'use strict';
// Relocation fuzz on the real mission paper (arXiv 2309.15217, CC BY 4.0). event.html draws every page so the
// workspace holds its layout, page and paragraph text; then, in node, every non-letter character of every layout
// or page view is changed to a digit the way a word tap or find-and-replace would (the booth's own widening), and
// the workspace's relocation (the code of dist/paper-workspace.js, run in a sandbox) is asked to move it onto a
// paragraph. A landing must keep its character and share at least one ink neighbour with the view, unless it is
// one of the listed superscript marks whose line the view moved. Every affiliation mark of page 1 (but the lone
// trailing ∗ of column 2, which has two equal readings) and every footnote digit must still relocate, and the
// fraction bars of page 3 (|V| / |S|, "||V S||" in the paragraph) must never move.
// The API is stubbed. FALSIFY_BOOTH_MISSION_PDF names a local copy of the paper.
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
const port = Number(process.env.BOOTH_RELOCATE_PORT || 8894);
const token = 'fsg_' + 'd'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);
const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*'};
const vm = require('node:vm');

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


/* The relocation functions of paper-workspace.js, from segmentKind up to widening, in a sandbox. */
function relocator(segments) {
  const code = fs.readFileSync(path.join(dist, 'paper-workspace.js'), 'utf8');
  const from = code.indexOf('    function segmentKind(id)');
  const to = code.indexOf('    function widening(api)');
  assert.ok(from > 0 && to > from, 'relocation block in paper-workspace.js');
  const body = 'const coreSegments=x=>Array.isArray(x)?x:[];' + code.slice(from, to) + ';return {repairEdit};';
  return vm.runInNewContext('(function(source){' + body + '})', {})({segments});
}

function occursOnce(text, part) { const at = text.indexOf(part); return at >= 0 && text.indexOf(part, at + 1) < 0; }
/* The booth's own widening (booth-recipe uniqueSpan): whole words both sides until unique in the segment. */
function uniqueSpan(text, start, end) {
  let from = start;
  let to = end;
  while (!occursOnce(text, text.slice(from, to)) && (from > 0 || to < text.length)) {
    from = Math.max(0, from - 1);
    while (from > 0 && !/\s/.test(text[from - 1])) from -= 1;
    to = Math.min(text.length, to + 1);
    while (to < text.length && !/\s/.test(text[to])) to += 1;
  }
  return {from, to};
}
const flat = text => text.replace(/\s+/g, ' ');
function inkAround(text, i, n) {
  const left = [];
  const right = [];
  for (let k = i - 1; k >= 0 && left.length < n; k--) if (!/\s/.test(text[k])) left.unshift(text[k]);
  for (let k = i + 1; k < text.length && right.length < n; k++) if (!/\s/.test(text[k])) right.push(text[k]);
  return {left, right};
}
function agree(a, b) {
  let l = 0;
  while (l < a.left.length && l < b.left.length && a.left[a.left.length - 1 - l] === b.left[b.left.length - 1 - l]) l++;
  let r = 0;
  while (r < a.right.length && r < b.right.length && a.right[r] === b.right[r]) r++;
  return Math.max(l, r);
}
/* Superscript marks the views print on their own line: the paragraph spot each lands on (12 characters each side). */
const MOVED_MARKS = [
  /Shahul Es\[†\], Jithin/, /Jithin James\[†\], Luis/, /Anke\[∗\]♢/, /Anke∗\[♢\], Steven/,
  /Ragas\[1\], a/, /OpenAI API\[2\]\./, /this step\[3\]:/, /^2 \[3\]$/, /as WikiEval\[4\]\./, /of 2022\[5\]\./,
];

