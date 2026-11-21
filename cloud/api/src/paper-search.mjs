// Booth paper search and PDF proxy (contract docs/booth-contract-20261120.md section 6).
// Search metadata is public and cached by normalized query + page only. The PDF route checks the
// arXiv OAI-PMH license before streaming bytes, and never sends an email, owner id or bearer upstream.
import { AiError, aiFail, resolveAiOwner, sha256Hex } from './ai-identity.mjs';
import { aiSettings } from './ai-gateway.mjs';
import { SESSION_HEADER } from './confluence.mjs';

const USER_AGENT = 'falsify-workbench-booth/1.0 (+https://github.com/Shinick-Han/falsify-workbench)';
const PAGE_SIZE = 10;
const MAX_PAGE = 5;
const MAX_AUTHORS = 6;
const MAX_ABSTRACT = 700;
const MAX_TITLE = 500;
const SEARCH_CACHE_SECONDS = 3600;
const LICENSE_CACHE_SECONDS = 86400;
const MAX_REDIRECTS = 3;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_OAI_BYTES = 1024 * 1024;
const INITIAL_HOSTS = new Set(['api.openalex.org', 'export.arxiv.org', 'oaipmh.arxiv.org', 'arxiv.org']);
const REDIRECT_HOSTS = new Set(['arxiv.org', 'export.arxiv.org']);
const NEW_ID = /^\d{4}\.\d{4,5}(v\d{1,3})?$/;
const OLD_ID = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d{1,3})?$/;
const OPENALEX_FILTER = 'best_oa_location.source.id:S4306400194,best_oa_location.license:cc-by|cc-by-sa|public-domain';
const OPENALEX_SELECT = 'id,display_name,publication_year,authorships,abstract_inverted_index,best_oa_location,ids';
const OPENALEX_LICENSES = {
  'cc-by': { id: 'cc-by', url: 'https://creativecommons.org/licenses/by/4.0/' },
  'cc-by-sa': { id: 'cc-by-sa', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  'public-domain': { id: 'public-domain', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
};

const MESSAGES = {
  invalid_request: 'The request is not valid for this endpoint.',
  unauthorized: 'A valid Falsify session is required.',
  membership_required: 'An active team membership is required.',
  open_access_disabled: 'Open access is not enabled.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  payload_too_large: 'The request body exceeds the hosted limit.',
  rate_limited: 'Too many hosted AI requests; retry later.',
  license_not_allowed: 'This paper license is not allowed for the booth.',
  redirect_refused: 'The upstream redirect was refused.',
  upstream_invalid: 'The upstream response could not be used.',
  upstream_unavailable: 'The paper source is temporarily unavailable.',
  internal_error: 'Internal error.',
};
const RETRYABLE = new Set(['rate_limited', 'upstream_unavailable', 'internal_error']);
const KNOWN = new Set(['/v1/papers/search', '/v1/papers/pdf']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function paperSearchEnabled(env) {
  return env?.PAPER_SEARCH_ENABLED === true || env?.PAPER_SEARCH_ENABLED === 'true';
}

// A key outside this charset is ignored so it cannot change the request shape. Empty means the free pool.
function openAlexKey(env) {
  const raw = typeof env?.OPENALEX_API_KEY === 'string' ? env.OPENALEX_API_KEY.trim() : '';
  return /^[A-Za-z0-9._~-]{1,200}$/.test(raw) ? raw : '';
}

function paperLimits(env) {
  return {
    searchPerOwnerHour: positiveInt(env?.PAPER_SEARCH_PER_OWNER_HOUR, 60),
    searchPerIpHour: positiveInt(env?.PAPER_SEARCH_PER_IP_HOUR, 300),
    pdfPerOwnerHour: positiveInt(env?.PAPER_PDF_PER_OWNER_HOUR, 20),
    pdfPerIpHour: positiveInt(env?.PAPER_PDF_PER_IP_HOUR, 120),
    perHour: positiveInt(env?.PAPER_SEARCH_PER_HOUR, 3000),
  };
}

// Guests use the tighter upload cap. Every other owner resolveAiOwner can return uses the deployment cap.
function uploadCap(env, ownerId) {
  const settings = aiSettings(env);
  return typeof ownerId === 'string' && ownerId.startsWith('gst:')
    ? settings.guestMaxUploadBytes
    : settings.maxUploadBytes;
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

function newRequestId() {
  return 'req_' + crypto.randomUUID().replace(/-/g, '');
}

function toPaperError(error) {
  if (error instanceof AiError) return error;
  const code = error?.code;
  if (code === 'unauthorized') return new AiError(401, 'unauthorized');
  if (code === 'membership_required') return new AiError(403, 'membership_required');
  if (code === 'open_access_disabled') return new AiError(403, 'open_access_disabled');
  if (code === 'rate_limited') return new AiError(429, 'rate_limited', error.headers || {});
  if (code === 'not_configured') return new AiError(503, 'upstream_unavailable');
  return new AiError(500, 'internal_error');
}

function errorResponse(error, requestId) {
  const code = MESSAGES[error.code] ? error.code : 'internal_error';
  return json(error.status || 500, {
    error: {
      code,
      message: MESSAGES[code],
      requestId,
      retryable: RETRYABLE.has(code),
    },
  }, error.headers || {});
}

// Retry-After is exposed on every response so a browser can read a 429 wait even without a refreshed session.
// X-Falsify-Paper-License is exposed so the event page can bind the OAI-verified licence of a PDF it opened.
const EXPOSE_HEADERS = `${SESSION_HEADER}, Retry-After, X-Falsify-Paper-License`;

function withRefreshed(response, refreshed) {
  const headers = new Headers(response.headers);
  if (refreshed) headers.set(SESSION_HEADER, refreshed);
  headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
  return new Response(response.body, { status: response.status, headers });
}

function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
    },
  });
}

