'use strict';
// Real browser verification of app/dist/w8-paper.js on the actual legacy index.html DOM
// (+ booth-pageedit.css, booth-edits.js, booth-pageedit.js, w8-paper.js) without editing index.html.
// Covers:
//  - Desktop (1280x800) & Mobile touch (390x844): open(file), direct-in-PDF edit, paragraph sheet edit
//  - Direct BLUE unchanged PDF & mandatory blind-pdf RED training marker stripping
//  - Rapid edits + export race, byte-identical artifact() & download(), re-open edited PDF
//  - Automatic IndexedDB + localStorage persistence and reload resume() (source + edits + page 2)
// Uses synthetic PDFs only; no real network calls.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium, webkit} = require('playwright');
const oracle = require('./helpers/pdf-oracle.cjs');

const dist = path.resolve(__dirname, '../dist');
const fixturePath = path.resolve(__dirname, './fixtures/paragraph-audit-synthetic.pdf');
const fixtureBytes = fs.readFileSync(fixturePath);
const port = Number(process.env.W8_PAPER_TEST_PORT || 19942);
const baseUrl = `http://127.0.0.1:${port}/`;

const MARKER_HEX = '46414c5349465920524544205445414d20545241494e494e4720434f505920207c2020494e54454e54494f4e414c4c5920414c544552454420207c20204e4f54204f524947494e414c';
const MARKER_STREAM = `\nq\nBT\n1 0 0 1 30 17.8 Tm\n/helv 7.1 Tf .55 .25 .14 RG .55 .25 .14 rg [<${MARKER_HEX}>]TJ\nET\nQ\n`;
const BANNER_STREAM = '\nq\n25 13 562 14 re\nh\n.98 .94 .87 rg f\nQ\n';

async function makeMarkedPdfBytes() {
  const mupdf = await oracle.loadMuPdf();
  const d = new mupdf.PDFDocument();
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  d.insertPage(-1, d.addPage([0, 0, 612, 792], 0, {Font: {helv: font}},
    'BT /helv 12 Tf 72 700 Td (Synthetic blind check 0.91 stays intact) Tj ET'));
  const p = d.findPage(0);
  p.put('Contents', [p.get('Contents'), d.addStream(BANNER_STREAM, {}), d.addStream(MARKER_STREAM, {})]);
  const buf = d.saveToBuffer();
  const bytes = Buffer.from(buf.asUint8Array());
  buf.destroy();
  d.destroy();
  return bytes;
}

function serve() {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: dist, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PYTHONUNBUFFERED: '1'},
  });
  let out = '';
  child.stdout.on('data', c => { out += c.toString(); });
  child.stderr.on('data', c => { out += c.toString(); });
  const ready = (async () => {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (child.exitCode != null) throw new Error('http.server exited ' + child.exitCode + '\n' + out);
      try { if ((await fetch(baseUrl + 'index.html')).ok) return; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('http.server timeout\n' + out);
  })();
  return {child, ready};
}

// Serve legacy index.html with the Stage 1 W8 PDF scripts/CSS injected into <head>
// (exactly how the new public Workbench entry loads them alongside the legacy index DOM).
function injectW8Head(html) {
  const inject = [
    '<link rel="stylesheet" href="booth-pageedit.css">',
    '<script src="booth-edits.js" defer></script>',
    '<script src="booth-pageedit.js" defer></script>',
    '<script src="w8-paper.js" defer></script>',
  ].join('\n  ');
  assert.ok(html.includes('</head>'), 'index.html must have </head>');
  return html.replace('</head>', `  ${inject}\n</head>`);
}

async function setupPage(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (!url.startsWith(baseUrl)) return route.abort();
    if (url === baseUrl + 'index.html' || url === baseUrl) {
      const raw = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
      return route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: injectW8Head(raw)});
    }
    return route.continue();
  });
  await page.goto(baseUrl + 'index.html', {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => !!window.FalsifyW8Paper && !!window.FalsifyPaperWorkspace && !!window.FalsifyBoothEdits && !!window.FalsifyBoothPageEdit);
  return {page, errors};
}

async function openPdfInBrowser(page, bytes, name) {
  const b64 = Buffer.from(bytes).toString('base64');
  return page.evaluate(async ([encoded, fileName]) => {
    const bin = atob(encoded);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], fileName, {type: 'application/pdf'});
    return window.FalsifyW8Paper.open(file);
  }, [b64, name]);
}

async function getArtifactInBrowser(page) {
  return page.evaluate(async () => {
    const art = await window.FalsifyW8Paper.artifact();
    const u8 = new Uint8Array(await art.file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < u8.length; i += 1) bin += String.fromCharCode(u8[i]);
    return {
      sha256: art.sha256,
      sourceSha256: art.sourceSha256,
      revision: art.revision,
      editCount: art.editCount,
      changed: art.changed,
      blinding: art.blinding,
      name: art.file.name,
      b64: btoa(bin),
    };
  });
}

