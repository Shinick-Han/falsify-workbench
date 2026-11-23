// Unit & integration tests for app/dist/w8-paper.js (window.FalsifyW8Paper)
// Uses real vendored MuPDF (blind-pdf.mjs + browser-pdf.mjs), real booth-edits.js,
// and synthetic PDFs only (no network mutations).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import * as blindMod from '../dist/blind-pdf.mjs';
import * as browserPdfMod from '../dist/browser-pdf.mjs';

const w8Source = await readFile(fileURLToPath(new URL('../dist/w8-paper.js', import.meta.url)), 'utf8');
const boothEditsSource = await readFile(fileURLToPath(new URL('../dist/booth-edits.js', import.meta.url)), 'utf8');
const boothPageEditSource = await readFile(fileURLToPath(new URL('../dist/booth-pageedit.js', import.meta.url)), 'utf8');
const fixturePdfBytes = new Uint8Array(
  await readFile(fileURLToPath(new URL('./fixtures/paragraph-audit-synthetic.pdf', import.meta.url)))
);

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

const MARKER_HEX = '46414c5349465920524544205445414d20545241494e494e4720434f505920207c2020494e54454e54494f4e414c4c5920414c544552454420207c20204e4f54204f524947494e414c';
const MARKER_STREAM = `\nq\nBT\n1 0 0 1 30 17.8 Tm\n/helv 7.1 Tf .55 .25 .14 RG .55 .25 .14 rg [<${MARKER_HEX}>]TJ\nET\nQ\n`;
const BANNER_STREAM = '\nq\n25 13 562 14 re\nh\n.98 .94 .87 rg f\nQ\n';

function makeSyntheticPdf({marked = false, pages = 2, line1 = 'Alpha score 0.85 stays clear'} = {}) {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  for (let i = 0; i < pages; i += 1) {
    const body = i === 0
      ? `BT /helv 12 Tf 72 700 Td (${line1}) Tj 0 -24 Td (Beta metric 0.42 remains fixed) Tj ET`
      : `BT /helv 12 Tf 72 700 Td (Second page summary value 9.10) Tj ET`;
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {Font: {helv: font}}, body));
    if (marked) {
      const p = doc.findPage(i);
      const prev = p.get('Contents');
      p.put('Contents', [prev, doc.addStream(BANNER_STREAM, {}), doc.addStream(MARKER_STREAM, {})]);
    }
  }
  const buf = doc.saveToBuffer();
  const bytes = buf.asUint8Array().slice();
  buf.destroy();
  doc.destroy();
  return bytes;
}

function extractPageText(pdfBytes, pageIndex = 0) {
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    try {
      const st = page.toStructuredText();
      try { return st.asText(); } finally { st.destroy(); }
    } finally { page.destroy(); }
  } finally { doc.destroy(); }
}

function findWordFractionRect(pdfBytes, pageIndex, needle) {
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    try {
      const bounds = page.getBounds();
      const w = bounds[2] - bounds[0];
      const h = bounds[3] - bounds[1];
      const hits = page.search(needle);
      assert.ok(hits.length >= 1, `expected to find "${needle}" on page ${pageIndex + 1}`);
      const q = hits[0][0];
      const minX = Math.min(q[0], q[2], q[4], q[6]);
      const minY = Math.min(q[1], q[3], q[5], q[7]);
      const maxX = Math.max(q[0], q[2], q[4], q[6]);
      const maxY = Math.max(q[1], q[3], q[5], q[7]);
      return {
        x: (minX - bounds[0]) / w,
        y: (minY - bounds[1]) / h,
        w: (maxX - minX) / w,
        h: (maxY - minY) / h,
      };
    } finally { page.destroy(); }
  } finally { doc.destroy(); }
}

