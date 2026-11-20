'use strict';
// Node PDF oracle helper built on the vendored MuPDF 1.28.1 WASM module.
// Shared by booth-r1r2-browser.spec.cjs and generator unit tests to prove R2 (extractable text,
// removed original text, content-stream checks) and R3 (PDF magic, byte cap, SHA-256, page count).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const MUPDF_URL = pathToFileURL(path.resolve(__dirname, '../../dist/browser-pdf-vendor/mupdf.js')).href;
const DEFAULT_MAX_PDF_BYTES = 16777216;
let mupdfPromise = null;

function loadMuPdf() {
  if (!mupdfPromise) mupdfPromise = import(MUPDF_URL);
  return mupdfPromise;
}

function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('pdfBytes must be a Buffer, Uint8Array, or ArrayBuffer');
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  const u8 = toUint8Array(bytes);
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(toUint8Array(bytes)).digest('hex');
}

function countOccurrences(text, needle) {
  const hay = String(text || '');
  const sub = String(needle || '');
  if (!sub) return 0;
  let count = 0;
  let at = 0;
  while (true) {
    const found = hay.indexOf(sub, at);
    if (found < 0) return count;
    count += 1;
    at = found + sub.length;
  }
}

async function withDoc(pdfBytes, fn) {
  const mupdf = await loadMuPdf();
  const doc = mupdf.Document.openDocument(toUint8Array(pdfBytes), 'application/pdf');
  try {
    return await fn(doc, mupdf);
  } finally {
    doc.destroy();
  }
}

function checkPageIndex(doc, pageIndex) {
  const total = doc.countPages();
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= total) {
    throw new RangeError(`pageIndex ${pageIndex} out of range 0..${total - 1}`);
  }
  return total;
}

async function countPages(pdfBytes) {
  return withDoc(pdfBytes, doc => doc.countPages());
}

async function extractText(pdfBytes, pageIndex, options = {}) {
  return withDoc(pdfBytes, doc => {
    checkPageIndex(doc, pageIndex);
    const page = doc.loadPage(pageIndex);
    try {
      const st = options && options.flags ? page.toStructuredText(options.flags) : page.toStructuredText();
      try {
        return st.asText();
      } finally {
        st.destroy();
      }
    } finally {
      page.destroy();
    }
  });
}

async function search(pdfBytes, pageIndex, needle, options = {}) {
  const query = String(needle == null ? '' : needle);
  if (!query) return [];
  return withDoc(pdfBytes, doc => {
    checkPageIndex(doc, pageIndex);
    const page = doc.loadPage(pageIndex);
    try {
      const hits = options && Number.isInteger(options.maxHits)
        ? page.search(query, options.maxHits)
        : page.search(query);
      return Array.isArray(hits) ? hits.map(quads => quads.map(q => [...q])) : [];
    } finally {
      page.destroy();
    }
  });
}

function readStreamObj(obj) {
  if (!obj || typeof obj.isStream !== 'function' || !obj.isStream()) return null;
  const buf = obj.readStream();
  try {
    return Buffer.from(buf.asUint8Array());
  } finally {
    buf.destroy();
  }
}

async function pageStreamBuffers(pdfBytes, pageIndex) {
  return withDoc(pdfBytes, doc => {
    checkPageIndex(doc, pageIndex);
    const pdfDoc = doc.asPDF();
    if (!pdfDoc) return [];
    const pageObj = pdfDoc.findPage(pageIndex);
    const contents = pageObj ? pageObj.get('Contents') : null;
    if (!contents) return [];
    const out = [];
    if (typeof contents.isArray === 'function' && contents.isArray()) {
      const len = contents.length;
      for (let i = 0; i < len; i += 1) {
        const chunk = readStreamObj(contents.get(i));
        if (chunk) out.push(chunk);
      }
    } else {
      const chunk = readStreamObj(contents);
      if (chunk) out.push(chunk);
    }
    return out;
  });
}

