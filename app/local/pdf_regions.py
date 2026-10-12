"""Source-located edit regions and edited-page regional QA for pdf_quality (MuPDF only, never output-defined masks).

build_plan derives the private 'falsify.pdf-edit-plan.v1' from the immutable source alone: each selected Before is
anchored in its page's MuPDF character stream with whitespace removed and nothing else normalized, so signs, digits,
hyphens and operators keep their meaning. A missing or repeated anchor is reported, never guessed. Regions are tight
per-line boxes of the selected source characters in MuPDF unrotated page points; styles are their {font, size, color}.
compare_plan only cross-checks a supplied plan against that one: a caller can never define, widen or move what QA
excludes. check_page compares one edited output page with its source page and returns fixed codes only (no text,
coordinates or paths).
"""
import hashlib
import json
import math
import re
from collections import Counter

PLAN_SCHEMA = 'falsify.pdf-edit-plan.v1'
POLICY = 'document-consistency-text'
CODES = ('edited_page_render', 'edited_page_text', 'edited_region_style', 'edited_region_visible')
LIMITS = {'maxPlanBytes': 512 * 1024, 'maxPlanEdits': 64, 'maxEditLines': 64, 'maxStyles': 16, 'maxMaskFraction': 0.5}
BASE_TOL = 0.6           # points: same baseline
POS_TOL = 0.6            # points: same glyph origin on an unedited line
PLAN_TOL = 1.5           # points: a supplied region may differ this much from the located one
MARGIN = 1.5             # points of antialiasing bleed around excluded edited lines
SIZE_TOL = (0.25, 0.03)  # absolute points, fraction of the source size
COLOR_TOL = 8            # RGB channel levels
PIXEL_DELTA = 40         # channel levels a sample must move to count as changed
MINOR_FRACTION = 0.0005  # sub-PIXEL_DELTA samples outside the excluded lines tolerated before it is a warning
INK_DELTA = 64           # channel levels a pixel must differ from its line background to count as ink
_SUBSET = re.compile(r'^[A-Z]{6}\+')
_HEX = re.compile(r'[0-9a-f]{64}')

def font_key(name):
    """Font identity without subset prefix, case, punctuation or a PostScript/Regular suffix."""
    key = re.sub(r'[^a-z0-9]', '', _SUBSET.sub('', name or '').lower())
    return re.sub(r'(?:regular|psmt|mt|ps)+$', '', key) or key

class _Char:
    __slots__ = ('c', 'box', 'base', 'style', 'line', 'block')
    def __init__(self, c, box, base, style, line, block):
        self.c, self.box, self.base, self.style, self.line, self.block = c, box, base, style, line, block

class PageModel:
    def __init__(self, chars): self.chars, self.stream = chars, ''.join(ch.c for ch in chars)

def page_model(page, mupdf, max_chars):
    """Non-whitespace characters (one code point each) of the horizontal text lines in MuPDF extraction order, or None
    over the character budget. Rotated or vertical lines are left to the raster comparison."""
    raw = page.get_text('rawdict', flags=mupdf.TEXT_PRESERVE_WHITESPACE | mupdf.TEXT_MEDIABOX_CLIP)
    chars, line = [], 0
    for block, b in enumerate(raw.get('blocks', ())):
        for l in (b.get('lines', ()) if b.get('type') == 0 else ()):
            line += 1
            d = l.get('dir') or (1, 0)
            if abs(d[1]) > 1e-3 or d[0] <= 0: continue
            for s in l.get('spans', ()):
                font = _SUBSET.sub('', str(s.get('font') or ''))[:64]
                style = (font_key(font), float(s.get('size') or 0), int(s.get('color') or 0) & 0xFFFFFF, font)
                for ch in s.get('chars', ()):
                    for c in ch.get('c', ''):
                        if not c.isspace(): chars.append(_Char(c, tuple(ch['bbox']), ch['origin'][1], style, line, block))
                if len(chars) > max_chars: return None
    return PageModel(chars)

def _find(stream, needle, limit=2):
    hits, i = [], stream.find(needle)
    while i >= 0 and len(hits) < limit: hits.append(i); i = stream.find(needle, i + 1)
    return hits

def locate(model, before):
    """('resolved', selected char indices) for exactly one whitespace-free occurrence; else ('ambiguous'|'unavailable', [])."""
    needle = re.sub(r'\s+', '', before or '')
    hits = _find(model.stream, needle) if needle else []
    if len(hits) != 1: return ('ambiguous' if hits else 'unavailable'), []
    return 'resolved', list(range(hits[0], hits[0] + len(needle)))

def _sha(text): return hashlib.sha256(text.encode('utf-8')).hexdigest()

def _union(boxes):
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))

