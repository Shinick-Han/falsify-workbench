'use strict';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const W8 = require('../dist/w8-csv.js');
const W8_SOURCE = readFileSync(new URL('../dist/w8-csv.js', import.meta.url), 'utf8');

const EXPECTED_HEADER =
  '참가자,조건,탐지기,모델,실행번호,ID,물리 페이지,위치(절·그림·표),유형,판정(아님/확인필요),심각도,정확한 원문 인용,대응 근거·이유·검산,확신,추가로 필요한 정보';

// Minimal RFC 4180 CSV parser supporting CRLF and multiline quoted fields.
function parseCsv(csvText) {
  assert.equal(csvText.charCodeAt(0), 0xfeff, 'CSV must start with UTF-8 BOM');
  assert.ok(csvText.endsWith('\r\n'), 'CSV must end with CRLF');
  const body = csvText.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else {
      assert.notEqual(ch, '\n', 'Unquoted bare LF is not allowed in Excel CSV');
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
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this._text = '';
    this.className = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.type = '';
    this.href = '';
    this.download = '';
    this.target = '';
    this.rel = '';
    this.focused = false;
    this.classList = {
      toggle: (cls, force) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        const next = force === undefined ? !set.has(cls) : Boolean(force);
        if (next) set.add(cls);
        else set.delete(cls);
        this.className = [...set].join(' ');
      },
      contains: cls => this.className.split(/\s+/).includes(cls),
    };
  }
  get textContent() {
    return this._text + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v) {
    for (const c of this.children) if (c && typeof c === 'object') c.parentNode = null;
    this.children = [];
    this._text = String(v);
  }
  append(...kids) {
    for (const kid of kids) {
      if (kid && typeof kid === 'object') kid.parentNode = this;
      this.children.push(kid);
    }
  }
  replaceChildren(...kids) {
    for (const c of this.children) if (c && typeof c === 'object') c.parentNode = null;
    this.children = [];
    this._text = '';
    this.append(...kids);
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  focus() {
    this.focused = true;
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new Event('click'));
  }
  *walk() {
    yield this;
    for (const c of this.children) {
      if (c && typeof c === 'object' && typeof c.walk === 'function') yield* c.walk();
    }
  }
  find(pred) {
    for (const n of this.walk()) if (pred(n)) return n;
    return null;
  }
  findAll(pred) {
    const out = [];
    for (const n of this.walk()) if (pred(n)) out.push(n);
    return out;
  }
}

function createDom() {
  const doc = new EventTarget();
  const createdAnchors = [];
  doc.createElement = tag => {
    const el = new SyntheticEl(tag, doc);
    if (tag.toLowerCase() === 'a') createdAnchors.push(el);
    return el;
  };
  const host = new SyntheticEl('div', doc);
  const store = new Map();
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: k => {
      store.delete(k);
    },
  };
  return { doc, host, storage, createdAnchors };
}

function makeSampleRun(overrides = {}) {
  return {
    id: 'run-1',
    fileHash: 'a'.repeat(64),
    detector: '내장 BLUE',
    model: 'claude-sonnet-4-6',
    condition: 'A',
    runNumber: 1,
    findings: [
      {
        id: 'B-1',
        pageIndex: 0,
        locationLabel: 'Table 1',
        findingType: 'D1',
        verdictLabel: '아님',
        severity: '높음',
        quote: 'Ragas faithfulness is 0.95.',
        rationale: '본문 수치와 표 수치가 서로 다릅니다.',
        evidence: [
          { quote: 'Table 1: Ragas 0.50', relation: '표 1 수치와 불일치' },
          { quote: 'Section 4 reports 0.50 on WikiEval.', relation: '본문 4절과 상충' },
        ],
        confidence: '높음',
        uncertainty: '원시 채점표 확인 필요',
      },
    ],
    ...overrides,
  };
}

test('header is byte-perfect UTF-8 BOM + exact 15 columns + CRLF', () => {
  const csv = W8.toCsv([], { participant: '홍길동', condition: 'A' });
  const expected = '\uFEFF' + EXPECTED_HEADER + '\r\n';
  assert.equal(csv, expected);
  const bytes = Buffer.from(csv, 'utf8');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual(bytes, Buffer.from(expected, 'utf8'));
  const parsed = parseCsv(csv);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].length, 15);
  assert.deepEqual(parsed[0], [...W8.COLUMNS]);
});

