// Authenticated read-only W8 team Jira history gateway (GET /v1/w8/history/jira).
// Searches fixed project FLS (key DESC) via /rest/api/3/search/jql, reads visible FLS issue
// details/links/comments/attachments, and serves issue-bound PDF/text previews or native links.
// Requires only read:jira-work on the caller's existing Atlassian OAuth bearer session. No writes.
import {
  SITE_URL,
  GatewayError,
  confluenceConfig,
  confluenceInternal,
} from './confluence.mjs';
import { jiraBase, downloadJiraAttachmentBytes } from './w8-jira-files.mjs';

export const JIRA_HISTORY_SOURCE = 'jira';
export const JIRA_PROJECT_KEY = 'FLS';
export const JIRA_HISTORY_JQL = 'project = FLS ORDER BY key DESC';
export const JIRA_READ_SCOPE = 'read:jira-work';

const ALLOWED_SCOPE_PROFILES = new Set(['w8-history', 'w8-team']);
const FLS_ISSUE_ID = /^FLS-[1-9][0-9]{0,7}$/;
const ATTACHMENT_ID = /^[0-9]{1,20}$/;
const LIST_CURSOR_PURPOSE = 'falsify.w8-history-jira.list-cursor.v1';
const ATT_CURSOR_PURPOSE = 'falsify.w8-history-jira.att-cursor.v1';
const CLIENT_CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;
const UNSAFE_SINGLELINE = /[\u0000-\u001f\u007f]/;
const UNSAFE_TOKEN = /[\u0000-\u001f\u007f\s]/;
const SENSITIVE_QUERY_KEYS = new Set(['token', 'access_token', 'sig', 'signature', 'auth', 'key']);
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

const MAX_SEALED = 8192;
const MAX_UPSTREAM_TOKEN_CHARS = 2048;
const MAX_TITLE_CHARS = 500;
const LIST_PAGE_LIMIT = 25;
const ATTACHMENT_PAGE_LIMIT = 25;
const MAX_LINKS = 50;
const MAX_COMMENTS = 20;
const MAX_ADF_DEPTH = 24;
const MAX_DETAIL_TEXT_CHARS = 128 * 1024;
const DEFAULT_MAX_PDF_BYTES = 12 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 100_000;
const HARD_MAX_TEXT_CHARS = 500_000;

const BLOCKED_TEXT_MIMES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml']);
const BLOCKED_TEXT_EXTS = new Set(['.html', '.htm', '.xhtml', '.svg']);
const ALLOWED_TEXT_EXTS = new Set(['.md', '.markdown', '.csv', '.txt', '.json']);
const ALLOWED_TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'application/csv',
  'application/json',
  'text/json',
]);
const GENERIC_BINARY_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const lossyDecoder = new TextDecoder('utf-8', { fatal: false });

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

function pdfBinaryResponse(bytes) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': 'inline; filename="attachment.pdf"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function hasValidSecret(env) {
  const secret = String(env?.ATLASSIAN_CLIENT_SECRET || '');
  return secret.length >= 8 && secret.length <= 256 && !/[\u0000-\u001f]/.test(secret);
}

function resolvePositiveBound(raw, fallback, hardMax) {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, hardMax);
}

function resolveMaxFileBytes(env) {
  const explicit = env?.W8_HISTORY_MAX_PDF_BYTES;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    return resolvePositiveBound(explicit, DEFAULT_MAX_PDF_BYTES, HARD_MAX_FILE_BYTES);
  }
  const uploadCap = Number(env?.AI_MAX_UPLOAD_BYTES);
  if (Number.isSafeInteger(uploadCap) && uploadCap > 0 && uploadCap < DEFAULT_MAX_PDF_BYTES) {
    return uploadCap;
  }
  return DEFAULT_MAX_PDF_BYTES;
}

function resolveMaxTextChars(env) {
  return resolvePositiveBound(env?.W8_HISTORY_MAX_TEXT_CHARS, DEFAULT_MAX_TEXT_CHARS, HARD_MAX_TEXT_CHARS);
}

