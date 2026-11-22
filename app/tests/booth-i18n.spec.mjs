// booth-i18n.js unit tests: dictionary & pattern translation, DOM walk & restore,
// translate="no" exclusion, storage keys (normal vs kiosk), kiosk clearVisitor reset,
// and booth.js dual-language AI opinion parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const i18nSource = await readFile(fileURLToPath(new URL('../dist/booth-i18n.js', import.meta.url)), 'utf8');
const runtimeSource = await readFile(fileURLToPath(new URL('../dist/booth-runtime.js', import.meta.url)), 'utf8');
const editsSource = await readFile(fileURLToPath(new URL('../dist/booth-edits.js', import.meta.url)), 'utf8');
const boothSource = await readFile(fileURLToPath(new URL('../dist/booth.js', import.meta.url)), 'utf8');
const myaiSource = await readFile(fileURLToPath(new URL('../dist/booth-myai.js', import.meta.url)), 'utf8');

function memoryStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

function makeFakeDom() {
  const observers = [];
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.target = null; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.target = null; }
  }
  class FakeNode {
    constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() {
      if (!this.parentNode) return null;
      const list = this.parentNode.childNodes;
      const idx = list.indexOf(this);
      return idx >= 0 && idx + 1 < list.length ? list[idx + 1] : null;
    }
  }
  class FakeText extends FakeNode {
    constructor(val) { super(3); this._val = String(val); }
    get nodeValue() { return this._val; }
    set nodeValue(v) { this._val = String(v); }
    get textContent() { return this._val; }
    set textContent(v) { this._val = String(v); }
  }
  class FakeElement extends FakeNode {
    constructor(tag) {
      super(1);
      this.tagName = tag.toUpperCase();
      this.attrs = new Map();
      this.listeners = new Map();
      this.value = '';
      this.className = '';
      this.type = '';
      this.dataset = {};
    }
    get id() { return this.attrs.get('id') || ''; }
    set id(v) { this.attrs.set('id', String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    hasAttribute(k) { return this.attrs.has(k); }
    append(...nodes) {
      for (const n of nodes) {
        const node = typeof n === 'string' ? new FakeText(n) : n;
        node.parentNode = this;
        this.childNodes.push(node);
      }
    }
    after(node) {
      if (!this.parentNode) return;
      const list = this.parentNode.childNodes;
      const idx = list.indexOf(this);
      node.parentNode = this.parentNode;
      list.splice(idx + 1, 0, node);
    }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) {
      this.childNodes = [];
      if (v !== '' && v != null) this.append(new FakeText(v));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    click() { for (const fn of this.listeners.get('click') || []) fn(); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
      const out = [];
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      const walk = node => {
        for (const kid of node.childNodes) {
          if (kid.nodeType === 1) {
            if (cls && String(kid.className).split(/\s+/).includes(cls)) out.push(kid);
            walk(kid);
          }
        }
      };
      walk(this);
      return out;
    }
  }
  const html = new FakeElement('html');
  html.lang = 'ko';
  const body = new FakeElement('body');
  html.append(body);
  const events = [];
  const docListeners = new Map();
  const doc = {
    readyState: 'complete',
    title: 'Falsify · Paper Workbench · Event',
    documentElement: html,
    body,
    createElement: tag => new FakeElement(tag),
    createTextNode: text => new FakeText(text),
    getElementById(id) {
      let found = null;
      const walk = node => {
        if (found) return;
        for (const kid of node.childNodes) {
          if (kid.nodeType === 1) {
            if (kid.id === id) { found = kid; return; }
            walk(kid);
          }
        }
      };
      walk(body);
      return found;
    },
    querySelectorAll: sel => body.querySelectorAll(sel),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type) || [];
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatchEvent(ev) {
      events.push(ev);
      for (const fn of docListeners.get(ev.type) || []) fn(ev);
    },
  };
  return {doc, body, html, observers, events, FakeElement, FakeText, FakeMutationObserver};
}