export function matchPaperSearch(pathname) {
  if (pathname === '/v1/papers/search' || pathname === '/v1/papers/pdf') {
    return { template: pathname, params: {} };
  }
  // Keep every /v1/papers/* path here so it cannot fall through to Confluence or legacy records.
  if (typeof pathname === 'string' && pathname.startsWith('/v1/papers/')) {
    return { template: '/v1/papers/unknown', params: {} };
  }
  return null;
}

function requestUrl(ctx) {
  if (ctx.url instanceof URL) return ctx.url;
  return new URL(ctx.request.url);
}

function normalizeQuery(raw) {
  const text = String(raw).normalize('NFC').replace(/\s+/g, ' ').trim();
  if (/[\u0000-\u001f\u007f]/.test(text)) aiFail(400, 'invalid_request');
  const length = Array.from(text).length;
  if (length < 1 || length > 200) aiFail(400, 'invalid_request');
  return text;
}

function parsePage(raw) {
  if (!/^[1-5]$/.test(raw)) aiFail(400, 'invalid_request');
  return Number(raw);
}

function searchQuery(url) {
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => key !== 'q' && key !== 'page')) {
    aiFail(400, 'invalid_request');
  }
  if (!url.searchParams.has('q')) aiFail(400, 'invalid_request');
  const query = normalizeQuery(url.searchParams.get('q'));
  const page = url.searchParams.has('page') ? parsePage(url.searchParams.get('page')) : 1;
  return { query, page };
}

function isArxivId(value) {
  return typeof value === 'string' && (NEW_ID.test(value) || OLD_ID.test(value));
}

function canonicalArxivId(id) {
  return id.replace(/v\d{1,3}$/, '');
}

function pdfId(url) {
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => key !== 'id') || !url.searchParams.has('id')) {
    aiFail(400, 'invalid_request');
  }
  const id = url.searchParams.get('id');
  // The whole parameter must be an id. A URL, an encoded slash trick or a bad version never matches.
  if (!isArxivId(id)) aiFail(400, 'invalid_request');
  return id;
}

function clipChars(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('').trimEnd();
}

function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  return clipChars(value.replace(/\s+/g, ' ').trim(), max);
}

function yearOf(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1900 && n <= 2100 ? n : null;
}

function landingUrl(id) {
  const path = id.split('/').map(encodeURIComponent).join('/');
  return `https://arxiv.org/abs/${path}`;
}

function pdfFetchUrl(id) {
  const path = id.split('/').map(encodeURIComponent).join('/');
  return `https://arxiv.org/pdf/${path}`;
}

function filenameFor(id) {
  return `arxiv-${id.replaceAll('/', '-')}.pdf`;
}

async function bucketKey(prefix, value) {
  return prefix + (await sha256Hex('falsify-rate:' + prefix + value)).slice(0, 24);
}