function fuzz(segments, mode) {
  const W = relocator(segments);
  const pageCount = (page, needle) => {
    let n = 0;
    const want = flat(needle);
    for (const seg of segments) {
      if (seg.pageIndex !== page || !seg.id.startsWith('paragraph:')) continue;
      const text = flat(seg.text);
      for (let at = text.indexOf(want); at >= 0; at = text.indexOf(want, at + 1)) n++;
    }
    return n;
  };
  const rows = [];
  for (const seg of segments) {
    if (seg.id.startsWith('paragraph:')) continue;
    const text = seg.text;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (!/[^\s\p{L}]/u.test(c)) continue;
      let span;
      if (mode === 'token') {
        let s = i; while (s > 0 && !/\s/.test(text[s - 1])) s--;
        let e = i; while (e < text.length && !/\s/.test(text[e])) e++;
        if (e - s > 6) continue;
        span = uniqueSpan(text, s, e);
      } else span = uniqueSpan(text, i, i + 1);
      const before = text.slice(span.from, span.to);
      const after = text.slice(span.from, i) + (c === '1' ? '2' : '1') + text.slice(i + 1, span.to);
      const n = pageCount(seg.pageIndex, before);
      if (mode === 'token' && n === 1) continue;
      const edit = {id: 'x', segmentId: seg.id, pageIndex: seg.pageIndex, before, after, anchor: {start: span.from, end: span.to}};
      const out = W.repairEdit(edit, n ? 'AMBIGUOUS_MATCH' : 'NOT_FOUND', []);
      const row = {seg: seg.id, page: seg.pageIndex, i, c, view: text.slice(Math.max(0, i - 16), i) + '[' + c + ']' + text.slice(i + 1, i + 16)};
      if (!out || out.segmentId === seg.id) { rows.push(row); continue; }
      let k = 0;
      while (k < out.before.length && out.before[k] === out.after[k]) k++;
      const at = out.anchor.start + k;
      const pageSegs = segments.filter(s => s.pageIndex === seg.pageIndex && s.id.startsWith('paragraph:'));
      let off = 0;
      for (const s of pageSegs) { if (s.id === out.segmentId) break; off += s.text.length + 1; }
      const pageText = pageSegs.map(s => s.text).join('\n');
      const para = segments.find(s => s.id === out.segmentId).text;
      row.land = flat(para.slice(Math.max(0, at - 12), at) + '[' + para[at] + ']' + para.slice(at + 1, at + 13)).trim();
      row.wrong = para[at] !== c ? 'character' : agree(inkAround(text, i, 12), inkAround(pageText, off + at, 12)) >= 1 || MOVED_MARKS.some(re => re.test(row.land)) ? '' : 'context';
      rows.push(row);
    }
  }
  return rows;
}

async function missionSegments(browser) {
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, deviceScaleFactor: 1, locale: 'ko-KR'});
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  const base = 'http://127.0.0.1:' + port + '/';
  await page.route('**/*', route => (route.request().url().startsWith(base) ? route.continue() : stubApi(route)));
  await page.goto(base + 'event.html');
  await page.locator('#booth-missions .booth-mission').first().click();
  await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'edit');
  for (let n = 1; n <= 8; n++) {
    let ok = false;
    for (let tries = 0; tries < 6 && !ok; tries++) {
      await page.evaluate(number => globalThis.FalsifyPaperWorkspace.showPage(number), n);
      ok = await page.waitForFunction(number => (globalThis.FalsifyPaperWorkspace.getSource().segments || []).some(s => s.pageIndex === number - 1 && s.id.startsWith('paragraph:')), n, {timeout: 8000}).then(() => true, () => false);
    }
    assert.ok(ok, 'paragraphs of page ' + n);
  }
  const segments = await page.evaluate(() => globalThis.FalsifyPaperWorkspace.getSource().segments.map(s => ({id: s.id, pageIndex: s.pageIndex, text: s.text})));
  await context.close();
  return segments;
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    const segments = await missionSegments(browser);
    const report = [];
    for (const mode of ['token', 'character']) {
      const rows = fuzz(segments, mode);
      const moved = rows.filter(row => row.land);
      const wrong = moved.filter(row => row.wrong);
      report.push(mode + ': ' + rows.length + ' edits, ' + moved.length + ' moved, ' + wrong.length + ' wrong');
      assert.deepEqual(wrong.map(row => (row.page + 1) + ' ' + JSON.stringify(row.view) + ' -> ' + row.land), [], mode + ' landings');
      if (mode !== 'character') continue;
      const marks = rows.filter(row => row.page === 0 && /[†∗♢]/.test(row.c));
      const stayed = marks.filter(row => !row.land).map(row => row.seg + ' ' + JSON.stringify(row.view));
      assert.deepEqual(stayed, ['layout:p1:column2 ' + JSON.stringify(marks.find(row => row.seg === 'layout:p1:column2' && row.i === 3).view)], 'page-1 marks that stay');
      report.push('page-1 marks moved ' + (marks.length - stayed.length) + '/' + marks.length);
      for (const re of MOVED_MARKS) assert.ok(moved.some(row => re.test(row.land)), 'relocates onto ' + re);
      const bars = rows.filter(row => row.page === 2 && row.c === '|' && /\[\|\]\||\|\[\|\]/.test(row.land || ''));
      assert.deepEqual(bars.map(row => row.view + ' -> ' + row.land), [], 'fraction bars never move');
    }
    console.log(report.join('\n'));
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth relocate browser passed'); }, error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
