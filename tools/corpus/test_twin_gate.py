"""Tests for the source twin gate."""

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

CORPUS = Path(__file__).resolve().parent
if str(CORPUS) not in sys.path:
    sys.path.insert(0, str(CORPUS))

import render
import twin_gate
from render import find_engine
from source_case import list_bindings
from twin_gate import (
    GateError,
    context_survives,
    hunks_attributed,
    main,
    normalize_pdf_text,
    word_hunks,
    write_bundle,
    _match_exemptions,
)

FIXTURE = CORPUS / "fixtures" / "rct_minimal"
BEFORE = (
    "At week 8 the mean Fictional Symptom Score change was -12.4 with FX-217 and "
    "-4.1 with placebo (difference -8.3, 95% CI -14.0 to -2.6, p=0.004)."
)
AFTER = BEFORE.replace("p=0.004", "p=0.04")
_FORBIDDEN_KEYS = {"before", "after", "rationale"}


def _invoke(argv):
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = main(argv)
    return code, stdout.getvalue(), stderr.getvalue()


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(twin_gate._dump(payload), encoding="utf-8", newline="\n")


def _keys(value, found: set[str]) -> None:
    if isinstance(value, dict):
        found.update(value)
        for item in value.values():
            _keys(item, found)
    elif isinstance(value, list):
        for item in value:
            _keys(item, found)


def _have_pymupdf() -> bool:
    try:
        import pymupdf
    except ImportError:
        return False
    return pymupdf is not None


class PureHelperTests(unittest.TestCase):
    def test_normalize_joins_hyphenation_and_space(self):
        raw = "partici-\npants   were\nenrolled"
        self.assertEqual(normalize_pdf_text(raw), "participants were enrolled")

    def test_context_uses_full_sentence_when_it_is_unique(self):
        clean = "intro " + BEFORE + " tail"
        defect = "intro " + AFTER + " tail"
        self.assertTrue(context_survives(BEFORE, AFTER, clean, defect, 40))

    def test_context_rejects_a_short_missing_change(self):
        self.assertFalse(context_survives("p=0.004", "p=0.04", "p=0.004 stays", "same", 80))

    def test_hunk_attribution(self):
        left = BEFORE.split()
        right = AFTER.split()
        tokens = {"p=0.004).", "p=0.04)."}
        self.assertEqual(hunks_attributed([left], [right], tokens), [])
        unexplained = hunks_attributed([left], ["unrelated change".split()], tokens)
        self.assertTrue(unexplained)
        self.assertEqual(word_hunks(["same"], ["same"]), [])

    def test_exemption_matching(self):
        signals = [
            {"kind": "abstract_results_sample_size_mismatch", "family": "D1", "excerpt": "240 participants"},
            {"kind": "other", "family": "D2", "excerpt": "elsewhere"},
        ]
        exemptions = [
            {"kind": "abstract_results_sample_size_mismatch", "family": "D1", "excerptContains": "240 participants"},
            {"kind": "abstract_results_sample_size_mismatch", "family": "D1", "excerptContains": "missing excerpt"},
        ]
        unexempted, unused = _match_exemptions(signals, exemptions)
        self.assertEqual(unexempted, [1])
        self.assertEqual(unused, [1])

    def test_bundle_writer_and_refusal_to_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = {
                "case_id": "rct-minimal",
                "plan": {"mutationSetId": "m01-abstract-p"},
                "clean_pdf": b"%PDF-1.4 clean\n",
                "defect_pdf": b"%PDF-1.4 defect\n",
                "ledger": {
                    "schema": "falsify.red-gold-ledger.v1",
                    "defects": [{"defectId": "d1", "stealthStatus": "not_audited"}],
                },
                "normalized": [{"signalId": "base-1", "texts": ["240 participants"]}],
                "stealth_pass": True,
                "stealth_status": "clean",
            }
            report = {"schema": twin_gate.SCHEMA, "pass": True, "checks": [], "failures": [], "modelCalls": 0}
            dest = root / "bundle"
            write_bundle(dest, state, report)
            names = sorted(path.relative_to(dest).as_posix() for path in dest.rglob("*") if path.is_file())
            self.assertEqual(names, [
                "blind/paper.pdf",
                "manifest.json",
                "sealed/baseline-signals.json",
                "sealed/clean.pdf",
                "sealed/gate.json",
                "sealed/gold-ledger.json",
            ])
            self.assertEqual([path.name for path in (dest / "blind").iterdir()], ["paper.pdf"])
            manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["schema"], twin_gate.BUNDLE_SCHEMA)
            self.assertEqual(len(manifest["files"]), 5)
            with self.assertRaises(GateError):
                write_bundle(dest, state, report)

    def test_exit_code_mapping(self):
        self.assertEqual(main(["verify"]), 2)
        code, _out, err = _invoke(["verify", "missing-build", "--case", "missing-case", "--timeout", "0"])
        self.assertEqual(code, 124)
        self.assertIn("timeout", err)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = root / "case"
            case.mkdir()
            build = root / "build"
            build.mkdir()
            _write_json(build / "twin.json", {"schema": "falsify.source-twin.v1", "compiled": False})
            code, _out, err = _invoke(["verify", str(build), "--case", str(case)])
            self.assertEqual(code, 2)
            self.assertIn("not_compiled", err)


