'use strict';
// Real Chromium check of app/dist/event-theme.css on event.html. The API is stubbed.
// FALSIFY_BOOTH_MISSION_PDF names a local copy of arXiv 2309.15217 (CC BY 4.0).
// The booth step is set by hand on <html data-booth-step>, so this runs without booth.js changes.
// A phone pass (360x780) and a desktop pass (1280x800: two panes in the edit step).
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217 (the Ragas paper)');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.EVENT_THEME_PORT || 8878);
const token = 'fsg_' + 'b'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

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

function stubApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (!url.href.startsWith(api)) return route.abort();
  if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
  if (request.method() === 'POST' && url.pathname === '/v1/ai/guest') {
    return json(route, 200, {guest: {token, expiresAt: new Date(Date.now() + 864e5).toISOString()}});
  }
  if (url.pathname === '/v1/ai/capabilities') {
    return json(route, 200, {
      enabled: true, provider: 'anthropic', execution: 'server', models: ['claude-opus-5-5'], efforts: ['high'],
      limits: {maxUploadBytes: 33554432, maxPromptChars: 8000}, modelJobs: false, blueJobs: false,
    });
  }
  if (url.pathname === '/v1/booth/config') {
    return json(route, 200, {
      enabled: true, submissionsOpen: true, announcement: '', consentVersion: '2026-11-22.v2',
      limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216},
      missions: [{
        paperId: '2309.15217', title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
        license: 'cc-by-4.0', course: 'quick', hint: 'Table 1의 점수 하나를 바꿔 보세요', pageHint: 5,
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
  return json(route, 404, {error: {code: 'not_found'}});
}

async function setStep(page, step) {
  await page.evaluate(value => { document.documentElement.dataset.boothStep = value; }, step);
  await page.waitForTimeout(100);
}

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/* Workbench regions a booth visitor must never see. */
const CHROME = {
  'RED header': '.topbar',
  rail: '.rail',
  'R1 banner': '.wayfinding',
  'drop zone': '.paper-intake .document-upload',
  'web-run panel': '#hosted-ai',
  'AMAS help': '.paper-intake > details.red-help',
  'local bridge': '#local-bridge',
};

async function assertChromeHidden(page, step) {
  for (const [name, selector] of Object.entries(CHROME)) {
    const node = page.locator(selector).first();
    if (await node.count() === 0) continue;
    assert.equal(await node.isVisible(), false, step + ': ' + name + ' is visible');
  }
  assert.equal(await page.locator('#booth').isVisible(), true, step + ': #booth is hidden');
  assert.equal(await page.locator('#source-link').isVisible(), true, step + ': license link is hidden');
}

async function waitPageText(page, needle) {
  await page.waitForFunction(
    text => /^5 \//.test(document.querySelector('#paper-page-label')?.textContent || '')
      && [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(node => node.textContent.includes(text)),
    needle,
  );
}

function tokenPoint(page, needle) {
  return page.evaluate(value => {
    const spans = [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')]
      .sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i));
    for (const span of spans) {
      const text = span.textContent || '';
      const at = text.indexOf(value);
      if (at < 0) continue;
      span.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let startNode = null, startOff = 0, endNode = null, endOff = 0;
      const endAt = at + value.length;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const len = node.nodeValue.length;
        if (!startNode && at <= offset + len) { startNode = node; startOff = at - offset; }
        if (startNode && endAt <= offset + len) { endNode = node; endOff = endAt - offset; break; }
        offset += len;
      }
      if (!startNode || !endNode) continue;
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
      if (r.width > 0 && r.height > 0) return {x: r.left + r.width / 2, y: r.top + r.height / 2};
    }
    return null;
  }, needle);
}

async function openWordBar(page, wide, needle) {
  const tap = (x, y) => (wide ? page.mouse.click(x, y) : page.touchscreen.tap(x, y));
  if (!wide && await page.evaluate(() => (globalThis.FalsifyPaperWorkspace?.getZoom?.() || 1) === 1)) {
    const first = await tokenPoint(page, needle);
    assert.ok(first, 'could not locate ' + needle + ' at zoom 1');
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
      pt = await tokenPoint(page, needle);
      assert.ok(pt, 'could not locate ' + needle + ' on page');
      if (prev && Math.abs(prev.x - pt.x) < 0.5 && Math.abs(prev.y - pt.y) < 0.5) break;
      prev = pt;
      await page.waitForTimeout(100);
    }
    await tap(pt.x, pt.y);
    if (await page.locator('#booth-pe-pop').waitFor({state: 'visible', timeout: 2000}).then(() => true, () => false)) {
      return;
    }
  }
  throw new Error('word bar did not open for ' + needle);
}

async function checkWordAndSheetEdit(page, wide, tag) {
  await openWordBar(page, wide, '0.95');
  const pop = page.locator('#booth-pe-pop');
  assert.equal(await pop.isVisible(), true, tag + ': #booth-pe-pop is hidden');
  const smallPopButtons = await page.evaluate(() => [...document.querySelectorAll('#booth-pe-pop button')]
    .filter(node => node.offsetParent !== null)
    .map(node => ({text: node.textContent.trim(), className: node.className, rect: node.getBoundingClientRect().toJSON()}))
    .filter(item => item.rect.width < 44 || item.rect.height < 44));
  assert.deepEqual(smallPopButtons, [], tag + ': #booth-pe-pop button(s) under 44px: ' + JSON.stringify(smallPopButtons));
  assert.ok(await overflow(page) <= 0, tag + ' word bar: horizontal overflow');

  const whole = pop.getByRole('button', {name: '문단 전체 고치기'});
  if (wide) await whole.click();
  else await whole.tap();
  const sheet = page.locator('#booth-pe-sheet');
  const area = page.locator('#booth-pe-sheet-text');
  await area.waitFor({state: 'visible'});
  const apply = sheet.getByRole('button', {name: '바꾸기', exact: true});
  const cancel = sheet.getByRole('button', {name: '취소', exact: true});
  assert.equal(await apply.isVisible(), true, tag + ': 바꾸기 is not visible');
  assert.equal(await cancel.isVisible(), true, tag + ': 취소 is not visible');
  for (const [name, button] of [['바꾸기', apply], ['취소', cancel]]) {
    const box = await button.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44, tag + ' ' + name + ' tap target ' + JSON.stringify(box));
  }
  const layout = await page.evaluate(() => {
    const card = document.querySelector('#booth-pe-sheet .booth-pe-sheet-card').getBoundingClientRect();
    const textarea = document.querySelector('#booth-pe-sheet-text');
    const ta = textarea.getBoundingClientRect();
    const actions = document.querySelector('#booth-pe-sheet .booth-pe-sheet-actions').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('#booth-pe-sheet .booth-pe-sheet-actions button')]
      .filter(node => node.offsetParent !== null)
      .map(node => node.getBoundingClientRect());
    const buttonOverlap = buttons.length >= 2
      && !(buttons[0].right <= buttons[1].left + 0.5 || buttons[1].right <= buttons[0].left + 0.5
        || buttons[0].bottom <= buttons[1].top + 0.5 || buttons[1].bottom <= buttons[0].top + 0.5);
    return {
      cardLeft: card.left, cardRight: card.right, viewportWidth: window.innerWidth,
      areaBottom: ta.bottom, actionsTop: actions.top,
      buttonOverlap,
      font: parseFloat(getComputedStyle(textarea).fontSize),
    };
  });
  assert.ok(layout.font >= 16, tag + ': sheet textarea font under 16px zooms iOS ' + JSON.stringify(layout));
  assert.ok(layout.actionsTop >= layout.areaBottom - 0.5, tag + ': sheet actions overlap textarea ' + JSON.stringify(layout));
  assert.equal(layout.buttonOverlap, false, tag + ': sheet buttons overlap each other ' + JSON.stringify(layout));
  assert.ok(layout.cardLeft >= -0.5 && layout.cardRight <= layout.viewportWidth + 0.5, tag + ': sheet card overflows horizontally ' + JSON.stringify(layout));
  assert.ok(await overflow(page) <= 0, tag + ' sheet: horizontal overflow');

  const original = await area.inputValue();
  assert.equal(original.includes('0.95'), true, tag + ': sheet text missing 0.95: ' + JSON.stringify(original));
  await area.fill(original.replace('0.95', '0.50'));
  if (wide) await apply.click();
  else await apply.tap();
  await area.waitFor({state: 'hidden'});
  const edits = await page.evaluate(() => globalThis.FalsifyBoothEdits.list());
  assert.equal(edits.length, 1, tag + ': expected 1 edit in FalsifyBoothEdits');
  assert.equal(edits[0].originalText.includes('0.95'), true, tag + ': originalText missing 0.95: ' + JSON.stringify(edits[0]));
  assert.equal(edits[0].newText.includes('0.50'), true, tag + ': newText missing 0.50: ' + JSON.stringify(edits[0]));
  assert.ok(await overflow(page) <= 0, tag + ' applied: horizontal overflow');
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  const pageErrors = [];
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    const base = 'http://127.0.0.1:' + port + '/';

    const index = await browser.newPage({viewport: {width: 390, height: 844}});
    await index.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await index.goto(base + 'index.html');
    assert.equal(await index.locator('link[href^="event-theme.css"]').count(), 0, 'index.html must not load the event theme');
    assert.equal(await index.locator('.topbar').isVisible(), true, 'index.html keeps its header');
    await index.close();

    const page = await browser.newPage({viewport: {width: 360, height: 780}, deviceScaleFactor: 1, hasTouch: true, locale: 'ko-KR'});
    page.setDefaultTimeout(90000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => { void dialog.accept(); });
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : stubApi(route));
    await page.goto(base + 'event.html');
    const links = await page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map(node => node.getAttribute('href')));
    const theme = links.findIndex(href => href.startsWith('event-theme.css?v='));
    const booth = links.findIndex(href => href.startsWith('booth.css?v='));
    assert.ok(theme >= 0 && booth > theme, 'event-theme.css loads before booth.css');

    await page.locator('#paper-workspace').waitFor({state: 'attached'});
    await setStep(page, 'pick');
    const mission = page.locator('#booth-missions .booth-mission').first();
    await mission.waitFor();
    await assertChromeHidden(page, 'pick');
    assert.equal(await page.locator('#paper-workspace').isVisible(), false, 'pick: workspace is visible');
    assert.ok(await overflow(page) <= 0, 'pick: horizontal overflow');

    await mission.click();
    await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'edit');
    await waitPageText(page, '0.95');
    await setStep(page, 'edit');
    await assertChromeHidden(page, 'edit');
    assert.equal(await page.locator('#paper-page-label').isVisible(), true);
    assert.match(await page.locator('#paper-page-label').textContent(), /^\d+ \/ \d+쪽$/);
    for (const hidden of ['#paper-zoom-in', '#paper-zoom-out', '#paper-mode-table', '#paper-undo', '#paper-redo',
      '#paper-current-download', '#paper-generate', '#paper-after-stage', '#paper-file']) {
      assert.equal(await page.locator(hidden).count(), 1, hidden + ' must stay in the DOM');
      assert.equal(await page.locator(hidden).isVisible(), false, 'edit: ' + hidden + ' is visible');
    }
    assert.equal(await page.locator('.paper-canvas').first().isVisible(), true, 'edit: page image is hidden');
    assert.ok(await overflow(page) <= 0, 'edit: horizontal overflow');

    await checkWordAndSheetEdit(page, false, 'phone');

    for (const step of ['send', 'ticket']) {
      await setStep(page, step);
      await assertChromeHidden(page, step);
      assert.equal(await page.locator('#paper-workspace').isVisible(), false, step + ': workspace is visible');
      assert.ok(await overflow(page) <= 0, step + ': horizontal overflow');
    }
    // Desktop (>= 1024px): two panes in edit. The page column sits left of the work column.
    const desk = await browser.newPage({viewport: {width: 1280, height: 800}, deviceScaleFactor: 1, locale: 'ko-KR'});
    desk.setDefaultTimeout(90000);
    desk.on('pageerror', error => pageErrors.push(error.message));
    desk.on('dialog', dialog => { void dialog.accept(); });
    await desk.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : stubApi(route));
    await desk.goto(base + 'event.html');
    await desk.locator('#paper-workspace').waitFor({state: 'attached'});
    await setStep(desk, 'pick');
    const deskMission = desk.locator('#booth-missions .booth-mission').first();
    await deskMission.waitFor();
    await assertChromeHidden(desk, 'desktop pick');
    assert.equal(await desk.locator('#paper-workspace').isVisible(), false, 'desktop pick: workspace is visible');
    assert.ok(await overflow(desk) <= 0, 'desktop pick: horizontal overflow');
    await deskMission.click();
    await desk.waitForFunction(() => document.documentElement.dataset.boothStep === 'edit');
    await waitPageText(desk, '0.95');
    await setStep(desk, 'edit');
    await assertChromeHidden(desk, 'desktop edit');
    // The recipe panel (tabs, find-and-replace) sits right of the page, and the page image
    // starts above the fold next to it.
    if (await desk.locator('#booth-recipe').count()) {
      const recipe = await desk.evaluate(() => {
        const rect = selector => { const node = document.querySelector(selector); if (!node) return null; const box = node.getBoundingClientRect(); return {left: box.left, right: box.right, top: box.top, bottom: box.bottom}; };
        return {recipe: rect('#booth-recipe'), canvas: rect('.paper-page > canvas'), hint: rect('#booth-hint'), height: window.innerHeight};
      });
      assert.ok(recipe.recipe.left > recipe.canvas.right, 'desktop edit: recipe panel is not right of the page ' + JSON.stringify(recipe));
      assert.ok(recipe.recipe.top >= recipe.hint.bottom, 'desktop edit: recipe panel is not under the hint ' + JSON.stringify(recipe));
      assert.ok(recipe.canvas.top < recipe.height - 76 - 200, 'desktop edit: page image starts below the fold ' + JSON.stringify(recipe));
      assert.ok(recipe.recipe.top < recipe.canvas.bottom, 'desktop edit: recipe panel is not beside the page ' + JSON.stringify(recipe));
      assert.equal(await desk.locator('#booth-find-list').count(), 0, 'desktop edit: no paragraph list toggle');
    }
    const panes = await desk.evaluate(() => {
      const box = selector => { const node = document.querySelector(selector); if (!node) return null; const rect = node.getBoundingClientRect(); return {left: rect.left, right: rect.right, top: rect.top, width: rect.width}; };
      return {canvas: box('.paper-page > canvas'), recipe: box('#booth-recipe'), hint: box('#booth-hint'), toolbar: box('#paper-workspace .paper-toolbar'),
        foot: box('#source-link'), stageWidth: document.querySelector('#paper-before-stage').clientWidth};
    });
    assert.ok(panes.canvas, 'desktop edit: page missing ' + JSON.stringify(panes));
    assert.ok(panes.canvas.width >= 680 && panes.canvas.width <= 760, 'desktop edit: page column is 680-760px ' + JSON.stringify(panes));
    assert.ok(panes.stageWidth >= 320 && Math.abs(panes.canvas.width - panes.stageWidth) <= 2, 'desktop edit: page image is narrowed ' + JSON.stringify(panes));
    assert.ok(panes.foot && panes.foot.top > panes.canvas.top + 100, 'desktop edit: license link is not below the page ' + JSON.stringify(panes));
    assert.ok(panes.hint && panes.hint.left > panes.canvas.right, 'desktop edit: hint is not in the work column ' + JSON.stringify(panes));
    assert.ok(Math.abs(panes.hint.top - panes.toolbar.top) < 2, 'desktop edit: hint and page navigation do not share the top row ' + JSON.stringify(panes));
    assert.ok(await overflow(desk) <= 0, 'desktop edit: horizontal overflow');
    // The page navigation stays in view (sticky) while the page scrolls.
    await desk.evaluate(() => window.scrollTo(0, 400));
    await desk.waitForTimeout(100);
    const stuck = await desk.evaluate(() => ({scrollY: window.scrollY, navTop: document.querySelector('#paper-workspace .paper-toolbar').getBoundingClientRect().top}));
    assert.ok(stuck.scrollY > 0 && stuck.navTop >= 0, 'desktop edit: page navigation is not sticky ' + JSON.stringify(stuck));
    await desk.evaluate(() => window.scrollTo(0, 0));
    await checkWordAndSheetEdit(desk, true, 'desktop');
    assert.equal(await desk.locator('#paper-edits').isVisible(), false, 'desktop: applied edits list is visible (the dock shows them)');
    for (const step of ['send', 'ticket']) {
      await setStep(desk, step);
      await assertChromeHidden(desk, 'desktop ' + step);
      assert.equal(await desk.locator('#paper-workspace').isVisible(), false, 'desktop ' + step + ': workspace is visible');
      assert.ok(await overflow(desk) <= 0, 'desktop ' + step + ': horizontal overflow');
    }
    await desk.close();
    assert.equal(pageErrors.join('\n'), '');
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('event theme browser passed'); }, error => {
  console.error(error && error.message);
  console.error(error);
  process.exit(1);
});
