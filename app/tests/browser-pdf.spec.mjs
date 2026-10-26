import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import {extname, join} from 'node:path';
import {test} from 'node:test';
import * as mupdf from 'mupdf';
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import {BrowserPdfError, ENGINE, prepare} from '../dist/browser-pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function streamObj(data) {
  const body = Buffer.from(data);
  return Buffer.concat([Buffer.from(`<< /Length ${body.length} >> stream\n`), body, Buffer.from('\nendstream')]);
}

function assemble(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = chunks.reduce((n, c) => n + c.length, 0);
    chunks.push(Buffer.from(`${i} 0 obj\n`), objects[i], Buffer.from('\nendobj\n'));
  }
  const start = chunks.reduce((n, c) => n + c.length, 0);
  const count = objects.length - 1;
  let xref = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= count; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer << /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  return new Uint8Array(Buffer.concat(chunks));
}

function buildPdf(pageBodies, {rotate = []} = {}) {
  const font = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
  const image = Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >> stream\n`),
    pixels, Buffer.from('\nendstream'),
  ]);
  const objects = [null];
  const pageIds = [];
  const contentIds = [];
  let next = 3;
  for (let i = 0; i < pageBodies.length; i++) {
    pageIds.push(next++);
    contentIds.push(next++);
  }
  const fontId = next++;
  const imageId = next++;
  objects[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  objects[2] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] /Count ${pageBodies.length} >>`);
  pageBodies.forEach((body, index) => {
    const turn = rotate[index] ? ` /Rotate ${rotate[index]}` : '';
    objects[pageIds[index]] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${turn} /Contents ${contentIds[index]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> >>`);
    objects[contentIds[index]] = streamObj(body);
  });
  objects[fontId] = font;
  objects[imageId] = image;
  return assemble(objects);
}

const figure = 'q 1 0 0 RG 2 w 72 500 80 40 re S Q\nq 20 0 0 20 400 480 cm /Im1 Do Q\n';
const multi = buildPdf([
  `BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (Keep alpha REPLACE me and beta.) Tj 1 0 0 1 72 682 Tm (Second line stays.) Tj ET\n${figure}`,
  'BT /F1 12 Tf 0 0 0.7 rg 1 0 0 1 72 700 Tm (Untouched control page figure-text.) Tj ET\nq 0 0.4 0.2 RG 3 w 100 100 60 60 re S Q\n',
]);
const rotated = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 400 Tm (Rotate BEFORE here.) Tj ET\n',
], {rotate: [90]});
const longPage = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (HOOK) Tj 1 0 0 1 360 700 Tm (BLOCKER stays to the right.) Tj ET\n',
]);
const crowded = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (HOOK) Tj 1 0 0 1 360 700 Tm (BLOCKER stays to the right.) Tj 1 0 0 1 72 686 Tm (Filled line immediately below the hook.) Tj ET\n',
]);
const cafe = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (The caf\\351 table.) Tj ET\n',
]);
const repeated = buildPdf([
  'BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 700 Tm (See beta and beta.) Tj ET\n',
]);

function fileOf(bytes, name = 'fixture.pdf') {
  return new File([bytes], name, {type: 'application/pdf'});
}
function snapshot(bytes, edits) {
  return {schema: 'falsify.paper-edits.v1', fileHash: sha(bytes), revision: 1, edits};
}
async function bytesOf(file) {
  return new Uint8Array(await file.arrayBuffer());
}
async function pdfText(bytes) {
  const doc = await pdfjs.getDocument({data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false}).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
    page.cleanup();
  }
  if (typeof doc.cleanup === 'function') await doc.cleanup();
  return pages;
}
async function operators(bytes, pageNumber) {
  const doc = await pdfjs.getDocument({data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false}).promise;
  const page = await doc.getPage(pageNumber);
  const list = await page.getOperatorList();
  const names = list.fnArray.map(fn => Object.entries(pdfjs.OPS).find(([, value]) => value === fn)?.[0]);
  if (typeof doc.cleanup === 'function') await doc.cleanup();
  return names;
}
function contentStreams(bytes) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf').asPDF();
  try {
    return Array.from({length: doc.countPages()}, (_, index) => {
      const contents = doc.loadPage(index).getObject().get('Contents');
      const parts = [];
      if (contents.isArray()) for (let i = 0; i < contents.length; i++) parts.push(contents.get(i).readStream().asString());
      else parts.push(contents.readStream().asString());
      return parts.join('\n');
    });
  } finally { doc.destroy(); }
}
function pymupdfAvailable() {
  try {
    execFileSync('python3', ['-c', 'import pymupdf'], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}
function pymupdfInspect(source, output) {
  const script = `
import base64, json, sys, pymupdf
body = json.load(sys.stdin)
def open_pdf(key):
    return pymupdf.open(stream=base64.b64decode(body[key]), filetype='pdf')
src, out = open_pdf('source'), open_pdf('output')
def pix(doc, index):
    return doc[index].get_pixmap(dpi=72, alpha=False, colorspace=pymupdf.csRGB)
a, b = pix(src, 1), pix(out, 1)
diff = sum(1 for x, y in zip(a.samples, b.samples) if x != y) if a.samples == a.samples and len(a.samples) == len(b.samples) else -1
print(json.dumps({
  'texts': [page.get_text('text') for page in out],
  'pages': [src.page_count, out.page_count],
  'untouchedDiff': diff,
  'untouchedSamples': len(a.samples),
  'version': pymupdf.version[1] if isinstance(pymupdf.version, tuple) else str(pymupdf.version),
}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], {
    input: JSON.stringify({source: Buffer.from(source).toString('base64'), output: Buffer.from(output).toString('base64')}),
    maxBuffer: 32 * 1024 * 1024,
  }).toString());
}

test('vendored engine pin and global', () => {
  const manifest = JSON.parse(readFileSync(new URL('../dist/browser-pdf-vendor/manifest.json', import.meta.url), 'utf8'));
  const wasm = readFileSync(new URL('../dist/browser-pdf-vendor/mupdf-wasm.wasm', import.meta.url));
  assert.equal(manifest.version, '1.28.1');
  assert.equal(manifest.license, 'AGPL-3.0-or-later');
  assert.equal(manifest.files['mupdf-wasm.wasm'].sha256, sha(wasm));
  assert.equal(ENGINE.version, '1.28.1');
  assert.equal(typeof globalThis.FalsifyBrowserPdf.prepare, 'function');
  assert.match(readFileSync(new URL('../dist/browser-pdf.js', import.meta.url), 'utf8'), /FalsifyBrowserPdf/);
  assert.match(readFileSync(new URL('../dist/browser-pdf-vendor/NOTICE.md', import.meta.url), 'utf8'), /AGPL/);
});

test('replaces one word, keeps unrelated text, figures, and page count', async () => {
  const result = await prepare({
    file: fileOf(multi, 'paper.pdf'),
    edits: snapshot(multi, [
      {id: 'word', enabled: true, pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human', anchor: {bbox: [120, 60, 210, 110]}},
      {id: 'same', enabled: true, pageIndex: 0, before: 'line', after: 'line', origin: 'human'},
      {id: 'off', enabled: false, pageIndex: 0, before: 'alpha', after: 'zzzz', origin: 'human'},
    ]),
    signal: new AbortController().signal,
  });
  const out = await bytesOf(result.file);
  assert.equal(result.sha256, sha(out));
  assert.notEqual(result.sha256, sha(multi));
  assert.equal(result.file.name, 'paper.edited.pdf');
  assert.equal(result.file.type, 'application/pdf');
  assert.equal(String.fromCharCode(...out.slice(0, 5)), '%PDF-');
  assert.equal(result.pageMap.length, 2);
  assert.deepEqual(result.pageMap[1], {sourcePageIndex: 1, outputPageIndex: 1, continuationPageIndices: []});
  assert.equal(result.verification.status, 'applied');
  assert.equal(result.verification.independent, false);
  assert.equal(result.verification.edits.every(edit => edit.status === 'applied'), true);
  const word = result.verification.edits.find(edit => edit.id === 'word');
  assert.equal(word.font, 'Helvetica');
  assert.equal(word.size, 12);
  assert.deepEqual(word.color, [0, 0, 0]);
  assert.equal(word.fontSubstituted, false);
  const streams = contentStreams(out);
  assert.equal(streams[0].includes('REPLACE'), false);
  assert.equal(streams[0].includes('(AFTER)'), true);
  assert.equal(streams[0].includes('alpha'), true);
  assert.equal(streams[0].includes('Second'), true);
  assert.match(streams[0], /\/Im1\s+Do/);
  assert.match(streams[0], /\bre\b/);
  assert.equal(streams[1].includes('Untouched control page figure-text'), true);
  const pages = await pdfText(out);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].includes('REPLACE'), false);
  assert.equal(pages[0].includes('AFTER'), true);
  assert.equal(pages[0].includes('alpha'), true);
  assert.equal(pages[0].includes('beta'), true);
  assert.equal(pages[0].includes('Second'), true);
  assert.equal(pages[0].includes('zzzz'), false);
  assert.equal(pages[1].includes('Untouched control page figure-text'), true);
  const ops = await operators(out, 1);
  assert.ok(ops.includes('rectangle') || ops.includes('constructPath'), ops.filter(Boolean).join(','));
  assert.ok(ops.some(name => /paintImage|paintXObject/.test(name || '')), ops.filter(Boolean).join(','));
  const other = await operators(out, 2);
  assert.ok(other.includes('rectangle') || other.includes('constructPath'), other.filter(Boolean).join(','));
});

