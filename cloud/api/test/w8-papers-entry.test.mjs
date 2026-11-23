// Offline tests for the isolated W8 public paper API wrapper (falsify-w8-papers).
// Verifies strict route allowlisting, CORS isolation, guest minting, paper-links auth/hash checks,
// and fail-closed rejection of /v1/ai/jobs, admin, booth, team, and legacy record routes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';
import worker, { isW8PapersPublicPath } from '../src/w8-papers-entry.js';
import { setW8PaperLinksFetchForTests } from '../src/w8-paper-links.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '..');

const ORIGIN = 'https://shinick-han.github.io';
const FOREIGN_ORIGIN = 'https://evil.example';
const STORE_BASE = 'https://falsify-runtime.shinick.dev/w8-archive';
const STORE_TOKEN = 'synthetic-store-token-for-w8-papers-entry-test-0123456789';
const SESSION_KEY = Buffer.alloc(32, 9).toString('base64');
const SAMPLE_PDF = new Uint8Array(Buffer.from('%PDF-1.7\n% synthetic w8 papers test\n%%EOF\n', 'utf8'));
const SAMPLE_SHA = createHash('sha256').update(SAMPLE_PDF).digest('hex');
const WRONG_SHA = '0'.repeat(64);
const MISSING_LINK_TOKEN = 'a'.repeat(32);

function createTestDb() {
  const guests = new Map();
  const counters = new Map();
  return {
    guests,
    counters,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('FROM guest_sessions')) {
                const [tokenHash, nowMs] = args;
                const row = guests.get(tokenHash);
                if (!row || row.revoked_at !== null || row.expires_at <= nowMs) return null;
                return { guest_id: row.guest_id };
              }
              if (sql.includes('INSERT INTO rate_counters')) {
                const [bucket, windowStart] = args;
                const key = `${bucket}|${windowStart}`;
                const next = (counters.get(key) || 0) + 1;
                counters.set(key, next);
                return { count: next };
              }
              throw new Error(`Unexpected first() SQL: ${sql}`);
            },
            async run() {
              if (sql.includes('INSERT INTO guest_sessions')) {
                const [tokenHash, guestId, createdAt, expiresAt] = args;
                guests.set(tokenHash, { guest_id: guestId, created_at: createdAt, expires_at: expiresAt, revoked_at: null });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM rate_counters')) {
                const [windowStart] = args;
                for (const key of [...counters.keys()]) {
                  if (Number(key.split('|')[1]) < windowStart) counters.delete(key);
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes('UPDATE rate_counters SET count = count - 1')) {
                const [bucket, windowStart] = args;
                const key = `${bucket}|${windowStart}`;
                const cur = counters.get(key) || 0;
                if (cur > 0) counters.set(key, cur - 1);
                return { meta: { changes: cur > 0 ? 1 : 0 } };
              }
              throw new Error(`Unexpected run() SQL: ${sql}`);
            },
          };
        },
      };
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    DB: createTestDb(),
    ALLOWED_ORIGINS: ORIGIN,
    CONFLUENCE_ONLY: 'true',
    AI_HOSTING_ENABLED: 'true',
    AI_OPEN_ACCESS: 'true',
    AI_PAPER_TOOLS_ENABLED: 'false',
    AI_GUEST_BLUE: 'false',
    AI_GUEST_MODEL_JOBS: 'false',
    AI_MODEL_JOBS_OPERATOR_ONLY: 'true',
    PAPER_SEARCH_ENABLED: 'true',
    CONFLUENCE_SESSION_KEY: SESSION_KEY,
    W8_PDF_STORE_BASE: STORE_BASE,
    W8_PDF_STORE_TOKEN: STORE_TOKEN,
    ...overrides,
  };
}

afterEach(() => {
  setW8PaperLinksFetchForTests(null);
});

