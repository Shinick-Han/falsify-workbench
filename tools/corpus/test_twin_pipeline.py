"""Build every discovered mutation set and require the twin gate to pass."""

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

CORPUS = Path(__file__).resolve().parent
if str(CORPUS) not in sys.path:
    sys.path.insert(0, str(CORPUS))

import twin_gate
from render import find_engine
from source_mutator import build_twin, load_spec
from twin_gate import normalize_pdf_text, verify_twin

_BUNDLE_FILES = [
    "blind/paper.pdf",
    "manifest.json",
    "sealed/baseline-signals.json",
    "sealed/clean.pdf",
    "sealed/gate.json",
    "sealed/gold-ledger.json",
]
_PUBLIC_KEYS = {"before", "after", "rationale", "defectId", "operationId", "overridesApplied"}
_REPORT_KEYS = {"before", "after", "rationale", "operationId", "overridesApplied"}


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
    return bool(find_engine()) and _have_pymupdf() and _have_matplotlib()


def _specs() -> list[Path]:
    return sorted(Path(__file__).resolve().parent.glob("fixtures/*/mutations/*.json"))


def _walk_keys(node, found: set[str]) -> None:
    if isinstance(node, dict):
        found.update(node)
        for item in node.values():
            _walk_keys(item, found)
    elif isinstance(node, list):
        for item in node:
            _walk_keys(item, found)


def _files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.is_file())


def _canonical_pdf(path: Path) -> str:
    import pymupdf

    doc = pymupdf.open(path)
    try:
        pages = [page.get_text("text") or "" for page in doc]
    finally:
        doc.close()
    return normalize_pdf_text("\f".join(pages))


@unittest.skipUnless(_ready(), "pdflatex, pymupdf, matplotlib")
class TwinPipelineTests(unittest.TestCase):
    def test_every_mutation_set_passes_the_gate(self):
        specs = _specs()
        self.assertGreater(len(specs), 0)
        started = time.perf_counter()
        detected = []
        try:
            for spec_path in specs:
                with self.subTest(spec=spec_path.as_posix()):
                    if self._run_spec(spec_path):
                        detected.append(spec_path.stem)
        finally:
            elapsed = time.perf_counter() - started
            print(f"pipeline-test-seconds {elapsed:.1f} layer0 {','.join(detected)}")

    def _run_spec(self, spec_path: Path) -> bool:
        spec = load_spec(spec_path)
        case = spec_path.parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            build = root / "build"
            build_twin(case, spec, build, compile_pdf=True)
            first = verify_twin(build, case, bundle_out=root / "bundle-a")
            second = verify_twin(build, case, bundle_out=root / "bundle-b")
            self.assertTrue(first["pass"], first["failures"])
            self.assertTrue(second["pass"], second["failures"])
            self.assertEqual(first, second)
            self._assert_bundle(root / "bundle-a", root / "bundle-b", build, first)
            return any(item.get("layer0Detected") for item in first["defects"])

    def _assert_bundle(self, left: Path, right: Path, build: Path, report: dict) -> None:
        names = sorted(path.relative_to(left).as_posix() for path in _files(left))
        self.assertEqual(names, _BUNDLE_FILES)
        for path in _files(left):
            other = right / path.relative_to(left)
            self.assertEqual(path.read_bytes(), other.read_bytes(), path.name)
        ledger = json.loads((build / "sealed" / "gold-ledger.json").read_text(encoding="utf-8"))
        rationales = [item["rationale"] for item in ledger["defects"]]
        self._assert_blind(left, report, rationales)
        canonical = _canonical_pdf(build / "defect" / "paper.pdf")
        for defect in ledger["defects"]:
            if any(not twin_gate._image_context(item) for item in defect["source"]["contexts"]):
                quote = normalize_pdf_text(defect["quote"])
                self.assertIn(quote, canonical, defect["defectId"])

    def _assert_blind(self, bundle: Path, report: dict, rationales: list[str]) -> None:
        report_keys = set()
        _walk_keys(report, report_keys)
        self.assertTrue(_REPORT_KEYS.isdisjoint(report_keys))
        report_text = json.dumps(report, ensure_ascii=False)
        for rationale in rationales:
            self.assertNotIn(rationale, report_text)
        for path in _files(bundle):
            if "sealed/" in path.relative_to(bundle).as_posix():
                continue
            raw = path.read_bytes()
            for rationale in rationales:
                self.assertNotIn(rationale.encode("utf-8"), raw, path.name)
            if path.suffix.lower() != ".json":
                continue
            keys = set()
            _walk_keys(json.loads(path.read_text(encoding="utf-8")), keys)
            self.assertTrue(_PUBLIC_KEYS.isdisjoint(keys), path.name)


if __name__ == "__main__":
    unittest.main()
