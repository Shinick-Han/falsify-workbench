// Byte-derived text comparison for full-document recomposition. The caller supplies
// logical content, not a destination map, as the expectation.
const normalize = value => value.replace(/\s+/gu, ' ').trim();

export async function checkRecomposition({bytes, expectedBlocks, edits = {}, pdfjs, exporter} = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || !pdfjs?.getDocument) throw new TypeError('PDF bytes and PDF.js are required');
  if (!Array.isArray(expectedBlocks) || !expectedBlocks.length || expectedBlocks.some(b => typeof b.id !== 'string' || typeof b.text !== 'string') || new Set(expectedBlocks.map(b => b.id)).size !== expectedBlocks.length) throw new TypeError('unique expected blocks are required');
  if (Object.keys(edits).some(id => !expectedBlocks.some(b => b.id === id) || typeof edits[id] !== 'string')) throw new TypeError('invalid edit');
  const findings = [], pages = [], locations = [];
  const task = pdfjs.getDocument({data: bytes.slice(), useSystemFonts: true, isEvalSupported: false});
  let doc;
  try {
    doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n), viewport = page.getViewport({scale: 1});
      const content = await page.getTextContent();
      const parts = [];
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        parts.push(item.str);
        if (item.str.trim()) {
          const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
          const height = Math.abs(item.height), width = Math.abs(item.width);
          // Approximate text bounds, suitable for detecting clear overflow only.
          if (x < -1 || x + width > viewport.width + 1 || y < -1 || y - height > viewport.height + 1) findings.push({code:'text-outside-page', pageIndex:n - 1, text:item.str});
        }
      }
      pages.push(normalize(parts.join(' ')));
      page.cleanup();
    }
  } finally { await task.destroy(); }
  const observed = normalize(pages.join(' '));
  const expected = normalize(expectedBlocks.map(b => Object.hasOwn(edits,b.id) ? edits[b.id] : b.text).join(' '));
  if (observed !== expected) findings.push({code:'content-mismatch', expected, observed});
  let cursor = 0;
  const pageStarts = []; let offset = 0;
  for (const page of pages) { pageStarts.push(offset); offset += page.length + 1; }
  for (const block of expectedBlocks) {
    const value = normalize(Object.hasOwn(edits,block.id) ? edits[block.id] : block.text);
    if (!value) { locations.push({id:block.id, pageIndexes:[]}); continue; }
    const at = observed.indexOf(value, cursor);
    if (at < 0) { locations.push({id:block.id, pageIndexes:null}); continue; }
    const end = at + value.length - 1;
    const indexes = pages.map((p,i) => ({i,start:pageStarts[i],end:pageStarts[i]+p.length-1})).filter(p => p.end >= at && p.start <= end).map(p => p.i);
    locations.push({id:block.id, pageIndexes:indexes}); cursor = at + value.length;
  }
  const independent = typeof exporter === 'string' && exporter.trim() && !/pdf\.?js/i.test(exporter) ? {status:'declared', reader:'PDF.js text extraction', exporter, limitation:'Distinct named engines only; exporter identity is caller supplied.'} : {status:'unavailable', reader:'PDF.js text extraction', reason:'Exporter path not supplied or uses PDF.js.'};
  return {schema:'falsify.recomposition-check.v1', readable:true, checks:{content:{status:observed === expected ? 'pass':'finding', comparison:'ordered text with whitespace runs collapsed'}, bounds:{status:findings.some(f=>f.code==='text-outside-page')?'finding':'checked', limitation:'Approximate text item bounds only.'}, movement:{status:'observed', locations}, independent, visual:{status:'unavailable', reason:'No raster or visibility inspection.'}, overlap:{status:'unavailable', reason:'Text and asset ownership not established.'}, captionOwnership:{status:'unavailable', reason:'Relations not established from PDF bytes.'}}, findings};
}