function loadI18n(extra = {}) {
  const local = extra.localStorage || memoryStore();
  const session = extra.sessionStorage || memoryStore();
  const context = vm.createContext({
    console, URL, URLSearchParams, CustomEvent,
    localStorage: local,
    sessionStorage: session,
    location: extra.location || {search: '', pathname: '/event.html'},
    ...extra,
  });
  vm.runInContext(i18nSource, context, {filename: 'booth-i18n.js'});
  return {context, i18n: context.FalsifyBoothI18n, local, session};
}

test('dictionary and pattern translation, vars interpolation, and whitespace preservation', () => {
  const {i18n} = loadI18n();
  assert.equal(i18n.lang(), 'ko');
  assert.equal(i18n.t('내 기록'), '내 기록');
  assert.equal(i18n.t('기회 {n}번 남음', {n: 3}), '기회 3번 남음');

  i18n.setLang('en');
  assert.equal(i18n.lang(), 'en');
  assert.equal(i18n.t('내 기록'), 'My tickets');
  assert.equal(i18n.t('  내 기록  '), '  My tickets  ');
  assert.equal(i18n.t(' · 5쪽 Table 1의 숫자 하나를 바꿔 결론과 어긋나게 해 보세요. 예: Ragas 충실도 0.95 → 0.50'),
    ' · Change one number in Table 1 on p. 5 so it disagrees with the conclusion. e.g. Ragas faithfulness 0.95 → 0.50');
  /* plan97s-9 */
  assert.equal(i18n.t('검색 결과가 없어요. 영어로 찾아볼까요? 예: medical imaging'),
    'No papers found. Try English words, e.g. medical imaging.');
  assert.equal(i18n.t('영어 제목 또는 주제'), 'Title or topic in English');
  assert.equal(i18n.t('다른 공개 논문 찾기 · 영어 제목 또는 주제'),
    'Search open papers · Title or topic in English');

  // Patterns
  assert.equal(i18n.t('기회 3번 남음'), '3 tries left');
  assert.equal(i18n.t('기회 1번 남음'), '1 try left');
  assert.equal(i18n.t('기회 {n}번 남음', {n: 4}), '4 tries left');
  assert.equal(i18n.t('1인 5번까지'), 'Up to 5 tries per person');
  assert.equal(i18n.t('5쪽'), 'p. 5');
  assert.equal(i18n.t('5 / 12쪽'), '5 / 12');
  assert.equal(i18n.t('5쪽 · 1곳'), 'p. 5 · 1 edit');
  assert.equal(i18n.t('3, 5쪽 · 2곳'), 'pp. 3, 5 · 2 edits');
  assert.equal(i18n.t('고친 곳 0개'), '0 edits');
  assert.equal(i18n.t('고친 곳 1개'), '1 edit');
  assert.equal(i18n.t('고친 곳 3개'), '3 edits');
  assert.equal(i18n.t('2분'), '2m');
  assert.equal(i18n.t('45초'), '45s');
  assert.equal(i18n.t('2분 14초'), '2m 14s');
  assert.equal(i18n.t('앞에 3건 대기 중 · 약 2분'), '3 ahead in queue · ~2 min');
  assert.equal(i18n.t('예상 대기 시간 약 3분'), 'Estimated wait: ~3 min');
  /* plan97s-2 */
  assert.equal(i18n.t('내 기록 보기'), 'View my tickets');
  assert.equal(i18n.t('기회 3번을 모두 썼어요. 「내 기록」에서 결과를 볼 수 있어요.'), 'You used all 3 tries. Check My tickets for your results.');
  assert.equal(i18n.t('기회 1번을 모두 썼어요. 「내 기록」에서 결과를 볼 수 있어요.'), 'You used all 1 try. Check My tickets for your results.');
  /* plan97s-4 */
  assert.equal(i18n.t('AI 검증 차례를 기다리는 중 · 앞에 3건'), 'Waiting in the AI check queue · 3 ahead');
  assert.equal(i18n.t('AI 검증 차례를 기다리는 중 · 앞에 1건'), 'Waiting in the AI check queue · 1 ahead');
  assert.equal(i18n.t('자동 확인을 멈췄어요. 「결과 다시 보기」를 눌러 주세요.'), 'Auto-check stopped. Tap Check result again.');
  assert.equal(i18n.t('차례가 오면 AI가 앞뒤 문장과 표를 대조해요'), 'When your turn comes, AI cross-checks text and tables');

  // External mission hints, DEFAULT_NOTES, prize messages, sx94b strings
  assert.equal(
    i18n.t('AI가 놓쳤어요! 부스 스태프에게 이 화면을 보여 주면 작은 선물을 드려요.'),
    'AI missed it! Show this screen to booth staff for a small prize.',
  );
  assert.equal(
    i18n.t('더 정밀한 AI도 놓쳤어요. 최종 추첨 대상이에요.'),
    'Even the deeper AI missed it. You are entered in the final raffle.',
  );
  assert.equal(
    i18n.t('빠른 AI를 이겼어요. 정밀 AI는 찾아냈지만, 받은 선물은 그대로 가져가세요.'),
    'You beat the fast AI. The deeper AI caught it, but the prize you received is yours to keep.',
  );
  assert.equal(
    i18n.t('AI는 다른 곳을 짚었어요. 심어 둔 결함은 AI 눈을 피했어요.'),
    'AI flagged somewhere else. Your defect slipped past it.',
  );
  assert.equal(
    i18n.t('AI가 이번 수정본에서 결함을 짚지 못했어요. 심어 둔 결함은 AI 눈을 피했어요.'),
    'AI found no defect in this copy. Your defect slipped past it.',
  );
  assert.equal(i18n.t('가짜연구소 Falsify 프로젝트 · GitHub'), 'Falsify by Pseudo Lab · GitHub');
  assert.equal(i18n.t('이 페이지 소스 · AGPL-3.0'), 'Page source · AGPL-3.0');
  assert.equal(
    i18n.t('기다리는 동안 가짜연구소 Falsify 프로젝트를 둘러보세요. 마음에 들면 GitHub에서 ★를 눌러 주세요.'),
    'While you wait, take a look at Falsify by Pseudo Lab. If you like it, give it a ★ on GitHub.',
  );
  assert.equal(i18n.t('GitHub에서 보기 ★'), 'View on GitHub ★');
  assert.equal(
    i18n.t('휴대폰 카메라로 찍으면 Falsify 프로젝트가 열려요.'),
    'Scan with your phone camera to open the Falsify project.',
  );
  // Ask my AI (sx95) strings
  assert.equal(i18n.t('원문 PDF 받기'), 'Get the PDF');
  assert.equal(
    i18n.t('AI에 이 PDF를 첨부하고 프롬프트를 붙여 넣으세요. 링크를 읽을 수 있는 AI라면 프롬프트만 붙여 넣어도 돼요.'),
    'Attach this PDF to your AI and paste the prompt. If your AI can open links, the prompt alone is enough.',
  );
  assert.equal(
    i18n.t('AI가 논문을 열지 못했어요. 원문 PDF를 받아 AI에 첨부한 뒤 다시 물어봐 주세요.'),
    'Your AI could not open the paper. Get the PDF, attach it to your AI and ask again.',
  );
  assert.equal(i18n.t('전체 1,085자'), '1,085 chars total');
  // Per-defect fair results (sx96) strings and count patterns
  assert.equal(
    i18n.t('공개 논문을 몰래 고쳐 보세요. AI가 보통 1~3분 안에 찾아내는지 겨뤄요. 심은 결함 중 하나라도 AI가 놓치면 부스에서 선물을 드려요.'),
    'Sneak defects into an open paper and see if AI catches them (usually 1–3 min). If the AI misses even one, win a prize at the booth.',
  );
  assert.equal(
    i18n.t('심은 결함 중 하나라도 AI가 놓치면 성공이에요.'),
    'If the AI misses even one of your defects, you win.',
  );
  assert.equal(
    i18n.t('심어 둔 결함 중 일부는 AI가 찾았어요.'),
    'AI found some of the defects you planted.',
  );
  assert.equal(i18n.t('AI가 찾음'), 'Found by AI');
  assert.equal(i18n.t('근처를 짚음'), 'AI got close');
  assert.equal(i18n.t('AI가 놓침'), 'Missed by AI');
  assert.equal(i18n.t('4개를 모두 찾아냈어요'), 'found all 4');
  assert.equal(i18n.t('AI가 4개를 모두 찾아냈어요'), 'AI found all 4');
  assert.equal(i18n.t('4개 모두 놓쳤어요'), 'missed all 4');
  assert.equal(i18n.t('AI가 4개 모두 놓쳤어요'), 'AI missed all 4');
  assert.equal(i18n.t('4개 중 1개가 '), '1 of 4 ');
  assert.equal(i18n.t('AI 눈을 피했어요'), 'slipped past the AI');
  assert.equal(i18n.t('4개 중 1개가 AI 눈을 피했어요'), '1 of 4 slipped past the AI');
  /* plan97s-6 */
  assert.equal(
    i18n.t('접수번호와 확인키가 보이게 휴대폰으로 이 티켓을 찍어 두세요. 내 휴대폰의 「내 기록」에서 두 코드로 결과를 볼 수 있어요.'),
    'Take a photo of this ticket with your phone, with the ticket no. and claim key in view. On your phone, open My tickets and enter the two codes to see your result.',
  );
  // Per-defect evidence headings and labels
  assert.equal(i18n.t('AI가 짚은 문장'), 'Flagged quote');
  assert.equal(i18n.t('항목별 AI 검증 결과'), 'Per-defect AI results');
  assert.equal(i18n.t('결함 1 · 5쪽'), 'Defect 1 · p. 5');
  assert.equal(i18n.t('결함 5 · 9쪽'), 'Defect 5 · p. 9');
  assert.equal(i18n.t('결함 3'), 'Defect 3');
});

