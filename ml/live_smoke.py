"""Живая проверка LLM-провайдера из env: Claude (ANTHROPIC_API_KEY) или OpenAI-совместимый, например бесплатный Gemini
(OPENAI_COMPAT_API_KEY). Добавьте --list-models, чтобы увидеть модели провайдера.

    backend\\.venv\\Scripts\\python -m ml.live_smoke                      # 1 DEV-диалог, проверка всего пути
    backend\\.venv\\Scripts\\python -m ml.live_smoke --conversation p1-ru-013 --strategy single_call

Проверяет: structured output проходит валидацию, usage приходит, кэш префикса читается со 2-го вызова,
кэш ответов делает повтор бесплатным, стоимость считается. Ничего не пишет в таблицу результатов.
"""
from __future__ import annotations

import argparse
import sys

from backend.app import config, db, service
from ml.judges import is_llm, make_judge
from ml.pipeline import evaluate_conversation


def main(argv=None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--conversation", default="p1-ru-013")
    p.add_argument("--checklist", default=None)
    p.add_argument("--strategy", choices=["per_criterion", "single_call"], default=None)
    p.add_argument("--list-models", action="store_true", help="показать модели провайдера и выйти")
    a = p.parse_args(argv)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    judge = make_judge()
    if not is_llm(judge):
        print("SKIP: нет ключа LLM-провайдера (ANTHROPIC_API_KEY / OPENAI_COMPAT_API_KEY) — живой вызов не выполнялся.")
        return 2
    print(f"провайдер: {judge.name}, модель: {judge.model}")
    if a.list_models:
        if not hasattr(judge, "list_models"):
            print("список моделей доступен только для OpenAI-совместимого провайдера")
            return 0
        for m in judge.list_models():
            print(" ", m)
        return 0
    if a.strategy:
        config.LLM_STRATEGY = a.strategy
    db.init_db()
    service.seed_checklists()
    conv = db.get_conversation(a.conversation)
    if not conv:
        print(f"нет диалога {a.conversation}: сначала POST /ingest?group_id=DEV")
        return 2
    checklist = service.get_checklist_or_404(a.checklist)

    config.LLM_RESULT_CACHE = True
    # первый прогон — честно через API: кэш ответов не читаем, но пишем (второй платный прогон не нужен)
    judge._cache_get = lambda key: None
    first = evaluate_conversation(conv, checklist, judge)
    del judge._cache_get
    p1 = first["pipeline"]
    ok = True

    def check(cond: bool, msg: str):
        nonlocal ok
        ok &= cond
        print(f"[{'OK' if cond else 'FAIL'}] {msg}")

    check(p1["llm_calls"] > 0 and p1["input_tokens"] + p1["cache_read_tokens"] + p1["cache_write_tokens"] > 0,
          f"API ответил: model={p1['model']} strategy={p1['strategy']} calls={p1['llm_calls']}")
    check(p1["llm_fallbacks"] == 0, f"structured output без fallback (ошибки: {p1['errors'] or 'нет'})")
    if p1["strategy"] == "per_criterion" and judge.name == "anthropic":
        check(p1["cache_read_tokens"] > 0, f"кэш префикса читается: write={p1['cache_write_tokens']} read={p1['cache_read_tokens']}")
    srcs = {c["id"]: c["source"] for c in first["criteria"]}
    check(all(s.startswith("llm") for s in srcs.values()), f"все критерии от LLM: {srcs}")
    if p1["errors"]:
        print("      ошибки:", p1["errors"][:3])
    print(f"      итог={first['overall']} грубые={first['critical_error']} на проверку={first['review_criteria']} "
          f"согласие с правилами={first['agreement_rate']}")
    print(f"      токены: in={p1['input_tokens']} out={p1['output_tokens']} cache_write={p1['cache_write_tokens']} "
          f"cache_read={p1['cache_read_tokens']} | стоимость ${p1['cost_usd']:.4f} | {p1['duration_sec']} c")

    again = evaluate_conversation(conv, checklist, judge)
    check(again["pipeline"]["result_cache_hits"] == len(checklist["criteria"]) and again["pipeline"]["cost_usd"] == 0,
          f"повтор из кэша ответов бесплатный: hits={again['pipeline']['result_cache_hits']}")
    print("\nLIVE SMOKE:", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
