'use strict';
// End-to-end R1 + R2 + R3 browser spec for event.html on the Ragas mission paper (arXiv 2309.15217, CC BY 4.0).
// Drives event.html against stubbed APIs at both 390x844 touch (phone) and 1280x800 (desktop),
// intercepts POST /v1/booth/submissions, parses the multipart body, and validates the submitted PDF
// in Node with the vendored MuPDF oracle (app/tests/helpers/pdf-oracle.cjs).
//
// Proves:
// - R1: edits always reach send and submit without refusal messages (no 못했어요 / 없어요 / 고쳐 주세요),
//       except the sole permitted failure: offline PDF engine with 「다시 시도」.
// - R2: the submitted PDF has 8 pages, %PDF- magic, size <= 16 MiB, matching editedSha256,
//       extractable new text (with search quads and no NUL bytes), original occurrence removed
//       from extraction and content streams, and untouched text preserved.
// - R3: blind-pdf trust capability claimed, consentVersion 2026-11-22.v3, sourceSha256 & declared payload.
//
// Env:
//   FALSIFY_BOOTH_MISSION_PDF  path to local arXiv 2309.15217.pdf (required)
//   BROWSER_EXECUTABLE         optional Chromium binary path
//   BOOTH_R1R2_PORT            optional HTTP port (default 19930, range 19930-19939)
//   BOOTH_R1R2_SHOTS           optional directory for failure/step screenshots
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
const shots = process.env.BOOTH_R1R2_SHOTS || '';
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_R1R2_PORT || 19930);
const token = 'fsg_' + 'e'.repeat(43);
const sourcePdfBytes = fs.readFileSync(pdfPath);
const CONSENT_VERSION = '2026-11-22.v3';
const FORBIDDEN_MESSAGE = /못했어요|없어요|고쳐 주세요/;
const MESSAGE_SELECTORS = [
  '[role="status"]',
  '[role="alert"]',
  '.booth-feedback',
  '.booth-pe-status',
  '.booth-find-ask',
  '.booth-find-note',
  '#booth-dock-status',
  '#booth-submit-status',
  '#booth-status',
  '#booth-agent-status',
  '#paper-before-status',
  '#paper-edit-status',
  '#paper-generate-status',
  '#paper-workspace-status',
].join(', ');
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const AGENT_RECIPE = {
  schema: 'falsify.booth.recipe.v1',
  paperId: '2309.15217',
  edits: [{page: 5, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'}],
  defectType: 'number',
  reason: 'Table 1 Ragas faithfulness lowered from 0.95 to 0.50.',
  source: 'agent',
  agent: {name: 'Claude Code', model: 'claude-opus-5-5'},
  code: 'R-ABC123',
  createdAt: '2026-11-22T00:58:00.000Z',
  expiresAt: '2026-11-22T06:58:00.000Z',
};

function serve() {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: dist,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, PYTHONUNBUFFERED: '1'},
  });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.stderr.on('data', chunk => { text += chunk; });
  const ready = (async () => {
    const started = Date.now();
    while (Date.now() - started < 8000) {
      if (child.exitCode != null) throw new Error('http.server exited ' + child.exitCode + '\n' + text);
      try { if ((await fetch('http://127.0.0.1:' + port + '/event.html')).ok) return; } catch { /* not listening yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('http.server did not start\n' + text);
  })();
  return {child, ready};
}

function json(route, status, body) {
  return route.fulfill({status, contentType: 'application/json', headers: cors, body: JSON.stringify(body)});
}

function boothConfig() {
  return {
    enabled: true,
    submissionsOpen: true,
    announcement: '',
    consentVersion: CONSENT_VERSION,
    limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216},
    missions: [{
      paperId: '2309.15217',
      title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
      license: 'cc-by-4.0',
      course: 'quick',
      hint: 'Table 1의 점수 하나를 바꿔 보세요',
      pageHint: 5,
    }],
  };
}

async function stubApi(route, submissions) {
  const request = route.request();
  const url = new URL(request.url());
  if (!url.href.startsWith(api)) return route.abort();
  if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
  if (request.method() === 'POST' && url.pathname === '/v1/ai/guest') {
    return json(route, 200, {guest: {token, expiresAt: new Date(Date.now() + 864e5).toISOString()}});
  }
  if (url.pathname === '/v1/ai/capabilities') {
    return json(route, 200, {
      enabled: true, provider: 'anthropic', execution: 'server',
      models: ['claude-opus-5-5'], efforts: ['high'],
      limits: {maxUploadBytes: 33554432, maxPromptChars: 8000},
      modelJobs: false, blueJobs: false,
    });
  }
  if (url.pathname === '/v1/booth/config') return json(route, 200, boothConfig());
  if (url.pathname === '/v1/papers/pdf') {
    return route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: {...cors, 'X-Falsify-Paper-License': 'cc-by-4.0', 'Content-Disposition': 'attachment; filename="2309.15217.pdf"'},
      body: sourcePdfBytes,
    });
  }
  if (request.method() === 'GET' && url.pathname === '/v1/booth/recipes/R-ABC123') {
    return json(route, 200, AGENT_RECIPE);
  }
  if (request.method() === 'POST' && url.pathname === '/v1/booth/submissions') {
    let body = Buffer.alloc(0);
    try { body = request.postDataBuffer() || Buffer.alloc(0); } catch { body = Buffer.alloc(0); }
    const headers = request.headers();
    submissions.push({body, contentType: headers['content-type'] || ''});
    let declaredCount = 1;
    try {
      const parsed = oracle.parseMultipart(body, headers['content-type'] || '');
      if (parsed.meta && Array.isArray(parsed.meta.declared)) declaredCount = parsed.meta.declared.length;
    } catch { /* fallback to 1 */ }
    return json(route, 201, {
      receipt: 'F-0090', claimKey: '7Q3K-M9XD', status: 'received',
      course: 'quick', declaredCount, createdAt: '2026-11-22T01:00:00.000Z',
    });
  }
  if (url.pathname === '/v1/booth/claim' && (request.method() === 'GET' || request.method() === 'POST')) {
    return json(route, 200, {
      receipt: 'F-0090', status: 'reviewing', course: 'quick',
      declaredCount: 1, createdAt: '2026-11-22T01:00:00.000Z', published: false,
    });
  }
  return json(route, 404, {error: {code: 'not_found'}});
}

let lastPage = null;
async function diagnose() {
  if (!lastPage || lastPage.isClosed()) return null;
  if (shots) {
    fs.mkdirSync(shots, {recursive: true});
    await lastPage.screenshot({path: path.join(shots, 'failure.png'), fullPage: true}).catch(() => {});
  }
  return lastPage.evaluate(sel => ({
    step: document.documentElement.dataset.boothStep,
    page: document.querySelector('#paper-page-label')?.textContent || '',
    dockCount: document.querySelector('#booth-dock-count')?.textContent || '',
    dockStatus: document.querySelector('#booth-dock-status')?.textContent || '',
    submitStatus: document.querySelector('#booth-submit-status')?.textContent || '',
    messages: [...document.querySelectorAll(sel)]
      .filter(node => node.offsetParent !== null && node.textContent.trim())
      .map(node => ({id: node.id || node.className, text: node.textContent.trim()})),
    boothEdits: globalThis.FalsifyBoothEdits?.list?.() || null,
  }), MESSAGE_SELECTORS).catch(() => null);
}

function stepIs(page, name, timeout = 90000) {
  return page.waitForFunction(value => document.documentElement.dataset.boothStep === value, name, {timeout});
}

function editCountIs(page, n) {
  return page.waitForFunction(count => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 ' + count + '개', n);
}

/* Assert that no visible status/feedback/alert message contains refusal wording (못했어요, 없어요, 고쳐 주세요). */
async function assertNoRefusalMessages(page, label) {
  const seen = await page.evaluate(sel => {
    return [...document.querySelectorAll(sel)]
      .filter(node => {
        if (node.hidden) return false;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return node.offsetParent !== null || style.position === 'fixed';
      })
      .map(node => ({id: node.id || node.className, text: node.textContent.trim()}))
      .filter(item => item.text.length > 0);
  }, MESSAGE_SELECTORS);
  const bad = seen.filter(item => FORBIDDEN_MESSAGE.test(item.text));
  assert.deepEqual(bad, [], `${label}: forbidden refusal message(s) appeared: ${JSON.stringify(bad)}`);
}

async function openContext(browser, wide, opts = {}) {
  const submissions = [];
  const errors = [];
  const context = await browser.newContext(wide
    ? {viewport: {width: 1280, height: 800}, deviceScaleFactor: 1, locale: 'ko-KR'}
    : {viewport: {width: 390, height: 844}, deviceScaleFactor: 3, hasTouch: true, isMobile: false, locale: 'ko-KR'});
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  lastPage = page;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.accept(); });
  const base = 'http://127.0.0.1:' + port + '/';
  await page.route('**/*', route => {
    const url = route.request().url();
    if (opts.abortMuPdf && /mupdf.*\.(?:wasm|js)(?:\?|$)/i.test(url)) return route.abort('failed');
    if (url.startsWith(base)) return route.continue();
    return stubApi(route, submissions);
  });
  await page.goto(base + 'event.html' + (opts.hash || ''));
  return {context, page, submissions, errors};
}