test('DOM walk translates text and attributes, skips translate="no" and input values, and restores cleanly', () => {
  const dom = makeFakeDom();
  const booth = dom.doc.createElement('section');
  booth.id = 'booth';
  const desk = dom.doc.createElement('header');
  desk.id = 'booth-deskbar';
  const rec = dom.doc.createElement('a');
  rec.id = 'booth-desk-records';
  rec.textContent = '내 기록';
  desk.append(rec);

  const label = dom.doc.createElement('p');
  label.textContent = '  고친 곳 2개  ';
  label.setAttribute('aria-label', '고친 곳 목록');

  const input = dom.doc.createElement('input');
  input.setAttribute('placeholder', '제목 또는 주제');
  input.value = '사용자가 입력한 한글';

  const paperStage = dom.doc.createElement('div');
  paperStage.id = 'paper-before-stage';
  const paperSpan = dom.doc.createElement('span');
  paperSpan.textContent = '내 기록';
  paperSpan.setAttribute('title', '이전 쪽');
  paperStage.append(paperSpan);

  const quote = dom.doc.createElement('blockquote');
  quote.setAttribute('translate', 'no');
  quote.textContent = 'AI가 짚은 문장 그대로 내 기록';

  const dynamicNode = dom.doc.createElement('p');
  dynamicNode.textContent = '기회 4번 남음';

  booth.append(desk, label, input, quote, dynamicNode);
  dom.body.append(booth, paperStage);

  const {i18n} = loadI18n({
    document: dom.doc,
    MutationObserver: dom.FakeMutationObserver,
  });

  // Initial Korean mode: toggle button placed with label EN, paper stage marked translate="no"
  const toggle = dom.doc.getElementById('booth-lang-desk');
  assert.ok(toggle);
  assert.equal(toggle.textContent, 'EN');
  assert.equal(toggle.getAttribute('aria-label'), 'Switch to English');
  assert.equal(toggle.getAttribute('translate'), 'no');
  assert.equal(paperStage.getAttribute('translate'), 'no');
  assert.equal(dom.html.lang, 'ko');

  // Switch to EN
  toggle.click();
  assert.equal(i18n.lang(), 'en');
  assert.equal(dom.html.lang, 'en');
  assert.equal(dom.doc.title, 'Falsify · AI Review Challenge');
  assert.equal(toggle.textContent, '한국어');
  assert.equal(toggle.getAttribute('aria-label'), '한국어로 보기');
  assert.equal(rec.textContent, 'My tickets');
  assert.equal(label.textContent, '  2 edits  ');
  assert.equal(label.getAttribute('aria-label'), 'Edit list');
  assert.equal(input.getAttribute('placeholder'), 'Title or topic');
  assert.equal(input.value, '사용자가 입력한 한글', 'visitor input value untouched');
  assert.equal(paperSpan.textContent, '내 기록', 'paper stage subtree untouched');
  assert.equal(paperSpan.getAttribute('title'), '이전 쪽', 'paper stage attributes untouched');
  assert.equal(quote.textContent, 'AI가 짚은 문장 그대로 내 기록', 'translate="no" quote untouched');
  assert.equal(dynamicNode.textContent, '4 tries left');

  // Simulate node overwritten by external code while in EN mode: restore must NOT clobber it
  dynamicNode.textContent = 'custom override';

  // Switch back to KO
  toggle.click();
  assert.equal(i18n.lang(), 'ko');
  assert.equal(dom.html.lang, 'ko');
  assert.equal(dom.doc.title, 'Falsify · Paper Workbench · Event');
  assert.equal(toggle.textContent, 'EN');
  assert.equal(rec.textContent, '내 기록');
  assert.equal(label.textContent, '  고친 곳 2개  ');
  assert.equal(label.getAttribute('aria-label'), '고친 곳 목록');
  assert.equal(input.getAttribute('placeholder'), '제목 또는 주제');
  assert.equal(dynamicNode.textContent, 'custom override', 'modified text is not clobbered on restore');
});