async function requireHistoryConfig(ctx) {
  const conf = confluenceConfig(ctx.env || {});
  const key = await confluenceInternal.aesKey(ctx.env || {});
  const ready = conf.fixed && !!conf.client && hasValidSecret(ctx.env) && !!conf.callback && !!key;
  if (!ready) fail(503, 'not_configured');
  return {
    key,
    maxFileBytes: resolveMaxFileBytes(ctx.env),
    maxTextChars: resolveMaxTextChars(ctx.env),
  };
}

function base64ToBytes(text) {
  if (typeof text !== 'string' || !text || text.length > MAX_SEALED) return null;
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pad)) return null;
  const raw = atob(pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function openSealed(key, purpose, token) {
  if (typeof token !== 'string' || token.length < 24 || token.length > MAX_SEALED) return null;
  const bytes = base64ToBytes(token);
  if (!bytes || bytes.length < 29) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(purpose) },
      key,
      bytes.slice(12),
    );
    const parsed = JSON.parse(strictDecoder.decode(new Uint8Array(plain)));
    return parsed && typeof parsed === 'object' && parsed.purpose === purpose ? parsed : null;
  } catch {
    return null;
  }
}

function sessionHasJiraReadScope(session, resourceScopes = null) {
  if (Array.isArray(resourceScopes) && !resourceScopes.includes(JIRA_READ_SCOPE)) return false;
  if (Array.isArray(session?.scopes) && !session.scopes.includes(JIRA_READ_SCOPE)) return false;
  if (Array.isArray(resourceScopes) || Array.isArray(session?.scopes)) return true;
  return ALLOWED_SCOPE_PROFILES.has(session?.scopeProfile);
}

async function verifyJiraReadAccess(ctx, session) {
  if (Array.isArray(session.scopes) && !session.scopes.includes(JIRA_READ_SCOPE)) {
    fail(403, 'jira_scope_required');
  }
  const resource = await confluenceInternal.accessibleResource(ctx.fetchImpl, session.accessToken);
  if (resource.id !== session.cloudId) fail(403, 'site_not_allowed');
  if (!sessionHasJiraReadScope(session, resource.scopes)) fail(403, 'jira_scope_required');
  return resource.scopes;
}

function checkJiraStatus(status, session, resourceScopes, notFoundCode = null) {
  if (status === 401) fail(403, 'jira_scope_required');
  if (status === 403) {
    fail(403, sessionHasJiraReadScope(session, resourceScopes) ? 'permission_denied' : 'jira_scope_required');
  }
  if (notFoundCode && status === 404) fail(404, notFoundCode);
}

function cleanSingleLine(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(UNSAFE_SINGLELINE, '').trim();
  if (!cleaned) return fallback;
  return cleaned.length > MAX_TITLE_CHARS ? cleaned.slice(0, MAX_TITLE_CHARS) : cleaned;
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function issueBrowseUrl(issueKey) {
  return `${SITE_URL}/browse/${encodeURIComponent(issueKey)}`;
}

function safeSiteUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || parsed.origin !== SITE_URL || parsed.username || parsed.password) {
      return null;
    }
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function jiraAttachmentPublicUrl(att, attachmentId) {
  const candidate = safeSiteUrl(att?.content);
  if (candidate && candidate.includes('/attachment/')) return candidate;
  return `${SITE_URL}/rest/api/3/attachment/content/${encodeURIComponent(String(attachmentId))}`;
}

function baseMediaType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().split(';')[0].trim() : '';
}

function fileExtension(filename) {
  if (typeof filename !== 'string') return '';
  const clean = filename.trim().toLowerCase();
  const dot = clean.lastIndexOf('.');
  return dot > 0 && dot < clean.length - 1 ? clean.slice(dot) : '';
}

export function classifyJiraAttachment(att) {
  const mime = baseMediaType(att?.mimeType);
  const ext = fileExtension(att?.filename);
  if (BLOCKED_TEXT_MIMES.has(mime) || BLOCKED_TEXT_EXTS.has(ext)) return 'file';
  if (mime === 'application/pdf') return 'pdf';
  if (ext === '.pdf' && GENERIC_BINARY_MIMES.has(mime)) return 'pdf';
  const nonTextMedia = mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/');
  if (ALLOWED_TEXT_EXTS.has(ext) && !nonTextMedia) return 'text';
  if (ALLOWED_TEXT_MIMES.has(mime) && ext !== '.pdf') return 'text';
  return 'file';
}

