// Offline booth submission tests. Synthetic tokens and PDF bytes only.
// The runtime is the injected fetch stub; nothing leaves this process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNER_ID } from '../src/ai-identity.mjs';
import { aiSettings } from '../src/ai-gateway.mjs';

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
const SERVICE_TOKEN = 'test-service-token-' + 't'.repeat(24);
const OPERATOR = 'fso_' + randomBytes(32).toString('base64url');
const WRONG_OPERATOR = 'fso_' + randomBytes(32).toString('base64url');
const CONSENT = '2026-11-22.v1';
const KEY_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const sha256 = text => createHash('sha256').update(text).digest('hex');
const pdfBytes = text => Buffer.from(`%PDF-1.7 synthetic ${text}`);

let script;
let statements;

async function stubFetch(url, init, env) {
  const requestUrl = new URL(String(url));
  const method = String((init && init.method) || 'GET').toUpperCase();
  const headers = new Headers((init && init.headers) || {});
  const mode = String((env && env.AI_STUB_MODE) || '');
  const db = env && env.DB;
  const owner = headers.get('X-Falsify-Owner-Id') || '';
  const reply = (status, body, extra) => new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extra || {}) },
  });
  if (db) {
    await db.prepare('INSERT INTO ai_stub_calls (host, path, method, owner_id) VALUES (?1, ?2, ?3, ?4)')
      .bind(requestUrl.hostname, requestUrl.pathname, method, owner).run();
  }
  if (requestUrl.hostname !== 'runtime.test') return new Response('not found', { status: 404 });
  if (requestUrl.pathname === '/internal/v1/uploads' && method === 'POST') {
    const rawBody = init.body;
    let bytes;
    if (rawBody instanceof ArrayBuffer) bytes = new Uint8Array(rawBody);
    else if (ArrayBuffer.isView(rawBody)) bytes = new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
    else if (typeof rawBody === 'string') bytes = new TextEncoder().encode(rawBody);
    else bytes = new Uint8Array(await new Response(rawBody).arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const id = `rt-${sha.slice(0, 32)}`;
    await db.prepare('INSERT INTO ai_stub_uploads (id, owner_id, sha256, bytes) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO NOTHING')
      .bind(id, owner, sha, bytes.byteLength).run();
    return reply(201, { upload: { id, sha256: sha, bytes: bytes.byteLength, name: 'paper.pdf', mime: 'application/pdf', createdAt: new Date().toISOString() } });
  }
  if (requestUrl.pathname === '/internal/v1/jobs' && method === 'POST') {
    const payload = JSON.parse(init.body);
    const known = await db.prepare('SELECT 1 AS ok FROM ai_stub_uploads WHERE id = ?1 AND owner_id = ?2').bind(payload.uploadId, owner).first();
    if (!known) return new Response('unknown upload', { status: 404 });
    const at = new Date().toISOString();
    await db.prepare(
      'INSERT INTO ai_stub_jobs (id, owner_id, state, upload_id, payload) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (id) DO NOTHING'
    ).bind(payload.jobId, owner, 'queued', payload.uploadId, JSON.stringify(payload)).run();
    return reply(202, {
      id: payload.jobId,
      role: payload.role,
      state: 'queued',
      model: payload.model,
      effort: payload.effort,
      artifacts: [],
      createdAt: at,
      updatedAt: at,
    });
  }
  const artifact = /^\/internal\/v1\/jobs\/([^/]+)\/artifacts\/([^/]+)$/.exec(requestUrl.pathname);
  if (artifact && method === 'GET') {
    const job = await db.prepare('SELECT id FROM ai_stub_jobs WHERE id = ?1 AND owner_id = ?2').bind(artifact[1], owner).first();
    if (!job || artifact[2] !== 'edited-pdf-1') return new Response('not found', { status: 404 });
    const bytes = new TextEncoder().encode('%PDF-1.7 synthetic edited output ART-MARK');
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  }
  const status = /^\/internal\/v1\/jobs\/([^/]+)$/.exec(requestUrl.pathname);
  if (status && method === 'GET') {
    const job = await db.prepare('SELECT id, state FROM ai_stub_jobs WHERE id = ?1 AND owner_id = ?2').bind(status[1], owner).first();
    if (!job) return new Response('not found', { status: 404 });
    const at = new Date().toISOString();
    const artifacts = [{ id: 'artifact-1', name: 'review.json', mime: 'application/json', bytes: 4 }];
    if (mode !== 'no-edited') {
      artifacts.push({ id: 'edited-pdf-1', name: 'edited.pdf', mime: 'application/pdf', bytes: 40 });
    }
    return reply(200, {
      id: job.id,
      role: 'red',
      state: job.state === 'completed' ? 'completed' : 'running',
      artifacts,
      createdAt: at,
      updatedAt: at,
    });
  }
  return new Response('unmocked', { status: 404 });
}

const STUB_TABLES = [
  'CREATE TABLE ai_stub_calls (seq INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, path TEXT NOT NULL, method TEXT NOT NULL, owner_id TEXT NOT NULL)',
  'CREATE TABLE ai_stub_uploads (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL)',
  'CREATE TABLE ai_stub_jobs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, state TEXT NOT NULL, upload_id TEXT NOT NULL, payload TEXT)',
];

// Comments are removed first. 0006 keeps the contract comment that contains a semicolon,
// and a blind split would cut that CREATE TABLE in half.
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
  const sql = ['0001_shared_records.sql', '0002_invite_membership.sql', '0003_hosted_ai.sql', '0004_owner_usage.sql', '0005_guest_sessions.sql', '0006_booth.sql']
    .map(name => readFileSync(path.join(apiRoot, 'migrations', name), 'utf8'))
    .join('\n');
  return stripSqlComments(sql).split(';').map(part => part.trim()).filter(Boolean);
}

