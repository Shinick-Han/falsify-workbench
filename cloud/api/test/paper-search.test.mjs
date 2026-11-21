// Offline paper-search tests. Fixtures are synthetic. Nothing in this file is a copied abstract,
// and fetchImpl never leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPaperSearch, handlePaperSearchRequest, clearPdfMemoForTests, agePdfMemoForTests } from '../src/paper-search.mjs';

const USER_AGENT = 'falsify-workbench-booth/1.0 (+https://github.com/Shinick-Han/falsify-workbench)';
const AUTHOR = '11111111-1111-4111-8111-111111111111';
const GUEST_ID = '22222222-2222-4222-8222-222222222222';
const SESSION = `fss_${'b'.repeat(43)}`;
const GUEST = `fsg_${'a'.repeat(43)}`;
const SESSION_KEY = Buffer.alloc(32, 7).toString('base64');
const IP = '203.0.113.10';

const CC_BY = 'http://creativecommons.org/licenses/by/4.0/';
const CC_BY_3 = 'http://creativecommons.org/licenses/by/3.0/';
const CC_BY_SA = 'http://creativecommons.org/licenses/by-sa/4.0/';
const CC0 = 'http://creativecommons.org/publicdomain/zero/1.0/';
const CC_BY_NC = 'http://creativecommons.org/licenses/by-nc/4.0/';
const CC_BY_NC_SA = 'http://creativecommons.org/licenses/by-nc-sa/4.0/';
const CC_BY_NC_ND = 'http://creativecommons.org/licenses/by-nc-nd/4.0/';
const CC_BY_ND = 'http://creativecommons.org/licenses/by-nd/4.0/';
const ARXIV_NONEXCLUSIVE = 'http://arxiv.org/licenses/nonexclusive-distrib/1.0/';
const BOOTH_CAP = 16 * 1024 * 1024;

function baseEnv(extra = {}) {
  return { CONFLUENCE_SESSION_KEY: SESSION_KEY, PAPER_SEARCH_ENABLED: 'true', ...extra };
}

function testDeps(options = {}) {
  const counts = new Map();
  const rateCalls = [];
  const releases = [];
  let authCalls = 0;
  const deps = {
    getDb: () => options.db || {},
    async rateLimit(_db, bucket, limit) {
      rateCalls.push({ bucket, limit });
      const n = (counts.get(bucket) || 0) + 1;
      counts.set(bucket, n);
      if (n > limit) {
        const error = new Error('rate_limited');
        error.status = 429;
        error.code = 'rate_limited';
        error.headers = { 'Retry-After': '30' };
        throw error;
      }
      return n;
    },
    async releaseSlot(_db, bucket, slot) {
      releases.push({ bucket, slot });
      counts.set(bucket, Math.max(0, (counts.get(bucket) || 1) - 1));
    },
    async authenticatePassword() {
      authCalls += 1;
      if (options.authError) throw options.authError;
      return { id: AUTHOR };
    },
    clientIp: () => options.ip || IP,
  };
  return { deps, rateCalls, releases, authCalls: () => authCalls };
}

function memoryCache() {
  const store = new Map();
  return {
    async match(request) {
      const hit = store.get(request.url);
      if (!hit) return undefined;
      return new Response(hit.body.slice(), { status: hit.status, headers: hit.headers });
    },
    async put(request, response) {
      const headers = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      store.set(request.url, { body: new Uint8Array(await response.arrayBuffer()), status: response.status, headers });
    },
    entries() { return [...store.entries()]; },
    get size() { return store.size; },
  };
}

function pdfBytes(size = 20) {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('%PDF-'));
  for (let i = 5; i < size; i += 1) bytes[i] = 0x20;
  return bytes;
}

function chunked(parts, headers) {
  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === 'string' ? new TextEncoder().encode(part) : part);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

function oaiXml(license) {
  const licenseTag = license ? `<license>${license}</license>` : '';
  return `<?xml version="1.0"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <GetRecord><record>
    <header><identifier>oai:arXiv.org:2503.00001</identifier></header>
    <metadata><arXiv><id>2503.00001</id>${licenseTag}</arXiv></metadata>
  </record></GetRecord>
</OAI-PMH>`;
}

function oaiMissing() {
  return `<?xml version="1.0"?><OAI-PMH><error code="idDoesNotExist">gone</error></OAI-PMH>`;
}

function atomEntriesFeed(entries, total = entries.length) {
  const body = entries.map(entry => {
    const authors = (entry.authors || ['Ada Example']).map(name => `<author><name>${name}</name></author>`).join('');
    return `<entry>
    <id>http://arxiv.org/abs/${entry.id}</id>
    <title>${entry.title || `Synthetic ${entry.id}`}</title>
    <summary>${entry.summary || 'Synthetic booth summary.'}</summary>
    <published>${entry.published || '2024-01-02T00:00:00Z'}</published>
    ${authors}
  </entry>`;
  }).join('\n');
  return `<?xml version="1.0"?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults>${total}</opensearch:totalResults>
  ${body}
</feed>`;
}

function atomFeed({ id = '2503.10497v1', title = 'Cats &amp; dogs', summary = 'Synthetic booth summary.', total = 25, authors = ['Ada Example'] } = {}) {
  return atomEntriesFeed([{ id, title, summary, authors }], total);
}

function oaiId(target) {
  return (target.searchParams.get('identifier') || '').replace(/^oai:arXiv\.org:/, '');
}

function rangeOk(size = 730780) {
  return new Response(new TextEncoder().encode('%PDF-'), {
    status: 206,
    headers: { 'Content-Type': 'application/pdf', 'Content-Range': `bytes 0-4/${size}` },
  });
}

function openAlexWork(extra = {}) {
  const authors = extra.authors || ['Ada Example', 'Bo Example'];
  return {
    display_name: extra.title || 'Synthetic Booth Paper',
    publication_year: extra.year || 2024,
    authorships: authors.map(name => ({ author: { display_name: name } })),
    abstract_inverted_index: extra.inverted || { Synthetic: [0], booth: [1], abstract: [2] },
    best_oa_location: {
      license: extra.license || 'cc-by',
      pdf_url: extra.pdf || 'https://arxiv.org/pdf/2503.10497',
      landing_page_url: 'https://arxiv.org/abs/2503.10497',
    },
    ids: { doi: extra.doi || null },
  };
}

function openAlexBody(extra = {}) {
  return JSON.stringify({
    meta: { count: extra.count ?? 25, page: extra.page || 1, per_page: 10 },
    results: extra.results || [openAlexWork(extra)],
  });
}

function jsonResponse(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function routes(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(String(url));
    const headers = new Headers(init.headers || {});
    calls.push({ href: String(url), host: target.hostname, ua: headers.get('user-agent'), redirect: init.redirect, init });
    const handler = handlers[target.hostname];
    if (!handler) return new Response('unhandled host', { status: 599 });
    return handler(target, init);
  };
  return { fetchImpl, calls };
}

function assertUpstreamIdentity(calls) {
  for (const call of calls) {
    assert.equal(call.ua, USER_AGENT);
    assert.equal(call.ua.includes('@'), false);
    assert.equal(call.redirect, 'manual');
    assert.equal(call.href.includes(AUTHOR), false);
    assert.equal(call.href.includes(GUEST_ID), false);
    assert.equal(call.href.includes(IP), false);
    assert.equal(call.href.includes('mailto'), false);
    const headerText = JSON.stringify(call.init.headers);
    assert.equal(headerText.includes('@'), false);
    assert.equal(headerText.includes(AUTHOR), false);
    assert.equal(headerText.includes('gst:'), false);
  }
}

async function send(options) {
  const url = new URL(`https://booth.test${options.pathname}${options.query ? `?${options.query}` : ''}`);
  const headers = new Headers();
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  const request = new Request(url, { method: options.method || 'GET', headers });
  return handlePaperSearchRequest({
    request,
    env: baseEnv(options.env),
    url,
    match: options.match === undefined ? matchPaperSearch(url.pathname) : options.match,
    fetchImpl: options.fetchImpl || (async () => { throw new Error('unexpected fetch'); }),
    cache: options.cache,
    deps: options.deps,
  });
}

async function errorOf(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const body = await response.json();
  assert.equal(typeof body.error.requestId, 'string');
  assert.match(body.error.requestId, /^req_[0-9a-f]{32}$/);
  return body.error;
}

