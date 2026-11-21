'use strict';
// Real Chromium walk of event.html English mode at 390x844 and 1280x800:
// - pick, search results, edit (both tabs: Edit it myself & Ask my AI), send, receipt & pending,
//   results (caught with AI note, partial, missed, missedNone, withdrawn), My tickets,
//   withdraw confirm, kiosk idle & handoff dialogs (verifying handoff resets to Korean),
//   and stubbed error states (offline, engine unavailable, not_found, rate_limited, booth_closed, my-ai invalid JSON).
// - At each state in EN mode, asserts zero visible Hangul outside translate="no" areas (including CSS ::before/::after).
// - Toggles back to Korean mid-edit and asserts Korean returns while step & edits remain intact.
// - Saves screenshots of each main state in EN at 390 and 1280 to BOOTH_I18N_SHOTS.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217 (the Ragas paper)');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_I18N_PORT || 19961);
const base = 'http://127.0.0.1:' + port + '/';
const shotDir = process.env.BOOTH_I18N_SHOTS || '';
const token = 'fsg_' + 'e'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const MISSIONS = [
  {
    paperId: '2309.15217',
    title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
    license: 'cc-by-4.0', course: 'quick', pageHint: 5,
    hint: '5쪽 Table 1의 숫자 하나를 바꿔 결론과 어긋나게 해 보세요. 예: Ragas 충실도 0.95 → 0.50',
  },
  {
    paperId: '2407.08275',
    title: 'Beyond Benchmarks: Evaluating Embedding Model Similarity for Retrieval Augmented Generation Systems',
    license: 'cc-by-4.0', course: 'quick', pageHint: 3,
    hint: '3쪽 Table 2의 점수 하나를 바꿔 순위가 뒤집히게 해 보세요. 예: Mistral MTEB 평균 67.56 → 60.00',
  },
];

const CLAIMS = {
  'F-0042': {
    receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', published: false,
  },
  'F-0043': {
    receipt: 'F-0043', status: 'judged', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:30.000Z',
    published: true, outcome: 'caught',
    publicNote: '내가 심어 둔 결함을 AI가 찾았어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Ragas 0.50 0.78 0.70"\nAI 설명: 표 값이 본문 결론과 어긋나요.\nAI note: Table 1 faithfulness 0.50 contradicts the conclusion claiming Ragas agrees best with humans.',
  },
  'F-0044': {
    receipt: 'F-0044', status: 'judged', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:02:10.000Z',
    published: true, outcome: 'partial',
    publicNote: '내가 심어 둔 결함 근처를 AI가 짚었어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Table 1: Agreement with human annotators."\nAI 설명: 표 1의 수치 일관성에 의문이 있어요.\nAI note: The numbers in Table 1 appear inconsistent with the surrounding text.',
  },
  'F-0045': {
    receipt: 'F-0045', status: 'judged', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:02:00.000Z',
    published: true, outcome: 'missed',
    publicNote: 'AI는 다른 곳을 짚었어요. 심어 둔 결함은 AI 눈을 피했어요.',
    prizeMessage: 'AI가 놓쳤어요! 부스 스태프에게 이 화면을 보여 주면 작은 선물을 드려요.',
  },
  'F-0046': {
    receipt: 'F-0046', status: 'judged', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:02:05.000Z',
    published: true, outcome: 'missed',
    publicNote: 'AI가 이번 수정본에서 결함을 짚지 못했어요. 심어 둔 결함은 AI 눈을 피했어요.',
    prizeMessage: '더 정밀한 AI도 놓쳤어요. 최종 추첨 대상이에요.',
  },
  'F-0047': {
    receipt: 'F-0047', status: 'withdrawn', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', published: false,
  },
};

function serve() {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: dist, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PYTHONUNBUFFERED: '1'},
  });
  let out = '';
  child.stdout.on('data', c => { out += c.toString(); });
  child.stderr.on('data', c => { out += c.toString(); });
  const ready = (async () => {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (child.exitCode != null) throw new Error('http.server exited ' + child.exitCode + '\n' + out);
      try { if ((await fetch(base + 'event.html')).ok) return; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('http.server did not start\n' + out);
  })();
  return {child, ready};
}

function json(route, status, body) {
  return route.fulfill({status, contentType: 'application/json', headers: cors, body: JSON.stringify(body)});
}

