"""Decide whether a clean/defect source twin may become a benchmark bundle.

The gate reads a build directory and its source case, runs the Layer 0 sensor
and the existing blind/stealth checks, and writes a bundle only when every
check passes. Refusals are report entries. Invalid input raises GateError.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import difflib
import hashlib
import io
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

_CORPUS = Path(__file__).resolve().parent
_ROOT = _CORPUS.parents[1]
if str(_CORPUS) not in sys.path:
    sys.path.insert(0, str(_CORPUS))

import render
import source_case
from render import RenderError
from source_case import SourceCaseError
from vendor import load_vendor_module

SCHEMA = "falsify.source-twin-gate.v1"
BUNDLE_SCHEMA = "falsify.source-bundle.v1"
EXEMPTION_SCHEMA = "falsify.source-baseline-exemptions.v1"
_TWIN_SCHEMA = "falsify.source-twin.v1"
_LEDGER_SCHEMA = "falsify.red-gold-ledger.v1"
_PLAN_SCHEMA = "falsify.source-mutation-plan.v1"
_CHECK_NAMES = (
    "inputs",
    "truth",
    "clean_layer0",
    "defect_survival",
    "diff_attribution",
    "defect_layer0",
    "blind",
    "anonymization",
    "citations",
    "claims",
)
_SOFT_HYPHEN_RE = re.compile(r"([A-Za-z])-\n([a-z])")
_REAL_HYPHEN_RE = re.compile(r"(\d)-\n([A-Za-z])")
_HYPHEN_DIGIT_RE = re.compile(r"([A-Za-z])-\n(\d)")
_INSIDE_HYPHEN_RE = re.compile(r"(\d-[A-Za-z]{1,3})\n([a-z]{1,8})(?![A-Za-z])")
_FIGURE_RE = re.compile(r"Figure \d+: .*?(?=Figure \d+:|\[\d+\] [A-Z]|$)")
_BIB_RE = re.compile(r"\[\d+\] [A-Z].*?\d{4}\.")
_DRIVE_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]:[\\/][A-Za-z0-9._ -]{1,40}"
    r"(?:[\\/][A-Za-z0-9._ -]+)+"
)
_MARKER_RE = re.compile(r"\[\?\]|\?\?")
_COMMON_RED = frozenset({"before", "after", "attack", "candidate", "rationale"})
_RESOLVE_ERRORS = (SourceCaseError, RenderError, OSError, TypeError, UnicodeError, ValueError)
_SENSOR_ERRORS = (OSError, RuntimeError, TypeError, ValueError)
_FULL_PACKS = {
    "include_figure_forensics": True,
    "include_flow_triage": True,
    "include_internal_consistency": True,
    "include_meta_and_tables": True,
    "include_pdf_security": True,
}
_PARTIAL_PACKS = {
    "include_figure_forensics": False,
    "include_flow_triage": True,
    "include_internal_consistency": True,
    "include_meta_and_tables": True,
    "include_pdf_security": False,
}
_RUNTIME = None


class GateError(ValueError):
    """Invalid input. Gate refusals are report entries, not this exception."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


class GateTimeout(GateError):
    """The verify deadline elapsed."""

    def __init__(self):
        super().__init__("timeout")


def _deadline(timeout):
    if timeout is None:
        return None
    return time.monotonic() + float(timeout)


def _ensure(deadline) -> None:
    if deadline is not None and time.monotonic() >= deadline:
        raise GateTimeout()


def _collapse(text) -> str:
    return " ".join(str(text or "").split())


def _detail(text) -> str:
    return _collapse(text)[:80]


def _failure(check: str, code: str, detail: str) -> dict:
    return {"check": check, "code": code, "detail": _detail(detail)}


def _dump(payload) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_bytes(path: Path) -> bytes | None:
    if not path.is_file():
        return None
    try:
        return path.read_bytes()
    except OSError:
        return None


def _parse_json(path: Path):
    raw = _read_bytes(path)
    if raw is None:
        raise GateError("missing_file")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise GateError("unparsable") from None
    if not isinstance(data, dict):
        raise GateError("unparsable")
    return data


def _case_id(case_dir: Path) -> str:
    try:
        loaded = source_case.load_case(case_dir)
    except SourceCaseError:
        raise GateError("unparsable") from None
    return str(loaded["manifest"]["caseId"])


def _marked_uncompiled(twin: dict) -> bool:
    if twin.get("compiled") is False:
        return True
    for key in ("clean", "defect"):
        side = twin.get(key)
        if isinstance(side, dict) and side.get("compiled") is False:
            return True
    return False


