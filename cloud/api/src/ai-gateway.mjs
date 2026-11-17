// Hosted AI gateway (contract docs/hosted-ai-contract-20261117.md).
// Authenticates one stable owner, keeps an idempotent job index in D1 and proxies every execution
// to the container-internal runtime. No prompt, upload bytes or provider error text is stored here.
import { SESSION_HEADER } from './confluence.mjs';
import { AiError, aiFail, hostingEnabled, resolveAiOwner, sha256Hex } from './ai-identity.mjs';
import {
  cancelRuntimeJob,
  createRuntimeJob,
  createRuntimeUpload,
  getRuntimeArtifact,
  getRuntimeJob,
} from './ai-runtime-client.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ARTIFACT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const MODEL_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;
const EFFORT_TOKEN = /^[a-z]{1,16}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_JOB_BODY_BYTES = 64 * 1024;
const MAX_UPLOAD_BOUND = 64 * 1024 * 1024;
const ROLES = ['red', 'blue'];
const STATES = ['queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'interrupted'];
const DEFAULT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Fixed upload allowlist. Anything else is 415 before a byte is forwarded.
const MIME_TYPES = ['application/pdf', 'application/octet-stream', 'text/plain'];
const CONTROL = /[\u0000-\u001f\u007f]/;

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
  idempotency_conflict: 'This idempotency key is already used for a different request.',
  ai_unavailable: 'Hosted AI execution is temporarily unavailable.',
  internal_error: 'Internal error.',
};
const RETRYABLE = new Set(['rate_limited', 'ai_unavailable', 'internal_error']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function csv(value, fallback, pattern) {
  const items = String(value || '').split(',').map(item => item.trim()).filter(item => pattern.test(item));
  return items.length ? [...new Set(items)] : fallback.slice();
}

export function aiSettings(env) {
  const maxCallsPerJob = Math.min(positiveInt(env?.AI_MAX_CALLS_PER_JOB, 24), 64);
  const models = csv(env?.AI_MODELS, DEFAULT_MODELS, MODEL_TOKEN);
  const efforts = csv(env?.AI_EFFORTS, DEFAULT_EFFORTS, EFFORT_TOKEN);
  const requestedModel = String(env?.AI_DEFAULT_MODEL || '');
  const requestedEffort = String(env?.AI_DEFAULT_EFFORT || '');
  return {
    enabled: hostingEnabled(env),
    maxUploadBytes: Math.min(positiveInt(env?.AI_MAX_UPLOAD_BYTES, 32 * 1024 * 1024), MAX_UPLOAD_BOUND),
    maxPromptChars: Math.min(positiveInt(env?.AI_MAX_PROMPT_CHARS, 8000), 100000),
    maxCallsPerJob,
    defaultCalls: Math.min(positiveInt(env?.AI_DEFAULT_CALLS, 12), maxCallsPerJob),
    uploadsPerOwnerHour: positiveInt(env?.AI_UPLOADS_PER_OWNER_HOUR, 60),
    jobsPerOwnerHour: positiveInt(env?.AI_JOBS_PER_OWNER_HOUR, 20),
    activeJobsPerOwner: positiveInt(env?.AI_ACTIVE_JOBS_PER_OWNER, 3),
    models,
    efforts,
    defaultModel: models.includes(requestedModel) ? requestedModel : models[0],
    defaultEffort: efforts.includes(requestedEffort) ? requestedEffort : (efforts.includes('high') ? 'high' : efforts[0]),
    mimeTypes: MIME_TYPES.slice(),
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
  let created;
  try {
    created = await createRuntimeUpload(env, { ownerId: ctx.ownerId, name, mime, bytes });
  } catch (error) {
    await deps.releaseSlot(db, bucket, slot);
    throw error;
  }
  if (typeof created.upload.sha256 === 'string' && HASH.test(created.upload.sha256) && created.upload.sha256 !== sha256) {
    await deps.releaseSlot(db, bucket, slot);
    aiFail(503, 'ai_unavailable');
  }
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

function capabilitiesResponse(settings) {
  return json(200, {
    enabled: settings.enabled,
    provider: 'anthropic',
    execution: 'server',
    models: settings.models,
    efforts: settings.efforts,
    limits: { maxUploadBytes: settings.maxUploadBytes, maxPromptChars: settings.maxPromptChars },
  });
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
function publicSnapshot(value, { fallbackId, fallbackRole, includeResult }) {
  if (!isObject(value) || !STATES.includes(value.state)) aiFail(503, 'ai_unavailable');
  const snapshot = {
    id: typeof value.id === 'string' && UUID.test(value.id) ? value.id : fallbackId,
    role: value.role === 'blue' ? 'blue' : (value.role === 'red' ? 'red' : fallbackRole),
    state: value.state,
  };
  const progress = progressView(value.progress);
  if (progress) snapshot.progress = progress;
  const model = shortString(value.model, 64);
  const effort = shortString(value.effort, 16);
  if (model) snapshot.model = model;
  if (effort) snapshot.effort = effort;
  snapshot.provider = 'anthropic';
  const usage = usageView(value.usage);
  if (usage) snapshot.usage = usage;
  const artifacts = artifactList(value.artifacts);
  if (artifacts) snapshot.artifacts = artifacts;
  const createdAt = shortString(value.createdAt, 40);
  const updatedAt = shortString(value.updatedAt, 40);
  if (createdAt) snapshot.createdAt = createdAt;
  if (updatedAt) snapshot.updatedAt = updatedAt;
  if (includeResult && isObject(value.result)) snapshot.result = value.result;
  const failure = isObject(value.failure) ? failureView(value.failure) : null;
  if (failure) snapshot.failure = failure;
  const completedAt = shortString(value.completedAt, 40);
  if (completedAt) snapshot.completedAt = completedAt;
  return snapshot;
}

function queuedSnapshot({ id, role, model, effort, maxCalls, at }) {
  return {
    id,
    role,
    state: 'queued',
    progress: { completedCalls: 0, requiredCalls: maxCalls, phase: 'queued' },
    model,
    effort,
    provider: 'anthropic',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    artifacts: [],
    createdAt: at,
    updatedAt: at,
  };
}

// Best-effort index refresh: a status read must not fail because the local index write failed.
async function persistSnapshot(db, ownerId, snapshot) {
  const stored = publicSnapshot(snapshot, {
    fallbackId: snapshot.id,
    fallbackRole: snapshot.role,
    includeResult: false,
  });
  try {
    await db
      .prepare('UPDATE ai_jobs SET state = ?1, snapshot = ?2, updated_at = ?3, completed_at = ?4 WHERE id = ?5 AND owner_id = ?6')
      .bind(stored.state, JSON.stringify(stored), stored.updatedAt ?? nowIso(), stored.completedAt ?? null, stored.id, ownerId)
      .run();
  } catch { /* the runtime remains the source of truth */ }
}

// The client harness may only restate server-allowlisted values; whatever it sends, the runtime
// receives the canonical hosted shape without endpoints, paths, credentials or code.
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
  if (!isObject(value)) aiFail(400, 'invalid_request');
  const allowed = ['schema', 'id', 'name', 'version', 'role', 'instructions', 'maxCalls', 'adapter'];
  if (Object.keys(value).some(key => !allowed.includes(key))) aiFail(400, 'invalid_request');
  if (value.schema !== undefined && value.schema !== 'falsify.harness.v1') aiFail(400, 'invalid_request');
  if (value.role !== undefined && value.role !== role) aiFail(400, 'invalid_request');
  if (value.adapter !== undefined) {
    if (!isObject(value.adapter) || Object.keys(value.adapter).some(key => !['type', 'model', 'effort'].includes(key))) {
      aiFail(400, 'invalid_request');
    }
    if (value.adapter.type !== 'hosted') aiFail(400, 'invalid_request');
    if (value.adapter.model !== undefined && !settings.models.includes(value.adapter.model)) aiFail(400, 'invalid_request');
    if (value.adapter.effort !== undefined && !settings.efforts.includes(value.adapter.effort)) aiFail(400, 'invalid_request');
  }
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

// Refreshes the owner's active rows from the runtime before refusing a new job, so work that
// finished while nobody polled stops consuming the active-job cap. The scan is bounded, and a
// runtime error leaves that row exactly as it was.
async function reconcileActiveJobs(db, env, ownerId, excludeId, limit) {
  const bound = Math.min(Math.max(Number(limit) || 1, 1), MAX_RECONCILE_ROWS);
  const rows = await db
    .prepare(
      "SELECT id, role FROM ai_jobs WHERE owner_id = ?1 AND id <> ?2 AND state IN ('queued', 'running', 'cancelling') ORDER BY created_at LIMIT ?3"
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
      });
      if (TERMINAL_STATES.has(snapshot.state)) await persistSnapshot(db, ownerId, snapshot);
    } catch { /* reconciliation is best-effort; the index row is unchanged */ }
  }
}

async function createJob(ctx) {
  const { request, env, settings, deps } = ctx;
  const db = deps.getDb();
  const body = await readJsonBody(request, MAX_JOB_BODY_BYTES);
  const keys = Object.keys(body);
  const allowed = ['role', 'prompt', 'uploadId', 'idempotencyKey', 'model', 'effort', 'budget', 'harness'];
  if (keys.some(key => !allowed.includes(key))) aiFail(400, 'invalid_request');
  for (const required of ['role', 'prompt', 'uploadId', 'idempotencyKey']) {
    if (!Object.hasOwn(body, required)) aiFail(400, 'invalid_request');
  }
  if (!ROLES.includes(body.role)) aiFail(400, 'invalid_request');
  if (typeof body.prompt !== 'string') aiFail(400, 'invalid_request');
  const prompt = body.prompt.normalize('NFC').trim();
  if (!prompt || [...prompt].length > settings.maxPromptChars) aiFail(400, 'invalid_request');
  if (typeof body.uploadId !== 'string' || !UUID.test(body.uploadId)) aiFail(400, 'invalid_request');
  if (typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) aiFail(400, 'invalid_request');
  const model = body.model === undefined ? settings.defaultModel : body.model;
  const effort = body.effort === undefined ? settings.defaultEffort : body.effort;
  if (typeof model !== 'string' || !settings.models.includes(model)) aiFail(400, 'invalid_request');
  if (typeof effort !== 'string' || !settings.efforts.includes(effort)) aiFail(400, 'invalid_request');
  let maxCalls = settings.defaultCalls;
  if (body.budget !== undefined) {
    if (!isObject(body.budget)) aiFail(400, 'invalid_request');
    if (Object.keys(body.budget).some(key => key !== 'maxCalls')) aiFail(400, 'invalid_request');
    if (body.budget.maxCalls !== undefined) {
      if (!Number.isSafeInteger(body.budget.maxCalls) || body.budget.maxCalls < 1) aiFail(400, 'invalid_request');
      maxCalls = Math.min(body.budget.maxCalls, settings.maxCallsPerJob);
    }
  }
  const harness = validateHarness(body.harness, { role: body.role, prompt, maxCalls, model, effort, settings });
  // The upload must exist and belong to this owner before the runtime is involved.
  const upload = await db
    .prepare('SELECT runtime_upload_id FROM ai_uploads WHERE id = ?1 AND owner_id = ?2')
    .bind(body.uploadId, ctx.ownerId)
    .first();
  if (!upload) aiFail(400, 'invalid_request');
  // Prompt text is hashed for idempotency and forwarded, never written to D1.
  const requestHash = await sha256Hex(JSON.stringify([body.role, prompt, body.uploadId, model, effort, maxCalls]));
  const bucket = await bucketKey('ai-job:', ctx.ownerId);
  const slot = await deps.rateLimit(db, bucket, settings.jobsPerOwnerHour);
  const jobId = await jobIdFor(ctx.ownerId, body.idempotencyKey, requestHash);
  const at = nowIso();
  const queued = queuedSnapshot({ id: jobId, role: body.role, model, effort, maxCalls, at });
  // The unique (owner, idempotency key) insert is the reservation: a duplicate never reaches the
  // runtime, and a distinct key on an active-heavy owner is rolled back before it can count.
  const reserved = await db
    .prepare(
      `INSERT INTO ai_jobs (id, owner_id, role, idempotency_key, request_hash, upload_id, model, effort, state, snapshot, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', ?9, ?10, ?10)
       ON CONFLICT (owner_id, idempotency_key) DO NOTHING`
    )
    .bind(jobId, ctx.ownerId, body.role, body.idempotencyKey, requestHash, body.uploadId, model, effort, JSON.stringify(queued), at)
    .run();
  if (reserved.meta.changes !== 1) {
    await deps.releaseSlot(db, bucket, slot);
    const row = await db
      .prepare('SELECT id, role, request_hash, snapshot FROM ai_jobs WHERE owner_id = ?1 AND idempotency_key = ?2')
      .bind(ctx.ownerId, body.idempotencyKey)
      .first();
    if (row && row.request_hash === requestHash) {
      // A duplicate submit is answered from the runtime's live state, which is a read: it can never
      // buy another paid call. If the runtime is unreachable (or no longer knows the job), fall back
      // to the stored snapshot below.
      let snapshot = null;
      try {
        const runtime = await getRuntimeJob(env, { ownerId: ctx.ownerId, jobId: row.id });
        snapshot = publicSnapshot(runtime, {
          fallbackId: row.id,
          fallbackRole: row.role,
          includeResult: true,
        });
        await persistSnapshot(db, ctx.ownerId, snapshot);
      } catch {
        snapshot = null;
      }
      if (!snapshot) {
        try { snapshot = JSON.parse(row.snapshot); } catch { snapshot = null; }
      }
      if (!isObject(snapshot)) aiFail(503, 'ai_unavailable');
      return json(200, { job: snapshot, replayed: true });
    }
    aiFail(409, 'idempotency_conflict');
  }
  let active = await db
    .prepare("SELECT COUNT(*) AS count FROM ai_jobs WHERE owner_id = ?1 AND state IN ('queued', 'running', 'cancelling')")
    .bind(ctx.ownerId)
    .first();
  if ((active?.count ?? 0) > settings.activeJobsPerOwner) {
    // Jobs that finished while nobody polled must not hold the active-job cap forever. Reconcile a
    // bounded set of this owner's active rows, then re-count. Runtime errors leave rows unchanged.
    await reconcileActiveJobs(db, env, ctx.ownerId, jobId, settings.activeJobsPerOwner + 5);
    active = await db
      .prepare("SELECT COUNT(*) AS count FROM ai_jobs WHERE owner_id = ?1 AND state IN ('queued', 'running', 'cancelling')")
      .bind(ctx.ownerId)
      .first();
  }
  if ((active?.count ?? 0) > settings.activeJobsPerOwner) {
    await db.prepare('DELETE FROM ai_jobs WHERE id = ?1 AND owner_id = ?2').bind(jobId, ctx.ownerId).run();
    await deps.releaseSlot(db, bucket, slot);
    aiFail(429, 'rate_limited', { 'Retry-After': '60' });
  }
  let result;
  try {
    result = await createRuntimeJob(env, {
      ownerId: ctx.ownerId,
      payload: {
        jobId,
        ownerId: ctx.ownerId,
        idempotencyKey: body.idempotencyKey,
        requestHash,
        role: body.role,
        prompt,
        uploadId: upload.runtime_upload_id,
        model,
        effort,
        budget: { maxCalls },
        harness,
      },
    });
  } catch (error) {
    // No accepted job is reported as accepted. The gateway index row is rolled back so the client
    // can retry; the runtime deduplicates (ownerId, idempotencyKey) and the same hash, so a retry
    // cannot buy a second paid call.
    try {
      await db.prepare('DELETE FROM ai_jobs WHERE id = ?1 AND owner_id = ?2').bind(jobId, ctx.ownerId).run();
    } catch { /* the row is inert until a runtime snapshot confirms it */ }
    await deps.releaseSlot(db, bucket, slot);
    throw error;
  }
  const snapshot = publicSnapshot(result.snapshot, {
    fallbackId: jobId,
    fallbackRole: body.role,
    includeResult: true,
  });
  await persistSnapshot(db, ctx.ownerId, snapshot);
  return json(result.status === 200 ? 200 : 202, { job: snapshot, replayed: false });
}

async function ownedJob(db, ctx) {
  if (!UUID.test(ctx.params.id)) aiFail(404, 'not_found');
  const row = await db
    .prepare('SELECT id, role FROM ai_jobs WHERE id = ?1 AND owner_id = ?2')
    .bind(ctx.params.id, ctx.ownerId)
    .first();
  // Foreign and missing jobs are indistinguishable.
  if (!row) aiFail(404, 'not_found');
  return row;
}

// A runtime that does not know a job this gateway owns has lost its state; that is unavailable,
// not a foreign job (which is rejected from D1 before this call).
async function runtimeJobSnapshot(call) {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AiError && error.code === 'not_found') aiFail(503, 'ai_unavailable');
    throw error;
  }
}

