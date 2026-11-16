"""Native PDF body text span inspector/mutator and in-memory supplement mutator for coordinated RED."""
import base64
import difflib
import hashlib
from pathlib import Path
import re

import pymupdf

from paper_evidence_text import _order_blocks
from paper_stealth_audit import (BLINDNESS_META_PATTERNS, count_tail_order_jumps, page_font_inventory)
from paper_supplement_audit import infer_supplement_kind
from paper_visual_edit import _font, _span
import preserve

SCHEMA = 'falsify.text-span-mutation.v1'
LIST_SCHEMA = 'falsify.text-span-list.v1'
SUPPLEMENT_SCHEMA = 'falsify.supplement-mutation.v1'

MAX_SUPPLEMENTS = 12
MAX_SUPPLEMENT_BYTES = 10 * 1024 * 1024
MAX_SPAN_LIMIT = 1000
MAX_AFTER_LEN = 4000
ALLOWED_SUPPLEMENT_EXTS = frozenset({'.txt', '.csv', '.tsv', '.json', '.md', '.log', '.py', '.r'})
FORBIDDEN_RED_KEYS = frozenset({
    'before', 'after', 'patch', 'gold', 'why_hard', 'candidateRationales', 'falsify', 'red-plan',
})
_HINT_TOKENS = (
    'intentional', 'fabricated', 'fake-doi', 'red-team', 'injected', 'falsify-red',
    'red-plan', 'answer-key', 'answer_key', 'tampered', '변조', '가짜', '함정', '정답',
)
_BBOX_FINITE = (int, float)


class SpanMutationError(ValueError):
    """Self-healing mutation error carrying structured nearestCandidates and recoveryHint."""

    def __init__(self, code: str, details: dict | None = None):
        super().__init__(code)
        self.code = code
        payload = dict(details or {})
        payload['error'] = code
        payload.setdefault('nearestCandidates', [])
        payload.setdefault('recoveryHint', 'Inspect target text and retry with exact values.')
        self.details = payload


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _require_pdf_bytes(pdf_bytes: bytes) -> bytes:
    if not isinstance(pdf_bytes, (bytes, bytearray)) or not bytes(pdf_bytes).startswith(b'%PDF-'):
        raise ValueError('pdf_invalid')
    return bytes(pdf_bytes)


def _has_blindness_leak(text: str) -> bool:
    low = text.lower()
    if any(tok in low for tok in _HINT_TOKENS):
        return True
    return any(pat.search(text) for pat in BLINDNESS_META_PATTERNS)


def _join_line_spans(raw_spans: list[dict]) -> tuple[str, dict]:
    ordered = sorted(raw_spans, key=lambda s: s['bbox'][0])
    dom = max(ordered, key=lambda s: len(s['text']))
    base_size = float(dom.get('size') or 10.0)
    parts, prev_x1 = [], None
    for sp in ordered:
        txt = sp['text']
        if prev_x1 is not None and parts and not parts[-1].endswith((' ', '\n')) and not txt.startswith(' '):
            if sp['bbox'][0] - prev_x1 > max(1.0, base_size * 0.18):
                parts.append(' ')
        parts.append(txt)
        prev_x1 = max(prev_x1, sp['bbox'][2]) if prev_x1 is not None else sp['bbox'][2]
    return ''.join(parts).strip(), dom


def _valid_spans(raw_line: dict) -> list[dict]:
    spans = []
    for sp in raw_line.get('spans', []):
        bbox = sp.get('bbox')
        if sp.get('text') and isinstance(bbox, (list, tuple)) and len(bbox) == 4:
            spans.append(sp)
    return spans


def _spans_bbox(spans: list[dict]) -> list[float]:
    return [
        float(min(s['bbox'][0] for s in spans)),
        float(min(s['bbox'][1] for s in spans)),
        float(max(s['bbox'][2] for s in spans)),
        float(max(s['bbox'][3] for s in spans)),
    ]


def _extract_line_record(raw_line: dict) -> dict | None:
    spans = _valid_spans(raw_line)
    if not spans:
        return None
    text, dom = _join_line_spans(spans)
    if not text:
        return None
    raw_bbox = raw_line.get('bbox')
    bbox = [float(v) for v in raw_bbox] if raw_bbox else _spans_bbox(spans)
    origin = dom.get('origin')
    return {
        'text': text,
        'bbox': bbox,
        'font': str(dom.get('font') or 'Helvetica'),
        'size': float(dom.get('size') or 10.0),
        'color': int(dom.get('color') or 0),
        'origin': list(origin) if origin else None,
        'spans': spans,
    }


