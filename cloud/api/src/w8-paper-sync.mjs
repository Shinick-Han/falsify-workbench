// Stateless W8 team paper library sync (PUT /v1/w8/paper-sync).
// Maintains one app-owned Confluence child page per paper source SHA-256 under
// env.W8_CONFLUENCE_LIBRARY_PARENT_ID (default 20512769) in the fixed Falsify space.
// Uses caller's own Confluence OAuth bearerSession (no Jira scopes required).
// Durable state is stored in immutable content-addressed JSON attachments committed
// atomically via Confluence page version CAS so retries and concurrent contributors
// never lose or duplicate data.
import {
  SPACE_ID,
  MAX_ARCHIVE_BYTES,
  GatewayError,
  confluenceConfig,
  confluenceInternal,
} from './confluence.mjs';
import { canonicalJson, sha256HexBytes, sha256HexText } from './w8-archive.mjs';

export const W8_DEFAULT_LIBRARY_PARENT_ID = '20512769';
export const W8_PAPER_SYNC_SCHEMA = 'falsify.w8-paper-sync.v1';
export const W8_ROUND_GRADES_SCHEMA = 'falsify.w8-round-grades.v1';
export const W8_PAPER_SYNC_KIND = 'w8-paper-sync';
export const W8_PAPER_SYNC_LABEL = 'falsify-w8-paper-sync';
export const W8_PAPER_SYNC_PROPERTY_KEY = 'falsify-w8-paper-sync';

const PAGE_ID = /^[0-9]{1,20}$/;
const ATTACHMENT_ID = /^(?:att)?[0-9]{1,20}$/;
const PROPERTY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,180}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const HEX64_ANY_CASE = /^[a-fA-F0-9]{64}$/;
const ARXIV_ID = /^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7})(?:v[1-9][0-9]{0,2})?$/;
const W8_PAPERS_CURSOR_PURPOSE = 'falsify.w8.papers-cursor.v1';
const UNSAFE_CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNSAFE_SINGLELINE = /[\u0000-\u001f\u007f]/;
const MAX_CARRIER_DEPTH = 16;
const MAX_TITLE_CHARS = 500;
const MAX_ID_CHARS = 200;
const MAX_LABEL_CHARS = 120;
const MAX_SHORT_FIELD_CHARS = 128;
const MAX_CONFLICT_RETRIES = 4;
const MAX_ATTACHMENT_PAGES = 10;
const MAX_RENDERED_BODY_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = MAX_ARCHIVE_BYTES + 16384;

const OTHER_FALSIFY_LABELS = new Set(['falsify-archive-ready', 'falsify-w8-blue-ready', 'falsify-w8-blue']);
const OTHER_FALSIFY_PROPS = new Set(['falsify-archive', 'falsify-w8-archive']);

const BANNED_KEY_RE = /^(pdf|pdfBytes|sourcePdf|sourcePDF|binary|bytes|contentBase64|segments|rawDocument|documentText|fullText|extractedText|raw|batches|pdfUrl|paperLink|paperLinks|paperLinkUrl|privateLink|privateAiLink|aiLink|aiUrl|driveUrl|driveLink|driveFileId|linkToken|signedUrl|downloadUrl|attachmentUrl|red|redRuns|redLedger|redFindings|gold|answer|answers|answerKey|sourceRunId|snapshotOf|comparison|patches|candidates|edits|before|after|injectedFaults|plantedFaults|accessToken|refreshToken|authorization|bearer|clientSecret|session|token|apiKey|cookie|secret|password)$/i;
const ROLE_KEY_RE = /^(role|kind|mode|track)$/i;
const FORBIDDEN_TEXT_PATTERNS = [
  /%PDF-/,
  /data:application\/pdf/i,
  /JVBERi0/,
  /\/v1\/w8\/paper-links\//i,
  /\/links\/[0-9a-f]{32}\.pdf/i,
  /drive\.google\.com/i,
  /docs\.google\.com/i,
  /googleapis\.com\/drive/i,
  /falsify-runtime\./i,
  /\/v1\/ai\/(?:files|jobs|paper|runs|sessions)/i,
  /api\.media\.atlassian\.com/i,
  /(?:^|[\s"'(<])(?:blob:|file:\/\/)/i,
  /https?:\/\/[^\s"'<>]*[?&](?:token|access_token|signature|sig|auth)=/i,
];

const TOP_KEYS = ['sourceSha256', 'title', 'arxivId', 'revisionSha256', 'sourceDriveId', 'revisionDriveId', 'runs'];
const RUN_KEYS = ['id', 'model', 'detector', 'condition', 'findings', 'revisionSha256', 'createdAt'];
const FINDING_KEYS = ['quote', 'rationale', 'severity', 'verdict', 'verdictLabel', 'id', 'page', 'locationLabel', 'findingType', 'confidence'];
const UNCLASSIFIED_LABEL = '미분류';
const VALID_GRADE_STATUSES = new Set(['detected', 'partial', 'missed']);

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

function isPlain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function hasValidSecret(env) {
  const secret = String(env.ATLASSIAN_CLIENT_SECRET || '');
  return secret.length >= 8 && secret.length <= 256 && !/[\u0000-\u001f]/.test(secret);
}

export function resolveLibraryParentId(env) {
  const raw = env?.W8_CONFLUENCE_LIBRARY_PARENT_ID;
  if (raw === undefined || raw === null) return W8_DEFAULT_LIBRARY_PARENT_ID;
  const trimmed = String(raw).trim();
  if (!trimmed) return W8_DEFAULT_LIBRARY_PARENT_ID;
  return PAGE_ID.test(trimmed) ? trimmed : null;
}

export function paperSyncConfig(env) {
  const conf = confluenceConfig(env);
  const parentPageId = resolveLibraryParentId(env);
  const configured = conf.fixed && !!conf.client && hasValidSecret(env) && !!conf.callback && !!parentPageId;
  return {
    configured,
    parentPageId,
    spaceId: SPACE_ID,
  };
}

export function paperSyncPageTitle(sourceSha256) {
  return `Falsify w8-paper ${sourceSha256}`;
}

function documentDriveId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{10,180}$/.test(value)) fail(400, 'invalid_request');
  return value;
}

export function humanPaperTitle(payload) {
  const name = [...payload.title].slice(0, 200).join('');
  return name + ' · ' + payload.sourceSha256.slice(0, 16);
}

async function resolvePageTitle(db, payload) {
  if (!db) return paperSyncPageTitle(payload.sourceSha256);
  const row = await db.prepare(
    'INSERT INTO w8_paper_titles(source_sha256,page_title) VALUES (?,?) ON CONFLICT(source_sha256) DO UPDATE SET source_sha256=excluded.source_sha256 RETURNING page_title'
  ).bind(payload.sourceSha256, humanPaperTitle(payload)).first();
  return row.page_title;
}

function containsForbiddenText(text) {
  return FORBIDDEN_TEXT_PATTERNS.some(re => re.test(text));
}

function assertCleanPrimitive(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) fail(400, 'invalid_request');
  if (typeof value === 'string' && containsForbiddenText(value)) fail(422, 'forbidden_content');
}

function assertCleanObject(obj, depth) {
  if (!isPlain(obj)) fail(400, 'invalid_request');
  for (const key of Object.keys(obj)) {
    if (BANNED_KEY_RE.test(key)) fail(422, 'forbidden_content');
    const val = obj[key];
    if (ROLE_KEY_RE.test(key) && typeof val === 'string') {
      const lower = val.trim().toLowerCase();
      if (lower === 'red' || lower.startsWith('red-') || lower.startsWith('red_')) {
        fail(422, 'forbidden_content');
      }
    }
    assertCleanCarrier(val, depth + 1);
  }
}

