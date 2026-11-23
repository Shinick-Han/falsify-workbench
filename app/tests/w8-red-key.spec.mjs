'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const RedKey = require('../dist/w8-red-key.js');
const W8Csv = require('../dist/w8-csv.js');
const RED_KEY_SOURCE = readFileSync(new URL('../dist/w8-red-key.js', import.meta.url), 'utf8');
const W8_CSV_SOURCE = readFileSync(new URL('../dist/w8-csv.js', import.meta.url), 'utf8');

const EXPECTED_HEADERS = [
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
];
const EXPECTED_HEADER_LINE = EXPECTED_HEADERS.join(',');

// Minimal RFC 4180 CSV parser enforcing UTF-8 BOM and CRLF line endings.
function parseCsv(csvText) {
  assert.equal(csvText.charCodeAt(0), 0xfeff, 'CSV must start with UTF-8 BOM');
  assert.ok(csvText.endsWith('\r\n'), 'CSV must end with CRLF');
  const body = csvText.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      assert.notEqual(ch, '\n', 'Unquoted bare LF is not allowed');
      cell += ch;
    }
  }
  assert.equal(inQuotes, false, 'Unclosed quoted field');
  assert.equal(row.length, 0, 'Trailing unterminated row');
  return rows;
}

class SyntheticEl extends EventTarget {
  constructor(tag, doc) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.id = '';
    this.type = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.href = '';
    this.download = '';
    this.clicked = 0;
  }
  click() {
    this.clicked += 1;
    this.dispatchEvent(new Event('click'));
  }
}

class SyntheticDocument extends EventTarget {
  constructor() {
    super();
    this.createdLinks = [];
  }
  createElement(tag) {
    const el = new SyntheticEl(tag, this);
    if (tag.toLowerCase() === 'a') this.createdLinks.push(el);
    return el;
  }
}

function makeBrowserSandbox({ failBlob = false } = {}) {
  const doc = new SyntheticDocument();
  const blobs = [];
  const urls = new Map();
  const revoked = [];
  let seq = 0;
  let networkCalls = 0;
  class FakeBlob {
    constructor(parts, opts) {
      this.parts = parts;
      this.type = opts?.type || '';
      blobs.push(this);
    }
  }
  const win = {
    document: doc,
    Blob: failBlob ? undefined : FakeBlob,
    URL: failBlob
      ? undefined
      : {
          createObjectURL(blob) {
            const u = 'blob:red-key-' + (++seq);
            urls.set(u, blob);
            return u;
          },
          revokeObjectURL(u) {
            revoked.push(u);
          },
        },
    setTimeout(fn) {
      fn();
      return { unref() {} };
    },
    fetch() {
      networkCalls += 1;
      throw new Error('Network call forbidden in w8-red-key.js');
    },
    XMLHttpRequest: class {
      open() {
        networkCalls += 1;
        throw new Error('XHR forbidden in w8-red-key.js');
      }
    },
    navigator: {
      sendBeacon() {
        networkCalls += 1;
        throw new Error('sendBeacon forbidden in w8-red-key.js');
      },
    },
    Event,
    CustomEvent,
    WeakMap,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
  };
  win.window = win;
  win.globalThis = win;
  doc.defaultView = win;
  const ctx = vm.createContext(win);
  vm.runInContext(W8_CSV_SOURCE, ctx, { filename: 'w8-csv.js' });
  vm.runInContext(RED_KEY_SOURCE, ctx, { filename: 'w8-red-key.js' });
  return {
    win,
    doc,
    api: win.FalsifyW8RedKey,
    blobs,
    urls,
    revoked,
    getNetworkCalls: () => networkCalls,
  };
}

function makeMockPaper(initial = {}) {
  let state = { ready: false, sourceSha256: null, edits: [], ...initial };
  return {
    state: () => ({ ready: state.ready, sourceSha256: state.sourceSha256 }),
    edits: () => state.edits.map(e => ({ ...e, ...(e.assist ? { assist: { ...e.assist } } : {}) })),
    set(next) {
      state = { ...state, ...next };
    },
  };
}

test('FLS-18 exact 16 headers, order, filename, BOM, and CRLF', () => {
  assert.equal(RedKey.COLUMNS.length, 16);
  assert.deepEqual([...RedKey.COLUMNS], EXPECTED_HEADERS);
  assert.equal(RedKey.HEADER_LINE, EXPECTED_HEADER_LINE);
  assert.equal(RedKey.FILENAME, '정답지_W8.csv');
  assert.equal(RedKey.BUTTON_ID, 'w8-red-key-export');
  assert.equal(RedKey.BUTTON_LABEL, 'RED 정답지 CSV 다운로드');
  assert.equal(typeof W8Csv.triggerDownload, 'function');

  const emptyCsv = RedKey.toCsv([]);
  assert.deepEqual(parseCsv(emptyCsv), [EXPECTED_HEADERS]);
});

