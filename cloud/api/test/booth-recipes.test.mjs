// Booth recipe API, mission text, /mcp wiring and submission assist fields. Offline: Miniflare + local D1.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRecipe, getRecipe, missionTextFrom, missionsList, normalizeRecipeCode, parseRecipe, RECIPE_TTL_MS,
} from '../src/booth-recipes.mjs';

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
const missionFixture = path.join(here, 'fixtures', 'booth-mission-text.fixture.json');
const mcpProbe = path.join(here, 'fixtures', 'agent-mcp-probe.mjs');

const ORIGIN = 'https://shinick-han.github.io';
const OPERATOR = 'fso_' + randomBytes(32).toString('base64url');
const CONSENT = '2026-11-22.v1';
const SOURCE_HASH = '11'.repeat(32);
const EVENT_PAGE = 'https://shinick-han.github.io/falsify-workbench/event.html';
const MIGRATIONS = ['0001_shared_records.sql', '0002_invite_membership.sql', '0003_hosted_ai.sql', '0004_owner_usage.sql',
  '0005_guest_sessions.sql', '0006_booth.sql', '0007_booth_recipes.sql'];
const CODE_RE = /^R-[0-9A-HJKMNP-TV-Z]{6}$/;
const BOUNDARY = '----falsifyrecipeboundary';

let script;
let probeScript;
let statements;

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

