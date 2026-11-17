"""Tests for the source/PDF pair corpus builder."""

import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
EVAL = HERE.parents[0] / "evaluation"
if str(EVAL) not in sys.path:
    sys.path.insert(0, str(EVAL))

import pair_corpus
from leak_dependence import _parse_manifest
from source_mutator import load_spec, plan_mutations

FIX = HERE / "fixtures"
_ROLES = {"source-native", "pdf-mutation"}
_SOURCE_PDF = b"%PDF-1.4\n%source-arm\n"
_EDITED_PDF = b"%PDF-1.4\n%pdf-arm\n"


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


def _ready() -> bool:
    return bool(shutil.which("pdflatex") and _have_pymupdf() and _have_matplotlib())


def _spec(case_id, set_id):
    return {
        "schema": "falsify.source-mutation.v1",
        "caseId": case_id,
        "mutationSetId": set_id,
        "mutations": [{
            "defectId": "d1",
            "operator": "set_text",
            "valueId": "n_excluded",
            "text": "61",
            "surfaces": ["tex:results"],
            "family": "D1",
            "difficulty": "L2",
            "rationale": "Stub spec used only to exercise the corpus index.",
        }],
    }


def _gold(producer, set_id):
    return {
        "caseId": "demo-case",
        "defects": [{
            "defectId": "d1",
            "difficulty": "L3",
            "family": "D1",
            "pageIndex": 0,
            "quote": "alpha token",
            "source": {"contexts": [{"after": "alpha token", "before": "beta token"}]},
        }],
        "mutationSetId": set_id,
        "producer": producer,
        "schema": "falsify.red-gold-ledger.v1",
    }


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_bundle(bundle: Path, spec, pdf: bytes) -> None:
    _write_json(bundle / "manifest.json", {
        "caseId": spec["caseId"],
        "mutationSetId": spec["mutationSetId"],
        "schema": "falsify.source-bundle.v1",
    })
    _write_json(bundle / "sealed" / "gold-ledger.json", _gold("source-native", spec["mutationSetId"]))
    _write_json(bundle / "sealed" / "baseline-signals.json", {"signals": []})
    _write_json(bundle / "sealed" / "gate.json", {
        "defects": [{"defectId": "d1", "layer0Detected": False}],
        "pass": True,
        "schema": "falsify.source-twin-gate.v1",
    })
    (bundle / "blind").mkdir(parents=True, exist_ok=True)
    (bundle / "blind" / "paper.pdf").write_bytes(pdf)


def _fake_build(case_dir, spec, out_dir, compile_pdf=True):
    del case_dir, compile_pdf
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    _write_json(out / "spec.json", spec)
    return {"defectCount": 1, "modelCalls": 0, "overrideCount": 1}


def _fake_verify(build_dir, case_dir, bundle_out=None, timeout=None):
    del case_dir, timeout
    spec = json.loads((Path(build_dir) / "spec.json").read_text(encoding="utf-8"))
    if spec["mutationSetId"].endswith("no"):
        return {
            "failures": [{"check": "defect_layer0", "code": "collateral_signal", "detail": "x"}],
            "pass": False,
        }
    _write_bundle(Path(bundle_out), spec, _SOURCE_PDF)
    return {"defects": [{"defectId": "d1", "layer0Detected": False}], "failures": [], "pass": True}


def _fake_make(bundle_dir, out_dir):
    manifest = json.loads((Path(bundle_dir) / "manifest.json").read_text(encoding="utf-8"))
    out = Path(out_dir)
    if manifest["mutationSetId"].endswith("src"):
        _write_json(out / "sealed" / "pair.json", {
            "defects": [{"defectId": "d1", "reason": "unit_failed", "status": "unsupported"}],
            "schema": "falsify.source-pdf-pair.v1",
            "status": "unsupported",
        })
        return {"reasons": ["unit_failed"], "status": "unsupported", "unsupported": 1}
    (out / "blind").mkdir(parents=True, exist_ok=True)
    (out / "blind" / "paper.pdf").write_bytes(_EDITED_PDF)
    _write_json(out / "sealed" / "gold-ledger.json", _gold("pdf-mutation", manifest["mutationSetId"]))
    _write_json(out / "sealed" / "pair.json", {
        "defects": [{"defectId": "d1", "reason": None, "status": "applied"}],
        "schema": "falsify.source-pdf-pair.v1",
        "status": "applied",
    })
    return {"reasons": [None], "status": "applied", "unsupported": 0}


def _fake_layer0(pdf, run_id):
    del pdf, run_id
    return {
        "agentId": "layer0-sensor",
        "findings": [{
            "decision": "defect",
            "excerpt": "alpha token",
            "id": "sens-1",
            "pageIndex": 0,
            "quote": "alpha token",
        }],
        "runId": "layer0-sensor",
    }


def _fixture(root: Path) -> None:
    case = root / "demo"
    (case / "mutations").mkdir(parents=True)
    (case / "case.json").write_text("{}\n", encoding="utf-8")
    for set_id in ("p01-pair-ok", "p02-pair-src", "p03-pair-no"):
        _write_json(case / "mutations" / f"{set_id}.json", _spec("demo-case", set_id))


def _keys(node, found: set) -> None:
    if isinstance(node, dict):
        found.update(node)
        for value in node.values():
            _keys(value, found)
    elif isinstance(node, list):
        for value in node:
            _keys(value, found)


