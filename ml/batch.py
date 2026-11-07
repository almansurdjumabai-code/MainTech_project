"""CLI batch-оценка без запущенного сервера (та же БД, тот же пайплайн).

    backend\\.venv\\Scripts\\python -m ml.batch --group-id DEV --ingest
    backend\\.venv\\Scripts\\python -m ml.batch --group-id CONTROL --checklist cqa-default-v2 --mode anthropic
    backend\\.venv\\Scripts\\python -m ml.batch --group-id DEV --ids p1-ru-001 p1-kz-003 --force

Идемпотентно: уже оценённые пары (диалог, чек-лист) пропускаются -> повторный запуск = resume.
"""
from __future__ import annotations

import argparse
import sys

from backend.app import db, service
from backend.app.ingest import IngestError, ingest_group


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="CQA batch evaluation")
    p.add_argument("--group-id", required=True)
    p.add_argument("--checklist", default=None, help="checklist id (по умолчанию cqa-default-v1)")
    p.add_argument("--ingest", action="store_true", help="сначала загрузить набор у организаторов")
    p.add_argument("--mode", choices=["auto", "anthropic", "rules"], default=None)
    p.add_argument("--force", action="store_true", help="переоценить уже оценённые")
    p.add_argument("--ids", nargs="*", help="только эти conversation_id")
    p.add_argument("--limit", type=int, default=None, help="первые N диалогов (проба / оценка стоимости)")
    a = p.parse_args(argv)

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    db.init_db()
    service.seed_checklists()

    if a.ingest:
        try:
            info = ingest_group(a.group_id)
        except IngestError as exc:
            print(f"ingest failed: {exc}", file=sys.stderr)
            return 2
        print(f"ingested {info['ingested']} | languages {info['languages']} | channels {info['channels']}")

    checklist = service.get_checklist_or_404(a.checklist)
    ids = a.ids or db.conversation_ids(a.group_id)
    if a.limit:
        ids = ids[: a.limit]
    if not ids:
        print(f"no conversations for group_id={a.group_id}; добавьте --ingest", file=sys.stderr)
        return 2

    def progress(job, cid):
        n = job["done"] + job["skipped"] + job["failed"]
        print(f"[{n}/{job['total']}] {cid}  done={job['done']} skipped={job['skipped']} failed={job['failed']} cost=${job['cost_usd']:.4f}",
              flush=True)

    job = service.new_job(a.group_id, checklist["id"], ids)
    job = service.run_batch(job, ids, checklist, a.mode, a.force, on_progress=progress)
    print(f"\njob {job['job_id']}: {job['status']} | judge={job['judge']} model={job['model']} | "
          f"done={job['done']} skipped={job['skipped']} failed={job['failed']} llm_fallbacks={job['llm_fallbacks']} | cost=${job['cost_usd']:.4f}")
    for e in job["errors"][:10]:
        print("  error:", e)
    s = service.stats(a.group_id, checklist["id"])
    print(f"avg overall={s['avg_overall']} | critical={s['critical_errors']} | by language={s['avg_overall_by_language']}")
    return 0 if job["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