def _extract_page_blocks(page) -> list[dict]:
    data = page.get_text('dict', flags=pymupdf.TEXT_MEDIABOX_CLIP) or {}
    blocks = []
    for raw_block in data.get('blocks', []):
        if raw_block.get('type') != 0:
            continue
        lines = [rec for ln in raw_block.get('lines', []) if (rec := _extract_line_record(ln)) is not None]
        if not lines:
            continue
        bbox = [
            min(ln['bbox'][0] for ln in lines), min(ln['bbox'][1] for ln in lines),
            max(ln['bbox'][2] for ln in lines), max(ln['bbox'][3] for ln in lines),
        ]
        blocks.append({'bbox': bbox, 'lines': lines, 'text': '\n'.join(ln['text'] for ln in lines)})
    return blocks


def _extract_page_lines(page, page_idx: int) -> list[dict]:
    blocks = _extract_page_blocks(page)
    ordered = _order_blocks(blocks, float(page.rect.width))
    lines, line_idx = [], 0
    for blk in ordered:
        for ln in blk['lines']:
            lines.append({
                'spanId': f'p{page_idx}-l{line_idx}',
                'pageIndex': page_idx,
                'bbox': [round(float(v), 2) for v in ln['bbox']],
                'font': ln['font'],
                'size': round(float(ln['size']), 2),
                'color': ln['color'],
                'origin': ln['origin'],
                'text': ln['text'],
                'blockBbox': [round(float(v), 2) for v in blk['bbox']],
                'column': blk.get('column', 'full'),
                'spans': ln['spans'],
            })
            line_idx += 1
    return lines


def _line_matches_query(text: str, needle: str) -> bool:
    if not needle:
        return True
    low = text.lower()
    return needle in low or needle in ' '.join(low.split())


def list_pdf_text_spans(
    pdf_bytes: bytes,
    page_index: int | None = None,
    query: str | None = None,
    limit: int = 200,
) -> dict:
    """List compact reading-order text lines/spans for exact text-span targeting."""
    raw = _require_pdf_bytes(pdf_bytes)
    if isinstance(limit, bool) or type(limit) is not int or not 1 <= limit <= MAX_SPAN_LIMIT:
        raise ValueError('span_limit_invalid')
    if query is not None and not isinstance(query, str):
        raise ValueError('span_query_invalid')
    needle = ' '.join(query.strip().lower().split()) if query else ''
    with pymupdf.open(stream=raw, filetype='pdf') as doc:
        if page_index is not None and (
            isinstance(page_index, bool) or type(page_index) is not int or not 0 <= page_index < len(doc)
        ):
            raise ValueError('paper_evidence_page_invalid')
        indices = [page_index] if page_index is not None else list(range(len(doc)))
        matched = []
        for idx in indices:
            for ln in _extract_page_lines(doc[idx], idx):
                if _line_matches_query(ln['text'], needle):
                    matched.append({
                        'spanId': ln['spanId'],
                        'pageIndex': ln['pageIndex'],
                        'bbox': ln['bbox'],
                        'font': ln['font'],
                        'size': ln['size'],
                        'text': ln['text'],
                    })
    return {
        'schema': LIST_SCHEMA,
        'spanCount': min(len(matched), limit),
        'totalMatches': len(matched),
        'truncated': len(matched) > limit,
        'spans': matched[:limit],
    }


def _line_similarity(target: str, candidate: str) -> float:
    t_low, c_low = target.lower(), candidate.lower()
    if t_low in c_low or c_low in t_low:
        return 0.9 + 0.1 * difflib.SequenceMatcher(None, t_low, c_low).ratio()
    t_tokens = set(re.findall(r'[a-z0-9._-]+', t_low))
    c_tokens = set(re.findall(r'[a-z0-9._-]+', c_low))
    overlap = len(t_tokens & c_tokens) / max(1, len(t_tokens | c_tokens))
    seq = difflib.SequenceMatcher(None, t_low, c_low).ratio()
    return 0.65 * seq + 0.35 * overlap


def _nearest_line_candidates(page_lines: list[dict], target: str, limit: int = 3) -> list[dict]:
    scored = sorted(
        page_lines,
        key=lambda ln: _line_similarity(target, ln['text']),
        reverse=True,
    )
    return [
        {'spanId': ln['spanId'], 'pageIndex': ln['pageIndex'], 'bbox': ln['bbox'], 'text': ln['text']}
        for ln in scored[:limit]
    ]


def _validate_bbox(bbox) -> list[float] | None:
    if bbox is None:
        return None
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        raise SpanMutationError('text_span_bbox_invalid', {
            'recoveryHint': 'bbox must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0.',
        })
    vals = [float(v) for v in bbox]
    if any(isinstance(v, bool) or type(v) not in _BBOX_FINITE for v in bbox) or vals[2] <= vals[0] or vals[3] <= vals[1]:
        raise SpanMutationError('text_span_bbox_invalid', {
            'recoveryHint': 'bbox coordinates must be finite numbers with x1 > x0 and y1 > y0.',
        })
    return vals


