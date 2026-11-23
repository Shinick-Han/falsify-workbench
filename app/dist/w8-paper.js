/* Stage 1 PDF editor adapter for the public W8 Workbench (window.FalsifyW8Paper).
   Bridges legacy index DOM (#paper-file, #paper-workspace) with direct-in-PDF editing
   (booth-pageedit.js + FalsifyBoothEdits), mandatory blind-pdf checks (FalsifyBlindPdf),
   stable MuPDF export (FalsifyBrowserPdf.rewrite), and automatic multi-day private local
   persistence (recent source list, keyed resume, edits, page, exact final artifact bytes)
   reusing the falsify.paper-source.v1 IndexedDB store.
   Original Workbench code, AGPL-3.0-only. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    const doc = root.document;
    const instance = doc && typeof doc.getElementById === 'function' ? api.create({document: doc, root}) : null;
    root.FalsifyW8Paper = instance || api;
  }
})(typeof window === 'object' ? window : globalThis, function (globalRoot) {
  'use strict';

  const DRAFT_SCHEMA = 'falsify.w8-paper-draft.v1';
  const DRAFT_KEY = 'falsify.w8-paper.draft.v1';
  const DRAFT_ITEM_PREFIX = 'falsify.w8-paper.draft.v1.';
  const RECENT_INDEX_KEY = 'falsify.w8-paper.recent.v1';
  const SOURCE_DB_NAME = 'falsify.paper-source.v1';
  const SOURCE_STORE = 'files';
  const ARTIFACT_PREFIX = 'w8-artifact:';
  const sourceKey = hash => 'w8-source:' + hash;
  const TTL_MS = Infinity;
  const OPEN_TIMEOUT_MS = 65000;
  const HEX64 = /^[0-9a-f]{64}$/;
  const PDF_ERROR_TEXT = Object.freeze({
    invalid_file: 'PDF 파일만 열 수 있습니다.',
    pdf_corrupt: 'PDF 구조를 읽지 못했습니다. 다른 파일을 선택하세요.',
    pdf_encrypted: '암호가 걸린 PDF는 열 수 없습니다.',
    pdf_unreadable: '이 브라우저에서 PDF를 열지 못했습니다.',
    pdf_timeout: 'PDF를 여는 시간이 초과되었습니다. 다시 시도하세요.',
    superseded: '새 PDF를 열어 이전 불러오기를 중단했습니다.',
    no_source: '열린 PDF가 없습니다.',
    blind_unavailable: '블라인드 검사 모듈을 불러오지 못했습니다.',
    engine_unavailable: 'PDF 내보내기 엔진을 불러오지 못했습니다.',
    pdf_unchanged: '수정한 내용이 PDF에 반영되지 않았습니다. 수정 위치를 확인하세요.',
    source_changed: 'PDF 내보내기 중 다른 파일로 바뀌었습니다.',
    missing_source: '저장된 원본 PDF를 찾지 못했습니다. 파일을 다시 선택하세요.',
    hash_mismatch: '선택한 파일이 저장된 작업의 원본 PDF와 다릅니다.',
    aborted: '작업을 취소했습니다.',
  });

  const INTEGRATOR_NODES = Object.freeze({
    fileInput: '#paper-file',
    workspace: '#paper-workspace',
    stage: '#paper-before-stage',
    toolbar: '#paper-workspace .paper-toolbar',
    pageControls: Object.freeze(['#paper-page-prev', '#paper-page-label', '#paper-page-jump', '#paper-page-next']),
    statusNodes: Object.freeze(['#paper-workspace-status', '#paper-before-status']),
    mountedByPageEdit: Object.freeze(['#booth-pe-bar', '#booth-pe-pop', '#booth-pe-sheet']),
    hideableLegacyNodes: Object.freeze([
      '#paper-original-download',
      '#paper-zoom-out',
      '#paper-zoom-label',
      '#paper-zoom-in',
      '.paper-edit-tools',
      '.paper-font-tools',
      '.paper-compare-tools',
      '.paper-pane:has(#paper-after-stage)',
      '#paper-inline',
      '#paper-edits',
      '#paper-undo',
      '#paper-redo',
      '#paper-generate',
      '#paper-generate-cancel',
      '#paper-current-download',
      '.paper-share',
      '.paper-draft',
      '#paper-proposals',
      '#paper-external-mount',
      '.paper-paragraph-list',
    ]),
    htmlAttribute: 'data-booth-step="edit"',
    scripts: Object.freeze(['booth-edits.js', 'booth-pageedit.js', 'w8-paper.js']),
    stylesheets: Object.freeze(['paper-workspace.css', 'booth-pageedit.css']),
    events: Object.freeze(['falsify:w8-paper-change']),
  });

  function makeError(code, message) {
    const err = new Error(message || PDF_ERROR_TEXT[code] || 'PDF 작업 중 오류가 발생했습니다.');
    err.code = code || 'error';
    return err;
  }

  function sanitizeName(value) {
    const clean = String(value || '')
      .replace(/[\u0000-\u001f\u007f\\/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    return clean || 'document.pdf';
  }

  function ensurePdfExt(name) {
    return /\.pdf$/i.test(name) ? name : name + '.pdf';
  }

  function outputFileName(sourceName, edited, options) {
    if (options && typeof options.filename === 'string' && options.filename.trim()) {
      return ensurePdfExt(sanitizeName(options.filename));
    }
    if (options && options.neutral) return 'paper.pdf';
    const stem = sanitizeName(sourceName).replace(/\.pdf$/i, '') || 'document';
    const suffix = edited ? '-edited.pdf' : '.pdf';
    return stem.slice(0, Math.max(1, 160 - suffix.length)) + suffix;
  }

  function isPdfSignatureAt(head, i) {
    return head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44
      && head[i + 3] === 0x46 && head[i + 4] === 0x2d;
  }

  function hasPdfMagic(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5) return false;
    const head = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
    for (let i = 0; i <= head.length - 5; i += 1) {
      if (isPdfSignatureAt(head, i)) return true;
    }
    return false;
  }

  async function readBytes(fileLike) {
    if (fileLike instanceof Uint8Array) return new Uint8Array(fileLike);
    if (fileLike instanceof ArrayBuffer) return new Uint8Array(fileLike);
    if (ArrayBuffer.isView(fileLike)) return new Uint8Array(fileLike.buffer, fileLike.byteOffset, fileLike.byteLength);
    if (fileLike && fileLike.bytes instanceof Uint8Array) return new Uint8Array(fileLike.bytes);
    if (fileLike && typeof fileLike.arrayBuffer === 'function') return new Uint8Array(await fileLike.arrayBuffer());
    return null;
  }

  function makePdfFile(bytes, name, lastModified) {
    const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes || 0);
    const fileName = ensurePdfExt(sanitizeName(name));
    if (typeof File === 'function') {
      const opts = {type: 'application/pdf'};
      if (Number.isFinite(lastModified)) opts.lastModified = lastModified;
      return new File([copy], fileName, opts);
    }
    return {
      name: fileName,
      type: 'application/pdf',
      size: copy.byteLength,
      bytes: copy,
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
    };
  }

  function clampUnit(n) {
    return Math.min(1, Math.max(0, Number(n)));
  }

  function inUnit(n) {
    return Number.isFinite(n) && n >= 0 && n <= 1;
  }

  function validRect(r) {
    return !!r && typeof r === 'object'
      && inUnit(r.x) && inUnit(r.y)
      && Number.isFinite(r.w) && Number.isFinite(r.h)
      && r.w > 0 && r.h > 0;
  }

  function cleanRect(r) {
    return {x: clampUnit(r.x), y: clampUnit(r.y), w: clampUnit(r.w), h: clampUnit(r.h)};
  }

  function validEditPage(pageIndex) {
    return Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex <= 9999;
  }

  function validEditText(edit) {
    return typeof edit.originalText === 'string'
      && typeof edit.newText === 'string'
      && edit.originalText !== edit.newText;
  }

  function cleanBoothEdit(edit) {
    if (!edit || typeof edit !== 'object' || !validEditPage(edit.pageIndex)) return null;
    if (!Array.isArray(edit.rects) || !edit.rects.length || !edit.rects.every(validRect)) return null;
    if (!validEditText(edit)) return null;
    const out = {
      pageIndex: edit.pageIndex,
      rects: edit.rects.map(cleanRect),
      originalText: edit.originalText,
      newText: edit.newText,
      source: typeof edit.source === 'string' && edit.source ? edit.source.slice(0, 32) : 'tap',
    };
    if (typeof edit.id === 'string' && edit.id) out.id = edit.id.slice(0, 80);
    if (out.source === 'myai' && typeof edit.assist?.reason === 'string' && edit.assist.reason) {
      out.assist = {kind: 'my-ai', reason: edit.assist.reason};
    }
    return out;
  }

  function normBoothEdit(e) {
    return {
      p: e.pageIndex,
      r: e.rects.map(q => [Math.round(q.x * 1e6), Math.round(q.y * 1e6), Math.round(q.w * 1e6), Math.round(q.h * 1e6)]),
      o: e.originalText,
      n: e.newText,
      s: e.source || 'tap',
    };
  }

  function normWsEdit(e) {
    return {
      id: e.id || '',
      p: e.pageIndex,
      seg: e.segmentId || '',
      b: e.before || '',
      a: e.after || '',
      st: e.anchor && e.anchor.start,
      en: e.anchor && e.anchor.end,
    };
  }

  function canonicalSpecKey(sourceSha256, boothEdits, wsEdits) {
    return JSON.stringify({
      h: sourceSha256,
      b: boothEdits.map(normBoothEdit),
      w: wsEdits.map(normWsEdit),
    });
  }

  function cloneSafe(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
  }

  function validDraftHeader(parsed, nowMs) {
    if (!parsed || typeof parsed !== 'object' || parsed.schema !== DRAFT_SCHEMA) return false;
    if (!HEX64.test(parsed.fileHash || '')) return false;
    if (!Number.isSafeInteger(parsed.savedAt) || !Number.isSafeInteger(parsed.expiresAt)) return false;
    return parsed.expiresAt > nowMs && parsed.savedAt <= nowMs + 60000;
  }

  function normalizeDraftPage(parsed) {
    const pageCount = Number.isInteger(parsed.pageCount) && parsed.pageCount > 0 ? parsed.pageCount : 0;
    const rawPage = Number.isInteger(parsed.page) && parsed.page >= 1 ? parsed.page : 1;
    const page = pageCount > 0 ? Math.min(rawPage, pageCount) : rawPage;
    return {page, pageCount};
  }

  function cleanDraftKey(value) {
    return typeof value === 'string' && value.startsWith(ARTIFACT_PREFIX) && value.length <= 128 ? value : null;
  }

  function normalizeDraftRecord(parsed) {
    const edits = Array.isArray(parsed.edits) ? parsed.edits.map(cleanBoothEdit).filter(Boolean) : [];
    const {page, pageCount} = normalizeDraftPage(parsed);
    const rev = Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : edits.length;
    return {
      schema: DRAFT_SCHEMA,
      fileHash: parsed.fileHash,
      name: sanitizeName(parsed.name),
      page,
      pageCount,
      revision: rev,
      edits,
      hasSource: parsed.hasSource === true,
      lastArtifactSha256: HEX64.test(parsed.lastArtifactSha256 || '') ? parsed.lastArtifactSha256 : null,
      lastArtifactKey: cleanDraftKey(parsed.lastArtifactKey),
      savedAt: parsed.savedAt,
      expiresAt: parsed.expiresAt,
    };
  }

  function draftToSummary(rec) {
    return {
      fileHash: rec.fileHash,
      name: rec.name,
      page: rec.page,
      pageCount: rec.pageCount,
      editCount: rec.edits.length,
      revision: rec.revision,
      savedAt: rec.savedAt,
      expiresAt: rec.expiresAt,
      hasSource: rec.hasSource,
      lastArtifactSha256: rec.lastArtifactSha256,
    };
  }

  function normalizeResumeArg(arg) {
    if (typeof arg === 'string') return {fileHash: arg};
    return arg && typeof arg === 'object' ? arg : {};
  }

  function createIdbBlobStore(idb, isDisposed) {
    let opening = null;
    function openDb() {
      if (isDisposed()) return Promise.reject(new Error('Disposed'));
      if (!opening) {
        opening = new Promise((resolve, reject) => {
          const req = idb.open(SOURCE_DB_NAME, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(SOURCE_STORE)) db.createObjectStore(SOURCE_STORE);
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }).catch(err => { opening = null; throw err; });
      }
      return opening;
    }
    async function txRun(mode, op) {
      const db = await openDb();
      if (isDisposed()) throw new Error('Disposed');
      return new Promise((resolve, reject) => {
        let result;
        const tx = db.transaction(SOURCE_STORE, mode);
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        try { op(tx.objectStore(SOURCE_STORE), val => { result = val; }); }
        catch (err) { try { tx.abort(); } catch {} reject(err); }
      });
    }
    const call = (method, key, record) => txRun(method === 'get' ? 'readonly' : 'readwrite', (store, set) => {
      const q = method === 'put' ? store.put(record, key) : store[method](key);
      q.onsuccess = () => set(q.result);
    });
    return {
      get: key => call('get', key),
      put: (key, record) => call('put', key, record),
      delete: key => call('delete', key),
      dispose() {
        if (opening) opening.then(db => db.close(), () => {});
        opening = null;
      },
    };
  }

  function create(deps) {
    deps = deps || {};
    const root = deps.root || globalRoot;
    const doc = deps.document || root.document || null;
    const timers = deps.timers || root;
    const urls = deps.urls || root.URL;
    const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now());
    const ttlMs = Number.isFinite(deps.ttlMs) && deps.ttlMs > 0 ? deps.ttlMs : TTL_MS;
    const openTimeoutMs = Number.isFinite(deps.openTimeoutMs) && deps.openTimeoutMs > 0 ? deps.openTimeoutMs : OPEN_TIMEOUT_MS;

    const workspaceApi = () => deps.workspace || root.FalsifyPaperWorkspace || null;
    const boothEditsApi = () => deps.boothEdits || root.FalsifyBoothEdits || null;
    const pageEditApi = () => deps.pageEdit || root.FalsifyBoothPageEdit || null;
    const blindPdfApi = () => deps.blindPdf || root.FalsifyBlindPdf || null;
    const browserPdfApi = () => deps.browserPdf || root.FalsifyBrowserPdf || null;
    const paragraphPdfApi = () => deps.paragraphPdf || root.FalsifyParagraphPdf || null;
    const storageApi = () => {
      if (Object.hasOwn(deps, 'storage')) return deps.storage;
      try { return root.localStorage || null; } catch { return null; }
    };

    let blobStore = null;
    let disposed = false;

    function blobApi() {
      if (Object.hasOwn(deps, 'sourceBlobs')) return deps.sourceBlobs;
      if (!blobStore && root.indexedDB) blobStore = createIdbBlobStore(root.indexedDB, () => disposed);
      return blobStore;
    }

    async function sha256Hex(bytes) {
      const subtle = deps.subtle || (root.crypto && root.crypto.subtle) || (globalThis.crypto && globalThis.crypto.subtle);
      if (!subtle || typeof subtle.digest !== 'function') throw makeError('engine_unavailable', 'SHA-256을 계산할 수 없습니다.');
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const digest = await subtle.digest('SHA-256', u8);
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }

    async function artifactKeyFor(specKey) {
      const Encoder = root.TextEncoder || globalThis.TextEncoder;
      const hash = await sha256Hex(new Encoder().encode(specKey));
      return ARTIFACT_PREFIX + hash;
    }

    let sourceEpoch = 0;
    let openSeq = 0;
    let loading = false;
    let ready = false;
    let openingOwn = false;
    let suppressingEdits = false;
    let activeFile = null;
    let activeHash = null;
    let lastArxiv = null;
    let activeName = '';
    let activePage = 0;
    let activePageCount = 0;
    let revision = 0;
    let cachedArtifact = null;
    let inFlight = null;
    let activeResume = null;
    let draftTimer = null;
    let unsubBoothEdits = null;
    let subscribedStore = null;
    let stageObserver = null;
    let observedPageEl = null;
    let cancelPendingOpen = null;
    const listeners = [];

    function listen(target, type, fn, opts) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn, opts);
      listeners.push(() => { try { target.removeEventListener(type, fn, opts); } catch {} });
    }

    function ownsBoothStep() {
      return !!(doc && doc.documentElement && !doc.getElementById('booth'));
    }

    function ensureBoothSubscription() {
      const store = boothEditsApi();
      if (!store || typeof store.subscribe !== 'function' || subscribedStore === store) return;
      if (typeof unsubBoothEdits === 'function') { try { unsubBoothEdits(); } catch {} }
      subscribedStore = store;
      unsubBoothEdits = store.subscribe(() => {
        if (!suppressingEdits && !disposed) onCommittedEditsChanged('edit');
      });
    }

    function ensureEditorMounted(activate) {
      ensureBoothSubscription();
      if (!doc || !doc.documentElement) return false;
      if (activate !== false && ownsBoothStep()) doc.documentElement.dataset.boothStep = 'edit';
      const pe = pageEditApi();
      if (pe && typeof pe.mount === 'function') { try { pe.mount(doc, {force: true}); } catch {} }
      return !!doc.getElementById('booth-pe-bar');
    }

    function setEditActive(active) {
      if (!doc || !doc.documentElement) return false;
      if (ownsBoothStep()) doc.documentElement.dataset.boothStep = active ? 'edit' : 'view';
      if (active) ensureEditorMounted(true);
      return doc.documentElement.dataset.boothStep === 'edit';
    }

    function currentBoothEdits() {
      const store = boothEditsApi();
      if (!store || typeof store.list !== 'function') return [];
      try { return store.list().map(cleanBoothEdit).filter(Boolean); } catch { return []; }
    }

    function currentWorkspaceEdits() {
      const ws = workspaceApi();
      if (!ws || typeof ws.getEditSnapshot !== 'function') return [];
      try {
        const snap = ws.getEditSnapshot();
        const list = snap && Array.isArray(snap.edits) ? snap.edits : [];
        return list.filter(e => e && e.enabled !== false && e.after !== e.before);
      } catch { return []; }
    }

    function activeSourceInfo() {
      const ws = workspaceApi();
      const wsSrc = ws && typeof ws.getSource === 'function' ? ws.getSource() : null;
      if (wsSrc && wsSrc.file && HEX64.test(wsSrc.fileHash || '')) {
        return {file: wsSrc.file, fileHash: wsSrc.fileHash, name: sanitizeName(wsSrc.file.name || activeName)};
      }
      if (activeFile && HEX64.test(activeHash || '')) {
        return {file: activeFile, fileHash: activeHash, name: sanitizeName(activeName || activeFile.name)};
      }
      return null;
    }

    function syncPageFromWorkspace() {
      const ws = workspaceApi();
      if (!ws) return;
      const count = typeof ws.getPageCount === 'function' ? Number(ws.getPageCount()) || 0 : 0;
      const idx = typeof ws.getPageIndex === 'function' ? ws.getPageIndex() : null;
      if (count > 0) activePageCount = count;
      if (Number.isInteger(idx) && idx >= 0) activePage = idx + 1;
    }

    function currentSpecState() {
      const src = activeSourceInfo();
      if (!src) return null;
      const boothEdits = currentBoothEdits();
      const wsEdits = boothEdits.length ? [] : currentWorkspaceEdits();
      return {
        src,
        boothEdits,
        wsEdits,
        specKey: canonicalSpecKey(src.fileHash, boothEdits, wsEdits),
        editCount: boothEdits.length || wsEdits.length,
        revision,
        sourceEpoch,
      };
    }

    function readStorageItem(box, key) {
      if (!box || typeof box.getItem !== 'function') return null;
      try { return box.getItem(key); } catch { return null; }
    }

    function removeStorageItem(box, key) {
      if (!box || typeof box.removeItem !== 'function') return;
      try { box.removeItem(key); } catch {}
    }

    function readDraftByKey(box, key) {
      const raw = readStorageItem(box, key);
      if (!raw || typeof raw !== 'string') return null;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { return null; }
      if (!validDraftHeader(parsed, now())) {
        removeStorageItem(box, key);
        return null;
      }
      return normalizeDraftRecord(parsed);
    }

    function readRecentHashes(box) {
      const raw = readStorageItem(box, RECENT_INDEX_KEY);
      if (!raw || typeof raw !== 'string') return [];
      let list = null;
      try { list = JSON.parse(raw); } catch { return []; }
      if (!Array.isArray(list)) return [];
      const out = [];
      for (const h of list) {
        if (typeof h === 'string' && HEX64.test(h) && !out.includes(h)) out.push(h);
      }
      return out;
    }

    function writeRecentHashes(box, hashes) {
      if (!box || typeof box.setItem !== 'function') return;
      try {
        if (hashes.length) box.setItem(RECENT_INDEX_KEY, JSON.stringify(hashes));
        else removeStorageItem(box, RECENT_INDEX_KEY);
      } catch {}
    }

    function readAllDraftRecords() {
      const box = storageApi();
      if (!box) return [];
      const records = [];
      const seen = new Set();
      for (const h of readRecentHashes(box)) {
        const rec = readDraftByKey(box, DRAFT_ITEM_PREFIX + h);
        if (!rec || rec.fileHash !== h || seen.has(h)) continue;
        seen.add(h);
        records.push(rec);
      }
      const legacy = readDraftByKey(box, DRAFT_KEY);
      if (legacy && !seen.has(legacy.fileHash)) {
        seen.add(legacy.fileHash);
        records.unshift(legacy);
      }
      records.sort((a, b) => b.savedAt - a.savedAt);
      return records;
    }

    function arxivForPaper(hash, entry) {
      if (!HEX64.test(hash)) return null;
      if (!entry && lastArxiv?.hash === hash) return lastArxiv.entry;
      const key = 'falsify.w8.arxiv.' + hash;
      try {
        const saved = storageApi()?.getItem(key);
        entry ||= JSON.parse(saved || root.sessionStorage?.getItem(key) || 'null');
        if (entry && !saved) storageApi()?.setItem(key, JSON.stringify(entry));
      } catch {}
      lastArxiv = {hash, entry: entry || null};
      return lastArxiv.entry;
    }

    function readDraftRecord(expectedHash) {
      const box = storageApi();
      if (!box) return null;
      if (expectedHash) {
        if (!HEX64.test(expectedHash)) return null;
        const keyed = readDraftByKey(box, DRAFT_ITEM_PREFIX + expectedHash);
        if (keyed && keyed.fileHash === expectedHash) return keyed;
        const legacy = readDraftByKey(box, DRAFT_KEY);
        return legacy && legacy.fileHash === expectedHash ? legacy : null;
      }
      return readAllDraftRecords()[0] || null;
    }

    function recent() {
      return readAllDraftRecords().map(draftToSummary);
    }

    function resumableSummary() {
      const list = recent();
      return list.length ? list[0] : null;
    }

    function matchesCachedArtifact(src, specKey) {
      return !!(src && cachedArtifact
        && cachedArtifact.sourceEpoch === sourceEpoch
        && cachedArtifact.sourceSha256 === src.fileHash
        && cachedArtifact.specKey === specKey);
    }

    function freshArtifactSummary(src, specKey) {
      if (!matchesCachedArtifact(src, specKey)) return null;
      return {
        sha256: cachedArtifact.sha256,
        revision,
        changed: cachedArtifact.changed,
        editCount: cachedArtifact.editCount,
        name: cachedArtifact.file.name,
      };
    }

    function isEditActiveNow() {
      return !!(doc && doc.documentElement && doc.documentElement.dataset && doc.documentElement.dataset.boothStep === 'edit');
    }

    function currentEditsFor(src) {
      if (!src) return {boothEdits: [], wsEdits: [], editsList: []};
      const boothEdits = currentBoothEdits();
      const wsEdits = boothEdits.length ? [] : currentWorkspaceEdits();
      return {boothEdits, wsEdits, editsList: boothEdits.length ? boothEdits : wsEdits};
    }

    function state() {
      ensureBoothSubscription();
      syncPageFromWorkspace();
      const src = activeSourceInfo();
      const {boothEdits, wsEdits, editsList} = currentEditsFor(src);
      const specKey = src ? canonicalSpecKey(src.fileHash, boothEdits, wsEdits) : null;
      const page = src ? (activePage || (activePageCount > 0 ? 1 : 0)) : 0;
      return {
        ready: !!(src && ready),
        loading,
        busy: !!inFlight,
        editActive: isEditActiveNow(),
        editorMounted: !!(doc && doc.getElementById('booth-pe-bar')),
        fileHash: src ? src.fileHash : null,
        sourceSha256: src ? src.fileHash : null,
        name: src ? src.name : '',
        page,
        pageIndex: page > 0 ? page - 1 : null,
        pageCount: src ? activePageCount : 0,
        revision,
        editCount: editsList.length,
        edits: cloneSafe(editsList) || [],
        hasEdits: editsList.length > 0,
        artifact: freshArtifactSummary(src, specKey),
        resumable: resumableSummary(),
      };
    }

    function emitChange(reason, extra) {
      if (!doc || typeof doc.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
      const snap = state();
      const detail = Object.assign({
        reason: reason || 'change',
        state: snap,
        fileHash: snap.fileHash,
        sourceSha256: snap.sourceSha256,
        name: snap.name,
        page: snap.page,
        pageIndex: snap.pageIndex,
        pageCount: snap.pageCount,
        revision: snap.revision,
        editCount: snap.editCount,
        ready: snap.ready,
        hasEdits: snap.hasEdits,
        artifact: snap.artifact,
      }, extra || {});
      try { doc.dispatchEvent(new CustomEvent('falsify:w8-paper-change', {detail})); } catch {}
    }

    async function ensureSourceBlob(src, savedAt, expiresAt, existing, forceWrite) {
      if (!forceWrite && existing && existing.hasSource) return true;
      const blobs = blobApi();
      if (!blobs || typeof blobs.put !== 'function') return false;
      try {
        await blobs.put(sourceKey(src.fileHash), {
          fileHash: src.fileHash,
          name: src.name,
          type: src.file.type || 'application/pdf',
          savedAt,
          expiresAt,
          blob: await readBytes(src.file),
        });
        return true;
      } catch {
        return false;
      }
    }

    async function persistArtifactBlob(entry) {
      const blobs = blobApi();
      if (!blobs || typeof blobs.put !== 'function') return null;
      const savedAt = now();
      const key = entry.artifactKey || await artifactKeyFor(entry.specKey);
      entry.artifactKey = key;
      try {
        await blobs.put(key, {
          kind: 'w8-artifact',
          key,
          fileHash: entry.sourceSha256,
          specKey: entry.specKey,
          sha256: entry.sha256,
          name: entry.file.name,
          type: 'application/pdf',
          changed: entry.changed,
          editCount: entry.editCount,
          edits: cloneSafe(entry.edits) || [],
          blinding: cloneSafe(entry.blinding),
          savedAt,
          expiresAt: Math.min(Number.MAX_SAFE_INTEGER, savedAt + ttlMs),
          blob: await readBytes(entry.file),
        });
        return key;
      } catch {
        return null;
      }
    }

    function validPersistedArtifactRecord(kept, snap, key) {
      return !!kept && kept.kind === 'w8-artifact' && kept.key === key
        && kept.fileHash === snap.src.fileHash && kept.specKey === snap.specKey
        && HEX64.test(kept.sha256 || '') && kept.expiresAt > now() && !!kept.blob;
    }

    function hydrateRestoredArtifact(kept, snap, key, bytes) {
      const edits = Array.isArray(kept.edits)
        ? cloneSafe(kept.edits) || []
        : cloneSafe(snap.boothEdits.length ? snap.boothEdits : snap.wsEdits) || [];
      return {
        sourceEpoch: snap.sourceEpoch,
        sourceSha256: snap.src.fileHash,
        specKey: snap.specKey,
        artifactKey: key,
        file: makePdfFile(bytes, kept.name || outputFileName(snap.src.name, snap.editCount > 0)),
        sha256: kept.sha256,
        changed: kept.changed === true,
        editCount: Number.isInteger(kept.editCount) ? kept.editCount : snap.editCount,
        edits,
        blinding: kept.blinding ? cloneSafe(kept.blinding) : null,
      };
    }

    async function restorePersistedArtifact(snap) {
      const blobs = blobApi();
      if (!snap || !blobs || typeof blobs.get !== 'function') return null;
      const key = await artifactKeyFor(snap.specKey);
      let kept = null;
      try { kept = await blobs.get(key); } catch { return null; }
      if (!validPersistedArtifactRecord(kept, snap, key)) return null;
      const bytes = await readBytes(kept.blob);
      if (!bytes || !hasPdfMagic(bytes) || await sha256Hex(bytes) !== kept.sha256) return null;
      return hydrateRestoredArtifact(kept, snap, key, bytes);
    }

    function currentArtifactMeta(specNow) {
      if (!cachedArtifact || !specNow || cachedArtifact.specKey !== specNow.specKey) {
        return {sha: null, key: null};
      }
      return {sha: cachedArtifact.sha256, key: cachedArtifact.artifactKey || null};
    }

    function captureDraftSnapshot(src) {
      syncPageFromWorkspace();
      const savedAt = now();
      const meta = currentArtifactMeta(currentSpecState());
      return {
        epoch: sourceEpoch,
        src,
        savedAt,
        expiresAt: Math.min(Number.MAX_SAFE_INTEGER, savedAt + ttlMs),
        page: Math.max(1, activePage || 1),
        pageCount: activePageCount,
        revision,
        edits: currentBoothEdits(),
        meta,
      };
    }

    function writeDraftRecord(box, record) {
      const raw = JSON.stringify(record);
      try {
        box.setItem(DRAFT_ITEM_PREFIX + record.fileHash, raw);
        box.setItem(DRAFT_KEY, raw);
        const ordered = [record.fileHash].concat(readRecentHashes(box).filter(h => h !== record.fileHash));
        writeRecentHashes(box, ordered);
        return true;
      } catch {
        return false;
      }
    }

    function draftSaveStillCurrent(snap) {
      return !disposed && sourceEpoch === snap.epoch && activeHash === snap.src.fileHash;
    }

    async function persistDraft(opts) {
      const src = activeSourceInfo();
      const box = storageApi();
      if (!src || !box || typeof box.setItem !== 'function') return false;
      const snap = captureDraftSnapshot(src);
      const existing = readDraftRecord(src.fileHash);
      const hasSource = await ensureSourceBlob(src, snap.savedAt, snap.expiresAt, existing, !!(opts && opts.writeSource));
      if (!draftSaveStillCurrent(snap)) return false;
      const record = {
        schema: DRAFT_SCHEMA,
        fileHash: src.fileHash,
        name: src.name,
        page: snap.page,
        pageCount: snap.pageCount,
        revision: snap.revision,
        edits: snap.edits,
        hasSource,
        lastArtifactSha256: snap.meta.sha,
        lastArtifactKey: snap.meta.key,
        savedAt: snap.savedAt,
        expiresAt: snap.expiresAt,
      };
      return writeDraftRecord(box, record);
    }

    function schedulePersist(writeSource) {
      if (draftTimer !== null) { timers.clearTimeout(draftTimer); draftTimer = null; }
      if (writeSource) { void persistDraft({writeSource: true}); return; }
      draftTimer = timers.setTimeout(() => { draftTimer = null; void persistDraft({writeSource: false}); }, 120);
    }

    function flushDraft() {
      if (draftTimer !== null) { timers.clearTimeout(draftTimer); draftTimer = null; }
      return persistDraft({writeSource: false});
    }

    function onCommittedEditsChanged(reason) {
      if (!activeSourceInfo()) return;
      revision += 1;
      cachedArtifact = null;
      schedulePersist(false);
      emitChange(reason || 'edit');
    }

    function warmEngines(file) {
      const blind = blindPdfApi();
      if (blind && typeof blind.warm === 'function') { try { blind.warm(file); } catch {} }
      const pdf = browserPdfApi();
      if (pdf && typeof pdf.warm === 'function') { try { void Promise.resolve(pdf.warm()).catch(() => {}); } catch {} }
    }

    function clearBoothStore() {
      const store = boothEditsApi();
      if (!store || typeof store.clear !== 'function') return;
      suppressingEdits = true;
      try { store.clear(); } finally { suppressingEdits = false; }
    }

    function assignFileInput(input, file) {
      if (typeof root.DataTransfer === 'function') {
        const dt = new root.DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        return input.files && input.files[0] ? input.files[0] : file;
      }
      try { Object.defineProperty(input, 'files', {configurable: true, value: [file]}); } catch {}
      return file;
    }

    function currentStagePageEl() {
      const stage = doc && doc.getElementById('paper-before-stage');
      return stage ? (stage.querySelector(':scope > .paper-page') || stage.querySelector('.paper-page')) : null;
    }

    function stageHasRenderedPage() {
      return !!currentStagePageEl();
    }

    function probePdfLoaded(ws, expectedHash) {
      const src = ws && typeof ws.getSource === 'function' ? ws.getSource() : null;
      if (!src || src.fileHash !== expectedHash || !ws.getPdfDoc || !ws.getPdfDoc()) return false;
      const count = typeof ws.getPageCount === 'function' ? Number(ws.getPageCount()) || 0 : 0;
      if (count > 0) activePageCount = count;
      return true;
    }

    function probePageRendered(ws) {
      if (!stageHasRenderedPage()) return false;
      const idx = ws && typeof ws.getPageIndex === 'function' ? ws.getPageIndex() : null;
      if (!Number.isInteger(idx) || idx < 0) return false;
      activePage = idx + 1;
      return true;
    }

    function probeWorkspaceReady(expectedHash, flags) {
      const ws = workspaceApi();
      if (probePdfLoaded(ws, expectedHash)) flags.pdfReady = true;
      if (flags.pdfReady && !flags.pageReady && probePageRendered(ws)) flags.pageReady = true;
      return flags.pdfReady && flags.pageReady;
    }

    function detailMatchesFile(detail, expectedFile, expectedHash) {
      if (!detail) return false;
      if (detail.file && detail.file === expectedFile) return true;
      return HEX64.test(detail.fileHash || '') && detail.fileHash === expectedHash;
    }

    function dispatchInputOpen(input, file, checkDone) {
      const assigned = assignFileInput(input, file);
      openingOwn = true;
      try { input.dispatchEvent(new (root.Event || Event)('change', {bubbles: true})); }
      finally { openingOwn = false; }
      checkDone();
      return assigned || file;
    }

    function waitForWorkspaceReady(expectedFile, expectedHash, mySeq) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let observer = null;
        const flags = {pdfReady: false, pageReady: false};
        const cleanup = () => {
          if (timer !== null) { timers.clearTimeout(timer); timer = null; }
          if (observer) { try { observer.disconnect(); } catch {} observer = null; }
          if (doc && typeof doc.removeEventListener === 'function') {
            doc.removeEventListener('falsify:paper-workspace-pdf', onPdf);
            doc.removeEventListener('falsify:paper-workspace-page', onPage);
            doc.removeEventListener('falsify:paper-workspace-pdf-error', onErr);
            doc.removeEventListener('falsify:document-clear', onClear);
          }
          if (cancelPendingOpen === abortMe) cancelPendingOpen = null;
        };
        const finish = (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (err) reject(err); else resolve();
        };
        const checkDone = () => {
          if (mySeq !== openSeq || disposed) { finish(makeError('superseded')); return; }
          if (probeWorkspaceReady(expectedHash, flags)) finish(null);
        };
        const onPdf = e => {
          if (!detailMatchesFile(e && e.detail, expectedFile, expectedHash)) return;
          flags.pdfReady = true;
          const pages = Number(e.detail && e.detail.pages) || 0;
          if (pages > 0) activePageCount = pages;
          checkDone();
        };
        const onPage = e => {
          const d = e && e.detail;
          if (!d || d.fileHash !== expectedHash) return;
          flags.pdfReady = true;
          flags.pageReady = true;
          if (Number.isInteger(d.page) && d.page >= 1) activePage = d.page;
          if (Number.isInteger(d.pages) && d.pages >= 1) activePageCount = d.pages;
          checkDone();
        };
        const onErr = e => {
          if (!detailMatchesFile(e && e.detail, expectedFile, expectedHash)) return;
          finish(makeError(typeof e.detail.code === 'string' ? e.detail.code : 'pdf_unreadable'));
        };
        const onClear = () => { if (!openingOwn) finish(makeError('aborted')); };
        const abortMe = () => finish(makeError('superseded'));
        cancelPendingOpen = abortMe;

        if (doc && typeof doc.addEventListener === 'function') {
          doc.addEventListener('falsify:paper-workspace-pdf', onPdf);
          doc.addEventListener('falsify:paper-workspace-page', onPage);
          doc.addEventListener('falsify:paper-workspace-pdf-error', onErr);
          doc.addEventListener('falsify:document-clear', onClear);
        }
        const stage = doc && doc.getElementById('paper-before-stage');
        if (stage && typeof root.MutationObserver === 'function') {
          observer = new root.MutationObserver(checkDone);
          observer.observe(stage, {childList: true, subtree: true});
        }
        timer = timers.setTimeout(() => finish(makeError('pdf_timeout')), openTimeoutMs);

        const input = doc && doc.getElementById('paper-file');
        if (input) expectedFile = dispatchInputOpen(input, expectedFile, checkDone);
        else if (typeof deps.openFile === 'function') void Promise.resolve(deps.openFile(expectedFile, expectedHash)).then(checkDone, finish);
        else finish(makeError('pdf_unreadable', '#paper-file 요소를 찾지 못했습니다.'));
      });
    }

    async function validateOpenInput(fileLike) {
      if (disposed) throw makeError('aborted');
      const rawBytes = await readBytes(fileLike);
      if (!rawBytes || !rawBytes.byteLength) throw makeError('invalid_file');
      if (!hasPdfMagic(rawBytes)) throw makeError('pdf_corrupt');
      const name = sanitizeName(fileLike && fileLike.name ? fileLike.name : 'document.pdf');
      const fileHash = await sha256Hex(rawBytes);
      const ws = workspaceApi();
      const prevSrc = ws && typeof ws.getSource === 'function' ? ws.getSource() : null;
      const isNative = typeof File === 'function' && fileLike instanceof File;
      const loadFile = isNative && (!prevSrc || prevSrc.file !== fileLike)
        ? fileLike
        : makePdfFile(rawBytes, name, fileLike && fileLike.lastModified);
      return {loadFile, fileHash, name};
    }

    function beginOpenState(loadFile, fileHash, name, options) {
      if (typeof cancelPendingOpen === 'function') { try { cancelPendingOpen(); } catch {} }
      const mySeq = ++openSeq;
      sourceEpoch += 1;
      loading = true;
      ready = false;
      cachedArtifact = null;
      inFlight = null;
      if (!options.preserveEdits) { clearBoothStore(); revision = 0; }
      activeFile = loadFile;
      activeHash = fileHash;
      activeName = name;
      activePage = 1;
      activePageCount = 0;
      ensureEditorMounted(options.activateEditor !== false);
      emitChange('loading');
      return mySeq;
    }

    function clearFailedOpen(mySeq, err) {
      if (mySeq !== openSeq) return;
      loading = false;
      ready = false;
      activeFile = null;
      activeHash = null;
      activeName = '';
      activePage = 0;
      activePageCount = 0;
      if (!err || err.code !== 'superseded') emitChange('error', {error: err ? err.message : ''});
    }

    async function open(fileLike, options) {
      options = options || {};
      const {loadFile, fileHash, name} = await validateOpenInput(fileLike);
      if (options.restoreSaved && readDraftRecord(fileHash)) return resume({fileHash, file: loadFile});
      const mySeq = beginOpenState(loadFile, fileHash, name, options);
      try {
        await waitForWorkspaceReady(loadFile, fileHash, mySeq);
      } catch (err) {
        clearFailedOpen(mySeq, err);
        throw err;
      }
      if (mySeq !== openSeq || disposed) throw makeError('superseded');
      syncPageFromWorkspace();
      loading = false;
      ready = true;
      ensureEditorMounted(options.activateEditor !== false);
      warmEngines(loadFile);
      if (!options.skipPersist) await persistDraft({writeSource: true});
      if (mySeq !== openSeq || disposed) throw makeError('superseded');
      emitChange('ready');
      return state();
    }

    async function prepareCleanSource(file, sourceSha256, signal) {
      const blind = blindPdfApi();
      if (!blind || typeof blind.prepare !== 'function') throw makeError('blind_unavailable');
      const clean = await blind.prepare({file, signal});
      if (signal && signal.aborted) throw makeError('aborted');
      if (!clean || !clean.file || !HEX64.test(clean.sha256 || '')) {
        throw makeError('blind_unavailable', '블라인드 PDF 결과를 확인하지 못했습니다.');
      }
      const cleanBytes = await readBytes(clean.file);
      if (!cleanBytes || !hasPdfMagic(cleanBytes) || await sha256Hex(cleanBytes) !== clean.sha256) {
        throw makeError('blind_unavailable', '블라인드 PDF 검증에 실패했습니다.');
      }
      return {
        bytes: cleanBytes,
        file: clean.file,
        sha256: clean.sha256,
        changed: clean.changed === true,
        blinding: {
          changed: clean.changed === true,
          originalSourceSha256: sourceSha256,
          cleanSourceSha256: clean.sha256,
          removed: Array.isArray(clean.removed) ? cloneSafe(clean.removed) || [] : [],
          verification: clean.verification ? cloneSafe(clean.verification) : null,
        },
      };
    }

    async function tryWorkspaceCachedOutput(revisionAt) {
      const ws = workspaceApi();
      const existing = ws && typeof ws.getCurrentOutput === 'function' ? ws.getCurrentOutput() : null;
      if (!existing || !existing.file || !HEX64.test(existing.sha256 || '') || existing.revision !== revisionAt) return null;
      const bytes = await readBytes(existing.file);
      if (!bytes || !hasPdfMagic(bytes) || await sha256Hex(bytes) !== existing.sha256) return null;
      return {bytes, sha256: existing.sha256};
    }

    function selectWorkspaceExporter(wsEdits) {
      const usePara = wsEdits.some(e => /^(paragraph|layout):/.test(String(e.segmentId || '')));
      const para = paragraphPdfApi();
      return usePara && para && typeof para.prepare === 'function' ? para : browserPdfApi();
    }

    async function exportWorkspaceEdits(clean, wsEdits, revisionAt, signal) {
      const reused = await tryWorkspaceCachedOutput(revisionAt);
      if (reused) return reused;
      const exporter = selectWorkspaceExporter(wsEdits);
      if (!exporter || typeof exporter.prepare !== 'function') throw makeError('engine_unavailable');
      const res = await exporter.prepare({
        file: makePdfFile(clean.bytes, clean.file.name || 'document.pdf'),
        fileHash: clean.sha256,
        edits: cloneSafe(wsEdits) || [],
        revision: revisionAt,
        signal,
      });
      const outBytes = res && res.file ? await readBytes(res.file) : null;
      if (!outBytes || !hasPdfMagic(outBytes)) throw makeError('engine_unavailable');
      const outSha = await sha256Hex(outBytes);
      if (res.sha256 && res.sha256 !== outSha) throw makeError('engine_unavailable');
      return {bytes: outBytes, sha256: outSha};
    }

    function ensureBuildLive(startEpoch, signal) {
      if (disposed || (signal && signal.aborted)) throw makeError('aborted');
      if (sourceEpoch !== startEpoch) throw makeError('source_changed');
    }

    async function rewriteBoothEdits(clean, boothEdits, startEpoch, signal) {
      const pdfApi = browserPdfApi();
      if (!pdfApi || typeof pdfApi.rewrite !== 'function') throw makeError('engine_unavailable');
      const rewritten = await pdfApi.rewrite(clean.bytes, cloneSafe(boothEdits) || []);
      ensureBuildLive(startEpoch, signal);
      const bytes = rewritten instanceof Uint8Array ? rewritten : new Uint8Array(rewritten || 0);
      if (!hasPdfMagic(bytes)) throw makeError('engine_unavailable');
      const hash = await sha256Hex(bytes);
      if (hash === clean.sha256) throw makeError('pdf_unchanged');
      return {bytes, sha256: hash, edited: true};
    }

    async function produceArtifactBytes(snap, clean, startEpoch, signal) {
      if (snap.boothEdits.length > 0) return rewriteBoothEdits(clean, snap.boothEdits, startEpoch, signal);
      if (snap.wsEdits.length > 0) {
        const wsOut = await exportWorkspaceEdits(clean, snap.wsEdits, snap.revision, signal);
        ensureBuildLive(startEpoch, signal);
        return {bytes: wsOut.bytes, sha256: wsOut.sha256, edited: true};
      }
      return {bytes: clean.bytes, sha256: clean.sha256, edited: false};
    }

    function specStillCurrent(startEpoch, specKey) {
      const cur = currentSpecState();
      if (!cur || cur.sourceEpoch !== startEpoch) throw makeError('source_changed');
      return cur.specKey === specKey ? cur : null;
    }

    async function commitArtifact(snap, clean, built, startEpoch, latestRev) {
      const editsCopy = cloneSafe(snap.boothEdits.length ? snap.boothEdits : snap.wsEdits) || [];
      const entry = {
        sourceEpoch: startEpoch,
        sourceSha256: snap.src.fileHash,
        specKey: snap.specKey,
        artifactKey: null,
        file: makePdfFile(built.bytes, outputFileName(snap.src.name, built.edited)),
        sha256: built.sha256,
        changed: built.edited || clean.changed,
        editCount: editsCopy.length,
        edits: editsCopy,
        blinding: clean.blinding,
      };
      cachedArtifact = entry;
      await persistArtifactBlob(entry);
      if (sourceEpoch === startEpoch) {
        await persistDraft({writeSource: false});
        emitChange('artifact');
      }
      return formatArtifact(entry, latestRev);
    }

    async function buildArtifactStep(startEpoch, signal) {
      ensureBuildLive(startEpoch, signal);
      const snap = currentSpecState();
      if (!snap) throw makeError('no_source');
      if (matchesCachedArtifact(snap.src, snap.specKey)) return formatArtifact(cachedArtifact, snap.revision);

      const persisted = await restorePersistedArtifact(snap);
      ensureBuildLive(startEpoch, signal);
      if (persisted) {
        const cur = specStillCurrent(startEpoch, snap.specKey);
        if (!cur) return null;
        cachedArtifact = persisted;
        return formatArtifact(persisted, cur.revision);
      }

      const clean = await prepareCleanSource(snap.src.file, snap.src.fileHash, signal);
      ensureBuildLive(startEpoch, signal);
      if (!specStillCurrent(startEpoch, snap.specKey)) return null;

      const built = await produceArtifactBytes(snap, clean, startEpoch, signal);
      const after = specStillCurrent(startEpoch, snap.specKey);
      if (!after) return null;
      return commitArtifact(snap, clean, built, startEpoch, after.revision);
    }

    async function runArtifactBuild(startEpoch, signal) {
      while (true) {
        const result = await buildArtifactStep(startEpoch, signal);
        if (result) return result;
      }
    }

    function formatArtifact(entry, rev) {
      return Object.freeze({
        file: entry.file,
        sha256: entry.sha256,
        revision: rev,
        sourceSha256: entry.sourceSha256,
        originalSourceSha256: entry.sourceSha256,
        changed: entry.changed,
        editCount: entry.editCount,
        edits: cloneSafe(entry.edits) || [],
        blinding: cloneSafe(entry.blinding),
        editSignature: entry.specKey,
      });
    }

    async function artifact(options) {
      const signal = options && options.signal;
      if (signal && signal.aborted) throw makeError('aborted');
      if (activeResume) {
        try { await activeResume; } catch {}
        if (signal && signal.aborted) throw makeError('aborted');
      }
      const snap = currentSpecState();
      if (!snap) throw makeError('no_source');
      if (matchesCachedArtifact(snap.src, snap.specKey)) return formatArtifact(cachedArtifact, snap.revision);

      const startEpoch = snap.sourceEpoch;
      const res = await acquireArtifactPromise(startEpoch, signal);
      if (signal && signal.aborted) throw makeError('aborted');
      if (sourceEpoch !== startEpoch) throw makeError('source_changed');
      const latest = currentSpecState();
      if (latest && latest.specKey !== res.editSignature) return artifact(options);
      return res;
    }

    function acquireArtifactPromise(startEpoch, signal) {
      if (inFlight && inFlight.epoch === startEpoch && !signal) return inFlight.promise;
      const run = runArtifactBuild(startEpoch, signal);
      if (!signal) {
        const token = {epoch: startEpoch, promise: run};
        inFlight = token;
        const clear = () => { if (inFlight === token) inFlight = null; };
        run.then(clear, clear);
      }
      return run;
    }

    async function download(options) {
      const art = await artifact(options);
      const src = activeSourceInfo();
      const name = outputFileName(src ? src.name : art.file.name, art.editCount > 0, options);
      const fileToSave = art.file.name === name ? art.file : makePdfFile(await readBytes(art.file), name);
      if (typeof deps.triggerDownload === 'function') {
        deps.triggerDownload(fileToSave, art);
        return art;
      }
      triggerBrowserDownload(fileToSave, name);
      return art;
    }

    function triggerBrowserDownload(fileToSave, name) {
      if (!doc || !urls || typeof urls.createObjectURL !== 'function') return;
      const href = urls.createObjectURL(fileToSave);
      const a = doc.createElement('a');
      a.href = href;
      a.download = name;
      const host = doc.body || doc.documentElement;
      if (host) host.append(a);
      a.click();
      a.remove();
      timers.setTimeout(() => { try { urls.revokeObjectURL(href); } catch {} }, 1000);
    }

    function isAtRenderedPage(targetPage, prevEl) {
      const ws = workspaceApi();
      const curEl = currentStagePageEl();
      if (!curEl || (prevEl && curEl === prevEl)) return false;
      return !!(ws && typeof ws.getPageIndex === 'function' && ws.getPageIndex() === targetPage - 1);
    }

    function waitForPage(targetPage, expectedHash) {
      return new Promise(resolve => {
        if (isAtRenderedPage(targetPage, null)) { activePage = targetPage; resolve(true); return; }
        const prevEl = currentStagePageEl();
        let settled = false;
        let timer = null;
        let observer = null;
        const done = ok => {
          if (settled) return;
          settled = true;
          if (timer !== null) { timers.clearTimeout(timer); timer = null; }
          if (observer) { try { observer.disconnect(); } catch {} observer = null; }
          if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('falsify:paper-workspace-page', onPage);
          resolve(ok);
        };
        const check = () => { if (isAtRenderedPage(targetPage, prevEl)) { activePage = targetPage; done(true); } };
        const onPage = e => {
          const d = e && e.detail;
          if (!d || (expectedHash && d.fileHash && d.fileHash !== expectedHash)) return;
          if (d.page === targetPage) { activePage = targetPage; done(true); }
        };
        if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('falsify:paper-workspace-page', onPage);
        const stage = doc && doc.getElementById('paper-before-stage');
        if (stage && typeof root.MutationObserver === 'function') {
          observer = new root.MutationObserver(check);
          observer.observe(stage, {childList: true, subtree: true});
        }
        timer = timers.setTimeout(() => done(false), 15000);
        const ws = workspaceApi();
        if (!ws || typeof ws.showPage !== 'function' || !ws.showPage(targetPage, {scroll: false})) done(false);
        else check();
      });
    }

    async function goToPage(pageNumber) {
      const src = activeSourceInfo();
      if (!src) return false;
      syncPageFromWorkspace();
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || (activePageCount > 0 && pageNumber > activePageCount)) return false;
      const ok = await waitForPage(pageNumber, src.fileHash);
      if (ok) { schedulePersist(false); emitChange('page'); }
      return ok;
    }

    async function resolveProvidedResumeFile(fileLike, record) {
      const bytes = await readBytes(fileLike);
      if (!bytes || !hasPdfMagic(bytes)) throw makeError('pdf_corrupt');
      if (await sha256Hex(bytes) !== record.fileHash) throw makeError('hash_mismatch');
      return typeof File === 'function' && fileLike instanceof File ? fileLike : makePdfFile(bytes, record.name);
    }

    async function resolveStoredResumeFile(record) {
      const blobs = blobApi();
      let kept = null;
      if (blobs && typeof blobs.get === 'function') {
        try { kept = await blobs.get(sourceKey(record.fileHash)) || await blobs.get(record.fileHash); } catch { kept = null; }
      }
      if (!kept || kept.fileHash !== record.fileHash || !(kept.expiresAt > now()) || !kept.blob) {
        throw makeError('missing_source');
      }
      const bytes = await readBytes(kept.blob);
      if (!bytes || !hasPdfMagic(bytes) || await sha256Hex(bytes) !== record.fileHash) {
        throw makeError('missing_source');
      }
      return makePdfFile(bytes, record.name);
    }

    function restoreEditsFromDraft(record) {
      const store = boothEditsApi();
      if (store && typeof store.restore === 'function') {
        suppressingEdits = true;
        try { store.restore(JSON.stringify(record.edits)); }
        finally { suppressingEdits = false; }
      }
      revision = Math.max(revision, record.revision || 0);
      cachedArtifact = null;
    }

    async function runResume(options) {
      const record = readDraftRecord(options.fileHash || null);
      if (!record) return null;
      const file = options.file
        ? await resolveProvidedResumeFile(options.file, record)
        : await resolveStoredResumeFile(record);
      await open(file, {preserveEdits: false, skipPersist: true, activateEditor: options.activateEditor !== false});
      restoreEditsFromDraft(record);
      if (record.page > 1 && (activePageCount === 0 || record.page <= activePageCount)) {
        await waitForPage(record.page, record.fileHash);
      }
      const restoredArtifact = await restorePersistedArtifact(currentSpecState());
      if (restoredArtifact) cachedArtifact = restoredArtifact;
      await persistDraft({writeSource: false});
      emitChange('resumed');
      return state();
    }

    function resume(arg) {
      const run = runResume(normalizeResumeArg(arg));
      activeResume = run;
      const clear = () => { if (activeResume === run) activeResume = null; };
      run.then(clear, clear);
      return run;
    }

    async function deleteStoredKey(blobs, key) {
      if (!key || !blobs || typeof blobs.delete !== 'function') return;
      try { await blobs.delete(key); } catch {}
    }

    function removeDraftMetadata(box, hash) {
      if (!box) return;
      if (hash) removeStorageItem(box, DRAFT_ITEM_PREFIX + hash);
      const remaining = readRecentHashes(box).filter(h => h !== hash);
      writeRecentHashes(box, remaining);
      const legacy = readDraftByKey(box, DRAFT_KEY);
      if (!legacy || legacy.fileHash === hash) {
        const nextRec = remaining.length ? readDraftByKey(box, DRAFT_ITEM_PREFIX + remaining[0]) : null;
        if (nextRec) { try { box.setItem(DRAFT_KEY, JSON.stringify(nextRec)); } catch {} }
        else removeStorageItem(box, DRAFT_KEY);
      }
    }

    async function clearDraft(targetHash) {
      if (draftTimer !== null) { timers.clearTimeout(draftTimer); draftTimer = null; }
      const expected = typeof targetHash === 'string' && HEX64.test(targetHash) ? targetHash : null;
      const rec = readDraftRecord(expected);
      const hash = expected || (rec && rec.fileHash) || activeHash;
      removeDraftMetadata(storageApi(), hash);
      if (hash) {
        removeStorageItem(storageApi(), 'falsify.w8.arxiv.' + hash);
        try { root.sessionStorage?.removeItem('falsify.w8.arxiv.' + hash); } catch {}
        if (lastArxiv?.hash === hash) lastArxiv = null;
      }
      const blobs = blobApi();
      if (hash) await deleteStoredKey(blobs, sourceKey(hash));
      const artKey = (rec && rec.lastArtifactKey) || (cachedArtifact && cachedArtifact.sourceSha256 === hash ? cachedArtifact.artifactKey : null);
      await deleteStoredKey(blobs, artKey);
    }

    function removeEdit(id) {
      if (typeof id !== 'string' || !id) return false;
      const store = boothEditsApi();
      if (store && typeof store.list === 'function' && typeof store.remove === 'function') {
        if (store.list().some(e => e.id === id)) { store.remove(id); return true; }
      }
      const ws = workspaceApi();
      return !!(ws && typeof ws.removeEdit === 'function' && ws.removeEdit(id) === true);
    }

    function clearEdits() {
      const store = boothEditsApi();
      if (store && typeof store.clear === 'function') store.clear();
    }

    function adoptExternalSource(nextHash, name) {
      sourceEpoch += 1;
      clearBoothStore();
      revision = 0;
      cachedArtifact = null;
      inFlight = null;
      activeHash = nextHash;
      activeName = sanitizeName(name);
      activePage = 1;
      activePageCount = 0;
      const ws = workspaceApi();
      const src = ws && typeof ws.getSource === 'function' ? ws.getSource() : null;
      activeFile = src ? src.file : null;
      ready = false;
      ensureEditorMounted(true);
      if (activeFile) warmEngines(activeFile);
      emitChange('source');
    }

    function onWorkspaceSource(event) {
      const detail = event && event.detail;
      const nextHash = detail && HEX64.test(detail.fileHash || '') ? detail.fileHash : null;
      if (!nextHash) return;
      if (openingOwn || loading) {
        activeHash = nextHash;
        if (detail.name) activeName = sanitizeName(detail.name);
        return;
      }
      if (nextHash !== activeHash) adoptExternalSource(nextHash, detail.name);
    }

    function onWorkspacePage(event) {
      const detail = event && event.detail;
      if (!detail || !HEX64.test(detail.fileHash || '')) return;
      if (activeHash && detail.fileHash !== activeHash) return;
      const prevPage = activePage;
      const wasReady = ready;
      activeHash = detail.fileHash;
      if (Number.isInteger(detail.page) && detail.page >= 1) activePage = detail.page;
      if (Number.isInteger(detail.pages) && detail.pages >= 1) activePageCount = detail.pages;
      if (loading) return;
      ready = true;
      ensureEditorMounted(true);
      if (!wasReady) { schedulePersist(true); emitChange('ready'); }
      else if (activePage !== prevPage) { schedulePersist(false); emitChange('page'); }
    }

    function onWorkspaceEdits() {
      if (suppressingEdits || loading || currentBoothEdits().length > 0) return;
      const ws = workspaceApi();
      const snap = ws && typeof ws.getEditSnapshot === 'function' ? ws.getEditSnapshot() : null;
      if (snap && snap.revision !== 0) onCommittedEditsChanged('edit');
    }

    function onDocumentClear() {
      if (openingOwn) return;
      sourceEpoch += 1;
      loading = false;
      ready = false;
      activeFile = null;
      activeHash = null;
      activeName = '';
      activePage = 0;
      activePageCount = 0;
      revision = 0;
      cachedArtifact = null;
      inFlight = null;
      clearBoothStore();
      emitChange('clear');
    }

    function observeStagePages() {
      const stage = doc && doc.getElementById('paper-before-stage');
      if (!stage || typeof root.MutationObserver !== 'function') return;
      stageObserver = new root.MutationObserver(() => {
        const pageEl = currentStagePageEl();
        if (!pageEl || pageEl === observedPageEl) return;
        observedPageEl = pageEl;
        if (loading) return;
        const prevPage = activePage;
        syncPageFromWorkspace();
        if (activeHash && activePage > 0 && activePage !== prevPage) {
          schedulePersist(false);
          emitChange('page');
        }
      });
      stageObserver.observe(stage, {childList: true, subtree: true});
    }

    function attachListeners() {
      ensureBoothSubscription();
      if (doc) {
        listen(doc, 'falsify:paper-workspace-ready', ensureBoothSubscription);
        if (doc.readyState === 'loading') listen(doc, 'DOMContentLoaded', ensureBoothSubscription);
        listen(doc, 'falsify:paper-workspace-source', onWorkspaceSource);
        listen(doc, 'falsify:paper-workspace-page', onWorkspacePage);
        listen(doc, 'falsify:paper-workspace-edits', onWorkspaceEdits);
        listen(doc, 'falsify:document-clear', onDocumentClear);
        listen(doc, 'falsify:workspace-reset', onDocumentClear);
        listen(doc, 'visibilitychange', () => { if (doc.visibilityState === 'hidden') void flushDraft(); });
        observeStagePages();
      }
      listen(root, 'pagehide', () => { void flushDraft(); });
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (draftTimer !== null) { timers.clearTimeout(draftTimer); draftTimer = null; }
      if (typeof cancelPendingOpen === 'function') { try { cancelPendingOpen(); } catch {} }
      if (typeof unsubBoothEdits === 'function') { try { unsubBoothEdits(); } catch {} }
      if (stageObserver) { try { stageObserver.disconnect(); } catch {} stageObserver = null; }
      for (const off of listeners.splice(0)) off();
      if (blobStore) blobStore.dispose();
    }

    attachListeners();

    return Object.freeze({
      open,
      artifact,
      download,
      state,
      recent,
      resume,
      arxivForPaper,
      goToPage,
      edits: () => cloneSafe(currentBoothEdits().length ? currentBoothEdits() : currentWorkspaceEdits()) || [],
      removeEdit,
      clearEdits,
      clearDraft,
      flushDraft,
      mountEditor: () => ensureEditorMounted(true),
      setEditActive,
      integratorNodes: () => INTEGRATOR_NODES,
      dispose,
      create,
      DRAFT_SCHEMA,
      DRAFT_KEY,
      DRAFT_ITEM_PREFIX,
      RECENT_INDEX_KEY,
      TTL_MS,
    });
  }

  return Object.freeze({create, DRAFT_SCHEMA, DRAFT_KEY, DRAFT_ITEM_PREFIX, RECENT_INDEX_KEY, TTL_MS, INTEGRATOR_NODES});
});