def build_plan(doc, mupdf, source_sha256, edits, max_chars):
    """(plan, located, models): plan is the private contract dict; located maps edit index -> (selected char indices,
    source styles) of resolved edits; models maps page index -> PageModel, or None when over budget."""
    models, located, entries, taken = {}, {}, [], {}
    for k, e in enumerate(edits):
        p = e.get('pageIndex')
        entry = {'id': f'edit-{k + 1}', 'pageIndex': p, 'beforeSha256': _sha(e['before']), 'afterSha256': _sha(e['after']),
            'status': 'unavailable', 'regions': [], 'styles': []}
        entries.append(entry)
        if type(p) is not int or not 0 <= p < doc.page_count or k >= LIMITS['maxPlanEdits']: continue
        if p not in models: models[p] = page_model(doc[p], mupdf, max_chars)
        if models[p] is None: continue
        chars = models[p].chars
        status, picked = locate(models[p], e['before'])
        lines = {}
        for i in picked: lines.setdefault(chars[i].line, []).append(chars[i].box)
        styles = list(dict.fromkeys(chars[i].style for i in picked))
        if status == 'resolved' and (len(lines) > LIMITS['maxEditLines'] or len(styles) > LIMITS['maxStyles']): status = 'unavailable'
        # Two edits claiming the same source characters cannot both be honoured, so the later one is not guessed.
        if status == 'resolved' and taken.setdefault(p, set()) & set(picked): status = 'ambiguous'
        entry['status'] = status
        if status != 'resolved': continue
        taken[p] |= set(picked)
        located[k] = (picked, styles)
        entry['regions'] = [[round(v, 3) for v in _union(boxes)] for boxes in lines.values()]
        entry['styles'] = [{'font': s[3], 'size': round(s[1], 3), 'color': s[2]} for s in styles]
    states = {e['status'] for e in entries}
    status = 'resolved' if states == {'resolved'} else 'partial' if 'resolved' in states else 'unavailable'
    return {'schema': PLAN_SCHEMA, 'sourceSha256': source_sha256, 'policy': POLICY, 'status': status, 'edits': entries}, located, models

def _num(v): return type(v) in (int, float) and math.isfinite(v)

def _same_regions(got, own):
    if len(got) != len(own): return False
    for r in got:
        if not isinstance(r, list) or len(r) != 4 or not all(_num(v) for v in r) or r[0] >= r[2] or r[1] >= r[3]: return False
    key = lambda r: (r[1], r[0])
    return all(abs(a - b) <= PLAN_TOL for g, o in zip(sorted(got, key=key), sorted(own, key=key)) for a, b in zip(g, o))

def _same_styles(got, own):
    if len(got) != len(own): return False
    for s in got:
        if not isinstance(s, dict) or not isinstance(s.get('font'), str) or len(s['font']) > 128 or not _num(s.get('size')) \
                or s['size'] <= 0 or type(s.get('color')) is not int or not 0 <= s['color'] <= 0xFFFFFF: return False
    key = lambda s: (font_key(s['font']), s['color'], s['size'])
    return all(_style_eq((font_key(g['font']), g['size'], g['color']), (font_key(o['font']), o['size'], o['color']))
        for g, o in zip(sorted(got, key=key), sorted(own, key=key)))

def compare_plan(supplied, plan):
    """'absent' | 'accepted' | 'rejected'. A supplied plan is accepted only when it is well formed, bound to the same
    source bytes and selected Before/After hashes, and agrees with the located plan; it never adds or widens a region."""
    if supplied is None: return 'absent'
    try:
        if not isinstance(supplied, dict) or len(json.dumps(supplied, allow_nan=False)) > LIMITS['maxPlanBytes']: return 'rejected'
        if any(supplied.get(k) != plan[k] for k in ('schema', 'sourceSha256', 'policy', 'status')): return 'rejected'
        got_edits = supplied.get('edits')
        if not isinstance(got_edits, list) or len(got_edits) != len(plan['edits']): return 'rejected'
        for got, own in zip(got_edits, plan['edits']):
            if not isinstance(got, dict) or not isinstance(got.get('id'), str) or type(got.get('pageIndex')) is not int: return 'rejected'
            if not all(_HEX.fullmatch(str(got.get(k))) for k in ('beforeSha256', 'afterSha256')): return 'rejected'
            if any(got.get(k) != own[k] for k in ('pageIndex', 'beforeSha256', 'afterSha256', 'status')): return 'rejected'
            if not isinstance(got.get('regions'), list) or not isinstance(got.get('styles'), list): return 'rejected'
            if own['status'] == 'resolved' and not (_same_regions(got['regions'], own['regions']) and _same_styles(got['styles'], own['styles'])):
                return 'rejected'
        return 'accepted'
    except (TypeError, ValueError, AttributeError, KeyError, RecursionError):
        return 'rejected'

