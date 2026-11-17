"""Compare printed numeric claims with a clinical source case.

The idea of checking claims against the experimental log comes from
PaperOrchestra, MIT, commit 6a319132932ee031e2d759b0f7f5075cf77bd1cf.
Section counters, page folios, citation marks, reference-list entries,
table and figure counters, and the literal 95% confidence label are
read off the document structure and left out of the claim multiset.
A figure drawing is an image, so the printed claim is its caption.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

_CORPUS = Path(__file__).resolve().parent
if str(_CORPUS) not in sys.path:
    sys.path.insert(0, str(_CORPUS))

import render
import source_case
from source_case import SourceCaseError

SCHEMA = "falsify.claim-check.v1"
_CITE_RE = re.compile(r"\\cite\s*\{[^{}]*\}")
_SUPER_RE = re.compile(r"\^\{[^{}]*\}")
_COMMAND_RE = re.compile(r"\\[A-Za-z]+")
_BRACE_RE = re.compile(r"\\(title|author)\{([^{}]*)\}")
_MARK_RE = re.compile(r"\[[0-9][0-9,\s]*\]")
_CONF_RE = re.compile(r"(?<![\d.])95\s*%(?=\s*(?:CI|Wald|interval)\b)")
_NUM_RE = re.compile(r"(?<![A-Za-z0-9.])(-?\d+(?:\.\d+)?%?)")
_TABLE_PREFIX = re.compile(r"^\s*Table\s+\d+\s*:\s*", re.IGNORECASE)
_FIGURE_PREFIX = re.compile(r"^\s*Figure\s+\d+\s*:\s*", re.IGNORECASE)
_TABLE_LINE = re.compile(r"^\s*Table\s+(\d+)\s*:", re.IGNORECASE)
_FIGURE_LINE = re.compile(r"^\s*Figure\s+(\d+)\s*:", re.IGNORECASE)
_WORD_RE = re.compile(r"[A-Za-z]{3,}")
_SENTENCE_RE = re.compile(r"\.\s+[A-Z]")
_UNESCAPE = (
    ("\\%", "%"),
    ("\\&", "&"),
    ("\\$", "$"),
    ("\\#", "#"),
    ("\\_", "_"),
    ("\\{", "{"),
    ("\\}", "}"),
)
_KINDS_SKIP = frozenset({"source-phrase", "source-citation"})


class ClaimError(ValueError):
    """Invalid PDF or case. Refusal of a readable pair is a report, not this."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _normalize(text: str) -> str:
    from twin_gate import normalize_pdf_text

    return normalize_pdf_text(text)


def _plain(line: str) -> str:
    text = _CITE_RE.sub(" ", line)
    text = _SUPER_RE.sub(" ", text)
    for old, new in _UNESCAPE:
        text = text.replace(old, new)
    text = text.replace("\\\\", " ")
    text = _COMMAND_RE.sub(" ", text)
    text = text.replace("{", " ").replace("}", " ").replace("$", "")
    text = text.replace("---", "\u2014").replace("--", "\u2013")
    return text


def _strip_structural(text: str) -> str:
    return _CONF_RE.sub(" ", _MARK_RE.sub(" ", text))


def tokens_of(text: str) -> list[str]:
    """Claim tokens left after reflow normalisation and structural removal."""
    return _NUM_RE.findall(_strip_structural(_normalize(text)))


def _listing(counts: Counter) -> list[str]:
    listed = []
    for token in sorted(counts):
        listed.extend([token] * counts[token])
    return listed


def _counts(text: str) -> Counter:
    return Counter(tokens_of(text))


def _join(parts) -> str:
    return "\n".join(part for part in parts if part)


def _vocab(text: str) -> set[str]:
    return {word.casefold() for word in _WORD_RE.findall(text)}


def _words(text: str) -> list[str]:
    return [word.casefold() for word in _WORD_RE.findall(text)]


def _in_vocab(text: str, vocab: set[str]) -> bool:
    words = _words(text)
    if not words:
        return bool(re.search(r"\d", text))
    return all(word in vocab for word in words)


def _covered(text: str, vocab: set[str]) -> bool:
    if _SENTENCE_RE.search(text):
        return False
    return _in_vocab(text, vocab)


def _first_line(text: str) -> str:
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def _strip_counter(text: str, kind: str) -> str:
    pattern = _TABLE_PREFIX if kind == "table" else _FIGURE_PREFIX
    lines = text.splitlines() or [""]
    lines[0] = pattern.sub("", lines[0])
    return "\n".join(lines)


