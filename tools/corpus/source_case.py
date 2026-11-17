"""Load, bind, and resolve a falsify.source-case.v1 directory.

Rendering and compiling are outside this module. Tokens use the form
``{{v:ID}}``. An exact token string in figures JSON becomes a float.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

from vendor import load_vendor_module

_EXTRACT = "upstream/skills/section-writing-agent/scripts/extract_metrics.py"
_FILE_KEYS = ("idea", "log", "values", "figures", "references", "tex")
_CHART_TYPES = frozenset({
    "line", "bar", "grouped_bar", "stacked_bar", "radar", "scatter", "heatmap",
})
_ALLOWED_PACKAGES = frozenset({
    "inputenc", "fontenc", "graphicx", "booktabs", "amsmath",
    "amssymb", "geometry", "caption", "array",
})
_BANNED_FIELDS = ("doi", "url", "pmid", "pmcid", "issn", "isbn")
_CASE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
_VALUE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
_OBJECT_ID_RE = re.compile(r"^[A-Z][A-Za-z0-9]{0,15}$")
_REF_KEY_RE = re.compile(r"^[a-z][a-z0-9]{0,47}$")
_TOKEN_RE = re.compile(r"\{\{v:([a-z][a-z0-9_]{0,47})\}\}")
_EXACT_TOKEN_RE = re.compile(r"^\{\{v:([a-z][a-z0-9_]{0,47})\}\}$")
_TABLE_HEADING_RE = re.compile(r"^###\s+Table\s+([A-Z][A-Za-z0-9]{0,15}):\s*(.+?)\s*$")
_SECTION_RE = re.compile(r"\\section\*?\{([^{}]*)\}")
_BEGIN_ABS = re.compile(r"\\begin\{abstract\}")
_END_ABS = re.compile(r"\\end\{abstract\}")
_PACKAGE_RE = re.compile(r"\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}")
_FORBIDDEN_RE = re.compile(
    r"\\(write18|immediate|openout|input|include|href|url|pdfinfo|special)(?![A-Za-z])"
)
_CITE_RE = re.compile(r"\\cite\{([^}]+)\}")
_DIRECTIVE_RE = re.compile(r"\\falsify(table|figure)\{([^}]+)\}")
_RAW_RE = re.compile(r"^##\s+2\.?\s*Raw Numeric Data\s*$", re.M)
_H2_RE = re.compile(r"^##\s+")
_DOC_RE = re.compile(r"\\documentclass(?:\[[^\]]*\])?\{article\}")
_SEP_RE = re.compile(r"\|?\s*[:\-]+\s*(\|\s*[:\-]+\s*)+\|?")
_BANNED_TEXT = re.compile(r"https?://|doi\s*:|10\.\d{4,}/", re.I)


class SourceCaseError(ValueError):
    """Validation failure. ``code`` is one of the contract error codes."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _fail(code: str, message: str) -> None:
    raise SourceCaseError(code, message)


def _relative_inside(rel: str) -> bool:
    if not isinstance(rel, str) or not rel or rel.startswith(("/", "\\")):
        return False
    if len(rel) >= 2 and rel[1] == ":":
        return False
    parts = rel.replace("\\", "/").split("/")
    return not any(part in ("", "..") for part in parts)


