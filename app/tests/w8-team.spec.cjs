'use strict';
// Focused browser-module regression tests for app/dist/w8-team.js.
// Synthetic DOM, mocked OAuth popup and gateway. No live network, real Atlassian account, or D1.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.resolve(__dirname, '../dist/w8-team.js'), 'utf8');
const BASE = 'https://api.test';
const GATEWAY_ORIGIN = 'https://api.test';
const PAGE_ORIGIN = 'https://shinick-han.github.io';
const SITE = 'https://falsify.atlassian.net';
const LEDGER_KEY = 'falsify.experiment-ledger.v1';
const SESSION_KEY = 'falsify.w8-session.v1';
const RECEIPTS_KEY = 'falsify.w8-receipts.v1';
const FUTURE = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
const SEALED_TOKEN = 'sealed-w8-session-token-synthetic-0123456789';

const BOM_CSV = '\uFEFF참가자,조건,탐지기,모델,실행번호,ID,물리 페이지,위치(절·그림·표),유형,판정(아님/확인필요),심각도,정확한 원문 인용,대응 근거·이유·검산,확신,추가로 필요한 정보\r\n홍길동,A,내장 BLUE,claude-sonnet-5-5,1,F1,2,Section 2,numerical,확인필요,major,Sample quote,Reason here,high,\r\n';
const FILENAME = 'Blue_W8_홍길동_A.csv';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const liveIntervals = new Set();
const until = async (fn, label) => {
  for (let i = 0; i < 300 && !fn(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(fn(), label);
};

class El extends EventTarget {
  constructor(tag) {
    super();
    Object.assign(this, {
      tagName: tag.toUpperCase(),
      children: [],
      attrs: {},
      _text: '',
      className: '',
      disabled: false,
      hidden: false,
      href: '',
      target: '',
      rel: '',
      type: '',
    });
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      add: c => { const s = set(); s.add(c); this.className = [...s].join(' '); },
      remove: c => { const s = set(); s.delete(c); this.className = [...s].join(' '); },
      contains: c => set().has(c),
    };
  }
  get textContent() { return this._text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  append(...kids) { for (const c of kids) if (c !== null && c !== undefined) this.children.push(c); }
  replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}

const b64 = s => Buffer.from(s, 'binary').toString('base64');
const ub64 = s => Buffer.from(s, 'base64').toString('binary');

function sampleRuns() {
  return [
    {
      id: 'red-secret-run',
      role: 'red',
      finalState: { selected: [{ id: 'P1', before: 'a', after: 'b' }] },
      gold: [{ id: 'G1', answer: 'SECRET_RED_ANSWER' }],
      segments: [{ id: 's0', label: 'p.1', text: 'FULL_RAW_DOCUMENT_TEXT_DO_NOT_UPLOAD' }],
    },
    {
      id: 'blue-run-1',
      role: 'blue',
      createdAt: '2026-11-23T01:00:00.000Z',
      model: 'claude-sonnet-5-5',
      provenance: 'local-codex',
      fileHash: 'a'.repeat(64),
      sourceHash: 'b'.repeat(64),
      sourceRunId: 'red-secret-run',
      comparison: { sourceRunId: 'red-secret-run', selected: [{ id: 'P1' }] },
      segments: [{ id: 's0', label: 'p.2 Section 2', pageIndex: 1, text: 'FULL_RAW_DOCUMENT_TEXT_DO_NOT_UPLOAD' }],
      response: {
        status: 'ok',
        findings: [
          {
            id: 'F1',
            segmentId: 's0',
            quote: 'Sample quote',
            rationale: 'Reason here',
            uncertainty: 'Limited context',
            evidence: [{ segmentId: 's0', quote: 'Table 1', relation: 'contradicts' }],
          },
        ],
      },
    },
    {
      id: 'ext-blue-2',
      role: 'blue',
      createdAt: '2026-11-23T02:00:00.000Z',
      provenance: 'external-ai-import',
      fileHash: 'a'.repeat(64),
      sourceHash: 'b'.repeat(64),
      segments: [{ id: 's0', label: 'p.3', text: 'ANOTHER_RAW_DOC_TEXT' }],
      snapshot: {
        role: 'blue',
        batches: [{ model: 'gpt-5.5', prompt: 'w8-common-v6', raw: 'RAW_EXTERNAL_TEXT' }],
        items: [
          {
            id: 'EF1',
            kind: 'finding',
            enabled: true,
            pageIndex: 2,
            locationLabel: 'Section 3',
            findingType: 'citation',
            severity: 'minor',
            verdictLabel: '확인필요',
            confidence: 'medium',
            quote: 'External quote',
            rationale: 'External rationale',
            evidence: [],
          },
        ],
      },
    },
  ];
}

function setup({ routes, config, autoPopup = true, blockPopup = false } = {}) {
  const store = new Map();
  const initialLedger = '{"schema":"falsify.experiment-ledger.v1","runs":[{"id":"local-keep"}]}';
  store.set(LEDGER_KEY, initialLedger);

  const opened = [];
  const calls = [];
  const win = new EventTarget();
  let confirmCalled = false;
  let alertCalled = false;
  win.confirm = () => { confirmCalled = true; return true; };
  win.alert = () => { alertCalled = true; };
  win.open = (url, name, features) => {
    if (blockPopup) return null;
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
          const nonce = calls.filter(c => c.path === '/v1/w8/auth/start').at(-1)?.body?.nonce;
          setTimeout(() => {
            const ev = new Event('message');
            ev.origin = GATEWAY_ORIGIN;
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
    opened.push(popup);
    return popup;
  };

  const defaultRoutes = (method, reqPath, init) => {
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
          parentPageId: '8355842',
          issueKey: 'FLS-18',
          allowedIssues: ['FLS-18'],
          maxArchiveBytes: 6 * 1024 * 1024,
          maxCsvBytes: 2 * 1024 * 1024,
        },
      };
    }
    if (method === 'POST' && reqPath === '/v1/w8/auth/start') {
      return { status: 200, body: { authorizeUrl: `https://auth.atlassian.com/authorize?state=${encodeURIComponent(body.nonce)}` } };
    }
    if (method === 'POST' && reqPath === '/v1/w8/auth/refresh') {
      if (!auth) return { status: 401, body: { error: { code: 'unauthorized' } } };
      return { status: 200, body: { session: auth.replace(/^Bearer /, ''), expiresAt: FUTURE, hasJiraScope: true } };
    }
    if (method === 'POST' && reqPath === '/v1/w8/submit') {
      if (!auth) return { status: 401, body: { error: { code: 'unauthorized' } } };
      return {
        status: 201,
        body: {
          submitted: true,
          pageId: '9101',
          pageUrl: `${SITE}/wiki/spaces/Falsify/pages/9101/W8`,
          issueKey: body.issueKey || 'FLS-18',
          issueUrl: `${SITE}/browse/${body.issueKey || 'FLS-18'}?focusedCommentId=1001`,
          attachmentId: '501',
          attachmentFilename: body.filename,
          attachmentUrl: `${SITE}/rest/api/3/attachment/content/501`,
          commentId: '1001',
          csvSha256: body.archive.csvSha256,
          archiveSha256: 'c'.repeat(64),
          reused: { page: false, attachment: false, comment: false },
          alreadyExisted: false,
          commentUpdated: false,
        },
      };
    }
    return { status: 404, body: { error: { code: 'not_found' } } };
  };

  const fetch = async (url, init) => {
    const u = new URL(url);
    const reqPath = u.pathname + u.search;
    calls.push({ url, method: init.method, path: reqPath, headers: { ...init.headers }, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = await (routes ? routes(init.method, reqPath, init, defaultRoutes) : defaultRoutes(init.method, reqPath, init));
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      headers: { get: name => answer.headers?.[name.toLowerCase()] ?? null },
      blob: async () => answer.blob,
      text: async () => (answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)),
    };
  };

  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (k === LEDGER_KEY) throw new Error('must never touch experiment ledger');
      store.set(k, String(v));
    },
    removeItem: k => store.delete(k),
  };

  const document = {
    createElement: tag => new El(tag),
  };

  const ctx = vm.createContext({
    window: win,
    document,
    location: { origin: PAGE_ORIGIN, href: PAGE_ORIGIN + '/falsify-workbench/' },
    localStorage,
    fetch,
    crypto: globalThis.crypto,
    FalsifyCloudConfig: config || { apiBase: BASE, provider: 'confluence' },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    Event,
    Uint8Array,
    btoa: b64,
    atob: ub64,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); liveIntervals.add(id); return id; },
    clearInterval: id => { liveIntervals.delete(id); return clearInterval(id); },
    console,
  });

  vm.runInContext(src, ctx, { filename: 'w8-team.js' });
  return {
    api: ctx.FalsifyW8Team,
    calls,
    opened,
    store,
    document,
    win,
    initialLedger,
    confirmCalled: () => confirmCalled,
    alertCalled: () => alertCalled,
  };
}

