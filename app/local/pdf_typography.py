"""Bounded, source-informed spacing fit and in-place text-object edits for single-line PDF changes.

A replacement drawn with the original simple font object (same resource name, size, baseline and
colour) is fitted into the original selection extent only by changing horizontal gaps:

* word gaps (advance after a space glyph) may narrow to the narrowest space the source document
  itself already uses for this font name and size, or to TIGHT_SPACE_RATIO of the natural space
  width when the source is narrower nowhere, but never below MIN_SPACE_RATIO;
* if word gaps alone cannot absorb an overflow, a uniform inter-glyph tracking of at most
  MAX_TRACKING_EM (in em of the font size) tightens non-space gaps; tracking never stretches;
* a shorter replacement is stretched only by word gaps up to the source's own widest space;
  anything left over stays as white space inside the selection (no glyph stretch).

No font substitution, size shrink, horizontal glyph scaling (Tz), reflow or clipping is used;
a replacement that needs more than these limits fails. The resulting spacing is recorded and is
not claimed to be identical to the source spacing.

When possible the replacement is written into the original TJ/Tj operator itself (content order
and the following glyphs' positions are kept by a compensating TJ offset) instead of redacting and
appending a new text object at the end of the page content.
"""
import re
import statistics

MIN_SPACE_RATIO = 0.70
TIGHT_SPACE_RATIO = 0.75
MAX_TRACKING_EM = 0.010
MICRO_OVERLAP_PT = 0.02
EPS = 0.005

def source_space_range(pages_raw, font_matches, size, space_natural):
    """Space advances (pt) the source already uses for this font name/size, from char origins.

    Returns (min, max, median, count); the natural advance if no space was measured.
    """
    advances = []
    for raw in pages_raw:
        for block in raw['blocks']:
            for line in block.get('lines', []):
                if tuple(line['dir']) != (1.0, 0.0): continue
                for span in line['spans']:
                    if not font_matches(span['font']) or abs(span['size'] - size) > 0.01: continue
                    chars = span.get('chars', [])
                    for a, b in zip(chars, chars[1:]):
                        if a['c'] == ' ' and abs(a['origin'][1] - b['origin'][1]) < 0.01:
                            advances.append(b['origin'][0] - a['origin'][0])
    if not advances: return space_natural, space_natural, space_natural, 0
    return min(advances), max(advances), statistics.median(advances), len(advances)

def plan_fit(text, natural, target, size, space_natural, space_range):
    """Per-glyph extra advances (pt) so the replacement occupies at most `target` points.

    `natural` holds each glyph's natural advance in points. Raises ValueError (with the
    measurement and limits) when the bounded adjustments cannot make the replacement fit.
    """
    floor = max(MIN_SPACE_RATIO * space_natural, min(space_range[0], TIGHT_SPACE_RATIO * space_natural))
    ceiling = max(space_range[1], space_natural)
    gaps = range(len(text) - 1)
    spaces = [i for i in gaps if text[i] == ' ']
    others = [i for i in gaps if text[i] != ' ']
    width = sum(natural)
    deficit = target - width
    word, tracking = 0.0, 0.0
    if deficit < 0:
        if spaces: word = max(deficit / len(spaces), floor - space_natural)
        rest = deficit - word * len(spaces)
        if rest < -1e-9:
            tracking = rest / len(others) if others else float('-inf')
            if tracking < -MAX_TRACKING_EM * size - 1e-9:
                raise ValueError(f"After가 원래 텍스트 공간을 초과합니다 (After {width:.2f}pt > 원래 영역 {target:.2f}pt, "
                    f"{width - target:.2f}pt 초과). 원본 문서가 이미 쓰는 단어 간격(최소 {floor:.2f}pt)과 자간 한도 "
                    f"({MAX_TRACKING_EM * size:.2f}pt)로도 맞출 수 없습니다. 더 짧게 수정하세요.")
    elif spaces:
        word = min(deficit / len(spaces), ceiling - space_natural)
    extras = [word if text[i] == ' ' else tracking for i in gaps] + [0.0]
    fitted = width + sum(extras)
    return {'extras': extras, 'wordSpaceAdjustPt': round(word, 4), 'trackingPt': round(tracking, 4),
        'spaceAdvancePt': round(space_natural + word, 4), 'naturalWidthPt': round(width, 3),
        'fittedWidthPt': round(fitted, 3), 'targetWidthPt': round(target, 3),
        'trailingGapPt': round(target - fitted, 3), 'spaceFloorPt': round(floor, 4),
        'spaceCeilingPt': round(ceiling, 4), 'sourceSpaceRangePt': [round(space_range[0], 4), round(space_range[1], 4)],
        'sourceSpaceSamples': space_range[3], 'adjustedWordGaps': len(spaces) if word else 0,
        'adjustedTrackingGaps': len(others) if tracking else 0}

