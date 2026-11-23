// Authenticated W8 team library PDF attachments (GET /v1/w8/paper-attachments).
// Lists and streams only PDFs attached directly to the configured Confluence library root
// page (same configuration as w8-paper-sync.mjs). Reuses caller's sealed Confluence OAuth
// session, existing API scopes, and confluenceInternal.downloadAttachment redirect controls.
import {
  SITE_URL,
  SPACE_KEY,
  MAX_ARCHIVE_BYTES,
  GatewayError,
  confluenceInternal,
} from './confluence.mjs';
import { paperSyncConfig } from './w8-paper-sync.mjs';

const CURSOR_PURPOSE = 'falsify.w8-library-attachments.cursor.v1';
const ATTACHMENT_ID = /^(?:att)?([0-9]{1,20})$/;
const UPSTREAM_CURSOR = /^[A-Za-z0-9_=-]{1,512}$/;
const CLIENT_CURSOR = /^[A-Za-z0-9_-]{1,2048}$/;
const UNSAFE_SINGLELINE = /[\u0000-\u001f\u007f]/;
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const MAX_SEALED = 8192;
const MAX_TITLE_CHARS = 500;
const PAGE_LIMIT = 25;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

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
    const parsed = JSON.parse(decoder.decode(new Uint8Array(plain)));
    return parsed && typeof parsed === 'object' && parsed.purpose === purpose ? parsed : null;
  } catch {
    return null;
  }
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

function validTitle(title) {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > MAX_TITLE_CHARS || UNSAFE_SINGLELINE.test(trimmed)) return null;
  return trimmed;
}

export function parseAttachmentId(raw) {
  if (typeof raw !== 'string') fail(400, 'invalid_request');
  const match = ATTACHMENT_ID.exec(raw);
  if (!match) fail(400, 'invalid_request');
  return {
    raw,
    digits: match[1],
    v2Id: `att${match[1]}`,
    hasPrefix: raw.startsWith('att'),
  };
}

function alternateAttachmentId(id) {
  return id.startsWith('att') ? id.slice(3) : `att${id}`;
}

function sameAttachmentDigits(metaId, expectedDigits) {
  const text = typeof metaId === 'string' || typeof metaId === 'number' ? String(metaId) : '';
  const match = ATTACHMENT_ID.exec(text);
  return match !== null && match[1] === expectedDigits;
}

function resolveMaxPdfBytes(env) {
  let limit = MAX_ARCHIVE_BYTES;
  for (const raw of [env?.W8_PDF_LINK_MAX_BYTES, env?.AI_MAX_UPLOAD_BYTES]) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0 && n < limit) limit = n;
  }
  return limit;
}

function parseQueryParams(url) {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (key !== 'cursor' && key !== 'attachmentId') fail(400, 'invalid_request');
  }
  const cursors = params.getAll('cursor');
  const ids = params.getAll('attachmentId');
  if (cursors.length > 1 || ids.length > 1 || (cursors.length && ids.length)) {
    fail(400, 'invalid_request');
  }
  if (ids.length === 1) return { mode: 'download', attachmentId: ids[0] };
  return { mode: 'list', cursor: cursors.length === 1 ? cursors[0] : null };
}

async function openListCursor(cursor, key, cloudId, parentPageId) {
  if (cursor === null) return null;
  if (!CLIENT_CURSOR.test(cursor)) fail(400, 'invalid_cursor');
  const opened = await openSealed(key, CURSOR_PURPOSE, cursor);
  const valid = opened &&
    opened.cloudId === cloudId &&
    opened.parent === parentPageId &&
    typeof opened.cursor === 'string' &&
    UPSTREAM_CURSOR.test(opened.cursor);
  if (!valid) fail(400, 'invalid_cursor');
  return opened.cursor;
}

function cursorFromNext(next, cloudId, parentPageId) {
  if (!next) return null;
  if (typeof next !== 'string' || next.startsWith('//')) fail(502, 'upstream_invalid');
  let parsed;
  try { parsed = new URL(next, 'https://api.atlassian.com'); } catch { fail(502, 'upstream_invalid'); }
  const v2Path = `/wiki/api/v2/pages/${parentPageId}/attachments`;
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

function rootPageUrl(page, parentPageId) {
  return confluenceInternal.webUrl(page) || `${SITE_URL}/wiki/spaces/${SPACE_KEY}/pages/${parentPageId}`;
}

function isDirectRootContainer(item, parentPageId, strictPageId) {
  if (item.blogPostId || item.customContentId) return false;
  if (item.pageId === undefined || item.pageId === null) return !strictPageId;
  return String(item.pageId) === parentPageId;
}

function listAttachmentEntry(item, parentPageId, pageUrl) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id) : '';
  if (!ATTACHMENT_ID.test(id)) return null;
  if (item.status !== undefined && item.status !== 'current') return null;
  if (!isDirectRootContainer(item, parentPageId, false)) return null;
  if (baseMediaType(item.mediaType) !== 'application/pdf') return null;
  const title = validTitle(item.title);
  return title ? { attachmentId: id, pageId: parentPageId, title, pageUrl } : null;
}