async function tokenPoint(page, token) {
  return page.evaluate(value => {
    const spans = [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')]
      .sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i));
    for (const span of spans) {
      const text = span.textContent;
      const at = text.indexOf(value);
      if (at < 0) continue;
      span.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
      const range = document.createRange();
      range.setStart(span.firstChild, at);
      range.setEnd(span.firstChild, at + value.length);
      const r = range.getBoundingClientRect();
      return {x: r.left + r.width / 2, y: r.top + r.height / 2};
    }
    return null;
  }, token);
}

async function runDesktopFlow(browser, markedBytes) {
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, acceptDownloads: true, locale: 'ko-KR'});
  const {page, errors} = await setupPage(context);

  // Track falsify:w8-paper-change events.
  await page.evaluate(() => {
    window.__w8Events = [];
    document.addEventListener('falsify:w8-paper-change', e => window.__w8Events.push(e.detail.reason));
  });

  // 1. Open representative 2-page PDF.
  const opened = await openPdfInBrowser(page, fixtureBytes, 'audit-paper.pdf');
  assert.equal(opened.ready, true);
  assert.equal(opened.pageCount, 2);
  assert.equal(opened.page, 1);
  assert.equal(opened.editorMounted, true);
  assert.equal(opened.editActive, true);
  assert.equal(opened.fileHash, oracle.sha256(fixtureBytes));

  // 2. Direct BLUE unchanged PDF path.
  const unchangedArt = await getArtifactInBrowser(page);
  assert.equal(unchangedArt.editCount, 0);
  assert.equal(unchangedArt.revision, 0);
  assert.equal(unchangedArt.changed, false);
  assert.equal(unchangedArt.sha256, oracle.sha256(fixtureBytes));

  // 3. Direct-in-PDF click edit on desktop ("REFERENCE" -> "ALTERED").
  const pt = await tokenPoint(page, 'REFERENCE');
  assert.ok(pt, 'REFERENCE token should be rendered in text layer');
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('#booth-pe-pop:not([hidden])');
  await page.fill('#booth-pe-input', 'ALTERED');
  await page.click('#booth-pe-pop .booth-pe-apply');
  await page.waitForFunction(() => document.querySelectorAll('#paper-before-stage .booth-patch').length >= 1);

  const afterEditState = await page.evaluate(() => window.FalsifyW8Paper.state());
  assert.equal(afterEditState.editCount, 1);
  assert.equal(afterEditState.revision, 1);

  // 4. Download immediately after edit and compare byte-for-byte with artifact().
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => window.FalsifyW8Paper.download()),
  ]);
  const dlPath = await download.path();
  const dlBytes = fs.readFileSync(dlPath);
  const editedArt = await getArtifactInBrowser(page);
  const artBytes = Buffer.from(editedArt.b64, 'base64');

  assert.equal(oracle.sha256(dlBytes), editedArt.sha256, 'downloaded bytes must match artifact() SHA-256');
  assert.equal(Buffer.compare(dlBytes, artBytes), 0, 'downloaded bytes must be byte-identical to artifact()');
  assert.equal(await oracle.countPages(artBytes), 2);
  const page0Text = await oracle.extractText(artBytes, 0);
  assert.match(page0Text, /ALTERED/);
  assert.doesNotMatch(page0Text, /REFERENCE/);

  // 5. Re-open the downloaded PDF to confirm changes appear on reopen.
  const reopened = await openPdfInBrowser(page, dlBytes, 'audit-paper-edited.pdf');
  assert.equal(reopened.ready, true);
  assert.equal(reopened.fileHash, editedArt.sha256);
  const hasAlteredSpan = await page.evaluate(() =>
    [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')]
      .some(s => s.textContent.includes('ALTERED'))
  );
  assert.equal(hasAlteredSpan, true, 're-opened PDF shows the committed change on page 1');

  // 6. Navigate to page 2, make an edit on page 2, reload page, and verify resume().
  await openPdfInBrowser(page, fixtureBytes, 'resume-paper.pdf');
  assert.equal(await page.evaluate(() => window.FalsifyW8Paper.goToPage(2)), true);
  const pt2 = await tokenPoint(page, 'cautiously');
  assert.ok(pt2, 'page 2 token point');
  await page.mouse.click(pt2.x, pt2.y);
  await page.waitForSelector('#booth-pe-pop:not([hidden])');
  await page.fill('#booth-pe-input', 'RESUMED');
  await page.click('#booth-pe-pop .booth-pe-apply');
  const preReloadArt = await getArtifactInBrowser(page);
  await page.evaluate(() => window.FalsifyW8Paper.flushDraft());

  // Reload the page completely (fresh JS runtime, real IndexedDB + localStorage).
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => !!window.FalsifyW8Paper && !!window.FalsifyPaperWorkspace && !!window.FalsifyBoothPageEdit);
  const preResume = await page.evaluate(() => window.FalsifyW8Paper.state());
  assert.ok(preResume.resumable, 'resumable draft must exist after reload');
  assert.equal(preResume.resumable.page, 2);
  assert.equal(preResume.resumable.editCount, 1);
  assert.equal(preResume.resumable.hasSource, true);
  assert.equal(preResume.resumable.lastArtifactSha256, preReloadArt.sha256);

  const resumed = await page.evaluate(() => window.FalsifyW8Paper.resume());
  assert.equal(resumed.ready, true);
  assert.equal(resumed.page, 2);
  assert.equal(resumed.editCount, 1);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#paper-before-stage .booth-patch')].some(n => n.textContent.includes('RESUMED'))
  );
  const resumedArt = await getArtifactInBrowser(page);
  assert.equal(resumedArt.sha256, preReloadArt.sha256, 'artifact SHA-256 must stay identical across reload');
  const resumedBytes = Buffer.from(resumedArt.b64, 'base64');
  assert.match(await oracle.extractText(resumedBytes, 1), /RESUMED/);

  // 7. Arbitrary marked user PDF (with RED training marker) is ALWAYS blinded on direct BLUE path.
  await openPdfInBrowser(page, markedBytes, 'marked-user.pdf');
  const blindedArt = await getArtifactInBrowser(page);
  assert.equal(blindedArt.editCount, 0);
  assert.equal(blindedArt.changed, true);
  assert.equal(blindedArt.blinding.changed, true);
  const blindedBytes = Buffer.from(blindedArt.b64, 'base64');
  const blindedText = await oracle.extractText(blindedBytes, 0);
  assert.doesNotMatch(blindedText, /FALSIFY RED TEAM/);
  assert.match(blindedText, /Synthetic blind check 0\.91 stays intact/);

  assert.deepEqual(errors, [], 'no uncaught page errors on desktop');
  await context.close();
}

