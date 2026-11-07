"""Проверка готовности перед защитой и перед t+23h (ничего не меняет в БД).

    backend\\.venv\\Scripts\\python -m ml.preflight                     # локально: БД, чек-листы, модель, покрытие
    backend\\.venv\\Scripts\\python -m ml.preflight --online            # + API организаторов, запись звонка, сервер
    backend\\.venv\\Scripts\\python -m ml.preflight --group-id CONTROL  # для контрольного набора
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter

from backend.app import config, db, service

# Ожидания из Student Guide для DEV
DEV_EXPECT = {"total": 65, "channels": {"agent chat": 60, "voice call": 5}, "languages": {"RU": 35, "KZ": 15, "EN": 15}}
# Цены моделей, $/1M (вход, выход, чтение кэша) — должны совпадать с LLM_PRICE_*
PRICES = {"claude-sonnet-5-5": (2.0, 10.0, 0.20), "claude-opus-5-5": (4.0, 20.0, 0.20), "claude-haiku-5-5": (0.10, 0.50, None)}


class Report:
    def __init__(self):
        self.fails = self.warns = 0

    def line(self, level: str, msg: str):
        self.fails += level == "FAIL"
        self.warns += level == "WARN"
        print(f"[{level:<4}] {msg}")


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--group-id", default="DEV")
    p.add_argument("--checklist", default=None, help="по умолчанию — последняя версия семейства по умолчанию")
    p.add_argument("--online", action="store_true", help="проверить API организаторов, запись звонка и сервер")
    p.add_argument("--server", default="http://127.0.0.1:8000")
    a = p.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    r = Report()
    db.init_db()
    service.seed_checklists()

    # 1. данные
    convs = db.list_conversations(group_id=a.group_id)
    if not convs:
        r.line("FAIL", f"нет диалогов group_id={a.group_id}: POST /ingest?group_id={a.group_id}")
    else:
        ch, lang = Counter(c["channel"] for c in convs), Counter(c["language"] for c in convs)
        r.line("OK", f"{a.group_id}: {len(convs)} диалогов, каналы {dict(ch)}, языки {dict(lang)}")
        if a.group_id == "DEV":
            ok = len(convs) == DEV_EXPECT["total"] and dict(ch) == DEV_EXPECT["channels"] and dict(lang) == DEV_EXPECT["languages"]
            r.line("OK" if ok else "WARN", "счётчики совпадают со Student Guide (65 = 60 чатов + 5 звонков; 35 RU / 15 KZ / 15 EN)"
                   if ok else f"счётчики не совпадают со Student Guide: ожидалось {DEV_EXPECT}")
        empty = [c["conversation_id"] for c in convs if not c["turns"]]
        if empty:
            r.line("WARN", f"пустые транскрипты: {empty[:5]}")

    # 2. чек-листы
    cls = db.list_checklists()
    latest = [c for c in cls if c["is_latest"]]
    r.line("OK" if cls else "FAIL", f"чек-листы: {[c['id'] for c in cls]}; последние: {[c['id'] for c in latest]}")
    checklist_id = a.checklist or next((c["id"] for c in latest if c["family"] == config.DEFAULT_CHECKLIST_ID.rsplit("-v", 1)[0]),
                                       config.DEFAULT_CHECKLIST_ID)

    # 3. модель и стоимость
    if config.LLM_PROVIDER == "rules":
        r.line("WARN", "LLM_PROVIDER=rules — оценка только правилами")
    else:
        from ml.judges import is_llm, make_judge
        j = make_judge()
        if not is_llm(j):
            r.line("WARN", "нет ключа LLM (ANTHROPIC_API_KEY / OPENAI_COMPAT_API_KEY) — будет rule-based; новому критерию без LLM нужны keywords")
        else:
            r.line("OK", f"LLM: {j.name} / {j.model}, strategy={config.LLM_STRATEGY}, кэш ответов={config.LLM_RESULT_CACHE}")
            if j.name == "openai_compat" and config.LLM_STRATEGY != "single_call":
                r.line("WARN", "бесплатный тариф: рекомендуется LLM_STRATEGY=single_call (1 запрос на диалог вместо 8)")
    exp = PRICES.get(config.LLM_MODEL) if config.ANTHROPIC_API_KEY else None
    got = (config.LLM_PRICE_IN, config.LLM_PRICE_OUT, config.LLM_PRICE_CACHE_READ)
    if exp and any(e is not None and abs(e - g) > 1e-9 for e, g in zip(exp, got)):
        r.line("WARN", f"цены LLM_PRICE_* {got} не совпадают с {config.LLM_MODEL} {exp} — cost_usd будет неверным")
    elif exp:
        r.line("OK", f"цены для расчёта стоимости соответствуют {config.LLM_MODEL}: {got}")

    # 4. покрытие оценками
    if convs:
        res = {x["conversation_id"]: x for x in db.list_results(a.group_id, checklist_id)}
        missing = [c["conversation_id"] for c in convs if c["conversation_id"] not in res]
        r.line("OK" if not missing else "WARN",
               f"оценено {len(res)}/{len(convs)} чек-листом {checklist_id}" + (f"; не оценены: {missing[:5]}… → POST /evaluate/batch" if missing else ""))
        stale = [cid for cid, x in res.items() if "review_required" not in (db.get_results_for_conversation(cid, checklist_id) or [{}])[0]]
        if stale:
            r.line("WARN", f"{len(stale)} результатов посчитаны старой версией (нет флагов ручной проверки) → batch с force=true")
        flagged = sum(1 for x in res.values() if x.get("review_required"))
        r.line("OK", f"на ручную проверку: {flagged}; открытых апелляций: {len(db.list_appeals('open'))}")
    jobs = [j for j in db.list_jobs(10) if j.get("group_id") == a.group_id]
    if jobs and jobs[0].get("failed"):
        r.line("WARN", f"последний batch {jobs[0]['job_id']}: failed={jobs[0]['failed']}, ошибки: {jobs[0]['errors'][:2]}")

    # 5. сеть (по запросу)
    if a.online:
        import httpx

        from backend.app import audio
        from backend.app.ingest import IngestError, fetch_group
        try:
            data = fetch_group(a.group_id)
            r.line("OK", f"API организаторов отвечает: {a.group_id} total_records={data.get('total_records')}")
        except IngestError as exc:
            r.line("FAIL", f"API организаторов: {exc}")
        call = next((c for c in convs if c.get("audio_url")), None)
        if call:
            try:
                info = audio.resolve(call["audio_url"])
                r.line("OK", f"запись звонка {call['conversation_id']} доступна (ссылка до {info.get('expires_at')})")
            except audio.AudioError as exc:
                r.line("FAIL", f"запись звонка {call['conversation_id']}: {exc}")
        try:
            h = httpx.get(f"{a.server}/health", timeout=3).json()
            r.line("OK", f"сервер {a.server}: judge={h.get('judge')} model={h.get('model')}")
        except Exception as exc:  # noqa: BLE001
            r.line("FAIL", f"сервер {a.server} недоступен ({type(exc).__name__}) → uvicorn backend.app.main:app --port 8000")

    print(f"\nPREFLIGHT: {'FAIL' if r.fails else 'OK'} (fail={r.fails}, warn={r.warns})")
    return 1 if r.fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