def _hashes(root: Path) -> dict:
    found = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            found[path.relative_to(root).as_posix()] = pair_corpus._sha256(path.read_bytes())
    return found


class PairSpecTests(unittest.TestCase):
    def test_pair_specs_plan_as_one_defect(self):
        paths = sorted(FIX.glob("*/mutations/p*-pair-*.json"))
        self.assertGreaterEqual(len(paths), 15)
        for path in paths:
            spec = load_spec(path)
            plan = plan_mutations(path.parents[1], spec)
            self.assertEqual(len(plan["defects"]), 1, path.name)
            self.assertEqual(len(plan["defects"][0]["changedSurfaces"]), 1, path.name)


class PairCorpusStubTests(unittest.TestCase):
    def setUp(self):
        self.saved = {
            "build_twin": pair_corpus.build_twin,
            "layer0_run": pair_corpus.layer0_run,
            "make_pdf_twin": pair_corpus.make_pdf_twin,
            "verify_twin": pair_corpus.verify_twin,
        }
        pair_corpus.build_twin = _fake_build
        pair_corpus.verify_twin = _fake_verify
        pair_corpus.make_pdf_twin = _fake_make
        pair_corpus.layer0_run = _fake_layer0
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        _fixture(self.root / "fixtures")

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(pair_corpus, name, value)
        self.tmp.cleanup()

    def _build(self, layer0=False):
        out = self.root / ("corpus-layer0" if layer0 else "corpus")
        summary = pair_corpus.build_corpus(
            self.root / "fixtures", out, layer0_runs=layer0,
        )
        return out, summary

    def test_index_statuses_and_manifest_shape(self):
        out, summary = self._build(layer0=True)
        self.assertEqual(summary, {
            "paired": 1,
            "refused": 1,
            "schema": pair_corpus.SCHEMA,
            "sets": 3,
            "sourceOnly": 1,
        })
        index = json.loads((out / "sealed" / "index.json").read_text(encoding="utf-8"))
        by_status = {item["status"] for item in index["sets"]}
        self.assertEqual(by_status, {"paired", "source_only", "refused"})
        manifest = json.loads((out / "sealed" / "leak-dependence-input.json").read_text(encoding="utf-8"))
        entries = _parse_manifest(manifest)
        self.assertEqual(len(entries), 2)
        self.assertEqual({item["arm"] for item in entries}, _ROLES)
        report = pair_corpus.measure_corpus(out, self.root / "report.json")
        self.assertEqual(report["schema"], "falsify.leak-dependence.v1")
        self.assertEqual(report["pairCount"], 1)

    def test_opaque_ids_and_blind_side(self):
        out, _summary = self._build()
        index = json.loads((out / "sealed" / "index.json").read_text(encoding="utf-8"))
        names = []
        for item in index["sets"]:
            self.assertNotEqual(item["pairKey"], item["mutationSetId"])
            names.append(item["mutationSetId"])
            for role, arm in item["arms"].items():
                self.assertNotIn(arm["armId"], _ROLES)
                self.assertNotEqual(arm["armId"], role)
                self.assertEqual(len(arm["pdfSha256"]), 64)
        for path in (out / "blind").rglob("*"):
            rel = path.relative_to(out).as_posix()
            for name in names:
                self.assertNotIn(name, rel)
            for role in _ROLES:
                self.assertNotIn(role, rel)
        self.assertEqual(list((out / "blind").rglob("*.json")), [])

    def test_two_builds_match(self):
        first, _summary = self._build()
        second = self.root / "corpus-2"
        pair_corpus.build_corpus(self.root / "fixtures", second)
        self.assertEqual(_hashes(first), _hashes(second))

    def test_measure_refuses_empty_runs(self):
        out, _summary = self._build()
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = pair_corpus.main(["measure", "--corpus", str(out), "--out", str(self.root / "no.json")])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(buffer.getvalue())["error"], "runs_empty")
        self.assertFalse((self.root / "no.json").exists())

    def test_build_stdout_hides_set_names(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = pair_corpus.main([
                "build", "--fixtures", str(self.root / "fixtures"), "--out", str(self.root / "cli"),
            ])
        self.assertEqual(code, 0)
        text = buffer.getvalue()
        self.assertNotIn("p01-pair-ok", text)
        self.assertNotIn("source-native", text)
        keys = set()
        _keys(json.loads(text), keys)
        self.assertTrue(pair_corpus._BANNED.isdisjoint(keys))


class PairCorpusEndToEndTests(unittest.TestCase):
    @unittest.skipUnless(_ready(), "pdflatex, PyMuPDF, or matplotlib is unavailable")
    def test_one_real_pair_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "corpus"
            summary = pair_corpus.build_corpus(
                FIX, out, sets_glob="rct_minimal/mutations/p02-pair-flow-excl.json",
            )
            index = json.loads((out / "sealed" / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["sets"], 1)
        self.assertEqual(summary["paired"], 1)
        self.assertEqual(summary["refused"], 0)
        self.assertEqual(index["sets"][0]["status"], "paired")
        self.assertIn("source-native", index["sets"][0]["arms"])
        self.assertIn("pdf-mutation", index["sets"][0]["arms"])


if __name__ == "__main__":
    unittest.main()