function createFakeEnv(opts = {}) {
  const listeners = new Map();
  const events = [];
  let mountedBar = false;
  let stagePageEl = null;

  const doc = {
    readyState: 'complete',
    visibilityState: 'visible',
    documentElement: {dataset: {}},
    body: {append() {}},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      events.push(event);
      for (const fn of [...(listeners.get(event.type) || [])]) fn(event);
      return true;
    },
    getElementById(id) {
      if (id === 'paper-file') return fileInput;
      if (id === 'paper-before-stage') return stage;
      if (id === 'booth-pe-bar') return mountedBar ? {id: 'booth-pe-bar'} : null;
      return null;
    },
    createElement(tag) {
      return {tagName: tag.toUpperCase(), click() {}, remove() {}};
    },
  };

  const stage = {
    querySelector(sel) {
      return sel.includes('.paper-page') ? stagePageEl : null;
    },
  };

  let wsSource = null;
  let wsPages = 0;
  let wsPageIndex = null;
  let wsPdfDoc = null;
  let openDelayMs = opts.openDelayMs || 0;

  const fileInputListeners = new Set();
  const fileInput = {
    files: [],
    addEventListener(type, fn) { if (type === 'change') fileInputListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'change') fileInputListeners.delete(fn); },
    dispatchEvent(event) {
      if (event.type === 'change') {
        for (const fn of [...fileInputListeners]) fn(event);
      }
      return true;
    },
  };

  // Simulate legacy app.js synchronous falsify:document-clear + paper-workspace.js async PDF load.
  let loadCounter = 0;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    // Mimic app.js firing falsify:document-clear synchronously on replace!
    doc.dispatchEvent(new Event('falsify:document-clear'));
    const token = ++loadCounter;
    void (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = sha256(bytes);
      if (openDelayMs > 0) await new Promise(r => setTimeout(r, openDelayMs));
      if (token !== loadCounter) return;
      let pageCount;
      try {
        const d = mupdf.Document.openDocument(bytes, 'application/pdf');
        pageCount = d.countPages();
        d.destroy();
      } catch {
        doc.dispatchEvent(new CustomEvent('falsify:paper-workspace-pdf-error', {
          detail: {file, fileHash: hash, code: 'pdf_corrupt', name: 'InvalidPDFException'},
        }));
        return;
      }
      wsSource = {file, fileHash: hash, segments: []};
      wsPages = pageCount;
      wsPageIndex = 0;
      wsPdfDoc = {numPages: pageCount};
      stagePageEl = {className: 'paper-page'};
      doc.dispatchEvent(new CustomEvent('falsify:paper-workspace-source', {detail: {fileHash: hash, name: file.name}}));
      doc.dispatchEvent(new CustomEvent('falsify:paper-workspace-pdf', {detail: {fileHash: hash, file, pages: pageCount}}));
      doc.dispatchEvent(new CustomEvent('falsify:paper-workspace-page', {detail: {fileHash: hash, pageIndex: 0, page: 1, pages: pageCount}}));
    })();
  });

  const workspace = {
    getSource: () => wsSource,
    getPdfDoc: () => wsPdfDoc,
    getPageCount: () => wsPages,
    getPageIndex: () => wsPageIndex,
    getEditSnapshot: () => null,
    getCurrentOutput: () => null,
    showPage(n) {
      if (!wsSource || n < 1 || n > wsPages) return false;
      wsPageIndex = n - 1;
      stagePageEl = {className: 'paper-page', page: n};
      queueMicrotask(() => {
        doc.dispatchEvent(new CustomEvent('falsify:paper-workspace-page', {
          detail: {fileHash: wsSource.fileHash, pageIndex: n - 1, page: n, pages: wsPages},
        }));
      });
      return true;
    },
  };

  // Load real FalsifyBoothEdits in an isolated VM context.
  const boothCtx = vm.createContext({console});
  vm.runInContext(boothEditsSource, boothCtx, {filename: 'booth-edits.js'});
  const boothEdits = boothCtx.FalsifyBoothEdits;

  const storageMap = opts.storageMap || new Map();
  const storage = {
    getItem: k => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => { storageMap.set(k, String(v)); },
    removeItem: k => { storageMap.delete(k); },
  };
  const blobMap = opts.blobMap || new Map();
  const sourceBlobs = opts.sourceBlobs || {
    get: async k => blobMap.get(k),
    put: async (k, v) => { blobMap.set(k, v); },
    delete: async k => { blobMap.delete(k); },
  };

  let blindCalls = 0;
  let rewriteCalls = 0;
  const blindPdf = {
    warm() {},
    async prepare(req) {
      blindCalls += 1;
      return blindMod.prepare(req);
    },
  };
  const browserPdf = {
    warm: async () => true,
    async rewrite(bytes, edits) {
      rewriteCalls += 1;
      if (opts.onBeforeRewrite) await opts.onBeforeRewrite(rewriteCalls, edits);
      return browserPdfMod.rewrite(bytes, edits);
    },
  };

  const pageEdit = {
    mount(targetDoc, mountOpts) {
      if (mountOpts?.force || targetDoc.documentElement.dataset.boothStep === 'edit') {
        mountedBar = true;
        return true;
      }
      return false;
    },
  };

  const downloads = [];
  const w8Ctx = vm.createContext({
    console, setTimeout, clearTimeout, File, Blob, Uint8Array, ArrayBuffer,
    Event, CustomEvent, crypto, URL, TextEncoder, TextDecoder,
  });
  vm.runInContext(w8Source, w8Ctx, {filename: 'w8-paper.js'});

  const adapter = w8Ctx.FalsifyW8Paper.create({
    root: {
      document: doc,
      crypto,
      URL,
      Event,
      CustomEvent,
      setTimeout,
      clearTimeout,
      addEventListener() {},
      removeEventListener() {},
    },
    document: doc,
    workspace,
    boothEdits,
    pageEdit,
    blindPdf: opts.blindPdf === undefined ? blindPdf : opts.blindPdf,
    browserPdf: opts.browserPdf === undefined ? browserPdf : opts.browserPdf,
    storage,
    sourceBlobs,
    ttlMs: opts.ttlMs,
    now: opts.now || (() => Date.now()),
    triggerDownload(file, art) { downloads.push({file, art}); },
  });

  return {
    adapter,
    doc,
    boothEdits,
    events,
    downloads,
    storageMap,
    blobMap,
    getCounts: () => ({blindCalls, rewriteCalls}),
  };
}

