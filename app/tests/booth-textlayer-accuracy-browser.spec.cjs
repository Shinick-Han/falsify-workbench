'use strict';
// Measures DOM text-layer word accuracy against MuPDF ground-truth glyph boxes on event.html
// for mission paper arXiv 2309.15217 pages 1, 4 and 5 across three viewports:
//   - 390x844 at fit zoom (1x)
//   - 390x844 at mission zoom (~2.65x)
//   - 1280x800 desktop (1x)
//
// Asserts word-centre p95 < 3.0 pt, span-endpoint p95 < 1.0 pt, and zero words whose DOM centre
// falls outside their MuPDF box widened by 2 pt. Set ACCURACY_REPORT_ONLY=1 to print metrics only.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_ACCURACY_PORT || 19963);
const reportOnly = process.env.ACCURACY_REPORT_ONLY === '1';
const token = 'fsg_' + 'a'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);
const MUPDF_URL = pathToFileURL(path.resolve(dist, 'browser-pdf-vendor/mupdf.js')).href;
const PAGES = [1, 4, 5];
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const LIGATURES = new Map([
  ['\ufb00', 'ff'], ['\ufb01', 'fi'], ['\ufb02', 'fl'], ['\ufb03', 'ffi'], ['\ufb04', 'ffl'],
]);

function normalizeText(s) {
  let out = '';
  for (const ch of String(s || '')) out += LIGATURES.get(ch) || ch;
  return out;
}

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
      enabled: true, submissionsOpen: true, announcement: '', consentVersion: '2026-11-22.v3',
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

/* Extracts MuPDF lines (with per-character boxes) in top-left PDF points relative to page bounds. */
async function extractMuPdfPages(pageNumbers) {
  const mupdf = await import(MUPDF_URL);
  const doc = mupdf.Document.openDocument(new Uint8Array(pdfBytes), 'application/pdf');
  const out = new Map();
  try {
    for (const pageNum of pageNumbers) {
      const page = doc.loadPage(pageNum - 1);
      try {
        const bounds = page.getBounds();
        const bx0 = bounds[0], by0 = bounds[1];
        const pw = bounds[2] - bx0, ph = bounds[3] - by0;
        const st = page.toStructuredText();
        const lines = [];
        let cur = null;
        try {
          st.walk({
            beginLine(bbox, wmode, dir) {
              cur = {
                x0: bbox[0] - bx0, y0: bbox[1] - by0, x1: bbox[2] - bx0, y1: bbox[3] - by0,
                dir: [dir[0], dir[1]], text: '', charMap: [],
              };
            },
            onChar(c, _origin, _font, _size, quad) {
              if (!cur) return;
              const xs = [quad[0], quad[2], quad[4], quad[6]];
              const ys = [quad[1], quad[3], quad[5], quad[7]];
              const box = {
                x0: Math.min(...xs) - bx0, y0: Math.min(...ys) - by0,
                x1: Math.max(...xs) - bx0, y1: Math.max(...ys) - by0,
              };
              const norm = normalizeText(c);
              for (const ch of norm) {
                cur.text += ch;
                cur.charMap.push(box);
              }
            },
            endLine() {
              if (cur && cur.text.trim()) lines.push(cur);
              cur = null;
            },
          });
        } finally {
          st.destroy();
        }
        out.set(pageNum, {pw, ph, lines});
      } finally {
        page.destroy();
      }
    }
  } finally {
    doc.destroy();
  }
  return out;
}

/* Reads every token word rect (Range inside span[data-i]) as page fractions on the current rendered page. */
function collectDomWords(page) {
  return page.evaluate(() => {
    const pageEl = document.querySelector('#paper-before-stage > .paper-page');
    const pb = pageEl.getBoundingClientRect();
    const pe = globalThis.FalsifyBoothPageEdit;
    const spans = [...pageEl.querySelectorAll('.paper-text-layer span[data-i]')]
      .sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i));
    const words = [];
    const spanBoxes = [];
    for (const span of spans) {
      const text = span.textContent || '';
      if (!text.trim()) continue;
      const tokens = pe.tokensIn(text);
      const textNodes = [];
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      const rangeFor = (start, end) => {
        const range = document.createRange();
        let at = 0;
        let started = false;
        for (const node of textNodes) {
          const len = node.nodeValue.length;
          if (!started && start <= at + len) { range.setStart(node, start - at); started = true; }
          if (started && end <= at + len) { range.setEnd(node, end - at); return range; }
          at += len;
        }
        return started ? range : null;
      };
      const spanBox = span.getBoundingClientRect();
      const rot = parseFloat(span.style.getPropertyValue('--rotate')) || 0;
      if (text.trim().length >= 3 && Math.abs(rot) <= 1 && spanBox.width > 0 && spanBox.height > 0) {
        spanBoxes.push({
          text: text.trim(),
          fx0: (spanBox.left - pb.left) / pb.width,
          fy0: (spanBox.top - pb.top) / pb.height,
          fx1: (spanBox.right - pb.left) / pb.width,
          fy1: (spanBox.bottom - pb.top) / pb.height,
        });
      }
      for (const tok of tokens) {
        const range = rangeFor(tok.start, tok.end);
        if (!range) continue;
        const raw = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
        const list = raw.length ? raw : [range.getBoundingClientRect()].filter(r => r.width > 0 && r.height > 0);
        if (!list.length) continue;
        const left = Math.min(...list.map(r => r.left));
        const right = Math.max(...list.map(r => r.right));
        const top = Math.abs(rot) > 1 ? Math.min(...list.map(r => r.top)) : (spanBox.height > 0 ? spanBox.top : Math.min(...list.map(r => r.top)));
        const bottom = Math.abs(rot) > 1 ? Math.max(...list.map(r => r.bottom)) : (spanBox.height > 0 ? spanBox.bottom : Math.max(...list.map(r => r.bottom)));
        words.push({
          text: text.slice(tok.start, tok.end),
          rotated: Math.abs(rot) > 1,
          fx0: (left - pb.left) / pb.width,
          fy0: (top - pb.top) / pb.height,
          fx1: (right - pb.left) / pb.width,
          fy1: (bottom - pb.top) / pb.height,
        });
      }
    }
    return {zoom: globalThis.FalsifyPaperWorkspace.getZoom(), words, spanBoxes};
  });
}

