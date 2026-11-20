'use strict';
// Real Chromium check that paper-workspace page canvases are drawn at devicePixelRatio (pdf.js outputScale)
// while every overlay stays in CSS pixels. index.html is driven at deviceScaleFactor 1 and 3 with the same
// viewport; the backing store must be about 3x the CSS box, and paragraph, table-cell, text-layer, change-mark
// and figure-selection rectangles must land on the same CSS rectangles at both ratios.
// FALSIFY_BOOTH_MISSION_PDF names a local copy of arXiv 2309.15217 (CC BY 4.0). Every non-local request is aborted.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217 (the Ragas paper)');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
// Port 0 lets the OS pick a free port, so a server another checkout left running is never the one tested.
let base = '';
const pdfBytes = fs.readFileSync(pdfPath);
const pdfHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');
const TABLE_PAGE = 5;

function serve() {
  const child = spawn('python3', ['-m', 'http.server', '0', '--bind', '127.0.0.1'], {
    cwd: dist, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PYTHONUNBUFFERED: '1'},
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
      try { if (base && (await fetch(base + 'index.html')).ok) return; } catch { /* not yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('http.server did not start\n' + text);
  })();
  return {child, ready};
}

/* Rectangles relative to the page element, rounded to 0.01 CSS px. */
function relRects([selector, pageSelector]) {
  const pageEl = document.querySelector(pageSelector);
  const origin = pageEl.getBoundingClientRect();
  const round = n => Math.round(n * 100) / 100;
  return [...document.querySelectorAll(selector)].filter(node => !node.hidden).map(node => {
    const r = node.getBoundingClientRect();
    return [round(r.left - origin.left), round(r.top - origin.top), round(r.width), round(r.height)];
  });
}

function canvasBox(selector) {
  const canvas = document.querySelector(selector);
  if (!canvas) return null;
  const style = getComputedStyle(canvas);
  const border = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const r = canvas.getBoundingClientRect();
  const page = canvas.parentElement.getBoundingClientRect();
  return {width: canvas.width, height: canvas.height, cssWidth: r.width - border, cssHeight: r.height - borderY,
    left: r.left - page.left, top: r.top - page.top, dpr: devicePixelRatio};
}

async function figureSelection(page) {
  // The figure picker draws its page with FalsifyBlueVisual.previewBluePage into .visual-edit-frame and
  // positions .visual-edit-selection in percent of the PDF box (paper-visual-edit-ui paintOverlay).
  return page.evaluate(async ({b64, hash, pageNo}) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bytes], '2309.15217.pdf', {type: 'application/pdf'});
    const view = await window.FalsifyBlueVisual.previewBluePage({file, fileHash: hash, page: pageNo});
    const host = document.createElement('section');host.className = 'paper-visual-edit';
    const stage = document.createElement('div');stage.className = 'visual-edit-stage';
    const frame = document.createElement('div');frame.className = 'visual-edit-frame';
    const overlay = document.createElement('div');overlay.className = 'visual-edit-selection';
    const box = [view.width * 0.1, view.height * 0.2, view.width * 0.6, view.height * 0.45];
    overlay.style.left = (100 * box[0] / view.width) + '%';overlay.style.top = (100 * box[1] / view.height) + '%';
    overlay.style.width = (100 * (box[2] - box[0]) / view.width) + '%';overlay.style.height = (100 * (box[3] - box[1]) / view.height) + '%';
    frame.append(view.canvas, overlay);stage.append(frame);host.append(stage);document.body.prepend(host);
    const f = frame.getBoundingClientRect(), o = overlay.getBoundingClientRect(), round = n => Math.round(n * 100) / 100;
    const out = {frame: [round(f.width), round(f.height)], box: [round(o.left - f.left), round(o.top - f.top), round(o.width), round(o.height)]};
    host.remove();
    return out;
  }, {b64: pdfBytes.toString('base64'), hash: pdfHash, pageNo: TABLE_PAGE});
}

