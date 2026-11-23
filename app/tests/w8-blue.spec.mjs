'use strict';
// Synthetic Node test suite for app/dist/w8-blue.js (W8 Stage 1 BLUE adapter & results panel).
// Uses only synthetic PDF fixtures, synthetic DOM, synthetic storage and mocked fetch.
// No real network mutations, no paid calls, no private papers or private prompts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const w8BlueSource = await readFile(fileURLToPath(new URL('../dist/w8-blue.js', import.meta.url)), 'utf8');
const w8PaperLinksSource = await readFile(fileURLToPath(new URL('../dist/w8-paper-links.js', import.meta.url)), 'utf8');
const promptInstSource = await readFile(fileURLToPath(new URL('../dist/prompt-instructions.js', import.meta.url)), 'utf8');
const ExternalExchange = require('../dist/external-exchange.js');
const ExternalProposals = require('../dist/external-proposals.js');
const DefectSensor = require('../dist/blue-defect-sensor-core.js');
const W8Blue = require('../dist/w8-blue.js');
const W8PaperLinks = require('../dist/w8-paper-links.js');

const PDF_V1_BYTES = Buffer.from('%PDF-1.7\n% synthetic w8-blue fixture v1\n%%EOF\n');
const PDF_V1_SHA = createHash('sha256').update(PDF_V1_BYTES).digest('hex');
const PDF_V2_BYTES = Buffer.from('%PDF-1.7\n% synthetic w8-blue fixture v2 edited\n%%EOF\n');
const PDF_V2_SHA = createHash('sha256').update(PDF_V2_BYTES).digest('hex');
const TOKEN = 'fss_' + 'A'.repeat(43);
const GUEST_TOKEN = 'fsg_' + 'G'.repeat(43);
const UPLOAD_UUID = '11111111-2222-4333-8444-555555555555';
const CAPS = {
  enabled: true,
  provider: 'anthropic',
  execution: 'server',
  models: ['claude-opus-5-5', 'gpt-5'],
  modelProviders: { 'claude-opus-5-5': 'anthropic', 'gpt-5': 'openai' },
  efforts: ['low', 'medium', 'high'],
  limits: { maxUploadBytes: 33554432, maxPromptChars: 32000 },
  blueJobs: true,
  modelJobs: true
};

const SEGMENTS_V1 = [
  { id: 's0', pageIndex: 0, label: 'PDF p. 1', text: 'In arm A, 10/40 (35.0%) patients responded. Primary endpoint p = 0.04.' },
  { id: 's1', pageIndex: 1, label: 'PDF p. 2', text: 'Table 1 reports mean age 62.4 years across 38 subjects.' },
  { id: 's2', pageIndex: 2, label: 'PDF p. 3', text: 'Subgroup benefit was extrapolated to all enrolled participants [12].' }
];

const FIVE_FINDINGS = [
  { id: 'F-1', page: 1, locationLabel: 'Results', findingType: 'D1', verdictLabel: '아님', severity: '불일치', quote: '10/40 (35.0%)', rationale: '10/40 is 25.0%, not 35.0%.', evidence: [{ quote: '10/40 (35.0%) patients responded.', relation: 'Arithmetic mismatch' }], confidence: '높음', uncertainty: '' },
  { id: 'F-2', page: 2, locationLabel: 'Table 1', findingType: 'D1', verdictLabel: '아님', severity: '불일치', quote: 'across 38 subjects.', rationale: 'Sample size 38 differs from N=40.', evidence: [{ quote: '10/40', relation: 'Denominator discrepancy' }], confidence: '높음', uncertainty: 'Confirm dropout table' },
  { id: 'F-3', page: 3, locationLabel: 'Discussion', findingType: 'D3', verdictLabel: '아님', severity: '결론이 바뀌는 불일치', quote: 'Subgroup benefit was extrapolated to all enrolled participants [12].', rationale: 'Subgroup overgeneralization.', evidence: [{ quote: 'Primary endpoint p = 0.04.', relation: 'Scope mismatch' }], confidence: '중간', uncertainty: '' },
  { id: 'F-4', page: 3, locationLabel: 'References', findingType: 'D2', verdictLabel: '확인필요', severity: '불일치', quote: '[12]', rationale: 'Reference 12 missing from bibliography.', evidence: [], confidence: '중간', uncertainty: 'Check full reference list' },
  { id: 'F-5', locationLabel: 'Appendix', findingType: 'D4-1', verdictLabel: '확인필요', severity: '불일치', quote: 'Unmatched synthetic quote not in text', rationale: 'Pre-specified status unclear.', evidence: ['Protocol registration needed'], confidence: '낮음', uncertainty: 'Registry ID needed' }
];

const liveHandles = [];
after(() => {
  for(const h of liveHandles){
    try{ h.destroy(); }catch{}
  }
});

class El extends EventTarget {
  constructor(tag, owner){
    super();
    Object.assign(this, {
      tagName: String(tag).toUpperCase(),
      ownerDocument: owner,
      children: [],
      parent: null,
      attrs: {},
      dataset: {},
      _text: '',
      id: '',
      className: '',
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      readOnly: false,
      type: '',
      files: [],
      download: '',
      href: '',
      rel: ''
    });
  }
  get textContent(){
    return this._text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join('');
  }
  set textContent(val){
    this.children = [];
    this._text = String(val ?? '');
  }
  append(...kids){
    for(const kid of kids){
      if(kid && typeof kid === 'object') kid.parent = this;
      this.children.push(kid);
    }
  }
  replaceChildren(...kids){
    this.textContent = '';
    this.append(...kids);
  }
  setAttribute(k, v){
    this.attrs[k] = String(v);
    if(k === 'id') this.id = String(v);
  }
  removeAttribute(k){
    delete this.attrs[k];
  }
  getAttribute(k){
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  click(){
    if(!this.disabled) this.dispatchEvent(new Event('click'));
  }
  focus(){}
  select(){}
  *walk(){
    yield this;
    for(const c of this.children) if(c && typeof c === 'object' && c.walk) yield* c.walk();
  }
  find(pred){
    for(const n of this.walk()) if(pred(n)) return n;
    return null;
  }
  findAll(pred){
    const out = [];
    for(const n of this.walk()) if(pred(n)) out.push(n);
    return out;
  }
  querySelector(sel){
    if(typeof sel === 'string' && sel.startsWith('#')) return this.find(n => n.id === sel.slice(1));
    return null;
  }
}

function makeDoc(){
  const doc = new EventTarget();
  const body = new El('body', doc);
  doc.body = body;
  doc.readyState = 'complete';
  doc.createElement = tag => new El(tag, doc);
  doc.getElementById = id => body.find(n => n.id === id);
  return doc;
}

function makeStorage(seed = {}){
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: k => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); }
  };
}

function makePdfFile(bytes = PDF_V1_BYTES, name = 'synthetic-paper.pdf'){
  const copy = Uint8Array.from(bytes);
  return {
    name,
    size: copy.byteLength,
    type: 'application/pdf',
    arrayBuffer: async () => copy.slice().buffer,
    text: async () => copy.toString('utf8')
  };
}