test('storage keys: localStorage on normal devices, sessionStorage on kiosk, cleared by clearVisitor', () => {
  const local = memoryStore();
  const session = memoryStore();
  const normal = loadI18n({localStorage: local, sessionStorage: session, location: {search: '', pathname: '/event.html'}});
  assert.equal(normal.i18n.lang(), 'ko');
  assert.equal(local.getItem('falsify.booth.lang.v1'), null);
  normal.i18n.setLang('en');
  assert.equal(local.getItem('falsify.booth.lang.v1'), 'en');
  assert.equal(session.getItem('falsify.booth.lang.v1'), null);
  normal.i18n.setLang('ko');
  assert.equal(local.getItem('falsify.booth.lang.v1'), null, 'Korean removes the key');

  // Kiosk mode (?kiosk=1) uses sessionStorage and leaves localStorage alone
  const kioskLocal = memoryStore({'falsify.booth.lang.v1': 'en'});
  const kioskSession = memoryStore({'falsify.booth.kiosk.v1': '1'});
  const kioskCtx = vm.createContext({
    console, URL, URLSearchParams, CustomEvent, setTimeout, clearTimeout, Promise,
    localStorage: kioskLocal,
    sessionStorage: kioskSession,
    location: {search: '?kiosk=1', pathname: '/event.html', replace() {}},
  });
  vm.runInContext(editsSource, kioskCtx, {filename: 'booth-edits.js'});
  vm.runInContext(i18nSource, kioskCtx, {filename: 'booth-i18n.js'});
  vm.runInContext(runtimeSource, kioskCtx, {filename: 'booth-runtime.js'});

  assert.equal(kioskCtx.FalsifyBoothI18n.lang(), 'ko', 'kiosk starts in Korean despite localStorage');
  kioskCtx.FalsifyBoothI18n.setLang('en');
  assert.equal(kioskSession.getItem('falsify.booth.lang.v1'), 'en');
  kioskCtx.FalsifyBoothRuntime.clearVisitor();
  assert.equal(kioskSession.getItem('falsify.booth.lang.v1'), null, 'kiosk clearVisitor resets language');
  assert.equal(kioskLocal.getItem('falsify.booth.lang.v1'), 'en', 'normal-mode localStorage untouched');
});

