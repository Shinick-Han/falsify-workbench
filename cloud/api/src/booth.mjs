// Booth submissions (contract docs/booth-contract-20261120.md section 5).
// Visitors submit one completed RED apply-only job. The claim key is returned once.
// owner_id and claim_hash are never returned. No IP, user agent or token is stored here.
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { AiError, resolveAiOwner, sha256Hex } from './ai-identity.mjs';
import { getRuntimeArtifact, getRuntimeJob } from './ai-runtime-client.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT = /^F-\d{4,}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const COURSES = ['quick', 'deep'];
const DEFECTS = ['number', 'figure', 'citation', 'logic', 'method', 'other'];
const PAPER_SOURCES = ['arxiv', 'mission', 'upload'];
const STATUSES = ['received', 'reviewing', 'judged', 'invalid', 'withdrawn'];
const PATCH_STATUSES = ['received', 'reviewing', 'judged', 'invalid'];
const OUTCOMES = ['missed', 'caught', 'partial', 'invalid'];
const MISSION_COURSES = ['quick', 'deep', 'any'];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SUBMIT_KEYS = ['jobId', 'course', 'declared', 'paper', 'nickname', 'consentVersion'];
const SUBMIT_REQUIRED = ['jobId', 'course', 'declared', 'consentVersion'];
const DECLARED_KEYS = ['pageIndex', 'segmentId', 'before', 'after', 'defectType', 'reason'];
const DECLARED_REQUIRED = ['pageIndex', 'before', 'after', 'defectType', 'reason'];
const CLAIM_KEYS = ['receipt', 'claimKey'];
const PATCH_KEYS = ['status', 'outcome', 'operatorNote', 'publicNote', 'prizeMessage', 'aiSummary', 'published'];
const SETTINGS_KEYS = ['submissionsOpen', 'missions', 'announcement'];
const MISSION_KEYS = ['id', 'title', 'source', 'paperId', 'license', 'course', 'hint'];
const MAX_JSON_BYTES = 64 * 1024;
const SUMMARY_MAX_BYTES = 16 * 1024;
const CLAIM_PREFIX = 'booth-claim:v1:';
// Claim and withdraw share one bucket so the two key checks cannot double the guess rate.
const CLAIM_BUCKET_PREFIX = 'booth-claim:ip:';
const SUBMIT_BUCKET_PREFIX = 'booth-submit:ip:';
const SUBMIT_GLOBAL_BUCKET = 'booth-submit:all';

const COURSE_VIEW = [
  { id: 'quick', label: '빠른 코스' },
  { id: 'deep', label: '정밀 코스' },
];
const DEFECT_VIEW = [
  { id: 'number', label: '수치·통계' },
  { id: 'figure', label: '그림·표' },
  { id: 'citation', label: '인용·출처' },
  { id: 'logic', label: '논리·결론' },
  { id: 'method', label: '방법·실험 설계' },
  { id: 'other', label: '기타' },
];

const MESSAGES = {
  invalid_request: 'The request is not valid for this endpoint.',
  unauthorized: 'A valid Falsify session is required.',
  forbidden: 'This action is not allowed.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  payload_too_large: 'The request body exceeds the hosted limit.',
  unsupported_media_type: 'The request type is not supported.',
  rate_limited: 'Too many booth requests; retry later.',
  booth_closed: 'Booth submissions are closed.',
  consent_outdated: 'The consent version is out of date.',
  job_not_ready: 'The job is not ready for submission.',
  already_submitted: 'This job was already submitted.',
  pii_not_allowed: 'The nickname looks like contact information.',
  artifact_expired: 'The edited PDF is no longer available.',
  withdrawn: 'A withdrawn submission cannot be changed that way.',
  ai_unavailable: 'Hosted AI execution is temporarily unavailable.',
  internal_error: 'Internal error.',
};
const RETRYABLE = new Set(['rate_limited', 'ai_unavailable', 'internal_error']);

const ADMIN_SELECT = `id, seq, receipt, status, course, nickname, declared, paper, job_id, artifact_id,
  outcome, operator_note, public_note, prize_message, ai_summary, published_at, created_at, updated_at`;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const chars = value => [...value].length;
const CONTROL = /[\u0000-\u001f\u007f]/;
const nowIso = () => new Date().toISOString();

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function boothEnabled(env) {
  return env?.BOOTH_ENABLED === true || env?.BOOTH_ENABLED === 'true';
}

// Unset stays open. Only an explicit false closes submissions when no settings row is stored.
function envSubmissionsOpen(value) {
  if (value === false || value === 'false') return false;
  return true;
}

function consentVersionOf(env) {
  const raw = env?.BOOTH_CONSENT_VERSION;
  return typeof raw === 'string' && raw.length ? raw : '2026-11-22.v1';
}

