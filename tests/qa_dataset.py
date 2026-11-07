"""QA блок 1: проверка входного набора организаторов (до того, как ошибки данных станут «ошибками модели»).

    backend\\.venv\\Scripts\\python -m tests.qa_dataset              # живой запрос DEV у организаторов
    backend\\.venv\\Scripts\\python -m tests.qa_dataset --from-db    # то, что уже загружено в БД
    backend\\.venv\\Scripts\\python -m tests.qa_dataset --group-id CONTROL --no-counts
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import Counter

ROLES = {"client", "operator", "bot", "system"}
MMSS = re.compile(r"^\d{1,3}:\d{2}$")
# ISO 8601 с часовым поясом (Z или ±HH:MM), дробная часть любой длины
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")
DEV_EXPECT = {"total": 65, "channels": {"agent chat": 60, "voice call": 5}, "languages": {"RU": 35, "KZ": 15, "EN": 15}}


def check(records: list[dict], expect_counts: bool = True) -> dict:
    """Возвращает {"errors": [...], "warnings": [...], "summary": {...}}."""
    errors, warnings = [], []
    ids = [r.get("conversation_id") for r in records]
    ch = Counter(r.get("channel") for r in records)
    lang = Counter(r.get("language") for r in records)
    if expect_counts:
        if len(records) != DEV_EXPECT["total"]:
            errors.append(f"записей {len(records)}, ожидалось {DEV_EXPECT['total']}")
        if dict(ch) != DEV_EXPECT["channels"]:
            errors.append(f"каналы {dict(ch)}, ожидалось {DEV_EXPECT['channels']}")
        if dict(lang) != DEV_EXPECT["languages"]:
            errors.append(f"языки {dict(lang)}, ожидалось {DEV_EXPECT['languages']}")
    dup = [i for i, n in Counter(ids).items() if n > 1]
    if dup:
        errors.append(f"повторяющиеся conversation_id: {dup}")
    if None in ids or "" in ids:
        errors.append("есть записи без conversation_id")
    unknown_ch = set(ch) - set(DEV_EXPECT["channels"])
    if unknown_ch:
        errors.append(f"неизвестные каналы: {unknown_ch}")
    unknown_lang = set(lang) - set(DEV_EXPECT["languages"])
    if unknown_lang:
        errors.append(f"неизвестные языки: {unknown_lang}")
    roles = Counter()
    for r in records:
        cid, channel, tr = r.get("conversation_id"), r.get("channel"), r.get("transcript")
        audio = r.get("audio_url")
        if channel == "agent chat" and audio:
            errors.append(f"{cid}: у чата заполнен audio_url")
        if channel == "voice call" and not audio:
            errors.append(f"{cid}: у звонка пустой audio_url")
        if not isinstance(tr, list) or not tr:
            errors.append(f"{cid}: пустой транскрипт")
            continue
        fmt = MMSS if channel == "agent chat" else ISO
        bad_ts = [i for i, t in enumerate(tr) if not fmt.match(str(t.get("timestamp") or ""))]
        if bad_ts:
            errors.append(f"{cid}: время не в формате {'MM:SS' if channel == 'agent chat' else 'ISO 8601 с поясом'} в репликах {bad_ts[:5]}")
        for i, t in enumerate(tr):
            sp = t.get("speaker")
            roles[sp] += 1
            if sp not in ROLES:
                errors.append(f"{cid}[{i}]: неизвестная роль {sp!r}")
            if not str(t.get("text") or "").strip():
                errors.append(f"{cid}[{i}]: пустой text")
        if not any(t.get("speaker") == "operator" for t in tr):
            warnings.append(f"{cid}: нет ни одной реплики оператора")
    return {"errors": errors, "warnings": warnings,
            "summary": {"total": len(records), "channels": dict(ch), "languages": dict(lang), "roles": dict(roles)}}


def check_evidence(records: list[dict], checklist_id: str | None = None) -> list[str]:
    """Каждая ссылка-доказательство указывает на существующую реплику с тем же текстом/ролью/временем,
    у N/A есть причина, у не-N/A (кроме флага) есть evidence. Оценка — текущим судьёй из env (без ключа — правила)."""
    from backend.app import service
    from ml.pipeline import evaluate_conversation
    checklist = service.get_checklist_or_404(checklist_id)
    problems = []
    for rec in records:
        tr = rec["transcript"]
        res = evaluate_conversation(rec, checklist)
        for c in res["criteria"]:
            if c["na"] and not c.get("na_reason"):
                problems.append(f"{rec['conversation_id']} {c['id']}: N/A без причины")
            if not c["na"] and c["type"] != "flag" and not c.get("evidence"):
                problems.append(f"{rec['conversation_id']} {c['id']}: нет реплики-доказательства")
            for e in [c.get("evidence"), c.get("expected_span"), *(c.get("evidence_all") or [])]:
                if not e:
                    continue
                i = e.get("index")
                if not isinstance(i, int) or not 0 <= i < len(tr):
                    problems.append(f"{rec['conversation_id']} {c['id']}: индекс {i} вне транскрипта")
                elif (tr[i]["text"], tr[i]["speaker"], tr[i]["timestamp"]) != (e["text"], e["speaker"], e["timestamp"]):
                    problems.append(f"{rec['conversation_id']} {c['id']}: ссылка #{i} не совпадает с репликой")
    return problems


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--group-id", default="DEV")
    p.add_argument("--from-db", action="store_true")
    p.add_argument("--no-counts", action="store_true", help="не сверять счётчики DEV (для контрольного набора)")
    p.add_argument("--evidence", action="store_true", help="оценить все диалоги и проверить ссылки на реплики")
    a = p.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    if a.from_db:
        from backend.app import db
        records = [db.get_conversation(c["conversation_id"]) for c in db.list_conversations(group_id=a.group_id)]
    else:
        from backend.app.ingest import fetch_group
        records = fetch_group(a.group_id)["records"]
    res = check(records, expect_counts=not a.no_counts and a.group_id == "DEV")
    print("summary:", res["summary"])
    for w in res["warnings"]:
        print("[WARN]", w)
    for e in res["errors"]:
        print("[FAIL]", e)
    print("DATASET:", "FAIL" if res["errors"] else "OK", f"(errors={len(res['errors'])}, warnings={len(res['warnings'])})")
    bad = 0
    if a.evidence:
        from backend.app import db, service
        db.init_db()
        service.seed_checklists()
        problems = check_evidence(records)
        for x in problems[:30]:
            print("[FAIL]", x)
        refs = len(records)
        print("EVIDENCE:", "FAIL" if problems else "OK", f"(диалогов {refs}, проблем {len(problems)})")
        bad = len(problems)
    return 1 if res["errors"] or bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
