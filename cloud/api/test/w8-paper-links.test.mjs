// Offline tests for W8 temporary PDF link routes (/v1/w8/paper-links/*).
// Exercises full Worker routing, CORS, guest auth via resolveAiOwner, rate caps, 32 MiB PDF bounds,
// public GET/HEAD proxying with neutral inline headers, owner-checked DELETE, errors, and log hygiene.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import worker from '../src/index.js';
import {
  handleW8PaperLinks,
  matchW8PaperLinks,
  setW8PaperLinksFetchForTests,
  w8PaperLinksConfigured,
} from '../src/w8-paper-links.mjs';

const ORIGIN = 'https://shinick-han.github.io';
const OTHER_ORIGIN = 'https://external-ai.example';
const STORE_BASE = 'https://pdf-store.internal.example/w8';
const STORE_TOKEN = 'store-secret-token-for-w8-paper-links-0123456789';
const GUEST_ID_A = '11111111-1111-4111-8111-111111111111';
const GUEST_ID_B = '22222222-2222-4222-8222-222222222222';
const GUEST_TOKEN_A = 'fsg_' + 'A'.repeat(43);
const GUEST_TOKEN_B = 'fsg_' + 'B'.repeat(43);
const REVOKED_TOKEN = 'fsg_' + 'R'.repeat(43);
const EXPIRED_TOKEN = 'fsg_' + 'E'.repeat(43);
const LINK_TOKEN = '0123456789abcdef0123456789abcdef';
const EXPIRES_AT = '2026-11-24T05:00:00.000Z';