async function waitPageRendered(page, pageNum, needle) {
  await page.waitForFunction(
    ([n, text]) => new RegExp('^' + n + ' /').test(document.querySelector('#paper-page-label')?.textContent || '')
      && [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(node => node.textContent.includes(text)),
    [pageNum, needle],
  );
}

async function openMission(browser, wide, opts = {}) {
  const session = await openContext(browser, wide, opts);
  const {page} = session;
  await page.locator('#booth-missions .booth-mission').first().click();
  await stepIs(page, 'edit');
  await waitPageRendered(page, 5, '0.95');
  // R3: blind-pdf trust capability is already claimed by booth.js at boot.
  assert.equal(await page.evaluate(() => globalThis.FalsifyBlindPdf.claimTrust()), null, 'blind-pdf trust capability already claimed');
  return session;
}

async function goToPage(page, pageNum, needle) {
  await page.evaluate(n => globalThis.FalsifyPaperWorkspace.showPage(n), pageNum);
  await waitPageRendered(page, pageNum, needle);
}

/* Locate the nth occurrence of needle in the rendered text layer (reading order by data-i),
   scroll it into the center of #paper-before-stage, and return its viewport click/tap coordinates. */
function tokenPoint(page, needle, nth = 0) {
  return page.evaluate(([value, n]) => {
    const spans = [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')]
      .sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i));
    const hits = [];
    for (const span of spans) {
      const text = span.textContent || '';
      for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
        hits.push({span, at});
      }
    }
    const hit = hits[n];
    if (!hit) return null;
    hit.span.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
    const walker = document.createTreeWalker(hit.span, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    const endAt = hit.at + value.length;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const len = node.nodeValue.length;
      if (!startNode && hit.at <= offset + len) { startNode = node; startOff = hit.at - offset; }
      if (startNode && endAt <= offset + len) { endNode = node; endOff = endAt - offset; break; }
      offset += len;
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    const stage = document.getElementById('paper-before-stage');
    const stageBox = stage.getBoundingClientRect();
    const first = range.getBoundingClientRect();
    if (stage.scrollWidth > stage.clientWidth) {
      stage.scrollLeft += (first.left + first.width / 2) - (stageBox.left + stageBox.width / 2);
    }
    if (stage.scrollHeight > stage.clientHeight) {
      stage.scrollTop += (first.top + first.height / 2) - (stageBox.top + stageBox.height / 2);
    }
    const r = range.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  }, [needle, nth]);
}

