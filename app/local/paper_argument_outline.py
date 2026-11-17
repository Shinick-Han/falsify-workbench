"""Advisory argument outline and claim–evidence map. No network and no RED labels.

The digest is hard-capped at ``DIGEST_CAP`` (6000 characters). Topic sentences are
hard-capped at ``TOPIC_CAP`` (300 characters). ``signals`` is always empty: every
D3/S1 row is an advisory hint, never a confirmed defect.
"""
import json
import re

import paper_flow_and_spin_triage as spin
import paper_internal_consistency as consistency

SCHEMA = "falsify.argument-outline.v1"
DIGEST_CAP = 6000
TOPIC_CAP = 300
_MIN_PARAGRAPH_WORDS = 15
_MAX_SENTENCES = 8
_MAX_WORDS = 220
_ORPHAN_WORDS = 60
_MIN_TOPIC_WORDS = 6
_DEFAULT_LIMIT = 20

_CONNECTIVE = re.compile(
    r"^(?:however|moreover|furthermore|additionally|in addition|also|therefore|thus|hence|"
    r"consequently|as a result|that is|in other words|for example|for instance|similarly|"
    r"likewise|finally|then)\b",
    re.I,
)
_PIVOT = re.compile(
    r"\b(?:however|in contrast|by contrast|on the other hand|conversely|nevertheless|"
    r"nonetheless|whereas|although|yet)\b",
    re.I,
)
_CITE = re.compile(
    r"\[[0-9][0-9,\s\-–]*\]|\bet al\.?|\([A-Z][A-Za-z\-]+(?:\s+et al\.?)?,?\s+\d{4}\)",
)
_ABBREV = re.compile(r"\b(?:et al|vs|fig|dr|mr|mrs|prof|e\.g|i\.e|no|vol)\.", re.I)
_PCT_RE = re.compile(r"(?<!\d)(\d+(?:\.\d+)?)\s*%")
_P_RE = re.compile(r"\bp\s*(?:<=|>=|<|>|=)\s*(\d*\.\d+|\d+(?:\.\d+)?)", re.I)
_RATIO_RE = re.compile(r"\b(?:aOR|aHR|aRR|OR|HR|RR|IRR)\s*=\s*(\d+(?:\.\d+)?)", re.I)
_EFFECT_RE = re.compile(
    r"\b(?:hazard ratio|odds ratio|relative risk|risk ratio|mean difference|"
    r"mortality|response rate|absolute risk)\b[^.]{0,60}?(\d+(?:\.\d+)?)\s*%?",
    re.I,
)
_CI_WORD = re.compile(r"\bCI\b|confidence interval", re.I)
_CI_PAIR_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(?:to|–|—|-|,)\s*(\d+(?:\.\d+)?)",
    re.I,
)
_NUM_RE = re.compile(r"\d*\.\d+|\d+")
_CAUSAL_CORE = re.compile(r"\bproves\b|\bdemonstrates that\b.{0,80}\bcauses\b", re.I)
_ABSOLUTE_RE = re.compile(r"\bdefinitively\b|\beliminates\b", re.I)
_HEDGE_RE = re.compile(
    r"\b(?:may|might|could|suggests?|appears?|possibly|likely|associated with|"
    r"warrants|exploratory|hypothesis(?:-generating)?|seems|potentially)\b",
    re.I,
)
_LIMIT_RE = re.compile(
    r"\blimitations?\b|\bcaveats?\b|\blimited by\b|interpreted with caution",
    re.I,
)
_CLAIM_SECTIONS = frozenset({"abstract", "discussion", "conclusion"})
_CAUSAL_SECTIONS = frozenset({"abstract", "conclusion"})
_LIMIT_SECTIONS = frozenset({"discussion", "conclusion"})


def _guard(pdf_bytes, segments):
    consistency._reject_red_keys(pdf_bytes)
    consistency._reject_red_keys(segments)


def _bounded_limit(value):
    if value is None:
        return _DEFAULT_LIMIT
    consistency._require_limit(value)
    return value


def _read_pdf(pdf_bytes):
    if isinstance(pdf_bytes, bytearray):
        pdf_bytes = bytes(pdf_bytes)
    if not isinstance(pdf_bytes, bytes) or not pdf_bytes.startswith(b"%PDF-"):
        raise ValueError("pdf_bytes")
    return _open_pdf(pdf_bytes)


