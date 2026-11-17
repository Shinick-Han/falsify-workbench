"""Turn a mutation spec into a sealed source twin.

``plan_mutations`` is pure. ``build_twin`` renders through ``render_twin``
and writes the blind twin plus the sealed plan and gold ledger.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

import render
from render import RenderError, assemble_case
from source_case import (
    SourceCaseError,
    _close_abstract,
    _open_tex_state,
    list_bindings,
    load_case,
    resolve_case,
)

SCHEMA = "falsify.source-mutation.v1"
PLAN_SCHEMA = "falsify.source-mutation-plan.v1"
LEDGER_SCHEMA = "falsify.red-gold-ledger.v1"
STRENGTHEN_CLAIM = (
    (r"\bwere associated with\b", "caused"),
    (r"\bwas associated with\b", "caused"),
    (r"\bappeared to\b", "did"),
    (r"\bappears to\b", "does"),
    (r"\bsuggests\b", "demonstrates"),
    (r"\bsuggest\b", "demonstrate"),
    (r"\bmight\b", "will"),
    (r"\bmay\b", "will"),
)
REMOVE_HEDGE = (
    (r"\bpossibly\b", ""),
    (r"\bperhaps\b", ""),
    (r"\bin this sample\b", ""),
    (r"\balthough\b[^,]*,\s*", ""),
    (r"\bit is possible that\b", ""),
    (r"\btentatively\b", ""),
    (r"\bseems to\b", ""),
    (r"\bappears to\b", ""),
)
MINIMIZE_LIMITATION = (
    (r"\bare limited by\b", "are unaffected by"),
    (r"\bis limited by\b", "is unaffected by"),
    (r"\bcould not exclude\b", "excludes"),
    (r"\bcannot exclude\b", "excludes"),
    (r"\bshould be interpreted with caution\b", "can be interpreted with confidence"),
    (r"\bprecludes causal inference\b", "supports causal inference"),
    (r"\bremains uncertain\b", "is established"),
    (r"\bunderpowered\b", "adequately powered"),
)
RULES = {
    "strengthen_claim": STRENGTHEN_CLAIM,
    "remove_hedge": REMOVE_HEDGE,
    "minimize_limitation": MINIMIZE_LIMITATION,
}
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
_VALUE_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
_NUMBER_RE = re.compile(r"^-?\d+(\.\d+)?$")
_ABS_RE = re.compile(r"[A-Za-z]:[\\/]|/Users/|/home/")
_COMMAND_RE = re.compile(r"\\[A-Za-z]+")
_FAMILIES = frozenset({"D1", "D2", "D3", "D4", "D5", "D6", "D7", "S1"})
_LEVELS = frozenset({"L1", "L2", "L3", "L4"})
_PHRASE_FAMILIES = frozenset({"S1", "D3"})
_COMMON_KEYS = {
    "defectId", "operator", "valueId", "surfaces", "family", "difficulty", "rationale",
}
_OPERATOR_KEYS = {
    "set_text": {"text"},
    "shift_number": {"delta"},
    "scale_number": {"factor"},
    "transpose_digits": set(),
    "swap_values": {"withValueId"},
    "set_phrase": {"text"},
    "apply_template": {"template"},
}
_SECRET_KEYS = {
    "before", "after", "rationale", "defectId", "operationId", "overridesApplied",
}
_UNESCAPE = (
    ("\\%", "%"),
    ("\\&", "&"),
    ("\\$", "$"),
    ("\\#", "#"),
    ("\\_", "_"),
    ("\\{", "{"),
    ("\\}", "}"),
)


class MutationError(ValueError):
    """Validation or correspondence failure. ``code`` is the contract code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _require_id(value, label: str) -> str:
    if not isinstance(value, str) or _ID_RE.fullmatch(value) is None:
        raise MutationError("schema_invalid", label)
    return value


def _require_value(value, label: str) -> str:
    if not isinstance(value, str) or _VALUE_RE.fullmatch(value) is None:
        raise MutationError("schema_invalid", label)
    return value


def _require_family(value) -> str:
    if value not in _FAMILIES:
        raise MutationError("schema_invalid", "family")
    return value


def _require_level(value) -> str:
    if value not in _LEVELS:
        raise MutationError("schema_invalid", "difficulty")
    return value


def _require_rationale(value) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MutationError("schema_invalid", "rationale")
    return value


def _reject_extra(item: dict, allowed: set[str]) -> None:
    for key in item:
        if key not in allowed:
            raise MutationError("schema_invalid", "field")