async function bundle({ probe = false } = {}) {
  const entry = [
    "import worker from './src/index.js';",
    "import { setAiFetchForTests } from './src/ai-runtime-client.mjs';",
    "setAiFetchForTests(async () => new Response('unmocked', { status: 404 }));",
    'export default worker;',
  ].join('\n');
  const result = await build({
    stdin: { contents: entry, resolveDir: apiRoot, sourcefile: 'recipe-test-entry.mjs', loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['node:*'],
    logLevel: 'silent',
    plugins: [{
      name: 'recipe-fixtures',
      setup(b) {
        b.onResolve({ filter: /cloud-records-core\.mjs$/ }, () => ({ path: corePath }));
        b.onResolve({ filter: /harness-core\.js$/ }, () => ({ path: harnessPath }));
        b.onResolve({ filter: /booth-mission-text\.json$/ }, () => ({ path: missionFixture }));
        if (probe) b.onResolve({ filter: /agent-mcp\.mjs$/ }, () => ({ path: mcpProbe }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

before(async () => {
  script = await bundle();
  probeScript = await bundle({ probe: true });
  const sql = MIGRATIONS.map(name => readFileSync(path.join(apiRoot, 'migrations', name), 'utf8')).join('\n');
  statements = stripSqlComments(sql).split(';').map(part => part.trim()).filter(Boolean);
});

async function start(bindings = {}, { probe = false } = {}) {
  const instance = new Miniflare(convertV4MiniflareOptions({
    name: 'falsify-recipes',
    modules: true,
    script: probe ? probeScript : script,
    compatibilityDate: '2026-10-19',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      ALLOWED_ORIGINS: ORIGIN,
      AI_HOSTING_ENABLED: 'true',
      AI_OPEN_ACCESS: 'true',
      AI_RUNTIME_URL: 'https://runtime.test',
      HOSTED_AI_SERVICE_TOKEN: 'test-service-token-' + 't'.repeat(24),
      CONFLUENCE_ONLY: 'false',
      AI_GUESTS_PER_IP_HOUR: '50',
      AI_GUESTS_PER_HOUR: '100',
      BOOTH_ENABLED: 'true',
      BOOTH_CONSENT_VERSION: CONSENT,
      BOOTH_OPERATOR_TOKEN: OPERATOR,
      BOOTH_SUBMISSIONS_PER_OWNER: '20',
      EVENT_PAGE_URL: EVENT_PAGE,
      ...bindings,
    },
    d1Databases: ['DB'],
  }));
  const d1 = await instance.getD1Database('DB');
  for (const statement of statements) await d1.prepare(statement).run();
  return instance;
}

function client(instance) {
  return async (method, pathname, { token, body, raw, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) payload = JSON.stringify(body);
    if (typeof payload === 'string' && !Object.keys(h).some(key => key.toLowerCase() === 'content-type')) {
      h['Content-Type'] = 'application/json';
    }
    const response = await instance.dispatchFetch('https://api.test' + pathname, { method, headers: h, body: payload });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, headers: response.headers, body: parsed, text };
  };
}

async function withApp(bindings, fn, options) {
  const instance = await start(bindings, options);
  try {
    return await fn(instance, client(instance));
  } finally {
    await instance.dispose();
  }
}

function recipe(overrides = {}) {
  return {
    schema: 'falsify.booth.recipe.v1',
    paperId: '2309.15217',
    edits: [{ page: 5, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70' }],
    defectType: 'number',
    reason: 'Ragas faithfulness lowered to 0.50 while the text says Ragas agrees best with humans.',
    source: 'agent',
    agent: { name: 'Claude Code', model: 'claude-opus-5-5' },
    ...overrides,
  };
}

function fieldOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'invalid_request');
    return error.field ?? null;
  }
  assert.fail('expected invalid_request');
}

function assertStarCors(response) {
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
}

test('recipe validation follows contract section 1 and forces source to agent', () => {
  const ok = parseRecipe(recipe({ source: 'my-ai' }));
  assert.equal(ok.source, 'agent');
  assert.equal(ok.schema, 'falsify.booth.recipe.v1');
  assert.deepEqual(ok.edits, recipe().edits);
  const minimal = parseRecipe({ paperId: 'hep-th/9901001v2', edits: [{ find: 'a', replace: '' }] });
  assert.deepEqual(minimal, { schema: 'falsify.booth.recipe.v1', paperId: 'hep-th/9901001v2', edits: [{ find: 'a', replace: '' }], source: 'agent' });
  assert.equal(parseRecipe(recipe({ reason: 'line one\nline two' })).reason, 'line one\nline two');
  assert.equal(parseRecipe({ paperId: '2309.15217v3', edits: [{ find: 'x', replace: 'y', context: 'a\nb' }] }).edits[0].context, 'a\nb');

  assert.equal(fieldOf(() => parseRecipe(recipe({ extra: 1 }))), 'extra');
  assert.equal(fieldOf(() => parseRecipe(recipe({ schema: 'other' }))), 'schema');
  assert.equal(fieldOf(() => parseRecipe(recipe({ paperId: '2309.152' }))), 'paperId');
  assert.equal(fieldOf(() => parseRecipe(recipe({ paperId: 'arXiv:2309.15217' }))), 'paperId');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [] }))), 'edits');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: Array.from({ length: 6 }, () => ({ find: 'a', replace: 'b' })) }))), 'edits');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [{ find: 'a', replace: 'b', page: 0 }] }))), 'edits[0].page');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [{ find: 'a', replace: 'b', page: 501 }] }))), 'edits[0].page');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [{ find: 'a', replace: 'b', page: 1.5 }] }))), 'edits[0].page');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [{ find: '   ', replace: 'b' }] }))), 'edits[0].find');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [{ find: 'x'.repeat(301), replace: 'b' }] }))), 'edits[0].find');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [{ find: 'a\nb', replace: 'b' }] }))), 'edits[0].find');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [{ find: 'a', replace: 'a' }] }))), 'edits[0].replace');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [{ find: 'a', replace: 'x'.repeat(301) }] }))), 'edits[0].replace');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [{ find: 'a', replace: 'b', context: 'c'.repeat(601) }] }))), 'edits[0].context');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [{ find: 'a', replace: 'b', note: 1 }] }))), 'edits[0].note');
  assert.equal(fieldOf(() => parseRecipe(recipe({ edits: [{ find: 'a' }] }))), 'edits[0].replace');
  assert.equal(fieldOf(() => parseRecipe(recipe({ defectType: 'typo' }))), 'defectType');
  assert.equal(fieldOf(() => parseRecipe(recipe({ reason: 'r'.repeat(501) }))), 'reason');
  assert.equal(fieldOf(() => parseRecipe(recipe({ reason: 'tab\there' }))), 'reason');
  assert.equal(fieldOf(() => parseRecipe(recipe({ source: 'robot' }))), 'source');
  assert.equal(fieldOf(() => parseRecipe(recipe({ agent: { name: 'n'.repeat(61) } }))), 'agent.name');
  assert.equal(fieldOf(() => parseRecipe(recipe({ agent: { model: 'a\x07' } }))), 'agent.model');
  assert.equal(fieldOf(() => parseRecipe(recipe({ agent: { email: 'x' } }))), 'agent.email');
  assert.equal(fieldOf(() => parseRecipe([])), null);
});

