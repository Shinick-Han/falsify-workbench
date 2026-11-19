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
import { aiSettings, providerForModel } from '../src/ai-gateway.mjs';

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
  const providerField = () => {
    const reported = String((env && env.AI_STUB_PROVIDER) || '');
    if (reported === 'omit') return {};
    return { provider: reported || 'anthropic' };
  };
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
      ...providerField(),
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
      ...providerField(),
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
      ...providerField(),
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
  if (requestUrl.pathname === '/internal/v1/paper' && method === 'POST') {
    const payloadText = typeof init.body === 'string' ? init.body : '';
    if (db) {
      await db.prepare('INSERT INTO ai_stub_paper (owner_header, service_token, payload) VALUES (?1, ?2, ?3)')
        .bind(headers.get('X-Falsify-Owner-Id') || '', headers.get('X-Falsify-Service-Token') || '', payloadText)
        .run();
    }
    let payload = {};
    try { payload = JSON.parse(payloadText); } catch { payload = {}; }
    const probe = payload && payload.body && payload.body.stub;
    if (probe === 'throw') throw new Error('socket');
    if (probe === 'malformed') return new Response('not-json', { status: 500 });
    if (probe === 'bad-code') return reply(400, { error: { code: 'Not_A_Code', detail: 'secret paper text' } });
    if (probe === 'long-code') return reply(400, { error: { code: 'a'.repeat(65) } });
    if (probe === 'error') return reply(400, { error: { code: 'paper_evidence_expired_or_missing', message: 'secret paper text' } });
    if (probe === 'busy') return reply(429, { error: { code: 'paper_busy' } });
    if (probe === 'visual') return reply(400, { error: { code: 'visual_region_invalid' } });
    if (probe === 'analysis') return reply(429, { error: { code: 'analysis_busy' } });
    if (probe === 'unsupported') return reply(404, { error: { code: 'paper_path_unsupported' } });
    return reply(200, { marker: 'PAPER-OK', echoed: payload });
  }
  return new Response('unmocked', { status: 404 });
}

const STUB_TABLES = [
  'CREATE TABLE ai_stub_calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, path TEXT NOT NULL, method TEXT NOT NULL)',
  'CREATE TABLE ai_stub_uploads (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL)',
  'CREATE TABLE ai_stub_jobs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, state TEXT NOT NULL, upload_id TEXT NOT NULL, model TEXT, effort TEXT, max_calls INTEGER, prompt TEXT, created_at TEXT NOT NULL, payload TEXT)',
  'CREATE TABLE ai_stub_paper (seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_header TEXT NOT NULL, service_token TEXT NOT NULL, payload TEXT NOT NULL)',
];

function migrationStatements() {
  const sql = ['0001_shared_records.sql', '0002_invite_membership.sql', '0003_hosted_ai.sql', '0004_owner_usage.sql', '0005_guest_sessions.sql']
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
      limits: { maxUploadBytes: 4096, maxPromptChars: 32000 },
      openAccess: { enabled: false, accessKeyRequired: false },
      modelProviders: {
        'claude-opus-5-5': 'anthropic',
        'claude-sonnet-5-5': 'anthropic',
        'claude-haiku-5-5': 'anthropic',
      },
      blueJobs: true,
      modelJobs: true,
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
    assert.equal(capped.headers.get('Access-Control-Expose-Headers'), 'X-Falsify-Confluence-Session, Retry-After');

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
      [{ prompt: 'x'.repeat(32001) }, 'long prompt'],
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

  await withApp({ ...bindings, AI_STUB_MODE: 'runtime-down' }, async (mf, call) => {
    const ada = await register(mf, call, 'unreconciled');
    const d1 = await mf.getD1Database('DB');
    const author = await d1.prepare('SELECT id FROM authors WHERE username = ?1').bind('unreconciled').first();
    const ownerId = `usr:${author.id}`;
    const at = new Date().toISOString();
    // The upload is seeded directly: the runtime is unreachable in this scenario.
    await d1.prepare('INSERT INTO ai_uploads (id, owner_id, sha256, name, mime, bytes, runtime_upload_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(UUID_A, ownerId, 'b'.repeat(64), 'paper.pdf', 'application/pdf', 10, 'rt-seeded', at).run();
    const staleId = '66666666-6666-4666-8666-666666666666';
    // The runtime is unreachable, so reconciliation cannot refresh the row and it must stay untouched.
    await seedGatewayJob(mf, { id: staleId, ownerId, state: 'running' });
    const res = await postJob(call, ada.body.token, jobBody(UUID_A, { idempotencyKey: 'op-reconcile-0002' }));
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'rate_limited');
    const stale = await d1.prepare('SELECT state FROM ai_jobs WHERE id = ?1').bind(staleId).first();
    assert.equal(stale.state, 'running', 'a runtime outage leaves the index unchanged');
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
      useEvidence: false,
      budget: { maxCalls: 5 },
    });
    const created = await postJob(call, ada.body.token, body);
    assert.equal(created.status, 202);
    const jobId = created.body.job.id;
    assert.equal(created.body.job.applyOnly, false);
    assert.equal(created.body.job.useEvidence, false, 'request flags are projected into the snapshot');
    const payload = await stubJobPayload(mf, jobId);
    assert.deepEqual(payload.edits, [{ pageIndex: 0, before: '12.4%', after: '14.1%', occurrence: 0, id: 'edit-1' }]);
    assert.equal(payload.visualEdits, undefined, 'visual edits require the apply-only path');
    assert.equal(payload.useEvidence, false);
    assert.equal(payload.applyOnly, undefined, 'the default is omitted from the wire');
    assert.deepEqual(payload.budget, { maxCalls: 5 });
    assert.equal(payload.harness.maxCalls, 5);
    assert.deepEqual(Object.keys(payload).sort(), [
      'budget', 'effort', 'harness', 'idempotencyKey', 'jobId', 'model', 'ownerId',
      'prompt', 'requestHash', 'role', 'uploadId', 'edits', 'useEvidence',
    ].sort());

    const replay = await postJob(call, ada.body.token, body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.job.applyOnly, false);
    assert.equal(replay.body.job.useEvidence, false, 'a replay keeps the request flags');
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
    const manyVisual = Array.from({ length: 13 }, (_, i) => ({ ...TABLE_EDIT, itemId: `table-${i}` }));
    const twelveVisual = Array.from({ length: 12 }, (_, i) => ({ ...TABLE_EDIT, itemId: `table-${i}` }));
    const cases = [
      [{ edits: many }, 'more than 100 text edits'],
      [{ applyOnly: true, visualEdits: manyVisual, edits: [TEXT_EDIT] }, 'more than 12 visual edits'],
      [{ visualEdits: [TABLE_EDIT] }, 'visual edits without apply-only'],
      [{ edits: [{ ...TEXT_EDIT, executable: '/bin/sh' }] }, 'text edit executable'],
      [{ edits: [{ ...TEXT_EDIT, apiKey: 'sk-synthetic' }] }, 'text edit apiKey'],
      [{ edits: [{ ...TEXT_EDIT, path: '../../etc/passwd' }] }, 'text edit path'],
      [{ applyOnly: true, visualEdits: [{ ...TABLE_EDIT, command: 'rm -rf /' }] }, 'visual edit command'],
      [{ applyOnly: true, visualEdits: [{ ...TABLE_EDIT, kind: 'region' }] }, 'unsupported visual kind'],
      [{ applyOnly: true, visualEdits: [{ kind: 'table-cell', itemId: 't', row: 0, column: 0, before: 'a', after: 'b' }] }, 'missing rationale'],
      [{ applyOnly: true, visualEdits: [{ ...CHART_EDIT, beforeY: '12.4' }] }, 'non numeric chart value'],
      [{ applyOnly: true, visualEdits: [{ ...CHART_EDIT, afterY: 12.4 }] }, 'unchanged chart value'],
      [{ edits: [{ before: 'a', after: 'b' }] }, 'missing pageIndex'],
      [{ edits: [{ ...TEXT_EDIT, bbox: [0, 0, 1] }] }, 'short bbox'],
      [{ edits: [{ ...TEXT_EDIT, after: TEXT_EDIT.before }] }, 'identical replacement'],
      [{ useEvidence: 'yes' }, 'non boolean useEvidence'],
      [{ applyOnly: 'yes' }, 'non boolean applyOnly'],
      [{ applyOnly: true }, 'apply-only without edits'],
      [{ applyOnly: true, edits: [TEXT_EDIT], budget: { maxCalls: 5 } }, 'apply-only with a call budget'],
      [{ role: 'blue', uploadId: blueUpload.body.upload.id, applyOnly: true, edits: [TEXT_EDIT] }, 'apply-only for BLUE'],
      [{ role: 'blue', uploadId: blueUpload.body.upload.id, edits: [TEXT_EDIT] }, 'edits for BLUE'],
      [{ role: 'blue', uploadId: blueUpload.body.upload.id, applyOnly: true, visualEdits: [TABLE_EDIT] }, 'visual edits for BLUE'],
    ];
    for (const [override, label] of cases) {
      const res = await postJob(call, ada.body.token, { ...base, ...override });
      assert.equal(res.status, 400, label);
      assert.equal(res.body.error.code, 'invalid_request', label);
      assert.equal(res.text.includes('sk-synthetic'), false, label);
      assert.equal(res.text.includes('/bin/sh'), false, label);
    }
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 0, 'invalid selections never reach the runtime');

    // Twelve coordinated visual operations is the runtime limit and must be accepted.
    const atLimit = await postJob(call, ada.body.token, {
      role: 'red',
      prompt: 'Review this synthetic paper and list contradictions.',
      uploadId: redUpload.body.upload.id,
      idempotencyKey: 'op-strict-0012',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      budget: { maxCalls: 0 },
      applyOnly: true,
      visualEdits: twelveVisual,
    });
    assert.equal(atLimit.status, 202, '12 visual edits are accepted');
    assert.equal((await stubJobPayload(mf, atLimit.body.job.id)).visualEdits.length, 12);
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1);
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
      visualEdits: [TABLE_EDIT],
      budget: { maxCalls: 0 },
    });
    assert.equal(created.status, 202);
    assert.equal(created.body.job.progress.requiredCalls, 0);
    assert.equal(created.body.job.state, 'queued');
    assert.equal(created.body.job.applyOnly, true, 'apply-only is projected into the snapshot');
    assert.equal(created.body.job.useEvidence, true, 'useEvidence defaults to true');
    const payload = await stubJobPayload(mf, created.body.job.id);
    assert.equal(payload.applyOnly, true);
    assert.deepEqual(payload.budget, { maxCalls: 0 });
    assert.equal(payload.harness.maxCalls, 0);
    assert.deepEqual(payload.edits, [{ pageIndex: 0, before: '12.4%', after: '14.1%', occurrence: 0, id: 'edit-1' }]);
    assert.deepEqual(payload.visualEdits, [TABLE_EDIT], 'visual edits are accepted on the apply-only path');

    const replay = await postJob(call, ada.body.token, {
      ...jobBody(up.body.upload.id, { idempotencyKey: 'op-apply-0001' }),
      applyOnly: true,
      edits: [TEXT_EDIT],
      visualEdits: [TABLE_EDIT],
      budget: { maxCalls: 0 },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.job.id, created.body.job.id);
    assert.equal(replay.body.job.applyOnly, true, 'a replay keeps applyOnly');
    assert.equal(replay.body.job.useEvidence, true, 'a replay keeps the useEvidence default');
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

test('an unpolled terminal job blocks the next submit once its usage is reconciled', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '5',
    AI_OWNER_TOKEN_BUDGET: '20',
    AI_TOKEN_WINDOW_SECONDS: '3600',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'unpolled');
    const up = await upload(call, ada.body.token, pdfBytes('unpolled'));
    const d1 = await mf.getD1Database('DB');

    // Job A finishes in the runtime, but the client never polls it.
    const first = await postJob(call, ada.body.token, jobBody(up.body.upload.id, { idempotencyKey: 'op-unpolled-0001' }));
    assert.equal(first.status, 202);
    await d1.prepare("UPDATE ai_stub_jobs SET state = 'completed' WHERE id = ?1").bind(first.body.job.id).run();
    const before = await d1.prepare('SELECT usage_recorded_at FROM ai_jobs WHERE id = ?1').bind(first.body.job.id).first();
    assert.equal(before.usage_recorded_at, null, 'nothing is recorded until the gateway observes it');

    // The next submit reconciles the owner's active rows first, sees the spent 23 tokens, and refuses.
    const blocked = await postJob(call, ada.body.token, jobBody(up.body.upload.id, { idempotencyKey: 'op-unpolled-0002' }));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'owner_budget_exhausted');
    const recorded = await d1.prepare(
      'SELECT state, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens FROM ai_jobs WHERE id = ?1'
    ).bind(first.body.job.id).first();
    assert.equal(recorded.state, 'completed', 'reconciliation recorded the terminal state');
    assert.deepEqual(
      [recorded.input_tokens, recorded.output_tokens, recorded.cache_read_input_tokens, recorded.cache_creation_input_tokens],
      [11, 7, 2, 3]
    );
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1, 'the blocked submit never created a job');
    assert.equal(
      (await d1.prepare("SELECT COUNT(*) AS count FROM ai_jobs WHERE idempotency_key = 'op-unpolled-0002'").first()).count,
      0,
      'the refused submission is rolled back'
    );
  });
});