test('direct BLUE unchanged PDF runs blind-pdf and preserves clean bytes and SHA-256', async () => {
  const env = createFakeEnv();
  const file = new File([fixturePdfBytes], 'audit.pdf', {type: 'application/pdf'});
  const opened = await env.adapter.open(file);

  assert.equal(opened.ready, true);
  assert.equal(opened.fileHash, sha256(fixturePdfBytes));
  assert.equal(opened.page, 1);
  assert.equal(opened.pageCount, 2);
  assert.equal(opened.revision, 0);
  assert.equal(opened.editCount, 0);
  assert.equal(opened.editorMounted, true);
  assert.equal(env.doc.documentElement.dataset.boothStep, 'edit');

  const art = await env.adapter.artifact();
  assert.equal(env.getCounts().blindCalls, 1, 'must always run blind-pdf on user files');
  assert.equal(env.getCounts().rewriteCalls, 0, 'unchanged PDF skips rewrite');
  assert.equal(art.sha256, sha256(fixturePdfBytes));
  assert.equal(art.sourceSha256, sha256(fixturePdfBytes));
  assert.equal(art.revision, 0);
  assert.equal(art.editCount, 0);
  assert.equal(art.changed, false);

  const reasons = env.events
    .filter(e => e.type === 'falsify:w8-paper-change')
    .map(e => e.detail.reason);
  assert.deepEqual(reasons, ['loading', 'ready', 'artifact']);
  env.adapter.dispose();
});

test('arbitrary user PDF with RED training marker is always stripped even on direct BLUE unchanged path', async () => {
  const markedBytes = makeSyntheticPdf({marked: true, pages: 2});
  assert.match(extractPageText(markedBytes, 0), /FALSIFY RED TEAM TRAINING COPY/);

  const env = createFakeEnv();
  await env.adapter.open(new File([markedBytes], 'arxiv-2309.15217.pdf', {type: 'application/pdf'}));
  const art = await env.adapter.artifact();

  assert.equal(art.editCount, 0);
  assert.equal(art.changed, true);
  assert.equal(art.blinding.changed, true);
  assert.equal(art.blinding.removed.length, 2);
  assert.notEqual(art.sha256, sha256(markedBytes));

  const outBytes = new Uint8Array(await art.file.arrayBuffer());
  assert.equal(sha256(outBytes), art.sha256);
  for (let p = 0; p < 2; p += 1) {
    assert.doesNotMatch(extractPageText(outBytes, p), /FALSIFY RED TEAM/);
  }
  assert.match(extractPageText(outBytes, 0), /Alpha score 0\.85 stays clear/);
  env.adapter.dispose();
});

