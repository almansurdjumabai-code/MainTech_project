"""Pass B — Judge. Один вызов = один критерий, structured JSON, без overall.

Провайдеры:
- RuleJudge: без ключа, детерминированно по признакам retriever'а (демо не падает).
- ClaudeJudge: Anthropic SDK, structured outputs (json_schema). Ошибка/отказ -> fallback на RuleJudge по этому критерию.
"""
from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass, field

from backend.app import config
from scoring import allowed_answers

from .retriever import ROLE_RU, Ctx

log = logging.getLogger("cqa.judge")

ANSWER_RU = {"YES": "Да", "NO": "Нет", "NA": "N/A"}


def answer_label(answer) -> str:
    return ANSWER_RU.get(str(answer), f"{answer} баллов" if str(answer).isdigit() else str(answer))


def fmt_evidence_ref(e: dict) -> str:
    quote = e["text"] if len(e["text"]) <= 140 else e["text"][:137] + "…"
    return f"[{e['timestamp']}] {ROLE_RU.get(e['speaker'], e['speaker'])}: «{quote}»"


def build_explanation(crit: dict, answer, reason: str, evidence: list[dict], expected: dict | None, na_reason: str) -> str:
    head = f"{crit['name']} — {answer_label(answer)}."
    body = na_reason if str(answer) == "NA" else reason
    refs = []
    if expected and str(answer) != "NA":
        refs.append("ожидалось: " + fmt_evidence_ref(expected))
    refs += [fmt_evidence_ref(e) for e in evidence[:2] if not expected or e["index"] != expected["index"]]
    tail = f" Основание — {'; '.join(refs)}." if refs else ""
    return f"{head} {body}{tail}".strip()


@dataclass
class Usage:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    fallbacks: int = 0
    errors: list[str] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, input_tokens: int, output_tokens: int) -> None:
        # судьи по критериям работают в потоках
        with self._lock:
            self.calls += 1
            self.input_tokens += input_tokens or 0
            self.output_tokens += output_tokens or 0

    @property
    def cost_usd(self) -> float:
        return round(self.input_tokens / 1e6 * config.LLM_PRICE_IN + self.output_tokens / 1e6 * config.LLM_PRICE_OUT, 6)


def _strip(e: dict) -> dict:
    return {k: e[k] for k in ("index", "timestamp", "speaker", "text")}


class RuleJudge:
    name = "rules"
    model = "rule-based-v1"

    def judge(self, ctx: Ctx, crit: dict, hint: dict, usage: Usage) -> dict:
        evidence = [_strip(s) for s in hint["spans"]]
        expected = _strip(hint["missing"]) if hint.get("missing") else None
        answer = hint["answer"]
        return {
            "answer": answer,
            "na_reason": hint.get("na_reason") or "",
            "explanation": build_explanation(crit, answer, hint.get("reason", ""), evidence, expected, hint.get("na_reason", "")),
            "evidence_list": evidence,
            "expected": expected,
            "source": "rules",
        }


