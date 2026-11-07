"""Сравнение автооценки с разметкой (gold). Результаты оценки в БД не пишет.

    backend\\.venv\\Scripts\\python -m eval.run_eval                                  # rule-based
    backend\\.venv\\Scripts\\python -m eval.run_eval --modes rules,hybrid,llm_only    # сравнение (LLM-режимы нужен ключ)
    backend\\.venv\\Scripts\\python -m eval.run_eval --modes rules --out backend/docs/demo/eval_results

Режимы:
- rules    — только правила (retriever + rule judge), бесплатно;
- hybrid   — Claude с подсказками retriever'а + детерминированная консистентность (основной путь);
- llm_only — Claude без подсказок retriever'а (то же structured JSON и валидация ответа);
- <mode>+review — производный: ответы, отмеченные needs_review, уходят человеку; считаем точность на остальных
  и долю ошибок, которые система сама отправила на проверку.

Нужен загруженный набор: POST /ingest?group_id=DEV (или python -m ml.batch --group-id DEV --ingest).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

from backend.app import config, db, service
from ml.judges import RuleJudge, is_llm, make_judge
from ml.pipeline import evaluate_conversation

ROOT = Path(__file__).resolve().parent


def make_mode_judge(mode: str):
    if mode == "rules":
        return RuleJudge()
    j = make_judge()  # активный LLM-провайдер из env: Claude или OpenAI-совместимый (Gemini и др.)
    if not is_llm(j):
        return None
    j.use_hints = mode != "llm_only"
    return j


def prf(pairs: list[tuple[str, str]]) -> dict:
    """Per-class precision/recall/F1 + macro-F1 + confusion matrix по парам (gold, pred)."""
    labels = sorted({g for g, _ in pairs} | {p for _, p in pairs})
    conf = {g: Counter() for g in labels}
    for g, p in pairs:
        conf[g][p] += 1
    per = {}
    for lab in labels:
        tp = conf[lab][lab]
        fp = sum(conf[g][lab] for g in labels if g != lab)
        fn = sum(conf[lab][p] for p in labels if p != lab)
        prec = tp / (tp + fp) if tp + fp else None
        rec = tp / (tp + fn) if tp + fn else None
        f1 = 2 * prec * rec / (prec + rec) if prec and rec else (0.0 if prec is not None and rec is not None else None)
        per[lab] = {"precision": prec, "recall": rec, "f1": f1, "support": tp + fn}
    f1s = [v["f1"] for v in per.values() if v["support"] and v["f1"] is not None]
    return {"per_class": per, "macro_f1": sum(f1s) / len(f1s) if f1s else None,
            "confusion": {g: dict(c) for g, c in conf.items()}}


def kappa(pairs: list[tuple[str, str]]) -> float | None:
    """Cohen's kappa: согласие с поправкой на случайное совпадение (1 — полное, 0 — как случайно)."""
    n = len(pairs)
    if n < 2:
        return None
    po = sum(a == b for a, b in pairs) / n
    labels = {a for a, _ in pairs} | {b for _, b in pairs}
    pe = sum((sum(a == l for a, _ in pairs) / n) * (sum(b == l for _, b in pairs) / n) for l in labels)
    return None if pe == 1 else (po - pe) / (1 - pe)


def human_agreement(gold: dict) -> dict | None:
    """Согласие двух разметчиков (если есть gold['second']): без него сравнение модели с человеком неполное."""
    second = gold.get("second") or {}
    by_crit = defaultdict(list)
    for cid, s in second.items():
        first = gold["labels"].get(cid) or {}
        for crit, b in (s.get("labels") or {}).items():
            a = first.get(crit)
            if a is not None and b is not None:
                by_crit[crit].append((str(a), str(b)))
    if not by_crit:
        return None
    return {"conversations": len(second),
            "criteria": {c: {"n": len(p), "agreement": sum(a == b for a, b in p) / len(p), "kappa": kappa(p)}
                         for c, p in sorted(by_crit.items())}}


