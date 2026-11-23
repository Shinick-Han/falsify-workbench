'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { validatePaperSyncPayload, mergePaperSyncState } from '../../cloud/api/src/w8-paper-sync.mjs';

const syncPath = fileURLToPath(new URL('../dist/w8-paper-sync.js', import.meta.url));
const teamPath = fileURLToPath(new URL('../dist/w8-team.js', import.meta.url));
const bluePath = fileURLToPath(new URL('../dist/w8-blue.js', import.meta.url));
const workbenchJsPath = fileURLToPath(new URL('../dist/w8-workbench.js', import.meta.url));
const workbenchHtmlPath = fileURLToPath(new URL('../dist/workbench.html', import.meta.url));

const SYNC_SRC = readFileSync(syncPath, 'utf8');
const TEAM_SRC = readFileSync(teamPath, 'utf8');
const BLUE_SRC = readFileSync(bluePath, 'utf8');
const WORKBENCH_JS_SRC = readFileSync(workbenchJsPath, 'utf8');
const WORKBENCH_HTML_SRC = readFileSync(workbenchHtmlPath, 'utf8');

const PREVIEW_BASE = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const PROD_BASE = 'https://falsify-cloud-api.ai-gongbu.workers.dev';
const PAGE_ORIGIN = 'https://shinick-han.github.io';
const SITE = 'https://falsify.atlassian.net';
const LEDGER_KEY = 'falsify.experiment-ledger.v1';
const SESSION_KEY = 'falsify.w8-session.v1';
const FUTURE = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
const SEALED_TOKEN = 'sealed-w8-session-token-sync-0123456789';

const SHA_A = 'a'.repeat(64);
const REV_A = 'b'.repeat(64);
const SHA_B = 'c'.repeat(64);
const REV_B = 'd'.repeat(64);
const SHA_OLD = 'e'.repeat(64);
const REV_OLD = 'f'.repeat(64);

const b64 = s => Buffer.from(s, 'binary').toString('base64');
const ub64 = s => Buffer.from(s, 'base64').toString('binary');

