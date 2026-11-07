"""LLM-судья через OpenAI-совместимый Chat Completions API: Gemini (бесплатный ключ AI Studio), Groq, OpenRouter, Ollama.

Тот же контракт, промпт, кэш ответов и fallback, что у ClaudeJudge; отличается только транспорт.
Без новых зависимостей — httpx.

Особенности бесплатных тарифов, которые учитываем:
- лимиты запросов -> троттлинг (OPENAI_COMPAT_MIN_INTERVAL_SEC) и повтор с паузой на 429/5xx (Retry-After);
- json_schema иногда игнорируется или отклоняется -> схема дублируется в промпте, JSON разбирается с запасом,
  при 400 на json_schema один раз переходим на json_object;
- кэша промпта у провайдера может не быть -> рекомендуем LLM_STRATEGY=single_call (1 запрос на диалог).
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time

import httpx

from backend.app import config

from .judges import ClaudeJudge, RuleJudge, Usage

log = logging.getLogger("cqa.judge.compat")

_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)
_throttle_lock = threading.Lock()
_last_call = [0.0]
# модель -> время, когда у неё кончилась дневная квота (общая для процесса: новые судьи сразу берут запасную)
_quota_exhausted: dict[str, float] = {}
QUOTA_PAUSE_SEC = 3600


def _daily_quota_hit(resp: httpx.Response) -> bool:
    """429 из-за дневного лимита (повтор через минуту не поможет), а не из-за минутного."""
    return resp.status_code == 429 and ("PerDay" in resp.text or "per day" in resp.text.lower())


def parse_json(text: str) -> dict:
    """JSON из ответа модели: без ```-обёрток и лишнего текста вокруг объекта."""
    text = _FENCE.sub("", text or "").strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise
        data = json.loads(text[start:end + 1])
    if not isinstance(data, dict):
        raise ValueError("model output is not a JSON object")
    return data


class OpenAICompatJudge(ClaudeJudge):
    name = "openai_compat"

    def __init__(self, model: str | None = None, base_url: str | None = None, api_key: str | None = None,
                 transport: httpx.BaseTransport | None = None):
        self.model = model or config.OPENAI_COMPAT_MODEL
        # цепочка запасных моделей через запятую: берётся первая, у которой не кончилась дневная квота
        self.primary_model = self.model
        self.fallback_models = [m.strip() for m in config.OPENAI_COMPAT_FALLBACK_MODEL.split(",") if m.strip()] if model is None else []
        self.model = self._next_model() or self.model
        self.base_url = (base_url or config.OPENAI_COMPAT_BASE_URL).rstrip("/")
        self.api_key = api_key if api_key is not None else config.OPENAI_COMPAT_API_KEY
        self.json_mode = config.OPENAI_COMPAT_JSON_MODE  # json_schema | json_object
        self.http = httpx.Client(timeout=config.LLM_TIMEOUT_SEC, transport=transport)
        self.system = (config.PROMPTS_DIR / "judge_system.md").read_text(encoding="utf-8")
        self.fallback = RuleJudge()
        self.anthropic = None

    def _next_model(self) -> str | None:
        now = time.monotonic()
        for m in [self.primary_model, *self.fallback_models]:
            if now - _quota_exhausted.get(m, -1e9) >= QUOTA_PAUSE_SEC:
                return m
        return None

    @property
    def fallback_model(self) -> str:
        """Непусто, если сейчас работает запасная модель (на ней одно прочтение вместо голосования)."""
        return self.model if self.model != self.primary_model else ""

    @property
    def prices(self) -> tuple[float, float, float]:
        return config.OPENAI_COMPAT_PRICE_IN, config.OPENAI_COMPAT_PRICE_OUT, config.OPENAI_COMPAT_PRICE_IN

    def _errors(self) -> tuple:
        return (httpx.HTTPError, RuntimeError, StopIteration, ValueError, KeyError, TypeError, IndexError)

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    def list_models(self) -> list[str]:
        r = self.http.get(f"{self.base_url}/models", headers=self._headers())
        r.raise_for_status()
        return sorted(m.get("id", "") for m in r.json().get("data", []))

    @staticmethod
    def _throttle() -> None:
        gap = config.OPENAI_COMPAT_MIN_INTERVAL_SEC
        if gap <= 0:
            return
        with _throttle_lock:
            wait = _last_call[0] + gap - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            _last_call[0] = time.monotonic()

    def _body(self, messages: list[dict], schema: dict, max_tokens: int) -> dict:
        # Anthropic-блоки (с cache_control) -> обычный текст; схему дублируем в промпте на случай,
        # если провайдер проигнорирует response_format
        user = "\n\n".join(b["text"] for m in messages for b in m["content"])
        user += ("\n\nReturn ONLY a JSON object (no markdown) that matches this JSON Schema:\n"
                 + json.dumps(schema, ensure_ascii=False))
        body = {"model": self.model, "max_tokens": max_tokens, "temperature": 0,
                "messages": [{"role": "system", "content": self.system}, {"role": "user", "content": user}]}
        if self.json_mode == "json_schema":
            body["response_format"] = {"type": "json_schema",
                                       "json_schema": {"name": "cqa_judgment", "strict": True, "schema": schema}}
        else:
            body["response_format"] = {"type": "json_object"}
        return body

    def _call(self, messages: list[dict], schema: dict, max_tokens: int, usage: Usage) -> dict:
        attempts = max(1, config.LLM_MAX_RETRIES + 1)
        for attempt in range(attempts):
            self._throttle()
            resp = self.http.post(f"{self.base_url}/chat/completions", headers=self._headers(),
                                  json=self._body(messages, schema, max_tokens))
            if resp.status_code == 400 and self.json_mode == "json_schema":
                # провайдер не принял схему (например, additionalProperties) -> режим json_object
                log.warning("provider rejected json_schema, switching to json_object")
                self.json_mode = "json_object"
                continue
            if _daily_quota_hit(resp):
                _quota_exhausted[self.model] = time.monotonic()
                nxt = self._next_model()
                if nxt:
                    log.warning("daily quota exhausted for %s, switching to %s", self.model, nxt)
                    self.model = nxt
                    continue
                raise RuntimeError(f"provider daily quota exhausted for {self.model}")  # сразу правила, без ожидания
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == attempts - 1:
                    resp.raise_for_status()
                try:
                    delay = float(resp.headers.get("retry-after", ""))
                except ValueError:
                    delay = 2 ** attempt  # экспоненциальный backoff: 1, 2, 4 … с
                time.sleep(min(delay, 60))
                continue
            resp.raise_for_status()
            data = resp.json()
            u = data.get("usage") or {}
            cached = ((u.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0
            usage.add((u.get("prompt_tokens") or 0) - cached, u.get("completion_tokens") or 0, 0, cached)
            choice = (data.get("choices") or [{}])[0]
            if choice.get("finish_reason") == "length":
                raise RuntimeError("output truncated (max_tokens)")
            if not isinstance(choice.get("message"), dict):
                # провайдер вернул ответ без текста (например, сработал его фильтр безопасности) — понятная ошибка вместо KeyError
                raise RuntimeError(f"provider returned no message (finish_reason={choice.get('finish_reason')!r}, "
                                   f"keys={sorted(choice)})")
            return parse_json(choice["message"].get("content") or "")
        raise RuntimeError("provider: retries exhausted")