def _unique_strings(items) -> None:
    if any(not isinstance(item, str) or not item for item in items):
        raise MutationError("schema_invalid", "surfaces")
    if len(items) != len(set(items)):
        raise MutationError("schema_invalid", "surfaces")


def _require_surfaces_shape(value) -> None:
    if value == "*":
        return
    if not isinstance(value, list) or not value:
        raise MutationError("schema_invalid", "surfaces")
    _unique_strings(value)


def _require_prose(value: str) -> None:
    if not value or len(value) > 240:
        raise MutationError("schema_invalid", "phrase")
    if any(char in value for char in "\\{}"):
        raise MutationError("schema_invalid", "phrase")


def _require_text(value, operator: str) -> str:
    if not isinstance(value, str) or "\n" in value or "\r" in value:
        raise MutationError("schema_invalid", "text")
    if operator == "set_phrase":
        _require_prose(value)
    return value


def _number_arg(value, label: str) -> Decimal:
    if isinstance(value, bool) or isinstance(value, str):
        raise MutationError("schema_invalid", label)
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))
    raise MutationError("schema_invalid", label)


def _require_template(value) -> str:
    if value not in RULES:
        raise MutationError("schema_invalid", "template")
    return value


def _validate_operator_fields(item: dict) -> dict:
    operator = item["operator"]
    if operator in ("set_text", "set_phrase"):
        return {"text": _require_text(item.get("text"), operator)}
    if operator == "shift_number":
        return {"delta": _number_arg(item.get("delta"), "delta")}
    if operator == "scale_number":
        return {"factor": _number_arg(item.get("factor"), "factor")}
    if operator == "swap_values":
        return {"withValueId": _require_value(item.get("withValueId"), "withValueId")}
    if operator == "apply_template":
        return {"template": _require_template(item.get("template"))}
    return {}


def _validate_mutation(item) -> dict:
    if not isinstance(item, dict):
        raise MutationError("schema_invalid", "mutation")
    operator = item.get("operator")
    if operator not in _OPERATOR_KEYS:
        _unknown_operator(operator)
    allowed = _COMMON_KEYS | _OPERATOR_KEYS[operator]
    _reject_extra(item, allowed)
    _require_id(item.get("defectId"), "defectId")
    _require_value(item.get("valueId"), "valueId")
    _require_family(item.get("family"))
    _require_level(item.get("difficulty"))
    _require_rationale(item.get("rationale"))
    _require_surfaces_shape(item.get("surfaces"))
    cleaned = {key: item[key] for key in _COMMON_KEYS}
    cleaned.update(_validate_operator_fields(item))
    return cleaned


def _unknown_operator(operator) -> None:
    if isinstance(operator, str):
        raise MutationError("unknown_operator", operator)
    raise MutationError("schema_invalid", "operator")


def _reject_duplicate_ids(mutations: list[dict]) -> None:
    seen = set()
    for item in mutations:
        defect_id = item["defectId"]
        if defect_id in seen:
            raise MutationError("duplicate_defect", defect_id)
        seen.add(defect_id)


def _validate_spec(data) -> dict:
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        raise MutationError("schema_invalid", "schema")
    _require_id(data.get("caseId"), "caseId")
    _require_id(data.get("mutationSetId"), "mutationSetId")
    mutations = data.get("mutations")
    if not isinstance(mutations, list) or not mutations:
        raise MutationError("schema_invalid", "mutations")
    _reject_extra(data, {"schema", "caseId", "mutationSetId", "mutations"})
    cleaned = [_validate_mutation(item) for item in mutations]
    _reject_duplicate_ids(cleaned)
    return {
        "schema": SCHEMA,
        "caseId": data["caseId"],
        "mutationSetId": data["mutationSetId"],
        "mutations": cleaned,
    }


def load_spec(path) -> dict:
    """Read and validate a mutation spec."""
    try:
        text = Path(path).read_text(encoding="utf-8")
        data = json.loads(text, parse_float=Decimal)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise MutationError("schema_invalid", "spec") from exc
    return _validate_spec(data)


def _known_value(current: dict, value_id: str) -> None:
    if value_id not in current["values"]:
        raise MutationError("unknown_value", value_id)


def _select_surfaces(requested, bound: list[str]) -> list[str]:
    if not bound:
        raise MutationError("surface_unbound", "value")
    if requested == "*":
        return list(bound)
    if not isinstance(requested, list) or not requested:
        raise MutationError("schema_invalid", "surfaces")
    _unique_strings(requested)
    for surface in requested:
        if surface not in bound:
            raise MutationError("surface_unbound", surface)
    return list(requested)