async function until(pred, label = 'condition') {
  for (let i = 0; i < 400 && !pred(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(pred(), label);
}

class El extends EventTarget {
  constructor(tag, id = '') {
    super();
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.attrs = {};
    this.dataset = {};
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.href = '';
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
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) {
    delete this.attrs[k];
    if (k === 'href') this.href = '';
  }
  click() { if (!this.disabled && !this.hidden) this.dispatchEvent(new Event('click')); }
}

function createHarness({
  searchApiBase = PREVIEW_BASE,
  configApiBase = PROD_BASE,
  routes,
  autoPopup = true,
  preSeedStore = null,
  initialPaperState = null,
  runsByHash = null,
  driveIdsByHash = null,
  recentPapers = [],
  editDebounceMs = 15,
  retryDelayMs = 20,
} = {}) {
  const store = new Map();
  const initialLedger = '{"schema":"falsify.experiment-ledger.v1","runs":[{"id":"legacy-keep","role":"blue","fileHash":"' + SHA_OLD + '","findings":[{"quote":"old"}]}]}';
  store.set(LEDGER_KEY, initialLedger);
  if (preSeedStore) {
    for (const [k, v] of Object.entries(preSeedStore)) store.set(k, String(v));
  }

  const calls = [];
  const openedPopups = [];
  const win = new EventTarget();
  const doc = new EventTarget();
  const nodes = {
    'w8-search': new El('div', 'w8-search'),
    'w8-sync': new El('section', 'w8-sync'),
    'w8-sync-status': new El('p', 'w8-sync-status'),
    'w8-sync-link': new El('a', 'w8-sync-link'),
    'w8-sync-connect': new El('button', 'w8-sync-connect'),
    'w8-sync-retry': new El('button', 'w8-sync-retry'),
    'w8-sync-disconnect': new El('button', 'w8-sync-disconnect'),
  };
  nodes['w8-search'].dataset.apiBase = searchApiBase;
  nodes['w8-sync-link'].hidden = true;
  nodes['w8-sync-retry'].hidden = true;
  nodes['w8-sync-disconnect'].hidden = true;
  doc.getElementById = id => nodes[id] || null;
  doc.createElement = tag => new El(tag);

  const liveIntervals = new Set();
  win.open = (url, name, features) => {
    const popup = {
      closed: false,
      url: String(url),
      name,
      features,
      opener: win,
      close() { this.closed = true; },
    };
    popup.location = {
      set href(v) {
        popup.url = String(v);
        if (autoPopup && /^https:\/\/auth\.atlassian\.com\//.test(popup.url)) {
          const authStartCall = calls.filter(c => c.path === '/v1/w8/paper-auth/start').at(-1);
          const nonce = authStartCall?.body?.nonce;
          const origin = new URL(authStartCall.url).origin;
          setTimeout(() => {
            const ev = new Event('message');
            ev.origin = origin;
            ev.source = popup;
            ev.data = {
              type: 'falsify.confluence.session.v1',
              nonce,
              session: typeof autoPopup === 'function' ? autoPopup(popup) : SEALED_TOKEN,
              expiresAt: FUTURE,
              scopeProfile: 'w8-team',
            };
            win.dispatchEvent(ev);
          }, 5);
        }
      },
      get href() { return popup.url; },
    };
    openedPopups.push(popup);
    return popup;
  };

  let pageCounter = 100;
  const pageBySource = new Map();
  const defaultRoutes = (method, reqPath, init, fullUrl) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const auth = init.headers?.authorization || '';
    if (method === 'GET' && reqPath === '/v1/w8/capabilities') {
      return {
        status: 200,
        body: {
          provider: 'atlassian-w8',
          configured: true,
          siteUrl: SITE,
          spaceKey: 'Falsify',
          spaceId: '65737',
          issueKey: 'FLS-18',
        },
      };
    }
    if (method === 'POST' && reqPath === '/v1/w8/paper-auth/start') {
      return { status: 200, body: { authorizeUrl: `https://auth.atlassian.com/authorize?state=${encodeURIComponent(body.nonce)}` } };
    }
    if (method === 'POST' && reqPath === '/v1/w8/auth/refresh') {
      if (!auth) return { status: 401, body: { error: { code: 'unauthorized' } } };
      return { status: 200, body: { session: auth.replace(/^Bearer /, ''), expiresAt: FUTURE, hasJiraScope: false } };
    }
    if (method === 'PUT' && reqPath === '/v1/w8/paper-sync') {
      if (auth !== 'Bearer ' + SEALED_TOKEN && !auth.startsWith('Bearer sealed-')) {
        return { status: 401, body: { error: { code: 'unauthorized' } } };
      }
      let pageId = pageBySource.get(body.sourceSha256);
      if (!pageId) {
        pageId = String(++pageCounter);
        pageBySource.set(body.sourceSha256, pageId);
      }
      return {
        status: 200,
        body: {
          pageId,
          pageUrl: `${SITE}/wiki/spaces/Falsify/pages/${pageId}/Paper`,
        },
      };
    }
    return { status: 404, body: { error: { code: 'not_found' } }, url: fullUrl };
  };

  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const reqPath = u.pathname + u.search;
    calls.push({ url, origin: u.origin, method: init.method, path: reqPath, headers: { ...init.headers }, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = await (routes ? routes(init.method, reqPath, init, url, defaultRoutes) : defaultRoutes(init.method, reqPath, init, url));
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      headers: { get: name => answer.headers?.[name.toLowerCase()] ?? null },
      text: async () => (answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)),
    };
  };

  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (k === LEDGER_KEY) throw new Error('must never touch experiment ledger');
      store.set(k, String(v));
    },
    removeItem: k => store.delete(k),
  };

  const paperState = initialPaperState || {
    ready: false,
    sourceSha256: null,
    name: '',
    hasEdits: false,
    artifact: null,
  };
  let nextArtifact = null;
  const paper = {
    state: () => ({ ...paperState }),
    recent: () => recentPapers.slice(),
    artifact: async () => {
      if (nextArtifact) return nextArtifact;
      const sha = paperState.artifact?.sha256 || paperState.sourceSha256;
      return { sha256: sha, sourceSha256: paperState.sourceSha256, editCount: paperState.hasEdits ? 1 : 0, file: { name: paperState.name || 'paper.pdf' } };
    },
    setPaper(patch, art) {
      if (patch.sourceSha256 && patch.sourceSha256 !== paperState.sourceSha256 && !Object.hasOwn(patch, 'artifact')) {
        paperState.artifact = null;
      }
      Object.assign(paperState, patch);
      nextArtifact = art || null;
    },
  };

  const runsMap = new Map(Object.entries(runsByHash || {}));
  const blue = {
    runs: hash => (hash ? (runsMap.get(hash) || []).slice() : []),
    setRuns(hash, list) { runsMap.set(hash, list.slice()); },
  };
  const driveIds = new Map(Object.entries(driveIdsByHash || {}));
  const paperLinks = {
    driveId: hash => (hash ? driveIds.get(String(hash).toLowerCase()) || '' : ''),
    setDriveId(hash, id) {
      if (id) driveIds.set(String(hash).toLowerCase(), id);
      else driveIds.delete(String(hash).toLowerCase());
    },
  };

  const ctx = vm.createContext({
    window: win,
    document: doc,
    location: { origin: PAGE_ORIGIN, href: PAGE_ORIGIN + '/falsify-workbench/workbench.html' },
    localStorage: storage,
    fetch: fetchImpl,
    crypto: globalThis.crypto,
    FalsifyCloudConfig: configApiBase ? { apiBase: configApiBase, provider: 'confluence' } : {},
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    Event,
    CustomEvent,
    Uint8Array,
    btoa: b64,
    atob: ub64,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); liveIntervals.add(id); return id; },
    clearInterval: id => { liveIntervals.delete(id); return clearInterval(id); },
    console,
  });
  ctx.globalThis = ctx;

  vm.runInContext(TEAM_SRC, ctx, { filename: 'w8-team.js' });
  vm.runInContext(BLUE_SRC, ctx, { filename: 'w8-blue.js' });
  vm.runInContext(SYNC_SRC, ctx, { filename: 'w8-paper-sync.js' });

  const sync = ctx.FalsifyW8PaperSync.mount({
    document: doc,
    window: win,
    storage,
    paper,
    paperLinks,
    blue,
    team: ctx.FalsifyW8Team,
    editDebounceMs,
    retryDelayMs,
    CustomEvent,
  });

  return {
    sync,
    team: ctx.FalsifyW8Team,
    BlueApi: ctx.FalsifyW8Blue,
    SyncApi: ctx.FalsifyW8PaperSync,
    nodes,
    doc,
    win,
    paper,
    paperLinks,
    blue,
    calls,
    openedPopups,
    store,
    initialLedger,
    cleanup() {
      sync.destroy();
      for (const id of liveIntervals) clearInterval(id);
      liveIntervals.clear();
    },
  };
}

