'use strict';
// Real Chromium checks for plan97s-9:
// - C-13: tapping a second mission while the first loads keeps the first paper and its hint, with no second PDF fetch.
// - C-02: tapping an already-open search paper returns to edit, keeps edits, and fetches the PDF once.
// - C-05: Korean empty search shows the English hint and translates cleanly across KO/EN toggles.
// - C-03/F-02: Verified search results keep their license through submission, with or without the PDF response header.
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

function buildSyntheticPdf(pageCount, textLine, opts = {}) {
  const objects = [];
  const addObj = body => { objects.push(body); return objects.length; };
  const catalogId = addObj('');
  const pagesId = addObj('');
  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contentCache = new Map();
  const contentFor = text => {
    const key = text || '';
    if (contentCache.has(key)) return contentCache.get(key);
    const streamText = key ? `BT /F1 12 Tf 72 720 Td (${key}) Tj ET` : '';
    const id = addObj(`<< /Length ${Buffer.byteLength(streamText, 'latin1')} >>\nstream\n${streamText}\nendstream`);
    contentCache.set(key, id);
    return id;
  };
  const kids = [];
  for (let i = 0; i < pageCount; i += 1) {
    const line = typeof textLine === 'function' ? textLine(i + 1) : textLine;
    const contentId = contentFor(line);
    const pageId = addObj(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    kids.push(`${pageId} 0 R`);
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
  let encryptRef = '';
  if (opts.encrypted) {
    const pad = 'A'.repeat(32);
    const encId = addObj(`<< /Filter /Standard /V 1 /R 2 /O (${pad}) /U (${pad}) /P -44 >>`);
    encryptRef = ` /Encrypt ${encId} 0 R /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>]`;
  }
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [0];
  let pos = chunks[0].length;
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(pos);
    const chunk = Buffer.from(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`, 'latin1');
    chunks.push(chunk);
    pos += chunk.length;
  }
  const xrefPos = pos;
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (let i = 1; i <= objects.length; i += 1) xref.push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  xref.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R${encryptRef} >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  chunks.push(Buffer.from(xref.join(''), 'latin1'));
  return Buffer.concat(chunks);
}

const CORRUPT_PDF = Buffer.from('%PDF-1.4\nthis-is-not-a-valid-pdf-stream-or-xref\n');
const ENCRYPTED_PDF = buildSyntheticPdf(1, 'Secret 0.95', {encrypted: true});
const SCANNED_EMPTY_PDF = buildSyntheticPdf(2, '');
const SCANNED_STAMP_ONLY_PDF = buildSyntheticPdf(1, 'arXiv:2401.99993v1 [cs.CV] 12 Jan 2024');
const SCANNED_12P_EMPTY_PDF = buildSyntheticPdf(12, '');
const LATE_TEXT_12P_PDF = buildSyntheticPdf(12, p => (p === 11 ? 'Late selectable text 0.95' : ''));
const LONG_205P_PDF = buildSyntheticPdf(205, 'Long benchmark accuracy 0.95 on page');

async function handlePdfRoute(route, url, opts) {
  const id = url.searchParams.get('id') || '';
  opts.pdfIds.push(id);
  if (opts.pdfDelayMs && id === '2309.15217') {
    await new Promise(resolve => setTimeout(resolve, opts.pdfDelayMs));
  }
  const body = (opts.pdfMap && opts.pdfMap[id]) || pdfBytes;
  return route.fulfill({
    status: 200,
    contentType: 'application/pdf',
    headers: {
      ...corsHeaders(opts),
      'X-Falsify-Paper-License': 'cc-by-4.0',
      'Content-Disposition': 'attachment; filename="arxiv-' + id + '.pdf"',
    },
    body,
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
        licenseVerified: true, license: 'cc-by-4.0',
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

/* C-03 / F-02: Verified search metadata supplies the license even when the PDF header is not exposed. */
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
        license: 'cc-by-4.0',
        licenseVerified: true,
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

    assert.equal(await page.locator('#booth-paper-credit').textContent(), '원문 arXiv 2309.15217 · CC BY 4.0 · 게임용으로 고친 사본');

    await findAndReplace(page, desk, '0.95', '0.50');
    await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
    await page.locator('#booth-next').click();
    await stepIs(page, 'send');
    await page.locator('#booth-rows button', {hasText: '수치·통계'}).first().click();
    await page.locator('#booth-rows textarea').first().fill('Table 1 충실도 값을 낮춰 본문 결론과 어긋나게 함');
    await page.locator('#booth-submit-button').click();

    await stepIs(page, 'ticket');
    assert.equal(opts.submissions.length, 1);
    const parsed = oracle.parseMultipart(opts.submissions[0].body, opts.submissions[0].contentType);
    assert.equal(parsed.meta.paper.license, 'cc-by-4.0');
  } finally {
    await page.close();
  }
}

/* Confirmed open-eligibility regressions: password, corrupt, and scanned 0-text PDFs stay on pick
   with query & results intact, show clear KO/EN status, consume 0 submissions, and allow selecting a valid paper next. */
async function unreadablePdfPass(browser, viewport, desk, pageErrors) {
  const opts = {
    pdfIds: [],
    submissions: [],
    pdfMap: {
      '2401.99991': ENCRYPTED_PDF,
      '2401.99992': CORRUPT_PDF,
      '2401.99993': SCANNED_EMPTY_PDF,
      '2401.99994': SCANNED_STAMP_ONLY_PDF,
      '2309.15217': pdfBytes,
    },
    searchBody: {
      source: 'arxiv', page: 1, hasMore: false,
      results: [
        {id: '2401.99991', title: 'Encrypted PDF Fixture', authors: ['A'], year: 2024, licenseVerified: true, license: 'cc-by-4.0'},
        {id: '2401.99992', title: 'Corrupt PDF Fixture', authors: ['B'], year: 2024, licenseVerified: true, license: 'cc-by-4.0'},
        {id: '2401.99993', title: 'Scanned Empty PDF Fixture', authors: ['C'], year: 2024, licenseVerified: true, license: 'cc-by-4.0'},
        {id: '2401.99994', title: 'Scanned Stamp Only Fixture', authors: ['D'], year: 2024, licenseVerified: true, license: 'cc-by-4.0'},
        {id: '2309.15217', title: 'Valid Ragas Paper', authors: ['E'], year: 2023, licenseVerified: true, license: 'cc-by-4.0'},
      ],
    },
  };
  const page = await openPage(browser, viewport, desk, opts, pageErrors);
  try {
    if (!desk) await page.locator('#booth-search-box > summary').click();
    await page.locator('#booth-search-q').fill('eligibility');
    await page.locator('#booth-search-go').click();
    const cards = page.locator('#booth-search-results .booth-search-item button');
    await cards.nth(4).waitFor();

    const cases = [
      [0, '암호가 걸린 PDF라 열지 못했어요. 다른 논문을 골라 주세요.'],
      [1, 'PDF를 읽지 못했어요. 다른 논문을 골라 주세요.'],
      [2, '편집할 텍스트가 없는 스캔 PDF예요. 다른 논문을 골라 주세요.'],
      [3, '편집할 텍스트가 없는 스캔 PDF예요. 다른 논문을 골라 주세요.'],
    ];
    for (const [idx, expected] of cases) {
      await cards.nth(idx).click();
      await page.waitForFunction(msg => document.querySelector('#booth-search-status')?.textContent === msg, expected);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'pick');
      assert.equal(await page.locator('#booth-search-q').inputValue(), 'eligibility');
      assert.equal(await cards.count(), 5);
      assert.equal(opts.submissions.length, 0);
    }

    // Verify EN translation on the visible status and restore KO.
    const toggleSel = desk ? '#booth-lang-desk' : '#booth-lang-pick';
    await page.locator(toggleSel).click();
    await page.waitForFunction(() => document.querySelector('#booth-search-status')?.textContent === 'This scanned PDF has no editable text. Please pick another paper.');
    await page.locator(toggleSel).click();

    // Selecting the valid paper right after opens cleanly to edit.
    await cards.nth(4).click();
    await stepIs(page, 'edit');
    await page.waitForFunction(() => !!globalThis.FalsifyPaperWorkspace?.getPdfDoc?.());
  } finally {
    await page.close();
  }
}

/* Confirmed 205-page PDF (>200p shared-import cap) + 420-char search title:
   #paper-file stays intact (no shared import clearing), title truncates to 300 chars at selection, manual edit & submit succeed. */
async function longPdfAndLongTitlePass(browser, viewport, desk, pageErrors) {
  const longTitle = 'A Comprehensive Evaluation of Large-Scale Scientific Benchmarks ' + 'with Extended Analysis '.repeat(18) + 'Final';
  assert.ok(longTitle.length > 400);
  const opts = {
    pdfIds: [],
    submissions: [],
    pdfMap: {'2402.20500': LONG_205P_PDF},
    searchBody: {
      source: 'arxiv', page: 1, hasMore: false,
      results: [{
        id: '2402.20500',
        title: longTitle,
        authors: ['Ada Lovelace'],
        year: 2024,
        licenseVerified: true,
        license: 'cc-by-4.0',
      }],
    },
  };
  const page = await openPage(browser, viewport, desk, opts, pageErrors);
  try {
    if (!desk) await page.locator('#booth-search-box > summary').click();
    await page.locator('#booth-search-q').fill('205 pages');
    await page.locator('#booth-search-go').click();
    const cardBtn = page.locator('#booth-search-results .booth-search-item button').first();
    await cardBtn.waitFor();
    const cardTitle = await cardBtn.locator('.title').textContent();
    assert.ok(cardTitle.length > 0 && cardTitle.length <= 300);
    assert.equal(cardTitle, cardTitle.trim());

    await cardBtn.click();
    await stepIs(page, 'edit');
    await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace?.getPdfDoc?.()?.numPages === 205);
    // Give any stray async task a moment to prove app.js shared-import does NOT clear #paper-file.
    await page.waitForTimeout(300);
    const fileState = await page.evaluate(() => ({
      filesLen: document.getElementById('paper-file')?.files?.length || 0,
      importStatus: document.getElementById('import-status')?.textContent || '',
      paperTitle: globalThis.FalsifyBoothPaper?.current?.()?.title || '',
    }));
    assert.equal(fileState.filesLen, 1, '#paper-file was NOT cleared by shared 200p import');
    assert.equal(fileState.importStatus, '', 'shared import did not run on event.html');
    assert.equal(fileState.paperTitle, cardTitle);

    await page.evaluate(() => {
      globalThis.FalsifyBoothEdits.add({
        pageIndex: 0,
        rects: [{x: 0.1, y: 0.08, w: 0.2, h: 0.02}],
        originalText: '0.95',
        newText: '0.50',
        source: 'tap',
      });
    });
    await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
    await page.locator('#booth-next').click();
    await stepIs(page, 'send');
    await page.locator('#booth-submit-button').click();
    await stepIs(page, 'ticket');
    assert.equal(opts.submissions.length, 1);
    const parsed = oracle.parseMultipart(opts.submissions[0].body, opts.submissions[0].contentType);
    assert.ok(parsed.meta.paper.title.length > 0 && parsed.meta.paper.title.length <= 300);
    assert.equal(parsed.meta.paper.title, cardTitle);
  } finally {
    await page.close();
  }
}

/* Optional AI / recipe broken or throwing must not block manual tap-to-edit and submission. */
async function optionalAiIsolatedPass(browser, viewport, desk, pageErrors) {
  const opts = {pdfIds: [], submissions: []};
  const page = await browser.newPage({
    viewport, deviceScaleFactor: 1, hasTouch: !desk, locale: 'ko-KR',
  });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.includes('booth-myai.js')) return route.abort();
    if (url.startsWith(base)) return route.continue();
    return stubApi(route, opts);
  });
  try {
    await page.goto(base + 'event.html');
    await page.locator('#booth-missions .booth-mission').first().waitFor();
    await page.evaluate(() => {
      globalThis.FalsifyBoothRecipe = {assist() { throw new Error('optional recipe crashed'); }};
    });
    await page.locator('#booth-missions .booth-mission').first().click();
    await stepIs(page, 'edit');
    await page.waitForFunction(() => !!globalThis.FalsifyPaperWorkspace?.getPdfDoc?.());
    await page.evaluate(() => {
      globalThis.FalsifyBoothEdits.add({
        pageIndex: 4,
        rects: [{x: 0.1, y: 0.2, w: 0.08, h: 0.02}],
        originalText: '0.95',
        newText: '0.50',
        source: 'tap',
      });
    });
    await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
    await page.locator('#booth-next').click();
    await stepIs(page, 'send');
    await page.locator('#booth-submit-button').click();
    await stepIs(page, 'ticket');
    assert.equal(opts.submissions.length, 1);
  } finally {
    await page.close();
  }
}

/* 12-page PDFs with empty front matter: fully scanned 12p rejects after scanning all 12 pages,
   while 12p with selectable text starting on page 11 stays open, renders page 11 text, edits, and submits. */
async function lateTextAndLongScannedPass(browser, viewport, desk, pageErrors) {
  const opts = {
    pdfIds: [],
    submissions: [],
    pdfMap: {
      '2402.12000': SCANNED_12P_EMPTY_PDF,
      '2402.12011': LATE_TEXT_12P_PDF,
    },
    searchBody: {
      source: 'arxiv', page: 1, hasMore: false,
      results: [
        {id: '2402.12000', title: 'Fully Scanned 12-Page Atlas', authors: ['X'], year: 2024, licenseVerified: true, license: 'cc-by-4.0'},
        {id: '2402.12011', title: '12-Page Paper With Text On Page 11', authors: ['Y'], year: 2024, licenseVerified: true, license: 'cc-by-4.0'},
      ],
    },
  };
  const page = await openPage(browser, viewport, desk, opts, pageErrors);
  try {
    if (!desk) await page.locator('#booth-search-box > summary').click();
    await page.locator('#booth-search-q').fill('atlas');
    await page.locator('#booth-search-go').click();
    const cards = page.locator('#booth-search-results .booth-search-item button');
    await cards.nth(1).waitFor();

    // 1. 12-page fully empty PDF returns to pick with query & results intact once all 12 pages are verified empty.
    await cards.nth(0).click();
    await page.waitForFunction(() => document.querySelector('#booth-search-status')?.textContent === '편집할 텍스트가 없는 스캔 PDF예요. 다른 논문을 골라 주세요.');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'pick');
    assert.equal(await page.locator('#booth-search-q').inputValue(), 'atlas');
    assert.equal(await cards.count(), 2);
    assert.equal(opts.submissions.length, 0);

    // 2. 12-page PDF with image-only pages 1..10 and selectable text on page 11 stays open and submittable.
    await cards.nth(1).click();
    await stepIs(page, 'edit');
    await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace?.getPdfDoc?.()?.numPages === 12);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'edit', 'stays on edit after background tail scan finds page 11 text');
    await page.evaluate(() => globalThis.FalsifyPaperWorkspace.showPage(11, {scroll: false}));
    await page.waitForFunction(() => (document.querySelector('#paper-before-stage .paper-text-layer')?.textContent || '').includes('Late selectable text 0.95'));
    await findAndReplace(page, desk, '0.95', '0.50');
    await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
    await page.locator('#booth-next').click();
    await stepIs(page, 'send');
    await page.locator('#booth-submit-button').click();
    await stepIs(page, 'ticket');
    assert.equal(opts.submissions.length, 1);
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
    await unreadablePdfPass(browser, desk, true, pageErrors);
    await unreadablePdfPass(browser, phone, false, pageErrors);
    await lateTextAndLongScannedPass(browser, desk, true, pageErrors);
    await longPdfAndLongTitlePass(browser, desk, true, pageErrors);
    await optionalAiIsolatedPass(browser, desk, true, pageErrors);
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
