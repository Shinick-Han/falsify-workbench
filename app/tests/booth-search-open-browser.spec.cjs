'use strict';
// Real Chromium checks for plan97s-9:
// - C-13: tapping a second mission while the first loads keeps the first paper and its hint, with no second PDF fetch.
// - C-02: tapping an already-open search paper returns to edit, keeps edits, and fetches the PDF once.
// - C-05: Korean empty search shows the English hint and translates cleanly across KO/EN toggles.
// - C-03/F-02: Atom-shaped search paper (license: null) reads X-Falsify-Paper-License when exposed by CORS and submits.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const oracle = require('./helpers/pdf-oracle.cjs');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217 (the Ragas paper)');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_SEARCH_OPEN_PORT || 19641);
const origin = 'http://127.0.0.1:' + port;
const base = origin + '/';
const token = 'fsg_' + 'a'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);
const shotDir = process.env.BOOTH_SEARCH_OPEN_SHOTS || '';

const MISSIONS = [
  {
    paperId: '2309.15217',
    title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
    license: 'cc-by-4.0', course: 'quick', hint: 'Table 1의 점수 하나를 바꿔 보세요', pageHint: 5,
  },
  {
    paperId: '2401.00001',
    title: 'Second Mission Paper for Busy Tap Guard',
    license: 'cc-by-4.0', course: 'quick', hint: 'B힌트…', pageHint: 2,
  },
];

async function shot(page, name, viewport) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, {recursive: true});
  await page.screenshot({path: path.join(shotDir, name + '-' + viewport.width + 'x' + viewport.height + '.png'), fullPage: true});
}

function serve() {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: dist, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PYTHONUNBUFFERED: '1'},
  });
  let text = '';
  child.stdout.on('data', c => { text += c.toString(); });
  child.stderr.on('data', c => { text += c.toString(); });
  const ready = (async () => {
    const started = Date.now();
    while (Date.now() - started < 8000) {
      if (child.exitCode != null) throw new Error('http.server exited ' + child.exitCode + '\n' + text);
      try { if ((await fetch(base + 'event.html')).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('http.server did not start\n' + text);
  })();
  return {child, ready};
}

function corsHeaders(opts) {
  const realCors = !!(opts && opts.realCors);
  const headers = {
    'Access-Control-Allow-Origin': realCors ? origin : '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': realCors ? 'authorization, content-type' : '*',
  };
  if (realCors) {
    headers.Vary = 'Origin';
    headers['Access-Control-Expose-Headers'] = opts.exposeLicense
      ? 'X-Falsify-Confluence-Session, Retry-After, X-Falsify-Paper-License'
      : 'X-Falsify-Confluence-Session, Retry-After';
  }
  return headers;
}

function json(route, status, body, opts) {
  return route.fulfill({status, contentType: 'application/json', headers: corsHeaders(opts), body: JSON.stringify(body)});
}

async function handlePdfRoute(route, url, opts) {
  const id = url.searchParams.get('id') || '';
  opts.pdfIds.push(id);
  if (opts.pdfDelayMs && id === '2309.15217') {
    await new Promise(resolve => setTimeout(resolve, opts.pdfDelayMs));
  }
  return route.fulfill({
    status: 200,
    contentType: 'application/pdf',
    headers: {
      ...corsHeaders(opts),
      'X-Falsify-Paper-License': 'cc-by-4.0',
      'Content-Disposition': 'attachment; filename="arxiv-' + id + '.pdf"',
    },
    body: pdfBytes,
  });
}

async function stubApi(route, opts) {
  const request = route.request();
  const url = new URL(request.url());
  if (!url.href.startsWith(api)) return route.abort();
  if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: corsHeaders(opts)});
  if (request.method() === 'POST' && url.pathname === '/v1/ai/guest') {
    return json(route, 200, {guest: {token, expiresAt: new Date(Date.now() + 864e5).toISOString()}}, opts);
  }
  if (url.pathname === '/v1/booth/config') {
    return json(route, 200, {
      enabled: true, submissionsOpen: true, announcement: '행사 안내', consentVersion: '2026-11-22.v3',
      limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216, perOwner: 3},
      missions: opts.missions || MISSIONS,
    }, opts);
  }
  if (url.pathname === '/v1/papers/search') {
    return json(route, 200, opts.searchBody || {
      source: 'arxiv', page: 1, hasMore: false,
      results: [{
        id: '2309.15217',
        title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
        authors: ['Shahul Es', 'Jithin James'],
        year: 2023,
        license: 'cc-by-4.0',
      }],
    }, opts);
  }
  if (url.pathname === '/v1/papers/pdf') return handlePdfRoute(route, url, opts);
  if (request.method() === 'POST' && url.pathname === '/v1/booth/submissions') {
    let body = Buffer.alloc(0);
    try { body = request.postDataBuffer() || Buffer.alloc(0); } catch { body = Buffer.alloc(0); }
    opts.submissions.push({body, contentType: request.headers()['content-type'] || ''});
    return json(route, 201, {
      receipt: 'F-0042', claimKey: '7Q3K-M9XD', status: 'received',
      course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00.000Z',
    }, opts);
  }
  if (url.pathname === '/v1/booth/claim') {
    return json(route, 200, {
      receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1,
      createdAt: '2026-11-22T01:00:00.000Z', published: false,
    }, opts);
  }
  return json(route, 404, {error: {code: 'not_found'}}, opts);
}

