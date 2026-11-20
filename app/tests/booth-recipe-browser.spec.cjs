'use strict';
// Real Chromium walk of the booth recipe UI on event.html: find-and-replace, #recipe=CODE, the
// result card, a prefilled fix row, the send-step page comparison and the submit payload.
// The API is stubbed. FALSIFY_BOOTH_MISSION_PDF names a local copy of arXiv 2309.15217 (CC BY 4.0).
// BOOTH_RECIPE_SHOTS, when set, is a directory for 390x844 (DPR 3) and 1280x800 screenshots.
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
const port = Number(process.env.BOOTH_RECIPE_PORT || 8879);
const token = 'fsg_' + 'b'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);
const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*'};

/* One edit resolves on page 5 by context; the other (WikiEval, many places, no page) stays ambiguous. */
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
    enabled: true, submissionsOpen: true, announcement: '', consentVersion: '2026-11-22.v2',
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
    edit: document.querySelector('#paper-edit-status')?.textContent || '',
    proposals: document.querySelector('#paper-proposal-status')?.textContent || '',
    gen: document.querySelector('#paper-generate-status')?.textContent || '',
    edits: (globalThis.FalsifyPaperWorkspace?.getEditSnapshot()?.edits || []).map(edit => [edit.segmentId, edit.before, edit.after]),
  })).catch(() => null);
}

