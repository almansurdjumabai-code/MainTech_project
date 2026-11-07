"""QA блок 2: движок скоринга. Ожидаемые значения посчитаны вручную по PDF до чтения кода — записаны литералами,
а не через round() или ту же формулу, что в коде."""
import copy
import json
from pathlib import Path

import pytest

from scoring import ScoringError, aggregate

ROOT = Path(__file__).resolve().parents[2]
CL = json.loads((ROOT / "configs/checklists/cqa-default-v1.json").read_text(encoding="utf-8"))


def j(**answers):
    base = {"C1": "YES", "C2": "YES", "C3": "YES", "C4": 20, "C5": "YES", "C6": 10, "C7": "YES", "C8": "NO"}
    base.update(answers)
    return {k: {"answer": v} for k, v in base.items()}


def pts(res, cid):
    return next(c for c in res["criteria"] if c["id"] == cid)["points"]


def test_weights_match_pdf():
    w = {c["id"]: c["weight"] for c in CL["criteria"]}
    assert w == {"C1": 10, "C2": 15, "C3": 20, "C4": 20, "C5": 15, "C6": 15, "C7": 5, "C8": 0}


def test_all_perfect_100():
    assert aggregate(CL, j())["overall"] == 100.00


def test_all_bad_0():
    res = aggregate(CL, j(C1="NO", C2="NO", C3="NO", C4=0, C5="NO", C6=0, C7="NO"))
    assert res["overall"] == 0.00


def test_one_na_88_13_half_up():
    # 10 + 15 + (C3 N/A) + 15 + 15 + 10.5 + 5 = 70.5 из 80 -> 88.125 -> 88.13 (половина вверх, не банковское 88.12)
    res = aggregate(CL, j(C3="NA", C4=15, C6=7))
    assert res["overall"] == 88.13


@pytest.mark.parametrize("step,before", [(0, 0), (5, 5), (10, 10), (15, 15), (20, 20)])
def test_consult_steps_before_redistribution(step, before):
    # без N/A перераспределения нет: баллы C4 = ступень (вес 20, макс. ступень 20)
    assert pts(aggregate(CL, j(C4=step)), "C4") == before


def test_control_7_gives_10_5():
    assert pts(aggregate(CL, j(C6=7)), "C6") == 10.5


def test_no_applicable_overall_not_computed():
    custom = {"name": "all-na", "rounding": 2, "criteria": [
        {"id": "A", "name": "a", "type": "binary", "weight": 50, "na_allowed": True, "na_condition": "x", "description": "a"},
        {"id": "B", "name": "b", "type": "scale", "scale": [0, 5], "weight": 50, "na_allowed": True, "na_condition": "x", "description": "b"},
    ]}
    res = aggregate(custom, {"A": {"answer": "NA"}, "B": {"answer": "NA"}})
    assert res["overall"] is None and res["max_overall"] is None  # не 0 и не исключение


def test_critical_flag_separate_points_unchanged():
    clean, flagged = aggregate(CL, j()), aggregate(CL, j(C8="YES"))
    assert flagged["overall"] == clean["overall"] == 100.00
    assert flagged["critical_error"] is True and clean["critical_error"] is False
    assert flagged["critical_criteria"] == ["C8"]


def test_weights_sum_90_still_out_of_100():
    custom = copy.deepcopy(CL)
    next(c for c in custom["criteria"] if c["id"] == "C7")["weight"] = 0  # 100 - 5 = 95
    next(c for c in custom["criteria"] if c["id"] == "C1")["weight"] = 5  # 95 - 5 = 90
    assert aggregate(custom, j())["overall"] == 100.00
    # C6 = 7: 10.5 из 15 -> потеря 4.5 из 90 -> 85.5/90 = 95.0
    assert aggregate(custom, j(C6=7))["overall"] == 95.00


def test_invalid_step_12_rejected():
    with pytest.raises(ScoringError):
        aggregate(CL, j(C4=12))


def test_na_on_empathy_rejected():
    with pytest.raises(ScoringError):
        aggregate(CL, j(C5="NA"))


def test_rounding_half_up_not_bankers():
    # 0.125 и 0.375 — классические случаи, где round() банковский даёт 0.12 / 0.38 vs half-up 0.13 / 0.38
    custom = {"name": "r", "rounding": 2, "criteria": [
        {"id": "A", "name": "a", "type": "scale", "scale": [0, 1, 8], "weight": 100, "na_allowed": False, "description": "a"}]}
    # 1/8 * 100 = 12.5 -> при rounding=0 half-up 13 (банковское дало бы 12)
    custom0 = {**custom, "rounding": 0}
    assert aggregate(custom0, {"A": {"answer": 1}})["overall"] == 13