test('committed edits export blind rewritten PDF and download matches artifact byte-for-byte', async () => {
  const markedBytes = makeSyntheticPdf({marked: true, pages: 2});
  const rect = findWordFractionRect(markedBytes, 0, '0.85');
  const env = createFakeEnv();

  await env.adapter.open(new File([markedBytes], 'study.pdf', {type: 'application/pdf'}));
  env.boothEdits.add({
    pageIndex: 0,
    rects: [rect],
    originalText: '0.85',
    newText: '0.19',
    source: 'tap',
  });

  const st = env.adapter.state();
  assert.equal(st.revision, 1);
  assert.equal(st.editCount, 1);

  const art1 = await env.adapter.artifact();
  const downloaded = await env.adapter.download();
  assert.equal(downloaded.sha256, art1.sha256);
  assert.equal(downloaded.revision, 1);
  assert.equal(env.getCounts().rewriteCalls, 1, 'cached artifact reused for download');
  assert.equal(env.downloads.length, 1);
  assert.equal(env.downloads[0].file.name, 'study-edited.pdf');

  const outBytes = new Uint8Array(await art1.file.arrayBuffer());
  const dlBytes = new Uint8Array(await env.downloads[0].file.arrayBuffer());
  assert.deepEqual(dlBytes, outBytes);

  const page0Text = extractPageText(outBytes, 0);
  assert.match(page0Text, /0\.19/);
  assert.doesNotMatch(page0Text, /0\.85/);
  assert.doesNotMatch(page0Text, /FALSIFY RED TEAM/);
  env.adapter.dispose();
});

test('rapid edits during in-flight export rebuild automatically so callers never get stale bytes', async () => {
  const cleanBytes = makeSyntheticPdf({marked: false, pages: 1});
  const rect1 = findWordFractionRect(cleanBytes, 0, '0.85');
  const rect2 = findWordFractionRect(cleanBytes, 0, '0.42');

  let releaseFirstRewrite;
  const firstRewriteStarted = new Promise(resolve => { releaseFirstRewrite = resolve; });
  let unblockFirstRewrite;
  const holdFirstRewrite = new Promise(resolve => { unblockFirstRewrite = resolve; });

  const env = createFakeEnv({
    async onBeforeRewrite(callNo) {
      if (callNo === 1) {
        releaseFirstRewrite();
        await holdFirstRewrite;
      }
    },
  });

  await env.adapter.open(new File([cleanBytes], 'race.pdf', {type: 'application/pdf'}));
  env.boothEdits.add({pageIndex: 0, rects: [rect1], originalText: '0.85', newText: '0.11', source: 'tap'});

  // Start artifact build at revision 1.
  const p1 = env.adapter.artifact();
  await firstRewriteStarted;

  // Commit edit #2 (revision 2) while rewrite #1 is still running, then call artifact() again.
  env.boothEdits.add({pageIndex: 0, rects: [rect2], originalText: '0.42', newText: '0.99', source: 'tap'});
  const p2 = env.adapter.artifact();
  unblockFirstRewrite();

  const [a1, a2] = await Promise.all([p1, p2]);
  assert.equal(a1.sha256, a2.sha256, 'both callers receive the exact same latest stable bytes');
  assert.equal(a1.revision, 2);
  assert.equal(a2.revision, 2);
  assert.equal(a1.editCount, 2);

  const outBytes = new Uint8Array(await a1.file.arrayBuffer());
  const text = extractPageText(outBytes, 0);
  assert.match(text, /0\.11/);
  assert.match(text, /0\.99/);
  assert.doesNotMatch(text, /0\.85/);
  assert.doesNotMatch(text, /0\.42/);

  // Subsequent edit after resolution leaves previous artifact immutable.
  env.boothEdits.add({pageIndex: 0, rects: [rect1], originalText: '0.85', newText: '0.77', source: 'tap'});
  const a3 = await env.adapter.artifact();
  assert.notEqual(a3.sha256, a1.sha256);
  assert.equal(sha256(new Uint8Array(await a1.file.arrayBuffer())), a1.sha256);
  assert.match(extractPageText(new Uint8Array(await a3.file.arrayBuffer()), 0), /0\.77/);
  env.adapter.dispose();
});