def _verify_advances(chars, after, natural, plan, size):
    gaps = []
    for i, (a, b) in enumerate(zip(chars, chars[1:])):
        advance = b['origin'][0] - a['origin'][0]
        gaps.append(advance)
        if abs(advance - (natural[i] + plan['extras'][i])) > 0.01: raise ValueError('삽입 글자 간격이 계획과 다릅니다.')
        if after[i] == ' ' and advance < plan['spaceFloorPt'] - EPS: raise ValueError('단어 간격이 한도보다 좁습니다.')
        if after[i] != ' ' and advance < natural[i] - MAX_TRACKING_EM * size - EPS: raise ValueError('자간이 한도보다 좁습니다.')
    return gaps


def verify_fit(chars, after, natural, plan, origin, size, end):
    """Check extracted replacement glyphs: text, baseline, advances, gaps, glyph widths, extent."""
    text = ''.join(c['c'] for c in chars).replace('\u00a0', ' ')
    if text != after: raise ValueError('삽입 글자열 추출 검증 실패')
    if abs(chars[0]['origin'][0] - origin[0]) > 0.01 or any(abs(c['origin'][1] - origin[1]) > 0.01 for c in chars):
        raise ValueError('삽입 텍스트의 시작점/기준선이 원본과 다릅니다.')
    gaps = _verify_advances(chars, after, natural, plan, size)
    if chars[-1]['bbox'][2] > end + EPS: raise ValueError('삽입 텍스트가 원래 영역 밖으로 나갑니다.')
    for c, w in zip(chars, natural):
        if abs((c['bbox'][2] - c['bbox'][0]) - w) > 0.01: raise ValueError('삽입 글리프 폭이 원본 글꼴 폭과 다릅니다(가로 비율 변경).')
    words = [g for g, ch in zip(gaps, after) if ch == ' ']
    return {'measuredSpaceAdvancePt': [round(min(words), 3), round(max(words), 3)] if words else None,
        'measuredMinGlyphAdvanceDeltaPt': round(min((g - natural[i] for i, g in enumerate(gaps) if after[i] != ' '), default=0), 4)}

# --- minimal content-stream lexer (strings, arrays, names, numbers, operators) -------------------

DELIM = b'()<>[]{}/%'
WS = b' \t\r\n\f\0'

def _literal(data, i):
    """Parse a literal string starting at data[i] == '('; return (bytes, end)."""
    out, depth, i = bytearray(), 1, i + 1
    while i < len(data):
        c = data[i]
        if c == 0x5C:
            i += 1
            if i >= len(data): break
            e = data[i]
            if e in b'01234567':
                j = i
                while j < len(data) and j < i + 3 and data[j] in b'01234567': j += 1
                out.append(int(data[i:j], 8) & 255); i = j; continue
            if e in b'\r\n':
                i += 2 if data[i:i+2] == b'\r\n' else 1; continue
            out.append({0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12}.get(e, e)); i += 1; continue
        if c == 0x28: depth += 1
        elif c == 0x29:
            depth -= 1
            if depth == 0: return bytes(out), i + 1
        out.append(c); i += 1
    raise ValueError('content string')

def _word_token(c, word, i, j):
    if c == 0x2F: return 'name', word[1:].decode('latin-1'), i, j
    elif re.fullmatch(rb'[+-]?(\d+\.?\d*|\.\d+)', word): return 'num', float(word), i, j
    else:
        if word in (b'BI', b'ID'): raise ValueError('inline image')
        return 'op', word.decode('latin-1'), i, j


def _hex_string(data, i):
    end = data.index(b'>', i)
    hexs = re.sub(rb'\s', b'', data[i+1:end])
    if len(hexs) % 2: hexs += b'0'
    return bytes.fromhex(hexs.decode('ascii')), end + 1


