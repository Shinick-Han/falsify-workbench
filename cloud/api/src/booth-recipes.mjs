// Booth defect recipes (recipe contract v1, sections 1 and 2).
// An agent posts a recipe draft. A human opens the returned code on the event page, reviews it and submits.
// Recipes carry no personal data, live 6 hours in D1 and are cleaned lazily on write. No IP is stored;
// rate buckets hold truncated hashes only. These routes answer CORS "*" without credentials.
import { sha256Hex } from './ai-identity.mjs';
import { boothEnabled, publicMissions } from './booth.mjs';
import MISSION_TEXT from './booth-mission-text.json' with { type: 'json' };

export const RECIPE_SCHEMA = 'falsify.booth.recipe.v1';
export const MISSION_TEXT_SCHEMA = 'falsify.booth.mission-text.v1';
export const RECIPE_CODE = /^R-[0-9A-HJKMNP-TV-Z]{6}$/;
export const ASSIST_KINDS = Object.freeze(['manual', 'my-ai', 'agent']);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const NEW_ARXIV = /^\d{4}\.\d{4,5}(v\d+)?$/;
const OLD_ARXIV = /^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/;
const DEFECTS = ['number', 'figure', 'citation', 'logic', 'method', 'other'];
const RECIPE_KEYS = ['schema', 'paperId', 'edits', 'defectType', 'reason', 'source', 'agent'];
const EDIT_KEYS = ['page', 'find', 'replace', 'context'];
const AGENT_KEYS = ['name', 'model'];
// C0, DEL, C1 and the bidi marks, embeddings, overrides and isolates (U+200E, U+200F, U+202A-U+202E,
// U+2066-U+2069). Newline is allowed only in reason and context.
const CONTROL = /[\x00-\x1f\x7f-\x9f\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
const CONTROL_EXCEPT_NEWLINE = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u;
const DIGITS = /^[0-9]{1,12}$/;
export const MAX_RECIPE_BYTES = 8 * 1024;
const MAX_EDITS = 5;
const MAX_PAGE = 500;
export const RECIPE_TTL_MS = 6 * 3600 * 1000;
const CODE_ATTEMPTS = 5;
const HOUR = 3600;
const IP_BUCKET_PREFIX = 'booth-recipe:ip:';
const READ_BUCKET_PREFIX = 'booth-recipe-read:ip:';
const GLOBAL_BUCKET = 'booth-recipe:all';
const DEFAULT_EVENT_PAGE = 'https://shinick-han.github.io/falsify-workbench/event.html';

const MESSAGES = {
  invalid_request: 'The request is not valid for this endpoint.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  payload_too_large: 'The recipe exceeds 8 KB.',
  unsupported_media_type: 'The request type is not supported.',
  rate_limited: 'Too many recipe requests; retry later.',
  internal_error: 'Internal error.',
};
const RETRYABLE = new Set(['rate_limited', 'internal_error']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Retry-After',
};

class RecipeError extends Error {
  constructor(status, code, field, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.field = field;
    this.headers = headers;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const chars = value => [...value].length;
const utf8Bytes = text => new TextEncoder().encode(text).byteLength;

function invalid(field) {
  throw new RecipeError(400, 'invalid_request', field);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function recipeLimits(env) {
  return {
    perIpHour: positiveInt(env?.BOOTH_RECIPES_PER_IP_HOUR, 120),
    perHour: positiveInt(env?.BOOTH_RECIPES_PER_HOUR, 5000),
    readsPerIpHour: positiveInt(env?.BOOTH_RECIPE_READS_PER_IP_HOUR, 600),
  };
}

function eventPageUrl(env) {
  const raw = env?.EVENT_PAGE_URL;
  return typeof raw === 'string' && /^https?:\/\//.test(raw) ? raw : DEFAULT_EVENT_PAGE;
}

function errorBody(error) {
  const code = MESSAGES[error.code] ? error.code : 'internal_error';
  const body = { error: { code, message: MESSAGES[code], retryable: RETRYABLE.has(code) } };
  if (error.field) body.error.field = error.field;
  return body;
}

function failure(error) {
  if (!(error instanceof RecipeError)) {
    console.error(JSON.stringify({ event: 'unhandled_recipe_error', name: error?.name || 'unknown' }));
    return { status: 500, body: errorBody({ code: 'internal_error' }) };
  }
  const result = { status: error.status, body: errorBody(error) };
  if (Object.keys(error.headers).length) result.headers = { ...error.headers };
  // MCP callers only see {status, body}, so the wait is in the body as well as in Retry-After.
  const wait = Number(error.headers['Retry-After']);
  if (Number.isSafeInteger(wait) && wait >= 0) {
    result.body.error.retryAfterSeconds = wait;
    result.body.error.retryAfter = wait;
  }
  return result;
}

function onlyKeys(value, allowed, field) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra !== undefined) invalid(field ? field + '.' + extra : extra);
}

// Strings: length in code points, control characters rejected (newline allowed only where noted).
function text(value, field, { min = 0, max, newline = false }) {
  if (typeof value !== 'string') invalid(field);
  const length = chars(value);
  if (length < min || length > max) invalid(field);
  if ((newline ? CONTROL_EXCEPT_NEWLINE : CONTROL).test(value)) invalid(field);
  return value;
}

export function validPaperId(value) {
  return typeof value === 'string' && value.length <= 64 && (NEW_ARXIV.test(value) || OLD_ARXIV.test(value));
}

function parsePage(value, field) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE) invalid(field);
  return value;
}