test('booth.js parsePublicNote reads AI note into opinionEn and keeps old notes intact', () => {
  const ctx = vm.createContext({console, URL, URLSearchParams});
  vm.runInContext(boothSource, ctx, {filename: 'booth.js'});
  const {parsePublicNote} = ctx.FalsifyBooth;

  const oldNote = '내가 심어 둔 결함을 AI가 찾았어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Ragas 0.50"\nAI 설명: 표 값이 본문과 어긋나요.';
  assert.deepEqual(JSON.parse(JSON.stringify(parsePublicNote(oldNote))), {
    page: '5',
    quote: 'Ragas 0.50',
    opinion: '표 값이 본문과 어긋나요.',
    text: '내가 심어 둔 결함을 AI가 찾았어요.',
  });

  const bilingual = oldNote + '\nAI note: Table 1 value contradicts the conclusion.';
  assert.deepEqual(JSON.parse(JSON.stringify(parsePublicNote(bilingual))), {
    page: '5',
    quote: 'Ragas 0.50',
    opinion: '표 값이 본문과 어긋나요.',
    opinionEn: 'Table 1 value contradicts the conclusion.',
    text: '내가 심어 둔 결함을 AI가 찾았어요.',
  });
});

test('booth-myai.js builds English prompt when page is in English mode', () => {
  const ctx = vm.createContext({
    console, URL, URLSearchParams, CustomEvent,
    FalsifyBoothI18n: {lang: () => 'en', setLang() {}, t: s => s},
  });
  vm.runInContext(myaiSource, ctx, {filename: 'booth-myai.js'});
  const prompt = ctx.FalsifyBoothMyAI.buildPrompt({
    paperId: '2309.15217', title: 'Ragas', license: 'cc-by-4.0',
    hint: 'Change one number in Table 1 on p. 5.', page: 5, pageText: 'Ragas 0.95',
  }, {lang: 'en'});
  assert.match(prompt, /You are setting a puzzle/);
  assert.match(prompt, /1 to 5 defects/);
  assert.ok(prompt.includes('PDF: https://arxiv.org/pdf/2309.15217'));
  assert.ok(prompt.includes('{"error":"cannot_read_paper"}'));
  assert.match(prompt, /Answer with the JSON object only/);
  assert.doesNotMatch(prompt, /0\.95|Change one number|Good defects/);
  assert.doesNotMatch(prompt, /[\uac00-\ud7a3]/);
});