async function stubApi(route, state) {
  const req = route.request();
  const url = new URL(req.url());
  if (!url.href.startsWith(api)) return route.abort();
  if (state.offline) return route.abort('internetdisconnected');
  if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
  if (req.method() === 'POST' && url.pathname === '/v1/ai/guest') {
    return json(route, 200, {guest: {token, expiresAt: '2099-01-01T00:00:00.000Z'}});
  }
  if (url.pathname === '/v1/ai/capabilities') {
    return json(route, 200, {
      enabled: true, provider: 'anthropic', execution: 'server',
      models: ['claude-opus-5-5'], efforts: ['high'],
      limits: {maxUploadBytes: 33554432, maxPromptChars: 8000},
      modelJobs: false, blueJobs: false,
    });
  }
  if (url.pathname === '/v1/booth/config') {
    if (state.onConfig) return state.onConfig(route);
    return json(route, 200, {
      enabled: true, submissionsOpen: state.submissionsOpen !== false, announcement: '',
      consentVersion: '2026-11-22.v3',
      limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216, perOwner: 3},
      missions: MISSIONS,
    });
  }
  if (url.pathname === '/v1/papers/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q === 'nomatch') return json(route, 200, {results: [], hasMore: false});
    return json(route, 200, {
      results: [{
        id: '2309.15217',
        title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
        authors: ['Shahul Es', 'Jithin James'], year: 2023, license: 'cc-by-4.0',
      }],
      hasMore: false,
    });
  }
  if (url.pathname === '/v1/papers/pdf') {
    return route.fulfill({
      status: 200, contentType: 'application/pdf',
      headers: {...cors, 'X-Falsify-Paper-License': 'cc-by-4.0', 'Content-Disposition': 'attachment; filename="2309.15217.pdf"'},
      body: pdfBytes,
    });
  }
  if (req.method() === 'POST' && url.pathname === '/v1/booth/submissions') {
    if (state.submitError) return json(route, state.submitError.status, {error: {code: state.submitError.code}});
    return json(route, 201, {
      receipt: 'F-0042', claimKey: '7Q3K-M9XD', status: 'received',
      course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00.000Z',
    });
  }
  if (url.pathname === '/v1/booth/claim' && (req.method() === 'GET' || req.method() === 'POST')) {
    const r = req.method() === 'GET' ? url.searchParams.get('receipt') : JSON.parse(req.postData() || '{}').receipt;
    if (CLAIMS[r]) return json(route, 200, CLAIMS[r]);
    return json(route, 404, {error: {code: 'not_found'}});
  }
  if (req.method() === 'POST' && url.pathname === '/v1/booth/withdraw') {
    return json(route, 200, CLAIMS['F-0047']);
  }
  return json(route, 404, {error: {code: 'not_found'}});
}

/* Assert zero visible Hangul outside translate="no" subtrees, including CSS ::before/::after content. */
async function assertNoVisibleHangul(page, label) {
  await page.waitForTimeout(80);
  const offenders = await page.evaluate(() => {
    const HANGUL = /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/;
    const isExcluded = node => {
      let cur = node && node.nodeType === 1 ? node : node && node.parentElement;
      while (cur) {
        if (cur.getAttribute && cur.getAttribute('translate') === 'no') return true;
        cur = cur.parentElement;
      }
      return false;
    };
    const isVisible = el => {
      if (!el || el.nodeType !== 1) return false;
      if (el.hidden) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const bad = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const val = (node.nodeValue || '').trim();
      if (!val || !HANGUL.test(val)) continue;
      if (isExcluded(node)) continue;
      const el = node.parentElement;
      if (!el || !isVisible(el)) continue;
      bad.push({kind: 'text', el: el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.') : ''), text: val});
    }
    for (const el of document.body.querySelectorAll('*')) {
      if (isExcluded(el) || !isVisible(el)) continue;
      for (const pseudo of ['::before', '::after']) {
        const content = getComputedStyle(el, pseudo).content || '';
        if (content && content !== 'none' && content !== 'normal' && HANGUL.test(content)) {
          bad.push({kind: pseudo, el: el.tagName + (el.id ? '#' + el.id : ''), text: content});
        }
      }
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.placeholder && HANGUL.test(el.placeholder)) {
        bad.push({kind: 'placeholder', el: el.tagName + (el.id ? '#' + el.id : ''), text: el.placeholder});
      }
    }
    return bad;
  });
  if (offenders.length) {
    console.error('Offending visible Hangul in ' + label + ':', JSON.stringify(offenders, null, 2));
  }
  assert.deepEqual(offenders, [], label + ': visible Hangul found outside translate="no": ' + JSON.stringify(offenders));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, label + ': horizontal overflow ' + overflow);
}