function callerIp(deps) {
  if (typeof deps?.clientIp !== 'function') return 'unknown';
  const value = deps.clientIp();
  return typeof value === 'string' && value ? value : 'unknown';
}

// The shared PAPER_SEARCH_PER_HOUR bucket covers search and PDF so one global cap bounds both upstreams.
async function claimLimits(db, deps, claims) {
  const taken = [];
  try {
    for (const claim of claims) {
      const slot = await deps.rateLimit(db, claim.bucket, claim.limit);
      taken.push({ bucket: claim.bucket, slot });
    }
  } catch (error) {
    for (let i = taken.length - 1; i >= 0; i -= 1) {
      await deps.releaseSlot(db, taken[i].bucket, taken[i].slot).catch(() => {});
    }
    throw error;
  }
}

async function limitSearch(ctx, ownerId) {
  const limits = paperLimits(ctx.env);
  const db = ctx.deps.getDb();
  await claimLimits(db, ctx.deps, [
    { bucket: await bucketKey('paper-search:owner:', ownerId), limit: limits.searchPerOwnerHour },
    { bucket: await bucketKey('paper-search:ip:', callerIp(ctx.deps)), limit: limits.searchPerIpHour },
    { bucket: 'paper-search:all', limit: limits.perHour },
  ]);
}

async function limitPdf(ctx, ownerId) {
  const limits = paperLimits(ctx.env);
  const db = ctx.deps.getDb();
  await claimLimits(db, ctx.deps, [
    { bucket: await bucketKey('paper-pdf:owner:', ownerId), limit: limits.pdfPerOwnerHour },
    { bucket: await bucketKey('paper-pdf:ip:', callerIp(ctx.deps)), limit: limits.pdfPerIpHour },
    { bucket: 'paper-search:all', limit: limits.perHour },
  ]);
}

// Per-isolate copy of recently served PDFs. The Cache API is per data center and its behaviour on a
// workers.dev hostname is not documented as working, so a warm isolate answers mission PDFs from memory
// without the OAI license call and the arXiv fetch. Only bytes that passed the license allow-list (a fresh
// verdict, or a Cache API entry written after one) go in, keyed by the exact id like the Cache API key.
// Bounded by count and bytes (an isolate has 128 MB and the event Worker also buffers 16 MiB submissions),
// and each entry expires an hour after it was stored, so a changed upstream license or a new unversioned
// arXiv version is seen within the license cache TTL plus an hour. The oldest entry goes first.
const MEMO_MAX_ENTRIES = 12;
const MEMO_MAX_BYTES = 24 * 1024 * 1024;
const MEMO_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MEMO_TTL_MS = 60 * 60 * 1000;
const pdfMemo = new Map();

function memoGet(id, now = Date.now()) {
  const hit = pdfMemo.get(id);
  if (!hit) return null;
  pdfMemo.delete(id);
  if (now - hit.storedAt >= MEMO_TTL_MS || now < hit.storedAt) return null;
  pdfMemo.set(id, hit);
  return hit;
}

function memoPut(id, bytes, licenseId, now = Date.now()) {
  if (bytes.byteLength > MEMO_MAX_ENTRY_BYTES) return;
  pdfMemo.delete(id);
  pdfMemo.set(id, { bytes, licenseId, storedAt: now });
  let total = 0;
  for (const entry of pdfMemo.values()) total += entry.bytes.byteLength;
  for (const [key, entry] of pdfMemo) {
    if (pdfMemo.size <= MEMO_MAX_ENTRIES && total <= MEMO_MAX_BYTES) break;
    pdfMemo.delete(key);
    total -= entry.bytes.byteLength;
  }
}

export function clearPdfMemoForTests() {
  pdfMemo.clear();
}

export function agePdfMemoForTests(ms) {
  for (const entry of pdfMemo.values()) entry.storedAt -= ms;
}

function resolveCache(ctx) {
  if (ctx && ctx.cache && typeof ctx.cache.match === 'function') return ctx.cache;
  const caches = globalThis.caches;
  if (caches && caches.default && typeof caches.default.match === 'function') return caches.default;
  return null;
}

