// W8 temporary PDF link proxy routes (/v1/w8/paper-links/*).
// PUT uploads a bounded <=32 MiB PDF authenticated via resolveAiOwner and forwards it to the fixed
// store at W8_PDF_STORE_BASE/objects/{sha} with X-Falsify-Store-Token and X-Falsify-Owner from auth.
// GET/HEAD publicly proxy /links/{token}.pdf with a neutral inline filename, no-store, and noindex.
// DELETE requires auth matching the link owner. Disabled (404) when store env vars are unconfigured.
import { AiError, resolveAiOwner, sha256Hex } from './ai-identity.mjs';
import { SESSION_HEADER } from './confluence.mjs';

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_STORE_JSON_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const SHA256_PATH = /^\/v1\/w8\/paper-links\/([0-9a-f]{64})$/;
const TOKEN_PDF_PATH = /^\/v1\/w8\/paper-links\/([0-9a-f]{32})\.pdf$/;
const TOKEN_HEX = /^[0-9a-f]{32}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DIGITS = /^[0-9]{1,12}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const GUEST_GLOBAL_BUCKET = 'w8-pdf-links-guest:all';
const OWNER_UPLOAD_PREFIX = 'w8-pdf-link:';
const OWNER_DELETE_PREFIX = 'w8-pdf-link-del:';
const WRITE_EXPOSE_HEADERS = `${SESSION_HEADER}, Retry-After`;
const READ_EXPOSE_HEADERS = 'Content-Length, Content-Type, Content-Disposition';
const NEUTRAL_DISPOSITION = 'inline; filename="paper.pdf"';

const MESSAGES = {
  invalid_request: 'The request is not valid for this endpoint.',
  unauthorized: 'A valid Falsify session is required.',
  membership_required: 'An active team membership is required.',
  open_access_disabled: 'Open access is not enabled.',
  forbidden: 'This action is not allowed.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  conflict: 'The paper link request conflicted with existing state.',
  payload_too_large: 'The PDF exceeds the 32 MiB limit.',
  unsupported_media_type: 'The request body must be application/pdf.',
  invalid_pdf: 'The file is not a PDF.',
  pdf_mismatch: 'The PDF does not match the declared SHA-256.',
  rate_limited: 'Too many paper link requests; retry later.',
  storage_full: 'Temporary PDF storage is full.',
  ai_unavailable: 'Authentication is temporarily unavailable.',
  store_unavailable: 'The PDF link store is temporarily unavailable.',
  internal_error: 'Internal error.',
};
const RETRYABLE = new Set(['rate_limited', 'ai_unavailable', 'store_unavailable', 'internal_error']);

let injectedFetch = null;
export function setW8PaperLinksFetchForTests(fn) {
  injectedFetch = typeof fn === 'function' ? fn : null;
}

const linkFail = (status, code, headers = {}) => {
  throw new AiError(status, code, headers);
};

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function transportAllowed(url) {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
}

function parseStoreBase(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!transportAllowed(url)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function parseStoreToken(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512 || CONTROL.test(trimmed)) return null;
  return trimmed;
}