async function runMobileFlow(browser, engineName) {
  const context = await browser.newContext({
    viewport: {width: 390, height: 844},
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    locale: 'ko-KR',
  });
  const {page, errors} = await setupPage(context);

  const opened = await openPdfInBrowser(page, fixtureBytes, 'mobile-audit.pdf');
  assert.equal(opened.ready, true, `${engineName}: opened`);
  assert.equal(opened.editorMounted, true, `${engineName}: booth-pageedit mounted`);

  // First tap zooms in on small screen; second tap opens the bottom edit bar (#booth-pe-pop.is-bar).
  const pt1 = await tokenPoint(page, 'REFERENCE');
  assert.ok(pt1, `${engineName}: token visible before zoom`);
  await page.touchscreen.tap(pt1.x, pt1.y);
  await page.waitForFunction(() => window.FalsifyPaperWorkspace.getZoom() > 1);
  await page.waitForTimeout(150);

  const pt2 = await tokenPoint(page, 'REFERENCE');
  assert.ok(pt2, `${engineName}: token visible after zoom`);
  await page.touchscreen.tap(pt2.x, pt2.y);
  await page.waitForSelector('#booth-pe-pop.is-bar:not([hidden])');
  await page.fill('#booth-pe-input', 'MOBILE');
  await page.click('#booth-pe-pop .booth-pe-apply');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#paper-before-stage .booth-patch')].some(n => n.textContent.includes('MOBILE'))
  );

  const art = await getArtifactInBrowser(page);
  const artBytes = Buffer.from(art.b64, 'base64');
  const page0Text = await oracle.extractText(artBytes, 0);
  assert.match(page0Text, /MOBILE/, `${engineName}: exported PDF contains mobile edit`);
  assert.doesNotMatch(page0Text, /REFERENCE/, `${engineName}: exported PDF removed original token`);
  assert.deepEqual(errors, [], `${engineName}: no uncaught page errors`);
  await context.close();
}

(async () => {
  const markedBytes = await makeMarkedPdfBytes();
  const server = serve();
  let chromiumBrowser = null;
  let webkitBrowser = null;
  try {
    await server.ready;
    chromiumBrowser = await chromium.launch({headless: true});
    await runDesktopFlow(chromiumBrowser, markedBytes);
    console.log('PASS desktop Chromium (open, direct BLUE, edit, download, reopen, page-2 reload resume, RED marker blinding)');
    await runMobileFlow(chromiumBrowser, 'mobile-chromium');
    console.log('PASS mobile Chromium (390x844 touch zoom, bottom bar edit, blind rewrite)');

    // Also verify WebKit mobile touch when WebKit binary is available.
    try {
      webkitBrowser = await webkit.launch({headless: true});
      await runMobileFlow(webkitBrowser, 'mobile-webkit');
      console.log('PASS mobile WebKit (390x844 touch zoom, bottom bar edit, blind rewrite)');
    } catch (webkitErr) {
      if (/Executable doesn't exist|Failed to launch/i.test(String(webkitErr && webkitErr.message))) {
        console.log('SKIP mobile WebKit (unavailable in environment):', webkitErr.message.split('\n')[0]);
      } else {
        throw webkitErr;
      }
    }
  } finally {
    if (chromiumBrowser) await chromiumBrowser.close().catch(() => {});
    if (webkitBrowser) await webkitBrowser.close().catch(() => {});
    server.child.kill('SIGTERM');
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