function makeTextFile(text, name = 'response.json'){
  const bytes = Buffer.from(text, 'utf8');
  return {
    name,
    size: bytes.byteLength,
    type: 'text/plain',
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

function createHarness(opts = {}){
  const doc = makeDoc();
  const host = new El('div', doc);
  host.id = 'w8-blue-host';
  doc.body.append(host);
  const ls = opts.ls || makeStorage();
  const ss = opts.ss || makeStorage();
  const calls = [];
  const events = [];
  doc.addEventListener('falsify:w8-runs-change', e => events.push(e.detail));

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const rec = { url: String(url), path: u.pathname, method: String(init.method || 'GET').toUpperCase(), headers: Object.assign({}, init.headers || {}), body: init.body };
    calls.push(rec);
    const res = opts.routes ? await opts.routes(rec) : { status: 404, body: { error: { code: 'not_found' } } };
    if(res === 'network-error') throw new Error('ECONNRESET');
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: { get: () => '' },
      text: async () => res.body === undefined ? '' : (typeof res.body === 'string' ? res.body : JSON.stringify(res.body))
    };
  };

  let clipboardText = '';
  const sandbox = {
    console, URL, Event, CustomEvent, EventTarget, TextEncoder, TextDecoder, Blob, crypto,
    setTimeout, clearTimeout,
    localStorage: ls,
    sessionStorage: ss,
    document: doc,
    navigator: opts.clipboardFail
      ? { clipboard: { writeText: async () => { throw new Error('denied'); } } }
      : { clipboard: { writeText: async t => { clipboardText = t; } } },
    FalsifyExternalExchange: ExternalExchange,
    FalsifyExternalProposals: ExternalProposals,
    FalsifyBlueDefectSensor: DefectSensor,
    FalsifyImport: opts.importModule || { extract: async () => ({ text: SEGMENTS_V1.map(s => s.text).join('\n\n'), format: 'PDF', segments: SEGMENTS_V1 }) },
    FalsifyW8PaperLinks: opts.paperLinks,
    FalsifyW8Archive: opts.archive
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(promptInstSource, sandbox, { filename: 'prompt-instructions.js' });
  vm.runInNewContext(w8BlueSource, sandbox, { filename: 'w8-blue.js' });

  const api = sandbox.FalsifyW8Blue;
  const config = opts.config !== undefined ? opts.config : {
    apiBase: 'https://api.falsify.test',
    hostedAi: { enabled: true, apiBase: 'https://api.falsify.test' },
    openAccess: { enabled: opts.openAccess !== false }
  };
  const sessionProvider = opts.openAccess === false ? null : {
    token: async () => GUEST_TOKEN,
    invalidate: () => {}
  };

  let currentArtifact = opts.artifact !== undefined
    ? opts.artifact
    : { file: makePdfFile(PDF_V1_BYTES, 'synthetic-v1.pdf'), sha256: PDF_V1_SHA, revision: 'rev-1' };

  const handle = api.mount(host, {
    document: doc,
    localStorage: ls,
    sessionStorage: ss,
    fetch: fetchImpl,
    config: () => config,
    sessionProvider: () => sessionProvider,
    artifact: async () => currentArtifact,
    onLocate: opts.onLocate,
    setTimeout: opts.setTimeout || ((fn, ms) => setTimeout(fn, Math.min(ms, 20))),
    clearTimeout
  });
  liveHandles.push(handle);

  return {
    api, handle, host, doc, ls, ss, calls, events, sandbox,
    getClipboard: () => clipboardText,
    setArtifact: next => { currentArtifact = next; }
  };
}

test('static hygiene: no innerHTML, no modal confirm/alert, no inline style tags, no private team prompt', () => {
  assert.doesNotMatch(w8BlueSource, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
  assert.doesNotMatch(w8BlueSource, /\b(?:confirm|alert)\s*\(/);
  assert.doesNotMatch(w8BlueSource, /createElement\s*\(\s*['"]style['"]/i);
});

test('projectRun and projectRuns produce exact standard CSV projection and keep unknown blank', () => {
  const projected = W8Blue.projectRuns([
    {
      id: 'run-b',
      fileHash: PDF_V1_SHA,
      detector: '내 AI',
      model: 'manual-model-unverified',
      condition: '',
      createdAt: '2026-11-23T02:00:00.000Z',
      findings: []
    },
    {
      id: 'run-a',
      fileHash: PDF_V1_SHA,
      detector: '내장 BLUE',
      model: 'claude-opus-5-5',
      condition: 'P0',
      createdAt: '2026-11-23T01:00:00.000Z',
      findings: [
        {
          id: 'F-1',
          pageIndex: 0,
          locationLabel: 'Table 1',
          findingType: 'D1',
          verdictLabel: '아님',
          severity: '불일치',
          quote: '10/40 (35.0%)',
          rationale: 'Percentage mismatch.',
          evidence: [{ quote: '10/40', relation: '25% not 35%' }, 'Extra text evidence'],
          confidence: '높음',
          uncertainty: ''
        },
        {
          id: 'F-2',
          pageIndex: null,
          quote: 'Unlocated phrase',
          rationale: 'Location unknown'
        }
      ]
    },
    {
      id: 'run-other-pdf',
      fileHash: PDF_V2_SHA,
      detector: '내 AI',
      model: 'gpt-5',
      condition: 'W8-v6',
      createdAt: '2026-11-23T00:30:00.000Z',
      findings: []
    }
  ], PDF_V1_SHA);

  assert.equal(projected.length, 2);
  assert.deepEqual(Object.keys(projected[0]).sort(), ['condition', 'detector', 'fileHash', 'findings', 'id', 'model', 'runNumber']);
  assert.equal(projected[0].id, 'run-a');
  assert.equal(projected[0].runNumber, 1);
  assert.equal(projected[0].model, 'claude-opus-5-5');
  assert.equal(projected[0].findings.length, 2);
  assert.deepEqual(Object.keys(projected[0].findings[0]).sort(), [
    'confidence', 'evidence', 'findingType', 'id', 'locationLabel', 'pageIndex', 'quote', 'rationale', 'severity', 'uncertainty', 'verdictLabel'
  ]);
  assert.deepEqual(projected[0].findings[0].evidence, [
    { quote: '10/40', relation: '25% not 35%' },
    { quote: 'Extra text evidence', relation: '' }
  ]);
  // Unknown fields stay blank / null
  assert.equal(projected[0].findings[1].pageIndex, null);
  assert.equal(projected[0].findings[1].locationLabel, '');
  assert.equal(projected[0].findings[1].findingType, '');
  assert.equal(projected[0].findings[1].verdictLabel, '');
  assert.equal(projected[0].findings[1].severity, '');
  assert.equal(projected[0].findings[1].confidence, '');
  assert.equal(projected[0].findings[1].uncertainty, '');
  assert.deepEqual(projected[0].findings[1].evidence, []);
  // Second run: 0 findings & unknown model stays blank
  assert.equal(projected[1].id, 'run-b');
  assert.equal(projected[1].runNumber, 2);
  assert.equal(projected[1].model, '');
  assert.equal(projected[1].condition, '');
  assert.deepEqual(projected[1].findings, []);
});

test('strict RED/BLUE separation: artifact RED metadata never enters hosted request or external prompt', async () => {
  let postedBody = null;
  const h = createHarness({
    artifact: {
      file: makePdfFile(PDF_V1_BYTES, 'clean.pdf'),
      sha256: PDF_V1_SHA,
      revision: 'rev-1',
      edits: [{ before: 'SECRET_BEFORE', after: 'SECRET_AFTER' }],
      gold: [{ id: 'GOLD_SECRET' }],
      plan: { secret: 'PLAN_SECRET' },
      sourceRunId: 'red-run-secret-123'
    },
    routes: rec => {
      if(rec.path === '/v1/ai/capabilities') return { status: 200, body: CAPS };
      if(rec.path === '/v1/ai/uploads') return { status: 200, body: { upload: { id: UPLOAD_UUID, sha256: PDF_V1_SHA, bytes: PDF_V1_BYTES.length, name: 'clean.pdf' } } };
      if(rec.path === '/v1/ai/jobs' && rec.method === 'POST'){
        postedBody = JSON.parse(rec.body);
        return {
          status: 200,
          body: { job: { id: 'job-clean', role: 'blue', state: 'completed', model: 'claude-opus-5-5', effort: 'high', result: { status: 'ok', findings: [] } } }
        };
      }
      return { status: 404, body: {} };
    }
  });
  await h.handle.ready;

  // Verify one-line send notice is next to built-in review button
  assert.match(h.host.querySelector('#w8-blue-hosted-send-note').textContent, /전송/);

  // Run hosted BLUE
  h.host.querySelector('#w8-blue-hosted-run').click();
  await new Promise(r => setTimeout(r, 40));

  assert.ok(postedBody);
  assert.equal(postedBody.role, 'blue');
  const serialized = JSON.stringify(postedBody);
  assert.doesNotMatch(serialized, /SECRET_BEFORE|SECRET_AFTER|GOLD_SECRET|PLAN_SECRET|red-run-secret-123/);
  for(const forbidden of ['edits', 'gold', 'plan', 'sourceRunId', 'before', 'after']){
    assert.equal(Object.hasOwn(postedBody, forbidden), false);
  }

  // Copy external instructions and verify zero RED leakage
  h.host.querySelector('#w8-blue-tab-external').click();
  h.host.querySelector('#w8-blue-copy-prompt').click();
  await new Promise(r => setTimeout(r, 20));
  const copied = h.getClipboard();
  assert.match(copied, /clean\.pdf/);
  assert.doesNotMatch(copied, /SECRET_BEFORE|SECRET_AFTER|GOLD_SECRET|PLAN_SECRET|red-run-secret-123/);
});

test('hosted BLUE login, upload, poll, auto-record (5+ findings & 0 findings), separate runs, and pending resume across reload', async () => {
  const ls = makeStorage();
  const ss = makeStorage();
  let pollCount = 0;
  let postJobs = 0;
  let uploadCount = 0;
  const submittedBodies = [];

  const routes = rec => {
    if(rec.path === '/v1/ai/capabilities') return { status: 200, body: CAPS };
    if(rec.path === '/v1/auth/login'){
      const body = JSON.parse(rec.body);
      assert.equal(body.username, 'tester');
      assert.equal(body.password, 'correct-horse-battery');
      return { status: 200, body: { token: TOKEN, author: { id: 'u1', username: 'tester', displayName: '테스터' } } };
    }
    if(rec.path === '/v1/ai/uploads'){
      uploadCount++;
      return { status: 200, body: { upload: { id: UPLOAD_UUID, sha256: PDF_V1_SHA, bytes: PDF_V1_BYTES.length, name: 'synthetic-v1.pdf' } } };
    }
    if(rec.path === '/v1/ai/jobs' && rec.method === 'POST'){
      postJobs++;
      const body = JSON.parse(rec.body);
      submittedBodies.push(body);
      if(postJobs === 1){
        return { status: 200, body: { job: { id: 'job-run-1', role: 'blue', state: 'queued', model: body.model || 'claude-opus-5-5', effort: body.effort || 'high', progress: { completedCalls: 0, requiredCalls: 2, phase: 'reviewing' } } } };
      }
      if(postJobs === 2){
        return { status: 200, body: { job: { id: 'job-run-2', role: 'blue', state: 'completed', model: 'gpt-5', effort: 'medium', result: { status: 'ok', findings: [] } } } };
      }
      // Run 3 stays running so we can test tab-close reload resume!
      return { status: 200, body: { job: { id: 'job-pending-3', role: 'blue', state: 'running', model: 'claude-opus-5-5', effort: 'high', progress: { completedCalls: 1, requiredCalls: 3, phase: 'reread' } } } };
    }
    if(rec.path === '/v1/ai/jobs/job-run-1' && rec.method === 'GET'){
      pollCount++;
      if(pollCount === 1){
        return { status: 200, body: { job: { id: 'job-run-1', role: 'blue', state: 'running', model: 'claude-opus-5-5', effort: 'high', progress: { completedCalls: 1, requiredCalls: 2, phase: 'reread' } } } };
      }
      return { status: 200, body: { job: { id: 'job-run-1', role: 'blue', state: 'completed', model: 'claude-opus-5-5', effort: 'high', result: { status: 'ok', findings: FIVE_FINDINGS } } } };
    }
    if(rec.path === '/v1/ai/jobs/job-pending-3' && rec.method === 'GET'){
      return {
        status: 200,
        body: {
          job: {
            id: 'job-pending-3',
            role: 'blue',
            state: 'completed',
            model: 'claude-opus-5-5',
            effort: 'high',
            result: {
              status: 'ok',
              findings: Array.from({ length: 14 }, (_, i) => ({
                id: 'BIG-' + (i + 1),
                segmentId: 'p1-b' + (i + 1),
                locationLabel: 'Section ' + (i + 1),
                quote: 'Quote ' + (i + 1),
                rationale: 'Rationale ' + (i + 1)
              }))
            }
          }
        }
      };
    }
    return { status: 404, body: {} };
  };

  // 1. Login required (openAccess: false)
  const h1 = createHarness({ ls, ss, openAccess: false, routes });
  await h1.handle.ready;
  assert.equal(h1.host.querySelector('#w8-blue-login-form').hidden, false);
  assert.equal(h1.host.querySelector('#w8-blue-hosted-run').disabled, true);

  h1.host.querySelector('#w8-blue-login-user').value = 'tester';
  h1.host.querySelector('#w8-blue-login-pass').value = 'correct-horse-battery';
  h1.host.querySelector('#w8-blue-login-btn').click();
  await new Promise(r => setTimeout(r, 40));

  assert.equal(h1.host.querySelector('#w8-blue-login-pass').value, '');
  assert.equal(h1.host.querySelector('#w8-blue-login-form').hidden, true);
  assert.equal(h1.host.querySelector('#w8-blue-hosted-run').disabled, false);
  // Password never enters storage
  assert.equal(JSON.stringify([...ls.map.entries(), ...ss.map.entries()]).includes('correct-horse-battery'), false);

  // 2. Run 1: queued -> running -> completed (5 findings)
  h1.host.querySelector('#w8-blue-hosted-run').click();
  await new Promise(r => setTimeout(r, 120));

  let runs = h1.handle.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].detector, '내장 BLUE');
  assert.equal(runs[0].model, 'claude-opus-5-5');
  assert.equal(runs[0].condition, 'P0');
  assert.equal(runs[0].runNumber, 1);
  assert.equal(runs[0].findings.length, 5);
  assert.equal(runs[0].findings[4].pageIndex, null); // unmatched preserved!
  assert.equal(h1.events.at(-1).runs.length, 1);

  // 3. Run 2 on same PDF with custom budget: creates SEPARATE run with 0 findings & reuses upload!
  const budgetInput = h1.host.querySelector('#w8-blue-hosted-budget');
  budgetInput.value = '4';
  budgetInput.dispatchEvent(new Event('input'));
  h1.host.querySelector('#w8-blue-hosted-run').click();
  await new Promise(r => setTimeout(r, 60));

  assert.equal(uploadCount, 1); // upload reused!
  assert.equal(submittedBodies[1].budget.maxCalls, 4);
  assert.notEqual(submittedBodies[0].idempotencyKey, submittedBodies[1].idempotencyKey);
  runs = h1.handle.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].runNumber, 2);
  assert.equal(runs[1].model, 'gpt-5');
  assert.equal(runs[1].findings.length, 0);

  // 4. Start Run 3 which stays 'running', then simulate tab close + reopen (remount)!
  const h1NoPoll = createHarness({
    ls, ss, openAccess: false,
    setTimeout: (fn) => setTimeout(fn, 60000), // freeze poll before tab closes
    routes
  });
  await h1NoPoll.handle.ready;
  h1NoPoll.host.querySelector('#w8-blue-hosted-run').click();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(postJobs, 3);
  h1NoPoll.handle.destroy(); // tab closed!

  // Reopen in fresh instance: must GET job-pending-3 WITHOUT posting a 4th job, and persist all 14 findings!
  const postJobsBeforeReload = postJobs;
  const h2 = createHarness({ ls, ss, openAccess: false, routes });
  await h2.handle.ready;
  await new Promise(r => setTimeout(r, 50));

  assert.equal(postJobs, postJobsBeforeReload); // ZERO duplicate POST!
  const restored = h2.handle.runs();
  assert.equal(restored.length, 3);
  assert.equal(restored[2].id, 'hosted-job-pending-3');
  assert.equal(restored[2].runNumber, 3);
  assert.equal(restored[2].findings.length, 14); // >12 findings preserved losslessly!
  assert.equal(restored[2].findings[0].pageIndex, 0);
  // Pending list cleared after terminal completion
  const pendingStore = JSON.parse(ls.getItem(W8Blue.PENDING_STORE_KEY) || '{"jobs":[]}');
  assert.equal(pendingStore.jobs.length, 0);
});

test('external 내 AI works offline: copy, paste JSON (5 findings & 0 findings), file import Markdown & Zero-Drop, post-record edits, private W8 team prompt', async () => {
  const ls = makeStorage();
  const ss = makeStorage();
  const located = [];
  const h = createHarness({
    ls, ss,
    config: { hostedAi: { enabled: false } }, // completely offline / hosted disabled!
    onLocate: d => located.push(d)
  });
  await h.handle.ready;

  // Switch to 내 AI
  h.host.querySelector('#w8-blue-tab-external').click();

  // Load private W8 team prompt file (must never be written to localStorage)
  const SECRET_TEAM_TEXT = 'PRIVATE_W8_TEAM_PROMPT_V6_DO_NOT_PUBLISH: inspect numerical consistency.';
  const teamInput = h.host.querySelector('#w8-blue-team-prompt-file');
  teamInput.files = [makeTextFile(SECRET_TEAM_TEXT, 'W8_common_v6.md')];
  teamInput.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 30));

  assert.equal(h.host.querySelector('#w8-blue-condition').value, 'W8_common_v6');

  // Copy instructions -> includes private team prompt & PDF filename
  h.host.querySelector('#w8-blue-copy-prompt').click();
  await new Promise(r => setTimeout(r, 20));
  assert.match(h.getClipboard(), /PRIVATE_W8_TEAM_PROMPT_V6_DO_NOT_PUBLISH/);
  assert.match(h.getClipboard(), /synthetic-v1\.pdf/);

  // Paste 5-finding JSON with an unmatched finding
  h.host.querySelector('#w8-blue-external-model').value = 'ChatGPT-5';
  h.host.querySelector('#w8-blue-external-model').dispatchEvent(new Event('input'));
  h.host.querySelector('#w8-blue-external-answer').value = JSON.stringify({ findings: FIVE_FINDINGS });
  h.host.querySelector('#w8-blue-external-import').click();
  await new Promise(r => setTimeout(r, 30));

  // Verify private prompt text is NOT persisted in localStorage!
  assert.equal(JSON.stringify([...ls.map.entries()]).includes('PRIVATE_W8_TEAM_PROMPT_V6_DO_NOT_PUBLISH'), false);

  let runs = h.handle.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].detector, '내 AI');
  assert.equal(runs[0].model, 'ChatGPT-5');
  assert.equal(runs[0].condition, 'W8_common_v6');
  assert.equal(runs[0].findings.length, 5);
  assert.equal(runs[0].findings[4].pageIndex, null); // F-5 unmatched

  // Import file: Korean Markdown table with Zero-Drop 2-stage ledger
  const mdResponse = [
    '| 후보ID | 쪽 | 위치 | 유형 | 인용한 원문 | 의심 내용 |',
    '|---|---|---|---|---|---|',
    '| C-1 | 1 | Results | D1 | 10/40 (35.0%) | pct error |',
    '| C-2 | 2 | Table 1 | D1 | across 38 subjects. | dropped in stage 2 |',
    '',
    '| 번호 | 쪽 | 위치(절, 그림, 표) | 유형 | 판정 | 심각도 | 인용한 원문 | 왜 결함인가 | 확신 |',
    '|---|---|---|---|---|---|---|---|---|',
    '| M-1 | 1 | Results | D1 | 아님 | 불일치 | 10/40 (35.0%) | 25%가 맞음 | 높음 |'
  ].join('\n');
  const extFileInput = h.host.querySelector('#w8-blue-external-file');
  h.host.querySelector('#w8-blue-external-model').value = '';
  h.host.querySelector('#w8-blue-external-model').dispatchEvent(new Event('input'));
  extFileInput.files = [makeTextFile(mdResponse, 'claude-review.md')];
  extFileInput.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 30));

  runs = h.handle.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].model, ''); // unknown stays blank
  assert.equal(runs[1].findings.length, 2); // M-1 + Zero-Drop recovered C-2!
  assert.equal(runs[1].findings[1].verdictLabel, '확인필요');

  // Import 0-finding JSON
  h.host.querySelector('#w8-blue-external-answer').value = JSON.stringify({ findings: [] });
  h.host.querySelector('#w8-blue-external-import').click();
  await new Promise(r => setTimeout(r, 30));

  runs = h.handle.runs();
  assert.equal(runs.length, 3);
  assert.equal(runs[2].findings.length, 0);

  // Reject role-mismatch RED response without adding a run
  h.host.querySelector('#w8-blue-external-answer').value = JSON.stringify({ role: 'red', changes: [{ before: 'a', after: 'b' }] });
  h.host.querySelector('#w8-blue-external-import').click();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(h.handle.runs().length, 3);
  assert.equal(h.host.querySelector('#w8-blue-external-error').hidden, false);

  // Post-record model supplementation on Run #2 (which had blank model)
  const runCards = h.host.querySelector('#w8-blue-runs-list').findAll(n => n.tagName === 'ARTICLE');
  const run2ModelInput = runCards[1].find(n => n.tagName === 'INPUT' && n.placeholder === '모델명');
  const run2SaveBtn = runCards[1].find(n => n.tagName === 'BUTTON' && n.textContent === '메타 저장');
  run2ModelInput.value = 'Claude Opus';
  run2SaveBtn.click();

  assert.equal(h.handle.runs()[1].model, 'Claude Opus');

  // File-hash mismatch imports cleanly inline without any confirm() modal
  h.host.querySelector('#w8-blue-external-answer').value = JSON.stringify({
    fileHash: PDF_V2_SHA,
    findings: [{ id: 'MM-1', quote: '10/40 (35.0%)', rationale: 'Imported despite hash mismatch note' }]
  });
  h.host.querySelector('#w8-blue-external-import').click();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.handle.runs().length, 4);
  assert.match(h.host.querySelector('#w8-blue-external-status').textContent, /다릅니다/);

  // Post-record location binding on unmatched F-5 in Run #1
  const findingCards = h.host.querySelector('#w8-blue-findings-list').findAll(n => n.tagName === 'ARTICLE');
  const f5Card = findingCards.find(c => c.getAttribute('data-finding-id') === 'F-5');
  assert.ok(f5Card);
  const pageInput = f5Card.find(n => n.tagName === 'INPUT' && n.type === 'number');
  const locInput = f5Card.find(n => n.tagName === 'INPUT' && n.type === 'text');
  const saveLocBtn = f5Card.find(n => n.tagName === 'BUTTON' && n.textContent === '위치 저장');
  pageInput.value = '3';
  locInput.value = 'Appendix Table A1';
  saveLocBtn.click();

  assert.equal(h.handle.runs()[0].findings[4].pageIndex, 2); // 0-based!
  assert.equal(h.handle.runs()[0].findings[4].locationLabel, 'Appendix Table A1');

  // Click '원문에서 보기' dispatches locate callback
  const updatedF5 = h.host.querySelector('#w8-blue-findings-list').findAll(n => n.tagName === 'ARTICLE').find(c => c.getAttribute('data-finding-id') === 'F-5');
  updatedF5.find(n => n.tagName === 'BUTTON' && n.textContent === '원문에서 보기').click();
  assert.equal(located.length, 1);
  assert.equal(located[0].pageIndex, 2);

  // Comparison table is visible (>= 2 runs)
  assert.equal(h.host.querySelector('#w8-blue-compare-wrap').hidden, false);

  // Switch artifact to v2 (different sha256) -> v1 runs isolated, v2 starts empty
  h.setArtifact({ file: makePdfFile(PDF_V2_BYTES, 'synthetic-v2.pdf'), sha256: PDF_V2_SHA, revision: 'rev-2' });
  await h.handle.refresh();
  assert.equal(h.handle.runs().length, 0);
  assert.equal(h.events.at(-1).fileHash, PDF_V2_SHA);
  assert.equal(h.events.at(-1).runs.length, 0);

  // Remount back on v1 -> all 4 runs + post-record edits durably restored!
  h.handle.destroy();
  const hReloaded = createHarness({
    ls, ss,
    config: { hostedAi: { enabled: false } },
    artifact: { file: makePdfFile(PDF_V1_BYTES, 'synthetic-v1.pdf'), sha256: PDF_V1_SHA, revision: 'rev-1' }
  });
  await hReloaded.handle.ready;
  const restored = hReloaded.handle.runs();
  assert.equal(restored.length, 4);
  assert.equal(restored[1].model, 'Claude Opus');
  assert.equal(restored[0].findings[4].pageIndex, 2);
  assert.equal(restored[0].findings[4].locationLabel, 'Appendix Table A1');
});