test('no findings in completed runs produces header-only BOM CSV', () => {
  const csv = W8.toCsv(
    [makeSampleRun({ id: 'empty-1', findings: [] }), makeSampleRun({ id: 'empty-2', runNumber: 2, findings: [] })],
    { participant: '김연구', condition: 'A' }
  );
  assert.equal(csv, '\uFEFF' + EXPECTED_HEADER + '\r\n');
  assert.equal(parseCsv(csv).length, 1);
});

test('filename follows Blue_W8_<이름>_<조건>.csv with A/B/C study condition and sanitizes unsafe characters', () => {
  assert.equal(W8.buildFilename('홍길동'), 'Blue_W8_홍길동_A.csv');
  assert.equal(W8.buildFilename('홍길동', 'A'), 'Blue_W8_홍길동_A.csv');
  assert.equal(W8.buildFilename('홍길동', 'B'), 'Blue_W8_홍길동_B.csv');
  assert.equal(W8.buildFilename('홍길동', 'B 자유'), 'Blue_W8_홍길동_B.csv');
  assert.equal(W8.buildFilename('홍길동', 'W8-B'), 'Blue_W8_홍길동_B.csv');
  assert.equal(W8.buildFilename('홍길동', 'C'), 'Blue_W8_홍길동_C.csv');
  assert.equal(W8.buildFilename('  Alice Kim  '), 'Blue_W8_Alice_Kim_A.csv');
  assert.equal(W8.buildFilename('../bad:name*?"<>|'), 'Blue_W8_bad_name_A.csv');
  assert.equal(W8.buildFilename('   '), 'Blue_W8_참가자_A.csv');
});

test('unmatched findings are preserved and multiple evidence items are grouped into one cell', () => {
  const run = makeSampleRun({
    findings: [
      {
        id: 'B-1',
        pageIndex: 0,
        locationLabel: 'Table 1',
        findingType: 'D1',
        verdictLabel: '아님',
        severity: '높음',
        quote: 'Faithfulness = 0.95',
        rationale: '표 1 수치와 다릅니다.',
        evidence: [
          { quote: 'Table 1: 0.50', relation: '표 1 값' },
          { quote: 'Appendix A: 0.50', relation: '부록 재집계' },
        ],
        confidence: '높음',
        uncertainty: '부록 표 원본 필요',
      },
      {
        id: 'B-unmatched',
        pageIndex: null,
        locationLabel: '',
        findingType: '',
        verdictLabel: '',
        severity: '',
        quote: 'Unlocated passage from response',
        rationale: '본문에서 자동 매칭되지 않았으나 수치가 의심됨',
        evidence: [],
        confidence: '',
        uncertainty: '원문 페이지 확인 필요',
      },
    ],
  });

  const rows = parseCsv(W8.toCsv([run], { participant: '홍길동', condition: 'A' }));
  assert.equal(rows.length, 3, 'header + 2 findings (evidence grouped, not exploded into extra rows)');

  const matched = rows[1];
  assert.equal(matched[0], '홍길동');
  assert.equal(matched[1], 'A');
  assert.equal(matched[2], '내장 BLUE');
  assert.equal(matched[3], 'claude-sonnet-4-6');
  assert.equal(matched[4], '1');
  assert.equal(matched[5], 'B-1');
  assert.equal(matched[6], '1', '0-based pageIndex 0 becomes 1-based physical page 1');
  assert.equal(matched[7], 'Table 1');
  assert.equal(matched[8], 'D1');
  assert.equal(matched[9], '아님');
  assert.equal(matched[10], '높음');
  assert.equal(matched[11], 'Faithfulness = 0.95');
  assert.ok(matched[12].includes('표 1 수치와 다릅니다.'));
  assert.ok(matched[12].includes('표 1 값'));
  assert.ok(matched[12].includes('Table 1: 0.50'));
  assert.ok(matched[12].includes('부록 재집계'));
  assert.ok(matched[12].includes('Appendix A: 0.50'));
  assert.equal(matched[13], '높음');
  assert.equal(matched[14], '부록 표 원본 필요');

  const unmatched = rows[2];
  assert.equal(unmatched[5], 'B-unmatched');
  assert.equal(unmatched[6], '', 'unmatched finding leaves physical page empty');
  assert.equal(unmatched[7], '', 'unmatched finding leaves location empty');
  assert.equal(unmatched[8], '', 'do not fabricate findingType');
  assert.equal(unmatched[9], '', 'do not fabricate verdictLabel');
  assert.equal(unmatched[10], '', 'do not fabricate severity');
  assert.equal(unmatched[11], 'Unlocated passage from response');
  assert.equal(unmatched[12], '본문에서 자동 매칭되지 않았으나 수치가 의심됨');
  assert.equal(unmatched[13], '', 'do not fabricate confidence');
  assert.equal(unmatched[14], '원문 페이지 확인 필요');
});

