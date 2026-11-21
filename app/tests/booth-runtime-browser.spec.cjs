'use strict';
// Real Chromium checks of booth-runtime.js with booth.js on event.html (BoothEdit model):
// - return to the tab: immediate claim poll on visibilitychange, polling restarts after 15 min, wake lock
// - offline: config, paper load, polling and submit show offline line with 다시 시도 and retry on 'online'
// - saved progress: hidden saves FalsifyBoothEdits.serialize(); reload offers 「고친 곳 1개를 이어서 할까요?」 and restores via FalsifyBoothEdits.restore()
// - kiosk (?kiosk=1): sessionStorage receipts, 「다음 분께 넘기기」 resets guest & BoothEdits, idle warning
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
const port = Number(process.env.BOOTH_RUNTIME_PORT || 19922);
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
const FINAL_MISSED = {
  receipt: 'F-0042', status: 'judged', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00.000Z',
  published: true, outcome: 'missed', publicNote: 'AI는 다른 곳을 짚었어요. 심어 둔 결함은 AI 눈을 피했어요.',
  prizeMessage: '부스에서 스티커를 받아 가세요', publishedAt: '2026-11-22T01:02:00.000Z',
};
const CONFIG = {
  enabled: true, submissionsOpen: true, announcement: '', consentVersion: '2026-11-22.v3',
  limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216, perOwner: 3},
  missions: [{
    paperId: '2309.15217', title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
    license: 'cc-by-4.0', course: 'quick', hint: 'Table 1의 점수 하나를 바꿔 보세요', pageHint: 5,
  }],
};
const tokenFor = n => 'fsg_' + String.fromCharCode(96 + n).repeat(43);

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
  if ((request.method() === 'GET' || request.method() === 'POST') && url.pathname === '/v1/booth/claim') {
    state.claims += 1;
    state.claimMethods.push(request.method());
    if (state.hooks.claim) return state.hooks.claim(route);
    return json(route, 200, PENDING);
  }
  return json(route, 404, {error: {code: 'not_found'}});
}

function newState() { return {guests: 0, auth: [], claims: 0, claimMethods: [], submissions: 0, hooks: {}, offline: false}; }
async function setOffline(context, state, value) {
  state.offline = value;
  await context.setOffline(value);
}

async function openContext(browser, device, state, pageErrors) {
  const context = await browser.newContext({...device, locale: 'ko-KR'});
  await context.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const api = window.FalsifyBrowserPdf || (window.FalsifyBrowserPdf = {});
      if (typeof api.rewrite !== 'function') {
        api.rewrite = async (sourceBytes, edits) => {
          const marker = new TextEncoder().encode('\n% falsify-stub-rewrite ' + (edits ? edits.length : 0) + '\n');
          const out = new Uint8Array(sourceBytes.length + marker.length);
          out.set(sourceBytes, 0);
          out.set(marker, sourceBytes.length);
          return out;
        };
      }
    });
  });
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

