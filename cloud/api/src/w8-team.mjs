// Stateless W8 Stage 2 team delivery gateway (Confluence BLUE-only archive + Jira CSV attachment + single participant comment).
// Reuses per-user Atlassian OAuth 2.0 3LO sealed sessions from confluence.mjs. No D1, KV, R2, or global service credentials.
import {
  SITE_URL,
  SPACE_KEY,
  SPACE_ID,
  MAX_ARCHIVE_BYTES,
  SESSION_HEADER,
  GatewayError,
  confluenceConfig,
  startAtlassianAuth,
  confluenceInternal,
} from './confluence.mjs';
import {
  W8_ARCHIVE_KIND,
  MAX_W8_CSV_BYTES,
  W8ArchiveError,
  normalizeParticipant,
  normalizeCondition,
  normalizeCsvFilename,
  normalizeIssueKey,
  participantKeyHash,
  sha256HexBytes,
  sha256HexText,
  validateW8BlueArchive,
} from './w8-archive.mjs';
import { handleW8Papers, handleW8PaperSync } from './w8-paper-sync.mjs';
import { jiraBase, downloadJiraAttachmentBytes } from './w8-jira-files.mjs';
import { handleJiraHistory } from './w8-history-jira.mjs';
import { handleConfluenceHistory } from './w8-history-confluence.mjs';
import { handleW8LibraryAttachments } from './w8-library-attachments.mjs';

export const W8_DEFAULT_ISSUE = 'FLS-18';
export const W8_READY_LABEL = 'falsify-w8-blue-ready';
export const W8_LABEL = 'falsify-w8-blue';
export const W8_PROPERTY_KEY = 'falsify-w8-archive';
export const W8_SCOPE_PROFILE = 'w8-team';
export const W8_JIRA_SCOPES = Object.freeze(['read:jira-work', 'write:jira-work']);

const PAGE_ID = /^[0-9]{1,20}$/;
const ATTACHMENT_ID = /^(?:att)?[0-9]{1,20}$/;
const COMMENT_ID = /^[0-9]{1,20}$/;
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const FLS_ISSUE_ID = /^FLS-[1-9][0-9]{0,7}$/;
const UNSAFE_SINGLELINE = /[\u0000-\u001f\u007f]/;
const REQUIRED_JIRA_PERMS = ['BROWSE_PROJECTS', 'CREATE_ATTACHMENTS', 'ADD_COMMENTS', 'EDIT_OWN_COMMENTS'];
const REQUIRED_JIRA_COMMENT_PERMS = ['BROWSE_PROJECTS', 'ADD_COMMENTS', 'EDIT_OWN_COMMENTS'];
const MAX_PATTERN_LINKS = 50;
// Platform-bounded subrequest caps for Cloudflare Worker execution budgets.
const MAX_COMMENT_PAGES = 10;
const MAX_ATTACHMENT_CANDIDATES = 10;

const encoder = new TextEncoder();

const MESSAGES = {
  not_configured: 'W8 team delivery is not configured.',
  invalid_request: 'The request is not valid for this endpoint.',
  unsupported_media_type: 'The request body must be application/json.',
  origin_not_allowed: 'This origin is not allowed.',
  unauthorized: 'A valid Atlassian session is required.',
  session_expired: 'The Atlassian session has expired. Connect again.',
  jira_scope_required: 'Your Atlassian connection needs Jira permission for W8 submission. Reconnect to grant it.',
  site_not_allowed: 'The Atlassian grant is not for the Falsify site.',
  space_not_allowed: 'The archive space is not the Falsify space.',
  parent_not_allowed: 'The archive parent page is missing, restricted, or outside the Falsify space.',
  issue_not_allowed: 'This Jira issue is not configured for W8 team submission.',
  permission_denied: 'Your Atlassian account does not have read/write permission for this team space or Jira issue.',
  invalid_archive: 'The BLUE-only archive failed validation.',
  forbidden_content: 'Raw documents, PDF bytes, and RED answers cannot be submitted to the W8 team archive.',
  invalid_csv: 'The CSV payload or filename is invalid.',
  payload_too_large: 'The submission exceeds size limits.',
  invalid_cursor: 'The pagination cursor is not valid.',
  rate_limited: 'Atlassian rate limited the request. Retry later.',
  write_partial: 'The team submission stopped partway through. Resume to complete remaining steps without duplicates.',
  write_unknown: 'The team submission outcome is unknown. Resume to reconcile remote state without duplicates.',
  archive_conflict: 'An existing page blocks this archive. It was not overwritten.',
  redirect_refused: 'An upstream redirect was refused.',
  upstream_unavailable: 'Atlassian could not be reached.',
  upstream_invalid: 'Atlassian returned a response this gateway will not follow.',
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  internal_error: 'Internal error.',
};

const fail = (status, code, headers = {}, extra = null) => {
  throw new GatewayError(status, code, headers, extra);
};

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function errorResponse(error) {
  const body = { error: { code: error.code, message: MESSAGES[error.code] || MESSAGES.internal_error } };
  if (error.extra?.pageId && PAGE_ID.test(String(error.extra.pageId))) body.pageId = String(error.extra.pageId);
  if (error.extra?.readBack) body.readBack = true;
  if (error.extra?.progress && typeof error.extra.progress === 'object') body.progress = error.extra.progress;
  return json(error.status, body, error.headers || {});
}

function w8ParentId(env) {
  const raw = String(env.W8_CONFLUENCE_PARENT_PAGE_ID || env.CONFLUENCE_PARENT_PAGE_ID || '').trim();
  return PAGE_ID.test(raw) ? raw : null;
}

function parseIssueKeySafe(value) {
  try { return normalizeIssueKey(value); } catch { return null; }
}

function parseAllowedIssues(env, defaultIssue) {
  const allowedSet = new Set();
  for (const part of String(env.W8_ALLOWED_ISSUE_KEYS || '').split(',')) {
    const key = parseIssueKeySafe(part);
    if (key) allowedSet.add(key);
  }
  if (defaultIssue) allowedSet.add(defaultIssue);
  return [...allowedSet];
}

export function w8Config(env) {
  const conf = confluenceConfig(env);
  const parent = w8ParentId(env);
  const defaultIssue = parseIssueKeySafe(env.W8_JIRA_ISSUE_KEY || W8_DEFAULT_ISSUE);
  const allowedIssues = parseAllowedIssues(env, defaultIssue);
  const configured = conf.configured && !!parent && !!defaultIssue && allowedIssues.length > 0;
  return {
    configured,
    siteUrl: SITE_URL,
    spaceKey: SPACE_KEY,
    spaceId: SPACE_ID,
    parentPageId: parent,
    issueKey: defaultIssue || W8_DEFAULT_ISSUE,
    allowedIssues,
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    maxCsvBytes: MAX_W8_CSV_BYTES,
    scopes: [...new Set([...confluenceInternal.SCOPES, ...W8_JIRA_SCOPES])],
  };
}

function hasAllJiraScopes(list) {
  return Array.isArray(list) && W8_JIRA_SCOPES.every(s => list.includes(s));
}

function sessionHasJiraScopes(session, resourceScopes = null) {
  if (Array.isArray(resourceScopes) && !hasAllJiraScopes(resourceScopes)) return false;
  if (Array.isArray(session?.scopes) && !hasAllJiraScopes(session.scopes)) return false;
  if (Array.isArray(resourceScopes) || Array.isArray(session?.scopes)) return true;
  return session?.scopeProfile === W8_SCOPE_PROFILE;
}

