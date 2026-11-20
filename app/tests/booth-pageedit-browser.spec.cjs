'use strict';
// Real Chromium walk of in-place page editing on event.html (booth-pageedit.js) on the Ragas mission,
// page 5, Table 1: the page is the editor. Phone 390x844 at DPR 3 (tap to zoom 2.5x, tap 0.95, popover,
// 바꾸기, patch, delete, 문단 전체 고치기) and desktop 1280x800 (direct clicks). The API is stubbed.
// FALSIFY_BOOTH_MISSION_PDF names a local copy of arXiv 2309.15217 (CC BY 4.0).
// BOOTH_PAGEEDIT_SHOTS, when set, is a directory for screenshots of each state.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217 (the Ragas paper)');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const shots = process.env.BOOTH_PAGEEDIT_SHOTS || '';
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_PAGEEDIT_PORT || 8883);
const token = 'fsg_' + 'c'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);
const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*'};

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

function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

let lastPage = null;
async function diagnose() {
  if (!lastPage || lastPage.isClosed()) return null;
  if (shots) await lastPage.screenshot({path: path.join(shots, 'failure.png')}).catch(() => {});
  return lastPage.evaluate(() => ({
    step: document.documentElement.dataset.boothStep,
    zoom: globalThis.FalsifyPaperWorkspace?.getZoom?.(),
    label: document.querySelector('#paper-page-label')?.textContent || '',
    dock: document.querySelector('#booth-dock-count')?.textContent || '',
    pop: document.querySelector('#booth-pe-pop')?.textContent || '',
    tip: document.querySelector('#booth-pe-bar')?.textContent || '',
    status: document.querySelector('#paper-before-status')?.textContent || '',
    edits: (globalThis.FalsifyPaperWorkspace?.getEditSnapshot()?.edits || []).map(edit => [edit.segmentId, edit.before, edit.after]),
  })).catch(() => null);
}

/* The client rect of the text-layer span that reads exactly 0.95 (Table 1, Ragas faithfulness). */
function scoreRect(page) {
  return page.evaluate(() => {
    const span = [...document.querySelectorAll('#paper-before-stage .paper-page .paper-text-layer span[data-i]')].find(node => node.textContent.trim() === '0.95');
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height};
  });
}

async function tapAt(page, wide, x, y) {
  if (wide) await page.mouse.click(x, y);
  else await page.touchscreen.tap(x, y);
}

async function openMission(browser, wide, tablet = false) {
  const context = await browser.newContext(tablet
    ? {viewport: {width: 1280, height: 800}, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'ko-KR'}
    : wide
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
  await page.evaluate(() => window.scrollTo(0, 0));
  return {page, errors};
}

async function assertLayout(page, wide) {
  assert.equal(await page.locator('.paper-paragraph-list').count() >= 1, true, 'the list stays in the DOM');
  // Visually hidden, still there for screen readers and keyboards (not display:none).
  const list = await page.locator('.paper-paragraph-list').first().evaluate(node => ({w: node.getBoundingClientRect().width, display: getComputedStyle(node).display, buttons: node.querySelectorAll('button').length}));
  assert.ok(list.w <= 1 && list.display !== 'none' && list.buttons > 0, 'the paragraph list is visually hidden but in the accessibility tree ' + JSON.stringify(list));
  assert.equal(await page.locator('#booth-pe-zoom-in').isVisible(), true, 'visible + zoom button');
  assert.equal(await page.locator('#booth-pe-zoom-out').isVisible(), true, 'visible − zoom button');
  assert.equal(await page.locator('#booth-find-list').count(), 0, 'no list toggle');
  const box = await page.evaluate(() => {
    const canvas = document.querySelector('#paper-before-stage .paper-page > canvas').getBoundingClientRect();
    const content = document.querySelector('.content');
    const style = getComputedStyle(content);
    return {width: canvas.width, stage: document.querySelector('#paper-before-stage').clientWidth, column: content.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)};
  });
  if (wide) assert.ok(box.width >= 680 && box.width <= 760, 'desktop page column is 680-760px: ' + JSON.stringify(box));
  else assert.ok(Math.abs(box.stage - box.column) <= 2, 'phone page spans the column: ' + JSON.stringify(box));
  assert.equal(await page.locator('#booth-pe-pop').isVisible(), false);
}