function boothLimits(env) {
  return {
    perOwner: positiveInt(env?.BOOTH_SUBMISSIONS_PER_OWNER, 5),
    perIpHour: positiveInt(env?.BOOTH_SUBMISSIONS_PER_IP_HOUR, 60),
    perHour: positiveInt(env?.BOOTH_SUBMISSIONS_PER_HOUR, 600),
    claimsPerIpHour: positiveInt(env?.BOOTH_CLAIMS_PER_IP_HOUR, 120),
  };
}

function boothFail(status, code, options = {}) {
  const error = new AiError(status, code, options.headers || {});
  if (options.extra) error.extra = options.extra;
  throw error;
}

function keysOk(value, allowed, required) {
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key))) return false;
  return required.every(key => Object.hasOwn(value, key));
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

function toAiError(error) {
  if (error instanceof AiError) return error;
  const code = error?.code;
  if (code === 'rate_limited') return new AiError(429, 'rate_limited', error.headers || {});
  if (code === 'unauthorized') return new AiError(401, 'unauthorized');
  if (code === 'payload_too_large') return new AiError(413, 'payload_too_large');
  if (code === 'not_configured') return new AiError(503, 'ai_unavailable');
  return new AiError(500, 'internal_error');
}

function errorResponse(error, requestId) {
  const code = MESSAGES[error.code] ? error.code : 'internal_error';
  const status = code === error.code ? (error.status || 500) : 500;
  const body = {
    error: {
      code,
      message: MESSAGES[code],
      requestId,
      retryable: RETRYABLE.has(code),
    },
  };
  if (code === 'already_submitted' && error.extra?.receipt) body.receipt = error.extra.receipt;
  return json(status, body, error.headers || {});
}

function hashesEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length || left.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

// Uppercase, drop dashes and spaces, then map the letters Crockford treats as digits.
function normalizeClaimKey(input) {
  if (typeof input !== 'string') return '';
  return input.toUpperCase().replace(/[ -]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

function claimKey() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const byte of bytes) raw += CROCKFORD[byte & 31];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function formatReceipt(seq) {
  return `F-${String(seq).padStart(4, '0')}`;
}

async function bucketKey(prefix, value) {
  return prefix + (await sha256Hex('falsify-rate:' + prefix + value)).slice(0, 24);
}

function clientIp(ctx) {
  const value = typeof ctx.deps?.clientIp === 'function' ? ctx.deps.clientIp() : '';
  return typeof value === 'string' && value ? value : 'unknown';
}

async function readBoundedBytes(request, max) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null) {
    const text = declared.trim();
    if (!/^[0-9]{1,12}$/.test(text)) boothFail(400, 'invalid_request');
    if (Number(text) > max) boothFail(413, 'payload_too_large');
  }
  if (!request.body) boothFail(400, 'invalid_request');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        boothFail(413, 'payload_too_large');
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

async function readJsonBody(request, max = MAX_JSON_BYTES) {
  const type = (request.headers.get('Content-Type') || '').trim();
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(type)) boothFail(415, 'unsupported_media_type');
  const bytes = await readBoundedBytes(request, max);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    boothFail(400, 'invalid_request');
  }
  if (!isObject(parsed)) boothFail(400, 'invalid_request');
  return parsed;
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function resolveOwner(ctx) {
  return resolveAiOwner({
    request: ctx.request,
    env: ctx.env,
    authenticatePassword: ctx.deps.authenticatePassword,
    getDb: ctx.deps.getDb,
    fetchImpl: ctx.fetchImpl || ctx.deps.fetchImpl,
  });
}

async function requireOperator(ctx) {
  const owner = await resolveOwner(ctx);
  if (owner.kind !== 'operator') boothFail(403, 'forbidden');
  return owner;
}

async function requireVisitor(ctx) {
  const owner = await resolveOwner(ctx);
  // The operator judges submissions. They do not file one.
  if (owner.kind === 'operator') boothFail(403, 'forbidden');
  return owner;
}

async function settingsMap(db) {
  const listed = await db.prepare('SELECT key, value FROM booth_settings').all();
  const map = new Map();
  for (const row of listed.results || []) map.set(row.key, row.value);
  return map;
}

function submissionsOpenFrom(map, env) {
  if (!map.has('submissions_open')) return envSubmissionsOpen(env?.BOOTH_SUBMISSIONS_OPEN);
  return map.get('submissions_open') === 'true';
}

function missionsFrom(map) {
  if (!map.has('missions')) return [];
  const parsed = parseJsonValue(map.get('missions'));
  return Array.isArray(parsed) ? parsed : [];
}

