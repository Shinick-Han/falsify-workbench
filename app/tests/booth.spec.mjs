'use strict';
// Booth step flow (pick, edit, send, ticket), its pure helpers and the hosted-ai hooks they depend on.
// Synthetic DOM, storage and fetch only. No browser, network, token or private paper.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

class BoothTransfer {
  constructor() {
    this.files = [];
    this.items = {add: file => { this.files.push(file); }};
  }
}
const editsSource = await readFile(fileURLToPath(new URL('../dist/booth-edits.js', import.meta.url)), 'utf8');
const boothSource = await readFile(fileURLToPath(new URL('../dist/booth.js', import.meta.url)), 'utf8');
const appSource = await readFile(fileURLToPath(new URL('../dist/app.js', import.meta.url)), 'utf8');
const openAccessSource = await readFile(fileURLToPath(new URL('../dist/open-access.js', import.meta.url)), 'utf8');
const boothContext = vm.createContext({console, URL, URLSearchParams, Event, File, FormData, crypto, AbortController, DataTransfer: BoothTransfer});
vm.runInContext(editsSource, boothContext, {filename: 'booth-edits.js'});
vm.runInContext(boothSource, boothContext, {filename: 'booth.js'});
const booth = boothContext.FalsifyBooth;
const boothEdits = boothContext.FalsifyBoothEdits;

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

async function waitFor(predicate) {
  for (let i = 0; i < 40 && !predicate(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(predicate(), true);
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

test('submission bodies use only contract keys and never carry a nickname', () => {
  const built = booth.buildSubmission({
    jobId: JOB_ID, course: 'quick', consentVersion: '2026-11-22.v1',
    nickname: '부스방문자', editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2503.10497', title: 'Synthetic title', license: 'cc-by-4.0', course: 'quick', sourceSha256: SHA},
    rows: [{
      pageIndex: 3, segmentId: 'p4-s2', before: 'p < 0.05', after: 'p < 0.5',
      defectType: 'number', reason: '유의수준을 바꿔 결론이 성립하지 않음', rationale: RATIONALE,
    }],
  });
  assert.equal(built.ok, true);
  assert.equal(Object.hasOwn(built.body, 'jobId'), false);
  assert.deepEqual(Object.keys(built.body), ['course', 'declared', 'paper', 'consentVersion', 'editedSha256']);
  assert.deepEqual(Object.keys(built.body.declared[0]), ['pageIndex', 'segmentId', 'before', 'after', 'defectType', 'reason']);
  assert.deepEqual(Object.keys(built.body.paper), ['source', 'id', 'title', 'license', 'sourceSha256']);
  assert.equal(built.body.editedSha256, EDITED_SHA);
  assert.equal(built.body.paper.sourceSha256, SHA);
  assert.equal(JSON.stringify(built.body).includes(RATIONALE), false);
  assert.equal(JSON.stringify(built.body).includes('quick'), true);
  assert.equal(built.body.consentVersion, '2026-11-22.v1');
  const tabbed = booth.buildSubmission({
    course: 'quick', consentVersion: 'v', editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2309.15217', title: 'Synthetic title', license: 'cc-by-4.0'},
    rows: [{pageIndex: 4, segmentId: 'paragraph:4:p4', before: '0.95\t0.78', after: '0.50\t0.78', defectType: 'number', reason: '표의 점수'}],
  });
  assert.equal(tabbed.ok, true);
  assert.equal(tabbed.body.declared[0].before, '0.95\t0.78');
  assert.equal(booth.buildSubmission({
    course: 'quick', consentVersion: 'v', editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2309.15217', license: 'cc-by-4.0'},
    rows: [{pageIndex: 4, before: '0.95\u0000', after: '0.50', defectType: 'number', reason: '표의 점수'}],
  }).code, 'invalid_request');
  const file = new File([EDITED], 'edited.pdf', {type: 'application/pdf'});
  const form = booth.submissionForm(built.body, file);
  assert.deepEqual([...form.keys()], ['meta', 'pdf']);
  assert.deepEqual(JSON.parse(form.get('meta')), plain(built.body));
  assert.equal(form.get('pdf').name, 'edited.pdf');
  assert.equal(form.get('pdf').size, EDITED.length);
  const bare = booth.buildSubmission({
    course: 'deep', consentVersion: 'v', editedSha256: EDITED_SHA,
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}],
  });
  assert.deepEqual(plain(bare), {ok: false, code: 'paper_not_allowed'});
  assert.equal(booth.buildSubmission({
    course: 'quick', consentVersion: 'v', editedSha256: EDITED_SHA,
    paper: {source: 'upload', id: 'local', title: 'Uploaded', license: 'cc-by'},
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}],
  }).code, 'paper_not_allowed');
  assert.equal(booth.buildSubmission({course: 'quick', editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0'},
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}]}).code, 'invalid_request', 'no consentVersion');
  const optional = booth.buildSubmission({course: 'quick', consentVersion: 'v', editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0'},
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: '', reason: '  '}, {pageIndex: 1, before: 'c', after: 'd'}]});
  assert.equal(optional.ok, true, 'type and reason are optional');
  assert.deepEqual(plain(optional.body.declared.map(item => [item.defectType, item.reason])), [['other', booth.NO_REASON], ['other', booth.NO_REASON]]);
  assert.equal(booth.buildSubmission({course: 'quick', consent: true,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0', sourceSha256: SHA},
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}]}).code, 'invalid_request');
  assert.equal(booth.buildSubmission({course: 'quick', consentVersion: 'v', editedSha256: SHA,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0', sourceSha256: SHA},
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}]}).code, 'pdf_unchanged');
  const six = Array.from({length: 6}, (_, index) => ({
    pageIndex: index, before: 'before ' + index, after: 'after', defectType: 'other', reason: '이유',
  }));
  assert.equal(booth.buildSubmission({
    course: 'quick', consentVersion: 'v', editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0'},
    rows: six,
  }).code, 'invalid_request');
  const eight = Array.from({length: 8}, (_, index) => ({
    pageIndex: index, before: 'before ' + index, after: 'after', defectType: 'other', reason: '이유',
  }));
  assert.equal(booth.buildSubmission({
    course: 'quick', consentVersion: 'v', editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0'},
    limits: {maxDeclared: 8, maxPdfBytes: 16777216, perOwner: 2},
    rows: eight,
  }).ok, true);
  assert.equal(booth.buildSubmission({
    course: 'quick', consentVersion: 'v', editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0'},
    limits: {maxDeclared: 8},
    rows: eight.concat([{pageIndex: 8, before: 'before 8', after: 'after', defectType: 'other', reason: '이유'}]),
  }).code, 'invalid_request');
});

test('the R4-2 interop vector is the edited.pdf part', async () => {
  const interop = Buffer.from('%PDF-1.7\n% falsify booth interop fixture\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  const interopSha = '241e9c74200e288d5bc4b11ef565745b1c5495930790689240bb7168ad111019';
  assert.equal(interop.length, 109);
  assert.equal(createHash('sha256').update(interop).digest('hex'), interopSha);
  const built = booth.buildSubmission({
    course: 'quick', consentVersion: 'v', editedSha256: interopSha,
    paper: {source: 'arxiv', id: '2503.10497', title: 'Synthetic title', license: 'cc-by-4.0', sourceSha256: SHA},
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}],
  });
  assert.equal(built.ok, true);
  const named = new File([interop], 'visitor-notes.txt', {type: 'text/plain'});
  const form = booth.submissionForm(built.body, named);
  const pdf = form.get('pdf');
  assert.equal(pdf.name, 'edited.pdf');
  assert.equal(pdf.type, 'application/pdf');
  assert.equal(pdf.size, 109);
  assert.equal(new TextDecoder().decode(new Uint8Array(await pdf.arrayBuffer())), interop.toString('utf8'));
  assert.equal(booth.errorMessage('storage_full'), '오늘 접수 공간이 가득 찼어요. 부스 스태프에게 알려 주세요.');
  assert.match(booth.errorMessage('length_required'), /파일 크기를 확인하지 못했어요/);
  assert.match(booth.errorMessage('payload_too_large'), /너무 커서/);
  assert.equal(booth.errorMessage('payload_too_large', {maxPdfBytes: 16777216}), '수정본 PDF는 16MB까지 제출할 수 있어요.');
  assert.equal(booth.errorMessage('length_required', {maxPdfBytes: 16777216}), '수정본 PDF는 16MB까지 제출할 수 있어요.');
  assert.match(booth.errorMessage('model_jobs_operator_only'), /AI 검증을 바로 돌리지 않아요/);
  assert.equal(booth.errorMessage('payload_too_large', {maxPdfBytes: 12}), booth.errorMessage('payload_too_large'));
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
    booth_closed: '접수 시간이 아니에요',
    consent_outdated: '부스 설정이 바뀌었어요',
    job_not_ready: '아직 만드는 중',
    already_submitted: '이미 제출한',
    rate_limited: '요청이 몰려',
    license_not_allowed: '라이선스',
    payload_too_large: '너무 커서',
    length_required: '파일 크기를 확인하지',
    storage_full: '접수 공간이 가득',
    model_jobs_operator_only: 'AI 검증',
    not_found: '확인키',
    paper_not_allowed: '라이선스',
    invalid_pdf: '수정본 PDF를 읽지 못했어요',
    pdf_mismatch: '중간에 바뀌었어요',
    pdf_unchanged: '아직 원본과 같아요',
    invalid_request: '입력 내용',
    forbidden: '이 작업을 할 수 없어요',
  };
  for (const [code, fragment] of Object.entries(expected)) {
    assert.match(booth.errorMessage(code), new RegExp(fragment), code);
  }
  assert.match(booth.errorMessage('already_submitted', {receipt: 'F-0042'}), /F-0042/);
  assert.match(booth.errorMessage('session_missing'), /연결이 잠시 끊겼어요/);
  for (const code of ['session_missing', 'unauthorized', 'length_required', 'forbidden']) {
    assert.doesNotMatch(booth.errorMessage(code), /새로 고/, code + ' never asks for a reload, which would drop the edits');
    assert.match(booth.errorMessage(code), /다시 시도/, code + ' names the next step');
  }
  assert.match(booth.errorMessage('mystery'), /^처리하지 못했어요\. 잠시 뒤 다시 시도해 주세요\.$/);
});

/* Synthetic DOM the booth mount builds into. ids maps element ids to nodes. */
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
      this.attrs = {};
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
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; }
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
    click() { this.dispatchEvent({type: 'click'}); }
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
    documentElement: {dataset: {}},
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
  const paperInput = new Node('input');
  paperInput.id = 'paper-file';
  const generate = new Node('button');
  generate.id = 'paper-generate';
  content.append(paperInput, generate);
  main.append(content);
  doc.body = body;
  return {doc, content, ids};
}