test('W8 private team prompt JSON works with native 내장 BLUE without persisting prompt body', async () => {
  const ls = makeStorage();
  let sentPrompt = '';
  const h = createHarness({
    ls,
    routes: rec => {
      if(rec.path === '/v1/ai/capabilities') return { status: 200, body: CAPS };
      if(rec.path === '/v1/ai/uploads') return { status: 200, body: { upload: { id: UPLOAD_UUID, sha256: PDF_V1_SHA, bytes: PDF_V1_BYTES.length, name: 'synthetic-v1.pdf' } } };
      if(rec.path === '/v1/ai/jobs' && rec.method === 'POST'){
        const body = JSON.parse(rec.body);
        sentPrompt = body.prompt;
        return { status: 200, body: { job: { id: 'job-w8-team', role: 'blue', state: 'completed', model: 'claude-opus-5-5', result: { status: 'ok', findings: [FIVE_FINDINGS[0]] } } } };
      }
      return { status: 404, body: {} };
    }
  });
  await h.handle.ready;

  const teamInput = h.host.querySelector('#w8-blue-team-prompt-file');
  teamInput.files = [makeTextFile(JSON.stringify({ condition: 'W8-v6', prompt: 'SECRET_NATIVE_W8_V6_PROMPT' }), 'team-v6.json')];
  teamInput.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 30));

  h.host.querySelector('#w8-blue-hosted-run').click();
  await new Promise(r => setTimeout(r, 40));

  assert.equal(sentPrompt, 'SECRET_NATIVE_W8_V6_PROMPT');
  const runs = h.handle.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].condition, 'W8-v6');
  assert.equal(JSON.stringify([...ls.map.entries()]).includes('SECRET_NATIVE_W8_V6_PROMPT'), false);
});

