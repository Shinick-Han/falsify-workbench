// Full-worker mount checks. OpenAlex and arXiv are answered inside this process.
// Fixtures are synthetic. Nothing in this file is a copied abstract.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '..');
const repoRoot = path.resolve(apiRoot, '../..');

function cloudRequire() {
  const local = createRequire(import.meta.url);
  try {
    local.resolve('miniflare');
    local.resolve('esbuild');
    return local;
  } catch { /* NODE_PATH below */ }
  for (const dir of (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) {
    if (!existsSync(path.join(dir, 'miniflare', 'package.json')) || !existsSync(path.join(dir, 'esbuild', 'package.json'))) continue;
    const parentPkg = path.join(dir, '..', 'package.json');
    return createRequire(existsSync(parentPkg) ? parentPkg : path.join(dir, 'miniflare', 'package.json'));
  }
  throw new Error('miniflare and esbuild were not found next to this test or on NODE_PATH');
}

const require = cloudRequire();
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');

const integratedCore = path.join(repoRoot, 'app/dist/cloud-records-core.mjs');
const corePath = process.env.FALSIFY_CLOUD_CORE || (existsSync(integratedCore) ? integratedCore : path.resolve(repoRoot, '../contract/app/dist/cloud-records-core.mjs'));
const harnessPath = path.join(repoRoot, 'app/dist/harness-core.js');

const ORIGIN = 'https://shinick-han.github.io';
const USER_AGENT = 'falsify-workbench-booth/1.0 (+https://github.com/Shinick-Han/falsify-workbench)';
const QUERY = 'synthetic-mount-query';
const SEARCH_ID = '2503.10497';
const PDF_ID = '2503.00072';
const CC_BY_NC = 'http://creativecommons.org/licenses/by-nc/4.0/';

let script;
let statements;
let workerSeq = 0;

function stripSqlComments(sql) {
  let out = '';
  let quote = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      if (sql[i] === '\n') out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

function migrationStatements() {
  const sql = ['0001_shared_records.sql', '0002_invite_membership.sql', '0003_hosted_ai.sql', '0004_owner_usage.sql', '0005_guest_sessions.sql', '0006_booth.sql', '0007_booth_recipes.sql']
    .map(name => readFileSync(path.join(apiRoot, 'migrations', name), 'utf8'))
    .join('\n');
  return stripSqlComments(sql).split(';').map(part => part.trim()).filter(Boolean);
}

function openAlexBody() {
  return JSON.stringify({
    meta: { count: 25, page: 1, per_page: 10 },
    results: [{
      display_name: 'Synthetic Mount Paper',
      publication_year: 2024,
      authorships: [
        { author: { display_name: 'Ada Example' } },
        { author: { display_name: 'Bo Example' } },
      ],
      abstract_inverted_index: { Synthetic: [0], mount: [1], abstract: [2] },
      best_oa_location: {
        license: 'cc-by',
        pdf_url: `https://arxiv.org/pdf/${SEARCH_ID}`,
        landing_page_url: `https://arxiv.org/abs/${SEARCH_ID}`,
      },
      ids: { doi: null },
    }],
  });
}

function oaiByNc() {
  return `<?xml version="1.0"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <GetRecord><record>
    <header><identifier>oai:arXiv.org:${PDF_ID}</identifier></header>
    <metadata><arXiv><id>${PDF_ID}</id><license>${CC_BY_NC}</license></arXiv></metadata>
  </record></GetRecord>
</OAI-PMH>`;
}

function outbound(request, calls) {
  const url = new URL(request.url);
  calls.push({
    href: url.href,
    host: url.hostname,
    path: url.pathname,
    method: request.method,
    authorization: request.headers.get('authorization'),
    ua: request.headers.get('user-agent'),
    filter: url.searchParams.get('filter'),
    search: url.searchParams.get('search'),
    apiKey: url.searchParams.get('api_key'),
  });
  if (url.hostname === 'api.openalex.org') {
    return new Response(openAlexBody(), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.hostname === 'oaipmh.arxiv.org') {
    return new Response(oaiByNc(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }
  // A PDF byte fetch or an Atom fallback must fail closed inside the test.
  if (url.hostname === 'arxiv.org' || url.hostname === 'export.arxiv.org') {
    return new Response('upstream fetch refused', { status: 500 });
  }
  return new Response('unhandled host', { status: 599 });
}

async function start({ calls, logs, bindings = {} }) {
  workerSeq += 1;
  const instance = new Miniflare(convertV4MiniflareOptions({
    name: `falsify-paper-search-mount-${workerSeq}`,
    modules: true,
    script,
    compatibilityDate: '2026-10-19',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      ALLOWED_ORIGINS: ORIGIN,
      AI_HOSTING_ENABLED: 'true',
      AI_OPEN_ACCESS: 'true',
      ...bindings,
    },
    d1Databases: ['DB'],
    outboundService: request => outbound(request, calls),
    handleStructuredLogs: log => {
      if (log && typeof log.message === 'string') logs.push(log.message);
    },
  }));
  const d1 = await instance.getD1Database('DB');
  for (const statement of statements) await d1.prepare(statement).run();
  return instance;
}

function client(instance) {
  return async (method, pathname, { token, body, headers = {} } = {}) => {
    const h = { Origin: ORIGIN, ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) payload = JSON.stringify(body);
    if (typeof payload === 'string' && !Object.keys(h).some(key => key.toLowerCase() === 'content-type')) {
      h['Content-Type'] = 'application/json';
    }
    const response = await instance.dispatchFetch(`https://api.test${pathname}`, { method, headers: h, body: payload });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, headers: response.headers, body: parsed, text };
  };
}

async function withApp(bindings, fn) {
  const calls = [];
  const logs = [];
  const instance = await start({ calls, logs, bindings });
  try {
    return await fn({ call: client(instance), calls, logs });
  } finally {
    await instance.dispose();
  }
}

function requestEvents(logs) {
  const events = [];
  for (const message of logs) {
    let value = message;
    for (let depth = 0; depth < 2 && typeof value === 'string'; depth += 1) {
      try { value = JSON.parse(value); } catch { value = null; }
    }
    if (value && value.event === 'request') {
      events.push({ body: value, text: message });
      continue;
    }
    if (value && typeof value.message === 'string') {
      try {
        const inner = JSON.parse(value.message);
        if (inner && inner.event === 'request') events.push({ body: inner, text: value.message });
      } catch { /* not the request line */ }
    }
  }
  return events;
}

function assertSearchRouteLog(logs, status) {
  const events = requestEvents(logs).filter(item => item.body.route === '/v1/papers/search' && item.body.status === status);
  assert.equal(events.length, 1, JSON.stringify(logs));
  const hit = events[0];
  assert.equal(hit.body.event, 'request');
  assert.equal(hit.body.method, 'GET');
  assert.equal(hit.body.route, '/v1/papers/search');
  assert.equal(hit.text.includes(QUERY), false);
  assert.equal(hit.text.includes('?'), false);
  assert.equal(hit.text.includes(SEARCH_ID), false);
  assert.equal(hit.text.includes(PDF_ID), false);
}

async function mintGuest(call) {
  const minted = await call('POST', '/v1/ai/guest', { body: {} });
  assert.equal(minted.status, 201, minted.text);
  assert.match(minted.body.guest.token, /^fsg_[A-Za-z0-9_-]{43}$/);
  return minted.body.guest.token;
}

describe('mounted paper search', { concurrency: false }, () => {
  before(async () => {
    const result = await build({
      entryPoints: [path.join(apiRoot, 'src/index.js')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      external: ['node:*'],
      logLevel: 'silent',
      plugins: [{
        name: 'shared-core',
        setup(esbuild) {
          esbuild.onResolve({ filter: /cloud-records-core\.mjs$/ }, () => ({ path: corePath }));
          esbuild.onResolve({ filter: /harness-core\.js$/ }, () => ({ path: harnessPath }));
        },
      }],
    });
    script = result.outputFiles[0].text;
    statements = migrationStatements();
  });

  test('GET /v1/papers/search is 404 not_found when PAPER_SEARCH_ENABLED is absent', async () => {
    await withApp({}, async ({ call, calls, logs }) => {
      const denied = await call('GET', `/v1/papers/search?q=${QUERY}`);
      assert.equal(denied.status, 404);
      assert.equal(denied.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(denied.body.error.code, 'not_found');
      assert.equal(denied.body.error.retryable, false);
      assert.match(denied.body.error.requestId, /^req_[0-9a-f]{32}$/);
      assert.equal(calls.length, 0);
      assertSearchRouteLog(logs, 404);
    });
  });

  test('a guest search reaches OpenAlex and returns the envelope with pages CORS', async () => {
    await withApp({ PAPER_SEARCH_ENABLED: 'true' }, async ({ call, calls }) => {
      const token = await mintGuest(call);
      const found = await call('GET', `/v1/papers/search?q=${QUERY}&page=1`, { token });
      assert.equal(found.status, 200, found.text);
      assert.equal(found.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(found.headers.get('cache-control'), 'public, max-age=3600');
      assert.equal(found.headers.get('access-control-allow-origin'), ORIGIN);
      assert.equal(found.body.source, 'arxiv');
      assert.equal(found.body.page, 1);
      assert.equal(found.body.hasMore, true);
      assert.deepEqual(found.body.results, [{
        source: 'arxiv',
        id: SEARCH_ID,
        title: 'Synthetic Mount Paper',
        authors: ['Ada Example', 'Bo Example'],
        year: 2024,
        abstract: 'Synthetic mount abstract',
        license: { id: 'cc-by', url: 'https://creativecommons.org/licenses/by/4.0/' },
        licenseVerified: true,
        landingUrl: `https://arxiv.org/abs/${SEARCH_ID}`,
      }]);
      const openAlex = calls.filter(item => item.host === 'api.openalex.org');
      assert.equal(openAlex.length, 1);
      assert.equal(openAlex[0].method, 'GET');
      assert.equal(openAlex[0].path, '/works');
      assert.equal(openAlex[0].search, QUERY);
      assert.equal(openAlex[0].filter.includes('S4306400194'), true);
      assert.equal(openAlex[0].filter.includes('cc-by'), true);
      assert.equal(openAlex[0].apiKey, null);
      assert.equal(openAlex[0].href.includes('api_key'), false);
      assert.equal(openAlex[0].href.includes('mailto'), false);
      assert.equal(openAlex[0].href.includes('@'), false);
      assert.equal(openAlex[0].href.includes('fsg_'), false);
      assert.equal(openAlex[0].authorization, null);
      assert.equal(openAlex[0].ua, USER_AGENT);
      assert.equal(openAlex[0].ua.includes('@'), false);
      assert.equal(calls.some(item => item.host === 'export.arxiv.org'), false);
      assert.equal(calls.some(item => item.host === 'arxiv.org'), false);
    });
  });

  test('a non-CC PDF id is 403 license_not_allowed and never fetches arxiv.org', async () => {
    await withApp({ PAPER_SEARCH_ENABLED: 'true' }, async ({ call, calls }) => {
      const token = await mintGuest(call);
      const denied = await call('GET', `/v1/papers/pdf?id=${PDF_ID}`, { token });
      assert.equal(denied.status, 403, denied.text);
      assert.equal(denied.body.error.code, 'license_not_allowed');
      assert.equal(denied.body.error.retryable, false);
      assert.match(denied.body.error.requestId, /^req_[0-9a-f]{32}$/);
      assert.deepEqual(calls.map(item => item.host), ['oaipmh.arxiv.org']);
      assert.equal(calls[0].href.includes('verb=GetRecord'), true);
      assert.equal(calls[0].href.includes(`oai%3AarXiv.org%3A${PDF_ID}`) || calls[0].href.includes(`oai:arXiv.org:${PDF_ID}`), true);
      assert.equal(calls.some(item => item.host === 'arxiv.org'), false);
      assert.equal(calls.some(item => item.host === 'export.arxiv.org'), false);
      assert.equal(calls.some(item => item.host === 'api.openalex.org'), false);
    });
  });

  test('the request log line uses route /v1/papers/search and omits the query string', async () => {
    await withApp({ PAPER_SEARCH_ENABLED: 'true' }, async ({ call, logs }) => {
      const token = await mintGuest(call);
      logs.length = 0;
      const found = await call('GET', `/v1/papers/search?q=${QUERY}`, { token });
      assert.equal(found.status, 200, found.text);
      assertSearchRouteLog(logs, 200);
      assert.equal(logs.some(message => message.includes(QUERY)), false);
    });
  });
});
