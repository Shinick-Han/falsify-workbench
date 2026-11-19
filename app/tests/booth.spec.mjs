'use strict';
// Booth panel pure helpers and the hosted-ai hooks they depend on.
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
const boothSource = await readFile(fileURLToPath(new URL('../dist/booth.js', import.meta.url)), 'utf8');
const appSource = await readFile(fileURLToPath(new URL('../dist/app.js', import.meta.url)), 'utf8');
const openAccessSource = await readFile(fileURLToPath(new URL('../dist/open-access.js', import.meta.url)), 'utf8');
const boothContext = vm.createContext({console, URL, URLSearchParams, Event, File, FormData, crypto, DataTransfer: BoothTransfer});
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

test('submission bodies use only contract keys and reject nickname PII', () => {
  assert.deepEqual(plain(booth.buildSubmission({nickname: 'visitor@example.com'})), {ok: false, code: 'pii_not_allowed'});
  assert.deepEqual(plain(booth.buildSubmission({nickname: '01012345678'})), {ok: false, code: 'pii_not_allowed'});
  assert.equal(booth.buildSubmission({nickname: 'line\nname'}).code, 'invalid_request');
  const built = booth.buildSubmission({
    jobId: JOB_ID, course: 'quick', consent: true, consentVersion: '2026-11-22.v1',
    nickname: '부스방문자', editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2503.10497', title: 'Synthetic title', license: 'cc-by-4.0', course: 'quick', sourceSha256: SHA},
    rows: [{
      pageIndex: 3, segmentId: 'p4-s2', before: 'p < 0.05', after: 'p < 0.5',
      defectType: 'number', reason: '유의수준을 바꿔 결론이 성립하지 않음', rationale: RATIONALE,
    }],
  });
  assert.equal(built.ok, true);
  assert.equal(Object.hasOwn(built.body, 'jobId'), false);
  assert.deepEqual(Object.keys(built.body), ['course', 'declared', 'paper', 'nickname', 'consentVersion', 'editedSha256']);
  assert.deepEqual(Object.keys(built.body.declared[0]), ['pageIndex', 'segmentId', 'before', 'after', 'defectType', 'reason']);
  assert.deepEqual(Object.keys(built.body.paper), ['source', 'id', 'title', 'license', 'sourceSha256']);
  assert.equal(built.body.editedSha256, EDITED_SHA);
  assert.equal(built.body.paper.sourceSha256, SHA);
  assert.equal(JSON.stringify(built.body).includes(RATIONALE), false);
  assert.equal(JSON.stringify(built.body).includes('quick'), true);
  assert.equal(built.body.consentVersion, '2026-11-22.v1');
  const tabbed = booth.buildSubmission({
    course: 'quick', consent: true, editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2309.15217', title: 'Synthetic title', license: 'cc-by-4.0'},
    rows: [{pageIndex: 4, segmentId: 'paragraph:4:p4', before: '0.95\t0.78', after: '0.50\t0.78', defectType: 'number', reason: '표의 점수'}],
  });
  assert.equal(tabbed.ok, true);
  assert.equal(tabbed.body.declared[0].before, '0.95\t0.78');
  assert.equal(booth.buildSubmission({
    course: 'quick', consent: true, editedSha256: EDITED_SHA,
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
    course: 'deep', consent: true, editedSha256: EDITED_SHA,
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}],
  });
  assert.deepEqual(plain(bare), {ok: false, code: 'paper_not_allowed'});
  assert.equal(booth.buildSubmission({
    course: 'quick', consent: true, editedSha256: EDITED_SHA,
    paper: {source: 'upload', id: 'local', title: 'Uploaded', license: 'cc-by'},
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}],
  }).code, 'paper_not_allowed');
  assert.equal(booth.buildSubmission({course: 'quick', consent: false, editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0'},
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}]}).code, 'invalid_request');
  assert.equal(booth.buildSubmission({course: 'quick', consent: true,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0', sourceSha256: SHA},
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}]}).code, 'invalid_request');
  assert.equal(booth.buildSubmission({course: 'quick', consent: true, editedSha256: SHA,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0', sourceSha256: SHA},
    rows: [{pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: '이유'}]}).code, 'pdf_unchanged');
  const six = Array.from({length: 6}, (_, index) => ({
    pageIndex: index, before: 'before ' + index, after: 'after', defectType: 'other', reason: '이유',
  }));
  assert.equal(booth.buildSubmission({
    course: 'quick', consent: true, editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0'},
    rows: six,
  }).code, 'invalid_request');
  const eight = Array.from({length: 8}, (_, index) => ({
    pageIndex: index, before: 'before ' + index, after: 'after', defectType: 'other', reason: '이유',
  }));
  assert.equal(booth.buildSubmission({
    course: 'quick', consent: true, editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0'},
    limits: {maxDeclared: 8, maxPdfBytes: 16777216, perOwner: 2},
    rows: eight,
  }).ok, true);
  assert.equal(booth.buildSubmission({
    course: 'quick', consent: true, editedSha256: EDITED_SHA,
    paper: {source: 'arxiv', id: '2503.10497', license: 'cc-by-4.0'},
    limits: {maxDeclared: 8},
    rows: eight.concat([{pageIndex: 8, before: 'before 8', after: 'after', defectType: 'other', reason: '이유'}]),
  }).code, 'invalid_request');
  assert.equal(booth.CONSENT_COPY['2026-11-22.v1'], '제출한 수정본 PDF와 결함 설명(쪽·유형·이유)은 가짜연구소 Falsify 스터디가 저장하고 운영자가 읽습니다. 마감 후 AI 검증에는 수정본 PDF만 모델 제공자(Anthropic 또는 OpenAI)에 보내며, 결함 설명은 AI에 보내지 않습니다. 이름·연락처는 받지 않으니 이유란에도 적지 마세요. 원 논문은 미션이나 검색에서 고른 공개 논문(CC BY·CC BY-SA·CC0)이며, 수정본을 스터디 밖에 공개할 때는 저자·arXiv 번호·라이선스와 수정 사실을 밝히고, CC BY-SA 논문의 수정본은 같은 라이선스로 공개합니다. 결과와 경품 안내는 접수번호와 확인키로만 확인할 수 있습니다. 확인키로 언제든 철회할 수 있습니다. 철회하면 서버의 수정본 PDF·설명·결과를 바로 지우고, 운영자 보관본은 다음 동기화 때 지웁니다. 이미 AI 검증에 보낸 사본은 모델 제공자에게서 회수할 수 없고, 웹 실행 서버 사본은 7일, 데이터베이스 백업은 최대 30일 뒤에 사라집니다. 보관 자료는 스터디 종료 후 삭제합니다.');
  assert.equal(booth.CONSENT_COPY['2026-11-22.v1'].includes('2026-11-22.v1'), false);
});

