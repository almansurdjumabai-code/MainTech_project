import json
from pathlib import Path

import pytest

from scoring import ScoringError, aggregate
from scoring.checklist import Checklist

CHECKLIST = json.loads(
    (Path(__file__).resolve().parents[2] / "configs/checklists/cqa-default-v1.json").read_text(encoding="utf-8")
)


def judg(**answers):
    base = {"C1": "YES", "C2": "YES", "C3": "YES", "C4": 20, "C5": "YES", "C6": 10, "C7": "YES", "C8": "NO"}
    base.update(answers)
    return {k: {"answer": v} for k, v in base.items()}


def by_id(res, cid):
    return next(c for c in res["criteria"] if c["id"] == cid)


def test_seed_checklist_is_valid_and_weights_sum_100():
    cl = Checklist.model_validate(CHECKLIST)
    assert sum(c.weight for c in cl.criteria) == 100


def test_all_perfect_is_100():
    res = aggregate(CHECKLIST, judg())
    assert res["overall"] == 100.0
    assert res["critical_error"] is False


def test_scale_steps_proportional_to_weight():
    res = aggregate(CHECKLIST, judg(C4=15, C6=7))
    assert by_id(res, "C4")["points"] == 15.0  # 20 * 15/20
    assert by_id(res, "C6")["points"] == 10.5  # 15 * 7/10
    assert res["overall"] == 100 - 5 - 4.5


def test_na_redistributes_weight_proportionally():
    # C3 (w=20) N/A -> применимые 80, множитель 1.25
    res = aggregate(CHECKLIST, judg(C3="NA", C7="NO"))
    assert by_id(res, "C3")["points"] is None
    assert by_id(res, "C3")["na"] is True
    assert by_id(res, "C1")["effective_weight"] == 12.5
    assert res["overall"] == round((80 - 5) * 1.25, 2)  # 93.75


def test_rounding_two_decimals():
    # применимые: 10+15+15 = 40 (C2,C3,C4,C7 NA); C6=7 -> 10.5; C1 YES 10; C5 NO
    res = aggregate(CHECKLIST, judg(C2="NA", C3="NA", C4="NA", C7="NA", C5="NO", C6=7))
    assert res["overall"] == round((10 + 10.5) * 100 / 40, 2)  # 51.25


def test_rounding_half_up_repeating():
    # применимые: C1(10)+C5(15)+C6(15)+C2(15) = 55; набрано C1=10 -> 18.1818..
    res = aggregate(CHECKLIST, judg(C3="NA", C4="NA", C7="NA", C2="NO", C5="NO", C6=0))
    assert res["overall"] == 18.18


def test_critical_not_in_sum_but_flagged():
    res = aggregate(CHECKLIST, judg(C8="YES"))
    assert res["overall"] == 100.0
    assert res["critical_error"] is True
    assert by_id(res, "C8")["points"] is None


def test_no_applicable_weighted_gives_null_overall():
    custom = {
        "name": "t", "rounding": 2,
        "criteria": [
            {"id": "A", "name": "a", "type": "binary", "weight": 50, "na_allowed": True, "na_condition": "x", "description": "d"},
            {"id": "F", "name": "f", "type": "flag", "weight": 0, "description": "d"},
        ],
    }
    res = aggregate(custom, {"A": {"answer": "NA"}, "F": {"answer": "NO"}})
    assert res["overall"] is None


def test_na_not_allowed_raises():
    with pytest.raises(ScoringError):
        aggregate(CHECKLIST, judg(C1="NA"))


def test_scale_step_outside_scale_raises():
    with pytest.raises(ScoringError):
        aggregate(CHECKLIST, judg(C4=12))


def test_weights_not_summing_to_100_still_max_100():
    custom = {
        "name": "t",
        "criteria": [
            {"id": "A", "name": "a", "type": "binary", "weight": 3, "description": "d"},
            {"id": "B", "name": "b", "type": "scale", "scale": [0, 1, 2], "weight": 1, "description": "d"},
        ],
    }
    res = aggregate(custom, {"A": {"answer": "YES"}, "B": {"answer": 2}})
    assert res["overall"] == 100.0


def test_sections_and_extra_fields_preserved():
    j = judg(C3="NA")
    j["C1"]["explanation"] = "ok"
    res = aggregate(CHECKLIST, j)
    assert by_id(res, "C1")["explanation"] == "ok"
    s2 = next(s for s in res["sections"] if s["id"] == "S2")
    assert s2["points"] == s2["max_points"] == 25.0  # только C4: 20 * 1.25
    s4 = next(s for s in res["sections"] if s["id"] == "S4")
    assert s4["points"] is None


def test_answer_aliases():
    res = aggregate(CHECKLIST, judg(C1="да", C2="N/A", C4="15"))
    assert by_id(res, "C1")["answer"] == "YES"
    assert by_id(res, "C2")["na"] is True
    assert by_id(res, "C4")["raw_score"] == 15