def tokens(data):
    """Yield (kind, value, start, end); kind in num/str/name/op/[/]/<</>>. Raises on inline images."""
    i, n = 0, len(data)
    while i < n:
        c = data[i]
        if c in WS: i += 1; continue
        if c == 0x25:
            while i < n and data[i] not in b'\r\n': i += 1
            continue
        if c == 0x28:
            value, end = _literal(data, i); yield 'str', value, i, end; i = end; continue
        if data[i:i+2] in (b'<<', b'>>'): yield data[i:i+2].decode(), None, i, i + 2; i += 2; continue
        if c == 0x3C:
            value, end = _hex_string(data, i)
            yield 'str', value, i, end; i = end; continue
        if c in b'[]': yield chr(c), None, i, i + 1; i += 1; continue
        j = i + 1 if c == 0x2F else i
        while j < n and data[j] not in WS and data[j] not in DELIM: j += 1
        if j == i: raise ValueError('content token')
        word = data[i:j]
        yield _word_token(c, word, i, j)
        i = j

def _mul(m, n):
    """Affine product m x n of PDF matrices (a, b, c, d, e, f)."""
    return (m[0]*n[0] + m[1]*n[2], m[0]*n[1] + m[1]*n[3], m[2]*n[0] + m[3]*n[2], m[2]*n[1] + m[3]*n[3],
        m[4]*n[0] + m[5]*n[2] + n[4], m[4]*n[1] + m[5]*n[3] + n[5])

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

def _make_show(value, operands, decode, mapping, tm, state, default, size, e, key):
    last = operands[-1] if operands else (None,)
    if value == 'Tj' and last[0] == 'str': items = decode(last[1])
    elif value == 'TJ' and last[0] == 'arr':
        items = []
        for k, v in last[1]:
            if k == 'str': items += decode(v)
            else: items.append(('k', v))
    else: raise LookupError(value)
    glyphs = [v for k, v in items if k == 'g']
    # A ligature code maps to two or more characters; only codes with no mapping are undecodable here.
    pieces = [mapping.get(g, '').replace('\u00a0', ' ') for g in glyphs]
    if any(not piece for piece in pieces): raise LookupError('undecodable')
    m = _mul(tm, state['ctm'])
    sx, sy = (m[0] ** 2 + m[1] ** 2) ** 0.5 * state['fs'], (m[2] ** 2 + m[3] ** 2) ** 0.5 * state['fs']
    spacing = any(state[k] != v for k, v in default.items())
    wrong_size = size is not None and (abs(sx - sy) > 0.01 or abs(sx - size) > 0.01)
    return (last[2], e, items, ''.join(pieces), spacing, wrong_size, key, pieces)


def _set_font_spacing(value, operands, state):
    if value == 'Tf':
        if len(operands) < 2 or operands[-2][0] != 'name' or operands[-1][0] != 'num': raise LookupError('Tf')
        state['font'], state['fs'] = operands[-2][1], operands[-1][1]
    elif value in ('Tc', 'Tw', 'Ts', 'Tz'):
        if not operands or operands[-1][0] != 'num': raise LookupError(value)
        state[value] = operands[-1][1]


def _set_quote_spacing(value, operands, state):
    # aw ac string ": sets word and character spacing for everything that follows.
    if len(operands) < 3 or operands[-1][0] != 'str' or operands[-2][0] != 'num' or operands[-3][0] != 'num': raise LookupError(value)
    state['Tw'], state['Tc'] = operands[-3][1], operands[-2][1]


def _apply_text_state(value, operands, state, stack, tm, font, resource):
    def nums(k):
        tail = operands[-k:]
        return [o[1] for o in tail] if len(tail) == k and all(o[0] == 'num' for o in tail) else None
    if value in ('Tf', 'Tc', 'Tw', 'Ts', 'Tz'):
        _set_font_spacing(value, operands, state)
    elif value == 'q': stack.append(dict(state, tm=tm))
    elif value == 'Q':
        if not stack: raise LookupError('Q')
        state = stack.pop(); state.pop('tm')
    elif value == 'cm':
        m = nums(6)
        if m is None: raise LookupError('cm')
        state['ctm'] = _mul(tuple(m), state['ctm'])
    elif value == 'BT': tm = IDENTITY
    elif value == 'Tm':
        m = nums(6)
        if m is None: raise LookupError('Tm')
        tm = tuple(m)
    elif value in ("'", '"') and font == resource: raise LookupError(value)
    elif value == '"':
        _set_quote_spacing(value, operands, state)
    return state, tm


