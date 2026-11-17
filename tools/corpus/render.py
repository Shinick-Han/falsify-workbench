"""Typeset a resolved source case into deterministic TeX, figures, and PDF.

``assemble_case`` is pure. Figure drawing reuses the vendored matplotlib
helper. Compilation, when requested, shells out to ``pdflatex`` with a fixed
argument list and source-date environment.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from source_case import SourceCaseError, resolve_case
from vendor import load_vendor_module

SCHEMA = "falsify.source-render.v1"
TWIN_SCHEMA = "falsify.source-twin.v1"
_DETERMINISM = r"\pdfinfoomitdate=1 \pdftrailerid{} \pdfsuppressptexinfo=-1"
_SANITY = "upstream/skills/section-writing-agent/scripts/latex_sanity.py"
_PLOTTER = "upstream/skills/plotting-agent/scripts/render_matplotlib.py"
_AUX = (".aux", ".log", ".out")
_DRIVE = re.compile(r"[A-Za-z]:[\\/]")
_CITE_RE = re.compile(r"\\cite\{([^}]+)\}")
_TABLE_LINE = re.compile(r"\\falsifytable\{([^}]+)\}")
_FIGURE_LINE = re.compile(r"\\falsifyfigure\{([^}]+)\}")
_BIB_LINE = re.compile(r"\\falsifybibliography")
_PAGE_RE = re.compile(br"/Type\s*/Page(?!s)")
_ESCAPES = (
    ("&", r"\&"),
    ("%", r"\%"),
    ("$", r"\$"),
    ("#", r"\#"),
    ("_", r"\_"),
    ("<", "$<$"),
    (">", "$>$"),
    ("±", r"$\pm$"),
    ("≤", r"$\leq$"),
    ("≥", r"$\geq$"),
    ("–", "--"),
)


class RenderError(ValueError):
    """Refusal while assembling, drawing, or compiling. ``code`` is stable."""

    def __init__(self, code: str, details=""):
        self.code = code
        self.details = details
        text = details if isinstance(details, str) else json.dumps(details, ensure_ascii=False)
        super().__init__(text)


def _escape_text(value) -> str:
    text = str(value)
    for old, new in _ESCAPES:
        text = text.replace(old, new)
    return text


def _align(count: int) -> str:
    if count <= 1:
        return "l"
    return "l" + ("r" * (count - 1))


def _width(table: dict) -> int:
    width = len(table.get("headers") or [])
    for row in table.get("rows") or []:
        if len(row) > width:
            width = len(row)
    return width


def _cells(cells, width: int) -> str:
    padded = list(cells) + [""] * max(0, width - len(list(cells)))
    shown = padded[:width]
    return " & ".join(_escape_text(cell) for cell in shown) + r" \\"


def _format_table(table: dict) -> str:
    width = _width(table)
    lines = [
        r"\begin{table}",
        r"\centering",
        r"\caption{" + _escape_text(table.get("label", "")) + "}",
        r"\begin{tabular}{" + _align(width) + "}",
        r"\toprule",
        _cells(table.get("headers") or [], width),
        r"\midrule",
    ]
    for row in table.get("rows") or []:
        lines.append(_cells(row, width))
    lines.extend([r"\bottomrule", r"\end{tabular}", r"\end{table}"])
    return "\n".join(lines) + "\n"


def _format_figure(figure: dict) -> str:
    figure_id = str(figure["figureId"])
    lines = [
        r"\begin{figure}",
        r"\centering",
        r"\includegraphics[width=0.8\linewidth]{figures/" + figure_id + ".png}",
        r"\caption{" + _escape_text(figure.get("caption", "")) + "}",
        r"\end{figure}",
    ]
    return "\n".join(lines) + "\n"


def _authors(authors) -> str:
    return ", ".join(_escape_text(author) for author in authors)


def _bib_item(ref: dict) -> str:
    body = (
        _authors(ref.get("authors") or [])
        + ". "
        + _escape_text(ref.get("title", ""))
        + r". \emph{"
        + _escape_text(ref.get("venue", ""))
        + "}. "
        + str(ref.get("year", ""))
        + "."
    )
    return r"\bibitem{" + str(ref.get("key", "")) + "} " + body


def _format_bibliography(references) -> str:
    lines = [r"\begin{thebibliography}{99}"]
    for ref in references:
        lines.append(_bib_item(ref))
    lines.append(r"\end{thebibliography}")
    return "\n".join(lines) + "\n"


def _remember(key: str, seen: set[str], ordered: list[str]) -> None:
    if key and key not in seen:
        seen.add(key)
        ordered.append(key)


def _cited_keys(tex: str) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for match in _CITE_RE.finditer(tex):
        for key in match.group(1).split(","):
            _remember(key.strip(), seen, ordered)
    return ordered


def _take_cited(tex: str, by_key: dict) -> tuple[list, set[str]]:
    ordered = []
    seen: set[str] = set()
    for key in _cited_keys(tex):
        ref = by_key.get(key)
        if ref is not None and key not in seen:
            seen.add(key)
            ordered.append(ref)
    return ordered, seen


def _order_references(tex: str, references) -> list:
    by_key = {ref["key"]: ref for ref in references}
    ordered, seen = _take_cited(tex, by_key)
    for ref in references:
        if ref["key"] not in seen:
            ordered.append(ref)
            seen.add(ref["key"])
    return ordered


def _directive(line: str) -> tuple[str, str]:
    stripped = line.strip()
    table = _TABLE_LINE.fullmatch(stripped)
    if table:
        return "table", table.group(1)
    figure = _FIGURE_LINE.fullmatch(stripped)
    if figure:
        return "figure", figure.group(1)
    if _BIB_LINE.fullmatch(stripped):
        return "bibliography", ""
    return "", ""


def _find(items, field: str, ident: str) -> dict:
    for item in items:
        if item.get(field) == ident:
            return item
    raise RenderError("unknown_directive", ident)


def _replace_line(line: str, tables, figures, references, source: str) -> str:
    kind, ident = _directive(line)
    if kind == "table":
        return _format_table(_find(tables, "tableId", ident))
    if kind == "figure":
        return _format_figure(_find(figures, "figureId", ident))
    if kind == "bibliography":
        return _format_bibliography(_order_references(source, references))
    return line


def _normalize(tex: str) -> str:
    return tex.replace("\r\n", "\n").replace("\r", "\n")


def _iter_lines(tex: str) -> list[str]:
    if not tex:
        return []
    parts = tex.split("\n")
    if tex.endswith("\n"):
        parts = parts[:-1]
    return [part + "\n" for part in parts]


def _insert_preamble(tex: str) -> str:
    if _DETERMINISM in tex:
        return tex
    match = re.search(r"^\\documentclass[^\n]*\n", tex, re.M)
    if match is None:
        return _DETERMINISM + "\n" + tex
    return tex[: match.end()] + _DETERMINISM + "\n" + tex[match.end() :]


def _require_sane(tex: str) -> None:
    module = load_vendor_module(_SANITY)
    findings = []
    findings.extend(module.check_documentclass(tex))
    findings.extend(module.check_braces(tex))
    findings.extend(module.check_environments(tex))
    findings.extend(module.check_duplicate_labels(tex))
    if findings:
        raise RenderError("latex_sanity", findings)


def _figure_jobs(figures) -> list[dict]:
    jobs = []
    for figure in figures:
        figure_id = str(figure["figureId"])
        jobs.append({
            "figureId": figure_id,
            "fileName": figure_id + ".png",
            "spec": figure["spec"],
        })
    return jobs


def assemble_case(resolved) -> dict:
    """Replace source directives and return TeX plus figure jobs."""
    tex = _normalize(str(resolved.get("tex") or ""))
    tables = list(resolved.get("tables") or [])
    figures = list(resolved.get("figures") or [])
    references = list(resolved.get("references") or [])
    body = "".join(
        _replace_line(line, tables, figures, references, tex) for line in _iter_lines(tex)
    )
    assembled = _insert_preamble(body)
    _require_sane(assembled)
    return {"tex": assembled, "figures": _figure_jobs(figures)}


def _load_plotter():
    try:
        return load_vendor_module(_PLOTTER)
    except ImportError as exc:
        raise RenderError("figure_engine_unavailable", "matplotlib") from exc


def _force_font(module) -> None:
    module.plt.rcParams["font.family"] = "serif"
    module.plt.rcParams["font.serif"] = ["DejaVu Serif"]


def _chart(spec):
    if not isinstance(spec, dict):
        raise RenderError("figure_spec", "spec")
    return spec.get("type")


def _make_axes(module, spec):
    try:
        return module.make_axes(spec)
    except (SystemExit, Exception) as exc:
        raise RenderError("figure_spec", "axes") from exc


def _paint(renderer, ax, spec) -> None:
    try:
        renderer(ax, spec)
    except (SystemExit, Exception) as exc:
        raise RenderError("figure_spec", "draw") from exc


def _finish_axes(ax, spec, chart) -> None:
    title = spec.get("title")
    if title:
        ax.set_title(title)
    if chart != "radar":
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)


def _save_figure(fig, dest: Path) -> None:
    try:
        fig.tight_layout()
        fig.savefig(dest, metadata={"Software": None})
    except (SystemExit, Exception) as exc:
        raise RenderError("figure_spec", "save") from exc


def _draw(module, spec, dest: Path) -> None:
    chart = _chart(spec)
    renderer = module.RENDERERS.get(chart)
    if renderer is None:
        raise RenderError("figure_spec", "type")
    fig, ax = _make_axes(module, spec)
    try:
        _paint(renderer, ax, spec)
        _finish_axes(ax, spec, chart)
        _save_figure(fig, dest)
    finally:
        module.plt.close(fig)


def _figure_dest(out_dir: Path, file_name) -> Path:
    if not isinstance(file_name, str) or not file_name or file_name != Path(file_name).name:
        raise RenderError("figure_spec", "fileName")
    return out_dir / file_name


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _render_one(module, item, out_dir: Path) -> dict:
    file_name = item.get("fileName")
    dest = _figure_dest(out_dir, file_name)
    _draw(module, item.get("spec"), dest)
    return {"figureId": item.get("figureId"), "fileName": file_name, "sha256": _sha256_file(dest)}


def render_figures(figures, out_dir) -> list[dict]:
    """Draw each figure to ``out_dir`` and return content hashes."""
    if not figures:
        return []
    module = _load_plotter()
    _force_font(module)
    dest_root = Path(out_dir)
    dest_root.mkdir(parents=True, exist_ok=True)
    return [_render_one(module, item, dest_root) for item in figures]


def _first_line(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def _version_process():
    try:
        return subprocess.run(
            ["pdflatex", "--version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def find_engine():
    """Return the pdflatex identity, or None when it is not on PATH."""
    if shutil.which("pdflatex") is None:
        return None
    proc = _version_process()
    if proc is None:
        return None
    line = _first_line((proc.stdout or b"").decode("utf-8", "replace"))
    if not line:
        return None
    return {"name": "pdflatex", "miktex": "miktex" in line.lower(), "version": line}


def _argv(engine) -> list[str]:
    argv = [
        "pdflatex",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-no-shell-escape",
        "-output-directory=.",
    ]
    if engine.get("miktex"):
        argv.append("-disable-installer")
    argv.append("paper.tex")
    return argv


def _tex_env() -> dict:
    env = os.environ.copy()
    env["SOURCE_DATE_EPOCH"] = "0"
    env["FORCE_SOURCE_DATE"] = "1"
    env.pop("TEXMFOUTPUT", None)
    env["openin_any"] = "p"
    env["openout_any"] = "p"
    return env


def _remaining(started: float, timeout: float) -> float:
    left = timeout - (time.monotonic() - started)
    if left <= 0:
        raise RenderError("compile_timeout", "pdflatex")
    return left


def _path_variants(work_dir: Path) -> list[str]:
    found = []
    try:
        resolved = work_dir.resolve()
    except OSError:
        resolved = work_dir
    for item in (work_dir, resolved):
        raw = str(item)
        found.extend((raw, raw.replace("\\", "/"), raw.replace("/", "\\")))
    unique = []
    for item in found:
        if item and item not in unique:
            unique.append(item)
    unique.sort(key=len, reverse=True)
    return unique


def _redact(text: str, work_dir: Path) -> str:
    for variant in _path_variants(work_dir):
        text = text.replace(variant, ".")
    return text


def _captured_text(proc) -> str:
    out = (proc.stdout or b"").decode("utf-8", "replace")
    err = (proc.stderr or b"").decode("utf-8", "replace")
    return out + "\n" + err


def _failure_tail(dest: Path, proc) -> str:
    log_path = dest / "paper.log"
    if log_path.is_file():
        text = log_path.read_text(encoding="utf-8", errors="replace")
    else:
        text = _captured_text(proc)
    lines = _redact(text, dest).splitlines()
    return "\n".join(lines[-30:])


def _run_pass(dest: Path, engine, timeout: float) -> None:
    try:
        proc = subprocess.run(
            _argv(engine),
            cwd=dest,
            env=_tex_env(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RenderError("compile_timeout", "pdflatex") from exc
    if proc.returncode != 0:
        raise RenderError("compile_failed", _failure_tail(dest, proc))


def _cleanup_aux(dest: Path) -> None:
    for suffix in _AUX:
        path = dest / ("paper" + suffix)
        if path.is_file():
            path.unlink()


def compile_tex(work_dir, *, timeout=120) -> dict:
    """Run pdflatex twice. Remove aux, log, and out files after success."""
    dest = Path(work_dir)
    engine = find_engine()
    if engine is None:
        raise RenderError("engine_unavailable", "pdflatex")
    started = time.monotonic()
    _run_pass(dest, engine, _remaining(started, timeout))
    _run_pass(dest, engine, _remaining(started, timeout))
    if not (dest / "paper.pdf").is_file():
        raise RenderError("compile_failed", "missing pdf")
    _cleanup_aux(dest)
    return {"engine": engine, "pdf": "paper.pdf"}


def _page_count(data: bytes) -> int:
    return len(_PAGE_RE.findall(data))


def _prepare_out(out_dir) -> Path:
    dest = Path(out_dir)
    if dest.exists() and not dest.is_dir():
        raise RenderError("out_dir_not_empty", "not a directory")
    if dest.exists() and any(dest.iterdir()):
        raise RenderError("out_dir_not_empty", "directory not empty")
    dest.mkdir(parents=True, exist_ok=True)
    return dest


def _write_tex(dest: Path, tex: str) -> None:
    (dest / "paper.tex").write_text(tex, encoding="utf-8", newline="\n")


def _entry(dest: Path, rel: str) -> dict:
    return {"path": rel, "sha256": _sha256_file(dest.joinpath(*rel.split("/")))}


def _finish_compile(dest: Path, compile_pdf: bool):
    if not compile_pdf:
        return None
    result = compile_tex(dest)
    return {
        "engine": result["engine"],
        "pageCount": _page_count((dest / "paper.pdf").read_bytes()),
    }


def _payload(resolved, dest: Path, figures, compiled) -> dict:
    files = [_entry(dest, "paper.tex")]
    for item in figures:
        files.append(_entry(dest, "figures/" + item["fileName"]))
    engine = None
    page_count = None
    did_compile = False
    if compiled is not None:
        did_compile = True
        engine = compiled["engine"]
        page_count = compiled["pageCount"]
        files.append(_entry(dest, "paper.pdf"))
    return {
        "schema": SCHEMA,
        "caseId": resolved["caseId"],
        "compiled": did_compile,
        "engine": engine,
        "overridesApplied": list(resolved.get("overridesApplied") or []),
        "files": files,
        "pageCount": page_count,
        "modelCalls": 0,
    }


def render_case(case_dir, out_dir, *, overrides=None, compile_pdf=True) -> dict:
    """Write ``paper.tex``, figures, and, when requested, ``paper.pdf``."""
    resolved = resolve_case(case_dir, overrides)
    assembled = assemble_case(resolved)
    dest = _prepare_out(out_dir)
    _write_tex(dest, assembled["tex"])
    figures = render_figures(assembled["figures"], dest / "figures")
    compiled = _finish_compile(dest, compile_pdf)
    return _payload(resolved, dest, figures, compiled)


def _diff_count(left: str, right: str) -> int:
    a = left.splitlines()
    b = right.splitlines()
    count = 0
    for index in range(max(len(a), len(b))):
        aval = a[index] if index < len(a) else None
        bval = b[index] if index < len(b) else None
        if aval != bval:
            count += 1
    return count


def _changed_files(clean: dict, defect: dict) -> list[str]:
    clean_map = {item["path"]: item["sha256"] for item in clean["files"]}
    defect_map = {item["path"]: item["sha256"] for item in defect["files"]}
    paths = list(clean_map)
    for path in defect_map:
        if path not in clean_map:
            paths.append(path)
    return [path for path in paths if clean_map.get(path) != defect_map.get(path)]


def _twin_payload(root: Path, clean: dict, defect: dict) -> dict:
    clean_tex = (root / "clean" / "paper.tex").read_text(encoding="utf-8")
    defect_tex = (root / "defect" / "paper.tex").read_text(encoding="utf-8")
    return {
        "schema": TWIN_SCHEMA,
        "caseId": clean["caseId"],
        "clean": clean,
        "defect": defect,
        "texDiffLines": _diff_count(clean_tex, defect_tex),
        "changedFiles": _changed_files(clean, defect),
        "samePageCount": clean["pageCount"] == defect["pageCount"],
    }


def render_twin(case_dir, out_dir, overrides, *, compile_pdf=True) -> dict:
    """Render a clean twin and a defect twin that applies ``overrides``."""
    if not overrides:
        raise RenderError("no_overrides", "empty")
    root = _prepare_out(out_dir)
    clean = render_case(case_dir, root / "clean", overrides=None, compile_pdf=compile_pdf)
    defect = render_case(case_dir, root / "defect", overrides=overrides, compile_pdf=compile_pdf)
    return _twin_payload(root, clean, defect)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="render")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("render", "twin"):
        command = sub.add_parser(name)
        command.add_argument("case_dir")
        command.add_argument("--out", required=True)
        command.add_argument("--overrides", required=(name == "twin"))
        command.add_argument("--no-compile", action="store_true")
    return parser


def _read_overrides(path):
    if path is None:
        return None
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SourceCaseError("schema_invalid", "overrides") from exc
    if not isinstance(data, list):
        raise SourceCaseError("schema_invalid", "overrides")
    return data


def _dispatch(args):
    overrides = _read_overrides(args.overrides)
    compile_pdf = not args.no_compile
    if args.command == "twin":
        return render_twin(args.case_dir, args.out, overrides or [], compile_pdf=compile_pdf)
    if args.command == "render":
        return render_case(args.case_dir, args.out, overrides=overrides, compile_pdf=compile_pdf)
    raise SourceCaseError("schema_invalid", "command")


def _is_absolute(value: str) -> bool:
    if value.startswith(("/", "\\")):
        return True
    return len(value) >= 2 and value[1] == ":"


def _reject_absolute(node) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            _reject_child(key, value)
        return
    if isinstance(node, list):
        for item in node:
            _reject_absolute(item)


def _reject_child(key, value) -> None:
    if key in {"path", "version"} and isinstance(value, str) and _is_absolute(value):
        raise RenderError("absolute_path", key)
    _reject_absolute(value)


def _emit(payload) -> None:
    _reject_absolute(payload)
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if _DRIVE.search(text):
        raise RenderError("absolute_path", "json")
    sys.stdout.write(text)


def _detail(exc) -> str:
    if isinstance(exc, RenderError) and not isinstance(exc.details, str):
        return json.dumps(exc.details, ensure_ascii=False)
    return str(exc)


def _report_error(exc) -> None:
    print(f"{exc.code}: {_detail(exc)}", file=sys.stderr)


def _status_code(code) -> int:
    if code is None or code == 0:
        return 0
    try:
        return int(code)
    except (TypeError, ValueError):
        return 2


def _failure_code(exc) -> int:
    if isinstance(exc, SourceCaseError):
        return 2
    if isinstance(exc, RenderError) and exc.code == "compile_timeout":
        return 124
    return 3


def main(argv=None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return _status_code(exc.code)
    try:
        _emit(_dispatch(args))
    except (SourceCaseError, RenderError) as exc:
        _report_error(exc)
        return _failure_code(exc)
    except ValueError as exc:
        if str(exc) == "vendor_unverified":
            print("vendor_unverified", file=sys.stderr)
            return 3
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