def _validate_before_after_occ(op: dict, prefix: str, ctx: dict) -> tuple[str, str, int]:
    before, after, occ = op.get('before'), op.get('after'), op.get('occurrence', 0)
    if not isinstance(before, str) or not before.strip():
        raise SpanMutationError(f'{prefix}_before_invalid', {
            **ctx, 'recoveryHint': 'Provide a non-empty exact string for "before".',
        })
    if not isinstance(after, str) or '\x00' in after or len(after) > MAX_AFTER_LEN or after == before:
        raise SpanMutationError(f'{prefix}_after_invalid', {
            **ctx, 'recoveryHint': 'Provide a valid non-identical "after" string without NUL bytes.',
        })
    if _has_blindness_leak(after):
        raise SpanMutationError(f'{prefix}_blindness_rejected', {
            **ctx, 'recoveryHint': 'Replacement text contains blindness-leaking keywords; use neutral scientific wording.',
        })
    if isinstance(occ, bool) or type(occ) is not int or occ < 0:
        raise SpanMutationError(f'{prefix}_occurrence_invalid', {
            **ctx, 'recoveryHint': 'occurrence must be a non-negative integer.',
        })
    return before, after, occ


def _validate_text_op(op: dict, page_count: int, idx: int) -> dict:
    if not isinstance(op, dict):
        raise ValueError('text_span_operation_invalid')
    op_id = op.get('id') if isinstance(op.get('id'), str) and op.get('id') else f'text-op-{idx}'
    page_idx = op.get('pageIndex')
    if isinstance(page_idx, bool) or type(page_idx) is not int or not 0 <= page_idx < page_count:
        raise SpanMutationError('paper_evidence_page_invalid', {
            'pageIndex': page_idx,
            'recoveryHint': f'pageIndex must be an integer in 0..{max(0, page_count - 1)}.',
        })
    before, after, occ = _validate_before_after_occ(op, 'text_span', {'pageIndex': page_idx})
    span_id = op.get('spanId')
    return {
        'id': op_id,
        'pageIndex': page_idx,
        'before': before,
        'after': after,
        'occurrence': occ,
        'bbox': _validate_bbox(op.get('bbox')),
        'spanId': span_id if isinstance(span_id, str) else None,
    }


def _find_clip_rect(page, page_lines: list[dict], op: dict):
    if op['bbox'] is not None:
        return pymupdf.Rect(op['bbox'])
    if op['spanId']:
        hit = next((ln for ln in page_lines if ln['spanId'] == op['spanId']), None)
        if hit is None:
            raise SpanMutationError('text_span_not_found', {
                'pageIndex': op['pageIndex'],
                'nearestCandidates': _nearest_line_candidates(page_lines, op['before']),
                'recoveryHint': f"spanId '{op['spanId']}' was not found on page {op['pageIndex']}. Call list_text_spans.",
            })
        return pymupdf.Rect(hit['bbox']) + (-2, -2, 2, 2)
    return None


def _match_span_rect(page, page_lines: list[dict], op: dict) -> pymupdf.Rect:
    clip = _find_clip_rect(page, page_lines, op)
    rects = page.search_for(op['before'], clip=clip)
    cands = _nearest_line_candidates(page_lines, op['before'])
    if not rects:
        raise SpanMutationError('text_span_not_found', {
            'pageIndex': op['pageIndex'],
            'nearestCandidates': cands,
            'recoveryHint': (
                f"Exact text '{op['before'][:60]}' not found on page {op['pageIndex']}. "
                'Copy exact text from nearestCandidates or call list_text_spans.'
            ),
        })
    if op['occurrence'] >= len(rects):
        raise SpanMutationError('text_span_occurrence_out_of_range', {
            'pageIndex': op['pageIndex'],
            'matchCount': len(rects),
            'nearestCandidates': cands,
            'recoveryHint': (
                f"Requested occurrence {op['occurrence']}, but found {len(rects)} match(es) on page "
                f"{op['pageIndex']}. Use occurrence in 0..{len(rects) - 1}."
            ),
        })
    return pymupdf.Rect(rects[op['occurrence']])


def _line_for_rect(page_lines: list[dict], rect: pymupdf.Rect) -> dict | None:
    best, best_area = None, 0.0
    for ln in page_lines:
        inter = (pymupdf.Rect(ln['bbox']) & rect).get_area()
        if inter > best_area:
            best, best_area = ln, inter
    return best


def _same_line_ys(rect: pymupdf.Rect) -> float:
    return max(4.0, rect.height * 0.55)


def _max_line_width(page, page_lines, rect: pymupdf.Rect, matched_line: dict | None, orig_size: float) -> float:
    rect_cy = (rect.y0 + rect.y1) / 2.0
    tol = _same_line_ys(rect)
    right_neighbors = [
        sp['bbox'][0]
        for ln in page_lines for sp in ln['spans']
        if abs((sp['bbox'][1] + sp['bbox'][3]) / 2.0 - rect_cy) <= tol and sp['bbox'][0] >= rect.x1 - 1.5
    ]
    right_neighbors.extend(
        w[0] for w in page.get_text('words')
        if abs((w[1] + w[3]) / 2.0 - rect_cy) <= tol and w[0] >= rect.x1 - 1.0
    )
    if right_neighbors:
        return max(rect.width, min(right_neighbors) - rect.x0 - max(1.2, orig_size * 0.18))
    page_w = float(page.rect.width)
    col = matched_line.get('column', 'full') if matched_line else 'full'
    col_right = page_w * 0.48 if col == 'left' else page_w - 36.0
    blk_right = matched_line['blockBbox'][2] if matched_line else rect.x1
    return max(rect.width, min(col_right, max(blk_right + 24.0, rect.x1 + 36.0)) - rect.x0)


