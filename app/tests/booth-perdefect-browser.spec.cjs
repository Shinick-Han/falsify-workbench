'use strict';
// Real Chromium verification of per-defect fair results (sx96) in ko and en at 390 and 1280:
// - 4 edits all caught
// - 4 edits with 1 missed (outcome missed, escaped note)
// - 1 edit caught
// - 1 edit missed
// - partial
// - missing local receipt
// Checks headline, per-edit status labels + aria-labels, rule line on send & result screens,
// zero visible Hangul in EN mode, zero horizontal overflow, and saves 390 screenshots to BOOTH_PERDEFECT_SHOTS.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_PERDEFECT_PORT || 19929);
const base = 'http://127.0.0.1:' + port + '/';
const shotDir = process.env.BOOTH_PERDEFECT_SHOTS || '';
const token = 'fsg_' + 'f'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const FOUR_EDITS = [
  {page: 5, before: 'Ragas 0.95 0.78 0.70', after: 'Ragas 0.50 0.78 0.70'},
  {page: 2, before: 'we used 12 annotators', after: 'we used 30 annotators'},
  {page: 3, before: 'dataset has 50 rows', after: 'dataset has 99 rows'},
  {page: 6, before: 'faithfulness is high', after: 'faithfulness is low'},
];
const ONE_EDIT = [FOUR_EDITS[0]];