test('buildArchive sanitizes BLUE-only runs and strips raw documents, RED runs, and answers', async () => {
  const t = setup();
  const built = await t.api.buildArchive({
    csv: BOM_CSV,
    filename: FILENAME,
    participant: '홍길동',
    runs: sampleRuns(),
    condition: 'A',
  });
  assert.equal(built.archive.schema, 'falsify.w8-blue-archive.v1');
  assert.equal(built.archive.runCount, 2, 'RED run must be excluded');
  assert.equal(built.archive.findingCount, 2);
  assert.equal(built.archive.runs[0].findings[0].page, 2, 'page resolved before stripping segments');
  assert.equal(built.archive.runs[1].model, 'gpt-5.5');
  assert.equal(built.archive.runs[1].sourceKind, 'external');
  const serialized = JSON.stringify(built.archive);
  assert.equal(serialized.includes('FULL_RAW_DOCUMENT_TEXT_DO_NOT_UPLOAD'), false);
  assert.equal(serialized.includes('ANOTHER_RAW_DOC_TEXT'), false);
  assert.equal(serialized.includes('SECRET_RED_ANSWER'), false);
  assert.equal(serialized.includes('red-secret-run'), false);
  assert.equal(serialized.includes('RAW_EXTERNAL_TEXT'), false);
  assert.equal(serialized.includes('"segments"'), false);
  assert.equal(serialized.includes('"gold"'), false);

  await assert.rejects(
    t.api.buildArchive({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs: [sampleRuns()[0]], condition: 'A' }),
    /RED 기록은 팀에 제출할 수 없습니다/,
  );
});

