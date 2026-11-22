'use strict';
// Real Chromium verification of Booth v2 leaderboard, opt-in gallery consent,
// 5-edit evidence cards, cancel/back navigation, mobile/desktop/EN layouts,
// and first-30 LIVE prize + separate FINAL raffle notices.
const {spawn} = require('node:child_process');
const {mkdirSync} = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_V2_PORT || 19628);
const base = 'http://127.0.0.1:' + port + '/';
const shotDir = process.env.BOOTH_V2_SHOTS ? path.resolve(process.env.BOOTH_V2_SHOTS) : '';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const json = (route, status, body) => route.fulfill({status, contentType: 'application/json', headers: cors, body: JSON.stringify(body)});

const SUMMARY = {
  judged: 24, missed: 6, pending: 3, conqueredCount: 2,
  bySource: {mission: {judged: 18, missed: 4}, arxiv: {judged: 6, missed: 2}},
  byDefectType: {number: {judged: 10, missed: 2}, logic: {judged: 8, missed: 3}, method: {judged: 6, missed: 1}},
  byAssist: {manual: {judged: 16, missed: 4}, 'my-ai': {judged: 5, missed: 1}, agent: {judged: 3, missed: 1}},
  conqueredPapers: [
    {paperKey: '2309.15217', title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation'},
    {paperKey: '2410.06145', title: 'Evaluating Long-Context Reasoning in Open Models'},
  ],
};

const FIVE_EDITS = [0, 1, 2, 3, 4].map(i => ({
  index: i,
  pageIndex: i + 1,
  defectType: ['number', 'figure', 'logic', 'method', 'citation'][i],
  before: `Table ${i + 1} reports accuracy 0.9${i} across all folds.`,
  after: `Table ${i + 1} reports accuracy 0.4${i} across all folds.`,
  verdict: i === 4 ? 'missed' : (i === 3 ? 'partial' : 'caught'),
  ...(i < 4 ? {
    evidence: {
      quote: `Table ${i + 1} reports accuracy 0.4${i} across all folds.`,
      rationale: `결함 ${i + 1}의 수치가 본문 설명과 모순돼요.`,
      rationaleEn: `Defect ${i + 1} contradicts the surrounding text.`,
    },
  } : {}),
}));

const ENTRY_1 = {
  receipt: 'F-8888', // must never render on another visitor's card
  paperKey: '2309.15217',
  paper: {id: '2309.15217v1', title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation', source: 'mission', license: 'cc-by-4.0'},
  round: 'final', outcome: 'missed', assist: 'my-ai',
  edits: FIVE_EDITS,
};

const ENTRY_2 = {
  paperKey: '2410.06145',
  paper: {id: '2410.06145v2', title: 'Evaluating Long-Context Reasoning in Open Models', source: 'arxiv', license: 'cc0-1.0'},
  round: 'live', outcome: 'caught', assist: 'manual',
  edits: [{
    index: 0, pageIndex: 2, defectType: 'logic',
    before: 'We evaluate zero-shot transfer without fine-tuning.',
    after: 'We evaluate transfer after 50 epochs of supervised fine-tuning.',
    verdict: 'caught',
    evidence: {
      quote: 'We evaluate transfer after 50 epochs of supervised fine-tuning.',
      rationale: '초록의 zero-shot 주장과 실험 설정이 충돌해요.',
      rationaleEn: 'Contradicts the zero-shot claim in the abstract.',
    },
  }],
};

const CLAIM_MISSED = {
  receipt: 'F-0100', status: 'judged', course: 'quick', declaredCount: 1,
  createdAt: '2026-11-22T01:00:00.000Z', published: true, outcome: 'missed',
  publicNote: 'AI가 이번 수정본에서 결함을 짚지 못했어요. 심어 둔 결함은 AI 눈을 피했어요.',
  prizeMessage: 'AI가 놓쳤어요! 부스 스태프에게 이 화면을 보여 주면 작은 선물을 드려요.',
  galleryConsent: false,
  publishedAt: '2026-11-22T01:02:15.000Z',
};

function startServer() {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {cwd: dist, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = (async () => {
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await fetch(base + 'event.html');
        if (res.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('http.server did not start\n' + stderr);
  })();
  return {child, ready};
}

async function assertNoOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  assert.ok(metrics.scrollW <= metrics.innerW + 1, `${label}: horizontal overflow ${metrics.scrollW} > ${metrics.innerW}`);
}

async function assertNoLeakedHangulInEn(page, label) {
  const leaks = await page.evaluate(() => {
    const out = [];
    const root = document.getElementById('booth');
    if (!root) return out;
    const walk = node => {
      if (node.nodeType === 1) {
        if (node.hidden) return;
        const st = getComputedStyle(node);
        if (st.display === 'none' || st.visibility === 'hidden') return;
        if (node.getAttribute('translate') === 'no') return;
        for (const kid of node.childNodes) walk(kid);
      } else if (node.nodeType === 3) {
        const t = (node.nodeValue || '').trim();
        if (t && /[가-힣]/.test(t)) out.push(t);
      }
    };
    walk(root);
    return out;
  });
  assert.deepEqual(leaks, [], `${label}: Hangul leaked in EN mode: ${JSON.stringify(leaks)}`);
}

async function shot(page, name) {
  if (!shotDir) return;
  mkdirSync(shotDir, {recursive: true});
  await page.screenshot({path: path.join(shotDir, name + '.png'), fullPage: true});
}

async function verifyViewport(browser, w, h, tag) {
  const page = await browser.newPage({viewport: {width: w, height: h}});
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.clock.install({time: new Date('2026-11-22T01:05:00.000Z')});
  await page.addInitScript(() => {
    localStorage.setItem('falsify.booth.receipts.v1', JSON.stringify([{
      receipt: 'F-0100', claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:00:00.000Z',
      title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
      pages: [5], count: 1, edits: [{page: 5, before: '0.95', after: '0.50'}], outcome: 'missed',
    }]));
  });

  let unlocked = false;
  let unlockCalls = 0;
  let guestCalls = 0;
  let consentCalls = [];
  let lbCalls = 0;
  let ticketConsent = false;

  await page.route('**/*', route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.url().startsWith(base)) return route.continue();
    if (!url.href.startsWith(api)) return route.abort();
    if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
    if (url.pathname === '/v1/booth/config') {
      const auth = req.headers().authorization || '';
      const cfg = {
        enabled: true, submissionsOpen: true, consentVersion: '2026-11-22.v3',
        features: {gallery: true, forfeit: true, paperBlock: false},
        limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216, perOwner: 3},
        missions: [{id: 'ragas', paperId: '2309.15217', title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation', license: 'cc-by-4.0', pageHint: 5, hint: 'Table 1의 점수 하나를 바꿔 보세요'}],
      };
      if (auth) cfg.ownerState = {used: 1, perOwner: 3, unlocked};
      return json(route, 200, cfg);
    }
    if (url.pathname === '/v1/booth/leaderboard/summary') return json(route, 200, SUMMARY);
    if (req.method() === 'POST' && url.pathname === '/v1/ai/guest') {
      guestCalls += 1;
      return json(route, 200, {guest: {token: 'fsg_' + 'a'.repeat(43), expiresAt: '2026-11-23T00:00:00Z'}});
    }
    if (req.method() === 'POST' && url.pathname === '/v1/booth/leaderboard/unlock') {
      unlockCalls += 1;
      unlocked = true;
      return json(route, 200, {unlocked: true});
    }
    if (url.pathname === '/v1/booth/leaderboard') {
      lbCalls += 1;
      if (!unlocked) return json(route, 403, {error: {code: 'leaderboard_locked'}});
      if (url.searchParams.get('cursor') === 'c2') return json(route, 200, {entries: [ENTRY_2], nextCursor: null});
      if (lbCalls === 1) return json(route, 200, {entries: [], nextCursor: null});
      return json(route, 200, {entries: [ENTRY_1], nextCursor: 'c2'});
    }
    if (url.pathname === '/v1/booth/claim') return json(route, 200, Object.assign({}, CLAIM_MISSED, {galleryConsent: ticketConsent}));
    if (req.method() === 'POST' && url.pathname === '/v1/booth/gallery-consent') {
      const body = JSON.parse(req.postData() || '{}');
      consentCalls.push(body);
      ticketConsent = body.galleryConsent === true;
      return json(route, 200, {galleryConsent: ticketConsent});
    }
    return json(route, 404, {error: {code: 'not_found'}});
  });

  // 1. Cold load with a fresh receipt (<15m): resumeLatest opens ticket directly without minting guest session.
  await page.goto(base + 'event.html#booth');
  await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'ticket' && document.querySelector('#booth-live-title')?.textContent);
  assert.equal(guestCalls, 0, `${tag}: boot/ticket mints no guest session`);
  assert.match(await page.locator('#booth-gift').textContent(), /먼저 승리한 선착순 30분께 부스에서 드려요/);
  assert.match(await page.locator('#booth-final').textContent(), /현장 선착순 30명 선물과 별도로/);
  assert.equal(await page.locator('#booth-ticket-consent-input').isChecked(), false, `${tag}: ticket consent default unchecked`);
  await assertNoOverflow(page, tag + ' ticket-ko');

  // Toggle ticket consent ON -> calls gallery-consent, does not unlock.
  await page.locator('#booth-ticket-consent-input').check();
  await page.waitForFunction(() => /공개하도록 바꿨어요/.test(document.querySelector('#booth-ticket-consent-status')?.textContent || ''));
  assert.equal(consentCalls.length, 1);
  assert.equal(consentCalls[0].galleryConsent, true);
  assert.equal(unlockCalls, 0);
  await shot(page, `${tag}-ticket-ko`);

  // Open leaderboard from ticket -> shows forfeit gate -> Cancel returns cleanly to ticket without unlock.
  await page.locator('#booth-live-leaderboard').click();
  await page.locator('#booth-lb-gate').waitFor({state: 'visible'});
  assert.equal(await page.locator('#booth-lb-unlock-go').textContent(), '기회 2번 포기하고 보기');
  assert.equal(unlockCalls, 0);
  const goBox = await page.locator('#booth-lb-unlock-go').boundingBox();
  assert.ok(goBox && goBox.height >= 44, `${tag}: unlock button >= 44px`);
  await assertNoOverflow(page, tag + ' gate-ko');
  await shot(page, `${tag}-gate-ko`);

  await page.locator('#booth-lb-unlock-cancel').click();
  await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'ticket');
  assert.equal(unlockCalls, 0, `${tag}: cancel never calls unlock`);

  // Return to pick landing and verify hero copy & teaser stats.
  await page.locator('#booth-live-again').click();
  await page.locator('#booth-pick-leaderboard').waitFor({state: 'visible'});
  assert.match(await page.locator('#booth-landing').textContent(), /먼저 승리한 선착순 30분\(1인 1회\)께 부스에서 선물을 드려요/);
  assert.match(await page.locator('#booth-lb-teaser-stats').textContent(), /정복 2편 · 판정 24건 · LIVE 통과율 25%/);
  await assertNoOverflow(page, tag + ' pick-ko');

  // Open leaderboard -> confirm unlock -> first call returns [] -> staff example card visible!
  await page.locator('#booth-pick-leaderboard').click();
  await page.locator('#booth-lb-unlock-go').waitFor({state: 'visible'});
  await page.locator('#booth-lb-unlock-go').click();
  await page.locator('#booth-lb-feed').waitFor({state: 'visible'});
  assert.equal(unlockCalls, 1);
  assert.equal(await page.locator('#booth-lb-example-note').isVisible(), true);
  assert.match(await page.locator('#booth-lb-list').textContent(), /운영진 예시/);

  // Go back via button, reopen -> now loads 5-edit entry + nextCursor.
  await page.locator('#booth-lb-back').click();
  await page.locator('#booth-landing').waitFor({state: 'visible'});
  await page.locator('#booth-pick-leaderboard').click();
  await page.waitForFunction(() => (document.querySelector('#booth-lb-list')?.textContent || '').includes('결함 5 · 6쪽'));
  const listText = await page.locator('#booth-lb-list').textContent();
  assert.equal(listText.includes('F-8888'), false, `${tag}: receipt hidden on other visitors cards`);
  assert.match(listText, /FINAL 판정/);
  for (let i = 1; i <= 4; i += 1) assert.match(listText, new RegExp(`결함 ${i}의 수치가 본문 설명과 모순돼요`));
  await assertNoOverflow(page, tag + ' gallery-ko');
  await shot(page, `${tag}-gallery-ko`);

  // Pagination: load more appends ENTRY_2.
  await page.locator('#booth-lb-more').click();
  await page.waitForFunction(() => (document.querySelector('#booth-lb-list')?.textContent || '').includes('Evaluating Long-Context'));

  // Switch to EN -> verify zero leaked Hangul, English rationales visible, no overflow!
  await page.evaluate(() => globalThis.FalsifyBoothI18n.setLang('en'));
  await page.waitForFunction(() => document.documentElement.lang === 'en' && (document.querySelector('#booth-lb-list')?.textContent || '').includes('FINAL round'));
  await assertNoOverflow(page, tag + ' gallery-en');
  await assertNoLeakedHangulInEn(page, tag + ' gallery-en');
  const enVisibleRationale = await page.locator('#booth-lb-list .booth-opinion-en').first().isVisible();
  assert.equal(enVisibleRationale, true, `${tag}: EN rationale shown in EN mode`);
  await shot(page, `${tag}-gallery-en`);

  // Browser back from #booth-leaderboard returns cleanly to pick landing.
  await page.goBack();
  await page.locator('#booth-landing').waitFor({state: 'visible'});
  await assertNoOverflow(page, tag + ' pick-en');
  await assertNoLeakedHangulInEn(page, tag + ' pick-en');

  assert.deepEqual(errs, [], `${tag}: page errors`);
  await page.close();
}

async function main() {
  const server = startServer();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome});
    await verifyViewport(browser, 390, 844, 'mobile-390');
    await verifyViewport(browser, 360, 740, 'mobile-360');
    await verifyViewport(browser, 1280, 800, 'desktop-1280');
    console.log('booth-v2-leaderboard-browser: mobile-390, mobile-360, desktop-1280 (KO+EN) all passed');
  } finally {
    if (browser) await browser.close();
    server.child.kill();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
