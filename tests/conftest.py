import os
import sys
import tempfile
from pathlib import Path

# До импорта приложения: временная БД и rule-based судья (тесты без сети и без ключа)
_tmp = tempfile.mkdtemp(prefix="cqa-test-")
os.environ["CQA_DB_PATH"] = str(Path(_tmp) / "test.db")
os.environ["LLM_PROVIDER"] = "rules"
os.environ["ANTHROPIC_API_KEY"] = ""
os.environ["LLM_RESULT_CACHE"] = "0"  # тесты с фейковым клиентом не должны делить кэш ответов
# локальный backend/.env не должен влиять на тесты (load_dotenv не перезаписывает заданные переменные)
os.environ["LLM_STRATEGY"] = "per_criterion"
os.environ["LLM_VOTES"] = "1"  # голосование включают отдельные тесты
os.environ["OPENAI_COMPAT_API_KEY"] = ""
os.environ["OPENAI_COMPAT_BASE_URL"] = "https://generativelanguage.googleapis.com/v1beta/openai"

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