function parseEdit(item, index) {
  const field = 'edits[' + index + ']';
  if (!isObject(item)) invalid(field);
  onlyKeys(item, EDIT_KEYS, field);
  const out = {};
  if (Object.hasOwn(item, 'page')) out.page = parsePage(item.page, field + '.page');
  out.find = text(item.find, field + '.find', { min: 1, max: 300 });
  if (!out.find.trim()) invalid(field + '.find');
  out.replace = text(item.replace, field + '.replace', { max: 300 });
  if (out.replace === out.find) invalid(field + '.replace');
  if (Object.hasOwn(item, 'context')) out.context = text(item.context, field + '.context', { max: 600, newline: true });
  return out;
}

function parseEdits(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EDITS) invalid('edits');
  return value.map(parseEdit);
}

function parseAgent(value) {
  if (!isObject(value)) invalid('agent');
  onlyKeys(value, AGENT_KEYS, 'agent');
  const out = {};
  if (Object.hasOwn(value, 'name')) out.name = text(value.name, 'agent.name', { max: 60 });
  if (Object.hasOwn(value, 'model')) out.model = text(value.model, 'agent.model', { max: 60 });
  return out;
}

function parseOptionalFields(input, recipe) {
  if (Object.hasOwn(input, 'defectType')) {
    if (!DEFECTS.includes(input.defectType)) invalid('defectType');
    recipe.defectType = input.defectType;
  }
  if (Object.hasOwn(input, 'reason')) recipe.reason = text(input.reason, 'reason', { max: 500, newline: true });
  if (Object.hasOwn(input, 'source') && !ASSIST_KINDS.includes(input.source)) invalid('source');
  if (Object.hasOwn(input, 'agent')) recipe.agent = parseAgent(input.agent);
}

// Contract section 1. The server has no page text for arbitrary papers, so "find occurs in the page"
// is checked by the event page when it applies the recipe. source is forced to "agent".
export function parseRecipe(input) {
  if (!isObject(input)) invalid();
  onlyKeys(input, RECIPE_KEYS);
  if (Object.hasOwn(input, 'schema') && input.schema !== RECIPE_SCHEMA) invalid('schema');
  if (!validPaperId(input.paperId)) invalid('paperId');
  const recipe = { schema: RECIPE_SCHEMA, paperId: input.paperId, edits: parseEdits(input.edits) };
  parseOptionalFields(input, recipe);
  recipe.source = 'agent';
  return recipe;
}

