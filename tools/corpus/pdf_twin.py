"""PDF-edited counterpart of a gate-passed source-native bundle.

Visible text changes go through ``paper_text_span_mutator.mutate_pdf_text_spans``,
the text-span editor ``paper_red_mcp`` calls. A figure image, a replacement
that does not fit on its line, or any failed unit of a defect is recorded as
unsupported instead of being approximated.
"""

from __future__ import annotations

import argparse
import copy
import difflib
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parents[1]
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import twin_gate

PAIR_SCHEMA = "falsify.source-pdf-pair.v1"
LEDGER_SCHEMA = "falsify.red-gold-ledger.v1"
BUNDLE_SCHEMA = "falsify.source-bundle.v1"
_ABS_RE = re.compile(r"[A-Za-z]:[\\/]|/Users/|/home/")
_ID_RE = re.compile(rb"/ID\s*\[\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\]")
_ENGINE = None


class PdfTwinError(ValueError):
    """Invalid input or a failed self-check. ``code`` selects the exit status."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _dump(data) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if _ABS_RE.search(text):
        raise PdfTwinError("path_leak")
    return text


def _engine():
    global _ENGINE
    if _ENGINE is not None:
        return _ENGINE
    app = _ROOT / "app" / "local"
    text = str(app)
    if text not in sys.path:
        sys.path.insert(0, text)
    try:
        from paper_stealth_audit import audit_pdf_stealth
        from paper_text_span_mutator import SpanMutationError, mutate_pdf_text_spans
    except ImportError:
        raise PdfTwinError("engine_missing") from None
    _ENGINE = (mutate_pdf_text_spans, SpanMutationError, audit_pdf_stealth)
    return _ENGINE


def _load_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise PdfTwinError("bundle_invalid") from None
    if not isinstance(data, dict):
        raise PdfTwinError("bundle_invalid")
    return data


def _pdf_bytes(path: Path) -> bytes:
    try:
        data = path.read_bytes()
    except OSError:
        raise PdfTwinError("bundle_invalid") from None
    if not data.startswith(b"%PDF-"):
        raise PdfTwinError("bundle_invalid")
    return data


def _require_text(ledger: dict, manifest: dict):
    case_id = ledger.get("caseId") or manifest.get("caseId")
    set_id = ledger.get("mutationSetId")
    if not isinstance(case_id, str) or not isinstance(set_id, str) or not case_id or not set_id:
        raise PdfTwinError("bundle_invalid")
    return case_id, set_id


def _load_bundle(bundle_dir) -> dict:
    root = Path(bundle_dir)
    manifest = _load_json(root / "manifest.json")
    ledger = _load_json(root / "sealed" / "gold-ledger.json")
    if manifest.get("schema") != BUNDLE_SCHEMA or ledger.get("schema") != LEDGER_SCHEMA:
        raise PdfTwinError("bundle_invalid")
    if ledger.get("producer") != "source-native":
        raise PdfTwinError("bundle_invalid")
    defects = ledger.get("defects")
    if not isinstance(defects, list) or not defects:
        raise PdfTwinError("bundle_invalid")
    case_id, set_id = _require_text(ledger, manifest)
    return {
        "blind": _pdf_bytes(root / "blind" / "paper.pdf"),
        "caseId": case_id,
        "clean": _pdf_bytes(root / "sealed" / "clean.pdf"),
        "defects": defects,
        "ledger": ledger,
        "mutationSetId": set_id,
    }


def _word_entries(doc) -> list[dict]:
    items = []
    for page_index, page in enumerate(doc):
        for word in page.get_text("words") or []:
            items.append({
                "bbox": doc[page_index].rect.__class__(word[:4]),
                "block": word[5],
                "line": word[6],
                "page": page_index,
                "text": str(word[4]),
            })
    return items


def _contexts(defect: dict) -> list[dict]:
    source = defect.get("source") if isinstance(defect, dict) else None
    if not isinstance(source, dict):
        return []
    contexts = source.get("contexts")
    if not isinstance(contexts, list):
        return []
    return [item for item in contexts if isinstance(item, dict)]


def _image(context: dict) -> bool:
    named = context.get("figureFile")
    return isinstance(named, str) and bool(named)


def _textual(context: dict) -> bool:
    before = context.get("before")
    after = context.get("after")
    return isinstance(before, str) and isinstance(after, str) and "figureFile" not in context


def _unsupported(defect: dict, reason: str) -> dict:
    return {
        "changes": [],
        "contexts": [],
        "defect": defect,
        "ops": [],
        "reason": reason,
        "status": "unsupported",
    }


def _span_for(tag, before, after, i1, i2, j1, j2, prev_equal, next_equal):
    if tag == "replace" and i2 > i1 and j2 > j1:
        return (i1, i2, j1, j2)
    if prev_equal and i1 > 0 and j1 > 0:
        return (i1 - 1, i2, j1 - 1, j2)
    if next_equal and i2 < len(before) and j2 < len(after):
        return (i1, i2 + 1, j1, j2 + 1)
    return None


def _merge_spans(spans: list[tuple]) -> list[tuple]:
    ordered = sorted(spans)
    merged = [ordered[0]]
    for i1, i2, j1, j2 in ordered[1:]:
        left, right, low, high = merged[-1]
        if i1 <= right:
            merged[-1] = (left, max(right, i2), low, max(high, j2))
            continue
        merged.append((i1, i2, j1, j2))
    return merged


def _replacements(before: list[str], after: list[str]):
    opcodes = difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_opcodes()
    spans = []
    for index, (tag, i1, i2, j1, j2) in enumerate(opcodes):
        if tag == "equal":
            continue
        prev = index > 0 and opcodes[index - 1][0] == "equal"
        nxt = index + 1 < len(opcodes) and opcodes[index + 1][0] == "equal"
        span = _span_for(tag, before, after, i1, i2, j1, j2, prev, nxt)
        if span is None:
            return "reflow"
        spans.append(span)
    if not spans:
        return "unit_failed"
    return _merge_spans(spans)


def _starts(words: list[dict], needle: list[str]) -> list[int]:
    size = len(needle)
    limit = len(words) - size + 1
    found = []
    for index in range(max(0, limit)):
        window = [item["text"] for item in words[index:index + size]]
        if window == needle:
            found.append(index)
    return found


def _same_line(chunk: list[dict]) -> bool:
    if not chunk:
        return False
    head = chunk[0]
    for item in chunk[1:]:
        if item["page"] != head["page"] or item["block"] != head["block"] or item["line"] != head["line"]:
            return False
    return True


def _edits_fit(words, start: int, spans) -> bool:
    for i1, i2, _j1, _j2 in spans:
        if not _same_line(words[start + i1:start + i2]):
            return False
    return True


def _bind(words, needle, spans, used: set):
    reflow = False
    size = len(needle)
    for start in _starts(words, needle):
        if any(index in used for index in range(start, start + size)):
            continue
        if _edits_fit(words, start, spans):
            return start
        reflow = True
    if reflow:
        return "reflow"
    return "not_found"


def _union(chunk: list[dict]):
    box = chunk[0]["bbox"]
    for item in chunk[1:]:
        box |= item["bbox"]
    return box + (-1, -1, 1, 1)


def _occurrence(page, text: str, box):
    for index, rect in enumerate(page.search_for(text) or []):
        if rect.intersects(box):
            return index
    return None


def _joined(words, left: int, right: int) -> str:
    return " ".join(item["text"] for item in words[left:right])


def _other_span(spans, start: int, index: int, own) -> bool:
    for i1, i2, _j1, _j2 in spans:
        if (i1, i2) == own:
            continue
        if start + i1 <= index < start + i2:
            return True
    return False


def _grow(words, spans, start, stop, left, right, own):
    nxt = left - 1
    if nxt >= start and not _other_span(spans, start, nxt, own) and _same_line(words[nxt:right]):
        return nxt, right
    nxt = right + 1
    if nxt <= stop and not _other_span(spans, start, right, own) and _same_line(words[left:nxt]):
        return left, nxt
    return None


def _window_text(words, left, right, edit_left, edit_right, replacement: str):
    old = _joined(words, left, right)
    prefix = _joined(words, left, edit_left)
    suffix = _joined(words, edit_right, right)
    new = " ".join(part for part in (prefix, replacement, suffix) if part)
    return old, new


def _unique_quote(words, doc, spans, start, stop, i1, i2, replacement: str):
    """Grow a same-line edit with unchanged neighbors until that page shows it once."""
    left = start + i1
    right = start + i2
    if right <= left or not replacement or not _same_line(words[left:right]):
        return "reflow"
    page = doc[words[left]["page"]]
    own = (i1, i2)
    while True:
        old, new = _window_text(words, left, right, start + i1, start + i2, replacement)
        found = page.search_for(old) or []
        if len(found) == 1:
            return old, new, _union(words[left:right]), words[left]["page"]
        # A longer replacement cannot fit by borrowing neighbors; keep the short quote.
        if found and len(new) > len(old):
            return old, new, _union(words[left:right]), words[left]["page"]
        if not found:
            return "not_found"
        grown = _grow(words, spans, start, stop, left, right, own)
        if grown is None:
            return "unit_failed"
        left, right = grown


def _next_id(counter: list[int]) -> str:
    value = counter[0]
    counter[0] = value + 1
    return f"op-{value}"


def _ops_for(words, doc, after, spans, start, width, counter):
    ops = []
    stop = start + width
    for i1, i2, j1, j2 in spans:
        quoted = _unique_quote(words, doc, spans, start, stop, i1, i2, " ".join(after[j1:j2]))
        if isinstance(quoted, str):
            return quoted
        old, new, box, page_index = quoted
        if old == new:
            continue
        occurrence = _occurrence(doc[page_index], old, box)
        if occurrence is None:
            return "not_found"
        ops.append({
            "after": new,
            "before": old,
            "id": _next_id(counter),
            "occurrence": occurrence,
            "pageIndex": page_index,
        })
    if not ops:
        return "unit_failed"
    return ops


def _plan_context(words, doc, context, used, counter):
    before = context["before"].split()
    after = context["after"].split()
    if not before or not after:
        return "reflow"
    spans = _replacements(before, after)
    if isinstance(spans, str):
        return spans
    start = _bind(words, before, spans, used)
    if isinstance(start, str):
        return start
    ops = _ops_for(words, doc, after, spans, start, len(before), counter)
    if isinstance(ops, str):
        return ops
    return ops, set(range(start, start + len(before)))


def _plan_texts(words, doc, contexts, used, counter):
    ops = []
    taken = set()
    for context in contexts:
        planned = _plan_context(words, doc, context, used | taken, counter)
        if isinstance(planned, str):
            return [], set(), planned
        new_ops, new_taken = planned
        ops.extend(new_ops)
        taken |= new_taken
    if not ops:
        return [], set(), "unit_failed"
    return ops, taken, None


def _plan_defect(words, doc, defect, used, counter) -> dict:
    contexts = _contexts(defect)
    if any(_image(item) for item in contexts):
        return _unsupported(defect, "figure_image")
    text = [item for item in contexts if _textual(item)]
    if not text:
        return _unsupported(defect, "unit_failed")
    ops, taken, reason = _plan_texts(words, doc, text, used, counter)
    if reason:
        return _unsupported(defect, reason)
    used |= taken
    return {
        "changes": [],
        "contexts": text,
        "defect": defect,
        "ops": ops,
        "reason": None,
        "status": "applied",
    }


def _plan_all(words, doc, defects) -> list[dict]:
    used = set()
    counter = [0]
    return [_plan_defect(words, doc, defect, used, counter) for defect in defects]


def _prepare(clean: bytes, defects) -> list[dict]:
    import pymupdf

    with pymupdf.open(stream=clean, filetype="pdf") as doc:
        return _plan_all(_word_entries(doc), doc, defects)


def _map_reason(exc) -> str:
    code = getattr(exc, "code", "")
    if code in {"text_span_no_room", "text_span_after_invalid"}:
        return "reflow"
    if code in {"text_span_not_found", "text_span_occurrence_out_of_range", "text_span_before_invalid"}:
        return "not_found"
    return "unit_failed"


def _apply_ops(mutate, pdf: bytes, ops):
    """Traceless line edits only. Append-insert does not keep the replacement on its line."""
    return mutate(pdf, ops, allow_trace=False)


def _reject(plan: dict, reason: str) -> None:
    plan["status"] = "unsupported"
    plan["reason"] = reason
    plan["ops"] = []
    plan["changes"] = []


def _kept(pdf: bytes, plan: dict, result) -> bool:
    trial = {
        "changes": [],
        "contexts": plan["contexts"],
        "defect": plan["defect"],
        "ops": plan["ops"],
    }
    _attach([trial], result)
    if not trial["changes"]:
        return False
    edited = _stabilize(result["pdfBytes"])
    if not _contexts_ok(pdf, edited, plan["contexts"]):
        return False
    return _hunks_ok(pdf, edited, plan["contexts"])


def _solo(pdf: bytes, plans, mutate, error) -> list[dict]:
    ready = []
    for plan in plans:
        if plan["status"] != "applied":
            continue
        try:
            result = _apply_ops(mutate, pdf, plan["ops"])
        except error as exc:
            _reject(plan, _map_reason(exc))
            continue
        if not _kept(pdf, plan, result):
            _reject(plan, "unit_failed")
            continue
        ready.append(plan)
    return ready


def _combine(pdf: bytes, ready, mutate, error):
    chosen = list(ready)
    while chosen:
        ops = [op for plan in chosen for op in plan["ops"]]
        try:
            return chosen, _apply_ops(mutate, pdf, ops)
        except error as exc:
            _reject(chosen.pop(), _map_reason(exc))
    return [], None


def _attach(chosen, result) -> None:
    for plan in chosen:
        plan["changes"] = []
    owners = {}
    for plan in chosen:
        for op in plan["ops"]:
            owners[op["id"]] = plan
    for change in result["changes"]:
        owners[change["id"]]["changes"].append(change)


def _document(data: bytes) -> str:
    import pymupdf

    with pymupdf.open(stream=data, filetype="pdf") as doc:
        return "\f".join((page.get_text("text") or "") for page in doc)


def _flat_words(data: bytes) -> list[str]:
    pages = _document(data).split("\f")
    return [word for page in pages for word in twin_gate.normalize_pdf_text(page).split()]


def _after_ok(after: str, text: str) -> bool:
    needle = twin_gate.normalize_pdf_text(after)
    hay = twin_gate.normalize_pdf_text(text)
    if not needle:
        return False
    start = 0
    while start <= len(hay):
        pos = hay.find(needle, start)
        if pos < 0:
            return False
        end = pos + len(needle)
        if end >= len(hay) or not hay[end].isdigit():
            return True
        start = pos + 1
    return False


def _pair_tokens(before: str, after: str) -> set[str]:
    left = twin_gate.normalize_pdf_text(before).split()
    right = twin_gate.normalize_pdf_text(after).split()
    return {word for word in left if word not in set(right)} | {word for word in right if word not in set(left)}


def _covers(hunk: list[str], tokens: set[str]) -> bool:
    for token in tokens:
        for word in hunk:
            if token == word or token in word or word in token:
                return True
    return False


def _hunks_ok(clean: bytes, edited: bytes, contexts) -> bool:
    tokens = set()
    for context in contexts:
        tokens |= _pair_tokens(str(context.get("before") or ""), str(context.get("after") or ""))
    for hunk in twin_gate.word_hunks(_flat_words(clean), _flat_words(edited)):
        if hunk and not _covers(hunk, tokens):
            return False
    return True


def _contexts_ok(clean: bytes, edited: bytes, contexts) -> bool:
    clean_text = _document(clean)
    edited_text = _document(edited)
    for context in contexts:
        before = str(context.get("before") or "")
        after = str(context.get("after") or "")
        if not twin_gate.context_survives(before, after, clean_text, edited_text, 0):
            return False
    return True


def _verify(clean: bytes, edited: bytes, plans) -> bool:
    contexts = []
    edited_text = _document(edited)
    for plan in plans:
        if not plan.get("changes"):
            return False
        if not _after_ok(str(plan["defect"].get("after") or ""), edited_text):
            return False
        contexts.extend(plan["contexts"])
    if contexts and not _contexts_ok(clean, edited, contexts):
        return False
    return _hunks_ok(clean, edited, contexts)


def _line_quote(page, after: str) -> str:
    for line in (page.get_text("text") or "").splitlines():
        collapsed = " ".join(line.split())
        if collapsed and _after_ok(after, collapsed):
            return collapsed
    return ""


def _quote(doc, change, after: str) -> str:
    page = doc[int(change["pageIndex"])]
    found = _line_quote(page, after)
    if found:
        return found
    texts = [str(word[4]) for word in (page.get_text("words") or [])]
    joined = " ".join(texts)
    if _after_ok(after, joined):
        return joined
    return ""


def _quotes(data: bytes, plans) -> list[str] | None:
    import pymupdf

    found = []
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        for plan in plans:
            quote = _quote(doc, plan["changes"][0], str(plan["defect"].get("after") or ""))
            if not quote:
                return None
            found.append(quote)
    return found


def _regions(plans) -> list[dict]:
    regions = []
    for plan in plans:
        for change in plan["changes"]:
            regions.append({"bbox": list(change["bbox"]), "pageIndex": change["pageIndex"]})
    return regions


def _stealth_summary(audit: dict) -> dict:
    issues = audit.get("issues") if isinstance(audit.get("issues"), list) else []
    status = audit.get("status")
    return {
        "checks": audit.get("checks"),
        "issueCodes": [item.get("code") for item in issues if isinstance(item, dict) and item.get("code")],
        "status": status,
        "stealthPass": status != "detectable_artifact",
    }


def _edited_defect(plan: dict, quote: str, status: str) -> dict:
    defect = copy.deepcopy(plan["defect"])
    change = plan["changes"][0]
    defect["bbox"] = list(change["bbox"])
    defect["pageIndex"] = change["pageIndex"]
    defect["quote"] = quote
    defect["stealthStatus"] = status
    return defect


def _build_ledger(source, plans, quotes, clean_hash, edited_hash, stealth) -> dict:
    ledger = copy.deepcopy(source)
    edited = []
    cursor = 0
    for plan in plans:
        if plan["status"] != "applied":
            continue
        edited.append(_edited_defect(plan, quotes[cursor], stealth["status"]))
        cursor += 1
    ledger["blindPdfSha256"] = edited_hash
    ledger["defects"] = edited
    ledger["producer"] = "pdf-mutation"
    ledger["sourceSha256"] = clean_hash
    ledger["stealthPass"] = stealth["stealthPass"]
    return ledger


def _pair_rows(plans) -> list[dict]:
    rows = []
    for plan in plans:
        rows.append({
            "defectId": plan["defect"].get("defectId"),
            "reason": plan["reason"],
            "status": plan["status"],
        })
    return rows


def _status(applied: int, unsupported: int) -> str:
    if unsupported == 0:
        return "applied"
    if applied == 0:
        return "unsupported"
    return "partial"


def _build_pair(bundle, plans, clean_hash, blind_hash, edited_hash, stealth) -> dict:
    applied = sum(plan["status"] == "applied" for plan in plans)
    unsupported = len(plans) - applied
    return {
        "appliedCount": applied,
        "caseId": bundle["caseId"],
        "cleanPdfSha256": clean_hash,
        "defects": _pair_rows(plans),
        "mutationSetId": bundle["mutationSetId"],
        "pairId": bundle["caseId"] + "+" + bundle["mutationSetId"],
        "partial": unsupported > 0,
        "pdfBlindPdfSha256": edited_hash,
        "schema": PAIR_SCHEMA,
        "sourceBlindPdfSha256": blind_hash,
        "status": _status(applied, unsupported),
        "stealth": stealth,
        "unsupportedCount": unsupported,
    }


def _public(plans, stealth: str) -> dict:
    statuses = [plan["status"] for plan in plans]
    applied = statuses.count("applied")
    unsupported = len(statuses) - applied
    return {
        "applied": applied,
        "partial": unsupported > 0,
        "reasons": [plan["reason"] for plan in plans],
        "status": _status(applied, unsupported),
        "statuses": statuses,
        "stealth": stealth,
        "unsupported": unsupported,
    }


def _blank_ids(data: bytes, matches) -> bytes:
    blank = bytearray(data)
    for match in matches:
        blank[match.start(1):match.end(1)] = b"0" * (match.end(1) - match.start(1))
        blank[match.start(2):match.end(2)] = b"0" * (match.end(2) - match.start(2))
    return bytes(blank)


def _fill_ids(data: bytes, matches, digest: bytes) -> bytes:
    out = bytearray(data)
    for match in matches:
        first = match.end(1) - match.start(1)
        second = match.end(2) - match.start(2)
        block = (digest * (first + second + len(digest)))[:first + second]
        out[match.start(1):match.end(1)] = block[:first]
        out[match.start(2):match.end(2)] = block[first:first + second]
    return bytes(out)


def _stabilize(data: bytes) -> bytes:
    """Replace the engine's random trailer /ID with a hash of the other bytes."""
    matches = list(_ID_RE.finditer(data))
    if not matches:
        return data
    digest = hashlib.sha256(_blank_ids(data, matches)).hexdigest().upper().encode("ascii")
    return _fill_ids(data, matches, digest)


