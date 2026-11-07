"""Pass D — Consistency: детерминированные санитары поверх ответов судьи (до агрегации)."""
from __future__ import annotations

from scoring import ScoringError, normalize_answer

from .judges import build_explanation
from .retriever import Ctx


def apply(ctx: Ctx, checklist: dict, judgments: dict[str, dict], hints: dict[str, dict]) -> list[str]:
    """Правит judgments на месте. Возвращает список заметок о правках (видны в результате)."""
    notes: list[str] = []
    for crit in checklist["criteria"]:
        cid = crit["id"]
        j = judgments[cid]
        hint = hints[cid]

        # 1. ответ вне шкалы / N/A где запрещён -> берём ответ правил
        try:
            j["answer"] = normalize_answer(crit, j["answer"])
        except ScoringError as exc:
            notes.append(f"{cid}: ответ судьи отклонён ({exc}), взят ответ правил")
            j["answer"] = normalize_answer(crit, hint["answer"])
            j["source"] = f"{j.get('source')}+consistency"

        # 2. N/A без причины -> подставляем условие из чек-листа
        if j["answer"] == "NA" and not j.get("na_reason"):
            j["na_reason"] = f"Выполнено условие N/A: {crit.get('na_condition')}"

        # 3. evidence обязателен для не-N/A ответов: если судья не дал — берём спаны retriever'а
        if j["answer"] != "NA" and not j.get("evidence_list") and hint["spans"]:
            j["evidence_list"] = [{k: s[k] for k in ("index", "timestamp", "speaker", "text")} for s in hint["spans"]]

    # 4. Консультация: максимум при пустой консультации недопустим
    c4 = next((c for c in checklist["criteria"] if c.get("rule") == "consult"), None)
    if c4:
        j, feats = judgments[c4["id"]], hints[c4["id"]].get("features", {})
        top = max(c4["scale"])
        if j["answer"] == top and feats.get("substantive_operator_turns", 1) == 0:
            j["answer"] = 0
            j["source"] = f"{j.get('source')}+consistency"
            j["explanation"] = build_explanation(c4, 0, "Ответа по существу нет (консистентность: максимальный балл при пустой консультации снят).",
                                                 j.get("evidence_list", []), j.get("expected"), "")
            notes.append(f"{c4['id']}: {top} -> 0, у оператора нет ответа по существу")

    # 5. Нет ни одной реплики оператора -> «Завершение» не может быть «Да»
    close = next((c for c in checklist["criteria"] if c.get("rule") == "close"), None)
    if close and not ctx.op and judgments[close["id"]]["answer"] == "YES":
        judgments[close["id"]]["answer"] = "NA" if close.get("na_allowed") else "NO"
        notes.append(f"{close['id']}: оператор не участвовал, «Да» снято")
    return notes
