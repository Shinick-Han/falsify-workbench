'use strict';
// Real Chromium check of the "내 AI에게" tab body (app/dist/booth-myai.js) on a stub page.
// FalsifyBoothRecipe is a local stub (S1 builds the real one); nothing reaches the network.
// BROWSER_EXECUTABLE picks Chromium. BOOTH_MYAI_SHOTS names a directory for screenshots (optional).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const origin = 'http://booth-myai.test';
const shots = process.env.BOOTH_MYAI_SHOTS || '';
const PAGE5 = 'Table 1: Agreement with human annotators.\nFaithfulness Answer Relevance Context Relevance\n' +
  'Ragas 0.95 0.78 0.70\nGPT Score 0.72 0.52 0.63\nRagas agrees best with the human annotators on faithfulness.';
const FENCE = String.fromCharCode(96).repeat(3);
const ANSWER = 'Sure! Here are two subtle defects.\n' + FENCE + 'json\n' + JSON.stringify({
  schema: 'falsify.booth.recipe.v1', paperId: '2309.15217',
  edits: [{page: '5', before: '0.95', after: '0.50'}, {page: 5, find: '0.99 1.00', replace: '0.10 0.20'}],
  defectType: 'number', reason: 'Ragas faithfulness is now lower than GPT Score.', source: 'agent',
}, null, 2) + '\n' + FENCE + '\nLet me know if you want more.';

const STUB_PAGE = '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<link rel="stylesheet" href="booth.css"><link rel="stylesheet" href="booth-myai.css">' +
  '<style>body{margin:0;background:#eef0f1}.booth{padding:0 16px 24px}</style></head><body>' +
  '<main class="booth"><p id="booth-hint" class="booth-hint"><span class="booth-klab">힌트</span> · Table 1의 점수 하나를 바꿔 보세요</p>' +
  '<input id="paper-page-jump" type="number" value="5" hidden><div id="booth-myai"></div></main>' +
  '<script src="stub-recipe.js"></script><script src="external-red.js"></script>' +
  '<script src="external-exchange.js"></script><script src="booth-myai.js"></script>' +
  '<script>window.__mount = FalsifyBoothMyAI.mount(document.getElementById("booth-myai"));</script></body></html>';

/* Stub of S1's FalsifyBoothRecipe (contract §3). window.__recipe controls apply. */
const STUB_RECIPE = 'window.__calls = {assist: [], apply: []};\n' +
  'window.__recipe = {mode: "ok"};\n' +
  'window.FalsifyBoothRecipe = {\n' +
  '  paperInfo() { return {paperId: "2309.15217", title: "Ragas: Automated Evaluation of Retrieval Augmented Generation", license: "cc-by-4.0", pages: 6}; },\n' +
  '  pageText(n) { return n === 5 ? ' + JSON.stringify(PAGE5) + ' : "Page " + n + " text about WikiEval with 50 questions."; },\n' +
  '  setAssist(kind, code) { window.__calls.assist.push([kind, code]); },\n' +
  '  assist() { return {assist: "manual"}; },\n' +
  '  async apply(recipe, options) {\n' +
  '    window.__calls.apply.push(JSON.parse(JSON.stringify(recipe)));\n' +
  '    if (options && options.onProgress) options.onProgress({message: "논문에 적용하는 중"});\n' +
  '    if (window.__recipe.mode === "throw") throw new Error("PDF를 만들지 못했어요");\n' +
  '    const [first, ...rest] = recipe.edits;\n' +
  '    return {applied: [first], unresolved: rest.map(edit => ({edit, reason: "not_found"}))};\n' +
  '  },\n' +
  '};\n';

function serve(route) {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort();
  if (url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: STUB_PAGE});
  if (url.pathname === '/stub-recipe.js') return route.fulfill({status: 200, contentType: 'text/javascript', body: STUB_RECIPE});
  const file = path.join(dist, path.basename(url.pathname));
  if (!/^\/[\w.-]+\.(?:js|css)$/.test(url.pathname) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
  return route.fulfill({status: 200, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file)});
}

