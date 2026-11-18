'use strict';
// Pointer selection on a synthetic confusion-matrix page. No private PDF and no network.
const {spawnSync} = require('node:child_process');
const http = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'app/dist');
const localPython = 'C:\\Users\\user\\source\\falsify\\coordination\\ocr-chart-wave-20261103\\runtime\\Scripts\\python.exe';
const python = process.env.PYTHON_EXECUTABLE || process.env.FALSIFY_PYTHON || (fs.existsSync(localPython) ? localPython : 'python');
const probe = process.env.TEXT_SELECT_PROBE === '1';
const fixture = path.join(__dirname, 'fixtures', 'text_select_heatmap.py');

function pdfBytes() {
  const run = spawnSync(python, [fixture], {maxBuffer: 8 * 1024 * 1024});
  if (run.error || run.status !== 0) throw new Error(run.stderr?.toString() || run.error?.message || 'fixture failed');
  return run.stdout;
}

function browserPath() {
  let bundled = '';
  try { bundled = require('playwright').chromium.executablePath(); } catch {}
  return [
    process.env.BROWSER_EXECUTABLE,
    bundled,
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  ].find(candidate => candidate && fs.existsSync(candidate));
}

function serve() {
  const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream'};
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(dist + path.sep) || req.method !== 'GET') { res.writeHead(404).end(); return; }
      const bytes = await fs.promises.readFile(file);
      res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
      res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function spans(page) {
  return page.locator('#paper-before-stage .textLayer span[data-i]').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return {i: node.dataset.i, text: node.textContent, x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height};
  }));
}

function exact(list, text) {
  return list.filter(span => span.text === text);
}

function center(span) {
  return {x: (span.x + span.right) / 2, y: (span.y + span.bottom) / 2};
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, {steps: 14});
  await page.mouse.up();
}

async function outcome(page) {
  return page.evaluate(() => {
    const editors = [...document.querySelectorAll('.paper-page > textarea')];
    const status = document.querySelector('#paper-edit-status');
    return {
      branch: status?.dataset.branch || '',
      status: status?.textContent || '',
      editor: editors.at(-1)?.value || '',
      editors: editors.length,
      meta: document.querySelector('#paper-inline-meta')?.textContent || '',
    };
  });
}

async function closeEditor(page) {
  const open = await page.locator('.paper-page > textarea').count();
  if (open) await page.locator('.paper-page > textarea').last().press('Escape');
  await page.evaluate(() => { const status = document.querySelector('#paper-edit-status'); if (status) delete status.dataset.branch; });
}

async function charEdge(page, dataI, index, edge) {
  return page.locator(`#paper-before-stage .textLayer span[data-i="${dataI}"]`).evaluate((span, args) => {
    const node = [...span.childNodes].find(child => child.nodeType === 3);
    const range = document.createRange();
    range.setStart(node, args.index);
    range.setEnd(node, Math.min(args.index + 1, node.textContent.length));
    const rect = range.getBoundingClientRect();
    return {x: args.edge === 'right' ? rect.right - 0.5 : rect.left + 0.5, y: rect.top + rect.height / 2};
  }, {index, edge});
}

function expectAnchored(result, text) {
  assert.equal(result.branch, 'anchored', JSON.stringify(result));
  assert.equal(result.editor, text, JSON.stringify(result));
  assert.equal(result.status, '', JSON.stringify(result));
}

