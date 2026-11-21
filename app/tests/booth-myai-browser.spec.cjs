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
  '<script src="booth-recipe.js"></script><script src="stub-recipe.js"></script><script src="external-red.js"></script>' +
  '<script src="external-exchange.js"></script><script src="booth-myai.js"></script>' +
  '<script>window.__mount = FalsifyBoothMyAI.mount(document.getElementById("booth-myai"));</script></body></html>';

/* Stub of FalsifyBoothRecipe wrapping the real locate() across pages 1..6. window.__recipe controls apply. */
const STUB_RECIPE = 'const __realLocate = window.FalsifyBoothRecipe.locate;\n' +
  'const __pages = [1, 2, 3, 4, 5, 6].map(n => ({pageIndex: n - 1, text: n === 5 ? ' + JSON.stringify(PAGE5) + ' : "Page " + n + " text about WikiEval with 50 questions."}));\n' +
  'window.__calls = {assist: [], apply: [], located: []};\n' +
  'window.__recipe = {mode: "ok"};\n' +
  'window.FalsifyBoothRecipe = {\n' +
  '  paperInfo() { return {paperId: window.__paperId || "2309.15217", title: "Ragas: Automated Evaluation of Retrieval Augmented Generation", license: "cc-by-4.0", pages: 6}; },\n' +
  '  pageText(n) { return __pages[n - 1] ? __pages[n - 1].text : ""; },\n' +
  '  setAssist(kind, code) { window.__calls.assist.push([kind, code]); },\n' +
  '  assist() { return {assist: "manual"}; },\n' +
  '  async apply(recipe, options) {\n' +
  '    window.__calls.apply.push(JSON.parse(JSON.stringify(recipe)));\n' +
  '    if (options && options.onProgress) options.onProgress({message: "논문에 적용하는 중"});\n' +
  '    if (window.__recipe.mode === "slow") await new Promise(r => setTimeout(r, 600));\n' +
  '    if (window.__recipe.mode === "throw") throw new Error("PDF를 만들지 못했어요");\n' +
  '    const applied = [], unresolved = [];\n' +
  '    for (const edit of recipe.edits) {\n' +
  '      const hit = __realLocate(edit, __pages);\n' +
  '      if (hit.status === "resolved") {\n' +
  '        const rec = {edit, pageIndex: hit.pageIndex};\n' +
  '        applied.push(rec);\n' +
  '        window.__calls.located.push(rec);\n' +
  '      } else unresolved.push({edit, reason: hit.status});\n' +
  '    }\n' +
  '    return {applied, unresolved};\n' +
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

async function open(browser, viewport, clipboard, share = false) {
  const context = await browser.newContext({viewport, deviceScaleFactor: 2, hasTouch: viewport.width < 600, isMobile: viewport.width < 600});
  await context.route('**/*', serve);
  await context.addInitScript(([mode, share]) => {
    window.__clip = [];
    window.__shared = [];
    window.__shareMode = 'ok';
    if (share) {
      Object.defineProperty(navigator, 'share', {configurable: true, value: data => {
        window.__shared.push(data);
        return window.__shareMode === 'abort' ? Promise.reject(new DOMException('cancel', 'AbortError')) : Promise.resolve();
      }});
      Object.defineProperty(navigator, 'canShare', {configurable: true, value: data => !!data && typeof data.text === 'string'});
    }
    const writeText = mode === 'deny' ? () => Promise.reject(new DOMException('denied', 'NotAllowedError')) : text => { window.__clip.push(text); return Promise.resolve(); };
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}});
    if (mode === 'deny') document.execCommand = () => false;
  }, [clipboard, share]);
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
  return page.evaluate(() => [...document.querySelectorAll('#booth-myai button, #booth-myai a, #booth-myai input, #booth-myai textarea')]
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
  assert.equal(await page.locator('#booth-myai-page').count(), 0, 'no page input');
  assert.equal(await page.locator('#booth-myai input[type="number"]').count(), 0, 'no numeric page input');
  assert.match(await page.locator('#booth-myai-preview').textContent(), /논문 검증 게임/);
  assert.match(await page.locator('.booth-myai-size').textContent(), /^전체 [\d,]+자$/);
  assert.doesNotMatch(await page.locator('.booth-myai-size').textContent(), /원문 포함/);
  assert.equal(await page.locator('#booth-myai-guide').textContent(),
    'AI에 이 PDF를 첨부하고 프롬프트를 붙여 넣으세요. 링크를 읽을 수 있는 AI라면 프롬프트만 붙여 넣어도 돼요.');
  const pdf = page.locator('#booth-myai-pdf');
  assert.equal(await pdf.textContent(), '원문 PDF 받기');
  assert.equal(await pdf.getAttribute('href'), 'https://arxiv.org/pdf/2309.15217');
  assert.equal(await pdf.getAttribute('target'), '_blank');
  assert.equal(await pdf.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await pdf.getAttribute('download'), null, 'no download attribute');
  assert.equal(await pdf.evaluate(n => n.className.includes('ink')), false, 'PDF link is secondary button');
}