function stepIs(page, name) {
  return page.waitForFunction(value => document.documentElement.dataset.boothStep === value, name);
}

async function openPage(browser, viewport, desk, opts, pageErrors) {
  const page = await browser.newPage({
    viewport, deviceScaleFactor: 1, hasTouch: !desk, locale: 'ko-KR',
  });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(base)) return route.continue();
    return stubApi(route, opts);
  });
  await page.goto(base + 'event.html');
  await page.locator('#booth-missions .booth-mission').first().waitFor();
  return page;
}

async function findAndReplace(page, desk, find, replace) {
  const pane = page.locator(desk ? '#booth-pane-find' : '#booth-find-fold');
  if (!desk && !(await pane.evaluate(node => node.open))) await pane.locator('summary').click();
  await pane.getByLabel('바꿀 글자').first().fill(find);
  await pane.getByLabel('새 글자').first().fill(replace);
  await pane.getByRole('button', {name: '바꾸기'}).first().click();
}

/* C-13: mission B tap while mission A is loading keeps A's hint and starts no second PDF fetch. */
async function busyTapPass(browser, viewport, desk, pageErrors) {
  const opts = {pdfDelayMs: 1500, pdfIds: [], submissions: []};
  const page = await openPage(browser, viewport, desk, opts, pageErrors);
  try {
    const cards = page.locator('#booth-missions .booth-mission');
    assert.equal(await cards.count(), 2);
    await cards.nth(0).click();
    await page.waitForTimeout(150);
    await cards.nth(1).click();
    await stepIs(page, 'edit');
    assert.equal(await page.locator('#booth-hint').textContent(), '힌트 · Table 1의 점수 하나를 바꿔 보세요');
    assert.deepEqual(opts.pdfIds, ['2309.15217'], 'only mission A PDF was fetched (no mission B prefetch/load)');
  } finally {
    await page.close();
  }
}

/* C-02: tapping an already-open search paper returns to edit, keeps edits, and fetches PDF once. */
async function searchRetapPass(browser, viewport, desk, pageErrors) {
  const opts = {pdfIds: [], submissions: []};
  const page = await openPage(browser, viewport, desk, opts, pageErrors);
  try {
    if (!desk) await page.locator('#booth-search-box > summary').click();
    await page.locator('#booth-search-q').fill('Ragas');
    await page.locator('#booth-search-go').click();
    const cardBtn = page.locator('#booth-search-results .booth-search-item button').first();
    await cardBtn.waitFor();
    await cardBtn.click();
    await stepIs(page, 'edit');
    await page.waitForFunction(() => !!globalThis.FalsifyPaperWorkspace?.getPdfDoc?.());
    await page.evaluate(() => {
      globalThis.FalsifyBoothEdits.add({
        pageIndex: 4,
        rects: [{x: 0.1, y: 0.2, w: 0.08, h: 0.02}],
        originalText: '0.95',
        newText: '0.50',
        source: 'find',
      });
    });
    await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
    await page.locator(desk ? '#booth-dock-back' : '#booth-edit-back').click();
    await stepIs(page, 'pick');
    await cardBtn.click();
    await stepIs(page, 'edit');
    assert.equal(await page.locator('#booth-dock-count').textContent(), '고친 곳 1개');
    assert.deepEqual(opts.pdfIds, ['2309.15217'], 're-tapping the open search paper makes no second PDF fetch');
  } finally {
    await page.close();
  }
}