test('recipe codes normalise case, spacing and Crockford look-alikes', () => {
  assert.equal(normalizeRecipeCode('r-7k3qxm'), 'R-7K3QXM');
  assert.equal(normalizeRecipeCode(' R 7K3QXM '), 'R-7K3QXM');
  assert.equal(normalizeRecipeCode('r-7k3qxo'), 'R-7K3QX0');
  assert.equal(normalizeRecipeCode('R-ILLL00'), 'R-111100');
  assert.equal(normalizeRecipeCode('7K3QXM'), null);
  assert.equal(normalizeRecipeCode('R-7K3QX'), null);
  assert.equal(normalizeRecipeCode('R-7K3QXU'), null);
  assert.equal(normalizeRecipeCode(42), null);
});

test('mission text lookup only serves papers in the bundled file', () => {
  const data = JSON.parse(readFileSync(missionFixture, 'utf8'));
  assert.equal(missionTextFrom(data, '2309.15217').pages.length, 2);
  assert.equal(missionTextFrom(data, '2401.00001'), null);
  assert.equal(missionTextFrom(data, '__proto__'), null);
  assert.equal(missionTextFrom({ schema: 'other', papers: data.papers }, '2309.15217'), null);
  const shipped = JSON.parse(readFileSync(path.join(apiRoot, 'src', 'booth-mission-text.json'), 'utf8'));
  assert.equal(shipped.schema, 'falsify.booth.mission-text.v1');
});

