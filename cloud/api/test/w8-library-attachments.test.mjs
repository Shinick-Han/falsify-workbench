// Offline mocked Confluence tests for W8 library PDF attachments (GET /v1/w8/paper-attachments).
// No live network calls, no external writes, no credentials, no D1 required.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import worker from '../src/index.js';
import { handleConfluence, matchConfluence, SESSION_HEADER, MAX_ARCHIVE_BYTES } from '../src/confluence.mjs';
import { handleW8, matchW8 } from '../src/w8-team.mjs';
import { W8_DEFAULT_LIBRARY_PARENT_ID } from '../src/w8-paper-sync.mjs';
import { handleW8LibraryAttachments } from '../src/w8-library-attachments.mjs';

const CLOUD = '33333333-3333-3333-3333-333333333333';
const LEGACY_PARENT = '8355842';
const LIBRARY_ROOT = W8_DEFAULT_LIBRARY_PARENT_ID; // 20512769
const CUSTOM_ROOT = '44556677';
const CHILD_PAGE = '55667788';
const ORIGIN = 'https://shinick-han.github.io';
const SECRET = 'synthetic-library-att-secret';
const SITE = 'https://falsify.atlassian.net';
const MEDIA_UUID = '11111111-2222-3333-4444-555555555555';
const MEDIA_URL = `https://api.media.atlassian.com/file/${MEDIA_UUID}/binary?client=abc&token=sig`;
const T0 = 1_700_300_000_000;

const PDF_A = Buffer.from('%PDF-1.7\n1 0 obj << /Title (Paper A) >> endobj\n%%EOF\n');
const PDF_B = Buffer.from('%PDF-1.7\n1 0 obj << /Title (Paper B) >> endobj\n%%EOF\n');

const CONFLUENCE_SCOPES = [
  'offline_access',
  'read:space:confluence',
  'read:page:confluence',
  'read:content.metadata:confluence',
  'write:page:confluence',
  'read:attachment:confluence',
  'write:confluence-file',
  'readonly:content.attachment:confluence',
  'write:confluence-content',
  'read:confluence-user',
];