test('a runtime 404 for an indexed job becomes terminal interrupted, not a permanent 503', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '5',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'lostjob');
    const other = await register(mf, call, 'lostother');
    const up = await upload(call, ada.body.token, pdfBytes('lost-job'));
    const created = await postJob(call, ada.body.token, jobBody(up.body.upload.id, { idempotencyKey: 'op-lost-0001' }));
    assert.equal(created.status, 202);
    const jobId = created.body.job.id;
    const d1 = await mf.getD1Database('DB');
    // The runtime loses the job (restart or state loss).
    await d1.prepare('DELETE FROM ai_stub_jobs WHERE id = ?1').bind(jobId).run();

    const status = await call('GET', `/v1/ai/jobs/${jobId}`, { token: ada.body.token });
    assert.equal(status.status, 200, 'a lost job is terminal, not a permanent 503');
    assert.equal(status.body.job.state, 'interrupted');
    assert.equal(status.body.job.failure.code, 'runtime_job_missing');
    assert.equal(status.body.job.failure.retryable, false);
    const row = await d1.prepare('SELECT state FROM ai_jobs WHERE id = ?1').bind(jobId).first();
    assert.equal(row.state, 'interrupted', 'the index stops retrying the lost job');

    const again = await call('GET', `/v1/ai/jobs/${jobId}`, { token: ada.body.token });
    assert.equal(again.status, 200);
    assert.equal(again.body.job.state, 'interrupted');

    const cancel = await call('POST', `/v1/ai/jobs/${jobId}/cancel`, { token: ada.body.token });
    assert.equal(cancel.status, 202);
    assert.equal(cancel.body.job.state, 'interrupted', 'cancel is idempotent for a lost job');

    const artifact = await call('GET', `/v1/ai/jobs/${jobId}/artifacts/artifact-1`, { token: ada.body.token });
    assert.equal(artifact.status, 404, 'a missing artifact is a consistent 404');

    const foreign = await call('GET', `/v1/ai/jobs/${jobId}`, { token: other.body.token });
    assert.equal(foreign.status, 404, 'owner isolation is unchanged');
  });
});

test('long prompts and larger job bodies are accepted within the configured cap', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '6',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'longprompt');
    const up = await upload(call, ada.body.token, pdfBytes('long-prompt'));
    const uploadId = up.body.upload.id;

    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.limits.maxPromptChars, 32000, 'the default prompt cap is 32000');

    // The legacy 8000-character limit is not mandatory: a complete long BLUE prompt is accepted.
    const longPrompt = 'Review this synthetic paper. '.padEnd(9000, 'x');
    assert.equal(longPrompt.length, 9000);
    const accepted = await postJob(call, ada.body.token, jobBody(uploadId, {
      idempotencyKey: 'op-long-0001',
      prompt: longPrompt,
    }));
    assert.equal(accepted.status, 202);
    assert.equal((await stubJobPayload(mf, accepted.body.job.id)).prompt.length, 9000);

    // Apply-only keeps the same prompt handling and the zero call budget.
    const applyOnly = await postJob(call, ada.body.token, {
      ...jobBody(uploadId, { idempotencyKey: 'op-long-apply-0001', prompt: longPrompt, budget: { maxCalls: 0 } }),
      applyOnly: true,
      edits: [TEXT_EDIT],
    });
    assert.equal(applyOnly.status, 202);
    assert.equal(applyOnly.body.job.progress.requiredCalls, 0);

    const tooLong = await postJob(call, ada.body.token, jobBody(uploadId, {
      idempotencyKey: 'op-long-too-0001',
      prompt: 'x'.repeat(32001),
    }));
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, 'invalid_request');
  });

  // A body above the old 64 KiB limit but under 256 KiB is accepted; a body above 256 KiB is 413.
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_ACTIVE_JOBS_PER_OWNER: '2',
    AI_MAX_PROMPT_CHARS: '200000',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'bigbody');
    const up = await upload(call, ada.body.token, pdfBytes('big-body'));
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.equal(capabilities.body.limits.maxPromptChars, 200000, 'the env override is reflected');

    const large = await postJob(call, ada.body.token, jobBody(up.body.upload.id, {
      idempotencyKey: 'op-big-0001',
      prompt: 'y'.repeat(70000),
    }));
    assert.equal(large.status, 202, 'a job body above the old 64 KiB limit is accepted');

    const oversized = await postJob(call, ada.body.token, jobBody(up.body.upload.id, {
      idempotencyKey: 'op-big-0002',
      prompt: 'z'.repeat(300000),
    }));
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error.code, 'payload_too_large', 'the body limit stays an explicit bound');
  });
});

test('migration 0004 and deployed wrangler keep credentials secret and usage policy optional', () => {
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
  // production, staging and the guest-only event environment.
  assert.equal(wrangler.split('"AI_HOSTING_ENABLED": "true"').length, 4);
  assert.equal(wrangler.split('"AI_OWNER_TOKEN_BUDGET": "0"').length, 4);
  assert.equal(wrangler.split('"AI_TOKEN_WINDOW_SECONDS": "86400"').length, 4);
  assert.equal(/"AI_OPEN_ACCESS_KEY"\s*:/.test(wrangler), false, 'the event access key is a secret, never a var');
  assert.equal(/"HOSTED_AI_SERVICE_TOKEN"\s*:/.test(wrangler), false, 'the service token is a secret, never a var');
  assert.equal(/"ANTHROPIC_API_KEY"\s*:/.test(wrangler), false);
  assert.equal(wrangler.includes('sk-ant-'), false);
  assert.match(wrangler, /"AI_RUNTIME_URL": "https:\/\/falsify-runtime\.shinick\.dev\/production"/);
  assert.match(wrangler, /"AI_RUNTIME_URL": "https:\/\/falsify-runtime\.shinick\.dev\/staging"/);
  assert.match(wrangler, /"AI_MAX_UPLOAD_BYTES": "33554432"/);
  assert.equal(wrangler.split('"CONFLUENCE_ONLY": "true"').length, 4);
});

const GUEST_TOKEN = /^fsg_[A-Za-z0-9_-]{43}$/;
const ACCESS_KEY = 'booth-example-key';
const OTHER_GUEST = 'gst:33333333-3333-4333-8333-333333333333';

function mintGuest(c, accessKey, headers = {}) {
  const body = accessKey === undefined ? {} : { accessKey };
  return c('POST', '/v1/ai/guest', { body, headers });
}

const fromIp = address => ({ 'CF-Connecting-IP': address });

async function guestRow(instance, token) {
  const d1 = await instance.getD1Database('DB');
  return d1.prepare('SELECT token_hash, guest_id, created_at, expires_at, revoked_at FROM guest_sessions WHERE token_hash = ?1')
    .bind(sha256(token)).first();
}

