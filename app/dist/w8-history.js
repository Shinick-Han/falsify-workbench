/* Concise team history viewer inside the W8 Confluence library panel (window.FalsifyW8History).
   Supports lazy Confluence and Jira source tabs with source-local pagination, lazy per-item
   detail and attachment pagination, inert text preview for Markdown/CSV, native links for
   xlsx/pptx/other files, and normal editor opening for PDF attachments via openFile(file, {title}).
   Clears authenticated state on disconnect/401/stale responses, preserves Confluence state
   across Jira read-scope escalation or cancel, and keeps historical viewing separate from BLUE. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.FalsifyW8History = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  const SOURCES = ['confluence', 'jira'];
  const EXPECTED_SITE = 'https://falsify.atlassian.net';
  const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;
  const INERT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g;
  const ISSUE_ID_RE = /^[A-Z][A-Z0-9_]{1,15}-[1-9][0-9]{0,7}$/;
  const ATTACHMENT_TYPES = new Set(['pdf', 'text', 'file']);

  const SOURCE_LABEL = {
    confluence: 'Confluence',
    jira: 'Jira',
  };

  const ERROR_COPY = {
    not_configured: '팀 기록 서버가 아직 설정되지 않았어요.',
    jira_scope_required: 'Jira 팀 기록을 보려면 읽기 권한을 연결해 주세요.',
    permission_denied: '이 Atlassian 계정에 팀 기록 읽기 권한이 없어요.',
    site_not_allowed: 'Falsify 사이트 설정을 확인해 주세요.',
    space_not_allowed: 'Falsify Confluence 공간 설정을 확인해 주세요.',
    parent_not_allowed: 'Falsify Confluence 공간 설정을 확인해 주세요.',
    issue_not_allowed: '허용된 Jira 프로젝트 기록만 확인할 수 있어요.',
    rate_limited: '요청이 많아 잠시 뒤 다시 시도해 주세요.',
    network: '네트워크 오류로 팀 기록을 불러오지 못했어요. 다시 시도해 주세요.',
    timeout: '응답 시간이 초과됐어요. 다시 시도해 주세요.',
    popup_blocked: '로그인 팝업이 차단됐어요. 팝업을 허용한 뒤 다시 눌러 주세요.',
    auth_cancelled: 'Jira 읽기 권한 연결을 취소했어요.',
  };

  function isObj(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isValidSource(source) {
    return source === 'confluence' || source === 'jira';
  }

  function cleanText(value, maxLen) {
    if (typeof value !== 'string') return '';
    const text = value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
    return maxLen && text.length > maxLen ? text.slice(0, maxLen).trim() : text;
  }

  function cleanInertText(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\r\n?/g, '\n').replace(INERT_CONTROL_RE, '');
  }

  function formatDate(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
  }

  function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }

  function isAllowedBaseUrl(u) {
    const ok = u.protocol === 'https:' || (isLoopbackHost(u.hostname) && u.protocol === 'http:');
    return ok && !u.username && !u.password && !u.search && !u.hash;
  }

  function parseBase(value, locationHref) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const u = locationHref ? new URL(value, locationHref) : new URL(value);
      return isAllowedBaseUrl(u) ? u.origin + u.pathname.replace(/\/+$/, '') : '';
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

  function safeHttpsUrl(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password) return '';
      return u.href;
    } catch {
      return '';
    }
  }

  function readSearchDataset(doc, prop, attr) {
    const el = typeof doc?.getElementById === 'function' ? doc.getElementById('w8-search') : null;
    if (!el) return '';
    if (el.dataset && typeof el.dataset[prop] === 'string' && el.dataset[prop]) return el.dataset[prop];
    return typeof el.getAttribute === 'function' ? (el.getAttribute(attr) || '') : '';
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

  function errorCodeOf(err) {
    return err?.errorCode || err?.code || '';
  }

  function isJiraScopeError(err) {
    return errorCodeOf(err) === 'jira_scope_required';
  }

  function isAuthFailure(err) {
    const code = errorCodeOf(err);
    return err?.status === 401 || code === 'unauthorized' || code === 'session_expired' || code === 'auth_required';
  }

  function historyErrorMessage(err, source) {
    const code = errorCodeOf(err);
    if (Object.hasOwn(ERROR_COPY, code)) return ERROR_COPY[code];
    if (err?.status === 429) return ERROR_COPY.rate_limited;
    const label = SOURCE_LABEL[source] || '팀';
    return label + ' 기록을 불러오지 못했어요. 다시 시도해 주세요.';
  }

  function cleanCursor(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  }

  function fallbackTitle(source, id) {
    return source === 'jira' ? id : '제목 없는 기록';
  }

  function sanitizeArray(raw, mapper) {
    return Array.isArray(raw) ? raw.map(mapper).filter(Boolean) : [];
  }

  function sanitizeHistoryItem(raw, source) {
    if (!isObj(raw)) return null;
    const id = cleanText(String(raw.id ?? ''), 120);
    if (!id) return null;
    const count = Number.isSafeInteger(raw.attachmentCount) && raw.attachmentCount >= 0 ? raw.attachmentCount : null;
    return {
      id,
      title: cleanText(raw.title, 240) || fallbackTitle(source, id),
      url: allowedSiteUrl(raw.url),
      updatedAt: formatDate(raw.updatedAt),
      kind: cleanText(raw.kind, 60),
      attachmentCount: count,
    };
  }

  function sanitizeLink(raw) {
    if (!isObj(raw)) return null;
    const url = safeHttpsUrl(raw.url);
    if (!url) return null;
    return { title: cleanText(raw.title, 200) || url, url };
  }

  function sanitizeAttachment(raw) {
    if (!isObj(raw)) return null;
    const id = cleanText(String(raw.id ?? ''), 120);
    if (!id) return null;
    const type = ATTACHMENT_TYPES.has(raw.type) ? raw.type : 'file';
    return {
      id,
      title: cleanText(raw.title, 240) || '첨부 파일',
      type,
      url: allowedSiteUrl(raw.url),
    };
  }

  function sanitizeDetailMeta(src, fallback, source, id) {
    const fb = isObj(fallback) ? fallback : {};
    return {
      id,
      title: cleanText(src.title, 240) || fb.title || fallbackTitle(source, id),
      url: allowedSiteUrl(src.url) || fb.url || '',
      updatedAt: formatDate(src.updatedAt) || fb.updatedAt || '',
      kind: cleanText(src.kind, 60) || fb.kind || '',
    };
  }

  function sanitizeHistoryDetail(raw, fallback, source) {
    const src = isObj(raw) ? raw : {};
    const id = cleanText(String(src.id ?? fallback?.id ?? ''), 120);
    return Object.assign(sanitizeDetailMeta(src, fallback, source, id), {
      text: typeof src.text === 'string' ? cleanInertText(src.text) : '',
      links: sanitizeArray(src.links, sanitizeLink),
      attachments: sanitizeArray(src.attachments, sanitizeAttachment),
      nextAttachmentCursor: cleanCursor(src.nextAttachmentCursor),
    });
  }

  function mergeUniqueById(existing, incoming) {
    const seen = new Set(existing.map(item => item.id));
    const merged = existing.slice();
    for (const item of incoming) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
    return merged;
  }

  function showIssueBadge(source, id) {
    return source === 'jira' || ISSUE_ID_RE.test(id);
  }

  function formatItemMeta(item) {
    const parts = [];
    if (item.kind) parts.push(item.kind);
    if (item.updatedAt) parts.push(item.updatedAt);
    if (Number.isSafeInteger(item.attachmentCount) && item.attachmentCount > 0) {
      parts.push('첨부 ' + item.attachmentCount);
    }
    return parts.join(' · ');
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
      scopeRequired: false,
      listGen: 0,
      selectedId: '',
      detail: null,
      detailLoading: false,
      detailError: '',
      detailGen: 0,
      attLoadingMore: false,
      attError: '',
      attGen: 0,
      fileGen: 0,
      openingAttId: '',
      attErrorMap: new Map(),
      textPreviews: new Map(),
      activeTextAttId: '',
    };
  }

  function resetDetailState(src) {
    src.detailGen += 1;
    src.attGen += 1;
    src.fileGen += 1;
    src.selectedId = '';
    src.detail = null;
    src.detailLoading = false;
    src.detailError = '';
    src.attLoadingMore = false;
    src.attError = '';
    src.openingAttId = '';
    src.attErrorMap.clear();
    src.textPreviews.clear();
    src.activeTextAttId = '';
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
    src.scopeRequired = false;
    resetDetailState(src);
  }

  function fnOrNull(value) {
    return typeof value === 'function' ? value : null;
  }

  function resolveEnvDeps(options) {
    const doc = options.document || root?.document || null;
    const win = options.window || root?.window || root || null;
    return {
      doc,
      win,
      locationHref: options.locationHref || win?.location?.href || '',
      fileCtor: options.File || root?.File || null,
      ObserverCtor: options.MutationObserver || root?.MutationObserver || null,
    };
  }

  function resolveRuntimeDeps(options) {
    return {
      paperSync: options.paperSync || root?.FalsifyW8Sync || null,
      team: options.team || root?.FalsifyW8Team || null,
      openFile: fnOrNull(options.openFile),
      isBusy: fnOrNull(options.isBusy) || (() => false),
    };
  }

  function resolveDeps(options) {
    return Object.assign(resolveEnvDeps(options), resolveRuntimeDeps(options));
  }

  function queryNodes(doc) {
    const byId = id => (typeof doc?.getElementById === 'function' ? doc.getElementById(id) : null);
    return {
      panel: byId('w8-library-panel'),
      group: byId('w8-history-group'),
      refresh: byId('w8-history-refresh'),
      retry: byId('w8-history-retry'),
      tabs: {
        confluence: byId('w8-history-tab-confluence'),
        jira: byId('w8-history-tab-jira'),
      },
      body: byId('w8-history-body'),
      status: byId('w8-history-status'),
      actions: byId('w8-history-actions'),
      jiraConnect: byId('w8-history-jira-connect'),
      list: byId('w8-history-list'),
      more: byId('w8-history-more'),
      detail: byId('w8-history-detail'),
      syncRoot: byId('w8-sync'),
      syncDisconnect: byId('w8-sync-disconnect'),
    };
  }

  function makeExternalLink(doc, url, text, ariaLabel) {
    const a = doc.createElement('a');
    a.className = 'w8-library-ext';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    if (ariaLabel) a.setAttribute('aria-label', ariaLabel);
    return a;
  }

  function buildTitleRow(doc, source, id, title, tagName) {
    const row = doc.createElement(tagName === 'h4' ? 'div' : 'span');
    row.className = 'w8-history-title-row';
    if (showIssueBadge(source, id)) {
      const idSpan = doc.createElement('span');
      idSpan.className = 'w8-history-id';
      idSpan.textContent = id;
      row.append(idSpan);
    }
    const titleEl = doc.createElement(tagName);
    titleEl.className = tagName === 'h4' ? 'w8-history-detail-title' : 'w8-library-title';
    titleEl.textContent = title;
    row.append(titleEl);
    return row;
  }

  function buildItemNode(doc, source, item, view) {
    const li = doc.createElement('li');
    li.className = view.selected ? 'w8-library-item w8-history-item is-selected' : 'w8-library-item w8-history-item';
    li.dataset.historySource = source;
    li.dataset.historyId = item.id;

    const row = doc.createElement('div');
    row.className = 'w8-library-item-row';

    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'w8-library-open w8-history-open';
    btn.dataset.historySource = source;
    btn.dataset.historyId = item.id;
    btn.setAttribute('aria-expanded', view.selected ? 'true' : 'false');

    const main = doc.createElement('span');
    main.className = 'w8-history-item-main';
    main.append(buildTitleRow(doc, source, item.id, item.title, 'span'));

    const metaText = formatItemMeta(item);
    if (metaText) {
      const meta = doc.createElement('span');
      meta.className = 'w8-history-meta';
      meta.textContent = metaText;
      main.append(meta);
    }

    const go = doc.createElement('span');
    go.className = 'w8-library-go';
    go.textContent = view.selected ? '닫기' : '보기 →';
    btn.append(main, go);
    btn.addEventListener('click', () => { void view.onSelect(item); });
    row.append(btn);

    if (item.url) {
      const label = SOURCE_LABEL[source];
      const prefix = showIssueBadge(source, item.id) ? item.id + ' ' : '';
      row.append(makeExternalLink(doc, item.url, label, prefix + item.title + ' ' + label + ' 열기'));
    }

    li.append(row);
    return li;
  }

  function buildTextPreviewNode(doc, preview) {
    const wrap = doc.createElement('div');
    wrap.className = 'w8-history-preview';
    if (preview.truncated || preview.url) {
      const bar = doc.createElement('div');
      bar.className = 'w8-history-preview-bar';
      if (preview.truncated) {
        const note = doc.createElement('p');
        note.className = 'booth-small w8-history-truncated';
        note.textContent = '파일이 커서 앞부분만 표시했어요.';
        bar.append(note);
      }
      if (preview.url) bar.append(makeExternalLink(doc, preview.url, '원본 열기', preview.title + ' 원본 열기'));
      wrap.append(bar);
    }
    const pre = doc.createElement('pre');
    pre.className = 'w8-history-pre';
    const code = doc.createElement('code');
    code.textContent = preview.text;
    pre.append(code);
    wrap.append(pre);
    return wrap;
  }

  function buildNativeFileNode(doc, att) {
    if (!att.url) {
      const plain = doc.createElement('span');
      plain.className = 'w8-history-att-plain';
      plain.textContent = att.title + ' (원본 링크 없음)';
      return plain;
    }
    const a = doc.createElement('a');
    a.className = 'w8-history-att-link';
    a.dataset.attType = 'file';
    a.dataset.attId = att.id;
    a.href = att.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const title = doc.createElement('span');
    title.className = 'w8-library-title';
    title.textContent = att.title;
    const go = doc.createElement('span');
    go.className = 'w8-library-go';
    go.textContent = '원본 열기 ↗';
    a.append(title, go);
    return a;
  }

  function attachmentButtonGoLabel(att, view) {
    if (att.type === 'pdf') return view.loading ? '여는 중…' : '편집기로 열기';
    if (view.loading) return '불러오는 중…';
    return view.expandedText ? '접기' : '내용 보기';
  }

  function buildAttachmentAction(doc, att, view) {
    if (att.type === 'file') return buildNativeFileNode(doc, att);
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'w8-library-open w8-history-att-btn';
    btn.dataset.attType = att.type;
    btn.dataset.attId = att.id;
    btn.disabled = att.type === 'pdf' ? view.pdfDisabled : view.loading;
    const title = doc.createElement('span');
    title.className = 'w8-library-title';
    title.textContent = att.title;
    const go = doc.createElement('span');
    go.className = 'w8-library-go';
    go.textContent = attachmentButtonGoLabel(att, view);
    btn.append(title, go);
    btn.addEventListener('click', () => { void view.onOpen(att); });
    return btn;
  }

  function buildAttachmentNode(doc, att, view) {
    const li = doc.createElement('li');
    li.className = 'w8-history-att';
    li.dataset.attType = att.type;
    li.dataset.attId = att.id;
    li.append(buildAttachmentAction(doc, att, view));
    if (view.errorText) {
      const err = doc.createElement('p');
      err.className = 'w8-library-notice is-error';
      err.textContent = view.errorText;
      li.append(err);
    }
    if (view.preview) li.append(buildTextPreviewNode(doc, view.preview));
    return li;
  }

  function buildLinksSection(doc, links) {
    const box = doc.createElement('div');
    box.className = 'w8-history-sub';
    const label = doc.createElement('span');
    label.className = 'booth-klab';
    label.textContent = '관련 링크';
    const ul = doc.createElement('ul');
    ul.className = 'w8-history-links';
    for (const link of links) {
      const li = doc.createElement('li');
      const a = doc.createElement('a');
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.title;
      li.append(a);
      ul.append(li);
    }
    box.append(label, ul);
    return box;
  }

  function buildAttachmentsList(doc, src, attachments, handlers) {
    const ul = doc.createElement('ul');
    ul.className = 'w8-history-attachments';
    for (const att of attachments) {
      const expandedText = att.type === 'text' && src.activeTextAttId === att.id;
      ul.append(buildAttachmentNode(doc, att, {
        loading: src.openingAttId === att.id,
        pdfDisabled: handlers.busyPdf,
        expandedText,
        errorText: src.attErrorMap.get(att.id) || '',
        preview: expandedText ? (src.textPreviews.get(att.id) || null) : null,
        onOpen: handlers.onOpenAttachment,
      }));
    }
    return ul;
  }

  function buildAttachmentsSection(doc, src, detail, handlers) {
    const box = doc.createElement('div');
    box.className = 'w8-history-sub';
    const label = doc.createElement('span');
    label.className = 'booth-klab';
    label.textContent = '첨부 파일';
    box.append(label);

    if (detail.attachments.length) box.append(buildAttachmentsList(doc, src, detail.attachments, handlers));

    if (src.attError) {
      const err = doc.createElement('p');
      err.className = 'booth-feedback w8-history-status-error';
      err.textContent = src.attError;
      box.append(err);
    }

    if (detail.nextAttachmentCursor) {
      const more = doc.createElement('button');
      more.type = 'button';
      more.className = 'booth-btn line wide w8-history-att-more';
      more.disabled = src.attLoadingMore;
      more.textContent = src.attLoadingMore ? '불러오는 중…' : '첨부 더 보기';
      more.addEventListener('click', () => { void handlers.onMoreAttachments(); });
      box.append(more);
    }
    return box;
  }

  function buildDetailHead(doc, source, headerInfo, onClose) {
    const head = doc.createElement('div');
    head.className = 'w8-history-detail-head';

    const heading = doc.createElement('div');
    heading.className = 'w8-history-detail-heading';
    heading.append(buildTitleRow(doc, source, headerInfo.id, headerInfo.title, 'h4'));

    const meta = [headerInfo.kind, headerInfo.updatedAt].filter(Boolean).join(' · ');
    if (meta) {
      const p = doc.createElement('p');
      p.className = 'booth-mono-meta';
      p.textContent = meta;
      heading.append(p);
    }

    const actions = doc.createElement('div');
    actions.className = 'w8-history-detail-actions';
    if (headerInfo.url) {
      actions.append(makeExternalLink(doc, headerInfo.url, SOURCE_LABEL[source], headerInfo.title + ' 원본 열기'));
    }
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'booth-btn line slim w8-history-close';
    closeBtn.textContent = '닫기';
    closeBtn.addEventListener('click', onClose);
    actions.append(closeBtn);

    head.append(heading, actions);
    return head;
  }

  function buildDetailError(doc, message, onRetry) {
    const err = doc.createElement('p');
    err.className = 'booth-feedback w8-history-status-error';
    err.textContent = message;
    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.className = 'booth-btn line slim w8-history-detail-retry';
    retry.textContent = '다시 시도';
    retry.addEventListener('click', () => { void onRetry(); });
    return [err, retry];
  }

  function buildDetailBodyParts(doc, src, handlers) {
    const parts = [];
    const bodyEl = doc.createElement('div');
    bodyEl.className = src.detail.text ? 'w8-history-text' : 'booth-small';
    bodyEl.textContent = src.detail.text || '본문이 없어요.';
    parts.push(bodyEl);
    if (src.detail.links.length) parts.push(buildLinksSection(doc, src.detail.links));
    if (src.detail.attachments.length || src.detail.nextAttachmentCursor || src.attError) {
      parts.push(buildAttachmentsSection(doc, src, src.detail, handlers));
    }
    return parts;
  }

  function buildDetailContent(doc, source, src, handlers) {
    const fallback = src.items.find(it => it.id === src.selectedId)
      || { id: src.selectedId, title: src.selectedId, url: '', kind: '', updatedAt: '' };
    const parts = [buildDetailHead(doc, source, src.detail || fallback, handlers.onClose)];

    if (src.detailLoading) {
      const loading = doc.createElement('p');
      loading.className = 'booth-feedback';
      loading.textContent = '내용을 불러오는 중…';
      parts.push(loading);
      return parts;
    }
    if (src.detailError) {
      parts.push(...buildDetailError(doc, src.detailError, handlers.onRetryDetail));
      return parts;
    }
    if (!src.detail) return parts;
    return parts.concat(buildDetailBodyParts(doc, src, handlers));
  }

  function computeSourceStatus(source, src, jiraConnecting, authExpired) {
    if (authExpired) return 'Atlassian 연결이 만료됐어요. 다시 연결한 뒤 불러와 주세요.';
    if (source === 'jira' && jiraConnecting) return 'Jira 읽기 권한을 연결하는 중…';
    if (!src) return '';
    if (src.loading) return SOURCE_LABEL[source] + ' 기록을 불러오는 중…';
    if (src.errorMessage) return src.errorMessage;
    if (src.loaded && !src.items.length) return '표시할 ' + SOURCE_LABEL[source] + ' 기록이 없어요.';
    return '';
  }

  function cloneDetailSnapshot(detail) {
    if (!detail) return null;
    return Object.assign({}, detail, {
      links: detail.links.map(l => Object.assign({}, l)),
      attachments: detail.attachments.map(a => Object.assign({}, a)),
    });
  }

  function cloneSourceSnapshot(src) {
    return {
      loaded: src.loaded,
      loading: src.loading,
      loadingMore: src.loadingMore,
      nextCursor: src.nextCursor,
      errorMessage: src.errorMessage,
      scopeRequired: src.scopeRequired,
      selectedId: src.selectedId,
      detailLoading: src.detailLoading,
      detailError: src.detailError,
      attLoadingMore: src.attLoadingMore,
      attError: src.attError,
      activeTextAttId: src.activeTextAttId,
      items: src.items.map(it => Object.assign({}, it)),
      detail: cloneDetailSnapshot(src.detail),
    };
  }

  function createInitialState() {
    return {
      activeSource: '',
      authExpired: false,
      jiraConnecting: false,
      externalBusy: false,
      openingFileKey: '',
      sessionGen: 0,
      jiraConnectGen: 0,
      openPdfGen: 0,
      destroyed: false,
      sources: {
        confluence: createSourceState(),
        jira: createSourceState(),
      },
    };
  }

  function addTrackedListener(listeners, target, type, fn) {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(type, fn);
    listeners.push(() => {
      if (typeof target.removeEventListener === 'function') target.removeEventListener(type, fn);
    });
  }

  function bindEventListeners(nodes, d, actions, listeners) {
    addTrackedListener(listeners, nodes.tabs.confluence, 'click', () => { void actions.selectSource('confluence'); });
    addTrackedListener(listeners, nodes.tabs.jira, 'click', () => { void actions.selectSource('jira'); });
    addTrackedListener(listeners, nodes.refresh, 'click', () => { void actions.refresh(); });
    addTrackedListener(listeners, nodes.retry, 'click', () => { void actions.retryActive(); });
    addTrackedListener(listeners, nodes.more, 'click', () => { void actions.loadMoreActive(); });
    addTrackedListener(listeners, nodes.jiraConnect, 'click', () => { void actions.connectJira(); });
    addTrackedListener(listeners, nodes.syncDisconnect, 'click', () => { actions.clear({ authExpired: false }); });
    addTrackedListener(listeners, d.doc, 'falsify:w8-paper-sync', event => {
      const status = event?.detail?.status;
      if (status === 'disconnected') actions.clear({ authExpired: false });
      else if (status === 'expired') actions.clear({ authExpired: true });
    });
  }

  function observeSyncRoot(nodes, d, onStateChange) {
    if (!nodes.syncRoot || typeof d.ObserverCtor !== 'function') return null;
    const observer = new d.ObserverCtor(() => {
      const stateName = nodes.syncRoot.dataset?.syncState || nodes.syncRoot.getAttribute?.('data-sync-state') || '';
      onStateChange(stateName);
    });
    try { observer.observe(nodes.syncRoot, { attributes: true, attributeFilter: ['data-sync-state'] }); } catch {}
    return observer;
  }

  function paintTabsDom(nodes, connected, activeSource) {
    for (const source of SOURCES) {
      const tab = nodes.tabs[source];
      if (tab) tab.setAttribute('aria-selected', connected && activeSource === source ? 'true' : 'false');
    }
    if (nodes.body && activeSource) {
      nodes.body.setAttribute('aria-labelledby', 'w8-history-tab-' + activeSource);
    }
  }

  function paintRefreshRetryDom(nodes, active, src, jiraConnecting) {
    const busyList = Boolean(src && (src.loading || src.loadingMore));
    if (nodes.refresh) {
      nodes.refresh.hidden = !active || Boolean(src?.scopeRequired);
      nodes.refresh.disabled = busyList || jiraConnecting;
    }
    if (nodes.retry) {
      const showRetry = active && Boolean(src.errorMessage) && !src.scopeRequired && !busyList;
      nodes.retry.hidden = !showRetry;
      nodes.retry.disabled = busyList;
    }
  }

  function paintJiraActionDom(nodes, active, activeSource, src, jiraConnecting) {
    const show = active && activeSource === 'jira' && Boolean(src?.scopeRequired);
    if (nodes.actions) nodes.actions.hidden = !show;
    if (nodes.jiraConnect) {
      nodes.jiraConnect.hidden = !show;
      nodes.jiraConnect.disabled = jiraConnecting;
    }
  }

  function paintStatusDom(nodes, source, src, st) {
    if (!nodes.status) return;
    nodes.status.textContent = computeSourceStatus(source, src, st.jiraConnecting, st.authExpired);
    const isErr = Boolean(st.authExpired || (src && src.errorMessage && !src.loading));
    nodes.status.classList?.toggle?.('w8-history-status-error', isErr);
  }

  function paintMoreDom(nodes, connected, src) {
    if (!nodes.more) return;
    nodes.more.hidden = !connected || !src || !src.nextCursor || src.loading || src.scopeRequired;
    nodes.more.disabled = Boolean(src?.loadingMore);
    nodes.more.textContent = src?.loadingMore ? '불러오는 중…' : '더 보기';
  }

  function updateListItemFromDetail(src, detail) {
    const hit = src.items.find(it => it.id === detail.id);
    if (!hit) return;
    if (detail.title) hit.title = detail.title;
    if (detail.url) hit.url = detail.url;
    if (detail.updatedAt) hit.updatedAt = detail.updatedAt;
  }

  function attachmentPayload(att) {
    return { id: att.id, title: att.title, type: att.type, url: att.url };
  }

  function mount(options = {}) {
    const d = resolveDeps(options);
    const nodes = queryNodes(d.doc);
    const listeners = [];
    const st = createInitialState();

    function isConnected() {
      return Boolean(typeof d.team?.isConnected === 'function' && d.team.isConnected());
    }

    function currentSyncBase() {
      const cfgBase = options.configBase ?? root?.FalsifyCloudConfig?.apiBase ?? '';
      return resolveSyncBase(d.doc, d.paperSync, cfgBase, d.locationHref);
    }

    function isStaleList(source, sGen, lGen) {
      return st.destroyed || sGen !== st.sessionGen || lGen !== st.sources[source].listGen || !isConnected();
    }

    function isStaleDetail(source, id, sGen, dGen) {
      const src = st.sources[source];
      return st.destroyed || sGen !== st.sessionGen || dGen !== src.detailGen || src.selectedId !== id || !isConnected();
    }

    function isStaleAttPage(source, id, sGen, dGen, aGen) {
      const src = st.sources[source];
      return isStaleDetail(source, id, sGen, dGen) || aGen !== src.attGen || !src.detail || src.detail.id !== id;
    }

    function isStalePdf(sGen, pGen) {
      return st.destroyed || sGen !== st.sessionGen || pGen !== st.openPdfGen || !isConnected();
    }

    function paintList(connected, source, src) {
      if (nodes.list && typeof d.doc?.createElement === 'function') {
        const rows = connected && src && src.items.length
          ? src.items.map(item => buildItemNode(d.doc, source, item, {
            selected: src.selectedId === item.id,
            onSelect: it => openItem(source, it.id),
          }))
          : [];
        nodes.list.replaceChildren(...rows);
      }
      paintMoreDom(nodes, connected, src);
    }

    function paintDetail(connected, source, src, busyPdf) {
      if (!nodes.detail || typeof d.doc?.createElement !== 'function') return;
      if (!connected || !src || !src.selectedId) {
        nodes.detail.hidden = true;
        nodes.detail.replaceChildren();
        return;
      }
      nodes.detail.hidden = false;
      const parts = buildDetailContent(d.doc, source, src, {
        busyPdf,
        onClose: () => closeDetail(source),
        onRetryDetail: () => loadDetail(source, src.selectedId),
        onMoreAttachments: () => loadMoreAttachments(source, src.selectedId),
        onOpenAttachment: att => openAttachment(source, src.selectedId, att),
      });
      nodes.detail.replaceChildren(...parts);
    }

    function paint() {
      if (st.destroyed) return;
      const connected = isConnected() && !st.authExpired;
      const source = connected ? st.activeSource : '';
      const src = source ? st.sources[source] : null;
      const busyPdf = st.externalBusy || Boolean(st.openingFileKey) || Boolean(d.isBusy());
      paintTabsDom(nodes, connected, source);
      if (nodes.body) nodes.body.hidden = !(st.authExpired || Boolean(src));
      paintStatusDom(nodes, source, src, st);
      paintRefreshRetryDom(nodes, Boolean(src), src, st.jiraConnecting);
      paintJiraActionDom(nodes, Boolean(src), source, src, st.jiraConnecting);
      paintList(connected, source, src);
      paintDetail(connected, source, src, busyPdf);
    }

    function clear(opts = {}) {
      if (st.destroyed) return;
      st.sessionGen += 1;
      st.jiraConnectGen += 1;
      st.openPdfGen += 1;
      st.activeSource = '';
      st.jiraConnecting = false;
      st.openingFileKey = '';
      st.authExpired = Boolean(opts.authExpired);
      resetSourceState(st.sources.confluence);
      resetSourceState(st.sources.jira);
      paint();
    }

    function closeDetail(source) {
      if (st.destroyed || !isValidSource(source)) return;
      resetDetailState(st.sources[source]);
      paint();
    }

    function handleSourceScopeError(source, src) {
      src.loading = false;
      src.loadingMore = false;
      src.detailLoading = false;
      src.attLoadingMore = false;
      src.openingAttId = '';
      src.scopeRequired = true;
      src.errorMessage = ERROR_COPY.jira_scope_required;
      if (source === 'jira') resetDetailState(src);
      paint();
    }

    function handleSourceError(source, err, onLocalError) {
      if (source === 'jira' && isJiraScopeError(err)) {
        handleSourceScopeError(source, st.sources[source]);
        return;
      }
      if (isAuthFailure(err)) {
        clear({ authExpired: true });
        return;
      }
      onLocalError(err);
      paint();
    }

    function beginListLoad(src, reset) {
      src.errorMessage = '';
      src.failedOnMore = false;
      src.scopeRequired = false;
      st.authExpired = false;
      if (reset) {
        src.loading = true;
        src.loadingMore = false;
        src.items = [];
        src.nextCursor = '';
        resetDetailState(src);
      } else {
        src.loadingMore = true;
      }
      paint();
    }

    function applyListResult(source, res, reset) {
      const src = st.sources[source];
      const clean = sanitizeArray(res?.items, item => sanitizeHistoryItem(item, source));
      src.items = reset ? clean : mergeUniqueById(src.items, clean);
      src.nextCursor = cleanCursor(res?.nextCursor);
      src.loaded = true;
      src.loading = false;
      src.loadingMore = false;
      src.errorMessage = '';
      src.failedOnMore = false;
      src.scopeRequired = false;
      paint();
    }

    function markListUnconfigured(src) {
      src.loaded = true;
      src.loading = false;
      src.loadingMore = false;
      src.errorMessage = ERROR_COPY.not_configured;
      paint();
    }

    async function loadSource(source, { reset = true } = {}) {
      if (st.destroyed || !isValidSource(source)) return;
      if (!isConnected()) { clear({ authExpired: st.authExpired }); return; }
      const src = st.sources[source];
      const syncBase = currentSyncBase();
      if (!syncBase || typeof d.team?.historyList !== 'function') { markListUnconfigured(src); return; }
      const cursor = reset ? '' : src.nextCursor;
      const sGen = st.sessionGen;
      const lGen = ++src.listGen;
      beginListLoad(src, reset);
      try {
        const res = await d.team.historyList(source, cursor ? { cursor, base: syncBase } : { base: syncBase });
        if (isStaleList(source, sGen, lGen)) return;
        applyListResult(source, res, reset);
      } catch (err) {
        if (st.destroyed || sGen !== st.sessionGen || lGen !== src.listGen) return;
        handleSourceError(source, err, () => {
          src.loading = false;
          src.loadingMore = false;
          src.failedOnMore = !reset;
          src.errorMessage = historyErrorMessage(err, source);
        });
      }
    }

    function selectSource(source) {
      if (st.destroyed || !isValidSource(source) || Boolean(nodes.panel?.hidden)) return Promise.resolve();
      if (!isConnected()) { clear({ authExpired: st.authExpired }); return Promise.resolve(); }
      st.activeSource = source;
      st.authExpired = false;
      const src = st.sources[source];
      paint();
      return !src.loaded && !src.loading && !src.scopeRequired ? loadSource(source, { reset: true }) : Promise.resolve();
    }

    function applyDetailResult(source, src, id, res) {
      const fallback = src.items.find(it => it.id === id) || { id };
      src.detail = sanitizeHistoryDetail(res, fallback, source);
      updateListItemFromDetail(src, src.detail);
      src.detailLoading = false;
      src.detailError = '';
      paint();
      if (st.activeSource === source && !nodes.panel?.hidden && d.doc.activeElement === d.doc.body) {
        nodes.detail?.focus?.();
      }
    }

    async function loadDetail(source, id) {
      if (st.destroyed || !isValidSource(source) || !id) return;
      if (!isConnected()) { clear({ authExpired: true }); return; }
      const src = st.sources[source];
      const syncBase = currentSyncBase();
      if (!syncBase || typeof d.team?.historyDetail !== 'function') {
        src.selectedId = id;
        src.detailLoading = false;
        src.detailError = ERROR_COPY.not_configured;
        paint();
        return;
      }
      resetDetailState(src);
      src.selectedId = id;
      src.detailLoading = true;
      const sGen = st.sessionGen;
      const dGen = ++src.detailGen;
      paint();
      try {
        const res = await d.team.historyDetail(source, id, { base: syncBase });
        if (isStaleDetail(source, id, sGen, dGen)) return;
        applyDetailResult(source, src, id, res);
      } catch (err) {
        if (st.destroyed || sGen !== st.sessionGen || dGen !== src.detailGen || src.selectedId !== id) return;
        handleSourceError(source, err, () => {
          src.detailLoading = false;
          src.detailError = historyErrorMessage(err, source);
        });
      }
    }

    function openItem(source, id) {
      if (st.destroyed || !isValidSource(source) || !id) return Promise.resolve();
      const src = st.sources[source];
      if (src.selectedId === id && src.detail && !src.detailLoading && !src.detailError) {
        closeDetail(source);
        return Promise.resolve();
      }
      return loadDetail(source, id);
    }

    function canPageAttachments(src, id) {
      return Boolean(src.detail && src.detail.id === id && src.detail.nextAttachmentCursor && !src.attLoadingMore);
    }

    function applyAttachmentPage(src, res) {
      const incoming = sanitizeArray(res?.attachments, sanitizeAttachment);
      src.detail.attachments = mergeUniqueById(src.detail.attachments, incoming);
      src.detail.nextAttachmentCursor = cleanCursor(res?.nextAttachmentCursor);
      src.attLoadingMore = false;
      paint();
    }

    async function loadMoreAttachments(source, id) {
      if (st.destroyed || !isValidSource(source) || !id) return;
      if (!isConnected()) { clear({ authExpired: true }); return; }
      const src = st.sources[source];
      const syncBase = currentSyncBase();
      if (!canPageAttachments(src, id) || !syncBase || typeof d.team?.historyDetail !== 'function') return;
      const sGen = st.sessionGen;
      const dGen = src.detailGen;
      const aGen = ++src.attGen;
      src.attLoadingMore = true;
      src.attError = '';
      paint();
      try {
        const res = await d.team.historyDetail(source, id, { base: syncBase, attachmentCursor: src.detail.nextAttachmentCursor });
        if (isStaleAttPage(source, id, sGen, dGen, aGen)) return;
        applyAttachmentPage(src, res);
      } catch (err) {
        if (st.destroyed || sGen !== st.sessionGen || dGen !== src.detailGen || aGen !== src.attGen) return;
        handleSourceError(source, err, () => {
          src.attLoadingMore = false;
          src.attError = historyErrorMessage(err, source);
        });
      }
    }

    function toggleCachedTextPreview(src, att) {
      if (src.activeTextAttId === att.id) {
        src.activeTextAttId = '';
        paint();
        return true;
      }
      if (src.textPreviews.has(att.id)) {
        src.activeTextAttId = att.id;
        paint();
        return true;
      }
      return false;
    }

    function storeTextPreview(src, att, res) {
      if (!isObj(res) || typeof res.text !== 'string') throw new Error('텍스트 첨부를 읽지 못했어요.');
      src.textPreviews.set(att.id, {
        title: att.title,
        text: cleanInertText(res.text),
        truncated: Boolean(res.truncated),
        url: att.url,
      });
      src.activeTextAttId = att.id;
      src.openingAttId = '';
      paint();
    }

    async function openTextAttachment(source, itemId, att) {
      const src = st.sources[source];
      if (toggleCachedTextPreview(src, att)) return;
      const syncBase = currentSyncBase();
      if (!syncBase || typeof d.team?.historyFile !== 'function') {
        src.attErrorMap.set(att.id, ERROR_COPY.not_configured);
        paint();
        return;
      }
      const sGen = st.sessionGen;
      const dGen = src.detailGen;
      const fGen = ++src.fileGen;
      src.openingAttId = att.id;
      src.attErrorMap.delete(att.id);
      paint();
      try {
        const res = await d.team.historyFile(source, itemId, attachmentPayload(att), { base: syncBase });
        if (isStaleDetail(source, itemId, sGen, dGen) || fGen !== src.fileGen) return;
        storeTextPreview(src, att, res);
      } catch (err) {
        if (st.destroyed || sGen !== st.sessionGen || dGen !== src.detailGen || fGen !== src.fileGen) return;
        handleSourceError(source, err, () => {
          src.openingAttId = '';
          src.attErrorMap.set(att.id, err?.message || '텍스트 첨부를 불러오지 못했어요.');
        });
      }
    }

    async function runPdfAttachmentOpen(source, itemId, att, sGen, pGen) {
      const syncBase = currentSyncBase();
      if (!syncBase || typeof d.team?.historyFile !== 'function' || typeof d.openFile !== 'function') {
        throw new Error('첨부 PDF를 불러올 수 없어요.');
      }
      const blob = await d.team.historyFile(source, itemId, attachmentPayload(att), { base: syncBase });
      if (isStalePdf(sGen, pGen)) return;
      const bytes = await readBytes(blob);
      if (isStalePdf(sGen, pGen)) return;
      if (!bytes || !hasPdfMagic(bytes)) throw new Error('첨부 파일이 유효한 PDF가 아니에요.');
      const title = att.title || st.sources[source].detail?.title || 'paper';
      await d.openFile(makePdfFile(bytes, title, d.fileCtor), { title });
    }

    function finishPdfAttempt(src, attId, sGen, pGen) {
      if (st.destroyed || sGen !== st.sessionGen || pGen !== st.openPdfGen) return;
      st.openingFileKey = '';
      if (src.openingAttId === attId) src.openingAttId = '';
      paint();
    }

    async function openPdfAttachment(source, itemId, att) {
      if (st.externalBusy || d.isBusy()) return;
      const src = st.sources[source];
      const sGen = st.sessionGen;
      const pGen = ++st.openPdfGen;
      src.openingAttId = att.id;
      st.openingFileKey = source + ':' + itemId + ':' + att.id;
      src.attErrorMap.delete(att.id);
      paint();
      try {
        await runPdfAttachmentOpen(source, itemId, att, sGen, pGen);
      } catch (err) {
        if (st.destroyed || sGen !== st.sessionGen || pGen !== st.openPdfGen) return;
        handleSourceError(source, err, () => {
          src.attErrorMap.set(att.id, err?.message || '첨부 PDF를 불러오지 못했어요.');
        });
      } finally {
        finishPdfAttempt(src, att.id, sGen, pGen);
      }
    }

    function openAttachment(source, itemId, attachment) {
      if (st.destroyed || !isValidSource(source) || !itemId || !attachment?.id) return Promise.resolve();
      if (!isConnected()) { clear({ authExpired: true }); return Promise.resolve(); }
      if (attachment.type === 'pdf') return openPdfAttachment(source, itemId, attachment);
      if (attachment.type === 'text') return openTextAttachment(source, itemId, attachment);
      return Promise.resolve();
    }

    function isStaleJiraConnect(sGen, cGen) {
      return st.destroyed || sGen !== st.sessionGen || cGen !== st.jiraConnectGen;
    }

    function handleJiraConnectError(err, sGen, cGen) {
      if (isStaleJiraConnect(sGen, cGen)) return;
      st.jiraConnecting = false;
      if (!isConnected() || isAuthFailure(err)) { clear({ authExpired: true }); return; }
      st.sources.jira.scopeRequired = true;
      st.sources.jira.errorMessage = historyErrorMessage(err, 'jira');
      paint();
    }

    async function connectJira() {
      if (st.destroyed || st.jiraConnecting) return null;
      if (!isConnected()) { clear({ authExpired: true }); return null; }
      const syncBase = currentSyncBase();
      if (!syncBase || typeof d.team?.connectHistory !== 'function') {
        st.sources.jira.errorMessage = ERROR_COPY.not_configured;
        paint();
        return null;
      }
      const sGen = st.sessionGen;
      const cGen = ++st.jiraConnectGen;
      st.jiraConnecting = true;
      st.sources.jira.errorMessage = '';
      paint();
      try {
        const res = await d.team.connectHistory({ base: syncBase });
        if (isStaleJiraConnect(sGen, cGen)) return null;
        st.jiraConnecting = false;
        if (!isConnected()) { clear({ authExpired: true }); return null; }
        st.sources.jira.scopeRequired = false;
        await loadSource('jira', { reset: true });
        return res;
      } catch (err) {
        handleJiraConnectError(err, sGen, cGen);
        return null;
      }
    }

    function handleSyncStateChange(stateName) {
      if (st.destroyed) return;
      if (stateName === 'disconnected') { clear({ authExpired: false }); return; }
      if (stateName === 'expired') { clear({ authExpired: true }); return; }
      if ((stateName === 'connected' || stateName === 'synced') && isConnected()) {
        st.authExpired = false;
        paint();
      }
    }

    function refresh() {
      return st.activeSource ? loadSource(st.activeSource, { reset: true }) : Promise.resolve();
    }

    function retryActive() {
      if (!st.activeSource) return Promise.resolve();
      const src = st.sources[st.activeSource];
      return loadSource(st.activeSource, { reset: !src.failedOnMore });
    }

    function loadMore(source) {
      const target = isValidSource(source) ? source : st.activeSource;
      if (!target) return Promise.resolve();
      const src = st.sources[target];
      return !src.loadingMore && src.nextCursor ? loadSource(target, { reset: false }) : Promise.resolve();
    }

    function setBusy(value) {
      st.externalBusy = Boolean(value);
      paint();
    }

    function snapshotState() {
      return {
        activeSource: st.activeSource,
        connected: isConnected() && !st.authExpired,
        authExpired: st.authExpired,
        jiraConnecting: st.jiraConnecting,
        openingFileKey: st.openingFileKey,
        sources: {
          confluence: cloneSourceSnapshot(st.sources.confluence),
          jira: cloneSourceSnapshot(st.sources.jira),
        },
      };
    }

    let observer = observeSyncRoot(nodes, d, handleSyncStateChange);
    bindEventListeners(nodes, d, {
      selectSource,
      refresh,
      retryActive,
      loadMoreActive: () => loadMore(),
      connectJira,
      clear,
    }, listeners);
    paint();

    function destroy() {
      if (st.destroyed) return;
      st.destroyed = true;
      st.sessionGen += 1;
      st.jiraConnectGen += 1;
      st.openPdfGen += 1;
      st.sources.confluence.listGen += 1;
      st.sources.jira.listGen += 1;
      if (observer) { try { observer.disconnect(); } catch {} observer = null; }
      for (const off of listeners.splice(0)) off();
    }

    return {
      selectSource,
      refresh,
      loadMore,
      openItem,
      closeDetail,
      loadMoreAttachments,
      openAttachment,
      connectJira,
      clear,
      setBusy,
      state: snapshotState,
      destroy,
    };
  }

  return Object.freeze({
    mount,
    allowedSiteUrl,
    safeHttpsUrl,
    resolveSyncBase,
    sanitizeHistoryItem,
    sanitizeHistoryDetail,
    sanitizeAttachment,
    sanitizeLink,
  });
});