function baseEnv(overrides = {}) {
  return {
    ATLASSIAN_CLIENT_ID: 'falsify-test-client',
    ATLASSIAN_CLIENT_SECRET: SECRET,
    ATLASSIAN_CALLBACK_URL: 'https://worker.example/v1/confluence/auth/callback',
    CONFLUENCE_SESSION_KEY: Buffer.alloc(32, 9).toString('base64'),
    CONFLUENCE_PARENT_PAGE_ID: LEGACY_PARENT,
    ALLOWED_ORIGINS: ORIGIN,
    CONFLUENCE_ONLY: 'true',
    ...overrides,
  };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function postedFromCallback(html) {
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

function hasHeader(headers, name) {
  if (!headers) return false;
  const lower = name.toLowerCase();
  if (headers instanceof Headers) return headers.has(name);
  return Object.keys(headers).some(k => k.toLowerCase() === lower && headers[k] !== undefined);
}

function getHeader(headers, name) {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(name);
  const key = Object.keys(headers).find(k => k.toLowerCase() === lower);
  return key ? headers[key] : null;
}

function createMockConfluence(options = {}) {
  const calls = [];
  const rootId = options.rootId || LIBRARY_ROOT;
  const attachments = new Map();
  for (const att of options.attachments || []) {
    attachments.set(String(att.id), att);
  }
  const mediaFiles = new Map(Object.entries(options.mediaFiles || {}));

  function findAttachment(lookupId, allowNumericOnly = false) {
    if (attachments.has(lookupId)) return attachments.get(lookupId);
    if (allowNumericOnly && options.acceptNumericOnly && !lookupId.startsWith('att')) {
      return attachments.get(lookupId) || null;
    }
    return null;
  }

  function handleOAuth(u) {
    if (u.hostname === 'auth.atlassian.com' && u.pathname === '/oauth/token') {
      const n = calls.filter(c => c.path === '/oauth/token').length;
      return jsonResponse(200, {
        access_token: `access-${n}`,
        refresh_token: `refresh-${n}`,
        expires_in: options.tokenExpiresIn ?? 3600,
        scope: CONFLUENCE_SCOPES.join(' '),
      });
    }
    if (u.pathname === '/oauth/token/accessible-resources') {
      return jsonResponse(200, options.resources ?? [{ id: CLOUD, url: SITE, scopes: CONFLUENCE_SCOPES }]);
    }
    return null;
  }

  function handleMedia(u, init) {
    if (u.hostname !== 'api.media.atlassian.com') return null;
    if (typeof options.onMediaRequest === 'function') {
      const res = options.onMediaRequest(u, init);
      if (res) return res;
    }
    const entry = mediaFiles.get(u.toString()) || mediaFiles.get(u.pathname);
    if (!entry) return new Response('missing media', { status: 404 });
    if (entry.redirect) return new Response(null, { status: entry.status || 302, headers: { Location: entry.redirect } });
    return new Response(entry.bytes, {
      status: entry.status ?? 200,
      headers: { 'Content-Type': entry.contentType || 'application/pdf', ...(entry.headers || {}) },
    });
  }

  function handlePageMeta(wiki) {
    if (wiki === '/wiki/api/v2/spaces/65737') {
      if (options.spaceStatus) return new Response('no', { status: options.spaceStatus });
      return jsonResponse(200, options.space ?? { id: '65737', key: 'Falsify' });
    }
    if (/^\/wiki\/api\/v2\/pages\/([0-9]+)\/ancestors$/.test(wiki)) {
      return jsonResponse(200, { results: options.ancestors ?? [] });
    }
    const resMatch = /^\/wiki\/api\/v2\/pages\/([0-9]+)\/restriction-state$/.exec(wiki);
    if (resMatch) {
      const state = options.restrictionById?.[resMatch[1]] || 'OPEN';
      return jsonResponse(200, { state });
    }
    const pageMatch = /^\/wiki\/api\/v2\/pages\/([0-9]+)$/.exec(wiki);
    if (pageMatch) {
      const id = pageMatch[1];
      if (options.pageStatusById?.[id]) return new Response('no', { status: options.pageStatusById[id] });
      const spaceId = options.pageSpaceById?.[id] || '65737';
      const page = { id, spaceId, status: 'current' };
      if (!options.omitRootWebui && id === rootId) {
        page._links = { webui: options.rootWebui || `/spaces/Falsify/pages/${id}/Paper+Library` };
      }
      return jsonResponse(200, page);
    }
    return null;
  }

  function handleAttachmentList(wiki, u) {
    const listMatch = /^\/wiki\/api\/v2\/pages\/([0-9]+)\/attachments$/.exec(wiki);
    if (!listMatch) return null;
    if (options.listStatus) {
      return new Response('err', { status: options.listStatus, headers: options.listHeaders || {} });
    }
    const cursor = u.searchParams.get('cursor') || '';
    if (options.listPages) {
      const page = options.listPages[cursor];
      if (!page) return jsonResponse(400, { message: 'bad cursor' });
      return jsonResponse(200, page);
    }
    const results = [...attachments.values()].filter(a => !a._excludeFromList);
    return jsonResponse(200, { results });
  }

  function handleAttachmentMeta(wiki) {
    const metaMatch = /^\/wiki\/api\/v2\/attachments\/([^/]+)$/.exec(wiki);
    if (!metaMatch) return null;
    const lookupId = decodeURIComponent(metaMatch[1]);
    if (options.metaStatusById?.[lookupId]) {
      return new Response('err', {
        status: options.metaStatusById[lookupId],
        headers: options.metaHeadersById?.[lookupId] || {},
      });
    }
    const att = findAttachment(lookupId, true);
    if (!att) return jsonResponse(404, { message: 'not found' });
    return jsonResponse(200, att.metaOverride || att);
  }

  function handleAttachmentDownload(wiki) {
    const dlMatch = /^\/wiki\/rest\/api\/content\/([0-9]+)\/child\/attachment\/([^/]+)\/download$/.exec(wiki);
    if (!dlMatch) return null;
    const [, pageId, attId] = dlMatch;
    if (options.downloadStatusById?.[attId]) {
      return new Response('err', {
        status: options.downloadStatusById[attId],
        headers: options.downloadHeadersById?.[attId] || {},
      });
    }
    const key = `${pageId}:${attId}`;
    if (options.downloadRedirectByKey?.[key]) {
      return new Response(null, { status: 302, headers: { Location: options.downloadRedirectByKey[key] } });
    }
    if (options.downloadDirectByKey?.[key]) {
      const entry = options.downloadDirectByKey[key];
      return new Response(entry.bytes, {
        status: entry.status ?? 200,
        headers: { 'Content-Type': entry.contentType || 'application/pdf' },
      });
    }
    return new Response('not found', { status: 404 });
  }

  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const u = new URL(url);
    calls.push({
      url: u.toString(),
      method,
      host: u.hostname,
      path: u.pathname,
      search: u.search,
      headers: init.headers,
      hasAuthorization: hasHeader(init.headers, 'authorization'),
      authorization: getHeader(init.headers, 'authorization'),
    });
    assert.equal(init.redirect, 'manual');
    assert.equal(u.protocol, 'https:');
    assert.equal(u.pathname.includes('/ex/jira/'), false, 'must never call Jira');
    if (u.pathname.includes('/ex/confluence/')) {
      assert.equal(method, 'GET', 'library attachments must never perform Confluence writes');
    }

    const oauth = handleOAuth(u);
    if (oauth) return oauth;
    const media = handleMedia(u, init);
    if (media) return media;
    if (u.pathname.includes('/ex/confluence/')) {
      const wiki = u.pathname.slice(u.pathname.indexOf('/wiki/'));
      return (
        handlePageMeta(wiki) ||
        handleAttachmentList(wiki, u) ||
        handleAttachmentMeta(wiki) ||
        handleAttachmentDownload(wiki) ||
        new Response('unmocked confluence', { status: 404 })
      );
    }
    throw new Error(`unmocked ${method} ${u.toString()}`);
  };

  return { calls, fetchImpl };
}

async function mintSession(env, fetchImpl, now = T0) {
  const startReq = new Request('https://worker.example/v1/w8/paper-auth/start', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: 'nonce_library_attachments_01', returnOrigin: ORIGIN }),
  });
  const startRes = await handleW8({
    request: startReq,
    env,
    url: new URL(startReq.url),
    match: matchW8('/v1/w8/paper-auth/start'),
    settings: { origins: new Set([ORIGIN]) },
    fetchImpl,
    now: () => now,
  });
  assert.equal(startRes.status, 200);
  const { authorizeUrl } = await startRes.json();
  const state = new URL(authorizeUrl).searchParams.get('state');
  const cbUrl = `https://worker.example/v1/confluence/auth/callback?code=auth_code_12345&state=${encodeURIComponent(state)}`;
  const cbRes = await handleConfluence({
    request: new Request(cbUrl, { method: 'GET' }),
    env,
    url: new URL(cbUrl),
    match: matchConfluence('/v1/confluence/auth/callback'),
    settings: { origins: new Set([ORIGIN]) },
    fetchImpl,
    now: () => now,
  });
  assert.equal(cbRes.status, 200);
  const posted = postedFromCallback(await cbRes.text());
  assert.ok(posted?.message?.session, 'session minted');
  return posted.message.session;
}

