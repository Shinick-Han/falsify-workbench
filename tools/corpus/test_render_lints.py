"""Table and figure lint refusals around source rendering."""

import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import render
from render import DEFECT_LINT_KEY, RenderError, assemble_case, render_case, render_twin
from source_case import list_bindings, resolve_case
from source_mutator import _dump, build_twin

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "rct_minimal"
SURVIVAL = Path(__file__).resolve().parent / "fixtures" / "survival_minimal"
SCRIPT = Path(__file__).resolve().parent / "render.py"
ROOT = Path(__file__).resolve().parents[2]
_ABS = re.compile(r"[A-Za-z]:[\\/]|/Users/|/home/")
_VERTICAL = (
    "\\begin{table}\n"
    "\\centering\n"
    "\\caption{Synthetic vertical rule table for the lint refusal}\n"
    "\\begin{tabular}{|l|r|}\n"
    "\\toprule\n"
    "Arm & Value \\\\\n"
    "\\midrule\n"
    "A & 1 \\\\\n"
    "\\bottomrule\n"
    "\\end{tabular}\n"
    "\\end{table}\n"
)


def _have_matplotlib():
    try:
        import matplotlib
    except ImportError:
        return False
    return matplotlib is not None


def _copy_case(tmp):
    dest = Path(tmp) / "case"
    shutil.copytree(FIXTURE, dest)
    return dest


def _figureless(tmp):
    dest = _copy_case(tmp)
    payload = {"schema": "falsify.source-figures.v1", "figures": []}
    (dest / "inputs" / "figures.json").write_text(
        json.dumps(payload) + "\n", encoding="utf-8", newline="\n",
    )
    tex_path = dest / "source" / "paper.tex"
    lines = [
        line
        for line in tex_path.read_text(encoding="utf-8").splitlines(True)
        if r"\falsifyfigure" not in line
    ]
    tex_path.write_text("".join(lines), encoding="utf-8", newline="\n")
    return dest


def _inject_vertical(case: Path) -> None:
    tex_path = case / "source" / "paper.tex"
    text = tex_path.read_text(encoding="utf-8")
    needle = "\\begin{document}\n"
    if needle not in text:
        raise AssertionError(needle)
    tex_path.write_text(text.replace(needle, needle + _VERTICAL, 1), encoding="utf-8", newline="\n")


def _blank_caption(case: Path) -> None:
    path = case / "inputs" / "figures.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["figures"][0]["caption"] = ""
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8", newline="\n")


def _cli(args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=ROOT,
        check=False,
    )


def _assert_warnings(test, warnings):
    test.assertTrue(warnings)
    test.assertEqual(warnings, sorted(warnings, key=lambda item: (item["lint"], item["code"])))
    for item in warnings:
        test.assertEqual(set(item), {"lint", "code", "count"})
        test.assertIsInstance(item["count"], int)
        test.assertGreater(item["count"], 0)
    test.assertIsNone(_ABS.search(json.dumps(warnings)))


def _public_files(root: Path) -> dict:
    sealed = root / "sealed"
    found = {}
    for path in root.rglob("*"):
        if not path.is_file() or sealed in path.parents:
            continue
        found[path.relative_to(root).as_posix()] = path.read_bytes()
    return found


def _plan_phrases(plan) -> list[str]:
    phrases = []

    def walk(node, key=None):
        if isinstance(node, dict):
            for name, value in node.items():
                walk(value, name)
            return
        if isinstance(node, list):
            for value in node:
                walk(value, key)
            return
        if not isinstance(node, str) or key not in {"before", "after", "rationale", "defectId", "operationId"}:
            return
        if key == "before" and node.isdigit():
            return
        phrases.append(node)

    walk(plan)
    return phrases