async function start(bindings = {}) {
  const instance = new Miniflare(convertV4MiniflareOptions({
    name: 'falsify-booth',
    modules: true,
    script,
    compatibilityDate: '2026-10-19',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      ALLOWED_ORIGINS: ORIGIN,
      AI_HOSTING_ENABLED: 'true',
      AI_OPEN_ACCESS: 'true',
      AI_RUNTIME_URL: 'https://runtime.test',
      HOSTED_AI_SERVICE_TOKEN: SERVICE_TOKEN,
      AI_MAX_UPLOAD_BYTES: '4096',
      AI_RUNTIME_TIMEOUT_MS: '5000',
      CONFLUENCE_ONLY: 'false',
      AI_GUESTS_PER_IP_HOUR: '50',
      AI_GUESTS_PER_HOUR: '100',
      AI_GUEST_JOBS_PER_OWNER_HOUR: '30',
      AI_GUEST_JOBS_PER_HOUR: '100',
      AI_GUEST_ACTIVE_JOBS_PER_OWNER: '6',
      AI_GUEST_UPLOADS_PER_OWNER_HOUR: '30',
      AI_JOBS_PER_OWNER_HOUR: '30',
      AI_ACTIVE_JOBS_PER_OWNER: '6',
      BOOTH_ENABLED: 'true',
      BOOTH_CONSENT_VERSION: CONSENT,
      BOOTH_OPERATOR_TOKEN: OPERATOR,
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
    if (typeof payload === 'string' && !Object.keys(h).some(key => key.toLowerCase() === 'content-type')) {
      h['Content-Type'] = 'application/json';
    }
    const response = await instance.dispatchFetch(`https://api.test${pathname}`, { method, headers: h, body: payload });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, headers: response.headers, body: parsed, text, bytes };
  };
}

async function withApp(bindings, fn) {
  const instance = await start(bindings);
  try {
    return await fn(instance, client(instance));
  } finally {
    await instance.dispose();
  }
}

async function invite(instance) {
  const code = 'fsi_' + randomBytes(32).toString('base64url');
  const d1 = await instance.getD1Database('DB');
  await d1.prepare('INSERT INTO invitations (code_hash, created_at, expires_at, revoked_at) VALUES (?1, ?2, ?3, NULL)')
    .bind(sha256(code), new Date().toISOString(), Date.now() + 3600e3).run();
  return code;
}

async function register(instance, call, username) {
  return call('POST', '/v1/auth/register', { body: { username, password: PASSWORD, inviteCode: await invite(instance) } });
}

const mintGuest = (call, headers = {}) => call('POST', '/v1/ai/guest', { body: {}, headers });
const fromIp = address => ({ 'CF-Connecting-IP': address });

function upload(call, token, bytes, headers = {}) {
  return call('POST', '/v1/ai/uploads', {
    token,
    raw: bytes,
    headers: { 'Content-Type': 'application/pdf', 'X-Falsify-File-Name': 'paper.pdf', ...headers },
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
    budget: { maxCalls: 2 },
    ...overrides,
  };
}

function applyOnlyBody(uploadId, key) {
  return {
    ...jobBody(uploadId, { idempotencyKey: key, budget: { maxCalls: 0 } }),
    applyOnly: true,
    edits: [{ id: 'edit-1', pageIndex: 0, before: '12.4%', after: '14.1%', occurrence: 0 }],
  };
}

const MULTIPART_BOUNDARY = '----falsifyboothboundary7x';

function submissionMeta(pdf, overrides = {}) {
  const file = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  return {
    course: 'quick',
    declared: [{
      pageIndex: 3,
      segmentId: 'p4-s2',
      before: 'p < 0.05',
      after: 'p < 0.5',
      defectType: 'number',
      reason: '유의수준을 바꿔 결론이 성립하지 않음',
    }],
    paper: { source: 'arxiv', id: '2503.10497', title: 'Synthetic paper', license: 'cc-by-4.0' },
    nickname: '부스방문자',
    consentVersion: CONSENT,
    editedSha256: createHash('sha256').update(file).digest('hex'),
    ...overrides,
  };
}

function multipartRaw(meta, pdf) {
  const file = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  const head = Buffer.from(
    `--${MULTIPART_BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="meta"\r\n' +
    'Content-Type: application/json; charset=utf-8\r\n\r\n' +
    `${JSON.stringify(meta)}\r\n` +
    `--${MULTIPART_BOUNDARY}\r\n` +
    'Content-Disposition: form-data; name="pdf"; filename="edited.pdf"\r\n' +
    'Content-Type: application/pdf\r\n\r\n'
  );
  const tail = Buffer.from(`\r\n--${MULTIPART_BOUNDARY}--\r\n`);
  return Buffer.concat([head, file, tail]);
}

function submitPdf(call, token, pdf, overrides = {}, headers = {}) {
  return call('POST', '/v1/booth/submissions', {
    token,
    raw: multipartRaw(submissionMeta(pdf, overrides), pdf),
    headers: {
      'Content-Type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      ...headers,
    },
  });
}

async function stubCalls(instance, pathname, method) {
  const d1 = await instance.getD1Database('DB');
  const row = await d1.prepare('SELECT COUNT(*) AS count FROM ai_stub_calls WHERE path = ?1 AND method = ?2')
    .bind(pathname, method).first();
  return Number(row.count);
}

before(async () => {
  const entry = [
    "import worker from './src/index.js';",
    "import { setAiFetchForTests } from './src/ai-runtime-client.mjs';",
    `setAiFetchForTests(${stubFetch.toString()});`,
    'export default worker;',
  ].join('\n');
  const result = await build({
    stdin: { contents: entry, resolveDir: apiRoot, sourcefile: 'booth-test-entry.mjs', loader: 'js' },
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

after(async () => { /* each test disposes its own instance */ });

test('operator id, gateway defaults and migration 0006 keep secrets out of the schema', () => {
  assert.equal(OWNER_ID.test('opr:booth'), true);
  assert.equal(OWNER_ID.test('opr:other'), false);
  assert.equal(OWNER_ID.test('gst:11111111-1111-4111-8111-111111111111'), true);
  const settings = aiSettings({});
  assert.equal(settings.guestBlue, true);
  assert.equal(settings.guestModelJobs, true);
  assert.equal(settings.guestApplyJobsSeparated, false);
  assert.equal(settings.guestApplyJobsPerHour, settings.guestJobsPerHour);
  assert.equal(settings.operatorJobsPerHour, 600);
  assert.equal(settings.operatorActiveJobs, 4);
  assert.equal(settings.operatorUploadsPerHour, 600);
  assert.equal(settings.operatorMaxCallsPerJob, settings.maxCallsPerJob);
  assert.equal(settings.operatorTokenBudget, 0);
  const event = aiSettings({
    AI_GUEST_BLUE: 'false',
    AI_GUEST_MODEL_JOBS: 'false',
    AI_GUEST_JOBS_PER_HOUR: '40',
    AI_GUEST_APPLY_JOBS_PER_HOUR: '600',
    BOOTH_OPERATOR_MAX_CALLS_PER_JOB: '80',
  });
  assert.equal(event.guestBlue, false);
  assert.equal(event.guestModelJobs, false);
  assert.equal(event.guestApplyJobsSeparated, true);
  assert.equal(event.guestApplyJobsPerHour, 600);
  assert.equal(event.operatorMaxCallsPerJob, 64);
  const sql = readFileSync(path.join(apiRoot, 'migrations', '0006_booth.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE booth_submissions/);
  assert.match(sql, /CREATE TABLE booth_settings/);
  assert.match(sql, /CREATE TABLE booth_files/);
  assert.match(sql, /pdf_sha256 TEXT NOT NULL/);
  assert.match(sql, /pdf_bytes INTEGER NOT NULL/);
  assert.match(sql, /source_sha256 TEXT/);
  assert.match(sql, /UNIQUE \(owner_id, pdf_sha256\)/);
  assert.match(sql, /PRIMARY KEY \(submission_id, idx\)/);
  assert.equal(/\bjob_id\b/.test(sql), false);
  assert.equal(/\bartifact_id\b/.test(sql), false);
  assert.match(sql, /claim_hash TEXT NOT NULL/);
  assert.match(sql, /CREATE INDEX booth_submissions_owner/);
  assert.match(sql, /CREATE INDEX booth_submissions_status/);
  assert.equal(/\buser_agent\b/i.test(sql), false);
  assert.equal(/\btoken TEXT\b/.test(sql), false);
  const wrangler = readFileSync(path.join(apiRoot, 'wrangler.jsonc'), 'utf8');
  assert.equal(wrangler.split('"BOOTH_ENABLED": "true"').length, 2);
  assert.equal(wrangler.split('"AI_GUEST_BLUE": "false"').length, 2);
  assert.equal(wrangler.split('"AI_GUEST_APPLY_JOBS_PER_HOUR": "600"').length, 2);
  assert.equal(wrangler.split('"PAPER_SEARCH_ENABLED": "true"').length, 2);
  for (const literal of [
    '"AI_GUESTS_PER_HOUR": "800"',
    '"AI_GUEST_UPLOADS_PER_HOUR": "400"',
    '"AI_GUEST_JOBS_PER_OWNER_HOUR": "20"',
    '"AI_GUEST_APPLY_JOBS_PER_HOUR": "600"',
    '"AI_GUEST_MODEL_JOBS": "false"',
    '"BOOTH_SUBMISSIONS_PER_IP_HOUR": "400"',
    '"BOOTH_CLAIMS_PER_IP_HOUR": "2000"',
    '"BOOTH_CLAIMS_PER_HOUR": "5000"',
    '"BOOTH_OPERATOR_ACTIVE_JOBS": "2"',
    '"PAPER_SEARCH_PER_IP_HOUR": "2000"',
    '"PAPER_PDF_PER_IP_HOUR": "600"',
  ]) {
    assert.equal(wrangler.split(literal).length, 2, literal);
  }
  assert.match(wrangler, /"BOOTH_CONSENT_VERSION": "2026-11-22.v1"/);
  assert.match(wrangler, /"AI_GUESTS_PER_IP_HOUR": "600"/);
  const boothSource = readFileSync(path.join(apiRoot, 'src/booth.mjs'), 'utf8');
  assert.match(boothSource, /const SEQ_ATTEMPTS = 5/);
  assert.match(boothSource, /claimsPerHour: positiveInt\(env\?\.BOOTH_CLAIMS_PER_HOUR, 2000\)/);
  assert.match(boothSource, /const PDF_CHUNK_BYTES = 512 \* 1024/);
  assert.match(boothSource, /const PDF_HARD_CAP = 32 \* 1024 \* 1024/);
  assert.match(boothSource, /const PDF_DEFAULT_BYTES = 20 \* 1024 \* 1024/);
  assert.equal(/"BOOTH_OPERATOR_TOKEN"\s*:/.test(wrangler), false);
});

test('booth stays dark until BOOTH_ENABLED is true, including for a valid operator', async () => {
  await withApp({ BOOTH_ENABLED: 'false' }, async (_mf, call) => {
    const open = await call('GET', '/v1/booth/config');
    assert.equal(open.status, 404);
    assert.equal(open.body.error.code, 'not_found');
    const authed = await call('GET', '/v1/booth/admin/submissions', { token: OPERATOR });
    assert.equal(authed.status, 404);
    assert.equal(authed.body.error.code, 'not_found');
    const preflight = await call('OPTIONS', '/v1/booth/config');
    assert.equal(preflight.status, 404);
  });
  await withApp({ BOOTH_ENABLED: '' }, async (_mf, call) => {
    const open = await call('POST', '/v1/booth/submissions', { raw: '{}' });
    assert.equal(open.status, 404);
    assert.equal(open.body.error.code, 'not_found');
  });
});

test('visitor submit, claim, publish, withdraw and admin pdf', async () => {
  await withApp({}, async (mf, call) => {
    const preflight = await call('OPTIONS', '/v1/booth/submissions', {
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
    assert.equal(preflight.headers.get('Cache-Control'), 'no-store');

    const config = await call('GET', '/v1/booth/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.enabled, true);
    assert.equal(config.body.submissionsOpen, true);
    assert.equal(config.body.consentVersion, CONSENT);
    assert.equal(config.body.limits.maxDeclared, 5);
    assert.equal(config.body.missions.length, 0);
    assert.equal(config.body.announcement, null);
    assert.equal(config.headers.get('Cache-Control'), 'no-store');
    assert.equal(config.headers.get('X-Content-Type-Options'), 'nosniff');

    const guest = (await mintGuest(call)).body.guest.token;
    const password = await register(mf, call, 'boothada');
    assert.equal(password.status, 201);
    const anon = await call('GET', '/v1/booth/admin/submissions');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'unauthorized');
    const asGuest = await call('GET', '/v1/booth/admin/submissions', { token: guest });
    assert.equal(asGuest.status, 403);
    assert.equal(asGuest.body.error.code, 'forbidden');
    const asPassword = await call('GET', '/v1/booth/admin/settings', { token: password.body.token });
    assert.equal(asPassword.status, 403);
    const wrong = await call('GET', '/v1/booth/admin/submissions', { token: WRONG_OPERATOR });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'unauthorized');
    const operatorSubmit = await call('POST', '/v1/booth/submissions', {
      token: OPERATOR,
      body: { course: 'quick' },
    });
    assert.equal(operatorSubmit.status, 403);
    assert.equal(operatorSubmit.body.error.code, 'forbidden');

    const guestPdf = pdfBytes('op-booth-happy1');
    const sourceSha256 = '11'.repeat(32);
    const jobsBefore = await stubCalls(mf, '/internal/v1/jobs', 'POST');
    const created = await submitPdf(call, guest, guestPdf, {
      paper: {
        source: 'arxiv', id: '2503.10497', title: 'Synthetic paper', license: 'cc-by-4.0', sourceSha256,
      },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.headers.get('X-Falsify-Parse-Ms'), null);
    assert.equal(created.body.receipt, 'F-0001');
    assert.match(created.body.claimKey, KEY_RE);
    assert.equal(created.body.status, 'received');
    assert.equal(created.body.course, 'quick');
    assert.equal(created.body.declaredCount, 1);
    assert.match(created.body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    const receipt = created.body.receipt;
    const claimKey = created.body.claimKey;

    const again = await submitPdf(call, guest, guestPdf);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'already_submitted');
    assert.equal(again.body.receipt, 'F-0001');

    const lower = await call('POST', '/v1/booth/claim', { body: { receipt, claimKey: claimKey.toLowerCase() } });
    assert.equal(lower.status, 200);
    assert.equal(lower.body.published, false);
    assert.equal(Object.hasOwn(lower.body, 'prizeMessage'), false);
    assert.equal(Object.hasOwn(lower.body, 'outcome'), false);
    const spaced = await call('POST', '/v1/booth/claim', { body: { receipt, claimKey: claimKey.replace('-', ' - ') } });
    assert.equal(spaced.status, 200);
    const plain = await call('POST', '/v1/booth/claim', { body: { receipt, claimKey: claimKey.replace('-', '') } });
    assert.equal(plain.status, 200);
    assert.equal(plain.body.declaredCount, 1);

    const d1 = await mf.getD1Database('DB');
    const stored = await d1.prepare(
      'SELECT id, owner_id FROM booth_submissions WHERE receipt = ?1'
    ).bind(receipt).first();
    const knownKey = 'A0B1CDEF';
    const knownReceipt = 'F-0088';
    await d1.prepare(
      `INSERT INTO booth_submissions (
        id, seq, receipt, claim_hash, owner_id, pdf_sha256, pdf_bytes, course, declared, consent_version, status, created_at, updated_at
      ) VALUES (?1, 88, ?2, ?3, ?4, ?5, 8, 'deep', '[]', ?6, 'received', ?7, ?7)`
    ).bind(
      '22222222-2222-4222-8222-222222222222',
      knownReceipt,
      sha256(`booth-claim:v1:${knownReceipt}:${knownKey}`),
      stored.owner_id,
      'cd'.repeat(32),
      CONSENT,
      new Date().toISOString(),
    ).run();
    const confused = await call('POST', '/v1/booth/claim', { body: { receipt: knownReceipt, claimKey: 'ao bi-cdef' } });
    assert.equal(confused.status, 200, 'O/I and spaces normalize');
    const ell = await call('POST', '/v1/booth/claim', { body: { receipt: knownReceipt, claimKey: 'a0bL-cdef' } });
    assert.equal(ell.status, 200, 'L normalizes to 1');
    const wrongKey = await call('POST', '/v1/booth/claim', { body: { receipt, claimKey: 'AAAAAAAA' } });
    const unknown = await call('POST', '/v1/booth/claim', { body: { receipt: 'F-9999', claimKey } });
    assert.equal(wrongKey.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(wrongKey.body.error.code, 'not_found');
    assert.equal(unknown.body.error.code, 'not_found');
    assert.equal(wrongKey.body.receipt, undefined);
    assert.equal(unknown.body.receipt, undefined);

    const hidden = await call('PATCH', `/v1/booth/admin/submissions/${receipt}`, {
      token: OPERATOR,
      body: { prizeMessage: 'GIFT-CODE', publicNote: '잘 봤습니다', outcome: 'caught', published: false },
    });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.published, false);
    assert.equal(hidden.body.prizeMessage, 'GIFT-CODE');
    const before = await call('POST', '/v1/booth/claim', { body: { receipt, claimKey } });
    assert.equal(before.body.published, false);
    assert.equal(Object.hasOwn(before.body, 'prizeMessage'), false);
    assert.equal(JSON.stringify(before.body).includes('GIFT-CODE'), false);

    const published = await call('PATCH', `/v1/booth/admin/submissions/${receipt}`, {
      token: OPERATOR,
      body: { published: true, aiSummary: { marker: 'operator-only' } },
    });
    assert.equal(published.status, 200);
    assert.equal(published.body.published, true);
    assert.match(published.body.publishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(published.body.aiSummary.marker, 'operator-only');
    assert.equal(published.body.pdfSha256, createHash('sha256').update(guestPdf).digest('hex'));
    assert.equal(published.body.pdfBytes, guestPdf.length);
    assert.equal(published.body.sourceSha256, sourceSha256);
    assert.equal(published.body.jobId, undefined);
    assert.equal(published.body.artifactId, undefined);
    assert.equal(JSON.stringify(published.body).includes(stored.owner_id), false);
    const after = await call('POST', '/v1/booth/claim', { body: { receipt, claimKey } });
    assert.equal(after.body.published, true);
    assert.equal(after.body.prizeMessage, 'GIFT-CODE');
    assert.equal(after.body.outcome, 'caught');
    assert.equal(after.body.publicNote, '잘 봤습니다');
    assert.equal(after.body.publishedAt, published.body.publishedAt);
    assert.equal(JSON.stringify(after.body).includes('operator-only'), false);

    const kept = await call('PATCH', `/v1/booth/admin/submissions/${receipt}`, {
      token: OPERATOR,
      body: { published: true },
    });
    assert.equal(kept.body.publishedAt, published.body.publishedAt, 'publishing again keeps the first timestamp');

    const pdf = await call('GET', `/v1/booth/admin/submissions/${receipt}/pdf`, { token: OPERATOR });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('Content-Type'), 'application/pdf');
    assert.equal(pdf.headers.get('Content-Disposition'), 'attachment; filename="F-0001.pdf"');
    assert.equal(pdf.headers.get('Cache-Control'), 'no-store');
    assert.equal(Buffer.compare(Buffer.from(pdf.bytes), guestPdf), 0);
    assert.equal(pdf.headers.get('X-Falsify-Pdf-Sha256'), published.body.pdfSha256);
    assert.equal(pdf.text.includes(stored.owner_id), false);
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), jobsBefore);
    const storedFiles = await d1.prepare(
      'SELECT COUNT(*) AS count FROM booth_files WHERE submission_id = ?1'
    ).bind(stored.id).first();
    assert.equal(Number(storedFiles.count), 1);

    const withdrawn = await call('POST', '/v1/booth/withdraw', { body: { receipt, claimKey } });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.body.status, 'withdrawn');
    assert.equal(withdrawn.body.published, false);
    assert.equal(withdrawn.body.declaredCount, 0);
    assert.equal(Object.hasOwn(withdrawn.body, 'prizeMessage'), false);
    const blocked = await call('PATCH', `/v1/booth/admin/submissions/${receipt}`, {
      token: OPERATOR,
      body: { status: 'judged' },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'withdrawn');
    const noted = await call('PATCH', `/v1/booth/admin/submissions/${receipt}`, {
      token: OPERATOR,
      body: { operatorNote: '철회됨' },
    });
    assert.equal(noted.status, 200);
    assert.equal(noted.body.operatorNote, '철회됨');
    assert.equal(noted.body.status, 'withdrawn');
    assert.equal(noted.body.prizeMessage, null);
    const detail = await call('GET', `/v1/booth/admin/submissions/${receipt}`, { token: OPERATOR });
    assert.equal(detail.status, 200);
    assert.equal(JSON.stringify(detail.body).includes('claim_hash'), false);
    assert.equal(JSON.stringify(detail.body).includes(stored.owner_id), false);
    assert.deepEqual(detail.body.declared, []);
    assert.equal(detail.body.nickname, null);
    assert.equal(detail.body.paper, null);
    assert.equal(detail.body.aiSummary, null);
    assert.equal(detail.body.outcome, null);
    assert.equal(detail.body.publicNote, null);
    assert.equal(detail.body.course, 'quick');
    assert.equal(detail.body.pdfSha256, published.body.pdfSha256);
    assert.equal(detail.body.jobId, undefined);
    const tomb = await d1.prepare(
      `SELECT declared, nickname, paper, public_note, prize_message, ai_summary, outcome, published_at,
              operator_note, course, consent_version, pdf_sha256, created_at
       FROM booth_submissions WHERE receipt = ?1`
    ).bind(receipt).first();
    assert.equal(tomb.declared, '[]');
    assert.equal(tomb.nickname, null);
    assert.equal(tomb.paper, null);
    assert.equal(tomb.public_note, null);
    assert.equal(tomb.prize_message, null);
    assert.equal(tomb.ai_summary, null);
    assert.equal(tomb.outcome, null);
    assert.equal(tomb.published_at, null);
    assert.equal(tomb.operator_note, '철회됨');
    assert.equal(tomb.course, 'quick');
    assert.equal(tomb.consent_version, CONSENT);
    assert.equal(tomb.pdf_sha256, published.body.pdfSha256);
    assert.equal(tomb.created_at, created.body.createdAt);
    const filesAfter = await d1.prepare(
      'SELECT COUNT(*) AS count FROM booth_files WHERE submission_id = ?1'
    ).bind(stored.id).first();
    assert.equal(Number(filesAfter.count), 0);
    const hiddenPdf = await call('GET', `/v1/booth/admin/submissions/${receipt}/pdf`, { token: OPERATOR });
    assert.equal(hiddenPdf.status, 404);
    assert.equal(hiddenPdf.body.error.code, 'withdrawn');
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), jobsBefore);
  });
});

test('submit rejects a bad paper, a stale consent or a private nickname', async () => {
  await withApp({}, async (mf, call) => {
    const guestA = (await mintGuest(call, fromIp('203.0.113.10'))).body.guest.token;
    const pdf = pdfBytes('shape');
    const staleConsent = await submitPdf(call, guestA, Buffer.from('not-pdf'), { consentVersion: '1999-01-01.v0' });
    assert.equal(staleConsent.status, 409);
    assert.equal(staleConsent.body.error.code, 'consent_outdated');

    const email = await submitPdf(call, guestA, pdf, { nickname: 'a@b' });
    assert.equal(email.status, 400);
    assert.equal(email.body.error.code, 'pii_not_allowed');
    const digits = await submitPdf(call, guestA, pdf, { nickname: '1234567' });
    assert.equal(digits.status, 400);
    assert.equal(digits.body.error.code, 'pii_not_allowed');
    const extra = await submitPdf(call, guestA, pdf, { email: 'hidden@example.test' });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.error.code, 'invalid_request');
    const meta = submissionMeta(pdf);
    delete meta.paper;
    const noPaper = await call('POST', '/v1/booth/submissions', {
      token: guestA,
      raw: multipartRaw(meta, pdf),
      headers: { 'Content-Type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` },
    });
    assert.equal(noPaper.status, 400);
    assert.equal(noPaper.body.error.code, 'paper_not_allowed');
    const uploaded = await submitPdf(call, guestA, pdf, {
      paper: { source: 'upload', id: 'local-1', title: 'Local', license: 'cc-by' },
    });
    assert.equal(uploaded.status, 400);
    assert.equal(uploaded.body.error.code, 'paper_not_allowed');
    const noncommercial = await submitPdf(call, guestA, pdf, {
      paper: { source: 'arxiv', id: '2503.10497', title: 'Synthetic paper', license: 'cc-by-nc-4.0' },
    });
    assert.equal(noncommercial.status, 400);
    assert.equal(noncommercial.body.error.code, 'paper_not_allowed');
    const filled = await submitPdf(call, guestA, pdfBytes('deep-course'), { course: 'deep' });
    assert.equal(filled.status, 201);
    assert.equal(filled.body.receipt, 'F-0001');
    assert.equal(filled.body.course, 'deep');
    const allowedLicense = await submitPdf(call, guestA, pdfBytes('mission-ok'), {
      paper: { source: 'mission', id: 'mission-1', title: 'Mission paper', license: 'public-domain' },
    });
    assert.equal(allowedLicense.status, 201);
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 0);
    const missing = await call('PUT', '/v1/booth/no-such');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
    assert.equal(typeof missing.body.error.requestId, 'string');
  });

  await withApp({ BOOTH_SUBMISSIONS_OPEN: 'false' }, async (_mf, call) => {
    const guest = (await mintGuest(call)).body.guest.token;
    const closed = await submitPdf(call, guest, Buffer.from('not-pdf'), { consentVersion: 'nope' });
    assert.equal(closed.status, 403);
    assert.equal(closed.body.error.code, 'booth_closed');
  });
});