def _heading_title(text: str):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) == 2 and lines[0].isdigit():
        return lines[1]
    if len(lines) != 1:
        return None
    match = re.fullmatch(r"\d+\s+(\S.*)", lines[0])
    if match:
        return match.group(1).strip()
    if lines[0] in {"Abstract", "References"}:
        return lines[0]
    return None


def _heading_body(text: str) -> str:
    title = _heading_title(text)
    if title in {None, "Abstract", "References"}:
        return ""
    return title


def _brace(tex: str, command: str) -> str:
    for match in _BRACE_RE.finditer(tex):
        if match.group(1) == command:
            return match.group(2)
    return ""


def _body_lines(tex: str) -> list[str]:
    started = False
    lines = []
    for raw in render._iter_lines(render._normalize(tex)):
        if not started:
            started = "\\begin{document}" in raw
            continue
        if "\\end{document}" in raw:
            break
        lines.append(raw)
    return lines


def _row_text(cells) -> str:
    return " ".join(_plain(str(cell)) for cell in cells)


def _table_text(table: dict) -> str:
    parts = [_plain(str(table.get("label") or ""))]
    headers = table.get("headers") or []
    if headers:
        parts.append(_row_text(headers))
    for row in table.get("rows") or []:
        parts.append(_row_text(row))
    return "\n".join(parts)


def _tag(raw: str, surface: str, in_abstract: bool) -> str:
    if "\\title{" in raw:
        return "tex:title"
    if in_abstract:
        return "tex:abstract"
    return surface


def _add_truth(buckets, raw, surface, in_abstract, tables, figures) -> None:
    kind, ident = render._directive(raw)
    if kind == "table":
        buckets["table:" + ident].append(_table_text(tables[ident]))
        return
    if kind == "figure":
        caption = str(figures[ident].get("caption") or "")
        buckets["figure:" + ident].append(_plain(caption))
        return
    if kind == "bibliography":
        return
    buckets[_tag(raw, surface, in_abstract)].append(_plain(raw))


def _truth_texts(resolved: dict) -> dict[str, list[str]]:
    tables = {item["tableId"]: item for item in resolved.get("tables") or []}
    figures = {item["figureId"]: item for item in resolved.get("figures") or []}
    buckets = defaultdict(list)
    surface = "tex:front"
    in_abstract = False
    for raw in _body_lines(str(resolved.get("tex") or "")):
        surface, in_abstract = source_case._open_tex_state(raw, surface, in_abstract)
        _add_truth(buckets, raw, surface, in_abstract, tables, figures)
        in_abstract = source_case._close_abstract(raw, in_abstract)
    return buckets


def _numbered(text: str, pattern, ordered: list[str]) -> str:
    match = pattern.match(_first_line(text))
    if match is None:
        return ""
    number = int(match.group(1))
    if number < 1 or number > len(ordered):
        return ""
    return ordered[number - 1]


def _section_map(tex: str) -> dict[str, str]:
    found = {}
    for match in source_case._SECTION_RE.finditer(tex):
        title = _normalize(match.group(1).strip())
        found[title] = "tex:" + source_case._slug(match.group(1))
    return found


def _catalog(resolved: dict) -> dict:
    texts = _truth_texts(resolved)
    tex = str(resolved.get("tex") or "")
    vocabs = {}
    table_ids = []
    for table in resolved.get("tables") or []:
        ident = "table:" + table["tableId"]
        table_ids.append(ident)
        vocabs[ident] = _vocab(_join(texts.get(ident, [])))
    figure_ids = []
    for figure in resolved.get("figures") or []:
        ident = "figure:" + figure["figureId"]
        figure_ids.append(ident)
        vocabs[ident] = _vocab(_join(texts.get(ident, [])))
    return {
        "texts": texts,
        "table_ids": table_ids,
        "figure_ids": figure_ids,
        "vocabs": vocabs,
        "sections": _section_map(tex),
        "title": _normalize(_plain(_brace(tex, "title"))),
        "author": _normalize(_plain(_brace(tex, "author"))),
    }


def _match_caption(text: str, pattern, ordered: list[str]) -> str:
    return _numbered(text, pattern, ordered)


def _match_heading(text: str, sections: dict) -> str:
    title = _heading_title(text)
    if title == "Abstract":
        return "tex:abstract"
    if title == "References":
        return "tex:bibliography"
    if title is None:
        return ""
    return sections.get(_normalize(title), "")


def _block_text(block: dict) -> str:
    lines = []
    for line in block.get("lines") or []:
        parts = [str(span.get("text") or "") for span in line.get("spans") or []]
        lines.append("".join(parts))
    return "\n".join(lines)