async function decodePageStreams(pdfBytes, pageIndex) {
  const buffers = await pageStreamBuffers(pdfBytes, pageIndex);
  return buffers.map(buf => buf.toString('latin1'));
}

/* Display-space center [cx, cy] of a MuPDF search hit (array of 8-number quads). */
function hitCenter(hit) {
  if (!Array.isArray(hit) || !hit.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of hit) {
    for (let i = 0; i < 8; i += 2) {
      if (q[i] < minX) minX = q[i];
      if (q[i] > maxX) maxX = q[i];
      if (q[i + 1] < minY) minY = q[i + 1];
      if (q[i + 1] > maxY) maxY = q[i + 1];
    }
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

function hasHitNear(hits, targetCenter, maxDist = 20) {
  return hits.some(hit => {
    const c = hitCenter(hit);
    return c && Math.hypot(c[0] - targetCenter[0], c[1] - targetCenter[1]) <= maxDist;
  });
}

function extractBoundary(body, contentType) {
  if (typeof contentType === 'string') {
    const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    if (match) return match[1] || match[2];
  }
  const lineEnd = body.indexOf(Buffer.from('\r\n'));
  if (lineEnd > 2 && body[0] === 0x2d && body[1] === 0x2d) {
    return body.subarray(2, lineEnd).toString('latin1').trim();
  }
  throw new Error('Could not determine multipart boundary');
}

/* Binary-safe multipart/form-data parser for intercepted POST /v1/booth/submissions bodies. */
function parseMultipart(rawBody, contentType = '') {
  const body = toBuffer(rawBody);
  const boundary = extractBoundary(body, contentType);
  const delim = Buffer.from('--' + boundary, 'latin1');
  const headerSep = Buffer.from('\r\n\r\n', 'latin1');
  const parts = [];
  const fields = {};
  const files = {};

  let cursor = body.indexOf(delim);
  while (cursor >= 0) {
    let start = cursor + delim.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // closing --boundary--
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    else if (body[start] === 0x0a) start += 1;

    const next = body.indexOf(delim, start);
    if (next < 0) break;
    let end = next;
    if (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;
    else if (end >= 1 && body[end - 1] === 0x0a) end -= 1;

    const partBuf = body.subarray(start, end);
    const sepAt = partBuf.indexOf(headerSep);
    if (sepAt >= 0) {
      const headerText = partBuf.subarray(0, sepAt).toString('utf8');
      const data = Buffer.from(partBuf.subarray(sepAt + 4));
      const headers = {};
      for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const disp = headers['content-disposition'] || '';
      const nameMatch = /name="([^"]+)"/i.exec(disp);
      const fileMatch = /filename="([^"]*)"/i.exec(disp);
      const name = nameMatch ? nameMatch[1] : '';
      const filename = fileMatch ? fileMatch[1] : null;
      const partType = headers['content-type'] || '';
      const part = {name, filename, contentType: partType, headers, bytes: data};
      parts.push(part);
      if (name) {
        if (filename !== null) files[name] = {filename, contentType: partType, bytes: data};
        else fields[name] = data.toString('utf8');
      }
    }
    cursor = next;
  }

  let meta = null;
  if (typeof fields.meta === 'string') {
    meta = JSON.parse(fields.meta);
  }
  const pdf = files.pdf || null;
  return {
    boundary,
    parts,
    fields,
    files,
    meta,
    pdfBytes: pdf ? pdf.bytes : null,
    pdfFilename: pdf ? pdf.filename : '',
    pdfContentType: pdf ? pdf.contentType : '',
  };
}

