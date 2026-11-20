
// Browser flow bench: event.html served gzip from app/dist, API = local event Worker (Miniflare, local D1, stubbed arXiv + runtime).
import { createRequire } from 'node:module';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { start, OPERATOR, median } from './bench-lib.mjs';
const appRoot = process.env.APP_ROOT;
const dist = process.env.DIST || path.join(appRoot, 'dist');
const reqApp = createRequire(path.join(appRoot, 'package.json'));
const { chromium } = reqApp('playwright');
const SPORT = Number(process.env.BENCH_PAGE_PORT || 8951), APORT = Number(process.env.BENCH_API_PORT || 8952);
const PAGE_ORIGIN = 'http://127.0.0.1:' + SPORT;
const API = 'http://127.0.0.1:' + APORT;
const RUNS = Number(process.env.RUNS || 3);
const PROFILES = (process.env.PROFILES || 'desktop,fast4g4x,slow4g6x').split(',');
const PRESET = {
  desktop: { cpu: 1, net: null, viewport: { width: 1280, height: 800 }, dpr: 1, mobile: false },
  fast4g4x: { cpu: 4, net: { latency: 165, downloadThroughput: 1012500, uploadThroughput: 168750 }, viewport: { width: 390, height: 844 }, dpr: 3, mobile: true },
  cpu6: { cpu: 6, net: null, viewport: { width: 390, height: 844 }, dpr: 3, mobile: true },
  slow4g1x: { cpu: 1, net: { latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 }, viewport: { width: 390, height: 844 }, dpr: 3, mobile: true },
  slow4g6x: { cpu: 6, net: { latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 }, viewport: { width: 390, height: 844 }, dpr: 3, mobile: true },
};
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm', '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2', '.ttf':'font/ttf', '.otf':'font/otf', '.pdf':'application/pdf', '.bcmap':'application/octet-stream' };
const gzCache = new Map();
const staticBytes = { n: 0, bytes: 0 };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, PAGE_ORIGIN);
  let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (p === '/cloud-config.event.js' || p === '/event.html') body = Buffer.from(body.toString().replaceAll('https://falsify-cloud-api-event.ai-gongbu.workers.dev', API));
  const type = TYPES[path.extname(f)] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'max-age=600', 'Access-Control-Allow-Origin': '*' };
  if (/text|javascript|json|svg|wasm/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '')) {
    const key = f + ((p === '/cloud-config.event.js' || p === '/event.html') ? '#cfg' : '');
    if (!gzCache.has(key)) gzCache.set(key, zlib.gzipSync(body, { level: 6 }));
    body = gzCache.get(key); headers['Content-Encoding'] = 'gzip';
  }
  staticBytes.n++; staticBytes.bytes += body.length; (globalThis.__static ||= []).push({ t: Date.now(), p, b: body.length });
  res.writeHead(200, headers); res.end(body);
});
await new Promise(r => server.listen(SPORT, '127.0.0.1', r));
const missionPdf = fs.readFileSync(process.env.MISSION_PDF);
const mf = await start({ D1_LAT_MS: process.env.D1_LAT_MS || '22', UP_OAI_MS: '150', UP_PDF_MS: '250', RT_MS: '40', MISSION_PDF_B64: missionPdf.toString('base64'), BOOTH_OPERATOR_ACTIVE_JOBS: '50', NOCACHE: process.env.NOCACHE || '0', AI_GUESTS_PER_IP_HOUR: '5000', BOOTH_SUBMISSIONS_PER_IP_HOUR: '5000', PAPER_PDF_PER_IP_HOUR:'5000', AI_GUEST_UPLOADS_PER_OWNER_HOUR:'100', BOOTH_SUBMISSIONS_PER_OWNER:'500' }, { port: APORT, origin: PAGE_ORIGIN });
await mf.ready;
const opCall = async (method, p, body) => { const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + OPERATOR, 'Content-Type': 'application/json', Origin: PAGE_ORIGIN }, body: body ? JSON.stringify(body) : undefined }); return r.json(); };
await opCall('PUT', '/v1/booth/admin/settings', { submissionsOpen: true, missions: [{ id: 'ragas', title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation', source: 'arxiv', paperId: '2309.15217', license: 'cc-by-4.0', course: 'quick', pageHint: 5, hint: 'Table 1의 점수 하나를 바꿔 보세요' }] });

const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const INIT = () => {
  window.__lt = []; window.__ev = [];
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__ev.push([e.startTime, e.duration, e.name]); }).observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch {}
};
async function oneRun(profileName, runIndex) {
  const P = PRESET[profileName];
  const ctx = await browser.newContext({ viewport: P.viewport, deviceScaleFactor: P.dpr, isMobile: P.mobile, hasTouch: P.mobile, locale: 'ko-KR' });
  // Local only: anything that is not the page server or the local Worker is aborted, never fetched.
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(PAGE_ORIGIN + '/') || url.startsWith(API + '/') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    return route.abort('blockedbyclient');
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);
  page.on('dialog', d => { void d.accept(); });
  const logs = []; page.on('console', m => logs.push(m.type()+': '+m.text().slice(0,200))); page.on('pageerror', e => logs.push('pageerror: '+e.message.slice(0,200))); page.on('requestfailed', r => logs.push('reqfailed: '+r.url().slice(0,120)+' '+(r.failure()?.errorText||'')));
  globalThis.__logs = logs;
  await page.addInitScript(INIT);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const reqs = [];
  cdp.on('Network.requestWillBeSent', e => { reqs.push({ t: Date.now(), url: e.request.url, method: e.request.method, type: e.type }); });
  if (P.net) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...P.net });
  if (P.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: P.cpu });
  const marks = {};
  const wf = async (fn, arg, opts) => { try { return await page.waitForFunction(fn, arg, { ...opts, timeout: Number(process.env.STEP_TIMEOUT||240000) }); } catch (e) { e.message += ' AT ' + fn.toString().slice(0, 140) + ' STEP=' + (await page.evaluate(() => document.documentElement.dataset.boothStep).catch(()=>'?')) + ' STATUS=' + (await page.evaluate(() => ['booth-mission-status','booth-submit-status','paper-generate-status','paper-edit-status'].map(i => i+':'+(document.getElementById(i)?.textContent||'')).join(';')).catch(()=>'')) + ' LOGS ' + logs.slice(-12).join(' | ') + ' API ' + reqs.filter(r=>r.url.startsWith(API)).map(r=>r.method+' '+new URL(r.url).pathname).join(', '); e.marks = { ...marks, openWaitMs: (typeof win !== 'undefined' && win.open?.wall) ? Date.now() - win.open.wall : null }; throw e; } };
  const now = () => page.evaluate(() => performance.now());
  const t0 = Date.now();
  await page.goto(PAGE_ORIGIN + '/event.html', { waitUntil: 'load', timeout: 240000 });
  marks.load = Date.now() - t0;
  try { await page.locator('#booth-missions .booth-mission').first().waitFor({ timeout: Number(process.env.MISSION_TIMEOUT||240000) }); } catch (e) { e.message += '\nLOGS ' + logs.slice(0,30).join(' | ') + '\nAPI ' + reqs.filter(r=>r.url.startsWith(API)).map(r=>r.method+' '+r.url).join(', '); throw e; }
  marks.missions = Date.now() - t0;
  const fcp = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime || null);
  const win = {};
  const stepStart = async name => { win[name] = { t: await now(), wall: Date.now() }; };
  const stepEnd = async name => { win[name].t1 = await now(); win[name].wall1 = Date.now(); };
  await stepStart('open');
  await page.locator('#booth-missions .booth-mission').first().click();
  await wf(() => document.documentElement.dataset.boothStep === 'edit', null, { polling: 50 });
  await wf(() => [...document.querySelectorAll('.paper-paragraph-button')].some(n => n.textContent.includes('0.95')), null, { polling: 50 });
  await stepEnd('open');
  const listToggle = page.locator('#booth-find-list');
  if (await listToggle.count() && await listToggle.isVisible()) await listToggle.click();
  const idx = await page.evaluate(() => { const hits = [...document.querySelectorAll('.paper-paragraph-button')].map((n, i) => ({ i, l: n.textContent.length, t: n.textContent })).filter(x => x.t.includes('0.95') && x.t.includes('0.78') && x.l <= 400); hits.sort((a, b) => a.l - b.l); return hits.length ? hits[0].i : -1; });
  const para = page.locator('.paper-paragraph-button').nth(idx);
  await para.scrollIntoViewIfNeeded();
  await para.click();
  const editor = page.locator('textarea[aria-label$="직접 편집"]');
  await editor.waitFor();
  const orig = await editor.inputValue();
  await editor.fill(orig.replace('0.95', '0.50'));
  await stepStart('edit');
  await page.locator('.paper-direct-controls').getByRole('button', { name: '완료', exact: true }).click();
  await wf(() => document.querySelector('#booth-dock-count')?.textContent === '고친 곳 1개', null, { polling: 50 });
  await stepEnd('edit');
  await stepStart('next');
  await page.locator('#booth-next').click();
  await wf(() => document.documentElement.dataset.boothStep === 'send', null, { polling: 50 });
  await stepEnd('next');
  const card = page.locator('#booth-rows .booth-card').first();
  await card.getByRole('button', { name: '수치·통계' }).click();
  await card.locator('textarea').fill('표의 점수를 0.95에서 0.50으로 바꿨습니다');
  await page.locator('#booth-consent').check();
  await wf(() => !document.querySelector('#booth-submit-button')?.disabled, null, { polling: 50 });
  await stepStart('submit');
  await page.locator('#booth-submit-button').click();
  await wf(() => document.documentElement.dataset.boothStep === 'ticket' || /실패|못|오류/.test(document.querySelector('#booth-submit-status')?.textContent || ''), null, { polling: 50 });
  await stepEnd('submit');
  const step = await page.evaluate(() => document.documentElement.dataset.boothStep);
  const receipt = (await page.locator('#booth-receipt-code').textContent().catch(() => '')) || '';
  const perf = await page.evaluate(() => ({ lt: window.__lt, ev: window.__ev, heap: performance.memory ? performance.memory.usedJSHeapSize : null }));
  const out = { profile: profileName, run: runIndex, step, receipt, fcp, load: marks.load, missions: marks.missions, steps: {} };
  for (const [name, w] of Object.entries(win)) {
    const lts = perf.lt.filter(([s]) => s >= w.t && s <= w.t1);
    const evs = perf.ev.filter(([s]) => s >= w.t - 5 && s <= w.t1);
    const api = reqs.filter(r => r.t >= w.wall && r.t <= w.wall1 && r.url.startsWith(API));
    out.steps[name] = { ms: Math.round(w.wall1 - w.wall), longTasks: lts.length, longTaskMs: Math.round(lts.reduce((a, [, d]) => a + d, 0)), maxLongTask: Math.round(Math.max(0, ...lts.map(([, d]) => d))), maxEvent: Math.round(Math.max(0, ...evs.map(([, d]) => d))), apiRequests: api.map(r => r.method + ' ' + new URL(r.url).pathname).join(', ') };
  }
  const loadLt = perf.lt.filter(([s]) => s <= (win.open?.t || 0));
  out.loadLongTaskMs = Math.round(loadLt.reduce((a, [, d]) => a + d, 0));
  out.loadMaxLongTask = Math.round(Math.max(0, ...loadLt.map(([, d]) => d)));
  out.apiAll = reqs.filter(r => r.url.startsWith(API)).map(r => r.method + ' ' + new URL(r.url).pathname + (r.type === 'Preflight' ? ' [preflight]' : ''));
  out.staticReqs = reqs.filter(r => r.url.startsWith(PAGE_ORIGIN)).length;
  out.heapMB = perf.heap ? +(perf.heap / 1048576).toFixed(1) : null;
  await ctx.close();
  return out;
}
const results = [];
process.on('exit', () => {});
for (const prof of PROFILES) for (let i = 0; i < RUNS; i++) {
  try { const r = await oneRun(prof, i); results.push(r); console.error('RUN ' + JSON.stringify({ p: prof, i, step: r.step, steps: Object.fromEntries(Object.entries(r.steps).map(([k, v]) => [k, v.ms])) })); }
  catch (e) { console.error('FAIL ' + prof + ' ' + i + ' ' + e.message.slice(0, 4000)); results.push({ profile: prof, run: i, error: e.message.slice(0, 4000), marks: e.marks || null }); }
}
const subs = await opCall('GET', '/v1/booth/admin/submissions?limit=200');
fs.writeFileSync(process.env.OUT || 'booth-bench-browser.json', JSON.stringify({ static: globalThis.__static, results, submissions: (subs.submissions || []).map(s => ({ receipt: s.receipt, pdfBytes: s.pdfBytes })), staticBytes }, null, 1));
await browser.close(); await mf.dispose(); server.close();
console.error('DONE');