function assertCleanCarrier(value, depth = 0) {
  if (value === null || value === undefined || typeof value === 'boolean') return;
  if (typeof value !== 'object') {
    assertCleanPrimitive(value);
    return;
  }
  if (depth > MAX_CARRIER_DEPTH) fail(400, 'invalid_request');
  if (Array.isArray(value)) {
    for (const item of value) assertCleanCarrier(item, depth + 1);
    return;
  }
  assertCleanObject(value, depth);
}

function assertAllowedKeys(obj, allowed) {
  if (!isPlain(obj) || Object.keys(obj).some(k => !allowed.includes(k))) {
    fail(400, 'invalid_request');
  }
}

function normalizeHex64(value, required) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(400, 'invalid_request');
    return null;
  }
  if (typeof value !== 'string') fail(400, 'invalid_request');
  const trimmed = value.trim();
  if (!HEX64_ANY_CASE.test(trimmed)) fail(400, 'invalid_request');
  return trimmed.toLowerCase();
}

function normalizeText(value, { required = false, multiline = false, maxLen = null } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(400, 'invalid_request');
    return '';
  }
  if (typeof value !== 'string') fail(400, 'invalid_request');
  const norm = value.normalize('NFC').trim();
  if (required && !norm) fail(400, 'invalid_request');
  if (!norm) return '';
  if (containsForbiddenText(norm)) fail(422, 'forbidden_content');
  const re = multiline ? UNSAFE_CTRL : UNSAFE_SINGLELINE;
  if (re.test(norm)) fail(400, 'invalid_request');
  if (maxLen !== null && norm.length > maxLen) fail(400, 'invalid_request');
  return norm;
}

function normalizeArxivId(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = normalizeText(value, { required: false, multiline: false, maxLen: 64 });
  if (!raw) return null;
  const stripped = raw.replace(/^arxiv:/i, '').trim();
  if (!ARXIV_ID.test(stripped)) fail(400, 'invalid_request');
  return stripped;
}

function normalizeFinding(raw) {
  assertAllowedKeys(raw, FINDING_KEYS);
  const quote = normalizeText(raw.quote, { multiline: true });
  const rationale = normalizeText(raw.rationale, { multiline: true });
  const severity = normalizeText(raw.severity, { maxLen: MAX_SHORT_FIELD_CHARS });
  const verdict = normalizeText(raw.verdict ?? raw.verdictLabel, { maxLen: MAX_SHORT_FIELD_CHARS });
  const out = { quote, rationale, severity, verdict };
  const id = normalizeText(raw.id, { maxLen: MAX_ID_CHARS });
  const locationLabel = normalizeText(raw.locationLabel, { maxLen: MAX_ID_CHARS });
  const findingType = normalizeText(raw.findingType, { maxLen: MAX_SHORT_FIELD_CHARS });
  const confidence = normalizeText(raw.confidence, { maxLen: MAX_SHORT_FIELD_CHARS });
  if (id) out.id = id;
  if (raw.page !== undefined && raw.page !== null) {
    if (!Number.isSafeInteger(raw.page) || raw.page < 1) fail(400, 'invalid_request');
    out.page = raw.page;
  }
  if (locationLabel) out.locationLabel = locationLabel;
  if (findingType) out.findingType = findingType;
  if (confidence) out.confidence = confidence;
  return out;
}

function normalizeRun(raw, defaultRevision) {
  assertAllowedKeys(raw, RUN_KEYS);
  const id = normalizeText(raw.id, { required: true, maxLen: MAX_ID_CHARS });
  const model = normalizeText(raw.model, { maxLen: MAX_ID_CHARS });
  const detector = normalizeText(raw.detector, { maxLen: MAX_SHORT_FIELD_CHARS });
  const condition = normalizeText(raw.condition, { maxLen: 160 });
  const revisionSha256 = raw.revisionSha256 !== undefined
    ? normalizeHex64(raw.revisionSha256, false)
    : defaultRevision;
  const createdAt = normalizeText(raw.createdAt, { maxLen: 64 });
  if (createdAt && !Number.isFinite(Date.parse(createdAt))) fail(400, 'invalid_request');
  const rawFindings = raw.findings ?? [];
  if (!Array.isArray(rawFindings)) fail(400, 'invalid_request');
  const findings = rawFindings.map(normalizeFinding);
  return {
    id,
    model,
    ...(detector ? { detector } : {}),
    ...(condition ? { condition } : {}),
    revisionSha256,
    ...(createdAt ? { createdAt } : {}),
    findings,
  };
}

export function validatePaperSyncPayload(raw) {
  if (!isPlain(raw)) fail(400, 'invalid_request');
  assertCleanCarrier(raw, 0);
  assertAllowedKeys(raw, TOP_KEYS);
  if (!Object.hasOwn(raw, 'sourceSha256') || !Object.hasOwn(raw, 'title')) {
    fail(400, 'invalid_request');
  }
  const sourceSha256 = normalizeHex64(raw.sourceSha256, true);
  const title = normalizeText(raw.title, { required: true, maxLen: MAX_TITLE_CHARS });
  const arxivId = normalizeArxivId(raw.arxivId);
  const revisionSha256 = normalizeHex64(raw.revisionSha256, false);
  const rawRuns = raw.runs ?? [];
  if (!Array.isArray(rawRuns)) fail(400, 'invalid_request');
  const runs = rawRuns.map(run => normalizeRun(run, revisionSha256));
  const result = { sourceSha256, title, arxivId, revisionSha256, runs };
  const original = documentDriveId(raw.sourceDriveId);
  const revision = documentDriveId(raw.revisionDriveId);
  if (original) result.sourceDriveId = original;
  if (revision && revisionSha256) result.revisionDriveId = revision;
  return result;
}

function sanitizeContributorLabel(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || containsForbiddenText(cleaned)) return fallback;
  return cleaned.slice(0, MAX_LABEL_CHARS);
}

function cloneState(existing, sourceSha256) {
  if (!existing) {
    return {
      schema: W8_PAPER_SYNC_SCHEMA,
      sourceSha256,
      title: '',
      titleAuthor: '',
      arxivId: null,
      arxivIds: [],
      contributors: {},
      revisions: [],
      runs: [],
    };
  }
  return JSON.parse(JSON.stringify(existing));
}

function dedupeStrings(items) {
  return [...new Set(items.filter(s => typeof s === 'string' && s))].sort();
}

function mergeFindings(existingFindings, incomingFindings) {
  const seen = new Set();
  const merged = [];
  for (const item of [...existingFindings, ...incomingFindings]) {
    const fp = canonicalJson(item);
    if (seen.has(fp)) continue;
    seen.add(fp);
    merged.push(item);
  }
  return merged;
}

function runStorageKey(contributorKey, revisionSha256, runId) {
  return `${contributorKey}::${revisionSha256 || 'source'}::${runId}`;
}

function effectiveRevision(revisionSha256, sourceSha256) {
  return revisionSha256 && revisionSha256 !== sourceSha256 ? revisionSha256 : null;
}

function mergeContributors(state, payload, contributor) {
  const prev = state.contributors[contributor.key] || { label: contributor.label, title: '', arxivId: null, revisions: [] };
  const revSet = new Set(Array.isArray(prev.revisions) ? prev.revisions : []);
  const topRev = effectiveRevision(payload.revisionSha256, payload.sourceSha256);
  if (topRev) revSet.add(topRev);
  for (const run of payload.runs) {
    const runRev = effectiveRevision(run.revisionSha256, payload.sourceSha256);
    if (runRev) revSet.add(runRev);
  }
  state.contributors[contributor.key] = {
    label: contributor.label || prev.label || contributor.key,
    title: payload.title,
    arxivId: payload.arxivId || prev.arxivId || null,
    revisions: [...revSet].sort(),
  };
  const ordered = {};
  for (const key of Object.keys(state.contributors).sort()) ordered[key] = state.contributors[key];
  state.contributors = ordered;
}