/* Phone: the mission opens zoomed (3.5x) on Table 1; 전체 쪽 zooms out. */
async function autoZoomed(page) {
  await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 3.5
    && document.querySelector('#paper-before-stage .paper-page > canvas').getBoundingClientRect().width > 1000);
  await waitScoreInStage(page);
  assert.equal(await page.locator('#booth-pe-fit').isVisible(), true, '전체 쪽 shows while zoomed');
  await canvasCapped(page);
}

/* iOS Safari draws a blank canvas past 4096 px a side or ~16.7M px. */
async function canvasCapped(page) {
  const size = await page.evaluate(() => { const c = document.querySelector('#paper-before-stage .paper-page > canvas'); return [c.width, c.height]; });
  assert.ok(size[0] <= 4096 && size[1] <= 4096 && size[0] * size[1] <= 16777216, 'zoomed canvas backing store stays within iOS limits ' + size);
}

/* The +/− buttons step the zoom without pinching (WCAG 2.5.7). */
async function zoomButtons(page, first) {
  await page.locator('#booth-pe-zoom-in').click();
  await page.waitForFunction(value => globalThis.FalsifyPaperWorkspace.getZoom() === value, first);
  assert.equal(await page.locator('#booth-pe-fit').isVisible(), true);
  await page.locator('#booth-pe-zoom-out').click();
  await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1);
  assert.equal(await page.locator('#booth-pe-zoom-out').isDisabled(), true, '− is off at the fit size');
}

async function zoomOut(page) {
  await page.locator('#booth-pe-fit').click();
  await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1 && !document.documentElement.classList.contains('booth-pe-zoomed')
    && document.querySelector('#paper-before-stage .paper-page > canvas').getBoundingClientRect().width < 400);
  assert.equal(await page.locator('#booth-pe-fit').isVisible(), false);
}

function waitScoreInStage(page) {
  return page.waitForFunction(() => {
    const stage = document.querySelector('#paper-before-stage');
    const span = [...stage.querySelectorAll('.paper-text-layer span[data-i]')].find(node => node.textContent.trim() === '0.95');
    if (!span) return false;
    const s = stage.getBoundingClientRect();
    const r = span.getBoundingClientRect();
    return r.left >= s.left && r.right <= s.right && r.top >= s.top && r.bottom <= s.bottom && r.bottom <= innerHeight;
  });
}

/* Phone only: from the fit view, a tap zooms around the tap inside a pannable box; a table gets 3.5x. */
async function zoomIn(page) {
  assert.equal(await page.locator('#booth-pe-fit').isVisible(), false);
  const before = await scoreRect(page);
  await page.touchscreen.tap(before.x, before.y);
  await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 3.5
    && document.querySelector('#paper-before-stage .paper-page > canvas').getBoundingClientRect().width > 1000);
  await page.waitForFunction(() => {
    const stage = document.querySelector('#paper-before-stage');
    const span = [...stage.querySelectorAll('.paper-text-layer span[data-i]')].find(node => node.textContent.trim() === '0.95');
    if (!span) return false;
    const s = stage.getBoundingClientRect();
    const r = span.getBoundingClientRect();
    return r.left >= s.left && r.right <= s.right && r.top >= s.top && r.bottom <= s.bottom;
  });
  assert.equal(await page.locator('#booth-pe-pop').isVisible(), false, 'the first tap only zooms');
  assert.equal(await page.locator('#booth-pe-fit').isVisible(), true, '전체 쪽 shows while zoomed');
  const box = await page.evaluate(() => {
    const stage = document.querySelector('#paper-before-stage');
    return {scrollW: stage.scrollWidth, clientW: stage.clientWidth, overflow: getComputedStyle(stage).overflowX};
  });
  assert.ok(box.scrollW > box.clientW * 2 && box.overflow === 'auto', 'zoomed page pans inside the stage ' + JSON.stringify(box));
  await canvasCapped(page);
  const after = await scoreRect(page);
  assert.ok(after.height > before.height * 2.5, 'the score is drawn bigger: ' + JSON.stringify([before, after]));
}