// Uppercase, drop spaces, map the letters Crockford reads as digits. The "R" prefix is required.
export function normalizeRecipeCode(input) {
  if (typeof input !== 'string') return null;
  const compact = input.replace(/\s+/g, '').toUpperCase();
  const match = /^R-?([0-9A-Z]{6})$/.exec(compact);
  if (!match) return null;
  const code = 'R-' + match[1].replace(/O/g, '0').replace(/[IL]/g, '1');
  return RECIPE_CODE.test(code) ? code : null;
}

export function randomRecipeCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const byte of bytes) raw += CROCKFORD[byte & 31];
  return 'R-' + raw;
}

function expandIpv6(address) {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(Math.max(missing, 0)).fill('0'), ...tail];
  return groups.every(group => /^[0-9a-f]{1,4}$/.test(group)) ? groups : null;
}

// Rate-limit key for a client address. IPv4 is unchanged. IPv6 is cut to its /64, because one
// client usually holds a whole /64. An IPv4-mapped IPv6 address counts as its IPv4 address.
export function ipRateKey(ip) {
  if (typeof ip !== 'string' || !ip.trim()) return 'unknown';
  const value = ip.trim().toLowerCase().replace(/%.*$/, '');
  if (!value.includes(':')) return value;
  const mapped = /^[0:]*:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return mapped[1];
  const groups = expandIpv6(value);
  if (!groups) return value;
  return groups.slice(0, 4).map(group => group.padStart(4, '0')).join(':') + '::/64';
}

async function bucketKey(prefix, value) {
  return prefix + (await sha256Hex('falsify-rate:' + prefix + value)).slice(0, 24);
}

// Same fixed-window counter as the other booth buckets (rate_counters), with an injectable clock.
async function takeSlot(db, bucket, limit, nowMs) {
  const seconds = Math.floor(nowMs / 1000);
  const start = seconds - (seconds % HOUR);
  const row = await db
    .prepare('INSERT INTO rate_counters (bucket, window_start, count) VALUES (?1, ?2, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(bucket, start)
    .first();
  if (row.count === 1) await db.prepare('DELETE FROM rate_counters WHERE window_start < ?1').bind(start).run();
  if (row.count > limit) throw new RecipeError(429, 'rate_limited', undefined, { 'Retry-After': String(start + HOUR - seconds) });
  return start;
}

async function releaseSlot(db, bucket, start) {
  await db.prepare('UPDATE rate_counters SET count = count - 1 WHERE bucket = ?1 AND window_start = ?2 AND count > 0').bind(bucket, start).run();
}

// A global rejection gives the per-IP slot back, as the claim buckets do.
async function chargeRecipe(db, env, ip, nowMs) {
  const limits = recipeLimits(env);
  const ipBucket = await bucketKey(IP_BUCKET_PREFIX, ipRateKey(ip));
  const ipSlot = await takeSlot(db, ipBucket, limits.perIpHour, nowMs);
  try {
    await takeSlot(db, GLOBAL_BUCKET, limits.perHour, nowMs);
  } catch (error) {
    await releaseSlot(db, ipBucket, ipSlot);
    throw error;
  }
}

async function storeRecipe(db, recipe, nowMs, nextCode) {
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + RECIPE_TTL_MS).toISOString();
  await db.prepare('DELETE FROM booth_recipes WHERE expires_at <= ?1').bind(createdAt).run();
  const payload = JSON.stringify(recipe);
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = nextCode();
    const result = await db.prepare(
      'INSERT INTO booth_recipes (code, recipe, created_at, expires_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (code) DO NOTHING'
    ).bind(code, payload, createdAt, expiresAt).run();
    if (Number(result?.meta?.changes) === 1) return { code, createdAt, expiresAt };
  }
  throw new RecipeError(500, 'internal_error');
}

