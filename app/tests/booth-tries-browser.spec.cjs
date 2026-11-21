'use strict';
// Real Chromium verification of plan97s-2 (0 tries -> 내 기록 보기, hide desktop duplicate,
// KO/EN toggle, tap opens 내 기록, and withdrawing at 0 tries returns a try on the same ticket).
const {spawn} = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_TRIES_PORT || 19618);
const base = 'http://127.0.0.1:' + port + '/';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const json = (route, status, body) => route.fulfill({status, contentType: 'application/json', headers: cors, body: JSON.stringify(body)});
const CAUGHT = {
  receipt: 'F-0043', status: 'judged', course: 'quick', declaredCount: 1,
  createdAt: '2026-11-22T01:00:00.000Z', published: true, outcome: 'caught',
  publicNote: '내가 심어 둔 결함을 AI가 찾았어요.',
};
const MISSED = {
  receipt: 'F-0043', status: 'judged', course: 'quick', declaredCount: 1,
  createdAt: '2026-11-22T01:00:00.000Z', published: true, outcome: 'missed',
  publicNote: 'AI가 이번 수정본에서 결함을 짚지 못했어요. 심어 둔 결함은 AI 눈을 피했어요.',
};
const WITHDRAWN = {
  receipt: 'F-0043', status: 'withdrawn', course: 'quick', declaredCount: 1,
  createdAt: '2026-11-22T01:00:00.000Z', published: false,
};

function startServer() {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {cwd: dist, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = (async () => {
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await fetch(base + 'event.html');
        if (res.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('http.server did not start\n' + stderr);
  })();
  return {child, ready};
}

async function main() {
  const server = startServer();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome});
    const viewports = [
      [390, 844, ''],
      [360, 740, ''],
      [1280, 800, ''],
      [1280, 800, '?kiosk=1'],
      [800, 1280, '?kiosk=1'],
    ];
    for (const [w, h, q] of viewports) {
      const page = await browser.newPage({viewport: {width: w, height: h}});
      const errs = [];
      page.on('pageerror', e => errs.push(e.message));
      await page.clock.install({time: new Date('2026-11-22T01:05:00.000Z')});
      await page.addInitScript(([kiosk]) => {
        const list = [3, 2, 1].map(n => ({receipt: 'F-004' + n, claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:00:00.000Z', title: 'Ragas'}));
        (kiosk ? sessionStorage : localStorage).setItem('falsify.booth.receipts.v1', JSON.stringify(list));
      }, [!!q]);
      await page.route('**/*', route => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.url().startsWith(base)) return route.continue();
        if (!url.href.startsWith(api)) return route.abort();
        if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
        if (url.pathname === '/v1/booth/config') {
          return json(route, 200, {enabled: true, submissionsOpen: true, consentVersion: 'v3', limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216, perOwner: 3}, missions: []});
        }
        if (url.pathname === '/v1/booth/claim') return json(route, 200, CAUGHT);
        if (req.method() === 'POST' && url.pathname === '/v1/ai/guest') return json(route, 200, {guest: {token: 'fsg_' + 'a'.repeat(43), expiresAt: '2026-11-23T00:00:00Z'}});
        return json(route, 404, {error: {code: 'not_found'}});
      });
      await page.goto(base + 'event.html' + q + '#booth-result');
      await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'ticket' && document.querySelector('#booth-live-title')?.textContent, null, {timeout: 30000});
      const again = page.locator('#booth-live-again');
      assert.equal(await again.textContent(), '내 기록 보기', `${w}x${h}${q} button label`);
      assert.equal(await again.isVisible(), true, `${w}x${h}${q} button visible`);
      const box = await again.boundingBox();
      assert.ok(box && box.height >= 44, `${w}x${h}${q} button height >= 44`);
      assert.equal(await page.locator('#booth-live-records').isVisible(), false, `${w}x${h}${q} duplicate records button hidden`);
      assert.equal(await page.locator('#booth-chances-top').textContent(), '기회 0번 남음');
      await page.evaluate(() => globalThis.FalsifyBoothI18n.setLang('en'));
      await page.waitForFunction(() => document.querySelector('#booth-live-again')?.textContent === 'View my tickets');
      await page.evaluate(() => globalThis.FalsifyBoothI18n.setLang('ko'));
      await page.waitForFunction(() => document.querySelector('#booth-live-again')?.textContent === '내 기록 보기');
      await again.click();
      await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'pick');
      assert.equal(await page.evaluate(() => location.hash), '#booth-result');
      assert.equal(await page.locator('#booth-result').isVisible(), true);
      assert.match(await page.locator('#booth-receipts-list').textContent(), /F-0043/);
      assert.deepEqual(errs, [], `${w}x${h}${q} page errors`);
      await page.close();
    }

    // Withdrawing at 0 tries on desktop restores 1 try on the same ticket and brings back #booth-live-records.
    const page = await browser.newPage({viewport: {width: 1280, height: 800}});
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.clock.install({time: new Date('2026-11-22T01:05:00.000Z')});
    await page.addInitScript(() => {
      const list = [3, 2, 1].map(n => ({receipt: 'F-004' + n, claimKey: '7Q3K-M9XD', createdAt: '2026-11-22T01:00:00.000Z', title: 'Ragas'}));
      localStorage.setItem('falsify.booth.receipts.v1', JSON.stringify(list));
    });
    await page.route('**/*', route => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.url().startsWith(base)) return route.continue();
      if (!url.href.startsWith(api)) return route.abort();
      if (req.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
      if (url.pathname === '/v1/booth/config') {
        return json(route, 200, {enabled: true, submissionsOpen: true, consentVersion: 'v3', limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216, perOwner: 3}, missions: []});
      }
      if (url.pathname === '/v1/booth/claim') return json(route, 200, MISSED);
      if (req.method() === 'POST' && url.pathname === '/v1/booth/withdraw') return json(route, 200, WITHDRAWN);
      if (req.method() === 'POST' && url.pathname === '/v1/ai/guest') return json(route, 200, {guest: {token: 'fsg_' + 'a'.repeat(43), expiresAt: '2026-11-23T00:00:00Z'}});
      return json(route, 404, {error: {code: 'not_found'}});
    });
    await page.goto(base + 'event.html#booth-result');
    await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'ticket' && document.querySelector('#booth-live-title')?.textContent, null, {timeout: 30000});
    assert.equal(await page.locator('#booth-chances-top').textContent(), '기회 0번 남음');
    assert.equal(await page.locator('#booth-live-again').textContent(), '내 기록 보기');
    assert.equal(await page.locator('#booth-live-records').isVisible(), false);
    await page.locator('#booth-withdraw-box > summary').click();
    await page.locator('#booth-withdraw').click();
    await page.locator('#booth-withdraw-confirm').click();
    await page.waitForFunction(() => document.querySelector('#booth-live-title')?.textContent === '제출을 철회했어요');
    assert.equal(await page.locator('#booth-chances-top').textContent(), '기회 1번 남음');
    assert.equal(await page.locator('#booth-live-again').textContent(), '다시 도전하기 · 기회 1번 남음');
    assert.equal(await page.locator('#booth-live-records').isVisible(), true);
    assert.deepEqual(errs, [], 'withdraw page errors');
    await page.close();
    console.log('booth-tries-browser: all 5 viewports + withdraw pass');
  } finally {
    if (browser) await browser.close();
    server.child.kill();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
