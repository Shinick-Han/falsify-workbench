'use strict';
// Real Chromium regression test for per-edit AI evidence on result tickets:
// - Independent normal entry (1 edit caught with evidence)
// - 5-finding ticket (same device with local diffs + multiple edits on same page 5, KO & EN, live KO<->EN toggle)
// - 5-edit mixed ticket (caught + partial + missed + escaped summary + prize + staff note, no fabricated evidence on missed)
// - Other device (fresh browser context, claim only, no local edits) for 5-finding and 5-mixed tickets
// - Legacy 1-summary ticket (no per-edit evidence) compatibility
// - Safe textContent rendering of HTML markup in evidence & notes
// Verifies mobile (390x844) and desktop (1280x800), zero horizontal overflow, zero visible Hangul in EN mode.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_EVIDENCE_PORT || 0);
let base = '';
const token = 'fsg_' + 'a'.repeat(43);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const FIVE_EDITS = [
  {page: 5, before: 'Ragas 0.95 0.78 0.70', after: 'Ragas 0.50 0.78 0.70'},
  {page: 5, before: 'context recall 0.88', after: 'context recall 0.41'},
  {page: 2, before: 'we used 12 annotators', after: 'we used 30 annotators'},
  {page: 5, before: 'human agreement 0.91', after: 'human agreement 0.35'},
  {page: 9, before: 'detection time 64%', after: 'detection time 10%'},
];

