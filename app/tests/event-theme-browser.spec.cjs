'use strict';
// Real Chromium check of app/dist/event-theme.css on event.html. The API is stubbed.
// FALSIFY_BOOTH_MISSION_PDF names a local copy of arXiv 2309.15217 (CC BY 4.0).
// The booth step is set by hand on <html data-booth-step>, so this runs without booth.js changes.
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
    await page.waitForFunction(() => [...document.querySelectorAll('.paper-paragraph-button')].some(node => node.textContent.includes('0.95')));
    await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'edit');
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

    const paragraphIndex = await page.evaluate(() => {
      const hits = [...document.querySelectorAll('.paper-paragraph-button')].map((node, index) => ({index, text: node.textContent}))
        .filter(item => item.text.includes('0.95') && item.text.includes('0.78') && item.text.length <= 400);
      hits.sort((a, b) => a.text.length - b.text.length);
      return hits.length ? hits[0].index : -1;
    });
    assert.ok(paragraphIndex >= 0);
    const paragraph = page.locator('.paper-paragraph-button').nth(paragraphIndex);
    const card = await paragraph.boundingBox();
    assert.ok(card && card.height >= 44, 'paragraph card is shorter than 44px');
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.click();
    const editor = page.locator('textarea[aria-label$="직접 편집"]');
    await editor.waitFor();
    const done = page.locator('.paper-direct-controls').getByRole('button', {name: '완료', exact: true});
    const cancel = page.locator('.paper-direct-controls').getByRole('button', {name: '입력 취소', exact: true});
    assert.equal(await done.isVisible(), true, 'edit: 완료 is not visible');
    assert.equal(await cancel.isVisible(), true, 'edit: 입력 취소 is not visible');
    for (const [name, button] of [['완료', done], ['입력 취소', cancel]]) {
      const box = await button.boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, name + ' tap target ' + JSON.stringify(box));
    }
    const layout = await page.evaluate(() => {
      const area = document.querySelector('textarea[aria-label$="직접 편집"]').getBoundingClientRect();
      const canvas = document.querySelector('.paper-page > canvas').getBoundingClientRect();
      const bar = document.querySelector('.paper-direct-controls').getBoundingClientRect();
      return {areaTop: area.top, canvasBottom: canvas.bottom, barTop: bar.top, areaBottom: area.bottom, font: parseFloat(getComputedStyle(document.querySelector('textarea[aria-label$="직접 편집"]')).fontSize)};
    });
    assert.ok(layout.areaTop >= layout.canvasBottom, 'editor overlaps the page image ' + JSON.stringify(layout));
    assert.ok(layout.barTop >= layout.areaBottom, 'controls overlap the editor ' + JSON.stringify(layout));
    assert.ok(layout.font >= 16, 'editor font under 16px zooms iOS');
    assert.ok(await overflow(page) <= 0, 'editor: horizontal overflow');
    const original = await editor.inputValue();
    await editor.fill(original.replace('0.95', '0.50'));
    await done.tap();
    await page.waitForFunction(() => {
      const edits = document.querySelector('#paper-edits');
      return !!(edits && edits.textContent.includes('0.50') && edits.textContent.includes('0.95'));
    });
    assert.equal(await editor.count(), 0, '완료 did not close the editor');
    assert.ok(await overflow(page) <= 0, 'applied: horizontal overflow');

    for (const step of ['send', 'ticket']) {
      await setStep(page, step);
      await assertChromeHidden(page, step);
      assert.equal(await page.locator('#paper-workspace').isVisible(), false, step + ': workspace is visible');
      assert.ok(await overflow(page) <= 0, step + ': horizontal overflow');
    }
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