async function getJob(ctx) {
  const db = ctx.deps.getDb();
  const row = await ownedJob(db, ctx);
  const runtime = await runtimeJobSnapshot(() => getRuntimeJob(ctx.env, { ownerId: ctx.ownerId, jobId: row.id }));
  const snapshot = publicSnapshot(runtime, {
    fallbackId: row.id,
    fallbackRole: row.role,
    includeResult: true,
  });
  await persistSnapshot(db, ctx.ownerId, snapshot);
  return json(200, { job: snapshot });
}

async function cancelJob(ctx) {
  const db = ctx.deps.getDb();
  const row = await ownedJob(db, ctx);
  const runtime = await runtimeJobSnapshot(() => cancelRuntimeJob(ctx.env, { ownerId: ctx.ownerId, jobId: row.id }));
  const snapshot = publicSnapshot(runtime, {
    fallbackId: row.id,
    fallbackRole: row.role,
    includeResult: true,
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
  const response = await getRuntimeArtifact(ctx.env, { ownerId: ctx.ownerId, jobId: row.id, artifactId });
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

const AI_ROUTES = {
  '/v1/ai/capabilities': { GET: ctx => capabilitiesResponse(ctx.settings) },
  '/v1/ai/uploads': { POST: ctx => createUpload(ctx) },
  '/v1/ai/jobs': { POST: ctx => createJob(ctx) },
  '/v1/ai/jobs/:id': { GET: ctx => getJob(ctx) },
  '/v1/ai/jobs/:id/cancel': { POST: ctx => cancelJob(ctx) },
  '/v1/ai/jobs/:id/artifacts/:artifactId': { GET: ctx => getArtifact(ctx) },
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

// ctx: { request, env, url, match, fetchImpl, deps: { getDb, rateLimit, releaseSlot, authenticatePassword } }
export async function handleAiRequest(ctx) {
  const requestId = newRequestId();
  let refreshed = null;
  try {
    const settings = aiSettings(ctx.env);
    if (ctx.request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Methods': AI_ALLOW_METHODS,
          'Access-Control-Allow-Headers': AI_ALLOW_HEADERS,
          'Access-Control-Max-Age': '600',
          'Cache-Control': 'no-store',
        },
      });
    }
    // Capabilities are public: a signed-out or disabled page must be able to show enabled:false and
    // the model/limit catalog without a session. Nothing here reads D1 or the provider.
    if (ctx.match.template === '/v1/ai/capabilities') {
      if (ctx.request.method !== 'GET') aiFail(405, 'method_not_allowed', { Allow: 'GET' });
      return capabilitiesResponse(settings);
    }
    // A disabled deployment behaves like it has no other hosted AI routes.
    if (!settings.enabled) aiFail(404, 'not_found');
    const owner = await resolveAiOwner({
      request: ctx.request,
      env: ctx.env,
      authenticatePassword: ctx.deps.authenticatePassword,
      fetchImpl: ctx.fetchImpl,
    });
    refreshed = owner.refreshed;
    const route = AI_ROUTES[ctx.match.template];
    if (!route) aiFail(404, 'not_found');
    const handler = route[ctx.request.method];
    if (!handler) aiFail(405, 'method_not_allowed', { Allow: Object.keys(route).join(', ') });
    const response = await handler({ ...ctx, settings, ownerId: owner.ownerId, requestId });
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