test('bridges legacy experiment-ledger BLUE runs and falsify:hosted-blue-result without duplicates', async () => {
  const legacyLedger = {
    schema: 'falsify.experiment-ledger.v1',
    harnesses: [],
    reviews: [],
    runs: [
      {
        id: 'legacy-local-1',
        createdAt: '2026-11-23T00:10:00.000Z',
        role: 'blue',
        revision: 'r-old',
        fileHash: PDF_V1_SHA,
        sourceHash: 'a'.repeat(64),
        segments: SEGMENTS_V1,
        harness: { id: 'builtin-blue', name: '기본 BLUE', version: '1', role: 'blue' },
        model: 'gpt-6.1-sol',
        provenance: 'local-codex',
        response: {
          status: 'ok',
          findings: [{
            id: 'L-1',
            segmentId: 's1',
            quote: 'across 38 subjects.',
            rationale: 'Local broker finding',
            evidence: [{ segmentId: 's0', quote: '10/40 (35.0%)', relation: 'differs' }],
            uncertainty: 'Verify N'
          }]
        }
      }
    ],
    externalResponses: []
  };
  const ls = makeStorage({ 'falsify.experiment-ledger.v1': JSON.stringify(legacyLedger) });
  const h = createHarness({ ls, config: { hostedAi: { enabled: false } } });
  await h.handle.ready;

  // Legacy run appears immediately
  let runs = h.handle.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].detector, '로컬 BLUE');
  assert.equal(runs[0].model, 'gpt-6.1-sol');
  assert.equal(runs[0].findings[0].pageIndex, 1);

  // Dispatch falsify:hosted-blue-result twice for same job -> records ONCE (deduped!)
  const jobEvent = new CustomEvent('falsify:hosted-blue-result', {
    detail: {
      fileHash: PDF_V1_SHA,
      fileName: 'synthetic-v1.pdf',
      job: {
        id: 'job-bridge-99',
        role: 'blue',
        state: 'completed',
        model: 'claude-opus-5-5',
        createdAt: '2026-11-23T01:00:00.000Z',
        result: { status: 'ok', findings: [FIVE_FINDINGS[0]] }
      }
    }
  });
  h.doc.dispatchEvent(jobEvent);
  h.doc.dispatchEvent(jobEvent);
  await new Promise(r => setTimeout(r, 30));

  runs = h.handle.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].detector, '내장 BLUE');
  assert.equal(runs[1].findings.length, 1);
  assert.equal(h.api.runs().length, 2); // window.FalsifyW8Blue.runs() matches!
});

test('network failure on hosted submit preserves idempotencyKey for safe manual retry', async () => {
  const ls = makeStorage();
  const ss = makeStorage();
  let attempt = 0;
  const keys = [];
  const h = createHarness({
    ls, ss,
    routes: rec => {
      if(rec.path === '/v1/ai/capabilities') return { status: 200, body: CAPS };
      if(rec.path === '/v1/ai/uploads') return { status: 200, body: { upload: { id: UPLOAD_UUID, sha256: PDF_V1_SHA, bytes: PDF_V1_BYTES.length, name: 'synthetic-v1.pdf' } } };
      if(rec.path === '/v1/ai/jobs' && rec.method === 'POST'){
        attempt++;
        const body = JSON.parse(rec.body);
        keys.push(body.idempotencyKey);
        if(attempt === 1) return 'network-error';
        return {
          status: 200,
          body: { replayed: true, job: { id: 'job-recovered', role: 'blue', state: 'completed', model: 'claude-opus-5-5', result: { status: 'ok', findings: [FIVE_FINDINGS[0]] } } }
        };
      }
      return { status: 404, body: {} };
    }
  });
  await h.handle.ready;

  h.host.querySelector('#w8-blue-hosted-run').click();
  await new Promise(r => setTimeout(r, 40));

  assert.equal(h.host.querySelector('#w8-blue-hosted-resume').hidden, false);
  assert.equal(h.handle.runs().length, 0);

  // Manual retry reuses the EXACT same idempotencyKey!
  h.host.querySelector('#w8-blue-hosted-resume').click();
  await new Promise(r => setTimeout(r, 40));

  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(h.handle.runs().length, 1);
  assert.equal(h.host.querySelector('#w8-blue-hosted-resume').hidden, true);
});