function assertJiraScopes(session, resourceScopes = null) {
  if (!sessionHasJiraScopes(session, resourceScopes)) fail(403, 'jira_scope_required');
}

function w8ReadyLabel(page) {
  const results = page?.labels?.results;
  return Array.isArray(results) && results.some(label => label && label.name === W8_READY_LABEL);
}

function w8PropertyValue(page) {
  const results = page?.properties?.results;
  if (!Array.isArray(results)) return null;
  const found = results.find(item => item && item.key === W8_PROPERTY_KEY);
  return found && found.value && typeof found.value === 'object' && !Array.isArray(found.value) ? found.value : null;
}

function safeSiteUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.origin !== SITE_URL || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function issueBrowseUrl(issueKey, commentId = null) {
  const base = `${SITE_URL}/browse/${encodeURIComponent(issueKey)}`;
  return commentId && COMMENT_ID.test(String(commentId))
    ? `${base}?focusedCommentId=${encodeURIComponent(String(commentId))}`
    : base;
}

function jiraAttachmentPublicUrl(att, attachmentId) {
  const candidate = safeSiteUrl(att?.content);
  if (candidate && candidate.includes('/attachment/')) return candidate;
  return `${SITE_URL}/rest/api/3/attachment/content/${encodeURIComponent(String(attachmentId))}`;
}

function w8PageTitle(archiveSha256) {
  return `Falsify ${W8_ARCHIVE_KIND} ${archiveSha256}`;
}

function w8SummaryHtml(archive, archiveSha256) {
  const esc = confluenceInternal.escapeHtml;
  const models = [...new Set(archive.runs.map(r => r.model).filter(Boolean))].join(', ') || '미기재';
  return (
    `<p>Falsify W8 BLUE team archive. Participant: ${esc(archive.participant)}. Condition: ${esc(archive.condition)}. ` +
    `Jira issue: ${esc(archive.issueKey)}. Runs: ${esc(archive.runCount)}. Findings: ${esc(archive.findingCount)}. ` +
    `Models: ${esc(models)}.</p>` +
    `<p>CSV file: ${esc(archive.csvFilename)} (SHA-256 ${esc(archive.csvSha256)}). ` +
    `Archive attachment: ${esc(archiveSha256)}.json (SHA-256 ${esc(archiveSha256)}).</p>` +
    `<p>Sanitized BLUE-only JSON record. No raw PDF document and no RED ledger or answer key are included.</p>`
  );
}

function markerLine({ participantHash, issueKey, pageId, attachmentId, csvSha256, archiveSha256 }) {
  return `[falsify-w8:v1 participant=${participantHash} issue=${issueKey} page=${pageId} attachment=${attachmentId} csvSha256=${csvSha256} archiveSha256=${archiveSha256}]`;
}

export function parseW8Marker(text) {
  if (typeof text !== 'string') return null;
  const m = /\[falsify-w8:v1\s+participant=([a-f0-9]{16})\s+issue=([A-Z][A-Z0-9_]{1,15}-[1-9][0-9]{0,7})\s+page=([0-9]{1,20})\s+attachment=((?:att)?[0-9]{1,20})\s+csvSha256=([a-f0-9]{64})\s+archiveSha256=([a-f0-9]{64})\]/.exec(text);
  if (!m) return null;
  return {
    participantHash: m[1],
    issueKey: m[2],
    pageId: m[3],
    attachmentId: m[4],
    csvSha256: m[5],
    archiveSha256: m[6],
  };
}

function extractAdfText(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out; }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.text === 'string') out.push(node.text);
  if (Array.isArray(node.content)) {
    for (const child of node.content) extractAdfText(child, out);
  }
  return out;
}

function linkBullet(prefix, href) {
  return {
    type: 'listItem',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: prefix },
        { type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] },
      ],
    }],
  };
}

function buildCommentAdf({ archive, archiveSha256, pageId, pageUrl, attachmentId, attachmentUrl, participantHash }) {
  const models = [...new Set(archive.runs.map(r => r.model).filter(Boolean))].join(', ') || '미기재';
  const marker = markerLine({ participantHash, issueKey: archive.issueKey, pageId, attachmentId, csvSha256: archive.csvSha256, archiveSha256 });
  return {
    version: 1,
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: `W8 BLUE 제출 · ${archive.participant} (조건 ${archive.condition})`, marks: [{ type: 'strong' }] }],
      },
      {
        type: 'bulletList',
        content: [
          linkBullet('Confluence 실험 보관: ', pageUrl),
          linkBullet(`CSV 첨부 (${archive.csvFilename}): `, attachmentUrl),
          {
            type: 'listItem',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: `실행 ${archive.runCount}건 · 지적 ${archive.findingCount}건 · 모델 ${models} · CSV SHA-256 ${archive.csvSha256.slice(0, 12)}` }],
            }],
          },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: marker }] },
    ],
  };
}

function checkJiraAuthStatus(status, session, notFoundCode = null) {
  if (status === 401) fail(403, 'jira_scope_required');
  if (status === 403) fail(403, sessionHasJiraScopes(session) ? 'permission_denied' : 'jira_scope_required');
  if (notFoundCode && status === 404) fail(403, notFoundCode);
}

async function fetchJiraAccountId(ctx, session, base, headers) {
  const response = await confluenceInternal.callUpstream(ctx.fetchImpl, `${base}/rest/api/3/myself`, { headers });
  checkJiraAuthStatus(response.status, session);
  const me = await confluenceInternal.readUpstreamJson(response);
  const accountId = typeof me?.accountId === 'string' ? me.accountId : '';
  if (!ACCOUNT_ID.test(accountId)) fail(403, 'permission_denied');
  return accountId;
}

async function assertJiraIssuePermissions(ctx, session, base, headers, issueKey) {
  const url = `${base}/rest/api/3/mypermissions?issueKey=${encodeURIComponent(issueKey)}&permissions=${REQUIRED_JIRA_PERMS.join(',')}`;
  const response = await confluenceInternal.callUpstream(ctx.fetchImpl, url, { headers });
  checkJiraAuthStatus(response.status, session, 'issue_not_allowed');
  const payload = await confluenceInternal.readUpstreamJson(response);
  const perms = payload?.permissions;
  if (!perms || REQUIRED_JIRA_PERMS.some(key => perms[key]?.havePermission !== true)) {
    fail(403, 'permission_denied');
  }
}

async function fetchJiraIssueAttachments(ctx, session, base, headers, issueKey) {
  const url = `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,attachment`;
  const response = await confluenceInternal.callUpstream(ctx.fetchImpl, url, { headers });
  checkJiraAuthStatus(response.status, session, 'issue_not_allowed');
  const issue = await confluenceInternal.readUpstreamJson(response);
  if (!issue || issue.key !== issueKey) fail(502, 'upstream_invalid');
  return Array.isArray(issue.fields?.attachment) ? issue.fields.attachment : [];
}

async function verifyJiraAccountAndPermissions(ctx, session, issueKey) {
  const base = jiraBase(session.cloudId);
  const headers = confluenceInternal.authHeaders(session.accessToken);
  const accountId = await fetchJiraAccountId(ctx, session, base, headers);
  await assertJiraIssuePermissions(ctx, session, base, headers, issueKey);
  const attachments = await fetchJiraIssueAttachments(ctx, session, base, headers, issueKey);
  return { accountId, attachments };
}