async function selectScore(page, wide, offset = {x: 0, y: 0}) {
  const rect = await scoreRect(page);
  await tapAt(page, wide, rect.x + offset.x, rect.y + offset.y);
  const pop = page.locator('#booth-pe-pop');
  await pop.waitFor({state: 'visible'});
  const input = page.locator('#booth-pe-input');
  assert.equal(await input.inputValue(), '0.95', 'the popover is prefilled with the tapped token');
  assert.equal(await input.evaluate(node => node === document.activeElement), true, 'the input is focused');
  assert.equal(await input.evaluate(node => node.selectionStart === 0 && node.selectionEnd === node.value.length), true, 'the word is selected');
  assert.ok(parseFloat(await input.evaluate(node => getComputedStyle(node).fontSize)) >= 16, 'input font is at least 16px');
  assert.deepEqual(await input.evaluate(node => ['inputmode', 'enterkeyhint', 'autocapitalize', 'autocorrect'].map(key => node.getAttribute(key)).concat(node.spellcheck)),
    ['decimal', 'done', 'off', 'off', false]);
  for (const button of await pop.locator('button:visible').all()) {
    const b = await button.boundingBox();
    assert.ok(b.width >= 44 && b.height >= (wide ? 44 : 36), 'popover tap target ' + JSON.stringify(b));
  }
  await page.waitForTimeout(50);
  const now = await scoreRect(page); // the bar may pan the word into view
  const sel = await page.locator('#paper-before-stage .booth-pe-sel').boundingBox();
  assert.ok(sel && Math.abs(sel.x + sel.width / 2 - now.x) < 4 && Math.abs(sel.y + sel.height / 2 - now.y) < 4, 'the ink box sits on the word');
  assert.ok(sel && Math.abs(sel.x + sel.width / 2 - now.x) < 4 );
  const p = await pop.boundingBox();
  const vw = wide ? 1280 : page.viewportSize().width;
  assert.ok(p.x >= 0 && p.x + p.width <= vw, 'the popover stays on screen ' + JSON.stringify(p));
  if (wide) {
    assert.equal(await pop.evaluate(node => node.classList.contains('is-bar')), false);
    assert.deepEqual(await pop.locator('button:visible').allTextContents(), ['바꾸기', '문단 전체 고치기', '취소']);
    assert.ok(p.y >= sel.y + sel.height || p.y + p.height <= sel.y, 'the popover does not cover the word');
  } else {
    assert.equal(await pop.evaluate(node => node.classList.contains('is-bar')), true, 'phones get the edit bar');
    assert.deepEqual(await pop.locator('button:visible').allTextContents(), ['‹', '›', '바꾸기', '문단 전체 고치기', '취소']);
    assert.ok(Math.abs(p.y + p.height - page.viewportSize().height) <= 1, 'with no keyboard the bar sits at the bottom ' + JSON.stringify(p));
    assert.ok(sel.y + sel.height <= p.y, 'the word stays above the bar');
    assert.equal(await page.locator('#booth-dock').isVisible(), false, 'the dock steps aside while editing');
  }
  return rect;
}