describe('w8-papers-entry route allowlist', () => {
  test('allows only the four public W8 paper API route patterns', () => {
    assert.equal(isW8PapersPublicPath('/v1/ai/guest'), true);
    assert.equal(isW8PapersPublicPath('/v1/papers/search'), true);
    assert.equal(isW8PapersPublicPath('/v1/papers/pdf'), true);
    assert.equal(isW8PapersPublicPath(`/v1/w8/paper-links/${SAMPLE_SHA}`), true);
    assert.equal(isW8PapersPublicPath(`/v1/w8/paper-links/${MISSING_LINK_TOKEN}.pdf`), true);
    assert.equal(isW8PapersPublicPath('/v1/w8/paper-links/malformed-id'), true);

    for (const blocked of [
      '/',
      '/v1/health',
      '/v1/me',
      '/v1/records',
      '/v1/auth/login',
      '/v1/auth/register',
      '/v1/ai/capabilities',
      '/v1/ai/uploads',
      '/v1/ai/jobs',
      '/v1/ai/jobs/11111111-1111-4111-8111-111111111111',
      '/v1/ai/paper',
      '/v1/papers/unknown',
      '/v1/w8/paper-links',
      '/v1/w8/paper-links/',
      `/v1/w8/paper-links/${SAMPLE_SHA}/extra`,
      '/v1/w8/team/papers',
      '/v1/confluence/auth/start',
      '/v1/booth/submissions',
      '/v1/booth/recipes',
      '/mcp',
      '/admin',
    ]) {
      assert.equal(isW8PapersPublicPath(blocked), false, `expected blocked: ${blocked}`);
    }
  });

  test('blocks /v1/ai/jobs, admin, and unrelated routes with 404 without CORS allow', async () => {
    const env = makeEnv();
    for (const [method, pathname] of [
      ['POST', '/v1/ai/jobs'],
      ['GET', '/v1/ai/jobs'],
      ['OPTIONS', '/v1/ai/jobs'],
      ['GET', '/v1/ai/capabilities'],
      ['POST', '/v1/ai/uploads'],
      ['POST', '/v1/ai/paper'],
      ['GET', '/v1/health'],
      ['GET', '/v1/records'],
      ['GET', '/v1/booth/submissions'],
      ['POST', '/mcp'],
      ['GET', '/admin'],
    ]) {
      const res = await worker.fetch(
        new Request(`https://falsify-w8-papers.ai-gongbu.workers.dev${pathname}`, {
          method,
          headers: { Origin: ORIGIN },
        }),
        env,
      );
      assert.equal(res.status, 404, `${method} ${pathname} should be 404`);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
      const body = await res.json();
      assert.equal(body.error.code, 'not_found');
    }
  });
});