function matchParticipantComment(comments, accountId, participantHash, issueKey) {
  let matched = null;
  for (const comment of comments) {
    if (!comment || !COMMENT_ID.test(String(comment.id)) || comment.author?.accountId !== accountId) continue;
    const marker = parseW8Marker(extractAdfText(comment.body).join('\n'));
    if (marker && marker.participantHash === participantHash && marker.issueKey === issueKey) {
      matched = { id: String(comment.id), marker };
    }
  }
  return matched;
}

async function listParticipantComment(ctx, session, issueKey, accountId, participantHash) {
  const base = jiraBase(session.cloudId);
  const headers = confluenceInternal.authHeaders(session.accessToken);
  let startAt = 0;
  let found = null;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const response = await confluenceInternal.callUpstream(
      ctx.fetchImpl,
      `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=100`,
      { headers },
    );
    const payload = await confluenceInternal.readUpstreamJson(response);
    const comments = Array.isArray(payload?.comments) ? payload.comments : null;
    if (!comments) fail(502, 'upstream_invalid');
    const pageMatch = matchParticipantComment(comments, accountId, participantHash, issueKey);
    if (pageMatch) found = pageMatch;
    startAt += comments.length;
    const total = Number(payload.total);
    if (!comments.length || !Number.isFinite(total) || startAt >= total) break;
  }
  return found;
}

function collectAttachmentCandidates(attachments, filename, preferredIds) {
  const byId = new Map();
  for (const att of attachments) {
    if (att && ATTACHMENT_ID.test(String(att.id))) byId.set(String(att.id), att);
  }
  const ordered = [];
  const seen = new Set();
  const pushUnique = att => {
    const id = String(att.id);
    if (!seen.has(id)) { seen.add(id); ordered.push(att); }
  };
  for (const pref of preferredIds) {
    if (pref && byId.has(String(pref))) pushUnique(byId.get(String(pref)));
  }
  for (const att of [...attachments].reverse()) {
    if (att && ATTACHMENT_ID.test(String(att.id)) && att.filename === filename) pushUnique(att);
  }
  return ordered;
}

function attachmentEligible(att, accountId, byteLength) {
  if (att.author?.accountId && att.author.accountId !== accountId) return false;
  if (typeof att.size === 'number' && att.size !== byteLength) return false;
  return true;
}

async function findExistingJiraAttachment(ctx, session, attachments, { filename, csvBytes, csvSha256, accountId, preferredIds = [] }) {
  const candidates = collectAttachmentCandidates(attachments, filename, preferredIds);
  let checked = 0;
  for (const att of candidates) {
    if (checked >= MAX_ATTACHMENT_CANDIDATES) break;
    if (!attachmentEligible(att, accountId, csvBytes.byteLength)) continue;
    checked++;
    const downloaded = await downloadJiraAttachmentBytes(ctx.fetchImpl, session.cloudId, session.accessToken, String(att.id));
    if (downloaded && (await sha256HexBytes(downloaded)) === csvSha256) {
      return {
        attachmentId: String(att.id),
        attachmentFilename: typeof att.filename === 'string' && att.filename ? att.filename : filename,
        attachmentUrl: jiraAttachmentPublicUrl(att, String(att.id)),
        reused: true,
      };
    }
  }
  return null;
}

function buildMultipartBody(boundary, filename, contentType, fileBytes) {
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + fileBytes.length + tail.length);
  body.set(head, 0);
  body.set(fileBytes, head.length);
  body.set(tail, head.length + fileBytes.length);
  return body;
}

function promotePartial(error, progress) {
  if (!(error instanceof GatewayError)) {
    fail(409, 'write_unknown', {}, { pageId: progress.pageId, readBack: true, progress });
  }
  const unknown = ['upstream_unavailable', 'redirect_refused', 'write_unknown', 'upstream_invalid'].includes(error.code) || error.status >= 500;
  error.status = 409;
  error.code = unknown ? 'write_unknown' : 'write_partial';
  error.extra = { ...(error.extra || {}), pageId: progress.pageId, readBack: true, progress };
  throw error;
}

async function uploadJiraCsvAttachment(ctx, session, issueKey, filename, csvBytes, progress) {
  const base = jiraBase(session.cloudId);
  const boundary = `falsifyw8${crypto.randomUUID().replace(/-/g, '')}`;
  const body = buildMultipartBody(boundary, filename, 'text/csv; charset=utf-8', csvBytes);
  try {
    const response = await confluenceInternal.callUpstream(
      ctx.fetchImpl,
      `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`,
      {
        method: 'POST',
        headers: confluenceInternal.authHeaders(session.accessToken, {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'X-Atlassian-Token': 'no-check',
        }),
        body,
      },
      true,
    );
    const created = await confluenceInternal.readUpstreamJson(response, true);
    const item = Array.isArray(created) ? created[0] : created;
    if (!item || !ATTACHMENT_ID.test(String(item.id)) || (typeof item.size === 'number' && item.size !== csvBytes.byteLength)) {
      fail(409, 'write_partial', {}, { pageId: progress.pageId, readBack: true, progress });
    }
    const attachmentId = String(item.id);
    return {
      attachmentId,
      attachmentFilename: typeof item.filename === 'string' && item.filename ? item.filename : filename,
      attachmentUrl: jiraAttachmentPublicUrl(item, attachmentId),
      reused: false,
    };
  } catch (error) {
    promotePartial(error, progress);
  }
}

async function lookupW8Page(ctx, base, token, parent, title) {
  const lookupUrl = `${base}/wiki/api/v2/pages?space-id=${SPACE_ID}&title=${encodeURIComponent(title)}&limit=5`;
  const lookup = await confluenceInternal.callUpstream(ctx.fetchImpl, lookupUrl, { headers: confluenceInternal.authHeaders(token) });
  const found = await confluenceInternal.readUpstreamJson(lookup);
  const results = Array.isArray(found?.results) ? found.results : null;
  if (!results || results.length > 5) fail(502, 'upstream_invalid');
  const sameTitle = results.filter(p => p && p.title === title && p.status === 'current');
  if (sameTitle.length > 1) fail(409, 'archive_conflict');
  const page = sameTitle[0] ? await confluenceInternal.getPage(ctx.fetchImpl, base, token, String(sameTitle[0].id)) : null;
  if (page && (String(page.parentId) !== parent || String(page.spaceId) !== SPACE_ID)) fail(409, 'archive_conflict');
  return page;
}

async function reuseReadyW8Page(ctx, base, token, page, archiveSha256) {
  if (!page || !w8ReadyLabel(page)) return null;
  await confluenceInternal.assertReadOpen(ctx.fetchImpl, base, token, String(page.id));
  const prop = w8PropertyValue(page);
  if (prop && prop.ready === true && prop.archiveSha256 === archiveSha256 && prop.kind === W8_ARCHIVE_KIND) {
    const url = confluenceInternal.webUrl(page);
    if (!url) fail(502, 'upstream_invalid');
    return { pageId: String(page.id), pageUrl: url, reused: true };
  }
  fail(409, 'archive_conflict');
}

