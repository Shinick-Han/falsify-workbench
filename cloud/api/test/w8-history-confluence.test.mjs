// Offline mocked Confluence tests for W8 Confluence history browser (handleConfluenceHistory).
// Covers real-shaped Falsify space 65737 pages (archive parent 8355842 experiments/harness/external-response,
// W8 BLUE archives, study rounds, source paper references beyond W8 root), storage & ADF extraction,
// historical PDF/text/file attachments, sealed cursor paging, per-page permissions, read-only OAuth scopes,
// bounded downloads via confluenceInternal.downloadAttachment, and no network writes / no search scope.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_ARCHIVE_BYTES, GatewayError, confluenceInternal } from '../src/confluence.mjs';
import { handleW8, matchW8 } from '../src/w8-team.mjs';
import {
  HISTORY_SOURCE,
  DEFAULT_ARCHIVE_PARENT_ID,
  DEFAULT_LIBRARY_PARENT_ID,
  handleConfluenceHistory,
  extractStorageContent,
  extractAdfContent,
  classifyAttachment,
} from '../src/w8-history-confluence.mjs';

const CLOUD = '44444444-4444-4444-4444-444444444444';
const OTHER_CLOUD = '55555555-5555-5555-5555-555555555555';
const SITE = 'https://falsify.atlassian.net';
const ARCHIVE_PARENT = DEFAULT_ARCHIVE_PARENT_ID; // 8355842
const LIBRARY_ROOT = DEFAULT_LIBRARY_PARENT_ID; // 20512769
const WORKSPACE_ROOT = '66042';
const MEDIA_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MEDIA_URL = `https://api.media.atlassian.com/file/${MEDIA_UUID}/binary?client=abc&token=sig`;

const HASH_EXP = '1'.repeat(64);
const HASH_HARNESS = '2'.repeat(64);
const HASH_EXT = '3'.repeat(64);
const HASH_W8 = '4'.repeat(64);

const PDF_HIST = Buffer.from('%PDF-1.7\n1 0 obj << /Title (Historical Source Paper) >> endobj\n%%EOF\n');
const READ_ONLY_SCOPES = [
  'offline_access',
  'read:space:confluence',
  'read:page:confluence',
  'read:attachment:confluence',
  'readonly:content.attachment:confluence',
];

function baseEnv(overrides = {}) {
  return {
    ATLASSIAN_CLIENT_ID: 'falsify-history-client',
    ATLASSIAN_CLIENT_SECRET: 'synthetic-history-secret',
    ATLASSIAN_CALLBACK_URL: 'https://worker.example/v1/confluence/auth/callback',
    CONFLUENCE_SESSION_KEY: Buffer.alloc(32, 11).toString('base64'),
    CONFLUENCE_PARENT_PAGE_ID: ARCHIVE_PARENT,
    ALLOWED_ORIGINS: 'https://shinick-han.github.io',
    ...overrides,
  };
}