def _load_inputs(build_dir, case_dir) -> dict:
    root = Path(build_dir)
    case = Path(case_dir)
    if not root.is_dir() or not case.is_dir():
        raise GateError("missing_file")
    twin = _parse_json(root / "twin.json")
    if _marked_uncompiled(twin):
        raise GateError("not_compiled")
    plan = _parse_json(root / "sealed" / "mutation-plan.json")
    ledger = _parse_json(root / "sealed" / "gold-ledger.json")
    clean_tex = _read_bytes(root / "clean" / "paper.tex")
    defect_tex = _read_bytes(root / "defect" / "paper.tex")
    clean_pdf = _read_bytes(root / "clean" / "paper.pdf")
    defect_pdf = _read_bytes(root / "defect" / "paper.pdf")
    if None in (clean_tex, defect_tex, clean_pdf, defect_pdf):
        raise GateError("missing_file")
    if not (root / "clean" / "figures").is_dir() or not (root / "defect" / "figures").is_dir():
        raise GateError("missing_file")
    return {
        "root": root,
        "case_dir": case,
        "case_id": _case_id(case),
        "twin": twin,
        "plan": plan,
        "ledger": ledger,
        "clean_tex": clean_tex,
        "defect_tex": defect_tex,
        "clean_pdf": clean_pdf,
        "defect_pdf": defect_pdf,
        "clean_signals": [],
        "normalized": [],
        "detected": {},
        "stealth_status": "not_audited",
        "stealth_pass": False,
        "forensic": Counter(),
    }


def _text(doc: dict, key: str) -> str:
    value = doc.get(key)
    if isinstance(value, str):
        return value
    return ""


def _schema_failures(state: dict) -> list[dict]:
    expected = (
        ("twin", _TWIN_SCHEMA),
        ("plan", _PLAN_SCHEMA),
        ("ledger", _LEDGER_SCHEMA),
    )
    failures = []
    for key, schema in expected:
        if state[key].get("schema") != schema:
            failures.append(_failure("inputs", "schema_mismatch", key))
    return failures


def _ids_consistent(state: dict) -> bool:
    case_id = state["case_id"]
    names = (
        _text(state["twin"], "caseId"),
        _text(state["plan"], "caseId"),
        _text(state["ledger"], "caseId"),
        _text(state["ledger"], "paperId"),
    )
    if any(item != case_id for item in names):
        return False
    plan_set = _text(state["plan"], "mutationSetId")
    ledger_set = _text(state["ledger"], "mutationSetId")
    return bool(plan_set) and plan_set == ledger_set


def _check_inputs(state: dict) -> tuple[list[dict], dict]:
    failures = _schema_failures(state)
    if not isinstance(state["ledger"].get("defects"), list):
        failures.append(_failure("inputs", "schema_mismatch", "defects"))
    if not isinstance(state["plan"].get("overrides"), list):
        failures.append(_failure("inputs", "schema_mismatch", "overrides"))
    if not _ids_consistent(state):
        failures.append(_failure("inputs", "id_mismatch", "caseId"))
    details = {"caseId": state["case_id"], "mutationSetId": _text(state["plan"], "mutationSetId")}
    return failures, details


def _resolved(case_dir: Path, overrides):
    try:
        resolved = source_case.resolve_case(case_dir, overrides)
        tex = render.assemble_case(resolved)["tex"].encode("utf-8")
    except _RESOLVE_ERRORS:
        return None
    return resolved, tex


def _changed_pairs(resolved) -> set[tuple[str, str]]:
    pairs = set()
    for item in resolved.get("overridesApplied") or []:
        if item.get("before") != item.get("after"):
            pairs.add((item.get("valueId"), item.get("surface")))
    return pairs


def _ledger_pairs(ledger: dict):
    pairs = set()
    for defect in ledger.get("defects") or []:
        source = defect.get("source") if isinstance(defect, dict) else None
        if not isinstance(source, dict):
            return None
        value_id = source.get("valueId")
        surfaces = source.get("changedSurfaces")
        if not isinstance(value_id, str) or not isinstance(surfaces, list):
            return None
        for surface in surfaces:
            if not isinstance(surface, str):
                return None
            pairs.add((value_id, surface))
    return pairs


def _check_truth(state: dict) -> tuple[list[dict], dict]:
    failures = []
    clean = _resolved(state["case_dir"], None)
    defect = _resolved(state["case_dir"], state["plan"].get("overrides"))
    if clean is None or clean[1] != state["clean_tex"]:
        failures.append(_failure("truth", "clean_not_truth", "clean tex"))
    if defect is None or defect[1] != state["defect_tex"]:
        failures.append(_failure("truth", "defect_not_plan", "defect tex"))
    ledger_pairs = _ledger_pairs(state["ledger"])
    plan_pairs = set() if defect is None else _changed_pairs(defect[0])
    if ledger_pairs is None or ledger_pairs != plan_pairs:
        failures.append(_failure("truth", "ledger_plan_mismatch", "changed surfaces"))
    return failures, {"pairs": len(plan_pairs)}


def _load_exemptions(case_dir: Path) -> list[dict]:
    path = case_dir / "gate" / "baseline-exemptions.json"
    if not path.exists():
        return []
    data = _parse_json(path)
    if data.get("schema") != EXEMPTION_SCHEMA or not isinstance(data.get("exemptions"), list):
        raise GateError("unparsable")
    return [item for item in data["exemptions"] if isinstance(item, dict)]


def _exemption_matches(exemption: dict, signal: dict) -> bool:
    if exemption.get("kind") != signal.get("kind"):
        return False
    if exemption.get("family") != signal.get("family"):
        return False
    needle = _collapse(exemption.get("excerptContains"))
    haystack = _collapse(signal.get("excerpt"))
    return bool(needle) and needle in haystack


