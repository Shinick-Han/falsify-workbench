import { confluenceInternal, GatewayError } from './confluence.mjs';
import { MAX_W8_CSV_BYTES } from './w8-archive.mjs';

const MEDIA_HOST = 'api.media.atlassian.com';
const MEDIA_BINARY = /^\/file\/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\/binary$/;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_DOWNLOAD_REDIRECTS = 3;
const fail = (status, code, headers) => { throw new GatewayError(status, code, headers); };

export function jiraBase(cloudId) {
  if (typeof cloudId !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(cloudId)) fail(403, 'site_not_allowed');
  return `https://api.atlassian.com/ex/jira/${cloudId}`;
}

function jiraDownloadTarget(url, cloudId, attachmentId) {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  if (url.origin === 'https://api.atlassian.com') {
    return url.pathname === `/ex/jira/${cloudId}/rest/api/3/attachment/content/${attachmentId}` && url.search === '';
  }
  if (url.origin === `https://${MEDIA_HOST}`) return MEDIA_BINARY.test(url.pathname) && url.search.length <= 2048;
  return false;
}

function nextRedirectUrl(response, parsed, hop) {
  if (!REDIRECT_CODES.has(response.status) || hop === MAX_DOWNLOAD_REDIRECTS) fail(502, 'redirect_refused');
  const location = response.headers.get('Location');
  if (!location) fail(502, 'redirect_refused');
  try { return new URL(location, parsed); } catch { fail(502, 'redirect_refused'); }
}

async function fetchJiraBinaryHop(fetchImpl, parsed, sendBearer, token, maxBytes) {
  const headers = sendBearer ? { Accept: '*/*', Authorization: `Bearer ${token}` } : { Accept: '*/*' };
  try {
    return await confluenceInternal.fetchBounded(
      fetchImpl,
      parsed.origin + parsed.pathname + parsed.search,
      { method: 'GET', headers, redirect: 'manual' },
      maxBytes,
    );
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    fail(502, 'upstream_unavailable');
  }
}

async function readJiraDownloadBody(response, maxBytes, strictStatus) {
  if (response.status === 429) {
    const retry = response.headers.get('Retry-After');
    const retryHeaders = retry && /^\d{1,6}$/.test(retry) ? { 'Retry-After': retry } : {};
    fail(429, 'rate_limited', retryHeaders);
  }
  if (!response.ok) {
    if (!strictStatus) return null;
    const code = {401: 'unauthorized', 403: 'permission_denied', 404: 'not_found'}[response.status];
    fail(code ? response.status : 502, code || 'upstream_unavailable');
  }
  const bytes = await confluenceInternal.readBounded(response, maxBytes);
  if (strictStatus && !bytes) fail(413, 'payload_too_large');
  return bytes;
}

export async function downloadJiraAttachmentBytes(fetchImpl, cloudId, token, attachmentId, {maxBytes = MAX_W8_CSV_BYTES, strictStatus = false} = {}) {
  let current = `${jiraBase(cloudId)}/rest/api/3/attachment/content/${attachmentId}`;
  let sendBearer = true;
  const seen = new Set();
  for (let hop = 0; hop <= MAX_DOWNLOAD_REDIRECTS; hop++) {
    if (seen.has(current)) fail(502, 'redirect_refused');
    seen.add(current);
    let parsed;
    try { parsed = new URL(current); } catch { fail(502, 'redirect_refused'); }
    if (!jiraDownloadTarget(parsed, cloudId, attachmentId)) fail(502, 'redirect_refused');
    const response = await fetchJiraBinaryHop(fetchImpl, parsed, sendBearer, token, maxBytes);
    if (response.status >= 300 && response.status < 400) {
      const next = nextRedirectUrl(response, parsed, hop);
      if (next.hostname !== parsed.hostname) sendBearer = false;
      current = next.origin + next.pathname + next.search;
      continue;
    }
    return readJiraDownloadBody(response, maxBytes, strictStatus);
  }
  fail(502, 'redirect_refused');
}