def _within(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _case_path(root: Path, rel: str) -> Path:
    if not _relative_inside(rel):
        _fail("path_escape", "file path")
    candidate = root.joinpath(*rel.replace("\\", "/").split("/"))
    if not _within(root, candidate):
        _fail("path_escape", "file path")
    return candidate


def _read_text(path: Path, label: str) -> str:
    if not path.is_file():
        _fail("missing_file", label)
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeError:
        _fail("schema_invalid", "encoding")
    return ""


def _json_object(text: str, schema: str) -> dict:
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        _fail("schema_invalid", "json")
    if not isinstance(data, dict) or data.get("schema") != schema:
        _fail("schema_invalid", schema)
    return data


def _check_manifest(data: dict) -> dict:
    if not _CASE_ID_RE.fullmatch(str(data.get("caseId", ""))):
        _fail("schema_invalid", "caseId")
    if data.get("synthetic") is not True:
        _fail("schema_invalid", "synthetic")
    if data.get("oracleScope") != "P0":
        _fail("schema_invalid", "oracleScope")
    if data.get("documentClass") != "article":
        _fail("schema_invalid", "documentClass")
    if not isinstance(data.get("title"), str) or not isinstance(data.get("domain"), str):
        _fail("schema_invalid", "title")
    files = data.get("files")
    if not isinstance(files, dict) or set(files) != set(_FILE_KEYS):
        _fail("schema_invalid", "files")
    for key in _FILE_KEYS:
        if not isinstance(files[key], str):
            _fail("schema_invalid", "file path")
    return data


def _read_manifest(root: Path) -> dict:
    if not root.exists():
        _fail("missing_file", "case directory")
    if not root.is_dir():
        _fail("schema_invalid", "case directory")
    path = _case_path(root, "case.json")
    return _check_manifest(_json_object(_read_text(path, "case.json"), "falsify.source-case.v1"))


def _read_texts(root: Path, manifest: dict) -> dict:
    texts = {}
    for key in _FILE_KEYS:
        rel = manifest["files"][key]
        texts[rel] = _read_text(_case_path(root, rel), rel)
    return texts


def _check_value(key: str, item) -> None:
    if not _VALUE_ID_RE.fullmatch(key):
        _fail("schema_invalid", "value id")
    if not isinstance(item, dict) or not isinstance(item.get("text"), str):
        _fail("schema_invalid", "value text")
    if "note" in item and not isinstance(item["note"], str):
        _fail("schema_invalid", "value note")


def _parse_values(text: str) -> dict:
    data = _json_object(text, "falsify.source-values.v1")
    values = data.get("values")
    if not isinstance(values, dict):
        _fail("schema_invalid", "values")
    for key, item in values.items():
        _check_value(key, item)
    return values


def _reject_identifier_value(value) -> None:
    if isinstance(value, str) and _BANNED_TEXT.search(value):
        _fail("schema_invalid", "identifier")
    if isinstance(value, list):
        for item in value:
            _reject_identifier_value(item)


def _reject_identifiers(item: dict) -> None:
    for field in _BANNED_FIELDS:
        if field in item:
            _fail("schema_invalid", field)
    for value in item.values():
        _reject_identifier_value(value)


def _check_reference(item, seen: set[str]) -> dict:
    if not isinstance(item, dict):
        _fail("schema_invalid", "reference")
    key = item.get("key")
    if not isinstance(key, str) or not _REF_KEY_RE.fullmatch(key) or key in seen:
        _fail("schema_invalid", "reference key")
    seen.add(key)
    if item.get("synthetic") is not True:
        _fail("schema_invalid", "reference synthetic")
    _reject_identifiers(item)
    authors = item.get("authors")
    if not isinstance(authors, list) or not all(isinstance(author, str) for author in authors):
        _fail("schema_invalid", "authors")
    for field in ("title", "venue"):
        if not isinstance(item.get(field), str):
            _fail("schema_invalid", field)
    if not isinstance(item.get("year"), int) or isinstance(item.get("year"), bool):
        _fail("schema_invalid", "year")
    return {
        "key": key,
        "authors": list(authors),
        "title": item["title"],
        "venue": item["venue"],
        "year": item["year"],
    }


def _parse_references(text: str) -> list[dict]:
    data = _json_object(text, "falsify.source-references.v1")
    refs = data.get("references")
    if not isinstance(refs, list):
        _fail("schema_invalid", "references")
    seen: set[str] = set()
    return [_check_reference(item, seen) for item in refs]


def _check_figure(item, seen: set[str]) -> dict:
    if not isinstance(item, dict):
        _fail("schema_invalid", "figure")
    figure_id = item.get("figureId")
    if not isinstance(figure_id, str) or not _OBJECT_ID_RE.fullmatch(figure_id) or figure_id in seen:
        _fail("schema_invalid", "figure id")
    seen.add(figure_id)
    if not isinstance(item.get("caption"), str):
        _fail("schema_invalid", "caption")
    spec = item.get("spec")
    if not isinstance(spec, dict) or spec.get("type") not in _CHART_TYPES:
        _fail("schema_invalid", "figure spec")
    return {"figureId": figure_id, "caption": item["caption"], "spec": spec}


def _parse_figures(text: str) -> list[dict]:
    data = _json_object(text, "falsify.source-figures.v1")
    figures = data.get("figures")
    if not isinstance(figures, list):
        _fail("schema_invalid", "figures")
    seen: set[str] = set()
    return [_check_figure(item, seen) for item in figures]


def _require_raw_section(text: str) -> None:
    if _RAW_RE.search(text) is None:
        _fail("schema_invalid", "raw numeric data")


def _mark_raw(line: str, in_raw: bool) -> bool:
    if _RAW_RE.match(line):
        return True
    if _H2_RE.match(line):
        return False
    return in_raw


def _table_starts(lines: list[str], index: int) -> bool:
    if index + 1 >= len(lines) or "|" not in lines[index]:
        return False
    return _SEP_RE.fullmatch(lines[index + 1].strip()) is not None


def _table_end(lines: list[str], index: int) -> int:
    cursor = index + 2
    while cursor < len(lines) and "|" in lines[cursor]:
        cursor += 1
    return cursor


def _next_table_index(lines: list[str], index: int):
    while index < len(lines) and lines[index].strip() == "":
        index += 1
    if index < len(lines) and _table_starts(lines, index):
        return index
    return None


def _span_from_heading(lines: list[str], index: int, heading: re.Match) -> tuple[dict, int]:
    if _TOKEN_RE.search(lines[index]):
        _fail("schema_invalid", "token in table heading")
    start = _next_table_index(lines, index + 1)
    if start is None:
        _fail("schema_invalid", "table heading")
    end = _table_end(lines, start)
    span = {
        "tableId": heading.group(1),
        "label": heading.group(2).strip(),
        "linenos": list(range(start + 1, end + 1)),
    }
    return span, end


def _table_spans(lines: list[str]) -> list[dict]:
    spans = []
    in_raw = False
    index = 0
    while index < len(lines):
        in_raw = _mark_raw(lines[index], in_raw)
        heading = _TABLE_HEADING_RE.match(lines[index].strip()) if in_raw else None
        if heading:
            span, index = _span_from_heading(lines, index, heading)
            spans.append(span)
            continue
        index += 1
    return spans


def _vendor_tables(log_text: str) -> list[dict]:
    module = load_vendor_module(_EXTRACT)
    section = module.find_raw_data_section(log_text)
    return module.parse_markdown_tables(section)


def _merge_table(item: dict, span: dict) -> dict:
    if item.get("label") != span["label"]:
        _fail("schema_invalid", "table label")
    if not _OBJECT_ID_RE.fullmatch(span["tableId"]):
        _fail("schema_invalid", "table id")
    return {
        "tableId": span["tableId"],
        "label": span["label"],
        "headers": item["headers"],
        "rows": item["rows"],
    }


def _unique_ids(ids: list[str], label: str) -> None:
    if len(ids) != len(set(ids)):
        _fail("schema_invalid", label)


def _parse_tables(log_text: str) -> list[dict]:
    _require_raw_section(log_text)
    parsed = _vendor_tables(log_text)
    spans = _table_spans(log_text.splitlines())
    if len(parsed) != len(spans):
        _fail("schema_invalid", "table count")
    tables = [_merge_table(item, span) for item, span in zip(parsed, spans)]
    _unique_ids([table["tableId"] for table in tables], "table id")
    return tables


def _slug(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    if not slug:
        _fail("schema_invalid", "section")
    return slug


def _open_tex_state(line: str, surface: str, in_abstract: bool) -> tuple[str, bool]:
    match = _SECTION_RE.search(line)
    if match:
        surface = "tex:" + _slug(match.group(1))
    if _BEGIN_ABS.search(line):
        in_abstract = True
    return surface, in_abstract


def _close_abstract(line: str, in_abstract: bool) -> bool:
    if _END_ABS.search(line):
        return False
    return in_abstract


def _brace_end(line: str, open_index: int) -> int:
    depth = 0
    for index in range(open_index, len(line)):
        char = line[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    return len(line)


def _inside_title(line: str, start: int) -> bool:
    marker = line.find("\\title{")
    if marker < 0 or start < marker:
        return False
    return start < _brace_end(line, marker + len("\\title"))


def _pick_surface(line: str, start: int, surface: str, in_abstract: bool) -> str:
    if _inside_title(line, start):
        return "tex:title"
    if in_abstract:
        return "tex:abstract"
    return surface


def _known_binding(value_id: str, surface: str, path: str, lineno: int, values: dict) -> dict:
    if value_id not in values:
        _fail("unknown_value", value_id)
    return {"valueId": value_id, "surface": surface, "file": path, "line": lineno}


def _tokens_on_line(line: str, path: str, lineno: int, values: dict, surface_for) -> list[dict]:
    found = []
    for match in _TOKEN_RE.finditer(line):
        surface = surface_for(match.start())
        found.append(_known_binding(match.group(1), surface, path, lineno, values))
    return found


def _bindings_for_tex(path: str, text: str, values: dict) -> list[dict]:
    surface = "tex:front"
    in_abstract = False
    found = []
    for lineno, line in enumerate(text.splitlines(), 1):
        surface, in_abstract = _open_tex_state(line, surface, in_abstract)
        found.extend(_tokens_on_line(line, path, lineno, values, _surface_at(line, surface, in_abstract)))
        in_abstract = _close_abstract(line, in_abstract)
    return found


def _surface_at(line: str, surface: str, in_abstract: bool):
    def pick(start: int) -> str:
        return _pick_surface(line, start, surface, in_abstract)
    return pick


def _log_bindings(path: str, text: str, values: dict) -> tuple[list[dict], list[dict]]:
    lines = text.splitlines()
    spans = _table_spans(lines)
    covered = {lineno for span in spans for lineno in span["linenos"]}
    bindings = []
    for span in spans:
        surface = "table:" + span["tableId"]
        for lineno in span["linenos"]:
            bindings.extend(_tokens_on_line(
                lines[lineno - 1], path, lineno, values, lambda _start, surface=surface: surface,
            ))
    _reject_uncovered_tokens(lines, covered)
    order = [{"tableId": span["tableId"], "label": span["label"]} for span in spans]
    return bindings, order


def _reject_uncovered_tokens(lines: list[str], covered: set[int]) -> None:
    for lineno, line in enumerate(lines, 1):
        if lineno in covered:
            continue
        if _TOKEN_RE.search(line):
            _fail("schema_invalid", "token outside table cell")


def _bindings_for_figures(path: str, text: str, values: dict) -> list[dict]:
    current = None
    found = []
    figure_re = re.compile(r'"figureId"\s*:\s*"([A-Z][A-Za-z0-9]{0,15})"')
    for lineno, line in enumerate(text.splitlines(), 1):
        match = figure_re.search(line)
        if match:
            current = match.group(1)
        if current is None and _TOKEN_RE.search(line):
            _fail("schema_invalid", "figure token before figureId")
        surface = f"figure:{current}"
        found.extend(_tokens_on_line(
            line, path, lineno, values, lambda _start, surface=surface: surface,
        ))
    return found


def _check_document(text: str) -> None:
    if _DOC_RE.search(text) is None:
        _fail("schema_invalid", "document class")
    if "\\begin{document}" not in text or "\\end{document}" not in text:
        _fail("schema_invalid", "document body")


def _check_forbidden(text: str) -> None:
    match = _FORBIDDEN_RE.search(text)
    if match:
        _fail("forbidden_tex", match.group(0))


def _check_packages(text: str) -> None:
    for match in _PACKAGE_RE.finditer(text):
        _check_package_list(match.group(1))


def _check_package_list(body: str) -> None:
    for name in body.split(","):
        cleaned = name.strip()
        if cleaned and cleaned not in _ALLOWED_PACKAGES:
            _fail("forbidden_tex", cleaned)


def _check_citations(text: str, references: list[dict]) -> None:
    keys = {item["key"] for item in references}
    for match in _CITE_RE.finditer(text):
        for key in match.group(1).split(","):
            cleaned = key.strip()
            if cleaned not in keys:
                _fail("unknown_citation", cleaned)


def _directive_sets(text: str) -> tuple[set[str], set[str]]:
    tables = set()
    figures = set()
    for match in _DIRECTIVE_RE.finditer(text):
        kind, object_id = match.group(1), match.group(2)
        if kind == "table":
            tables.add(object_id)
        else:
            figures.add(object_id)
    return tables, figures


def _check_bound(ids: set[str], known: set[str]) -> None:
    for object_id in sorted(ids):
        if not _OBJECT_ID_RE.fullmatch(object_id) or object_id not in known:
            _fail("unbound_directive", object_id)


def _parse_tex(text: str, references: list[dict], tables: list[dict], figures: list[dict]) -> dict:
    _check_document(text)
    _check_forbidden(text)
    _check_packages(text)
    _check_citations(text, references)
    table_ids, figure_ids = _directive_sets(text)
    _check_bound(table_ids, {table["tableId"] for table in tables})
    _check_bound(figure_ids, {figure["figureId"] for figure in figures})
    return {"tables": table_ids, "figures": figure_ids}


def _build_warnings(values, tables, figures, bindings, tex_info) -> list[dict]:
    warnings = []
    used = {item["valueId"] for item in bindings}
    for value_id in sorted(values):
        if value_id not in used:
            warnings.append({"code": "unused_value", "valueId": value_id})
    for table in tables:
        if table["tableId"] not in tex_info["tables"]:
            warnings.append({"code": "unreferenced_table", "tableId": table["tableId"]})
    for figure in figures:
        if figure["figureId"] not in tex_info["figures"]:
            warnings.append({"code": "unreferenced_figure", "figureId": figure["figureId"]})
    return warnings


def _all_bindings(files: dict, texts: dict, values: dict, tables: list[dict]) -> list[dict]:
    tex_path = files["tex"]
    log_path = files["log"]
    figure_path = files["figures"]
    bindings = _bindings_for_tex(tex_path, texts[tex_path], values)
    log_bindings, order = _log_bindings(log_path, texts[log_path], values)
    if [item["tableId"] for item in order] != [table["tableId"] for table in tables]:
        _fail("schema_invalid", "table id order")
    bindings.extend(log_bindings)
    bindings.extend(_bindings_for_figures(figure_path, texts[figure_path], values))
    return bindings


def _load_model(case_dir) -> dict:
    root = Path(case_dir)
    manifest = _read_manifest(root)
    texts = _read_texts(root, manifest)
    files = manifest["files"]
    values = _parse_values(texts[files["values"]])
    figures = _parse_figures(texts[files["figures"]])
    references = _parse_references(texts[files["references"]])
    tables = _parse_tables(texts[files["log"]])
    tex_info = _parse_tex(texts[files["tex"]], references, tables, figures)
    bindings = _all_bindings(files, texts, values, tables)
    return {
        "root": root,
        "manifest": manifest,
        "texts": texts,
        "values": values,
        "figures": figures,
        "references": references,
        "tables": tables,
        "bindings": bindings,
        "warnings": _build_warnings(values, tables, figures, bindings, tex_info),
    }


def load_case(case_dir) -> dict:
    """Return the validated manifest, raw file texts, and non-fatal warnings."""
    model = _load_model(case_dir)
    return {
        "manifest": model["manifest"],
        "texts": model["texts"],
        "warnings": model["warnings"],
    }


def list_bindings(case_dir) -> list[dict]:
    """Return every token occurrence sorted by file, line, and value id."""
    model = _load_model(case_dir)
    return sorted(model["bindings"], key=lambda item: (item["file"], item["line"], item["valueId"]))


def _override_fields(item) -> tuple[str, str, object]:
    if not isinstance(item, dict):
        _fail("schema_invalid", "override")
    value_id = item.get("valueId")
    text = item.get("text")
    if not isinstance(value_id, str) or not isinstance(text, str):
        _fail("schema_invalid", "override")
    return value_id, text, item.get("surfaces")


def _target_surfaces(target, bound: set[str]) -> list[str]:
    if target == "*":
        return sorted(bound)
    if isinstance(target, list) and target and all(isinstance(item, str) for item in target):
        return list(target)
    _fail("schema_invalid", "override surfaces")
    return []


def _apply_surface(value_id, surface, text, values, surfaces, resolved, applied, seen) -> None:
    if surface not in surfaces[value_id]:
        _fail("override_unbound", surface)
    key = (value_id, surface)
    if key in seen:
        _fail("override_conflict", surface)
    seen.add(key)
    before = values[value_id]["text"]
    resolved[key] = text
    applied.append({
        "valueId": value_id,
        "surface": surface,
        "before": before,
        "after": text,
    })


def _apply_one(item, values, surfaces, resolved, applied, seen) -> None:
    value_id, text, target = _override_fields(item)
    if value_id not in values or value_id not in surfaces:
        _fail("override_unbound", value_id)
    for surface in _target_surfaces(target, surfaces[value_id]):
        _apply_surface(value_id, surface, text, values, surfaces, resolved, applied, seen)


def _override_map(model: dict, overrides) -> dict:
    values = model["values"]
    surfaces: dict[str, set[str]] = {}
    for binding in model["bindings"]:
        surfaces.setdefault(binding["valueId"], set()).add(binding["surface"])
    resolved = {}
    for value_id, bound in surfaces.items():
        for surface in bound:
            resolved[(value_id, surface)] = values[value_id]["text"]
    applied = []
    seen = set()
    for item in overrides or []:
        _apply_one(item, values, surfaces, resolved, applied, seen)
    return {"values": values, "resolved": resolved, "applied": applied}


def _lookup(mapping: dict, value_id: str, surface: str) -> str:
    if value_id not in mapping["values"]:
        _fail("unknown_value", value_id)
    return mapping["resolved"].get((value_id, surface), mapping["values"][value_id]["text"])


def _reject_marker(text: str, where: str) -> None:
    if "{{v:" in text:
        _fail("token_unresolved", where)


def _replace_tex_line(line: str, surface: str, in_abstract: bool, mapping: dict) -> str:
    def replacer(match: re.Match) -> str:
        chosen = _pick_surface(line, match.start(), surface, in_abstract)
        return _lookup(mapping, match.group(1), chosen)
    return _TOKEN_RE.sub(replacer, line)


def _render_tex(text: str, mapping: dict) -> str:
    surface = "tex:front"
    in_abstract = False
    parts = []
    for line in text.splitlines(keepends=True):
        surface, in_abstract = _open_tex_state(line, surface, in_abstract)
        parts.append(_replace_tex_line(line, surface, in_abstract, mapping))
        in_abstract = _close_abstract(line, in_abstract)
    rendered = "".join(parts)
    _reject_marker(rendered, "tex")
    return rendered


def _subst_cell(cell, surface: str, mapping: dict):
    if not isinstance(cell, str):
        return cell
    rendered = _TOKEN_RE.sub(lambda match: _lookup(mapping, match.group(1), surface), cell)
    _reject_marker(rendered, "table")
    return rendered


def _render_tables(tables: list[dict], mapping: dict) -> list[dict]:
    rendered = []
    for table in tables:
        surface = "table:" + table["tableId"]
        rendered.append({
            "tableId": table["tableId"],
            "label": table["label"],
            "headers": [_subst_cell(cell, surface, mapping) for cell in table["headers"]],
            "rows": [
                [_subst_cell(cell, surface, mapping) for cell in row]
                for row in table["rows"]
            ],
        })
    return rendered


def _as_float(text: str) -> float:
    try:
        return float(text)
    except ValueError:
        _fail("schema_invalid", "figure number")
    return 0.0


def _subst_json_string(text: str, surface: str, mapping: dict):
    exact = _EXACT_TOKEN_RE.fullmatch(text)
    if exact:
        rendered = _lookup(mapping, exact.group(1), surface)
        _reject_marker(rendered, "figure")
        return _as_float(rendered)
    rendered = _TOKEN_RE.sub(lambda match: _lookup(mapping, match.group(1), surface), text)
    _reject_marker(rendered, "figure")
    return rendered


def _subst_spec(node, surface: str, mapping: dict):
    if isinstance(node, dict):
        return {key: _subst_spec(value, surface, mapping) for key, value in node.items()}
    if isinstance(node, list):
        return [_subst_spec(value, surface, mapping) for value in node]
    if isinstance(node, str):
        return _subst_json_string(node, surface, mapping)
    return node


def _render_figures(figures: list[dict], mapping: dict) -> list[dict]:
    rendered = []
    for figure in figures:
        surface = "figure:" + figure["figureId"]
        rendered.append({
            "figureId": figure["figureId"],
            "caption": _subst_json_string(figure["caption"], surface, mapping),
            "spec": _subst_spec(figure["spec"], surface, mapping),
        })
    return rendered


def _resolved_bindings(bindings: list[dict], mapping: dict) -> list[dict]:
    seen = []
    keys = set()
    for binding in bindings:
        key = (binding["valueId"], binding["surface"])
        if key in keys:
            continue
        keys.add(key)
        seen.append({
            "valueId": binding["valueId"],
            "surface": binding["surface"],
            "resolved": _lookup(mapping, binding["valueId"], binding["surface"]),
        })
    return sorted(seen, key=lambda item: (item["surface"], item["valueId"]))


def _file_hash(path: Path) -> str:
    data = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def _cite_override(item: dict) -> tuple:
    cite_key = item.get("citeKey")
    with_key = item.get("withKey")
    surfaces = item.get("surfaces")
    occurrence = item.get("occurrence", 1)
    if not isinstance(cite_key, str) or not isinstance(with_key, str):
        _fail("schema_invalid", "citation override")
    if not isinstance(surfaces, list) or len(surfaces) != 1:
        _fail("schema_invalid", "citation override")
    if not isinstance(surfaces[0], str) or not surfaces[0].startswith("tex:"):
        _fail("schema_invalid", "citation override")
    if type(occurrence) is not int or occurrence < 1:
        _fail("schema_invalid", "citation override")
    return cite_key, with_key, surfaces[0], occurrence


def _split_overrides(overrides):
    values = []
    cites = []
    for item in overrides or []:
        if not isinstance(item, dict):
            _fail("schema_invalid", "override")
        if "citeKey" in item and "valueId" in item:
            _fail("schema_invalid", "override")
        if "citeKey" in item:
            cites.append(_cite_override(item))
            continue
        values.append(item)
    return values, cites


def _group_spans(line: str, offset: int, match, cite_key: str) -> list:
    found = []
    body = match.group(1)
    body_start = match.start(1)
    pos = 0
    for part in body.split(","):
        if part.strip() == cite_key:
            local = part.find(cite_key)
            start = offset + body_start + pos + local
            found.append((start, start + len(cite_key)))
        pos += len(part) + 1
    return found


def _line_spans(line, offset, current, in_abstract, surface, cite_key) -> list:
    found = []
    for match in _CITE_RE.finditer(line):
        chosen = _pick_surface(line, match.start(), current, in_abstract)
        if chosen == surface:
            found.extend(_group_spans(line, offset, match, cite_key))
    return found


def _citation_spans(tex: str, surface: str, cite_key: str) -> list:
    """Return source spans of ``cite_key`` on one tex surface, in reading order."""
    current = "tex:front"
    in_abstract = False
    spans = []
    offset = 0
    for line in tex.splitlines(keepends=True):
        current, in_abstract = _open_tex_state(line, current, in_abstract)
        spans.extend(_line_spans(line, offset, current, in_abstract, surface, cite_key))
        in_abstract = _close_abstract(line, in_abstract)
        offset += len(line)
    return spans


def _citing_surfaces(tex: str, cite_key: str) -> list:
    current = "tex:front"
    in_abstract = False
    found = []
    for line in tex.splitlines(keepends=True):
        current, in_abstract = _open_tex_state(line, current, in_abstract)
        _collect_cite_surfaces(line, current, in_abstract, cite_key, found)
        in_abstract = _close_abstract(line, in_abstract)
    return found


def _collect_cite_surfaces(line, current, in_abstract, cite_key, found) -> None:
    for match in _CITE_RE.finditer(line):
        chosen = _pick_surface(line, match.start(), current, in_abstract)
        keys = [part.strip() for part in match.group(1).split(",")]
        if cite_key in keys and chosen not in found:
            found.append(chosen)


def _bibliography_order(tex: str, references) -> list:
    ordered = []
    seen = set()
    for match in _CITE_RE.finditer(tex):
        for key in match.group(1).split(","):
            cleaned = key.strip()
            if cleaned and cleaned not in seen:
                seen.add(cleaned)
                ordered.append(cleaned)
    for ref in references:
        key = ref.get("key") if isinstance(ref, dict) else None
        if key and key not in seen:
            seen.add(key)
            ordered.append(key)
    return ordered


def _known_cite_keys(references) -> set:
    keys = set()
    for ref in references:
        if isinstance(ref, dict) and isinstance(ref.get("key"), str):
            keys.add(ref["key"])
    return keys


def _require_cite_pool(references, cite_key: str, with_key: str) -> None:
    known = _known_cite_keys(references)
    if cite_key not in known:
        _fail("unknown_citation", cite_key)
    if with_key not in known:
        _fail("unknown_citation", with_key)


def _reject_span_overlap(located) -> None:
    spans = sorted(item[0] for item in located)
    for earlier, later in zip(spans, spans[1:]):
        if earlier[1] > later[0]:
            _fail("override_conflict", "citation")


def _locate_cites(tex, references, cites) -> list:
    located = []
    for cite_key, with_key, surface, occurrence in cites:
        _require_cite_pool(references, cite_key, with_key)
        spans = _citation_spans(tex, surface, cite_key)
        if occurrence > len(spans):
            _fail("override_unbound", surface)
        if cite_key == with_key:
            _fail("schema_invalid", "citation override")
        located.append((spans[occurrence - 1], cite_key, with_key, surface))
    _reject_span_overlap(located)
    return located


def _record_bibliography(applied, located, before, after) -> None:
    previous = ",".join(before)
    current = ",".join(after)
    seen = set()
    for _span, cite_key, _with_key, _surface in located:
        if cite_key in seen:
            continue
        seen.add(cite_key)
        applied.append({
            "valueId": cite_key,
            "surface": "tex:bibliography",
            "before": previous,
            "after": current,
        })


def _apply_cite_overrides(tex: str, references, cites, applied) -> str:
    """Replace citation keys. Value overrides cannot name a cite key."""
    if not cites:
        return tex
    before = _bibliography_order(tex, references)
    located = _locate_cites(tex, references, cites)
    ordered = sorted(located, key=lambda item: item[0][0], reverse=True)
    for (start, end), cite_key, with_key, surface in ordered:
        tex = tex[:start] + with_key + tex[end:]
        applied.append({
            "valueId": cite_key,
            "surface": surface,
            "before": cite_key,
            "after": with_key,
        })
    after = _bibliography_order(tex, references)
    if after != before:
        _record_bibliography(applied, located, before, after)
    return tex


def resolve_case(case_dir, overrides=None) -> dict:
    """Substitute tokens. Overrides may target one surface or ``\"*\"``.

    A citation override (``citeKey``, ``withKey``, one ``tex:`` surface,
    optional ``occurrence``) rewrites one citation key. ``{{v:ID}}`` overrides
    do not name citation keys, and ``render.py`` is unchanged.
    """
    model = _load_model(case_dir)
    value_overrides, cite_overrides = _split_overrides(overrides)
    mapping = _override_map(model, value_overrides)
    files = model["manifest"]["files"]
    tex = _render_tex(model["texts"][files["tex"]], mapping)
    tex = _apply_cite_overrides(tex, model["references"], cite_overrides, mapping["applied"])
    tables = _render_tables(model["tables"], mapping)
    figures = _render_figures(model["figures"], mapping)
    _reject_marker(json.dumps(tables), "table")
    _reject_marker(json.dumps(figures), "figure")
    values_rel = files["values"]
    return {
        "schema": "falsify.source-case-resolved.v1",
        "caseId": model["manifest"]["caseId"],
        "tex": tex,
        "tables": tables,
        "figures": figures,
        "references": model["references"],
        "bindings": _resolved_bindings(model["bindings"], mapping),
        "overridesApplied": mapping["applied"],
        "inputHashes": {values_rel: _file_hash(_case_path(model["root"], values_rel))},
    }


def _dump(data: dict) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def _skeleton_case(case_id: str, domain: str) -> dict:
    return {
        "schema": "falsify.source-case.v1",
        "caseId": case_id,
        "title": "Synthetic skeleton",
        "domain": domain,
        "synthetic": True,
        "oracleScope": "P0",
        "documentClass": "article",
        "files": {
            "idea": "inputs/idea.md",
            "log": "inputs/experimental_log.md",
            "values": "inputs/values.json",
            "figures": "inputs/figures.json",
            "references": "inputs/refs.json",
            "tex": "source/paper.tex",
        },
    }


def _skeleton_values() -> dict:
    return {
        "schema": "falsify.source-values.v1",
        "values": {"n_arm": {"text": "10", "note": "skeleton arm size"}},
    }


def _skeleton_figures() -> dict:
    return {
        "schema": "falsify.source-figures.v1",
        "figures": [{
            "figureId": "F1",
            "caption": "Skeleton arm size.",
            "spec": {
                "type": "bar",
                "aspect_ratio": "4:3",
                "x_labels": ["Arm"],
                "series": [{"name": "Arm", "y": ["{{v:n_arm}}"]}],
            },
        }],
    }


def _skeleton_refs() -> dict:
    return {
        "schema": "falsify.source-references.v1",
        "references": [{
            "key": "skeleton2019",
            "authors": ["Skeleton A"],
            "title": "A fictional methods note",
            "venue": "Journal of Fictional Methods",
            "year": 2019,
            "synthetic": True,
        }],
    }


def _skeleton_log() -> str:
    return "\n".join([
        "# Log",
        "",
        "## 1. Experimental Setup",
        "",
        "Fictional setup for a skeleton case.",
        "",
        "## 2. Raw Numeric Data",
        "",
        "### Table T1: Skeleton arm",
        "",
        "| Arm | n |",
        "| --- | --- |",
        "| FX-217 | {{v:n_arm}} |",
        "",
        "## 3. Observations",
        "",
        "None.",
        "",
    ])


def _skeleton_tex() -> str:
    return "\n".join([
        r"\documentclass{article}",
        r"\usepackage[utf8]{inputenc}",
        r"\usepackage{booktabs}",
        r"\begin{document}",
        r"\title{Synthetic skeleton}",
        r"\maketitle",
        r"\begin{abstract}",
        r"The skeleton arm enrolled {{v:n_arm}} participants \cite{skeleton2019}.",
        r"\end{abstract}",
        r"\section{Results}",
        r"\falsifytable{T1}",
        r"\falsifyfigure{F1}",
        r"\falsifybibliography",
        r"\end{document}",
        "",
    ])


def _skeleton_idea() -> str:
    return "# Skeleton\n\nA fictional placeholder case.\n"


def _skeleton_files(case_id: str, domain: str) -> list[tuple[str, str]]:
    return [
        ("case.json", _dump(_skeleton_case(case_id, domain))),
        ("inputs/idea.md", _skeleton_idea()),
        ("inputs/experimental_log.md", _skeleton_log()),
        ("inputs/values.json", _dump(_skeleton_values())),
        ("inputs/figures.json", _dump(_skeleton_figures())),
        ("inputs/refs.json", _dump(_skeleton_refs())),
        ("source/paper.tex", _skeleton_tex()),
    ]


def _ensure_empty_dir(dest: Path) -> None:
    if dest.exists() and not dest.is_dir():
        _fail("schema_invalid", "destination")
    if dest.exists() and any(dest.iterdir()):
        _fail("schema_invalid", "directory not empty")
    dest.mkdir(parents=True, exist_ok=True)


def init_case(dest_dir, case_id, *, domain="clinical-rct") -> list[str]:
    """Write a minimal valid case. Refuses a destination that already has entries."""
    if not _CASE_ID_RE.fullmatch(case_id):
        _fail("schema_invalid", "caseId")
    if not isinstance(domain, str) or not domain:
        _fail("schema_invalid", "domain")
    dest = Path(dest_dir)
    _ensure_empty_dir(dest)
    created = []
    for rel, content in _skeleton_files(case_id, domain):
        path = dest.joinpath(*rel.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
        created.append(rel)
    return created


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="source_case")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("validate", "bindings", "resolve"):
        command = sub.add_parser(name)
        command.add_argument("case_dir")
        command.add_argument("--overrides")
        command.add_argument("--out")
    return parser


def _read_overrides(path: str | None):
    if path is None:
        return None
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        _fail("schema_invalid", "overrides")
    if not isinstance(data, list):
        _fail("schema_invalid", "overrides")
    return data


def _run(args) -> object:
    if args.command == "validate":
        return load_case(args.case_dir)
    if args.command == "bindings":
        return list_bindings(args.case_dir)
    if args.command == "resolve":
        return resolve_case(args.case_dir, _read_overrides(getattr(args, "overrides", None)))
    _fail("schema_invalid", "command")
    return None


def _write_output(payload, out_path: str | None) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    sys.stdout.write(text)
    if out_path:
        Path(out_path).write_text(text, encoding="utf-8", newline="\n")


def main(argv=None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    try:
        payload = _run(args)
    except SourceCaseError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        if str(exc) == "vendor_unverified":
            print("vendor_unverified", file=sys.stderr)
            return 3
        raise
    _write_output(payload, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
