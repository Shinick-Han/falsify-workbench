// blind-pdf.js (the page side): the arXiv trust skip is bound to the fetched bytes, and every other PDF
// still goes through the MuPDF marker check in the module worker. Synthetic PDFs only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';

const pageUrl = new URL('../dist/blind-pdf.js?v=test', import.meta.url).href;
const workerModule = new URL('../dist/blind-pdf-worker.mjs', import.meta.url).href;
const source = await readFile(fileURLToPath(new URL('../dist/blind-pdf.js', import.meta.url)), 'utf8');

// Same marker and banner as blind-pdf.spec.mjs: the RED training copy footer.
const hex = '46414c5349465920524544205445414d20545241494e494e4720434f505920207c2020494e54454e54494f4e414c4c5920414c544552454420207c20204e4f54204f524947494e414c';
const marker = `\nq\nBT\n1 0 0 1 30 17.8 Tm\n/helv 7.1 Tf .55 .25 .14 RG .55 .25 .14 rg [<${hex}>]TJ\nET\nQ\n`;
const banner = '\nq\n25 13 562 14 re\nh\n.98 .94 .87 rg f\nQ\n';
const body = 'BT /helv 12 Tf 30 700 Td (Publisher and body remain) Tj ET';
function pdf(marked, pages = 2) {
  const d = new mupdf.PDFDocument(), font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < pages; i++) {
    d.insertPage(-1, d.addPage([0, 0, 612, 792], 0, {Font: {helv: font}}, body));
    const p = d.findPage(i), prev = p.get('Contents');
    if (marked) p.put('Contents', [prev, d.addStream(banner, {}), d.addStream(marker, {})]);
  }
  const b = d.saveToBuffer(), bytes = b.asUint8Array().slice(); b.destroy(); d.destroy(); return bytes;
}
function text(bytes, i = 0) { const d = new mupdf.PDFDocument(bytes); try { return d.loadPage(i).toStructuredText().asText(); } finally { d.destroy(); } }
const CLEAN = pdf(false), MARKED = pdf(true);

/* A module Worker stand-in: runs the real blind-pdf-worker.mjs in this process. */
let workers = 0, modules = 0;
class FakeWorker {
  constructor(url, options) {
    assert.equal(options.type, 'module');
    workers += 1;
    const scope = {postMessage: data => queueMicrotask(() => this.onmessage && this.onmessage({data}))};
    this.ready = (async () => { globalThis.self = scope; await import(workerModule + '?w=' + (++modules)); this.scope = scope; })();
  }
  postMessage(data) { void this.ready.then(() => this.scope.onmessage({data})); }
  terminate() {}
}
/* A fresh page: blind-pdf.js runs against its own root, as a reload would. */
function loadPage() {
  const root = {};
  new Function('globalThis', 'document', 'Worker', source)(root, {currentScript: {src: pageUrl}}, FakeWorker);
  return root;
}
const asFile = (bytes, name) => new File([bytes], name, {type: 'application/pdf'});

test('the trust capability is handed out once and the API object cannot be swapped', () => {
  const root = loadPage();
  const api = root.FalsifyBlindPdf;
  assert.equal(typeof api.prepare, 'function');
  assert.equal(api.trust, undefined, 'no public trust(file)');
  assert.equal(typeof api.claimTrust(), 'function', 'booth.js gets the capability');
  assert.equal(api.claimTrust(), null, 'a later page script gets nothing');
  assert.equal(Object.isFrozen(api), true);
  assert.throws(() => { 'use strict'; root.FalsifyBlindPdf = {prepare: async () => ({changed: false})}; }, TypeError);
  assert.equal(root.FalsifyBlindPdf, api);
});

test('bytes the booth fetched skip MuPDF; the PDF handed to generation must have the same hash', async () => {
  workers = 0;
  const root = loadPage();
  const register = root.FalsifyBlindPdf.claimTrust();
  assert.match(await register(CLEAN.slice()), /^[0-9a-f]{64}$/);
  const out = await root.FalsifyBlindPdf.prepare({file: asFile(CLEAN, 'arxiv-2503.10497.pdf')});
  assert.equal(out.changed, false);
  assert.equal(out.verification.source, 'arxiv');
  assert.equal(workers, 0, 'no MuPDF worker for the trusted bytes');
});

test('the worker path still finds and removes the training marker', async () => {
  workers = 0;
  const root = loadPage();
  root.FalsifyBlindPdf.claimTrust();
  const out = await root.FalsifyBlindPdf.prepare({file: asFile(MARKED, 'test.pdf')});
  assert.equal(workers, 1);
  assert.equal(out.changed, true);
  assert.equal(out.removed.length, 2);
  const clean = new Uint8Array(await out.file.arrayBuffer());
  for (let i = 0; i < 2; i++) {
    assert.match(text(clean, i), /Publisher and body remain/);
    assert.doesNotMatch(text(clean, i), /FALSIFY RED TEAM/);
  }
  assert.match(text(MARKED), /FALSIFY RED TEAM TRAINING COPY/, 'the input stays as it was');
});

test('spoof attempts never skip the check', async () => {
  workers = 0;
  const root = loadPage();
  const register = root.FalsifyBlindPdf.claimTrust();
  await register(CLEAN);
  // A recipe paperId or a mission file name does not carry trust: only the bytes do.
  let out = await root.FalsifyBlindPdf.prepare({file: asFile(MARKED, 'arxiv-2503.10497.pdf')});
  assert.equal(out.changed, true, 'visitor file under an arXiv name');
  // Page-script globals and a second claim do nothing.
  root.FalsifyBlindPdfTrusted = true;
  root.trusted = new Set(['*']);
  assert.equal(root.FalsifyBlindPdf.claimTrust(), null);
  out = await root.FalsifyBlindPdf.prepare({file: {name: 'mission.pdf', bytes: MARKED.slice()}});
  assert.equal(out.changed, true, 'page-script globals');
  // Trust is taken from a copy at fetch time: changing the buffer afterwards drops it.
  const fetched = MARKED.slice();
  const root2 = loadPage();
  const register2 = root2.FalsifyBlindPdf.claimTrust();
  const pending = register2(fetched);
  fetched[10] ^= 0x01;
  await pending;
  out = await root2.FalsifyBlindPdf.prepare({file: asFile(fetched, 'arxiv.pdf')});
  assert.equal(out.changed, true, 'bytes changed after the fetch');
  // A reload (a resumed session) starts with nothing trusted.
  const root3 = loadPage();
  root3.FalsifyBlindPdf.claimTrust();
  out = await root3.FalsifyBlindPdf.prepare({file: asFile(MARKED, 'arxiv.pdf')});
  assert.equal(out.changed, true, 'resumed session');
  // Something that is not a PDF is never registered.
  assert.equal(await register(new TextEncoder().encode('<html>nope</html>')), '');
  assert.ok(workers >= 3);
});