class TableLintTests(unittest.TestCase):
    def test_clean_fixture_assembles(self):
        assembled = assemble_case(resolve_case(FIXTURE))
        self.assertIn(r"\toprule", assembled["tex"])
        self.assertNotIn("|", assembled["tex"].split(r"\begin{tabular}{")[1].split("}")[0])
        _assert_warnings(self, assembled["lintWarnings"])
        self.assertTrue(any(item["code"] == "no-label" for item in assembled["lintWarnings"]))

    def test_vertical_rule_is_table_lint(self):
        tex = (
            "\\documentclass{article}\n"
            "\\begin{document}\n"
            + _VERTICAL
            + "\\end{document}\n"
        )
        with self.assertRaises(RenderError) as caught:
            assemble_case({"tex": tex, "tables": [], "figures": [], "references": []})
        self.assertEqual(caught.exception.code, "table_lint")
        self.assertTrue(any(item["code"] == "vertical-rule" for item in caught.exception.details))

    def test_vertical_rule_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _copy_case(tmp)
            _inject_vertical(case)
            out = Path(tmp) / "out"
            with self.assertRaises(RenderError) as caught:
                render_case(case, out, compile_pdf=False)
            self.assertEqual(caught.exception.code, "table_lint")
            self.assertFalse(out.exists())

    def test_cli_table_lint_exits_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _copy_case(tmp)
            _inject_vertical(case)
            out = Path(tmp) / "out"
            proc = _cli(["render", str(case), "--out", str(out), "--no-compile"])
            self.assertEqual(proc.returncode, 3, proc.stderr)
            self.assertTrue(proc.stderr.startswith("table_lint:"))
            self.assertIn("vertical-rule", proc.stderr)
            self.assertIsNone(_ABS.search(proc.stderr))
            self.assertFalse(out.exists())

    def test_warnings_do_not_refuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _figureless(tmp)
            out = Path(tmp) / "out"
            proc = _cli(["render", str(case), "--out", str(out), "--no-compile"])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            _assert_warnings(self, payload["lintWarnings"])
            self.assertTrue(any(item["lint"] == "table_lint" for item in payload["lintWarnings"]))
            self.assertFalse(any(item["lint"] == "figure_lint" for item in payload["lintWarnings"]))
            self.assertIsNone(_ABS.search(proc.stdout))
            self.assertTrue((out / "paper.tex").is_file())