const CLAIMS = {
  // Independent normal single-edit entry with per-edit evidence
  'F-0700': {
    receipt: 'F-0700', status: 'judged', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:20.000Z',
    published: true, outcome: 'caught',
    publicNote: '내가 심어 둔 결함을 AI가 찾았어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Ragas 0.50 0.78 0.70"\nAI 설명: 표 1 충실도 0.50이 본문 결론과 어긋나요.\nAI note: Table 1 faithfulness 0.50 contradicts the conclusion.',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught', evidence: {
        quote: 'Ragas 0.50 0.78 0.70',
        rationale: '표 1 충실도 0.50이 본문 결론과 어긋나요.',
        rationaleEn: 'Table 1 faithfulness 0.50 contradicts the conclusion.',
      }},
    ],
  },
  // 5 findings including 3 on page 5
  'F-0701': {
    receipt: 'F-0701', status: 'judged', course: 'quick', declaredCount: 5,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:02:10.000Z',
    published: true, outcome: 'caught',
    publicNote: '내가 심어 둔 결함을 AI가 찾았어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Ragas 0.50 0.78 0.70"\nAI 설명: 표 1 충실도 0.50이 본문 결론과 어긋나요.\nAI note: Table 1 faithfulness 0.50 contradicts the conclusion.',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught', evidence: {quote: 'Ragas 0.50 0.78 0.70', rationale: '표 1 충실도 0.50이 본문 결론과 어긋나요.', rationaleEn: 'Table 1 faithfulness 0.50 contradicts the conclusion.'}},
      {index: 1, pageIndex: 4, verdict: 'caught', evidence: {quote: 'context recall 0.41', rationale: '5쪽 두 번째 수치 0.41이 요약과 어긋나요.', rationaleEn: 'Second p. 5 metric 0.41 conflicts with the summary.'}},
      {index: 2, pageIndex: 1, verdict: 'caught', evidence: {quote: 'we used 30 annotators', rationale: '2쪽 평가자 수가 실험 설명과 달라요.', rationaleEn: 'Annotator count on p. 2 conflicts with the setup.'}},
      {index: 3, pageIndex: 4, verdict: 'caught', evidence: {quote: 'human agreement 0.35', rationale: '5쪽 세 번째 일치도 값이 본문과 모순돼요.', rationaleEn: 'Third p. 5 agreement value contradicts the text.'}},
      {index: 4, pageIndex: 8, verdict: 'caught', evidence: {quote: 'detection time 10%', rationale: '9쪽 탐지 시간 수치가 표와 달라요.', rationaleEn: 'Detection time on p. 9 disagrees with the table.'}},
    ],
  },
  // 5 edits mixed: 3 caught, 1 partial, 1 missed + escaped summary + prize + bogus missed evidence stripped
  'F-0702': {
    receipt: 'F-0702', status: 'judged', course: 'quick', declaredCount: 5,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:02:20.000Z',
    published: true, outcome: 'missed',
    publicNote: '심어 둔 결함 중 일부는 AI가 찾았어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Ragas 0.50 0.78 0.70"\nAI 설명: 표 1 충실도 0.50이 본문 결론과 어긋나요.\nAI note: Table 1 faithfulness 0.50 contradicts the conclusion.',
    prizeMessage: 'AI가 놓쳤어요! 부스 스태프에게 이 화면을 보여 주면 작은 선물을 드려요.',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught', evidence: {quote: 'Ragas 0.50 0.78 0.70', rationale: '표 1 충실도 0.50이 어긋나요.', rationaleEn: 'Table 1 faithfulness 0.50 is inconsistent.'}},
      {index: 1, pageIndex: 4, verdict: 'partial', evidence: {quote: 'context recall 0.41', rationale: '5쪽 근처 수치를 짚었어요.', rationaleEn: 'Flagged a nearby score on p. 5.'}},
      {index: 2, pageIndex: 1, verdict: 'missed', evidence: {quote: 'FABRICATED QUOTE', rationale: 'FABRICATED REASON', rationaleEn: 'FABRICATED EN'}},
      {index: 3, pageIndex: 4, verdict: 'caught', evidence: {quote: 'human agreement 0.35', rationale: '5쪽 일치도 0.35가 모순돼요.', rationaleEn: 'p. 5 agreement 0.35 conflicts.'}},
      {index: 4, pageIndex: 8, verdict: 'caught', evidence: {quote: 'detection time 10%', rationale: '9쪽 수치가 표와 달라요.', rationaleEn: 'p. 9 figure disagrees with the table.'}},
    ],
  },
  // Legacy 1-summary ticket without per-edit evidence
  'F-0703': {
    receipt: 'F-0703', status: 'judged', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:30.000Z',
    published: true, outcome: 'caught',
    publicNote: '내가 심어 둔 결함을 AI가 찾았어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Legacy single quote"\nAI 설명: 예전 단일 요약 설명이에요.\nAI note: Legacy single-summary explanation.',
  },
  // Staff note + XSS literal textContent check
  'F-0704': {
    receipt: 'F-0704', status: 'judged', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:35.000Z',
    published: true, outcome: 'caught',
    publicNote: '내가 심어 둔 결함을 AI가 찾았어요. (AI가 짚은 곳: 5쪽)\nStaff check: <b>verified</b>\nAI가 짚은 문장: "ignored"\nAI 설명: ignored',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught', evidence: {
        quote: '<img src=x onerror=alert(1)>',
        rationale: '<script>window.__xss=1</script> KO',
        rationaleEn: '<script>window.__xss=1</script> EN',
      }},
    ],
  },
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
    if (!full.startsWith(dist + path.sep) && full !== dist) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
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
    return json(route, 200, {
      enabled: true, submissionsOpen: true, announcement: '',
      consentVersion: '2026-11-22.v3',
      limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216, perOwner: 5},
      missions: [{
        paperId: '2309.15217',
        title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
        license: 'cc-by-4.0', course: 'quick', pageHint: 5,
        hint: '5쪽 Table 1의 숫자 하나를 바꿔 결론과 어긋나게 해 보세요. 예: Ragas 충실도 0.95 → 0.50',
      }],
    });
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
      await page.locator('#booth-result-link').click();
    }
  } else if (await page.locator('#booth-result').isHidden()) {
    await page.locator(desk ? '#booth-desk-records' : '#booth-result-link').click();
  }
  await page.locator('#booth-claim-receipt').fill(receipt);
  await page.locator('#booth-claim-key').fill('7Q3K-M9XD');
  await page.locator('#booth-claim-form button[type="submit"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'ticket');
}

