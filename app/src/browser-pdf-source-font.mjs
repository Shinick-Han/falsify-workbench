/* Bounded source-font lookup and single-byte encoding for same-length numeric
 * cell replacements. Keeps the source page's embedded font resource when every
 * target character maps unambiguously through ToUnicode/Encoding, has a
 * positive width, and exists in the embedded font program. Otherwise returns
 * null so callers fall back to the existing replacement font path.
 */

const NUMERIC_TOKEN_RE = /^[+-]?(?:\d+(?:[.,]\d+)*|\.\d+)%?$/;

const NUMERIC_GLYPHS = Object.freeze({
  0x25: ['percent'],
  0x2b: ['plus'],
  0x2c: ['comma'],
  0x2d: ['hyphen', 'minus'],
  0x2e: ['period'],
  0x30: ['zero'],
  0x31: ['one'],
  0x32: ['two'],
  0x33: ['three'],
  0x34: ['four'],
  0x35: ['five'],
  0x36: ['six'],
  0x37: ['seven'],
  0x38: ['eight'],
  0x39: ['nine'],
});

const STANDARD_ASCII_ENCODINGS = new Set([
  'WinAnsiEncoding',
  'StandardEncoding',
  'MacRomanEncoding',
]);

export function isSameLengthNumericReplacement(originalText, newText) {
  const orig = String(originalText == null ? '' : originalText).replace(/\s+/g, '').trim();
  const next = String(newText == null ? '' : newText).replace(/\s+/g, '').trim();
  if (!orig || orig.length !== next.length) return false;
  return NUMERIC_TOKEN_RE.test(orig) && NUMERIC_TOKEN_RE.test(next);
}

function readStreamBytes(streamObj) {
  const buf = streamObj.readStream();
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy();
  }
}

function recordCmapPair(byteToUnicode, unicodeToByte, conflicts, byte, cp) {
  if (byteToUnicode.has(byte) && byteToUnicode.get(byte) !== cp) {
    conflicts.add(byte);
    return;
  }
  byteToUnicode.set(byte, cp);
  if (unicodeToByte.has(cp) && unicodeToByte.get(cp) !== byte) {
    unicodeToByte.set(cp, -1);
    return;
  }
  unicodeToByte.set(cp, byte);
}