function announcementFrom(map) {
  if (!map.has('announcement')) return null;
  const value = map.get('announcement');
  return typeof value === 'string' ? value : null;
}

function publicSettings(map, env) {
  return {
    submissionsOpen: submissionsOpenFrom(map, env),
    missions: missionsFrom(map),
    announcement: announcementFrom(map),
  };
}

function configView(settings, env) {
  return {
    enabled: true,
    submissionsOpen: settings.submissionsOpen,
    consentVersion: consentVersionOf(env),
    courses: COURSE_VIEW.map(item => ({ ...item })),
    defectTypes: DEFECT_VIEW.map(item => ({ ...item })),
    limits: { maxDeclared: 5, maxReason: 500, maxNickname: 24 },
    missions: settings.missions,
    announcement: settings.announcement,
  };
}

function parseDeclaredItem(item) {
  if (!isObject(item) || !keysOk(item, DECLARED_KEYS, DECLARED_REQUIRED)) boothFail(400, 'invalid_request');
  if (!Number.isSafeInteger(item.pageIndex) || item.pageIndex < 0 || item.pageIndex > 9999) boothFail(400, 'invalid_request');
  if (typeof item.before !== 'string' || chars(item.before) < 1 || chars(item.before) > 2000) boothFail(400, 'invalid_request');
  if (typeof item.after !== 'string' || chars(item.after) > 2000) boothFail(400, 'invalid_request');
  if (!DEFECTS.includes(item.defectType)) boothFail(400, 'invalid_request');
  if (typeof item.reason !== 'string' || chars(item.reason) < 1 || chars(item.reason) > 500) boothFail(400, 'invalid_request');
  const out = {
    pageIndex: item.pageIndex,
    before: item.before,
    after: item.after,
    defectType: item.defectType,
    reason: item.reason,
  };
  if (Object.hasOwn(item, 'segmentId')) {
    if (typeof item.segmentId !== 'string' || chars(item.segmentId) < 1 || chars(item.segmentId) > 120) {
      boothFail(400, 'invalid_request');
    }
    out.segmentId = item.segmentId;
  }
  return out;
}

function parseDeclared(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) boothFail(400, 'invalid_request');
  return value.map(parseDeclaredItem);
}

function parsePaper(value) {
  if (value === undefined) return null;
  if (!isObject(value) || !keysOk(value, ['source', 'id', 'title', 'license'], ['source', 'id', 'title', 'license'])) {
    boothFail(400, 'invalid_request');
  }
  if (!PAPER_SOURCES.includes(value.source)) boothFail(400, 'invalid_request');
  if (typeof value.id !== 'string' || chars(value.id) < 1 || chars(value.id) > 64) boothFail(400, 'invalid_request');
  if (typeof value.title !== 'string' || chars(value.title) > 300) boothFail(400, 'invalid_request');
  if (typeof value.license !== 'string' || chars(value.license) > 40) boothFail(400, 'invalid_request');
  return { source: value.source, id: value.id, title: value.title, license: value.license };
}

function parseNickname(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || chars(value) < 1 || chars(value) > 24 || CONTROL.test(value)) {
    boothFail(400, 'invalid_request');
  }
  if (value.includes('@') || /\d{7,}/.test(value)) boothFail(400, 'pii_not_allowed');
  return value;
}

function parseSubmission(body) {
  if (!keysOk(body, SUBMIT_KEYS, SUBMIT_REQUIRED)) boothFail(400, 'invalid_request');
  if (typeof body.jobId !== 'string' || !UUID.test(body.jobId)) boothFail(400, 'invalid_request');
  if (!COURSES.includes(body.course)) boothFail(400, 'invalid_request');
  if (typeof body.consentVersion !== 'string') boothFail(400, 'invalid_request');
  return {
    jobId: body.jobId,
    course: body.course,
    declared: parseDeclared(body.declared),
    paper: parsePaper(body.paper),
    nickname: parseNickname(body.nickname),
    consentVersion: body.consentVersion,
  };
}

function parseMission(item) {
  if (!isObject(item) || !keysOk(item, MISSION_KEYS, MISSION_KEYS)) boothFail(400, 'invalid_request');
  if (typeof item.id !== 'string' || item.id.length > 40 || !SLUG.test(item.id)) boothFail(400, 'invalid_request');
  if (typeof item.title !== 'string' || chars(item.title) < 1 || chars(item.title) > 300) boothFail(400, 'invalid_request');
  if (item.source !== 'arxiv') boothFail(400, 'invalid_request');
  if (typeof item.paperId !== 'string' || chars(item.paperId) < 1 || chars(item.paperId) > 64) boothFail(400, 'invalid_request');
  if (typeof item.license !== 'string' || chars(item.license) < 1 || chars(item.license) > 40) boothFail(400, 'invalid_request');
  if (!MISSION_COURSES.includes(item.course)) boothFail(400, 'invalid_request');
  if (typeof item.hint !== 'string' || chars(item.hint) > 300) boothFail(400, 'invalid_request');
  return {
    id: item.id,
    title: item.title,
    source: 'arxiv',
    paperId: item.paperId,
    license: item.license,
    course: item.course,
    hint: item.hint,
  };
}