test('empty doc bootstrap catches thrown artifact error cleanly and recovers on refresh', async () => {
  const ls = makeStorage();
  const h = createHarness({
    ls,
    config: { hostedAi: { enabled: false } },
    artifact: null
  });
  await h.handle.ready;

  // Mount a fresh instance whose artifact() synchronously throws '열린 PDF가 없습니다'
  let openArt = null;
  const doc2 = makeDoc();
  const host2 = new El('div', doc2);
  doc2.body.append(host2);
  const ctl = h.api.mount(host2, {
    document: doc2,
    localStorage: ls,
    sessionStorage: makeStorage(),
    config: () => ({ hostedAi: { enabled: false } }),
    artifact: () => {
      if(!openArt) throw new Error('열린 PDF가 없습니다');
      return Promise.resolve(openArt);
    }
  });
  liveHandles.push(ctl);
  const initialRuns = await ctl.ready;
  assert.equal(initialRuns.length, 0);
  assert.match(host2.querySelector('#w8-blue-doc-meta').textContent, /먼저 열어/);

  // Once a PDF is opened, refresh() picks it up cleanly
  openArt = { file: makePdfFile(PDF_V1_BYTES, 'later.pdf'), sha256: PDF_V1_SHA, revision: 'rev-later' };
  await ctl.refresh();
  assert.match(host2.querySelector('#w8-blue-doc-meta').textContent, /later\.pdf/);
});

test('preserves every returned finding including rejected/unresolved/partial without inventing ledger mirror or 0 findings on malformed/failed', async () => {
  const ls = makeStorage();
  let labRecordCalls = 0;
  let jobSeq = 0;
  const h = createHarness({
    ls,
    routes: rec => {
      if(rec.path === '/v1/ai/capabilities') return { status: 200, body: CAPS };
      if(rec.path === '/v1/ai/uploads') return { status: 200, body: { upload: { id: UPLOAD_UUID, sha256: PDF_V1_SHA, bytes: PDF_V1_BYTES.length, name: 'synthetic-v1.pdf' } } };
      if(rec.path === '/v1/ai/jobs' && rec.method === 'POST'){
        jobSeq++;
        if(jobSeq === 1){
          // Completed with mixed statuses: accepted, rejected, unresolved, unlocated
          return {
            status: 200,
            body: {
              job: {
                id: 'job-statuses',
                role: 'blue',
                state: 'completed',
                model: 'claude-opus-5-5',
                result: {
                  status: 'ok',
                  findings: [
                    { id: 'A-1', page: 1, status: 'accepted', quote: '10/40 (35.0%)', rationale: 'Accepted finding' },
                    { id: 'R-2', status: 'rejected', quote: 'Rejected candidate quote', rationale: 'Server marked rejected' },
                    { id: 'U-3', status: 'unresolved', rationale: 'Unlocated unresolved finding' }
                  ]
                }
              }
            }
          };
        }
        if(jobSeq === 2){
          // Malformed completed result without findings array -> must NOT fabricate 0 findings!
          return { status: 200, body: { job: { id: 'job-malformed', role: 'blue', state: 'completed', model: 'claude-opus-5-5', result: { status: 'ok' } } } };
        }
        // Failed job -> must NOT fabricate 0 findings!
        return { status: 200, body: { job: { id: 'job-failed', role: 'blue', state: 'failed', failure: { code: 'provider_error' }, result: null } } };
      }
      return { status: 404, body: {} };
    }
  });
  h.sandbox.FalsifyLab = { record: async () => { labRecordCalls++; return 'fake-id'; } };
  await h.handle.ready;

  // Job 1: all 3 findings (including rejected & unresolved) preserved with original status, and ZERO fabricated ledger mirror calls!
  h.host.querySelector('#w8-blue-hosted-run').click();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(labRecordCalls, 0);
  const runs1 = h.handle.runs();
  assert.equal(runs1.length, 1);
  assert.equal(runs1[0].findings.length, 3);
  assert.equal(runs1[0].findings[0].status, 'accepted');
  assert.equal(runs1[0].findings[1].status, 'rejected');
  assert.equal(runs1[0].findings[1].quote, 'Rejected candidate quote');
  assert.equal(runs1[0].findings[2].status, 'unresolved');
  assert.equal(runs1[0].findings[2].pageIndex, null);

  // Job 2: malformed completed result does NOT add a fabricated 0-finding run
  h.host.querySelector('#w8-blue-hosted-run').click();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(h.handle.runs().length, 1);
  assert.equal(h.host.querySelector('#w8-blue-hosted-error').hidden, false);

  // Job 3: failed job does NOT add a fabricated 0-finding run
  h.host.querySelector('#w8-blue-hosted-run').click();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(h.handle.runs().length, 1);
  assert.match(h.host.querySelector('#w8-blue-hosted-error').textContent, /실패/);

  // Malformed/failed external JSON does NOT fabricate a 0-finding run
  h.host.querySelector('#w8-blue-tab-external').click();
  h.host.querySelector('#w8-blue-external-answer').value = JSON.stringify({ status: 'failed', error: 'timeout' });
  h.host.querySelector('#w8-blue-external-import').click();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.handle.runs().length, 1);
  assert.equal(h.host.querySelector('#w8-blue-external-error').hidden, false);
});

test('external BLUE saves individual findings from a clipped JSON response and retains an unreadable draft', async () => {
  const h = createHarness({ config: { hostedAi: { enabled: false } } });
  await h.handle.ready;
  h.host.querySelector('#w8-blue-tab-external').click();
  const input = h.host.querySelector('#w8-blue-external-answer');
  const submit = h.host.querySelector('#w8-blue-external-import');
  const broken = '{"findings":[{"reportNumber":"F-06","rationale":';
  input.value = broken;
  submit.click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(input.value, broken);
  assert.equal(h.handle.runs().length, 0);
  assert.match(h.host.querySelector('#w8-blue-external-error').textContent, /JSON에서 지적 항목을 읽지 못했어요/);

  input.value = '{"reportNumber":"F-06","page":1,"rationale":"First"}, {"reportNumber":"F-07","page":3,"rationale":"Second"}]}';
  submit.click();
  await new Promise(resolve => setTimeout(resolve, 30));
  const [run] = h.handle.runs();
  const [stored] = JSON.parse(h.ls.getItem(W8Blue.RUNS_STORE_KEY)).runs;
  assert.equal(stored.partial, true);
  assert.deepEqual(Array.from(run.findings, finding => finding.id), ['F-06', 'F-07']);
  assert.deepEqual(Array.from(run.findings, finding => finding.pageIndex), [0, 2]);
  const cards = h.host.querySelector('#w8-blue-findings-list').children;
  assert.equal(cards.filter(card => card.className.includes('w8-finding-card')).length, 2);
  assert.match(h.host.querySelector('#w8-blue-external-status').textContent, /지적 2건/);
});

test('durable external dedupe survives reload while explicit re-run creates a distinct run, and storage limit never truncates old runs', async () => {
  const ls = makeStorage();
  const payload = JSON.stringify({ findings: [{ id: 'D-1', page: 1, quote: '10/40 (35.0%)', rationale: 'Pct error' }] });

  const h1 = createHarness({ ls, config: { hostedAi: { enabled: false } } });
  await h1.handle.ready;
  h1.host.querySelector('#w8-blue-tab-external').click();
  h1.host.querySelector('#w8-blue-external-model').value = 'Gemini-2.5';
  h1.host.querySelector('#w8-blue-external-model').dispatchEvent(new Event('input'));
  h1.host.querySelector('#w8-blue-external-answer').value = payload;
  h1.host.querySelector('#w8-blue-external-import').click();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h1.handle.runs().length, 1);
  h1.handle.destroy();

  // Reload in a brand-new instance and re-import the exact same response -> deduped across reload!
  const h2 = createHarness({ ls, config: { hostedAi: { enabled: false } } });
  await h2.handle.ready;
  h2.host.querySelector('#w8-blue-tab-external').click();
  h2.host.querySelector('#w8-blue-external-model').value = 'Gemini-2.5';
  h2.host.querySelector('#w8-blue-external-model').dispatchEvent(new Event('input'));
  h2.host.querySelector('#w8-blue-external-answer').value = payload;
  h2.host.querySelector('#w8-blue-external-import').click();
  await new Promise(r => setTimeout(r, 30));

  assert.equal(h2.handle.runs().length, 1);
  assert.equal(h2.host.querySelector('#w8-blue-external-force-new').hidden, false);
  assert.match(h2.host.querySelector('#w8-blue-external-status').textContent, /이미 기록된 동일한 응답/);

  // Explicit user click on '별도 실행으로 추가' records a genuine distinct Run #2!
  h2.host.querySelector('#w8-blue-external-force-new').click();
  await new Promise(r => setTimeout(r, 30));
  const runsAfterForce = h2.handle.runs();
  assert.equal(runsAfterForce.length, 2);
  assert.equal(runsAfterForce[0].runNumber, 1);
  assert.equal(runsAfterForce[1].runNumber, 2);
  assert.notEqual(runsAfterForce[0].id, runsAfterForce[1].id);
  h2.handle.destroy();

  // Verify storage limit refuses write instead of silently dropping old runs
  const seeded = Array.from({ length: 200 }, (_, i) => ({
    id: 'old-run-' + i,
    fileHash: PDF_V1_SHA,
    detector: '내 AI',
    model: 'M',
    condition: 'P0',
    createdAt: new Date(1700000000000 + i * 1000).toISOString(),
    findings: []
  }));
  const fullLs = makeStorage({
    [W8Blue.RUNS_STORE_KEY]: JSON.stringify({ schema: W8Blue.RUNS_STORE_KEY, runs: seeded })
  });
  const h3 = createHarness({ ls: fullLs, config: { hostedAi: { enabled: false } } });
  await h3.handle.ready;
  h3.host.querySelector('#w8-blue-tab-external').click();
  h3.host.querySelector('#w8-blue-external-answer').value = payload;
  h3.host.querySelector('#w8-blue-external-import').click();
  for(let i = 0; i < 40 && h3.host.querySelector('#w8-blue-external-error').hidden; i++){
    await new Promise(r => setTimeout(r, 10));
  }

  const storedAfter = JSON.parse(fullLs.getItem(W8Blue.RUNS_STORE_KEY)).runs;
  assert.equal(storedAfter.length, 200);
  assert.equal(storedAfter[0].id, 'old-run-0'); // oldest run was NOT silently truncated!
  assert.equal(h3.host.querySelector('#w8-blue-external-error').hidden, false);
  assert.match(h3.host.querySelector('#w8-blue-external-error').textContent, /기존 기록을 유지/);
});