function parseSimpleToUnicode(cmapText) {
  if (!cmapText || /\busecmap\b/.test(cmapText)) return null;
  const byteToUnicode = new Map();
  const unicodeToByte = new Map();
  const conflicts = new Set();

  for (const section of cmapText.matchAll(/\d+\s+beginbfchar\b([\s\S]*?)endbfchar/g)) {
    for (const m of section[1].matchAll(/<([\da-fA-F]{2})>\s*<([\da-fA-F]{4})>/g)) {
      recordCmapPair(byteToUnicode, unicodeToByte, conflicts, parseInt(m[1], 16), parseInt(m[2], 16));
    }
  }
  for (const section of cmapText.matchAll(/\d+\s+beginbfrange\b([\s\S]*?)endbfrange/g)) {
    const body = section[1];
    for (const m of body.matchAll(/<([\da-fA-F]{2})>\s*<([\da-fA-F]{2})>\s*<([\da-fA-F]{4})>/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const start = parseInt(m[3], 16);
      if (hi < lo) continue;
      for (let b = lo; b <= hi; b++) {
        recordCmapPair(byteToUnicode, unicodeToByte, conflicts, b, start + (b - lo));
      }
    }
    for (const m of body.matchAll(/<([\da-fA-F]{2})>\s*<([\da-fA-F]{2})>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const targets = [...m[3].matchAll(/<([\da-fA-F]{4})>/g)];
      for (let i = 0; i < targets.length && lo + i <= hi; i++) {
        recordCmapPair(byteToUnicode, unicodeToByte, conflicts, lo + i, parseInt(targets[i][1], 16));
      }
    }
  }
  for (const b of conflicts) byteToUnicode.delete(b);
  return {byteToUnicode, unicodeToByte};
}

function seedAsciiGlyphs(byteToGlyph) {
  for (const [cpStr, names] of Object.entries(NUMERIC_GLYPHS)) {
    const cp = Number(cpStr);
    byteToGlyph.set(cp, names[0]);
  }
}

function safeResolve(ref) {
  if (!ref || ref.isNull()) return null;
  const resolved = ref.resolve();
  return resolved && !resolved.isNull() ? resolved : null;
}

function applyEncodingDifferences(diffs, byteToGlyph) {
  if (!diffs || !diffs.isArray()) return;
  let code = 0;
  for (let i = 0; i < diffs.length; i++) {
    const item = diffs.get(i);
    if (item.isNumber()) {
      code = item.asNumber();
    } else if (item.isName()) {
      byteToGlyph.set(code, String(item.asName() || ''));
      code += 1;
    }
  }
}

function parseSimpleEncoding(fontObj) {
  const byteToGlyph = new Map();
  const enc = safeResolve(fontObj.get('Encoding'));
  if (!enc) return {byteToGlyph, explicit: false};
  if (enc.isName()) {
    if (STANDARD_ASCII_ENCODINGS.has(String(enc.asName() || ''))) seedAsciiGlyphs(byteToGlyph);
    return {byteToGlyph, explicit: true};
  }
  if (!enc.isDictionary()) return {byteToGlyph, explicit: false};
  const base = enc.get('BaseEncoding');
  if (base && !base.isNull() && STANDARD_ASCII_ENCODINGS.has(String(base.asName() || ''))) {
    seedAsciiGlyphs(byteToGlyph);
  }
  applyEncodingDifferences(safeResolve(enc.get('Differences')), byteToGlyph);
  return {byteToGlyph, explicit: true};
}

function parseCharSet(fontDescriptor) {
  if (!fontDescriptor || fontDescriptor.isNull()) return null;
  const raw = fontDescriptor.get('CharSet');
  if (!raw || raw.isNull()) return null;
  const text = String(raw.asString() || '');
  if (!text) return null;
  const names = new Set();
  for (const m of text.matchAll(/\/([^\s/()<>[\]{}%]+)/g)) names.add(m[1]);
  return names.size ? names : null;
}

function readWidths(fontObj) {
  const widthsObj = safeResolve(fontObj.get('Widths'));
  const firstObj = fontObj.get('FirstChar');
  if (!widthsObj || !widthsObj.isArray() || !firstObj || firstObj.isNull() || !firstObj.isNumber()) return null;
  const widths = [];
  for (let i = 0; i < widthsObj.length; i++) {
    const item = widthsObj.get(i);
    widths.push(item && item.isNumber() ? item.asNumber() : NaN);
  }
  return {firstChar: firstObj.asNumber(), widths};
}

function findUniquePageFont(page, sourceFontName) {
  const resources = safeResolve(page.getObject().getInheritable('Resources'));
  if (!resources) return null;
  const resolved = safeResolve(resources.get('Font'));
  if (!resolved) return null;
  const matches = [];
  resolved.forEach((value, key) => {
    const item = safeResolve(value);
    if (!item || !item.isDictionary()) return;
    const subRef = item.get('Subtype');
    const subtype = subRef && !subRef.isNull() ? String(subRef.asName() || '') : '';
    if (subtype !== 'Type1' && subtype !== 'TrueType') return;
    const baseRef = item.get('BaseFont');
    const base = baseRef && !baseRef.isNull() ? String(baseRef.asName() || '') : '';
    if (base !== sourceFontName) return;
    const indirect = value.isIndirect() ? value.asIndirect() : null;
    matches.push({resName: String(key), fontObj: item, indirect});
  });
  if (!matches.length) return null;
  if (matches.length > 1) {
    const firstIndirect = matches[0].indirect;
    if (firstIndirect === null || matches.some(m => m.indirect !== firstIndirect)) return null;
  }
  return matches[0];
}

function findEmbeddedStream(fontDescriptor) {
  if (!fontDescriptor || fontDescriptor.isNull()) return null;
  for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
    const ref = fontDescriptor.get(key);
    if (!ref.isNull() && ref.isStream()) return ref;
  }
  return null;
}

function embeddedFontHasCodePoints(mupdf, fontDescriptor, baseFont, codePoints) {
  const streamRef = findEmbeddedStream(fontDescriptor);
  if (!streamRef) {
    return !/^[A-Z]{6}\+/.test(baseFont);
  }
  const streamBytes = readStreamBytes(streamRef);
  let font = null;
  try {
    font = new mupdf.Font(baseFont, streamBytes);
    for (const cp of codePoints) {
      if (!(font.encodeCharacter(cp) > 0)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    try { font?.destroy(); } catch { /* ignore */ }
  }
}

function byteForCodePoint(cp, toUnicode, encoding) {
  const expectedNames = NUMERIC_GLYPHS[cp];
  if (!expectedNames) return null;
  if (toUnicode) {
    const b = toUnicode.unicodeToByte.get(cp);
    if (b === undefined || b < 0 || b > 255) return null;
    if (encoding.byteToGlyph.size) {
      const gName = encoding.byteToGlyph.get(b);
      if (!gName || !expectedNames.includes(gName)) return null;
    }
    return {byte: b, glyphName: encoding.byteToGlyph.get(b) || expectedNames[0]};
  }
  if (!encoding.byteToGlyph.size) return null;
  let found = null;
  for (const [b, gName] of encoding.byteToGlyph.entries()) {
    if (!expectedNames.includes(gName)) continue;
    if (found !== null) return null;
    found = {byte: b, glyphName: gName};
  }
  return found;
}

function encodePdfBytes(bytes) {
  const asciiSafe = bytes.every(b => b >= 32 && b <= 126);
  if (asciiSafe) {
    let out = '(';
    for (const b of bytes) {
      if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
      else out += String.fromCharCode(b);
    }
    return out + ')';
  }
  return '<' + bytes.map(b => b.toString(16).padStart(2, '0')).join('') + '>';
}

function loadFontToUnicode(fontObj) {
  const tuRef = fontObj.get('ToUnicode');
  if (!tuRef || tuRef.isNull()) return {ok: true, map: null};
  if (!tuRef.isStream()) return {ok: false, map: null};
  const cmapText = new TextDecoder('latin1').decode(readStreamBytes(tuRef));
  const map = parseSimpleToUnicode(cmapText);
  return {ok: Boolean(map), map};
}

function widthForByte(widthsInfo, byte, fontSize) {
  if (!widthsInfo) return 0;
  const idx = byte - widthsInfo.firstChar;
  const rawW = idx >= 0 && idx < widthsInfo.widths.length ? widthsInfo.widths[idx] : NaN;
  return Number.isFinite(rawW) && rawW > 0 ? (rawW / 1000) * fontSize : NaN;
}

function encodeNumericText(text, toUnicode, encoding, charSet, widthsInfo, fontSize) {
  const bytes = [];
  const codePoints = [];
  let totalWidth = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const mapped = byteForCodePoint(cp, toUnicode, encoding);
    if (!mapped || (charSet && !charSet.has(mapped.glyphName))) return null;
    const w = widthForByte(widthsInfo, mapped.byte, fontSize);
    if (!Number.isFinite(w)) return null;
    totalWidth += w;
    bytes.push(mapped.byte);
    codePoints.push(cp);
  }
  return bytes.length ? {bytes, codePoints, width: widthsInfo ? totalWidth : null} : null;
}

export function resolveSourceFontEncoding(page, sourceFontName, text, fontSize, mupdf) {
  if (!page || !sourceFontName || !text || !(fontSize > 0) || !mupdf) return null;
  const match = findUniquePageFont(page, sourceFontName);
  if (!match || !/^[A-Za-z0-9_.-]+$/.test(match.resName)) return null;
  const {resName, fontObj} = match;

  const tu = loadFontToUnicode(fontObj);
  if (!tu.ok) return null;

  const encoding = parseSimpleEncoding(fontObj);
  const fontDescriptor = safeResolve(fontObj.get('FontDescriptor'));
  const charSet = parseCharSet(fontDescriptor);
  const widthsInfo = readWidths(fontObj);
  const encoded = encodeNumericText(text, tu.map, encoding, charSet, widthsInfo, fontSize);
  if (!encoded) return null;
  if (!embeddedFontHasCodePoints(mupdf, fontDescriptor, sourceFontName, encoded.codePoints)) return null;

  return {
    resName,
    baseFont: sourceFontName,
    bytes: encoded.bytes,
    pdfLiteral: encodePdfBytes(encoded.bytes),
    width: encoded.width,
  };
}
