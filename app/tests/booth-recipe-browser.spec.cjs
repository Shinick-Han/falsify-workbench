'use strict';
// Real Chromium walk of the booth recipe, find-and-replace, two-tab UI and automatic cropped
// send-step change preview on event.html (BoothEdit model) at 390x844 touch and 1280x800.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217 (the Ragas paper)');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const shots = process.env.BOOTH_RECIPE_SHOTS || '';
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_RECIPE_PORT || 19921);
const token = 'fsg_' + 'b'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);
const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*'};

const MYAI_RECIPE = {
  schema: 'falsify.booth.recipe.v1', paperId: '2309.15217',
  edits: [
    {page: 5, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'},
    {find: 'WikiEval', replace: 'WikiQA'},
  ],
  defectType: 'number', reason: 'Ragas faithfulness lowered to 0.50 while the text says Ragas agrees best with humans.',
  source: 'my-ai', agent: {name: 'My AI', model: 'test-model'},
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

async function stubApi(route, log) {
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
  if (request.method() === 'GET' && url.pathname.startsWith('/v1/booth/recipes/')) {
    log.recipes.push(url.pathname);
    return json(route, 404, {error: {code: 'not_found'}});
  }
  if (request.method() === 'POST' && url.pathname === '/v1/booth/submissions') {
    let body = Buffer.alloc(0);
    try { body = request.postDataBuffer() || Buffer.alloc(0); } catch { body = Buffer.alloc(0); }
    log.submissions.push(body);
    return json(route, 201, {receipt: 'F-0043', claimKey: '7Q3K-M9XD', status: 'received', course: 'quick', declaredCount: 2, createdAt: '2026-11-22T01:00:00.000Z'});
  }
  if (url.pathname === '/v1/booth/claim' && (request.method() === 'GET' || request.method() === 'POST')) {
    return json(route, 200, {receipt: 'F-0043', status: 'reviewing', course: 'quick', declaredCount: 2, createdAt: '2026-11-22T01:00:00.000Z', published: false});
  }
  return json(route, 404, {error: {code: 'not_found'}});
}

async function phoneAudit(page, selector) {
  return page.evaluate(scope => {
    const small = [...document.querySelectorAll(scope + ' button')]
      .filter(node => node.offsetParent !== null)
      .map(node => ({text: node.textContent.trim(), rect: node.getBoundingClientRect()}))
      .filter(item => item.rect.width < 44 || item.rect.height < 44)
      .map(item => item.text + ' ' + Math.round(item.rect.width) + 'x' + Math.round(item.rect.height));
    return {small, overflow: document.documentElement.scrollWidth - window.innerWidth};
  }, selector);
}

function stepIs(page, name) {
  return page.waitForFunction(value => document.documentElement.dataset.boothStep === value, name);
}

async function shoot(page, name, wide) {
  if (!shots) return;
  fs.mkdirSync(shots, {recursive: true});
  await page.screenshot({path: path.join(shots, name + (wide ? '-1280' : '-390') + '.png')});
}

let lastPage = null;
async function diagnose() {
  if (!lastPage || lastPage.isClosed()) return null;
  if (shots) await lastPage.screenshot({path: path.join(shots, 'failure.png'), fullPage: true}).catch(() => {});
  return lastPage.evaluate(() => ({
    step: document.documentElement.dataset.boothStep,
    dock: document.querySelector('#booth-dock-count')?.textContent || '',
    dockStatus: document.querySelector('#booth-dock-status')?.textContent || '',
    recipe: document.querySelector('#booth-recipe-result')?.textContent || '',
    find: [...document.querySelectorAll('#booth-pane-find .booth-feedback')].map(node => node.textContent),
    edits: (globalThis.FalsifyBoothEdits?.list() || []).map(edit => [edit.pageIndex, edit.originalText, edit.newText, edit.source, edit.rects.length]),
  })).catch(() => null);
}

async function openPage(browser, hash, log, errors, wide) {
  const context = await browser.newContext(wide
    ? {viewport: {width: 1280, height: 800}, deviceScaleFactor: 1, locale: 'ko-KR'}
    : {viewport: {width: 390, height: 844}, deviceScaleFactor: shots ? 3 : 1, hasTouch: true, locale: 'ko-KR'});
  await context.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const api = window.FalsifyBrowserPdf || (window.FalsifyBrowserPdf = {});
      if (typeof api.rewrite !== 'function') {
        api.rewrite = async (sourceBytes, edits) => {
          const marker = new TextEncoder().encode('\n% falsify-stub-rewrite ' + (edits ? edits.length : 0) + '\n');
          const out = new Uint8Array(sourceBytes.length + marker.length);
          out.set(sourceBytes, 0);
          out.set(marker, sourceBytes.length);
          return out;
        };
      }
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  lastPage = page;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { void dialog.accept(); });
  const base = 'http://127.0.0.1:' + port + '/';
  await page.route('**/*', route => (route.request().url().startsWith(base) ? route.continue() : stubApi(route, log)));
  await page.goto(base + 'event.html' + hash);
  return page;
}

/* Acceptance B: two tabs at half width, no agent nodes, phone edit-step gap <= 16px, find & myai tabs work. */
async function findAndTabsCheck(browser, log, errors, wide) {
  const page = await openPage(browser, '', log, errors, wide);
  await page.locator('#booth-missions .booth-mission').first().click();
  await stepIs(page, 'edit');
  await page.waitForFunction(() => !!globalThis.FalsifyPaperWorkspace?.getPdfDoc?.() && !!document.querySelector('#paper-before-stage canvas'));
  assert.deepEqual(await page.locator('.booth-tabs [role=tab]').allTextContents(), ['직접 고치기', '내 AI에게']);
  const domB = await page.evaluate(() => {
    const tabNodes = [...document.querySelectorAll('.booth-tabs [role=tab]')];
    const tabs = tabNodes.map(n => n.getBoundingClientRect());
    const tabBar = document.querySelector('.booth-tabs').getBoundingClientRect();
    const toolbar = document.querySelector('#paper-workspace .paper-toolbar').getBoundingClientRect();
    return {
      tabIds: tabNodes.map(n => n.id),
      paneIds: [...document.querySelectorAll('#booth-recipe .booth-pane')].map(n => n.id),
      widths: tabs.map(r => Math.round(r.width * 10) / 10),
      barWidth: Math.round(tabBar.width * 10) / 10,
      phoneGap: Math.round((toolbar.top - tabBar.bottom) * 10) / 10,
      agentIds: [...document.querySelectorAll('#booth [id*="agent"], .page-foot [id*="agent"]')].map(n => n.id),
      sourceLink: !!document.querySelector('#source-link'),
    };
  });
  assert.deepEqual(domB.tabIds, ['booth-tab-find', 'booth-tab-myai'], 'only two tabs');
  assert.deepEqual(domB.paneIds, ['booth-pane-find', 'booth-pane-myai'], 'only two panes');
  assert.deepEqual(domB.agentIds, [], 'no agent DOM nodes');
  assert.equal(domB.sourceLink, true, 'source link stays');
  assert.ok(Math.abs(domB.widths[0] - domB.widths[1]) <= 2, 'two tabs equal half width: ' + JSON.stringify(domB.widths));
  assert.ok(domB.widths[0] > domB.barWidth * 0.44 && domB.widths[0] < domB.barWidth * 0.52, 'tab width ~half bar: ' + JSON.stringify(domB));
  if (!wide) {
    assert.ok(domB.phoneGap >= 0 && domB.phoneGap <= 16, 'phone edit-step gap <= 16px, got ' + domB.phoneGap);
    console.log('MEASURED_PHONE_GAP=' + domB.phoneGap);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shoot(page, 'edit-top', wide);
  }

  const pane = page.locator(wide ? '#booth-pane-find' : '#booth-find-fold');
  if (!wide) {
    const more = page.locator('#booth-find-fold');
    assert.equal(await more.evaluate(node => node.open), false, '찾아 바꾸기 starts closed');
    assert.equal(await more.locator('summary').textContent(), '찾아 바꾸기');
    await more.locator('summary').click();
  }
  await pane.getByLabel('바꿀 글자').first().fill('0.78');
  await pane.locator('.booth-find-hit').first().waitFor();
  const hits = await pane.locator('.booth-find-hit').allTextContents();
  assert.equal(hits.length >= 1, true);
  assert.match(hits[0], /^5쪽/);
  assert.equal(await pane.locator('.booth-find-hit mark').first().textContent(), '0.78');
  await pane.locator('.booth-find-hit').first().click();
  assert.equal(await pane.locator('.booth-find-hit').first().getAttribute('aria-selected'), 'true');
  await pane.getByLabel('새 글자').first().fill('0.87');
  await pane.getByRole('button', {name: '바꾸기'}).first().click();
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
  const stored = await page.evaluate(() => globalThis.FalsifyBoothEdits.list());
  assert.equal(stored.length, 1);
  assert.equal(stored[0].pageIndex, 4);
  assert.equal(stored[0].originalText, '0.78');
  assert.equal(stored[0].newText, '0.87');
  assert.equal(stored[0].source, 'find');
  assert.ok(stored[0].rects.length >= 1 && stored[0].rects[0].w > 0 && stored[0].rects[0].h > 0);
  assert.equal(await page.locator('#booth-next').isEnabled(), true);

  await pane.getByLabel('바꿀 글자').first().fill('the');
  await pane.locator('.booth-find-more').waitFor({state: 'visible'});
  assert.equal(await pane.locator('.booth-find-hit').count(), 20);
  assert.match(await pane.locator('.booth-find-more').textContent(), /^\d+곳 더 있어요/);

  await page.locator('#booth-tab-myai').click();
  assert.equal(await page.locator('#booth-myai').count(), 1);
  await page.waitForFunction(() => /^전체 [\d,]+자$/.test(document.querySelector('#booth-myai .booth-myai-size')?.textContent || ''));
  assert.equal(await page.locator('#booth-myai-page').count(), 0);
  assert.equal(await page.locator('#booth-myai-pdf').getAttribute('href'), 'https://arxiv.org/pdf/2309.15217');

  if (!wide) {
    await page.setViewportSize({width: 360, height: 780});
    await page.locator('#booth-tab-find').click();
    const audit = await phoneAudit(page, '#booth-recipe');
    assert.deepEqual(audit.small, []);
    assert.equal(audit.overflow <= 0, true, 'edit overflow ' + audit.overflow);
  }
  await page.context().close();
}

/* Acceptance B: event.html#recipe=R-ABC123 opens normally on pick with no error and no recipe applied. */
async function hashIgnoredCheck(browser, log, errors) {
  const before = log.recipes.length;
  const page = await openPage(browser, '#recipe=R-ABC123', log, errors, false);
  await page.locator('#booth-missions .booth-mission').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'pick');
  assert.equal(await page.evaluate(() => globalThis.FalsifyBoothEdits.list().length), 0);
  assert.equal(log.recipes.length, before, 'no recipe fetch on #recipe= hash');
  assert.equal(await page.locator('#booth [id*="agent"], .page-foot [id*="agent"]').count(), 0);
  await page.context().close();
}