def _style_eq(a, b):
    """(font key, size, RGB int) equality with a bounded size and color tolerance."""
    if a[0] != b[0] or abs(a[1] - b[1]) > max(SIZE_TOL[0], SIZE_TOL[1] * a[1]): return False
    return all(abs(((a[2] >> s) & 255) - ((b[2] >> s) & 255)) <= COLOR_TOL for s in (16, 8, 0))

def _rows(chars):
    """[(baseline, char indices left to right)] grouping characters that share a baseline."""
    rows = []
    for i in sorted(range(len(chars)), key=lambda i: (chars[i].base, chars[i].box[0])):
        if rows and chars[i].base - rows[-1][0] <= BASE_TOL: rows[-1][1].append(i)
        else: rows.append((chars[i].base, [i]))
    return [(base, sorted(idx, key=lambda i: chars[i].box[0])) for base, idx in rows]

def _text(chars, row): return ''.join(chars[i].c for i in row)

def _same_row(S, row, O, orow, placed):
    if len(row) != len(orow): return False
    for i, j in zip(row, orow):
        a, b = S[i], O[j]
        if a.c != b.c or not _style_eq(a.style, b.style): return False
        if placed and (abs(a.base - b.base) > BASE_TOL or abs(a.box[0] - b.box[0]) > POS_TOL): return False
    return True

def _px(pix, page, box, margin=0.0):
    zx, zy = pix.width / page.rect.width, pix.height / page.rect.height
    return (max(0, int((box[0] - margin) * zx)), max(0, int((box[1] - margin) * zy)),
        min(pix.width, math.ceil((box[2] + margin) * zx)), min(pix.height, math.ceil((box[3] + margin) * zy)))

def _masked_diff(pa, pb, page, boxes):
    """'passed' | 'warning' | 'failed' for the same-frame renders outside the given boxes (plus MARGIN)."""
    if (pa.width, pa.height, pa.n, pa.stride) != (pb.width, pb.height, pb.n, pb.stride): return 'failed'
    sa, sb, n, stride = bytearray(pa.samples), bytearray(pb.samples), pa.n, pa.stride
    for box in boxes:
        x0, y0, x1, y1 = _px(pa, page, box, MARGIN)
        if x1 <= x0: continue
        blank = bytes((x1 - x0) * n)
        for y in range(y0, y1):
            o = y * stride + x0 * n
            sa[o:o + len(blank)] = blank; sb[o:o + len(blank)] = blank
    if sa == sb: return 'passed'
    minor = 0
    for y in range(pa.height):
        ra, rb = sa[y * stride:(y + 1) * stride], sb[y * stride:(y + 1) * stride]
        if ra == rb: continue
        for x, z in zip(ra, rb):
            if x != z:
                if abs(x - z) > PIXEL_DELTA: return 'failed'
                minor += 1
    return 'passed' if minor <= MINOR_FRACTION * len(sa) else 'warning'

def _inked(pix, page, chars):
    """Every letter or digit of the given output characters leaves ink against its own line's background."""
    rows = {}
    for ch in chars: rows.setdefault(round(ch.base, 1), []).append(ch)
    n, stride, data = pix.n, pix.stride, pix.samples
    pixel = lambda x, y: data[y * stride + x * n:y * stride + x * n + n]
    for row in rows.values():
        x0, y0, x1, y1 = _px(pix, page, _union([c.box for c in row]))
        background = Counter(pixel(x, y) for y in range(y0, y1) for x in range(x0, x1)).most_common(1)
        if not background: continue
        bg = background[0][0]
        for ch in row:
            if not ch.c.isalnum(): continue
            cx0, cy0, cx1, cy1 = _px(pix, page, ch.box)
            if cx1 <= cx0 or cy1 <= cy0: continue
            if not any(max(abs(p - q) for p, q in zip(pixel(x, y), bg)) > INK_DELTA for y in range(cy0, cy1) for x in range(cx0, cx1)):
                return False
    return True

def _box_eq(a, b): return all(abs(x - y) <= 0.01 for x, y in zip(a, b))