function nodesOf(node) {
  const out = [];
  const visit = item => { out.push(item); for (const kid of item.children) if (kid && typeof kid === 'object') visit(kid); };
  visit(node);
  return out;
}
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const SOURCE_BYTES = Buffer.from('%PDF-1.7 synthetic booth paper\n%%EOF\n');
const SOURCE_SHA = createHash('sha256').update(SOURCE_BYTES).digest('hex');
const MISSIONS = [
  {paperId: '2503.10497', title: 'Synthetic mission: a longer subtitle', license: 'cc-by-4.0', course: 'quick', hint: '8쪽 표를 고치세요', pageHint: 8},
  {paperId: '2503.10498', title: 'Plain mission', pageHint: '8'},
];
function pdfReply(bytes = SOURCE_BYTES) {
  return {
    ok: true, status: 200,
    headers: {get(name) {
      if (name === 'X-Falsify-Paper-License') return 'cc-by-4.0';
      if (name === 'Content-Disposition') return 'attachment; filename="arxiv-2503.10497.pdf"';
      return null;
    }},
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => ({}),
  };
}
function makeBoothEdit(overrides = {}) {
  return {
    id: overrides.id || 'e-1',
    pageIndex: overrides.pageIndex ?? 1,
    rects: overrides.rects || [{x: 0.1, y: 0.2, w: 0.3, h: 0.02}],
    originalText: overrides.originalText ?? BEFORE,
    newText: overrides.newText ?? AFTER,
    source: overrides.source || 'tap',
  };
}
/* Viewer-only workspace hook + stubbed FalsifyBrowserPdf.rewrite + clean BoothEdits store. */
function useWorkspace(edits = [], extra = {}) {
  const state = {pages: [], rewrites: [], blindCalls: []};
  boothContext.FalsifyPaperWorkspace = {
    getSource: () => ({fileHash: extra.fileHash || SOURCE_SHA, file: new File([SOURCE_BYTES], 'source.pdf', {type: 'application/pdf'})}),
    showPage(n) { state.pages.push(n); return true; },
  };
  boothContext.FalsifyBrowserPdf = extra.browserPdf === null ? undefined : (extra.browserPdf || {
    async rewrite(sourceBytes, list) {
      state.rewrites.push({bytes: Buffer.from(sourceBytes), edits: plain(list)});
      return extra.rewriteResult ? extra.rewriteResult(sourceBytes, list) : new Uint8Array(EDITED);
    },
  });
  boothContext.FalsifyBlindPdf = extra.blindPdf || {
    async prepare({file}) {
      state.blindCalls.push(file);
      return {file, sha256: SOURCE_SHA, changed: false, removed: []};
    },
  };
  boothEdits.clear();
  for (const edit of edits) boothEdits.add(edit);
  return state;
}
const ONE_EDIT = [makeBoothEdit()];
/* Mounted booth with a fake clock. claims is a list of claim replies (a body, or {status, headers, body}). */
function liveBooth(options = {}) {
  const {doc, ids, content} = page();
  const storage = options.storage || memoryStorage();
  const calls = [];
  const clock = {t: options.now || Date.parse('2026-11-22T01:00:30Z')};
  const timers = [];
  const intervals = [];
  let timerId = 0;
  const claims = (options.claims || []).slice();
  const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: {get(name) { return Object.prototype.hasOwnProperty.call(headers, name) ? headers[name] : null; }},
    json: async () => body,
  });
  const submitReplies = (options.submits || []).slice();
  let invalidated = 0;
  const fetchImpl = async (url, init = {}) => {
    const full = String(url);
    const path = full.split('?')[0];
    const headers = init.headers || {};
    const form = init.body && typeof init.body.get === 'function' ? init.body : null;
    // GET /v1/booth/claim carries receipt and key in the query; record them as the body a POST would send.
    const query = full.includes('?') ? new URLSearchParams(full.slice(full.indexOf('?') + 1)) : null;
    const queryBody = query && path.endsWith('/v1/booth/claim') ? {receipt: query.get('receipt'), claimKey: query.get('key')} : null;
    calls.push({path, method: init.method || 'GET', at: clock.t, auth: headers.Authorization || '', contentType: headers['Content-Type'] || '',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : queryBody, form, signal: init.signal || null});
    if (path.endsWith('/v1/booth/config')) {
      if (options.configGate) await options.configGate;
      return reply(200, {enabled: true, submissionsOpen: true, announcement: options.announcement, consentVersion: options.consentVersion || '2026-11-22.v2',
        limits: {maxDeclared: options.maxDeclared || 5, maxReason: 500, maxNickname: 24, perOwner: options.perOwner || 5, maxPdfBytes: 16777216},
        missions: options.missions || MISSIONS});
    }
    if (path.endsWith('/v1/booth/claim') || path.endsWith('/v1/booth/withdraw')) {
      const next = path.endsWith('/v1/booth/withdraw') ? options.withdrawn : (claims.length > 1 ? claims.shift() : claims[0]);
      if (next && next.status && next.body) return reply(next.status, next.body, next.headers);
      if (!next) return reply(404, {error: {code: 'not_found'}});
      return reply(200, next);
    }
    if (path.endsWith('/v1/booth/submissions')) {
      const next = submitReplies.length ? submitReplies.shift() : null;
      if (next) return reply(next.status, next.body);
      if (options.submitStatus) return reply(options.submitStatus, {error: {code: 'rate_limited'}});
      return reply(201, {receipt: 'F-0042', claimKey: '7Q3K-M9XD', status: 'received', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:30Z'});
    }
    if (path.includes('/v1/papers/pdf')) return options.pdfReply ? options.pdfReply(full) : pdfReply();
    if (path.includes('/v1/papers/search')) {
      return reply(200, {source: 'arxiv', page: 1, hasMore: false, results: [{id: '2503.10497', title: 'Synthetic result', authors: ['Ada'], year: 2026, license: 'cc-by-4.0'}]});
    }
    return reply(404, {error: {code: 'not_found'}});
  };
  const location = {hash: options.hash || ''};
  const handle = booth.mount({
    document: doc, fetch: fetchImpl, storage, location, blindTrust: options.blindTrust,
    config: () => ({booth: {enabled: true}, apiBase: 'https://event.example'}),
    session: () => ({token: async () => options.token === undefined ? 'fsg_' + 'a'.repeat(43) : options.token, invalidate() { invalidated += 1; }}),
    setTimeout: (fn, ms) => { timerId += 1; timers.push({id: timerId, fn, ms}); return timerId; },
    clearTimeout: id => { const at = timers.findIndex(item => item.id === id); if (at >= 0) timers.splice(at, 1); },
    setInterval: (fn, ms) => { timerId += 1; intervals.push({id: timerId, fn, ms}); return timerId; },
    clearInterval: id => { const at = intervals.findIndex(item => item.id === id); if (at >= 0) intervals.splice(at, 1); },
    now: () => clock.t,
  });
  async function tick() {
    assert.equal(timers.length, 1, 'one poll timer pending');
    const next = timers.shift();
    clock.t += next.ms;
    next.fn();
    await settle();
    return next.ms;
  }
  const claimCalls = () => calls.filter(call => call.path.endsWith('/v1/booth/claim'));
  const step = () => doc.documentElement.dataset.boothStep;
  const text = id => ids.get(id).textContent;
  return {doc, ids, content, storage, calls, claimCalls, timers, intervals, clock, tick, handle, location, step, text, invalidated: () => invalidated};
}
function missionButtons(h) {
  return nodesOf(h.ids.get('booth-missions')).filter(node => node.tagName === 'button');
}
async function pickMission(h, index = 0) {
  missionButtons(h)[index].click();
  await settle();
}
function chip(h, label, row = 0) {
  const cards = nodesOf(h.ids.get('booth-rows')).filter(node => node.className === 'booth-panel booth-card');
  return nodesOf(cards[row]).find(node => node.tagName === 'button' && node.textContent === label);
}
function declare(h, label, reason, row = 0) {
  const cards = nodesOf(h.ids.get('booth-rows')).filter(node => node.className === 'booth-panel booth-card');
  if (label) chip(h, label, row).click();
  nodesOf(cards[row]).find(node => node.tagName === 'textarea').value = reason;
}
async function submit(h) {
  h.ids.get('booth-submit').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
}
/* pick → edit → add BoothEdits → 다음 (FalsifyBrowserPdf.rewrite) → send. */
async function reachSend(h, edits = ONE_EDIT) {
  const ws = useWorkspace([]);
  await pickMission(h);
  for (const edit of edits) boothEdits.add(edit);
  h.ids.get('booth-next').click();
  await waitFor(() => h.step() === 'send');
  return ws;
}
async function submitThroughBooth(h) {
  await reachSend(h);
  declare(h, '수치·통계', '평균을 바꿨습니다');
  
  await submit(h);
}

test('the booth mounts only when enabled and starts on pick', async () => {
  const skipped = page();
  let created = false;
  booth.mount({
    document: {createElement() { created = true; return {}; }, getElementById() { return null; }},
    config: () => ({}),
  });
  assert.equal(created, false);
  booth.mount({document: skipped.doc, config: () => ({booth: {enabled: false}})});
  assert.equal(skipped.ids.get('booth'), undefined);
  assert.equal(skipped.doc.documentElement.dataset.boothStep, undefined);
  const h = liveBooth({announcement: '행사 안내'});
  assert.equal(h.content.children[0].id, 'booth');
  assert.equal(h.step(), 'pick');
  assert.equal(h.ids.get('booth').hidden, true);
  assert.equal(h.ids.get('booth-search').hidden, true);
  await settle();
  assert.equal(h.calls[0].path.endsWith('/v1/booth/config'), true);
  assert.equal(h.calls[0].auth, '');
  assert.equal(h.ids.get('booth').hidden, false);
  assert.equal(h.ids.get('booth-search').hidden, false);
  assert.equal(h.text('booth-announce'), '행사 안내');
  assert.equal(h.text('booth-result-link'), '내 기록');
  assert.equal(h.text('booth-title'), 'AI를 속일 수있을까요?');
  assert.equal(nodesOf(h.ids.get('booth-title')).find(node => node.tagName === 'b').textContent, '속일 수');
  assert.match(h.text('booth-step-pick'), /AI REVIEW CHALLENGE/);
  assert.match(h.text('booth-step-pick'), /공개 논문을 몰래 고쳐 보세요\. AI가 보통 1~3분 안에 찾아내는지 겨뤄요\. 심은 결함 중 하나라도 AI가 놓치면 부스에서 선물을 드려요\./);
  assert.doesNotMatch(h.text('booth-step-pick'), /2분 안에/);
  assert.match(h.text('booth-step-pick'), /01논문 고르기.*02몰래 고치기.*03AI 검증/);
  assert.equal(h.text('booth-search-box').startsWith('다른 공개 논문 직접 찾기'), true);
  for (const id of ['booth-step-edit', 'booth-submit', 'booth-receipt']) assert.equal(h.ids.get(id).hidden, true, id);
  h.handle.destroy();
  assert.equal(h.content.children.some(node => node.id === 'booth'), false);
  assert.equal(h.doc.documentElement.dataset.boothStep, undefined);
});

test('a mission ticket loads the paper, jumps to the hint page and opens edit', async () => {
  const h = liveBooth();
  await settle();
  const tickets = missionButtons(h);
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].className, 'booth-tk booth-tk-h booth-mission');
  assert.equal(tickets[0].textContent, 'arXiv 2503.10497 · CC BY 4.0Synthetic mission: a longer subtitle8쪽 표를 고치세요8쪽도전 →');
  assert.equal(tickets[0].getAttribute('aria-label'), 'Synthetic mission: a longer subtitle · 8쪽에서 도전');
  assert.equal(tickets[1].textContent, 'arXiv 2503.10498Plain mission도전 →');
  assert.equal(nodesOf(h.ids.get('booth-missions')).some(node => /쪽으로 가기|이 논문으로 시작/.test(node.textContent || '')), false);
  const ws = useWorkspace([]);
  h.ids.get('paper-file').addEventListener('change', () => {
    const file = h.ids.get('paper-file').files && h.ids.get('paper-file').files[0];
    h.doc.dispatchEvent({type: 'falsify:document-clear'});
    h.doc.dispatchEvent({type: 'falsify:document', detail: {file, fileHash: 'not-the-opened-pdf'}});
  });
  await pickMission(h);
  assert.equal(h.step(), 'edit');
  assert.deepEqual(ws.pages, [8]);
  assert.equal(h.calls.filter(call => call.path.includes('/v1/papers/pdf')).length, 1);
  assert.equal(h.calls.find(call => call.path.includes('/v1/papers/pdf')).auth, 'Bearer fsg_' + 'a'.repeat(43));
  assert.equal(h.ids.get('booth-step-edit').hidden, false);
  assert.equal(h.ids.get('booth-step-pick').hidden, true);
  assert.equal(h.text('booth-hint'), '힌트 · 8쪽 표를 고치세요');
  assert.match(h.text('booth-step-edit'), /← 논문 고르기2 \/ 3 몰래 고치기/);
  h.ids.get('booth-edit-back').click();
  assert.equal(h.step(), 'pick');
  await pickMission(h);
  assert.equal(h.step(), 'edit');
  assert.deepEqual(ws.pages, [8, 8]);
  assert.equal(h.calls.filter(call => call.path.includes('/v1/papers/pdf')).length, 1, 'the open paper is not fetched again');
  h.doc.dispatchEvent({type: 'falsify:document-clear'});
  assert.equal(h.step(), 'pick', 'losing the paper returns to pick');
  await pickMission(h, 1);
  assert.equal(h.step(), 'edit');
  assert.equal(h.text('booth-hint'), '힌트 · 숫자, 결론 문장, 표 값 중 한 곳을 골라 티 나지 않게 바꿔 보세요.');
  h.handle.destroy();
});

test('a failed paper load stays on pick with the reason', async () => {
  const h = liveBooth({token: ''});
  await settle();
  await pickMission(h);
  assert.equal(h.step(), 'pick');
  assert.match(h.text('booth-mission-status'), /연결이 잠시 끊겼어요/);
  h.handle.destroy();
});

test('the dock counts FalsifyBoothEdits, stops calmly at MAX_DECLARED = 5, and disables 다음 at zero', async () => {
  const h = liveBooth();
  await settle();
  useWorkspace([]);
  await pickMission(h);
  assert.equal(h.text('booth-dock-count'), '고친 곳 0개');
  assert.match(h.text('booth-dock'), /여러 곳을 고쳐도 돼요/);
  assert.equal(h.ids.get('booth-next').disabled, true);
  assert.equal(h.ids.get('booth-next').textContent, '다음');
  boothEdits.add(makeBoothEdit({id: 'e-1', pageIndex: 1}));
  boothEdits.add(makeBoothEdit({id: 'e-2', pageIndex: 2, originalText: 'b', newText: 'c'}));
  assert.equal(h.text('booth-dock-count'), '고친 곳 2개');
  assert.equal(h.ids.get('booth-next').disabled, false);
  for (let i = 3; i <= 5; i += 1) boothEdits.add(makeBoothEdit({id: 'e-' + i, pageIndex: i, originalText: 'x' + i, newText: 'y' + i}));
  assert.equal(h.text('booth-dock-count'), '고친 곳 5개');
  assert.equal(h.text('booth-dock-sub'), '5곳까지 고칠 수 있어요');
  assert.equal(h.ids.get('booth-dock').getAttribute('data-at-cap'), 'true');
  assert.equal(h.ids.get('booth-next').disabled, false, '5 edits can still proceed to send');
  assert.doesNotMatch(h.text('booth-dock'), /막혀|거부|불가/);
  boothEdits.add(makeBoothEdit({id: 'e-6', pageIndex: 6, originalText: 'x6', newText: 'y6'}));
  assert.equal(h.ids.get('booth-next').disabled, true, 'above cap stops calmly');
  assert.match(h.text('booth-dock-status'), /한 번에 5곳까지 제출할 수 있어요\. 지금은 6곳이에요\./);
  boothEdits.clear();
  assert.equal(h.ids.get('booth-next').disabled, true);
  h.ids.get('booth-next').click();
  await settle();
  assert.equal(h.step(), 'edit');
  assert.equal(h.text('booth-dock-status'), '');
  h.handle.destroy();
});

test('다음 runs blind-pdf then FalsifyBrowserPdf.rewrite directly, hashes the result, and opens send', async () => {
  const h = liveBooth();
  await settle();
  const ws = useWorkspace([]);
  await pickMission(h);
  boothEdits.add(ONE_EDIT[0]);
  h.ids.get('booth-next').click();
  await waitFor(() => h.step() === 'send');
  assert.equal(ws.blindCalls.length, 1, 'blind-pdf source check ran');
  assert.equal(ws.rewrites.length, 1, 'FalsifyBrowserPdf.rewrite ran once');
  assert.deepEqual(ws.rewrites[0].bytes, SOURCE_BYTES);
  assert.equal(ws.rewrites[0].edits.length, 1);
  assert.equal(ws.rewrites[0].edits[0].originalText, BEFORE);
  assert.equal(ws.rewrites[0].edits[0].newText, AFTER);
  assert.equal(boothContext.FalsifyBoothPaper.output().sha256, EDITED_SHA);
  assert.equal(h.text('booth-dock-status'), '');
  assert.equal(h.ids.get('booth-dock').getAttribute('data-busy'), 'false');
  assert.match(h.text('booth-submit'), /← 고치기3 \/ 3 AI에게 제출/);
  const card = nodesOf(h.ids.get('booth-rows')).find(node => node.className === 'booth-panel booth-card');
  assert.match(card.textContent, /^내가 숨긴 결함 · 2쪽/);
  const diff = nodesOf(card).find(node => node.className === 'booth-diff');
  assert.equal(nodesOf(diff).find(node => node.tagName === 'del').textContent, '4.2');
  assert.equal(nodesOf(diff).find(node => node.tagName === 'ins').textContent, '5.8');
  assert.equal(diff.textContent, 'The mean was 4.25.8 (SD 1.1).');
  assert.doesNotMatch(card.textContent, /운영진만/);
  assert.match(card.textContent, /어떤 결함인가요 \(선택\)/);
  assert.equal(h.ids.get('booth-consent'), undefined);
  assert.equal(h.ids.get('booth-nickname'), undefined);
  assert.equal(h.ids.get('booth-courses'), undefined);
  assert.equal(h.ids.get('booth-make'), undefined);
  assert.equal(h.ids.get('booth-remake'), undefined, 'no #booth-remake button');
  // Back to edit and 다음 again with unchanged edits: skips rewrite and keeps the declaration.
  declare(h, '수치·통계', '평균을 바꿨습니다');
  h.ids.get('booth-send-back').click();
  assert.equal(h.step(), 'edit');
  h.ids.get('booth-next').click();
  await waitFor(() => h.step() === 'send');
  assert.equal(ws.rewrites.length, 1, 'unchanged edits reuse the built PDF');
  assert.equal(chip(h, '수치·통계').className, 'booth-chip on');
  assert.equal(nodesOf(h.ids.get('booth-rows')).find(node => node.tagName === 'textarea').value, '평균을 바꿨습니다');
  h.handle.destroy();
});

function fixLabels(h) {
  const box = h.ids.get('booth-dock-fix');
  return box.hidden ? [] : JSON.parse(JSON.stringify(nodesOf(box).filter(node => node.tagName === 'button').map(node => node.textContent)));
}
function fixButtonOf(h, label) {
  return nodesOf(h.ids.get('booth-dock-fix')).find(node => node.tagName === 'button' && node.textContent === label);
}

test('engine_unavailable is the sole build failure, with one 다시 시도 button', async () => {
  const h = liveBooth();
  await settle();
  let attempt = 0;
  useWorkspace([], {
    browserPdf: {
      async rewrite() {
        attempt += 1;
        if (attempt === 1) {
          const err = new Error('offline');
          err.code = 'engine_unavailable';
          throw err;
        }
        return new Uint8Array(EDITED);
      },
    },
  });
  await pickMission(h);
  boothEdits.add(ONE_EDIT[0]);
  h.ids.get('booth-next').click();
  await settle();
  assert.equal(h.step(), 'edit');
  assert.equal(h.text('booth-dock-status'), booth.ENGINE_UNAVAILABLE);
  assert.deepEqual(fixLabels(h), ['다시 시도']);
  assert.equal(h.ids.get('booth-next').disabled, false);
  fixButtonOf(h, '다시 시도').click();
  await waitFor(() => h.step() === 'send');
  assert.equal(attempt, 2);
  assert.deepEqual(fixLabels(h), []);
  h.handle.destroy();

  // Unchanged bytes from rewrite stay on edit with pdf_unchanged.
  const h2 = liveBooth();
  await settle();
  useWorkspace([], {rewriteResult: () => new Uint8Array(SOURCE_BYTES)});
  await pickMission(h2);
  boothEdits.add(ONE_EDIT[0]);
  h2.ids.get('booth-next').click();
  await settle();
  assert.equal(h2.step(), 'edit');
  assert.match(h2.text('booth-dock-status'), /아직 원본과 같아요/);
  h2.handle.destroy();
});