async function listLibraryAttachments(ctx, session, cfg, key, cursor) {
  const upstreamCursor = await openListCursor(cursor, key, session.cloudId, cfg.parentPageId);
  const rootPage = await confluenceInternal.confine(ctx.fetchImpl, session.accessToken, session.cloudId, cfg.parentPageId);
  const base = confluenceInternal.cloudBase(session.cloudId);
  const query = `limit=${PAGE_LIMIT}&status=current&mediaType=${encodeURIComponent('application/pdf')}` +
    (upstreamCursor ? `&cursor=${encodeURIComponent(upstreamCursor)}` : '');
  const response = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/api/v2/pages/${cfg.parentPageId}/attachments?${query}`,
    { headers: confluenceInternal.authHeaders(session.accessToken) },
  );
  if (response.status === 404) fail(403, 'parent_not_allowed');
  const payload = await confluenceInternal.readUpstreamJson(response);
  const results = Array.isArray(payload?.results) ? payload.results : null;
  if (!results || results.length > PAGE_LIMIT) fail(502, 'upstream_invalid');
  const pageUrl = rootPageUrl(rootPage, cfg.parentPageId);
  const items = results.map(item => listAttachmentEntry(item, cfg.parentPageId, pageUrl)).filter(Boolean);
  const nextRaw = cursorFromNext(payload?._links?.next, session.cloudId, cfg.parentPageId);
  const nextCursor = nextRaw
    ? await confluenceInternal.seal(key, CURSOR_PURPOSE, {
      purpose: CURSOR_PURPOSE,
      cloudId: session.cloudId,
      parent: cfg.parentPageId,
      cursor: nextRaw,
    })
    : null;
  if (nextCursor && !CLIENT_CURSOR.test(nextCursor)) fail(502, 'upstream_invalid');
  return json(200, { items, nextCursor });
}

async function fetchAttachmentMetadataOnce(ctx, base, token, id) {
  const response = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/api/v2/attachments/${encodeURIComponent(id)}`,
    { headers: confluenceInternal.authHeaders(token) },
  );
  if (response.status === 401 || response.status === 403) fail(403, 'permission_denied');
  if (response.status === 400 || response.status === 404) return { status: response.status, meta: null };
  const meta = await confluenceInternal.readUpstreamJson(response);
  return { status: response.status, meta };
}

async function fetchAttachmentMetadata(ctx, base, session, parsedId) {
  const primary = await fetchAttachmentMetadataOnce(ctx, base, session.accessToken, parsedId.v2Id);
  if (primary.meta) return primary.meta;
  const allowFallback = primary.status === 400 || (!parsedId.hasPrefix && primary.status === 404);
  if (allowFallback) {
    const secondary = await fetchAttachmentMetadataOnce(ctx, base, session.accessToken, parsedId.digits);
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

function assertRootPdfMetadata(meta, parsedId, parentPageId, maxBytes) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail(502, 'upstream_invalid');
  if (!sameAttachmentDigits(meta.id, parsedId.digits)) fail(502, 'upstream_invalid');
  if (meta.status !== undefined && meta.status !== 'current') fail(404, 'not_found');
  if (!isDirectRootContainer(meta, parentPageId, true)) fail(404, 'not_found');
  if (baseMediaType(meta.mediaType) !== 'application/pdf') fail(404, 'not_found');
  assertAttachmentSize(meta, maxBytes);
  return String(meta.id);
}

function downloadAttachmentOnce(ctx, base, session, pageId, attId) {
  const startUrl = `${base}/wiki/rest/api/content/${pageId}/child/attachment/${attId}/download`;
  return confluenceInternal.downloadAttachment(
    ctx.fetchImpl,
    startUrl,
    session.accessToken,
    session.cloudId,
    pageId,
    attId,
    false,
  );
}

async function downloadPdfBytes(ctx, base, session, pageId, metaId, maxBytes) {
  let dl = await downloadAttachmentOnce(ctx, base, session, pageId, metaId);
  if (dl.status === 400 || dl.status === 404) {
    dl = await downloadAttachmentOnce(ctx, base, session, pageId, alternateAttachmentId(metaId));
  }
  if (dl.status === 401 || dl.status === 403) fail(403, 'permission_denied');
  if (dl.status === 404) fail(404, 'not_found');
  if (dl.status < 200 || dl.status >= 300) fail(502, 'upstream_unavailable');
  const bytes = await confluenceInternal.readBounded(dl, maxBytes);
  if (!bytes) fail(413, 'payload_too_large');
  if (!hasPdfMagic(bytes)) fail(502, 'upstream_invalid');
  return bytes;
}

function pdfBinaryResponse(bytes) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': 'inline; filename="paper.pdf"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

async function downloadLibraryAttachment(ctx, session, cfg, rawAttachmentId) {
  const parsedId = parseAttachmentId(rawAttachmentId);
  const maxBytes = resolveMaxPdfBytes(ctx.env);
  await confluenceInternal.confine(ctx.fetchImpl, session.accessToken, session.cloudId, cfg.parentPageId);
  const base = confluenceInternal.cloudBase(session.cloudId);
  const meta = await fetchAttachmentMetadata(ctx, base, session, parsedId);
  const verifiedId = assertRootPdfMetadata(meta, parsedId, cfg.parentPageId, maxBytes);
  const bytes = await downloadPdfBytes(ctx, base, session, cfg.parentPageId, verifiedId, maxBytes);
  return pdfBinaryResponse(bytes);
}

export async function handleW8LibraryAttachments(ctx, session) {
  if (!session || typeof session.accessToken !== 'string' || typeof session.cloudId !== 'string') {
    fail(401, 'unauthorized');
  }
  const cfg = paperSyncConfig(ctx.env);
  const key = await confluenceInternal.aesKey(ctx.env);
  if (!cfg.configured || !key) fail(503, 'not_configured');
  const query = parseQueryParams(ctx.url);
  if (query.mode === 'download') {
    return downloadLibraryAttachment(ctx, session, cfg, query.attachmentId);
  }
  return listLibraryAttachments(ctx, session, cfg, key, query.cursor);
}