async function checkCopy(page) {
  await page.locator('#booth-myai-copy').click();
  await page.waitForFunction(() => window.__clip.length === 1);
  const copied = await page.evaluate(() => window.__clip[0]);
  assert.ok(copied.includes('PDF: https://arxiv.org/pdf/2309.15217'), 'exact arXiv PDF URL');
  assert.ok(copied.includes('{"error":"cannot_read_paper"}'), 'cannot_read clause');
  assert.ok(!copied.includes('Table 1의 점수 하나를 바꿔 보세요'), 'no mission hint in prompt');
  assert.ok(!copied.includes('Ragas 0.95 0.78 0.70'), 'no page text in prompt');
  assert.doesNotMatch(copied, /좋은 결함|0\.95|0\.50/);
  assert.match(copied, /1~5개/);
  assert.match(copied, /"source": "my-ai"/);
  assert.equal(await page.locator('#booth-myai-copy-status').textContent(),
    '복사했어요. AI 채팅에 붙여 넣고, 받은 답을 전부 복사해 오세요.');
  assert.equal(await page.locator('#booth-myai-copy').textContent(), '복사됨 ✓');
  assert.equal(await page.locator('#booth-myai-full').isVisible(), false);
  await page.waitForFunction(() => document.querySelector('#booth-myai-copy').textContent === '다시 복사', null, {timeout: 4000});
  await page.getByRole('button', {name: 'English'}).click();
  await page.locator('#booth-myai-copy').click();
  await page.waitForFunction(() => window.__clip.length === 2);
  const copiedEn = await page.evaluate(() => window.__clip[1]);
  assert.match(copiedEn, /Plant 1 to 5 defects/);
  assert.ok(copiedEn.includes('PDF: https://arxiv.org/pdf/2309.15217'));
  assert.match(copiedEn, /Answer with the JSON object only/);
  assert.doesNotMatch(copiedEn, /[\uac00-\ud7a3]/);
  await page.getByRole('button', {name: '한국어'}).click();
}

async function checkApply(page) {
  assert.equal(await page.locator('#booth-myai-answer').getAttribute('placeholder'),
    'AI 답 전체를 붙여 넣으세요. { "edits": … }가 들어 있으면 돼요. 앞뒤 설명은 괜찮아요.');
  await page.locator('#booth-myai-answer').fill(ANSWER);
  await page.locator('#booth-myai-apply').click();
  await page.locator('.booth-myai-count').waitFor();
  await page.waitForFunction(() => !document.querySelector('#booth-myai-apply').disabled);
  assert.equal(await page.locator('.booth-myai-count').textContent(), '1곳 적용 · 1곳은 직접 골라 주세요');
  assert.match(await page.locator('#booth-myai-result').textContent(), /"0\.99 1\.00" · 찾는 글자가 이 논문에 없어요/);
  assert.match(await page.locator('#booth-myai-result').textContent(), /남은 곳은 바로 아래에서 고칠 수 있어요\.$/);
  assert.doesNotMatch(await page.locator('#booth-myai-result').textContent(), /직접 고치기/, 'no other route');
  const calls = await page.evaluate(() => window.__calls);
  assert.equal(calls.assist.length, 1);
  assert.equal(calls.assist[0][0], 'my-ai');
  assert.equal(calls.apply.length, 1);
  const recipe = calls.apply[0];
  assert.equal(recipe.source, 'my-ai');
  assert.equal(recipe.paperId, '2309.15217');
  assert.deepEqual(recipe.edits[0], {page: 5, find: '0.95', replace: '0.50'});
  // P0-6: the find_missing warning is folded into the result card; the grey box is gone.
  assert.equal(await page.locator('#booth-myai-diags').textContent(), '');
  assert.equal(await page.locator('#booth-myai-diags').isVisible(), false);
}

async function checkZeroAndInterpretation(page) {
  const wrongPage = JSON.stringify({edits: [{page: 1, find: '0.95', replace: '0.50'}], paperId: '2401.00001'});
  await page.locator('#booth-myai-answer').fill(wrongPage);
  await page.locator('#booth-myai-apply').click();
  await page.waitForFunction(() => document.querySelector('.booth-myai-count')?.textContent === '1곳 적용했어요');
  await page.waitForFunction(() => !document.querySelector('#booth-myai-apply').disabled);
  const lastLocated = await page.evaluate(() => window.__calls.located[window.__calls.located.length - 1]);
  assert.equal(lastLocated.pageIndex, 4, 'wrong page number (1) still locates edit on page 5 (pageIndex 4)');
  // An interpretation fix (paperId corrected) keeps its one grey line.
  const notes = await page.locator('#booth-myai-diags li').allTextContents();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /다른 논문 번호\(2401\.00001\)/);
  assert.equal(await page.locator('#booth-myai-diags').isVisible(), true);
}