function cacheRequest(pathname, params) {
  const url = new URL(`https://cache.falsify.local${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, { method: 'GET' });
}

async function readCacheJson(cache, request) {
  if (!cache) return null;
  try {
    const hit = await cache.match(request);
    if (!hit) return null;
    return JSON.parse(await hit.text());
  } catch {
    return null;
  }
}

async function readCachedPdf(cache, request) {
  if (!cache) return null;
  try {
    const hit = await cache.match(request);
    if (!hit) return null;
    const bytes = new Uint8Array(await hit.arrayBuffer());
    const licenseId = hit.headers.get('x-falsify-paper-license') || '';
    if (!looksLikePdf(bytes) || !/^[a-z0-9._-]{1,64}$/.test(licenseId)) return null;
    return { bytes, licenseId };
  } catch {
    return null;
  }
}

async function writeCachedPdf(cache, request, bytes, licenseId) {
  if (!cache || typeof cache.put !== 'function') return;
  if (!looksLikePdf(bytes) || !/^[a-z0-9._-]{1,64}$/.test(licenseId)) return;
  const response = new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'X-Falsify-Paper-License': licenseId,
      'Cache-Control': `public, max-age=${LICENSE_CACHE_SECONDS}`,
    },
  });
  try {
    await cache.put(request, response);
  } catch {
    // A cache that refuses the PDF must not fail the visitor request.
  }
}

async function writeCacheJson(cache, request, payload, maxAge) {
  if (!cache || typeof cache.put !== 'function') return;
  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}`,
    },
  });
  try {
    await cache.put(request, response);
  } catch {
    // A cache that refuses the entry must not fail the visitor request.
  }
}

function assertHttps(url, hosts) {
  if (url.protocol !== 'https:' || url.username || url.password) aiFail(502, 'redirect_refused');
  if (url.port && url.port !== '443') aiFail(502, 'redirect_refused');
  if (!hosts.has(url.hostname)) aiFail(502, 'redirect_refused');
}

async function cancelBody(response) {
  try {
    if (response?.body) await response.body.cancel();
  } catch {
    // Already consumed or already cancelled.
  }
}

function redirectTarget(response, current) {
  if (![301, 302, 303, 307, 308].includes(response.status)) aiFail(502, 'redirect_refused');
  const location = response.headers.get('Location');
  if (!location || location.length > 2048) aiFail(502, 'redirect_refused');
  let next;
  try {
    next = new URL(location, current);
  } catch {
    aiFail(502, 'redirect_refused');
  }
  assertHttps(next, REDIRECT_HOSTS);
  return next;
}

// redirect:manual. A hop is followed only to https://arxiv.org/ or https://export.arxiv.org/.
// extraHeaders (the OpenAlex bearer) are attached only to the first request, and only when that
// host is api.openalex.org, so a redirect cannot carry the key.
async function upstreamFetch(fetchImpl, target, accept, extraHeaders = null) {
  if (typeof fetchImpl !== 'function') aiFail(503, 'upstream_unavailable');
  let current = new URL(target);
  assertHttps(current, INITIAL_HOSTS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers = { 'User-Agent': USER_AGENT, Accept: accept };
    if (hop === 0 && current.hostname === 'api.openalex.org' && extraHeaders) Object.assign(headers, extraHeaders);
    let response;
    try {
      response = await fetchImpl(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers,
      });
    } catch (error) {
      if (error instanceof AiError) throw error;
      aiFail(503, 'upstream_unavailable');
    }
    if (response.status >= 300 && response.status < 400) {
      const next = redirectTarget(response, current);
      await cancelBody(response);
      if (hop === MAX_REDIRECTS) aiFail(502, 'redirect_refused');
      current = next;
      continue;
    }
    return response;
  }
  aiFail(502, 'redirect_refused');
}

function concatChunks(chunks, size) {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readBounded(response, maxBytes) {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        aiFail(502, 'upstream_invalid');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AiError) throw error;
    aiFail(503, 'upstream_unavailable');
  }
  return concatChunks(chunks, size);
}