def _open_doc(library, pdf_bytes):
    try:
        return library.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:
        raise ValueError("pdf_bytes") from exc


def _pdf_page_rows(doc):
    rows = []
    for index, page in enumerate(doc):
        rows.append({"pageIndex": index, "text": page.get_text("text") or "", "id": None})
    return rows


def _open_pdf(pdf_bytes):
    import pymupdf

    doc = _open_doc(pymupdf, pdf_bytes)
    try:
        return _pdf_page_rows(doc)
    finally:
        doc.close()


def _combined_pages(pdf_bytes, segments):
    pages = []
    if pdf_bytes is not None:
        pages.extend(_read_pdf(pdf_bytes))
    pages.extend(consistency._normalize_pages(segments))
    return pages


def _raw_items(segments):
    if isinstance(segments, (list, tuple)):
        return list(segments)
    return []


def _item_page(item, fallback):
    if isinstance(item, dict):
        page = item.get("pageIndex", fallback)
        if type(page) is int and not isinstance(page, bool):
            return page
    if isinstance(item, tuple) and item and type(item[0]) is int and not isinstance(item[0], bool):
        return item[0]
    return fallback


def _flatten(value):
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return " ".join(_flatten(part) for part in value)
    if isinstance(value, dict):
        return " ".join(_flatten(part) for part in value.values())
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def _table_parts(item, kind):
    parts = []
    caption = item.get("caption")
    if isinstance(caption, str):
        parts.append(caption)
    if item.get("rows") is not None:
        parts.append(_flatten(item.get("rows")))
    if item.get("cells") is not None:
        parts.append(_flatten(item.get("cells")))
    if kind == "table" and isinstance(item.get("text"), str):
        parts.append(item["text"])
    return parts


def _is_table(item, kind):
    if kind == "table" or item.get("rows") is not None or item.get("cells") is not None:
        return True
    caption = item.get("caption")
    return isinstance(caption, str) and caption.lower().startswith("table")


def _table_text(item):
    if not isinstance(item, dict):
        return ""
    kind = str(item.get("kind") or item.get("role") or "").lower()
    if not _is_table(item, kind):
        return ""
    return "\n".join(part for part in _table_parts(item, kind) if part)


def _table_blobs(segments):
    blobs = []
    for index, item in enumerate(_raw_items(segments)):
        text = _table_text(item)
        if text:
            blobs.append({"pageIndex": _item_page(item, index), "text": text})
    return blobs


def _fresh_state():
    return {"section": None, "lines": [], "page": None}


def _flush(state, rows):
    text = " ".join(state["lines"]).strip()
    if text and state["section"] is not None:
        rows.append({"section": state["section"], "pageIndex": state["page"], "text": text})
    state["lines"] = []
    state["page"] = None


def _push(state, page_index, line):
    if not state["lines"]:
        state["page"] = page_index
    state["lines"].append(line.strip())


def _consume(page, line, state, rows):
    section, rest = consistency._split_heading(line)
    if section is not None:
        _flush(state, rows)
        state["section"] = section
        if rest:
            _push(state, page["pageIndex"], rest)
        return
    if state["section"] is None or not line.strip():
        if state["section"] is not None and not line.strip():
            _flush(state, rows)
        return
    _push(state, page["pageIndex"], line)


def _paragraphs(pages):
    state = _fresh_state()
    rows = []
    for page in pages:
        for line in page["text"].splitlines() or [page["text"]]:
            _consume(page, line, state, rows)
    _flush(state, rows)
    return rows


def _mask_dot(match):
    return match.group(0)[:-1] + "\u0000"


def _restore(part):
    return part.replace("\u0000", ".").strip()


def _merge_short(raw):
    merged = []
    carry = ""
    for part in raw:
        sentence = (carry + " " + part).strip() if carry else part
        if len(sentence.split()) <= 5:
            carry = sentence
            continue
        merged.append(sentence)
        carry = ""
    if carry:
        merged.append(carry)
    return merged


def _sentences(text):
    protected = _ABBREV.sub(_mask_dot, text or "")
    parts = re.split(r"(?<=[.!?])\s+", protected)
    raw = [_restore(part) for part in parts if part.strip()]
    return _merge_short(raw)