test('static hygiene and regenerated workbench.html have no manual submit button or inline styles', () => {
  assert.doesNotMatch(SYNC_SRC, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/);
  assert.doesNotMatch(SYNC_SRC, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(SYNC_SRC, /<style\b|\.style\./);
  assert.doesNotMatch(WORKBENCH_JS_SRC, /onSubmit\s*:/, 'Workbench must not wire a manual team submit button');
  assert.match(WORKBENCH_HTML_SRC, /id="w8-sync"/);
  assert.match(WORKBENCH_HTML_SRC, /id="w8-sync-connect"[^>]*>Confluence 연결</);
  assert.match(WORKBENCH_HTML_SRC, /id="w8-sync-link"/);
  assert.match(WORKBENCH_HTML_SRC, /src="w8-paper-sync\.js\?v=[0-9a-f]{12}"/);
});

test('buildPayload enforces strict Worker contract, joins by actual hashes, strips RED and %PDF-', () => {
  const h = createHarness();
  try {
    const payload = JSON.parse(JSON.stringify(h.SyncApi.buildPayload({
      sourceSha256: SHA_A,
      title: 'Attention Is All You Need',
      arxivId: '1706.03762',
      revisionSha256: REV_A,
      runs: [
        { id: 'red-1', role: 'red', fileHash: REV_A, findings: [{ quote: 'RED_SECRET' }] },
        { id: 'other-paper-run', role: 'blue', fileHash: SHA_B, model: 'gpt-5', findings: [{ quote: 'WRONG_PAPER' }] },
        {
          id: 'hosted-1',
          role: 'blue',
          fileHash: REV_A,
          model: 'claude-sonnet-5-5',
          segments: [{ id: 's1', text: 'RAW_TEXT_SHOULD_NOT_LEAK' }],
          findings: [
            { id: 'F1', quote: 'Table 1 reports 28.', rationale: 'Inconsistent with text', severity: '높음', verdictLabel: '아님', extraField: 'drop' },
          ],
        },
        {
          id: 'ext-2',
          fileHash: SHA_A,
          model: 'manual-model-unverified',
          snapshot: {
            role: 'blue',
            batches: [{ model: 'gpt-5.5' }],
            items: [{ kind: 'finding', enabled: true, sourceQuote: 'Figure 2', reason: 'Scale mismatch', verdict: '확인필요' }],
          },
        },
        { id: 'empty-3', fileHash: REV_A, model: 'claude-haiku-5-5', findings: [] },
      ],
    })));

    assert.deepEqual(Object.keys(payload).sort(), ['arxivId', 'revisionSha256', 'runs', 'sourceSha256', 'title']);
    assert.equal(payload.sourceSha256, SHA_A);
    assert.equal(payload.revisionSha256, REV_A);
    assert.equal(payload.arxivId, '1706.03762');
    assert.equal(payload.runs.length, 3);
    assert.deepEqual(payload.runs[0], {
      id: 'hosted-1',
      revisionSha256: REV_A,
      model: 'claude-sonnet-5-5',
      findings: [{ id: 'F1', quote: 'Table 1 reports 28.', rationale: 'Inconsistent with text', severity: '높음', verdict: '아님' }],
    });
    assert.deepEqual(payload.runs[1], {
      id: 'ext-2',
      revisionSha256: null,
      model: 'gpt-5.5',
      findings: [{ quote: 'Figure 2', rationale: 'Scale mismatch', verdict: '확인필요' }],
    });
    assert.deepEqual(payload.runs[2], { id: 'empty-3', revisionSha256: REV_A, model: 'claude-haiku-5-5', findings: [] });
    assert.equal(JSON.stringify(payload).includes('RED_SECRET'), false);
    assert.equal(JSON.stringify(payload).includes('WRONG_PAPER'), false);
    assert.equal(JSON.stringify(payload).includes('RAW_TEXT_SHOULD_NOT_LEAK'), false);

    assert.throws(
      () => h.SyncApi.buildPayload({ sourceSha256: SHA_A, title: '%PDF-1.7 fake' }),
      /원본 PDF 바이너리/,
    );
  } finally {
    h.cleanup();
  }
});

test('guest/unauthenticated editor never auto-opens popup or publishes on open, edit, or BLUE runs', async () => {
  const h = createHarness();
  try {
    await h.sync.ready;
    assert.equal(h.nodes['w8-sync-connect'].hidden, false);
    assert.equal(h.nodes['w8-sync-link'].hidden, true);

    h.paper.setPaper({ ready: true, sourceSha256: SHA_A, name: 'Guest.pdf', hasEdits: false });
    h.sync.show({ sourceSha256: SHA_A, title: 'Guest.pdf', opened: true });

    h.paper.setPaper({ ready: true, sourceSha256: SHA_A, name: 'Guest.pdf', hasEdits: true, artifact: { sha256: REV_A } }, { sha256: REV_A, sourceSha256: SHA_A, editCount: 1 });
    h.sync.edited();
    await new Promise(r => setTimeout(r, 40));

    const extRun = { id: 'guest-ext-1', fileHash: REV_A, model: 'gpt-5', findings: [{ quote: 'q', rationale: 'r' }] };
    h.blue.setRuns(REV_A, [extRun]);
    h.doc.dispatchEvent(new CustomEvent('falsify:w8-runs-change', { detail: { fileHash: REV_A, runs: [extRun] } }));
    await new Promise(r => setTimeout(r, 30));

    assert.equal(h.openedPopups.length, 0, 'no auto popup');
    assert.equal(h.calls.length, 0, 'no network sync without authenticated Atlassian session');
    assert.equal(h.nodes['w8-sync-connect'].hidden, false);
    assert.equal(h.store.get(LEDGER_KEY), h.initialLedger);

    // Explicitly connecting publishes the paper still open, including its current revision.
    h.nodes['w8-sync-connect'].click();
    await until(() => h.team.isConnected(), 'connected later');
    await until(() => h.sync.state().pageId, 'open paper published on explicit connection');
    const writes = h.calls.filter(c => c.path === '/v1/w8/paper-sync');
    assert.deepEqual(writes.map(call => [call.body.sourceSha256, call.body.revisionSha256]), [[SHA_A, REV_A]]);
  } finally {
    h.cleanup();
  }
});

test('user-gesture Confluence 연결 + auto-sync on open, revision edit, native and external BLUE runs without submit button or Jira writes', async () => {
  const h = createHarness();
  try {
    await h.sync.ready;

    // Click 'Confluence 연결' on landing screen (user gesture)
    h.nodes['w8-sync-connect'].click();
    await until(() => h.team.isConnected(), 'connected via user gesture');
    assert.equal(h.openedPopups.length, 1);
    assert.equal(h.store.has(SESSION_KEY), true);
    assert.equal(h.store.get(SESSION_KEY).includes(SEALED_TOKEN), false, 'session encrypted');
    assert.equal(h.nodes['w8-sync-connect'].hidden, true);
    assert.equal(h.nodes['w8-sync-disconnect'].hidden, false);

    // 1) Open original paper -> auto-syncs original without submit button
    h.paper.setPaper({ ready: true, sourceSha256: SHA_A, name: 'PaperA.pdf', hasEdits: false });
    h.sync.show({ sourceSha256: SHA_A, title: 'Paper A Title', arxivId: '2401.00001', opened: true });
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 1, 'synced original');

    let syncCalls = h.calls.filter(c => c.path === '/v1/w8/paper-sync');
    assert.equal(syncCalls[0].method, 'PUT');
    assert.equal(syncCalls[0].origin, PREVIEW_BASE);
    assert.equal(syncCalls[0].headers.authorization, 'Bearer ' + SEALED_TOKEN);
    assert.deepEqual(syncCalls[0].body, {
      sourceSha256: SHA_A,
      title: 'Paper A Title',
      arxivId: '2401.00001',
    });
    assert.equal(h.nodes['w8-sync-link'].hidden, false);
    assert.match(h.nodes['w8-sync-link'].href, /^https:\/\/falsify\.atlassian\.net\/wiki\/spaces\/Falsify\/pages\/101\//);

    // 2) Edit paper -> auto-syncs revisionSha256
    h.paper.setPaper(
      { ready: true, sourceSha256: SHA_A, name: 'PaperA.pdf', hasEdits: true, artifact: { sha256: REV_A } },
      { sha256: REV_A, sourceSha256: SHA_A, editCount: 1 },
    );
    h.sync.edited();
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 2, 'synced revision');

    syncCalls = h.calls.filter(c => c.path === '/v1/w8/paper-sync');
    assert.deepEqual(syncCalls[1].body, {
      sourceSha256: SHA_A,
      title: 'Paper A Title',
      arxivId: '2401.00001',
      revisionSha256: REV_A,
    });

    // 3) New native hosted BLUE run -> auto-syncs with runs
    const nativeRun = {
      id: 'hosted-job-1',
      fileHash: REV_A,
      detector: '내장 BLUE',
      model: 'claude-sonnet-5-5',
      findings: [{ id: 'F1', quote: '28 cm', rationale: 'Differs from table', severity: '높음', verdictLabel: '아님' }],
    };
    h.blue.setRuns(REV_A, [nativeRun]);
    h.doc.dispatchEvent(new CustomEvent('falsify:w8-runs-change', { detail: { fileHash: REV_A, runs: [nativeRun] } }));
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 3, 'synced native BLUE run');

    syncCalls = h.calls.filter(c => c.path === '/v1/w8/paper-sync');
    assert.equal(syncCalls[2].body.revisionSha256, REV_A);
    assert.deepEqual(syncCalls[2].body.runs, [{
      id: 'hosted-job-1',
      revisionSha256: REV_A,
      model: 'claude-sonnet-5-5',
      findings: [{ id: 'F1', quote: '28 cm', rationale: 'Differs from table', severity: '높음', verdict: '아님' }],
    }]);

    // 4) New external BLUE run -> auto-syncs both runs joined by actual source/revision
    const extRun = {
      id: 'ext-run-2',
      fileHash: REV_A,
      detector: '외부 AI',
      model: 'gpt-5.5',
      findings: [{ id: 'E1', quote: 'p < 0.01', rationale: 'Recalculated p = 0.08', verdictLabel: '확인필요' }],
    };
    h.blue.setRuns(REV_A, [nativeRun, extRun]);
    h.doc.dispatchEvent(new CustomEvent('falsify:w8-runs-change', { detail: { fileHash: REV_A, runs: [nativeRun, extRun] } }));
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 4, 'synced external BLUE run');

    syncCalls = h.calls.filter(c => c.path === '/v1/w8/paper-sync');
    assert.deepEqual(syncCalls[3].body.runs.map(r => r.id), ['hosted-job-1', 'ext-run-2']);
    assert.equal(h.calls.some(c => c.path === '/v1/w8/submit'), false, 'never writes to Jira /v1/w8/submit');
    assert.equal(h.store.get(LEDGER_KEY), h.initialLedger);
  } finally {
    h.cleanup();
  }
});