test('open access off rejects guest minting and every fsg bearer', async () => {
  const issued = await withApp({
    AI_HOSTING_ENABLED: 'true',
    AI_OPEN_ACCESS: 'true',
    CONFLUENCE_ONLY: 'false',
  }, async (mf, call) => {
    const minted = await mintGuest(call);
    assert.equal(minted.status, 201);
    return minted.body.guest.token;
  });

  await withApp({
    AI_HOSTING_ENABLED: 'true',
    AI_OPEN_ACCESS: 'false',
    AI_OPEN_ACCESS_KEY: ACCESS_KEY,
    CONFLUENCE_ONLY: 'false',
  }, async (mf, call) => {
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.enabled, true);
    assert.deepEqual(capabilities.body.openAccess, { enabled: false, accessKeyRequired: false });
    assert.equal(JSON.stringify(capabilities.body).includes(ACCESS_KEY), false);

    const minted = await mintGuest(call, ACCESS_KEY);
    assert.equal(minted.status, 403);
    assert.equal(minted.body.error.code, 'open_access_disabled');
    assert.equal(minted.body.error.retryable, false);
    assert.equal(typeof minted.body.error.requestId, 'string');
    assert.equal(JSON.stringify(minted.body).includes(ACCESS_KEY), false);

    for (const token of [issued, 'fsg_' + 'a'.repeat(43), 'fsg_short']) {
      const denied = await upload(call, token, pdfBytes('closed-' + token.length));
      assert.equal(denied.status, 403, token.slice(0, 12));
      assert.equal(denied.body.error.code, 'open_access_disabled');
      assert.equal(JSON.stringify(denied.body).includes(token), false);
    }

    const ada = await register(mf, call, 'stillada');
    const allowed = await upload(call, ada.body.token, pdfBytes('password-stays'));
    assert.equal(allowed.status, 201, 'password owners keep the hosted routes');
  });

  await withApp({ AI_HOSTING_ENABLED: 'false', AI_OPEN_ACCESS: 'true', CONFLUENCE_ONLY: 'false' }, async (mf, call) => {
    const hidden = await mintGuest(call);
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body.error.code, 'not_found');
    const probe = await call('GET', '/v1/ai/capabilities');
    assert.equal(probe.body.enabled, false);
    assert.equal(probe.body.openAccess.enabled, true, 'the flag is reported even while hosting routes are absent');
  });
});

test('a guest session is hashed, expires, and runs jobs as gst', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    AI_OPEN_ACCESS: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_GUEST_SESSION_SECONDS: '3600',
    AI_GUEST_MAX_CALLS_PER_JOB: '8',
    AI_MAX_CALLS_PER_JOB: '24',
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '3',
    AI_GUEST_JOBS_PER_OWNER_HOUR: '6',
    AI_GUESTS_PER_IP_HOUR: '10',
  }, async (mf, call) => {
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.deepEqual(capabilities.body.openAccess, { enabled: true, accessKeyRequired: false });
    assert.equal(JSON.stringify(capabilities.body).includes(ACCESS_KEY), false);

    const minted = await mintGuest(call);
    assert.equal(minted.status, 201);
    assert.equal(minted.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(Object.keys(minted.body).sort(), ['guest']);
    assert.deepEqual(Object.keys(minted.body.guest).sort(), ['expiresAt', 'token']);
    const token = minted.body.guest.token;
    assert.match(token, GUEST_TOKEN);
    const expiresAt = Date.parse(minted.body.guest.expiresAt);
    assert.ok(Math.abs(expiresAt - (Date.now() + 3600 * 1000)) < 10000);

    const row = await guestRow(mf, token);
    assert.equal(row.token_hash, sha256(token));
    assert.match(row.guest_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(row.revoked_at, null);
    assert.equal(JSON.stringify(row).includes(token), false);
    const ownerId = `gst:${row.guest_id}`;

    const up = await upload(call, token, pdfBytes('guest-round-trip'));
    assert.equal(up.status, 201);
    const d1 = await mf.getD1Database('DB');
    const stored = await d1.prepare('SELECT owner_id FROM ai_uploads WHERE id = ?1').bind(up.body.upload.id).first();
    assert.equal(stored.owner_id, ownerId);

    const capped = await postJob(call, token, jobBody(up.body.upload.id, {
      idempotencyKey: 'op-guest-capped-01',
      budget: { maxCalls: 20 },
    }));
    assert.equal(capped.status, 202);
    assert.equal(capped.body.job.progress.requiredCalls, 8);
    const stub = await d1.prepare('SELECT owner_id, max_calls FROM ai_stub_jobs WHERE id = ?1').bind(capped.body.job.id).first();
    assert.equal(stub.owner_id, ownerId);
    assert.equal(stub.max_calls, 8);

    const defaults = await postJob(call, token, jobBody(up.body.upload.id, {
      idempotencyKey: 'op-guest-default-1',
      budget: undefined,
    }));
    assert.equal(defaults.status, 202);
    assert.equal(defaults.body.job.progress.requiredCalls, 8);

    const revoked = await mintGuest(call);
    const revokedToken = revoked.body.guest.token;
    await d1.prepare('UPDATE guest_sessions SET revoked_at = ?1 WHERE token_hash = ?2')
      .bind(Date.now(), sha256(revokedToken)).run();
    const revokedUpload = await upload(call, revokedToken, pdfBytes('revoked-guest'));
    assert.equal(revokedUpload.status, 401);
    assert.equal(revokedUpload.body.error.code, 'unauthorized');

    await d1.prepare('UPDATE guest_sessions SET expires_at = ?1 WHERE token_hash = ?2')
      .bind(Date.now() - 1000, sha256(token)).run();
    const expired = await upload(call, token, pdfBytes('expired-guest'));
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error.code, 'unauthorized');

    const unknown = await upload(call, 'fsg_' + 'b'.repeat(43), pdfBytes('unknown-guest'));
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.code, 'unauthorized');
    const malformed = await upload(call, 'fsg_short', pdfBytes('malformed-guest'));
    assert.equal(malformed.status, 401);
    assert.equal(malformed.body.error.code, 'unauthorized');
  });
});

test('guest minting requires the access key only when one is configured', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    AI_OPEN_ACCESS: 'true',
    AI_OPEN_ACCESS_KEY: ACCESS_KEY,
    CONFLUENCE_ONLY: 'false',
    AI_GUESTS_PER_IP_HOUR: '10',
  }, async (mf, call) => {
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.deepEqual(capabilities.body.openAccess, { enabled: true, accessKeyRequired: true });
    assert.equal(JSON.stringify(capabilities.body).includes(ACCESS_KEY), false);

    const missing = await mintGuest(call);
    assert.equal(missing.status, 403);
    assert.equal(missing.body.error.code, 'invalid_access_key');
    assert.equal(missing.body.error.retryable, false);
    const wrong = await mintGuest(call, 'wrong-example-key');
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, 'invalid_access_key');
    assert.equal(JSON.stringify(wrong.body).includes('wrong-example-key'), false);
    const right = await mintGuest(call, ACCESS_KEY);
    assert.equal(right.status, 201);
    assert.match(right.body.guest.token, GUEST_TOKEN);
    assert.equal(JSON.stringify(right.body).includes(ACCESS_KEY), false);

    const tooLong = await mintGuest(call, 'k'.repeat(129));
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, 'invalid_request');
    const extra = await call('POST', '/v1/ai/guest', { body: { accessKey: ACCESS_KEY, note: 'synthetic-marker' } });
    assert.equal(extra.status, 400);
    assert.equal(JSON.stringify(extra.body).includes('synthetic-marker'), false);
    const text = await call('POST', '/v1/ai/guest', { raw: '{}', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(text.status, 415);
    const huge = await mintGuest(call, 'k'.repeat(2000));
    assert.equal(huge.status, 413);
    assert.equal(huge.body.error.code, 'payload_too_large');

    const get = await call('GET', '/v1/ai/guest');
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('Allow'), 'POST');
    const preflight = await call('OPTIONS', '/v1/ai/guest', {
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    const evil = await call('POST', '/v1/ai/guest', {
      body: {},
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error.code, 'origin_not_allowed');
  });
});

test('guest mint caps are per IP and global', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    AI_OPEN_ACCESS: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_GUESTS_PER_IP_HOUR: '1',
    AI_GUESTS_PER_HOUR: '10',
  }, async (mf, call) => {
    const first = await mintGuest(call, undefined, fromIp('203.0.113.10'));
    assert.equal(first.status, 201);
    const again = await mintGuest(call, undefined, fromIp('203.0.113.10'));
    assert.equal(again.status, 429);
    assert.equal(again.body.error.code, 'rate_limited');
    assert.match(again.headers.get('Retry-After'), /^[1-9][0-9]*$/);
    const other = await mintGuest(call, undefined, fromIp('203.0.113.11'));
    assert.equal(other.status, 201);
  });

  await withApp({
    AI_HOSTING_ENABLED: 'true',
    AI_OPEN_ACCESS: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_GUESTS_PER_IP_HOUR: '10',
    AI_GUESTS_PER_HOUR: '2',
  }, async (mf, call) => {
    assert.equal((await mintGuest(call, undefined, fromIp('203.0.113.21'))).status, 201);
    assert.equal((await mintGuest(call, undefined, fromIp('203.0.113.22'))).status, 201);
    const blocked = await mintGuest(call, undefined, fromIp('203.0.113.23'));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
  });
});

