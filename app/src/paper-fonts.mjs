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