test('blind-pdf strips an untrusted source before rewrite while preserving original sourceSha256', async () => {
  const cleaned = Buffer.from('%PDF-1.7 cleaned source bytes\n%%EOF\n');
  const h = liveBooth();
  await settle();
  const ws = useWorkspace([], {
    blindPdf: {
      async prepare({file}) {
        ws.blindCalls.push(file);
        return {file: new File([cleaned], 'cleaned.pdf', {type: 'application/pdf'}), sha256: createHash('sha256').update(cleaned).digest('hex'), changed: true, removed: ['footer']};
      },
    },
  });
  await pickMission(h);
  boothEdits.add(ONE_EDIT[0]);
  h.ids.get('booth-next').click();
  await waitFor(() => h.step() === 'send');
  assert.deepEqual(ws.rewrites[0].bytes, cleaned, 'rewrite receives cleaned bytes');
  declare(h, '수치·통계', '값을 바꿨습니다');
  
  await submit(h);
  const posted = h.calls.find(call => call.path.endsWith('/v1/booth/submissions'));
  const meta = JSON.parse(posted.form.get('meta'));
  assert.equal(meta.paper.sourceSha256, SOURCE_SHA, 'meta keeps original sourceSha256');
  h.handle.destroy();
});

test('editing BoothEdits while on send rebuilds automatically before submit', async () => {
  const h = liveBooth();
  await settle();
  const ws = await reachSend(h);
  declare(h, '수치·통계', '값을 바꿨어요');
  
  boothEdits.update('e-1', AFTER + '9');
  await submit(h);
  assert.equal(ws.rewrites.length, 2, 'rebuilt automatically for updated edit');
  assert.equal(h.step(), 'ticket');
  h.handle.destroy();
});

test('declared payload strips C0 control chars and trims to 2000 code points while rewrite keeps full text (P2-1)', async () => {
  const h = liveBooth();
  await settle();
  const rawBefore = 'A\u0000B\u0007C\tD\n' + 'x'.repeat(2100);
  const rawAfter = 'Y\u0001Z\u001f' + 'y'.repeat(2100);
  const ws = await reachSend(h, [makeBoothEdit({id: 'e-long', pageIndex: 2, originalText: rawBefore, newText: rawAfter})]);
  assert.equal(ws.rewrites[0].edits[0].originalText, rawBefore, 'rewrite keeps full originalText');
  assert.equal(ws.rewrites[0].edits[0].newText, rawAfter, 'rewrite keeps full newText');
  declare(h, '수치·통계', '긴 문단을 바꿨어요');
  
  await submit(h);
  assert.equal(h.step(), 'ticket');
  const posted = h.calls.find(call => call.path.endsWith('/v1/booth/submissions'));
  const meta = JSON.parse(posted.form.get('meta'));
  assert.equal(meta.declared[0].before.length, 2000);
  assert.equal(meta.declared[0].after.length, 2000);
  assert.equal(meta.declared[0].before.startsWith('ABC\tD\n'), true, 'C0 controls stripped, tab/newline kept');
  assert.equal(meta.declared[0].after.startsWith('YZ'), true, 'C0 controls stripped from after');
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(meta.declared[0].before + meta.declared[0].after), false);
  h.handle.destroy();
});

test('dock count button opens #booth-dock-pop with delete buttons even at 6 edits (P1-1)', async () => {
  const h = liveBooth();
  await settle();
  useWorkspace([]);
  await pickMission(h);
  for (let i = 0; i < 6; i += 1) {
    boothEdits.add(makeBoothEdit({id: 'p-' + i, pageIndex: i % 5, rects: [{x: 0.1 + i * 0.1, y: 0.2, w: 0.05, h: 0.02}], originalText: 'a' + i, newText: 'b' + i}));
  }
  assert.equal(h.text('booth-dock-count'), '고친 곳 6개');
  assert.equal(h.ids.get('booth-next').disabled, true);
  assert.equal(h.ids.get('booth-dock-pop').hidden, true);
  h.ids.get('booth-dock-count').click();
  assert.equal(h.ids.get('booth-dock-pop').hidden, false);
  assert.equal(h.ids.get('booth-dock-count').getAttribute('aria-expanded'), 'true');
  assert.equal(h.ids.get('booth-dock-pop').children.length, 6);
  const delBtn = h.ids.get('booth-dock-pop').children[0].children[1];
  delBtn.click();
  assert.equal(h.text('booth-dock-count'), '고친 곳 5개');
  assert.equal(h.ids.get('booth-next').disabled, false);
  assert.equal(h.ids.get('booth-dock-pop').hidden, false, 'popover stays open for further removals');
  h.ids.get('booth-dock-count').click();
  assert.equal(h.ids.get('booth-dock-pop').hidden, true);
  h.handle.destroy();
});

test('a lost or refused session at submit is minted again and retried in place', async () => {
  const fill = h => { chip(h, '수치·통계').click(); declare(h, '', '유의수준을 바꿔 결론이 성립하지 않음'); };
  const once = liveBooth({submits: [{status: 401, body: {error: {code: 'unauthorized'}}}]});
  await settle();
  await reachSend(once);
  fill(once);
  await submit(once);
  const posts = once.calls.filter(call => call.path.endsWith('/v1/booth/submissions'));
  assert.equal(posts.length, 2, 'retried once by itself');
  assert.equal(once.invalidated(), 1, 'with a new guest session');
  assert.notEqual(once.step(), 'send', 'and the submission went through');
  once.handle.destroy();
  const twice = liveBooth({submits: [{status: 401, body: {error: {code: 'session_missing'}}}, {status: 411, body: {error: {code: 'length_required'}}}]});
  await settle();
  await reachSend(twice);
  fill(twice);
  await submit(twice);
  assert.equal(twice.step(), 'send', 'the edits and the send step stay');
  assert.doesNotMatch(twice.text('booth-submit-status'), /새로 고/);
  twice.handle.destroy();
});

test('send declares chips and reasons and posts only the contract fields', async () => {
  const h = liveBooth({submits: [{status: 413, body: {error: {code: 'payload_too_large'}}}]});
  await settle();
  await reachSend(h);
  const chips = nodesOf(h.ids.get('booth-rows')).filter(node => node.tagName === 'button' && node.className.startsWith('booth-chip'));
  assert.deepEqual(chips.map(node => node.textContent), ['수치·통계', '그림·표', '인용·출처', '논리·결론', '방법·실험 설계', '기타']);
  assert.equal(chips.every(node => node.getAttribute('aria-pressed') === 'false'), true);
  
  assert.equal(h.ids.get('booth-submit-button').disabled, false);
  assert.equal(h.text('booth-submit-button'), 'AI에게 제출하기');
  chip(h, '그림·표').click();
  chip(h, '그림·표').click();
  assert.equal(chip(h, '그림·표').getAttribute('aria-pressed'), 'false', 'a second tap clears the type');
  chip(h, '그림·표').click();
  chip(h, '수치·통계').click();
  assert.equal(chip(h, '수치·통계').className, 'booth-chip on');
  assert.equal(chip(h, '수치·통계').getAttribute('aria-pressed'), 'true');
  assert.equal(chip(h, '그림·표').className, 'booth-chip');
  declare(h, '', '유의수준을 바꿔 결론이 성립하지 않음');
  await submit(h);
  assert.equal(h.text('booth-submit-status'), '수정본 PDF는 16MB까지 제출할 수 있어요.');
  assert.equal(h.step(), 'send');
  await submit(h);
  const posts = h.calls.filter(call => call.path.endsWith('/v1/booth/submissions'));
  assert.equal(posts.length, 2);
  const posted = posts[1];
  assert.equal(posted.auth, 'Bearer fsg_' + 'a'.repeat(43));
  assert.equal(posted.contentType, '');
  assert.deepEqual([...posted.form.keys()], ['meta', 'pdf']);
  const meta = JSON.parse(posted.form.get('meta'));
  assert.deepEqual(Object.keys(meta), ['course', 'declared', 'paper', 'consentVersion', 'editedSha256']);
  assert.equal(meta.course, 'quick');
  assert.equal(meta.consentVersion, '2026-11-22.v2');
  assert.equal(meta.editedSha256, EDITED_SHA);
  assert.deepEqual(meta.paper, {source: 'mission', id: '2503.10497', title: 'Synthetic mission: a longer subtitle', license: 'cc-by-4.0', sourceSha256: SOURCE_SHA});
  assert.deepEqual(meta.declared, [{pageIndex: 1, before: BEFORE, after: AFTER, defectType: 'number', reason: '유의수준을 바꿔 결론이 성립하지 않음'}]);
  assert.equal(JSON.stringify(meta).includes(RATIONALE), false);
  assert.equal(posted.form.get('pdf').name, 'edited.pdf');
  assert.equal(posted.form.get('pdf').type, 'application/pdf');
  assert.equal(posted.form.get('pdf').size, EDITED.length);
  assert.equal(h.step(), 'ticket');
  assert.deepEqual(plain(booth.readReceipts(h.storage)[0]), {
    receipt: 'F-0042', claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:00:30Z',
    title: 'Synthetic mission: a longer subtitle', pages: [2], count: 1,
    edits: [{page: 2, before: BEFORE, after: AFTER}],
  });
  h.handle.destroy();
});

test('send has no consent box or nickname; empty type and reason still submit', async () => {
  const h = liveBooth();
  await settle();
  await reachSend(h);
  assert.equal(h.ids.get('booth-consent'), undefined);
  assert.equal(h.ids.get('booth-consent-panel'), undefined);
  assert.equal(h.ids.get('booth-nickname'), undefined);
  assert.doesNotMatch(h.text('booth-submit'), /동의|별명|운영진만/);
  assert.equal(h.ids.get('booth-submit-button').disabled, false);
  await submit(h);
  const posts = h.calls.filter(call => call.path.endsWith('/v1/booth/submissions'));
  assert.equal(posts.length, 1);
  const meta = JSON.parse(posts[0].form.get('meta'));
  assert.equal(meta.consentVersion, '2026-11-22.v2');
  assert.deepEqual(plain(meta.declared.map(item => [item.defectType, item.reason])), [['other', booth.NO_REASON]]);
  assert.equal(h.step(), 'ticket');
  h.handle.destroy();
});

test('the ticket polls the claim view until the AI result is published', async () => {
  const h = liveBooth({claims: [
    {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false},
    {status: 429, headers: {'Retry-After': '45'}, body: {error: {code: 'rate_limited'}}},
    {status: 429, body: {error: {code: 'rate_limited'}}},
    {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false},
    {receipt: 'F-0042', status: 'judged', course: 'quick', declaredCount: 1, published: true, outcome: 'missed', createdAt: '2026-11-22T01:00:30Z',
      publicNote: '<b>표</b> 값 변경을 놓쳤어요', prizeMessage: '부스에서 작은 선물을 받아 가세요', publishedAt: '2026-11-22T01:03:00Z'},
  ]});
  await settle();
  await submitThroughBooth(h);
  assert.equal(h.step(), 'ticket');
  assert.equal(h.text('booth-receipt-code'), 'F-0042');
  assert.equal(h.text('booth-claim-code'), '7Q3K-M9XD');
  assert.equal(h.text('booth-ticket-paper'), 'Synthetic mission');
  assert.equal(h.text('booth-ticket-pages'), '2쪽 · 1곳');
  assert.match(h.text('booth-ticket'), /^FALSIFY · AI REVIEW TICKET/);
  assert.equal(h.ids.get('booth-ticket-wait').hidden, false);
  assert.equal(h.ids.get('booth-ticket-result').hidden, true);
  assert.equal(h.ids.get('booth-ticket-duration-cell').hidden, true);
  assert.equal(h.text('booth-ticket-state'), 'AI 검증 차례를 기다리는 중');
  assert.equal(h.text('booth-ticket-elapsed'), '0:00');
  assert.equal(h.intervals.length, 1);
  h.clock.t += 42000;
  h.intervals[0].fn();
  assert.equal(h.text('booth-ticket-elapsed'), '0:42');
  h.clock.t -= 42000;
  assert.equal(h.text('booth-ticket-steps'), '수정본 받음AI가 앞뒤 문장과 표를 대조하는 중결과');
  assert.match(h.text('booth-live-capture'), /^이 티켓을 캡처해 두세요\. 화면을 닫아도 「내 기록」에서/);
  assert.equal(h.ids.get('booth-live-again').hidden, true);
  assert.equal(h.text('booth-chances-top'), '기회 4번 남음');
  assert.equal(h.claimCalls().length, 0);
  assert.equal(await h.tick(), 15000);
  assert.deepEqual(h.claimCalls()[0].body, {receipt: 'F-0042', claimKey: '7Q3K-M9XD'});
  assert.equal(h.text('booth-ticket-state'), 'AI가 논문을 읽는 중');
  assert.equal(await h.tick(), 15000);
  assert.equal(await h.tick(), 45000);
  assert.equal(await h.tick(), 60000);
  assert.equal(h.ids.get('booth-ticket-wait').hidden, false);
  assert.equal(await h.tick(), 15000);
  assert.equal(h.claimCalls().length, 5);
  assert.equal(h.timers.length, 0);
  assert.equal(h.intervals.length, 0, 'the clock stops with the result');
  assert.equal(h.ids.get('booth-ticket-wait').hidden, true);
  assert.equal(h.ids.get('booth-ticket-steps').hidden, true);
  assert.equal(h.ids.get('booth-ticket-result').hidden, false);
  assert.equal(h.text('booth-live-title'), 'AI가 못 찾았어요');
  assert.equal(nodesOf(h.ids.get('booth-live-title')).find(node => node.tagName === 'b').textContent, '못 찾았어요');
  assert.equal(h.ids.get('booth-stamp').className, 'booth-stamp pass');
  assert.equal(h.text('booth-stamp'), '통과PASSED');
  assert.match(h.text('booth-ticket-result'), /^AI 검증 결과/);
  assert.equal(h.text('booth-ticket-duration'), '2분 30초');
  assert.equal(h.ids.get('booth-ticket-duration-cell').hidden, false);
  assert.equal(h.ids.get('booth-gift').hidden, false);
  assert.match(h.text('booth-gift'), /^교환권 · 1인 1회부스에서 작은 선물을 받아 가세요/);
  assert.equal(h.text('booth-live-note'), 'AI가 의심한 곳<b>표</b> 값 변경을 놓쳤어요');
  assert.equal(h.ids.get('booth-live-again').hidden, false);
  assert.equal(h.text('booth-live-again'), '다시 도전하기 · 기회 4번 남음');
  assert.equal(booth.readReceipts(h.storage)[0].outcome, 'missed');
  const history = nodesOf(h.ids.get('booth-history')).filter(node => node.tagName === 'button');
  assert.deepEqual(history.map(node => node.children.map(kid => kid.textContent)), [['F-0042 · Synthetic mission', '통과']]);
  assert.equal(history[0].className, 'booth-hist-row pass');
  assert.equal(h.ids.get('booth-withdraw-box').hidden, false);
  h.ids.get('booth-live-again').click();
  assert.equal(h.step(), 'pick');
  assert.equal(h.ids.get('booth-receipt').hidden, true);
  assert.equal(h.ids.get('booth-submit').hidden, true);
  assert.equal(h.ids.get('booth-rows').textContent, '');
  assert.equal(h.ids.get('booth-missions').hidden, false);
  assert.equal(h.ids.get('booth-landing').hidden, false);
  assert.equal(h.timers.length, 0);
  h.handle.destroy();
});

test('polling stops after 15 min with a recheck button and lookups reuse the ticket', async () => {
  const pending = {receipt: 'F-0042', status: 'received', course: 'quick', declaredCount: 1, published: false};
  const h = liveBooth({claims: [pending]});
  await settle();
  h.ids.get('booth-result-link').dispatchEvent({type: 'click', preventDefault() {}});
  assert.equal(h.location.hash, '#booth-result');
  assert.equal(h.ids.get('booth-result').hidden, false);
  assert.equal(h.ids.get('booth-landing').hidden, true);
  assert.equal(h.step(), 'pick');
  h.ids.get('booth-claim-receipt').value = 'f-0042';
  h.ids.get('booth-claim-key').value = '7q3k m9xd';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.claimCalls()[0].auth, '');
  assert.deepEqual(h.claimCalls()[0].body, {receipt: 'F-0042', claimKey: '7Q3K-M9XD'});
  assert.equal(h.step(), 'ticket');
  assert.equal(h.location.hash, '#booth');
  assert.equal(h.text('booth-claim-code'), '7Q3K-M9XD');
  assert.equal(h.ids.get('booth-ticket-paper-cell').hidden, true);
  assert.equal(h.text('booth-ticket-pages'), '1곳');
  const delays = [];
  while (h.timers.length) delays.push(await h.tick());
  assert.equal(delays.length, 12 + 24);
  assert.equal(delays.reduce((sum, ms) => sum + ms, 0), 900000);
  assert.equal(h.claimCalls().length, 1 + 36);
  assert.equal(h.ids.get('booth-live-recheck').hidden, false);
  assert.equal(h.text('booth-live-recheck'), '결과 다시 보기');
  h.ids.get('booth-live-recheck').click();
  await settle();
  assert.equal(h.claimCalls().length, 38);
  assert.equal(h.ids.get('booth-live-recheck').hidden, true);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 15000);
  h.handle.destroy();
  assert.equal(h.timers.length, 0);
  assert.equal(h.intervals.length, 0);
});