test('guest work caps leave password and Confluence owners on their own limits', async () => {
  await withApp({
    ...CONFLUENCE_ENV,
    CONFLUENCE_ONLY: 'false',
    AI_HOSTING_ENABLED: 'true',
    AI_OPEN_ACCESS: 'true',
    AI_GUESTS_PER_IP_HOUR: '10',
    AI_GUEST_UPLOADS_PER_OWNER_HOUR: '1',
    AI_UPLOADS_PER_OWNER_HOUR: '4',
    AI_GUEST_JOBS_PER_OWNER_HOUR: '5',
    AI_JOBS_PER_OWNER_HOUR: '4',
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '1',
    AI_ACTIVE_JOBS_PER_OWNER: '3',
    AI_GUEST_JOBS_PER_HOUR: '2',
    AI_GUEST_MAX_CALLS_PER_JOB: '8',
    AI_MAX_CALLS_PER_JOB: '4',
  }, async (mf, call) => {
    const alpha = confluenceSession({ accountId: 'acct-guest-limit' });
    const guestA = (await mintGuest(call)).body.guest.token;
    const guestB = (await mintGuest(call)).body.guest.token;
    const guestC = (await mintGuest(call)).body.guest.token;
    const ada = await register(mf, call, 'capada');

    const firstUpload = await upload(call, guestA, pdfBytes('guest-a'));
    assert.equal(firstUpload.status, 201);
    const secondUpload = await upload(call, guestA, pdfBytes('guest-a-again'));
    assert.equal(secondUpload.status, 429);
    const passwordUploads = [
      await upload(call, ada.body.token, pdfBytes('ada-1')),
      await upload(call, ada.body.token, pdfBytes('ada-2')),
    ];
    assert.deepEqual(passwordUploads.map(item => item.status), [201, 201]);
    const confluenceUpload = await upload(call, alpha, pdfBytes('confluence-stays'));
    assert.equal(confluenceUpload.status, 201);
    const d1 = await mf.getD1Database('DB');
    const confluenceOwner = await d1.prepare('SELECT owner_id FROM ai_uploads WHERE id = ?1').bind(confluenceUpload.body.upload.id).first();
    assert.equal(confluenceOwner.owner_id, atlOwner(CLOUD, 'acct-guest-limit'));
    assert.equal(confluenceOwner.owner_id.startsWith('gst:'), false);

    const uploadB = await upload(call, guestB, pdfBytes('guest-b'));
    const uploadC = await upload(call, guestC, pdfBytes('guest-c'));
    assert.equal(uploadB.status, 201);
    assert.equal(uploadC.status, 201);

    const jobA = await postJob(call, guestA, jobBody(firstUpload.body.upload.id, {
      idempotencyKey: 'op-guest-a-0001',
      budget: { maxCalls: 6 },
    }));
    assert.equal(jobA.status, 202);
    assert.equal(jobA.body.job.progress.requiredCalls, 4, 'guest calls are also capped by AI_MAX_CALLS_PER_JOB');
    const jobA2 = await postJob(call, guestA, jobBody(firstUpload.body.upload.id, {
      idempotencyKey: 'op-guest-a-0002',
    }));
    assert.equal(jobA2.status, 429);
    const ownerA = await d1.prepare('SELECT owner_id FROM ai_uploads WHERE id = ?1').bind(firstUpload.body.upload.id).first();
    const rowsA = await d1.prepare('SELECT COUNT(*) AS count FROM ai_jobs WHERE owner_id = ?1').bind(ownerA.owner_id).first();
    assert.equal(rowsA.count, 1, 'the active-cap rejection rolls the extra guest job back');

    const jobB = await postJob(call, guestB, jobBody(uploadB.body.upload.id, { idempotencyKey: 'op-guest-b-0001' }));
    assert.equal(jobB.status, 202);
    const jobC = await postJob(call, guestC, jobBody(uploadC.body.upload.id, { idempotencyKey: 'op-guest-c-0001' }));
    assert.equal(jobC.status, 429, 'the global guest job cap stops the third guest');

    const passwordJob = await postJob(call, ada.body.token, jobBody(passwordUploads[0].body.upload.id, {
      idempotencyKey: 'op-ada-cap-0001',
      budget: { maxCalls: 2 },
    }));
    const passwordJob2 = await postJob(call, ada.body.token, jobBody(passwordUploads[0].body.upload.id, {
      idempotencyKey: 'op-ada-cap-0002',
      budget: { maxCalls: 2 },
    }));
    assert.equal(passwordJob.status, 202);
    assert.equal(passwordJob2.status, 202);
    assert.equal(passwordJob.body.job.progress.requiredCalls, 2);
  });
});

test('the guest token budget sums gst owners and does not spend the password budget', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'true',
    AI_OPEN_ACCESS: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_GUEST_TOKEN_BUDGET: '10',
    AI_OWNER_TOKEN_BUDGET: '100',
    AI_TOKEN_WINDOW_SECONDS: '86400',
    AI_GUEST_JOBS_PER_OWNER_HOUR: '6',
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '3',
    AI_GUEST_JOBS_PER_HOUR: '20',
  }, async (mf, call) => {
    await seedUsageJob(mf, { id: '22222222-2222-4222-8222-222222222222', ownerId: OTHER_GUEST, input: 10 });
    const token = (await mintGuest(call)).body.guest.token;
    const up = await upload(call, token, pdfBytes('guest-budget'));
    assert.equal(up.status, 201);
    const blocked = await postJob(call, token, jobBody(up.body.upload.id, { idempotencyKey: 'op-guest-budget-1' }));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'owner_budget_exhausted');
    assert.match(blocked.headers.get('Retry-After'), /^[1-9][0-9]*$/);

    const applyOnly = await postJob(call, token, {
      ...jobBody(up.body.upload.id, { idempotencyKey: 'op-guest-budget-2', budget: { maxCalls: 0 } }),
      applyOnly: true,
      edits: [TEXT_EDIT],
    });
    assert.equal(applyOnly.status, 202, 'apply-only still skips the token gate');

    const ada = await register(mf, call, 'budgetada');
    const adaUpload = await upload(call, ada.body.token, pdfBytes('ada-budget'));
    const adaJob = await postJob(call, ada.body.token, jobBody(adaUpload.body.upload.id, { idempotencyKey: 'op-ada-budget-1' }));
    assert.equal(adaJob.status, 202, 'the password owner keeps AI_OWNER_TOKEN_BUDGET');
  });
});

test('an issued fsg bearer is rejected on non-AI routes like an unknown bearer', async () => {
  await withApp({
    ...CONFLUENCE_ENV,
    CONFLUENCE_ONLY: 'false',
    AI_HOSTING_ENABLED: 'true',
    AI_OPEN_ACCESS: 'true',
  }, async (mf, call) => {
    const token = (await mintGuest(call)).body.guest.token;
    const unknown = 'unknown-bearer-not-a-session';
    const routes = [
      ['GET', '/v1/records'],
      ['POST', '/v1/records', { kind: 'harness', payload: {} }],
      ['GET', '/v1/me'],
      ['POST', '/v1/logout'],
      ['POST', '/v1/auth/password', { currentPassword: PASSWORD, newPassword: NEXT }],
      ['POST', '/v1/auth/sessions/revoke'],
      ['GET', '/v1/confluence/archives'],
    ];
    for (const [method, pathname, body] of routes) {
      const guest = await call(method, pathname, { token, body });
      const other = await call(method, pathname, { token: unknown, body });
      assert.equal(guest.status, other.status, `${method} ${pathname}`);
      assert.equal(guest.body.error.code, other.body.error.code, `${method} ${pathname}`);
      assert.equal(guest.body.error.message, other.body.error.message, `${method} ${pathname}`);
      assert.equal(guest.status, 401, `${method} ${pathname}`);
      assert.equal(guest.body.error.code, 'unauthorized');
      assert.equal(JSON.stringify(guest.body).includes(token), false);
    }
    const still = await upload(call, token, pdfBytes('guest-after-non-ai'));
    assert.equal(still.status, 201, 'the guest session is still an AI owner');
  });
});

const GUEST_OPEN = {
  AI_HOSTING_ENABLED: 'true',
  AI_OPEN_ACCESS: 'true',
  CONFLUENCE_ONLY: 'false',
  AI_MAX_UPLOAD_BYTES: '4096',
};

function applyOnlyBody(uploadId, key) {
  return {
    ...jobBody(uploadId, { idempotencyKey: key, budget: { maxCalls: 0 } }),
    applyOnly: true,
    edits: [TEXT_EDIT],
  };
}

test('guest limit defaults stay inside the deployment upload cap', () => {
  const settings = aiSettings({});
  assert.equal(settings.maxUploadBytes, 32 * 1024 * 1024);
  assert.equal(settings.guestMaxUploadBytes, 20 * 1024 * 1024);
  assert.equal(settings.guestUploadsPerHour, 300);
  assert.equal(settings.guestJobReadsPerOwnerHour, 600);
  assert.equal(settings.guestJobReadsPerHour, 45000);
  assert.equal(settings.guestArtifactsPerOwnerHour, 60);
  assert.equal(settings.guestArtifactsPerHour, 1200);
  const capped = aiSettings({ AI_MAX_UPLOAD_BYTES: '100', AI_GUEST_MAX_UPLOAD_BYTES: '1000' });
  assert.equal(capped.maxUploadBytes, 100);
  assert.equal(capped.guestMaxUploadBytes, 100);
  const nonGuest = aiSettings({ AI_MAX_UPLOAD_BYTES: '1000', AI_GUEST_MAX_UPLOAD_BYTES: '40' });
  assert.equal(nonGuest.maxUploadBytes, 1000);
  assert.equal(nonGuest.guestMaxUploadBytes, 40);
});