test('rapid open() supersedes earlier load and switching source rejects stale in-flight artifact()', async () => {
  const pdf1 = makeSyntheticPdf({line1: 'First document 1.11'});
  const pdf2 = makeSyntheticPdf({line1: 'Second document 2.22'});
  const env = createFakeEnv({openDelayMs: 25});

  const p1 = env.adapter.open(new File([pdf1], 'first.pdf', {type: 'application/pdf'}));
  const p2 = env.adapter.open(new File([pdf2], 'second.pdf', {type: 'application/pdf'}));

  await assert.rejects(p1, err => err.code === 'superseded');
  const st = await p2;
  assert.equal(st.fileHash, sha256(pdf2));
  assert.equal(st.name, 'second.pdf');
  env.adapter.dispose();
});

test('automatic local persistence and resume() restore source PDF, edits, and last page', async () => {
  const pdfBytes = makeSyntheticPdf({marked: false, pages: 2});
  const rect = findWordFractionRect(pdfBytes, 1, '9.10');
  const storageMap = new Map();
  const blobMap = new Map();
  let clock = 1_700_000_000_000;

  const env1 = createFakeEnv({storageMap, blobMap, now: () => clock});
  await env1.adapter.open(new File([pdfBytes], 'persisted.pdf', {type: 'application/pdf'}));
  assert.equal(await env1.adapter.goToPage(2), true);
  env1.boothEdits.add({pageIndex: 1, rects: [rect], originalText: '9.10', newText: '3.14', source: 'tap'});
  const artBeforeReload = await env1.adapter.artifact();
  assert.equal(env1.getCounts().rewriteCalls, 1);
  await env1.adapter.flushDraft();
  env1.adapter.dispose();

  // New session / page reload using the same localStorage + IndexedDB backing stores.
  const env2 = createFakeEnv({storageMap, blobMap, now: () => clock + 60_000});
  const before = env2.adapter.state();
  assert.equal(before.ready, false);
  assert.ok(before.resumable);
  assert.equal(before.resumable.fileHash, sha256(pdfBytes));
  assert.equal(before.resumable.name, 'persisted.pdf');
  assert.equal(before.resumable.page, 2);
  assert.equal(before.resumable.editCount, 1);
  assert.equal(before.resumable.hasSource, true);
  assert.equal(before.resumable.lastArtifactSha256, artBeforeReload.sha256);

  // Calling artifact() concurrently while resume() is still in flight awaits resume and restores exact bytes without recomputing!
  const resumePromise = env2.adapter.resume();
  const artAfterReload = await env2.adapter.artifact();
  const resumed = await resumePromise;
  assert.equal(resumed.ready, true);
  assert.equal(resumed.fileHash, sha256(pdfBytes));
  assert.equal(resumed.page, 2);
  assert.equal(resumed.editCount, 1);
  assert.equal(env2.boothEdits.list().length, 1);
  assert.equal(env2.boothEdits.list()[0].newText, '3.14');
  assert.equal(artAfterReload.sha256, artBeforeReload.sha256, 'exact SHA-256 must survive reload without recomputing');
  assert.equal(env2.getCounts().rewriteCalls, 0, 'restored persisted artifact must NOT re-run MuPDF rewrite');
  assert.equal(env2.getCounts().blindCalls, 0, 'restored persisted artifact must NOT re-run blind-pdf');

  const outBytes = new Uint8Array(await artAfterReload.file.arrayBuffer());
  assert.match(extractPageText(outBytes, 1), /3\.14/);
  assert.doesNotMatch(extractPageText(outBytes, 1), /9\.10/);
  env2.adapter.dispose();

  // Multi-day private draft survives well beyond 12 hours (e.g. 7 days later) by default.
  const envDay7 = createFakeEnv({storageMap, blobMap, now: () => clock + 7 * 24 * 60 * 60 * 1000});
  assert.ok(envDay7.adapter.state().resumable, 'private draft must survive 7 days by default');
  assert.equal(envDay7.adapter.recent().length, 1);
  envDay7.adapter.dispose();

  // Explicit short TTL still expires deterministically when injected.
  const envExpired = createFakeEnv({
    storageMap: new Map(),
    blobMap: new Map(),
    ttlMs: 10_000,
    now: () => clock,
  });
  await envExpired.adapter.open(new File([pdfBytes], 'short-ttl.pdf', {type: 'application/pdf'}));
  envExpired.adapter.dispose();
  const envAfterShort = createFakeEnv({
    storageMap: envExpired.storageMap,
    blobMap: envExpired.blobMap,
    ttlMs: 10_000,
    now: () => clock + 20_000,
  });
  assert.equal(envAfterShort.adapter.state().resumable, null);
  assert.equal(envAfterShort.adapter.recent().length, 0);
  assert.equal(await envAfterShort.adapter.resume(), null);
  envAfterShort.adapter.dispose();
});