async function tapToken(page, wide, needle, nth = 0) {
  const tap = (x, y) => (wide ? page.mouse.click(x, y) : page.touchscreen.tap(x, y));
  // On touch phones, the first tap at zoom 1 may zoom into the tapped area before opening the word bar.
  if (!wide && await page.evaluate(() => (globalThis.FalsifyPaperWorkspace?.getZoom?.() || 1) === 1)) {
    const first = await tokenPoint(page, needle, nth);
    assert.ok(first, `could not locate ${JSON.stringify(needle)}[${nth}] at zoom 1`);
    await tap(first.x, first.y);
    if (await page.locator('#booth-pe-pop').waitFor({state: 'visible', timeout: 500}).then(() => true, () => false)) {
      return;
    }
    await page.waitForFunction(() => (globalThis.FalsifyPaperWorkspace?.getZoom?.() || 1) > 1, null, {timeout: 5000}).catch(() => {});
    await page.waitForTimeout(250);
  }
  for (let tries = 0; tries < 5; tries += 1) {
    let pt = null;
    let prev = null;
    for (let still = 0; still < 15; still += 1) {
      pt = await tokenPoint(page, needle, nth);
      assert.ok(pt, `could not locate ${JSON.stringify(needle)}[${nth}] on page`);
      if (prev && Math.abs(prev.x - pt.x) < 0.5 && Math.abs(prev.y - pt.y) < 0.5) break;
      prev = pt;
      await page.waitForTimeout(100);
    }
    await tap(pt.x, pt.y);
    if (await page.locator('#booth-pe-pop').waitFor({state: 'visible', timeout: 2000}).then(() => true, () => false)) {
      return;
    }
  }
  throw new Error(`word popover did not open for ${JSON.stringify(needle)}[${nth}]`);
}