def _match_exemptions(signals: list[dict], exemptions: list[dict]) -> tuple[list[int], list[int]]:
    used = [False] * len(exemptions)
    unexempted = []
    for index, signal in enumerate(signals):
        hits = [pos for pos, item in enumerate(exemptions) if _exemption_matches(item, signal)]
        for pos in hits:
            used[pos] = True
        if not hits:
            unexempted.append(index)
    unused = [pos for pos, hit in enumerate(used) if not hit]
    return unexempted, unused


def _runtime():
    global _RUNTIME
    if _RUNTIME is not None:
        return _RUNTIME
    app = _ROOT / "app" / "local"
    evaluation = _ROOT / "tools" / "evaluation"
    for path in (app, evaluation):
        text = str(path)
        if text not in sys.path:
            sys.path.insert(0, text)
    import arena_runner
    from paper_blue_sensor import run_blue_sensor
    from paper_evidence import EvidenceStore
    from paper_stealth_audit import audit_blindness_leaks, audit_pdf_stealth
    _RUNTIME = {
        "arena": arena_runner,
        "sensor": run_blue_sensor,
        "store": EvidenceStore,
        "stealth": audit_pdf_stealth,
        "blindness": audit_blindness_leaks,
    }
    return _RUNTIME


def _run_sensor(pdf_bytes: bytes, packs: dict, deadline) -> dict:
    _ensure(deadline)
    runtime = _runtime()
    digest = _sha256(pdf_bytes)
    store = runtime["store"]()
    try:
        summary = store.prepare(pdf_bytes, digest)
        report = runtime["sensor"](
            summary["paperId"],
            file_hash=digest,
            max_signals=100,
            include_external_oracle=False,
            store=store,
            **packs,
        )
    except _SENSOR_ERRORS:
        raise GateError("unparsable") from None
    _ensure(deadline)
    return report


def _ordered_signals(signals: list[dict]) -> list[dict]:
    return sorted(signals, key=lambda sig: (
        str(sig.get("family")),
        str(sig.get("kind")),
        sig.get("pageIndex") if type(sig.get("pageIndex")) is int else -1,
        _collapse(sig.get("excerpt")),
    ))


def _check_clean_layer0(state: dict, deadline) -> tuple[list[dict], dict]:
    report = _run_sensor(state["clean_pdf"], _FULL_PACKS, deadline)
    signals = _ordered_signals(list(report.get("signals") or []))
    exemptions = _load_exemptions(state["case_dir"])
    unexempted, unused = _match_exemptions(signals, exemptions)
    failures = []
    for index in unexempted:
        signal = signals[index]
        failures.append(_failure(
            "clean_layer0", "clean_signal_unexempted",
            f"{signal.get('family')} {signal.get('kind')}",
        ))
    for index in unused:
        item = exemptions[index]
        failures.append(_failure(
            "clean_layer0", "exemption_unused",
            f"{item.get('kind')} {item.get('excerptContains')}",
        ))
    state["clean_signals"] = signals
    state["normalized"] = _runtime()["arena"]._normalize_baseline_signals({"signals": signals})
    details = {"signals": len(signals), "exemptions": len(exemptions)}
    return failures, details


def _strip_folio(page: str, number: int) -> str:
    lines = page.splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    while lines and not lines[0].strip():
        lines.pop(0)
    folio = str(number)
    if lines and lines[0].strip() == folio:
        lines = lines[1:]
    if lines and lines[-1].strip() == folio:
        lines = lines[:-1]
    return "\n".join(lines)


def _without_folios(text: str) -> str:
    if "\f" not in text:
        return text
    pages = text.split("\f")
    parts = [_strip_folio(page, index + 1) for index, page in enumerate(pages)]
    return "\n".join(parts)


def _join_breaks(text: str) -> str:
    previous = None
    while text != previous:
        previous = text
        text = _SOFT_HYPHEN_RE.sub(r"\1\2", text)
        text = _REAL_HYPHEN_RE.sub(r"\1-\2", text)
        text = _HYPHEN_DIGIT_RE.sub(r"\1-\2", text)
        text = _INSIDE_HYPHEN_RE.sub(r"\1\2", text)
    return text


def _bib_index(entry: str) -> int:
    match = re.search(r"\d+", entry)
    if match is None:
        return 0
    return int(match.group())


def _stabilize_layout(text: str) -> str:
    figures = _FIGURE_RE.findall(text)
    entries = _BIB_RE.findall(text)
    if not figures and not entries:
        return text
    body = _collapse(_BIB_RE.sub(" ", _FIGURE_RE.sub(" ", text)))
    trailer = " ".join(figures + sorted(entries, key=_bib_index))
    whole = _collapse(body + " " + trailer)
    if sorted(text.split()) != sorted(whole.split()):
        return text
    return whole