def check_page(src_page, out_page, model, picks, mupdf, raster, max_chars):
    """Regional QA of one edited output page against its source page. picks: [(selected source char indices, After,
    source styles)] for every edit on the page, all resolved. Returns ({code: status}, {limitation keys})."""
    if src_page.rotation or not _box_eq(src_page.cropbox, src_page.mediabox):
        return dict.fromkeys(CODES, 'warning'), {'regional_partial'}
    if out_page.rotation or not _box_eq(out_page.mediabox, src_page.mediabox) or not _box_eq(out_page.cropbox, out_page.mediabox):
        return {'edited_page_render': 'failed'}, {'regional'}
    out_model = page_model(out_page, mupdf, max_chars)
    if out_model is None: return dict.fromkeys(CODES, 'warning'), {'budget'}
    S, O, res, notes = model.chars, out_model.chars, {}, {'regional'}
    selected, first, afters = {}, {}, {}
    for k, (picked, after, _) in enumerate(picks):
        selected.update(dict.fromkeys(picked, k))
        first[k], afters[k] = min(picked), re.sub(r'\s+', '', after)
    src_rows, out_rows = _rows(S), _rows(O)
    row_of = {i: r for r, (_, row) in enumerate(src_rows) for i in row}
    edited = sorted({row_of[i] for i in selected})
    # Expected characters of the edited lines: unselected source characters kept, each Before replaced by its After.
    expected = []
    for r in edited:
        for i in src_rows[r][1]:
            k = selected.get(i)
            if k is None: expected.append((S[i].c, i, None))
            elif i == first[k]: expected += [(c, None, k) for c in afters[k]]
    # Same placement: every edited source line has exactly one output line on its baseline, and together they hold
    # exactly the expected characters. Anything else is reflow, which is only partially compared.
    used, mapped, strict = set(), [], True
    for r in edited:
        near = [q for q, (base, _) in enumerate(out_rows) if abs(base - src_rows[r][0]) <= BASE_TOL and q not in used]
        if len(near) != 1: strict = False; break
        used.add(near[0]); mapped.append(near[0])
    aligned = [j for q in mapped for j in out_rows[q][1]] if strict else []
    strict = strict and ''.join(O[j].c for j in aligned) == ''.join(c for c, _, _ in expected)
    if not strict: used = set()
    blocks, edited_set, by_text = {S[i].block for i in selected}, set(edited), {}
    for q, (_, row) in enumerate(out_rows):
        if q not in used: by_text.setdefault(_text(O, row), []).append(q)
    lost = restyled = moved = False
    for r, (_, row) in enumerate(src_rows):
        if r in edited_set or (not strict and any(S[i].block in blocks for i in row)): continue
        hits = [q for q in by_text.get(_text(S, row), ()) if q not in used]
        match = next((q for q in hits if _same_row(S, row, O, out_rows[q][1], True)), None)
        if match is None:
            match = next((q for q in hits if _same_row(S, row, O, out_rows[q][1], False)), None)
            if match is not None: moved = True
            elif hits: match, restyled = hits[0], True
            else: lost = True
        if match is not None: used.add(match)
    boxes, style_bad, unknown = {k: [] for k in afters}, False, False
    if strict:
        for (_, i, k), j in zip(expected, aligned):
            if k is None: restyled |= not _style_eq(S[i].style, O[j].style)
            else:
                boxes[k].append(O[j])
                style_bad |= not any(_style_eq(s, O[j].style) for s in picks[k][2])
        res['edited_page_text'] = 'failed' if lost or restyled or moved else 'warning' if len(used) < len(out_rows) else 'passed'
    else:
        notes.add('regional_partial')
        res['edited_page_text'] = 'failed' if lost or restyled else 'warning'
        for k, after in afters.items():
            hits = _find(out_model.stream, after)
            if len(hits) != 1: unknown = True; continue
            boxes[k] = O[hits[0]:hits[0] + len(after)]
            style_bad |= not all(any(_style_eq(s, ch.style) for s in picks[k][2]) for ch in boxes[k])
    res['edited_region_style'] = 'failed' if style_bad else 'warning' if unknown else 'passed'
    trace = out_page.get_texttrace()
    if sum(len(s.get('chars', ())) for s in trace) > max_chars:
        notes.add('budget'); res['edited_region_visible'] = 'warning'; trace = None
    pb = raster(out_page)
    if trace is not None:
        hidden = [s['bbox'] for s in trace if s.get('type') == 3 or s.get('opacity', 1) == 0]
        overlaps = lambda a, b: min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])
        invisible = any(overlaps(ch.box, h) for chars in boxes.values() for ch in chars for h in hidden) \
            or not all(_inked(pb, out_page, chars) for chars in boxes.values() if chars)
        res['edited_region_visible'] = 'failed' if invisible else 'warning' if unknown else 'passed'
    if not strict:
        res['edited_page_render'] = 'warning'; return res, notes
    excluded = [_union([S[i].box for i in src_rows[r][1]]) for r in edited] + [_union([O[j].box for j in out_rows[q][1]]) for q in mapped]
    area = sum((b[2] - b[0] + 2 * MARGIN) * (b[3] - b[1] + 2 * MARGIN) for b in excluded)
    if area > LIMITS['maxMaskFraction'] * src_page.rect.width * src_page.rect.height:
        notes.add('regional_partial'); res['edited_page_render'] = 'warning'
    else: res['edited_page_render'] = _masked_diff(raster(src_page), pb, src_page, excluded)
    return res, notes