async function readText(response, maxBytes) {
  const bytes = await readBounded(response, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function declaredLength(response) {
  const declared = response.headers.get('Content-Length');
  if (declared === null) return null;
  const text = declared.trim();
  if (!/^[0-9]{1,12}$/.test(text)) aiFail(502, 'upstream_invalid');
  return Number(text);
}

function looksLikePdf(bytes) {
  if (bytes.byteLength < 5) return false;
  return new TextDecoder('latin1').decode(bytes.subarray(0, 5)) === '%PDF-';
}

function contentTypeAllowsPdf(response) {
  const type = (response.headers.get('Content-Type') || '').toLowerCase();
  if (!type) return true;
  return type.includes('application/pdf') || type.includes('application/octet-stream');
}

async function failCancelled(response, status, code) {
  await cancelBody(response);
  aiFail(status, code);
}

async function readPdfPrefix(reader, maxBytes) {
  const chunks = [];
  let length = 0;
  try {
    while (length < 5) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      chunks.push(value);
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        aiFail(413, 'payload_too_large');
      }
    }
  } catch (error) {
    if (error instanceof AiError) throw error;
    await reader.cancel().catch(() => {});
    aiFail(503, 'upstream_unavailable');
  }
  return concatChunks(chunks, length);
}

async function readPdfRemainder(reader, head, maxBytes) {
  const chunks = [head];
  let size = head.byteLength;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        aiFail(413, 'payload_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AiError) throw error;
    await reader.cancel().catch(() => {});
    aiFail(503, 'upstream_unavailable');
  }
  return concatChunks(chunks, size);
}

// Content-Length above the cap is a JSON 413 before the body is read.
// Otherwise the body is counted up to the cap. Crossing the cap, including when Content-Length
// understated the size, is a JSON 413 and the partial bytes are discarded. An accepted PDF is
// returned whole so the caller can cache it. Nothing over the cap is cached.
async function openPdfBody(response, maxBytes) {
  if (response.status !== 200) await failCancelled(response, 502, 'upstream_invalid');
  let declared;
  try {
    declared = declaredLength(response);
  } catch (error) {
    await cancelBody(response);
    throw error;
  }
  // A declared size over the cap is 413 before content-type or magic, and the body is not read.
  if (declared !== null && declared > maxBytes) await failCancelled(response, 413, 'payload_too_large');
  if (!contentTypeAllowsPdf(response)) await failCancelled(response, 502, 'upstream_invalid');
  if (!response.body) aiFail(502, 'upstream_invalid');
  const reader = response.body.getReader();
  const head = await readPdfPrefix(reader, maxBytes);
  if (!looksLikePdf(head)) {
    await reader.cancel().catch(() => {});
    aiFail(502, 'upstream_invalid');
  }
  return readPdfRemainder(reader, head, maxBytes);
}

function idFromPath(pathname) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const doi = /(?:^|\/)arxiv\.(\d{4}\.\d{4,5})(v\d{1,3})?$/i.exec(decoded);
  if (doi) {
    const id = doi[1] + (doi[2] || '');
    if (isArxivId(id)) return id;
  }
  const pieces = decoded.split('/').filter(Boolean);
  for (let n = 1; n <= 2 && n <= pieces.length; n += 1) {
    const candidate = pieces.slice(pieces.length - n).join('/').replace(/\.pdf$/i, '');
    if (isArxivId(candidate)) return candidate;
  }
  return null;
}

function idFromUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 400) return null;
  if (isArxivId(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'arxiv.org' && host !== 'export.arxiv.org' && host !== 'doi.org' && host !== 'dx.doi.org') return null;
  return idFromPath(url.pathname);
}

function abstractFromInverted(index) {
  if (!isObject(index)) return '';
  const placed = [];
  for (const [word, positions] of Object.entries(index)) {
    if (placed.length >= 2000) break;
    if (typeof word !== 'string' || word.length > 80 || !Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (placed.length >= 2000) break;
      if (!Number.isInteger(pos) || pos < 0 || pos > 2000) continue;
      placed.push([pos, word]);
    }
  }
  placed.sort((a, b) => a[0] - b[0]);
  return clipChars(placed.map(([, word]) => word).join(' '), MAX_ABSTRACT);
}

function authorNames(work) {
  const rows = Array.isArray(work.authorships) ? work.authorships : [];
  const names = [];
  for (const row of rows) {
    const name = cleanLine(row?.author?.display_name, 200);
    if (!name) continue;
    names.push(name);
    if (names.length === MAX_AUTHORS) break;
  }
  return names;
}