test('guest uploads are capped globally and by a byte limit the guest learns from limits', async () => {
  await withApp({
    ...GUEST_OPEN,
    AI_MAX_UPLOAD_BYTES: '100',
    AI_GUEST_MAX_UPLOAD_BYTES: '40',
    AI_GUEST_UPLOADS_PER_HOUR: '2',
    AI_GUEST_UPLOADS_PER_OWNER_HOUR: '5',
    AI_UPLOADS_PER_OWNER_HOUR: '5',
  }, async (mf, call) => {
    const token = (await mintGuest(call)).body.guest.token;
    const ada = await register(mf, call, 'uploadcap');
    const unsigned = await call('GET', '/v1/ai/capabilities');
    const asGuest = await call('GET', '/v1/ai/capabilities', { token });
    const asPassword = await call('GET', '/v1/ai/capabilities', { token: ada.body.token });
    const unknown = await call('GET', '/v1/ai/capabilities', { token: 'fsg_' + 'c'.repeat(43) });
    assert.equal(unsigned.body.limits.maxUploadBytes, 100);
    assert.equal(asGuest.status, 200);
    assert.equal(asGuest.body.limits.maxUploadBytes, 40);
    assert.equal(asGuest.body.limits.maxPromptChars, unsigned.body.limits.maxPromptChars);
    assert.equal(asPassword.body.limits.maxUploadBytes, 100);
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.limits.maxUploadBytes, 100);
    assert.deepEqual(Object.keys(asGuest.body.limits).sort(), ['maxPromptChars', 'maxUploadBytes']);

    const tooBig = await upload(call, token, Buffer.alloc(41, 0x25));
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.error.code, 'payload_too_large');
    assert.equal(await stubCalls(mf, '/internal/v1/uploads', 'POST'), 0, 'an oversized body is not forwarded');

    const first = await upload(call, token, Buffer.alloc(40, 0x25));
    assert.equal(first.status, 201);
    const dedup = await upload(call, token, Buffer.alloc(40, 0x25), { name: 'again.pdf' });
    assert.equal(dedup.status, 200);
    assert.equal(dedup.body.upload.deduplicated, true);
    assert.equal(await stubCalls(mf, '/internal/v1/uploads', 'POST'), 1, 'a repeat does not reach the runtime');

    const other = (await mintGuest(call, undefined, fromIp('203.0.113.31'))).body.guest.token;
    const second = await upload(call, other, Buffer.alloc(40, 0x26));
    assert.equal(second.status, 201, 'a same-byte repeat does not spend the global upload cap');
    const thirdToken = (await mintGuest(call, undefined, fromIp('203.0.113.32'))).body.guest.token;
    const third = await upload(call, thirdToken, Buffer.alloc(40, 0x27));
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'rate_limited');
    assert.match(third.headers.get('Retry-After'), /^[1-9][0-9]*$/);
    assert.equal(await stubCalls(mf, '/internal/v1/uploads', 'POST'), 2, 'the blocked guest is not forwarded');

    const password = await upload(call, ada.body.token, Buffer.alloc(80, 0x28));
    assert.equal(password.status, 201, 'password owners keep AI_MAX_UPLOAD_BYTES');
    const passwordTooBig = await upload(call, ada.body.token, Buffer.alloc(101, 0x28));
    assert.equal(passwordTooBig.status, 413);
  });

  await withApp({
    ...GUEST_OPEN,
    AI_MAX_UPLOAD_BYTES: '30',
    AI_GUEST_MAX_UPLOAD_BYTES: '1000',
  }, async (mf, call) => {
    const token = (await mintGuest(call)).body.guest.token;
    const caps = await call('GET', '/v1/ai/capabilities', { token });
    assert.equal(caps.body.limits.maxUploadBytes, 30, 'the guest cap cannot exceed AI_MAX_UPLOAD_BYTES');
    assert.equal((await call('GET', '/v1/ai/capabilities')).body.limits.maxUploadBytes, 30);
    assert.equal((await upload(call, token, Buffer.alloc(30, 0x25))).status, 201);
    assert.equal((await upload(call, token, Buffer.alloc(31, 0x26))).status, 413);
  });

  await withApp({
    AI_HOSTING_ENABLED: 'true',
    AI_OPEN_ACCESS: 'false',
    CONFLUENCE_ONLY: 'false',
  }, async (mf, call) => {
    const unsigned = await call('GET', '/v1/ai/capabilities');
    const caps = await call('GET', '/v1/ai/capabilities', { token: 'fsg_' + 'd'.repeat(43) });
    assert.equal(caps.status, 200);
    assert.equal(caps.body.limits.maxUploadBytes, unsigned.body.limits.maxUploadBytes);
    assert.deepEqual(caps.body.openAccess, { enabled: false, accessKeyRequired: false });
  });
});

test('apply-only guest jobs count toward the guest job caps', async () => {
  await withApp({
    ...GUEST_OPEN,
    AI_GUEST_JOBS_PER_OWNER_HOUR: '1',
    AI_GUEST_JOBS_PER_HOUR: '10',
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '5',
    AI_GUEST_TOKEN_BUDGET: '1',
  }, async (mf, call) => {
    const token = (await mintGuest(call)).body.guest.token;
    const up = await upload(call, token, pdfBytes('apply-owner'));
    const first = await postJob(call, token, applyOnlyBody(up.body.upload.id, 'op-apply-owner-1'));
    assert.equal(first.status, 202);
    assert.equal(first.body.job.applyOnly, true);
    const second = await postJob(call, token, applyOnlyBody(up.body.upload.id, 'op-apply-owner-2'));
    assert.equal(second.status, 429);
    assert.equal(second.body.error.code, 'rate_limited');
    const rows = await (await mf.getD1Database('DB')).prepare('SELECT COUNT(*) AS count FROM ai_jobs').first();
    assert.equal(rows.count, 1);
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1);
  });

  await withApp({
    ...GUEST_OPEN,
    AI_GUEST_JOBS_PER_OWNER_HOUR: '6',
    AI_GUEST_JOBS_PER_HOUR: '1',
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '5',
  }, async (mf, call) => {
    const tokenA = (await mintGuest(call, undefined, fromIp('203.0.113.40'))).body.guest.token;
    const tokenB = (await mintGuest(call, undefined, fromIp('203.0.113.41'))).body.guest.token;
    const upA = await upload(call, tokenA, pdfBytes('apply-global-a'));
    const upB = await upload(call, tokenB, pdfBytes('apply-global-b'));
    const first = await postJob(call, tokenA, applyOnlyBody(upA.body.upload.id, 'op-apply-global-1'));
    assert.equal(first.status, 202);
    const blocked = await postJob(call, tokenB, jobBody(upB.body.upload.id, { idempotencyKey: 'op-apply-global-2' }));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1, 'the second guest does not reach the runtime');
    const ada = await register(mf, call, 'applyada');
    const adaUp = await upload(call, ada.body.token, pdfBytes('apply-ada'));
    const adaJob = await postJob(call, ada.body.token, jobBody(adaUp.body.upload.id, { idempotencyKey: 'op-apply-ada-1' }));
    assert.equal(adaJob.status, 202, 'password jobs do not spend the guest job cap');
  });
});

test('guest status, cancel, replay and artifact calls are capped before the runtime', async () => {
  await withApp({
    ...GUEST_OPEN,
    AI_GUEST_JOBS_PER_HOUR: '5',
    AI_GUEST_JOBS_PER_OWNER_HOUR: '5',
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '5',
    AI_GUEST_JOB_READS_PER_OWNER_HOUR: '1',
    AI_GUEST_JOB_READS_PER_HOUR: '10',
  }, async (mf, call) => {
    const token = (await mintGuest(call)).body.guest.token;
    const other = (await mintGuest(call, undefined, fromIp('203.0.113.50'))).body.guest.token;
    const up = await upload(call, token, pdfBytes('reads'));
    const created = await postJob(call, token, jobBody(up.body.upload.id, { idempotencyKey: 'op-reads-0001' }));
    assert.equal(created.status, 202);
    const jobId = created.body.job.id;
    assert.equal((await call('GET', `/v1/ai/jobs/${jobId}`, { token })).status, 200);
    const again = await call('GET', `/v1/ai/jobs/${jobId}`, { token });
    assert.equal(again.status, 429);
    assert.equal(again.body.error.code, 'rate_limited');
    const foreign = await call('GET', `/v1/ai/jobs/${jobId}`, { token: other });
    assert.equal(foreign.status, 404);
    const otherUp = await upload(call, other, pdfBytes('reads-other'));
    const otherJob = await postJob(call, other, jobBody(otherUp.body.upload.id, { idempotencyKey: 'op-reads-0002' }));
    assert.equal(otherJob.status, 202);
    const otherStatus = await call('GET', `/v1/ai/jobs/${otherJob.body.job.id}`, { token: other });
    assert.equal(otherStatus.status, 200, 'another guest keeps their own read cap');
    assert.equal(await stubCalls(mf, `/internal/v1/jobs/${jobId}`, 'GET'), 1, 'the refused poll does not reach the runtime');
  });

  await withApp({
    ...GUEST_OPEN,
    AI_GUEST_JOBS_PER_HOUR: '1',
    AI_GUEST_JOBS_PER_OWNER_HOUR: '4',
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '4',
    AI_GUEST_JOB_READS_PER_OWNER_HOUR: '10',
    AI_GUEST_JOB_READS_PER_HOUR: '5',
  }, async (mf, call) => {
    const token = (await mintGuest(call)).body.guest.token;
    const up = await upload(call, token, pdfBytes('replay-cap'));
    const created = await postJob(call, token, jobBody(up.body.upload.id, { idempotencyKey: 'op-replay-0001' }));
    assert.equal(created.status, 202);
    const replay = await postJob(call, token, jobBody(up.body.upload.id, { idempotencyKey: 'op-replay-0001' }));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    const extra = await postJob(call, token, jobBody(up.body.upload.id, { idempotencyKey: 'op-replay-0002' }));
    assert.equal(extra.status, 429, 'a replay does not free a guest job slot for a new job');
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 1);
  });

  await withApp({
    ...GUEST_OPEN,
    AI_GUEST_JOBS_PER_HOUR: '4',
    AI_GUEST_JOBS_PER_OWNER_HOUR: '4',
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '4',
    AI_GUEST_JOB_READS_PER_OWNER_HOUR: '10',
    AI_GUEST_JOB_READS_PER_HOUR: '1',
  }, async (mf, call) => {
    const token = (await mintGuest(call)).body.guest.token;
    const up = await upload(call, token, pdfBytes('follow'));
    const created = await postJob(call, token, jobBody(up.body.upload.id, { idempotencyKey: 'op-follow-0001' }));
    const jobId = created.body.job.id;
    const cancel = await call('POST', `/v1/ai/jobs/${jobId}/cancel`, { token });
    assert.equal(cancel.status, 202);
    const replay = await postJob(call, token, jobBody(up.body.upload.id, { idempotencyKey: 'op-follow-0001' }));
    assert.equal(replay.status, 429, 'cancel and replay share the guest read cap');
    assert.equal(await stubCalls(mf, `/internal/v1/jobs/${jobId}`, 'GET'), 0);
    const ada = await register(mf, call, 'readada');
    const adaUp = await upload(call, ada.body.token, pdfBytes('read-ada'));
    const adaJob = await postJob(call, ada.body.token, jobBody(adaUp.body.upload.id, { idempotencyKey: 'op-follow-ada' }));
    assert.equal(adaJob.status, 202);
    assert.equal((await call('GET', `/v1/ai/jobs/${adaJob.body.job.id}`, { token: ada.body.token })).status, 200);
    assert.equal((await call('POST', `/v1/ai/jobs/${adaJob.body.job.id}/cancel`, { token: ada.body.token })).status, 202);
  });

  await withApp({
    ...GUEST_OPEN,
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '3',
    AI_GUEST_JOB_READS_PER_HOUR: '10',
    AI_GUEST_ARTIFACTS_PER_OWNER_HOUR: '5',
    AI_GUEST_ARTIFACTS_PER_HOUR: '1',
  }, async (mf, call) => {
    const token = (await mintGuest(call)).body.guest.token;
    const up = await upload(call, token, pdfBytes('artifact'));
    const created = await postJob(call, token, jobBody(up.body.upload.id, { idempotencyKey: 'op-art-0001' }));
    const jobId = created.body.job.id;
    const file = await call('GET', `/v1/ai/jobs/${jobId}/artifacts/artifact-1`, { token });
    assert.equal(file.status, 200);
    const again = await call('GET', `/v1/ai/jobs/${jobId}/artifacts/artifact-1`, { token });
    assert.equal(again.status, 429);
    assert.equal(again.body.error.code, 'rate_limited');
    assert.equal(await stubCalls(mf, `/internal/v1/jobs/${jobId}/artifacts/artifact-1`, 'GET'), 1);
    const ada = await register(mf, call, 'artada');
    const adaUp = await upload(call, ada.body.token, pdfBytes('art-ada'));
    const adaJob = await postJob(call, ada.body.token, jobBody(adaUp.body.upload.id, { idempotencyKey: 'op-art-ada' }));
    const adaFile = await call('GET', `/v1/ai/jobs/${adaJob.body.job.id}/artifacts/artifact-1`, { token: ada.body.token });
    assert.equal(adaFile.status, 200, 'password downloads do not spend the guest artifact cap');
  });
});