def _add_topic_flag(flags, topic):
    if len(topic.split()) < _MIN_TOPIC_WORDS or _CONNECTIVE.match(topic):
        flags.append("no_topic_sentence")


def _add_overlong_flag(flags, text, sents):
    if len(sents) > _MAX_SENTENCES or len(text.split()) > _MAX_WORDS:
        flags.append("overlong")


def _add_pivot_flag(flags, text):
    if len(_PIVOT.findall(text)) >= 2:
        flags.append("multi_pivot")


def _add_orphan_flag(flags, text, sents):
    if len(sents) == 1 and len(text.split()) < _ORPHAN_WORDS:
        flags.append("orphan")


def _add_citation_flag(flags, text, sents):
    if len(_CITE.findall(text)) > len(sents):
        flags.append("citation_dump")


def _flags(text, sents):
    flags = []
    _add_topic_flag(flags, sents[0])
    _add_overlong_flag(flags, text, sents)
    _add_pivot_flag(flags, text)
    _add_orphan_flag(flags, text, sents)
    _add_citation_flag(flags, text, sents)
    return flags


def _analyze(paragraph):
    sents = _sentences(paragraph["text"])
    if not sents or len(paragraph["text"].split()) < _MIN_PARAGRAPH_WORDS:
        return None
    return {
        "section": paragraph["section"],
        "pageIndex": paragraph["pageIndex"],
        "topicSentence": sents[0][:TOPIC_CAP],
        "sentenceCount": len(sents),
        "flags": _flags(paragraph["text"], sents),
    }


def _outline(paragraphs):
    rows = []
    for paragraph in paragraphs:
        row = _analyze(paragraph)
        if row is not None:
            rows.append(row)
    return rows


def _section_sentences(paragraphs, sections):
    rows = []
    for paragraph in paragraphs:
        if paragraph["section"] not in sections:
            continue
        for sentence in _sentences(paragraph["text"]):
            rows.append({
                "section": paragraph["section"],
                "pageIndex": paragraph["pageIndex"],
                "text": sentence,
            })
    return rows


def _bare(value):
    return str(value).replace("%", "").strip()


def _percent_values(sentence):
    return [match.group(1) + "%" for match in _PCT_RE.finditer(sentence)]


def _p_values(sentence):
    return [match.group(1) for match in _P_RE.finditer(sentence)]


def _ratio_values(sentence):
    return [match.group(1) for match in _RATIO_RE.finditer(sentence)]


def _effect_values(sentence):
    return [match.group(1) for match in _EFFECT_RE.finditer(sentence)]


def _ci_values(sentence):
    if _CI_WORD.search(sentence) is None:
        return []
    found = []
    for match in _CI_PAIR_RE.finditer(sentence):
        found.append(match.group(1))
        found.append(match.group(2))
    return found


def _collapse(values):
    kept = []
    seen = set()
    for value in values:
        number = _float_or_none(_bare(value))
        if number is None or number in seen:
            continue
        seen.add(number)
        kept.append(value if "%" in value else _bare(value))
    return kept


def _quant_values(sentence):
    found = []
    found.extend(_percent_values(sentence))
    found.extend(_p_values(sentence))
    found.extend(_ratio_values(sentence))
    found.extend(_ci_values(sentence))
    found.extend(_effect_values(sentence))
    return _collapse(found)


def _is_results_blob(paragraph):
    if paragraph["section"] == "results":
        return True
    return paragraph["text"].lower().startswith("table")


def _evidence(paragraphs, tables):
    blobs = []
    for paragraph in paragraphs:
        if _is_results_blob(paragraph):
            blobs.append({"pageIndex": paragraph["pageIndex"], "text": paragraph["text"]})
    blobs.extend(tables)
    return blobs


def _boundary(token, text):
    if not token:
        return False
    tail = r"(?!\d)"
    if "." not in token:
        tail = r"(?!\.\d)(?!\d)"
    return re.search(r"(?<!\d)" + re.escape(token) + tail, text) is not None


def _present(value, text):
    token = _bare(value)
    if token and _boundary(token, text):
        return True
    return value != token and _boundary(value, text)


def _exact_page(value, blobs):
    for blob in blobs:
        if _present(value, blob["text"]):
            return blob["pageIndex"]
    return None


def _float_or_none(token):
    try:
        return float(token)
    except ValueError:
        return None