test('FalsifyW8Team.submit connects inline when unauthenticated, returns {pageUrl, issueUrl}, and encrypts session', async () => {
  const t = setup();
  const result = await t.api.submit({
    csv: BOM_CSV,
    filename: FILENAME,
    participant: '홍길동',
    runs: sampleRuns(),
    condition: 'A',
  });

  assert.equal(result.pageUrl, `${SITE}/wiki/spaces/Falsify/pages/9101/W8`);
  assert.equal(result.issueUrl, `${SITE}/browse/FLS-18?focusedCommentId=1001`);
  assert.equal(t.opened.length, 1);
  assert.equal(t.store.has(SESSION_KEY), true);
  assert.equal(t.store.get(SESSION_KEY).includes(SEALED_TOKEN), false, 'session must be encrypted in localStorage');
  assert.equal(t.store.get(LEDGER_KEY), t.initialLedger, 'local experiment ledger untouched');

  const submitCall = t.calls.find(c => c.path === '/v1/w8/submit');
  assert.ok(submitCall);
  assert.equal(submitCall.body.csv, BOM_CSV, 'exact BOM CSV preserved');
  assert.equal(submitCall.body.filename, FILENAME);
  assert.equal(submitCall.body.archive.runCount, 2);
  assert.equal(JSON.stringify(submitCall.body).includes('SECRET_RED_ANSWER'), false);

  const savedReceipt = t.api.receipt({ participant: '홍길동', issueKey: 'FLS-18' });
  assert.equal(savedReceipt.pageUrl, result.pageUrl);
  assert.equal(savedReceipt.issueUrl, result.issueUrl);
  assert.equal(savedReceipt.state, 'complete');
});