def _orig_words(page, rect: pymupdf.Rect) -> list:
    """Original words under the match rect, left to right, captured before redaction."""
    clip = rect + (-0.5, -0.5, 0.5, 0.5)
    try:
        words = page.get_text('words', clip=clip) or []
    except (RuntimeError, ValueError):
        return []
    return sorted(words, key=lambda w: w[0])


def _mean_word_gap(orig_words: list, size: float, orig_size: float) -> float:
    """Original mean word gap, scaled with the font size so shrinking stays proportional."""
    gaps = [orig_words[i + 1][0] - orig_words[i][2] for i in range(len(orig_words) - 1)]
    gaps = [g for g in gaps if g > 0.5]
    if gaps and orig_size > 0:
        return sum(gaps) / len(gaps) * size / orig_size
    return size * 0.28


def _word_positions(font_metrics, words, size: float, orig_words: list, start_x: float,
                    keep_original: bool, orig_size: float) -> list[tuple[float, str]]:
    """Place replacement words one by one; never emit a space character."""
    if keep_original:
        return [(float(ow[0]), word) for word, ow in zip(words, orig_words)]
    gap = _mean_word_gap(orig_words, size, orig_size)
    positions, x = [], start_x
    for word in words:
        positions.append((x, word))
        x += font_metrics.text_length(word, fontsize=size) + gap
    return positions


def _layout_end_x(font_metrics, positions: list[tuple[float, str]], size: float) -> float:
    if not positions:
        return 0.0
    x, word = positions[-1]
    return x + font_metrics.text_length(word, fontsize=size)


def _fit_mode(font_metrics, words, orig_words: list, size: float, orig_size: float,
              rect: pymupdf.Rect, keep_modes: tuple, limit: float) -> tuple[bool | None, list]:
    for keep in keep_modes:
        positions = _word_positions(font_metrics, words, size, orig_words, rect.x0, keep, orig_size)
        if _layout_end_x(font_metrics, positions, size) <= limit + 0.5:
            return keep, positions
    return None, []


def _fit_word_layout(font_metrics, words, orig_words: list, orig_size: float,
                     rect: pymupdf.Rect, max_width: float) -> tuple[float | None, bool | None, list]:
    """Largest font size that fits the budget, preferring the original word x positions."""
    if not words:
        return orig_size, True, []
    min_size = min(orig_size, max(5.5, orig_size * 0.78))
    keep_modes = (True, False) if len(words) == len(orig_words) else (False,)
    limit = rect.x0 + max_width
    keep, positions = _fit_mode(font_metrics, words, orig_words, orig_size, orig_size, rect, keep_modes, limit)
    if keep is not None:
        return orig_size, keep, positions
    keep, positions = _fit_mode(font_metrics, words, orig_words, min_size, orig_size, rect, keep_modes, limit)
    if keep is None:
        return None, None, []
    best = (min_size, keep, positions)
    low, high = min_size, orig_size
    for _ in range(24):
        mid = (low + high) / 2.0
        mode, layout = _fit_mode(font_metrics, words, orig_words, mid, orig_size, rect, keep_modes, limit)
        if mode is None:
            high = mid
            continue
        best, low = (round(mid, 3), mode, layout), mid
    return best


def _color_tuple(color_int: int) -> tuple[float, float, float]:
    return ((color_int >> 16 & 255) / 255.0, (color_int >> 8 & 255) / 255.0, (color_int & 255) / 255.0)


def _font_error(page_lines: list[dict], op: dict, exc: Exception) -> SpanMutationError:
    return SpanMutationError('text_span_font_missing', {
        'pageIndex': op['pageIndex'],
        'nearestCandidates': _nearest_line_candidates(page_lines, op['before']),
        'recoveryHint': f'Font cannot render replacement glyphs ({exc}); use ASCII/standard characters.',
    })


