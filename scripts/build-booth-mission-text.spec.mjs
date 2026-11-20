import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {
  DEFAULT_LIST, DEFAULT_OUT, SCHEMA, buildBundle, parseArgs, pageTextFromItems, readPaperList, serialize,
} from './build-booth-mission-text.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/build-booth-mission-text.mjs');
const fixture = join(root, 'app/tests/fixtures/paragraph-audit-synthetic.pdf');
const item = (str, x, y, size = 10, width = str.length * 5) => ({str, transform: [size, 0, 0, size, x, y], width, height: size});

let listCount = 0;
function tempList(dir, entries) {
  const path = join(dir, `papers-${++listCount}.json`);
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

test('text items join into lines and paragraphs; hyphenation is kept', () => {
  const text = pageTextFromItems([
    item('Ragas', 50, 700), item('0.95', 90, 700), item(' ', 110, 700), item('0.78', 115, 700),
    item('agrees with hu-', 50, 688), item('mans.', 50, 676),
    item('5 Experiments', 50, 640),
    {str: '', transform: [10, 0, 0, 10, 0, 0], width: 0},
  ]);
  assert.equal(text, 'Ragas 0.95 0.78\nagrees with hu-\nmans.\n\n5 Experiments');
});

test('arguments', () => {
  const opts = parseArgs(['pdfs', '--check']);
  assert.equal(opts.check, true);
  assert.equal(opts.list, DEFAULT_LIST);
  assert.equal(opts.out, DEFAULT_OUT);
  assert.throws(() => parseArgs([]), /Usage/);
  assert.throws(() => parseArgs(['a', '--nope']), /Unknown argument/);
});

test('the paper list is strict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'falsify-mission-list-'));
  try {
    const good = {paperId: '2401.00001', title: 'T', license: 'cc-by-4.0', url: 'https://arxiv.org/abs/2401.00001', licenseSource: 'asserted'};
    assert.equal(readPaperList(tempList(dir, [good])).get('2401.00001').title, 'T');
    assert.throws(() => readPaperList(tempList(dir, [{...good, paperId: '../x'}])), /Bad paperId/);
    assert.throws(() => readPaperList(tempList(dir, [{...good, title: ''}])), /missing title/);
    assert.throws(() => readPaperList(tempList(dir, [{...good, licenseSource: 'guess'}])), /licenseSource/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a synthetic PDF builds into the schema; --check passes then catches drift', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'falsify-mission-text-'));
  try {
    const pdfs = join(dir, 'pdfs');
    mkdirSync(pdfs);
    copyFileSync(fixture, join(pdfs, '2401.00001.pdf'));
    const entry = {paperId: '2401.00001', title: 'Synthetic', license: 'cc-by-4.0', url: 'https://arxiv.org/abs/2401.00001', licenseSource: 'asserted'};
    const list = tempList(dir, [entry]);
    const bundle = await buildBundle(pdfs, readPaperList(list));
    assert.equal(bundle.schema, SCHEMA);
    const paper = bundle.papers['2401.00001'];
    assert.deepEqual(Object.keys(paper), ['paperId', 'title', 'license', 'url', 'pages']);
    assert.equal(paper.title, 'Synthetic');
    assert.deepEqual(paper.pages.map(p => p.page), [1, 2]);
    assert.ok(paper.pages.every(p => typeof p.text === 'string' && p.text.length > 20));
    await assert.rejects(buildBundle(pdfs, readPaperList(tempList(dir, [{...entry, licenseSource: 'pdf-xmp'}]))), /no CC BY 4\.0/);
    await assert.rejects(buildBundle(pdfs, new Map()), /not in the paper list/);

    const out = join(dir, 'out.json');
    const run = (...args) => spawnSync(process.execPath, [script, pdfs, '--list', list, '--out', out, ...args], {encoding: 'utf8'});
    const missing = run('--check');
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(out, 'utf8'), serialize(bundle));
    assert.equal(run('--check').status, 0);
    writeFileSync(out, readFileSync(out, 'utf8').replace('Synthetic', 'Changed'));
    assert.equal(run('--check').status, 1);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the committed bundle matches the paper list and the schema S3 serves', () => {
  const bundle = JSON.parse(readFileSync(DEFAULT_OUT, 'utf8'));
  const list = readPaperList(DEFAULT_LIST);
  assert.deepEqual(Object.keys(bundle), ['schema', 'papers']);
  assert.equal(bundle.schema, SCHEMA);
  assert.deepEqual(Object.keys(bundle.papers).sort(), [...list.keys()].sort());
  for (const [id, paper] of Object.entries(bundle.papers)) {
    const entry = list.get(id);
    assert.deepEqual(Object.keys(paper), ['paperId', 'title', 'license', 'url', 'pages']);
    assert.equal(paper.paperId, id);
    assert.equal(paper.title, entry.title);
    assert.equal(paper.license, 'cc-by-4.0');
    assert.equal(paper.url, `https://arxiv.org/abs/${id}`);
    assert.deepEqual(paper.pages.map(p => p.page), paper.pages.map((_, i) => i + 1));
    assert.ok(paper.pages.every(p => Object.keys(p).join() === 'page,text' && typeof p.text === 'string'));
  }
  assert.match(bundle.papers['2309.15217'].pages[4].text, /Ragas 0\.95 0\.78 0\.70/);
  assert.ok(Buffer.byteLength(readFileSync(DEFAULT_OUT)) < 1_500_000, 'bundle stays small enough for the Worker');
});

// The mission PDFs are never committed. Set FALSIFY_MISSION_PDF_DIR to check the bundle against them.
test('the committed bundle is up to date with the mission PDFs', {skip: !process.env.FALSIFY_MISSION_PDF_DIR}, () => {
  const run = spawnSync(process.execPath, [script, process.env.FALSIFY_MISSION_PDF_DIR, '--check'], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
});