test('admin list pages by seq and settings show up on the public config', async () => {
  await withApp({}, async (mf, call) => {
    const guest = (await mintGuest(call)).body.guest.token;
    const receipts = [];
    for (let i = 1; i <= 3; i++) {
      const created = await submitPdf(call, guest, pdfBytes(`op-booth-page0${i}`));
      assert.equal(created.status, 201, created.text);
      receipts.push(created.body.receipt);
    }
    assert.deepEqual(receipts, ['F-0001', 'F-0002', 'F-0003']);
    const first = await call('GET', '/v1/booth/admin/submissions?limit=2', { token: OPERATOR });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.submissions.map(row => row.receipt), ['F-0001', 'F-0002']);
    assert.equal(first.body.nextAfter, first.body.submissions[1].seq);
    const second = await call('GET', `/v1/booth/admin/submissions?after=${first.body.nextAfter}&limit=2`, { token: OPERATOR });
    assert.deepEqual(second.body.submissions.map(row => row.receipt), ['F-0003']);
    assert.equal(second.body.nextAfter, null);
    const judged = await call('PATCH', '/v1/booth/admin/submissions/F-0002', {
      token: OPERATOR,
      body: { status: 'judged', outcome: 'partial' },
    });
    assert.equal(judged.status, 200);
    assert.equal(judged.body.status, 'judged');
    const filtered = await call('GET', '/v1/booth/admin/submissions?status=judged,invalid', { token: OPERATOR });
    assert.deepEqual(filtered.body.submissions.map(row => row.receipt), ['F-0002']);
    const badLimit = await call('GET', '/v1/booth/admin/submissions?limit=201', { token: OPERATOR });
    assert.equal(badLimit.status, 400);
    const doomed = second.body.submissions[0].id;
    const removed = await call('DELETE', '/v1/booth/admin/submissions/F-0003', { token: OPERATOR });
    assert.equal(removed.status, 204);
    assert.equal(removed.body, null);
    const d1 = await mf.getD1Database('DB');
    const left = await d1.prepare('SELECT COUNT(*) AS count FROM booth_files WHERE submission_id = ?1').bind(doomed).first();
    assert.equal(Number(left.count), 0);
    const gone = await call('GET', '/v1/booth/admin/submissions/F-0003', { token: OPERATOR });
    assert.equal(gone.status, 404);

    const mission = {
      id: 'lane-a',
      title: '첫 과제',
      source: 'arxiv',
      paperId: '2503.10497',
      license: 'cc-by-4.0',
      course: 'any',
      hint: '숫자만',
    };
    const saved = await call('PUT', '/v1/booth/admin/settings', {
      token: OPERATOR,
      body: { submissionsOpen: false, missions: [mission], announcement: '곧 마감' },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.submissionsOpen, false);
    assert.deepEqual(saved.body.missions, [mission]);
    assert.equal(saved.body.announcement, '곧 마감');
    const config = await call('GET', '/v1/booth/config');
    assert.equal(config.body.submissionsOpen, false);
    assert.deepEqual(config.body.missions, [mission]);
    assert.equal(config.body.announcement, '곧 마감');
    const closed = await submitPdf(call, guest, pdfBytes('op-booth-shut01'));
    assert.equal(closed.status, 403);
    assert.equal(closed.body.error.code, 'booth_closed');
    const cleared = await call('PUT', '/v1/booth/admin/settings', {
      token: OPERATOR,
      body: { announcement: null, submissionsOpen: true },
    });
    assert.equal(cleared.body.announcement, null);
    assert.equal(cleared.body.submissionsOpen, true);
    assert.equal((await call('GET', '/v1/booth/config')).body.announcement, null);
    const huge = { note: 'x'.repeat(17000) };
    assert.ok(Buffer.byteLength(JSON.stringify(huge)) > 16 * 1024);
    const oversized = await call('PATCH', '/v1/booth/admin/submissions/F-0001', {
      token: OPERATOR,
      body: { aiSummary: huge },
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.body.error.code, 'invalid_request');
  });
});

test('per-owner, per-IP and claim buckets stop the next submission', async () => {
  await withApp({ BOOTH_SUBMISSIONS_PER_OWNER: '5' }, async (mf, call) => {
    const guest = (await mintGuest(call, fromIp('203.0.113.20'))).body.guest.token;
    const other = (await mintGuest(call, fromIp('203.0.113.21'))).body.guest.token;
    let first = null;
    for (let i = 1; i <= 5; i++) {
      const created = await submitPdf(call, guest, pdfBytes(`op-booth-cap0${i}`));
      assert.equal(created.status, 201, `submission ${i} ${created.text}`);
      if (!first) first = created.body;
    }
    const extraPdf = pdfBytes('op-booth-cap06');
    const extra = await submitPdf(call, guest, extraPdf);
    assert.equal(extra.status, 429);
    assert.equal(extra.body.error.code, 'rate_limited');
    const dropped = await call('POST', '/v1/booth/withdraw', {
      body: { receipt: first.receipt, claimKey: first.claimKey },
    });
    assert.equal(dropped.status, 200);
    const freed = await submitPdf(call, guest, extraPdf);
    assert.equal(freed.status, 201, `a withdrawn row does not count toward the owner cap ${freed.text}`);
    const allowed = await submitPdf(call, other, pdfBytes('op-booth-cap07'));
    assert.equal(allowed.status, 201);
  });

  await withApp({ BOOTH_SUBMISSIONS_PER_IP_HOUR: '1', BOOTH_SUBMISSIONS_PER_HOUR: '10' }, async (mf, call) => {
    const guest = (await mintGuest(call, fromIp('203.0.113.30'))).body.guest.token;
    assert.equal((await submitPdf(call, guest, pdfBytes('op-booth-ip001'), {}, fromIp('203.0.113.30'))).status, 201);
    const blocked = await submitPdf(call, guest, pdfBytes('op-booth-ip002'), {}, fromIp('203.0.113.30'));
    assert.equal(blocked.status, 429);
    const moved = await submitPdf(call, guest, pdfBytes('op-booth-ip002'), {}, fromIp('203.0.113.31'));
    assert.equal(moved.status, 201);
  });

  await withApp({ BOOTH_CLAIMS_PER_IP_HOUR: '1' }, async (mf, call) => {
    const guest = (await mintGuest(call)).body.guest.token;
    const created = await submitPdf(call, guest, pdfBytes('op-booth-claim1'));
    const ok = await call('POST', '/v1/booth/claim', {
      headers: fromIp('203.0.113.40'),
      body: { receipt: created.body.receipt, claimKey: created.body.claimKey },
    });
    assert.equal(ok.status, 200);
    const limited = await call('POST', '/v1/booth/withdraw', {
      headers: fromIp('203.0.113.40'),
      body: { receipt: created.body.receipt, claimKey: created.body.claimKey },
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'rate_limited');
  });

  await withApp({ BOOTH_CLAIMS_PER_HOUR: '1', BOOTH_CLAIMS_PER_IP_HOUR: '10' }, async (mf, call) => {
    const guest = (await mintGuest(call)).body.guest.token;
    const created = await submitPdf(call, guest, pdfBytes('op-booth-claimg'));
    const ok = await call('POST', '/v1/booth/claim', {
      headers: fromIp('203.0.113.50'),
      body: { receipt: created.body.receipt, claimKey: created.body.claimKey },
    });
    assert.equal(ok.status, 200);
    const blocked = await call('POST', '/v1/booth/claim', {
      headers: fromIp('203.0.113.51'),
      body: { receipt: created.body.receipt, claimKey: created.body.claimKey },
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    const d1 = await mf.getD1Database('DB');
    const global = await d1.prepare(`SELECT count FROM rate_counters WHERE bucket = 'booth-claim:all'`).first();
    assert.equal(Number(global.count) >= 1, true);
  });
});

test('multipart pdf checks, chunks and a same-hash duplicate', async () => {
  await withApp({}, async (mf, call) => {
    const guest = (await mintGuest(call, fromIp('203.0.113.60'))).body.guest.token;
    const other = (await mintGuest(call, fromIp('203.0.113.61'))).body.guest.token;
    const real = pdfBytes('mismatch-me');
    const digest = createHash('sha256').update(real).digest('hex');

    const notPdf = await submitPdf(call, guest, Buffer.from('not a pdf at all'));
    assert.equal(notPdf.status, 400);
    assert.equal(notPdf.body.error.code, 'invalid_pdf');
    assert.equal(notPdf.body.error.retryable, false);
    const empty = await submitPdf(call, guest, Buffer.alloc(0));
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'invalid_pdf');
    const mismatch = await submitPdf(call, guest, real, { editedSha256: 'ab'.repeat(32) });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, 'pdf_mismatch');
    const unchanged = await submitPdf(call, guest, real, {
      paper: {
        source: 'arxiv', id: '2503.10497', title: 'Synthetic paper', license: 'cc-by-4.0', sourceSha256: digest,
      },
    });
    assert.equal(unchanged.status, 400);
    assert.equal(unchanged.body.error.code, 'pdf_unchanged');
    const upper = await submitPdf(call, guest, real, { editedSha256: digest.toUpperCase() });
    assert.equal(upper.status, 400);
    assert.equal(upper.body.error.code, 'invalid_request');
    const jsonBody = await call('POST', '/v1/booth/submissions', { token: guest, body: { course: 'quick' } });
    assert.equal(jsonBody.status, 415);
    assert.equal(jsonBody.body.error.code, 'unsupported_media_type');

    const created = await submitPdf(call, guest, real);
    assert.equal(created.status, 201, created.text);
    const shared = await submitPdf(call, other, real);
    assert.equal(shared.status, 201, 'another owner may submit the same bytes');
    const again = await submitPdf(call, guest, real);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'already_submitted');
    assert.equal(again.body.receipt, created.body.receipt);

    const chunkBytes = 512 * 1024;
    const big = Buffer.alloc(chunkBytes + 17);
    big.write('%PDF-1.7\n', 0, 'ascii');
    for (let i = 9; i < big.length; i++) big[i] = i & 0xff;
    const chunked = await submitPdf(call, guest, big);
    assert.equal(chunked.status, 201, chunked.text);
    const pdf = await call('GET', `/v1/booth/admin/submissions/${chunked.body.receipt}/pdf`, { token: OPERATOR });
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.compare(Buffer.from(pdf.bytes), big), 0);
    assert.equal(pdf.headers.get('X-Falsify-Pdf-Sha256'), createHash('sha256').update(big).digest('hex'));
    const d1 = await mf.getD1Database('DB');
    const row = await d1.prepare('SELECT id FROM booth_submissions WHERE receipt = ?1').bind(chunked.body.receipt).first();
    const blobs = await d1.prepare(
      'SELECT idx, data FROM booth_files WHERE submission_id = ?1 ORDER BY idx ASC'
    ).bind(row.id).all();
    assert.equal(blobs.results.length, 2);
    assert.equal(Number(blobs.results[0].idx), 0);
    assert.equal(Number(blobs.results[1].idx), 1);
    const first = Buffer.from(blobs.results[0].data);
    const second = Buffer.from(blobs.results[1].data);
    assert.equal(first.length, chunkBytes);
    assert.equal(second.length, 17);
    assert.equal(first[first.length - 1], (chunkBytes - 1) & 0xff);
    assert.equal(second[second.length - 1], (big.length - 1) & 0xff);
    assert.equal(Buffer.compare(Buffer.concat([first, second]), big), 0);

    const withdrawn = await call('POST', '/v1/booth/withdraw', {
      body: { receipt: chunked.body.receipt, claimKey: chunked.body.claimKey },
    });
    assert.equal(withdrawn.status, 200);
    const afterWithdraw = await d1.prepare(
      'SELECT COUNT(*) AS count FROM booth_files WHERE submission_id = ?1'
    ).bind(row.id).first();
    assert.equal(Number(afterWithdraw.count), 0);

    const deleted = await call('DELETE', `/v1/booth/admin/submissions/${shared.body.receipt}`, { token: OPERATOR });
    assert.equal(deleted.status, 204);
    const sharedRow = await d1.prepare(
      'SELECT id FROM booth_submissions WHERE receipt = ?1'
    ).bind(shared.body.receipt).first();
    assert.equal(sharedRow, null);
    const sharedFiles = await d1.prepare('SELECT COUNT(*) AS count FROM booth_files').first();
    const kept = await d1.prepare(
      'SELECT COUNT(*) AS count FROM booth_files WHERE submission_id = (SELECT id FROM booth_submissions WHERE receipt = ?1)'
    ).bind(created.body.receipt).first();
    assert.equal(Number(kept.count), 1);
    assert.equal(Number(sharedFiles.count), 1);
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 0);
  });

  await withApp({ BOOTH_MAX_PDF_BYTES: '1024' }, async (_mf, call) => {
    const guest = (await mintGuest(call)).body.guest.token;
    const overPdf = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2000, 0x62)]);
    const tooBig = await submitPdf(call, guest, overPdf);
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.error.code, 'payload_too_large');
    assert.equal(tooBig.body.error.retryable, false);
    const overBody = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(1024 + 64 * 1024, 0x63)]);
    const tooLong = await submitPdf(call, guest, overBody);
    assert.equal(tooLong.status, 413);
    assert.equal(tooLong.body.error.code, 'payload_too_large');
  });
});

