"""Human-in-the-loop: какие критерии автооценки стоит показать проверяющему и почему.

Сигналы детерминированные и объяснимые (не «вероятность правильности»):
- rules_llm_disagree — правила и LLM независимо пришли к разным ответам;
- llm_low_confidence — модель сама отметила низкую уверенность;
- llm_fallback      — LLM не ответила (ошибка/отказ), стоит ответ правил;
- consistency_override — ответ судьи был исправлен детерминированной проверкой;
- no_evidence       — ответ без подтверждающей реплики;
- no_rule           — новый критерий без правил в режиме без LLM;
- critical_flag     — найдена грубая ошибка: подтверждает человек (дорогая ошибка в обе стороны).

confidence (high | medium | low) — уровень по этим сигналам, а не откалиброванная вероятность.
"""
from __future__ import annotations

from collections import Counter

from scoring import ScoringError, normalize_answer

# Сигналы, которые означают неуверенность (critical_flag — это важность, а не неуверенность)
UNCERTAIN = {"rules_llm_disagree", "llm_low_confidence", "llm_fallback", "consistency_override", "no_evidence", "no_rule"}


def _agreement(crit: dict, answer, rule_answer) -> str | None:
    try:
        a, r = normalize_answer(crit, answer), normalize_answer(crit, rule_answer)
    except ScoringError:
        return None
    if a == r:
        return "agree"
    if crit["type"] == "scale" and "NA" not in (a, r):
        scale = sorted(crit["scale"])
        if abs(scale.index(a) - scale.index(r)) == 1:
            return "near"  # соседние ступени шкалы — расхождение в пределах одного шага
    return "disagree"


def annotate(checklist: dict, judgments: dict[str, dict], hints: dict[str, dict], judge_name: str) -> None:
    """Добавляет в каждый judgment: rule_answer, agreement, confidence, needs_review, review_reasons."""
    llm = judge_name == "anthropic"
    for crit in checklist["criteria"]:
        j, hint = judgments[crit["id"]], hints[crit["id"]]
        source = str(j.get("source") or "")
        reasons: list[str] = []
        agreement = None
        if llm and source.startswith("llm"):
            agreement = _agreement(crit, j["answer"], hint["answer"])
            if agreement == "disagree":
                reasons.append("rules_llm_disagree")
            if j.get("llm_confidence") == "low":
                reasons.append("llm_low_confidence")
        if "fallback" in source:
            reasons.append("llm_fallback")
        if "consistency" in source:
            reasons.append("consistency_override")
        if (str(j["answer"]) != "NA" and crit["type"] != "flag"
                and not j.get("evidence_list") and not j.get("expected")):
            reasons.append("no_evidence")
        if (hint.get("features") or {}).get("no_rule") and not llm:
            reasons.append("no_rule")
        if crit["type"] == "flag" and str(j["answer"]) == "YES":
            reasons.append("critical_flag")

        uncertain = [r for r in reasons if r in UNCERTAIN]
        if uncertain:
            confidence = "low"
        elif llm and agreement == "agree" and j.get("llm_confidence", "high") != "medium":
            confidence = "high"  # два независимых метода согласны
        else:
            confidence = "medium"  # один метод (только правила) или расхождение в один шаг шкалы
        j.update({"rule_answer": hint["answer"], "agreement": agreement, "confidence": confidence,
                  "needs_review": bool(reasons), "review_reasons": reasons})


def summarize(criteria: list[dict]) -> dict:
    """Сводка по результату: нужна ли ручная проверка и где."""
    flagged = [c["id"] for c in criteria if c.get("needs_review") and not c.get("reviewed")]
    compared = [c for c in criteria if c.get("agreement")]
    return {
        "review_required": bool(flagged),
        "review_criteria": flagged,
        "agreement_rate": round(sum(c["agreement"] == "agree" for c in compared) / len(compared), 3) if compared else None,
        "review_reasons": dict(Counter(r for c in criteria if not c.get("reviewed") for r in c.get("review_reasons") or [])),
    }
