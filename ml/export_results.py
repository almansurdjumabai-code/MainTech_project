"""Выгрузка результатов в формат сдачи (CQA_Student_Guide_Appendix_Results.pdf, JSON 1.0).

    # DEV (60 чатов + 5 звонков) -> results/dev/results.json
    backend\\.venv\\Scripts\\python -m ml.export_results --group-id DEV --set dev --evaluate
    # контрольный набор на t+23h: получить -> оценить -> проверить -> записать (дальше commit + push)
    backend\\.venv\\Scripts\\python -m ml.export_results --group-id <ID> --set prod --ingest --evaluate

Нумерация evidence_turns — с 1 по исходному transcript (у нас index с 0, поэтому +1).
Диалог, который не удалось оценить, остаётся в файле со status="error" — нулём не подменяется.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from backend.app import config, db, service

# id критерия в нашем чек-листе -> код из приложения; rule — запасной ключ, если id поменяли
CODES = {"C1": "contact", "C2": "discovery", "C3": "identification", "C4": "consultation",
         "C5": "empathy", "C6": "dialogue", "C7": "closure", "C8": "critical"}
RULE_CODES = {"contact": "contact", "need": "discovery", "identification": "identification", "consult": "consultation",
              "empathy": "empathy", "control": "dialogue", "close": "closure", "critical": "critical"}
ORDER = list(CODES.values())
ROOT = Path(__file__).resolve().parents[1]


def value_of(answer):
    s = str(answer).upper()
    if s == "YES":
        return True
    if s == "NO":
        return False
    if s == "NA":
        return None
    return int(answer)


def turns_of(c: dict) -> list[int]:
    idx = [e["index"] for e in (c.get("evidence_all") or []) if isinstance(e, dict) and isinstance(e.get("index"), int)]
    for extra in (c.get("evidence"), c.get("expected_span")):
        if not idx and isinstance(extra, dict) and isinstance(extra.get("index"), int):
            idx = [extra["index"]]
    return sorted({i + 1 for i in idx})


def score_check(values: dict[str, object], checklist: dict) -> float | None:
    """Независимый пересчёт итога по правилам приложения: N/A исключается, вес перераспределяется."""
    pts = w = Decimal(0)
    for c in checklist["criteria"]:
        code = code_of(c)
        if code is None or c["type"] == "flag":
            continue
        v = values[code]
        if v is None:
            continue
        weight = Decimal(str(c["weight"]))
        w += weight
        if c["type"] == "scale":
            pts += Decimal(v) / Decimal(max(c["scale"])) * weight
        else:
            pts += weight if v is True else 0
    if w == 0:
        return None
    return float((pts / w * 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def code_of(c: dict) -> str | None:
    return CODES.get(c["id"]) or RULE_CODES.get(c.get("rule") or "")


def record(conv: dict, res: dict | None, checklist: dict, use_final: bool) -> dict:
    cid = conv["conversation_id"]
    if not conv.get("transcript"):
        return {"conversation_id": cid, "status": "error", "criteria": [], "score": None, "error": "Пустой транскрипт."}
    if not res:
        return {"conversation_id": cid, "status": "error", "criteria": [], "score": None,
                "error": "Диалог не оценён (оценка завершилась ошибкой или не запускалась)."}
    block = res if use_final else (res.get("original") or res)
    by_code = {}
    for c in block["criteria"]:
        code = code_of(c)
        if code:
            by_code[code] = c
    missing = [k for k in ORDER if k not in by_code]
    if missing:
        return {"conversation_id": cid, "status": "error", "criteria": [], "score": None,
                "error": f"В оценке нет критериев: {', '.join(missing)}."}
    crits = [{"criterion_id": k, "value": value_of(by_code[k]["answer"]),
              "rationale": (by_code[k].get("explanation") or "").strip()[:600],
              "evidence_turns": turns_of(by_code[k])} for k in ORDER]
    values = {c["criterion_id"]: c["value"] for c in crits}
    final = block.get("overall")
    check = score_check(values, checklist)
    if check != final:  # итог в файле обязан совпадать с ответами по критериям
        raise RuntimeError(f"{cid}: overall {final} != пересчёт по приложению {check}")
    return {"conversation_id": cid, "status": "ok", "criteria": crits,
            "score": {"final_score": final, "critical_flag": values["critical"]}}


def model_info(results: list[dict]) -> dict:
    models = sorted({(r.get("pipeline") or {}).get("model") for r in results} - {None})
    judges = {(r.get("pipeline") or {}).get("judge") for r in results}
    llm = [m for m in models if m != "rule-based-v1"]
    if llm:
        return {"mode": "hybrid", "name": " + ".join(["rule-based-v1 (детерминированные правила RU/KZ/EN)", *llm])}
    if judges <= {"rules", None}:
        return {"mode": "local", "name": "rule-based-v1 (детерминированные правила RU/KZ/EN, без LLM)"}
    return {"mode": "hybrid", "name": " + ".join(models)}


def build(group_id: str, checklist_id: str, team: str, use_final: bool = False) -> dict:
    checklist = service.get_checklist_or_404(checklist_id)
    convs = [db.get_conversation(c["conversation_id"]) for c in db.list_conversations(group_id=group_id)]
    res = {r["conversation_id"]: r for r in db.all_result_bodies(group_id, checklist["id"])}
    out = [record(c, res.get(c["conversation_id"]), checklist, use_final) for c in convs]
    return {"schema_version": "1.0", "team_name": team, "model": model_info(list(res.values())), "results": out}


def validate(doc: dict, expected_ids: list[str], prod: bool) -> list[str]:
    errs = []
    ids = [r["conversation_id"] for r in doc["results"]]
    if len(ids) != len(set(ids)):
        errs.append("повторяющиеся conversation_id")
    if set(ids) != set(expected_ids):
        errs.append(f"ID не совпадают с набором: нет {sorted(set(expected_ids) - set(ids))[:5]}, лишние {sorted(set(ids) - set(expected_ids))[:5]}")
    if prod and len(ids) != 10:
        errs.append(f"prod: должно быть ровно 10 записей, сейчас {len(ids)}")
    for r in doc["results"]:
        if r["status"] == "ok":
            if [c["criterion_id"] for c in r["criteria"]] != ORDER:
                errs.append(f"{r['conversation_id']}: нужны все 8 критериев ровно по одному разу")
            if r["score"]["critical_flag"] is not next(c["value"] for c in r["criteria"] if c["criterion_id"] == "critical"):
                errs.append(f"{r['conversation_id']}: critical_flag != critical")
            for c in r["criteria"]:
                if any((not isinstance(t, int)) or t < 1 for t in c["evidence_turns"]):
                    errs.append(f"{r['conversation_id']}: {c['criterion_id']} — номера реплик с 1")
    return errs


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--group-id", default="DEV")
    p.add_argument("--set", choices=["dev", "prod"], default=None, help="папка results/<set>/ (по умолчанию: DEV -> dev, иначе prod)")
    p.add_argument("--checklist", default=config.DEFAULT_CHECKLIST_ID, help="действующий чек-лист (коды критериев C1..C8)")
    p.add_argument("--team", default=os.getenv("CQA_TEAM_NAME", "MainTech"))
    p.add_argument("--ingest", action="store_true", help="сначала загрузить набор у организаторов")
    p.add_argument("--evaluate", action="store_true", help="оценить неоценённые диалоги")
    p.add_argument("--force", action="store_true", help="переоценить все заново")
    p.add_argument("--mode", default=None, choices=[None, "auto", "anthropic", "rules"], help="судья (по умолчанию из .env)")
    p.add_argument("--final", action="store_true", help="с учётом решений проверяющего (по умолчанию — ответ системы)")
    p.add_argument("--out", default=None)
    a = p.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    db.init_db()
    service.seed_checklists()
    target = a.set or ("dev" if a.group_id.upper() == "DEV" else "prod")
    out = Path(a.out) if a.out else ROOT / "results" / target / "results.json"

    if a.ingest:
        from backend.app.ingest import ingest_group
        info = ingest_group(a.group_id)
        print(f"ingest {a.group_id}: {info['ingested']} диалогов, языки {info['languages']}, каналы {info['channels']}")
    ids = db.conversation_ids(a.group_id)
    if not ids:
        print(f"нет диалогов group_id={a.group_id}: запустите с --ingest")
        return 1
    if a.evaluate:
        checklist = service.get_checklist_or_404(a.checklist)
        job = service.new_job(a.group_id, checklist["id"], ids)
        service.run_batch(job, ids, checklist, a.mode, a.force,
                          on_progress=lambda j, cid: print(f"  {j['done'] + j['skipped'] + j['failed']}/{j['total']} {cid}", flush=True))
        print(f"оценка: done={job['done']} skipped={job['skipped']} failed={job['failed']} cost=${job['cost_usd']}")
        for e in job["errors"]:
            print("  ошибка:", e)

    doc = build(a.group_id, a.checklist, a.team, a.final)
    errs = validate(doc, ids, target == "prod")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")  # UTF-8 без BOM
    ok = sum(r["status"] == "ok" for r in doc["results"])
    print(f"{out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}: {len(doc['results'])} записей (ok {ok}, error {len(doc['results']) - ok}),"
          f" model={doc['model']}")
    for e in errs:
        print("✗", e)
    print("ПРОВЕРКА:", "OK — можно commit + push" if not errs else "ЕСТЬ ОШИБКИ")
    print("доп. проверка QA: node qa/validate_results.mjs", out.as_posix())
    return 1 if errs else 0


if __name__ == "__main__":
    raise SystemExit(main())
