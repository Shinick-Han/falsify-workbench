"""CLI coverage for corpus list, build, mutate, and verify."""
from __future__ import annotations

import contextlib
import importlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / "app" / "local"
CASE = ROOT / "tools" / "corpus" / "fixtures" / "rct_minimal"
SPEC = CASE / "mutations" / "m01-abstract-p.json"
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

import falsify_cli  # noqa: E402

_BANNED = ("before", "after", "rationale", "operationId", "overridesApplied")
_SOURCE_SCHEMAS = (
    "falsify.source-case.v1",
    "falsify.source-mutation.v1",
    "falsify.source-mutation-plan.v1",
    "falsify.source-twin.v1",
    "falsify.source-twin-gate.v1",
    "falsify.source-bundle.v1",
    "falsify.source-baseline-exemptions.v1",
)


def _have_module(name: str) -> bool:
    try:
        return importlib.import_module(name) is not None
    except ImportError:
        return False


def _ready_e2e() -> bool:
    return bool(shutil.which("pdflatex")) and _have_module("pymupdf") and _have_module("matplotlib")


def _run(argv: list[str]) -> tuple[int, dict, str]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = falsify_cli.main(argv)
    raw = buf.getvalue()
    payload = json.loads(raw) if raw.strip() else {}
    return code, payload, raw