def find_show(data, resource, mapping, before, size=None, code_bytes=1, squeeze=False):
    """Locate `before` in consecutive Tj/TJ operators of font `resource` (one source line may be
    split into several text objects, e.g. around a hyphen).

    With `squeeze=True` the word spaces of `before` are ignored while matching, because a word gap
    is a TJ offset in most typeset PDFs and never a drawn space glyph. This is how a whole phrase
    is located in the original operators without adding a space glyph.

    `data` is one content stream (bytes) or the page's content streams in order as a list of
    (key, bytes); graphics and text state carry across streams as in the concatenated page
    content. String operands are decoded as big-endian `code_bytes`-byte codes.

    Returns a list of parts (start, end, items, index, count, key): start..end spans operand and
    operator inside stream `key`, items are ('g', code) / ('k', number), and glyphs
    index..index+count of that operator are selected. Returns None when not present; raises
    LookupError when a unique, decodable match cannot be proved (non-default Tc/Tw/Tz/Ts at a
    matched operator, matched operator's effective font size different from `size` or
    anisotropic, q/Q imbalance, incomplete codes, quote operators, duplicate matches, malformed
    or stream-crossing arrays, or a selection that cuts a ligature glyph in half).

    Bounded state model: q/Q save and restore the spacing state, the font resource, the Tf size
    and the CTM; BT resets and Tm sets the text matrix (Td/TD/T* only translate), and the scale of
    Tm x CTM times the Tf size is the effective size. Glyph positions are not interpreted here;
    they are re-measured after export.
    """
    streams = [(None, data)] if isinstance(data, (bytes, bytearray)) else list(data)
    default = {'Tc': 0, 'Tw': 0, 'Ts': 0, 'Tz': 100}
    state, stack, tm, shows = dict(default, font=None, fs=None, ctm=IDENTITY), [], IDENTITY, []
    def decode(raw):
        if len(raw) % code_bytes: raise LookupError('incomplete code')
        return [('g', int.from_bytes(raw[i:i + code_bytes], 'big')) for i in range(0, len(raw), code_bytes)]
    for key, stream in streams:
        operands, array = [], None
        for kind, value, s, e in tokens(stream):
            if kind == '[': array = []; operands.append(('[', s)); continue
            if kind == ']':
                if array is None: raise LookupError('array')
                operands.append(('arr', array, operands.pop()[1], e)); array = None; continue
            if array is not None:
                if kind not in ('str', 'num'): raise LookupError('array item')
                array.append((kind, value)); continue
            if kind != 'op': operands.append((kind, value, s, e)); continue
            font = state['font']
            if value in ('Tj', 'TJ'):
                if font != resource: shows.append(None); operands = []; continue
                show = _make_show(value, operands, decode, mapping, tm, state, default, size, e, key)
                shows.append(show)
            else:
                state, tm = _apply_text_state(value, operands, state, stack, tm, font, resource)
            operands = []
        if array is not None: raise LookupError('array')
    if stack: raise LookupError('unbalanced q')
    return _find_show_parts(shows, before, squeeze)


def _glyph_bounds(pieces, offset, squeeze=False):
    """[(glyph index, char start, char end)] for one show, in absolute character offsets.

    With `squeeze` the word spaces are dropped from the character stream, because typeset PDFs
    express a word gap as a TJ offset rather than a space glyph.
    """
    bounds, at = [], offset
    for index, piece in enumerate(pieces):
        kept = piece.replace(' ', '') if squeeze else piece
        bounds.append((index, at, at + len(kept)))
        at += len(kept)
    return bounds


def _show_text(pieces, squeeze=False):
    return ''.join(p.replace(' ', '') if squeeze else p for p in pieces)


def _selection_glyphs(bounds, lo, hi):
    """Glyph index/count covering characters [lo, hi), or LookupError when a ligature is cut."""
    first = next((index for index, start, _ in bounds if start == lo), None)
    last = next((index for index, _, end in bounds if end == hi), None)
    if first is None or last is None: raise LookupError('ligature')
    count = sum(1 for _, start, _ in bounds if lo <= start < hi)
    if count <= 0: raise LookupError('partial')
    return first, count


def _runs(shows):
    """Consecutive shows drawn with the same font; None separates runs."""
    runs, run = [], []
    for show in shows + [None]:
        if show is None:
            if run: runs.append(run)
            run = []
        else: run.append(show)
    return runs


