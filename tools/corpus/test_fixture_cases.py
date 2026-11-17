"""Checks for every source-case fixture under tools/corpus/fixtures."""

import json
import shutil
import sys
import tempfile
import unittest
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from render import render_case
from source_case import list_bindings, load_case, resolve_case

_ID_RE = r"^[a-z0-9][a-z0-9-]{0,47}$"
_FAMILIES = {"D1", "D2", "D3", "D4", "D5", "D6", "D7", "S1"}
_LEVELS = {"L1", "L2", "L3", "L4"}
_PHRASE_FAMILIES = {"S1", "D3"}
_TEMPLATES = {"strengthen_claim", "remove_hedge", "minimize_limitation"}
_OPERATORS = {
    "set_text",
    "shift_number",
    "scale_number",
    "transpose_digits",
    "swap_values",
    "set_phrase",
    "apply_template",
}
_EXEMPT_KEYS = ("kind", "family", "excerptContains", "reason")
_TENTH = Decimal("0.1")
_Z = Decimal("1.96")
_HUNDRED = Decimal(100)
_STUDIES = ("s1", "s2", "s3", "s4", "s5", "s6")
_DTA_PCTS = (
    ("tp", "n_ref_pos", "sens_pct"),
    ("tn", "n_ref_neg", "spec_pct"),
    ("tp", "n_idx_pos", "ppv_pct"),
    ("tn", "n_idx_neg", "npv_pct"),
    ("n_ref_pos", "n_analyzed", "prev_pct"),
    ("tp6", "n_ref_pos", "sens6_pct"),
    ("tn6", "n_ref_neg", "spec6_pct"),
)
_DTA_CIS = (
    ("sens_pct", "sens_lo", "sens_hi"),
    ("spec_pct", "spec_lo", "spec_hi"),
    ("ppv_pct", "ppv_lo", "ppv_hi"),
    ("npv_pct", "npv_lo", "npv_hi"),
    ("prev_pct", "prev_lo", "prev_hi"),
    ("sens6_pct", "sens6_lo", "sens6_hi"),
    ("spec6_pct", "spec6_lo", "spec6_hi"),
)
_DTA_WALD = (
    ("tp", "n_ref_pos", "sens_lo", "sens_hi"),
    ("tn", "n_ref_neg", "spec_lo", "spec_hi"),
    ("tp", "n_idx_pos", "ppv_lo", "ppv_hi"),
    ("tn", "n_idx_neg", "npv_lo", "npv_hi"),
    ("n_ref_pos", "n_analyzed", "prev_lo", "prev_hi"),
    ("tp6", "n_ref_pos", "sens6_lo", "sens6_hi"),
    ("tn6", "n_ref_neg", "spec6_lo", "spec6_hi"),
)


def _cases():
    root = HERE / "fixtures"
    return [path for path in sorted(root.iterdir()) if (path / "case.json").is_file()]


def _fixture(name):
    return HERE / "fixtures" / name


def _read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _values(case):
    return _read_json(case / "inputs" / "values.json")["values"]


def _case_id(case):
    return _read_json(case / "case.json")["caseId"]


def _int(values, key):
    return int(values[key]["text"])


def _dec(values, key):
    return Decimal(values[key]["text"])


def _bound(case):
    found = {}
    for item in list_bindings(case):
        found.setdefault(item["valueId"], set()).add(item["surface"])
    return found


def _multi_surface_count(bound):
    count = 0
    for surfaces in bound.values():
        if len(surfaces) >= 2:
            count += 1
    return count


def _phrase_ids(values):
    return [key for key in values if key.startswith("ph_")]


def _has_role(values, words):
    for key, item in values.items():
        if not key.startswith("ph_"):
            continue
        blob = f"{key} {item.get('note', '')}".lower()
        for word in words:
            if word in blob:
                return True
    return False


def _pct(numerator, denominator):
    ratio = Decimal(numerator) / Decimal(denominator) * _HUNDRED
    return _half_up(ratio)


def _half_up(value):
    return value.quantize(_TENTH, rounding=ROUND_HALF_UP)


def _proportion_interval(events, total):
    proportion = Decimal(events) / Decimal(total)
    se = (proportion * (1 - proportion) / Decimal(total)).sqrt()
    low = (proportion - _Z * se) * _HUNDRED
    high = (proportion + _Z * se) * _HUNDRED
    return _half_up(low), _half_up(high)


def _risk_parts(events, size, control_events, control_size):
    treated = Decimal(events) / Decimal(size)
    control = Decimal(control_events) / Decimal(control_size)
    diff = (treated - control) * _HUNDRED
    variance = treated * (1 - treated) / Decimal(size)
    variance += control * (1 - control) / Decimal(control_size)
    return diff, variance.sqrt() * _HUNDRED


