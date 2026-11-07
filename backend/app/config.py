"""Единая точка конфигурации (env + пути). Импортируется и backend, и ml."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / "backend" / ".env")

DATASET_URL = os.getenv("DATASET_URL", "").strip()
DB_PATH = Path(os.getenv("CQA_DB_PATH") or (ROOT / "data" / "cqa.db"))
if not DB_PATH.is_absolute():
    DB_PATH = ROOT / DB_PATH
CHECKLIST_DIR = ROOT / "configs" / "checklists"
PROMPTS_DIR = ROOT / "prompts"

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "auto").lower()  # auto | anthropic | openai_compat | rules
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
LLM_MODEL = os.getenv("LLM_MODEL", "claude-sonnet-5-5")
LLM_EFFORT = os.getenv("LLM_EFFORT", "low")
# цены $/1M по умолчанию — Sonnet 5.5: вход 2, выход 10, чтение кэша 0.20 (запись кэша = 1.25x входа)
LLM_PRICE_IN = float(os.getenv("LLM_PRICE_IN", "2.0"))
LLM_PRICE_OUT = float(os.getenv("LLM_PRICE_OUT", "10.0"))
LLM_PRICE_CACHE_READ = float(os.getenv("LLM_PRICE_CACHE_READ", "0.20"))
LLM_MAX_WORKERS = int(os.getenv("LLM_MAX_WORKERS", "8"))
# per_criterion — отдельный вызов на критерий (независимые суждения); single_call — все критерии одним вызовом (дешевле)
LLM_STRATEGY = os.getenv("LLM_STRATEGY", "per_criterion").lower()
# Кэш ответов модели по (модель, effort, промпт, транскрипт, критерий): повторная оценка и смена одного критерия
# не оплачивают уже оценённые критерии заново
LLM_RESULT_CACHE = os.getenv("LLM_RESULT_CACHE", "1").lower() not in ("0", "false", "no")
LLM_TIMEOUT_SEC = float(os.getenv("LLM_TIMEOUT_SEC", "120"))
# Голосование: N независимых прочтений диалога, по каждому критерию — ответ большинства;
# расхождение прочтений понижает уверенность и отправляет критерий на ручную проверку (1 = выключено)
LLM_VOTES = max(1, int(os.getenv("LLM_VOTES", "1")))
LLM_MAX_RETRIES = int(os.getenv("LLM_MAX_RETRIES", "3"))  # SDK: экспоненциальный backoff на 429/5xx/сеть

# OpenAI-совместимый провайдер (по умолчанию — бесплатный Gemini API из Google AI Studio)
OPENAI_COMPAT_BASE_URL = os.getenv("OPENAI_COMPAT_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai").strip()
OPENAI_COMPAT_API_KEY = os.getenv("OPENAI_COMPAT_API_KEY", "").strip()
OPENAI_COMPAT_MODEL = os.getenv("OPENAI_COMPAT_MODEL", "gemini-flash-latest")
# запасная модель со своей дневной квотой: при исчерпании квоты основной переключаемся сразу, без ожидания
OPENAI_COMPAT_FALLBACK_MODEL = os.getenv("OPENAI_COMPAT_FALLBACK_MODEL", "").strip()
OPENAI_COMPAT_JSON_MODE = os.getenv("OPENAI_COMPAT_JSON_MODE", "json_schema")  # json_schema | json_object
OPENAI_COMPAT_PRICE_IN = float(os.getenv("OPENAI_COMPAT_PRICE_IN", "0"))  # бесплатный тариф = 0
OPENAI_COMPAT_PRICE_OUT = float(os.getenv("OPENAI_COMPAT_PRICE_OUT", "0"))
# пауза между запросами: бесплатные тарифы ограничивают запросы в минуту (15 RPM -> 4 с)
OPENAI_COMPAT_MIN_INTERVAL_SEC = float(os.getenv("OPENAI_COMPAT_MIN_INTERVAL_SEC", "4"))

DEFAULT_CHECKLIST_ID = os.getenv("DEFAULT_CHECKLIST_ID", "cqa-default-v1")

# CORS: любой локальный фронт (localhost / 127.0.0.1 на любом порту) + file:// (Origin: null)
CORS_ORIGIN_REGEX = os.getenv(
    "CORS_ORIGIN_REGEX", r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|null)$"
)