def run_mode(mode: str, gold: dict, checklist: dict) -> dict | None:
    judge = make_mode_judge(mode)
    if judge is None:
        return None
    rows, cost, durations, tokens = [], 0.0, [], Counter()
    for cid, labels in gold["labels"].items():
        conv = db.get_conversation(cid)
        if not conv:
            print(f"skip {cid}: not ingested", file=sys.stderr)
            continue
        t0 = time.time()
        res = evaluate_conversation(conv, checklist, judge)
        durations.append(time.time() - t0)
        p = res["pipeline"]
        cost += p["cost_usd"]
        for k in ("input_tokens", "output_tokens", "cache_write_tokens", "cache_read_tokens", "llm_calls", "result_cache_hits", "llm_fallbacks"):
            tokens[k] += p.get(k, 0) or 0
        got = {c["id"]: c for c in res["criteria"]}
        for crit_id, want in labels.items():
            if want is None:
                continue
            c = got[crit_id]
            human_why = ((gold.get("meta") or {}).get(cid, {}).get("reasons") or {}).get(crit_id, "")
            rows.append({"conversation_id": cid, "language": conv.get("language"), "criterion": crit_id, "human_reason": human_why,
                         "model_explanation": c.get("explanation", ""),
                         "gold": str(want), "pred": str(c["answer"]), "ok": str(c["answer"]) == str(want),
                         "needs_review": bool(c.get("needs_review")), "review_reasons": c.get("review_reasons") or [],
                         "confidence": c.get("confidence")})
    n_conv = len({r["conversation_id"] for r in rows}) or 1
    return {"mode": mode, "judge": judge.name, "model": judge.model, "rows": rows,
            "cost_usd": round(cost, 6), "cost_per_conversation": round(cost / n_conv, 6),
            "latency_sec_avg": round(sum(durations) / len(durations), 3) if durations else None,
            "usage": dict(tokens), "conversations": n_conv}


def metrics(rows: list[dict], checklist: dict) -> dict:
    by_crit = defaultdict(list)
    for r in rows:
        by_crit[r["criterion"]].append(r)
    flag_ids = {c["id"] for c in checklist["criteria"] if c["type"] == "flag"}
    out = {"n": len(rows), "accuracy": sum(r["ok"] for r in rows) / len(rows) if rows else None, "criteria": {}}
    for cid, rs in sorted(by_crit.items()):
        out["criteria"][cid] = {"n": len(rs), "accuracy": sum(r["ok"] for r in rs) / len(rs),
                                "kappa": kappa([(r["gold"], r["pred"]) for r in rs]),
                                **prf([(r["gold"], r["pred"]) for r in rs])}
    f1s = [m["macro_f1"] for m in out["criteria"].values() if m["macro_f1"] is not None]
    out["macro_f1_mean"] = sum(f1s) / len(f1s) if f1s else None
    lang = defaultdict(list)
    for r in rows:
        lang[r["language"]].append(r["ok"])
    out["accuracy_by_language"] = {k: {"accuracy": sum(v) / len(v), "n": len(v)} for k, v in sorted(lang.items())}
    # Грубые ошибки: пропуск реального нарушения (False PASS) — самая дорогая ошибка
    fl = [r for r in rows if r["criterion"] in flag_ids]
    out["critical"] = {
        "n": len(fl), "gold_yes": sum(r["gold"] == "YES" for r in fl),
        "false_pass": sum(r["gold"] == "YES" and r["pred"] != "YES" for r in fl),
        "false_fail": sum(r["gold"] != "YES" and r["pred"] == "YES" for r in fl),
    }
    # N/A: отличаем «неприменимо» от «нарушения»
    na_pairs = [(r["gold"] == "NA", r["pred"] == "NA") for r in rows]
    tp = sum(g and p for g, p in na_pairs)
    out["na"] = {"gold_na": sum(g for g, _ in na_pairs), "pred_na": sum(p for _, p in na_pairs),
                 "precision": tp / sum(p for _, p in na_pairs) if any(p for _, p in na_pairs) else None,
                 "recall": tp / sum(g for g, _ in na_pairs) if any(g for g, _ in na_pairs) else None}
    # Пропущенное действие засчитано (gold NO -> pred YES): «ложный PASS» по обычным критериям
    out["false_yes"] = sum(r["gold"] == "NO" and r["pred"] == "YES" for r in rows)
    out["false_no"] = sum(r["gold"] == "YES" and r["pred"] == "NO" for r in rows)
    # Human-in-the-loop
    auto = [r for r in rows if not r["needs_review"]]
    errors = [r for r in rows if not r["ok"]]
    out["review"] = {
        "review_rate": 1 - len(auto) / len(rows) if rows else None,
        "auto_accuracy": sum(r["ok"] for r in auto) / len(auto) if auto else None,
        "errors_total": len(errors),
        "errors_sent_to_review": sum(r["needs_review"] for r in errors),
    }
    return out