test('CSV quoting preserves commas, double quotes, multiline quotes, and guards Excel formulas', () => {
  const run = makeSampleRun({
    findings: [
      {
        id: 'Q-1',
        pageIndex: 2,
        locationLabel: 'Section 3, "Results"',
        findingType: 'D3',
        verdictLabel: '확인필요',
        severity: '중간',
        quote: 'Line 1, with "quotes"\nLine 2, after newline',
        rationale: 'First line\r\nSecond line with "emphasis", ok',
        evidence: [{ quote: 'Cell A, "B"', relation: '근거, 비교' }],
        confidence: '중간',
        uncertainty: '',
      },
      {
        id: 'Q-2',
        pageIndex: 3,
        locationLabel: 'Table 2',
        findingType: 'D1',
        verdictLabel: '아님',
        severity: '높음',
        quote: '=HYPERLINK("http://example.test", "click")',
        rationale: '+1+1 formula text',
        evidence: [{ quote: '@SUM(A1:A2)', relation: '-check' }],
        confidence: '높음',
        uncertainty: '\tcmd',
      },
    ],
  });

  const csv = W8.toCsv([run], { participant: '이검수', condition: 'A' });
  assert.ok(csv.includes('""quotes""'), 'embedded double quotes are doubled');
  assert.ok(csv.includes(`"'=HYPERLINK(""http://example.test"", ""click"")"`), 'leading = is formula-guarded');
  assert.ok(csv.includes("'+1+1 formula text"), 'leading + is formula-guarded');

  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][7], 'Section 3, "Results"');
  assert.equal(rows[1][11], 'Line 1, with "quotes"\nLine 2, after newline');
  assert.ok(rows[1][12].includes('First line\r\nSecond line with "emphasis", ok'));
  assert.ok(rows[1][12].includes('Cell A, "B"'));

  assert.equal(rows[2][11], `\'=HYPERLINK("http://example.test", "click")`);
  assert.equal(rows[2][12].startsWith("'+1+1 formula text"), true);
  assert.equal(rows[2][14], "'\tcmd");
});

test('duplicate run IDs are deduplicated across CSV export and multi-run numbering is preserved', () => {
  const run1 = makeSampleRun({ id: 'dup-id', runNumber: 1, model: 'model-a' });
  const run1Dup = makeSampleRun({ id: 'dup-id', runNumber: 1, model: 'model-a-duplicate' });
  const run2 = makeSampleRun({
    id: 'run-2',
    runNumber: 2,
    detector: '외부 AI',
    model: 'gpt-5',
    condition: 'W8-v6',
    findings: [
      {
        id: 'E-1',
        pageIndex: 4,
        locationLabel: 'Figure 2',
        findingType: 'D1',
        verdictLabel: '아님',
        severity: '높음',
        quote: 'Figure 2 shows 80%.',
        rationale: '본문은 60%로 서술함',
        evidence: [],
        confidence: '높음',
        uncertainty: '',
      },
    ],
  });

  const fallbackBuilt = W8.buildExport([run1, run1Dup, run2], { participant: '박실험' });
  assert.equal(fallbackBuilt.runs.length, 2);
  assert.deepEqual(fallbackBuilt.runs.map(r => r.id), ['dup-id', 'run-2']);
  assert.equal(fallbackBuilt.filename, 'Blue_W8_박실험_A.csv');

  const fallbackRows = parseCsv(fallbackBuilt.csv);
  assert.equal(fallbackRows.length, 3);
  assert.equal(fallbackRows[1][3], 'model-a');
  assert.equal(fallbackRows[1][4], '1');
  assert.equal(fallbackRows[1][1], 'A', 'per-run condition retained when user provides no override');
  assert.equal(fallbackRows[2][2], '외부 AI');
  assert.equal(fallbackRows[2][3], 'gpt-5');
  assert.equal(fallbackRows[2][4], '2');
  assert.equal(fallbackRows[2][1], 'W8-v6', 'per-run condition retained when user provides no override');

  const overrideBuilt = W8.buildExport([run1, run1Dup, run2], { participant: '박실험', condition: 'B' });
  assert.equal(overrideBuilt.filename, 'Blue_W8_박실험_B.csv');
  const overrideRows = parseCsv(overrideBuilt.csv);
  assert.equal(overrideRows[1][1], 'B', 'user study override applies to filename and all rows');
  assert.equal(overrideRows[2][1], 'B', 'user study override beats per-run prompt condition');
});

