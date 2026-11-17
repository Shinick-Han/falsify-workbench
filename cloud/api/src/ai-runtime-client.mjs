// Confined client for the container-internal hosted AI runtime (contract 2026-11-17).
// The gateway never talks to a provider directly: it forwards to the runtime with the service token
// and an already-resolved owner ID. Every failure becomes a fixed AI error; runtime bodies are never
// echoed to a client.
import { AiError, aiFail } from './ai-identity.mjs';

const PLACEHOLDER_ORIGIN = 'https://ai-runtime.internal';
const MAX_RUNTIME_JSON = 1024 * 1024;

// Tests inject one fetch function; it also receives env so a bundled stub can persist call counts.
let injectedFetch = null;
export function setAiFetchForTests(fn) {
  injectedFetch = typeof fn === 'function' ? fn : null;
}

function bindingFetch(env) {
  const binding = env?.AI_RUNTIME;
  return binding && typeof binding.fetch === 'function' ? (url, init) => binding.fetch(url, init) : null;
}

// Returns the fetch used for confined runtime and identity calls.
export function aiFetch(env) {
  if (injectedFetch) return (url, init) => injectedFetch(String(url), init, env);
  const binding = bindingFetch(env);
  if (binding) return binding;
  return (url, init) => globalThis.fetch(url, init);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

// Runtime configuration is server environment only. An empty or unusable URL is "not deployed yet",
// never a live assumption: callers turn that into 503 ai_unavailable.
function runtimeTransportAllowed(url) {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
}

function runtimeBase(raw) {
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!runtimeTransportAllowed(url)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function runtimeToken(env) {
  const raw = typeof env?.HOSTED_AI_SERVICE_TOKEN === 'string' ? env.HOSTED_AI_SERVICE_TOKEN : '';
  const usable = raw.length >= 16 && raw.length <= 512 && !/[\u0000-\u001f]/.test(raw);
  return usable ? raw : null;
}

function runtimeConfiguredBase(env) {
  const parsed = runtimeBase(String(env?.AI_RUNTIME_URL || '').trim());
  if (parsed) return parsed;
  return bindingFetch(env) ? PLACEHOLDER_ORIGIN : null;
}

export function runtimeConfig(env) {
  return {
    base: runtimeConfiguredBase(env),
    token: runtimeToken(env),
    timeoutMs: positiveInt(env?.AI_RUNTIME_TIMEOUT_MS, 20000),
  };
}

export function runtimeAvailable(env) {
  const config = runtimeConfig(env);
  return !!(config.base && config.token);
}

function runtimeFailure(status) {
  if (status === 404) return new AiError(404, 'not_found');
  if (status === 409) return new AiError(409, 'idempotency_conflict');
  if (status === 413) return new AiError(413, 'payload_too_large');
  if (status === 429) return new AiError(429, 'rate_limited');
  if (status === 400 || status === 415 || status === 422) return new AiError(400, 'invalid_request');
  // Includes a rejected service token: the runtime refusing us is our outage, not the user's error.
  return new AiError(503, 'ai_unavailable');
}

async function send(env, pathname, { method = 'GET', ownerId, headers = {}, body } = {}) {
  const config = runtimeConfig(env);
  if (!config.base || !config.token) aiFail(503, 'ai_unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return await aiFetch(env)(config.base + pathname, {
      method,
      headers: {
        'X-Falsify-Service-Token': config.token,
        'X-Falsify-Owner-Id': ownerId,
        Accept: 'application/json',
        ...headers,
      },
      body,
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (error) {
    if (error instanceof AiError) throw error;
    aiFail(503, 'ai_unavailable');
  } finally {
    clearTimeout(timer);
  }
}

async function readRuntimeJson(response) {
  if (response.status >= 300 && response.status < 400) aiFail(503, 'ai_unavailable');
  if (response.status < 200 || response.status >= 300) throw runtimeFailure(response.status);
  let text;
  try {
    text = await response.text();
  } catch {
    aiFail(503, 'ai_unavailable');
  }
  if (typeof text !== 'string' || text.length > MAX_RUNTIME_JSON) aiFail(503, 'ai_unavailable');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    aiFail(503, 'ai_unavailable');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) aiFail(503, 'ai_unavailable');
  return parsed;
}

export async function createRuntimeUpload(env, { ownerId, name, mime, bytes }) {
  const query = `?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`;
  const response = await send(env, `/internal/v1/uploads${query}`, {
    method: 'POST',
    ownerId,
    headers: { 'Content-Type': mime },
    body: bytes,
  });
  const body = await readRuntimeJson(response);
  const upload = body.upload;
  if (!upload || typeof upload !== 'object' || Array.isArray(upload)) aiFail(503, 'ai_unavailable');
  if (typeof upload.id !== 'string' || !upload.id || upload.id.length > 200) aiFail(503, 'ai_unavailable');
  return { status: response.status === 200 ? 200 : 201, upload };
}

export async function createRuntimeJob(env, { ownerId, payload }) {
  const response = await send(env, '/internal/v1/jobs', {
    method: 'POST',
    ownerId,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, snapshot: await readRuntimeJson(response) };
}

export async function getRuntimeJob(env, { ownerId, jobId }) {
  const response = await send(env, `/internal/v1/jobs/${encodeURIComponent(jobId)}`, { ownerId });
  return readRuntimeJson(response);
}

export async function cancelRuntimeJob(env, { ownerId, jobId }) {
  const response = await send(env, `/internal/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    ownerId,
    headers: { 'Content-Type': 'application/json' },
  });
  return readRuntimeJson(response);
}

// Returns the raw runtime Response; the caller streams the bytes and never buffers them in D1.
export async function getRuntimeArtifact(env, { ownerId, jobId, artifactId }) {
  const response = await send(env, `/internal/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`, {
    ownerId,
    headers: { Accept: '*/*' },
  });
  if (response.status >= 300 && response.status < 400) aiFail(503, 'ai_unavailable');
  if (!response.ok) throw runtimeFailure(response.status);
  return response;
}