def pct(x) -> str:
    return "—" if x is None else f"{x:.0%}"


def num(x) -> str:
    return "—" if x is None else f"{x:.2f}"


def to_markdown(gold: dict, results: list[dict]) -> str:
    lines = [f"# Evaluation — {gold.get('group_id')} / {gold.get('checklist_id')}", "",
             f"Разметка: `{Path(gold['_path']).name}`, {len(gold['labels'])} диалогов. "
             f"Кто размечал: {gold.get('labeled_by')}.", "",
             "> Внимание: правила rule-based режима дорабатывались на этих же диалогах, поэтому для `rules` это "
             "оценка на обучающих данных, а не независимый тест.", "",
             "«Не уверен» / спорные ответы разметки (null) исключены; метрики по критериям не смешиваются в одну.", "",
             *(["Согласие двух людей (база для сравнения с моделью): " + ", ".join(
                 f"{c} {v['agreement']:.0%} (κ={'—' if v['kappa'] is None else round(v['kappa'], 2)}, n={v['n']})"
                 for c, v in gold["_human_agreement"]["criteria"].items()), ""] if gold.get("_human_agreement") else
               ["Согласие человек–человек не измерено: нет второго разметчика.", ""]),
             "| Режим | Модель | Accuracy | Macro-F1 (ср.) | False PASS (грубые) | На проверку | Точность авто | Ошибок поймано review | $/диалог | Латентность, с |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        m = r["metrics"]
        crit = m["critical"]
        rv = m["review"]
        lines.append(f"| {r['mode']} | {r['model']} | {pct(m['accuracy'])} ({m['n']}) | "
                     f"{'—' if m['macro_f1_mean'] is None else f'{m['macro_f1_mean']:.2f}'} | "
                     f"{crit['false_pass']} из {crit['gold_yes']} | {pct(rv['review_rate'])} | {pct(rv['auto_accuracy'])} | "
                     f"{rv['errors_sent_to_review']} из {rv['errors_total']} | {r['cost_per_conversation']:.4f} | {r['latency_sec_avg']} |")
    for r in results:
        m = r["metrics"]
        weak = [cid for cid, cm in m["criteria"].items() if cm["accuracy"] < 0.8]
        lines += ["", f"## {r['mode']}", "",
                  f"Рабочая планка QA — 80% совпадений по каждому критерию. Ниже планки (первыми в доработку): {', '.join(weak) or 'нет'}.", "",
                  "| Критерий | n | Accuracy | Cohen's κ | Macro-F1 | Матрица (gold → pred) |", "|---|---|---|---|---|---|"]
        for cid, cm in m["criteria"].items():
            conf = "; ".join(f"{g}→{', '.join(f'{p}:{n}' for p, n in sorted(ps.items()))}" for g, ps in sorted(cm["confusion"].items()))
            lines.append(f"| {cid} | {cm['n']} | {pct(cm['accuracy'])} | {num(cm['kappa'])} | "
                         f"{'—' if cm['macro_f1'] is None else f'{cm['macro_f1']:.2f}'} | {conf} |")
        lines += ["", "По языкам: " + ", ".join(f"{k} {pct(v['accuracy'])} (n={v['n']})" for k, v in m["accuracy_by_language"].items()),
                  f"N/A: precision {pct(m['na']['precision'])}, recall {pct(m['na']['recall'])}. "
                  f"Засчитано пропущенное действие (gold NO → YES): {m['false_yes']}; лишнее «Нет» (YES → NO): {m['false_no']}.",
                  f"Токены: {r['usage']}"]
        misses = [x for x in r["rows"] if not x["ok"]]
        if misses:
            lines += ["", "Расхождения (для ML-инженера):", "", "| Диалог | Критерий | Модель | Человек | Почему (человек) | Объяснение модели | Ушло на проверку |",
                      "|---|---|---|---|---|---|---|"]
            lines += [f"| {x['conversation_id']} | {x['criterion']} | {x['pred']} | {x['gold']} | {x['human_reason'] or '—'} | "
                      f"{x['model_explanation'][:160].replace('|', '/')} | {', '.join(x['review_reasons']) if x['needs_review'] else 'нет'} |"
                      for x in misses]
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--gold", default=str(ROOT / "gold_dev.json"))
    p.add_argument("--mode", choices=["auto", "anthropic", "rules"], default=None, help="(старый флаг) = --modes")
    p.add_argument("--modes", default="rules", help="через запятую: rules,hybrid,llm_only")
    p.add_argument("--out", default=None, help="папка для eval_<modes>.json и .md")
    p.add_argument("--show-misses", action="store_true")
    a = p.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

    modes = [m.strip() for m in a.modes.split(",") if m.strip()]
    if a.mode:
        modes = ["rules"] if a.mode == "rules" else ["hybrid"]
    db.init_db()
    service.seed_checklists()
    gold = json.loads(Path(a.gold).read_text(encoding="utf-8"))
    gold["_path"] = a.gold
    checklist = service.get_checklist_or_404(gold["checklist_id"])
    gold["_human_agreement"] = human_agreement(gold)
    if gold["_human_agreement"]:
        print("human-human:", {c: round(v["agreement"], 2) for c, v in gold["_human_agreement"]["criteria"].items()})

    results = []
    for mode in modes:
        r = run_mode(mode, gold, checklist)
        if r is None:
            print(f"{mode}: пропущен — нет ключа LLM-провайдера (LLM-путь не запускался)", file=sys.stderr)
            continue
        r["metrics"] = metrics(r["rows"], checklist)
        results.append(r)
        m = r["metrics"]
        print(f"\n{mode}: judge={r['judge']} model={r['model']} | accuracy={pct(m['accuracy'])} (n={m['n']}) | "
              f"macroF1={m['macro_f1_mean'] and round(m['macro_f1_mean'], 2)} | critical false_pass={m['critical']['false_pass']}/{m['critical']['gold_yes']} | "
              f"review_rate={pct(m['review']['review_rate'])} auto_acc={pct(m['review']['auto_accuracy'])} "
              f"errors_to_review={m['review']['errors_sent_to_review']}/{m['review']['errors_total']} | "
              f"cost=${r['cost_usd']:.4f} (${r['cost_per_conversation']:.4f}/диалог) | latency={r['latency_sec_avg']}s")
        print(f"{'criterion':<10}{'accuracy':>10}{'macroF1':>9}{'n':>5}")
        for cid, cm in m["criteria"].items():
            f1 = "—" if cm["macro_f1"] is None else f"{cm['macro_f1']:.2f}"
            print(f"{cid:<10}{cm['accuracy']:>10.0%}{f1:>9}{cm['n']:>5}")
        print(f"{'ALL':<10}{m['accuracy']:>10.0%}{'':>9}{m['n']:>5}")
        if a.show_misses:
            for x in r["rows"]:
                if not x["ok"]:
                    print(f"  {x['criterion']} miss  {x['conversation_id']}: gold={x['gold']} got={x['pred']}"
                          f"{'  [needs_review: ' + ','.join(x['review_reasons']) + ']' if x['needs_review'] else ''}")

    if a.out and results:
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        stem = "eval_" + "_".join(r["mode"] for r in results)
        (out / f"{stem}.json").write_text(json.dumps([{k: v for k, v in r.items()} for r in results], ensure_ascii=False, indent=2),
                                          encoding="utf-8")
        (out / f"{stem}.md").write_text(to_markdown(gold, results), encoding="utf-8")
        print(f"\nотчёт: {out / (stem + '.md')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