function mergeHeader(state, payload, contributor) {
  if (payload.sourceDriveId || payload.revisionDriveId) {
    state.driveFiles ??= {};
    if (payload.sourceDriveId) state.driveFiles[payload.sourceSha256] ??= payload.sourceDriveId;
    if (payload.revisionDriveId && payload.revisionSha256) state.driveFiles[payload.revisionSha256] ??= payload.revisionDriveId;
  }
  if (!state.title || state.titleAuthor === contributor.key) {
    state.title = payload.title;
    state.titleAuthor = contributor.key;
  }
  const allArxiv = dedupeStrings([
    ...(Array.isArray(state.arxivIds) ? state.arxivIds : []),
    state.arxivId,
    payload.arxivId,
  ]);
  state.arxivIds = allArxiv;
  if (!state.arxivId && payload.arxivId) state.arxivId = payload.arxivId;
  if (!state.arxivId && allArxiv.length) state.arxivId = allArxiv[0];
}

function mergeRevisions(state, payload, contributor) {
  const byRev = new Map();
  for (const item of state.revisions || []) {
    if (item && HEX64.test(item.revisionSha256)) {
      byRev.set(item.revisionSha256, new Set(Array.isArray(item.contributors) ? item.contributors : []));
    }
  }
  const revsToAdd = [
    effectiveRevision(payload.revisionSha256, payload.sourceSha256),
    ...payload.runs.map(r => effectiveRevision(r.revisionSha256, payload.sourceSha256)),
  ].filter(Boolean);
  for (const rev of revsToAdd) {
    if (!byRev.has(rev)) byRev.set(rev, new Set());
    byRev.get(rev).add(contributor.key);
  }
  state.revisions = [...byRev.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([revisionSha256, contribs]) => ({
      revisionSha256,
      contributors: [...contribs].sort(),
    }));
}