def _decimals(token):
    if "." not in token:
        return 0
    return len(token.split(".", 1)[1])


def _same_number(left, right):
    return abs(left - right) <= 1e-9


def _within(claim, other, decimals):
    tolerance = 0.5 * (10 ** (-decimals))
    return abs(claim - other) <= tolerance


def _blob_close(claim, decimals, text):
    for match in _NUM_RE.finditer(text):
        other = _float_or_none(match.group(0))
        if other is None:
            continue
        if _same_number(claim, other) or _within(claim, other, decimals):
            return True
    return False


def _close_page(token, blobs):
    claim = _float_or_none(token)
    if claim is None:
        return None
    decimals = _decimals(token)
    for blob in blobs:
        if _blob_close(claim, decimals, blob["text"]):
            return blob["pageIndex"]
    return None


def _status_for(value, blobs):
    exact = _exact_page(value, blobs)
    if exact is not None:
        return "supported", exact
    close = _close_page(_bare(value), blobs)
    if close is None:
        return "unsupported", None
    return "uncertain", close


def _claims(paragraphs, tables):
    evidence = _evidence(paragraphs, tables)
    rows = []
    seen = set()
    for sentence in _section_sentences(paragraphs, _CLAIM_SECTIONS):
        for value in _quant_values(sentence["text"]):
            key = (sentence["text"], value)
            if key in seen:
                continue
            seen.add(key)
            status, page = _status_for(value, evidence)
            rows.append({
                "claim": sentence["text"][:TOPIC_CAP],
                "section": sentence["section"],
                "pageIndex": sentence["pageIndex"],
                "value": value,
                "status": status,
                "evidencePageIndex": page,
            })
    return rows


def _norm(text):
    return " ".join(str(text or "").split())


