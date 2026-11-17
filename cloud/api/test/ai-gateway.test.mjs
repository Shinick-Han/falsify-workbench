// Offline hosted AI gateway tests (contract docs/hosted-ai-contract-20261117.md).
// Synthetic bytes and accounts only. The runtime and the Atlassian identity endpoint are replaced by
// one injected fetch stub that runs inside the worker isolate and records its calls in D1; nothing
// leaves this process and no live provider, Atlasian or runtime endpoint is contacted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
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
const PASSWORD = 'correct horse battery';
const NEXT = 'replacement horse battery';
const CLOUD = '11111111-1111-4111-8111-111111111111';
const SESSION_PURPOSE = 'falsify.confluence.session.v1';
const SESSION_KEY = Buffer.alloc(32, 7);
const SERVICE_TOKEN = 'test-service-token-' + 't'.repeat(24);
const DEFAULT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const UUID_A = '11111111-1111-4111-8111-111111111111';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const atlOwner = (cloudId, accountId) => `atl:${sha256(`${cloudId}:${accountId}`)}`;
const pdfBytes = text => Buffer.from(`%PDF-1.7 synthetic ${text}`);

let script;
let statements;

// Injected into the worker isolate. `env` is passed by ai-runtime-client so the stub can record
// calls in the same D1 database and read per-instance failure modes from a binding.
async function stubFetch(url, init, env) {
  const requestUrl = new URL(String(url));
  const method = String((init && init.method) || 'GET').toUpperCase();
  const headers = new Headers((init && init.headers) || {});
  const mode = String((env && env.AI_STUB_MODE) || '');
  const db = env && env.DB;
  const EDITED_PDF = new TextEncoder().encode('%PDF-1.7 synthetic edited output ART-MARK');
  const reply = (status, body, extra) => new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extra || {}) },
  });
  if (db) {
    await db.prepare('INSERT INTO ai_stub_calls (host, path, method) VALUES (?1, ?2, ?3)')
      .bind(requestUrl.hostname, requestUrl.pathname, method).run();
  }
  if (requestUrl.hostname === 'api.atlassian.com') {
    if (!requestUrl.pathname.endsWith('/wiki/rest/api/user/current')) return new Response('not found', { status: 404 });
    if (mode === 'identity-no-account') return reply(200, { email: 'leak@example.test', displayName: 'Leak Name' });
    if (mode === 'identity-forbidden') return new Response('denied', { status: 403 });
    if (mode === 'identity-down') return new Response('down', { status: 500 });
    const authorization = headers.get('Authorization') || '';
    const token = authorization.replace(/^Bearer /, '');
    const accountId = token.startsWith('access:') ? token.slice('access:'.length) : '';
    if (!accountId) return reply(200, {});
    return reply(200, { accountId, email: 'leak@example.test', displayName: 'Leak Name' });
  }
  if (requestUrl.hostname !== 'runtime.test') return new Response('not found', { status: 404 });
  if (mode === 'runtime-down') return new Response('down', { status: 503 });
  if (requestUrl.pathname === '/internal/v1/uploads' && method === 'POST') {
    if (mode === 'upload-down') return new Response('down', { status: 500 });
    const rawBody = init.body;
    let bytes;
    if (rawBody instanceof ArrayBuffer) bytes = new Uint8Array(rawBody);
    else if (ArrayBuffer.isView(rawBody)) bytes = new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
    else if (typeof rawBody === 'string') bytes = new TextEncoder().encode(rawBody);
    else bytes = new Uint8Array(await new Response(rawBody).arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const owner = headers.get('X-Falsify-Owner-Id') || '';
    const id = `rt-${sha.slice(0, 32)}`;
    await db.prepare('INSERT INTO ai_stub_uploads (id, owner_id, sha256, bytes) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO NOTHING')
      .bind(id, owner, sha, bytes.byteLength).run();
    return reply(201, {
      upload: {
        id,
        sha256: sha,
        bytes: bytes.byteLength,
        name: requestUrl.searchParams.get('name') || '',
        mime: requestUrl.searchParams.get('mime') || '',
        createdAt: new Date().toISOString(),
      },
    });
  }
  if (requestUrl.pathname === '/internal/v1/jobs' && method === 'POST') {
    if (mode === 'job-down') return new Response('down', { status: 503 });
    const payload = JSON.parse(init.body);
    const owner = headers.get('X-Falsify-Owner-Id') || '';
    const known = await db.prepare('SELECT 1 AS ok FROM ai_stub_uploads WHERE id = ?1 AND owner_id = ?2')
      .bind(payload.uploadId, owner).first();
    if (!known) return new Response('unknown upload', { status: 404 });
    const at = new Date().toISOString();
    await db.prepare(
      'INSERT INTO ai_stub_jobs (id, owner_id, state, upload_id, model, effort, max_calls, prompt, created_at, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT (id) DO NOTHING'
    ).bind(payload.jobId, owner, 'queued', payload.uploadId, payload.model, payload.effort, payload.budget.maxCalls, payload.prompt, at, JSON.stringify(payload)).run();
    return reply(202, {
      id: payload.jobId,
      role: payload.role,
      state: 'queued',
      progress: { completedCalls: 0, requiredCalls: payload.budget.maxCalls, phase: 'queued' },
      model: payload.model,
      effort: payload.effort,
      provider: 'anthropic',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      artifacts: [],
      createdAt: at,
      updatedAt: at,
    });
  }
  const cancel = /^\/internal\/v1\/jobs\/([^/]+)\/cancel$/.exec(requestUrl.pathname);
  if (cancel && method === 'POST') {
    const owner = headers.get('X-Falsify-Owner-Id') || '';
    const job = await db.prepare('SELECT id, model, effort, max_calls FROM ai_stub_jobs WHERE id = ?1 AND owner_id = ?2')
      .bind(cancel[1], owner).first();
    if (!job) return new Response('not found', { status: 404 });
    await db.prepare('UPDATE ai_stub_jobs SET state = ?1 WHERE id = ?2').bind('cancelling', job.id).run();
    const at = new Date().toISOString();
    return reply(202, {
      id: job.id,
      role: 'red',
      state: 'cancelling',
      progress: { completedCalls: 1, requiredCalls: job.max_calls, phase: 'cancelling' },
      model: job.model,
      effort: job.effort,
      provider: 'anthropic',
      usage: { inputTokens: 11, outputTokens: 7 },
      artifacts: [],
      createdAt: at,
      updatedAt: at,
    });
  }
  const artifact = /^\/internal\/v1\/jobs\/([^/]+)\/artifacts\/([^/]+)$/.exec(requestUrl.pathname);
  if (artifact && method === 'GET') {
    const owner = headers.get('X-Falsify-Owner-Id') || '';
    const job = await db.prepare('SELECT id FROM ai_stub_jobs WHERE id = ?1 AND owner_id = ?2')
      .bind(artifact[1], owner).first();
    if (!job) return new Response('not found', { status: 404 });
    if (artifact[2] === 'edited-pdf-1') {
      return new Response(EDITED_PDF, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="edited.pdf"' },
      });
    }
    if (artifact[2] !== 'artifact-1') return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ artifact: artifact[2], owner, marker: 'ARTIFACT-BYTES' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="review.json"' },
    });
  }
  const status = /^\/internal\/v1\/jobs\/([^/]+)$/.exec(requestUrl.pathname);
  if (status && method === 'GET') {
    const owner = headers.get('X-Falsify-Owner-Id') || '';
    const job = await db.prepare('SELECT id, model, effort, max_calls, state, created_at FROM ai_stub_jobs WHERE id = ?1 AND owner_id = ?2')
      .bind(status[1], owner).first();
    if (!job) return new Response('not found', { status: 404 });
    const at = new Date().toISOString();
    const terminal = ['completed', 'cancelled', 'failed', 'interrupted'].includes(job.state);
    const editedDigest = await crypto.subtle.digest('SHA-256', EDITED_PDF);
    const editedSha = Array.from(new Uint8Array(editedDigest), b => b.toString(16).padStart(2, '0')).join('');
    const snapshot = {
      id: job.id,
      role: 'red',
      state: terminal ? job.state : 'running',
      progress: { completedCalls: 2, requiredCalls: job.max_calls, phase: terminal ? job.state : 'analyzing' },
      model: job.model,
      effort: job.effort,
      provider: 'anthropic',
      usage: { inputTokens: 11, outputTokens: 7, cacheReadInputTokens: 2, cacheCreationInputTokens: 3 },
      result: { findings: [{ marker: 'RESULT-MARKER' }] },
      artifacts: [
        { id: 'artifact-1', name: 'review.json', mime: 'application/json', bytes: 42, sha256: 'aa'.repeat(32) },
        { id: 'edited-pdf-1', name: 'edited.pdf', mime: 'application/pdf', bytes: EDITED_PDF.length, sha256: editedSha },
      ],
      createdAt: job.created_at,
      updatedAt: at,
    };
    if (terminal) snapshot.completedAt = at;
    return reply(200, snapshot);
  }
  return new Response('unmocked', { status: 404 });
}