def _run_parts(run, needle, squeeze):
    """Glyph parts of one run whose text contains `needle` exactly once, else None."""
    chunks = [(_show_text(show[7], squeeze), show) for show in run]
    text = ''.join(chunk for chunk, _ in chunks)
    at = text.find(needle)
    if at < 0: return None
    if text.find(needle, at + 1) >= 0: raise LookupError('duplicate')
    parts, offset, left = [], 0, len(needle)
    for chunk, (start, end, items, _chars, spacing, wrong_size, key, pieces) in chunks:
        lo, hi = max(at - offset, 0), min(at + len(needle) - offset, len(chunk))
        if lo < hi:
            if spacing: raise LookupError('spacing state')
            if wrong_size: raise LookupError('font size')
            index, count = _selection_glyphs(_glyph_bounds(pieces, offset, squeeze), offset + lo, offset + hi)
            parts.append((start, end, items, index, count, key)); left -= hi - lo
        offset += len(chunk)
    if left: raise LookupError('partial')
    return parts


def _find_show_parts(shows, before, squeeze=False):
    needle = before.replace(' ', '') if squeeze else before
    found = [parts for parts in (_run_parts(run, needle, squeeze) for run in _runs(shows)) if parts is not None]
    if len(found) > 1: raise LookupError('duplicate')
    return found[0] if found else None

def _rewrite_selection(items, i, count, codes, extras_units, widths_units, out):
    new_units, old_units, comp = 0.0, 0.0, 0.0
    taken = 0
    while i < len(items) and taken < count:
        k, v = items[i]
        if k == 'g': old_units += widths_units(v); taken += 1
        else: old_units -= v
        i += 1
    if taken != count: raise LookupError('selection outside operator')
    while i < len(items) and items[i][0] == 'k': old_units -= items[i][1]; i += 1
    for code, extra in zip(codes, extras_units):
        out.append(('g', code)); new_units += widths_units(code) + extra
        if abs(extra) > 1e-9: out.append(('k', -extra))
    # Only needed when unselected glyphs of this operator follow the selection.
    if any(k == 'g' for k, _ in items[i:]): out.append(('k', new_units - old_units))
    else: comp = None
    return i, new_units, old_units, comp


def rewrite_items(items, index, count, codes, extras_units, widths_units):
    """Replace glyphs index..index+count with `codes` (each followed by its spacing offset) and one
    compensating offset so the glyph after the selection keeps its original position."""
    out, g, i, new_units, old_units, seen, comp = [], 0, 0, 0.0, 0.0, False, 0.0
    while i < len(items):
        kind, value = items[i]
        if kind == 'g' and g == index and not seen:
            seen = True
            i, new_units, old_units, comp = _rewrite_selection(items, i, count, codes, extras_units, widths_units, out)
            continue
        if kind == 'g': g += 1
        out.append((kind, value)); i += 1
    if not seen: raise LookupError('selection not in operator')
    return out, None if comp is None else new_units - old_units

def serialize_tj(items, code_bytes=1):
    parts, run = [], bytearray()
    for kind, value in items:
        if kind == 'g': run += value.to_bytes(code_bytes, 'big'); continue
        if run: parts.append('<%s>' % run.hex()); run = bytearray()
        if abs(value) > 1e-9: parts.append(('%.4f' % value).rstrip('0').rstrip('.'))
    if run: parts.append('<%s>' % run.hex())
    return ('[' + ' '.join(parts) + '] TJ').encode('ascii')

def rewrite_parts(parts, codes, extras_units, widths_units, code_bytes=1):
    """Splices [(start, end, bytes)]: the replacement goes into the first matched operator and the
    remaining selected glyphs are removed from the following operators of the same source line,
    each keeping its own positioning plus a compensating offset for its unselected glyphs."""
    splices, compensation = [], []
    for k, (start, end, items, index, count, *_) in enumerate(parts):
        new, comp = rewrite_items(items, index, count, codes if k == 0 else [], extras_units if k == 0 else [], widths_units)
        splices.append((start, end, serialize_tj(new, code_bytes))); compensation.append(None if comp is None else round(comp, 3))
    return splices, compensation


# --- word-by-word in-place rewrite (word gaps are TJ offsets, never space glyphs) -------------

def _glyph_items(items):
    """[(item position, glyph index, code)] for one operator's item list."""
    out, glyph = [], 0
    for pos, (kind, value) in enumerate(items):
        if kind == 'g':
            out.append((pos, glyph, value)); glyph += 1
    return out


