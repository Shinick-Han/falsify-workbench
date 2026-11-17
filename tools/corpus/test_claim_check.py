"""Tests for the printed-claim check."""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

CORPUS = Path(__file__).resolve().parent

import claim_check
import render
from claim_check import (
    _heading_body,
    _plain,
    _strip_counter,
    gate_claims,
    main,
    tokens_of,
)
from render import find_engine

FIXTURES = CORPUS / "fixtures"


def _have(name: str) -> bool:
    try:
        __import__(name)
    except ImportError:
        return False
    return True


def _ready() -> bool:
    return bool(find_engine()) and _have("pymupdf") and _have("matplotlib")


def _invoke(argv):
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = main(argv)
    return code, stdout.getvalue(), stderr.getvalue()


def _keys(value, found: set[str]) -> None:
    if isinstance(value, dict):
        found.update(value)
        for item in value.values():
            _keys(item, found)
    elif isinstance(value, list):
        for item in value:
            _keys(item, found)


class TokenTests(unittest.TestCase):
    def test_numbers_stay_whole_and_a_hyphenated_code_is_not_negative(self):
        self.assertEqual(tokens_of("p=0.004 versus p=0.04"), ["0.004", "0.04"])
        self.assertEqual(tokens_of("FX-217 after 8-week"), ["217", "8"])
        self.assertEqual(tokens_of("change -12.4 to -2.6"), ["-12.4", "-2.6"])
        self.assertEqual(tokens_of("45/100 (45.0%)"), ["45", "100", "45.0%"])

    def test_reflow_joins_a_real_hyphen_before_a_number(self):
        self.assertEqual(tokens_of("limited by the 8-\nweek follow-up"), ["8"])

    def test_structural_numbers_drop_out_of_the_claim_multiset(self):
        text = "a 95% CI, a 95% Wald interval, its 95% interval, and 95.0%"
        self.assertEqual(tokens_of(text), ["95.0%"])
        self.assertEqual(tokens_of("notes [1, 2] and [4, 5, 6] then 12"), ["12"])
        self.assertEqual(_heading_body("1\nIntroduction"), "Introduction")
        self.assertEqual(tokens_of(_heading_body("4\nDiscussion")), [])
        self.assertEqual(tokens_of(_strip_counter("Table 2: week 4 and week 8", "table")), ["4", "8"])
        self.assertEqual(tokens_of(_strip_counter("Figure 1: scores 4 and 6", "figure")), ["4", "6"])

    def test_math_subscripts_are_indexes_and_literal_factors_stay(self):
        source = _plain(r"$p_1(1-p_1)/n_1+p_0(1-p_0)/n_0$ and 1.96 and $1/a-1/n_1$")
        printed = "p1(1−p1)/n1 +p0(1−p0)/n0 and 1.96 and 1/a −1/n1"
        self.assertEqual(tokens_of(source), ["1", "1", "1.96", "1", "1"])
        self.assertEqual(tokens_of(printed), tokens_of(source))
        self.assertNotIn("0", tokens_of(source))

    def test_citation_keys_and_superscripts_are_not_printed_claims(self):
        cited = _plain(r"see \cite{hale2018,okonkwo2020} and keep 3")
        powered = _plain(r"and $I^{2} = 0.0\%$")
        self.assertEqual(tokens_of(cited), ["3"])
        self.assertEqual(tokens_of(powered), ["0.0%"])
        self.assertNotIn("2018", tokens_of(cited))
        self.assertNotIn("2", tokens_of(powered))
        self.assertEqual(tokens_of("Ward as real [5]."), [])
        self.assertEqual(tokens_of("Ward as real [1]."), [])


@unittest.skipUnless(_ready(), "pdflatex, pymupdf, matplotlib")
class CleanPdfTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.pdfs = {}
        for name in ("rct_minimal", "meta_minimal", "dta_minimal", "cohort_minimal", "survival_minimal"):
            dest = root / name
            render.render_case(FIXTURES / name, dest, compile_pdf=True)
            cls.pdfs[name] = (dest / "paper.pdf").read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_clean_pdfs_match_their_cases(self):
        for name, pdf in self.pdfs.items():
            with self.subTest(case=name):
                report = claim_check.check_pdf(pdf, FIXTURES / name)
                self.assertTrue(report["pass"], report["surfaces"])
                self.assertEqual(report["unsupportedCount"], 0)
                self.assertEqual(report["missingCount"], 0)
                self.assertEqual(report["schema"], claim_check.SCHEMA)

    def test_clean_cli_is_counts_only(self):
        pdf_path = Path(self.tmp.name) / "rct_minimal" / "paper.pdf"
        code, out, err = _invoke(["check", str(pdf_path), "--case", str(FIXTURES / "rct_minimal")])
        self.assertEqual(code, 0, err)
        self.assertEqual(err, "")
        report = json.loads(out)
        self.assertTrue(report["pass"])
        self.assertEqual(report["surfaces"], [])
        found = set()
        _keys(report, found)
        self.assertNotIn("missing", found)

    def test_phrase_and_citation_defects_do_not_decide_the_check(self):
        pdf = self.pdfs["rct_minimal"]
        case = FIXTURES / "rct_minimal"
        for kind, reason in (("source-phrase", "phrase"), ("source-citation", "citation")):
            ledger = {"defects": [{"kind": kind, "source": {"contexts": [
                {"surface": "tex:discussion", "before": "may", "after": "will"},
            ]}}]}
            failures, details = gate_claims(pdf, pdf, case, ledger)
            self.assertEqual(failures, [], kind)
            self.assertEqual(details["notApplicable"], 1, kind)
            self.assertEqual(details["notApplicableReasons"][reason], 1, kind)

    def test_a_figure_drawing_is_not_a_printed_token(self):
        pdf = self.pdfs["rct_minimal"]
        ledger = {"defects": [{"kind": "source-value", "source": {"contexts": [{
            "surface": "figure:F1",
            "before": "-12.4",
            "after": "-3.0",
            "figureFile": "figures/F1.png",
        }]}}]}
        failures, details = gate_claims(pdf, pdf, FIXTURES / "rct_minimal", ledger)
        self.assertEqual(failures, [])
        self.assertEqual(details["defectUnsupported"], 0)
        self.assertEqual(details["notApplicable"], 1)
        self.assertEqual(details["notApplicableReasons"]["figure_image_only"], 1)

    def test_a_figure_with_text_still_needs_a_visible_token(self):
        pdf = self.pdfs["rct_minimal"]
        ledger = {"defects": [{"kind": "source-value", "source": {"contexts": [
            {
                "surface": "figure:F1",
                "before": "-12.4",
                "after": "-3.0",
                "figureFile": "figures/F1.png",
            },
            {"surface": "tex:results", "before": "change -12.4", "after": "change -3.0"},
        ]}}]}
        failures, details = gate_claims(pdf, pdf, FIXTURES / "rct_minimal", ledger)
        self.assertEqual(details["notApplicable"], 0)
        self.assertIn("number_not_visible", {item["code"] for item in failures})


class CliTests(unittest.TestCase):
    def test_usage_and_missing_input_exit_2(self):
        self.assertEqual(main([]), 2)
        code, _out, err = _invoke(["check", "missing.pdf", "--case", "missing-case"])
        self.assertEqual(code, 2)
        self.assertIn("missing_file", err)


if __name__ == "__main__":
    unittest.main()
