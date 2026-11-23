// Offline mocked Confluence tests for W8 team paper library sync (PUT /v1/w8/paper-sync).
// No live writes, no real OAuth calls, no credentials, no D1 required.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import worker from '../src/index.js';
import { handleConfluence, matchConfluence, SESSION_HEADER } from '../src/confluence.mjs';
import { handleW8, matchW8 } from '../src/w8-team.mjs';
import {
  W8_DEFAULT_LIBRARY_PARENT_ID,
  W8_PAPER_SYNC_KIND,
  W8_PAPER_SYNC_LABEL,
  W8_PAPER_SYNC_PROPERTY_KEY,
  W8_PAPER_SYNC_SCHEMA,
  paperSyncPageTitle,
  parseAppOwnedPaperBody,
} from '../src/w8-paper-sync.mjs';
import { canonicalJson } from '../src/w8-archive.mjs';

const CLOUD = '22222222-2222-2222-2222-222222222222';
const LEGACY_PARENT = '8355842';
const LIBRARY_PARENT = W8_DEFAULT_LIBRARY_PARENT_ID; // 20512769
const CUSTOM_PARENT = '30999888';
const ORIGIN = 'https://shinick-han.github.io';
const SECRET = 'synthetic-paper-sync-secret';
const SITE = 'https://falsify.atlassian.net';
const T0 = 1_700_200_000_000;

const SRC_A = 'a'.repeat(64);
const REV_1 = '1'.repeat(64);
const REV_2 = '2'.repeat(64);

const CONFLUENCE_ONLY_SCOPES = [
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

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function baseEnv(overrides = {}) {
  return {
    ATLASSIAN_CLIENT_ID: 'falsify-test-client',
    ATLASSIAN_CLIENT_SECRET: SECRET,
    ATLASSIAN_CALLBACK_URL: 'https://worker.example/v1/confluence/auth/callback',
    CONFLUENCE_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
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

function createSharedConfluenceServer(options = {}) {
  const calls = [];
  const state = {
    nextPageId: 40000,
    nextAttId: 700,
    nextPropId: 900,
    parentIds: new Set([LEGACY_PARENT, LIBRARY_PARENT, ...(options.extraParents || [])]),
    pages: new Map(), // pageId -> { id, title, parentId, spaceId, version, body, attachments: Map(attId -> {id,title,bytes}), properties: Map(key -> {id,key,value,version}), labels: Set }
    tokenUsers: new Map(), // accessToken -> { accountId, displayName }
    defaultUser: options.defaultUser || { accountId: 'acc-alice', displayName: 'Alice Kim' },
  };

  function latestAttachmentState(page) {
    const parsed = parseAppOwnedPaperBody(page.body, page.title.split(' ').pop());
    if (!parsed || parsed.stateToken === 'pending') return null;
    const filename = `${parsed.stateToken}.json`;
    const att = [...page.attachments.values()].find(a => a.title === filename);
    assert.ok(att, `attachment ${filename} must exist`);
    assert.equal(sha256(att.bytes), parsed.stateToken);
    return JSON.parse(att.bytes.toString('utf8'));
  }

  function makeFetch(userOverride = null) {
    return async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      const u = new URL(url);
      calls.push({ url: u.toString(), method, host: u.hostname, path: u.pathname, search: u.search, headers: init.headers });
      assert.equal(init.redirect, 'manual');
      assert.equal(u.protocol, 'https:');
      assert.equal(u.pathname.includes('/ex/jira/'), false, 'paper-sync must never call Jira');

      if (u.hostname === 'auth.atlassian.com' && u.pathname === '/oauth/token') {
        const n = calls.filter(c => c.path === '/oauth/token').length;
        const token = `conf-access-${n}`;
        if (userOverride) state.tokenUsers.set(token, userOverride);
        return jsonResponse(200, {
          access_token: token,
          refresh_token: `conf-refresh-${n}`,
          expires_in: options.tokenExpiresIn ?? 3600,
          scope: CONFLUENCE_ONLY_SCOPES.join(' '),
        });
      }

      if (u.pathname === '/oauth/token/accessible-resources') {
        return jsonResponse(200, options.resources ?? [{ id: CLOUD, url: SITE, scopes: CONFLUENCE_ONLY_SCOPES }]);
      }

      if (u.pathname.includes('/ex/confluence/')) {
        const wiki = u.pathname.slice(u.pathname.indexOf('/wiki/'));
        const bearer = String(init.headers?.Authorization || '').replace(/^Bearer\s+/, '');
        const user = userOverride || state.tokenUsers.get(bearer) || state.defaultUser;

        if (method === 'GET' && wiki === '/wiki/rest/api/user/current') {
          if (options.userCurrentStatus) return new Response('no', { status: options.userCurrentStatus });
          return jsonResponse(200, user);
        }

        if (method === 'GET' && wiki === '/wiki/api/v2/spaces/65737') {
          if (options.spaceStatus) return new Response('no', { status: options.spaceStatus });
          return jsonResponse(200, options.space ?? { id: '65737', key: 'Falsify' });
        }

        if (method === 'GET' && /^\/wiki\/api\/v2\/pages\/([0-9]+)\/ancestors$/.test(wiki)) {
          const id = wiki.split('/')[5];
          return jsonResponse(200, { results: options.ancestorsById?.[id] ?? options.ancestors ?? [] });
        }

        if (method === 'GET' && /^\/wiki\/api\/v2\/pages\/([0-9]+)\/restriction-state$/.test(wiki)) {
          const id = wiki.split('/')[5];
          if (options.restrictionStatusById?.[id]) return new Response('no', { status: options.restrictionStatusById[id] });
          return jsonResponse(200, { state: options.restrictionById?.[id] || 'OPEN' });
        }

        const childrenMatch = /^\/wiki\/api\/v2\/pages\/([0-9]+)\/children$/.exec(wiki);
        if (method === 'GET' && childrenMatch) {
          const parentId = childrenMatch[1];
          if (options.childrenStatus) return new Response('no', { status: options.childrenStatus });
          const allChildren = [
            ...[...state.pages.values()]
              .filter(p => p.parentId === parentId)
              .map(p => ({ id: p.id, parentId: p.parentId, type: p.type || 'page', status: p.status || 'current', title: p.title })),
            ...(options.extraChildrenByParent?.[parentId] || []),
          ];
          const pageSize = options.childrenPageSize || 25;
          const cursorParam = u.searchParams.get('cursor');
          let offset = 0;
          if (cursorParam) {
            const m = /^raw_w8_cursor_([0-9]+)=$/.exec(cursorParam);
            if (!m) return jsonResponse(400, { message: 'bad cursor' });
            offset = Number(m[1]);
          }
          const slice = allChildren.slice(offset, offset + pageSize);
          const nextOffset = offset + slice.length;
          let nextLink = null;
          if (options.evilNext) {
            nextLink = 'https://evil.example/steal?cursor=raw_evil=';
          } else if (nextOffset < allChildren.length) {
            nextLink = `/ex/confluence/${CLOUD}/wiki/api/v2/pages/${parentId}/children?cursor=${encodeURIComponent(`raw_w8_cursor_${nextOffset}=`)}`;
          }
          return jsonResponse(200, {
            results: slice,
            ...(nextLink ? { _links: { next: nextLink } } : {}),
          });
        }

        if (method === 'GET' && wiki === '/wiki/api/v2/pages' && u.searchParams.has('title')) {
          const title = u.searchParams.get('title');
          const matches = [...state.pages.values()].filter(p => p.title === title);
          return jsonResponse(200, { results: matches.map(p => ({ id: p.id, title: p.title, status: 'current' })) });
        }

        if (method === 'POST' && wiki === '/wiki/api/v2/pages') {
          const body = JSON.parse(init.body);
          if (typeof options.beforePageCreate === 'function') {
            const hookResult = await options.beforePageCreate(body, state);
            if (hookResult) return hookResult;
          }
          const dup = [...state.pages.values()].find(p => p.title === body.title && p.spaceId === body.spaceId);
          if (dup) return jsonResponse(409, { message: 'duplicate title' });
          const id = String(++state.nextPageId);
          const page = {
            id,
            title: body.title,
            parentId: String(body.parentId),
            spaceId: String(body.spaceId),
            version: 1,
            body: body.body.value,
            attachments: new Map(),
            properties: new Map(),
            labels: new Set(),
          };
          state.pages.set(id, page);
          return jsonResponse(200, {
            id,
            title: page.title,
            status: 'current',
            parentId: page.parentId,
            spaceId: page.spaceId,
            version: { number: page.version, createdAt: '2026-11-23T06:00:00.000Z' },
            _links: { webui: `/spaces/Falsify/pages/${id}/Paper` },
          });
        }

        const pageMatch = /^\/wiki\/api\/v2\/pages\/([0-9]+)$/.exec(wiki);
        if (method === 'GET' && pageMatch) {
          const id = pageMatch[1];
          if (options.pageStatusById?.[id]) return new Response('no', { status: options.pageStatusById[id] });
          if (state.parentIds.has(id) && !state.pages.has(id)) {
            if (options.parentStatusById?.[id]) return new Response('no', { status: options.parentStatusById[id] });
            const spaceId = options.parentSpaceById?.[id] || '65737';
            return jsonResponse(200, { id, spaceId, status: 'current' });
          }
          const page = state.pages.get(id);
          if (!page) return jsonResponse(404, {});
          return jsonResponse(200, {
            id: page.id,
            title: page.title,
            status: page.status || 'current',
            parentId: page.parentId,
            spaceId: page.spaceId,
            version: { number: page.version, createdAt: '2026-11-23T06:00:00.000Z' },
            body: { storage: { representation: 'storage', value: page.body } },
            _links: { webui: options.badWebUiById?.[id] ?? page.webui ?? `/spaces/Falsify/pages/${page.id}/Paper` },
            labels: { results: [...page.labels].map(name => ({ prefix: 'global', name })) },
            properties: { results: [...page.properties.values()].map(p => ({ id: p.id, key: p.key, value: p.value, version: { number: p.version } })) },
          });
        }

        if (method === 'PUT' && pageMatch) {
          const id = pageMatch[1];
          const page = state.pages.get(id);
          if (!page) return jsonResponse(404, {});
          const body = JSON.parse(init.body);
          if (typeof options.beforePagePut === 'function') {
            const hookResult = await options.beforePagePut(page, body, state);
            if (hookResult) return hookResult;
          }
          if (body.version?.number !== page.version + 1) {
            return jsonResponse(409, { message: 'version conflict' });
          }
          page.version = body.version.number;
          page.title = body.title;
          page.body = body.body.value;
          return jsonResponse(200, {
            id: page.id,
            title: page.title,
            status: 'current',
            parentId: page.parentId,
            spaceId: page.spaceId,
            version: { number: page.version, createdAt: '2026-11-23T06:01:00.000Z' },
            _links: { webui: `/spaces/Falsify/pages/${page.id}/Paper` },
          });
        }

        const attList = /^\/wiki\/api\/v2\/pages\/([0-9]+)\/attachments$/.exec(wiki);
        if (method === 'GET' && attList) {
          const page = state.pages.get(attList[1]);
          const filename = u.searchParams.get('filename');
          const all = page ? [...page.attachments.values()] : [];
          const filtered = filename ? all.filter(a => a.title === filename) : all;
          return jsonResponse(200, { results: filtered.map(a => ({ id: a.id, title: a.title })) });
        }

        const attPost = /^\/wiki\/rest\/api\/content\/([0-9]+)\/child\/attachment$/.exec(wiki);
        if (method === 'POST' && attPost) {
          const page = state.pages.get(attPost[1]);
          const { filename, bytes } = extractMultipartFile(init.body);
          if (options.failAttachmentUploadOnce) {
            options.failAttachmentUploadOnce = false;
            return new Response('err', { status: 500 });
          }
          if (options.raceDuplicateAttachmentOnce) {
            options.raceDuplicateAttachmentOnce = false;
            const attId = `att${++state.nextAttId}`;
            page.attachments.set(attId, { id: attId, title: filename, bytes });
            return jsonResponse(400, { message: 'already exists' });
          }
          const existing = [...page.attachments.values()].find(a => a.title === filename);
          if (existing) return jsonResponse(400, { message: 'already exists' });
          const attId = `att${++state.nextAttId}`;
          page.attachments.set(attId, { id: attId, title: filename, bytes });
          return jsonResponse(200, { results: [{ id: attId, title: filename }] });
        }

        const attDl = /^\/wiki\/rest\/api\/content\/([0-9]+)\/child\/attachment\/((?:att)?[0-9]+)\/download$/.exec(wiki);
        if (method === 'GET' && attDl) {
          const pageId = attDl[1];
          if (options.downloadRedirectByPageId?.[pageId]) {
            return new Response(null, { status: 302, headers: { Location: options.downloadRedirectByPageId[pageId] } });
          }
          const page = state.pages.get(pageId);
          const att = page?.attachments.get(attDl[2]);
          if (!att) return new Response('missing', { status: 404 });
          const bytes = options.tamperAttachmentBytesByPageId?.[pageId] ?? att.bytes;
          return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        const propList = /^\/wiki\/api\/v2\/pages\/([0-9]+)\/properties$/.exec(wiki);
        if (method === 'GET' && propList) {
          const page = state.pages.get(propList[1]);
          const key = u.searchParams.get('key');
          const all = page ? [...page.properties.values()] : [];
          const filtered = key ? all.filter(p => p.key === key) : all;
          return jsonResponse(200, { results: filtered.map(p => ({ id: p.id, key: p.key, value: p.value, version: { number: p.version } })) });
        }
        if (method === 'POST' && propList) {
          if (options.failPropertyOnce) {
            options.failPropertyOnce = false;
            return new Response('err', { status: 500 });
          }
          const page = state.pages.get(propList[1]);
          const { key, value } = JSON.parse(init.body);
          if (page.properties.has(key)) return jsonResponse(400, { message: 'property exists' });
          const id = `prop_${++state.nextPropId}`;
          page.properties.set(key, { id, key, value, version: 1 });
          return jsonResponse(200, { id, key, value, version: { number: 1 } });
        }

        const propPut = /^\/wiki\/api\/v2\/pages\/([0-9]+)\/properties\/([A-Za-z0-9_-]+)$/.exec(wiki);
        if (method === 'PUT' && propPut) {
          const page = state.pages.get(propPut[1]);
          const propId = propPut[2];
          const { key, value, version } = JSON.parse(init.body);
          const existing = [...page.properties.values()].find(p => p.id === propId);
          if (!existing) return jsonResponse(404, {});
          if (version?.number !== existing.version + 1) return jsonResponse(409, { message: 'prop conflict' });
          existing.value = value;
          existing.version = version.number;
          return jsonResponse(200, { id: existing.id, key, value, version: { number: existing.version } });
        }

        const labelPost = /^\/wiki\/rest\/api\/content\/([0-9]+)\/label$/.exec(wiki);
        if (method === 'POST' && labelPost) {
          if (options.failLabelOnce) {
            options.failLabelOnce = false;
            return new Response('err', { status: 500 });
          }
          const page = state.pages.get(labelPost[1]);
          for (const item of JSON.parse(init.body)) page.labels.add(item.name);
          return jsonResponse(200, { results: [...page.labels].map(name => ({ name })) });
        }
      }

      throw new Error(`unmocked ${method} ${u.toString()}`);
    };
  }

  return { state, calls, makeFetch, latestAttachmentState };
}

function w8Request(path, { method = 'PUT', headers = {}, body, env, fetchImpl, now = T0, origin = ORIGIN } = {}) {
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
    settings: { origins: new Set([ORIGIN]) },
    fetchImpl: fetchImpl ?? (async () => { throw new Error('unexpected fetch'); }),
    now: () => now,
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
    settings: { origins: new Set([ORIGIN]) },
    fetchImpl: fetchImpl ?? (async () => { throw new Error('unexpected fetch'); }),
    now: () => now,
  });
}

async function readRes(response) {
  const text = await response.text();
  try { return { status: response.status, headers: response.headers, json: JSON.parse(text), text }; }
  catch { return { status: response.status, headers: response.headers, json: null, text }; }
}

async function mintConfluenceOnlySession(server, { user, env = baseEnv(), now = T0, nonce = 'c'.repeat(20) } = {}) {
  const fetchImpl = server.makeFetch(user);
  const start = await readRes(await w8Request('/v1/w8/paper-auth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { nonce, returnOrigin: ORIGIN },
    env,
    fetchImpl,
    now,
  }));
  assert.equal(start.status, 200);
  const authUrl = new URL(start.json.authorizeUrl);
  const scopes = authUrl.searchParams.get('scope').split(' ');
  assert.ok(scopes.includes('read:confluence-user'));
  assert.equal(scopes.includes('read:jira-work'), false);
  assert.equal(scopes.includes('write:jira-work'), false);
  const stateToken = authUrl.searchParams.get('state');
  const cb = await readRes(await confluenceRequest(`/v1/confluence/auth/callback?code=code-${nonce.slice(0, 6)}&state=${encodeURIComponent(stateToken)}`, {
    env,
    fetchImpl,
    now,
  }));
  const posted = postedFromCallback(cb.text);
  assert.ok(posted, 'callback posted sealed session');
  return { session: posted.message.session, fetchImpl };
}