def _shared_surfaces(requested, left_bound: list[str], right_bound: list[str]) -> list[str]:
    if requested == "*":
        shared = [item for item in left_bound if item in right_bound]
        if not shared:
            raise MutationError("surface_unbound", "*")
        return shared
    selected = _select_surfaces(requested, left_bound)
    for surface in selected:
        if surface not in right_bound:
            raise MutationError("surface_unbound", surface)
    return selected


def _places(text: str) -> int:
    if "." not in text:
        return 0
    return len(text.split(".", 1)[1])


def _format_number(value: Decimal, places: int) -> str:
    quantum = Decimal(1).scaleb(-places)
    rounded = value.quantize(quantum, rounding=ROUND_HALF_UP)
    sign = "-" if rounded < 0 else ""
    return sign + f"{abs(rounded):.{places}f}"


def _as_decimal(text: str) -> Decimal:
    if _NUMBER_RE.fullmatch(text) is None:
        raise MutationError("not_numeric", "value")
    return Decimal(text)


def _shift(before: str, delta: Decimal) -> str:
    updated = _as_decimal(before) + delta
    return _format_number(updated, _places(before))


def _scale(before: str, factor: Decimal) -> str:
    updated = _as_decimal(before) * factor
    return _format_number(updated, _places(before))


def _leading_zero(text: str) -> bool:
    body = text[1:] if text.startswith("-") else text
    integer = body.split(".", 1)[0]
    return len(integer) > 1 and integer.startswith("0")


def _swap_digits(chars: list[str], left: int, right: int):
    if chars[left] == chars[right]:
        return None
    swapped = list(chars)
    swapped[left], swapped[right] = swapped[right], swapped[left]
    candidate = "".join(swapped)
    if _leading_zero(candidate):
        return None
    return candidate


def _transpose(text: str) -> str:
    _as_decimal(text)
    chars = list(text)
    indexes = [index for index, char in enumerate(chars) if char.isdigit()]
    for pos in range(len(indexes) - 1):
        candidate = _swap_digits(chars, indexes[pos], indexes[pos + 1])
        if candidate is not None:
            return candidate
    raise MutationError("no_change", "transpose")


def _collapse_phrase(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"\s+([,.;:])", r"\1", cleaned)


def _replace_first(text: str, pattern: str, replacement: str):
    match = re.search(pattern, text, re.IGNORECASE)
    if match is None:
        return None
    raw = text[:match.start()] + replacement + text[match.end():]
    return _collapse_phrase(raw)


def _apply_rules(text: str, rules) -> str:
    for pattern, replacement in rules:
        updated = _replace_first(text, pattern, replacement)
        if updated is not None:
            return updated
    raise MutationError("template_no_match", "template")


def _require_phrase(value_id: str, family: str) -> None:
    if not str(value_id).startswith("ph_"):
        raise MutationError("schema_invalid", "phrase value")
    if family not in _PHRASE_FAMILIES:
        raise MutationError("schema_invalid", "family")


def _after_for_surface(item: dict, before: str) -> str:
    operator = item["operator"]
    if operator in ("set_text", "set_phrase"):
        if operator == "set_phrase":
            _require_phrase(item["valueId"], item["family"])
        return item["text"]
    if operator == "apply_template":
        _require_phrase(item["valueId"], item["family"])
        return _apply_rules(before, RULES[item["template"]])
    if operator == "shift_number":
        return _shift(before, item["delta"])
    if operator == "scale_number":
        return _scale(before, item["factor"])
    if operator == "transpose_digits":
        return _transpose(before)
    raise MutationError("unknown_operator", operator)


def _check_figure(surface: str, text: str) -> None:
    if surface.startswith("figure:") and _NUMBER_RE.fullmatch(text) is None:
        raise MutationError("not_numeric", surface)


def _apply_single(item: dict, current: dict) -> list[tuple]:
    value_id = item["valueId"]
    surfaces = _select_surfaces(item["surfaces"], current["bound"].get(value_id, []))
    changes = []
    for surface in surfaces:
        before = current["cells"][(value_id, surface)]
        after = _after_for_surface(item, before)
        _check_figure(surface, after)
        if before != after:
            changes.append((value_id, surface, after))
    if not changes:
        raise MutationError("no_change", value_id)
    return changes


def _apply_swap(item: dict, current: dict) -> list[tuple]:
    left_id = item["valueId"]
    right_id = item["withValueId"]
    _known_value(current, right_id)
    surfaces = _shared_surfaces(
        item["surfaces"], current["bound"].get(left_id, []), current["bound"].get(right_id, []),
    )
    changes = []
    for surface in surfaces:
        left = current["cells"][(left_id, surface)]
        right = current["cells"][(right_id, surface)]
        _check_figure(surface, left)
        _check_figure(surface, right)
        if left != right:
            changes.append((left_id, surface, right))
            changes.append((right_id, surface, left))
    if not changes:
        raise MutationError("no_change", left_id)
    return changes


