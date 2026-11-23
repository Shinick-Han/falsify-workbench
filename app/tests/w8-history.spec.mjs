'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const historyPath = fileURLToPath(new URL('../dist/w8-history.js', import.meta.url));
const shellHtmlPath = fileURLToPath(new URL('../../scripts/workbench-shell.html', import.meta.url));
const workbenchCssPath = fileURLToPath(new URL('../dist/w8-workbench.css', import.meta.url));

const HISTORY_SRC = readFileSync(historyPath, 'utf8');
const SHELL_HTML_SRC = readFileSync(shellHtmlPath, 'utf8');
const WORKBENCH_CSS_SRC = readFileSync(workbenchCssPath, 'utf8');

const SYNC_API_BASE = 'https://falsify-cloud-api.ai-gongbu.workers.dev';
const SITE = 'https://falsify.atlassian.net';
const PDF_BYTES_A = new TextEncoder().encode('%PDF-1.7\n% history pdf A\n%%EOF\n');
const PDF_BYTES_B = new TextEncoder().encode('%PDF-1.7\n% history pdf B\n%%EOF\n');

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

function makeErr(code, status, message) {
  const err = new Error(message || code);
  err.code = code;
  err.errorCode = code;
  if (status) err.status = status;
  return err;
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

class FakeMutationObserver {
  constructor(cb) {
    this.cb = cb;
    this.target = null;
  }
  observe(target) { this.target = target; }
  disconnect() { this.target = null; }
  trigger() { if (this.target) this.cb([]); }
}

function createHistoryHarness({
  connected = true,
  panelHidden = false,
  syncBase = SYNC_API_BASE,
  historyList = async () => ({ items: [], nextCursor: null }),
  historyDetail = async () => ({ id: '', title: '', url: '', updatedAt: '', kind: '', text: '', links: [], attachments: [], nextAttachmentCursor: null }),
  historyFile = async () => new Blob([PDF_BYTES_A], { type: 'application/pdf' }),
  connectHistory = async () => ({ connected: true }),
} = {}) {
  const doc = new EventTarget();
  const win = new EventTarget();
  const observers = [];
  const nodes = {
    'w8-search': new El('div', 'w8-search'),
    'w8-sync': new El('section', 'w8-sync'),
    'w8-sync-disconnect': new El('button', 'w8-sync-disconnect'),
    'w8-library-panel': new El('section', 'w8-library-panel'),
    'w8-history-group': new El('div', 'w8-history-group'),
    'w8-history-refresh': new El('button', 'w8-history-refresh'),
    'w8-history-retry': new El('button', 'w8-history-retry'),
    'w8-history-tab-confluence': new El('button', 'w8-history-tab-confluence'),
    'w8-history-tab-jira': new El('button', 'w8-history-tab-jira'),
    'w8-history-body': new El('div', 'w8-history-body'),
    'w8-history-status': new El('p', 'w8-history-status'),
    'w8-history-actions': new El('div', 'w8-history-actions'),
    'w8-history-jira-connect': new El('button', 'w8-history-jira-connect'),
    'w8-history-list': new El('ul', 'w8-history-list'),
    'w8-history-more': new El('button', 'w8-history-more'),
    'w8-history-detail': new El('article', 'w8-history-detail'),
    'w8-blue': new El('div', 'w8-blue'),
    'w8-csv': new El('div', 'w8-csv'),
  };
  nodes['w8-search'].dataset.syncBase = syncBase;
  nodes['w8-library-panel'].hidden = panelHidden;
  nodes['w8-history-body'].hidden = true;
  nodes['w8-history-detail'].hidden = true;
  nodes['w8-history-detail'].dataset.historyViewer = 'readonly';
  doc.getElementById = id => nodes[id] || null;
  doc.createElement = tag => {
    const el = new El(tag);
    el.ownerDocument = doc;
    return el;
  };

  let isConn = connected;
  const calls = {
    historyList: [],
    historyDetail: [],
    historyFile: [],
    connectHistory: [],
    openFile: [],
  };

  const team = {
    isConnected: () => isConn,
    historyList: async (source, opts) => {
      calls.historyList.push({ source, opts });
      return historyList(source, opts);
    },
    historyDetail: async (source, id, opts) => {
      calls.historyDetail.push({ source, id, opts });
      return historyDetail(source, id, opts);
    },
    historyFile: async (source, id, attachment, opts) => {
      calls.historyFile.push({ source, id, attachment, opts });
      return historyFile(source, id, attachment, opts);
    },
    connectHistory: async opts => {
      calls.connectHistory.push(opts);
      return connectHistory(opts);
    },
  };

  const paperSync = {
    state: () => ({ connected: isConn, syncBase }),
  };

  class TrackedObserver extends FakeMutationObserver {
    constructor(cb) {
      super(cb);
      observers.push(this);
    }
  }

  const ctx = vm.createContext({
    window: win,
    document: doc,
    location: { origin: 'https://shinick-han.github.io', href: 'https://shinick-han.github.io/falsify-workbench/workbench.html' },
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
  vm.runInContext(HISTORY_SRC, ctx, { filename: 'w8-history.js' });

  const history = ctx.FalsifyW8History.mount({
    document: doc,
    window: win,
    File: FakeFile,
    MutationObserver: TrackedObserver,
    team,
    paperSync,
    openFile: async (file, opts) => { calls.openFile.push({ file, opts }); },
  });

  return {
    history,
    api: ctx.FalsifyW8History,
    nodes,
    doc,
    calls,
    setConnected(v) { isConn = v; },
    setPanelHidden(v) { nodes['w8-library-panel'].hidden = v; },
    emitSyncState(stateName) {
      nodes['w8-sync'].dataset.syncState = stateName;
      for (const obs of observers) obs.trigger();
    },
    disconnectClick() {
      isConn = false;
      nodes['w8-sync-disconnect'].dispatchEvent(new Event('click'));
    },
  };
}

test('static hygiene, shell markup inside library panel, scope label 팀 기록, and responsive styles', () => {
  assert.doesNotMatch(HISTORY_SRC, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/);
  assert.doesNotMatch(HISTORY_SRC, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(HISTORY_SRC, /<style\b|\.style\./);
  assert.doesNotMatch(HISTORY_SRC, /localStorage|sessionStorage/);
  assert.doesNotMatch(SHELL_HTML_SRC, /\sstyle=/);

  const panelStart = SHELL_HTML_SRC.indexOf('id="w8-library-panel"');
  const panelEnd = SHELL_HTML_SRC.indexOf('</section>', panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart, 'Confluence library panel exists');
  const panelSlice = SHELL_HTML_SRC.slice(panelStart, panelEnd);

  assert.match(panelSlice, /id="w8-library-papers-group"/, 'existing papers group preserved');
  assert.match(panelSlice, /id="w8-library-att-group"/, 'existing attachments group preserved');
  assert.match(panelSlice, /id="w8-history-group"[\s\S]*?<span class="booth-klab">팀 기록<\/span>/);
  assert.match(panelSlice, /id="w8-history-tab-confluence"[^>]*>Confluence<\/button>/);
  assert.match(panelSlice, /id="w8-history-tab-jira"[^>]*>Jira<\/button>/);
  assert.match(panelSlice, /id="w8-history-detail"[^>]*data-history-viewer="readonly"/);

  const reviewStart = SHELL_HTML_SRC.indexOf('id="w8-review"');
  assert.ok(panelEnd < reviewStart, 'historical viewer stays outside BLUE review inputs');
  assert.match(WORKBENCH_CSS_SRC, /\.w8-history-tabs/);
  assert.match(WORKBENCH_CSS_SRC, /\.w8-history-pre/);
});

test('collapsed library panel makes zero calls on mount or sync state transitions, and list loads lazily per tab', async () => {
  const h = createHistoryHarness({
    connected: true,
    panelHidden: true,
    historyList: async source => ({
      items: source === 'confluence'
        ? [{ id: '101', title: 'W8 실험 노트', url: SITE + '/wiki/spaces/Falsify/pages/101', updatedAt: '2026-11-20T01:00:00Z', kind: 'page', attachmentCount: 2 }]
        : [{ id: 'FLS-18', title: 'W8 BLUE 결과 수집', url: SITE + '/browse/FLS-18', updatedAt: '2026-11-21T02:00:00Z', kind: 'task', attachmentCount: 1 }],
      nextCursor: null,
    }),
  });

  await flushMicrotasks();
  h.emitSyncState('connected');
  await flushMicrotasks();
  assert.equal(h.calls.historyList.length, 0, 'no calls while collapsed');

  // Even programmatic selectSource while collapsed must not fetch.
  await h.history.selectSource('confluence');
  assert.equal(h.calls.historyList.length, 0, 'no calls while panel is hidden');

  // Expand panel: still zero calls until user chooses a source tab.
  h.setPanelHidden(false);
  await flushMicrotasks();
  assert.equal(h.calls.historyList.length, 0, 'lazy list waits for source tab click');

  // Click Confluence tab: fetches ONLY confluence, not jira and not detail.
  h.nodes['w8-history-tab-confluence'].click();
  await until(() => h.history.state().sources.confluence.loaded, 'confluence loaded');
  assert.equal(h.calls.historyList.length, 1);
  assert.deepEqual(plain(h.calls.historyList[0]), { source: 'confluence', opts: { base: SYNC_API_BASE } });
  assert.equal(h.calls.historyDetail.length, 0, 'no eager detail fetch');
  assert.equal(h.nodes['w8-history-tab-confluence'].getAttribute('aria-selected'), 'true');
  assert.equal(h.nodes['w8-history-tab-jira'].getAttribute('aria-selected'), 'false');

  // Click Jira tab: fetches ONLY jira and lists actual issue identifier FLS-18.
  h.nodes['w8-history-tab-jira'].click();
  await until(() => h.history.state().sources.jira.loaded, 'jira loaded');
  assert.equal(h.calls.historyList.length, 2);
  assert.deepEqual(plain(h.calls.historyList[1]), { source: 'jira', opts: { base: SYNC_API_BASE } });
  const idBadges = h.nodes['w8-history-list'].findAll(n => n.className === 'w8-history-id');
  assert.deepEqual(idBadges.map(n => n.textContent), ['FLS-18']);

  // Switching back to Confluence reuses cached items without refetching.
  h.nodes['w8-history-tab-confluence'].click();
  await flushMicrotasks();
  assert.equal(h.calls.historyList.length, 2);
  assert.equal(h.nodes['w8-history-list'].children.length, 1);
  h.history.destroy();
});

test('source-local pagination keeps Confluence and Jira cursors and items independent', async () => {
  const h = createHistoryHarness({
    connected: true,
    historyList: async (source, { cursor }) => {
      if (source === 'confluence') {
        if (!cursor) {
          return {
            items: [
              { id: 'c1', title: '노트 1', url: SITE + '/wiki/pages/c1', updatedAt: '2026-11-18T00:00:00Z', kind: 'page' },
              { id: 'c2', title: '노트 2', url: 'https://evil.example/phish', updatedAt: '2026-11-19T00:00:00Z', kind: 'page' },
            ],
            nextCursor: 'conf-p2',
          };
        }
        return {
          items: [
            { id: 'c2', title: '중복 무시', url: SITE + '/wiki/pages/c2', updatedAt: '2026-11-19T00:00:00Z', kind: 'page' },
            { id: 'c3', title: '노트 3', url: SITE + '/wiki/pages/c3', updatedAt: '2026-11-20T00:00:00Z', kind: 'page' },
          ],
          nextCursor: null,
        };
      }
      if (!cursor) {
        return {
          items: [{ id: 'FLS-18', title: '첫 번째 이슈', url: SITE + '/browse/FLS-18', updatedAt: '2026-11-19T00:00:00Z', kind: 'task' }],
          nextCursor: 'jira-p2',
        };
      }
      return {
        items: [{ id: 'FLS-42', title: '두 번째 이슈', url: SITE + '/browse/FLS-42', updatedAt: '2026-11-22T00:00:00Z', kind: 'bug' }],
        nextCursor: null,
      };
    },
  });

  h.nodes['w8-history-tab-confluence'].click();
  await until(() => h.history.state().sources.confluence.items.length === 2, 'conf page 1');
  // Unsafe domain on c2 is stripped, never rendered as link.
  assert.equal(h.history.state().sources.confluence.items[1].url, '');
  assert.equal(h.nodes['w8-history-more'].hidden, false);

  h.nodes['w8-history-more'].click();
  await until(() => h.history.state().sources.confluence.items.length === 3, 'conf page 2 merged');
  assert.deepEqual(plain(h.calls.historyList[1]), { source: 'confluence', opts: { cursor: 'conf-p2', base: SYNC_API_BASE } });
  assert.equal(h.nodes['w8-history-more'].hidden, true);

  // Switch to Jira and paginate independently.
  h.nodes['w8-history-tab-jira'].click();
  await until(() => h.history.state().sources.jira.items.length === 1, 'jira page 1');
  assert.equal(h.nodes['w8-history-more'].hidden, false);
  h.nodes['w8-history-more'].click();
  await until(() => h.history.state().sources.jira.items.length === 2, 'jira page 2');
  assert.deepEqual(plain(h.calls.historyList[3]), { source: 'jira', opts: { cursor: 'jira-p2', base: SYNC_API_BASE } });
  const jiraIds = h.nodes['w8-history-list'].findAll(n => n.className === 'w8-history-id').map(n => n.textContent);
  assert.deepEqual(jiraIds, ['FLS-18', 'FLS-42']);
  assert.equal(h.history.state().sources.confluence.items.length, 3, 'confluence untouched');
  h.history.destroy();
});

test('detail viewer supports readable article/links, attachment pagination, inert Markdown/CSV preview, native xlsx/pptx links, and PDF openFile without touching BLUE', async () => {
  const h = createHistoryHarness({
    connected: true,
    historyList: async () => ({
      items: [{ id: 'FLS-18', title: 'W8 검수 기록', url: SITE + '/browse/FLS-18', updatedAt: '2026-11-22T03:00:00Z', kind: 'task', attachmentCount: 4 }],
      nextCursor: null,
    }),
    historyDetail: async (source, id, { attachmentCursor }) => {
      if (!attachmentCursor) {
        return {
          id,
          title: 'W8 검수 기록',
          url: SITE + '/browse/FLS-18',
          updatedAt: '2026-11-22T03:00:00Z',
          kind: 'task',
          text: '1차 요약 문단\n\n<script>alert("xss")</script> 그대로 텍스트로 표시',
          links: [
            { title: 'arXiv 원문', url: 'https://arxiv.org/abs/1706.03762' },
            { title: '위험 링크', url: 'javascript:alert(1)' },
            { title: 'HTTP 차단', url: 'http://example.com/a' },
          ],
          attachments: [
            { id: 'att-pdf', title: 'revised-paper.pdf', type: 'pdf', url: SITE + '/rest/api/3/attachment/content/1' },
            { id: 'att-csv', title: 'blue-results.csv', type: 'text', url: SITE + '/rest/api/3/attachment/content/2' },
          ],
          nextAttachmentCursor: 'att-page-2',
        };
      }
      return {
        attachments: [
          { id: 'att-xlsx', title: 'summary.xlsx', type: 'file', url: SITE + '/rest/api/3/attachment/content/3' },
          { id: 'att-pptx-bad', title: 'slides.pptx', type: 'file', url: 'https://untrusted.example/slides.pptx' },
        ],
        nextAttachmentCursor: null,
      };
    },
    historyFile: async (source, id, attachment) => {
      if (attachment.type === 'text') {
        return { text: 'col1,col2\n=cmd|"calc"!A0,<img src=x onerror=alert(1)>', truncated: true };
      }
      return new Blob([PDF_BYTES_A], { type: 'application/pdf' });
    },
  });

  h.nodes['w8-history-tab-jira'].click();
  await until(() => h.history.state().sources.jira.items.length === 1, 'jira item listed');

  // Lazy per-item detail fetch on click.
  h.nodes['w8-history-list'].findAll(n => n.className.includes('w8-history-open'))[0].click();
  await until(() => Boolean(h.history.state().sources.jira.detail), 'detail loaded');
  assert.equal(h.calls.historyDetail.length, 1);
  assert.deepEqual(plain(h.calls.historyDetail[0]), { source: 'jira', id: 'FLS-18', opts: { base: SYNC_API_BASE } });

  // Safe https link kept, javascript: and http: filtered out.
  const linkNodes = h.nodes['w8-history-detail'].findAll(n => n.tagName === 'A' && n.href.includes('arxiv.org'));
  assert.equal(linkNodes.length, 1);
  assert.equal(linkNodes[0].rel, 'noopener noreferrer');
  const badLinks = h.nodes['w8-history-detail'].findAll(n => n.tagName === 'A' && (/javascript:|http:\/\//i.test(n.href)));
  assert.equal(badLinks.length, 0);

  // Article body is inert textContent (no script element created).
  assert.equal(h.nodes['w8-history-detail'].findAll(n => n.tagName === 'SCRIPT').length, 0);
  const bodyNode = h.nodes['w8-history-detail'].findAll(n => n.className === 'w8-history-text')[0];
  assert.match(bodyNode.textContent, /<script>alert\("xss"\)<\/script>/);

  // Load second page of attachments via attachmentCursor.
  const attMoreBtn = h.nodes['w8-history-detail'].findAll(n => n.className.includes('w8-history-att-more'))[0];
  attMoreBtn.click();
  await until(() => h.history.state().sources.jira.detail.attachments.length === 4, 'attachments page 2 loaded');
  assert.deepEqual(plain(h.calls.historyDetail[1]), {
    source: 'jira',
    id: 'FLS-18',
    opts: { base: SYNC_API_BASE, attachmentCursor: 'att-page-2' },
  });

  // Native link for xlsx on allowed site; untrusted pptx URL downgraded to plain inert span.
  const fileLinks = h.nodes['w8-history-detail'].findAll(n => n.tagName === 'A' && n.dataset.attType === 'file');
  assert.equal(fileLinks.length, 1);
  assert.equal(fileLinks[0].href, SITE + '/rest/api/3/attachment/content/3');
  const plainFiles = h.nodes['w8-history-detail'].findAll(n => n.className === 'w8-history-att-plain');
  assert.equal(plainFiles.length, 1);
  assert.match(plainFiles[0].textContent, /slides\.pptx/);

  // Open text (CSV) attachment -> inert <pre><code> + truncated notice; zero openFile calls; BLUE untouched.
  const csvBtn = h.nodes['w8-history-detail'].findAll(n => n.dataset.attId === 'att-csv' && n.tagName === 'BUTTON')[0];
  csvBtn.click();
  await until(() => h.nodes['w8-history-detail'].findAll(n => n.tagName === 'CODE').length === 1, 'csv inert preview rendered');
  assert.equal(h.calls.historyFile.length, 1);
  assert.equal(h.calls.historyFile[0].attachment.id, 'att-csv');
  assert.equal(h.calls.historyFile[0].attachment.type, 'text');
  const codeNode = h.nodes['w8-history-detail'].findAll(n => n.tagName === 'CODE')[0];
  assert.match(codeNode.textContent, /=cmd\|"calc"!A0/);
  assert.equal(h.nodes['w8-history-detail'].findAll(n => n.tagName === 'IMG').length, 0);
  assert.equal(h.nodes['w8-history-detail'].findAll(n => n.className.includes('w8-history-truncated')).length, 1);
  assert.equal(h.calls.openFile.length, 0);
  assert.equal(h.nodes['w8-blue'].children.length, 0);
  assert.equal(h.nodes['w8-csv'].children.length, 0);

  // Open PDF attachment -> downloads Blob and passes File + {title} to openFile.
  const pdfBtn = h.nodes['w8-history-detail'].findAll(n => n.dataset.attId === 'att-pdf' && n.tagName === 'BUTTON')[0];
  pdfBtn.click();
  await until(() => h.calls.openFile.length === 1, 'pdf opened in normal editor');
  assert.equal(h.calls.historyFile[1].attachment.id, 'att-pdf');
  assert.equal(h.calls.historyFile[1].attachment.type, 'pdf');
  assert.equal(h.calls.openFile[0].file.type, 'application/pdf');
  assert.equal(h.calls.openFile[0].file.name, 'revised-paper.pdf');
  assert.deepEqual(plain(h.calls.openFile[0].opts), { title: 'revised-paper.pdf' });
  h.history.destroy();
});

test('Jira jira_scope_required requires explicit connectHistory and preserves Confluence on cancel or escalation', async () => {
  let jiraGranted = false;
  let connectAttempt = 0;

  const h = createHistoryHarness({
    connected: true,
    historyList: async source => {
      if (source === 'confluence') {
        return {
          items: [{ id: 'p-1', title: '팀 회의록', url: SITE + '/wiki/pages/p-1', updatedAt: '2026-11-20T00:00:00Z', kind: 'page' }],
          nextCursor: 'conf-next',
        };
      }
      if (!jiraGranted) throw makeErr('jira_scope_required', 403, 'scope required');
      return {
        items: [{ id: 'FLS-99', title: '권한 승인 후 이슈', url: SITE + '/browse/FLS-99', updatedAt: '2026-11-22T00:00:00Z', kind: 'task' }],
        nextCursor: null,
      };
    },
    connectHistory: async () => {
      connectAttempt += 1;
      if (connectAttempt === 1) throw makeErr('auth_cancelled', 0, 'cancelled');
      jiraGranted = true;
      return { connected: true };
    },
  });

  // Load Confluence first.
  h.nodes['w8-history-tab-confluence'].click();
  await until(() => h.history.state().sources.confluence.items.length === 1, 'confluence loaded');

  // Switch to Jira -> receives jira_scope_required, does NOT auto-call connectHistory.
  h.nodes['w8-history-tab-jira'].click();
  await until(() => h.history.state().sources.jira.scopeRequired, 'jira scope required shown');
  assert.equal(h.calls.connectHistory.length, 0, 'no automatic auth escalation');
  assert.equal(h.nodes['w8-history-jira-connect'].hidden, false);
  assert.equal(h.history.state().sources.confluence.items.length, 1, 'confluence preserved on scope error');

  // Explicit Jira connect click -> user cancels -> Confluence still preserved, Jira connect button remains.
  h.nodes['w8-history-jira-connect'].click();
  await until(() => !h.history.state().jiraConnecting && /취소/.test(h.nodes['w8-history-status'].textContent), 'cancel message shown');
  assert.equal(h.calls.connectHistory.length, 1);
  assert.deepEqual(plain(h.calls.connectHistory[0]), { base: SYNC_API_BASE });
  assert.equal(h.nodes['w8-history-jira-connect'].hidden, false);
  assert.equal(h.history.state().sources.confluence.items.length, 1, 'confluence preserved on cancel');
  assert.equal(h.history.state().sources.confluence.nextCursor, 'conf-next');

  // Switch back to Confluence -> preserved items still visible without refetching.
  h.nodes['w8-history-tab-confluence'].click();
  await flushMicrotasks();
  assert.equal(h.nodes['w8-history-list'].children.length, 1);

  // Switch to Jira and approve escalation -> loads Jira issues while keeping Confluence intact.
  h.nodes['w8-history-tab-jira'].click();
  await flushMicrotasks();
  h.nodes['w8-history-jira-connect'].click();
  await until(() => h.history.state().sources.jira.items.length === 1, 'jira loaded after escalation');
  assert.equal(h.nodes['w8-history-jira-connect'].hidden, true);
  assert.equal(h.history.state().sources.jira.items[0].id, 'FLS-99');
  assert.equal(h.history.state().sources.confluence.items.length, 1, 'confluence preserved after escalation');
  h.history.destroy();
});

test('disconnect, 401 expiry, and late responses clear authenticated data and prevent stale renders or PDF opens', async () => {
  const slowDetail = deferred();
  const slowPdf = deferred();
  let detailCalls = 0;

  const h = createHistoryHarness({
    connected: true,
    historyList: async () => ({
      items: [
        { id: 'c1', title: 'Page 1', url: SITE + '/wiki/pages/c1', updatedAt: '2026-11-20T00:00:00Z', kind: 'page' },
        { id: 'c2', title: 'Page 2', url: SITE + '/wiki/pages/c2', updatedAt: '2026-11-21T00:00:00Z', kind: 'page' },
      ],
      nextCursor: null,
    }),
    historyDetail: async (source, id) => {
      detailCalls += 1;
      if (detailCalls === 1) return slowDetail.promise;
      return {
        id,
        title: 'Page 2',
        url: SITE + '/wiki/pages/c2',
        updatedAt: '2026-11-21T00:00:00Z',
        kind: 'page',
        text: 'Second page body',
        links: [],
        attachments: [{ id: 'pdf-slow', title: 'slow.pdf', type: 'pdf', url: SITE + '/wiki/download/1' }],
        nextAttachmentCursor: null,
      };
    },
    historyFile: async () => slowPdf.promise,
  });

  h.nodes['w8-history-tab-confluence'].click();
  await until(() => h.history.state().sources.confluence.items.length === 2, 'confluence loaded');

  // Start slow detail for c1, then supersede with c2.
  const openBtns = h.nodes['w8-history-list'].findAll(n => n.className.includes('w8-history-open'));
  openBtns[0].click();
  await flushMicrotasks();
  openBtns[1].click();
  await until(() => h.history.state().sources.confluence.detail?.id === 'c2', 'c2 detail loaded');

  // Late c1 detail must be ignored.
  slowDetail.resolve({ id: 'c1', title: 'Stale Page 1', url: SITE + '/wiki/pages/c1', updatedAt: '', kind: 'page', text: 'stale', links: [], attachments: [], nextAttachmentCursor: null });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.history.state().sources.confluence.detail?.id, 'c2');

  // Start slow PDF download, then disconnect -> clears everything and late PDF must not call openFile.
  const pdfBtn = h.nodes['w8-history-detail'].findAll(n => n.dataset.attId === 'pdf-slow' && n.tagName === 'BUTTON')[0];
  pdfBtn.click();
  await flushMicrotasks();

  h.disconnectClick();
  await flushMicrotasks();
  assert.equal(h.history.state().activeSource, '');
  assert.equal(h.history.state().sources.confluence.items.length, 0);
  assert.equal(h.history.state().sources.confluence.detail, null);
  assert.equal(h.nodes['w8-history-list'].children.length, 0);
  assert.equal(h.nodes['w8-history-detail'].hidden, true);
  assert.equal(h.nodes['w8-history-body'].hidden, true);

  slowPdf.resolve(new Blob([PDF_BYTES_B], { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.calls.openFile.length, 0, 'late PDF after disconnect ignored');
  h.history.destroy();

  // 401 expiry clears both sources and shows expiry notice.
  const h401 = createHistoryHarness({
    connected: true,
    historyList: async source => {
      if (source === 'confluence') {
        return { items: [{ id: 'c1', title: 'Cached', url: SITE + '/wiki/pages/c1', updatedAt: '', kind: 'page' }], nextCursor: null };
      }
      throw makeErr('unauthorized', 401, 'expired');
    },
  });
  h401.nodes['w8-history-tab-confluence'].click();
  await until(() => h401.history.state().sources.confluence.items.length === 1, 'confluence cached');
  h401.nodes['w8-history-tab-jira'].click();
  await until(() => h401.history.state().authExpired, '401 cleared session');
  assert.equal(h401.history.state().sources.confluence.items.length, 0);
  assert.equal(h401.history.state().sources.jira.items.length, 0);
  assert.equal(h401.nodes['w8-history-list'].children.length, 0);
  assert.match(h401.nodes['w8-history-status'].textContent, /만료/);
  h401.history.destroy();
});

test('page-2 retry preserves page 1, Markdown preview caches and stays inert, and invalid PDF bytes never open editor', async () => {
  let page2Attempts = 0;
  const h = createHistoryHarness({
    connected: true,
    historyList: async (source, { cursor }) => {
      if (!cursor) {
        return {
          items: [{ id: 'm1', title: 'Markdown & Bad PDF', url: SITE + '/wiki/pages/m1', updatedAt: '2026-11-20T00:00:00Z', kind: 'page' }],
          nextCursor: 'p2',
        };
      }
      page2Attempts += 1;
      if (page2Attempts === 1) throw makeErr('network', 0, 'net err');
      return {
        items: [{ id: 'm2', title: 'Page 2 Item', url: SITE + '/wiki/pages/m2', updatedAt: '2026-11-21T00:00:00Z', kind: 'page' }],
        nextCursor: null,
      };
    },
    historyDetail: async () => ({
      id: 'm1',
      title: 'Markdown & Bad PDF',
      url: SITE + '/wiki/pages/m1',
      updatedAt: '2026-11-20T00:00:00Z',
      kind: 'page',
      text: 'Summary body',
      links: [],
      attachments: [
        { id: 'md-1', title: 'notes.md', type: 'text', url: SITE + '/wiki/download/md1' },
        { id: 'bad-pdf', title: 'corrupt.pdf', type: 'pdf', url: SITE + '/wiki/download/bad' },
      ],
      nextAttachmentCursor: null,
    }),
    historyFile: async (source, id, att) => {
      if (att.id === 'md-1') return { text: '# Heading\n[xss](javascript:alert(1))', truncated: false };
      return new Blob([new TextEncoder().encode('NOT A PDF')], { type: 'application/pdf' });
    },
  });

  h.nodes['w8-history-tab-confluence'].click();
  await until(() => h.history.state().sources.confluence.items.length === 1, 'page 1 loaded');

  // Trigger page-2 failure -> page 1 remains, retry button appears.
  h.nodes['w8-history-more'].click();
  await until(() => Boolean(h.history.state().sources.confluence.errorMessage), 'page 2 error shown');
  assert.equal(h.history.state().sources.confluence.items.length, 1, 'page 1 preserved');
  assert.equal(h.nodes['w8-history-retry'].hidden, false);

  // Retry loads page 2 without dropping page 1.
  h.nodes['w8-history-retry'].click();
  await until(() => h.history.state().sources.confluence.items.length === 2, 'page 2 recovered');

  // Open detail -> open Markdown attachment -> toggle off -> toggle on uses cache (only 1 historyFile call).
  h.nodes['w8-history-list'].findAll(n => n.className.includes('w8-history-open'))[0].click();
  await until(() => Boolean(h.history.state().sources.confluence.detail), 'detail loaded');

  const mdBtn = () => h.nodes['w8-history-detail'].findAll(n => n.dataset.attId === 'md-1' && n.tagName === 'BUTTON')[0];
  mdBtn().click();
  await until(() => h.nodes['w8-history-detail'].findAll(n => n.tagName === 'CODE').length === 1, 'md preview open');
  assert.equal(h.calls.historyFile.length, 1);
  assert.equal(h.nodes['w8-history-detail'].findAll(n => n.tagName === 'A' && n.href.startsWith('javascript:')).length, 0);

  mdBtn().click();
  await flushMicrotasks();
  assert.equal(h.nodes['w8-history-detail'].findAll(n => n.tagName === 'CODE').length, 0, 'md preview collapsed');

  mdBtn().click();
  await flushMicrotasks();
  assert.equal(h.nodes['w8-history-detail'].findAll(n => n.tagName === 'CODE').length, 1, 'md preview reopened from cache');
  assert.equal(h.calls.historyFile.length, 1, 'no duplicate fetch for cached text attachment');

  // Corrupt PDF must not call openFile and renders inline error.
  const badPdfBtn = h.nodes['w8-history-detail'].findAll(n => n.dataset.attId === 'bad-pdf' && n.tagName === 'BUTTON')[0];
  badPdfBtn.click();
  await until(() => h.nodes['w8-history-detail'].findAll(n => n.className.includes('w8-library-notice')).length === 1, 'pdf error notice shown');
  assert.equal(h.calls.openFile.length, 0);
  h.history.destroy();
});
