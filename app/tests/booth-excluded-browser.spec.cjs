'use strict';
// Real Chromium verification of pre-edit notice, excluded per-edit verdicts with KO/EN rationales,
// mixed ticket/gallery counts, all-excluded aggregate invalid label (판정 제외), and preserved manual invalid.
// Verifies mobile (360, 390) and desktop (1280) in KO & EN (including live toggle), zero overflow, zero Hangul leak.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_EXCLUDED_PORT || 0);
let base = '';
const token = 'fsg_' + 'e'.repeat(43);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const THREE_EDITS = [
  {page: 5, before: 'Ragas 0.95 0.78 0.70', after: 'Ragas 0.50 0.78 0.70'},
  {page: 2, before: 'we used 12 annotators', after: 'we used 30 annotators'},
  {page: 3, before: 'utilize the model', after: 'use the model'},
];

const CLAIMS = {
  'F-0901': {
    receipt: 'F-0901', status: 'judged', course: 'quick', declaredCount: 3,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:40.000Z',
    published: true, outcome: 'missed',
    publicNote: '심어 둔 결함 중 일부는 AI가 찾았어요.',
    prizeMessage: 'AI가 놓쳤어요! 부스 스태프에게 이 화면을 보여 주면 작은 선물을 드려요.',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught', evidence: {
        quote: 'Ragas 0.50 0.78 0.70',
        rationale: '표 1 충실도 0.50이 본문 결론과 어긋나요.',
        rationaleEn: 'Table 1 faithfulness 0.50 contradicts the conclusion.',
      }},
      {index: 1, pageIndex: 1, verdict: 'missed'},
      {index: 2, pageIndex: 2, verdict: 'excluded', evidence: {
        rationale: '문맥상 뜻이 같은 단어 교체라 판정에서 제외됐어요.',
        rationaleEn: 'Excluded as a contextual synonym swap.',
      }},
    ],
  },
  'F-0902': {
    receipt: 'F-0902', status: 'invalid', course: 'quick', declaredCount: 3,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:50.000Z',
    published: true, outcome: 'invalid',
    publicNote: '이번 제출은 결함 판정 기준에 해당하지 않아 무효로 처리되었어요.',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'excluded', evidence: {rationale: '단순 오타 수정이에요.', rationaleEn: 'Simple typo edit only.'}},
      {index: 1, pageIndex: 1, verdict: 'excluded', evidence: {rationale: '문맥상 같은 뜻의 단어 교체예요.', rationaleEn: 'Same-meaning word swap.'}},
      {index: 2, pageIndex: 2, verdict: 'excluded', evidence: {rationale: '표현만 다듬은 수정이에요.', rationaleEn: 'Stylistic phrasing change only.'}},
    ],
  },
  'F-0903': {
    receipt: 'F-0903', status: 'invalid', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:55.000Z',
    published: true, outcome: 'invalid',
    publicNote: '원본과 동일한 파일이에요.',
  },
};

const MIXED_GALLERY_ENTRY = {
  paperKey: '2309.15217',
  paper: {id: '2309.15217v1', title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation', source: 'mission', license: 'cc-by-4.0'},
  round: 'live', outcome: 'missed', assist: 'manual',
  edits: [
    {index: 0, pageIndex: 4, defectType: 'number', before: '0.95', after: '0.50', verdict: 'caught', evidence: {quote: '0.50', rationale: '표 1 수치 모순', rationaleEn: 'Table 1 numeric conflict'}},
    {index: 1, pageIndex: 1, defectType: 'logic', before: '12 annotators', after: '30 annotators', verdict: 'missed'},
    {index: 2, pageIndex: 2, defectType: 'other', before: 'utilize the model', after: 'use the model', verdict: 'excluded', evidence: {rationale: '동의어 교체라 제외됐어요.', rationaleEn: 'Excluded as a synonym swap.'}},
  ],
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
};

function serve() {
  const server = http.createServer((req, res) => {
    const clean = (req.url || '/').split('?')[0];
    const rel = clean === '/' ? 'event.html' : clean.replace(/^\/+/, '');
    const full = path.resolve(dist, rel);
    if (!full.startsWith(dist + path.sep) && full !== dist) { res.writeHead(403); res.end(); return; }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {'Content-Type': MIME[path.extname(full)] || 'application/octet-stream'});
      res.end(data);
    });
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port + '/';
      resolve();
    });
  });
  return {close: () => server.close(), ready};
}