function hasPdfMagic(bytes) {
  if (!bytes || bytes.byteLength < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

function assertValidFlsId(rawId) {
  if (typeof rawId !== 'string' || !FLS_ISSUE_ID.test(rawId)) fail(400, 'invalid_request');
  return rawId;
}

function assertValidAttachmentId(rawFile) {
  if (typeof rawFile !== 'string' || !ATTACHMENT_ID.test(rawFile)) fail(400, 'invalid_request');
  return rawFile;
}

function parseQueryParams(url) {
  const params = url.searchParams;
  const allowed = new Set(['cursor', 'id', 'attachmentCursor', 'file']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length > 1) fail(400, 'invalid_request');
  }
  const hasId = params.has('id');
  const hasCursor = params.has('cursor');
  const hasAttCursor = params.has('attachmentCursor');
  if (params.has('file')) {
    if (!hasId || hasCursor || hasAttCursor) fail(400, 'invalid_request');
    return { mode: 'file', id: assertValidFlsId(params.get('id')), file: assertValidAttachmentId(params.get('file')) };
  }
  if (hasId) {
    if (hasCursor) fail(400, 'invalid_request');
    return { mode: 'detail', id: assertValidFlsId(params.get('id')), attachmentCursor: params.get('attachmentCursor') || null };
  }
  if (hasAttCursor) fail(400, 'invalid_request');
  return { mode: 'list', cursor: params.get('cursor') || null };
}

function validUpstreamToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= MAX_UPSTREAM_TOKEN_CHARS && !UNSAFE_TOKEN.test(token);
}

async function openListCursor(cursor, key, cloudId) {
  if (cursor === null) return null;
  if (!CLIENT_CURSOR.test(cursor)) fail(400, 'invalid_cursor');
  const opened = await openSealed(key, LIST_CURSOR_PURPOSE, cursor);
  if (!opened || opened.cloudId !== cloudId || !validUpstreamToken(opened.token)) {
    fail(400, 'invalid_cursor');
  }
  return opened.token;
}

async function sealListCursor(key, cloudId, nextPageToken) {
  if (!nextPageToken) return null;
  if (!validUpstreamToken(nextPageToken)) fail(502, 'upstream_invalid');
  const sealed = await confluenceInternal.seal(key, LIST_CURSOR_PURPOSE, {
    purpose: LIST_CURSOR_PURPOSE,
    cloudId,
    token: nextPageToken,
  });
  if (!CLIENT_CURSOR.test(sealed)) fail(502, 'upstream_invalid');
  return sealed;
}

async function openAttachmentCursor(cursor, key, cloudId, issueId) {
  if (cursor === null) return 0;
  if (!CLIENT_CURSOR.test(cursor)) fail(400, 'invalid_cursor');
  const opened = await openSealed(key, ATT_CURSOR_PURPOSE, cursor);
  const ok = opened &&
    opened.cloudId === cloudId &&
    opened.issueId === issueId &&
    Number.isSafeInteger(opened.offset) &&
    opened.offset > 0;
  if (!ok) fail(400, 'invalid_cursor');
  return opened.offset;
}

async function sealAttachmentCursor(key, cloudId, issueId, offset) {
  const sealed = await confluenceInternal.seal(key, ATT_CURSOR_PURPOSE, {
    purpose: ATT_CURSOR_PURPOSE,
    cloudId,
    issueId,
    offset,
  });
  if (!CLIENT_CURSOR.test(sealed)) fail(502, 'upstream_invalid');
  return sealed;
}

function countValidAttachments(rawList) {
  if (!Array.isArray(rawList)) return undefined;
  let count = 0;
  for (const att of rawList) {
    if (att && ATTACHMENT_ID.test(String(att.id))) count++;
  }
  return count;
}