async function tapAndReplace(page, wide, needle, replacer, nth = 0) {
  await tapToken(page, wide, needle, nth);
  const input = page.locator('#booth-pe-input');
  const current = await input.inputValue();
  const next = typeof replacer === 'function' ? replacer(current) : replacer;
  await input.fill(next);
  await page.locator('#booth-pe-pop').getByRole('button', {name: '바꾸기', exact: true}).click();
  await page.locator('#booth-pe-pop').waitFor({state: 'hidden'});
}

/* Open 「문단 전체 고치기」 from the active popover, edit the sheet textarea, and apply. */
async function openParagraphSheetAndEdit(page, transform) {
  const wholeBtn = page.locator('#booth-pe-pop').getByRole('button', {name: '문단 전체 고치기'});
  assert.equal(await wholeBtn.isDisabled(), false, '문단 전체 고치기 must always be enabled (R1)');
  await wholeBtn.click();
  const textarea = page.locator('textarea:visible').last();
  await textarea.waitFor({state: 'visible'});
  const original = await textarea.inputValue();
  const next = transform(original);
  await textarea.fill(next);
  // Find the submit button (바꾸기 or 완료) belonging to the paragraph sheet container.
  const clicked = await textarea.evaluate(node => {
    let cur = node.parentElement;
    while (cur && cur !== document.body) {
      const btn = [...cur.querySelectorAll('button')].find(b => {
        if (b.offsetParent === null) return false;
        const label = b.textContent.trim();
        return label === '바꾸기' || label === '완료';
      });
      if (btn) { btn.click(); return true; }
      cur = cur.parentElement;
    }
    return false;
  });
  assert.equal(clicked, true, 'paragraph sheet must have a visible 바꾸기/완료 button');
  await textarea.waitFor({state: 'hidden'});
}

async function findAndReplace(page, wide, find, replace) {
  const pane = page.locator(wide ? '#booth-pane-find' : '#booth-find-fold');
  if (!wide && !(await pane.evaluate(node => node.open))) await pane.locator('summary').click();
  await pane.getByLabel('바꿀 글자').first().fill(find);
  await pane.getByLabel('새 글자').first().fill(replace);
  // Wait briefly for live search index results; if a hit list renders, pick the first hit when >1 hits exist.
  await pane.locator('.booth-find-hit').first().waitFor({state: 'visible', timeout: 5000}).catch(() => {});
  const hitCount = await pane.locator('.booth-find-hit').count();
  if (hitCount > 1) {
    await pane.locator('.booth-find-hit').first().click();
  }
  await pane.getByRole('button', {name: '바꾸기'}).first().click();
}

