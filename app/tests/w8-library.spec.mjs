'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const libraryPath = fileURLToPath(new URL('../dist/w8-library.js', import.meta.url));
const boothPath = fileURLToPath(new URL('../dist/booth.js', import.meta.url));
const workbenchJsPath = fileURLToPath(new URL('../dist/w8-workbench.js', import.meta.url));
const workbenchCssPath = fileURLToPath(new URL('../dist/w8-workbench.css', import.meta.url));
const workbenchHtmlPath = fileURLToPath(new URL('../dist/workbench.html', import.meta.url));
const shellHtmlPath = fileURLToPath(new URL('../../scripts/workbench-shell.html', import.meta.url));

const LIBRARY_SRC = readFileSync(libraryPath, 'utf8');
const BOOTH_SRC = readFileSync(boothPath, 'utf8');
const WORKBENCH_JS_SRC = readFileSync(workbenchJsPath, 'utf8');
const WORKBENCH_CSS_SRC = readFileSync(workbenchCssPath, 'utf8');
const WORKBENCH_HTML_SRC = readFileSync(workbenchHtmlPath, 'utf8');
const SHELL_HTML_SRC = readFileSync(shellHtmlPath, 'utf8');

const SEARCH_API_BASE = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const SYNC_API_BASE = 'https://falsify-cloud-api.ai-gongbu.workers.dev';
const SITE = 'https://falsify.atlassian.net';

const PDF_A = new TextEncoder().encode('%PDF-1.7\n% paper A bytes\n%%EOF\n');
const PDF_B = new TextEncoder().encode('%PDF-1.7\n% paper B bytes\n%%EOF\n');
const PDF_ATT = new TextEncoder().encode('%PDF-1.7\n% attachment pdf bytes\n%%EOF\n');
const PDF_WRONG = new TextEncoder().encode('%PDF-1.7\n% mismatched pdf bytes\n%%EOF\n');
const SHA_A = createHash('sha256').update(PDF_A).digest('hex');
const SHA_B = createHash('sha256').update(PDF_B).digest('hex');
const SHA_C = 'c'.repeat(64);
const DRIVE_ID_1 = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function until(pred, label = 'condition') {
  for (let i = 0; i < 400 && !pred(); i += 1) await new Promise(r => setTimeout(r, 5));
  assert.ok(pred(), label);
}

const plain = value => JSON.parse(JSON.stringify(value));

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

class FakeFile {
  constructor(parts, name, opts) {
    this.parts = parts;
    this.name = name;
    this.type = opts?.type || '';
    const u8 = new Uint8Array(parts[0] || 0);
    this.size = u8.byteLength;
    this.bytes = u8;
  }
  async arrayBuffer() {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
  }
}

class El extends EventTarget {
  constructor(tag, id = '') {
    super();
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.attrs = {};
    this.dataset = {};
    this.children = [];
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.href = '';
    this.target = '';
    this.rel = '';
    this.type = '';
    this.ownerDocument = null;
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      toggle: (cls, force) => {
        const s = set();
        const next = force === undefined ? !s.has(cls) : Boolean(force);
        if (next) s.add(cls);
        else s.delete(cls);
        this.className = [...s].join(' ');
      },
      contains: cls => set().has(cls),
    };
  }
  append(...items) {
    for (const item of items) {
      if (item !== null && item !== undefined) this.children.push(item);
    }
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) {
    delete this.attrs[k];
    if (k === 'href') this.href = '';
  }
  click() {
    if (!this.disabled && !this.hidden) this.dispatchEvent(new Event('click'));
  }
  findAll(pred, out = []) {
    for (const child of this.children) {
      if (typeof child === 'object' && child) {
        if (pred(child)) out.push(child);
        if (typeof child.findAll === 'function') child.findAll(pred, out);
      }
    }
    return out;
  }
}

function makePdfBlobFile(bytes, name = 'paper.pdf') {
  const copy = new Uint8Array(bytes);
  return {
    name,
    type: 'application/pdf',
    size: copy.byteLength,
    bytes: copy,
    arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
  };
}

