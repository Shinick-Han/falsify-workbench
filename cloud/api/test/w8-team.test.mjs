// Offline mocked Atlassian tests for W8 Stage 2 team delivery.
// No live writes, no real OAuth calls, no D1 secrets.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import worker from '../src/index.js';
import { handleConfluence, matchConfluence } from '../src/confluence.mjs';
import { handleW8, matchW8, parseW8Marker, W8_JIRA_SCOPES, W8_READY_LABEL, W8_PROPERTY_KEY } from '../src/w8-team.mjs';
import { W8_ARCHIVE_SCHEMA, canonicalJson, validateW8BlueArchive } from '../src/w8-archive.mjs';

const CLOUD = '22222222-2222-2222-2222-222222222222';
const PARENT = '8355842';
const ORIGIN = 'https://shinick-han.github.io';
const OTHER_ORIGIN = 'http://127.0.0.1:7816';
const SECRET = 'synthetic-w8-client-secret';
const SITE = 'https://falsify.atlassian.net';
const T0 = 1_700_100_000_000;

const BOM_CSV = '\uFEFF참가자,조건,탐지기,모델,실행번호,ID,물리 페이지,위치(절·그림·표),유형,판정(아님/확인필요),심각도,정확한 원문 인용,대응 근거·이유·검산,확신,추가로 필요한 정보\r\n홍길동,A,내장 BLUE,claude-sonnet-5-5,1,F1,2,"Section 2, Table 1",numerical_mismatch,확인필요,major,"Sample ""quoted"" claim","Table 1 reports 12%, text claims 21%.",high,\r\n';
const REVISED_CSV = '\uFEFF참가자,조건,탐지기,모델,실행번호,ID,물리 페이지,위치(절·그림·표),유형,판정(아님/확인필요),심각도,정확한 원문 인용,대응 근거·이유·검산,확신,추가로 필요한 정보\r\n홍길동,A,내장 BLUE,claude-sonnet-5-5,1,F1,2,"Section 2, Table 1",numerical_mismatch,확인필요,major,"Sample ""quoted"" claim","Updated rationale after manual check.",high,\r\n';
const FILENAME = 'Blue_W8_홍길동_A.csv';

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function makeArchive({
  participant = '홍길동',
  condition = 'A',
  issueKey = 'FLS-18',
  csv = BOM_CSV,
  filename = FILENAME,
  findings = [
    {
      id: 'F1',
      page: 2,
      locationLabel: 'Section 2, Table 1',
      findingType: 'numerical_mismatch',
      verdictLabel: '확인필요',
      severity: 'major',
      quote: 'Sample "quoted" claim',
      rationale: 'Table 1 reports 12%, text claims 21%.',
      evidence: [{ quote: 'Table 1: 12%', relation: 'contradicts prose', label: 'p.2 Table 1' }],
      confidence: 'high',
      uncertainty: 'No raw dataset attached.',
      additionalInfo: '',
    },
  ],
} = {}) {
  return {
    schema: W8_ARCHIVE_SCHEMA,
    participant,
    condition,
    issueKey,
    csvFilename: filename,
    csvSha256: sha256(Buffer.from(csv, 'utf8')),
    runCount: 1,
    findingCount: findings.length,
    runs: [
      {
        runNumber: 1,
        id: 'blue-run-1',
        createdAt: '2026-11-23T01:00:00.000Z',
        sourceKind: 'builtin',
        provenance: 'local-codex',
        detector: '내장 BLUE',
        model: 'claude-sonnet-5-5',
        fileHash: 'a'.repeat(64),
        sourceHash: 'b'.repeat(64),
        promptCondition: 'w8-common-v6',
        status: 'ok',
        findings,
      },
    ],
  };
}

function baseEnv(overrides = {}) {
  return {
    ATLASSIAN_CLIENT_ID: 'falsify-test-client',
    ATLASSIAN_CLIENT_SECRET: SECRET,
    ATLASSIAN_CALLBACK_URL: 'https://worker.example/v1/confluence/auth/callback',
    CONFLUENCE_SESSION_KEY: Buffer.alloc(32, 9).toString('base64'),
    CONFLUENCE_PARENT_PAGE_ID: PARENT,
    ALLOWED_ORIGINS: `${ORIGIN},${OTHER_ORIGIN}`,
    CONFLUENCE_ONLY: 'true',
    W8_TEAM_ENABLED: 'true',
    ...overrides,
  };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function extractMultipartFile(body) {
  const buf = Buffer.from(body);
  const marker = Buffer.from('\r\n\r\n');
  const start = buf.indexOf(marker);
  const end = buf.lastIndexOf(Buffer.from('\r\n--'));
  assert.ok(start > 0 && end > start, 'valid multipart body');
  const head = buf.subarray(0, start).toString('utf8');
  const nameMatch = /filename="([^"]+)"/.exec(head);
  return {
    filename: nameMatch ? nameMatch[1] : null,
    bytes: buf.subarray(start + 4, end),
  };
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

