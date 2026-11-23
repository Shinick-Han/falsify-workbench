/* Automatic Workbench -> Confluence paper sync client (window.FalsifyW8PaperSync).
   Reuses FalsifyW8Team's per-user Atlassian OAuth encrypted session without auto-popups,
   manual submit buttons, guest/operator publishing, or Jira writes. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.FalsifyW8PaperSync = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  const STORAGE_KEY = 'falsify.w8-paper-sync.v1';
  const EXPECTED_SITE = 'https://falsify.atlassian.net';
  const HEX64 = /^[0-9a-f]{64}$/;
  const DRIVE_ID = /^[A-Za-z0-9_-]{10,180}$/;
  const DEFAULT_EDIT_DEBOUNCE_MS = 700;
  const DEFAULT_RETRY_DELAY_MS = 2000;
  const MAX_AUTO_RETRIES = 2;
  const UNKNOWN_MODELS = new Set(['manual-model-unverified', 'unknown', '미확인', '모델 미상']);
  const SYNC_ERROR_COPY = {
    not_configured: 'Confluence 자동 동기화 서버가 아직 설정되지 않았어요.',
    permission_denied: '이 Atlassian 계정에 Falsify Confluence 쓰기 권한이 없어요.',
    origin_not_allowed: 'Confluence 연결이 허용되지 않은 Workbench 주소예요.',
    network: 'Confluence 서버에 연결할 수 없어요. 네트워크 연결을 확인해 주세요.',
    timeout: 'Confluence 응답이 지연되고 있어요.',
    upstream_unavailable: 'Confluence 서버가 응답하지 않아요.',
    site_not_allowed: 'Falsify Confluence 공간 설정을 확인해 주세요.',
    space_not_allowed: 'Falsify Confluence 공간 설정을 확인해 주세요.',
    parent_not_allowed: 'Falsify Confluence 공간 설정을 확인해 주세요.',
    rate_limited: '요청이 많아 잠시 기다린 뒤 다시 동기화해요.',
    payload_too_large: '동기화 크기가 한도를 넘었어요.',
    popup_blocked: '로그인 팝업이 차단됐어요. 이 사이트의 팝업을 허용한 뒤 Confluence 연결을 다시 눌러 주세요.',
    auth_cancelled: 'Confluence 연결을 취소했어요.',
  };

  function isObj(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isPlain(value) {
    if (!isObj(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === null || Object.getPrototypeOf(proto) === null;
  }

  function strVal(value) {
    return typeof value === 'string' ? value : '';
  }

  function setIfPresent(target, key, value) {
    if (value) target[key] = value;
  }

  function normalizeSha(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim().toLowerCase();
    return HEX64.test(text) ? text : '';
  }

  function cleanDriveId(value) {
    return typeof value === 'string' && DRIVE_ID.test(value) ? value : '';
  }

  function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }

  function parseBase(value, locationHref) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const u = locationHref ? new URL(value, locationHref) : new URL(value);
      const allowed = u.protocol === 'https:' || (isLoopbackHost(u.hostname) && u.protocol === 'http:');
      if (!allowed || u.username || u.password || u.search || u.hash) return '';
      return u.origin + u.pathname.replace(/\/+$/, '');
    } catch {
      return '';
    }
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

  function cleanStr(value, multiline, maxLen) {
    if (value === null || value === undefined) return '';
    const raw = String(value).replace(/\u0000/g, '').trim();
    const cleaned = multiline
      ? raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      : raw.replace(/[\u0000-\u001f\u007f]/g, ' ');
    if (cleaned.includes('%PDF-')) {
      const err = new Error('원본 PDF 바이너리는 Confluence 동기화에 포함할 수 없습니다.');
      err.code = 'forbidden_content';
      throw err;
    }
    return maxLen && cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    if (isPlain(value)) {
      return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function isBlueRun(run) {
    if (!isObj(run)) return false;
    if (typeof run.role === 'string' && run.role.toLowerCase() === 'red') return false;
    if (typeof run.snapshot?.role === 'string' && run.snapshot.role.toLowerCase() === 'red') return false;
    return true;
  }

  function firstBatchModel(run) {
    const batches = run?.snapshot?.batches;
    if (!Array.isArray(batches)) return '';
    const hit = batches.find(b => isObj(b) && typeof b.model === 'string' && b.model.trim());
    return hit ? hit.model : '';
  }

  function resolveModel(run) {
    const candidates = [run?.model, run?.response?.model, run?.result?.model, run?.harness?.adapter?.model, firstBatchModel(run)];
    for (const candidate of candidates) {
      const value = cleanStr(candidate, false, 200);
      if (value && !UNKNOWN_MODELS.has(value.toLowerCase()) && !UNKNOWN_MODELS.has(value)) return value;
    }
    return '';
  }

  function resolveCreatedAt(run) {
    const value = cleanStr(run?.createdAt, false, 64);
    return value && Number.isFinite(Date.parse(value)) ? value : '';
  }

  function extractRawFindings(run) {
    if (Array.isArray(run?.findings)) return run.findings;
    if (Array.isArray(run?.response?.findings)) return run.response.findings;
    if (Array.isArray(run?.result?.findings)) return run.result.findings;
    if (Array.isArray(run?.snapshot?.items)) {
      return run.snapshot.items.filter(item => isObj(item) && item.kind !== 'change' && item.enabled !== false);
    }
    if (Array.isArray(run?.items)) return run.items;
    return [];
  }

  function resolveFindingPage(raw) {
    if (Number.isSafeInteger(raw.page) && raw.page >= 1) return raw.page;
    if (Number.isSafeInteger(raw.pageIndex) && raw.pageIndex >= 0) return raw.pageIndex + 1;
    return null;
  }

  function sanitizeFinding(raw) {
    if (!isObj(raw)) return null;
    const out = {};
    setIfPresent(out, 'id', cleanStr(raw.id, false, 200));
    const page = resolveFindingPage(raw);
    if (page !== null) out.page = page;
    setIfPresent(out, 'locationLabel', cleanStr(raw.locationLabel ?? raw.location, false, 200));
    setIfPresent(out, 'findingType', cleanStr(raw.findingType ?? raw.defectFamily, false, 128));
    setIfPresent(out, 'confidence', cleanStr(raw.confidence, false, 128));
    setIfPresent(out, 'quote', cleanStr(raw.quote ?? raw.sourceQuote, true));
    setIfPresent(out, 'rationale', cleanStr(raw.rationale ?? raw.reason ?? raw.description, true));
    setIfPresent(out, 'severity', cleanStr(raw.severity, false, 128));
    setIfPresent(out, 'verdict', cleanStr(raw.verdict ?? raw.verdictLabel, false, 128));
    return out;
  }

  function resolveHashForRun(rawHash, sourceSha256, allowedHashes) {
    const sha = normalizeSha(rawHash);
    if (!sha || !allowedHashes.has(sha)) return { ok: false, revisionSha256: null };
    return { ok: true, revisionSha256: sha === sourceSha256 ? null : sha };
  }

  function resolveRunRevision(run, sourceSha256, defaultRevision, allowedHashes) {
    if (typeof run.fileHash === 'string' && run.fileHash.trim()) {
      return resolveHashForRun(run.fileHash, sourceSha256, allowedHashes);
    }
    if (run.revisionSha256 === null || run.revisionSha256 === '') {
      return { ok: true, revisionSha256: null };
    }
    if (run.revisionSha256 !== undefined) {
      return resolveHashForRun(run.revisionSha256, sourceSha256, allowedHashes);
    }
    return { ok: true, revisionSha256: defaultRevision || null };
  }

  function sanitizeRun(run, ctx) {
    if (!isBlueRun(run)) return null;
    const rev = resolveRunRevision(run, ctx.sourceSha256, ctx.revisionSha256, ctx.allowedHashes);
    if (!rev.ok) return null;
    const id = cleanStr(run.id, false, 200);
    const dedupeKey = `${rev.revisionSha256 || 'source'}::${id}`;
    if (!id || ctx.seenKeys.has(dedupeKey)) return null;
    ctx.seenKeys.add(dedupeKey);
    const findings = extractRawFindings(run).map(sanitizeFinding).filter(Boolean);
    const entry = { id, revisionSha256: rev.revisionSha256, findings };
    setIfPresent(entry, 'model', resolveModel(run));
    setIfPresent(entry, 'createdAt', resolveCreatedAt(run));
    return entry;
  }

  function buildPayload(input) {
    const src = isObj(input) ? input : {};
    const sourceSha256 = normalizeSha(src.sourceSha256);
    if (!sourceSha256) {
      const err = new Error('유효한 원문 SHA-256이 필요합니다.');
      err.code = 'invalid_source';
      throw err;
    }
    const rawRevision = normalizeSha(src.revisionSha256);
    const revisionSha256 = rawRevision && rawRevision !== sourceSha256 ? rawRevision : '';
    const allowedHashes = new Set([sourceSha256, revisionSha256, normalizeSha(src.artifactSha256)].filter(Boolean));
    const ctx = { sourceSha256, revisionSha256, allowedHashes, seenKeys: new Set() };
    const sanitizedRuns = Array.isArray(src.runs) ? src.runs.map(r => sanitizeRun(r, ctx)).filter(Boolean) : [];
    const payload = { sourceSha256, title: cleanStr(src.title, false, 240) || 'Untitled paper' };
    setIfPresent(payload, 'arxivId', cleanStr(src.arxivId, false, 64));
    setIfPresent(payload, 'revisionSha256', revisionSha256);
    if (sanitizedRuns.length) payload.runs = sanitizedRuns;
    return payload;
  }

  function payloadSignature(payload) {
    return canonicalJson(payload);
  }

  function readSearchDataset(doc, prop, attr) {
    if (!doc || typeof doc.getElementById !== 'function') return '';
    const el = doc.getElementById('w8-search');
    if (!el) return '';
    if (el.dataset && typeof el.dataset[prop] === 'string' && el.dataset[prop]) return el.dataset[prop];
    if (typeof el.getAttribute === 'function') return el.getAttribute(attr) || '';
    return '';
  }

  function resolveSyncBase(doc, fallbackBase, locationHref) {
    const searchBase = parseBase(readSearchDataset(doc, 'syncBase', 'data-sync-base') || readSearchDataset(doc, 'apiBase', 'data-api-base'), locationHref);
    if (searchBase) return searchBase;
    return parseBase(fallbackBase || root?.FalsifyCloudConfig?.apiBase || '', locationHref);
  }

  function resolveAuthBase(doc, fallbackBase, locationHref) {
    const explicit = parseBase(readSearchDataset(doc, 'authBase', 'data-auth-base'), locationHref);
    if (explicit) return explicit;
    return resolveSyncBase(doc, fallbackBase, locationHref);
  }

  function syncErrorMessage(err, fallback = 'Confluence에 기록하지 못했어요. 편집은 이어갈 수 있어요.') {
    const code = err?.errorCode || err?.code || '';
    if (Object.hasOwn(SYNC_ERROR_COPY, code)) return SYNC_ERROR_COPY[code];
    if (err?.status === 429) return SYNC_ERROR_COPY.rate_limited;
    if (err?.status === 413) return SYNC_ERROR_COPY.payload_too_large;
    return fallback;
  }

  function isAuthFailure(err) {
    const code = err?.errorCode || err?.code || '';
    return err?.status === 401 || code === 'unauthorized' || code === 'session_expired' || code === 'auth_required';
  }

  function isTransientFailure(err) {
    const code = err?.errorCode || err?.code || '';
    return code === 'network' || code === 'timeout' || code === 'rate_limited' || err?.status === 429 || (Number(err?.status) >= 500 && Number(err?.status) < 600);
  }

  function defaultLocalStorage() {
    try { return root?.localStorage || null; } catch { return null; }
  }

  function resolveEnvDeps(options) {
    const doc = options.document || root?.document || null;
    const win = options.window || root?.window || root || null;
    return {
      doc,
      win,
      storage: options.storage !== undefined ? options.storage : defaultLocalStorage(),
      setT: options.setTimeout || ((fn, ms) => root.setTimeout(fn, ms)),
      clearT: options.clearTimeout || (id => root.clearTimeout(id)),
      nowIso: () => new Date(typeof options.now === 'function' ? options.now() : Date.now()).toISOString(),
      locationHref: options.locationHref || win?.location?.href || '',
    };
  }

  function resolveRuntimeDeps(options) {
    return {
      paper: options.paper || root?.FalsifyW8Paper || null,
      paperLinksOf: () => options.paperLinks || root?.FalsifyW8PaperLinks || null,
      blue: options.blue || root?.FalsifyW8Blue || null,
      team: options.team || root?.FalsifyW8Team || null,
      editDebounceMs: Number.isFinite(options.editDebounceMs) ? options.editDebounceMs : DEFAULT_EDIT_DEBOUNCE_MS,
      retryDelayMs: Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS,
    };
  }

  function querySyncNodes(doc, host) {
    const byId = id => (typeof doc?.getElementById === 'function' ? doc.getElementById(id) : null);
    return {
      root: host || byId('w8-sync'),
      status: byId('w8-sync-status'),
      link: byId('w8-sync-link'),
      connect: byId('w8-sync-connect'),
      retry: byId('w8-sync-retry'),
      disconnect: byId('w8-sync-disconnect'),
    };
  }

  function addRunIdsFromList(target, list) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const rid = cleanStr(item?.id, false, 200);
      if (rid) target.add(rid);
    }
  }

  function collectStorageRunIds(storage, target) {
    if (typeof storage?.getItem !== 'function') return;
    for (const key of ['falsify.w8-blue.runs.v1', 'falsify.experiment-ledger.v1']) {
      try {
        const parsed = JSON.parse(storage.getItem(key) || 'null');
        const lists = Array.isArray(parsed) ? [parsed] : [parsed?.runs, parsed?.externalResponses];
        lists.forEach(list => addRunIdsFromList(target, list));
      } catch {}
    }
  }

  function collectRecentBlueRunIds(paper, blue, target) {
    if (typeof paper?.recent !== 'function' || typeof blue?.runs !== 'function') return;
    try {
      for (const rec of paper.recent()) {
        for (const h of [rec?.fileHash, rec?.lastArtifactSha256]) {
          const sha = normalizeSha(h);
          if (sha) addRunIdsFromList(target, blue.runs(sha));
        }
      }
    } catch {}
  }

  function createDocState(sha, info, st) {
    const samePaper = Boolean(st && normalizeSha(st.sourceSha256) === sha);
    const cachedArtSha = samePaper ? normalizeSha(st.artifact?.sha256) : '';
    const hasEdits = Boolean(samePaper && st.hasEdits);
    const rawTitle = info.title || info.file?.name || st?.name;
    return {
      sourceSha256: sha,
      title: cleanStr(rawTitle, false, 240) || 'Untitled paper',
      arxivId: cleanStr(info.arxivId, false, 64),
      revisionSha256: hasEdits && cachedArtSha && cachedArtSha !== sha ? cachedArtSha : '',
      artifactSha256: cachedArtSha,
      opened: Boolean(info.opened),
      knownRunIds: new Set(),
      pendingEdit: false,
      pendingSyncOnRestore: false,
      pendingLinkRefresh: false,
      syncing: false,
      failed: false,
      authExpired: false,
      retryCount: 0,
      message: '',
    };
  }

  function computeSyncState(connected, connecting, active, rec, pageUrl) {
    if (connecting) return 'connecting';
    if (!connected) return active?.authExpired ? 'expired' : 'disconnected';
    if (active?.failed) return 'error';
    if (active?.syncing) return 'syncing';
    return pageUrl && !rec?.dirty ? 'synced' : 'connected';
  }

  function paintLinkNode(linkNode, pageUrl, title) {
    if (!linkNode) return;
    linkNode.hidden = !pageUrl;
    if (pageUrl) {
      linkNode.href = pageUrl;
      linkNode.setAttribute('aria-label', title ? `${title} Confluence 페이지 열기` : 'Confluence 페이지 열기');
    } else {
      linkNode.removeAttribute('href');
      linkNode.removeAttribute('aria-label');
    }
  }

  function paintButtons(nodes, connected, connecting, active) {
    if (nodes.connect) {
      nodes.connect.hidden = connected;
      nodes.connect.disabled = connecting;
    }
    if (nodes.retry) {
      nodes.retry.hidden = !connected || !active?.failed;
      nodes.retry.disabled = !!active?.syncing;
    }
    if (nodes.disconnect) {
      nodes.disconnect.hidden = !connected;
      nodes.disconnect.disabled = connecting;
    }
  }

  function matchesKnownHash(docState, eventHash) {
    return eventHash === docState.sourceSha256
      || eventHash === docState.revisionSha256
      || eventHash === docState.artifactSha256;
  }

  function isCleanMatch(existing, sig, force) {
    return Boolean(!force && existing && !existing.dirty && existing.lastSyncedSignature === sig && existing.pageUrl);
  }

  function normalizeRecord(sha, entry, locationHref, updatedAtFallback) {
    return {
      sourceSha256: sha,
      apiBase: parseBase(strVal(entry.apiBase), locationHref),
      pageId: strVal(entry.pageId),
      pageUrl: allowedSiteUrl(entry.pageUrl),
      lastSyncedSignature: strVal(entry.lastSyncedSignature),
      pendingSignature: strVal(entry.pendingSignature),
      dirty: entry.dirty === true,
      updatedAt: strVal(entry.updatedAt) || updatedAtFallback,
    };
  }

  function mount(options = {}) {
    const env = resolveEnvDeps(options);
    const rt = resolveRuntimeDeps(options);
    const { doc, win, storage, setT, clearT, nowIso, locationHref } = env;
    const { paper, paperLinksOf, blue, team, editDebounceMs, retryDelayMs } = rt;
    const nodes = querySyncNodes(doc, options.host);

    const touchedInSession = new Set();
    const preExistingRunIds = new Set();
    const inFlight = new Map();
    const queuedResync = new Map();
    const listeners = [];
    let active = null;
    let restored = false;
    let connecting = false;
    let noticeOverride = '';
    let editTimer = null;
    let retryTimer = null;
    let destroyed = false;

    collectStorageRunIds(storage, preExistingRunIds);
    collectRecentBlueRunIds(paper, blue, preExistingRunIds);

    function configBase() {
      return parseBase(options.configBase ?? root?.FalsifyCloudConfig?.apiBase ?? '', locationHref);
    }

    function currentSyncBase() {
      if (Object.hasOwn(options, 'apiBase')) {
        const raw = typeof options.apiBase === 'function' ? options.apiBase() : options.apiBase;
        return parseBase(raw, locationHref);
      }
      return resolveSyncBase(doc, configBase(), locationHref);
    }

    function currentAuthBase() {
      if (Object.hasOwn(options, 'authBase')) {
        const raw = typeof options.authBase === 'function' ? options.authBase() : options.authBase;
        return parseBase(raw, locationHref);
      }
      return resolveAuthBase(doc, configBase(), locationHref);
    }

    function isConnected() {
      return !!(team && typeof team.isConnected === 'function' && team.isConnected());
    }

    function readStore() {
      if (typeof storage?.getItem !== 'function') return {};
      try {
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
        return isPlain(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    function writeStore(map) {
      if (typeof storage?.setItem !== 'function') return;
      try { storage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch {}
    }

    function readRecord(sourceSha256, apiBase) {
      const sha = normalizeSha(sourceSha256);
      if (!sha) return null;
      const entry = readStore()[sha];
      if (!isPlain(entry) || entry.sourceSha256 !== sha) return null;
      if (apiBase && entry.apiBase && entry.apiBase !== apiBase) return null;
      return normalizeRecord(sha, entry, locationHref, '');
    }

    function saveRecord(entry) {
      const sha = normalizeSha(entry?.sourceSha256);
      if (!sha) return;
      const map = readStore();
      map[sha] = normalizeRecord(sha, entry, locationHref, nowIso());
      writeStore(map);
    }

    function emitSyncEvent(detail) {
      const EventCtor = options.CustomEvent || root?.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
      if (typeof doc?.dispatchEvent !== 'function' || !EventCtor) return;
      try { doc.dispatchEvent(new EventCtor('falsify:w8-paper-sync', { detail })); } catch {}
    }

    function clearTimers() {
      if (editTimer !== null) { clearT(editTimer); editTimer = null; }
      if (retryTimer !== null) { clearT(retryTimer); retryTimer = null; }
    }

    function collectRunsFor(docState, extraRuns, extraHash) {
      const hashes = [...new Set([docState.sourceSha256, docState.revisionSha256, docState.artifactSha256].filter(Boolean))];
      const allowed = new Set(hashes);
      const collected = [];
      const seen = new Set();

      function appendList(list, expectedHash) {
        if (!Array.isArray(list)) return;
        for (const run of list) {
          if (!isBlueRun(run)) continue;
          const runHash = normalizeSha(run.fileHash) || expectedHash;
          if (!runHash || !allowed.has(runHash)) continue;
          const id = cleanStr(run.id, false, 200);
          const key = `${runHash}::${id}`;
          if (!id || seen.has(key)) continue;
          seen.add(key);
          collected.push(normalizeSha(run.fileHash) === runHash ? run : Object.assign({}, run, { fileHash: runHash }));
        }
      }

      if (typeof blue?.runs === 'function') {
        for (const hash of hashes) {
          try { appendList(blue.runs(hash), hash); } catch {}
        }
      }
      if (Array.isArray(extraRuns) && extraHash && allowed.has(extraHash)) {
        appendList(extraRuns, extraHash);
      }
      return collected;
    }

    function disconnectedCopy() {
      if (active?.authExpired && active.message) return active.message;
      return noticeOverride || 'Confluence에 연결하면 지금 연 논문과 이후의 수정본·BLUE 결과가 Falsify 팀 공간에 기록돼요.';
    }

    function statusCopy(rec) {
      if (connecting) return 'Confluence에 연결하는 중…';
      if (!isConnected()) return disconnectedCopy();
      if (!active) return noticeOverride || 'Confluence 연결됨 · 논문과 BLUE 결과를 Falsify 팀 공간에 자동 기록해요.';
      if (active.failed && active.message) return active.message;
      if (active.syncing) return 'Confluence에 자동 동기화하는 중…';
      if (rec?.pageUrl && !rec.dirty) return 'Confluence에 기록했어요.';
      return 'Confluence 연결됨 · 논문과 BLUE 결과를 Falsify 팀 공간에 자동 기록해요.';
    }

    function paint() {
      if (destroyed) return;
      const connected = isConnected();
      const rec = active ? readRecord(active.sourceSha256, currentSyncBase()) : null;
      const pageUrl = active && rec ? allowedSiteUrl(rec.pageUrl) : '';
      if (nodes.status) {
        nodes.status.textContent = statusCopy(rec);
        nodes.status.classList?.toggle?.('is-error', Boolean(active?.failed || active?.authExpired));
      }
      paintLinkNode(nodes.link, pageUrl, active?.title);
      paintButtons(nodes, connected, connecting, active);
      if (nodes.root) nodes.root.dataset.syncState = computeSyncState(connected, connecting, active, rec, pageUrl);
    }

    async function resolveArtifactFor(docState) {
      if (typeof paper?.state !== 'function') return;
      const st = paper.state();
      if (!st || normalizeSha(st.sourceSha256) !== docState.sourceSha256) return;
      if (!st.hasEdits) {
        docState.revisionSha256 = '';
        const cachedSha = normalizeSha(st.artifact?.sha256);
        if (cachedSha) docState.artifactSha256 = cachedSha;
        return;
      }
      if (typeof paper.artifact !== 'function') return;
      const art = await paper.artifact();
      if (!art || normalizeSha(art.sourceSha256) !== docState.sourceSha256) return;
      const artSha = normalizeSha(art.sha256);
      if (!artSha) return;
      docState.artifactSha256 = artSha;
      docState.revisionSha256 = artSha !== docState.sourceSha256 ? artSha : '';
    }

    function attachDriveIds(payload) {
      const links = paperLinksOf();
      const sourceId = cleanDriveId(links?.driveId?.(payload.sourceSha256));
      const revisionId = payload.revisionSha256 ? cleanDriveId(links?.driveId?.(payload.revisionSha256)) : '';
      if (sourceId) payload.sourceDriveId = sourceId;
      if (revisionId) payload.revisionDriveId = revisionId;
      return payload;
    }

    async function prepareSyncPayload(docState, opts) {
      if (opts.includeArtifactIfEdited && !opts.background && active === docState) {
        try { await resolveArtifactFor(docState); } catch { return null; }
      }
      const runs = collectRunsFor(docState, opts.extraRuns, opts.extraHash);
      addRunIdsFromList(docState.knownRunIds, runs);
      return attachDriveIds(buildPayload({
        sourceSha256: docState.sourceSha256,
        title: docState.title,
        arxivId: docState.arxivId,
        revisionSha256: docState.revisionSha256,
        artifactSha256: docState.artifactSha256,
        runs,
      }));
    }

    function markSynced(docState, syncBase, sig, res) {
      saveRecord({
        sourceSha256: docState.sourceSha256,
        apiBase: syncBase,
        pageId: res.pageId,
        pageUrl: res.pageUrl,
        lastSyncedSignature: sig,
        pendingSignature: '',
        dirty: false,
      });
      Object.assign(docState, { syncing: false, failed: false, authExpired: false, retryCount: 0, message: '' });
      if (active === docState) paint();
      emitSyncEvent({ sourceSha256: docState.sourceSha256, pageId: res.pageId, pageUrl: res.pageUrl, status: 'synced' });
    }

    function scheduleTransientRetry(docState) {
      if (active !== docState || destroyed || docState.retryCount >= MAX_AUTO_RETRIES) return;
      docState.retryCount += 1;
      if (retryTimer !== null) clearT(retryTimer);
      retryTimer = setT(() => {
        retryTimer = null;
        if (!destroyed && active === docState && docState.failed && isConnected()) {
          void syncPaper(docState, { includeArtifactIfEdited: true, force: true });
        }
      }, retryDelayMs * docState.retryCount);
    }

    function handleSyncError(docState, err) {
      docState.syncing = false;
      if (isAuthFailure(err)) {
        docState.authExpired = true;
        docState.failed = false;
        docState.message = 'Confluence 연결이 만료됐어요. 다시 연결하면 이어서 자동 기록돼요.';
      } else {
        docState.failed = true;
        docState.message = syncErrorMessage(err);
        if (isTransientFailure(err)) scheduleTransientRetry(docState);
      }
      if (active === docState) paint();
      emitSyncEvent({ sourceSha256: docState.sourceSha256, status: docState.authExpired ? 'expired' : 'error', code: err?.code || 'error' });
    }

    async function executeSync(docState, opts, syncBase) {
      const payload = await prepareSyncPayload(docState, opts);
      if (!payload) return null;
      const sig = payloadSignature(payload);
      const existing = readRecord(docState.sourceSha256, syncBase);
      if (isCleanMatch(existing, sig, opts.force)) {
        Object.assign(docState, { syncing: false, failed: false, authExpired: false, message: '' });
        if (active === docState) paint();
        return { pageId: existing.pageId, pageUrl: existing.pageUrl, skipped: true };
      }
      saveRecord({
        sourceSha256: docState.sourceSha256,
        apiBase: syncBase,
        pageId: existing?.pageId || '',
        pageUrl: existing?.pageUrl || '',
        lastSyncedSignature: existing?.lastSyncedSignature || '',
        pendingSignature: sig,
        dirty: true,
      });
      docState.syncing = true;
      if (active === docState) paint();
      try {
        const res = await team.paperSync(payload, { base: syncBase, authBase: currentAuthBase() });
        markSynced(docState, syncBase, sig, res);
        return res;
      } catch (err) {
        handleSyncError(docState, err);
        return null;
      }
    }

    async function syncPaper(docState, opts = {}) {
      if (destroyed || !docState || typeof team?.paperSync !== 'function') return null;
      if (!isConnected()) { paint(); return null; }
      const syncBase = currentSyncBase();
      if (!syncBase) return null;

      if (inFlight.has(docState.sourceSha256)) {
        queuedResync.set(docState.sourceSha256, { docState, opts: Object.assign({}, opts, { background: active !== docState }) });
        return inFlight.get(docState.sourceSha256);
      }

      const job = executeSync(docState, opts, syncBase);
      inFlight.set(docState.sourceSha256, job);
      try {
        return await job;
      } finally {
        if (inFlight.get(docState.sourceSha256) === job) inFlight.delete(docState.sourceSha256);
        const queued = queuedResync.get(docState.sourceSha256);
        if (queued) {
          queuedResync.delete(docState.sourceSha256);
          if (!destroyed && isConnected()) void syncPaper(queued.docState, queued.opts);
        }
      }
    }

    function triggerInitialSync(docState, rec) {
      const force = Boolean(!docState.opened && rec?.dirty);
      if (!docState.opened && !force) return;
      if (!restored) { docState.pendingSyncOnRestore = true; return; }
      if (!isConnected()) return;
      if (docState.opened) touchedInSession.add(docState.sourceSha256);
      void syncPaper(docState, { includeArtifactIfEdited: true, force });
    }

    function show(info = {}) {
      if (destroyed) return;
      const sha = normalizeSha(info.sourceSha256);
      if (sha && active?.sourceSha256 === sha) {
        active.title = cleanStr(info.title, false, 240) || active.title;
        active.arxivId = cleanStr(info.arxivId, false, 64) || active.arxivId;
        if (info.opened && !active.opened) {
          active.opened = true;
          triggerInitialSync(active, readRecord(sha, currentSyncBase()));
        }
        paint();
        return;
      }
      clearTimers();
      if (!sha) { active = null; paint(); return; }
      const st = typeof paper?.state === 'function' ? paper.state() : null;
      const docState = createDocState(sha, info, st);
      addRunIdsFromList(docState.knownRunIds, collectRunsFor(docState));
      active = docState;
      triggerInitialSync(docState, readRecord(sha, currentSyncBase()));
      paint();
    }

    function edited() {
      if (destroyed || !active) return;
      const docState = active;
      docState.revisionSha256 = '';
      docState.artifactSha256 = '';
      docState.retryCount = 0;
      clearTimers();
      if (!restored) {
        docState.pendingEdit = true;
        docState.pendingSyncOnRestore = true;
        paint();
        return;
      }
      if (!isConnected()) {
        docState.pendingEdit = false;
        paint();
        return;
      }
      touchedInSession.add(docState.sourceSha256);
      docState.pendingEdit = true;
      editTimer = setT(() => {
        editTimer = null;
        if (destroyed || active !== docState) return;
        docState.pendingEdit = false;
        void syncPaper(docState, { includeArtifactIfEdited: true });
      }, editDebounceMs);
      paint();
    }

    async function beforeSwitch() {
      if (destroyed || !active) return;
      const docState = active;
      const hadPendingEdit = docState.pendingEdit;
      docState.pendingEdit = false;
      clearTimers();
      if (!hadPendingEdit || !isConnected()) return;
      try { await resolveArtifactFor(docState); } catch { return; }
      void syncPaper(docState, { includeArtifactIfEdited: false, background: true });
    }

    async function matchViaFreshArtifact(docState, eventHash) {
      if (typeof paper?.artifact !== 'function') return false;
      try {
        const art = await paper.artifact();
        if (destroyed || active !== docState) return false;
        if (normalizeSha(art?.sourceSha256) !== docState.sourceSha256 || normalizeSha(art?.sha256) !== eventHash) return false;
        docState.artifactSha256 = eventHash;
        docState.revisionSha256 = eventHash !== docState.sourceSha256 ? eventHash : '';
        return true;
      } catch {
        return false;
      }
    }

    async function matchRunsEventHash(docState, eventHash) {
      if (matchesKnownHash(docState, eventHash)) return true;
      const st = typeof paper?.state === 'function' ? paper.state() : null;
      if (!st || normalizeSha(st.sourceSha256) !== docState.sourceSha256) return false;
      if (normalizeSha(st.artifact?.sha256) === eventHash) {
        docState.artifactSha256 = eventHash;
        if (st.hasEdits && eventHash !== docState.sourceSha256) docState.revisionSha256 = eventHash;
        return true;
      }
      return st.hasEdits ? matchViaFreshArtifact(docState, eventHash) : false;
    }

    function recordObservedRuns(docState, runs) {
      let hasNewRun = false;
      for (const run of runs) {
        const rid = cleanStr(run?.id, false, 200);
        if (rid && !docState.knownRunIds.has(rid)) {
          if (!preExistingRunIds.has(rid)) hasNewRun = true;
          docState.knownRunIds.add(rid);
        }
      }
      return hasNewRun;
    }

    function isRunSyncEligible(docState, hasNewRun) {
      if (hasNewRun || touchedInSession.has(docState.sourceSha256)) return true;
      const rec = readRecord(docState.sourceSha256, currentSyncBase());
      return Boolean(rec?.lastSyncedSignature || rec?.dirty);
    }

    function clearPendingEditIfResolved(docState) {
      if (!docState.revisionSha256 || editTimer === null) return;
      clearT(editTimer);
      editTimer = null;
      docState.pendingEdit = false;
    }

    async function handleRunsChange(detail) {
      if (destroyed || !active) return;
      const docState = active;
      const eventHash = normalizeSha(detail?.fileHash);
      if (!eventHash || !(await matchRunsEventHash(docState, eventHash))) return;
      if (destroyed || active !== docState) return;
      const hasNewRun = recordObservedRuns(docState, collectRunsFor(docState, detail?.runs, eventHash));
      if (hasNewRun && isConnected()) touchedInSession.add(docState.sourceSha256);
      if (!isRunSyncEligible(docState, hasNewRun)) return;
      if (!restored) { docState.pendingSyncOnRestore = true; return; }
      if (!isConnected()) { paint(); return; }
      clearPendingEditIfResolved(docState);
      void syncPaper(docState, {
        includeArtifactIfEdited: Boolean(paper?.state?.()?.hasEdits && !docState.revisionSha256),
        extraRuns: detail?.runs,
        extraHash: eventHash,
      });
    }

    function matchesLinkHash(docState, sha) {
      return matchesKnownHash(docState, sha) || normalizeSha(paper?.state?.()?.artifact?.sha256) === sha;
    }

    function handlePdfLink(detail) {
      if (destroyed || detail?.action !== 'saved' || !active) return;
      const sha = normalizeSha(detail?.sha256);
      if (!sha || !matchesLinkHash(active, sha)) return;
      const eligible = touchedInSession.has(active.sourceSha256) || Boolean(readRecord(active.sourceSha256, currentSyncBase())?.pageId);
      if (!eligible) return;
      if (!restored) { active.pendingLinkRefresh = true; return; }
      if (isConnected()) void syncPaper(active, { includeArtifactIfEdited: true });
    }

    async function connect() {
      if (destroyed || connecting || typeof team?.connect !== 'function') return null;
      connecting = true;
      noticeOverride = '';
      if (active) Object.assign(active, { failed: false, authExpired: false, message: '' });
      paint();
      try {
        const res = await team.connect({ base: currentAuthBase(), paperLibrary: true });
        connecting = false;
        restored = true;
        if (active) Object.assign(active, { authExpired: false, failed: false, retryCount: 0, message: '' });
        paint();
        if (active && isConnected() && (active.opened || readRecord(active.sourceSha256, currentSyncBase())?.dirty)) {
          touchedInSession.add(active.sourceSha256);
          void syncPaper(active, { includeArtifactIfEdited: true });
        }
        return res;
      } catch (err) {
        connecting = false;
        noticeOverride = syncErrorMessage(err, 'Confluence에 연결하지 못했어요. 다시 연결해 주세요.');
        if (active) active.message = '';
        paint();
        return null;
      }
    }

    function disconnect() {
      if (destroyed || typeof team?.disconnect !== 'function') return;
      clearTimers();
      team.disconnect();
      if (active) Object.assign(active, { syncing: false, failed: false, authExpired: false, message: '' });
      noticeOverride = '이 브라우저의 Confluence 연결을 끊었어요.';
      paint();
      emitSyncEvent({ status: 'disconnected' });
    }

    function retry() {
      if (destroyed || !active || !isConnected()) return Promise.resolve(null);
      clearTimers();
      active.retryCount = 0;
      return syncPaper(active, { includeArtifactIfEdited: true, force: true });
    }

    function listen(target, type, fn) {
      if (typeof target?.addEventListener !== 'function') return;
      target.addEventListener(type, fn);
      listeners.push(() => {
        if (typeof target.removeEventListener === 'function') target.removeEventListener(type, fn);
      });
    }

    function finishRestore() {
      if (destroyed) return;
      restored = true;
      paint();
      if (!active || !isConnected()) return;
      const rec = readRecord(active.sourceSha256, currentSyncBase());
      const shouldSync = active.pendingSyncOnRestore || active.pendingLinkRefresh || Boolean(rec?.dirty);
      if (!shouldSync) return;
      if (active.pendingSyncOnRestore) touchedInSession.add(active.sourceSha256);
      active.pendingSyncOnRestore = false;
      active.pendingLinkRefresh = false;
      void syncPaper(active, { includeArtifactIfEdited: true, force: Boolean(rec?.dirty) });
    }

    listen(nodes.connect, 'click', () => { void connect(); });
    listen(nodes.retry, 'click', () => { void retry(); });
    listen(nodes.disconnect, 'click', () => { disconnect(); });
    listen(doc, 'falsify:w8-runs-change', event => { void handleRunsChange(event?.detail); });
    listen(doc, 'falsify:w8-pdf-link', event => { handlePdfLink(event?.detail); });
    listen(win, 'online', () => {
      if (!destroyed && active?.failed && isConnected()) {
        active.retryCount = 0;
        void syncPaper(active, { includeArtifactIfEdited: true, force: true });
      }
    });

    paint();
    const ready = Promise.resolve()
      .then(() => (typeof team?.restoreSession === 'function' ? team.restoreSession() : null))
      .catch(() => null)
      .then(finishRestore);

    return {
      ready,
      show,
      edited,
      beforeSwitch,
      onRunsChange: handleRunsChange,
      connect,
      disconnect,
      retry,
      record: sha => readRecord(sha, currentSyncBase()),
      state: () => {
        const rec = active ? readRecord(active.sourceSha256, currentSyncBase()) : null;
        return {
          connected: isConnected(),
          connecting,
          syncing: Boolean(active?.syncing),
          failed: Boolean(active?.failed),
          authExpired: Boolean(active?.authExpired),
          activeSourceSha256: active?.sourceSha256 || '',
          revisionSha256: active?.revisionSha256 || '',
          pageId: rec?.pageId || '',
          pageUrl: rec?.pageUrl || '',
          syncBase: currentSyncBase(),
          authBase: currentAuthBase(),
        };
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        clearTimers();
        for (const off of listeners.splice(0)) off();
      },
    };
  }

  return Object.freeze({
    STORAGE_KEY,
    buildPayload,
    payloadSignature,
    resolveSyncBase,
    resolveAuthBase,
    mount,
  });
});
