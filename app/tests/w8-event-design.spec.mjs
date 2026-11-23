'use strict';
// Synthetic Node tests for W8 event-aligned BLUE ticket/findings UI, grading live sync,
// and W8 personal-AI RED "BLUE 검수로 이동" CTA (with strict event.html isolation).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const w8BlueSource = await readFile(fileURLToPath(new URL('../dist/w8-blue.js', import.meta.url)), 'utf8');
const w8GradingSource = await readFile(fileURLToPath(new URL('../dist/w8-grading.js', import.meta.url)), 'utf8');
const boothMyAiSource = await readFile(fileURLToPath(new URL('../dist/booth-myai.js', import.meta.url)), 'utf8');
const promptInstSource = await readFile(fileURLToPath(new URL('../dist/prompt-instructions.js', import.meta.url)), 'utf8');
const shellHtml = await readFile(fileURLToPath(new URL('../../scripts/workbench-shell.html', import.meta.url)), 'utf8');

const PDF_BYTES = Buffer.from('%PDF-1.7\n% synthetic w8 event design fixture\n%%EOF\n');
const PDF_SHA = createHash('sha256').update(PDF_BYTES).digest('hex');

const liveHandles = [];
after(() => {
  for (const h of liveHandles) {
    try { h.destroy?.(); } catch {}
    try { h.dispose?.(); } catch {}
  }
});

class El extends EventTarget {
  constructor(tag, owner) {
    super();
    const self = this;
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
      open: false,
      type: '',
      files: [],
      download: '',
      href: '',
      rel: '',
      focused: false,
      scrolledIntoView: 0,
      classList: {
        toggle(cls, force) {
          const set = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
          const on = force === undefined ? !set.has(cls) : !!force;
          if (on) set.add(cls); else set.delete(cls);
          self.className = [...set].join(' ');
          return on;
        },
        contains(cls) {
          return String(self.className || '').split(/\s+/).includes(cls);
        }
      }
    });
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() {
    return this._text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join('');
  }
  set textContent(val) {
    this.children = [];
    this._text = String(val ?? '');
  }
  append(...kids) {
    for (const kid of kids) {
      if (kid && typeof kid === 'object') kid.parent = this;
      this.children.push(kid);
    }
  }
  appendChild(kid) { this.append(kid); return kid; }
  removeChild(kid) {
    const idx = this.children.indexOf(kid);
    if (idx >= 0) this.children.splice(idx, 1);
    return kid;
  }
  replaceChildren(...kids) {
    this.textContent = '';
    this.append(...kids);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
  }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  focus() { this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrolledIntoView += 1; }
  select() {}
  add(opt) { this.append(opt); }
  *walk() {
    yield this;
    for (const c of this.children) if (c && typeof c === 'object' && c.walk) yield* c.walk();
  }
  find(pred) {
    for (const n of this.walk()) if (pred(n)) return n;
    return null;
  }
  findAll(pred) {
    const out = [];
    for (const n of this.walk()) if (pred(n)) out.push(n);
    return out;
  }
  querySelector(sel) {
    if (typeof sel !== 'string') return null;
    if (sel.startsWith('#')) return this.find(n => n.id === sel.slice(1));
    if (sel.startsWith('.')) return this.find(n => String(n.className || '').split(/\s+/).includes(sel.slice(1)));
    return this.find(n => n.tagName === sel.toUpperCase());
  }
}

function makeDoc(isWorkbench) {
  const doc = new EventTarget();
  doc.documentElement = new El('html', doc);
  if (isWorkbench) doc.documentElement.dataset.w8Workbench = '';
  doc.body = new El('body', doc);
  doc.readyState = 'complete';
  doc.activeElement = doc.body;
  doc.createElement = tag => new El(tag, doc);
  doc.createTextNode = text => String(text ?? '');
  doc.getElementById = id => doc.body.find(n => n.id === id);
  return doc;
}

function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: k => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); }
  };
}

function makePdfFile(name = 'Seedling growth.pdf') {
  const copy = Uint8Array.from(PDF_BYTES);
  return { name, size: copy.byteLength, type: 'application/pdf', arrayBuffer: async () => copy.slice().buffer };
}