async function shot(page, name, tag) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, {recursive: true});
  await page.screenshot({path: path.join(shotDir, name + '-' + tag + '.png'), fullPage: true});
}

function stepIs(page, name) {
  return page.waitForFunction(v => document.documentElement.dataset.boothStep === v, name);
}

async function openPage(browser, viewport, desk, state, pageErrors) {
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 1, hasTouch: !desk, isMobile: !desk, locale: 'en-US',
  });
  await context.addInitScript(() => {
    window.__clip = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {writeText: text => { window.__clip.push(text); return Promise.resolve(); }},
    });
    window.addEventListener('DOMContentLoaded', () => {
      const api = window.FalsifyBrowserPdf || (window.FalsifyBrowserPdf = {});
      api.__origRewrite = api.rewrite;
      api.rewrite = async (sourceBytes, edits) => {
        if (window.__failEngine) throw new Error('offline');
        const marker = new TextEncoder().encode('\n% stub ' + (edits ? edits.length : 0) + '\n');
        const out = new Uint8Array(sourceBytes.length + marker.length);
        out.set(sourceBytes, 0);
        out.set(marker, sourceBytes.length);
        return out;
      };
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  page.on('pageerror', err => pageErrors.push(err.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(base)) return route.continue();
    return stubApi(route, state);
  });
  return {context, page};
}

async function lookupTicket(page, desk, receipt, key = '7Q3K-M9XD') {
  if (await page.evaluate(() => document.documentElement.dataset.boothStep !== 'pick')) {
    if (desk) await page.locator('#booth-desk-records').click();
    else {
      await page.locator('#booth-live-again').click();
      await stepIs(page, 'pick');
      await page.locator('#booth-result-link').click();
    }
  } else if (await page.locator('#booth-result').isHidden()) {
    await page.locator(desk ? '#booth-desk-records' : '#booth-result-link').click();
  }
  await page.locator('#booth-claim-receipt').fill(receipt);
  await page.locator('#booth-claim-key').fill(key);
  await page.locator('#booth-claim-form button[type="submit"]').click();
  await stepIs(page, 'ticket');
}

