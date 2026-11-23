/* W8 RED answer-key CSV export (FLS-18 format). Strictly browser-local, offline, no OAuth. AGPL-3.0-only. */
(function (root, factory) {
  'use strict';
  const csv = (root && root.FalsifyW8Csv) || (typeof require === 'function' ? require('./w8-csv.js') : null);
  const api = factory(root, csv);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.FalsifyW8RedKey = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root, initialCsv) {
  'use strict';

  const FILENAME = '정답지_W8.csv';
  const BUTTON_ID = 'w8-red-key-export';
  const BUTTON_LABEL = 'RED 정답지 CSV 다운로드';
  const PAPER_CHANGE_EVENT = 'falsify:w8-paper-change';

  const COLUMNS = Object.freeze([
    '결함ID',
    '유형',
    '유형_세부',
    '난이도',
    'PDF쪽',
    '저널쪽',
    '위치',
    '원문',
    '변조 후',
    '변경 수단',
    '탐지 단서',
    '외부 조회 필요',
    '적중 기준',
    '부분 기준',
    '함께 바뀐 곳',
    '의존 결함',
  ]);

  const HEADER_LINE = COLUMNS.join(',');

  const BOOTH_SOURCE_METHODS = Object.freeze({
    tap: '직접 편집',
    paragraph: '문단 편집',
    find: '찾아 바꾸기',
    myai: '내 AI 레시피',
    recipe: '레시피',
  });

  const mountedButtons = typeof WeakMap === 'function' ? new WeakMap() : null;

  function csvApi() {
    const api = (root && root.FalsifyW8Csv) || initialCsv;
    if (!api) throw new Error('W8 CSV 모듈을 불러오지 못했습니다.');
    return api;
  }

  function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function rawText(value) {
    return typeof value === 'string' ? value : '';
  }

  function resolvePhysicalPage(edit) {
    return Number.isInteger(edit?.pageIndex) && edit.pageIndex >= 0 ? String(edit.pageIndex + 1) : '';
  }

  function resolveMethod(edit) {
    const source = cleanString(edit?.source).toLowerCase();
    return source ? BOOTH_SOURCE_METHODS[source] || '' : '';
  }

  function resolveDetectionCue(edit) {
    return cleanString(edit?.assist?.reason);
  }

  function editToRow(edit, index) {
    return {
      결함ID: 'W8-' + String(index + 1).padStart(2, '0'),
      유형: '',
      유형_세부: '',
      난이도: '',
      PDF쪽: resolvePhysicalPage(edit),
      저널쪽: '',
      위치: '',
      원문: rawText(edit?.originalText),
      '변조 후': rawText(edit?.newText),
      '변경 수단': resolveMethod(edit),
      '탐지 단서': resolveDetectionCue(edit),
      '외부 조회 필요': '',
      '적중 기준': '',
      '부분 기준': '',
      '함께 바뀐 곳': '',
      '의존 결함': '',
    };
  }

  function buildRows(edits) {
    if (!Array.isArray(edits)) return [];
    const rows = [];
    for (let i = 0; i < edits.length; i += 1) {
      if (edits[i] && typeof edits[i] === 'object') rows.push(editToRow(edits[i], rows.length));
    }
    return rows;
  }

  function serializeRows(rows) {
    const csv = csvApi();
    const lines = [HEADER_LINE];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      lines.push(COLUMNS.map(col => csv.csvCell(row[col])).join(','));
    }
    return csv.BOM + lines.join(csv.CRLF) + csv.CRLF;
  }

  function toCsv(edits) {
    return serializeRows(buildRows(edits));
  }

  function buildExport(edits) {
    const rows = buildRows(edits);
    return {
      csv: serializeRows(rows),
      filename: FILENAME,
      rows,
      editCount: rows.length,
    };
  }

  function activeEditsForPaper(paper) {
    if (!paper || typeof paper.state !== 'function' || typeof paper.edits !== 'function') return [];
    if (!paper.state()?.ready) return [];
    const list = paper.edits();
    return Array.isArray(list) ? list : [];
  }

  function deliverDownload(doc, payload, opts) {
    if (typeof opts.download === 'function') {
      opts.download(payload);
      return;
    }
    csvApi().triggerDownload(doc, payload.csv, payload.filename);
  }

  function mount(button, options) {
    const opts = options || {};
    const doc = opts.document || button?.ownerDocument || root.document;
    if (!button || !doc) return null;

    if (mountedButtons?.has(button)) mountedButtons.get(button).destroy();

    const paper = opts.paper || root.FalsifyW8Paper || null;
    let destroyed = false;

    button.textContent = BUTTON_LABEL;
    if (!button.type) button.type = 'button';

    function getPayload() {
      const edits = activeEditsForPaper(paper);
      return edits.length ? buildExport(edits) : null;
    }

    function refresh() {
      if (destroyed) return false;
      const hasEdits = activeEditsForPaper(paper).length > 0;
      button.hidden = !hasEdits;
      return hasEdits;
    }

    function download() {
      if (destroyed) return null;
      const payload = getPayload();
      if (!payload) {
        button.hidden = true;
        return null;
      }
      deliverDownload(doc, payload, opts);
      return payload;
    }

    function onClick() {
      if (destroyed || button.disabled) return;
      try { download(); } catch (err) { opts.onError?.(err); }
    }

    button.addEventListener('click', onClick);
    if (typeof doc.addEventListener === 'function') doc.addEventListener(PAPER_CHANGE_EVENT, refresh);
    refresh();

    const controller = {
      button,
      refresh,
      getPayload,
      download,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (typeof button.removeEventListener === 'function') button.removeEventListener('click', onClick);
        if (typeof doc.removeEventListener === 'function') doc.removeEventListener(PAPER_CHANGE_EVENT, refresh);
        if (mountedButtons?.get(button) === controller) mountedButtons.delete(button);
      },
    };

    if (mountedButtons) mountedButtons.set(button, controller);
    return controller;
  }

  return Object.freeze({
    FILENAME,
    BUTTON_ID,
    BUTTON_LABEL,
    COLUMNS,
    HEADER_LINE,
    BOOTH_SOURCE_METHODS,
    EVENTS: Object.freeze({ PAPER_CHANGE: PAPER_CHANGE_EVENT }),
    resolveMethod,
    editToRow,
    buildRows,
    serializeRows,
    toCsv,
    buildExport,
    activeEditsForPaper,
    mount,
  });
});