def normalize_pdf_text(text: str) -> str:
    """Canonical PDF text for both survival counts and whole-document diffs.

    A line or page break may fall anywhere, including after a real hyphen
    (``8-\\nweek`` becomes ``8-week``) and inside a hyphenated word
    (``8-we\\nek`` becomes ``8-week``). A letter hyphenation break
    (``partici-\\npants``) joins without the hyphen. Pages are separated by
    a form feed; a line that is only that page's running number is removed,
    so the folio cannot create or hide a difference. Figure captions and
    bibliography entries are then gathered into one stable trailer, because
    a float can move an unchanged reference across a page break.
    """
    plain = _join_breaks(_without_folios(str(text or "")))
    return _stabilize_layout(_collapse(plain))


def _pdf_pages(data: bytes) -> list[str]:
    import pymupdf
    try:
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            return [page.get_text("text") or "" for page in doc]
    except (RuntimeError, ValueError):
        raise GateError("unparsable") from None


def _document(pages: list[str]) -> str:
    return "\f".join(pages)


def _words(text: str) -> list[str]:
    return _collapse(text).split()


def _only_words(left: str, right: str) -> list[str]:
    blocked = set(_words(right))
    return [word for word in _words(left) if word not in blocked]


def _longer_first(before: str, after: str):
    patterns = ((before, "b"), (after, "a"))
    return tuple(sorted(patterns, key=lambda item: len(item[0]), reverse=True))


def _take_pattern(text: str, index: int, patterns, counts: dict) -> int:
    for pattern, label in patterns:
        if pattern and text.startswith(pattern, index):
            counts[label] += 1
            return len(pattern)
    return 0


def _count_pair(text: str, before: str, after: str) -> tuple[int, int]:
    counts = {"b": 0, "a": 0}
    patterns = _longer_first(before, after)
    index = 0
    limit = len(text)
    while index < limit:
        step = _take_pattern(text, index, patterns, counts)
        index += step or 1
    return counts["b"], counts["a"]


def context_survives(before: str, after: str, clean: str, defect: str, line_limit: int) -> bool:
    """Return whether after increased and before decreased by the same amount.

    Counts use the canonical PDF text, so the same sentence may occur
    elsewhere and a break may fall after a real hyphen or inside a hyphenated
    word. A context whose before and after strings are equal, or that leaves
    the document unchanged, fails. ``line_limit`` is retained for callers.
    """
    del line_limit
    before_n = normalize_pdf_text(before)
    after_n = normalize_pdf_text(after)
    if not before_n or not after_n or before_n == after_n:
        return False
    clean_before, clean_after = _count_pair(normalize_pdf_text(clean), before_n, after_n)
    defect_before, defect_after = _count_pair(normalize_pdf_text(defect), before_n, after_n)
    gained = defect_after - clean_after
    lost = clean_before - defect_before
    return gained > 0 and gained == lost


def _contexts(defect: dict) -> list[dict]:
    source = defect.get("source") if isinstance(defect, dict) else None
    if not isinstance(source, dict) or not isinstance(source.get("contexts"), list):
        return []
    return [item for item in source["contexts"] if isinstance(item, dict)]


def _figure_name(context: dict) -> str:
    named = context.get("figureFile")
    if isinstance(named, str) and named:
        return Path(named.replace("\\", "/")).name
    surface = context.get("surface")
    if isinstance(surface, str) and surface.startswith("figure:"):
        return surface.split(":", 1)[1] + ".png"
    return ""


def _png_bytes(root: Path, name: str) -> bytes | None:
    if not name or name != Path(name).name:
        return None
    return _read_bytes(root / "figures" / name)


def _image_context(context: dict) -> bool:
    return isinstance(context.get("figureFile"), str)


def _text_context_ok(context: dict, clean: str, defect: str) -> bool:
    before = context.get("before")
    after = context.get("after")
    if not isinstance(before, str) or not isinstance(after, str):
        return False
    return context_survives(before, after, clean, defect, 0)


def _one_survival(defect: dict, clean: str, defect_text: str, state: dict) -> list[dict]:
    failures = []
    for context in _contexts(defect):
        surface = str(context.get("surface") or "")
        if _image_context(context):
            name = _figure_name(context)
            left = _png_bytes(state["root"] / "clean", name)
            right = _png_bytes(state["root"] / "defect", name)
            if left is None or right is None or left == right:
                code = "figure_unchanged" if left == right and left is not None else "defect_not_visible"
                failures.append(_failure("defect_survival", code, name or surface))
            continue
        if surface.startswith(("tex:", "table:", "figure:")):
            if not _text_context_ok(context, clean, defect_text):
                failures.append(_failure("defect_survival", "defect_not_visible", surface))
    return failures


def _check_survival(state: dict) -> tuple[list[dict], dict]:
    clean_pages = _pdf_pages(state["clean_pdf"])
    defect_pages = _pdf_pages(state["defect_pdf"])
    state["clean_pages"] = clean_pages
    state["defect_pages"] = defect_pages
    clean = _document(clean_pages)
    defect = _document(defect_pages)
    failures = []
    for item in state["ledger"].get("defects") or []:
        if isinstance(item, dict):
            failures.extend(_one_survival(item, clean, defect, state))
    return failures, {"contexts": len(failures)}


