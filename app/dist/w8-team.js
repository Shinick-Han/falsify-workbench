/* Falsify W8 Stage 2 team delivery client.
   Exposes FalsifyW8Team.submit({csv, filename, participant, runs, condition}) -> {pageUrl, issueUrl}.
   Reuses per-user Atlassian OAuth gateway with an AES-GCM encrypted session cache separate from falsify.experiment-ledger.v1.
   Builds sanitized BLUE-only archives without truncating quotes/findings, reconciles partial/uncertain writes, and preserves local work. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FalsifyW8Team = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';

  const SESSION_KEY = 'falsify.w8-session.v1';
  const CACHE_KEY = 'falsify.w8-cache-key.v1';
  const RECEIPTS_KEY = 'falsify.w8-receipts.v1';
  const ARCHIVE_SCHEMA = 'falsify.w8-blue-archive.v1';
  const EXPECTED_SITE = 'https://falsify.atlassian.net';
  const EXPECTED_SPACE = 'Falsify';
  const EXPECTED_SPACE_ID = '65737';
  const DEFAULT_ISSUE = 'FLS-18';
  const AUTH_HOSTS = new Set(['auth.atlassian.com', 'login.atlassian.com', 'falsify.atlassian.net']);
  const SESSION_HEADER = 'x-falsify-confluence-session';
  const AUTH_MS = 15000;
  const READ_MS = 30000;
  const SUBMIT_MS = 90000;
  const MAX_ARCHIVE_BYTES = 6 * 1024 * 1024;
  const MAX_CSV_BYTES = 6 * 1024 * 1024;
  const MAX_FILENAME_CHARS = 255;
  const HEX64 = /^[a-f0-9]{64}$/;
  const ISSUE_RE = /^[A-Z][A-Z0-9_]{1,15}-[1-9][0-9]{0,7}$/;
  const UNSAFE_SINGLELINE = /[\u0000-\u001f\u007f]/;
  const UNSAFE_FILENAME_CHARS = /[\/\\";:*?<>|]/;

  const ERROR_COPY = {
    not_configured: '팀 제출 서버 설정이 아직 완료되지 않았습니다. 로컬 CSV 다운로드와 작업은 계속 사용할 수 있습니다.',
    popup_blocked: '로그인 팝업이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤 다시 제출하세요. 로컬 작업은 그대로입니다.',
    auth_cancelled: 'Atlassian 연결을 취소했습니다. 로컬 작업과 CSV는 그대로입니다.',
    auth_required: 'Atlassian 팀 연결이 필요합니다. 로컬 작업과 CSV는 그대로입니다.',
    timeout: '응답이 끊겼습니다. 다시 제출하면 원격 상태를 대조해 남은 단계만 이어서 완료합니다. 로컬 작업은 그대로입니다.',
    network: '응답이 끊겼습니다. 다시 제출하면 원격 상태를 대조해 남은 단계만 이어서 완료합니다. 로컬 작업은 그대로입니다.',
    jira_scope_required: 'Jira 첨부·댓글 권한을 포함해 다시 연결해야 합니다.',
    permission_denied: '이 Atlassian 계정에 Falsify 팀 공간 또는 Jira 이슈 쓰기 권한이 없습니다. 로컬 CSV는 그대로입니다.',
    issue_not_allowed: '허용된 W8 Jira 이슈가 아닙니다.',
    parent_not_allowed: '대상 Confluence 공간 또는 부모 페이지 설정을 확인하세요. 다른 곳에 올리지 않았습니다.',
    space_not_allowed: '대상 Confluence 공간 또는 부모 페이지 설정을 확인하세요. 다른 곳에 올리지 않았습니다.',
    site_not_allowed: '대상 Confluence 공간 또는 부모 페이지 설정을 확인하세요. 다른 곳에 올리지 않았습니다.',
    write_partial: '제출이 중간에 멈췄습니다. 다시 제출하면 완료된 단계를 재사용하고 남은 단계만 마칩니다. 로컬 작업은 그대로입니다.',
    write_unknown: '제출 완료 여부를 확인하지 못했습니다. 다시 제출하면 원격 상태를 대조해 남은 단계만 이어서 완료합니다. 로컬 작업은 그대로입니다.',
    archive_conflict: '같은 이름의 기존 페이지와 충돌했습니다. 덮어쓰지 않았습니다.',
    payload_too_large: '제출 크기가 6 MiB 한도를 넘습니다. 잘라서 보내지 않았으며 로컬 CSV는 그대로입니다.',
    rate_limited: '요청이 몰렸습니다. 잠시 뒤 다시 제출하세요.',
    session_expired: 'Atlassian 연결이 만료되었습니다. 다시 연결한 뒤 제출하세요.',
    unauthorized: 'Atlassian 연결이 만료되었습니다. 다시 연결한 뒤 제출하세요.',
  };

  const encoder = new TextEncoder();

  function w8Error(code, message, extra) {
    const err = new Error(message);
    err.code = code;
    if (extra && typeof extra === 'object') Object.assign(err, extra);
    return err;
  }

  function bytesToB64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function b64ToBytes(text) {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function base64url(bytes) {
    return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function newNonce() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return base64url(b);
  }

  async function sha256HexBytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  function isPlain(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === null || Object.getPrototypeOf(proto) === null;
  }

  function canonicalJson(v) {
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    if (isPlain(v)) {
      return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  }

  function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }

  function parseBase(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const u = new URL(value);
      const allowed = u.protocol === 'https:' || (isLoopbackHost(u.hostname) && u.protocol === 'http:');
      if (!allowed || u.username || u.password || u.search || u.hash) return '';
      return u.origin + u.pathname.replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  function originOf(baseUrl) {
    try { return baseUrl ? new URL(baseUrl).origin : ''; } catch { return ''; }
  }

  function checkAuthorizeUrl(value) {
    let u;
    try { u = new URL(value); } catch { throw w8Error('invalid_auth_url', '게이트웨이의 로그인 주소가 올바르지 않아 창을 열지 않았습니다.'); }
    if (u.protocol !== 'https:' || u.username || u.password || !AUTH_HOSTS.has(u.hostname)) {
      throw w8Error('invalid_auth_url', '로그인 주소가 Atlassian Falsify 연결이 아니어서 창을 열지 않았습니다.');
    }
    return u.href;
  }

  function allowedSiteUrl(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.origin !== EXPECTED_SITE) return '';
      return u.href;
    } catch {
      return '';
    }
  }

  function cleanStr(value, multiline) {
    if (value === null || value === undefined) return '';
    const s = String(value).replace(/\u0000/g, '').trim();
    const cleaned = multiline
      ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      : s.replace(/[\u0000-\u001f\u007f]/g, ' ');
    if (cleaned.includes('%PDF-')) throw w8Error('forbidden_content', '원본 PDF 바이너리는 팀 보관에 포함할 수 없습니다.');
    return cleaned;
  }

  function parsePageFromLabel(label) {
    if (typeof label !== 'string') return null;
    const m = /(?:^|\b)(?:p\.?|page|쪽)\s*([1-9]\d*)\b|\b([1-9]\d*)\s*쪽/i.exec(label);
    if (!m) return null;
    const n = Number(m[1] || m[2]);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  }

  function normalizeEvidenceEntry(item, segmentMap) {
    if (typeof item === 'string') {
      const q = cleanStr(item, true);
      return q ? { quote: q, relation: '', label: '' } : null;
    }
    if (!item || typeof item !== 'object') return null;
    const seg = typeof item.segmentId === 'string' ? segmentMap.get(item.segmentId) : null;
    return {
      quote: cleanStr(item.quote ?? item.text ?? '', true),
      relation: cleanStr(item.relation ?? item.reason ?? '', true),
      label: cleanStr(item.label ?? seg?.label ?? '', false),
    };
  }

  function normalizeFindingEvidence(raw, segmentMap) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      const entry = normalizeEvidenceEntry(item, segmentMap);
      if (entry) out.push(entry);
    }
    return out;
  }

  function extractRunFindings(run) {
    if (Array.isArray(run.findings)) return run.findings;
    if (Array.isArray(run.response?.findings)) return run.response.findings;
    if (Array.isArray(run.snapshot?.items)) {
      return run.snapshot.items.filter(item => item && item.kind !== 'change' && item.enabled !== false);
    }
    return [];
  }

  function buildSegmentMap(segments) {
    const map = new Map();
    if (!Array.isArray(segments)) return map;
    for (const s of segments) {
      if (s && typeof s.id === 'string') {
        map.set(s.id, {
          label: typeof s.label === 'string' ? s.label : '',
          pageIndex: Number.isInteger(s.pageIndex) ? s.pageIndex : null,
        });
      }
    }
    return map;
  }

  function resolveFindingPage(f, seg) {
    if (Number.isSafeInteger(f.page) && f.page >= 1) return f.page;
    if (Number.isSafeInteger(f.pageIndex) && f.pageIndex >= 0) return f.pageIndex + 1;
    if (seg && Number.isSafeInteger(seg.pageIndex) && seg.pageIndex >= 0) return seg.pageIndex + 1;
    return parsePageFromLabel(f.locationLabel || f.location || seg?.label || '');
  }

  function firstPresent(obj, keys, fallback = '') {
    for (const k of keys) {
      if (obj[k] !== null && obj[k] !== undefined && obj[k] !== '') return obj[k];
    }
    return fallback;
  }

  function sanitizeFinding(f, i, segmentMap) {
    const seg = typeof f.segmentId === 'string' ? segmentMap.get(f.segmentId) : null;
    const id = cleanStr(firstPresent(f, ['id', 'reportNumber'], `F${i + 1}`), false) || `F${i + 1}`;
    return {
      id,
      page: resolveFindingPage(f, seg),
      locationLabel: cleanStr(firstPresent(f, ['locationLabel', 'location', 'label'], seg?.label ?? ''), false),
      findingType: cleanStr(firstPresent(f, ['findingType', 'type', 'defectFamily']), false),
      verdictLabel: cleanStr(firstPresent(f, ['verdictLabel', 'verdict']), false),
      severity: cleanStr(f.severity, false),
      quote: cleanStr(firstPresent(f, ['quote', 'sourceQuote']), true),
      rationale: cleanStr(firstPresent(f, ['rationale', 'reason', 'description']), true),
      evidence: normalizeFindingEvidence(f.evidence, segmentMap),
      confidence: cleanStr(f.confidence, false),
      uncertainty: cleanStr(f.uncertainty, true),
      additionalInfo: cleanStr(firstPresent(f, ['additionalInfo', 'neededInfo']), true),
    };
  }

  function firstBatchField(run, key) {
    const batches = run.snapshot?.batches;
    if (!Array.isArray(batches)) return '';
    const hit = batches.find(b => b && b[key]);
    return hit ? hit[key] : '';
  }

  function optionalHex(value) {
    return typeof value === 'string' && HEX64.test(value) ? value : null;
  }

  function normalizeRunStatus(run) {
    const raw = run.status ?? run.response?.status ?? 'ok';
    return ['ok', 'abstain', 'refusal'].includes(raw) ? raw : 'ok';
  }

  function resolveRunMeta(run, index) {
    const isExternal = run.sourceKind === 'external' || run.provenance === 'external-ai-import' || !!run.snapshot;
    const runNumber = Number.isSafeInteger(run.runNumber) && run.runNumber >= 1 ? run.runNumber : index + 1;
    const createdAt = typeof run.createdAt === 'string' && Number.isFinite(Date.parse(run.createdAt)) ? run.createdAt : '';
    const fallbackId = `blue-run-${runNumber}`;
    return {
      runNumber,
      id: cleanStr(run.id || fallbackId, false) || fallbackId,
      createdAt,
      sourceKind: isExternal ? 'external' : 'builtin',
      provenance: cleanStr(run.provenance || (isExternal ? 'external-ai-import' : 'local-codex'), false),
      detector: cleanStr(run.detector || (isExternal ? '내 AI' : '내장 BLUE'), false),
      model: cleanStr(run.model || firstBatchField(run, 'model'), false),
      fileHash: optionalHex(run.fileHash),
      sourceHash: optionalHex(run.sourceHash),
      promptCondition: cleanStr(firstPresent(run, ['promptCondition', 'promptVersion'], firstBatchField(run, 'prompt')), false),
      status: normalizeRunStatus(run),
    };
  }

  function sanitizeSingleRun(run, index) {
    const segmentMap = buildSegmentMap(run.segments);
    const findings = [];
    const rawFindings = extractRunFindings(run);
    for (let i = 0; i < rawFindings.length; i++) {
      const f = rawFindings[i];
      if (f && typeof f === 'object') findings.push(sanitizeFinding(f, i, segmentMap));
    }
    return { ...resolveRunMeta(run, index), findings };
  }

  function validateCsvInput(csv, filename) {
    if (typeof csv !== 'string' || !csv.length) throw w8Error('invalid_csv', '제출할 CSV 내용이 비어 있습니다.');
    if (csv.includes('%PDF-')) throw w8Error('forbidden_content', '원본 PDF 바이너리는 팀 제출에 포함할 수 없습니다.');
    const csvBytes = encoder.encode(csv);
    if (csvBytes.byteLength > MAX_CSV_BYTES) throw w8Error('payload_too_large', 'CSV 크기가 6 MiB 한도를 넘습니다.');
    const cleanName = typeof filename === 'string' ? filename.normalize('NFC').trim() : '';
    const badName = !cleanName || cleanName.length > MAX_FILENAME_CHARS || UNSAFE_SINGLELINE.test(cleanName) ||
      !/\.csv$/i.test(cleanName) || UNSAFE_FILENAME_CHARS.test(cleanName) || cleanName.includes('..');
    if (badName) throw w8Error('invalid_filename', 'CSV 파일 이름은 안전한 .csv 형식이어야 합니다.');
    return { csvBytes, filename: cleanName };
  }

  function validateSubmitMeta(participant, condition, issueKey) {
    const cleanParticipant = typeof participant === 'string' ? participant.normalize('NFC').trim() : '';
    if (!cleanParticipant || UNSAFE_SINGLELINE.test(cleanParticipant)) throw w8Error('invalid_participant', '참가자 이름을 입력하세요.');
    const cleanCondition = typeof condition === 'string' ? condition.normalize('NFC').trim() : '';
    if (!cleanCondition || UNSAFE_SINGLELINE.test(cleanCondition)) throw w8Error('invalid_condition', 'W8 조건을 입력하세요.');
    const cleanIssue = String(issueKey || DEFAULT_ISSUE).trim().toUpperCase();
    if (!ISSUE_RE.test(cleanIssue)) throw w8Error('invalid_issue', 'Jira 이슈 키 형식이 올바르지 않습니다.');
    return { participant: cleanParticipant, condition: cleanCondition, issueKey: cleanIssue };
  }

  function isBlueRun(r) {
    if (!r || typeof r !== 'object') return false;
    if (typeof r.role === 'string' && r.role.toLowerCase() === 'red') return false;
    if (typeof r.snapshot?.role === 'string' && r.snapshot.role.toLowerCase() === 'red') return false;
    return true;
  }

  function extractSanitizedBlueRuns(runs) {
    if (!Array.isArray(runs) || runs.length === 0) throw w8Error('invalid_runs', '제출할 BLUE 실행을 하나 이상 선택하세요.');
    const blueOnly = runs.filter(isBlueRun);
    if (!blueOnly.length) throw w8Error('forbidden_content', 'RED 기록은 팀에 제출할 수 없습니다. BLUE 실행만 선택하세요.');
    const seenIds = new Set();
    return blueOnly.map((run, i) => {
      const sanitized = sanitizeSingleRun(run, i);
      if (seenIds.has(sanitized.id)) sanitized.id = `${sanitized.id}-${i + 1}`;
      seenIds.add(sanitized.id);
      return sanitized;
    });
  }

  // Strictly extracts sanitized BLUE-only runs without truncating quotes/findings.
  async function buildBlueOnlyArchive({ csv, filename, participant, runs, condition, issueKey = DEFAULT_ISSUE }) {
    const csvInfo = validateCsvInput(csv, filename);
    const meta = validateSubmitMeta(participant, condition, issueKey);
    const sanitizedRuns = extractSanitizedBlueRuns(runs);
    const csvSha256 = await sha256HexBytes(csvInfo.csvBytes);
    const findingCount = sanitizedRuns.reduce((sum, r) => sum + r.findings.length, 0);
    const archive = {
      schema: ARCHIVE_SCHEMA,
      participant: meta.participant,
      condition: meta.condition,
      issueKey: meta.issueKey,
      csvFilename: csvInfo.filename,
      csvSha256,
      runCount: sanitizedRuns.length,
      findingCount,
      runs: sanitizedRuns,
    };
    const archiveBytes = encoder.encode(canonicalJson(archive));
    if (archiveBytes.byteLength > MAX_ARCHIVE_BYTES) throw w8Error('payload_too_large', 'BLUE 보관 크기가 6 MiB 한도를 넘습니다.');
    return {
      archive,
      csvSha256,
      archiveSha256: await sha256HexBytes(archiveBytes),
      participant: meta.participant,
      condition: meta.condition,
      filename: csvInfo.filename,
      issueKey: meta.issueKey,
    };
  }

  function receiptMapKey(participant, issueKey) {
    return `${String(participant || '').normalize('NFC').trim().toLowerCase()}::${String(issueKey || DEFAULT_ISSUE).trim().toUpperCase()}`;
  }

  function safeErrorCode(text) {
    try {
      const code = JSON.parse(text)?.error?.code;
      return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : '';
    } catch {
      return '';
    }
  }

  function safeProgress(text) {
    try {
      const p = JSON.parse(text)?.progress;
      return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
    } catch {
      return null;
    }
  }

  function koreanFailure(err) {
    const code = err?.errorCode || err?.code || '';
    if (Object.hasOwn(ERROR_COPY, code)) return ERROR_COPY[code];
    if (err?.status === 429) return ERROR_COPY.rate_limited;
    if (err?.status === 401) return ERROR_COPY.unauthorized;
    if (err?.message && err.code && err.code !== 'http' && err.code !== 'response') return err.message;
    return '팀 제출을 완료하지 못했습니다. 다시 제출하면 원격 상태를 확인해 이어서 진행합니다. 로컬 작업은 그대로입니다.';
  }

  function buildReceiptRecord(entry) {
    return {
      participant: entry.participant,
      condition: entry.condition || '',
      issueKey: entry.issueKey,
      pageId: entry.pageId || null,
      pageUrl: allowedSiteUrl(entry.pageUrl) || null,
      attachmentId: entry.attachmentId || null,
      attachmentFilename: entry.attachmentFilename || null,
      attachmentUrl: allowedSiteUrl(entry.attachmentUrl) || null,
      commentId: entry.commentId || null,
      issueUrl: allowedSiteUrl(entry.issueUrl) || null,
      csvSha256: entry.csvSha256 || null,
      archiveSha256: entry.archiveSha256 || null,
      state: entry.state || 'complete',
      updatedAt: new Date().toISOString(),
    };
  }

  function buildResumePayload(receipt) {
    if (!receipt) return undefined;
    const out = {};
    for (const key of ['pageId', 'attachmentId', 'commentId', 'csvSha256', 'archiveSha256']) {
      if (receipt[key]) out[key] = receipt[key];
    }
    return Object.keys(out).length ? out : undefined;
  }

  function create(deps = {}) {
    const cfg = deps.config ?? globalThis.FalsifyCloudConfig ?? {};
    const storage = deps.storage ?? globalThis.localStorage;
    const fetcher = deps.fetch ?? globalThis.fetch?.bind(globalThis);
    const win = deps.window ?? globalThis.window;
    const loc = deps.location ?? globalThis.location;
    const doc = deps.document ?? globalThis.document;
    const base = parseBase(cfg.apiBase);
    const gatewayOrigin = base ? new URL(base).origin : '';

    const state = { session: null, authBase: '', stamp: 0, caps: null, pending: null, busy: false, restored: false };

    function readReceipts() {
      try {
        const raw = storage?.getItem(RECEIPTS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return isPlain(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    function saveReceipt(entry) {
      if (!storage || !entry?.participant || !entry?.issueKey) return;
      try {
        const map = readReceipts();
        map[receiptMapKey(entry.participant, entry.issueKey)] = buildReceiptRecord(entry);
        storage.setItem(RECEIPTS_KEY, JSON.stringify(map));
      } catch {}
    }

    function getReceipt({ participant, issueKey = DEFAULT_ISSUE } = {}) {
      if (!participant) return null;
      return readReceipts()[receiptMapKey(participant, issueKey)] || null;
    }

    async function cacheKey() {
      const existing = storage?.getItem(CACHE_KEY);
      if (existing) {
        return crypto.subtle.importKey('raw', b64ToBytes(existing), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      }
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
      storage.setItem(CACHE_KEY, bytesToB64(raw));
      return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    }

    async function rememberSession(token, expiresAt, stamp, authBaseOverride) {
      if (state.stamp !== stamp || typeof token !== 'string' || !(Date.parse(expiresAt) > Date.now())) return false;
      const savedAuthBase = parseBase(authBaseOverride) || state.authBase || base;
      const iv = new Uint8Array(12);
      crypto.getRandomValues(iv);
      const key = await cacheKey();
      const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(JSON.stringify({ session: token, expiresAt, ...(savedAuthBase ? { authBase: savedAuthBase } : {}) })),
      ));
      if (state.stamp !== stamp) return false;
      storage.setItem(SESSION_KEY, JSON.stringify({ v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) }));
      if (state.stamp !== stamp) { try { storage.removeItem(SESSION_KEY); } catch {} return false; }
      state.session = { token, expiresAt };
      if (savedAuthBase) state.authBase = savedAuthBase;
      return true;
    }

    async function restoreSession() {
      if (state.restored && isConnected()) return state.session;
      state.restored = true;
      const raw = storage?.getItem(SESSION_KEY);
      if (!raw) { state.session = null; state.authBase = ''; return null; }
      try {
        const packed = JSON.parse(raw);
        if (!packed || packed.v !== 1) throw new Error('shape');
        const key = await cacheKey();
        const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(packed.iv) }, key, b64ToBytes(packed.ct));
        const data = JSON.parse(new TextDecoder().decode(buf));
        if (typeof data.session !== 'string' || !(Date.parse(data.expiresAt) > Date.now())) throw new Error('expired');
        state.session = { token: data.session, expiresAt: data.expiresAt };
        state.authBase = parseBase(data.authBase) || state.authBase || base;
        return state.session;
      } catch {
        clearCachedSession();
        return null;
      }
    }

    function clearCachedSession() {
      state.session = null;
      state.authBase = '';
      try { storage?.removeItem(SESSION_KEY); } catch {}
    }

    function isConnected() {
      return !!(state.session && Date.parse(state.session.expiresAt) > Date.now());
    }

    function getHeader(res, name) {
      try { return res.headers?.get?.(name) ?? null; } catch { return null; }
    }

    function budgetFor(method, path) {
      const bare = String(path || '').split('?')[0];
      if (bare.startsWith('/v1/w8/auth/')) return AUTH_MS;
      if (bare === '/v1/w8/paper-attachments' && path.includes('attachmentId=')) return SUBMIT_MS;
      if (method === 'POST' && bare === '/v1/w8/submit') return SUBMIT_MS;
      if (method === 'POST' && bare === '/v1/w8/history/jira-link') return SUBMIT_MS;
      if (method === 'PUT' && bare === '/v1/w8/paper-sync') return SUBMIT_MS;
      return READ_MS;
    }

    function buildHeaders(body, auth) {
      const headers = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (auth) {
        if (!isConnected()) throw w8Error('auth_required', koreanFailure({ code: 'auth_required' }));
        headers.authorization = 'Bearer ' + state.session.token;
      }
      return headers;
    }

    async function fetchPayload(method, path, headers, body, targetBase, pdf) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), budgetFor(method, path));
      try {
        const res = await fetcher(targetBase + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctl.signal,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          mode: 'cors',
        });
        if (pdf && res.ok) return { res, blob: await res.blob() };
        return { res, text: await res.text() };
      } catch {
        const code = ctl.signal.aborted ? 'timeout' : 'network';
        throw w8Error(code, koreanFailure({ code }));
      } finally {
        clearTimeout(timer);
      }
    }

    function parseApiOutcome(res, text, stamp, clearOn401 = true) {
      if (!res.ok) {
        const errorCode = safeErrorCode(text);
        const progress = safeProgress(text);
        if (res.status === 401 && clearOn401 && stamp === state.stamp) clearCachedSession();
        throw w8Error(errorCode || 'http', koreanFailure({ status: res.status, errorCode }), { status: res.status, errorCode, progress });
      }
      if (!text) return {};
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {}
      throw w8Error('response', koreanFailure({ code: 'response' }));
    }

    async function api(method, path, { body, auth = false, stamp = state.stamp, base: baseOverride, clearOn401 = true, pdf = false } = {}) {
      const targetBase = parseBase(baseOverride) || base;
      if (!targetBase || !fetcher) throw w8Error('not_configured', koreanFailure({ code: 'not_configured' }));
      if (auth && targetBase !== state.authBase) throw w8Error('auth_required', koreanFailure({ code: 'auth_required' }));
      if (!path.startsWith('/v1/w8/')) throw w8Error('invalid_request', '허용되지 않은 원격 주소입니다.');
      const headers = buildHeaders(body, auth);
      if (pdf) headers.accept = 'application/pdf';
      const { res, text, blob } = await fetchPayload(method, path, headers, body, targetBase, pdf);
      const replacement = getHeader(res, SESSION_HEADER);
      if (replacement && stamp === state.stamp && state.session?.expiresAt) {
        await rememberSession(replacement, state.session.expiresAt, stamp).catch(() => {});
      }
      if (blob) {
        if (blob.type.split(';')[0] !== 'application/pdf') throw w8Error('response', 'PDF를 읽을 수 없습니다.');
        return blob;
      }
      return parseApiOutcome(res, text, stamp, clearOn401);
    }

    async function capabilities(stamp = state.stamp, baseOverride) {
      const targetBase = parseBase(baseOverride) || base;
      if (!targetBase || !fetcher) {
        return { configured: false, siteUrl: EXPECTED_SITE, spaceKey: EXPECTED_SPACE, spaceId: EXPECTED_SPACE_ID, issueKey: DEFAULT_ISSUE, allowedIssues: [DEFAULT_ISSUE] };
      }
      const data = await api('GET', '/v1/w8/capabilities', { stamp, base: targetBase });
      if (data.provider !== 'atlassian-w8') throw w8Error('not_configured', 'Falsify W8 팀 제출 게이트웨이가 아닙니다.');
      const site = typeof data.siteUrl === 'string' ? data.siteUrl.replace(/\/+$/, '') : '';
      if (site !== EXPECTED_SITE || data.spaceKey !== EXPECTED_SPACE || String(data.spaceId) !== EXPECTED_SPACE_ID) {
        throw w8Error('site_not_allowed', '게이트웨이 대상 사이트가 Falsify가 아니어서 연결하지 않았습니다.');
      }
      state.caps = data;
      return data;
    }

    function clearPending() {
      if (state.pending?.timer) clearInterval(state.pending.timer);
      if (state.pending?.listener && win?.removeEventListener) win.removeEventListener('message', state.pending.listener);
      state.pending = null;
    }

    function closePopup(popup) {
      try { if (popup && popup.closed !== true && typeof popup.close === 'function') popup.close(); } catch {}
    }

    function openAuthPopup(preOpened) {
      if (preOpened) return preOpened;
      try { return win.open('about:blank', 'falsify-w8-oauth', 'popup,width=480,height=720'); } catch { return null; }
    }

    function navigateAuthPopup(popup, url) {
      if (popup.closed) throw w8Error('auth_cancelled', koreanFailure({ code: 'auth_cancelled' }));
      if (popup.opener == null || popup.opener !== win) {
        throw w8Error('auth_cancelled', '로그인 창이 이 페이지와 연결되어 있지 않아 세션을 받을 수 없습니다.');
      }
      popup.location.href = url;
    }

    function validAuthReply(data) {
      return typeof data.session === 'string' && data.session.length >= 16 &&
        data.session.length <= 8192 && Date.parse(data.expiresAt) > Date.now();
    }

    function waitForOAuthMessage(popup, nonce, stamp, expectedOrigin, authBase) {
      const origin = expectedOrigin || gatewayOrigin;
      return new Promise((resolve, reject) => {
        const finish = (err, result) => {
          clearPending();
          closePopup(popup);
          if (err) reject(err);
          else resolve(result);
        };
        const listener = async event => {
          if (state.stamp !== stamp || !state.pending || event.origin !== origin || event.source !== popup) return;
          const data = event.data;
          if (!data || data.type !== 'falsify.confluence.session.v1' || data.nonce !== nonce) return;
          if (!validAuthReply(data)) { finish(w8Error('unauthorized', '로그인 응답이 올바르지 않습니다.')); return; }
          try {
            const saved = await rememberSession(data.session, data.expiresAt, stamp, authBase);
            finish(
              saved ? null : w8Error('storage_error', '연결 정보를 브라우저에 저장하지 못했습니다.'),
              saved ? { connected: true, expiresAt: data.expiresAt, authBase: authBase || base } : null,
            );
          } catch {
            clearCachedSession();
            finish(w8Error('storage_error', '연결 정보를 브라우저에 저장하지 못했습니다.'));
          }
        };
        const timer = setInterval(() => {
          if (state.stamp !== stamp || popup.closed) finish(w8Error('auth_cancelled', koreanFailure({ code: 'auth_cancelled' })));
        }, 250);
        if (timer && typeof timer.unref === 'function') timer.unref();
        state.pending = { nonce, popup, stamp, timer, listener };
        win.addEventListener('message', listener);
      });
    }

    async function connect({ popup: preOpened, base: baseOverride, paperLibrary = false, history = false } = {}) {
      const primary = parseBase(baseOverride) || base;
      if (!primary || !fetcher) { closePopup(preOpened); throw w8Error('not_configured', koreanFailure({ code: 'not_configured' })); }
      if (!win || typeof win.open !== 'function') { closePopup(preOpened); throw w8Error('auth_required', koreanFailure({ code: 'auth_required' })); }
      const stamp = ++state.stamp;
      if (state.pending) { closePopup(state.pending.popup); clearPending(); }
      const popup = openAuthPopup(preOpened);
      if (!popup || popup.closed) throw w8Error('popup_blocked', koreanFailure({ code: 'popup_blocked' }));
      try {
        const authBase = primary;
        const caps = await capabilities(stamp, authBase);
        if (!caps.configured) throw w8Error('not_configured', koreanFailure({ code: 'not_configured' }));
        if (stamp !== state.stamp) throw w8Error('auth_cancelled', koreanFailure({ code: 'auth_cancelled' }));
        const nonce = newNonce();
        const startPath = history ? '/v1/w8/history/auth/start' : paperLibrary ? '/v1/w8/paper-auth/start' : '/v1/w8/auth/start';
        const started = await api('POST', startPath, { body: { nonce, returnOrigin: loc.origin }, stamp, base: authBase });
        if (stamp !== state.stamp) throw w8Error('auth_cancelled', koreanFailure({ code: 'auth_cancelled' }));
        navigateAuthPopup(popup, checkAuthorizeUrl(started.authorizeUrl));
        return await waitForOAuthMessage(popup, nonce, stamp, originOf(authBase), authBase);
      } catch (err) {
        closePopup(popup);
        clearPending();
        throw err;
      }
    }

    async function refreshSession() {
      await restoreSession();
      if (!isConnected()) throw w8Error('auth_required', koreanFailure({ code: 'auth_required' }));
      const stamp = state.stamp;
      const target = state.authBase;
      const refreshed = await api('POST', '/v1/w8/auth/refresh', { auth: true, stamp, base: target });
      if (typeof refreshed.session === 'string' && refreshed.expiresAt) {
        await rememberSession(refreshed.session, refreshed.expiresAt, stamp, target);
      }
      return { connected: isConnected(), expiresAt: state.session?.expiresAt || null, authBase: target };
    }

    async function paperRequest(method, path, { base: baseOverride, body, pdf = false } = {}) {
      await restoreSession();
      if (!isConnected()) throw w8Error('auth_required', koreanFailure({ code: 'auth_required' }));
      const syncBase = parseBase(baseOverride) || state.authBase;
      const stamp = state.stamp;
      const send = clearOn401 => api(method, path, { body, auth: true, stamp, base: syncBase, clearOn401, pdf });
      let result;
      try {
        result = await send(false);
      } catch (err) {
        if (err?.status !== 401 || stamp !== state.stamp) throw err;
        try {
          await refreshSession();
          result = await send(true);
        } catch (retryErr) {
          if (stamp === state.stamp && (retryErr?.status === 401 || ['unauthorized', 'session_expired', 'auth_required'].includes(retryErr?.code))) clearCachedSession();
          throw retryErr;
        }
      }
      if (stamp !== state.stamp) throw w8Error('auth_cancelled', koreanFailure({ code: 'auth_cancelled' }));
      return result;
    }

    function paperList(path, { base, cursor } = {}) {
      const query = cursor ? '?cursor=' + encodeURIComponent(cursor) : '';
      return paperRequest('GET', path + query, { base });
    }

    const listPapers = opts => paperList('/v1/w8/papers', opts);
    const listPaperAttachments = opts => paperList('/v1/w8/paper-attachments', opts);

    function getPaperAttachment(attachmentId, { base } = {}) {
      if (!/^(?:att)?\d{1,20}$/.test(String(attachmentId))) throw w8Error('invalid_request', '첨부 파일 번호가 올바르지 않습니다.');
      return paperRequest('GET', '/v1/w8/paper-attachments?attachmentId=' + encodeURIComponent(attachmentId), { base, pdf: true });
    }

    function getPaper(pageId, { base } = {}) {
      if (!/^\d+$/.test(String(pageId))) throw w8Error('invalid_request', '논문 페이지 번호가 올바르지 않습니다.');
      return paperRequest('GET', '/v1/w8/papers?pageId=' + encodeURIComponent(pageId), { base });
    }

    function historyPath(source) {
      if (source === 'jira' || source === 'confluence') return '/v1/w8/history/' + source;
      throw w8Error('invalid_request', '팀 기록 출처가 올바르지 않습니다.');
    }

    function historyList(source, opts) {
      return paperList(historyPath(source), opts);
    }

    function historyDetail(source, id, { base, attachmentCursor } = {}) {
      let path = historyPath(source) + '?id=' + encodeURIComponent(id);
      if (attachmentCursor) path += '&attachmentCursor=' + encodeURIComponent(attachmentCursor);
      return paperRequest('GET', path, { base });
    }

    function historyFile(source, id, attachment, { base } = {}) {
      const path = historyPath(source) + '?id=' + encodeURIComponent(id) + '&file=' + encodeURIComponent(attachment.id);
      return paperRequest('GET', path, { base, pdf: attachment.type === 'pdf' });
    }

    function connectHistory({ base } = {}) {
      return connect({ base, history: true });
    }

    function normalizeHistoryJiraLinkPayload(payload) {
      if (!isPlain(payload)) throw w8Error('invalid_request', 'Jira 연결 정보가 올바르지 않습니다.');
      const issueKey = String(payload.issueKey || '').trim().toUpperCase();
      if (!/^FLS-[1-9][0-9]{0,7}$/.test(issueKey)) {
        throw w8Error('issue_not_allowed', '기존 FLS 이슈 키(예: FLS-18)를 입력해 주세요.');
      }
      const pageId = String(payload.pageId || '').trim();
      if (!/^\d{1,20}$/.test(pageId)) throw w8Error('invalid_request', 'Confluence 페이지 번호가 올바르지 않습니다.');
      const patternKey = cleanStr(payload.patternKey, false);
      if (!patternKey || patternKey.length > 160) throw w8Error('invalid_request', '연결할 패턴 키가 필요합니다.');
      const body = { issueKey, pageId, patternKey };
      const patternLabel = cleanStr(payload.patternLabel, false);
      if (patternLabel) body.patternLabel = patternLabel.slice(0, 240);
      const summary = cleanStr(payload.summary, false);
      if (summary) body.summary = summary.slice(0, 400);
      const rev = optionalHex(typeof payload.revisionSha256 === 'string' ? payload.revisionSha256.trim().toLowerCase() : '');
      if (rev) body.revisionSha256 = rev;
      return body;
    }

    function parseHistoryJiraLinkResponse(res, fallback) {
      const issueUrl = allowedSiteUrl(res?.issueUrl);
      const pageUrl = allowedSiteUrl(res?.pageUrl);
      const commentId = String(res?.commentId ?? '').trim();
      if (!res?.linked || !issueUrl || !commentId) {
        throw w8Error('response', 'Jira 댓글 연결 응답이 올바르지 않습니다.');
      }
      return {
        linked: true,
        issueKey: String(res.issueKey || fallback.issueKey),
        issueUrl,
        commentId,
        pageId: String(res.pageId || fallback.pageId),
        pageUrl: pageUrl || '',
        patternHash: String(res.patternHash || ''),
        linkedPageIds: Array.isArray(res.linkedPageIds) ? res.linkedPageIds.map(String) : [fallback.pageId],
        reused: res.reused === true,
        updated: res.updated === true,
        alreadyExisted: res.alreadyExisted === true,
      };
    }

    async function historyJiraLink(payload, { base } = {}) {
      const body = normalizeHistoryJiraLinkPayload(payload);
      const res = await paperRequest('POST', '/v1/w8/history/jira-link', { base, body });
      return parseHistoryJiraLinkResponse(res, body);
    }

    async function paperSync(payload, { base } = {}) {
      const res = await paperRequest('PUT', '/v1/w8/paper-sync', { base, body: payload });
      const pageId = String(res?.pageId ?? '').trim();
      const pageUrl = allowedSiteUrl(res?.pageUrl);
      if (!pageId || !pageUrl) throw w8Error('response', 'Confluence 동기화 응답이 올바르지 않습니다.');
      return { pageId, pageUrl };
    }

    function disconnect() {
      state.stamp++;
      if (state.pending) { closePopup(state.pending.popup); clearPending(); }
      clearCachedSession();
    }

    async function refreshOrUpgrade(stamp, autoConnect, forceReconnect, onStatus) {
      try {
        const refreshed = await api('POST', '/v1/w8/auth/refresh', { auth: true, stamp });
        if (typeof refreshed.session === 'string' && refreshed.expiresAt) {
          await rememberSession(refreshed.session, refreshed.expiresAt, stamp).catch(() => {});
        }
        if (refreshed.hasJiraScope === false) {
          if (!autoConnect) throw w8Error('jira_scope_required', koreanFailure({ code: 'jira_scope_required' }));
          onStatus?.('Jira 권한을 포함해 다시 연결하는 중...');
          await connect();
        }
      } catch (err) {
        const recoverable = err?.status === 401 || err?.code === 'auth_required' || err?.code === 'jira_scope_required';
        if (recoverable && autoConnect && !forceReconnect) {
          onStatus?.('Atlassian 팀에 다시 연결하는 중...');
          await connect();
          return;
        }
        throw err;
      }
    }

    async function ensureAuth({ autoConnect = true, forceReconnect = false, onStatus, preOpenedPopup = null } = {}) {
      await restoreSession();
      if (forceReconnect || !isConnected()) {
        if (!autoConnect) { closePopup(preOpenedPopup); throw w8Error('auth_required', koreanFailure({ code: 'auth_required' })); }
        onStatus?.('Atlassian 팀 연결 중...');
        await connect({ popup: preOpenedPopup });
      } else {
        closePopup(preOpenedPopup);
      }
      await refreshOrUpgrade(state.stamp, autoConnect, forceReconnect, onStatus);
    }

    async function checkRemote({ participant, issueKey } = {}) {
      await restoreSession();
      if (!isConnected()) throw w8Error('auth_required', koreanFailure({ code: 'auth_required' }));
      const qs = new URLSearchParams({ participant: String(participant || '').trim() });
      if (issueKey) qs.set('issueKey', String(issueKey).trim().toUpperCase());
      return api('GET', '/v1/w8/status?' + qs.toString(), { auth: true });
    }

    function preOpenAuthPopup(autoConnect) {
      const hasSessionHint = isConnected() || !!storage?.getItem(SESSION_KEY);
      if (hasSessionHint || !autoConnect || !base || !fetcher || !win || typeof win.open !== 'function') return null;
      return openAuthPopup(null);
    }

    function finalizeSubmission(result, prepared, extras = {}) {
      const pageUrl = allowedSiteUrl(result.pageUrl);
      const issueUrl = allowedSiteUrl(result.issueUrl);
      if (!pageUrl || !issueUrl) throw w8Error('write_unknown', koreanFailure({ code: 'write_unknown' }));
      const completed = {
        pageUrl,
        issueUrl,
        pageId: result.pageId,
        issueKey: result.issueKey || prepared.issueKey,
        attachmentId: result.attachmentId,
        attachmentFilename: result.attachmentFilename || prepared.filename,
        attachmentUrl: allowedSiteUrl(result.attachmentUrl) || null,
        commentId: result.commentId,
        csvSha256: result.csvSha256 || prepared.csvSha256,
        archiveSha256: result.archiveSha256 || prepared.archiveSha256,
        reused: result.reused || { page: false, attachment: false, comment: false },
        alreadyExisted: result.alreadyExisted === true,
        commentUpdated: result.commentUpdated === true,
        ...extras,
      };
      saveReceipt({ participant: prepared.participant, condition: prepared.condition, ...completed, state: 'complete' });
      return completed;
    }

    async function reconcileAfterUncertainWrite(err, prepared, onStatus) {
      const uncertain = err?.code === 'timeout' || err?.code === 'network' || err?.errorCode === 'write_unknown';
      if (!uncertain || !isConnected()) return null;
      onStatus?.('원격 제출 상태를 확인하는 중...');
      try {
        const remote = await checkRemote({ participant: prepared.participant, issueKey: prepared.issueKey });
        const exactMatch = remote?.found === true &&
          remote.csvSha256 === prepared.csvSha256 &&
          remote.archiveSha256 === prepared.archiveSha256 &&
          allowedSiteUrl(remote.pageUrl) &&
          allowedSiteUrl(remote.issueUrl);
        if (!exactMatch) return null;
        return finalizeSubmission(
          { ...remote, alreadyExisted: true, commentUpdated: false, reused: { page: true, attachment: true, comment: true } },
          prepared,
          { reconciled: true },
        );
      } catch {
        return null;
      }
    }

    async function postSubmission(payload, prepared, autoConnect, onStatus) {
      const send = () => {
        onStatus?.('BLUE 보관 저장 및 Jira 제출 중...');
        return api('POST', '/v1/w8/submit', { auth: true, body: payload });
      };
      try {
        const res = await send();
        if (!res.submitted) throw w8Error('write_unknown', koreanFailure({ code: 'write_unknown' }));
        return finalizeSubmission(res, prepared);
      } catch (err) {
        if (err?.errorCode === 'jira_scope_required' && autoConnect) {
          onStatus?.('Jira 권한을 포함해 다시 연결하는 중...');
          await ensureAuth({ autoConnect: true, forceReconnect: true, onStatus });
          const retried = await send();
          if (!retried.submitted) throw w8Error('write_unknown', koreanFailure({ code: 'write_unknown' }));
          return finalizeSubmission(retried, prepared);
        }
        if (err?.progress) {
          saveReceipt({ participant: prepared.participant, condition: prepared.condition, issueKey: prepared.issueKey, ...err.progress, csvSha256: prepared.csvSha256, archiveSha256: prepared.archiveSha256, state: 'partial' });
        }
        const reconciled = await reconcileAfterUncertainWrite(err, prepared, onStatus);
        if (reconciled) return reconciled;
        throw err;
      }
    }

    async function submit({ csv, filename, participant, runs, condition, issueKey, autoConnect = true, onStatus } = {}) {
      if (state.busy) throw w8Error('busy', '이미 팀 제출이 진행 중입니다.');
      state.busy = true;
      const preOpenedPopup = preOpenAuthPopup(autoConnect);
      let popupConsumed = false;
      try {
        const caps = await capabilities();
        if (caps.configured !== true) throw w8Error('not_configured', koreanFailure({ code: 'not_configured' }));
        const prepared = await buildBlueOnlyArchive({ csv, filename, participant, runs, condition, issueKey: issueKey || caps.issueKey || DEFAULT_ISSUE });
        popupConsumed = true;
        await ensureAuth({ autoConnect, onStatus, preOpenedPopup });
        const resume = buildResumePayload(getReceipt({ participant: prepared.participant, issueKey: prepared.issueKey }));
        const payload = {
          participant: prepared.participant,
          condition: prepared.condition,
          filename: prepared.filename,
          csv,
          archive: prepared.archive,
          issueKey: prepared.issueKey,
          ...(resume ? { resume } : {}),
        };
        return await postSubmission(payload, prepared, autoConnect, onStatus);
      } finally {
        if (!popupConsumed) closePopup(preOpenedPopup);
        state.busy = false;
      }
    }

    function submitSuccessMessage(res) {
      if (res.reconciled) return '원격 상태를 확인해 완료된 제출 링크를 복구했습니다.';
      if (res.alreadyExisted) return '같은 CSV가 이미 제출되어 기존 링크를 열었습니다.';
      if (res.commentUpdated) return '변경된 CSV를 첨부하고 기존 댓글을 갱신했습니다.';
      if (res.reused?.page || res.reused?.attachment) return '중단된 지점부터 이어서 제출을 마쳤습니다.';
      return `제출했습니다. Confluence 보관과 ${res.issueKey} 댓글을 연결했습니다.`;
    }

    function mount(host, options = {}) {
      if (!host || !doc) return null;
      const getPayload = typeof options.getPayload === 'function' ? options.getPayload : () => null;
      const onSubmitted = typeof options.onSubmitted === 'function' ? options.onSubmitted : null;

      const section = doc.createElement('section');
      section.className = 'w8-team-panel';
      section.setAttribute('data-w8-team', 'true');

      const heading = doc.createElement('h3');
      heading.textContent = '팀에 제출';
      const scopeLine = doc.createElement('p');
      scopeLine.className = 'w8-team-scope muted';
      const actions = doc.createElement('div');
      actions.className = 'button-row';
      const submitBtn = doc.createElement('button');
      submitBtn.type = 'button';
      submitBtn.className = 'button primary';
      submitBtn.textContent = '팀에 제출';
      const disconnectBtn = doc.createElement('button');
      disconnectBtn.type = 'button';
      disconnectBtn.className = 'button secondary';
      disconnectBtn.textContent = '연결 끊기';
      disconnectBtn.hidden = true;
      actions.append(submitBtn, disconnectBtn);

      const statusEl = doc.createElement('p');
      statusEl.className = 'w8-team-status';
      statusEl.setAttribute('role', 'status');
      const linksEl = doc.createElement('div');
      linksEl.className = 'w8-team-links';
      section.append(heading, scopeLine, actions, statusEl, linksEl);
      host.append(section);

      function renderLinks(res) {
        linksEl.replaceChildren();
        for (const [url, label] of [[allowedSiteUrl(res?.pageUrl), 'Confluence 실험 보기'], [allowedSiteUrl(res?.issueUrl), 'Jira 댓글 보기']]) {
          if (!url) continue;
          const a = doc.createElement('a');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = label;
          linksEl.append(a);
        }
      }

      function paint() {
        submitBtn.disabled = state.busy;
        disconnectBtn.hidden = !isConnected();
        disconnectBtn.disabled = state.busy;
        const current = getPayload();
        const issue = current?.issueKey || state.caps?.issueKey || options.issueKey || DEFAULT_ISSUE;
        const runCount = Array.isArray(current?.runs) ? current.runs.length : 0;
        const fileLabel = current?.filename ? ` · ${current.filename}` : '';
        scopeLine.textContent = `대상: ${EXPECTED_SPACE} 공간 · Jira ${issue} · 선택한 실행 ${runCount}건${fileLabel} · BLUE 결과와 인용만 전송(원본 PDF·RED 정답 제외)`;
      }

      submitBtn.addEventListener('click', async () => {
        const payload = getPayload();
        if (!payload) {
          statusEl.textContent = '제출할 CSV와 BLUE 실행을 먼저 준비하세요.';
          statusEl.classList.add('error');
          return;
        }
        statusEl.classList.remove('error');
        statusEl.textContent = '제출 준비 중...';
        paint();
        try {
          const res = await submit({ ...payload, onStatus: msg => { statusEl.textContent = msg; } });
          renderLinks(res);
          statusEl.textContent = submitSuccessMessage(res);
          onSubmitted?.(res);
        } catch (err) {
          statusEl.textContent = koreanFailure(err);
          statusEl.classList.add('error');
        } finally {
          paint();
        }
      });

      disconnectBtn.addEventListener('click', () => {
        disconnect();
        statusEl.classList.remove('error');
        statusEl.textContent = '이 브라우저의 Atlassian 연결을 끊었습니다. 로컬 작업과 CSV는 그대로입니다.';
        paint();
      });

      paint();
      void restoreSession().then(() => paint());
      return { section, paint, renderLinks, submitBtn, disconnectBtn, statusEl, linksEl };
    }

    return {
      capabilities,
      connect,
      disconnect,
      isConnected,
      restoreSession,
      refreshSession,
      listPapers,
      listPaperAttachments,
      historyList, historyDetail, historyFile, connectHistory, historyJiraLink,
      getPaperAttachment,
      getPaper,
      paperSync,
      checkRemote,
      submit,
      buildArchive: buildBlueOnlyArchive,
      receipt: getReceipt,
      receipts: readReceipts,
      status: () => ({
        configured: state.caps?.configured ?? null,
        connected: isConnected(),
        expiresAt: state.session?.expiresAt || null,
        authBase: state.authBase || base || null,
        siteUrl: EXPECTED_SITE,
        spaceKey: EXPECTED_SPACE,
        issueKey: state.caps?.issueKey || DEFAULT_ISSUE,
        receipts: readReceipts(),
      }),
      mount,
    };
  }

  let defaultInstance = null;
  function instance() {
    if (!defaultInstance) defaultInstance = create();
    return defaultInstance;
  }

  return {
    create,
    buildArchive: buildBlueOnlyArchive,
    submit: args => instance().submit(args),
    capabilities: () => instance().capabilities(),
    connect: args => instance().connect(args),
    disconnect: () => instance().disconnect(),
    isConnected: () => instance().isConnected(),
    restoreSession: () => instance().restoreSession(),
    refreshSession: args => instance().refreshSession(args),
    listPapers: opts => instance().listPapers(opts),
    listPaperAttachments: opts => instance().listPaperAttachments(opts),
    historyList: (source, opts) => instance().historyList(source, opts),
    historyDetail: (source, id, opts) => instance().historyDetail(source, id, opts),
    historyFile: (source, id, attachment, opts) => instance().historyFile(source, id, attachment, opts),
    connectHistory: opts => instance().connectHistory(opts),
    historyJiraLink: (payload, opts) => instance().historyJiraLink(payload, opts),
    getPaperAttachment: (id, opts) => instance().getPaperAttachment(id, opts),
    getPaper: (id, opts) => instance().getPaper(id, opts),
    paperSync: (payload, opts) => instance().paperSync(payload, opts),
    checkRemote: args => instance().checkRemote(args),
    receipt: args => instance().receipt(args),
    receipts: () => instance().receipts(),
    status: () => instance().status(),
    mount: (host, options) => instance().mount(host, options),
  };
});
