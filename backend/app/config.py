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

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "auto").lower()  # auto | anthropic | rules
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
LLM_MODEL = os.getenv("LLM_MODEL", "claude-opus-5-5")
LLM_EFFORT = os.getenv("LLM_EFFORT", "low")
LLM_PRICE_IN = float(os.getenv("LLM_PRICE_IN", "4.0"))
LLM_PRICE_OUT = float(os.getenv("LLM_PRICE_OUT", "20.0"))
LLM_MAX_WORKERS = int(os.getenv("LLM_MAX_WORKERS", "8"))

DEFAULT_CHECKLIST_ID = os.getenv("DEFAULT_CHECKLIST_ID", "cqa-default-v1")

# CORS: любой локальный фронт (localhost / 127.0.0.1 на любом порту) + file:// (Origin: null)
CORS_ORIGIN_REGEX = os.getenv(
    "CORS_ORIGIN_REGEX", r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|null)$"
)
