'use strict';
// Real Chromium check of FalsifyBoothPatch (app/dist/booth-patch.js) on the Ragas paper, page 5 (Table 1).
// A bare test page renders the page with pdfjs-dist from app/node_modules the way paper-workspace.js does
// (canvas backing at devicePixelRatio, pdf.js TextLayer in CSS pixels inside .paper-page), finds the
// text-layer span holding 0.95, measures it and paints 0.50 over it at deviceScaleFactor 1 and 3. Checks:
// the overlay box matches the span box within 1px, it sits between canvas and text layer, it takes no
// pointer events, the background is sampled from the page, repaint after a page resize keeps the
// position, and remove() and clear() take overlays away.
// FALSIFY_BOOTH_MISSION_PDF names a local copy of arXiv 2309.15217 (CC BY 4.0). Every non-local request
// is aborted. FALSIFY_PATCH_SHOTS, when set, names a directory for before/after crops at 3x.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const appDir = path.resolve(__dirname, '..');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217 (the Ragas paper)');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const shots = process.env.FALSIFY_PATCH_SHOTS || '';
const pdfBytes = fs.readFileSync(pdfPath);
const PAGE_NO = 5;
const PAGE_WIDTH = 660;
let base = '';

const TEST_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<link rel="stylesheet" href="dist/paper-workspace.css"><link rel="stylesheet" href="dist/booth-patch.css">' +
  '<style>body{margin:0;padding:24px;background:#eef0f2}.paper-canvas{border:0}</style>' +
  '<script src="dist/booth-patch.js"></script></head><body><div id="host"></div>' +
  '<script type="module">' +
  'import * as lib from "./node_modules/pdfjs-dist/build/pdf.mjs";' +
  'lib.GlobalWorkerOptions.workerSrc = "./node_modules/pdfjs-dist/build/pdf.worker.mjs";' +
  'window.renderPage = async (pageNo, width) => {' +
  '  const doc = await lib.getDocument({url: "__mission.pdf", standardFontDataUrl: "./node_modules/pdfjs-dist/standard_fonts/"}).promise;' +
  '  const pdfPage = await doc.getPage(pageNo);' +
  '  const scale = width / pdfPage.getViewport({scale: 1}).width;' +
  '  const viewport = pdfPage.getViewport({scale});' +
  '  const pageEl = document.createElement("div"); pageEl.className = "paper-page";' +
  '  pageEl.style.width = viewport.width + "px"; pageEl.style.height = viewport.height + "px";' +
  '  pageEl.style.setProperty("--total-scale-factor", String(scale)); pageEl.style.setProperty("--text-scale-factor", "1");' +
  '  pageEl.style.setProperty("--scale-round-x", "1px"); pageEl.style.setProperty("--scale-round-y", "1px");' +
  '  const canvas = document.createElement("canvas"); canvas.className = "paper-canvas";' +
  '  const cssW = Math.floor(viewport.width), cssH = Math.floor(viewport.height), out = Math.min(3, Math.max(1, devicePixelRatio));' +
  '  canvas.width = Math.floor(cssW * out); canvas.height = Math.floor(cssH * out);' +
  '  canvas.style.width = cssW + "px"; canvas.style.height = cssH + "px";' +
  '  const textEl = document.createElement("div"); textEl.className = "paper-text-layer textLayer";' +
  '  pageEl.append(canvas, textEl); document.getElementById("host").replaceChildren(pageEl);' +
  '  const params = {canvasContext: canvas.getContext("2d"), canvas, viewport};' +
  '  if (out !== 1) params.transform = [out, 0, 0, out, 0, 0];' +
  '  await pdfPage.render(params).promise;' +
  '  const layer = new lib.TextLayer({textContentSource: await pdfPage.getTextContent(), container: textEl, viewport});' +
  '  await layer.render();' +
  '  layer.textDivs.forEach((div, i) => { div.dataset.i = String(i); });' +
  '  return {width: viewport.width, height: viewport.height, scale};' +
  '};' +
  'window.pageReady = true;' +
  '</script></body></html>';