def _iter_blocks(pdf_bytes: bytes):
    import pymupdf

    try:
        document = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    except (RuntimeError, ValueError):
        raise ClaimError("unparsable") from None
    try:
        for index, page in enumerate(document, start=1):
            height = float(page.rect.height)
            for block in page.get_text("dict").get("blocks") or []:
                if block.get("type") != 0:
                    continue
                text = _block_text(block)
                if text.strip():
                    yield text, float(block["bbox"][1]), height, index
    finally:
        document.close()


def _is_folio(text: str, top: float, height: float, page_no: int) -> bool:
    if top < height * 0.85:
        return False
    return text.strip() == str(page_no)


def _new_state() -> dict:
    return {
        "section": "tex:front",
        "table": "",
        "figure": "",
        "bib": False,
        "title_done": False,
        "in_body": False,
        "title_acc": [],
        "front_acc": [],
        "chunks": defaultdict(list),
    }


def _leave_floats(state: dict) -> None:
    state["table"] = ""
    state["figure"] = ""


def _store(state: dict, ident: str, text: str) -> None:
    if ident and text.strip():
        state["chunks"][ident].append(text)


def _classify(state: dict, catalog: dict, text: str) -> tuple[str, str]:
    figure = _match_caption(text, _FIGURE_LINE, catalog["figure_ids"])
    if figure:
        return "figure", figure
    table = _match_caption(text, _TABLE_LINE, catalog["table_ids"])
    if table:
        return "table", table
    heading = _match_heading(text, catalog["sections"])
    if heading:
        return "heading", heading
    if state["figure"] and _in_vocab(text, catalog["vocabs"].get(state["figure"], set())):
        return "body", state["figure"]
    if state["table"] and _covered(text, catalog["vocabs"].get(state["table"], set())):
        return "body", state["table"]
    if state["bib"]:
        return "bib", ""
    return "prose", state["section"]


def _apply(state: dict, kind: str, ident: str, text: str) -> None:
    if kind == "figure":
        _leave_floats(state)
        state["figure"] = ident
        _store(state, ident, _strip_counter(text, "figure"))
        return
    if kind == "table":
        _leave_floats(state)
        state["table"] = ident
        _store(state, ident, _strip_counter(text, "table"))
        return
    if kind == "heading":
        _leave_floats(state)
        state["bib"] = ident == "tex:bibliography"
        if not state["bib"]:
            state["section"] = ident
            _store(state, ident, _heading_body(text))
        return
    if kind == "body":
        _store(state, ident, text)
        return
    if kind == "bib":
        _leave_floats(state)
        return
    _leave_floats(state)
    _store(state, ident, text)


def _finish_title(state: dict, catalog: dict, pending: str) -> None:
    acc = state["title_acc"]
    if acc:
        _store(state, "tex:title", _normalize(_join(acc)))
    state["title_acc"] = []
    state["title_done"] = True
    _before_body(state, catalog, pending)


def _take_title(state: dict, catalog: dict, text: str) -> None:
    title = catalog["title"]
    if not title:
        state["title_done"] = True
        _before_body(state, catalog, text)
        return
    state["title_acc"].append(text)
    joined = _normalize(_join(state["title_acc"]))
    if joined == title:
        _store(state, "tex:title", joined)
        state["title_acc"] = []
        state["title_done"] = True
        return
    if title.startswith(joined):
        return
    state["title_acc"].pop()
    _finish_title(state, catalog, text)


def _open_body(state: dict, catalog: dict, text: str) -> None:
    if state["front_acc"]:
        _store(state, "tex:front", _join(state["front_acc"]))
        state["front_acc"] = []
    state["in_body"] = True
    kind, ident = _classify(state, catalog, text)
    _apply(state, kind, ident, text)


def _before_body(state: dict, catalog: dict, text: str) -> None:
    if not state["title_done"]:
        _take_title(state, catalog, text)
        return
    heading = _match_heading(text, catalog["sections"])
    if heading:
        _open_body(state, catalog, text)
        return
    state["front_acc"].append(text)


def _absorb(state: dict, catalog: dict, text: str, top: float, height: float, page_no: int) -> None:
    if _is_folio(text, top, height, page_no):
        return
    if not state["in_body"]:
        _before_body(state, catalog, text)
        return
    kind, ident = _classify(state, catalog, text)
    _apply(state, kind, ident, text)


