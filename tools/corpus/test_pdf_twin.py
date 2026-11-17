"""Tests for the PDF-edited counterpart of a source-native bundle."""

import json
import os
import re
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

    def test_same_bundle_has_one_hash_across_twenty_makes(self):
        hashes = set()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(20):
                out = root / str(index)
                pdf_twin.make_pdf_twin(self.m01, out)
                hashes.add(pdf_twin._sha256((out / "blind" / "paper.pdf").read_bytes()))
        self.assertEqual(len(hashes), 1)

    def test_empty_out_dir_is_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            out.mkdir()
            report = pdf_twin.make_pdf_twin(self.m01, out)
            self.assertEqual(report["status"], "applied")
            self.assertTrue((out / "blind" / "paper.pdf").is_file())

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


def _fixed_pdf() -> bytes:
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), "p=0.004")
    doc.set_metadata({
        "producer": "pdf-twin-test",
        "creationDate": "D:20200101000000Z",
        "modDate": "D:20200101000000Z",
    })
    doc.xref_set_key(-1, "ID", "[<01010101010101010101010101010101><01010101010101010101010101010101>]")
    return doc.tobytes(
        garbage=0,
        deflate=False,
        no_new_id=True,
        encryption=int(pymupdf.mupdf.PDF_ENCRYPT_KEEP),
    )


def _swap_id(data: bytes, body: bytes) -> bytes:
    match = re.search(br"/ID\s*\[[^\]]*\]", data)
    if match is None:
        raise AssertionError("id missing")
    return data[:match.start()] + b"/ID[" + body + b"]" + data[match.end():]


@unittest.skipUnless(_have_pymupdf(), "pymupdf")
class IdFormTests(unittest.TestCase):
    def test_hex_and_literal_ids_collapse_to_one_document(self):
        base = _fixed_pdf()
        forms = [
            base,
            _swap_id(base, b"<00112233445566778899AABBCCDDEEFF><FFEEDDCCBBAA99887766554433221100>"),
            _swap_id(base, b"<00112233445566778899AABBCCDDEEFF>(a\\\\b\\(c\\)\\141)"),
            _swap_id(base, b"<00112233445566778899AABBCCDDEEFF>(ab]cd)"),
            _swap_id(base, b"(\\\\(\\)\\141)(zz\\(q\\\\))"),
        ]
        import pymupdf

        for item in forms:
            pymupdf.TOOLS.reset_mupdf_warnings()
            with pymupdf.open(stream=item, filetype="pdf") as doc:
                self.assertFalse(doc.is_repaired)
                self.assertIn("p=0.004", doc[0].get_text("text") or "")
            self.assertEqual(pymupdf.TOOLS.mupdf_warnings(), "")
        stabilized = [pdf_twin._stabilize(item) for item in forms]
        self.assertEqual(len({item for item in stabilized}), 1)
        self.assertEqual(pdf_twin._stabilize(stabilized[0]), stabilized[0])
        pymupdf.TOOLS.reset_mupdf_warnings()
        with pymupdf.open(stream=stabilized[0], filetype="pdf") as doc:
            self.assertFalse(doc.is_repaired)
            self.assertIn("p=0.004", doc[0].get_text("text") or "")
            self.assertEqual(doc.metadata["creationDate"], "D:20200101000000Z")
            self.assertEqual(doc.metadata["modDate"], "D:20200101000000Z")
            self.assertEqual(doc.metadata["producer"], "pdf-twin-test")
        self.assertEqual(pymupdf.TOOLS.mupdf_warnings(), "")
        self.assertTrue(pdf_twin._startxref_ok(stabilized[0]))


class UsageTests(unittest.TestCase):
    def test_nonempty_out_exits_2_and_keeps_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = root / "out"
            out.mkdir()
            kept = out / "keep.txt"
            kept.write_text("safe", encoding="utf-8")
            with self.assertRaises(pdf_twin.PdfTwinError) as caught:
                pdf_twin.make_pdf_twin(root / "no-bundle", out)
            self.assertEqual(caught.exception.code, "out_dir_not_empty")
            code = pdf_twin.main(["make", str(root / "no-bundle"), "--out", str(out)])
            self.assertEqual(code, 2)
            self.assertEqual(kept.read_text(encoding="utf-8"), "safe")
            self.assertEqual([path.name for path in out.iterdir()], ["keep.txt"])

    def test_out_file_exits_2_and_is_not_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "out.pdf"
            target.write_bytes(b"not-a-directory")
            with self.assertRaises(pdf_twin.PdfTwinError) as caught:
                pdf_twin.make_pdf_twin(root / "no-bundle", target)
            self.assertEqual(caught.exception.code, "out_dir_not_empty")
            code = pdf_twin.main(["make", str(root / "no-bundle"), "--out", str(target)])
            self.assertEqual(code, 2)
            self.assertEqual(target.read_bytes(), b"not-a-directory")

    def test_usage_and_invalid_bundle_exit_2(self):
        self.assertEqual(pdf_twin.main(["make"]), 2)
        with tempfile.TemporaryDirectory() as tmp:
            code = pdf_twin.main(["make", tmp, "--out", str(Path(tmp) / "out")])
            self.assertEqual(code, 2)
            self.assertFalse((Path(tmp) / "out").exists())
