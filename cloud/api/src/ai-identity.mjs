// Stable owner identity for hosted AI execution.
// A site cloudId is never an owner by itself: password sessions map to the D1 author row,
// Confluence sessions map to the hash of (cloudId, Atlassian accountId), and an open guest
// session maps to gst:<uuid>. Unknown or ambiguous identity is always a 401, never a fallback.
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

const UUID_BODY = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_BODY}$`);
const CLOUD = /^[0-9a-f-]{8,64}$/i;
// Atlassian accountIds are opaque; classic ones are 24 hex chars and current ones may carry a colon.
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// usr: password author, atl: Confluence account, gst: one open guest session.
export const OWNER_ID = new RegExp(`^(?:usr:${UUID_BODY}|atl:[a-f0-9]{64}|gst:${UUID_BODY})$`);
export const GUEST_TOKEN = /^fsg_[A-Za-z0-9_-]{43}$/;

export function hostingEnabled(env) {
  return env?.AI_HOSTING_ENABLED === true || env?.AI_HOSTING_ENABLED === 'true';
}

export function openAccessEnabled(env) {
  return env?.AI_OPEN_ACCESS === true || env?.AI_OPEN_ACCESS === 'true';
}

export function guestOwner(guestId) {
  if (typeof guestId !== 'string' || !UUID.test(guestId)) aiFail(401, 'unauthorized');
  return `gst:${guestId}`;
}

// Accepts a guest bearer only after the caller has checked that open access is on.
// Expired, revoked, unknown and malformed tokens are the same 401. The raw token is never stored.
export async function resolveGuestOwner(db, token, nowMs) {
  if (!GUEST_TOKEN.test(token)) aiFail(401, 'unauthorized');
  const row = await db
    .prepare('SELECT guest_id FROM guest_sessions WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2')
    .bind(await sha256Hex(token), nowMs)
    .first();
  if (!row) aiFail(401, 'unauthorized');
  return { ownerId: guestOwner(row.guest_id), kind: 'guest', refreshed: null };
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

// ctx: { request, env, authenticatePassword, getDb, fetchImpl, now }
// authenticatePassword resolves an fss_ session against D1 and enforces active membership.
// getDb resolves an fsg_ session. While open access is off every fsg_ bearer is 403.
export async function resolveAiOwner({ request, env, authenticatePassword, getDb, fetchImpl, now = Date.now }) {
  const header = request.headers.get('Authorization');
  if (header === null) aiFail(401, 'unauthorized');
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) aiFail(401, 'unauthorized');
  const token = match[1];
  // Invitation codes are never sessions.
  if (token.startsWith('fsi_')) aiFail(401, 'unauthorized');
  if (token.startsWith('fsg_')) {
    if (!openAccessEnabled(env)) aiFail(403, 'open_access_disabled');
    if (typeof getDb !== 'function') aiFail(401, 'unauthorized');
    return resolveGuestOwner(getDb(), token, now());
  }
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
