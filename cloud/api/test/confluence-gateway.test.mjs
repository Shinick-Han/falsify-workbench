// Offline mocks only. A passing run is not live Atlassian OAuth, storage, or deployment proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import worker from '../src/index.js';
import {
  SESSION_HEADER,
  handleConfluence,
  matchConfluence,
  setReviewBundleForTests,
} from '../src/confluence.mjs';

const CLOUD = '11111111-1111-1111-1111-111111111111';
const PARENT = '424242';
const ORIGIN = 'https://shinick-han.github.io';
const OTHER = 'http://127.0.0.1:7816';
const SECRET = 'test-secret-value';
const SITE = 'https://falsify.atlassian.net';
const T0 = 1_700_000_000_000;
const ENVELOPE_MS = 12 * 60 * 60 * 1000;

const archive = {
  schema: 'falsify.confluence-archive.v1',
  kind: 'experiment',
  id: 'selected-run-1',
  title: 'Synthetic <script> title',
  data: {
    schema: 'falsify.review-bundle.v1',
    marker: 'RAW-MARKER-DO-NOT-LEAK',
    selectedRunId: 'selected-run-1',
    ledger: { schema: 'falsify.experiment-ledger.v1', harnesses: [], runs: [], reviews: [] },
  },
};

function canonical(value) {
  return JSON.parse(JSON.stringify(value));
}
function archiveSha(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const HASH = archiveSha(archive);
const TITLE = `Falsify experiment ${HASH}`;

let seenValidators = null;
function installBundle() {
  seenValidators = null;
  setReviewBundleForTests({
    async validateArchive(value, validators) {
      seenValidators = validators;
      if (!value || value.schema !== 'falsify.confluence-archive.v1' || value.reject === true) throw new Error('reject');
      return canonical(value);
    },
    async archiveHash(value) {
      return archiveSha(value);
    },
  });
}

function baseEnv(overrides = {}) {
  return {
    ATLASSIAN_CLIENT_ID: 'falsify-test-client',
    ATLASSIAN_CLIENT_SECRET: SECRET,
    ATLASSIAN_CALLBACK_URL: 'https://worker.example/v1/confluence/auth/callback',
    CONFLUENCE_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CONFLUENCE_PARENT_PAGE_ID: PARENT,
    ALLOWED_ORIGINS: `${ORIGIN},${OTHER}`,
    ...overrides,
  };
}

function extractFile(body) {
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
  const start = text.indexOf('\r\n\r\n');
  const end = text.lastIndexOf('\r\n--');
  assert.ok(start > 0 && end > start);
  return text.slice(start + 4, end);
}

function jsonResponse(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function readyPage(extra = {}) {
  return {
    id: '9001',
    title: TITLE,
    status: 'current',
    parentId: PARENT,
    spaceId: '65737',
    version: { createdAt: '2026-10-26T00:00:00.000Z' },
    _links: { webui: '/spaces/Falsify/pages/9001/Falsify' },
    labels: { results: [{ prefix: 'global', name: 'falsify-archive-ready' }] },
    properties: { results: [{ key: 'falsify-archive', value: { kind: 'experiment', id: archive.id, archiveSha256: HASH, ready: true } }] },
    ...extra,
  };
}

function mockUpstream(options = {}) {
  const calls = [];
  const store = {
    page: null,
    labeled: false,
    file: options.downloadText || options.listHash || options.downloadStatus
      ? (options.downloadText ?? JSON.stringify(canonical(archive)))
      : null,
  };
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const u = new URL(url);
    calls.push({ url: u.toString(), method, init, host: u.hostname, path: u.pathname, search: u.search });
    assert.equal(init.redirect, 'manual');
    assert.ok(u.hostname === 'api.atlassian.com' || u.hostname === 'auth.atlassian.com');
    assert.equal(u.protocol, 'https:');
    const wiki = u.pathname.includes('/wiki/') ? u.pathname.slice(u.pathname.indexOf('/wiki/')) : u.pathname;
    if (u.hostname === 'auth.atlassian.com' && u.pathname === '/oauth/token') {
      if (options.tokenStatus) return new Response('no', { status: options.tokenStatus, headers: options.tokenHeaders || {} });
      const params = new URLSearchParams(init.body);
      const expires = params.get('grant_type') === 'refresh_token' ? (options.refreshExpires ?? 3600) : (options.expiresIn ?? 3600);
      const n = calls.filter(call => call.path === '/oauth/token').length;
      return jsonResponse(200, { access_token: `access-token-${n}`, refresh_token: `refresh-token-${n}`, expires_in: expires });
    }
    if (u.pathname === '/oauth/token/accessible-resources') {
      if (options.resourcesStatus) return new Response('no', { status: options.resourcesStatus, headers: options.resourcesHeaders || {} });
      return jsonResponse(200, options.resources ?? [{ id: CLOUD, url: SITE }]);
    }
    if (wiki === '/wiki/api/v2/spaces/65737') {
      if (options.spaceStatus) return new Response('no', { status: options.spaceStatus, headers: options.spaceHeaders || {} });
      return jsonResponse(200, options.space ?? { id: '65737', key: 'Falsify' });
    }
    if (method === 'GET' && wiki === `/wiki/api/v2/pages/${PARENT}` && u.search === '') {
      if (options.parentStatus) return new Response('no', { status: options.parentStatus });
      return jsonResponse(200, options.parent ?? { id: PARENT, spaceId: '65737' });
    }
    if (method === 'GET' && wiki === '/wiki/api/v2/pages' && u.searchParams.has('title')) {
      if (options.foreignTitle) return jsonResponse(200, { results: [{ id: '9001', title: u.searchParams.get('title'), status: 'current' }] });
      if (options.conflictingReady) return jsonResponse(200, { results: [{ id: '9001', title: TITLE, status: 'current' }] });
      if (store.page && store.page.title === u.searchParams.get('title')) {
        return jsonResponse(200, { results: [{ id: store.page.id, title: store.page.title, status: 'current' }] });
      }
      return jsonResponse(200, { results: [] });
    }
    if (method === 'POST' && wiki === '/wiki/api/v2/pages') {
      if (options.pageStatus) return new Response('err', { status: options.pageStatus });
      if (options.pageThrows) throw new Error('boom-network');
      const body = JSON.parse(init.body);
      store.summary = body.body.value;
      store.page = { id: '9001', title: body.title, parentId: body.parentId, spaceId: body.spaceId };
      return jsonResponse(200, { id: '9001', spaceId: '65737', parentId: PARENT, title: body.title, status: 'current' });
    }
    if (method === 'GET' && wiki === '/wiki/api/v2/pages/9001') {
      if (options.foreignTitle) return jsonResponse(200, { id: '9001', parentId: '111', spaceId: '65737', title: TITLE, status: 'current' });
      if (options.conflictingReady) {
        return jsonResponse(200, readyPage({
          properties: { results: [{ key: 'falsify-archive', value: { kind: 'experiment', id: archive.id, archiveSha256: 'ff'.repeat(32), ready: true } }] },
        }));
      }
      if (options.hideLabel) return jsonResponse(200, readyPage({ labels: { results: [] } }));
      if (options.listBroken) return jsonResponse(200, readyPage({ version: {}, _links: {} }));
      if (store.page || options.listHash) return jsonResponse(200, readyPage(store.labeled || options.listHash ? {} : { labels: { results: [] }, properties: { results: [] } }));
      return jsonResponse(404, {});
    }
    if (method === 'GET' && wiki === '/wiki/api/v2/pages/9003') {
      return jsonResponse(200, { id: '9003', parentId: PARENT, spaceId: '65737', title: 'draft', status: 'current', labels: { results: [] }, properties: { results: [] } });
    }
    if (method === 'GET' && wiki === '/wiki/api/v2/pages/9001/attachments') {
      return jsonResponse(200, { results: store.file ? [{ id: '77', title: `${HASH}.json` }] : [] });
    }
    if (method === 'POST' && wiki === '/wiki/rest/api/content/9001/child/attachment') {
      if (options.attachmentStatus) return new Response('err', { status: options.attachmentStatus, headers: options.attachmentHeaders || {} });
      assert.equal(init.headers['X-Atlassian-Token'], 'nocheck');
      store.file = options.tamperDownload ? extractFile(init.body).replace('RAW-MARKER-DO-NOT-LEAK', 'TAMPERED-MARKER') : extractFile(init.body);
      assert.match(String(init.headers['Content-Type']), /multipart\/form-data/);
      assert.match(Buffer.from(init.body).toString('utf8'), new RegExp(`name="file"; filename="${HASH}\\.json"`));
      return jsonResponse(200, { results: [{ id: '77', title: `${HASH}.json` }] });
    }
    if (wiki.includes('/child/attachment/') && wiki.endsWith('/download')) {
      if (options.downloadStatus) {
        return new Response(null, { status: options.downloadStatus, headers: { Location: 'https://evil.example/secret-file' } });
      }
      return new Response(options.downloadText ?? store.file, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'POST' && wiki === '/wiki/api/v2/pages/9001/properties') return jsonResponse(200, { key: 'falsify-archive' });
    if (method === 'POST' && wiki === '/wiki/rest/api/content/9001/label') {
      store.labeled = true;
      return jsonResponse(200, { results: [{ name: 'falsify-archive-ready' }] });
    }
    if (method === 'GET' && wiki === `/wiki/api/v2/pages/${PARENT}/children`) {
      if (options.evilNext) {
        return jsonResponse(200, { results: [], _links: { next: 'https://evil.example/steal?cursor=safe_CURSOR-1' } });
      }
      return jsonResponse(200, {
        results: options.children ?? [
          { id: '9001', parentId: PARENT },
          { id: '9003', parentId: PARENT },
        ],
        _links: { next: `https://api.atlassian.com/ex/confluence/${CLOUD}/wiki/api/v2/pages/${PARENT}/children?limit=25&cursor=safe_CURSOR-1` },
      });
    }
    throw new Error(`unmocked ${method} ${u.pathname}${u.search}`);
  };
  return { fetchImpl, calls, store };
}

function gateway(path, { method = 'GET', headers = {}, body, env, fetchImpl, now = T0, origin = ORIGIN } = {}) {
  const requestHeaders = { Origin: origin, ...headers };
  const request = new Request(`https://worker.example${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return handleConfluence({
    request,
    env: env ?? baseEnv(),
    url: new URL(request.url),
    match: matchConfluence(new URL(request.url).pathname),
    settings: { origins: new Set([ORIGIN, OTHER]) },
    fetchImpl: fetchImpl ?? (async () => { throw new Error('unexpected fetch'); }),
    now: () => now,
  });
}

async function read(response) {
  const text = await response.text();
  try { return { status: response.status, headers: response.headers, json: JSON.parse(text), text }; }
  catch { return { status: response.status, headers: response.headers, json: null, text }; }
}

function posted(html) {
  const start = html.indexOf('var message=');
  if (start < 0) return null;
  const originKey = ';var origin=';
  const mid = html.indexOf(originKey, start);
  const end = html.indexOf(';var text=', mid);
  return {
    message: JSON.parse(html.slice(start + 'var message='.length, mid)),
    origin: JSON.parse(html.slice(mid + originKey.length, end)),
  };
}

async function mint({ origin = ORIGIN, nonce = 'n'.repeat(16), now = T0, mock = mockUpstream(), env } = {}) {
  const started = await read(await gateway('/v1/confluence/auth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: { nonce, returnOrigin: origin },
    origin,
    fetchImpl: mock.fetchImpl,
    now,
    env,
  }));
  assert.equal(started.status, 200);
  const state = new URL(started.json.authorizeUrl).searchParams.get('state');
  const callback = await read(await gateway(`/v1/confluence/auth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`, {
    fetchImpl: mock.fetchImpl,
    now,
    env,
    origin,
  }));
  const message = posted(callback.text);
  assert.ok(message);
  return { ...started.json, state, session: message.message.session, message, mock, env: env ?? baseEnv() };
}

describe('confluence gateway', { concurrency: false }, () => {
  test('capabilities stay unconfigured without secrets or a parent', async () => {
    installBundle();
    const bare = await read(await gateway('/v1/confluence/capabilities', { env: { ALLOWED_ORIGINS: ORIGIN } }));
    assert.equal(bare.status, 200);
    assert.deepEqual(bare.json, {
      provider: 'confluence',
      configured: false,
      siteUrl: SITE,
      spaceKey: 'Falsify',
      spaceId: '65737',
      maxArchiveBytes: 6 * 1024 * 1024,
    });
    assert.equal(JSON.stringify(bare.json).includes(SECRET), false);
    const wrongSite = await read(await gateway('/v1/confluence/capabilities', {
      env: baseEnv({ CONFLUENCE_SITE_URL: 'https://evil.example' }),
    }));
    assert.equal(wrongSite.json.configured, false);
    assert.equal(wrongSite.json.siteUrl, SITE);
    const shortKey = await read(await gateway('/v1/confluence/capabilities', {
      env: baseEnv({ CONFLUENCE_SESSION_KEY: Buffer.from('short').toString('base64') }),
    }));
    assert.equal(shortKey.json.configured, false);
    const start = await read(await gateway('/v1/confluence/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { nonce: 'n'.repeat(16), returnOrigin: ORIGIN },
      env: { ALLOWED_ORIGINS: ORIGIN },
    }));
    assert.equal(start.status, 503);
    assert.equal(start.json.error.code, 'not_configured');
    assert.equal(start.text.includes('authorize'), false);
  });

  test('auth start rejects a foreign origin and keeps the secret off the authorize URL', async () => {
    installBundle();
    const mock = mockUpstream();
    const ok = await mint({ mock });
    const url = new URL(ok.authorizeUrl);
    assert.equal(url.origin, 'https://auth.atlassian.com');
    assert.equal(url.searchParams.get('client_id'), 'falsify-test-client');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://worker.example/v1/confluence/auth/callback');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('audience'), 'api.atlassian.com');
    assert.deepEqual(url.searchParams.get('scope').split(' '), [
      'offline_access',
      'read:space:confluence',
      'read:page:confluence',
      'write:page:confluence',
      'read:attachment:confluence',
      'write:confluence-file',
      'readonly:content.attachment:confluence',
      'write:confluence-content',
    ]);
    assert.equal(ok.authorizeUrl.includes(SECRET), false);
    assert.equal(ok.message.message.type, 'falsify.confluence.session.v1');
    assert.equal(ok.message.message.nonce, 'n'.repeat(16));
    assert.equal(ok.message.origin, ORIGIN);
    assert.equal(ok.message.message.session.includes('access-token-1'), false);
    const foreign = await read(await gateway('/v1/confluence/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: { nonce: 'n'.repeat(16), returnOrigin: ORIGIN },
      origin: 'https://evil.example',
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.error.code, 'origin_not_allowed');
    assert.equal(foreign.json.error.message.includes('evil.example'), false);
    const otherReturn = await read(await gateway('/v1/confluence/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { nonce: 'n'.repeat(16), returnOrigin: 'https://evil.example' },
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(otherReturn.status, 403);
  });

  test('callback binds nonce and origin, and drops tampered, expired, or wrong-site state', async () => {
    installBundle();
    const first = mockUpstream();
    const a = await mint({ mock: first, nonce: 'a'.repeat(16), origin: ORIGIN });
    const second = mockUpstream();
    const b = await mint({ mock: second, nonce: 'b'.repeat(16), origin: OTHER });
    assert.equal(a.message.message.nonce, 'a'.repeat(16));
    assert.equal(a.message.origin, ORIGIN);
    assert.equal(b.message.message.nonce, 'b'.repeat(16));
    assert.equal(b.message.origin, OTHER);
    assert.equal(a.message.message.session === b.message.message.session, false);
    const tamperMock = mockUpstream();
    const flipped = a.state[20] === 'A' ? 'B' : 'A';
    const tampered = `${a.state.slice(0, 20)}${flipped}${a.state.slice(21)}`;
    const tamper = await read(await gateway(`/v1/confluence/auth/callback?code=auth-code-1&state=${encodeURIComponent(tampered)}`, { fetchImpl: tamperMock.fetchImpl }));
    assert.equal(posted(tamper.text), null);
    assert.equal(tamper.text.includes('postMessage'), false);
    assert.equal(tamperMock.calls.length, 0);
    const expiredMock = mockUpstream();
    const expired = await read(await gateway(`/v1/confluence/auth/callback?code=auth-code-1&state=${encodeURIComponent(a.state)}`, {
      fetchImpl: expiredMock.fetchImpl,
      now: T0 + 10 * 60 * 1000 + 1,
    }));
    assert.equal(posted(expired.text), null);
    assert.equal(expiredMock.calls.some(call => call.path === '/oauth/token'), false);
    const siteMock = mockUpstream({ resources: [{ id: CLOUD, url: 'https://evil.atlassian.net' }] });
    const started = await read(await gateway('/v1/confluence/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { nonce: 'c'.repeat(16), returnOrigin: ORIGIN },
      fetchImpl: siteMock.fetchImpl,
    }));
    const state = new URL(started.json.authorizeUrl).searchParams.get('state');
    const wrongSite = await read(await gateway(`/v1/confluence/auth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`, { fetchImpl: siteMock.fetchImpl }));
    assert.equal(posted(wrongSite.text), null);
    assert.equal(wrongSite.text.includes('access-token-1'), false);
    assert.equal(siteMock.calls.some(call => call.method === 'POST' && call.path.endsWith('/wiki/api/v2/pages')), false);
    const asBearer = await read(await gateway('/v1/confluence/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${a.state}` },
      fetchImpl: mockUpstream().fetchImpl,
    }));
    assert.equal(asBearer.status, 401);
    assert.equal(asBearer.json.error.code, 'unauthorized');
  });

  test('refresh rotates inside the skew, keeps the envelope deadline, and stops at the cap', async () => {
    installBundle();
    const minted = await mint({ mock: mockUpstream({ expiresIn: 3600 }) });
    const fresh = mockUpstream();
    const stillFresh = await read(await gateway('/v1/confluence/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.session}` },
      fetchImpl: fresh.fetchImpl,
    }));
    assert.equal(stillFresh.status, 200);
    assert.equal(stillFresh.headers.get(SESSION_HEADER), null);
    assert.equal(fresh.calls.length, 0);
    assert.equal(stillFresh.json.expiresAt, new Date(T0 + ENVELOPE_MS).toISOString());
    const rotating = mockUpstream({ refreshExpires: 30 });
    let session = minted.session;
    const now = T0 + 3600 * 1000 - 10_000;
    let expiresAt = null;
    for (let i = 0; i < 16; i++) {
      const next = await read(await gateway('/v1/confluence/auth/refresh', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session}` },
        fetchImpl: rotating.fetchImpl,
        now,
      }));
      assert.equal(next.status, 200);
      assert.equal(next.headers.get(SESSION_HEADER), next.json.session);
      assert.equal(next.headers.get('access-control-expose-headers'), SESSION_HEADER);
      expiresAt = expiresAt ?? next.json.expiresAt;
      assert.equal(next.json.expiresAt, expiresAt);
      assert.notEqual(next.json.session, session);
      session = next.json.session;
    }
    assert.equal(rotating.calls.filter(call => call.path === '/oauth/token').length, 16);
    const capped = await read(await gateway('/v1/confluence/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session}` },
      fetchImpl: rotating.fetchImpl,
      now,
    }));
    assert.equal(capped.status, 401);
    assert.equal(capped.json.error.code, 'session_expired');
    assert.equal(rotating.calls.filter(call => call.path === '/oauth/token').length, 16);
    const expiredMock = mockUpstream();
    const expired = await read(await gateway('/v1/confluence/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.session}` },
      fetchImpl: expiredMock.fetchImpl,
      now: T0 + ENVELOPE_MS,
    }));
    assert.equal(expired.status, 401);
    assert.equal(expired.json.error.code, 'session_expired');
    assert.equal(expiredMock.calls.length, 0);
    const limited = mockUpstream({ tokenStatus: 429, tokenHeaders: { 'Retry-After': '4' } });
    const rate = await read(await gateway('/v1/confluence/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.session}` },
      fetchImpl: limited.fetchImpl,
      now,
    }));
    assert.equal(rate.status, 429);
    assert.equal(rate.json.error.code, 'rate_limited');
    assert.equal(rate.headers.get('retry-after'), '4');
    assert.equal(rate.json.readBack, undefined);
    const dead = mockUpstream({ tokenStatus: 500 });
    const authFailed = await read(await gateway('/v1/confluence/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.session}` },
      fetchImpl: dead.fetchImpl,
      now,
    }));
    assert.equal(authFailed.status, 401);
    assert.equal(authFailed.json.error.code, 'session_expired');
    assert.equal(dead.calls.some(call => call.path.includes('/wiki/')), false);
  });

  test('publish requires teamShare, confines site space and parent, and writes the ready marker last', async () => {
    installBundle();
    const minted = await mint();
    const upstream = mockUpstream();
    let dbCalls = 0;
    const env = baseEnv();
    env.DB = { prepare() { dbCalls += 1; throw new Error('db touched'); } };
    const published = await read(await gateway('/v1/confluence/archives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { archive, teamShare: true },
      fetchImpl: upstream.fetchImpl,
      env,
    }));
    assert.equal(published.status, 201);
    assert.equal(published.json.stored, true);
    assert.equal(published.json.alreadyExisted, false);
    assert.equal(published.json.archiveSha256, HASH);
    assert.equal(published.json.pageId, '9001');
    assert.equal(published.json.webUrl, `${SITE}/wiki/spaces/Falsify/pages/9001/Falsify`);
    assert.equal(upstream.store.summary.includes('<script>'), false);
    assert.equal(upstream.store.summary.includes('&lt;script&gt;'), true);
    assert.equal(upstream.store.summary.includes('RAW-MARKER-DO-NOT-LEAK'), false);
    assert.equal(upstream.store.summary.includes('JSON only'), true);
    assert.equal(upstream.store.summary.includes('no PDF'), true);
    assert.equal(upstream.store.file.includes('RAW-MARKER-DO-NOT-LEAK'), true);
    assert.equal(typeof seenValidators.harness, 'object');
    assert.equal(typeof seenValidators.red, 'object');
    assert.equal(typeof seenValidators.blue, 'object');
    assert.equal(typeof seenValidators.review, 'object');
    const posts = upstream.calls.filter(call => call.method === 'POST' && call.path.includes('/wiki/'));
    assert.equal(posts.at(-1).path.endsWith('/label'), true);
    const property = posts.find(call => call.path.endsWith('/properties'));
    const label = posts.find(call => call.method === 'POST' && call.path.endsWith('/label'));
    const attachment = posts.find(call => call.method === 'POST' && call.path.endsWith('/child/attachment'));
    assert.ok(upstream.calls.indexOf(attachment) < upstream.calls.indexOf(property));
    assert.ok(upstream.calls.indexOf(property) < upstream.calls.indexOf(label));
    assert.deepEqual(JSON.parse(property.init.body), {
      key: 'falsify-archive',
      value: { kind: 'experiment', id: archive.id, archiveSha256: HASH, ready: true },
    });
    assert.equal(dbCalls, 0);
    for (const call of upstream.calls) {
      assert.equal(call.url.includes(SECRET), false);
      assert.equal(call.url.includes('access-token-'), false);
      if (call.host !== 'auth.atlassian.com') assert.equal(String(call.init.body || '').includes(SECRET), false);
    }
    const again = await read(await gateway('/v1/confluence/archives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { archive, teamShare: true },
      fetchImpl: upstream.fetchImpl,
      env,
    }));
    assert.equal(again.status, 200);
    assert.equal(again.json.alreadyExisted, true);
    assert.equal(again.json.archiveSha256, HASH);
    assert.equal(upstream.calls.filter(call => call.method === 'POST' && call.path.endsWith('/wiki/api/v2/pages')).length, 1);
    assert.equal(dbCalls, 0);
    const privateMode = mockUpstream();
    let validated = false;
    setReviewBundleForTests({
      async validateArchive() { validated = true; return canonical(archive); },
      async archiveHash() { return HASH; },
    });
    const denied = await read(await gateway('/v1/confluence/archives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { archive, teamShare: false },
      fetchImpl: privateMode.fetchImpl,
    }));
    assert.equal(denied.status, 400);
    assert.equal(denied.json.error.code, 'team_share_required');
    assert.equal(validated, false);
    assert.equal(privateMode.calls.length, 0);
    const extra = await read(await gateway('/v1/confluence/archives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { archive, teamShare: true, url: 'https://evil.example/proxy' },
      fetchImpl: mockUpstream().fetchImpl,
    }));
    assert.equal(extra.status, 400);
    assert.equal(extra.json.error.code, 'invalid_request');
  });

  test('wrong space, parent, rate limit, partial write, and unknown write stop before a ready archive', async () => {
    installBundle();
    const minted = await mint();
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` };
    async function publish(mock) {
      return read(await gateway('/v1/confluence/archives', {
        method: 'POST',
        headers: auth,
        body: { archive, teamShare: true },
        fetchImpl: mock.fetchImpl,
      }));
    }
    const space = mockUpstream({ space: { id: '65737', key: 'Other' } });
    const spaceDenied = await publish(space);
    assert.equal(spaceDenied.status, 403);
    assert.equal(spaceDenied.json.error.code, 'space_not_allowed');
    assert.equal(space.calls.some(call => call.method === 'POST'), false);
    const parent = mockUpstream({ parent: { id: PARENT, spaceId: '1' } });
    const parentDenied = await publish(parent);
    assert.equal(parentDenied.status, 403);
    assert.equal(parentDenied.json.error.code, 'parent_not_allowed');
    assert.equal(parent.calls.some(call => call.method === 'POST' && call.path.includes('/pages')), false);
    const foreign = mockUpstream({ foreignTitle: true });
    const conflict = await publish(foreign);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'archive_conflict');
    assert.equal(foreign.calls.some(call => call.method === 'POST' && call.path.endsWith('/wiki/api/v2/pages')), false);
    const rated = mockUpstream({ spaceStatus: 429, spaceHeaders: { 'Retry-After': '9' } });
    const rate = await publish(rated);
    assert.equal(rate.status, 429);
    assert.equal(rate.json.error.code, 'rate_limited');
    assert.equal(rate.headers.get('retry-after'), '9');
    assert.equal(rate.json.readBack, undefined);
    assert.equal(rated.calls.some(call => call.method === 'POST'), false);
    const unknown = mockUpstream({ pageStatus: 500 });
    const failedCreate = await publish(unknown);
    assert.equal(failedCreate.status, 409);
    assert.equal(failedCreate.json.error.code, 'write_unknown');
    assert.equal(failedCreate.json.readBack, true);
    assert.equal(failedCreate.json.pageId, undefined);
    assert.equal(failedCreate.json.error.message.includes('err'), false);
    assert.equal(unknown.calls.some(call => call.path.endsWith('/attachments')), false);
    const dropped = mockUpstream({ pageThrows: true });
    const network = await publish(dropped);
    assert.equal(network.status, 409);
    assert.equal(network.json.error.code, 'write_unknown');
    assert.equal(network.json.error.message.includes('boom-network'), false);
    const partial = mockUpstream({ attachmentStatus: 500 });
    const half = await publish(partial);
    assert.equal(half.status, 409);
    assert.equal(half.json.error.code, 'write_unknown');
    assert.equal(half.json.pageId, '9001');
    assert.equal(half.json.readBack, true);
    assert.equal(partial.calls.some(call => call.method === 'POST' && call.path.endsWith('/label')), false);
    const laterLimit = mockUpstream({ attachmentStatus: 429, attachmentHeaders: { 'Retry-After': '5' } });
    const later = await publish(laterLimit);
    assert.equal(later.status, 409);
    assert.equal(later.json.error.code, 'write_partial');
    assert.equal(later.json.pageId, '9001');
    assert.equal(later.headers.get('retry-after'), '5');
    assert.equal(laterLimit.calls.some(call => call.method === 'POST' && call.path.endsWith('/label')), false);
    const redirected = mockUpstream({ downloadStatus: 302 });
    const redirect = await publish(redirected);
    assert.equal(redirect.status, 409);
    assert.equal(redirect.json.error.code, 'write_unknown');
    assert.equal(redirect.json.pageId, '9001');
    assert.equal(redirected.calls.some(call => call.host === 'evil.example'), false);
    const tampered = mockUpstream({ tamperDownload: true });
    const badFile = await publish(tampered);
    assert.equal(badFile.status, 409);
    assert.equal(badFile.json.error.code, 'write_partial');
    assert.equal(badFile.json.pageId, '9001');
    assert.equal(tampered.calls.some(call => call.method === 'POST' && call.path.endsWith('/label')), false);
    const unlabeled = mockUpstream({ hideLabel: true });
    const unfinished = await publish(unlabeled);
    assert.equal(unfinished.status, 409);
    assert.equal(unfinished.json.error.code, 'write_partial');
    assert.equal(unfinished.json.pageId, '9001');
  });

  test('lists and reads only ready parent children and rejects bad cursors and bytes', async () => {
    installBundle();
    const minted = await mint();
    const auth = { Authorization: `Bearer ${minted.session}` };
    const upstream = mockUpstream({ listHash: true });
    upstream.store.file = JSON.stringify(canonical(archive));
    const listed = await read(await gateway('/v1/confluence/archives?cursor=safe_CURSOR-1', {
      headers: auth,
      fetchImpl: upstream.fetchImpl,
    }));
    assert.equal(listed.status, 200);
    assert.equal(listed.json.items.length, 1);
    assert.equal(listed.json.items[0].pageId, '9001');
    assert.equal(listed.json.items[0].webUrl, `${SITE}/wiki/spaces/Falsify/pages/9001/Falsify`);
    assert.equal(listed.json.nextCursor, 'safe_CURSOR-1');
    assert.equal(listed.json.items.some(item => item.pageId === '9003'), false);
    const childCalls = upstream.calls.filter(call => call.path.endsWith('/children'));
    assert.equal(childCalls.length, 1);
    assert.equal(childCalls[0].host, 'api.atlassian.com');
    assert.equal(childCalls[0].url.includes('cursor=safe_CURSOR-1'), true);
    assert.equal(upstream.calls.filter(call => call.url.includes('safe_CURSOR-1')).length, 1);
    const missing = await read(await gateway('/v1/confluence/archives/9003', { headers: auth, fetchImpl: upstream.fetchImpl }));
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'not_found');
    const loaded = await read(await gateway('/v1/confluence/archives/9001', { headers: auth, fetchImpl: mockUpstream({ listHash: true, downloadText: JSON.stringify(canonical(archive)) }).fetchImpl }));
    assert.equal(loaded.status, 200);
    assert.equal(loaded.json.archiveSha256, HASH);
    assert.equal(loaded.json.archive.data.marker, 'RAW-MARKER-DO-NOT-LEAK');
    const altered = JSON.stringify({ ...canonical(archive), id: 'other-run' });
    const hashMismatch = await read(await gateway('/v1/confluence/archives/9001', {
      headers: auth,
      fetchImpl: mockUpstream({ listHash: true, downloadText: altered }).fetchImpl,
    }));
    assert.equal(hashMismatch.status, 422);
    assert.equal(hashMismatch.json.error.code, 'invalid_archive');
    assert.equal(hashMismatch.json.archive, undefined);
    const redirect = mockUpstream({ listHash: true, downloadStatus: 302 });
    const refused = await read(await gateway('/v1/confluence/archives/9001', { headers: auth, fetchImpl: redirect.fetchImpl }));
    assert.equal(refused.status, 502);
    assert.equal(refused.json.error.code, 'redirect_refused');
    assert.equal(redirect.calls.some(call => call.host === 'evil.example'), false);
    const evilCursor = mockUpstream();
    const badCursor = await read(await gateway('/v1/confluence/archives?cursor=https://evil.example/steal', {
      headers: auth,
      fetchImpl: evilCursor.fetchImpl,
    }));
    assert.equal(badCursor.status, 400);
    assert.equal(badCursor.json.error.code, 'invalid_cursor');
    assert.equal(evilCursor.calls.length, 0);
    const evilNext = await read(await gateway('/v1/confluence/archives', {
      headers: auth,
      fetchImpl: mockUpstream({ evilNext: true, children: [] }).fetchImpl,
    }));
    assert.equal(evilNext.status, 502);
    assert.equal(evilNext.json.error.code, 'upstream_invalid');
    const broken = await read(await gateway('/v1/confluence/archives', {
      headers: auth,
      fetchImpl: mockUpstream({ listBroken: true, children: [{ id: '9001', parentId: PARENT }] }).fetchImpl,
    }));
    assert.equal(broken.status, 502);
    assert.equal(broken.json.error.code, 'upstream_invalid');
    const retired = await read(await gateway('/v1/confluence/archives', {
      headers: { Authorization: `Bearer fss_${'a'.repeat(43)}` },
      env: { ...baseEnv(), DB: { prepare() { throw new Error('db touched'); } } },
      fetchImpl: mockUpstream().fetchImpl,
    }));
    assert.equal(retired.status, 401);
    assert.equal(retired.json.error.code, 'unauthorized');
  });

  test('worker logs stay redacted, legacy writes retire, and old reads remain', async () => {
    installBundle();
    const lines = [];
    const log = console.log;
    const err = console.error;
    console.log = (...args) => lines.push(args.map(String).join(' '));
    console.error = (...args) => lines.push(args.map(String).join(' '));
    const previousFetch = globalThis.fetch;
    try {
      const minted = await mint({ now: Date.now() });
      const upstream = mockUpstream();
      globalThis.fetch = upstream.fetchImpl;
      let prepares = 0;
      const env = baseEnv({ CONFLUENCE_ONLY: 'true', DB: { prepare() { prepares += 1; throw new Error('db touched'); } } });
      const published = await worker.fetch(new Request('https://worker.example/v1/confluence/archives', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
        body: JSON.stringify({ archive, teamShare: true }),
      }), env);
      assert.equal(published.status, 201);
      assert.equal(prepares, 0);
      assert.equal(published.headers.get('access-control-allow-origin'), ORIGIN);
      const callback = await worker.fetch(new Request(`https://worker.example/v1/confluence/auth/callback?code=auth-code-1&state=${encodeURIComponent(minted.state)}`, {
        headers: { Origin: 'https://evil.example' },
      }), env);
      assert.equal(callback.status, 200);
      assert.equal(callback.headers.get('access-control-allow-origin'), null);
      assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
      const html = await callback.text();
      const message = posted(html);
      assert.equal(message.origin, ORIGIN);
      assert.equal(message.message.nonce, 'n'.repeat(16));
      assert.equal(html.includes(SECRET), false);
      assert.equal(html.includes('access-token-'), false);
      const writes = [
        ['POST', '/v1/auth/register'],
        ['POST', '/v1/auth/login'],
        ['POST', '/v1/auth/password'],
        ['POST', '/v1/auth/sessions/revoke'],
        ['POST', '/v1/logout'],
        ['POST', '/v1/records'],
        ['PATCH', '/v1/records/22222222-2222-4222-8222-222222222222'],
        ['DELETE', '/v1/records/22222222-2222-4222-8222-222222222222'],
      ];
      for (const [method, path] of writes) {
        const response = await worker.fetch(new Request(`https://worker.example${path}`, {
          method,
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'If-Match': '"1"' },
          body: '{}',
        }), env);
        assert.equal(response.status, 410);
        const payload = await response.json();
        assert.equal(payload.error.code, 'storage_moved');
        assert.equal(payload.error.message, 'Remote records moved to the Falsify Confluence archive. This account or record write is no longer accepted.');
      }
      assert.equal(prepares, 0);
      const health = await worker.fetch(new Request('https://worker.example/v1/health', { headers: { Origin: ORIGIN } }), env);
      assert.equal(health.status, 200);
      const withoutDb = await worker.fetch(new Request('https://worker.example/v1/records/22222222-2222-4222-8222-222222222222', {
        headers: { Origin: ORIGIN, Authorization: `Bearer fss_${'b'.repeat(43)}` },
      }), baseEnv({ CONFLUENCE_ONLY: 'true' }));
      assert.equal(withoutDb.status, 503);
      assert.equal((await withoutDb.json()).error.code, 'not_configured');
      const authorId = '11111111-1111-4111-8111-111111111111';
      const recordId = '22222222-2222-4222-8222-222222222222';
      const preserved = { schema: 'kept', note: 'historical-private', marker: 'PRESERVE-ME' };
      const db = {
        prepare(sql) {
          return { bind() { return { async first() {
            if (sql.includes('FROM sessions')) return { id: authorId, username: 'old', display_name: 'Old', member_status: 'active' };
            if (sql.includes('FROM records')) {
              return {
                id: recordId, owner_id: authorId, username: 'old', display_name: 'Old', kind: 'run', visibility: 'private',
                created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z', revision: 3,
                payload: JSON.stringify(preserved), public_payload: JSON.stringify({ schema: 'public' }), review_visible: 1,
              };
            }
            throw new Error(`unexpected sql ${sql}`);
          } }; } };
        },
      };
      const old = await worker.fetch(new Request(`https://worker.example/v1/records/${recordId}`, {
        headers: { Origin: ORIGIN, Authorization: `Bearer fss_${'c'.repeat(43)}` },
      }), baseEnv({ CONFLUENCE_ONLY: 'true', DB: db }));
      assert.equal(old.status, 200);
      const oldBody = await old.json();
      assert.deepEqual(oldBody.record.payload, preserved);
      assert.equal(oldBody.record.visibility, 'private');
      const open = await worker.fetch(new Request('https://worker.example/v1/auth/login', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: '{}',
      }), baseEnv({ CONFLUENCE_ONLY: 'false', DB: {} }));
      assert.equal(open.status, 400);
      const forbidden = await worker.fetch(new Request('https://worker.example/v1/confluence/capabilities', {
        headers: { Origin: 'https://evil.example' },
      }), baseEnv());
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.headers.get('access-control-allow-origin'), null);
    } finally {
      console.log = log;
      console.error = err;
      globalThis.fetch = previousFetch;
    }
    const joined = lines.join('\n');
    assert.equal(joined.includes(SECRET), false);
    assert.equal(joined.includes('access-token-'), false);
    assert.equal(joined.includes('auth-code-1'), false);
    assert.equal(joined.includes('RAW-MARKER-DO-NOT-LEAK'), false);
    assert.equal(joined.includes('PRESERVE-ME'), false);
    assert.match(joined, /"route":"\/v1\/confluence\/auth\/callback"/);
    assert.match(joined, /"route":"\/v1\/records\/:id"/);
    const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    assert.equal(wrangler.includes('ATLASSIAN_CLIENT_SECRET'), false);
    assert.equal(wrangler.includes('CONFLUENCE_SESSION_KEY'), false);
    assert.equal(wrangler.includes('424242'), false);
    assert.equal(wrangler.split('"CONFLUENCE_PARENT_PAGE_ID": "8355842"').length, 3);
    assert.equal(wrangler.split('"ATLASSIAN_CLIENT_ID": "db5aa4f3-b807-43bd-95fa-4bdda751406e"').length, 3);
    assert.match(wrangler, /"CONFLUENCE_ONLY": "false"/);
    assert.match(wrangler, /"REMOTE_PROVIDER": "confluence"/);
    assert.match(wrangler, /"database_name": "falsify-harness-records"/);
    assert.match(wrangler, /"database_name": "falsify-harness-records-staging"/);
    assert.match(wrangler, /"compatibility_date": "2026-10-19"/);
    assert.match(wrangler, /"name": "falsify-cloud-api"/);
  });
});