test('POST and GET recipes: 201, CORS star, case-insensitive codes, 400 field, 413, 415, 405, preflight', async () => {
  await withApp({}, async (_mf, call) => {
    // A foreign origin is fine here: these routes are public and answer "*".
    const created = await call('POST', '/v1/booth/recipes', { body: recipe({ source: 'manual' }), headers: { Origin: 'https://agent.example' } });
    assert.equal(created.status, 201, created.text);
    assertStarCors(created);
    assert.match(created.body.code, CODE_RE);
    assert.equal(created.body.url, EVENT_PAGE + '#recipe=' + created.body.code);
    const ttl = Date.parse(created.body.expiresAt) - Date.now();
    assert.ok(ttl > RECIPE_TTL_MS - 60_000 && ttl <= RECIPE_TTL_MS, String(ttl));
    assert.deepEqual(Object.keys(created.body).sort(), ['code', 'expiresAt', 'url']);

    const lower = await call('GET', '/v1/booth/recipes/' + created.body.code.toLowerCase(), { headers: { Origin: 'https://agent.example' } });
    assert.equal(lower.status, 200, lower.text);
    assertStarCors(lower);
    assert.equal(lower.body.code, created.body.code);
    assert.equal(lower.body.source, 'agent');
    assert.equal(lower.body.expiresAt, created.body.expiresAt);
    assert.ok(Date.parse(lower.body.createdAt) <= Date.now());
    assert.deepEqual(lower.body.edits, recipe().edits);
    assert.deepEqual(lower.body.agent, recipe().agent);
    const compact = await call('GET', '/v1/booth/recipes/' + created.body.code.replace('-', ''));
    assert.equal(compact.status, 200);

    const unknown = await call('GET', '/v1/booth/recipes/R-ZZZZZZ');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'not_found');
    assertStarCors(unknown);
    assert.equal((await call('GET', '/v1/booth/recipes/not-a-code')).status, 404);

    const bad = await call('POST', '/v1/booth/recipes', { body: recipe({ edits: [{ find: 'a', replace: 'a' }] }) });
    assert.equal(bad.status, 400);
    assert.deepEqual({ code: bad.body.error.code, field: bad.body.error.field }, { code: 'invalid_request', field: 'edits[0].replace' });
    assertStarCors(bad);
    assert.equal((await call('POST', '/v1/booth/recipes', { raw: '{not json' })).status, 400);

    const huge = await call('POST', '/v1/booth/recipes', { body: recipe({ reason: 'x'.repeat(9000) }) });
    assert.equal(huge.status, 413);
    assert.equal(huge.body.error.code, 'payload_too_large');
    assertStarCors(huge);

    const text = await call('POST', '/v1/booth/recipes', { raw: JSON.stringify(recipe()), headers: { 'Content-Type': 'text/plain' } });
    assert.equal(text.status, 415);

    const put = await call('PUT', '/v1/booth/recipes', { body: recipe() });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'POST');
    const postOne = await call('POST', '/v1/booth/recipes/' + created.body.code, { body: recipe() });
    assert.equal(postOne.status, 405);
    assert.equal(postOne.headers.get('allow'), 'GET');

    const pre = await call('OPTIONS', '/v1/booth/recipes', { headers: { Origin: 'https://agent.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204);
    assertStarCors(pre);
    assert.equal(pre.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
    assert.equal(pre.headers.get('access-control-allow-headers'), 'Content-Type');

    // Other booth routes keep the exact-origin gate.
    const config = await call('GET', '/v1/booth/config', { headers: { Origin: 'https://agent.example' } });
    assert.equal(config.status, 403);
  });
});

test('per-IP and global hourly limits answer 429 with Retry-After', async () => {
  await withApp({ BOOTH_RECIPES_PER_IP_HOUR: '2', BOOTH_RECIPES_PER_HOUR: '3' }, async (mf, call) => {
    const ip = address => ({ 'CF-Connecting-IP': address });
    assert.equal((await call('POST', '/v1/booth/recipes', { body: recipe(), headers: ip('198.51.100.1') })).status, 201);
    assert.equal((await call('POST', '/v1/booth/recipes', { body: recipe(), headers: ip('198.51.100.1') })).status, 201);
    const perIp = await call('POST', '/v1/booth/recipes', { body: recipe(), headers: ip('198.51.100.1') });
    assert.equal(perIp.status, 429);
    assert.equal(perIp.body.error.code, 'rate_limited');
    assert.equal(perIp.body.error.retryable, true);
    const wait = Number(perIp.headers.get('retry-after'));
    assert.ok(Number.isInteger(wait) && wait > 0 && wait <= 3600);
    assert.equal(perIp.body.error.retryAfterSeconds, wait);
    assertStarCors(perIp);
    assert.equal(perIp.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.equal((await call('POST', '/v1/booth/recipes', { body: recipe(), headers: ip('198.51.100.2') })).status, 201);
    const global = await call('POST', '/v1/booth/recipes', { body: recipe(), headers: ip('198.51.100.3') });
    assert.equal(global.status, 429);
    // Bucket names are truncated hashes; no IP is stored.
    const d1 = await mf.getD1Database('DB');
    const rows = (await d1.prepare("SELECT bucket, count FROM rate_counters WHERE bucket LIKE 'booth-recipe:%'").all()).results;
    assert.ok(rows.every(row => !row.bucket.includes('198.51.100')));
    assert.equal(rows.find(row => row.bucket === 'booth-recipe:all').count, 4);
    // The global rejection gave the third IP its slot back.
    assert.ok(rows.some(row => row.bucket.startsWith('booth-recipe:ip:') && row.count === 0));
  });
});

test('expiry: GET is 404 after 6 hours (injected clock), write cleans expired rows, codes retry on collision', async () => {
  await withApp({}, async (mf, call) => {
    const d1 = await mf.getD1Database('DB');
    const env = { BOOTH_ENABLED: 'true', DB: d1, EVENT_PAGE_URL: EVENT_PAGE };
    const t0 = Date.parse('2026-11-22T06:00:00.000Z');
    const made = await createRecipe(env, recipe(), '192.0.2.1', { now: t0, nextCode: () => 'R-AAAAAA' });
    assert.equal(made.status, 201);
    assert.equal(made.body.code, 'R-AAAAAA');
    assert.equal(made.body.expiresAt, '2026-11-22T12:00:00.000Z');
    assert.equal((await getRecipe(env, 'r-aaaaaa', { now: t0 + RECIPE_TTL_MS - 1 })).status, 200);
    const late = await getRecipe(env, 'R-AAAAAA', { now: t0 + RECIPE_TTL_MS });
    assert.equal(late.status, 404);
    assert.equal(late.body.error.code, 'not_found');

    // Collision: the first candidate is taken, the second lands.
    const codes = ['R-AAAAAA', 'R-BBBBBB'];
    const retry = await createRecipe(env, recipe(), '192.0.2.1', { now: t0 + 1000, nextCode: () => codes.shift() });
    assert.equal(retry.status, 201);
    assert.equal(retry.body.code, 'R-BBBBBB');
    const stuck = await createRecipe(env, recipe(), '192.0.2.1', { now: t0 + 2000, nextCode: () => 'R-AAAAAA' });
    assert.equal(stuck.status, 500);

    // A write after the TTL removes both expired rows before it inserts.
    const fresh = await createRecipe(env, recipe(), '192.0.2.1', { now: t0 + RECIPE_TTL_MS + 5000, nextCode: () => 'R-CCCCCC' });
    assert.equal(fresh.status, 201);
    const left = (await d1.prepare('SELECT code FROM booth_recipes ORDER BY code').all()).results.map(row => row.code);
    assert.deepEqual(left, ['R-CCCCCC']);

    // The HTTP route reads the real clock, so a row whose expiry has passed is 404 there as well.
    const posted = await call('POST', '/v1/booth/recipes', { body: recipe() });
    assert.equal((await call('GET', '/v1/booth/recipes/' + posted.body.code)).status, 200);
    await d1.prepare('UPDATE booth_recipes SET expires_at = ?1 WHERE code = ?2').bind('2000-01-01T00:00:00.000Z', posted.body.code).run();
    assert.equal((await call('GET', '/v1/booth/recipes/' + posted.body.code)).status, 404);
  });
});

const missionFor = (id, paperId) => ({ id, title: 'Mission ' + id, source: 'arxiv', paperId, license: 'cc-by-4.0', course: 'any', hint: '' });

function setMissions(call, missions) {
  return call('PUT', '/v1/booth/admin/settings', { token: OPERATOR, headers: { Origin: ORIGIN }, body: { missions } });
}

test('mission text: only papers in the bundle AND the live mission list, CORS star, old-style ids', async () => {
  await withApp({}, async (_mf, call) => {
    // In the bundle but no live missions yet: 404.
    assert.equal((await call('GET', '/v1/booth/missions/2309.15217/text')).status, 404);
    assert.equal((await setMissions(call, [missionFor('ragas', '2309.15217'), missionFor('ghost', '2401.00001')])).status, 200);
    const offList = await call('GET', '/v1/booth/missions/hep-th%2F9901001/text');
    assert.equal(offList.status, 404);
    assertStarCors(offList);
    assert.equal((await setMissions(call, [missionFor('ragas', '2309.15217'), missionFor('ghost', '2401.00001'), missionFor('old', 'hep-th/9901001')])).status, 200);
    const hit = await call('GET', '/v1/booth/missions/2309.15217/text', { headers: { Origin: 'https://agent.example' } });
    assert.equal(hit.status, 200, hit.text);
    assertStarCors(hit);
    assert.equal(hit.body.paperId, '2309.15217');
    assert.equal(hit.body.license, 'cc-by-4.0');
    assert.deepEqual(hit.body.pages[1], { page: 5, text: 'Ragas 0.95 0.78 0.70' });
    const old = await call('GET', '/v1/booth/missions/hep-th%2F9901001/text');
    assert.equal(old.status, 200);
    assert.equal(old.body.title, 'Old style fixture');
    assert.equal((await call('GET', '/v1/booth/missions/hep-th/9901001/text')).status, 200);
    const miss = await call('GET', '/v1/booth/missions/2401.00001/text');
    assert.equal(miss.status, 404);
    assertStarCors(miss);
    assert.equal((await call('POST', '/v1/booth/missions/2309.15217/text', { body: {} })).status, 405);
  });
});

test('booth disabled: recipe, mission text and /mcp routes are 404', async () => {
  await withApp({ BOOTH_ENABLED: 'false' }, async (_mf, call) => {
    assert.equal((await call('POST', '/v1/booth/recipes', { body: recipe() })).status, 404);
    assert.equal((await call('GET', '/v1/booth/recipes/R-AAAAAA')).status, 404);
    assert.equal((await call('GET', '/v1/booth/missions/2309.15217/text')).status, 404);
    assert.equal((await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize' } })).status, 404);
  });
  assert.equal((await createRecipe({ BOOTH_ENABLED: 'false' }, recipe(), 'x')).status, 404);
});

test('/mcp: the real MCP server creates a recipe the REST route returns; GET and DELETE are 405', async () => {
  await withApp({}, async (_mf, call) => {
    const rpc = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } } });
    assert.equal(rpc.status, 200, rpc.text);
    assert.equal(rpc.body.jsonrpc, '2.0');
    assert.equal(rpc.body.result.serverInfo.name, 'falsify-booth');
    const listed = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.deepEqual(listed.body.result.tools.map(tool => tool.name).sort(), ['create_recipe', 'get_mission_text', 'list_missions']);
    const created = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_recipe', arguments: { paperId: '2309.15217', edits: [{ page: 5, find: '0.95', replace: '0.50' }], defectType: 'number' } } } });
    assert.equal(created.status, 200, created.text);
    assert.notEqual(created.body.result.isError, true, created.text);
    const code = created.body.result.structuredContent.code;
    assert.match(code, /^R-[0-9A-HJKMNP-TV-Z]{6}$/);
    const fetched = await call('GET', '/v1/booth/recipes/' + code.toLowerCase());
    assert.equal(fetched.status, 200, fetched.text);
    assert.equal(fetched.body.source, 'agent');
    assert.equal(fetched.body.edits[0].replace, '0.50');
    for (const method of ['GET', 'DELETE']) {
      const res = await call(method, '/mcp');
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'POST');
    }
  });
});