def _plan_page_text_op(doc, page, page_lines: list[dict], op: dict, font_idx: int, prior_rects: list) -> dict:
    rect = _match_span_rect(page, page_lines, op)
    if any((r & rect).get_area() > 0.01 for r in prior_rects):
        raise SpanMutationError('text_span_operations_overlap', {
            'pageIndex': op['pageIndex'],
            'nearestCandidates': _nearest_line_candidates(page_lines, op['before']),
            'recoveryHint': 'Two text-span operations target overlapping regions on the same page.',
        })
    matched_line = _line_for_rect(page_lines, rect)
    span = _span(page, rect)
    if not span.get('origin') and matched_line and matched_line.get('origin'):
        span = {**span, 'origin': matched_line['origin']}
    try:
        font_name, substituted, font_metrics = _font(doc, page, span, op['after'], font_idx)
    except ValueError as exc:
        raise _font_error(page_lines, op, exc) from None
    orig_size = max(4.0, float(span.get('size') or 10.0))
    words = op['after'].split()
    orig_words = _orig_words(page, rect)
    max_width = _max_line_width(page, page_lines, rect, matched_line, orig_size)
    fitted_size, keep_original, positions = _fit_word_layout(
        font_metrics, words, orig_words, orig_size, rect, max_width,
    )
    if fitted_size is None:
        raise SpanMutationError('text_span_no_room', {
            'pageIndex': op['pageIndex'],
            'nearestCandidates': _nearest_line_candidates(page_lines, op['before']),
            'recoveryHint': (
                f"Replacement '{op['after'][:40]}' exceeds available width ({round(max_width, 1)}pt). "
                'Shorten "after" so it fits cleanly inside the column/line.'
            ),
        })
    origin_y = float(span['origin'][1]) if span.get('origin') else float(rect.y1 - max(1.0, fitted_size * 0.2))
    mod_x1 = max(rect.x1, rect.x0 + _layout_end_x(font_metrics, positions, fitted_size))
    return {
        'op': op,
        'rect': rect,
        'modBbox': [round(float(v), 2) for v in (rect.x0, rect.y0, mod_x1, rect.y1)],
        'fontName': font_name,
        'fontSubstituted': substituted,
        'fittedSize': fitted_size,
        'origSize': orig_size,
        'originY': origin_y,
        'color': _color_tuple(int(span.get('color') or 0)),
        'doc': doc,
        'span': span,
        'fontIdx': font_idx,
        'origWords': orig_words,
        'words': words,
        'keepOriginal': keep_original,
        'maxWidth': max_width,
    }


def _insert_plan_words(page, plan: dict) -> None:
    """Re-register the font after redaction, then place words without any space glyph."""
    op = plan['op']
    words = plan['words']
    if not words:
        return
    try:
        font_name, substituted, font_metrics = _font(
            plan['doc'], page, plan['span'], op['after'], plan['fontIdx'],
        )
    except ValueError as exc:
        raise SpanMutationError('text_span_font_missing', {
            'pageIndex': op['pageIndex'],
            'recoveryHint': f'Font cannot render replacement glyphs ({exc}); use ASCII/standard characters.',
        }) from None
    plan['fontName'], plan['fontSubstituted'] = font_name, substituted
    positions = _word_positions(
        font_metrics, words, plan['fittedSize'], plan['origWords'], plan['rect'].x0,
        plan['keepOriginal'], plan['origSize'],
    )
    for x, word in positions:
        page.insert_text(
            (x, plan['originY']),
            word,
            fontname=font_name,
            fontsize=plan['fittedSize'],
            color=plan['color'],
            overlay=True,
        )
    plan['modBbox'][2] = round(
        max(float(plan['rect'].x1), _layout_end_x(font_metrics, positions, plan['fittedSize'])), 2,
    )


def _apply_page_text_plans(page, plans: list[dict]) -> None:
    for plan in plans:
        page.add_redact_annot(plan['rect'], fill=False, cross_out=False)
    page.apply_redactions(images=0, graphics=0, text=0)
    for plan in plans:
        _insert_plan_words(page, plan)


def _text_change_record(plan: dict) -> dict:
    op = plan['op']
    return {
        'id': op['id'],
        'kind': 'text-span',
        'pageIndex': op['pageIndex'],
        'bbox': plan['modBbox'],
        'before': op['before'],
        'after': op['after'],
        'occurrence': op['occurrence'],
        'font': plan['fontName'],
        'fontSubstituted': plan['fontSubstituted'],
        'fontSize': round(float(plan['fittedSize']), 2),
        'originalFontSize': round(float(plan['origSize']), 2),
        'stealth': 'append-insert',
    }


def _plan_rects(doc, validated: list[dict]) -> dict:
    """Resolve every operation's target rectangle on the unedited document."""
    by_page: dict[int, list[dict]] = {}
    for op in validated:
        by_page.setdefault(op['pageIndex'], []).append(op)
    rects = {}
    for page_idx, page_ops in by_page.items():
        page = doc[page_idx]
        page_lines = _extract_page_lines(page, page_idx)
        prior_rects: list = []
        for op in page_ops:
            rect = _match_span_rect(page, page_lines, op)
            if any((r & rect).get_area() > 0.01 for r in prior_rects):
                raise SpanMutationError('text_span_operations_overlap', {
                    'pageIndex': op['pageIndex'],
                    'nearestCandidates': _nearest_line_candidates(page_lines, op['before']),
                    'recoveryHint': 'Two text-span operations target overlapping regions on the same page.',
                })
            prior_rects.append(rect)
            rects[op['id']] = rect
    return rects