function createLibraryHarness({
  connected = false,
  syncBase = SYNC_API_BASE,
  searchApiBase = SEARCH_API_BASE,
  paperState = { ready: false, sourceSha256: null },
  listPapers = async () => ({ items: [], nextCursor: null }),
  getPaper = async () => ({}),
  listPaperAttachments = async () => ({ items: [], nextCursor: null }),
  getPaperAttachment = async () => new Blob([PDF_ATT], { type: 'application/pdf' }),
  cachedUrls = {},
  fetchMap = {},
  loadArxiv = null,
  resumeLocal = async () => false,
  connectImpl = null,
  readyPromise = Promise.resolve(),
} = {}) {
  const doc = new EventTarget();
  const win = new EventTarget();
  const nodes = {
    'w8-search': new El('div', 'w8-search'),
    'w8-sync': new El('section', 'w8-sync'),
    'w8-sync-disconnect': new El('button', 'w8-sync-disconnect'),
    'w8-library-toggle': new El('button', 'w8-library-toggle'),
    'w8-library-toggle-label': new El('span', 'w8-library-toggle-label'),
    'w8-library-panel': new El('section', 'w8-library-panel'),
    'w8-library-refresh': new El('button', 'w8-library-refresh'),
    'w8-library-status': new El('p', 'w8-library-status'),
    'w8-library-actions': new El('div', 'w8-library-actions'),
    'w8-library-connect': new El('button', 'w8-library-connect'),
    'w8-library-sections': new El('div', 'w8-library-sections'),
    'w8-library-papers-group': new El('div', 'w8-library-papers-group'),
    'w8-library-papers-status': new El('p', 'w8-library-papers-status'),
    'w8-library-retry': new El('button', 'w8-library-retry'),
    'w8-library-list': new El('ul', 'w8-library-list'),
    'w8-library-more': new El('button', 'w8-library-more'),
    'w8-library-att-group': new El('div', 'w8-library-att-group'),
    'w8-library-att-status': new El('p', 'w8-library-att-status'),
    'w8-library-att-retry': new El('button', 'w8-library-att-retry'),
    'w8-library-att-list': new El('ul', 'w8-library-att-list'),
    'w8-library-att-more': new El('button', 'w8-library-att-more'),
  };
  nodes['w8-search'].dataset.apiBase = searchApiBase;
  nodes['w8-search'].dataset.syncBase = syncBase;
  nodes['w8-library-panel'].hidden = true;
  nodes['w8-library-toggle'].setAttribute('aria-expanded', 'false');
  doc.getElementById = id => nodes[id] || null;
  doc.createElement = tag => {
    const el = new El(tag);
    el.ownerDocument = doc;
    return el;
  };

  let isConn = connected;
  const calls = {
    connect: 0,
    listPapers: [],
    getPaper: [],
    listPaperAttachments: [],
    getPaperAttachment: [],
    urlLookups: [],
    fetches: [],
    loadArxiv: [],
    resumeLocal: [],
    openFile: [],
    selectCurrent: [],
  };

  const team = {
    isConnected: () => isConn,
    listPapers: async args => {
      calls.listPapers.push(args);
      return listPapers(args);
    },
    getPaper: async (pageId, opts) => {
      calls.getPaper.push({ pageId, opts });
      return getPaper(pageId, opts);
    },
    listPaperAttachments: async args => {
      calls.listPaperAttachments.push(args);
      return listPaperAttachments(args);
    },
    getPaperAttachment: async (attachmentId, opts) => {
      calls.getPaperAttachment.push({ attachmentId, opts });
      return getPaperAttachment(attachmentId, opts);
    },
  };

  const paperSync = {
    ready: readyPromise,
    state: () => ({ connected: isConn, syncBase }),
    connect: async () => {
      calls.connect += 1;
      if (connectImpl) return connectImpl({ setConnected: v => { isConn = v; } });
      isConn = true;
      return { connected: true };
    },
    disconnect: () => {
      isConn = false;
    },
  };

  const paperLinks = {
    url: sha => {
      calls.urlLookups.push(sha);
      return cachedUrls[sha] || '';
    },
  };

  const fetchImpl = async (url, init) => {
    calls.fetches.push({ url, init });
    const handler = fetchMap[url];
    if (!handler) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return typeof handler === 'function' ? await handler(url, init) : handler;
  };

  const ctx = vm.createContext({
    window: win,
    document: doc,
    location: { origin: 'https://shinick-han.github.io', href: 'https://shinick-han.github.io/falsify-workbench/workbench.html' },
    crypto: globalThis.crypto,
    URL,
    Event,
    Blob,
    File: FakeFile,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
  });
  ctx.globalThis = ctx;
  vm.runInContext(LIBRARY_SRC, ctx, { filename: 'w8-library.js' });

  const library = ctx.FalsifyW8Library.mount({
    document: doc,
    window: win,
    fetch: fetchImpl,
    crypto: globalThis.crypto,
    File: FakeFile,
    paper: { state: () => ({ ...paperState }) },
    paperSync,
    team,
    paperLinks,
    loadArxiv: loadArxiv
      ? async arg => { calls.loadArxiv.push(arg); return loadArxiv(arg); }
      : async arg => { calls.loadArxiv.push(arg); throw new Error('not mocked'); },
    resumeLocal: async sha => { calls.resumeLocal.push(sha); return resumeLocal(sha); },
    openFile: async (file, opts) => { calls.openFile.push({ file, opts }); },
    selectCurrent: info => { calls.selectCurrent.push(info); },
  });

  return {
    library,
    api: ctx.FalsifyW8Library,
    nodes,
    doc,
    calls,
    setConnected(v) { isConn = v; },
    setPaperState(next) { Object.assign(paperState, next); },
    disconnectClick() {
      isConn = false;
      nodes['w8-sync-disconnect'].dispatchEvent(new Event('click'));
    },
  };
}