async function visibleOpinions(page, panelSel, isEn) {
  return page.locator(panelSel + ' .booth-declared-item').evaluateAll((items, en) => items.map(item => {
    const q = item.querySelector('blockquote.booth-quote');
    const ko = item.querySelector('.booth-opinion-ko');
    const enNode = item.querySelector('.booth-opinion-en');
    const shown = node => !!node && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0;
    return {
      idx: item.getAttribute('data-edit-index'),
      head: item.querySelector('.booth-klab')?.textContent || '',
      verdict: item.querySelector('.booth-edit-verdict')?.textContent || '',
      quote: q ? q.textContent : null,
      quoteVisible: shown(q),
      koVisible: shown(ko),
      enVisible: shown(enNode),
      activeText: en ? (enNode?.textContent || null) : (ko?.textContent || null),
    };
  }), isEn);
}

async function runSameDevice(browser, viewport, desk, lang) {
  const isEn = lang === 'en';
  const tag = `same-${lang}-${viewport.width}`;
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 1, hasTouch: !desk, isMobile: !desk, locale: isEn ? 'en-US' : 'ko-KR',
  });
  await context.addInitScript(({isEn, FIVE_EDITS}) => {
    if (isEn) localStorage.setItem('falsify.booth.lang.v1', 'en');
    else localStorage.removeItem('falsify.booth.lang.v1');
    localStorage.setItem('falsify.booth.receipts.v1', JSON.stringify([
      {receipt: 'F-0700', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00.000Z', title: 'Ragas', pages: [5], count: 1, edits: [FIVE_EDITS[0]]},
      {receipt: 'F-0701', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00.000Z', title: 'Ragas', pages: [2, 5, 9], count: 5, edits: FIVE_EDITS},
      {receipt: 'F-0702', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00.000Z', title: 'Ragas', pages: [2, 5, 9], count: 5, edits: FIVE_EDITS},
      {receipt: 'F-0703', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00.000Z', title: 'Ragas', pages: [5], count: 1, edits: [FIVE_EDITS[0]]},
      {receipt: 'F-0704', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00.000Z', title: 'Ragas', pages: [5], count: 1, edits: [FIVE_EDITS[0]]},
    ]));
  }, {isEn, FIVE_EDITS});
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : stubApi(route));

  try {
    await page.goto(base + 'event.html');
    await page.locator('#booth-missions .booth-mission').first().waitFor();

    // 1. Independent normal entry (1 edit caught with evidence)
    await lookup(page, desk, 'F-0700');
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, isEn ? 'AI caught it' : 'AI가 찾아냈어요');
    assert.equal(await page.locator('#booth-live-note').isVisible(), false, `${tag} F-0700 suppresses duplicate note`);
    assert.equal(await page.locator('#booth-live-findings').isVisible(), false);
    assert.equal(await page.locator('#booth-live-declared').isVisible(), true);
    const oneRows = await visibleOpinions(page, '#booth-live-declared', isEn);
    assert.equal(oneRows.length, 1);
    assert.equal(oneRows[0].quoteVisible, true);
    assert.equal(oneRows[0].koVisible, !isEn);
    assert.equal(oneRows[0].enVisible, isEn);
    await assertClean(page, `${tag} F-0700`, isEn);

    // 2. 5 findings (3 on page 5) -> all 5 quotes & KO/EN rationales visibly expanded with diffs
    await lookup(page, desk, 'F-0701');
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, isEn ? 'AI found all 5' : 'AI가 5개를 모두 찾아냈어요');
    assert.equal(await page.locator('#booth-live-note').isVisible(), false, `${tag} F-0701 suppresses duplicate note`);
    assert.equal(await page.locator('#booth-live-page').isVisible(), false, `${tag} F-0701 hides single representative page`);
    assert.equal(await page.locator('#booth-live-findings').isVisible(), false);
    const fiveRows = await visibleOpinions(page, '#booth-live-declared', isEn);
    assert.equal(fiveRows.length, 5);
    assert.deepEqual(fiveRows.map(r => r.head), isEn
      ? ['Defect 1 · p. 5', 'Defect 2 · p. 5', 'Defect 3 · p. 2', 'Defect 4 · p. 5', 'Defect 5 · p. 9']
      : ['결함 1 · 5쪽', '결함 2 · 5쪽', '결함 3 · 2쪽', '결함 4 · 5쪽', '결함 5 · 9쪽']);
    assert.equal(fiveRows.every(r => r.quoteVisible && r.koVisible === !isEn && r.enVisible === isEn), true);
    assert.equal(await page.locator('#booth-live-declared details').count(), 0, 'all 5 evidence blocks expanded');
    await assertClean(page, `${tag} F-0701`, isEn);

    // Live KO<->EN toggle on 5-finding ticket
    const toggleSel = desk ? '#booth-lang-desk' : '#booth-lang-ticket';
    await page.locator(toggleSel).click();
    const toggledRows = await visibleOpinions(page, '#booth-live-declared', !isEn);
    assert.equal(toggledRows.every(r => r.koVisible === isEn && r.enVisible === !isEn), true, `${tag} live language toggle switches all 5 rationales`);
    await assertClean(page, `${tag} F-0701 toggled`, !isEn);
    await page.locator(toggleSel).click();

    // 3. 5 edits mixed: 4 caught/partial with evidence, 1 missed without evidence, mixed summary + prize kept
    await lookup(page, desk, 'F-0702');
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, isEn ? '1 of 5 slipped past the AI' : '5개 중 1개가 AI 눈을 피했어요');
    assert.equal(await page.locator('#booth-gift').isVisible(), true, `${tag} F-0702 prize visible`);
    assert.equal(await page.locator('#booth-final').isVisible(), true, `${tag} F-0702 final raffle visible`);
    assert.equal(await page.locator('#booth-live-note').isVisible(), true, `${tag} F-0702 mixed summary visible`);
    assert.equal(await page.locator('#booth-live-note blockquote').count(), 0, `${tag} F-0702 no duplicate quote in note`);
    const mixedRows = await visibleOpinions(page, '#booth-live-declared', isEn);
    assert.equal(mixedRows.length, 5);
    assert.equal(mixedRows[2].quote, null, `${tag} missed item has no quote`);
    assert.equal(mixedRows[2].koVisible, false);
    assert.equal(mixedRows[2].enVisible, false);
    assert.equal(mixedRows.filter(r => r.quoteVisible).length, 4);
    await assertClean(page, `${tag} F-0702`, isEn);

    // 4. Legacy 1-summary ticket compatibility
    await lookup(page, desk, 'F-0703');
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, isEn ? 'AI caught it' : 'AI가 찾아냈어요');
    assert.equal(await page.locator('#booth-live-page').isVisible(), true, `${tag} F-0703 legacy page visible`);
    assert.equal(await page.locator('#booth-live-note blockquote').textContent(), 'Legacy single quote');
    assert.equal(await page.locator('#booth-live-note .booth-opinion-en').isVisible(), isEn);
    assert.equal(await page.locator('#booth-live-note .booth-opinion-ko').isVisible(), !isEn);
    await assertClean(page, `${tag} F-0703`, isEn);

    // 5. Staff note + XSS rendered safely as textContent
    await lookup(page, desk, 'F-0704');
    await page.waitForFunction(() => document.querySelector('#booth-live-note')?.textContent?.includes('Staff check: <b>verified</b>'));
    assert.equal(await page.evaluate(() => window.__xss || 0), 0);
    assert.equal(await page.locator('#booth-live-declared img, #booth-live-declared script, #booth-live-note b').count(), 0);
    assert.equal(await page.locator('#booth-live-declared blockquote').textContent(), '<img src=x onerror=alert(1)>');
    await assertClean(page, `${tag} F-0704`, isEn);

    assert.equal(pageErrors.join('\n'), '', `${tag} unexpected page errors`);
  } finally {
    await context.close();
  }
}

