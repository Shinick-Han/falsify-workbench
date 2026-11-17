"""Tests for deterministic source-case rendering."""

import contextlib
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import render
from render import (
    RenderError,
    assemble_case,
    find_engine,
    render_case,
    render_figures,
    render_twin,
)
from source_case import SourceCaseError, list_bindings, resolve_case

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "rct_minimal"
SCRIPT = Path(__file__).resolve().parent / "render.py"
ROOT = Path(__file__).resolve().parents[2]
_ABS = re.compile(r"[A-Za-z]:[\\/]|/Users/|/home/")
_SPECIALS = set("&%_#$<>±≤≥–")


def _values():
    payload = json.loads((FIXTURE / "inputs" / "values.json").read_text(encoding="utf-8"))
    return payload["values"]


def _references():
    payload = json.loads((FIXTURE / "inputs" / "refs.json").read_text(encoding="utf-8"))
    return payload["references"]


def _cite_order(tex, references):
    seen = []
    for match in re.finditer(r"\\cite\{([^}]+)\}", tex):
        for key in match.group(1).split(","):
            cleaned = key.strip()
            if cleaned and cleaned not in seen:
                seen.append(cleaned)
    known = {item["key"] for item in references}
    ordered = [key for key in seen if key in known]
    for item in references:
        if item["key"] not in ordered:
            ordered.append(item["key"])
    return ordered


def _abstract_bounds(tex):
    lines = tex.splitlines()
    start = next(index for index, line in enumerate(lines) if r"\begin{abstract}" in line)
    end = next(index for index, line in enumerate(lines) if r"\end{abstract}" in line)
    return start, end


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
    (dest / "inputs" / "figures.json").write_text(json.dumps(payload) + "\n", encoding="utf-8", newline="\n")
    tex_path = dest / "source" / "paper.tex"
    lines = [
        line
        for line in tex_path.read_text(encoding="utf-8").splitlines(True)
        if r"\falsifyfigure" not in line
    ]
    tex_path.write_text("".join(lines), encoding="utf-8", newline="\n")
    return dest


def _cli(args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=ROOT,
        check=False,
    )


def _assert_no_absolute(test, text):
    test.assertIsNone(_ABS.search(text), text[-400:])


def _assert_same_bytes(test, left, right):
    if left == right:
        return
    limit = min(len(left), len(right))
    index = next((pos for pos in range(limit) if left[pos] != right[pos]), limit)
    window = slice(max(0, index - 24), index + 48)
    test.fail(
        f"bytes differ at {index} ({len(left)} vs {len(right)}) "
        f"left={left[window]!r} right={right[window]!r}"
    )