/* Phone: a smaller visual viewport (the soft keyboard) lifts the bar; the word stays above it. */
async function barAboveKeyboard(page) {
  await page.evaluate(() => {
    const fake = new EventTarget();
    Object.assign(fake, {width: innerWidth, height: innerHeight - 300, offsetTop: 0, offsetLeft: 0, scale: 1});
    Object.defineProperty(window, 'visualViewport', {value: fake, configurable: true});
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => document.querySelector('#booth-pe-pop').style.bottom === '300px');
  const geo = await page.evaluate(() => ({bar: document.querySelector('#booth-pe-pop').getBoundingClientRect().toJSON(),
    sel: document.querySelector('.booth-pe-sel').getBoundingClientRect().toJSON(), height: innerHeight}));
  assert.ok(Math.abs(geo.bar.bottom - (geo.height - 300)) <= 1, 'bar pinned above the keyboard ' + JSON.stringify(geo));
  assert.ok(geo.sel.bottom <= geo.bar.top && geo.sel.top >= 0, 'the word is panned above the bar ' + JSON.stringify(geo));
  await shoot(page, 'word-bar-keyboard', false);
  await page.evaluate(() => { delete window.visualViewport; window.dispatchEvent(new Event('resize')); });
  await page.waitForFunction(() => document.querySelector('#booth-pe-pop').style.bottom === '0px');
}

/* Phone: ‹ › walk the words of the page in reading order. */
async function stepWords(page) {
  const input = page.locator('#booth-pe-input');
  await page.locator('#booth-pe-pop .booth-pe-next').click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-input').value === '0.78');
  assert.equal(await input.getAttribute('inputmode'), 'decimal');
  await page.locator('#booth-pe-pop .booth-pe-prev').click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-input').value === '0.95');
  await page.locator('#booth-pe-pop .booth-pe-prev').click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-input').value === 'Ragas');
  assert.equal(await input.getAttribute('inputmode'), 'text', 'words get the text keyboard');
  await page.locator('#booth-pe-pop .booth-pe-next').click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-input').value === '0.95');
}

async function patchBox(page) {
  return page.evaluate(() => {
    const node = document.querySelector('#paper-before-stage .paper-page .booth-patch');
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return {x: r.left, y: r.top, width: r.width, height: r.height, text: node.textContent, events: getComputedStyle(node).pointerEvents};
  });
}

async function replaceScore(page, wide, tapped) {
  let rect = tapped;
  await page.locator('#booth-pe-input').fill('0.50');
  await shoot(page, 'word-popover', wide);
  await page.locator('#booth-pe-pop').getByRole('button', {name: '바꾸기', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
  assert.equal(await page.locator('#booth-pe-pop').isVisible(), false);
  assert.match(await page.locator('#paper-edits').textContent(), /0\.95 → 0\.50/);
  const edits = await page.evaluate(() => globalThis.FalsifyPaperWorkspace.getEditSnapshot().edits.map(edit => [edit.segmentId, edit.before, edit.after, edit.origin]));
  assert.equal(edits.length, 1);
  assert.match(edits[0][0], /^paragraph:4:/, 'the edit lands in the tapped paragraph');
  assert.deepEqual(edits[0].slice(1), ['0.95', '0.50', 'external-ai-import'], 'same pipeline as find-and-replace');
  const patch = await patchBox(page);
  assert.ok(patch, 'a .booth-patch covers the old spot');
  rect = await scoreRect(page); // the applied-edit row above the page on phones moves the page down
  assert.equal(patch.text, '0.50');
  assert.equal(patch.events, 'none', 'the patch never takes taps');
  assert.ok(Math.abs(patch.x - rect.left) <= 3 && Math.abs(patch.y - rect.top) <= 3 && patch.width >= rect.width - 3 && Math.abs(patch.height - rect.height) <= 2, 'patch over the old word ' + JSON.stringify([patch, rect]));
  await shoot(page, 'patched', wide);
  await patchAtFit(page, wide);
}

/* The patch is painted at every zoom: at the fit size (zoom 1, also after −/+ and 전체 쪽) it still covers
   the edited token with a non-zero box and reads 0.50. */
async function patchAtFit(page, wide, label = 'fit') {
  const id = await page.evaluate(() => globalThis.FalsifyPaperWorkspace.getEditSnapshot().edits.find(edit => edit.after.includes('0.50')).id);
  if (await page.locator('#booth-pe-fit').isVisible()) await page.locator('#booth-pe-fit').click();
  await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1);
  await page.locator('#booth-pe-zoom-in').click();
  await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() > 1);
  await page.locator('#booth-pe-zoom-out').click();
  await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1);
  await page.waitForFunction(value => {
    const node = [...document.querySelectorAll('#paper-before-stage .paper-page .booth-patch')].find(item => item.dataset.patchId === value);
    return node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
  }, id);
  const fit = await page.evaluate(value => {
    const node = [...document.querySelectorAll('#paper-before-stage .paper-page .booth-patch')].find(item => item.dataset.patchId === value);
    const p = node.getBoundingClientRect();
    const span = [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].find(item => item.textContent.trim() === '0.95');
    const range = document.createRange();
    range.selectNodeContents(span);
    const t = range.getBoundingClientRect();
    return {text: node.textContent, w: p.width, h: p.height, cx: Math.abs((p.left + p.width / 2) - (t.left + t.width / 2)), cy: Math.abs((p.top + p.height / 2) - (t.top + t.height / 2)), tw: t.width, th: t.height,
      mark: [...document.querySelectorAll('#paper-before-stage .paper-change-mark')].filter(item => item.dataset.edit === value && item.getBoundingClientRect().width > 0).length};
  }, id);
  assert.equal(fit.text, '0.50', label + ': the patch reads the new value');
  assert.ok(fit.w > 0 && fit.h > 0, label + ': the patch has a size ' + JSON.stringify(fit));
  assert.ok(fit.cx <= Math.max(2, fit.tw / 2) && fit.cy <= Math.max(2, fit.th / 2), label + ': the patch sits over the token ' + JSON.stringify(fit));
  assert.equal(fit.mark, 0, label + ': no change mark drawn over the patch');
  await shoot(page, label === 'fit' ? 'patched-fit' : 'tablet-patched-fit', wide);
  if (!wide) await zoomIn(page); // back to the zoomed phone view the walk continues in
}