/* Shared R2 + R3 assertion helper for a submitted booth PDF. */
async function assertSubmittedPdf(opts) {
  const {
    meta,
    pdfBytes,
    sourcePdfBytes = null,
    expectedPages = 8,
    maxPdfBytes = DEFAULT_MAX_PDF_BYTES,
    consentVersion = '',
    expectations = [],
    label = 'submitted PDF',
  } = opts || {};

  assert.ok(meta && typeof meta === 'object', `${label}: meta JSON must be present`);
  assert.ok(pdfBytes && pdfBytes.byteLength > 0, `${label}: pdf bytes must be non-empty`);
  const buf = toBuffer(pdfBytes);
  assert.equal(buf.subarray(0, 5).toString('ascii'), '%PDF-', `${label}: must start with %PDF-`);
  assert.ok(buf.byteLength <= maxPdfBytes, `${label}: byteLength ${buf.byteLength} exceeds cap ${maxPdfBytes}`);

  const actualSha = sha256(buf);
  assert.equal(actualSha, meta.editedSha256, `${label}: editedSha256 must match uploaded PDF bytes`);
  assert.ok(meta.paper && typeof meta.paper.sourceSha256 === 'string', `${label}: meta.paper.sourceSha256 required`);
  assert.notEqual(meta.editedSha256, meta.paper.sourceSha256, `${label}: edited PDF must differ from source`);
  if (sourcePdfBytes) {
    assert.equal(meta.paper.sourceSha256, sha256(sourcePdfBytes), `${label}: sourceSha256 must match source PDF`);
  }
  if (consentVersion) {
    assert.equal(meta.consentVersion, consentVersion, `${label}: consentVersion mismatch`);
  }
  assert.ok(Array.isArray(meta.declared) && meta.declared.length >= 1 && meta.declared.length <= 5,
    `${label}: declared length must be 1..5`);

  const pageCount = await countPages(buf);
  assert.equal(pageCount, expectedPages, `${label}: page count must stay ${expectedPages}`);

  const pages = {};
  for (const exp of expectations) {
    const idx = exp.pageIndex;
    const text = await extractText(buf, idx);
    pages[idx] = text;
    assert.equal(text.includes('\0'), false, `${label}: page ${idx + 1} extracted text must not contain NUL bytes`);
    const streams = await decodePageStreams(buf, idx);
    const joinedStreams = streams.join('\n');

    for (const needle of exp.mustContain || []) {
      assert.equal(text.includes(needle), true, `${label}: page ${idx + 1} text must contain ${JSON.stringify(needle)}`);
      const hits = await search(buf, idx, needle);
      assert.ok(hits.length >= 1, `${label}: page ${idx + 1} search must find real text for ${JSON.stringify(needle)}`);
    }
    for (const needle of exp.mustNotContain || []) {
      assert.equal(text.includes(needle), false, `${label}: page ${idx + 1} text must NOT contain ${JSON.stringify(needle)}`);
      const hits = await search(buf, idx, needle);
      assert.equal(hits.length, 0, `${label}: page ${idx + 1} search must find 0 hits for ${JSON.stringify(needle)}`);
      assert.equal(joinedStreams.includes(needle), false, `${label}: page ${idx + 1} content stream must NOT contain literal ${JSON.stringify(needle)}`);
    }
    for (const [needle, expectedCount] of exp.exactCounts || []) {
      assert.equal(countOccurrences(text, needle), expectedCount,
        `${label}: page ${idx + 1} text occurrence count for ${JSON.stringify(needle)} must be ${expectedCount}`);
      const hits = await search(buf, idx, needle);
      assert.equal(hits.length, expectedCount,
        `${label}: page ${idx + 1} search hit count for ${JSON.stringify(needle)} must be ${expectedCount}`);
    }
    for (const needle of exp.untouched || []) {
      assert.equal(text.includes(needle), true, `${label}: page ${idx + 1} untouched text missing ${JSON.stringify(needle)}`);
    }
    for (const needle of exp.streamMustNotContain || []) {
      assert.equal(joinedStreams.includes(needle), false,
        `${label}: page ${idx + 1} content stream must NOT contain ${JSON.stringify(needle)}`);
    }
  }
  return {pageCount, pages};
}

module.exports = {
  loadMuPdf,
  countPages,
  extractText,
  search,
  pageStreamBuffers,
  decodePageStreams,
  hitCenter,
  hasHitNear,
  sha256,
  countOccurrences,
  parseMultipart,
  assertSubmittedPdf,
};