test('accepts native workbench variants (experiment-ledger, hosted job, external exchange)', () => {
  const ledgerRun = {
    id: 'ledger-1',
    fileHash: 'b'.repeat(64),
    harness: { name: 'BLUE', version: '1' },
    model: 'claude-opus-4-6',
    segments: [{ id: 's2', pageIndex: 2, label: '3쪽 · Methods', text: 'Sample N=40.' }],
    response: {
      findings: [
        {
          id: 'L-1',
          segmentId: 's2',
          quote: 'Sample N=40.',
          rationale: '표 2 합계는 38명입니다.',
          evidence: [{ segmentId: 's2', quote: 'Total = 38', relation: '합계 불일치' }],
          uncertainty: '탈락자 수 미기재',
        },
      ],
    },
  };
  const hostedJobRun = {
    id: 'hosted-1',
    fileHash: 'b'.repeat(64),
    source: 'hosted',
    result: {
      model: 'gpt-5.2',
      findings: [
        {
          id: 'H-1',
          segmentId: 'p7-b4',
          verdictLabel: '아님',
          quote: 'AUC = 0.99',
          rationale: 'ROC 곡선과 불일치',
          evidence: [],
        },
      ],
    },
  };
  const externalRun = {
    id: 'ext-1',
    fileHash: 'b'.repeat(64),
    provenance: 'imported-unverified',
    model: 'manual-model-unverified',
    items: [
      {
        id: 'X-1',
        page: 5,
        locationLabel: 'Discussion',
        quote: 'Effect doubled.',
        rationale: '실제 증가율은 1.2배',
        zeroDropRecovered: true,
        evidence: ['Table 3 shows 1.2x'],
      },
    ],
  };

  const rows = parseCsv(W8.toCsv([ledgerRun, hostedJobRun, externalRun], { participant: '최검토', condition: 'A' }));
  assert.equal(rows.length, 4);

  // Ledger run
  assert.equal(rows[1][2], 'BLUE v1');
  assert.equal(rows[1][3], 'claude-opus-4-6');
  assert.equal(rows[1][4], '1');
  assert.equal(rows[1][6], '3');
  assert.equal(rows[1][7], '3쪽 · Methods');

  // Hosted run
  assert.equal(rows[2][2], '내장 BLUE');
  assert.equal(rows[2][3], 'gpt-5.2');
  assert.equal(rows[2][4], '2');
  assert.equal(rows[2][6], '7');
  assert.equal(rows[2][9], '아님');

  // External run
  assert.equal(rows[3][2], '외부 AI');
  assert.equal(rows[3][3], '', 'manual-model-unverified is omitted');
  assert.equal(rows[3][4], '3');
  assert.equal(rows[3][6], '5');
  assert.equal(rows[3][9], '확인필요', 'zeroDropRecovered provides grounded 확인필요');
  assert.ok(rows[3][12].includes('Table 3 shows 1.2x'));
});

