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

import pytest  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def isolated_db(tmp_path_factory):
    """Своя SQLite на каждый тестовый модуль — модули не влияют друг на друга."""
    from backend.app import config

    orig = config.DB_PATH
    config.DB_PATH = tmp_path_factory.mktemp("db") / "cqa.db"
    yield config.DB_PATH
    config.DB_PATH = orig
