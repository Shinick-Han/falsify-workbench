'use strict';
// Real Chromium checks of booth-runtime.js with booth.js on event.html. The API is stubbed.
// - return to the tab: an immediate claim poll on visibilitychange, polling restarts after it stopped, wake lock
// - offline: config, paper load, polling and submit show the offline line with 다시 시도 and retry on 'online'
// - saved progress: hidden saves the edit; a reload offers 「고친 곳 1개를 이어서 할까요?」 and replays it
// - kiosk (?kiosk=1) on a 1280x800 touch tablet: sessionStorage receipts, 「다음 분께 넘기기」 resets to a fresh
//   guest, and the idle warning 「계속하시겠어요?」 (page.clock)
// FALSIFY_BOOTH_MISSION_PDF names a local copy of arXiv 2309.15217 (CC BY 4.0). Screenshots go to BOOTH_RUNTIME_SHOTS.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217 (the Ragas paper)');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const shots = process.env.BOOTH_RUNTIME_SHOTS || path.join(os.tmpdir(), 'booth-runtime-shots');
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_RUNTIME_PORT || 8886);
const base = 'http://127.0.0.1:' + port + '/';
const pdfBytes = fs.readFileSync(pdfPath);
const OFFLINE = '인터넷 연결이 끊겼어요. 연결되면 다시 눌러 주세요.';
const TABLET = {viewport: {width: 1280, height: 800}, deviceScaleFactor: 2, hasTouch: true, isMobile: true};
const PHONE = {viewport: {width: 390, height: 844}, deviceScaleFactor: 1, hasTouch: true, isMobile: true};