async function submitAndCapture(page, submissions, expectedCount, label) {
  await assertNoRefusalMessages(page, label + ':before-next');
  await page.locator('#booth-next').click();
  await stepIs(page, 'send', 120000);
  await assertNoRefusalMessages(page, label + ':send');

  const cards = page.locator('#booth-rows .booth-card');
  assert.equal(await cards.count(), expectedCount, `${label}: send step card count`);
  for (let i = 0; i < expectedCount; i += 1) {
    const card = cards.nth(i);
    const anyPressed = await card.locator('button[aria-pressed="true"]').count();
    if (!anyPressed) await card.getByRole('button', {name: '수치·통계'}).click();
    const reason = card.locator('textarea');
    if (!(await reason.inputValue()).trim()) await reason.fill(`${label} defect ${i + 1}`);
  }
  await page.locator('#booth-consent').check();
  await page.locator('#booth-submit-button').click();
  await stepIs(page, 'ticket', 30000);
  await assertNoRefusalMessages(page, label + ':ticket');

  assert.ok(submissions.length >= 1, `${label}: POST /v1/booth/submissions must have been sent`);
  const last = submissions[submissions.length - 1];
  const parsed = oracle.parseMultipart(last.body, last.contentType);
  assert.equal(parsed.pdfFilename, 'edited.pdf', `${label}: pdf filename`);
  assert.equal(parsed.pdfContentType, 'application/pdf', `${label}: pdf content-type`);
  return parsed;
}

async function runSession(openFn, bodyFn) {
  const session = await openFn();
  try {
    return await bodyFn(session);
  } catch (error) {
    const info = await diagnose();
    if (info && error && typeof error.message === 'string' && !error.message.includes('\ndiagnose=')) {
      error.message += '\ndiagnose=' + JSON.stringify(info);
    }
    throw error;
  } finally {
    await session.context.close();
  }
}

/* Case 1: Delete the whole Table 1 caption on page 5 (exact regression case). */
async function caseCaptionDelete(browser, wide) {
  const label = `caption-delete(${wide ? '1280' : '390'})`;
  await runSession(() => openMission(browser, wide), async ({page, submissions, errors}) => {
    await tapToken(page, wide, 'WikEval', 0);
    await openParagraphSheetAndEdit(page, text => {
      assert.ok(text.includes('Agreement') && text.includes('WikEval'), `${label}: sheet text missing caption: ${JSON.stringify(text)}`);
      return '';
    });
    await editCountIs(page, 1);
    const parsed = await submitAndCapture(page, submissions, 1, label);
    assert.equal(parsed.meta.declared[0].pageIndex, 4, `${label}: declared pageIndex`);
    assert.equal(parsed.meta.declared[0].after, '', `${label}: deletion declares empty after`);
    await oracle.assertSubmittedPdf({
      label,
      meta: parsed.meta,
      pdfBytes: parsed.pdfBytes,
      sourcePdfBytes,
      expectedPages: 8,
      consentVersion: CONSENT_VERSION,
      expectations: [{
        pageIndex: 4,
        mustNotContain: ['Agreement with human annotators', 'pairwise comparisons', 'WikEval'],
        untouched: ['0.95', '0.78', '0.70', 'GPT Score', 'GPT Ranking', 'Experiments'],
      }],
    });
    assert.equal(errors.join('\n'), '', `${label}: uncaught page errors`);
  });
}