function parseAnnouncement(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || chars(value) > 300) boothFail(400, 'invalid_request');
  return value;
}

function parseSettingsBody(body) {
  if (!keysOk(body, SETTINGS_KEYS, [])) boothFail(400, 'invalid_request');
  const out = {};
  if (Object.hasOwn(body, 'submissionsOpen')) {
    if (typeof body.submissionsOpen !== 'boolean') boothFail(400, 'invalid_request');
    out.submissionsOpen = body.submissionsOpen;
  }
  if (Object.hasOwn(body, 'missions')) {
    if (!Array.isArray(body.missions) || body.missions.length > 20) boothFail(400, 'invalid_request');
    out.missions = body.missions.map(parseMission);
  }
  if (Object.hasOwn(body, 'announcement')) out.announcement = parseAnnouncement(body.announcement);
  return out;
}

function noteText(value, max) {
  if (typeof value !== 'string' || chars(value) > max) boothFail(400, 'invalid_request');
  return value;
}

function parsePatch(body) {
  if (!keysOk(body, PATCH_KEYS, [])) boothFail(400, 'invalid_request');
  const out = {};
  if (Object.hasOwn(body, 'status')) {
    if (!PATCH_STATUSES.includes(body.status)) boothFail(400, 'invalid_request');
    out.status = body.status;
  }
  if (Object.hasOwn(body, 'outcome')) {
    if (body.outcome !== null && !OUTCOMES.includes(body.outcome)) boothFail(400, 'invalid_request');
    out.outcome = body.outcome;
  }
  if (Object.hasOwn(body, 'operatorNote')) out.operatorNote = noteText(body.operatorNote, 2000);
  if (Object.hasOwn(body, 'publicNote')) out.publicNote = noteText(body.publicNote, 1000);
  if (Object.hasOwn(body, 'prizeMessage')) out.prizeMessage = noteText(body.prizeMessage, 500);
  if (Object.hasOwn(body, 'aiSummary')) {
    if (!isObject(body.aiSummary)) boothFail(400, 'invalid_request');
    if (new TextEncoder().encode(JSON.stringify(body.aiSummary)).byteLength > SUMMARY_MAX_BYTES) {
      boothFail(400, 'invalid_request');
    }
    out.aiSummary = body.aiSummary;
  }
  if (Object.hasOwn(body, 'published')) {
    if (typeof body.published !== 'boolean') boothFail(400, 'invalid_request');
    out.published = body.published;
  }
  return out;
}

function editedPdf(artifacts) {
  if (!Array.isArray(artifacts)) return null;
  for (const item of artifacts) {
    if (!isObject(item) || item.name !== 'edited.pdf') continue;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 128) continue;
    return item.id;
  }
  return null;
}

function snapshotOf(row) {
  const parsed = parseJsonValue(row?.snapshot);
  return isObject(parsed) ? parsed : {};
}

async function artifactFromRuntime(env, ownerId, jobId) {
  try {
    const runtime = await getRuntimeJob(env, { ownerId, jobId });
    return editedPdf(runtime?.artifacts);
  } catch (error) {
    if (error instanceof AiError && error.code === 'not_found') return null;
    throw error;
  }
}

// Role, applyOnly and state come from the stored row. A snapshot with no artifact list is the
// only case that may call the runtime, and it does so once, as the caller.
async function readyArtifact(ctx, ownerId, row) {
  const snapshot = snapshotOf(row);
  if (row.role !== 'red' || snapshot.applyOnly !== true || row.state !== 'completed') {
    boothFail(409, 'job_not_ready');
  }
  const stored = editedPdf(snapshot.artifacts);
  if (stored) return stored;
  const missingList = !Array.isArray(snapshot.artifacts) || snapshot.artifacts.length === 0;
  if (!missingList) boothFail(409, 'job_not_ready');
  const live = await artifactFromRuntime(ctx.env, ownerId, row.id);
  if (!live) boothFail(409, 'job_not_ready');
  return live;
}

function isUniqueError(error) {
  const text = `${error?.message || ''} ${error?.cause?.message || ''}`;
  return /UNIQUE constraint failed/i.test(text);
}