const SAMPLE_PDF = new Uint8Array(Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'utf8'));
const SAMPLE_SHA = sha256(SAMPLE_PDF);
const ALT_PDF = new Uint8Array(Buffer.from('%PDF-1.7\n% second synthetic pdf\n%%EOF\n', 'utf8'));
const ALT_SHA = sha256(ALT_PDF);

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function createTestDb() {
  const guests = new Map();
  const counters = new Map();
  const addGuest = (token, guestId, { expiresAt = Date.now() + 3600_000, revokedAt = null } = {}) => {
    guests.set(sha256(token), { guest_id: guestId, expires_at: expiresAt, revoked_at: revokedAt });
  };
  addGuest(GUEST_TOKEN_A, GUEST_ID_A);
  addGuest(GUEST_TOKEN_B, GUEST_ID_B);
  addGuest(REVOKED_TOKEN, GUEST_ID_A, { revokedAt: new Date().toISOString() });
  addGuest(EXPIRED_TOKEN, GUEST_ID_A, { expiresAt: Date.now() - 10_000 });

  const db = {
    addGuest,
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
              if (sql.includes('DELETE FROM rate_counters')) {
                const [windowStart] = args;
                for (const key of [...counters.keys()]) {
                  const ws = Number(key.split('|')[1]);
                  if (ws < windowStart) counters.delete(key);
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
  return db;
}

function makeEnv(overrides = {}) {
  return {
    DB: createTestDb(),
    ALLOWED_ORIGINS: ORIGIN,
    AI_OPEN_ACCESS: 'true',
    CONFLUENCE_SESSION_KEY: Buffer.alloc(32, 7).toString('base64'),
    W8_PDF_STORE_BASE: STORE_BASE,
    W8_PDF_STORE_TOKEN: STORE_TOKEN,
    ...overrides,
  };
}

function makeStoreStub() {
  const calls = [];
  const links = new Map();
  const fn = async (url, init = {}) => {
    const method = init.method || 'GET';
    const headers = new Headers(init.headers || {});
    const body = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : null;
    calls.push({ url: String(url), method, headers, body, redirect: init.redirect });

    if (headers.get('X-Falsify-Store-Token') !== STORE_TOKEN) {
      return new Response(JSON.stringify({ error: 'bad store token' }), { status: 401 });
    }
    const parsed = new URL(url);
    const objMatch = /^\/w8\/objects\/([0-9a-f]{64})$/.exec(parsed.pathname);
    if (method === 'PUT' && objMatch) {
      const owner = headers.get('X-Falsify-Owner');
      assert.ok(owner, 'PUT must include X-Falsify-Owner');
      const token = LINK_TOKEN;
      links.set(token, { sha256: objMatch[1], owner, bytes: body, expiresAt: EXPIRES_AT });
      return new Response(JSON.stringify({
        token,
        sha256: objMatch[1],
        expiresAt: EXPIRES_AT,
        internalSecretField: 'must-be-dropped',
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'DELETE' && objMatch) {
      const owner = headers.get('X-Falsify-Owner');
      const found = [...links.entries()].find(([, entry]) => entry.sha256 === objMatch[1]);
      if (!found) return new Response(JSON.stringify({ error: 'missing' }), { status: 404 });
      if (found[1].owner !== owner) return new Response(JSON.stringify({ error: 'owner_mismatch' }), { status: 403 });
      links.delete(found[0]);
      return new Response(null, { status: 204 });
    }
    const linkMatch = /^\/w8\/links\/([0-9a-f]{32})\.pdf$/.exec(parsed.pathname);
    if (linkMatch) {
      const entry = links.get(linkMatch[1]);
      if (!entry) return new Response(JSON.stringify({ error: 'missing' }), { status: 404 });
      if (method === 'GET' || method === 'HEAD') {
        return new Response(method === 'HEAD' ? null : entry.bytes, {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Length': String(entry.bytes.byteLength),
            'Content-Disposition': 'attachment; filename="edited-red-clue-secret.pdf"',
            'X-Falsify-Edit-Clue': 'should-never-leak',
            'X-Falsify-Owner': entry.owner,
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }
      if (method === 'DELETE') {
        const owner = headers.get('X-Falsify-Owner');
        if (owner !== entry.owner) {
          return new Response(JSON.stringify({ error: 'owner_mismatch' }), { status: 403 });
        }
        links.delete(linkMatch[1]);
        return new Response(null, { status: 204 });
      }
    }
    return new Response('unexpected', { status: 404 });
  };
  return { fn, calls, links };
}

function pdfReq(path, { method = 'PUT', origin = ORIGIN, token = GUEST_TOKEN_A, body = SAMPLE_PDF, headers = {} } = {}) {
  const reqHeaders = new Headers(headers);
  if (origin !== null) reqHeaders.set('Origin', origin);
  if (token !== null) reqHeaders.set('Authorization', `Bearer ${token}`);
  if (method === 'PUT' && !reqHeaders.has('Content-Type')) reqHeaders.set('Content-Type', 'application/pdf');
  return new Request(`https://api.example${path}`, {
    method,
    headers: reqHeaders,
    body: method === 'PUT' ? body : undefined,
  });
}

afterEach(() => {
  setW8PaperLinksFetchForTests(null);
});

describe('W8 paper-links configuration and route matching', () => {
  test('disabled (404) when W8_PDF_STORE_BASE or W8_PDF_STORE_TOKEN is missing or invalid', async () => {
    const store = makeStoreStub();
    setW8PaperLinksFetchForTests(store.fn);

    const badEnvs = [
      makeEnv({ W8_PDF_STORE_BASE: '' }),
      makeEnv({ W8_PDF_STORE_TOKEN: '' }),
      makeEnv({ W8_PDF_STORE_BASE: 'http://remote.example/store' }),
      makeEnv({ W8_PDF_STORE_BASE: 'https://user:pass@store.example/w8' }),
      makeEnv({ W8_PDF_STORE_BASE: 'https://store.example/w8?x=1' }),
      makeEnv({ W8_PDF_STORE_TOKEN: 'bad\ntoken' }),
    ];

    for (const env of badEnvs) {
      assert.equal(w8PaperLinksConfigured(env), false);
      const putRes = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`), env);
      assert.equal(putRes.status, 404);
      const getRes = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`), env);
      assert.equal(getRes.status, 404);
      const headRes = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`, { method: 'HEAD' }), env);
      assert.equal(headRes.status, 404);
      assert.equal(await headRes.text(), '');
      const delRes = await worker.fetch(pdfReq(`/v1/w8/paper-links/${LINK_TOKEN}.pdf`, { method: 'DELETE' }), env);
      assert.equal(delRes.status, 404);
      const optRes = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, { method: 'OPTIONS', token: null }), env);
      assert.equal(optRes.status, 404);
    }
    assert.equal(store.calls.length, 0);
  });

  test('loopback http store base is allowed; invalid path shapes return 404 without hitting w8-team', async () => {
    assert.equal(w8PaperLinksConfigured(makeEnv({ W8_PDF_STORE_BASE: 'http://127.0.0.1:8790' })), true);
    assert.equal(w8PaperLinksConfigured(makeEnv({ W8_PDF_STORE_BASE: 'http://localhost:8790/store' })), true);
    assert.equal(matchW8PaperLinks('/v1/w8/capabilities'), null);
    assert.equal(matchW8PaperLinks(`/v1/w8/paper-links/${SAMPLE_SHA}`).template, '/v1/w8/paper-links/:sha256');
    assert.equal(matchW8PaperLinks(`/v1/w8/paper-links/${LINK_TOKEN}.pdf`).template, '/v1/w8/paper-links/:token.pdf');
    assert.equal(matchW8PaperLinks('/v1/w8/paper-links/UPPERCASE.pdf').template, '/v1/w8/paper-links/unknown');

    const env = makeEnv();
    for (const badPath of [
      '/v1/w8/paper-links',
      '/v1/w8/paper-links/not-a-sha',
      `/v1/w8/paper-links/${SAMPLE_SHA.toUpperCase()}`,
      `/v1/w8/paper-links/${LINK_TOKEN}`,
      `/v1/w8/paper-links/${LINK_TOKEN.toUpperCase()}.pdf`,
      `/v1/w8/paper-links/${LINK_TOKEN}.txt`,
    ]) {
      const res = await worker.fetch(pdfReq(badPath, { method: 'GET', token: null }), env);
      assert.equal(res.status, 404);
    }
  });
});

describe('W8 paper-links PUT, GET, HEAD, DELETE happy path and security', () => {
  test('PUT uploads PDF with real auth owner, public GET/HEAD read exact bytes with neutral headers, owner DELETE removes it', async () => {
    const store = makeStoreStub();
    setW8PaperLinksFetchForTests(store.fn);
    const env = makeEnv();

    // Client attempts to spoof X-Falsify-Owner, X-Falsify-Store-Token, and send an edit-clue filename.
    const putRes = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, {
      headers: {
        'X-Falsify-Owner': 'gst:99999999-9999-4999-8999-999999999999',
        'X-Falsify-Store-Token': 'spoofed-token',
        'X-Falsify-File-Name': 'edited_paper_with_red_defect.pdf',
      },
    }), env);
    assert.equal(putRes.status, 201);
    assert.equal(putRes.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.match(putRes.headers.get('Vary') || '', /Origin/);
    assert.equal(putRes.headers.get('Cache-Control'), 'no-store');
    const created = await putRes.json();
    assert.deepEqual(created, { token: LINK_TOKEN, sha256: SAMPLE_SHA, expiresAt: EXPIRES_AT });

    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0].method, 'PUT');
    assert.equal(store.calls[0].url, `${STORE_BASE}/objects/${SAMPLE_SHA}`);
    assert.equal(store.calls[0].headers.get('X-Falsify-Store-Token'), STORE_TOKEN);
    assert.equal(store.calls[0].headers.get('X-Falsify-Owner'), `gst:${GUEST_ID_A}`);
    assert.equal(store.calls[0].headers.get('Authorization'), null);
    assert.equal(store.calls[0].headers.get('X-Falsify-File-Name'), null);
    assert.equal(store.calls[0].redirect, 'manual');
    assert.deepEqual(store.calls[0].body, SAMPLE_PDF);

    // Public unauthenticated GET from an arbitrary third-party Origin succeeds with CORS "*".
    const getRes = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`, {
      method: 'GET',
      headers: { Origin: OTHER_ORIGIN, Authorization: 'Bearer should-not-forward' },
    }), env);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(getRes.headers.get('Access-Control-Allow-Credentials'), null);
    assert.equal(getRes.headers.get('Content-Type'), 'application/pdf');
    assert.equal(getRes.headers.get('Content-Disposition'), 'inline; filename="paper.pdf"');
    assert.equal(getRes.headers.get('Cache-Control'), 'no-store');
    assert.match(getRes.headers.get('X-Robots-Tag') || '', /\bnoindex\b/);
    assert.equal(getRes.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(getRes.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(getRes.headers.get('Content-Length'), String(SAMPLE_PDF.byteLength));
    // Must not leak upstream edit clues, owner, or session headers.
    assert.equal(getRes.headers.get('X-Falsify-Edit-Clue'), null);
    assert.equal(getRes.headers.get('X-Falsify-Owner'), null);
    assert.equal(getRes.headers.get('X-Falsify-Session'), null);
    const downloaded = new Uint8Array(await getRes.arrayBuffer());
    assert.deepEqual(downloaded, SAMPLE_PDF);

    assert.equal(store.calls[1].method, 'GET');
    assert.equal(store.calls[1].url, `${STORE_BASE}/links/${LINK_TOKEN}.pdf`);
    assert.equal(store.calls[1].headers.get('X-Falsify-Store-Token'), STORE_TOKEN);
    assert.equal(store.calls[1].headers.get('X-Falsify-Owner'), null);
    assert.equal(store.calls[1].headers.get('Authorization'), null);

    // Public unauthenticated HEAD without Origin returns exact headers and empty body.
    const headRes = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`, {
      method: 'HEAD',
    }), env);
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(headRes.headers.get('Content-Type'), 'application/pdf');
    assert.equal(headRes.headers.get('Content-Disposition'), 'inline; filename="paper.pdf"');
    assert.equal(headRes.headers.get('Cache-Control'), 'no-store');
    assert.match(headRes.headers.get('X-Robots-Tag') || '', /\bnoindex\b/);
    assert.equal(headRes.headers.get('Content-Length'), String(SAMPLE_PDF.byteLength));
    assert.equal(headRes.headers.get('X-Falsify-Edit-Clue'), null);
    assert.equal((await headRes.arrayBuffer()).byteLength, 0);

    // Another guest cannot delete Guest A's link even if they forge X-Falsify-Owner.
    const wrongOwnerDel = await worker.fetch(pdfReq(`/v1/w8/paper-links/${LINK_TOKEN}.pdf`, {
      method: 'DELETE',
      token: GUEST_TOKEN_B,
      headers: { 'X-Falsify-Owner': `gst:${GUEST_ID_A}` },
    }), env);
    assert.equal(wrongOwnerDel.status, 403);
    assert.equal((await wrongOwnerDel.json()).error.code, 'forbidden');
    assert.equal(store.calls[3].headers.get('X-Falsify-Owner'), `gst:${GUEST_ID_B}`);

    // Matching owner deletes the link; subsequent GET returns 404.
    const delRes = await worker.fetch(pdfReq(`/v1/w8/paper-links/${LINK_TOKEN}.pdf`, {
      method: 'DELETE',
      token: GUEST_TOKEN_A,
    }), env);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.deepEqual(await delRes.json(), { deleted: true });
    assert.equal(store.calls[4].method, 'DELETE');
    assert.equal(store.calls[4].url, `${STORE_BASE}/links/${LINK_TOKEN}.pdf`);
    assert.equal(store.calls[4].headers.get('X-Falsify-Owner'), `gst:${GUEST_ID_A}`);

    const afterGet = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`), env);
    assert.equal(afterGet.status, 404);

    // Also supports DELETE /v1/w8/paper-links/{sha256} (matching client revoke-by-sha).
    const putAgain = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`), env);
    assert.equal(putAgain.status, 201);
    const wrongShaDel = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, {
      method: 'DELETE',
      token: GUEST_TOKEN_B,
    }), env);
    assert.equal(wrongShaDel.status, 403);
    const okShaDel = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, {
      method: 'DELETE',
      token: GUEST_TOKEN_A,
    }), env);
    assert.equal(okShaDel.status, 200);
    assert.deepEqual(await okShaDel.json(), { deleted: true });
    assert.equal(store.calls.at(-1).url, `${STORE_BASE}/objects/${SAMPLE_SHA}`);
    assert.equal(store.calls.at(-1).headers.get('X-Falsify-Owner'), `gst:${GUEST_ID_A}`);
  });
});

describe('W8 paper-links unauthorized writes and CORS boundaries', () => {
  test('PUT and DELETE reject missing, invalid, revoked, expired tokens and disabled open access', async () => {
    const store = makeStoreStub();
    setW8PaperLinksFetchForTests(store.fn);
    const env = makeEnv();

    for (const token of [null, 'bad', 'fsi_' + 'X'.repeat(43), REVOKED_TOKEN, EXPIRED_TOKEN]) {
      const putRes = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, { token }), env);
      assert.equal(putRes.status, 401);
      const delRes = await worker.fetch(pdfReq(`/v1/w8/paper-links/${LINK_TOKEN}.pdf`, { method: 'DELETE', token }), env);
      assert.equal(delRes.status, 401);
      const delShaRes = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, { method: 'DELETE', token }), env);
      assert.equal(delShaRes.status, 401);
    }

    // Without CONFLUENCE_SESSION_KEY, unknown non-prefix tokens fail closed with 503 (never 500).
    const noConfEnv = makeEnv({ CONFLUENCE_SESSION_KEY: '' });
    const unknownNoConf = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, { token: 'unknown-token' }), noConfEnv);
    assert.equal(unknownNoConf.status, 503);
    assert.equal((await unknownNoConf.json()).error.code, 'ai_unavailable');

    const closedEnv = makeEnv({ AI_OPEN_ACCESS: 'false' });
    const putClosed = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`), closedEnv);
    assert.equal(putClosed.status, 403);
    assert.equal((await putClosed.json()).error.code, 'open_access_disabled');
    const delClosed = await worker.fetch(pdfReq(`/v1/w8/paper-links/${LINK_TOKEN}.pdf`, { method: 'DELETE' }), closedEnv);
    assert.equal(delClosed.status, 403);
    assert.equal((await delClosed.json()).error.code, 'open_access_disabled');
    assert.equal(store.calls.length, 0);
  });

  test('CORS allows anonymous read preflight and rejects unallowed origins on write preflight and writes', async () => {
    const store = makeStoreStub();
    setW8PaperLinksFetchForTests(store.fn);
    const env = makeEnv();

    // Unallowed origin PUT and DELETE are rejected with 403 origin_not_allowed.
    const badPut = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, { origin: OTHER_ORIGIN }), env);
    assert.equal(badPut.status, 403);
    assert.equal(badPut.headers.get('Access-Control-Allow-Origin'), null);

    const badDel = await worker.fetch(pdfReq(`/v1/w8/paper-links/${LINK_TOKEN}.pdf`, { method: 'DELETE', origin: OTHER_ORIGIN }), env);
    assert.equal(badDel.status, 403);
    assert.equal(badDel.headers.get('Access-Control-Allow-Origin'), null);

    const badDelPre = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`, {
      method: 'OPTIONS',
      headers: { Origin: OTHER_ORIGIN, 'Access-Control-Request-Method': 'DELETE' },
    }), env);
    assert.equal(badDelPre.status, 403);
    assert.equal(badDelPre.headers.get('Access-Control-Allow-Origin'), null);

    const badPutPre = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${SAMPLE_SHA}`, {
      method: 'OPTIONS',
      headers: { Origin: OTHER_ORIGIN, 'Access-Control-Request-Method': 'PUT' },
    }), env);
    assert.equal(badPutPre.status, 403);

    // Anonymous read preflight from any origin gets CORS "*" and GET/HEAD only.
    const pubReadPre = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`, {
      method: 'OPTIONS',
      headers: { Origin: OTHER_ORIGIN, 'Access-Control-Request-Method': 'GET' },
    }), env);
    assert.equal(pubReadPre.status, 204);
    assert.equal(pubReadPre.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(pubReadPre.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
    assert.equal(pubReadPre.headers.get('Access-Control-Allow-Headers'), null);

    // Allowed origin DELETE preflight echoes Origin and allows Authorization + DELETE.
    const okDelPre = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'DELETE' },
    }), env);
    assert.equal(okDelPre.status, 204);
    assert.equal(okDelPre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.match(okDelPre.headers.get('Access-Control-Allow-Methods') || '', /DELETE/);
    assert.match(okDelPre.headers.get('Access-Control-Allow-Headers') || '', /authorization/);

    // Allowed origin PUT/DELETE preflight echoes Origin and allows PUT and DELETE.
    const okPutPre = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${SAMPLE_SHA}`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT' },
    }), env);
    assert.equal(okPutPre.status, 204);
    assert.equal(okPutPre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(okPutPre.headers.get('Access-Control-Allow-Methods'), 'PUT, DELETE, OPTIONS');
    assert.equal(store.calls.length, 0);
  });
});