test('matchPaperSearch only claims /v1/papers paths', () => {
  assert.deepEqual(matchPaperSearch('/v1/papers/search'), { template: '/v1/papers/search', params: {} });
  assert.deepEqual(matchPaperSearch('/v1/papers/pdf'), { template: '/v1/papers/pdf', params: {} });
  assert.equal(matchPaperSearch('/v1/papers/other').template, '/v1/papers/unknown');
  assert.equal(matchPaperSearch('/v1/papers'), null);
  assert.equal(matchPaperSearch('/v1/ai/jobs'), null);
  assert.equal(matchPaperSearch('/v1/papers-extra'), null);
});

test('disabled search is 404 before auth', async () => {
  const tracked = testDeps();
  let fetched = 0;
  const response = await send({
    pathname: '/v1/papers/search',
    query: 'q=graph',
    env: { PAPER_SEARCH_ENABLED: 'false' },
    deps: tracked.deps,
    fetchImpl: async () => { fetched += 1; return new Response('no'); },
  });
  assert.equal(response.status, 404);
  assert.equal((await errorOf(response)).code, 'not_found');
  assert.equal(tracked.authCalls(), 0);
  assert.equal(tracked.rateCalls.length, 0);
  assert.equal(fetched, 0);
});

test('missing and invalid bearers are 401 and do not call upstream', async () => {
  const cases = [null, 'not-a-session'];
  for (const token of cases) {
    const tracked = testDeps();
    let fetched = 0;
    const response = await send({
      pathname: '/v1/papers/search',
      query: 'q=graph',
      token,
      deps: tracked.deps,
      fetchImpl: async () => { fetched += 1; return new Response('no'); },
    });
    assert.equal(response.status, 401, String(token));
    const error = await errorOf(response);
    assert.equal(error.code, 'unauthorized');
    assert.equal(error.retryable, false);
    assert.equal(fetched, 0);
  }
  const guest = testDeps({
    db: { prepare() { return { bind() { return this; }, async first() { return null; } }; } },
  });
  let fetched = 0;
  const unknownGuest = await send({
    pathname: '/v1/papers/search',
    query: 'q=graph',
    token: GUEST,
    env: { AI_OPEN_ACCESS: 'true' },
    deps: guest.deps,
    fetchImpl: async () => { fetched += 1; return new Response('no'); },
  });
  assert.equal(unknownGuest.status, 401);
  assert.equal((await errorOf(unknownGuest)).code, 'unauthorized');
  assert.equal(fetched, 0);
  const rejected = testDeps({
    authError: Object.assign(new Error('unauthorized'), { status: 401, code: 'unauthorized' }),
  });
  const badSession = await send({
    pathname: '/v1/papers/search',
    query: 'q=graph',
    token: SESSION,
    deps: rejected.deps,
    fetchImpl: async () => { fetched += 1; return new Response('no'); },
  });
  assert.equal(badSession.status, 401);
  assert.equal((await errorOf(badSession)).code, 'unauthorized');
  assert.equal(fetched, 0);
});