def _mismatch_blob(sig):
    payload = {
        "anchor": sig.get("anchorExcerpt"),
        "excerpt": sig.get("excerpt"),
        "reported": sig.get("reported"),
        "computed": sig.get("computed"),
        "detail": sig.get("detail"),
    }
    return _norm(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _same_sentence(sentence, sig):
    clipped = _norm(sentence)[:220]
    anchor = _norm(sig.get("anchorExcerpt"))
    excerpt = _norm(sig.get("excerpt"))
    if not clipped:
        return False
    return clipped[:80] in anchor or clipped[:80] in excerpt or anchor[:80] in clipped


def _value_covered(sentence, value, signals):
    token = _bare(value)
    for sig in signals:
        if "mismatch" not in str(sig.get("kind")):
            continue
        if _same_sentence(sentence, sig) and token and token in _mismatch_blob(sig):
            return True
    return False


def _claim_hint(claim):
    return {
        "family": "D3",
        "kind": "conclusion_claim_without_results_support",
        "advisoryOnly": True,
        "section": claim["section"],
        "pageIndex": claim["pageIndex"],
        "excerpt": claim["claim"][:220],
        "value": claim["value"],
        "detail": "Advisory only. Quantitative claim was not found in Results or table text.",
        "reported": {"value": claim["value"], "status": "unsupported"},
        "computed": {"advisoryOnly": True},
    }


def _claim_hints(claims, signals):
    hints = []
    seen = set()
    for claim in claims:
        if claim["status"] != "unsupported":
            continue
        if _value_covered(claim["claim"], claim["value"], signals):
            continue
        key = (claim["section"], claim["pageIndex"], claim["claim"])
        if key in seen:
            continue
        seen.add(key)
        hints.append(_claim_hint(claim))
    return hints


def _overclaim(text):
    if _HEDGE_RE.search(text):
        return False
    if _CAUSAL_CORE.search(text):
        return True
    return _ABSOLUTE_RE.search(text) is not None


def _language_family(text):
    if _CAUSAL_CORE.search(text):
        return "D3"
    return "S1"


def _spin_covered(sentence, hints):
    clipped = _norm(sentence)[:220]
    if len(clipped) < 12:
        return False
    for hint in hints:
        excerpt = _norm(hint.get("excerpt"))
        if excerpt and (excerpt in clipped or clipped in excerpt):
            return True
    return False


def _causal_hint(sentence):
    return {
        "family": _language_family(sentence["text"]),
        "kind": "causal_or_absolute_language_without_hedge",
        "advisoryOnly": True,
        "section": sentence["section"],
        "pageIndex": sentence["pageIndex"],
        "excerpt": sentence["text"][:220],
        "detail": "Advisory only. Causal or absolute wording has no hedge in the sentence.",
        "reported": {"section": sentence["section"]},
        "computed": {"advisoryOnly": True},
    }


def _causal_hints(paragraphs, flow_hints):
    hints = []
    for sentence in _section_sentences(paragraphs, _CAUSAL_SECTIONS):
        if not _overclaim(sentence["text"]):
            continue
        if _spin_covered(sentence["text"], flow_hints):
            continue
        hints.append(_causal_hint(sentence))
    return hints


def _limitation_hint(page_index, section):
    return {
        "family": "S1",
        "kind": "limitations_absent",
        "advisoryOnly": True,
        "section": section,
        "pageIndex": page_index,
        "excerpt": "No limitations statement in Discussion or Conclusion.",
        "detail": "Advisory only. No limitations statement was found in Discussion or Conclusion.",
        "reported": {"limitationsFound": False},
        "computed": {"advisoryOnly": True},
    }


def _has_limitation(paragraphs):
    for paragraph in paragraphs:
        if paragraph["section"] in _LIMIT_SECTIONS and _LIMIT_RE.search(paragraph["text"]):
            return True
    return False


def _limitation_anchor(paragraphs):
    for paragraph in paragraphs:
        if paragraph["section"] in _LIMIT_SECTIONS:
            return paragraph["pageIndex"], paragraph["section"]
    return 0, "discussion"


def _limitation_hints(paragraphs):
    if _has_limitation(paragraphs):
        return []
    page_index, section = _limitation_anchor(paragraphs)
    return [_limitation_hint(page_index, section)]


def _tag(hints):
    tagged = []
    for index, hint in enumerate(hints):
        tagged.append({"id": f"ao-{index + 1}", **hint})
    return tagged


def _bound_hints(rows, cap):
    return _tag(rows[:cap]), len(rows) > cap


def _sibling_reports(pages):
    internal = consistency.audit_internal_consistency(pages, max_signals=100, max_hints=100)
    flow = spin.audit_flow_and_spin_triage(pages, max_signals=100, max_hints=100)
    return internal.get("signals") or [], flow.get("triageHints") or []


def _hint_rows(paragraphs, claims, pages):
    signals, flow_hints = _sibling_reports(pages)
    rows = []
    rows.extend(_claim_hints(claims, signals))
    rows.extend(_causal_hints(paragraphs, flow_hints))
    rows.extend(_limitation_hints(paragraphs))
    return rows


def _digest_lines(outline, claims):
    lines = [f"ARGUMENT OUTLINE advisory digest capped at {DIGEST_CAP} characters"]
    for row in outline:
        flags = ",".join(row["flags"]) or "-"
        lines.append(
            f"{row['section']} p{row['pageIndex']}: {row['topicSentence']} [{flags}]"
        )
    lines.append("UNSUPPORTED CLAIMS advisory")
    for row in claims:
        if row["status"] != "unsupported":
            continue
        lines.append(f"{row['section']} p{row['pageIndex']} {row['value']}: {row['claim']}")
    return lines


def _digest(outline, claims):
    text = "\n".join(_digest_lines(outline, claims))
    if len(text) <= DIGEST_CAP:
        return text
    return text[:DIGEST_CAP]


def _report(outline, claims, hints, truncated, digest):
    return {
        "schema": SCHEMA,
        "outline": outline,
        "claimEvidenceMap": claims,
        "triageHints": hints,
        "hintCount": len(hints),
        "truncatedHints": truncated,
        "signals": [],
        "digest": digest,
        "digestCap": DIGEST_CAP,
        "topicCap": TOPIC_CAP,
    }


def audit_argument_outline(pdf_bytes=None, *, segments=None, limit=20):
    """Return an advisory outline. ``limit`` bounds triage hints (1–100, default 20)."""
    _guard(pdf_bytes, segments)
    cap = _bounded_limit(limit)
    pages = _combined_pages(pdf_bytes, segments)
    paragraphs = _paragraphs(pages)
    outline = _outline(paragraphs)
    claims = _claims(paragraphs, _table_blobs(segments))
    hints, truncated = _bound_hints(_hint_rows(paragraphs, claims, pages), cap)
    return _report(outline, claims, hints, truncated, _digest(outline, claims))