function mergeRuns(state, payload, contributor) {
  const byKey = new Map();
  for (const run of state.runs || []) {
    if (run && typeof run.key === 'string') byKey.set(run.key, run);
  }
  for (const incoming of payload.runs) {
    const rev = effectiveRevision(incoming.revisionSha256, payload.sourceSha256);
    const key = runStorageKey(contributor.key, rev, incoming.id);
    const prev = byKey.get(key);
    const detector = incoming.detector || prev?.detector || '';
    const condition = incoming.condition || prev?.condition || '';
    const next = {
      key,
      id: incoming.id,
      contributor: contributor.key,
      revisionSha256: rev,
      model: incoming.model || prev?.model || '',
      ...(detector ? { detector } : {}),
      ...(condition ? { condition } : {}),
      ...(incoming.createdAt || prev?.createdAt ? { createdAt: prev?.createdAt || incoming.createdAt } : {}),
      findings: mergeFindings(prev?.findings || [], incoming.findings),
    };
    byKey.set(key, next);
  }
  state.runs = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function mergePaperSyncState(existingState, payload, contributor) {
  const state = cloneState(existingState, payload.sourceSha256);
  mergeContributors(state, payload, contributor);
  mergeHeader(state, payload, contributor);
  mergeRevisions(state, payload, contributor);
  mergeRuns(state, payload, contributor);
  return state;
}

function bodyMarker(edge, sourceSha256, stateToken) {
  return `[falsify-w8-paper-sync:v1:${edge} source=${sourceSha256} state=${stateToken}]`;
}

export function parseAppOwnedPaperBody(bodyValue, expectedSourceSha256) {
  if (typeof bodyValue !== 'string' || !bodyValue.trim()) return null;
  const startRe = /\[falsify-w8-paper-sync:v1:start\s+source=([a-f0-9]{64})\s+state=([a-f0-9]{64}|pending)\]/g;
  const endRe = /\[falsify-w8-paper-sync:v1:end\s+source=([a-f0-9]{64})\s+state=([a-f0-9]{64}|pending)\]/g;
  const starts = [...bodyValue.matchAll(startRe)];
  const ends = [...bodyValue.matchAll(endRe)];
  if (starts.length !== 1 || ends.length !== 1) return null;
  const start = starts[0];
  const end = ends[0];
  if (start[1] !== expectedSourceSha256 || end[1] !== expectedSourceSha256) return null;
  if (start[2] !== end[2] || start.index >= end.index) return null;
  const beforeText = bodyValue.slice(0, start.index).replace(/<[^>]*>/g, '').trim();
  const afterText = bodyValue.slice(end.index + end[0].length).replace(/<[^>]*>/g, '').trim();
  if (beforeText || afterText) return null;
  return { sourceSha256: start[1], stateToken: start[2] };
}

function markerAnchor(edge, source, state) {
  return '<ac:structured-macro ac:name="anchor" ac:schema-version="1"><ac:parameter ac:name="">' +
    bodyMarker(edge, source, state) + '</ac:parameter></ac:structured-macro>';
}

function renderPendingHtml(sourceSha256, title) {
  const esc = confluenceInternal.escapeHtml;
  return (
    markerAnchor('start', sourceSha256, 'pending') +
    `<h1>${esc(title)}</h1>` +
    '<p>논문을 기록하는 중입니다.</p>' +
    markerAnchor('end', sourceSha256, 'pending')
  );
}

function renderArxivHtml(state) {
  const esc = confluenceInternal.escapeHtml;
  const ids = dedupeStrings([...(state.arxivIds || []), state.arxivId]);
  if (!ids.length) return '';
  const links = ids.map(id => `<a href="https://arxiv.org/abs/${encodeURIComponent(id)}">${esc(id)}</a>`).join(', ');
  return `<p><strong>arXiv:</strong> ${links}</p>`;
}

function renderAlternateTitlesHtml(state) {
  const esc = confluenceInternal.escapeHtml;
  const alts = dedupeStrings(
    Object.values(state.contributors || {})
      .map(c => c?.title)
      .filter(t => t && t !== state.title),
  );
  if (!alts.length) return '';
  return `<p><strong>Alternate titles:</strong> ${alts.map(esc).join(' · ')}</p>`;
}

function paperFileLink(state, hash, label) {
  const id = state.driveFiles?.[hash];
  if (!id || !/^[A-Za-z0-9_-]{10,180}$/.test(id)) return label;
  return '<a href="https://drive.google.com/file/d/' + id + '/view">' + label + '</a>';
}

function renderRevisionsHtml(state) {
  const esc = confluenceInternal.escapeHtml;
  const runsByRev = new Map();
  let sourceRunCount = 0;
  for (const run of state.runs) {
    if (!run.revisionSha256) {
      sourceRunCount++;
    } else {
      runsByRev.set(run.revisionSha256, (runsByRev.get(run.revisionSha256) || 0) + 1);
    }
  }
  const rows = [
    `<tr><td>${paperFileLink(state, state.sourceSha256, '원문 PDF')}</td><td><code>${esc(state.sourceSha256.slice(0, 12))}</code></td><td>${Object.keys(state.contributors).length}</td><td>${sourceRunCount}</td></tr>`,
    ...state.revisions.map(rev => (
      `<tr><td>${paperFileLink(state, rev.revisionSha256, '수정본 PDF')}</td><td><code>${esc(rev.revisionSha256.slice(0, 12))}</code></td>` +
      `<td>${rev.contributors.length}</td><td>${runsByRev.get(rev.revisionSha256) || 0}</td></tr>`
    )),
  ];
  return (
    `<h2>논문 파일</h2>` +
    `<table><thead><tr><th>파일</th><th>버전</th><th>참여자 수</th><th>BLUE 검수 횟수</th></tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table>`
  );
}

function renderFindingRow(f) {
  const esc = confluenceInternal.escapeHtml;
  return (
    `<tr><td>${esc(f.severity || '-')}</td><td>${esc(f.verdict || '-')}</td>` +
    `<td>${esc(f.quote || '')}</td><td>${esc(f.rationale || '')}</td></tr>`
  );
}

function renderRunsHtml(state, stateSha256, budgetBytes) {
  const esc = confluenceInternal.escapeHtml;
  if (!state.runs.length) {
    return `<h2>BLUE 검수</h2><p>첫 검수가 끝나면 결과가 여기에 표시됩니다.</p>`;
  }
  const parts = [`<h2>BLUE 검수</h2>`];
  let used = encoder.encode(parts[0]).byteLength;
  let truncated = false;
  for (const run of state.runs) {
    const label = state.contributors[run.contributor]?.label || run.contributor;
    const revText = run.revisionSha256 ? `revision <code>${esc(run.revisionSha256.slice(0, 12))}</code>` : 'source';
    const metaParts = [`Contributor: ${esc(label)}`];
    if (run.detector) metaParts.push(`Detector: ${esc(run.detector)}`);
    metaParts.push(`Model: ${esc(run.model || 'unspecified')}`);
    if (run.condition) metaParts.push(`Condition: ${esc(run.condition)}`);
    metaParts.push(`Target: ${revText}`, `Findings: ${run.findings.length}`);
    const header =
      `<h3>Run <code>${esc(run.id)}</code></h3>` +
      `<p>${metaParts.join(' · ')}</p>`;
    const tableHead = `<table><thead><tr><th>Severity</th><th>Verdict</th><th>Quote</th><th>Rationale</th></tr></thead><tbody>`;
    const tableFoot = `</tbody></table>`;
    const rows = run.findings.map(renderFindingRow).join('');
    const block = run.findings.length ? `${header}${tableHead}${rows}${tableFoot}` : header;
    const blockBytes = encoder.encode(block).byteLength;
    if (used + blockBytes > budgetBytes) {
      truncated = true;
      break;
    }
    parts.push(block);
    used += blockBytes;
  }
  if (truncated) {
    parts.push(`<p>Additional BLUE runs and findings are preserved losslessly in attachment <code>${esc(stateSha256)}.json</code>.</p>`);
  }
  return parts.join('');
}

export function renderPaperSyncHtml(state, stateSha256) {
  const esc = confluenceInternal.escapeHtml;
  const totalFindings = state.runs.reduce((sum, r) => sum + r.findings.length, 0);
  const contributorLabels = Object.entries(state.contributors)
    .map(([key, item]) => item?.label || key)
    .map(esc)
    .join(', ');
  const start = markerAnchor('start', state.sourceSha256, stateSha256);
  const end = markerAnchor('end', state.sourceSha256, stateSha256);
  const intro =
    `<h1>${esc(state.title)}</h1>` +
    renderArxivHtml(state) +
    renderAlternateTitlesHtml(state) +
    `<p>참여자 ${contributorLabels} · 수정본 ${state.revisions.length}개 · BLUE 검수 ${state.runs.length}회 · 지적 ${totalFindings}건</p>` +
    renderRevisionsHtml(state);
  const fixedBytes = encoder.encode(start + intro + end).byteLength;
  const runsHtml = renderRunsHtml(state, stateSha256, Math.max(16384, MAX_RENDERED_BODY_BYTES - fixedBytes - 1024));
  return start + intro + runsHtml + end;
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

async function fetchCurrentContributor(ctx, base, session) {
  const response = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/rest/api/user/current`,
    { headers: confluenceInternal.authHeaders(session.accessToken) },
  );
  if (response.status === 401) fail(401, 'unauthorized');
  if (response.status === 403 || response.status === 404) fail(403, 'permission_denied');
  const me = await confluenceInternal.readUpstreamJson(response);
  const accountId = typeof me?.accountId === 'string' ? me.accountId : '';
  if (!ACCOUNT_ID.test(accountId)) fail(403, 'permission_denied');
  const digest = await sha256HexText(`${session.cloudId}:${accountId}`);
  const key = `atl:${digest.slice(0, 16)}`;
  const label = sanitizeContributorLabel(me?.publicName || me?.displayName, key);
  return { key, label };
}

async function getPageWithBody(fetchImpl, base, token, pageId, writeStarted = false) {
  const url = `${base}/wiki/api/v2/pages/${pageId}?body-format=storage&include-labels=true&include-properties=true`;
  const response = await confluenceInternal.callUpstream(
    fetchImpl,
    url,
    { headers: confluenceInternal.authHeaders(token) },
    writeStarted,
  );
  if (response.status === 404) return null;
  return confluenceInternal.readUpstreamJson(response, writeStarted);
}

async function lookupPaperPageId(ctx, base, token, title) {
  const lookupUrl = `${base}/wiki/api/v2/pages?space-id=${SPACE_ID}&title=${encodeURIComponent(title)}&limit=5`;
  const lookup = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    lookupUrl,
    { headers: confluenceInternal.authHeaders(token) },
  );
  const found = await confluenceInternal.readUpstreamJson(lookup);
  const results = Array.isArray(found?.results) ? found.results : null;
  if (!results || results.length > 5) fail(502, 'upstream_invalid');
  const sameTitle = results.filter(p => p && p.title === title && p.status === 'current');
  if (sameTitle.length > 1) fail(409, 'archive_conflict');
  if (!sameTitle.length) return null;
  const id = String(sameTitle[0].id);
  if (!PAGE_ID.test(id)) fail(502, 'upstream_invalid');
  return id;
}

function pagePropertyEntry(page, key) {
  const results = page?.properties?.results;
  if (!Array.isArray(results)) return null;
  return results.find(item => item && item.key === key) || null;
}

function pageHasLabel(page, labelName) {
  const results = page?.labels?.results;
  return Array.isArray(results) && results.some(label => label && label.name === labelName);
}

function matchingSyncProperty(value, sourceSha256) {
  return isPlain(value) && value.schema === W8_PAPER_SYNC_SCHEMA &&
    value.kind === W8_PAPER_SYNC_KIND && value.sourceSha256 === sourceSha256;
}

function versionedProperty(property) {
  return property && PROPERTY_ID.test(String(property.id || '')) && Number.isSafeInteger(Number(property.version?.number));
}

function hasOtherArchiveMarkers(page) {
  const labels = page.labels?.results;
  const props = page.properties?.results;
  return (Array.isArray(labels) && labels.some(label => OTHER_FALSIFY_LABELS.has(label?.name))) ||
    (Array.isArray(props) && props.some(prop => OTHER_FALSIFY_PROPS.has(prop?.key)));
}

function assertAppOwnedPage(page, parentPageId, sourceSha256) {
  if (!page || !PAGE_ID.test(String(page.id))) fail(502, 'upstream_invalid');
  if (String(page.spaceId) !== SPACE_ID || String(page.parentId) !== parentPageId) {
    fail(409, 'archive_conflict');
  }
  if (hasOtherArchiveMarkers(page)) fail(409, 'archive_conflict');
  const syncProp = pagePropertyEntry(page, W8_PAPER_SYNC_PROPERTY_KEY);
  if (syncProp && !matchingSyncProperty(syncProp.value, sourceSha256)) fail(409, 'archive_conflict');
  const parsedBody = parseAppOwnedPaperBody(page?.body?.storage?.value, sourceSha256);
  if (!parsedBody) fail(409, 'archive_conflict');
  if (parsedBody.stateToken === 'pending' && syncProp?.value?.ready === true) {
    fail(409, 'archive_conflict');
  }
  const versionNumber = Number(page?.version?.number);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) fail(502, 'upstream_invalid');
  return {
    pageId: String(page.id),
    versionNumber,
    stateToken: parsedBody.stateToken,
    syncProp,
  };
}

function nextAttachmentPageUrl(nextLink, cloudId, pageId) {
  if (typeof nextLink !== 'string' || !nextLink) return null;
  let parsed;
  try { parsed = new URL(nextLink, 'https://api.atlassian.com'); } catch { fail(502, 'upstream_invalid'); }
  const expectedPath = `/ex/confluence/${cloudId}/wiki/api/v2/pages/${pageId}/attachments`;
  if (parsed.origin !== 'https://api.atlassian.com' || parsed.pathname !== expectedPath) {
    fail(502, 'upstream_invalid');
  }
  return parsed.toString();
}

async function findPageAttachmentByTitle(ctx, base, session, pageId, filename, writeStarted = false) {
  let url = `${base}/wiki/api/v2/pages/${pageId}/attachments?filename=${encodeURIComponent(filename)}&limit=25`;
  for (let hop = 0; hop < MAX_ATTACHMENT_PAGES; hop++) {
    const response = await confluenceInternal.callUpstream(
      ctx.fetchImpl,
      url,
      { headers: confluenceInternal.authHeaders(session.accessToken) },
      writeStarted,
    );
    const list = await confluenceInternal.readUpstreamJson(response, writeStarted);
    const results = Array.isArray(list?.results) ? list.results : null;
    if (!results || results.length > 25) fail(writeStarted ? 409 : 502, writeStarted ? 'write_unknown' : 'upstream_invalid');
    const found = results.find(item => item && item.title === filename && ATTACHMENT_ID.test(String(item.id)));
    if (found) return String(found.id);
    const nextUrl = nextAttachmentPageUrl(list?._links?.next, session.cloudId, pageId);
    if (!nextUrl) return null;
    url = nextUrl;
  }
  return null;
}

function parseVerifiedStateBytes(bytes, sourceSha256, corruptStatus, corruptCode) {
  let parsed;
  try { parsed = JSON.parse(decoder.decode(bytes)); } catch { fail(corruptStatus, corruptCode); }
  if (
    !isPlain(parsed) ||
    parsed.schema !== W8_PAPER_SYNC_SCHEMA ||
    parsed.sourceSha256 !== sourceSha256 ||
    !isPlain(parsed.contributors) ||
    !Array.isArray(parsed.revisions) ||
    !Array.isArray(parsed.runs)
  ) {
    fail(corruptStatus, corruptCode);
  }
  return parsed;
}

async function downloadAndVerifyState(ctx, base, session, pageId, expectedSha, sourceSha256, opts = false) {
  const { writeStarted = false, corruptStatus = 409, corruptCode = 'archive_conflict' } =
    typeof opts === 'boolean' ? { writeStarted: opts } : opts;
  const filename = `${expectedSha}.json`;
  const attId = await findPageAttachmentByTitle(ctx, base, session, pageId, filename, writeStarted);
  if (!attId) fail(corruptStatus, corruptCode);
  const dl = await confluenceInternal.downloadAttachment(
    ctx.fetchImpl,
    `${base}/wiki/rest/api/content/${pageId}/child/attachment/${attId}/download`,
    session.accessToken,
    session.cloudId,
    pageId,
    attId,
    writeStarted,
  );
  const bytes = await confluenceInternal.readBounded(dl, MAX_ARCHIVE_BYTES);
  if (dl.status < 200 || dl.status >= 300) fail(corruptStatus, corruptCode);
  if (!bytes) fail(corruptStatus === 422 ? 413 : corruptStatus, corruptStatus === 422 ? 'payload_too_large' : corruptCode);
  if ((await sha256HexBytes(bytes)) !== expectedSha) fail(corruptStatus, corruptCode);
  const parsed = parseVerifiedStateBytes(bytes, sourceSha256, corruptStatus, corruptCode);
  assertCleanCarrier(parsed, 0);
  return parsed;
}

async function ensureStateAttachment(ctx, base, session, pageId, stateSha256, stateBytes) {
  const filename = `${stateSha256}.json`;
  let attId = await findPageAttachmentByTitle(ctx, base, session, pageId, filename, true);
  if (!attId) {
    const boundary = `falsifyw8p${crypto.randomUUID().replace(/-/g, '')}`;
    const body = buildMultipartBody(boundary, filename, 'application/json', stateBytes);
    const response = await confluenceInternal.callUpstream(
      ctx.fetchImpl,
      `${base}/wiki/rest/api/content/${pageId}/child/attachment`,
      {
        method: 'POST',
        headers: confluenceInternal.authHeaders(session.accessToken, {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'X-Atlassian-Token': 'nocheck',
        }),
        body,
      },
      true,
    );
    if (response.status === 400 || response.status === 409) {
      attId = await findPageAttachmentByTitle(ctx, base, session, pageId, filename, true);
    } else {
      const uploaded = await confluenceInternal.readUpstreamJson(response, true);
      const list = uploaded?.results || (uploaded?.id ? [uploaded] : null);
      const item = Array.isArray(list) ? list.find(x => x && x.title === filename) : null;
      attId = item && ATTACHMENT_ID.test(String(item.id)) ? String(item.id) : null;
    }
  }
  if (!attId) fail(409, 'write_partial', {}, { pageId, readBack: true });
  const dl = await confluenceInternal.downloadAttachment(
    ctx.fetchImpl,
    `${base}/wiki/rest/api/content/${pageId}/child/attachment/${attId}/download`,
    session.accessToken,
    session.cloudId,
    pageId,
    attId,
    true,
  );
  const downloaded = await confluenceInternal.readBounded(dl, MAX_ARCHIVE_BYTES);
  if (dl.status < 200 || dl.status >= 300 || !downloaded || (await sha256HexBytes(downloaded)) !== stateSha256) {
    fail(409, 'write_partial', {}, { pageId, readBack: true });
  }
}

async function createPendingPage(ctx, base, token, parentPageId, pageTitle, sourceSha256, displayTitle) {
  const response = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/api/v2/pages`,
    {
      method: 'POST',
      headers: confluenceInternal.authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        spaceId: SPACE_ID,
        status: 'current',
        title: pageTitle,
        parentId: parentPageId,
        body: { representation: 'storage', value: renderPendingHtml(sourceSha256, displayTitle) },
      }),
    },
    false,
  );
  if (response.status === 400 || response.status === 409) return { conflict: true, page: null };
  const created = await confluenceInternal.readUpstreamJson(response, true);
  const pageId = created && PAGE_ID.test(String(created.id)) ? String(created.id) : null;
  if (!pageId) fail(409, 'write_unknown', {}, { readBack: true });
  ctx.budget.pageId = pageId;
  if (String(created.spaceId || SPACE_ID) !== SPACE_ID || (created.parentId && String(created.parentId) !== parentPageId)) {
    fail(409, 'archive_conflict');
  }
  return { conflict: false, pageId };
}