test('a 20 MiB multipart body is parsed inside the worker', async () => {
  await withApp({ BOOTH_PARSE_TIMING: '1' }, async (_mf, call) => {
    const guest = (await mintGuest(call)).body.guest.token;
    const big = Buffer.alloc(20 * 1024 * 1024, 0x61);
    const wallStart = performance.now();
    const denied = await submitPdf(call, guest, big);
    const wallMs = performance.now() - wallStart;
    assert.equal(denied.status, 400);
    assert.equal(denied.body.error.code, 'invalid_pdf');
    const parseMs = Number(denied.headers.get('X-Falsify-Parse-Ms'));
    assert.equal(Number.isFinite(parseMs) && parseMs >= 0, true);
    console.log(`BOOTH_PARSE_MS ${parseMs.toFixed(3)} BOOTH_PARSE_WALL_MS ${wallMs.toFixed(3)}`);
  });
});

test('guest BLUE is refused before a rate slot when disabled and allowed when unset', async () => {
  await withApp({
    AI_GUEST_BLUE: 'false',
    AI_OPEN_ACCESS: 'true',
    AI_GUEST_JOBS_PER_HOUR: '1',
    AI_GUEST_JOBS_PER_OWNER_HOUR: '5',
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '4',
  }, async (mf, call) => {
    const guest = (await mintGuest(call)).body.guest.token;
    const up = await upload(call, guest, pdfBytes('blue-off'));
    assert.equal(up.status, 201);
    const missing = '55555555-5555-4555-8555-555555555555';
    const blocked = await call('POST', '/v1/ai/jobs', {
      token: guest,
      body: jobBody(missing, { role: 'blue', idempotencyKey: 'op-blue-blocked' }),
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'guest_blue_disabled');
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 0);
    const red = await call('POST', '/v1/ai/jobs', {
      token: guest,
      body: jobBody(up.body.upload.id, { idempotencyKey: 'op-blue-red001' }),
    });
    assert.equal(red.status, 202, 'the refused BLUE job did not spend the guest job slot');
    const unsigned = await call('GET', '/v1/ai/capabilities');
    const asGuest = await call('GET', '/v1/ai/capabilities', { token: guest });
    assert.equal(unsigned.body.blueJobs, false);
    assert.equal(asGuest.body.blueJobs, false);
    assert.equal(unsigned.body.modelJobs, true);
    assert.equal(asGuest.body.modelJobs, true);
    const ada = await register(mf, call, 'blueada');
    const adaUp = await upload(call, ada.body.token, pdfBytes('blue-ada'));
    const adaBlue = await call('POST', '/v1/ai/jobs', {
      token: ada.body.token,
      body: jobBody(adaUp.body.upload.id, { role: 'blue', idempotencyKey: 'op-blue-ada001' }),
    });
    assert.equal(adaBlue.status, 202, 'a password owner can still run BLUE');
  });

  await withApp({ AI_OPEN_ACCESS: 'true', AI_GUEST_JOBS_PER_OWNER_HOUR: '4', AI_GUEST_ACTIVE_JOBS_PER_OWNER: '2' }, async (mf, call) => {
    const guest = (await mintGuest(call)).body.guest.token;
    const up = await upload(call, guest, pdfBytes('blue-on'));
    const allowed = await call('POST', '/v1/ai/jobs', {
      token: guest,
      body: jobBody(up.body.upload.id, { role: 'blue', idempotencyKey: 'op-blue-open001' }),
    });
    assert.equal(allowed.status, 202);
    assert.equal((await call('GET', '/v1/ai/capabilities')).body.blueJobs, true);
    assert.equal((await call('GET', '/v1/ai/capabilities', { token: guest })).body.blueJobs, true);
  });

  await withApp({ AI_OPEN_ACCESS: 'false', AI_GUEST_BLUE: 'false', AI_GUEST_MODEL_JOBS: 'false' }, async (_mf, call) => {
    const unsigned = await call('GET', '/v1/ai/capabilities');
    assert.equal(unsigned.body.blueJobs, true);
    assert.equal(unsigned.body.modelJobs, true);
    const asOperator = await call('GET', '/v1/ai/capabilities', { token: OPERATOR });
    assert.equal(asOperator.body.blueJobs, true);
    assert.equal(asOperator.body.modelJobs, true);
  });
});