def _write(out_dir, pdf: bytes, ledger, pair) -> None:
    out = Path(out_dir)
    temp = Path(tempfile.mkdtemp(prefix="pdf-twin-"))
    blind = temp / "blind"
    sealed = temp / "sealed"
    try:
        blind.mkdir()
        sealed.mkdir()
        (blind / "paper.pdf").write_bytes(pdf)
        (sealed / "gold-ledger.json").write_text(_dump(ledger), encoding="utf-8", newline="\n")
        (sealed / "pair.json").write_text(_dump(pair), encoding="utf-8", newline="\n")
        if out.exists():
            shutil.rmtree(out)
        shutil.move(str(temp), str(out))
    except Exception:
        shutil.rmtree(temp, ignore_errors=True)
        raise


def _edited_bytes(clean: bytes, chosen, result):
    if result is None:
        return clean
    _attach(chosen, result)
    return _stabilize(result["pdfBytes"])


def make_pdf_twin(bundle_dir, out_dir) -> dict:
    """Edit ``sealed/clean.pdf`` and write the blind PDF, ledger, and pair record."""
    bundle = _load_bundle(bundle_dir)
    mutate, error, audit = _engine()
    plans = _prepare(bundle["clean"], bundle["defects"])
    ready = _solo(bundle["clean"], plans, mutate, error)
    chosen, result = _combine(bundle["clean"], ready, mutate, error)
    edited = _edited_bytes(bundle["clean"], chosen, result)
    if not _verify(bundle["clean"], edited, chosen):
        raise PdfTwinError("verification_failed")
    quotes = _quotes(edited, chosen)
    if quotes is None:
        raise PdfTwinError("verification_failed")
    stealth = _stealth_summary(audit(bundle["clean"], edited, _regions(chosen)))
    clean_hash = _sha256(bundle["clean"])
    blind_hash = _sha256(bundle["blind"])
    edited_hash = _sha256(edited)
    ledger = _build_ledger(bundle["ledger"], plans, quotes, clean_hash, edited_hash, stealth)
    pair = _build_pair(bundle, plans, clean_hash, blind_hash, edited_hash, stealth)
    _write(out_dir, edited, ledger, pair)
    return _public(plans, stealth["status"])


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pdf_twin")
    sub = parser.add_subparsers(dest="command", required=True)
    make = sub.add_parser("make")
    make.add_argument("bundle")
    make.add_argument("--out", required=True)
    return parser


def _exit_code(exc: PdfTwinError) -> int:
    if exc.code == "verification_failed":
        return 3
    return 2


def main(argv=None) -> int:
    """Edit a gate bundle. JSON on stdout is counts and statuses only."""
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        code = exc.code
        if code in (None, 0):
            return 0
        return code if isinstance(code, int) else 2
    try:
        report = make_pdf_twin(args.bundle, args.out)
    except PdfTwinError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        return _exit_code(exc)
    sys.stdout.write(_dump(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