export function storeConfig(env) {
  const base = parseStoreBase(env?.W8_PDF_STORE_BASE);
  const token = parseStoreToken(env?.W8_PDF_STORE_TOKEN);
  if (!base || !token) return null;
  const maxBytes = Math.min(positiveInt(env?.W8_PDF_LINK_MAX_BYTES, MAX_PDF_BYTES), MAX_PDF_BYTES);
  const timeoutMs = positiveInt(env?.W8_PDF_STORE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  return { base, token, maxBytes, timeoutMs };
}

export function w8PaperLinksConfigured(env) {
  return storeConfig(env) !== null;
}

export function matchW8PaperLinks(pathname) {
  if (typeof pathname !== 'string') return null;
  if (pathname !== '/v1/w8/paper-links' && !pathname.startsWith('/v1/w8/paper-links/')) return null;
  const link = TOKEN_PDF_PATH.exec(pathname);
  if (link) return { template: '/v1/w8/paper-links/:token.pdf', kind: 'link', token: link[1] };
  const object = SHA256_PATH.exec(pathname);
  if (object) return { template: '/v1/w8/paper-links/:sha256', kind: 'object', sha256: object[1] };
  return { template: '/v1/w8/paper-links/unknown', kind: 'unknown' };
}

export function isPublicPaperLinkRead(match, request, allowedOrigin = false) {
  if (match?.kind !== 'link') return false;
  const method = request?.method || '';
  if (method === 'GET' || method === 'HEAD') return true;
  if (method !== 'OPTIONS') return false;
  const requested = (request.headers.get('Access-Control-Request-Method') || '').trim().toUpperCase();
  if (requested === 'GET' || requested === 'HEAD') return true;
  return requested === '' && !allowedOrigin;
}

function newRequestId() {
  return 'req_' + crypto.randomUUID().replace(/-/g, '');
}

function json(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function toLinkError(error) {
  if (error instanceof AiError) return error;
  const code = error?.code;
  if (code === 'unauthorized') return new AiError(401, 'unauthorized');
  if (code === 'membership_required') return new AiError(403, 'membership_required');
  if (code === 'open_access_disabled') return new AiError(403, 'open_access_disabled');
  if (code === 'rate_limited') return new AiError(429, 'rate_limited', error.headers || {});
  if (code === 'not_configured') return new AiError(503, 'store_unavailable');
  return new AiError(500, 'internal_error');
}

function errorResponse(error, requestId, isHead = false) {
  const code = MESSAGES[error.code] ? error.code : 'internal_error';
  const status = code === error.code ? (error.status || 500) : 500;
  if (isHead) {
    return new Response(null, {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(error.headers || {}),
      },
    });
  }
  return json(status, {
    error: {
      code,
      message: MESSAGES[code],
      requestId,
      retryable: RETRYABLE.has(code),
    },
  }, error.headers || {});
}

function withWriteHeaders(response, refreshed) {
  const headers = new Headers(response.headers);
  if (refreshed) headers.set(SESSION_HEADER, refreshed);
  headers.set('Access-Control-Expose-Headers', WRITE_EXPOSE_HEADERS);
  return new Response(response.body, { status: response.status, headers });
}

function resolveStoreFetch(ctx) {
  if (typeof ctx.fetchImpl === 'function') return ctx.fetchImpl;
  if (injectedFetch) return (url, init) => injectedFetch(String(url), init, ctx.env);
  return (url, init) => globalThis.fetch(url, init);
}

function sanitizedRetryAfter(response) {
  const raw = (response.headers.get('Retry-After') || '').trim();
  return /^[0-9]{1,6}$/.test(raw) ? { 'Retry-After': raw } : {};
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel();
  } catch { /* ignore */ }
}

