/* Inline Confluence paper library picker for W8 Workbench (window.FalsifyW8Library).
   Expands inline next to "내 PDF 열기", connects only on explicit interaction via
   existing paperSync, lists registered papers (listPapers/getPaper) and direct PDF
   attachments (listPaperAttachments/getPaperAttachment) from window.FalsifyW8Team
   on the canonical sync base with independent pagination and partial-failure survival.
   Registered papers reopen preferring local current/saved draft -> valid cached local
   PDF link (window.FalsifyW8PaperLinks.url(sha)) -> public arXiv via mounted search
   fetch (SHA-256 verified before editing) -> user Drive fallback (no permission
   elevation). Attachments download as application/pdf Blobs and open as named Files.
   Clears state and ignores stale responses on disconnect, 401 expiry, or supersede. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.FalsifyW8Library = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  const EXPECTED_SITE = 'https://falsify.atlassian.net';
  const HEX64 = /^[0-9a-f]{64}$/;
  const DRIVE_ID = /^[A-Za-z0-9_-]{10,180}$/;
  const ATTACHMENT_ID = /^(?:att)?\d{1,20}$/;
  const ARXIV_ID = /^(?:\d{4}\.\d{4,5}(?:v\d{1,3})?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d{1,3})?)$/;
  const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;
  const ERROR_COPY = {
    not_configured: 'Confluence 팀 라이브러리 서버가 아직 설정되지 않았어요.',
    permission_denied: '이 Atlassian 계정에 Falsify Confluence 읽기 권한이 없어요.',
    site_not_allowed: 'Falsify Confluence 공간 설정을 확인해 주세요.',
    space_not_allowed: 'Falsify Confluence 공간 설정을 확인해 주세요.',
    parent_not_allowed: 'Falsify Confluence 공간 설정을 확인해 주세요.',
    rate_limited: '요청이 많아 잠시 뒤 다시 시도해 주세요.',
    network: '네트워크 오류로 Confluence 목록을 불러오지 못했어요. 다시 시도해 주세요.',
    timeout: '응답 시간이 초과됐어요. 다시 시도해 주세요.',
  };
  const SOURCE_COPY = {
    papers: {
      loading: '등록된 논문 목록을 불러오는 중…',
      empty: 'Confluence 팀 공간에 기록된 논문이 아직 없어요.',
      fallbackError: '등록된 논문 목록을 불러오지 못했어요. 다시 시도해 주세요.',
    },
    attachments: {
      loading: 'PDF 첨부 목록을 불러오는 중…',
      empty: 'Confluence 팀 공간에 첨부된 PDF가 아직 없어요.',
      fallbackError: 'PDF 첨부 목록을 불러오지 못했어요. 다시 시도해 주세요.',
    },
  };

  function isObj(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeSha(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim().toLowerCase();
    return HEX64.test(text) ? text : '';
  }

  function cleanDriveId(value) {
    return typeof value === 'string' && DRIVE_ID.test(value) ? value : '';
  }

  function cleanAttachmentId(value) {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    return ATTACHMENT_ID.test(text) ? text : '';
  }

  function cleanArxivId(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    return ARXIV_ID.test(text) ? text : '';
  }

  function cleanText(value, maxLen) {
    if (typeof value !== 'string') return '';
    const text = value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
    return maxLen && text.length > maxLen ? text.slice(0, maxLen).trim() : text;
  }

  function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }

  function parseBase(value, locationHref) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const u = locationHref ? new URL(value, locationHref) : new URL(value);
      const ok = u.protocol === 'https:' || (isLoopbackHost(u.hostname) && u.protocol === 'http:');
      if (!ok || u.username || u.password || u.search || u.hash) return '';
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

  function allowedCachedUrl(value, searchApiBase, locationHref) {
    if (typeof value !== 'string' || !value || !searchApiBase) return '';
    try {
      const base = new URL(searchApiBase, locationHref || undefined);
      const target = new URL(value, locationHref || undefined);
      const ok = target.protocol === 'https:' || (isLoopbackHost(target.hostname) && target.protocol === 'http:');
      if (!ok || target.username || target.password || target.origin !== base.origin) return '';
      return target.href;
    } catch {
      return '';
    }
  }

  function driveFileUrl(driveId) {
    const clean = cleanDriveId(driveId);
    return clean ? 'https://drive.google.com/file/d/' + clean + '/view' : '';
  }

  function readSearchDataset(doc, prop, attr) {
    const el = typeof doc?.getElementById === 'function' ? doc.getElementById('w8-search') : null;
    if (!el) return '';
    if (el.dataset && typeof el.dataset[prop] === 'string' && el.dataset[prop]) return el.dataset[prop];
    return typeof el.getAttribute === 'function' ? (el.getAttribute(attr) || '') : '';
  }

  function resolveSearchApiBase(doc, locationHref) {
    return parseBase(readSearchDataset(doc, 'apiBase', 'data-api-base'), locationHref);
  }

  function resolveSyncBase(doc, paperSync, configBase, locationHref) {
    const fromSync = parseBase(paperSync?.state?.()?.syncBase || '', locationHref);
    if (fromSync) return fromSync;
    const syncApi = root?.FalsifyW8PaperSync;
    if (typeof syncApi?.resolveSyncBase === 'function') {
      const resolved = parseBase(syncApi.resolveSyncBase(doc, configBase, locationHref), locationHref);
      if (resolved) return resolved;
    }
    const raw = readSearchDataset(doc, 'syncBase', 'data-sync-base')
      || readSearchDataset(doc, 'apiBase', 'data-api-base')
      || configBase;
    return parseBase(raw, locationHref);
  }

  function isPdfMagicAt(bytes, i) {
    return bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44
      && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d;
  }

  function hasPdfMagic(bytes) {
    if (!bytes || typeof bytes.byteLength !== 'number' || bytes.byteLength < 5) return false;
    const limit = Math.min(bytes.byteLength, 1024);
    for (let i = 0; i <= limit - 5; i += 1) {
      if (isPdfMagicAt(bytes, i)) return true;
    }
    return false;
  }

  function isArrayBuffer(value) {
    return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]';
  }

  async function readBytes(fileLike) {
    if (ArrayBuffer.isView(fileLike)) {
      return new Uint8Array(fileLike.buffer, fileLike.byteOffset, fileLike.byteLength).slice();
    }
    if (isArrayBuffer(fileLike)) return new Uint8Array(fileLike).slice();
    if (fileLike && ArrayBuffer.isView(fileLike.bytes)) {
      return new Uint8Array(fileLike.bytes.buffer, fileLike.bytes.byteOffset, fileLike.bytes.byteLength).slice();
    }
    if (typeof fileLike?.arrayBuffer === 'function') return new Uint8Array(await fileLike.arrayBuffer());
    return null;
  }

  async function sha256Hex(bytes, cryptoApi) {
    const subtle = cryptoApi?.subtle || root?.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== 'function') return '';
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  function safePdfFileName(title) {
    const stem = cleanText(title, 120).replace(/[\\/:"*?<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    const base = stem || 'paper';
    return /\.pdf$/i.test(base) ? base : base + '.pdf';
  }

  function makePdfFile(bytes, title, fileCtor) {
    const copy = ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice()
      : new Uint8Array(bytes || 0);
    const name = safePdfFileName(title);
    const Ctor = fileCtor || root?.File;
    if (typeof Ctor === 'function') return new Ctor([copy], name, { type: 'application/pdf' });
    return {
      name,
      type: 'application/pdf',
      size: copy.byteLength,
      bytes: copy,
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
    };
  }

  function isAuthFailure(err) {
    const code = err?.errorCode || err?.code || '';
    return err?.status === 401 || code === 'unauthorized' || code === 'session_expired' || code === 'auth_required';
  }

  function listErrorMessage(err, sourceKey) {
    const code = err?.errorCode || err?.code || '';
    if (Object.hasOwn(ERROR_COPY, code)) return ERROR_COPY[code];
    if (err?.status === 429) return ERROR_COPY.rate_limited;
    return SOURCE_COPY[sourceKey]?.fallbackError || 'Confluence 목록을 불러오지 못했어요. 다시 시도해 주세요.';
  }

  function sanitizeListItem(raw) {
    if (!isObj(raw)) return null;
    const pageId = cleanText(String(raw.pageId ?? ''), 120);
    if (!pageId) return null;
    return {
      pageId,
      pageUrl: allowedSiteUrl(raw.pageUrl),
      title: cleanText(raw.title, 240) || '제목 없는 논문',
      sourceSha256: normalizeSha(raw.sourceSha256),
    };
  }

  function sanitizeAttachmentItem(raw) {
    if (!isObj(raw)) return null;
    const attachmentId = cleanAttachmentId(raw.attachmentId);
    if (!attachmentId) return null;
    return {
      attachmentId,
      pageId: cleanText(String(raw.pageId ?? ''), 120),
      pageUrl: allowedSiteUrl(raw.pageUrl),
      title: cleanText(raw.title, 240) || '첨부 PDF',
    };
  }

  function sanitizeDetail(raw, fallback) {
    const src = isObj(raw) ? raw : {};
    return {
      pageId: cleanText(String(src.pageId ?? fallback.pageId), 120) || fallback.pageId,
      pageUrl: allowedSiteUrl(src.pageUrl) || fallback.pageUrl || '',
      title: cleanText(src.title, 240) || fallback.title || '제목 없는 논문',
      sourceSha256: normalizeSha(src.sourceSha256) || fallback.sourceSha256 || '',
      arxivId: cleanArxivId(src.arxivId),
      sourceDriveId: cleanDriveId(src.sourceDriveId),
    };
  }

  function fallbackNoticeFor(driveUrl, arxivReason) {
    if (arxivReason === 'sha_mismatch') {
      const msg = driveUrl
        ? '공개 arXiv PDF가 기록된 원문 SHA-256과 달라 바로 열지 않았어요. 본인 Google 계정으로 Drive 원본 파일을 확인한 뒤 「내 PDF 열기」로 열어 주세요.'
        : '공개 arXiv PDF가 기록된 원문 SHA-256과 달라 바로 열지 않았어요. 원본 PDF 파일을 「내 PDF 열기」로 직접 열어 주세요.';
      return { message: msg, driveUrl, kind: driveUrl ? 'drive' : 'local' };
    }
    const msg = driveUrl
      ? '이 기기에서 원문 PDF를 바로 다시 열 수 없어요. 본인 Google 계정으로 Drive 원본 파일을 열어 다운로드한 뒤 「내 PDF 열기」로 이어서 작업할 수 있어요.'
      : '이 기기에서 원문 PDF를 바로 다시 열 수 없어요. 원본 PDF 파일을 「내 PDF 열기」로 직접 열어 주세요.';
    return { message: msg, driveUrl, kind: driveUrl ? 'drive' : 'local' };
  }

  function queryNodes(doc) {
    const byId = id => (typeof doc?.getElementById === 'function' ? doc.getElementById(id) : null);
    return {
      toggle: byId('w8-library-toggle'),
      toggleLabel: byId('w8-library-toggle-label'),
      panel: byId('w8-library-panel'),
      refresh: byId('w8-library-refresh'),
      status: byId('w8-library-status'),
      actions: byId('w8-library-actions'),
      connect: byId('w8-library-connect'),
      sections: byId('w8-library-sections'),
      papers: {
        group: byId('w8-library-papers-group'),
        status: byId('w8-library-papers-status'),
        retry: byId('w8-library-retry'),
        list: byId('w8-library-list'),
        more: byId('w8-library-more'),
      },
      attachments: {
        group: byId('w8-library-att-group'),
        status: byId('w8-library-att-status'),
        retry: byId('w8-library-att-retry'),
        list: byId('w8-library-att-list'),
        more: byId('w8-library-att-more'),
      },
      syncRoot: byId('w8-sync'),
      syncDisconnect: byId('w8-sync-disconnect'),
    };
  }

  function readCachedLinkUrl(paperLinks, searchApiBase, sha, locationHref) {
    if (!paperLinks || !searchApiBase || !sha || typeof paperLinks.url !== 'function') return '';
    return allowedCachedUrl(paperLinks.url(sha), searchApiBase, locationHref);
  }

  async function fetchVerifiedPdf(fetchImpl, url, expectedSha, title, cryptoApi, fileCtor) {
    if (typeof fetchImpl !== 'function' || !url || !expectedSha) return null;
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        mode: 'cors',
      });
      if (!res?.ok || typeof res.arrayBuffer !== 'function') return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!hasPdfMagic(bytes)) return null;
      const actualSha = await sha256Hex(bytes, cryptoApi);
      if (actualSha !== expectedSha) return null;
      return makePdfFile(bytes, title, fileCtor);
    } catch {
      return null;
    }
  }

  async function verifyPdfFileSha(file, expectedSha, cryptoApi) {
    if (!file || !expectedSha) return false;
    const bytes = await readBytes(file);
    if (!bytes || !hasPdfMagic(bytes)) return false;
    return (await sha256Hex(bytes, cryptoApi)) === expectedSha;
  }

  function buildNoticeNode(doc, notice) {
    const box = doc.createElement('div');
    box.className = notice.kind === 'error' ? 'w8-library-notice is-error' : 'w8-library-notice';
    const text = doc.createElement('p');
    text.textContent = notice.message;
    box.append(text);
    if (notice.driveUrl) {
      const link = doc.createElement('a');
      link.className = 'w8-library-drive';
      link.href = notice.driveUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Google Drive에서 원본 PDF 열기';
      box.append(link);
    }
    return box;
  }

  function buildItemNode(doc, item, view) {
    const li = doc.createElement('li');
    li.className = 'w8-library-item';
    if (view.attrKey) li.dataset[view.attrKey] = view.attrValue;
    const row = doc.createElement('div');
    row.className = 'w8-library-item-row';

    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = view.buttonClass || 'w8-library-open';
    if (view.attrKey) btn.dataset[view.attrKey] = view.attrValue;
    btn.disabled = view.disabled;
    const titleSpan = doc.createElement('span');
    titleSpan.className = 'w8-library-title';
    titleSpan.textContent = item.title;
    const goSpan = doc.createElement('span');
    goSpan.className = 'w8-library-go';
    goSpan.textContent = view.opening ? '여는 중…' : '열기 →';
    btn.append(titleSpan, goSpan);
    btn.addEventListener('click', () => { void view.onOpen(item); });
    row.append(btn);

    if (item.pageUrl) {
      const ext = doc.createElement('a');
      ext.className = 'w8-library-ext';
      ext.href = item.pageUrl;
      ext.target = '_blank';
      ext.rel = 'noopener noreferrer';
      ext.textContent = 'Confluence';
      ext.setAttribute('aria-label', item.title + ' Confluence 페이지 열기');
      row.append(ext);
    }

    li.append(row);
    if (view.notice) li.append(buildNoticeNode(doc, view.notice));
    return li;
  }

  function computeHeaderStatus(connected, connecting, authExpired) {
    if (connecting) return 'Confluence에 연결하는 중…';
    if (connected) return '';
    return authExpired
      ? 'Confluence 연결이 만료됐어요. 다시 연결한 뒤 불러와 주세요.'
      : 'Confluence에 연결하면 팀 공간에 기록된 논문과 PDF 첨부를 불러올 수 있어요.';
  }

  function computeSourceStatus(src, sourceKey) {
    const copy = SOURCE_COPY[sourceKey];
    if (src.loading) return copy.loading;
    if (src.errorMessage) return src.errorMessage;
    if (src.loaded && !src.items.length) return copy.empty;
    return '';
  }

  function createSourceState() {
    return {
      items: [],
      nextCursor: '',
      loaded: false,
      loading: false,
      loadingMore: false,
      errorMessage: '',
      failedOnMore: false,
      listGen: 0,
    };
  }

  function resetSourceState(src) {
    src.listGen += 1;
    src.items = [];
    src.nextCursor = '';
    src.loaded = false;
    src.loading = false;
    src.loadingMore = false;
    src.errorMessage = '';
    src.failedOnMore = false;
  }

  function fnOrNull(value) {
    return typeof value === 'function' ? value : null;
  }

  function defaultFetch() {
    return typeof root?.fetch === 'function' ? root.fetch.bind(root) : null;
  }

  function resolveEnvDeps(options) {
    const doc = options.document || root?.document || null;
    const win = options.window || root?.window || root || null;
    return {
      doc,
      win,
      locationHref: options.locationHref || win?.location?.href || '',
      fetchImpl: options.fetch || defaultFetch(),
      cryptoApi: options.crypto || root?.crypto || null,
      fileCtor: options.File || root?.File || null,
      ObserverCtor: options.MutationObserver || root?.MutationObserver || null,
    };
  }

  function resolveRuntimeDeps(options) {
    return {
      paper: options.paper || root?.FalsifyW8Paper || null,
      paperSync: options.paperSync || root?.FalsifyW8Sync || null,
      team: options.team || root?.FalsifyW8Team || null,
      paperLinksOf: () => options.paperLinks || root?.FalsifyW8PaperLinks || null,
      loadArxiv: fnOrNull(options.loadArxiv),
      openFile: fnOrNull(options.openFile),
      resumeLocal: fnOrNull(options.resumeLocal),
      selectCurrent: fnOrNull(options.selectCurrent),
      isBusy: fnOrNull(options.isBusy) || (() => false),
    };
  }

  function resolveDeps(options) {
    return Object.assign(resolveEnvDeps(options), resolveRuntimeDeps(options));
  }

  function mergeUniqueByKey(existing, incoming, keyName) {
    const seen = new Set(existing.map(item => item[keyName]));
    const merged = existing.slice();
    for (const item of incoming) {
      const id = item[keyName];
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(item);
      }
    }
    return merged;
  }

  function clearNoticesWithPrefix(map, prefix) {
    for (const key of [...map.keys()]) {
      if (key.startsWith(prefix)) map.delete(key);
    }
  }

  function mount(options = {}) {
    const d = resolveDeps(options);
    const nodes = queryNodes(d.doc);
    const listeners = [];
    let observer = null;

    const st = {
      expanded: false,
      connecting: false,
      externalBusy: false,
      openingKey: '',
      authExpired: false,
      papers: createSourceState(),
      attachments: createSourceState(),
      itemNotices: new Map(),
      sessionGen: 0,
      openGen: 0,
      destroyed: false,
    };

    function isConnected() {
      return Boolean(typeof d.team?.isConnected === 'function' && d.team.isConnected());
    }

    function currentSyncBase() {
      const cfgBase = options.configBase ?? root?.FalsifyCloudConfig?.apiBase ?? '';
      return resolveSyncBase(d.doc, d.paperSync, cfgBase, d.locationHref);
    }

    function currentSearchApiBase() {
      if (Object.hasOwn(options, 'searchApiBase')) {
        const raw = typeof options.searchApiBase === 'function' ? options.searchApiBase() : options.searchApiBase;
        return parseBase(raw, d.locationHref);
      }
      return resolveSearchApiBase(d.doc, d.locationHref);
    }

    function isStaleSource(sourceKey, sGen, lGen) {
      return st.destroyed || sGen !== st.sessionGen || lGen !== st[sourceKey].listGen || !isConnected();
    }

    function isStaleOpen(sGen, oGen) {
      return st.destroyed || sGen !== st.sessionGen || oGen !== st.openGen || !isConnected();
    }

    function paintToggle() {
      if (nodes.toggle) nodes.toggle.setAttribute('aria-expanded', st.expanded ? 'true' : 'false');
      if (nodes.toggleLabel) nodes.toggleLabel.textContent = st.expanded ? '접기 ▴' : '열어 보기 ▾';
      if (nodes.panel) nodes.panel.hidden = !st.expanded;
    }

    function paintHeaderControls(connected) {
      const anyLoading = st.papers.loading || st.attachments.loading;
      if (nodes.connect) {
        nodes.connect.hidden = connected;
        nodes.connect.disabled = st.connecting;
      }
      if (nodes.actions) nodes.actions.hidden = connected;
      if (nodes.refresh) {
        nodes.refresh.hidden = !connected;
        nodes.refresh.disabled = anyLoading;
      }
      if (nodes.sections) nodes.sections.hidden = !connected;
    }

    function sourceRowView(sourceKey, item, busyNow) {
      if (sourceKey === 'attachments') {
        const key = 'att:' + item.attachmentId;
        return {
          attrKey: 'attachmentId',
          attrValue: item.attachmentId,
          buttonClass: 'w8-library-open w8-library-att-open',
          disabled: busyNow,
          opening: st.openingKey === key,
          notice: st.itemNotices.get(key) || null,
          onOpen: openAttachment,
        };
      }
      const key = 'paper:' + item.pageId;
      return {
        attrKey: 'pageId',
        attrValue: item.pageId,
        buttonClass: 'w8-library-open',
        disabled: busyNow,
        opening: st.openingKey === key,
        notice: st.itemNotices.get(key) || null,
        onOpen: openItem,
      };
    }

    function paintSourceControls(src, sNodes, connected, busyNow) {
      const busyList = src.loading || src.loadingMore;
      if (sNodes.status) sNodes.status.textContent = connected ? computeSourceStatus(src, sNodes.key) : '';
      if (sNodes.retry) {
        sNodes.retry.hidden = !connected || !src.errorMessage || busyList;
        sNodes.retry.disabled = busyList;
      }
      if (sNodes.more) {
        sNodes.more.hidden = !connected || !src.nextCursor || src.loading;
        sNodes.more.disabled = src.loadingMore || busyNow;
        sNodes.more.textContent = src.loadingMore ? '불러오는 중…' : '더 보기';
      }
    }

    function paintSourceList(sourceKey, src, sNodes, connected, busyNow) {
      if (!sNodes.list || typeof d.doc?.createElement !== 'function') return;
      if (!connected || !src.items.length) {
        sNodes.list.replaceChildren();
        return;
      }
      const rows = src.items.map(item => buildItemNode(d.doc, item, sourceRowView(sourceKey, item, busyNow)));
      sNodes.list.replaceChildren(...rows);
    }

    function paint() {
      if (st.destroyed) return;
      const connected = isConnected() && !st.authExpired;
      const busyNow = st.externalBusy || Boolean(st.openingKey) || Boolean(d.isBusy());
      paintToggle();
      if (nodes.status) nodes.status.textContent = computeHeaderStatus(connected, st.connecting, st.authExpired);
      paintHeaderControls(connected);
      const pNodes = Object.assign({ key: 'papers' }, nodes.papers);
      const aNodes = Object.assign({ key: 'attachments' }, nodes.attachments);
      paintSourceControls(st.papers, pNodes, connected, busyNow);
      paintSourceList('papers', st.papers, pNodes, connected, busyNow);
      paintSourceControls(st.attachments, aNodes, connected, busyNow);
      paintSourceList('attachments', st.attachments, aNodes, connected, busyNow);
    }

    function clear(opts = {}) {
      if (st.destroyed) return;
      st.sessionGen += 1;
      st.openGen += 1;
      resetSourceState(st.papers);
      resetSourceState(st.attachments);
      st.connecting = false;
      st.openingKey = '';
      st.authExpired = Boolean(opts.authExpired);
      st.itemNotices.clear();
      paint();
    }

    function beginSourceLoad(sourceKey, reset) {
      const src = st[sourceKey];
      src.errorMessage = '';
      src.failedOnMore = false;
      st.authExpired = false;
      if (reset) {
        src.loading = true;
        src.loadingMore = false;
        src.items = [];
        src.nextCursor = '';
        clearNoticesWithPrefix(st.itemNotices, sourceKey === 'attachments' ? 'att:' : 'paper:');
      } else {
        src.loadingMore = true;
      }
      paint();
    }

    function applySourceResult(sourceKey, res, reset) {
      const src = st[sourceKey];
      const rawItems = Array.isArray(res?.items) ? res.items : [];
      const sanitize = sourceKey === 'attachments' ? sanitizeAttachmentItem : sanitizeListItem;
      const idKey = sourceKey === 'attachments' ? 'attachmentId' : 'pageId';
      const clean = rawItems.map(sanitize).filter(Boolean);
      src.items = reset ? clean : mergeUniqueByKey(src.items, clean, idKey);
      src.nextCursor = typeof res?.nextCursor === 'string' && res.nextCursor.trim() ? res.nextCursor.trim() : '';
      src.loaded = true;
      src.loading = false;
      src.loadingMore = false;
      src.errorMessage = '';
      src.failedOnMore = false;
      paint();
    }

    function teamListMethod(sourceKey) {
      return sourceKey === 'attachments' ? d.team?.listPaperAttachments : d.team?.listPapers;
    }

    async function loadSource(sourceKey, { reset = true } = {}) {
      if (st.destroyed) return;
      if (!isConnected()) { clear({ authExpired: st.authExpired }); return; }
      const src = st[sourceKey];
      const syncBase = currentSyncBase();
      const listFn = teamListMethod(sourceKey);
      if (!syncBase || typeof listFn !== 'function') {
        src.loaded = true;
        src.loading = false;
        src.loadingMore = false;
        src.errorMessage = sourceKey === 'papers' ? 'Confluence 팀 라이브러리 설정을 확인할 수 없어요.' : '';
        paint();
        return;
      }
      const cursor = reset ? '' : src.nextCursor;
      const sGen = st.sessionGen;
      const lGen = ++src.listGen;
      beginSourceLoad(sourceKey, reset);
      try {
        const query = cursor ? { base: syncBase, cursor } : { base: syncBase };
        const res = await listFn(query);
        if (isStaleSource(sourceKey, sGen, lGen)) return;
        applySourceResult(sourceKey, res, reset);
      } catch (err) {
        if (st.destroyed || sGen !== st.sessionGen || lGen !== src.listGen) return;
        if (isAuthFailure(err)) { clear({ authExpired: true }); return; }
        src.loading = false;
        src.loadingMore = false;
        src.failedOnMore = !reset;
        src.errorMessage = listErrorMessage(err, sourceKey);
        paint();
      }
    }

    function loadAll({ reset = true } = {}) {
      return Promise.all([
        loadSource('papers', { reset }),
        loadSource('attachments', { reset }),
      ]);
    }

    function matchesCurrentPaper(sha) {
      if (!sha || typeof d.paper?.state !== 'function') return false;
      const ps = d.paper.state();
      return Boolean(ps?.ready && normalizeSha(ps.sourceSha256) === sha);
    }

    async function tryOpenLocal(item, sha, sGen, oGen) {
      if (!sha) return false;
      if (matchesCurrentPaper(sha)) {
        d.selectCurrent?.({ sha, title: item.title, pageUrl: item.pageUrl });
        return true;
      }
      if (typeof d.resumeLocal !== 'function') return false;
      const resumed = await d.resumeLocal(sha);
      if (isStaleOpen(sGen, oGen)) return true;
      return Boolean(resumed);
    }

    async function tryOpenCachedLink(item, sha, sGen, oGen) {
      if (!sha || typeof d.openFile !== 'function') return false;
      const url = readCachedLinkUrl(d.paperLinksOf(), currentSearchApiBase(), sha, d.locationHref);
      if (!url) return false;
      const file = await fetchVerifiedPdf(d.fetchImpl, url, sha, item.title, d.cryptoApi, d.fileCtor);
      if (isStaleOpen(sGen, oGen)) return true;
      if (!file) return false;
      await d.openFile(file, { title: item.title, arxivEntry: null, expectedSha256: sha });
      return true;
    }

    async function tryOpenArxiv(detail, sGen, oGen) {
      if (!detail.arxivId || !detail.sourceSha256 || !d.loadArxiv || !d.openFile) {
        return { opened: false, reason: '' };
      }
      let file;
      try { file = await d.loadArxiv({ id: detail.arxivId, title: detail.title }); }
      catch { return { opened: false, reason: 'fetch_failed' }; }
      if (isStaleOpen(sGen, oGen)) return { opened: true, reason: '' };
      const matched = await verifyPdfFileSha(file, detail.sourceSha256, d.cryptoApi);
      if (isStaleOpen(sGen, oGen)) return { opened: true, reason: '' };
      if (!matched) return { opened: false, reason: 'sha_mismatch' };
      const arxivEntry = { id: detail.arxivId, title: detail.title, license: '' };
      await d.openFile(file, { title: detail.title, arxivEntry, expectedSha256: detail.sourceSha256 });
      return { opened: true, reason: '' };
    }

    function updatePaperMetadata(detail) {
      const hit = st.papers.items.find(entry => entry.pageId === detail.pageId);
      if (!hit) return;
      hit.title = detail.title;
      if (detail.pageUrl) hit.pageUrl = detail.pageUrl;
      if (detail.sourceSha256) hit.sourceSha256 = detail.sourceSha256;
    }

    async function resolveViaDetail(item, sGen, oGen) {
      const noticeKey = 'paper:' + item.pageId;
      const syncBase = currentSyncBase();
      if (!syncBase || typeof d.team?.getPaper !== 'function') {
        st.itemNotices.set(noticeKey, fallbackNoticeFor('', ''));
        return;
      }
      const rawDetail = await d.team.getPaper(item.pageId, { base: syncBase });
      if (isStaleOpen(sGen, oGen)) return;
      const detail = sanitizeDetail(rawDetail, item);
      updatePaperMetadata(detail);
      if (!item.sourceSha256 && detail.sourceSha256) {
        if (await tryOpenLocal(detail, detail.sourceSha256, sGen, oGen)) return;
        if (isStaleOpen(sGen, oGen)) return;
        if (await tryOpenCachedLink(detail, detail.sourceSha256, sGen, oGen)) return;
        if (isStaleOpen(sGen, oGen)) return;
      }
      const arxivOutcome = await tryOpenArxiv(detail, sGen, oGen);
      if (arxivOutcome.opened || isStaleOpen(sGen, oGen)) return;
      st.itemNotices.set(noticeKey, fallbackNoticeFor(driveFileUrl(detail.sourceDriveId), arxivOutcome.reason));
    }

    async function runOpenPipeline(item, sGen, oGen) {
      if (await tryOpenLocal(item, item.sourceSha256, sGen, oGen)) return;
      if (isStaleOpen(sGen, oGen)) return;
      if (await tryOpenCachedLink(item, item.sourceSha256, sGen, oGen)) return;
      if (isStaleOpen(sGen, oGen)) return;
      await resolveViaDetail(item, sGen, oGen);
    }

    function handleOpenError(noticeKey, err, sGen, oGen, fallbackMsg) {
      if (st.destroyed || sGen !== st.sessionGen || oGen !== st.openGen) return;
      if (isAuthFailure(err)) { clear({ authExpired: true }); return; }
      st.itemNotices.set(noticeKey, {
        message: err?.message || fallbackMsg,
        driveUrl: '',
        kind: 'error',
      });
    }

    function finishOpenAttempt(sGen, oGen) {
      if (!st.destroyed && sGen === st.sessionGen && oGen === st.openGen) {
        st.openingKey = '';
        paint();
      }
    }

    async function openItem(item) {
      if (st.destroyed || !item?.pageId || st.externalBusy || d.isBusy()) return;
      if (!isConnected()) { clear({ authExpired: true }); return; }
      const noticeKey = 'paper:' + item.pageId;
      const sGen = st.sessionGen;
      const oGen = ++st.openGen;
      st.openingKey = noticeKey;
      st.itemNotices.delete(noticeKey);
      paint();
      try {
        await runOpenPipeline(item, sGen, oGen);
      } catch (err) {
        handleOpenError(noticeKey, err, sGen, oGen, '논문을 불러오지 못했어요. 다시 시도해 주세요.');
      } finally {
        finishOpenAttempt(sGen, oGen);
      }
    }

    async function runAttachmentOpen(item, sGen, oGen) {
      const syncBase = currentSyncBase();
      if (!syncBase || typeof d.team?.getPaperAttachment !== 'function' || typeof d.openFile !== 'function') {
        throw new Error('첨부 PDF를 불러올 수 없어요.');
      }
      const blob = await d.team.getPaperAttachment(item.attachmentId, { base: syncBase });
      if (isStaleOpen(sGen, oGen)) return;
      const bytes = await readBytes(blob);
      if (isStaleOpen(sGen, oGen)) return;
      if (!bytes || !hasPdfMagic(bytes)) throw new Error('첨부 파일이 유효한 PDF가 아니에요.');
      const file = makePdfFile(bytes, item.title, d.fileCtor);
      await d.openFile(file, { title: item.title, arxivEntry: null });
    }

    async function openAttachment(item) {
      const attachmentId = cleanAttachmentId(item?.attachmentId);
      if (st.destroyed || !attachmentId || st.externalBusy || d.isBusy()) return;
      if (!isConnected()) { clear({ authExpired: true }); return; }
      const noticeKey = 'att:' + attachmentId;
      const sGen = st.sessionGen;
      const oGen = ++st.openGen;
      st.openingKey = noticeKey;
      st.itemNotices.delete(noticeKey);
      paint();
      try {
        await runAttachmentOpen({ attachmentId, title: item.title }, sGen, oGen);
      } catch (err) {
        handleOpenError(noticeKey, err, sGen, oGen, '첨부 PDF를 불러오지 못했어요. 다시 시도해 주세요.');
      } finally {
        finishOpenAttempt(sGen, oGen);
      }
    }

    function needsInitialLoad() {
      const needPapers = !st.papers.loaded && !st.papers.loading;
      const needAtt = !st.attachments.loaded && !st.attachments.loading;
      return needPapers || needAtt;
    }

    function connectAndLoad() {
      if (st.destroyed || st.connecting || typeof d.paperSync?.connect !== 'function') return Promise.resolve(null);
      const sGen = st.sessionGen;
      st.connecting = true;
      st.authExpired = false;
      paint();
      return Promise.resolve(d.paperSync.connect()).then(res => {
        if (st.destroyed || sGen !== st.sessionGen) return res;
        st.connecting = false;
        if (isConnected()) void loadAll({ reset: true });
        else paint();
        return res;
      }, () => {
        if (st.destroyed || sGen !== st.sessionGen) return null;
        st.connecting = false;
        paint();
        return null;
      });
    }

    function toggle() {
      if (st.destroyed) return;
      st.expanded = !st.expanded;
      paint();
      if (!st.expanded) return;
      if (isConnected()) {
        if (needsInitialLoad()) void loadAll({ reset: true });
        return;
      }
      const sGen = st.sessionGen;
      if (typeof d.paperSync?.ready?.then === 'function') {
        void d.paperSync.ready.then(() => {
          if (st.destroyed || !st.expanded || sGen !== st.sessionGen) return;
          if (isConnected() && needsInitialLoad()) void loadAll({ reset: true });
          else paint();
        });
      }
    }

    function handleSyncStateChange(stateName) {
      if (st.destroyed) return;
      if (stateName === 'disconnected') { clear({ authExpired: false }); return; }
      if (stateName === 'expired') { clear({ authExpired: true }); return; }
      if ((stateName === 'connected' || stateName === 'synced') && isConnected()) {
        st.authExpired = false;
        if (st.expanded && needsInitialLoad()) void loadAll({ reset: true });
        else paint();
      }
    }

    function listen(target, type, fn) {
      if (typeof target?.addEventListener !== 'function') return;
      target.addEventListener(type, fn);
      listeners.push(() => {
        if (typeof target.removeEventListener === 'function') target.removeEventListener(type, fn);
      });
    }

    listen(nodes.toggle, 'click', toggle);
    listen(nodes.connect, 'click', () => { void connectAndLoad(); });
    listen(nodes.refresh, 'click', () => { void loadAll({ reset: true }); });
    listen(nodes.papers.retry, 'click', () => { void loadSource('papers', { reset: !st.papers.failedOnMore }); });
    listen(nodes.papers.more, 'click', () => { if (!st.papers.loadingMore && st.papers.nextCursor) void loadSource('papers', { reset: false }); });
    listen(nodes.attachments.retry, 'click', () => { void loadSource('attachments', { reset: !st.attachments.failedOnMore }); });
    listen(nodes.attachments.more, 'click', () => { if (!st.attachments.loadingMore && st.attachments.nextCursor) void loadSource('attachments', { reset: false }); });
    listen(nodes.syncDisconnect, 'click', () => { clear({ authExpired: false }); });
    listen(d.doc, 'falsify:w8-paper-sync', event => {
      if (event?.detail?.status === 'disconnected') clear({ authExpired: false });
      else if (event?.detail?.status === 'expired') clear({ authExpired: true });
    });

    if (nodes.syncRoot && typeof d.ObserverCtor === 'function') {
      observer = new d.ObserverCtor(() => {
        handleSyncStateChange(nodes.syncRoot.dataset?.syncState || nodes.syncRoot.getAttribute?.('data-sync-state') || '');
      });
      try { observer.observe(nodes.syncRoot, { attributes: true, attributeFilter: ['data-sync-state'] }); } catch {}
    }

    paint();

    return {
      toggle,
      connect: connectAndLoad,
      refresh: () => loadAll({ reset: true }),
      loadMore: () => (st.papers.nextCursor ? loadSource('papers', { reset: false }) : Promise.resolve()),
      loadMoreAttachments: () => (st.attachments.nextCursor ? loadSource('attachments', { reset: false }) : Promise.resolve()),
      openItem,
      openAttachment,
      clear,
      setBusy(value) {
        st.externalBusy = Boolean(value);
        paint();
      },
      state: () => ({
        expanded: st.expanded,
        connected: isConnected() && !st.authExpired,
        loaded: st.papers.loaded,
        loading: st.papers.loading,
        loadingMore: st.papers.loadingMore,
        openingKey: st.openingKey,
        openingPageId: st.openingKey.startsWith('paper:') ? st.openingKey.slice(6) : '',
        nextCursor: st.papers.nextCursor,
        errorMessage: st.papers.errorMessage,
        items: st.papers.items.map(item => Object.assign({}, item)),
        attachments: {
          loaded: st.attachments.loaded,
          loading: st.attachments.loading,
          loadingMore: st.attachments.loadingMore,
          nextCursor: st.attachments.nextCursor,
          errorMessage: st.attachments.errorMessage,
          items: st.attachments.items.map(item => Object.assign({}, item)),
        },
      }),
      destroy() {
        if (st.destroyed) return;
        st.destroyed = true;
        st.sessionGen += 1;
        st.openGen += 1;
        st.papers.listGen += 1;
        st.attachments.listGen += 1;
        if (observer) { try { observer.disconnect(); } catch {} observer = null; }
        for (const off of listeners.splice(0)) off();
      },
    };
  }

  return Object.freeze({
    mount,
    driveFileUrl,
    allowedSiteUrl,
    allowedCachedUrl,
    resolveSyncBase,
    resolveSearchApiBase,
    sanitizeListItem,
    sanitizeAttachmentItem,
    sanitizeDetail,
  });
});