def _word_glyph_groups(items, index, count, words):
    """[(glyph indices, separator item position or None)] one entry per word.

    A word gap is the widest TJ offsets inside the selection: they must be clearly larger than
    any kerning offset, otherwise the split is not provable.
    """
    glyphs = [(pos, g, code) for pos, g, code in _glyph_items(items) if index <= g < index + count]
    if len(glyphs) != count: raise LookupError('selection outside operator')
    if words == 1: return [([g for _, g, _ in glyphs], None)]
    gaps = [pos for pos in range(glyphs[0][0], glyphs[-1][0]) if items[pos][0] == 'k']
    if len(gaps) < words - 1: raise LookupError('words')
    cut = sorted(sorted(gaps, key=lambda pos: abs(items[pos][1]), reverse=True)[:words - 1])
    if min(abs(items[pos][1]) for pos in cut) < 0.30 * max(abs(items[pos][1]) for pos in cut):
        raise LookupError('words')
    groups, start = [], glyphs[0][0]
    for pos in cut:
        groups.append(([g for at, g, _ in glyphs if start <= at < pos], pos)); start = pos
    groups.append(([g for at, g, _ in glyphs if at >= start], None))
    if any(not members for members, _ in groups): raise LookupError('words')
    return groups


def _word_delta(by_glyph, members, codes, widths_units):
    """Advance change (1/1000 text space) of one replaced word; kerning offsets inside it stay."""
    if len(members) != len(codes): raise LookupError('words')
    old = sum(widths_units(by_glyph[g][1]) for g in members)
    return sum(widths_units(code) for code in codes) - old


def rewrite_words(items, index, count, word_codes, widths_units, code_bytes=1):
    """Replace a selected glyph run word by word inside its original TJ/Tj operator.

    Every word keeps its glyph count, its kerning offsets and its slot: the code of glyph i of
    word k is replaced by the code of character i, and the TJ offset that follows the word absorbs
    the width change so the next word and everything after the selection stay at their positions.
    """
    groups = _word_glyph_groups(items, index, count, len(word_codes))
    by_glyph = {g: (pos, code) for pos, g, code in _glyph_items(items)}
    deltas, head, drop, seps, tail = [], {}, set(), {}, None
    for (members, sep), codes in zip(groups, word_codes):
        deltas.append(round(_word_delta(by_glyph, members, codes, widths_units), 3))
        head[members[0]] = codes
        drop.update(members[1:])
        if sep is not None: seps[sep] = deltas[-1]
        else: tail = deltas[-1]
    out, glyph, i, tail_at = [], 0, 0, None
    last_glyph = groups[-1][0][-1]
    while i < len(items):
        kind, value = items[i]
        if kind == 'g':
            if glyph in head:
                for code in head[glyph]: out.append(('g', code))
            elif glyph not in drop: out.append((kind, value))
            if glyph == last_glyph: tail_at = len(out)
            glyph += 1; i += 1; continue
        out.append(('k', value + seps[i]) if i in seps else (kind, value)); i += 1
    if tail is not None and tail_at is not None and abs(tail) > 1e-9:
        out = _insert_trailing_gap(out, tail_at, tail)
    return out, deltas


def _insert_trailing_gap(out, at, delta):
    """Add the width change to the first TJ offset after the selection, or insert one."""
    for pos in range(at, len(out)):
        kind, value = out[pos]
        if kind == 'g': out.insert(pos, ('k', delta)); return out
        if kind == 'k': out[pos] = ('k', value + delta); return out
    out.append(('k', delta))
    return out


def verify_words(chars, squeezed, natural, origin, size, end):
    """Check a word-by-word replacement: same baseline, natural glyph widths, original extent.

    Word gaps are TJ offsets, so the extracted glyph run carries no space character; spacing is
    asserted where it is observable (each word's first glyph keeps the original word start, which
    the caller verified through unchanged neighbouring glyph positions).
    """
    text = ''.join(c['c'] for c in chars).replace('\u00a0', ' ')
    if text != squeezed: raise ValueError('삽입 글자열 추출 검증 실패')
    if abs(chars[0]['origin'][0] - origin[0]) > 0.01 or any(abs(c['origin'][1] - origin[1]) > 0.01 for c in chars):
        raise ValueError('삽입 텍스트의 시작점/기준선이 원본과 다릅니다.')
    for c, w in zip(chars, natural):
        if abs((c['bbox'][2] - c['bbox'][0]) - w) > 0.01: raise ValueError('삽입 글리프 폭이 원본 글꼴 폭과 다릅니다(가로 비율 변경).')
    if chars[-1]['bbox'][2] > end + EPS: raise ValueError('삽입 텍스트가 원래 영역 밖으로 나갑니다.')
    return {'wordGapMode': 'tj-offset', 'measuredGlyphWidthsPt': [round(n, 3) for n in natural[:1]]}
