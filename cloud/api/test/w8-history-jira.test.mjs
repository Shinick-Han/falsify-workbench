// Offline mocked Jira REST API v3 tests for W8 read-only Jira history (GET /v1/w8/history/jira).
// No live network calls, no writes, no credentials, no D1 required.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import worker from '../src/index.js';
import { GatewayError, SITE_URL, handleConfluence, matchConfluence } from '../src/confluence.mjs';
import { handleW8, matchW8 } from '../src/w8-team.mjs';
import {
  JIRA_HISTORY_JQL,
  JIRA_READ_SCOPE,
  classifyJiraAttachment,
  handleJiraHistory,
} from '../src/w8-history-jira.mjs';

const ORIGIN = 'https://shinick-han.github.io';

const CLOUD = '44444444-4444-4444-4444-444444444444';
const OTHER_CLOUD = '55555555-5555-5555-5555-555555555555';
const SECRET = 'synthetic-jira-history-secret';
const MEDIA_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MEDIA_URL = `https://api.media.atlassian.com/file/${MEDIA_UUID}/binary?client=abc&token=sig`;

const PDF_SMALL = Buffer.from('%PDF-1.7\n1 0 obj << /Title (FLS Report) >> endobj\n%%EOF\n');
const CSV_BOM = Buffer.from('\uFEFFparticipant,condition,finding\n홍길동,A,F1\n', 'utf8');
const MD_TEXT = Buffer.from('# W8 Experiment Notes\n\n- Verified FLS-18\n', 'utf8');
const JSON_TEXT = Buffer.from('{"issue":"FLS-18","runs":2}\n', 'utf8');
const HTML_PAYLOAD = Buffer.from('<html><body><script>alert(1)</script></body></html>', 'utf8');

function baseEnv(overrides = {}) {
  return {
    ATLASSIAN_CLIENT_ID: 'falsify-test-client',
    ATLASSIAN_CLIENT_SECRET: SECRET,
    ATLASSIAN_CALLBACK_URL: 'https://worker.example/v1/confluence/auth/callback',
    CONFLUENCE_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CONFLUENCE_PARENT_PAGE_ID: '8355842',
    ...overrides,
  };
}