class ClaudeJudge:
    name = "anthropic"

    def __init__(self, model: str | None = None):
        import anthropic  # импорт тут: без ключа модуль не нужен

        self.anthropic = anthropic
        self.client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY, max_retries=3, timeout=120)
        self.model = model or config.LLM_MODEL
        self.system = (config.PROMPTS_DIR / "judge_system.md").read_text(encoding="utf-8")
        self.fallback = RuleJudge()

    @staticmethod
    def _schema(crit: dict) -> dict:
        return {
            "type": "object",
            "properties": {
                "answer": {"type": "string", "enum": allowed_answers(crit)},
                "evidence_indices": {"type": "array", "items": {"type": "integer"}},
                "expected_index": {"type": "integer"},
                "na_reason": {"type": "string"},
                "explanation": {"type": "string"},
            },
            "required": ["answer", "evidence_indices", "expected_index", "na_reason", "explanation"],
            "additionalProperties": False,
        }

    @staticmethod
    def _criterion_block(crit: dict) -> str:
        """Промпт собирается из полей чек-листа — новый критерий не требует правки кода/промптов."""
        lines = [f"Criterion {crit['id']}: {crit['name']}", f"Type: {crit['type']}", f"Definition: {crit['description']}"]
        if crit["type"] == "scale":
            lines.append("Scale (pick one step):")
            for step in sorted(crit["scale"], reverse=True):
                desc = (crit.get("scale_descriptions") or {}).get(str(step), "")
                lines.append(f"  {step}: {desc}")
        if crit["type"] == "flag":
            lines.append("This is a critical-error flag: YES if any listed violation occurred (an offer alone is enough), otherwise NO.")
        if crit.get("na_allowed"):
            lines.append(f"N/A allowed only when: {crit.get('na_condition')}")
        else:
            lines.append("N/A is NOT allowed for this criterion.")
        lines.append(f"Allowed answers: {', '.join(allowed_answers(crit))}")
        return "\n".join(lines)

    @staticmethod
    def _transcript(ctx: Ctx) -> str:
        return "\n".join(f"[{t.index}] [{t.timestamp}] {t.speaker}: {t.text}" for t in ctx.turns)

    @staticmethod
    def _hints(hint: dict) -> str:
        parts = [f"- [{s['index']}] {s['speaker']} ({s.get('why', '')})" for s in hint["spans"]]
        if hint.get("missing"):
            m = hint["missing"]
            parts.append(f"- expected-but-missing near [{m['index']}] ({m.get('why', '')})")
        return "\n".join(parts) or "- (no candidate spans found by rules)"

    def judge(self, ctx: Ctx, crit: dict, hint: dict, usage: Usage) -> dict:
        user = (
            f"Conversation language: {ctx.language}. Channel: {ctx.channel}.\n\n"
            f"{self._criterion_block(crit)}\n\n"
            f"Retriever hints:\n{self._hints(hint)}\n\n"
            f"Transcript (index, timestamp, speaker, text):\n{self._transcript(ctx)}"
        )
        kwargs = dict(
            model=self.model,
            max_tokens=4000,
            system=self.system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": config.LLM_EFFORT,
                           "format": {"type": "json_schema", "schema": self._schema(crit)}},
        )
        try:
            if self.model.startswith(("claude-opus-5", "claude-fable", "claude-sonnet-5-5")):
                # серверный fallback на другую модель при отказе классификатора
                resp = self.client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
            else:
                resp = self.client.messages.create(**kwargs)
            usage.add(resp.usage.input_tokens, resp.usage.output_tokens)
            if resp.stop_reason == "refusal":
                raise RuntimeError("model refusal")
            text = next(b.text for b in resp.content if b.type == "text")
            data = json.loads(text)
        except (self.anthropic.APIConnectionError, self.anthropic.RateLimitError, self.anthropic.APIStatusError,
                RuntimeError, StopIteration, json.JSONDecodeError) as exc:
            usage.fallbacks += 1
            usage.errors.append(f"{crit['id']}: {type(exc).__name__}: {str(exc)[:160]}")
            log.warning("LLM judge failed for %s: %s — using rules", crit["id"], exc)
            out = self.fallback.judge(ctx, crit, hint, usage)
            out["source"] = "rules-fallback"
            return out

        n = len(ctx.turns)
        evidence = [ctx.turns[i].ev() for i in data.get("evidence_indices", []) if isinstance(i, int) and 0 <= i < n][:3]
        evidence = [_strip(e) for e in evidence]
        exp_i = data.get("expected_index", -1)
        expected = _strip(ctx.turns[exp_i].ev()) if isinstance(exp_i, int) and 0 <= exp_i < n else None
        return {
            "answer": data["answer"],
            "na_reason": data.get("na_reason") or "",
            "explanation": data.get("explanation") or "",
            "evidence_list": evidence,
            "expected": expected,
            "source": "llm",
        }


def make_judge(mode: str | None = None):
    """mode: auto | anthropic | rules (по умолчанию из env LLM_PROVIDER)."""
    mode = (mode or config.LLM_PROVIDER or "auto").lower()
    if mode == "rules":
        return RuleJudge()
    if config.ANTHROPIC_API_KEY:
        return ClaudeJudge()
    if mode == "anthropic":
        log.warning("LLM_PROVIDER=anthropic, но ANTHROPIC_API_KEY пуст — использую rule-based")
    return RuleJudge()