test('OPTIONS is a preflight only when search is enabled', async () => {
  const tracked = testDeps();
  const open = await send({ pathname: '/v1/papers/search', method: 'OPTIONS', deps: tracked.deps });
  assert.equal(open.status, 204);
  assert.equal(open.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.match(open.headers.get('access-control-allow-headers'), /authorization/i);
  assert.equal(tracked.authCalls(), 0);
  const closed = await send({
    pathname: '/v1/papers/pdf',
    method: 'OPTIONS',
    env: { PAPER_SEARCH_ENABLED: 'no' },
    deps: tracked.deps,
  });
  assert.equal(closed.status, 404);
  assert.equal(tracked.authCalls(), 0);
});

test('POST is 401 without a bearer and 405 after auth', async () => {
  const anonymous = await send({ pathname: '/v1/papers/search', method: 'POST', deps: testDeps().deps });
  assert.equal(anonymous.status, 401);
  const tracked = testDeps();
  const authed = await send({ pathname: '/v1/papers/search', method: 'POST', token: SESSION, deps: tracked.deps });
  assert.equal(authed.status, 405);
  assert.equal(authed.headers.get('allow'), 'GET');
  assert.equal((await errorOf(authed)).code, 'method_not_allowed');
  assert.equal(tracked.rateCalls.length, 0);
});

test('OpenAlex happy path verifies the actual arXiv OAI license and keeps the fixed upstream policy', async () => {
  const names = ['Ada Example', 'Bo Example', 'Cy Example', 'Di Example', 'Ed Example', 'Fa Example', 'Gu Example', 'Ho Example'];
  const routed = routes({
    'api.openalex.org': () => jsonResponse(200, openAlexBody({ authors: names, license: 'cc-by' })),
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
  });
  const response = await send({
    pathname: '/v1/papers/search',
    query: 'q=graph+nets',
    token: SESSION,
    deps: testDeps().deps,
    fetchImpl: routed.fetchImpl,
    env: { OPENALEX_API_KEY: 'booth-example-key' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  const body = await response.json();
  assert.equal(body.source, 'arxiv');
  assert.equal(body.page, 1);
  assert.equal(body.hasMore, true);
  assert.equal(body.results.length, 1);
  const paper = body.results[0];
  assert.deepEqual(paper, {
    source: 'arxiv',
    id: '2503.10497',
    title: 'Synthetic Booth Paper',
    authors: names.slice(0, 6),
    year: 2024,
    abstract: 'Synthetic booth abstract',
    license: { id: 'cc-by-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    licenseVerified: true,
    landingUrl: 'https://arxiv.org/abs/2503.10497',
  });
  assert.deepEqual(routed.calls.map(call => call.host), ['api.openalex.org', 'oaipmh.arxiv.org']);
  const upstream = new URL(routed.calls[0].href);
  assert.equal(upstream.searchParams.get('filter'), 'best_oa_location.source.id:S4306400194,best_oa_location.license:cc-by|cc-by-sa|public-domain');
  assert.equal(upstream.searchParams.get('per_page'), '10');
  assert.equal(upstream.searchParams.get('search'), 'graph nets');
  assert.equal(upstream.searchParams.has('api_key'), false);
  assert.equal(upstream.searchParams.has('mailto'), false);
  assert.equal(routed.calls[0].href.includes('booth-example-key'), false);
  assert.equal(new Headers(routed.calls[0].init.headers).get('authorization'), 'Bearer booth-example-key');
  assert.equal(routed.calls[1].href.includes('booth-example-key'), false);
  assert.equal(new Headers(routed.calls[1].init.headers).get('authorization'), null);
  assert.equal(JSON.stringify(body).includes('booth-example-key'), false);
  assertUpstreamIdentity(routed.calls);
});

test('OpenAlex failure falls back to the arXiv Atom API and returns only OAI-verified allowed papers', async () => {
  const summary = `${'A'.repeat(701)}`;
  const routed = routes({
    'api.openalex.org': () => new Response('down', { status: 503 }),
    'export.arxiv.org': () => new Response(atomFeed({ summary, total: 25 }), {
      status: 200,
      headers: { 'Content-Type': 'application/atom+xml' },
    }),
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
  });
  const response = await send({
    pathname: '/v1/papers/search',
    query: 'q=synthetic',
    token: SESSION,
    deps: testDeps().deps,
    fetchImpl: routed.fetchImpl,
    env: { OPENALEX_API_KEY: 'booth-example-key' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].title, 'Cats & dogs');
  assert.deepEqual(body.results[0].license, { id: 'cc-by-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' });
  assert.equal(body.results[0].licenseVerified, true);
  assert.equal(body.results[0].id, '2503.10497');
  assert.equal(body.results[0].landingUrl, 'https://arxiv.org/abs/2503.10497');
  assert.equal(body.results[0].year, 2024);
  assert.equal(Array.from(body.results[0].abstract).length, 700);
  assert.equal(body.hasMore, true);
  assert.deepEqual(routed.calls.map(call => call.host), ['api.openalex.org', 'export.arxiv.org', 'oaipmh.arxiv.org']);
  assert.equal(routed.calls[0].href.includes('booth-example-key'), false);
  assert.equal(new Headers(routed.calls[0].init.headers).get('authorization'), 'Bearer booth-example-key');
  assert.equal(routed.calls[1].href.includes('booth-example-key'), false);
  assert.equal(routed.calls[1].href.includes('api_key'), false);
  assert.equal(new Headers(routed.calls[1].init.headers).get('authorization'), null);
  assert.equal(routed.calls[2].href.includes('booth-example-key'), false);
  assert.equal(new Headers(routed.calls[2].init.headers).get('authorization'), null);
  assertUpstreamIdentity(routed.calls);
});

test('query length and page bounds are 400 before upstream', async () => {
  const queries = ['', 'q=', `q=${'a'.repeat(201)}`, 'q=ok&page=0', 'q=ok&page=6', 'q=ok&page=1.5', 'q=ok&extra=1', `q=${encodeURIComponent('😀'.repeat(201))}`];
  for (const query of queries) {
    let fetched = 0;
    const response = await send({
      pathname: '/v1/papers/search',
      query,
      token: SESSION,
      deps: testDeps().deps,
      fetchImpl: async () => { fetched += 1; throw new Error('fetched'); },
    });
    assert.equal(response.status, 400, query);
    assert.equal((await errorOf(response)).code, 'invalid_request');
    assert.equal(fetched, 0);
  }
  const routed = routes({
    'api.openalex.org': () => jsonResponse(200, openAlexBody({ count: 1000 })),
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
  });
  const page = await send({
    pathname: '/v1/papers/search',
    query: 'q=synthetic&page=5',
    token: SESSION,
    deps: testDeps().deps,
    fetchImpl: routed.fetchImpl,
  });
  const body = await page.json();
  assert.equal(body.page, 5);
  assert.equal(body.hasMore, false);
  assert.equal(new URL(routed.calls[0].href).searchParams.get('page'), '5');
  const wide = await send({
    pathname: '/v1/papers/search',
    query: `q=${encodeURIComponent('😀'.repeat(200))}`,
    token: SESSION,
    deps: testDeps().deps,
    fetchImpl: routes({
      'api.openalex.org': () => jsonResponse(200, openAlexBody({ count: 1 })),
      'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
    }).fetchImpl,
  });
  assert.equal(wide.status, 200);
});

test('a search cache hit does not call upstream again and shares the license cache across pages', async () => {
  let openAlexCalls = 0;
  let oaiCalls = 0;
  const routed = routes({
    'api.openalex.org': () => {
      openAlexCalls += 1;
      return jsonResponse(200, openAlexBody());
    },
    'oaipmh.arxiv.org': () => {
      oaiCalls += 1;
      return new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    },
  });
  const cache = memoryCache();
  const deps = testDeps().deps;
  const first = await send({
    pathname: '/v1/papers/search',
    query: 'q=%20%20Hello%20%20%20World%20',
    token: SESSION,
    deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(first.status, 200);
  const second = await send({
    pathname: '/v1/papers/search',
    query: 'q=Hello%20World',
    token: SESSION,
    deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), await first.json());
  assert.equal(openAlexCalls, 1);
  assert.equal(oaiCalls, 1);
  const otherPage = await send({
    pathname: '/v1/papers/search',
    query: 'q=Hello%20World&page=2',
    token: SESSION,
    deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(otherPage.status, 200);
  assert.equal(openAlexCalls, 2);
  assert.equal(oaiCalls, 1, 'same paper on another page reuses the cached OAI verdict');
});

test('license allow, deny, missing id, and a cached deny', async () => {
  const pdf = pdfBytes();
  const licenses = [
    ['2503.00011', CC_BY, 200, 'cc-by-4.0'],
    ['2503.00012', CC_BY_SA, 200, 'cc-by-sa-4.0'],
    ['2503.00013', CC0, 200, 'cc0'],
    ['2503.00014', CC_BY_NC, 403, 'license_not_allowed'],
    ['2503.00015', ARXIV_NONEXCLUSIVE, 403, 'license_not_allowed'],
  ];
  for (const [id, license, status, marker] of licenses) {
    const routed = routes({
      'oaipmh.arxiv.org': () => new Response(oaiXml(license), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
      'arxiv.org': () => new Response(pdf, { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
    });
    const response = await send({
      pathname: '/v1/papers/pdf',
      query: `id=${encodeURIComponent(id)}`,
      token: SESSION,
      deps: testDeps().deps,
      fetchImpl: routed.fetchImpl,
    });
    assert.equal(response.status, status, id);
    if (status === 200) {
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.equal(response.headers.get('x-falsify-paper-license'), marker);
      assert.match(response.headers.get('access-control-expose-headers'), /(^|,\s*)X-Falsify-Paper-License(\s*,|$)/);
      assert.match(response.headers.get('access-control-expose-headers'), /Retry-After/);
      assert.equal(response.headers.get('content-disposition'), `attachment; filename="arxiv-${id}.pdf"`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdf);
      assert.deepEqual(routed.calls.map(call => call.host), ['oaipmh.arxiv.org', 'arxiv.org']);
    } else {
      assert.equal((await errorOf(response)).code, marker);
      assert.deepEqual(routed.calls.map(call => call.host), ['oaipmh.arxiv.org']);
    }
    assertUpstreamIdentity(routed.calls);
  }

  const cache = memoryCache();
  let oaiCalls = 0;
  const denied = routes({
    'oaipmh.arxiv.org': () => {
      oaiCalls += 1;
      return new Response(oaiXml(CC_BY_NC), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    },
    'arxiv.org': () => new Response(pdf, { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
  });
  const deps = testDeps().deps;
  const first = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00021',
    token: SESSION,
    deps,
    cache,
    fetchImpl: denied.fetchImpl,
  });
  const second = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00021v2',
    token: SESSION,
    deps,
    cache,
    fetchImpl: denied.fetchImpl,
  });
  assert.equal(first.status, 403);
  assert.equal(second.status, 403);
  assert.equal(oaiCalls, 1);
  assert.equal(denied.calls.some(call => call.host === 'arxiv.org'), false);

  const missing = routes({
    'oaipmh.arxiv.org': () => new Response(oaiMissing(), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
  });
  const gone = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00031',
    token: SESSION,
    deps: testDeps().deps,
    fetchImpl: missing.fetchImpl,
  });
  assert.equal(gone.status, 404);
  assert.equal((await errorOf(gone)).code, 'not_found');
});

test('id validation rejects URLs, path tricks and bad versions', async () => {
  const rejected = [
    'https://arxiv.org/pdf/2503.10497',
    'http://arxiv.org/abs/2503.10497',
    '2503.10497/../../etc/passwd',
    '../2503.10497',
    '2503.10497v',
    '2503.10497v1234',
    '2503.10497V2',
    '2503.104',
    'not-an-id',
    'hep-th/123',
    'HEP-th/9901001',
  ];
  for (const id of rejected) {
    let fetched = 0;
    const response = await send({
      pathname: '/v1/papers/pdf',
      query: `id=${encodeURIComponent(id)}`,
      token: SESSION,
      deps: testDeps().deps,
      fetchImpl: async () => { fetched += 1; throw new Error('fetched'); },
    });
    assert.equal(response.status, 400, id);
    assert.equal((await errorOf(response)).code, 'invalid_request');
    assert.equal(fetched, 0);
  }
});

test('an old-style id is fetched without putting a slash in the filename', async () => {
  const pdf = pdfBytes();
  const routed = routes({
    'oaipmh.arxiv.org': target => {
      assert.equal(target.searchParams.get('verb'), 'GetRecord');
      assert.equal(target.searchParams.get('metadataPrefix'), 'arXiv');
      assert.equal(target.searchParams.get('identifier'), 'oai:arXiv.org:hep-th/9901001');
      return new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    },
    'arxiv.org': target => {
      assert.equal(target.pathname, '/pdf/hep-th/9901001');
      return new Response(pdf, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    },
  });
  const response = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=hep-th/9901001',
    token: SESSION,
    deps: testDeps().deps,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="arxiv-hep-th-9901001.pdf"');
  assertUpstreamIdentity(routed.calls);
});

test('non-PDF upstream is an error', async () => {
  for (const upstream of [
    new Response('<html>not a pdf</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    new Response('hello world!!', { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
    new Response('down', { status: 404, headers: { 'Content-Type': 'application/pdf' } }),
  ]) {
    const routed = routes({
      'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
      'arxiv.org': () => upstream,
    });
    const response = await send({
      pathname: '/v1/papers/pdf',
      query: 'id=2503.10497',
      token: SESSION,
      deps: testDeps().deps,
      fetchImpl: routed.fetchImpl,
    });
    assert.equal(response.status, 502);
    assert.equal((await errorOf(response)).code, 'upstream_invalid');
  }
});

test('oversize PDFs are 413, including a Content-Length that understates the body', async () => {
  const capped = { AI_MAX_UPLOAD_BYTES: '32' };
  const declared = routes({
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
    'arxiv.org': () => new Response(pdfBytes(20), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': '999999' },
    }),
  });
  const tooBig = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.10497',
    token: SESSION,
    env: capped,
    deps: testDeps().deps,
    fetchImpl: declared.fetchImpl,
  });
  assert.equal(tooBig.status, 413);
  assert.equal((await errorOf(tooBig)).code, 'payload_too_large');

  const buffered = routes({
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC0), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
    'arxiv.org': () => chunked([pdfBytes(40)], { 'Content-Type': 'application/pdf' }),
  });
  const noLength = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00041',
    token: SESSION,
    env: capped,
    deps: testDeps().deps,
    fetchImpl: buffered.fetchImpl,
  });
  assert.equal(noLength.status, 413);
  assert.equal((await errorOf(noLength)).code, 'payload_too_large');

  const lying = routes({
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY_SA), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
    'arxiv.org': () => chunked(['%PDF-1.4', 'Y'.repeat(40)], {
      'Content-Type': 'application/pdf',
      'Content-Length': '8',
    }),
  });
  const streamed = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00042',
    token: SESSION,
    env: capped,
    deps: testDeps().deps,
    fetchImpl: lying.fetchImpl,
  });
  assert.equal(streamed.status, 413);
  assert.equal((await errorOf(streamed)).code, 'payload_too_large');
});

test('a redirect to a foreign host is refused and an arXiv hop is followed', async () => {
  const foreign = routes({
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
    'arxiv.org': () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/pdf/2503.10497' } }),
    'evil.example': () => new Response(pdfBytes(), { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
  });
  const refused = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.10497',
    token: SESSION,
    deps: testDeps().deps,
    fetchImpl: foreign.fetchImpl,
  });
  assert.equal(refused.status, 502);
  assert.equal((await errorOf(refused)).code, 'redirect_refused');
  assert.equal(foreign.calls.some(call => call.host === 'evil.example'), false);

  const insecure = routes({
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
    'arxiv.org': () => new Response(null, { status: 302, headers: { Location: 'http://arxiv.org/pdf/2503.10497' } }),
  });
  const httpHop = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00051',
    token: SESSION,
    deps: testDeps().deps,
    fetchImpl: insecure.fetchImpl,
  });
  assert.equal(httpHop.status, 502);
  assert.equal(insecure.calls.length, 2);

  const pdf = pdfBytes();
  const followed = routes({
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC0), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
    'arxiv.org': () => new Response(null, { status: 302, headers: { Location: 'https://export.arxiv.org/pdf/2503.00052' } }),
    'export.arxiv.org': () => new Response(pdf, { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
  });
  const ok = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00052',
    token: SESSION,
    deps: testDeps().deps,
    fetchImpl: followed.fetchImpl,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-falsify-paper-license'), 'cc0');
  assert.deepEqual(followed.calls.map(call => call.host), ['oaipmh.arxiv.org', 'arxiv.org', 'export.arxiv.org']);
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), pdf);
});

test('search and pdf rate limits return 429 and roll back the earlier slot', async () => {
  const tracked = testDeps();
  const routed = routes({
    'api.openalex.org': () => jsonResponse(200, openAlexBody({ count: 1 })),
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
  });
  const first = await send({
    pathname: '/v1/papers/search',
    query: 'q=synthetic',
    token: SESSION,
    env: { PAPER_SEARCH_PER_OWNER_HOUR: '1' },
    deps: tracked.deps,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(first.status, 200);
  const second = await send({
    pathname: '/v1/papers/search',
    query: 'q=synthetic',
    token: SESSION,
    env: { PAPER_SEARCH_PER_OWNER_HOUR: '1' },
    deps: tracked.deps,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(second.status, 429);
  const error = await errorOf(second);
  assert.equal(error.code, 'rate_limited');
  assert.equal(error.retryable, true);
  assert.equal(second.headers.get('retry-after'), '30');
  assert.equal(second.headers.get('access-control-expose-headers'), 'X-Falsify-Confluence-Session, Retry-After, X-Falsify-Paper-License');
  assert.equal(routed.calls.filter(call => call.host === 'api.openalex.org').length, 1);
  assert.equal(tracked.rateCalls[0].bucket.startsWith('paper-search:owner:'), true);
  assert.equal(tracked.rateCalls[0].bucket.includes(AUTHOR), false);
  assert.equal(tracked.rateCalls[0].bucket.includes(IP), false);
  assert.equal(tracked.rateCalls[1].bucket.startsWith('paper-search:ip:'), true);
  assert.equal(tracked.rateCalls[2].bucket, 'paper-search:all');

  const global = testDeps();
  const globalRoutes = routes({
    'api.openalex.org': () => jsonResponse(200, openAlexBody({ count: 1 })),
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
  });
  await send({
    pathname: '/v1/papers/search',
    query: 'q=one',
    token: SESSION,
    env: { PAPER_SEARCH_PER_HOUR: '1', PAPER_SEARCH_PER_OWNER_HOUR: '10' },
    deps: global.deps,
    fetchImpl: globalRoutes.fetchImpl,
  });
  const blocked = await send({
    pathname: '/v1/papers/search',
    query: 'q=two',
    token: SESSION,
    env: { PAPER_SEARCH_PER_HOUR: '1', PAPER_SEARCH_PER_OWNER_HOUR: '10' },
    deps: global.deps,
    fetchImpl: globalRoutes.fetchImpl,
  });
  assert.equal(blocked.status, 429);
  assert.equal(global.releases.length >= 2, true);
  assert.equal(global.releases.some(item => item.bucket.startsWith('paper-search:owner:')), true);
  assert.equal(global.releases.some(item => item.bucket.startsWith('paper-search:ip:')), true);
});

test('a guest uses guestMaxUploadBytes and a password owner keeps maxUploadBytes', async () => {
  const pdf = pdfBytes(80);
  const env = { AI_OPEN_ACCESS: 'true', AI_MAX_UPLOAD_BYTES: '1000', AI_GUEST_MAX_UPLOAD_BYTES: '50' };
  function pdfRoute() {
    return routes({
      'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
      'arxiv.org': () => new Response(pdf, { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
    });
  }
  const guestRoutes = pdfRoute();
  const guestDeps = testDeps({
    db: {
      prepare() {
        return { bind() { return this; }, async first() { return { guest_id: GUEST_ID }; } };
      },
    },
  });
  const guest = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00061',
    token: GUEST,
    env,
    deps: guestDeps.deps,
    fetchImpl: guestRoutes.fetchImpl,
  });
  assert.equal(guest.status, 413);
  assert.equal((await errorOf(guest)).code, 'payload_too_large');
  assertUpstreamIdentity(guestRoutes.calls);
  assert.equal(guestDeps.rateCalls.some(call => call.bucket.startsWith('paper-pdf:owner:')), true);
  assert.equal(guestDeps.rateCalls.some(call => call.bucket.startsWith('paper-pdf:ip:')), true);
  assert.equal(guestDeps.rateCalls.some(call => call.bucket === 'paper-search:all'), true);
  assert.equal(guestDeps.rateCalls.some(call => call.bucket.startsWith('paper-search:owner:')), false);
  assert.equal(guestDeps.rateCalls.some(call => call.bucket.includes(GUEST_ID)), false);

  const userRoutes = pdfRoute();
  const user = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00062',
    token: SESSION,
    env,
    deps: testDeps().deps,
    fetchImpl: userRoutes.fetchImpl,
  });
  assert.equal(user.status, 200);
  assert.equal((await user.arrayBuffer()).byteLength, 80);
});

test('an allowed PDF cache hit serves bytes with no upstream call, and a denied id stores none', async () => {
  clearPdfMemoForTests();
  const pdf = pdfBytes(80);
  let fetches = 0;
  const routed = routes({
    'oaipmh.arxiv.org': () => {
      fetches += 1;
      return new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    },
    'arxiv.org': () => {
      fetches += 1;
      return new Response(pdf, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    },
  });
  const cache = memoryCache();
  const deps = testDeps().deps;
  const first = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00071',
    token: SESSION,
    deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('x-falsify-paper-license'), 'cc-by-4.0');
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), pdf);
  assert.equal(fetches, 2);
  const second = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00071',
    token: SESSION,
    deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('cache-control'), 'no-store');
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), pdf);
  assert.equal(fetches, 2);

  const guestDeps = testDeps({
    db: {
      prepare() {
        return { bind() { return this; }, async first() { return { guest_id: GUEST_ID }; } };
      },
    },
  });
  const guest = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00071',
    token: GUEST,
    env: { AI_OPEN_ACCESS: 'true', AI_MAX_UPLOAD_BYTES: '1000', AI_GUEST_MAX_UPLOAD_BYTES: '50' },
    deps: guestDeps.deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(guest.status, 413);
  assert.equal((await errorOf(guest)).code, 'payload_too_large');
  assert.equal(fetches, 2);

  const deniedCache = memoryCache();
  const denied = routes({
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY_NC), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
    'arxiv.org': () => { throw new Error('denied id must not fetch pdf bytes'); },
  });
  const blocked = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00072',
    token: SESSION,
    deps: testDeps().deps,
    cache: deniedCache,
    fetchImpl: denied.fetchImpl,
  });
  assert.equal(blocked.status, 403);
  const again = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.00072',
    token: SESSION,
    deps: testDeps().deps,
    cache: deniedCache,
    fetchImpl: denied.fetchImpl,
  });
  assert.equal(again.status, 403);
  assert.equal(denied.calls.every(call => call.host === 'oaipmh.arxiv.org'), true);
  assert.equal(denied.calls.length, 1);
  const pdfEntries = deniedCache.entries().filter(([url, hit]) => url.includes('/papers/pdf') || String(hit.headers['content-type'] || '').includes('pdf'));
  assert.equal(pdfEntries.length, 0);
});