def _study_parts(values, name):
    return _risk_parts(
        _int(values, f"e_{name}"),
        _int(values, f"n_{name}"),
        _int(values, f"c_{name}"),
        _int(values, f"n_{name}"),
    )


def _inverse_variance(parts):
    weights = [Decimal(1) / ((se / _HUNDRED) ** 2) for _diff, se in parts]
    total = sum(weights, Decimal(0))
    pooled = sum((diff * weight for (diff, _se), weight in zip(parts, weights)), Decimal(0))
    pooled /= total
    se = _HUNDRED / total.sqrt()
    q = Decimal(0)
    for (diff, _se), weight in zip(parts, weights):
        gap = (diff - pooled) / _HUNDRED
        q += weight * gap * gap
    return weights, total, pooled, se, q


def _i2_percent(q, df):
    if q <= 0:
        return Decimal(0)
    raw = (q - df) / q * _HUNDRED
    if raw < 0:
        return Decimal(0)
    return raw


def _rendered_tex(case):
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / "out"
        render_case(case, dest, compile_pdf=False)
        return (dest / "paper.tex").read_bytes()


def _mutation_paths(case):
    folder = case / "mutations"
    if not folder.is_dir():
        return []
    return sorted(folder.glob("*.json"))


class FixtureCaseTests(unittest.TestCase):
    def test_load_has_no_warnings(self):
        for case in _cases():
            loaded = load_case(case)
            self.assertEqual(loaded["warnings"], [], case.name)

    def test_every_value_is_bound(self):
        for case in _cases():
            self.assertEqual(set(_values(case)), set(_bound(case)), case.name)

    def test_resolve_leaves_no_token(self):
        for case in _cases():
            resolved = resolve_case(case)
            blob = resolved["tex"] + json.dumps(resolved["tables"]) + json.dumps(resolved["figures"])
            self.assertNotIn("{{v:", blob, case.name)

    def test_headline_values_repeat(self):
        for case in _cases():
            self.assertGreaterEqual(_multi_surface_count(_bound(case)), 5, case.name)

    def test_render_tex_is_stable(self):
        for case in _cases():
            self.assertEqual(_rendered_tex(case), _rendered_tex(case), case.name)

    def test_phrase_roles_when_present(self):
        checked = 0
        for case in _cases():
            values = _values(case)
            if not _phrase_ids(values):
                continue
            checked += 1
            self._assert_phrase_case(values, case.name)
        self.assertGreater(checked, 0)

    def test_cases_without_phrase_values_skip(self):
        missing = [case.name for case in _cases() if not _phrase_ids(_values(case))]
        if not missing:
            self.skipTest("every fixture already has ph_ values")
        self.skipTest("no ph_ value yet; rct_minimal gets them from another worker")

    def test_mutation_files(self):
        for case in _cases():
            bound = _bound(case)
            for path in _mutation_paths(case):
                self._check_mutation_file(case, path, bound)

    def test_baseline_exemptions_when_present(self):
        for case in _cases():
            path = case / "gate" / "baseline-exemptions.json"
            if path.is_file():
                self._check_exemptions(path)

    @unittest.skipUnless(shutil.which("pdflatex"), "pdflatex is not on PATH")
    def test_pdf_page_count(self):
        for case in _cases():
            with tempfile.TemporaryDirectory() as tmp:
                payload = render_case(case, Path(tmp) / "out", compile_pdf=True)
            self.assertGreaterEqual(payload["pageCount"], 2, case.name)
            self.assertLessEqual(payload["pageCount"], 4, case.name)

    def _assert_phrase_case(self, values, label):
        self.assertTrue(_has_role(values, ("claim", "conclusion", "interpretation")), label)
        self.assertTrue(_has_role(values, ("hedge",)), label)
        self.assertTrue(_has_role(values, ("limit",)), label)
        for key in _phrase_ids(values):
            self._assert_phrase_text(values[key]["text"])

    def _assert_phrase_text(self, text):
        self.assertLessEqual(len(text), 240)
        self.assertNotIn("{", text)
        self.assertNotIn("}", text)
        self.assertNotIn("\\", text)

    def _check_mutation_file(self, case, path, bound):
        data = _read_json(path)
        self.assertEqual(data["schema"], "falsify.source-mutation.v1")
        self.assertEqual(data["caseId"], _case_id(case))
        self.assertRegex(data["mutationSetId"], _ID_RE)
        mutations = data["mutations"]
        self.assertIsInstance(mutations, list)
        self.assertTrue(mutations)
        ids = [item["defectId"] for item in mutations]
        self.assertEqual(len(ids), len(set(ids)))
        for item in mutations:
            self._check_defect(item, bound)

    def _check_defect(self, spec, bound):
        self.assertIsInstance(spec, dict)
        self.assertRegex(spec["defectId"], _ID_RE)
        operator = spec["operator"]
        self.assertIn(operator, _OPERATORS)
        self.assertIn(spec["family"], _FAMILIES)
        self.assertIn(spec["difficulty"], _LEVELS)
        self.assertIn("relation", spec["rationale"].lower())
        value_id = spec["valueId"]
        self.assertIn(value_id, bound)
        self._check_surfaces(spec["surfaces"], bound[value_id])
        self._check_operator(spec, operator, bound)

    def _check_surfaces(self, surfaces, known):
        if surfaces == "*":
            self.assertTrue(known)
            return
        self.assertIsInstance(surfaces, list)
        self.assertTrue(surfaces)
        for surface in surfaces:
            self.assertIn(surface, known)

    def _check_operator(self, spec, operator, bound):
        if operator in ("set_text", "set_phrase"):
            self.assertTrue(str(spec["text"]).strip())
        if operator == "set_phrase":
            self.assertTrue(spec["valueId"].startswith("ph_"))
            self.assertIn(spec["family"], _PHRASE_FAMILIES)
        if operator == "shift_number":
            self._require_number(spec, "delta")
        if operator == "scale_number":
            self._require_number(spec, "factor")
        if operator == "swap_values":
            self.assertIn(spec["withValueId"], bound)
        if operator == "apply_template":
            self._check_template(spec)

    def _check_template(self, spec):
        self.assertIn(spec["template"], _TEMPLATES)
        self.assertTrue(spec["valueId"].startswith("ph_"))
        self.assertIn(spec["family"], _PHRASE_FAMILIES)

    def _require_number(self, spec, key):
        value = spec[key]
        self.assertNotIsInstance(value, bool)
        self.assertIsInstance(value, (int, float))

    def _check_exemptions(self, path):
        data = _read_json(path)
        self.assertEqual(data["schema"], "falsify.source-baseline-exemptions.v1")
        items = data["exemptions"]
        self.assertIsInstance(items, list)
        for item in items:
            for key in _EXEMPT_KEYS:
                self.assertTrue(str(item[key]).strip())