function makeSession(overrides = {}) {
  return {
    accessToken: 'readonly-access-token',
    refreshToken: 'readonly-refresh-token',
    cloudId: CLOUD,
    siteUrl: SITE,
    scopes: READ_ONLY_SCOPES,
    ...overrides,
  };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function hasHeader(headers, name) {
  if (!headers) return false;
  const lower = name.toLowerCase();
  if (headers instanceof Headers) return headers.has(name);
  return Object.keys(headers).some(k => k.toLowerCase() === lower && headers[k] !== undefined);
}

function createMockConfluence(options = {}) {
  const calls = [];
  const pages = new Map();
  for (const p of options.pages || []) pages.set(String(p.id), p);
  const attachmentsByPage = new Map();
  const attachmentsById = new Map();
  for (const att of options.attachments || []) {
    attachmentsById.set(String(att.id), att);
    const pid = String(att.pageId || '');
    if (pid) {
      if (!attachmentsByPage.has(pid)) attachmentsByPage.set(pid, []);
      attachmentsByPage.get(pid).push(att);
    }
  }
  const mediaFiles = new Map(Object.entries(options.mediaFiles || {}));

  function handleSpaceAndPagesList(wiki, u) {
    if (wiki === '/wiki/api/v2/spaces/65737') {
      if (options.spaceStatus) return new Response('err', { status: options.spaceStatus });
      return jsonResponse(200, options.space ?? { id: '65737', key: 'Falsify' });
    }
    if (wiki === '/wiki/api/v2/pages') {
      assert.equal(u.searchParams.get('space-id'), '65737');
      if (options.listStatus) return new Response('err', { status: options.listStatus, headers: options.listHeaders || {} });
      const cursor = u.searchParams.get('cursor') || '';
      if (options.listPages) {
        const entry = options.listPages[cursor];
        if (!entry) return jsonResponse(400, { message: 'bad cursor' });
        return jsonResponse(200, entry);
      }
      const results = [...pages.values()].map(p => ({
        id: p.id,
        title: p.title,
        status: p.status ?? 'current',
        spaceId: p.spaceId ?? '65737',
        parentId: p.parentId,
        version: p.version ?? { createdAt: '2026-10-26T00:00:00.000Z' },
        _links: p._links,
      }));
      return jsonResponse(200, { results });
    }
    return null;
  }

  function handleSinglePage(wiki, u) {
    const match = /^\/wiki\/api\/v2\/pages\/([0-9]+)$/.exec(wiki);
    if (!match) return null;
    const id = match[1];
    if (options.pageStatusById?.[id]) return new Response('err', { status: options.pageStatusById[id] });
    const page = pages.get(id);
    if (!page) return jsonResponse(404, { message: 'not found' });
    const fmt = u.searchParams.get('body-format');
    const out = {
      id: page.id,
      title: page.title,
      status: page.status ?? 'current',
      spaceId: page.spaceId ?? '65737',
      parentId: page.parentId,
      version: page.version ?? { createdAt: '2026-10-26T00:00:00.000Z' },
      _links: page._links,
      labels: page.labels,
      properties: page.properties,
    };
    if (fmt === 'storage' && page.storage !== undefined) {
      out.body = { storage: { representation: 'storage', value: page.storage } };
    } else if (fmt === 'atlas_doc_format' && page.adf !== undefined) {
      out.body = { atlas_doc_format: { representation: 'atlas_doc_format', value: page.adf } };
    } else if (page.directAdf !== undefined) {
      out.body = { atlas_doc_format: { representation: 'atlas_doc_format', value: page.directAdf } };
    }
    return jsonResponse(200, out);
  }

  function handleAttachments(wiki, u) {
    const listMatch = /^\/wiki\/api\/v2\/pages\/([0-9]+)\/attachments$/.exec(wiki);
    if (listMatch) {
      const pid = listMatch[1];
      if (options.attListStatusByPage?.[pid]) return new Response('err', { status: options.attListStatusByPage[pid] });
      const cursor = u.searchParams.get('cursor') || '';
      if (options.attPagesByPage?.[pid]) {
        const entry = options.attPagesByPage[pid][cursor];
        if (!entry) return jsonResponse(400, { message: 'bad cursor' });
        return jsonResponse(200, entry);
      }
      return jsonResponse(200, { results: attachmentsByPage.get(pid) || [] });
    }
    const metaMatch = /^\/wiki\/api\/v2\/attachments\/([^/]+)$/.exec(wiki);
    if (metaMatch) {
      const id = decodeURIComponent(metaMatch[1]);
      if (options.metaStatusById?.[id]) return new Response('err', { status: options.metaStatusById[id] });
      const att = attachmentsById.get(id);
      if (!att) return jsonResponse(404, { message: 'not found' });
      return jsonResponse(200, att.metaOverride || att);
    }
    const dlMatch = /^\/wiki\/rest\/api\/content\/([0-9]+)\/child\/attachment\/([^/]+)\/download$/.exec(wiki);
    if (dlMatch) {
      const [, pid, attId] = dlMatch;
      const key = `${pid}:${attId}`;
      if (options.downloadStatusByKey?.[key]) {
        return new Response('err', {
          status: options.downloadStatusByKey[key],
          headers: options.downloadHeadersByKey?.[key] || {},
        });
      }
      if (options.downloadRedirectByKey?.[key]) {
        return new Response(null, { status: 302, headers: { Location: options.downloadRedirectByKey[key] } });
      }
      if (options.downloadDirectByKey?.[key]) {
        const entry = options.downloadDirectByKey[key];
        return new Response(entry.bytes, { status: entry.status ?? 200, headers: { 'Content-Type': entry.contentType || 'application/octet-stream' } });
      }
      return new Response('not found', { status: 404 });
    }
    return null;
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
      hasAuthorization: hasHeader(init.headers, 'authorization'),
    });
    assert.equal(method, 'GET', 'history handler must NEVER send write requests');
    assert.equal(init.redirect, 'manual', 'must never auto-follow redirects');
    assert.equal(u.protocol, 'https:');
    assert.equal(u.pathname.includes('/ex/jira/'), false, 'must never call Jira');
    assert.equal(u.pathname.includes('/search'), false, 'must never call Confluence search / CQL');

    if (u.pathname === '/oauth/token/accessible-resources') {
      return jsonResponse(200, options.resources ?? [{ id: CLOUD, url: SITE, scopes: READ_ONLY_SCOPES }]);
    }
    if (u.hostname === 'api.media.atlassian.com') {
      assert.equal(hasHeader(init.headers, 'authorization'), false, 'Bearer must NEVER be sent to media host');
      const entry = mediaFiles.get(u.toString()) || mediaFiles.get(u.pathname);
      if (!entry) return new Response('missing media', { status: 404 });
      return new Response(entry.bytes, { status: entry.status ?? 200, headers: { 'Content-Type': entry.contentType || 'application/octet-stream' } });
    }
    if (u.pathname.includes('/ex/confluence/')) {
      const wiki = u.pathname.slice(u.pathname.indexOf('/wiki/'));
      return (
        handleSpaceAndPagesList(wiki, u) ||
        handleSinglePage(wiki, u) ||
        handleAttachments(wiki, u) ||
        new Response('unmocked confluence', { status: 404 })
      );
    }
    throw new Error(`unmocked ${method} ${u.toString()}`);
  };

  return { calls, fetchImpl };
}