test('Reuses FalsifyW8Csv BOM, CRLF, csvCell (RFC 4180 + formula safety), and triggerDownload', () => {
  const { win, doc, api } = makeBrowserSandbox();
  let cellCalls = 0;
  let triggerCalls = 0;
  const origCell = win.FalsifyW8Csv.csvCell;
  const origTrigger = win.FalsifyW8Csv.triggerDownload;
  win.FalsifyW8Csv = {
    ...win.FalsifyW8Csv,
    csvCell(v) {
      cellCalls += 1;
      return origCell(v);
    },
    triggerDownload(d, csv, filename) {
      triggerCalls += 1;
      return origTrigger(d, csv, filename);
    },
  };

  const paper = makeMockPaper({
    ready: true,
    sourceSha256: 'a'.repeat(64),
    edits: [
      {
        id: 'e-1',
        pageIndex: 4,
        originalText: '=SUM(A1), "quoted"\nline2',
        newText: '-0.48',
        source: 'myai',
        assist: { kind: 'my-ai', reason: '+check Table 1' },
      },
    ],
  });
  const button = doc.createElement('button');
  api.mount(button, { paper });
  button.click();

  assert.ok(cellCalls >= 16, 'Expected csvCell delegation to FalsifyW8Csv');
  assert.equal(triggerCalls, 1, 'Expected triggerDownload delegation to FalsifyW8Csv');
  const rows = parseCsv(api.toCsv(paper.edits()));
  assert.equal(rows[1][7], '\'=SUM(A1), "quoted"\nline2');
  assert.equal(rows[1][8], "'-0.48");
  assert.equal(rows[1][10], "'+check Table 1");
});

test('Maps per-edit data truthfully: W8-01+, 1-based PDF쪽, raw texts, known methods, real assist.reason, duplicates, blank unknowns', () => {
  const cue = 'Compare the two changed values with Table 1.';
  const edits = [
    { id: 'e-1', pageIndex: 4, originalText: '0.95', newText: '0.65', source: 'myai', assist: { kind: 'my-ai', reason: cue } },
    // Duplicate text on same page preserved as distinct row; no assist.reason stays blank.
    { id: 'e-2', pageIndex: 4, originalText: '0.95', newText: '0.65', source: 'tap' },
    // Raw whitespace and empty deletion ("") preserved without normalization or placeholder.
    { id: 'e-3', pageIndex: 0, originalText: '  p < 0.05  ', newText: '', source: 'paragraph' },
    // Find-and-replace and recipe methods.
    { id: 'e-4', pageIndex: 2, originalText: '18', newText: '38', source: 'find' },
    { id: 'e-5', pageIndex: 1, originalText: 'alpha', newText: 'beta', source: 'recipe' },
    // Unknown source stays blank; ungrounded extra fields (reason/location/defectType) are ignored.
    { id: 'e-6', pageIndex: 3, originalText: '10%', newText: '20%', source: 'unknown-mode', reason: 'ignored', location: 'ignored', defectType: 'number' },
  ];

  const built = RedKey.buildExport(edits);
  assert.equal(built.filename, '정답지_W8.csv');
  assert.equal(built.editCount, 6);
  const rows = parseCsv(built.csv);
  assert.deepEqual(rows, [
    EXPECTED_HEADERS,
    ['W8-01', '', '', '', '5', '', '', '0.95', '0.65', '내 AI 레시피', cue, '', '', '', '', ''],
    ['W8-02', '', '', '', '5', '', '', '0.95', '0.65', '직접 편집', '', '', '', '', '', ''],
    ['W8-03', '', '', '', '1', '', '', '  p < 0.05  ', '', '문단 편집', '', '', '', '', '', ''],
    ['W8-04', '', '', '', '3', '', '', '18', '38', '찾아 바꾸기', '', '', '', '', '', ''],
    ['W8-05', '', '', '', '2', '', '', 'alpha', 'beta', '레시피', '', '', '', '', '', ''],
    ['W8-06', '', '', '', '4', '', '', '10%', '20%', '', '', '', '', '', '', ''],
  ]);
});