function json(route, status, body) {
  return route.fulfill({status, contentType: 'application/json', headers: cors, body: JSON.stringify(body)});
}

async function stubApi(route) {
  const req = route.request();
  const url = new URL(req.url());
  if (!url.href.startsWith(api)) return route.abort();
  if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
  if (req.method() === 'POST' && url.pathname === '/v1/ai/guest') {
    return json(route, 200, {guest: {token, expiresAt: '2099-01-01T00:00:00.000Z'}});
  }
  if (url.pathname === '/v1/booth/config') {
    const auth = req.headers().authorization || '';
    const cfg = {
      enabled: true, submissionsOpen: true, announcement: '',
      consentVersion: '2026-11-22.v3',
      features: {gallery: true, forfeit: true, paperBlock: false},
      limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216, perOwner: 3},
      missions: [{
        paperId: '2309.15217',
        title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
        license: 'cc-by-4.0', course: 'quick', pageHint: 5,
        hint: 'Table 1의 점수 하나를 바꿔 보세요',
      }],
    };
    if (auth) cfg.ownerState = {used: 3, perOwner: 3, unlocked: true};
    return json(route, 200, cfg);
  }
  if (url.pathname === '/v1/booth/leaderboard/summary') {
    return json(route, 200, {judged: 10, missed: 3, pending: 0, conqueredCount: 1, conqueredPapers: []});
  }
  if (url.pathname === '/v1/booth/leaderboard') {
    return json(route, 200, {entries: [MIXED_GALLERY_ENTRY], nextCursor: null});
  }
  if (url.pathname === '/v1/booth/claim' && (req.method() === 'GET' || req.method() === 'POST')) {
    const r = req.method() === 'GET' ? url.searchParams.get('receipt') : JSON.parse(req.postData() || '{}').receipt;
    if (CLAIMS[r]) return json(route, 200, CLAIMS[r]);
    return json(route, 404, {error: {code: 'not_found'}});
  }
  return json(route, 404, {error: {code: 'not_found'}});
}

async function assertClean(page, label, isEn) {
  await page.waitForTimeout(80);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, label + ': horizontal overflow ' + overflow);
  if (!isEn) return;
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
      if (!el || el.nodeType !== 1 || el.hidden) return false;
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
      if (!val || !HANGUL.test(val) || isExcluded(node)) continue;
      const el = node.parentElement;
      if (el && isVisible(el)) bad.push({el: el.tagName + '#' + el.id, text: val});
    }
    return bad;
  });
  assert.deepEqual(offenders, [], label + ': visible Hangul in EN mode: ' + JSON.stringify(offenders));
}

async function lookup(page, desk, receipt) {
  if (await page.evaluate(() => document.documentElement.dataset.boothStep !== 'pick')) {
    if (desk) await page.locator('#booth-desk-records').click();
    else {
      await page.locator('#booth-live-again').click();
      await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'pick');
      if (await page.locator('#booth-result').isHidden()) await page.locator('#booth-result-link').click();
    }
  } else if (await page.locator('#booth-result').isHidden()) {
    await page.locator(desk ? '#booth-desk-records' : '#booth-result-link').click();
  }
  await page.locator('#booth-claim-receipt').fill(receipt);
  await page.locator('#booth-claim-key').fill('7Q3K-M9XD');
  await page.locator('#booth-claim-form button[type="submit"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'ticket');
}