test('a warm isolate serves a repeated PDF from memory when no Cache API is available', async () => {
  clearPdfMemoForTests();
  let fetches = 0;
  const routed = routes({
    'oaipmh.arxiv.org': () => { fetches += 1; return new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }); },
    'arxiv.org': target => { fetches += 1; return new Response(pdfBytes(64 + target.pathname.length), { status: 200, headers: { 'Content-Type': 'application/pdf' } }); },
  });
  const deps = testDeps().deps;
  const get = id => send({ pathname: '/v1/papers/pdf', query: 'id=' + id, token: SESSION, deps, cache: null, fetchImpl: routed.fetchImpl });
  const first = await get('2503.00081');
  assert.equal(first.status, 200);
  const firstBytes = new Uint8Array(await first.arrayBuffer());
  assert.equal(fetches, 2);
  const second = await get('2503.00081');
  assert.equal(second.status, 200);
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), firstBytes);
  assert.equal(second.headers.get('x-falsify-paper-license'), 'cc-by-4.0');
  assert.match(second.headers.get('access-control-expose-headers'), /(^|,\s*)X-Falsify-Paper-License(\s*,|$)/);
  assert.match(second.headers.get('access-control-expose-headers'), /Retry-After/);
  assert.equal(fetches, 2, 'no OAI or arXiv call for a warm repeat');
  // Twelve entries at most: thirteen more ids push the first one out.
  for (let i = 0; i < 13; i++) assert.equal((await get('2503.001' + String(i).padStart(2, '0'))).status, 200);
  const before = fetches;
  assert.equal((await get('2503.00081')).status, 200);
  assert.equal(fetches, before + 2, 'the evicted id is fetched again');
  // An hour later the memo entry is gone, so the license is checked upstream again.
  agePdfMemoForTests(60 * 60 * 1000);
  const aged = fetches;
  assert.equal((await get('2503.00081')).status, 200);
  assert.equal(fetches, aged + 2, 'an expired entry re-checks the license and refetches');
  // A denied license is never memoised.
  clearPdfMemoForTests();
  let deniedFetches = 0;
  const denied = routes({
    'oaipmh.arxiv.org': () => { deniedFetches += 1; return new Response(oaiXml('http://arxiv.org/licenses/nonexclusive-distrib/1.0/'), { status: 200, headers: { 'Content-Type': 'text/xml' } }); },
    'arxiv.org': () => { deniedFetches += 1; return new Response(pdfBytes(80), { status: 200, headers: { 'Content-Type': 'application/pdf' } }); },
  });
  const getDenied = () => send({ pathname: '/v1/papers/pdf', query: 'id=2503.00099', token: SESSION, deps, cache: null, fetchImpl: denied.fetchImpl });
  assert.equal((await getDenied()).status, 403);
  assert.equal((await getDenied()).status, 403);
  assert.equal(deniedFetches, 2, 'each denied open asks OAI again and never fetches the PDF');
  clearPdfMemoForTests();
});