test('partial write saves progress receipt and subsequent submit resumes cleanly without duplicates', async () => {
  let attempt = 0;
  const t = setup({
    routes(method, reqPath, init, fallback) {
      if (method === 'POST' && reqPath === '/v1/w8/submit') {
        attempt++;
        const body = JSON.parse(init.body);
        if (attempt === 1) {
          return {
            status: 409,
            body: {
              error: { code: 'write_partial', message: 'stopped' },
              readBack: true,
              progress: {
                pageId: '9101',
                pageUrl: `${SITE}/wiki/spaces/Falsify/pages/9101/W8`,
                attachmentId: '501',
                attachmentUrl: `${SITE}/rest/api/3/attachment/content/501`,
                commentId: null,
              },
            },
          };
        }
        assert.equal(body.resume?.pageId, '9101', 'resume hint carries prior pageId');
        assert.equal(body.resume?.attachmentId, '501', 'resume hint carries prior attachmentId');
        return {
          status: 201,
          body: {
            submitted: true,
            pageId: '9101',
            pageUrl: `${SITE}/wiki/spaces/Falsify/pages/9101/W8`,
            issueKey: 'FLS-18',
            issueUrl: `${SITE}/browse/FLS-18?focusedCommentId=1001`,
            attachmentId: '501',
            attachmentFilename: body.filename,
            attachmentUrl: `${SITE}/rest/api/3/attachment/content/501`,
            commentId: '1001',
            csvSha256: body.archive.csvSha256,
            archiveSha256: 'd'.repeat(64),
            reused: { page: true, attachment: true, comment: false },
            alreadyExisted: false,
            commentUpdated: false,
          },
        };
      }
      return fallback(method, reqPath, init);
    },
  });

  await assert.rejects(
    t.api.submit({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs: sampleRuns(), condition: 'A' }),
    /완료된 단계를 재사용/,
  );
  const partial = t.api.receipt({ participant: '홍길동', issueKey: 'FLS-18' });
  assert.equal(partial.state, 'partial');
  assert.equal(partial.pageId, '9101');
  assert.equal(partial.attachmentId, '501');

  const resumed = await t.api.submit({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs: sampleRuns(), condition: 'A' });
  assert.equal(resumed.reused.page, true);
  assert.equal(resumed.reused.attachment, true);
  assert.equal(t.api.receipt({ participant: '홍길동', issueKey: 'FLS-18' }).state, 'complete');
  assert.equal(t.store.get(LEDGER_KEY), t.initialLedger);
});

test('jira_scope_required triggers inline scope upgrade reconnect and completes submission', async () => {
  let submits = 0;
  const t = setup({
    autoPopup: () => (submits === 0 ? 'sealed-confluence-only-token-0000' : 'sealed-w8-upgraded-token-9999'),
    routes(method, reqPath, init, fallback) {
      if (method === 'POST' && reqPath === '/v1/w8/submit') {
        submits++;
        if (submits === 1) {
          return { status: 403, body: { error: { code: 'jira_scope_required' } } };
        }
      }
      return fallback(method, reqPath, init);
    },
  });

  const res = await t.api.submit({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs: sampleRuns(), condition: 'A' });
  assert.equal(submits, 2);
  assert.equal(t.opened.length, 2, 'reconnected inline to expand scopes');
  assert.equal(res.pageUrl, `${SITE}/wiki/spaces/Falsify/pages/9101/W8`);
  assert.equal(res.issueUrl, `${SITE}/browse/FLS-18?focusedCommentId=1001`);
});

test('unauthenticated/unconfigured/blocked popup preserves local ledger and throws clean Korean error', async () => {
  const unauth = setup({ autoPopup: false });
  await assert.rejects(
    unauth.api.submit({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs: sampleRuns(), condition: 'A', autoConnect: false }),
    /Atlassian 팀 연결이 필요합니다/,
  );
  assert.equal(unauth.store.get(LEDGER_KEY), unauth.initialLedger);

  const blocked = setup({ blockPopup: true });
  await assert.rejects(
    blocked.api.submit({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs: sampleRuns(), condition: 'A' }),
    /팝업이 차단/,
  );
  assert.equal(blocked.store.get(LEDGER_KEY), blocked.initialLedger);

  const off = setup({
    routes(method, reqPath, init, fallback) {
      if (method === 'GET' && reqPath === '/v1/w8/capabilities') {
        return { status: 200, body: { provider: 'atlassian-w8', configured: false, siteUrl: SITE, spaceKey: 'Falsify', spaceId: '65737', issueKey: 'FLS-18' } };
      }
      return fallback(method, reqPath, init);
    },
  });
  await assert.rejects(
    off.api.submit({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs: sampleRuns(), condition: 'A' }),
    /로컬 CSV 다운로드와 작업은 계속/,
  );
  assert.equal(off.store.get(LEDGER_KEY), off.initialLedger);
  assert.equal(off.opened[0]?.closed, true, 'pre-opened popup closed when unconfigured');
});