async function run(browser, dpr) {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}, deviceScaleFactor: dpr, locale: 'ko-KR'});
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  try {
    await page.goto(base + 'index.html');
    await page.setInputFiles('#paper-file', pdfPath);
    await page.waitForFunction(() => document.querySelectorAll('.paper-paragraph-button').length > 0);
    while (!(await page.locator('#paper-page-label').textContent()).startsWith(TABLE_PAGE + ' /')) await page.click('#paper-page-next');
    await page.waitForFunction(() => [...document.querySelectorAll('.paper-paragraph-button')].some(node => node.textContent.includes('0.95')));
    const out = {dpr, before: await page.evaluate(canvasBox, '#paper-before-stage .paper-canvas')};
    out.text = (await page.evaluate(relRects, ['#paper-before-stage .paper-text-layer span', '#paper-before-stage .paper-page'])).slice(0, 40);

    // Paragraph marker from the list, then a click on the page inside that box opens the same paragraph.
    await page.locator('.paper-paragraph-list > summary').click();
    // The Table 1 score paragraph, the booth mission's edit (same pick as event-theme-browser.spec.cjs).
    const index = await page.evaluate(() => {
      const hits = [...document.querySelectorAll('.paper-paragraph-button')].map((node, i) => ({i, text: node.textContent}))
        .filter(item => item.text.includes('0.95') && item.text.includes('0.78') && item.text.length <= 400);
      hits.sort((a, b) => a.text.length - b.text.length);
      return hits.length ? hits[0].i : -1;
    });
    assert.ok(index >= 0, 'Table 1 score paragraph not found');
    const button = page.locator('.paper-paragraph-button').nth(index);
    const expected = await button.textContent();
    await button.hover();
    out.marker = (await page.evaluate(relRects, ['#paper-before-stage .paper-paragraph-marker', '#paper-before-stage .paper-page']))[0];
    await page.mouse.move(0, 0);
    const pageBox = await page.locator('#paper-before-stage .paper-page').boundingBox();
    const [x, y, w, h] = out.marker;
    await page.mouse.click(pageBox.x + x + w / 2, pageBox.y + y + Math.min(h / 2, 12));
    const editor = page.locator('textarea[aria-label$="직접 편집"]');
    await editor.waitFor();
    out.editorValue = await editor.inputValue();
    out.expected = expected;
    out.editorRect = await editor.evaluate(node => { const r = node.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)]; });

    // Apply one edit and draw the generated preview so the after canvas and change marks are covered.
    await editor.fill(out.editorValue.replace('0.95', '0.50'));
    await page.locator('.paper-direct-controls').getByRole('button', {name: '완료', exact: true}).click();
    await page.waitForFunction(() => (document.querySelector('#paper-edits')?.textContent || '').includes('0.50'));
    if (await page.locator('#paper-generate').isEnabled()) await page.click('#paper-generate');
    await page.locator('#paper-after-stage .paper-canvas').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#paper-after-stage .paper-change-mark').length > 0);
    out.after = await page.evaluate(canvasBox, '#paper-after-stage .paper-canvas');
    out.afterMarks = await page.evaluate(relRects, ['#paper-after-stage .paper-change-mark', '#paper-after-stage']);
    out.beforeMarks = await page.evaluate(relRects, ['#paper-before-stage .paper-change-mark', '#paper-before-stage .paper-page']);

    // Table cells on the Table 1 page.
    await page.click('#paper-mode-table');
    await page.waitForFunction(() => document.querySelectorAll('.paper-table-cell').length > 0);
    out.table = await page.evaluate(canvasBox, '#paper-before-stage .paper-canvas');
    out.cells = await page.evaluate(relRects, ['.paper-table-cell', '#paper-before-stage .paper-page']);
    out.figure = await figureSelection(page);
    out.errors = errors;
    return out;
  } finally {
    await page.close();
  }
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, label + ': ' + actual + ' vs ' + expected);
}

function sameRects(a, b, label) {
  assert.equal(a.length, b.length, label + ' count');
  assert.ok(a.length > 0, label + ' is empty');
  a.forEach((rect, i) => rect.forEach((value, k) => near(value, b[i][k], 0.5, label + '[' + i + '][' + k + ']')));
}

function assertBacking(box, ratio, label) {
  assert.ok(box, label + ' canvas missing');
  near(box.width / box.cssWidth, ratio, 0.01, label + ' backing width ratio');
  near(box.height / box.cssHeight, ratio, 0.01, label + ' backing height ratio');
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    const one = await run(browser, 1);
    const three = await run(browser, 3);
    for (const [label, box] of [['before', one.before], ['after', one.after], ['table page', one.table]]) assertBacking(box, 1, '1x ' + label);
    for (const [label, box] of [['before', three.before], ['after', three.after], ['table page', three.table]]) assertBacking(box, 3, '3x ' + label);
    for (const key of ['before', 'after', 'table']) {
      for (const field of ['cssWidth', 'cssHeight', 'left', 'top']) near(three[key][field], one[key][field], 0.01, key + ' CSS ' + field);
    }
    assert.equal(three.editorValue, three.expected, 'page click opened another paragraph');
    assert.ok(three.expected.includes('0.95'));
    assert.equal(one.editorValue, three.editorValue);
    assert.deepEqual(three.editorRect, one.editorRect, 'direct editor moved');
    sameRects(three.marker ? [three.marker] : [], [one.marker], 'paragraph marker');
    sameRects(three.text, one.text, 'text layer');
    sameRects(three.cells, one.cells, 'table cells');
    sameRects(three.afterMarks, one.afterMarks, 'after change marks');
    if (one.beforeMarks.length || three.beforeMarks.length) sameRects(three.beforeMarks, one.beforeMarks, 'before change marks');
    assert.deepEqual(three.figure, one.figure, 'figure selection box moved');
    assert.equal(one.errors.concat(three.errors).join('\n'), '');
    console.log('3x backing', three.before.width + 'x' + three.before.height, 'for CSS', three.before.cssWidth + 'x' + three.before.cssHeight,
      '· cells', three.cells.length, '· after marks', three.afterMarks.length);
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('paper hidpi browser passed'); }, error => {
  console.error(error && error.message);
  console.error(error);
  process.exit(1);
});