@unittest.skipUnless(_have_pymupdf(), "pymupdf")
class TinyPdfTests(unittest.TestCase):
    def test_page_words_from_a_generated_pdf(self):
        import pymupdf

        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((72, 72), "alpha beta gamma")
        raw = doc.tobytes()
        doc.close()
        pages = twin_gate._pdf_pages(raw)
        self.assertEqual(twin_gate._page_words(pages), [["alpha", "beta", "gamma"]])


def _ledger(unchanged):
    return {
        "schema": "falsify.red-gold-ledger.v1",
        "paperId": "rct-minimal",
        "sourceSha256": None,
        "blindPdfSha256": None,
        "stealthPass": None,
        "producer": "source-native",
        "caseId": "rct-minimal",
        "mutationSetId": "m01-abstract-p",
        "defects": [{
            "defectId": "d1",
            "operationId": "d1",
            "kind": "source-value",
            "pageIndex": 0,
            "bbox": None,
            "itemId": None,
            "supplementName": None,
            "before": "0.004",
            "after": "0.04",
            "quote": AFTER,
            "location": "abstract",
            "world": None,
            "family": "D1",
            "difficulty": "L3",
            "rationale": "Abstract p value disagrees with Results and Table T2.",
            "stealthStatus": "not_audited",
            "source": {
                "valueId": "p_primary",
                "operator": "set_text",
                "changedSurfaces": ["tex:abstract"],
                "unchangedSurfaces": unchanged,
                "contexts": [{
                    "surface": "tex:abstract",
                    "before": BEFORE,
                    "after": AFTER,
                }],
            },
        }],
    }


def _plan(overrides=None):
    chosen = overrides or [{"valueId": "p_primary", "text": "0.04", "surfaces": ["tex:abstract"]}]
    return {
        "schema": "falsify.source-mutation-plan.v1",
        "caseId": "rct-minimal",
        "mutationSetId": "m01-abstract-p",
        "overrides": chosen,
        "defects": [{"defectId": "d1", "overrideIndexes": [0]}],
    }


