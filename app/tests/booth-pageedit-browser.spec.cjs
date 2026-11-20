'use strict';
// Real Chromium walk of in-place page editing on event.html (booth-pageedit.js + FalsifyBoothEdits)
// on the Ragas mission (arXiv 2309.15217, page 5 Table 1 + caption, and page 1 arXiv stamp).
// Asserts FalsifyBoothEdits store contents and .booth-patch overlays only (generator is tested separately).
// Covers phone (390x844 touch DPR 3), desktop (1280x800 mouse) and tablet (1280x800 touch DPR 2).
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_PAGEEDIT_PORT || 19910);
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
    enabled: true, submissionsOpen: true, announcement: '', consentVersion: '2026-11-22.v3',
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

let lastPage = null;
async function diagnose() {
  if (!lastPage || lastPage.isClosed()) return null;
  return lastPage.evaluate(() => ({
    step: document.documentElement.dataset.boothStep,
    zoom: globalThis.FalsifyPaperWorkspace?.getZoom?.(),
    label: document.querySelector('#paper-page-label')?.textContent || '',
    popHidden: document.querySelector('#booth-pe-pop')?.hidden,
    sheetHidden: document.querySelector('#booth-pe-sheet')?.hidden,
    storeEdits: globalThis.FalsifyBoothEdits?.list?.() || [],
    patches: [...document.querySelectorAll('#paper-before-stage .booth-patch')].map(n => ({id: n.dataset.editId, text: n.textContent})),
  })).catch(() => null);
}

function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

function storeEdits(page) {
  return page.evaluate(() => globalThis.FalsifyBoothEdits.list());
}

function overlays(page) {
  return page.evaluate(() => [...document.querySelectorAll('#paper-before-stage .paper-page .booth-patch')].map(node => {
    const r = node.getBoundingClientRect();
    return {
      editId: node.dataset.editId,
      text: node.textContent,
      left: r.left, top: r.top, width: r.width, height: r.height,
      bg: getComputedStyle(node).backgroundColor,
      events: getComputedStyle(node).pointerEvents,
    };
  }));
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
    && [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(node => node.textContent.trim() === '0.95'));
  if (!wide) {
    await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() > 2
      && document.querySelector('#paper-before-stage .paper-page > canvas')?.getBoundingClientRect().width > 700);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return {page, errors};
}

function tokenPoint(page, token, nth = 0) {
  return page.evaluate(([value, n]) => {
    const spans = [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')]
      .sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i));
    const hits = [];
    for (const span of spans) {
      const text = span.textContent;
      for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
        const edge = i => i < 0 || i >= text.length || /[\s,.;:()"]/.test(text[i]);
        if (edge(at - 1) && edge(at + value.length)) hits.push({span, at});
      }
    }
    const hit = hits[n];
    if (!hit) return null;
    const stage = document.getElementById('paper-before-stage');
    if (stage.scrollHeight > stage.clientHeight || stage.scrollWidth > stage.clientWidth) {
      stage.scrollIntoView({block: 'center', behavior: 'instant'});
      const box = stage.getBoundingClientRect();
      const range0 = document.createRange();
      range0.setStart(hit.span.firstChild, hit.at);
      range0.setEnd(hit.span.firstChild, hit.at + value.length);
      const first = range0.getBoundingClientRect();
      if (stage.scrollWidth > stage.clientWidth) {
        stage.scrollLeft += first.left + first.width / 2 - (box.left + box.width / 2);
      }
      if (stage.scrollHeight > stage.clientHeight) {
        stage.scrollTop += first.top + first.height / 2 - (box.top + box.height / 2);
      }
    } else {
      hit.span.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
    }
    const range = document.createRange();
    range.setStart(hit.span.firstChild, hit.at);
    range.setEnd(hit.span.firstChild, hit.at + value.length);
    const r = range.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height};
  }, [token, nth]);
}

async function tapToken(page, wide, token, nth = 0, offset = {x: 0, y: 0}) {
  if (!wide && await page.evaluate(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1)) {
    const first = await tokenPoint(page, token, nth);
    assert.ok(first, 'token visible before zoom: ' + token);
    await tapAt(page, wide, first.x, first.y);
    await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() > 1);
    await page.waitForTimeout(200);
  }
  const pt = await tokenPoint(page, token, nth);
  assert.ok(pt, 'token on page: ' + token + ' #' + nth);
  await tapAt(page, wide, pt.x + offset.x, pt.y + offset.y);
  return pt;
}