test('pymupdf extraction and untouched-page render when installed', async (t) => {
  if (!pymupdfAvailable()) {
    t.skip('pymupdf is not installed');
    return;
  }
  const result = await prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]),
  });
  const report = pymupdfInspect(multi, await bytesOf(result.file));
  assert.equal(report.pages[0], report.pages[1]);
  assert.equal(report.texts[0].includes('REPLACE'), false);
  assert.equal(report.texts[0].includes('AFTER'), true);
  assert.equal(report.texts[1].includes('Untouched control page figure-text'), true);
  assert.ok(report.untouchedSamples > 0);
  assert.ok(report.untouchedDiff / report.untouchedSamples < 0.002, `untouched raster diff ${report.untouchedDiff}/${report.untouchedSamples} pymupdf ${report.version}`);
});

test('wraps a long After when the line below is free', async () => {
  const after = 'This replacement is intentionally long so the browser editor wraps it onto the open lines below.';
  const result = await prepare({
    file: fileOf(longPage),
    edits: snapshot(longPage, [{id: 'long', pageIndex: 0, before: 'HOOK', after, origin: 'human'}]),
  });
  const out = await bytesOf(result.file);
  const edit = result.verification.edits[0];
  assert.ok(edit.wrappedLines >= 2, 'wrappedLines ' + edit.wrappedLines);
  const text = (await pdfText(out))[0];
  assert.equal(text.includes('HOOK'), false);
  assert.equal(text.includes('BLOCKER'), true);
  assert.equal(text.includes('intentionally'), true);
  assert.equal(text.includes('open'), true);
  assert.equal(contentStreams(out)[0].includes('HOOK'), false);
  assert.equal(result.pageMap.length, 1);
});