async function createW8Page(ctx, base, token, parent, title, archive, archiveSha256) {
  const response = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/api/v2/pages`,
    {
      method: 'POST',
      headers: confluenceInternal.authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        spaceId: SPACE_ID,
        status: 'current',
        title,
        parentId: parent,
        body: { representation: 'storage', value: w8SummaryHtml(archive, archiveSha256) },
      }),
    },
    false,
  );
  return confluenceInternal.readUpstreamJson(response);
}

function validatePageIdentity(ctx, page, parent, created) {
  const pageId = page && PAGE_ID.test(String(page.id)) ? String(page.id) : null;
  if (pageId) ctx.budget.pageId = pageId;
  if (!pageId) fail(created ? 409 : 502, created ? 'write_unknown' : 'upstream_invalid', {}, created ? { readBack: true } : null);
  if (String(page.spaceId || SPACE_ID) !== SPACE_ID || (page.parentId && String(page.parentId) !== parent)) {
    fail(409, 'archive_conflict');
  }
  return pageId;
}

async function uploadConfluenceAttachment(ctx, base, token, pageId, filename, archiveBytes) {
  const boundary = `falsify${crypto.randomUUID().replace(/-/g, '')}`;
  const body = buildMultipartBody(boundary, filename, 'application/json', archiveBytes);
  const uploaded = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/rest/api/content/${pageId}/child/attachment`,
    {
      method: 'POST',
      headers: confluenceInternal.authHeaders(token, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-Atlassian-Token': 'nocheck',
      }),
      body,
    },
    true,
  );
  const resBody = await confluenceInternal.readUpstreamJson(uploaded, true);
  const resultsList = resBody?.results || (resBody?.id ? [resBody] : null);
  return Array.isArray(resultsList) ? resultsList.find(item => item && item.title === filename) : null;
}

async function ensureW8PageAttachment(ctx, base, session, pageId, archiveSha256, archiveBytes, progress) {
  const filename = `${archiveSha256}.json`;
  const listResp = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/api/v2/pages/${pageId}/attachments?limit=25`,
    { headers: confluenceInternal.authHeaders(session.accessToken) },
    true,
  );
  const list = await confluenceInternal.readUpstreamJson(listResp, true);
  const attachments = Array.isArray(list?.results) ? list.results : null;
  if (!attachments || attachments.length > 25) fail(409, 'write_unknown', {}, { pageId, readBack: true, progress });
  let attachment = attachments.find(item => item && item.title === filename);
  if (!attachment) attachment = await uploadConfluenceAttachment(ctx, base, session.accessToken, pageId, filename, archiveBytes);
  if (!attachment || !ATTACHMENT_ID.test(String(attachment.id))) {
    fail(409, 'write_partial', {}, { pageId, readBack: true, progress });
  }
  const download = await confluenceInternal.downloadAttachment(
    ctx.fetchImpl,
    `${base}/wiki/rest/api/content/${pageId}/child/attachment/${attachment.id}/download`,
    session.accessToken,
    session.cloudId,
    pageId,
    String(attachment.id),
    true,
  );
  const downloaded = await confluenceInternal.readBounded(download, MAX_ARCHIVE_BYTES);
  if (download.status < 200 || download.status >= 300 || !downloaded || (await sha256HexBytes(downloaded)) !== archiveSha256) {
    fail(409, 'write_partial', {}, { pageId, readBack: true, progress });
  }
}

async function ensureW8PagePropertyAndLabels(ctx, base, token, page, pageId, archive, archiveSha256) {
  const existingProp = w8PropertyValue(page);
  const hasMatchingProp = existingProp && existingProp.ready === true && existingProp.archiveSha256 === archiveSha256 && existingProp.kind === W8_ARCHIVE_KIND;
  if (!hasMatchingProp) {
    const propResp = await confluenceInternal.callUpstream(
      ctx.fetchImpl,
      `${base}/wiki/api/v2/pages/${pageId}/properties`,
      {
        method: 'POST',
        headers: confluenceInternal.authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          key: W8_PROPERTY_KEY,
          value: {
            kind: W8_ARCHIVE_KIND,
            id: `w8:${archive.issueKey}:${archiveSha256.slice(0, 16)}`,
            title: `W8 BLUE · ${archive.participant} · ${archive.condition} · ${archive.issueKey}`,
            archiveSha256,
            participant: archive.participant,
            condition: archive.condition,
            issueKey: archive.issueKey,
            csvSha256: archive.csvSha256,
            ready: true,
          },
        }),
      },
      true,
    );
    if (propResp.status !== 409) await confluenceInternal.readUpstreamJson(propResp, true);
  }
  const labelResp = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/rest/api/content/${pageId}/label`,
    {
      method: 'POST',
      headers: confluenceInternal.authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify([
        { prefix: 'global', name: W8_READY_LABEL },
        { prefix: 'global', name: W8_LABEL },
      ]),
    },
    true,
  );
  await confluenceInternal.readUpstreamJson(labelResp, true);
}

async function verifyReadyW8Page(ctx, base, token, pageId, archiveSha256, progress) {
  const fresh = await confluenceInternal.getPage(ctx.fetchImpl, base, token, pageId, true);
  await confluenceInternal.assertReadOpen(ctx.fetchImpl, base, token, pageId);
  const url = confluenceInternal.webUrl(fresh);
  const prop = w8PropertyValue(fresh);
  if (!url || !w8ReadyLabel(fresh) || !prop || prop.ready !== true || prop.archiveSha256 !== archiveSha256) {
    fail(409, 'write_partial', {}, { pageId, readBack: true, progress });
  }
  return url;
}

async function ensureConfluenceW8Archive(ctx, session, parent, archive, archiveSha256, archiveBytes) {
  const base = confluenceInternal.cloudBase(session.cloudId);
  const token = session.accessToken;
  const title = w8PageTitle(archiveSha256);
  let page = await lookupW8Page(ctx, base, token, parent, title);
  const ready = await reuseReadyW8Page(ctx, base, token, page, archiveSha256);
  if (ready) return ready;

  const created = !page;
  if (!page) page = await createW8Page(ctx, base, token, parent, title, archive, archiveSha256);
  const pageId = validatePageIdentity(ctx, page, parent, created);
  const progress = { pageId, pageUrl: null, archiveSha256, attachmentId: null, attachmentUrl: null, commentId: null };
  ctx.budget.progress = progress;
  try {
    await ensureW8PageAttachment(ctx, base, session, pageId, archiveSha256, archiveBytes, progress);
    await ensureW8PagePropertyAndLabels(ctx, base, token, page, pageId, archive, archiveSha256);
    const pageUrl = await verifyReadyW8Page(ctx, base, token, pageId, archiveSha256, progress);
    return { pageId, pageUrl, reused: !created };
  } catch (error) {
    promotePartial(error, progress);
  }
}

function commentMarkerMatches(marker, pageId, attachmentId, csvSha256, archiveSha256) {
  return marker.pageId === pageId &&
    marker.attachmentId === attachmentId &&
    marker.csvSha256 === csvSha256 &&
    marker.archiveSha256 === archiveSha256;
}