function database(env) {
  if (!env?.DB) throw new RecipeError(500, 'internal_error');
  return env.DB;
}

function checkSize(recipe) {
  let serialized;
  try {
    serialized = JSON.stringify(recipe);
  } catch {
    invalid();
  }
  if (typeof serialized !== 'string') invalid();
  if (utf8Bytes(serialized) > MAX_RECIPE_BYTES) throw new RecipeError(413, 'payload_too_large');
}

const clockOf = options => (typeof options?.now === 'number' ? options.now : Date.now());

// Shared by POST /v1/booth/recipes and the MCP module. options.now and options.nextCode are test seams.
export async function createRecipe(env, recipe, ip, options = {}) {
  try {
    if (!boothEnabled(env)) throw new RecipeError(404, 'not_found');
    checkSize(recipe);
    const parsed = parseRecipe(recipe);
    const nowMs = clockOf(options);
    const db = database(env);
    await chargeRecipe(db, env, ip, nowMs);
    const stored = await storeRecipe(db, parsed, nowMs, options.nextCode || randomRecipeCode);
    const url = eventPageUrl(env) + '#recipe=' + stored.code;
    return { status: 201, body: { code: stored.code, url, expiresAt: stored.expiresAt } };
  } catch (error) {
    return failure(error);
  }
}

function parseStored(value) {
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function getRecipe(env, rawCode, options = {}) {
  try {
    if (!boothEnabled(env)) throw new RecipeError(404, 'not_found');
    const code = normalizeRecipeCode(rawCode);
    if (!code) throw new RecipeError(404, 'not_found');
    const nowIso = new Date(clockOf(options)).toISOString();
    const row = await database(env).prepare(
      'SELECT recipe, created_at, expires_at FROM booth_recipes WHERE code = ?1 AND expires_at > ?2'
    ).bind(code, nowIso).first();
    const recipe = row ? parseStored(row.recipe) : null;
    if (!recipe) throw new RecipeError(404, 'not_found');
    return { status: 200, body: { ...recipe, code, createdAt: row.created_at, expiresAt: row.expires_at } };
  } catch (error) {
    return failure(error);
  }
}

// The public mission list exactly as GET /v1/booth/config returns it.
export async function missionsList(env) {
  if (!boothEnabled(env) || !env?.DB) return [];
  return publicMissions(env.DB);
}

export function missionTextFrom(data, paperId) {
  if (!isObject(data) || data.schema !== MISSION_TEXT_SCHEMA || !isObject(data.papers)) return null;
  if (typeof paperId !== 'string' || !Object.hasOwn(data.papers, paperId)) return null;
  const entry = data.papers[paperId];
  return isObject(entry) ? entry : null;
}

const unversioned = id => String(id).replace(/v\d+$/, '');

// The bundle may hold more papers than are live. A paper is served only while it is also in the
// current mission list (booth settings, as GET /v1/booth/config shows it). The Worker binds env for MCP.
export async function missionText(paperId, env) {
  const entry = missionTextFrom(MISSION_TEXT, paperId);
  if (!entry) return null;
  const missions = await missionsList(env);
  const live = missions.some(item => isObject(item) && typeof item.paperId === 'string'
    && unversioned(item.paperId) === unversioned(paperId));
  return live ? entry : null;
}

function respond(result) {
  const hasBody = result.body !== null && result.body !== undefined;
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(hasBody ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...CORS,
    ...(result.headers || {}),
  };
  return new Response(hasBody ? JSON.stringify(result.body) : null, { status: result.status, headers });
}

function checkDeclaredLength(request) {
  const declared = request.headers.get('Content-Length');
  if (declared === null) return;
  if (!DIGITS.test(declared.trim())) invalid();
  if (Number(declared.trim()) > MAX_RECIPE_BYTES) throw new RecipeError(413, 'payload_too_large');
}

async function readBounded(request) {
  checkDeclaredLength(request);
  if (!request.body) invalid();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RECIPE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new RecipeError(413, 'payload_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readRecipeBody(request) {
  const type = (request.headers.get('Content-Type') || '').trim();
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(type)) throw new RecipeError(415, 'unsupported_media_type');
  const bytes = await readBounded(request);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return invalid();
  }
}

