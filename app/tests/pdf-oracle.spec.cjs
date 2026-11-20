'use strict';
// Unit tests for app/tests/helpers/pdf-oracle.cjs (MuPDF text extraction, search, page count,
// content-stream decoding, multipart parsing, and assertSubmittedPdf).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const oracle = require('./helpers/pdf-oracle.cjs');

async function makeSyntheticPdf() {
  const mupdf = await oracle.loadMuPdf();
  const doc = new mupdf.PDFDocument();
  try {
    const font = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
    const pages = [
      'BT /F1 12 Tf 72 720 Td (Page One 0.52 and 0.52) Tj ET\n',
      'BT /F1 12 Tf 72 720 Td (Page Two Table 1: 0.95 untouched) Tj ET\n',
    ];
    for (const stream of pages) {
      const resources = doc.newDictionary();
      const fonts = doc.newDictionary();
      fonts.put('F1', font);
      resources.put('Font', fonts);
      const page = doc.addPage([0, 0, 612, 792], 0, resources, stream);
      doc.insertPage(-1, page);
    }
    const buf = doc.saveToBuffer('garbage=compact');
    try {
      return Buffer.from(buf.asUint8Array());
    } finally {
      buf.destroy();
    }
  } finally {
    doc.destroy();
  }
}

function buildMultipartBody(boundary, metaObj, pdfBytes) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify(metaObj)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pdf"; filename="edited.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    pdfBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

test('pdf-oracle extracts text, searches quads, counts pages, and decodes streams', async () => {
  const pdf = await makeSyntheticPdf();
  assert.equal(await oracle.countPages(pdf), 2);
  const p0 = await oracle.extractText(pdf, 0);
  const p1 = await oracle.extractText(pdf, 1);
  assert.ok(p0.includes('Page One 0.52 and 0.52'));
  assert.ok(p1.includes('0.95 untouched'));

  const hits = await oracle.search(pdf, 0, '0.52');
  assert.equal(hits.length, 2);
  const c0 = oracle.hitCenter(hits[0]);
  const c1 = oracle.hitCenter(hits[1]);
  assert.ok(c0 && c1 && c1[0] > c0[0], 'second 0.52 sits to the right of first 0.52');
  assert.equal(oracle.hasHitNear(hits, c1, 5), true);

  const streams = await oracle.decodePageStreams(pdf, 1);
  assert.equal(streams.length, 1);
  assert.ok(streams[0].includes('0.95 untouched'));

  await assert.rejects(() => oracle.extractText(pdf, 2), RangeError);
});

test('pdf-oracle parseMultipart preserves binary PDF bytes and assertSubmittedPdf verifies R2+R3', async () => {
  const editedPdf = await makeSyntheticPdf();
  const sourcePdf = Buffer.from('%PDF-1.4\n%different-source\n');
  const meta = {
    course: 'quick',
    consentVersion: '2026-11-22.v3',
    editedSha256: oracle.sha256(editedPdf),
    paper: {
      source: 'mission',
      id: '2309.15217',
      title: 'Synthetic',
      license: 'cc-by-4.0',
      sourceSha256: oracle.sha256(sourcePdf),
    },
    declared: [{pageIndex: 0, before: 'old', after: '0.52', defectType: 'number', reason: 'test'}],
  };
  const boundary = '----FalsifyTestBoundary1234';
  const body = buildMultipartBody(boundary, meta, editedPdf);

  const parsed = oracle.parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.pdfFilename, 'edited.pdf');
  assert.equal(parsed.pdfContentType, 'application/pdf');
  assert.equal(Buffer.compare(parsed.pdfBytes, editedPdf), 0);

  // Boundary auto-detection without explicit Content-Type header also works.
  const parsedNoHeader = oracle.parseMultipart(body);
  assert.equal(Buffer.compare(parsedNoHeader.pdfBytes, editedPdf), 0);

  await oracle.assertSubmittedPdf({
    meta: parsed.meta,
    pdfBytes: parsed.pdfBytes,
    sourcePdfBytes: sourcePdf,
    expectedPages: 2,
    consentVersion: '2026-11-22.v3',
    expectations: [
      {pageIndex: 0, mustContain: ['Page One'], mustNotContain: ['MISSING_TOKEN'], exactCounts: [['0.52', 2]], untouched: ['and']},
      {pageIndex: 1, mustContain: ['0.95'], untouched: ['untouched']},
    ],
  });

  // Failing expectation: mustNotContain catches text still present.
  await assert.rejects(() => oracle.assertSubmittedPdf({
    meta: parsed.meta,
    pdfBytes: parsed.pdfBytes,
    expectedPages: 2,
    expectations: [{pageIndex: 1, mustNotContain: ['0.95']}],
  }));
});

test('pdf-oracle reads FALSIFY_BOOTH_MISSION_PDF when available', async t => {
  const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    t.skip('FALSIFY_BOOTH_MISSION_PDF not set');
    return;
  }
  const bytes = fs.readFileSync(pdfPath);
  assert.equal(await oracle.countPages(bytes), 8);
  assert.equal((await oracle.search(bytes, 4, '0.95')).length, 1);
  assert.equal((await oracle.search(bytes, 4, '0.52')).length, 2);
  assert.equal((await oracle.search(bytes, 3, '95%')).length, 1);
  assert.equal((await oracle.search(bytes, 0, '†')).length, 3);
  assert.equal((await oracle.search(bytes, 0, '♢')).length, 2);
});