const INSERT_SQL = `INSERT INTO booth_submissions (
  id, seq, receipt, claim_hash, owner_id, job_id, artifact_id, course, nickname,
  declared, paper, consent_version, status, created_at, updated_at
) SELECT ?1, next.seq, next.receipt, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'received', ?11, ?11
FROM (
  SELECT COALESCE(MAX(seq), 0) + 1 AS seq,
         'F-' || printf('%04d', COALESCE(MAX(seq), 0) + 1) AS receipt
  FROM booth_submissions
) AS next
WHERE next.seq = ?12`;

async function insertSubmission(db, fields) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const preview = await db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM booth_submissions').first();
    const seq = Number(preview?.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) boothFail(500, 'internal_error');
    const receipt = formatReceipt(seq);
    const claimHash = await sha256Hex(`${CLAIM_PREFIX}${receipt}:${fields.normalizedKey}`);
    try {
      const result = await db.prepare(INSERT_SQL).bind(
        fields.id,
        claimHash,
        fields.ownerId,
        fields.jobId,
        fields.artifactId,
        fields.course,
        fields.nickname,
        JSON.stringify(fields.declared),
        fields.paper ? JSON.stringify(fields.paper) : null,
        fields.consentVersion,
        fields.createdAt,
        seq,
      ).run();
      if (Number(result?.meta?.changes) !== 1) continue;
      const stored = await db.prepare('SELECT receipt, created_at FROM booth_submissions WHERE id = ?1').bind(fields.id).first();
      if (!stored || stored.receipt !== receipt) {
        await db.prepare('DELETE FROM booth_submissions WHERE id = ?1').bind(fields.id).run();
        continue;
      }
      return { receipt: stored.receipt, createdAt: stored.created_at };
    } catch (error) {
      if (error instanceof AiError) throw error;
      const existing = await db.prepare('SELECT receipt FROM booth_submissions WHERE job_id = ?1').bind(fields.jobId).first();
      if (existing?.receipt) boothFail(409, 'already_submitted', { extra: { receipt: existing.receipt } });
      if (attempt === 1 || !isUniqueError(error)) throw error;
    }
  }
  boothFail(500, 'internal_error');
}

async function chargeSubmission(ctx, limits) {
  const db = ctx.deps.getDb();
  const ipBucket = await bucketKey(SUBMIT_BUCKET_PREFIX, clientIp(ctx));
  const ipSlot = await ctx.deps.rateLimit(db, ipBucket, limits.perIpHour);
  try {
    const globalSlot = await ctx.deps.rateLimit(db, SUBMIT_GLOBAL_BUCKET, limits.perHour);
    return { ipBucket, ipSlot, globalSlot };
  } catch (error) {
    await ctx.deps.releaseSlot(db, ipBucket, ipSlot);
    throw error;
  }
}

async function releaseSubmission(ctx, charged) {
  if (!charged) return;
  const db = ctx.deps.getDb();
  await ctx.deps.releaseSlot(db, charged.ipBucket, charged.ipSlot);
  await ctx.deps.releaseSlot(db, SUBMIT_GLOBAL_BUCKET, charged.globalSlot);
}

async function chargeClaim(ctx) {
  const db = ctx.deps.getDb();
  const bucket = await bucketKey(CLAIM_BUCKET_PREFIX, clientIp(ctx));
  await ctx.deps.rateLimit(db, bucket, boothLimits(ctx.env).claimsPerIpHour);
}

function claimView(row) {
  const declared = parseJsonValue(row.declared);
  const published = row.published_at != null;
  const view = {
    receipt: row.receipt,
    status: row.status,
    course: row.course,
    declaredCount: Array.isArray(declared) ? declared.length : 0,
    createdAt: row.created_at,
    published,
  };
  if (published) {
    view.outcome = row.outcome ?? null;
    view.publicNote = row.public_note ?? null;
    view.prizeMessage = row.prize_message ?? null;
    view.publishedAt = row.published_at;
  }
  return view;
}

const CLAIM_SELECT = `id, receipt, status, course, declared, created_at, published_at, outcome, public_note, prize_message`;

async function loadClaim(db, receipt, claimKey) {
  if (!RECEIPT.test(receipt)) boothFail(404, 'not_found');
  const row = await db.prepare(`SELECT ${CLAIM_SELECT}, claim_hash FROM booth_submissions WHERE receipt = ?1`).bind(receipt).first();
  const normalized = normalizeClaimKey(claimKey);
  const got = await sha256Hex(`${CLAIM_PREFIX}${receipt}:${normalized}`);
  const expected = typeof row?.claim_hash === 'string' && /^[a-f0-9]{64}$/.test(row.claim_hash)
    ? row.claim_hash
    : '0'.repeat(64);
  const presented = /^[a-f0-9]{64}$/.test(got) ? got : '1'.repeat(64);
  if (!row || !hashesEqual(expected, presented)) boothFail(404, 'not_found');
  return row;
}

