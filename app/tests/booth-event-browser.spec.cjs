'use strict';
// Real Chromium walk of event.html. The API is stubbed. FALSIFY_BOOTH_MISSION_PDF names a local copy of arXiv 2309.15217 (CC BY 4.0).
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
  published: true, outcome: 'missed', publicNote: '표 1의 점수 변경을 AI가 놓쳤어요.', prizeMessage: '부스에서 스티커를 받아 가세요', publishedAt: '2026-11-22T01:02:00.000Z',
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
      viewport: {width: 390, height: 900}, deviceScaleFactor: 1, hasTouch: true, locale: 'ko-KR',
    });
    page.setDefaultTimeout(90000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => { void dialog.accept(); });
    await page.clock.install();
    const base = 'http://127.0.0.1:' + port + '/';
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(base)) return route.continue();
      return stubApi(route, submissions, claims);
    });
    await page.goto(base + 'event.html');
    await page.getByRole('button', {name: '5쪽으로 가기'}).waitFor();
    assert.equal(await page.locator('.rail [data-view="blue"]').isHidden(), true);
    await page.getByRole('button', {name: '5쪽으로 가기'}).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.paper-paragraph-button')].some(node => node.textContent.includes('0.95')));
    const paragraphIndex = await page.evaluate(() => {
      const hits = [...document.querySelectorAll('.paper-paragraph-button')].map((node, index) => ({
        index, length: node.textContent.length, text: node.textContent,
      })).filter(item => item.text.includes('0.95') && item.text.includes('0.78') && item.length <= 400);
      hits.sort((a, b) => a.length - b.length);
      return hits.length ? hits[0].index : -1;
    });
    assert.equal(paragraphIndex >= 0, true);
    const paragraph = page.locator('.paper-paragraph-button').nth(paragraphIndex);
    assert.equal(await page.locator('#booth-submit').isHidden(), false);
    assert.equal(await page.locator('#booth-make').isVisible(), true);
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.click();
    const editor = page.locator('textarea[aria-label$="직접 편집"]');
    await editor.waitFor();
    const original = await editor.inputValue();
    assert.equal(original.includes('0.95'), true);
    await editor.fill(original.replace('0.95', '0.50'));
    await page.locator('.paper-direct-controls').getByRole('button', {name: '완료', exact: true}).click();
    await page.waitForFunction(() => {
      const edits = document.querySelector('#paper-edits');
      return !!(edits && edits.textContent.includes('0.50') && edits.textContent.includes('0.95'));
    });
    await page.locator('#booth-make').click();
    await page.waitForFunction(() => {
      const rows = document.querySelector('#booth-rows');
      return !!(rows && rows.textContent.includes('0.50') && rows.textContent.includes('0.95'));
    });
    await page.locator('#booth-rows select').selectOption('number');
    await page.locator('#booth-rows textarea').fill('표의 점수를 0.95에서 0.50으로 바꿨습니다');
    assert.match(await page.locator('#booth-consent-copy').textContent(), /제출하면 바로 수정본 PDF만 AI 검증을 위해 모델 제공자\(Anthropic\)에 보내고/);
    await page.locator('#booth-consent').check();
    await page.locator('#booth-submit-button').click();
    const submitted = await page.waitForFunction(() => {
      if (document.querySelector('#booth-receipt-code')?.textContent === 'F-0042') return 'ok';
      const status = document.querySelector('#booth-submit-status')?.textContent || '';
      if (status && status !== '제출하는 중…') return status;
      return null;
    }, null, {timeout: 20000}).then(handle => handle.jsonValue());
    assert.equal(submitted, 'ok');
    assert.equal(await page.locator('#booth-claim-code').textContent(), '7Q3K-M9XD');
    assert.equal(await page.locator('.rail [data-view="blue"]').isHidden(), true);
    assert.equal(submissions.length, 1);
    const posted = submissions[0].toString('utf8');
    assert.equal(posted.includes('edited.pdf'), true);
    assert.equal(posted.includes('0.50'), true);
    assert.equal(posted.includes('0.95'), true);
    assert.equal(posted.includes('2026-11-22.v2'), true);
    const live = page.locator('#booth-receipt #booth-live');
    await live.waitFor();
    assert.match(await page.locator('#booth-live-title').textContent(), /AI가 결함을 찾는 중이에요\. 보통 1~3분 걸려요/);
    assert.equal(await page.locator('#booth-live-again').isHidden(), true);
    for (let round = 1; round <= 3; round += 1) {
      await page.clock.fastForward(15000);
      const started = Date.now();
      while (claims.length < round && Date.now() - started < 10000) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(claims.length, round);
    }
    assert.deepEqual(claims[0], {receipt: 'F-0042', claimKey: '7Q3K-M9XD'});
    await page.waitForFunction(() => document.querySelector('#booth-live-title')?.textContent === 'AI가 못 찾았어요!');
    assert.equal(await page.locator('#booth-live-prize').textContent(), '부스에서 스티커를 받아 가세요');
    assert.equal(await page.locator('#booth-live-note').textContent(), '표 1의 점수 변경을 AI가 놓쳤어요.');
    const again = page.getByRole('button', {name: '다시 도전하기'});
    assert.equal(await again.isVisible(), true);
    await page.setViewportSize({width: 360, height: 800});
    const audit = await phoneAudit(page, '#booth');
    assert.deepEqual(audit.small, []);
    assert.equal(audit.seen >= 3, true);
    assert.equal(audit.overflow <= 0, true, 'horizontal overflow ' + audit.overflow);
    await page.clock.fastForward(60000);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(claims.length, 3);
    await again.click();
    await page.waitForFunction(() => document.querySelector('#booth-receipt')?.hidden === true);
    assert.equal(await page.locator('#booth-submit').isHidden(), true);
    assert.equal(await page.locator('#booth-missions').isVisible(), true);
    assert.equal(await page.locator('#booth-consent').isChecked(), false);
    assert.equal(await page.locator('#paper-file').inputValue(), '');
    await page.locator('#booth-result-link').click();
    await page.locator('#booth-receipts-list').getByRole('button', {name: /F-0042/}).waitFor();
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
      submit: document.querySelector('#booth-submit')?.hidden,
      make: document.querySelector('#booth-make')?.hidden,
      status: document.querySelector('#booth-submit-status')?.textContent || '',
      search: document.querySelector('#booth-search-status')?.textContent || '',
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