def _apply_mutation(item: dict, current: dict, seen: set) -> list[tuple]:
    _known_value(current, item["valueId"])
    if item["operator"] == "swap_values":
        changes = _apply_swap(item, current)
    else:
        changes = _apply_single(item, current)
    _claim_changes(changes, seen)
    return changes


def _claim_changes(changes, seen: set) -> None:
    for value_id, surface, _text in changes:
        key = (value_id, surface)
        if key in seen:
            raise MutationError("conflict", value_id)
        seen.add(key)


def _overrides_from(changes) -> list[dict]:
    grouped = []
    index = {}
    for value_id, surface, text in changes:
        key = (value_id, text)
        slot = index.get(key)
        if slot is None:
            index[key] = len(grouped)
            grouped.append({"valueId": value_id, "text": text, "surfaces": [surface]})
        else:
            grouped[slot]["surfaces"].append(surface)
    return grouped


def _changed_set(changes, value_id: str) -> set[str]:
    return {surface for item_id, surface, _text in changes if item_id == value_id}


def _split_surfaces(bound: list[str], changed: set[str]) -> tuple[list[str], list[str]]:
    kept = [item for item in bound if item in changed]
    rest = [item for item in bound if item not in changed]
    return kept, rest


def _endpoints(changes, value_id: str, cells: dict) -> tuple[str, str]:
    for item_id, surface, text in changes:
        if item_id == value_id:
            return cells[(value_id, surface)], text
    raise MutationError("no_change", value_id)


def _record_defect(item, changes, overrides, defects, current) -> None:
    value_id = item["valueId"]
    before, after = _endpoints(changes, value_id, current["cells"])
    changed, unchanged = _split_surfaces(
        current["bound"].get(value_id, []), _changed_set(changes, value_id),
    )
    start = len(overrides)
    overrides.extend(_overrides_from(changes))
    defects.append({
        "defectId": item["defectId"],
        "overrideIndexes": list(range(start, len(overrides))),
        "before": before,
        "after": after,
        "changedSurfaces": changed,
        "unchangedSurfaces": unchanged,
    })


def _current_map(case_dir) -> dict:
    loaded = load_case(case_dir)
    manifest = loaded["manifest"]
    raw = json.loads(loaded["texts"][manifest["files"]["values"]])
    bound = {}
    for item in list_bindings(case_dir):
        surfaces = bound.setdefault(item["valueId"], [])
        if item["surface"] not in surfaces:
            surfaces.append(item["surface"])
    cells = {}
    for item in resolve_case(case_dir)["bindings"]:
        cells[(item["valueId"], item["surface"])] = item["resolved"]
    return {
        "caseId": manifest["caseId"],
        "values": raw["values"],
        "bound": bound,
        "cells": cells,
    }


def plan_mutations(case_dir, spec) -> dict:
    """Return a sealed mutation plan. Does not write."""
    checked = _validate_spec(spec)
    current = _current_map(case_dir)
    if checked["caseId"] != current["caseId"]:
        raise MutationError("schema_invalid", "caseId")
    overrides = []
    defects = []
    seen = set()
    for item in checked["mutations"]:
        changes = _apply_mutation(item, current, seen)
        _record_defect(item, changes, overrides, defects, current)
    return {
        "schema": PLAN_SCHEMA,
        "caseId": checked["caseId"],
        "mutationSetId": checked["mutationSetId"],
        "overrides": overrides,
        "defects": defects,
    }


def _expand_line(raw, kind, ident, tables, figures, references, tex) -> str:
    if kind == "table":
        return render._format_table(render._find(tables, "tableId", ident))
    if kind == "figure":
        return render._format_figure(render._find(figures, "figureId", ident))
    if kind == "bibliography":
        return render._format_bibliography(render._order_references(tex, references))
    return raw


def _line_tag(surface: str, in_abstract: bool, kind: str, ident: str, raw: str) -> str:
    if kind == "table":
        return "table:" + ident
    if kind == "figure":
        return "figure:" + ident
    if kind == "bibliography":
        return "tex:bibliography"
    if "\\title{" in raw:
        return "tex:title"
    if in_abstract:
        return "tex:abstract"
    return surface