class FigureLintTests(unittest.TestCase):
    def test_referenced_figure_without_caption_is_figure_lint(self):
        with tempfile.TemporaryDirectory() as tmp:
            figures = Path(tmp) / "figures"
            figures.mkdir()
            (figures / "F9.png").write_bytes(b"not-a-png")
            tex = "\\includegraphics[width=0.8\\linewidth]{figures/F9.png}\n"
            with self.assertRaises(RenderError) as caught:
                render._figure_warnings([], figures, tex)
        self.assertEqual(caught.exception.code, "figure_lint")
        self.assertTrue(any(item["code"] == "missing-caption" for item in caught.exception.details))

    @unittest.skipUnless(_have_matplotlib(), "matplotlib unavailable")
    def test_empty_caption_refuses_during_render(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _copy_case(tmp)
            _blank_caption(case)
            with self.assertRaises(RenderError) as caught:
                render_case(case, Path(tmp) / "out", compile_pdf=False)
        self.assertEqual(caught.exception.code, "figure_lint")
        self.assertTrue(any(item["code"] == "empty-caption" for item in caught.exception.details))

    @unittest.skipUnless(_have_matplotlib(), "matplotlib unavailable")
    def test_cli_empty_caption_exits_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _copy_case(tmp)
            _blank_caption(case)
            proc = _cli(["render", str(case), "--out", str(Path(tmp) / "out"), "--no-compile"])
        self.assertEqual(proc.returncode, 3, proc.stderr)
        self.assertTrue(proc.stderr.startswith("figure_lint:"))
        self.assertIn("empty-caption", proc.stderr)
        self.assertIsNone(_ABS.search(proc.stderr))

    @unittest.skipUnless(_have_matplotlib(), "matplotlib unavailable")
    def test_clean_fixture_render_keeps_warnings(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = render_case(FIXTURE, Path(tmp) / "out", compile_pdf=False)
        warnings = result["lintWarnings"]
        _assert_warnings(self, warnings)
        self.assertTrue(any(
            item["lint"] == "figure_lint" and item["code"] == "no-pipeline-figure"
            for item in warnings
        ))
        self.assertTrue(any(item["code"] == "no-label" for item in warnings))
        self.assertIsNone(_ABS.search(json.dumps(result)))


class TwinWarningTests(unittest.TestCase):
    def test_twin_report_includes_sorted_warnings(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _figureless(tmp)
            binding = next(item for item in list_bindings(case) if item["surface"] == "tex:abstract")
            values = json.loads((case / "inputs" / "values.json").read_text(encoding="utf-8"))["values"]
            before = values[binding["valueId"]]["text"]
            result = render_twin(case, Path(tmp) / "out", [{
                "valueId": binding["valueId"],
                "text": "QQ" + before,
                "surfaces": ["tex:abstract"],
            }], compile_pdf=False)
        for side in ("clean", "defect"):
            _assert_warnings(self, result[side]["lintWarnings"])
        self.assertEqual(result["clean"]["lintWarnings"], result["defect"]["lintWarnings"])
        self.assertNotIn(DEFECT_LINT_KEY, result)
        self.assertIsNone(_ABS.search(json.dumps(result)))

    def test_stdout_omits_defect_lint_counts(self):
        payload = {
            "schema": "falsify.source-twin.v1",
            "caseId": "survival-minimal",
            DEFECT_LINT_KEY: [{"lint": "table_lint", "code": "mixed-precision", "count": 1}],
        }
        buf = io.StringIO()
        with redirect_stdout(buf):
            render._emit(payload)
        text = buf.getvalue()
        self.assertNotIn(DEFECT_LINT_KEY, text)
        self.assertNotIn("mixed-precision", text)
        self.assertNotIn(DEFECT_LINT_KEY, payload)

    @unittest.skipUnless(_have_matplotlib(), "matplotlib unavailable")
    def test_precision_mutation_keeps_public_bytes_equal(self):
        spec = {
            "schema": "falsify.source-mutation.v1",
            "caseId": "survival-minimal",
            "mutationSetId": "precision-events",
            "mutations": [{
                "defectId": "events-precision-cell",
                "operator": "set_text",
                "valueId": "d_k0",
                "text": "12.0",
                "surfaces": ["table:T2"],
                "family": "D1",
                "difficulty": "L1",
                "rationale": "Events column mixes a one-decimal count with integer counts.",
            }],
        }
        with tempfile.TemporaryDirectory() as tmp:
            real_out = Path(tmp) / "real"
            equal_out = Path(tmp) / "equal"
            real_summary = build_twin(SURVIVAL, spec, real_out, compile_pdf=False)
            cached = []
            real_findings = render._table_findings

            def same_as_clean(tex):
                if not cached:
                    cached.append(real_findings(tex))
                return cached[0]

            with mock.patch.object(render, "_table_findings", side_effect=same_as_clean):
                equal_summary = build_twin(SURVIVAL, spec, equal_out, compile_pdf=False)
            self.assertEqual(_dump(real_summary), _dump(equal_summary))
            self.assertEqual(_public_files(real_out), _public_files(equal_out))
            sealed = real_out / "sealed" / "defect-lint-warnings.json"
            self.assertTrue(sealed.is_file())
            self.assertFalse((equal_out / "sealed" / "defect-lint-warnings.json").exists())
            defect_counts = json.loads(sealed.read_text(encoding="utf-8"))["lintWarnings"]
            twin = json.loads((real_out / "twin.json").read_text(encoding="utf-8"))
            public = twin["clean"]["lintWarnings"]
            self.assertEqual(public, twin["defect"]["lintWarnings"])
            self.assertNotEqual(defect_counts, public)
            self.assertTrue(any(item["code"] == "mixed-precision" for item in defect_counts))
            self.assertFalse(any(item["code"] == "mixed-precision" for item in public))
            self.assertNotIn(DEFECT_LINT_KEY, twin)
            findings = render._table_findings((real_out / "defect" / "paper.tex").read_text(encoding="utf-8"))
            messages = [item["message"] for item in findings if item.get("code") == "mixed-precision"]
            self.assertTrue(messages)
            plan = json.loads((real_out / "sealed" / "mutation-plan.json").read_text(encoding="utf-8"))
            phrases = _plan_phrases(plan)
            self.assertIn("12.0", phrases)
            stdout = _dump(real_summary)
            public_json = "\n".join(
                raw.decode("utf-8")
                for name, raw in _public_files(real_out).items()
                if name.endswith(".json")
            )
            for phrase in phrases:
                self.assertNotIn(phrase, stdout)
                self.assertNotIn(phrase, public_json)
            for name, raw in _public_files(real_out).items():
                if name.endswith((".png", ".pdf")):
                    continue
                text = raw.decode("utf-8")
                for message in messages:
                    self.assertNotIn(message, text, name)
                self.assertNotIn(spec["mutations"][0]["rationale"], text, name)
                self.assertNotIn(spec["mutations"][0]["defectId"], text, name)


if __name__ == "__main__":
    unittest.main()