describe('W8 paper-links limits, validation, and upstream error handling', () => {
  test('enforces media type, PDF magic, SHA-256 match, 32 MiB declared and streaming limits, and 405 methods', async () => {
    const store = makeStoreStub();
    setW8PaperLinksFetchForTests(store.fn);
    const env = makeEnv();

    // Unsupported media type
    const badMime = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, {
      headers: { 'Content-Type': 'application/json' },
    }), env);
    assert.equal(badMime.status, 415);

    // Non-PDF bytes
    const notPdf = new Uint8Array(Buffer.from('not a pdf document', 'utf8'));
    const badMagic = await worker.fetch(pdfReq(`/v1/w8/paper-links/${sha256(notPdf)}`, { body: notPdf }), env);
    assert.equal(badMagic.status, 400);
    assert.equal((await badMagic.json()).error.code, 'invalid_pdf');

    // SHA mismatch
    const mismatch = await worker.fetch(pdfReq(`/v1/w8/paper-links/${ALT_SHA}`, { body: SAMPLE_PDF }), env);
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, 'pdf_mismatch');

    // Declared Content-Length over 32 MiB rejected before reading body
    const over32MiB = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, {
      headers: { 'Content-Length': String(32 * 1024 * 1024 + 1) },
    }), env);
    assert.equal(over32MiB.status, 413);
    assert.equal((await over32MiB.json()).error.code, 'payload_too_large');

    // Streaming body exceeding configured cap without Content-Length rejected with 413
    const smallCapEnv = makeEnv({ W8_PDF_LINK_MAX_BYTES: '16' });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(SAMPLE_PDF.subarray(0, 10));
        controller.enqueue(SAMPLE_PDF.subarray(10));
        controller.close();
      },
    });
    const req = new Request(`https://api.example/v1/w8/paper-links/${SAMPLE_SHA}`, {
      method: 'PUT',
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${GUEST_TOKEN_A}`,
        'Content-Type': 'application/pdf',
      },
      body: stream,
      duplex: 'half',
    });
    const overStream = await worker.fetch(req, smallCapEnv);
    assert.equal(overStream.status, 413);

    // Method not allowed
    const badMethodSha = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, { method: 'POST' }), env);
    assert.equal(badMethodSha.status, 405);
    assert.equal(badMethodSha.headers.get('Allow'), 'PUT, DELETE');

    const badMethodLink = await worker.fetch(pdfReq(`/v1/w8/paper-links/${LINK_TOKEN}.pdf`, { method: 'POST' }), env);
    assert.equal(badMethodLink.status, 405);
    assert.equal(badMethodLink.headers.get('Allow'), 'GET, HEAD, DELETE');

    assert.equal(store.calls.length, 0);
  });

  test('enforces per-owner and global guest rate caps and releases slots on store outage', async () => {
    let failStore = false;
    const store = makeStoreStub();
    setW8PaperLinksFetchForTests(async (url, init) => {
      if (failStore) return new Response('internal failure details', { status: 502 });
      return store.fn(url, init);
    });

    const env = makeEnv({
      AI_GUEST_UPLOADS_PER_OWNER_HOUR: '2',
      AI_GUEST_UPLOADS_PER_HOUR: '3',
    });

    // Store outage returns 503 and releases slot so subsequent valid requests still get full quota.
    failStore = true;
    const outageRes = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`), env);
    assert.equal(outageRes.status, 503);
    assert.equal((await outageRes.json()).error.code, 'store_unavailable');
    failStore = false;

    const r1 = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`), env);
    assert.equal(r1.status, 201);
    const r2 = await worker.fetch(pdfReq(`/v1/w8/paper-links/${ALT_SHA}`, { body: ALT_PDF }), env);
    assert.equal(r2.status, 201);

    // Guest A hits per-owner cap (2/hour).
    const r3 = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`), env);
    assert.equal(r3.status, 429);
    assert.ok(Number(r3.headers.get('Retry-After')) > 0);
    assert.equal((await r3.json()).error.code, 'rate_limited');

    // Guest B succeeds once (global count -> 3), then hits global guest cap (3/hour).
    const b1 = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, { token: GUEST_TOKEN_B }), env);
    assert.equal(b1.status, 201);
    const b2 = await worker.fetch(pdfReq(`/v1/w8/paper-links/${ALT_SHA}`, { token: GUEST_TOKEN_B, body: ALT_PDF }), env);
    assert.equal(b2.status, 429);
    assert.equal((await b2.json()).error.code, 'rate_limited');
  });

  test('fails closed on store redirects, invalid JSON/token/sha, non-PDF GET, oversized GET, and store error codes', async () => {
    const env = makeEnv();

    // Redirect refused on PUT and GET
    setW8PaperLinksFetchForTests(async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/x' } }));
    assert.equal((await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`), env)).status, 503);
    assert.equal((await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`), env)).status, 503);

    // Network throw -> 503 without echoing message
    setW8PaperLinksFetchForTests(async () => { throw new Error('secret-store-hostname-leaked'); });
    const netErr = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`), env);
    assert.equal(netErr.status, 503);
    assert.doesNotMatch(await netErr.text(), /secret-store-hostname-leaked/);

    // Invalid PUT JSON responses (uppercase token, wrong sha, bad expiresAt) -> 503
    for (const payload of [
      { token: 'INVALID_UPPER', sha256: SAMPLE_SHA, expiresAt: EXPIRES_AT },
      { token: LINK_TOKEN, sha256: ALT_SHA, expiresAt: EXPIRES_AT },
      { token: LINK_TOKEN, sha256: SAMPLE_SHA, expiresAt: 'not-a-date' },
    ]) {
      setW8PaperLinksFetchForTests(async () => new Response(JSON.stringify(payload), { status: 201 }));
      assert.equal((await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`), env)).status, 503);
    }

    // Store 507 storage_full and 429 rate_limited on PUT
    setW8PaperLinksFetchForTests(async () => new Response('full', { status: 507 }));
    const fullRes = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`), env);
    assert.equal(fullRes.status, 507);
    assert.equal((await fullRes.json()).error.code, 'storage_full');

    setW8PaperLinksFetchForTests(async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '45' } }));
    const slowRes = await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`), env);
    assert.equal(slowRes.status, 429);
    assert.equal(slowRes.headers.get('Retry-After'), '45');

    // Store 410 expired on GET/HEAD -> 404 not_found (empty body on HEAD)
    setW8PaperLinksFetchForTests(async () => new Response('gone', { status: 410 }));
    assert.equal((await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`), env)).status, 404);
    const headGone = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`, { method: 'HEAD' }), env);
    assert.equal(headGone.status, 404);
    assert.equal(await headGone.text(), '');

    // Store returns HTML or non-%PDF- bytes on GET -> 503
    setW8PaperLinksFetchForTests(async () => new Response('<html>oops</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    assert.equal((await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`), env)).status, 503);

    setW8PaperLinksFetchForTests(async () => new Response('not pdf bytes', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    assert.equal((await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`), env)).status, 503);

    // Store returns >32 MiB Content-Length on HEAD/GET -> 503
    setW8PaperLinksFetchForTests(async () => new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(32 * 1024 * 1024 + 1) },
    }));
    assert.equal((await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`, { method: 'HEAD' }), env)).status, 503);
  });

  test('logs contain route templates only and never log tokens, hashes, filenames, or secrets', async () => {
    const store = makeStoreStub();
    setW8PaperLinksFetchForTests(store.fn);
    const env = makeEnv();

    const logs = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));
    try {
      await worker.fetch(pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`, {
        headers: { 'X-Falsify-File-Name': 'SecretPaperName.pdf' },
      }), env);
      const got = await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`), env);
      await got.arrayBuffer();
      await worker.fetch(new Request(`https://api.example/v1/w8/paper-links/${LINK_TOKEN}.pdf`, { method: 'HEAD' }), env);
      await worker.fetch(pdfReq(`/v1/w8/paper-links/${LINK_TOKEN}.pdf`, { method: 'DELETE' }), env);

      // Force an unhandled error in direct handler invocation to verify error log redaction.
      const errRes = await handleW8PaperLinks({
        request: pdfReq(`/v1/w8/paper-links/${SAMPLE_SHA}`),
        env,
        match: matchW8PaperLinks(`/v1/w8/paper-links/${SAMPLE_SHA}`),
        deps: {
          getDb() { throw new Error(`boom ${GUEST_TOKEN_A} ${LINK_TOKEN} SecretPaperName.pdf`); },
          rateLimit() { throw new Error('unused'); },
          releaseSlot() {},
          authenticatePassword() {},
          clientIp: () => '127.0.0.1',
        },
      });
      assert.equal(errRes.status, 500);
    } finally {
      console.log = origLog;
      console.error = origError;
    }

    const joined = logs.join('\n');
    assert.match(joined, /\/v1\/w8\/paper-links\/:sha256/);
    assert.match(joined, /\/v1\/w8\/paper-links\/:token\.pdf/);
    for (const secret of [LINK_TOKEN, SAMPLE_SHA, STORE_TOKEN, GUEST_TOKEN_A, GUEST_ID_A, 'SecretPaperName.pdf']) {
      assert.equal(joined.includes(secret), false, `log must not contain ${secret}`);
    }
  });
});