function mapOpenAlex(payload, page) {
  const results = [];
  const seen = new Set();
  for (const work of payload.results) {
    if (!isObject(work)) continue;
    const location = isObject(work.best_oa_location) ? work.best_oa_location : {};
    const license = OPENALEX_LICENSES[location.license];
    if (!license) continue;
    const ids = isObject(work.ids) ? work.ids : {};
    const id = idFromUrl(location.pdf_url) || idFromUrl(location.landing_page_url) || idFromUrl(ids.arxiv) || idFromUrl(ids.doi);
    if (!id || seen.has(id)) continue;
    const title = cleanLine(work.display_name, MAX_TITLE);
    if (!title) continue;
    seen.add(id);
    results.push({
      source: 'arxiv',
      id,
      title,
      authors: authorNames(work),
      year: yearOf(work.publication_year),
      abstract: abstractFromInverted(work.abstract_inverted_index),
      license: { id: license.id, url: license.url },
      licenseVerified: true,
      landingUrl: landingUrl(id),
    });
  }
  const total = Number(payload.meta?.count);
  const hasMore = page < MAX_PAGE && (Number.isFinite(total) ? page * PAGE_SIZE < total : results.length === PAGE_SIZE);
  return { source: 'arxiv', page, hasMore, results };
}

function openAlexUrl(query, page) {
  const params = new URLSearchParams();
  params.set('search', query);
  params.set('filter', OPENALEX_FILTER);
  params.set('per_page', String(PAGE_SIZE));
  params.set('page', String(page));
  params.set('select', OPENALEX_SELECT);
  return `https://api.openalex.org/works?${params.toString()}`;
}

async function searchOpenAlex(fetchImpl, query, page, apiKey) {
  // The key is a header only. It is never a query parameter and never sent to arXiv.
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : null;
  try {
    const response = await upstreamFetch(fetchImpl, openAlexUrl(query, page), 'application/json', headers);
    if (response.status !== 200) {
      await cancelBody(response);
      return null;
    }
    let payload;
    try {
      payload = JSON.parse(await readText(response, MAX_METADATA_BYTES));
    } catch (error) {
      if (error instanceof AiError && error.code !== 'upstream_invalid') throw error;
      return null;
    }
    if (!isObject(payload) || !Array.isArray(payload.results)) return null;
    return mapOpenAlex(payload, page);
  } catch (error) {
    if (error instanceof AiError && error.code !== 'redirect_refused' && error.code !== 'upstream_unavailable' && error.code !== 'upstream_invalid') {
      throw error;
    }
    return null;
  }
}

function xmlCodePoint(raw, radix) {
  const code = Number.parseInt(raw, radix);
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(code);
}

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => xmlCodePoint(n, 10))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => xmlCodePoint(n, 16))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagText(block, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!match) return '';
  return decodeXml(match[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function mapAtom(xml, page) {
  if (!xml.includes('<feed') || !xml.includes('http://www.w3.org/2005/Atom')) return null;
  const results = [];
  const seen = new Set();
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRe.exec(xml))) {
    const block = match[1];
    const rawId = tagText(block, 'id');
    const id = isArxivId(rawId) ? rawId : idFromUrl(rawId);
    if (!id || seen.has(id)) continue;
    const title = clipChars(tagText(block, 'title'), MAX_TITLE);
    if (!title) continue;
    const authors = [];
    const authorRe = /<author\b[^>]*>([\s\S]*?)<\/author>/g;
    let author;
    while ((author = authorRe.exec(block)) && authors.length < MAX_AUTHORS) {
      const name = cleanLine(tagText(author[1], 'name'), 200);
      if (name) authors.push(name);
    }
    const published = tagText(block, 'published');
    seen.add(id);
    results.push({
      source: 'arxiv',
      id,
      title,
      authors,
      year: yearOf(/^(\d{4})/.exec(published)?.[1]),
      abstract: clipChars(tagText(block, 'summary'), MAX_ABSTRACT),
      license: null,
      licenseVerified: false,
      landingUrl: landingUrl(id),
    });
  }
  const totalMatch = /<(?:[\w-]+:)?totalResults>(\d+)<\/(?:[\w-]+:)?totalResults>/.exec(xml);
  const total = totalMatch ? Number(totalMatch[1]) : NaN;
  const start = (page - 1) * PAGE_SIZE;
  const hasMore = page < MAX_PAGE && (Number.isFinite(total) ? start + results.length < total : results.length === PAGE_SIZE);
  return { source: 'arxiv', page, hasMore, results };
}