test('guest model jobs stop before a rate slot and a valid operator still sees both flags', async () => {
  await withApp({
    AI_GUEST_MODEL_JOBS: 'false',
    AI_GUEST_BLUE: 'false',
    AI_OPEN_ACCESS: 'true',
    AI_GUEST_JOBS_PER_HOUR: '1',
    AI_GUEST_JOBS_PER_OWNER_HOUR: '5',
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '4',
  }, async (mf, call) => {
    const guest = (await mintGuest(call)).body.guest.token;
    const missing = '66666666-6666-4666-8666-666666666666';
    const blue = await call('POST', '/v1/ai/jobs', {
      token: guest,
      body: jobBody(missing, { role: 'blue', idempotencyKey: 'op-model-blue' }),
    });
    assert.equal(blue.status, 403);
    assert.equal(blue.body.error.code, 'guest_blue_disabled');
    const model = await call('POST', '/v1/ai/jobs', {
      token: guest,
      body: jobBody(missing, { idempotencyKey: 'op-model-red' }),
    });
    assert.equal(model.status, 403);
    assert.equal(model.body.error.code, 'guest_model_disabled');
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 0);
    const up = await upload(call, guest, pdfBytes('model-off'));
    const apply = await call('POST', '/v1/ai/jobs', {
      token: guest,
      body: applyOnlyBody(up.body.upload.id, 'op-model-apply'),
    });
    assert.equal(apply.status, 202, 'the refused model job did not spend the guest job slot');
    const unsigned = await call('GET', '/v1/ai/capabilities');
    const asGuest = await call('GET', '/v1/ai/capabilities', { token: guest });
    const asWrong = await call('GET', '/v1/ai/capabilities', { token: WRONG_OPERATOR });
    for (const view of [unsigned, asGuest, asWrong]) {
      assert.equal(view.status, 200);
      assert.equal(view.body.blueJobs, false);
      assert.equal(view.body.modelJobs, false);
    }
    const asOperator = await call('GET', '/v1/ai/capabilities', { token: OPERATOR });
    assert.equal(asOperator.status, 200);
    assert.equal(asOperator.body.blueJobs, true);
    assert.equal(asOperator.body.modelJobs, true);
    assert.equal(asOperator.body.openAccess.enabled, true);
    const ada = await register(mf, call, 'modelada');
    const adaUp = await upload(call, ada.body.token, pdfBytes('model-ada'));
    const adaJob = await call('POST', '/v1/ai/jobs', {
      token: ada.body.token,
      body: jobBody(adaUp.body.upload.id, { idempotencyKey: 'op-model-ada' }),
    });
    assert.equal(adaJob.status, 202, 'a password owner can still run a model job');
  });
});