test('migration 0005 stores guest token hashes and indexes expiry', () => {
  const sql = readFileSync(path.join(apiRoot, 'migrations', '0005_guest_sessions.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE guest_sessions/);
  assert.match(sql, /token_hash TEXT PRIMARY KEY/);
  assert.match(sql, /guest_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /expires_at INTEGER NOT NULL/);
  assert.match(sql, /revoked_at INTEGER/);
  assert.match(sql, /CREATE INDEX guest_sessions_expires ON guest_sessions \(expires_at\)/);
  assert.equal(sql.includes('api_key'), false);
  assert.equal(/\btoken TEXT\b/.test(sql), false);
});

const DEFAULT_CAPABILITIES = {
  enabled: false,
  provider: 'anthropic',
  execution: 'server',
  models: DEFAULT_MODELS,
  efforts: DEFAULT_EFFORTS,
  limits: { maxUploadBytes: 4096, maxPromptChars: 32000 },
  openAccess: { enabled: false, accessKeyRequired: false },
  blueJobs: true,
  modelJobs: true,
};

test('providerForModel maps claude, gpt and o-digit ids and rejects the rest', () => {
  assert.equal(providerForModel('claude-opus-5-5'), 'anthropic');
  assert.equal(providerForModel('claude-haiku-5-5'), 'anthropic');
  assert.equal(providerForModel('gpt-5.4'), 'openai');
  assert.equal(providerForModel('gpt-4o'), 'openai');
  assert.equal(providerForModel('o3'), 'openai');
  assert.equal(providerForModel('o3-mini'), 'openai');
  assert.equal(providerForModel('o1'), 'openai');
  assert.equal(providerForModel('llama-3'), null);
  assert.equal(providerForModel('gemini-2.5'), null);
  assert.equal(providerForModel('Claude-opus-5-5'), null);
  assert.equal(providerForModel('omni'), null);
  assert.equal(providerForModel('o'), null);
  assert.equal(providerForModel('gpt'), null);
  assert.equal(providerForModel(''), null);
  assert.equal(providerForModel(null), null);
});

test('AI_MODELS drops ids with no provider and does not restore Claude when every id is unknown', () => {
  assert.deepEqual(aiSettings({}).models, DEFAULT_MODELS);
  assert.deepEqual(aiSettings({ AI_MODELS: '' }).models, DEFAULT_MODELS);
  assert.deepEqual(aiSettings({ AI_MODELS: '???' }).models, DEFAULT_MODELS);
  const mixed = aiSettings({ AI_MODELS: 'claude-sonnet-5-5, llama-3, gpt-5.4, o3, claude-sonnet-5-5' });
  assert.deepEqual(mixed.models, ['claude-sonnet-5-5', 'gpt-5.4', 'o3']);
  assert.equal(mixed.defaultModel, 'claude-sonnet-5-5');
  const rejected = aiSettings({ AI_MODELS: 'llama-3,gemini-2.5' });
  assert.deepEqual(rejected.models, []);
  assert.equal(rejected.defaultModel, '');
  const openai = aiSettings({ AI_MODELS: 'gpt-5.4,o3-mini', AI_DEFAULT_MODEL: 'o3-mini' });
  assert.deepEqual(openai.models, ['gpt-5.4', 'o3-mini']);
  assert.equal(openai.defaultModel, 'o3-mini');
});

test('default capabilities add modelProviders and leave every other field unchanged', async () => {
  await withApp({ AI_HOSTING_ENABLED: 'false', CONFLUENCE_ONLY: 'false' }, async (_mf, call) => {
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.equal(capabilities.status, 200);
    assert.deepEqual(Object.keys(capabilities.body), [
      'enabled', 'provider', 'execution', 'models', 'efforts', 'limits', 'openAccess', 'modelProviders', 'blueJobs', 'modelJobs',
    ]);
    const { modelProviders, ...rest } = capabilities.body;
    assert.deepEqual(rest, DEFAULT_CAPABILITIES);
    assert.deepEqual(modelProviders, {
      'claude-opus-5-5': 'anthropic',
      'claude-sonnet-5-5': 'anthropic',
      'claude-haiku-5-5': 'anthropic',
    });
  });
});

test('capabilities report one provider or mixed and drop unknown AI_MODELS ids', async () => {
  const host = { AI_HOSTING_ENABLED: 'true', CONFLUENCE_ONLY: 'false', AI_MAX_UPLOAD_BYTES: '4096' };
  await withApp({ ...host, AI_MODELS: 'claude-sonnet-5-5,llama-3,gpt-5.4,o3,not a token' }, async (mf, call) => {
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.provider, 'mixed');
    assert.deepEqual(capabilities.body.models, ['claude-sonnet-5-5', 'gpt-5.4', 'o3']);
    assert.deepEqual(capabilities.body.modelProviders, {
      'claude-sonnet-5-5': 'anthropic',
      'gpt-5.4': 'openai',
      'o3': 'openai',
    });
    const ada = await register(mf, call, 'mixedmodels');
    const up = await upload(call, ada.body.token, pdfBytes('mixed'));
    const rejected = await postJob(call, ada.body.token, jobBody(up.body.upload.id, { model: 'llama-3' }));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'invalid_request');
  });

  await withApp({ ...host, AI_MODELS: 'gpt-5.4,o3-mini' }, async (_mf, call) => {
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.equal(capabilities.body.provider, 'openai');
    assert.deepEqual(capabilities.body.models, ['gpt-5.4', 'o3-mini']);
    assert.deepEqual(capabilities.body.modelProviders, { 'gpt-5.4': 'openai', 'o3-mini': 'openai' });
  });

  await withApp({ ...host, AI_MODELS: 'llama-3,gemini-2.5' }, async (mf, call) => {
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.deepEqual(capabilities.body.models, []);
    assert.deepEqual(capabilities.body.modelProviders, {});
    assert.equal(capabilities.body.provider, 'mixed', 'an explicit list with no provider does not become Claude');
    const ada = await register(mf, call, 'emptycatalog');
    const up = await upload(call, ada.body.token, pdfBytes('empty-catalog'));
    const rejected = await postJob(call, ada.body.token, jobBody(up.body.upload.id));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'invalid_request');
  });
});

test('job snapshots keep a runtime provider and otherwise derive one from the model', async () => {
  const host = {
    AI_HOSTING_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
    AI_MAX_UPLOAD_BYTES: '4096',
    AI_MODELS: 'claude-sonnet-5-5,gpt-5.4,o3',
  };
  await withApp({ ...host, AI_STUB_PROVIDER: 'openai' }, async (mf, call) => {
    const ada = await register(mf, call, 'passthru');
    const up = await upload(call, ada.body.token, pdfBytes('pass'));
    const created = await postJob(call, ada.body.token, jobBody(up.body.upload.id, {
      model: 'claude-sonnet-5-5',
      idempotencyKey: 'op-pass-0001',
    }));
    assert.equal(created.status, 202);
    assert.equal(created.body.job.model, 'claude-sonnet-5-5');
    assert.equal(created.body.job.provider, 'openai', 'an anthropic or openai runtime provider is passed through');
  });

  await withApp({ ...host, AI_STUB_PROVIDER: 'other-vendor' }, async (mf, call) => {
    const ada = await register(mf, call, 'fallback');
    const up = await upload(call, ada.body.token, pdfBytes('fall'));
    const gpt = await postJob(call, ada.body.token, jobBody(up.body.upload.id, {
      model: 'gpt-5.4',
      idempotencyKey: 'op-fall-gpt1',
    }));
    assert.equal(gpt.status, 202);
    assert.equal(gpt.body.job.provider, 'openai');
    const claude = await postJob(call, ada.body.token, jobBody(up.body.upload.id, {
      model: 'claude-sonnet-5-5',
      idempotencyKey: 'op-fall-claude',
    }));
    assert.equal(claude.status, 202);
    assert.equal(claude.body.job.provider, 'anthropic');
    const reasoning = await postJob(call, ada.body.token, jobBody(up.body.upload.id, {
      model: 'o3',
      idempotencyKey: 'op-fall-o3xx',
    }));
    assert.equal(reasoning.status, 202);
    assert.equal(reasoning.body.job.provider, 'openai');
  });
});