test('does not retro-publish existing unrelated local history on reload or tab view, and ignores runs from other papers', async () => {
  // First create an encrypted session via connect on a temporary harness, then carry over localStorage.
  const seed = createHarness();
  await seed.sync.ready;
  seed.nodes['w8-sync-connect'].click();
  await until(() => seed.team.isConnected(), 'seed connected');
  const carried = Object.fromEntries(seed.store.entries());
  carried['falsify.w8-blue.runs.v1'] = JSON.stringify([
    { id: 'old-run-1', fileHash: REV_OLD, model: 'claude-sonnet-5-5', findings: [{ quote: 'old quote' }] },
  ]);
  seed.cleanup();

  const h = createHarness({
    preSeedStore: carried,
    recentPapers: [{ fileHash: SHA_OLD, lastArtifactSha256: REV_OLD, name: 'Old.pdf' }],
    runsByHash: { [REV_OLD]: [{ id: 'old-run-1', fileHash: REV_OLD, model: 'claude-sonnet-5-5', findings: [{ quote: 'old quote' }] }] },
  });
  try {
    await h.sync.ready;
    assert.equal(h.team.isConnected(), true, 'encrypted session restored across reload');

    // Simulate reload resume (opened: false) of untouched old local paper
    h.paper.setPaper({ ready: true, sourceSha256: SHA_OLD, name: 'Old.pdf', hasEdits: true, artifact: { sha256: REV_OLD } });
    h.sync.show({ sourceSha256: SHA_OLD, title: 'Old.pdf', opened: false });

    // Switching to Review tab emits existing old runs -> must NOT retro-publish
    h.doc.dispatchEvent(new CustomEvent('falsify:w8-runs-change', {
      detail: { fileHash: REV_OLD, runs: h.blue.runs(REV_OLD) },
    }));
    await new Promise(r => setTimeout(r, 40));
    assert.equal(h.calls.filter(c => c.path === '/v1/w8/paper-sync').length, 0, 'untouched local history must not retro-publish');

    // Opening Paper B syncs ONLY Paper B (never Old.pdf) and ignores stale runs-change for Old.pdf
    h.paper.setPaper({ ready: true, sourceSha256: SHA_B, name: 'PaperB.pdf', hasEdits: false });
    h.sync.show({ sourceSha256: SHA_B, title: 'PaperB.pdf', opened: true });
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 1, 'synced Paper B');

    h.doc.dispatchEvent(new CustomEvent('falsify:w8-runs-change', {
      detail: { fileHash: REV_OLD, runs: [{ id: 'brand-new-on-old', fileHash: REV_OLD, findings: [] }] },
    }));
    await new Promise(r => setTimeout(r, 30));

    const syncCalls = h.calls.filter(c => c.path === '/v1/w8/paper-sync');
    assert.equal(syncCalls.length, 1);
    assert.equal(syncCalls[0].body.sourceSha256, SHA_B);
    assert.equal(syncCalls[0].body.runs, undefined);
  } finally {
    h.cleanup();
  }
});

