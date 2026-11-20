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
/* Optional: BOOTH_SHOT_DIR saves pick, send-consent, ticket-missed and withdraw-confirm screenshots per viewport. */
const shotDir = process.env.BOOTH_SHOT_DIR || '';

async function shot(page, name, viewport) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, {recursive: true});
  await page.screenshot({path: path.join(shotDir, name + '-' + viewport.width + 'x' + viewport.height + '.png'), fullPage: true});
}

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
  published: true, outcome: 'missed', publicNote: 'AI는 다른 곳을 짚었어요. AI가 먼저 본 곳은 7쪽이었고, 심어 둔 결함은 AI 눈을 피했어요.',
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
      enabled: true, submissionsOpen: true, announcement: '행사 안내', consentVersion: '2026-11-22.v3',
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
  if (url.pathname === '/v1/booth/claim' && (request.method() === 'GET' || request.method() === 'POST')) {
    // Result polls are a GET with the receipt and key in the query (no preflight); POST is the fallback.
    claims.push(request.method() === 'GET'
      ? {receipt: url.searchParams.get('receipt'), claimKey: url.searchParams.get('key')}
      : JSON.parse(request.postData() || '{}'));
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

/* Desktop (>=1024px): the top bar shows the step, the phone bars are hidden, nothing scrolls sideways.
   Phones: no desktop node is visible, so the phone pass keeps its alpha.86 layout. */
async function deskChecks(page, desk, current) {
  const seen = await page.evaluate(() => ({
    bar: !!document.querySelector('#booth-deskbar')?.offsetParent,
    steps: [1, 2, 3].map(n => document.querySelector('#booth-desk-step-' + n)?.className || ''),
    current: document.querySelector('#booth-desk-steps [aria-current="step"]')?.id || '',
    desktopNodes: [...document.querySelectorAll('#booth .booth-desk')].filter(node => node.offsetParent !== null).length,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  assert.equal(seen.overflow <= 0, true, 'horizontal overflow ' + seen.overflow);
  if (!desk) {
    assert.equal(seen.bar, false, 'no desktop top bar on phones');
    assert.equal(seen.desktopNodes, 0, 'no desktop-only node on phones');
    return;
  }
  assert.equal(seen.bar, true, 'desktop top bar');
  assert.deepEqual(seen.steps, [1, 2, 3].map(n => n === current ? 'on' : n < current ? 'done' : ''));
  assert.equal(seen.current, 'booth-desk-step-' + current);
  assert.equal(await page.locator('.booth-stepbar-row b:visible, .booth-prog:visible, .booth-top:visible').count(), 0, 'phone step bars are hidden');
}

/* One full pass: pick, edit, send, ticket. desk is the >=1024px layout in booth.css. */
async function walk(browser, viewport, desk, pageErrors) {
  const submissions = [];
  const claims = [];
  const page = await browser.newPage({
    viewport, deviceScaleFactor: 1, hasTouch: !desk, locale: 'ko-KR',
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
  assert.equal(await page.locator('#booth-search').isVisible(), desk, 'search is a closed disclosure on phones, one open row on desktop');
  await deskChecks(page, desk, 1);
  // Rules before the first tap (ux-booth P0-1): the line under the hero and the 01/02/03 how-to, on phones too.
  const limit = page.locator('#booth-pick-limit');
  assert.equal(await limit.textContent(), '1인 5번까지 · 이름·연락처는 받지 않아요');
  assert.equal(await limit.isVisible(), true, 'the rules line is visible');
  assert.equal(await page.locator('#booth-howto').isVisible(), true, 'the how-to is visible');
  assert.equal(await page.locator('#booth-howto li').count(), 3);
  assert.doesNotMatch(await page.locator('#booth-step-pick').textContent(), /2분 안에/);
  if (!desk) {
    const hero = await page.locator('.booth-hero').boundingBox();
    const line = await limit.boundingBox();
    const howto = await page.locator('#booth-howto').boundingBox();
    assert.equal(line.y >= hero.y + hero.height && howto.y >= line.y + line.height, true, 'hero, then the rules line, then the how-to');
    assert.equal(line.y + line.height <= viewport.height, true, 'the rules line is above the fold');
  }
  await shot(page, 'pick', viewport);
  await mission.click();
  await stepIs(page, 'edit');
  // blind-pdf.js trust skip: booth.js holds the one-time capability, so no page script can claim it.
  assert.equal(await page.evaluate(() => globalThis.FalsifyBlindPdf.claimTrust()), null, 'the trust capability is already claimed');
  assert.equal(await page.evaluate(() => typeof globalThis.FalsifyBlindPdf.trust), 'undefined');
  await page.waitForFunction(() => [...document.querySelectorAll('.paper-paragraph-button')].some(node => node.textContent.includes('0.95')));
  assert.match(await page.locator('#booth-hint').textContent(), /^힌트 · Table 1의 점수 하나를 바꿔 보세요/);
  assert.equal(await page.locator('#booth-dock-count').textContent(), '고친 곳 0개');
  assert.equal(await page.locator('#booth-next').isDisabled(), true);

  // edit: change one paragraph; the dock counts it and enables 다음. On event.html the page itself is the
  // editor (booth-pageedit.js); the paragraph list stays for screen readers and keyboards, visually hidden
  // until it holds focus, so this walk opens the paragraph through it. Phones open zoomed: zoom out first.
  assert.equal(await page.locator('#booth-find-list').count(), 0);
  if (await page.locator('#booth-pe-fit').isVisible()) {
    await page.locator('#booth-pe-fit').click();
    await page.waitForFunction(() => globalThis.FalsifyPaperWorkspace.getZoom() === 1);
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.paper-paragraph-button')].some(node => node.textContent.includes('0.95') && node.textContent.includes('0.78')));
  const paragraphIndex = await page.evaluate(() => {
    const hits = [...document.querySelectorAll('.paper-paragraph-button')].map((node, index) => ({
      index, length: node.textContent.length, text: node.textContent,
    })).filter(item => item.text.includes('0.95') && item.text.includes('0.78') && item.length <= 400);
    hits.sort((a, b) => a.length - b.length);
    return hits.length ? hits[0].index : -1;
  });
  assert.equal(paragraphIndex >= 0, true);
  const paragraph = page.locator('.paper-paragraph-button').nth(paragraphIndex);
  await paragraph.focus();
  await page.keyboard.press('Enter');
  const editor = page.locator('textarea[aria-label$="직접 편집"]');
  await editor.waitFor();
  const original = await editor.inputValue();
  assert.equal(original.includes('0.95'), true);
  await editor.fill(original.replace('0.95', '0.50'));
  await page.locator('.paper-direct-controls').getByRole('button', {name: '완료', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
  assert.equal(await page.locator('#booth-next').isEnabled(), true);
  const dock = await page.locator('#booth-dock').boundingBox();
  assert.equal(Math.round(dock.y + dock.height), viewport.height, 'dock is fixed to the bottom');
  await deskChecks(page, desk, 2);
  if (desk) {
    assert.equal(Math.round(dock.width), viewport.width, 'the desktop dock spans the viewport');
    // A second edit, then delete it from the dock: the workspace's own 삭제 runs and the count drops.
    const otherIndex = await page.evaluate(() => [...document.querySelectorAll('.paper-paragraph-button')]
      .findIndex(node => !node.textContent.includes('0.95') && node.textContent.trim().length >= 20 && node.textContent.length <= 400));
    assert.equal(otherIndex >= 0, true);
    const other = page.locator('.paper-paragraph-button').nth(otherIndex);
    await other.focus();
    await page.keyboard.press('Enter');
    await editor.waitFor();
    await editor.fill((await editor.inputValue()) + ' extra');
    await page.locator('.paper-direct-controls').getByRole('button', {name: '완료', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 2개');
    const chipList = page.locator('#booth-dock-chips .booth-dock-chip');
    assert.equal(await chipList.count(), 2);
    const extra = chipList.filter({hasNotText: '0.95'}).locator('.booth-dock-x');
    assert.match(await extra.getAttribute('aria-label'), /^\d+쪽 고친 곳 지우기$/);
    const xBox = await extra.boundingBox();
    assert.equal(xBox.width >= 32 && xBox.height >= 32, true, 'the × hit area is at least 32px');
    await extra.click();
    await page.waitForFunction(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개');
    assert.equal(await chipList.count(), 1);
    assert.match(await page.locator('#booth-dock-chips').textContent(), /^\d+쪽0\.95→0\.50×$/);
    assert.equal(await page.locator('#booth-dock-chips del').textContent(), '0.95');
    assert.equal(await page.locator('#booth-dock-back').isVisible(), true);
    assert.equal(await page.locator('#booth-edit-back').isVisible(), false);
    assert.equal(await page.locator('#booth-hint').isVisible(), true);
  }

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
  assert.match(await card.textContent(), /이 설명은 AI에게 보내지 않고 운영진만 봐요\./);
  await card.getByRole('button', {name: '수치·통계'}).click();
  assert.equal(await card.getByRole('button', {name: '수치·통계'}).getAttribute('aria-pressed'), 'true');
  await card.locator('textarea').fill('표의 점수를 0.95에서 0.50으로 바꿨습니다');
  assert.equal(await page.locator('#booth-consent-summary li').count(), 3);
  assert.equal(await page.locator('#booth-consent-summary li').first().textContent(), '수정본 PDF만 AI(Anthropic)에 보내요.');
  assert.equal(await page.locator('#booth-consent-copy').isVisible(), false);
  await page.locator('#booth-consent-full summary').click();
  assert.match(await page.locator('#booth-consent-copy').textContent(), /제출하면 수정본 PDF만 AI 검증을 위해 모델 제공자\(Anthropic\)에 바로 보내고/);
  assert.doesNotMatch(await page.locator('#booth-consent-copy').textContent(), /OpenAI/);
  assert.equal(await page.locator('#booth-consent-version').textContent(), '동의 버전 · 2026-11-22.v3');
  await shot(page, 'send-consent', viewport);
  assert.equal(await page.locator('#booth-submit-button').isDisabled(), true);
  await page.locator('#booth-consent').check();
  assert.equal(await page.locator('#booth-submit-button').textContent(), 'AI에게 제출하기');
  await deskChecks(page, desk, 3);
  if (desk) {
    const rows = await page.locator('#booth-rows').boundingBox();
    const side = await page.locator('#booth-send-ticket').boundingBox();
    const submitBox = await page.locator('#booth-submit-button').boundingBox();
    assert.equal(side.x >= rows.x + rows.width, true, 'the SUBMISSION ticket sits right of the declarations');
    assert.equal(submitBox.x >= side.x && submitBox.x + submitBox.width <= side.x + side.width + 0.5, true, 'submit lives in the ticket');
    assert.equal(await page.locator('#booth-send-paper').textContent(), 'Ragas: Automated Evaluation of Retrieval Augmented Generation');
  } else {
    await page.setViewportSize({width: 360, height: 780});
    const sendAudit = await phoneAudit(page, '#booth');
    assert.deepEqual(sendAudit.small, []);
    assert.equal(sendAudit.overflow <= 0, true, 'send overflow ' + sendAudit.overflow);
    await page.setViewportSize(viewport);
  }
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
  assert.equal(posted.includes('2026-11-22.v3'), true);
  assert.equal(posted.includes('"course":"quick"'), true);
  assert.equal(posted.includes('"defectType":"number"'), true);
  assert.equal(await page.locator('#booth-ticket-wait').isVisible(), true);
  assert.equal(await page.locator('#booth-ticket-steps').textContent(), '수정본 받음AI가 앞뒤 문장과 표를 대조하는 중결과');
  assert.match(await page.locator('#booth-live-capture').textContent(), /^이 티켓을 캡처해 두세요/);
  assert.match(await page.locator('#booth-ticket-elapsed').textContent(), /^\d+:\d\d$/);
  assert.equal(await page.locator('#booth-barcode').isVisible(), true);
  assert.equal(await page.locator('#booth-live-again').isHidden(), true);
  await deskChecks(page, desk, 3);
  if (desk) {
    const stub = await page.locator('#booth-ticket-stub').boundingBox();
    const bars = await page.locator('#booth-barcode').boundingBox();
    assert.equal(bars.x >= stub.x && bars.y >= stub.y && bars.y + bars.height <= stub.y + stub.height, true, 'the barcode sits in the stub');
    assert.equal(await page.locator('#booth-stub-receipt').textContent(), 'F-0042');
    assert.equal(await page.locator('#booth-copy').isVisible(), true);
  }
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
  await deskChecks(page, desk, 3);
  // 최종 추첨 (ux-booth P0-2): on a 통과 result phones see it too, under the gift ticket.
  assert.equal(await page.locator('#booth-final').isVisible(), true, '최종 추첨 is visible');
  assert.match(await page.locator('#booth-final').textContent(), /^최종 추첨/);
  if (!desk) {
    const giftBox = await page.locator('#booth-gift').boundingBox();
    const finalBox = await page.locator('#booth-final').boundingBox();
    assert.equal(finalBox.y >= giftBox.y + giftBox.height, true, 'the draw card follows the gift ticket');
    assert.equal(finalBox.x >= 0 && finalBox.x + finalBox.width <= viewport.width, true, 'the draw card fits the phone column');
  }
  await shot(page, 'ticket-missed', viewport);
  if (desk) {
    const ticketBox = await page.locator('#booth-ticket').boundingBox();
    const result = await page.locator('#booth-ticket-result').boundingBox();
    const stamp = await page.locator('#booth-stamp').boundingBox();
    assert.equal(Math.round(ticketBox.width), 960, 'the boarding pass is 960px wide');
    assert.equal(result.x >= ticketBox.x + ticketBox.width - 251, true, 'the result stub is the 250px right part');
    assert.equal(stamp.x >= result.x && stamp.x + stamp.width <= result.x + result.width, true, 'the stamp sits in the stub');
    const gift = await page.locator('#booth-gift').boundingBox();
    const title = await page.locator('#booth-live-title').boundingBox();
    assert.equal(gift.x > title.x + title.width, true, 'the gift ticket is the right column');
    assert.equal(await page.locator('#booth-live-records').isVisible(), true);
  } else {
    await page.setViewportSize({width: 360, height: 780});
    const audit = await phoneAudit(page, '#booth');
    assert.deepEqual(audit.small, []);
    assert.equal(audit.seen >= 3, true);
    assert.equal(audit.overflow <= 0, true, 'horizontal overflow ' + audit.overflow);
  }
  // Withdraw asks once (ux-booth P0-6): 취소 and a fail-outline 철회하기 replace the first button, under the warning.
  await page.setViewportSize(viewport);
  await page.locator('#booth-withdraw-box > summary').click();
  await page.locator('#booth-withdraw').click();
  const ask = page.locator('#booth-withdraw-ask');
  assert.equal(await ask.isVisible(), true);
  assert.equal(await page.locator('#booth-withdraw').isHidden(), true, 'the first button gives way');
  assert.match(await ask.textContent(), /^철회하면 되돌릴 수 없고, 선물과 추첨 기회도 함께 사라져요\./);
  const confirmLook = await page.locator('#booth-withdraw-confirm').evaluate(node => {
    const style = getComputedStyle(node);
    return {color: style.color, border: style.borderTopColor, background: style.backgroundColor};
  });
  assert.deepEqual(confirmLook, {color: 'rgb(138, 48, 48)', border: 'rgb(138, 48, 48)', background: 'rgba(0, 0, 0, 0)'});
  const cancelBox = await page.locator('#booth-withdraw-cancel').boundingBox();
  const confirmBox = await page.locator('#booth-withdraw-confirm').boundingBox();
  assert.equal(cancelBox.height >= 44 && confirmBox.height >= 44, true, '44px targets');
  await ask.scrollIntoViewIfNeeded();
  await shot(page, 'withdraw-confirm', viewport);
  await page.locator('#booth-withdraw-cancel').click();
  assert.equal(await ask.isHidden(), true);
  assert.equal(await page.locator('#booth-withdraw').isVisible(), true);
  await page.locator('#booth-withdraw-box > summary').click();
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
  await page.locator(desk ? '#booth-desk-records' : '#booth-result-link').click();
  await page.locator('#booth-receipts-list').getByRole('button', {name: /F-0042/}).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.boothStep), 'pick');
  assert.equal(await page.locator('#booth-landing').isHidden(), true);
  const resultAudit = await phoneAudit(page, '#booth-result');
  assert.deepEqual(resultAudit.small, []);
  assert.equal(resultAudit.seen >= 2, true);
  assert.equal(resultAudit.overflow <= 0, true, 'result overflow ' + resultAudit.overflow);
  await deskChecks(page, desk, 1);
  await page.close();
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  const pageErrors = [];
  try {
  await server.ready;
  browser = await chromium.launch({
    executablePath: chrome, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    await walk(browser, {width: 390, height: 844}, false, pageErrors);
    await walk(browser, {width: 1280, height: 800}, true, pageErrors);
    assert.equal(pageErrors.join('\n'), '');
  } catch (error) {
    const shot = '/tmp/booth-event-browser.png';
    const contexts = browser.contexts();
    const last = contexts[contexts.length - 1];
    const open = last && last.pages()[0];
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