/* Finds the matching MuPDF word box (in PDF points) for a DOM word rect on the same page. */
function matchMuPdfWord(domWord, muPage) {
  const needle = normalizeText(domWord.text);
  if (!needle) return null;
  const dx0 = domWord.fx0 * muPage.pw;
  const dy0 = domWord.fy0 * muPage.ph;
  const dx1 = domWord.fx1 * muPage.pw;
  const dy1 = domWord.fy1 * muPage.ph;
  const dcx = (dx0 + dx1) / 2;
  const dcy = (dy0 + dy1) / 2;
  const isWordChar = ch => /[A-Za-z0-9]/.test(ch);
  let best = null;
  for (const line of muPage.lines) {
    if (!domWord.rotated) {
      if (dcy < line.y0 - 12 || dcy > line.y1 + 12) continue;
    } else {
      if (dcx < line.x0 - 12 || dcx > line.x1 + 12) continue;
    }
    for (let at = line.text.indexOf(needle); at >= 0; at = line.text.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      const before = at > 0 ? line.text[at - 1] : '';
      const after = end < line.text.length ? line.text[end] : '';
      const wholeWord = (!isWordChar(needle[0]) || !isWordChar(before))
        && (!isWordChar(needle[needle.length - 1]) || !isWordChar(after));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = at; i < end; i += 1) {
        const b = line.charMap[i];
        if (b.x0 < x0) x0 = b.x0;
        if (b.y0 < y0) y0 = b.y0;
        if (b.x1 > x1) x1 = b.x1;
        if (b.y1 > y1) y1 = b.y1;
      }
      const mcx = (x0 + x1) / 2;
      const mcy = (y0 + y1) / 2;
      const dist = Math.hypot(dcx - mcx, dcy - mcy);
      if (dist > 40) continue;
      // Strongly prefer whole-word boundary matches so short words like "in" never match inside "line".
      const score = dist + (wholeWord ? 0 : 12);
      if (!best || score < best.score) {
        best = {score, dist, x0, y0, x1, y1, mcx, mcy, dcx, dcy, dx0, dy0, dx1, dy1, wholeWord};
      }
    }
  }
  return best;
}

function matchMuPdfSpanEndpointError(span, muPage) {
  const needle = normalizeText(span.text);
  if (!needle) return null;
  const dx0 = span.fx0 * muPage.pw;
  const dx1 = span.fx1 * muPage.pw;
  const dcy = ((span.fy0 + span.fy1) / 2) * muPage.ph;
  let best = null;
  for (const line of muPage.lines) {
    if (dcy < line.y0 - 12 || dcy > line.y1 + 12) continue;
    for (let at = line.text.indexOf(needle); at >= 0; at = line.text.indexOf(needle, at + 1)) {
      const mx0 = line.charMap[at].x0;
      const mx1 = line.charMap[at + needle.length - 1].x1;
      const err = Math.max(Math.abs(dx0 - mx0), Math.abs(dx1 - mx1));
      if (best === null || err < best) best = err;
    }
  }
  return best;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

async function openViewport(browser, spec) {
  const ctx = await browser.newContext(spec.context);
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000);
  const base = 'http://127.0.0.1:' + port + '/';
  await page.route('**/*', route => (route.request().url().startsWith(base) ? route.continue() : stubApi(route)));
  await page.goto(base + 'event.html');
  await page.locator('#booth-missions .booth-mission').first().click();
  await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'edit');
  await page.waitForFunction(() => /^5 \//.test(document.querySelector('#paper-page-label')?.textContent || '')
    && [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(n => n.textContent.trim() === '0.95'));
  if (spec.waitMissionZoom) {
    await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() > 2);
    await page.waitForTimeout(200);
  } else if (spec.fitZoom) {
    await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() > 2);
    await page.locator('#booth-pe-fit').click();
    await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1
      && !document.documentElement.classList.contains('booth-pe-zoomed'));
    await page.waitForTimeout(200);
  }
  return {ctx, page};
}