async function readClaimBody(ctx) {
  const body = await readJsonBody(ctx.request, 4096);
  if (!keysOk(body, CLAIM_KEYS, CLAIM_KEYS)) boothFail(400, 'invalid_request');
  if (typeof body.receipt !== 'string' || typeof body.claimKey !== 'string') boothFail(400, 'invalid_request');
  await chargeClaim(ctx);
  return body;
}

function adminView(row) {
  const declared = parseJsonValue(row.declared);
  const paper = parseJsonValue(row.paper);
  const summary = parseJsonValue(row.ai_summary);
  return {
    id: row.id,
    seq: Number(row.seq),
    receipt: row.receipt,
    status: row.status,
    course: row.course,
    nickname: row.nickname ?? null,
    declared: Array.isArray(declared) ? declared : [],
    paper: isObject(paper) ? paper : null,
    jobId: row.job_id,
    artifactId: row.artifact_id,
    outcome: row.outcome ?? null,
    operatorNote: row.operator_note ?? null,
    publicNote: row.public_note ?? null,
    prizeMessage: row.prize_message ?? null,
    aiSummary: isObject(summary) ? summary : null,
    published: row.published_at != null,
    publishedAt: row.published_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function adminRow(db, receipt) {
  if (typeof receipt !== 'string' || !RECEIPT.test(receipt)) boothFail(404, 'not_found');
  const row = await db.prepare(`SELECT ${ADMIN_SELECT} FROM booth_submissions WHERE receipt = ?1`).bind(receipt).first();
  if (!row) boothFail(404, 'not_found');
  return row;
}

function readLimit(url) {
  const raw = url.searchParams.get('limit');
  if (raw === null) return 100;
  if (!/^[0-9]+$/.test(raw)) boothFail(400, 'invalid_request');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > 200) boothFail(400, 'invalid_request');
  return n;
}

function readAfter(url) {
  const raw = url.searchParams.get('after');
  if (raw === null) return 0;
  if (!/^[0-9]+$/.test(raw)) boothFail(400, 'invalid_request');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) boothFail(400, 'invalid_request');
  return n;
}

function readStatuses(url) {
  const raw = url.searchParams.get('status');
  if (raw === null) return [];
  const items = raw.split(',').map(item => item.trim()).filter(Boolean);
  if (!items.length || items.some(item => !STATUSES.includes(item))) boothFail(400, 'invalid_request');
  return [...new Set(items)];
}

async function getConfig(ctx) {
  const settings = publicSettings(await settingsMap(ctx.deps.getDb()), ctx.env);
  return json(200, configView(settings, ctx.env));
}

async function postSubmission(ctx) {
  const owner = await requireVisitor(ctx);
  const submission = parseSubmission(await readJsonBody(ctx.request));
  const db = ctx.deps.getDb();
  const settings = publicSettings(await settingsMap(db), ctx.env);
  if (!settings.submissionsOpen) boothFail(403, 'booth_closed');
  if (submission.consentVersion !== consentVersionOf(ctx.env)) boothFail(409, 'consent_outdated');
  const job = await db.prepare(
    'SELECT id, role, state, snapshot FROM ai_jobs WHERE id = ?1 AND owner_id = ?2'
  ).bind(submission.jobId, owner.ownerId).first();
  if (!job) boothFail(404, 'not_found');
  const artifactId = await readyArtifact(ctx, owner.ownerId, job);
  const duplicate = await db.prepare('SELECT receipt FROM booth_submissions WHERE job_id = ?1').bind(submission.jobId).first();
  if (duplicate?.receipt) boothFail(409, 'already_submitted', { extra: { receipt: duplicate.receipt } });
  const limits = boothLimits(ctx.env);
  const owned = await db.prepare('SELECT COUNT(*) AS count FROM booth_submissions WHERE owner_id = ?1').bind(owner.ownerId).first();
  if (Number(owned?.count ?? 0) >= limits.perOwner) boothFail(429, 'rate_limited');
  const charged = await chargeSubmission(ctx, limits);
  try {
    const createdAt = nowIso();
    const displayKey = claimKey();
    const stored = await insertSubmission(db, {
      id: crypto.randomUUID(),
      ownerId: owner.ownerId,
      jobId: submission.jobId,
      artifactId,
      course: submission.course,
      nickname: submission.nickname,
      declared: submission.declared,
      paper: submission.paper,
      consentVersion: submission.consentVersion,
      normalizedKey: normalizeClaimKey(displayKey),
      createdAt,
    });
    return json(201, {
      receipt: stored.receipt,
      claimKey: displayKey,
      status: 'received',
      course: submission.course,
      declaredCount: submission.declared.length,
      createdAt: stored.createdAt,
    });
  } catch (error) {
    await releaseSubmission(ctx, charged);
    throw error;
  }
}

