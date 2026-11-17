"""Recompute every printed cohort-minimal number from the counts."""

import json
import unittest
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

CASE = Path(__file__).resolve().parent / "fixtures" / "cohort_minimal"
Z = Decimal("1.96")
HUNDRED = Decimal(100)
TENTH = Decimal("0.1")
HUNDREDTH = Decimal("0.01")
_PERCENTS = (
    ("ev_exp", "n_exp", "risk_exp_pct"),
    ("ev_unexp", "n_unexp", "risk_unexp_pct"),
    ("fem_exp_k", "n_exp", "fem_exp_pct"),
    ("fem_unexp_k", "n_unexp", "fem_unexp_pct"),
    ("n_mark_exp", "n_exp", "mark_exp_pct"),
    ("n_mark_unexp", "n_unexp", "mark_unexp_pct"),
    ("shift_exp_k", "n_exp", "shift_exp_pct"),
    ("shift_unexp_k", "n_unexp", "shift_unexp_pct"),
    ("ev_mark_exp", "n_mark_exp", "pct_mark_exp"),
    ("ev_mark_unexp", "n_mark_unexp", "pct_mark_unexp"),
    ("ev_plain_exp", "n_plain_exp", "pct_plain_exp"),
    ("ev_plain_unexp", "n_plain_unexp", "pct_plain_unexp"),
)


def _values():
    path = CASE / "inputs" / "values.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload["values"]


def _dec(values, key):
    return Decimal(values[key]["text"])


def _half_up(value, quantum):
    return value.quantize(quantum, rounding=ROUND_HALF_UP)


def _percent(events, size):
    ratio = Decimal(events) / Decimal(size) * HUNDRED
    return _half_up(ratio, TENTH)


def _risk_bounds(events, size):
    total = Decimal(size)
    proportion = Decimal(events) / total
    spread = (proportion * (1 - proportion) / total).sqrt()
    low = (proportion - Z * spread) * HUNDRED
    high = (proportion + Z * spread) * HUNDRED
    return _half_up(low, TENTH), _half_up(high, TENTH)


def _risk_difference(events, size, control_events, control_size):
    exposed = Decimal(events) / Decimal(size)
    control = Decimal(control_events) / Decimal(control_size)
    diff = (exposed - control) * HUNDRED
    variance = exposed * (1 - exposed) / Decimal(size)
    variance += control * (1 - control) / Decimal(control_size)
    spread = variance.sqrt() * HUNDRED
    point = _half_up(diff, TENTH)
    low = _half_up(diff - Z * spread, TENTH)
    high = _half_up(diff + Z * spread, TENTH)
    return point, low, high


def _log_bounds(point, spread):
    log_point = point.ln()
    low = (log_point - Z * spread).exp()
    high = (log_point + Z * spread).exp()
    return _half_up(point, HUNDREDTH), _half_up(low, HUNDREDTH), _half_up(high, HUNDREDTH)


def _risk_ratio(events, size, control_events, control_size):
    exposed_k = Decimal(events)
    exposed_n = Decimal(size)
    control_k = Decimal(control_events)
    control_n = Decimal(control_size)
    point = (exposed_k / exposed_n) / (control_k / control_n)
    spread = (1 / exposed_k - 1 / exposed_n + 1 / control_k - 1 / control_n).sqrt()
    return _log_bounds(point, spread)


def _odds_ratio(events, size, control_events, control_size):
    exposed_k = Decimal(events)
    exposed_n = Decimal(size)
    control_k = Decimal(control_events)
    control_n = Decimal(control_size)
    exposed_odds = exposed_k / (exposed_n - exposed_k)
    control_odds = control_k / (control_n - control_k)
    variance = 1 / exposed_k + 1 / (exposed_n - exposed_k)
    variance += 1 / control_k + 1 / (control_n - control_k)
    return _log_bounds(exposed_odds / control_odds, variance.sqrt())