const CLAIMS = {
  'F-0201': {
    receipt: 'F-0201', status: 'judged', course: 'quick', declaredCount: 4,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:40.000Z',
    published: true, outcome: 'caught',
    publicNote: '내가 심어 둔 결함을 AI가 찾았어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Ragas 0.50 0.78 0.70"\nAI 설명: 표 1의 충실도 0.50이 본문 결론과 어긋납니다.\nAI note: Table 1 faithfulness 0.50 contradicts the conclusion.',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught'},
      {index: 1, pageIndex: 1, verdict: 'caught'},
      {index: 2, pageIndex: 2, verdict: 'caught'},
      {index: 3, pageIndex: 5, verdict: 'caught'},
    ],
  },
  'F-0202': {
    receipt: 'F-0202', status: 'judged', course: 'quick', declaredCount: 4,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:55.000Z',
    published: true, outcome: 'missed',
    publicNote: '심어 둔 결함 중 일부는 AI가 찾았어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Ragas 0.50 0.78 0.70"\nAI 설명: 표 1의 충실도 0.50이 본문 결론과 어긋납니다.\nAI note: Table 1 faithfulness 0.50 contradicts the conclusion.',
    prizeMessage: 'AI가 놓쳤어요! 부스 스태프에게 이 화면을 보여 주면 작은 선물을 드려요.',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught'},
      {index: 1, pageIndex: 1, verdict: 'partial'},
      {index: 2, pageIndex: 2, verdict: 'missed'},
      {index: 3, pageIndex: 5, verdict: 'caught'},
    ],
  },
  'F-0203': {
    receipt: 'F-0203', status: 'judged', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:20.000Z',
    published: true, outcome: 'caught',
    publicNote: '내가 심어 둔 결함을 AI가 찾았어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Ragas 0.50 0.78 0.70"\nAI 설명: 표 1의 충실도 0.50이 본문 결론과 어긋납니다.\nAI note: Table 1 faithfulness 0.50 contradicts the conclusion.',
    editResults: [{index: 0, pageIndex: 4, verdict: 'caught'}],
  },
  'F-0204': {
    receipt: 'F-0204', status: 'judged', course: 'quick', declaredCount: 1,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:25.000Z',
    published: true, outcome: 'missed',
    publicNote: 'AI는 다른 곳을 짚었어요. 심어 둔 결함은 AI 눈을 피했어요.',
    prizeMessage: 'AI가 놓쳤어요! 부스 스태프에게 이 화면을 보여 주면 작은 선물을 드려요.',
    editResults: [{index: 0, pageIndex: 4, verdict: 'missed'}],
  },
  'F-0205': {
    receipt: 'F-0205', status: 'judged', course: 'quick', declaredCount: 2,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:30.000Z',
    published: true, outcome: 'partial',
    publicNote: '내가 심어 둔 결함 근처를 AI가 짚었어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Table 1: Agreement with human annotators."\nAI 설명: 표 1의 수치가 본문과 어긋납니다.\nAI note: Numbers in Table 1 disagree with the text.',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught'},
      {index: 1, pageIndex: 1, verdict: 'partial'},
    ],
  },
  'F-0299': {
    receipt: 'F-0299', status: 'judged', course: 'quick', declaredCount: 4,
    createdAt: '2026-11-22T01:00:00.000Z', publishedAt: '2026-11-22T01:01:50.000Z',
    published: true, outcome: 'missed',
    publicNote: '심어 둔 결함 중 일부는 AI가 찾았어요. (AI가 짚은 곳: 5쪽)\nAI가 짚은 문장: "Ragas 0.50 0.78 0.70"\nAI 설명: 표 1의 충실도 0.50이 본문 결론과 어긋납니다.\nAI note: Table 1 faithfulness 0.50 contradicts the conclusion.',
    prizeMessage: 'AI가 놓쳤어요! 부스 스태프에게 이 화면을 보여 주면 작은 선물을 드려요.',
    editResults: [
      {index: 0, pageIndex: 4, verdict: 'caught'},
      {index: 1, pageIndex: 1, verdict: 'missed'},
      {index: 2, pageIndex: 2, verdict: 'missed'},
      {index: 3, pageIndex: 5, verdict: 'caught'},
    ],
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
  if (url.pathname === '/v1/papers/pdf') {
    return route.fulfill({
      status: 200, contentType: 'application/pdf',
      headers: {...cors, 'X-Falsify-Paper-License': 'cc-by-4.0', 'Content-Disposition': 'attachment; filename="2309.15217.pdf"'},
      body: pdfBytes,
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

async function shot(page, name) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, {recursive: true});
  await page.screenshot({path: path.join(shotDir, name), fullPage: true});
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

async function runCase(browser, viewport, desk, lang) {
  const isEn = lang === 'en';
  const tag = `${lang}-${viewport.width}`;
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 1, hasTouch: !desk, isMobile: !desk, locale: isEn ? 'en-US' : 'ko-KR',
  });
  await context.addInitScript(({isEn, FOUR_EDITS, ONE_EDIT}) => {
    if (isEn) localStorage.setItem('falsify.booth.lang.v1', 'en');
    else localStorage.removeItem('falsify.booth.lang.v1');
    localStorage.setItem('falsify.booth.receipts.v1', JSON.stringify([
      {receipt: 'F-0201', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00.000Z', title: 'Ragas', pages: [2, 3, 5, 6], count: 4, edits: FOUR_EDITS},
      {receipt: 'F-0202', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00.000Z', title: 'Ragas', pages: [2, 3, 5, 6], count: 4, edits: FOUR_EDITS},
      {receipt: 'F-0203', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00.000Z', title: 'Ragas', pages: [5], count: 1, edits: ONE_EDIT},
      {receipt: 'F-0204', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00.000Z', title: 'Ragas', pages: [5], count: 1, edits: ONE_EDIT},
      {receipt: 'F-0205', claimKey: '7Q3K-M9XD', createdAt: '2026-11-20T01:00:00.000Z', title: 'Ragas', pages: [2, 5], count: 2, edits: FOUR_EDITS.slice(0, 2)},
    ]));
    window.addEventListener('DOMContentLoaded', () => {
      const api = window.FalsifyBrowserPdf || (window.FalsifyBrowserPdf = {});
      api.rewrite = async (sourceBytes, edits) => {
        const marker = new TextEncoder().encode('\n% stub ' + (edits ? edits.length : 0) + '\n');
        const out = new Uint8Array(sourceBytes.length + marker.length);
        out.set(sourceBytes, 0);
        out.set(marker, sourceBytes.length);
        return out;
      };
    });
  }, {isEn, FOUR_EDITS, ONE_EDIT});
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  page.setDefaultTimeout(90000);
  await page.route('**/*', route => {
    if (route.request().url().startsWith(base)) return route.continue();
    return stubApi(route);
  });

  const ruleExpected = isEn
    ? 'If the AI misses even one of your defects, you win. Booth prizes go to the first 30 winners (1 per person).'
    : '심은 결함 중 하나라도 AI가 놓치면 성공이에요. 현장 선물은 먼저 승리한 선착순 30분(1인 1회)께 드려요.';
  const L = isEn
    ? {caught: 'Found by AI', partial: 'AI got close', missed: 'Missed by AI'}
    : {caught: 'AI가 찾음', partial: '근처를 짚음', missed: 'AI가 놓침'};

  try {
    await page.goto(base + 'event.html');
    await page.locator('#booth-missions .booth-mission').first().waitFor();
    await assertClean(page, tag + ' pick', isEn);

    // Check send screen rule line (open mission, apply one quick edit, go to send).
    await page.locator('#booth-missions .booth-mission').first().click();
    await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'edit');
    await page.waitForFunction(() => !!globalThis.FalsifyPaperWorkspace?.getPdfDoc?.()
      && [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(n => n.textContent.includes('0.95')));
    const pane = page.locator(desk ? '#booth-pane-find' : '#booth-find-fold');
    if (!desk && !(await pane.evaluate(n => n.open))) await pane.locator('summary').click();
    await pane.getByLabel(isEn ? 'Find text' : '바꿀 글자').first().fill('0.95');
    await pane.getByLabel(isEn ? 'Replace with' : '새 글자').first().fill('0.50');
    await pane.getByRole('button', {name: isEn ? 'Replace' : '바꾸기'}).first().click();
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    await page.locator('#booth-next').waitFor({state: 'visible'});
    await page.locator('#booth-next').click();
    await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'send');
    assert.equal(await page.locator('#booth-send-rule').isVisible(), true);
    assert.equal(await page.locator('#booth-send-rule').textContent(), ruleExpected);
    await assertClean(page, tag + ' send', isEn);

    // Return to pick for claim lookups
    if (desk) await page.locator('#booth-desk-records').click();
    else {
      await page.locator('#booth-send-back').click();
      await page.locator('#booth-edit-back').click();
      await page.locator('#booth-result-link').click();
    }

    const scenarios = [
      {
        receipt: 'F-0201',
        title: isEn ? 'AI found all 4' : 'AI가 4개를 모두 찾아냈어요',
        labels: [L.caught, L.caught, L.caught, L.caught],
        declaredVisible: true,
        shotName: !desk ? `4-all-caught-${lang}-390.png` : '',
      },
      {
        receipt: 'F-0202',
        title: isEn ? '1 of 4 slipped past the AI' : '4개 중 1개가 AI 눈을 피했어요',
        labels: [L.caught, L.partial, L.missed, L.caught],
        declaredVisible: true,
        shotName: !desk ? `1-of-4-escaped-${lang}-390.png` : '',
      },
      {
        receipt: 'F-0203',
        title: isEn ? 'AI caught it' : 'AI가 찾아냈어요',
        labels: [L.caught],
        declaredVisible: true,
        shotName: '',
      },
      {
        receipt: 'F-0204',
        title: isEn ? 'AI missed it' : 'AI가 못 찾았어요',
        labels: [L.missed],
        declaredVisible: true,
        shotName: '',
      },
      {
        receipt: 'F-0205',
        title: isEn ? 'AI got close' : 'AI가 근처를 짚었어요',
        labels: [L.caught, L.partial],
        declaredVisible: true,
        shotName: '',
      },
      {
        receipt: 'F-0299',
        title: isEn ? '2 of 4 slipped past the AI' : '4개 중 2개가 AI 눈을 피했어요',
        labels: [],
        declaredVisible: false,
        shotName: '',
      },
    ];

    for (const sc of scenarios) {
      await lookup(page, desk, sc.receipt);
      await page.waitForFunction(expected => document.querySelector('#booth-live-title')?.textContent === expected, sc.title);
      assert.equal(await page.locator('#booth-live-rule').isVisible(), true, `${tag} ${sc.receipt} rule visible`);
      assert.equal(await page.locator('#booth-live-rule').textContent(), ruleExpected, `${tag} ${sc.receipt} rule copy`);
      assert.equal(await page.locator('#booth-live-declared').isVisible(), sc.declaredVisible, `${tag} ${sc.receipt} declared visible`);
      const gotLabels = await page.locator('#booth-live-declared .booth-edit-verdict').evaluateAll(nodes =>
        nodes.map(n => ({text: n.textContent, aria: n.getAttribute('aria-label')})),
      );
      assert.deepEqual(gotLabels, sc.labels.map(text => ({text, aria: text})), `${tag} ${sc.receipt} labels`);
      await assertClean(page, `${tag} ${sc.receipt}`, isEn);
      if (sc.shotName) await shot(page, sc.shotName);
    }

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
      await runCase(browser, {width: 390, height: 844}, false, lang);
      await runCase(browser, {width: 1280, height: 800}, true, lang);
    }
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth per-defect browser passed'); }, error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