const STUB_TABLES = [
  'CREATE TABLE ai_stub_calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, path TEXT NOT NULL, method TEXT NOT NULL)',
  'CREATE TABLE ai_stub_uploads (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL)',
  'CREATE TABLE ai_stub_jobs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, state TEXT NOT NULL, upload_id TEXT NOT NULL, model TEXT, effort TEXT, max_calls INTEGER, prompt TEXT, created_at TEXT NOT NULL, payload TEXT)',
];

function migrationStatements() {
  const sql = ['0001_shared_records.sql', '0002_invite_membership.sql', '0003_hosted_ai.sql', '0004_owner_usage.sql']
    .map(name => readFileSync(path.join(apiRoot, 'migrations', name), 'utf8'))
    .join('\n');
  return sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean);
}

async function start(bindings = {}) {
  const instance = new Miniflare(convertV4MiniflareOptions({
    name: 'falsify-ai-gateway',
    modules: true,
    script,
    compatibilityDate: '2026-10-19',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      ALLOWED_ORIGINS: ORIGIN,
      AI_HOSTING_ENABLED: 'true',
      AI_RUNTIME_URL: 'https://runtime.test',
      HOSTED_AI_SERVICE_TOKEN: SERVICE_TOKEN,
      AI_MAX_UPLOAD_BYTES: '4096',
      AI_RUNTIME_TIMEOUT_MS: '5000',
      REGISTERS_PER_IP_HOUR: '100',
      LOGIN_FAILURES_PER_USERNAME_HOUR: '100',
      LOGINS_PER_IP_HOUR: '1000',
      LOGINS_PER_HOUR: '5000',
      ...bindings,
    },
    d1Databases: ['DB'],
  }));
  const d1 = await instance.getD1Database('DB');
  for (const statement of statements) await d1.prepare(statement).run();
  for (const statement of STUB_TABLES) await d1.prepare(statement).run();
  return instance;
}

function client(instance) {
  return async (method, pathname, { token, body, raw, headers = {} } = {}) => {
    const h = { Origin: ORIGIN, ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) payload = JSON.stringify(body);
    if (typeof payload === 'string' && !Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    const response = await instance.dispatchFetch(`https://api.test${pathname}`, { method, headers: h, body: payload });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, headers: response.headers, body: parsed, text, bytes };
  };
}

async function invite(instance) {
  const code = 'fsi_' + randomBytes(32).toString('base64url');
  const d1 = await instance.getD1Database('DB');
  await d1.prepare('INSERT INTO invitations (code_hash, created_at, expires_at, revoked_at) VALUES (?1, ?2, ?3, NULL)')
    .bind(sha256(code), new Date().toISOString(), Date.now() + 3600e3).run();
  return code;
}

async function register(instance, c, username, password = PASSWORD) {
  return c('POST', '/v1/auth/register', { body: { username, password, inviteCode: await invite(instance) } });
}

const login = (c, username, password = PASSWORD) => c('POST', '/v1/auth/login', { body: { username, password } });

function upload(c, token, bytes, { name = 'paper.pdf', mime = 'application/pdf', headers = {} } = {}) {
  return c('POST', '/v1/ai/uploads', {
    token,
    raw: bytes,
    headers: { 'Content-Type': mime, 'X-Falsify-File-Name': encodeURIComponent(name), ...headers },
  });
}

function jobBody(uploadId, overrides = {}) {
  return {
    role: 'red',
    prompt: 'Review this synthetic paper and list contradictions.',
    uploadId,
    idempotencyKey: 'op-synthetic-0001',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    budget: { maxCalls: 5 },
    ...overrides,
  };
}

const postJob = (c, token, body) => c('POST', '/v1/ai/jobs', { token, body });