/* plan97s-8: every booth-myai.js RULE_TEXT / ruleText output translates cleanly in EN with no Hangul */
test('booth-myai.js rule error sentences translate cleanly to English with no Hangul', async () => {
  const recipeSource = await readFile(fileURLToPath(new URL('../dist/booth-recipe.js', import.meta.url)), 'utf8');
  const {i18n} = loadI18n();
  i18n.setLang('en');
  const ctx = vm.createContext({console, URL, URLSearchParams, CustomEvent});
  vm.runInContext(recipeSource, ctx, {filename: 'booth-recipe.js'});
  vm.runInContext(myaiSource, ctx, {filename: 'booth-myai.js'});
  const M = ctx.FalsifyBoothMyAI;
  const parseCtx = {paperId: '2309.15217', segments: []};
  // Inputs that exercise the real booth-recipe.js validator codes via parseAnswer
  const inputs = [
    JSON.stringify({edits: Array.from({length: 6}, (_, i) => ({find: 'a' + i, replace: 'b'}))}),
    JSON.stringify({edits: [], reason: 'r'}),
    JSON.stringify({edits: [{find: '0.95', replace: '0.95'}]}),
    JSON.stringify({edits: [{find: '0.95\n0.78', replace: '0.5'}]}),
    JSON.stringify({edits: [{find: '0.95\u202e', replace: '0.5'}]}),
    JSON.stringify({edits: [{find: 'x'.repeat(301), replace: 'y'}]}),
    JSON.stringify({edits: [{find: '  ', replace: 'y'}]}),
    JSON.stringify({edits: [{find: '0.95', replace: '0.5'}, {find: 'a', replace: 'b'}, {find: 'c', replace: 'x'.repeat(301)}]}),
    JSON.stringify({reason: 'x'.repeat(500), edits: Array.from({length: 5}, () => ({find: 'f'.repeat(300), replace: '한'.repeat(300), context: 'c'.repeat(600)}))}),
  ];
  for (const raw of inputs) {
    const out = M.parseAnswer(raw, parseCtx);
    const rules = out.diagnostics.filter(d => d.code === 'rule');
    assert.ok(rules.length >= 1, `expected rule error for ${raw.slice(0, 60)}`);
    for (const d of rules) {
      const en = i18n.t(d.message);
      assert.doesNotMatch(en, /[가-힣]/, `Hangul leaked in EN: ${d.message} -> ${en}`);
      assert.doesNotMatch(en, /^(count|unchanged|control|too_long|too_large|empty|type|page|unknown|defect_type)\b/, `Raw code leaked: ${en}`);
    }
  }
  // Exercise every remaining RULE_TEXT / ruleText branch through a stub validator returning {field, code} only
  const directCases = [
    [{code: 'type', field: ''}],
    [{code: 'type', field: 'edits[0]'}],
    [{code: 'type', field: 'edits[0].find'}],
    [{code: 'type', field: 'edits[2].replace'}],
    [{code: 'empty', field: 'edits[0].find'}],
    [{code: 'too_long', field: 'edits[0].find'}],
    [{code: 'too_long', field: 'edits[2].replace'}],
    [{code: 'control', field: 'edits[0].find'}],
    [{code: 'unchanged', field: 'edits[0].replace'}],
    [{code: 'page', field: 'edits[0].page'}],
    [{code: 'unknown', field: 'extra'}],
    [{code: 'count', field: 'edits'}],
    [{code: 'schema', field: 'schema'}],
    [{code: 'paper', field: 'paperId'}],
    [{code: 'source', field: 'source'}],
    [{code: 'defect_type', field: 'defectType'}],
    [{code: 'too_large', field: ''}],
    [{code: 'too_long', field: 'agent.name'}],
    [{code: 'too_long', field: 'reason'}],
    [{code: 'too_long', field: 'edits[0].context'}],
  ];
  for (const errors of directCases) {
    ctx.FalsifyBoothRecipe = {validate: () => ({ok: false, errors})};
    const out = M.parseAnswer(JSON.stringify({edits: [{find: '0.95', replace: '0.50'}]}), parseCtx);
    const rules = out.diagnostics.filter(d => d.code === 'rule');
    assert.equal(rules.length, 1, JSON.stringify(errors));
    const rawFallback = [errors[0].code, errors[0].field].filter(Boolean).join(' ');
    assert.notEqual(rules[0].message, rawFallback, `fell back to raw code: ${rawFallback}`);
    const en = i18n.t(rules[0].message);
    assert.doesNotMatch(en, /[가-힣]/, `Hangul leaked for ${JSON.stringify(errors)}: ${rules[0].message} -> ${en}`);
    assert.notEqual(en, rawFallback, `Raw code leaked: ${en}`);
  }
});