describe('w8-papers-entry delegated handlers and CORS', () => {
  test('mints guest session for allowed origin and rejects foreign origin', async () => {
    const env = makeEnv();

    const badOrigin = await worker.fetch(
      new Request('https://falsify-w8-papers.ai-gongbu.workers.dev/v1/ai/guest', {
        method: 'POST',
        headers: { Origin: FOREIGN_ORIGIN, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.headers.get('Access-Control-Allow-Origin'), null);

    const opt = await worker.fetch(
      new Request('https://falsify-w8-papers.ai-gongbu.workers.dev/v1/ai/guest', {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
      }),
      env,
    );
    assert.equal(opt.status, 204);
    assert.equal(opt.headers.get('Access-Control-Allow-Origin'), ORIGIN);

    const res = await worker.fetch(
      new Request('https://falsify-w8-papers.ai-gongbu.workers.dev/v1/ai/guest', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    const data = await res.json();
    assert.match(data.guest.token, /^fsg_[A-Za-z0-9_-]{43}$/);
  });

  test('enforces auth, hash mismatch, malformed id, missing file, and non-wildcard write CORS on paper-links', async () => {
    const env = makeEnv();
    const storeCalls = [];
    setW8PaperLinksFetchForTests(async (url, init) => {
      storeCalls.push({ url, method: init?.method });
      return new Response(null, { status: 404 });
    });

    // Mint guest token
    const guestRes = await worker.fetch(
      new Request('https://falsify-w8-papers.ai-gongbu.workers.dev/v1/ai/guest', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    const { guest } = await guestRes.json();

    // Write OPTIONS allows exact app origin, never wildcard; rejects foreign origin
    const okOpt = await worker.fetch(
      new Request(`https://falsify-w8-papers.ai-gongbu.workers.dev/v1/w8/paper-links/${SAMPLE_SHA}`, {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT' },
      }),
      env,
    );
    assert.equal(okOpt.status, 204);
    assert.equal(okOpt.headers.get('Access-Control-Allow-Origin'), ORIGIN);

    const badOpt = await worker.fetch(
      new Request(`https://falsify-w8-papers.ai-gongbu.workers.dev/v1/w8/paper-links/${SAMPLE_SHA}`, {
        method: 'OPTIONS',
        headers: { Origin: FOREIGN_ORIGIN, 'Access-Control-Request-Method': 'PUT' },
      }),
      env,
    );
    assert.equal(badOpt.status, 403);
    assert.equal(badOpt.headers.get('Access-Control-Allow-Origin'), null);

    // Malformed hash id returns 404 without calling store
    const malformed = await worker.fetch(
      new Request('https://falsify-w8-papers.ai-gongbu.workers.dev/v1/w8/paper-links/not-a-sha', {
        method: 'PUT',
        headers: {
          Origin: ORIGIN,
          Authorization: `Bearer ${guest.token}`,
          'Content-Type': 'application/pdf',
        },
        body: SAMPLE_PDF,
      }),
      env,
    );
    assert.equal(malformed.status, 404);
    assert.equal(storeCalls.length, 0);

    // Authenticated PUT with mismatched SHA-256 fails closed with 400 pdf_mismatch before store call
    const mismatch = await worker.fetch(
      new Request(`https://falsify-w8-papers.ai-gongbu.workers.dev/v1/w8/paper-links/${WRONG_SHA}`, {
        method: 'PUT',
        headers: {
          Origin: ORIGIN,
          Authorization: `Bearer ${guest.token}`,
          'Content-Type': 'application/pdf',
        },
        body: SAMPLE_PDF,
      }),
      env,
    );
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal((await mismatch.json()).error.code, 'pdf_mismatch');
    assert.equal(storeCalls.length, 0);

    // Unknown bearer token returns 401 unauthorized (because random CONFLUENCE_SESSION_KEY is configured)
    const badBearer = await worker.fetch(
      new Request(`https://falsify-w8-papers.ai-gongbu.workers.dev/v1/w8/paper-links/${SAMPLE_SHA}`, {
        method: 'PUT',
        headers: {
          Origin: ORIGIN,
          Authorization: 'Bearer invalid-non-prefix-token',
          'Content-Type': 'application/pdf',
        },
        body: SAMPLE_PDF,
      }),
      env,
    );
    assert.equal(badBearer.status, 401);
    assert.equal((await badBearer.json()).error.code, 'unauthorized');

    // Missing PDF link returns 404 with public read CORS
    const missing = await worker.fetch(
      new Request(`https://falsify-w8-papers.ai-gongbu.workers.dev/v1/w8/paper-links/${MISSING_LINK_TOKEN}.pdf`, {
        method: 'GET',
        headers: { Origin: FOREIGN_ORIGIN },
      }),
      env,
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(storeCalls.length, 1);
  });

  test('wrangler.w8-papers.jsonc stays isolated and free of secrets', () => {
    const raw = readFileSync(path.join(apiRoot, 'wrangler.w8-papers.jsonc'), 'utf8');
    assert.match(raw, /"name"\s*:\s*"falsify-w8-papers"/);
    assert.match(raw, /"main"\s*:\s*"src\/w8-papers-entry\.js"/);
    assert.match(raw, /"ALLOWED_ORIGINS"\s*:\s*"https:\/\/shinick-han\.github\.io"/);
    assert.match(raw, /"W8_PDF_STORE_BASE"\s*:\s*"https:\/\/falsify-runtime\.shinick\.dev\/w8-archive"/);
    assert.equal(/"W8_PDF_STORE_TOKEN"\s*:/.test(raw), false);
    assert.equal(/"CONFLUENCE_SESSION_KEY"\s*:/.test(raw), false);
    assert.equal(/"AI_OPEN_ACCESS_KEY"\s*:/.test(raw), false);
    assert.equal(/"HOSTED_AI_SERVICE_TOKEN"\s*:/.test(raw), false);
    assert.equal(/"AI_RUNTIME_URL"\s*:/.test(raw), false);
  });
});