function serve() {
  const child = spawn('python3', ['-m', 'http.server', '0', '--bind', '127.0.0.1'], {
    cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PYTHONUNBUFFERED: '1'},
  });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.stderr.on('data', chunk => { text += chunk; });
  const ready = (async () => {
    const started = Date.now();
    while (Date.now() - started < 8000) {
      if (child.exitCode != null) throw new Error('http.server exited ' + child.exitCode + '\n' + text);
      const port = /port (\d+)/.exec(text);
      if (port) base = 'http://127.0.0.1:' + port[1] + '/';
      try { if (base && (await fetch(base + 'dist/booth-patch.js')).ok) return; } catch { /* not yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('http.server did not start\n' + text);
  })();
  return {child, ready};
}

/* Box of the token inside its span (a Range over the token's characters), in page CSS pixels and fractions. */
function findToken([token, near]) {
  const pageEl = document.querySelector('.paper-page');
  const spans = [...pageEl.querySelectorAll('.textLayer span')].filter(span => span.textContent.includes(token));
  const pick = near ? spans.find(span => span.textContent.includes(near)) || spans[0] : spans[0];
  if (!pick) return null;
  pick.dataset.patchTarget = token;
  const page = pageEl.getBoundingClientRect();
  const node = pick.firstChild, at = pick.textContent.indexOf(token);
  const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + token.length);
  const span = pick.getBoundingClientRect(), tok = range.getBoundingClientRect();
  const m = window.FalsifyBoothPatch.measure(pick);
  // The token's x and width come from the Range; y and height from measure(), whose baselineFrac refers to it.
  const tokenRect = {x: (tok.left - page.left) / page.width, y: m.rect.y, w: tok.width / page.width, h: m.rect.h};
  return {text: pick.textContent, span: [span.left - page.left, span.top - page.top, span.width, span.height],
    token: [tokenRect.x * page.width, tokenRect.y * page.height, tokenRect.w * page.width, tokenRect.h * page.height], tokenRect, measure: m,
    page: [page.width, page.height],
    computed: {fontSize: getComputedStyle(pick).fontSize, transform: getComputedStyle(pick).transform, family: getComputedStyle(pick).fontFamily}};
}

function overlayState(id) {
  const pageEl = document.querySelector('.paper-page');
  const page = pageEl.getBoundingClientRect();
  const node = pageEl.querySelector('.booth-patch[data-patch-id="' + id + '"]');
  if (!node) return null;
  const r = node.getBoundingClientRect(), text = node.querySelector('.booth-patch-text');
  const kids = [...pageEl.children];
  const textStyle = getComputedStyle(text);
  const probe = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {rect: [r.left - page.left, r.top - page.top, r.width, r.height], text: text.textContent,
    order: kids.map(kid => kid.tagName === 'CANVAS' ? 'canvas' : kid.classList.contains('booth-patch') ? 'patch' : kid.classList.contains('textLayer') ? 'text' : 'other'),
    pointer: getComputedStyle(node).pointerEvents, textPointer: textStyle.pointerEvents, background: getComputedStyle(node).backgroundColor,
    fontSize: parseFloat(textStyle.fontSize), weight: textStyle.fontWeight, family: textStyle.fontFamily, transform: textStyle.transform,
    probeIsPatch: !!(probe && probe.closest('.booth-patch')), count: pageEl.querySelectorAll('.booth-patch').length};
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, label + ': ' + actual + ' vs ' + expected);
}
function sameRect(a, b, tolerance, label) { a.forEach((v, i) => near(v, b[i], tolerance, label + '[' + i + ']')); }

async function crop(page, rect, pad, file) {
  if (!shots) return;
  const pageBox = await page.locator('.paper-page').boundingBox();
  await page.screenshot({path: path.join(shots, file), clip: {x: pageBox.x + rect.x * pageBox.width - pad.l, y: pageBox.y + rect.y * pageBox.height - pad.t,
    width: rect.w * pageBox.width + pad.l + pad.r, height: rect.h * pageBox.height + pad.t + pad.b}});
}

async function paintToken(page, id, token, nearText, text) {
  const found = await page.evaluate(findToken, [token, nearText]);
  assert.ok(found, token + ' span not found');
  await page.evaluate(([pid, f, t]) => window.FalsifyBoothPatch.paint(document.querySelector('.paper-page'),
    {id: pid, pageIndex: 4, rect: f.tokenRect, text: t, font: {fontPx: f.measure.fontPx, baselineFrac: f.measure.baselineFrac, family: f.measure.family}}),
  [id, found, text]);
  return found;
}

async function run(browser, dpr) {
  const page = await browser.newPage({viewport: {width: 1000, height: 1100}, deviceScaleFactor: dpr, locale: 'en-US'});
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === base + '__patch.html') return route.fulfill({status: 200, contentType: 'text/html', body: TEST_PAGE});
    if (url === base + '__mission.pdf') return route.fulfill({status: 200, contentType: 'application/pdf', body: pdfBytes});
    return url.startsWith(base) ? route.continue() : route.abort();
  });
  try {
    await page.goto(base + '__patch.html');
    await page.waitForFunction(() => window.pageReady === true && !!window.FalsifyBoothPatch);
    const view = await page.evaluate(([n, w]) => window.renderPage(n, w), [PAGE_NO, PAGE_WIDTH]);
    const out = {dpr, view};
    const table = await page.evaluate(findToken, ['0.95', null]);
    assert.ok(table, '0.95 span not found');
    out.table = table;
    const tableArea = {x: table.tokenRect.x - 0.32, y: table.tokenRect.y - 0.09, w: 0.62, h: 0.2};
    const body = await page.evaluate(findToken, ['WikiEval', null]);
    assert.ok(body, 'WikiEval body span not found');
    out.body = body;
    const bodyArea = {x: 0.06, y: body.tokenRect.y - 0.012, w: 0.44, h: 0.05};
    await crop(page, tableArea, {l: 0, t: 0, r: 0, b: 0}, 'table-before-' + dpr + 'x.png');
    await crop(page, bodyArea, {l: 0, t: 0, r: 0, b: 0}, 'body-before-' + dpr + 'x.png');
    const wordArea = {x: body.tokenRect.x - 0.03, y: body.tokenRect.y - 0.006, w: body.tokenRect.w + 0.1, h: body.tokenRect.h + 0.012};
    await crop(page, wordArea, {l: 0, t: 0, r: 0, b: 0}, 'word-before-' + dpr + 'x.png');

    await paintToken(page, 'p095', '0.95', null, '0.50');
    out.painted = await page.evaluate(overlayState, 'p095');
    await paintToken(page, 'pbody', 'WikiEval', null, 'WikiQA');
    out.bodyPainted = await page.evaluate(overlayState, 'pbody');
    out.bodyCount = out.bodyPainted.count;
    await crop(page, tableArea, {l: 0, t: 0, r: 0, b: 0}, 'table-after-' + dpr + 'x.png');
    await crop(page, bodyArea, {l: 0, t: 0, r: 0, b: 0}, 'body-after-' + dpr + 'x.png');
    await crop(page, wordArea, {l: 0, t: 0, r: 0, b: 0}, 'word-after-' + dpr + 'x.png');

    // A long replacement is compressed, never below 0.7, then overflows.
    await paintToken(page, 'plong', '0.95', null, '0.5000000000');
    out.long = await page.evaluate(overlayState, 'plong');
    await page.evaluate(() => window.FalsifyBoothPatch.remove('plong'));
    out.afterLongRemove = await page.evaluate(() => document.querySelectorAll('.booth-patch[data-patch-id="plong"]').length);

    // Resize the page box (a zoom or a wider column re-renders at another width), then repaint.
    await page.evaluate(([n, w]) => window.renderPage(n, w), [PAGE_NO, Math.round(PAGE_WIDTH * 1.4)]);
    out.resizedTable = await page.evaluate(findToken, ['0.95', null]);
    out.lostOnRender = await page.evaluate(() => document.querySelectorAll('.booth-patch').length);
    await page.evaluate(() => window.FalsifyBoothPatch.repaint(document.querySelector('.paper-page'), 4));
    out.repainted = await page.evaluate(overlayState, 'p095');
    out.repaintedRatio = out.repainted.fontSize / out.painted.fontSize;
    // Repainting for another page index leaves nothing behind in this page element.
    await page.evaluate(() => window.FalsifyBoothPatch.repaint(document.querySelector('.paper-page'), 7));
    out.otherPage = await page.evaluate(() => document.querySelectorAll('.booth-patch').length);
    await page.evaluate(() => window.FalsifyBoothPatch.repaint(document.querySelector('.paper-page'), 4));

    // CSS resize of the same page element: percent geometry follows; repaint refits the font.
    await page.evaluate(() => { const el = document.querySelector('.paper-page'); el.style.width = '500px'; el.style.height = (500 * 1.294) + 'px'; });
    await page.evaluate(() => window.FalsifyBoothPatch.repaint(document.querySelector('.paper-page'), 4));
    out.cssResized = await page.evaluate(overlayState, 'p095');
    [out.cssPageWidth, out.cssPageHeight] = await page.evaluate(() => { const r = document.querySelector('.paper-page').getBoundingClientRect(); return [r.width, r.height]; });

    await page.evaluate(() => window.FalsifyBoothPatch.remove('p095'));
    out.afterRemove = await page.evaluate(() => [...document.querySelectorAll('.booth-patch')].map(n => n.dataset.patchId));
    await page.evaluate(() => window.FalsifyBoothPatch.clear());
    out.afterClear = await page.evaluate(() => document.querySelectorAll('.booth-patch').length);
    out.repaintAfterClear = await page.evaluate(() => { window.FalsifyBoothPatch.repaint(document.querySelector('.paper-page'), 4); return document.querySelectorAll('.booth-patch').length; });
    out.errors = errors;
    return out;
  } finally {
    await page.close();
  }
}

