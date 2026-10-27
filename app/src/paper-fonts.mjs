// Coverage is supplied by the host's font parser, not inferred from family names.
export async function inspectFonts(text, fonts = {}) {
  const codepoints = [...new Set(Array.from(text, c => c.codePointAt(0)))];
  if (typeof fonts.hasGlyph !== 'function') return {status:'unavailable', missing:[], detail:'Font coverage API unavailable; full-font coverage and fallback are unverified.'};
  try {
    const missing = [];
    for (const cp of codepoints) if (!(await fonts.hasGlyph(cp))) missing.push(cp);
    return {status:missing.length ? 'missing' : 'covered', missing};
  } catch (error) { return {status:'unavailable', missing:[], detail:`Font coverage failed: ${error.message}`}; }
}

const isScalar = cp => Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

// The supplied text must be the union of all comparison variants.
export async function createFontPlan({text, fonts = []}, {mupdf} = {}) {
  if (typeof text !== 'string' || !Array.isArray(fonts)) throw new TypeError('Expected text and fonts array');
  const codepoints = [...new Set(Array.from(text, c => c.codePointAt(0)))];
  if (!codepoints.every(isScalar)) throw new TypeError('Text contains an invalid Unicode scalar');
  const ids = new Set();
  // Snapshot every input before the first await, including later candidates.
  const snapshots = fonts.map(input => ({input, bytes: input?.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes.slice(0)) : input?.bytes instanceof Uint8Array ? Uint8Array.from(input.bytes) : null}));
  const candidates = [];
  for (const {input, bytes: snapshot} of snapshots) {
    if (!input || typeof input.id !== 'string' || !input.id || ids.has(input.id) || typeof input.family !== 'string' || !input.family) throw new TypeError('Each font needs a unique id and family');
    ids.add(input.id);
    let bytes, sha256 = null, buffer, font;
    const glyphs = new Map();
    let detail = null;
    try {
      if (!snapshot) throw new TypeError('Font bytes unavailable');
      bytes = snapshot;
      sha256 = hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
      if (!mupdf?.Buffer || !mupdf?.Font) throw new Error('MuPDF font API unavailable');
      buffer = new mupdf.Buffer(bytes);
      font = new mupdf.Font(input.id, buffer);
      for (const cp of codepoints) {
        const gid = font.encodeCharacter(cp);
        if (!Number.isInteger(gid) || gid < 0) throw new Error('Invalid glyph result');
        glyphs.set(cp, gid !== 0);
      }
    } catch (error) {
      detail = String(error?.message || error);
      glyphs.clear();
    } finally {
      try { font?.destroy(); } finally { buffer?.destroy(); }
    }
    const coverage = detail ? {status:'unavailable', missing:[], detail} : {status:codepoints.every(cp => glyphs.get(cp)) ? 'covered' : 'missing', missing:codepoints.filter(cp => !glyphs.get(cp))};
    candidates.push(Object.freeze({id:input.id, family:input.family, sha256, coverage: Object.freeze({...coverage, missing:Object.freeze(coverage.missing)}),
      getBytes: () => bytes?.slice() ?? null,
      hasGlyph: cp => isScalar(cp) && glyphs.has(cp) ? glyphs.get(cp) : null}));
  }
  const selected = candidates.find(c => c.coverage.status === 'covered') || null;
  const fallback = codepoints.map(codepoint => {
    const candidate = selected || candidates.find(c => c.hasGlyph(codepoint) === true);
    return Object.freeze({codepoint, fontId:candidate?.id ?? null, family:candidate?.family ?? null});
  });
  const missing = fallback.filter(x => x.fontId === null).map(x => x.codepoint);
  const unavailable = missing.length > 0 && candidates.some(c => c.coverage.status === 'unavailable') || candidates.length === 0;
  const status = unavailable ? 'unavailable' : missing.length ? 'missing' : 'covered';
  return Object.freeze({status, selected, candidates:Object.freeze(candidates), codepoints:Object.freeze(codepoints), missing:Object.freeze(missing), fallback:Object.freeze(fallback),
    hasGlyph: cp => isScalar(cp) && codepoints.includes(cp) ? (fallback.find(x => x.codepoint === cp).fontId !== null ? true : unavailable ? null : false) : null});
}
