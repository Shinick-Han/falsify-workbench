// Read-only Confluence history browser for W8 (GET /v1/w8/history/confluence).
// Lists real readable pages across fixed Falsify space 65737 (archive parent 8355842,
// study rounds, source paper references, and W8 pages) using the caller's existing
// OAuth bearer session and read:page/read:attachment scopes (no writes, no search scope).
import {
  SITE_URL,
  SPACE_KEY,
  SPACE_ID,
  MAX_ARCHIVE_BYTES,
  GatewayError,
  confluenceConfig,
  budgetedFetch,
  confluenceInternal,
} from './confluence.mjs';
import { W8_ARCHIVE_SCHEMA, sha256HexBytes } from './w8-archive.mjs';
import {
  W8_PAPER_SYNC_SCHEMA,
  parseAppOwnedPaperBody,
  validateRoundGradesPayload,
  analyzeTeamRecord,
} from './w8-paper-sync.mjs';

export const HISTORY_SOURCE = 'confluence';
export const DEFAULT_ARCHIVE_PARENT_ID = '8355842';
export const DEFAULT_LIBRARY_PARENT_ID = '20512769';

const LIST_CURSOR_PURPOSE = 'falsify.w8-history-confluence.list-cursor.v1';
const ATT_CURSOR_PURPOSE = 'falsify.w8-history-confluence.att-cursor.v1';

const PAGE_ID = /^[0-9]{1,20}$/;
const ATTACHMENT_ID = /^(?:att)?([0-9]{1,20})$/;
const UPSTREAM_CURSOR = /^[A-Za-z0-9_=-]{1,512}$/;
const CLIENT_CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;
const UNSAFE_SINGLELINE = /[\u0000-\u001f\u007f]/;
const HASH_ARCHIVE_TITLE_RE = /^Falsify\s+(experiment|harness|paper-edit|attempt|external-response|w8-blue|w8-paper)\s+([a-f0-9]{64})$/i;
const ARCHIVE_SUMMARY_RE = /Falsify team archive \(([a-z-]+)\)\.\s*Title\s+(.+?)\.\s*Id\s+([^\n]+?)\.\s*SHA-256\s+[a-f0-9]{64}\./i;
const W8_BLUE_SUMMARY_RE = /Falsify W8 BLUE team archive\.\s*Participant:\s*([^.\n]+?)\.\s*Condition:\s*([^.\n]+?)\.\s*Jira issue:\s*([A-Z][A-Z0-9_]{1,15}-[1-9][0-9]{0,7})\./i;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

const PAGE_LIMIT = 25;
const ENRICH_CONCURRENCY = 5;
const MAX_SEALED = 8192;
const MAX_TITLE_CHARS = 500;
const MAX_DETAIL_TEXT_CHARS = 100_000;
const MAX_TEXT_PREVIEW_CHARS = 200_000;
const MAX_LINKS = 100;
const MAX_ADF_DEPTH = 64;

const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/ndjson',
  'application/x-ndjson',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'text/markdown',
  'text/x-markdown',
  'text/xml',
  'text/yaml',
  'text/x-yaml',
]);
const TEXT_EXT_RE = /\.(?:txt|md|markdown|csv|tsv|json|jsonl|ndjson|yaml|yml|log|tex|bib|xml)$/i;
const OCTET_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const ALLOWED_QUERY_KEYS = new Set(['cursor', 'id', 'attachmentCursor', 'file']);
const BLOCK_ADF_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'tableRow',
  'blockquote',
  'codeBlock',
  'panel',
  'rule',
  'bulletList',
  'orderedList',
  'expand',
  'nestedExpand',
]);
const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const lenientDecoder = new TextDecoder('utf-8', { fatal: false });

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

function hasValidSecret(env) {
  const secret = String(env?.ATLASSIAN_CLIENT_SECRET || '');
  return secret.length >= 8 && secret.length <= 256 && !/[\u0000-\u001f]/.test(secret);
}

function resolvePageIdEnv(raw, fallback) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return fallback;
  return PAGE_ID.test(trimmed) ? trimmed : fallback;
}