test('keeps a sync failure visible until the background retry succeeds', async () => {
  let release;
  let attempts = 0;
  const h = createHarness({ async routes(method, path, init, url, fallback) {
    if (path === '/v1/w8/paper-sync') {
      if (++attempts === 1) return {status:503, body:{error:{code:'upstream_unavailable'}}};
      await new Promise(resolve => { release = resolve; });
    }
    return fallback(method, path, init, url);
  }});
  try {
    await h.sync.ready;
    await h.sync.connect();
    h.paper.setPaper({ready:true, sourceSha256:SHA_A, name:'Paper.pdf', hasEdits:false});
    const paper = {sourceSha256:SHA_A, title:'Paper.pdf', opened:true};
    h.sync.show(paper);
    await until(() => release, 'background retry started');
    h.sync.show(paper);
    assert.equal(h.nodes['w8-sync-status'].textContent, 'Confluence 서버가 응답하지 않아요.');
    assert.equal(h.nodes['w8-sync-retry'].hidden, false);
    assert.equal(h.nodes['w8-sync-retry'].disabled, true);
    release();
    await until(() => !h.nodes['w8-sync-link'].hidden, 'confirmed remote receipt');
    assert.equal(attempts, 2);
    assert.equal(h.nodes['w8-sync-retry'].hidden, true);
  } finally { release?.(); h.cleanup(); }
});

test('keeps a failed connection and its action visible when a paper opens', async () => {
  const h = createHarness({routes(method, path, init, url, fallback) {
    if (path === '/v1/w8/capabilities') return {status:403, body:{error:{code:'origin_not_allowed'}}};
    return fallback(method, path, init, url);
  }});
  try {
    await h.sync.ready;
    await h.sync.connect();
    h.sync.show({sourceSha256:SHA_A, title:'Paper.pdf', opened:true});
    assert.equal(h.nodes['w8-sync-status'].textContent, 'Confluence 연결이 허용되지 않은 Workbench 주소예요.');
    assert.equal(h.nodes['w8-sync-connect'].hidden, false);
  } finally { h.cleanup(); }
});