def _preserve_patch(op: dict, rect) -> dict:
    """One preserve patch: the caller-verified box scopes the quote to this occurrence."""
    return {
        'label': f"PDF p. {op['pageIndex'] + 1}",
        'before': op['before'],
        'after': op['after'],
        'rect': [round(float(v), 3) for v in (rect.x0, rect.y0, rect.x1, rect.y1)],
    }


def _try_inplace(raw: bytes, items: list[dict]) -> tuple[bytes, set, dict]:
    """Rewrite the original text operators in place; returns (bytes, applied ids, failure reasons).

    The whole batch is attempted first because preserve verifies every edited page; a patch that
    cannot be proved is then retried alone so the rest keep their traceless route.
    """
    patches = [_preserve_patch(item['op'], item['rect']) for item in items]
    try:
        out_bytes, _verification = preserve.export_pdf(raw, patches)
        return out_bytes, {item['op']['id'] for item in items}, {}
    except ValueError:
        pass
    current, applied, failures = raw, set(), {}
    for item in items:
        try:
            current, _verification = preserve.export_pdf(current, [_preserve_patch(item['op'], item['rect'])])
            applied.add(item['op']['id'])
        except ValueError as exc:
            failures[item['op']['id']] = str(exc)[:240]
    return current, applied, failures


def _inplace_record(out_doc, op: dict, rect) -> dict:
    """Change record for an operator rewrite: measured position, original font, no substitution."""
    page = out_doc[op['pageIndex']]
    hits = page.search_for(op['after'], clip=rect + (-2, -2, 2, 2))
    box = pymupdf.Rect(hits[0]) if hits else rect
    span = _span(page, box)
    size = round(float(span.get('size') or 0.0), 2)
    return {
        'id': op['id'],
        'kind': 'text-span',
        'pageIndex': op['pageIndex'],
        'bbox': [round(min(rect.x0, box.x0), 2), round(min(rect.y0, box.y0), 2),
                 round(max(rect.x1, box.x1), 2), round(max(rect.y1, box.y1), 2)],
        'before': op['before'],
        'after': op['after'],
        'occurrence': op['occurrence'],
        'font': str(span.get('font') or ''),
        'fontSubstituted': False,
        'fontSize': size,
        'originalFontSize': size,
        'stealth': 'in-place-operator',
        'logicalTextOrderPreserved': True,
    }


def _apply_redact_insert(raw: bytes, ops: list[dict]) -> tuple[bytes, list[dict], list[dict]]:
    """Fallback route: redact the matched box and append the replacement text (leaves a trace)."""
    with pymupdf.open(stream=raw, filetype='pdf') as doc:
        by_page: dict[int, list[dict]] = {}
        for op in ops:
            by_page.setdefault(op['pageIndex'], []).append(op)
        all_plans = []
        font_idx = 0
        for page_idx, page_ops in by_page.items():
            page = doc[page_idx]
            page_lines = _extract_page_lines(page, page_idx)
            page_plans, prior_rects = [], []
            for op in page_ops:
                plan = _plan_page_text_op(doc, page, page_lines, op, font_idx, prior_rects)
                prior_rects.append(plan['rect'])
                page_plans.append(plan)
                font_idx += 1
            all_plans.append((page, page_plans))
        changes, modified_regions = [], []
        for page, page_plans in all_plans:
            _apply_page_text_plans(page, page_plans)
            for plan in page_plans:
                changes.append(_text_change_record(plan))
                modified_regions.append({'pageIndex': plan['op']['pageIndex'], 'bbox': plan['modBbox']})
        return doc.tobytes(garbage=4, deflate=True), changes, modified_regions


def _trace_report(raw: bytes, out_bytes: bytes, regions: list[dict], fallback_ids) -> dict:
    """Cheap text-layer trace check: appended text, new subset fonts, reading-order jumps."""
    touched = sorted({region['pageIndex'] for region in regions})
    with pymupdf.open(stream=raw, filetype='pdf') as before, pymupdf.open(stream=out_bytes, filetype='pdf') as after:
        font_ok = all(page_font_inventory(before[i]) == page_font_inventory(after[i]) for i in touched)
        jumps = sum(max(0, count_tail_order_jumps(after[i], i) - count_tail_order_jumps(before[i], i))
            for i in touched)
    return {
        'readingOrderOk': jumps == 0,
        'appendOrderJumps': jumps,
        'fontInventoryPreserved': font_ok,
        'appendInsertOps': sorted(fallback_ids),
    }


def _empty_result(raw: bytes) -> dict:
    return {
        'schema': SCHEMA,
        'sourceSha256': _sha256(raw),
        'outputSha256': _sha256(raw),
        'appliedCount': 0,
        'changes': [],
        'modifiedRegions': [],
        'inPlaceCount': 0,
        'fallbackCount': 0,
        'fallbackReasons': {},
        'trace': {'readingOrderOk': True, 'appendOrderJumps': 0, 'fontInventoryPreserved': True, 'appendInsertOps': []},
        'pdfBytes': raw,
    }