test('mount() binds only on mount, tracks ready/resume/edit/undo/paper-switch, one-click local download, zero network', () => {
  const { doc, api, blobs, urls, revoked, getNetworkCalls } = makeBrowserSandbox();
  const button = doc.createElement('button');
  button.id = 'w8-red-key-export';
  button.hidden = true;

  // Prior to mount, clicking does nothing.
  button.click();
  assert.equal(blobs.length, 0);

  const paper = makeMockPaper({ ready: false, sourceSha256: null, edits: [] });
  const ctl = api.mount(button, { paper });
  assert.equal(button.textContent, 'RED 정답지 CSV 다운로드');
  assert.equal(button.hidden, true);
  assert.equal(ctl.getPayload(), null);

  // Even if edits exist while paper.state().ready is false (mid-load/switch), stays hidden.
  paper.set({
    ready: false,
    edits: [{ id: 'stale', pageIndex: 0, originalText: '1', newText: '2', source: 'tap' }],
  });
  doc.dispatchEvent(new CustomEvent('falsify:w8-paper-change', { detail: { reason: 'loading' } }));
  assert.equal(button.hidden, true);
  assert.equal(ctl.getPayload(), null);

  // Resumed paper A with 2 edits + persisted assist.reason -> visible and exports exact CSV.
  const cue = 'PDF 5쪽 Table 1의 두 수치를 수정한다.';
  paper.set({
    ready: true,
    sourceSha256: '1'.repeat(64),
    edits: [
      { id: 'e-1', pageIndex: 4, originalText: '0.95', newText: '0.65', source: 'myai', assist: { kind: 'my-ai', reason: cue } },
      { id: 'e-2', pageIndex: 4, originalText: '0.78', newText: '0.48', source: 'myai', assist: { kind: 'my-ai', reason: cue } },
    ],
  });
  doc.dispatchEvent(new CustomEvent('falsify:w8-paper-change', { detail: { reason: 'resumed' } }));
  assert.equal(button.hidden, false);

  button.click();
  assert.equal(blobs.length, 1);
  assert.equal(doc.createdLinks[0].download, '정답지_W8.csv');
  assert.equal(revoked.length, 1);
  assert.deepEqual(parseCsv(urls.get(doc.createdLinks[0].href).parts[0]), [
    EXPECTED_HEADERS,
    ['W8-01', '', '', '', '5', '', '', '0.95', '0.65', '내 AI 레시피', cue, '', '', '', '', ''],
    ['W8-02', '', '', '', '5', '', '', '0.78', '0.48', '내 AI 레시피', cue, '', '', '', '', ''],
  ]);

  // Undo first edit -> removed edit does not appear.
  paper.set({
    edits: [{ id: 'e-2', pageIndex: 4, originalText: '0.78', newText: '0.48', source: 'myai', assist: { kind: 'my-ai', reason: cue } }],
  });
  doc.dispatchEvent(new CustomEvent('falsify:w8-paper-change', { detail: { reason: 'edit' } }));
  assert.deepEqual(parseCsv(ctl.getPayload().csv), [
    EXPECTED_HEADERS,
    ['W8-01', '', '', '', '5', '', '', '0.78', '0.48', '내 AI 레시피', cue, '', '', '', '', ''],
  ]);

  // Switch to unedited paper B -> hidden, no stale paper A key.
  paper.set({ ready: true, sourceSha256: '2'.repeat(64), edits: [] });
  doc.dispatchEvent(new CustomEvent('falsify:w8-paper-change', { detail: { reason: 'ready' } }));
  assert.equal(button.hidden, true);
  assert.equal(ctl.getPayload(), null);
  button.click();
  assert.equal(blobs.length, 1);

  // Re-mount replaces previous listener; destroy detaches cleanly.
  paper.set({ edits: [{ id: 'b-1', pageIndex: 0, originalText: '18', newText: '28', source: 'tap' }] });
  const ctl2 = api.mount(button, { paper });
  assert.equal(button.hidden, false);
  button.click();
  assert.equal(blobs.length, 2);
  ctl2.destroy();
  button.click();
  assert.equal(blobs.length, 2);
  assert.equal(getNetworkCalls(), 0, 'Zero network calls allowed');
});

test('Surfaces common download failure to caller onError without throwing unhandled click errors', () => {
  const { doc, api } = makeBrowserSandbox({ failBlob: true });
  const button = doc.createElement('button');
  const paper = makeMockPaper({
    ready: true,
    sourceSha256: '3'.repeat(64),
    edits: [{ id: 'e-1', pageIndex: 0, originalText: '18', newText: '28', source: 'tap' }],
  });
  const errors = [];
  api.mount(button, { paper, onError: err => errors.push(err) });
  assert.equal(button.hidden, false);

  button.click();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /파일 다운로드/);
});