function sealSession(payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', SESSION_KEY, iv);
  cipher.setAAD(Buffer.from(SESSION_PURPOSE));
  const body = Buffer.concat([cipher.update(JSON.stringify({ purpose: SESSION_PURPOSE, ...payload }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

// A sealed Confluence session whose access token carries the synthetic accountId the stub resolves.
function confluenceSession({ cloudId = CLOUD, accountId = 'acct-alpha' } = {}) {
  return sealSession({
    accessToken: `access:${accountId}`,
    refreshToken: 'refresh:test',
    accessExp: Date.now() + 3600e3,
    envelopeExp: Date.now() + 12 * 3600e3,
    rotations: 0,
    cloudId,
    siteUrl: 'https://falsify.atlassian.net',
  });
}

const CONFLUENCE_ENV = { CONFLUENCE_SESSION_KEY: SESSION_KEY.toString('base64'), CONFLUENCE_ONLY: 'true' };

async function stubCalls(instance, pathname, method) {
  const d1 = await instance.getD1Database('DB');
  const row = await d1.prepare('SELECT COUNT(*) AS count FROM ai_stub_calls WHERE path = ?1 AND method = ?2')
    .bind(pathname, method).first();
  return row.count;
}

async function seedGatewayJob(instance, { id = UUID_A, ownerId, state = 'queued', role = 'red' } = {}) {
  const d1 = await instance.getD1Database('DB');
  const at = new Date().toISOString();
  const snapshot = {
    id, role, state,
    progress: { completedCalls: 0, requiredCalls: 5, phase: 'queued' },
    model: 'claude-sonnet-5-5',
    effort: 'high',
    provider: 'anthropic',
    usage: { inputTokens: 0, outputTokens: 0 },
    artifacts: [],
    createdAt: at,
    updatedAt: at,
  };
  await d1.prepare(
    `INSERT INTO ai_jobs (id, owner_id, role, idempotency_key, request_hash, upload_id, model, effort, state, snapshot, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
  ).bind(id, ownerId, role, 'op-seeded-0001', 'f'.repeat(64), UUID_A, 'claude-sonnet-5-5', 'high', state, JSON.stringify(snapshot), at).run();
}

// Records usage as if a terminal snapshot had been observed for this owner in the current window.
async function seedUsageJob(instance, { id, ownerId, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, recordedAt = new Date().toISOString() }) {
  const d1 = await instance.getD1Database('DB');
  const at = new Date().toISOString();
  const snapshot = { id, role: 'red', state: 'completed', createdAt: at, updatedAt: at };
  await d1.prepare(
    `INSERT INTO ai_jobs (id, owner_id, role, idempotency_key, request_hash, upload_id, model, effort, state, snapshot,
       created_at, updated_at, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, usage_recorded_at)
     VALUES (?1, ?2, 'red', ?3, ?4, ?5, 'claude-sonnet-5-5', 'high', 'completed', ?6, ?7, ?7, ?8, ?9, ?10, ?11, ?12)`
  ).bind(id, ownerId, `op-seed-${id}`, 'e'.repeat(64), UUID_A, JSON.stringify(snapshot), at, input, output, cacheRead, cacheCreation, recordedAt).run();
}

async function ownerUsage(instance, ownerId) {
  const d1 = await instance.getD1Database('DB');
  const row = await d1.prepare(
    `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens), 0) AS used
     FROM ai_jobs WHERE owner_id = ?1`
  ).bind(ownerId).first();
  return Number(row.used);
}

async function stubJobPayload(instance, jobId) {
  const d1 = await instance.getD1Database('DB');
  const row = await d1.prepare('SELECT payload FROM ai_stub_jobs WHERE id = ?1').bind(jobId).first();
  return row ? JSON.parse(row.payload) : null;
}

const TEXT_EDIT = { id: 'edit-1', pageIndex: 0, before: '12.4%', after: '14.1%', occurrence: 0 };
const TABLE_EDIT = {
  kind: 'table-cell', itemId: 'table-3', row: 2, column: 1,
  before: '12.4', after: '14.1', rationale: 'Align table with prose.',
};
const CHART_EDIT = {
  kind: 'chart-point', itemId: 'figure-2', seriesId: 'series-a', pointIndex: 3,
  beforeY: 12.4, afterY: 14.1, rationale: 'Align chart with prose.',
};

async function withApp(bindings, fn) {
  const instance = await start(bindings);
  try {
    return await fn(instance, client(instance));
  } finally {
    await instance.dispose();
  }
}

before(async () => {
  const entry = [
    "import worker from './src/index.js';",
    "import { setAiFetchForTests } from './src/ai-runtime-client.mjs';",
    `setAiFetchForTests(${stubFetch.toString()});`,
    'export default worker;',
  ].join('\n');
  const result = await build({
    stdin: { contents: entry, resolveDir: apiRoot, sourcefile: 'ai-gateway-test-entry.mjs', loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['node:*'],
    logLevel: 'silent',
    plugins: [{
      name: 'shared-core',
      setup(b) {
        b.onResolve({ filter: /cloud-records-core\.mjs$/ }, () => ({ path: corePath }));
        b.onResolve({ filter: /harness-core\.js$/ }, () => ({ path: harnessPath }));
      },
    }],
  });
  script = result.outputFiles[0].text;
  statements = migrationStatements();
});

after(async () => { /* every test disposes its own instance */ });

test('hosting off leaves legacy gateways unchanged and exposes enabled:false', async () => {
  await withApp({ AI_HOSTING_ENABLED: 'false', CONFLUENCE_ONLY: 'true' }, async (mf, call) => {
    // The capability probe is public: a signed-out page can truthfully render enabled:false.
    const probe = await call('GET', '/v1/ai/capabilities');
    assert.equal(probe.status, 200);
    assert.equal(probe.body.enabled, false);
    assert.deepEqual(probe.body.models, DEFAULT_MODELS);
    const blocked = await login(call, 'nobody');
    assert.equal(blocked.status, 410);
    assert.equal(blocked.body.error.code, 'storage_moved');
    const write = await call('POST', '/v1/records', { raw: '{}' });
    assert.equal(write.status, 410);
    assert.equal(write.body.error.code, 'storage_moved');
    for (const [method, pathname] of [
      ['POST', '/v1/ai/uploads'],
      ['POST', '/v1/ai/jobs'],
      ['GET', `/v1/ai/jobs/${UUID_A}`],
    ]) {
      const res = await call(method, pathname, { raw: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 404, `${method} ${pathname}`);
      assert.equal(res.body.error.code, 'not_found');
    }
    const signedOutUpload = await upload(call, null, pdfBytes('signed-out'));
    assert.equal(signedOutUpload.status, 404, 'other AI routes stay absent while hosting is off');
  });

  await withApp({ AI_HOSTING_ENABLED: 'false', CONFLUENCE_ONLY: 'false' }, async (mf, call) => {
    const created = await register(mf, call, 'offline');
    assert.equal(created.status, 201);
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.equal(capabilities.status, 200);
    assert.deepEqual(capabilities.body, {
      enabled: false,
      provider: 'anthropic',
      execution: 'server',
      models: DEFAULT_MODELS,
      efforts: DEFAULT_EFFORTS,
      limits: { maxUploadBytes: 4096, maxPromptChars: 8000 },
    });
    assert.equal(JSON.stringify(capabilities.body).includes('key'), false);
    const blocked = await upload(call, created.body.token, pdfBytes('disabled'));
    assert.equal(blocked.status, 404);
    assert.equal(blocked.body.error.code, 'not_found');
  });
});

test('hosting on unblocks password sessions while records stay moved', async () => {
  await withApp({ AI_HOSTING_ENABLED: 'true', CONFLUENCE_ONLY: 'true' }, async (mf, call) => {
    const withoutInvite = await call('POST', '/v1/auth/register', { body: { username: 'ada', password: PASSWORD } });
    assert.equal(withoutInvite.status, 400);
    assert.equal(withoutInvite.body.error.code, 'invalid_request');
    const badInvite = await call('POST', '/v1/auth/register', { body: { username: 'ada', password: PASSWORD, inviteCode: 'not-an-invitation' } });
    assert.equal(badInvite.status, 403);
    assert.equal(badInvite.body.error.code, 'invalid_invitation');
    const created = await register(mf, call, 'ada');
    assert.equal(created.status, 201, 'invitation-only registration still works');
    const first = await login(call, 'ada');
    assert.equal(first.status, 200, 'login is not blocked by CONFLUENCE_ONLY');
    const changed = await call('POST', '/v1/auth/password', {
      token: first.body.token,
      body: { currentPassword: PASSWORD, newPassword: NEXT },
    });
    assert.equal(changed.status, 200);
    const second = await login(call, 'ada', NEXT);
    assert.equal(second.status, 200);
    const loggedOut = await call('POST', '/v1/logout', { token: second.body.token });
    assert.equal(loggedOut.status, 200);
    const write = await call('POST', '/v1/records', { token: created.body.token, body: { kind: 'harness', payload: {} } });
    assert.equal(write.status, 410);
    assert.equal(write.body.error.code, 'storage_moved');
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.equal(capabilities.status, 200, 'the capability probe needs no session');
    assert.equal(capabilities.body.enabled, true);
    assert.equal(JSON.stringify(capabilities.body).includes('token'), false);

    const d1 = await mf.getD1Database('DB');
    const author = await d1.prepare('SELECT id FROM authors WHERE username = ?1').bind('ada').first();
    await d1.prepare("UPDATE team_members SET status = 'revoked', revoked_at = ?1 WHERE author_id = ?2")
      .bind(new Date().toISOString(), author.id).run();
    const fresh = await login(call, 'ada', NEXT);
    assert.equal(fresh.status, 403);
    assert.equal(fresh.body.error.code, 'membership_required', 'membership is still required');
  });
});

test('Confluence owner comes from the resolved accountId, never the site cloudId', async () => {
  await withApp({ ...CONFLUENCE_ENV, AI_MAX_UPLOAD_BYTES: '4096' }, async (mf, call) => {
    const alpha = confluenceSession({ accountId: 'acct-alpha' });
    const body = pdfBytes('confluence-alpha');
    const first = await upload(call, alpha, body, { name: 'paper one.pdf' });
    assert.equal(first.status, 201);
    assert.equal(first.body.upload.name, 'paper one.pdf');
    assert.equal(first.body.upload.deduplicated, false);
    assert.equal(first.body.upload.sha256, sha256(body));
    const d1 = await mf.getD1Database('DB');
    const stored = await d1.prepare('SELECT owner_id FROM ai_uploads WHERE id = ?1').bind(first.body.upload.id).first();
    assert.equal(stored.owner_id, atlOwner(CLOUD, 'acct-alpha'));
    assert.equal(stored.owner_id.length, 'atl:'.length + 64);
    assert.notEqual(stored.owner_id, `atl:${sha256(CLOUD)}`, 'cloudId alone is not an owner');

    const replay = await upload(call, alpha, body, { name: 'renamed.pdf' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.upload.deduplicated, true);
    assert.equal(replay.body.upload.id, first.body.upload.id, 'same identity maps to the same owner');

    const beta = confluenceSession({ accountId: 'acct-beta' });
    const other = await upload(call, beta, body, { name: 'paper one.pdf' });
    assert.equal(other.status, 201);
    assert.notEqual(other.body.upload.id, first.body.upload.id, 'same site, different account is a different owner');
    const betaRow = await d1.prepare('SELECT owner_id FROM ai_uploads WHERE id = ?1').bind(other.body.upload.id).first();
    assert.equal(betaRow.owner_id, atlOwner(CLOUD, 'acct-beta'));

    // Hosted execution needs no archive parent and readiness: only the current-user lookup was made.
    const atlas = await d1.prepare("SELECT path FROM ai_stub_calls WHERE host = 'api.atlassian.com'").all();
    assert.ok(atlas.results.length >= 2);
    assert.ok(atlas.results.every(row => row.path.endsWith('/wiki/rest/api/user/current')));
    assert.equal(JSON.stringify(first.body).includes('leak@example.test'), false);
    assert.equal(JSON.stringify(first.body).includes('Leak Name'), false);
    assert.equal(await stubCalls(mf, '/internal/v1/uploads', 'POST'), 2, 'dedup never re-forwards the file');
  });
});

test('an unresolved Confluence identity is a fixed 401/503 with a requestId', async () => {
  const cases = [
    { mode: 'identity-no-account', status: 401, code: 'unauthorized', retryable: false },
    { mode: 'identity-forbidden', status: 401, code: 'unauthorized', retryable: false },
    { mode: 'identity-down', status: 503, code: 'ai_unavailable', retryable: true },
  ];
  for (const item of cases) {
    await withApp({ ...CONFLUENCE_ENV, AI_STUB_MODE: item.mode }, async (mf, call) => {
      const res = await upload(call, confluenceSession(), pdfBytes(item.mode));
      assert.equal(res.status, item.status, item.mode);
      assert.equal(res.body.error.code, item.code, item.mode);
      assert.equal(res.body.error.retryable, item.retryable, item.mode);
      assert.match(res.body.error.requestId, /^req_[0-9a-f]{32}$/);
      assert.equal(res.body.error.message.length > 0, true);
      assert.equal(res.text.includes('leak@example.test'), false);
      assert.equal(res.text.includes('Leak Name'), false);
      const d1 = await mf.getD1Database('DB');
      assert.equal((await d1.prepare('SELECT COUNT(*) AS count FROM ai_uploads').first()).count, 0);
    });
  }
  await withApp({ ...CONFLUENCE_ENV }, async (mf, call) => {
    const garbage = await upload(call, 'not-a-sealed-session', pdfBytes('garbage'));
    assert.equal(garbage.status, 401);
    assert.equal(garbage.body.error.code, 'unauthorized');
    const invitation = await upload(call, 'fsi_' + 'a'.repeat(43), pdfBytes('invite'));
    assert.equal(invitation.status, 401);
    const missing = await upload(call, null, pdfBytes('missing'));
    assert.equal(missing.status, 401);
  });
});

test('uploads enforce size, mime, name, ownership and metadata-only storage', async () => {
  await withApp({ AI_HOSTING_ENABLED: 'true', CONFLUENCE_ONLY: 'false', AI_MAX_UPLOAD_BYTES: '64' }, async (mf, call) => {
    const ada = await register(mf, call, 'uploader');
    const token = ada.body.token;
    const bytes = pdfBytes('upload-metadata');
    const first = await upload(call, token, bytes);
    assert.equal(first.status, 201);
    assert.deepEqual(Object.keys(first.body.upload).sort(), ['bytes', 'createdAt', 'deduplicated', 'id', 'mime', 'name', 'sha256']);
    assert.equal(first.body.upload.bytes, bytes.byteLength);

    const dedup = await upload(call, token, bytes, { name: 'other-name.pdf' });
    assert.equal(dedup.status, 200);
    assert.equal(dedup.body.upload.deduplicated, true);
    assert.equal(dedup.body.upload.id, first.body.upload.id);
    assert.equal(dedup.body.upload.name, first.body.upload.name);

    const bea = await register(mf, call, 'uploader2');
    const other = await upload(call, bea.body.token, bytes);
    assert.equal(other.status, 201);
    assert.notEqual(other.body.upload.id, first.body.upload.id);

    const oversize = await upload(call, token, Buffer.alloc(200, 0x41));
    assert.equal(oversize.status, 413);
    assert.equal(oversize.body.error.code, 'payload_too_large');
    const badType = await upload(call, token, pdfBytes('html'), { mime: 'text/html' });
    assert.equal(badType.status, 415);
    assert.equal(badType.body.error.code, 'unsupported_media_type');
    const noName = await call('POST', '/v1/ai/uploads', { token, raw: pdfBytes('noname'), headers: { 'Content-Type': 'application/pdf' } });
    assert.equal(noName.status, 400);
    const empty = await upload(call, token, Buffer.alloc(0));
    assert.equal(empty.status, 400);
    const unauthenticated = await upload(call, null, pdfBytes('anon'));
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.body.error.requestId, /^req_[0-9a-f]{32}$/);

    const d1 = await mf.getD1Database('DB');
    const columns = await d1.prepare('PRAGMA table_info(ai_uploads)').all();
    const names = columns.results.map(row => row.name);
    assert.deepEqual(names.sort(), ['bytes', 'created_at', 'id', 'mime', 'name', 'owner_id', 'runtime_upload_id', 'sha256']);
    assert.equal(names.includes('content'), false);
    assert.equal(names.includes('payload'), false);
    const rows = await d1.prepare('SELECT COUNT(*) AS count FROM ai_uploads').first();
    assert.equal(rows.count, 2);
    // No file bytes reach the index: the largest text column holds a name or a hash only.
    const stored = await d1.prepare('SELECT name, sha256 FROM ai_uploads ORDER BY created_at').all();
    for (const row of stored.results) {
      assert.ok(row.name.length <= 200);
      assert.match(row.sha256, /^[a-f0-9]{64}$/);
    }
  });
});

test('job idempotency, validation, clamping and active-job cap', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '1',
    AI_MAX_CALLS_PER_JOB: '4',
    AI_DEFAULT_CALLS: '3',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'jobowner');
    const bea = await register(mf, call, 'jobother');
    const uploadA = await upload(call, ada.body.token, pdfBytes('job-a'));
    const uploadB = await upload(call, bea.body.token, pdfBytes('job-b'));
    assert.equal(uploadA.status, 201);
    assert.equal(uploadB.status, 201);

    const body = jobBody(uploadA.body.upload.id, { budget: { maxCalls: 99 } });
    const created = await postJob(call, ada.body.token, body);
    assert.equal(created.status, 202);
    assert.equal(created.body.replayed, false);
    assert.equal(created.body.job.state, 'queued');
    assert.equal(created.body.job.role, 'red');
    assert.equal(created.body.job.model, 'claude-sonnet-5-5');
    assert.equal(created.body.job.effort, 'high');
    assert.equal(created.body.job.progress.requiredCalls, 4, 'the server hard budget wins');
    const jobId = created.body.job.id;

    const replay = await postJob(call, ada.body.token, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.job.id, jobId);
    assert.equal(replay.body.job.state, 'running', 'a replay reads the live runtime state, not only the index');
    assert.equal(replay.body.job.result.findings[0].marker, 'RESULT-MARKER', 'a replay returns the live result');
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1, 'a replay never creates a second job');
    assert.ok((await stubCalls(mf, `/internal/v1/jobs/${jobId}`, 'GET')) >= 1, 'the replay is a read, never a paid call');

    const conflict = await postJob(call, ada.body.token, { ...body, prompt: 'A different synthetic instruction.' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'idempotency_conflict');
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1);

    const capped = await postJob(call, ada.body.token, { ...body, idempotencyKey: 'op-synthetic-0002' });
    assert.equal(capped.status, 429);
    assert.equal(capped.body.error.code, 'rate_limited');
    assert.ok(Number(capped.headers.get('Retry-After')) > 0);

    const d1 = await mf.getD1Database('DB');
    const stubJob = await d1.prepare('SELECT max_calls FROM ai_stub_jobs WHERE id = ?1').bind(jobId).first();
    assert.equal(stubJob.max_calls, 4);
    const indexRow = await d1.prepare('SELECT snapshot, state FROM ai_jobs WHERE id = ?1').bind(jobId).first();
    assert.equal(indexRow.state, 'running', 'the replay persists the refreshed state');
    assert.equal(indexRow.snapshot.includes('Review this synthetic paper'), false, 'no prompt is stored');
    assert.equal(indexRow.snapshot.includes('result'), false, 'no result body is stored');
    assert.equal(indexRow.snapshot.includes('RESULT-MARKER'), false, 'no analysis text is stored');

    const invalid = [
      [{ role: 'green' }, 'role'],
      [{ prompt: '   ' }, 'empty prompt'],
      [{ prompt: 'x'.repeat(9000) }, 'long prompt'],
      [{ uploadId: uploadB.body.upload.id }, 'foreign upload'],
      [{ uploadId: '11111111-1111-4111-8111-111111111112' }, 'unknown upload'],
      [{ model: 'gpt-synthetic' }, 'model allowlist'],
      [{ effort: 'ultra' }, 'effort allowlist'],
      [{ idempotencyKey: 'short' }, 'idempotency key'],
      [{ budget: { maxCalls: 0 } }, 'budget'],
      [{ budget: { maxCalls: 2, unlimited: true } }, 'budget keys'],
      [{ harness: { schema: 'falsify.harness.v1', endpoint: 'https://evil.test' } }, 'harness endpoint'],
      [{ harness: { schema: 'falsify.harness.v1', adapter: { type: 'http', url: 'https://evil.test' } } }, 'harness adapter'],
    ];
    for (const [override, label] of invalid) {
      const res = await postJob(call, ada.body.token, { ...body, idempotencyKey: 'op-invalid-0001', ...override });
      assert.equal(res.status, 400, label);
      assert.equal(res.body.error.code, 'invalid_request', label);
      assert.equal(res.text.includes('evil.test'), false, label);
    }
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1);
    assert.equal((await d1.prepare('SELECT COUNT(*) AS count FROM ai_jobs').first()).count, 1);
  });
});

test('active-job cap reconciles with the runtime instead of leaking abandoned rows', async () => {
  const bindings = {
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '1',
  };

  await withApp(bindings, async (mf, call) => {
    const ada = await register(mf, call, 'reconciler');
    const up = await upload(call, ada.body.token, pdfBytes('reconcile'));
    const d1 = await mf.getD1Database('DB');
    const author = await d1.prepare('SELECT id FROM authors WHERE username = ?1').bind('reconciler').first();
    const ownerId = `usr:${author.id}`;
    const staleId = '55555555-5555-4555-8555-555555555555';
    // The index says running, but the runtime finished that job long ago.
    await seedGatewayJob(mf, { id: staleId, ownerId, state: 'running' });
    const at = new Date().toISOString();
    await d1.prepare(
      'INSERT INTO ai_stub_jobs (id, owner_id, state, upload_id, model, effort, max_calls, prompt, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
    ).bind(staleId, ownerId, 'completed', 'rt-seeded', 'claude-sonnet-5-5', 'high', 3, 'synthetic', at).run();

    const created = await postJob(call, ada.body.token, jobBody(up.body.upload.id, { idempotencyKey: 'op-reconcile-0001' }));
    assert.equal(created.status, 202, 'a finished stale row must not hold the cap');
    const stale = await d1.prepare('SELECT state, snapshot FROM ai_jobs WHERE id = ?1').bind(staleId).first();
    assert.equal(stale.state, 'completed');
    assert.equal(stale.snapshot.includes('RESULT-MARKER'), false, 'reconciliation stores no analysis text');
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1, 'only the new job is submitted');
  });

  await withApp(bindings, async (mf, call) => {
    const ada = await register(mf, call, 'unreconciled');
    const up = await upload(call, ada.body.token, pdfBytes('unreconciled'));
    const d1 = await mf.getD1Database('DB');
    const author = await d1.prepare('SELECT id FROM authors WHERE username = ?1').bind('unreconciled').first();
    const staleId = '66666666-6666-4666-8666-666666666666';
    // The runtime does not know this row, so reconciliation fails and the row must stay untouched.
    await seedGatewayJob(mf, { id: staleId, ownerId: `usr:${author.id}`, state: 'running' });
    const res = await postJob(call, ada.body.token, jobBody(up.body.upload.id, { idempotencyKey: 'op-reconcile-0002' }));
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'rate_limited');
    const stale = await d1.prepare('SELECT state FROM ai_jobs WHERE id = ?1').bind(staleId).first();
    assert.equal(stale.state, 'running', 'a reconciliation error leaves the index unchanged');
    const leaked = await d1.prepare('SELECT COUNT(*) AS count FROM ai_jobs WHERE idempotency_key = ?1').bind('op-reconcile-0002').first();
    assert.equal(leaked.count, 0, 'the refused submission is rolled back');
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 0);
  });
});

test('a replayed submit falls back to the stored snapshot when the runtime is unreachable', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_STUB_MODE: 'runtime-down',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'fallback');
    const d1 = await mf.getD1Database('DB');
    const author = await d1.prepare('SELECT id FROM authors WHERE username = ?1').bind('fallback').first();
    const ownerId = `usr:${author.id}`;
    const at = new Date().toISOString();
    const prompt = 'Review this synthetic paper and list contradictions.';
    const model = 'claude-sonnet-5-5';
    const effort = 'high';
    const maxCalls = 5;
    const seededId = '77777777-7777-4777-8777-777777777777';
    const requestHash = createHash('sha256')
      .update(JSON.stringify(['red', prompt, UUID_A, model, effort, maxCalls])).digest('hex');
    const snapshot = {
      id: seededId,
      role: 'red',
      state: 'running',
      progress: { completedCalls: 1, requiredCalls: maxCalls, phase: 'analyzing' },
      model,
      effort,
      provider: 'anthropic',
      usage: { inputTokens: 5, outputTokens: 3 },
      artifacts: [],
      createdAt: at,
      updatedAt: at,
    };
    await d1.prepare('INSERT INTO ai_uploads (id, owner_id, sha256, name, mime, bytes, runtime_upload_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(UUID_A, ownerId, 'b'.repeat(64), 'paper.pdf', 'application/pdf', 10, 'rt-seeded', at).run();
    await d1.prepare(
      `INSERT INTO ai_jobs (id, owner_id, role, idempotency_key, request_hash, upload_id, model, effort, state, snapshot, created_at, updated_at)
       VALUES (?1, ?2, 'red', ?3, ?4, ?5, ?6, ?7, 'running', ?8, ?9, ?9)`
    ).bind(seededId, ownerId, 'op-fallback-0001', requestHash, UUID_A, model, effort, JSON.stringify(snapshot), at).run();

    const replay = await postJob(call, ada.body.token, {
      role: 'red', prompt, uploadId: UUID_A, idempotencyKey: 'op-fallback-0001', model, effort, budget: { maxCalls },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.job.id, seededId);
    assert.equal(replay.body.job.state, 'running', 'the stored snapshot is used when the runtime is down');
    assert.equal(replay.body.job.result, undefined);
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 0, 'no job is ever created by a replay');
    assert.ok((await stubCalls(mf, `/internal/v1/jobs/${seededId}`, 'GET')) >= 1, 'the live read was attempted');
  });
});

test('status, cancel and artifact proxy stay owner-only', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '5',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'statusowner');
    const bea = await register(mf, call, 'statusother');
    const up = await upload(call, ada.body.token, pdfBytes('status'));
    const created = await postJob(call, ada.body.token, jobBody(up.body.upload.id));
    assert.equal(created.status, 202);
    const jobId = created.body.job.id;

    const status = await call('GET', `/v1/ai/jobs/${jobId}`, { token: ada.body.token });
    assert.equal(status.status, 200);
    assert.equal(status.body.job.state, 'running');
    assert.equal(status.body.job.progress.completedCalls, 2);
    assert.equal(status.body.job.usage.inputTokens, 11);
    assert.equal(status.body.job.result.findings[0].marker, 'RESULT-MARKER');
    assert.equal(status.body.job.artifacts[0].id, 'artifact-1');
    assert.equal(status.body.job.provider, 'anthropic');

    const d1 = await mf.getD1Database('DB');
    const indexed = await d1.prepare('SELECT state, snapshot FROM ai_jobs WHERE id = ?1').bind(jobId).first();
    assert.equal(indexed.state, 'running');
    assert.equal(indexed.snapshot.includes('RESULT-MARKER'), false, 'analysis text is not persisted');

    const beforeForeign = await d1.prepare('SELECT COUNT(*) AS count FROM ai_stub_calls').first();
    for (const [method, pathname] of [
      ['GET', `/v1/ai/jobs/${jobId}`],
      ['POST', `/v1/ai/jobs/${jobId}/cancel`],
      ['GET', `/v1/ai/jobs/${jobId}/artifacts/artifact-1`],
    ]) {
      const res = await call(method, pathname, { token: bea.body.token });
      assert.equal(res.status, 404, `${method} ${pathname}`);
      assert.equal(res.body.error.code, 'not_found');
    }
    const afterForeign = await d1.prepare('SELECT COUNT(*) AS count FROM ai_stub_calls').first();
    assert.equal(afterForeign.count, beforeForeign.count, 'owner isolation never reaches the runtime');

    const cancelled = await call('POST', `/v1/ai/jobs/${jobId}/cancel`, { token: ada.body.token });
    assert.equal(cancelled.status, 202);
    assert.equal(cancelled.body.job.state, 'cancelling');

    const artifact = await call('GET', `/v1/ai/jobs/${jobId}/artifacts/artifact-1`, { token: ada.body.token });
    assert.equal(artifact.status, 200);
    assert.equal(artifact.headers.get('Content-Type'), 'application/json');
    assert.match(artifact.headers.get('Content-Disposition'), /^attachment; filename="review\.json"$/);
    assert.equal(artifact.headers.get('Cache-Control'), 'no-store');
    const payload = JSON.parse(artifact.text);
    assert.equal(payload.marker, 'ARTIFACT-BYTES');
    assert.match(payload.owner, /^usr:[0-9a-f-]{36}$/, 'the runtime receives the resolved owner');

    for (const pathname of [
      '/v1/ai/jobs/not-a-uuid',
      `/v1/ai/jobs/${jobId}/artifacts/${encodeURIComponent('../etc/passwd')}`,
      '/v1/ai/jobs/22222222-2222-4222-8222-222222222222',
    ]) {
      const res = await call('GET', pathname, { token: ada.body.token });
      assert.equal(res.status, 404, pathname);
    }
    const missingArtifact = await call('GET', `/v1/ai/jobs/${jobId}/artifacts/does-not-exist`, { token: ada.body.token });
    assert.equal(missingArtifact.status, 404);
  });
});

test('runtime outage is 503 ai_unavailable and never a fabricated state', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_STUB_MODE: 'runtime-down',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'outage');
    const token = ada.body.token;
    const up = await upload(call, token, pdfBytes('outage'));
    assert.equal(up.status, 503);
    assert.equal(up.body.error.code, 'ai_unavailable');
    assert.equal(up.body.error.retryable, true);
    assert.match(up.body.error.requestId, /^req_[0-9a-f]{32}$/);
    assert.equal(up.text.includes('down'), false);

    const d1 = await mf.getD1Database('DB');
    const author = await d1.prepare('SELECT id FROM authors WHERE username = ?1').bind('outage').first();
    const ownerId = `usr:${author.id}`;
    const at = new Date().toISOString();
    await d1.prepare('INSERT INTO ai_uploads (id, owner_id, sha256, name, mime, bytes, runtime_upload_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(UUID_A, ownerId, 'a'.repeat(64), 'paper.pdf', 'application/pdf', 10, 'rt-seeded', at).run();
    await seedGatewayJob(mf, { id: '33333333-3333-4333-8333-333333333333', ownerId });

    const job = await postJob(call, token, jobBody(UUID_A, { idempotencyKey: 'op-outage-0001' }));
    assert.equal(job.status, 503);
    assert.equal(job.body.error.code, 'ai_unavailable');
    assert.equal((await d1.prepare('SELECT COUNT(*) AS count FROM ai_jobs WHERE idempotency_key = ?1').bind('op-outage-0001').first()).count, 0);

    const status = await call('GET', '/v1/ai/jobs/33333333-3333-4333-8333-333333333333', { token });
    assert.equal(status.status, 503);
    assert.equal(status.body.error.code, 'ai_unavailable');
    const cancel = await call('POST', '/v1/ai/jobs/33333333-3333-4333-8333-333333333333/cancel', { token });
    assert.equal(cancel.status, 503);
    const artifact = await call('GET', '/v1/ai/jobs/33333333-3333-4333-8333-333333333333/artifacts/artifact-1', { token });
    assert.equal(artifact.status, 503);
    const unchanged = await d1.prepare('SELECT state FROM ai_jobs WHERE id = ?1').bind('33333333-3333-4333-8333-333333333333').first();
    assert.equal(unchanged.state, 'queued', 'no state is invented while the runtime is down');
  });

  // A runtime that lost a job this gateway owns is unavailable, not a fabricated 404 or state.
  await withApp({ AI_HOSTING_ENABLED: 'true', CONFLUENCE_ONLY: 'false' }, async (mf, call) => {
    const ada = await register(mf, call, 'lost');
    const d1 = await mf.getD1Database('DB');
    const author = await d1.prepare('SELECT id FROM authors WHERE username = ?1').bind('lost').first();
    const ownerId = `usr:${author.id}`;
    await seedGatewayJob(mf, { id: '44444444-4444-4444-8444-444444444444', ownerId });
    const status = await call('GET', '/v1/ai/jobs/44444444-4444-4444-8444-444444444444', { token: ada.body.token });
    assert.equal(status.status, 503);
    assert.equal(status.body.error.code, 'ai_unavailable');
  });
});

test('per-owner rate limits are configurable and isolated', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_UPLOADS_PER_OWNER_HOUR: '2',
    AI_JOBS_PER_OWNER_HOUR: '2',
    AI_ACTIVE_JOBS_PER_OWNER: '5',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'limited');
    const bea = await register(mf, call, 'unlimited');
    const upA = await upload(call, ada.body.token, pdfBytes('limit-1'));
    const upA2 = await upload(call, ada.body.token, pdfBytes('limit-2'));
    assert.equal(upA.status, 201);
    assert.equal(upA2.status, 201);
    const limitedUpload = await upload(call, ada.body.token, pdfBytes('limit-3'));
    assert.equal(limitedUpload.status, 429);
    assert.equal(limitedUpload.body.error.code, 'rate_limited');
    assert.ok(Number(limitedUpload.headers.get('Retry-After')) > 0);
    const beaUpload = await upload(call, bea.body.token, pdfBytes('limit-3'));
    assert.equal(beaUpload.status, 201, 'limits are per owner');

    const first = await postJob(call, ada.body.token, jobBody(upA.body.upload.id, { idempotencyKey: 'op-limit-0001' }));
    assert.equal(first.status, 202);
    const second = await postJob(call, ada.body.token, jobBody(upA.body.upload.id, { idempotencyKey: 'op-limit-0002' }));
    assert.equal(second.status, 202);
    const third = await postJob(call, ada.body.token, jobBody(upA.body.upload.id, { idempotencyKey: 'op-limit-0003' }));
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'rate_limited');
    const otherJob = await postJob(call, bea.body.token, jobBody(beaUpload.body.upload.id, { idempotencyKey: 'op-limit-0001' }));
    assert.equal(otherJob.status, 202, 'job limits are per owner');
  });
});

test('CORS allows the upload headers and still rejects foreign origins', async () => {
  await withApp({ AI_HOSTING_ENABLED: 'true', CONFLUENCE_ONLY: 'false' }, async (mf, call) => {
    const preflight = await call('OPTIONS', '/v1/ai/uploads', {
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-falsify-file-name',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    const allowedHeaders = preflight.headers.get('Access-Control-Allow-Headers');
    for (const header of ['authorization', 'content-type', 'x-falsify-file-name']) {
      assert.match(allowedHeaders, new RegExp(header.replace('-', '\\-')));
    }
    assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /POST/);
    assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /GET/);
    assert.equal(preflight.headers.get('Cache-Control'), 'no-store');
    const probeFlight = await call('OPTIONS', '/v1/ai/capabilities', {
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(probeFlight.status, 204);
    assert.equal(probeFlight.headers.get('Access-Control-Allow-Origin'), ORIGIN);

    // Preflight on every AI route is answered before authentication, for the configured origin only.
    for (const pathname of ['/v1/ai/jobs', `/v1/ai/jobs/${UUID_A}`, `/v1/ai/jobs/${UUID_A}/cancel`, `/v1/ai/jobs/${UUID_A}/artifacts/artifact-1`]) {
      const flight = await call('OPTIONS', pathname, { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
      assert.equal(flight.status, 204, pathname);
      assert.equal(flight.headers.get('Access-Control-Allow-Origin'), ORIGIN, pathname);
      assert.match(flight.headers.get('Access-Control-Allow-Headers'), /x-falsify-file-name/, pathname);
    }

    const evil = await call('POST', '/v1/ai/uploads', {
      raw: pdfBytes('evil'),
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/pdf', 'X-Falsify-File-Name': 'a.pdf' },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error.code, 'origin_not_allowed');
    assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);

    const evilProbe = await call('GET', '/v1/ai/capabilities', { headers: { Origin: 'https://evil.example' } });
    assert.equal(evilProbe.status, 403, 'the origin gate still protects the public probe');
    assert.equal(evilProbe.headers.get('Access-Control-Allow-Origin'), null);

    const created = await register(mf, call, 'cors');
    const capabilities = await call('GET', '/v1/ai/capabilities', { headers: { Origin: ORIGIN } });
    assert.equal(capabilities.status, 200, 'capabilities need no bearer');
    assert.equal(capabilities.body.enabled, true);
    assert.equal(capabilities.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(capabilities.headers.get('Vary'), 'Origin');
    assert.equal(JSON.stringify(capabilities.body).includes(created.body.token), false);
  });
});

test('RED edit selection is validated, forwarded and part of the idempotency hash', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '8',
    AI_MAX_CALLS_PER_JOB: '8',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'editor');
    const up = await upload(call, ada.body.token, pdfBytes('edit-selection'));
    const body = jobBody(up.body.upload.id, {
      idempotencyKey: 'op-edits-0001',
      edits: [TEXT_EDIT],
      visualEdits: [TABLE_EDIT, CHART_EDIT],
      useEvidence: false,
      budget: { maxCalls: 5 },
    });
    const created = await postJob(call, ada.body.token, body);
    assert.equal(created.status, 202);
    const jobId = created.body.job.id;
    const payload = await stubJobPayload(mf, jobId);
    assert.deepEqual(payload.edits, [{ pageIndex: 0, before: '12.4%', after: '14.1%', occurrence: 0, id: 'edit-1' }]);
    assert.deepEqual(payload.visualEdits, [TABLE_EDIT, CHART_EDIT]);
    assert.equal(payload.useEvidence, false);
    assert.equal(payload.applyOnly, undefined, 'the default is omitted from the wire');
    assert.deepEqual(payload.budget, { maxCalls: 5 });
    assert.equal(payload.harness.maxCalls, 5);
    assert.deepEqual(Object.keys(payload).sort(), [
      'budget', 'effort', 'harness', 'idempotencyKey', 'jobId', 'model', 'ownerId',
      'prompt', 'requestHash', 'role', 'uploadId', 'edits', 'visualEdits', 'useEvidence',
    ].sort());

    const replay = await postJob(call, ada.body.token, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1);

    const changed = await postJob(call, ada.body.token, { ...body, edits: [{ ...TEXT_EDIT, after: '14.2%' }] });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'idempotency_conflict');
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1, 'a changed selection is a different request');

    const other = await postJob(call, ada.body.token, {
      ...body, idempotencyKey: 'op-edits-0002', edits: [{ ...TEXT_EDIT, after: '14.2%' }],
    });
    assert.equal(other.status, 202);
    assert.notEqual(other.body.job.id, jobId, 'a changed selection is a new job');

    const cancel = await call('POST', `/v1/ai/jobs/${jobId}/cancel`, { token: ada.body.token });
    assert.equal(cancel.status, 202);
    assert.equal(cancel.body.job.state, 'cancelling');

    // D1 never stores the prompt, the selection or the RED rationale.
    const d1 = await mf.getD1Database('DB');
    const rows = await d1.prepare('SELECT snapshot FROM ai_jobs').all();
    const stored = rows.results.map(row => row.snapshot).join('\n');
    assert.equal(stored.includes('Align table with prose.'), false);
    assert.equal(stored.includes('Align chart with prose.'), false);
    assert.equal(stored.includes('Review this synthetic paper'), false);
    assert.equal(stored.includes('12.4%'), false);
  });
});

test('edit and apply-only validation is strict', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '10',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'strictred');
    const bea = await register(mf, call, 'strictblue');
    const redUpload = await upload(call, ada.body.token, pdfBytes('strict-red'));
    const blueUpload = await upload(call, bea.body.token, pdfBytes('strict-blue'));
    const base = jobBody(redUpload.body.upload.id, { idempotencyKey: 'op-strict-0001' });
    const many = Array.from({ length: 101 }, (_, i) => ({ pageIndex: 0, before: `a${i}`, after: `b${i}` }));
    const manyVisual = Array.from({ length: 25 }, (_, i) => ({ ...TABLE_EDIT, itemId: `table-${i}` }));
    const cases = [
      [{ edits: many }, 'more than 100 text edits'],
      [{ visualEdits: manyVisual }, 'more than 24 visual edits'],
      [{ edits: [{ ...TEXT_EDIT, executable: '/bin/sh' }] }, 'text edit executable'],
      [{ edits: [{ ...TEXT_EDIT, apiKey: 'sk-synthetic' }] }, 'text edit apiKey'],
      [{ edits: [{ ...TEXT_EDIT, path: '../../etc/passwd' }] }, 'text edit path'],
      [{ visualEdits: [{ ...TABLE_EDIT, command: 'rm -rf /' }] }, 'visual edit command'],
      [{ visualEdits: [{ ...TABLE_EDIT, kind: 'region' }] }, 'unsupported visual kind'],
      [{ visualEdits: [{ kind: 'table-cell', itemId: 't', row: 0, column: 0, before: 'a', after: 'b' }] }, 'missing rationale'],
      [{ visualEdits: [{ ...CHART_EDIT, beforeY: '12.4' }] }, 'non numeric chart value'],
      [{ visualEdits: [{ ...CHART_EDIT, afterY: 12.4 }] }, 'unchanged chart value'],
      [{ edits: [{ before: 'a', after: 'b' }] }, 'missing pageIndex'],
      [{ edits: [{ ...TEXT_EDIT, bbox: [0, 0, 1] }] }, 'short bbox'],
      [{ edits: [{ ...TEXT_EDIT, after: TEXT_EDIT.before }] }, 'identical replacement'],
      [{ useEvidence: 'yes' }, 'non boolean useEvidence'],
      [{ applyOnly: 'yes' }, 'non boolean applyOnly'],
      [{ applyOnly: true }, 'apply-only without edits'],
      [{ applyOnly: true, edits: [TEXT_EDIT], budget: { maxCalls: 5 } }, 'apply-only with a call budget'],
      [{ role: 'blue', uploadId: blueUpload.body.upload.id, applyOnly: true, edits: [TEXT_EDIT] }, 'apply-only for BLUE'],
      [{ role: 'blue', uploadId: blueUpload.body.upload.id, edits: [TEXT_EDIT] }, 'edits for BLUE'],
      [{ role: 'blue', uploadId: blueUpload.body.upload.id, visualEdits: [TABLE_EDIT] }, 'visual edits for BLUE'],
    ];
    for (const [override, label] of cases) {
      const res = await postJob(call, ada.body.token, { ...base, ...override });
      assert.equal(res.status, 400, label);
      assert.equal(res.body.error.code, 'invalid_request', label);
      assert.equal(res.text.includes('sk-synthetic'), false, label);
      assert.equal(res.text.includes('/bin/sh'), false, label);
    }
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 0, 'invalid selections never reach the runtime');
  });
});

test('apply-only RED jobs carry a zero call budget and still cancel', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '5',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'applyonly');
    const up = await upload(call, ada.body.token, pdfBytes('apply-only'));
    const created = await postJob(call, ada.body.token, {
      ...jobBody(up.body.upload.id, { idempotencyKey: 'op-apply-0001' }),
      applyOnly: true,
      edits: [TEXT_EDIT],
      budget: { maxCalls: 0 },
    });
    assert.equal(created.status, 202);
    assert.equal(created.body.job.progress.requiredCalls, 0);
    assert.equal(created.body.job.state, 'queued');
    const payload = await stubJobPayload(mf, created.body.job.id);
    assert.equal(payload.applyOnly, true);
    assert.deepEqual(payload.budget, { maxCalls: 0 });
    assert.equal(payload.harness.maxCalls, 0);
    assert.deepEqual(payload.edits, [{ pageIndex: 0, before: '12.4%', after: '14.1%', occurrence: 0, id: 'edit-1' }]);
    assert.equal(payload.visualEdits, undefined);

    const replay = await postJob(call, ada.body.token, {
      ...jobBody(up.body.upload.id, { idempotencyKey: 'op-apply-0001' }),
      applyOnly: true,
      edits: [TEXT_EDIT],
      budget: { maxCalls: 0 },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.job.id, created.body.job.id);
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1);

    const cancel = await call('POST', `/v1/ai/jobs/${created.body.job.id}/cancel`, { token: ada.body.token });
    assert.equal(cancel.status, 202);
    assert.equal(cancel.body.job.state, 'cancelling');
  });
});

test('edited.pdf streams to the owner and re-uploads unchanged as a BLUE input', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '6',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'handoff');
    const bea = await register(mf, call, 'handoffother');
    const up = await upload(call, ada.body.token, pdfBytes('handoff-source'));
    const red = await postJob(call, ada.body.token, jobBody(up.body.upload.id, {
      idempotencyKey: 'op-handoff-0001',
      edits: [TEXT_EDIT],
      visualEdits: [TABLE_EDIT],
    }));
    assert.equal(red.status, 202);
    const jobId = red.body.job.id;

    const status = await call('GET', `/v1/ai/jobs/${jobId}`, { token: ada.body.token });
    assert.equal(status.status, 200);
    const editedMeta = status.body.job.artifacts.find(item => item.name === 'edited.pdf');
    assert.ok(editedMeta, 'the RED job lists edited.pdf');
    assert.equal(editedMeta.mime, 'application/pdf');

    const artifact = await call('GET', `/v1/ai/jobs/${jobId}/artifacts/edited-pdf-1`, { token: ada.body.token });
    assert.equal(artifact.status, 200);
    assert.equal(artifact.headers.get('Content-Type'), 'application/pdf');
    assert.equal(artifact.headers.get('Content-Disposition'), 'attachment; filename="edited.pdf"');
    assert.equal(artifact.headers.get('Cache-Control'), 'no-store');
    assert.equal(new TextDecoder().decode(artifact.bytes.subarray(0, 5)), '%PDF-');
    const digest = createHash('sha256').update(Buffer.from(artifact.bytes)).digest('hex');
    assert.equal(digest, editedMeta.sha256, 'the proxied bytes match the listed artifact hash');

    const foreign = await call('GET', `/v1/ai/jobs/${jobId}/artifacts/edited-pdf-1`, { token: bea.body.token });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.text.includes('ART-MARK'), false);

    // The exact edited bytes go back through the unchanged upload path as a BLUE input.
    const blueUpload = await upload(call, ada.body.token, Buffer.from(artifact.bytes), { name: 'edited.pdf', mime: 'application/pdf' });
    assert.equal(blueUpload.status, 201);
    assert.equal(blueUpload.body.upload.sha256, digest);
    assert.equal(blueUpload.body.upload.bytes, artifact.bytes.byteLength);

    const blue = await postJob(call, ada.body.token, {
      role: 'blue',
      prompt: 'Review the edited PDF.',
      uploadId: blueUpload.body.upload.id,
      idempotencyKey: 'op-handoff-blue-0001',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      budget: { maxCalls: 3 },
    });
    assert.equal(blue.status, 202);
    const payload = await stubJobPayload(mf, blue.body.job.id);
    assert.equal(payload.role, 'blue');
    assert.equal(payload.edits, undefined, 'RED edits never reach BLUE');
    assert.equal(payload.visualEdits, undefined);
    assert.equal(payload.applyOnly, undefined);
    assert.equal(payload.prompt, 'Review the edited PDF.');
    assert.equal(JSON.stringify(payload).includes('12.4%'), false);
    assert.equal(JSON.stringify(payload).includes('Align table with prose.'), false);

    const d1 = await mf.getD1Database('DB');
    const storedUpload = await d1.prepare('SELECT id, sha256, name, mime, bytes FROM ai_uploads WHERE id = ?1')
      .bind(blueUpload.body.upload.id).first();
    assert.equal(storedUpload.sha256, digest);
    assert.equal(storedUpload.name, 'edited.pdf');
    assert.equal(storedUpload.mime, 'application/pdf');
    assert.equal(JSON.stringify(storedUpload).includes('rationale'), false);

    const blueRow = await d1.prepare('SELECT snapshot FROM ai_jobs WHERE id = ?1').bind(blue.body.job.id).first();
    assert.equal(blueRow.snapshot.includes('Review the edited PDF.'), false);
    assert.equal(blueRow.snapshot.includes('Align table with prose.'), false);
    assert.equal(blueRow.snapshot.includes('12.4%'), false);
  });
});

test('owner token budget gates model jobs on recorded usage and skips apply-only', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '8',
    AI_OWNER_TOKEN_BUDGET: '100',
    AI_TOKEN_WINDOW_SECONDS: '3600',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'budget');
    const up = await upload(call, ada.body.token, pdfBytes('budget'));
    const d1 = await mf.getD1Database('DB');
    const author = await d1.prepare('SELECT id FROM authors WHERE username = ?1').bind('budget').first();
    const ownerId = `usr:${author.id}`;

    const first = await postJob(call, ada.body.token, jobBody(up.body.upload.id, { idempotencyKey: 'op-budget-0001' }));
    assert.equal(first.status, 202, 'no recorded usage is under budget');
    await d1.prepare("UPDATE ai_stub_jobs SET state = 'completed' WHERE id = ?1").bind(first.body.job.id).run();
    const done = await call('GET', `/v1/ai/jobs/${first.body.job.id}`, { token: ada.body.token });
    assert.equal(done.status, 200);
    assert.equal(done.body.job.state, 'completed');
    const usageRow = await d1.prepare(
      'SELECT input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, usage_recorded_at FROM ai_jobs WHERE id = ?1'
    ).bind(first.body.job.id).first();
    assert.deepEqual(
      [usageRow.input_tokens, usageRow.output_tokens, usageRow.cache_read_input_tokens, usageRow.cache_creation_input_tokens],
      [11, 7, 2, 3],
      'terminal provider usage is recorded'
    );
    assert.equal(typeof usageRow.usage_recorded_at, 'string');
    assert.equal(await ownerUsage(mf, ownerId), 23);

    const reread = await call('GET', `/v1/ai/jobs/${first.body.job.id}`, { token: ada.body.token });
    assert.equal(reread.status, 200);
    const rereadRow = await d1.prepare('SELECT usage_recorded_at FROM ai_jobs WHERE id = ?1').bind(first.body.job.id).first();
    assert.equal(rereadRow.usage_recorded_at, usageRow.usage_recorded_at, 'usage is recorded once');
    assert.equal(await ownerUsage(mf, ownerId), 23, 'a re-read never double counts');

    const second = await postJob(call, ada.body.token, jobBody(up.body.upload.id, { idempotencyKey: 'op-budget-0002' }));
    assert.equal(second.status, 202);

    await seedUsageJob(mf, { id: '88888888-8888-4888-8888-888888888888', ownerId, input: 90 });
    assert.equal(await ownerUsage(mf, ownerId), 113);
    const blocked = await postJob(call, ada.body.token, jobBody(up.body.upload.id, { idempotencyKey: 'op-budget-0003' }));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'owner_budget_exhausted');
    assert.equal(blocked.body.error.retryable, true);
    assert.match(blocked.body.error.requestId, /^req_[0-9a-f]{32}$/);
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
    assert.equal(
      (await d1.prepare("SELECT COUNT(*) AS count FROM ai_jobs WHERE idempotency_key = 'op-budget-0003'").first()).count,
      0,
      'an over-budget submission reserves nothing'
    );
    // A duplicate of an existing job creates no spend, so the gate must not block the replay.
    const replayCompleted = await postJob(call, ada.body.token, jobBody(up.body.upload.id, { idempotencyKey: 'op-budget-0001' }));
    assert.equal(replayCompleted.status, 200);
    assert.equal(replayCompleted.body.replayed, true);
    assert.equal(replayCompleted.body.job.id, first.body.job.id);

    // Apply-only makes no model calls, so the token gate does not block it.
    const applyOnly = await postJob(call, ada.body.token, {
      ...jobBody(up.body.upload.id, { idempotencyKey: 'op-budget-apply-0001', budget: { maxCalls: 0 } }),
      applyOnly: true,
      edits: [TEXT_EDIT],
    });
    assert.equal(applyOnly.status, 202);
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 3, 'apply-only still reaches the runtime');

    // A new window only sees usage recorded inside it.
    const old = new Date(Date.now() - 2 * 3600e3).toISOString();
    await d1.prepare('UPDATE ai_jobs SET usage_recorded_at = ?1 WHERE id = ?2')
      .bind(old, '88888888-8888-4888-8888-888888888888').run();
    await d1.prepare('UPDATE ai_jobs SET usage_recorded_at = ?1 WHERE id = ?2').bind(old, first.body.job.id).run();
    assert.equal(await ownerUsage(mf, ownerId), 113, 'all-time recorded usage is unchanged');
    const nextWindow = await postJob(call, ada.body.token, jobBody(up.body.upload.id, { idempotencyKey: 'op-budget-0004' }));
    assert.equal(nextWindow.status, 202, 'the previous window no longer counts');
  });
});

test('migration 0004 and wrangler keep the policy defaults inert', () => {
  const migration = readFileSync(path.join(apiRoot, 'migrations', '0003_hosted_ai.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE ai_uploads/);
  assert.match(migration, /CREATE TABLE ai_jobs/);
  assert.match(migration, /CREATE UNIQUE INDEX ai_jobs_owner_idempotency/);
  assert.match(migration, /CREATE UNIQUE INDEX ai_uploads_owner_sha/);
  assert.equal(migration.includes('api_key'), false);
  const usage = readFileSync(path.join(apiRoot, 'migrations', '0004_owner_usage.sql'), 'utf8');
  assert.match(usage, /ALTER TABLE ai_jobs ADD COLUMN input_tokens/);
  assert.match(usage, /ALTER TABLE ai_jobs ADD COLUMN cache_read_input_tokens/);
  assert.match(usage, /ADD COLUMN usage_recorded_at TEXT/);
  assert.match(usage, /CREATE INDEX ai_jobs_owner_usage_recorded/);
  assert.equal(usage.includes('api_key'), false);
  assert.equal(/ADD COLUMN .*balance/i.test(usage), false, 'no fabricated balance column is stored');
  const wrangler = readFileSync(path.join(apiRoot, 'wrangler.jsonc'), 'utf8');
  assert.equal(wrangler.split('"AI_HOSTING_ENABLED": "false"').length, 3);
  assert.equal(wrangler.split('"AI_OWNER_TOKEN_BUDGET": "0"').length, 3);
  assert.equal(wrangler.split('"AI_TOKEN_WINDOW_SECONDS": "86400"').length, 3);
  assert.equal(wrangler.includes('"AI_HOSTING_ENABLED": "true"'), false);
  assert.equal(/"HOSTED_AI_SERVICE_TOKEN"\s*:/.test(wrangler), false, 'the service token is a secret, never a var');
  assert.equal(/"ANTHROPIC_API_KEY"\s*:/.test(wrangler), false);
  assert.equal(wrangler.includes('sk-ant-'), false);
  assert.match(wrangler, /"AI_RUNTIME_URL": ""/);
  assert.match(wrangler, /"AI_MAX_UPLOAD_BYTES": "33554432"/);
  assert.equal(wrangler.split('"CONFLUENCE_ONLY": "true"').length, 3);
});
