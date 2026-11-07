"""Pass A — Retriever: для каждого критерия 1–3 спана-кандидата + missing-expected-span.

Работает правилами (быстро, бесплатно, на оригинальном языке). Его же признаки
использует rule-based судья, когда нет ключа LLM. LLM-судья получает спаны как подсказку,
но видит весь транскрипт и может с ними не согласиться.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional

from . import lexicon as L

ROLE_RU = {"operator": "оператор", "client": "клиент", "bot": "бот", "system": "система"}


@dataclass
class Turn:
    index: int
    timestamp: str
    speaker: str
    text: str

    def ev(self, why: str = "") -> dict:
        return {"index": self.index, "timestamp": self.timestamp, "speaker": self.speaker, "text": self.text, "why": why}


@dataclass
class Ctx:
    turns: list[Turn]
    language: str
    channel: str
    op: list[Turn] = field(default_factory=list)
    client: list[Turn] = field(default_factory=list)
    system: list[Turn] = field(default_factory=list)

    @property
    def first_op(self) -> Optional[Turn]:
        return self.op[0] if self.op else None

    @property
    def last_op(self) -> Optional[Turn]:
        return self.op[-1] if self.op else None

    def after(self, idx: int, speaker: str | None = None) -> list[Turn]:
        return [t for t in self.turns if t.index > idx and (speaker is None or t.speaker == speaker)]

    def before(self, idx: int, speaker: str | None = None) -> list[Turn]:
        return [t for t in self.turns if t.index < idx and (speaker is None or t.speaker == speaker)]


def build_ctx(conversation: dict) -> Ctx:
    turns = [Turn(i, str(t.get("timestamp") or ""), (t.get("speaker") or "").lower(), t.get("text") or "")
             for i, t in enumerate(conversation.get("transcript") or [])]
    ctx = Ctx(turns=turns, language=(conversation.get("language") or "").upper(), channel=conversation.get("channel") or "")
    ctx.op = [t for t in turns if t.speaker == "operator"]
    ctx.client = [t for t in turns if t.speaker == "client"]
    ctx.system = [t for t in turns if t.speaker == "system"]
    return ctx


def _hits(turns: list[Turn], pattern) -> list[Turn]:
    return [t for t in turns if pattern.search(t.text)]


def _substantive(t: Turn) -> bool:
    """Реплика оператора по существу (не только приветствие/прощание)."""
    text = t.text.strip()
    if len(text) < 25:
        return False
    stripped = L.GREETING.sub("", L.FAREWELL.sub("", L.INTRO.sub("", text)))
    return len(stripped.strip(" .,!?-—")) >= 20


def _reasks(ctx: Ctx) -> list[Turn]:
    if not ctx.first_op:
        return []
    return [t for t in ctx.after(ctx.first_op.index, "client") if L.REASK.search(t.text)]


def _client_request(ctx: Ctx) -> list[Turn]:
    """Реплики клиента, где сформулирован запрос (вопрос/проблема), без коротких «да», «2», «ок»."""
    return [t for t in ctx.client if len(t.text.strip()) >= 12 and not t.text.strip().isdigit()]


# ---------------- per-rule analysis ----------------
# Каждая функция возвращает: spans (1–3), missing (или None), features, и предложение правил:
# answer, na_reason, reason (почему).

def rule_contact(ctx: Ctx, crit: dict) -> dict:
    t = ctx.first_op
    if not t:
        return dict(spans=[], missing=None, features={"operator_joined": False},
                    answer="NO", reason="Оператор так и не ответил в чате, приветствия и представления нет.")
    greet = bool(L.GREETING.search(t.text))
    intro = bool(L.INTRO.search(t.text) or L.INTRO_NAME.search(t.text))
    op_lang = L.detect_lang(t.text)
    lang_ok = op_lang is None or ctx.language in ("", op_lang)
    feats = {"greeting": greet, "introduction": intro, "operator_lang": op_lang, "client_lang": ctx.language}
    if greet and intro and lang_ok:
        return dict(spans=[t.ev("первый ответ оператора")], missing=None, features=feats, answer="YES",
                    reason="В первом ответе оператор поздоровался на языке клиента и представился.")
    missing_parts = []
    if not greet:
        missing_parts.append("приветствия")
    if not intro:
        missing_parts.append("представления")
    if not lang_ok:
        missing_parts.append(f"ответа на языке клиента ({ctx.language}, оператор: {op_lang})")
    return dict(spans=[t.ev("первый ответ оператора")], missing=t.ev("здесь ожидались приветствие и представление"),
                features=feats, answer="NO", reason="В первом ответе оператора нет " + ", ".join(missing_parts) + ".")


def rule_need(ctx: Ctx, crit: dict) -> dict:
    if not ctx.first_op:
        return dict(spans=[], missing=None, features={"operator_joined": False}, answer="NA",
                    na_reason="Оператор не вступил в диалог — уточнять было некому.", reason="")
    questions = [t for t in ctx.op if "?" in t.text and not L.HELP_OFFER.search(t.text)]
    clarifying = [t for t in questions if L.CLARIFY.search(t.text) or len(t.text) < 160]
    reasks = _reasks(ctx)
    feats = {"operator_questions": len(questions), "client_reasks": len(reasks)}
    if clarifying:
        return dict(spans=[t.ev("уточняющий вопрос оператора") for t in clarifying[:2]] + ([ctx.client[0].ev("исходный запрос")] if ctx.client else []),
                    missing=None, features=feats, answer="YES",
                    reason="Оператор уточнил недостающие детали, прежде чем отвечать.")
    if reasks:
        return dict(spans=[reasks[0].ev("клиенту пришлось уточнять самому"), ctx.first_op.ev("ответ без уточнения")],
                    missing=ctx.first_op.ev("здесь ожидалось уточнение недостающих деталей"), features=feats, answer="NO",
                    reason="Оператор ответил, не уточнив недостающие детали; клиенту пришлось переспрашивать.")
    first_req = _client_request(ctx)
    spans = [first_req[0].ev("запрос клиента")] if first_req else []
    return dict(spans=spans, missing=None, features=feats, answer="NA",
                na_reason="Данных для ответа хватало с самого начала: запрос клиента был конкретным, уточнения не понадобились.",
                reason="")


def rule_identification(ctx: Ctx, crit: dict) -> dict:
    verified = _hits(ctx.turns, L.VERIFIED)
    requests = _hits(ctx.op, L.VERIFY_REQUEST)
    disclosures = _hits(ctx.op, L.ACCOUNT_DISCLOSURE)
    feats = {"verified": bool(verified), "verify_requested": bool(requests), "account_disclosures": len(disclosures)}
    v_idx = verified[0].index if verified else None
    if disclosures:
        first_disc = disclosures[0]
        if v_idx is not None and v_idx < first_disc.index:
            return dict(spans=[verified[0].ev("подтверждение личности"), first_disc.ev("раскрытие данных после проверки")],
                        missing=None, features=feats, answer="YES",
                        reason="Личность подтверждена до раскрытия данных по счёту.")
        return dict(spans=[first_disc.ev("данные по счёту раскрыты")] + ([verified[0].ev("подтверждение позже")] if verified else []),
                    missing=first_disc.ev("до этой реплики ожидалось подтверждение личности"), features=feats, answer="NO",
                    reason="Оператор раскрыл данные по счёту без подтверждённой идентификации.")
    if verified:
        spans = [t.ev("проверка личности") for t in (requests[:1] + verified[:1])]
        return dict(spans=spans, missing=None, features=feats, answer="YES",
                    reason="Перед работой с данными клиента личность была подтверждена.")
    spans = [t.ev("оператор упомянул проверку личности") for t in requests[:1]] or ([ctx.client[0].ev("исходный запрос")] if ctx.client else [])
    return dict(spans=spans, missing=None, features=feats, answer="NA",
                na_reason="Запрос не требовал идентификации: данные счёта не раскрывались, защищённых действий не было.", reason="")


def rule_consult(ctx: Ctx, crit: dict) -> dict:
    requests = _client_request(ctx)
    if not requests:
        return dict(spans=[], missing=None, features={"client_request": False}, answer="NA",
                    na_reason="Чат закончился до того, как клиент сформулировал запрос.", reason="")
    subst = [t for t in ctx.op if _substantive(t)]
    instr = [t for t in subst if L.INSTRUCTION.search(t.text)]
    reasks = _reasks(ctx)
    last = ctx.turns[-1] if ctx.turns else None
    open_q = [t for t in ctx.client if "?" in t.text and not any(o.index > t.index and _substantive(o) for o in ctx.op)]
    feats = {"substantive_operator_turns": len(subst), "instructions": len(instr), "client_reasks": len(reasks),
             "unanswered_questions": len(open_q)}
    if not subst:
        return dict(spans=[requests[0].ev("запрос клиента")], missing=(ctx.first_op or requests[0]).ev("здесь ожидался ответ по существу"),
                    features=feats, answer=0, reason="Ответа по существу нет.")
    if open_q:
        return dict(spans=[instr[0].ev("частичный ответ") if instr else subst[0].ev("ответ оператора"), open_q[0].ev("вопрос остался без ответа")],
                    missing=open_q[0].ev("после этого вопроса ожидался ответ"), features=feats, answer=10,
                    reason="Часть запроса закрыта, но существенный вопрос клиента остался без ответа.")
    best = (instr or subst)
    if not reasks:
        return dict(spans=[t.ev("ответ / следующий шаг") for t in best[:2]], missing=None, features=feats, answer=20,
                    reason="Оператор ответил по существу или дал следующий шаг, вопросы клиента закрыты.")
    last_client = ctx.client[-1] if ctx.client else None
    if last_client and reasks[-1].index == last_client.index:
        # TODO(hackathon): «клиенту всё ещё непонятно» по правилам = последний переспрос без ответа
        return dict(spans=[best[0].ev("общий ответ"), reasks[-1].ev("клиенту всё ещё непонятно")], missing=reasks[-1].ev("после этого ожидалось понятное объяснение"),
                    features=feats, answer=5, reason="Есть общая подсказка, но клиенту всё ещё непонятно, как действовать.")
    return dict(spans=[best[-1].ev("итоговый ответ"), reasks[0].ev("клиенту пришлось переспросить")], missing=None,
                features=feats, answer=15, reason="Основной вопрос решён, но первый ответ был неполным — клиент уточнял детали.")


def rule_empathy(ctx: Ctx, crit: dict) -> dict:
    rude = _hits(ctx.op, L.INSULT)
    complaints = _hits(ctx.client, L.COMPLAINT)
    empathy = _hits(ctx.op, L.EMPATHY)
    feats = {"complaints": len(complaints), "empathy_phrases": len(empathy), "rude": len(rude)}
    if rude:
        return dict(spans=[rude[0].ev("невежливая реплика")], missing=None, features=feats, answer="NO",
                    reason="Оператор допустил невежливую реплику.")
    if not ctx.op:
        return dict(spans=[], missing=None, features=feats, answer="NO", reason="Оператор не ответил клиенту.")
    if complaints:
        reacted = [t for t in empathy if t.index > complaints[0].index]
        if reacted:
            return dict(spans=[complaints[0].ev("недовольство клиента"), reacted[0].ev("реакция оператора")], missing=None,
                        features=feats, answer="YES", reason="Клиент описал неудобство, оператор вежливо отреагировал на конкретную проблему.")
        nxt = next((t for t in ctx.op if t.index > complaints[0].index), ctx.first_op)
        return dict(spans=[complaints[0].ev("недовольство клиента"), nxt.ev("ответ без реакции на проблему")],
                    missing=nxt.ev("здесь ожидалась реакция на недовольство"), features=feats, answer="NO",
                    reason="Клиент выразил недовольство, но оператор не отреагировал на проблему.")
    return dict(spans=[(empathy or ctx.op)[0].ev("вежливый тон")], missing=None, features=feats, answer="YES",
                reason="Оператор вежлив; недовольства клиент не выражал.")


def rule_control(ctx: Ctx, crit: dict) -> dict:
    if not ctx.op:
        return dict(spans=[], missing=None, features={}, answer=0, reason="Оператор не вёл диалог.")
    reasks = _reasks(ctx)
    glitches = _hits(ctx.op, L.OP_GLITCH)
    feats = {"client_reasks": len(reasks), "operator_glitches": len(glitches)}
    n = len(reasks) + (1 if glitches and not reasks else 0)
    steps = sorted(crit.get("scale") or [0, 4, 7, 10], reverse=True)  # [10,7,4,0]
    answer = steps[min(n, len(steps) - 1)]
    if n == 0:
        return dict(spans=[ctx.op[-1].ev("ответы ясные")], missing=None, features=feats, answer=answer,
                    reason="Ответы оператора ясные и последовательные, переспрашивать не пришлось.")
    bad = (reasks or glitches)[:2]
    prev_op = next((t for t in reversed(ctx.op) if t.index < bad[0].index), ctx.first_op)
    return dict(spans=[prev_op.ev("неясная формулировка")] + [t.ev("переспрос / поправка") for t in bad], missing=None,
                features=feats, answer=answer,
                reason=f"Зафиксировано сбоев в ясности: {n} (клиент переспрашивал или оператор поправлялся).")


def rule_close(ctx: Ctx, crit: dict) -> dict:
    if not ctx.op:
        return dict(spans=[], missing=None, features={}, answer="NA", na_reason="Оператор не подключился — завершать было нечего.", reason="")
    last_op = ctx.last_op
    tail_ops = ctx.op[-2:]
    bye = [t for t in tail_ops if L.FAREWELL.search(t.text) or L.HELP_MORE.search(t.text)]
    left = _hits([t for t in ctx.system if t.index > last_op.index], L.CLIENT_LEFT)
    feats = {"farewell": bool(bye), "client_left": bool(left)}
    if bye:
        return dict(spans=[bye[-1].ev("прощание / предложение помощи")], missing=None, features=feats, answer="YES",
                    reason="Оператор подвёл итог или предложил помощь и попрощался.")
    after_last = ctx.after(last_op.index, "client")
    if left or (after_last and after_last[-1].index == ctx.turns[-1].index and len(after_last) >= 1 and "?" not in after_last[-1].text):
        ev = (left or after_last)[-1]
        return dict(spans=[ev.ev("клиент вышел из чата")], missing=None, features=feats, answer="NA",
                    na_reason="Чат оборвался до возможности его завершить: клиент ушёл после ответа оператора.", reason="")
    return dict(spans=[last_op.ev("последняя реплика оператора")], missing=last_op.ev("здесь ожидалось прощание или предложение помощи"),
                features=feats, answer="NO", reason="Оператор закончил диалог без прощания и предложения дальнейшей помощи.")


def rule_critical(ctx: Ctx, crit: dict) -> dict:
    found = []
    for name, pat in (("оскорбление клиента", L.INSULT), ("услуга в обход компании", L.BYPASS), ("раскрытие конфиденциальной информации", L.LEAK)):
        for t in _hits(ctx.op, pat):
            found.append((name, t))
    feats = {"violations": [n for n, _ in found]}
    if found:
        return dict(spans=[t.ev(n) for n, t in found[:3]], missing=None, features=feats, answer="YES",
                    reason="Выявлено: " + ", ".join(sorted({n for n, _ in found})) + ".")
    return dict(spans=[], missing=None, features=feats, answer="NO",
                reason="Оскорблений, предложений услуг в обход компании и раскрытия конфиденциальной информации не выявлено.")


def rule_keywords(ctx: Ctx, crit: dict) -> dict:
    """Fallback для НОВЫХ критериев без встроенного правила: ищем keywords в репликах оператора."""
    import re
    kws = [k for k in (crit.get("keywords") or []) if k.strip()]
    top = (max(crit["scale"]) if crit["type"] == "scale" else "YES")
    low = (0 if crit["type"] == "scale" else "NO")
    if not ctx.op and crit.get("na_allowed"):
        return dict(spans=[], missing=None, features={}, answer="NA", na_reason=crit.get("na_condition") or "Оператор не участвовал.", reason="")
    if not kws:
        # TODO(hackathon): без LLM и без keywords честно не оценить — ставим N/A если можно, иначе низший балл с пометкой
        if crit.get("na_allowed"):
            return dict(spans=[], missing=None, features={"no_rule": True}, answer="NA",
                        na_reason="Rule-based режим: для нового критерия нет правил/ключевых слов, нужна оценка LLM или проверяющего.", reason="")
        return dict(spans=[], missing=None, features={"no_rule": True}, answer=low,
                    reason="Rule-based режим: для нового критерия нет правил/ключевых слов — требуется проверка (апелляция).")
    pat = re.compile("|".join(re.escape(k) for k in kws), re.IGNORECASE)
    hits = _hits(ctx.op, pat)
    if hits:
        return dict(spans=[t.ev("совпадение по ключевым словам критерия") for t in hits[:2]], missing=None, features={"keyword_hits": len(hits)},
                    answer=top, reason="В репликах оператора найдено требуемое действие.")
    return dict(spans=[], missing=(ctx.last_op or ctx.turns[-1]).ev("требуемое действие не найдено") if ctx.turns else None,
                features={"keyword_hits": 0}, answer=low, reason="Требуемое действие в репликах оператора не найдено.")


RULES: dict[str, Callable[[Ctx, dict], dict]] = {
    "contact": rule_contact, "need": rule_need, "identification": rule_identification, "consult": rule_consult,
    "empathy": rule_empathy, "control": rule_control, "close": rule_close, "critical": rule_critical,
}


def analyze(ctx: Ctx, crit: dict) -> dict:
    fn = RULES.get(crit.get("rule") or "", rule_keywords)
    out = fn(ctx, crit)
    out.setdefault("na_reason", "")
    out["spans"] = [s for s in out.get("spans", []) if s][:3]
    # если правило предложило N/A, а критерий его не допускает — пусть судья решит; правила дают низший балл
    if out["answer"] == "NA" and not crit.get("na_allowed"):
        out["answer"] = 0 if crit["type"] == "scale" else "NO"
    return out


def retrieve(ctx: Ctx, checklist: dict) -> dict[str, dict]:
    """Pass A: {criterion_id: {spans, missing, features, rule_answer, ...}}"""
    return {c["id"]: analyze(ctx, c) for c in checklist["criteria"]}