function serve() {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: dist, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PYTHONUNBUFFERED: '1'},
  });
  let text = '';
  const take = chunk => { text += chunk.toString(); };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const ready = (async () => {
    const started = Date.now();
    while (Date.now() - started < 8000) {
      if (child.exitCode != null) throw new Error('http.server exited ' + child.exitCode + '\n' + text);
      try {
        const res = await fetch(base + 'event.html');
        if (res.ok) return;
      } catch { /* not listening yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('http.server did not start\n' + text);
  })();
  return {child, ready};
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
function json(route, status, body) {
  return route.fulfill({status, contentType: 'application/json', headers: cors, body: JSON.stringify(body)});
}
const PENDING = {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00.000Z', published: false};
const CONFIG = {
  enabled: true, submissionsOpen: true, announcement: '', consentVersion: '2026-11-22.v2',
  limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216, perOwner: 5},
  missions: [{
    paperId: '2309.15217', title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
    license: 'cc-by-4.0', course: 'quick', hint: 'Table 1의 점수 하나를 바꿔 보세요', pageHint: 5,
  }],
};
const tokenFor = n => 'fsg_' + String.fromCharCode(96 + n).repeat(43);

/* state: {guests, auth:[], claims, claimMethods:[], submissions, hooks:{config}} */
async function stubApi(route, state) {
  const request = route.request();
  const url = new URL(request.url());
  if (!url.href.startsWith(api)) return route.abort();
  if (state.offline) return route.abort('internetdisconnected');
  if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
  const auth = request.headers().authorization;
  if (auth) state.auth.push(url.pathname + ' ' + auth);
  if (request.method() === 'POST' && url.pathname === '/v1/ai/guest') {
    state.guests += 1;
    return json(route, 200, {guest: {token: tokenFor(state.guests), expiresAt: '2099-01-01T00:00:00.000Z'}});
  }
  if (url.pathname === '/v1/ai/capabilities') {
    return json(route, 200, {enabled: true, provider: 'anthropic', execution: 'server', models: ['claude-opus-5-5'], efforts: ['high'],
      limits: {maxUploadBytes: 33554432, maxPromptChars: 8000}, modelJobs: false, blueJobs: false});
  }
  if (url.pathname === '/v1/booth/config') {
    if (state.hooks.config) return state.hooks.config(route);
    return json(route, 200, CONFIG);
  }
  if (url.pathname === '/v1/papers/pdf') {
    return route.fulfill({status: 200, contentType: 'application/pdf',
      headers: {...cors, 'X-Falsify-Paper-License': 'cc-by-4.0', 'Content-Disposition': 'attachment; filename="2309.15217.pdf"'}, body: pdfBytes});
  }
  if (request.method() === 'POST' && url.pathname === '/v1/booth/submissions') {
    state.submissions += 1;
    const n = state.submissions;
    return json(route, 201, {receipt: 'F-004' + n, claimKey: '7Q3K-M9X' + n, status: 'received', course: 'quick', declaredCount: 1,
      createdAt: new Date().toISOString()});
  }
  // Result polls are a GET with the key in the query (CORS simple, no preflight); POST is the old-Worker fallback.
  if ((request.method() === 'GET' || request.method() === 'POST') && url.pathname === '/v1/booth/claim') {
    state.claims += 1;
    state.claimMethods.push(request.method());
    return json(route, 200, PENDING);
  }
  return json(route, 404, {error: {code: 'not_found'}});
}

function newState() { return {guests: 0, auth: [], claims: 0, claimMethods: [], submissions: 0, hooks: {}, offline: false}; }
/* Routed requests are fulfilled even in an offline context, so the stub fails them itself. */
async function setOffline(context, state, value) {
  state.offline = value;
  await context.setOffline(value);
}

async function openContext(browser, device, state, pageErrors) {
  const context = await browser.newContext({...device, locale: 'ko-KR'});
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(base)) return route.continue();
    return stubApi(route, state);
  });
  return {context, page};
}

function stepIs(page, name) {
  return page.waitForFunction(value => document.documentElement.dataset.boothStep === value, name);
}
async function until(check, ms = 10000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}
async function shot(page, name) {
  fs.mkdirSync(shots, {recursive: true});
  await page.screenshot({path: path.join(shots, name + '.png')});
}
async function visibility(page, state) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => value});
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => value === 'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}
/* One paragraph edit: 0.95 → 0.50 in the Table 1 paragraph, as booth-event-browser does it. */
async function editParagraph(page) {
  // Phones open the mission zoomed on the hint page once its paragraphs are drawn. Wait for that first,
  // then zoom out and wait for the redrawn list, as booth-event-browser does: zooming out earlier is
  // undone by the hint zoom, and an index taken from the old list opens another paragraph.
  await page.waitForFunction(() => [...document.querySelectorAll('.paper-paragraph-button')].some(node => node.textContent.includes('0.95')));
  // The hint zoom fits Table 1 once the paragraph boxes are in, a moment after the list (only once per paper).
  await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() > 1, null, {timeout: 4000}).catch(() => {});
  if (await page.locator('#booth-pe-fit').isVisible()) {
    await page.locator('#booth-pe-fit').click();
    await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1);
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.paper-paragraph-button')].some(node => node.textContent.includes('0.95') && node.textContent.includes('0.78')));
  const listToggle = page.locator('#booth-find-list');
  if (await listToggle.count() && await listToggle.isVisible()) await listToggle.click();
  const index = await page.evaluate(() => {
    const hits = [...document.querySelectorAll('.paper-paragraph-button')].map((node, i) => ({i, text: node.textContent}))
      .filter(item => item.text.includes('0.95') && item.text.includes('0.78') && item.text.length <= 400);
    hits.sort((a, b) => a.text.length - b.text.length);
    return hits.length ? hits[0].i : -1;
  });
  assert.equal(index >= 0, true);
  const paragraph = page.locator('.paper-paragraph-button').nth(index);
  // On event.html the page itself is the editor (booth-pageedit.js); the paragraph list stays for
  // screen readers and keyboards, visually hidden until focused, so open it the keyboard way.
  await paragraph.focus();
  await page.keyboard.press('Enter');
  const editor = page.locator('textarea[aria-label$="직접 편집"]');
  await editor.waitFor();
  const original = await editor.inputValue();
  assert.equal(original.includes('0.95'), true, 'the editor opened the Table 1 paragraph');
  await editor.fill(original.replace('0.95', '0.50'));
  await page.locator('.paper-direct-controls').getByRole('button', {name: '완료', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
}

/* Ticket waiting from a fresh local receipt; return to the tab, wake lock, stopped polling, offline polling. */
async function returnPass(browser, pageErrors) {
  const state = newState();
  const {context, page} = await openContext(browser, PHONE, state, pageErrors);
  await page.clock.install({time: new Date('2026-11-22T01:01:00.000Z')});
  await page.addInitScript(() => {
    localStorage.setItem('falsify.booth.receipts.v1', JSON.stringify([{receipt: 'F-0042', claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:00:00.000Z', title: 'Ragas', pages: [5]}]));
    window.__wake = {requests: 0, releases: 0};
    Object.defineProperty(navigator, 'wakeLock', {configurable: true, value: {request() {
      window.__wake.requests += 1;
      const listeners = [];
      return Promise.resolve({release() { window.__wake.releases += 1; listeners.forEach(fn => fn()); return Promise.resolve(); },
        addEventListener(type, fn) { if (type === 'release') listeners.push(fn); }});
    }}});
  });
  await page.goto(base + 'event.html');
  await stepIs(page, 'ticket');
  assert.equal(await until(async () => state.claims === 1), true, 'the reload picked the ticket up');
  assert.deepEqual(state.claimMethods, ['GET'], 'the claim is read with a GET');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.kiosk), undefined, 'normal mode is not a kiosk');
  assert.equal(await page.locator('.booth-handoff').count(), 0);
  assert.equal(await until(() => page.evaluate(() => window.__wake.requests === 1)), true, 'the screen stays on while waiting');

  await visibility(page, 'hidden');
  assert.equal(await page.evaluate(() => window.__wake.releases), 1, 'released when hidden');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(state.claims, 1, 'nothing is polled while hidden');
  await visibility(page, 'visible');
  assert.equal(await until(async () => state.claims === 2, 3000), true, 'back on the tab polls at once, without waiting 15 s');
  assert.equal(await page.evaluate(() => window.__wake.requests), 2, 'the wake lock is asked for again');

  // 15 minutes later polling has stopped; returning starts it again.
  for (let i = 0; i < 40 && await page.locator('#booth-live-recheck').isHidden(); i += 1) {
    await page.clock.fastForward(30000);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(await page.locator('#booth-live-recheck').isVisible(), true, 'polling stopped after 15 min');
  const stoppedAt = state.claims;
  await visibility(page, 'hidden');
  await visibility(page, 'visible');
  assert.equal(await until(async () => state.claims === stoppedAt + 1, 3000), true);
  assert.equal(await page.locator('#booth-live-recheck').isHidden(), true, 'polling runs again');
  await page.clock.fastForward(15000);
  assert.equal(await until(async () => state.claims === stoppedAt + 2), true, 'the restarted polling keeps its 15 s rhythm');

  // Offline while polling: the offline line and 다시 시도; 'online' polls at once.
  await setOffline(context, state, true);
  await page.clock.fastForward(15000);
  await page.waitForFunction(text => document.querySelector('#booth-live-error')?.textContent === text, OFFLINE);
  assert.equal(await page.locator('#booth-live-error-retry').isVisible(), true);
  await shot(page, 'ticket-offline-390');
  const offlineAt = state.claims;
  await setOffline(context, state, false);
  assert.equal(await until(async () => state.claims === offlineAt + 1, 5000), true, 'online retries the claim at once');
  await page.waitForFunction(() => document.querySelector('#booth-live-error')?.hidden === true);
  assert.equal(await page.locator('#booth-live-error-retry').isHidden(), true);
  await context.close();
}

/* Offline config and paper load, then saved progress across a reload. */
async function offlineAndProgressPass(browser, pageErrors) {
  const state = newState();
  const {context, page} = await openContext(browser, PHONE, state, pageErrors);
  state.hooks.config = async route => {
    state.hooks.config = null;
    await setOffline(context, state, true);
    return route.abort('internetdisconnected');
  };
  await page.goto(base + 'event.html');
  await page.waitForFunction(text => document.querySelector('#booth-status')?.textContent === text, OFFLINE);
  assert.equal(await page.locator('#booth-status-retry').isVisible(), true);
  assert.equal(await page.locator('#booth-status-retry').textContent(), '다시 시도');
  await shot(page, 'config-offline-390');
  await setOffline(context, state, false);
  const mission = page.locator('#booth-missions .booth-mission').first();
  await mission.waitFor();
  assert.equal(await page.locator('#booth-status').textContent(), '');
  assert.equal(await page.locator('#booth-status-retry').isHidden(), true);

  await setOffline(context, state, true);
  await mission.click();
  await page.waitForFunction(text => document.querySelector('#booth-mission-status')?.textContent === text, OFFLINE);
  assert.equal(await page.locator('#booth-mission-status-retry').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'pick');
  await shot(page, 'paper-offline-390');
  await setOffline(context, state, false);
  await stepIs(page, 'edit');
  assert.equal(state.guests, 1);

  await editParagraph(page);
  await visibility(page, 'hidden');
  const saved = JSON.parse(await page.evaluate(() => sessionStorage.getItem('falsify.booth.progress.v1')));
  assert.equal(saved.step, 'edit');
  assert.equal(saved.paperId, '2309.15217');
  assert.deepEqual(saved.edits.map(edit => [edit.page, edit.find, edit.replace]), [[saved.edits[0].page, '0.95', '0.50']]);

  await page.reload();
  const panel = page.locator('#booth-resume');
  await panel.waitFor();
  assert.equal(await page.locator('#booth-resume-text').textContent(), '고친 곳 1개를 이어서 할까요?');
  assert.equal(await page.locator('#booth-resume-go').textContent(), '이어서');
  assert.equal(await page.locator('#booth-resume-fresh').textContent(), '처음부터');
  await shot(page, 'resume-390');
  await page.locator('#booth-resume-go').click();
  await stepIs(page, 'edit');
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개', null, {timeout: 60000});
  assert.equal(await page.locator('#booth-resume').count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('falsify.booth.progress.v1')), null);
  const edits = await page.evaluate(() => window.FalsifyPaperWorkspace.getEditSnapshot().edits.filter(edit => edit.enabled !== false)
    .map(edit => [edit.before.includes('0.95'), edit.after.includes('0.50')]));
  assert.deepEqual(edits, [[true, true]]);

  // 처음부터 drops the saved progress and keeps pick.
  await visibility(page, 'hidden');
  await page.reload();
  await page.locator('#booth-resume').waitFor();
  await page.locator('#booth-resume-fresh').click();
  assert.equal(await page.locator('#booth-resume').count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('falsify.booth.progress.v1')), null);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'pick');
  await context.close();
}

async function declareAndSubmit(page, context, state) {
  await page.locator('#booth-next').click();
  await stepIs(page, 'send');
  const card = page.locator('#booth-rows .booth-card').first();
  await card.getByRole('button', {name: '수치·통계'}).click();
  await card.locator('textarea').fill('표의 점수를 0.95에서 0.50으로 바꿨어요');
  await page.locator('#booth-consent').check();
  await setOffline(context, state, true);
  await page.locator('#booth-submit-button').click();
  await page.waitForFunction(text => document.querySelector('#booth-submit-status')?.textContent === text, OFFLINE);
  assert.equal(await page.locator('#booth-submit-status-retry').isVisible(), true);
  await setOffline(context, state, false);
  await stepIs(page, 'ticket');
}

async function touchSize(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box && box.width >= 48 && box.height >= 48, selector + ' is a 48px touch target: ' + JSON.stringify(box));
}

