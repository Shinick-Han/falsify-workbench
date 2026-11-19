'use strict';
// Booth panel pure helpers and the hosted-ai hooks they depend on.
// Synthetic DOM, storage and fetch only. No browser, network, token or private paper.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const boothSource = await readFile(fileURLToPath(new URL('../dist/booth.js', import.meta.url)), 'utf8');
const boothContext = vm.createContext({console, URL, URLSearchParams});
vm.runInContext(boothSource, boothContext, {filename: 'booth.js'});
const booth = boothContext.FalsifyBooth;

const hostedSource = await readFile(fileURLToPath(new URL('../dist/hosted-ai.js', import.meta.url)), 'utf8');
const hostedContext = vm.createContext({console, URL, Event, CustomEvent, setTimeout, clearTimeout, TextEncoder});
vm.runInContext(hostedSource, hostedContext, {filename: 'hosted-ai.js'});
const hosted = hostedContext.FalsifyHostedAi;

const JOB_ID = '12345678-1234-4234-8234-123456789abc';
const TOKEN = 'fss_' + 'A'.repeat(43);
const FUTURE = new Date(Date.now() + 864e5).toISOString();
const CAPS = {enabled: true, provider: 'anthropic', execution: 'server',
  models: ['claude-opus-5-5'], efforts: ['high'],
  limits: {maxUploadBytes: 33554432, maxPromptChars: 8000}};