function check(out) {
  const label = out.dpr + 'x ';
  const {painted, table} = out;
  assert.ok(painted, label + 'no overlay');
  sameRect(painted.rect, table.token, 1, label + 'overlay vs 0.95 box');
  near(table.measure.rect.x * out.view.width, table.span[0], 1, label + 'measure rect x');
  near(table.measure.rect.h * out.view.height, table.span[3], 1, label + 'measure rect h');
  assert.ok(table.measure.fontPx > 4 && table.measure.fontPx < 20, label + 'fontPx ' + table.measure.fontPx);
  assert.ok(table.measure.baselineFrac > 0.6 && table.measure.baselineFrac < 0.95, label + 'baselineFrac ' + table.measure.baselineFrac);
  assert.equal(table.measure.family, 'serif');
  assert.equal(painted.text, '0.50');
  assert.equal(painted.order[0], 'canvas');
  assert.equal(painted.order.at(-1), 'text', label + 'overlay must sit below the text layer');
  assert.ok(painted.order.includes('patch'));
  assert.equal(painted.pointer, 'none');
  assert.equal(painted.textPointer, 'none');
  assert.equal(painted.probeIsPatch, false, label + 'a tap on the patch reached the overlay');
  assert.match(painted.background, /^rgb\(2[45]\d, 2[45]\d, 2[45]\d\)$/, label + 'background ' + painted.background);
  assert.match(painted.family, /Times New Roman/);
  near(painted.fontSize, table.measure.fontPx, 0.01, label + 'patch font size');
  assert.equal(painted.weight, '700', label + 'the bold Ragas score must stay bold');
  assert.ok(out.bodyPainted && out.bodyPainted.text === 'WikiQA');
  assert.equal(out.bodyPainted.weight, '400', label + 'body text weight');
  sameRect(out.bodyPainted.rect, out.body.token, 1, label + 'body overlay vs WikiEval box');
  const scale = /matrix\(([\d.]+)/.exec(out.long.transform);
  assert.ok(scale && Math.abs(Number(scale[1]) - 0.7) < 0.001, label + 'long text scaleX ' + out.long.transform);
  assert.equal(out.afterLongRemove, 0);
  assert.equal(out.lostOnRender, 0, 'a fresh page element starts without patches');
  sameRect(out.repainted.rect, out.resizedTable.token, 1, label + 'repainted overlay vs resized 0.95 box');
  near(out.repaintedRatio, 1.4, 0.02, label + 'repainted font ratio');
  assert.equal(out.otherPage, 0);
  const k = out.cssPageWidth / out.resizedTable.page[0];
  const t = out.resizedTable.tokenRect;
  sameRect(out.cssResized.rect, [t.x * out.cssPageWidth, t.y * out.cssPageHeight, t.w * out.cssPageWidth, t.h * out.cssPageHeight], 1, label + 'css-resized overlay');
  near(out.cssResized.fontSize / out.repainted.fontSize, k, 0.02, label + 'css-resized font');
  assert.deepEqual(out.afterRemove, ['pbody']);
  assert.equal(out.afterClear, 0);
  assert.equal(out.repaintAfterClear, 0);
  assert.equal(out.errors.join('\n'), '');
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  if (shots) fs.mkdirSync(shots, {recursive: true});
  const server = serve();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    const one = await run(browser, 1);
    const three = await run(browser, 3);
    check(one);
    check(three);
    sameRect(three.painted.rect, one.painted.rect, 0.5, '1x vs 3x overlay');
    console.log('0.95 span', JSON.stringify(three.table.text), 'fontPx', three.table.measure.fontPx.toFixed(2),
      'baselineFrac', three.table.measure.baselineFrac.toFixed(3), 'overlay', three.painted.rect.map(v => v.toFixed(1)).join(','),
      'bg', three.painted.background, shots ? '· shots in FALSIFY_PATCH_SHOTS' : '');
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth patch browser passed'); }, error => {
  console.error(error && error.message);
  console.error(error);
  process.exit(1);
});