function historyConfig(env) {
  const conf = confluenceConfig(env || {});
  const configured = conf.fixed && !!conf.client && hasValidSecret(env) && !!conf.callback;
  return {
    configured,
    archiveParentId: resolvePageIdEnv(env?.CONFLUENCE_PARENT_PAGE_ID, DEFAULT_ARCHIVE_PARENT_ID),
    libraryParentId: resolvePageIdEnv(env?.W8_CONFLUENCE_LIBRARY_PARENT_ID, DEFAULT_LIBRARY_PARENT_ID),
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

function validTitle(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.normalize('NFC').trim();
  if (!trimmed || trimmed.length > MAX_TITLE_CHARS || UNSAFE_SINGLELINE.test(trimmed)) return null;
  return trimmed;
}

function baseMediaType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().split(';')[0].trim() : '';
}

function hasPdfMagic(bytes) {
  if (!bytes || bytes.byteLength < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

function resolveMaxPdfBytes(env) {
  let limit = MAX_ARCHIVE_BYTES;
  for (const raw of [env?.W8_HISTORY_MAX_PDF_BYTES, env?.W8_PDF_LINK_MAX_BYTES, env?.AI_MAX_UPLOAD_BYTES]) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0 && n < limit) limit = n;
  }
  return limit;
}

function resolveMaxTextChars(env) {
  const n = Number(env?.W8_HISTORY_MAX_TEXT_CHARS);
  if (Number.isSafeInteger(n) && n > 0 && n < MAX_TEXT_PREVIEW_CHARS) return n;
  return MAX_TEXT_PREVIEW_CHARS;
}

function parseAttachmentId(raw) {
  if (typeof raw !== 'string') fail(400, 'invalid_request');
  const match = ATTACHMENT_ID.exec(raw);
  if (!match) fail(400, 'invalid_request');
  return { raw, digits: match[1], v2Id: `att${match[1]}`, hasPrefix: raw.startsWith('att') };
}

function alternateAttachmentId(id) {
  return id.startsWith('att') ? id.slice(3) : `att${id}`;
}

function sameAttachmentDigits(metaId, expectedDigits) {
  const text = typeof metaId === 'string' || typeof metaId === 'number' ? String(metaId) : '';
  const match = ATTACHMENT_ID.exec(text);
  return match !== null && match[1] === expectedDigits;
}

function singleQueryParam(params, key) {
  const values = params.getAll(key);
  if (values.length > 1) fail(400, 'invalid_request');
  return values.length ? values[0] : null;
}

function parseIdModeParams(id, file, attachmentCursor) {
  if (!PAGE_ID.test(id)) fail(400, 'invalid_request');
  if (file !== null && attachmentCursor !== null) fail(400, 'invalid_request');
  if (file !== null) return { mode: 'file', pageId: id, fileId: parseAttachmentId(file) };
  return { mode: 'detail', pageId: id, attachmentCursor: attachmentCursor || null };
}

function parseQueryParams(url) {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) fail(400, 'invalid_request');
  }
  const cursor = singleQueryParam(params, 'cursor');
  const id = singleQueryParam(params, 'id');
  const attachmentCursor = singleQueryParam(params, 'attachmentCursor');
  const file = singleQueryParam(params, 'file');
  if (id !== null) {
    if (cursor !== null) fail(400, 'invalid_request');
    return parseIdModeParams(id, file, attachmentCursor);
  }
  if (file !== null || attachmentCursor !== null) fail(400, 'invalid_request');
  return { mode: 'list', cursor: cursor || null };
}

async function openHistoryCursor(cursor, key, purpose, expected) {
  if (cursor === null) return null;
  if (!CLIENT_CURSOR.test(cursor)) fail(400, 'invalid_cursor');
  const opened = await openSealed(key, purpose, cursor);
  const match = opened &&
    opened.cloudId === expected.cloudId &&
    opened.spaceId === SPACE_ID &&
    (expected.pageId === undefined || opened.pageId === expected.pageId) &&
    typeof opened.cursor === 'string' &&
    UPSTREAM_CURSOR.test(opened.cursor);
  if (!match) fail(400, 'invalid_cursor');
  return opened.cursor;
}

async function sealHistoryCursor(key, purpose, payload) {
  const sealed = await confluenceInternal.seal(key, purpose, { purpose, spaceId: SPACE_ID, ...payload });
  if (!CLIENT_CURSOR.test(sealed)) fail(502, 'upstream_invalid');
  return sealed;
}

function cursorFromNext(next, cloudId, v2Path) {
  if (!next) return null;
  if (typeof next !== 'string' || next.startsWith('//')) fail(502, 'upstream_invalid');
  let parsed;
  try { parsed = new URL(next, 'https://api.atlassian.com'); } catch { fail(502, 'upstream_invalid'); }
  const cloudPath = `/ex/confluence/${cloudId}${v2Path}`;
  const pathOk = parsed.pathname === cloudPath || parsed.pathname === v2Path;
  if (parsed.origin !== 'https://api.atlassian.com' || parsed.username || parsed.password || !pathOk) {
    fail(502, 'upstream_invalid');
  }
  const cursor = parsed.searchParams.get('cursor');
  if (!cursor) return null;
  if (!UPSTREAM_CURSOR.test(cursor)) fail(502, 'upstream_invalid');
  return cursor;
}

function resolveFetch(ctx) {
  if (ctx.fetchImpl?.budget) return ctx.fetchImpl;
  const raw = ctx.fetchImpl || globalThis.fetch.bind(globalThis);
  return budgetedFetch(raw, ctx.requestBudgetMs ?? 25000);
}

async function confineSpace(fetchImpl, session) {
  const resource = await confluenceInternal.accessibleResource(fetchImpl, session.accessToken);
  if (resource.id !== session.cloudId) fail(403, 'site_not_allowed');
  const base = confluenceInternal.cloudBase(session.cloudId);
  const spaceRes = await confluenceInternal.callUpstream(
    fetchImpl,
    `${base}/wiki/api/v2/spaces/${SPACE_ID}`,
    { headers: confluenceInternal.authHeaders(session.accessToken) },
  );
  if (spaceRes.status === 401) fail(403, 'permission_denied');
  if (spaceRes.status === 403 || spaceRes.status === 404) {
    fail(403, 'space_not_allowed');
  }
  const space = await confluenceInternal.readUpstreamJson(spaceRes);
  if (!space || String(space.id) !== SPACE_ID || space.key !== SPACE_KEY) {
    fail(403, 'space_not_allowed');
  }
  return base;
}