test('handles switching with pending edits, reload receipt restore without duplicate PUT, and idempotent retry', async () => {
  let failSyncCount = 1;
  const seed = createHarness();
  await seed.sync.ready;
  seed.nodes['w8-sync-connect'].click();
  await until(() => seed.team.isConnected(), 'seed connected');
  const carried = Object.fromEntries(seed.store.entries());
  seed.cleanup();

  const h = createHarness({
    preSeedStore: carried,
    routes(method, reqPath, init, fullUrl, fallback) {
      if (method === 'PUT' && reqPath === '/v1/w8/paper-sync' && failSyncCount > 0) {
        failSyncCount--;
        return { status: 503, body: { error: { code: 'upstream_unavailable' } } };
      }
      return fallback(method, reqPath, init, fullUrl);
    },
  });
  try {
    await h.sync.ready;
    h.paper.setPaper({ ready: true, sourceSha256: SHA_A, name: 'PaperA.pdf', hasEdits: false });
    h.sync.show({ sourceSha256: SHA_A, title: 'PaperA.pdf', opened: true });

    // First attempt returns 503 -> auto-retries idempotently and succeeds!
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 2, 'idempotent retry succeeded');
    assert.equal(h.nodes['w8-sync-link'].hidden, false);
    const pageUrlA = h.nodes['w8-sync-link'].href;

    // Make an edit on Paper A and immediately switch to Paper B before debounce fires -> beforeSwitch flushes Paper A revision!
    h.paper.setPaper(
      { ready: true, sourceSha256: SHA_A, name: 'PaperA.pdf', hasEdits: true, artifact: { sha256: REV_A } },
      { sha256: REV_A, sourceSha256: SHA_A, editCount: 1 },
    );
    h.sync.edited();
    await h.sync.beforeSwitch();

    h.paper.setPaper({ ready: true, sourceSha256: SHA_B, name: 'PaperB.pdf', hasEdits: false });
    h.sync.show({ sourceSha256: SHA_B, title: 'PaperB.pdf', opened: true });
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 4, 'flushed Paper A revision and synced Paper B');

    const syncCalls = h.calls.filter(c => c.path === '/v1/w8/paper-sync');
    assert.ok(syncCalls.some(c => c.body.sourceSha256 === SHA_A && c.body.revisionSha256 === REV_A));
    assert.ok(syncCalls.some(c => c.body.sourceSha256 === SHA_B));
    assert.notEqual(h.nodes['w8-sync-link'].href, pageUrlA, 'UI link belongs to active Paper B, not Paper A');

    // Reload on Paper B -> restores saved link immediately with ZERO extra PUTs!
    const snapshotStore = Object.fromEntries(h.store.entries());
    const reloaded = createHarness({ preSeedStore: snapshotStore });
    try {
      await reloaded.sync.ready;
      reloaded.paper.setPaper({ ready: true, sourceSha256: SHA_B, name: 'PaperB.pdf', hasEdits: false });
      reloaded.sync.show({ sourceSha256: SHA_B, title: 'PaperB.pdf', opened: false });
      await new Promise(r => setTimeout(r, 30));
      assert.equal(reloaded.calls.filter(c => c.path === '/v1/w8/paper-sync').length, 0, 'no redundant PUT on clean reload');
      assert.equal(reloaded.nodes['w8-sync-link'].hidden, false);
      assert.equal(reloaded.nodes['w8-sync-link'].href, h.nodes['w8-sync-link'].href);
    } finally {
      reloaded.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('uses the configured library gateway for OAuth, refresh and sync without sending its token to the search gateway', async () => {
  let attempts = 0;
  const h = createHarness({routes(method, path, init, url, fallback) {
    if (path === '/v1/w8/paper-sync' && ++attempts === 1) return {status:401,body:{error:{code:'unauthorized'}}};
    return fallback(method, path, init, url);
  }});
  h.nodes['w8-search'].dataset.syncBase = PROD_BASE;
  try {
    await h.sync.ready;
    h.nodes['w8-sync-connect'].click();
    await until(() => h.team.isConnected(), 'connected');
    h.paper.setPaper({ready:true,sourceSha256:SHA_A,name:'paper.pdf',hasEdits:false});
    h.sync.show({sourceSha256:SHA_A,title:'paper.pdf',opened:true});
    await until(() => h.sync.state().pageId, 'paper synced after refresh');
    assert.equal(attempts, 2);
    assert.equal(h.openedPopups.length, 1);
    await assert.rejects(h.team.paperSync({sourceSha256:SHA_A},{base:PREVIEW_BASE}), /./);
    assert.ok(h.calls.every(call => call.origin === PROD_BASE));
  } finally { h.cleanup(); }
});

test('unrecoverable 401 clears session and shows reconnect button without auto-popup, and rejects unsafe pageUrl', async () => {
  const seed = createHarness();
  await seed.sync.ready;
  seed.nodes['w8-sync-connect'].click();
  await until(() => seed.team.isConnected(), 'seed connected');
  const carried = Object.fromEntries(seed.store.entries());
  seed.cleanup();

  const expired = createHarness({
    preSeedStore: carried,
    routes(method, reqPath) {
      if (reqPath === '/v1/w8/paper-sync' || reqPath === '/v1/w8/auth/refresh') {
        return { status: 401, body: { error: { code: 'session_expired' } } };
      }
      return { status: 404, body: {} };
    },
  });
  try {
    await expired.sync.ready;
    expired.paper.setPaper({ ready: true, sourceSha256: SHA_A, name: 'Expired.pdf', hasEdits: false });
    expired.sync.show({ sourceSha256: SHA_A, title: 'Expired.pdf', opened: true });
    await until(() => expired.nodes['w8-sync-connect'].hidden === false, 'reconnect button shown');
    assert.equal(expired.openedPopups.length, 0, 'no auto popup on session expiry');
    assert.equal(expired.store.has(SESSION_KEY), false);
    assert.match(expired.nodes['w8-sync-status'].textContent, /만료/);
  } finally {
    expired.cleanup();
  }

  const badUrl = createHarness({
    preSeedStore: carried,
    routes(method, reqPath, init, fullUrl, fallback) {
      if (method === 'PUT' && reqPath === '/v1/w8/paper-sync') {
        return { status: 200, body: { pageId: '888', pageUrl: 'javascript:alert(1)' } };
      }
      return fallback(method, reqPath, init, fullUrl);
    },
  });
  try {
    await badUrl.sync.ready;
    badUrl.paper.setPaper({ ready: true, sourceSha256: SHA_B, name: 'BadUrl.pdf', hasEdits: false });
    badUrl.sync.show({ sourceSha256: SHA_B, title: 'BadUrl.pdf', opened: true });
    await until(() => badUrl.sync.state().failed === true, 'invalid pageUrl rejected');
    assert.equal(badUrl.nodes['w8-sync-link'].hidden, true);
    assert.equal(badUrl.nodes['w8-sync-link'].href, '');
  } finally {
    badUrl.cleanup();
  }
});

test('mixed source and revision projectRuns preserve per-run revisionSha256 and actual finding metadata under Worker validation', async () => {
  const h = createHarness();
  try {
    await h.sync.ready;
    h.nodes['w8-sync-connect'].click();
    await until(() => h.team.isConnected(), 'connected');

    const projectedSourceRuns = JSON.parse(JSON.stringify(h.BlueApi.projectRuns([
      {
        id: 'shared-run-id',
        fileHash: SHA_A,
        detector: '내장 BLUE',
        model: 'claude-sonnet-5-5',
        condition: 'P0',
        createdAt: '2026-11-23T01:00:00.000Z',
        findings: [{
          id: 'F-1',
          pageIndex: 0,
          locationLabel: 'Results / Table 1',
          findingType: 'D1',
          verdictLabel: '아님',
          severity: '불일치',
          quote: 'Table 1 reports 18 cm.',
          rationale: 'Body text says 28 cm.',
          evidence: [{ quote: '28 cm', relation: 'mismatch' }],
          confidence: '높음',
          uncertainty: 'Check appendix',
          status: 'open',
        }],
      },
    ], SHA_A)));

    const projectedRevRuns = JSON.parse(JSON.stringify(h.BlueApi.projectRuns([
      {
        id: 'shared-run-id',
        fileHash: REV_A,
        detector: '내 AI',
        model: 'gpt-5.5',
        condition: '공통 프롬프트 v6',
        createdAt: '2026-11-23T02:00:00.000Z',
        findings: [{
          id: 'F-2',
          pageIndex: 2,
          locationLabel: 'Figure 2',
          findingType: 'D3',
          verdictLabel: '확인필요',
          severity: '높음',
          quote: 'Accuracy rose to 99%.',
          rationale: 'Axis scale is truncated.',
          evidence: [{ quote: 'Figure 2 axis starts at 80%', relation: 'scale' }],
          confidence: '중간',
          uncertainty: '',
        }],
      },
    ], REV_A)));

    // Direct buildPayload also preserves valid createdAt, drops invalid createdAt, and honors explicit per-run revisionSha256.
    const directPayload = JSON.parse(JSON.stringify(h.SyncApi.buildPayload({
      sourceSha256: SHA_A,
      title: 'Mixed Runs Paper',
      revisionSha256: REV_A,
      runs: [
        { ...projectedSourceRuns[0], createdAt: '2026-11-23T01:00:00.000Z' },
        { ...projectedRevRuns[0], createdAt: 'not-a-date' },
        { id: 'explicit-source', revisionSha256: null, model: 'claude-haiku-5-5', findings: [{ id: 'F-3', page: 4, quote: 'p = 0.04' }] },
      ],
    })));
    const validatedDirect = validatePaperSyncPayload(directPayload);
    assert.equal(validatedDirect.runs.length, 3);
    assert.equal(validatedDirect.runs[0].revisionSha256, null);
    assert.equal(validatedDirect.runs[0].createdAt, '2026-11-23T01:00:00.000Z');
    assert.deepEqual(validatedDirect.runs[0].findings[0], {
      id: 'F-1',
      page: 1,
      locationLabel: 'Results / Table 1',
      findingType: 'D1',
      confidence: '높음',
      quote: 'Table 1 reports 18 cm.',
      rationale: 'Body text says 28 cm.',
      severity: '불일치',
      verdict: '아님',
    });
    assert.equal(validatedDirect.runs[1].revisionSha256, REV_A);
    assert.equal(Object.hasOwn(validatedDirect.runs[1], 'createdAt'), false);
    assert.equal(validatedDirect.runs[1].findings[0].page, 3);
    assert.equal(validatedDirect.runs[2].revisionSha256, null);
    assert.equal(validatedDirect.runs[2].findings[0].page, 4);

    // End-to-end sync with both source and revision projected runs present in one PUT payload.
    h.blue.setRuns(SHA_A, projectedSourceRuns);
    h.paper.setPaper(
      { ready: true, sourceSha256: SHA_A, name: 'Mixed.pdf', hasEdits: true, artifact: { sha256: REV_A } },
      { sha256: REV_A, sourceSha256: SHA_A, editCount: 1 },
    );
    h.sync.show({ sourceSha256: SHA_A, title: 'Mixed Runs Paper', opened: true });
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 1, 'initial sync with source run');

    h.blue.setRuns(REV_A, projectedRevRuns);
    h.doc.dispatchEvent(new CustomEvent('falsify:w8-runs-change', { detail: { fileHash: REV_A, runs: projectedRevRuns } }));
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 2, 'mixed sync with source + revision runs');

    const mixedBody = h.calls.filter(c => c.path === '/v1/w8/paper-sync')[1].body;
    const validated = validatePaperSyncPayload(mixedBody);
    const merged = mergePaperSyncState(null, validated, { key: 'atl:tester', label: 'Tester' });

    assert.equal(mixedBody.revisionSha256, REV_A);
    assert.equal(mixedBody.runs.length, 2);
    assert.equal(mixedBody.runs[0].id, 'shared-run-id');
    assert.equal(mixedBody.runs[0].revisionSha256, null, 'source run keeps null revisionSha256 even when top-level revisionSha256 is set');
    assert.equal(mixedBody.runs[0].findings[0].page, 1);
    assert.equal(mixedBody.runs[0].findings[0].locationLabel, 'Results / Table 1');
    assert.equal(mixedBody.runs[0].findings[0].findingType, 'D1');
    assert.equal(mixedBody.runs[0].findings[0].confidence, '높음');
    assert.equal(mixedBody.runs[1].id, 'shared-run-id');
    assert.equal(mixedBody.runs[1].revisionSha256, REV_A, 'revision run keeps its revisionSha256');
    assert.equal(mixedBody.runs[1].findings[0].page, 3);

    assert.equal(merged.runs.length, 2, 'server merge keeps source and revision runs distinct');
    assert.ok(merged.runs.some(r => r.id === 'shared-run-id' && r.revisionSha256 === null && r.findings[0].page === 1));
    assert.ok(merged.runs.some(r => r.id === 'shared-run-id' && r.revisionSha256 === REV_A && r.findings[0].page === 3));
  } finally {
    h.cleanup();
  }
});