test('mounted Korean UI submits directly with no extra approvals or precautionary modals', async () => {
  const t = setup();
  const host = new El('div');
  const panel = t.api.mount(host, {
    getPayload: () => ({
      csv: BOM_CSV,
      filename: FILENAME,
      participant: '홍길동',
      runs: sampleRuns(),
      condition: 'A',
    }),
  });
  assert.match(panel.section.textContent, /팀에 제출/);
  assert.match(panel.section.textContent, /FLS-18/);
  assert.match(panel.section.textContent, /원본 PDF·RED 정답 제외/);

  panel.submitBtn.click();
  await until(() => /제출했습니다/.test(panel.statusEl.textContent), 'submitted via button');
  assert.equal(t.confirmCalled(), false, 'no confirm modal');
  assert.equal(t.alertCalled(), false, 'no alert modal');
  assert.equal(panel.linksEl.children.length, 2);
  assert.equal(panel.linksEl.children[0].href, `${SITE}/wiki/spaces/Falsify/pages/9101/W8`);
  assert.equal(panel.linksEl.children[1].href, `${SITE}/browse/FLS-18?focusedCommentId=1001`);
  assert.equal(panel.disconnectBtn.hidden, false);

  panel.disconnectBtn.click();
  assert.match(panel.statusEl.textContent, /로컬 작업과 CSV는 그대로/);
  assert.equal(t.store.has(SESSION_KEY), false);
  assert.equal(t.store.get(LEDGER_KEY), t.initialLedger);
});

test('comment timeout alternate paths in browser: reconciles via read-only status if committed, or resumes cleanly on retry if uncommitted', async () => {
  const built = await setup().api.buildArchive({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs: sampleRuns(), condition: 'A' });

  // Path 1: POST /v1/w8/submit returns 409 write_unknown after Jira comment actually landed -> GET /v1/w8/status reconciles immediately.
  let submitCalls1 = 0;
  const committed = setup({
    routes(method, reqPath, init, fallback) {
      if (method === 'POST' && reqPath === '/v1/w8/submit') {
        submitCalls1++;
        return {
          status: 409,
          body: {
            error: { code: 'write_unknown', message: 'timeout' },
            readBack: true,
            progress: { pageId: '9101', pageUrl: `${SITE}/wiki/spaces/Falsify/pages/9101/W8`, attachmentId: '501' },
          },
        };
      }
      if (method === 'GET' && reqPath.startsWith('/v1/w8/status?')) {
        return {
          status: 200,
          body: {
            found: true,
            issueKey: 'FLS-18',
            issueUrl: `${SITE}/browse/FLS-18?focusedCommentId=1001`,
            commentId: '1001',
            pageId: '9101',
            pageUrl: `${SITE}/wiki/spaces/Falsify/pages/9101/W8`,
            attachmentId: '501',
            attachmentFilename: FILENAME,
            attachmentUrl: `${SITE}/rest/api/3/attachment/content/501`,
            csvSha256: built.csvSha256,
            archiveSha256: built.archiveSha256,
          },
        };
      }
      return fallback(method, reqPath, init);
    },
  });

  const rec = await committed.api.submit({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs: sampleRuns(), condition: 'A' });
  assert.equal(submitCalls1, 1, 'no blind POST replay when status readback proves commit landed');
  assert.equal(rec.reconciled, true);
  assert.equal(rec.alreadyExisted, true);
  assert.equal(rec.pageUrl, `${SITE}/wiki/spaces/Falsify/pages/9101/W8`);
  assert.equal(rec.issueUrl, `${SITE}/browse/FLS-18?focusedCommentId=1001`);
  assert.equal(committed.api.receipt({ participant: '홍길동', issueKey: 'FLS-18' }).state, 'complete');

  // Path 2: POST /v1/w8/submit times out BEFORE comment landed -> GET /v1/w8/status returns found=false -> throws resumable error (no blind replay) -> repeated identical submit completes cleanly!
  let submitCalls2 = 0;
  const uncommitted = setup({
    routes(method, reqPath, init, fallback) {
      if (method === 'POST' && reqPath === '/v1/w8/submit') {
        submitCalls2++;
        if (submitCalls2 === 1) {
          return {
            status: 409,
            body: {
              error: { code: 'write_unknown', message: 'timeout' },
              readBack: true,
              progress: { pageId: '9101', pageUrl: `${SITE}/wiki/spaces/Falsify/pages/9101/W8`, attachmentId: '501' },
            },
          };
        }
        const body = JSON.parse(init.body);
        assert.equal(body.resume?.pageId, '9101');
        assert.equal(body.resume?.attachmentId, '501');
        return {
          status: 201,
          body: {
            submitted: true,
            pageId: '9101',
            pageUrl: `${SITE}/wiki/spaces/Falsify/pages/9101/W8`,
            issueKey: 'FLS-18',
            issueUrl: `${SITE}/browse/FLS-18?focusedCommentId=1001`,
            attachmentId: '501',
            attachmentFilename: FILENAME,
            attachmentUrl: `${SITE}/rest/api/3/attachment/content/501`,
            commentId: '1001',
            csvSha256: built.csvSha256,
            archiveSha256: built.archiveSha256,
            reused: { page: true, attachment: true, comment: false },
            alreadyExisted: false,
            commentUpdated: false,
          },
        };
      }
      if (method === 'GET' && reqPath.startsWith('/v1/w8/status?')) {
        return { status: 200, body: { found: false, issueKey: 'FLS-18', issueUrl: `${SITE}/browse/FLS-18` } };
      }
      return fallback(method, reqPath, init);
    },
  });

  await assert.rejects(
    uncommitted.api.submit({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs: sampleRuns(), condition: 'A' }),
    /원격 상태를 대조해 남은 단계만/,
  );
  assert.equal(submitCalls2, 1, 'no blind automatic replay when comment did not land');
  assert.equal(uncommitted.api.receipt({ participant: '홍길동', issueKey: 'FLS-18' }).state, 'partial');

  const done = await uncommitted.api.submit({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs: sampleRuns(), condition: 'A' });
  assert.equal(submitCalls2, 2);
  assert.deepEqual({ ...done.reused }, { page: true, attachment: true, comment: false });
  assert.equal(uncommitted.api.receipt({ participant: '홍길동', issueKey: 'FLS-18' }).state, 'complete');
});