async function walkViewport(browser, viewport, desk, pageErrors) {
  const tag = String(viewport.width);
  const state = {offline: false, submissionsOpen: true, submitError: null};
  const {context, page} = await openPage(browser, viewport, desk, state, pageErrors);
  try {
    await page.goto(base + 'event.html');
    await page.locator('#booth-missions .booth-mission').first().waitFor();

    // Default Korean, toggle button says EN
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'ko');
    const toggleSel = desk ? '#booth-lang-desk' : '#booth-lang-pick';
    assert.equal(await page.locator(toggleSel).textContent(), 'EN');
    await page.locator(toggleSel).click();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.locator(toggleSel).textContent(), '한국어');
    assert.equal(await page.evaluate(() => localStorage.getItem('falsify.booth.lang.v1')), 'en');

    // 1. Pick + Search results
    await assertNoVisibleHangul(page, tag + ' pick');
    await shot(page, 'pick', tag);
    if (!desk) await page.locator('#booth-search-box > summary').click();
    await page.locator('#booth-search-q').fill('Ragas');
    await page.locator('#booth-search-go').click();
    await page.locator('#booth-search-results .booth-search-item').first().waitFor();
    await assertNoVisibleHangul(page, tag + ' search-results');
    await shot(page, 'search', tag);

    // Empty search
    await page.locator('#booth-search-q').fill('nomatch');
    await page.locator('#booth-search-go').click();
    await page.waitForFunction(() => /No papers found/.test(document.querySelector('#booth-search-status')?.textContent || ''));
    await assertNoVisibleHangul(page, tag + ' search-empty');

    // 2. Edit: open mission paper, verify Edit it myself tab + find-and-replace
    await page.locator('#booth-missions .booth-mission').first().click();
    await stepIs(page, 'edit');
    await page.waitForFunction(() => !!globalThis.FalsifyPaperWorkspace?.getPdfDoc?.()
      && /^5 \/ /.test(document.querySelector('#paper-page-label')?.textContent || '')
      && [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(n => n.textContent.includes('0.95')));
    assert.equal(await page.locator('#paper-before-stage').getAttribute('translate'), 'no');
    assert.equal(await page.locator('#paper-before-stage .paper-text-layer').first().getAttribute('translate'), 'no');
    await assertNoVisibleHangul(page, tag + ' edit-find');

    const pane = page.locator(desk ? '#booth-pane-find' : '#booth-find-fold');
    if (!desk && !(await pane.evaluate(n => n.open))) await pane.locator('summary').click();
    await pane.getByLabel('Find text').first().fill('0.95');
    await pane.getByLabel('Replace with').first().fill('0.50');
    await pane.getByRole('button', {name: 'Replace'}).first().click();
    await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '1 edit');
    await assertNoVisibleHangul(page, tag + ' edit-after-replace');
    await shot(page, 'edit-find', tag);

    // Toggle back to Korean mid-edit and assert Korean returns + step & edits intact!
    const editToggleSel = desk ? '#booth-lang-desk' : '#booth-lang-edit';
    await page.locator(editToggleSel).click();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'ko');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'edit');
    assert.equal(await page.locator('#booth-dock-count').textContent(), '고친 곳 1개');
    assert.equal(await page.locator('#booth-tab-find').textContent(), '직접 고치기');
    assert.equal(await page.locator('#booth-tab-myai').textContent(), '내 AI에게');
    const editsMid = await page.evaluate(() => globalThis.FalsifyBoothEdits.list());
    assert.equal(editsMid.length, 1);
    assert.equal(editsMid[0].originalText, '0.95');
    assert.equal(editsMid[0].newText, '0.50');

    // Toggle back to English
    await page.locator(editToggleSel).click();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.locator('#booth-dock-count').textContent(), '1 edit');

    // 3. Edit: Ask my AI tab (prompt copy is English, invalid JSON error is English)
    await page.locator('#booth-tab-myai').click();
    await page.locator('#booth-myai-copy').waitFor();
    await page.locator('#booth-myai-copy').click();
    await page.waitForFunction(() => window.__clip.length >= 1);
    const copiedPrompt = await page.evaluate(() => window.__clip[window.__clip.length - 1]);
    assert.match(copiedPrompt, /You are setting a puzzle/);
    assert.match(copiedPrompt, /Answer with the JSON object only/);
    assert.doesNotMatch(copiedPrompt, /[\uac00-\ud7a3]/, 'copied Ask my AI prompt must be English in EN mode');
    await assertNoVisibleHangul(page, tag + ' edit-myai');
    await shot(page, 'edit-myai', tag);

    // Invalid JSON error on Ask my AI
    await page.locator('#booth-myai-answer').fill('{"edits": [{"find": "0.95" "replace": "0.50"}]}');
    await page.locator('#booth-myai-apply').click();
    await page.locator('.booth-myai-diag.error').first().waitFor();
    await assertNoVisibleHangul(page, tag + ' edit-myai-error');
    // Blur textarea (phone hides the dock while typing) before clicking Next
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    await page.locator('#booth-next').waitFor({state: 'visible'});

    // Engine unavailable error on Next
    await page.evaluate(() => { window.__failEngine = true; });
    await page.locator('#booth-next').click();
    await page.waitForFunction(() => /Could not load the PDF editor/.test(document.querySelector('#booth-dock-status')?.textContent || ''));
    await assertNoVisibleHangul(page, tag + ' edit-engine-error');
    await page.evaluate(() => { window.__failEngine = false; });

    // 4. Send step
    await page.locator('#booth-next').click();
    await stepIs(page, 'send');
    const card = page.locator('#booth-rows .booth-card').first();
    await card.getByRole('button', {name: 'Numbers & stats'}).click();
    await card.locator('textarea').fill('Changed Ragas faithfulness from 0.95 to 0.50.');
    await page.waitForSelector('.booth-recipe-compare canvas', {timeout: 15000}).catch(() => {});
    assert.equal(await page.locator('.booth-recipe-shot').first().getAttribute('translate'), 'no');
    await assertNoVisibleHangul(page, tag + ' send');
    await shot(page, 'send', tag);

    // Rate-limited error on submit
    state.submitError = {status: 429, code: 'rate_limited'};
    await page.locator('#booth-submit-button').click();
    await page.waitForFunction(() => /Submissions are busy|Too many requests/.test(document.querySelector('#booth-submit-status')?.textContent || ''));
    await assertNoVisibleHangul(page, tag + ' send-rate-limited');
    state.submitError = null;

    // 5. Submit -> Receipt & pending
    await page.locator('#booth-submit-button').click();
    await stepIs(page, 'ticket');
    assert.equal(await page.locator('#booth-receipt-code').textContent(), 'F-0042');
    assert.equal(await page.locator('#booth-receipt-code').getAttribute('translate'), 'no');
    assert.equal(await page.locator('#booth-claim-code').getAttribute('translate'), 'no');
    await assertNoVisibleHangul(page, tag + ' ticket-pending');
    await shot(page, 'ticket-pending', tag);

    // 6. Results: caught (with AI note line), partial, missed, missedNone, withdrawn
    await page.evaluate(() => {
      const edits = [{page: 5, before: 'Ragas 0.95 0.78 0.70', after: 'Ragas 0.50 0.78 0.70'}];
      for (const r of ['F-0043', 'F-0044', 'F-0045', 'F-0046', 'F-0047']) {
        globalThis.FalsifyBooth.rememberReceipt(localStorage, {
          receipt: r, claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:00:00.000Z',
          title: 'Ragas', pages: [5], count: 1, edits,
        });
      }
    });

    // Open My tickets first and check + screenshot
    if (desk) await page.locator('#booth-desk-records').click();
    else {
      await page.goto(base + 'event.html#booth-result');
      await page.locator('#booth-claim-form').waitFor();
    }
    await assertNoVisibleHangul(page, tag + ' records');
    await shot(page, 'records', tag);

    // Lookup not_found error
    await page.locator('#booth-claim-receipt').fill('F-9999');
    await page.locator('#booth-claim-key').fill('7Q3K-M9XD');
    await page.locator('#booth-claim-form button[type="submit"]').click();
    await page.waitForFunction(() => /double-check your ticket no/.test(document.querySelector('#booth-result-error')?.textContent || ''));
    await assertNoVisibleHangul(page, tag + ' records-not-found');

    // Caught with AI note
    await lookupTicket(page, desk, 'F-0043');
    await page.waitForFunction(() => document.querySelector('#booth-live-title')?.textContent === 'AI caught it');
    assert.equal(await page.locator('#booth-live-note .booth-opinion-en').isVisible(), true, 'English AI note visible');
    assert.equal(await page.locator('#booth-live-note .booth-opinion-ko').isVisible(), false, 'Korean AI opinion hidden in EN');
    assert.equal(await page.locator('#booth-live-note .booth-quote').getAttribute('translate'), 'no');
    await assertNoVisibleHangul(page, tag + ' result-caught');
    await shot(page, 'result-caught', tag);

    // Partial with AI note
    await lookupTicket(page, desk, 'F-0044');
    await page.waitForFunction(() => document.querySelector('#booth-live-title')?.textContent === 'AI got close');
    assert.equal(await page.locator('#booth-live-note .booth-opinion-en').isVisible(), true);
    assert.equal(await page.locator('#booth-live-note .booth-opinion-ko').isVisible(), false);
    await assertNoVisibleHangul(page, tag + ' result-partial');
    await shot(page, 'result-partial', tag);

    // Missed with prize message
    await lookupTicket(page, desk, 'F-0045');
    await page.waitForFunction(() => document.querySelector('#booth-live-title')?.textContent === 'AI missed it');
    assert.match(await page.locator('#booth-live-prize').textContent(), /AI missed it! Show this screen to booth staff/);
    await assertNoVisibleHangul(page, tag + ' result-missed');
    await shot(page, 'result-missed', tag);

    // Withdraw confirm dialog on missed ticket
    await page.locator('#booth-withdraw-box > summary').click();
    await page.locator('#booth-withdraw').click();
    await page.locator('#booth-withdraw-ask').waitFor({state: 'visible'});
    await assertNoVisibleHangul(page, tag + ' withdraw-confirm');
    await shot(page, 'withdraw-confirm', tag);
    await page.locator('#booth-withdraw-cancel').click();

    // MissedNone
    await lookupTicket(page, desk, 'F-0046');
    await page.waitForFunction(() => /found no defect/.test(document.querySelector('#booth-live-note')?.textContent || ''));
    await assertNoVisibleHangul(page, tag + ' result-missedNone');

    // Withdrawn
    await lookupTicket(page, desk, 'F-0047');
    await page.waitForFunction(() => document.querySelector('#booth-live-title')?.textContent === 'Submission withdrawn');
    await assertNoVisibleHangul(page, tag + ' result-withdrawn');
    await shot(page, 'result-withdrawn', tag);
  } finally {
    await context.close();
  }
}

