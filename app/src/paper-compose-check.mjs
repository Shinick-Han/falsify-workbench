// Byte-derived text comparison for full-document recomposition. The caller supplies
// logical content, not a destination map, as the expectation.
const normalize = value => value.replace(/\s+/gu, ' ').trim();

export async function checkRecomposition({bytes, expectedBlocks, edits = {}, pdfjs, exporter} = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || !pdfjs?.getDocument) throw new TypeError('PDF bytes and PDF.js are required');
  if (!Array.isArray(expectedBlocks) || !expectedBlocks.length || expectedBlocks.some(b => typeof b.id !== 'string' || typeof b.text !== 'string') || new Set(expectedBlocks.map(b => b.id)).size !== expectedBlocks.length) throw new TypeError('unique expected blocks are required');
  if (Object.keys(edits).some(id => !expectedBlocks.some(b => b.id === id) || typeof edits[id] !== 'string')) throw new TypeError('invalid edit');
  const findings = [], pages = [], locations = [];
  let inspectedItems = 0;
  const task = pdfjs.getDocument({data: bytes.slice(), useSystemFonts: true, isEvalSupported: false});
  let doc;
  try {
    doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n), viewport = page.getViewport({scale: 1});
      const content = await page.getTextContent();
      const parts = [];
      let previous = null;
      const frame = viewport.transform;
      const frameSupported = viewport.rotation === 0 && Array.isArray(frame) && frame.length === 6 && frame.every(Number.isFinite) &&
        frame[0] === 1 && frame[1] === 0 && frame[2] === 0 && frame[3] === -1 &&
        Number.isFinite(viewport.width) && Number.isFinite(viewport.height) && viewport.width > 0 && viewport.height > 0;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const t = item.transform, style = content.styles?.[item.fontName];
        const supported = frameSupported && Array.isArray(t) && t.length === 6 && t.every(Number.isFinite) &&
          Number.isFinite(item.width) && item.width >= 0 && Number.isFinite(item.height) && item.height > 0 &&
          t[0] > 0 && t[3] > 0 && Math.abs(t[1]) < 1e-6 && Math.abs(t[2]) < 1e-6 &&
          item.dir === 'ltr' && !style?.vertical;
        let position = null;
        if (supported) {
          const [x, y] = viewport.convertToViewportPoint(t[4], t[5]);
          if (Number.isFinite(x) && Number.isFinite(y)) position = {x, y, width:item.width, height:item.height};
        }
        if (item.str.trim()) {
          inspectedItems++;
          if (!position || !Number.isFinite(style?.ascent) || !Number.isFinite(style?.descent) || style.ascent < 0 || style.descent > 0) {
            findings.push({code:'unsupported-text-geometry', pageIndex:n - 1, text:item.str});
          } else {
            const top = position.y - style.ascent * position.height;
            const bottom = position.y - style.descent * position.height;
            if (position.x < -1 || position.x + position.width > viewport.width + 1 || top < -1 || bottom > viewport.height + 1) findings.push({code:'text-outside-page', pageIndex:n - 1, text:item.str});
          }
        }
        if (previous && item.str && !/\s$/u.test(previous.str) && !/^\s/u.test(item.str)) {
          if (previous.hasEOL) parts.push(' ');
          else if (!position || !previous.position) findings.push({code:'ambiguous-text-geometry', pageIndex:n - 1});
          else {
            const height = Math.max(position.height, previous.position.height);
            const dy = Math.abs(position.y - previous.position.y);
            const gap = position.x - (previous.position.x + previous.position.width);
            if (dy > height * 0.5) parts.push(' ');
            else if (dy > height * 0.1 || gap < -height * 0.1 || (gap > height * 0.1 && gap < height * 0.3)) findings.push({code:'ambiguous-text-geometry', pageIndex:n - 1});
            else if (gap >= height * 0.3) parts.push(' ');
          }
        }
        parts.push(item.str);
        if (item.str) previous = {str:item.str, hasEOL:item.hasEOL, position};
        else if (item.hasEOL && previous) previous.hasEOL = true;
      }
      pages.push(normalize(parts.join('')));
      page.cleanup();
    }
  } finally { await task.destroy(); }
  const observed = normalize(pages.join(' '));
  const expected = normalize(expectedBlocks.map(b => Object.hasOwn(edits,b.id) ? edits[b.id] : b.text).join(' '));
  if (observed !== expected) findings.push({code:'content-mismatch', expected, observed});
  const alignmentAvailable = observed === expected && !findings.some(f => f.code === 'ambiguous-text-geometry' || f.code === 'unsupported-text-geometry');
  if (alignmentAvailable) {
    // Both sequences are normalized as a whole, with one separator between
    // nonempty entries. Offsets therefore follow the validated sequence itself.
    const pageRanges = []; let offset = 0;
    for (const page of pages) {
      if (!page) { pageRanges.push(null); continue; }
      if (offset) offset++;
      pageRanges.push({start:offset, end:offset + page.length});
      offset += page.length;
    }
    offset = 0;
    for (const block of expectedBlocks) {
      const value = normalize(Object.hasOwn(edits,block.id) ? edits[block.id] : block.text);
      if (!value) { locations.push({id:block.id, pageIndexes:[]}); continue; }
      if (offset) offset++;
      const start = offset, end = start + value.length;
      const pageIndexes = pageRanges.flatMap((range, i) => range && range.start < end && range.end > start ? [i] : []);
      locations.push({id:block.id, pageIndexes});
      offset = end;
    }
  }
  const independent = typeof exporter === 'string' && exporter.trim() && !/pdf\.?js/i.test(exporter) ? {status:'declared', reader:'PDF.js text extraction', exporter, limitation:'Distinct named engines only; exporter identity is caller supplied.'} : {status:'unavailable', reader:'PDF.js text extraction', reason:'Exporter path not supplied or uses PDF.js.'};
  return {schema:'falsify.recomposition-check.v1', readable:true, checks:{content:{status:findings.some(f=>f.code==='ambiguous-text-geometry' || f.code==='unsupported-text-geometry') ? 'unavailable' : observed === expected ? 'pass':'finding', comparison:'ordered text with whitespace runs collapsed; ambiguous item geometry is unavailable'}, bounds:{status:findings.some(f=>f.code==='text-outside-page')?'finding':!inspectedItems || findings.some(f=>f.code==='unsupported-text-geometry')?'unavailable':'checked', limitation:'Extracted upright text items only, estimated from font ascent and descent; PDF.js may omit off-page text. Not clipping or ink bounds.'}, movement:alignmentAvailable ? {status:'observed', locations} : {status:'unavailable', locations:null, reason:'Complete ordered text alignment or supported geometry is unavailable.'}, independent, visual:{status:'unavailable', reason:'No raster or visibility inspection.'}, overlap:{status:'unavailable', reason:'Text and asset ownership not established.'}, captionOwnership:{status:'unavailable', reason:'Relations not established from PDF bytes.'}}, findings};
}