test('workbench-shell.html includes #booth-ink SVG filter and focusable #w8-review container', () => {
  assert.match(shellHtml, /<filter id="booth-ink">/);
  assert.match(shellHtml, /id="w8-review"[^>]*tabindex="-1"/);
  assert.match(shellHtml, /id="w8-review-tab"/);
});

test('W8 BLUE keeps ungraded results neutral (including 0 findings), preserves partial grading distinct from caught, focuses imported ticket, and preserves runs on failure', async () => {
  const doc = makeDoc(true);
  const host = new El('div', doc);
  host.id = 'w8-blue';
  const gradingHost = new El('div', doc);
  gradingHost.id = 'w8-grading';
  doc.body.append(host, gradingHost);

  const ls = makeStorage();
  const ss = makeStorage();
  let jobSeq = 0;
  let releasePoll = null;
  const CAPS = {
    enabled: true, models: ['gemini-4-neon-high'], modelProviders: { 'gemini-4-neon-high': 'agy-cli' },
    blueDefaultModel: 'gemini-4-neon-high', blueDefaultEffort: 'high', efforts: ['high'],
    limits: { maxUploadBytes: 33554432, maxPromptChars: 32000 }, blueJobs: true, modelJobs: true
  };
  const TWO_FINDINGS = [
    { id: 'F-1', page: 1, locationLabel: 'Table 1', findingType: 'D1', verdictLabel: '아님', severity: '불일치', quote: '28', rationale: 'Table height conflicts with text.' },
    { id: 'F-2', page: 1, locationLabel: 'Results', findingType: 'D1', verdictLabel: '확인필요', severity: '불일치', quote: '34', rationale: 'Needs raw table check.' }
  ];

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const respond = (body, status = 200) => ({ ok: status < 300, status, headers: { get: () => '' }, text: async () => JSON.stringify(body) });
    if (u.pathname === '/v1/ai/capabilities') return respond(CAPS);
    if (u.pathname === '/v1/ai/uploads') return respond({ upload: { id: 'up-1', sha256: PDF_SHA, bytes: PDF_BYTES.length, name: 'Seedling growth.pdf' } });
    if (u.pathname === '/v1/ai/jobs' && method === 'POST') {
      jobSeq++;
      if (jobSeq === 1) {
        return respond({ job: { id: 'job-check-1', role: 'blue', state: 'running', model: 'gemini-4-neon-high', progress: { completedCalls: 1, requiredCalls: 2, phase: 'reread' } } });
      }
      return respond({ job: { id: 'job-fail-2', role: 'blue', state: 'failed', model: 'gemini-4-neon-high', failure: { code: 'provider_error' } } });
    }
    if (u.pathname === '/v1/ai/jobs/job-check-1') {
      await new Promise(resolve => { releasePoll = resolve; });
      return respond({ job: { id: 'job-check-1', role: 'blue', state: 'completed', model: 'gemini-4-neon-high', result: { status: 'ok', findings: TWO_FINDINGS } } });
    }
    return respond({ error: { code: 'not_found' } }, 404);
  };

  class OptionEl extends El {
    constructor(text, value) {
      super('option', doc);
      this.textContent = text;
      this.value = value;
    }
  }
  const sandbox = {
    console, URL, Event, CustomEvent, EventTarget, TextEncoder, TextDecoder, Blob, crypto,
    setTimeout, clearTimeout, localStorage: ls, sessionStorage: ss, document: doc,
    Option: OptionEl,
    navigator: { clipboard: { writeText: async () => {} } }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(promptInstSource, sandbox, { filename: 'prompt-instructions.js' });
  vm.runInNewContext(w8BlueSource, sandbox, { filename: 'w8-blue.js' });
  vm.runInNewContext(w8GradingSource, sandbox, { filename: 'w8-grading.js' });

  const blue = sandbox.FalsifyW8Blue.mount(host, {
    document: doc, localStorage: ls, sessionStorage: ss, fetch: fetchImpl,
    config: () => ({ apiBase: 'https://api.falsify.test', hostedAi: { enabled: true, apiBase: 'https://api.falsify.test' }, openAccess: { enabled: true } }),
    sessionProvider: () => ({ token: async () => 'fsg_' + 'a'.repeat(43), invalidate: () => {} }),
    artifact: async () => ({ file: makePdfFile(), sha256: PDF_SHA, revision: 'rev-1' }),
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 15)),
    clearTimeout
  });
  liveHandles.push(blue);
  await blue.ready;

  // Idle before any run: ticket hidden
  assert.equal(host.querySelector('#w8-blue-ticket-section').hidden, true);
  assert.equal(host.querySelector('#w8-blue-body').getAttribute('data-results'), 'empty');

  // Capture 2 synthetic RED edits for grading
  sandbox.FalsifyW8Grading.capture(PDF_SHA, [
    { id: 'e1', pageIndex: 0, originalText: '18', newText: '28' },
    { id: 'e2', pageIndex: 0, originalText: '24', newText: '34' }
  ]);
  sandbox.FalsifyW8Grading.mount(gradingHost, () => blue.runs());

  // Start hosted BLUE -> checking ticket visible
  host.querySelector('#w8-blue-hosted-run').click();
  for (let i = 0; i < 40 && !releasePoll; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(host.querySelector('#w8-blue-ticket-section').hidden, false);
  assert.equal(host.querySelector('#w8-blue-ticket').getAttribute('data-state'), 'pending');
  assert.equal(host.querySelector('#w8-blue-ticket-wait').hidden, false);
  assert.equal(host.querySelector('#w8-blue-ticket-steps').hidden, false);

  // Complete job (ungraded) -> neutral "검수 완료 · 지적 2건" (never 적발/통과 before grading)
  releasePoll();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(host.querySelector('#w8-blue-ticket-result').hidden, false);
  assert.equal(host.querySelector('#w8-blue-ticket').getAttribute('data-state'), 'completed');
  assert.equal(host.querySelector('#w8-blue-stamp-word').textContent, '검수 완료');
  assert.equal(host.querySelector('#w8-blue-body').getAttribute('data-results'), 'ready');
  assert.equal(host.querySelector('#w8-blue-run-filters').hidden, true);
  assert.equal(host.querySelector('#w8-blue-results-title').textContent, '항목별 AI 검증 결과');
  assert.equal(host.querySelector('#w8-blue-verdict-title').textContent, '검수 완료 · 지적 2건');
  const cards = host.querySelector('#w8-blue-findings-list').findAll(n => n.tagName === 'ARTICLE');
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.ok(!card.textContent.includes('AI가 찾음'), 'ungraded finding must not claim AI가 찾음');
  }

  // Grade edit 1 detected + edit 2 partial -> keeps 부분 적발 distinct from 적발
  const details = gradingHost.querySelector('details');
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  const selects = gradingHost.findAll(n => n.tagName === 'SELECT');
  assert.equal(selects.length, 2);
  selects[0].value = 'detected';
  selects[0].dispatchEvent(new Event('change'));
  assert.equal(host.querySelector('#w8-blue-stamp-word').textContent, '채점 중');
  selects[1].value = 'partial';
  selects[1].dispatchEvent(new Event('change'));
  assert.equal(host.querySelector('#w8-blue-ticket').getAttribute('data-state'), 'partial');
  assert.equal(host.querySelector('#w8-blue-stamp-word').textContent, '부분 적발');
  assert.equal(host.querySelector('#w8-blue-verdict-title').textContent, '적발 1곳 · 부분 적발 1곳');

  // Grade edit 1 partial + edit 2 partial -> all partial
  selects[0].value = 'partial';
  selects[0].dispatchEvent(new Event('change'));
  assert.equal(host.querySelector('#w8-blue-stamp-word').textContent, '부분 적발');
  assert.equal(host.querySelector('#w8-blue-verdict-title').textContent, 'AI가 2개 모두 근처를 짚었어요');

  // Grade edit 1 detected + edit 2 missed -> PASSED ("2개 중 1개가 AI 눈을 피했어요")
  selects[0].value = 'detected';
  selects[0].dispatchEvent(new Event('change'));
  selects[1].value = 'missed';
  selects[1].dispatchEvent(new Event('change'));
  assert.equal(host.querySelector('#w8-blue-stamp-word').textContent, '통과');
  assert.equal(host.querySelector('#w8-blue-verdict-title').textContent, '2개 중 1개가 AI 눈을 피했어요');

  // External 0-finding ungraded run -> neutral "검수 완료 · 지적 0건" (NEVER 통과) + focuses & scrolls ticket
  host.querySelector('#w8-blue-tab-external').click();
  host.querySelector('#w8-blue-external-answer').value = JSON.stringify({ findings: [] });
  const ticketEl = host.querySelector('#w8-blue-ticket');
  const verdictTitleEl = host.querySelector('#w8-blue-verdict-title');
  const prevScrolls = ticketEl.scrolledIntoView;
  host.querySelector('#w8-blue-external-import').click();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(blue.runs().length, 2);
  assert.equal(host.querySelector('#w8-blue-ticket').getAttribute('data-state'), 'completed');
  assert.equal(host.querySelector('#w8-blue-stamp-word').textContent, '검수 완료');
  assert.equal(verdictTitleEl.textContent, '검수 완료 · 지적 0건');
  assert.ok(ticketEl.scrolledIntoView > prevScrolls, 'explicit external import must scroll ticket into view');
  assert.equal(doc.activeElement, verdictTitleEl, 'explicit external import must focus verdict heading');
  const zeroCard = host.querySelector('#w8-blue-findings-list').findAll(n => n.tagName === 'ARTICLE').at(-1);
  assert.ok(zeroCard && !zeroCard.textContent.includes('AI가 놓침'), 'ungraded 0-finding card must not say AI가 놓침');

  // Failed hosted BLUE job -> clear FAILED ticket while keeping prior 2 runs intact
  host.querySelector('#w8-blue-tab-hosted').click();
  host.querySelector('#w8-blue-hosted-run').click();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(host.querySelector('#w8-blue-ticket').getAttribute('data-state'), 'failed');
  assert.equal(host.querySelector('#w8-blue-stamp-word').textContent, '실패');
  assert.equal(blue.runs().length, 2);
});

