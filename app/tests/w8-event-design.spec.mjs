'use strict';
// Synthetic Node tests for W8 event-aligned BLUE ticket/findings UI, grading live sync,
// and W8 personal-AI RED "BLUE 검수로 이동" CTA (with strict event.html isolation).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const w8MatcherSource = await readFile(new URL('../dist/w8-matcher.js', import.meta.url), 'utf8');
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

test('Native and imported BLUE grade planted edits, restore manual overrides, and retain earlier runs on failure', async () => {
  const doc = makeDoc(true);
  const host = new El('div', doc);
  host.id = 'w8-blue';
  doc.body.append(host);

  const ls = makeStorage();
  const ss = makeStorage();
  let jobSeq = 0;
  let releasePoll = null;
  const CAPS = {
    enabled: true, models: ['gemini-4-neon-high'], modelProviders: { 'gemini-4-neon-high': 'agy-cli' },
    blueDefaultModel: 'gemini-4-neon-high', blueDefaultEffort: 'high', efforts: ['high'],
    limits: { maxUploadBytes: 33554432, maxPromptChars: 32000 }, blueJobs: true, modelJobs: true
  };
  // RAGAS Table 1: the paper quotes the second edited value in a separate PDF block.
  const evidence = [
    { segmentId: 'p5-b2', quote: '0.48', relation: 'contradicts' },
    { segmentId: 'p5-b4', quote: 'Ragas 0.65 0.70 GPT Score 0.72 0.52 0.63 GPT Ranking 0.54 0.40 0.52', relation: 'contradicts' }
  ];
  const findings = Array.from({ length: 10 }, (_, i) => ({
    id: 'F' + (i + 1), page: i < 4 ? 5 : 4,
    quote: i < 3 ? 'Our proposed metrics are much closer aligned with the human judgements.' : 'WikiEval',
    rationale: i < 3 ? 'Table 1 contradicts the conclusion about Ragas.' : 'Review the dataset methodology.',
    evidence: i < 3 ? evidence : []
  }));

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
      return respond({ job: { id: 'job-check-1', role: 'blue', state: 'completed', model: 'gemini-4-neon-high', result: { status: 'ok', findings } } });
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
  vm.runInNewContext(w8MatcherSource, sandbox, { filename: 'w8-matcher.js' });
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
    { id: 'e1', pageIndex: 4, originalText: '0.95', newText: '0.65' },
    { id: 'e2', pageIndex: 4, originalText: '0.78', newText: '0.48' }
  ]);

  // Start hosted BLUE -> checking ticket visible
  host.querySelector('#w8-blue-hosted-run').click();
  for (let i = 0; i < 40 && !releasePoll; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(host.querySelector('#w8-blue-ticket-section').hidden, false);
  assert.equal(host.querySelector('#w8-blue-ticket').getAttribute('data-state'), 'pending');
  assert.equal(host.querySelector('#w8-blue-ticket-wait').hidden, false);
  assert.equal(host.querySelector('#w8-blue-ticket-steps').hidden, false);

  releasePoll();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(host.querySelector('#w8-blue-ticket').getAttribute('data-state'), 'caught');
  assert.equal(host.querySelector('#w8-blue-verdict-title').textContent, 'AI가 2개를 모두 찾아냈어요');
  const editHost = host.querySelector('#w8-blue-edit-results');
  assert.ok(editHost);
  assert.equal(editHost.findAll(n => n.tagName === 'DEL').length, 2);
  assert.match(editHost.textContent, /0\.95 → 0\.65/);
  assert.match(editHost.textContent, /0\.78 → 0\.48/);
  assert.match(editHost.textContent, /BLUE 근거 · F1/);
  assert.equal(host.querySelector('#w8-blue-findings-list').findAll(n => n.tagName === 'ARTICLE').length, 10);
  assert.equal(blue.runs()[0].findings[0].evidence[1].pageIndex, 4);

  function selectVerdict(index, value) {
    const select = editHost.findAll(n => n.tagName === 'SELECT')[index];
    select.value = value;
    select.dispatchEvent(new Event('change'));
  }
  selectVerdict(1, 'partial');
  assert.equal(host.querySelector('#w8-blue-verdict-title').textContent, '적발 1곳 · 부분 적발 1곳');
  await blue.refresh();
  assert.equal(host.querySelector('#w8-blue-stamp-word').textContent, '부분 적발');
  selectVerdict(1, 'auto');
  assert.equal(host.querySelector('#w8-blue-stamp-word').textContent, '적발');

  // No findings in a completed blind run means the two edits went undetected.
  host.querySelector('#w8-blue-tab-external').click();
  host.querySelector('#w8-blue-external-answer').value = JSON.stringify({ findings: [] });
  const ticketEl = host.querySelector('#w8-blue-ticket');
  const verdictTitleEl = host.querySelector('#w8-blue-verdict-title');
  const prevScrolls = ticketEl.scrolledIntoView;
  host.querySelector('#w8-blue-external-import').click();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(blue.runs().length, 2);
  assert.equal(host.querySelector('#w8-blue-ticket').getAttribute('data-state'), 'missed');
  assert.equal(host.querySelector('#w8-blue-stamp-word').textContent, '미검출');
  assert.equal(verdictTitleEl.textContent, 'AI가 2개 모두 놓쳤어요');
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

test('saved runs reuse the local key, respect manual decisions, and distinguish incomplete review from a miss', () => {
  const storage = makeStorage();
  const sandbox = { localStorage: storage };
  sandbox.window = sandbox;
  vm.runInNewContext(w8MatcherSource, sandbox);
  vm.runInNewContext(w8GradingSource, sandbox);
  const grading = sandbox.FalsifyW8Grading;
  const run = { id: 'hosted-existing', fileHash: PDF_SHA, status: 'ok', findings: [{
    id: 'F1', pageIndex: 4, quote: 'The results in Table 1',
    evidence: [{ quote: '0.48' }, { quote: 'Ragas 0.65 0.70' }]
  }] };
  assert.equal(grading.summary(run, storage), null);
  grading.capture(PDF_SHA, [
    { id: 'one', pageIndex: 4, originalText: '0.95', newText: '0.65' },
    { id: 'two', pageIndex: 4, originalText: '0.78', newText: '0.48' }
  ]);
  assert.equal(grading.summary(run, storage).detected, 2, 'old same-page RAGAS evidence had no per-quote page');
  assert.equal(grading.summary({ ...run, findings: [{ ...run.findings[0], pageIndex: 2 }] }, storage).missed, 2);
  assert.equal(grading.summary({ ...run, findings: [] }, storage).missed, 2);
  for (const patch of [{ status: 'refusal' }, { partial: true }, { status: 'abstain' },
    { coverage: { complete: false } }, { coverage: { batchStatuses: ['ok','refusal'] } },
    { findings: [{ id: 'F1', quote: '0.48' }] }]) {
    assert.equal(grading.summary({ ...run, ...patch }, storage).pending, 2);
  }
  const key = 'falsify.w8.grading.' + PDF_SHA;
  const saved = JSON.parse(storage.getItem(key));
  saved.decisions[JSON.stringify([run.id, 'two'])] = { verdict: 'partial', links: [] };
  storage.setItem(key, JSON.stringify(saved));
  assert.equal(grading.summary(run, storage).partial, 1);
  assert.equal(grading.summary({ ...run, id: 'another-run' }, storage).detected, 2);
  assert.equal(grading.summary({ ...run, fileHash: 'other-paper' }, storage), null);
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