const BYTES = Buffer.from('%PDF-1.7 synthetic booth fixture\n%%EOF\n');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const BEFORE = 'The mean was 4.2 (SD 1.1).';
const AFTER = 'The mean was 5.8 (SD 1.1).';
const BEFORE_2 = 'We included 120 patients.';
const AFTER_2 = 'We included 210 patients.';
const RATIONALE = 'RED_RATIONALE_MUST_STAY_OUT_OF_THE_EVENT';
const EDITED = Buffer.from('%PDF-1.7 synthetic edited booth fixture\n%%EOF\n');
const EDITED_SHA = createHash('sha256').update(EDITED).digest('hex');
const live = [];
after(() => { for (const entry of live) { try { entry.app.destroy(); } catch { /* already gone */ } } });
/* vm objects keep the context's prototype, so strict equality copies them first. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
}

test('claim keys normalize Crockford input and receipts keep the F- form', () => {
  assert.equal(booth.normalizeClaimKey('7Q3K-M9XD'), '7Q3K-M9XD');
  assert.equal(booth.normalizeClaimKey('7q3k m9xd'), '7Q3K-M9XD');
  assert.equal(booth.normalizeClaimKey('7Q3K-M9XL'), '7Q3K-M9X1');
  assert.equal(booth.normalizeClaimKey('7Q3K-M9XO'), '7Q3K-M9X0');
  assert.equal(booth.normalizeClaimKey('7Q3K-M9XI'), '7Q3K-M9X1');
  assert.equal(booth.normalizeClaimKey('7Q3K-M9XU'), '');
  assert.equal(booth.normalizeClaimKey('short'), '');
  assert.equal(booth.normalizeClaimKey(null), '');
  assert.equal(booth.normalizeReceipt(' f-0042 '), 'F-0042');
  assert.equal(booth.normalizeReceipt('F-10000'), 'F-10000');
  assert.equal(booth.normalizeReceipt('F-42'), '');
});

test('submission bodies use only contract keys and reject nickname PII', () => {
  assert.deepEqual(plain(booth.buildSubmission({nickname: 'visitor@example.com'})), {ok: false, code: 'pii_not_allowed'});
  assert.deepEqual(plain(booth.buildSubmission({nickname: '01012345678'})), {ok: false, code: 'pii_not_allowed'});
  assert.equal(booth.buildSubmission({nickname: 'line\nname'}).code, 'invalid_request');
  const built = booth.buildSubmission({
    jobId: JOB_ID, course: 'quick', consent: true, consentVersion: '2026-11-22.v1',
    nickname: '부스방문자',
    paper: {source: 'arxiv', id: '2503.10497', title: 'Synthetic title', license: 'cc-by-4.0', course: 'quick'},
    rows: [{
      pageIndex: 3, segmentId: 'p4-s2', before: 'p < 0.05', after: 'p < 0.5',
      defectType: 'number', reason: '유의수준을 바꿔 결론이 성립하지 않음', rationale: RATIONALE,
    }],
  });
  assert.equal(built.ok, true);
  assert.deepEqual(Object.keys(built.body), ['jobId', 'course', 'declared', 'paper', 'nickname', 'consentVersion']);
  assert.deepEqual(Object.keys(built.body.declared[0]), ['pageIndex', 'segmentId', 'before', 'after', 'defectType', 'reason']);
  assert.deepEqual(Object.keys(built.body.paper), ['source', 'id', 'title', 'license']);
  assert.equal(JSON.stringify(built.body).includes(RATIONALE), false);
  assert.equal(JSON.stringify(built.body).includes('quick'), true);
  const bare = booth.buildSubmission({
    jobId: JOB_ID, course: 'deep', consent: true,
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}],
  });
  assert.equal(bare.ok, true);
  assert.deepEqual(Object.keys(bare.body), ['jobId', 'course', 'declared', 'consentVersion']);
  assert.equal(bare.body.consentVersion, booth.CONSENT_COPY ? '2026-11-22.v1' : '2026-11-22.v1');
  assert.equal(booth.buildSubmission({jobId: JOB_ID, course: 'quick', consent: false,
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}]}).code, 'invalid_request');
  assert.equal(booth.CONSENT_COPY.includes('확인키로 언제든 제출을 철회할 수 있습니다.'), true);
});

test('search and pdf paths cannot carry a declared reason', () => {
  assert.equal(booth.paperSearchPath('통계', 2), '/v1/papers/search?q=' + encodeURIComponent('통계') + '&page=2');
  assert.equal(booth.paperSearchPath('통계', 2).includes('reason'), false);
  assert.equal(booth.paperSearchPath('', 1), '');
  assert.equal(booth.paperSearchPath('x', 6), '');
  assert.equal(booth.paperPdfPath('2503.10497'), '/v1/papers/pdf?id=2503.10497');
  assert.equal(booth.paperPdfPath('https://arxiv.org/pdf/2503.10497'), '');
  assert.equal(booth.paperSearchPath.length, 2);
});

test('this device keeps at most 10 receipts', () => {
  const storage = memoryStorage();
  for (let i = 0; i < 12; i += 1) {
    booth.rememberReceipt(storage, {
      receipt: 'F-' + String(i).padStart(4, '0'),
      claimKey: '7Q3K-M9XD',
      createdAt: '2026-11-22T00:00:' + String(i).padStart(2, '0') + 'Z',
    });
  }
  const list = booth.readReceipts(storage);
  assert.equal(list.length, 10);
  assert.equal(list[0].receipt, 'F-0011');
  assert.equal(list[9].receipt, 'F-0002');
  booth.rememberReceipt(storage, {receipt: 'F-0004', claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T00:01:00Z'});
  const again = booth.readReceipts(storage);
  assert.equal(again.length, 10);
  assert.equal(again[0].receipt, 'F-0004');
  assert.equal(again.filter(item => item.receipt === 'F-0004').length, 1);
  assert.equal(booth.rememberReceipt(storage, {receipt: 'nope', claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T00:01:00Z'}).length, 10);
});

test('server error codes become the booth messages', () => {
  const expected = {
    booth_closed: '접수를 받지 않습니다',
    consent_outdated: '동의 문구',
    job_not_ready: '수정본이 아직',
    already_submitted: '이미 제출된',
    pii_not_allowed: '별명',
    rate_limited: '너무 많습니다',
    license_not_allowed: '라이선스',
    payload_too_large: '너무 커서',
    not_found: '확인키',
    invalid_request: '입력 내용',
    forbidden: '할 수 없습니다',
  };
  for (const [code, fragment] of Object.entries(expected)) {
    assert.match(booth.errorMessage(code), new RegExp(fragment), code);
  }
  assert.match(booth.errorMessage('already_submitted', {receipt: 'F-0042'}), /F-0042/);
  assert.match(booth.errorMessage('session_missing'), /게스트 세션/);
  assert.match(booth.errorMessage('mystery'), /처리하지 못했습니다/);
});

test('the event panel submits contract fields and keeps claim and search auth apart', async () => {
  function page() {
    const ids = new Map();
    class Node {
      constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.parentNode = null;
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.checked = false;
        this.className = '';
        this.type = '';
        this._text = '';
        this._id = '';
        this.listeners = new Map();
      }
      get id() { return this._id; }
      set id(value) {
        if (this._id) ids.delete(this._id);
        this._id = value || '';
        if (this._id) ids.set(this._id, this);
      }
      get firstChild() { return this.children.find(kid => kid && typeof kid === 'object') || null; }
      get textContent() {
        return this._text + this.children.map(kid => typeof kid === 'string' ? kid : kid.textContent).join('');
      }
      set textContent(value) { this.children = []; this._text = String(value ?? ''); }
      setAttribute() {}
      append(...kids) {
        for (const kid of kids) {
          if (kid == null || kid === false) continue;
          if (typeof kid === 'object') kid.parentNode = this;
          this.children.push(kid);
        }
      }
      insertBefore(node, ref) {
        node.parentNode = this;
        const at = this.children.indexOf(ref);
        if (at < 0) this.children.unshift(node);
        else this.children.splice(at, 0, node);
      }
      remove() {
        if (!this.parentNode) return;
        const at = this.parentNode.children.indexOf(this);
        if (at >= 0) this.parentNode.children.splice(at, 1);
        this.parentNode = null;
      }
      addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
      removeEventListener(type, fn) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn));
      }
      dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); }
      querySelector(selector) {
        const visit = node => {
          if (selector === '.content' && node.className === 'content') return node;
          for (const kid of node.children) {
            if (kid && typeof kid === 'object') {
              const found = visit(kid);
              if (found) return found;
            }
          }
          return null;
        };
        return visit(this);
      }
      scrollIntoView() {}
    }
    const doc = {
      listeners: new Map(),
      createElement: tag => new Node(tag),
      getElementById: id => ids.get(id) || null,
      addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); },
      removeEventListener(type, fn) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn));
      },
      dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); },
    };
    const body = new Node('body');
    const main = new Node('main');
    main.id = 'main';
    const content = new Node('div');
    content.className = 'content';
    body.append(main);
    main.append(content);
    doc.body = body;
    return {doc, content, ids};
  }
  const skipped = page();
  let created = false;
  booth.mount({
    document: {createElement() { created = true; return {}; }, getElementById() { return null; }},
    config: () => ({}),
  });
  assert.equal(created, false);
  booth.mount({document: skipped.doc, config: () => ({booth: {enabled: false}})});
  assert.equal(skipped.ids.get('booth'), undefined);

  const {doc, content, ids} = page();
  const calls = [];
  const storage = memoryStorage();
  const token = 'fsg_' + 'a'.repeat(43);
  let sessionToken = token;
  const fetchImpl = async (url, init = {}) => {
    const headers = init.headers || {};
    calls.push({
      url: String(url), method: init.method || 'GET', auth: headers.Authorization || '',
      body: init.body ? JSON.parse(init.body) : null,
    });
    const path = String(url);
    const payload = path.endsWith('/v1/booth/config')
      ? {enabled: true, submissionsOpen: true, announcement: '행사 안내', consentVersion: '2026-11-22.v1',
        missions: [{paperId: '2503.10497', title: 'Synthetic mission', license: 'cc-by-4.0', course: 'quick'}]}
      : path.endsWith('/v1/booth/submissions')
        ? {receipt: 'F-0042', claimKey: '7Q3K-M9XD', status: 'received', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00Z'}
        : path.endsWith('/v1/booth/claim')
          ? {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false}
          : path.endsWith('/v1/booth/withdraw')
            ? {receipt: 'F-0042', status: 'withdrawn', course: 'quick', declaredCount: 1, published: false}
            : path.includes('/v1/papers/search')
              ? {source: 'arxiv', page: 1, hasMore: false, results: [{id: '2503.10497', title: 'Synthetic result', authors: ['Ada'], year: 2026, license: 'cc-by-4.0'}]}
              : {error: {code: 'not_found'}};
    const status = path.endsWith('/v1/booth/submissions') ? 201 : payload.error ? 404 : 200;
    return {ok: status >= 200 && status < 300, status, headers: {get() { return null; }}, json: async () => payload};
  };
  const location = {hash: ''};
  const handle = booth.mount({
    document: doc, fetch: fetchImpl, storage, location,
    config: () => ({booth: {enabled: true}, apiBase: 'https://event.example', hostedAi: {apiBase: 'https://event.example'}}),
    session: () => ({token: async () => sessionToken}),
  });
  assert.equal(content.children[0].id, 'booth');
  assert.equal(ids.get('booth-search').hidden, true);
  assert.match(ids.get('booth-consent-copy').textContent, /철회할 수 있습니다/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls[0].auth, '');
  assert.equal(calls[0].url.endsWith('/v1/booth/config'), true);
  assert.equal(ids.get('booth').hidden, false);
  assert.equal(ids.get('booth-search').hidden, false);
  assert.match(ids.get('booth-announce').textContent, /행사 안내/);
  assert.match(ids.get('booth-missions').textContent, /Synthetic mission/);
  doc.dispatchEvent({type: 'falsify:hosted-apply-complete', detail: {
    jobId: JOB_ID, artifactId: 'art-edited', fileName: 'edited.pdf',
    edits: [{pageIndex: 1, segmentId: 'p2-b1', before: BEFORE, after: AFTER, rationale: RATIONALE}],
  }});
  const controls = [];
  const walk = node => {
    controls.push(node);
    for (const kid of node.children) if (kid && typeof kid === 'object') walk(kid);
  };
  walk(ids.get('booth-rows'));
  const select = controls.find(node => node.tagName === 'select');
  const reason = controls.find(node => node.tagName === 'textarea');
  select.value = 'number';
  reason.value = '유의수준을 바꿔 결론이 성립하지 않음';
  ids.get('booth-consent').checked = true;
  ids.get('booth-consent').dispatchEvent({type: 'change'});
  ids.get('booth-nickname').value = '부스방문자';
  assert.equal(ids.get('booth-submit-button').disabled, false);
  ids.get('booth-submit').dispatchEvent({type: 'submit', preventDefault() {}});
  await new Promise(resolve => setTimeout(resolve, 0));
  const posted = calls.find(call => call.url.endsWith('/v1/booth/submissions'));
  assert.equal(posted.auth, 'Bearer ' + token);
  assert.deepEqual(Object.keys(posted.body), ['jobId', 'course', 'declared', 'nickname', 'consentVersion']);
  assert.deepEqual(Object.keys(posted.body.declared[0]), ['pageIndex', 'segmentId', 'before', 'after', 'defectType', 'reason']);
  assert.equal(JSON.stringify(posted.body).includes(RATIONALE), false);
  assert.equal(ids.get('booth-receipt-code').textContent, 'F-0042');
  assert.equal(ids.get('booth-claim-code').textContent, '7Q3K-M9XD');
  assert.equal(booth.readReceipts(storage)[0].receipt, 'F-0042');
  ids.get('booth-result-link').dispatchEvent({type: 'click', preventDefault() {}});
  assert.equal(location.hash, '#booth-result');
  assert.equal(ids.get('booth-result').hidden, false);
  assert.equal(ids.get('booth-claim-receipt').value, 'F-0042');
  ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await new Promise(resolve => setTimeout(resolve, 0));
  const claim = calls.find(call => call.url.endsWith('/v1/booth/claim'));
  assert.equal(claim.auth, '');
  assert.deepEqual(claim.body, {receipt: 'F-0042', claimKey: '7Q3K-M9XD'});
  assert.match(ids.get('booth-result-status').textContent, /검토 중/);
  ids.get('booth-withdraw').dispatchEvent({type: 'click'});
  assert.equal(ids.get('booth-withdraw-confirm').hidden, false);
  ids.get('booth-withdraw-confirm').dispatchEvent({type: 'click'});
  await new Promise(resolve => setTimeout(resolve, 0));
  const withdrawn = calls.find(call => call.url.endsWith('/v1/booth/withdraw'));
  assert.equal(withdrawn.auth, '');
  assert.match(ids.get('booth-result-status').textContent, /철회됨/);
  ids.get('booth-search-q').value = '통계';
  ids.get('booth-search').dispatchEvent({type: 'submit', preventDefault() {}});
  await new Promise(resolve => setTimeout(resolve, 0));
  const search = calls.find(call => call.url.includes('/v1/papers/search'));
  assert.equal(search.auth, 'Bearer ' + token);
  assert.equal(search.url.includes('reason'), false);
  assert.match(ids.get('booth-search-results').textContent, /Synthetic result/);
  sessionToken = '';
  ids.get('booth-search').dispatchEvent({type: 'submit', preventDefault() {}});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(ids.get('booth-search-status').textContent, /게스트 세션/);
  handle.destroy();
  assert.equal(content.children.some(node => node.id === 'booth'), false);
});

class El extends EventTarget {
  constructor(tag, owner) {
    super();
    Object.assign(this, {tagName: String(tag).toUpperCase(), ownerDocument: owner, children: [], parent: null, attrs: {},
      id: '', className: '', value: '', checked: false, disabled: false, hidden: false, type: '', files: []});
  }
  get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.children = []; this._text = String(value); }
  append(...kids) {
    for (const kid of kids) {
      if (kid && typeof kid === 'object') kid.parent = this;
      this.children.push(kid);
    }
  }
  replaceChildren(...kids) { this.textContent = ''; this.append(...kids); }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'id') this.id = String(value); }
  getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  *walk() { yield this; for (const child of this.children) if (child && child.walk) yield* child.walk(); }
  find(predicate) { for (const node of this.walk()) if (predicate(node)) return node; return null; }
  querySelector(selector) {
    if (typeof selector !== 'string' || !selector.startsWith('#')) return null;
    return this.find(node => node.id === selector.slice(1));
  }
}
function makeDocument() {
  const doc = new EventTarget();
  const body = new El('body', doc);
  doc.body = body;
  doc.readyState = 'complete';
  doc.createElement = tag => new El(tag, doc);
  doc.getElementById = id => body.find(node => node.id === id);
  return doc;
}
function storageStub(map) {
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
  };
}
const job = (over = {}) => Object.assign({
  id: 'job-1', role: 'red', state: 'queued', progress: {completedCalls: 0, requiredCalls: 1, phase: 'queued'},
  model: 'claude-opus-5-5', effort: 'high', provider: 'anthropic', usage: null, result: null, artifacts: [],
  createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:01.000Z',
}, over);
function setup(options = {}) {
  const doc = makeDocument();
  const host = new El('section', doc);
  host.id = 'hosted-ai';
  doc.body.append(host);
  const events = [];
  doc.addEventListener('falsify:hosted-apply-complete', event => events.push(event.detail));
  const store = new Map();
  const calls = [];
  const fetchStub = async (url, init = {}) => {
    const record = {url: String(url), path: new URL(url).pathname, method: String(init.method || 'GET').toUpperCase(),
      headers: Object.assign({}, init.headers || {}), body: init.body};
    calls.push(record);
    const route = options.routes(record);
    return {
      ok: route.status >= 200 && route.status < 300, status: route.status,
      headers: {get() { return null; }},
      text: async () => JSON.stringify(route.body || {}),
      blob: async () => new Blob([route.blobText || '{}']),
    };
  };
  const app = hosted.create({
    document: doc, host, fetch: fetchStub, storage: storageStub(store), crypto: globalThis.crypto,
    URL, TextEncoder, AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 15)), clearTimeout,
    config: () => Object.freeze({apiBase: 'https://worker.test', provider: 'confluence',
      hostedAi: Object.freeze({enabled: true, apiBase: 'https://worker.test'})}),
  });
  const $ = id => host.find(node => node.id === id);
  const entry = {app, doc, $, calls, events, store, destroy: () => app.destroy()};
  live.push(entry);
  return entry;
}
function router(caps) {
  let posts = [];
  const route = record => {
    if (record.path === '/v1/ai/capabilities') return {status: 200, body: caps};
    if (record.path === '/v1/auth/login') {
      return {status: 200, body: {token: TOKEN, author: {id: 'author-1', username: 'synthetic', displayName: 'Synthetic'}, expiresAt: FUTURE}};
    }
    if (record.path === '/v1/ai/uploads') {
      return {status: 201, body: {upload: {id: 'up-1', sha256: SHA, name: 'paper.pdf', mime: 'application/pdf', bytes: BYTES.length, deduplicated: false}}};
    }
    if (record.path === '/v1/ai/jobs' && record.method === 'POST') {
      const body = JSON.parse(record.body);
      posts.push(body);
      if (body.applyOnly === true) {
        return {status: 202, body: {job: job({
          id: 'job-apply', role: 'red', state: 'completed', applyOnly: true,
          result: {schema: 'falsify.hosted-apply.v1', applyOnly: true},
          artifacts: [{id: 'art-edited', name: 'edited.pdf', mime: 'application/pdf', bytes: EDITED.length, sha256: EDITED_SHA}],
        }), replayed: false}};
      }
      return {status: 202, body: {job: job({
        id: 'job-red', state: 'completed',
        result: {schema: 'falsify.document-red.v1', status: 'ok', candidates: [
          {id: 'c1', segmentId: 'p2-b1', before: BEFORE, after: AFTER, occurrence: 1, rationale: RATIONALE},
          {id: 'c2', segmentId: 'p1-b2', before: BEFORE_2, after: AFTER_2, rationale: RATIONALE},
        ]},
      }), replayed: false}};
    }
    if (/^\/v1\/ai\/jobs\/[^/]+$/.test(record.path)) return {status: 200, body: {job: job({state: 'completed'})}};
    return {status: 404, body: {error: {code: 'not_found'}}};
  };
  route.posts = () => posts;
  return route;
}
const until = async (predicate, label) => {
  for (let i = 0; i < 400 && !predicate(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), label);
};
async function signIn(entry) {
  await entry.app.ready;
  entry.$('hosted-ai-username').value = 'synthetic';
  entry.$('hosted-ai-password').value = 'correct horse battery';
  entry.$('hosted-ai-login-form').dispatchEvent(new Event('submit'));
  await until(() => entry.$('hosted-ai-config') && entry.$('hosted-ai-config').hidden === false, 'config opens');
}
async function selectFile(entry) {
  const input = entry.$('hosted-ai-file');
  input.files = [{name: 'paper.pdf', size: BYTES.length, type: 'application/pdf',
    arrayBuffer: async () => BYTES.buffer.slice(BYTES.byteOffset, BYTES.byteOffset + BYTES.byteLength)}];
  input.dispatchEvent(new Event('change'));
  await until(() => /sha256/.test(entry.$('hosted-ai-file-status').textContent), 'file hashed');
}
function check(entry, id) {
  const box = entry.$(id);
  box.checked = true;
  box.dispatchEvent(new Event('change'));
}

test('a completed RED apply emits the booth event and keeps BLUE when blueJobs is absent', async () => {
  const route = router(CAPS);
  const entry = setup({routes: route});
  await signIn(entry);
  assert.equal(entry.$('hosted-ai-role-blue').hidden, false);
  await selectFile(entry);
  const prompt = entry.$('hosted-ai-prompt');
  prompt.value = 'Check the methods section only.';
  prompt.dispatchEvent(new Event('input'));
  entry.$('hosted-ai-run').click();
  await until(() => entry.$('hosted-ai-selection') && entry.$('hosted-ai-selection').hidden === false, 'candidates');
  assert.equal(entry.events.length, 0);
  check(entry, 'hosted-ai-candidate-0');
  check(entry, 'hosted-ai-candidate-1');
  entry.$('hosted-ai-apply').click();
  await until(() => entry.events.length === 1, 'apply event');
  assert.deepEqual(plain(entry.events[0]), {
    jobId: 'job-apply', artifactId: 'art-edited', fileName: 'edited.pdf',
    edits: [
      {pageIndex: 1, segmentId: 'p2-b1', before: BEFORE, after: AFTER},
      {pageIndex: 0, segmentId: 'p1-b2', before: BEFORE_2, after: AFTER_2},
    ],
  });
  assert.equal(JSON.stringify(entry.events[0]).includes(RATIONALE), false);
  assert.equal(entry.$('hosted-ai-blue-handoff').hidden, false);
  const stored = [...entry.store.values()].join('\n');
  assert.equal(stored.includes(BEFORE), false);
  assert.equal(stored.includes(RATIONALE), false);
});

test('blueJobs false hides hosted BLUE run and the RED to BLUE handoff', async () => {
  const route = router({...CAPS, blueJobs: false});
  const entry = setup({routes: route});
  await signIn(entry);
  assert.equal(entry.$('hosted-ai-role-blue').hidden, true);
  await selectFile(entry);
  const prompt = entry.$('hosted-ai-prompt');
  prompt.value = 'Check the methods section only.';
  prompt.dispatchEvent(new Event('input'));
  entry.$('hosted-ai-role').value = 'blue';
  entry.$('hosted-ai-run').click();
  await until(() => /BLUE 검토를 실행하지 않습니다/.test(entry.$('hosted-ai-error').textContent), 'blue run refused');
  assert.equal(route.posts().some(body => body.role === 'blue'), false);
  entry.$('hosted-ai-role').value = 'red';
  entry.$('hosted-ai-run').click();
  await until(() => entry.$('hosted-ai-selection') && entry.$('hosted-ai-selection').hidden === false, 'red candidates');
  check(entry, 'hosted-ai-candidate-0');
  entry.$('hosted-ai-apply').click();
  await until(() => entry.$('hosted-ai-edited-section') && entry.$('hosted-ai-edited-section').hidden === false, 'edited pdf');
  assert.equal(entry.$('hosted-ai-blue-handoff').hidden, true);
  assert.equal(entry.$('hosted-ai-edited-download').hidden, false);
  const uploads = entry.calls.filter(call => call.path === '/v1/ai/uploads').length;
  entry.$('hosted-ai-blue-handoff').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(entry.calls.filter(call => call.path === '/v1/ai/uploads').length, uploads);
  assert.equal(entry.events[0].edits.length, 1);
  assert.deepEqual(Object.keys(entry.events[0].edits[0]), ['pageIndex', 'segmentId', 'before', 'after']);
});