def mutate_pdf_text_spans(pdf_bytes: bytes, operations: list[dict], allow_trace: bool = True) -> dict:
    """Apply stealth text-span replacements on an in-memory PDF copy.

    Each operation is first written into the document's own text operator (original font object,
    original word gaps, no redaction and no appended text object). Only when that cannot be proved
    is the old redact-and-insert route used, and every such operation is reported as
    `stealth: 'append-insert'`. With `allow_trace=False` a PDF that still carries a text-layer
    trace is refused instead of being returned.
    """
    raw = _require_pdf_bytes(pdf_bytes)
    if not isinstance(operations, list):
        raise ValueError('text_span_operations_invalid')
    if not operations:
        return _empty_result(raw)
    with pymupdf.open(stream=raw, filetype='pdf') as doc:
        validated = [_validate_text_op(op, len(doc), i) for i, op in enumerate(operations)]
        rects = _plan_rects(doc, validated)
    items = [{'op': op, 'rect': rects[op['id']]} for op in validated]
    out_bytes, applied, failures = _try_inplace(raw, items)
    fallback = [op for op in validated if op['id'] not in applied]
    fallback_changes = []
    if fallback:
        out_bytes, fallback_changes, _fallback_regions = _apply_redact_insert(out_bytes, fallback)
    with pymupdf.open(stream=out_bytes, filetype='pdf') as out_doc:
        by_id = {change['id']: change for change in fallback_changes}
        changes = [_inplace_record(out_doc, item['op'], item['rect']) if item['op']['id'] in applied
                   else by_id[item['op']['id']] for item in items]
    regions = [{'pageIndex': change['pageIndex'], 'bbox': change['bbox']} for change in changes]
    trace = _trace_report(raw, out_bytes, regions, failures)
    if not allow_trace and (trace['appendInsertOps'] or not trace['readingOrderOk']
            or not trace['fontInventoryPreserved']):
        raise SpanMutationError('text_span_trace_detected', {
            'pageIndex': None,
            'trace': trace,
            'fallbackReasons': failures,
            'recoveryHint': (
                'This replacement cannot be written into the original text operator without leaving a '
                'text-layer trace; pass allow_trace or pick an equal-or-shorter replacement inside one line and font.'
            ),
        })
    return {
        'schema': SCHEMA,
        'sourceSha256': _sha256(raw),
        'outputSha256': _sha256(out_bytes),
        'appliedCount': len(changes),
        'changes': changes,
        'modifiedRegions': regions,
        'inPlaceCount': len(applied),
        'fallbackCount': len(fallback),
        'fallbackReasons': failures,
        'trace': trace,
        'pdfBytes': out_bytes,
    }


def _load_single_supplement(path_obj: Path, idx: int, total_bytes: int) -> tuple[dict, int]:
    if path_obj.suffix.lower() not in ALLOWED_SUPPLEMENT_EXTS or not path_obj.is_file():
        raise ValueError('supplement_file_invalid')
    try:
        size = path_obj.stat().st_size
        raw = path_obj.read_bytes()
    except OSError:
        raise ValueError('supplement_file_invalid') from None
    if len(raw) != size or size > MAX_SUPPLEMENT_BYTES or total_bytes + size > MAX_SUPPLEMENT_BYTES:
        raise ValueError('supplement_size_limit')
    if b'\x00' in raw:
        raise ValueError('supplement_encoding_invalid')
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        raise ValueError('supplement_encoding_invalid') from None
    return {
        'supplementId': f'supp-{idx}',
        'name': path_obj.name,
        'kind': infer_supplement_kind(path_obj.name),
        'sha256': _sha256(raw),
        'sizeBytes': size,
        'lineCount': len(text.splitlines()),
        'text': text,
    }, total_bytes + size


def load_red_supplements(paths: list[str | Path] | None) -> list[dict]:
    """Load up to 12 immutable UTF-8 supplement files into memory (max 10 MiB total)."""
    if not paths:
        return []
    if not isinstance(paths, (list, tuple)) or len(paths) > MAX_SUPPLEMENTS:
        raise ValueError('supplement_count_limit')
    loaded, total_bytes = [], 0
    for idx, item in enumerate(paths):
        rec, total_bytes = _load_single_supplement(Path(item), idx, total_bytes)
        loaded.append(rec)
    return loaded