def _pdf_chunks(pdf_bytes: bytes, catalog: dict) -> dict[str, list[str]]:
    state = _new_state()
    try:
        blocks = list(_iter_blocks(pdf_bytes))
    except ImportError:
        raise ClaimError("unparsable") from None
    for text, top, height, page_no in blocks:
        _absorb(state, catalog, text, top, height, page_no)
    if not state["title_done"] and state["title_acc"]:
        _store(state, "tex:title", _normalize(_join(state["title_acc"])))
    if state["front_acc"]:
        _store(state, "tex:front", _join(state["front_acc"]))
    return state["chunks"]


def _bundle_counts(chunks: dict) -> dict[str, Counter]:
    counts = {}
    for name, parts in chunks.items():
        if name == "tex:bibliography":
            continue
        counts[name] = _counts(_join(parts))
    return counts


def _load_case(case_dir):
    try:
        return source_case.resolve_case(case_dir)
    except SourceCaseError:
        raise ClaimError("unparsable") from None


def _diff(pdf_counts: Counter, truth_counts: Counter) -> tuple[Counter, Counter]:
    return pdf_counts - truth_counts, truth_counts - pdf_counts


def _surface_diff(pdf_map: dict, truth_map: dict) -> tuple[dict, dict]:
    unsupported = {}
    missing = {}
    for name in set(pdf_map) | set(truth_map):
        extra, gone = _diff(pdf_map.get(name, Counter()), truth_map.get(name, Counter()))
        if extra:
            unsupported[name] = extra
        if gone:
            missing[name] = gone
    return unsupported, missing


def _rows(unsupported: dict, missing: dict) -> list[dict]:
    rows = []
    for name in sorted(set(unsupported) | set(missing)):
        extra = _listing(unsupported.get(name, Counter()))
        gone = _listing(missing.get(name, Counter()))
        rows.append({
            "missing": gone,
            "missingCount": len(gone),
            "surface": name,
            "unsupported": extra,
            "unsupportedCount": len(extra),
        })
    return rows


def _report(case_id: str, unsupported: dict, missing: dict) -> dict:
    rows = _rows(unsupported, missing)
    unsupported_count = sum(item["unsupportedCount"] for item in rows)
    missing_count = sum(item["missingCount"] for item in rows)
    return {
        "caseId": case_id,
        "missingCount": missing_count,
        "pass": unsupported_count == 0 and missing_count == 0,
        "schema": SCHEMA,
        "surfaces": rows,
        "unsupportedCount": unsupported_count,
    }


def check_pdf(pdf_bytes, case_dir) -> dict:
    """Return unsupported printed tokens and missing truth tokens per surface."""
    if not isinstance(pdf_bytes, (bytes, bytearray)) or not pdf_bytes:
        raise ClaimError("unparsable")
    resolved = _load_case(case_dir)
    catalog = _catalog(resolved)
    pdf_map = _bundle_counts(_pdf_chunks(bytes(pdf_bytes), catalog))
    truth_map = _bundle_counts(catalog["texts"])
    unsupported, missing = _surface_diff(pdf_map, truth_map)
    return _report(str(resolved.get("caseId") or ""), unsupported, missing)


def _by_surface(report: dict, key: str) -> dict[str, Counter]:
    found = {}
    for item in report.get("surfaces") or []:
        tokens = item.get(key) or []
        if tokens:
            found[item["surface"]] = Counter(tokens)
    return found


def _contexts(defect: dict) -> list[dict]:
    source = defect.get("source") if isinstance(defect, dict) else None
    if not isinstance(source, dict):
        return []
    contexts = source.get("contexts")
    if not isinstance(contexts, list):
        return []
    return [item for item in contexts if isinstance(item, dict)]


def _printed(defect: dict) -> list[dict]:
    return [item for item in _contexts(defect) if not item.get("figureFile")]


def _pair_delta(before: str, after: str) -> tuple[Counter, Counter]:
    return _diff(_counts(after), _counts(before))


def _add_delta(bucket: dict, surface: str, counts: Counter) -> None:
    if counts:
        bucket[surface] = bucket.get(surface, Counter()) + counts


def _one_defect(defect: dict, introduced: dict, removed: dict) -> bool:
    """Record printed token changes. A source-value defect stays numeric."""
    kind = defect.get("kind") if isinstance(defect, dict) else None
    if kind in _KINDS_SKIP:
        return False
    if kind != "source-value":
        return False
    for item in _printed(defect):
        before = item.get("before")
        after = item.get("after")
        surface = item.get("surface")
        if not isinstance(before, str) or not isinstance(after, str) or not isinstance(surface, str):
            continue
        added, dropped = _pair_delta(before, after)
        _add_delta(introduced, surface, added)
        _add_delta(removed, surface, dropped)
    return True