test('static hygiene, regenerated workbench.html, attachments section, and local picker + drag-drop stay intact', () => {
  assert.doesNotMatch(LIBRARY_SRC, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/);
  assert.doesNotMatch(LIBRARY_SRC, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(LIBRARY_SRC, /<style\b|\.style\./);
  assert.doesNotMatch(LIBRARY_SRC, /\bforBase\s*\(/, 'Must use real FalsifyW8PaperLinks.url(sha), not fictional forBase()');
  assert.doesNotMatch(SHELL_HTML_SRC, /\sstyle=/);
  assert.match(WORKBENCH_CSS_SRC, /\.w8-intake-primary/);
  assert.match(WORKBENCH_HTML_SRC, /id="w8-drop"/);
  assert.match(WORKBENCH_HTML_SRC, /id="w8-open"[\s\S]*?내 PDF 열기/);
  assert.match(WORKBENCH_HTML_SRC, /id="w8-library-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="w8-library-panel"/);
  assert.match(WORKBENCH_HTML_SRC, /id="w8-library-att-list"/);
  assert.match(WORKBENCH_HTML_SRC, /id="w8-library-att-more"/);
  assert.match(WORKBENCH_HTML_SRC, /id="w8-library-att-retry"/);
  assert.match(WORKBENCH_HTML_SRC, /src="w8-library\.js\?v=[0-9a-f]{12}"/);
  assert.match(WORKBENCH_JS_SRC, /byId\('w8-open'\)\.addEventListener\('click',\s*\(\)\s*=>\s*fileInput\.click\(\)\)/);
  assert.match(WORKBENCH_JS_SRC, /drop\.addEventListener\('drop'/);
  assert.match(WORKBENCH_JS_SRC, /loadArxiv:\s*item\s*=>\s*search\.load\(item\)/);
});

test('booth.js mountWorkbenchSearch exports current arXiv load reusing mounted session and base', async () => {
  const doc = new EventTarget();
  const container = new El('div', 'w8-search');
  container.ownerDocument = doc;
  container.dataset.apiBase = SEARCH_API_BASE;
  const byIdMap = new Map();
  doc.createElement = tag => {
    const el = new El(tag);
    el.ownerDocument = doc;
    return el;
  };
  doc.getElementById = id => {
    if (byIdMap.has(id)) return byIdMap.get(id);
    const hit = container.findAll(n => n.id === id)[0] || null;
    if (hit) byIdMap.set(id, hit);
    return hit;
  };
  const fetched = [];
  let tokenCount = 0;
  const win = new EventTarget();
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.fetch = async (url, init) => {
    fetched.push({ url, auth: init.headers?.Authorization });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/pdf' },
      arrayBuffer: async () => PDF_A.buffer.slice(PDF_A.byteOffset, PDF_A.byteOffset + PDF_A.byteLength),
    };
  };
  win.FalsifyHostedSession = {
    forBase: base => ({
      token: async () => { tokenCount += 1; return 'guest-token-for-' + base; },
      invalidate() {},
    }),
  };
  const ctx = vm.createContext({
    window: win,
    document: doc,
    location: { href: 'https://shinick-han.github.io/falsify-workbench/workbench.html', hash: '' },
    fetch: win.fetch,
    matchMedia: win.matchMedia,
    FalsifyHostedSession: win.FalsifyHostedSession,
    URL,
    URLSearchParams,
    AbortController,
    Uint8Array,
    ArrayBuffer,
    File: FakeFile,
    setTimeout,
    clearTimeout,
    console,
  });
  ctx.globalThis = ctx;
  vm.runInContext(BOOTH_SRC, ctx, { filename: 'booth.js' });

  const mounted = win.FalsifyBooth.mountWorkbenchSearch(container, () => {});
  assert.equal(typeof mounted.load, 'function');
  const file = await mounted.load({ id: '1706.03762' });
  assert.equal(file.name, 'arxiv-1706.03762.pdf');
  assert.equal(tokenCount, 1);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, SEARCH_API_BASE + '/v1/papers/pdf?id=1706.03762');
  assert.equal(fetched[0].auth, 'Bearer guest-token-for-' + SEARCH_API_BASE);
  await assert.rejects(() => mounted.load({ id: '../bad' }));
});

test('inline expand does not auto-connect; explicit connect loads both papers and attachments with independent load-more', async () => {
  const h = createLibraryHarness({
    connected: false,
    listPapers: async ({ cursor }) => {
      if (!cursor) {
        return {
          items: [
            { pageId: '101', pageUrl: SITE + '/wiki/spaces/Falsify/pages/101/A', title: 'Attention Is All You Need', sourceSha256: SHA_A },
            { pageId: '102', pageUrl: 'javascript:alert(1)', title: 'Unsafe Link Paper', sourceSha256: SHA_B },
          ],
          nextCursor: 'p-cursor-2',
        };
      }
      return {
        items: [
          { pageId: '102', pageUrl: SITE + '/wiki/spaces/Falsify/pages/102/B', title: 'Duplicate Ignored', sourceSha256: SHA_B },
          { pageId: '103', pageUrl: SITE + '/wiki/spaces/Falsify/pages/103/C', title: 'Third Real Paper', sourceSha256: SHA_C },
        ],
        nextCursor: null,
      };
    },
    listPaperAttachments: async ({ cursor }) => {
      if (!cursor) {
        return {
          items: [
            { attachmentId: 'att1001', pageId: '501', title: 'Clinical Study Draft.pdf', pageUrl: SITE + '/wiki/spaces/Falsify/pages/501/Study' },
            { attachmentId: 'bad/id', pageId: '502', title: 'Invalid Attachment', pageUrl: SITE + '/wiki/spaces/Falsify/pages/502/Bad' },
          ],
          nextCursor: 'a-cursor-2',
        };
      }
      return {
        items: [
          { attachmentId: 'att1001', pageId: '501', title: 'Dup Attachment', pageUrl: SITE + '/wiki/spaces/Falsify/pages/501/Study' },
          { attachmentId: 'att1002', pageId: '503', title: 'Appendix Tables', pageUrl: SITE + '/wiki/spaces/Falsify/pages/503/App' },
        ],
        nextCursor: null,
      };
    },
  });

  // Collapsed on load, zero API calls.
  assert.equal(h.nodes['w8-library-panel'].hidden, true);
  assert.equal(h.calls.connect, 0);
  assert.equal(h.calls.listPapers.length, 0);
  assert.equal(h.calls.listPaperAttachments.length, 0);

  // Explicit expand when disconnected shows connect CTA without auto-connecting.
  h.nodes['w8-library-toggle'].click();
  await flushMicrotasks();
  assert.equal(h.nodes['w8-library-panel'].hidden, false);
  assert.equal(h.nodes['w8-library-connect'].hidden, false);
  assert.equal(h.nodes['w8-library-sections'].hidden, true);
  assert.equal(h.calls.connect, 0);

  // Explicit connect triggers paperSync.connect() and loads both lists from canonical sync base.
  h.nodes['w8-library-connect'].click();
  await until(() => h.library.state().loaded && h.library.state().attachments.loaded, 'both lists loaded');
  assert.equal(h.calls.connect, 1);
  assert.deepEqual(plain(h.calls.listPapers), [{ base: SYNC_API_BASE }]);
  assert.deepEqual(plain(h.calls.listPaperAttachments), [{ base: SYNC_API_BASE }]);
  assert.equal(h.nodes['w8-library-sections'].hidden, false);
  assert.equal(h.nodes['w8-library-more'].hidden, false);
  assert.equal(h.nodes['w8-library-att-more'].hidden, false);

  // Registered papers rendered with safe Confluence link only.
  const paperTitles = h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-title').map(n => n.textContent);
  assert.deepEqual(paperTitles, ['Attention Is All You Need', 'Unsafe Link Paper']);
  const paperLinks = h.nodes['w8-library-list'].findAll(n => n.tagName === 'A' && n.className === 'w8-library-ext');
  assert.equal(paperLinks.length, 1);
  assert.equal(paperLinks[0].href, SITE + '/wiki/spaces/Falsify/pages/101/A');

  // Attachments rendered (invalid attachmentId rejected).
  const attTitles = h.nodes['w8-library-att-list'].findAll(n => n.className === 'w8-library-title').map(n => n.textContent);
  assert.deepEqual(attTitles, ['Clinical Study Draft.pdf']);

  // Independent load-more for papers does NOT touch attachments.
  h.nodes['w8-library-more'].click();
  await until(() => h.calls.listPapers.length === 2 && !h.library.state().loadingMore, 'papers page 2 loaded');
  assert.deepEqual(plain(h.calls.listPapers[1]), { base: SYNC_API_BASE, cursor: 'p-cursor-2' });
  assert.equal(h.calls.listPaperAttachments.length, 1);
  assert.equal(h.nodes['w8-library-more'].hidden, true);
  assert.equal(h.nodes['w8-library-att-more'].hidden, false);

  // Independent load-more for attachments does NOT touch papers.
  h.nodes['w8-library-att-more'].click();
  await until(() => h.calls.listPaperAttachments.length === 2 && !h.library.state().attachments.loadingMore, 'attachments page 2 loaded');
  assert.deepEqual(plain(h.calls.listPaperAttachments[1]), { base: SYNC_API_BASE, cursor: 'a-cursor-2' });
  assert.equal(h.calls.listPapers.length, 2);
  assert.equal(h.nodes['w8-library-att-more'].hidden, true);
  const allAttTitles = h.nodes['w8-library-att-list'].findAll(n => n.className === 'w8-library-title').map(n => n.textContent);
  assert.deepEqual(allAttTitles, ['Clinical Study Draft.pdf', 'Appendix Tables']);
  h.library.destroy();
});

test('direct PDF attachment downloads Blob via getPaperAttachment and opens as named File in standard editor', async () => {
  const h = createLibraryHarness({
    connected: true,
    listPaperAttachments: async () => ({
      items: [
        { attachmentId: 'att2048', pageId: '77', title: 'Seedling Report', pageUrl: SITE + '/wiki/spaces/Falsify/pages/77/Seedling' },
        { attachmentId: 'att2049', pageId: '78', title: 'Corrupt.pdf', pageUrl: SITE + '/wiki/spaces/Falsify/pages/78/Corrupt' },
      ],
      nextCursor: null,
    }),
    getPaperAttachment: async id => {
      if (id === 'att2048') return new Blob([PDF_ATT], { type: 'application/pdf' });
      return new Blob([new TextEncoder().encode('<html>not a pdf</html>')], { type: 'text/html' });
    },
  });

  h.nodes['w8-library-toggle'].click();
  await until(() => h.library.state().attachments.items.length === 2, 'attachments listed');

  // Open valid PDF attachment -> opens as named File with .pdf extension and application/pdf type.
  h.nodes['w8-library-att-list'].findAll(n => n.className.includes('w8-library-att-open'))[0].click();
  await until(() => h.calls.openFile.length === 1 && !h.library.state().openingKey, 'attachment opened');
  assert.deepEqual(plain(h.calls.getPaperAttachment), [{ attachmentId: 'att2048', opts: { base: SYNC_API_BASE } }]);
  assert.equal(h.calls.openFile[0].file.name, 'Seedling Report.pdf');
  assert.equal(h.calls.openFile[0].file.type, 'application/pdf');
  assert.equal(h.calls.openFile[0].opts.title, 'Seedling Report');
  assert.equal(h.calls.fetches.length, 0);

  // Non-PDF attachment response is rejected cleanly with inline error and never opened in editor.
  h.nodes['w8-library-att-list'].findAll(n => n.className.includes('w8-library-att-open'))[1].click();
  await until(() => !h.library.state().openingKey && h.nodes['w8-library-att-list'].findAll(n => n.className.includes('is-error')).length === 1, 'corrupt attachment notice');
  assert.equal(h.calls.openFile.length, 1);
  h.library.destroy();
});

test('partial failures keep available rows in the other source and allow independent retry without losing page 1', async () => {
  let paperAttempts = 0;
  let attAttempts = 0;
  const h = createLibraryHarness({
    connected: true,
    listPapers: async ({ cursor }) => {
      paperAttempts += 1;
      if (!cursor) {
        return {
          items: [{ pageId: '201', pageUrl: SITE + '/wiki/pages/201', title: 'Surviving Paper', sourceSha256: SHA_A }],
          nextCursor: 'p-page-2',
        };
      }
      if (paperAttempts === 2) {
        const err = new Error('network');
        err.code = 'network';
        throw err;
      }
      return {
        items: [{ pageId: '202', pageUrl: SITE + '/wiki/pages/202', title: 'Recovered Page 2 Paper', sourceSha256: SHA_B }],
        nextCursor: null,
      };
    },
    listPaperAttachments: async () => {
      attAttempts += 1;
      if (attAttempts === 1) {
        const err = new Error('network');
        err.code = 'network';
        throw err;
      }
      return {
        items: [{ attachmentId: 'att9', pageId: '90', title: 'Recovered Attachment.pdf', pageUrl: SITE + '/wiki/pages/90' }],
        nextCursor: null,
      };
    },
  });

  // Initial load: papers succeeds, attachments fails -> paper row stays rendered, attachments shows retry.
  h.nodes['w8-library-toggle'].click();
  await until(() => h.library.state().loaded && !h.library.state().attachments.loading, 'partial initial load settled');
  assert.equal(h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-title')[0].textContent, 'Surviving Paper');
  assert.equal(h.nodes['w8-library-retry'].hidden, true);
  assert.equal(h.nodes['w8-library-att-retry'].hidden, false);
  assert.match(h.nodes['w8-library-att-status'].textContent, /네트워크 오류/);

  // Retry attachments only -> recovers without reloading papers.
  h.nodes['w8-library-att-retry'].click();
  await until(() => h.library.state().attachments.items.length === 1, 'attachments recovered');
  assert.equal(paperAttempts, 1);
  assert.equal(attAttempts, 2);
  assert.equal(h.nodes['w8-library-att-retry'].hidden, true);

  // Papers load-more fails -> keeps page 1 row AND shows retry; retry loads page 2 without dropping page 1.
  h.nodes['w8-library-more'].click();
  await until(() => !h.library.state().loadingMore && !h.nodes['w8-library-retry'].hidden, 'papers page 2 failed');
  assert.equal(h.library.state().items.length, 1);
  assert.equal(h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-title')[0].textContent, 'Surviving Paper');
  assert.equal(h.library.state().attachments.items.length, 1);

  h.nodes['w8-library-retry'].click();
  await until(() => h.library.state().items.length === 2, 'papers page 2 recovered');
  assert.deepEqual(h.library.state().items.map(i => i.title), ['Surviving Paper', 'Recovered Page 2 Paper']);
  h.library.destroy();
});

test('reopen prefers local current -> saved draft -> FalsifyW8PaperLinks.url(sha) -> verified arXiv', async () => {
  // 1) Local current exact source
  {
    const h = createLibraryHarness({
      connected: true,
      paperState: { ready: true, sourceSha256: SHA_A },
      listPapers: async () => ({
        items: [{ pageId: '1', pageUrl: SITE + '/wiki/pages/1', title: 'Current Paper', sourceSha256: SHA_A }],
        nextCursor: null,
      }),
    });
    h.nodes['w8-library-toggle'].click();
    await until(() => h.library.state().items.length === 1, 'current item listed');
    h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-open')[0].click();
    await flushMicrotasks();
    assert.equal(h.calls.selectCurrent.length, 1);
    assert.equal(h.calls.resumeLocal.length, 0);
    assert.equal(h.calls.urlLookups.length, 0);
    assert.equal(h.calls.getPaper.length, 0);
    h.library.destroy();
  }

  // 2) Local saved draft resume
  {
    const h = createLibraryHarness({
      connected: true,
      resumeLocal: async sha => sha === SHA_A,
      listPapers: async () => ({
        items: [{ pageId: '2', pageUrl: SITE + '/wiki/pages/2', title: 'Draft Paper', sourceSha256: SHA_A }],
        nextCursor: null,
      }),
    });
    h.nodes['w8-library-toggle'].click();
    await until(() => h.library.state().items.length === 1, 'draft item listed');
    h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-open')[0].click();
    await flushMicrotasks();
    assert.deepEqual(h.calls.resumeLocal, [SHA_A]);
    assert.equal(h.calls.urlLookups.length, 0);
    assert.equal(h.calls.getPaper.length, 0);
    h.library.destroy();
  }

  // 3) Valid cached local PDF link via real FalsifyW8PaperLinks.url(sha) (no auth header leaked)
  {
    const cachedUrl = SEARCH_API_BASE + '/v1/w8/paper-links/' + 'a'.repeat(32) + '.pdf';
    const h = createLibraryHarness({
      connected: true,
      cachedUrls: { [SHA_A]: cachedUrl },
      fetchMap: {
        [cachedUrl]: {
          ok: true,
          status: 200,
          arrayBuffer: async () => PDF_A.buffer.slice(PDF_A.byteOffset, PDF_A.byteOffset + PDF_A.byteLength),
        },
      },
      listPapers: async () => ({
        items: [{ pageId: '3', pageUrl: SITE + '/wiki/pages/3', title: 'Cached Link Paper', sourceSha256: SHA_A }],
        nextCursor: null,
      }),
    });
    h.nodes['w8-library-toggle'].click();
    await until(() => h.library.state().items.length === 1, 'cached item listed');
    h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-open')[0].click();
    await until(() => h.calls.openFile.length === 1, 'cached PDF opened');
    assert.deepEqual(plain(h.calls.urlLookups), [SHA_A]);
    assert.equal(h.calls.fetches.length, 1);
    assert.equal(h.calls.fetches[0].url, cachedUrl);
    assert.equal(h.calls.fetches[0].init.credentials, 'omit');
    assert.equal(h.calls.fetches[0].init.headers, undefined);
    assert.equal(h.calls.getPaper.length, 0);
    assert.equal(h.calls.openFile[0].opts.title, 'Cached Link Paper');
    assert.equal(h.calls.openFile[0].opts.expectedSha256, SHA_A);
    h.library.destroy();
  }

  // 4) Public arXiv via mounted search fetch with SHA-256 verified before editing
  {
    const h = createLibraryHarness({
      connected: true,
      listPapers: async () => ({
        items: [{ pageId: '4', pageUrl: SITE + '/wiki/pages/4', title: 'ArXiv Paper', sourceSha256: SHA_B }],
        nextCursor: null,
      }),
      getPaper: async () => ({
        pageId: '4',
        pageUrl: SITE + '/wiki/pages/4',
        title: 'ArXiv Paper Full Title',
        sourceSha256: SHA_B,
        arxivId: '2309.15217v1',
        sourceDriveId: DRIVE_ID_1,
      }),
      loadArxiv: async () => makePdfBlobFile(PDF_B, 'arxiv-2309.15217v1.pdf'),
    });
    h.nodes['w8-library-toggle'].click();
    await until(() => h.library.state().items.length === 1, 'arxiv item listed');
    h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-open')[0].click();
    await until(() => h.calls.openFile.length === 1, 'arxiv PDF opened');
    assert.deepEqual(plain(h.calls.getPaper), [{ pageId: '4', opts: { base: SYNC_API_BASE } }]);
    assert.deepEqual(plain(h.calls.loadArxiv), [{ id: '2309.15217v1', title: 'ArXiv Paper Full Title' }]);
    assert.equal(h.calls.openFile[0].opts.arxivEntry.id, '2309.15217v1');
    h.library.destroy();
  }
});

test('SHA mismatch on cached link or arXiv never opens editor and falls back to user Drive file with no permission elevation', async () => {
  const badCachedUrl = SEARCH_API_BASE + '/v1/w8/paper-links/' + 'b'.repeat(32) + '.pdf';
  const crossOriginUrl = 'https://evil.example/v1/w8/paper-links/' + 'c'.repeat(32) + '.pdf';
  const h = createLibraryHarness({
    connected: true,
    cachedUrls: { [SHA_A]: badCachedUrl, [SHA_C]: crossOriginUrl },
    fetchMap: {
      [badCachedUrl]: {
        ok: true,
        status: 200,
        arrayBuffer: async () => PDF_WRONG.buffer.slice(PDF_WRONG.byteOffset, PDF_WRONG.byteOffset + PDF_WRONG.byteLength),
      },
    },
    listPapers: async () => ({
      items: [
        { pageId: '10', pageUrl: SITE + '/wiki/pages/10', title: 'Mismatched ArXiv Paper', sourceSha256: SHA_A },
        { pageId: '11', pageUrl: SITE + '/wiki/pages/11', title: 'Private Drive Paper', sourceSha256: SHA_C },
      ],
      nextCursor: null,
    }),
    getPaper: async pageId => {
      if (pageId === '10') {
        return {
          pageId: '10',
          pageUrl: SITE + '/wiki/pages/10',
          title: 'Mismatched ArXiv Paper',
          sourceSha256: SHA_A,
          arxivId: '1706.03762',
          sourceDriveId: DRIVE_ID_1,
        };
      }
      return {
        pageId: '11',
        pageUrl: SITE + '/wiki/pages/11',
        title: 'Private Drive Paper',
        sourceSha256: SHA_C,
        arxivId: '',
        sourceDriveId: DRIVE_ID_1,
      };
    },
    loadArxiv: async () => makePdfBlobFile(PDF_WRONG, 'arxiv-1706.03762.pdf'),
  });

  h.nodes['w8-library-toggle'].click();
  await until(() => h.library.state().items.length === 2, 'items listed');

  h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-open')[0].click();
  await until(() => !h.library.state().openingKey && h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-drive').length === 1, 'drive fallback shown for item 10');
  assert.equal(h.calls.openFile.length, 0);
  const driveLinks10 = h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-drive');
  assert.equal(driveLinks10[0].href, 'https://drive.google.com/file/d/' + DRIVE_ID_1 + '/view');
  assert.equal(driveLinks10[0].target, '_blank');
  assert.equal(driveLinks10[0].rel, 'noopener noreferrer');

  const fetchCountBefore = h.calls.fetches.length;
  h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-open')[1].click();
  await until(() => !h.library.state().openingKey && h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-drive').length === 2, 'drive fallback shown for item 11');
  assert.equal(h.calls.openFile.length, 0);
  assert.equal(h.calls.fetches.length, fetchCountBefore);
  h.library.destroy();
});

test('disconnect, 401 expiry, and cross-source supersede clear lists and ignore stale paper and attachment responses', async () => {
  const attListWait = deferred();
  const attBlobWait = deferred();
  let attListCount = 0;

  const h = createLibraryHarness({
    connected: true,
    listPapers: async () => ({
      items: [{ pageId: 'B', pageUrl: SITE + '/wiki/pages/B', title: 'Paper B', sourceSha256: SHA_B }],
      nextCursor: null,
    }),
    getPaper: async () => ({
      pageId: 'B',
      pageUrl: SITE + '/wiki/pages/B',
      title: 'Paper B',
      sourceSha256: SHA_B,
      arxivId: '2309.15217',
      sourceDriveId: '',
    }),
    listPaperAttachments: async () => {
      attListCount += 1;
      if (attListCount === 1) {
        return {
          items: [{ attachmentId: 'att77', pageId: '77', title: 'Slow Attachment.pdf', pageUrl: SITE + '/wiki/pages/77' }],
          nextCursor: 'att-next-1',
        };
      }
      return attListWait.promise;
    },
    getPaperAttachment: async () => attBlobWait.promise,
    loadArxiv: async () => makePdfBlobFile(PDF_B, 'arxiv-2309.15217.pdf'),
  });

  h.nodes['w8-library-toggle'].click();
  await until(() => h.library.state().items.length === 1 && h.library.state().attachments.items.length === 1, 'both loaded');

  // Start slow attachment download, then supersede by opening registered paper B.
  void h.library.openAttachment(h.library.state().attachments.items[0]);
  await flushMicrotasks();
  void h.library.openItem(h.library.state().items[0]);
  await until(() => h.calls.openFile.length === 1 && !h.library.state().openingKey, 'paper B opened');
  assert.equal(h.calls.openFile[0].opts.title, 'Paper B');

  // Late attachment Blob must be ignored (must not open Slow Attachment.pdf).
  attBlobWait.resolve(new Blob([PDF_ATT], { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.calls.openFile.length, 1);

  // Start attachment loadMore (pending), then disconnect -> clears BOTH lists and ignores stale response.
  h.nodes['w8-library-att-more'].click();
  await flushMicrotasks();
  h.disconnectClick();
  await flushMicrotasks();
  assert.equal(h.library.state().items.length, 0);
  assert.equal(h.library.state().attachments.items.length, 0);
  assert.equal(h.nodes['w8-library-list'].children.length, 0);
  assert.equal(h.nodes['w8-library-att-list'].children.length, 0);
  assert.equal(h.nodes['w8-library-sections'].hidden, true);
  assert.equal(h.nodes['w8-library-connect'].hidden, false);

  attListWait.resolve({
    items: [{ attachmentId: 'att999', pageId: '99', title: 'Stale Attachment.pdf', pageUrl: SITE + '/wiki/pages/99' }],
    nextCursor: null,
  });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.library.state().attachments.items.length, 0);
  assert.equal(h.nodes['w8-library-att-list'].children.length, 0);
  h.library.destroy();

  // 401 auth failure on attachments clears BOTH sources and shows reconnect CTA.
  const h401 = createLibraryHarness({
    connected: true,
    listPapers: async () => ({
      items: [{ pageId: '1', pageUrl: SITE + '/wiki/pages/1', title: 'Paper', sourceSha256: SHA_A }],
      nextCursor: null,
    }),
    listPaperAttachments: async () => {
      const err = new Error('unauthorized');
      err.status = 401;
      err.code = 'unauthorized';
      throw err;
    },
  });
  h401.nodes['w8-library-toggle'].click();
  await until(() => /만료/.test(h401.nodes['w8-library-status'].textContent), 'expired message shown');
  assert.equal(h401.library.state().items.length, 0);
  assert.equal(h401.library.state().attachments.items.length, 0);
  assert.equal(h401.nodes['w8-library-connect'].hidden, false);
  h401.library.destroy();
});

test('unsafe sourceDriveId is rejected and never renders a Drive link', async () => {
  const h = createLibraryHarness({
    connected: true,
    listPapers: async () => ({
      items: [{ pageId: 'bad-drive', pageUrl: SITE + '/wiki/pages/99', title: 'Bad Drive Paper', sourceSha256: SHA_C }],
      nextCursor: null,
    }),
    getPaper: async () => ({
      pageId: 'bad-drive',
      pageUrl: SITE + '/wiki/pages/99',
      title: 'Bad Drive Paper',
      sourceSha256: SHA_C,
      arxivId: '',
      sourceDriveId: '../etc/passwd',
    }),
  });
  h.nodes['w8-library-toggle'].click();
  await until(() => h.library.state().items.length === 1, 'bad-drive listed');
  h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-open')[0].click();
  await until(() => !h.library.state().openingKey && h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-notice').length === 1, 'fallback notice rendered');
  assert.equal(h.nodes['w8-library-list'].findAll(n => n.className === 'w8-library-drive').length, 0);
  assert.equal(h.calls.openFile.length, 0);
  h.library.destroy();
});