class AssemblyTests(unittest.TestCase):
    def test_fixture_assembly_is_byte_identical(self):
        first = assemble_case(resolve_case(FIXTURE))
        second = assemble_case(resolve_case(FIXTURE))
        self.assertEqual(first, second)
        self.assertEqual(first["tex"].encode("utf-8"), second["tex"].encode("utf-8"))

    def test_directives_tables_and_preamble(self):
        resolved = resolve_case(FIXTURE)
        tex = assemble_case(resolved)["tex"]
        self.assertNotIn(r"\falsifytable", tex)
        self.assertNotIn(r"\falsifyfigure", tex)
        self.assertNotIn(r"\falsifybibliography", tex)
        self.assertEqual(tex.count(r"\pdfinfoomitdate=1 \pdftrailerid{} \pdfsuppressptexinfo=-1"), 1)
        self.assertIn(r"\toprule", tex)
        self.assertIn(r"\midrule", tex)
        self.assertIn(r"\bottomrule", tex)
        for table in resolved["tables"]:
            spec = "l" + ("r" * (len(table["headers"]) - 1))
            self.assertIn(r"\begin{tabular}{" + spec + "}", tex)
            self.assertIn(r"\caption{" + table["label"] + "}", tex)
            for row in table["rows"]:
                for cell in row:
                    if "%" in str(cell):
                        self.assertIn(str(cell).replace("%", r"\%"), tex)
        for figure in resolved["figures"]:
            self.assertIn(
                r"\includegraphics[width=0.8\linewidth]{figures/" + figure["figureId"] + ".png}",
                tex,
            )
            if not any(char in figure["caption"] for char in _SPECIALS):
                self.assertIn(r"\caption{" + figure["caption"] + "}", tex)
        self.assertNotIn(r"\caption{Table ", tex)

    def test_bibliography_follows_first_citation(self):
        resolved = resolve_case(FIXTURE)
        tex = assemble_case(resolved)["tex"]
        refs = _references()
        keys = re.findall(r"\\bibitem\{([^}]+)\}", tex)
        self.assertEqual(keys, _cite_order(resolved["tex"], refs))
        first = next(item for item in refs if item["key"] == keys[0])
        authors = ", ".join(first["authors"])
        expected = f"{authors}. {first['title']}. \\emph{{{first['venue']}}}. {first['year']}."
        self.assertIn(expected, tex)

    def test_uncited_references_keep_file_order(self):
        resolved = {
            "tex": (
                "\\documentclass{article}\n\\begin{document}\n"
                "See \\cite{chen2022,hale2018}.\n\\falsifybibliography\n\\end{document}\n"
            ),
            "tables": [],
            "figures": [],
            "references": [
                {"key": "hale2018", "authors": ["Hale M"], "title": "T", "venue": "V", "year": 2018},
                {"key": "brant2021", "authors": ["Brant S"], "title": "T", "venue": "V", "year": 2021},
                {"key": "chen2022", "authors": ["Chen R"], "title": "T", "venue": "V", "year": 2022},
            ],
        }
        tex = assemble_case(resolved)["tex"]
        self.assertEqual(
            re.findall(r"\\bibitem\{([^}]+)\}", tex),
            ["chen2022", "hale2018", "brant2021"],
        )

    def test_cell_escaping(self):
        resolved = {
            "tex": "\\documentclass{article}\n\\begin{document}\n\\falsifytable{T1}\n\\end{document}\n",
            "tables": [{
                "tableId": "T1",
                "label": "Specials",
                "headers": ["Left", "Right"],
                "rows": [["a & b", "100%"], ["x_y", "p < 0.05"], ["# $", "± ≤ ≥ –"]],
            }],
            "figures": [],
            "references": [],
        }
        tex = assemble_case(resolved)["tex"]
        self.assertIn(r"a \& b", tex)
        self.assertIn(r"100\%", tex)
        self.assertIn(r"x\_y", tex)
        self.assertIn(r"\#", tex)
        self.assertIn(r"\$", tex)
        self.assertIn("$<$", tex)
        self.assertIn(r"$\pm$", tex)
        self.assertIn(r"$\leq$", tex)
        self.assertIn(r"$\geq$", tex)
        self.assertIn("--", tex)
        self.assertIn(r"\begin{tabular}{lr}", tex)

    def test_preamble_inserted_once(self):
        resolved = resolve_case(FIXTURE)
        line = "\\pdfinfoomitdate=1 \\pdftrailerid{} \\pdfsuppressptexinfo=-1\n"
        tex_in = resolved["tex"]
        marker = tex_in.find("\\documentclass")
        end = tex_in.find("\n", marker)
        resolved["tex"] = tex_in[: end + 1] + line + tex_in[end + 1 :]
        tex = assemble_case(resolved)["tex"]
        self.assertEqual(tex.count(line.strip()), 1)

    def test_sanity_failure(self):
        with self.assertRaises(RenderError) as caught:
            assemble_case({"tex": "hello {\n", "tables": [], "figures": [], "references": []})
        self.assertEqual(caught.exception.code, "latex_sanity")

    def test_unknown_directive(self):
        resolved = resolve_case(FIXTURE)
        resolved["tex"] += "\\falsifytable{T9}\n"
        with self.assertRaises(RenderError) as caught:
            assemble_case(resolved)
        self.assertEqual(caught.exception.code, "unknown_directive")

    def test_abstract_override_changes_only_abstract_lines(self):
        binding = next(item for item in list_bindings(FIXTURE) if item["surface"] == "tex:abstract")
        before = _values()[binding["valueId"]]["text"]
        after = "QQ" + before
        clean = assemble_case(resolve_case(FIXTURE))["tex"].splitlines()
        dirty = assemble_case(resolve_case(FIXTURE, [{
            "valueId": binding["valueId"],
            "text": after,
            "surfaces": ["tex:abstract"],
        }]))["tex"].splitlines()
        self.assertEqual(len(clean), len(dirty))
        start, end = _abstract_bounds("\n".join(clean))
        changed = [index for index, pair in enumerate(zip(clean, dirty)) if pair[0] != pair[1]]
        self.assertTrue(changed)
        self.assertTrue(all(start < index < end for index in changed))
        self.assertTrue(any(after in line for line in dirty[start:end]))

    def test_refuses_nonempty_output_and_empty_overrides(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            out.mkdir()
            (out / "keep").write_text("x", encoding="utf-8")
            with self.assertRaises(RenderError) as caught:
                render_case(FIXTURE, out, compile_pdf=False)
            self.assertEqual(caught.exception.code, "out_dir_not_empty")
            self.assertTrue((out / "keep").is_file())
            with self.assertRaises(RenderError) as empty:
                render_twin(FIXTURE, Path(tmp) / "twin", [], compile_pdf=False)
            self.assertEqual(empty.exception.code, "no_overrides")
            with self.assertRaises(RenderError) as missing:
                render_twin(FIXTURE, Path(tmp) / "twin2", None, compile_pdf=False)
            self.assertEqual(missing.exception.code, "no_overrides")

    def test_twin_without_compile_diffs_tex_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _figureless(tmp)
            binding = next(item for item in list_bindings(case) if item["surface"] == "tex:abstract")
            before = _values()[binding["valueId"]]["text"]
            result = render_twin(case, Path(tmp) / "out", [{
                "valueId": binding["valueId"],
                "text": "QQ" + before,
                "surfaces": ["tex:abstract"],
            }], compile_pdf=False)
            self.assertEqual(result["schema"], "falsify.source-twin.v1")
            self.assertEqual(result["changedFiles"], ["paper.tex"])
            self.assertGreater(result["texDiffLines"], 0)
            self.assertTrue(result["samePageCount"])
            self.assertFalse(result["clean"]["compiled"])
            self.assertEqual(result["clean"]["modelCalls"], 0)
            self.assertIsNone(result["clean"]["engine"])
            blob = json.dumps(result)
            _assert_no_absolute(self, blob)


class CliTests(unittest.TestCase):
    def test_usage_and_invalid_case(self):
        usage = _cli(["render", "--no-compile"])
        self.assertEqual(usage.returncode, 2)
        with tempfile.TemporaryDirectory() as tmp:
            invalid = _cli(["render", str(Path(tmp) / "missing"), "--out", str(Path(tmp) / "out"), "--no-compile"])
        self.assertEqual(invalid.returncode, 2)
        _assert_no_absolute(self, invalid.stdout + invalid.stderr)

    def test_success_refusal_and_timeout_codes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            case = _figureless(tmp)
            out = root / "out"
            done = _cli(["render", str(case), "--out", str(out), "--no-compile"])
            self.assertEqual(done.returncode, 0, done.stderr)
            payload = json.loads(done.stdout)
            self.assertEqual(payload["schema"], "falsify.source-render.v1")
            self.assertFalse(payload["compiled"])
            self.assertEqual(payload["modelCalls"], 0)
            self.assertEqual([item["path"] for item in payload["files"]], ["paper.tex"])
            _assert_no_absolute(self, done.stdout)
            self.assertTrue((out / "paper.tex").is_file())
            self.assertFalse((out / "paper.pdf").exists())
            overrides = root / "empty.json"
            overrides.write_text("[]\n", encoding="utf-8")
            refused = _cli([
                "twin", str(case), "--out", str(root / "twin"),
                "--overrides", str(overrides), "--no-compile",
            ])
            self.assertEqual(refused.returncode, 3)
            _assert_no_absolute(self, refused.stdout + refused.stderr)
            busy = root / "busy"
            busy.mkdir()
            (busy / "x").write_text("x", encoding="utf-8")
            blocked = _cli(["render", str(case), "--out", str(busy), "--no-compile"])
            self.assertEqual(blocked.returncode, 3)
        with mock.patch.object(render, "render_case", side_effect=RenderError("compile_timeout", "pdflatex")):
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(render.main(["render", "case", "--out", "out"]), 124)

    def test_requirements_pin_is_corpus_only(self):
        text = (SCRIPT.parent / "requirements.txt").read_text(encoding="utf-8")
        self.assertIn("matplotlib==3.11.2", text)
        self.assertIn("corpus tooling only", text)


@unittest.skipUnless(_have_matplotlib(), "matplotlib unavailable")
class FigureTests(unittest.TestCase):
    def test_png_bytes_match_across_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = render_case(FIXTURE, root / "a", compile_pdf=False)
            second = render_case(FIXTURE, root / "b", compile_pdf=False)
            left = (root / "a" / "figures" / "F1.png").read_bytes()
            right = (root / "b" / "figures" / "F1.png").read_bytes()
            _assert_same_bytes(self, left, right)
            entry = next(item for item in first["files"] if item["path"] == "figures/F1.png")
            self.assertEqual(entry["sha256"], hashlib.sha256(left).hexdigest())
            self.assertEqual(first["files"], second["files"])
            self.assertTrue(left.startswith(b"\x89PNG"))

    def test_figure_override_changes_only_that_png(self):
        before = _values()["chg_w8_fx"]["text"]
        after = "0" if before != "0" else "1"
        overrides = [{"valueId": "chg_w8_fx", "text": after, "surfaces": ["figure:F1"]}]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            clean = render_case(FIXTURE, root / "clean", compile_pdf=False)
            dirty = render_case(FIXTURE, root / "dirty", overrides=overrides, compile_pdf=False)
            clean_map = {item["path"]: item["sha256"] for item in clean["files"]}
            dirty_map = {item["path"]: item["sha256"] for item in dirty["files"]}
            changed = [path for path in clean_map if clean_map[path] != dirty_map.get(path)]
            figure_paths = [path for path in clean_map if path.startswith("figures/")]
            changed_figures = [path for path in figure_paths if path in changed]
            self.assertEqual(changed_figures, ["figures/F1.png"])
            self.assertEqual(changed, ["figures/F1.png"])

    def test_unknown_figure_type(self):
        resolved = resolve_case(FIXTURE)
        resolved["figures"][0]["spec"] = dict(resolved["figures"][0]["spec"])
        resolved["figures"][0]["spec"]["type"] = "pie"
        jobs = assemble_case(resolved)["figures"]
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RenderError) as caught:
                render_figures(jobs, Path(tmp) / "figures")
            self.assertEqual(caught.exception.code, "figure_spec")