def _ledger_delta(ledger: dict) -> tuple[dict, dict, list, int]:
    introduced = {}
    removed = {}
    numeric = []
    skipped = 0
    for defect in ledger.get("defects") or []:
        if isinstance(defect, dict) and defect.get("kind") in _KINDS_SKIP:
            skipped += 1
            continue
        if _one_defect(defect, introduced, removed):
            numeric.append(defect)
    return introduced, removed, numeric, skipped


def _unequal(expected: dict, actual: dict) -> str:
    for name in sorted(set(expected) | set(actual)):
        if expected.get(name, Counter()) != actual.get(name, Counter()):
            return name
    return ""


def _introduced(defect: dict) -> dict[str, Counter]:
    found = {}
    for item in _printed(defect):
        before = item.get("before")
        after = item.get("after")
        surface = item.get("surface")
        if not isinstance(before, str) or not isinstance(after, str) or not isinstance(surface, str):
            continue
        added, _dropped = _pair_delta(before, after)
        _add_delta(found, surface, added)
    return found


def _visible(defect: dict, actual: dict) -> bool:
    needed = _introduced(defect)
    if not needed:
        return False
    overlap = 0
    for surface, counts in needed.items():
        overlap += sum((counts & actual.get(surface, Counter())).values())
    return overlap > 0


def _surface_name(defect: dict) -> str:
    for item in _contexts(defect):
        surface = item.get("surface")
        if isinstance(surface, str) and surface:
            return surface
    return "document"


def _fail(code: str, detail: str) -> dict:
    text = " ".join(str(detail).split())[:80]
    return {"check": "claims", "code": code, "detail": text or "document"}


def _clean_failure(report: dict) -> list[dict]:
    if report.get("pass"):
        return []
    surface = report["surfaces"][0]["surface"] if report.get("surfaces") else "document"
    return [_fail("clean_mismatch", surface)]


def _defect_failures(defect: dict, introduced: dict, removed: dict, numeric: list) -> list[dict]:
    failures = []
    actual_unsup = _by_surface(defect, "unsupported")
    actual_miss = _by_surface(defect, "missing")
    mismatch = _unequal(introduced, actual_unsup) or _unequal(removed, actual_miss)
    if mismatch:
        failures.append(_fail("undeclared_number", mismatch))
    for item in numeric:
        if not _visible(item, actual_unsup):
            failures.append(_fail("number_not_visible", _surface_name(item)))
    return failures


def gate_claims(clean_pdf, defect_pdf, case_dir, ledger) -> tuple[list[dict], dict]:
    """Apply the sealed ledger rule. Phrase and citation defects do not decide it."""
    clean = check_pdf(clean_pdf, case_dir)
    defect = check_pdf(defect_pdf, case_dir)
    introduced, removed, numeric, skipped = _ledger_delta(ledger if isinstance(ledger, dict) else {})
    failures = _clean_failure(clean)
    failures.extend(_defect_failures(defect, introduced, removed, numeric))
    details = {
        "cleanMissing": clean["missingCount"],
        "cleanUnsupported": clean["unsupportedCount"],
        "defectMissing": defect["missingCount"],
        "defectUnsupported": defect["unsupportedCount"],
        "notApplicable": skipped,
    }
    return failures, details


def _public(report: dict) -> dict:
    surfaces = []
    for item in report["surfaces"]:
        surfaces.append({
            "missingCount": item["missingCount"],
            "surface": item["surface"],
            "unsupported": list(item["unsupported"]),
            "unsupportedCount": item["unsupportedCount"],
        })
    return {
        "caseId": report["caseId"],
        "missingCount": report["missingCount"],
        "pass": report["pass"],
        "schema": SCHEMA,
        "surfaces": surfaces,
        "unsupportedCount": report["unsupportedCount"],
    }


def _dump(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="claim_check")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check")
    check.add_argument("pdf")
    check.add_argument("--case", required=True)
    return parser


def _read_pdf(path: str) -> bytes:
    try:
        data = Path(path).read_bytes()
    except OSError:
        raise ClaimError("missing_file") from None
    if not data:
        raise ClaimError("missing_file")
    return data


def main(argv=None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    try:
        report = check_pdf(_read_pdf(args.pdf), args.case)
    except ClaimError as exc:
        print(exc.code, file=sys.stderr)
        return 2
    sys.stdout.write(_dump(_public(report)))
    if report["pass"]:
        return 0
    return 3


if __name__ == "__main__":
    sys.exit(main())