function mockAtlassian(options = {}) {
  const calls = [];
  const state = {
    nextPageId: 9100,
    nextAttId: 500,
    nextCommentId: 1000,
    pages: new Map(), // pageId -> { id, title, parentId, spaceId, summary, attachments: Map, properties: Map, labels: Set }
    jiraAttachments: new Map(), // issueKey -> [{ id, filename, size, content, bytes, author }]
    jiraComments: new Map(), // issueKey -> [{ id, author, body }]
  };

  const fullScopes = [
    'offline_access',
    'read:space:confluence',
    'read:page:confluence',
    'read:content.metadata:confluence',
    'write:page:confluence',
    'read:attachment:confluence',
    'write:confluence-file',
    'readonly:content.attachment:confluence',
    'write:confluence-content',
    ...W8_JIRA_SCOPES,
  ];

  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const u = new URL(url);
    calls.push({ url: u.toString(), method, host: u.hostname, path: u.pathname, search: u.search, headers: init.headers, body: init.body });
    assert.equal(init.redirect, 'manual');
    assert.equal(u.protocol, 'https:');
    assert.ok(u.hostname === 'api.atlassian.com' || u.hostname === 'auth.atlassian.com' || u.hostname === 'api.media.atlassian.com');

    if (u.hostname === 'auth.atlassian.com' && u.pathname === '/oauth/token') {
      const n = calls.filter(c => c.path === '/oauth/token').length;
      const scope = options.tokenScope !== undefined ? options.tokenScope : fullScopes.join(' ');
      return jsonResponse(200, {
        access_token: `access-token-${n}`,
        refresh_token: `refresh-token-${n}`,
        expires_in: 3600,
        ...(scope !== null ? { scope } : {}),
      });
    }

    if (u.pathname === '/oauth/token/accessible-resources') {
      const scopes = options.resourceScopes !== undefined ? options.resourceScopes : fullScopes;
      return jsonResponse(200, options.resources ?? [{ id: CLOUD, url: SITE, ...(scopes ? { scopes } : {}) }]);
    }

    // Media redirect target for Jira attachment download
    if (u.hostname === 'api.media.atlassian.com') {
      assert.equal(init.headers?.Authorization, undefined, 'Bearer must be stripped on cross-host media redirect');
      const attId = u.searchParams.get('attId');
      for (const list of state.jiraAttachments.values()) {
        const found = list.find(a => a.id === attId);
        if (found) return new Response(found.bytes, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
      }
      return new Response('missing', { status: 404 });
    }

    // Confluence endpoints
    if (u.pathname.includes('/ex/confluence/')) {
      const wiki = u.pathname.slice(u.pathname.indexOf('/wiki/'));
      if (wiki === '/wiki/api/v2/spaces/65737') {
        if (options.spaceStatus) return new Response('no', { status: options.spaceStatus });
        return jsonResponse(200, options.space ?? { id: '65737', key: 'Falsify' });
      }
      if (method === 'GET' && wiki === `/wiki/api/v2/pages/${PARENT}` && u.search === '') {
        if (options.parentStatus) return new Response('no', { status: options.parentStatus });
        return jsonResponse(200, options.parent ?? { id: PARENT, spaceId: '65737' });
      }
      if (method === 'GET' && /^\/wiki\/api\/v2\/pages\/[0-9]+\/ancestors$/.test(wiki)) {
        return jsonResponse(200, { results: options.ancestors ?? [] });
      }
      if (method === 'GET' && /^\/wiki\/api\/v2\/pages\/([0-9]+)\/restriction-state$/.test(wiki)) {
        const id = wiki.split('/')[5];
        return jsonResponse(200, { state: options.restrictionById?.[id] || 'OPEN' });
      }
      if (method === 'GET' && wiki === '/wiki/api/v2/pages' && u.searchParams.has('title')) {
        const title = u.searchParams.get('title');
        const matches = [...state.pages.values()].filter(p => p.title === title);
        return jsonResponse(200, { results: matches.map(p => ({ id: p.id, title: p.title, status: 'current' })) });
      }
      if (method === 'POST' && wiki === '/wiki/api/v2/pages') {
        if (options.failConfluenceCreate) return new Response('err', { status: 500 });
        const body = JSON.parse(init.body);
        const id = String(++state.nextPageId);
        const page = {
          id,
          title: body.title,
          parentId: body.parentId,
          spaceId: body.spaceId,
          summary: body.body.value,
          attachments: new Map(),
          properties: new Map(),
          labels: new Set(),
        };
        state.pages.set(id, page);
        return jsonResponse(200, { id, spaceId: body.spaceId, parentId: body.parentId, title: body.title, status: 'current' });
      }
      const pageGet = /^\/wiki\/api\/v2\/pages\/([0-9]+)$/.exec(wiki);
      if (method === 'GET' && pageGet) {
        const page = state.pages.get(pageGet[1]);
        if (!page) return jsonResponse(404, {});
        return jsonResponse(200, {
          id: page.id,
          title: page.title,
          status: 'current',
          parentId: page.parentId,
          spaceId: page.spaceId,
          version: { createdAt: '2026-11-23T01:00:00.000Z' },
          _links: { webui: `/spaces/Falsify/pages/${page.id}/W8` },
          labels: { results: [...page.labels].map(name => ({ prefix: 'global', name })) },
          properties: { results: [...page.properties.entries()].map(([key, value]) => ({ key, value })) },
        });
      }
      const attList = /^\/wiki\/api\/v2\/pages\/([0-9]+)\/attachments$/.exec(wiki);
      if (method === 'GET' && attList) {
        const page = state.pages.get(attList[1]);
        return jsonResponse(200, { results: page ? [...page.attachments.values()].map(a => ({ id: a.id, title: a.title })) : [] });
      }
      const attPost = /^\/wiki\/rest\/api\/content\/([0-9]+)\/child\/attachment$/.exec(wiki);
      if (method === 'POST' && attPost) {
        if (options.failConfluenceAttachmentOnce) {
          options.failConfluenceAttachmentOnce = false;
          return new Response('err', { status: 500 });
        }
        const page = state.pages.get(attPost[1]);
        const { filename, bytes } = extractMultipartFile(init.body);
        const attId = `att${++state.nextAttId}`;
        page.attachments.set(attId, { id: attId, title: filename, bytes });
        return jsonResponse(200, { results: [{ id: attId, title: filename }] });
      }
      const attDl = /^\/wiki\/rest\/api\/content\/([0-9]+)\/child\/attachment\/((?:att)?[0-9]+)\/download$/.exec(wiki);
      if (method === 'GET' && attDl) {
        const page = state.pages.get(attDl[1]);
        const att = page?.attachments.get(attDl[2]);
        if (!att) return new Response('missing', { status: 404 });
        return new Response(att.bytes, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const propPost = /^\/wiki\/api\/v2\/pages\/([0-9]+)\/properties$/.exec(wiki);
      if (method === 'POST' && propPost) {
        const page = state.pages.get(propPost[1]);
        const { key, value } = JSON.parse(init.body);
        page.properties.set(key, value);
        return jsonResponse(200, { key });
      }
      const labelPost = /^\/wiki\/rest\/api\/content\/([0-9]+)\/label$/.exec(wiki);
      if (method === 'POST' && labelPost) {
        if (options.failConfluenceLabelOnce) {
          options.failConfluenceLabelOnce = false;
          return new Response('err', { status: 500 });
        }
        const page = state.pages.get(labelPost[1]);
        for (const item of JSON.parse(init.body)) page.labels.add(item.name);
        return jsonResponse(200, { results: [...page.labels].map(name => ({ name })) });
      }
      if (method === 'GET' && wiki === `/wiki/api/v2/pages/${PARENT}/children`) {
        const children = [...state.pages.values()].filter(p => p.parentId === PARENT).map(p => ({ id: p.id, parentId: PARENT }));
        return jsonResponse(200, { results: children });
      }
    }

    // Jira endpoints
    if (u.pathname.includes('/ex/jira/')) {
      const rest = u.pathname.slice(u.pathname.indexOf('/rest/'));
      const accountId = options.accountId || 'acc-alice';
      if (method === 'GET' && rest === '/rest/api/3/myself') {
        if (options.jiraMyselfStatus) return new Response('no', { status: options.jiraMyselfStatus });
        return jsonResponse(200, { accountId, displayName: 'Synthetic Alice' });
      }
      if (method === 'GET' && rest === '/rest/api/3/mypermissions') {
        if (options.jiraPermsStatus) return new Response('no', { status: options.jiraPermsStatus });
        const perms = {
          BROWSE_PROJECTS: { havePermission: true },
          CREATE_ATTACHMENTS: { havePermission: true },
          ADD_COMMENTS: { havePermission: true },
          EDIT_OWN_COMMENTS: { havePermission: true },
          ...(options.jiraPermissions || {}),
        };
        return jsonResponse(200, { permissions: perms });
      }
      const issueGet = /^\/rest\/api\/3\/issue\/([A-Z0-9_-]+)$/.exec(rest);
      if (method === 'GET' && issueGet) {
        const key = issueGet[1];
        if (options.missingIssue === key) return jsonResponse(404, {});
        const atts = (state.jiraAttachments.get(key) || []).map(({ bytes, ...meta }) => meta);
        return jsonResponse(200, { key, fields: { summary: `W8 ${key}`, attachment: atts } });
      }
      const attUpload = /^\/rest\/api\/3\/issue\/([A-Z0-9_-]+)\/attachments$/.exec(rest);
      if (method === 'POST' && attUpload) {
        assert.equal(init.headers['X-Atlassian-Token'], 'no-check');
        if (options.failJiraAttachmentOnce) {
          options.failJiraAttachmentOnce = false;
          return new Response('err', { status: 500 });
        }
        const key = attUpload[1];
        const { filename, bytes } = extractMultipartFile(init.body);
        const id = String(++state.nextAttId);
        const record = {
          id,
          filename,
          size: bytes.byteLength,
          content: `${SITE}/rest/api/3/attachment/content/${id}`,
          author: { accountId },
          bytes,
        };
        if (!state.jiraAttachments.has(key)) state.jiraAttachments.set(key, []);
        state.jiraAttachments.get(key).push(record);
        const { bytes: _b, ...publicRec } = record;
        return jsonResponse(200, [publicRec]);
      }
      const attContent = /^\/rest\/api\/3\/attachment\/content\/([0-9]+)$/.exec(rest);
      if (method === 'GET' && attContent) {
        const attId = attContent[1];
        if (options.jiraDownloadRedirect) {
          return new Response(null, {
            status: 303,
            headers: {
              Location: `https://api.media.atlassian.com/file/11111111-2222-4333-8444-555555555555/binary?attId=${attId}&token=signed-dl`,
            },
          });
        }
        for (const list of state.jiraAttachments.values()) {
          const found = list.find(a => a.id === attId);
          if (found) return new Response(found.bytes, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
        }
        return new Response('missing', { status: 404 });
      }
      const commentList = /^\/rest\/api\/3\/issue\/([A-Z0-9_-]+)\/comment$/.exec(rest);
      if (method === 'GET' && commentList) {
        const key = commentList[1];
        const all = state.jiraComments.get(key) || [];
        return jsonResponse(200, { startAt: 0, maxResults: 100, total: all.length, comments: all });
      }
      if (method === 'POST' && commentList) {
        if (options.failJiraCommentOnce) {
          options.failJiraCommentOnce = false;
          return new Response('err', { status: 500 });
        }
        if (options.timeoutJiraCommentAfterCommitOnce) {
          options.timeoutJiraCommentAfterCommitOnce = false;
          const key = commentList[1];
          const { body } = JSON.parse(init.body);
          const id = String(++state.nextCommentId);
          const rec = { id, author: { accountId }, body };
          if (!state.jiraComments.has(key)) state.jiraComments.set(key, []);
          state.jiraComments.get(key).push(rec);
          return new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        if (options.timeoutJiraCommentBeforeCommitOnce) {
          options.timeoutJiraCommentBeforeCommitOnce = false;
          return new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        const key = commentList[1];
        const { body } = JSON.parse(init.body);
        const id = String(++state.nextCommentId);
        const rec = { id, author: { accountId }, body };
        if (!state.jiraComments.has(key)) state.jiraComments.set(key, []);
        state.jiraComments.get(key).push(rec);
        return jsonResponse(201, rec);
      }
      const commentPut = /^\/rest\/api\/3\/issue\/([A-Z0-9_-]+)\/comment\/([0-9]+)$/.exec(rest);
      if (method === 'PUT' && commentPut) {
        const [, key, id] = commentPut;
        const { body } = JSON.parse(init.body);
        const list = state.jiraComments.get(key) || [];
        const target = list.find(c => c.id === id);
        if (!target) return jsonResponse(404, {});
        if (options.timeoutJiraPutAfterCommitOnce) {
          options.timeoutJiraPutAfterCommitOnce = false;
          target.body = body;
          return new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        target.body = body;
        return jsonResponse(200, target);
      }
    }

    throw new Error(`unmocked ${method} ${u.toString()}`);
  };

  return { fetchImpl, calls, state };
}

function w8Request(path, { method = 'GET', headers = {}, body, env, fetchImpl, now = T0, origin = ORIGIN, requestBudgetMs } = {}) {
  const request = new Request(`https://worker.example${path}`, {
    method,
    headers: { Origin: origin, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return handleW8({
    request,
    env: env ?? baseEnv(),
    url: new URL(request.url),
    match: matchW8(new URL(request.url).pathname),
    settings: { origins: new Set([ORIGIN, OTHER_ORIGIN]) },
    fetchImpl: fetchImpl ?? (async () => { throw new Error('unexpected fetch'); }),
    now: () => now,
    requestBudgetMs,
  });
}

function confluenceRequest(path, { method = 'GET', headers = {}, body, env, fetchImpl, now = T0, origin = ORIGIN } = {}) {
  const request = new Request(`https://worker.example${path}`, {
    method,
    headers: { Origin: origin, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return handleConfluence({
    request,
    env: env ?? baseEnv(),
    url: new URL(request.url),
    match: matchConfluence(new URL(request.url).pathname),
    settings: { origins: new Set([ORIGIN, OTHER_ORIGIN]) },
    fetchImpl: fetchImpl ?? (async () => { throw new Error('unexpected fetch'); }),
    now: () => now,
  });
}

async function readRes(response) {
  const text = await response.text();
  try { return { status: response.status, headers: response.headers, json: JSON.parse(text), text }; }
  catch { return { status: response.status, headers: response.headers, json: null, text }; }
}

async function mintW8Session({ mock = mockAtlassian(), env = baseEnv(), origin = ORIGIN, nonce = 'w'.repeat(20), now = T0 } = {}) {
  const started = await readRes(await w8Request('/v1/w8/auth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { nonce, returnOrigin: origin },
    origin,
    env,
    fetchImpl: mock.fetchImpl,
    now,
  }));
  assert.equal(started.status, 200);
  const authUrl = new URL(started.json.authorizeUrl);
  const stateToken = authUrl.searchParams.get('state');
  const cb = await readRes(await confluenceRequest(`/v1/confluence/auth/callback?code=w8-auth-code&state=${encodeURIComponent(stateToken)}`, {
    env,
    fetchImpl: mock.fetchImpl,
    now,
    origin,
  }));
  const posted = postedFromCallback(cb.text);
  assert.ok(posted, 'callback posted sealed session');
  assert.equal(posted.origin, origin);
  assert.equal(posted.message.nonce, nonce);
  assert.equal(posted.message.scopeProfile, 'w8-team');
  return { session: posted.message.session, authorizeUrl: authUrl, mock, env };
}

describe('W8 Stage 2 team delivery gateway', { concurrency: false }, () => {
  test('capabilities expose confinement without secrets and allow configured test issue', async () => {
    const bare = await readRes(await w8Request('/v1/w8/capabilities', { env: { ALLOWED_ORIGINS: ORIGIN } }));
    assert.equal(bare.status, 200);
    assert.equal(bare.json.configured, false);
    assert.equal(bare.json.issueKey, 'FLS-18');
    assert.equal(bare.text.includes(SECRET), false);

    const configured = await readRes(await w8Request('/v1/w8/capabilities', {
      env: baseEnv({ W8_JIRA_ISSUE_KEY: 'FLS-99', W8_ALLOWED_ISSUE_KEYS: 'FLS-18,FLS-99' }),
    }));
    assert.equal(configured.status, 200);
    assert.equal(configured.json.configured, true);
    assert.equal(configured.json.siteUrl, SITE);
    assert.equal(configured.json.spaceKey, 'Falsify');
    assert.equal(configured.json.spaceId, '65737');
    assert.equal(configured.json.parentPageId, PARENT);
    assert.equal(configured.json.issueKey, 'FLS-99');
    assert.deepEqual(configured.json.allowedIssues, ['FLS-18', 'FLS-99']);
    assert.equal(configured.text.includes(SECRET), false);
  });

  test('OAuth scope expansion happens only on /v1/w8/auth/start and Confluence-only sessions are rejected for W8', async () => {
    const confMock = mockAtlassian({ tokenScope: null, resourceScopes: null });
    const confStart = await readRes(await confluenceRequest('/v1/confluence/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { nonce: 'c'.repeat(20), returnOrigin: ORIGIN },
      fetchImpl: confMock.fetchImpl,
    }));
    assert.equal(confStart.status, 200);
    const confScopes = new URL(confStart.json.authorizeUrl).searchParams.get('scope').split(' ');
    assert.equal(confScopes.includes('read:jira-work'), false);
    assert.equal(confScopes.includes('write:jira-work'), false);

    const confState = new URL(confStart.json.authorizeUrl).searchParams.get('state');
    const confCb = await readRes(await confluenceRequest(`/v1/confluence/auth/callback?code=c-code-1&state=${encodeURIComponent(confState)}`, {
      fetchImpl: confMock.fetchImpl,
    }));
    const confSession = postedFromCallback(confCb.text).message.session;

    // Confluence-only session cannot submit to W8 without Jira scopes.
    const submitDenied = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${confSession}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: makeArchive() },
      fetchImpl: confMock.fetchImpl,
    }));
    assert.equal(submitDenied.status, 403);
    assert.equal(submitDenied.json.error.code, 'jira_scope_required');
    assert.equal(confMock.calls.some(c => c.method === 'POST' && c.path.includes('/ex/')), false);

    // W8 auth start adds Jira scopes and reuses the single registered callback URL.
    const minted = await mintW8Session();
    const w8Scopes = minted.authorizeUrl.searchParams.get('scope').split(' ');
    assert.equal(w8Scopes.includes('read:jira-work'), true);
    assert.equal(w8Scopes.includes('write:jira-work'), true);
    assert.equal(minted.authorizeUrl.searchParams.get('redirect_uri'), 'https://worker.example/v1/confluence/auth/callback');

    // Legacy password token or missing bearer rejected without upstream calls.
    const noAuth = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: makeArchive() },
    }));
    assert.equal(noAuth.status, 401);
    const legacy = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer fss_${'x'.repeat(43)}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: makeArchive() },
    }));
    assert.equal(legacy.status, 401);
  });

  test('happy path submits sanitized BLUE-only archive, exact BOM CSV, and one comment without touching D1 or legacy list', async () => {
    const mock = mockAtlassian();
    let dbCalls = 0;
    const env = baseEnv({ DB: { prepare() { dbCalls++; throw new Error('D1 touched'); } } });
    const minted = await mintW8Session({ mock, env });
    const archive = makeArchive();

    const res = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive },
      env,
      fetchImpl: mock.fetchImpl,
    }));

    assert.equal(res.status, 201);
    assert.equal(res.json.submitted, true);
    assert.equal(res.json.issueKey, 'FLS-18');
    assert.equal(res.json.pageUrl, `${SITE}/wiki/spaces/Falsify/pages/${res.json.pageId}/W8`);
    assert.equal(res.json.issueUrl, `${SITE}/browse/FLS-18?focusedCommentId=${res.json.commentId}`);
    assert.equal(res.json.csvSha256, sha256(Buffer.from(BOM_CSV, 'utf8')));
    assert.equal(res.json.alreadyExisted, false);
    assert.equal(res.json.commentUpdated, false);
    assert.deepEqual(res.json.reused, { page: false, attachment: false, comment: false });
    assert.equal(dbCalls, 0);

    // Verify Confluence page content & isolation from legacy confluence-store list.
    const page = mock.state.pages.get(res.json.pageId);
    assert.ok(page);
    assert.equal(page.parentId, PARENT);
    assert.equal(page.labels.has(W8_READY_LABEL), true);
    assert.equal(page.labels.has('falsify-archive-ready'), false, 'must not pollute legacy confluence archive list');
    assert.equal(page.properties.get(W8_PROPERTY_KEY).archiveSha256, res.json.archiveSha256);
    assert.match(page.summary, /No raw PDF document and no RED ledger/);

    // Verify exact CSV bytes attached to Jira (including UTF-8 BOM).
    const jiraAtts = mock.state.jiraAttachments.get('FLS-18');
    assert.equal(jiraAtts.length, 1);
    assert.equal(jiraAtts[0].filename, FILENAME);
    assert.equal(jiraAtts[0].bytes.toString('utf8'), BOM_CSV);
    assert.equal(jiraAtts[0].bytes[0], 0xef);
    assert.equal(jiraAtts[0].bytes[1], 0xbb);
    assert.equal(jiraAtts[0].bytes[2], 0xbf);

    // Verify single Jira ADF comment contains both links and reconciliation marker.
    const comments = mock.state.jiraComments.get('FLS-18');
    assert.equal(comments.length, 1);
    const commentJson = JSON.stringify(comments[0].body);
    assert.equal(commentJson.includes(res.json.pageUrl), true);
    assert.equal(commentJson.includes(res.json.attachmentUrl), true);
    assert.ok(parseW8Marker(commentJson));

    // Readback via GET /v1/w8/status returns current remote receipt without mutating.
    const statusRes = await readRes(await w8Request('/v1/w8/status?participant=' + encodeURIComponent('홍길동'), {
      headers: { Authorization: `Bearer ${minted.session}` },
      env,
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.json.found, true);
    assert.equal(statusRes.json.pageId, res.json.pageId);
    assert.equal(statusRes.json.attachmentId, res.json.attachmentId);
    assert.equal(statusRes.json.commentId, res.json.commentId);
  });

  test('partial retry after Jira attachment reuses Confluence page and CSV attachment with zero duplicates', async () => {
    const mock = mockAtlassian({ failJiraCommentOnce: true, jiraDownloadRedirect: true });
    const env = baseEnv({ W8_JIRA_ISSUE_KEY: 'FLS-999' });
    const minted = await mintW8Session({ mock, env });
    const archive = makeArchive({ issueKey: 'FLS-999' });

    // First attempt: Confluence page + Jira CSV attachment succeed, comment fails 500 -> 409 write_unknown.
    const first = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive, issueKey: 'FLS-999' },
      env,
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(first.status, 409);
    assert.equal(first.json.error.code, 'write_unknown');
    assert.equal(first.json.readBack, true);
    assert.ok(first.json.progress.pageId);
    assert.ok(first.json.progress.attachmentId);
    assert.equal(mock.state.pages.size, 1);
    assert.equal(mock.state.jiraAttachments.get('FLS-999').length, 1);
    assert.equal((mock.state.jiraComments.get('FLS-999') || []).length, 0);

    // Retry WITHOUT even passing resume hint (simulates lost client state after reload):
    // server reconciles remote Confluence page and byte-verifies Jira attachment (across media redirect).
    const second = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive, issueKey: 'FLS-999' },
      env,
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(second.status, 201);
    assert.equal(second.json.pageId, first.json.progress.pageId);
    assert.equal(second.json.attachmentId, first.json.progress.attachmentId);
    assert.deepEqual(second.json.reused, { page: true, attachment: true, comment: false });
    assert.equal(mock.state.pages.size, 1, 'no duplicate Confluence page');
    assert.equal(mock.state.jiraAttachments.get('FLS-999').length, 1, 'no duplicate Jira attachment');
    assert.equal(mock.state.jiraComments.get('FLS-999').length, 1, 'exactly one comment created');
  });

  test('partial retry resumes unfinished Confluence page created before label failure', async () => {
    const mock = mockAtlassian({ failConfluenceLabelOnce: true });
    const minted = await mintW8Session({ mock });
    const archive = makeArchive();

    const first = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive },
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(first.status, 409);
    assert.equal(mock.state.pages.size, 1);
    assert.equal((mock.state.jiraAttachments.get('FLS-18') || []).length, 0);

    const second = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive },
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(second.status, 201);
    assert.equal(mock.state.pages.size, 1, 'resumed unfinished page without creating a second page');
    assert.equal(mock.state.jiraAttachments.get('FLS-18').length, 1);
    assert.equal(mock.state.jiraComments.get('FLS-18').length, 1);
  });

  test('duplicates are no-op, revisions update the same single participant comment, and separate users stay isolated', async () => {
    const mock = mockAtlassian();
    const minted = await mintW8Session({ mock });
    const archive1 = makeArchive({ csv: BOM_CSV });

    const first = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: archive1 },
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(first.status, 201);

    // Exact duplicate submission: returns 200 alreadyExisted=true, zero additional writes.
    const writesBefore = mock.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length;
    const dup = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: archive1 },
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(dup.status, 200);
    assert.equal(dup.json.alreadyExisted, true);
    assert.equal(dup.json.pageId, first.json.pageId);
    assert.equal(dup.json.attachmentId, first.json.attachmentId);
    assert.equal(dup.json.commentId, first.json.commentId);
    assert.equal(mock.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length, writesBefore, 'no extra writes on duplicate');

    // Revised CSV submission: creates new Confluence page + attaches new CSV + updates SAME comment!
    const archive2 = makeArchive({ csv: REVISED_CSV });
    const rev = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: REVISED_CSV, archive: archive2 },
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(rev.status, 200);
    assert.equal(rev.json.alreadyExisted, false);
    assert.equal(rev.json.commentUpdated, true);
    assert.notEqual(rev.json.pageId, first.json.pageId);
    assert.notEqual(rev.json.attachmentId, first.json.attachmentId);
    assert.equal(rev.json.commentId, first.json.commentId, 'must update the exact same participant comment');
    assert.equal(mock.state.jiraComments.get('FLS-18').length, 1, 'still only ONE comment for this participant');
    const updatedText = JSON.stringify(mock.state.jiraComments.get('FLS-18')[0].body);
    assert.equal(updatedText.includes(rev.json.pageUrl), true);
    assert.equal(updatedText.includes(rev.json.attachmentUrl), true);

    // Different authenticated Jira user submitting even with same display name gets their own comment (cannot hijack Alice's).
    const bobMock = mockAtlassian({ accountId: 'acc-bob' });
    bobMock.state.nextCommentId = 2000;
    bobMock.state.jiraComments.set('FLS-18', [...mock.state.jiraComments.get('FLS-18')]);
    const bobSession = await mintW8Session({ mock: bobMock });
    const bobRes = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bobSession.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: archive1 },
      fetchImpl: bobMock.fetchImpl,
    }));
    assert.equal(bobRes.status, 201);
    assert.notEqual(bobRes.json.commentId, first.json.commentId);
    assert.equal(bobMock.state.jiraComments.get('FLS-18').length, 2);
  });

  test('confinement, permissions, forbidden RED/raw-doc payloads, and browser-supplied tokens are rejected before writes', async () => {
    const mock = mockAtlassian();
    const minted = await mintW8Session({ mock });
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` };

    // Disallowed Jira issue
    const badIssue = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers,
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: makeArchive({ issueKey: 'OTHER-1' }), issueKey: 'OTHER-1' },
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(badIssue.status, 403);
    assert.equal(badIssue.json.error.code, 'issue_not_allowed');

    // Browser-supplied token/url fields rejected
    const withToken = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers,
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: makeArchive(), token: 'global-secret' },
      fetchImpl: mock.fetchImpl,
    }));
    assert.equal(withToken.status, 400);

    // Forbidden RED / raw document / PDF fields rejected
    for (const mutated of [
      { ...makeArchive(), segments: [{ id: 's0', text: 'raw paper' }] },
      { ...makeArchive(), gold: [{ id: 'G1' }] },
      { ...makeArchive(), runs: [{ ...makeArchive().runs[0], sourceRunId: 'red-1' }] },
      { ...makeArchive(), runs: [{ ...makeArchive().runs[0], findings: [{ ...makeArchive().runs[0].findings[0], quote: '%PDF-1.7 binary' }] }] },
    ]) {
      const rejected = await readRes(await w8Request('/v1/w8/submit', {
        method: 'POST',
        headers,
        body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: mutated },
        fetchImpl: mock.fetchImpl,
      }));
      assert.equal(rejected.status, 422);
      assert.equal(rejected.json.error.code, 'forbidden_content');
    }

    // Missing Jira permission fails BEFORE any Confluence page write
    const noPermMock = mockAtlassian({ jiraPermissions: { CREATE_ATTACHMENTS: { havePermission: false } } });
    const noPermSession = await mintW8Session({ mock: noPermMock });
    const noPerm = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${noPermSession.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: makeArchive() },
      fetchImpl: noPermMock.fetchImpl,
    }));
    assert.equal(noPerm.status, 403);
    assert.equal(noPerm.json.error.code, 'permission_denied');
    assert.equal(noPermMock.state.pages.size, 0, 'must not create orphan Confluence page when Jira permission is missing');

    // Restricted Confluence parent fails BEFORE any write
    const restrictedMock = mockAtlassian({ restrictionById: { [PARENT]: 'VIEW_RESTRICTED' } });
    const restricted = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers,
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: makeArchive() },
      fetchImpl: restrictedMock.fetchImpl,
    }));
    assert.equal(restricted.status, 403);
    assert.equal(restricted.json.error.code, 'parent_not_allowed');
    assert.equal(restrictedMock.state.pages.size, 0);

    // Zero-finding valid BLUE run is accepted
    const zeroCsv = '\uFEFF참가자,조건,탐지기,모델,실행번호,ID,물리 페이지,위치(절·그림·표),유형,판정(아님/확인필요),심각도,정확한 원문 인용,대응 근거·이유·검산,확신,추가로 필요한 정보\r\n';
    const zeroArchive = makeArchive({ csv: zeroCsv, findings: [] });
    const zeroValidated = await validateW8BlueArchive(zeroArchive);
    assert.equal(zeroValidated.normalized.findingCount, 0);
    assert.equal(typeof canonicalJson(zeroValidated.normalized), 'string');
  });

  test('the model Worker leaves the team routes on the team Worker', async () => {
    const request = () => new Request('https://worker.example/v1/w8/capabilities', {
      headers: { Origin: ORIGIN },
    });
    assert.equal((await worker.fetch(request(), baseEnv({ W8_TEAM_ENABLED: undefined }))).status, 404);
    assert.equal((await worker.fetch(request(), baseEnv())).status, 200);
  });

  test('worker fetch routes /v1/w8/* with strict CORS and redacted logs', async () => {
    const mock = mockAtlassian();
    const minted = await mintW8Session({ mock, now: Date.now() });
    const lines = [];
    const origLog = console.log;
    const origErr = console.error;
    const origFetch = globalThis.fetch;
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    globalThis.fetch = mock.fetchImpl;
    try {
      const env = baseEnv();
      const forbiddenOrigin = await worker.fetch(new Request('https://worker.example/v1/w8/capabilities', {
        headers: { Origin: 'https://evil.example' },
      }), env);
      assert.equal(forbiddenOrigin.status, 403);
      assert.equal(forbiddenOrigin.headers.get('access-control-allow-origin'), null);

      const preflight = await worker.fetch(new Request('https://worker.example/v1/w8/submit', {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN },
      }), env);
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);

      const ok = await worker.fetch(new Request('https://worker.example/v1/w8/submit', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${minted.session}` },
        body: JSON.stringify({ participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive: makeArchive() }),
      }), env);
      assert.equal(ok.status, 201);
      assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    } finally {
      console.log = origLog;
      console.error = origErr;
      globalThis.fetch = origFetch;
    }
    const joined = lines.join('\n');
    assert.match(joined, /"route":"\/v1\/w8\/submit"/);
    assert.equal(joined.includes(SECRET), false);
    assert.equal(joined.includes('access-token-'), false);
    assert.equal(joined.includes('Table 1 reports 12%'), false);
  });

  test('comment timeout alternate paths: committed-before-timeout reconciles read-only with zero writes; uncommitted-before-timeout creates one comment on retry', async () => {
    // Alternate path 1: Jira comment POST actually committed before Worker deadline timed out.
    const committedMock = mockAtlassian({ timeoutJiraCommentAfterCommitOnce: true });
    const minted1 = await mintW8Session({ mock: committedMock });
    const archive = makeArchive();
    const timedOut1 = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted1.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive },
      fetchImpl: committedMock.fetchImpl,
      requestBudgetMs: 80,
    }));
    assert.equal(timedOut1.status, 409);
    assert.equal(timedOut1.json.error.code, 'write_unknown');
    assert.equal(timedOut1.json.readBack, true);
    assert.ok(timedOut1.json.progress.pageId);
    assert.ok(timedOut1.json.progress.attachmentId);
    assert.equal(committedMock.state.jiraComments.get('FLS-18').length, 1, 'comment landed remotely before timeout');

    // Read-only status check immediately sees the committed comment.
    const status1 = await readRes(await w8Request('/v1/w8/status?participant=' + encodeURIComponent('홍길동'), {
      headers: { Authorization: `Bearer ${minted1.session}` },
      fetchImpl: committedMock.fetchImpl,
    }));
    assert.equal(status1.status, 200);
    assert.equal(status1.json.found, true);
    assert.equal(status1.json.csvSha256, archive.csvSha256);
    assert.equal(status1.json.pageId, timedOut1.json.progress.pageId);
    assert.equal(status1.json.attachmentId, timedOut1.json.progress.attachmentId);

    // Repeated identical submission after committed timeout performs ZERO writes and returns alreadyExisted=true.
    const writesBefore = committedMock.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length;
    const resume1 = { pageId: timedOut1.json.progress.pageId, attachmentId: timedOut1.json.progress.attachmentId, csvSha256: timedOut1.json.progress.csvSha256, archiveSha256: timedOut1.json.progress.archiveSha256 };
    const repeated = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted1.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive, resume: resume1 },
      fetchImpl: committedMock.fetchImpl,
    }));
    assert.equal(repeated.status, 200);
    assert.equal(repeated.json.alreadyExisted, true);
    assert.deepEqual(repeated.json.reused, { page: true, attachment: true, comment: true });
    assert.equal(committedMock.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length, writesBefore, 'zero extra writes after reconciliation');
    assert.equal(committedMock.state.jiraComments.get('FLS-18').length, 1);

    // Alternate path 2: Jira comment POST timed out BEFORE committing -> status is found=false, retry posts ONLY the comment.
    const uncommittedMock = mockAtlassian({ timeoutJiraCommentBeforeCommitOnce: true });
    const minted2 = await mintW8Session({ mock: uncommittedMock });
    const timedOut2 = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted2.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive },
      fetchImpl: uncommittedMock.fetchImpl,
      requestBudgetMs: 80,
    }));
    assert.equal(timedOut2.status, 409);
    assert.equal(timedOut2.json.error.code, 'write_unknown');
    assert.equal((uncommittedMock.state.jiraComments.get('FLS-18') || []).length, 0);

    const status2 = await readRes(await w8Request('/v1/w8/status?participant=' + encodeURIComponent('홍길동'), {
      headers: { Authorization: `Bearer ${minted2.session}` },
      fetchImpl: uncommittedMock.fetchImpl,
    }));
    assert.equal(status2.status, 200);
    assert.equal(status2.json.found, false);

    const resume2 = { pageId: timedOut2.json.progress.pageId, attachmentId: timedOut2.json.progress.attachmentId, csvSha256: timedOut2.json.progress.csvSha256, archiveSha256: timedOut2.json.progress.archiveSha256 };
    const resumed2 = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted2.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive, resume: resume2 },
      fetchImpl: uncommittedMock.fetchImpl,
    }));
    assert.equal(resumed2.status, 201);
    assert.deepEqual(resumed2.json.reused, { page: true, attachment: true, comment: false });
    assert.equal(uncommittedMock.state.pages.size, 1);
    assert.equal(uncommittedMock.state.jiraAttachments.get('FLS-18').length, 1);
    assert.equal(uncommittedMock.state.jiraComments.get('FLS-18').length, 1);

    // Alternate path 3: Revision comment PUT committed before timeout -> repeated identical revision reconciles cleanly with zero extra writes.
    const revArchive = makeArchive({ csv: REVISED_CSV });
    const revMock = mockAtlassian({ timeoutJiraPutAfterCommitOnce: true });
    const minted3 = await mintW8Session({ mock: revMock });
    const initial3 = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted3.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: BOM_CSV, archive },
      fetchImpl: revMock.fetchImpl,
    }));
    assert.equal(initial3.status, 201);

    const revTimedOut = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted3.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: REVISED_CSV, archive: revArchive },
      fetchImpl: revMock.fetchImpl,
      requestBudgetMs: 80,
    }));
    assert.equal(revTimedOut.status, 409);
    assert.equal(revTimedOut.json.error.code, 'write_unknown');

    const revWritesBefore = revMock.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length;
    const revReconciled = await readRes(await w8Request('/v1/w8/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minted3.session}` },
      body: { participant: '홍길동', condition: 'A', filename: FILENAME, csv: REVISED_CSV, archive: revArchive },
      fetchImpl: revMock.fetchImpl,
    }));
    assert.equal(revReconciled.status, 200);
    assert.equal(revReconciled.json.alreadyExisted, true);
    assert.equal(revReconciled.json.commentId, initial3.json.commentId);
    assert.equal(revMock.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length, revWritesBefore);
    assert.equal(revMock.state.jiraComments.get('FLS-18').length, 1);
  });

  test('archive preserves large run/finding counts and long verbatim quotes without arbitrary truncation up to 6 MiB', async () => {
    const longQuote = 'Verbatim claim '.repeat(400).trim(); // 6000 chars (> old 4000 cap)
    const manyFindings = Array.from({ length: 220 }, (_, i) => ({
      id: `F${i + 1}`,
      page: i + 1,
      locationLabel: `Section ${i + 1}`,
      findingType: 'numerical_mismatch',
      verdictLabel: '확인필요',
      severity: 'minor',
      quote: i === 0 ? longQuote : `Quote ${i + 1}`,
      rationale: i === 0 ? longQuote : `Rationale ${i + 1}`,
      evidence: Array.from({ length: 15 }, (_, j) => ({ quote: `Ev ${j}`, relation: 'supports', label: 'p.1' })),
      confidence: 'high',
      uncertainty: '',
      additionalInfo: '',
    }));
    const bigArchive = makeArchive({ findings: manyFindings });
    const validated = await validateW8BlueArchive(bigArchive);
    assert.equal(validated.normalized.findingCount, 220);
    assert.equal(validated.normalized.runs[0].findings[0].quote, longQuote);
    assert.equal(validated.normalized.runs[0].findings[0].evidence.length, 15);
  });
});