test('both upstreams failing is 503 and is not cached', async () => {
  let calls = 0;
  const routed = routes({
    'api.openalex.org': () => { calls += 1; return new Response('down', { status: 503 }); },
    'export.arxiv.org': () => new Response('down', { status: 503 }),
  });
  const cache = memoryCache();
  const deps = testDeps().deps;
  const first = await send({
    pathname: '/v1/papers/search',
    query: 'q=synthetic',
    token: SESSION,
    deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(first.status, 503);
  assert.equal((await errorOf(first)).retryable, true);
  const second = await send({
    pathname: '/v1/papers/search',
    query: 'q=synthetic',
    token: SESSION,
    deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(second.status, 503);
  assert.equal(calls, 2);
  assert.equal(cache.size, 0);
});

test('strict canonical CC URI parsing rejects spoofed hosts, bad versions, bare tokens, and conflicting tags', async () => {
  const rejectedUris = [
    'https://evil.example/creativecommons.org/publicdomain/zero/1.0/',
    'https://creativecommons.org.evil.example/licenses/by/4.0/',
    'http://not-cc.example/licenses/by/4.0/',
    'http://creativecommons.org/licenses/by/',
    'http://creativecommons.org/licenses/by/9.9/',
    'http://creativecommons.org/publicdomain/zero/2.0/',
    'http://creativecommons.org/licenses/by/4.0/deed.en',
    'http://creativecommons.org/licenses/by/4.0/?extra=1',
    'http://creativecommons.org/licenses/by/4.0/#frag',
    'http://creativecommons.org/publicdomain/mark/1.0/',
    'cc-by',
    'cc0',
  ];
  for (let i = 0; i < rejectedUris.length; i += 1) {
    const id = `2503.70${String(i).padStart(3, '0')}`;
    const routed = routes({
      'oaipmh.arxiv.org': () => new Response(oaiXml(rejectedUris[i]), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
      'arxiv.org': () => { throw new Error(`must not fetch PDF for ${rejectedUris[i]}`); },
    });
    const res = await send({ pathname: '/v1/papers/pdf', query: `id=${id}`, token: SESSION, deps: testDeps().deps, fetchImpl: routed.fetchImpl });
    assert.equal(res.status, 403, rejectedUris[i]);
  }

  // Conflicting multiple <license> tags (version mismatch or mixed allow+deny) must fail closed.
  for (const xml of [
    `<?xml version="1.0"?><OAI-PMH><GetRecord><record><metadata><arXiv><license>${CC_BY_3}</license><license>${CC_BY}</license></arXiv></metadata></record></GetRecord></OAI-PMH>`,
    `<?xml version="1.0"?><OAI-PMH><GetRecord><record><metadata><arXiv><license>${CC_BY}</license><license>${CC_BY_NC}</license></arXiv></metadata></record></GetRecord></OAI-PMH>`,
  ]) {
    const routed = routes({
      'oaipmh.arxiv.org': () => new Response(xml, { status: 200, headers: { 'Content-Type': 'text/xml' } }),
      'arxiv.org': () => { throw new Error('must not fetch PDF on conflicting licenses'); },
    });
    const res = await send({ pathname: '/v1/papers/pdf', query: 'id=2503.70999', token: SESSION, deps: testDeps().deps, fetchImpl: routed.fetchImpl });
    assert.equal(res.status, 403);
  }

  // A cached license entry whose id and url versions disagree is ignored and re-fetched.
  const cache = memoryCache();
  await cache.put(
    new Request('https://cache.falsify.local/papers/license?id=2503.70888', { method: 'GET' }),
    new Response(JSON.stringify({ kind: 'allow', id: 'cc-by-4.0', url: 'https://creativecommons.org/licenses/by/3.0/' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  let oaiCalls = 0;
  const routed = routes({
    'api.openalex.org': () => jsonResponse(200, openAlexBody({
      count: 1,
      results: [openAlexWork({ title: 'Version Protected', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.70888' })],
    })),
    'oaipmh.arxiv.org': () => {
      oaiCalls += 1;
      return new Response(oaiXml(CC_BY_3), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    },
  });
  const res = await send({ pathname: '/v1/papers/search', query: 'q=version-mismatch-cache', token: SESSION, deps: testDeps().deps, cache, fetchImpl: routed.fetchImpl });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(oaiCalls, 1);
  assert.deepEqual(body.results[0].license, { id: 'cc-by-3.0', url: 'https://creativecommons.org/licenses/by/3.0/' });
});

test('OpenAlex mismatches against arXiv OAI-PMH are excluded and actual OAI versions are returned', async () => {
  const works = [
    openAlexWork({ title: 'Actual CC BY 3.0', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.10001' }),
    openAlexWork({ title: 'Duplicate version', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.10001v2' }),
    openAlexWork({ title: 'False public-domain', license: 'public-domain', pdf: 'https://arxiv.org/pdf/2503.10002' }),
    openAlexWork({ title: 'False cc-by actually nc-sa', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.10003' }),
    openAlexWork({ title: 'False cc-by-sa actually nonexclusive', license: 'cc-by-sa', pdf: 'https://arxiv.org/pdf/2503.10004' }),
    openAlexWork({ title: 'Actual CC0', license: 'public-domain', pdf: 'https://arxiv.org/pdf/2503.10005' }),
    openAlexWork({ title: 'Actual CC BY-SA 4.0', license: 'cc-by-sa', pdf: 'https://arxiv.org/pdf/2503.10006' }),
    openAlexWork({ title: 'Missing on OAI', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.10007' }),
    openAlexWork({ title: 'No license tag on OAI', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.10008' }),
  ];
  const oaiByPaper = {
    '2503.10001': oaiXml(CC_BY_3),
    '2503.10002': oaiXml(ARXIV_NONEXCLUSIVE),
    '2503.10003': oaiXml(CC_BY_NC_SA),
    '2503.10004': oaiXml(ARXIV_NONEXCLUSIVE),
    '2503.10005': oaiXml(CC0),
    '2503.10006': oaiXml(CC_BY_SA),
    '2503.10007': oaiMissing(),
    '2503.10008': oaiXml(''),
  };
  const checked = [];
  const routed = routes({
    'api.openalex.org': () => jsonResponse(200, openAlexBody({ count: works.length, results: works })),
    'oaipmh.arxiv.org': target => {
      const id = oaiId(target);
      checked.push(id);
      return new Response(oaiByPaper[id], { status: 200, headers: { 'Content-Type': 'text/xml' } });
    },
  });
  const response = await send({
    pathname: '/v1/papers/search',
    query: 'q=mismatch-check',
    token: SESSION,
    deps: testDeps().deps,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  const body = await response.json();
  assert.equal(body.hasMore, false);
  assert.deepEqual(
    body.results.map(item => ({ id: item.id, license: item.license, licenseVerified: item.licenseVerified })),
    [
      { id: '2503.10001', license: { id: 'cc-by-3.0', url: 'https://creativecommons.org/licenses/by/3.0/' }, licenseVerified: true },
      { id: '2503.10005', license: { id: 'cc0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' }, licenseVerified: true },
      { id: '2503.10006', license: { id: 'cc-by-sa-4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }, licenseVerified: true },
    ],
  );
  assert.equal(checked.filter(id => id === '2503.10001').length, 1, 'duplicate versioned id is checked once');
  assertUpstreamIdentity(routed.calls);
});

test('event search pre-probes PDFs via Range against min(booth maxPdfBytes, ownerCap), confirms indeterminate size via HEAD, canonicalizes old versions, and hides unresolved PDFs no-store', async () => {
  const works = [
    openAlexWork({ title: 'Within Cap', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.80001v1' }),
    openAlexWork({ title: 'Oversized 17 MiB', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.80002' }),
    openAlexWork({ title: 'Missing 404', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.80003' }),
    openAlexWork({ title: 'HTML not PDF', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.80004' }),
    openAlexWork({ title: 'Chunked Confirmed by HEAD', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.80005' }),
    openAlexWork({ title: 'Chunked Oversized by HEAD', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.80008' }),
    openAlexWork({ title: 'Denied OAI', license: 'public-domain', pdf: 'https://arxiv.org/pdf/2503.80006' }),
    openAlexWork({ title: 'Redirected to export', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.80007' }),
  ];
  const probedCalls = [];
  const routed = routes({
    'api.openalex.org': () => jsonResponse(200, openAlexBody({ count: works.length, results: works })),
    'oaipmh.arxiv.org': target => new Response(oaiXml(oaiId(target) === '2503.80006' ? ARXIV_NONEXCLUSIVE : CC_BY), {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    }),
    'arxiv.org': (target, init) => {
      const method = init.method || 'GET';
      probedCalls.push({ method, path: target.pathname });
      if (method === 'HEAD') {
        assert.equal(new Headers(init.headers).get('range'), null);
        if (target.pathname === '/pdf/2503.80005') {
          return new Response(null, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(3 * 1024 * 1024) } });
        }
        if (target.pathname === '/pdf/2503.80008') {
          return new Response(null, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(18 * 1024 * 1024) } });
        }
        return new Response(null, { status: 405 });
      }
      assert.equal(new Headers(init.headers).get('range'), 'bytes=0-4');
      if (target.pathname === '/pdf/2503.80001') return rangeOk(10 * 1024 * 1024);
      if (target.pathname === '/pdf/2503.80002') return rangeOk(17 * 1024 * 1024);
      if (target.pathname === '/pdf/2503.80003') return new Response('gone', { status: 404, headers: { 'Content-Type': 'text/html' } });
      if (target.pathname === '/pdf/2503.80004') return new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      if (target.pathname === '/pdf/2503.80005') return chunked(['%PDF-1.7\n'], { 'Content-Type': 'application/pdf' });
      if (target.pathname === '/pdf/2503.80008') return chunked(['%PDF-1.7\n'], { 'Content-Type': 'application/pdf' });
      if (target.pathname === '/pdf/2503.80007') return new Response(null, { status: 302, headers: { Location: 'https://export.arxiv.org/pdf/2503.80007' } });
      throw new Error(`unexpected arxiv.org probe ${target.pathname}`);
    },
    'export.arxiv.org': (target, init) => {
      assert.equal(new Headers(init.headers).get('range'), 'bytes=0-4');
      return rangeOk(2 * 1024 * 1024);
    },
  });
  const cache = memoryCache();
  const res = await send({
    pathname: '/v1/papers/search',
    query: 'q=event-probe',
    token: SESSION,
    env: { BOOTH_ENABLED: 'true', BOOTH_MAX_PDF_BYTES: String(BOOTH_CAP) },
    deps: testDeps().deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  const body = await res.json();
  assert.deepEqual(body.results.map(item => item.id), ['2503.80001', '2503.80005', '2503.80007']);
  assert.equal(body.results[0].landingUrl, 'https://arxiv.org/abs/2503.80001', 'obsolete v1 is canonicalized before probing and in output');
  assert.equal(probedCalls.some(c => c.path === '/pdf/2503.80001v1'), false, 'never probes obsolete v1 in search');
  assert.equal(probedCalls.some(c => c.path === '/pdf/2503.80006'), false, 'OAI-disallowed paper is never range-probed');
  assert.equal(probedCalls.some(c => c.method === 'HEAD' && c.path === '/pdf/2503.80005'), true);
  assert.equal(probedCalls.some(c => c.method === 'HEAD' && c.path === '/pdf/2503.80008'), true);
  assertUpstreamIdentity(routed.calls);

  // Guest with tighter 8 MiB upload cap uses min(16 MiB booth, 8 MiB guest) = 8 MiB, gets its own
  // search cache key, and reuses all cached PDF sizes (including HEAD-confirmed 2503.80005 & 2503.80008) with 0 probes.
  const guestDeps = testDeps({
    db: { prepare() { return { bind() { return this; }, async first() { return { guest_id: GUEST_ID }; } }; } },
  });
  probedCalls.length = 0;
  const guestRes = await send({
    pathname: '/v1/papers/search',
    query: 'q=event-probe',
    token: GUEST,
    env: { BOOTH_ENABLED: 'true', BOOTH_MAX_PDF_BYTES: String(BOOTH_CAP), AI_OPEN_ACCESS: 'true', AI_GUEST_MAX_UPLOAD_BYTES: String(8 * 1024 * 1024) },
    deps: guestDeps.deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(guestRes.status, 200);
  const guestBody = await guestRes.json();
  assert.deepEqual(guestBody.results.map(item => item.id), ['2503.80005', '2503.80007']);
  assert.equal(probedCalls.length, 0, 'all definitive Range and HEAD sizes are reused from cache');

  // Non-event deployment (BOOTH_ENABLED unset) skips PDF range probing and has its own cap=none search cache key.
  probedCalls.length = 0;
  const nonEvent = await send({
    pathname: '/v1/papers/search',
    query: 'q=event-probe',
    token: SESSION,
    env: { BOOTH_ENABLED: 'false' },
    deps: testDeps().deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(nonEvent.status, 200);
  assert.equal(probedCalls.length, 0);
  assert.equal((await nonEvent.json()).results.length, 7);

  // Unresolved size (chunked 200 + HEAD without Content-Length), 503, and gzip are hidden with no-store (uncached).
  const transientCache = memoryCache();
  let transientCalls = 0;
  const transientRoutes = routes({
    'api.openalex.org': () => {
      transientCalls += 1;
      return jsonResponse(200, openAlexBody({
        count: 4,
        results: [
          openAlexWork({ title: 'Good', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.81001' }),
          openAlexWork({ title: 'Probe 503', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.81002' }),
          openAlexWork({ title: 'Probe Gzip', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.81003' }),
          openAlexWork({ title: 'Unresolved Size After HEAD', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.81004' }),
        ],
      }));
    },
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
    'arxiv.org': (target, init) => {
      if ((init.method || 'GET') === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
      }
      if (target.pathname === '/pdf/2503.81001') return rangeOk(10000);
      if (target.pathname === '/pdf/2503.81002') return new Response('busy', { status: 503 });
      if (target.pathname === '/pdf/2503.81004') return chunked(['%PDF-1.7\n'], { 'Content-Type': 'application/pdf' });
      return new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00]), {
        status: 206,
        headers: { 'Content-Type': 'application/pdf', 'Content-Encoding': 'gzip', 'Content-Range': 'bytes 0-4/9000' },
      });
    },
  });
  const degraded = await send({
    pathname: '/v1/papers/search',
    query: 'q=transient-pdf',
    token: SESSION,
    env: { BOOTH_ENABLED: 'true', BOOTH_MAX_PDF_BYTES: String(BOOTH_CAP) },
    deps: testDeps().deps,
    cache: transientCache,
    fetchImpl: transientRoutes.fetchImpl,
  });
  assert.equal(degraded.status, 200);
  assert.equal(degraded.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await degraded.json()).results.map(item => item.id), ['2503.81001']);
  assert.equal(transientCache.entries().some(([url]) => url.includes('/papers/search')), false);
  assert.equal(transientCalls, 1);

  // Obsolete v1 in Atom metadata canonicalizes to latest unversioned id for search/probe, while direct PDF open keeps exact v1.
  const versionPaths = [];
  const versionRoutes = routes({
    'api.openalex.org': () => new Response('down', { status: 503 }),
    'export.arxiv.org': () => new Response(atomEntriesFeed([{ id: '2503.82001v1', title: 'Old Version In Feed' }], 1), {
      status: 200,
      headers: { 'Content-Type': 'application/atom+xml' },
    }),
    'oaipmh.arxiv.org': () => new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
    'arxiv.org': (target, init) => {
      versionPaths.push({ path: target.pathname, range: new Headers(init.headers).get('range') });
      if (new Headers(init.headers).get('range') === 'bytes=0-4') {
        return target.pathname === '/pdf/2503.82001' ? rangeOk(100000) : rangeOk(BOOTH_CAP + 1);
      }
      return new Response(pdfBytes(40), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
    },
  });
  const searched = await send({
    pathname: '/v1/papers/search',
    query: 'q=old-version',
    token: SESSION,
    env: { BOOTH_ENABLED: 'true', BOOTH_MAX_PDF_BYTES: String(BOOTH_CAP) },
    deps: testDeps().deps,
    fetchImpl: versionRoutes.fetchImpl,
  });
  const searchedBody = await searched.json();
  assert.deepEqual(searchedBody.results.map(item => ({ id: item.id, landingUrl: item.landingUrl })), [
    { id: '2503.82001', landingUrl: 'https://arxiv.org/abs/2503.82001' },
  ]);
  const directV1 = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.82001v1',
    token: SESSION,
    env: { BOOTH_ENABLED: 'true', BOOTH_MAX_PDF_BYTES: String(BOOTH_CAP) },
    deps: testDeps().deps,
    fetchImpl: versionRoutes.fetchImpl,
  });
  assert.equal(directV1.status, 200);
  assert.deepEqual(versionPaths, [
    { path: '/pdf/2503.82001', range: 'bytes=0-4' },
    { path: '/pdf/2503.82001v1', range: null },
  ]);
});

test('Atom fallback uses fixed 10-per-page direct offsets, bounded concurrency, and keeps hasMore on empty filtered pages', async () => {
  const page1Entries = Array.from({ length: 10 }, (_, i) => ({
    id: `2503.20${String(i).padStart(3, '0')}v1`,
    title: `Paper ${i}`,
  }));
  const oaiByPaper = {
    '2503.20000': oaiXml(ARXIV_NONEXCLUSIVE),
    '2503.20001': oaiXml(CC_BY_SA),
    '2503.20002': oaiXml(CC0),
    '2503.20003': oaiXml(CC_BY_NC_ND),
    '2503.20004': oaiXml(CC_BY_ND),
  };
  let inFlight = 0;
  let maxInFlight = 0;
  const atomParams = [];
  const routed = routes({
    'api.openalex.org': () => new Response('down', { status: 503 }),
    'export.arxiv.org': target => {
      const start = Number(target.searchParams.get('start'));
      const max = Number(target.searchParams.get('max_results'));
      atomParams.push({ start, max });
      if (start === 0) {
        return new Response(atomEntriesFeed(page1Entries, 25), { status: 200, headers: { 'Content-Type': 'application/atom+xml' } });
      }
      if (start === 10) {
        return new Response(atomEntriesFeed([{ id: '2503.29001v2', title: 'Denied Page 2' }], 25), {
          status: 200,
          headers: { 'Content-Type': 'application/atom+xml' },
        });
      }
      return new Response(atomEntriesFeed([{ id: '2503.29002v1', title: 'Page 3 Paper' }], 25), {
        status: 200,
        headers: { 'Content-Type': 'application/atom+xml' },
      });
    },
    'oaipmh.arxiv.org': async target => {
      const id = oaiId(target);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 4));
      inFlight -= 1;
      if (id === '2503.29001') return new Response(oaiXml(ARXIV_NONEXCLUSIVE), { status: 200, headers: { 'Content-Type': 'text/xml' } });
      return new Response(oaiByPaper[id] || oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    },
  });

  const first = await send({ pathname: '/v1/papers/search', query: 'q=atom-fixed&page=1', token: SESSION, deps: testDeps().deps, fetchImpl: routed.fetchImpl });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.page, 1);
  assert.equal(firstBody.hasMore, true);
  assert.deepEqual(firstBody.results.map(item => item.id), ['2503.20001', '2503.20002', '2503.20005', '2503.20006', '2503.20007', '2503.20008', '2503.20009']);
  assert.equal(firstBody.results[0].license.id, 'cc-by-sa-4.0');
  assert.equal(firstBody.results[1].license.id, 'cc0');
  assert.equal(maxInFlight <= 5, true, `bounded concurrency, saw ${maxInFlight}`);
  assert.deepEqual(atomParams[0], { start: 0, max: 10 });

  // Direct page 2 offset (start=10, max=10): all entries filtered out, empty results with hasMore=true.
  const second = await send({ pathname: '/v1/papers/search', query: 'q=atom-fixed&page=2', token: SESSION, deps: testDeps().deps, fetchImpl: routed.fetchImpl });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.deepEqual(secondBody, { source: 'arxiv', page: 2, hasMore: true, results: [] });
  assert.deepEqual(atomParams[1], { start: 10, max: 10 });

  // Direct page 3 offset (start=20, max=10): last page, hasMore=false.
  const third = await send({ pathname: '/v1/papers/search', query: 'q=atom-fixed&page=3', token: SESSION, deps: testDeps().deps, fetchImpl: routed.fetchImpl });
  assert.equal(third.status, 200);
  const thirdBody = await third.json();
  assert.equal(thirdBody.hasMore, false);
  assert.deepEqual(thirdBody.results.map(item => item.id), ['2503.29002']);
  assert.deepEqual(atomParams[2], { start: 20, max: 10 });
});

test('search populates the shared license cache for PDF opens and ignores stale unverified search cache entries', async () => {
  clearPdfMemoForTests();
  const pdf = pdfBytes(40);
  const oaiHits = [];
  const routed = routes({
    'api.openalex.org': () => jsonResponse(200, openAlexBody({
      count: 2,
      results: [
        openAlexWork({ title: 'Allowed Paper', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.30001' }),
        openAlexWork({ title: 'Denied Paper', license: 'public-domain', pdf: 'https://arxiv.org/pdf/2503.30002' }),
      ],
    })),
    'oaipmh.arxiv.org': target => {
      const id = oaiId(target);
      oaiHits.push(id);
      return new Response(id === '2503.30001' ? oaiXml(CC_BY) : oaiXml(ARXIV_NONEXCLUSIVE), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    },
    'arxiv.org': () => new Response(pdf, { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
  });
  const cache = memoryCache();
  const deps = testDeps().deps;
  await cache.put(
    new Request('https://cache.falsify.local/papers/search?v=4&q=shared-cache&page=1&cap=none', { method: 'GET' }),
    new Response(JSON.stringify({
      source: 'arxiv',
      page: 1,
      hasMore: false,
      results: [{ source: 'arxiv', id: '2503.30002', title: 'Stale', authors: [], year: 2024, abstract: '', license: null, licenseVerified: false, landingUrl: 'https://arxiv.org/abs/2503.30002' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  const searched = await send({
    pathname: '/v1/papers/search',
    query: 'q=shared-cache',
    token: SESSION,
    deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(searched.status, 200);
  const searchBody = await searched.json();
  assert.deepEqual(searchBody.results.map(item => item.id), ['2503.30001']);
  assert.deepEqual(oaiHits, ['2503.30001', '2503.30002']);

  const opened = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.30001',
    token: SESSION,
    deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get('x-falsify-paper-license'), 'cc-by-4.0');
  assert.equal(oaiHits.length, 2, 'PDF open reuses the search OAI allow verdict');

  const denied = await send({
    pathname: '/v1/papers/pdf',
    query: 'id=2503.30002',
    token: SESSION,
    deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(denied.status, 403);
  assert.equal(oaiHits.length, 2, 'PDF open reuses the search OAI deny verdict');
  clearPdfMemoForTests();
});

test('empty verified search results are cached without falling back to Atom', async () => {
  let atomCalls = 0;
  let openAlexCalls = 0;
  const cache = memoryCache();
  const routed = routes({
    'api.openalex.org': target => {
      openAlexCalls += 1;
      const q = target.searchParams.get('search');
      if (q === 'zero-hits') return jsonResponse(200, openAlexBody({ count: 0, results: [] }));
      return jsonResponse(200, openAlexBody({
        count: 1,
        results: [openAlexWork({ title: 'Denied Only', license: 'public-domain', pdf: 'https://arxiv.org/pdf/2503.40001' })],
      }));
    },
    'export.arxiv.org': () => { atomCalls += 1; return new Response(atomFeed(), { status: 200 }); },
    'oaipmh.arxiv.org': () => new Response(oaiXml(ARXIV_NONEXCLUSIVE), { status: 200, headers: { 'Content-Type': 'text/xml' } }),
  });
  const deps = testDeps().deps;
  const zero = await send({ pathname: '/v1/papers/search', query: 'q=zero-hits', token: SESSION, deps, cache, fetchImpl: routed.fetchImpl });
  assert.equal(zero.status, 200);
  assert.equal(zero.headers.get('cache-control'), 'public, max-age=3600');
  assert.deepEqual(await zero.json(), { source: 'arxiv', page: 1, hasMore: false, results: [] });
  assert.equal(atomCalls, 0);

  const zeroAgain = await send({ pathname: '/v1/papers/search', query: 'q=zero-hits', token: SESSION, deps, cache, fetchImpl: routed.fetchImpl });
  assert.equal(zeroAgain.status, 200);
  assert.equal(openAlexCalls, 1);

  const allDenied = await send({ pathname: '/v1/papers/search', query: 'q=all-denied', token: SESSION, deps, cache, fetchImpl: routed.fetchImpl });
  assert.equal(allDenied.status, 200);
  assert.equal(allDenied.headers.get('cache-control'), 'public, max-age=3600');
  assert.deepEqual(await allDenied.json(), { source: 'arxiv', page: 1, hasMore: false, results: [] });
  assert.equal(atomCalls, 0);
});

test('transient OAI failures exclude unverified papers, skip search cache, fail closed with 503 when none verify, and circuit-break failing waves', async () => {
  const partialCache = memoryCache();
  let partialOpenAlexCalls = 0;
  let flakyCalls = 0;
  const partialRoutes = routes({
    'api.openalex.org': () => {
      partialOpenAlexCalls += 1;
      return jsonResponse(200, openAlexBody({
        count: 2,
        results: [
          openAlexWork({ title: 'Good Paper', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.50001' }),
          openAlexWork({ title: 'Flaky Paper', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.50002' }),
        ],
      }));
    },
    'oaipmh.arxiv.org': target => {
      const id = oaiId(target);
      if (id === '2503.50001') return new Response(oaiXml(CC_BY), { status: 200, headers: { 'Content-Type': 'text/xml' } });
      flakyCalls += 1;
      return flakyCalls === 1
        ? new Response('busy', { status: 503 })
        : new Response(oaiXml(CC_BY_SA), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    },
  });
  const deps = testDeps().deps;
  const degraded = await send({
    pathname: '/v1/papers/search',
    query: 'q=partial-oai',
    token: SESSION,
    deps,
    cache: partialCache,
    fetchImpl: partialRoutes.fetchImpl,
  });
  assert.equal(degraded.status, 200);
  assert.equal(degraded.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await degraded.json()).results.map(item => item.id), ['2503.50001']);

  const recovered = await send({
    pathname: '/v1/papers/search',
    query: 'q=partial-oai',
    token: SESSION,
    deps,
    cache: partialCache,
    fetchImpl: partialRoutes.fetchImpl,
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers.get('cache-control'), 'public, max-age=3600');
  assert.deepEqual((await recovered.json()).results.map(item => item.id), ['2503.50001', '2503.50002']);
  assert.equal(partialOpenAlexCalls, 2, 'degraded page was not cached');

  const downCache = memoryCache();
  let atomCalled = 0;
  const downRoutes = routes({
    'api.openalex.org': () => jsonResponse(200, openAlexBody({
      count: 2,
      results: [
        openAlexWork({ title: 'Denied', license: 'public-domain', pdf: 'https://arxiv.org/pdf/2503.50011' }),
        openAlexWork({ title: 'Transient', license: 'cc-by', pdf: 'https://arxiv.org/pdf/2503.50012' }),
      ],
    })),
    'export.arxiv.org': () => { atomCalled += 1; return new Response(atomFeed(), { status: 200 }); },
    'oaipmh.arxiv.org': target => (oaiId(target) === '2503.50011'
      ? new Response(oaiXml(ARXIV_NONEXCLUSIVE), { status: 200, headers: { 'Content-Type': 'text/xml' } })
      : new Response('oai down', { status: 503 })),
  });
  const unavailable = await send({
    pathname: '/v1/papers/search',
    query: 'q=oai-down',
    token: SESSION,
    deps: testDeps().deps,
    cache: downCache,
    fetchImpl: downRoutes.fetchImpl,
  });
  assert.equal(unavailable.status, 503);
  const err = await errorOf(unavailable);
  assert.equal(err.code, 'upstream_unavailable');
  assert.equal(err.retryable, true);
  assert.equal(atomCalled, 0);
  assert.equal(downCache.entries().some(([url]) => url.includes('/papers/search')), false);

  const entries = Array.from({ length: 15 }, (_, i) => ({ id: `2503.60${String(i).padStart(3, '0')}v1` }));
  let waveOaiCalls = 0;
  const breakerRoutes = routes({
    'api.openalex.org': () => new Response('down', { status: 503 }),
    'export.arxiv.org': () => new Response(atomEntriesFeed(entries, 50), { status: 200, headers: { 'Content-Type': 'application/atom+xml' } }),
    'oaipmh.arxiv.org': () => {
      waveOaiCalls += 1;
      return new Response('oai overloaded', { status: 503 });
    },
  });
  const broken = await send({
    pathname: '/v1/papers/search',
    query: 'q=oai-breaker',
    token: SESSION,
    deps: testDeps().deps,
    fetchImpl: breakerRoutes.fetchImpl,
  });
  assert.equal(broken.status, 503);
  assert.equal((await errorOf(broken)).code, 'upstream_unavailable');
  assert.equal(waveOaiCalls, 5, 'stops after the first completely failing OAI wave');
  const warm = memoryCache();
  await warm.put(new Request('https://cache.falsify.local/papers/license?id=2503.60008'),
    Response.json({ kind: 'allow', id: 'cc-by-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' }));
  const cachedPaper = await send({
    pathname: '/v1/papers/search', query: 'q=oai-breaker', token: SESSION,
    deps: testDeps().deps, cache: warm, fetchImpl: breakerRoutes.fetchImpl,
  });
  assert.equal(cachedPaper.status, 200);
  assert.deepEqual((await cachedPaper.json()).results.map(paper => paper.id), ['2503.60008']);
  assert.equal(waveOaiCalls, 10, 'later cached papers need no additional network request');
});