test('guest applyOnly jobs use their own bucket only when the env var is set', async () => {
  const caps = {
    AI_GUEST_JOBS_PER_HOUR: '1',
    AI_GUEST_JOBS_PER_OWNER_HOUR: '10',
    AI_GUEST_ACTIVE_JOBS_PER_OWNER: '10',
    AI_GUEST_UPLOADS_PER_OWNER_HOUR: '10',
  };
  await withApp({ ...caps, AI_GUEST_APPLY_JOBS_PER_HOUR: '2' }, async (mf, call) => {
    const guest = (await mintGuest(call)).body.guest.token;
    const up = await upload(call, guest, pdfBytes('apply-split'));
    const model = await call('POST', '/v1/ai/jobs', {
      token: guest,
      body: jobBody(up.body.upload.id, { idempotencyKey: 'op-split-model1' }),
    });
    assert.equal(model.status, 202);
    const modelAgain = await call('POST', '/v1/ai/jobs', {
      token: guest,
      body: jobBody(up.body.upload.id, { idempotencyKey: 'op-split-model2' }),
    });
    assert.equal(modelAgain.status, 429);
    const apply1 = await call('POST', '/v1/ai/jobs', { token: guest, body: applyOnlyBody(up.body.upload.id, 'op-split-apply1') });
    const apply2 = await call('POST', '/v1/ai/jobs', { token: guest, body: applyOnlyBody(up.body.upload.id, 'op-split-apply2') });
    assert.equal(apply1.status, 202);
    assert.equal(apply2.status, 202);
    const apply3 = await call('POST', '/v1/ai/jobs', { token: guest, body: applyOnlyBody(up.body.upload.id, 'op-split-apply3') });
    assert.equal(apply3.status, 429);
    const d1 = await mf.getD1Database('DB');
    const rows = await d1.prepare(
      `SELECT bucket, count FROM rate_counters WHERE bucket IN ('ai-guest-jobs:all', 'ai-guest-apply-jobs:all')`
    ).all();
    const counts = Object.fromEntries(rows.results.map(row => [row.bucket, row.count]));
    assert.equal(counts['ai-guest-jobs:all'] >= 1, true);
    assert.equal(counts['ai-guest-apply-jobs:all'] >= 2, true);
  });

  await withApp(caps, async (mf, call) => {
    const guest = (await mintGuest(call)).body.guest.token;
    const up = await upload(call, guest, pdfBytes('apply-shared'));
    const apply = await call('POST', '/v1/ai/jobs', { token: guest, body: applyOnlyBody(up.body.upload.id, 'op-shared-apply') });
    assert.equal(apply.status, 202);
    const model = await call('POST', '/v1/ai/jobs', {
      token: guest,
      body: jobBody(up.body.upload.id, { idempotencyKey: 'op-shared-model' }),
    });
    assert.equal(model.status, 429, 'unset apply cap keeps one guest job bucket');
    const d1 = await mf.getD1Database('DB');
    const separated = await d1.prepare(`SELECT COUNT(*) AS count FROM rate_counters WHERE bucket = 'ai-guest-apply-jobs:all'`).first();
    assert.equal(Number(separated.count), 0);
  });
});