test('a wrong claim stays on 내 기록 with the reason', async () => {
  const h = liveBooth({claims: []});
  await settle();
  h.ids.get('booth-result-link').dispatchEvent({type: 'click', preventDefault() {}});
  h.ids.get('booth-claim-receipt').value = 'F-0042';
  h.ids.get('booth-claim-key').value = 'bad';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.match(h.text('booth-result-error'), /접수번호와 확인키를 다시 확인해 볼까요\?/);
  h.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.step(), 'pick');
  assert.match(h.text('booth-result-error'), /접수번호와 확인키를 다시 확인해 볼까요\?/);
  h.ids.get('booth-records-back').click();
  assert.equal(h.ids.get('booth-result').hidden, true);
  assert.equal(h.ids.get('booth-landing').hidden, false);
  h.handle.destroy();
});

test('every final outcome shows its headline, stamp and gift ticket', async () => {
  const cases = [
    ['caught', 'AI가 찾아냈어요', '찾아냈어요', 'booth-stamp fail', '적발DETECTED'],
    ['partial', 'AI가 근처를 짚었어요', '근처를 짚었어요', 'booth-stamp fail', '적발DETECTED'],
    ['missed', 'AI가 못 찾았어요', '못 찾았어요', 'booth-stamp pass', '통과PASSED'],
    ['invalid', '이번 도전은 무효로 끝났어요', '무효로 끝났어요', 'booth-stamp void', '무효VOID'],
  ];
  for (const [outcome, title, strong, stampClass, stampText] of cases) {
    for (const prize of ['prize ' + outcome, '']) {
      const h = liveBooth({claims: [{receipt: 'F-0042', status: outcome === 'invalid' ? 'invalid' : 'judged', course: 'quick', declaredCount: 1,
        published: true, outcome, publicNote: 'note ' + outcome, prizeMessage: prize || undefined}]});
      await settle();
      h.ids.get('booth-claim-receipt').value = 'F-0042';
      h.ids.get('booth-claim-key').value = '7Q3K-M9XD';
      h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
      await settle();
      assert.equal(h.step(), 'ticket');
      assert.equal(h.text('booth-live-title'), title, outcome);
      assert.equal(nodesOf(h.ids.get('booth-live-title')).find(node => node.tagName === 'b').textContent, strong);
      assert.equal(h.ids.get('booth-stamp').className, stampClass);
      assert.equal(h.text('booth-stamp'), stampText);
      assert.equal(h.ids.get('booth-gift').hidden, !prize, outcome + ' gift');
      assert.equal(h.text('booth-live-prize'), prize);
      assert.match(h.text('booth-live-note'), new RegExp('note ' + outcome + '$'));
      assert.equal(h.ids.get('booth-live-tip').hidden, !(outcome === 'caught' || outcome === 'partial'));
      assert.equal(h.ids.get('booth-live-sub').hidden, outcome !== 'partial', outcome + ' sub-copy');
      assert.equal(h.text('booth-live-sub'), outcome === 'partial' ? '결함 근처까지 짚으면 적발로 봐요.' : '');
      assert.equal(h.ids.get('booth-ticket-duration-cell').hidden, true, 'no publishedAt, no duration');
      assert.equal(h.ids.get('booth-live-again').hidden, false);
      assert.equal(h.timers.length, 0);
      h.handle.destroy();
    }
  }
  const w = liveBooth({claims: [{receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false}],
    withdrawn: {receipt: 'F-0042', status: 'withdrawn', course: 'quick', declaredCount: 1, published: false}});
  await settle();
  w.ids.get('booth-claim-receipt').value = 'F-0042';
  w.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  w.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(w.ids.get('booth-withdraw-box').tagName, 'details');
  assert.equal(w.text('booth-withdraw-box').startsWith('제출 철회'), true);
  // The confirm stage replaces the first button: 취소 (outline) and 철회하기 (fail outline) under the warning.
  assert.equal(w.ids.get('booth-withdraw-ask').hidden, true);
  assert.equal(w.ids.get('booth-withdraw').hidden, false);
  w.ids.get('booth-withdraw').click();
  assert.equal(w.ids.get('booth-withdraw-ask').hidden, false);
  assert.equal(w.ids.get('booth-withdraw').hidden, true, 'the first button gives way');
  assert.equal(w.text('booth-withdraw-ask'), '철회하면 되돌릴 수 없고, 선물과 추첨 기회도 함께 사라져요.취소철회하기');
  assert.equal(w.ids.get('booth-withdraw-cancel').className, 'booth-btn line');
  assert.equal(w.ids.get('booth-withdraw-confirm').className, 'booth-btn line danger');
  w.ids.get('booth-withdraw-cancel').click();
  assert.equal(w.ids.get('booth-withdraw-ask').hidden, true);
  assert.equal(w.ids.get('booth-withdraw').hidden, false);
  assert.equal(w.calls.some(call => call.path.endsWith('/v1/booth/withdraw')), false);
  w.ids.get('booth-withdraw').click();
  assert.equal(w.calls.some(call => call.path.endsWith('/v1/booth/withdraw')), false);
  w.ids.get('booth-withdraw-confirm').click();
  await settle();
  const withdrawn = w.calls.find(call => call.path.endsWith('/v1/booth/withdraw'));
  assert.equal(withdrawn.auth, '');
  assert.deepEqual(withdrawn.body, {receipt: 'F-0042', claimKey: '7Q3K-M9XD'});
  assert.equal(w.text('booth-live-title'), '제출을 철회했어요');
  assert.equal(w.text('booth-stamp'), '철회WITHDRAWN');
  assert.equal(w.ids.get('booth-withdraw-box').hidden, true);
  assert.equal(w.ids.get('booth-live-again').hidden, false);
  assert.equal(w.timers.length, 0);
  w.handle.destroy();
});

/* ux-ai-assist P0-2: AI-made edits keep their source on the send card. */
test('the send card names an AI-assisted edit', async () => {
  const cases = [
    [{assist: 'my-ai'}, 'AI와 숨긴 결함 · 2쪽', 'AI 제안'],
    [{assist: 'manual'}, '내가 숨긴 결함 · 2쪽', null],
    [null, '내가 숨긴 결함 · 2쪽', null],
  ];
  try {
    for (const [info, title, chipText] of cases) {
      boothContext.FalsifyBoothRecipe = info ? {assist: () => info} : {};
      const h = liveBooth();
      await settle();
      await reachSend(h);
      const card = nodesOf(h.ids.get('booth-rows')).find(node => node.className === 'booth-panel booth-card');
      assert.equal(nodesOf(card).find(node => node.className === 'booth-klab').textContent, title);
      const aiChip = nodesOf(card).find(node => node.className === 'booth-ai-chip');
      assert.equal(aiChip ? aiChip.textContent : null, chipText);
      h.handle.destroy();
    }
  } finally {
    delete boothContext.FalsifyBoothRecipe;
  }
});

/* ux-booth P0-3: only AI verdicts show a 검증 시간; an operator's invalid call is not an AI wait. */
test('the ticket shows 검증 시간 for AI verdicts only', async () => {
  for (const [outcome, shown] of [['missed', true], ['partial', true], ['invalid', false]]) {
    const h = liveBooth({claims: [{receipt: 'F-0042', status: outcome === 'invalid' ? 'invalid' : 'judged', course: 'quick', declaredCount: 1,
      published: true, outcome, publicNote: 'note', createdAt: '2026-11-22T01:00:00Z', publishedAt: '2026-11-22T01:05:00Z'}]});
    await settle();
    h.ids.get('booth-claim-receipt').value = 'F-0042';
    h.ids.get('booth-claim-key').value = '7Q3K-M9XD';
    h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
    await settle();
    assert.equal(h.ids.get('booth-ticket-duration-cell').hidden, !shown, outcome);
    assert.equal(h.text('booth-ticket-duration'), shown ? '5분' : '', outcome);
    h.handle.destroy();
  }
});

/* Desktop layout nodes (booth.css shows them at >=1024px only). */
function deskSteps(h) {
  return [1, 2, 3].map(n => {
    const item = h.ids.get('booth-desk-step-' + n);
    return (item.className || '-') + ':' + item.getAttribute('aria-current');
  }).join(' ');
}
test('the desktop top bar marks the current step bold and earlier steps done', async () => {
  const h = liveBooth();
  await settle();
  const bar = h.ids.get('booth-deskbar');
  assert.equal(bar.className, 'booth-deskbar booth-desk');
  const kids = h.ids.get('booth').children;
  assert.equal(kids.indexOf(bar) < kids.indexOf(h.ids.get('booth-step-pick')), true, 'the bar leads #booth, before every step');
  assert.equal(h.text('booth-deskbar'), 'FFalsifyAI REVIEW CHALLENGE1논문 고르기2몰래 고치기3AI 검증내 기록');
  assert.equal(h.ids.get('booth-desk-records').getAttribute('href'), '#booth-result');
  assert.equal(deskSteps(h), 'on:step -:false -:false');
  await reachSend(h);
  assert.equal(deskSteps(h), 'done:false done:false on:step');
  h.ids.get('booth-send-back').click();
  assert.equal(h.step(), 'edit');
  assert.equal(deskSteps(h), 'done:false on:step -:false');
  h.ids.get('booth-dock-back').click();
  assert.equal(h.step(), 'pick', 'the dock has its own way back to pick');
  assert.equal(deskSteps(h), 'on:step -:false -:false');
  h.ids.get('booth-desk-records').dispatchEvent({type: 'click', preventDefault() {}});
  assert.equal(h.location.hash, '#booth-result');
  assert.equal(h.ids.get('booth-result').hidden, false);
  h.handle.destroy();
});

test('the desktop pick step adds the how-to list, the cap line and the mission count', async () => {
  const h = liveBooth({perOwner: 3});
  await settle();
  assert.equal(h.text('booth-howto'), '01논문 고르기미션 논문이나 공개 논문 하나02몰래 고치기숫자, 문장, 결론 어디든 한 곳 이상03AI 검증보통 1~3분, 접수번호로 결과 확인');
  assert.equal(h.text('booth-pick-limit'), '1인 3번까지 · 이름·연락처는 받지 않아요');
  // Phones see the rules line and the how-to too: neither is a desktop-only node, and the line follows the hero.
  for (const id of ['booth-howto', 'booth-pick-limit']) assert.equal(h.ids.get(id).className.split(' ').includes('booth-desk'), false, id);
  const intro = h.ids.get('booth-pick-limit').parentNode.children;
  assert.equal(intro.indexOf(h.ids.get('booth-pick-limit')), intro.indexOf(h.ids.get('booth-howto')) - 1, 'the rules line sits above the how-to');
  assert.equal(h.ids.get('booth-mission-head').hidden, false);
  assert.equal(h.text('booth-mission-count'), '오늘의 미션 · 2');
  assert.match(h.text('booth-mission-head'), /티켓을 누르면 힌트 쪽이 열려요$/);
  h.handle.destroy();
  const none = liveBooth({missions: []});
  await settle();
  assert.equal(none.ids.get('booth-mission-head').hidden, true);
  none.handle.destroy();
});

test('on desktop the paper search is one open row; phones keep the closed disclosure', async () => {
  const media = {matches: true, listeners: [], addEventListener(type, fn) { this.listeners.push(fn); }, removeEventListener() {}};
  const queries = [];
  const {doc, ids} = page();
  const handle = booth.mount({
    document: doc, storage: memoryStorage(), location: {hash: ''}, fetch: async () => ({ok: false, status: 500, json: async () => ({})}),
    config: () => ({booth: {enabled: true}, apiBase: 'https://event.example'}),
    matchMedia: query => { queries.push(query); return media; },
  });
  assert.deepEqual(queries, ['(min-width:1024px)']);
  assert.equal(ids.get('booth-search-box').open, true);
  assert.equal(ids.get('booth-search-go').textContent, '찾기');
  assert.equal(ids.get('booth-search-q').getAttribute('placeholder'), '다른 공개 논문 찾기 · 제목 또는 주제');
  media.matches = false;
  for (const fn of media.listeners) fn();
  assert.equal(ids.get('booth-search-box').open, false);
  assert.equal(ids.get('booth-search-go').textContent, '검색');
  assert.equal(ids.get('booth-search-q').getAttribute('placeholder'), '제목 또는 주제');
  handle.destroy();
});

test('the desktop dock lists each BoothEdit as a chip, deletes via FalsifyBoothEdits and jumps via showPage', async () => {
  const h = liveBooth();
  await settle();
  const ws = useWorkspace([]);
  await pickMission(h);
  assert.equal(h.ids.get('booth-dock-chips').children.length, 0);
  const chips = () => h.ids.get('booth-dock-chips').children;
  const label = node => nodesOf(node).filter(kid => kid.tagName !== 'button').map(kid => kid._text).join('');
  const xOf = node => nodesOf(node).find(kid => kid.className === 'booth-dock-x');
  boothEdits.add(makeBoothEdit({id: 'e1'}));
  assert.equal(chips().length, 1);
  assert.equal(chips()[0].className, 'booth-dock-chip');
  assert.equal(label(chips()[0]), '2쪽4.2→5.8');
  assert.equal(nodesOf(chips()[0]).find(node => node.tagName === 'del').textContent, '4.2');
  assert.equal(xOf(chips()[0]).textContent, '×');
  assert.equal(xOf(chips()[0]).getAttribute('aria-label'), '2쪽 고친 곳 지우기');
  boothEdits.add(makeBoothEdit({id: 'e2', pageIndex: 4, originalText: 'abc VeryLongDeletedToken xyz', newText: 'abc  xyz'}));
  boothEdits.add(makeBoothEdit({id: 'e3', pageIndex: 6, originalText: BEFORE_2, newText: AFTER_2}));
  boothEdits.add(makeBoothEdit({id: 'e4', pageIndex: 7, originalText: 'a', newText: 'b'}));
  assert.deepEqual(chips().slice(0, 3).map(label), ['2쪽4.2→5.8', '5쪽VeryLongDelet…→(지움)', '7쪽120→210']);
  assert.equal(h.text('booth-dock-count'), '고친 곳 4개');
  // × removes directly from FalsifyBoothEdits and refreshes the dock.
  xOf(chips()[2]).click();
  assert.equal(boothEdits.list().some(e => e.id === 'e3'), false);
  assert.equal(h.text('booth-dock-count'), '고친 곳 3개');
  boothEdits.add(makeBoothEdit({id: 'e5', pageIndex: 7, rects: [{x: 0.5, y: 0.5, w: 0.1, h: 0.02}], originalText: 'c', newText: 'd'}));
  // +N opens a popover with every edit; its text jumps to that page, its × deletes.
  const more = chips()[3];
  assert.equal(more.tagName, 'button');
  assert.equal(more.className, 'booth-dock-chip more');
  assert.equal(more.textContent, '+1');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(h.ids.get('booth-dock-pop').hidden, true);
  more.click();
  const pop = h.ids.get('booth-dock-pop');
  assert.equal(pop.hidden, false);
  assert.equal(chips()[3].getAttribute('aria-expanded'), 'true');
  assert.equal(pop.children.length, 4, 'every edit is listed');
  assert.equal(label(pop.children[3]), '8쪽c→d');
  const jump = pop.children[3].children[0];
  assert.equal(jump.getAttribute('aria-label'), '8쪽 고친 곳으로 이동');
  ws.pages.length = 0;
  jump.click();
  assert.deepEqual(ws.pages, [8]);
  assert.equal(pop.hidden, true, 'jumping to an edit closes the popover');
  chips()[3].click();
  xOf(h.ids.get('booth-dock-pop').children[0]).click();
  assert.equal(boothEdits.list().some(e => e.id === 'e1'), false);
  h.ids.get('booth-dock').dispatchEvent({type: 'keydown', key: 'Escape'});
  assert.equal(h.ids.get('booth-dock-pop').hidden, true);
  boothEdits.clear();
  assert.equal(chips().length, 0);
  h.handle.destroy();
});