(async () => {
  const source = pdfBytes();
  assert.ok(source.length > 500 && source.length < 200000);
  const executable = browserPath();
  assert.ok(executable, 'Edge or Chromium is required');
  const {chromium} = require('playwright');
  const server = await serve();
  const browser = await chromium.launch({executablePath: executable, headless: true});
  const cases = [];
  let roundtrip = null;
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1600}, reducedMotion: 'reduce'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/cloud-config.js')) return route.fulfill({status: 200, contentType: 'text/javascript', body: 'globalThis.FalsifyCloudConfig=Object.freeze({apiBase:"https://example.invalid",provider:"confluence",hostedAi:Object.freeze({enabled:false,apiBase:""})});'});
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
      return route.abort();
    });
    await page.goto('http://127.0.0.1:' + server.address().port + '/');
    await page.locator('#paper-file').setInputFiles({name: 'heatmap.pdf', mimeType: 'application/pdf', buffer: source});
    await page.locator('#paper-before-stage .textLayer span[data-i]').first().waitFor({state: 'visible', timeout: 90000});
    await page.waitForFunction(() => /문단을 클릭|글 선택 편집은 사용할 수 있습니다/.test(document.querySelector('#paper-before-status')?.textContent || ''), null, {timeout: 90000});
    const listed = await spans(page);
    const runCell = exact(listed, '96%')[0];
    const repeated = exact(listed, '1%')[1];
    const paired = listed.find(span => span.text === '96% 1%');
    const tick = exact(listed, '0.2')[0];
    const row = exact(listed, 'Pulm. embolism')[0];
    const rightCell = exact(listed, '73%')[0];
    const gapCell = exact(listed, '44%')[0];
    const title = exact(listed, 'Ground truth disease')[0];
    const rotated = exact(listed, 'Pneumonia')[0];
    const otherFigure = exact(listed, '9%')[0];
    assert.ok(runCell && repeated && paired && tick && row && rightCell && gapCell && title && rotated && otherFigure, 'synthetic spans missing: ' + listed.map(span => span.text).join('|'));

    async function gesture(name, action) {
      await closeEditor(page);
      await action();
      const result = await outcome(page);
      cases.push({name, ...result});
      return result;
    }

    const one = await gesture('one-cell', async () => {
      const fresh = exact(await spans(page), '96%')[0];
      const at = center(fresh);
      await drag(page, {x: fresh.x + 2, y: at.y}, {x: fresh.right - 2, y: at.y});
    });
    const again = await gesture('repeated-1', async () => {
      const fresh = exact(await spans(page), '1%')[1];
      const at = center(fresh);
      await drag(page, {x: fresh.x + 1, y: at.y}, {x: fresh.right - 1, y: at.y});
    });
    const againPlace = await page.evaluate(() => {
      const editor = document.querySelector('.paper-page > textarea');
      const hits = [...document.querySelectorAll('#paper-before-stage .textLayer span')].filter(span => span.textContent === '1%').map(span => span.getBoundingClientRect());
      const box = editor ? editor.getBoundingClientRect() : null;
      return {editor: box && {x: box.left, y: box.top}, hits: hits.map(hit => ({x: hit.left, y: hit.top}))};
    });
    const half = await gesture('half-run', async () => {
      const fresh = (await spans(page)).find(span => span.text === '96% 1%');
      await drag(page, await charEdge(page, fresh.i, 0, 'left'), await charEdge(page, fresh.i, 2, 'right'));
    });
    const tickCase = await gesture('tick', async () => {
      const fresh = exact(await spans(page), '0.2')[0];
      const at = center(fresh);
      await drag(page, {x: fresh.x + 1, y: at.y}, {x: fresh.right - 1, y: at.y});
    });
    const rowCase = await gesture('row-label', async () => {
      const fresh = exact(await spans(page), 'Pulm. embolism')[0];
      await drag(page, await charEdge(page, fresh.i, 0, 'left'), await charEdge(page, fresh.i, fresh.text.length - 1, 'right'));
    });
    const across = await gesture('two-cells', async () => {
      const fresh = await spans(page);
      const left = exact(fresh, '96%')[0];
      const right = exact(fresh, '73%')[0];
      await drag(page, await charEdge(page, left.i, 0, 'left'), await charEdge(page, right.i, right.text.length - 1, 'right'));
    });
    const titleCase = await gesture('rotated-title', async () => {
      const fresh = exact(await spans(page), 'Ground truth disease')[0];
      await drag(page, {x: (fresh.x + fresh.right) / 2, y: fresh.y + 4}, {x: (fresh.x + fresh.right) / 2, y: fresh.bottom - 4});
    });
    const columnCase = await gesture('rotated-column', async () => {
      const fresh = exact(await spans(page), 'Pneumonia')[0];
      await drag(page, {x: (fresh.x + fresh.right) / 2, y: fresh.y + 3}, {x: (fresh.x + fresh.right) / 2, y: fresh.bottom - 3});
    });
    const gap = await gesture('gap', async () => {
      const fresh = exact(await spans(page), '44%')[0];
      const y = (fresh.y + fresh.bottom) / 2;
      await drag(page, {x: fresh.x - 6, y}, {x: fresh.right + 6, y});
    });
    const backwards = await gesture('backwards', async () => {
      const fresh = await spans(page);
      const left = exact(fresh, '96%')[0];
      const right = exact(fresh, '73%')[0];
      const y = (right.y + right.bottom) / 2;
      await drag(page, {x: right.right + 6, y}, {x: left.x + 1, y});
    });
    const figures = await gesture('two-figures', async () => {
      const fresh = await spans(page);
      await drag(page, center(exact(fresh, '44%')[0]), center(exact(fresh, '9%')[0]));
    });
    const doubled = await gesture('double-click', async () => {
      const fresh = exact(await spans(page), '96%')[0];
      const at = await charEdge(page, fresh.i, 2, 'right');
      await page.mouse.dblclick(at.x, at.y);
    });

    console.log(JSON.stringify({probe, errors, cases}, null, 2));
    if (probe) return;

    expectAnchored(one, '96%');
    expectAnchored(again, '1%');
    assert.ok(againPlace.editor && againPlace.hits.length > 1, JSON.stringify(againPlace));
    const againDistance = index => Math.hypot(againPlace.editor.x - againPlace.hits[index].x, againPlace.editor.y - againPlace.hits[index].y);
    assert.ok(againDistance(1) + 8 < againDistance(0), JSON.stringify(againPlace));
    assert.equal(half.branch, 'anchored', JSON.stringify(half));
    assert.equal(half.editor, '96%', JSON.stringify(half));
    expectAnchored(tickCase, '0.2');
    expectAnchored(rowCase, 'Pulm. embolism');
    assert.equal(across.branch, 'anchored', JSON.stringify(across));
    assert.match(across.editor, /96%/, JSON.stringify(across));
    assert.match(across.editor, /73%/, JSON.stringify(across));
    assert.equal(titleCase.branch, 'anchored', JSON.stringify(titleCase));
    assert.equal(titleCase.editor, 'Ground truth disease');
    assert.notEqual(columnCase.editor, '0.6', JSON.stringify(columnCase));
    assert.ok(columnCase.editor === 'Pneumonia' || columnCase.status.includes('회전된 글자'), JSON.stringify(columnCase));
    expectAnchored(gap, '44%');
    assert.equal(backwards.branch, 'anchored', JSON.stringify(backwards));
    assert.match(backwards.editor, /96%/, JSON.stringify(backwards));
    assert.doesNotMatch(backwards.status, /한 곳으로 확정하지 못해/);
    assert.equal(figures.branch, 'multi-region', JSON.stringify(figures));
    assert.equal(figures.status, '선택이 여러 영역에 걸쳐 있습니다. 한 영역 안에서 다시 선택하세요.');
    assert.equal(figures.editor, '');
    expectAnchored(doubled, '96%');
    assert.deepEqual(errors, []);

    await closeEditor(page);
    const target = exact(await spans(page), '96%')[0];
    const at = center(target);
    await drag(page, {x: target.x + 2, y: at.y}, {x: target.right - 2, y: at.y});
    const editor = page.locator('.paper-page > textarea').last();
    await editor.waitFor();
    const anchored = await outcome(page);
    assert.equal(anchored.editor, '96%');
    await editor.fill('69%');
    await page.locator('.paper-direct-controls').getByRole('button', {name: '완료', exact: true}).click();
    await page.waitForFunction(() => {
      const output = window.FalsifyPaperWorkspace?.getOutput?.();
      const status = document.querySelector('#paper-generate-status')?.textContent || '';
      return !!output || /생성하지 못했습니다|만들지 않았습니다|확인하세요/.test(status);
    }, null, {timeout: 120000});
    roundtrip = await page.evaluate(async () => {
      const output = window.FalsifyPaperWorkspace?.getOutput?.();
      const status = document.querySelector('#paper-generate-status')?.textContent || '';
      const editStatus = document.querySelector('#paper-edit-status')?.textContent || '';
      const edits = window.FalsifyPaperWorkspace?.getEditSnapshot?.()?.edits || [];
      if (!output?.file) return {ok: false, status, editStatus, edits: edits.map(edit => ({before: edit.before, after: edit.after}))};
      const bytes = [...new Uint8Array(await output.file.arrayBuffer())];
      return {ok: true, status, sha256: output.sha256, bytes, verification: output.verification?.status || ''};
    });
    if (roundtrip.ok) {
      const extracted = spawnSync(python, ['-c', 'import sys,pymupdf; doc=pymupdf.open(stream=sys.stdin.buffer.read(), filetype="pdf"); print(doc[0].get_text("text"))'], {input: Buffer.from(roundtrip.bytes)});
      const text = extracted.stdout.toString();
      roundtrip.text = text;
      delete roundtrip.bytes;
      assert.equal(extracted.status, 0, extracted.stderr.toString());
      assert.match(text, /69%/);
      assert.match(text, /96%/);
      assert.equal((text.match(/69%/g) || []).length, 1);
    }
    console.log(JSON.stringify({roundtrip: {...roundtrip, bytes: undefined}}, null, 2));
    if (!roundtrip.ok) console.log('ROUNDTRIP_UNAVAILABLE ' + JSON.stringify({status: roundtrip.status, editStatus: roundtrip.editStatus, edits: roundtrip.edits}));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