const PAPER_ON = {
  AI_HOSTING_ENABLED: 'true',
  AI_PAPER_TOOLS_ENABLED: 'true',
  CONFLUENCE_ONLY: 'false',
  AI_OPEN_ACCESS: 'true',
};
const PAPER_QUERY = '/api/paper/evidence/query';
const PAPER_JOB = 'ab'.repeat(16);
const ENABLED_CAPABILITIES = {
  enabled: true,
  provider: 'anthropic',
  execution: 'server',
  models: DEFAULT_MODELS,
  efforts: DEFAULT_EFFORTS,
  limits: { maxUploadBytes: 4096, maxPromptChars: 32000 },
  openAccess: { enabled: false, accessKeyRequired: false },
  modelProviders: {
    'claude-opus-5-5': 'anthropic',
    'claude-sonnet-5-5': 'anthropic',
    'claude-haiku-5-5': 'anthropic',
  },
  blueJobs: true,
  modelJobs: true,
};

function postPaper(c, token, body) {
  return c('POST', '/v1/ai/paper', { token, body });
}

async function stubPaper(instance) {
  const d1 = await instance.getD1Database('DB');
  const listed = await d1.prepare('SELECT owner_header, service_token, payload FROM ai_stub_paper ORDER BY seq').all();
  return listed.results.map(row => ({
    ownerHeader: row.owner_header,
    serviceToken: row.service_token,
    payload: JSON.parse(row.payload),
  }));
}

test('paper tool settings default off and keep the contract hour caps', () => {
  const settings = aiSettings({});
  assert.equal(settings.paperTools, false);
  assert.equal(settings.paperMaxBodyBytes, 29360128);
  assert.equal(settings.paperPreparesPerHour, 30);
  assert.equal(settings.paperCallsPerHour, 600);
  assert.equal(settings.guestPaperPreparesPerHour, 10);
  assert.equal(settings.guestPaperCallsPerHour, 240);
  assert.equal(settings.paperCallsGlobalPerHour, 3000);
  assert.equal(aiSettings({ AI_PAPER_TOOLS_ENABLED: 'false' }).paperTools, false);
  assert.equal(aiSettings({ AI_PAPER_TOOLS_ENABLED: 'TRUE' }).paperTools, false);
  const on = aiSettings({ AI_PAPER_TOOLS_ENABLED: 'true', AI_PAPER_MAX_BODY_BYTES: '100' });
  assert.equal(on.paperTools, true);
  assert.equal(on.paperMaxBodyBytes, 100);
  assert.equal(aiSettings({ AI_PAPER_TOOLS_ENABLED: true }).paperTools, true);
  assert.equal(aiSettings({ AI_PAPER_MAX_BODY_BYTES: String(80 * 1024 * 1024) }).paperMaxBodyBytes, 64 * 1024 * 1024);
});

test('paper tools stay absent by default and capabilities match the base bytes', async () => {
  await withApp({ AI_HOSTING_ENABLED: 'true', CONFLUENCE_ONLY: 'false' }, async (mf, call) => {
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.equal(JSON.stringify(capabilities.body), JSON.stringify(ENABLED_CAPABILITIES));
    assert.equal(Object.hasOwn(capabilities.body, 'paperTools'), false);
    const denied = await postPaper(call, undefined, { path: PAPER_QUERY, body: null });
    assert.equal(denied.status, 404);
    assert.equal(denied.body.error.code, 'paper_tools_disabled');
    assert.equal(await stubCalls(mf, '/internal/v1/paper', 'POST'), 0);
    const preflight = await call('OPTIONS', '/v1/ai/paper', {
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  });
  await withApp({ AI_HOSTING_ENABLED: 'true', AI_PAPER_TOOLS_ENABLED: 'false', CONFLUENCE_ONLY: 'false' }, async (mf, call) => {
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.equal(JSON.stringify(capabilities.body), JSON.stringify(ENABLED_CAPABILITIES));
    const denied = await postPaper(call, undefined, { path: PAPER_QUERY, body: null });
    assert.equal(denied.status, 404);
    assert.equal(denied.body.error.code, 'paper_tools_disabled');
    assert.equal(await stubCalls(mf, '/internal/v1/paper', 'POST'), 0);
  });
});

test('enabled paper capabilities add only paperTools and still serve a member when hosting is off', async () => {
  await withApp({
    AI_HOSTING_ENABLED: 'false',
    AI_PAPER_TOOLS_ENABLED: 'true',
    CONFLUENCE_ONLY: 'false',
  }, async (mf, call) => {
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.equal(capabilities.body.enabled, false);
    assert.deepEqual(capabilities.body.paperTools, { enabled: true });
    assert.deepEqual(Object.keys(capabilities.body), [
      'enabled', 'provider', 'execution', 'models', 'efforts', 'limits', 'openAccess', 'modelProviders', 'blueJobs', 'modelJobs', 'paperTools',
    ]);
    const ada = await register(mf, call, 'paperhost');
    const forwarded = await postPaper(call, ada.body.token, { path: PAPER_QUERY, body: { operation: 'status' } });
    assert.equal(forwarded.status, 200);
    assert.equal(forwarded.body.marker, 'PAPER-OK');
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 0);
  });
});

test('paper forwards guest and member bodies verbatim and does not spend the token budget', async () => {
  await withApp({
    ...PAPER_ON,
    AI_GUEST_TOKEN_BUDGET: '10',
    AI_OWNER_TOKEN_BUDGET: '100',
  }, async (mf, call) => {
    const capabilities = await call('GET', '/v1/ai/capabilities');
    assert.deepEqual(capabilities.body.paperTools, { enabled: true });
    assert.equal(JSON.stringify({ ...ENABLED_CAPABILITIES, paperTools: { enabled: true } }), JSON.stringify({
      ...capabilities.body,
      openAccess: ENABLED_CAPABILITIES.openAccess,
    }));
    const uploadFlight = await call('OPTIONS', '/v1/ai/uploads', {
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-falsify-file-name',
      },
    });
    const paperFlight = await call('OPTIONS', '/v1/ai/paper', {
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-falsify-file-name',
      },
    });
    assert.equal(paperFlight.status, 204);
    assert.equal(paperFlight.headers.get('Access-Control-Allow-Methods'), uploadFlight.headers.get('Access-Control-Allow-Methods'));
    assert.equal(paperFlight.headers.get('Access-Control-Allow-Headers'), uploadFlight.headers.get('Access-Control-Allow-Headers'));
    assert.equal(paperFlight.headers.get('Access-Control-Max-Age'), uploadFlight.headers.get('Access-Control-Max-Age'));
    assert.equal(paperFlight.headers.get('Cache-Control'), 'no-store');

    const missing = await postPaper(call, undefined, { path: PAPER_QUERY, body: null });
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, 'unauthorized');
    const garbage = await postPaper(call, 'fss_' + 'a'.repeat(43), { path: PAPER_QUERY, body: null });
    assert.equal(garbage.status, 401);
    assert.equal(garbage.body.error.code, 'unauthorized');
    const unknownGuest = await postPaper(call, 'fsg_' + 'b'.repeat(43), { path: PAPER_QUERY, body: null });
    assert.equal(unknownGuest.status, 401);
    assert.equal(unknownGuest.body.error.code, 'unauthorized');
    assert.equal(await stubCalls(mf, '/internal/v1/paper', 'POST'), 0);

    const ada = await register(mf, call, 'papermember');
    const memberBody = { path: PAPER_QUERY, body: { operation: 'status' } };
    const member = await postPaper(call, ada.body.token, memberBody);
    const memberRows = await stubPaper(mf);
    assert.equal(member.status, 200);
    assert.equal(member.text, JSON.stringify({ marker: 'PAPER-OK', echoed: memberRows[0].payload }));
    assert.deepEqual(memberRows[0].payload, { ownerId: memberRows[0].ownerHeader, path: memberBody.path, body: memberBody.body });
    assert.equal(memberRows[0].serviceToken, SERVICE_TOKEN);
    assert.match(memberRows[0].ownerHeader, /^usr:/);

    const method = await call('GET', '/v1/ai/paper', { token: ada.body.token });
    assert.equal(method.status, 405);
    assert.equal(method.body.error.code, 'method_not_allowed');

    await seedUsageJob(mf, { id: '22222222-2222-4222-8222-222222222222', ownerId: OTHER_GUEST, input: 10 });
    const guestToken = (await mintGuest(call)).body.guest.token;
    const guestBody = { path: `/api/paper/evidence/jobs/${PAPER_JOB}`, body: null };
    const guest = await postPaper(call, guestToken, guestBody);
    const guestRow = (await stubPaper(mf)).at(-1);
    assert.equal(guest.status, 200);
    assert.equal(guest.text, JSON.stringify({ marker: 'PAPER-OK', echoed: guestRow.payload }));
    assert.match(guestRow.ownerHeader, /^gst:/);
    assert.equal(guestRow.payload.path, guestBody.path);
    assert.equal(guestRow.payload.body, null);
    const guestUpload = await upload(call, guestToken, pdfBytes('paper-budget'));
    const blocked = await postJob(call, guestToken, jobBody(guestUpload.body.upload.id, { idempotencyKey: 'op-paper-budget' }));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'owner_budget_exhausted');

    for (const path of [
      '/api/paper/evidence/jobs',
      `/api/paper/evidence/jobs/${PAPER_JOB}/cancel`,
      '/api/paper/visual/export',
      '/api/paper/chart/prepare',
    ]) {
      const allowed = await postPaper(call, ada.body.token, { path, body: { marker: path } });
      assert.equal(allowed.status, 200, path);
      assert.equal((await stubPaper(mf)).at(-1).payload.path, path);
    }
    const before = await stubCalls(mf, '/internal/v1/paper', 'POST');
    const unsupported = await postPaper(call, ada.body.token, { path: '/api/paper/chart/export', body: null });
    assert.equal(unsupported.status, 404);
    assert.equal(unsupported.body.error.code, 'paper_path_unsupported');
    assert.equal(await stubCalls(mf, '/internal/v1/paper', 'POST'), before);
    const foreign = await call('POST', '/v1/ai/paper', {
      token: ada.body.token,
      body: { path: PAPER_QUERY, body: null },
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error.code, 'origin_not_allowed');
  });
});