function callHistory(path, { method = 'GET', env = baseEnv(), session = makeSession(), fetchImpl } = {}) {
  const req = new Request(`https://worker.example${path}`, { method });
  return handleConfluenceHistory({ request: req, env, url: new URL(req.url), fetchImpl }, session);
}

describe('W8 Confluence history browser (handleConfluenceHistory)', () => {
  test('exports source identifier and rejects missing session, bad config, non-GET, and client-supplied domains', async () => {
    assert.equal(HISTORY_SOURCE, 'confluence');
    const mock = createMockConfluence();

    await assert.rejects(
      callHistory('/v1/w8/history/confluence', { session: null, fetchImpl: mock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 401 && err.code === 'unauthorized',
    );
    await assert.rejects(
      callHistory('/v1/w8/history/confluence', { method: 'POST', fetchImpl: mock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 405 && err.code === 'method_not_allowed',
    );
    await assert.rejects(
      callHistory('/v1/w8/history/confluence', {
        env: baseEnv({ CONFLUENCE_SITE_URL: 'https://evil.atlassian.net' }),
        fetchImpl: mock.fetchImpl,
      }),
      err => err instanceof GatewayError && err.status === 503 && err.code === 'not_configured',
    );
    await assert.rejects(
      callHistory('/v1/w8/history/confluence', {
        env: baseEnv({ CONFLUENCE_SESSION_KEY: '' }),
        fetchImpl: mock.fetchImpl,
      }),
      err => err instanceof GatewayError && err.status === 503 && err.code === 'not_configured',
    );

    for (const badPath of [
      '/v1/w8/history/confluence?domain=evil.atlassian.net',
      '/v1/w8/history/confluence?space=99999',
      '/v1/w8/history/confluence?id=abc',
      '/v1/w8/history/confluence?file=att123',
      '/v1/w8/history/confluence?attachmentCursor=abc',
      '/v1/w8/history/confluence?id=1001&cursor=abc',
      '/v1/w8/history/confluence?id=1001&file=att123&attachmentCursor=abc',
      '/v1/w8/history/confluence?id=1001&id=1002',
      '/v1/w8/history/confluence?id=1001&file=not-an-id',
    ]) {
      await assert.rejects(
        callHistory(badPath, { fetchImpl: mock.fetchImpl }),
        err => err instanceof GatewayError && err.status === 400 && err.code === 'invalid_request',
        `expected 400 for ${badPath}`,
      );
    }
    assert.equal(mock.calls.length, 0, 'invalid requests must fail before any upstream call');
  });

  test('lists real-shaped space 65737 pages (archives under 8355842, W8 blue, study rounds, source refs) with real titles and read-only scopes', async () => {
    const mock = createMockConfluence({
      pages: [
        {
          id: '9101',
          title: `Falsify experiment ${HASH_EXP}`,
          parentId: ARCHIVE_PARENT,
          version: { createdAt: '2026-10-20T09:00:00.000Z' },
          _links: { webui: '/spaces/Falsify/pages/9101/Falsify+experiment' },
          properties: {
            results: [{
              key: 'falsify-archive',
              value: { kind: 'experiment', id: 'exp-round-1', title: 'Clinical Trial v1.2 Audit', archiveSha256: HASH_EXP, ready: true },
            }],
          },
          storage: `<p>Falsify team archive (experiment). Title Clinical Trial v1.2 Audit. Id exp-round-1. SHA-256 ${HASH_EXP}.</p>`,
        },
        {
          id: '9102',
          title: `Falsify external-response ${HASH_EXT}`,
          parentId: ARCHIVE_PARENT,
          version: { createdAt: '2026-10-18T12:00:00.000Z' },
          _links: { webui: '/spaces/Falsify/pages/9102/External' },
          // Older archive: property omits title, real title is in storage summary HTML
          properties: {
            results: [{
              key: 'falsify-archive',
              value: { kind: 'external-response', id: 'ext-gpt-run-4', archiveSha256: HASH_EXT, ready: true },
            }],
          },
          storage: `<p>Falsify team archive (external-response). Title GPT-5.5 External Critique &amp; Table 2. Id ext-gpt-run-4. SHA-256 ${HASH_EXT}.</p>`,
        },
        {
          id: '9103',
          title: `Falsify harness ${HASH_HARNESS}`,
          parentId: ARCHIVE_PARENT,
          version: { createdAt: '2026-10-15T08:00:00.000Z' },
          _links: { webui: '/spaces/Falsify/pages/9103/Harness' },
          properties: {
            results: [{
              key: 'falsify-archive',
              value: { kind: 'harness', id: 'harness-clinical-v3', archiveSha256: HASH_HARNESS, ready: true },
            }],
          },
          storage: '',
        },
        {
          id: '9104',
          title: `Falsify w8-blue ${HASH_W8}`,
          parentId: ARCHIVE_PARENT,
          version: { createdAt: '2026-11-22T10:00:00.000Z' },
          _links: { webui: '/spaces/Falsify/pages/9104/W8Blue' },
          properties: {
            results: [{
              key: 'falsify-w8-archive',
              value: { kind: 'w8-blue', participant: 'Alice Kim', condition: 'C1', issueKey: 'FLS-18', ready: true },
            }],
          },
          storage: '<p>Falsify W8 BLUE team archive. Participant: Alice Kim. Condition: C1. Jira issue: FLS-18.</p>',
        },
        {
          id: '10420',
          title: 'Study Round 2 — Source Paper References',
          parentId: WORKSPACE_ROOT,
          version: { createdAt: '2026-09-12T15:30:00.000Z' },
          _links: { webui: '/spaces/Falsify/pages/10420/Study+Round+2' },
        },
        {
          id: '20512999',
          title: 'Attention Paper · aabbccdd11223344',
          parentId: LIBRARY_ROOT,
          version: { createdAt: '2026-11-23T06:00:00.000Z' },
          _links: { webui: '/spaces/Falsify/pages/20512999/Attention' },
          properties: {
            results: [{
              key: 'falsify-w8-paper-sync',
              value: { kind: 'w8-paper-sync', title: 'Attention Is All You Need', ready: true },
            }],
          },
          storage: '<h1>Attention Is All You Need</h1>',
        },
        {
          id: '9199',
          title: `Falsify experiment ${'9'.repeat(64)}`,
          parentId: ARCHIVE_PARENT,
          version: { createdAt: '2026-10-01T00:00:00.000Z' },
        },
      ],
      // Per-page permission denial on 9199 during enrichment: must be omitted, not crash list
      pageStatusById: { '9199': 403 },
    });

    const res = await callHistory('/v1/w8/history/confluence?cursor=', { fetchImpl: mock.fetchImpl });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.equal(body.nextCursor, null);
    assert.deepEqual(body.items, [
      {
        id: '9101',
        title: 'Clinical Trial v1.2 Audit',
        url: `${SITE}/wiki/spaces/Falsify/pages/9101/Falsify+experiment`,
        updatedAt: '2026-10-20T09:00:00.000Z',
        kind: 'experiment',
      },
      {
        id: '9102',
        title: 'GPT-5.5 External Critique & Table 2',
        url: `${SITE}/wiki/spaces/Falsify/pages/9102/External`,
        updatedAt: '2026-10-18T12:00:00.000Z',
        kind: 'external-response',
      },
      {
        id: '9103',
        title: 'harness · harness-clinical-v3',
        url: `${SITE}/wiki/spaces/Falsify/pages/9103/Harness`,
        updatedAt: '2026-10-15T08:00:00.000Z',
        kind: 'harness',
      },
      {
        id: '9104',
        title: 'W8 BLUE · Alice Kim (C1 · FLS-18)',
        url: `${SITE}/wiki/spaces/Falsify/pages/9104/W8Blue`,
        updatedAt: '2026-11-22T10:00:00.000Z',
        kind: 'w8-blue',
      },
      {
        id: '10420',
        title: 'Study Round 2 — Source Paper References',
        url: `${SITE}/wiki/spaces/Falsify/pages/10420/Study+Round+2`,
        updatedAt: '2026-09-12T15:30:00.000Z',
        kind: 'page',
      },
      {
        id: '20512999',
        title: 'Attention Is All You Need',
        url: `${SITE}/wiki/spaces/Falsify/pages/20512999/Attention`,
        updatedAt: '2026-11-23T06:00:00.000Z',
        kind: 'w8-paper-sync',
      },
    ]);
    // Regular page 10420 did not need extra enrichment call
    assert.equal(mock.calls.some(c => c.path.endsWith('/pages/10420')), false);
    assert.equal(mock.calls.every(c => c.method === 'GET'), true);
  });

  test('supports sealed cursor paging for list and rejects raw, evil-host, or cross-cloud cursors', async () => {
    const mock = createMockConfluence({
      listPages: {
        '': {
          results: [{
            id: '1001',
            title: 'Round 1 Notes',
            status: 'current',
            spaceId: '65737',
            parentId: WORKSPACE_ROOT,
            version: { createdAt: '2026-09-01T00:00:00.000Z' },
          }],
          _links: { next: '/wiki/api/v2/pages?space-id=65737&limit=25&cursor=raw_page2==' },
        },
        'raw_page2==': {
          results: [{
            id: '1002',
            title: 'Round 2 Notes',
            status: 'current',
            spaceId: '65737',
            parentId: WORKSPACE_ROOT,
            version: { createdAt: '2026-09-02T00:00:00.000Z' },
          }],
          _links: {},
        },
      },
    });

    const res1 = await callHistory('/v1/w8/history/confluence', { fetchImpl: mock.fetchImpl });
    assert.equal(res1.status, 200);
    const page1 = await res1.json();
    assert.equal(page1.items.length, 1);
    assert.equal(page1.items[0].id, '1001');
    assert.equal(page1.items[0].url, `${SITE}/wiki/spaces/Falsify/pages/1001`);
    assert.ok(typeof page1.nextCursor === 'string' && page1.nextCursor.length > 20);
    assert.equal(page1.nextCursor.includes('='), false);
    assert.equal(page1.nextCursor.includes('raw_page2'), false);

    const res2 = await callHistory(`/v1/w8/history/confluence?cursor=${encodeURIComponent(page1.nextCursor)}`, {
      fetchImpl: mock.fetchImpl,
    });
    assert.equal(res2.status, 200);
    const page2 = await res2.json();
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0].id, '1002');
    assert.equal(page2.nextCursor, null);

    // Raw cursor rejected
    await assert.rejects(
      callHistory('/v1/w8/history/confluence?cursor=raw_page2%3D%3D', { fetchImpl: mock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 400 && err.code === 'invalid_cursor',
    );

    // Cross-cloud cursor replay rejected
    const otherMock = createMockConfluence({
      resources: [{ id: OTHER_CLOUD, url: SITE, scopes: READ_ONLY_SCOPES }],
    });
    await assert.rejects(
      callHistory(`/v1/w8/history/confluence?cursor=${encodeURIComponent(page1.nextCursor)}`, {
        session: makeSession({ cloudId: OTHER_CLOUD }),
        fetchImpl: otherMock.fetchImpl,
      }),
      err => err instanceof GatewayError && err.status === 400 && err.code === 'invalid_cursor',
    );

    // Evil next link host rejected
    const evilMock = createMockConfluence({
      listPages: {
        '': {
          results: [],
          _links: { next: 'https://evil.example/wiki/api/v2/pages?cursor=steal' },
        },
      },
    });
    await assert.rejects(
      callHistory('/v1/w8/history/confluence', { fetchImpl: evilMock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 502 && err.code === 'upstream_invalid',
    );
  });

  test('reads page detail with storage plain text, safe material links, historical PDFs/text/files, and attachment cursor paging', async () => {
    const storage = [
      '<h2>Study Round 2 &amp; Source Papers</h2>',
      '<script>alert("xss")</script>',
      '<p>Primary paper: <a href="https://arxiv.org/abs/2401.12345">arXiv 2401.12345</a> and ',
      '<a href="/wiki/spaces/Falsify/pages/9101/Audit">Internal Audit</a>.</p>',
      '<p>Bad links ignored: <a href="javascript:alert(1)">js</a> ',
      '<a href="https://api.media.atlassian.com/file/11111111-2222-3333-4444-555555555555/binary?token=sec">media</a>.</p>',
      '<p>Bare DOI: https://doi.org/10.1000/falsify-test.</p>',
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[{"metric": 0.91}]]></ac:plain-text-body></ac:structured-macro>',
    ].join('');

    const mock = createMockConfluence({
      pages: [
        {
          id: '10420',
          title: 'Study Round 2 — Source Papers',
          parentId: WORKSPACE_ROOT,
          version: { createdAt: '2026-09-12T15:30:00.000Z' },
          _links: { webui: '/spaces/Falsify/pages/10420/Study+Round+2' },
          storage,
        },
      ],
      attPagesByPage: {
        '10420': {
          '': {
            results: [
              {
                id: 'att501',
                pageId: '10420',
                status: 'current',
                title: 'historical-clinical-2024.pdf',
                mediaType: 'application/pdf',
                _links: { download: '/download/attachments/10420/historical-clinical-2024.pdf?version=1&token=dropme' },
              },
              {
                id: 'att502',
                pageId: '10420',
                status: 'current',
                title: 'archive-snapshot.json',
                mediaType: 'application/json',
                _links: { webui: '/pages/viewpageattachments.action?pageId=10420' },
              },
              {
                id: 'att503',
                pageId: '10420',
                status: 'current',
                title: 'chart-figure.png',
                mediaType: 'image/png',
                downloadLink: '/download/attachments/10420/chart-figure.png',
              },
              {
                id: 'att504',
                pageId: '10420',
                status: 'trashed',
                title: 'deleted.pdf',
                mediaType: 'application/pdf',
              },
              {
                id: 'att505',
                pageId: '99999',
                status: 'current',
                title: 'other-page.pdf',
                mediaType: 'application/pdf',
              },
            ],
            _links: { next: `/ex/confluence/${CLOUD}/wiki/api/v2/pages/10420/attachments?limit=25&cursor=att_p2=` },
          },
          'att_p2=': {
            results: [
              {
                id: 'att506',
                pageId: '10420',
                status: 'current',
                title: 'round2-findings.csv',
                mediaType: 'text/csv',
              },
            ],
            _links: {},
          },
        },
      },
    });

    const res1 = await callHistory('/v1/w8/history/confluence?id=10420', { fetchImpl: mock.fetchImpl });
    assert.equal(res1.status, 200);
    const detail1 = await res1.json();
    assert.equal(detail1.id, '10420');
    assert.equal(detail1.title, 'Study Round 2 — Source Papers');
    assert.equal(detail1.url, `${SITE}/wiki/spaces/Falsify/pages/10420/Study+Round+2`);
    assert.equal(detail1.updatedAt, '2026-09-12T15:30:00.000Z');
    assert.equal(detail1.kind, 'page');
    assert.match(detail1.text, /Study Round 2 & Source Papers/);
    assert.match(detail1.text, /\{"metric": 0\.91\}/);
    assert.equal(detail1.text.includes('alert("xss")'), false);
    assert.deepEqual(detail1.links, [
      { title: 'arXiv 2401.12345', url: 'https://arxiv.org/abs/2401.12345' },
      { title: 'Internal Audit', url: `${SITE}/wiki/spaces/Falsify/pages/9101/Audit` },
      { title: 'https://doi.org/10.1000/falsify-test', url: 'https://doi.org/10.1000/falsify-test' },
    ]);
    assert.deepEqual(detail1.attachments, [
      {
        id: 'att501',
        title: 'historical-clinical-2024.pdf',
        type: 'pdf',
        url: `${SITE}/wiki/download/attachments/10420/historical-clinical-2024.pdf`,
      },
      {
        id: 'att502',
        title: 'archive-snapshot.json',
        type: 'text',
        url: `${SITE}/wiki/pages/viewpageattachments.action`,
      },
      {
        id: 'att503',
        title: 'chart-figure.png',
        type: 'file',
        url: `${SITE}/wiki/download/attachments/10420/chart-figure.png`,
      },
    ]);
    assert.ok(typeof detail1.nextAttachmentCursor === 'string' && !detail1.nextAttachmentCursor.includes('='));

    // Second page of attachments using attachmentCursor
    const res2 = await callHistory(
      `/v1/w8/history/confluence?id=10420&attachmentCursor=${encodeURIComponent(detail1.nextAttachmentCursor)}`,
      { fetchImpl: mock.fetchImpl },
    );
    assert.equal(res2.status, 200);
    const detail2 = await res2.json();
    assert.deepEqual(detail2.attachments, [
      {
        id: 'att506',
        title: 'round2-findings.csv',
        type: 'text',
        url: `${SITE}/wiki/pages/viewpageattachments.action?pageId=10420`,
      },
    ]);
    assert.equal(detail2.nextAttachmentCursor, null);

    // Attachment cursor bound to pageId=10420 must fail on another pageId=9101
    await assert.rejects(
      callHistory(`/v1/w8/history/confluence?id=9101&attachmentCursor=${encodeURIComponent(detail1.nextAttachmentCursor)}`, {
        fetchImpl: mock.fetchImpl,
      }),
      err => err instanceof GatewayError && err.status === 400 && err.code === 'invalid_cursor',
    );
  });

  test('falls back to ADF body format when storage body is absent and extracts ADF text + links', async () => {
    const adfDoc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'ADF Study Protocol' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Reference: ' },
            {
              type: 'text',
              text: 'OpenReview Thread',
              marks: [{ type: 'link', attrs: { href: 'https://openreview.net/forum?id=abc123' } }],
            },
            { type: 'hardBreak' },
            { type: 'status', attrs: { text: 'Verified' } },
          ],
        },
        {
          type: 'blockCard',
          attrs: { url: 'https://arxiv.org/abs/2501.00001', title: 'Synthetic Benchmark Paper' },
        },
      ],
    };

    const mock = createMockConfluence({
      pages: [
        {
          id: '10500',
          title: 'ADF Protocol Page',
          parentId: WORKSPACE_ROOT,
          storage: '',
          adf: JSON.stringify(adfDoc),
        },
      ],
    });

    const res = await callHistory('/v1/w8/history/confluence?id=10500', { fetchImpl: mock.fetchImpl });
    assert.equal(res.status, 200);
    const detail = await res.json();
    assert.match(detail.text, /ADF Study Protocol/);
    assert.match(detail.text, /Reference: OpenReview Thread/);
    assert.match(detail.text, /\[Verified\]/);
    assert.deepEqual(detail.links, [
      { title: 'OpenReview Thread', url: 'https://openreview.net/forum?id=abc123' },
      { title: 'Synthetic Benchmark Paper', url: 'https://arxiv.org/abs/2501.00001' },
    ]);
    assert.equal(mock.calls.some(c => c.search.includes('body-format=atlas_doc_format')), true);
  });

  test('delivers file mode: binary PDF via downloadAttachment redirect, inert JSON/text with truncation, and native link for remaining formats', async () => {
    const archiveJson = JSON.stringify({
      schema: 'falsify.confluence-archive.v1',
      kind: 'experiment',
      htmlSnippet: '<script>alert(1)</script>',
      note: 'A'.repeat(200),
    });

    const mock = createMockConfluence({
      pages: [
        {
          id: '10420',
          title: 'Study Round 2',
          parentId: WORKSPACE_ROOT,
          storage: '<p>Notes</p>',
        },
        {
          id: '10421',
          title: 'Other Page In Same Space',
          parentId: WORKSPACE_ROOT,
          storage: '<p>Other</p>',
        },
      ],
      attachments: [
        {
          id: 'att501',
          pageId: '10420',
          status: 'current',
          title: 'historical-paper.pdf',
          mediaType: 'application/pdf',
          fileSize: PDF_HIST.byteLength,
        },
        {
          id: 'att502',
          pageId: '10420',
          status: 'current',
          title: `${HASH_EXP}.json`,
          mediaType: 'application/json',
          fileSize: Buffer.byteLength(archiveJson),
        },
        {
          id: 'att503',
          pageId: '10420',
          status: 'current',
          title: 'diagram.png',
          mediaType: 'image/png',
          _links: { download: '/download/attachments/10420/diagram.png' },
        },
        {
          id: 'att504',
          pageId: '10420',
          status: 'current',
          title: 'report.html',
          mediaType: 'text/html',
          _links: { webui: '/pages/viewpageattachments.action?pageId=10420' },
        },
        {
          id: 'att505',
          pageId: '10421',
          status: 'current',
          title: 'belongs-to-other-page.pdf',
          mediaType: 'application/pdf',
          fileSize: PDF_HIST.byteLength,
        },
      ],
      downloadRedirectByKey: {
        '10420:att501': MEDIA_URL,
      },
      downloadDirectByKey: {
        '10420:att502': { bytes: Buffer.from(archiveJson, 'utf8'), contentType: 'application/json' },
      },
      mediaFiles: {
        [MEDIA_URL]: { bytes: PDF_HIST, contentType: 'application/pdf' },
      },
    });

    // 1. PDF -> binary application/pdf, Bearer dropped on redirect to api.media.atlassian.com
    const pdfRes = await callHistory('/v1/w8/history/confluence?id=10420&file=att501', { fetchImpl: mock.fetchImpl });
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get('Content-Type'), 'application/pdf');
    assert.equal(pdfRes.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(pdfRes.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(Buffer.from(await pdfRes.arrayBuffer()), PDF_HIST);

    const restCall = mock.calls.find(c => c.path.endsWith('/child/attachment/att501/download'));
    const mediaCall = mock.calls.find(c => c.host === 'api.media.atlassian.com');
    assert.equal(restCall?.hasAuthorization, true);
    assert.equal(mediaCall?.hasAuthorization, false);

    // 2. JSON archive -> inert text JSON { text, truncated } (full and truncated)
    const textRes = await callHistory('/v1/w8/history/confluence?id=10420&file=att502', { fetchImpl: mock.fetchImpl });
    assert.equal(textRes.status, 200);
    assert.match(textRes.headers.get('Content-Type'), /^application\/json/);
    const textBody = await textRes.json();
    assert.equal(textBody.text, archiveJson);
    assert.equal(textBody.truncated, false);

    const truncRes = await callHistory('/v1/w8/history/confluence?id=10420&file=att502', {
      env: baseEnv({ W8_HISTORY_MAX_TEXT_CHARS: '64' }),
      fetchImpl: mock.fetchImpl,
    });
    assert.equal(truncRes.status, 200);
    const truncBody = await truncRes.json();
    assert.equal(truncBody.text, archiveJson.slice(0, 64));
    assert.equal(truncBody.truncated, true);

    // 3. Remaining formats (PNG, HTML) -> native Confluence attachment link JSON, no download call
    mock.calls.length = 0;
    const pngRes = await callHistory('/v1/w8/history/confluence?id=10420&file=att503', { fetchImpl: mock.fetchImpl });
    assert.equal(pngRes.status, 200);
    assert.deepEqual(await pngRes.json(), {
      id: 'att503',
      title: 'diagram.png',
      type: 'file',
      url: `${SITE}/wiki/download/attachments/10420/diagram.png`,
    });
    assert.equal(mock.calls.some(c => c.path.includes('/download')), false);

    const htmlRes = await callHistory('/v1/w8/history/confluence?id=10420&file=att504', { fetchImpl: mock.fetchImpl });
    assert.equal(htmlRes.status, 200);
    assert.equal((await htmlRes.json()).type, 'file');

    // 4. Cross-page attachment theft blocked (att505 belongs to 10421, requested via id=10420)
    mock.calls.length = 0;
    await assert.rejects(
      callHistory('/v1/w8/history/confluence?id=10420&file=att505', { fetchImpl: mock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 404 && err.code === 'not_found',
    );
    assert.equal(mock.calls.some(c => c.path.includes('/download')), false);
  });

  test('enforces space confinement, per-page permissions, bounded sizes, PDF magic, and redirect allowlist', async () => {
    const mock = createMockConfluence({
      pages: [
        { id: '2001', title: 'Foreign Space Page', spaceId: '99999', storage: '<p>Secret</p>' },
        { id: '2002', title: 'Restricted Page', spaceId: '65737', storage: '<p>Restricted</p>' },
        { id: '2003', title: 'Valid Page', spaceId: '65737', storage: '<p>Ok</p>' },
      ],
      pageStatusById: { '2002': 403 },
      attachments: [
        { id: 'att701', pageId: '2003', status: 'current', title: 'evil-redirect.pdf', mediaType: 'application/pdf', fileSize: 100 },
        { id: 'att702', pageId: '2003', status: 'current', title: 'fake.pdf', mediaType: 'application/pdf', fileSize: 20 },
        { id: 'att703', pageId: '2003', status: 'current', title: 'huge.pdf', mediaType: 'application/pdf', fileSize: MAX_ARCHIVE_BYTES + 1 },
        { id: 'att704', pageId: '2003', status: 'current', title: 'binary.txt', mediaType: 'text/plain', fileSize: 10 },
      ],
      downloadRedirectByKey: {
        '2003:att701': 'https://evil.example/file/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/binary',
      },
      downloadDirectByKey: {
        '2003:att702': { bytes: Buffer.from('<html>not pdf</html>'), contentType: 'application/pdf' },
        '2003:att704': { bytes: Buffer.from([0x61, 0x00, 0x62]), contentType: 'text/plain' },
      },
    });

    // Foreign space page -> 404
    await assert.rejects(
      callHistory('/v1/w8/history/confluence?id=2001', { fetchImpl: mock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 404 && err.code === 'not_found',
    );
    // Restricted page -> 403 permission_denied
    await assert.rejects(
      callHistory('/v1/w8/history/confluence?id=2002', { fetchImpl: mock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 403 && err.code === 'permission_denied',
    );
    await assert.rejects(
      callHistory('/v1/w8/history/confluence?id=2002&file=att701', { fetchImpl: mock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 403 && err.code === 'permission_denied',
    );
    // Disallowed redirect -> 502 redirect_refused
    await assert.rejects(
      callHistory('/v1/w8/history/confluence?id=2003&file=att701', { fetchImpl: mock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 502 && err.code === 'redirect_refused',
    );
    assert.equal(mock.calls.some(c => c.host === 'evil.example'), false);
    // Non-PDF bytes -> 502 upstream_invalid
    await assert.rejects(
      callHistory('/v1/w8/history/confluence?id=2003&file=att702', { fetchImpl: mock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 502 && err.code === 'upstream_invalid',
    );
    // Oversized PDF metadata -> 413 payload_too_large without download
    mock.calls.length = 0;
    await assert.rejects(
      callHistory('/v1/w8/history/confluence?id=2003&file=att703', { fetchImpl: mock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 413 && err.code === 'payload_too_large',
    );
    assert.equal(mock.calls.some(c => c.path.includes('/download')), false);
    // NUL byte binary disguised as text/plain -> 502 upstream_invalid
    await assert.rejects(
      callHistory('/v1/w8/history/confluence?id=2003&file=att704', { fetchImpl: mock.fetchImpl }),
      err => err instanceof GatewayError && err.status === 502 && err.code === 'upstream_invalid',
    );

    // Wrong space key/id or inaccessible space -> 403 space_not_allowed
    const badSpace = createMockConfluence({ space: { id: '65737', key: 'WrongKey' } });
    await assert.rejects(
      callHistory('/v1/w8/history/confluence', { fetchImpl: badSpace.fetchImpl }),
      err => err instanceof GatewayError && err.status === 403 && err.code === 'space_not_allowed',
    );
  });

  test('pure helpers classify attachments and safely extract storage/ADF content', () => {
    assert.equal(classifyAttachment({ title: 'a.pdf', mediaType: 'application/pdf' }), 'pdf');
    assert.equal(classifyAttachment({ title: 'legacy.PDF', mediaType: 'application/octet-stream' }), 'pdf');
    assert.equal(classifyAttachment({ title: 'disguised.pdf', mediaType: 'text/html' }), 'file');
    assert.equal(classifyAttachment({ title: 'data.json', mediaType: 'application/json; charset=utf-8' }), 'text');
    assert.equal(classifyAttachment({ title: 'notes.md', mediaType: '' }), 'text');
    assert.equal(classifyAttachment({ title: 'vector.svg', mediaType: 'image/svg+xml' }), 'file');

    const storageRes = extractStorageContent('<p>See <ri:url ri:value="https://example.org/paper.pdf" /></p>');
    assert.deepEqual(storageRes.links, [{ title: 'https://example.org/paper.pdf', url: 'https://example.org/paper.pdf' }]);

    const adfBad = extractAdfContent('{not valid json');
    assert.deepEqual(adfBad, { text: '', links: [] });
  });

  test('integrates end-to-end through handleW8 (/v1/w8/history/confluence) with sealed OAuth bearer and multi-container Atlassian site', async () => {
    const env = baseEnv();
    const key = await confluenceInternal.aesKey(env);
    const now = 1_700_400_000_000;
    const sealed = await confluenceInternal.seal(key, confluenceInternal.SESSION_PURPOSE, {
      purpose: confluenceInternal.SESSION_PURPOSE,
      accessToken: 'w8-readonly-token',
      refreshToken: 'w8-readonly-refresh',
      accessExp: now + 3600_000,
      envelopeExp: now + 12 * 3600_000,
      rotations: 0,
      cloudId: CLOUD,
      siteUrl: SITE,
      scopes: READ_ONLY_SCOPES,
    });
    const mock = createMockConfluence({
      // Separate Confluence and Jira containers sharing the same Falsify cloudId
      resources: [
        { id: CLOUD, url: SITE, scopes: READ_ONLY_SCOPES },
        { id: CLOUD, url: SITE, scopes: ['read:jira-work'] },
      ],
      pages: [
        {
          id: '10888',
          title: 'Study Round 1 — Source Corpus',
          parentId: WORKSPACE_ROOT,
          version: { createdAt: '2026-08-15T10:00:00.000Z' },
          _links: { webui: '/spaces/Falsify/pages/10888/Round+1' },
          storage: '<p>Corpus summary</p>',
        },
      ],
    });
    const req = new Request('https://worker.example/v1/w8/history/confluence', {
      method: 'GET',
      headers: { Origin: 'https://shinick-han.github.io', Authorization: `Bearer ${sealed}` },
    });
    const res = await handleW8({
      request: req,
      env,
      url: new URL(req.url),
      match: matchW8('/v1/w8/history/confluence'),
      settings: { origins: new Set(['https://shinick-han.github.io']) },
      fetchImpl: mock.fetchImpl,
      now: () => now,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].id, '10888');
    assert.equal(body.items[0].title, 'Study Round 1 — Source Corpus');
    assert.equal(body.nextCursor, null);
  });
});