/* Phone hint zoom fits Table 1 across the column without getPageParagraphs; zoom buttons step cleanly. */
async function checkZoomAndHint(page, wide) {
  assert.equal(await page.locator('#booth-pe-zoom-in').isVisible(), true);
  assert.equal(await page.locator('#booth-pe-zoom-out').isVisible(), true);
  if (!wide) {
    const fit = await page.evaluate(() => {
      const span = text => [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].find(node => node.textContent.trim() === text).getBoundingClientRect();
      const stage = document.getElementById('paper-before-stage').getBoundingClientRect();
      return {zoom: globalThis.FalsifyPaperWorkspace.getZoom(), ragas: span('Ragas'), last: span('0.70'), head: span('Faith.'),
        stage: {left: stage.left, right: stage.right, top: stage.top}, width: innerWidth};
    });
    assert.ok(fit.zoom > 2 && fit.zoom <= 3.5, 'phone hint zoom fits Table 1: ' + JSON.stringify(fit));
    assert.ok(fit.ragas.left >= Math.max(0, fit.stage.left) && fit.last.right <= Math.min(fit.width, fit.stage.right), 'Table 1 in view: ' + JSON.stringify(fit));
    assert.equal(await page.locator('#booth-pe-fit').isVisible(), true, '전체 쪽 shown while zoomed');
    await page.locator('#booth-pe-fit').click();
    await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1
      && !document.documentElement.classList.contains('booth-pe-zoomed'));
    assert.equal(await page.locator('#booth-pe-fit').isVisible(), false);
  }
  const firstStep = wide ? 1.25 : 1.5;
  await page.locator('#booth-pe-zoom-in').click();
  await page.waitForFunction(v => globalThis.FalsifyPaperWorkspace.getZoom() === v, firstStep);
  assert.equal(await page.locator('#booth-pe-fit').isVisible(), true);
  await page.locator('#booth-pe-zoom-out').click();
  await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1
    && !document.documentElement.classList.contains('booth-pe-zoomed'));
  assert.equal(await page.locator('#booth-pe-zoom-out').isDisabled(), true);
}