def _keys(node, found: set[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            found.add(key)
            _keys(value, found)
    elif isinstance(node, list):
        for item in node:
            _keys(item, found)


class RenderError(Exception):
    def __init__(self, code: str, details: str = ""):
        super().__init__(details)
        self.code = code


class MutationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class GateError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class GateTimeout(Exception):
    def __init__(self):
        super().__init__("timeout")
        self.code = "timeout"


def _raise_gate(*_args, **_kwargs):
    raise GateError("missing_file")


def _raise_timeout(*_args, **_kwargs):
    raise GateTimeout()


def _assert_blind(test: unittest.TestCase, payload: dict, raw: str, *, allow_defect_id: bool = False) -> None:
    found: set[str] = set()
    _keys(payload, found)
    for key in _BANNED:
        test.assertNotIn(key, found)
    if not allow_defect_id:
        test.assertNotIn("defectId", found)
    test.assertNotRegex(raw, r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]")
    test.assertNotIn("/Users/", raw)
    test.assertNotIn("/home/", raw)
    test.assertNotIn("SECRET_VALUE", raw)


class CorpusListTests(unittest.TestCase):
    def test_list_fixtures_hides_answer_keys(self):
        code, payload, raw = _run(["corpus", "list"])
        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["command"], "corpus list")
        self.assertEqual(payload["root"], "tools/corpus/fixtures")
        by_id = {item["caseId"]: item for item in payload["cases"]}
        self.assertEqual(
            by_id["rct-minimal"]["mutationSetIds"],
            [
                "m01-abstract-p",
                "m02-table-n",
                "m03-figure-y",
                "m04-all-estimate",
                "m05-strengthen-claim",
                "m06-minimize-limitation",
                "m07-remove-hedge",
            ],
        )
        self.assertEqual(len(by_id["dta-minimal"]["mutationSetIds"]), 4)
        self.assertEqual(len(by_id["meta-minimal"]["mutationSetIds"]), 4)
        self.assertNotIn("Abstract p value disagrees", raw)
        _assert_blind(self, payload, raw)

    def test_list_custom_root_omits_spec_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = root / "sample"
            mutations = case / "mutations"
            mutations.mkdir(parents=True)
            (case / "case.json").write_text(json.dumps({
                "schema": "falsify.source-case.v1",
                "caseId": "sample-case",
                "title": "not a value",
            }), encoding="utf-8")
            (mutations / "m01.json").write_text(json.dumps({
                "schema": "falsify.source-mutation.v1",
                "caseId": "sample-case",
                "mutationSetId": "m01-only",
                "rationale": "SECRET_VALUE",
                "mutations": [{"text": "0.99", "before": "1", "after": "2"}],
            }), encoding="utf-8")
            code, payload, raw = _run(["corpus", "list", "--root", str(root)])
        self.assertEqual(code, 0, raw)
        self.assertEqual(payload["cases"][0]["caseId"], "sample-case")
        self.assertEqual(payload["cases"][0]["mutationSetIds"], ["m01-only"])
        self.assertNotIn(str(root), raw)
        _assert_blind(self, payload, raw)

    def test_list_missing_root_and_bad_spec(self):
        missing, missing_payload, _raw = _run(["corpus", "list", "--root", "missing-corpus-root"])
        self.assertEqual(missing, 2)
        self.assertEqual(missing_payload["error"], "file_not_found")
        with tempfile.TemporaryDirectory() as tmp:
            case = Path(tmp) / "sample"
            (case / "mutations").mkdir(parents=True)
            (case / "case.json").write_text(
                json.dumps({"schema": "falsify.source-case.v1", "caseId": "sample-case"}),
                encoding="utf-8",
            )
            (case / "mutations" / "bad.json").write_text("{}", encoding="utf-8")
            code, payload, raw = _run(["corpus", "list", "--root", str(case)])
        self.assertEqual(code, 2)
        self.assertEqual(payload["error"], "schema_invalid")
        self.assertNotIn("SECRET_VALUE", raw)

    def test_tools_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch("falsify_corpus_cli._tools_root", return_value=Path(tmp)):
                listed, list_payload, _raw = _run(["corpus", "list"])
                schemas, schema_payload, _schema_raw = _run(["schemas", "--id", "falsify.agent-cli.v1"])
        self.assertEqual(listed, 2)
        self.assertEqual(list_payload["error"], "corpus_tools_unavailable")
        self.assertEqual(schemas, 0)
        self.assertEqual(schema_payload["catalog"]["schemaId"], "falsify.agent-cli.v1")


class CorpusCommandTests(unittest.TestCase):
    def test_help_and_missing_flags_exit(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = falsify_cli.main(["corpus", "list", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("--root", buf.getvalue())
        bare, bare_payload, _raw = _run(["corpus"])
        self.assertEqual(bare, 2)
        self.assertEqual(bare_payload["error"], "invalid_arguments")
        self.assertIn("corpus list", bare_payload["message"])

    def test_build_stub_drops_overrides(self):
        def render_case(*_args, **_kwargs):
            return {
                "schema": "falsify.source-render.v1",
                "caseId": "rct-minimal",
                "compiled": False,
                "engine": None,
                "overridesApplied": [{"before": "0.03", "after": "0.04", "rationale": "SECRET_VALUE"}],
                "files": [{"path": "paper.tex", "sha256": "ab"}],
                "pageCount": None,
                "modelCalls": 0,
            }

        with tempfile.TemporaryDirectory() as tmp:
            with patch("falsify_corpus_cli._import_named", return_value=SimpleNamespace(render_case=render_case)):
                code, payload, raw = _run([
                    "corpus", "build", "--case", str(CASE), "--out", str(Path(tmp) / "out"), "--no-compile",
                ])
        self.assertEqual(code, 0, raw)
        self.assertEqual(payload["command"], "corpus build")
        self.assertEqual(payload["files"], [{"path": "paper.tex", "sha256": "ab"}])
        self.assertIsNone(payload["engine"])
        _assert_blind(self, payload, raw)

    def test_dependency_missing_names_tool_and_hides_log(self):
        def render_case(*_args, **_kwargs):
            raise RenderError("engine_unavailable", r"C:\Users\user\secret SECRET_VALUE")

        with tempfile.TemporaryDirectory() as tmp:
            with patch("falsify_corpus_cli._import_named", return_value=SimpleNamespace(render_case=render_case)):
                tex, tex_payload, tex_raw = _run([
                    "corpus", "build", "--case", str(CASE), "--out", str(Path(tmp) / "out"),
                ])
        self.assertEqual(tex, 2)
        self.assertEqual(tex_payload["error"], "dependency_missing")
        self.assertEqual(tex_payload["dependency"], "pdflatex")
        self.assertIn("pdflatex", tex_payload["message"])
        _assert_blind(self, tex_payload, tex_raw)

        def draw(*_args, **_kwargs):
            raise RenderError("figure_engine_unavailable", "SECRET_VALUE")

        with tempfile.TemporaryDirectory() as tmp:
            with patch("falsify_corpus_cli._import_named", return_value=SimpleNamespace(render_case=draw)):
                plotted, plotted_payload, plotted_raw = _run([
                    "corpus", "build", "--case", str(CASE), "--out", str(Path(tmp) / "out"), "--no-compile",
                ])
        self.assertEqual(plotted, 2)
        self.assertEqual(plotted_payload["dependency"], "matplotlib")
        self.assertIn("matplotlib", plotted_payload["message"])
        _assert_blind(self, plotted_payload, plotted_raw)

    def test_mutation_error_exit_and_blind_stdout(self):
        def load_spec(*_args, **_kwargs):
            raise MutationError("diff_mismatch", "before 0.031 rationale SECRET_VALUE")

        with tempfile.TemporaryDirectory() as tmp:
            with patch("falsify_corpus_cli._import_named", return_value=SimpleNamespace(load_spec=load_spec, build_twin=load_spec)):
                code, payload, raw = _run([
                    "corpus", "mutate", "--case", str(CASE), "--spec", str(SPEC),
                    "--out", str(Path(tmp) / "out"), "--no-compile",
                ])
        self.assertEqual(code, 3)
        self.assertEqual(payload["error"], "diff_mismatch")
        _assert_blind(self, payload, raw)

    def test_verify_refusal_prints_report_without_sealed_detail(self):
        def verify_twin(*_args, **_kwargs):
            return {
                "schema": "falsify.source-twin-gate.v1",
                "caseId": "rct-minimal",
                "mutationSetId": "m01-abstract-p",
                "pass": False,
                "checks": [{"check": "diff_attribution", "pass": False, "details": {"pages": 1}}],
                "failures": [{
                    "check": "diff_attribution",
                    "code": "unexplained_diff",
                    "detail": "SECRET_VALUE 0.031",
                }],
                "defects": [{"defectId": "abs-p", "layer0Detected": False, "before": "SECRET_VALUE"}],
                "modelCalls": 0,
            }

        with tempfile.TemporaryDirectory() as tmp:
            build = Path(tmp) / "build"
            build.mkdir()
            with patch("falsify_corpus_cli._import_named", return_value=SimpleNamespace(verify_twin=verify_twin)):
                code, payload, raw = _run([
                    "corpus", "verify", "--build", str(build), "--case", str(CASE),
                ])
        self.assertEqual(code, 3)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "gate_refused")
        self.assertEqual(payload["report"]["failures"], [{
            "check": "diff_attribution",
            "code": "unexplained_diff",
        }])
        self.assertEqual(payload["report"]["defects"], [{"defectId": "abs-p", "layer0Detected": False}])
        _assert_blind(self, payload, raw, allow_defect_id=True)

    def test_gate_input_and_timeout_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            build = Path(tmp) / "build"
            build.mkdir()
            with patch("falsify_corpus_cli._import_named", return_value=SimpleNamespace(verify_twin=_raise_gate)):
                refused, refused_payload, _raw = _run(["corpus", "verify", "--build", str(build), "--case", str(CASE)])
            with patch("falsify_corpus_cli._import_named", return_value=SimpleNamespace(verify_twin=_raise_timeout)):
                timed, timed_payload, _timed_raw = _run(["corpus", "verify", "--build", str(build), "--case", str(CASE)])
        self.assertEqual(refused, 2)
        self.assertEqual(refused_payload["error"], "missing_file")
        self.assertEqual(timed, 124)
        self.assertEqual(timed_payload["error"], "timeout")

    def test_refuses_to_overwrite_case_directory(self):
        code, payload, _raw = _run([
            "corpus", "build", "--case", str(CASE), "--out", str(CASE), "--no-compile",
        ])
        self.assertEqual(code, 2)
        self.assertEqual(payload["error"], "cannot_overwrite_input")

    def test_schemas_register_source_contracts(self):
        code, payload, raw = _run(["schemas"])
        self.assertEqual(code, 0)
        ids = [item["schemaId"] for item in payload["catalog"]["schemas"]]
        for schema_id in _SOURCE_SCHEMAS:
            self.assertIn(schema_id, ids)
        looked, entry, _entry_raw = _run(["schemas", "--id", "falsify.source-twin-gate.v1"])
        self.assertEqual(looked, 0)
        self.assertEqual(entry["catalog"]["schemaId"], "falsify.source-twin-gate.v1")
        self.assertEqual(entry["catalog"]["role"], "cli")
        _assert_blind(self, payload, raw)


@unittest.skipUnless(_have_module("matplotlib"), "matplotlib")
class CorpusNoCompileTests(unittest.TestCase):
    def test_build_no_compile_writes_tex(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "clean"
            code, payload, raw = _run([
                "corpus", "build", "--case", str(CASE), "--out", str(out), "--no-compile",
            ])
            self.assertEqual(code, 0, raw)
            self.assertFalse(payload["compiled"])
            self.assertTrue((out / "paper.tex").is_file())
            _assert_blind(self, payload, raw)


@unittest.skipUnless(_ready_e2e(), "pdflatex, pymupdf, matplotlib")
class CorpusEndToEndTests(unittest.TestCase):
    def test_list_mutate_verify_m01(self):
        listed, listing, list_raw = _run(["corpus", "list"])
        self.assertEqual(listed, 0, list_raw)
        ids = {item["caseId"]: item["mutationSetIds"] for item in listing["cases"]}
        self.assertIn("m01-abstract-p", ids["rct-minimal"])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            build = root / "build"
            bundle = root / "bundle"
            mutated, mutation, mutation_raw = _run([
                "corpus", "mutate", "--case", str(CASE), "--spec", str(SPEC), "--out", str(build),
            ])
            self.assertEqual(mutated, 0, mutation_raw)
            self.assertEqual(mutation["mutationSetId"], "m01-abstract-p")
            self.assertTrue(mutation["compiled"])
            _assert_blind(self, mutation, mutation_raw)
            verified, report, report_raw = _run([
                "corpus", "verify", "--build", str(build), "--case", str(CASE), "--bundle-out", str(bundle),
            ])
            self.assertEqual(verified, 0, report_raw)
            self.assertTrue(report["report"]["pass"])
            self.assertTrue((bundle / "manifest.json").is_file())
            self.assertTrue((bundle / "blind" / "paper.pdf").is_file())
            for row in report["report"]["defects"]:
                self.assertEqual(set(row), {"defectId", "layer0Detected"})
            _assert_blind(self, report, report_raw, allow_defect_id=True)


if __name__ == "__main__":
    unittest.main()