def _page_words(pages: list[str]) -> list[list[str]]:
    return [normalize_pdf_text(page).split() for page in pages]


def word_hunks(left: list[str], right: list[str]) -> list[list[str]]:
    """Return the words inserted or deleted between two pages."""
    matcher = difflib.SequenceMatcher(a=left, b=right, autojunk=False)
    hunks = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            hunks.append(left[i1:i2] + right[j1:j2])
    return hunks


def _pair_tokens(before: str, after: str) -> set[str]:
    left = normalize_pdf_text(before)
    right = normalize_pdf_text(after)
    return set(_only_words(left, right)) | set(_only_words(right, left))


def _context_tokens(defect: dict) -> set[str]:
    tokens = set()
    for context in _contexts(defect):
        if _image_context(context):
            continue
        before = context.get("before")
        after = context.get("after")
        if isinstance(before, str) and isinstance(after, str):
            tokens.update(_pair_tokens(before, after))
    return tokens


def _plain_contexts(defect: dict) -> list[dict]:
    found = []
    for context in _contexts(defect):
        if _image_context(context):
            continue
        before = context.get("before")
        after = context.get("after")
        if isinstance(before, str) and isinstance(after, str):
            found.append(context)
    return found


def _context_matches(context: dict, hunks: list[list[str]]) -> bool:
    tokens = _pair_tokens(str(context.get("before") or ""), str(context.get("after") or ""))
    if not tokens:
        return False
    for hunk in hunks:
        if _hunk_covered(hunk, tokens):
            return True
    return False


def _hunk_covered(hunk: list[str], tokens: set[str]) -> bool:
    for token in tokens:
        for word in hunk:
            if token == word or token in word or word in token:
                return True
    return False


def hunks_attributed(clean_pages: list[list[str]], defect_pages: list[list[str]], tokens: set[str]) -> list[list[str]]:
    """Return whole-document word hunks that no defect token explains.

    Pages are one word stream. Breaks must already have been removed by
    ``normalize_pdf_text``; a moved page does not create a hunk by itself.
    """
    left = [word for page in clean_pages for word in page]
    right = [word for page in defect_pages for word in page]
    unexplained = []
    for hunk in word_hunks(left, right):
        if hunk and not _hunk_covered(hunk, tokens):
            unexplained.append(hunk)
    return unexplained


def _changed_figures(ledger: dict) -> set[str]:
    names = set()
    for defect in ledger.get("defects") or []:
        if isinstance(defect, dict):
            for context in _contexts(defect):
                if isinstance(context.get("figureFile"), str):
                    names.add(_figure_name(context))
    return {name for name in names if name}


def _png_map(root: Path) -> dict[str, bytes]:
    folder = root / "figures"
    found = {}
    if not folder.is_dir():
        return found
    for path in sorted(folder.glob("*.png")):
        found[path.name] = path.read_bytes()
    return found


def _figure_failures(state: dict) -> list[dict]:
    changed = _changed_figures(state["ledger"])
    clean = _png_map(state["root"] / "clean")
    defect = _png_map(state["root"] / "defect")
    failures = []
    for name in sorted(set(clean) | set(defect)):
        if name in changed:
            continue
        if clean.get(name) != defect.get(name):
            failures.append(_failure("diff_attribution", "unexplained_figure_change", name))
    return failures


def _image_counts(data: bytes) -> list[int]:
    import pymupdf
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        return [len(page.get_images()) for page in doc]


def _image_total(data: bytes) -> int:
    return sum(_image_counts(data))


def _diff_failures(clean_words, defect_words, tokens, contexts) -> list[dict]:
    failures = []
    hunks = word_hunks(clean_words, defect_words)
    for hunk in hunks:
        if hunk and not _hunk_covered(hunk, tokens):
            failures.append(_failure("diff_attribution", "unexplained_diff", " ".join(hunk)))
    for context in contexts:
        if not _context_matches(context, hunks):
            failures.append(_failure(
                "diff_attribution", "unexplained_diff", str(context.get("surface") or "context"),
            ))
    return failures


def _check_diff(state: dict) -> tuple[list[dict], dict]:
    clean_pages = state.get("clean_pages") or _pdf_pages(state["clean_pdf"])
    defect_pages = state.get("defect_pages") or _pdf_pages(state["defect_pdf"])
    tokens = set()
    contexts = []
    for defect in state["ledger"].get("defects") or []:
        if isinstance(defect, dict):
            tokens.update(_context_tokens(defect))
            contexts.extend(_plain_contexts(defect))
    clean_words = normalize_pdf_text(_document(clean_pages)).split()
    defect_words = normalize_pdf_text(_document(defect_pages)).split()
    failures = _diff_failures(clean_words, defect_words, tokens, contexts)
    if _image_total(state["clean_pdf"]) != _image_total(state["defect_pdf"]):
        failures.append(_failure("diff_attribution", "unexplained_figure_change", "image count"))
    failures.extend(_figure_failures(state))
    return failures, {"pages": len(clean_pages)}


def _signal_key(signal: dict) -> tuple:
    return (signal.get("kind"), signal.get("family"), _collapse(signal.get("excerpt")))