def _walk_body(resolved) -> tuple[list[str], list[str]]:
    tex = render._normalize(str(resolved.get("tex") or ""))
    tables = list(resolved.get("tables") or [])
    figures = list(resolved.get("figures") or [])
    references = list(resolved.get("references") or [])
    lines = []
    tags = []
    surface = "tex:front"
    in_abstract = False
    for raw in render._iter_lines(tex):
        surface, in_abstract = _open_tex_state(raw, surface, in_abstract)
        kind, ident = render._directive(raw)
        block = _expand_line(raw, kind, ident, tables, figures, references, tex)
        tag = _line_tag(surface, in_abstract, kind, ident, raw)
        _append_block(lines, tags, block, tag)
        in_abstract = _close_abstract(raw, in_abstract)
    return lines, tags


def _append_block(lines, tags, block: str, tag: str) -> None:
    for piece in block.splitlines():
        lines.append(piece)
        tags.append(tag)


def _align_tags(body_lines, body_tags, full_lines) -> list:
    tags = []
    index = 0
    total = len(body_lines)
    for line in full_lines:
        if index < total and line == body_lines[index]:
            tags.append(body_tags[index])
            index += 1
        else:
            tags.append(None)
    if index != total:
        raise MutationError("diff_mismatch", "line map")
    return tags


def _read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def _tagged(case_dir, tex_path: Path, overrides) -> tuple[list[str], list]:
    resolved = resolve_case(case_dir, overrides)
    body_lines, body_tags = _walk_body(resolved)
    full_lines = _read_lines(tex_path)
    if full_lines != assemble_case(resolved)["tex"].splitlines():
        raise MutationError("diff_mismatch", "tex")
    return full_lines, _align_tags(body_lines, body_tags, full_lines)


def _diff_indexes(clean_lines, defect_lines) -> list[int]:
    pairs = zip(clean_lines, defect_lines)
    return [index for index, pair in enumerate(pairs) if pair[0] != pair[1]]


def _all_changed(plan: dict) -> set[str]:
    found = set()
    for defect in plan["defects"]:
        found.update(defect["changedSurfaces"])
    return found


def _text_surface(surface: str) -> bool:
    return surface.startswith("tex:") or surface.startswith("table:")


def _require_text_diff(defect: dict, diffs, tags) -> None:
    wanted = [item for item in defect["changedSurfaces"] if _text_surface(item)]
    if not wanted:
        return
    for index in diffs:
        if tags[index] in wanted:
            return
    raise MutationError("diff_mismatch", "text")


def _explain_lines(diffs, tags, plan: dict) -> None:
    changed = _all_changed(plan)
    for index in diffs:
        if tags[index] not in changed:
            raise MutationError("diff_mismatch", "line")
    for defect in plan["defects"]:
        _require_text_diff(defect, diffs, tags)


def _figure_surfaces(plan: dict) -> list[str]:
    found = []
    for defect in plan["defects"]:
        for surface in defect["changedSurfaces"]:
            if surface.startswith("figure:") and surface not in found:
                found.append(surface)
    return found


def _allowed_files(diffs, plan: dict, changed_files) -> set[str]:
    allowed = set()
    if diffs:
        allowed.add("paper.tex")
    for surface in _figure_surfaces(plan):
        allowed.add("figures/" + surface.split(":", 1)[1] + ".png")
    if "paper.pdf" in changed_files and allowed:
        allowed.add("paper.pdf")
    return allowed


def _explain_files(diffs, plan: dict, changed_files) -> None:
    allowed = _allowed_files(diffs, plan, changed_files)
    for path in changed_files:
        if path not in allowed:
            raise MutationError("diff_mismatch", "file")
    for path in allowed:
        if path == "paper.pdf":
            continue
        if path not in changed_files:
            raise MutationError("diff_mismatch", "file")


def _correspond(case_dir, root: Path, plan: dict, twin: dict) -> None:
    clean_lines, clean_tags = _tagged(case_dir, root / "clean" / "paper.tex", None)
    defect_lines, defect_tags = _tagged(case_dir, root / "defect" / "paper.tex", plan["overrides"])
    if len(clean_lines) != len(defect_lines) or clean_tags != defect_tags:
        raise MutationError("diff_mismatch", "lines")
    diffs = _diff_indexes(clean_lines, defect_lines)
    _explain_lines(diffs, defect_tags, plan)
    _explain_files(diffs, plan, twin["changedFiles"])


def _ligatures(text: str) -> str:
    return text.replace("---", "\u2014").replace("--", "\u2013")


def _detex(line: str) -> str:
    text = line
    for old, new in _UNESCAPE:
        text = text.replace(old, new)
    text = text.replace("\\\\", " ")
    text = _COMMAND_RE.sub(" ", text)
    text = text.replace("{", " ").replace("}", " ").replace("$", "")
    return _ligatures(re.sub(r"\s+", " ", text).strip())