def _pdf_info(path):
    import pymupdf

    doc = pymupdf.open(path)
    try:
        meta = doc.metadata or {}
        fonts = set()
        chunks = []
        for index in range(doc.page_count):
            page = doc[index]
            chunks.append(page.get_text())
            for font in page.get_fonts():
                fonts.add(font[3])
        return {
            "producer": meta.get("producer"),
            "creator": meta.get("creator"),
            "creationDate": meta.get("creationDate"),
            "fonts": fonts,
            "text": "".join(chunks),
            "pages": doc.page_count,
        }
    finally:
        doc.close()


def _norm_text(text):
    return re.sub(r"\s+", " ", text).strip()


def _swap_digits(text):
    chars = []
    changed = False
    for char in text:
        if not char.isdigit():
            chars.append(char)
            continue
        changed = True
        chars.append("8" if char == "9" else "9")
    if not changed:
        return None
    return "".join(chars)


def _text_override():
    """Same-width digit swap on a value that is not drawn in a figure."""
    tex = resolve_case(FIXTURE)["tex"]
    surfaces = {}
    for item in list_bindings(FIXTURE):
        surfaces.setdefault(item["valueId"], set()).add(item["surface"])
    values = _values()
    for value_id, item in values.items():
        text = item["text"]
        found = surfaces.get(value_id, set())
        if not text or text not in tex or any(name.startswith("figure:") for name in found):
            continue
        nested = any(value_id != other_id and text in other["text"] for other_id, other in values.items())
        candidate = None if nested else _swap_digits(text)
        if candidate and candidate not in tex:
            return value_id, text, candidate
    raise AssertionError("no same-width override")


