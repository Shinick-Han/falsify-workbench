'use strict';
// Real Chromium walk of the event.html booth steps (pick, edit, send, ticket). The API is stubbed. FALSIFY_BOOTH_MISSION_PDF names a local copy of arXiv 2309.15217 (CC BY 4.0).
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
const port = Number(process.env.BOOTH_EVENT_PORT || 8877);
const token = 'fsg_' + 'a'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);

function serve() {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: dist, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PYTHONUNBUFFERED: '1'},
  });
  let text = '';
  const take = chunk => { text += chunk.toString(); };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const ready = (async () => {
    const started = Date.now();
    while (Date.now() - started < 8000) {
      if (child.exitCode != null) throw new Error('http.server exited ' + child.exitCode + '\n' + text);
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/event.html');
        if (res.ok) return;
      } catch { /* not listening yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('http.server did not start\n' + text);
  })();
  return {child, ready};
}

function json(route, status, body) {
  return route.fulfill({status, contentType: 'application/json', headers: cors, body: JSON.stringify(body)});
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const PENDING = {receipt: 'F-0042', status: 'reviewing', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00.000Z', published: false};
const MISSED = {
  receipt: 'F-0042', status: 'judged', course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00.000Z',
  published: true, outcome: 'missed', publicNote: 'AI는 다른 곳을 짚었습니다. AI가 먼저 본 곳은 7쪽이었고, 심어 둔 결함은 AI 눈을 피했습니다.',
  prizeMessage: '부스에서 스티커를 받아 가세요', publishedAt: '2026-11-22T01:02:00.000Z',
};

async function stubApi(route, submissions, claims) {
  const request = route.request();
  const url = new URL(request.url());
  if (!url.href.startsWith(api)) return route.abort();
  if (request.method() === 'OPTIONS') {
    return route.fulfill({status: 204, headers: cors});
  }
  if (request.method() === 'POST' && url.pathname === '/v1/ai/guest') {
    return json(route, 200, {guest: {token, expiresAt: new Date(Date.now() + 864e5).toISOString()}});
  }
  if (url.pathname === '/v1/ai/capabilities') {
    return json(route, 200, {
      enabled: true, provider: 'anthropic', execution: 'server',
      models: ['claude-opus-5-5'], efforts: ['high'],
      limits: {maxUploadBytes: 33554432, maxPromptChars: 8000},
      modelJobs: false, blueJobs: false,
    });
  }
  if (url.pathname === '/v1/booth/config') {
    return json(route, 200, {
      enabled: true, submissionsOpen: true, announcement: '행사 안내', consentVersion: '2026-11-22.v2',
      limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216},
      missions: [{
        paperId: '2309.15217',
        title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
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
  if (request.method() === 'POST' && url.pathname === '/v1/booth/submissions') {
    let body = Buffer.alloc(0);
    try { body = request.postDataBuffer() || Buffer.alloc(0); } catch { body = Buffer.alloc(0); }
    submissions.push(body);
    return json(route, 201, {
      receipt: 'F-0042', claimKey: '7Q3K-M9XD', status: 'received',
      course: 'quick', declaredCount: 1, createdAt: '2026-11-22T01:00:00.000Z',
    });
  }
  if (request.method() === 'POST' && url.pathname === '/v1/booth/claim') {
    claims.push(JSON.parse(request.postData() || '{}'));
    return json(route, 200, claims.length <= 2 ? PENDING : MISSED);
  }
  return json(route, 404, {error: {code: 'not_found'}});
}

/* Visible buttons and links in the selector need a 44px box; the page must not scroll sideways. */
async function phoneAudit(page, selector) {
  return page.evaluate(scope => {
    const small = [...document.querySelectorAll(scope + ' button, ' + scope + ' a.button')]
      .filter(node => node.offsetParent !== null)
      .map(node => ({text: node.textContent.trim(), rect: node.getBoundingClientRect()}))
      .filter(item => item.rect.width < 44 || item.rect.height < 44)
      .map(item => item.text + ' ' + Math.round(item.rect.width) + 'x' + Math.round(item.rect.height));
    const seen = document.querySelectorAll(scope + ' button, ' + scope + ' a.button');
    return {small, seen: [...seen].filter(node => node.offsetParent !== null).length, overflow: document.documentElement.scrollWidth - window.innerWidth};
  }, selector);
}

/* Steps the booth reports on <html data-booth-step>. */
function stepIs(page, name) {
  return page.waitForFunction(value => document.documentElement.dataset.boothStep === value, name);
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  const pageErrors = [];
  const submissions = [];
  const claims = [];
  try {
  await server.ready;
  browser = await chromium.launch({
    executablePath: chrome, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({
      viewport: {width: 390, height: 844}, deviceScaleFactor: 1, hasTouch: true, locale: 'ko-KR',
    });
    page.setDefaultTimeout(90000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => { void dialog.accept(); });
    await page.clock.install({time: new Date('2026-11-22T00:59:30.000Z')});
    const base = 'http://127.0.0.1:' + port + '/';
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(base)) return route.continue();
      return stubApi(route, submissions, claims);
    });
    await page.goto(base + 'event.html');

    // pick: one mission ticket loads the paper, jumps to the hint page and opens edit.
    const mission = page.locator('#booth-missions .booth-mission').first();
    await mission.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'pick');
    assert.equal(await page.locator('.rail [data-view="blue"]').isHidden(), true);
    assert.match(await page.locator('#booth-title').textContent(), /AI를 속일 수\s*있을까요\?/);
    assert.match(await mission.textContent(), /arXiv 2309\.15217 · CC BY 4\.0/);
    assert.match(await mission.textContent(), /5쪽도전 →/);
    assert.equal(await page.locator('#booth-search').isVisible(), false);
    await mission.click();
    await stepIs(page, 'edit');
    await page.waitForFunction(() => [...document.querySelectorAll('.paper-paragraph-button')].some(node => node.textContent.includes('0.95')));
    assert.match(await page.locator('#booth-hint').textContent(), /^힌트 · Table 1의 점수 하나를 바꿔 보세요/);
    assert.equal(await page.locator('#booth-dock-count').textContent(), '고친 곳 0개');
    assert.equal(await page.locator('#booth-next').isDisabled(), true);

    // edit: change one paragraph; the dock counts it and enables 다음. The paragraph list sits
    // collapsed under the find-and-replace form (booth-recipe.js) until 「문단 목록에서 고르기」.
    const listToggle = page.locator('#booth-find-list');
    if (await listToggle.count()) {
      assert.equal(await page.locator('.paper-paragraph-list').first().isVisible(), false);
      await listToggle.click();
    }
    const paragraphIndex = await page.evaluate(() => {
      const hits = [...document.querySelectorAll('.paper-paragraph-button')].map((node, index) => ({
        index, length: node.textContent.length, text: node.textContent,
      })).filter(item => item.text.includes('0.95') && item.text.includes('0.78') && item.length <= 400);
      hits.sort((a, b) => a.length - b.length);
      return hits.length ? hits[0].index : -1;
    });
    assert.equal(paragraphIndex >= 0, true);
    const paragraph = page.locator('.paper-paragraph-button').nth(paragraphIndex);
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.click();
    const editor = page.locator('textarea[aria-label$="직접 편집"]');
    await editor.waitFor();
    const original = await editor.inputValue();
    assert.equal(original.includes('0.95'), true);
    await editor.fill(original.replace('0.95', '0.50'));
    await page.locator('.paper-direct-controls').getByRole('button', {name: '완료', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
    assert.equal(await page.locator('#booth-next').isEnabled(), true);
    const dock = await page.locator('#booth-dock').boundingBox();
    assert.equal(Math.round(dock.y + dock.height), 844, 'dock is fixed to the bottom');

    // 다음 builds the submission PDF itself, then opens send.
    await page.locator('#booth-next').click();
    await stepIs(page, 'send');
    assert.equal(await page.locator('#booth-make').count(), 0);
    assert.equal(await page.locator('#booth-courses').count(), 0);
    const card = page.locator('#booth-rows .booth-card').first();
    assert.match(await card.locator('.booth-klab').first().textContent(), /^내가 숨긴 결함 · \d+쪽$/);
    assert.equal(await card.locator('del').textContent(), '0.95');
    assert.equal(await card.locator('ins').textContent(), '0.50');
    assert.equal((await card.locator('.booth-diff').textContent()).length < 80, true, 'diff shows only the changed region');
    assert.match(await card.textContent(), /이 설명은 AI에게 보내지 않아요/);
    await card.getByRole('button', {name: '수치·통계'}).click();
    assert.equal(await card.getByRole('button', {name: '수치·통계'}).getAttribute('aria-pressed'), 'true');
    await card.locator('textarea').fill('표의 점수를 0.95에서 0.50으로 바꿨습니다');
    assert.equal(await page.locator('#booth-consent-summary li').count(), 3);
    assert.equal(await page.locator('#booth-consent-summary li').first().textContent(), '수정본 PDF만 AI(Anthropic)에 보내요.');
    assert.equal(await page.locator('#booth-consent-copy').isVisible(), false);
    await page.locator('#booth-consent-full summary').click();
    assert.match(await page.locator('#booth-consent-copy').textContent(), /제출하면 바로 수정본 PDF만 AI 검증을 위해 모델 제공자\(Anthropic\)에 보내고/);
    assert.equal(await page.locator('#booth-consent-version').textContent(), '동의 버전 · 2026-11-22.v2');
    assert.equal(await page.locator('#booth-submit-button').isDisabled(), true);
    await page.locator('#booth-consent').check();
    assert.equal(await page.locator('#booth-submit-button').textContent(), 'AI에게 제출하기');
    await page.setViewportSize({width: 360, height: 780});
    const sendAudit = await phoneAudit(page, '#booth');
    assert.deepEqual(sendAudit.small, []);
    assert.equal(sendAudit.overflow <= 0, true, 'send overflow ' + sendAudit.overflow);
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#booth-submit-button').click();

    // ticket: waiting, then the stub publishes missed with a prize message.
    const submitted = await page.waitForFunction(() => {
      if (document.documentElement.dataset.boothStep === 'ticket') return 'ok';
      const status = document.querySelector('#booth-submit-status')?.textContent || '';
      if (status && status !== '제출하는 중…') return status;
      return null;
    }, null, {timeout: 20000}).then(handle => handle.jsonValue());
    assert.equal(submitted, 'ok');
    assert.equal(await page.locator('#booth-receipt-code').textContent(), 'F-0042');
    assert.equal(await page.locator('#booth-claim-code').textContent(), '7Q3K-M9XD');
    assert.equal(await page.locator('#booth-ticket-paper').textContent(), 'Ragas');
    assert.match(await page.locator('#booth-ticket-pages').textContent(), /^\d+쪽 · 1곳$/);
    assert.equal(await page.locator('.rail [data-view="blue"]').isHidden(), true);
    assert.equal(submissions.length, 1);
    const posted = submissions[0].toString('utf8');
    assert.equal(posted.includes('edited.pdf'), true);
    assert.equal(posted.includes('0.50'), true);
    assert.equal(posted.includes('0.95'), true);
    assert.equal(posted.includes('2026-11-22.v2'), true);
    assert.equal(posted.includes('"course":"quick"'), true);
    assert.equal(posted.includes('"defectType":"number"'), true);
    assert.equal(await page.locator('#booth-ticket-wait').isVisible(), true);
    assert.equal(await page.locator('#booth-ticket-steps').textContent(), '수정본 받음AI가 앞뒤 문장과 표를 대조하는 중결과');
    assert.match(await page.locator('#booth-live-capture').textContent(), /^이 티켓을 캡처해 두세요/);
    assert.match(await page.locator('#booth-ticket-elapsed').textContent(), /^\d+:\d\d$/);
    assert.equal(await page.locator('#booth-barcode').isVisible(), true);
    assert.equal(await page.locator('#booth-live-again').isHidden(), true);
    for (let round = 1; round <= 3; round += 1) {
      await page.clock.fastForward(15000);
      const started = Date.now();
      while (claims.length < round && Date.now() - started < 10000) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(claims.length, round);
    }
    assert.deepEqual(claims[0], {receipt: 'F-0042', claimKey: '7Q3K-M9XD'});
    await page.waitForFunction(() => document.querySelector('#booth-live-title')?.textContent === 'AI가 못 찾았어요');
    assert.equal(await page.locator('#booth-live-title b').textContent(), '못 찾았어요');
    assert.equal(await page.locator('#booth-stamp-word').textContent(), '통과');
    assert.equal(await page.locator('#booth-stamp').getAttribute('class'), 'booth-stamp pass');
    assert.equal(await page.locator('#booth-ticket-wait').isHidden(), true);
    assert.equal(await page.locator('#booth-ticket-duration').textContent(), '2분');
    assert.equal(await page.locator('#booth-gift').isVisible(), true);
    assert.equal(await page.locator('#booth-live-prize').textContent(), '부스에서 스티커를 받아 가세요');
    assert.match(await page.locator('#booth-gift').textContent(), /교환권 · 1인 1회/);
    assert.match(await page.locator('#booth-live-note').textContent(), /AI가 먼저 본 곳은 7쪽이었고/);
    const again = page.locator('#booth-live-again');
    assert.equal(await again.isVisible(), true);
    assert.equal(await again.textContent(), '다시 도전하기 · 기회 4번 남음');
    assert.match(await page.locator('#booth-history').textContent(), /F-0042 · Ragas통과/);
    await page.setViewportSize({width: 360, height: 780});
    const audit = await phoneAudit(page, '#booth');
    assert.deepEqual(audit.small, []);
    assert.equal(audit.seen >= 3, true);
    assert.equal(audit.overflow <= 0, true, 'horizontal overflow ' + audit.overflow);
    await page.clock.fastForward(60000);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(claims.length, 3);

    // 다시 도전하기 resets the paper the way the old retry did and returns to pick.
    await again.click();
    await stepIs(page, 'pick');
    assert.equal(await page.locator('#booth-receipt').isHidden(), true);
    assert.equal(await page.locator('#booth-submit').isHidden(), true);
    assert.equal(await page.locator('#booth-missions').isVisible(), true);
    assert.equal(await page.locator('#booth-consent').isChecked(), false);
    assert.equal(await page.locator('#paper-file').inputValue(), '');
    await page.locator('#booth-result-link').click();
    await page.locator('#booth-receipts-list').getByRole('button', {name: /F-0042/}).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'pick');
    assert.equal(await page.locator('#booth-landing').isHidden(), true);
    const resultAudit = await phoneAudit(page, '#booth-result');
    assert.deepEqual(resultAudit.small, []);
    assert.equal(resultAudit.seen >= 2, true);
    assert.equal(resultAudit.overflow <= 0, true, 'result overflow ' + resultAudit.overflow);
    assert.equal(pageErrors.join('\n'), '');
  } catch (error) {
    const shot = '/tmp/booth-event-browser.png';
    const open = browser.contexts()[0] && browser.contexts()[0].pages()[0];
    if (open) await open.screenshot({path: shot, fullPage: true}).catch(() => {});
    const note = open ? await open.evaluate(() => ({
      step: document.documentElement.dataset.boothStep,
      dock: document.querySelector('#booth-dock-status')?.textContent || '',
      status: document.querySelector('#booth-submit-status')?.textContent || '',
      mission: document.querySelector('#booth-mission-status')?.textContent || '',
      gen: document.querySelector('#paper-generate-status')?.textContent || '',
      edit: document.querySelector('#paper-edit-status')?.textContent || '',
      before: document.querySelector('#paper-before-status')?.textContent || '',
    })).catch(() => null) : null;
    error.message += '\npage=' + JSON.stringify(note) + '\nerrors=' + pageErrors.join(' | ');
    throw error;
  } finally {
    if (browser) await browser.close();
  }
  } finally {
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth event browser passed'); }, error => {
  console.error(error && error.message);
  console.error(error);
  process.exit(1);
});