/* Tap editing: new edit, repeated token, re-edit in place, revert removes edit, deletion '', overlay survives zoom & page turn. */
async function tapFlow(page, wide, isTouch) {
  const pop = page.locator('#booth-pe-pop');
  const input = page.locator('#booth-pe-input');
  const apply = pop.getByRole('button', {name: '바꾸기', exact: true});

  // Tap 0.95 (on phone: first tap zooms to 3.5x on table, second tap opens bar)
  await tapToken(page, wide, '0.95', 0);
  await pop.waitFor({state: 'visible'});
  assert.equal(await input.inputValue(), '0.95');
  assert.equal(await input.getAttribute('inputmode'), 'decimal');
  assert.equal(await pop.getByRole('button', {name: '문단 전체 고치기'}).isDisabled(), false, 'paragraph button always enabled');
  assert.equal(await pop.getByRole('button', {name: '원래대로'}).isVisible(), false, 'revert button hidden for unedited word');
  assert.equal(await pop.evaluate(n => n.classList.contains('is-bar')), isTouch);
  if (isTouch) {
    assert.equal(await page.locator('#booth-dock').isVisible(), false, 'dock hidden while touch bar open');
    // Touch word stepping ‹ ›
    await pop.locator('.booth-pe-next').click();
    await page.waitForFunction(() => document.querySelector('#booth-pe-input').value === '0.78');
    await pop.locator('.booth-pe-prev').click();
    await page.waitForFunction(() => document.querySelector('#booth-pe-input').value === '0.95');
    // Soft keyboard visualViewport lifts the bar
    await page.evaluate(() => {
      const fake = new EventTarget();
      Object.assign(fake, {width: innerWidth, height: innerHeight - 300, offsetTop: 0, offsetLeft: 0, scale: 1});
      Object.defineProperty(window, 'visualViewport', {value: fake, configurable: true});
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(() => document.querySelector('#booth-pe-pop').style.bottom === '300px');
    await page.evaluate(() => { delete window.visualViewport; window.dispatchEvent(new Event('resize')); });
    await page.waitForFunction(() => document.querySelector('#booth-pe-pop').style.bottom === '0px');
  } else {
    // Desktop: Esc closes and refocuses stage
    await page.keyboard.press('Escape');
    assert.equal(await pop.isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'paper-before-stage');
    await tapToken(page, wide, '0.95', 0);
    await pop.waitFor({state: 'visible'});
  }

  // Replace 0.95 -> 0.50
  await input.fill('0.50');
  if (!isTouch) await page.keyboard.press('Enter');
  else await apply.click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-pop').hidden);

  let edits = await storeEdits(page);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].pageIndex, 4);
  assert.equal(edits[0].originalText, '0.95');
  assert.equal(edits[0].newText, '0.50');
  assert.equal(edits[0].source, 'tap');
  assert.ok(edits[0].rects.length >= 1 && edits[0].rects[0].w > 0 && edits[0].rects[0].h > 0);

  let patches = await overlays(page);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].editId, edits[0].id);
  assert.equal(patches[0].text, '0.50');
  assert.equal(patches[0].bg, 'rgb(255, 255, 255)');
  assert.equal(patches[0].events, 'none');

  // Repeated token: tap the second 0.52 -> 0.11
  await tapToken(page, wide, '0.52', 1);
  await pop.waitFor({state: 'visible'});
  assert.equal(await input.inputValue(), '0.52');
  await input.fill('0.11');
  await apply.click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-pop').hidden);

  edits = await storeEdits(page);
  assert.equal(edits.length, 2);
  assert.deepEqual(edits.map(e => [e.originalText, e.newText]), [['0.95', '0.50'], ['0.52', '0.11']]);
  // Second 0.52 sits lower than 0.95 on page 5
  assert.ok(edits[1].rects[0].y > edits[0].rects[0].y, 'second 0.52 rect is below 0.95');

  // Tapping an existing edit (0.95 -> 0.50) edits it in place
  await tapToken(page, wide, '0.95', 0);
  await pop.waitFor({state: 'visible'});
  assert.equal(await input.inputValue(), '0.50', 'existing edit prefilled with newText');
  await input.fill('0.42');
  await apply.click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-pop').hidden);

  edits = await storeEdits(page);
  assert.equal(edits.length, 2, 'updated in place, count unchanged');
  assert.equal(edits[0].newText, '0.42');
  patches = await overlays(page);
  assert.deepEqual(patches.map(p => p.text).sort(), ['0.11', '0.42']);

  // Overlay survives page turn (page 5 -> page 6 -> page 5) and zoom changes
  await page.locator('#paper-page-next').click();
  await page.waitForFunction(() => /^6 \//.test(document.querySelector('#paper-page-label').textContent)
    && !!document.querySelector('#paper-before-stage .paper-page canvas')
    && !document.querySelector('#paper-before-stage .booth-patch'));
  assert.equal((await overlays(page)).length, 0, 'page 6 has no overlays');
  await page.locator('#paper-page-prev').click();
  await page.waitForFunction(() => /^5 \//.test(document.querySelector('#paper-page-label').textContent)
    && [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(n => n.textContent.trim() === '0.95'));
  await page.waitForFunction(() => document.querySelectorAll('#paper-before-stage .booth-patch').length === 2);
  assert.deepEqual((await overlays(page)).map(p => p.text).sort(), ['0.11', '0.42']);

  // Reverting an edit back to originalText removes it and its overlay
  await tapToken(page, wide, '0.95', 0);
  await pop.waitFor({state: 'visible'});
  assert.equal(await pop.getByRole('button', {name: '원래대로'}).isVisible(), true, 'revert button visible for edited word');
  await input.fill('0.95');
  await apply.click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-pop').hidden);
  edits = await storeEdits(page);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].newText, '0.11');
  assert.equal((await overlays(page)).length, 1);

  // P1-1: Tapping the remaining edited word (second 0.52 -> 0.11) and pressing 「원래대로」 removes it from the store
  await tapToken(page, wide, '0.52', 1);
  await pop.waitFor({state: 'visible'});
  const revertBtn = pop.getByRole('button', {name: '원래대로', exact: true});
  assert.equal(await revertBtn.isVisible(), true, '원래대로 button shown for existing edit');
  await revertBtn.click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-pop').hidden);
  assert.equal((await storeEdits(page)).length, 0, '원래대로 removes edit from store');
  assert.equal((await overlays(page)).length, 0, '원래대로 removes edit overlay');

  // Removing via store clears the overlay immediately (stateless store-driven preview)
  await page.evaluate(() => globalThis.FalsifyBoothEdits.clear());
  assert.equal((await overlays(page)).length, 0);
}