/* Case 2: Tap 0.95 -> 0.50, and the second 0.52 -> 0.11 (the first 0.52 stays) on page 5. */
async function caseTapScores(browser, wide, sourceRefs) {
  const label = `tap-scores(${wide ? '1280' : '390'})`;
  await runSession(() => openMission(browser, wide), async ({page, submissions, errors}) => {
    await tapAndReplace(page, wide, '0.95', '0.50', 0);
    await editCountIs(page, 1);
    await tapAndReplace(page, wide, '0.52', '0.11', 1);
    await editCountIs(page, 2);
    const parsed = await submitAndCapture(page, submissions, 2, label);
    await oracle.assertSubmittedPdf({
      label,
      meta: parsed.meta,
      pdfBytes: parsed.pdfBytes,
      sourcePdfBytes,
      expectedPages: 8,
      consentVersion: CONSENT_VERSION,
      expectations: [{
        pageIndex: 4,
        mustContain: ['0.50', '0.11'],
        mustNotContain: ['0.95'],
        exactCounts: [['0.52', 1]],
        untouched: ['0.78', '0.70', '0.72', '0.63', '0.54', '0.40', 'Ragas', 'GPT Score', 'GPT Ranking'],
      }],
    });
    // Confirm the surviving 0.52 is the FIRST one (GPT Score row), and 0.11 sits at the SECOND 0.52's position.
    const remaining052 = await oracle.search(parsed.pdfBytes, 4, '0.52');
    const placed011 = await oracle.search(parsed.pdfBytes, 4, '0.11');
    assert.equal(oracle.hasHitNear(remaining052, sourceRefs.first052, 15), true, `${label}: first 0.52 must remain in place`);
    assert.equal(oracle.hasHitNear(remaining052, sourceRefs.second052, 15), false, `${label}: second 0.52 must be gone`);
    assert.equal(oracle.hasHitNear(placed011, sourceRefs.second052, 20), true, `${label}: 0.11 must appear where second 0.52 was`);
    assert.equal(errors.join('\n'), '', `${label}: uncaught page errors`);
  });
}

/* Case 3: Find-and-replace 95% -> 950 on page 4. */
async function caseFindReplace95Pct(browser, wide) {
  const label = `find-95pct(${wide ? '1280' : '390'})`;
  await runSession(() => openMission(browser, wide), async ({page, submissions, errors}) => {
    await findAndReplace(page, wide, '95%', '950');
    await editCountIs(page, 1);
    const parsed = await submitAndCapture(page, submissions, 1, label);
    assert.equal(parsed.meta.declared[0].pageIndex, 3, `${label}: declared pageIndex 3 (page 4)`);
    await oracle.assertSubmittedPdf({
      label,
      meta: parsed.meta,
      pdfBytes: parsed.pdfBytes,
      sourcePdfBytes,
      expectedPages: 8,
      consentVersion: CONSENT_VERSION,
      expectations: [{
        pageIndex: 3,
        mustContain: ['950'],
        mustNotContain: ['95%'],
        untouched: ['90%', 'The WikiEval Dataset', 'Faithfulness'],
      }],
    });
    assert.equal(errors.join('\n'), '', `${label}: uncaught page errors`);
  });
}

/* Case 4: Tap † -> 1 on page 1 (first affiliation dagger in Shahul Es†). */
async function caseTapDagger(browser, wide, sourceRefs) {
  const label = `tap-dagger(${wide ? '1280' : '390'})`;
  await runSession(() => openMission(browser, wide), async ({page, submissions, errors}) => {
    await goToPage(page, 1, '†');
    await tapAndReplace(page, wide, '†', word => {
      assert.ok(word.includes('†'), `${label}: popover must hold †, got ${JSON.stringify(word)}`);
      return word.replace('†', '1');
    }, 0);
    await editCountIs(page, 1);
    const parsed = await submitAndCapture(page, submissions, 1, label);
    assert.equal(parsed.meta.declared[0].pageIndex, 0, `${label}: declared pageIndex 0 (page 1)`);
    await oracle.assertSubmittedPdf({
      label,
      meta: parsed.meta,
      pdfBytes: parsed.pdfBytes,
      sourcePdfBytes,
      expectedPages: 8,
      consentVersion: CONSENT_VERSION,
      expectations: [{
        pageIndex: 0,
        exactCounts: [['†', 2]],
        untouched: ['Ragas: Automated Evaluation', 'Shahul', 'Abstract', 'Introduction'],
      }],
    });
    const daggers = await oracle.search(parsed.pdfBytes, 0, '†');
    const ones = await oracle.search(parsed.pdfBytes, 0, '1');
    assert.equal(oracle.hasHitNear(daggers, sourceRefs.firstDagger, 12), false, `${label}: first † must be removed`);
    assert.equal(oracle.hasHitNear(ones, sourceRefs.firstDagger, 20), true, `${label}: digit 1 must appear at first † position`);
    assert.equal(errors.join('\n'), '', `${label}: uncaught page errors`);
  });
}