function atomUrl(query, page) {
  const params = new URLSearchParams();
  params.set('search_query', `all:${query}`);
  params.set('start', String((page - 1) * PAGE_SIZE));
  params.set('max_results', String(PAGE_SIZE));
  return `https://export.arxiv.org/api/query?${params.toString()}`;
}

async function searchArxiv(fetchImpl, query, page) {
  const response = await upstreamFetch(fetchImpl, atomUrl(query, page), 'application/atom+xml');
  if (response.status !== 200) {
    await cancelBody(response);
    aiFail(503, 'upstream_unavailable');
  }
  const mapped = mapAtom(await readText(response, MAX_METADATA_BYTES), page);
  if (!mapped) aiFail(502, 'upstream_invalid');
  return mapped;
}

function cc0License(text) {
  if (text.includes('creativecommons.org/publicdomain/zero') || text === 'cc0') {
    return { id: 'cc0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' };
  }
  return null;
}

function isBlockedLicense(text) {
  if (text.includes('nonexclusive')) return true;
  return text.includes('licenses/by-nc') || text.includes('licenses/by-nd');
}

function creativeCommonsLicense(kind, version) {
  return {
    id: version ? `cc-${kind}-${version}` : `cc-${kind}`,
    url: `https://creativecommons.org/licenses/${kind}/${version || '4.0'}/`,
  };
}

function shareAlikeLicense(text) {
  const match = /licenses\/by-sa\/(\d+\.\d+)/.exec(text);
  if (match || text.includes('licenses/by-sa/') || text === 'cc-by-sa') {
    return creativeCommonsLicense('by-sa', match ? match[1] : '');
  }
  return null;
}

function attributionLicense(text) {
  const match = /licenses\/by\/(\d+\.\d+)/.exec(text);
  if (match || text.includes('licenses/by/') || text === 'cc-by') {
    return creativeCommonsLicense('by', match ? match[1] : '');
  }
  return null;
}

function classifyLicense(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;
  const zero = cc0License(text);
  if (zero) return zero;
  if (isBlockedLicense(text)) return null;
  return shareAlikeLicense(text) || attributionLicense(text);
}

function oaiLicenses(xml) {
  const values = [];
  const re = /<license\b[^>]*>([\s\S]*?)<\/license>/gi;
  let match;
  while ((match = re.exec(xml))) values.push(decodeXml(match[1].replace(/<[^>]+>/g, '')).trim());
  return values;
}

function oaiErrorCode(xml) {
  const match = /<error\b[^>]*\bcode="([^"]+)"/i.exec(xml);
  return match ? match[1] : '';
}

function verdictFromOai(xml) {
  if (oaiErrorCode(xml) === 'idDoesNotExist') return { kind: 'missing' };
  if (/<error\b/i.test(xml) && !/<license\b/i.test(xml)) return null;
  const allowed = oaiLicenses(xml).map(classifyLicense).find(Boolean);
  if (allowed) return { kind: 'allow', id: allowed.id, url: allowed.url };
  // A record with no allowed license, including a missing <license>, is a definitive deny.
  if (/<metadata\b/i.test(xml) || /<license\b/i.test(xml) || /<header\b/i.test(xml)) return { kind: 'deny' };
  return null;
}

function oaiUrl(canonicalId) {
  const params = new URLSearchParams();
  params.set('verb', 'GetRecord');
  params.set('identifier', `oai:arXiv.org:${canonicalId}`);
  params.set('metadataPrefix', 'arXiv');
  return `https://oaipmh.arxiv.org/oai?${params.toString()}`;
}

async function licenseVerdict(ctx, id) {
  const cache = resolveCache(ctx);
  const canonical = canonicalArxivId(id);
  const request = cacheRequest('/papers/license', { id: canonical });
  const cached = await readCacheJson(cache, request);
  if (cached && (cached.kind === 'allow' || cached.kind === 'deny' || cached.kind === 'missing')) return cached;
  const response = await upstreamFetch(ctx.fetchImpl, oaiUrl(canonical), 'text/xml');
  if (response.status !== 200) {
    await cancelBody(response);
    aiFail(503, 'upstream_unavailable');
  }
  const verdict = verdictFromOai(await readText(response, MAX_OAI_BYTES));
  if (!verdict) aiFail(502, 'upstream_invalid');
  await writeCacheJson(cache, request, verdict, LICENSE_CACHE_SECONDS);
  return verdict;
}