/* Page turns redraw the page; the patch is painted again on page 5. */
async function patchSurvivesTurn(page) {
  await page.locator('#paper-page-next').click();
  await page.waitForFunction(() => /^6 \//.test(document.querySelector('#paper-page-label').textContent)
    && !!document.querySelector('#paper-before-stage .paper-page canvas') && !document.querySelector('#paper-before-stage .booth-patch'));
  await page.locator('#paper-page-prev').click();
  await page.waitForFunction(() => /^5 \//.test(document.querySelector('#paper-page-label').textContent)
    && [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(node => node.textContent.trim() === '0.95'));
  await page.waitForFunction(() => document.querySelector('#paper-before-stage .paper-page .booth-patch')?.textContent === '0.50');
}

async function deleteEdit(page, wide) {
  if (wide) {
    const x = page.locator('#booth-dock-chips .booth-dock-x');
    assert.equal(await x.count(), 1);
    await x.click();
  } else {
    await page.locator('#paper-edits [data-act="delete"]').click();
  }
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 0개');
  await page.waitForFunction(() => !document.querySelector('.booth-patch'));
}

async function wholeParagraph(page, wide) {
  await selectScore(page, wide);
  await page.locator('#booth-pe-pop').getByRole('button', {name: '문단 전체 고치기'}).click();
  const editor = page.locator('textarea[aria-label$="직접 편집"]');
  await editor.waitFor();
  assert.equal(await page.locator('#booth-pe-pop').isVisible(), false);
  if (!wide) assert.equal(await page.evaluate(() => globalThis.FalsifyPaperWorkspace.getZoom()), 1, 'the phone zooms out for the sheet');
  assert.match(await editor.inputValue(), /0\.95/);
  const crop = page.locator('#paper-before-stage .booth-pe-head canvas.booth-pe-crop');
  await crop.waitFor();
  await page.waitForFunction(() => document.querySelector('.booth-pe-crop')?.dataset.sharp === '1');
  const look = await page.evaluate(() => {
    const area = document.querySelector('textarea[aria-label$="직접 편집"]');
    const style = getComputedStyle(area);
    const c = document.querySelector('.booth-pe-crop');
    const a = area.getBoundingClientRect();
    const r = c.getBoundingClientRect();
    const page = document.querySelector('#paper-before-stage .paper-page > canvas').getBoundingClientRect();
    return {font: style.fontFamily, size: parseFloat(style.fontSize), align: style.textAlign, bg: style.backgroundColor,
      cropBottom: r.bottom, cropW: r.width, cropH: r.height, pixels: c.width / r.width, areaTop: a.top, areaLeft: a.left, pageRight: page.right, pageBottom: page.bottom};
  });
  assert.match(look.font, /Times New Roman|serif/, 'serif face');
  assert.ok(look.size >= 16, 'editor font >= 16px');
  assert.equal(look.align, 'justify');
  assert.equal(look.bg, 'rgb(255, 255, 255)');
  assert.ok(look.cropW > 100 && look.cropH > 10 && look.cropBottom <= look.areaTop, 'the crop sits above the text box ' + JSON.stringify(look));
  assert.ok(look.pixels >= (wide ? 1 : 2.9), 'the crop is drawn at device pixels ' + JSON.stringify(look));
  if (wide) assert.ok(look.areaLeft > look.pageRight, 'desktop sheet sits in the work column');
  else assert.ok(look.areaTop >= look.pageBottom, 'phone sheet sits below the page');
  await shoot(page, 'paragraph-editor', wide);
  const cancel = page.locator('.paper-direct-controls').getByRole('button', {name: '입력 취소', exact: true});
  const dock = await page.evaluate(() => {
    const node = document.querySelector('#booth-dock');
    return {top: node.offsetParent === null ? innerHeight : node.getBoundingClientRect().top};
  });
  if (!wide) assert.equal(await page.locator('#booth-dock').isVisible(), false, 'the dock steps aside while the sheet has focus');
  await cancel.scrollIntoViewIfNeeded();
  const cancelBox = await cancel.boundingBox();
  assert.ok(cancelBox.y + cancelBox.height <= dock.top, 'the sheet controls show above the dock ' + JSON.stringify([cancelBox, dock]));
  await cancel.click();
  await page.waitForFunction(() => !document.querySelector('textarea[aria-label$="직접 편집"]') && !document.querySelector('.booth-pe-head'));
}

async function walk(browser, wide) {
  const {page, errors} = await openMission(browser, wide);
  await assertLayout(page, wide);
  if (!wide) {
    await autoZoomed(page);
    await page.locator('#booth-pe-bar').evaluate(node => node.scrollIntoView({block: 'start'}));
    await shoot(page, 'zoomed', wide);
    await zoomOut(page);
    const fitWidth = await page.evaluate(() => [document.querySelector('#paper-before-stage .paper-page > canvas').getBoundingClientRect().width, document.querySelector('#paper-before-stage').clientWidth]);
    assert.ok(Math.abs(fitWidth[0] - fitWidth[1]) <= 2, 'the fit page fills the column ' + fitWidth);
    await page.locator('#paper-workspace .paper-toolbar').evaluate(node => node.scrollIntoView({block: 'start'}));
  }
  await zoomButtons(page, wide ? 1.25 : 1.5);
  if (!wide) await page.locator('#paper-workspace .paper-toolbar').evaluate(node => node.scrollIntoView({block: 'start'}));
  await shoot(page, 'page-fit', wide);
  if (!wide) await zoomIn(page);
  // A finger that lands about 10px right of the number (nothing else within 24px) still selects it on phones.
  const rect = await selectScore(page, wide, wide ? {x: 0, y: 0} : {x: (await scoreRect(page)).width / 2 + 10, y: 0});
  if (!wide) {
    await stepWords(page);
    await barAboveKeyboard(page);
  }
  await replaceScore(page, wide, rect);
  assert.equal(await page.locator('#booth-dock').isVisible(), true, 'the dock is back after the edit');
  if (!wide) {
    // The applied edit is a booth card below the page: 5쪽 0.95 → 0.50, numbers in mono, a small 삭제.
    const card = await page.evaluate(() => {
      const row = document.querySelector('#paper-edits > li');
      const ins = row.querySelector('ins.booth-edit-text');
      return {below: row.getBoundingClientRect().top >= document.querySelector('#paper-before-stage').getBoundingClientRect().bottom,
        text: row.querySelector('[data-act="edit"]').textContent, number: ins.classList.contains('is-number'), mono: /mono/i.test(getComputedStyle(ins).fontFamily),
        origin: !!row.querySelector('.paper-edit-origin')?.offsetParent};
    });
    assert.deepEqual(card, {below: true, text: '5쪽 0.95 → 0.50', number: true, mono: true, origin: false});
  }
  await patchSurvivesTurn(page);
  await deleteEdit(page, wide);
  await wholeParagraph(page, wide);
  if (!wide) {
    await page.setViewportSize({width: 360, height: 780});
    assert.ok(await overflow(page) <= 0, '360px fit: horizontal overflow');
    await page.waitForFunction(() => Math.abs(document.querySelector('#paper-before-stage .paper-page > canvas').getBoundingClientRect().width - document.querySelector('#paper-before-stage').clientWidth) <= 2);
    await zoomIn(page);
    assert.ok(await overflow(page) <= 0, '360px zoomed: horizontal overflow');
    await selectScore(page, wide);
    assert.ok(await overflow(page) <= 0, '360px edit bar: horizontal overflow');
    await page.locator('#booth-pe-pop').getByRole('button', {name: '취소'}).click();
    await zoomOut(page);
  } else {
    // Enter applies, Esc cancels and returns focus to the page.
    await selectScore(page, wide);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#booth-pe-pop').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'paper-before-stage');
    await selectScore(page, wide);
    await page.locator('#booth-pe-input').fill('0.51');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
    const s = await scoreRect(page);
    await page.mouse.move(s.x, s.y + 40);
    await page.mouse.move(s.x + 60, s.y);
    await page.locator('#paper-before-stage .booth-pe-hover').waitFor({timeout: 1000});
  }
  const foot = await page.evaluate(() => {
    const a = document.querySelector('#agent-link').getBoundingClientRect();
    const s = document.querySelector('#source-link').getBoundingClientRect();
    return {gap: s.left - a.right, sameLine: Math.abs(a.top - s.top) < 2, sep: getComputedStyle(document.querySelector('#source-link'), '::before').content};
  });
  assert.equal(foot.sep, '"·"', 'footer links have a separator');
  if (foot.sameLine) assert.ok(foot.gap >= 0, 'footer links do not touch');
  assert.equal(errors.join('\n'), '');
  await page.context().close();
}

/* A landscape touch tablet (the booth device, a Galaxy Tab S7 FE class: 1280x800 CSS px at DPR 2): desktop layout, touch editing model, no zoom needed to tap. */
async function tabletWalk(browser) {
  const {page, errors} = await openMission(browser, true, true);
  await assertLayout(page, true);
  assert.equal(await page.evaluate(() => globalThis.FalsifyPaperWorkspace.getZoom()), 1, 'the tablet page is large enough without zoom');
  await shoot(page, 'tablet-page-fit', true);
  const rect = await scoreRect(page);
  await page.touchscreen.tap(rect.x + rect.width / 2 + 8, rect.y);
  const pop = page.locator('#booth-pe-pop');
  await pop.waitFor({state: 'visible'});
  const input = page.locator('#booth-pe-input');
  assert.equal(await input.inputValue(), '0.95', 'a tap near the number selects it');
  assert.equal(await input.getAttribute('inputmode'), 'decimal');
  assert.equal(await pop.evaluate(node => node.classList.contains('is-bar')), true, 'a coarse pointer gets the edit bar at desktop width');
  assert.deepEqual(await pop.locator('button:visible').allTextContents(), ['‹', '›', '바꾸기', '문단 전체 고치기', '취소']);
  const p = await pop.boundingBox();
  const column = await page.locator('#paper-before-stage .paper-page > canvas').boundingBox();
  assert.ok(Math.abs(p.y + p.height - 800) <= 1, 'bar at the bottom ' + JSON.stringify(p));
  assert.ok(Math.abs(p.x - column.x) <= 1 && Math.abs(p.width - column.width) <= 1, 'bar lines up with the page column ' + JSON.stringify([p, column]));
  assert.equal(await page.locator('#booth-dock').isVisible(), false, 'the dock steps aside while typing');
  await shoot(page, 'tablet-word-bar', true);
  await input.fill('0.50');
  await pop.getByRole('button', {name: '바꾸기'}).tap();
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
  assert.equal(await page.locator('#booth-dock').isVisible(), true);
  await page.locator('#paper-before-stage .booth-patch').first().waitFor();
  await patchAtFit(page, true, 'tablet');
  await page.locator('#booth-pe-zoom-in').tap();
  await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1.25);
  await canvasCapped(page);
  await shoot(page, 'tablet-zoomed', true);
  await page.locator('#booth-pe-fit').tap();
  await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1);
  assert.ok(await overflow(page) <= 0, 'tablet: horizontal overflow');
  assert.equal(errors.join('\n'), '');
  await page.context().close();
}