/* One edit via find-and-replace: 0.95 -> 0.50 on page 5. */
async function addOneEdit(page, wide) {
  await page.waitForFunction(() => !!globalThis.FalsifyPaperWorkspace?.getPdfDoc?.() && !!document.querySelector('#paper-before-stage canvas'));
  if (!wide) {
    const fold = page.locator('#booth-find-fold');
    if (!(await fold.evaluate(n => n.open))) await fold.locator('summary').click();
  }
  const pane = page.locator(wide ? '#booth-pane-find' : '#booth-find-fold');
  await pane.getByLabel('바꿀 글자').first().fill('0.95');
  await pane.getByLabel('새 글자').first().fill('0.50');
  await pane.getByRole('button', {name: '바꾸기'}).first().click();
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
}

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
  assert.equal(await until(async () => state.claims === 2, 3000), true, 'back on the tab polls at once');
  assert.equal(await page.evaluate(() => window.__wake.requests), 2, 'the wake lock is asked for again');

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

  await setOffline(context, state, true);
  await page.clock.fastForward(15000);
  await page.waitForFunction(text => document.querySelector('#booth-live-error')?.textContent === text, OFFLINE);
  assert.equal(await page.locator('#booth-live-error-retry').isVisible(), true);
  const offlineAt = state.claims;
  await setOffline(context, state, false);
  assert.equal(await until(async () => state.claims === offlineAt + 1, 5000), true, 'online retries the claim at once');
  await page.waitForFunction(() => document.querySelector('#booth-live-error')?.hidden === true);
  assert.equal(await page.locator('#booth-live-error-retry').isHidden(), true);
  // Coming back from another tab (e.g. after tapping the GitHub link) still lands the final result and hides the star row.
  assert.equal(await page.locator('#booth-project-wait').isVisible(), true, 'star row visible while still pending');
  state.hooks.claim = route => json(route, 200, FINAL_MISSED);
  await visibility(page, 'hidden');
  await visibility(page, 'visible');
  await page.waitForFunction(() => document.querySelector('#booth-live-title')?.textContent === 'AI가 못 찾았어요');
  assert.equal(await page.locator('#booth-project-wait').isHidden(), true, 'star row hides once final arrives after tab return');
  await context.close();
}

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
  await setOffline(context, state, false);
  const mission = page.locator('#booth-missions .booth-mission').first();
  await mission.waitFor();
  assert.equal(await page.locator('#booth-status').textContent(), '');

  await setOffline(context, state, true);
  await mission.click();
  await page.waitForFunction(text => document.querySelector('#booth-mission-status')?.textContent === text, OFFLINE);
  assert.equal(await page.locator('#booth-mission-status-retry').isVisible(), true);
  await setOffline(context, state, false);
  await stepIs(page, 'edit');
  assert.equal(state.guests, 1);

  await addOneEdit(page, false);
  await page.locator('#booth-tab-myai').click();
  await visibility(page, 'hidden');
  const saved = JSON.parse(await page.evaluate(() => sessionStorage.getItem('falsify.booth.progress.v1')));
  assert.equal(saved.v, 2);
  assert.equal(saved.step, 'edit');
  assert.equal(saved.paperId, '2309.15217');
  assert.equal(saved.tab, 'myai');
  const savedEdits = JSON.parse(saved.edits);
  assert.equal(savedEdits.length, 1);
  assert.equal(savedEdits[0].originalText, '0.95');
  assert.equal(savedEdits[0].newText, '0.50');
  assert.ok(savedEdits[0].rects.length >= 1);

  await page.reload();
  const panel = page.locator('#booth-resume');
  await panel.waitFor();
  assert.equal(await page.locator('#booth-resume-text').textContent(), '고친 곳 1개를 이어서 할까요?');
  await page.locator('#booth-resume-go').click();
  await stepIs(page, 'edit');
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개', null, {timeout: 30000});
  assert.equal(await page.locator('#booth-tab-myai').getAttribute('aria-selected'), 'true', 'resume restores 내 AI에게 tab');
  assert.equal(await page.locator('#booth-resume').count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('falsify.booth.progress.v1')), null);
  const restored = await page.evaluate(() => window.FalsifyBoothEdits.list());
  assert.equal(restored.length, 1);
  assert.equal(restored[0].originalText, '0.95');
  assert.equal(restored[0].newText, '0.50');
  assert.deepEqual(restored[0].rects, savedEdits[0].rects);

  // Saved legacy tab 'agent' restores to 'find'.
  await page.addInitScript(rec => {
    if (sessionStorage.getItem('__seed_legacy_agent')) return;
    sessionStorage.setItem('__seed_legacy_agent', '1');
    sessionStorage.setItem('falsify.booth.progress.v1', JSON.stringify(rec));
  }, {...saved, at: Date.now(), tab: 'agent', assist: 'agent'});
  await page.reload();
  await page.locator('#booth-resume').waitFor();
  await page.locator('#booth-resume-go').click();
  await stepIs(page, 'edit');
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개', null, {timeout: 30000});
  assert.equal(await page.locator('#booth-tab-find').getAttribute('aria-selected'), 'true', 'legacy agent tab restores to find');

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

  await mission.click();
  await stepIs(page, 'edit');
  assert.equal(await page.locator('#booth-handoff-desk').isHidden(), true, 'not while editing');
  await addOneEdit(page, true);
  await declareAndSubmit(page, context, state);
  // Kiosk waiting state: shows QR code (~120px) + caption, never the outbound GitHub link.
  assert.equal(await page.locator('#booth-project-wait').isVisible(), true, 'kiosk shows waiting project row');
  assert.equal(await page.locator('#booth-project-wait a').count(), 0, 'kiosk shows QR, never the link');
  assert.equal(await page.locator('#booth-project-qr-caption').textContent(), '휴대폰 카메라로 찍으면 Falsify 프로젝트가 열려요.');
  const qrImg = page.locator('#booth-project-qr');
  await qrImg.waitFor({state: 'visible'});
  const qrInfo = await qrImg.evaluate(img => ({
    src: img.getAttribute('src'),
    alt: img.getAttribute('alt'),
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    rect: img.getBoundingClientRect().toJSON(),
  }));
  assert.equal(qrInfo.src, 'falsify-project-qr.svg');
  assert.ok(qrInfo.alt && qrInfo.alt.length > 0, 'QR image has alt text');
  assert.equal(qrInfo.complete && qrInfo.naturalWidth > 0, true, 'QR SVG loaded');
  assert.ok(qrInfo.rect.width >= 115 && qrInfo.rect.width <= 125 && qrInfo.rect.height >= 115 && qrInfo.rect.height <= 125, 'QR is ~120px: ' + JSON.stringify(qrInfo.rect));
  await shot(page, 'kiosk-waiting');
  const first = await page.evaluate(() => ({
    session: JSON.parse(sessionStorage.getItem('falsify.booth.receipts.v1') || '[]').map(item => item.receipt),
    local: localStorage.getItem('falsify.booth.receipts.v1'),
  }));
  assert.deepEqual(first, {session: ['F-0041'], local: null});
  assert.equal(state.guests, 1, JSON.stringify(state.auth));
  assert.equal(state.auth.every(line => line.endsWith(tokenFor(1))), true);
  await page.locator('#booth-handoff-desk').click();
  await page.locator('#booth-handoff-dialog').waitFor();
  assert.equal(await page.locator('#booth-handoff-dialog-title').textContent(), '다음 분께 넘길까요?');
  await touchSize(page, '#booth-handoff-dialog-go');
  await touchSize(page, '#booth-handoff-dialog-stay');
  await Promise.all([page.waitForURL(base + 'event.html?kiosk=1'), page.locator('#booth-handoff-dialog-go').click()]);

  await mission.waitFor();
  const second = await page.evaluate(() => ({
    receipts: sessionStorage.getItem('falsify.booth.receipts.v1'),
    kiosk: sessionStorage.getItem('falsify.booth.kiosk.v1'),
    guestKeys: Object.keys(sessionStorage).filter(key => key.startsWith('falsify.open-access.guest')).length,
    step: document.documentElement.dataset.boothStep,
    edits: window.FalsifyBoothEdits.list().length,
  }));
  assert.deepEqual(second, {receipts: null, kiosk: '1', guestKeys: 0, step: 'pick', edits: 0});
  const before = state.auth.length;
  await mission.click();
  await stepIs(page, 'edit');
  assert.equal(state.guests, 2, 'the next visitor gets a new guest');
  assert.equal(state.auth.slice(before).every(line => line.endsWith(tokenFor(2))), true, 'and every call uses it');

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
  await touchSize(page, '#booth-idle-dialog-stay');
  await touchSize(page, '#booth-idle-dialog-reset');
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

