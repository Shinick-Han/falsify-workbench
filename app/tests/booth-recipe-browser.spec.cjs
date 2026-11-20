'use strict';
// Real Chromium walk of the booth recipe & find-and-replace UI on event.html (BoothEdit model):
// find-and-replace (1-hit direct add, multi-hit tap-to-pick, overlap replacement), #recipe=CODE,
// result card, prefilled one-tap fix row, send-step page comparison (edit.rects), and submit.
// FalsifyBrowserPdf.rewrite is stubbed to append a PDF comment marker until sx-gen merges.
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

const RECIPE = {
  schema: 'falsify.booth.recipe.v1', paperId: '2309.15217',
  edits: [
    {page: 5, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'},
    {find: 'WikiEval', replace: 'WikiQA'},
  ],
  defectType: 'number', reason: 'Ragas faithfulness lowered to 0.50 while the text says Ragas agrees best with humans.',
  source: 'agent', agent: {name: 'Claude Code', model: 'claude-opus-5-5'},
  code: 'R-ABC123', createdAt: '2026-11-22T00:58:00.000Z', expiresAt: '2026-11-22T06:58:00.000Z',
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
    if (url.pathname === '/v1/booth/recipes/R-ABC123') return json(route, 200, RECIPE);
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
    agent: document.querySelector('#booth-agent-status')?.textContent || '',
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

/* 직접 고치기: live matches from pdf.js text index, pick one, 바꾸기 -> BoothEdit added. */
async function findAndReplace(browser, log, errors, wide) {
  const page = await openPage(browser, '', log, errors, wide);
  await page.locator('#booth-missions .booth-mission').first().click();
  await stepIs(page, 'edit');
  await page.waitForFunction(() => !!globalThis.FalsifyPaperWorkspace?.getPdfDoc?.() && !!document.querySelector('#paper-before-stage canvas'));
  assert.deepEqual(await page.locator('.booth-tabs [role=tab]').allTextContents(), ['직접 고치기', '내 AI에게', 'Agent 코드']);
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
  await shoot(page, 'tab-find', wide);
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
  await page.waitForFunction(() => /원문 포함/.test(document.querySelector('#booth-myai .booth-myai-size')?.textContent || ''));
  await shoot(page, 'tab-myai', wide);

  await page.locator('#booth-tab-agent').click();
  assert.equal(await page.locator('#booth-agent-code').isVisible(), true);
  assert.equal(await page.locator('#booth-agent-code').getAttribute('placeholder'), '예: R-7K3QXM');
  await page.locator('#booth-agent-code').fill('https://example.test/event.html#recipe=R-XYZ789');
  assert.equal(await page.locator('#booth-agent-code').inputValue(), 'R-XYZ789', 'a pasted link leaves just the code');
  await page.locator('#booth-agent-code').fill('');
  await shoot(page, 'tab-agent', wide);

  // A recipe over existing work asks first, inline (never window.confirm).
  let dialogs = 0;
  page.on('dialog', () => { dialogs += 1; });
  const fetched = log.recipes.length;
  await page.evaluate(() => {
    globalThis.__realCurrent = globalThis.FalsifyBoothPaper.current;
    globalThis.FalsifyBoothPaper.current = () => ({id: '2401.00001', title: 'Other', license: 'cc-by-4.0'});
    location.hash = '#recipe=R-ABC123';
  });
  await page.locator('#booth-recipe-confirm').waitFor();
  assert.equal(await page.locator('#booth-recipe-confirm-text').textContent(), '지금 고친 곳 1개가 사라져요. 레시피를 불러올까요?');
  await page.locator('#booth-recipe-confirm-no').click();
  await page.waitForFunction(() => !document.querySelector('#booth-recipe-confirm'));
  assert.equal(await page.locator('#booth-dock-count').textContent(), '고친 곳 1개');
  await page.evaluate(() => {
    globalThis.FalsifyBoothPaper.current = globalThis.__realCurrent;
    location.hash = '#recipe=R-ABC123';
  });
  await page.locator('#booth-recipe-confirm').waitFor();
  assert.equal(await page.locator('#booth-recipe-confirm-text').textContent(), '지금 고친 곳 1개는 그대로 두고 레시피를 더해요. 레시피를 불러올까요?');
  await page.locator('#booth-recipe-confirm-yes').click();
  await page.waitForFunction(() => document.querySelector('#booth-recipe-count')?.textContent === '1곳 적용 · 1곳은 직접 골라 주세요');
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 2개');
  assert.equal(log.recipes.length, fetched + 2);
  assert.equal(dialogs, 0, 'no window.confirm');
  if (!wide) {
    await page.setViewportSize({width: 360, height: 780});
    await page.locator('#booth-tab-find').click();
    const audit = await phoneAudit(page, '#booth-recipe');
    assert.deepEqual(audit.small, []);
    assert.equal(audit.overflow <= 0, true, 'edit overflow ' + audit.overflow);
  }
  await page.context().close();
}

/* #recipe=R-ABC123 opens the mission, applies 1 edit with rects, leaves 1 as a one-tap fix row. */
async function recipeFlow(browser, log, errors, wide) {
  const page = await openPage(browser, '#recipe=r-abc123', log, errors, wide);
  await stepIs(page, 'edit');
  await page.waitForFunction(() => /\d+곳 적용/.test(document.querySelector('#booth-recipe-count')?.textContent || ''));
  assert.equal(await page.locator('#booth-recipe-confirm').count(), 0, 'a fresh page needs no confirm');
  assert.equal(await page.locator('#booth-recipe-count').textContent(), '1곳 적용 · 1곳은 직접 골라 주세요');
  assert.match(await page.locator('#booth-recipe-result').textContent(), /Claude Code · claude-opus-5-5 · R-ABC123 · (오늘|\d+월 \d+일) \d\d:\d\d까지 유효/);
  assert.equal(log.recipes.at(-1), '/v1/booth/recipes/R-ABC123');
  assert.equal(await page.evaluate(() => location.hash), '', 'the recipe hash is consumed');
  assert.equal(await page.locator('#booth-tab-agent').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#booth-pane-agent #booth-recipe-fix').count(), 1);
  const row = page.locator('#booth-recipe-fix .booth-find.row');
  assert.equal(await row.count(), 1);
  assert.match(await row.locator('.booth-find-note').textContent(), /여러 곳/);
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
  assert.deepEqual(await page.evaluate(() => globalThis.FalsifyBoothRecipe.assist()), {assist: 'agent', recipeCode: 'R-ABC123'});
  await row.locator('.booth-find-hit').first().waitFor();
  // One tap on a place adds its rects directly to FalsifyBoothEdits.
  await row.locator('.booth-find-hit').first().click();
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 2개');
  assert.equal(await page.locator('#booth-recipe-count').textContent(), '2곳 적용했어요');
  assert.equal(await page.locator('#booth-recipe-fix').isHidden(), true);

  // 다음 runs FalsifyBrowserPdf.rewrite directly and opens send.
  await page.locator('#booth-next').click();
  await stepIs(page, 'send');
  const cards = page.locator('#booth-rows .booth-card');
  assert.equal(await cards.count(), 2);
  const diffs = await page.locator('#booth-rows .booth-diff').allTextContents();
  assert.equal(diffs.some(text => text.includes('0.95') && text.includes('0.50')), true, diffs.join(' | '));
  assert.equal(diffs.some(text => text.includes('WikiEval') && text.includes('WikiQA')), true, diffs.join(' | '));
  const first = cards.first();
  assert.equal(await first.locator('textarea').inputValue(), RECIPE.reason, 'recipe reason prefilled');
  assert.equal(await first.getByRole('button', {name: '수치·통계'}).getAttribute('aria-pressed'), 'true');
  assert.equal(await first.locator('.booth-recipe-ai-pick').textContent(), 'AI 선택');
  assert.equal(await first.locator('.booth-recipe-draft').textContent(), 'AI가 채운 초안 · 내 말로 고쳐도 돼요');
  await first.locator('textarea').press('End');
  await first.locator('textarea').pressSequentially(' 직접');
  assert.equal(await first.locator('.booth-recipe-draft').textContent(), '내가 고침');
  const toggle = first.getByRole('button', {name: '수정본 쪽 보기'});
  await toggle.click();
  await first.locator('.booth-recipe-compare canvas').nth(1).waitFor();
  assert.deepEqual(await first.locator('.booth-recipe-compare figcaption').allTextContents(), ['원본', '수정본 · 5쪽']);
  await first.locator('.booth-recipe-compare figure').nth(1).locator('.booth-recipe-outline').waitFor();
  assert.equal(await first.locator('.booth-recipe-shot').nth(1).getAttribute('data-mark'), 'rects');
  for (let i = 0; i < 2; i += 1) {
    const card = cards.nth(i);
    if (await card.getByRole('button', {name: '수치·통계'}).getAttribute('aria-pressed') !== 'true') await card.getByRole('button', {name: '수치·통계'}).click();
    if (!(await card.locator('textarea').inputValue())) await card.locator('textarea').fill('데이터셋 이름을 바꿨습니다');
  }
  await page.locator('#booth-consent').check();
  await page.locator('#booth-submit-button').click();
  await stepIs(page, 'ticket');
  const posted = log.submissions.at(-1).toString('utf8');
  assert.match(posted, /"assist":"agent"/);
  assert.match(posted, /"recipeCode":"R-ABC123"/);
  assert.equal(posted.includes('WikiQA'), true);
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
    await findAndReplace(browser, log, errors, false);
    await recipeFlow(browser, log, errors, false);
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
