'use strict';
// Real Chromium walk of 「다음」 on event.html with the Ragas mission (arXiv 2309.15217, CC BY 4.0):
// a percent sign replaced with a digit reaches send on a phone (찾아 바꾸기) and on desktop (the word bar),
// and a forced generator failure names the edit, offers a fix in place and lets the visitor retry.
// The API is stubbed. FALSIFY_BOOTH_MISSION_PDF names a local copy of the paper.
// BOOTH_MAKE_SHOTS, when set, is a directory for screenshots of each state.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217 (the Ragas paper)');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const shots = process.env.BOOTH_MAKE_SHOTS || '';
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_MAKE_PORT || 8893);
const token = 'fsg_' + 'd'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);
const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*'};
const MADE_MS = 150000;

function serve() {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: dist, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PYTHONUNBUFFERED: '1'},
  });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.stderr.on('data', chunk => { text += chunk; });
  const ready = (async () => {
    const started = Date.now();
    while (Date.now() - started < 8000) {
      if (child.exitCode != null) throw new Error('http.server exited ' + child.exitCode + '\n' + text);
      try { if ((await fetch('http://127.0.0.1:' + port + '/event.html')).ok) return; } catch { /* not yet */ }
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
    enabled: true, submissionsOpen: true, announcement: '', consentVersion: '2026-11-22.v2',
    limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216},
    missions: [{
      paperId: '2309.15217', title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
      license: 'cc-by-4.0', course: 'quick', hint: 'Table 1의 점수 하나를 바꿔 보세요', pageHint: 5,
    }],
  };
}

async function stubApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (!url.href.startsWith(api)) return route.abort();
  if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
  if (request.method() === 'POST' && url.pathname === '/v1/ai/guest') {
    return json(route, 200, {guest: {token, expiresAt: new Date(Date.now() + 864e5).toISOString()}});
  }
  if (url.pathname === '/v1/ai/capabilities') {
    return json(route, 200, {enabled: true, provider: 'anthropic', execution: 'server', models: ['claude-opus-5-5'], efforts: ['high'],
      limits: {maxUploadBytes: 33554432, maxPromptChars: 8000}, modelJobs: false, blueJobs: false});
  }
  if (url.pathname === '/v1/booth/config') return json(route, 200, boothConfig());
  if (url.pathname === '/v1/papers/pdf') {
    return route.fulfill({status: 200, contentType: 'application/pdf',
      headers: {...cors, 'X-Falsify-Paper-License': 'cc-by-4.0', 'Content-Disposition': 'attachment; filename="2309.15217.pdf"'}, body: pdfBytes});
  }
  return json(route, 404, {error: {code: 'not_found'}});
}

async function shoot(page, name, wide) {
  if (!shots) return;
  fs.mkdirSync(shots, {recursive: true});
  await page.screenshot({path: path.join(shots, name + (wide ? '-1280' : '-390') + '.png')});
}

let lastPage = null;
async function diagnose() {
  if (!lastPage || lastPage.isClosed()) return null;
  if (shots) await lastPage.screenshot({path: path.join(shots, 'failure.png')}).catch(() => {});
  return lastPage.evaluate(() => ({
    step: document.documentElement.dataset.boothStep,
    dock: document.querySelector('#booth-dock-status')?.textContent || '',
    gen: document.querySelector('#paper-generate-status')?.textContent || '',
    edits: (globalThis.FalsifyPaperWorkspace?.getEditSnapshot()?.edits || []).map(edit => [edit.segmentId, edit.before, edit.after]),
  })).catch(() => null);
}

async function openMission(browser, wide) {
  const context = await browser.newContext(wide
    ? {viewport: {width: 1280, height: 800}, deviceScaleFactor: 1, locale: 'ko-KR'}
    : {viewport: {width: 390, height: 844}, deviceScaleFactor: 3, hasTouch: true, isMobile: false, locale: 'ko-KR'});
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  lastPage = page;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.accept(); });
  const base = 'http://127.0.0.1:' + port + '/';
  await page.route('**/*', route => (route.request().url().startsWith(base) ? route.continue() : stubApi(route)));
  await page.goto(base + 'event.html');
  await page.locator('#booth-missions .booth-mission').first().click();
  await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'edit');
  await page.waitForFunction(() => /^5 \//.test(document.querySelector('#paper-page-label')?.textContent || '')
    && (globalThis.FalsifyPaperWorkspace.getPageParagraphs()?.items || []).some(item => item.text.includes('0.95')));
  return {page, errors};
}

function editCount(page, n) {
  return page.waitForFunction(count => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 ' + count + '개', n);
}

/* 찾아 바꾸기: on phones it is the closed fold below the page, on desktop the find pane. */
async function findReplace(page, wide, find, replace) {
  const pane = page.locator(wide ? '#booth-pane-find' : '#booth-find-fold');
  if (!wide && !(await pane.evaluate(node => node.open))) await pane.locator('summary').click();
  await pane.getByLabel('바꿀 글자').first().fill(find);
  await pane.locator('.booth-find-hit').first().waitFor();
  await pane.locator('.booth-find-hit').first().click();
  await pane.getByLabel('새 글자').first().fill(replace);
  await pane.getByRole('button', {name: '바꾸기'}).first().click();
}

async function nextReachesSend(page, wide, name) {
  await page.locator('#booth-next').click();
  await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'send', null, {timeout: MADE_MS});
  assert.equal(await page.locator('#booth-dock-fix').isVisible(), false);
  await shoot(page, name, wide);
}