async function updateExistingComment(ctx, session, issueKey, commentId, adfBody, progress) {
  const base = jiraBase(session.cloudId);
  try {
    const response = await confluenceInternal.callUpstream(
      ctx.fetchImpl,
      `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      {
        method: 'PUT',
        headers: confluenceInternal.authHeaders(session.accessToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ body: adfBody }),
      },
      true,
    );
    const updated = await confluenceInternal.readUpstreamJson(response, true);
    const resolvedId = COMMENT_ID.test(String(updated?.id || commentId)) ? String(updated?.id || commentId) : commentId;
    return { commentId: resolvedId, reused: true, updated: true };
  } catch (error) {
    promotePartial(error, progress);
  }
}

async function createNewComment(ctx, session, issueKey, adfBody, progress) {
  const base = jiraBase(session.cloudId);
  try {
    const response = await confluenceInternal.callUpstream(
      ctx.fetchImpl,
      `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      {
        method: 'POST',
        headers: confluenceInternal.authHeaders(session.accessToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ body: adfBody }),
      },
      true,
    );
    const created = await confluenceInternal.readUpstreamJson(response, true);
    if (!created || !COMMENT_ID.test(String(created.id))) {
      fail(409, 'write_partial', {}, { pageId: progress.pageId, readBack: true, progress });
    }
    return { commentId: String(created.id), reused: false, updated: false };
  } catch (error) {
    promotePartial(error, progress);
  }
}

async function upsertParticipantComment(ctx, session, params) {
  const { issueKey, existingComment, archive, archiveSha256, pageId, pageUrl, attachmentId, attachmentUrl, participantHash, progress } = params;
  if (existingComment && commentMarkerMatches(existingComment.marker, pageId, attachmentId, archive.csvSha256, archiveSha256)) {
    return { commentId: existingComment.id, reused: true, updated: false };
  }
  const adfBody = buildCommentAdf({ archive, archiveSha256, pageId, pageUrl, attachmentId, attachmentUrl, participantHash });
  if (existingComment) {
    return updateExistingComment(ctx, session, issueKey, existingComment.id, adfBody, progress);
  }
  return createNewComment(ctx, session, issueKey, adfBody, progress);
}

async function requireW8Ready(ctx) {
  const cfg = w8Config(ctx.env);
  if (!cfg.configured || !(await confluenceInternal.aesKey(ctx.env))) fail(503, 'not_configured');
  return cfg;
}

async function handleCapabilities(ctx) {
  const cfg = w8Config(ctx.env);
  const key = await confluenceInternal.aesKey(ctx.env);
  return json(200, {
    provider: 'atlassian-w8',
    configured: cfg.configured && !!key,
    siteUrl: cfg.siteUrl,
    spaceKey: cfg.spaceKey,
    spaceId: cfg.spaceId,
    parentPageId: cfg.parentPageId,
    issueKey: cfg.issueKey,
    allowedIssues: cfg.allowedIssues,
    maxArchiveBytes: cfg.maxArchiveBytes,
    maxCsvBytes: cfg.maxCsvBytes,
    scopes: cfg.scopes,
  });
}

export function parseW8PatternMarker(text) {
  if (typeof text !== 'string') return null;
  const m = /\[falsify-w8-pattern:v1\s+issue=(FLS-[1-9][0-9]{0,7})\s+pattern=([a-f0-9]{16})\s+pages=([0-9]{1,20}(?:,[0-9]{1,20})*)\]/.exec(text);
  if (!m) return null;
  const pageIds = [...new Set(m[3].split(',').filter(id => PAGE_ID.test(id)))];
  if (!pageIds.length) return null;
  return {
    issueKey: m[1],
    patternHash: m[2],
    pageIds,
  };
}

function patternMarkerLine({ issueKey, patternHash, pageIds }) {
  return `[falsify-w8-pattern:v1 issue=${issueKey} pattern=${patternHash} pages=${pageIds.join(',')}]`;
}

function extractPatternLinkEntries(adfNode, out = []) {
  if (!adfNode || typeof adfNode !== 'object') return out;
  if (adfNode.type === 'listItem') {
    const texts = [];
    let href = null;
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'text' && typeof node.text === 'string') {
        texts.push(node.text);
        if (Array.isArray(node.marks)) {
          for (const mark of node.marks) {
            if (mark?.type === 'link' && typeof mark.attrs?.href === 'string') {
              const safe = safeSiteUrl(mark.attrs.href);
              if (safe && safe.includes('/wiki/')) href = safe;
            }
          }
        }
      }
      if (Array.isArray(node.content)) {
        for (const child of node.content) walk(child);
      }
    };
    walk(adfNode);
    if (href) {
      const idMatch = /\/pages\/([0-9]{1,20})(?:[/?#]|$)/.exec(href);
      if (idMatch) {
        const line = texts.join('').replace(href, '').replace(/\s+/g, ' ').trim();
        out.push({ pageId: idMatch[1], pageUrl: href, label: line.replace(/:\s*$/, '').trim() });
      }
    }
    return out;
  }
  if (Array.isArray(adfNode.content)) {
    for (const child of adfNode.content) extractPatternLinkEntries(child, out);
  }
  return out;
}

function buildPatternCommentAdf({ issueKey, patternHash, patternLabel, entries }) {
  const sortedPageIds = entries.map(e => e.pageId);
  const marker = patternMarkerLine({ issueKey, patternHash, pageIds: sortedPageIds });
  const bullets = entries.map(entry => {
    const prefix = entry.label ? `${entry.label}: ` : `Confluence 기록 (${entry.pageId}): `;
    return linkBullet(prefix, entry.pageUrl);
  });
  return {
    version: 1,
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: `W8 팀 기록 연결 · ${patternLabel}`, marks: [{ type: 'strong' }] }],
      },
      {
        type: 'bulletList',
        content: bullets,
      },
      { type: 'paragraph', content: [{ type: 'text', text: marker }] },
    ],
  };
}

async function assertJiraCommentPermissions(ctx, session, base, headers, issueKey) {
  const url = `${base}/rest/api/3/mypermissions?issueKey=${encodeURIComponent(issueKey)}&permissions=${REQUIRED_JIRA_COMMENT_PERMS.join(',')}`;
  const response = await confluenceInternal.callUpstream(ctx.fetchImpl, url, { headers });
  checkJiraAuthStatus(response.status, session, 'issue_not_allowed');
  const payload = await confluenceInternal.readUpstreamJson(response);
  const perms = payload?.permissions;
  if (!perms || REQUIRED_JIRA_COMMENT_PERMS.some(key => perms[key]?.havePermission !== true)) {
    fail(403, 'permission_denied');
  }
}

async function assertExistingFlsIssue(ctx, session, base, headers, issueKey) {
  const url = `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary`;
  const response = await confluenceInternal.callUpstream(ctx.fetchImpl, url, { headers });
  checkJiraAuthStatus(response.status, session, 'not_found');
  const issue = await confluenceInternal.readUpstreamJson(response);
  if (!issue || issue.key !== issueKey) fail(502, 'upstream_invalid');
  return issue;
}

function matchPatternComment(comments, accountId, issueKey, patternHash) {
  let matched = null;
  for (const comment of comments) {
    if (!comment || !COMMENT_ID.test(String(comment.id)) || comment.author?.accountId !== accountId) continue;
    const marker = parseW8PatternMarker(extractAdfText(comment.body).join('\n'));
    if (marker && marker.issueKey === issueKey && marker.patternHash === patternHash) {
      matched = { id: String(comment.id), marker, body: comment.body };
    }
  }
  return matched;
}

async function listPatternComment(ctx, session, issueKey, accountId, patternHash) {
  const base = jiraBase(session.cloudId);
  const headers = confluenceInternal.authHeaders(session.accessToken);
  let startAt = 0;
  let found = null;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const response = await confluenceInternal.callUpstream(
      ctx.fetchImpl,
      `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=100`,
      { headers },
    );
    const payload = await confluenceInternal.readUpstreamJson(response);
    const comments = Array.isArray(payload?.comments) ? payload.comments : null;
    if (!comments) fail(502, 'upstream_invalid');
    const pageMatch = matchPatternComment(comments, accountId, issueKey, patternHash);
    if (pageMatch) found = pageMatch;
    startAt += comments.length;
    const total = Number(payload.total);
    if (!comments.length || !Number.isFinite(total) || startAt >= total) break;
  }
  return found;
}

