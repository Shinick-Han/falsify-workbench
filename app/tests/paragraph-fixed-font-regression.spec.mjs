import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import * as paragraphPdf from '../dist/paragraph-pdf.mjs';

// Two distinct standard-font resources occur after a table-cell replacement:
// the new cell has WinAnsi encoding while the original page uses Helvetica.
function fixture() {
  const content = `BT /F1 8 Tf 50 467 Td (Group) Tj ET
BT /F2 8 Tf 170 447 Td (11) Tj ET
BT /F1 10 Tf 40 300 Td (Original body paragraph stays lower on the page.) Tj ET\n`;
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 1; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer << /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}

function inspect(bytes) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const page = doc.loadPage(0), structured = page.toStructuredText(), lines = [];
  try {
    structured.walk({beginLine(box) { lines.push({box, text: ''}); }, onChar(c) { lines.at(-1).text += c; }});
    const pix = page.toPixmap([3, 0, 0, 3, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
    try {
      const samples = pix.getPixels(), stride = pix.getStride(), width = pix.getWidth();
      // Compare only the upper 100 PDF points, away from the edited body.
      return {lines, top: Uint8Array.from(samples.subarray(0, stride * 300)), width, stride};
    } finally { pix.destroy(); }
  } finally { structured.destroy(); page.destroy(); doc.destroy(); }
}

test('body resize preserves fixed text using a second Helvetica resource', {timeout: 120000}, async () => {
  const bytes = fixture(), savedFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const u = new URL(input);
    if (u.protocol === 'file:') { const {readFileSync} = await import('node:fs'); return new Response(readFileSync(u)); }
    return savedFetch(input);
  };
  try {
    const out = await paragraphPdf.prepare({file: new File([bytes], 'fixture.pdf'),
      fileHash: createHash('sha256').update(bytes).digest('hex'), edits: [{id: 'body', pageIndex: 0,
        before: 'Original body paragraph stays lower on the page.', after: 'Changed body paragraph stays lower on the page.'}]});
    const before = inspect(bytes), after = inspect(new Uint8Array(await out.file.arrayBuffer()));
    assert.match(after.lines.map(line => line.text).join(' '), /Changed body paragraph stays lower on the page\./);
    assert.deepEqual(after.lines.find(line => line.text === '11'), before.lines.find(line => line.text === '11'));
    assert.equal(after.width, before.width); assert.equal(after.stride, before.stride);
    assert.deepEqual(after.top, before.top);
  } finally { globalThis.fetch = savedFetch; }
});
