"""Tests for the PDF-edited counterpart of a source-native bundle."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CORPUS = Path(__file__).resolve().parent
EVAL = CORPUS.parents[0] / "evaluation"
for entry in (EVAL, CORPUS):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

import arena_runner
import pdf_twin
from render import find_engine

FIXTURE = CORPUS / "fixtures" / "rct_minimal"
MUTATIONS = FIXTURE / "mutations"
SCRIPT = CORPUS / "pdf_twin.py"
MUTATOR = CORPUS / "source_mutator.py"
GATE = CORPUS / "twin_gate.py"
_SECRET_KEYS = {"before", "after", "rationale", "defectId", "operationId", "overridesApplied"}


def _have_pymupdf() -> bool:
    try:
        import pymupdf
    except ImportError:
        return False
    return pymupdf is not None


def _have_matplotlib() -> bool:
    try:
        import matplotlib
    except ImportError:
        return False
    return matplotlib is not None


def _load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _walk_keys(node, found):
    if isinstance(node, dict):
        found.update(node)
        for item in node.values():
            _walk_keys(item, found)
    elif isinstance(node, list):
        for item in node:
            _walk_keys(item, found)


def _run(args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONUTF8": "1"},
        check=False,
    )


def _bundle(case, spec, dest: Path) -> Path:
    build = dest / "build"
    bundle = dest / "bundle"
    built = subprocess.run(
        [sys.executable, str(MUTATOR), "build", str(case), "--spec", str(spec), "--out", str(build)],
        capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if built.returncode != 0:
        raise AssertionError(built.stderr[-800:] or built.stdout[-800:])
    gated = subprocess.run(
        [sys.executable, str(GATE), "verify", str(build), "--case", str(case), "--bundle-out", str(bundle)],
        capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if gated.returncode != 0:
        raise AssertionError(gated.stderr[-800:] or gated.stdout[-800:])
    return bundle


def _blue(quote):
    return {
        "runId": "blue-1",
        "agentId": "synthetic",
        "findings": [{"id": "f1", "decision": "defect", "quote": quote}],
    }


@unittest.skipUnless(find_engine() and _have_pymupdf() and _have_matplotlib(), "pdflatex/pymupdf/matplotlib")
class PdfTwinTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._root = tempfile.TemporaryDirectory()
        root = Path(cls._root.name)
        cls.m01 = _bundle(FIXTURE, MUTATIONS / "m01-abstract-p.json", root / "m01")
        cls.m03 = _bundle(FIXTURE, MUTATIONS / "m03-figure-y.json", root / "m03")

    @classmethod
    def tearDownClass(cls):
        cls._root.cleanup()

    def test_numeric_replacement_is_applied_and_local(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            report = pdf_twin.make_pdf_twin(self.m01, out)
            self.assertEqual(report["status"], "applied")
            self.assertEqual(report["applied"], 1)
            self.assertFalse(report["partial"])
            ledger = _load(out / "sealed" / "gold-ledger.json")
            pair = _load(out / "sealed" / "pair.json")
            defect = ledger["defects"][0]
            self.assertEqual(ledger["schema"], "falsify.red-gold-ledger.v1")
            self.assertEqual(ledger["producer"], "pdf-mutation")
            self.assertEqual(defect["defectId"], "abs-p")
            self.assertEqual(defect["family"], "D1")
            self.assertEqual(defect["before"], "0.004")
            self.assertEqual(defect["after"], "0.04")
            self.assertIsInstance(defect["pageIndex"], int)
            self.assertEqual(len(defect["bbox"]), 4)
            self.assertIn("0.04", defect["quote"])
            self.assertNotIn("0.004", defect["quote"])
            self.assertTrue(ledger["stealthPass"])
            self.assertEqual(pair["schema"], "falsify.source-pdf-pair.v1")
            self.assertEqual(pair["pairId"], "rct-minimal+m01-abstract-p")
            self.assertEqual(pair["defects"][0]["status"], "applied")
            edited = (out / "blind" / "paper.pdf").read_bytes()
            clean = (self.m01 / "sealed" / "clean.pdf").read_bytes()
            self.assertNotEqual(edited, clean)
            self.assertEqual(pair["pdfBlindPdfSha256"], pdf_twin._sha256(edited))
            self.assertEqual(pair["cleanPdfSha256"], pdf_twin._sha256(clean))
            import pymupdf
            with pymupdf.open(stream=edited, filetype="pdf") as doc:
                pages = [page.get_text("text") or "" for page in doc]
            self.assertIn(defect["quote"], pages[defect["pageIndex"]])
            self.assertIn("p=0.04)", pages[0])
            self.assertIn("p=0.004)", pages[1])
            hit = arena_runner.evaluate_arena_match(ledger, [_blue(defect["quote"])])
            self.assertEqual(hit["aggregate"]["tp"], 1)

    def test_figure_defect_is_unsupported_without_approximation(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            report = pdf_twin.make_pdf_twin(self.m03, out)
            self.assertEqual(report["status"], "unsupported")
            self.assertTrue(report["partial"])
            self.assertEqual(report["reasons"], ["figure_image"])
            pair = _load(out / "sealed" / "pair.json")
            ledger = _load(out / "sealed" / "gold-ledger.json")
            self.assertEqual(pair["defects"][0]["status"], "unsupported")
            self.assertEqual(pair["defects"][0]["reason"], "figure_image")
            self.assertEqual(ledger["defects"], [])
            self.assertEqual(ledger["producer"], "pdf-mutation")
            edited = (out / "blind" / "paper.pdf").read_bytes()
            clean = (self.m03 / "sealed" / "clean.pdf").read_bytes()
            self.assertEqual(edited, clean)

    def test_same_bundle_is_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "a"
            second = root / "b"
            pdf_twin.make_pdf_twin(self.m01, first)
            pdf_twin.make_pdf_twin(self.m01, second)
            self.assertEqual((first / "blind" / "paper.pdf").read_bytes(), (second / "blind" / "paper.pdf").read_bytes())
            self.assertEqual((first / "sealed" / "gold-ledger.json").read_bytes(), (second / "sealed" / "gold-ledger.json").read_bytes())
            self.assertEqual((first / "sealed" / "pair.json").read_bytes(), (second / "sealed" / "pair.json").read_bytes())

    def test_stdout_and_blind_files_hide_the_answer_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            done = _run(["make", str(self.m01), "--out", str(out)])
            self.assertEqual(done.returncode, 0, done.stderr)
            payload = json.loads(done.stdout)
            keys = set()
            _walk_keys(payload, keys)
            self.assertTrue(_SECRET_KEYS.isdisjoint(keys))
            ledger = _load(self.m01 / "sealed" / "gold-ledger.json")
            secret = ledger["defects"][0]
            for value in (secret["defectId"], secret["rationale"], secret["before"], secret["after"]):
                self.assertNotIn(value, done.stdout)
            self.assertNotIn("C:\\", done.stdout)
            outside = [
                path for path in out.rglob("*")
                if path.is_file() and "sealed" not in path.parts
            ]
            self.assertEqual([path.relative_to(out).as_posix() for path in outside], ["blind/paper.pdf"])
            blob = outside[0].read_bytes()
            self.assertNotIn(secret["defectId"].encode("ascii"), blob)
            self.assertNotIn(secret["rationale"].encode("utf-8"), blob)

    def test_tampered_ledger_exits_3_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle = root / "bundle"
            shutil.copytree(self.m01, bundle)
            path = bundle / "sealed" / "gold-ledger.json"
            data = _load(path)
            data["defects"][0]["after"] = "9.999"
            path.write_text(json.dumps(data), encoding="utf-8")
            out = root / "out"
            code = pdf_twin.main(["make", str(bundle), "--out", str(out)])
            self.assertEqual(code, 3)
            self.assertFalse(out.exists())


class UsageTests(unittest.TestCase):
    def test_usage_and_invalid_bundle_exit_2(self):
        self.assertEqual(pdf_twin.main(["make"]), 2)
        with tempfile.TemporaryDirectory() as tmp:
            code = pdf_twin.main(["make", tmp, "--out", str(Path(tmp) / "out")])
            self.assertEqual(code, 2)
            self.assertFalse((Path(tmp) / "out").exists())