test('mount works without OAuth, autofills participant/condition once, updates on falsify:w8-runs-change, and downloads offline', () => {
  const { doc, host, storage } = createDom();
  let currentRuns = [makeSampleRun({ id: 'r1', runNumber: 1 }), makeSampleRun({ id: 'r1', runNumber: 1 })];
  const downloaded = [];

  const ctrl = W8.mount(host, {
    document: doc,
    storage,
    runs: () => currentRuns,
    download: payload => downloaded.push(payload),
  });

  // No submit button or disclosure when onSubmit is absent.
  assert.equal(ctrl.element.find(n => n.getAttribute('data-w8-action') === 'submit'), null);
  assert.equal(ctrl.element.find(n => n.getAttribute('data-w8-disclosure') === 'true'), null);

  // Duplicate run IDs render only one checkbox.
  let boxes = ctrl.element.findAll(n => n.tagName === 'INPUT' && n.type === 'checkbox');
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].checked, true);

  // Downloading without participant shows inline Korean feedback without alert/modal.
  const dlBtn = ctrl.element.find(n => n.getAttribute('data-w8-action') === 'download');
  const participantInput = ctrl.element.find(n => n.getAttribute('data-w8-field') === 'participant');
  const conditionInput = ctrl.element.find(n => n.getAttribute('data-w8-field') === 'condition');
  const statusEl = ctrl.element.find(n => n.getAttribute('data-w8-status') === 'true');

  dlBtn.click();
  assert.equal(downloaded.length, 0);
  assert.match(statusEl.textContent, /참가자 이름/);
  assert.equal(participantInput.focused, true);

  // Fill participant & condition once -> persisted to storage.
  participantInput.value = '홍길동';
  participantInput.dispatchEvent(new Event('input'));
  conditionInput.value = 'W8-A';
  conditionInput.dispatchEvent(new Event('input'));

  dlBtn.click();
  assert.equal(downloaded.length, 1);
  assert.equal(downloaded[0].filename, 'Blue_W8_홍길동_A.csv');
  assert.equal(downloaded[0].participant, '홍길동');
  assert.equal(downloaded[0].condition, 'W8-A');
  assert.equal(downloaded[0].csv.charCodeAt(0), 0xfeff);

  // Add second run and dispatch falsify:w8-runs-change.
  currentRuns = [
    makeSampleRun({ id: 'r1', runNumber: 1 }),
    makeSampleRun({ id: 'r2', runNumber: 2, detector: '외부 AI', model: 'gpt-5' }),
  ];
  doc.dispatchEvent(new Event('falsify:w8-runs-change'));

  boxes = ctrl.element.findAll(n => n.tagName === 'INPUT' && n.type === 'checkbox');
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].checked, true);
  assert.equal(boxes[1].checked, true);

  // Uncheck first run; only second run is exported.
  boxes[0].checked = false;
  boxes[0].dispatchEvent(new Event('change'));
  dlBtn.click();
  assert.equal(downloaded.length, 2);
  assert.deepEqual(downloaded[1].runs.map(r => r.id), ['r2']);

  // Remounting autofills saved participant and condition automatically without asking again.
  ctrl.destroy();
  const host2 = new SyntheticEl('div', doc);
  const ctrl2 = W8.mount(host2, {
    document: doc,
    storage,
    runs: () => currentRuns,
    download: payload => downloaded.push(payload),
  });
  assert.equal(ctrl2.element.find(n => n.getAttribute('data-w8-field') === 'participant').value, '홍길동');
  assert.equal(ctrl2.element.find(n => n.getAttribute('data-w8-field') === 'condition').value, 'W8-A');
  ctrl2.destroy();
});