/* Acceptance A: automatic cropped compare on send step at 390x844 and 1280x800, plus multi-line height cap. */
async function compareFlow(browser, log, errors, wide) {
  const page = await openPage(browser, '', log, errors, wide);
  await page.locator('#booth-missions .booth-mission').first().click();
  await stepIs(page, 'edit');
  await page.waitForFunction(() => !!globalThis.FalsifyPaperWorkspace?.getPdfDoc?.() && !!document.querySelector('#paper-before-stage canvas'));
  await page.evaluate(recipe => globalThis.FalsifyBoothRecipe.apply(recipe), MYAI_RECIPE);
  await page.waitForFunction(() => document.querySelector('#booth-recipe-count')?.textContent === '1곳 적용 · 1곳은 직접 골라 주세요');
  assert.match(await page.locator('#booth-recipe-result').textContent(), /바뀐 곳은 「다음」에서 원문과 함께 확인해요\. 제출은 직접 해요\./);
  const row = page.locator('#booth-recipe-fix .booth-find.row');
  assert.equal(await row.count(), 1);
  assert.match(await row.locator('.booth-find-note').textContent(), /여러 곳/);
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
  assert.deepEqual(await page.evaluate(() => globalThis.FalsifyBoothRecipe.assist()), {assist: 'my-ai'});
  await row.locator('.booth-find-hit').first().waitFor();
  await row.locator('.booth-find-hit').first().click();
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 2개');
  assert.equal(await page.locator('#booth-recipe-count').textContent(), '2곳 적용했어요');
  assert.equal(await page.locator('#booth-recipe-fix').isHidden(), true);

  // Add a 3rd multi-line edit spanning 3+ lines (padded > 1/3 so padding trims to the 1/3 page height cap).
  const pageHeightPt = await page.evaluate(async () => {
    const pdf = globalThis.FalsifyPaperWorkspace.getPdfDoc();
    const p = await pdf.getPage(5);
    const vp = p.getViewport({scale: 1});
    globalThis.FalsifyBoothEdits.add({
      pageIndex: 4,
      rects: [
        {x: 0.08, y: 0.48, w: 0.40, h: 0.015},
        {x: 0.08, y: 0.50, w: 0.40, h: 0.015},
        {x: 0.08, y: 0.52, w: 0.40, h: 0.015},
        {x: 0.08, y: 0.745, w: 0.40, h: 0.015},
      ],
      originalText: 'multi-line original block',
      newText: 'multi-line edited block',
      source: 'paragraph',
    });
    return vp.height;
  });
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 3개');

  // 다음 builds the revised PDF and opens send; crops render automatically with no click.
  await page.locator('#booth-next').click();
  await stepIs(page, 'send');
  assert.equal(await page.locator('.booth-recipe-compare-toggle').count(), 0, 'no compare toggle button anywhere');
  const cards = page.locator('#booth-rows .booth-card');
  assert.equal(await cards.count(), 3);
  const first = cards.first();
  assert.equal(await first.locator('textarea').inputValue(), MYAI_RECIPE.reason, 'recipe reason prefilled');
  assert.equal(await first.getByRole('button', {name: '수치·통계'}).getAttribute('aria-pressed'), 'true');
  assert.equal(await first.locator('.booth-recipe-ai-pick').textContent(), 'AI 선택');
  assert.equal(await first.locator('.booth-recipe-draft').textContent(), 'AI가 채운 초안 · 내 말로 고쳐도 돼요');
  await first.locator('textarea').press('End');
  await first.locator('textarea').pressSequentially(' 직접');
  assert.equal(await first.locator('.booth-recipe-draft').textContent(), '내가 고침');

  // Wait for all 3 cards to render both crop canvases automatically.
  await page.waitForFunction(() => {
    const list = [...document.querySelectorAll('#booth-rows .booth-card')];
    return list.length === 3 && list.every(c => c.querySelectorAll('.booth-recipe-compare canvas').length === 2);
  });
  await first.locator('.booth-recipe-compare figure').nth(1).locator('.booth-recipe-outline').waitFor();
  await shoot(page, 'send', wide);

  const metrics = await page.evaluate(() => {
    return [...document.querySelectorAll('#booth-rows .booth-card')].map(card => {
      const compare = card.querySelector('.booth-recipe-compare');
      const cs = getComputedStyle(compare);
      const compareContentW = compare.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const captions = [...compare.querySelectorAll('figcaption')].map(n => n.textContent);
      const canvases = [...compare.querySelectorAll('canvas')].map(c => {
        const r = c.getBoundingClientRect();
        return {
          label: c.getAttribute('aria-label'),
          scale: parseFloat(c.dataset.scale),
          rawScale: c.dataset.scale,
          width: r.width,
          height: r.height,
          top: r.top,
          bottom: r.bottom,
          backingW: c.width,
          backingH: c.height,
        };
      });
      const revSurface = compare.querySelectorAll('.booth-recipe-shot')[1];
      const outline = revSurface?.querySelector('.booth-recipe-outline');
      const sr = revSurface?.getBoundingClientRect();
      const or = outline?.getBoundingClientRect();
      return {
        compareContentW,
        captions,
        canvases,
        mark: revSurface?.getAttribute('data-mark') || '',
        outlineInside: !!(sr && or && or.left >= sr.left - 1 && or.top >= sr.top - 1 && or.right <= sr.right + 1 && or.bottom <= sr.bottom + 1),
      };
    });
  });

  console.log('MEASURED_COMPARE_' + (wide ? '1280' : '390') + '=' + JSON.stringify(metrics[0]));
  for (const m of metrics) {
    assert.deepEqual(m.captions, ['원본', '수정본']);
    assert.equal(m.canvases.length, 2);
    assert.equal(m.mark, 'rects');
    assert.equal(m.outlineInside, true, 'outline lies inside revised surface: ' + JSON.stringify(m));
    assert.ok(m.canvases[0].backingW <= 4096 && m.canvases[0].backingH <= 4096);
    assert.ok(m.canvases[1].backingW <= 4096 && m.canvases[1].backingH <= 4096);
    if (!wide) {
      assert.ok(m.canvases[1].top >= m.canvases[0].bottom - 0.5, 'stacked on 390: ' + JSON.stringify(m.canvases));
      for (const c of m.canvases) {
        assert.ok(Math.abs(c.width - m.compareContentW) <= 2, `canvas width ${c.width} vs compare ${m.compareContentW}`);
      }
    } else {
      assert.ok(Math.abs(m.canvases[1].top - m.canvases[0].top) <= 2, 'side-by-side on 1280: ' + JSON.stringify(m.canvases));
    }
  }
  // Card 0 is page 5 Table 1 "0.95" -> "0.50": aria-labels and data-scale >= 1.2 on both canvases.
  assert.equal(metrics[0].canvases[0].label, '원본 5쪽, 고친 곳 주변');
  assert.equal(metrics[0].canvases[1].label, '수정본 5쪽, 고친 곳 주변');
  assert.ok(metrics[0].canvases[0].scale >= 1.2, 'before data-scale >= 1.2: ' + metrics[0].canvases[0].rawScale);
  assert.ok(metrics[0].canvases[1].scale >= 1.2, 'after data-scale >= 1.2: ' + metrics[0].canvases[1].rawScale);

  // Card 2 is the multi-line paragraph edit: height <= (pageHeightPt / 3) * data-scale + 2.
  const tall = metrics[2];
  for (const c of tall.canvases) {
    const cap = (pageHeightPt / 3) * c.scale + 2;
    assert.ok(c.height <= cap, `multi-line canvas height ${c.height} <= ${cap} (pageH=${pageHeightPt}, scale=${c.scale})`);
  }

  // Narrow 320x800 viewport check (P2-1): no horizontal page overflow on the send step.
  if (!wide) {
    await page.setViewportSize({width: 320, height: 800});
    const narrow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(narrow.scrollWidth <= narrow.innerWidth, '320x800 send step overflow: ' + JSON.stringify(narrow));
    await page.setViewportSize({width: 390, height: 844});
  }

  for (let i = 0; i < 3; i += 1) {
    const card = cards.nth(i);
    if (await card.getByRole('button', {name: '수치·통계'}).getAttribute('aria-pressed') !== 'true') await card.getByRole('button', {name: '수치·통계'}).click();
    if (!(await card.locator('textarea').inputValue())) await card.locator('textarea').fill('설명을 적었습니다');
  }
  await page.locator('#booth-submit-button').click();
  await stepIs(page, 'ticket');
  const posted = log.submissions.at(-1).toString('utf8');
  assert.match(posted, /"assist":"my-ai"/);
  assert.equal(posted.includes('recipeCode'), false);
  await page.context().close();
}