def _changed_line(clean_line: str, defect_line: str):
    if clean_line == defect_line:
        return None
    before = _detex(clean_line)
    after = _detex(defect_line)
    if before == after:
        return None
    return before, after


def _is_caption(left: str, right: str) -> bool:
    return "\\caption{" in left or "\\caption{" in right


def _body_contexts(surface, clean_lines, defect_lines, tags) -> list[dict]:
    found = []
    for index, tag in enumerate(tags):
        if tag != surface:
            continue
        pair = _changed_line(clean_lines[index], defect_lines[index])
        if pair is None:
            continue
        found.append({"surface": surface, "before": pair[0], "after": pair[1]})
    return found


def _caption_contexts(surface, clean_lines, defect_lines, tags) -> list[dict]:
    found = []
    for index, tag in enumerate(tags):
        if tag != surface or not _is_caption(clean_lines[index], defect_lines[index]):
            continue
        pair = _changed_line(clean_lines[index], defect_lines[index])
        if pair is None:
            continue
        found.append({"surface": surface, "before": pair[0], "after": pair[1]})
    return found


def _find_table(resolved, table_id: str) -> dict:
    for table in resolved["tables"]:
        if table["tableId"] == table_id:
            return table
    raise MutationError("diff_mismatch", "table")


def _table_rows(table: dict) -> list:
    rows = []
    headers = table.get("headers") or []
    if headers:
        rows.append(headers)
    rows.extend(table.get("rows") or [])
    return rows


def _join_cells(cells) -> str:
    return _ligatures(_collapse(" ".join(str(cell) for cell in cells)))


def _table_contexts(surface: str, clean_resolved, defect_resolved) -> list[dict]:
    table_id = surface.split(":", 1)[1]
    clean_rows = _table_rows(_find_table(clean_resolved, table_id))
    defect_rows = _table_rows(_find_table(defect_resolved, table_id))
    if len(clean_rows) != len(defect_rows):
        raise MutationError("diff_mismatch", "table row")
    found = []
    for clean_row, defect_row in zip(clean_rows, defect_rows):
        before = _join_cells(clean_row)
        after = _join_cells(defect_row)
        if before != after:
            found.append({"surface": surface, "before": before, "after": after})
    return found


def _figure_context(surface: str, defect_plan: dict) -> dict:
    figure_id = surface.split(":", 1)[1]
    return {
        "surface": surface,
        "before": defect_plan["before"],
        "after": defect_plan["after"],
        "figureFile": "figures/" + figure_id + ".png",
    }


def _surface_contexts(surface, defect_plan, clean_resolved, defect_resolved, lines, tags):
    clean_lines, defect_lines = lines
    if surface.startswith("figure:"):
        caption = _caption_contexts(surface, clean_lines, defect_lines, tags)
        return [_figure_context(surface, defect_plan), *caption]
    if surface.startswith("table:"):
        rows = _table_contexts(surface, clean_resolved, defect_resolved)
        return rows + _caption_contexts(surface, clean_lines, defect_lines, tags)
    return _body_contexts(surface, clean_lines, defect_lines, tags)


def _contexts(defect_plan, clean_resolved, defect_resolved, lines, tags) -> list[dict]:
    contexts = []
    for surface in defect_plan["changedSurfaces"]:
        batch = _surface_contexts(
            surface, defect_plan, clean_resolved, defect_resolved, lines, tags,
        )
        if not batch:
            raise MutationError("diff_mismatch", "surface")
        contexts.extend(batch)
    return contexts


def _pymupdf():
    try:
        import pymupdf
    except ImportError:
        return None
    return pymupdf


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _pdf_pages(pdf: Path, compiled: bool):
    if not compiled or not pdf.is_file():
        return None
    module = _pymupdf()
    if module is None:
        return None
    doc = module.open(pdf)
    try:
        return [_collapse(page.get_text()) for page in doc]
    finally:
        doc.close()


def _hint_tokens(needle: str, hint: str) -> list[str]:
    tokens = re.findall(r"[A-Za-z]{4,}|\d+\.\d+", needle)
    if hint and hint not in tokens:
        tokens.append(hint)
    return tokens


def _page_score(page: str, tokens, hint: str) -> int:
    if hint and hint not in page:
        return 0
    score = 0
    for token in tokens:
        if token and token in page:
            score += 1
    if hint and hint in page:
        score += 2
    return score