test('refuses a long After that would cover the next line', async () => {
  const after = 'This replacement is intentionally long so the browser editor wraps it onto the open lines below.';
  await assert.rejects(() => prepare({
    file: fileOf(crowded),
    edits: snapshot(crowded, [{id: 'long', pageIndex: 0, before: 'HOOK', after, origin: 'human'}]),
  }), error => error instanceof BrowserPdfError && error.code === 'unsupported' && error.details.edits[0].code === 'long-after-no-room');
});

test('non-ASCII WinAnsi replacement and missing Hangul glyphs', async () => {
  const result = await prepare({
    file: fileOf(cafe),
    edits: snapshot(cafe, [{id: 'cafe', pageIndex: 0, before: 'café', after: 'naïve', origin: 'human'}]),
  });
  const text = (await pdfText(await bytesOf(result.file)))[0];
  assert.equal(text.includes('café'), false);
  assert.equal(text.includes('naïve'), true);
  assert.equal(text.includes('table'), true);
  await assert.rejects(() => prepare({
    file: fileOf(cafe),
    edits: snapshot(cafe, [{id: 'hangul', pageIndex: 0, before: 'table', after: '한글', origin: 'human'}]),
  }), error => error instanceof BrowserPdfError && error.code === 'unsupported' && error.details.edits[0].code === 'missing-glyphs');
});

test('rotated page removes Before in user space', async () => {
  const result = await prepare({
    file: fileOf(rotated),
    edits: snapshot(rotated, [{id: 'turn', pageIndex: 0, before: 'BEFORE', after: 'AFTER', origin: 'human'}]),
  });
  const out = await bytesOf(result.file);
  const stream = contentStreams(out)[0];
  assert.equal(stream.includes('BEFORE'), false);
  assert.equal(stream.includes('Rotate'), true);
  assert.equal(stream.includes('here'), true);
  const text = (await pdfText(out))[0];
  assert.equal(text.includes('BEFORE'), false);
  assert.equal(text.includes('AFTER'), true);
  assert.equal(text.includes('Rotate'), true);
});