test('booth-myai.js W8 CTA omits button on 0 applied, checks state.sourceSha256, scrolls/focuses review across aria-busy, and stays isolated from event.html', async () => {
  // 1. Event page isolation (no data-w8-workbench)
  {
    const doc = makeDoc(false);
    const host = new El('div', doc);
    doc.body.append(host);
    const sandbox = {
      console, URL, Event, CustomEvent, EventTarget, setTimeout, clearTimeout,
      document: doc, navigator: { clipboard: { writeText: async () => {} } },
      FalsifyBoothRecipe: {
        validate: () => ({ ok: true, errors: [] }),
        paperInfo: () => ({ paperId: '2309.15217', title: 'Ragas', license: 'cc-by-4.0', pages: 1 }),
        pageText: () => 'Ragas 0.95',
        setAssist: () => {},
        apply: async () => ({ applied: [{ id: 'e1', pageIndex: 0 }], unresolved: [] })
      }
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.runInNewContext(boothMyAiSource, sandbox, { filename: 'booth-myai.js' });
    const h = sandbox.FalsifyBoothMyAI.mount(host);
    liveHandles.push(h);
    host.querySelector('#booth-myai-answer').value = JSON.stringify({ paperId: '2309.15217', edits: [{ page: 1, find: '0.95', replace: '0.50' }] });
    host.querySelector('#booth-myai-apply').click();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(host.querySelector('#w8-myai-go-blue'), null, 'event.html must NOT render W8 CTA');
  }

  // 2. W8 Workbench behavior
  {
    const doc = makeDoc(true);
    const reviewTab = new El('button', doc);
    reviewTab.id = 'w8-review-tab';
    let reviewClicks = 0;
    const reviewSection = new El('section', doc);
    reviewSection.id = 'w8-review';
    reviewSection.hidden = true;
    const blueTitle = new El('h2', doc);
    blueTitle.id = 'w8-blue-title';
    const blueAdapter = new El('section', doc);
    blueAdapter.id = 'w8-blue-adapter';
    blueAdapter.append(blueTitle);
    reviewSection.append(blueAdapter);
    reviewTab.addEventListener('click', () => {
      reviewClicks++;
      reviewSection.hidden = false;
      reviewSection.setAttribute('aria-busy', 'true');
    });
    const host = new El('div', doc);
    doc.body.append(reviewTab, reviewSection, host);

    let liveEdits = [];
    let currentSha = PDF_SHA;
    let applyBehavior = 'unresolved';
    let rootScrollCalls = 0;
    const paperId = 'local:' + PDF_SHA;
    const sandbox = {
      console, URL, Event, CustomEvent, EventTarget, setTimeout, clearTimeout,
      document: doc, navigator: { clipboard: { writeText: async () => {} } },
      scrollTo: () => { rootScrollCalls++; },
      FalsifyW8Paper: {
        state: () => ({ ready: true, sourceSha256: currentSha, hasEdits: liveEdits.length > 0, editCount: liveEdits.length })
      },
      FalsifyBoothRecipe: {
        validate: () => ({ ok: true, errors: [] }),
        paperInfo: () => ({ paperId, fileHash: PDF_SHA, title: 'Seedling growth.pdf', pages: 1 }),
        pageText: () => 'Shade 20 18',
        setAssist: () => {},
        apply: async () => {
          if (applyBehavior === 'unresolved') {
            liveEdits = [];
            return { applied: [], unresolved: [{ edit: { find: 'missing' }, reason: 'not_found' }] };
          }
          liveEdits = [{ id: 'e1' }, { id: 'e2' }];
          return { applied: [{ id: 'e1' }, { id: 'e2' }], unresolved: [] };
        }
      }
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.runInNewContext(boothMyAiSource, sandbox, { filename: 'booth-myai.js' });
    const h = sandbox.FalsifyBoothMyAI.mount(host);
    liveHandles.push(h);

    // 0 applied edits -> CTA omitted cleanly
    host.querySelector('#booth-myai-answer').value = JSON.stringify({ paperId, edits: [{ page: 1, find: 'missing', replace: 'x' }] });
    host.querySelector('#booth-myai-apply').click();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(host.querySelector('#w8-myai-go-blue'), null, 'CTA must not render when applied === 0');

    // Editing answer hides stale result
    host.querySelector('#booth-myai-answer').value = JSON.stringify({ paperId, edits: [{ page: 1, find: '18', replace: '28' }] });
    host.querySelector('#booth-myai-answer').dispatchEvent(new Event('input'));
    assert.equal(host.querySelector('#booth-myai-result').hidden, true);

    // Valid edits applied -> enabled CTA opens #w8-review-tab, scrolls review (never scrollTo(0,0)), and lands on #w8-blue-title once aria-busy clears
    applyBehavior = 'applied';
    host.querySelector('#booth-myai-apply').click();
    await new Promise(r => setTimeout(r, 20));
    const enabledBtn = host.querySelector('#w8-myai-go-blue');
    assert.ok(enabledBtn);
    assert.equal(enabledBtn.disabled, false);
    assert.equal(enabledBtn.textContent, 'BLUE 검수로 이동');
    enabledBtn.click();
    assert.equal(reviewClicks, 1);
    assert.equal(rootScrollCalls, 0, 'must NOT call window.scrollTo(0, 0)');
    assert.ok(reviewSection.scrolledIntoView >= 1, 'scrolls #w8-review immediately while aria-busy');
    assert.equal(doc.activeElement, reviewSection);

    // Once review finishes refreshing (aria-busy removed + runs event), focus & scroll land on #w8-blue-title / #w8-blue-adapter
    reviewSection.removeAttribute('aria-busy');
    doc.dispatchEvent(new CustomEvent('falsify:w8-runs-change', { detail: { fileHash: PDF_SHA, count: 0 } }));
    assert.ok(blueAdapter.scrolledIntoView >= 1 || blueTitle.scrolledIntoView >= 1, 'scrolls visible BLUE controls/heading once ready');
    assert.equal(doc.activeElement, blueTitle, 'focuses #w8-blue-title once ready');

    // Different paper sourceSha256 invalidates CTA cleanly
    currentSha = '0'.repeat(64);
    doc.dispatchEvent(new CustomEvent('falsify:w8-paper-change', { detail: { reason: 'open', sourceSha256: currentSha, editCount: 0 } }));
    assert.equal(host.querySelector('#booth-myai-result').hidden, true);
  }
});