test('the R4-2 interop vector is the edited.pdf part', async () => {
  const interop = Buffer.from('%PDF-1.7\n% falsify booth interop fixture\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  const interopSha = '241e9c74200e288d5bc4b11ef565745b1c5495930790689240bb7168ad111019';
  assert.equal(interop.length, 109);
  assert.equal(createHash('sha256').update(interop).digest('hex'), interopSha);
  const built = booth.buildSubmission({
    course: 'quick', consent: true, editedSha256: interopSha,
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
  assert.equal(booth.errorMessage('storage_full'), '오늘 접수 저장 공간이 가득 찼습니다. 부스 운영자에게 알려 주세요.');
  assert.match(booth.errorMessage('length_required'), /너무 크/);
  assert.match(booth.errorMessage('payload_too_large'), /너무 커서/);
  assert.equal(booth.errorMessage('payload_too_large', {maxPdfBytes: 16777216}), '수정본 PDF는 16MB 이하만 제출할 수 있습니다.');
  assert.equal(booth.errorMessage('length_required', {maxPdfBytes: 16777216}), '수정본 PDF는 16MB 이하만 제출할 수 있습니다.');
  assert.match(booth.errorMessage('model_jobs_operator_only'), /AI 검증을 실행하지 않습니다/);
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
    booth_closed: '접수를 받지 않습니다',
    consent_outdated: '동의 문구',
    job_not_ready: '수정본이 아직',
    already_submitted: '이미 제출된',
    pii_not_allowed: '별명',
    rate_limited: '너무 많습니다',
    license_not_allowed: '라이선스',
    payload_too_large: '너무 커서',
    length_required: '너무 크',
    storage_full: '저장 공간이 가득',
    model_jobs_operator_only: 'AI 검증',
    not_found: '확인키',
    paper_not_allowed: '라이선스',
    invalid_pdf: 'PDF 파일을 다시',
    pdf_mismatch: '해시가 일치하지',
    pdf_unchanged: '원본과 같습니다',
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

test('the event panel submits contract fields and keeps claim and search auth apart', async () => {
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
    const form = init.body && typeof init.body.get === 'function' ? init.body : null;
    calls.push({
      url: String(url), method: init.method || 'GET', auth: headers.Authorization || '',
      contentType: headers['Content-Type'] || '',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      form,
    });
    const path = String(url);
    if (path.endsWith('/v1/booth/submissions') && sizeReject) {
      return {ok: false, status: 413, headers: {get() { return null; }}, json: async () => ({error: {code: 'payload_too_large'}})};
    }
    const payload = path.endsWith('/v1/booth/config')
      ? {enabled: true, submissionsOpen: true, announcement: '행사 안내', consentVersion: '2026-11-22.v1',
        limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216},
        missions: [
          {paperId: '2503.10497', title: 'Synthetic mission', license: 'cc-by-4.0', course: 'quick', hint: '8쪽 표를 고치세요', pageHint: 8},
          {paperId: '2503.10498', title: 'Plain mission', pageHint: '8'},
        ]}
      : path.endsWith('/v1/booth/submissions')
        ? {receipt: 'F-0042', claimKey: '7Q3K-M9XD', status: 'received', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00Z'}
        : path.endsWith('/v1/booth/claim')
          ? {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false}
          : path.endsWith('/v1/booth/withdraw')
            ? {receipt: 'F-0042', status: 'withdrawn', course: 'quick', declaredCount: 1, published: false}
            : path.includes('/v1/papers/search')
              ? {source: 'arxiv', page: 1, hasMore: false, results: [{id: '2503.10497', title: 'Synthetic result', authors: ['Ada'], year: 2026, license: 'cc-by-4.0'}]}
              : path.includes('/v1/papers/pdf')
                ? null
                : {error: {code: 'not_found'}};
    if (payload === null) {
      const bytes = Buffer.from('%PDF-1.7 synthetic booth paper\n%%EOF\n');
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
    const status = path.endsWith('/v1/booth/submissions') ? 201 : payload.error ? 404 : 200;
    return {ok: status >= 200 && status < 300, status, headers: {get() { return null; }}, json: async () => payload};
  };
  let sizeReject = false;
  const location = {hash: ''};
  const handle = booth.mount({
    document: doc, fetch: fetchImpl, storage, location,
    config: () => ({booth: {enabled: true}, apiBase: 'https://event.example', hostedAi: {apiBase: 'https://event.example'}}),
    session: () => ({token: async () => sessionToken}),
  });
  assert.equal(content.children[0].id, 'booth');
  assert.equal(ids.get('booth-search').hidden, true);
  assert.match(ids.get('booth-consent-copy').textContent, /철회하면 서버의 수정본 PDF·설명·결과를 바로 지우고/);
  assert.match(ids.get('booth-consent-copy').textContent, /CC BY-SA 논문의 수정본은 같은 라이선스로 공개합니다/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls[0].auth, '');
  assert.equal(calls[0].url.endsWith('/v1/booth/config'), true);
  assert.equal(ids.get('booth').hidden, false);
  assert.equal(ids.get('booth-search').hidden, false);
  assert.match(ids.get('booth-announce').textContent, /행사 안내/);
  assert.match(ids.get('booth-missions').textContent, /Synthetic mission/);
  assert.match(ids.get('booth-missions').textContent, /8쪽 표를 고치세요/);
  const controls = [];
  const walk = node => {
    controls.push(node);
    for (const kid of node.children) if (kid && typeof kid === 'object') walk(kid);
  };
  ids.get('booth-make').click();
  assert.match(ids.get('booth-submit-status').textContent, /미션이나 검색에서 논문을 골라 시작해 주세요/);
  assert.equal(calls.some(call => call.url.endsWith('/v1/booth/submissions')), false);
  walk(ids.get('booth-missions'));
  const pageButtons = controls.filter(node => node.tagName === 'button' && /쪽으로 가기/.test(node.textContent || ''));
  assert.equal(pageButtons.length, 1);
  assert.equal(pageButtons[0].textContent, '8쪽으로 가기');
  const startPaper = controls.find(node => node.tagName === 'button' && /이 논문으로 시작/.test(node.textContent));
  assert.ok(startPaper);
  ids.get('paper-file').addEventListener('change', () => {
    const file = ids.get('paper-file').files && ids.get('paper-file').files[0];
    doc.dispatchEvent({type: 'falsify:document-clear'});
    doc.dispatchEvent({type: 'falsify:document', detail: {file, fileHash: 'not-the-opened-pdf'}});
  });
  startPaper.dispatchEvent({type: 'click'});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(ids.get('booth-search-status').textContent, /논문을 열었습니다/);
  assert.equal(ids.get('booth-submit').hidden, false);
  doc.dispatchEvent({type: 'falsify:document-clear'});
  assert.equal(ids.get('booth-submit').hidden, true);
  startPaper.dispatchEvent({type: 'click'});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ids.get('booth-submit').hidden, false);
  const sourceBytes = Buffer.from('%PDF-1.7 synthetic booth paper\n%%EOF\n');
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const edited = new File([EDITED], 'visitor-notes.txt', {type: 'text/plain'});
  const sourceFile = new File([sourceBytes], 'source.pdf', {type: 'application/pdf'});
  let workspaceEdits = [{enabled: true, pageIndex: 1, segmentId: 'p2-b1', before: BEFORE, after: AFTER}];
  const hintedPages = [];
  boothContext.FalsifyPaperWorkspace = {
    getSource: () => ({fileHash: 'not-sha256', file: sourceFile}),
    getEditSnapshot: () => ({revision: 3, edits: workspaceEdits}),
    getCurrentOutput: () => null,
    showPage(n) { hintedPages.push(n); return true; },
  };
  pageButtons[0].dispatchEvent({type: 'click'});
  assert.deepEqual(hintedPages, [8]);
  let generateClicks = 0;
  ids.get('paper-generate').addEventListener('click', () => { generateClicks += 1; });
  ids.get('booth-make').click();
  assert.equal(generateClicks, 1);
  assert.match(ids.get('booth-submit-status').textContent, /수정본 PDF를 만들고 있습니다/);
  doc.dispatchEvent({type: 'falsify:paper-generated', detail: {
    file: edited, revision: 3,
    edits: [{pageIndex: 1, segmentId: 'p2-b1', before: BEFORE, after: AFTER, rationale: RATIONALE}],
  }});
  await waitFor(() => /변경 전/.test(ids.get('booth-rows').textContent));
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
  assert.equal(posted.contentType, '');
  assert.deepEqual([...posted.form.keys()], ['meta', 'pdf']);
  const meta = JSON.parse(posted.form.get('meta'));
  assert.equal(Object.hasOwn(meta, 'jobId'), false);
  assert.deepEqual(Object.keys(meta), ['course', 'declared', 'paper', 'nickname', 'consentVersion', 'editedSha256']);
  assert.equal(meta.editedSha256, EDITED_SHA);
  assert.deepEqual(meta.paper, {
    source: 'mission', id: '2503.10497', title: 'Synthetic mission', license: 'cc-by-4.0', sourceSha256: sourceHash,
  });
  assert.equal(posted.form.get('pdf').name, 'edited.pdf');
  assert.equal(posted.form.get('pdf').type, 'application/pdf');
  assert.equal(posted.form.get('pdf').size, EDITED.length);
  sizeReject = true;
  ids.get('booth-submit-button').disabled = false;
  ids.get('booth-submit').dispatchEvent({type: 'submit', preventDefault() {}});
  await waitFor(() => /16MB/.test(ids.get('booth-submit-status').textContent));
  assert.equal(ids.get('booth-submit-status').textContent, '수정본 PDF는 16MB 이하만 제출할 수 있습니다.');
  sizeReject = false;
  workspaceEdits = Array.from({length: 6}, (_, index) => ({
    enabled: true, pageIndex: index, segmentId: 's' + index, before: 'before ' + index, after: 'after ' + index,
  }));
  doc.dispatchEvent({type: 'falsify:paper-generated', detail: {file: edited, sourceFileHash: sourceHash, revision: 4, edits: workspaceEdits}});
  await waitFor(() => /켠 편집이 6건입니다/.test(ids.get('booth-submit-status').textContent));
  assert.match(ids.get('booth-submit-status').textContent, /켠 편집이 6건입니다/);
  assert.match(ids.get('booth-submit-status').textContent, /5건 이하로 남겨 주세요/);
  assert.equal(ids.get('booth-submit-button').disabled, true);
  assert.equal(ids.get('booth-rows').textContent, '');
  ids.get('booth-submit').dispatchEvent({type: 'submit', preventDefault() {}});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.filter(call => call.url.endsWith('/v1/booth/submissions')).length, 2);
  doc.dispatchEvent({type: 'falsify:paper-generated', detail: {
    file: new File(['not a pdf'], 'note.txt', {type: 'text/plain'}), sourceFileHash: sourceHash, revision: 5, edits: workspaceEdits.slice(0, 1),
  }});
  await waitFor(() => /PDF 파일을 다시 만들어 주세요/.test(ids.get('booth-submit-status').textContent));
  assert.match(ids.get('booth-submit-status').textContent, /PDF 파일을 다시 만들어 주세요/);
  doc.dispatchEvent({type: 'falsify:document', detail: {file: {name: 'other.pdf'}}});
  ids.get('booth-submit').dispatchEvent({type: 'submit', preventDefault() {}});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(ids.get('booth-submit-status').textContent, /미션이나 검색에서 논문을 골라 시작해 주세요/);
  assert.equal(calls.filter(call => call.url.endsWith('/v1/booth/submissions')).length, 2);
  assert.deepEqual(Object.keys(meta.declared[0]), ['pageIndex', 'segmentId', 'before', 'after', 'defectType', 'reason']);
  assert.equal(JSON.stringify(meta).includes(RATIONALE), false);
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

  const cold = page();
  const coldStorage = memoryStorage();
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
    if (path.includes('/v1/papers/pdf')) {
      return {
        ok: true, status: 200,
        headers: {get(name) {
          if (name === 'X-Falsify-Paper-License') return 'cc-by-4.0';
          if (name === 'Content-Disposition') return 'attachment; filename="arxiv-2503.10497.pdf"';
          return null;
        }},
        arrayBuffer: async () => sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength),
        json: async () => ({}),
      };
    }
    const payload = path.endsWith('/v1/booth/claim')
      ? {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false}
      : path.endsWith('/v1/booth/withdraw')
        ? {receipt: 'F-0042', status: 'withdrawn', course: 'quick', declaredCount: 1, published: false}
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
    document: cold.doc, fetch: guestFetch, storage: coldStorage, location: openContext.location,
    config: () => openContext.FalsifyCloudConfig,
    session: () => openContext.FalsifyHostedSession,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(openContext.location.hash, '#booth-result');
  assert.equal(cold.ids.get('booth-result').hidden, false);
  assert.equal(cold.ids.get('booth-claim-receipt').value, '');
  assert.equal(cold.ids.get('booth-claim-key').value, '');
  assert.equal(guestCalls.some(call => call.url.endsWith('/v1/ai/guest')), false);
  assert.equal(guestCalls.some(call => String(call.url).includes('/v1/ai/capabilities')), false);
  cold.ids.get('booth-claim-receipt').value = 'F-0042';
  cold.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  cold.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(guestCalls.find(call => call.url.endsWith('/v1/booth/claim')).auth, '');
  assert.match(cold.ids.get('booth-result-status').textContent, /검토 중/);
  cold.ids.get('booth-withdraw').dispatchEvent({type: 'click'});
  cold.ids.get('booth-withdraw-confirm').dispatchEvent({type: 'click'});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(guestCalls.find(call => call.url.endsWith('/v1/booth/withdraw')).auth, '');
  assert.match(cold.ids.get('booth-result-status').textContent, /철회됨/);
  assert.equal(guestCalls.some(call => call.url.endsWith('/v1/ai/guest')), false);
  const missionNodes = [];
  const walkMission = node => {
    missionNodes.push(node);
    for (const kid of node.children) if (kid && typeof kid === 'object') walkMission(kid);
  };
  walkMission(cold.ids.get('booth-missions'));
  missionNodes.find(node => node.tagName === 'button' && /이 논문으로 시작/.test(node.textContent)).dispatchEvent({type: 'click'});
  await waitFor(() => guestCalls.some(call => call.url.endsWith('/v1/ai/guest')));
  await waitFor(() => guestCalls.some(call => call.url.includes('/v1/papers/pdf')));
  assert.equal(guestCalls.find(call => call.url.includes('/v1/papers/pdf')).auth, 'Bearer ' + minted);
  assert.equal(guestCalls.filter(call => call.url.endsWith('/v1/ai/guest')).length, 1);
  boothContext.FalsifyPaperWorkspace = {
    getSource: () => ({fileHash: sourceHash, file: sourceFile}),
    getEditSnapshot: () => ({revision: 9, edits: Array.from({length: 4}, (_, index) => ({
      enabled: true, pageIndex: index, segmentId: 's' + index, before: 'before ' + index, after: 'after ' + index,
    }))}),
    getCurrentOutput: () => null,
  };
  cold.ids.get('booth-make').click();
  cold.doc.dispatchEvent({type: 'falsify:paper-generated', detail: {file: edited, sourceFileHash: sourceHash, revision: 9, edits: []}});
  await waitFor(() => /3건 이하로 남겨 주세요/.test(cold.ids.get('booth-submit-status').textContent));
  assert.equal(guestCalls.some(call => call.url.endsWith('/v1/booth/submissions')), false);
  boothContext.FalsifyPaperWorkspace = {
    getSource: () => ({fileHash: sourceHash, file: sourceFile}),
    getEditSnapshot: () => ({revision: 10, edits: [{enabled: true, pageIndex: 1, segmentId: 'p2', before: BEFORE, after: AFTER}]}),
    getCurrentOutput: () => null,
  };
  cold.ids.get('booth-make').click();
  cold.doc.dispatchEvent({type: 'falsify:paper-generated', detail: {
    file: edited, sourceFileHash: sourceHash, revision: 10,
    edits: [{pageIndex: 1, segmentId: 'p2', before: BEFORE, after: AFTER}],
  }});
  await waitFor(() => /변경 전/.test(cold.ids.get('booth-rows').textContent));
  const coldNodes = [];
  const walkCold = node => {
    coldNodes.push(node);
    for (const kid of node.children) if (kid && typeof kid === 'object') walkCold(kid);
  };
  walkCold(cold.ids.get('booth-rows'));
  const coldSelect = coldNodes.find(node => node.tagName === 'select');
  const coldReason = coldNodes.find(node => node.tagName === 'textarea');
  coldSelect.value = 'number';
  coldReason.value = '유의수준을 바꿔 결론이 성립하지 않음';
  cold.ids.get('booth-consent').checked = true;
  cold.ids.get('booth-consent').dispatchEvent({type: 'change'});
  cold.ids.get('booth-submit').dispatchEvent({type: 'submit', preventDefault() {}});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(guestCalls.filter(call => call.url.endsWith('/v1/ai/guest')).length, 1);
  assert.equal(guestCalls.find(call => call.url.endsWith('/v1/booth/submissions')).auth, 'Bearer ' + minted);
  assert.equal(guestCalls.some(call => String(call.url).includes('/v1/ai/capabilities')), false);
  coldHandle.destroy();
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

test('each claim state maps to the visitor card copy', () => {
  const pending = booth.resultView({status: 'reviewing', published: false});
  assert.equal(pending.state, 'pending');
  assert.equal(pending.final, false);
  assert.equal(pending.title, 'AI가 결함을 찾는 중이에요. 보통 1~3분 걸려요. 이 화면을 닫아도 접수번호와 확인키로 나중에 볼 수 있어요.');
  assert.equal(booth.resultView({status: 'received', published: false}).state, 'pending');
  assert.equal(booth.resultView({status: 'judged', published: false, outcome: 'missed'}).state, 'pending');
  const caught = booth.resultView({status: 'judged', published: true, outcome: 'caught', publicNote: '3쪽 표의 값을 짚었어요', prizeMessage: 'ignored'});
  assert.deepEqual(plain(caught), {state: 'caught', title: 'AI가 찾아냈어요', note: '3쪽 표의 값을 짚었어요', prize: '', final: true});
  const partial = booth.resultView({status: 'judged', published: true, outcome: 'partial', publicNote: '쪽은 맞았어요'});
  assert.equal(partial.title, 'AI가 거의 찾았어요');
  assert.equal(partial.note, '쪽은 맞았어요');
  const missed = booth.resultView({status: 'judged', published: true, outcome: 'missed', publicNote: 'Opus 라운드로 갑니다', prizeMessage: '부스에서 스티커를 받아 가세요'});
  assert.deepEqual(plain(missed), {state: 'missed', title: 'AI가 못 찾았어요!', note: 'Opus 라운드로 갑니다', prize: '부스에서 스티커를 받아 가세요', final: true});
  const invalid = booth.resultView({status: 'invalid', published: true, outcome: 'invalid', publicNote: '바뀐 곳이 없어요'});
  assert.equal(invalid.title, '결함으로 인정되지 않았어요');
  assert.equal(booth.resultView({status: 'invalid', published: true}).title, '결함으로 인정되지 않았어요');
  const withdrawn = booth.resultView({status: 'withdrawn', published: false});
  assert.equal(withdrawn.title, '철회됨');
  assert.equal(withdrawn.final, true);
  assert.equal(booth.resultView(null).state, 'pending');
  const markup = booth.resultView({status: 'judged', published: true, outcome: 'missed', publicNote: '<img src=x onerror=alert(1)>', prizeMessage: '<b>prize</b>'});
  assert.equal(markup.note, '<img src=x onerror=alert(1)>');
  assert.equal(markup.prize, '<b>prize</b>');
  assert.equal(boothSource.includes('innerHTML'), false);
  assert.equal(boothSource.includes('insertAdjacentHTML'), false);
});

test('consent copy is a map keyed by version and an unknown version has no text', () => {
  assert.deepEqual(Object.keys(booth.CONSENT_COPY), ['2026-11-22.v1', '2026-11-22.v2']);
  assert.equal(booth.consentCopyFor('2026-11-22.v1'), booth.CONSENT_COPY['2026-11-22.v1']);
  assert.equal(booth.consentCopyFor('2026-11-22.v2'), '제출한 수정본 PDF와 결함 설명(쪽·유형·이유)은 가짜연구소 Falsify 스터디가 저장하고 운영자가 읽습니다. 제출하면 바로 수정본 PDF만 AI 검증을 위해 모델 제공자(Anthropic)에 보내고, 마감 후 한 번 더 보낼 수 있습니다. 결함 설명은 AI에 보내지 않습니다. 이름·연락처는 받지 않으니 이유란에도 적지 마세요. 원 논문은 미션이나 검색에서 고른 공개 논문(CC BY·CC BY-SA·CC0)이며, 수정본을 스터디 밖에 공개할 때는 저자·arXiv 번호·라이선스와 수정 사실을 밝히고, CC BY-SA 논문의 수정본은 같은 라이선스로 공개합니다. AI 결과와 경품 안내는 접수번호와 확인키로만 확인할 수 있습니다. 확인키로 언제든 철회할 수 있습니다. 철회하면 서버의 수정본 PDF·설명·결과를 바로 지우고, 운영자 보관본은 다음 동기화 때 지웁니다. 이미 AI 검증에 보낸 사본은 모델 제공자에게서 회수할 수 없고, 웹 실행 서버 사본은 7일, 데이터베이스 백업은 최대 30일 뒤에 사라집니다. 보관 자료는 스터디 종료 후 삭제합니다.');
  assert.equal(booth.consentCopyFor('2026-11-22.v3'), '');
  assert.equal(booth.consentCopyFor('toString'), '');
  assert.equal(booth.consentCopyFor(undefined), '');
  assert.equal(booth.CONSENT_VERSION, '2026-11-22.v1');
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
  assert.match(booth.capMessage(5), /5번까지/);
});

function nodesOf(node) {
  const out = [];
  const visit = item => { out.push(item); for (const kid of item.children) if (kid && typeof kid === 'object') visit(kid); };
  visit(node);
  return out;
}
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
/* Mounted booth with a fake clock. claims is a list of claim replies (a body, or {status, headers, body}). */
function liveBooth(options = {}) {
  const {doc, ids} = page();
  const storage = options.storage || memoryStorage();
  const calls = [];
  const clock = {t: options.now || Date.parse('2026-11-22T01:00:30Z')};
  const timers = [];
  let timerId = 0;
  const claims = (options.claims || []).slice();
  const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: {get(name) { return Object.prototype.hasOwnProperty.call(headers, name) ? headers[name] : null; }},
    json: async () => body,
  });
  const fetchImpl = async (url, init = {}) => {
    const path = String(url);
    calls.push({path, at: clock.t, body: typeof init.body === 'string' ? JSON.parse(init.body) : null});
    if (path.endsWith('/v1/booth/config')) {
      return reply(200, {enabled: true, submissionsOpen: true, consentVersion: options.consentVersion || '2026-11-22.v2',
        limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, perOwner: 5},
        missions: [{paperId: '2503.10497', title: 'Synthetic mission', license: 'cc-by-4.0', course: 'quick'}]});
    }
    if (path.endsWith('/v1/booth/claim')) {
      const next = claims.length > 1 ? claims.shift() : claims[0];
      if (next && next.status && next.body) return reply(next.status, next.body, next.headers);
      return reply(200, next);
    }
    if (path.endsWith('/v1/booth/submissions')) {
      if (options.submitStatus) return reply(options.submitStatus, {error: {code: 'rate_limited'}});
      return reply(201, {receipt: 'F-0042', claimKey: '7Q3K-M9XD', status: 'received', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:30Z'});
    }
    if (path.includes('/v1/papers/pdf')) {
      const bytes = Buffer.from('%PDF-1.7 synthetic booth paper\n%%EOF\n');
      return {ok: true, status: 200, headers: {get(name) { return name === 'X-Falsify-Paper-License' ? 'cc-by-4.0' : null; }},
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), json: async () => ({})};
    }
    return reply(404, {error: {code: 'not_found'}});
  };
  const location = {hash: options.hash || ''};
  const handle = booth.mount({
    document: doc, fetch: fetchImpl, storage, location,
    config: () => ({booth: {enabled: true}, apiBase: 'https://event.example'}),
    session: () => ({token: async () => 'fsg_' + 'a'.repeat(43)}),
    setTimeout: (fn, ms) => { timerId += 1; timers.push({id: timerId, fn, ms}); return timerId; },
    clearTimeout: id => { const at = timers.findIndex(item => item.id === id); if (at >= 0) timers.splice(at, 1); },
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
  return {doc, ids, storage, calls, claimCalls, timers, clock, tick, handle, location};
}
async function submitThroughBooth(h) {
  const sourceBytes = Buffer.from('%PDF-1.7 synthetic booth paper\n%%EOF\n');
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  boothContext.FalsifyPaperWorkspace = {
    getSource: () => ({fileHash: sourceHash, file: new File([sourceBytes], 'source.pdf', {type: 'application/pdf'})}),
    getEditSnapshot: () => ({revision: 1, edits: [{enabled: true, pageIndex: 1, segmentId: 'p2', before: BEFORE, after: AFTER}]}),
    getCurrentOutput: () => null,
  };
  nodesOf(h.ids.get('booth-missions')).find(node => node.tagName === 'button' && /이 논문으로 시작/.test(node.textContent)).dispatchEvent({type: 'click'});
  await settle();
  h.doc.dispatchEvent({type: 'falsify:paper-generated', detail: {
    file: new File([EDITED], 'edited.pdf', {type: 'application/pdf'}), sourceFileHash: sourceHash, revision: 1,
    edits: [{pageIndex: 1, segmentId: 'p2', before: BEFORE, after: AFTER}],
  }});
  await waitFor(() => /변경 전/.test(h.ids.get('booth-rows').textContent));
  const rowNodes = nodesOf(h.ids.get('booth-rows'));
  rowNodes.find(node => node.tagName === 'select').value = 'number';
  rowNodes.find(node => node.tagName === 'textarea').value = '평균을 바꿨습니다';
  h.ids.get('booth-consent').checked = true;
  h.ids.get('booth-consent').dispatchEvent({type: 'change'});
  h.ids.get('booth-submit').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
}

test('the receipt screen polls the claim view until the AI result is published', async () => {
  const h = liveBooth({claims: [
    {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false},
    {status: 429, headers: {'Retry-After': '45'}, body: {error: {code: 'rate_limited'}}},
    {status: 429, body: {error: {code: 'rate_limited'}}},
    {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false},
    {receipt: 'F-0042', status: 'judged', course: 'quick', declaredCount: 1, published: true, outcome: 'missed',
      publicNote: '<b>표</b> 값 변경을 놓쳤어요', prizeMessage: '부스에서 작은 선물을 받아 가세요', publishedAt: '2026-11-22T01:03:00Z'},
  ]});
  await settle();
  assert.match(h.ids.get('booth-consent-copy').textContent, /제출하면 바로 수정본 PDF만 AI 검증을 위해 모델 제공자\(Anthropic\)에 보내고/);
  await submitThroughBooth(h);
  assert.equal(h.ids.get('booth-receipt-code').textContent, 'F-0042');
  const card = h.ids.get('booth-live');
  assert.equal(card.parentNode, h.ids.get('booth-receipt-live'));
  assert.equal(card.hidden, false);
  assert.match(h.ids.get('booth-live-title').textContent, /AI가 결함을 찾는 중이에요/);
  assert.equal(h.ids.get('booth-live-again').hidden, true);
  assert.equal(h.claimCalls().length, 0);
  assert.equal(await h.tick(), 15000);
  assert.deepEqual(h.claimCalls()[0].body, {receipt: 'F-0042', claimKey: '7Q3K-M9XD'});
  assert.equal(await h.tick(), 15000);
  assert.equal(await h.tick(), 45000);
  assert.equal(await h.tick(), 60000);
  assert.match(h.ids.get('booth-live-title').textContent, /찾는 중/);
  assert.equal(await h.tick(), 15000);
  assert.equal(h.claimCalls().length, 5);
  assert.equal(h.timers.length, 0);
  assert.equal(h.ids.get('booth-live-title').textContent, 'AI가 못 찾았어요!');
  assert.equal(h.ids.get('booth-live-prize').textContent, '부스에서 작은 선물을 받아 가세요');
  assert.equal(h.ids.get('booth-live-prize').hidden, false);
  assert.equal(h.ids.get('booth-live-note').textContent, '<b>표</b> 값 변경을 놓쳤어요');
  assert.equal(h.ids.get('booth-live-again').hidden, false);
  assert.equal(h.ids.get('booth-live-again').textContent, '다시 도전하기');
  assert.equal(h.ids.get('booth-receipts').hidden, false);
  assert.match(h.ids.get('booth-receipts-list').textContent, /F-0042/);
  h.ids.get('booth-live-again').click();
  assert.equal(h.ids.get('booth-receipt').hidden, true);
  assert.equal(h.ids.get('booth-live').hidden, true);
  assert.equal(h.ids.get('booth-submit').hidden, true);
  assert.equal(h.ids.get('booth-consent').checked, false);
  assert.equal(h.ids.get('booth-rows').textContent, '');
  assert.equal(h.ids.get('booth-missions').hidden, false);
  assert.equal(h.timers.length, 0);
  h.handle.destroy();
});

test('polling stops after 15 min with a recheck button and lookups reuse the card', async () => {
  const pending = {receipt: 'F-0042', status: 'received', course: 'quick', declaredCount: 1, published: false};
  const h = liveBooth({claims: [pending]});
  await settle();
  h.ids.get('booth-claim-receipt').value = 'f-0042';
  h.ids.get('booth-claim-key').value = '7q3k m9xd';
  h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.equal(h.ids.get('booth-live').parentNode, h.ids.get('booth-result-live'));
  assert.match(h.ids.get('booth-live-title').textContent, /찾는 중/);
  const delays = [];
  while (h.timers.length) delays.push(await h.tick());
  assert.equal(delays.length, 12 + 24);
  assert.equal(delays.reduce((sum, ms) => sum + ms, 0), 900000);
  assert.equal(h.claimCalls().length, 1 + 36);
  assert.equal(h.ids.get('booth-live-recheck').hidden, false);
  assert.equal(h.ids.get('booth-live-recheck').textContent, '결과 다시 보기');
  h.ids.get('booth-live-recheck').click();
  await settle();
  assert.equal(h.claimCalls().length, 38);
  assert.equal(h.ids.get('booth-live-recheck').hidden, true);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 15000);
  h.handle.destroy();
  assert.equal(h.timers.length, 0);
});

test('every final outcome shows its copy and the retry button', async () => {
  const cases = [
    ['caught', 'AI가 찾아냈어요'], ['partial', 'AI가 거의 찾았어요'],
    ['missed', 'AI가 못 찾았어요!'], ['invalid', '결함으로 인정되지 않았어요'],
  ];
  for (const [outcome, title] of cases) {
    const h = liveBooth({claims: [{receipt: 'F-0042', status: outcome === 'invalid' ? 'invalid' : 'judged', course: 'quick', declaredCount: 1,
      published: true, outcome, publicNote: 'note ' + outcome, prizeMessage: 'prize ' + outcome}]});
    await settle();
    h.ids.get('booth-claim-receipt').value = 'F-0042';
    h.ids.get('booth-claim-key').value = '7Q3K-M9XD';
    h.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
    await settle();
    assert.equal(h.ids.get('booth-live-title').textContent, title, outcome);
    assert.equal(h.ids.get('booth-live-note').textContent, 'note ' + outcome);
    assert.equal(h.ids.get('booth-live-prize').hidden, outcome !== 'missed');
    assert.equal(h.ids.get('booth-live-again').hidden, false);
    assert.equal(h.timers.length, 0);
    h.handle.destroy();
  }
  const w = liveBooth({claims: [{receipt: 'F-0042', status: 'withdrawn', course: 'quick', declaredCount: 1, published: false}]});
  await settle();
  w.ids.get('booth-claim-receipt').value = 'F-0042';
  w.ids.get('booth-claim-key').value = '7Q3K-M9XD';
  w.ids.get('booth-claim-form').dispatchEvent({type: 'submit', preventDefault() {}});
  await settle();
  assert.match(w.ids.get('booth-result-status').textContent, /철회됨/);
  assert.equal(w.ids.get('booth-live-title').textContent, '철회됨');
  assert.equal(w.ids.get('booth-live-again').hidden, false);
  w.handle.destroy();
});

test('a cold reload with a stored receipt resumes polling and lists receipts', async () => {
  const storage = memoryStorage();
  booth.rememberReceipt(storage, {receipt: 'F-0041', claimKey: 'AAAA-BBBB', createdAt: '2026-11-22T00:10:00Z'});
  booth.rememberReceipt(storage, {receipt: 'F-0042', claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:00:00Z'});
  const h = liveBooth({storage, claims: [
    {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, published: false},
    {receipt: 'F-0042', status: 'judged', course: 'quick', declaredCount: 1, published: true, outcome: 'caught', publicNote: '잡았어요'},
  ]});
  await settle();
  assert.equal(h.claimCalls().length, 1);
  assert.deepEqual(h.claimCalls()[0].body, {receipt: 'F-0042', claimKey: '7Q3K-M9XD'});
  assert.equal(h.ids.get('booth-result').hidden, false);
  assert.match(h.ids.get('booth-live-title').textContent, /찾는 중/);
  const items = nodesOf(h.ids.get('booth-receipts-list')).filter(node => node.tagName === 'button');
  assert.deepEqual(items.map(node => node.textContent.split(' · ')[0]), ['F-0042', 'F-0041']);
  assert.equal(await h.tick(), 15000);
  assert.equal(h.ids.get('booth-live-title').textContent, 'AI가 찾아냈어요');
  items[1].click();
  await settle();
  assert.deepEqual(h.claimCalls().at(-1).body, {receipt: 'F-0041', claimKey: 'AAAA-BBBB'});
  h.handle.destroy();
  const stale = liveBooth({storage, now: Date.parse('2026-11-22T03:00:00Z'), claims: [{receipt: 'F-0042', status: 'reviewing', published: false}]});
  await settle();
  assert.equal(stale.claimCalls().length, 0);
  assert.equal(stale.ids.get('booth-result').hidden, true);
  stale.handle.destroy();
  const hashed = liveBooth({storage, hash: '#booth-result', now: Date.parse('2026-11-22T03:00:00Z'), claims: [{receipt: 'F-0042', status: 'reviewing', published: false}]});
  await settle();
  assert.equal(hashed.claimCalls().length, 1);
  assert.equal(hashed.timers.length, 1);
  hashed.handle.destroy();
});

test('an unknown consent version blocks submit and the guest cap gets a friendly line', async () => {
  const h = liveBooth({consentVersion: '2026-11-22.v9'});
  await settle();
  assert.match(h.ids.get('booth-consent-copy').textContent, /새 동의 문구가 없어 제출할 수 없습니다/);
  assert.equal(h.ids.get('booth-consent').disabled, true);
  await submitThroughBooth(h);
  assert.equal(h.calls.some(call => call.path.endsWith('/v1/booth/submissions')), false);
  assert.match(h.ids.get('booth-submit-status').textContent, /새 동의 문구가 없어/);
  assert.equal(h.ids.get('booth-submit-button').disabled, true);
  h.handle.destroy();
  const storage = memoryStorage();
  for (let i = 1; i <= 5; i += 1) booth.rememberReceipt(storage, {receipt: 'F-000' + i, claimKey: '7Q3K-M9XD', createdAt: '2026-11-21T01:00:00Z'});
  const capped = liveBooth({storage, submitStatus: 429});
  await settle();
  await submitThroughBooth(capped);
  assert.equal(capped.calls.filter(call => call.path.endsWith('/v1/booth/submissions')).length, 1);
  assert.match(capped.ids.get('booth-submit-status').textContent, /한 사람당 5번까지 제출할 수 있어요/);
  assert.equal(capped.ids.get('booth-receipts').hidden, false);
  capped.handle.destroy();
  const fresh = liveBooth({submitStatus: 429});
  await settle();
  await submitThroughBooth(fresh);
  assert.match(fresh.ids.get('booth-submit-status').textContent, /잠시 막혔어요/);
  fresh.handle.destroy();
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