def normalize_supplements(supplements) -> list[dict]:
    """Accept either startup file paths or pre-loaded supplement dicts."""
    if not supplements:
        return []
    if not isinstance(supplements, (list, tuple)) or len(supplements) > MAX_SUPPLEMENTS:
        raise ValueError('supplement_count_limit')
    if all(isinstance(s, (str, Path)) for s in supplements):
        return load_red_supplements(list(supplements))
    out, total = [], 0
    for idx, entry in enumerate(supplements):
        if not isinstance(entry, dict) or not isinstance(entry.get('text'), str) or '\x00' in entry['text']:
            raise ValueError('supplement_entry_invalid')
        name = Path(str(entry.get('name') or f'supplement-{idx}.txt')).name
        raw = entry['text'].encode('utf-8')
        total += len(raw)
        if total > MAX_SUPPLEMENT_BYTES:
            raise ValueError('supplement_size_limit')
        out.append({
            'supplementId': str(entry.get('supplementId') or f'supp-{idx}'),
            'name': name,
            'kind': entry.get('kind') or infer_supplement_kind(name),
            'sha256': _sha256(raw),
            'sizeBytes': len(raw),
            'lineCount': len(entry['text'].splitlines()),
            'text': entry['text'],
        })
    return out


def _nearest_supplement_lines(text: str, target: str, limit: int = 3) -> list[dict]:
    lines = [{'lineNumber': i + 1, 'text': ln} for i, ln in enumerate(text.splitlines()) if ln.strip()]
    ranked = sorted(lines, key=lambda item: _line_similarity(target, item['text']), reverse=True)
    return ranked[:limit]


def _find_occurrences(text: str, needle: str) -> list[int]:
    positions, start = [], 0
    while True:
        pos = text.find(needle, start)
        if pos == -1:
            return positions
        positions.append(pos)
        start = pos + len(needle)


def _resolve_supplement_target(state: dict[str, dict], op: dict) -> dict:
    sid = op.get('supplementId')
    name = op.get('name')
    for rec in state.values():
        if sid and (rec['supplementId'] == sid or rec['name'] == sid):
            return rec
        if name and rec['name'] == name:
            return rec
    cands = [{'supplementId': r['supplementId'], 'name': r['name']} for r in list(state.values())[:3]]
    raise SpanMutationError('supplement_not_found', {
        'pageIndex': None,
        'nearestCandidates': cands,
        'recoveryHint': 'Target supplement not found. Call list_red_supplements for valid supplementId/name.',
    })


def _apply_single_supplement_op(state: dict[str, dict], op: dict, idx: int) -> dict:
    target = _resolve_supplement_target(state, op)
    before, after, occ = _validate_before_after_occ(
        op, 'supplement', {'supplementId': target['supplementId'], 'supplementName': target['name']},
    )
    positions = _find_occurrences(target['text'], before)
    cands = _nearest_supplement_lines(target['text'], before)
    if not positions:
        raise SpanMutationError('supplement_before_not_found', {
            'supplementId': target['supplementId'],
            'supplementName': target['name'],
            'nearestCandidates': cands,
            'recoveryHint': (
                f"Exact 'before' text not found in {target['name']}. "
                'Copy a line from nearestCandidates or call list_red_supplements.'
            ),
        })
    if occ >= len(positions):
        raise SpanMutationError('supplement_occurrence_out_of_range', {
            'supplementId': target['supplementId'],
            'supplementName': target['name'],
            'matchCount': len(positions),
            'nearestCandidates': cands,
            'recoveryHint': f'Requested occurrence {occ}, found {len(positions)} match(es) (0..{len(positions) - 1}).',
        })
    pos = positions[occ]
    target['text'] = target['text'][:pos] + after + target['text'][pos + len(before):]
    op_id = op.get('id') if isinstance(op.get('id'), str) and op.get('id') else f'supp-op-{idx}'
    return {
        'id': op_id,
        'kind': 'supplement-edit',
        'supplementId': target['supplementId'],
        'supplementName': target['name'],
        'before': before,
        'after': after,
        'occurrence': occ,
    }


def assert_blind_supplements(value) -> None:
    """Reject any RED ground-truth keys inside blindSupplements."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key in FORBIDDEN_RED_KEYS:
                raise ValueError(f'forbidden_red_key_{key}')
            assert_blind_supplements(item)
    elif isinstance(value, list):
        for item in value:
            assert_blind_supplements(item)


def mutate_supplements(supplements: list[dict], operations: list[dict]) -> dict:
    """Apply in-memory supplement-edit operations and return blind mutated payloads."""
    state = {rec['supplementId']: dict(rec) for rec in supplements}
    changes = [_apply_single_supplement_op(state, op, idx) for idx, op in enumerate(operations)]
    blind = []
    for rec in state.values():
        raw = rec['text'].encode('utf-8')
        blind.append({
            'supplementId': rec['supplementId'],
            'name': rec['name'],
            'kind': rec['kind'],
            'sha256': _sha256(raw),
            'sizeBytes': len(raw),
            'contentBase64': base64.b64encode(raw).decode('ascii'),
            'text': rec['text'],
        })
    assert_blind_supplements(blind)
    return {
        'schema': SUPPLEMENT_SCHEMA,
        'appliedCount': len(changes),
        'changes': changes,
        'blindSupplements': blind,
    }
