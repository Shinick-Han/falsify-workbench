import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {prepare} = await import(pathToFileURL(resolve(app, 'dist/paragraph-pdf.mjs')).href);
const localPython = 'C:\\Users\\user\\source\\falsify\\coordination\\ocr-chart-wave-20261103\\runtime\\Scripts\\python.exe';
const python = process.env.PYTHON_EXECUTABLE || process.env.FALSIFY_PYTHON || (existsSync(localPython) ? localPython : 'python');
const refusal = '그림 안 글자를 고치면 그림이 깨져서 만들지 않았습니다. 표·그래프·그림 고치기를 쓰세요.';
const kept = ['3%', '23%', '28%', '44%', '73%', 'AcuteUTI', 'PulmEmbol', 'HeartFail', 'SepsisCase', 'StrokeUnit', 'Body', 'paragraph', 'remains', 'outside', 'the', 'figure.'];

function fixture() {
  const run = spawnSync(python, [resolve(app, 'tests/fixtures/figure_text_collision.py')], {maxBuffer: 8 * 1024 * 1024});
  assert.equal(run.status, 0, String(run.stderr || run.error || 'fixture generator failed'));
  return new Uint8Array(run.stdout);
}

function localFetch(input) {
  const url = new URL(input);
  assert.equal(url.protocol, 'file:');
  assert.ok(url.pathname.includes('/dist/paragraph-vendor/'));
  return new Response(readFileSync(url));
}

function wordsOf(bytes) {
  const warnings = [];
  mupdf.setLog(message => warnings.push(String(message)));
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  try {
    const page = doc.loadPage(0);
    try {
      const pix = page.toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false);
      pix.destroy();
      const structured = page.toStructuredText();
      try { return {words: structured.asText().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean), warnings}; }
      finally { structured.destroy(); }
    } finally { page.destroy(); }
  } finally {
    doc.destroy();
    mupdf.setLog(null);
  }
}

function boxes(bytes, needle) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const page = doc.loadPage(0);
  try { return page.search(needle).flat(2).map(value => Math.round(value * 10) / 10); }
  finally { page.destroy(); doc.destroy(); }
}

test('figure label edit keeps the figure, and the unpromoted path is refused', {timeout: 120000}, async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = localFetch;
  try {
    const source = fixture();
    const original = source.slice();
    const before = wordsOf(source);
    assert.equal(before.warnings.length, 0);
    assert.equal(before.words.length, 19);
    assert.equal(before.words.filter(word => word === '96%').length, 1);
    assert.equal(before.words.filter(word => word === '1%').length, 2);
    const edited = await prepare({file: source, edits: [{id: 'cell', pageIndex: 0, before: '96%', after: '69%'}]});
    assert.deepEqual(source, original);
    const bytes = new Uint8Array(await edited.file.arrayBuffer());
    const after = wordsOf(bytes);
    assert.equal(after.warnings.length, 0, after.warnings.slice(0, 3).join('\n'));
    assert.equal(after.words.length, 19);
    assert.equal(after.words.includes('96%'), false);
    assert.equal(after.words.filter(word => word === '69%').length, 1);
    assert.equal(after.words.filter(word => word === '1%').length, 2);
    for (const word of kept) assert.equal(after.words.includes(word), true, word);
    assert.deepEqual(boxes(bytes, '69%'), boxes(source, '96%'));
    await assert.rejects(
      prepare({file: source, rewriteFigureResources: false, edits: [{id: 'cell', pageIndex: 0, before: '96%', after: '69%'}]}),
      error => error.code === 'figure-text-corrupt' && error.message === refusal
    );
    const workspace = readFileSync(resolve(app, 'dist/paper-workspace.js'), 'utf8');
    assert.equal(workspace.includes(refusal), true);
  } finally { globalThis.fetch = previous; }
});

test('lost-word check ignores reflowed hyphenation and edits inside a word, and still finds real losses', async () => {
  const {lostWords} = await import(pathToFileURL(resolve(app, 'src/paragraph-pdf-figure-resources.mjs')).href);
  // Mission 2309.15217 p4: "95%" -> "950" reflows the paragraph, so line-end hyphens move.
  assert.deepEqual(lostWords('two annotators con-\nsidered anno-\ntators exter-\nnal in around 95% of cases',
    'two annotators considered annotators ex-\nternal in around 950 of cases', [{before: '95%', after: '950'}]), []);
  assert.deepEqual(lostWords('retrieval-\naugmented', 'retrieval-augmented', []), []);
  assert.deepEqual(lostWords('Sébastien Bubeck', 'Sebastien Bubeck', [{before: 'é', after: 'e'}]), []);
  assert.deepEqual(lostWords('paper’s idea and you’re here', "paper's idea and you1re here", [{before: 'you’', after: 'you1'}]), []);
  assert.deepEqual(lostWords('that ’provided con-\ntext’', 'that 1provided context’', [{before: '’', after: '1'}]), []);
  assert.deepEqual(lostWords('Can Xu said n X i', 'Can 2u said n X i', [{before: 'n X', after: 'n 2'}]), []);
  assert.deepEqual(lostWords('around 95% of cases', 'around of cases', [{before: '95%', after: ''}]), []);
  // A figure label that disappears is still reported.
  assert.deepEqual(lostWords('A B C AcuteUTI 73%', 'A Z C', [{before: 'B', after: 'Z'}]), ['AcuteUTI', '73%']);
  assert.deepEqual(lostWords('label con-\nsidered AcuteUTI', 'label considered', []), ['AcuteUTI']);
});