/* Case 5: Paragraph edit of a body sentence on page 5. */
async function caseParagraphBodyEdit(browser, wide) {
  const label = `paragraph-body(${wide ? '1280' : '390'})`;
  await runSession(() => openMission(browser, wide), async ({page, submissions, errors}) => {
    await tapToken(page, wide, 'randomly', 0);
    await openParagraphSheetAndEdit(page, text => {
      assert.ok(text.includes('broken randomly'), `${label}: sheet text missing target sentence: ${JSON.stringify(text)}`);
      return text.replace('broken randomly', 'broken deterministically');
    });
    await editCountIs(page, 1);
    const parsed = await submitAndCapture(page, submissions, 1, label);
    assert.equal(parsed.meta.declared[0].pageIndex, 4, `${label}: declared pageIndex 4 (page 5)`);
    await oracle.assertSubmittedPdf({
      label,
      meta: parsed.meta,
      pdfBytes: parsed.pdfBytes,
      sourcePdfBytes,
      expectedPages: 8,
      consentVersion: CONSENT_VERSION,
      expectations: [{
        pageIndex: 4,
        mustContain: ['deterministically', 'broken deterministically'],
        mustNotContain: ['broken randomly'],
        untouched: ['0.95', 'GPT Ranking', 'Conclusions'],
      }],
    });
    assert.equal(errors.join('\n'), '', `${label}: uncaught page errors`);
  });
}

/* Case 6: Symbol -> digit (♢ -> 3 on page 1, distinct from † and %). */
async function caseSymbolToDigit(browser, wide, sourceRefs) {
  const label = `symbol-to-digit(${wide ? '1280' : '390'})`;
  await runSession(() => openMission(browser, wide), async ({page, submissions, errors}) => {
    await goToPage(page, 1, '♢');
    await tapAndReplace(page, wide, '♢', word => {
      assert.ok(word.includes('♢'), `${label}: popover must hold ♢, got ${JSON.stringify(word)}`);
      return word.replace('♢', '3');
    }, 0);
    await editCountIs(page, 1);
    const parsed = await submitAndCapture(page, submissions, 1, label);
    assert.equal(parsed.meta.declared[0].pageIndex, 0, `${label}: declared pageIndex 0 (page 1)`);
    await oracle.assertSubmittedPdf({
      label,
      meta: parsed.meta,
      pdfBytes: parsed.pdfBytes,
      sourcePdfBytes,
      expectedPages: 8,
      consentVersion: CONSENT_VERSION,
      expectations: [{
        pageIndex: 0,
        exactCounts: [['♢', 1]],
        untouched: ['Ragas: Automated Evaluation', 'Luis', 'AMPLYFI', 'Abstract'],
      }],
    });
    const diamonds = await oracle.search(parsed.pdfBytes, 0, '♢');
    const threes = await oracle.search(parsed.pdfBytes, 0, '3');
    assert.equal(oracle.hasHitNear(diamonds, sourceRefs.firstDiamond, 12), false, `${label}: first ♢ must be removed`);
    assert.equal(oracle.hasHitNear(threes, sourceRefs.firstDiamond, 20), true, `${label}: digit 3 must appear at first ♢ position`);
    assert.equal(errors.join('\n'), '', `${label}: uncaught page errors`);
  });
}