/* Paragraph editing ("문단 전체 고치기"): clustering, existing edit substitution, line trim and full deletion. */
async function paragraphFlow(page, wide) {
  const pop = page.locator('#booth-pe-pop');
  const input = page.locator('#booth-pe-input');
  const sheet = page.locator('#booth-pe-sheet');
  const area = page.locator('#booth-pe-sheet-text');
  const sheetApply = sheet.getByRole('button', {name: '바꾸기', exact: true});

  // First make a tap edit inside Table 1 caption ("WikEval" -> "MyBench")
  await tapToken(page, wide, 'WikEval', 0);
  await pop.waitFor({state: 'visible'});
  await input.fill('MyBench');
  await pop.getByRole('button', {name: '바꾸기', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-pop').hidden);
  assert.equal((await storeEdits(page)).length, 1);

  // Tap "Agreement" on line 1 of Table 1 caption and open "문단 전체 고치기"
  await tapToken(page, wide, 'Agreement', 0);
  await pop.waitFor({state: 'visible'});
  await pop.getByRole('button', {name: '문단 전체 고치기'}).click();
  await sheet.waitFor({state: 'visible'});
  assert.equal(await pop.isVisible(), false);

  const prefill = await area.inputValue();
  const lines = prefill.split('\n');
  assert.equal(lines.length, 3, 'Table 1 caption clustered into exactly 3 lines: ' + JSON.stringify(lines));
  assert.match(lines[0], /^Table 1: Agreement with human annotators/);
  assert.match(lines[2], /MyBench/, 'existing tap edit inside block is substituted into prefill');
  assert.ok(!prefill.includes('0.95'), 'table above does not leak into caption');
  assert.ok(!prefill.includes('Answer Relevancy'), 'right column does not leak into caption');

  // Edit line 1 and revert MyBench -> WikEval on line 2: line 0 & 2 trim, old tap edit on line 2 is removed, leaving only line 1!
  const edited = [lines[0], lines[1].replace('faithfulness', 'accuracy'), lines[2].replace('MyBench', 'WikEval')].join('\n');
  await area.fill(edited);
  await sheetApply.click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-sheet').hidden);

  let edits = await storeEdits(page);
  assert.equal(edits.length, 1, 'reverted line-2 edit removed and only changed line-1 edit stored');
  assert.equal(edits[0].source, 'paragraph');
  assert.equal(edits[0].rects.length, 1, 'unchanged leading and trailing lines trimmed to 1 rect');
  assert.match(edits[0].originalText, /faithfulness/);
  assert.match(edits[0].newText, /accuracy/);
  assert.equal((await overlays(page)).length, 1);

  // Full deletion of Table 1 caption -> newText '' covering all 3 caption lines
  await tapToken(page, wide, 'Agreement', 0);
  await pop.waitFor({state: 'visible'});
  await pop.getByRole('button', {name: '문단 전체 고치기'}).click();
  await sheet.waitFor({state: 'visible'});
  await area.fill('');
  await sheetApply.click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-sheet').hidden);

  edits = await storeEdits(page);
  assert.equal(edits.length, 1, 'full-block deletion replaces the overlapping single-line edit');
  assert.equal(edits[0].source, 'paragraph');
  assert.equal(edits[0].rects.length, 3, 'all 3 caption lines covered');
  assert.equal(edits[0].newText, '', 'deleting everything gives empty newText');
  const patches = await overlays(page);
  assert.equal(patches.length, 3, 'all 3 caption rects covered by white overlays');
  assert.deepEqual(patches.map(p => p.text), ['', '', '']);

  // Page 5 left-column body paragraph ("randomly"): stays in left column, no right-column or prompt-box bleed,
  // and changed-range edit covers at most 2 lines inside the left column.
  await page.evaluate(() => globalThis.FalsifyBoothEdits.clear());
  await tapToken(page, wide, 'randomly', 0);
  await pop.waitFor({state: 'visible'});
  await pop.getByRole('button', {name: '문단 전체 고치기'}).click();
  await sheet.waitFor({state: 'visible'});
  const bodyPrefill = await area.inputValue();
  assert.ok(bodyPrefill.includes('Ties, where') && bodyPrefill.includes('broken randomly.'), 'sheet holds tapped left-column paragraph: ' + JSON.stringify(bodyPrefill));
  assert.ok(!bodyPrefill.includes('has shown') && !bodyPrefill.includes('closely aligned'), 'right column must not leak into paragraph sheet');
  assert.ok(!bodyPrefill.includes('Faithfulness measures') && !bodyPrefill.includes('answer: [answer]'), 'prompt box must not leak into paragraph sheet');
  await area.fill(bodyPrefill.replace('broken randomly', 'broken deterministically'));
  await sheetApply.click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-sheet').hidden);

  edits = await storeEdits(page);
  assert.equal(edits.length, 1, 'changed-range paragraph edit emits one BoothEdit');
  assert.equal(edits[0].source, 'paragraph');
  assert.equal(edits[0].originalText, 'randomly.');
  assert.equal(edits[0].newText, 'deterministically.');
  assert.ok(edits[0].rects.length >= 1 && edits[0].rects.length <= 2, 'paragraph edit covers at most 2 lines: ' + JSON.stringify(edits[0].rects));
  for (const r of edits[0].rects) {
    assert.ok(r.x >= 0.1 && r.x < 0.5 && r.x + r.w <= 0.53, 'paragraph edit rect lies inside the left column: ' + JSON.stringify(r));
  }
}

/* Previously refused areas (arXiv side stamp on page 1) are now freely editable with zero blocking messages. */
async function noRefusalFlow(page, wide) {
  await page.evaluate(() => {
    globalThis.FalsifyBoothEdits.clear();
    globalThis.FalsifyPaperWorkspace.showPage(1);
  });
  await page.waitForFunction(() => /^1 \//.test(document.querySelector('#paper-page-label').textContent)
    && [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(n => n.textContent.includes('arXiv:2309.15217v2')));
  await tapToken(page, wide, 'arXiv:2309.15217v2', 0);
  const pop = page.locator('#booth-pe-pop');
  await pop.waitFor({state: 'visible'});
  const input = page.locator('#booth-pe-input');
  assert.equal(await input.isDisabled(), false, 'arXiv stamp is editable (no notText refusal)');
  assert.equal(await pop.getByRole('button', {name: '바꾸기', exact: true}).isDisabled(), false);
  assert.equal(await pop.getByRole('button', {name: '문단 전체 고치기'}).isDisabled(), false);
  await input.fill('arXiv:0000.00000v1');
  await pop.getByRole('button', {name: '바꾸기', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('#booth-pe-pop').hidden);
  const edits = await storeEdits(page);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].pageIndex, 0);
  assert.equal(edits[0].newText, 'arXiv:0000.00000v1');
}

/* Phone race: touching the bar while loading cancels the hint zoom. */
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
    if (new URL(url).pathname === '/v1/papers/pdf') await new Promise(resolve => setTimeout(resolve, 1500));
    return stubApi(route);
  });
  await page.goto(base + 'event.html');
  await page.locator('#booth-missions .booth-mission').first().click();
  await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'edit');
  const bar = await page.locator('#booth-pe-bar').boundingBox();
  await page.touchscreen.tap(bar.x + 20, bar.y + bar.height / 2);
  await page.waitForFunction(() => /^5 \//.test(document.querySelector('#paper-page-label')?.textContent || '')
    && [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(n => n.textContent.trim() === '0.95'));
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => globalThis.FalsifyPaperWorkspace.getZoom()), 1, 'user touch cancels hint zoom');
  assert.equal(errors.join('\n'), '');
  await context.close();
}