async function kioskAndErrorsPass(browser, pageErrors) {
  // Kiosk mode at 1280x800: idle warning, handoff dialog, handoff resets lang to Korean
  const state = {offline: false, submissionsOpen: true, submitError: null};
  const {context, page} = await openPage(browser, {width: 1280, height: 800}, true, state, pageErrors);
  try {
    await page.clock.install({time: new Date('2026-11-22T01:00:00.000Z')});
    await page.goto(base + 'event.html?kiosk=1');
    await page.locator('#booth-missions .booth-mission').first().waitFor();
    await page.locator('#booth-lang-desk').click();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('falsify.booth.lang.v1')), 'en');
    assert.equal(await page.evaluate(() => localStorage.getItem('falsify.booth.lang.v1')), null);

    // Trigger idle dialog
    await page.locator('#booth-search-q').click();
    await page.clock.fastForward(160000);
    await page.locator('#booth-idle-dialog').waitFor({state: 'visible'});
    await assertNoVisibleHangul(page, 'kiosk-idle');
    await shot(page, 'kiosk-idle', '1280');
    await page.locator('#booth-idle-dialog-stay').click();

    // Trigger handoff dialog & confirm handoff resets language to Korean
    await page.locator('#booth-handoff-desk').click();
    await page.locator('#booth-handoff-dialog').waitFor({state: 'visible'});
    await assertNoVisibleHangul(page, 'kiosk-handoff');
    await shot(page, 'kiosk-handoff', '1280');
    await Promise.all([
      page.waitForURL(base + 'event.html?kiosk=1'),
      page.locator('#booth-handoff-dialog-go').click(),
    ]);
    await page.locator('#booth-missions .booth-mission').first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'ko', 'kiosk handoff resets to Korean');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('falsify.booth.lang.v1')), null);
  } finally {
    await context.close();
  }

  // Offline & booth_closed error states in EN mode (390x844)
  const closedState = {offline: false, submissionsOpen: false, submitError: null};
  const closed = await openPage(browser, {width: 390, height: 844}, false, closedState, pageErrors);
  try {
    await closed.page.addInitScript(() => { localStorage.setItem('falsify.booth.lang.v1', 'en'); });
    await closed.page.goto(base + 'event.html');
    await closed.page.waitForFunction(() => /Submissions are closed/.test(document.querySelector('#booth-status')?.textContent || ''));
    await assertNoVisibleHangul(closed.page, '390 booth-closed');
    // Offline config retry: go offline when /v1/booth/config is fetched
    closedState.onConfig = async route => {
      closedState.onConfig = null;
      closedState.offline = true;
      await closed.context.setOffline(true);
      return route.abort('internetdisconnected');
    };
    await closed.page.reload();
    await closed.page.waitForFunction(() => /You are offline/.test(document.querySelector('#booth-status')?.textContent || ''));
    await assertNoVisibleHangul(closed.page, '390 offline');
    await shot(closed.page, 'offline', '390');
  } finally {
    await closed.context.close();
  }
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  const pageErrors = [];
  try {
    await server.ready;
    browser = await chromium.launch({
      executablePath: chrome, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    await walkViewport(browser, {width: 390, height: 844}, false, pageErrors);
    await walkViewport(browser, {width: 1280, height: 800}, true, pageErrors);
    await kioskAndErrorsPass(browser, pageErrors);
    assert.equal(pageErrors.join('\n'), '', 'unexpected page errors');
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth i18n browser passed'); }, error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
