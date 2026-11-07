import os
import sys
import tempfile
from pathlib import Path

# До импорта приложения: временная БД и rule-based судья (тесты без сети и без ключа)
_tmp = tempfile.mkdtemp(prefix="cqa-test-")
os.environ["CQA_DB_PATH"] = str(Path(_tmp) / "test.db")
os.environ["LLM_PROVIDER"] = "rules"
os.environ["ANTHROPIC_API_KEY"] = ""

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