async function runOtherDevice(browser, viewport, desk, lang) {
  const isEn = lang === 'en';
  const tag = `other-${lang}-${viewport.width}`;
  // Fresh context: zero localStorage receipts (claim-only device).
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 1, hasTouch: !desk, isMobile: !desk, locale: isEn ? 'en-US' : 'ko-KR',
  });
  await context.addInitScript(en => {
    if (en) localStorage.setItem('falsify.booth.lang.v1', 'en');
    else localStorage.removeItem('falsify.booth.lang.v1');
    localStorage.removeItem('falsify.booth.receipts.v1');
  }, isEn);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : stubApi(route));

  try {
    await page.goto(base + 'event.html');
    await page.locator('#booth-missions .booth-mission').first().waitFor();

    // 1. Other device, 5 findings (3 on page 5)
    await lookup(page, desk, 'F-0701');
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, isEn ? 'AI found all 5' : 'AI가 5개를 모두 찾아냈어요');
    assert.equal(await page.locator('#booth-live-declared').isVisible(), false, `${tag} F-0701 declared hidden`);
    assert.equal(await page.locator('#booth-live-note').isVisible(), false, `${tag} F-0701 duplicate note hidden`);
    assert.equal(await page.locator('#booth-live-findings').isVisible(), true, `${tag} F-0701 findings visible`);
    const rows = await visibleOpinions(page, '#booth-live-findings', isEn);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map(r => r.head), isEn
      ? ['Defect 1 · p. 5', 'Defect 2 · p. 5', 'Defect 3 · p. 2', 'Defect 4 · p. 5', 'Defect 5 · p. 9']
      : ['결함 1 · 5쪽', '결함 2 · 5쪽', '결함 3 · 2쪽', '결함 4 · 5쪽', '결함 5 · 9쪽']);
    assert.equal(rows.every(r => r.quoteVisible && r.koVisible === !isEn && r.enVisible === isEn), true);
    await assertClean(page, `${tag} F-0701`, isEn);

    // 2. Other device, 5 mixed (4 caught/partial with evidence, 1 missed with none, mixed summary + prize visible)
    await lookup(page, desk, 'F-0702');
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, isEn ? '1 of 5 slipped past the AI' : '5개 중 1개가 AI 눈을 피했어요');
    assert.equal(await page.locator('#booth-live-declared').isVisible(), false);
    assert.equal(await page.locator('#booth-live-findings').isVisible(), true);
    assert.equal(await page.locator('#booth-gift').isVisible(), true);
    assert.equal(await page.locator('#booth-live-note').isVisible(), true);
    assert.equal(await page.locator('#booth-live-note blockquote').count(), 0);
    const mixedRows = await visibleOpinions(page, '#booth-live-findings', isEn);
    assert.equal(mixedRows.length, 5);
    assert.equal(mixedRows[2].quote, null);
    assert.equal(mixedRows.filter(r => r.quoteVisible).length, 4);
    await assertClean(page, `${tag} F-0702`, isEn);

    // 3. Other device, legacy 1-summary ticket
    await lookup(page, desk, 'F-0703');
    await page.waitForFunction(t => document.querySelector('#booth-live-title')?.textContent === t, isEn ? 'AI caught it' : 'AI가 찾아냈어요');
    assert.equal(await page.locator('#booth-live-declared').isVisible(), false);
    assert.equal(await page.locator('#booth-live-findings').isVisible(), false);
    assert.equal(await page.locator('#booth-live-note blockquote').textContent(), 'Legacy single quote');
    await assertClean(page, `${tag} F-0703`, isEn);

    assert.equal(pageErrors.join('\n'), '', `${tag} unexpected page errors`);
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
      await runSameDevice(browser, {width: 390, height: 844}, false, lang);
      await runSameDevice(browser, {width: 1280, height: 800}, true, lang);
      await runOtherDevice(browser, {width: 390, height: 844}, false, lang);
      await runOtherDevice(browser, {width: 1280, height: 800}, true, lang);
    }
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().then(() => { console.log('booth result evidence browser passed'); }, error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
