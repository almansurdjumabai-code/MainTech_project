"""Оркестрация: Retriever (A) -> Judge per criterion (B) -> Consistency (D) -> Aggregator (C)."""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

from backend.app import config
from scoring import aggregate

from . import consistency, review
from .judges import ClaudeJudge, RuleJudge, Usage, make_judge
from .retriever import build_ctx, retrieve


def _to_contract(c: dict) -> dict:
    """Критерий в стабильном контракте фронта: evidence = основная реплика, evidence_all = все."""
    ev_list = c.pop("evidence_list", []) or []
    expected = c.pop("expected", None)
    c["evidence"] = expected if (expected and c["answer"] not in ("YES",) and not c["na"] and c["type"] != "flag") else (ev_list[0] if ev_list else None)
    c["evidence_all"] = ev_list
    c["expected_span"] = expected  # где ожидалось пропущенное действие
    return c


def evaluate_conversation(conversation: dict, checklist: dict, judge=None) -> dict:
    t0 = time.time()
    judge = judge or make_judge()
    ctx = build_ctx(conversation)
    hints = retrieve(ctx, checklist)  # Pass A
    usage = Usage()

    def run(crit):
        return crit["id"], judge.judge(ctx, crit, hints[crit["id"]], usage)  # Pass B

    crits = checklist["criteria"]
    if isinstance(judge, ClaudeJudge) and config.LLM_STRATEGY == "single_call":
        judgments = judge.judge_all(ctx, crits, hints, usage)
    elif isinstance(judge, ClaudeJudge) and len(crits) > 1:
        # первый вызов прогревает кэш префикса (system + транскрипт), остальные читают его параллельно
        judgments = dict([run(crits[0])])
        with ThreadPoolExecutor(max_workers=max(1, config.LLM_MAX_WORKERS)) as pool:
            judgments.update(pool.map(run, crits[1:]))
    else:
        judgments = dict(map(run, crits))

    notes = consistency.apply(ctx, checklist, judgments, hints)  # Pass D
    review.annotate(checklist, judgments, hints, judge.name)  # Pass E — что показать человеку
    agg = aggregate(checklist, judgments)  # Pass C — только математика
    criteria = [_to_contract(c) for c in agg["criteria"]]
    final = {"criteria": criteria, "sections": agg["sections"], "overall": agg["overall"],
             "max_overall": agg["max_overall"], "critical_error": agg["critical_error"],
             "critical_criteria": agg["critical_criteria"]}
    final.update(review.summarize(criteria))
    return {
        "conversation_id": conversation["conversation_id"],
        "checklist_id": checklist["id"],
        "checklist_version": checklist.get("version"),
        "language": conversation.get("language"),
        "channel": conversation.get("channel"),
        "audio_url": conversation.get("audio_url"),
        "status": "auto",
        **final,
        "original": final,
        "final": final,
        "appeals": [],
        "reviews": [],
        "pipeline": {
            "passes": ["retriever", "judge", "consistency", "review_signals", "aggregator"],
            "strategy": config.LLM_STRATEGY if isinstance(judge, ClaudeJudge) else "rules",
            "judge": judge.name,
            "model": judge.model,
            "llm_calls": usage.calls,
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "cache_write_tokens": usage.cache_write_tokens,
            "cache_read_tokens": usage.cache_read_tokens,
            "cost_usd": usage.cost_usd,
            "result_cache_hits": usage.result_cache_hits,
            "llm_fallbacks": usage.fallbacks,
            "errors": usage.errors[:10],
            "consistency_notes": notes,
            "duration_sec": round(time.time() - t0, 2),
        },
    }


__all__ = ["evaluate_conversation", "RuleJudge", "ClaudeJudge", "make_judge"]