test('recent() lists multiple drafts with summary shape, keyed resume(fileHash|{fileHash}) restores exact draft, and edits are never truncated', async () => {
  const pdfA = makeSyntheticPdf({line1: 'Paper A value 1.11'});
  const pdfB = makeSyntheticPdf({line1: 'Paper B value 2.22'});
  const hashA = sha256(pdfA);
  const hashB = sha256(pdfB);
  const storageMap = new Map();
  const blobMap = new Map();
  let clock = 1_700_000_000_000;

  const env1 = createFakeEnv({storageMap, blobMap, now: () => (clock += 1000)});
  await env1.adapter.open(new File([pdfA], 'paper-a.pdf', {type: 'application/pdf'}));
  // Add 70 non-overlapping edits to prove no truncation on save.
  for (let i = 0; i < 70; i += 1) {
    env1.boothEdits.add({
      pageIndex: 0,
      rects: [{x: 0.01, y: 0.01 + i * 0.012, w: 0.05, h: 0.008}],
      originalText: 'orig' + i,
      newText: 'edit' + i,
      source: 'tap',
    });
  }
  await env1.adapter.flushDraft();

  await env1.adapter.open(new File([pdfB], 'paper-b.pdf', {type: 'application/pdf'}));
  const rectB = findWordFractionRect(pdfB, 0, '2.22');
  env1.boothEdits.add({pageIndex: 0, rects: [rectB], originalText: '2.22', newText: '8.88', source: 'tap'});
  const artB = await env1.adapter.artifact();
  await env1.adapter.flushDraft();
  env1.adapter.dispose();

  const env2 = createFakeEnv({storageMap, blobMap, now: () => (clock += 1000)});
  const list = env2.adapter.recent();
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], env2.adapter.state().resumable, 'recent()[0] has exact same summary shape as state().resumable');
  assert.equal(list[0].fileHash, hashB);
  assert.equal(list[0].name, 'paper-b.pdf');
  assert.equal(list[0].hasSource, true);
  assert.equal(list[0].editCount, 1);
  assert.equal(list[0].lastArtifactSha256, artB.sha256);
  assert.equal(list[1].fileHash, hashA);
  assert.equal(list[1].name, 'paper-a.pdf');
  assert.equal(list[1].hasSource, true);
  assert.equal(list[1].editCount, 70, 'all 70 user edits preserved without truncation');

  // Keyed resume via string fileHash selects paper A.
  const resumedA = await env2.adapter.resume(hashA);
  assert.equal(resumedA.fileHash, hashA);
  assert.equal(resumedA.editCount, 70);
  assert.equal(env2.boothEdits.list().length, 70);

  // Keyed resume via {fileHash} selects paper B and restores exact artifact SHA-256 without recomputing.
  const resumedB = await env2.adapter.resume({fileHash: hashB});
  assert.equal(resumedB.fileHash, hashB);
  assert.equal(resumedB.editCount, 1);
  const restoredArtB = await env2.adapter.artifact();
  assert.equal(restoredArtB.sha256, artB.sha256);
  assert.equal(env2.getCounts().rewriteCalls, 0);
  env2.adapter.dispose();
});