def _core_token(word: str) -> str:
    return word.strip(".,;:()[]")


def _changed_cores(before: str, after: str) -> set[str]:
    found = set()
    for word in _only_words(before, after) + _only_words(after, before):
        core = _core_token(word)
        if len(core) >= 4:
            found.add(core)
    return found


def _contains_context(excerpt: str, text: str) -> bool:
    return len(text) >= 4 and text in excerpt


def _quotes_changed_unit(excerpt: str, before: str, after: str) -> bool:
    excerpt_n = normalize_pdf_text(excerpt)
    before_n = normalize_pdf_text(before)
    after_n = normalize_pdf_text(after)
    if _contains_context(excerpt_n, before_n) or _contains_context(excerpt_n, after_n):
        return True
    for core in _changed_cores(before_n, after_n):
        if core in excerpt_n:
            return True
    return False


def _signal_hits(signal: dict, defect: dict) -> bool:
    excerpt = str(signal.get("excerpt") or "")
    for context in _contexts(defect):
        before = context.get("before")
        after = context.get("after")
        if isinstance(before, str) and isinstance(after, str):
            if _quotes_changed_unit(excerpt, before, after):
                return True
    return False


def _check_defect_layer0(state: dict, deadline) -> tuple[list[dict], dict]:
    report = _run_sensor(state["defect_pdf"], _FULL_PACKS, deadline)
    partial = _run_sensor(state["defect_pdf"], _PARTIAL_PACKS, deadline)
    clean_partial = _run_sensor(state["clean_pdf"], _PARTIAL_PACKS, deadline)
    state["forensic_defect"] = _forensic_counter(report, partial)
    state["forensic_clean"] = _forensic_counter(
        {"signals": state["clean_signals"]}, clean_partial,
    )
    baseline = {_signal_key(signal) for signal in state["clean_signals"]}
    detected = {str(item.get("defectId")): False for item in state["ledger"].get("defects") or [] if isinstance(item, dict)}
    failures = []
    fresh = 0
    for signal in report.get("signals") or []:
        if _signal_key(signal) in baseline:
            continue
        fresh += 1
        hit = False
        for defect in state["ledger"].get("defects") or []:
            if isinstance(defect, dict) and _signal_hits(signal, defect):
                detected[str(defect.get("defectId"))] = True
                hit = True
        if not hit:
            failures.append(_failure("defect_layer0", "collateral_signal", signal.get("kind")))
    state["detected"] = detected
    return failures, {"newSignals": fresh}


def _counter_of(report: dict) -> Counter:
    counter: Counter = Counter()
    for signal in report.get("signals") or []:
        key = (signal.get("kind"), signal.get("family"), signal.get("pageIndex"))
        counter[key] += 1
    return counter


def _forensic_counter(full: dict, partial: dict) -> Counter:
    extra = _counter_of(full)
    extra.subtract(_counter_of(partial))
    return Counter({key: count for key, count in extra.items() if count > 0})


def _meta_text(doc) -> str:
    values = []
    for value in (doc.metadata or {}).values():
        if value:
            values.append(str(value))
    return "\n".join(values)


def _font_set(doc) -> set[tuple]:
    found = set()
    for page in doc:
        for font in page.get_fonts():
            found.add((font[1], font[2], font[3]))
    return found


def _open_pair(clean: bytes, defect: bytes):
    import pymupdf
    return pymupdf.open(stream=clean, filetype="pdf"), pymupdf.open(stream=defect, filetype="pdf")


def _check_blind(state: dict, deadline) -> tuple[list[dict], dict]:
    _ensure(deadline)
    runtime = _runtime()
    failures = []
    blind = runtime["arena"].verify_blind_bundle(state["defect_pdf"], [], source_pdf_bytes=state["clean_pdf"])
    if not blind.get("blindClean"):
        failures.append(_failure("blind", "blind_leak", "blind bundle"))
    stealth = runtime["stealth"](state["clean_pdf"], state["defect_pdf"])
    status = str(stealth.get("status") or "")
    if status == "detectable_artifact":
        failures.append(_failure("blind", "stealth_artifact", status))
    blindness = runtime["blindness"](state["clean_pdf"], state["defect_pdf"])
    if not blindness.get("clean"):
        failures.append(_failure("blind", "blind_leak", "blindness"))
    clean_doc, defect_doc = _open_pair(state["clean_pdf"], state["defect_pdf"])
    try:
        if _meta_text(clean_doc) != _meta_text(defect_doc):
            failures.append(_failure("blind", "metadata_differs", "metadata"))
        if _font_set(clean_doc) != _font_set(defect_doc):
            failures.append(_failure("blind", "fonts_differ", "fonts"))
    finally:
        clean_doc.close()
        defect_doc.close()
    if state.get("forensic_clean") != state.get("forensic_defect"):
        failures.append(_failure("blind", "forensic_signal_differs", "forensics"))
    passed = status != "detectable_artifact" and not failures
    state["stealth_status"] = status or "not_audited"
    state["stealth_pass"] = bool(passed)
    return failures, {"status": state["stealth_status"]}