function cleanPatternText(value, maxLen, required = false) {
  if (value === undefined || value === null) {
    if (required) fail(400, 'invalid_request');
    return '';
  }
  if (typeof value !== 'string') fail(400, 'invalid_request');
  const norm = value.normalize('NFC').trim();
  if (required && !norm) fail(400, 'invalid_request');
  if (!norm) return '';
  if (norm.includes('%PDF-')) fail(422, 'forbidden_content');
  if (UNSAFE_SINGLELINE.test(norm) || norm.length > maxLen) fail(400, 'invalid_request');
  return norm;
}

function validateHistoryJiraLinkBody(body) {
  const allowed = ['issueKey', 'pageId', 'patternKey', 'patternLabel', 'summary', 'revisionSha256'];
  const required = ['issueKey', 'pageId', 'patternKey'];
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_request');
  if (Object.keys(body).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(body, k))) {
    fail(400, 'invalid_request');
  }
  let issueKey;
  try { issueKey = normalizeIssueKey(body.issueKey); } catch { fail(400, 'invalid_request'); }
  if (!FLS_ISSUE_ID.test(issueKey)) fail(403, 'issue_not_allowed');
  const pageId = typeof body.pageId === 'string' ? body.pageId.trim() : '';
  if (!PAGE_ID.test(pageId)) fail(400, 'invalid_request');
  const patternKey = cleanPatternText(body.patternKey, 160, true);
  const patternLabel = cleanPatternText(body.patternLabel, 240, false) || patternKey;
  const summary = cleanPatternText(body.summary, 400, false);
  const revisionSha256 = body.revisionSha256 === undefined || body.revisionSha256 === null || body.revisionSha256 === ''
    ? null
    : (typeof body.revisionSha256 === 'string' && HEX64.test(body.revisionSha256.trim().toLowerCase())
      ? body.revisionSha256.trim().toLowerCase()
      : fail(400, 'invalid_request'));
  return { issueKey, pageId, patternKey, patternLabel, summary, revisionSha256 };
}

function resolveConfluenceTitleForLink(page, pageId) {
  const props = page?.properties?.results;
  if (Array.isArray(props)) {
    const syncProp = props.find(p => p && p.key === 'falsify-w8-paper-sync')?.value;
    if (typeof syncProp?.title === 'string' && syncProp.title.trim()) return syncProp.title.trim().slice(0, 200);
    const archProp = props.find(p => p && p.key === 'falsify-w8-archive')?.value;
    if (typeof archProp?.title === 'string' && archProp.title.trim()) return archProp.title.trim().slice(0, 200);
  }
  return typeof page?.title === 'string' && page.title.trim() ? page.title.trim().slice(0, 200) : `Confluence ${pageId}`;
}

function formatPatternLinkLabel(pageTitle, revisionSha256, summary) {
  const parts = [pageTitle];
  if (revisionSha256) parts.push(`수정본 ${revisionSha256.slice(0, 12)}`);
  if (summary) parts.push(summary);
  return parts.join(' · ').slice(0, 500);
}

function mergePatternEntries(existingComment, currentEntry) {
  const byPage = new Map();
  if (existingComment) {
    const extracted = extractPatternLinkEntries(existingComment.body);
    for (const item of extracted) {
      if (PAGE_ID.test(item.pageId) && !byPage.has(item.pageId)) {
        byPage.set(item.pageId, item);
      }
    }
    for (const pid of existingComment.marker.pageIds) {
      if (!byPage.has(pid)) {
        byPage.set(pid, {
          pageId: pid,
          pageUrl: `${SITE_URL}/wiki/spaces/${SPACE_KEY}/pages/${pid}`,
          label: `Confluence 기록 (${pid})`,
        });
      }
    }
  }
  const hadPage = byPage.has(currentEntry.pageId);
  const prev = byPage.get(currentEntry.pageId);
  if (!hadPage && byPage.size >= MAX_PATTERN_LINKS) fail(413, 'payload_too_large');
  byPage.set(currentEntry.pageId, currentEntry);
  const unchanged = hadPage && prev && prev.pageUrl === currentEntry.pageUrl && prev.label === currentEntry.label;
  return { entries: [...byPage.values()], unchanged };
}

async function handleHistoryJiraLink(ctx, session) {
  const cfg = await requireW8Ready(ctx);
  const rawBody = await confluenceInternal.readRequestJson(ctx.request, 65536, ctx.budget.signal);
  const input = validateHistoryJiraLinkBody(rawBody);

  const resource = await confluenceInternal.accessibleResource(ctx.fetchImpl, session.accessToken);
  if (resource.id !== session.cloudId) fail(403, 'site_not_allowed');
  assertJiraScopes(session, resource.scopes);

  const confBase = confluenceInternal.cloudBase(session.cloudId);
  const page = await confluenceInternal.getPage(ctx.fetchImpl, confBase, session.accessToken, input.pageId);
  if (!page || String(page.spaceId) !== SPACE_ID || (page.status !== undefined && page.status !== 'current')) {
    fail(404, 'not_found');
  }
  await confluenceInternal.assertReadOpen(ctx.fetchImpl, confBase, session.accessToken, input.pageId);
  const pageUrl = confluenceInternal.webUrl(page) || `${SITE_URL}/wiki/spaces/${SPACE_KEY}/pages/${input.pageId}`;
  const pageTitle = resolveConfluenceTitleForLink(page, input.pageId);

  const jBase = jiraBase(session.cloudId);
  const headers = confluenceInternal.authHeaders(session.accessToken);
  const accountId = await fetchJiraAccountId(ctx, session, jBase, headers);
  await assertJiraCommentPermissions(ctx, session, jBase, headers, input.issueKey);
  await assertExistingFlsIssue(ctx, session, jBase, headers, input.issueKey);

  const patternHash = (await sha256HexText(`falsify-w8-pattern:${input.patternKey.toLowerCase()}`)).slice(0, 16);
  const existingComment = await listPatternComment(ctx, session, input.issueKey, accountId, patternHash);
  const currentEntry = {
    pageId: input.pageId,
    pageUrl,
    label: formatPatternLinkLabel(pageTitle, input.revisionSha256, input.summary),
  };
  const { entries, unchanged } = mergePatternEntries(existingComment, currentEntry);
  const linkedPageIds = entries.map(e => e.pageId);
  const progress = {
    pageId: input.pageId,
    pageUrl,
    commentId: existingComment?.id || null,
  };
  ctx.budget.pageId = input.pageId;
  ctx.budget.progress = progress;

  let commentResult;
  if (existingComment && unchanged) {
    commentResult = { commentId: existingComment.id, reused: true, updated: false };
  } else {
    const adfBody = buildPatternCommentAdf({
      issueKey: input.issueKey,
      patternHash,
      patternLabel: input.patternLabel,
      entries,
    });
    commentResult = existingComment
      ? await updateExistingComment(ctx, session, input.issueKey, existingComment.id, adfBody, progress)
      : await createNewComment(ctx, session, input.issueKey, adfBody, progress);
  }

  const alreadyExisted = commentResult.reused && !commentResult.updated;
  return json(commentResult.reused ? 200 : 201, {
    linked: true,
    issueKey: input.issueKey,
    issueUrl: issueBrowseUrl(input.issueKey, commentResult.commentId),
    commentId: commentResult.commentId,
    pageId: input.pageId,
    pageUrl,
    patternHash,
    linkedPageIds,
    reused: commentResult.reused,
    updated: commentResult.updated,
    alreadyExisted,
    spaceKey: cfg.spaceKey,
  });
}