async function walk(browser, wide, tablet = false) {
  const isTouch = !wide || tablet;
  const {page, errors} = await openMission(browser, wide, tablet);
  await checkZoomAndHint(page, wide);
  await tapFlow(page, wide, isTouch);
  await paragraphFlow(page, wide);
  await noRefusalFlow(page, wide);
  if (!wide) {
    await page.setViewportSize({width: 360, height: 780});
    assert.ok(await overflow(page) <= 0, '360px phone has no horizontal overflow');
  } else if (!tablet) {
    // Desktop hover hairline
    await page.evaluate(() => globalThis.FalsifyPaperWorkspace.showPage(5));
    await page.waitForFunction(() => /^5 \//.test(document.querySelector('#paper-page-label').textContent)
      && [...document.querySelectorAll('#paper-before-stage .paper-text-layer span[data-i]')].some(n => n.textContent.trim() === '0.95'));
    const s = await tokenPoint(page, '0.95', 0);
    await page.mouse.move(s.x, s.y);
    await page.locator('#paper-before-stage .booth-pe-hover').waitFor({timeout: 2000});
  } else {
    assert.ok(await overflow(page) <= 0, 'tablet has no horizontal overflow');
  }
  assert.equal(errors.join('\n'), '');
  await page.context().close();
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    await walk(browser, true, false);
    await walk(browser, false, false);
    await walk(browser, true, true);
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