function makeSession(overrides = {}) {
  return {
    accessToken: 'jira-read-access-token',
    cloudId: CLOUD,
    scopes: ['offline_access', 'read:confluence-user', JIRA_READ_SCOPE],
    scopeProfile: 'w8-history',
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

function makeAdfDoc(paragraphs) {
  return {
    version: 1,
    type: 'doc',
    content: paragraphs,
  };
}

function makeBudgetedFetch(rawFetch) {
  const controller = new AbortController();
  const budget = { signal: controller.signal, end: Date.now() + 25000 };
  const fn = (url, init) => rawFetch(url, init);
  fn.budget = budget;
  return { fetchImpl: fn, budget };
}

function createMockJira(options = {}) {
  const calls = [];
  const issues = new Map();
  for (const issue of options.issues || []) {
    issues.set(issue.key, issue);
  }
  const attachmentContent = new Map(Object.entries(options.attachmentContent || {}));
  const mediaFiles = new Map(Object.entries(options.mediaFiles || {}));

  const rawFetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const u = new URL(url);
    calls.push({
      url: u.toString(),
      method,
      host: u.hostname,
      path: u.pathname,
      search: u.search,
      hasAuth: hasHeader(init.headers, 'authorization'),
    });

    assert.equal(method, 'GET', 'Jira history must never perform write requests');
    assert.equal(init.redirect, 'manual', 'all upstream calls must disable auto-redirect');
    assert.equal(u.protocol, 'https:');
    assert.equal(u.pathname.includes('/rest/api/3/search/jql') || !u.pathname.endsWith('/rest/api/3/search'), true,
      'must use supported /rest/api/3/search/jql, never deprecated /search');

    if (u.hostname === 'api.atlassian.com' && u.pathname === '/oauth/token/accessible-resources') {
      const resources = options.resources ?? [{ id: CLOUD, url: SITE_URL, scopes: [JIRA_READ_SCOPE] }];
      return jsonResponse(200, resources);
    }

    if (u.hostname === 'api.media.atlassian.com') {
      assert.equal(hasHeader(init.headers, 'authorization'), false, 'Bearer token must be stripped on media redirect');
      const entry = mediaFiles.get(u.toString()) || mediaFiles.get(u.pathname);
      if (!entry) return new Response('missing media', { status: 404 });
      if (entry.redirect) return new Response(null, { status: 302, headers: { Location: entry.redirect } });
      return new Response(entry.bytes, {
        status: entry.status ?? 200,
        headers: { 'Content-Type': entry.contentType || 'application/octet-stream', ...(entry.headers || {}) },
      });
    }

    const jiraPrefix = `/ex/jira/${CLOUD}/rest/api/3`;
    if (u.hostname === 'api.atlassian.com' && u.pathname.startsWith(jiraPrefix)) {
      const restPath = u.pathname.slice(jiraPrefix.length);

      if (restPath === '/search/jql') {
        if (options.searchStatus) {
          return new Response('err', { status: options.searchStatus, headers: options.searchHeaders || {} });
        }
        assert.equal(u.searchParams.get('jql'), JIRA_HISTORY_JQL);
        const token = u.searchParams.get('nextPageToken') || '';
        if (options.searchPages) {
          const page = options.searchPages[token];
          if (!page) return jsonResponse(400, { errorMessages: ['invalid nextPageToken'] });
          return jsonResponse(200, page);
        }
        return jsonResponse(200, { issues: [...issues.values()], isLast: true });
      }

      const issueMatch = /^\/issue\/([^/]+)$/.exec(restPath);
      if (issueMatch) {
        const key = decodeURIComponent(issueMatch[1]);
        if (options.issueStatusByKey?.[key]) {
          return new Response('err', {
            status: options.issueStatusByKey[key],
            headers: options.issueHeadersByKey?.[key] || {},
          });
        }
        const issue = issues.get(key);
        if (!issue) return jsonResponse(404, { errorMessages: ['Issue does not exist'] });
        return jsonResponse(200, issue);
      }

      const attMatch = /^\/attachment\/content\/([0-9]+)$/.exec(restPath);
      if (attMatch) {
        const attId = attMatch[1];
        const entry = attachmentContent.get(attId);
        if (!entry) return new Response('not found', { status: 404 });
        if (entry.redirect) return new Response(null, { status: entry.status || 302, headers: { Location: entry.redirect } });
        return new Response(entry.bytes ?? null, {
          status: entry.status ?? 200,
          headers: { 'Content-Type': entry.contentType || 'application/octet-stream', ...(entry.headers || {}) },
        });
      }
    }

    throw new Error(`Unmocked upstream call: ${method} ${u.toString()}`);
  };

  const { fetchImpl, budget } = makeBudgetedFetch(rawFetch);
  return { calls, fetchImpl, budget };
}

async function callHistory(queryString, { env = baseEnv(), session = makeSession(), mock } = {}) {
  const url = new URL(`https://worker.example/v1/w8/history/jira${queryString}`);
  const request = new Request(url.toString(), { method: 'GET' });
  const ctx = {
    request,
    url,
    env,
    fetchImpl: mock.fetchImpl,
    budget: mock.budget,
  };
  return handleJiraHistory(ctx, session);
}

async function expectGatewayError(promise, status, code) {
  await assert.rejects(promise, err => {
    assert.ok(err instanceof GatewayError, `expected GatewayError, got ${err}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

describe('w8-history-jira: scope, auth, and config gates', () => {
  test('rejects missing session with 401 unauthorized', async () => {
    const mock = createMockJira();
    await expectGatewayError(callHistory('', { session: null, mock }), 401, 'unauthorized');
    assert.equal(mock.calls.length, 0);
  });

  test('rejects unconfigured env or altered site with 503 not_configured', async () => {
    const mock = createMockJira();
    await expectGatewayError(
      callHistory('', { env: baseEnv({ CONFLUENCE_SESSION_KEY: '' }), mock }),
      503,
      'not_configured',
    );
    await expectGatewayError(
      callHistory('', { env: baseEnv({ CONFLUENCE_SITE_URL: 'https://evil.atlassian.net' }), mock }),
      503,
      'not_configured',
    );
    assert.equal(mock.calls.length, 0);
  });

  test('returns dedicated 403 jira_scope_required when read:jira-work is missing', async () => {
    const mock = createMockJira({
      resources: [{ id: CLOUD, url: SITE_URL, scopes: ['read:page:confluence'] }],
    });
    await expectGatewayError(
      callHistory('', { session: makeSession({ scopes: ['read:page:confluence'] }), mock }),
      403,
      'jira_scope_required',
    );
    assert.equal(mock.calls.length, 0, 'must short-circuit before upstream calls when session scopes lack read:jira-work');

    await expectGatewayError(
      callHistory('', { session: makeSession({ scopes: undefined, scopeProfile: 'w8-history' }), mock }),
      403,
      'jira_scope_required',
    );
  });

  test('succeeds with read:jira-work ONLY and does not require write:jira-work', async () => {
    const mock = createMockJira({
      resources: [{ id: CLOUD, url: SITE_URL, scopes: [JIRA_READ_SCOPE] }],
      issues: [
        {
          key: 'FLS-18',
          fields: {
            summary: 'W8 evaluation',
            updated: '2026-11-20T09:00:00.000+0900',
            issuetype: { name: 'Task' },
            attachment: [],
          },
        },
      ],
    });
    const res = await callHistory('', {
      session: makeSession({ scopes: [JIRA_READ_SCOPE], scopeProfile: 'w8-history' }),
      mock,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].id, 'FLS-18');
  });

  test('rejects mismatched cloudId with 403 site_not_allowed', async () => {
    const mock = createMockJira({
      resources: [{ id: OTHER_CLOUD, url: SITE_URL, scopes: [JIRA_READ_SCOPE] }],
    });
    await expectGatewayError(callHistory('', { mock }), 403, 'site_not_allowed');
  });

  test('maps upstream Jira 401 to jira_scope_required and 403 to permission_denied', async () => {
    const mock401 = createMockJira({ searchStatus: 401 });
    await expectGatewayError(callHistory('', { mock: mock401 }), 403, 'jira_scope_required');

    const mock403 = createMockJira({ searchStatus: 403 });
    await expectGatewayError(callHistory('', { mock: mock403 }), 403, 'permission_denied');
  });
});

describe('w8-history-jira: list pagination via /search/jql', () => {
  test('lists fixed FLS project sorted key DESC with sealed nextPageToken pagination', async () => {
    const page1Issues = ['FLS-18', 'FLS-16', 'FLS-15'].map((key, idx) => ({
      key,
      fields: {
        summary: `Issue ${key}`,
        updated: `2026-11-2${idx}T12:00:00.000+0900`,
        issuetype: { name: 'Task' },
        attachment: idx === 0 ? [{ id: '101' }, { id: '102' }] : [],
      },
    }));
    // Inject a rogue non-FLS issue defensively to confirm it is filtered out.
    const page2Issues = [
      { key: 'OTHER-99', fields: { summary: 'Wrong project', updated: '2026-11-01T00:00:00Z', issuetype: { name: 'Bug' } } },
      ...['FLS-13', 'FLS-12', 'FLS-7'].map(key => ({
        key,
        fields: {
          summary: `Issue ${key}`,
          updated: '2026-11-10T01:02:03.000Z',
          issuetype: { name: 'Story' },
          attachment: [],
        },
      })),
    ];

    const mock = createMockJira({
      searchPages: {
        '': { issues: page1Issues, isLast: false, nextPageToken: 'tok_page_2_abc+def/==' },
        'tok_page_2_abc+def/==': { issues: page2Issues, isLast: true },
      },
    });

    // Empty ?cursor= should be accepted as page 1
    const res1 = await callHistory('?cursor=', { mock });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.deepEqual(body1.items.map(i => i.id), ['FLS-18', 'FLS-16', 'FLS-15']);
    assert.equal(body1.items[0].url, `${SITE_URL}/browse/FLS-18`);
    assert.equal(body1.items[0].attachmentCount, 2);
    assert.equal(body1.items[0].kind, 'Task');
    assert.equal(body1.items[0].updatedAt, '2026-11-20T03:00:00.000Z');
    assert.equal(typeof body1.nextCursor, 'string');
    assert.equal(body1.nextCursor.includes('tok_page_2'), false, 'raw nextPageToken must be sealed');

    const res2 = await callHistory(`?cursor=${encodeURIComponent(body1.nextCursor)}`, { mock });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.deepEqual(body2.items.map(i => i.id), ['FLS-13', 'FLS-12', 'FLS-7']);
    assert.equal(body2.nextCursor, null);

    // Tampered cursor and cross-cloud cursor must fail with 400 invalid_cursor
    await expectGatewayError(callHistory('?cursor=tampered_cursor_value', { mock }), 400, 'invalid_cursor');
    const otherMock = createMockJira({
      resources: [{ id: OTHER_CLOUD, url: SITE_URL, scopes: [JIRA_READ_SCOPE] }],
    });
    await expectGatewayError(
      callHistory(`?cursor=${encodeURIComponent(body1.nextCursor)}`, {
        session: makeSession({ cloudId: OTHER_CLOUD }),
        mock: otherMock,
      }),
      400,
      'invalid_cursor',
    );
  });

  test('rejects unknown query params, client JQL/domain overrides, and invalid param combos', async () => {
    const mock = createMockJira();
    await expectGatewayError(callHistory('?jql=project=OTHER', { mock }), 400, 'invalid_request');
    await expectGatewayError(callHistory('?domain=evil.example', { mock }), 400, 'invalid_request');
    await expectGatewayError(callHistory('?file=101', { mock }), 400, 'invalid_request');
    await expectGatewayError(callHistory('?attachmentCursor=abc', { mock }), 400, 'invalid_request');
    await expectGatewayError(callHistory('?id=FLS-18&cursor=abc', { mock }), 400, 'invalid_request');
    await expectGatewayError(callHistory('?id=FLS-18&file=101&attachmentCursor=abc', { mock }), 400, 'invalid_request');
    await expectGatewayError(callHistory('?id=OTHER-1', { mock }), 400, 'invalid_request');
    await expectGatewayError(callHistory('?id=fls-18', { mock }), 400, 'invalid_request');
    await expectGatewayError(callHistory('?id=FLS-18&file=att101', { mock }), 400, 'invalid_request');
    assert.equal(mock.calls.length, 0);
  });
});

describe('w8-history-jira: detail, comments, source-local links, and 51-attachment pagination', () => {
  test('renders ADF description, experiment comments, source-local links only, and paginates 51 attachments (10 PDF)', async () => {
    const attachments51 = [];
    for (let i = 1; i <= 51; i++) {
      if (i <= 10) {
        attachments51.push({ id: String(2000 + i), filename: `paper-${i}.pdf`, mimeType: 'application/pdf', size: 1024 * i });
      } else if (i <= 20) {
        attachments51.push({ id: String(2000 + i), filename: `notes-${i}.md`, mimeType: 'text/markdown', size: 512 });
      } else if (i <= 30) {
        attachments51.push({ id: String(2000 + i), filename: `results-${i}.csv`, mimeType: 'application/vnd.ms-excel', size: 1024 });
      } else if (i <= 35) {
        attachments51.push({ id: String(2000 + i), filename: `log-${i}.txt`, mimeType: 'text/plain', size: 256 });
      } else if (i <= 40) {
        attachments51.push({ id: String(2000 + i), filename: `meta-${i}.json`, mimeType: 'application/json', size: 256 });
      } else if (i === 41) {
        attachments51.push({ id: String(2000 + i), filename: 'report.html', mimeType: 'text/html', size: 256 });
      } else {
        attachments51.push({ id: String(2000 + i), filename: `chart-${i}.png`, mimeType: 'image/png', size: 4096 });
      }
    }

    const fls18 = {
      key: 'FLS-18',
      fields: {
        summary: 'W8 Team Experiment Hub',
        updated: '2026-11-22T15:30:00.000+0900',
        issuetype: { name: 'Epic' },
        description: makeAdfDoc([
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Main experiment instructions. See ' },
              {
                type: 'text',
                text: 'Confluence W8 Plan',
                marks: [{ type: 'link', attrs: { href: `${SITE_URL}/wiki/spaces/Falsify/pages/8355842` } }],
              },
              { type: 'text', text: ' and ignore ' },
              {
                type: 'text',
                text: 'External Phish',
                marks: [{ type: 'link', attrs: { href: 'https://evil.example/steal' } }],
              },
              {
                type: 'text',
                text: 'Signed Leak',
                marks: [{ type: 'link', attrs: { href: `${SITE_URL}/wiki/pages/1?token=secret123` } }],
              },
            ],
          },
          { type: 'inlineCard', attrs: { url: `${SITE_URL}/browse/FLS-12` } },
        ]),
        issuelinks: [
          {
            type: { outward: 'relates to', inward: 'is related to' },
            outwardIssue: { key: 'FLS-7', fields: { summary: 'Baseline corpus design' } },
          },
          {
            type: { outward: 'blocks' },
            outwardIssue: { key: 'OTHER-5', fields: { summary: 'Other project issue' } },
          },
        ],
        comment: {
          comments: [
            {
              id: '9001',
              author: { displayName: 'Alice' },
              created: '2026-11-21T10:00:00.000+0900',
              body: makeAdfDoc([
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'W8 BLUE submission linked: ' },
                    {
                      type: 'text',
                      text: 'Archive page',
                      marks: [{ type: 'link', attrs: { href: `${SITE_URL}/wiki/spaces/Falsify/pages/9991` } }],
                    },
                  ],
                },
              ]),
            },
          ],
        },
        attachment: attachments51,
      },
    };
    const fls7 = {
      key: 'FLS-7',
      fields: {
        summary: 'Baseline corpus design',
        updated: '2026-11-15T00:00:00.000Z',
        issuetype: { name: 'Task' },
        description: `Plain description referencing ${SITE_URL}/browse/FLS-13`,
        attachment: [],
      },
    };

    const mock = createMockJira({ issues: [fls18, fls7] });

    // Page 1 of FLS-18
    const r1 = await callHistory('?id=FLS-18', { mock });
    assert.equal(r1.status, 200);
    const d1 = await r1.json();
    assert.equal(d1.id, 'FLS-18');
    assert.equal(d1.title, 'W8 Team Experiment Hub');
    assert.equal(d1.url, `${SITE_URL}/browse/FLS-18`);
    assert.equal(d1.kind, 'Epic');
    assert.match(d1.text, /Main experiment instructions/);
    assert.match(d1.text, /--- Comments ---/);
    assert.match(d1.text, /Alice:/);
    assert.match(d1.text, /W8 BLUE submission linked/);

    // Verify source-local links only
    const linkUrls = d1.links.map(l => l.url);
    assert.ok(linkUrls.includes(`${SITE_URL}/browse/FLS-7`));
    assert.ok(linkUrls.includes(`${SITE_URL}/browse/FLS-12`));
    assert.ok(linkUrls.includes(`${SITE_URL}/wiki/spaces/Falsify/pages/8355842`));
    assert.ok(linkUrls.includes(`${SITE_URL}/wiki/spaces/Falsify/pages/9991`));
    assert.equal(linkUrls.some(u => u.includes('evil.example')), false);
    assert.equal(linkUrls.some(u => u.includes('OTHER-5')), false);
    assert.equal(linkUrls.some(u => u.includes('token=secret123')), false);

    assert.equal(d1.attachments.length, 25);
    assert.equal(typeof d1.nextAttachmentCursor, 'string');

    // Cross-issue attachmentCursor replay must fail
    await expectGatewayError(
      callHistory(`?id=FLS-7&attachmentCursor=${encodeURIComponent(d1.nextAttachmentCursor)}`, { mock }),
      400,
      'invalid_cursor',
    );

    // Page 2 and Page 3 of FLS-18 attachments
    const r2 = await callHistory(`?id=FLS-18&attachmentCursor=${encodeURIComponent(d1.nextAttachmentCursor)}`, { mock });
    assert.equal(r2.status, 200);
    const d2 = await r2.json();
    assert.equal(d2.attachments.length, 25);
    assert.equal(typeof d2.nextAttachmentCursor, 'string');

    const r3 = await callHistory(`?id=FLS-18&attachmentCursor=${encodeURIComponent(d2.nextAttachmentCursor)}`, { mock });
    assert.equal(r3.status, 200);
    const d3 = await r3.json();
    assert.equal(d3.attachments.length, 1);
    assert.equal(d3.nextAttachmentCursor, null);

    const all = [...d1.attachments, ...d2.attachments, ...d3.attachments];
    assert.equal(all.length, 51);
    assert.equal(new Set(all.map(a => a.id)).size, 51);
    assert.equal(all.filter(a => a.type === 'pdf').length, 10);
    assert.equal(all.filter(a => a.type === 'text').length, 30);
    assert.equal(all.find(a => a.title === 'report.html')?.type, 'file', 'HTML must never classify as text');

    // Verify reading non-default FLS issue (FLS-7) works directly
    const rFls7 = await callHistory('?id=FLS-7', { mock });
    assert.equal(rFls7.status, 200);
    const dFls7 = await rFls7.json();
    assert.equal(dFls7.id, 'FLS-7');
    assert.ok(dFls7.links.some(l => l.url === `${SITE_URL}/browse/FLS-13`));
  });

  test('classifies attachment types safely across MIME and extensions', () => {
    assert.equal(classifyJiraAttachment({ filename: 'a.pdf', mimeType: 'application/pdf' }), 'pdf');
    assert.equal(classifyJiraAttachment({ filename: 'a.PDF', mimeType: 'application/octet-stream' }), 'pdf');
    assert.equal(classifyJiraAttachment({ filename: 'a.md', mimeType: 'text/markdown' }), 'text');
    assert.equal(classifyJiraAttachment({ filename: 'a.markdown', mimeType: '' }), 'text');
    assert.equal(classifyJiraAttachment({ filename: 'a.csv', mimeType: 'application/vnd.ms-excel' }), 'text');
    assert.equal(classifyJiraAttachment({ filename: 'a.txt', mimeType: 'text/plain; charset=utf-8' }), 'text');
    assert.equal(classifyJiraAttachment({ filename: 'a.json', mimeType: 'application/json' }), 'text');
    assert.equal(classifyJiraAttachment({ filename: 'x.html', mimeType: 'text/html' }), 'file');
    assert.equal(classifyJiraAttachment({ filename: 'x.htm', mimeType: 'text/plain' }), 'file');
    assert.equal(classifyJiraAttachment({ filename: 'x.svg', mimeType: 'image/svg+xml' }), 'file');
    assert.equal(classifyJiraAttachment({ filename: 'x.txt', mimeType: 'text/html' }), 'file');
    assert.equal(classifyJiraAttachment({ filename: 'x.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'file');
  });
});

describe('w8-history-jira: file downloads, membership binding, 7MB PDF, text truncation, HTML safety', () => {
  test('streams 7MB PDF via media redirect stripping Bearer token and verifies %PDF- magic', async () => {
    const sevenMbPdf = Buffer.alloc(7 * 1024 * 1024, 0x20);
    Buffer.from('%PDF-1.7\n').copy(sevenMbPdf, 0);

    const mock = createMockJira({
      issues: [
        {
          key: 'FLS-16',
          fields: {
            summary: 'Large PDF issue',
            attachment: [
              { id: '7001', filename: 'largest-7mb.pdf', mimeType: 'application/pdf', size: sevenMbPdf.byteLength },
              { id: '7002', filename: 'corrupt.pdf', mimeType: 'application/pdf', size: 16 },
            ],
          },
        },
      ],
      attachmentContent: {
        '7001': { redirect: MEDIA_URL },
        '7002': { bytes: Buffer.from('NOT_A_PDF_BYTES!'), contentType: 'application/pdf' },
      },
      mediaFiles: {
        [MEDIA_URL]: { bytes: sevenMbPdf, contentType: 'application/pdf' },
      },
    });

    const res = await callHistory('?id=FLS-16&file=7001', { mock });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/pdf');
    assert.equal(res.headers.get('Content-Disposition'), 'inline; filename="attachment.pdf"');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    const out = new Uint8Array(await res.arrayBuffer());
    assert.equal(out.byteLength, sevenMbPdf.byteLength);
    assert.equal(Buffer.from(out.subarray(0, 5)).toString('ascii'), '%PDF-');

    // Non-PDF bytes masquerading as PDF must fail closed
    await expectGatewayError(callHistory('?id=FLS-16&file=7002', { mock }), 502, 'upstream_invalid');

    // Configured smaller PDF cap enforces 413 payload_too_large before downloading
    await expectGatewayError(
      callHistory('?id=FLS-16&file=7001', { env: baseEnv({ W8_HISTORY_MAX_PDF_BYTES: '1048576' }), mock }),
      413,
      'payload_too_large',
    );
  });

  test('binds file download to visible FLS issue and refuses cross-issue attachment IDs', async () => {
    const mock = createMockJira({
      issues: [
        {
          key: 'FLS-15',
          fields: {
            summary: 'Issue 15',
            attachment: [{ id: '5001', filename: 'mine.pdf', mimeType: 'application/pdf', size: PDF_SMALL.byteLength }],
          },
        },
        {
          key: 'FLS-18',
          fields: {
            summary: 'Issue 18',
            attachment: [{ id: '8001', filename: 'other.pdf', mimeType: 'application/pdf', size: PDF_SMALL.byteLength }],
          },
        },
      ],
      attachmentContent: {
        '8001': { bytes: PDF_SMALL, contentType: 'application/pdf' },
      },
    });

    // Requesting FLS-18's attachment 8001 through FLS-15 must return 404 without calling attachment/content
    await expectGatewayError(callHistory('?id=FLS-15&file=8001', { mock }), 404, 'not_found');
    assert.equal(mock.calls.some(c => c.path.includes('/attachment/content/')), false);
  });

  test('decodes markdown, csv (stripping BOM), txt, json as JSON {text, truncated} and never renders HTML', async () => {
    const mock = createMockJira({
      issues: [
        {
          key: 'FLS-12',
          fields: {
            summary: 'Text & HTML attachments',
            attachment: [
              { id: '3001', filename: 'data.csv', mimeType: 'text/csv', size: CSV_BOM.byteLength },
              { id: '3002', filename: 'notes.md', mimeType: 'text/markdown', size: MD_TEXT.byteLength },
              { id: '3003', filename: 'meta.json', mimeType: 'application/json', size: JSON_TEXT.byteLength },
              { id: '3004', filename: 'page.html', mimeType: 'text/html', size: HTML_PAYLOAD.byteLength },
              { id: '3005', filename: 'archive.zip', mimeType: 'application/zip', size: 1234 },
            ],
          },
        },
      ],
      attachmentContent: {
        '3001': { bytes: CSV_BOM, contentType: 'text/csv' },
        '3002': { bytes: MD_TEXT, contentType: 'text/markdown' },
        '3003': { bytes: JSON_TEXT, contentType: 'application/json' },
        '3004': { bytes: HTML_PAYLOAD, contentType: 'text/html' },
      },
    });

    const csvRes = await callHistory('?id=FLS-12&file=3001', { mock });
    assert.equal(csvRes.status, 200);
    assert.equal(csvRes.headers.get('Content-Type'), 'application/json; charset=utf-8');
    const csvBody = await csvRes.json();
    assert.deepEqual(csvBody, { text: 'participant,condition,finding\n홍길동,A,F1\n', truncated: false });

    // Truncation when exceeding W8_HISTORY_MAX_TEXT_CHARS
    const truncRes = await callHistory('?id=FLS-12&file=3002', {
      env: baseEnv({ W8_HISTORY_MAX_TEXT_CHARS: '15' }),
      mock,
    });
    assert.equal(truncRes.status, 200);
    assert.deepEqual(await truncRes.json(), { text: '# W8 Experiment', truncated: true });

    const jsonRes = await callHistory('?id=FLS-12&file=3003', { mock });
    assert.deepEqual(await jsonRes.json(), { text: '{"issue":"FLS-18","runs":2}\n', truncated: false });

    // HTML and binary formats return native attachment link JSON without downloading binary/rendering HTML
    const htmlCallsBefore = mock.calls.length;
    const htmlRes = await callHistory('?id=FLS-12&file=3004', { mock });
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.deepEqual(await htmlRes.json(), {
      id: '3004',
      title: 'page.html',
      type: 'file',
      url: `${SITE_URL}/rest/api/3/attachment/content/3004`,
    });
    const newCalls = mock.calls.slice(htmlCallsBefore);
    assert.equal(newCalls.some(c => c.path.includes('/attachment/content/')), false, 'must not download HTML attachment');

    const zipRes = await callHistory('?id=FLS-12&file=3005', { mock });
    assert.deepEqual(await zipRes.json(), {
      id: '3005',
      title: 'archive.zip',
      type: 'file',
      url: `${SITE_URL}/rest/api/3/attachment/content/3005`,
    });
  });

  test('refuses untrusted download redirect domains and forwards 429 Retry-After', async () => {
    const mock = createMockJira({
      issues: [
        {
          key: 'FLS-13',
          fields: {
            summary: 'Redirect security test',
            attachment: [
              { id: '6001', filename: 'evil.pdf', mimeType: 'application/pdf', size: 100 },
              { id: '6002', filename: 'throttled.pdf', mimeType: 'application/pdf', size: 100 },
            ],
          },
        },
      ],
      attachmentContent: {
        '6001': { redirect: 'https://evil.example/file.pdf' },
        '6002': { status: 429, headers: { 'Retry-After': '42' } },
      },
    });

    await expectGatewayError(callHistory('?id=FLS-13&file=6001', { mock }), 502, 'redirect_refused');
    await assert.rejects(callHistory('?id=FLS-13&file=6002', { mock }), err => {
      assert.ok(err instanceof GatewayError);
      assert.equal(err.status, 429);
      assert.equal(err.code, 'rate_limited');
      assert.equal(err.headers['Retry-After'], '42');
      return true;
    });
  });

  test('rejects NUL-containing text attachment and avoids splitting UTF-16 surrogates on truncation', async () => {
    const mock = createMockJira({
      issues: [
        {
          key: 'FLS-18',
          fields: {
            summary: 'Binary-in-text and emoji truncation',
            attachment: [
              { id: '9101', filename: 'sneaky.txt', mimeType: 'text/plain', size: 8 },
              { id: '9102', filename: 'emoji.md', mimeType: 'text/markdown', size: 16 },
            ],
          },
        },
      ],
      attachmentContent: {
        '9101': { bytes: Buffer.from([0x61, 0x00, 0x62, 0x63]), contentType: 'text/plain' },
        '9102': { bytes: Buffer.from('ab🧪cd', 'utf8'), contentType: 'text/markdown' },
      },
    });

    await expectGatewayError(callHistory('?id=FLS-18&file=9101', { mock }), 502, 'upstream_invalid');

    const res = await callHistory('?id=FLS-18&file=9102', {
      env: baseEnv({ W8_HISTORY_MAX_TEXT_CHARS: '3' }),
      mock,
    });
    assert.equal(res.status, 200);
    // 'ab' (2 code units) + high surrogate of '🧪' (at index 2) -> drops dangling high surrogate cleanly
    assert.deepEqual(await res.json(), { text: 'ab', truncated: true });
  });
});

describe('w8-history-jira: end-to-end /v1/w8/history/jira routing via handleW8 and worker', () => {
  function postedFromCallback(html) {
    const start = html.indexOf('var message=');
    const originKey = ';var origin=';
    const mid = html.indexOf(originKey, start);
    const end = html.indexOf(';var text=', mid);
    return JSON.parse(html.slice(start + 'var message='.length, mid));
  }

  async function mintOAuthSession(env, startPath, grantedScopes, fetchImpl) {
    const startReq = new Request(`https://worker.example${startPath}`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: 'nonce_jira_history_e2e_01', returnOrigin: ORIGIN }),
    });
    const startRes = await handleW8({
      request: startReq,
      env,
      url: new URL(startReq.url),
      match: matchW8(startPath),
      settings: { origins: new Set([ORIGIN]) },
      fetchImpl,
    });
    assert.equal(startRes.status, 200);
    const { authorizeUrl } = await startRes.json();
    const authUrl = new URL(authorizeUrl);
    if (startPath === '/v1/w8/history/auth/start') {
      const requested = authUrl.searchParams.get('scope').split(' ');
      assert.ok(requested.includes('read:jira-work'));
      assert.equal(requested.includes('write:jira-work'), false, 'history auth must not request write:jira-work');
    }
    const state = authUrl.searchParams.get('state');
    const cbUrl = `https://worker.example/v1/confluence/auth/callback?code=code_e2e_123&state=${encodeURIComponent(state)}`;
    const cbRes = await handleConfluence({
      request: new Request(cbUrl, { method: 'GET' }),
      env,
      url: new URL(cbUrl),
      match: matchConfluence('/v1/confluence/auth/callback'),
      settings: { origins: new Set([ORIGIN]) },
      fetchImpl,
    });
    assert.equal(cbRes.status, 200);
    const posted = postedFromCallback(await cbRes.text());
    assert.ok(posted.session);
    return posted.session;
  }

  test('routes /v1/w8/history/jira through handleW8 with history OAuth session and rejects non-GET and missing Jira scope', async () => {
    const env = baseEnv({ ALLOWED_ORIGINS: ORIGIN, CONFLUENCE_ONLY: 'true', W8_TEAM_ENABLED: 'true' });
    let activeScopes = ['offline_access', 'read:confluence-user', JIRA_READ_SCOPE];
    const fetchImpl = async (url, init = {}) => {
      const u = new URL(url);
      if (u.hostname === 'auth.atlassian.com' && u.pathname === '/oauth/token') {
        return jsonResponse(200, {
          access_token: 'e2e-token',
          refresh_token: 'e2e-refresh',
          expires_in: 3600,
          scope: activeScopes.join(' '),
        });
      }
      if (u.pathname === '/oauth/token/accessible-resources') {
        return jsonResponse(200, [{ id: CLOUD, url: SITE_URL, scopes: activeScopes }]);
      }
      if (u.pathname === `/ex/confluence/${CLOUD}/wiki/api/v2/spaces/65737`) {
        return jsonResponse(200, { id: '65737', key: 'Falsify' });
      }
      if (u.pathname === `/ex/confluence/${CLOUD}/wiki/api/v2/pages/8355842`) {
        return jsonResponse(200, { id: '8355842', spaceId: '65737', status: 'current' });
      }
      if (u.pathname === `/ex/confluence/${CLOUD}/wiki/api/v2/pages/8355842/restriction-state`) {
        return jsonResponse(200, { state: 'OPEN' });
      }
      if (u.pathname === `/ex/confluence/${CLOUD}/wiki/api/v2/pages/8355842/ancestors`) {
        return jsonResponse(200, { results: [] });
      }
      if (u.pathname === `/ex/jira/${CLOUD}/rest/api/3/search/jql`) {
        assert.equal(init.method || 'GET', 'GET');
        return jsonResponse(200, {
          issues: [{ key: 'FLS-18', fields: { summary: 'E2E issue', updated: '2026-11-22T00:00:00Z', issuetype: { name: 'Task' }, attachment: [] } }],
          isLast: true,
        });
      }
      throw new Error(`Unexpected e2e call ${u.toString()}`);
    };

    const historyToken = await mintOAuthSession(env, '/v1/w8/history/auth/start', activeScopes, fetchImpl);
    const okReq = new Request('https://worker.example/v1/w8/history/jira', {
      method: 'GET',
      headers: { Origin: ORIGIN, Authorization: `Bearer ${historyToken}` },
    });
    const okRes = await handleW8({
      request: okReq,
      env,
      url: new URL(okReq.url),
      match: matchW8('/v1/w8/history/jira'),
      settings: { origins: new Set([ORIGIN]) },
      fetchImpl,
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.items[0].id, 'FLS-18');

    // Non-GET write attempts must be rejected with 405 method_not_allowed
    const postReq = new Request('https://worker.example/v1/w8/history/jira', {
      method: 'POST',
      headers: { Origin: ORIGIN, Authorization: `Bearer ${historyToken}` },
    });
    const postRes = await handleW8({
      request: postReq,
      env,
      url: new URL(postReq.url),
      match: matchW8('/v1/w8/history/jira'),
      settings: { origins: new Set([ORIGIN]) },
      fetchImpl,
    });
    assert.equal(postRes.status, 405);

    // Session minted without read:jira-work returns 403 jira_scope_required JSON envelope
    activeScopes = ['offline_access', 'read:confluence-user'];
    const noJiraToken = await mintOAuthSession(env, '/v1/w8/paper-auth/start', activeScopes, fetchImpl);
    const deniedReq = new Request('https://worker.example/v1/w8/history/jira', {
      method: 'GET',
      headers: { Origin: ORIGIN, Authorization: `Bearer ${noJiraToken}` },
    });
    const deniedRes = await handleW8({
      request: deniedReq,
      env,
      url: new URL(deniedReq.url),
      match: matchW8('/v1/w8/history/jira'),
      settings: { origins: new Set([ORIGIN]) },
      fetchImpl,
    });
    assert.equal(deniedRes.status, 403);
    const deniedBody = await deniedRes.json();
    assert.equal(deniedBody.error.code, 'jira_scope_required');

    // Worker OPTIONS CORS preflight succeeds
    const optRes = await worker.fetch(
      new Request('https://worker.example/v1/w8/history/jira', { method: 'OPTIONS', headers: { Origin: ORIGIN } }),
      env,
    );
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  });
});