async function checkShare(page, tag, expected) {
  const button = page.locator('#booth-myai-share');
  if (!expected) return assert.equal(await button.count(), 0, tag + ': share button only on phones with navigator.share');
  assert.equal(await button.textContent(), 'AI 앱으로 보내기');
  assert.equal(await page.locator('#booth-myai-copy').evaluate(n => n.className), 'booth-btn ink wide', 'copy stays primary');
  assert.equal(await button.evaluate(n => n.className.includes('ink')), false, 'share is secondary');
  const order = await page.evaluate(() => { const a = document.querySelector('#booth-myai-copy'); const b = document.querySelector('#booth-myai-share'); return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); });
  assert.ok(order, 'share comes after copy');
  const clips = await page.evaluate(() => window.__clip.length);
  await button.click();
  await page.waitForFunction(() => window.__shared.length === 1);
  const shared = await page.evaluate(() => window.__shared[0]);
  assert.deepEqual(Object.keys(shared), ['text']);
  assert.ok(shared.text.includes('PDF: https://arxiv.org/pdf/2309.15217'));
  assert.ok(!shared.text.includes('Ragas 0.95 0.78 0.70'));
  await page.waitForFunction(n => window.__clip.length === n + 1, clips);
  await page.waitForFunction(() => /^보냈어요\./.test(document.querySelector('#booth-myai-copy-status').textContent));
  await page.locator('#booth-myai-copy').click();
  await page.waitForFunction(() => /^복사했어요/.test(document.querySelector('#booth-myai-copy-status').textContent));
  await page.evaluate(() => { window.__shareMode = 'abort'; });
  await button.click();
  await page.waitForFunction(() => window.__shared.length === 2);
  assert.match(await page.locator('#booth-myai-copy-status').textContent(), /^복사했어요/, 'cancelling the share sheet keeps the status');
}

async function checkErrors(page) {
  const before = await page.evaluate(() => window.__calls.apply.length);
  await page.locator('#booth-myai-answer').fill(FENCE + 'json\n{"error": "cannot_read_paper"}\n' + FENCE);
  await page.locator('#booth-myai-apply').click();
  await page.locator('.booth-myai-diag.error').first().waitFor();
  assert.deepEqual(await page.locator('#booth-myai-diags li').allTextContents(), [
    'AI가 논문을 열지 못했어요. 원문 PDF를 받아 AI에 첨부한 뒤 다시 물어봐 주세요.',
  ]);
  assert.equal(await page.locator('#booth-myai-result').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__calls.apply.length), before, 'cannot_read_paper must not call apply');

  await page.locator('#booth-myai-answer').fill('{"edits": [{"find": "0.95" "replace": "0.50"}]}');
  await page.locator('#booth-myai-apply').click();
  await page.waitForFunction(() => /JSON 모양이 깨져 있어요/.test(document.querySelector('#booth-myai-diags').textContent));
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
    assert.ok(sel.value.includes('PDF: https://arxiv.org/pdf/2309.15217'));
    assert.ok(sel.value.includes('{"error":"cannot_read_paper"}'));
    assert.ok(await overflow(page) <= 0, tag + ': overflow with fallback');
    await shot(page, 'step1-copy-fallback-' + tag);
    assert.equal(errors.join('\n'), '');
  } finally {
    await context.close();
  }
}