def _bounded(text: str, needle: str) -> bool:
    if not needle:
        return False
    pattern = re.compile(r"(?<![A-Za-z0-9])" + re.escape(needle) + r"(?![A-Za-z0-9])", re.I)
    return pattern.search(text) is not None


def _identity_markers(state: dict) -> list[str]:
    user = os.environ.get("USERNAME") or os.environ.get("USER") or ""
    host = socket.gethostname()
    home = str(Path.home())
    return [user, host, state["case_dir"].name, home, home.replace("\\", "/")]


def _marker_hit(text: str, meta: str, latin: str, marker: str) -> bool:
    if marker in (str(Path.home()), str(Path.home()).replace("\\", "/")):
        return marker.lower() in text.lower() or marker.lower() in meta.lower() or marker.lower() in latin.lower()
    return _bounded(text, marker) or _bounded(meta, marker) or _bounded(latin, marker)


def _source_red_tokens(tex: str, patterns) -> set[str]:
    found = set()
    for token, pattern in patterns:
        if pattern.search(tex):
            found.add(token)
    return found


def _red_hit(corpus: str, patterns, allowed: set[str], common_only: bool) -> bool:
    for token, pattern in patterns:
        if token in allowed:
            continue
        if common_only and token not in _COMMON_RED:
            continue
        if pattern.search(corpus):
            return True
    return False


def _anti_leak_ok(path: Path) -> bool:
    module = load_vendor_module("upstream/skills/paper-orchestra/scripts/anti_leakage_check.py")
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            code = module.check(str(path))
        except (OSError, UnicodeError):
            return True
    return code == 0


def _check_anonymization(state: dict) -> tuple[list[dict], dict]:
    import pymupdf
    failures = []
    patterns = _runtime()["arena"]._PDF_LEAK_PATTERNS
    allowed = _source_red_tokens(state["clean_tex"].decode("utf-8", "replace"), patterns)
    markers = _identity_markers(state)
    for label, data in (("clean", state["clean_pdf"]), ("defect", state["defect_pdf"])):
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            text = normalize_pdf_text("\n".join(page.get_text("text") or "" for page in doc))
            meta = _meta_text(doc)
        latin = data.decode("latin-1")
        if any(_marker_hit(text, meta, latin, marker) for marker in markers if marker):
            failures.append(_failure("anonymization", "identity_leak", label))
        if _DRIVE_RE.search(text) or _DRIVE_RE.search(meta) or _DRIVE_RE.search(latin):
            failures.append(_failure("anonymization", "identity_leak", "path"))
        if _red_hit(text, patterns, allowed, False) or _red_hit(meta, patterns, allowed, False):
            failures.append(_failure("anonymization", "identity_leak", "hint"))
        if _red_hit(latin, patterns, allowed | _COMMON_RED, False):
            failures.append(_failure("anonymization", "identity_leak", "bytes"))
    for side in ("clean", "defect"):
        if not _anti_leak_ok(state["root"] / side / "paper.tex"):
            failures.append(_failure("anonymization", "identity_leak", side))
    return failures, {"checked": 2}


def _cite_keys(tex: str, pattern) -> set[str]:
    keys = set()
    for match in pattern.finditer(tex):
        for key in match.group(1).split(","):
            cleaned = key.strip()
            if cleaned:
                keys.add(cleaned)
    return keys


def _reference_keys(case_dir: Path) -> set[str]:
    resolved = _resolved(case_dir, None)
    if resolved is None:
        return set()
    return {item["key"] for item in resolved[0].get("references") or [] if isinstance(item, dict) and item.get("key")}


def _check_citations(state: dict) -> tuple[list[dict], dict]:
    module = load_vendor_module("upstream/skills/section-writing-agent/scripts/orphan_cite_gate.py")
    known = _reference_keys(state["case_dir"])
    failures = []
    cited = set()
    for label, blob in (("clean", state["clean_tex"]), ("defect", state["defect_tex"])):
        keys = _cite_keys(blob.decode("utf-8", "replace"), module.CITE_RE)
        cited.update(keys)
        missing = sorted(keys - known)
        if missing:
            failures.append(_failure("citations", "undefined_citation", missing[0]))
    uncited = sorted(known - cited)
    if uncited:
        failures.append(_failure("citations", "uncited_reference", uncited[0]))
    pages = (state.get("clean_pages") or []) + (state.get("defect_pages") or [])
    if any(_MARKER_RE.search(normalize_pdf_text(page)) for page in pages):
        failures.append(_failure("citations", "undefined_citation", "marker"))
    return failures, {"references": len(known)}


def _check_claims(state: dict) -> tuple[list[dict], dict]:
    import claim_check

    try:
        return claim_check.gate_claims(
            state["clean_pdf"],
            state["defect_pdf"],
            state["case_dir"],
            state["ledger"],
        )
    except claim_check.ClaimError:
        return [_failure("claims", "unparsable", "pdf")], {"error": "unparsable"}


def _defect_rows(state: dict) -> list[dict]:
    rows = []
    for defect in state["ledger"].get("defects") or []:
        if not isinstance(defect, dict):
            continue
        defect_id = str(defect.get("defectId") or "")
        rows.append({
            "defectId": defect_id,
            "layer0Detected": bool(state["detected"].get(defect_id)),
        })
    return rows