function hasPdfMagic(bytes) {
  if (!bytes || bytes.byteLength < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function bucketKey(prefix, value) {
  return prefix + (await sha256Hex('falsify-rate:' + prefix + value)).slice(0, 24);
}

function baseMediaType(header) {
  return String(header || '').trim().toLowerCase().split(';')[0].trim();
}

async function readBoundedPdf(request, maxBytes) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null) {
    const text = declared.trim();
    if (!DIGITS.test(text)) linkFail(400, 'invalid_request');
    if (Number(text) > maxBytes) linkFail(413, 'payload_too_large');
  }
  if (!request.body) linkFail(400, 'invalid_pdf');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        linkFail(413, 'payload_too_large');
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readStoreJson(response) {
  let bytes;
  try {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_STORE_JSON_BYTES) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function linkLimits(env, ownerId) {
  const guest = typeof ownerId === 'string' && ownerId.startsWith('gst:');
  const ownerLimit = guest
    ? positiveInt(env?.W8_PDF_LINKS_GUEST_PER_OWNER_HOUR, positiveInt(env?.AI_GUEST_UPLOADS_PER_OWNER_HOUR, 10))
    : positiveInt(env?.W8_PDF_LINKS_PER_OWNER_HOUR, positiveInt(env?.AI_UPLOADS_PER_OWNER_HOUR, 60));
  const guestGlobalLimit = positiveInt(
    env?.W8_PDF_LINKS_GUEST_PER_HOUR,
    positiveInt(env?.AI_GUEST_UPLOADS_PER_HOUR, 300),
  );
  const deleteLimit = Math.max(ownerLimit * 2, 20);
  return { guest, ownerLimit, guestGlobalLimit, deleteLimit };
}

async function claimUploadSlots(db, deps, env, ownerId) {
  const limits = linkLimits(env, ownerId);
  const ownerBucket = await bucketKey(OWNER_UPLOAD_PREFIX, ownerId);
  const ownerSlot = await deps.rateLimit(db, ownerBucket, limits.ownerLimit);
  if (!limits.guest) return { ownerBucket, ownerSlot, globalSlot: null };
  try {
    const globalSlot = await deps.rateLimit(db, GUEST_GLOBAL_BUCKET, limits.guestGlobalLimit);
    return { ownerBucket, ownerSlot, globalSlot };
  } catch (error) {
    await deps.releaseSlot(db, ownerBucket, ownerSlot);
    throw error;
  }
}

async function releaseUploadSlots(db, deps, slots) {
  if (!slots) return;
  await deps.releaseSlot(db, slots.ownerBucket, slots.ownerSlot);
  if (slots.globalSlot !== null) {
    await deps.releaseSlot(db, GUEST_GLOBAL_BUCKET, slots.globalSlot);
  }
}

function parsePutStoreResult(parsed, expectedSha) {
  if (!isObject(parsed)) return null;
  if (typeof parsed.token !== 'string' || !TOKEN_HEX.test(parsed.token)) return null;
  if (parsed.sha256 !== expectedSha) return null;
  if (typeof parsed.expiresAt !== 'string' || !ISO_TIMESTAMP.test(parsed.expiresAt)) return null;
  if (!Number.isFinite(Date.parse(parsed.expiresAt))) return null;
  const result = { token: parsed.token, sha256: parsed.sha256, expiresAt: parsed.expiresAt };
  if (typeof parsed.driveFileId === 'string' && /^[A-Za-z0-9_-]{10,180}$/.test(parsed.driveFileId)) result.driveFileId = parsed.driveFileId;
  return result;
}

function mapPutStoreFailure(response) {
  const status = response.status;
  if (status === 400 || status === 415 || status === 422) return new AiError(400, 'invalid_request');
  if (status === 409) return new AiError(409, 'conflict');
  if (status === 413) return new AiError(413, 'payload_too_large');
  if (status === 429) return new AiError(429, 'rate_limited', sanitizedRetryAfter(response));
  if (status === 507) return new AiError(507, 'storage_full');
  return new AiError(503, 'store_unavailable');
}

async function sendToStore(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer?.unref === 'function') timer.unref();
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' });
    return { response, clear: () => clearTimeout(timer) };
  } catch {
    clearTimeout(timer);
    linkFail(503, 'store_unavailable');
  }
}

async function handlePutObject(ctx, config, owner) {
  if (baseMediaType(ctx.request.headers.get('Content-Type')) !== 'application/pdf') {
    linkFail(415, 'unsupported_media_type');
  }
  const bytes = await readBoundedPdf(ctx.request, config.maxBytes);
  if (!hasPdfMagic(bytes)) linkFail(400, 'invalid_pdf');
  const actualSha = await sha256Bytes(bytes);
  if (actualSha !== ctx.match.sha256) linkFail(400, 'pdf_mismatch');

  const db = ctx.deps.getDb();
  const slots = await claimUploadSlots(db, ctx.deps, ctx.env, owner.ownerId);
  const fetchImpl = resolveStoreFetch(ctx);
  let call;
  try {
    call = await sendToStore(
      fetchImpl,
      `${config.base}/objects/${ctx.match.sha256}`,
      {
        method: 'PUT',
        headers: {
          'X-Falsify-Store-Token': config.token,
          'X-Falsify-Owner': owner.ownerId,
          'Content-Type': 'application/pdf',
          Accept: 'application/json',
        },
        body: bytes,
      },
      config.timeoutMs,
    );
  } catch (error) {
    await releaseUploadSlots(db, ctx.deps, slots);
    throw error;
  }

  try {
    const { response } = call;
    if (response.status >= 300 && response.status < 400) {
      await cancelBody(response);
      await releaseUploadSlots(db, ctx.deps, slots);
      linkFail(503, 'store_unavailable');
    }
    if (response.status < 200 || response.status >= 300) {
      await cancelBody(response);
      const mapped = mapPutStoreFailure(response);
      if (mapped.code === 'store_unavailable') await releaseUploadSlots(db, ctx.deps, slots);
      throw mapped;
    }
    const parsed = parsePutStoreResult(await readStoreJson(response), ctx.match.sha256);
    if (!parsed) {
      await releaseUploadSlots(db, ctx.deps, slots);
      linkFail(503, 'store_unavailable');
    }
    return json(response.status === 200 ? 200 : 201, parsed);
  } finally {
    call.clear();
  }
}