async function runViewport(browser, viewport, desk, lang) {
  const isEn = lang === 'en';
  const tag = `${lang}-${viewport.width}`;
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 1, hasTouch: !desk, isMobile: !desk, locale: isEn ? 'en-US' : 'ko-KR',
  });
  await context.addInitScript(({isEn, THREE_EDITS}) => {
    if (isEn) localStorage.setItem('falsify.booth.lang.v1', 'en');
    else localStorage.removeItem('falsify.booth.lang.v1');
    localStorage.setItem('falsify.booth.receipts.v1', JSON.stringify([
      {receipt: 'F-0901', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00.000Z', title: 'Ragas', pages: [2, 3, 5], count: 3, edits: THREE_EDITS},
      {receipt: 'F-0902', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:01.000Z', title: 'Ragas', pages: [2, 3, 5], count: 3, edits: THREE_EDITS},
      {receipt: 'F-0903', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:02.000Z', title: 'Ragas', pages: [5], count: 1, edits: [THREE_EDITS[0]]},
    ]));
  }, {isEn, THREE_EDITS});
  const page = await context.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : stubApi(route));

  try {
    await page.goto(base + 'event.html');
    await page.locator('#booth-missions .booth-mission').first().waitFor();

    // 1. Pre-edit notice on edit step (simulated step transition check + KO/EN text)
    await page.evaluate(() => {
      document.getElementById('booth-step-pick').hidden = true;
      document.getElementById('booth-step-edit').hidden = false;
      document.documentElement.dataset.boothStep = 'edit';
    });
    const notice = page.locator('#booth-edit-notice');
    assert.equal(await notice.isVisible(), true, `${tag} pre-edit notice visible`);
    assert.equal(
      await notice.textContent(),
      isEn
        ? 'Simple typos or swapping in words with the same contextual meaning may not count as a pass.'
        : '단순 오타나 문맥상 뜻이 같은 단어 교체는 통과로 인정되지 않을 수 있어요.',
    );
    await assertClean(page, `${tag} edit-notice`, isEn);
    await page.evaluate(() => {
      document.getElementById('booth-step-edit').hidden = true;
      document.getElementById('booth-step-pick').hidden = false;
      document.documentElement.dataset.boothStep = 'pick';
    });

    // 2. Mixed 3-edit ticket (1 caught, 1 missed, 1 excluded)
    await lookup(page, desk, 'F-0901');
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, isEn ? '1 of 2 slipped past the AI' : '2개 중 1개가 AI 눈을 피했어요');
    assert.equal(await page.locator('#booth-live-excluded').isVisible(), true);
    assert.equal(await page.locator('#booth-live-excluded').textContent(), isEn ? '2 judged · 1 excluded' : '판정 대상 2곳 · 판정 제외 1곳');
    const exItem = page.locator('#booth-live-declared .booth-declared-item[data-edit-index="2"]');
    assert.equal(await exItem.locator('.booth-edit-verdict.excluded').textContent(), isEn ? 'Excluded' : '판정 제외');
    assert.equal(await exItem.locator('blockquote').count(), 0);
    assert.equal(await exItem.locator(isEn ? '.booth-opinion-en' : '.booth-opinion-ko').isVisible(), true);
    await assertClean(page, `${tag} F-0901`, isEn);

    // 3. All-excluded 3-edit invalid ticket -> 판정 제외 / Excluded + all 3 explanations + live toggle
    await lookup(page, desk, 'F-0902');
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, isEn ? 'All 3 were excluded' : '3개 모두 판정 제외예요');
    assert.equal(await page.locator('#booth-stamp-word').textContent(), isEn ? 'Excluded' : '판정 제외');
    assert.equal(await page.locator('#booth-live-excluded').isVisible(), false);
    assert.equal(await page.locator('#booth-live-declared .booth-declared-item').count(), 3);
    assert.equal(await page.locator('#booth-live-declared .booth-edit-verdict.excluded').count(), 3);
    assert.equal(await page.locator(`#booth-live-declared ${isEn ? '.booth-opinion-en' : '.booth-opinion-ko'}`).count(), 3);
    await assertClean(page, `${tag} F-0902`, isEn);

    // Live KO<->EN toggle on all-excluded ticket
    const toggleSel = desk ? '#booth-lang-desk' : '#booth-lang-ticket';
    await page.locator(toggleSel).click();
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, !isEn ? 'All 3 were excluded' : '3개 모두 판정 제외예요');
    assert.equal(await page.locator(`#booth-live-declared ${!isEn ? '.booth-opinion-en' : '.booth-opinion-ko'}`).first().isVisible(), true);
    await assertClean(page, `${tag} F-0902 toggled`, !isEn);
    await page.locator(toggleSel).click();

    // 4. Manual invalid without edits -> 무효 / VOID preserved
    await lookup(page, desk, 'F-0903');
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, isEn ? 'This entry was voided' : '이번 도전은 무효로 끝났어요');
    assert.equal(await page.locator('#booth-stamp-word').textContent(), isEn ? 'VOID' : '무효');
    assert.equal(await page.locator('#booth-live-findings').isVisible(), false);
    assert.equal(await page.locator('#booth-live-declared .booth-edit-verdict').count(), 0);
    assert.equal(await page.locator('#booth-live-note .booth-klab').textContent(), isEn ? 'Staff note' : '운영진 안내');

    // 5. Mixed gallery card in leaderboard
    await page.locator('#booth-live-leaderboard').click();
    await page.locator('#booth-lb-list .booth-lb-card').first().waitFor({state: 'visible'});
    const card = page.locator('#booth-lb-list .booth-lb-card').first();
    assert.match(await card.textContent(), isEn ? /2 judged · 1 excluded/ : /판정 대상 2곳 · 판정 제외 1곳/);
    assert.equal(await card.locator('.booth-edit-verdict.excluded').textContent(), isEn ? 'Excluded' : '판정 제외');
    assert.equal(await card.locator(isEn ? '.booth-opinion-en' : '.booth-opinion-ko').nth(1).isVisible(), true);
    await assertClean(page, `${tag} gallery-mixed`, isEn);

    assert.deepEqual(errs, [], `${tag} page errors`);
  } finally {
    await context.close();
  }
}

