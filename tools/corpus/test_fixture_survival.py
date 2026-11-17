"""Recompute every derived number printed by survival-minimal."""

import json
import unittest
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

_CASE = Path(__file__).resolve().parent / "fixtures" / "survival_minimal"
_TENTH = Decimal("0.1")
_HUNDRED = Decimal(100)
_Z = Decimal("1.96")
_KELP = (
    ("n_enter_k", "d_k0", "c_k0", "n_k1", "s_k3"),
    ("n_k1", "d_k1", "c_k1", "n_k2", "s_k6"),
    ("n_k2", "d_k2", "c_k2", "n_k3", "s_k9"),
    ("n_k3", "d_k3", "c_k3", "n_end_k", "s_k12"),
)
_BLANK = (
    ("n_enter_b", "d_b0", "c_b0", "n_b1", "s_b3"),
    ("n_b1", "d_b1", "c_b1", "n_b2", "s_b6"),
    ("n_b2", "d_b2", "c_b2", "n_b3", "s_b9"),
    ("n_b3", "d_b3", "c_b3", "n_end_b", "s_b12"),
)


def _values():
    path = _CASE / "inputs" / "values.json"
    return json.loads(path.read_text(encoding="utf-8"))["values"]


def _int(values, key):
    return int(values[key]["text"])


def _points(value):
    return (value * _HUNDRED).quantize(_TENTH, rounding=ROUND_HALF_UP)


def _printed(value):
    return format(_points(value), "f")


def _product(steps):
    survival = Decimal(1)
    total = Decimal(0)
    curve = []
    for size, events, _censored in steps:
        width = Decimal(size)
        lost = Decimal(events)
        survival *= (width - lost) / width
        total += lost / (width * (width - lost))
        curve.append(survival)
    variance = survival * survival * total
    return curve, variance


class SurvivalArithmeticTests(unittest.TestCase):
    def test_flow_counts(self):
        values = _values()
        self.assertEqual(_int(values, "n_inelig") + _int(values, "n_declined"), _int(values, "n_excluded"))
        self.assertEqual(_int(values, "n_screened") - _int(values, "n_excluded"), _int(values, "n_randomized"))
        allocated = _int(values, "n_alloc_k") + _int(values, "n_alloc_b")
        self.assertEqual(allocated, _int(values, "n_randomized"))
        self.assertEqual(_int(values, "n_alloc_k") - _int(values, "n_miss_k"), _int(values, "n_enter_k"))
        self.assertEqual(_int(values, "n_alloc_b") - _int(values, "n_miss_b"), _int(values, "n_enter_b"))

    def test_method_constants(self):
        values = _values()
        self.assertEqual(values["z_mult"]["text"], "1.96")
        self.assertEqual(Decimal(values["z_mult"]["text"]), _Z)
        months = [_int(values, key) for key in ("m3", "m6", "m9", "m12")]
        self.assertEqual(months, [3, 6, 9, 12])

    def test_risk_sets_and_survival(self):
        values = _values()
        kelp = self._arm(values, _KELP)
        blank = self._arm(values, _BLANK)
        self._assert_interval(values, kelp, "se_k12", "lo_k12", "hi_k12")
        self._assert_interval(values, blank, "se_b12", "lo_b12", "hi_b12")
        self._assert_difference(values, kelp, blank)

    def _arm(self, values, rows):
        steps = []
        for size_id, event_id, censor_id, next_id, surv_id in rows:
            size = _int(values, size_id)
            events = _int(values, event_id)
            censored = _int(values, censor_id)
            self.assertEqual(size - events - censored, _int(values, next_id), next_id)
            steps.append((size, events, censored))
        curve, variance = _product(steps)
        for index, row in enumerate(rows):
            self.assertEqual(values[row[4]]["text"], _printed(curve[index]), row[4])
        return curve[-1], variance

    def _assert_interval(self, values, arm, se_id, low_id, high_id):
        survival, variance = arm
        error = variance.sqrt()
        self.assertEqual(values[se_id]["text"], _printed(error), se_id)
        self.assertEqual(values[low_id]["text"], _printed(survival - _Z * error), low_id)
        self.assertEqual(values[high_id]["text"], _printed(survival + _Z * error), high_id)

    def _assert_difference(self, values, kelp, blank):
        gap = kelp[0] - blank[0]
        error = (kelp[1] + blank[1]).sqrt()
        self.assertEqual(values["diff12"]["text"], _printed(gap))
        self.assertEqual(values["se_diff"]["text"], _printed(error))
        self.assertEqual(values["lo_diff"]["text"], _printed(gap - _Z * error))
        self.assertEqual(values["hi_diff"]["text"], _printed(gap + _Z * error))


if __name__ == "__main__":
    unittest.main()