function validatedPdfContentLength(response, maxBytes) {
  const raw = response.headers.get('Content-Length');
  if (raw === null) return null;
  const text = raw.trim();
  if (!DIGITS.test(text)) return false;
  const n = Number(text);
  if (n < PDF_MAGIC.length || n > maxBytes) return false;
  return text;
}

function neutralPdfHeaders(contentLength) {
  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'Content-Disposition': NEUTRAL_DISPOSITION,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Expose-Headers': READ_EXPOSE_HEADERS,
  });
  if (contentLength !== null) headers.set('Content-Length', contentLength);
  return headers;
}

function concatPrefix(chunks, byteLength) {
  const out = new Uint8Array(Math.min(byteLength, PDF_MAGIC.length));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, out.byteLength - offset);
    if (take <= 0) break;
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

async function openVerifiedPdfStream(response, maxBytes, onDone) {
  if (!response.body) {
    onDone();
    linkFail(503, 'store_unavailable');
  }
  const reader = response.body.getReader();
  const prefixChunks = [];
  let seen = 0;
  let finished = false;
  try {
    while (seen < PDF_MAGIC.length) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      seen += value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel().catch(() => {});
        onDone();
        linkFail(503, 'store_unavailable');
      }
      prefixChunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    onDone();
    if (error instanceof AiError) throw error;
    linkFail(503, 'store_unavailable');
  }

  if (!hasPdfMagic(concatPrefix(prefixChunks, seen))) {
    await reader.cancel().catch(() => {});
    onDone();
    linkFail(503, 'store_unavailable');
  }

  let total = seen;
  let prefixIndex = 0;
  return new ReadableStream({
    async pull(controller) {
      if (prefixIndex < prefixChunks.length) {
        controller.enqueue(prefixChunks[prefixIndex++]);
        if (finished && prefixIndex >= prefixChunks.length) {
          onDone();
          controller.close();
        }
        return;
      }
      if (finished) {
        onDone();
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          onDone();
          controller.close();
          return;
        }
        if (!value || value.byteLength === 0) return;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          onDone();
          controller.error(new Error('pdf_size_exceeded'));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        onDone();
        controller.error(error);
      }
    },
    async cancel() {
      onDone();
      await reader.cancel().catch(() => {});
    },
  });
}

async function handleReadLink(ctx, config) {
  const method = ctx.request.method;
  const fetchImpl = resolveStoreFetch(ctx);
  const call = await sendToStore(
    fetchImpl,
    `${config.base}/links/${ctx.match.token}.pdf`,
    {
      method,
      headers: {
        'X-Falsify-Store-Token': config.token,
        Accept: 'application/pdf',
      },
    },
    config.timeoutMs,
  );

  const { response } = call;
  if (response.status === 404 || response.status === 410) {
    await cancelBody(response);
    call.clear();
    linkFail(404, 'not_found');
  }
  if (response.status === 429) {
    const retry = sanitizedRetryAfter(response);
    await cancelBody(response);
    call.clear();
    linkFail(429, 'rate_limited', retry);
  }
  if (response.status !== 200) {
    await cancelBody(response);
    call.clear();
    linkFail(503, 'store_unavailable');
  }
  if (baseMediaType(response.headers.get('Content-Type')) !== 'application/pdf') {
    await cancelBody(response);
    call.clear();
    linkFail(503, 'store_unavailable');
  }
  const contentLength = validatedPdfContentLength(response, config.maxBytes);
  if (contentLength === false) {
    await cancelBody(response);
    call.clear();
    linkFail(503, 'store_unavailable');
  }

  const headers = neutralPdfHeaders(contentLength);
  if (method === 'HEAD') {
    await cancelBody(response);
    call.clear();
    return new Response(null, { status: 200, headers });
  }
  const stream = await openVerifiedPdfStream(response, config.maxBytes, call.clear);
  return new Response(stream, { status: 200, headers });
}