function pageWebUrl(page, pageId) {
  return confluenceInternal.webUrl(page) || `${SITE_URL}/wiki/spaces/${SPACE_KEY}/pages/${pageId}`;
}

function pageUpdatedAt(page) {
  const candidate = page?.version?.createdAt || page?.createdAt || '';
  return typeof candidate === 'string' && !UNSAFE_SINGLELINE.test(candidate) ? candidate : '';
}

function pagePropertyByKey(page, key) {
  const list = page?.properties?.results;
  if (!Array.isArray(list)) return null;
  const entry = list.find(item => item && item.key === key);
  return entry && entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value)
    ? entry.value
    : null;
}

function decodeNumericEntity(raw, hex) {
  const code = Number.parseInt(raw, hex ? 16 : 10);
  if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

export function decodeHtmlEntities(text) {
  if (typeof text !== 'string' || !text.includes('&')) return String(text || '');
  return text.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z]{2,8}));/g, (full, hex, dec, named) => {
    if (hex) return decodeNumericEntity(hex, true);
    if (dec) return decodeNumericEntity(dec, false);
    return NAMED_ENTITIES[named.toLowerCase()] ?? full;
  });
}

function formatW8BlueTitle(participant, condition, issueKey) {
  const p = validTitle(participant);
  if (!p) return null;
  const parts = [validTitle(condition), validTitle(issueKey)].filter(Boolean);
  return parts.length ? `W8 BLUE · ${p} (${parts.join(' · ')})` : `W8 BLUE · ${p}`;
}

function extractStorageSummaryMeta(storageHtml) {
  if (typeof storageHtml !== 'string' || !storageHtml) return null;
  const plain = decodeHtmlEntities(storageHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const arch = ARCHIVE_SUMMARY_RE.exec(plain);
  if (arch) {
    return { kind: arch[1].toLowerCase(), title: validTitle(arch[2]) || validTitle(`${arch[1]} · ${arch[3]}`) };
  }
  const w8 = W8_BLUE_SUMMARY_RE.exec(plain);
  if (w8) return { kind: 'w8-blue', title: formatW8BlueTitle(w8[1], w8[2], w8[3]) };
  return null;
}

function archivePropertyMeta(page) {
  const archProp = pagePropertyByKey(page, 'falsify-archive');
  if (archProp) {
    const kind = validTitle(archProp.kind) || 'archive';
    const title = validTitle(archProp.title) || (validTitle(archProp.id) ? `${kind} · ${archProp.id}` : null);
    return { kind, title, hasExplicitTitle: !!validTitle(archProp.title) };
  }
  const w8Prop = pagePropertyByKey(page, 'falsify-w8-archive');
  if (w8Prop) {
    const title = formatW8BlueTitle(w8Prop.participant, w8Prop.condition, w8Prop.issueKey);
    return { kind: 'w8-blue', title, hasExplicitTitle: !!title };
  }
  const paperProp = pagePropertyByKey(page, 'falsify-w8-paper-sync');
  if (paperProp) {
    const title = validTitle(paperProp.title);
    return { kind: 'w8-paper-sync', title, hasExplicitTitle: !!title };
  }
  return null;
}

function resolvePageKind(page, cfg, propMeta, summaryMeta, hashMatch) {
  if (propMeta?.kind) return propMeta.kind;
  if (summaryMeta?.kind) return summaryMeta.kind;
  if (hashMatch) return hashMatch[1].toLowerCase();
  return String(page?.parentId || '') === cfg.archiveParentId ? 'archive' : 'page';
}

function resolvePageTitle(rawTitle, propMeta, summaryMeta) {
  if (propMeta?.hasExplicitTitle && propMeta.title) return propMeta.title;
  if (summaryMeta?.title) return summaryMeta.title;
  return propMeta?.title || rawTitle;
}

function resolvePageKindAndTitle(page, cfg) {
  const rawTitle = validTitle(page?.title) || `Page ${page?.id || ''}`.trim();
  const hashMatch = HASH_ARCHIVE_TITLE_RE.exec(rawTitle);
  const propMeta = archivePropertyMeta(page);
  const summaryMeta = extractStorageSummaryMeta(page?.body?.storage?.value);
  return {
    kind: resolvePageKind(page, cfg, propMeta, summaryMeta, hashMatch),
    title: resolvePageTitle(rawTitle, propMeta, summaryMeta),
  };
}

function normalizeLinkUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = decodeHtmlEntities(raw).trim();
  if (!trimmed || UNSAFE_SINGLELINE.test(trimmed) || trimmed.startsWith('//')) return null;
  let parsed;
  try {
    parsed = trimmed.startsWith('/') ? new URL(trimmed, SITE_URL) : new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hostname === 'api.media.atlassian.com') return null;
  return parsed.toString();
}

function pushUniqueLink(links, seen, title, rawUrl) {
  if (links.length >= MAX_LINKS) return;
  const url = normalizeLinkUrl(rawUrl);
  if (!url || seen.has(url)) return;
  seen.add(url);
  const cleanTitle = validTitle(decodeHtmlEntities(String(title || '')).replace(/\s+/g, ' ')) || url;
  links.push({ title: cleanTitle, url });
}