/* Phone race: the visitor touches the zoom bar while the paper is still loading; the hint zoom must not
   jump in later and override them. */
async function hintZoomYields(browser) {
  const context = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 3, hasTouch: true, locale: 'ko-KR'});
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  lastPage = page;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = 'http://127.0.0.1:' + port + '/';
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (new URL(url).pathname === '/v1/papers/pdf') await new Promise(resolve => setTimeout(resolve, 2500));
    return stubApi(route);
  });
  await page.goto(base + 'event.html');
  await page.locator('#booth-missions .booth-mission').first().click();
  await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'edit');
  const bar = await page.locator('#booth-pe-bar').boundingBox();
  await page.touchscreen.tap(bar.x + 20, bar.y + bar.height / 2);
  await page.waitForFunction(() => /^5 \//.test(document.querySelector('#paper-page-label')?.textContent || '')
    && (globalThis.FalsifyPaperWorkspace.getPageParagraphs()?.items || []).some(item => item.text.includes('0.95')));
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => globalThis.FalsifyPaperWorkspace.getZoom()), 1, 'a touch before the page is drawn cancels the hint zoom');
  assert.equal(errors.join('\n'), '');
  await context.close();
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    await walk(browser, false);
    await walk(browser, true);
    await tabletWalk(browser);
    await hintZoomYields(browser);
  } catch (error) {
    error.message += '\npage=' + JSON.stringify(await diagnose());
    throw error;
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth page edit browser passed'); }, error => {
  console.error(error && error.message);
  console.error(error && error.stack || error);
  process.exit(1);
});