async function open(browser, viewport, clipboard) {
  const context = await browser.newContext({viewport, deviceScaleFactor: 2, hasTouch: viewport.width < 600, isMobile: viewport.width < 600});
  await context.route('**/*', serve);
  await context.addInitScript(mode => {
    window.__clip = [];
    const writeText = mode === 'deny' ? () => Promise.reject(new DOMException('denied', 'NotAllowedError')) : text => { window.__clip.push(text); return Promise.resolve(); };
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}});
    if (mode === 'deny') document.execCommand = () => false;
  }, clipboard);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/');
  await page.locator('#booth-myai-copy').waitFor();
  return {context, page, errors};
}

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

async function targets(page) {
  return page.evaluate(() => [...document.querySelectorAll('#booth-myai button, #booth-myai input, #booth-myai textarea')]
    .filter(node => node.offsetParent !== null)
    .map(node => ({id: node.id || node.textContent, ...node.getBoundingClientRect().toJSON()}))
    .filter(box => box.height < 44 || box.width < 44));
}

async function shot(page, name) {
  if (!shots) return;
  fs.mkdirSync(shots, {recursive: true});
  await page.screenshot({path: path.join(shots, name + '.png'), fullPage: true});
}

async function checkStepOne(page) {
  const text = await page.locator('#booth-myai').textContent();
  assert.match(text, /부탁 글 복사/);
  assert.match(text, /어떤 AI든 괜찮아요 \(ChatGPT, Claude, Gemini…\)/);
  assert.match(text, /AI 답 붙여넣기/);
  assert.equal(await page.locator('#booth-myai-page').inputValue(), '5', 'page comes from #paper-page-jump');
  assert.match(await page.locator('#booth-myai-preview').textContent(), /논문 검증 게임/);
  assert.match(await page.locator('.booth-myai-size').textContent(), /5쪽 원문 포함/);
}

async function checkCopy(page) {
  await page.locator('#booth-myai-copy').click();
  await page.waitForFunction(() => window.__clip.length === 1);
  const copied = await page.evaluate(() => window.__clip[0]);
  assert.match(copied, /Table 1의 점수 하나를 바꿔 보세요/, 'hint from #booth-hint');
  assert.ok(copied.includes('Ragas 0.95 0.78 0.70'), 'page 5 text');
  assert.match(copied, /"source": "my-ai"/);
  assert.match(await page.locator('#booth-myai-copy-status').textContent(), /복사했어요/);
  assert.equal(await page.locator('#booth-myai-full').isVisible(), false);
  await page.getByRole('button', {name: 'English'}).click();
  await page.locator('#booth-myai-copy').click();
  await page.waitForFunction(() => window.__clip.length === 2);
  assert.match(await page.evaluate(() => window.__clip[1]), /Answer with the JSON object only/);
  await page.getByRole('button', {name: '한국어'}).click();
}

async function checkApply(page) {
  await page.locator('#booth-myai-answer').fill(ANSWER);
  await page.locator('#booth-myai-apply').click();
  await page.locator('.booth-myai-count').waitFor();
  assert.equal(await page.locator('.booth-myai-count').textContent(), '적용 1곳 · 확인 필요 1곳');
  assert.match(await page.locator('#booth-myai-result').textContent(), /"0\.99 1\.00" · 원문에서 찾지 못했어요/);
  const calls = await page.evaluate(() => window.__calls);
  assert.equal(calls.assist.length, 1);
  assert.equal(calls.assist[0][0], 'my-ai');
  assert.equal(calls.apply.length, 1);
  const recipe = calls.apply[0];
  assert.equal(recipe.source, 'my-ai');
  assert.equal(recipe.paperId, '2309.15217');
  assert.deepEqual(recipe.edits[0], {page: 5, find: '0.95', replace: '0.50'});
  assert.match(await page.locator('#booth-myai-diags').textContent(), /"0\.99 1\.00"를 그대로 찾지 못했어요/);
}