test('FLS-18 v6 team prompt download link and Blue_공통프롬프트_v6.txt condition label', async () => {
  const ls = makeStorage();
  const h = createHarness({ ls, config: { hostedAi: { enabled: false } } });
  await h.handle.ready;

  const link = h.host.querySelector('#w8-blue-team-prompt-link');
  assert.ok(link);
  assert.equal(link.tagName, 'A');
  assert.equal(link.getAttribute('href'), 'https://falsify.atlassian.net/rest/api/3/attachment/content/10077');
  assert.equal(link.textContent, '공통 프롬프트 v6 받기');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(link.getAttribute('target'), '_blank');

  // Loading Blue_공통프롬프트_v6.txt sets condition label to '공통 프롬프트 v6' (also with duplicate download suffix)
  const teamInput = h.host.querySelector('#w8-blue-team-prompt-file');
  teamInput.files = [makeTextFile('SYNTHETIC_FLS18_V6_PROMPT_BODY', 'Blue_공통프롬프트_v6.txt')];
  teamInput.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.host.querySelector('#w8-blue-condition').value, '공통 프롬프트 v6');

  teamInput.files = [makeTextFile('SYNTHETIC_FLS18_V6_PROMPT_BODY', 'Blue_공통프롬프트_v6 (1).txt')];
  teamInput.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.host.querySelector('#w8-blue-condition').value, '공통 프롬프트 v6');

  // Importing an external run under this team prompt records '공통 프롬프트 v6' without persisting prompt body
  h.host.querySelector('#w8-blue-tab-external').click();
  h.host.querySelector('#w8-blue-external-answer').value = JSON.stringify({ findings: [{ id: 'V6-1', page: 1, quote: '10/40 (35.0%)', rationale: 'Check v6' }] });
  h.host.querySelector('#w8-blue-external-import').click();
  await new Promise(r => setTimeout(r, 30));

  const runs = h.handle.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].condition, '공통 프롬프트 v6');
  assert.equal(JSON.stringify([...ls.map.entries()]).includes('SYNTHETIC_FLS18_V6_PROMPT_BODY'), false);
});