test('operator jobs use operator limits and the opr:booth owner', async () => {
  await withApp({
    AI_OPEN_ACCESS: 'false',
    AI_JOBS_PER_OWNER_HOUR: '20',
    BOOTH_OPERATOR_ACTIVE_JOBS: '30',
    AI_ACTIVE_JOBS_PER_OWNER: '3',
  }, async (mf, call) => {
    const up = await upload(call, OPERATOR, pdfBytes('operator-batch'));
    assert.equal(up.status, 201);
    const d1 = await mf.getD1Database('DB');
    const owner = await d1.prepare('SELECT owner_id FROM ai_uploads WHERE id = ?1').bind(up.body.upload.id).first();
    assert.equal(owner.owner_id, 'opr:booth');
    for (let i = 1; i <= 21; i++) {
      const created = await call('POST', '/v1/ai/jobs', {
        token: OPERATOR,
        body: jobBody(up.body.upload.id, { idempotencyKey: `op-opr-${String(i).padStart(4, '0')}`, role: i === 21 ? 'blue' : 'red' }),
      });
      assert.equal(created.status, 202, `operator job ${i}`);
    }
    assert.equal(await stubCalls(mf, '/internal/v1/jobs', 'POST'), 21);
  });

  // An empty secret fails the fso_ pattern, which is the same 401 as an unset binding.
  await withApp({ BOOTH_OPERATOR_TOKEN: '' }, async (_mf, call) => {
    const unset = await call('GET', '/v1/booth/admin/submissions', { token: OPERATOR });
    assert.equal(unset.status, 401);
    assert.equal(unset.body.error.code, 'unauthorized');
  });
});