async function postClaim(ctx) {
  const body = await readClaimBody(ctx);
  const row = await loadClaim(ctx.deps.getDb(), body.receipt, body.claimKey);
  return json(200, claimView(row));
}

async function postWithdraw(ctx) {
  const body = await readClaimBody(ctx);
  const db = ctx.deps.getDb();
  const row = await loadClaim(db, body.receipt, body.claimKey);
  const at = nowIso();
  await db.prepare(
    `UPDATE booth_submissions
     SET status = 'withdrawn', prize_message = NULL, published_at = NULL, updated_at = ?2
     WHERE id = ?1`
  ).bind(row.id, at).run();
  const fresh = await db.prepare(`SELECT ${CLAIM_SELECT} FROM booth_submissions WHERE id = ?1`).bind(row.id).first();
  return json(200, claimView(fresh));
}

async function listAdmin(ctx) {
  await requireOperator(ctx);
  const statuses = readStatuses(ctx.url);
  const after = readAfter(ctx.url);
  const limit = readLimit(ctx.url);
  const binds = [after];
  const where = ['seq > ?1'];
  if (statuses.length) {
    const marks = statuses.map((_, index) => `?${index + 2}`);
    where.push(`status IN (${marks.join(', ')})`);
    binds.push(...statuses);
  }
  binds.push(limit + 1);
  const sql = `SELECT ${ADMIN_SELECT} FROM booth_submissions WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?${binds.length}`;
  const listed = await ctx.deps.getDb().prepare(sql).bind(...binds).all();
  const rows = listed.results || [];
  const page = rows.slice(0, limit).map(adminView);
  const nextAfter = rows.length > limit ? page[page.length - 1].seq : null;
  return json(200, { submissions: page, nextAfter });
}

async function getAdmin(ctx) {
  await requireOperator(ctx);
  return json(200, adminView(await adminRow(ctx.deps.getDb(), ctx.match.params.receipt)));
}

async function patchAdmin(ctx) {
  await requireOperator(ctx);
  const patch = parsePatch(await readJsonBody(ctx.request));
  const db = ctx.deps.getDb();
  const row = await adminRow(db, ctx.match.params.receipt);
  if (row.status === 'withdrawn' && Object.keys(patch).some(key => key !== 'operatorNote')) {
    boothFail(409, 'withdrawn');
  }
  const sets = [];
  const binds = [];
  const set = (column, value) => {
    binds.push(value);
    sets.push(`${column} = ?${binds.length}`);
  };
  if (Object.hasOwn(patch, 'status')) set('status', patch.status);
  if (Object.hasOwn(patch, 'outcome')) {
    if (patch.outcome === null) sets.push('outcome = NULL');
    else set('outcome', patch.outcome);
  }
  if (Object.hasOwn(patch, 'operatorNote')) set('operator_note', patch.operatorNote);
  if (Object.hasOwn(patch, 'publicNote')) set('public_note', patch.publicNote);
  if (Object.hasOwn(patch, 'prizeMessage')) set('prize_message', patch.prizeMessage);
  if (Object.hasOwn(patch, 'aiSummary')) set('ai_summary', JSON.stringify(patch.aiSummary));
  if (Object.hasOwn(patch, 'published')) {
    if (patch.published) {
      binds.push(nowIso());
      sets.push(`published_at = COALESCE(published_at, ?${binds.length})`);
    } else sets.push('published_at = NULL');
  }
  if (sets.length) {
    binds.push(nowIso());
    sets.push(`updated_at = ?${binds.length}`);
    binds.push(row.id);
    await db.prepare(`UPDATE booth_submissions SET ${sets.join(', ')} WHERE id = ?${binds.length}`).bind(...binds).run();
  }
  return json(200, adminView(await adminRow(db, row.receipt)));
}

async function deleteAdmin(ctx) {
  await requireOperator(ctx);
  const db = ctx.deps.getDb();
  const row = await adminRow(db, ctx.match.params.receipt);
  await db.prepare('DELETE FROM booth_submissions WHERE id = ?1').bind(row.id).run();
  return json(204, null);
}