def _best_page(pages, needle: str, hint: str):
    tokens = _hint_tokens(needle, hint)
    best_index = None
    best_score = 0
    for index, page in enumerate(pages):
        score = _page_score(page, tokens, hint)
        if score > best_score:
            best_index = index
            best_score = score
    return best_index


def _relax_breaks(text: str) -> str:
    return re.sub(r"-\s+", "-", text)


def _page_has(page: str, needle: str) -> bool:
    if needle in page:
        return True
    return _relax_breaks(needle) in _relax_breaks(page)


def _find_page(pages, needle: str, hint: str):
    if len(needle) >= 6:
        for index, page in enumerate(pages):
            if _page_has(page, needle):
                return index
    return _best_page(pages, needle, hint)


def _search_hint(quote: str, after: str) -> str:
    if not after or after == quote or len(after) > 48:
        return ""
    return after


def _locate_text(pdf: Path, needle: str, hint: str, compiled: bool):
    pages = _pdf_pages(pdf, compiled)
    if pages is None:
        return None
    return _find_page(pages, _collapse(needle), hint)


def _caption(resolved, surface: str) -> str:
    figure_id = surface.split(":", 1)[1]
    for figure in resolved.get("figures") or []:
        if figure.get("figureId") == figure_id:
            return str(figure.get("caption") or "")
    return ""


def _first_text(contexts):
    for item in contexts:
        if _text_surface(item["surface"]):
            return item
    return None


def _location(surface: str) -> str:
    if ":" not in surface:
        return surface
    return surface.split(":", 1)[1]


def _text_quote(text_context, defect_plan, root: Path, compiled: bool):
    quote = text_context["after"]
    hint = _search_hint(quote, defect_plan["after"])
    page = _locate_text(root / "defect" / "paper.pdf", quote, hint, compiled)
    return quote, _location(text_context["surface"]), page


def _figure_quote(contexts, defect_plan, defect_resolved, root: Path, compiled: bool):
    surface = contexts[0]["surface"] if contexts else ""
    pages = _pdf_pages(root / "defect" / "paper.pdf", compiled)
    page = None
    if pages is not None and surface:
        page = _find_page(pages, _collapse(_caption(defect_resolved, surface)), "")
    return defect_plan["after"], _location(surface), page


def _quote_location(contexts, defect_plan, defect_resolved, root, compiled):
    text_context = _first_text(contexts)
    if text_context is not None:
        return _text_quote(text_context, defect_plan, root, compiled)
    return _figure_quote(contexts, defect_plan, defect_resolved, root, compiled)


def _kind(value_id: str) -> str:
    if value_id.startswith("ph_"):
        return "source-phrase"
    return "source-value"


def _defect_entry(mutation, defect_plan, clean_resolved, defect_resolved, lines, tags, root, compiled):
    contexts = _contexts(defect_plan, clean_resolved, defect_resolved, lines, tags)
    quote, location, page = _quote_location(
        contexts, defect_plan, defect_resolved, root, compiled,
    )
    return {
        "defectId": mutation["defectId"],
        "operationId": mutation["defectId"],
        "kind": _kind(mutation["valueId"]),
        "pageIndex": page,
        "bbox": None,
        "itemId": None,
        "supplementName": None,
        "before": defect_plan["before"],
        "after": defect_plan["after"],
        "quote": quote,
        "location": location,
        "world": None,
        "family": mutation["family"],
        "difficulty": mutation["difficulty"],
        "rationale": mutation["rationale"],
        "stealthStatus": "not_audited",
        "source": {
            "valueId": mutation["valueId"],
            "operator": mutation["operator"],
            "changedSurfaces": list(defect_plan["changedSurfaces"]),
            "unchangedSurfaces": list(defect_plan["unchangedSurfaces"]),
            "contexts": contexts,
        },
    }


def _hash_pdf(path: Path, compiled: bool):
    if not compiled or not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _ledger(case_dir, root: Path, spec, plan: dict, compiled: bool) -> dict:
    mutations = _validate_spec(spec)["mutations"]
    clean_resolved = resolve_case(case_dir)
    defect_resolved = resolve_case(case_dir, plan["overrides"])
    clean_lines, tags = _tagged(case_dir, root / "clean" / "paper.tex", None)
    defect_lines, _defect_tags = _tagged(case_dir, root / "defect" / "paper.tex", plan["overrides"])
    lines = (clean_lines, defect_lines)
    defects = [
        _defect_entry(
            mutation, defect_plan, clean_resolved, defect_resolved, lines, tags, root, compiled,
        )
        for mutation, defect_plan in zip(mutations, plan["defects"])
    ]
    return {
        "schema": LEDGER_SCHEMA,
        "paperId": plan["caseId"],
        "sourceSha256": _hash_pdf(root / "clean" / "paper.pdf", compiled),
        "blindPdfSha256": _hash_pdf(root / "defect" / "paper.pdf", compiled),
        "stealthPass": None,
        "producer": "source-native",
        "caseId": plan["caseId"],
        "mutationSetId": plan["mutationSetId"],
        "defects": defects,
    }