function extractBareUrls(text, links, seen) {
  if (typeof text !== 'string' || !text || links.length >= MAX_LINKS) return;
  for (const match of text.matchAll(BARE_URL_RE)) {
    const cleaned = match[0].replace(/[.,;:!?]+$/, '');
    pushUniqueLink(links, seen, cleaned, cleaned);
    if (links.length >= MAX_LINKS) break;
  }
}

function stripTagsToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|section|article)>/gi, '\n')
      .replace(/<\/(?:td|th)>/gi, ' | ')
      .replace(/<hr\s*\/?>/gi, '\n---\n')
      .replace(/<[^>]+>/g, ''),
  );
}

function normalizePlainText(text, maxChars) {
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return trimSurrogateSafe(cleaned, maxChars).text;
}

function trimSurrogateSafe(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  let cut = maxChars;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return { text: text.slice(0, cut), truncated: true };
}

function extractAnchorLinks(html, links, seen) {
  const anchorRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const href = match[1] ?? match[2] ?? '';
    const innerText = stripTagsToText(match[3] || '').replace(/\s+/g, ' ').trim();
    pushUniqueLink(links, seen, innerText, href);
  }
}

function extractRiUrlLinks(html, links, seen) {
  const riUrlRe = /<ri:url\b[^>]*\bri:value\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*\/?>/gi;
  for (const match of html.matchAll(riUrlRe)) {
    const href = match[1] ?? match[2] ?? '';
    pushUniqueLink(links, seen, href, href);
  }
}

export function extractStorageContent(storageHtml) {
  if (typeof storageHtml !== 'string' || !storageHtml.trim()) return { text: '', links: [] };
  const withoutScripts = storageHtml.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const links = [];
  const seen = new Set();
  extractAnchorLinks(withoutScripts, links, seen);
  extractRiUrlLinks(withoutScripts, links, seen);
  const text = normalizePlainText(stripTagsToText(withoutScripts), MAX_DETAIL_TEXT_CHARS);
  extractBareUrls(text, links, seen);
  return { text, links };
}

function adfLinkMarkHref(marks) {
  if (!Array.isArray(marks)) return null;
  const link = marks.find(m => m && m.type === 'link' && typeof m.attrs?.href === 'string');
  return link ? link.attrs.href : null;
}

function pushAdfCard(node, out, links, seen) {
  const url = node.attrs?.url;
  const label = node.attrs?.title || url || '';
  if (url) pushUniqueLink(links, seen, label, url);
  if (label) out.push(String(label));
  return true;
}

function pushAdfTextNode(node, out, links, seen) {
  out.push(node.text);
  const href = adfLinkMarkHref(node.marks);
  if (href) pushUniqueLink(links, seen, node.text, href);
  return true;
}

function pushAdfInline(node, out, links, seen) {
  if (node.type === 'text' && typeof node.text === 'string') return pushAdfTextNode(node, out, links, seen);
  if (node.type === 'hardBreak') { out.push('\n'); return true; }
  if (node.type === 'inlineCard' || node.type === 'blockCard' || node.type === 'embedCard') {
    return pushAdfCard(node, out, links, seen);
  }
  if (node.type === 'mention' && typeof node.attrs?.text === 'string') { out.push(node.attrs.text); return true; }
  if (node.type === 'status' && typeof node.attrs?.text === 'string') { out.push(`[${node.attrs.text}]`); return true; }
  return false;
}

function walkAdfNode(node, out, links, seen, depth) {
  if (!node || typeof node !== 'object' || depth > MAX_ADF_DEPTH) return;
  if (pushAdfInline(node, out, links, seen)) return;
  if (Array.isArray(node.content)) {
    for (const child of node.content) walkAdfNode(child, out, links, seen, depth + 1);
  }
  if (node.type === 'tableCell' || node.type === 'tableHeader') out.push(' | ');
  else if (BLOCK_ADF_TYPES.has(node.type)) out.push('\n');
}

export function extractAdfContent(adfRaw) {
  let doc = adfRaw;
  if (typeof adfRaw === 'string') {
    if (!adfRaw.trim()) return { text: '', links: [] };
    try { doc = JSON.parse(adfRaw); } catch { return { text: '', links: [] }; }
  }
  if (!doc || typeof doc !== 'object') return { text: '', links: [] };
  const out = [];
  const links = [];
  const seen = new Set();
  walkAdfNode(doc, out, links, seen, 0);
  const text = normalizePlainText(out.join(''), MAX_DETAIL_TEXT_CHARS);
  extractBareUrls(text, links, seen);
  return { text, links };
}

function extractPageBodyContent(page, title, kind) {
  const storage = page?.body?.storage?.value;
  if (typeof storage === 'string' && storage.trim()) return extractStorageContent(storage);
  const adf = page?.body?.atlas_doc_format?.value;
  if (adf !== undefined && adf !== null) return extractAdfContent(adf);
  const propMeta = archivePropertyMeta(page);
  if (propMeta) return { text: `${kind}: ${title}`, links: [] };
  return { text: '', links: [] };
}