test('mount with onSubmit shows concise privacy disclosure, sends full payload, renders receipt links, and allows download on failure', async () => {
  const { doc, host, storage } = createDom();
  const runs = [
    makeSampleRun({ id: 'r1', runNumber: 1 }),
    makeSampleRun({ id: 'r2', runNumber: 2, detector: '외부 AI', model: 'gpt-5' }),
  ];
  storage.setItem(W8.STORAGE_KEY, JSON.stringify({ participant: '김참가', condition: 'A' }));

  const submitted = [];
  const downloaded = [];
  let mode = 'ok';

  const ctrl = W8.mount(host, {
    document: doc,
    storage,
    runs: () => runs,
    download: p => downloaded.push(p),
    onSubmit: async payload => {
      submitted.push(payload);
      if (mode === 'ok') {
        return {
          pageUrl: 'https://falsify.atlassian.net/wiki/spaces/Falsify/pages/999',
          issueUrl: 'https://falsify.atlassian.net/browse/FLS-18',
        };
      }
      if (mode === 'xss') {
        return {
          pageUrl: 'javascript:alert(1)',
          issueUrl: 'https://falsify.atlassian.net/browse/FLS-18',
        };
      }
      throw new Error('팀 연결이 끊겼습니다.');
    },
  });

  const disclosure = ctrl.element.find(n => n.getAttribute('data-w8-disclosure') === 'true');
  assert.ok(disclosure, 'disclosure is rendered when onSubmit is provided');
  assert.match(disclosure.textContent, /지적 2건/);
  assert.match(disclosure.textContent, /Falsify 팀 공간/);
  assert.match(disclosure.textContent, /FLS-18/);
  assert.match(disclosure.textContent, /CSV/);
  assert.match(disclosure.textContent, /원문 인용/);
  assert.match(disclosure.textContent, /개인 PDF/);
  assert.match(disclosure.textContent, /키/);

  // No extra consent checkbox besides the run selection checkboxes.
  const checkboxes = ctrl.element.findAll(n => n.tagName === 'INPUT' && n.type === 'checkbox');
  assert.equal(checkboxes.length, 2);

  const submitBtn = ctrl.element.find(n => n.getAttribute('data-w8-action') === 'submit');
  const dlBtn = ctrl.element.find(n => n.getAttribute('data-w8-action') === 'download');
  const statusEl = ctrl.element.find(n => n.getAttribute('data-w8-status') === 'true');

  submitBtn.click();
  await new Promise(r => setImmediate(r));

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].csv.charCodeAt(0), 0xfeff);
  assert.equal(submitted[0].filename, 'Blue_W8_김참가_A.csv');
  assert.equal(submitted[0].participant, '김참가');
  assert.equal(submitted[0].condition, 'A');
  assert.deepEqual(submitted[0].runs.map(r => r.id), ['r1', 'r2']);

  const pageLink = ctrl.element.find(n => n.getAttribute('data-w8-link') === 'page');
  const issueLink = ctrl.element.find(n => n.getAttribute('data-w8-link') === 'issue');
  assert.equal(pageLink.href, 'https://falsify.atlassian.net/wiki/spaces/Falsify/pages/999');
  assert.equal(pageLink.rel, 'noopener noreferrer');
  assert.equal(issueLink.href, 'https://falsify.atlassian.net/browse/FLS-18');
  assert.equal(statusEl.classList.contains('error'), false);

  // Unsafe javascript: receipt URL is rejected while valid issueUrl still renders.
  mode = 'xss';
  submitBtn.click();
  await new Promise(r => setImmediate(r));
  assert.equal(ctrl.element.find(n => n.getAttribute('data-w8-link') === 'page'), null);
  assert.equal(
    ctrl.element.find(n => n.getAttribute('data-w8-link') === 'issue').href,
    'https://falsify.atlassian.net/browse/FLS-18'
  );

  // Disconnected / submit error renders error and still allows local CSV download.
  mode = 'error';
  submitBtn.click();
  await new Promise(r => setImmediate(r));
  assert.equal(statusEl.classList.contains('error'), true);
  assert.match(statusEl.textContent, /팀 연결이 끊겼습니다/);
  assert.equal(dlBtn.disabled, false);

  dlBtn.click();
  assert.equal(downloaded.length, 1);
  assert.equal(downloaded[0].csv, submitted[0].csv);

  // Stale receipt links from an earlier success were cleared on the failed retry.
  assert.equal(ctrl.element.find(n => n.getAttribute('data-w8-link') === 'issue'), null);

  ctrl.destroy();
});