test('booth.js PDF open error sentences translate cleanly to English with no Hangul', () => {
  const {i18n} = loadI18n();
  const boothCtx = vm.createContext({console, URL, URLSearchParams});
  vm.runInContext(boothSource, boothCtx, {filename: 'booth.js'});
  i18n.setLang('en');
  for (const code of ['pdf_encrypted', 'pdf_corrupt', 'pdf_empty_text', 'pdf_timeout', 'pdf_unreadable', 'leaderboard_forfeited', 'leaderboard_locked', 'paper_conquered']) {
    const ko = boothCtx.FalsifyBooth.errorMessage(code);
    const en = i18n.t(ko);
    assert.notEqual(en, ko, `missing EN translation for ${code}: ${ko}`);
    assert.doesNotMatch(en, /[가-힣]/, `Hangul leaked for ${code}: ${en}`);
  }
});

test('v2 leaderboard, opt-in consent, and first-30 prize notices translate cleanly to English with no Hangul', () => {
  const {i18n} = loadI18n();
  i18n.setLang('en');
  const samples = [
    '공개 논문을 몰래 고쳐 보세요. AI가 보통 1~3분 안에 찾아내는지 겨뤄요. 심은 결함 중 하나라도 AI가 놓치면 먼저 승리한 선착순 30분(1인 1회)께 부스에서 선물을 드려요.',
    '심은 결함 중 하나라도 AI가 놓치면 성공이에요. 현장 선물은 먼저 승리한 선착순 30분(1인 1회)께 드려요.',
    '먼저 승리한 선착순 30분께 부스에서 드려요. 이 화면을 보여 주세요.',
    '현장 선착순 30명 선물과 별도로, 마감 후 더 정밀한 AI가 한 번 더 검증해요. 그때도 못 찾으면 최종 추첨 대상이에요.',
    '내가 바꾼 문장과 AI 판정을 행사 갤러리에 공개할게요 (선택)',
    '선택하지 않아도 도전·선물·래더보드 조건은 같아요. 본인 티켓에서 언제든 바꿀 수 있어요.',
    '래더보드 · 다른 사람 결함 보기',
    '정복 2편 · 판정 12건 · LIVE 통과율 25%',
    '기회 2번 포기하고 보기',
    '지금 열면 남은 도전 기회 2번과 철회 후 재도전 기회를 포함해 새 도전이 종료돼요. 이미 제출해 검증 중인 건과 선물 수령은 그대로 유지돼요.',
    '도전 기회 3번을 모두 쓰면 다른 사람의 결함을 볼 수 있어요. 지금은 기회 2번이 남아 있어요.',
    '다른 사람의 결함을 열람하면, 이후 기존 제출을 철회하더라도 새 도전은 할 수 없어요. 이미 제출한 티켓과 선물은 그대로 유지돼요.',
    '결함 갤러리 열기',
    '운영진 예시',
    '아직 공개 선택된 참가자 사례가 없어 운영진 예시를 먼저 보여 드려요. 통계에는 포함되지 않아요.',
    '논문 출처별 LIVE 통과율',
    '결함 유형별 LIVE 통과율',
    '수정 방식별 LIVE 통과율',
    'LIVE 판정',
    'FINAL 판정',
    '내가 도전한 논문',
    '행사 갤러리에 공개하도록 바꿨어요.',
    '행사 갤러리에서 비공개로 바꿨어요.',
  ];
  for (const ko of samples) {
    const en = i18n.t(ko);
    assert.notEqual(en, ko, `missing EN translation: ${ko}`);
    assert.doesNotMatch(en, /[가-힣]/, `Hangul leaked: ${ko} -> ${en}`);
  }
});