function pdfResponse(body, id, licenseId) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filenameFor(id)}"`,
      'X-Falsify-Paper-License': licenseId,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function handleSearch(ctx, ownerId) {
  const { query, page } = searchQuery(requestUrl(ctx));
  await limitSearch(ctx, ownerId);
  const cache = resolveCache(ctx);
  const request = cacheRequest('/papers/search', { q: query, page: String(page) });
  const cached = await readCacheJson(cache, request);
  if (cached && cached.source === 'arxiv' && Array.isArray(cached.results) && cached.page === page) {
    return json(200, cached, { 'Cache-Control': `public, max-age=${SEARCH_CACHE_SECONDS}` });
  }
  const fresh = await searchOpenAlex(ctx.fetchImpl, query, page, openAlexKey(ctx.env))
    || await searchArxiv(ctx.fetchImpl, query, page);
  await writeCacheJson(cache, request, fresh, SEARCH_CACHE_SECONDS);
  return json(200, fresh, { 'Cache-Control': `public, max-age=${SEARCH_CACHE_SECONDS}` });
}

async function handlePdf(ctx, ownerId) {
  const id = pdfId(requestUrl(ctx));
  await limitPdf(ctx, ownerId);
  const cap = uploadCap(ctx.env, ownerId);
  const cache = resolveCache(ctx);
  // Version stays in the key: 2503.10497 and 2503.10497v2 are different files.
  const request = cacheRequest('/papers/pdf', { id });
  const memo = memoGet(id);
  if (memo) {
    if (memo.bytes.byteLength > cap) aiFail(413, 'payload_too_large');
    return pdfResponse(memo.bytes, id, memo.licenseId);
  }
  const cached = await readCachedPdf(cache, request);
  if (cached) {
    if (cached.bytes.byteLength > cap) aiFail(413, 'payload_too_large');
    memoPut(id, cached.bytes, cached.licenseId);
    return pdfResponse(cached.bytes, id, cached.licenseId);
  }
  const verdict = await licenseVerdict(ctx, id);
  if (verdict.kind === 'missing') aiFail(404, 'not_found');
  if (verdict.kind !== 'allow') aiFail(403, 'license_not_allowed');
  const response = await upstreamFetch(ctx.fetchImpl, pdfFetchUrl(id), 'application/pdf');
  const body = await openPdfBody(response, cap);
  await writeCachedPdf(cache, request, body, verdict.id);
  memoPut(id, body, verdict.id);
  return pdfResponse(body, id, verdict.id);
}

// ctx: { request, env, url, match, fetchImpl, cache?, deps: { getDb, rateLimit, releaseSlot, authenticatePassword, clientIp } }
// cache, when present, replaces caches.default. Upstream calls use fetchImpl with redirect:'manual'.
export async function handlePaperSearchRequest(ctx) {
  const requestId = newRequestId();
  let refreshed = null;
  try {
    if (!paperSearchEnabled(ctx.env)) aiFail(404, 'not_found');
    const template = ctx.match?.template || '';
    if (!KNOWN.has(template)) aiFail(404, 'not_found');
    if (ctx.request.method === 'OPTIONS') return preflight();
    const owner = await resolveAiOwner({
      request: ctx.request,
      env: ctx.env,
      authenticatePassword: ctx.deps?.authenticatePassword,
      getDb: ctx.deps?.getDb,
      fetchImpl: ctx.fetchImpl,
    });
    refreshed = owner.refreshed || null;
    if (ctx.request.method !== 'GET') aiFail(405, 'method_not_allowed', { Allow: 'GET' });
    const response = template === '/v1/papers/search'
      ? await handleSearch(ctx, owner.ownerId)
      : await handlePdf(ctx, owner.ownerId);
    return withRefreshed(response, refreshed);
  } catch (error) {
    const known = toPaperError(error);
    if (!(error instanceof AiError) && known.code === 'internal_error') {
      console.error(JSON.stringify({
        event: 'unhandled_paper_error',
        route: ctx.match?.template || 'unknown',
        name: error?.name || 'unknown',
      }));
    }
    return withRefreshed(errorResponse(known, requestId), refreshed);
  }
}