class CohortMinimalArithmeticTests(unittest.TestCase):
    def setUp(self):
        self.values = _values()

    def test_flow_counts_add(self):
        values = self.values
        aside = _dec(values, "n_ex_exposure") + _dec(values, "n_ex_outcome")
        aside += _dec(values, "n_ex_age")
        self.assertEqual(aside, _dec(values, "n_excluded"))
        self.assertEqual(_dec(values, "n_identified") - aside, _dec(values, "n_analyzed"))
        exposed = _dec(values, "n_exp") + _dec(values, "n_unexp")
        self.assertEqual(exposed, _dec(values, "n_analyzed"))

    def test_outcome_cells_add(self):
        values = self.values
        self.assertEqual(_dec(values, "ev_exp") + _dec(values, "none_exp"), _dec(values, "n_exp"))
        self.assertEqual(_dec(values, "ev_unexp") + _dec(values, "none_unexp"), _dec(values, "n_unexp"))
        cells = _dec(values, "ev_exp") + _dec(values, "none_exp")
        cells += _dec(values, "ev_unexp") + _dec(values, "none_unexp")
        self.assertEqual(cells, _dec(values, "n_analyzed"))

    def test_subgroup_cells_add_to_the_whole(self):
        values = self.values
        exposed = _dec(values, "n_mark_exp") + _dec(values, "n_plain_exp")
        unexposed = _dec(values, "n_mark_unexp") + _dec(values, "n_plain_unexp")
        events_exposed = _dec(values, "ev_mark_exp") + _dec(values, "ev_plain_exp")
        events_unexposed = _dec(values, "ev_mark_unexp") + _dec(values, "ev_plain_unexp")
        self.assertEqual(exposed, _dec(values, "n_exp"))
        self.assertEqual(unexposed, _dec(values, "n_unexp"))
        self.assertEqual(events_exposed, _dec(values, "ev_exp"))
        self.assertEqual(events_unexposed, _dec(values, "ev_unexp"))

    def test_percentages_match_counts(self):
        values = self.values
        for numerator, denominator, key in _PERCENTS:
            expected = _percent(_dec(values, numerator), _dec(values, denominator))
            self.assertEqual(_dec(values, key), expected, key)

    def test_wald_risk_intervals(self):
        values = self.values
        low, high = _risk_bounds(_dec(values, "ev_exp"), _dec(values, "n_exp"))
        self.assertEqual(_dec(values, "risk_exp_lo"), low)
        self.assertEqual(_dec(values, "risk_exp_hi"), high)
        low, high = _risk_bounds(_dec(values, "ev_unexp"), _dec(values, "n_unexp"))
        self.assertEqual(_dec(values, "risk_unexp_lo"), low)
        self.assertEqual(_dec(values, "risk_unexp_hi"), high)

    def test_risk_difference_interval(self):
        values = self.values
        point, low, high = _risk_difference(
            _dec(values, "ev_exp"),
            _dec(values, "n_exp"),
            _dec(values, "ev_unexp"),
            _dec(values, "n_unexp"),
        )
        self.assertEqual(_dec(values, "rd_pp"), point)
        self.assertEqual(_dec(values, "rd_lo"), low)
        self.assertEqual(_dec(values, "rd_hi"), high)

    def test_risk_ratio_interval(self):
        values = self.values
        point, low, high = _risk_ratio(
            _dec(values, "ev_exp"),
            _dec(values, "n_exp"),
            _dec(values, "ev_unexp"),
            _dec(values, "n_unexp"),
        )
        self.assertEqual(_dec(values, "rr"), point)
        self.assertEqual(_dec(values, "rr_lo"), low)
        self.assertEqual(_dec(values, "rr_hi"), high)

    def test_odds_ratio_interval(self):
        values = self.values
        point, low, high = _odds_ratio(
            _dec(values, "ev_exp"),
            _dec(values, "n_exp"),
            _dec(values, "ev_unexp"),
            _dec(values, "n_unexp"),
        )
        self.assertEqual(_dec(values, "or_est"), point)
        self.assertEqual(_dec(values, "or_lo"), low)
        self.assertEqual(_dec(values, "or_hi"), high)

    def test_methods_state_the_interval_and_rounding(self):
        tex = (CASE / "source" / "paper.tex").read_text(encoding="utf-8")
        methods = tex.split("\\section{Methods}", 1)[1].split("\\section{Results}", 1)[0]
        self.assertIn("1.96", methods)
        self.assertIn("log scale", methods)
        self.assertIn("half up to one decimal place", methods)
        self.assertIn("half up to two decimal places", methods)


if __name__ == "__main__":
    unittest.main()