test('static hygiene for w8-paper-links.js: no innerHTML, no modal confirm/alert, no inline style tags', () => {
  assert.doesNotMatch(w8PaperLinksSource, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
  assert.doesNotMatch(w8PaperLinksSource, /\b(?:confirm|alert)\s*\(/);
  assert.doesNotMatch(w8PaperLinksSource, /createElement\s*\(\s*['"]style['"]/i);
});

test('FalsifyW8PaperLinks: #w8-search base, forBase auth + 401 retry, PUT raw PDF, dedup, base+sha sessionStorage expiry, revoke, and DOM events', async () => {
  const doc = makeDoc();
  const searchEl = new El('div', doc);
  searchEl.id = 'w8-search';
  searchEl.dataset.apiBase = 'https://event-a.falsify.test/';
  doc.body.append(searchEl);

  const ss = makeStorage();
  let clock = Date.now();
  const events = [];
  doc.addEventListener('falsify:w8-pdf-link', e => events.push(e.detail));

  const forBaseCalls = [];
  let tokenSeq = 0;
  let invalidated = 0;
  const sessionProvider = {
    forBase(base){
      forBaseCalls.push(base);
      let current = '';
      return {
        async token(){
          if(!current){
            tokenSeq++;
            current = 'fsg_' + String(tokenSeq).padStart(2, '0') + 'x'.repeat(41);
          }
          return current;
        },
        invalidate(){
          invalidated++;
          current = '';
        }
      };
    }
  };

  let releaseFirstPut = null;
  let putCalls = 0;
  let deleteCalls = 0;
  let failNextPutWith401 = false;
  let nextDeleteStatus = 204;
  let overridePutResp = null;
  const seenRequests = [];
  const LINK_TOKEN_1 = '0123456789abcdef0123456789abcdef';
  const LINK_TOKEN_2 = 'fedcba9876543210fedcba9876543210';
  const LINK_TOKEN_3 = 'aabbccddeeff00112233445566778899';

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const req = {
      url: String(url),
      origin: u.origin,
      path: u.pathname,
      method: String(init.method || 'GET').toUpperCase(),
      headers: Object.assign({}, init.headers || {}),
      body: init.body
    };
    seenRequests.push(req);
    if(req.method === 'PUT'){
      putCalls++;
      if(failNextPutWith401){
        failNextPutWith401 = false;
        return { ok: false, status: 401, text: async () => JSON.stringify({ error: { code: 'auth_required' } }) };
      }
      if(putCalls === 1 && releaseFirstPut === null){
        await new Promise(resolve => { releaseFirstPut = resolve; });
      }
      if(overridePutResp){
        const r = overridePutResp;
        overridePutResp = null;
        return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
      }
      const tok = u.origin === 'https://event-b.falsify.test'
        ? LINK_TOKEN_3
        : (putCalls === 1 ? LINK_TOKEN_1 : LINK_TOKEN_2);
      const expiresAt = new Date(clock + 60_000).toISOString();
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ token: tok, sha256: req.path.split('/').pop(), expiresAt })
      };
    }
    if(req.method === 'DELETE'){
      deleteCalls++;
      const status = nextDeleteStatus;
      nextDeleteStatus = 204;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => status >= 400 ? JSON.stringify({ error: { code: 'internal_error' } }) : ''
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const sandbox = {
    console, URL, Event, CustomEvent, EventTarget, TextEncoder, TextDecoder, Blob, crypto,
    AbortController, setTimeout, clearTimeout,
    document: doc,
    sessionStorage: ss,
    fetch: fetchImpl,
    FalsifyHostedSession: sessionProvider
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(w8PaperLinksSource, sandbox, { filename: 'w8-paper-links.js' });

  const links = sandbox.FalsifyW8PaperLinks.create({
    document: doc,
    sessionStorage: ss,
    fetch: fetchImpl,
    crypto,
    sessionProvider: () => sessionProvider,
    now: () => clock
  });

  // Before upload: url() returns ''
  assert.equal(links.url(PDF_V1_SHA), '');
  assert.equal(links.url('not-a-sha'), '');

  // Concurrent ensure() calls deduplicate into a SINGLE PUT request and ONE DOM event
  const fileV1 = makePdfFile(PDF_V1_BYTES, 'secret-source-name.pdf');
  const p1 = links.ensure(fileV1, PDF_V1_SHA);
  const p2 = links.ensure(fileV1, PDF_V1_SHA);
  assert.strictEqual(p1, p2);
  for(let i = 0; i < 30 && !releaseFirstPut; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(putCalls, 1);
  releaseFirstPut();
  const [url1, url2] = await Promise.all([p1, p2]);

  const expectedUrl1 = 'https://event-a.falsify.test/v1/w8/paper-links/' + LINK_TOKEN_1 + '.pdf';
  assert.equal(url1, expectedUrl1);
  assert.equal(url2, expectedUrl1);
  assert.equal(putCalls, 1);
  assert.deepEqual(forBaseCalls, ['https://event-a.falsify.test']);
  assert.equal(seenRequests[0].path, '/v1/w8/paper-links/' + PDF_V1_SHA);
  assert.equal(seenRequests[0].headers['Content-Type'], 'application/pdf');
  assert.match(seenRequests[0].headers.Authorization, /^Bearer fsg_01/);
  assert.ok(ArrayBuffer.isView(seenRequests[0].body));
  assert.equal(Buffer.from(seenRequests[0].body).equals(PDF_V1_BYTES), true);
  assert.equal(links.url(PDF_V1_SHA), expectedUrl1);
  assert.equal(events.length, 1);
  assert.equal(events[0].sha256, PDF_V1_SHA);

  // Cache persists in sessionStorage across a fresh client instance with same base
  const freshClient = sandbox.FalsifyW8PaperLinks.create({
    document: doc,
    sessionStorage: ss,
    fetch: fetchImpl,
    crypto,
    sessionProvider: () => sessionProvider,
    now: () => clock
  });
  assert.equal(freshClient.url(PDF_V1_SHA), expectedUrl1);
  assert.equal(await freshClient.ensure(fileV1, PDF_V1_SHA), expectedUrl1);
  assert.equal(putCalls, 1);

  // Cache key includes base: switching #w8-search.dataset.apiBase isolates entries
  searchEl.dataset.apiBase = 'https://event-b.falsify.test';
  assert.equal(links.url(PDF_V1_SHA), '');
  const urlBaseB = await links.ensure(fileV1, PDF_V1_SHA);
  assert.equal(urlBaseB, 'https://event-b.falsify.test/v1/w8/paper-links/' + LINK_TOKEN_3 + '.pdf');
  assert.equal(forBaseCalls.at(-1), 'https://event-b.falsify.test');

  // Switch back to event-a -> original cached entry still valid until expiry
  searchEl.dataset.apiBase = 'https://event-a.falsify.test';
  assert.equal(links.url(PDF_V1_SHA), expectedUrl1);

  // Advance clock past expiresAt -> url() returns '' and ensure() refreshes (also tests 401 retry!)
  clock += 61_000;
  assert.equal(links.url(PDF_V1_SHA), '');
  failNextPutWith401 = true;
  const refreshedUrl = await links.ensure(fileV1, PDF_V1_SHA);
  assert.equal(refreshedUrl, 'https://event-a.falsify.test/v1/w8/paper-links/' + LINK_TOKEN_2 + '.pdf');
  assert.equal(invalidated, 1);
  assert.match(seenRequests.at(-1).headers.Authorization, /^Bearer fsg_03/);

  // Protocol validation rejects uppercase/bad token or mismatched sha256
  overridePutResp = { status: 200, body: { token: 'UPPERCASE0123456789ABCDEF0123456', sha256: PDF_V2_SHA, expiresAt: new Date(clock + 60_000).toISOString() } };
  await assert.rejects(() => links.ensure(makePdfFile(PDF_V2_BYTES, 'v2.pdf'), PDF_V2_SHA), /유효하지 않습니다/);
  assert.equal(links.url(PDF_V2_SHA), '');

  // Revoke failure (500) rejects without falsely claiming revoked
  nextDeleteStatus = 500;
  await assert.rejects(() => links.revoke(PDF_V1_SHA));
  assert.equal(links.url(PDF_V1_SHA), refreshedUrl);

  // Successful revoke sends DELETE, clears cache, and emits falsify:w8-pdf-link with detail.sha256
  const eventsBeforeRevoke = events.length;
  await links.revoke(PDF_V1_SHA);
  assert.equal(deleteCalls, 2);
  assert.equal(seenRequests.at(-1).method, 'DELETE');
  assert.equal(seenRequests.at(-1).path, new URL(refreshedUrl).pathname);
  assert.equal(links.url(PDF_V1_SHA), '');
  assert.equal(events.length, eventsBeforeRevoke + 1);
  assert.equal(events.at(-1).sha256, PDF_V1_SHA);

  // Default singleton export works directly via window.FalsifyW8PaperLinks (including real ensure/url/revoke)
  assert.equal(typeof sandbox.FalsifyW8PaperLinks.ensure, 'function');
  assert.equal(typeof sandbox.FalsifyW8PaperLinks.url, 'function');
  assert.equal(typeof sandbox.FalsifyW8PaperLinks.revoke, 'function');
  const singletonUrl = await sandbox.FalsifyW8PaperLinks.ensure(makePdfFile(PDF_V2_BYTES, 'v2.pdf'), PDF_V2_SHA);
  assert.match(singletonUrl, /^https:\/\/event-a\.falsify\.test\/v1\/w8\/paper-links\/[0-9a-f]{32}\.pdf$/);
  assert.equal(sandbox.FalsifyW8PaperLinks.url(PDF_V2_SHA), singletonUrl);
  await sandbox.FalsifyW8PaperLinks.revoke(PDF_V2_SHA);
  assert.equal(sandbox.FalsifyW8PaperLinks.url(PDF_V2_SHA), '');
});

test('BLUE external copy uses artifact URL only (no RED/source clues), shows preview, preserves custom prompts & formats, refreshes expired links', async () => {
  const ls = makeStorage();
  const ss = makeStorage();
  ls.setItem('falsify.prompt-versions.v1.blue', JSON.stringify([
    { id: 'custom-1', name: 'My Custom Blue', text: 'CUSTOM_BLUE_BODY_ONLY', format: 'CUSTOM_OUTPUT_FORMAT_SCHEMA' }
  ]));

  let activeUrl = 'https://event.falsify.test/v1/w8/paper-links/0123456789abcdef0123456789abcdef.pdf';
  const freshUrl = 'https://event.falsify.test/v1/w8/paper-links/fedcba9876543210fedcba9876543210.pdf';
  let ensureCalls = 0;

  let harnessRef = null;
  const paperLinks = {
    url: sha => (sha === PDF_V1_SHA ? activeUrl : ''),
    ensure: async (_file, sha) => {
      ensureCalls++;
      assert.equal(sha, PDF_V1_SHA);
      activeUrl = freshUrl;
      harnessRef.doc.dispatchEvent(new CustomEvent('falsify:w8-pdf-link', { detail: { sha256: sha, url: activeUrl, action: 'saved' } }));
      return activeUrl;
    },
    revoke: async sha => {
      activeUrl = '';
      harnessRef.doc.dispatchEvent(new CustomEvent('falsify:w8-pdf-link', { detail: { sha256: sha, url: '', action: 'revoked' } }));
    }
  };

  const h = createHarness({
    ls, ss,
    config: { hostedAi: { enabled: false } },
    paperLinks,
    artifact: {
      file: makePdfFile(PDF_V1_BYTES, 'secret-source-edited.pdf'),
      sha256: PDF_V1_SHA,
      revision: 'rev-secret-77',
      edits: [{ before: 'RED_SECRET_BEFORE', after: 'RED_SECRET_AFTER' }],
      gold: [{ id: 'GOLD_SECRET_99' }],
      sourceSha256: 'b'.repeat(64),
      sourceRunId: 'red-run-secret-456'
    }
  });
  harnessRef = h;
  await h.handle.ready;

  h.host.querySelector('#w8-blue-tab-external').click();

  // External preview shows non-expired artifact URL
  const preview = h.host.querySelector('#w8-blue-pdf-link-preview');
  const anchor = h.host.querySelector('#w8-blue-pdf-link');
  assert.equal(preview.hidden, false);
  assert.equal(anchor.getAttribute('href'), activeUrl);
  assert.equal(anchor.textContent, activeUrl);

  // Select custom saved prompt + custom format
  const sel = h.host.querySelector('#w8-blue-prompt-select');
  sel.value = 'saved:custom-1';
  sel.dispatchEvent(new Event('change'));

  // Copy prompt -> uses artifact URL ONLY, preserves custom prompt & format, zero RED/source clues!
  h.host.querySelector('#w8-blue-copy-prompt').click();
  await new Promise(r => setTimeout(r, 20));

  const copied1 = h.getClipboard();
  assert.equal(ensureCalls, 0); // reused non-expired cached URL
  assert.ok(copied1.includes(activeUrl));
  assert.ok(copied1.includes('CUSTOM_BLUE_BODY_ONLY'));
  assert.ok(copied1.includes('CUSTOM_OUTPUT_FORMAT_SCHEMA'));
  assert.doesNotMatch(copied1, /secret-source-edited\.pdf|rev-secret-77|RED_SECRET|GOLD_SECRET|red-run-secret-456/);
  assert.equal(copied1.includes(PDF_V1_SHA), false);
  assert.equal(copied1.includes('b'.repeat(64)), false);
  const feedback1 = h.host.querySelector('#w8-blue-copy-status').textContent;
  assert.match(feedback1, /PDF 링크/);
  assert.doesNotMatch(feedback1, /secret-source-edited\.pdf|rev-secret-77|RED_SECRET/);

  // Private team prompt with empty format preserves prompt verbatim without appending default JSON format
  const teamInput = h.host.querySelector('#w8-blue-team-prompt-file');
  teamInput.files = [makeTextFile('CUSTOM_TEAM_PROMPT_NO_FORMAT', 'team-custom.md')];
  teamInput.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 20));
  h.host.querySelector('#w8-blue-copy-prompt').click();
  await new Promise(r => setTimeout(r, 20));
  const copiedTeam = h.getClipboard();
  assert.ok(copiedTeam.includes('CUSTOM_TEAM_PROMPT_NO_FORMAT'));
  assert.ok(copiedTeam.includes(activeUrl));
  assert.doesNotMatch(copiedTeam, /"verdictLabel": "아님"/);

  // Simulate link expiration (or revoke event) -> preview hides, next Copy refreshes expired link!
  await paperLinks.revoke(PDF_V1_SHA);
  assert.equal(preview.hidden, true);
  assert.equal(anchor.textContent, '');

  h.host.querySelector('#w8-blue-copy-prompt').click();
  await new Promise(r => setTimeout(r, 30));

  assert.equal(ensureCalls, 1);
  const copiedRefreshed = h.getClipboard();
  assert.ok(copiedRefreshed.includes(freshUrl));
  assert.equal(copiedRefreshed.includes('0123456789abcdef0123456789abcdef'), false);
  assert.equal(preview.hidden, false);
  assert.equal(anchor.getAttribute('href'), freshUrl);
});

test('BLUE external copy falls back to existing attachment on upload failure without blocking native flows, and respects archive opt-out', async () => {
  let releaseSlowEnsure = null;
  let ensureAttempts = 0;
  let archiveEnabled = true;

  const paperLinks = {
    url: () => '',
    ensure: async () => {
      ensureAttempts++;
      if(ensureAttempts === 1){
        await new Promise(resolve => { releaseSlowEnsure = resolve; });
      }
      throw new Error('upload failed 503');
    },
    revoke: async () => {}
  };

  const h = createHarness({
    paperLinks,
    archive: { enabled: () => archiveEnabled },
    routes: rec => {
      if(rec.path === '/v1/ai/capabilities') return { status: 200, body: CAPS };
      if(rec.path === '/v1/ai/uploads') return { status: 200, body: { upload: { id: UPLOAD_UUID, sha256: PDF_V1_SHA, bytes: PDF_V1_BYTES.length, name: 'synthetic-v1.pdf' } } };
      if(rec.path === '/v1/ai/jobs' && rec.method === 'POST'){
        return { status: 200, body: { job: { id: 'job-unblocked', role: 'blue', state: 'completed', model: 'claude-opus-5-5', result: { status: 'ok', findings: [FIVE_FINDINGS[0]] } } } };
      }
      return { status: 404, body: {} };
    }
  });
  await h.handle.ready;

  // Start external copy whose link upload is slow/hanging
  h.host.querySelector('#w8-blue-tab-external').click();
  h.host.querySelector('#w8-blue-copy-prompt').click();
  for(let i = 0; i < 30 && !releaseSlowEnsure; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(h.host.querySelector('#w8-blue-copy-prompt').disabled, true);

  // Native hosted BLUE flow MUST NOT be blocked while link upload is in flight!
  h.host.querySelector('#w8-blue-tab-hosted').click();
  assert.equal(h.host.querySelector('#w8-blue-hosted-run').disabled, false);
  h.host.querySelector('#w8-blue-hosted-run').click();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(h.handle.runs().length, 1);

  // Now let link upload fail -> gracefully falls back to existing attachment copy!
  releaseSlowEnsure();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.host.querySelector('#w8-blue-copy-prompt').disabled, false);
  const fallbackCopied = h.getClipboard();
  assert.match(fallbackCopied, /synthetic-v1\.pdf/);
  assert.match(fallbackCopied, /첨부/);
  assert.match(h.host.querySelector('#w8-blue-copy-status').textContent, /파일 첨부 안내/);

  // When archive sharing is turned off, Copy does NOT attempt upload and uses attachment fallback
  const attemptsBeforeOptOut = ensureAttempts;
  archiveEnabled = false;
  h.host.querySelector('#w8-blue-tab-external').click();
  h.host.querySelector('#w8-blue-copy-prompt').click();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ensureAttempts, attemptsBeforeOptOut);
  assert.match(h.getClipboard(), /synthetic-v1\.pdf/);
});

test('BLUE external copy never copies stale artifact after edits or paper switch (before or during async link upload)', async () => {
  const URL_V1 = 'https://event.falsify.test/v1/w8/paper-links/11111111111111111111111111111111.pdf';
  const URL_V2 = 'https://event.falsify.test/v1/w8/paper-links/22222222222222222222222222222222.pdf';
  let releaseV1Ensure = null;
  const cachedUrls = new Map();

  const paperLinks = {
    url: sha => cachedUrls.get(sha) || '',
    ensure: async (_file, sha) => {
      if(sha === PDF_V1_SHA){
        await new Promise(resolve => { releaseV1Ensure = resolve; });
        cachedUrls.set(sha, URL_V1);
        return URL_V1;
      }
      cachedUrls.set(sha, URL_V2);
      return URL_V2;
    },
    revoke: async () => {}
  };

  const h = createHarness({
    config: { hostedAi: { enabled: false } },
    paperLinks,
    artifact: { file: makePdfFile(PDF_V1_BYTES, 'paper-v1.pdf'), sha256: PDF_V1_SHA, revision: 'rev-1' }
  });
  await h.handle.ready;
  h.host.querySelector('#w8-blue-tab-external').click();

  // 1. Start Copy on v1, then switch/edit to v2 BEFORE ensure(v1) resolves -> stale v1 must NOT be copied!
  h.host.querySelector('#w8-blue-copy-prompt').click();
  for(let i = 0; i < 30 && !releaseV1Ensure; i++) await new Promise(r => setTimeout(r, 5));

  // Simulate user editing paper (falsify:w8-paper-change with artifact: null) and artifact updating to v2
  h.setArtifact({ file: makePdfFile(PDF_V2_BYTES, 'paper-v2-edited.pdf'), sha256: PDF_V2_SHA, revision: 'rev-2' });
  h.doc.dispatchEvent(new CustomEvent('falsify:w8-paper-change', { detail: { reason: 'edit', artifact: null } }));
  assert.equal(h.host.querySelector('#w8-blue-pdf-link-preview').hidden, true);

  // Old ensure(v1) finishes now -> MUST be dropped without writing URL_V1 to clipboard!
  releaseV1Ensure();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.getClipboard(), '');
  assert.equal(h.host.querySelector('#w8-blue-pdf-link-preview').hidden, true);

  // 2. Clicking Copy now resolves fresh v2 artifact (even without explicit refresh()) and copies URL_V2 ONLY!
  h.host.querySelector('#w8-blue-copy-prompt').click();
  await new Promise(r => setTimeout(r, 30));
  const copiedV2 = h.getClipboard();
  assert.ok(copiedV2.includes(URL_V2));
  assert.equal(copiedV2.includes(URL_V1), false);
  assert.doesNotMatch(copiedV2, /paper-v2-edited\.pdf|paper-v1\.pdf/);
  assert.equal(h.host.querySelector('#w8-blue-pdf-link').getAttribute('href'), URL_V2);

  // 3. Even if setArtifact switches silently during in-flight ensure (no DOM event), post-ensure check blocks stale copy!
  cachedUrls.clear();
  releaseV1Ensure = null;
  h.setArtifact({ file: makePdfFile(PDF_V1_BYTES, 'paper-v1.pdf'), sha256: PDF_V1_SHA, revision: 'rev-1' });
  await h.handle.refresh();
  h.host.querySelector('#w8-blue-copy-prompt').click();
  for(let i = 0; i < 30 && !releaseV1Ensure; i++) await new Promise(r => setTimeout(r, 5));
  // Silent switch to v2 without refresh or event
  h.setArtifact({ file: makePdfFile(PDF_V2_BYTES, 'paper-v2.pdf'), sha256: PDF_V2_SHA, revision: 'rev-2' });
  releaseV1Ensure();
  await new Promise(r => setTimeout(r, 30));
  // Clipboard must STILL hold URL_V2 from earlier, NOT overwritten with stale URL_V1!
  assert.equal(h.getClipboard().includes(URL_V1), false);
});

test('W8 BLUE selector shows local Gemini default with fixed high effort and preserves explicit Claude/GPT selection', async () => {
  const GEMINI_CAPS = {
    enabled: true,
    provider: 'mixed',
    execution: 'server',
    models: ['claude-opus-5-5', 'gpt-6.2-astra', 'gemini-4-neon-high'],
    modelProviders: {
      'claude-opus-5-5': 'anthropic',
      'gpt-6.2-astra': 'openai',
      'gemini-4-neon-high': 'agy-cli'
    },
    blueDefaultModel: 'gemini-4-neon-high',
    blueDefaultEffort: 'high',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    limits: { maxUploadBytes: 33554432, maxPromptChars: 32000 },
    blueJobs: true,
    modelJobs: true
  };
  const submitted = [];
  const h = createHarness({
    routes: rec => {
      if(rec.path === '/v1/ai/capabilities') return { status: 200, body: GEMINI_CAPS };
      if(rec.path === '/v1/ai/uploads'){
        return { status: 201, body: { upload: { id: UPLOAD_UUID, sha256: PDF_V1_SHA, bytes: PDF_V1_BYTES.length, name: 'synthetic-v1.pdf' } } };
      }
      if(rec.path === '/v1/ai/jobs' && rec.method === 'POST'){
        const body = JSON.parse(rec.body);
        submitted.push(body);
        return {
          status: 200,
          body: {
            job: {
              id: 'job-gem-' + submitted.length,
              role: 'blue',
              state: 'completed',
              model: body.model,
              effort: body.effort,
              provider: body.model === 'gemini-4-neon-high' ? 'agy-cli' : 'openai',
              result: { status: 'ok', findings: [] }
            }
          }
        };
      }
      return { status: 404, body: {} };
    }
  });
  await h.handle.ready;

  const modelSel = h.host.querySelector('#w8-blue-hosted-model');
  const effortSel = h.host.querySelector('#w8-blue-hosted-effort');
  const groups = modelSel.children.filter(c => c.tagName === 'OPTGROUP');
  assert.deepEqual(groups.map(g => g.getAttribute('label')), ['로컬 Gemini', 'Claude', 'OpenAI']);
  assert.equal(modelSel.value, 'gemini-4-neon-high');
  assert.match(groups[0].children[0].textContent, /gemini-4-neon-high \(기본\)/);
  assert.equal(effortSel.value, 'high');
  assert.equal(effortSel.disabled, true);
  assert.equal(effortSel.children.length, 1);

  // Default native BLUE launch sends gemini-4-neon-high + high effort.
  h.host.querySelector('#w8-blue-hosted-run').click();
  for(let i = 0; i < 40 && submitted.length < 1; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].model, 'gemini-4-neon-high');
  assert.equal(submitted[0].effort, 'high');

  // Switching to GPT unlocks effort choices and submits explicit model + effort.
  modelSel.value = 'gpt-6.2-astra';
  modelSel.dispatchEvent(new Event('change'));
  assert.equal(effortSel.disabled, false);
  assert.equal(effortSel.children.length, 5);
  effortSel.value = 'medium';
  effortSel.dispatchEvent(new Event('change'));

  h.host.querySelector('#w8-blue-hosted-run').click();
  for(let i = 0; i < 40 && submitted.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].model, 'gpt-6.2-astra');
  assert.equal(submitted[1].effort, 'medium');

  // Switching back to local Gemini re-locks effort to high.
  modelSel.value = 'gemini-4-neon-high';
  modelSel.dispatchEvent(new Event('change'));
  assert.equal(effortSel.value, 'high');
  assert.equal(effortSel.disabled, true);
});