async function callEndpoint(path, { method = 'GET', token, env, fetchImpl, now = T0 } = {}) {
  const headers = { Origin: ORIGIN };
  if (token) headers.Authorization = `Bearer ${token}`;
  const req = new Request(`https://worker.example${path}`, { method, headers });
  return handleW8({
    request: req,
    env,
    url: new URL(req.url),
    match: matchW8('/v1/w8/paper-attachments'),
    settings: { origins: new Set([ORIGIN]) },
    fetchImpl,
    now: () => now,
  });
}

describe('W8 library PDF attachments (/v1/w8/paper-attachments)', () => {
  test('requires valid Confluence bearer session and rejects legacy tokens and non-GET methods', async () => {
    const env = baseEnv();
    const mock = createMockConfluence();

    const noAuth = await callEndpoint('/v1/w8/paper-attachments', { env, fetchImpl: mock.fetchImpl });
    assert.equal(noAuth.status, 401);
    assert.equal((await noAuth.json()).error.code, 'unauthorized');

    const legacy = await callEndpoint('/v1/w8/paper-attachments', {
      env,
      token: 'fss_' + 'a'.repeat(43),
      fetchImpl: mock.fetchImpl,
    });
    assert.equal(legacy.status, 401);

    const badToken = await callEndpoint('/v1/w8/paper-attachments?attachmentId=att101', {
      env,
      token: 'not-a-valid-sealed-session',
      fetchImpl: mock.fetchImpl,
    });
    assert.equal(badToken.status, 401);

    const postRes = await callEndpoint('/v1/w8/paper-attachments', {
      method: 'POST',
      env,
      fetchImpl: mock.fetchImpl,
    });
    assert.equal(postRes.status, 405);

    await assert.rejects(
      handleW8LibraryAttachments({ env, url: new URL('https://worker.example/v1/w8/paper-attachments'), fetchImpl: mock.fetchImpl }, null),
      err => err.status === 401 && err.code === 'unauthorized',
    );
    assert.equal(mock.calls.length, 0);
  });

  test('lists only current PDFs attached directly to configured library root and omits public links', async () => {
    const env = baseEnv({ W8_CONFLUENCE_LIBRARY_PARENT_ID: CUSTOM_ROOT });
    const mock = createMockConfluence({
      rootId: CUSTOM_ROOT,
      attachments: [
        {
          id: 'att101',
          pageId: CUSTOM_ROOT,
          status: 'current',
          title: 'Attention Is All You Need.pdf',
          mediaType: 'application/pdf',
          downloadLink: '/download/attachments/public-should-never-leak.pdf',
          _links: { download: '/secret-link' },
        },
        {
          id: 'att102',
          pageId: CUSTOM_ROOT,
          status: 'current',
          title: 'state.json',
          mediaType: 'application/json',
        },
        {
          id: 'att103',
          pageId: CUSTOM_ROOT,
          status: 'current',
          title: 'disguised.pdf',
          mediaType: 'text/html',
        },
        {
          id: 'att104',
          pageId: CUSTOM_ROOT,
          status: 'trashed',
          title: 'old.pdf',
          mediaType: 'application/pdf',
        },
        {
          id: 'att105',
          pageId: CHILD_PAGE,
          status: 'current',
          title: 'child-page.pdf',
          mediaType: 'application/pdf',
        },
        {
          id: 'att106',
          blogPostId: '99999',
          status: 'current',
          title: 'blog.pdf',
          mediaType: 'application/pdf',
        },
        {
          id: '107',
          pageId: CUSTOM_ROOT,
          status: 'current',
          title: 'NumericId.pdf',
          mediaType: 'application/pdf; charset=binary',
        },
      ],
    });
    const session = await mintSession(env, mock.fetchImpl);
    mock.calls.length = 0;

    const res = await callEndpoint('/v1/w8/paper-attachments', { env, token: session, fetchImpl: mock.fetchImpl });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.equal(body.nextCursor, null);
    assert.deepEqual(body.items, [
      {
        attachmentId: 'att101',
        pageId: CUSTOM_ROOT,
        title: 'Attention Is All You Need.pdf',
        pageUrl: `${SITE}/wiki/spaces/Falsify/pages/${CUSTOM_ROOT}/Paper+Library`,
      },
      {
        attachmentId: '107',
        pageId: CUSTOM_ROOT,
        title: 'NumericId.pdf',
        pageUrl: `${SITE}/wiki/spaces/Falsify/pages/${CUSTOM_ROOT}/Paper+Library`,
      },
    ]);
    assert.equal(mock.calls.some(c => c.path.includes(`/pages/${CUSTOM_ROOT}/attachments`)), true);
    assert.equal(mock.calls.some(c => c.path.includes(LEGACY_PARENT)), false);
  });

  test('downloads PDF via authenticated redirect to api.media.atlassian.com without sending Bearer to media host', async () => {
    const env = baseEnv();
    const mock = createMockConfluence({
      rootId: LIBRARY_ROOT,
      attachments: [
        {
          id: 'att501',
          pageId: LIBRARY_ROOT,
          status: 'current',
          title: 'paper-a.pdf',
          mediaType: 'application/pdf',
          fileSize: PDF_A.byteLength,
        },
      ],
      downloadRedirectByKey: { [`${LIBRARY_ROOT}:att501`]: MEDIA_URL },
      mediaFiles: { [MEDIA_URL]: { bytes: PDF_A, contentType: 'application/pdf' } },
    });
    const session = await mintSession(env, mock.fetchImpl);
    mock.calls.length = 0;

    const res = await callEndpoint('/v1/w8/paper-attachments?attachmentId=att501', {
      env,
      token: session,
      fetchImpl: mock.fetchImpl,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/pdf');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('Content-Disposition'), 'inline; filename="paper.pdf"');
    assert.equal(res.headers.get('Content-Length'), String(PDF_A.byteLength));
    const got = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(got, PDF_A);

    const metaCall = mock.calls.find(c => c.path.endsWith('/wiki/api/v2/attachments/att501'));
    const restCall = mock.calls.find(c => c.path.endsWith(`/wiki/rest/api/content/${LIBRARY_ROOT}/child/attachment/att501/download`));
    const mediaCall = mock.calls.find(c => c.host === 'api.media.atlassian.com');
    assert.ok(metaCall && restCall && mediaCall);
    assert.ok(mock.calls.indexOf(metaCall) < mock.calls.indexOf(restCall), 'v2 metadata verified before download');
    assert.equal(restCall.hasAuthorization, true, 'Atlassian REST download carries bearer');
    assert.equal(mediaCall.hasAuthorization, false, 'media host must NEVER receive bearer token');
  });

  test('supports both Confluence v2 att-prefixed IDs and bare REST numeric IDs', async () => {
    const env = baseEnv();

    // Case 1: Caller passes bare numeric REST ID "501", Confluence v2 stores "att501"
    const mockV2 = createMockConfluence({
      rootId: LIBRARY_ROOT,
      attachments: [
        { id: 'att501', pageId: LIBRARY_ROOT, status: 'current', title: 'v2.pdf', mediaType: 'application/pdf', fileSize: PDF_A.byteLength },
      ],
      downloadRedirectByKey: { [`${LIBRARY_ROOT}:att501`]: MEDIA_URL },
      mediaFiles: { [MEDIA_URL]: { bytes: PDF_A } },
    });
    const session1 = await mintSession(env, mockV2.fetchImpl);
    mockV2.calls.length = 0;

    const res1 = await callEndpoint('/v1/w8/paper-attachments?attachmentId=501', {
      env,
      token: session1,
      fetchImpl: mockV2.fetchImpl,
    });
    assert.equal(res1.status, 200);
    assert.deepEqual(Buffer.from(await res1.arrayBuffer()), PDF_A);
    assert.equal(mockV2.calls.some(c => c.path.endsWith('/wiki/api/v2/attachments/att501')), true);

    // Case 2: Caller passes bare numeric ID "602", mock v2 indexes only numeric "602"
    const mockNum = createMockConfluence({
      rootId: LIBRARY_ROOT,
      attachments: [
        { id: '602', pageId: LIBRARY_ROOT, status: 'current', title: 'num.pdf', mediaType: 'application/pdf', fileSize: PDF_B.byteLength },
      ],
      downloadRedirectByKey: { [`${LIBRARY_ROOT}:602`]: MEDIA_URL },
      mediaFiles: { [MEDIA_URL]: { bytes: PDF_B } },
    });
    const session2 = await mintSession(env, mockNum.fetchImpl);
    mockNum.calls.length = 0;

    const res2 = await callEndpoint('/v1/w8/paper-attachments?attachmentId=602', {
      env,
      token: session2,
      fetchImpl: mockNum.fetchImpl,
    });
    assert.equal(res2.status, 200);
    assert.deepEqual(Buffer.from(await res2.arrayBuffer()), PDF_B);

    // Case 3: v2 returns "att703" while v1 REST download accepts numeric "703"
    const mockSplit = createMockConfluence({
      rootId: LIBRARY_ROOT,
      attachments: [
        { id: 'att703', pageId: LIBRARY_ROOT, status: 'current', title: 'split.pdf', mediaType: 'application/pdf', fileSize: PDF_B.byteLength },
      ],
      downloadRedirectByKey: { [`${LIBRARY_ROOT}:703`]: MEDIA_URL },
      mediaFiles: { [MEDIA_URL]: { bytes: PDF_B } },
    });
    const session3 = await mintSession(env, mockSplit.fetchImpl);
    mockSplit.calls.length = 0;

    const res3 = await callEndpoint('/v1/w8/paper-attachments?attachmentId=att703', {
      env,
      token: session3,
      fetchImpl: mockSplit.fetchImpl,
    });
    assert.equal(res3.status, 200);
    assert.deepEqual(Buffer.from(await res3.arrayBuffer()), PDF_B);
    assert.equal(mockSplit.calls.some(c => c.path.endsWith(`/child/attachment/703/download`)), true);
  });

  test('blocks download when v2 metadata container is not exactly library root or attachment is not a current PDF', async () => {
    const env = baseEnv();
    const mock = createMockConfluence({
      rootId: LIBRARY_ROOT,
      attachments: [
        { id: 'att801', pageId: CHILD_PAGE, status: 'current', title: 'child.pdf', mediaType: 'application/pdf' },
        { id: 'att802', blogPostId: '777', status: 'current', title: 'blog.pdf', mediaType: 'application/pdf' },
        { id: 'att803', status: 'current', title: 'no-container.pdf', mediaType: 'application/pdf' },
        { id: 'att804', pageId: LIBRARY_ROOT, status: 'current', title: 'state.json', mediaType: 'application/json' },
        { id: 'att805', pageId: LIBRARY_ROOT, status: 'trashed', title: 'deleted.pdf', mediaType: 'application/pdf' },
        { id: 'att806', pageId: LIBRARY_ROOT, customContentId: '123', status: 'current', title: 'custom.pdf', mediaType: 'application/pdf' },
      ],
    });
    const session = await mintSession(env, mock.fetchImpl);

    for (const id of ['att801', 'att802', 'att803', 'att804', 'att805', 'att806', 'att999']) {
      mock.calls.length = 0;
      const res = await callEndpoint(`/v1/w8/paper-attachments?attachmentId=${id}`, {
        env,
        token: session,
        fetchImpl: mock.fetchImpl,
      });
      assert.equal(res.status, 404, `expected 404 for ${id}`);
      assert.equal((await res.json()).error.code, 'not_found');
      assert.equal(mock.calls.some(c => c.path.includes('/download')), false, `must not download ${id}`);
    }
  });

  test('refuses non-allowlisted redirects, non-PDF bytes, and oversized PDFs', async () => {
    const env = baseEnv({ W8_PDF_LINK_MAX_BYTES: '1024' });
    const tooBig = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1200, 0x41)]);
    const mock = createMockConfluence({
      rootId: LIBRARY_ROOT,
      attachments: [
        { id: 'att901', pageId: LIBRARY_ROOT, status: 'current', title: 'evil-redir.pdf', mediaType: 'application/pdf', fileSize: 100 },
        { id: 'att902', pageId: LIBRARY_ROOT, status: 'current', title: 'not-pdf.pdf', mediaType: 'application/pdf', fileSize: 20 },
        { id: 'att903', pageId: LIBRARY_ROOT, status: 'current', title: 'meta-big.pdf', mediaType: 'application/pdf', fileSize: MAX_ARCHIVE_BYTES + 1 },
        { id: 'att904', pageId: LIBRARY_ROOT, status: 'current', title: 'stream-big.pdf', mediaType: 'application/pdf', fileSize: 100 },
      ],
      downloadRedirectByKey: {
        [`${LIBRARY_ROOT}:att901`]: 'https://evil.example/file/11111111-2222-3333-4444-555555555555/binary',
        [`${LIBRARY_ROOT}:att902`]: MEDIA_URL,
        [`${LIBRARY_ROOT}:att904`]: 'https://api.media.atlassian.com/file/22222222-2222-3333-4444-555555555555/binary',
      },
      mediaFiles: {
        [MEDIA_URL]: { bytes: Buffer.from('<html>not a pdf</html>'), contentType: 'application/pdf' },
        'https://api.media.atlassian.com/file/22222222-2222-3333-4444-555555555555/binary': { bytes: tooBig },
      },
    });
    const session = await mintSession(env, mock.fetchImpl);

    mock.calls.length = 0;
    const evilRes = await callEndpoint('/v1/w8/paper-attachments?attachmentId=att901', { env, token: session, fetchImpl: mock.fetchImpl });
    assert.equal(evilRes.status, 502);
    assert.equal((await evilRes.json()).error.code, 'redirect_refused');
    assert.equal(mock.calls.some(c => c.host === 'evil.example'), false);

    const badBytesRes = await callEndpoint('/v1/w8/paper-attachments?attachmentId=att902', { env, token: session, fetchImpl: mock.fetchImpl });
    assert.equal(badBytesRes.status, 502);
    assert.equal((await badBytesRes.json()).error.code, 'upstream_invalid');

    mock.calls.length = 0;
    const metaBigRes = await callEndpoint('/v1/w8/paper-attachments?attachmentId=att903', { env, token: session, fetchImpl: mock.fetchImpl });
    assert.equal(metaBigRes.status, 413);
    assert.equal((await metaBigRes.json()).error.code, 'payload_too_large');
    assert.equal(mock.calls.some(c => c.path.includes('/download')), false);

    const streamBigRes = await callEndpoint('/v1/w8/paper-attachments?attachmentId=att904', { env, token: session, fetchImpl: mock.fetchImpl });
    assert.equal(streamBigRes.status, 413);
    assert.equal((await streamBigRes.json()).error.code, 'payload_too_large');
  });

  test('supports cursor paging with sealed cursors and rejects invalid or cross-root cursors', async () => {
    const env = baseEnv();
    const mock = createMockConfluence({
      rootId: LIBRARY_ROOT,
      omitRootWebui: true,
      listPages: {
        '': {
          results: [{ id: 'att1', pageId: LIBRARY_ROOT, status: 'current', title: 'first.pdf', mediaType: 'application/pdf' }],
          _links: { next: `/wiki/api/v2/pages/${LIBRARY_ROOT}/attachments?limit=25&cursor=page2token==` },
        },
        'page2token==': {
          results: [{ id: 'att2', pageId: LIBRARY_ROOT, status: 'current', title: 'second.pdf', mediaType: 'application/pdf' }],
          _links: {},
        },
      },
    });
    const session = await mintSession(env, mock.fetchImpl);

    const page1Res = await callEndpoint('/v1/w8/paper-attachments', { env, token: session, fetchImpl: mock.fetchImpl });
    assert.equal(page1Res.status, 200);
    const page1 = await page1Res.json();
    assert.equal(page1.items.length, 1);
    assert.equal(page1.items[0].attachmentId, 'att1');
    assert.equal(page1.items[0].pageUrl, `${SITE}/wiki/spaces/Falsify/pages/${LIBRARY_ROOT}`);
    assert.ok(typeof page1.nextCursor === 'string' && page1.nextCursor.length > 20);
    assert.equal(page1.nextCursor.includes('='), false, 'sealed cursor must be unpadded base64url');
    assert.equal(page1.nextCursor.includes('page2token'), false, 'raw Confluence cursor must not leak');

    const page2Res = await callEndpoint(`/v1/w8/paper-attachments?cursor=${encodeURIComponent(page1.nextCursor)}`, {
      env,
      token: session,
      fetchImpl: mock.fetchImpl,
    });
    assert.equal(page2Res.status, 200);
    const page2 = await page2Res.json();
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0].attachmentId, 'att2');
    assert.equal(page2.nextCursor, null);

    // Raw cursor rejected
    const rawCur = await callEndpoint('/v1/w8/paper-attachments?cursor=page2token%3D%3D', { env, token: session, fetchImpl: mock.fetchImpl });
    assert.equal(rawCur.status, 400);
    assert.equal((await rawCur.json()).error.code, 'invalid_cursor');

    // Session replayed as cursor rejected
    const replay = await callEndpoint(`/v1/w8/paper-attachments?cursor=${encodeURIComponent(session)}`, { env, token: session, fetchImpl: mock.fetchImpl });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error.code, 'invalid_cursor');

    // Cursor bound to LIBRARY_ROOT rejected when root changes to CUSTOM_ROOT
    const otherEnv = baseEnv({ W8_CONFLUENCE_LIBRARY_PARENT_ID: CUSTOM_ROOT });
    const crossRoot = await callEndpoint(`/v1/w8/paper-attachments?cursor=${encodeURIComponent(page1.nextCursor)}`, {
      env: otherEnv,
      token: session,
      fetchImpl: mock.fetchImpl,
    });
    assert.equal(crossRoot.status, 400);
    assert.equal((await crossRoot.json()).error.code, 'invalid_cursor');
  });

  test('handles permission denials, rate limits, bad queries, unconfigured state, and token refresh', async () => {
    const env = baseEnv();
    const okMock = createMockConfluence({
      rootId: LIBRARY_ROOT,
      tokenExpiresIn: 120,
      attachments: [{ id: 'att55', pageId: LIBRARY_ROOT, status: 'current', title: 'ok.pdf', mediaType: 'application/pdf', fileSize: PDF_A.byteLength }],
      downloadRedirectByKey: { [`${LIBRARY_ROOT}:att55`]: MEDIA_URL },
      mediaFiles: { [MEDIA_URL]: { bytes: PDF_A } },
    });
    const session = await mintSession(env, okMock.fetchImpl, T0);

    // Invalid query parameters
    for (const badPath of [
      '/v1/w8/paper-attachments?unknown=1',
      '/v1/w8/paper-attachments?cursor=abc&attachmentId=att55',
      '/v1/w8/paper-attachments?attachmentId=../secret',
      '/v1/w8/paper-attachments?attachmentId=',
      '/v1/w8/paper-attachments?cursor=',
    ]) {
      const res = await callEndpoint(badPath, { env, token: session, fetchImpl: okMock.fetchImpl });
      assert.equal(res.status, 400, `expected 400 for ${badPath}`);
    }

    // Invalid configured library root -> 503 not_configured
    const badCfg = await callEndpoint('/v1/w8/paper-attachments', {
      env: baseEnv({ W8_CONFLUENCE_LIBRARY_PARENT_ID: 'not-numeric' }),
      token: session,
      fetchImpl: okMock.fetchImpl,
    });
    assert.equal(badCfg.status, 503);
    assert.equal((await badCfg.json()).error.code, 'not_configured');

    // VIEW_RESTRICTED root -> 403 parent_not_allowed
    const restrictedMock = createMockConfluence({
      rootId: LIBRARY_ROOT,
      restrictionById: { [LIBRARY_ROOT]: 'VIEW_RESTRICTED' },
    });
    const restrictedRes = await callEndpoint('/v1/w8/paper-attachments', { env, token: session, fetchImpl: restrictedMock.fetchImpl });
    assert.equal(restrictedRes.status, 403);
    assert.equal((await restrictedRes.json()).error.code, 'parent_not_allowed');

    // List 403 -> permission_denied
    const deniedListMock = createMockConfluence({ rootId: LIBRARY_ROOT, listStatus: 403 });
    const deniedListRes = await callEndpoint('/v1/w8/paper-attachments', { env, token: session, fetchImpl: deniedListMock.fetchImpl });
    assert.equal(deniedListRes.status, 403);
    assert.equal((await deniedListRes.json()).error.code, 'permission_denied');

    // Attachment metadata 403 -> permission_denied without downloading
    const deniedMetaMock = createMockConfluence({ rootId: LIBRARY_ROOT, metaStatusById: { att55: 403 } });
    const deniedMetaRes = await callEndpoint('/v1/w8/paper-attachments?attachmentId=att55', {
      env,
      token: session,
      fetchImpl: deniedMetaMock.fetchImpl,
    });
    assert.equal(deniedMetaRes.status, 403);
    assert.equal((await deniedMetaRes.json()).error.code, 'permission_denied');
    assert.equal(deniedMetaMock.calls.some(c => c.path.includes('/download')), false);

    // Rate limited -> 429 with sanitized Retry-After
    const rateMock = createMockConfluence({ rootId: LIBRARY_ROOT, listStatus: 429, listHeaders: { 'Retry-After': '30' } });
    const rateRes = await callEndpoint('/v1/w8/paper-attachments', { env, token: session, fetchImpl: rateMock.fetchImpl });
    assert.equal(rateRes.status, 429);
    assert.equal(rateRes.headers.get('Retry-After'), '30');

    // Near-expiry session rotates and returns X-Falsify-Confluence-Session on binary PDF response
    const rotatedRes = await callEndpoint('/v1/w8/paper-attachments?attachmentId=att55', {
      env,
      token: session,
      fetchImpl: okMock.fetchImpl,
      now: T0 + 90_000,
    });
    assert.equal(rotatedRes.status, 200);
    assert.equal(rotatedRes.headers.get('Content-Type'), 'application/pdf');
    assert.ok(rotatedRes.headers.get(SESSION_HEADER), 'refreshed session header present on binary response');
    assert.deepEqual(Buffer.from(await rotatedRes.arrayBuffer()), PDF_A);
  });

  test('worker fetch routes GET and OPTIONS /v1/w8/paper-attachments with strict CORS', async () => {
    const env = baseEnv();
    const preflight = await worker.fetch(
      new Request('https://worker.example/v1/w8/paper-attachments', {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN },
      }),
      env,
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);

    const evilOrigin = await worker.fetch(
      new Request('https://worker.example/v1/w8/paper-attachments', {
        method: 'GET',
        headers: { Origin: 'https://evil.example' },
      }),
      env,
    );
    assert.equal(evilOrigin.status, 403);
    assert.equal(evilOrigin.headers.get('Access-Control-Allow-Origin'), null);

    const unauth = await worker.fetch(
      new Request('https://worker.example/v1/w8/paper-attachments?attachmentId=att55', {
        method: 'GET',
        headers: { Origin: ORIGIN },
      }),
      env,
    );
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  });
});