describe('W8 team paper sync (PUT /v1/w8/paper-sync)', { concurrency: false }, () => {
  test('keeps one page when a source file is renamed and links each version to its own private Drive file', async () => {
    const sql = new DatabaseSync(':memory:');
    try {
      sql.exec(readFileSync(new URL('../migrations/0010_w8_paper_titles.sql', import.meta.url), 'utf8'));
      const DB = {prepare: query => ({bind: (...values) => ({first: async () => sql.prepare(query).get(...values)})})};
      const env = baseEnv({DB});
      const server = createSharedConfluenceServer();
      const {session, fetchImpl} = await mintConfluenceOnlySession(server, {env});
      const sync = body => w8Request('/v1/w8/paper-sync', {
        env, fetchImpl, headers: {'Content-Type':'application/json', Authorization:'Bearer ' + session},
        body: {sourceSha256:SRC_A, ...body},
      }).then(readRes);
      const original = await sync({title:'Imported PDF', sourceDriveId:'PrivateOriginalId'});
      assert.equal(original.status, 201);
      const updated = await sync({title:'Renamed.pdf', revisionSha256:REV_1, revisionDriveId:'PrivateRevisedId'});
      assert.equal(updated.status, 200);
      assert.equal(original.json.pageId, updated.json.pageId);
      const page = server.state.pages.get(updated.json.pageId);
      assert.match(page.title, /^Imported PDF/);
      for (const fileId of ['PrivateOriginalId','PrivateRevisedId']) {
        assert.ok(page.body.includes('https://drive.google.com/file/d/' + fileId + '/view'));
      }
    } finally { sql.close(); }
  });

  test('uses Confluence-only OAuth (no Jira required), defaults to library parent 20512769, and honors env override', async () => {
    const server = createSharedConfluenceServer({ extraParents: [CUSTOM_PARENT] });
    const alice = await mintConfluenceOnlySession(server, { user: { accountId: 'acc-alice', displayName: 'Alice Kim' } });

    // Default parent 20512769 (even without CONFLUENCE_PARENT_PAGE_ID set)
    const envNoLegacyParent = baseEnv({ CONFLUENCE_PARENT_PAGE_ID: '' });
    const res = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.session}` },
      body: { sourceSha256: SRC_A, title: 'Reliable Evaluation of Scientific Claims', arxivId: '2401.12345v2' },
      env: envNoLegacyParent,
      fetchImpl: alice.fetchImpl,
    }));

    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.json).sort(), ['pageId', 'pageUrl']);
    assert.equal(res.json.pageUrl, `${SITE}/wiki/spaces/Falsify/pages/${res.json.pageId}/Paper`);
    const page = server.state.pages.get(res.json.pageId);
    assert.equal(page.parentId, LIBRARY_PARENT);
    assert.equal(page.spaceId, '65737');
    assert.equal(page.labels.has(W8_PAPER_SYNC_LABEL), true);
    assert.equal(page.labels.has('falsify-archive-ready'), false);
    assert.equal(page.labels.has('falsify-w8-blue-ready'), false);
    assert.equal(page.properties.get(W8_PAPER_SYNC_PROPERTY_KEY).value.sourceSha256, SRC_A);
    assert.match(page.body, /https:\/\/arxiv\.org\/abs\/2401\.12345v2/);

    // Custom env.W8_CONFLUENCE_LIBRARY_PARENT_ID works for another source digest
    const srcB = 'b'.repeat(64);
    const customRes = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.session}` },
      body: { sourceSha256: srcB, title: 'Second Paper' },
      env: baseEnv({ W8_CONFLUENCE_LIBRARY_PARENT_ID: CUSTOM_PARENT }),
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(customRes.status, 201);
    assert.equal(server.state.pages.get(customRes.json.pageId).parentId, CUSTOM_PARENT);

    // Invalid env.W8_CONFLUENCE_LIBRARY_PARENT_ID fails closed (503)
    const badParentCfg = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.session}` },
      body: { sourceSha256: SRC_A, title: 'Bad Parent Config' },
      env: baseEnv({ W8_CONFLUENCE_LIBRARY_PARENT_ID: 'not-a-number' }),
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(badParentCfg.status, 503);
    assert.equal(badParentCfg.json.error.code, 'not_configured');

    // Missing / legacy bearer rejected with 401; wrong method returns 405
    const noAuth = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers: { 'Content-Type': 'application/json' },
      body: { sourceSha256: SRC_A, title: 'No Auth' },
    }));
    assert.equal(noAuth.status, 401);

    const legacyToken = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer fss_${'x'.repeat(43)}` },
      body: { sourceSha256: SRC_A, title: 'Legacy' },
    }));
    assert.equal(legacyToken.status, 401);

    const wrongMethod = await readRes(await w8Request('/v1/w8/paper-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.session}` },
      body: { sourceSha256: SRC_A, title: 'Wrong Method' },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('Allow'), 'PUT');
  });

  test('refreshes near-expiry Confluence bearer session transparently via X-Falsify-Confluence-Session', async () => {
    const server = createSharedConfluenceServer({ tokenExpiresIn: 120 });
    const alice = await mintConfluenceOnlySession(server, { user: { accountId: 'acc-alice', displayName: 'Alice' }, now: T0 });
    // Advance clock within refresh skew (60s before 120s expiry)
    const res = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.session}` },
      body: { sourceSha256: SRC_A, title: 'Refresh Test' },
      fetchImpl: alice.fetchImpl,
      now: T0 + 90_000,
    }));
    assert.equal(res.status, 201);
    assert.ok(res.headers.get(SESSION_HEADER), 'refreshed session header propagated');
  });

  test('incrementally merges source, revisions, and BLUE runs with idempotent zero-write retries and zero duplicates', async () => {
    const server = createSharedConfluenceServer();
    const alice = await mintConfluenceOnlySession(server, { user: { accountId: 'acc-alice', displayName: 'Alice' } });
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.session}` };

    // 1. Source only
    const r1 = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers,
      body: { sourceSha256: SRC_A, title: 'Benchmark Audit', arxivId: 'arXiv:2405.00001' },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(r1.status, 201);
    const pageId = r1.json.pageId;
    assert.equal(server.state.pages.size, 1);

    // 2. Add revision without resending arxivId
    const r2 = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers,
      body: { sourceSha256: SRC_A, title: 'Benchmark Audit', revisionSha256: REV_1 },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(r2.status, 200);
    assert.equal(r2.json.pageId, pageId);

    // 3. Add BLUE run-1 with finding F1
    const f1 = { quote: 'Table 2 shows 94.2%', rationale: 'Recalculation yields 84.2%', severity: 'major', verdict: '확인필요' };
    const r3 = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers,
      body: {
        sourceSha256: SRC_A,
        title: 'Benchmark Audit',
        revisionSha256: REV_1,
        runs: [{ id: 'run-1', model: 'claude-sonnet-5-5', findings: [f1] }],
      },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(r3.status, 200);
    assert.equal(r3.json.pageId, pageId);

    // 4. Add BLUE run-2 on REV_2 (without resending run-1 or REV_1)
    const f2 = { quote: 'Figure 3 red curve rises', rationale: 'Axis labels are swapped', severity: 'minor', verdict: '확인필요' };
    const r4 = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers,
      body: {
        sourceSha256: SRC_A,
        title: 'Benchmark Audit',
        revisionSha256: REV_2,
        runs: [{ id: 'run-2', model: 'gpt-5.5', findings: [f2, f2] }], // intentional duplicate finding in same payload
      },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(r4.status, 200);

    const page = server.state.pages.get(pageId);
    const stateAfter4 = server.latestAttachmentState(page);
    assert.equal(stateAfter4.schema, W8_PAPER_SYNC_SCHEMA);
    assert.equal(stateAfter4.arxivId, '2405.00001', 'arxivId preserved when later syncs omit it');
    assert.deepEqual(stateAfter4.revisions.map(r => r.revisionSha256), [REV_1, REV_2]);
    assert.equal(stateAfter4.runs.length, 2);
    assert.equal(stateAfter4.runs.find(r => r.id === 'run-2').findings.length, 1, 'in-payload duplicate finding deduplicated');

    // 5. Exact retry of r4 performs ZERO upstream writes
    const writesBefore = server.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length;
    const versionBefore = page.version;
    const r5 = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers,
      body: {
        sourceSha256: SRC_A,
        title: 'Benchmark Audit',
        revisionSha256: REV_2,
        runs: [{ id: 'run-2', model: 'gpt-5.5', findings: [f2] }],
      },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(r5.status, 200);
    assert.equal(r5.json.pageId, pageId);
    assert.equal(page.version, versionBefore, 'no new page version on identical retry');
    assert.equal(server.calls.filter(c => c.method === 'POST' || c.method === 'PUT').length, writesBefore, 'zero extra writes on identical retry');

    // 6. Incremental update to run-1 adds f3 while preserving f1 without duplicating f1
    const f3 = { quote: 'p < 0.001', rationale: 'Sample size n=4 cannot reach p<0.001', severity: 'critical', verdict: '확인필요' };
    const r6 = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers,
      body: {
        sourceSha256: SRC_A,
        title: 'Benchmark Audit',
        revisionSha256: REV_1,
        runs: [{ id: 'run-1', findings: [f1, f3] }],
      },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(r6.status, 200);
    const stateAfter6 = server.latestAttachmentState(page);
    const mergedRun1 = stateAfter6.runs.find(r => r.id === 'run-1');
    assert.equal(mergedRun1.model, 'claude-sonnet-5-5', 'previous model preserved when omitted');
    assert.equal(mergedRun1.findings.length, 2);
  });

  test('preserves other contributors and resolves concurrent 409 update/create conflicts without loss or duplicates', async () => {
    let injectConflictOnce = false;
    let aliceRef = null;
    const server = createSharedConfluenceServer({
      beforePagePut: async () => {
        if (!injectConflictOnce) return null;
        injectConflictOnce = false;
        // While Bob is trying to commit his version, Alice commits a newer run first!
        const concurrent = await readRes(await w8Request('/v1/w8/paper-sync', {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceRef.session}` },
          body: {
            sourceSha256: SRC_A,
            title: 'Joint Paper',
            revisionSha256: REV_1,
            runs: [{ id: 'run-concurrent-alice', model: 'claude-opus-5-5', findings: [{ quote: 'Alice concurrent quote', rationale: 'Alice check', severity: 'major', verdict: '확인필요' }] }],
          },
          fetchImpl: aliceRef.fetchImpl,
        }));
        assert.equal(concurrent.status, 200);
        // Now Bob's PUT proceeds with his stale version number -> server returns 409!
        return null;
      },
    });

    const alice = await mintConfluenceOnlySession(server, { user: { accountId: 'acc-alice', displayName: 'Alice' }, nonce: 'a'.repeat(20) });
    const bob = await mintConfluenceOnlySession(server, { user: { accountId: 'acc-bob', displayName: 'Bob' }, nonce: 'b'.repeat(20) });
    aliceRef = alice;

    // Alice initializes page with local run id 'run-1'
    const a1 = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.session}` },
      body: {
        sourceSha256: SRC_A,
        title: 'Joint Paper',
        arxivId: '2402.54321',
        revisionSha256: REV_1,
        runs: [{ id: 'run-1', model: 'claude-sonnet-5-5', findings: [{ quote: 'Alice finding', rationale: 'A rationale', severity: 'major', verdict: '확인필요' }] }],
      },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(a1.status, 201);

    // Bob syncs with the SAME local run id 'run-1' while a 409 conflict happens mid-flight!
    injectConflictOnce = true;
    const b1 = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.session}` },
      body: {
        sourceSha256: SRC_A,
        title: 'Joint Paper (Bob local title)',
        revisionSha256: REV_2,
        runs: [{ id: 'run-1', model: 'gpt-5.5', findings: [{ quote: 'Bob finding', rationale: 'B rationale', severity: 'minor', verdict: '확인필요' }] }],
      },
      fetchImpl: bob.fetchImpl,
    }));
    assert.equal(b1.status, 200);
    assert.equal(b1.json.pageId, a1.json.pageId);
    assert.equal(server.state.pages.size, 1, 'single child page per source digest');

    const page = server.state.pages.get(a1.json.pageId);
    const merged = server.latestAttachmentState(page);
    assert.equal(Object.keys(merged.contributors).length, 2, 'both contributors preserved');
    assert.equal(merged.arxivId, '2402.54321', 'Alice arxivId preserved');
    assert.equal(merged.title, 'Joint Paper', 'primary title preserved');
    assert.match(page.body, /Joint Paper \(Bob local title\)/, 'Bob alternate title preserved in summary');
    assert.deepEqual(merged.revisions.map(r => r.revisionSha256), [REV_1, REV_2]);
    assert.equal(merged.runs.length, 3, 'Alice initial, Alice concurrent, and Bob run-1 all preserved without loss');
    assert.ok(merged.runs.some(r => r.id === 'run-1' && r.findings[0].quote === 'Alice finding'));
    assert.ok(merged.runs.some(r => r.id === 'run-concurrent-alice' && r.findings[0].quote === 'Alice concurrent quote'));
    assert.ok(merged.runs.some(r => r.id === 'run-1' && r.findings[0].quote === 'Bob finding'));

    // Concurrent page-create race on a brand-new paper digest
    const srcC = 'c'.repeat(64);
    let injectCreateRace = true;
    const raceServer = createSharedConfluenceServer({
      beforePageCreate: async () => {
        if (!injectCreateRace) return null;
        injectCreateRace = false;
        // Alice wins the create before Bob's POST lands
        const winner = await readRes(await w8Request('/v1/w8/paper-sync', {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice2.session}` },
          body: { sourceSha256: srcC, title: 'Race Paper', runs: [{ id: 'a-run', findings: [{ quote: 'Q-A', rationale: 'R-A', severity: 'major', verdict: '확인필요' }] }] },
          fetchImpl: alice2.fetchImpl,
        }));
        assert.equal(winner.status, 201);
        return null; // Bob's POST now hits duplicate title -> 409!
      },
    });
    const alice2 = await mintConfluenceOnlySession(raceServer, { user: { accountId: 'acc-alice', displayName: 'Alice' }, nonce: 'd'.repeat(20) });
    const bob2 = await mintConfluenceOnlySession(raceServer, { user: { accountId: 'acc-bob', displayName: 'Bob' }, nonce: 'e'.repeat(20) });

    const bobRace = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob2.session}` },
      body: { sourceSha256: srcC, title: 'Race Paper', runs: [{ id: 'b-run', findings: [{ quote: 'Q-B', rationale: 'R-B', severity: 'minor', verdict: '확인필요' }] }] },
      fetchImpl: bob2.fetchImpl,
    }));
    assert.equal(bobRace.status, 200);
    assert.equal(raceServer.state.pages.size, 1);
    const raceState = raceServer.latestAttachmentState(raceServer.state.pages.get(bobRace.json.pageId));
    assert.equal(raceState.runs.length, 2, 'both create-race contributors preserved');
  });

  test('recovers cleanly from mid-write failures (pending page, attachment duplicate race, and post-commit property/label failure)', async () => {
    const server = createSharedConfluenceServer({ failAttachmentUploadOnce: true });
    const alice = await mintConfluenceOnlySession(server, { user: { accountId: 'acc-alice', displayName: 'Alice' } });
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.session}` };
    const payload = {
      sourceSha256: SRC_A,
      title: 'Recovery Paper',
      runs: [{ id: 'r1', model: 'claude-sonnet-5-5', findings: [{ quote: 'Q1', rationale: 'R1', severity: 'major', verdict: '확인필요' }] }],
    };

    // Attempt 1 fails on attachment upload -> pending page exists, returns 409 write_unknown with pageId
    const first = await readRes(await w8Request('/v1/w8/paper-sync', { headers, body: payload, fetchImpl: alice.fetchImpl }));
    assert.equal(first.status, 409);
    assert.equal(first.json.error.code, 'write_unknown');
    assert.equal(first.json.readBack, true);
    assert.ok(first.json.pageId);
    assert.equal(server.state.pages.size, 1);

    // Attempt 2 recovers the pending page cleanly (even with a concurrent identical attachment race!)
    const serverOpts = { raceDuplicateAttachmentOnce: true, failLabelOnce: true };
    const server2 = createSharedConfluenceServer(serverOpts);
    const alice2 = await mintConfluenceOnlySession(server2, { user: { accountId: 'acc-alice', displayName: 'Alice' } });
    const headers2 = { 'Content-Type': 'application/json', Authorization: `Bearer ${alice2.session}` };

    // Label fails after page PUT committed
    const labelFail = await readRes(await w8Request('/v1/w8/paper-sync', { headers: headers2, body: payload, fetchImpl: alice2.fetchImpl }));
    assert.equal(labelFail.status, 409);
    assert.equal(labelFail.json.error.code, 'write_unknown');
    const committedPage = server2.state.pages.get(labelFail.json.pageId);
    const committedVersion = committedPage.version;
    assert.equal(committedPage.labels.has(W8_PAPER_SYNC_LABEL), false);

    // Retry finishes label without creating a duplicate version or duplicate runs
    const recovered = await readRes(await w8Request('/v1/w8/paper-sync', { headers: headers2, body: payload, fetchImpl: alice2.fetchImpl }));
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json.pageId, labelFail.json.pageId);
    assert.equal(committedPage.version, committedVersion, 'no redundant page version on post-commit recovery');
    assert.equal(committedPage.labels.has(W8_PAPER_SYNC_LABEL), true);
    assert.equal(server2.latestAttachmentState(committedPage).runs.length, 1);

    // Also finish recovery on server 1
    const recovered1 = await readRes(await w8Request('/v1/w8/paper-sync', { headers, body: payload, fetchImpl: alice.fetchImpl }));
    assert.equal(recovered1.status, 200);
    assert.equal(recovered1.json.pageId, first.json.pageId);
    assert.equal(server.state.pages.size, 1);
  });

  test('enforces confinement and refuses to overwrite non-app-owned pages or manually edited bodies', async () => {
    // 1. Restricted library parent fails before any write
    const restrictedServer = createSharedConfluenceServer({ restrictionById: { [LIBRARY_PARENT]: 'VIEW_RESTRICTED' } });
    const aliceR = await mintConfluenceOnlySession(restrictedServer, { user: { accountId: 'acc-alice' } });
    const restricted = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceR.session}` },
      body: { sourceSha256: SRC_A, title: 'Restricted Parent' },
      fetchImpl: aliceR.fetchImpl,
    }));
    assert.equal(restricted.status, 403);
    assert.equal(restricted.json.error.code, 'parent_not_allowed');
    assert.equal(restrictedServer.state.pages.size, 0);

    // 2. Parent outside fixed Falsify space fails before any write
    const wrongSpaceServer = createSharedConfluenceServer({ parentSpaceById: { [LIBRARY_PARENT]: '99999' } });
    const aliceW = await mintConfluenceOnlySession(wrongSpaceServer, { user: { accountId: 'acc-alice' } });
    const wrongSpace = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceW.session}` },
      body: { sourceSha256: SRC_A, title: 'Wrong Space Parent' },
      fetchImpl: aliceW.fetchImpl,
    }));
    assert.equal(wrongSpace.status, 403);
    assert.equal(wrongSpace.json.error.code, 'parent_not_allowed');
    assert.equal(wrongSpaceServer.state.pages.size, 0);

    // 3. Human-created page with same title is never overwritten
    const server = createSharedConfluenceServer();
    const alice = await mintConfluenceOnlySession(server, { user: { accountId: 'acc-alice', displayName: 'Alice' } });
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.session}` };
    const humanPageId = '55501';
    const humanBody = '<p>Hand-written team notes — do not overwrite!</p>';
    server.state.pages.set(humanPageId, {
      id: humanPageId,
      title: paperSyncPageTitle(SRC_A),
      parentId: LIBRARY_PARENT,
      spaceId: '65737',
      version: 3,
      body: humanBody,
      attachments: new Map(),
      properties: new Map(),
      labels: new Set(),
    });
    const conflictHuman = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers,
      body: { sourceSha256: SRC_A, title: 'Should Not Clobber' },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(conflictHuman.status, 409);
    assert.equal(conflictHuman.json.error.code, 'archive_conflict');
    assert.equal(server.state.pages.get(humanPageId).body, humanBody);
    assert.equal(server.state.pages.get(humanPageId).version, 3);

    // 4. App-owned page manually edited outside app markers is never overwritten
    const srcEdit = 'e'.repeat(64);
    const created = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers,
      body: { sourceSha256: srcEdit, title: 'Owned Page' },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(created.status, 201);
    const ownedPage = server.state.pages.get(created.json.pageId);
    const editedBody = ownedPage.body + '<p>Manual team commentary appended by human.</p>';
    ownedPage.body = editedBody;
    ownedPage.version += 1;

    const conflictEdited = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers,
      body: { sourceSha256: srcEdit, title: 'Owned Page', revisionSha256: REV_1 },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(conflictEdited.status, 409);
    assert.equal(conflictEdited.json.error.code, 'archive_conflict');
    assert.equal(ownedPage.body, editedBody, 'manually edited body left untouched');

    // 5. Same title under a DIFFERENT parent is rejected
    const srcOtherParent = 'f'.repeat(64);
    server.state.pages.set('55502', {
      id: '55502',
      title: paperSyncPageTitle(srcOtherParent),
      parentId: LEGACY_PARENT,
      spaceId: '65737',
      version: 1,
      body: `<p><code>[falsify-w8-paper-sync:v1:start source=${srcOtherParent} state=pending]</code></p><p><code>[falsify-w8-paper-sync:v1:end source=${srcOtherParent} state=pending]</code></p>`,
      attachments: new Map(),
      properties: new Map(),
      labels: new Set(),
    });
    const wrongParent = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers,
      body: { sourceSha256: srcOtherParent, title: 'Wrong Parent' },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(wrongParent.status, 409);
    assert.equal(wrongParent.json.error.code, 'archive_conflict');
  });

  test('blocks raw PDF, private AI/Drive links, and RED content before any write, and HTML-escapes rendered body', async () => {
    const server = createSharedConfluenceServer();
    const alice = await mintConfluenceOnlySession(server, {
      user: { accountId: 'acc-alice', displayName: 'Alice <img src=x onerror=alert(1)>' },
    });
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.session}` };

    const forbiddenPayloads = [
      { sourceSha256: SRC_A, title: 'PDF key', pdfBytes: 'abc' },
      { sourceSha256: SRC_A, title: 'Raw PDF magic', runs: [{ id: 'r1', findings: [{ quote: '%PDF-1.7 binary' }] }] },
      { sourceSha256: SRC_A, title: 'PDF base64', runs: [{ id: 'r1', findings: [{ rationale: 'JVBERi0xLjcK...' }] }] },
      { sourceSha256: SRC_A, title: 'Temp link', runs: [{ id: 'r1', findings: [{ rationale: 'See https://api.example/v1/w8/paper-links/0123456789abcdef0123456789abcdef.pdf' }] }] },
      { sourceSha256: SRC_A, title: 'Drive link', runs: [{ id: 'r1', findings: [{ rationale: 'https://drive.google.com/file/d/secret123/view' }] }] },
      { sourceSha256: SRC_A, title: 'Private AI runtime', runs: [{ id: 'r1', findings: [{ rationale: 'https://falsify-runtime.shinick.dev/production/job/1' }] }] },
      { sourceSha256: SRC_A, title: 'Signed URL', runs: [{ id: 'r1', findings: [{ rationale: 'https://storage.example/paper.pdf?token=secret123' }] }] },
      { sourceSha256: SRC_A, title: 'RED key', redRuns: [{ id: 'red-1' }] },
      { sourceSha256: SRC_A, title: 'Gold key', gold: [{ id: 'g1' }] },
      { sourceSha256: SRC_A, title: 'RED role', runs: [{ id: 'r1', role: 'red', findings: [] }] },
      { sourceSha256: SRC_A, title: 'Private link key', paperLinkUrl: 'https://example.com/a.pdf' },
    ];

    for (const bad of forbiddenPayloads) {
      const res = await readRes(await w8Request('/v1/w8/paper-sync', {
        headers,
        body: bad,
        fetchImpl: alice.fetchImpl,
      }));
      assert.equal(res.status, 422, `expected 422 for ${bad.title}`);
      assert.equal(res.json.error.code, 'forbidden_content');
    }
    assert.equal(server.state.pages.size, 0, 'no page created on forbidden content');

    // XSS / HTML injection is strictly sanitized in rendered XHTML body
    const xssPayload = {
      sourceSha256: SRC_A,
      title: 'Paper <script>alert("xss")</script> & "Quotes"',
      runs: [{
        id: 'run-<1>',
        model: 'model-"x"',
        findings: [{
          quote: '<svg onload=alert(1)> & 10% < 20%',
          rationale: 'Table says "10%" > 5% & red curve dips',
          severity: '<b>major</b>',
          verdict: '<script>bad</script>',
        }],
      }],
    };
    const ok = await readRes(await w8Request('/v1/w8/paper-sync', {
      headers,
      body: xssPayload,
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(ok.status, 201);
    const body = server.state.pages.get(ok.json.pageId).body;
    assert.equal(body.includes('<script>'), false);
    assert.equal(body.includes('<svg'), false);
    assert.equal(body.includes('<img'), false);
    assert.equal(body.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), true);
    assert.equal(body.includes('&lt;svg onload=alert(1)&gt;'), true);
    assert.equal(body.includes('Alice &lt;img src=x onerror=alert(1)&gt;'), true);
  });

  test('worker fetch routes PUT /v1/w8/paper-sync with strict CORS, PUT preflight, and redacted logs', async () => {
    const server = createSharedConfluenceServer();
    const alice = await mintConfluenceOnlySession(server, {
      user: { accountId: 'acc-alice', displayName: 'Alice' },
      now: Date.now(),
    });
    const lines = [];
    const origLog = console.log;
    const origErr = console.error;
    const origFetch = globalThis.fetch;
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    globalThis.fetch = alice.fetchImpl;
    try {
      const env = baseEnv();
      const forbiddenOrigin = await worker.fetch(new Request('https://worker.example/v1/w8/paper-sync', {
        method: 'PUT',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceSha256: SRC_A, title: 'Nope' }),
      }), env);
      assert.equal(forbiddenOrigin.status, 403);
      assert.equal(forbiddenOrigin.headers.get('access-control-allow-origin'), null);

      const preflight = await worker.fetch(new Request('https://worker.example/v1/w8/paper-sync', {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT' },
      }), env);
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
      assert.match(preflight.headers.get('access-control-allow-methods') || '', /\bPUT\b/);

      const synced = await worker.fetch(new Request('https://worker.example/v1/w8/paper-sync', {
        method: 'PUT',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${alice.session}` },
        body: JSON.stringify({
          sourceSha256: SRC_A,
          title: 'Worker Routed Paper',
          runs: [{ id: 'r1', findings: [{ quote: 'SENSITIVE_QUOTE_TEXT', rationale: 'Check', severity: 'major', verdict: '확인필요' }] }],
        }),
      }), env);
      assert.equal(synced.status, 201);
      assert.equal(synced.headers.get('access-control-allow-origin'), ORIGIN);
      const payload = await synced.json();
      assert.ok(payload.pageId);
      assert.ok(payload.pageUrl.startsWith(`${SITE}/wiki/`));
    } finally {
      console.log = origLog;
      console.error = origErr;
      globalThis.fetch = origFetch;
    }

    const joined = lines.join('\n');
    assert.match(joined, /"route":"\/v1\/w8\/paper-sync"/);
    assert.equal(joined.includes(SECRET), false);
    assert.equal(joined.includes('conf-access-'), false);
    assert.equal(joined.includes('SENSITIVE_QUOTE_TEXT'), false);
  });
});

function seedReadyPaperPage(server, {
  pageId,
  parentId = LIBRARY_PARENT,
  spaceId = '65737',
  sourceSha256,
  title,
  pageTitle = paperSyncPageTitle(sourceSha256),
  arxivId = null,
  arxivIds = null,
  driveFiles = null,
  runs = [],
  legacyMarkers = false,
  manualNote = '',
  omitPropTitle = false,
  ready = true,
  labeled = true,
  extraLabels = [],
  extraProps = [],
  status = 'current',
  overrideBodyStateToken = null,
  omitAttachment = false,
  extraState = {},
} = {}) {
  const stateObj = {
    schema: W8_PAPER_SYNC_SCHEMA,
    sourceSha256,
    title,
    titleAuthor: 'atl:0123456789abcdef',
    arxivId,
    arxivIds: arxivIds ?? (arxivId ? [arxivId] : []),
    contributors: { 'atl:0123456789abcdef': { label: 'Alice', title, arxivId, revisions: [] } },
    ...(driveFiles ? { driveFiles } : {}),
    revisions: [],
    runs,
    ...extraState,
  };
  const stateBytes = Buffer.from(canonicalJson(stateObj), 'utf8');
  const stateSha = sha256(stateBytes);
  const bodyToken = overrideBodyStateToken ?? stateSha;
  const startMarker = `[falsify-w8-paper-sync:v1:start source=${sourceSha256} state=${bodyToken}]`;
  const endMarker = `[falsify-w8-paper-sync:v1:end source=${sourceSha256} state=${bodyToken}]`;
  const body = legacyMarkers
    ? `<p><code>${startMarker}</code></p><h1>${title}</h1><p><code>${endMarker}</code></p>${manualNote}`
    : `<ac:structured-macro ac:name="anchor" ac:schema-version="1"><ac:parameter ac:name="">${startMarker}</ac:parameter></ac:structured-macro><h1>${title}</h1><ac:structured-macro ac:name="anchor" ac:schema-version="1"><ac:parameter ac:name="">${endMarker}</ac:parameter></ac:structured-macro>${manualNote}`;
  const attachments = new Map();
  if (!omitAttachment) {
    const attId = `att${++server.state.nextAttId}`;
    attachments.set(attId, { id: attId, title: `${stateSha}.json`, bytes: stateBytes });
  }
  const properties = new Map();
  const propValue = {
    schema: W8_PAPER_SYNC_SCHEMA,
    kind: W8_PAPER_SYNC_KIND,
    sourceSha256,
    ...(omitPropTitle ? {} : { title }),
    stateSha256: stateSha,
    ready,
  };
  properties.set(W8_PAPER_SYNC_PROPERTY_KEY, {
    id: `prop_${++server.state.nextPropId}`,
    key: W8_PAPER_SYNC_PROPERTY_KEY,
    value: propValue,
    version: 1,
  });
  for (const extra of extraProps) {
    properties.set(extra.key, {
      id: `prop_${++server.state.nextPropId}`,
      key: extra.key,
      value: extra.value,
      version: 1,
    });
  }
  const labels = new Set([...(labeled ? [W8_PAPER_SYNC_LABEL] : []), ...extraLabels]);
  const page = {
    id: String(pageId),
    title: pageTitle,
    parentId: String(parentId),
    spaceId: String(spaceId),
    status,
    version: 2,
    body,
    attachments,
    properties,
    labels,
  };
  server.state.pages.set(String(pageId), page);
  return { page, stateObj, stateSha, stateBytes };
}

async function mintReadOnlyConfluenceSession(server, { env = baseEnv(), now = T0, nonce = 'r'.repeat(20) } = {}) {
  const readOnlyScopes = [
    'offline_access',
    'read:space:confluence',
    'read:page:confluence',
    'read:content.metadata:confluence',
    'read:attachment:confluence',
    'readonly:content.attachment:confluence',
  ];
  const baseFetch = server.makeFetch({ accountId: 'acc-reader', displayName: 'Reader' });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'auth.atlassian.com' && u.pathname === '/oauth/token') {
      return jsonResponse(200, {
        access_token: 'conf-readonly-access-1',
        refresh_token: 'conf-readonly-refresh-1',
        expires_in: 3600,
        scope: readOnlyScopes.join(' '),
      });
    }
    if (u.pathname === '/oauth/token/accessible-resources') {
      return jsonResponse(200, [{ id: CLOUD, url: SITE, scopes: readOnlyScopes }]);
    }
    return baseFetch(url, init);
  };
  const start = await readRes(await confluenceRequest('/v1/confluence/auth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { nonce, returnOrigin: ORIGIN },
    env,
    fetchImpl,
    now,
  }));
  assert.equal(start.status, 200);
  const authUrl = new URL(start.json.authorizeUrl);
  const stateToken = authUrl.searchParams.get('state');
  const cb = await readRes(await confluenceRequest(`/v1/confluence/auth/callback?code=ro-code-1234&state=${encodeURIComponent(stateToken)}`, {
    env,
    fetchImpl,
    now,
  }));
  const posted = postedFromCallback(cb.text);
  assert.ok(posted, 'callback posted read-only Confluence session');
  return { session: posted.message.session, fetchImpl };
}

describe('W8 team paper library reads (GET /v1/w8/papers)', { concurrency: false }, () => {
  test('lists ready W8 papers including legacy RAGAS and read-only pages, filters mixed siblings, and returns verified details without raw state/PDFs/grants', async () => {
    const ragasSha = '11'.repeat(32);
    const readOnlySha = '22'.repeat(32);
    const annotatedSha = '33'.repeat(32);
    const pendingSha = '44'.repeat(32);
    const restrictedSha = '55'.repeat(32);
    const forbiddenChildSha = '66'.repeat(32);
    const draftSha = '77'.repeat(32);
    const otherParentSha = '88'.repeat(32);
    const wrongSpaceSha = '99'.repeat(32);
    const mixedMarkerSha = 'aa'.repeat(32);

    const server = createSharedConfluenceServer({
      extraParents: [CUSTOM_PARENT],
      restrictionById: {
        '41002': 'EDIT_RESTRICTED',
        '41006': 'VIEW_RESTRICTED',
      },
      pageStatusById: {
        '41007': 403,
      },
      extraChildrenByParent: {
        [LIBRARY_PARENT]: [{ id: '41099', parentId: LIBRARY_PARENT, type: 'folder', status: 'current', title: 'Subfolder' }],
      },
    });
    const writer = await mintConfluenceOnlySession(server, { user: { accountId: 'acc-alice', displayName: 'Alice' } });
    const reader = await mintReadOnlyConfluenceSession(server);

    // 1. Modern paper synced via PUT /v1/w8/paper-sync with D1 human title, Drive IDs, and BLUE runs
    const sql = new DatabaseSync(':memory:');
    let syncedPageId;
    try {
      sql.exec(readFileSync(new URL('../migrations/0010_w8_paper_titles.sql', import.meta.url), 'utf8'));
      const DB = { prepare: query => ({ bind: (...values) => ({ first: async () => sql.prepare(query).get(...values) }) }) };
      const syncEnv = baseEnv({ DB });
      const synced = await readRes(await w8Request('/v1/w8/paper-sync', {
        method: 'PUT',
        env: syncEnv,
        fetchImpl: writer.fetchImpl,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${writer.session}` },
        body: {
          sourceSha256: SRC_A,
          title: 'Modern Drive Paper',
          sourceDriveId: 'DriveOriginalFile01',
          revisionSha256: REV_1,
          revisionDriveId: 'DriveRevisionFile02',
          runs: [{ id: 'run-secret', model: 'gemini-4-neon-high', findings: [{ quote: 'PRIVATE_FINDING_QUOTE', rationale: 'Check table', severity: 'major', verdict: '확인필요' }] }],
        },
      }));
      assert.equal(synced.status, 201);
      syncedPageId = synced.json.pageId;
    } finally {
      sql.close();
    }

    // 2. Existing legacy RAGAS page (old title format, legacy <p><code> markers, arxivId, no driveFiles)
    seedReadyPaperPage(server, {
      pageId: '41001',
      sourceSha256: ragasSha,
      title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
      pageTitle: paperSyncPageTitle(ragasSha),
      arxivId: '2309.15217',
      legacyMarkers: true,
      runs: [{ key: 'atl:0123456789abcdef::source::r1', id: 'r1', contributor: 'atl:0123456789abcdef', revisionSha256: null, model: 'claude-sonnet-5-5', findings: [{ quote: 'RAGAS_INTERNAL_QUOTE', rationale: 'R', severity: 'minor', verdict: 'ok' }] }],
    });

    // 3. Read-only (EDIT_RESTRICTED) W8 paper page with arxivIds fallback
    seedReadyPaperPage(server, {
      pageId: '41002',
      sourceSha256: readOnlySha,
      title: 'Read-Only Paper',
      pageTitle: `Read-Only Paper · ${readOnlySha.slice(0, 16)}`,
      arxivId: null,
      arxivIds: ['2401.12345v2'],
      driveFiles: { [readOnlySha]: 'ReadOnlyDriveFile03' },
    });

    // 4. Ready paper with human manual note appended outside markers (still readable via verified state attachment)
    seedReadyPaperPage(server, {
      pageId: '41003',
      sourceSha256: annotatedSha,
      title: 'Manually Annotated Paper',
      manualNote: '<p>Team discussion note added in Confluence.</p>',
    });

    // 5. Mixed sibling pages under the same library parent that MUST be excluded from list & rejected on detail
    // 5a. Pending / unfinished W8 paper (no label, ready: false)
    seedReadyPaperPage(server, {
      pageId: '41004',
      sourceSha256: pendingSha,
      title: 'Pending Paper',
      ready: false,
      labeled: false,
      overrideBodyStateToken: 'pending',
    });
    // 5b. Human note page
    server.state.pages.set('41005', {
      id: '41005',
      title: 'Meeting Notes',
      parentId: LIBRARY_PARENT,
      spaceId: '65737',
      status: 'current',
      version: 1,
      body: '<p>Human notes</p>',
      attachments: new Map(),
      properties: new Map(),
      labels: new Set(),
    });
    // 5c. View-restricted W8 paper
    seedReadyPaperPage(server, { pageId: '41006', sourceSha256: restrictedSha, title: 'View Restricted Paper' });
    // 5d. Child returning 403 on GET /pages/{id}
    seedReadyPaperPage(server, { pageId: '41007', sourceSha256: forbiddenChildSha, title: 'Forbidden Child Paper' });
    // 5e. Standard archive page (falsify-archive-ready)
    server.state.pages.set('41008', {
      id: '41008',
      title: 'Falsify experiment archive',
      parentId: LIBRARY_PARENT,
      spaceId: '65737',
      status: 'current',
      version: 1,
      body: '<p>Archive</p>',
      attachments: new Map(),
      properties: new Map([['falsify-archive', { id: 'p_a', key: 'falsify-archive', value: { kind: 'experiment', ready: true }, version: 1 }]]),
      labels: new Set(['falsify-archive-ready']),
    });
    // 5f. W8 Stage 2 BLUE archive page (falsify-w8-blue-ready)
    server.state.pages.set('41009', {
      id: '41009',
      title: 'Falsify w8-blue archive',
      parentId: LIBRARY_PARENT,
      spaceId: '65737',
      status: 'current',
      version: 1,
      body: '<p>W8 BLUE</p>',
      attachments: new Map(),
      properties: new Map([['falsify-w8-archive', { id: 'p_b', key: 'falsify-w8-archive', value: { kind: 'w8-blue', ready: true }, version: 1 }]]),
      labels: new Set(['falsify-w8-blue-ready', 'falsify-w8-blue']),
    });
    // 5g. Conflicting mixed-marker page
    seedReadyPaperPage(server, {
      pageId: '41010',
      sourceSha256: mixedMarkerSha,
      title: 'Conflicting Marker Paper',
      extraLabels: ['falsify-archive-ready'],
    });
    // 5h. Draft status page
    seedReadyPaperPage(server, { pageId: '41011', sourceSha256: draftSha, title: 'Draft Paper', status: 'draft' });
    // 5i. Ready paper under LEGACY_PARENT (different parent) and wrong space
    seedReadyPaperPage(server, { pageId: '41012', parentId: LEGACY_PARENT, sourceSha256: otherParentSha, title: 'Other Parent Paper' });
    seedReadyPaperPage(server, { pageId: '41013', parentId: LIBRARY_PARENT, spaceId: '99999', sourceSha256: wrongSpaceSha, title: 'Wrong Space Paper' });

    const callsBefore = server.calls.length;
    const readEnv = baseEnv({
      CONFLUENCE_PARENT_PAGE_ID: '',
      DB: { prepare() { throw new Error('GET /v1/w8/papers must not touch D1'); } },
    });
    const listRes = await readRes(await w8Request('/v1/w8/papers', {
      method: 'GET',
      env: readEnv,
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(listRes.status, 200);
    assert.deepEqual(Object.keys(listRes.json).sort(), ['items', 'nextCursor']);
    assert.equal(listRes.json.nextCursor, null);
    assert.deepEqual(listRes.json.items.map(i => i.pageId), [syncedPageId, '41001', '41002', '41003']);
    for (const item of listRes.json.items) {
      assert.deepEqual(Object.keys(item).sort(), ['pageId', 'pageUrl', 'sourceSha256', 'title']);
      assert.ok(item.pageUrl.startsWith(`${SITE}/wiki/`));
    }
    const ragasItem = listRes.json.items.find(i => i.pageId === '41001');
    assert.equal(ragasItem.title, 'Ragas: Automated Evaluation of Retrieval Augmented Generation');
    assert.equal(ragasItem.sourceSha256, ragasSha);
    assert.equal(listRes.text.includes('PRIVATE_FINDING_QUOTE'), false);
    assert.equal(listRes.text.includes('RAGAS_INTERNAL_QUOTE'), false);
    assert.equal(listRes.text.includes('DriveOriginalFile01'), false);
    assert.equal(listRes.text.includes('conf-readonly-'), false);

    // Detail: legacy RAGAS paper
    const ragasDetail = await readRes(await w8Request('/v1/w8/papers?pageId=41001', {
      method: 'GET',
      env: readEnv,
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(ragasDetail.status, 200);
    assert.deepEqual(ragasDetail.json, {
      pageId: '41001',
      pageUrl: `${SITE}/wiki/spaces/Falsify/pages/41001/Paper`,
      title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
      sourceSha256: ragasSha,
      arxivId: '2309.15217',
      sourceDriveId: null,
    });
    assert.equal(ragasDetail.text.includes('RAGAS_INTERNAL_QUOTE'), false);

    // Detail: modern Drive-linked paper (returns sourceDriveId only, never revisionDriveId or runs)
    const modernDetail = await readRes(await w8Request(`/v1/w8/papers?pageId=${syncedPageId}`, {
      method: 'GET',
      env: readEnv,
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(modernDetail.status, 200);
    assert.deepEqual(modernDetail.json, {
      pageId: syncedPageId,
      pageUrl: `${SITE}/wiki/spaces/Falsify/pages/${syncedPageId}/Paper`,
      title: 'Modern Drive Paper',
      sourceSha256: SRC_A,
      arxivId: null,
      sourceDriveId: 'DriveOriginalFile01',
    });
    assert.equal(modernDetail.text.includes('DriveRevisionFile02'), false);
    assert.equal(modernDetail.text.includes('PRIVATE_FINDING_QUOTE'), false);

    // Detail: read-only EDIT_RESTRICTED paper & manually-annotated paper both succeed
    const roDetail = await readRes(await w8Request('/v1/w8/papers?pageId=41002', {
      method: 'GET',
      env: readEnv,
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(roDetail.status, 200);
    assert.equal(roDetail.json.arxivId, '2401.12345v2');
    assert.equal(roDetail.json.sourceDriveId, 'ReadOnlyDriveFile03');

    const annotatedDetail = await readRes(await w8Request('/v1/w8/papers?pageId=41003', {
      method: 'GET',
      env: readEnv,
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(annotatedDetail.status, 200);
    assert.equal(annotatedDetail.json.title, 'Manually Annotated Paper');
    assert.equal(annotatedDetail.json.arxivId, null);
    assert.equal(annotatedDetail.json.sourceDriveId, null);

    // Detail: non-ready, mixed, draft, other-parent, wrong-space, missing -> 404 (no attachment download!)
    const callsBeforeNeg = server.calls.length;
    for (const badId of ['41004', '41005', '41008', '41009', '41010', '41011', '41012', '41013', '999999']) {
      const denied = await readRes(await w8Request(`/v1/w8/papers?pageId=${badId}`, {
        method: 'GET',
        env: readEnv,
        fetchImpl: reader.fetchImpl,
        headers: { Authorization: `Bearer ${reader.session}` },
      }));
      assert.equal(denied.status, 404, `expected 404 for page ${badId}`);
      assert.equal(denied.json.error.code, 'not_found');
    }
    // Detail: VIEW_RESTRICTED -> 403 parent_not_allowed; GET 403 -> 403 permission_denied
    const viewRestricted = await readRes(await w8Request('/v1/w8/papers?pageId=41006', {
      method: 'GET',
      env: readEnv,
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(viewRestricted.status, 403);
    assert.equal(viewRestricted.json.error.code, 'parent_not_allowed');

    const childForbidden = await readRes(await w8Request('/v1/w8/papers?pageId=41007', {
      method: 'GET',
      env: readEnv,
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(childForbidden.status, 403);
    assert.equal(childForbidden.json.error.code, 'permission_denied');

    const negCalls = server.calls.slice(callsBeforeNeg);
    assert.equal(negCalls.some(c => c.path.includes('/attachment')), false, 'denied detail calls never touch attachments');

    const readCalls = server.calls.slice(callsBefore);
    assert.equal(readCalls.some(c => c.method !== 'GET'), false, 'read route performs zero writes');
    assert.equal(readCalls.some(c => c.path.includes('/user/current')), false, 'read route never needs user/current');
  });

  test('reuses sealed archive-style pagination and rejects raw, tampered, cross-parent, and cross-endpoint cursors', async () => {
    const server = createSharedConfluenceServer({ childrenPageSize: 2, extraParents: [CUSTOM_PARENT] });
    const reader = await mintReadOnlyConfluenceSession(server);
    seedReadyPaperPage(server, { pageId: '42001', sourceSha256: '1'.repeat(64), title: 'Paper One' });
    seedReadyPaperPage(server, { pageId: '42002', sourceSha256: '2'.repeat(64), title: 'Paper Two' });
    seedReadyPaperPage(server, { pageId: '42003', sourceSha256: '3'.repeat(64), title: 'Paper Three' });

    const page1 = await readRes(await w8Request('/v1/w8/papers', {
      method: 'GET',
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(page1.status, 200);
    assert.deepEqual(page1.json.items.map(i => i.pageId), ['42001', '42002']);
    assert.match(page1.json.nextCursor, /^[A-Za-z0-9_-]+$/);
    assert.equal(page1.json.nextCursor.includes('='), false);
    assert.notEqual(page1.json.nextCursor, 'raw_w8_cursor_2=');

    const page2 = await readRes(await w8Request(`/v1/w8/papers?cursor=${encodeURIComponent(page1.json.nextCursor)}`, {
      method: 'GET',
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(page2.status, 200);
    assert.deepEqual(page2.json.items.map(i => i.pageId), ['42003']);
    assert.equal(page2.json.nextCursor, null);

    const childCalls = server.calls.filter(c => c.path.endsWith(`/${LIBRARY_PARENT}/children`));
    assert.equal(childCalls.length, 2);
    assert.equal(childCalls[0].url.includes('cursor='), false);
    assert.equal(childCalls[1].url.includes('cursor=raw_w8_cursor_2%3D'), true);

    // Cross-endpoint cursor from /v1/confluence/archives is rejected even if valid for Confluence archives
    const archiveServer = createSharedConfluenceServer({ childrenPageSize: 1 });
    seedReadyPaperPage(archiveServer, { pageId: '42101', parentId: LEGACY_PARENT, sourceSha256: '4'.repeat(64), title: 'Archive 1' });
    seedReadyPaperPage(archiveServer, { pageId: '42102', parentId: LEGACY_PARENT, sourceSha256: '5'.repeat(64), title: 'Archive 2' });
    const archiveList = await readRes(await confluenceRequest('/v1/confluence/archives', {
      method: 'GET',
      fetchImpl: archiveServer.makeFetch(),
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(archiveList.status, 200);
    assert.ok(archiveList.json.nextCursor);

    const noCallsFetch = async () => { throw new Error('must reject bad cursor/query before upstream calls'); };
    for (const badCursor of [
      'raw_w8_cursor_2=',
      'https://evil.example/steal',
      '',
      `${page1.json.nextCursor.slice(0, -2)}AA`,
      archiveList.json.nextCursor,
    ]) {
      const res = await readRes(await w8Request(`/v1/w8/papers?cursor=${encodeURIComponent(badCursor)}`, {
        method: 'GET',
        fetchImpl: noCallsFetch,
        headers: { Authorization: `Bearer ${reader.session}` },
      }));
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, 'invalid_cursor');
    }

    // Cursor bound to LIBRARY_PARENT is rejected on CUSTOM_PARENT with zero upstream calls
    const wrongParentCursor = await readRes(await w8Request(`/v1/w8/papers?cursor=${encodeURIComponent(page1.json.nextCursor)}`, {
      method: 'GET',
      env: baseEnv({ W8_CONFLUENCE_LIBRARY_PARENT_ID: CUSTOM_PARENT }),
      fetchImpl: noCallsFetch,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(wrongParentCursor.status, 400);
    assert.equal(wrongParentCursor.json.error.code, 'invalid_cursor');

    // Invalid query parameters rejected with 400 invalid_request and zero upstream calls
    for (const badPath of [
      '/v1/w8/papers?foo=bar',
      `/v1/w8/papers?cursor=${encodeURIComponent(page1.json.nextCursor)}&pageId=42001`,
      '/v1/w8/papers?pageId=not-digits',
      '/v1/w8/papers?pageId=',
      '/v1/w8/papers?pageId=123456789012345678901',
      '/v1/w8/papers?pageId=42001&pageId=42002',
      '/v1/w8/papers?cursor=a&cursor=b',
    ]) {
      const res = await readRes(await w8Request(badPath, {
        method: 'GET',
        fetchImpl: noCallsFetch,
        headers: { Authorization: `Bearer ${reader.session}` },
      }));
      assert.equal(res.status, 400, `expected 400 for ${badPath}`);
      assert.equal(res.json.error.code, 'invalid_request');
    }

    // Evil upstream _links.next rejected with 502 upstream_invalid
    const evilServer = createSharedConfluenceServer({ evilNext: true });
    const evilNext = await readRes(await w8Request('/v1/w8/papers', {
      method: 'GET',
      fetchImpl: evilServer.makeFetch(),
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(evilNext.status, 502);
    assert.equal(evilNext.json.error.code, 'upstream_invalid');
  });

  test('verifies actual committed state attachment on detail and fails closed on tampering, redirects, and partial commits', async () => {
    const shaGood = 'b'.repeat(64);
    const shaHashBad = 'c'.repeat(64);
    const shaMissing = 'd'.repeat(64);
    const shaForbidden = 'e'.repeat(64);
    const shaRedirect = 'f'.repeat(64);
    const shaPendingBody = '0'.repeat(64);

    const server = createSharedConfluenceServer({
      tamperAttachmentBytesByPageId: {
        '43002': Buffer.from('{"tampered":true}', 'utf8'),
      },
      downloadRedirectByPageId: {
        '43005': 'https://evil.example/steal.json',
      },
    });
    const reader = await mintReadOnlyConfluenceSession(server);

    // 1. Body committed a newer state than property (post-commit partial update): detail verifies the newer body state!
    const seeded = seedReadyPaperPage(server, {
      pageId: '43001',
      sourceSha256: shaGood,
      title: 'Old Prop Title',
      arxivId: null,
    });
    const newerState = {
      ...seeded.stateObj,
      title: 'Verified Latest Title',
      arxivId: '2406.00001',
      driveFiles: { [shaGood]: 'VerifiedDriveId123' },
    };
    const newerBytes = Buffer.from(canonicalJson(newerState), 'utf8');
    const newerSha = sha256(newerBytes);
    seeded.page.attachments.set('att999', { id: 'att999', title: `${newerSha}.json`, bytes: newerBytes });
    seeded.page.body = seeded.page.body.replaceAll(seeded.stateSha, newerSha);

    const latestDetail = await readRes(await w8Request('/v1/w8/papers?pageId=43001', {
      method: 'GET',
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(latestDetail.status, 200);
    assert.equal(latestDetail.json.title, 'Verified Latest Title');
    assert.equal(latestDetail.json.arxivId, '2406.00001');
    assert.equal(latestDetail.json.sourceDriveId, 'VerifiedDriveId123');

    // 2. Hash-mismatched attachment -> 422 invalid_archive
    seedReadyPaperPage(server, { pageId: '43002', sourceSha256: shaHashBad, title: 'Tampered Bytes' });
    const badHash = await readRes(await w8Request('/v1/w8/papers?pageId=43002', {
      method: 'GET',
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(badHash.status, 422);
    assert.equal(badHash.json.error.code, 'invalid_archive');

    // 3. Missing attachment -> 422 invalid_archive
    seedReadyPaperPage(server, { pageId: '43003', sourceSha256: shaMissing, title: 'Missing Att', omitAttachment: true });
    const missingAtt = await readRes(await w8Request('/v1/w8/papers?pageId=43003', {
      method: 'GET',
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(missingAtt.status, 422);
    assert.equal(missingAtt.json.error.code, 'invalid_archive');

    // 4. State containing forbidden content -> 422 forbidden_content
    seedReadyPaperPage(server, {
      pageId: '43004',
      sourceSha256: shaForbidden,
      title: 'Forbidden State',
      extraState: { redRuns: [{ id: 'leak' }] },
    });
    const forbidden = await readRes(await w8Request('/v1/w8/papers?pageId=43004', {
      method: 'GET',
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(forbidden.status, 422);
    assert.equal(forbidden.json.error.code, 'forbidden_content');

    // 5. Attachment download redirect to evil host -> 502 redirect_refused (evil host never contacted)
    seedReadyPaperPage(server, { pageId: '43005', sourceSha256: shaRedirect, title: 'Redirect Att' });
    const redirected = await readRes(await w8Request('/v1/w8/papers?pageId=43005', {
      method: 'GET',
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(redirected.status, 502);
    assert.equal(redirected.json.error.code, 'redirect_refused');
    assert.equal(server.calls.some(c => c.host === 'evil.example'), false);

    // 6. Pending body with ready:true property -> 404 not_found
    seedReadyPaperPage(server, {
      pageId: '43006',
      sourceSha256: shaPendingBody,
      title: 'Pending Body',
      overrideBodyStateToken: 'pending',
    });
    const pendingBody = await readRes(await w8Request('/v1/w8/papers?pageId=43006', {
      method: 'GET',
      fetchImpl: reader.fetchImpl,
      headers: { Authorization: `Bearer ${reader.session}` },
    }));
    assert.equal(pendingBody.status, 404);
    assert.equal(pendingBody.json.error.code, 'not_found');
  });

  test('enforces authentication, confinement, custom parent isolation, refresh headers, and method allowlist', async () => {
    const server = createSharedConfluenceServer({ extraParents: [CUSTOM_PARENT], tokenExpiresIn: 120 });
    const alice = await mintConfluenceOnlySession(server, { user: { accountId: 'acc-alice', displayName: 'Alice' }, now: T0 });
    seedReadyPaperPage(server, { pageId: '44001', parentId: LIBRARY_PARENT, sourceSha256: '1'.repeat(64), title: 'Default Parent Paper' });
    seedReadyPaperPage(server, { pageId: '44002', parentId: CUSTOM_PARENT, sourceSha256: '2'.repeat(64), title: 'Custom Parent Paper' });

    // Missing / legacy / malformed auth -> 401 with zero upstream calls
    const noFetch = async () => { throw new Error('no upstream call expected'); };
    for (const headers of [
      {},
      { Authorization: `Bearer fss_${'a'.repeat(43)}` },
      { Authorization: `Bearer fsi_${'a'.repeat(43)}` },
      { Authorization: 'Bearer not-a-sealed-session' },
    ]) {
      const res = await readRes(await w8Request('/v1/w8/papers', { method: 'GET', headers, fetchImpl: noFetch }));
      assert.equal(res.status, 401);
      assert.equal(res.json.error.code, 'unauthorized');
    }

    // Expired envelope -> 401 session_expired
    const expired = await readRes(await w8Request('/v1/w8/papers', {
      method: 'GET',
      headers: { Authorization: `Bearer ${alice.session}` },
      fetchImpl: noFetch,
      now: T0 + 13 * 60 * 60 * 1000,
    }));
    assert.equal(expired.status, 401);
    assert.equal(expired.json.error.code, 'session_expired');

    // Near-expiry session transparently refreshes on GET /v1/w8/papers
    const refreshed = await readRes(await w8Request('/v1/w8/papers', {
      method: 'GET',
      headers: { Authorization: `Bearer ${alice.session}` },
      fetchImpl: alice.fetchImpl,
      now: T0 + 90_000,
    }));
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.headers.get(SESSION_HEADER));
    assert.equal(refreshed.headers.get('access-control-expose-headers'), SESSION_HEADER);

    // Custom W8_CONFLUENCE_LIBRARY_PARENT_ID isolates list & detail to that exact parent
    const customEnv = baseEnv({ W8_CONFLUENCE_LIBRARY_PARENT_ID: CUSTOM_PARENT });
    const customList = await readRes(await w8Request('/v1/w8/papers', {
      method: 'GET',
      env: customEnv,
      headers: { Authorization: `Bearer ${alice.session}` },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(customList.status, 200);
    assert.deepEqual(customList.json.items.map(i => i.pageId), ['44002']);

    const wrongParentDetail = await readRes(await w8Request('/v1/w8/papers?pageId=44001', {
      method: 'GET',
      env: customEnv,
      headers: { Authorization: `Bearer ${alice.session}` },
      fetchImpl: alice.fetchImpl,
    }));
    assert.equal(wrongParentDetail.status, 404);

    // Invalid parent env -> 503 not_configured
    const badCfg = await readRes(await w8Request('/v1/w8/papers', {
      method: 'GET',
      env: baseEnv({ W8_CONFLUENCE_LIBRARY_PARENT_ID: 'invalid' }),
      headers: { Authorization: `Bearer ${alice.session}` },
      fetchImpl: noFetch,
    }));
    assert.equal(badCfg.status, 503);
    assert.equal(badCfg.json.error.code, 'not_configured');

    // Confinement failures: wrong site, space 403, parent 403, restricted ancestor
    const wrongSite = await readRes(await w8Request('/v1/w8/papers', {
      method: 'GET',
      headers: { Authorization: `Bearer ${alice.session}` },
      fetchImpl: createSharedConfluenceServer({ resources: [{ id: '99999999-9999-9999-9999-999999999999', url: SITE }] }).makeFetch(),
    }));
    assert.equal(wrongSite.status, 403);
    assert.equal(wrongSite.json.error.code, 'site_not_allowed');

    const spaceDenied = await readRes(await w8Request('/v1/w8/papers', {
      method: 'GET',
      headers: { Authorization: `Bearer ${alice.session}` },
      fetchImpl: createSharedConfluenceServer({ spaceStatus: 403 }).makeFetch(),
    }));
    assert.equal(spaceDenied.status, 403);
    assert.equal(spaceDenied.json.error.code, 'space_not_allowed');

    const parentDenied = await readRes(await w8Request('/v1/w8/papers', {
      method: 'GET',
      headers: { Authorization: `Bearer ${alice.session}` },
      fetchImpl: createSharedConfluenceServer({ parentStatusById: { [LIBRARY_PARENT]: 403 } }).makeFetch(),
    }));
    assert.equal(parentDenied.status, 403);
    assert.equal(parentDenied.json.error.code, 'parent_not_allowed');

    const ancestorRestricted = await readRes(await w8Request('/v1/w8/papers', {
      method: 'GET',
      headers: { Authorization: `Bearer ${alice.session}` },
      fetchImpl: createSharedConfluenceServer({
        ancestors: [{ id: '66042', type: 'page' }],
        restrictionById: { '66042': 'VIEW_RESTRICTED' },
      }).makeFetch(),
    }));
    assert.equal(ancestorRestricted.status, 403);
    assert.equal(ancestorRestricted.json.error.code, 'parent_not_allowed');

    // Non-GET methods rejected with 405 Allow: GET
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const wrong = await readRes(await w8Request('/v1/w8/papers', {
        method,
        headers: { Authorization: `Bearer ${alice.session}` },
        fetchImpl: noFetch,
      }));
      assert.equal(wrong.status, 405);
      assert.equal(wrong.headers.get('Allow'), 'GET');
    }
  });

  test('worker fetch routes GET and OPTIONS /v1/w8/papers with strict CORS and redacted logs', async () => {
    const ragasSha = '12'.repeat(32);
    const server = createSharedConfluenceServer();
    seedReadyPaperPage(server, {
      pageId: '45001',
      sourceSha256: ragasSha,
      title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
      arxivId: '2309.15217',
      driveFiles: { [ragasSha]: 'SensitiveDriveId99' },
      runs: [{ key: 'atl:0123456789abcdef::source::r1', id: 'r1', contributor: 'atl:0123456789abcdef', revisionSha256: null, model: 'm', findings: [{ quote: 'SENSITIVE_PAPER_QUOTE', rationale: 'R', severity: 'major', verdict: 'v' }] }],
    });
    const reader = await mintReadOnlyConfluenceSession(server, { now: Date.now() });
    const lines = [];
    const origLog = console.log;
    const origErr = console.error;
    const origFetch = globalThis.fetch;
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    globalThis.fetch = reader.fetchImpl;
    try {
      const env = baseEnv();
      const forbiddenGet = await worker.fetch(new Request('https://worker.example/v1/w8/papers', {
        method: 'GET',
        headers: { Origin: 'https://evil.example', Authorization: `Bearer ${reader.session}` },
      }), env);
      assert.equal(forbiddenGet.status, 403);
      assert.equal(forbiddenGet.headers.get('access-control-allow-origin'), null);

      const forbiddenOptions = await worker.fetch(new Request('https://worker.example/v1/w8/papers', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
      }), env);
      assert.equal(forbiddenOptions.status, 403);
      assert.equal(forbiddenOptions.headers.get('access-control-allow-origin'), null);

      const preflight = await worker.fetch(new Request('https://worker.example/v1/w8/papers?pageId=45001', {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
      }), env);
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
      assert.match(preflight.headers.get('vary') || '', /\bOrigin\b/i);
      assert.match(preflight.headers.get('access-control-allow-methods') || '', /\bGET\b/);
      assert.match(preflight.headers.get('access-control-allow-headers') || '', /\bauthorization\b/i);

      const listed = await worker.fetch(new Request('https://worker.example/v1/w8/papers', {
        method: 'GET',
        headers: { Origin: ORIGIN, Authorization: `Bearer ${reader.session}` },
      }), env);
      assert.equal(listed.status, 200);
      assert.equal(listed.headers.get('access-control-allow-origin'), ORIGIN);
      assert.equal(listed.headers.get('cache-control'), 'no-store');
      assert.equal(listed.headers.get('x-content-type-options'), 'nosniff');
      const listJson = await listed.json();
      assert.equal(listJson.items.length, 1);
      assert.equal(listJson.items[0].pageId, '45001');

      const detail = await worker.fetch(new Request('https://worker.example/v1/w8/papers?pageId=45001', {
        method: 'GET',
        headers: { Origin: ORIGIN, Authorization: `Bearer ${reader.session}` },
      }), env);
      assert.equal(detail.status, 200);
      assert.equal(detail.headers.get('access-control-allow-origin'), ORIGIN);
      const detailJson = await detail.json();
      assert.equal(detailJson.arxivId, '2309.15217');
      assert.equal(detailJson.sourceDriveId, 'SensitiveDriveId99');
    } finally {
      console.log = origLog;
      console.error = origErr;
      globalThis.fetch = origFetch;
    }

    const joined = lines.join('\n');
    assert.match(joined, /"route":"\/v1\/w8\/papers"/);
    assert.equal(joined.includes(SECRET), false);
    assert.equal(joined.includes('conf-readonly-'), false);
    assert.equal(joined.includes('45001'), false);
    assert.equal(joined.includes('2309.15217'), false);
    assert.equal(joined.includes('SensitiveDriveId99'), false);
    assert.equal(joined.includes('SENSITIVE_PAPER_QUOTE'), false);
  });
});