class DiagnosticAccuracyArithmeticTests(unittest.TestCase):
    def test_flow_and_cells_add(self):
        values = _values(_fixture("dta_minimal"))
        self.assertEqual(_int(values, "n_ex_crit") + _int(values, "n_ex_decl"), _int(values, "n_excluded"))
        self.assertEqual(_int(values, "n_screened") - _int(values, "n_excluded"), _int(values, "n_eligible"))
        self.assertEqual(_int(values, "n_ex_spec") + _int(values, "n_ex_wd"), _int(values, "n_ex_analysis"))
        self.assertEqual(_int(values, "n_eligible") - _int(values, "n_ex_analysis"), _int(values, "n_analyzed"))
        self.assertEqual(_int(values, "tp") + _int(values, "fn"), _int(values, "n_ref_pos"))
        self.assertEqual(_int(values, "fp") + _int(values, "tn"), _int(values, "n_ref_neg"))
        self.assertEqual(_int(values, "tp") + _int(values, "fp"), _int(values, "n_idx_pos"))
        self.assertEqual(_int(values, "fn") + _int(values, "tn"), _int(values, "n_idx_neg"))
        self.assertEqual(_int(values, "n_ref_pos") + _int(values, "n_ref_neg"), _int(values, "n_analyzed"))
        self.assertEqual(_int(values, "n_idx_pos") + _int(values, "n_idx_neg"), _int(values, "n_analyzed"))
        self.assertEqual(_int(values, "tp6") + _int(values, "fn6"), _int(values, "n_ref_pos"))
        self.assertEqual(_int(values, "fp6") + _int(values, "tn6"), _int(values, "n_ref_neg"))
        cells = _int(values, "tp6") + _int(values, "fp6") + _int(values, "fn6") + _int(values, "tn6")
        self.assertEqual(cells, _int(values, "n_analyzed"))

    def test_percentages_match_counts(self):
        values = _values(_fixture("dta_minimal"))
        for numerator, denominator, key in _DTA_PCTS:
            expected = _pct(_int(values, numerator), _int(values, denominator))
            self.assertEqual(_dec(values, key), expected, key)

    def test_intervals_contain_estimates(self):
        values = _values(_fixture("dta_minimal"))
        for estimate, low, high in _DTA_CIS:
            self.assertLessEqual(_dec(values, low), _dec(values, estimate), estimate)
            self.assertLessEqual(_dec(values, estimate), _dec(values, high), estimate)

    def test_wald_intervals(self):
        values = _values(_fixture("dta_minimal"))
        for numerator, denominator, low, high in _DTA_WALD:
            expected_low, expected_high = _proportion_interval(
                _int(values, numerator),
                _int(values, denominator),
            )
            self.assertEqual(_dec(values, low), expected_low, low)
            self.assertEqual(_dec(values, high), expected_high, high)