test('buildArchive preserves long verbatim quotes and large finding/evidence counts without silent truncation', async () => {
  const t = setup();
  const longText = 'Long verbatim sentence. '.repeat(250).trim(); // 6000 chars
  const runs = [{
    id: 'blue-large',
    role: 'blue',
    model: 'claude-sonnet-5-5',
    findings: Array.from({ length: 220 }, (_, i) => ({
      id: `F${i + 1}`,
      page: i + 1,
      quote: i === 0 ? longText : `Q${i}`,
      rationale: i === 0 ? longText : `R${i}`,
      evidence: Array.from({ length: 15 }, (_, j) => ({ quote: `E${j}`, relation: 'supports', label: 'p.1' })),
    })),
  }];
  const built = await t.api.buildArchive({ csv: BOM_CSV, filename: FILENAME, participant: '홍길동', runs, condition: 'A' });
  assert.equal(built.archive.findingCount, 220);
  assert.equal(built.archive.runs[0].findings[0].quote, longText);
  assert.equal(built.archive.runs[0].findings[0].evidence.length, 15);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('ok - ' + name);
    } catch (e) {
      failed++;
      console.error('not ok - ' + name + '\n' + (e.stack || e));
    }
  }
  for (const id of liveIntervals) clearInterval(id);
  liveIntervals.clear();
  console.log(JSON.stringify({ passed: tests.length - failed, failed }));
  process.exit(failed ? 1 : 0);
})();

test('team library reads use the current session for lists, details, and PDF bytes', async () => {
  const pdf = new Blob(['%PDF-1.4 hello'], { type: 'application/pdf' });
  let attempts = 0;
  const t = setup({ routes(method, path, init, defaults) {
    if (method === 'GET' && path.startsWith('/v1/w8/paper')) {
      assert.match(init.headers.authorization, /^Bearer /);
      if (path.includes('attachmentId=')) {
        assert.equal(init.headers.accept, 'application/pdf');
        if (++attempts === 1) return { status: 401, body: { error: { code: 'unauthorized' } } };
        return { status: 200, blob: pdf };
      }
      return { status: 200, body: { path } };
    }
    return defaults(method, path, init);
  } });
  await assert.rejects(t.api.listPapers(), e => e.code === 'auth_required');
  await t.api.connect();
  assert.equal((await t.api.listPapers({ cursor: 'p+1' })).path, '/v1/w8/papers?cursor=p%2B1');
  assert.equal((await t.api.getPaper('62')).path, '/v1/w8/papers?pageId=62');
  assert.equal((await t.api.listPaperAttachments()).path, '/v1/w8/paper-attachments');
  assert.equal(await (await t.api.getPaperAttachment('att123')).text(), await pdf.text());
  assert.equal(attempts, 2);
  t.api.disconnect();
  await assert.rejects(t.api.getPaperAttachment('att123'), e => e.code === 'auth_required');
});