def _dump(data) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if _ABS_RE.search(text):
        raise MutationError("schema_invalid", "absolute path")
    return text


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_dump(data), encoding="utf-8", newline="\n")


def _assert_public(node) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key in _SECRET_KEYS:
                raise MutationError("diff_mismatch", "blind")
            _assert_public(value)
        return
    if isinstance(node, list):
        for value in node:
            _assert_public(value)


def _redact_side(side: dict) -> dict:
    redacted = {}
    for key, value in side.items():
        if key == "overridesApplied":
            continue
        redacted[key] = value
    redacted["overridesAppliedCount"] = len(side.get("overridesApplied") or [])
    return redacted


def _redact_twin(twin: dict) -> dict:
    redacted = {
        "schema": twin["schema"],
        "caseId": twin["caseId"],
        "clean": _redact_side(twin["clean"]),
        "defect": _redact_side(twin["defect"]),
        "texDiffLines": twin["texDiffLines"],
        "changedFiles": list(twin["changedFiles"]),
        "samePageCount": twin["samePageCount"],
    }
    _assert_public(redacted)
    return redacted


def _remove_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)


def _write_bundle(root: Path, twin: dict, plan: dict, ledger: dict) -> None:
    _write_json(root / "twin.json", _redact_twin(twin))
    sealed = root / "sealed"
    sealed.mkdir()
    try:
        _write_json(sealed / "mutation-plan.json", plan)
        _write_json(sealed / "gold-ledger.json", ledger)
    except Exception:
        _remove_tree(sealed)
        raise


def _summary(plan: dict, twin: dict) -> dict:
    return {
        "caseId": plan["caseId"],
        "mutationSetId": plan["mutationSetId"],
        "compiled": bool(twin["clean"].get("compiled")),
        "texDiffLines": twin["texDiffLines"],
        "changedFiles": list(twin["changedFiles"]),
        "samePageCount": twin["samePageCount"],
        "defectCount": len(plan["defects"]),
        "overrideCount": len(plan["overrides"]),
        "modelCalls": 0,
    }


def build_twin(case_dir, spec, out_dir, *, compile_pdf=True) -> dict:
    """Render the twin and write the section-3 layout. The summary omits before/after text."""
    plan = plan_mutations(case_dir, spec)
    root = Path(out_dir)
    try:
        twin = render.render_twin(case_dir, root, plan["overrides"], compile_pdf=compile_pdf)
        _correspond(case_dir, root, plan, twin)
        ledger = _ledger(case_dir, root, spec, plan, compile_pdf)
        _write_bundle(root, twin, plan, ledger)
    except MutationError:
        _remove_tree(root / "sealed")
        raise
    return _summary(plan, twin)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="source_mutator")
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan")
    plan.add_argument("case")
    plan.add_argument("--spec", required=True)
    build = sub.add_parser("build")
    build.add_argument("case")
    build.add_argument("--spec", required=True)
    build.add_argument("--out", required=True)
    build.add_argument("--no-compile", action="store_true")
    return parser


def _run(args):
    spec = load_spec(args.spec)
    if args.command == "plan":
        return plan_mutations(args.case, spec)
    if args.command == "build":
        return build_twin(args.case, spec, args.out, compile_pdf=not args.no_compile)
    raise MutationError("schema_invalid", "command")


def _status(code) -> int:
    if code is None or code == 0:
        return 0
    try:
        return int(code)
    except (TypeError, ValueError):
        return 2


def _exit_code(exc) -> int:
    if isinstance(exc, MutationError) and exc.code == "diff_mismatch":
        return 3
    if isinstance(exc, RenderError) and exc.code == "compile_timeout":
        return 124
    if isinstance(exc, RenderError):
        return 3
    return 2


def _report(exc) -> None:
    code = getattr(exc, "code", "error")
    print(f"{code}: {exc}", file=sys.stderr)


def _emit(data) -> None:
    sys.stdout.write(_dump(data))


def main(argv=None) -> int:
    """Plan or build a source mutation. JSON on stdout, diagnostics on stderr."""
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return _status(exc.code)
    try:
        _emit(_run(args))
    except (MutationError, SourceCaseError, RenderError) as exc:
        _report(exc)
        return _exit_code(exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
