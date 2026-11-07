"""QA блок 1: сам проверяющий скрипт ловит каждую аномалию данных."""
import copy
import json
from pathlib import Path

from tests.qa_dataset import check

RECS = json.loads((Path(__file__).parent / "fixtures/synthetic.json").read_text(encoding="utf-8"))["data"]["records"]
CALL = {"conversation_id": "c1", "channel": "voice call", "language": "RU", "audio_url": "https://x/player",
        "transcript": [{"timestamp": "2026-11-03T13:10:00.6388245+00:00", "speaker": "operator", "text": "Здравствуйте"}]}


def errs(records):
    return " | ".join(check(records, expect_counts=False)["errors"])


def test_clean_fixture_passes():
    assert check(RECS + [CALL], expect_counts=False)["errors"] == []


def test_each_anomaly_is_reported():
    bad = copy.deepcopy(RECS + [CALL])
    bad.append(copy.deepcopy(bad[0]))                                   # повтор conversation_id
    bad[0]["audio_url"] = "https://x"                                   # audio_url у чата
    bad[1]["transcript"][0]["speaker"] = "agent"                        # неизвестная роль
    bad[2]["transcript"][0]["timestamp"] = "2026-11-03T13:10:00"        # у чата не MM:SS
    bad[3]["transcript"][1]["text"] = "  "                              # пустой text
    bad[4]["audio_url"] = None                                          # у звонка нет audio_url
    bad[4]["transcript"][0]["timestamp"] = "13:10"                      # у звонка не ISO
    e = errs(bad)
    for needle in ("повторяющиеся", "у чата заполнен audio_url", "неизвестная роль", "MM:SS", "пустой text",
                   "у звонка пустой audio_url", "ISO 8601"):
        assert needle in e, needle


def test_counts_checked_for_dev():
    res = check(RECS, expect_counts=True)
    assert any("записей" in x for x in res["errors"])