test('the desktop send ticket holds the submit nodes and sums up the paper', async () => {
  const h = liveBooth();
  await settle();
  await reachSend(h, [ONE_EDIT[0], makeBoothEdit({id: 'e-2', pageIndex: 3, originalText: BEFORE_2, newText: AFTER_2})]);
  const side = h.ids.get('booth-send-ticket');
  const inside = new Set(nodesOf(side));
  for (const id of ['booth-submit-button', 'booth-submit-status']) assert.equal(inside.has(h.ids.get(id)), true, id);
  assert.equal(nodesOf(h.ids.get('booth-submit')).filter(node => node.id === 'booth-submit-button').length, 1);
  assert.match(h.text('booth-send-ticket'), /^Submission논문/);
  assert.equal(h.text('booth-send-paper'), 'Synthetic mission: a longer subtitle');
  assert.equal(h.text('booth-send-count'), '2곳 · 2, 4쪽');
  assert.equal(h.text('booth-send-chances'), '5번');
  assert.match(h.text('booth-submit'), /숨긴 결함을 확인해요/);
  h.handle.destroy();
});

test('the 최종 추첨 panel shows only when the AI missed, and the stub carries the receipt', async () => {
  for (const outcome of ['missed', 'caught', 'partial', 'invalid']) {
    const h = liveBooth({claims: [{receipt: 'F-0042', status: outcome === 'invalid' ? 'invalid' : 'judged', course: 'quick', declaredCount: 1,
      published: true, outcome, publicNote: 'note', prizeMessage: outcome === 'missed' ? 'prize' : undefined}]});
    await settle();
    h.ids.get('booth-claim-receipt').value = 'F-0042';
    h.ids.get('booth-claim-key').value = '7Q3K-M9XD';
    h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
    await settle();
    assert.equal(h.step(), 'ticket');
    assert.equal(h.ids.get('booth-final').hidden, outcome !== 'missed', outcome);
    assert.equal(h.ids.get('booth-final').className, 'booth-panel booth-final', 'phones see the draw card too');
    assert.equal(h.text('booth-final'), '최종 추첨마감 후 더 정밀한 AI가 한 번 더 검증해요. 그때도 못 찾으면 최종 추첨 대상이에요.');
    assert.equal(h.ids.get('booth-live-records').hidden, false);
    assert.equal(h.text('booth-stub-receipt'), 'F-0042');
    assert.equal(deskSteps(h), 'done:false done:false on:step');
    h.ids.get('booth-live-records').dispatchEvent({type: 'click', preventDefault() {}});
    assert.equal(h.step(), 'pick');
    assert.equal(h.ids.get('booth-result').hidden, false);
    h.handle.destroy();
  }
  const w = liveBooth({claims: [{receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false, createdAt: '2026-11-22T01:00:00Z'}]});
  await settle();
  w.ids.get('booth-claim-receipt').value = 'F-0042';
  w.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  w.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(w.ids.get('booth-final').hidden, true, 'pending');
  assert.equal(w.ids.get('booth-live-records').hidden, true);
  assert.equal(w.text('booth-stub-date'), '2026.11.22');
  assert.equal(w.text('booth-stub-receipt'), 'F-0042');
  const stub = w.ids.get('booth-ticket-stub');
  assert.equal(stub.children.includes(w.ids.get('booth-barcode')), true, 'the one barcode canvas sits in the stub');
  w.handle.destroy();
});

/* The CLI writes publicNote from tools/booth templates; the ticket reads those lines back. */
test('publicNote parses the three CLI templates and falls back to plain text', async () => {
  const config = JSON.parse(await readFile(fileURLToPath(new URL('../../tools/booth/booth.config.example.json', import.meta.url)), 'utf8'));
  const {buildPublicNote} = await import('../../tools/booth/lib/note.mjs');
  const templates = config.live.publicNote;
  const finding = {pageIndex: 8, quote: 'reducing detection and localization time by 10% and 43%', rationale: 'Finding 5 and the results disagree.'};
  const caught = buildPublicNote({outcome: 'caught', matched: finding, templates});
  const partial = buildPublicNote({outcome: 'partial', matched: finding, templates});
  const escaped = buildPublicNote({outcome: 'missed', matched: finding, first: finding, templates});
  const missed = buildPublicNote({outcome: 'missed', first: finding, templates});
  const none = buildPublicNote({outcome: 'missed', first: null, templates});
  assert.deepEqual(plain(booth.parsePublicNote(caught)), {
    page: '9', quote: 'reducing detection and localization time by 10% and 43%',
    opinion: 'Finding 5 and the results disagree.', text: '내가 심어 둔 결함을 AI가 찾았어요.',
  });
  assert.deepEqual(plain(booth.parsePublicNote(partial)), {
    page: '9', quote: 'reducing detection and localization time by 10% and 43%',
    opinion: 'Finding 5 and the results disagree.', text: '내가 심어 둔 결함 근처를 AI가 짚었어요.',
  });
  assert.deepEqual(plain(booth.parsePublicNote(escaped)), {
    page: '9', quote: 'reducing detection and localization time by 10% and 43%',
    opinion: 'Finding 5 and the results disagree.', text: '심어 둔 결함 중 일부는 AI가 찾았어요.',
  });
  assert.deepEqual(plain(booth.parsePublicNote(missed)), {page: '', quote: '', opinion: '', text: missed});
  assert.deepEqual(plain(booth.parsePublicNote(none)), {page: '', quote: '', opinion: '', text: none});
  assert.deepEqual(plain(booth.parsePublicNote('운영진 메모\n두 번째 줄')), {page: '', quote: '', opinion: '', text: '운영진 메모\n두 번째 줄'});
  assert.deepEqual(plain(booth.parsePublicNote('찾았어요 (AI가 짚은 곳: ?쪽)')), {page: '', quote: '', opinion: '', text: '찾았어요'});
  assert.equal(booth.parsePublicNote(null).text, '');
  const h = liveBooth({claims: [{receipt: 'F-0042', status: 'judged', published: true, outcome: 'caught', publicNote: caught,
    createdAt: '2026-11-22T01:00:00Z', publishedAt: '2026-11-22T01:02:14Z'}]});
  await settle();
  h.ids.get('booth-claim-receipt').value = 'F-0042';
  h.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.text('booth-live-page'), 'AI가 짚은 곳 · 9쪽');
  assert.equal(h.ids.get('booth-live-page').hidden, false);
  const note = nodesOf(h.ids.get('booth-live-note'));
  assert.equal(note.find(node => node.tagName === 'blockquote').textContent, 'reducing detection and localization time by 10% and 43%');
  assert.deepEqual(note.filter(node => node.className.startsWith('booth-klab')).map(node => node.textContent), ['AI 의견']);
  assert.equal(h.text('booth-live-note'), '내가 심어 둔 결함을 AI가 찾았어요.reducing detection and localization time by 10% and 43%AI 의견Finding 5 and the results disagree.');
  assert.equal(h.text('booth-ticket-duration'), '2분 14초');
  h.handle.destroy();
});

test('chances count down from the per-guest cap and never go below zero', async () => {
  assert.equal(booth.chancesLeft(5, 0), 5);
  assert.equal(booth.chancesLeft(5, 1), 4);
  assert.equal(booth.chancesLeft(5, 7), 0);
  assert.equal(booth.chancesLeft(undefined, 2), 3);
  const storage = memoryStorage();
  for (let i = 1; i <= 2; i += 1) booth.rememberReceipt(storage, {receipt: 'F-000' + i, claimKey: '7Q3K-M9XD', createdAt: '2026-11-21T01:00:00Z'});
  const h = liveBooth({storage, claims: [{receipt: 'F-0002', status: 'judged', published: true, outcome: 'caught'}]});
  await settle();
  assert.equal(h.text('booth-chances-top'), '기회 3번 남음');
  assert.equal(h.text('booth-live-again'), '다시 도전하기 · 기회 3번 남음');
  h.handle.destroy();
  for (let i = 3; i <= 7; i += 1) booth.rememberReceipt(storage, {receipt: 'F-000' + i, claimKey: '7Q3K-M9XD', createdAt: '2026-11-21T01:00:00Z'});
  const full = liveBooth({storage});
  await settle();
  assert.equal(full.text('booth-live-again'), '다시 도전하기 · 기회 0번 남음');
  full.handle.destroy();
});