class MetaAnalysisArithmeticTests(unittest.TestCase):
    def test_flow_adds(self):
        values = _values(_fixture("meta_minimal"))
        self.assertEqual(
            _int(values, "n_identified") - _int(values, "n_duplicates"),
            _int(values, "n_screened"),
        )
        self.assertEqual(
            _int(values, "n_screened") - _int(values, "n_rec_excl"),
            _int(values, "n_fulltext"),
        )
        self.assertEqual(
            _int(values, "n_fulltext") - _int(values, "n_ft_excl"),
            _int(values, "n_included"),
        )
        reasons = (
            _int(values, "n_ex_pop")
            + _int(values, "n_ex_comp")
            + _int(values, "n_ex_out")
            + _int(values, "n_ex_cohort")
        )
        self.assertEqual(reasons, _int(values, "n_ft_excl"))

    def test_column_sums(self):
        values = _values(_fixture("meta_minimal"))
        self.assertEqual(sum(_int(values, f"e_{name}") for name in _STUDIES), _int(values, "e_tx"))
        self.assertEqual(sum(_int(values, f"c_{name}") for name in _STUDIES), _int(values, "e_ctrl"))
        self.assertEqual(sum(_int(values, f"n_{name}") for name in _STUDIES), _int(values, "n_tx"))
        self.assertEqual(_int(values, "n_tx"), _int(values, "n_ctrl"))

    def test_weights_sum_to_100(self):
        values = _values(_fixture("meta_minimal"))
        total = sum((_dec(values, f"w_{name}") for name in _STUDIES), Decimal(0))
        self.assertEqual(total, Decimal("100.0"))
        self.assertEqual(_dec(values, "w_sum"), Decimal("100.0"))

    def test_risk_differences(self):
        values = _values(_fixture("meta_minimal"))
        for name in _STUDIES:
            self._assert_difference(values, f"e_{name}", f"n_{name}", f"c_{name}", f"n_{name}", f"rd_{name}")
            self._assert_contains(values, f"rd_{name}", f"lo_{name}", f"hi_{name}")
        self._assert_contains(values, "rd_pool", "rd_lo", "rd_hi")

    def test_inverse_variance_pool(self):
        values = _values(_fixture("meta_minimal"))
        parts = [_study_parts(values, name) for name in _STUDIES]
        weights, total, pooled, se, q = _inverse_variance(parts)
        for name, (diff, spread), weight in zip(_STUDIES, parts, weights):
            self.assertEqual(_dec(values, f"rd_{name}"), _half_up(diff), name)
            self.assertEqual(_dec(values, f"lo_{name}"), _half_up(diff - _Z * spread), name)
            self.assertEqual(_dec(values, f"hi_{name}"), _half_up(diff + _Z * spread), name)
            share = _half_up(weight / total * _HUNDRED)
            self.assertEqual(_dec(values, f"w_{name}"), share, name)
        self.assertEqual(_dec(values, "rd_pool"), _half_up(pooled))
        self.assertEqual(_dec(values, "rd_lo"), _half_up(pooled - _Z * se))
        self.assertEqual(_dec(values, "rd_hi"), _half_up(pooled + _Z * se))
        df = Decimal(len(_STUDIES) - 1)
        self.assertEqual(_dec(values, "q_stat"), _half_up(q))
        self.assertEqual(_dec(values, "q_df"), df)
        self.assertEqual(_int(values, "n_included") - 1, len(_STUDIES) - 1)
        self.assertEqual(_dec(values, "i2_pct"), _half_up(_i2_percent(q, df)))

    def _assert_difference(self, values, events, size, control_events, control_size, key):
        diff = (
            Decimal(_int(values, events)) / Decimal(_int(values, size))
            - Decimal(_int(values, control_events)) / Decimal(_int(values, control_size))
        ) * Decimal(100)
        self.assertEqual(_dec(values, key), diff.quantize(_TENTH, rounding=ROUND_HALF_UP), key)

    def _assert_contains(self, values, estimate, low, high):
        point = _dec(values, estimate)
        self.assertLessEqual(_dec(values, low), point, estimate)
        self.assertLessEqual(point, _dec(values, high), estimate)


if __name__ == "__main__":
    unittest.main()