test('/mcp passes createRecipe, missionsList and missionText to handleAgentMcp', async () => {
  await withApp({}, async (mf, call) => {
    const mission = { id: 'ragas', title: 'Ragas', source: 'arxiv', paperId: '2309.15217', license: 'cc-by-4.0', course: 'any', hint: '표 수치' };
    const saved = await call('PUT', '/v1/booth/admin/settings', { token: OPERATOR, headers: { Origin: ORIGIN }, body: { missions: [mission] } });
    assert.equal(saved.status, 200, saved.text);
    const probe = await call('POST', '/mcp', { body: { recipe: recipe(), paperId: '2309.15217' } });
    assert.equal(probe.status, 200, probe.text);
    assert.deepEqual(probe.body.keys, ['createRecipe', 'missionText', 'missionsList']);
    assert.equal(probe.body.created.status, 201);
    assert.match(probe.body.created.body.code, CODE_RE);
    assert.deepEqual(probe.body.missions, [mission]);
    assert.equal(probe.body.text.paperId, '2309.15217');
    assert.equal(probe.body.offList, null);
    const config = await call('GET', '/v1/booth/config', { headers: { Origin: ORIGIN } });
    assert.deepEqual(probe.body.missions, config.body.missions);
    const d1 = await mf.getD1Database('DB');
    assert.deepEqual(await missionsList({ BOOTH_ENABLED: 'true', DB: d1 }), [mission]);
  }, { probe: true });
});