def _mutation_set(state: dict) -> str:
    return _text(state["plan"], "mutationSetId")


def _report(state: dict, checks: list[dict], failures: list[dict]) -> dict:
    return {
        "schema": SCHEMA,
        "caseId": state["case_id"],
        "mutationSetId": _mutation_set(state),
        "pass": not failures,
        "checks": checks,
        "failures": failures,
        "defects": _defect_rows(state),
        "modelCalls": 0,
    }


def _run_named(name: str, state: dict, deadline):
    if name == "inputs":
        return _check_inputs(state)
    if name == "truth":
        return _check_truth(state)
    if name == "clean_layer0":
        return _check_clean_layer0(state, deadline)
    if name == "defect_survival":
        return _check_survival(state)
    if name == "diff_attribution":
        return _check_diff(state)
    if name == "defect_layer0":
        return _check_defect_layer0(state, deadline)
    if name == "blind":
        return _check_blind(state, deadline)
    if name == "anonymization":
        return _check_anonymization(state)
    if name == "citations":
        return _check_citations(state)
    return _check_claims(state)


def _filled_ledger(state: dict) -> dict:
    ledger = copy.deepcopy(state["ledger"])
    ledger["sourceSha256"] = _sha256(state["clean_pdf"])
    ledger["blindPdfSha256"] = _sha256(state["defect_pdf"])
    ledger["stealthPass"] = bool(state["stealth_pass"])
    for defect in ledger.get("defects") or []:
        if isinstance(defect, dict):
            defect["stealthStatus"] = state["stealth_status"]
    return ledger


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _file_entry(root: Path, rel: str) -> dict:
    return {"path": rel, "sha256": _sha256((root / rel).read_bytes())}


def _manifest(root: Path, state: dict) -> dict:
    names = [
        "blind/paper.pdf",
        "sealed/baseline-signals.json",
        "sealed/clean.pdf",
        "sealed/gate.json",
        "sealed/gold-ledger.json",
    ]
    return {
        "schema": BUNDLE_SCHEMA,
        "caseId": state["case_id"],
        "mutationSetId": _mutation_set(state),
        "blindPdfSha256": _sha256(state["defect_pdf"]),
        "files": [_file_entry(root, rel) for rel in names],
    }


def _fill_bundle(root: Path, state: dict, report: dict) -> None:
    _write_bytes(root / "blind" / "paper.pdf", state["defect_pdf"])
    _write_bytes(root / "sealed" / "clean.pdf", state["clean_pdf"])
    ledger = _dump(_filled_ledger(state)).encode("utf-8")
    signals = _dump({"signals": state["normalized"]}).encode("utf-8")
    gate = _dump(report).encode("utf-8")
    _write_bytes(root / "sealed" / "gold-ledger.json", ledger)
    _write_bytes(root / "sealed" / "baseline-signals.json", signals)
    _write_bytes(root / "sealed" / "gate.json", gate)
    _write_bytes(root / "manifest.json", _dump(_manifest(root, state)).encode("utf-8"))


def _nonempty(dest: Path) -> bool:
    if not dest.is_dir():
        return True
    return any(dest.iterdir())


def write_bundle(dest_dir, state: dict, report: dict) -> None:
    """Write a bundle atomically. Refuse a destination that already has entries."""
    dest = Path(dest_dir)
    if dest.exists() and _nonempty(dest):
        raise GateError("bundle_not_empty")
    parent = dest.parent
    parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=".bundle-", dir=parent))
    try:
        _fill_bundle(tmp, state, report)
        if dest.exists():
            dest.rmdir()
        os.replace(tmp, dest)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def verify_twin(build_dir, case_dir, *, bundle_out=None, timeout=None) -> dict:
    """Return the section-7 gate report. Write a bundle only when it passes."""
    deadline = _deadline(timeout)
    _ensure(deadline)
    state = _load_inputs(build_dir, case_dir)
    checks = []
    failures = []
    for name in _CHECK_NAMES:
        _ensure(deadline)
        found, details = _run_named(name, state, deadline)
        checks.append({"check": name, "pass": not found, "details": details})
        failures.extend(found)
    report = _report(state, checks, failures)
    if report["pass"] and bundle_out:
        write_bundle(bundle_out, state, report)
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="twin_gate")
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("build")
    verify.add_argument("--case", required=True)
    verify.add_argument("--bundle-out")
    verify.add_argument("--timeout", type=float)
    return parser


def _status(report: dict) -> int:
    if report.get("pass"):
        return 0
    return 3


def main(argv=None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    try:
        report = verify_twin(
            args.build,
            args.case,
            bundle_out=args.bundle_out,
            timeout=args.timeout,
        )
    except GateTimeout:
        print("timeout", file=sys.stderr)
        return 124
    except GateError as exc:
        print(exc.code, file=sys.stderr)
        return 2
    sys.stdout.write(_dump(report))
    return _status(report)


if __name__ == "__main__":
    sys.exit(main())