/* Single hit adds directly; multiple hits ask and tap-to-pick adds rects; same spot updates cleanly. */
async function findFlows(browser, log, errors, wide) {
  const page = await openPage(browser, '', log, errors, wide);
  await page.locator('#booth-missions .booth-mission').first().click();
  await stepIs(page, 'edit');
  await page.waitForFunction(() => !!globalThis.FalsifyPaperWorkspace?.getPdfDoc?.() && !!document.querySelector('#paper-before-stage canvas'));
  if (!wide) await page.locator('#booth-find-fold summary').click();
  const pane = page.locator(wide ? '#booth-pane-find' : '#booth-find-fold');
  const find = pane.getByLabel('바꿀 글자').first();
  const repl = pane.getByLabel('새 글자').first();
  const go = pane.getByRole('button', {name: '바꾸기'}).first();
  const status = pane.locator('.booth-find > .booth-feedback').first();
  const dockIs = count => page.waitForFunction(value => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 ' + value + '개', count);

  // 1 hit: 바꾸기 adds the edit directly (source 'find').
  await find.fill('0.95');
  await repl.fill('0.50');
  await go.click();
  await dockIs(1);
  await page.waitForFunction(() => /^바꿨어요 · 5쪽/.test(document.querySelector('#booth-pane-find .booth-find > .booth-feedback, #booth-find-fold .booth-find > .booth-feedback')?.textContent || ''));

  // Same hit changed twice: overlapping rects replace the older edit cleanly (still 1 edit).
  await find.fill('0.95');
  await repl.fill('0.40');
  await go.click();
  await page.waitForFunction(() => globalThis.FalsifyBoothEdits.list().some(e => e.newText === '0.40'));
  assert.equal(await page.evaluate(() => globalThis.FalsifyBoothEdits.list().length), 1);

  // Multiple hits: 바꾸기 prompts above the hit list; one tap adds the picked hit's rects.
  await find.fill('WikiEval');
  await repl.fill('WikiQA');
  await go.click();
  const ask = pane.locator('.booth-find-ask').first();
  await ask.waitFor();
  assert.match(await ask.textContent(), /^같은 글자가 \d+곳에 있어요\. 바꿀 곳을 눌러 주세요\.$/);
  await pane.locator('.booth-find-hit').nth(1).click();
  await dockIs(2);
  assert.equal(await ask.isHidden(), true);

  // Case-folded no-op: newText equals originalText -> calm notice, 0 edits added (P2-2).
  await find.fill('gpt ranking');
  await repl.fill('GPT Ranking');
  await go.click();
  const askNoop = pane.locator('.booth-find-ask').first();
  if (await askNoop.isVisible()) await pane.locator('.booth-find-hit').first().click();
  await page.waitForFunction(() => /새 글자가 원문과 같아요/.test(
    (document.querySelector('#booth-pane-find .booth-find > .booth-feedback, #booth-find-fold .booth-find > .booth-feedback')?.textContent || '')
    + (document.querySelector('#booth-pane-find .booth-find-ask, #booth-find-fold .booth-find-ask')?.textContent || '')
  ));
  assert.equal(await page.locator('#booth-dock-count').textContent(), '고친 곳 2개');

  // Missing text: calm feedback beside the form.
  await find.fill('zzqx nowhere');
  await repl.fill('x');
  await go.click();
  await page.waitForFunction(() => /찾는 글자가 이 논문에 없어요/.test(document.querySelector('#booth-pane-find .booth-find > .booth-feedback, #booth-find-fold .booth-find > .booth-feedback')?.textContent || ''));
  assert.match(await status.textContent(), /찾는 글자가 이 논문에 없어요/);

  if (wide) {
    await page.locator('#booth-dock-chips .booth-dock-x').first().click();
    await dockIs(1);
  }
  await page.context().close();
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  const errors = [];
  const log = {recipes: [], submissions: []};
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    await findAndTabsCheck(browser, log, errors, false);
    await findAndTabsCheck(browser, log, errors, true);
    await hashIgnoredCheck(browser, log, errors);
    await compareFlow(browser, log, errors, false);
    await compareFlow(browser, log, errors, true);
    await findFlows(browser, log, errors, false);
    await findFlows(browser, log, errors, true);
    assert.equal(errors.join('\n'), '');
  } catch (error) {
    error.message += '\npage=' + JSON.stringify(await diagnose()) + '\nerrors=' + errors.join(' | ');
    throw error;
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth recipe browser passed'); }, error => {
  console.error(error && error.message);
  console.error(error && error.stack || error);
  process.exit(1);
});