async function commitPageVersion(ctx, base, token, pageId, pageTitle, versionNumber, html) {
  const response = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/api/v2/pages/${pageId}`,
    {
      method: 'PUT',
      headers: confluenceInternal.authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        id: pageId,
        status: 'current',
        title: pageTitle,
        body: { representation: 'storage', value: html },
        version: { number: versionNumber + 1, message: 'Falsify W8 paper sync' },
      }),
    },
    true,
  );
  if (response.status === 409) return { conflict: true, page: null };
  const updated = await confluenceInternal.readUpstreamJson(response, true);
  return { conflict: false, page: updated };
}

async function fetchSyncProperty(ctx, base, token, pageId) {
  const listResp = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/api/v2/pages/${pageId}/properties?key=${encodeURIComponent(W8_PAPER_SYNC_PROPERTY_KEY)}`,
    { headers: confluenceInternal.authHeaders(token) },
    true,
  );
  const listed = await confluenceInternal.readUpstreamJson(listResp, true);
  return Array.isArray(listed?.results)
    ? listed.results.find(p => p && p.key === W8_PAPER_SYNC_PROPERTY_KEY) || null
    : null;
}

async function putSyncProperty(ctx, base, token, pageId, target, value) {
  const propId = String(target.id);
  const nextVer = Number(target.version.number) + 1;
  const resp = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/api/v2/pages/${pageId}/properties/${encodeURIComponent(propId)}`,
    {
      method: 'PUT',
      headers: confluenceInternal.authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ key: W8_PAPER_SYNC_PROPERTY_KEY, value, version: { number: nextVer } }),
    },
    true,
  );
  if (resp.status !== 409) await confluenceInternal.readUpstreamJson(resp, true);
}

async function upsertSyncProperty(ctx, base, token, pageId, existingProp, state, stateSha256) {
  const value = {
    schema: W8_PAPER_SYNC_SCHEMA,
    kind: W8_PAPER_SYNC_KIND,
    sourceSha256: state.sourceSha256,
    title: state.title,
    stateSha256,
    ready: true,
  };
  if (existingProp?.value?.ready === true && existingProp.value.stateSha256 === stateSha256 && existingProp.value.title === state.title) {
    return;
  }
  let target = existingProp;
  if (target && !versionedProperty(target)) {
    target = await fetchSyncProperty(ctx, base, token, pageId);
  }
  if (!target) {
    const resp = await confluenceInternal.callUpstream(
      ctx.fetchImpl,
      `${base}/wiki/api/v2/pages/${pageId}/properties`,
      {
        method: 'POST',
        headers: confluenceInternal.authHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: W8_PAPER_SYNC_PROPERTY_KEY, value }),
      },
      true,
    );
    if (resp.status === 400 || resp.status === 409) {
      const latest = await fetchSyncProperty(ctx, base, token, pageId);
      if (versionedProperty(latest)) {
        if (latest.value?.stateSha256 !== stateSha256) await putSyncProperty(ctx, base, token, pageId, latest, value);
      }
      return;
    }
    await confluenceInternal.readUpstreamJson(resp, true);
    return;
  }
  await putSyncProperty(ctx, base, token, pageId, target, value);
}

async function ensureSyncLabel(ctx, base, token, page, pageId) {
  if (pageHasLabel(page, W8_PAPER_SYNC_LABEL)) return;
  const response = await confluenceInternal.callUpstream(
    ctx.fetchImpl,
    `${base}/wiki/rest/api/content/${pageId}/label`,
    {
      method: 'POST',
      headers: confluenceInternal.authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify([{ prefix: 'global', name: W8_PAPER_SYNC_LABEL }]),
    },
    true,
  );
  await confluenceInternal.readUpstreamJson(response, true);
}

async function resolvePageUrl(ctx, base, token, page, pageId) {
  const direct = confluenceInternal.webUrl(page);
  if (direct) return direct;
  const fresh = await confluenceInternal.getPage(ctx.fetchImpl, base, token, pageId, true);
  const url = confluenceInternal.webUrl(fresh);
  if (!url) fail(409, 'write_partial', {}, { pageId, readBack: true });
  return url;
}

function promoteSyncError(error, pageId) {
  if (!pageId || !(error instanceof GatewayError)) throw error;
  if (error.code === 'archive_conflict' || error.code === 'payload_too_large' || error.code === 'forbidden_content') {
    throw error;
  }
  const unknown = ['upstream_unavailable', 'redirect_refused', 'write_unknown', 'upstream_invalid'].includes(error.code) || error.status >= 500;
  error.status = 409;
  error.code = unknown ? 'write_unknown' : 'write_partial';
  error.extra = { ...(error.extra || {}), pageId, readBack: true };
  throw error;
}

async function attemptPaperSync(ctx, session, base, parentPageId, pageTitle, payload, contributor) {
  const token = session.accessToken;
  let createdNow = false;
  let pageId = await lookupPaperPageId(ctx, base, token, pageTitle);
  if (!pageId) {
    const created = await createPendingPage(ctx, base, token, parentPageId, pageTitle, payload.sourceSha256, payload.title);
    if (created.conflict) return { retry: true };
    pageId = created.pageId;
    createdNow = true;
  }
  ctx.budget.pageId = pageId;
  const page = await getPageWithBody(ctx.fetchImpl, base, token, pageId, createdNow);
  if (!page) return { retry: true };
  await confluenceInternal.assertReadOpen(ctx.fetchImpl, base, token, pageId);
  const meta = assertAppOwnedPage(page, parentPageId, payload.sourceSha256);

  const existingState = meta.stateToken === 'pending'
    ? null
    : await downloadAndVerifyState(ctx, base, session, pageId, meta.stateToken, payload.sourceSha256, createdNow);

  const mergedState = mergePaperSyncState(existingState, payload, contributor);
  const stateBytes = encoder.encode(canonicalJson(mergedState));
  if (stateBytes.byteLength > MAX_ARCHIVE_BYTES) fail(413, 'payload_too_large');
  const nextStateSha = await sha256HexBytes(stateBytes);

  if (existingState !== null && meta.stateToken === nextStateSha) {
    try {
      await upsertSyncProperty(ctx, base, token, pageId, meta.syncProp, mergedState, nextStateSha);
      await ensureSyncLabel(ctx, base, token, page, pageId);
      const pageUrl = await resolvePageUrl(ctx, base, token, page, pageId);
      return { retry: false, status: 200, pageId, pageUrl };
    } catch (error) {
      promoteSyncError(error, pageId);
    }
  }

  try {
    await ensureStateAttachment(ctx, base, session, pageId, nextStateSha, stateBytes);
    const html = renderPaperSyncHtml(mergedState, nextStateSha);
    const committed = await commitPageVersion(ctx, base, token, pageId, pageTitle, meta.versionNumber, html);
    if (committed.conflict) return { retry: true };
    await upsertSyncProperty(ctx, base, token, pageId, meta.syncProp, mergedState, nextStateSha);
    await ensureSyncLabel(ctx, base, token, page, pageId);
    const pageUrl = await resolvePageUrl(ctx, base, token, committed.page || page, pageId);
    return { retry: false, status: createdNow ? 201 : 200, pageId, pageUrl };
  } catch (error) {
    promoteSyncError(error, pageId);
  }
}

export async function handleW8PaperSync(ctx, session) {
  const cfg = paperSyncConfig(ctx.env);
  if (!cfg.configured || !(await confluenceInternal.aesKey(ctx.env))) fail(503, 'not_configured');
  const rawBody = await confluenceInternal.readRequestJson(ctx.request, MAX_REQUEST_BYTES, ctx.budget.signal);
  const payload = validatePaperSyncPayload(rawBody);

  await confluenceInternal.confine(ctx.fetchImpl, session.accessToken, session.cloudId, cfg.parentPageId);
  const base = confluenceInternal.cloudBase(session.cloudId);
  const contributor = await fetchCurrentContributor(ctx, base, session);
  const pageTitle = await resolvePageTitle(ctx.env.DB, payload);

  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
    const result = await attemptPaperSync(ctx, session, base, cfg.parentPageId, pageTitle, payload, contributor);
    if (!result.retry) {
      return json(result.status, { pageId: result.pageId, pageUrl: result.pageUrl });
    }
  }
  fail(409, 'archive_conflict', {}, ctx.budget.pageId ? { pageId: ctx.budget.pageId, readBack: true } : null);
}

function singleQueryParam(params, name) {
  const values = params.getAll(name);
  if (values.length > 1) fail(400, 'invalid_request');
  return values.length ? values[0] : null;
}

function parsePapersQuery(searchParams) {
  for (const key of searchParams.keys()) {
    if (key !== 'cursor' && key !== 'pageId') fail(400, 'invalid_request');
  }
  const cursor = singleQueryParam(searchParams, 'cursor');
  const pageId = singleQueryParam(searchParams, 'pageId');
  if (cursor !== null && pageId !== null) fail(400, 'invalid_request');
  if (pageId !== null) {
    if (!PAGE_ID.test(pageId)) fail(400, 'invalid_request');
    return { mode: 'detail', pageId };
  }
  return { mode: 'list', cursor };
}

function isReadySyncProperty(value) {
  return isPlain(value) &&
    value.schema === W8_PAPER_SYNC_SCHEMA &&
    value.kind === W8_PAPER_SYNC_KIND &&
    value.ready === true &&
    typeof value.sourceSha256 === 'string' &&
    HEX64.test(value.sourceSha256) &&
    typeof value.stateSha256 === 'string' &&
    HEX64.test(value.stateSha256);
}

function readyPaperProperty(page, parentPageId) {
  if (!page || !PAGE_ID.test(String(page.id))) return null;
  if (page.status && page.status !== 'current') return null;
  if (String(page.spaceId) !== SPACE_ID || String(page.parentId) !== parentPageId) return null;
  if (hasOtherArchiveMarkers(page) || !pageHasLabel(page, W8_PAPER_SYNC_LABEL)) return null;
  const prop = pagePropertyEntry(page, W8_PAPER_SYNC_PROPERTY_KEY)?.value;
  return isReadySyncProperty(prop) ? prop : null;
}

function cleanPaperTitle(value) {
  if (typeof value !== 'string') return '';
  const norm = value.normalize('NFC').trim();
  if (!norm || norm.length > MAX_TITLE_CHARS || UNSAFE_SINGLELINE.test(norm) || containsForbiddenText(norm)) {
    return '';
  }
  return norm;
}

function resolveDisplayTitle(preferred, fallbackTitle) {
  return cleanPaperTitle(preferred) || cleanPaperTitle(fallbackTitle);
}

function verifiedArxivId(state) {
  const candidates = [state.arxivId, ...(Array.isArray(state.arxivIds) ? state.arxivIds : [])];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const stripped = candidate.normalize('NFC').trim().replace(/^arxiv:/i, '').trim();
    if (ARXIV_ID.test(stripped)) return stripped;
  }
  return null;
}

function verifiedSourceDriveId(state) {
  if (!isPlain(state.driveFiles)) return null;
  const value = state.driveFiles[state.sourceSha256];
  return typeof value === 'string' && DRIVE_ID.test(value) ? value : null;
}

function resolvedDetailStateSha(page, prop) {
  const parsedBody = parseAppOwnedPaperBody(page?.body?.storage?.value, prop.sourceSha256);
  if (!parsedBody) return prop.stateSha256;
  if (parsedBody.stateToken === 'pending') fail(404, 'not_found');
  return parsedBody.stateToken;
}

async function getReadableChildPage(fetchImpl, base, token, pageId) {
  const url = `${base}/wiki/api/v2/pages/${pageId}?include-labels=true&include-properties=true`;
  const response = await confluenceInternal.callUpstream(
    fetchImpl,
    url,
    { headers: confluenceInternal.authHeaders(token) },
  );
  if (response.status === 404 || response.status === 403) return null;
  return confluenceInternal.readUpstreamJson(response);
}

async function readListedPaper(ctx, session, base, parentPageId, child) {
  const page = await getReadableChildPage(ctx.fetchImpl, base, session.accessToken, String(child.id));
  const prop = readyPaperProperty(page, parentPageId);
  if (!prop) return null;
  try {
    await confluenceInternal.assertReadOpen(ctx.fetchImpl, base, session.accessToken, String(page.id));
  } catch (error) {
    if (error instanceof GatewayError && error.status === 403) return null;
    throw error;
  }
  const pageUrl = confluenceInternal.webUrl(page);
  const title = resolveDisplayTitle(prop.title, page.title);
  if (!pageUrl || !title) fail(502, 'upstream_invalid');
  return {
    pageId: String(page.id),
    pageUrl,
    title,
    sourceSha256: prop.sourceSha256,
  };
}

const STUDY_CONDITION_ORDER = Object.freeze(['A', 'B', 'C', UNCLASSIFIED_LABEL]);

export function extractStudyConditionGroup(value) {
  if (typeof value !== 'string') return UNCLASSIFIED_LABEL;
  const trimmed = value.normalize('NFC').trim();
  if (!trimmed) return UNCLASSIFIED_LABEL;
  const match = /^(?:W8[-_\s]*)?([ABC])(?:\b|[\s(·:_-]|$)/i.exec(trimmed);
  return match ? match[1].toUpperCase() : UNCLASSIFIED_LABEL;
}

function cleanOptionalText(value, maxLen = MAX_SHORT_FIELD_CHARS, multiline = false) {
  if (typeof value !== 'string') return '';
  const norm = value.normalize('NFC').replace(/\u0000/g, '').trim();
  const cleaned = multiline
    ? norm.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    : norm.replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (!cleaned || containsForbiddenText(cleaned)) return '';
  return maxLen && cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

function normalizeOptionalHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return HEX64.test(trimmed) ? trimmed : null;
}

function dedupeRunsByRevisionAndId(runs) {
  const byKey = new Map();
  if (!Array.isArray(runs)) return [];
  for (const run of runs) {
    if (!run || typeof run !== 'object') continue;
    const id = cleanOptionalText(run.id, MAX_ID_CHARS);
    if (!id) continue;
    const rev = normalizeOptionalHex(run.revisionSha256);
    const key = `${rev || 'source'}::${id}`;
    const prev = byKey.get(key);
    const findings = Array.isArray(run.findings) ? run.findings.filter(f => f && typeof f === 'object') : [];
    const detector = cleanOptionalText(run.detector, MAX_SHORT_FIELD_CHARS);
    const model = cleanOptionalText(run.model, MAX_ID_CHARS);
    const condition = cleanOptionalText(run.condition, 160);
    if (!prev) {
      byKey.set(key, {
        id,
        revisionSha256: rev,
        detector,
        model,
        condition,
        findings: mergeFindings([], findings),
      });
    } else {
      prev.detector = prev.detector || detector;
      prev.model = prev.model || model;
      prev.condition = prev.condition || condition;
      prev.findings = mergeFindings(prev.findings, findings);
    }
  }
  return [...byKey.values()];
}

function sortFindingTypeCounts(map) {
  return [...map.entries()]
    .sort((a, b) => {
      if (a[0] === UNCLASSIFIED_LABEL && b[0] !== UNCLASSIFIED_LABEL) return 1;
      if (b[0] === UNCLASSIFIED_LABEL && a[0] !== UNCLASSIFIED_LABEL) return -1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    })
    .map(([type, count]) => ({ type, count }));
}

function incrementBucket(map, key, findingCount) {
  const cur = map.get(key) || { runCount: 0, findingCount: 0 };
  cur.runCount += 1;
  cur.findingCount += findingCount;
  map.set(key, cur);
}

export function summarizeRunsStats(runs) {
  const deduped = dedupeRunsByRevisionAndId(runs);
  const typeCounts = new Map();
  const condCounts = new Map();
  const detectorCounts = new Map();
  const revCounts = new Map();
  let findingCount = 0;
  let unclassifiedFindingCount = 0;
  let legacyRunCount = 0;

  for (const run of deduped) {
    const fCount = run.findings.length;
    findingCount += fCount;
    const condGroup = extractStudyConditionGroup(run.condition);
    const detectorLabel = run.detector || UNCLASSIFIED_LABEL;
    if (condGroup === UNCLASSIFIED_LABEL || !run.detector) legacyRunCount += 1;
    incrementBucket(condCounts, condGroup, fCount);
    incrementBucket(detectorCounts, detectorLabel, fCount);
    incrementBucket(revCounts, run.revisionSha256 || '', fCount);
    for (const f of run.findings) {
      const fType = cleanOptionalText(f.findingType, MAX_SHORT_FIELD_CHARS) || UNCLASSIFIED_LABEL;
      if (fType === UNCLASSIFIED_LABEL) unclassifiedFindingCount += 1;
      typeCounts.set(fType, (typeCounts.get(fType) || 0) + 1);
    }
  }

  const byCondition = STUDY_CONDITION_ORDER
    .filter(c => condCounts.has(c))
    .map(c => ({ condition: c, ...condCounts.get(c) }));
  const byDetector = [...detectorCounts.entries()]
    .sort((a, b) => {
      if (a[0] === UNCLASSIFIED_LABEL && b[0] !== UNCLASSIFIED_LABEL) return 1;
      if (b[0] === UNCLASSIFIED_LABEL && a[0] !== UNCLASSIFIED_LABEL) return -1;
      return b[1].runCount - a[1].runCount || a[0].localeCompare(b[0]);
    })
    .map(([detector, counts]) => ({ detector, ...counts }));
  const byRevision = [...revCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([rev, counts]) => ({ revisionSha256: rev || null, ...counts }));

  return {
    runCount: deduped.length,
    findingCount,
    byFindingType: sortFindingTypeCounts(typeCounts),
    byCondition,
    byDetector,
    byRevision,
    unclassifiedFindingCount,
    legacyRunCount,
  };
}

export function validateRoundGradesPayload(raw) {
  if (!isPlain(raw) || raw.schema !== W8_ROUND_GRADES_SCHEMA || raw.published !== true) return null;
  assertCleanCarrier(raw);
  const revisionSha256 = normalizeOptionalHex(raw.revisionSha256);
  if (!revisionSha256 || !Array.isArray(raw.defects) || !Array.isArray(raw.grades)) return null;
  const defects = new Map();
  for (const item of raw.defects) {
    const defectId = cleanOptionalText(item?.defectId, MAX_ID_CHARS);
    if (!defectId || defects.has(defectId)) return null;
    defects.set(defectId, {
      defectId,
      findingType: cleanOptionalText(item.findingType) || UNCLASSIFIED_LABEL,
      label: cleanOptionalText(item.label, 240),
    });
  }
  if (!defects.size) return null;
  return { revisionSha256, defects, grades: raw.grades, roundId: cleanOptionalText(raw.roundId, 120) };
}

function matchPublishedGrades(round, runs) {
  const eligible = new Map(runs.filter(run => run.revisionSha256 === round.revisionSha256).map(run => [run.id, run]));
  const byRun = new Map();
  for (const grade of round.grades) {
    const run = eligible.get(grade?.runId);
    if (!run || grade.revisionSha256 !== round.revisionSha256 || !round.defects.has(grade.defectId)) continue;
    const recorded = extractStudyConditionGroup(run.condition);
    const declared = extractStudyConditionGroup(grade.condition);
    const condition = recorded === UNCLASSIFIED_LABEL ? declared : recorded;
    if (condition === UNCLASSIFIED_LABEL || (declared !== UNCLASSIFIED_LABEL && declared !== condition)) continue;
    if (!byRun.has(run.id)) byRun.set(run.id, { run, condition, grades: new Map(), conflict: false });
    const entry = byRun.get(run.id);
    const previous = entry.grades.get(grade.defectId);
    if (entry.condition !== condition || (previous && previous.status !== grade.status)) entry.conflict = true;
    entry.grades.set(grade.defectId, grade);
  }
  return [...byRun.values()].filter(entry => !entry.conflict && entry.grades.size === round.defects.size
    && [...entry.grades.values()].every(grade => VALID_GRADE_STATUSES.has(grade.status)));
}

function conditionRecall(entries, plantedCount, condition) {
  const counts = { detected: 0, partial: 0, missed: 0 };
  const runs = entries.filter(entry => entry.condition === condition);
  if (!runs.length) return null;
  for (const entry of runs) {
    for (const grade of entry.grades.values()) counts[grade.status]++;
  }
  const recall = (counts.detected + counts.partial * 0.5) / (runs.length * plantedCount);
  return { condition, runCount: runs.length, plantedCount, ...counts, recallPercent: Math.round(recall * 1000) / 10 };
}

function missedEvidence({ run, condition }, grade) {
  const finding = run.findings.find(item => Array.isArray(grade.findingIds) && grade.findingIds.includes(item.id));
  return {
    runId: run.id,
    condition,
    detector: run.detector,
    model: run.model,
    page: Number.isInteger(finding?.page) ? finding.page : null,
    locationLabel: cleanOptionalText(finding?.locationLabel),
    quote: cleanOptionalText(finding?.quote, 800, true),
    rationale: cleanOptionalText(grade.note || finding?.rationale, 800, true) || (`실행 지적 ${run.findings.length}건에서 미검출`),
  };
}

function repeatedMisses(round, entries) {
  const misses = [];
  for (const defect of round.defects.values()) {
    const missed = entries.filter(entry => entry.grades.get(defect.defectId).status === 'missed');
    if (missed.length < 2) continue;
    misses.push({
      ...defect,
      revisionSha256: round.revisionSha256,
      missedRunCount: missed.length,
      runIds: missed.map(entry => entry.run.id),
      conditions: [...new Set(missed.map(entry => entry.condition))],
      detectors: [...new Set(missed.map(entry => entry.run.detector).filter(Boolean))],
      evidence: missed.slice(0, 20).map(entry => missedEvidence(entry, entry.grades.get(defect.defectId))),
    });
  }
  return misses;
}

export function analyzeTeamRecord({ runs = [], roundGrades = null } = {}) {
  const stats = summarizeRunsStats(runs);
  if (!roundGrades) return { stats, round: null };
  const entries = matchPublishedGrades(roundGrades, dedupeRunsByRevisionAndId(runs));
  const plantedCount = roundGrades.defects.size;
  const round = {
    status: entries.length ? 'ready' : 'unmatched',
    roundId: roundGrades.roundId,
    revisionSha256: roundGrades.revisionSha256,
    plantedCount,
    scoredRunCount: entries.length,
    byCondition: ['A', 'B', 'C'].map(condition => conditionRecall(entries, plantedCount, condition)).filter(Boolean),
    repeatedMisses: repeatedMisses(roundGrades, entries),
  };
  return { stats, round };
}

async function readPaperDetail(ctx, session, cfg, pageId) {
  await confluenceInternal.confine(ctx.fetchImpl, session.accessToken, session.cloudId, cfg.parentPageId);
  const base = confluenceInternal.cloudBase(session.cloudId);
  const page = await getPageWithBody(ctx.fetchImpl, base, session.accessToken, pageId);
  const prop = readyPaperProperty(page, cfg.parentPageId);
  if (!prop) fail(404, 'not_found');
  await confluenceInternal.assertReadOpen(ctx.fetchImpl, base, session.accessToken, pageId);
  const stateSha = resolvedDetailStateSha(page, prop);
  const state = await downloadAndVerifyState(ctx, base, session, pageId, stateSha, prop.sourceSha256, {
    writeStarted: false,
    corruptStatus: 422,
    corruptCode: 'invalid_archive',
  });
  const pageUrl = confluenceInternal.webUrl(page);
  if (!pageUrl) fail(502, 'upstream_invalid');
  const title = resolveDisplayTitle(state.title, prop.title || page.title);
  if (!title) fail(422, 'invalid_archive');
  const summary = summarizeRunsStats(state.runs);
  return json(200, {
    pageId,
    pageUrl,
    title,
    sourceSha256: state.sourceSha256,
    arxivId: verifiedArxivId(state),
    sourceDriveId: verifiedSourceDriveId(state),
    stats: {
      runCount: summary.runCount,
      findingCount: summary.findingCount,
      byFindingType: summary.byFindingType,
    },
  });
}

export async function handleW8Papers(ctx, session) {
  const cfg = paperSyncConfig(ctx.env);
  if (!cfg.configured || !(await confluenceInternal.aesKey(ctx.env))) fail(503, 'not_configured');
  const query = parsePapersQuery(ctx.url.searchParams);
  if (query.mode === 'detail') return readPaperDetail(ctx, session, cfg, query.pageId);
  const { items, nextCursor } = await confluenceInternal.listParentChildren(
    ctx,
    session,
    cfg.parentPageId,
    query.cursor,
    (base, child) => readListedPaper(ctx, session, base, cfg.parentPageId, child),
    W8_PAPERS_CURSOR_PURPOSE,
  );
  return json(200, { items, nextCursor });
}