test('ambiguous, stale, and aborted requests do not return a file', async () => {
  await assert.rejects(() => prepare({
    file: fileOf(repeated),
    edits: snapshot(repeated, [{id: 'dup', pageIndex: 0, before: 'beta', after: 'BETA', origin: 'human'}]),
  }), error => error.code === 'unsupported' && error.details.edits[0].code === 'ambiguous');
  const picked = await prepare({
    file: fileOf(repeated),
    edits: snapshot(repeated, [{id: 'dup', pageIndex: 0, before: 'beta', after: 'BETA', origin: 'human', anchor: {occurrence: 1}}]),
  });
  const pickedText = (await pdfText(await bytesOf(picked.file)))[0];
  assert.equal(pickedText.includes('BETA'), true);
  assert.equal(pickedText.includes('beta'), true);
  await assert.rejects(() => prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]),
    fileHash: '0'.repeat(64),
  }), error => error.code === 'stale-source');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]),
    signal: controller.signal,
  }), error => error.code === 'aborted');
});

function listen(root) {
  const types = {'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json'};
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '');
    if (pathname === 'harness.html') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      res.end('<!doctype html><title>browser-pdf</title><script src="/dist/browser-pdf.js"></script>');
      return;
    }
    const path = join(root, pathname);
    if (path !== root && !path.startsWith(root + '/')) { res.writeHead(403); res.end(); return; }
    try {
      const body = readFileSync(path);
      res.writeHead(200, {'content-type': types[extname(path)] || 'application/octet-stream'});
      res.end(body);
    } catch { res.writeHead(404); res.end('missing'); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('chrome classic loader runs the vendored WASM edit', async (t) => {
  let chromium;
  try { ({chromium} = await import('playwright')); }
  catch { t.skip('playwright is not installed'); return; }
  const server = await listen(new URL('..', import.meta.url).pathname.replace(/\/$/, ''));
  const port = server.address().port;
  let browser;
  try {
    browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/harness.html`, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => globalThis.FalsifyBrowserPdf && typeof globalThis.FalsifyBrowserPdf.prepare === 'function');
    const encoded = Buffer.from(multi).toString('base64');
    const produced = await page.evaluate(async (b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const fileHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const file = new File([bytes], 'paper.pdf', {type: 'application/pdf'});
      const result = await FalsifyBrowserPdf.prepare({
        file,
        edits: {schema: 'falsify.paper-edits.v1', fileHash, edits: [{id: 'word', enabled: true, pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]},
      });
      const out = new Uint8Array(await result.file.arrayBuffer());
      let text = '';
      for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return {b64: btoa(text), sha256: result.sha256, status: result.verification.status, pages: result.pageMap.length, head: text.slice(0, 5)};
    }, encoded);
    assert.deepEqual(errors, []);
    assert.equal(produced.status, 'applied');
    assert.equal(produced.pages, 2);
    assert.equal(produced.head, '%PDF-');
    const out = Uint8Array.from(Buffer.from(produced.b64, 'base64'));
    assert.equal(produced.sha256, sha(out));
    const stream = contentStreams(out)[0];
    assert.equal(stream.includes('REPLACE'), false);
    assert.equal(stream.includes('(AFTER)'), true);
    assert.match(stream, /\/Im1\s+Do/);
  } catch (error) {
    if (/Executable doesn't exist|Failed to launch/i.test(String(error))) {
      t.skip(String(error));
      return;
    }
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('output hash is the returned bytes and quality warnings still return a candidate', async () => {
  const result = await prepare({
    file: fileOf(multi),
    edits: snapshot(multi, [{id: 'word', pageIndex: 0, before: 'REPLACE', after: 'AFTER', origin: 'human'}]),
  });
  const out = await bytesOf(result.file);
  assert.equal(result.sha256, sha(out));
  assert.equal(result.verification.outputSha256, result.sha256);
  assert.equal(result.verification.sourceSha256, sha(multi));
  assert.ok(result.warnings.some(item => item.code === 'extraction-gap'));
  assert.equal(result.verification.quality.removedBefore, true);
  assert.equal(result.verification.quality.presentAfter, true);
  assert.equal((await pdfText(out))[0].includes('AFTER'), true);
});