/* plan97s-3 */
async function finishedDraftPass(browser, pageErrors) {
  const state = newState();
  const {context, page} = await openContext(browser, PHONE, state, pageErrors);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    const createdAt = new Date(Date.now() - 5 * 60000).toISOString();
    localStorage.setItem('falsify.booth.receipts.v1', JSON.stringify([{
      receipt: 'F-0041', claimKey: '7Q3K-M9XD', createdAt, title: 'Ragas', pages: [5], outcome: 'caught',
    }]));
    sessionStorage.setItem('falsify.booth.progress.v1', JSON.stringify({
      v: 2, at: Date.now(), step: 'edit', paperId: '2309.15217', title: 'Ragas', license: 'cc-by-4.0',
      tab: 'myai', assist: 'manual',
      edits: JSON.stringify([{pageIndex: 4, rects: [{x: 0.2, y: 0.3, w: 0.05, h: 0.01}], originalText: '0.95', newText: '0.50'}]),
    }));
  });
  await page.goto(base + 'event.html');
  const panel = page.locator('#booth-resume');
  await panel.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'pick');
  assert.equal(state.claims, 0, 'a finished receipt does not open over a saved draft');
  assert.equal(await page.locator('#booth-resume-text').textContent(), '고친 곳 1개를 이어서 할까요?');
  await page.locator('#booth-resume-go').click();
  await stepIs(page, 'edit');
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개', null, {timeout: 30000});
  assert.equal(await page.locator('#booth-tab-myai').getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('falsify.booth.progress.v1')), null);

  // Same context, pending receipt + draft while on edit: pending ticket still auto-resumes.
  await page.evaluate(() => {
    const createdAt = new Date(Date.now() - 5 * 60000).toISOString();
    localStorage.setItem('falsify.booth.receipts.v1', JSON.stringify([{
      receipt: 'F-0042', claimKey: '7Q3K-M9XD', createdAt, title: 'Ragas', pages: [5],
    }]));
    sessionStorage.setItem('falsify.booth.progress.v1', JSON.stringify({
      v: 2, at: Date.now(), step: 'edit', paperId: '2309.15217', title: 'Ragas', license: 'cc-by-4.0',
      tab: 'myai', assist: 'manual',
      edits: JSON.stringify([{pageIndex: 4, rects: [{x: 0.2, y: 0.3, w: 0.05, h: 0.01}], originalText: '0.95', newText: '0.50'}]),
    }));
  });
  await page.reload();
  await stepIs(page, 'ticket');
  assert.equal(await until(async () => state.claims === 1), true, 'a pending receipt still opens over a draft');
  assert.equal(await page.locator('#booth-resume').isVisible(), false);

  // Same context, reload made from a finished ticket screen itself: still reopens the finished ticket.
  state.hooks.claim = route => json(route, 200, {...FINAL_MISSED, receipt: 'F-0041'});
  await page.evaluate(() => {
    const createdAt = new Date(Date.now() - 5 * 60000).toISOString();
    localStorage.setItem('falsify.booth.receipts.v1', JSON.stringify([{
      receipt: 'F-0041', claimKey: '7Q3K-M9XD', createdAt, title: 'Ragas', pages: [5], outcome: 'missed',
    }]));
  });
  await page.goto(base + 'event.html?r=1#booth-result');
  await stepIs(page, 'ticket');
  await page.waitForFunction(() => !document.querySelector('#booth-live-again')?.hidden);
  assert.equal(await until(async () => state.claims === 2), true, '#booth-result opens the finished ticket');
  await page.evaluate(() => {
    history.replaceState(null, '', 'event.html');
    sessionStorage.setItem('falsify.booth.progress.v1', JSON.stringify({
      v: 2, at: Date.now(), step: 'edit', paperId: '2309.15217', title: 'Ragas', license: 'cc-by-4.0',
      tab: 'find', assist: 'manual',
      edits: JSON.stringify([{pageIndex: 4, rects: [{x: 0.2, y: 0.3, w: 0.05, h: 0.01}], originalText: '0.95', newText: '0.50'}]),
    }));
  });
  await page.reload();
  await stepIs(page, 'ticket');
  assert.equal(await until(async () => state.claims === 3), true, 'reloading from the ticket screen reopens the finished ticket');
  assert.equal(await page.locator('#booth-resume').count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('falsify.booth.progress.v1')), null);
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
    if (!only || only === 'finished-draft') await finishedDraftPass(browser, pageErrors);
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
