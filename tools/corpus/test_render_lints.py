"""Table and figure lint refusals around source rendering."""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import render
from render import RenderError, assemble_case, render_case, render_twin
from source_case import list_bindings, resolve_case

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "rct_minimal"
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


def _sort_key(item):
    return (
        item.get("lint", ""),
        item.get("code", ""),
        item.get("figure", ""),
        item.get("line", 0),
        item.get("env", ""),
        item.get("message", ""),
    )


def _assert_warnings(test, warnings):
    test.assertTrue(warnings)
    test.assertEqual(warnings, sorted(warnings, key=_sort_key))
    test.assertTrue(all(item["severity"] == "WARN" for item in warnings))
    test.assertIsNone(_ABS.search(json.dumps(warnings)))


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
        self.assertIsNone(_ABS.search(json.dumps(result)))


if __name__ == "__main__":
    unittest.main()
