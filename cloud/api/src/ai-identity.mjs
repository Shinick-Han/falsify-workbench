// Stable owner identity for hosted AI execution.
// A site cloudId is never an owner by itself: password sessions map to the D1 author row and
// Confluence sessions map to the hash of (cloudId, Atlassian accountId) resolved from the session
// access token. Unknown or ambiguous identity is always a 401, never a fallback.
import { currentUserIdentity } from './confluence.mjs';

export class AiError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.name = 'AiError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
export const aiFail = (status, code, headers = {}) => { throw new AiError(status, code, headers); };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLOUD = /^[0-9a-f-]{8,64}$/i;
// Atlassian accountIds are opaque; classic ones are 24 hex chars and current ones may carry a colon.
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const OWNER_ID = /^(?:usr:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|atl:[a-f0-9]{64})$/;

export function hostingEnabled(env) {
  return env?.AI_HOSTING_ENABLED === true || env?.AI_HOSTING_ENABLED === 'true';
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export function userOwner(authorId) {
  if (typeof authorId !== 'string' || !UUID.test(authorId)) aiFail(401, 'unauthorized');
  return `usr:${authorId}`;
}

export async function atlassianOwner(cloudId, accountId) {
  if (typeof cloudId !== 'string' || !CLOUD.test(cloudId)) aiFail(401, 'unauthorized');
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) aiFail(401, 'unauthorized');
  return `atl:${await sha256Hex(`${cloudId}:${accountId}`)}`;
}

// Maps a Confluence gateway failure to the hosted AI error set. A rate limit stays a rate limit;
// an unreachable or unverifiable upstream is a 503; every other identity failure is a plain 401.
function identityFailure(error) {
  if (error instanceof AiError) return error;
  const gatewayCode = error?.code;
  if (gatewayCode === 'rate_limited') return new AiError(429, 'rate_limited', error.headers || {});
  if (gatewayCode === 'not_configured' || gatewayCode === 'upstream_unavailable'
    || gatewayCode === 'upstream_invalid' || gatewayCode === 'redirect_refused'
    || (Number(error?.status) || 0) >= 500) return new AiError(503, 'ai_unavailable');
  return new AiError(401, 'unauthorized');
}

// ctx: { request, env, authenticatePassword, fetchImpl, now }
// authenticatePassword resolves an fss_ session against D1 and enforces active membership.
export async function resolveAiOwner({ request, env, authenticatePassword, fetchImpl, now = Date.now }) {
  const header = request.headers.get('Authorization');
  if (header === null) aiFail(401, 'unauthorized');
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) aiFail(401, 'unauthorized');
  const token = match[1];
  // Invitation codes are never sessions.
  if (token.startsWith('fsi_')) aiFail(401, 'unauthorized');
  if (token.startsWith('fss_')) {
    const author = await authenticatePassword();
    return { ownerId: userOwner(author.id), kind: 'user', refreshed: null };
  }
  let identity;
  try {
    identity = await currentUserIdentity({ request, env, fetchImpl, now });
  } catch (error) {
    throw identityFailure(error);
  }
  return {
    ownerId: await atlassianOwner(identity.cloudId, identity.accountId),
    kind: 'atlassian',
    refreshed: identity.refreshed || null,
  };
}