async function showPage(page, pageNum) {
  const current = await page.evaluate(() => (globalThis.FalsifyPaperWorkspace.getPageIndex() ?? -1) + 1);
  if (current === pageNum) return;
  await page.evaluate(n => globalThis.FalsifyPaperWorkspace.showPage(n), pageNum);
  await page.waitForFunction(
    n => new RegExp('^' + n + ' /').test(document.querySelector('#paper-page-label')?.textContent || '')
      && document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]').length > 20,
    pageNum,
  );
  await page.waitForTimeout(150);
}

async function measureViewport(browser, spec, muPages) {
  const {ctx, page} = await openViewport(browser, spec);
  const errors = [];
  const spanErrors = [];
  const outside = [];
  let totalDomWords = 0;
  let matchedWords = 0;
  let actualZoom = 1;
  try {
    for (const pageNum of PAGES) {
      await showPage(page, pageNum);
      if (spec.waitMissionZoom) {
        const z = await page.evaluate(() => globalThis.FalsifyPaperWorkspace.getZoom());
        if (z < 2) {
          await page.evaluate(() => globalThis.FalsifyPaperWorkspace.setZoom(2.65));
          await page.waitForTimeout(250);
        }
      }
      const {zoom, words, spanBoxes} = await collectDomWords(page);
      actualZoom = zoom;
      const muPage = muPages.get(pageNum);
      for (const s of spanBoxes) {
        const se = matchMuPdfSpanEndpointError(s, muPage);
        if (se !== null) spanErrors.push(se);
      }
      for (const w of words) {
        totalDomWords += 1;
        const m = matchMuPdfWord(w, muPage);
        if (!m) continue;
        matchedWords += 1;
        errors.push(m.dist);
        const isOut = m.dcx < m.x0 - 2 || m.dcx > m.x1 + 2 || m.dcy < m.y0 - 2 || m.dcy > m.y1 + 2;
        if (isOut) {
          outside.push({
            page: pageNum, text: w.text, dist: +m.dist.toFixed(2),
            domCenter: [+m.dcx.toFixed(2), +m.dcy.toFixed(2)],
            muBox: [+m.x0.toFixed(2), +m.y0.toFixed(2), +m.x1.toFixed(2), +m.y1.toFixed(2)],
          });
        }
      }
    }
  } finally {
    await ctx.close();
  }
  errors.sort((a, b) => a - b);
  spanErrors.sort((a, b) => a - b);
  return {
    name: spec.name,
    zoom: +actualZoom.toFixed(2),
    totalDomWords,
    matchedWords,
    median: +percentile(errors, 0.5).toFixed(3),
    p95: +percentile(errors, 0.95).toFixed(3),
    max: +(errors[errors.length - 1] || 0).toFixed(3),
    spanCount: spanErrors.length,
    spanMedian: +percentile(spanErrors, 0.5).toFixed(3),
    spanP95: +percentile(spanErrors, 0.95).toFixed(3),
    spanMax: +(spanErrors[spanErrors.length - 1] || 0).toFixed(3),
    outsideCount: outside.length,
    outsideSample: outside.slice(0, 10),
  };
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const muPages = await extractMuPdfPages(PAGES);
  const server = serve();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({
      executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const specs = [
      {name: '390-fit', fitZoom: true, context: {viewport: {width: 390, height: 844}, deviceScaleFactor: 3, hasTouch: true, isMobile: false, locale: 'ko-KR'}},
      {name: '390-mission', waitMissionZoom: true, context: {viewport: {width: 390, height: 844}, deviceScaleFactor: 3, hasTouch: true, isMobile: false, locale: 'ko-KR'}},
      {name: '1280-desk', context: {viewport: {width: 1280, height: 800}, deviceScaleFactor: 1, locale: 'ko-KR'}},
    ];
    const results = [];
    for (const spec of specs) {
      const stats = await measureViewport(browser, spec, muPages);
      results.push(stats);
      console.log(JSON.stringify(stats));
    }
    if (!reportOnly) {
      for (const r of results) {
        assert.ok(r.matchedWords >= r.totalDomWords * 0.95,
          `${r.name}: matched too few words (${r.matchedWords}/${r.totalDomWords})`);
        assert.ok(r.p95 < 3.0, `${r.name}: word-centre p95 error ${r.p95} pt >= 3.0 pt`);
        assert.ok(r.spanCount >= 200, `${r.name}: matched too few spans (${r.spanCount})`);
        assert.ok(r.spanP95 < 1.0, `${r.name}: span-endpoint p95 error ${r.spanP95} pt >= 1.0 pt`);
        assert.equal(r.outsideCount, 0,
          `${r.name}: ${r.outsideCount} word(s) outside MuPDF box + 2pt: ${JSON.stringify(r.outsideSample)}`);
      }
    }
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth textlayer accuracy browser passed'); }, error => {
  console.error(error && error.message);
  console.error(error && error.stack || error);
  process.exit(1);
});