test('async save race does not write an old file over a newly active draft and rejections leave no unhandledRejection', async () => {
  const pdfA = makeSyntheticPdf({line1: 'Slow save A 1.11'});
  const pdfB = makeSyntheticPdf({line1: 'Fast open B 2.22'});
  const hashA = sha256(pdfA);
  const hashB = sha256(pdfB);
  const storageMap = new Map();
  const blobMap = new Map();
  let releasePutA;
  const putAStarted = new Promise(resolve => { releasePutA = resolve; });
  let unblockPutA;
  const holdPutA = new Promise(resolve => { unblockPutA = resolve; });

  const delayedBlobs = {
    get: async k => blobMap.get(k),
    async put(k, v) {
      if (v.fileHash === hashA) {
        releasePutA();
        await holdPutA;
      }
      blobMap.set(k, v);
    },
    delete: async k => { blobMap.delete(k); },
  };

  let clock = 1_700_000_000_000;
  const env = createFakeEnv({storageMap, blobMap, sourceBlobs: delayedBlobs, now: () => (clock += 1000)});

  // Start opening A (blocks on persistDraft -> delayedBlobs.put(hashA)).
  const openA = env.adapter.open(new File([pdfA], 'slow-a.pdf', {type: 'application/pdf'}));
  await putAStarted;

  // Open B while A's async blob save is still in flight.
  const openedB = await env.adapter.open(new File([pdfB], 'fast-b.pdf', {type: 'application/pdf'}));
  assert.equal(openedB.fileHash, hashB);

  // Release A's stale blob write: openA rejects as superseded and must NOT overwrite B as the latest draft.
  unblockPutA();
  await assert.rejects(openA, err => err.code === 'superseded');
  assert.equal(env.adapter.state().fileHash, hashB);
  assert.equal(env.adapter.recent()[0].fileHash, hashB, 'stale async save must not overwrite newly active draft');
  env.adapter.dispose();

  // Verify rejected resume() and artifact() produce zero unhandledRejection events.
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const failEnv = createFakeEnv({
      storageMap,
      blobMap: new Map(), // empty blob store -> missing_source on resume
      now: () => clock,
      browserPdf: {warm: async () => true, rewrite: async () => { throw new Error('boom'); }},
    });
    await assert.rejects(failEnv.adapter.resume(hashB), err => err.code === 'missing_source');
    await failEnv.adapter.open(new File([pdfB], 'fail-b.pdf', {type: 'application/pdf'}));
    const rectB = findWordFractionRect(pdfB, 0, '2.22');
    failEnv.boothEdits.add({pageIndex: 0, rects: [rectB], originalText: '2.22', newText: '7.77', source: 'tap'});
    await assert.rejects(failEnv.adapter.artifact(), /boom|PDF/);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(unhandled.length, 0, 'cleanup must never create unhandled promise rejections');
    failEnv.adapter.dispose();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('booth-pageedit.js mount predicate stays off on plain index.html and mounts cleanly with data-booth-step="edit" or force', () => {
  function runPageEdit({withBoothStep = false, withDataAttr = false} = {}) {
    let insertedBar = false;
    const html = {dataset: withDataAttr ? {boothStep: 'edit'} : {}, classList: {toggle() {}}};
    const stage = {
      before() { insertedBar = true; },
      querySelector() { return null; },
      addEventListener() {},
      getBoundingClientRect: () => ({left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800}),
    };
    const doc = {
      readyState: 'complete',
      documentElement: html,
      body: {append() {}},
      getElementById(id) {
        if (id === 'paper-before-stage') return stage;
        if (id === 'booth-step-edit') return withBoothStep ? {id} : null;
        if (id === 'booth-pe-bar') return insertedBar ? {id} : null;
        return null;
      },
      querySelector() { return null; },
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(),
          className: '',
          style: {},
          dataset: {},
          classList: {toggle() {}},
          setAttribute() {},
          append() {},
          addEventListener() {},
          remove() {},
        };
      },
      addEventListener() {},
    };
    const ctx = vm.createContext({
      document: doc,
      console,
      setTimeout: fn => { fn(); return 1; },
      clearTimeout() {},
      addEventListener() {},
      matchMedia: () => ({matches: false}),
    });
    ctx.window = ctx;
    vm.runInContext(boothPageEditSource, ctx, {filename: 'booth-pageedit.js'});
    return {api: ctx.FalsifyBoothPageEdit, doc, isMounted: () => insertedBar};
  }

  // Plain index.html: no #booth-step-edit and no data-booth-step="edit" -> does NOT mount automatically.
  const plain = runPageEdit();
  assert.equal(plain.isMounted(), false);
  // Explicit force mount (used by w8-paper.js) mounts idempotently.
  assert.equal(plain.api.mount(plain.doc, {force: true}), true);
  assert.equal(plain.isMounted(), true);
  assert.equal(plain.api.mount(plain.doc, {force: true}), false, 'idempotent when already mounted');

  // With data-booth-step="edit" -> auto-mounts without #booth-step-edit.
  const w8 = runPageEdit({withDataAttr: true});
  assert.equal(w8.isMounted(), true);

  // Legacy event.html with #booth-step-edit -> still auto-mounts as before.
  const booth = runPageEdit({withBoothStep: true});
  assert.equal(booth.isMounted(), true);
});
