// Booth submissions (contract docs/booth-contract-20261120.md sections 5, 11 and 12).
// Visitors submit an edited PDF. The claim key is returned once.
// owner_id and claim_hash are never returned. No IP, user agent or token is stored here.
// These routes do not call the runtime.
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { SESSION_HEADER } from './confluence.mjs';
import { AiError, resolveAiOwner, sha256Hex } from './ai-identity.mjs';

const RECEIPT = /^F-\d{4,}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const COURSES = ['quick', 'deep'];
const DEFECTS = ['number', 'figure', 'citation', 'logic', 'method', 'other'];
const PAPER_SOURCES = ['arxiv', 'mission'];
const PAPER_LICENSE = /^(?:cc-by(?:-sa)?(?:-\d+\.\d+)?|cc0(?:-1\.0)?|public-domain)$/;
const STATUSES = ['received', 'reviewing', 'judged', 'invalid', 'withdrawn'];
const PATCH_STATUSES = ['received', 'reviewing', 'judged', 'invalid'];
const OUTCOMES = ['missed', 'caught', 'partial', 'invalid'];
const MISSION_COURSES = ['quick', 'deep', 'any'];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SUBMIT_KEYS = ['course', 'declared', 'paper', 'nickname', 'consentVersion', 'editedSha256'];
const SUBMIT_REQUIRED = ['course', 'declared', 'consentVersion', 'editedSha256'];
const PAPER_KEYS = ['source', 'id', 'title', 'license', 'sourceSha256'];
const PAPER_REQUIRED = ['source', 'id', 'title', 'license', 'sourceSha256'];
const DECLARED_KEYS = ['pageIndex', 'segmentId', 'before', 'after', 'defectType', 'reason'];
const DECLARED_REQUIRED = ['pageIndex', 'before', 'after', 'defectType', 'reason'];
const CLAIM_KEYS = ['receipt', 'claimKey'];
const PATCH_KEYS = ['status', 'outcome', 'operatorNote', 'publicNote', 'prizeMessage', 'aiSummary', 'published'];
const SETTINGS_KEYS = ['submissionsOpen', 'missions', 'announcement'];
const MISSION_REQUIRED = ['id', 'title', 'source', 'paperId', 'license', 'course', 'hint'];
const MISSION_KEYS = [...MISSION_REQUIRED, 'pageHint', 'sourceSha256'];
const MAX_JSON_BYTES = 64 * 1024;
const SUMMARY_MAX_BYTES = 16 * 1024;
const MAX_DECLARED = 5;
const MAX_REASON = 500;
const MAX_NICKNAME = 24;
const PDF_CHUNK_BYTES = 512 * 1024;
const PDF_BODY_SLACK = 64 * 1024;
const PDF_HARD_CAP = 32 * 1024 * 1024;
const PDF_DEFAULT_BYTES = 20 * 1024 * 1024;
const STORED_PDF_DEFAULT = 2147483648;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const CLAIM_PREFIX = 'booth-claim:v1:';
// Claim and withdraw share one bucket so the two key checks cannot double the guess rate.
const CLAIM_BUCKET_PREFIX = 'booth-claim:ip:';
const CLAIM_GLOBAL_BUCKET = 'booth-claim:all';
const SUBMIT_BUCKET_PREFIX = 'booth-submit:ip:';
const SUBMIT_GLOBAL_BUCKET = 'booth-submit:all';
const SEQ_ATTEMPTS = 5;

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
  membership_required: 'An active team membership is required.',
  forbidden: 'This action is not allowed.',
  open_access_disabled: 'Open access is not enabled.',
  length_required: 'Content-Length is required.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  payload_too_large: 'The request body exceeds the hosted limit.',
  unsupported_media_type: 'The request type is not supported.',
  rate_limited: 'Too many booth requests; retry later.',
  booth_closed: 'Booth submissions are closed.',
  consent_outdated: 'The consent version is out of date.',
  already_submitted: 'This PDF was already submitted.',
  pii_not_allowed: 'The nickname looks like contact information.',
  paper_not_allowed: 'This paper is not allowed for a booth submission.',
  invalid_pdf: 'The file is not a PDF.',
  pdf_mismatch: 'The PDF does not match the declared hash.',
  pdf_unchanged: 'The PDF is unchanged from the source.',
  storage_full: 'Booth PDF storage is full.',
  withdrawn: 'This submission was withdrawn.',
  ai_unavailable: 'Hosted AI execution is temporarily unavailable.',
  internal_error: 'Internal error.',
};
const RETRYABLE = new Set(['rate_limited', 'ai_unavailable', 'internal_error']);