async function handleAuthStart(ctx) {
  await requireW8Ready(ctx);
  return startAtlassianAuth(ctx, { extraScopes: [...W8_JIRA_SCOPES, 'read:confluence-user'], scopeProfile: W8_SCOPE_PROFILE });
}

async function handleAuthRefresh(ctx, session) {
  const key = await confluenceInternal.aesKey(ctx.env);
  const sealed = ctx.refreshed || await confluenceInternal.seal(key, confluenceInternal.SESSION_PURPOSE, session);
  const headers = ctx.refreshed ? { [SESSION_HEADER]: ctx.refreshed, 'Access-Control-Expose-Headers': SESSION_HEADER } : {};
  return json(200, {
    session: sealed,
    expiresAt: new Date(session.envelopeExp).toISOString(),
    hasJiraScope: sessionHasJiraScopes(session),
  }, headers);
}

async function verifyConfinedAccess(ctx, session, cfg, issueKey) {
  const resource = await confluenceInternal.accessibleResource(ctx.fetchImpl, session.accessToken);
  if (resource.id !== session.cloudId) fail(403, 'site_not_allowed');
  assertJiraScopes(session, resource.scopes);
  await confluenceInternal.confine(ctx.fetchImpl, session.accessToken, session.cloudId, cfg.parentPageId);
  return verifyJiraAccountAndPermissions(ctx, session, issueKey);
}

async function handleStatus(ctx, session) {
  const cfg = await requireW8Ready(ctx);
  const params = ctx.url.searchParams;
  if ([...params.keys()].some(k => k !== 'participant' && k !== 'issueKey')) fail(400, 'invalid_request');
  let participant;
  let issueKey;
  try {
    participant = normalizeParticipant(params.get('participant') || '');
    issueKey = params.get('issueKey') ? normalizeIssueKey(params.get('issueKey')) : cfg.issueKey;
  } catch {
    fail(400, 'invalid_request');
  }
  if (!cfg.allowedIssues.includes(issueKey)) fail(403, 'issue_not_allowed');
  const { accountId, attachments } = await verifyConfinedAccess(ctx, session, cfg, issueKey);
  const participantHash = await participantKeyHash(participant);
  const existingComment = await listParticipantComment(ctx, session, issueKey, accountId, participantHash);
  if (!existingComment) return json(200, { found: false, issueKey, issueUrl: issueBrowseUrl(issueKey) });
  const m = existingComment.marker;
  const att = attachments.find(a => a && String(a.id) === m.attachmentId);
  const page = await confluenceInternal.getPage(ctx.fetchImpl, confluenceInternal.cloudBase(session.cloudId), session.accessToken, m.pageId);
  const pageUrl = page && w8ReadyLabel(page) ? confluenceInternal.webUrl(page) : null;
  return json(200, {
    found: true,
    issueKey,
    issueUrl: issueBrowseUrl(issueKey, existingComment.id),
    commentId: existingComment.id,
    pageId: m.pageId,
    pageUrl,
    attachmentId: m.attachmentId,
    attachmentFilename: att?.filename || null,
    attachmentUrl: att ? jiraAttachmentPublicUrl(att, m.attachmentId) : null,
    csvSha256: m.csvSha256,
    archiveSha256: m.archiveSha256,
  });
}

function matchOpt(value, re) {
  return typeof value === 'string' && re.test(value) ? value : null;
}

function parseResumeHint(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'invalid_request');
  const resumeAllowed = ['pageId', 'attachmentId', 'commentId', 'csvSha256', 'archiveSha256'];
  if (Object.keys(raw).some(k => !resumeAllowed.includes(k))) fail(400, 'invalid_request');
  return {
    pageId: matchOpt(raw.pageId, PAGE_ID),
    attachmentId: matchOpt(raw.attachmentId, ATTACHMENT_ID),
    commentId: matchOpt(raw.commentId, COMMENT_ID),
    csvSha256: matchOpt(raw.csvSha256, HEX64),
    archiveSha256: matchOpt(raw.archiveSha256, HEX64),
  };
}

function readCsvBytes(csv) {
  if (typeof csv !== 'string' || !csv.length) fail(422, 'invalid_csv');
  if (csv.includes('%PDF-')) fail(422, 'forbidden_content');
  const csvBytes = encoder.encode(csv);
  if (csvBytes.byteLength > MAX_W8_CSV_BYTES) fail(413, 'payload_too_large');
  return csvBytes;
}

function validateSubmitFields(body) {
  const allowed = ['participant', 'condition', 'filename', 'csv', 'archive', 'issueKey', 'resume'];
  const required = ['participant', 'condition', 'filename', 'csv', 'archive'];
  if (Object.keys(body).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(body, k))) {
    fail(400, 'invalid_request');
  }
  return { csvBytes: readCsvBytes(body.csv), resume: parseResumeHint(body.resume) };
}

function parseSubmitMeta(body, cfg) {
  let meta;
  try {
    meta = {
      participant: normalizeParticipant(body.participant),
      condition: normalizeCondition(body.condition),
      filename: normalizeCsvFilename(body.filename),
      issueKey: body.issueKey === undefined ? cfg.issueKey : normalizeIssueKey(body.issueKey),
    };
  } catch (error) {
    const code = error instanceof W8ArchiveError && error.code === 'invalid_filename' ? 'invalid_csv' : 'invalid_request';
    fail(422, code);
  }
  if (!cfg.allowedIssues.includes(meta.issueKey)) fail(403, 'issue_not_allowed');
  return meta;
}

async function validateSubmitArchive(rawArchive, meta, csvSha256) {
  let validated;
  try {
    validated = await validateW8BlueArchive(rawArchive);
  } catch (error) {
    if (error instanceof W8ArchiveError && error.code === 'payload_too_large') fail(413, 'payload_too_large');
    if (error instanceof W8ArchiveError && error.code === 'forbidden_content') fail(422, 'forbidden_content');
    fail(422, 'invalid_archive');
  }
  const a = validated.normalized;
  const matches = a.participant === meta.participant &&
    a.condition === meta.condition &&
    a.issueKey === meta.issueKey &&
    a.csvFilename === meta.filename &&
    a.csvSha256 === csvSha256;
  if (!matches) fail(422, 'invalid_archive');
  return validated;
}

async function ensureJiraCsvAttachment(ctx, session, { issueKey, attachments, filename, csvBytes, csvSha256, accountId, preferredIds, progress }) {
  const existing = await findExistingJiraAttachment(ctx, session, attachments, {
    filename,
    csvBytes,
    csvSha256,
    accountId,
    preferredIds,
  });
  return existing || uploadJiraCsvAttachment(ctx, session, issueKey, filename, csvBytes, progress);
}