test('browser script globals, default Blob download, zero-finding run, partial receipt, and CSP safety', async () => {
  const { doc, host, storage, createdAnchors } = createDom();
  const createdBlobs = [];
  const revokedUrls = [];
  const sandbox = {
    document: doc,
    localStorage: storage,
    Event,
    URL: class extends URL {
      static createObjectURL(blob) {
        createdBlobs.push(blob);
        return 'blob:w8-test-' + createdBlobs.length;
      }
      static revokeObjectURL(url) {
        revokedUrls.push(url);
      }
    },
    Blob: class FakeBlob {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = opts?.type || '';
      }
    },
    setTimeout: fn => {
      fn();
      return {};
    },
    alert: () => {
      throw new Error('alert must not be called');
    },
    confirm: () => {
      throw new Error('confirm must not be called');
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(W8_SOURCE, sandbox);
  assert.ok(sandbox.FalsifyW8Csv && typeof sandbox.FalsifyW8Csv.mount === 'function');

  // Start with 0 runs: entire export section must be hidden.
  let runs = [];

  const ctrl = sandbox.FalsifyW8Csv.mount(host, {
    runs: () => runs,
    onSubmit: async () => ({
      pageUrl: 'https://falsify.atlassian.net/wiki/spaces/Falsify/pages/101',
      error: 'Jira 댓글을 남기지 못했습니다.',
    }),
  });

  assert.equal(ctrl.element.hidden, true, 'entire export section stays hidden until there is at least one run');

  // Appear with a zero-findings completed run: section becomes visible and downloadable.
  runs = [
    {
      id: 'zero-run',
      fileHash: 'c'.repeat(64),
      detector: '내장 BLUE',
      model: 'claude-sonnet-4-6',
      runNumber: 1,
      findings: [],
    },
  ];
  doc.dispatchEvent(new Event('falsify:w8-runs-change'));
  assert.equal(ctrl.element.hidden, false, 'zero-findings completed run reveals export section');

  // CSP style-src 'self': no <style> elements and no inline style attributes.
  for (const node of ctrl.element.walk()) {
    assert.notEqual(node.tagName, 'STYLE');
    assert.equal(node.getAttribute('style'), null);
  }

  const participantInput = ctrl.element.find(n => n.getAttribute('data-w8-field') === 'participant');
  const conditionInput = ctrl.element.find(n => n.getAttribute('data-w8-field') === 'condition');
  const dlBtn = ctrl.element.find(n => n.getAttribute('data-w8-action') === 'download');
  const submitBtn = ctrl.element.find(n => n.getAttribute('data-w8-action') === 'submit');
  const statusEl = ctrl.element.find(n => n.getAttribute('data-w8-status') === 'true');

  assert.equal(dlBtn.disabled, false, 'zero-finding completed run is still downloadable');
  participantInput.value = '윤테스터';
  participantInput.dispatchEvent(new Event('input'));
  conditionInput.value = 'W8-Custom';
  conditionInput.dispatchEvent(new Event('input'));

  // Default Blob download path.
  dlBtn.click();
  assert.equal(createdBlobs.length, 1);
  assert.equal(createdBlobs[0].type, 'text/csv;charset=utf-8');
  assert.equal(createdBlobs[0].parts[0], '\uFEFF' + EXPECTED_HEADER + '\r\n');
  const dlAnchor = createdAnchors.at(-1);
  assert.equal(dlAnchor.download, 'Blue_W8_윤테스터_A.csv');
  assert.equal(dlAnchor.href, 'blob:w8-test-1');
  assert.deepEqual(revokedUrls, ['blob:w8-test-1']);

  // Run without condition inherits user-entered W8 condition in CSV column 2.
  runs = [
    {
      id: 'no-cond-run',
      fileHash: 'c'.repeat(64),
      detector: '내장 BLUE',
      model: 'claude-sonnet-4-6',
      runNumber: 1,
      findings: [{ id: 'F1', pageIndex: 1, quote: 'q', rationale: 'r', evidence: [] }],
    },
  ];
  doc.dispatchEvent(new Event('falsify:w8-runs-change'));
  const rows = parseCsv(ctrl.getPayload().csv);
  assert.equal(rows[1][1], 'W8-Custom');
  assert.equal(rows[1][6], '2');

  // Partial receipt renders pageUrl AND error text.
  submitBtn.click();
  await new Promise(r => setImmediate(r));
  assert.equal(
    ctrl.element.find(n => n.getAttribute('data-w8-link') === 'page').href,
    'https://falsify.atlassian.net/wiki/spaces/Falsify/pages/101'
  );
  assert.equal(statusEl.classList.contains('error'), true);
  assert.match(statusEl.textContent, /Jira 댓글을 남기지 못했습니다/);

  // Empty runs after PDF switch hides entire export section again and disables buttons cleanly.
  runs = [];
  doc.dispatchEvent(new Event('falsify:w8-runs-change'));
  assert.equal(ctrl.element.hidden, true, 'switching to PDF with no runs hides export section again');
  assert.equal(dlBtn.disabled, true);
  assert.equal(submitBtn.disabled, true);

  ctrl.destroy();
});

test('user-selected condition B updates filename/rows, clearing falls back to per-run condition, references and 맞음 rows are preserved', () => {
  const { doc, host, storage } = createDom();
  const X = require('../dist/external-exchange.js');
  const segments = [
    { id: 'p1-b0', pageIndex: 0, label: 'PDF p. 1', text: 'Synthetic total 420, subgroup sum 400.' },
    { id: 'p2-b0', pageIndex: 1, label: 'PDF p. 2', text: 'Confirmed baseline statement.' },
  ];
  const mixedInput = [
    '## B. 결함 및 확인필요 후보',
    '| ID | 물리 페이지 | 위치(절·그림·표) | 유형 | 판정(아님/확인필요) | 심각도 | 정확한 원문 인용 | 대응 근거·이유·검산(원문/그림판독/가정 구분) | 확신 | 추가로 필요한 정보 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| F-1 | 1 | Table 1 | D1 | 아님 | 가벼움 | Synthetic total 420, subgroup sum 400. | 합계 불일치 | 높음 | 없음 |',
    '| F-2 | 2 | Section 2 | D3 | 맞음 | 가벼움 | Confirmed baseline statement. | 원문 확인됨 | 높음 | 없음 |',
    '',
    '```csv',
    EXPECTED_HEADER,
    '테스터,B,내 AI,synth-model-b,1,F-1,1,"Table 1, Row 2",D1,아님,가벼움,"Synthetic total 420, subgroup sum 400.","합계 불일치\n[근거] 표 1 비교 | 인용: 160+140+100=400\n[참고] PDF p.1 Table 1",높음,없음',
    '테스터,B,내 AI,synth-model-b,1,F-2,2,Section 2,D3,맞음,가벼움,Confirmed baseline statement.,원문 확인됨,높음,없음',
    '```',
  ].join('\n');

  const batch = X.parse(mixedInput, { role: 'blue', segments, fileHash: 'd'.repeat(64) });
  assert.equal(batch.items.length, 2);

  const runFromExternal = {
    id: 'ext-mixed-1',
    fileHash: 'd'.repeat(64),
    detector: '내 AI',
    model: batch.model,
    condition: '공통 프롬프트 v6',
    runNumber: 1,
    segments,
    findings: batch.items.map(it => ({
      ...it,
      references: it.references.length ? it.references : [{ label: 'Table 1', doi: '10.1000/synth' }],
    })),
  };

  const downloaded = [];
  const ctrl = W8.mount(host, {
    document: doc,
    storage,
    runs: () => [runFromExternal],
    download: payload => downloaded.push(payload),
  });

  const participantInput = ctrl.element.find(n => n.getAttribute('data-w8-field') === 'participant');
  const conditionInput = ctrl.element.find(n => n.getAttribute('data-w8-field') === 'condition');
  const summaryEl = ctrl.element.find(n => n.getAttribute('data-w8-summary') === 'true');
  const dlBtn = ctrl.element.find(n => n.getAttribute('data-w8-action') === 'download');

  // Non-study run condition ("공통 프롬프트 v6") must not overwrite default study condition "A".
  assert.equal(conditionInput.value, 'A');

  participantInput.value = '김연구';
  participantInput.dispatchEvent(new Event('input'));
  conditionInput.value = 'B';
  conditionInput.dispatchEvent(new Event('input'));
  assert.match(summaryEl.textContent, /Blue_W8_김연구_B\.csv/);

  dlBtn.click();
  assert.equal(downloaded.length, 1);
  assert.equal(downloaded[0].filename, 'Blue_W8_김연구_B.csv');
  const rowsB = parseCsv(downloaded[0].csv);
  assert.equal(rowsB.length, 3, 'all findings including 맞음 are preserved without silent drops');
  assert.equal(rowsB[1][1], 'B');
  assert.equal(rowsB[1][6], '1');
  assert.equal(rowsB[1][7], 'Table 1, Row 2');
  assert.ok(rowsB[1][12].includes('[참고] PDF p.1 Table 1'), 'string references preserved in evidence cell');
  assert.equal(rowsB[2][1], 'B');
  assert.equal(rowsB[2][9], '맞음', '맞음 row is preserved');
  assert.ok(rowsB[2][12].includes('[참고] Table 1 · 10.1000/synth'), 'object references preserved in evidence cell');

  // Clearing study condition override falls back to per-run condition.
  conditionInput.value = '';
  conditionInput.dispatchEvent(new Event('input'));
  dlBtn.click();
  const rowsFallback = parseCsv(downloaded[1].csv);
  assert.equal(rowsFallback[1][1], '공통 프롬프트 v6');
  assert.equal(rowsFallback[2][1], '공통 프롬프트 v6');

  ctrl.destroy();
});