/* C-05: Korean empty search shows English hint, placeholder mentions English, KO/EN toggle translates cleanly. */
async function koreanEmptySearchPass(browser, viewport, desk, pageErrors) {
  const opts = {pdfIds: [], submissions: [], searchBody: {source: 'arxiv', page: 1, hasMore: false, results: []}};
  const page = await openPage(browser, viewport, desk, opts, pageErrors);
  try {
    const koPlaceholder = desk ? '다른 공개 논문 찾기 · 영어 제목 또는 주제' : '영어 제목 또는 주제';
    const enPlaceholder = desk ? 'Search open papers · Title or topic in English' : 'Title or topic in English';
    const koStatus = '검색 결과가 없어요. 영어로 찾아볼까요? 예: medical imaging';
    const enStatus = 'No papers found. Try English words, e.g. medical imaging.';
    const toggleSel = desk ? '#booth-lang-desk' : '#booth-lang-pick';

    if (!desk) await page.locator('#booth-search-box > summary').click();
    assert.equal(await page.locator('#booth-search-q').getAttribute('placeholder'), koPlaceholder);
    await shot(page, 'c05-placeholder-ko', viewport);
    await page.locator('#booth-search-q').fill('의료 영상');
    await page.locator('#booth-search-go').click();
    await page.waitForFunction(expected => document.querySelector('#booth-search-status')?.textContent === expected, koStatus);
    assert.equal(await page.locator('#booth-search-status').textContent(), koStatus);
    await shot(page, 'c05-empty-search-ko', viewport);

    await page.locator(toggleSel).click();
    await page.waitForFunction(expected => document.querySelector('#booth-search-status')?.textContent === expected, enStatus);
    assert.equal(await page.locator('#booth-search-q').getAttribute('placeholder'), enPlaceholder);
    await shot(page, 'c05-empty-search-en', viewport);
    await page.locator('#booth-search-q').fill('');
    await shot(page, 'c05-placeholder-en', viewport);

    await page.locator(toggleSel).click();
    await page.waitForFunction(expected => document.querySelector('#booth-search-status')?.textContent === expected, koStatus);
    assert.equal(await page.locator('#booth-search-q').getAttribute('placeholder'), koPlaceholder);
  } finally {
    await page.close();
  }
}

/* C-03 / F-02: Atom-shaped search paper (license: null) picks up X-Falsify-Paper-License when exposed by CORS. */
async function licenseHeaderPass(browser, viewport, desk, exposeLicense, pageErrors) {
  const opts = {
    pdfIds: [],
    submissions: [],
    realCors: true,
    exposeLicense,
    searchBody: {
      source: 'arxiv', page: 1, hasMore: false,
      results: [{
        id: '2309.15217',
        title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
        authors: ['Shahul Es', 'Jithin James'],
        year: 2023,
        license: null,
        licenseVerified: false,
      }],
    },
  };
  const page = await openPage(browser, viewport, desk, opts, pageErrors);
  try {
    if (!desk) await page.locator('#booth-search-box > summary').click();
    await page.locator('#booth-search-q').fill('Ragas');
    await page.locator('#booth-search-go').click();
    const cardBtn = page.locator('#booth-search-results .booth-search-item button').first();
    await cardBtn.waitFor();
    await cardBtn.click();
    await stepIs(page, 'edit');
    await page.waitForFunction(() => !!globalThis.FalsifyPaperWorkspace?.getPdfDoc?.());

    if (exposeLicense) {
      assert.equal(await page.locator('#booth-paper-credit').textContent(), '원문 arXiv 2309.15217 · CC BY 4.0 · 게임용으로 고친 사본');
      await shot(page, 'c03-atom-credit-ko', viewport);
    } else {
      assert.equal(await page.locator('#booth-paper-credit').textContent(), '원문 arXiv 2309.15217 · 게임용으로 고친 사본');
    }

    await findAndReplace(page, desk, '0.95', '0.50');
    await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
    await page.locator('#booth-next').click();
    await stepIs(page, 'send');
    await page.locator('#booth-rows button', {hasText: '수치·통계'}).first().click();
    await page.locator('#booth-rows textarea').first().fill('Table 1 충실도 값을 낮춰 본문 결론과 어긋나게 함');
    await page.locator('#booth-submit-button').click();

    if (exposeLicense) {
      await stepIs(page, 'ticket');
      assert.equal(opts.submissions.length, 1);
      const parsed = oracle.parseMultipart(opts.submissions[0].body, opts.submissions[0].contentType);
      assert.equal(parsed.meta.paper.license, 'cc-by-4.0');
    } else {
      await page.waitForFunction(() => {
        const text = document.querySelector('#booth-submit-status')?.textContent || '';
        return text.length > 0 && text !== '제출하는 중…';
      });
      assert.equal(opts.submissions.length, 0, 'control run without exposed license header blocks submission');
    }
  } finally {
    await page.close();
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
    const phone = {width: 390, height: 844};
    const desk = {width: 1280, height: 800};
    await busyTapPass(browser, phone, false, pageErrors);
    await busyTapPass(browser, desk, true, pageErrors);
    await searchRetapPass(browser, phone, false, pageErrors);
    await searchRetapPass(browser, desk, true, pageErrors);
    await koreanEmptySearchPass(browser, phone, false, pageErrors);
    await koreanEmptySearchPass(browser, desk, true, pageErrors);
    await licenseHeaderPass(browser, phone, false, true, pageErrors);
    await licenseHeaderPass(browser, desk, true, true, pageErrors);
    await licenseHeaderPass(browser, phone, false, false, pageErrors);
    assert.equal(pageErrors.join('\n'), '', 'unexpected page errors');
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth search-open browser passed'); }, error => {
  console.error(error && error.message);
  console.error(error);
  process.exit(1);
});