async function handleSubmit(ctx, session) {
  const cfg = await requireW8Ready(ctx);
  const body = await confluenceInternal.readRequestJson(ctx.request, MAX_ARCHIVE_BYTES + MAX_W8_CSV_BYTES + 16384, ctx.budget.signal);
  const { csvBytes, resume } = validateSubmitFields(body);
  const meta = parseSubmitMeta(body, cfg);
  const csvSha256 = await sha256HexBytes(csvBytes);
  const { normalized: archive, bytes: archiveBytes, archiveSha256 } = await validateSubmitArchive(body.archive, meta, csvSha256);

  const { accountId, attachments } = await verifyConfinedAccess(ctx, session, cfg, meta.issueKey);
  const participantHash = await participantKeyHash(meta.participant);
  const existingComment = await listParticipantComment(ctx, session, meta.issueKey, accountId, participantHash);

  const pageResult = await ensureConfluenceW8Archive(ctx, session, cfg.parentPageId, archive, archiveSha256, archiveBytes);
  const progress = {
    pageId: pageResult.pageId,
    pageUrl: pageResult.pageUrl,
    archiveSha256,
    attachmentId: null,
    attachmentUrl: null,
    commentId: existingComment?.id || null,
    csvSha256,
  };
  ctx.budget.progress = progress;

  const preferredIds = [resume?.attachmentId, existingComment?.marker?.attachmentId].filter(Boolean);
  const attResult = await ensureJiraCsvAttachment(ctx, session, {
    issueKey: meta.issueKey, attachments, filename: meta.filename, csvBytes, csvSha256, accountId, preferredIds, progress,
  });
  progress.attachmentId = attResult.attachmentId;
  progress.attachmentUrl = attResult.attachmentUrl;

  const commentResult = await upsertParticipantComment(ctx, session, {
    issueKey: meta.issueKey,
    existingComment,
    archive,
    archiveSha256,
    pageId: pageResult.pageId,
    pageUrl: pageResult.pageUrl,
    attachmentId: attResult.attachmentId,
    attachmentUrl: attResult.attachmentUrl,
    participantHash,
    progress,
  });
  progress.commentId = commentResult.commentId;

  const alreadyExisted = pageResult.reused && attResult.reused && commentResult.reused && !commentResult.updated;
  return json(alreadyExisted || commentResult.updated ? 200 : 201, {
    submitted: true,
    pageId: pageResult.pageId,
    pageUrl: pageResult.pageUrl,
    issueKey: meta.issueKey,
    issueUrl: issueBrowseUrl(meta.issueKey, commentResult.commentId),
    attachmentId: attResult.attachmentId,
    attachmentFilename: attResult.attachmentFilename,
    attachmentUrl: attResult.attachmentUrl,
    commentId: commentResult.commentId,
    csvSha256,
    archiveSha256,
    reused: { page: pageResult.reused, attachment: attResult.reused, comment: commentResult.reused },
    alreadyExisted,
    commentUpdated: commentResult.updated,
  });
}

const ROUTES = {
  '/v1/w8/history/auth/start': { POST: ctx => startAtlassianAuth(ctx, {
    extraScopes: ['read:confluence-user', 'read:jira-work'], scopeProfile: 'w8-history',
  }) },
  '/v1/w8/history/jira': { GET: async ctx => handleJiraHistory(ctx, await confluenceInternal.bearerSession(ctx)) },
  '/v1/w8/history/jira-link': { POST: async ctx => handleHistoryJiraLink(ctx, await confluenceInternal.bearerSession(ctx)) },
  '/v1/w8/history/confluence': { GET: async ctx => handleConfluenceHistory(ctx, await confluenceInternal.bearerSession(ctx)) },
  '/v1/w8/paper-attachments': { GET: async ctx => handleW8LibraryAttachments(ctx, await confluenceInternal.bearerSession(ctx)) },
  '/v1/w8/capabilities': { GET: ctx => handleCapabilities(ctx) },
  '/v1/w8/auth/start': { POST: ctx => handleAuthStart(ctx) },
  '/v1/w8/auth/refresh': { POST: async ctx => handleAuthRefresh(ctx, await confluenceInternal.bearerSession(ctx)) },
  '/v1/w8/status': { GET: async ctx => handleStatus(ctx, await confluenceInternal.bearerSession(ctx)) },
  '/v1/w8/submit': { POST: async ctx => handleSubmit(ctx, await confluenceInternal.bearerSession(ctx)) },
  '/v1/w8/paper-auth/start': { POST: ctx => startAtlassianAuth(ctx, { extraScopes: ['read:confluence-user'] }) },
  '/v1/w8/paper-sync': { PUT: async ctx => handleW8PaperSync(ctx, await confluenceInternal.bearerSession(ctx)) },
  '/v1/w8/papers': { GET: async ctx => handleW8Papers(ctx, await confluenceInternal.bearerSession(ctx)) },
};

export function matchW8(pathname) {
  if (Object.hasOwn(ROUTES, pathname)) return { template: pathname };
  if (pathname.startsWith('/v1/w8/')) return { template: '/v1/w8/unknown' };
  return null;
}

function isW8WriteRoute(ctx) {
  return (ctx.match.template === '/v1/w8/submit' && ctx.request.method === 'POST') ||
    (ctx.match.template === '/v1/w8/paper-sync' && ctx.request.method === 'PUT') ||
    (ctx.match.template === '/v1/w8/history/jira-link' && ctx.request.method === 'POST');
}

function makeBudgetedFetch(ctx, budget) {
  const upstream = ctx.fetchImpl || globalThis.fetch.bind(globalThis);
  const fetchImpl = (url, init) => {
    if (budget.signal.aborted || Date.now() >= budget.end) throw new Error('request deadline');
    if (isW8WriteRoute(ctx) && /^(POST|PUT)$/.test(init?.method || 'GET') && new URL(url).hostname === 'api.atlassian.com') {
      budget.mutationStarted = true;
    }
    return upstream(url, init);
  };
  fetchImpl.budget = budget;
  return fetchImpl;
}

function budgetExpiryError(budget) {
  const mutated = budget.mutationStarted || !!budget.pageId;
  const extra = mutated ? { pageId: budget.pageId, readBack: true, ...(budget.progress ? { progress: budget.progress } : {}) } : null;
  return new GatewayError(mutated ? 409 : 502, mutated ? 'write_unknown' : 'upstream_unavailable', {}, extra);
}

export async function handleW8(ctx) {
  const controller = new AbortController();
  const duration = ctx.requestBudgetMs ?? (isW8WriteRoute(ctx) ? 80000 : 25000);
  const budget = { signal: controller.signal, end: Date.now() + duration, mutationStarted: false, pageId: null, progress: null };
  const context = { ...ctx, fetchImpl: makeBudgetedFetch(ctx, budget), budget, now: ctx.now || Date.now, refreshed: null };
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(budgetExpiryError(budget)); }, duration);
  });
  try {
    const route = ROUTES[ctx.match.template];
    if (!route) fail(404, 'not_found');
    if (ctx.request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { 'Access-Control-Allow-Methods': 'GET, POST, PUT', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' },
      });
    }
    const handler = route[ctx.request.method];
    if (!handler) fail(405, 'method_not_allowed', { Allow: Object.keys(route).join(', ') });
    const response = await Promise.race([handler(context), deadline]);
    if (Date.now() >= budget.end) throw budgetExpiryError(budget);
    return confluenceInternal.withSession(response, context);
  } catch (error) {
    const known = error instanceof GatewayError ? error : new GatewayError(500, 'internal_error');
    return confluenceInternal.withSession(errorResponse(known), context);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