test('paper rejects extra keys, unknown paths and oversize bodies before the runtime', async () => {
  await withApp({
    ...PAPER_ON,
    AI_PAPER_MAX_BODY_BYTES: '512',
    AI_MAX_UPLOAD_BYTES: '8',
    AI_GUEST_MAX_UPLOAD_BYTES: '3',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'paperstrict');
    const guest = (await mintGuest(call)).body.guest.token;
    const extra = await postPaper(call, ada.body.token, { path: PAPER_QUERY, body: null, extra: 1 });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.error.code, 'invalid_request');
    const missingBody = await postPaper(call, ada.body.token, { path: PAPER_QUERY });
    assert.equal(missingBody.status, 400);
    assert.equal(missingBody.body.error.code, 'invalid_request');
    const arrayBody = await postPaper(call, ada.body.token, { path: PAPER_QUERY, body: [] });
    assert.equal(arrayBody.status, 400);
    assert.equal(arrayBody.body.error.code, 'invalid_request');
    const upper = await postPaper(call, ada.body.token, { path: `/api/paper/evidence/jobs/${'AB'.repeat(16)}`, body: null });
    assert.equal(upper.status, 404);
    assert.equal(upper.body.error.code, 'paper_path_unsupported');
    const preview = await postPaper(call, ada.body.token, { path: '/api/paper/chart/preview', body: {} });
    assert.equal(preview.status, 404);
    assert.equal(preview.body.error.code, 'paper_path_unsupported');
    const raw = await call('POST', '/v1/ai/paper', { token: ada.body.token, raw: 'x'.repeat(600) });
    assert.equal(raw.status, 413);
    assert.equal(raw.body.error.code, 'payload_too_large');
    const four = Buffer.from('abcd').toString('base64');
    const nine = Buffer.from('abcdefghi').toString('base64');
    const three = Buffer.from('abc').toString('base64');
    const prepare = file => ({ path: '/api/paper/evidence/prepare', body: { fileHash: 'cd'.repeat(32), file } });
    const guestOver = await postPaper(call, guest, prepare(four));
    assert.equal(guestOver.status, 413);
    assert.equal(guestOver.body.error.code, 'payload_too_large');
    const memberOver = await postPaper(call, ada.body.token, prepare(nine));
    assert.equal(memberOver.status, 413);
    assert.equal(memberOver.body.error.code, 'payload_too_large');
    assert.equal(await stubCalls(mf, '/internal/v1/paper', 'POST'), 0);
    const guestOk = await postPaper(call, guest, prepare(three));
    assert.equal(guestOk.status, 200);
    assert.equal((await stubPaper(mf)).at(-1).payload.body.file, three);
    const memberOk = await postPaper(call, ada.body.token, prepare(four));
    assert.equal(memberOk.status, 200);
    assert.equal((await stubPaper(mf)).at(-1).payload.body.file, four);
    assert.match((await stubPaper(mf)).at(-1).ownerHeader, /^usr:/);
    assert.match((await stubPaper(mf))[0].ownerHeader, /^gst:/);
  });
});

test('paper prepare and call caps are per owner and a rejected prepare returns its call slot', async () => {
  await withApp({
    ...PAPER_ON,
    AI_PAPER_PREPARES_PER_HOUR: '1',
    AI_GUEST_PAPER_PREPARES_PER_HOUR: '1',
    AI_PAPER_CALLS_PER_HOUR: '2',
    AI_GUEST_PAPER_CALLS_PER_HOUR: '10',
    AI_PAPER_CALLS_GLOBAL_PER_HOUR: '100',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'paperprepa');
    const bea = await register(mf, call, 'paperprepb');
    const guest = (await mintGuest(call)).body.guest.token;
    const prepare = token => postPaper(call, token, { path: '/api/paper/evidence/prepare', body: { fileHash: 'a'.repeat(64), file: 'JVBERi0x' } });
    const chart = token => postPaper(call, token, { path: '/api/paper/chart/prepare', body: {} });
    const query = token => postPaper(call, token, { path: PAPER_QUERY, body: null });
    assert.equal((await prepare(ada.body.token)).status, 200);
    const second = await prepare(ada.body.token);
    assert.equal(second.status, 429);
    assert.equal(second.body.error.code, 'rate_limited');
    assert.match(second.headers.get('Retry-After'), /^[1-9][0-9]*$/);
    assert.equal((await query(ada.body.token)).status, 200, 'the rejected prepare gives the call slot back');
    const capped = await query(ada.body.token);
    assert.equal(capped.status, 429);
    assert.equal(capped.body.error.code, 'rate_limited');
    assert.equal((await prepare(bea.body.token)).status, 200, 'member prepare caps are per owner');
    assert.equal((await prepare(guest)).status, 200);
    assert.equal((await prepare(guest)).status, 429);
    assert.equal((await query(guest)).status, 200, 'a guest prepare cap does not block a later guest call');
    assert.equal((await chart(guest)).status, 200, 'chart prepare is an ordinary call, not a PDF prepare');
    assert.equal(await stubCalls(mf, '/internal/v1/paper', 'POST'), 6);
  });
});

test('paper call caps are separate for guests and members and polls count', async () => {
  await withApp({
    ...PAPER_ON,
    AI_PAPER_CALLS_PER_HOUR: '2',
    AI_GUEST_PAPER_CALLS_PER_HOUR: '1',
    AI_PAPER_PREPARES_PER_HOUR: '100',
    AI_GUEST_PAPER_PREPARES_PER_HOUR: '100',
    AI_PAPER_CALLS_GLOBAL_PER_HOUR: '100',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'papercalla');
    const bea = await register(mf, call, 'papercallb');
    const guest = (await mintGuest(call)).body.guest.token;
    const poll = { path: `/api/paper/evidence/jobs/${PAPER_JOB}`, body: null };
    assert.equal((await postPaper(call, ada.body.token, { path: PAPER_QUERY, body: null })).status, 200);
    assert.equal((await postPaper(call, ada.body.token, poll)).status, 200);
    assert.equal((await postPaper(call, ada.body.token, poll)).status, 429);
    assert.equal((await postPaper(call, bea.body.token, { path: PAPER_QUERY, body: null })).status, 200);
    assert.equal((await postPaper(call, guest, { path: PAPER_QUERY, body: null })).status, 200);
    assert.equal((await postPaper(call, guest, poll)).status, 429);
    assert.equal((await postPaper(call, bea.body.token, poll)).status, 200, 'a guest call cap does not spend a member slot');
  });
});

test('paper global call cap stops every owner after the shared budget', async () => {
  await withApp({
    ...PAPER_ON,
    AI_PAPER_CALLS_PER_HOUR: '100',
    AI_GUEST_PAPER_CALLS_PER_HOUR: '100',
    AI_PAPER_CALLS_GLOBAL_PER_HOUR: '2',
  }, async (mf, call) => {
    const ada = await register(mf, call, 'papergloba');
    const bea = await register(mf, call, 'paperglobb');
    const guest = (await mintGuest(call)).body.guest.token;
    const query = { path: PAPER_QUERY, body: null };
    assert.equal((await postPaper(call, ada.body.token, query)).status, 200);
    assert.equal((await postPaper(call, guest, query)).status, 200);
    const blocked = await postPaper(call, bea.body.token, query);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    assert.equal((await postPaper(call, ada.body.token, query)).status, 429);
    assert.equal(await stubCalls(mf, '/internal/v1/paper', 'POST'), 2);
  });
});

test('paper runtime errors pass through allowlisted codes and drop malformed bodies', async () => {
  await withApp(PAPER_ON, async (mf, call) => {
    const ada = await register(mf, call, 'papererr');
    const send = stub => postPaper(call, ada.body.token, { path: PAPER_QUERY, body: { stub } });
    const expired = await send('error');
    assert.equal(expired.status, 400);
    assert.equal(expired.body.error.code, 'paper_evidence_expired_or_missing');
    assert.equal(expired.text.includes('secret paper text'), false);
    const busy = await send('busy');
    assert.equal(busy.status, 429);
    assert.equal(busy.body.error.code, 'paper_busy');
    assert.equal(busy.body.error.retryable, true);
    const visual = await send('visual');
    assert.equal(visual.status, 400);
    assert.equal(visual.body.error.code, 'visual_region_invalid');
    const analysis = await send('analysis');
    assert.equal(analysis.status, 429);
    assert.equal(analysis.body.error.code, 'analysis_busy');
    const bad = await send('bad-code');
    assert.equal(bad.status, 502);
    assert.equal(bad.body.error.code, 'runtime_unavailable');
    assert.equal(bad.text.includes('secret paper text'), false);
    const malformed = await send('malformed');
    assert.equal(malformed.status, 502);
    assert.equal(malformed.body.error.code, 'runtime_unavailable');
    const longCode = await send('long-code');
    assert.equal(longCode.status, 502);
    assert.equal(longCode.body.error.code, 'runtime_unavailable');
    const unsupported = await send('unsupported');
    assert.equal(unsupported.status, 404);
    assert.equal(unsupported.body.error.code, 'paper_path_unsupported');
    assert.ok(await stubCalls(mf, '/internal/v1/paper', 'POST') >= 1);
    const down = await send('throw');
    assert.equal(down.status, 503);
    assert.equal(down.body.error.code, 'ai_unavailable');
    assert.equal(down.text.includes('socket'), false);
  });
});
