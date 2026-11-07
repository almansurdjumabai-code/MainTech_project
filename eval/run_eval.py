"""Сравнение автооценки с ручной разметкой (gold). Ничего не пишет в БД результатов.

    backend\\.venv\\Scripts\\python -m eval.run_eval                 # rule-based
    backend\\.venv\\Scripts\\python -m eval.run_eval --mode anthropic  # Claude (нужен ключ, ~$0.1 за диалог на Opus)

Нужен загруженный набор: POST /ingest?group_id=DEV (или python -m ml.batch --group-id DEV --ingest).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

from backend.app import db, service
from ml.judges import make_judge
from ml.pipeline import evaluate_conversation

ROOT = Path(__file__).resolve().parent


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--gold", default=str(ROOT / "gold_dev.json"))
    p.add_argument("--mode", choices=["auto", "anthropic", "rules"], default="rules")
    p.add_argument("--show-misses", action="store_true")
    a = p.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    db.init_db()
    service.seed_checklists()
    gold = json.loads(Path(a.gold).read_text(encoding="utf-8"))
    checklist = service.get_checklist_or_404(gold["checklist_id"])
    judge = make_judge(a.mode)

    hits, total = Counter(), Counter()
    misses = defaultdict(list)
    cost = 0.0
    for cid, labels in gold["labels"].items():
        conv = db.get_conversation(cid)
        if not conv:
            print(f"skip {cid}: not ingested", file=sys.stderr)
            continue
        res = evaluate_conversation(conv, checklist, judge)
        cost += res["pipeline"]["cost_usd"]
        got = {c["id"]: c["answer"] for c in res["criteria"]}
        for crit_id, want in labels.items():
            if want is None:
                continue
            total[crit_id] += 1
            if str(got.get(crit_id)) == str(want):
                hits[crit_id] += 1
            else:
                misses[crit_id].append(f"{cid}: gold={want} got={got.get(crit_id)}")

    print(f"judge={judge.name} model={judge.model} | gold={Path(a.gold).name} | cost=${cost:.4f}")
    print(f"{'criterion':<10}{'accuracy':>10}{'n':>5}")
    all_h = all_t = 0
    for crit_id in sorted(total):
        all_h += hits[crit_id]
        all_t += total[crit_id]
        print(f"{crit_id:<10}{hits[crit_id] / total[crit_id]:>10.0%}{total[crit_id]:>5}")
    print(f"{'ALL':<10}{(all_h / all_t if all_t else 0):>10.0%}{all_t:>5}")
    if a.show_misses:
        for crit_id in sorted(misses):
            for m in misses[crit_id]:
                print(f"  {crit_id} miss  {m}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