async function runOtherDeviceAllExcluded(browser, viewport, desk, lang) {
  const isEn = lang === 'en';
  const tag = `other-${lang}-${viewport.width}`;
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 1, hasTouch: !desk, isMobile: !desk, locale: isEn ? 'en-US' : 'ko-KR',
  });
  await context.addInitScript(en => {
    if (en) localStorage.setItem('falsify.booth.lang.v1', 'en');
    else localStorage.removeItem('falsify.booth.lang.v1');
    localStorage.removeItem('falsify.booth.receipts.v1');
  }, isEn);
  const page = await context.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : stubApi(route));

  try {
    await page.goto(base + 'event.html');
    await page.locator('#booth-missions .booth-mission').first().waitFor();
    await lookup(page, desk, 'F-0902');
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, isEn ? 'All 3 were excluded' : '3개 모두 판정 제외예요');
    assert.equal(await page.locator('#booth-live-declared').isVisible(), false);
    assert.equal(await page.locator('#booth-live-findings').isVisible(), true);
    assert.equal(await page.locator('#booth-live-findings .booth-declared-item').count(), 3);
    assert.equal(await page.locator('#booth-live-findings .booth-edit-verdict.excluded').count(), 3);
    assert.equal(await page.locator(`#booth-live-findings ${isEn ? '.booth-opinion-en' : '.booth-opinion-ko'}`).first().isVisible(), true);
    await assertClean(page, `${tag} F-0902`, isEn);
    assert.deepEqual(errs, [], `${tag} page errors`);
  } finally {
    await context.close();
  }
}

async function main() {
  const server = serve();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({
      executablePath: chrome, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    for (const lang of ['ko', 'en']) {
      await runViewport(browser, {width: 360, height: 740}, false, lang);
      await runViewport(browser, {width: 390, height: 844}, false, lang);
      await runViewport(browser, {width: 1280, height: 800}, true, lang);
      await runOtherDeviceAllExcluded(browser, {width: 390, height: 844}, false, lang);
      await runOtherDeviceAllExcluded(browser, {width: 1280, height: 800}, true, lang);
    }
    console.log('booth-excluded-browser: 360/390/1280 KO+EN (same & other device) all passed');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