@unittest.skipUnless(find_engine(), "pdflatex unavailable")
class PdfTests(unittest.TestCase):
    def test_fixture_pdf_is_byte_identical_across_directories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first_dir = root / "one"
            second_dir = root / "two"
            first = render_case(FIXTURE, first_dir)
            second = render_case(FIXTURE, second_dir)
            self.assertTrue(first["compiled"])
            self.assertGreaterEqual(first["pageCount"], 1)
            self.assertEqual(first["pageCount"], second["pageCount"])
            self.assertEqual(first["engine"]["name"], "pdflatex")
            self.assertIsInstance(first["engine"]["miktex"], bool)
            self.assertTrue(first["engine"]["version"])
            _assert_no_absolute(self, json.dumps(first))
            self.assertEqual(first["modelCalls"], 0)
            pdf = next(item for item in first["files"] if item["path"] == "paper.pdf")
            left = (first_dir / "paper.pdf").read_bytes()
            right = (second_dir / "paper.pdf").read_bytes()
            self.assertEqual(hashlib.sha256(left).hexdigest(), pdf["sha256"])
            _assert_same_bytes(self, left, right)
            for name in ("paper.aux", "paper.log", "paper.out"):
                self.assertFalse((first_dir / name).exists())
            info = _pdf_info(first_dir / "paper.pdf")
            self.assertEqual(info["pages"], first["pageCount"])
            self.assertTrue(info["fonts"])

    def test_twin_pdf_text_metadata_and_fonts(self):
        value_id, before, after = _text_override()
        with tempfile.TemporaryDirectory() as tmp:
            result = render_twin(FIXTURE, Path(tmp) / "twin", [{
                "valueId": value_id,
                "text": after,
                "surfaces": "*",
            }])
            self.assertTrue(result["samePageCount"])
            self.assertGreaterEqual(result["clean"]["pageCount"], 1)
            clean_pdf = Path(tmp) / "twin" / "clean" / "paper.pdf"
            defect_pdf = Path(tmp) / "twin" / "defect" / "paper.pdf"
            clean = _pdf_info(clean_pdf)
            defect = _pdf_info(defect_pdf)
            self.assertEqual(clean["pages"], defect["pages"])
            self.assertEqual(clean["producer"], defect["producer"])
            self.assertEqual(clean["creator"], defect["creator"])
            self.assertEqual(clean["creationDate"], defect["creationDate"])
            self.assertEqual(clean["fonts"], defect["fonts"])
            self.assertTrue(clean["fonts"])
            self.assertIn(after, defect["text"])
            self.assertEqual(_norm_text(defect["text"]).replace(after, before), _norm_text(clean["text"]))

    def test_forbidden_tex_never_reaches_engine(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _copy_case(tmp)
            tex_path = case / "source" / "paper.tex"
            text = tex_path.read_text(encoding="utf-8")
            needle = "\\begin{document}\n"
            self.assertIn(needle, text)
            tex_path.write_text(text.replace(needle, needle + "\\input{secret}\n", 1), encoding="utf-8", newline="\n")
            with mock.patch.object(render, "find_engine", side_effect=AssertionError("engine")), \
                 mock.patch.object(render, "compile_tex", side_effect=AssertionError("compile")):
                with self.assertRaises(SourceCaseError) as caught:
                    render_case(case, Path(tmp) / "out", compile_pdf=True)
            self.assertEqual(caught.exception.code, "forbidden_tex")
