// Hosted AI gateway (contract docs/hosted-ai-contract-20261117.md).
// Authenticates one stable owner, keeps an idempotent job index in D1 and proxies every execution
// to the container-internal runtime. No prompt, upload bytes, edit rationale or provider error text
// is stored here. Owner-paid policy is a pre-flight gate over recorded usage, never a spend balance.
import { timingSafeEqual } from 'node:crypto';
import { SESSION_HEADER } from './confluence.mjs';
import { AiError, aiFail, hostingEnabled, openAccessEnabled, resolveAiOwner, resolveGuestOwner, resolveOperatorOwner, sha256Hex } from './ai-identity.mjs';
import {
  cancelRuntimeJob,
  createRuntimeJob,
  createRuntimeUpload,
  getRuntimeArtifact,
  getRuntimeJob,
  postRuntimePaper,
} from './ai-runtime-client.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ARTIFACT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const MODEL_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;
const EFFORT_TOKEN = /^[a-z]{1,16}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_JOB_BODY_BYTES = 256 * 1024;
const MAX_UPLOAD_BOUND = 64 * 1024 * 1024;
const DEFAULT_GUEST_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const GUEST_JOB_BUCKET = 'ai-guest-jobs:all';
// Guest apply-only RED jobs move here only when AI_GUEST_APPLY_JOBS_PER_HOUR is set.
const GUEST_APPLY_JOB_BUCKET = 'ai-guest-apply-jobs:all';
const GUEST_UPLOAD_BUCKET = 'ai-guest-uploads:all';
const GUEST_READ_BUCKET = 'ai-guest-reads:all';
const GUEST_ARTIFACT_BUCKET = 'ai-guest-artifacts:all';
const MAX_TEXT_EDITS = 100;
// The runtime's visual-edit engine accepts at most 12 coordinated visual operations.
const MAX_VISUAL_EDITS = 12;
const ROLES = ['red', 'blue'];
const STATES = ['queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'interrupted'];
const DEFAULT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SNAPSHOT_PROVIDERS = ['anthropic', 'openai'];
// Fixed upload allowlist. Anything else is 415 before a byte is forwarded.
const MIME_TYPES = ['application/pdf', 'application/octet-stream', 'text/plain'];
const CONTROL = /[\u0000-\u001f\u007f]/;
const TEXT_EDIT_KEYS = ['id', 'pageIndex', 'before', 'after', 'occurrence', 'bbox', 'spanId'];
// Mirrors app/local/red_multimodal.py: both visual kinds are strict objects with these exact keys.
const VISUAL_EDIT_KEYS = {
  'table-cell': ['kind', 'itemId', 'row', 'column', 'before', 'after', 'rationale'],
  'chart-point': ['kind', 'itemId', 'seriesId', 'pointIndex', 'beforeY', 'afterY', 'rationale'],
};

export const AI_ALLOW_METHODS = 'GET, POST, OPTIONS';
export const AI_ALLOW_HEADERS = 'authorization, content-type, x-falsify-file-name';

const MESSAGES = {
  invalid_request: 'The request is not valid for this endpoint.',
  unauthorized: 'A valid Falsify session is required.',
  membership_required: 'An active team membership is required.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  payload_too_large: 'The request body exceeds the hosted limit.',
  unsupported_media_type: 'The upload type is not supported.',
  rate_limited: 'Too many hosted AI requests; retry later.',
  open_access_disabled: 'Open access is not enabled.',
  guest_blue_disabled: 'Guest BLUE jobs are not enabled.',
  guest_model_disabled: 'Guest model jobs are not enabled.',
  model_jobs_operator_only: 'Model jobs are limited to the booth operator.',
  invalid_access_key: 'The access key is not valid.',
  owner_budget_exhausted: 'The owner token budget for this window is exhausted.',
  idempotency_conflict: 'This idempotency key is already used for a different request.',
  ai_unavailable: 'Hosted AI execution is temporarily unavailable.',
  paper_tools_disabled: 'Paper tools are not enabled.',
  paper_path_unsupported: 'That paper path is not supported.',
  runtime_unavailable: 'The paper runtime response could not be used.',
  internal_error: 'Internal error.',
};
const RETRYABLE = new Set(['rate_limited', 'owner_budget_exhausted', 'ai_unavailable', 'internal_error']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function csv(value, fallback, pattern) {
  const items = String(value || '').split(',').map(item => item.trim()).filter(item => pattern.test(item));
  return items.length ? [...new Set(items)] : fallback.slice();
}

// claude-* is anthropic. gpt-* and o<digit>* (o3, o3-mini) are openai. Anything else is not a provider.
export function providerForModel(model) {
  if (typeof model !== 'string') return null;
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-')) return 'openai';
  if (/^o\d/.test(model)) return 'openai';
  return null;
}

// Tokens with no provider are dropped. An explicit AI_MODELS list that matches the token pattern
// but names no allowed model stays empty and does not fall back to the Claude defaults.
// Unset, blank, and lists with no token at all keep DEFAULT_MODELS, the same as csv().
function listedModels(value) {
  const tokens = String(value || '').split(',').map(item => item.trim()).filter(item => MODEL_TOKEN.test(item));
  if (!tokens.length) return DEFAULT_MODELS.slice();
  const allowed = [];
  for (const token of tokens) {
    if (providerForModel(token) && !allowed.includes(token)) allowed.push(token);
  }
  return allowed;
}

function catalogProvider(models) {
  let provider = null;
  for (const model of models) {
    const next = providerForModel(model);
    if (!next) continue;
    if (!provider) provider = next;
    else if (provider !== next) return 'mixed';
  }
  return provider || 'mixed';
}

function modelProvidersFor(models) {
  const modelProviders = {};
  for (const model of models) {
    const provider = providerForModel(model);
    if (provider) modelProviders[model] = provider;
  }
  return modelProviders;
}

export function aiSettings(env) {
  const maxCallsPerJob = Math.min(positiveInt(env?.AI_MAX_CALLS_PER_JOB, 24), 64);
  const maxUploadBytes = Math.min(positiveInt(env?.AI_MAX_UPLOAD_BYTES, 32 * 1024 * 1024), MAX_UPLOAD_BOUND);
  const models = listedModels(env?.AI_MODELS);
  const efforts = csv(env?.AI_EFFORTS, DEFAULT_EFFORTS, EFFORT_TOKEN);
  const requestedModel = String(env?.AI_DEFAULT_MODEL || '');
  const requestedEffort = String(env?.AI_DEFAULT_EFFORT || '');
  return {
    enabled: hostingEnabled(env),
    maxUploadBytes,
    maxPromptChars: Math.min(positiveInt(env?.AI_MAX_PROMPT_CHARS, 32000), 200000),
    maxCallsPerJob,
    defaultCalls: Math.min(positiveInt(env?.AI_DEFAULT_CALLS, 12), maxCallsPerJob),
    uploadsPerOwnerHour: positiveInt(env?.AI_UPLOADS_PER_OWNER_HOUR, 60),
    jobsPerOwnerHour: positiveInt(env?.AI_JOBS_PER_OWNER_HOUR, 20),
    activeJobsPerOwner: positiveInt(env?.AI_ACTIVE_JOBS_PER_OWNER, 3),
    // Owner-paid policy: 0 disables the token gate. It counts only usage recorded from terminal
    // snapshots, so it is a coarse pre-flight policy, not an exact provider balance.
    ownerTokenBudget: nonNegativeInt(env?.AI_OWNER_TOKEN_BUDGET, 0),
    tokenWindowSeconds: positiveInt(env?.AI_TOKEN_WINDOW_SECONDS, 86400),
    openAccess: openAccessEnabled(env),
    openAccessKey: guestSecret(env),
    guestSessionSeconds: positiveInt(env?.AI_GUEST_SESSION_SECONDS, 21600),
    guestsPerIpHour: positiveInt(env?.AI_GUESTS_PER_IP_HOUR, 10),
    guestsPerHour: positiveInt(env?.AI_GUESTS_PER_HOUR, 600),
    guestUploadsPerOwnerHour: positiveInt(env?.AI_GUEST_UPLOADS_PER_OWNER_HOUR, 10),
    guestUploadsPerHour: positiveInt(env?.AI_GUEST_UPLOADS_PER_HOUR, 300),
    // Never wider than the deployment upload cap. The page reads this through limits.maxUploadBytes
    // only when the caller is a guest; unsigned capabilities keep maxUploadBytes.
    guestMaxUploadBytes: Math.min(positiveInt(env?.AI_GUEST_MAX_UPLOAD_BYTES, DEFAULT_GUEST_MAX_UPLOAD_BYTES), maxUploadBytes),
    guestJobsPerOwnerHour: positiveInt(env?.AI_GUEST_JOBS_PER_OWNER_HOUR, 6),
    guestActiveJobsPerOwner: positiveInt(env?.AI_GUEST_ACTIVE_JOBS_PER_OWNER, 1),
    guestMaxCallsPerJob: positiveInt(env?.AI_GUEST_MAX_CALLS_PER_JOB, 8),
    guestJobsPerHour: positiveInt(env?.AI_GUEST_JOBS_PER_HOUR, 150),
    // Unset keeps apply-only jobs on the model-job bucket. A set value, even an invalid one that
    // falls back to the same number, counts apply-only jobs in their own global bucket.
    guestApplyJobsSeparated: guestApplySeparated(env),
    guestApplyJobsPerHour: positiveInt(env?.AI_GUEST_APPLY_JOBS_PER_HOUR, positiveInt(env?.AI_GUEST_JOBS_PER_HOUR, 150)),
    // Unset means guests may still start BLUE. Only an explicit false closes it.
    guestBlue: guestBlueEnabled(env),
    // Unset means a guest may still start a model job. Only an explicit false leaves apply-only RED.
    guestModelJobs: guestModelJobsEnabled(env),
    operatorJobsPerHour: positiveInt(env?.BOOTH_OPERATOR_JOBS_PER_HOUR, 600),
    operatorActiveJobs: positiveInt(env?.BOOTH_OPERATOR_ACTIVE_JOBS, 4),
    operatorUploadsPerHour: positiveInt(env?.BOOTH_OPERATOR_UPLOADS_PER_HOUR, 600),
    operatorMaxCallsPerJob: Math.min(positiveInt(env?.BOOTH_OPERATOR_MAX_CALLS_PER_JOB, maxCallsPerJob), 64),
    // 0 leaves the existing owner token-budget gate off for opr:booth. A positive value is that gate.
    operatorTokenBudget: nonNegativeInt(env?.BOOTH_OPERATOR_TOKEN_BUDGET, 0),
    // Unset means any owner may start a model job. Only an explicit true reserves them for opr:booth.
    modelJobsOperatorOnly: modelJobsOperatorOnly(env),
    // One active guest job polled at the page's 12s steady rate is 300 reads an hour.
    // 600 leaves room for cancel, replay and a manual refresh. 45000 is 150 jobs at that rate.
    guestJobReadsPerOwnerHour: positiveInt(env?.AI_GUEST_JOB_READS_PER_OWNER_HOUR, 600),
    guestJobReadsPerHour: positiveInt(env?.AI_GUEST_JOB_READS_PER_HOUR, 45000),
    guestArtifactsPerOwnerHour: positiveInt(env?.AI_GUEST_ARTIFACTS_PER_OWNER_HOUR, 60),
    guestArtifactsPerHour: positiveInt(env?.AI_GUEST_ARTIFACTS_PER_HOUR, 1200),
    guestTokenBudget: nonNegativeInt(env?.AI_GUEST_TOKEN_BUDGET, 0),
    models,
    efforts,
    defaultModel: models.includes(requestedModel) ? requestedModel : (models[0] || ''),
    defaultEffort: efforts.includes(requestedEffort) ? requestedEffort : (efforts.includes('high') ? 'high' : efforts[0]),
    mimeTypes: MIME_TYPES.slice(),
    paperTools: paperToolsEnabled(env),
    paperMaxBodyBytes: Math.min(positiveInt(env?.AI_PAPER_MAX_BODY_BYTES, 29360128), 64 * 1024 * 1024),
    paperPreparesPerHour: positiveInt(env?.AI_PAPER_PREPARES_PER_HOUR, 30),
    paperCallsPerHour: positiveInt(env?.AI_PAPER_CALLS_PER_HOUR, 600),
    guestPaperPreparesPerHour: positiveInt(env?.AI_GUEST_PAPER_PREPARES_PER_HOUR, 10),
    guestPaperCallsPerHour: positiveInt(env?.AI_GUEST_PAPER_CALLS_PER_HOUR, 240),
    paperCallsGlobalPerHour: positiveInt(env?.AI_PAPER_CALLS_GLOBAL_PER_HOUR, 3000),
  };
}

function paperToolsEnabled(env) {
  return env?.AI_PAPER_TOOLS_ENABLED === true || env?.AI_PAPER_TOOLS_ENABLED === 'true';
}

function guestBlueEnabled(env) {
  if (env?.AI_GUEST_BLUE === false || env?.AI_GUEST_BLUE === 'false') return false;
  return true;
}

function guestModelJobsEnabled(env) {
  if (env?.AI_GUEST_MODEL_JOBS === false || env?.AI_GUEST_MODEL_JOBS === 'false') return false;
  return true;
}

function modelJobsOperatorOnly(env) {
  return env?.AI_MODEL_JOBS_OPERATOR_ONLY === true || env?.AI_MODEL_JOBS_OPERATOR_ONLY === 'true';
}

function guestApplySeparated(env) {
  const raw = env?.AI_GUEST_APPLY_JOBS_PER_HOUR;
  return raw !== undefined && raw !== null && String(raw).trim() !== '';
}

function guestSecret(env) {
  const raw = env?.AI_OPEN_ACCESS_KEY;
  return typeof raw === 'string' ? raw : '';
}

function isGuestOwner(ownerId) {
  return typeof ownerId === 'string' && ownerId.startsWith('gst:');
}

function isOperatorOwner(ownerId) {
  return ownerId === 'opr:booth';
}

// Password and Confluence owners keep today's settings object. The booth operator replaces the
// hourly, active, upload, call and token caps and may still use every model and effort. A guest
// uses the tighter caps, and the token budget below sums every gst: owner instead of one row.
function effectiveAiSettings(settings, ownerId) {
  if (isOperatorOwner(ownerId)) {
    const maxCallsPerJob = Math.min(settings.operatorMaxCallsPerJob, 64);
    return {
      ...settings,
      operatorScope: true,
      maxCallsPerJob,
      defaultCalls: Math.min(settings.defaultCalls, maxCallsPerJob),
      uploadsPerOwnerHour: settings.operatorUploadsPerHour,
      jobsPerOwnerHour: settings.operatorJobsPerHour,
      activeJobsPerOwner: settings.operatorActiveJobs,
      ownerTokenBudget: settings.operatorTokenBudget,
    };
  }
  if (!isGuestOwner(ownerId)) return settings;
  const maxCallsPerJob = Math.min(settings.guestMaxCallsPerJob, settings.maxCallsPerJob);
  return {
    ...settings,
    guestScope: true,
    maxCallsPerJob,
    defaultCalls: Math.min(settings.defaultCalls, maxCallsPerJob),
    maxUploadBytes: settings.guestMaxUploadBytes,
    uploadsPerOwnerHour: settings.guestUploadsPerOwnerHour,
    jobsPerOwnerHour: settings.guestJobsPerOwnerHour,
    activeJobsPerOwner: settings.guestActiveJobsPerOwner,
    ownerTokenBudget: settings.guestTokenBudget,
    paperPreparesPerHour: settings.guestPaperPreparesPerHour,
    paperCallsPerHour: settings.guestPaperCallsPerHour,
  };
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

// Maps the legacy API error class (auth, D1, CORS) onto the fixed hosted AI error set.
function toAiError(error) {
  if (error instanceof AiError) return error;
  const code = error?.code;
  if (code === 'unauthorized') return new AiError(401, 'unauthorized');
  if (code === 'membership_required') return new AiError(403, 'membership_required');
  if (code === 'rate_limited') return new AiError(429, 'rate_limited', error.headers || {});
  if (code === 'not_configured') return new AiError(503, 'ai_unavailable');
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

function withRefreshed(response, refreshed) {
  if (!refreshed) return response;
  const headers = new Headers(response.headers);
  headers.set(SESSION_HEADER, refreshed);
  headers.set('Access-Control-Expose-Headers', SESSION_HEADER);
  return new Response(response.body, { status: response.status, headers });
}

const nowIso = () => new Date().toISOString();

async function bucketKey(prefix, value) {
  return prefix + (await sha256Hex('falsify-rate:' + prefix + value)).slice(0, 24);
}

async function readBoundedBytes(request, max) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null) {
    const text = declared.trim();
    if (!/^[0-9]{1,12}$/.test(text)) aiFail(400, 'invalid_request');
    if (Number(text) > max) aiFail(413, 'payload_too_large');
  }
  if (!request.body) aiFail(400, 'invalid_request');
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
        aiFail(413, 'payload_too_large');
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

async function readJsonBody(request, max) {
  const type = (request.headers.get('Content-Type') || '').trim();
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(type)) aiFail(415, 'unsupported_media_type');
  const bytes = await readBoundedBytes(request, max);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    aiFail(400, 'invalid_request');
  }
  if (!isObject(parsed)) aiFail(400, 'invalid_request');
  return parsed;
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function uploadName(header) {
  if (header === null) aiFail(400, 'invalid_request');
  let name;
  try {
    name = decodeURIComponent(header);
  } catch {
    aiFail(400, 'invalid_request');
  }
  const normalized = name.normalize('NFC').trim();
  if (!normalized || [...normalized].length > 200 || CONTROL.test(normalized)) aiFail(400, 'invalid_request');
  return normalized;
}

function uploadView(row, deduplicated) {
  return {
    id: row.id,
    sha256: row.sha256,
    name: row.name,
    mime: row.mime,
    bytes: row.bytes,
    createdAt: row.created_at,
    deduplicated,
  };
}

const UPLOAD_COLUMNS = 'id, sha256, name, mime, bytes, created_at';

// Guest counters are separate from password/Confluence buckets. A null slot means "not a guest".
async function claimGuestCounter(db, deps, settings, bucket, limit) {
  if (settings.guestScope !== true) return null;
  return deps.rateLimit(db, bucket, limit);
}

async function releaseGuestCounter(db, deps, bucket, slot) {
  if (slot === null || slot === undefined) return;
  await deps.releaseSlot(db, bucket, slot);
}

async function claimGuestPair(db, deps, settings, ownerId, spec) {
  if (settings.guestScope !== true) return null;
  const ownerBucket = await bucketKey(spec.ownerPrefix, ownerId);
  const ownerSlot = await deps.rateLimit(db, ownerBucket, spec.ownerLimit);
  try {
    const globalSlot = await deps.rateLimit(db, spec.globalBucket, spec.globalLimit);
    return { ownerBucket, ownerSlot, globalSlot };
  } catch (error) {
    await deps.releaseSlot(db, ownerBucket, ownerSlot);
    throw error;
  }
}

async function releaseGuestPair(db, deps, spec, pair) {
  if (!pair) return;
  await deps.releaseSlot(db, pair.ownerBucket, pair.ownerSlot);
  await deps.releaseSlot(db, spec.globalBucket, pair.globalSlot);
}

// Runs fn only after the guest follow cap is reserved. A thrown runtime error gives the slot back
// so an outage does not burn the hour; a response keeps it because the runtime was reached.
async function guestRuntime(db, deps, settings, ownerId, spec, fn) {
  const pair = await claimGuestPair(db, deps, settings, ownerId, spec);
  try {
    return await fn();
  } catch (error) {
    await releaseGuestPair(db, deps, spec, pair);
    throw error;
  }
}

function guestFollowSpec(settings, kind) {
  if (kind === 'artifact') {
    return {
      ownerPrefix: 'ai-guest-artifact:',
      ownerLimit: settings.guestArtifactsPerOwnerHour,
      globalBucket: GUEST_ARTIFACT_BUCKET,
      globalLimit: settings.guestArtifactsPerHour,
    };
  }
  return {
    ownerPrefix: 'ai-guest-read:',
    ownerLimit: settings.guestJobReadsPerOwnerHour,
    globalBucket: GUEST_READ_BUCKET,
    globalLimit: settings.guestJobReadsPerHour,
  };
}

async function releaseUploadSlots(db, deps, bucket, slot, guestSlot) {
  await deps.releaseSlot(db, bucket, slot);
  await releaseGuestCounter(db, deps, GUEST_UPLOAD_BUCKET, guestSlot);
}

function reportedDigestMismatch(created, sha256) {
  const reported = created.upload.sha256;
  return typeof reported === 'string' && HASH.test(reported) && reported !== sha256;
}

async function insertUpload(input, created) {
  const { ctx, db, sha256, name, mime, bytes } = input;
  const id = crypto.randomUUID();
  const at = nowIso();
  const inserted = await db
    .prepare(
      `INSERT INTO ai_uploads (id, owner_id, sha256, name, mime, bytes, runtime_upload_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (owner_id, sha256) DO NOTHING`
    )
    .bind(id, ctx.ownerId, sha256, name, mime, bytes.byteLength, created.upload.id, at)
    .run();
  if (inserted.meta.changes !== 1) {
    const row = await db
      .prepare(`SELECT ${UPLOAD_COLUMNS} FROM ai_uploads WHERE owner_id = ?1 AND sha256 = ?2`)
      .bind(ctx.ownerId, sha256)
      .first();
    if (!row) aiFail(503, 'ai_unavailable');
    return json(200, { upload: uploadView(row, true) });
  }
  return json(201, {
    upload: uploadView({ id, sha256, name, mime, bytes: bytes.byteLength, created_at: at }, false),
  });
}

async function storeRuntimeUpload(input) {
  const { ctx, db, env, deps, bucket, slot, guestSlot, name, mime, bytes, sha256 } = input;
  let created;
  try {
    created = await createRuntimeUpload(env, { ownerId: ctx.ownerId, name, mime, bytes });
  } catch (error) {
    await releaseUploadSlots(db, deps, bucket, slot, guestSlot);
    throw error;
  }
  if (reportedDigestMismatch(created, sha256)) {
    await releaseUploadSlots(db, deps, bucket, slot, guestSlot);
    aiFail(503, 'ai_unavailable');
  }
  return insertUpload(input, created);
}

async function takeGuestUploadSlot(db, deps, settings, bucket, slot) {
  try {
    return await claimGuestCounter(db, deps, settings, GUEST_UPLOAD_BUCKET, settings.guestUploadsPerHour);
  } catch (error) {
    await deps.releaseSlot(db, bucket, slot);
    throw error;
  }
}

async function createUpload(ctx) {
  const { request, env, settings, deps } = ctx;
  const db = deps.getDb();
  const mime = (request.headers.get('Content-Type') || '').trim().toLowerCase().split(';')[0].trim();
  if (!settings.mimeTypes.includes(mime)) aiFail(415, 'unsupported_media_type');
  const name = uploadName(request.headers.get('X-Falsify-File-Name'));
  const bytes = await readBoundedBytes(request, settings.maxUploadBytes);
  if (bytes.byteLength === 0) aiFail(400, 'invalid_request');
  const sha256 = await sha256Bytes(bytes);
  const bucket = await bucketKey('ai-upload:', ctx.ownerId);
  const slot = await deps.rateLimit(db, bucket, settings.uploadsPerOwnerHour);
  // Same owner + same bytes reuses the stored upload and never forwards the file again.
  const existing = await db
    .prepare(`SELECT ${UPLOAD_COLUMNS} FROM ai_uploads WHERE owner_id = ?1 AND sha256 = ?2`)
    .bind(ctx.ownerId, sha256)
    .first();
  if (existing) return json(200, { upload: uploadView(existing, true) });
  // New runtime uploads only. The claim is after the dedup lookup and before the forward.
  const guestSlot = await takeGuestUploadSlot(db, deps, settings, bucket, slot);
  return storeRuntimeUpload({ ctx, db, env, deps, bucket, slot, guestSlot, name, mime, bytes, sha256 });
}

function capabilitiesResponse(settings, operatorView = false) {
  const body = {
    enabled: settings.enabled,
    provider: catalogProvider(settings.models),
    execution: 'server',
    models: settings.models,
    efforts: settings.efforts,
    limits: { maxUploadBytes: settings.maxUploadBytes, maxPromptChars: settings.maxPromptChars },
    openAccess: {
      enabled: settings.openAccess,
      accessKeyRequired: settings.openAccess === true && settings.openAccessKey.length > 0,
    },
    modelProviders: modelProvidersFor(settings.models),
    // When model jobs are operator-only, every non-operator view reports both flags false.
    // Otherwise unsigned and guest views are false only when open access is on and that flag
    // is explicitly disabled. A valid operator bearer forces both true.
    blueJobs: settings.modelJobsOperatorOnly === true && !operatorView
      ? false
      : operatorView || !(settings.openAccess === true && settings.guestBlue === false),
    modelJobs: settings.modelJobsOperatorOnly === true && !operatorView
      ? false
      : operatorView || !(settings.openAccess === true && settings.guestModelJobs === false),
  };
  if (settings.paperTools) body.paperTools = { enabled: true };
  return json(200, body);
}

// Only a body the runtime actually returned is reported; unknown fields are dropped, and the
// result body is kept out of D1 so no paper text is persisted in the job index.
function shortString(value, max) {
  return typeof value === 'string' && value && !CONTROL.test(value) ? value.slice(0, max) : null;
}

function countInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// Copies only counters the runtime actually returned; absent keys are omitted, not zero-filled.
function progressView(value) {
  if (!isObject(value)) return null;
  const progress = {};
  const completed = countInt(value.completedCalls);
  const required = countInt(value.requiredCalls);
  const phase = shortString(value.phase, 40);
  if (completed !== null) progress.completedCalls = completed;
  if (required !== null) progress.requiredCalls = required;
  if (phase) progress.phase = phase;
  return Object.keys(progress).length ? progress : null;
}

function usageView(value) {
  if (!isObject(value)) return null;
  const usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
    const n = countInt(value[key]);
    if (n !== null) usage[key] = n;
  }
  return Object.keys(usage).length ? usage : null;
}

function artifactList(value) {
  if (!Array.isArray(value)) return null;
  const artifacts = [];
  for (const item of value.slice(0, 64)) {
    if (!isObject(item)) continue;
    const id = shortString(item.id, 128);
    const name = shortString(item.name, 200);
    if (!id || !name) continue;
    const artifact = {
      id,
      name,
      mime: shortString(item.mime, 100) || 'application/octet-stream',
      bytes: countInt(item.bytes) ?? 0,
    };
    if (typeof item.sha256 === 'string' && HASH.test(item.sha256)) artifact.sha256 = item.sha256;
    artifacts.push(artifact);
  }
  return artifacts;
}

function failureView(value) {
  const code = shortString(value.code, 64);
  if (!code) return null;
  const failure = { code, retryable: value.retryable === true };
  const message = shortString(value.message, 300);
  const requestId = shortString(value.requestId, 100);
  if (message) failure.message = message;
  if (requestId) failure.requestId = requestId;
  return failure;
}

// Projects a runtime snapshot onto the contract shape. Nothing is invented: a state outside the
// allowlist is a runtime contract violation (503), and absent fields are omitted rather than zeroed.
// applyOnly/useEvidence are request facts, so a runtime that omits them falls back to what the
// gateway recorded (defaults false/true).
function snapshotFlags(value, fallbackApplyOnly, fallbackUseEvidence) {
  return {
    applyOnly: typeof value?.applyOnly === 'boolean' ? value.applyOnly : fallbackApplyOnly === true,
    useEvidence: typeof value?.useEvidence === 'boolean' ? value.useEvidence : fallbackUseEvidence !== false,
  };
}

function storedFlags(row) {
  let parsed = null;
  try { parsed = row?.snapshot ? JSON.parse(row.snapshot) : null; } catch { parsed = null; }
  const flags = snapshotFlags(parsed, false, true);
  return { fallbackApplyOnly: flags.applyOnly, fallbackUseEvidence: flags.useEvidence };
}

function storedCatalog(row) {
  let parsed = null;
  try { parsed = row?.snapshot ? JSON.parse(row.snapshot) : null; } catch { parsed = null; }
  if (!isObject(parsed)) return { provider: null };
  if (SNAPSHOT_PROVIDERS.includes(parsed.provider)) return { provider: parsed.provider };
  const model = typeof parsed.model === 'string' ? parsed.model : null;
  return { provider: providerForModel(model) };
}

function snapshotIdentity(value, { fallbackId, fallbackRole, fallbackApplyOnly, fallbackUseEvidence }) {
  const flags = snapshotFlags(value, fallbackApplyOnly, fallbackUseEvidence);
  return {
    id: typeof value.id === 'string' && UUID.test(value.id) ? value.id : fallbackId,
    role: value.role === 'blue' ? 'blue' : (value.role === 'red' ? 'red' : fallbackRole),
    state: value.state,
    applyOnly: flags.applyOnly,
    useEvidence: flags.useEvidence,
  };
}

function snapshotProvider(value) {
  if (SNAPSHOT_PROVIDERS.includes(value?.provider)) return value.provider;
  return providerForModel(shortString(value?.model, 64));
}

function addSnapshotDetails(snapshot, value, includeResult) {
  const progress = progressView(value.progress);
  if (progress) snapshot.progress = progress;
  const model = shortString(value.model, 64);
  if (model) snapshot.model = model;
  const effort = shortString(value.effort, 16);
  if (effort) snapshot.effort = effort;
  const provider = snapshotProvider(value);
  if (provider) snapshot.provider = provider;
  const usage = usageView(value.usage);
  if (usage) snapshot.usage = usage;
  const artifacts = artifactList(value.artifacts);
  if (artifacts) snapshot.artifacts = artifacts;
  const createdAt = shortString(value.createdAt, 40);
  if (createdAt) snapshot.createdAt = createdAt;
  const updatedAt = shortString(value.updatedAt, 40);
  if (updatedAt) snapshot.updatedAt = updatedAt;
  if (includeResult && isObject(value.result)) snapshot.result = value.result;
  const failure = isObject(value.failure) ? failureView(value.failure) : null;
  if (failure) snapshot.failure = failure;
  const completedAt = shortString(value.completedAt, 40);
  if (completedAt) snapshot.completedAt = completedAt;
}

function publicSnapshot(value, {
  fallbackId,
  fallbackRole,
  includeResult,
  fallbackApplyOnly = false,
  fallbackUseEvidence = true,
}) {
  if (!isObject(value) || !STATES.includes(value.state)) aiFail(503, 'ai_unavailable');
  const snapshot = snapshotIdentity(value, { fallbackId, fallbackRole, fallbackApplyOnly, fallbackUseEvidence });
  addSnapshotDetails(snapshot, value, includeResult);
  return snapshot;
}

function queuedSnapshot({ id, role, model, effort, maxCalls, at, applyOnly, useEvidence }) {
  return {
    id,
    role,
    state: 'queued',
    applyOnly,
    useEvidence,
    progress: { completedCalls: 0, requiredCalls: maxCalls, phase: 'queued' },
    model,
    effort,
    provider: providerForModel(model),
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    artifacts: [],
    createdAt: at,
    updatedAt: at,
  };
}

// A runtime 404 for a job this gateway owns means the runtime lost its worker/state. The contract's
// "interrupted" state is exactly that: terminal, not complete, and never automatically replayed.
function lostSnapshot(id, role, at, { fallbackApplyOnly = false, fallbackUseEvidence = true, provider = null } = {}) {
  const snapshot = {
    id,
    role,
    state: 'interrupted',
    applyOnly: fallbackApplyOnly,
    useEvidence: fallbackUseEvidence,
    progress: { phase: 'interrupted' },
  };
  if (SNAPSHOT_PROVIDERS.includes(provider)) snapshot.provider = provider;
  snapshot.failure = {
    code: 'runtime_job_missing',
    message: 'The runtime no longer has this job.',
    retryable: false,
  };
  snapshot.updatedAt = at;
  return snapshot;
}

// Best-effort index refresh: a status read must not fail because the local index write failed.
async function persistSnapshot(db, ownerId, snapshot) {
  const stored = publicSnapshot(snapshot, {
    fallbackId: snapshot.id,
    fallbackRole: snapshot.role,
    includeResult: false,
  });
  // Provider usage is recorded once, when the job is first seen terminal. Later reads must not move
  // that usage into another budget window, and a job without reported usage records zero tokens.
  const terminal = TERMINAL_STATES.has(stored.state) ? 1 : 0;
  const usage = stored.usage || {};
  try {
    await db
      .prepare(
        `UPDATE ai_jobs SET state = ?1, snapshot = ?2, updated_at = ?3, completed_at = ?4,
           input_tokens = CASE WHEN ?5 = 1 AND usage_recorded_at IS NULL THEN ?6 ELSE input_tokens END,
           output_tokens = CASE WHEN ?5 = 1 AND usage_recorded_at IS NULL THEN ?7 ELSE output_tokens END,
           cache_read_input_tokens = CASE WHEN ?5 = 1 AND usage_recorded_at IS NULL THEN ?8 ELSE cache_read_input_tokens END,
           cache_creation_input_tokens = CASE WHEN ?5 = 1 AND usage_recorded_at IS NULL THEN ?9 ELSE cache_creation_input_tokens END,
           usage_recorded_at = CASE WHEN ?5 = 1 THEN COALESCE(usage_recorded_at, ?10) ELSE usage_recorded_at END
         WHERE id = ?11 AND owner_id = ?12`
      )
      .bind(
        stored.state,
        JSON.stringify(stored),
        stored.updatedAt ?? nowIso(),
        stored.completedAt ?? null,
        terminal,
        tokenCount(usage, 'inputTokens'),
        tokenCount(usage, 'outputTokens'),
        tokenCount(usage, 'cacheReadInputTokens'),
        tokenCount(usage, 'cacheCreationInputTokens'),
        nowIso(),
        stored.id,
        ownerId,
      )
      .run();
  } catch { /* the runtime remains the source of truth */ }
}

// The client harness may only restate server-allowlisted values; whatever it sends, the runtime
// receives the canonical hosted shape without endpoints, paths, credentials or code.
const HARNESS_KEYS = ['schema', 'id', 'name', 'version', 'role', 'instructions', 'maxCalls', 'adapter'];
const HARNESS_ADAPTER_KEYS = ['type', 'model', 'effort'];

function keysWithin(value, allowed) {
  return !Object.keys(value).some(key => !allowed.includes(key));
}

function validateHarnessAdapter(adapter, settings) {
  if (!isObject(adapter) || !keysWithin(adapter, HARNESS_ADAPTER_KEYS)) aiFail(400, 'invalid_request');
  if (adapter.type !== 'hosted') aiFail(400, 'invalid_request');
  if (adapter.model !== undefined && !settings.models.includes(adapter.model)) aiFail(400, 'invalid_request');
  if (adapter.effort !== undefined && !settings.efforts.includes(adapter.effort)) aiFail(400, 'invalid_request');
}

function validateHarness(value, { role, prompt, maxCalls, model, effort, settings }) {
  const canonical = {
    schema: 'falsify.harness.v1',
    id: 'hosted-anthropic',
    name: 'Hosted Anthropic',
    version: '1',
    role,
    instructions: prompt,
    maxCalls,
    adapter: { type: 'hosted', model, effort },
  };
  if (value === undefined) return canonical;
  if (!isObject(value) || !keysWithin(value, HARNESS_KEYS)) aiFail(400, 'invalid_request');
  if (value.schema !== undefined && value.schema !== 'falsify.harness.v1') aiFail(400, 'invalid_request');
  if (value.role !== undefined && value.role !== role) aiFail(400, 'invalid_request');
  if (value.adapter !== undefined) validateHarnessAdapter(value.adapter, settings);
  return canonical;
}

// A job id is derived from the request identity, so a client retry after an ambiguous runtime
// failure reuses the same id and the runtime's own (owner, key, hash) dedup finds the original job
// instead of starting a second paid run.
async function jobIdFor(ownerId, idempotencyKey, requestHash) {
  const hex = await sha256Hex(`falsify-job:${ownerId}:${idempotencyKey}:${requestHash}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const TERMINAL_STATES = new Set(['cancelled', 'completed', 'failed', 'interrupted']);
const MAX_RECONCILE_ROWS = 25;

// ---- RED edit selection -------------------------------------------------------------------
// Only the selected operations travel to the runtime. Every allowed key is a scalar or a bounded
// numeric box, so no endpoint, path, credential or executable can be smuggled through an edit.

function editText(value, { max, allowEmpty }) {
  if (typeof value !== 'string' || CONTROL.test(value)) aiFail(400, 'invalid_request');
  if (!allowEmpty && !value.trim()) aiFail(400, 'invalid_request');
  if (value.length > max) aiFail(400, 'invalid_request');
  return value;
}

function editCount(value, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) aiFail(400, 'invalid_request');
  return value;
}

function validateBbox(value) {
  if (!Array.isArray(value) || value.length !== 4) aiFail(400, 'invalid_request');
  const box = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > 1e6) aiFail(400, 'invalid_request');
    box.push(item);
  }
  if (box[2] <= box[0] || box[3] <= box[1]) aiFail(400, 'invalid_request');
  return box;
}

function validateTextEdit(op) {
  if (!isObject(op)) aiFail(400, 'invalid_request');
  if (Object.keys(op).some(key => !TEXT_EDIT_KEYS.includes(key))) aiFail(400, 'invalid_request');
  // pageIndex is required by the text-span engine; before/after are its replacement contract.
  if (!Object.hasOwn(op, 'pageIndex')) aiFail(400, 'invalid_request');
  const pageIndex = editCount(op.pageIndex, 100000);
  const before = editText(op.before, { max: 4000, allowEmpty: false });
  const after = editText(op.after, { max: 4000, allowEmpty: true });
  if (after === before) aiFail(400, 'invalid_request');
  const edit = { pageIndex, before, after };
  if (op.occurrence !== undefined) edit.occurrence = editCount(op.occurrence, 100000);
  if (op.spanId !== undefined) edit.spanId = editText(op.spanId, { max: 120, allowEmpty: false });
  if (op.bbox !== undefined) edit.bbox = validateBbox(op.bbox);
  if (op.id !== undefined) edit.id = editText(op.id, { max: 80, allowEmpty: false });
  return edit;
}

function validateVisualEdit(op) {
  if (!isObject(op)) aiFail(400, 'invalid_request');
  const kind = op.kind;
  const keys = VISUAL_EDIT_KEYS[kind];
  if (!keys) aiFail(400, 'invalid_request');
  if (Object.keys(op).some(key => !keys.includes(key))) aiFail(400, 'invalid_request');
  for (const key of keys) {
    if (!Object.hasOwn(op, key)) aiFail(400, 'invalid_request');
  }
  const itemId = editText(op.itemId, { max: 160, allowEmpty: false });
  const rationale = editText(op.rationale, { max: 3000, allowEmpty: false });
  if (kind === 'table-cell') {
    const before = editText(op.before, { max: 4000, allowEmpty: true });
    const after = editText(op.after, { max: 4000, allowEmpty: true });
    if (after === before) aiFail(400, 'invalid_request');
    return {
      kind,
      itemId,
      row: editCount(op.row, 100000),
      column: editCount(op.column, 100000),
      before,
      after,
      rationale,
    };
  }
  const seriesId = editText(op.seriesId, { max: 120, allowEmpty: false });
  const pointIndex = editCount(op.pointIndex, 100000);
  for (const key of ['beforeY', 'afterY']) {
    if (typeof op[key] !== 'number' || !Number.isFinite(op[key]) || Math.abs(op[key]) > 1e12) aiFail(400, 'invalid_request');
  }
  if (op.beforeY === op.afterY) aiFail(400, 'invalid_request');
  return { kind, itemId, seriesId, pointIndex, beforeY: op.beforeY, afterY: op.afterY, rationale };
}

// Edit selections are RED-only: BLUE must stay blind and only ever receives the edited PDF bytes.
// Visual operations always run through the apply-only path; a model-driven job cannot carry them.
function validateEdits(value, role) {
  if (value === undefined) return [];
  if (role !== 'red' || !Array.isArray(value) || value.length > MAX_TEXT_EDITS) aiFail(400, 'invalid_request');
  return value.map(validateTextEdit);
}

function validateVisualEdits(value, role, applyOnly) {
  if (value === undefined) return [];
  if (!applyOnly || role !== 'red') aiFail(400, 'invalid_request');
  if (!Array.isArray(value) || value.length > MAX_VISUAL_EDITS) aiFail(400, 'invalid_request');
  return value.map(validateVisualEdit);
}

// ---- owner-paid policy --------------------------------------------------------------------

function usageSince(guestScope) {
  const owner = guestScope ? "owner_id LIKE 'gst:%'" : 'owner_id = ?1';
  const since = guestScope ? '?1' : '?2';
  return `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens), 0) AS used FROM ai_jobs WHERE ${owner} AND usage_recorded_at IS NOT NULL AND usage_recorded_at >= ${since}`;
}

async function recordedUsage(db, ctx, settings, startIso) {
  const guest = settings.guestScope === true;
  const statement = db.prepare(usageSince(guest));
  const row = guest ? await statement.bind(startIso).first() : await statement.bind(ctx.ownerId, startIso).first();
  return Number(row?.used ?? 0);
}

function budgetWindow(windowSeconds, nowMs = Date.now()) {
  const nowSeconds = Math.floor(nowMs / 1000);
  const startSeconds = nowSeconds - (nowSeconds % windowSeconds);
  return {
    startIso: new Date(startSeconds * 1000).toISOString(),
    retryAfter: Math.max(1, startSeconds + windowSeconds - nowSeconds),
  };
}

// Pre-flight gate over usage recorded from terminal snapshots. In-flight jobs reserve call slots
// (rate + active caps), never estimated tokens, so this is a policy limit, not a spend balance.
async function enforceOwnerBudget(db, ctx, settings, { applyOnly }) {
  if (applyOnly || settings.ownerTokenBudget <= 0) return;
  const window = budgetWindow(settings.tokenWindowSeconds);
  if (await recordedUsage(db, ctx, settings, window.startIso) >= settings.ownerTokenBudget) {
    aiFail(429, 'owner_budget_exhausted', { 'Retry-After': String(window.retryAfter) });
  }
}

function tokenCount(usage, key) {
  const n = Number(usage?.[key]);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

// Refreshes the owner's active rows from the runtime before refusing a new job, so work that
// finished while nobody polled stops consuming the active-job cap or hiding recorded usage. The
// scan is bounded; a runtime 404 marks the row interrupted, and other runtime errors leave it as is.
async function reconcileActiveJobs(db, env, ownerId, excludeId, limit) {
  const bound = Math.min(Math.max(Number(limit) || 1, 1), MAX_RECONCILE_ROWS);
  const rows = await db
    .prepare(
      "SELECT id, role, snapshot FROM ai_jobs WHERE owner_id = ?1 AND id <> ?2 AND state IN ('queued', 'running', 'cancelling') ORDER BY created_at LIMIT ?3"
    )
    .bind(ownerId, excludeId, bound)
    .all();
  for (const row of rows.results ?? []) {
    try {
      const runtime = await getRuntimeJob(env, { ownerId, jobId: row.id });
      const snapshot = publicSnapshot(runtime, {
        fallbackId: row.id,
        fallbackRole: row.role,
        includeResult: false,
        ...storedFlags(row),
      });
      if (TERMINAL_STATES.has(snapshot.state)) await persistSnapshot(db, ownerId, snapshot);
    } catch (error) {
      if (error instanceof AiError && error.code === 'not_found') {
        await persistSnapshot(db, ownerId, lostSnapshot(row.id, row.role, nowIso(), storedFlags(row)));
      }
    }
  }
}

// ---- job submission -----------------------------------------------------------------------

const JOB_KEYS = [
  'role', 'prompt', 'uploadId', 'idempotencyKey', 'model', 'effort', 'budget', 'harness',
  'applyOnly', 'edits', 'visualEdits', 'useEvidence',
];
const REQUIRED_JOB_KEYS = ['role', 'prompt', 'uploadId', 'idempotencyKey'];
const BUDGET_KEYS = ['maxCalls'];

function validateJobEnvelope(body) {
  if (!keysWithin(body, JOB_KEYS)) aiFail(400, 'invalid_request');
  for (const required of REQUIRED_JOB_KEYS) {
    if (!Object.hasOwn(body, required)) aiFail(400, 'invalid_request');
  }
  if (!ROLES.includes(body.role)) aiFail(400, 'invalid_request');
  if (typeof body.prompt !== 'string') aiFail(400, 'invalid_request');
  if (typeof body.uploadId !== 'string' || !UUID.test(body.uploadId)) aiFail(400, 'invalid_request');
  if (typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) aiFail(400, 'invalid_request');
}

function normalizePrompt(body, settings) {
  const prompt = body.prompt.normalize('NFC').trim();
  if (!prompt || [...prompt].length > settings.maxPromptChars) aiFail(400, 'invalid_request');
  return prompt;
}

function selectJobModel(body, settings) {
  const model = body.model === undefined ? settings.defaultModel : body.model;
  const effort = body.effort === undefined ? settings.defaultEffort : body.effort;
  if (typeof model !== 'string' || !settings.models.includes(model)) aiFail(400, 'invalid_request');
  if (typeof effort !== 'string' || !settings.efforts.includes(effort)) aiFail(400, 'invalid_request');
  return { model, effort };
}

function readJobFlags(body) {
  if (body.applyOnly !== undefined && typeof body.applyOnly !== 'boolean') aiFail(400, 'invalid_request');
  if (body.useEvidence !== undefined && typeof body.useEvidence !== 'boolean') aiFail(400, 'invalid_request');
  return { applyOnly: body.applyOnly === true, useEvidence: body.useEvidence !== false };
}

function readBudget(body) {
  if (body.budget === undefined) return null;
  if (!isObject(body.budget) || !keysWithin(body.budget, BUDGET_KEYS)) aiFail(400, 'invalid_request');
  return body.budget;
}

function jobMaxCalls(body, settings, applyOnly) {
  const budget = readBudget(body);
  if (applyOnly) {
    // Apply-only performs no model calls: the budget stays in the job contract as an explicit zero.
    if (budget?.maxCalls !== undefined && budget.maxCalls !== 0) aiFail(400, 'invalid_request');
    return 0;
  }
  const requested = budget?.maxCalls;
  if (requested === undefined) return settings.defaultCalls;
  if (!Number.isSafeInteger(requested) || requested < 1) aiFail(400, 'invalid_request');
  return Math.min(requested, settings.maxCallsPerJob);
}

function jobEdits(body, role, applyOnly) {
  const edits = validateEdits(body.edits, role);
  const visualEdits = validateVisualEdits(body.visualEdits, role, applyOnly);
  if (applyOnly) {
    if (role !== 'red') aiFail(400, 'invalid_request');
    if (edits.length + visualEdits.length === 0) aiFail(400, 'invalid_request');
  }
  return { edits, visualEdits };
}

function parseJobRequest(body, settings) {
  validateJobEnvelope(body);
  const prompt = normalizePrompt(body, settings);
  const { model, effort } = selectJobModel(body, settings);
  const { applyOnly, useEvidence } = readJobFlags(body);
  const maxCalls = jobMaxCalls(body, settings, applyOnly);
  const { edits, visualEdits } = jobEdits(body, body.role, applyOnly);
  const harness = validateHarness(body.harness, { role: body.role, prompt, maxCalls, model, effort, settings });
  return {
    role: body.role,
    prompt,
    uploadId: body.uploadId,
    idempotencyKey: body.idempotencyKey,
    model,
    effort,
    applyOnly,
    useEvidence,
    maxCalls,
    edits,
    visualEdits,
    harness,
  };
}

// A duplicate submit is answered from the runtime's live state (a read, never a paid call); if the
// runtime is unreachable or no longer knows the job, the stored snapshot is returned instead.
async function replayJob(db, env, deps, settings, ownerId, row, requestHash) {
  if (!row || row.request_hash !== requestHash) aiFail(409, 'idempotency_conflict');
  const spec = guestFollowSpec(settings, 'read');
  // The cap refusal must escape. A later runtime miss still falls back to the stored snapshot.
  const pair = await claimGuestPair(db, deps, settings, ownerId, spec);
  let snapshot = null;
  let reached = false;
  try {
    const runtime = await getRuntimeJob(env, { ownerId, jobId: row.id });
    reached = true;
    snapshot = publicSnapshot(runtime, {
      fallbackId: row.id,
      fallbackRole: row.role,
      includeResult: true,
      ...storedFlags(row),
    });
    await persistSnapshot(db, ownerId, snapshot);
  } catch {
    if (!reached) await releaseGuestPair(db, deps, spec, pair);
    snapshot = null;
  }
  if (!snapshot) {
    try { snapshot = JSON.parse(row.snapshot); } catch { snapshot = null; }
  }
  if (!isObject(snapshot)) aiFail(503, 'ai_unavailable');
  return json(200, { job: snapshot, replayed: true });
}

function jobHashParts(job) {
  // Plain jobs keep their previous hash; any changed selection becomes a different request.
  const parts = [job.role, job.prompt, job.uploadId, job.model, job.effort, job.maxCalls];
  if (job.applyOnly) parts.push(['applyOnly']);
  if (!job.useEvidence) parts.push(['noEvidence']);
  if (job.edits.length) parts.push(['edits', job.edits]);
  if (job.visualEdits.length) parts.push(['visualEdits', job.visualEdits]);
  return parts;
}

// The unique (owner, idempotency key) insert is the reservation: a duplicate never reaches the
// runtime, and a distinct key on an active-heavy owner is rolled back before it can count.
async function claimGuestJobSlot(db, deps, settings, job) {
  if (settings.guestScope !== true) return null;
  const separated = settings.guestApplyJobsSeparated === true && job.applyOnly === true;
  const bucket = separated ? GUEST_APPLY_JOB_BUCKET : GUEST_JOB_BUCKET;
  const limit = separated ? settings.guestApplyJobsPerHour : settings.guestJobsPerHour;
  const slot = await deps.rateLimit(db, bucket, limit);
  return { bucket, slot };
}

async function releaseGuestJobSlot(db, deps, guestSlot) {
  if (!guestSlot) return;
  await deps.releaseSlot(db, guestSlot.bucket, guestSlot.slot);
}

async function reserveJob(db, env, ctx, deps, settings, job) {
  const requestHash = await sha256Hex(JSON.stringify(jobHashParts(job)));
  // A duplicate key is a read, not a new job. Resolve it before either hourly slot is taken,
  // so a full guest or owner cap still returns the existing job.
  const prior = await db
    .prepare('SELECT id, role, request_hash, snapshot FROM ai_jobs WHERE owner_id = ?1 AND idempotency_key = ?2')
    .bind(ctx.ownerId, job.idempotencyKey)
    .first();
  if (prior) return { replay: await replayJob(db, env, deps, settings, ctx.ownerId, prior, requestHash) };
  const bucket = await bucketKey('ai-job:', ctx.ownerId);
  const slot = await deps.rateLimit(db, bucket, settings.jobsPerOwnerHour);
  let guestSlot = null;
  try {
    guestSlot = await claimGuestJobSlot(db, deps, settings, job);
  } catch (error) {
    await deps.releaseSlot(db, bucket, slot);
    throw error;
  }
  const reservation = {
    requestHash,
    bucket,
    slot,
    guestSlot,
    jobId: await jobIdFor(ctx.ownerId, job.idempotencyKey, requestHash),
  };
  const at = nowIso();
  const queued = queuedSnapshot({
    id: reservation.jobId,
    role: job.role,
    model: job.model,
    effort: job.effort,
    maxCalls: job.maxCalls,
    at,
    applyOnly: job.applyOnly,
    useEvidence: job.useEvidence,
  });
  const reserved = await db
    .prepare(
      `INSERT INTO ai_jobs (id, owner_id, role, idempotency_key, request_hash, upload_id, model, effort, state, snapshot, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', ?9, ?10, ?10)
       ON CONFLICT (owner_id, idempotency_key) DO NOTHING`
    )
    .bind(
      reservation.jobId, ctx.ownerId, job.role, job.idempotencyKey, requestHash,
      job.uploadId, job.model, job.effort, JSON.stringify(queued), at
    )
    .run();
  if (reserved.meta.changes === 1) return { reservation };
  await deps.releaseSlot(db, bucket, slot);
  await releaseGuestJobSlot(db, deps, guestSlot);
  const row = await db
    .prepare('SELECT id, role, request_hash, snapshot FROM ai_jobs WHERE owner_id = ?1 AND idempotency_key = ?2')
    .bind(ctx.ownerId, job.idempotencyKey)
    .first();
  return { replay: await replayJob(db, env, deps, settings, ctx.ownerId, row, requestHash) };
}

async function rollbackReservation(db, deps, ownerId, reservation) {
  try {
    await db.prepare('DELETE FROM ai_jobs WHERE id = ?1 AND owner_id = ?2').bind(reservation.jobId, ownerId).run();
  } catch { /* the row is inert until a runtime snapshot confirms it */ }
  await deps.releaseSlot(db, reservation.bucket, reservation.slot);
  await releaseGuestJobSlot(db, deps, reservation.guestSlot);
}

async function activeJobCount(db, ownerId) {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM ai_jobs WHERE owner_id = ?1 AND state IN ('queued', 'running', 'cancelling')")
    .bind(ownerId)
    .first();
  return Number(row?.count ?? 0);
}

// The policy gate runs only for a new job: a duplicate replay above creates no spend and is never
// blocked. Refresh this owner's active rows first so an unpolled but finished job cannot hide its
// recorded usage. Apply-only makes no model calls and skips the gate entirely.
async function applyJobPolicy(db, env, ctx, deps, settings, job, reservation) {
  if (!job.applyOnly && settings.ownerTokenBudget > 0) {
    await reconcileActiveJobs(db, env, ctx.ownerId, reservation.jobId, settings.activeJobsPerOwner + 5);
  }
  try {
    await enforceOwnerBudget(db, ctx, settings, { applyOnly: job.applyOnly });
  } catch (error) {
    await rollbackReservation(db, deps, ctx.ownerId, reservation);
    throw error;
  }
  let active = await activeJobCount(db, ctx.ownerId);
  if (active > settings.activeJobsPerOwner) {
    // A bounded reconcile frees rows the runtime already finished; a 404 marks a lost job
    // interrupted, and other runtime errors leave the row unchanged.
    await reconcileActiveJobs(db, env, ctx.ownerId, reservation.jobId, settings.activeJobsPerOwner + 5);
    active = await activeJobCount(db, ctx.ownerId);
  }
  if (active > settings.activeJobsPerOwner) {
    await rollbackReservation(db, deps, ctx.ownerId, reservation);
    aiFail(429, 'rate_limited', { 'Retry-After': '60' });
  }
}

// Defaults that the runtime already assumes are omitted so plain jobs keep the exact previous wire
// shape; the new keys appear only when the request actually uses them.
function runtimeJobPayload(job, reservation, upload, ownerId) {
  const payload = {
    jobId: reservation.jobId,
    ownerId,
    idempotencyKey: job.idempotencyKey,
    requestHash: reservation.requestHash,
    role: job.role,
    prompt: job.prompt,
    uploadId: upload.runtime_upload_id,
    model: job.model,
    effort: job.effort,
    budget: { maxCalls: job.maxCalls },
    harness: job.harness,
  };
  if (job.applyOnly) payload.applyOnly = true;
  if (!job.useEvidence) payload.useEvidence = false;
  if (job.edits.length) payload.edits = job.edits;
  if (job.visualEdits.length) payload.visualEdits = job.visualEdits;
  return payload;
}

async function submitJobToRuntime(db, env, ctx, deps, job, upload, reservation) {
  let result;
  try {
    result = await createRuntimeJob(env, {
      ownerId: ctx.ownerId,
      payload: runtimeJobPayload(job, reservation, upload, ctx.ownerId),
    });
  } catch (error) {
    // No accepted job is reported as accepted. The gateway index row is rolled back so the client
    // can retry; the runtime deduplicates (ownerId, idempotencyKey) and the same hash, so a retry
    // cannot buy a second paid call.
    await rollbackReservation(db, deps, ctx.ownerId, reservation);
    throw error;
  }
  const snapshot = publicSnapshot(result.snapshot, {
    fallbackId: reservation.jobId,
    fallbackRole: job.role,
    includeResult: true,
    fallbackApplyOnly: job.applyOnly,
    fallbackUseEvidence: job.useEvidence,
  });
  await persistSnapshot(db, ctx.ownerId, snapshot);
  return json(result.status === 200 ? 200 : 202, { job: snapshot, replayed: false });
}

async function createJob(ctx) {
  const { request, env, settings, deps } = ctx;
  const db = deps.getDb();
  const job = parseJobRequest(await readJsonBody(request, MAX_JOB_BODY_BYTES), settings);
  // Guest BLUE, then guest model jobs, then the operator-only gate. Each one stops before
  // upload lookup, a rate slot or a runtime call. A disabled BLUE job keeps its own code.
  if (settings.guestScope === true && settings.guestBlue === false && job.role === 'blue') {
    aiFail(403, 'guest_blue_disabled');
  }
  if (settings.guestScope === true && settings.guestModelJobs === false && !(job.role === 'red' && job.applyOnly === true)) {
    aiFail(403, 'guest_model_disabled');
  }
  if (settings.modelJobsOperatorOnly === true && !isOperatorOwner(ctx.ownerId) && !(job.role === 'red' && job.applyOnly === true)) {
    aiFail(403, 'model_jobs_operator_only');
  }
  // The upload must exist and belong to this owner before the runtime is involved.
  const upload = await db
    .prepare('SELECT runtime_upload_id FROM ai_uploads WHERE id = ?1 AND owner_id = ?2')
    .bind(job.uploadId, ctx.ownerId)
    .first();
  if (!upload) aiFail(400, 'invalid_request');
  const reserved = await reserveJob(db, env, ctx, deps, settings, job);
  if (reserved.replay) return reserved.replay;
  await applyJobPolicy(db, env, ctx, deps, settings, job, reserved.reservation);
  return submitJobToRuntime(db, env, ctx, deps, job, upload, reserved.reservation);
}

async function ownedJob(db, ctx) {
  if (!UUID.test(ctx.params.id)) aiFail(404, 'not_found');
  const row = await db
    .prepare('SELECT id, role, snapshot FROM ai_jobs WHERE id = ?1 AND owner_id = ?2')
    .bind(ctx.params.id, ctx.ownerId)
    .first();
  // Foreign and missing jobs are indistinguishable.
  if (!row) aiFail(404, 'not_found');
  return row;
}

// A runtime 404 for a job this gateway owns lost its state. Persist the terminal "interrupted"
// snapshot so status and cancel stop retrying, and return it instead of a permanent 503. An
// unreachable runtime is still a 503.
async function runtimeJobSnapshot(db, ownerId, row, call) {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof AiError) || error.code !== 'not_found') throw error;
    const snapshot = lostSnapshot(row.id, row.role, nowIso(), { ...storedFlags(row), ...storedCatalog(row) });
    await persistSnapshot(db, ownerId, snapshot);
    return snapshot;
  }
}

async function getJob(ctx) {
  const db = ctx.deps.getDb();
  const row = await ownedJob(db, ctx);
  const runtime = await guestRuntime(db, ctx.deps, ctx.settings, ctx.ownerId, guestFollowSpec(ctx.settings, 'read'), () =>
    runtimeJobSnapshot(db, ctx.ownerId, row, () => getRuntimeJob(ctx.env, { ownerId: ctx.ownerId, jobId: row.id })));
  const snapshot = publicSnapshot(runtime, {
    fallbackId: row.id,
    fallbackRole: row.role,
    includeResult: true,
    ...storedFlags(row),
  });
  await persistSnapshot(db, ctx.ownerId, snapshot);
  return json(200, { job: snapshot });
}

async function cancelJob(ctx) {
  const db = ctx.deps.getDb();
  const row = await ownedJob(db, ctx);
  const runtime = await guestRuntime(db, ctx.deps, ctx.settings, ctx.ownerId, guestFollowSpec(ctx.settings, 'read'), () =>
    runtimeJobSnapshot(db, ctx.ownerId, row, () => cancelRuntimeJob(ctx.env, { ownerId: ctx.ownerId, jobId: row.id })));
  const snapshot = publicSnapshot(runtime, {
    fallbackId: row.id,
    fallbackRole: row.role,
    includeResult: true,
    ...storedFlags(row),
  });
  await persistSnapshot(db, ctx.ownerId, snapshot);
  return json(202, { job: snapshot });
}

function safeMime(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase().split(';')[0].trim() : '';
  return /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/.test(text) ? text : 'application/octet-stream';
}

function safeFilename(value, artifactId) {
  const match = typeof value === 'string' ? /filename="?([^";\\]{1,200})"?/i.exec(value) : null;
  const raw = match ? match[1].normalize('NFC').trim() : '';
  const name = raw.replace(/[^A-Za-z0-9 ._()-]/g, '_').slice(0, 120).trim();
  return name || `artifact-${artifactId}`;
}

async function getArtifact(ctx) {
  const db = ctx.deps.getDb();
  const row = await ownedJob(db, ctx);
  const artifactId = String(ctx.params.artifactId || '');
  if (!ARTIFACT_ID.test(artifactId)) aiFail(404, 'not_found');
  const response = await guestRuntime(db, ctx.deps, ctx.settings, ctx.ownerId, guestFollowSpec(ctx.settings, 'artifact'), () =>
    getRuntimeArtifact(ctx.env, { ownerId: ctx.ownerId, jobId: row.id, artifactId }));
  return new Response(response.body, {
    status: 200,
    headers: {
      'Content-Type': safeMime(response.headers.get('Content-Type')),
      'Content-Disposition': `attachment; filename="${safeFilename(response.headers.get('Content-Disposition'), artifactId)}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const GUEST_BODY_BYTES = 1024;

function base64url(bytes) {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function guestAccessKey(body) {
  if (Object.keys(body).some(key => key !== 'accessKey')) aiFail(400, 'invalid_request');
  if (!Object.hasOwn(body, 'accessKey')) return '';
  const value = body.accessKey;
  if (typeof value !== 'string' || [...value].length > 128) aiFail(400, 'invalid_request');
  return value;
}

async function sameAccessKey(secret, presented) {
  const encode = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [left, right] = await Promise.all([encode(secret), encode(presented)]);
  return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}

async function assertAccessKey(settings, presented) {
  if (!settings.openAccessKey) return;
  if (!await sameAccessKey(settings.openAccessKey, presented)) aiFail(403, 'invalid_access_key');
}

async function insertGuestSession(db, settings) {
  const guestId = crypto.randomUUID();
  const token = 'fsg_' + base64url(crypto.getRandomValues(new Uint8Array(32)));
  const nowMs = Date.now();
  const expiresAt = nowMs + settings.guestSessionSeconds * 1000;
  await db.prepare(
    'INSERT INTO guest_sessions (token_hash, guest_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)'
  ).bind(await sha256Hex(token), guestId, nowMs, expiresAt).run();
  return json(201, { guest: { token, expiresAt: new Date(expiresAt).toISOString() } });
}

// Minting is public. The IP and global caps run before the key check and before any insert,
// so a guess cannot create a row and cannot probe the key without spending a slot.
async function createGuest(ctx) {
  const { request, settings, deps } = ctx;
  if (!settings.openAccess) aiFail(403, 'open_access_disabled');
  const presented = guestAccessKey(await readJsonBody(request, GUEST_BODY_BYTES));
  const db = deps.getDb();
  await deps.rateLimit(db, await bucketKey('guest:ip:', deps.clientIp()), settings.guestsPerIpHour);
  await deps.rateLimit(db, 'guest:all', settings.guestsPerHour);
  await assertAccessKey(settings, presented);
  return insertGuestSession(db, settings);
}

// CONTRACT-W19 item 1. Same paths the companion already serves; anything else never reaches the runtime.
const PAPER_PATHS = [
  /^\/api\/paper\/evidence\/prepare$/,
  /^\/api\/paper\/evidence\/query$/,
  /^\/api\/paper\/visual\/export$/,
  /^\/api\/paper\/chart\/prepare$/,
  /^\/api\/paper\/evidence\/jobs$/,
  /^\/api\/paper\/evidence\/jobs\/[a-f0-9]{32}$/,
  /^\/api\/paper\/evidence\/jobs\/[a-f0-9]{32}\/cancel$/,
];
const RUNTIME_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function allowedPaperPath(path) {
  return typeof path === 'string' && PAPER_PATHS.some(pattern => pattern.test(path));
}

// Only evidence prepare uploads a PDF; chart prepare works on an already prepared paper and counts
// as an ordinary call, so editing several charts does not use up the prepare limit.
function paperPrepare(path) {
  return path === '/api/paper/evidence/prepare';
}

function paperRequest(body) {
  if (!isObject(body)) aiFail(400, 'invalid_request');
  const keys = Object.keys(body);
  if (keys.some(key => key !== 'path' && key !== 'body')) aiFail(400, 'invalid_request');
  if (!Object.hasOwn(body, 'path') || !Object.hasOwn(body, 'body')) aiFail(400, 'invalid_request');
  if (!allowedPaperPath(body.path)) aiFail(404, 'paper_path_unsupported');
  if (body.body !== null && !isObject(body.body)) aiFail(400, 'invalid_request');
  return { path: body.path, body: body.body };
}

function base64DecodedLength(value) {
  if (typeof value !== 'string') return -1;
  if (value.length === 0) return 0;
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - pad;
}

function assertPrepareSize(path, inner, maxBytes) {
  if (!paperPrepare(path) || !isObject(inner) || !Object.hasOwn(inner, 'file')) return;
  const decoded = base64DecodedLength(inner.file);
  if (decoded < 0) aiFail(400, 'invalid_request');
  if (decoded > maxBytes) aiFail(413, 'payload_too_large');
}

async function reservePaper(db, deps, settings, ownerId, prepare) {
  const callBucket = await bucketKey('ai-paper-call:', ownerId);
  const callSlot = await deps.rateLimit(db, callBucket, settings.paperCallsPerHour);
  let globalSlot;
  try {
    globalSlot = await deps.rateLimit(db, 'ai-paper-calls:all', settings.paperCallsGlobalPerHour);
  } catch (error) {
    await deps.releaseSlot(db, callBucket, callSlot);
    throw error;
  }
  if (!prepare) return;
  try {
    const prepareBucket = await bucketKey('ai-paper-prepare:', ownerId);
    await deps.rateLimit(db, prepareBucket, settings.paperPreparesPerHour);
  } catch (error) {
    await deps.releaseSlot(db, 'ai-paper-calls:all', globalSlot);
    await deps.releaseSlot(db, callBucket, callSlot);
    throw error;
  }
}

function runtimeCode(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return ''; }
  const code = isObject(parsed) && isObject(parsed.error) ? parsed.error.code : '';
  return typeof code === 'string' && RUNTIME_CODE.test(code) ? code : '';
}

function paperSuccess(status, text) {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function paperFailure(status, text, requestId) {
  const code = runtimeCode(text);
  if (!code || status < 400 || status > 599) return errorResponse(new AiError(502, 'runtime_unavailable'), requestId);
  return json(status, {
    error: {
      code,
      message: MESSAGES[code] || 'The paper request was rejected.',
      requestId,
      retryable: code === 'paper_busy' || RETRYABLE.has(code),
    },
  });
}

async function createPaper(ctx) {
  const envelope = paperRequest(await readJsonBody(ctx.request, ctx.settings.paperMaxBodyBytes));
  assertPrepareSize(envelope.path, envelope.body, ctx.settings.maxUploadBytes);
  await reservePaper(ctx.deps.getDb(), ctx.deps, ctx.settings, ctx.ownerId, paperPrepare(envelope.path));
  const result = await postRuntimePaper(ctx.env, {
    ownerId: ctx.ownerId,
    path: envelope.path,
    body: envelope.body,
  });
  if (result.status >= 200 && result.status < 300) return paperSuccess(result.status, result.text);
  return paperFailure(result.status, result.text, ctx.requestId);
}

function paperRouteOpen(template, settings) {
  if (template !== '/v1/ai/paper') return false;
  if (!settings.paperTools) aiFail(404, 'paper_tools_disabled');
  return true;
}

const AI_ROUTES = {
  '/v1/ai/capabilities': { GET: ctx => capabilitiesResponse(ctx.settings) },
  '/v1/ai/guest': { POST: ctx => createGuest(ctx) },
  '/v1/ai/uploads': { POST: ctx => createUpload(ctx) },
  '/v1/ai/jobs': { POST: ctx => createJob(ctx) },
  '/v1/ai/jobs/:id': { GET: ctx => getJob(ctx) },
  '/v1/ai/jobs/:id/cancel': { POST: ctx => cancelJob(ctx) },
  '/v1/ai/jobs/:id/artifacts/:artifactId': { GET: ctx => getArtifact(ctx) },
  '/v1/ai/paper': { POST: ctx => createPaper(ctx) },
};

export function matchAi(pathname) {
  if (Object.hasOwn(AI_ROUTES, pathname)) return { template: pathname, params: { id: null, artifactId: null } };
  const cancel = /^\/v1\/ai\/jobs\/([^/]+)\/cancel$/.exec(pathname);
  if (cancel) return { template: '/v1/ai/jobs/:id/cancel', params: { id: cancel[1], artifactId: null } };
  const artifact = /^\/v1\/ai\/jobs\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
  if (artifact) return { template: '/v1/ai/jobs/:id/artifacts/:artifactId', params: { id: artifact[1], artifactId: artifact[2] } };
  const job = /^\/v1\/ai\/jobs\/([^/]+)$/.exec(pathname);
  if (job) return { template: '/v1/ai/jobs/:id', params: { id: job[1], artifactId: null } };
  if (pathname.startsWith('/v1/ai/')) return { template: '/v1/ai/unknown', params: { id: null, artifactId: null } };
  return null;
}

function allowMethods(template) {
  return template === '/v1/ai/guest' ? 'POST, OPTIONS' : AI_ALLOW_METHODS;
}

function bearerToken(request) {
  const header = request.headers.get('Authorization');
  if (header === null) return '';
  const match = /^Bearer (\S+)$/.exec(header);
  return match ? match[1] : '';
}

// A valid operator bearer is recognized without D1. A wrong fso_ stays on the public 200.
async function optionalOperator(ctx) {
  const token = bearerToken(ctx.request);
  if (!token.startsWith('fso_')) return false;
  try {
    await resolveOperatorOwner(ctx.env, token);
    return true;
  } catch {
    return false;
  }
}

// Invalid, expired and non-guest bearers keep the public 200. Only a live guest session changes limits.
async function optionalGuestOwner(ctx, settings) {
  if (settings.openAccess !== true) return null;
  const token = bearerToken(ctx.request);
  if (!token.startsWith('fsg_')) return null;
  if (typeof ctx.deps?.getDb !== 'function') return null;
  try {
    return await resolveGuestOwner(ctx.deps.getDb(), token, Date.now());
  } catch {
    return null;
  }
}

async function publicCapabilities(ctx, settings) {
  if (ctx.request.method !== 'GET') aiFail(405, 'method_not_allowed', { Allow: 'GET' });
  // The operator page must still see that BLUE and model jobs exist for the operator.
  if (await optionalOperator(ctx)) return capabilitiesResponse(settings, true);
  const guest = await optionalGuestOwner(ctx, settings);
  const view = guest ? effectiveAiSettings(settings, guest.ownerId) : settings;
  return capabilitiesResponse(view);
}

function aiHandler(ctx, settings, requestId, owner) {
  const route = AI_ROUTES[ctx.match.template];
  if (!route) aiFail(404, 'not_found');
  const handler = route[ctx.request.method];
  if (!handler) aiFail(405, 'method_not_allowed', { Allow: Object.keys(route).join(', ') });
  const bound = owner ? effectiveAiSettings(settings, owner.ownerId) : settings;
  return handler({ ...ctx, settings: bound, ownerId: owner ? owner.ownerId : undefined, requestId });
}

// ctx: { request, env, url, match, fetchImpl, deps: { getDb, rateLimit, releaseSlot, authenticatePassword, clientIp } }
export async function handleAiRequest(ctx) {
  const requestId = newRequestId();
  let refreshed = null;
  try {
    const settings = aiSettings(ctx.env);
    if (ctx.request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Methods': allowMethods(ctx.match.template),
          'Access-Control-Allow-Headers': AI_ALLOW_HEADERS,
          'Access-Control-Max-Age': '600',
          'Cache-Control': 'no-store',
        },
      });
    }
    // Capabilities stay public. Unsigned and non-guest callers get the deployment catalog and do
    // not touch D1. A valid guest bearer is the one case that reads the session, and only to
    // report that guest's upload cap through the existing limits object.
    if (ctx.match.template === '/v1/ai/capabilities') return publicCapabilities(ctx, settings);
    // Paper tools have their own kill switch and do not spend a model budget, so hosting can stay off.
    // Off: 404 before auth and before any runtime call. On: the same owner resolution as /v1/ai/jobs.
    const paperOpen = paperRouteOpen(ctx.match.template, settings);
    if (!paperOpen && !settings.enabled) aiFail(404, 'not_found');
    // Guest minting is unsigned. Every other route resolves one owner first.
    const owner = ctx.match.template === '/v1/ai/guest' ? null : await resolveAiOwner({
      request: ctx.request,
      env: ctx.env,
      authenticatePassword: ctx.deps.authenticatePassword,
      getDb: ctx.deps.getDb,
      fetchImpl: ctx.fetchImpl,
    });
    refreshed = owner ? owner.refreshed : null;
    const response = await aiHandler(ctx, settings, requestId, owner);
    return withRefreshed(response, refreshed);
  } catch (error) {
    const known = toAiError(error);
    if (!(error instanceof AiError) && known.code === 'internal_error') {
      // Only the name is logged: messages can carry SQL, tokens or payload fragments.
      console.error(JSON.stringify({ event: 'unhandled_ai_error', route: ctx.match?.template || 'unknown', name: error?.name || 'unknown' }));
    }
    return withRefreshed(errorResponse(known, requestId), refreshed);
  }
}