test('delayed Drive link availability event refreshes synced paper with sourceDriveId/revisionDriveId without retro-publishing', async () => {
  const h = createHarness();
  try {
    await h.sync.ready;
    h.nodes['w8-sync-connect'].click();
    await until(() => h.team.isConnected(), 'connected');

    // 1) Open paper before Drive upload completes -> initial PUT has no Drive IDs.
    h.paper.setPaper({ ready: true, sourceSha256: SHA_A, name: 'DrivePaper.pdf', hasEdits: false });
    h.sync.show({ sourceSha256: SHA_A, title: 'DrivePaper.pdf', opened: true });
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 1, 'initial sync without Drive ID');
    assert.equal(h.calls.filter(c => c.path === '/v1/w8/paper-sync')[0].body.sourceDriveId, undefined);

    // 2) Delayed source Drive link becomes available -> falsify:w8-pdf-link triggers refresh PUT with sourceDriveId.
    const SRC_DRIVE_ID = 'drive_source_0123456789';
    h.paperLinks.setDriveId(SHA_A, SRC_DRIVE_ID);
    h.doc.dispatchEvent(new CustomEvent('falsify:w8-pdf-link', { detail: { sha256: SHA_A, action: 'saved' } }));
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 2, 'refreshed with sourceDriveId');
    const afterSourceLink = h.calls.filter(c => c.path === '/v1/w8/paper-sync')[1].body;
    assert.equal(afterSourceLink.sourceDriveId, SRC_DRIVE_ID);
    assert.equal(afterSourceLink.revisionDriveId, undefined);
    assert.equal(validatePaperSyncPayload(afterSourceLink).sourceDriveId, SRC_DRIVE_ID);

    // 3) Duplicate saved event with same Drive ID, revoked event, and unrelated hash produce ZERO extra PUTs.
    h.doc.dispatchEvent(new CustomEvent('falsify:w8-pdf-link', { detail: { sha256: SHA_A, action: 'saved' } }));
    h.doc.dispatchEvent(new CustomEvent('falsify:w8-pdf-link', { detail: { sha256: SHA_A, action: 'revoked' } }));
    h.doc.dispatchEvent(new CustomEvent('falsify:w8-pdf-link', { detail: { sha256: SHA_B, action: 'saved' } }));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(h.calls.filter(c => c.path === '/v1/w8/paper-sync').length, 2);

    // 4) Edit paper before revision Drive upload finishes -> PUT has revisionSha256 & sourceDriveId, no revisionDriveId yet.
    h.paper.setPaper(
      { ready: true, sourceSha256: SHA_A, name: 'DrivePaper.pdf', hasEdits: true, artifact: { sha256: REV_A } },
      { sha256: REV_A, sourceSha256: SHA_A, editCount: 1 },
    );
    h.sync.edited();
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 3, 'revision synced before Drive link');
    assert.equal(h.calls.filter(c => c.path === '/v1/w8/paper-sync')[2].body.revisionSha256, REV_A);
    assert.equal(h.calls.filter(c => c.path === '/v1/w8/paper-sync')[2].body.revisionDriveId, undefined);

    // 5) Delayed revision Drive link arrives -> triggers refresh PUT with both sourceDriveId and revisionDriveId.
    const REV_DRIVE_ID = 'drive_revision_0123456789';
    h.paperLinks.setDriveId(REV_A, REV_DRIVE_ID);
    h.doc.dispatchEvent(new CustomEvent('falsify:w8-pdf-link', { detail: { sha256: REV_A, action: 'saved' } }));
    await until(() => h.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 4, 'refreshed with revisionDriveId');
    const afterRevLink = h.calls.filter(c => c.path === '/v1/w8/paper-sync')[3].body;
    assert.equal(afterRevLink.sourceDriveId, SRC_DRIVE_ID);
    assert.equal(afterRevLink.revisionDriveId, REV_DRIVE_ID);
    const validatedRev = validatePaperSyncPayload(afterRevLink);
    assert.equal(validatedRev.sourceDriveId, SRC_DRIVE_ID);
    assert.equal(validatedRev.revisionDriveId, REV_DRIVE_ID);

    // 6) Reload with untouched local paper (opened: false, no prior pageId) must NOT retro-publish on Drive link event,
    //    while an already-synced paper receiving falsify:w8-pdf-link before restore finishes DOES refresh once restored.
    const carried = Object.fromEntries(h.store.entries());
    const untouched = createHarness({ preSeedStore: carried });
    try {
      await untouched.sync.ready;
      untouched.paper.setPaper({ ready: true, sourceSha256: SHA_OLD, name: 'Old.pdf', hasEdits: false });
      untouched.sync.show({ sourceSha256: SHA_OLD, title: 'Old.pdf', opened: false });
      untouched.paperLinks.setDriveId(SHA_OLD, 'drive_old_0123456789');
      untouched.doc.dispatchEvent(new CustomEvent('falsify:w8-pdf-link', { detail: { sha256: SHA_OLD, action: 'saved' } }));
      await new Promise(r => setTimeout(r, 30));
      assert.equal(untouched.calls.filter(c => c.path === '/v1/w8/paper-sync').length, 0, 'untouched paper must not retro-publish on Drive link event');
    } finally {
      untouched.cleanup();
    }

    const preRestore = createHarness({ preSeedStore: carried });
    try {
      preRestore.paper.setPaper(
        { ready: true, sourceSha256: SHA_A, name: 'DrivePaper.pdf', hasEdits: true, artifact: { sha256: REV_A } },
        { sha256: REV_A, sourceSha256: SHA_A, editCount: 1 },
      );
      preRestore.sync.show({ sourceSha256: SHA_A, title: 'DrivePaper.pdf', opened: false });
      const NEW_REV_DRIVE_ID = 'drive_revision_refreshed_99';
      preRestore.paperLinks.setDriveId(SHA_A, SRC_DRIVE_ID);
      preRestore.paperLinks.setDriveId(REV_A, NEW_REV_DRIVE_ID);
      preRestore.doc.dispatchEvent(new CustomEvent('falsify:w8-pdf-link', { detail: { sha256: REV_A, action: 'saved' } }));
      await preRestore.sync.ready;
      await until(() => preRestore.calls.filter(c => c.path === '/v1/w8/paper-sync').length === 1, 'refreshed already-synced paper after restore');
      assert.equal(preRestore.calls.filter(c => c.path === '/v1/w8/paper-sync')[0].body.revisionDriveId, NEW_REV_DRIVE_ID);
    } finally {
      preRestore.cleanup();
    }
  } finally {
    h.cleanup();
  }
});