function multipart(meta, pdf) {
  return Buffer.concat([
    Buffer.from('--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'
      + JSON.stringify(meta) + '\r\n--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="pdf"; filename="edited.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),
    pdf,
    Buffer.from('\r\n--' + BOUNDARY + '--\r\n'),
  ]);
}

function submit(call, token, label, extra = {}) {
  const pdf = Buffer.from('%PDF-1.7 synthetic ' + label);
  const meta = {
    course: 'quick',
    declared: [{ pageIndex: 4, before: '0.95', after: '0.50', defectType: 'number', reason: '수치를 낮춤' }],
    paper: { source: 'arxiv', id: '2309.15217', title: 'Synthetic', license: 'cc-by-4.0', sourceSha256: SOURCE_HASH },
    consentVersion: CONSENT,
    editedSha256: createHash('sha256').update(pdf).digest('hex'),
    ...extra,
  };
  return call('POST', '/v1/booth/submissions', {
    token,
    raw: multipart(meta, pdf),
    headers: { Origin: ORIGIN, 'Content-Type': 'multipart/form-data; boundary=' + BOUNDARY },
  });
}

test('submissions store assist and recipeCode and the operator views return them', async () => {
  await withApp({}, async (_mf, call) => {
    const guest = (await call('POST', '/v1/ai/guest', { body: {}, headers: { Origin: ORIGIN } })).body.guest.token;
    const manual = await submit(call, guest, 'manual');
    assert.equal(manual.status, 201, manual.text);
    assert.equal(Object.hasOwn(manual.body, 'assist'), false);
    assert.equal((await submit(call, guest, 'myai', { assist: 'my-ai' })).status, 201);
    const agent = await submit(call, guest, 'agent', { assist: 'agent', recipeCode: 'r-7k3qxm' });
    assert.equal(agent.status, 201, agent.text);
    assert.equal((await submit(call, guest, 'agent-nocode', { assist: 'agent' })).status, 201);

    for (const [label, extra] of [
      ['bad-assist', { assist: 'robot' }],
      ['code-without-agent', { assist: 'my-ai', recipeCode: 'R-7K3QXM' }],
      ['code-default-assist', { recipeCode: 'R-7K3QXM' }],
      ['bad-code', { assist: 'agent', recipeCode: 'R-7K3QX' }],
      ['code-type', { assist: 'agent', recipeCode: 7 }],
    ]) {
      const res = await submit(call, guest, label, extra);
      assert.equal(res.status, 400, label);
      assert.equal(res.body.error.code, 'invalid_request', label);
    }

    const list = await call('GET', '/v1/booth/admin/submissions', { token: OPERATOR, headers: { Origin: ORIGIN } });
    assert.equal(list.status, 200, list.text);
    const seen = list.body.submissions.map(row => [row.assist, row.recipeCode]);
    assert.deepEqual(seen, [['manual', null], ['my-ai', null], ['agent', 'R-7K3QXM'], ['agent', null]]);
    const one = await call('GET', '/v1/booth/admin/submissions/' + agent.body.receipt, { token: OPERATOR, headers: { Origin: ORIGIN } });
    assert.equal(one.body.assist, 'agent');
    assert.equal(one.body.recipeCode, 'R-7K3QXM');
    const claim = await call('POST', '/v1/booth/claim', { headers: { Origin: ORIGIN }, body: { receipt: agent.body.receipt, claimKey: agent.body.claimKey } });
    assert.equal(claim.status, 200);
    assert.equal(Object.hasOwn(claim.body, 'assist'), false);
  });
});

test('migration 0007 and the event vars', () => {
  const sql = readFileSync(path.join(apiRoot, 'migrations', '0007_booth_recipes.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE booth_recipes/);
  assert.match(sql, /ALTER TABLE booth_submissions ADD COLUMN assist TEXT/);
  assert.match(sql, /ALTER TABLE booth_submissions ADD COLUMN recipe_code TEXT;/);
  const wrangler = readFileSync(path.join(apiRoot, 'wrangler.jsonc'), 'utf8');
  assert.match(wrangler, /"BOOTH_RECIPES_PER_IP_HOUR": "120"/);
  assert.match(wrangler, /"BOOTH_RECIPES_PER_HOUR": "5000"/);
  assert.match(wrangler, /"EVENT_PAGE_URL": "https:\/\/shinick-han\.github\.io\/falsify-workbench\/event\.html"/);
});