async function getAdminPdf(ctx) {
  await requireOperator(ctx);
  const receipt = ctx.match?.params?.receipt;
  if (typeof receipt !== 'string' || !RECEIPT.test(receipt)) boothFail(404, 'not_found');
  // owner_id stays out of AdminView. The PDF proxy is the one reader, and it forwards that stored owner.
  const row = await ctx.deps.getDb().prepare(
    'SELECT owner_id, job_id, artifact_id, receipt FROM booth_submissions WHERE receipt = ?1'
  ).bind(receipt).first();
  if (!row) boothFail(404, 'not_found');
  let response;
  try {
    response = await getRuntimeArtifact(ctx.env, {
      ownerId: row.owner_id,
      jobId: row.job_id,
      artifactId: row.artifact_id,
    });
  } catch (error) {
    if (error instanceof AiError && error.code === 'not_found') boothFail(404, 'artifact_expired');
    throw error;
  }
  return new Response(response.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${row.receipt}.pdf"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function getSettings(ctx) {
  await requireOperator(ctx);
  return json(200, publicSettings(await settingsMap(ctx.deps.getDb()), ctx.env));
}

async function writeSetting(db, key, value, at) {
  await db.prepare(
    `INSERT INTO booth_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, at).run();
}

async function putSettings(ctx) {
  await requireOperator(ctx);
  const patch = parseSettingsBody(await readJsonBody(ctx.request));
  const db = ctx.deps.getDb();
  const at = nowIso();
  if (Object.hasOwn(patch, 'submissionsOpen')) {
    await writeSetting(db, 'submissions_open', patch.submissionsOpen ? 'true' : 'false', at);
  }
  if (Object.hasOwn(patch, 'missions')) await writeSetting(db, 'missions', JSON.stringify(patch.missions), at);
  if (Object.hasOwn(patch, 'announcement')) {
    if (patch.announcement === null) await db.prepare('DELETE FROM booth_settings WHERE key = ?1').bind('announcement').run();
    else await writeSetting(db, 'announcement', patch.announcement, at);
  }
  return json(200, publicSettings(await settingsMap(db), ctx.env));
}

const ROUTES = {
  '/v1/booth/config': { GET: getConfig },
  '/v1/booth/submissions': { POST: postSubmission },
  '/v1/booth/claim': { POST: postClaim },
  '/v1/booth/withdraw': { POST: postWithdraw },
  '/v1/booth/admin/submissions': { GET: listAdmin },
  '/v1/booth/admin/submissions/:receipt': { GET: getAdmin, PATCH: patchAdmin, DELETE: deleteAdmin },
  '/v1/booth/admin/submissions/:receipt/pdf': { GET: getAdminPdf },
  '/v1/booth/admin/settings': { GET: getSettings, PUT: putSettings },
};

function hit(template, params = {}) {
  return { template, params };
}

function pathSegment(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function matchBooth(pathname) {
  if (pathname !== '/v1/booth' && !pathname.startsWith('/v1/booth/')) return null;
  if (pathname === '/v1/booth/config') return hit('/v1/booth/config');
  if (pathname === '/v1/booth/submissions') return hit('/v1/booth/submissions');
  if (pathname === '/v1/booth/claim') return hit('/v1/booth/claim');
  if (pathname === '/v1/booth/withdraw') return hit('/v1/booth/withdraw');
  if (pathname === '/v1/booth/admin/submissions') return hit('/v1/booth/admin/submissions');
  if (pathname === '/v1/booth/admin/settings') return hit('/v1/booth/admin/settings');
  const pdf = /^\/v1\/booth\/admin\/submissions\/([^/]+)\/pdf$/.exec(pathname);
  if (pdf) return hit('/v1/booth/admin/submissions/:receipt/pdf', { receipt: pathSegment(pdf[1]) });
  const one = /^\/v1\/booth\/admin\/submissions\/([^/]+)$/.exec(pathname);
  if (one) return hit('/v1/booth/admin/submissions/:receipt', { receipt: pathSegment(one[1]) });
  return hit('/v1/booth/unknown');
}

export async function handleBoothRequest(ctx) {
  const requestId = newRequestId();
  try {
    if (!boothEnabled(ctx.env)) return errorResponse(new AiError(404, 'not_found'), requestId);
    if (ctx.request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    const route = ROUTES[ctx.match?.template];
    if (!route) return errorResponse(new AiError(404, 'not_found'), requestId);
    const handler = route[ctx.request.method];
    if (!handler) {
      return errorResponse(new AiError(405, 'method_not_allowed', { Allow: Object.keys(route).join(', ') }), requestId);
    }
    return await handler({ ...ctx, requestId });
  } catch (error) {
    const known = toAiError(error);
    if (!(error instanceof AiError) && known.code === 'internal_error') {
      console.error(JSON.stringify({
        event: 'unhandled_booth_error',
        route: ctx.match?.template || 'unknown',
        name: error?.name || 'unknown',
      }));
    }
    return errorResponse(known, requestId);
  }
}