// GET by code is metered per IP (/64 for IPv6) so codes cannot be enumerated cheaply.
async function readRecipe(ctx) {
  try {
    if (!boothEnabled(ctx.env)) throw new RecipeError(404, 'not_found');
    const nowMs = clockOf(ctx.options);
    const bucket = await bucketKey(READ_BUCKET_PREFIX, ipRateKey(ctx.clientIp));
    await takeSlot(database(ctx.env), bucket, recipeLimits(ctx.env).readsPerIpHour, nowMs);
  } catch (error) {
    return failure(error);
  }
  return getRecipe(ctx.env, ctx.match.params.code, ctx.options);
}

async function listMissions(ctx) {
  return { status: 200, body: { missions: await missionsList(ctx.env) } };
}

async function postRecipe(ctx) {
  let body;
  try {
    body = await readRecipeBody(ctx.request);
  } catch (error) {
    return failure(error);
  }
  return createRecipe(ctx.env, body, ctx.clientIp, ctx.options);
}

async function getMissionText(ctx) {
  const paperId = ctx.match.params.paperId;
  const entry = validPaperId(paperId) ? await missionText(paperId, ctx.env) : null;
  if (!entry) return { status: 404, body: errorBody({ code: 'not_found' }) };
  return { status: 200, body: entry, headers: { 'Cache-Control': 'public, max-age=300' } };
}

const ROUTES = {
  '/v1/booth/recipes': { POST: postRecipe },
  '/v1/booth/recipes/:code': { GET: readRecipe },
  '/v1/booth/missions': { GET: listMissions },
  '/v1/booth/missions/:paperId/text': { GET: getMissionText },
};

function pathSegment(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function matchBoothRecipes(pathname) {
  if (pathname === '/v1/booth/recipes') return { template: '/v1/booth/recipes', params: {} };
  if (pathname === '/v1/booth/missions') return { template: '/v1/booth/missions', params: {} };
  const one = /^\/v1\/booth\/recipes\/([^/]+)$/.exec(pathname);
  if (one) return { template: '/v1/booth/recipes/:code', params: { code: pathSegment(one[1]) } };
  // Old-style arXiv ids contain a slash, sent raw or as %2F.
  const page = /^\/v1\/booth\/missions\/(.+)\/text$/.exec(pathname);
  if (page) return { template: '/v1/booth/missions/:paperId/text', params: { paperId: pathSegment(page[1]) } };
  return null;
}

function preflight(route) {
  return respond({
    status: 204,
    body: null,
    headers: {
      'Access-Control-Allow-Methods': [...Object.keys(route), 'OPTIONS'].join(', '),
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    },
  });
}

// ctx: {request, env, match, clientIp, options?}. Off (404) unless BOOTH_ENABLED, like the other booth routes.
export async function handleBoothRecipeRequest(ctx) {
  try {
    if (!boothEnabled(ctx.env)) return respond({ status: 404, body: errorBody({ code: 'not_found' }) });
    const route = ROUTES[ctx.match?.template];
    if (!route) return respond({ status: 404, body: errorBody({ code: 'not_found' }) });
    if (ctx.request.method === 'OPTIONS') return preflight(route);
    const handler = route[ctx.request.method];
    if (!handler) {
      return respond({ status: 405, body: errorBody({ code: 'method_not_allowed' }), headers: { Allow: Object.keys(route).join(', ') } });
    }
    return respond(await handler(ctx));
  } catch (error) {
    return respond(failure(error));
  }
}