/* Kiosk on the booth tablet: two visitors on one browser context, then the idle warning. */
async function kioskPass(browser, pageErrors) {
  const state = newState();
  const {context, page} = await openContext(browser, TABLET, state, pageErrors);
  await page.clock.install({time: new Date('2026-11-22T01:00:00.000Z')});
  await page.goto(base + 'event.html?kiosk=1');
  const mission = page.locator('#booth-missions .booth-mission').first();
  await mission.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.kiosk), '1');
  assert.equal(await page.locator('#booth-handoff-desk').isVisible(), true, 'the hand-off button shows on pick');
  await touchSize(page, '#booth-handoff-desk');

  // Visitor 1 submits once; the receipt lives in sessionStorage only.
  await mission.click();
  await stepIs(page, 'edit');
  assert.equal(await page.locator('#booth-handoff-desk').isHidden(), true, 'not while editing');
  await editParagraph(page);
  await declareAndSubmit(page, context, state);
  const first = await page.evaluate(() => ({
    session: JSON.parse(sessionStorage.getItem('falsify.booth.receipts.v1') || '[]').map(item => item.receipt),
    local: localStorage.getItem('falsify.booth.receipts.v1'),
  }));
  assert.deepEqual(first, {session: ['F-0041'], local: null});
  assert.equal(state.guests, 1, JSON.stringify(state.auth));
  assert.equal(state.auth.every(line => line.endsWith(tokenFor(1))), true);
  assert.equal(await page.locator('#booth-handoff-desk').isVisible(), true, 'the hand-off button shows on the ticket');
  await page.locator('#booth-handoff-desk').click();
  const confirm = page.locator('#booth-handoff-dialog');
  await confirm.waitFor();
  assert.equal(await page.locator('#booth-handoff-dialog-title').textContent(), '다음 분께 넘길까요?');
  await touchSize(page, '#booth-handoff-dialog-go');
  await touchSize(page, '#booth-handoff-dialog-stay');
  await shot(page, 'kiosk-handoff-1280');
  await Promise.all([page.waitForURL(base + 'event.html?kiosk=1'), page.locator('#booth-handoff-dialog-go').click()]);

  // Visitor 2: no receipts, a fresh guest token, 5 chances.
  await mission.waitFor();
  const second = await page.evaluate(() => ({
    receipts: sessionStorage.getItem('falsify.booth.receipts.v1'),
    kiosk: sessionStorage.getItem('falsify.booth.kiosk.v1'),
    guestKeys: Object.keys(sessionStorage).filter(key => key.startsWith('falsify.open-access.guest')).length,
    step: document.documentElement.dataset.boothStep,
  }));
  assert.deepEqual(second, {receipts: null, kiosk: '1', guestKeys: 0, step: 'pick'});
  await page.locator('#booth-desk-records').click();
  assert.equal(await page.locator('#booth-receipts').isHidden(), true, 'no earlier receipt is listed');
  await page.locator('#booth-records-back').click();
  const before = state.auth.length;
  await mission.click();
  await stepIs(page, 'edit');
  assert.equal(state.guests, 2, 'the next visitor gets a new guest');
  assert.equal(state.auth.slice(before).every(line => line.endsWith(tokenFor(2))), true, 'and every call uses it');

  // Idle: a touch arms the timer; 2:40 later the warning; 계속 extends; letting it run out resets.
  await page.locator('#booth-dock-back').click();
  await stepIs(page, 'pick');
  const search = page.locator('#booth-search-q');
  await search.tap();
  await search.fill('rag');
  await page.clock.fastForward(160000);
  const warning = page.locator('#booth-idle-dialog');
  await warning.waitFor();
  assert.equal(await page.locator('#booth-idle-dialog-title').textContent(), '계속하시겠어요?');
  assert.equal(await page.locator('#booth-idle-dialog').getAttribute('role'), 'alertdialog');
  assert.equal(await page.evaluate(() => document.activeElement?.id || ''), 'booth-idle-dialog-stay', 'the input lost focus, so the keyboard closes');
  const title = await page.locator('#booth-idle-dialog-title').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  assert.ok(title >= 28, 'readable from a step away: ' + title);
  await touchSize(page, '#booth-idle-dialog-stay');
  await touchSize(page, '#booth-idle-dialog-reset');
  await shot(page, 'kiosk-idle-1280');
  await page.locator('#booth-idle-dialog-stay').tap();
  assert.equal(await warning.isVisible(), false);
  await page.clock.fastForward(150000);
  assert.equal(await warning.isVisible(), false, 'the 계속 tap restarted the 3 minutes');
  await page.mouse.wheel(0, 200);
  await page.clock.fastForward(160000);
  await warning.waitFor();
  await Promise.all([page.waitForURL(base + 'event.html?kiosk=1'), page.clock.fastForward(20000)]);
  await mission.waitFor();
  assert.equal(await page.locator('#booth-search-q').inputValue(), '');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('falsify.booth.kiosk.v1')), '1');
  await context.close();
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  const pageErrors = [];
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    const only = process.env.BOOTH_RUNTIME_ONLY || '';
    if (!only || only === 'return') await returnPass(browser, pageErrors);
    if (!only || only === 'progress') await offlineAndProgressPass(browser, pageErrors);
    if (!only || only === 'kiosk') await kioskPass(browser, pageErrors);
    assert.equal(pageErrors.join('\n'), '');
  } catch (error) {
    const open = browser && browser.contexts().flatMap(context => context.pages()).at(-1);
    if (open) await shot(open, 'failure').catch(() => {});
    error.message += '\nerrors=' + pageErrors.join(' | ');
    throw error;
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth runtime browser passed'); }, error => {
  console.error(error && error.message);
  console.error(error);
  process.exit(1);
});
