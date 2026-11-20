// Offline paper-search tests. Fixtures are synthetic. Nothing in this file is a copied abstract,
// and fetchImpl never leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPaperSearch, handlePaperSearchRequest, clearPdfMemoForTests } from '../src/paper-search.mjs';

const USER_AGENT = 'falsify-workbench-booth/1.0 (+https://github.com/Shinick-Han/falsify-workbench)';
const AUTHOR = '11111111-1111-4111-8111-111111111111';
const GUEST_ID = '22222222-2222-4222-8222-222222222222';
const SESSION = `fss_${'b'.repeat(43)}`;
const GUEST = `fsg_${'a'.repeat(43)}`;
const SESSION_KEY = Buffer.alloc(32, 7).toString('base64');
const IP = '203.0.113.10';

const CC_BY = 'http://creativecommons.org/licenses/by/4.0/';
const CC_BY_SA = 'http://creativecommons.org/licenses/by-sa/4.0/';
const CC0 = 'http://creativecommons.org/publicdomain/zero/1.0/';
const CC_BY_NC = 'http://creativecommons.org/licenses/by-nc/4.0/';
const ARXIV_NONEXCLUSIVE = 'http://arxiv.org/licenses/nonexclusive-distrib/1.0/';

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

function atomFeed({ id = '2503.10497v1', title = 'Cats &amp; dogs', summary = 'Synthetic booth summary.', total = 12, authors = ['Ada Example'] } = {}) {
  const authorXml = authors.map(name => `<author><name>${name}</name></author>`).join('');
  return `<?xml version="1.0"?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults>${total}</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/${id}</id>
    <title>${title}</title>
    <summary>${summary}</summary>
    <published>2024-01-02T00:00:00Z</published>
    ${authorXml}
  </entry>
</feed>`;
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

test('OpenAlex happy path maps a synthetic work and keeps the fixed upstream policy', async () => {
  const names = ['Ada Example', 'Bo Example', 'Cy Example', 'Di Example', 'Ed Example', 'Fa Example', 'Gu Example', 'Ho Example'];
  const routed = routes({
    'api.openalex.org': () => jsonResponse(200, openAlexBody({ authors: names, license: 'cc-by' })),
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
    license: { id: 'cc-by', url: 'https://creativecommons.org/licenses/by/4.0/' },
    licenseVerified: true,
    landingUrl: 'https://arxiv.org/abs/2503.10497',
  });
  assert.equal(routed.calls.length, 1);
  const upstream = new URL(routed.calls[0].href);
  assert.equal(upstream.searchParams.get('filter'), 'best_oa_location.source.id:S4306400194,best_oa_location.license:cc-by|cc-by-sa|public-domain');
  assert.equal(upstream.searchParams.get('per_page'), '10');
  assert.equal(upstream.searchParams.get('search'), 'graph nets');
  assert.equal(upstream.searchParams.has('api_key'), false);
  assert.equal(upstream.searchParams.has('mailto'), false);
  assert.equal(routed.calls[0].href.includes('booth-example-key'), false);
  assert.equal(new Headers(routed.calls[0].init.headers).get('authorization'), 'Bearer booth-example-key');
  assert.equal(JSON.stringify(body).includes('booth-example-key'), false);
  assertUpstreamIdentity(routed.calls);
});

test('OpenAlex failure falls back to the arXiv Atom API with licenseVerified false', async () => {
  const summary = `${'A'.repeat(701)}`;
  const routed = routes({
    'api.openalex.org': () => new Response('down', { status: 503 }),
    'export.arxiv.org': () => new Response(atomFeed({ summary, total: 12 }), {
      status: 200,
      headers: { 'Content-Type': 'application/atom+xml' },
    }),
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
  assert.equal(body.results[0].license, null);
  assert.equal(body.results[0].licenseVerified, false);
  assert.equal(body.results[0].id, '2503.10497v1');
  assert.equal(body.results[0].year, 2024);
  assert.equal(Array.from(body.results[0].abstract).length, 700);
  assert.equal(body.hasMore, true);
  assert.deepEqual(routed.calls.map(call => call.host), ['api.openalex.org', 'export.arxiv.org']);
  assert.equal(routed.calls[0].href.includes('booth-example-key'), false);
  assert.equal(new Headers(routed.calls[0].init.headers).get('authorization'), 'Bearer booth-example-key');
  assert.equal(routed.calls[1].href.includes('booth-example-key'), false);
  assert.equal(routed.calls[1].href.includes('api_key'), false);
  assert.equal(new Headers(routed.calls[1].init.headers).get('authorization'), null);
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
    fetchImpl: routes({ 'api.openalex.org': () => jsonResponse(200, openAlexBody({ count: 1 })) }).fetchImpl,
  });
  assert.equal(wide.status, 200);
});

test('a search cache hit does not call upstream again', async () => {
  let fetched = 0;
  const routed = routes({
    'api.openalex.org': () => {
      fetched += 1;
      return jsonResponse(200, openAlexBody());
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
  assert.equal(fetched, 1);
  const otherPage = await send({
    pathname: '/v1/papers/search',
    query: 'q=Hello%20World&page=2',
    token: SESSION,
    deps,
    cache,
    fetchImpl: routed.fetchImpl,
  });
  assert.equal(otherPage.status, 200);
  assert.equal(fetched, 2);
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
  assert.equal(second.headers.get('access-control-expose-headers'), 'X-Falsify-Confluence-Session, Retry-After');
  assert.equal(routed.calls.length, 1);
  assert.equal(tracked.rateCalls[0].bucket.startsWith('paper-search:owner:'), true);
  assert.equal(tracked.rateCalls[0].bucket.includes(AUTHOR), false);
  assert.equal(tracked.rateCalls[0].bucket.includes(IP), false);
  assert.equal(tracked.rateCalls[1].bucket.startsWith('paper-search:ip:'), true);
  assert.equal(tracked.rateCalls[2].bucket, 'paper-search:all');

  const global = testDeps();
  const globalRoutes = routes({
    'api.openalex.org': () => jsonResponse(200, openAlexBody({ count: 1 })),
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
  assert.equal(fetches, 2, 'no OAI or arXiv call for a warm repeat');
  // Twelve entries at most: thirteen more ids push the first one out.
  for (let i = 0; i < 13; i++) assert.equal((await get('2503.001' + String(i).padStart(2, '0'))).status, 200);
  const before = fetches;
  assert.equal((await get('2503.00081')).status, 200);
  assert.equal(fetches, before + 2, 'the evicted id is fetched again');
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