@unittest.skipUnless(find_engine(), "pdflatex")
class EndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.case = root / "rct_minimal"
        shutil.copytree(FIXTURE, cls.case)
        bindings = list_bindings(cls.case)
        surfaces = sorted({item["surface"] for item in bindings if item["valueId"] == "p_primary"})
        unchanged = [item for item in surfaces if item != "tex:abstract"]
        cls.ledger = _ledger(unchanged)
        overrides = [{"valueId": "p_primary", "text": "0.04", "surfaces": ["tex:abstract"]}]
        cls.build = root / "build"
        payload = render.render_twin(cls.case, cls.build, overrides, compile_pdf=True)
        _write_json(cls.build / "twin.json", payload)
        _write_json(cls.build / "sealed" / "mutation-plan.json", _plan())
        _write_json(cls.build / "sealed" / "gold-ledger.json", cls.ledger)
        extra = [{"valueId": "p_primary", "text": "0.04", "surfaces": ["tex:abstract"]},
                 {"valueId": "n_randomized", "text": "241", "surfaces": ["tex:results"]}]
        cls.extra = root / "extra"
        extra_payload = render.render_twin(cls.case, cls.extra, extra, compile_pdf=True)
        _write_json(cls.extra / "twin.json", extra_payload)
        _write_json(cls.extra / "sealed" / "mutation-plan.json", _plan(extra))
        _write_json(cls.extra / "sealed" / "gold-ledger.json", cls.ledger)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _run(self, build, case, bundle):
        return _invoke(["verify", str(build), "--case", str(case), "--bundle-out", str(bundle)])

    def test_pass_writes_bundle_without_answer_keys(self):
        bundle = Path(self.tmp.name) / "bundle-pass"
        code, out, _err = self._run(self.build, self.case, bundle)
        self.assertEqual(code, 0, out)
        report = json.loads(out)
        self.assertTrue(report["pass"])
        self.assertEqual(report["modelCalls"], 0)
        found = set()
        _keys(report, found)
        self.assertFalse(_FORBIDDEN_KEYS & found)
        names = sorted(path.relative_to(bundle).as_posix() for path in bundle.rglob("*") if path.is_file())
        self.assertEqual(names, [
            "blind/paper.pdf",
            "manifest.json",
            "sealed/baseline-signals.json",
            "sealed/clean.pdf",
            "sealed/gate.json",
            "sealed/gold-ledger.json",
        ])
        self.assertEqual(len(list((bundle / "blind").iterdir())), 1)
        ledger = json.loads((bundle / "sealed" / "gold-ledger.json").read_text(encoding="utf-8"))
        self.assertTrue(ledger["stealthPass"])
        self.assertEqual(ledger["defects"][0]["stealthStatus"], "clean")
        self.assertTrue(ledger["sourceSha256"])
        self.assertTrue(ledger["blindPdfSha256"])

    def test_repeat_run_is_byte_identical(self):
        first = Path(self.tmp.name) / "bundle-a"
        second = Path(self.tmp.name) / "bundle-b"
        code_a, _out_a, err_a = self._run(self.build, self.case, first)
        code_b, _out_b, err_b = self._run(self.build, self.case, second)
        self.assertEqual(code_a, 0, err_a)
        self.assertEqual(code_b, 0, err_b)
        for rel in ("manifest.json", "sealed/gate.json"):
            left = (first / rel).read_bytes()
            right = (second / rel).read_bytes()
            self.assertEqual(left, right)

    def _assert_refusal(self, build, case, code_name):
        bundle = Path(self.tmp.name) / ("no-" + code_name)
        code, out, _err = self._run(build, case, bundle)
        self.assertEqual(code, 3, out)
        report = json.loads(out)
        self.assertIn(code_name, {item["code"] for item in report["failures"]})
        self.assertFalse(bundle.exists())
        for item in report["failures"]:
            self.assertLessEqual(len(item["detail"]), 80)

    def test_ledger_declares_a_change_that_was_not_applied(self):
        build = Path(self.tmp.name) / "undeclared-build"
        shutil.copytree(self.build, build)
        ledger = json.loads((build / "sealed" / "gold-ledger.json").read_text(encoding="utf-8"))
        ledger["defects"][0]["source"]["contexts"][0]["after"] = AFTER.replace("p=0.04", "p=0.99")
        _write_json(build / "sealed" / "gold-ledger.json", ledger)
        self._assert_refusal(build, self.case, "defect_not_visible")

    def test_extra_override_is_an_unexplained_diff(self):
        self._assert_refusal(self.extra, self.case, "unexplained_diff")

    def test_missing_exemption_file(self):
        case = Path(self.tmp.name) / "rct_minimal_bare"
        shutil.copytree(self.case, case)
        shutil.rmtree(case / "gate")
        self._assert_refusal(self.build, case, "clean_signal_unexempted")

    def test_unused_exemption(self):
        case = Path(self.tmp.name) / "rct_minimal_extra"
        shutil.copytree(self.case, case)
        path = case / "gate" / "baseline-exemptions.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["exemptions"].append({
            "kind": "abstract_results_sample_size_mismatch",
            "family": "D1",
            "excerptContains": "not-a-real-excerpt",
            "reason": "unused on purpose",
        })
        _write_json(path, payload)
        self._assert_refusal(self.build, case, "exemption_unused")

    def test_tampered_clean_tex(self):
        build = Path(self.tmp.name) / "tampered-build"
        shutil.copytree(self.build, build)
        tex = build / "clean" / "paper.tex"
        tex.write_text(tex.read_text(encoding="utf-8").replace("Fictional", "FictionalX", 1), encoding="utf-8", newline="\n")
        self._assert_refusal(build, self.case, "clean_not_truth")


if __name__ == "__main__":
    unittest.main()