export function classifyAttachment(att) {
  const mediaType = baseMediaType(att?.mediaType);
  const title = typeof att?.title === 'string' ? att.title.trim() : '';
  if (mediaType === 'application/pdf') return 'pdf';
  if (OCTET_TYPES.has(mediaType) && /\.pdf$/i.test(title)) return 'pdf';
  if (TEXT_MEDIA_TYPES.has(mediaType) || mediaType.endsWith('+json')) return 'text';
  if (OCTET_TYPES.has(mediaType) && TEXT_EXT_RE.test(title)) return 'text';
  return 'file';
}

function safeWikiPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('://')) {
    return null;
  }
  if (UNSAFE_SINGLELINE.test(rawPath)) return null;
  const pathOnly = rawPath.split(/[?#]/)[0];
  const suffix = pathOnly.startsWith('/wiki/') ? pathOnly.slice(5) : pathOnly;
  return suffix.startsWith('/') ? `${SITE_URL}/wiki${suffix}` : null;
}

function safeAttachmentUrl(att, pageId) {
  const candidates = [att?._links?.webui, att?._links?.download, att?.downloadLink];
  for (const candidate of candidates) {
    const resolved = safeWikiPath(candidate);
    if (resolved) return resolved;
  }
  return `${SITE_URL}/wiki/pages/viewpageattachments.action?pageId=${pageId}`;
}

function isAttachmentForPage(att, pageId, strictPageId) {
  if (!att || typeof att !== 'object') return false;
  if (att.status !== undefined && att.status !== 'current') return false;
  if (att.blogPostId || att.customContentId) return false;
  if (att.pageId === undefined || att.pageId === null) return !strictPageId;
  return String(att.pageId) === pageId;
}

function formatAttachmentItem(att, pageId) {
  if (!isAttachmentForPage(att, pageId, false)) return null;
  const id = typeof att.id === 'string' || typeof att.id === 'number' ? String(att.id) : '';
  if (!ATTACHMENT_ID.test(id)) return null;
  const title = validTitle(att.title);
  if (!title) return null;
  return {
    id,
    title,
    type: classifyAttachment(att),
    url: safeAttachmentUrl(att, pageId),
  };
}

function needsArchiveEnrichment(page, cfg) {
  if (!page || typeof page !== 'object') return false;
  if (HASH_ARCHIVE_TITLE_RE.test(String(page.title || ''))) return true;
  const parent = String(page.parentId || '');
  return parent === cfg.archiveParentId || parent === cfg.libraryParentId;
}

async function fetchPageForEnrich(fetchImpl, base, token, pageId) {
  const url = `${base}/wiki/api/v2/pages/${pageId}?body-format=storage&include-labels=true&include-properties=true`;
  const res = await confluenceInternal.callUpstream(fetchImpl, url, {
    headers: confluenceInternal.authHeaders(token),
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) return null;
  return confluenceInternal.readUpstreamJson(res);
}

async function mapConcurrently(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

function isCurrentSpacePage(page) {
  if (!page || typeof page !== 'object') return false;
  if (page.spaceId !== undefined && String(page.spaceId) !== SPACE_ID) return false;
  return page.status === undefined || page.status === 'current';
}

async function resolveListedPage(fetchImpl, base, token, rawPage, pageId, cfg) {
  if (!needsArchiveEnrichment(rawPage, cfg)) return rawPage;
  const detailed = await fetchPageForEnrich(fetchImpl, base, token, pageId);
  if (!detailed || String(detailed.spaceId) !== SPACE_ID) return null;
  return detailed.status && detailed.status !== 'current' ? null : detailed;
}

async function buildListedItem(fetchImpl, base, session, rawPage, cfg) {
  if (!isCurrentSpacePage(rawPage)) return null;
  const pageId = String(rawPage.id || '');
  if (!PAGE_ID.test(pageId)) return null;
  const page = await resolveListedPage(fetchImpl, base, session.accessToken, rawPage, pageId, cfg);
  if (!page) return null;
  const { kind, title } = resolvePageKindAndTitle(page, cfg);
  return { id: pageId, title, url: pageWebUrl(page, pageId), updatedAt: pageUpdatedAt(page), kind };
}

async function handleListMode(fetchImpl, session, cfg, key, cursor) {
  const upstreamCursor = await openHistoryCursor(cursor, key, LIST_CURSOR_PURPOSE, { cloudId: session.cloudId });
  const base = await confineSpace(fetchImpl, session);
  const query = `space-id=${SPACE_ID}&status=current&sort=-modified-date&limit=${PAGE_LIMIT}` +
    (upstreamCursor ? `&cursor=${encodeURIComponent(upstreamCursor)}` : '');
  const res = await confluenceInternal.callUpstream(
    fetchImpl,
    `${base}/wiki/api/v2/pages?${query}`,
    { headers: confluenceInternal.authHeaders(session.accessToken) },
  );
  if (res.status === 401 || res.status === 403) fail(403, 'permission_denied');
  if (res.status === 404) fail(403, 'space_not_allowed');
  const payload = await confluenceInternal.readUpstreamJson(res);
  const results = Array.isArray(payload?.results) ? payload.results : null;
  if (!results || results.length > PAGE_LIMIT) fail(502, 'upstream_invalid');

  const mapped = await mapConcurrently(results, ENRICH_CONCURRENCY, p => buildListedItem(fetchImpl, base, session, p, cfg));
  const nextRaw = cursorFromNext(payload?._links?.next, session.cloudId, '/wiki/api/v2/pages');
  const nextCursor = nextRaw
    ? await sealHistoryCursor(key, LIST_CURSOR_PURPOSE, { cloudId: session.cloudId, cursor: nextRaw })
    : null;
  return json(200, { items: mapped.filter(Boolean), nextCursor });
}

async function fetchReadablePage(fetchImpl, base, token, pageId, query = '') {
  const suffix = query ? `?${query}` : '';
  const res = await confluenceInternal.callUpstream(
    fetchImpl,
    `${base}/wiki/api/v2/pages/${pageId}${suffix}`,
    { headers: confluenceInternal.authHeaders(token) },
  );
  if (res.status === 401 || res.status === 403) fail(403, 'permission_denied');
  if (res.status === 404) fail(404, 'not_found');
  const page = await confluenceInternal.readUpstreamJson(res);
  if (!page || typeof page !== 'object' || String(page.id) !== pageId) fail(502, 'upstream_invalid');
  if (String(page.spaceId) !== SPACE_ID) fail(404, 'not_found');
  if (page.status !== undefined && page.status !== 'current') fail(404, 'not_found');
  return page;
}

async function fetchPageWithBody(fetchImpl, base, token, pageId) {
  const page = await fetchReadablePage(
    fetchImpl,
    base,
    token,
    pageId,
    'body-format=storage&include-labels=true&include-properties=true',
  );
  const hasStorage = typeof page?.body?.storage?.value === 'string' && page.body.storage.value.trim().length > 0;
  const hasAdf = page?.body?.atlas_doc_format?.value !== undefined && page?.body?.atlas_doc_format?.value !== null;
  if (hasStorage || hasAdf) return page;
  const adfRes = await confluenceInternal.callUpstream(
    fetchImpl,
    `${base}/wiki/api/v2/pages/${pageId}?body-format=atlas_doc_format`,
    { headers: confluenceInternal.authHeaders(token) },
  );
  if (adfRes.status === 200) {
    const adfPage = await confluenceInternal.readUpstreamJson(adfRes);
    if (adfPage?.body?.atlas_doc_format) {
      return { ...page, body: { ...(page.body || {}), atlas_doc_format: adfPage.body.atlas_doc_format } };
    }
  }
  return page;
}

async function listPageAttachments(fetchImpl, base, session, key, pageId, upstreamCursor) {
  const query = `limit=${PAGE_LIMIT}&status=current` +
    (upstreamCursor ? `&cursor=${encodeURIComponent(upstreamCursor)}` : '');
  const res = await confluenceInternal.callUpstream(
    fetchImpl,
    `${base}/wiki/api/v2/pages/${pageId}/attachments?${query}`,
    { headers: confluenceInternal.authHeaders(session.accessToken) },
  );
  if (res.status === 401 || res.status === 403) fail(403, 'permission_denied');
  if (res.status === 404) fail(404, 'not_found');
  const payload = await confluenceInternal.readUpstreamJson(res);
  const results = Array.isArray(payload?.results) ? payload.results : null;
  if (!results || results.length > PAGE_LIMIT) fail(502, 'upstream_invalid');
  const attachments = results.map(item => formatAttachmentItem(item, pageId)).filter(Boolean);
  const nextRaw = cursorFromNext(payload?._links?.next, session.cloudId, `/wiki/api/v2/pages/${pageId}/attachments`);
  const nextAttachmentCursor = nextRaw
    ? await sealHistoryCursor(key, ATT_CURSOR_PURPOSE, { cloudId: session.cloudId, pageId, cursor: nextRaw })
    : null;
  return { attachments, nextAttachmentCursor };
}

const HEX64 = /^[a-f0-9]{64}$/;

function normalizeArchiveRuns(archive) {
  const topCondition = typeof archive?.condition === 'string' ? archive.condition : '';
  const rawRuns = Array.isArray(archive?.runs) ? archive.runs : [];
  return rawRuns.map(run => {
    const fileHash = typeof run?.fileHash === 'string' && HEX64.test(run.fileHash) ? run.fileHash : null;
    const sourceHash = typeof run?.sourceHash === 'string' && HEX64.test(run.sourceHash) ? run.sourceHash : null;
    const revisionSha256 = fileHash && fileHash !== sourceHash ? fileHash : null;
    return {
      id: run?.id || '',
      revisionSha256,
      detector: run?.detector || '',
      model: run?.model || '',
      condition: topCondition || run?.promptCondition || '',
      findings: Array.isArray(run?.findings) ? run.findings : [],
    };
  });
}

async function lookupAttachmentByFilename(fetchImpl, base, token, pageId, filename) {
  const url = `${base}/wiki/api/v2/pages/${pageId}/attachments?filename=${encodeURIComponent(filename)}&limit=5`;
  const res = await confluenceInternal.callUpstream(fetchImpl, url, {
    headers: confluenceInternal.authHeaders(token),
  });
  if (res.status !== 200) return null;
  const payload = await confluenceInternal.readUpstreamJson(res);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const hit = results.find(item => item && item.title === filename && ATTACHMENT_ID.test(String(item.id)));
  return hit ? String(hit.id) : null;
}

async function loadVerifiedJsonAttachment(fetchImpl, base, session, pageId, attachments, expectedSha) {
  const filename = `${expectedSha}.json`;
  let attId = attachments.find(a => a.title === filename)?.id || null;
  if (!attId) attId = await lookupAttachmentByFilename(fetchImpl, base, session.accessToken, pageId, filename);
  if (!attId) return null;
  const bytes = await downloadAttachmentBytes(fetchImpl, base, session, pageId, attId, MAX_ARCHIVE_BYTES);
  if ((await sha256HexBytes(bytes)) !== expectedSha) return null;
  return JSON.parse(strictDecoder.decode(bytes));
}

async function loadStructuredRunsForPage(fetchImpl, base, session, page, pageId, attachments) {
  const paperProp = pagePropertyByKey(page, 'falsify-w8-paper-sync');
  if (paperProp && paperProp.ready === true && HEX64.test(String(paperProp.sourceSha256 || ''))) {
    const parsedBody = parseAppOwnedPaperBody(page?.body?.storage?.value, paperProp.sourceSha256);
    const stateSha = parsedBody && parsedBody.stateToken !== 'pending'
      ? parsedBody.stateToken
      : (HEX64.test(String(paperProp.stateSha256 || '')) ? paperProp.stateSha256 : null);
    if (!stateSha) return { isStructured: true, runs: [] };
    const state = await loadVerifiedJsonAttachment(fetchImpl, base, session, pageId, attachments, stateSha);
    if (state && state.schema === W8_PAPER_SYNC_SCHEMA && state.sourceSha256 === paperProp.sourceSha256 && Array.isArray(state.runs)) {
      return { isStructured: true, runs: state.runs };
    }
    return { isStructured: true, runs: [] };
  }

  const w8Prop = pagePropertyByKey(page, 'falsify-w8-archive');
  if (w8Prop && w8Prop.ready === true && HEX64.test(String(w8Prop.archiveSha256 || ''))) {
    const archive = await loadVerifiedJsonAttachment(fetchImpl, base, session, pageId, attachments, w8Prop.archiveSha256);
    if (archive && archive.schema === W8_ARCHIVE_SCHEMA && Array.isArray(archive.runs)) {
      return { isStructured: true, runs: normalizeArchiveRuns(archive) };
    }
    return { isStructured: true, runs: [] };
  }

  return { isStructured: false, runs: [] };
}

async function loadRoundGradesAttachment(fetchImpl, base, session, pageId, attachments) {
  const filename = 'w8-round-grades.json';
  try {
    const attId = attachments.find(attachment => attachment.title === filename)?.id
      || await lookupAttachmentByFilename(fetchImpl, base, session.accessToken, pageId, filename);
    if (!attId) return null;
    const bytes = await downloadAttachmentBytes(fetchImpl, base, session, pageId, attId, MAX_ARCHIVE_BYTES);
    return validateRoundGradesPayload(JSON.parse(strictDecoder.decode(bytes)));
  } catch {
    return null;
  }
}

async function resolvePageAnalysis(fetchImpl, base, session, page, pageId, attachments) {
  try {
    const { isStructured, runs } = await loadStructuredRunsForPage(fetchImpl, base, session, page, pageId, attachments);
    if (!isStructured) return null;
    const roundGrades = runs.length ? await loadRoundGradesAttachment(fetchImpl, base, session, pageId, attachments) : null;
    return analyzeTeamRecord({ runs, roundGrades });
  } catch {
    return null;
  }
}

async function handleDetailMode(fetchImpl, session, cfg, key, pageId, attachmentCursor) {
  const upstreamAttCursor = await openHistoryCursor(attachmentCursor, key, ATT_CURSOR_PURPOSE, {
    cloudId: session.cloudId,
    pageId,
  });
  const base = await confineSpace(fetchImpl, session);
  const page = await fetchPageWithBody(fetchImpl, base, session.accessToken, pageId);
  const { attachments, nextAttachmentCursor } = await listPageAttachments(
    fetchImpl,
    base,
    session,
    key,
    pageId,
    upstreamAttCursor,
  );
  const { kind, title } = resolvePageKindAndTitle(page, cfg);
  const { text, links } = extractPageBodyContent(page, title, kind);
  const analysis = attachmentCursor === null
    ? await resolvePageAnalysis(fetchImpl, base, session, page, pageId, attachments)
    : null;
  return json(200, {
    id: pageId,
    title,
    url: pageWebUrl(page, pageId),
    updatedAt: pageUpdatedAt(page),
    kind,
    text,
    links,
    attachments,
    nextAttachmentCursor,
    ...(analysis ? { analysis } : {}),
  });
}

async function fetchAttachmentMetaOnce(fetchImpl, base, token, id) {
  const res = await confluenceInternal.callUpstream(
    fetchImpl,
    `${base}/wiki/api/v2/attachments/${encodeURIComponent(id)}`,
    { headers: confluenceInternal.authHeaders(token) },
  );
  if (res.status === 401 || res.status === 403) fail(403, 'permission_denied');
  if (res.status === 400 || res.status === 404) return { status: res.status, meta: null };
  return { status: res.status, meta: await confluenceInternal.readUpstreamJson(res) };
}

async function fetchAttachmentMeta(fetchImpl, base, token, parsedId) {
  const primary = await fetchAttachmentMetaOnce(fetchImpl, base, token, parsedId.v2Id);
  if (primary.meta) return primary.meta;
  if (primary.status === 400 || (!parsedId.hasPrefix && primary.status === 404)) {
    const secondary = await fetchAttachmentMetaOnce(fetchImpl, base, token, parsedId.digits);
    if (secondary.meta) return secondary.meta;
  }
  fail(404, 'not_found');
}

function assertAttachmentSize(meta, maxBytes) {
  if (meta.fileSize === undefined || meta.fileSize === null) return;
  const size = Number(meta.fileSize);
  if (!Number.isSafeInteger(size) || size < 0) fail(502, 'upstream_invalid');
  if (size > maxBytes) fail(413, 'payload_too_large');
}

function assertPageAttachmentMeta(meta, parsedId, pageId) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail(502, 'upstream_invalid');
  if (!sameAttachmentDigits(meta.id, parsedId.digits)) fail(502, 'upstream_invalid');
  if (!isAttachmentForPage(meta, pageId, true)) fail(404, 'not_found');
  return String(meta.id);
}

function downloadAttachmentOnce(fetchImpl, base, session, pageId, attId) {
  const startUrl = `${base}/wiki/rest/api/content/${pageId}/child/attachment/${attId}/download`;
  return confluenceInternal.downloadAttachment(
    fetchImpl,
    startUrl,
    session.accessToken,
    session.cloudId,
    pageId,
    attId,
    false,
  );
}

async function downloadAttachmentBytes(fetchImpl, base, session, pageId, metaId, maxBytes) {
  let dl = await downloadAttachmentOnce(fetchImpl, base, session, pageId, metaId);
  if (dl.status === 400 || dl.status === 404) {
    dl = await downloadAttachmentOnce(fetchImpl, base, session, pageId, alternateAttachmentId(metaId));
  }
  if (dl.status === 401 || dl.status === 403) fail(403, 'permission_denied');
  if (dl.status === 404) fail(404, 'not_found');
  if (dl.status < 200 || dl.status >= 300) fail(502, 'upstream_unavailable');
  const bytes = await confluenceInternal.readBounded(dl, maxBytes);
  if (!bytes) fail(413, 'payload_too_large');
  return bytes;
}

function pdfBinaryResponse(bytes) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': 'inline; filename="document.pdf"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function textPreviewResponse(bytes, maxChars) {
  if (bytes.includes(0)) fail(502, 'upstream_invalid');
  const decoded = lenientDecoder.decode(bytes).replace(/^\uFEFF/, '');
  const { text, truncated } = trimSurrogateSafe(decoded, maxChars);
  return json(200, { text, truncated });
}

async function handleFileMode(fetchImpl, env, session, pageId, fileId) {
  const base = await confineSpace(fetchImpl, session);
  await fetchReadablePage(fetchImpl, base, session.accessToken, pageId);
  const meta = await fetchAttachmentMeta(fetchImpl, base, session.accessToken, fileId);
  const verifiedId = assertPageAttachmentMeta(meta, fileId, pageId);
  const type = classifyAttachment(meta);
  if (type === 'file') {
    return json(200, {
      id: verifiedId,
      title: validTitle(meta.title) || verifiedId,
      type: 'file',
      url: safeAttachmentUrl(meta, pageId),
    });
  }
  if (type === 'pdf') {
    const maxPdf = resolveMaxPdfBytes(env);
    assertAttachmentSize(meta, maxPdf);
    const bytes = await downloadAttachmentBytes(fetchImpl, base, session, pageId, verifiedId, maxPdf);
    if (!hasPdfMagic(bytes)) fail(502, 'upstream_invalid');
    return pdfBinaryResponse(bytes);
  }
  assertAttachmentSize(meta, MAX_ARCHIVE_BYTES);
  const bytes = await downloadAttachmentBytes(fetchImpl, base, session, pageId, verifiedId, MAX_ARCHIVE_BYTES);
  return textPreviewResponse(bytes, resolveMaxTextChars(env));
}

export async function handleConfluenceHistory(ctx, session) {
  if (ctx?.request?.method && ctx.request.method !== 'GET') {
    fail(405, 'method_not_allowed', { Allow: 'GET' });
  }
  if (!session || typeof session.accessToken !== 'string' || typeof session.cloudId !== 'string') {
    fail(401, 'unauthorized');
  }
  const cfg = historyConfig(ctx.env);
  const key = await confluenceInternal.aesKey(ctx.env);
  if (!cfg.configured || !key) fail(503, 'not_configured');
  const url = ctx.url instanceof URL ? ctx.url : new URL(ctx.request.url);
  const query = parseQueryParams(url);
  const fetchImpl = resolveFetch(ctx);
  if (query.mode === 'list') return handleListMode(fetchImpl, session, cfg, key, query.cursor);
  if (query.mode === 'detail') {
    return handleDetailMode(fetchImpl, session, cfg, key, query.pageId, query.attachmentCursor);
  }
  return handleFileMode(fetchImpl, ctx.env, session, query.pageId, query.fileId);
}