/* Phone: the visitor's case. 4쪽 "95%" becomes "950" through 찾아 바꾸기. Before the fix this ended in
   「수정본을 만들지 못했어요」: the reflowed paragraph re-hyphenated words and the figure check took them as lost. */
async function phoneSymbol(browser) {
  const {page, errors} = await openMission(browser, false);
  await findReplace(page, false, '95%', '950');
  await editCount(page, 1);
  assert.match(await page.locator('#paper-edits').textContent(), /95% → 950/);
  await nextReachesSend(page, false, 'symbol-send');
  assert.match(await page.locator('#booth-rows').textContent(), /4쪽/);
  assert.equal(errors.join('\n'), '');
  await page.context().close();
}

/* The client rect of the first needle on the drawn page (a run inside a text-layer span). */
function textRect(page, needle) {
  return page.evaluate(needle => {
    for (const span of document.querySelectorAll('#paper-before-stage .paper-page .paper-text-layer span[data-i]')) {
      const node = span.firstChild;
      const at = node && node.nodeType === 3 ? node.data.indexOf(needle) : -1;
      if (at < 0) continue;
      span.scrollIntoView({block: 'center'});
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const r = range.getBoundingClientRect();
      if (r.width > 0) return {x: r.left + r.width / 2, y: r.top + r.height / 2};
    }
    return null;
  }, needle);
}

/* Desktop: the word bar on 4쪽 "95%" turns the percent sign into a digit, "950". */
async function desktopWordBar(browser) {
  const {page, errors} = await openMission(browser, true);
  await page.evaluate(() => globalThis.FalsifyPaperWorkspace.showPage(4));
  await page.waitForFunction(() => /^4 \//.test(document.querySelector('#paper-page-label')?.textContent || ''));
  await page.waitForFunction(() => [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(node => node.textContent.includes('95%')));
  const spot = await textRect(page, '95%');
  assert.ok(spot, '95% on page 4');
  await page.mouse.click(spot.x, spot.y);
  const pop = page.locator('#booth-pe-pop');
  await pop.waitFor({state: 'visible'});
  const input = page.locator('#booth-pe-input');
  const word = await input.inputValue();
  assert.ok(word.includes('95%'), 'the word bar holds 95%: ' + word);
  await input.fill(word.replace('95%', '950'));
  await pop.getByRole('button', {name: '바꾸기'}).click();
  await editCount(page, 1);
  await nextReachesSend(page, true, 'wordbar-send');
  assert.equal(errors.join('\n'), '');
  await page.context().close();
}

/* A generator that fails with the engine's NOT_FOUND: the dock names the edit, offers 다시 고치기 and
   지우기, and after the visitor removes and redoes the edit, 「다음」 reaches send. */
async function forcedFailure(browser, wide) {
  const {page, errors} = await openMission(browser, wide);
  await page.evaluate(() => {
    const engine = globalThis.FalsifyParagraphPdf;
    const prepare = engine.prepare;
    globalThis.__boothFail = true;
    engine.prepare = request => {
      if (!globalThis.__boothFail) return prepare(request);
      const edits = Array.isArray(request.edits) ? request.edits : [];
      const failure = Object.assign(new Error('1 edit(s) could not be matched exactly once or planned'), {name: 'ParagraphPdfError', code: 'MATCH_FAILED',
        details: {failures: edits.map(edit => ({id: edit.id, pageIndex: edit.pageIndex, code: 'NOT_FOUND', hits: 0}))}});
      return Promise.reject(failure);
    };
  });
  await findReplace(page, wide, '0.95', '0.50');
  await editCount(page, 1);
  await page.locator('#booth-next').click();
  await page.locator('#booth-dock-fix').waitFor({state: 'visible', timeout: MADE_MS});
  assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'edit');
  assert.equal(await page.locator('#booth-dock-status').textContent(), '5쪽 「0.95 → 0.50」: 이 자리를 쪽에서 찾지 못했어요. 지우거나 다시 고쳐 주세요.');
  assert.deepEqual(await page.locator('#booth-dock-fix button').allTextContents(), ['다시 고치기', '이 고친 곳 지우기']);
  for (const box of await page.locator('#booth-dock-fix button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()))) {
    assert.ok(box.height >= 44, 'fix buttons are 44px tap targets ' + JSON.stringify(box));
  }
  assert.equal(await page.locator('#booth-next').isEnabled(), true);
  await shoot(page, 'forced-failure', wide);
  await page.locator('#booth-dock-fix').getByRole('button', {name: '이 고친 곳 지우기'}).click();
  await editCount(page, 0);
  assert.equal(await page.locator('#booth-dock-fix').isVisible(), false);
  assert.equal(await page.locator('#booth-dock-status').textContent(), '');
  await page.evaluate(() => { globalThis.__boothFail = false; });
  await findReplace(page, wide, '0.95', '0.50');
  await editCount(page, 1);
  await nextReachesSend(page, wide, 'retry-send');
  assert.equal(errors.join('\n'), '');
  await page.context().close();
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    await phoneSymbol(browser);
    await desktopWordBar(browser);
    await forcedFailure(browser, false);
    await forcedFailure(browser, true);
  } catch (error) {
    error.message += '\npage=' + JSON.stringify(await diagnose());
    throw error;
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth make browser passed'); }, error => {
  console.error(error && error.message);
  console.error(error && error.stack || error);
  process.exit(1);
});