async function run(browser, viewport, tag) {
  const {context, page, errors} = await open(browser, viewport, 'record', true);
  try {
    await checkStepOne(page);
    assert.deepEqual(await targets(page), [], tag + ': tap targets under 44px');
    assert.ok(await overflow(page) <= 0, tag + ': horizontal overflow');
    await shot(page, 'step1-' + tag);
    await checkCopy(page);
    await shot(page, 'step1-copied-' + tag);
    await checkShare(page, tag, viewport.width < 600);
    await checkApply(page);
    assert.ok(await overflow(page) <= 0, tag + ': overflow after apply');
    await page.locator('#booth-myai-answer').scrollIntoViewIfNeeded();
    await shot(page, 'step2-applied-' + tag);
    await checkZeroAndInterpretation(page);
    await shot(page, 'step2-applied-zero-' + tag);
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

/* plan97s-7: Ask my AI resets on paper change or document-clear, keeps state on same paper */
async function state(page) {
  return page.evaluate(() => ({
    answer: document.querySelector('#booth-myai-answer').value,
    resultHidden: document.querySelector('#booth-myai-result').hidden,
    result: document.querySelector('#booth-myai-result').textContent,
    diags: document.querySelector('#booth-myai-diags').children.length,
    copy: document.querySelector('#booth-myai-copy').textContent,
    copyStatus: document.querySelector('#booth-myai-copy-status').textContent,
    full: document.querySelector('#booth-myai-full').hidden,
    pdf: document.querySelector('#booth-myai-pdf').getAttribute('href'),
  }));
}
const fire = (page, name, detail) => page.evaluate(([n, d]) => document.dispatchEvent(d ? new CustomEvent(n, {detail: d}) : new Event(n)), [name, detail]);
async function applyOnce(page) {
  await page.locator('#booth-myai-copy').click();
  await page.waitForFunction(() => document.querySelector('#booth-myai-copy').textContent === '복사됨 ✓');
  await page.locator('#booth-myai-answer').fill(ANSWER);
  await page.locator('#booth-myai-apply').click();
  await page.waitForFunction(() => /곳 적용/.test(document.querySelector('#booth-myai-result').textContent));
}
async function checkReset(browser, viewport, tag) {
  const {context, page, errors} = await open(browser, viewport, 'record');
  try {
    await applyOnce(page);
    const kept = await state(page);
    assert.equal(kept.resultHidden, false);
    // same paper: lang toggle, re-index, same-hash source event, re-mount (tab switch)
    await fire(page, 'falsify:booth-lang-change', {lang: 'en'});
    await fire(page, 'falsify:booth-lang-change', {lang: 'ko'});
    await fire(page, 'falsify:booth-index-ready');
    await fire(page, 'falsify:paper-workspace-source', {fileHash: 'a'.repeat(64), name: 'x.pdf'});
    await fire(page, 'falsify:paper-workspace-source', {fileHash: 'a'.repeat(64), name: 'x.pdf'});
    await page.evaluate(() => { window.__mount2 = FalsifyBoothMyAI.mount(document.getElementById('booth-myai')); });
    const same = await state(page);
    assert.equal(same.answer, ANSWER, tag + ': answer kept on same paper');
    assert.equal(same.resultHidden, false, tag + ': result kept');
    assert.equal(same.result, kept.result);
    assert.equal(same.diags, kept.diags);
    assert.notEqual(same.copy, '복사', tag + ': copy label kept');
    assert.equal(same.copyStatus, kept.copyStatus);
    // paper switch signalled only by the source event
    await page.evaluate(() => { window.__paperId = '2611.16180'; });
    await fire(page, 'falsify:paper-workspace-source', {fileHash: 'b'.repeat(64), name: 'y.pdf'});
    const switched = await state(page);
    assert.deepEqual([switched.answer, switched.resultHidden, switched.result, switched.diags, switched.copy, switched.copyStatus, switched.full],
      ['', true, '', 0, '복사', '', true], tag + ': reset on paper switch');
    assert.equal(switched.pdf, 'https://arxiv.org/pdf/2611.16180');
    // retry on the same paper: document-clear alone
    await applyOnce(page);
    await fire(page, 'falsify:document-clear');
    const cleared = await state(page);
    assert.deepEqual([cleared.answer, cleared.resultHidden, cleared.diags, cleared.copy, cleared.copyStatus], ['', true, 0, '복사', ''], tag + ': reset on document-clear');
    // copy timer cancelled: label must not flip to 다시 복사 later
    await page.waitForTimeout(2300);
    assert.equal((await state(page)).copy, '복사', tag + ': timer cancelled');
    // an apply that re-opens its own paper (same id) keeps the answer and shows its result
    await page.evaluate(() => { window.__recipe.mode = 'slow'; });
    await page.locator('#booth-myai-answer').fill(ANSWER);
    await page.locator('#booth-myai-apply').click();
    await fire(page, 'falsify:document-clear');
    await page.waitForFunction(() => !document.querySelector('#booth-myai-apply').disabled);
    await page.waitForTimeout(100);
    const selfOpen = await state(page);
    assert.equal(selfOpen.answer, ANSWER, tag + ': same-paper clear during apply keeps the answer');
    assert.equal(selfOpen.resultHidden, false, tag + ': same-paper clear during apply shows the result');
    // an in-flight apply cannot paint into Step 2 after a switch to another paper
    await page.locator('#booth-myai-apply').click();
    await page.evaluate(() => { window.__paperId = '2309.15217'; });
    await fire(page, 'falsify:document-clear');
    await page.waitForFunction(() => !document.querySelector('#booth-myai-apply').disabled);
    await page.waitForTimeout(100);
    const afterSlow = await state(page);
    assert.equal(afterSlow.answer, '', tag + ': in-flight apply stays cleared');
    assert.equal(afterSlow.resultHidden, true, tag + ': in-flight apply does not paint late result');
    assert.equal(afterSlow.result, '', tag + ': in-flight apply leaves result empty');
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
      await checkReset(browser, viewport, tag);
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