const ADMIN_SELECT = `id, seq, receipt, status, course, nickname, declared, paper, pdf_sha256, pdf_bytes, source_sha256,
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
    claimsPerHour: positiveInt(env?.BOOTH_CLAIMS_PER_HOUR, 2000),
    storedBytes: positiveInt(env?.BOOTH_STORED_PDF_BYTES, STORED_PDF_DEFAULT),
  };
}

// Unset uses the guest upload default (20 MiB). A larger setting still stops at 32 MiB.
function maxPdfBytes(env) {
  const guestDefault = positiveInt(env?.AI_GUEST_MAX_UPLOAD_BYTES, PDF_DEFAULT_BYTES);
  const resolved = positiveInt(env?.BOOTH_MAX_PDF_BYTES, guestDefault);
  return Math.min(resolved, PDF_HARD_CAP);
}

// Test probe only. Unset in production, and then the header is absent.
function timingHeaders(env, parseMs) {
  if (env?.BOOTH_PARSE_TIMING !== '1' || typeof parseMs !== 'number') return {};
  return { 'X-Falsify-Parse-Ms': parseMs.toFixed(3) };
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
  if (code === 'membership_required') return new AiError(403, 'membership_required');
  if (code === 'open_access_disabled') return new AiError(403, 'open_access_disabled');
  if (code === 'payload_too_large') return new AiError(413, 'payload_too_large');
  if (code === 'not_configured') return new AiError(503, 'ai_unavailable');
  return new AiError(500, 'internal_error');
}

// Retry-After is exposed on every response so a browser can read a 429 wait even without a refreshed session.
const EXPOSE_HEADERS = `${SESSION_HEADER}, Retry-After`;

function withRefreshed(response, refreshed) {
  const headers = new Headers(response.headers);
  if (refreshed) headers.set(SESSION_HEADER, refreshed);
  headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
  return new Response(response.body, { status: response.status, headers });
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

function requireContentLength(request, maxBody) {
  const declared = request.headers.get('Content-Length');
  if (declared === null) boothFail(411, 'length_required');
  const text = declared.trim();
  if (!/^[0-9]{1,12}$/.test(text)) boothFail(400, 'invalid_request');
  if (Number(text) > maxBody) boothFail(413, 'payload_too_large');
}

function isPdfFile(value) {
  if (!value || typeof value === 'string' || typeof value.arrayBuffer !== 'function') return false;
  if (typeof value.name !== 'string' || value.name.length === 0) return false;
  const mime = String(value.type || '').toLowerCase().split(';')[0].trim();
  return mime === 'application/pdf';
}

// Content-Length is checked before the body is read. The PDF stays bytes: one digest, then subarray chunks.
async function readSubmissionParts(request, env) {
  const type = (request.headers.get('Content-Type') || '').trim();
  if (!/^multipart\/form-data\b/i.test(type)) boothFail(415, 'unsupported_media_type');
  requireContentLength(request, maxPdfBytes(env) + PDF_BODY_SLACK);
  let form;
  try {
    form = await request.formData();
  } catch {
    boothFail(400, 'invalid_request');
  }
  const names = [...form.keys()];
  if (names.length !== 2 || new Set(names).size !== 2 || !names.includes('meta') || !names.includes('pdf')) {
    boothFail(400, 'invalid_request');
  }
  const metaValue = form.get('meta');
  const pdfValue = form.get('pdf');
  if (typeof metaValue !== 'string' || !isPdfFile(pdfValue)) boothFail(400, 'invalid_request');
  let meta;
  try {
    meta = JSON.parse(metaValue);
  } catch {
    boothFail(400, 'invalid_request');
  }
  if (!isObject(meta)) boothFail(400, 'invalid_request');
  const pdf = new Uint8Array(await pdfValue.arrayBuffer());
  return { meta, pdf };
}

function startsWithPdf(bytes) {
  if (bytes.byteLength < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

async function sha256Bytes(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function chunkPdf(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += PDF_CHUNK_BYTES) {
    const end = Math.min(offset + PDF_CHUNK_BYTES, bytes.byteLength);
    const copy = new Uint8Array(end - offset);
    copy.set(bytes.subarray(offset, end));
    chunks.push(copy.buffer);
  }
  return chunks;
}

// Miniflare returns a BLOB as a number array. The runtime may return bytes.
function blobBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  boothFail(500, 'internal_error');
}

function reject(ctx, parseMs, status, code, options = {}) {
  boothFail(status, code, {
    ...options,
    headers: { ...timingHeaders(ctx.env, parseMs), ...(options.headers || {}) },
  });
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

function rememberRefresh(ctx, owner) {
  if (owner?.refreshed && ctx.boothState) ctx.boothState.refreshed = owner.refreshed;
  return owner;
}

async function requireOperator(ctx) {
  const owner = rememberRefresh(ctx, await resolveOwner(ctx));
  if (owner.kind !== 'operator') boothFail(403, 'forbidden');
  return owner;
}

async function requireVisitor(ctx) {
  const owner = rememberRefresh(ctx, await resolveOwner(ctx));
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
    limits: {
      maxDeclared: MAX_DECLARED,
      maxReason: MAX_REASON,
      maxNickname: MAX_NICKNAME,
      maxPdfBytes: maxPdfBytes(env),
      perOwner: boothLimits(env).perOwner,
    },
    missions: settings.missions,
    announcement: settings.announcement,
  };
}

function requireChars(value, min, max) {
  if (typeof value !== 'string' || chars(value) < min || chars(value) > max) boothFail(400, 'invalid_request');
  return value;
}

function requirePageIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9999) boothFail(400, 'invalid_request');
}

function copySegmentId(item, out) {
  if (!Object.hasOwn(item, 'segmentId')) return;
  if (typeof item.segmentId !== 'string' || chars(item.segmentId) < 1 || chars(item.segmentId) > 120) {
    boothFail(400, 'invalid_request');
  }
  out.segmentId = item.segmentId;
}

function parseDeclaredItem(item) {
  if (!isObject(item) || !keysOk(item, DECLARED_KEYS, DECLARED_REQUIRED)) boothFail(400, 'invalid_request');
  requirePageIndex(item.pageIndex);
  const before = requireChars(item.before, 1, 2000);
  const after = requireChars(item.after, 0, 2000);
  if (!DEFECTS.includes(item.defectType)) boothFail(400, 'invalid_request');
  const out = {
    pageIndex: item.pageIndex,
    before,
    after,
    defectType: item.defectType,
    reason: requireChars(item.reason, 1, MAX_REASON),
  };
  copySegmentId(item, out);
  return out;
}

function parseDeclared(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DECLARED) boothFail(400, 'invalid_request');
  return value.map(parseDeclaredItem);
}

function parsePaper(value) {
  if (value === undefined || value === null || !isObject(value)) boothFail(400, 'paper_not_allowed');
  if (!keysOk(value, PAPER_KEYS, PAPER_REQUIRED)) boothFail(400, 'invalid_request');
  if (!PAPER_SOURCES.includes(value.source)) boothFail(400, 'paper_not_allowed');
  if (typeof value.license !== 'string' || !PAPER_LICENSE.test(value.license)) boothFail(400, 'paper_not_allowed');
  if (typeof value.id !== 'string' || chars(value.id) < 1 || chars(value.id) > 64) boothFail(400, 'invalid_request');
  if (typeof value.title !== 'string' || chars(value.title) > 300) boothFail(400, 'invalid_request');
  if (typeof value.sourceSha256 !== 'string' || !HEX64.test(value.sourceSha256)) boothFail(400, 'invalid_request');
  const paper = {
    source: value.source,
    id: value.id,
    title: value.title,
    license: value.license,
    sourceSha256: value.sourceSha256,
  };
  return { paper, sourceSha256: value.sourceSha256 };
}

function parseNickname(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || chars(value) < 1 || chars(value) > MAX_NICKNAME || CONTROL.test(value)) {
    boothFail(400, 'invalid_request');
  }
  if (value.includes('@') || /\d{7,}/.test(value)) boothFail(400, 'pii_not_allowed');
  return value;
}

function parseSubmission(body) {
  if (!keysOk(body, SUBMIT_KEYS, SUBMIT_REQUIRED)) boothFail(400, 'invalid_request');
  if (typeof body.editedSha256 !== 'string' || !HEX64.test(body.editedSha256)) boothFail(400, 'invalid_request');
  if (!COURSES.includes(body.course)) boothFail(400, 'invalid_request');
  if (typeof body.consentVersion !== 'string') boothFail(400, 'invalid_request');
  const paper = parsePaper(body.paper);
  return {
    course: body.course,
    declared: parseDeclared(body.declared),
    paper: paper.paper,
    sourceSha256: paper.sourceSha256,
    nickname: parseNickname(body.nickname),
    consentVersion: body.consentVersion,
    editedSha256: body.editedSha256,
  };
}

function requireMissionId(value) {
  if (typeof value !== 'string' || value.length > 40 || !SLUG.test(value)) boothFail(400, 'invalid_request');
  return value;
}

function copyMissionPageHint(item, mission) {
  if (!Object.hasOwn(item, 'pageHint')) return;
  if (!Number.isSafeInteger(item.pageHint) || item.pageHint < 1 || item.pageHint > 9999) boothFail(400, 'invalid_request');
  mission.pageHint = item.pageHint;
}

function copyMissionSourceHash(item, mission) {
  if (!Object.hasOwn(item, 'sourceSha256')) return;
  if (typeof item.sourceSha256 !== 'string' || !HEX64.test(item.sourceSha256)) boothFail(400, 'invalid_request');
  mission.sourceSha256 = item.sourceSha256;
}

function parseMission(item) {
  if (!isObject(item) || !keysOk(item, MISSION_KEYS, MISSION_REQUIRED)) boothFail(400, 'invalid_request');
  const id = requireMissionId(item.id);
  const title = requireChars(item.title, 1, 300);
  if (item.source !== 'arxiv') boothFail(400, 'invalid_request');
  const paperId = requireChars(item.paperId, 1, 64);
  const license = requireChars(item.license, 1, 40);
  if (!MISSION_COURSES.includes(item.course)) boothFail(400, 'invalid_request');
  const mission = {
    id,
    title,
    source: 'arxiv',
    paperId,
    license,
    course: item.course,
    hint: requireChars(item.hint, 0, 300),
  };
  copyMissionPageHint(item, mission);
  copyMissionSourceHash(item, mission);
  return mission;
}

function missionSourceAllowed(missions, submission) {
  if (submission.paper.source !== 'mission') return true;
  const mission = missions.find(item =>
    isObject(item) && (item.id === submission.paper.id || item.paperId === submission.paper.id));
  if (!mission || typeof mission.sourceSha256 !== 'string') return true;
  return hashesEqual(mission.sourceSha256, submission.sourceSha256);
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

function isUniqueError(error) {
  const text = `${error?.message || ''} ${error?.cause?.message || ''}`;
  return /UNIQUE constraint failed/i.test(text);
}

const INSERT_SQL = `INSERT INTO booth_submissions (
  id, seq, receipt, claim_hash, owner_id, pdf_sha256, pdf_bytes, source_sha256, course, nickname,
  declared, paper, consent_version, status, created_at, updated_at
) SELECT ?1, next.seq, next.receipt, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'received', ?12, ?12
FROM (
  SELECT COALESCE(MAX(seq), 0) + 1 AS seq,
         'F-' || printf('%04d', COALESCE(MAX(seq), 0) + 1) AS receipt
  FROM booth_submissions
) AS next
WHERE next.seq = ?13
  AND (
    SELECT COUNT(*) FROM booth_submissions
    WHERE owner_id = ?3 AND status <> 'withdrawn'
  ) < ?14
  AND (
    SELECT COALESCE(SUM(s.pdf_bytes), 0) FROM booth_submissions AS s
    WHERE EXISTS (SELECT 1 FROM booth_files AS f WHERE f.submission_id = s.id)
  ) + ?5 <= ?15`;

const FILE_SQL = `INSERT INTO booth_files (submission_id, idx, data)
SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM booth_submissions WHERE id = ?1)`;

// Test-only. Attempt 0 expects a seq this far ahead, so the WHERE misses and the retry lands the real one.
function seqBias(env, attempt) {
  if (attempt !== 0) return 0;
  const raw = env?.BOOTH_TEST_SEQ_BIAS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

async function discardAttempt(db, id) {
  await db.batch([
    db.prepare('DELETE FROM booth_files WHERE submission_id = ?1').bind(id),
    db.prepare('DELETE FROM booth_submissions WHERE id = ?1').bind(id),
  ]);
}

// Test-only. The handler publishes `waiting`, then blocks until the test sets the same key to `go`.
async function holdTestGate(db, env, flag) {
  if (env?.[flag] !== '1') return;
  const at = nowIso();
  await db.prepare(
    `INSERT INTO booth_settings (key, value, updated_at) VALUES (?1, 'waiting', ?2)
     ON CONFLICT (key) DO UPDATE SET value = 'waiting', updated_at = excluded.updated_at`
  ).bind(flag, at).run();
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const row = await db.prepare('SELECT value FROM booth_settings WHERE key = ?1').bind(flag).first();
    if (row?.value === 'go') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  boothFail(500, 'internal_error');
}

// A missed WHERE leaves no row and, because each chunk insert requires that row, no file chunks.
async function explainMiss(db, fields, limits) {
  const owned = await db.prepare(
    `SELECT COUNT(*) AS count FROM booth_submissions WHERE owner_id = ?1 AND status <> 'withdrawn'`
  ).bind(fields.ownerId).first();
  if (Number(owned?.count ?? 0) >= limits.perOwner) boothFail(429, 'rate_limited');
  const stored = await db.prepare(
    `SELECT COALESCE(SUM(s.pdf_bytes), 0) AS total FROM booth_submissions AS s
     WHERE EXISTS (SELECT 1 FROM booth_files AS f WHERE f.submission_id = s.id)`
  ).first();
  if (Number(stored?.total ?? 0) + fields.pdfBytes > limits.storedBytes) boothFail(503, 'storage_full');
  const existing = await db.prepare(
    'SELECT receipt FROM booth_submissions WHERE owner_id = ?1 AND pdf_sha256 = ?2'
  ).bind(fields.ownerId, fields.pdfSha256).first();
  if (existing?.receipt) boothFail(409, 'already_submitted', { extra: { receipt: existing.receipt } });
}

async function insertSubmission(db, env, fields, limits) {
  const chunks = chunkPdf(fields.pdf);
  for (let attempt = 0; attempt < SEQ_ATTEMPTS; attempt++) {
    const preview = await db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM booth_submissions').first();
    const seq = Number(preview?.seq);
    if (!Number.isSafeInteger(seq) || seq < 1) boothFail(500, 'internal_error');
    const expected = seq + seqBias(env, attempt);
    const receipt = formatReceipt(seq);
    const claimHash = await sha256Hex(`${CLAIM_PREFIX}${receipt}:${fields.normalizedKey}`);
    const statements = [
      db.prepare(INSERT_SQL).bind(
        fields.id,
        claimHash,
        fields.ownerId,
        fields.pdfSha256,
        fields.pdfBytes,
        fields.sourceSha256,
        fields.course,
        fields.nickname,
        JSON.stringify(fields.declared),
        fields.paper ? JSON.stringify(fields.paper) : null,
        fields.consentVersion,
        fields.createdAt,
        expected,
        limits.perOwner,
        limits.storedBytes,
      ),
      ...chunks.map((data, idx) => db.prepare(FILE_SQL).bind(fields.id, idx, data)),
    ];
    try {
      const results = await db.batch(statements);
      const allLanded = Array.isArray(results)
        && results.length === statements.length
        && results.every(item => Number(item?.meta?.changes) === 1);
      if (!allLanded) {
        await discardAttempt(db, fields.id);
        await explainMiss(db, fields, limits);
        continue;
      }
      const stored = await db.prepare('SELECT receipt, created_at FROM booth_submissions WHERE id = ?1').bind(fields.id).first();
      if (!stored || stored.receipt !== receipt) {
        await discardAttempt(db, fields.id);
        continue;
      }
      return { receipt: stored.receipt, createdAt: stored.created_at };
    } catch (error) {
      if (error instanceof AiError) throw error;
      if (!isUniqueError(error)) throw error;
      await explainMiss(db, fields, limits);
      if (attempt === SEQ_ATTEMPTS - 1) boothFail(500, 'internal_error');
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
  const limits = boothLimits(ctx.env);
  const bucket = await bucketKey(CLAIM_BUCKET_PREFIX, clientIp(ctx));
  const ipSlot = await ctx.deps.rateLimit(db, bucket, limits.claimsPerIpHour);
  try {
    await ctx.deps.rateLimit(db, CLAIM_GLOBAL_BUCKET, limits.claimsPerHour);
  } catch (error) {
    await ctx.deps.releaseSlot(db, bucket, ipSlot);
    throw error;
  }
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
  const matches = hashesEqual(expected, presented);
  if (!row || !matches) boothFail(404, 'not_found');
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
    pdfSha256: row.pdf_sha256,
    pdfBytes: Number(row.pdf_bytes),
    sourceSha256: row.source_sha256 ?? null,
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
  const started = ctx.env?.BOOTH_PARSE_TIMING === '1' ? performance.now() : null;
  const elapsed = () => (started === null ? undefined : performance.now() - started);
  const fail = (status, code, options = {}) => reject(ctx, elapsed(), status, code, options);
  const parts = await readSubmissionParts(ctx.request, ctx.env);
  const submission = parseSubmission(parts.meta);
  const db = ctx.deps.getDb();
  const settings = publicSettings(await settingsMap(db), ctx.env);
  if (!settings.submissionsOpen) fail(403, 'booth_closed');
  if (submission.consentVersion !== consentVersionOf(ctx.env)) fail(409, 'consent_outdated');
  const pdf = parts.pdf;
  const limit = maxPdfBytes(ctx.env);
  if (pdf.byteLength === 0 || !startsWithPdf(pdf)) fail(400, 'invalid_pdf');
  if (pdf.byteLength > limit) fail(413, 'payload_too_large');
  const digest = await sha256Bytes(pdf);
  if (!hashesEqual(digest, submission.editedSha256)) fail(400, 'pdf_mismatch');
  if (hashesEqual(digest, submission.sourceSha256)) fail(400, 'pdf_unchanged');
  if (!missionSourceAllowed(settings.missions, submission)) fail(400, 'paper_not_allowed');
  const duplicate = await db.prepare(
    'SELECT receipt FROM booth_submissions WHERE owner_id = ?1 AND pdf_sha256 = ?2'
  ).bind(owner.ownerId, digest).first();
  if (duplicate?.receipt) fail(409, 'already_submitted', { extra: { receipt: duplicate.receipt } });
  const limits = boothLimits(ctx.env);
  const charged = await chargeSubmission(ctx, limits);
  try {
    const createdAt = nowIso();
    const displayKey = claimKey();
    const stored = await insertSubmission(db, ctx.env, {
      id: crypto.randomUUID(),
      ownerId: owner.ownerId,
      pdfSha256: digest,
      pdfBytes: pdf.byteLength,
      sourceSha256: submission.sourceSha256,
      pdf,
      course: submission.course,
      nickname: submission.nickname,
      declared: submission.declared,
      paper: submission.paper,
      consentVersion: submission.consentVersion,
      normalizedKey: normalizeClaimKey(displayKey),
      createdAt,
    }, limits);
    return json(201, {
      receipt: stored.receipt,
      claimKey: displayKey,
      status: 'received',
      course: submission.course,
      declaredCount: submission.declared.length,
      createdAt: stored.createdAt,
    }, timingHeaders(ctx.env, elapsed()));
  } catch (error) {
    await releaseSubmission(ctx, charged);
    if (error instanceof AiError && started !== null) {
      error.headers = { ...timingHeaders(ctx.env, elapsed()), ...(error.headers || {}) };
    }
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
  await db.batch([
    db.prepare(
      `UPDATE booth_submissions
       SET status = 'withdrawn', declared = '[]', nickname = NULL, paper = NULL,
           public_note = NULL, prize_message = NULL, ai_summary = NULL, outcome = NULL,
           published_at = NULL, operator_note = NULL, updated_at = ?2
       WHERE id = ?1`
    ).bind(row.id, at),
    db.prepare('DELETE FROM booth_files WHERE submission_id = ?1').bind(row.id),
  ]);
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

function patchAssignments(patch) {
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
  return { sets, binds };
}

async function patchAdmin(ctx) {
  await requireOperator(ctx);
  const patch = parsePatch(await readJsonBody(ctx.request));
  const db = ctx.deps.getDb();
  const row = await adminRow(db, ctx.match.params.receipt);
  const noteOnly = Object.keys(patch).every(key => key === 'operatorNote');
  if (row.status === 'withdrawn' && !noteOnly) boothFail(409, 'withdrawn');
  const { sets, binds } = patchAssignments(patch);
  if (sets.length) {
    binds.push(nowIso());
    sets.push(`updated_at = ?${binds.length}`);
    binds.push(row.id);
    if (!noteOnly) await holdTestGate(db, ctx.env, 'BOOTH_TEST_PATCH_GATE');
    const where = noteOnly
      ? `id = ?${binds.length}`
      : `id = ?${binds.length} AND status <> 'withdrawn'`;
    const updated = await db.prepare(
      `UPDATE booth_submissions SET ${sets.join(', ')} WHERE ${where}`
    ).bind(...binds).run();
    if (!noteOnly && Number(updated?.meta?.changes) !== 1) boothFail(409, 'withdrawn');
  }
  return json(200, adminView(await adminRow(db, row.receipt)));
}

async function deleteAdmin(ctx) {
  await requireOperator(ctx);
  const db = ctx.deps.getDb();
  const row = await adminRow(db, ctx.match.params.receipt);
  await db.batch([
    db.prepare('DELETE FROM booth_files WHERE submission_id = ?1').bind(row.id),
    db.prepare('DELETE FROM booth_submissions WHERE id = ?1').bind(row.id),
  ]);
  return json(204, null);
}

async function getAdminPdf(ctx) {
  await requireOperator(ctx);
  const receipt = ctx.match?.params?.receipt;
  if (typeof receipt !== 'string' || !RECEIPT.test(receipt)) boothFail(404, 'not_found');
  const db = ctx.deps.getDb();
  const row = await db.prepare(
    'SELECT id, receipt, status, pdf_sha256, pdf_bytes FROM booth_submissions WHERE receipt = ?1'
  ).bind(receipt).first();
  if (!row) boothFail(404, 'not_found');
  if (row.status === 'withdrawn') boothFail(404, 'withdrawn');
  const pdfBytes = Number(row.pdf_bytes);
  if (!Number.isSafeInteger(pdfBytes) || pdfBytes < 1) boothFail(500, 'internal_error');
  const expected = Math.ceil(pdfBytes / PDF_CHUNK_BYTES);
  const listed = await db.prepare(
    'SELECT idx FROM booth_files WHERE submission_id = ?1 ORDER BY idx ASC'
  ).bind(row.id).all();
  const idxs = listed.results || [];
  if (idxs.length !== expected) boothFail(500, 'internal_error');
  for (let i = 0; i < idxs.length; i++) {
    if (Number(idxs[i].idx) !== i) boothFail(500, 'internal_error');
  }
  await holdTestGate(db, ctx.env, 'BOOTH_TEST_PDF_GATE');
  // A plain ReadableStream drops Content-Length. FixedLengthStream keeps pdf_bytes on the response
  // while the body still reads one idx row at a time. Each read is joined to a live submission.
  const fixed = new FixedLengthStream(pdfBytes);
  const writer = fixed.writable.getWriter();
  const stop = async () => {
    try { await writer.abort(); } catch { /* the client already stopped reading */ }
  };
  const pump = (async () => {
    try {
      for (let next = 0; next < expected; next++) {
        const part = await db.prepare(
          `SELECT f.data AS data FROM booth_files AS f
           JOIN booth_submissions AS s ON s.id = f.submission_id
           WHERE f.submission_id = ?1 AND f.idx = ?2 AND s.status <> 'withdrawn'`
        ).bind(row.id, next).first();
        if (!part) return stop();
        const bytes = blobBytes(part.data);
        const want = next === expected - 1 ? pdfBytes - next * PDF_CHUNK_BYTES : PDF_CHUNK_BYTES;
        if (bytes.byteLength !== want) return stop();
        await writer.write(bytes);
      }
      await writer.close();
    } catch {
      await stop();
    }
  })();
  pump.catch(() => {});
  return new Response(fixed.readable, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${row.receipt}.pdf"`,
      'Content-Length': String(pdfBytes),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Falsify-Pdf-Sha256': row.pdf_sha256,
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
  const boothState = { refreshed: null };
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
    const response = await handler({ ...ctx, requestId, boothState });
    return withRefreshed(response, boothState.refreshed);
  } catch (error) {
    const known = toAiError(error);
    if (!(error instanceof AiError) && known.code === 'internal_error') {
      console.error(JSON.stringify({
        event: 'unhandled_booth_error',
        route: ctx.match?.template || 'unknown',
        name: error?.name || 'unknown',
      }));
    }
    return withRefreshed(errorResponse(known, requestId), boothState.refreshed);
  }
}