async function handleDeleteTarget(ctx, config, owner, targetPath) {
  const db = ctx.deps.getDb();
  const limits = linkLimits(ctx.env, owner.ownerId);
  const bucket = await bucketKey(OWNER_DELETE_PREFIX, owner.ownerId);
  const slot = await ctx.deps.rateLimit(db, bucket, limits.deleteLimit);

  const fetchImpl = resolveStoreFetch(ctx);
  let call;
  try {
    call = await sendToStore(
      fetchImpl,
      `${config.base}${targetPath}`,
      {
        method: 'DELETE',
        headers: {
          'X-Falsify-Store-Token': config.token,
          'X-Falsify-Owner': owner.ownerId,
          Accept: 'application/json',
        },
      },
      config.timeoutMs,
    );
  } catch (error) {
    await ctx.deps.releaseSlot(db, bucket, slot);
    throw error;
  }

  try {
    const { response } = call;
    await cancelBody(response);
    if (response.status === 200 || response.status === 204) return json(200, { deleted: true });
    if (response.status === 403) linkFail(403, 'forbidden');
    if (response.status === 404 || response.status === 410) linkFail(404, 'not_found');
    if (response.status === 429) linkFail(429, 'rate_limited', sanitizedRetryAfter(response));
    await ctx.deps.releaseSlot(db, bucket, slot);
    linkFail(503, 'store_unavailable');
  } finally {
    call.clear();
  }
}

function preflightResponse(match, request, allowedOrigin) {
  if (match.kind === 'object') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store',
      },
    });
  }
  if (isPublicPaperLinkRead(match, request, allowedOrigin)) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store',
      },
    });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, HEAD, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
    },
  });
}

async function resolveOwner(ctx) {
  return resolveAiOwner({
    request: ctx.request,
    env: ctx.env,
    authenticatePassword: ctx.deps?.authenticatePassword,
    getDb: ctx.deps?.getDb,
    fetchImpl: ctx.authFetchImpl || ctx.fetchImpl,
  });
}

async function dispatchPaperLink(ctx, config) {
  const { match, request } = ctx;
  if (match.kind === 'unknown') linkFail(404, 'not_found');
  if (request.method === 'OPTIONS') return { response: preflightResponse(match, request, ctx.allowedOrigin === true), refreshed: null };
  if (match.kind === 'object') {
    if (request.method === 'PUT') {
      const owner = await resolveOwner(ctx);
      return { response: await handlePutObject(ctx, config, owner), refreshed: owner.refreshed || null, isWrite: true };
    }
    if (request.method === 'DELETE') {
      const owner = await resolveOwner(ctx);
      return { response: await handleDeleteTarget(ctx, config, owner, `/objects/${match.sha256}`), refreshed: owner.refreshed || null, isWrite: true };
    }
    linkFail(405, 'method_not_allowed', { Allow: 'PUT, DELETE' });
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    return { response: await handleReadLink(ctx, config), refreshed: null, isWrite: false };
  }
  if (request.method === 'DELETE') {
    const owner = await resolveOwner(ctx);
    return { response: await handleDeleteTarget(ctx, config, owner, `/links/${match.token}.pdf`), refreshed: owner.refreshed || null, isWrite: true };
  }
  linkFail(405, 'method_not_allowed', { Allow: 'GET, HEAD, DELETE' });
}

// ctx: { request, env, url, match, allowedOrigin?, fetchImpl?, authFetchImpl?, deps: { getDb, rateLimit, releaseSlot, authenticatePassword, clientIp } }
export async function handleW8PaperLinks(ctx) {
  const requestId = newRequestId();
  const isHead = ctx.request.method === 'HEAD';
  const isWriteMethod = ctx.request.method === 'PUT' || ctx.request.method === 'DELETE';
  let refreshed = null;
  try {
    const config = storeConfig(ctx.env);
    if (!config) linkFail(404, 'not_found');
    const result = await dispatchPaperLink(ctx, config);
    refreshed = result.refreshed || null;
    return result.isWrite ? withWriteHeaders(result.response, refreshed) : result.response;
  } catch (error) {
    const known = toLinkError(error);
    if (!(error instanceof AiError) && known.code === 'internal_error') {
      console.error(JSON.stringify({
        event: 'unhandled_w8_paper_link_error',
        route: ctx.match?.template || 'unknown',
        name: error?.name || 'unknown',
      }));
    }
    const resp = errorResponse(known, requestId, isHead);
    return isWriteMethod ? withWriteHeaders(resp, refreshed) : resp;
  }
}