async function checkErrors(page) {
  const before = await page.evaluate(() => window.__calls.apply.length);
  await page.locator('#booth-myai-answer').fill('{"edits": [{"find": "0.95" "replace": "0.50"}]}');
  await page.locator('#booth-myai-apply').click();
  await page.locator('.booth-myai-diag.error').first().waitFor();
  assert.match(await page.locator('#booth-myai-diags').textContent(), /JSON 모양이 깨져 있어요/);
  assert.equal(await page.locator('#booth-myai-result').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__calls.apply.length), before, 'invalid answer must not call apply');

  await page.locator('#booth-myai-answer').fill('{"edits": [{"find": "0.95", "replace": "0.95"}]}');
  await page.locator('#booth-myai-apply').click();
  await page.waitForFunction(() => /바꾸기 전과 후가 같아요/.test(document.querySelector('#booth-myai-diags').textContent));

  await page.evaluate(() => { window.__recipe.mode = 'throw'; });
  await page.locator('#booth-myai-answer').fill(ANSWER);
  await page.locator('#booth-myai-apply').click();
  await page.waitForFunction(() => /적용하지 못했어요\. PDF를 만들지 못했어요/.test(document.querySelector('#booth-myai-diags').textContent));
  assert.equal(await page.locator('#booth-myai-apply').isDisabled(), false);
  await page.evaluate(() => { window.__recipe.mode = 'ok'; });

  await page.evaluate(() => { window.__saved = window.FalsifyBoothRecipe; delete window.FalsifyBoothRecipe; });
  await page.locator('#booth-myai-apply').click();
  await page.waitForFunction(() => /논문 도구가 아직 준비되지 않았어요/.test(document.querySelector('#booth-myai-diags').textContent));
  await page.evaluate(() => { window.FalsifyBoothRecipe = window.__saved; });
}

async function checkFallback(browser, viewport, tag) {
  const {context, page, errors} = await open(browser, viewport, 'deny');
  try {
    await page.locator('#booth-myai-copy').click();
    await page.locator('#booth-myai-full').waitFor({state: 'visible'});
    assert.match(await page.locator('#booth-myai-copy-status').textContent(), /자동 복사가 막혔어요/);
    const sel = await page.evaluate(() => { const a = document.querySelector('#booth-myai-full'); return {start: a.selectionStart, end: a.selectionEnd, len: a.value.length, focused: document.activeElement === a, value: a.value}; });
    assert.equal(sel.start, 0);
    assert.equal(sel.end, sel.len);
    assert.ok(sel.focused, 'fallback textarea is focused');
    assert.ok(sel.value.includes('Ragas 0.95 0.78 0.70'));
    assert.ok(await overflow(page) <= 0, tag + ': overflow with fallback');
    await shot(page, 'step1-copy-fallback-' + tag);
    assert.equal(errors.join('\n'), '');
  } finally {
    await context.close();
  }
}

async function run(browser, viewport, tag) {
  const {context, page, errors} = await open(browser, viewport, 'record');
  try {
    await checkStepOne(page);
    assert.deepEqual(await targets(page), [], tag + ': tap targets under 44px');
    assert.ok(await overflow(page) <= 0, tag + ': horizontal overflow');
    await shot(page, 'step1-' + tag);
    await checkCopy(page);
    await checkApply(page);
    assert.ok(await overflow(page) <= 0, tag + ': overflow after apply');
    await page.locator('#booth-myai-answer').scrollIntoViewIfNeeded();
    await shot(page, 'step2-applied-' + tag);
    await checkErrors(page);
    await page.locator('#booth-myai-answer').fill('{"edits": [{"find": "0.95" "replace": "0.50"}]}');
    await page.locator('#booth-myai-apply').click();
    await page.locator('.booth-myai-diag.error').first().waitFor();
    assert.ok(await overflow(page) <= 0, tag + ': overflow on error');
    await shot(page, 'step2-error-' + tag);
    assert.equal(errors.join('\n'), '');
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({executablePath: process.env.BROWSER_EXECUTABLE || undefined});
  try {
    for (const [tag, viewport] of [['360', {width: 360, height: 740}], ['390', {width: 390, height: 844}], ['1280', {width: 1280, height: 800}]]) {
      await run(browser, viewport, tag);
      await checkFallback(browser, viewport, tag);
    }
  } finally {
    await browser.close();
  }
}

main().then(() => { console.log('booth my-ai browser passed'); }, error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