/* Case 7 (§3.3 #4): Agent recipe deep-link (#recipe=R-ABC123) end-to-end. */
async function caseAgentRecipe(browser, wide) {
  const label = `agent-recipe(${wide ? '1280' : '390'})`;
  await runSession(() => openContext(browser, wide, {hash: '#recipe=R-ABC123'}), async ({page, submissions, errors}) => {
    await stepIs(page, 'edit');
    await editCountIs(page, 1);
    const parsed = await submitAndCapture(page, submissions, 1, label);
    assert.equal(parsed.meta.assist, 'agent', `${label}: meta.assist`);
    assert.equal(parsed.meta.recipeCode, 'R-ABC123', `${label}: meta.recipeCode`);
    await oracle.assertSubmittedPdf({
      label,
      meta: parsed.meta,
      pdfBytes: parsed.pdfBytes,
      sourcePdfBytes,
      expectedPages: 8,
      consentVersion: CONSENT_VERSION,
      expectations: [{
        pageIndex: 4,
        mustContain: ['0.50'],
        mustNotContain: ['0.95'],
        untouched: ['0.78', '0.70'],
      }],
    });
    assert.equal(errors.join('\n'), '', `${label}: uncaught page errors`);
  });
}

/* Case 8 (§3.3 #5): Offline PDF engine error path — the sole permitted failure under R1, with 「다시 시도」. */
async function caseEngineOffline(browser, wide) {
  const label = `engine-offline(${wide ? '1280' : '390'})`;
  await runSession(() => openMission(browser, wide, {abortMuPdf: true}), async ({page, errors}) => {
    await tapAndReplace(page, wide, '0.95', '0.50', 0);
    await editCountIs(page, 1);
    await page.locator('#booth-next').click();
    const retryBtn = page.locator('#booth-step-edit, #booth-dock').getByRole('button', {name: '다시 시도'}).first();
    await retryBtn.waitFor({state: 'visible', timeout: 30000});
    assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'edit', `${label}: stays on edit`);
    assert.equal(await page.locator('#booth-dock-count').textContent(), '고친 곳 1개', `${label}: edit preserved`);
    assert.equal(errors.join('\n'), '', `${label}: no uncaught page errors`);
  });
}

async function computeSourceRefs() {
  assert.equal(sourcePdfBytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(await oracle.countPages(sourcePdfBytes), 8);
  const hits052 = await oracle.search(sourcePdfBytes, 4, '0.52');
  assert.equal(hits052.length, 2, 'source page 5 must have 2 occurrences of 0.52');
  const hitsDagger = await oracle.search(sourcePdfBytes, 0, '†');
  assert.equal(hitsDagger.length, 3, 'source page 1 must have 3 occurrences of †');
  const hitsDiamond = await oracle.search(sourcePdfBytes, 0, '♢');
  assert.equal(hitsDiamond.length, 2, 'source page 1 must have 2 occurrences of ♢');
  return {
    first052: oracle.hitCenter(hits052[0]),
    second052: oracle.hitCenter(hits052[1]),
    firstDagger: oracle.hitCenter(hitsDagger[0]),
    firstDiamond: oracle.hitCenter(hitsDiamond[0]),
  };
}

async function main() {
  const sourceRefs = await computeSourceRefs();
  const server = serve();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    for (const wide of [false, true]) {
      await caseCaptionDelete(browser, wide);
      await caseTapScores(browser, wide, sourceRefs);
      await caseFindReplace95Pct(browser, wide);
      await caseTapDagger(browser, wide, sourceRefs);
      await caseParagraphBodyEdit(browser, wide);
      await caseSymbolToDigit(browser, wide, sourceRefs);
      await caseAgentRecipe(browser, wide);
      await caseEngineOffline(browser, wide);
    }
  } catch (error) {
    error.message += '\ndiagnose=' + JSON.stringify(await diagnose());
    throw error;
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth r1r2 browser passed'); }, error => {
  console.error(error && error.message);
  console.error(error && error.stack || error);
  process.exit(1);
});