test('the diff shows only the changed region with a little context', () => {
  assert.deepEqual(plain(booth.diffParts('Ragas 0.95 0.78 0.70', 'Ragas 0.50 0.78 0.70')), {lead: 'Ragas ', removed: '0.95', added: '0.50', tail: ' 0.78 0.70'});
  const long = 'x'.repeat(60) + ' the mean was 4.2 in the treated arm ' + 'y'.repeat(60);
  const parts = booth.diffParts(long, long.replace('4.2', '5.8'));
  assert.equal(parts.removed, '4.2');
  assert.equal(parts.added, '5.8');
  assert.equal(parts.lead, '…' + long.slice(long.indexOf('4.2') - 24, long.indexOf('4.2')));
  assert.equal(parts.tail.endsWith('…'), true);
  assert.equal(parts.lead.length + parts.removed.length + parts.tail.length < 60, true);
  assert.deepEqual(plain(booth.diffParts('remove this word please', 'remove word please')), {lead: 'remove ', removed: 'this ', added: '', tail: 'word please'});
  assert.deepEqual(plain(booth.diffParts('a', 'a b')), {lead: 'a', removed: '', added: ' b', tail: ''});
  assert.equal(booth.licenseLabel('cc-by-4.0'), 'CC BY 4.0');
  assert.equal(booth.licenseLabel('cc-by-3.0'), 'CC BY 3.0');
  assert.equal(booth.licenseLabel('cc-by'), 'CC BY');
  assert.equal(booth.licenseLabel('cc-by-sa-4.0'), 'CC BY-SA 4.0');
  assert.equal(booth.licenseLabel('cc-by-sa'), 'CC BY-SA');
  assert.equal(booth.licenseLabel('cc0'), 'CC0');
  assert.equal(booth.licenseLabel('cc0-1.0'), 'CC0');
  assert.equal(booth.licenseLabel('public-domain'), 'Public domain');
  assert.equal(booth.licenseLabel('mit'), '');
  assert.equal(booth.licenseLabel('cc0-2.0'), '');
  assert.equal(booth.licenseLabel('public-domain-1.0'), '');
  assert.equal(booth.licenseUrl('cc-by-4.0'), 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(booth.licenseUrl('cc-by-3.0'), 'https://creativecommons.org/licenses/by/3.0/');
  assert.equal(booth.licenseUrl('cc-by'), 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(booth.licenseUrl('cc-by-sa-4.0'), 'https://creativecommons.org/licenses/by-sa/4.0/');
  assert.equal(booth.licenseUrl('cc-by-sa-3.0'), 'https://creativecommons.org/licenses/by-sa/3.0/');
  assert.equal(booth.licenseUrl('cc-by-sa'), 'https://creativecommons.org/licenses/by-sa/4.0/');
  assert.equal(booth.licenseUrl('cc0'), 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.equal(booth.licenseUrl('cc0-1.0'), 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.equal(booth.licenseUrl('public-domain'), 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.equal(booth.licenseUrl('mit'), '');
  assert.equal(booth.licenseUrl(''), '');
  assert.equal(booth.arxivUrl('2309.15217'), 'https://arxiv.org/abs/2309.15217');
  assert.equal(booth.arxivUrl('cs.CL/0102034'), 'https://arxiv.org/abs/cs.CL/0102034');
  assert.equal(booth.arxivUrl('not-an-id'), '');
  assert.equal(booth.shortTitle('Ragas: Automated Evaluation'), 'Ragas');
  assert.equal(booth.formatClock(42000), '0:42');
  assert.equal(booth.formatClock(-5), '0:00');
  assert.equal(booth.formatDuration(98000), '1분 38초');
  assert.equal(booth.formatDuration(9000), '9초');
  assert.equal(booth.formatDuration(120000), '2분');
});

test('result polls use GET, and a Worker without that route falls back to POST once', async () => {
  const pending = {receipt: 'F-0042', status: 'received', course: 'quick', declaredCount: 1, published: false};
  const h = liveBooth({claims: [{status: 405, body: {error: {code: 'method_not_allowed'}}}, pending]});
  await settle();
  h.ids.get('booth-result-link').dispatchEvent({type: 'click', preventDefault() {}});
  h.ids.get('booth-claim-receipt').value = 'F-0042';
  h.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.deepEqual(h.claimCalls().map(call => call.method), ['GET', 'POST']);
  assert.equal(h.claimCalls()[0].contentType, '', 'a GET poll sends no Content-Type, so no preflight');
  assert.equal(h.step(), 'ticket');
  await h.tick();
  assert.equal(h.claimCalls().at(-1).method, 'POST', 'the fallback sticks');
  h.handle.destroy();
  const fresh = liveBooth({claims: [pending]});
  await settle();
  fresh.ids.get('booth-result-link').dispatchEvent({type: 'click', preventDefault() {}});
  fresh.ids.get('booth-claim-receipt').value = 'F-0042';
  fresh.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  fresh.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  await fresh.tick();
  assert.deepEqual(fresh.claimCalls().map(call => call.method), ['GET', 'GET']);
  assert.deepEqual(fresh.claimCalls()[1].body, {receipt: 'F-0042', claimKey: '7Q3K-M9XD'});
  fresh.handle.destroy();
});

test('a cold reload with a stored receipt resumes polling and lists receipts', async () => {
  const storage = memoryStorage();
  booth.rememberReceipt(storage, {receipt: 'F-0041', claimKey: 'AAAA-BBBB', createdAt: '2026-11-22T00:10:00Z', title: 'Older paper', pages: [3, 3, 1], outcome: 'caught'});
  booth.rememberReceipt(storage, {receipt: 'F-0042', claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:00:00Z'});
  assert.deepEqual(plain(booth.readReceipts(storage)[1].pages), [1, 3]);
  const h = liveBooth({storage, claims: [
    {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false},
    {receipt: 'F-0042', status: 'judged', course: 'quick', declaredCount: 1, published: true, outcome: 'caught', publicNote: '잡았어요'},
    {receipt: 'F-0041', status: 'judged', course: 'quick', declaredCount: 1, published: true, outcome: 'caught', publicNote: '잡았어요'},
  ]});
  await settle();
  assert.equal(h.claimCalls().length, 1);
  assert.deepEqual(h.claimCalls()[0].body, {receipt: 'F-0042', claimKey: '7Q3K-M9XD'});
  assert.equal(h.step(), 'ticket');
  assert.equal(h.text('booth-ticket-state'), 'AI가 논문을 읽는 중');
  const items = nodesOf(h.ids.get('booth-receipts-list')).filter(node => node.tagName === 'button');
  assert.deepEqual(items.map(node => node.children.map(kid => kid.textContent)), [['F-0042', '결과 보기'], ['F-0041 · Older paper', '적발']]);
  assert.equal(await h.tick(), 15000);
  assert.equal(h.text('booth-live-title'), 'AI가 찾아냈어요');
  assert.equal(booth.readReceipts(storage)[0].outcome, 'caught');
  nodesOf(h.ids.get('booth-history')).filter(node => node.tagName === 'button')[1].click();
  await settle();
  assert.deepEqual(h.claimCalls().at(-1).body, {receipt: 'F-0041', claimKey: 'AAAA-BBBB'});
  assert.equal(h.text('booth-receipt-code'), 'F-0041');
  assert.equal(h.text('booth-ticket-paper'), 'Older paper');
  assert.equal(h.text('booth-ticket-pages'), '1, 3쪽 · 1곳');
  h.handle.destroy();
  const stale = liveBooth({storage, now: Date.parse('2026-11-22T03:00:00Z'), claims: [{receipt: 'F-0042', status: 'reviewing', published: false}]});
  await settle();
  assert.equal(stale.claimCalls().length, 0);
  assert.equal(stale.step(), 'pick');
  assert.equal(stale.ids.get('booth-result').hidden, true);
  stale.handle.destroy();
  const hashed = liveBooth({storage, hash: '#booth-result', now: Date.parse('2026-11-22T03:00:00Z'), claims: [{receipt: 'F-0042', status: 'reviewing', published: false}]});
  assert.equal(hashed.ids.get('booth-result').hidden, false);
  await settle();
  assert.equal(hashed.claimCalls().length, 1);
  assert.equal(hashed.step(), 'ticket');
  assert.equal(hashed.timers.length, 1);
  hashed.handle.destroy();
});

test('the guest cap gets a friendly line and search stays a secondary path', async () => {
  const storage = memoryStorage();
  for (let i = 1; i <= 5; i += 1) booth.rememberReceipt(storage, {receipt: 'F-000' + i, claimKey: '7Q3K-M9XD', createdAt: '2026-11-21T01:00:00Z'});
  const capped = liveBooth({storage, submitStatus: 429});
  await settle();
  await submitThroughBooth(capped);
  assert.equal(capped.calls.filter(call => call.path.endsWith('/v1/booth/submissions')).length, 1);
  assert.match(capped.text('booth-submit-status'), /기회 5번을 모두 썼어요/);
  assert.equal(capped.step(), 'send');
  capped.handle.destroy();
  const fresh = liveBooth({submitStatus: 429});
  await settle();
  await submitThroughBooth(fresh);
  assert.match(fresh.text('booth-submit-status'), /지금 제출이 몰려 있어요\. 잠시 뒤 다시 눌러 주세요\./);
  assert.match(fresh.text('booth-submit-status'), /「내 기록」/);
  fresh.handle.destroy();
  const h = liveBooth();
  await settle();
  h.ids.get('booth-search-q').value = '통계';
  h.ids.get('booth-search').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  const search = h.calls.find(call => call.path.includes('/v1/papers/search'));
  assert.equal(search.auth, 'Bearer fsg_' + 'a'.repeat(43));
  assert.equal(search.path.includes('reason'), false);
  const result = nodesOf(h.ids.get('booth-search-results')).find(node => node.tagName === 'button');
  assert.equal(result.textContent, 'arXiv 2503.10497 · CC BY 4.0Synthetic resultAda · 2026도전 →');
  useWorkspace([]);
  result.click();
  await settle();
  assert.equal(h.step(), 'edit');
  assert.equal(h.text('booth-hint'), '힌트 · 숫자, 결론 문장, 표 값 중 한 곳을 골라 티 나지 않게 바꿔 보세요.');
  h.handle.destroy();
  const guest = liveBooth({token: ''});
  await settle();
  guest.ids.get('booth-search-q').value = '통계';
  guest.ids.get('booth-search').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.match(guest.text('booth-search-status'), /연결이 잠시 끊겼어요/);
  guest.handle.destroy();
});

test('a cold #booth-result load mints the guest session only for paper and submit', async () => {
  const cold = page();
  const guestCalls = [];
  const minted = 'fsg_' + 'c'.repeat(43);
  const guestFetch = async (url, init = {}) => {
    const headers = init.headers || {};
    guestCalls.push({url: String(url), method: init.method || 'GET', auth: headers.Authorization || ''});
    const path = String(url);
    if (path.endsWith('/v1/ai/guest')) {
      return {ok: true, status: 200, headers: {get() { return null; }}, json: async () => ({guest: {token: minted, expiresAt: FUTURE}})};
    }
    if (path.endsWith('/v1/booth/config')) {
      return {ok: true, status: 200, headers: {get() { return null; }}, json: async () => ({
        enabled: true, submissionsOpen: true, consentVersion: '2026-11-22.v1',
        limits: {maxPdfBytes: 16777216, maxDeclared: 3, maxReason: 500, maxNickname: 24, perOwner: 2},
        missions: [{paperId: '2503.10497', title: 'Synthetic mission', license: 'cc-by-4.0', course: 'quick'}],
      })};
    }
    if (path.includes('/v1/papers/pdf')) return pdfReply();
    const payload = path.split('?')[0].endsWith('/v1/booth/claim')
      ? {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false}
      : path.endsWith('/v1/booth/submissions')
        ? {receipt: 'F-0042', claimKey: '7Q3K-M9XD', status: 'received', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00Z'}
        : {error: {code: 'not_found'}};
    const status = path.endsWith('/v1/booth/submissions') ? 201 : payload.error ? 404 : 200;
    return {ok: status >= 200 && status < 300, status, headers: {get() { return null; }}, json: async () => payload};
  };
  const openContext = vm.createContext({
    URL, URLSearchParams, JSON, Date, Math, Number, String, Object, Error, Promise,
    sessionStorage: memoryStorage(),
    location: {hash: '#booth-result', pathname: '/event.html', search: '', href: 'https://event.example/event.html#booth-result'},
    history: {replaceState() {}},
    document: {
      documentElement: {dataset: {}},
      getElementById() { return null; },
      createElement() { return {className: '', textContent: '', setAttribute() {}, getAttribute() { return null; }}; },
      querySelectorAll() { return []; },
      addEventListener() {},
    },
    fetch: guestFetch,
    FalsifyCloudConfig: {
      apiBase: 'https://event.example', booth: {enabled: true}, openAccess: {enabled: true},
      hostedAi: {enabled: true, apiBase: 'https://event.example'},
    },
  });
  vm.runInContext(openAccessSource, openContext, {filename: 'open-access.js'});
  const coldHandle = booth.mount({
    document: cold.doc, fetch: guestFetch, storage: memoryStorage(), location: openContext.location,
    config: () => openContext.FalsifyCloudConfig,
    session: () => openContext.FalsifyHostedSession,
    setTimeout: () => 0, clearTimeout() {},
  });
  await settle();
  assert.equal(openContext.location.hash, '#booth-result');
  assert.equal(cold.ids.get('booth-result').hidden, false);
  assert.equal(cold.ids.get('booth-claim-receipt').value, '');
  assert.equal(guestCalls.some(call => call.url.endsWith('/v1/ai/guest')), false);
  assert.equal(guestCalls.some(call => String(call.url).includes('/v1/ai/capabilities')), false);
  cold.ids.get('booth-claim-receipt').value = 'F-0042';
  cold.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  cold.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(guestCalls.find(call => call.url.split('?')[0].endsWith('/v1/booth/claim')).auth, '');
  assert.equal(cold.doc.documentElement.dataset.boothStep, 'ticket');
  assert.equal(guestCalls.some(call => call.url.endsWith('/v1/ai/guest')), false);
  nodesOf(cold.ids.get('booth-receipt')).find(node => node.id === 'booth-live-again').hidden = false;
  cold.ids.get('booth-live-again').click();
  assert.equal(cold.doc.documentElement.dataset.boothStep, 'pick');
  useWorkspace([]);
  nodesOf(cold.ids.get('booth-missions')).find(node => node.tagName === 'button').click();
  await waitFor(() => guestCalls.some(call => call.url.includes('/v1/papers/pdf')));
  assert.equal(guestCalls.find(call => call.url.includes('/v1/papers/pdf')).auth, 'Bearer ' + minted);
  assert.equal(guestCalls.filter(call => call.url.endsWith('/v1/ai/guest')).length, 1);
  await waitFor(() => cold.doc.documentElement.dataset.boothStep === 'edit');
  for (let index = 0; index < 4; index += 1) boothEdits.add(makeBoothEdit({id: 'c-' + index, pageIndex: index, originalText: 'before ' + index, newText: 'after ' + index}));
  assert.match(cold.ids.get('booth-dock-status').textContent, /한 번에 3곳까지 제출할 수 있어요/);
  assert.equal(cold.ids.get('booth-next').disabled, true);
  assert.equal(cold.doc.documentElement.dataset.boothStep, 'edit');
  boothEdits.clear();
  boothEdits.add(ONE_EDIT[0]);
  cold.ids.get('booth-next').click();
  await waitFor(() => cold.doc.documentElement.dataset.boothStep === 'send');
  nodesOf(cold.ids.get('booth-rows')).find(node => node.tagName === 'button' && node.textContent === '수치·통계').click();
  nodesOf(cold.ids.get('booth-rows')).find(node => node.tagName === 'textarea').value = '유의수준을 바꿔 결론이 성립하지 않음';
  cold.ids.get('booth-submit').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(guestCalls.filter(call => call.url.endsWith('/v1/ai/guest')).length, 1);
  assert.equal(guestCalls.find(call => call.url.endsWith('/v1/booth/submissions')).auth, 'Bearer ' + minted);
  assert.equal(guestCalls.some(call => String(call.url).includes('/v1/ai/capabilities')), false);
  assert.equal(cold.doc.documentElement.dataset.boothStep, 'ticket');
  coldHandle.destroy();
});

test('each claim state maps to the visitor ticket copy', () => {
  const pending = booth.resultView({status: 'reviewing', published: false});
  assert.equal(pending.state, 'pending');
  assert.equal(pending.final, false);
  assert.equal(pending.stamp, null);
  assert.equal(pending.title, 'AI가 결함을 찾는 중이에요. 보통 1~3분 걸려요. 이 화면을 닫아도 접수번호와 확인키로 나중에 볼 수 있어요.');
  assert.equal(booth.resultView({status: 'received', published: false}).state, 'pending');
  assert.equal(booth.resultView({status: 'judged', published: false, outcome: 'missed'}).state, 'pending');
  const caught = booth.resultView({status: 'judged', published: true, outcome: 'caught', publicNote: '3쪽 표의 값을 짚었어요', prizeMessage: ' 정밀 AI는 찾았지만 선물은 유효해요 '});
  assert.deepEqual(plain(caught), {
    state: 'caught', note: '3쪽 표의 값을 짚었어요', prize: '정밀 AI는 찾았지만 선물은 유효해요', final: true,
    title: 'AI가 찾아냈어요', lead: 'AI가 ', strong: '찾아냈어요', stamp: {kind: 'fail', word: '적발', latin: 'DETECTED'},
  });
  const partial = booth.resultView({status: 'judged', published: true, outcome: 'partial', publicNote: '쪽은 맞았어요'});
  assert.equal(partial.title, 'AI가 근처를 짚었어요');
  assert.equal(partial.stamp.word, '적발');
  assert.equal(partial.prize, '');
  const missed = booth.resultView({status: 'judged', published: true, outcome: 'missed', publicNote: 'Opus 라운드로 갑니다', prizeMessage: '부스에서 스티커를 받아 가세요'});
  assert.equal(missed.title, 'AI가 못 찾았어요');
  assert.equal(missed.prize, '부스에서 스티커를 받아 가세요');
  assert.deepEqual(plain(missed.stamp), {kind: 'pass', word: '통과', latin: 'PASSED'});
  const invalid = booth.resultView({status: 'invalid', published: true, outcome: 'invalid', publicNote: '바뀐 곳이 없어요'});
  assert.equal(invalid.title, '이번 도전은 무효로 끝났어요');
  assert.equal(invalid.stamp.word, '무효');
  assert.equal(booth.resultView({status: 'invalid', published: true}).title, '이번 도전은 무효로 끝났어요');
  const judged = booth.resultView({status: 'judged', published: true, outcome: 'mystery'});
  assert.equal(judged.title, '결과가 나왔어요');
  assert.equal(judged.stamp, null);
  const withdrawn = booth.resultView({status: 'withdrawn', published: false});
  assert.equal(withdrawn.title, '제출을 철회했어요');
  assert.equal(withdrawn.final, true);
  assert.equal(booth.resultView(null).state, 'pending');
  const markup = booth.resultView({status: 'judged', published: true, outcome: 'missed', publicNote: '<img src=x onerror=alert(1)>', prizeMessage: '<b>prize</b>'});
  assert.equal(markup.note, '<img src=x onerror=alert(1)>');
  assert.equal(markup.prize, '<b>prize</b>');
  assert.equal(boothSource.includes('innerHTML'), false);
  assert.equal(boothSource.includes('insertAdjacentHTML'), false);
  const storage = memoryStorage();
  booth.rememberReceipt(storage, {receipt: 'F-0001', claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:00:00Z'});
  booth.rememberReceipt(storage, {receipt: 'F-0002', claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:01:00Z'});
  assert.equal(booth.noteReceiptOutcome(storage, 'F-0001', 'missed'), true);
  assert.equal(booth.noteReceiptOutcome(storage, 'F-0001', 'pending'), false);
  assert.deepEqual(plain(booth.readReceipts(storage).map(item => [item.receipt, item.outcome || ''])), [['F-0002', ''], ['F-0001', 'missed']]);
});

test('a cold #booth-result load keeps the hash and index routes still resolve', () => {
  function boot(hash) {
    const urls = [];
    const listeners = {};
    const nodes = new Map();
    function node(selector) {
      if (!nodes.has(selector)) nodes.set(selector, {
        textContent: '', dataset: {}, hidden: false, value: '',
        classList: {remove() {}, add() {}},
        addEventListener() {}, querySelectorAll() { return []; }, focus() {}, scrollIntoView() {}, closest() { return this; },
      });
      return nodes.get(selector);
    }
    const location = {hash};
    const history = {
      replaceState(_state, _title, url) {
        urls.push(['replace', String(url)]);
        if (String(url).startsWith('#')) location.hash = String(url);
      },
      pushState(_state, _title, url) {
        urls.push(['push', String(url)]);
        if (String(url).startsWith('#')) location.hash = String(url);
      },
    };
    vm.runInNewContext(appSource, {
      document: {querySelector: node, querySelectorAll() { return []; }, addEventListener() {}, dispatchEvent() {}},
      location, history, CustomEvent,
      matchMedia: () => ({matches: true}), clearTimeout() {}, setTimeout() {}, scrollTo() {},
      addEventListener(type, fn) { listeners[type] = fn; },
    }, {filename: 'app.js'});
    return {location, urls, listeners};
  }
  const result = boot('#booth-result');
  assert.deepEqual(result.urls, []);
  assert.equal(result.location.hash, '#booth-result');
  const boothHash = boot('#booth');
  assert.deepEqual(boothHash.urls, []);
  assert.equal(boothHash.location.hash, '#booth');
  const empty = boot('');
  assert.deepEqual(empty.urls, [['replace', '#red']]);
  assert.equal(empty.location.hash, '#red');
  const review = boot('#review');
  assert.deepEqual(review.urls, []);
  assert.equal(review.location.hash, '#review');
  review.location.hash = '#blue';
  review.listeners.hashchange();
  assert.equal(review.location.hash, '#blue');
  assert.deepEqual(review.urls, []);
  review.location.hash = '#booth-result';
  review.listeners.popstate();
  assert.equal(review.location.hash, '#booth-result');
  assert.deepEqual(review.urls, []);
});

test('the claim poll runs every 15 s for 3 min, every 30 s to 15 min, and honours Retry-After', () => {
  const delays = [];
  let elapsed = 0;
  for (;;) {
    const delay = booth.nextPollDelay(elapsed, 0);
    if (delay < 0) break;
    delays.push(delay);
    elapsed += delay;
  }
  assert.equal(delays.filter(ms => ms === 15000).length, 12);
  assert.equal(delays.slice(0, 12).every(ms => ms === 15000), true);
  assert.equal(delays.slice(12).every(ms => ms === 30000), true);
  assert.equal(elapsed, 900000);
  assert.equal(booth.nextPollDelay(900000, 0), -1);
  assert.equal(booth.nextPollDelay(30000, 45000), 45000);
  assert.equal(booth.nextPollDelay(30000, 5000), 15000);
  assert.equal(booth.nextPollDelay(200000, 0), 30000);
  assert.equal(booth.nextPollDelay(880000, 0), -1);
  assert.equal(booth.nextPollDelay(800000, 200000), -1);
  assert.equal(booth.retryAfterMs('45', 0), 45000);
  assert.equal(booth.retryAfterMs(' 7 ', 0), 7000);
  assert.equal(booth.retryAfterMs('99999', 0), 900000);
  const at = Date.parse('2026-11-22T01:00:00Z');
  assert.equal(booth.retryAfterMs('Sun, 22 Nov 2026 01:01:00 GMT', at), 60000);
  assert.equal(booth.retryAfterMs('Sun, 22 Nov 2026 00:59:00 GMT', at), 0);
  assert.equal(booth.retryAfterMs('soon', at), 0);
  assert.equal(booth.retryAfterMs(null, at), 0);
});

test('the result view lists this browser\'s newest 5 receipts', () => {
  const storage = memoryStorage();
  for (let i = 1; i <= 7; i += 1) {
    booth.rememberReceipt(storage, {receipt: 'F-' + String(i).padStart(4, '0'), claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:0' + i + ':00Z'});
  }
  const recent = booth.recentReceipts(storage);
  assert.equal(recent.length, 5);
  assert.deepEqual(plain(recent.map(item => item.receipt)), ['F-0007', 'F-0006', 'F-0005', 'F-0004', 'F-0003']);
  assert.equal(recent[0].claimKey, '7Q3K-M9XD');
  assert.equal(booth.readReceipts(storage).length, 7);
  assert.equal(booth.recentReceipts(null).length, 0);
  assert.match(booth.capMessage(5), /^기회 5번을 모두 썼어요\. /);
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

/* blind-pdf.js skips its MuPDF marker check only for bytes handed to its trust capability. */
function trustSpy() {
  const seen = [];
  const fn = bytes => { seen.push(Buffer.from(bytes)); return Promise.resolve('x'); };
  return {seen, fn};
}
test('only the bytes GET /v1/papers/pdf returned reach the blind-pdf trust capability', async () => {
  const spy = trustSpy();
  const h = liveBooth({blindTrust: spy.fn, hash: '#recipe=eyJwYXBlcklkIjoiMjUwMy4xMDQ5NyJ9'});
  await settle();
  assert.equal(spy.seen.length, 0, 'a #recipe= hash trusts nothing on its own');
  useWorkspace([]);
  await pickMission(h);
  assert.equal(h.step(), 'edit');
  assert.equal(spy.seen.length, 1);
  assert.deepEqual(spy.seen[0], SOURCE_BYTES, 'the trusted bytes are the API response bytes');
  // A visitor file in the workspace input: the booth drops the paper and trusts nothing new.
  const visitor = new File([Buffer.from('%PDF-1.7 visitor file with a training marker\n%%EOF\n')], 'arxiv-2503.10497.pdf', {type: 'application/pdf'});
  h.doc.dispatchEvent({type: 'falsify:document', detail: {file: visitor, fileHash: 'f'.repeat(64)}});
  assert.equal(h.step(), 'pick');
  assert.equal(spy.seen.length, 1);
  h.handle.destroy();
  // A recipe paperId still goes through the API: the trust follows the bytes the API sent, not the id.
  const other = Buffer.from('%PDF-1.7 synthetic search paper\n%%EOF\n');
  const h2 = liveBooth({blindTrust: spy.fn, pdfReply: () => pdfReply(other)});
  await settle();
  useWorkspace([]);
  assert.equal(await boothContext.FalsifyBoothPaper.open('2503.10499', {title: 'Recipe paper', source: 'mission'}), true);
  assert.equal(spy.seen.length, 2);
  assert.deepEqual(spy.seen[1], other);
  h2.handle.destroy();
  // A body that is not a PDF is never trusted.
  const h3 = liveBooth({blindTrust: spy.fn, pdfReply: () => pdfReply(Buffer.from('<html>not a pdf</html>'))});
  await settle();
  await pickMission(h3);
  assert.equal(h3.step(), 'pick');
  assert.equal(spy.seen.length, 2);
  h3.handle.destroy();
});

test('a resumed session from storage trusts no bytes', async () => {
  const spy = trustSpy();
  const storage = memoryStorage();
  storage.setItem('falsify.booth.receipts.v1', JSON.stringify([{receipt: 'F-0042', claimKey: '7Q3K-M9XD', title: 'Synthetic mission',
    paperId: '2503.10497', createdAt: '2026-11-22T01:00:00Z', sha256: SOURCE_SHA, trusted: true}]));
  const h = liveBooth({blindTrust: spy.fn, storage, hash: '#booth-result',
    claims: [{receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false}]});
  await settle();
  assert.ok(h.claimCalls().length >= 1, 'the stored ticket is looked up');
  assert.equal(spy.seen.length, 0);
  assert.equal(h.calls.filter(call => call.path.includes('/v1/papers/pdf')).length, 0);
  h.handle.destroy();
});

test('pointerdown on a mission starts the PDF request and the click reuses it; a scroll cancels it', async () => {
  const h = liveBooth();
  await settle();
  useWorkspace([]);
  const [first, second] = missionButtons(h);
  first.dispatchEvent({type: 'pointerdown'});
  await settle();
  const pdfCalls = () => h.calls.filter(call => call.path.includes('/v1/papers/pdf'));
  assert.equal(pdfCalls().length, 1, 'pointerdown starts the request');
  first.click();
  await settle();
  assert.equal(h.step(), 'edit');
  assert.equal(pdfCalls().length, 1, 'the click reuses the started request');
  h.ids.get('booth-edit-back').click();
  second.dispatchEvent({type: 'pointerdown'});
  await settle();
  assert.equal(pdfCalls().length, 2);
  second.dispatchEvent({type: 'pointercancel'});
  assert.equal(pdfCalls()[1].signal.aborted, true, 'a touch that became a scroll aborts the request');
  second.click();
  await settle();
  assert.equal(pdfCalls().length, 3, 'the click after a cancel fetches again');
  assert.equal(pdfCalls()[2].signal, null, 'a plain click request has nothing to abort');
  assert.equal(h.step(), 'edit');
  h.handle.destroy();
});

test('a hidden tab does not poll the claim view, and coming back polls at once', async () => {
  const pending = {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false};
  const h = liveBooth({claims: [pending]});
  await settle();
  await submitThroughBooth(h);
  assert.equal(h.step(), 'ticket');
  assert.equal(await h.tick(), 15000);
  assert.equal(h.claimCalls().length, 1);
  h.doc.visibilityState = 'hidden';
  h.doc.dispatchEvent({type: 'visibilitychange'});
  assert.equal(await h.tick(), 15000);
  assert.equal(h.claimCalls().length, 1, 'no poll while hidden');
  assert.equal(h.timers.length, 0, 'and no timer left running');
  h.clock.t += 120000;
  h.doc.visibilityState = 'visible';
  h.doc.dispatchEvent({type: 'visibilitychange'});
  await settle();
  assert.equal(h.claimCalls().length, 2, 'visible again polls at once');
  assert.equal(h.timers.length, 1, 'and polling goes on');
  h.handle.destroy();
});
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
    sessionProvider: options.sessionProvider,
    config: options.config || (() => Object.freeze({apiBase: 'https://worker.test', provider: 'confluence',
      hostedAi: Object.freeze({enabled: true, apiBase: 'https://worker.test'})})),
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
  assert.deepEqual(plain(hosted.capabilities()), {blueJobs: true, modelJobs: true});
  assert.equal(entry.$('hosted-ai-role-blue').hidden, false);
  assert.equal(entry.$('hosted-ai-run').hidden, false);
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
  assert.deepEqual(plain(hosted.capabilities()), {blueJobs: false, modelJobs: true});
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

test('modelJobs false hides the hosted model RED run and leaves apply', async () => {
  const route = router({...CAPS, modelJobs: false, blueJobs: false});
  const entry = setup({routes: route});
  await signIn(entry);
  assert.equal(entry.$('hosted-ai-run').hidden, true);
  assert.equal(entry.$('hosted-ai-role-field').hidden, true);
  assert.equal(entry.$('hosted-ai-advanced').hidden, true);
  assert.equal(entry.$('hosted-ai-prompt').hidden, true);
  assert.equal(entry.$('hosted-ai-presets').hidden, true);
  assert.equal(entry.$('hosted-ai-apply').hidden, false);
  assert.equal(entry.$('hosted-ai-booth-note').hidden, true);
  await selectFile(entry);
  entry.$('hosted-ai-prompt').value = 'Check the methods section only.';
  entry.$('hosted-ai-prompt').dispatchEvent(new Event('input'));
  entry.$('hosted-ai-run').click();
  await until(() => /모델 검토를 실행하지 않습니다/.test(entry.$('hosted-ai-error').textContent), 'model run refused');
  assert.equal(route.posts().length, 0);
});

test('the event page with modelJobs false points at the booth instead of run and apply', async () => {
  const route = router({...CAPS, modelJobs: false, blueJobs: false});
  const entry = setup({
    routes: route,
    config: () => Object.freeze({
      apiBase: 'https://worker.test', provider: 'confluence',
      booth: Object.freeze({enabled: true}),
      openAccess: Object.freeze({enabled: true}),
      hostedAi: Object.freeze({enabled: true, apiBase: 'https://worker.test'}),
    }),
    sessionProvider: () => ({token: async () => TOKEN}),
  });
  await entry.app.ready;
  await until(() => entry.$('hosted-ai-config') && entry.$('hosted-ai-config').hidden === false, 'event config opens');
  assert.equal(entry.$('hosted-ai-run').hidden, true);
  assert.equal(entry.$('hosted-ai-apply').hidden, true);
  assert.equal(entry.$('hosted-ai-booth-note').hidden, false);
  assert.match(entry.$('hosted-ai-booth-note').textContent, /AI를 실행하지 않습니다/);
  assert.match(entry.$('hosted-ai-booth-note').textContent, /부스 제출/);
  assert.match(entry.$('hosted-ai-intro').textContent, /부스 제출/);
  assert.equal(entry.$('hosted-ai-status').textContent.includes('준비됨'), false);
  entry.$('hosted-ai-run').dispatchEvent(new Event('click'));
  await until(() => /AI를 실행하지 않습니다/.test(entry.$('hosted-ai-error').textContent), 'event run refused');
  entry.$('hosted-ai-apply').dispatchEvent(new Event('click'));
  await until(() => /부스 제출/.test(entry.$('hosted-ai-error').textContent), 'event apply refused');
  assert.equal(route.posts().length, 0);
});

test('open-access intro does not promise guest BLUE when blueJobs is false', async () => {
  const source = await readFile(fileURLToPath(new URL('../dist/open-access.js', import.meta.url)), 'utf8');
  const notes = [];
  const listeners = new Map();
  function anchor(id) {
    return {
      id, children: [], nextElementSibling: null,
      after(child) { this.nextElementSibling = child; notes.push(child); },
      insertBefore(child) { this.children.unshift(child); notes.push(child); },
      querySelector(selector) {
        return selector === '[data-open-access-note]' ? this.children.find(item => item.note) : null;
      },
    };
  }
  const anchors = {'hosted-ai': anchor('hosted-ai'), 'view-blue': anchor('view-blue')};
  const document = {
    documentElement: {dataset: {}},
    getElementById: id => anchors[id] || null,
    createElement() {
      return {className: '', textContent: '', note: true, setAttribute() {}, getAttribute(name) {
        return name === 'data-open-access-note' ? '' : null;
      }};
    },
    querySelectorAll(selector) { return selector === '[data-open-access-note]' ? notes.slice() : []; },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
  };
  const context = {
    URL, URLSearchParams, JSON, Date, Math, Number, String, Object, Error, Promise,
    sessionStorage: memoryStorage(),
    location: {hash: '', pathname: '/', search: '', href: 'https://event.example/'},
    history: {replaceState() {}},
    document, fetch: async () => { throw new Error('offline'); },
    FalsifyCloudConfig: {apiBase: 'https://event.example', hostedAi: {apiBase: 'https://event.example'}, openAccess: {enabled: true}},
  };
  vm.createContext(context);
  vm.runInContext(source, context, {filename: 'open-access.js'});
  assert.equal(notes.length, 2);
  assert.match(notes[0].textContent, /BLUE 검토는 웹 실행 패널에서 로그인 없이 실행합니다/);
  document.dispatchEvent({type: 'falsify:hosted-capabilities', detail: {blueJobs: false, modelJobs: false}});
  assert.equal(notes.every(note => note.textContent.includes('BLUE 검토는 이 행사 화면에서 열리지 않습니다')), true);
  assert.equal(notes.some(note => /BLUE 검토는 웹 실행 패널에서 로그인 없이 실행합니다/.test(note.textContent)), false);
  document.dispatchEvent({type: 'falsify:hosted-capabilities', detail: {blueJobs: true, modelJobs: true}});
  assert.match(notes[0].textContent, /BLUE 검토는 웹 실행 패널에서 로그인 없이 실행합니다/);
});

test('receiptRecord validates edits, drops invalid entries, caps at 5, and cuts at 2000', () => {
  const base = {receipt: 'F-0042', claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:00:00Z'};
  // Old records without edits stay valid with no edits field.
  assert.deepEqual(plain(booth.receiptRecord(base)), base);
  const longBefore = 'a'.repeat(2100);
  const longAfter = 'b'.repeat(2100);
  const rec = booth.receiptRecord({
    ...base,
    edits: [
      null,
      'bad',
      {page: 0, before: 'x', after: 'y'},
      {page: 2001, before: 'x', after: 'y'},
      {page: 1.5, before: 'x', after: 'y'},
      {page: '1', before: 'x', after: 'y'},
      {page: 1, before: 123, after: 'y'},
      {page: 1, before: 'x', after: null},
      {page: 1, before: longBefore, after: longAfter},
      {page: 2, before: 'b2', after: 'a2'},
      {page: 3, before: 'b3', after: 'a3'},
      {page: 4, before: 'b4', after: 'a4'},
      {page: 2000, before: 'b5', after: 'a5'},
      {page: 6, before: 'b6', after: 'a6'},
    ],
  });
  assert.equal(rec.edits.length, 5);
  assert.equal(rec.edits[0].page, 1);
  assert.equal(rec.edits[0].before.length, 2000);
  assert.equal(rec.edits[0].after.length, 2000);
  assert.equal(rec.edits[0].before, 'a'.repeat(2000));
  assert.equal(rec.edits[0].after, 'b'.repeat(2000));
  assert.deepEqual(plain(rec.edits.slice(1)), [
    {page: 2, before: 'b2', after: 'a2'},
    {page: 3, before: 'b3', after: 'a3'},
    {page: 4, before: 'b4', after: 'a4'},
    {page: 2000, before: 'b5', after: 'a5'},
  ]);
  const allBad = booth.receiptRecord({...base, edits: [{page: 0, before: 'x', after: 'y'}]});
  assert.equal(Object.hasOwn(allBad, 'edits'), false);
});

test('pick sentence, edit credit line, search arXiv link and result declared block from local receipt', async () => {
  const storage = memoryStorage();
  booth.rememberReceipt(storage, {
    receipt: 'F-0042', claimKey: '7Q3K-M9XD', createdAt: '2026-11-21T01:00:00Z',
    title: 'Synthetic result', pages: [5], count: 1,
    edits: [{page: 5, before: 'Ragas 0.95 0.78 0.70', after: 'Ragas 0.50 0.78 0.70'}],
  });
  booth.rememberReceipt(storage, {
    receipt: 'F-0045', claimKey: '7Q3K-M9XD', createdAt: '2026-11-21T01:00:00Z',
  });
  const h = liveBooth({
    storage,
    claims: [
      {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false},
      {receipt: 'F-0042', status: 'judged', course: 'quick', declaredCount: 1, published: true, outcome: 'missed', publicNote: 'note'},
      {receipt: 'F-0042', status: 'judged', course: 'quick', declaredCount: 1, published: true, outcome: 'caught', publicNote: 'note'},
      {receipt: 'F-0045', status: 'judged', course: 'quick', declaredCount: 1, published: true, outcome: 'invalid', publicNote: 'note'},
      {receipt: 'F-0042', status: 'withdrawn', course: 'quick', declaredCount: 1, published: false},
      // No local record: block stays hidden even if payload contains a declared field.
      {receipt: 'F-0099', status: 'judged', course: 'quick', declaredCount: 1, published: true, outcome: 'missed', publicNote: 'note',
        declared: [{pageIndex: 4, before: '0.95', after: '0.50'}]},
    ],
  });
  await settle();
  assert.equal(
    h.text('booth-mission-credit'),
    '미션 논문은 모두 arXiv에 CC BY 4.0으로 공개된 논문이에요. 부스에서 보는 결함은 방문자가 게임을 위해 심은 거예요.',
  );
  // Mission card is a button with no nested links.
  const missionLinks = nodesOf(h.ids.get('booth-missions')).filter(node => node.tagName === 'a');
  assert.equal(missionLinks.length, 0);
  // Search results show licence label and an arXiv link outside the card button.
  h.ids.get('booth-search-q').value = '통계';
  h.ids.get('booth-search').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  const searchNodes = nodesOf(h.ids.get('booth-search-results'));
  const searchBtn = searchNodes.find(node => node.tagName === 'button');
  assert.equal(nodesOf(searchBtn).some(node => node.tagName === 'a'), false, 'no link nested inside search card button');
  const searchLinks = searchNodes.filter(node => node.tagName === 'a');
  assert.equal(searchLinks[0].getAttribute('href'), 'https://arxiv.org/abs/2503.10497');
  assert.equal(searchLinks[0].getAttribute('target'), '_blank');
  assert.equal(searchLinks[0].getAttribute('rel'), 'noopener noreferrer');
  // Opening from search renders the edit-step credit line with both links.
  useWorkspace([]);
  searchBtn.click();
  await settle();
  assert.equal(h.step(), 'edit');
  assert.equal(h.ids.get('booth-paper-credit').hidden, false);
  assert.equal(h.text('booth-paper-credit'), '원문 arXiv 2503.10497 · CC BY 4.0 · 게임용으로 고친 사본');
  const creditLinks = nodesOf(h.ids.get('booth-paper-credit')).filter(node => node.tagName === 'a');
  assert.deepEqual(creditLinks.map(a => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]), [
    ['arXiv 2503.10497', 'https://arxiv.org/abs/2503.10497', '_blank', 'noopener noreferrer'],
    ['CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', '_blank', 'noopener noreferrer'],
  ]);
  // Claim states: pending hides declared, missed & caught show stored edits, record without edits hides it, withdrawn hides it, unknown receipt hides it.
  h.ids.get('booth-claim-receipt').value = 'F-0042';
  h.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.ids.get('booth-live-declared').hidden, true, 'pending hides declared');
  await h.tick();
  assert.equal(h.ids.get('booth-live-declared').hidden, false, 'missed shows stored edits');
  assert.equal(h.text('booth-live-declared'), '내가 고친 곳5쪽Ragas 0.950.50 0.78 0.70');
  const decNodes = nodesOf(h.ids.get('booth-live-declared'));
  assert.equal(decNodes.find(node => node.tagName === 'del').textContent, '0.95');
  assert.equal(decNodes.find(node => node.tagName === 'ins').textContent, '0.50');
  // Caught shows stored edits.
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.ids.get('booth-live-declared').hidden, false, 'caught shows stored edits');
  // Stored record without edits hides block.
  h.ids.get('booth-claim-receipt').value = 'F-0045';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.ids.get('booth-live-declared').hidden, true, 'record without edits hides block');
  // Withdrawn hides block even when stored record has edits.
  h.ids.get('booth-claim-receipt').value = 'F-0042';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.ids.get('booth-live-declared').hidden, true, 'withdrawn hides declared');
  // No local record hides block even if server payload had declared (single source only).
  h.ids.get('booth-claim-receipt').value = 'F-0099';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.ids.get('booth-live-declared').hidden, true, 'no local record hides block');
  h.handle.destroy();
});

test('receipt edits keep a change near the end of a long paragraph', () => {
  const base = {receipt: 'F-0043', claimKey: '7Q3K-M9XE', createdAt: '2026-11-22T01:00:00Z'};
  const head = 'x'.repeat(630);
  const rec = booth.receiptRecord({...base, edits: [{page: 5, before: head + ' 0.95 end', after: head + ' 0.50 end'}]});
  assert.equal(rec.edits[0].before.endsWith('0.95 end'), true);
  assert.equal(rec.edits[0].after.endsWith('0.50 end'), true);
});

test('waiting project row shows while pending, hides when final or withdrawn, and swaps to QR on kiosk', async () => {
  const h = liveBooth({
    perOwner: 3,
    claims: [
      {receipt: 'F-0042', status: 'received', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00Z', published: false},
      {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00Z', published: false},
      {receipt: 'F-0042', status: 'judged', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00Z', published: true, outcome: 'missed', publicNote: 'note'},
      {receipt: 'F-0042', status: 'withdrawn', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00Z', published: false},
    ],
  });
  await settle();
  assert.equal(h.text('booth-pick-limit'), '1인 3번까지 · 이름·연락처는 받지 않아요');
  h.ids.get('booth-claim-receipt').value = 'F-0042';
  h.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  const row = h.ids.get('booth-project-wait');
  assert.equal(row.hidden, false, 'visible while queued');
  assert.equal(h.text('booth-project-copy'), '기다리는 동안 가짜연구소 Falsify 프로젝트를 둘러보세요. 마음에 들면 GitHub에서 ★를 눌러 주세요.');
  const link = h.ids.get('booth-project-link');
  assert.ok(link && link.tagName === 'a');
  assert.equal(link.textContent, 'GitHub에서 보기 ★');
  assert.equal(link.getAttribute('href'), 'https://github.com/Pseudo-Lab/Falsify');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(link.className.split(' ').includes('ink'), false, 'secondary button, not dark primary');
  assert.equal(h.ids.get('booth-project-qr'), undefined, 'non-kiosk omits QR');
  await h.tick();
  assert.equal(row.hidden, false, 'still visible while reviewing');
  await h.tick();
  assert.equal(row.hidden, true, 'hidden once final');
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(row.hidden, true, 'hidden on withdrawn');
  h.handle.destroy();

  // Kiosk mode: QR image + caption, no link.
  const prevRt = boothContext.FalsifyBoothRuntime;
  boothContext.FalsifyBoothRuntime = {kiosk: () => true};
  try {
    const k = liveBooth({
      perOwner: 3,
      claims: [{receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00Z', published: false}],
    });
    await settle();
    k.ids.get('booth-claim-receipt').value = 'F-0042';
    k.ids.get('booth-claim-key').value = '7Q3K-M9XD';
    k.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
    await settle();
    const kRow = k.ids.get('booth-project-wait');
    assert.equal(kRow.hidden, false, 'kiosk shows waiting row');
    assert.equal(nodesOf(kRow).some(node => node.tagName === 'a'), false, 'kiosk has no link');
    const qr = k.ids.get('booth-project-qr');
    assert.ok(qr && qr.tagName === 'img');
    assert.equal(qr.getAttribute('src'), 'falsify-project-qr.svg');
    assert.equal(qr.getAttribute('width'), '120');
    assert.equal(qr.getAttribute('height'), '120');
    assert.ok((qr.getAttribute('alt') || '').length > 0, 'QR has alt text');
    assert.equal(k.text('booth-project-qr-caption'), '휴대폰 카메라로 찍으면 Falsify 프로젝트가 열려요.');
    k.handle.destroy();
  } finally {
    if (prevRt === undefined) delete boothContext.FalsifyBoothRuntime;
    else boothContext.FalsifyBoothRuntime = prevRt;
  }
});

test('per-defect resultView headlines, status labels, rule line and fallback when local receipt is missing or mismatched', async () => {
  const fourAllCaught = booth.resultView({
    status: 'judged', published: true, outcome: 'caught',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught'},
      {index: 1, pageIndex: 1, verdict: 'caught'},
      {index: 2, pageIndex: 2, verdict: 'caught'},
      {index: 3, pageIndex: 5, verdict: 'caught'},
    ],
  });
  assert.equal(fourAllCaught.title, 'AI가 4개를 모두 찾아냈어요');
  assert.equal(fourAllCaught.lead, 'AI가 ');
  assert.equal(fourAllCaught.strong, '4개를 모두 찾아냈어요');
  assert.equal(fourAllCaught.stamp.kind, 'fail');

  const oneOfFourEscaped = booth.resultView({
    status: 'judged', published: true, outcome: 'missed',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught'},
      {index: 1, pageIndex: 1, verdict: 'partial'},
      {index: 2, pageIndex: 2, verdict: ''},
      {index: 3, pageIndex: 5, verdict: 'caught'},
    ],
  });
  assert.equal(oneOfFourEscaped.title, '4개 중 1개가 AI 눈을 피했어요');
  assert.equal(oneOfFourEscaped.lead, '4개 중 1개가 ');
  assert.equal(oneOfFourEscaped.strong, 'AI 눈을 피했어요');
  assert.equal(oneOfFourEscaped.stamp.kind, 'pass');
  assert.equal(oneOfFourEscaped.editResults[2].verdict, 'missed');

  const fourAllMissed = booth.resultView({
    status: 'judged', published: true, outcome: 'missed',
    editResults: [
      {index: 0, pageIndex: 0, verdict: 'missed'},
      {index: 1, pageIndex: 1, verdict: 'missed'},
      {index: 2, pageIndex: 2, verdict: 'missed'},
      {index: 3, pageIndex: 3, verdict: 'missed'},
    ],
  });
  assert.equal(fourAllMissed.title, 'AI가 4개 모두 놓쳤어요');
  assert.equal(fourAllMissed.stamp.kind, 'pass');

  const singleCaught = booth.resultView({
    status: 'judged', published: true, outcome: 'caught',
    editResults: [{index: 0, pageIndex: 4, verdict: 'caught'}],
  });
  assert.equal(singleCaught.title, 'AI가 찾아냈어요');

  const singleMissed = booth.resultView({
    status: 'judged', published: true, outcome: 'missed',
    editResults: [{index: 0, pageIndex: 4, verdict: 'missed'}],
  });
  assert.equal(singleMissed.title, 'AI가 못 찾았어요');

  const partialTwo = booth.resultView({
    status: 'judged', published: true, outcome: 'partial',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught'},
      {index: 1, pageIndex: 1, verdict: 'partial'},
    ],
  });
  assert.equal(partialTwo.title, 'AI가 근처를 짚었어요');

  const fourEdits = [
    {page: 5, before: '0.95', after: '0.50'},
    {page: 2, before: '12', after: '30'},
    {page: 3, before: '50', after: '99'},
    {page: 6, before: 'high', after: 'low'},
  ];
  const storage = memoryStorage();
  booth.rememberReceipt(storage, {receipt: 'F-0101', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00Z', title: 'Ragas', pages: [2, 3, 5, 6], count: 4, edits: fourEdits});
  booth.rememberReceipt(storage, {receipt: 'F-0102', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00Z', title: 'Ragas', pages: [5], count: 1, edits: [fourEdits[0]]});
  booth.rememberReceipt(storage, {receipt: 'F-0103', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00Z', title: 'Ragas', pages: [5], count: 2, edits: fourEdits.slice(0, 2)});

  const h = liveBooth({
    storage,
    claims: [
      {
        receipt: 'F-0101', status: 'judged', course: 'quick', declaredCount: 4, createdAt: '2026-11-22T01:00:00Z',
        published: true, outcome: 'missed', prizeMessage: 'PRIZE',
        editResults: [
          {index: 0, pageIndex: 4, verdict: 'caught'},
          {index: 1, pageIndex: 1, verdict: 'partial'},
          {index: 2, pageIndex: 2, verdict: 'missed'},
          {index: 3, pageIndex: 5, verdict: 'caught'},
        ],
      },
      {
        receipt: 'F-0102', status: 'judged', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00Z',
        published: true, outcome: 'caught',
        editResults: [{index: 0, pageIndex: 4, verdict: 'caught'}],
      },
      {
        receipt: 'F-0103', status: 'judged', course: 'quick', declaredCount: 4, createdAt: '2026-11-22T01:00:00Z',
        published: true, outcome: 'caught',
        editResults: [
          {index: 0, pageIndex: 4, verdict: 'caught'},
          {index: 1, pageIndex: 1, verdict: 'caught'},
          {index: 2, pageIndex: 2, verdict: 'caught'},
          {index: 3, pageIndex: 5, verdict: 'caught'},
        ],
      },
      {
        receipt: 'F-0199', status: 'judged', course: 'quick', declaredCount: 4, createdAt: '2026-11-22T01:00:00Z',
        published: true, outcome: 'caught',
        editResults: [
          {index: 0, pageIndex: 4, verdict: 'caught'},
          {index: 1, pageIndex: 1, verdict: 'caught'},
          {index: 2, pageIndex: 2, verdict: 'caught'},
          {index: 3, pageIndex: 5, verdict: 'caught'},
        ],
      },
    ],
  });
  await settle();
  // Send screen has the rule line near the submit button.
  assert.equal(h.text('booth-send-rule'), '심은 결함 중 하나라도 AI가 놓치면 성공이에요.');

  // 4 edits, 1 missed -> count headline, rule line, and 4 matched status labels with aria-label.
  h.ids.get('booth-claim-receipt').value = 'F-0101';
  h.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.text('booth-live-title'), '4개 중 1개가 AI 눈을 피했어요');
  assert.equal(h.ids.get('booth-live-rule').hidden, false);
  assert.equal(h.text('booth-live-rule'), '심은 결함 중 하나라도 AI가 놓치면 성공이에요.');
  const badges = nodesOf(h.ids.get('booth-live-declared')).filter(node => String(node.className || '').startsWith('booth-edit-verdict'));
  assert.deepEqual(badges.map(node => [node.textContent, node.getAttribute('aria-label'), node.className]), [
    ['AI가 찾음', 'AI가 찾음', 'booth-edit-verdict caught'],
    ['근처를 짚음', '근처를 짚음', 'booth-edit-verdict partial'],
    ['AI가 놓침', 'AI가 놓침', 'booth-edit-verdict missed'],
    ['AI가 찾음', 'AI가 찾음', 'booth-edit-verdict caught'],
  ]);

  // 1 edit caught -> keeps single-defect wording, shows 1 status label.
  h.ids.get('booth-claim-receipt').value = 'F-0102';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.text('booth-live-title'), 'AI가 찾아냈어요');
  const singleBadges = nodesOf(h.ids.get('booth-live-declared')).filter(node => String(node.className || '').startsWith('booth-edit-verdict'));
  assert.deepEqual(singleBadges.map(node => node.textContent), ['AI가 찾음']);

  // Mismatched count (2 local edits vs 4 editResults) -> keeps count headline, shows no status labels.
  h.ids.get('booth-claim-receipt').value = 'F-0103';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.text('booth-live-title'), 'AI가 4개를 모두 찾아냈어요');
  assert.equal(h.ids.get('booth-live-declared').hidden, false);
  const mismatchBadges = nodesOf(h.ids.get('booth-live-declared')).filter(node => String(node.className || '').startsWith('booth-edit-verdict'));
  assert.equal(mismatchBadges.length, 0);

  // Missing local receipt -> keeps count headline, hides declared list.
  h.ids.get('booth-claim-receipt').value = 'F-0199';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.text('booth-live-title'), 'AI가 4개를 모두 찾아냈어요');
  assert.equal(h.ids.get('booth-live-declared').hidden, true);
  h.handle.destroy();
});

test('per-defect results drive nothing on an invalid outcome, a short list or duplicate indices', () => {
  const four = [
    {index: 0, pageIndex: 4, verdict: 'caught'},
    {index: 1, pageIndex: 1, verdict: 'missed'},
    {index: 2, pageIndex: 2, verdict: 'caught'},
    {index: 3, pageIndex: 5, verdict: 'caught'},
  ];
  const invalid = booth.resultView({status: 'invalid', published: true, outcome: 'invalid', declaredCount: 4, editResults: four});
  assert.equal(invalid.editResults, undefined);
  const short = booth.resultView({status: 'judged', published: true, outcome: 'caught', declaredCount: 4, editResults: four.slice(0, 2)});
  assert.equal(short.editResults, undefined);
  assert.equal(short.title, booth.resultView({status: 'judged', published: true, outcome: 'caught'}).title);
  const dup = booth.resultView({status: 'judged', published: true, outcome: 'caught', editResults: [four[0], four[0]]});
  assert.equal(dup.editResults.length, 1);
  const whole = booth.resultView({status: 'judged', published: true, outcome: 'missed', declaredCount: 4, editResults: four});
  assert.equal(whole.title, '4개 중 1개가 AI 눈을 피했어요');
});