async function openPage(browser, hash, log, errors, wide) {
  const context = await browser.newContext(wide
    ? {viewport: {width: 1280, height: 800}, deviceScaleFactor: 1, locale: 'ko-KR'}
    : {viewport: {width: 390, height: 844}, deviceScaleFactor: shots ? 3 : 1, hasTouch: true, locale: 'ko-KR'});
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

/* 직접 고치기: live matches, choose one, 바꾸기; the dock counts it like a paragraph edit. */
async function findAndReplace(browser, log, errors, wide) {
  const page = await openPage(browser, '', log, errors, wide);
  await page.locator('#booth-missions .booth-mission').first().click();
  await stepIs(page, 'edit');
  await page.waitForFunction(() => [...document.querySelectorAll('.paper-paragraph-button')].some(node => node.textContent.includes('0.95')));
  assert.deepEqual(await page.locator('.booth-tabs [role=tab]').allTextContents(), ['직접 고치기', '내 AI에게', 'Agent 코드']);
  // The page is the editor on event.html; the paragraph list is visually hidden (still read by screen readers).
  assert.equal(await page.locator('#booth-find-list').count(), 0, 'no paragraph list toggle');
  assert.ok((await page.locator('.paper-paragraph-list').first().evaluate(node => node.getBoundingClientRect().width)) <= 1, 'paragraph list visually hidden');
  // Phones: the page comes right after the tabs; find-and-replace is a closed 「찾아 바꾸기」 below it.
  const pane = page.locator(wide ? '#booth-pane-find' : '#booth-find-fold');
  if (!wide) {
    const more = page.locator('#booth-find-fold');
    assert.equal(await more.evaluate(node => node.open), false, '찾아 바꾸기 starts closed');
    assert.equal(await more.locator('summary').textContent(), '찾아 바꾸기');
    const order = await page.evaluate(() => {
      const top = selector => document.querySelector(selector).getBoundingClientRect().top;
      return {tabs: top('.booth-tabs'), toolbar: top('#paper-workspace .paper-toolbar'), page: top('#paper-before-stage'), more: top('#booth-find-fold')};
    });
    assert.ok(order.tabs < order.toolbar && order.toolbar < order.page && order.page < order.more, 'phone order: tabs, page toolbar, page, 찾아 바꾸기 ' + JSON.stringify(order));
    assert.equal(await page.locator('#booth-pane-find').getByLabel('바꿀 글자').count(), 0, 'no find form above the page');
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
  assert.match(await page.locator('#paper-edits').textContent(), /0\.78 → 0\.87/);
  // A find-and-replace edit is painted on the page like a word tap: a .booth-patch reading 0.87.
  await page.waitForFunction(() => [...document.querySelectorAll('#paper-before-stage .booth-patch')].some(node => node.textContent === '0.87' && node.getBoundingClientRect().width > 0));
  assert.equal(await page.locator('#booth-next').isEnabled(), true);
  await pane.getByLabel('바꿀 글자').first().fill('the');
  await pane.locator('.booth-find-more').waitFor({state: 'visible'});
  assert.equal(await pane.locator('.booth-find-hit').count(), 20);
  assert.match(await pane.locator('.booth-find-more').textContent(), /^\d+곳 더 있어요/);
  await page.locator('#booth-tab-myai').click();
  assert.equal(await page.locator('#booth-myai').count(), 1);
  const myaiReady = await page.evaluate(() => typeof globalThis.FalsifyBoothMyAI?.mount === 'function');
  if (!myaiReady) assert.equal(await page.locator('#booth-pane-myai .booth-myai-wait').textContent(), '준비 중');
  await shoot(page, 'tab-myai', wide);
  await page.locator('#booth-tab-agent').click();
  assert.equal(await page.locator('#booth-agent-code').isVisible(), true);
  assert.equal(await page.locator('#booth-agent-code').getAttribute('placeholder'), '예: R-7K3QXM');
  assert.deepEqual(await page.locator('#booth-agent-code').evaluate(node => [node.getAttribute('autocapitalize'), node.getAttribute('autocomplete')]), ['characters', 'off']);
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
  assert.deepEqual(await page.locator('#booth-recipe-confirm button').allTextContents(), ['지금 것 지우고 불러오기', '지금 것 유지']);
  await shoot(page, 'recipe-confirm', wide);
  await page.locator('#booth-recipe-confirm-no').click();
  await page.waitForFunction(() => !document.querySelector('#booth-recipe-confirm'));
  assert.equal(await page.locator('#booth-agent-status').textContent(), '레시피를 불러오지 않았어요.');
  assert.equal(await page.locator('#booth-recipe-result').isHidden(), true);
  assert.equal(await page.locator('#booth-dock-count').textContent(), '고친 곳 1개');
  await page.evaluate(() => {
    globalThis.FalsifyBoothPaper.current = globalThis.__realCurrent;
    location.hash = '#recipe=R-ABC123';
  });
  await page.locator('#booth-recipe-confirm').waitFor();
  assert.equal(await page.locator('#booth-recipe-confirm-text').textContent(), '지금 고친 곳 1개는 그대로 두고 레시피를 더해요. 레시피를 불러올까요?');
  assert.deepEqual(await page.locator('#booth-recipe-confirm button').allTextContents(), ['더해서 불러오기', '그대로 두기']);
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

/* #recipe=R-ABC123 opens the mission, applies 1 edit, leaves 1 as a prefilled fix row. */
async function recipeFlow(browser, log, errors, wide) {
  const page = await openPage(browser, '#recipe=r-abc123', log, errors, wide);
  await stepIs(page, 'edit');
  await page.waitForFunction(() => /\d+곳 적용/.test(document.querySelector('#booth-recipe-count')?.textContent || ''));
  assert.equal(await page.locator('#booth-recipe-confirm').count(), 0, 'a fresh page needs no confirm');
  assert.equal(await page.locator('#booth-recipe-count').textContent(), '1곳 적용 · 1곳은 직접 골라 주세요');
  assert.match(await page.locator('#booth-recipe-result').textContent(), /Claude Code · claude-opus-5-5 · R-ABC123 · (오늘|\d+월 \d+일) \d\d:\d\d까지 유효/);
  await page.waitForFunction(() => document.querySelectorAll('#paper-edits .booth-recipe-ai-tag').length === 1);
  assert.equal(await page.locator('#paper-edits .booth-recipe-ai-tag').textContent(), 'AI');
  assert.equal(log.recipes.at(-1), '/v1/booth/recipes/R-ABC123');
  assert.equal(await page.evaluate(() => location.hash), '', 'the recipe hash is consumed');
  assert.equal(await page.locator('#booth-tab-find').getAttribute('aria-selected'), 'true');
  const row = page.locator('#booth-recipe-fix .booth-find.row');
  assert.equal(await row.count(), 1);
  assert.match(await row.locator('.booth-find-note').textContent(), /여러 곳/);
  assert.equal(await row.getByLabel('바꿀 글자').inputValue(), 'WikiEval');
  assert.equal(await row.getByLabel('새 글자').inputValue(), 'WikiQA');
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
  assert.deepEqual(await page.evaluate(() => globalThis.FalsifyBoothRecipe.assist()), {assist: 'agent', recipeCode: 'R-ABC123'});
  await page.locator('#booth-recipe-result').scrollIntoViewIfNeeded();
  await shoot(page, 'result-card', wide);
  await row.locator('.booth-find-hit').first().waitFor();
  await row.locator('.booth-find-hit').first().click();
  await row.getByRole('button', {name: '바꾸기'}).click();
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 2개');
  assert.equal(await page.locator('#booth-recipe-count').textContent(), '2곳 적용했어요');
  assert.equal(await page.locator('#booth-recipe-fix').isHidden(), true);

  // 다음 builds the PDF exactly as for a manual edit; send shows both diffs.
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
  assert.equal(await first.locator('.booth-recipe-compare-toggle').getAttribute('aria-expanded'), 'true');
  await first.locator('.booth-recipe-compare canvas').nth(1).waitFor();
  assert.deepEqual(await first.locator('.booth-recipe-compare figcaption').allTextContents(), ['원본', '수정본 · 5쪽']);
  const captionAbove = await first.locator('.booth-recipe-compare figure').evaluateAll(list => list.map(fig => fig.firstElementChild.tagName));
  assert.deepEqual(captionAbove, ['FIGCAPTION', 'FIGCAPTION']);
  await first.locator('.booth-recipe-compare figure').nth(1).locator('.booth-recipe-outline').waitFor();
  const mark = await first.locator('.booth-recipe-shot').nth(1).getAttribute('data-mark');
  assert.ok(mark === 'marks' || mark === 'bbox', 'changed spot marked: ' + mark);
  if (shots) console.log('compare mark source: ' + mark);
  const outline = await first.locator('.booth-recipe-outline').boundingBox();
  const shot = await first.locator('.booth-recipe-shot').nth(1).boundingBox();
  assert.ok(outline.width > 2 && outline.height > 2 && outline.x >= shot.x - 1 && outline.y >= shot.y - 1
    && outline.x + outline.width <= shot.x + shot.width + 1 && outline.y + outline.height <= shot.y + shot.height + 1, 'outline sits on the page');
  assert.equal(await first.locator('.booth-recipe-shot').first().locator('.booth-recipe-outline').count(), 0, 'the original stays unmarked');
  const drawn = await first.locator('.booth-recipe-compare canvas').evaluateAll(list => list.map(canvas => canvas.width > 50 && canvas.height > 50));
  assert.deepEqual(drawn, [true, true]);
  await first.locator('.booth-recipe-compare').scrollIntoViewIfNeeded();
  await shoot(page, 'send-compare', wide);
  if (!wide) {
    await page.setViewportSize({width: 360, height: 780});
    const audit = await phoneAudit(page, '#booth-rows');
    assert.deepEqual(audit.small, []);
    assert.equal(audit.overflow <= 0, true, 'send overflow ' + audit.overflow);
    await page.setViewportSize({width: 390, height: 844});
  }
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
    if (shots) {
      await findAndReplace(browser, log, errors, true);
      await recipeFlow(browser, log, errors, true);
    }
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