function formatListItem(issue) {
  if (!issue || typeof issue !== 'object' || !FLS_ISSUE_ID.test(String(issue.key || ''))) return null;
  const id = String(issue.key);
  const fields = issue.fields && typeof issue.fields === 'object' ? issue.fields : {};
  const item = {
    id,
    title: cleanSingleLine(fields.summary, id),
    url: issueBrowseUrl(id),
    updatedAt: normalizeIsoTimestamp(fields.updated),
    kind: cleanSingleLine(fields.issuetype?.name, 'issue'),
  };
  const attachmentCount = countValidAttachments(fields.attachment);
  if (attachmentCount !== undefined) item.attachmentCount = attachmentCount;
  return item;
}

async function handleList(ctx, session, cfg, resourceScopes, cursor) {
  const nextPageToken = await openListCursor(cursor, cfg.key, session.cloudId);
  const base = jiraBase(session.cloudId);
  const qs = new URLSearchParams({
    jql: JIRA_HISTORY_JQL,
    maxResults: String(LIST_PAGE_LIMIT),
    fields: 'summary,updated,issuetype,attachment',
  });
  if (nextPageToken) qs.set('nextPageToken', nextPageToken);
  const response = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/rest/api/3/search/jql?${qs.toString()}`,
    { headers: confluenceInternal.authHeaders(session.accessToken) },
  );
  if (response.status === 400 && nextPageToken) fail(400, 'invalid_cursor');
  checkJiraStatus(response.status, session, resourceScopes);
  const payload = await confluenceInternal.readUpstreamJson(response);
  if (!payload || !Array.isArray(payload.issues) || payload.issues.length > LIST_PAGE_LIMIT) {
    fail(502, 'upstream_invalid');
  }
  const items = payload.issues.map(formatListItem).filter(Boolean);
  const rawNext = payload.isLast === true ? null : (typeof payload.nextPageToken === 'string' && payload.nextPageToken ? payload.nextPageToken : null);
  const nextCursor = await sealListCursor(cfg.key, session.cloudId, rawNext);
  return json(200, { items, nextCursor });
}

function addSourceLocalLink(linksMap, url, title) {
  if (linksMap.size >= MAX_LINKS) return;
  const safe = safeSiteUrl(url);
  if (!safe || linksMap.has(safe)) return;
  linksMap.set(safe, { title: cleanSingleLine(title, safe), url: safe });
}

const CARD_NODE_TYPES = new Set(['inlineCard', 'blockCard', 'embedCard']);

function collectNodeLinks(node, linksMap) {
  if (node.type === 'text' && Array.isArray(node.marks)) {
    for (const mark of node.marks) {
      if (mark?.type === 'link' && mark.attrs?.href) {
        addSourceLocalLink(linksMap, mark.attrs.href, node.text || mark.attrs.title || mark.attrs.href);
      }
    }
  }
  if (CARD_NODE_TYPES.has(node.type) && node.attrs?.url) {
    addSourceLocalLink(linksMap, node.attrs.url, node.attrs.url);
  }
}

function renderAdfDate(timestamp) {
  const ms = Number(timestamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

function renderAdfLeaf(node) {
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return cleanSingleLine(node.attrs?.text, '');
  if (node.type === 'status') {
    const label = cleanSingleLine(node.attrs?.text, '');
    return label ? `[${label}]` : '';
  }
  if (node.type === 'date' && node.attrs?.timestamp) return renderAdfDate(node.attrs.timestamp);
  if (CARD_NODE_TYPES.has(node.type) && node.attrs?.url) return safeSiteUrl(node.attrs.url) || '';
  return null;
}

const SITE_URL_IN_TEXT = /https:\/\/falsify\.atlassian\.net\/[^\s<>()[\]"']+/g;

function collectPlainTextLinks(text, linksMap) {
  for (const match of text.matchAll(SITE_URL_IN_TEXT)) {
    const cleaned = match[0].replace(/[.,;:!?]+$/, '');
    addSourceLocalLink(linksMap, cleaned, cleaned);
  }
}

function renderAdfChildren(node, linksMap, depth) {
  if (!Array.isArray(node.content) || depth >= MAX_ADF_DEPTH) return '';
  const parts = node.content.map(child => renderAdfNode(child, linksMap, depth + 1)).filter(Boolean);
  if (node.type === 'listItem') return `- ${parts.join('\n  ')}`;
  if (node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'table') return parts.join('\n');
  if (node.type === 'tableRow') return parts.join(' | ');
  if (node.type === 'doc' || node.type === 'blockquote' || node.type === 'panel' || node.type === 'expand') {
    return parts.join('\n\n');
  }
  return parts.join('');
}

function renderAdfNode(node, linksMap, depth = 0) {
  if (typeof node === 'string') {
    collectPlainTextLinks(node, linksMap);
    return node;
  }
  if (!node || typeof node !== 'object' || depth > MAX_ADF_DEPTH) return '';
  collectNodeLinks(node, linksMap);
  const leaf = renderAdfLeaf(node);
  if (leaf !== null) return leaf;
  if (node.type === 'media' || node.type === 'mediaSingle' || node.type === 'mediaGroup') return '';
  return renderAdfChildren(node, linksMap, depth);
}

function extractIssueLinks(rawLinks, linksMap) {
  if (!Array.isArray(rawLinks)) return;
  for (const entry of rawLinks) {
    if (!entry || typeof entry !== 'object') continue;
    const target = entry.outwardIssue || entry.inwardIssue;
    const key = typeof target?.key === 'string' ? target.key : '';
    if (!FLS_ISSUE_ID.test(key)) continue;
    const relation = entry.outwardIssue ? entry.type?.outward : entry.type?.inward;
    const summary = cleanSingleLine(target.fields?.summary, '');
    const prefix = cleanSingleLine(relation, '');
    const label = [prefix ? `${prefix}:` : '', key, summary ? `· ${summary}` : ''].filter(Boolean).join(' ');
    addSourceLocalLink(linksMap, issueBrowseUrl(key), label);
  }
}

function formatCommentsSection(rawComments, linksMap) {
  if (!Array.isArray(rawComments) || rawComments.length === 0) return '';
  const recent = rawComments.slice(-MAX_COMMENTS);
  const blocks = [];
  for (const comment of recent) {
    if (!comment || typeof comment !== 'object') continue;
    const body = renderAdfNode(comment.body, linksMap).trim();
    if (!body) continue;
    const author = cleanSingleLine(comment.author?.displayName, 'Team member');
    const ts = normalizeIsoTimestamp(comment.updated || comment.created) || '';
    const header = ts ? `[${ts}] ${author}:` : `${author}:`;
    blocks.push(`${header}\n${body}`);
  }
  return blocks.length ? `--- Comments ---\n${blocks.join('\n\n')}` : '';
}

function formatAttachmentEntry(att) {
  if (!att || typeof att !== 'object') return null;
  const id = typeof att.id === 'string' || typeof att.id === 'number' ? String(att.id) : '';
  if (!ATTACHMENT_ID.test(id)) return null;
  return {
    id,
    title: cleanSingleLine(att.filename, `attachment-${id}`),
    type: classifyJiraAttachment(att),
    url: jiraAttachmentPublicUrl(att, id),
  };
}

async function fetchJiraIssue(ctx, session, resourceScopes, issueId, fields) {
  const base = jiraBase(session.cloudId);
  const url = `${base}/rest/api/3/issue/${encodeURIComponent(issueId)}?fields=${encodeURIComponent(fields)}`;
  const response = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    url,
    { headers: confluenceInternal.authHeaders(session.accessToken) },
  );
  checkJiraStatus(response.status, session, resourceScopes, 'not_found');
  const issue = await confluenceInternal.readUpstreamJson(response);
  if (!issue || issue.key !== issueId || !issue.fields || typeof issue.fields !== 'object') {
    fail(502, 'upstream_invalid');
  }
  return issue;
}

async function handleDetail(ctx, session, cfg, resourceScopes, issueId, attachmentCursor) {
  const offset = await openAttachmentCursor(attachmentCursor, cfg.key, session.cloudId, issueId);
  const issue = await fetchJiraIssue(
    ctx,
    session,
    resourceScopes,
    issueId,
    'summary,description,updated,issuetype,attachment,issuelinks,comment',
  );
  const fields = issue.fields;
  const linksMap = new Map();
  extractIssueLinks(fields.issuelinks, linksMap);
  const description = renderAdfNode(fields.description, linksMap).trim();
  const commentsBlock = formatCommentsSection(fields.comment?.comments, linksMap);
  const combinedText = [description, commentsBlock].filter(Boolean).join('\n\n').slice(0, MAX_DETAIL_TEXT_CHARS);

  const allAttachments = (Array.isArray(fields.attachment) ? fields.attachment : [])
    .map(formatAttachmentEntry)
    .filter(Boolean);
  const pageSlice = allAttachments.slice(offset, offset + ATTACHMENT_PAGE_LIMIT);
  const nextOffset = offset + ATTACHMENT_PAGE_LIMIT;
  const nextAttachmentCursor = nextOffset < allAttachments.length
    ? await sealAttachmentCursor(cfg.key, session.cloudId, issueId, nextOffset)
    : null;

  return json(200, {
    id: issueId,
    title: cleanSingleLine(fields.summary, issueId),
    url: issueBrowseUrl(issueId),
    updatedAt: normalizeIsoTimestamp(fields.updated),
    kind: cleanSingleLine(fields.issuetype?.name, 'issue'),
    text: combinedText,
    links: [...linksMap.values()],
    attachments: pageSlice,
    nextAttachmentCursor,
  });
}

function assertAttachmentSize(att, maxBytes) {
  if (att.size === undefined || att.size === null) return;
  const size = Number(att.size);
  if (!Number.isSafeInteger(size) || size < 0) fail(502, 'upstream_invalid');
  if (size > maxBytes) fail(413, 'payload_too_large');
}

function sliceSurrogateSafe(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}

function decodeTextPreview(bytes, maxTextChars) {
  if (bytes.includes(0)) fail(502, 'upstream_invalid');
  let text = lossyDecoder.decode(bytes);
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  return sliceSurrogateSafe(text, maxTextChars);
}

async function handleFile(ctx, session, cfg, resourceScopes, issueId, fileId) {
  const issue = await fetchJiraIssue(ctx, session, resourceScopes, issueId, 'summary,attachment');
  const attachments = Array.isArray(issue.fields.attachment) ? issue.fields.attachment : [];
  const att = attachments.find(item => item && String(item.id) === fileId);
  if (!att) fail(404, 'not_found');

  const type = classifyJiraAttachment(att);
  if (type === 'file') {
    return json(200, {
      id: fileId,
      title: cleanSingleLine(att.filename, `attachment-${fileId}`),
      type: 'file',
      url: jiraAttachmentPublicUrl(att, fileId),
    });
  }

  assertAttachmentSize(att, cfg.maxFileBytes);
  const bytes = await downloadJiraAttachmentBytes(
    ctx.fetchImpl,
    session.cloudId,
    session.accessToken,
    fileId,
    { maxBytes: cfg.maxFileBytes, strictStatus: true },
  );
  if (type === 'pdf') {
    if (!hasPdfMagic(bytes)) fail(502, 'upstream_invalid');
    return pdfBinaryResponse(bytes);
  }
  return json(200, decodeTextPreview(bytes, cfg.maxTextChars));
}

export async function handleJiraHistory(ctx, session) {
  if (!session || typeof session.accessToken !== 'string' || typeof session.cloudId !== 'string') {
    fail(401, 'unauthorized');
  }
  const cfg = await requireHistoryConfig(ctx);
  const query = parseQueryParams(ctx.url);
  const resourceScopes = await verifyJiraReadAccess(ctx, session);
  if (query.mode === 'list') return handleList(ctx, session, cfg, resourceScopes, query.cursor);
  if (query.mode === 'detail') {
    return handleDetail(ctx, session, cfg, resourceScopes, query.id, query.attachmentCursor);
  }
  return handleFile(ctx, session, cfg, resourceScopes, query.id, query.file);
}
