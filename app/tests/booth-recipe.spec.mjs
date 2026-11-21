// FalsifyBoothRecipe core on the BoothEdit model: recipe validation (contract §1), per-page text
// index with page-fraction rects, light normalisation (NFKC, whitespace, hyphens, look-alikes),
// page-first matching with context tie-breaks, searchHits with rects, assist bookkeeping, and
// apply() writing directly to FalsifyBoothEdits.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const editsSource = await readFile(fileURLToPath(new URL('../dist/booth-edits.js', import.meta.url)), 'utf8');
const source = await readFile(fileURLToPath(new URL('../dist/booth-recipe.js', import.meta.url)), 'utf8');

function load(extra = {}) {
  const context = vm.createContext({console, URL, TextEncoder, setTimeout, clearTimeout, ...extra});
  vm.runInContext(editsSource, context, {filename: 'booth-edits.js'});
  vm.runInContext(source, context, {filename: 'booth-recipe.js'});
  return {context, recipe: context.FalsifyBoothRecipe, edits: context.FalsifyBoothEdits};
}

const plain = value => JSON.parse(JSON.stringify(value));

function good(overrides = {}) {
  return {
    schema: 'falsify.booth.recipe.v1', paperId: '2309.15217',
    edits: [{page: 5, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'}],
    defectType: 'number', reason: 'Ragas faithfulness lowered.\nSecond line.', source: 'agent',
    agent: {name: 'Claude Code', model: 'claude-opus-5-5'},
    ...overrides,
  };
}

function codes(result) {
  return plain(result.errors).map(error => error.field + ':' + error.code);
}

/* Synthetic pdf.js-like pages with item rects (top-left page fractions).
   Page 1 and page 3 both say "agrees best"; page 3 also hyphenates "evalu-\nation" across two lines. */
const PAGES = [
  {
    pageIndex: 0,
    items: [
      {str: 'Ragas agrees best with humans.', rect: {x: 0.1, y: 0.1, w: 0.5, h: 0.02}, hasEOL: true},
      {str: 'Intro text.', rect: {x: 0.1, y: 0.14, w: 0.2, h: 0.02}, hasEOL: true},
    ],
  },
  {
    pageIndex: 2,
    items: [
      {str: 'Faith.', rect: {x: 0.1, y: 0.1, w: 0.1, h: 0.02}},
      {str: 'Ans. Rel.', rect: {x: 0.25, y: 0.1, w: 0.15, h: 0.02}, hasEOL: true},
      {str: 'Ragas', rect: {x: 0.1, y: 0.15, w: 0.1, h: 0.02}},
      {str: '0.95', rect: {x: 0.25, y: 0.15, w: 0.08, h: 0.02}},
      {str: '0.78', rect: {x: 0.38, y: 0.15, w: 0.08, h: 0.02}},
      {str: '0.70', rect: {x: 0.50, y: 0.15, w: 0.08, h: 0.02}, hasEOL: true},
      {str: 'GPT Score', rect: {x: 0.1, y: 0.20, w: 0.12, h: 0.02}},
      {str: '0.72', rect: {x: 0.25, y: 0.20, w: 0.08, h: 0.02}, hasEOL: true},
      {str: 'automatic evalu-', rect: {x: 0.1, y: 0.30, w: 0.3, h: 0.02}, hasEOL: true},
      {str: 'ation agrees best here, and agrees best there.', rect: {x: 0.1, y: 0.34, w: 0.7, h: 0.02}, hasEOL: true},
    ],
  },
];

function stubPdfDoc(pages) {
  return {
    numPages: pages.length,
    async getPage(n) {
      const p = pages[n - 1];
      return {
        getViewport: () => p.viewport || {width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800]},
        getTextContent: async () => ({items: p.items}),
        cleanup() {},
      };
    },
  };
}

function stubWorkspace(pages = PAGES) {
  const full = [];
  const maxPage = Math.max(...pages.map(p => p.pageIndex), -1);
  for (let i = 0; i <= maxPage; i += 1) {
    full.push(pages.find(p => p.pageIndex === i) || {pageIndex: i, items: []});
  }
  const pdf = stubPdfDoc(full);
  return {
    getSource: () => ({file: {}, fileHash: 'a'.repeat(64)}),
    getPdfDoc: () => pdf,
    getPageCount: () => full.length,
    getPageIndex: () => 2,
    showPage: () => true,
  };
}

test('validate accepts the contract example and both arXiv id styles', () => {
  const {recipe} = load();
  assert.deepEqual(plain(recipe.validate(good())), {ok: true, errors: []});
  assert.equal(recipe.validate(good({paperId: 'hep-th/9901001v2'})).ok, true);
  assert.equal(recipe.validate(good({paperId: 'math.AG/0601001'})).ok, true);
  assert.equal(recipe.validate(good({schema: undefined, defectType: undefined, reason: undefined, agent: undefined})).ok, true);
  assert.equal(recipe.validate(good({edits: [{find: 'x', replace: ''}]})).ok, true, 'an empty replace deletes');
  assert.equal(recipe.validate(good({source: 'my-ai'})).ok, true);
});

test('validate rejects every rule break with a field and code', () => {
  const {recipe} = load();
  const cases = [
    [good({extra: 1}), 'extra:unknown'],
    [good({schema: 'v2'}), 'schema:schema'],
    [good({paperId: '2309.152'}), 'paperId:paper'],
    [good({source: 'robot'}), 'source:source'],
    [good({defectType: 'typo'}), 'defectType:defect_type'],
    [good({reason: 'x'.repeat(501)}), 'reason:too_long'],
    [good({edits: []}), 'edits:count'],
    [good({edits: Array.from({length: 6}, () => ({find: 'a', replace: 'b'}))}), 'edits:count'],
    [good({edits: [{find: '   ', replace: 'b'}]}), 'edits[0].find:empty'],
    [good({edits: [{find: 'x'.repeat(301), replace: 'b'}]}), 'edits[0].find:too_long'],
    [good({edits: [{find: 'a\nb', replace: 'b'}]}), 'edits[0].find:control'],
    [good({edits: [{find: 'same', replace: 'same'}]}), 'edits[0].replace:unchanged'],
    [good({edits: [{find: 'a', replace: 'x'.repeat(301)}]}), 'edits[0].replace:too_long'],
    [good({edits: [{find: 'a', replace: 'b', page: 0}]}), 'edits[0].page:page'],
    [good({edits: [{find: 'a', replace: 'b', page: 501}]}), 'edits[0].page:page'],
    [good({edits: [{find: 'a', replace: 'b', page: 2.5}]}), 'edits[0].page:page'],
    [good({edits: [{find: 'a', replace: 'b', context: 'x'.repeat(601)}]}), 'edits[0].context:too_long'],
    [good({agent: {name: 'A', model: 'm', extra: 'x'}}), 'agent.extra:unknown'],
    [good({agent: {name: 'x'.repeat(61)}}), 'agent.name:too_long'],
    [good({agent: {name: 'tab\there'}}), 'agent.name:control'],
  ];
  for (const [input, expected] of cases) {
    const result = recipe.validate(input);
    assert.equal(result.ok, false, expected);
    assert.ok(codes(result).includes(expected), expected + ' in ' + codes(result).join(','));
  }
  const big = good({edits: Array.from({length: 5}, () => ({find: '가', replace: '나', context: '가'.repeat(600)}))});
  assert.deepEqual(codes(recipe.validate(big)), [':too_large'], 'the JSON is at most 8 KB of UTF-8');
  assert.deepEqual(codes(recipe.validate(null)), [':type']);
  assert.deepEqual(codes(recipe.validate([])), [':type']);
});

test('lengths count code points and C1/bidi controls and unknown edit keys are rejected', () => {
  const {recipe} = load();
  const astral = '\u{1D400}';
  assert.equal(recipe.validate(good({edits: [{find: astral.repeat(300), replace: '\u{1D401}'.repeat(300)}]})).ok, true, '300 astral code points fit');
  assert.ok(codes(recipe.validate(good({edits: [{find: astral.repeat(301), replace: 'x'}]}))).includes('edits[0].find:too_long'));
  assert.equal(recipe.validate(good({reason: astral.repeat(500), agent: {name: astral.repeat(60), model: 'm'}})).ok, true);
  assert.ok(codes(recipe.validate(good({edits: [{find: 'a', replace: 'b', context: astral.repeat(601)}]}))).includes('edits[0].context:too_long'));
  const bad = ['\u0085', '\u009f', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069'];
  for (const ch of bad) {
    const label = 'U+' + ch.codePointAt(0).toString(16);
    assert.ok(codes(recipe.validate(good({agent: {name: 'Claude' + ch, model: 'm'}}))).includes('agent.name:control'), label);
    assert.ok(codes(recipe.validate(good({edits: [{find: 'a' + ch, replace: 'b'}]}))).includes('edits[0].find:control'), label);
    assert.ok(codes(recipe.validate(good({reason: 'line\nmore' + ch}))).includes('reason:control'), label);
    assert.ok(codes(recipe.validate(good({edits: [{find: 'a', replace: 'b', context: 'x\n' + ch}]}))).includes('edits[0].context:control'), label);
  }
  assert.equal(recipe.validate(good({reason: 'a\nb', edits: [{find: 'a', replace: 'b', context: 'c\nd'}]})).ok, true, 'newline stays allowed in reason/context');
  assert.equal(recipe.validate(good({edits: [{find: 'a', replace: 'b\u200b'}]})).ok, true, 'zero-width space is not a control');
  assert.deepEqual(codes(recipe.validate(good({edits: [{find: 'a', replace: 'b', hint: {segmentId: 's0', at: 0}, note: 'x'}]}))), ['edits[0].hint:unknown', 'edits[0].note:unknown']);
});

test('the mission check is an exact id match, so a prefix id still gets search metadata', async () => {
  const label = {textContent: 'arXiv 2309.15217 · CC BY 4.0'};
  const missions = {querySelectorAll: selector => (selector === '.booth-mission .booth-lab' ? [label] : []), textContent: label.textContent};
  const document = {getElementById: id => (id === 'booth-missions' ? missions : null)};
  const searches = [];
  const fetch = async url => { searches.push(url); return {ok: true, status: 200, json: async () => ({results: [{id: '2309.1521', title: 'Other', license: 'cc-by-4.0'}]})}; };
  for (const [paperId, expected] of [['2309.15217', 0], ['2309.1521', 1]]) {
    searches.length = 0;
    const metas = [];
    const ws = stubWorkspace(PAGES);
    let opened = false;
    const getPdfDoc = ws.getPdfDoc;
    ws.getPdfDoc = () => (opened ? getPdfDoc() : null);
    const {recipe} = load({
      document, fetch, FalsifyPaperWorkspace: ws,
      FalsifyCloudConfig: {apiBase: 'https://api.example'},
      FalsifyHostedSession: {token: async () => 'fsg_' + 'c'.repeat(43)},
      FalsifyBoothPaper: {open: (id, meta) => { metas.push(plain(meta)); opened = true; return Promise.resolve(true); }, current: () => null},
    });
    await recipe.apply(good({paperId, edits: [{page: 3, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'}]}));
    assert.equal(searches.length, expected, paperId);
    assert.deepEqual(metas[0], expected ? {title: 'Other', license: 'cc-by-4.0'} : {}, paperId);
  }
});

test('cropBox widens narrow boxes, shifts inside edges, caps height at 1/3 keeping top, and pads wide boxes', () => {
  const {recipe} = load();
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
  assert.equal(recipe.cropBox([]), null);
  assert.equal(recipe.cropBox(null), null);

  // 1. Narrow box widened to 0.40 and centred.
  const narrow = plain(recipe.cropBox([{x: 0.45, y: 0.30, w: 0.10, h: 0.02}]));
  near(narrow.x, 0.30, 'narrow.x');
  near(narrow.w, 0.40, 'narrow.w');
  near(narrow.y, 0.27, 'narrow.y');
  near(narrow.h, 0.10, 'narrow.h');

  // 2. Box near the right edge shifted inside [0, 1].
  const rightEdge = plain(recipe.cropBox([{x: 0.90, y: 0.20, w: 0.06, h: 0.02}]));
  near(rightEdge.x, 0.60, 'rightEdge.x');
  near(rightEdge.w, 0.40, 'rightEdge.w');
  near(rightEdge.x + rightEdge.w, 1.0, 'rightEdge right bound');

  // Left edge shifted inside [0, 1].
  const leftEdge = plain(recipe.cropBox([{x: 0.02, y: 0.01, w: 0.05, h: 0.02}]));
  near(leftEdge.x, 0.0, 'leftEdge.x');
  near(leftEdge.w, 0.40, 'leftEdge.w');
  near(leftEdge.y, 0.0, 'leftEdge.y');
  near(leftEdge.h, 0.10, 'leftEdge.h');

  // 3. Moderately tall box (padded > 1/3, union + 0.02 <= 1/3) trims padding to 0.01 and caps height at 1/3.
  const trimmed = plain(recipe.cropBox([
    {x: 0.10, y: 0.20, w: 0.50, h: 0.02},
    {x: 0.10, y: 0.46, w: 0.50, h: 0.02},
  ]));
  near(trimmed.y, 0.19, 'trimmed.y keeps union.top - 0.01');
  near(trimmed.h, 1 / 3, 'trimmed.h capped at 1/3 without cutting union');
  assert.ok(trimmed.y <= 0.20 && trimmed.y + trimmed.h >= 0.48, 'trimmed crop contains whole union');

  // 4. Reviewer rot90 shape (narrow box with h = 0.482 > 1/3): crop never cuts the union.
  const rot90 = plain(recipe.cropBox([{x: 0.20, y: 0.15, w: 0.02, h: 0.482}]));
  near(rot90.x, 0.01, 'rot90.x widened and centred');
  near(rot90.w, 0.40, 'rot90.w');
  near(rot90.y, 0.14, 'rot90.y = union.top - 0.01');
  near(rot90.h, 0.502, 'rot90.h = union.h + 0.02');
  assert.ok(rot90.y <= 0.15 && rot90.y + rot90.h >= 0.15 + 0.482, 'rot90 crop contains whole union');

  // 5. Wide box padded by 0.02 on each side.
  const wide = plain(recipe.cropBox([{x: 0.10, y: 0.40, w: 0.50, h: 0.04}]));
  near(wide.x, 0.08, 'wide.x');
  near(wide.w, 0.54, 'wide.w');
  near(wide.y, 0.37, 'wide.y');
  near(wide.h, 0.12, 'wide.h');

  // Full-width box clamps to [0, 1].
  const full = plain(recipe.cropBox([{x: 0.01, y: 0.94, w: 0.98, h: 0.04}]));
  near(full.x, 0.0, 'full.x');
  near(full.w, 1.0, 'full.w');
  near(full.y + full.h, 1.0, 'full bottom shifted inside');
  near(full.h, 0.12, 'full.h');
});

test('normalise folds NFKC, whitespace and line-end hyphenation and keeps original offsets', () => {
  const {recipe} = load();
  const text = '  automatic evalu-\n  ation\t\tagrees  ';
  const joined = recipe.normalizeText(text, false);
  assert.equal(joined.text, 'automatic evaluation agrees');
  const at = joined.text.indexOf('evaluation');
  const start = joined.start[at];
  const end = joined.end[at + 'evaluation'.length - 1];
  assert.equal(text.slice(start, end), 'evalu-\n  ation');
  assert.equal(recipe.normalizeText(text, true).text, 'automatic evalu-ation agrees');
  assert.equal(recipe.normalizeText('self-contained', false).text, 'self-contained', 'a mid-line hyphen stays');
  assert.equal(recipe.normalizeText('ﬁne', false).text, 'fine', 'NFKC folds ligatures');
});

test('indexPage converts pdf.js getTextContent transforms into top-left page-fraction rects', () => {
  const {recipe} = load();
  const viewport = {width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800]};
  const page = plain(recipe.indexPage({
    pageIndex: 4,
    viewport,
    items: [
      {str: 'Ragas', transform: [10, 0, 0, 10, 60, 700], width: 30, height: 10, hasEOL: false},
      {str: '0.95', transform: [10, 0, 0, 10, 120, 700], width: 24, height: 10, hasEOL: true},
    ],
  }));
  assert.equal(page.pageIndex, 4);
  assert.equal(page.text, 'Ragas 0.95\n');
  assert.equal(page.spans.length, 2);
  // 0.95 sits at x = 120/600 = 0.20, w = 24/600 = 0.04, baseline y = (800 - 700)/800 = 0.125
  const r = page.spans[1].rect;
  assert.ok(Math.abs(r.x - 0.20) < 0.001, JSON.stringify(r));
  assert.ok(Math.abs(r.w - 0.04) < 0.001, JSON.stringify(r));
  assert.ok(r.y < 0.125 && r.y + r.h > 0.125, 'rect spans the baseline: ' + JSON.stringify(r));
});

test('locate resolves exact rects per hit (including multi-line hyphen wraps)', () => {
  const {recipe} = load();
  const num = plain(recipe.locate({page: 3, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'}, PAGES));
  assert.equal(num.status, 'resolved');
  assert.equal(num.pageIndex, 2);
  assert.equal(num.originalText, '0.95');
  assert.deepEqual(num.rects, [{x: 0.25, y: 0.15, w: 0.08, h: 0.02}]);

  const hyphen = plain(recipe.locate({find: 'evaluation agrees', replace: 'x'}, PAGES));
  assert.equal(hyphen.status, 'resolved');
  assert.equal(hyphen.originalText, 'evalu-\nation agrees');
  assert.equal(hyphen.rects.length, 2, 'a two-line hit produces one rect per line');
  assert.ok(hyphen.rects[0].y < hyphen.rects[1].y);

  const kept = plain(recipe.locate({find: 'evalu-ation', replace: 'x'}, PAGES));
  assert.equal(kept.status, 'resolved');
  assert.equal(kept.originalText, 'evalu-\nation');

  const spaced = plain(recipe.locate({page: 3, find: 'GPT  Score 0.72', replace: 'x'}, PAGES));
  assert.equal(spaced.status, 'resolved');
  assert.equal(spaced.originalText, 'GPT Score 0.72');
  assert.equal(spaced.rects.length, 1, 'same-line items merge into one rect');
});

test('locate: page scope beats the whole paper; context breaks ties; otherwise ambiguous', () => {
  const {recipe} = load();
  const first = plain(recipe.locate({page: 1, find: 'agrees best', replace: 'x'}, PAGES));
  assert.equal(first.status, 'resolved');
  assert.equal(first.pageIndex, 0);
  assert.equal(plain(recipe.locate({find: 'agrees best', replace: 'x'}, PAGES)).status, 'ambiguous');
  assert.equal(plain(recipe.locate({page: 3, find: 'agrees best', replace: 'x'}, PAGES)).status, 'ambiguous');
  const there = plain(recipe.locate({page: 3, find: 'agrees best', replace: 'x', context: 'and agrees best there'}, PAGES));
  assert.equal(there.status, 'resolved');
  const here = plain(recipe.locate({find: 'agrees best', replace: 'x', context: 'evaluation agrees best here'}, PAGES));
  assert.equal(here.status, 'resolved');
  assert.equal(here.pageIndex, 2);
  assert.ok(here.rects[0].x < there.rects[0].x, 'each occurrence has its own distinct horizontal rect');
  const missing = plain(recipe.locate({page: 2, find: 'agrees best', replace: 'x'}, PAGES));
  assert.equal(missing.status, 'ambiguous', 'nothing on page 2, so the whole paper decides');
});

test('locate: look-alike quotes, dashes, minus, NBSP, zero-width marks, case and spacing still find the text', () => {
  const {recipe} = load();
  const pages = [{
    pageIndex: 0,
    items: [{str: 'The \u201cbest\u201d score fell by \u22120.4 in 2019\u20132020 for\u00a0GPT\u200b-4 (Table 2).', rect: {x: 0.1, y: 0.2, w: 0.8, h: 0.02}}],
  }];
  const cases = [
    ['"best"', '\u201cbest\u201d'],
    ['-0.4', '\u22120.4'],
    ['2019-2020', '2019\u20132020'],
    ['for GPT-4', 'for\u00a0GPT\u200b-4'],
    ['THE "BEST" SCORE', 'The \u201cbest\u201d score'],
    ['Table2', 'Table 2'],
  ];
  for (const [find, before] of cases) {
    const found = plain(recipe.locate({find, replace: 'x'}, pages));
    assert.equal(found.status, 'resolved', find);
    assert.equal(found.originalText, before, find);
    assert.equal(found.rects.length, 1, find);
  }
  assert.equal(recipe.locate({find: 'ab', replace: 'x'}, [{pageIndex: 0, text: 'a b c'}]).status, 'not_found', 'short text never matches with spaces ignored');
  const exact = plain(recipe.locate({find: 'Fell', replace: 'x'}, [{pageIndex: 0, text: 'Fell and fell'}]));
  assert.equal(exact.start, 0, 'an exact-case hit wins before the case-folded tier is tried');
});

test('locate: not_found for text nowhere in the paper', () => {
  const {recipe} = load();
  assert.equal(recipe.locate({find: 'never written', replace: 'x'}, PAGES).status, 'not_found');
  assert.equal(recipe.locate({page: 3, find: 'never written', replace: 'x'}, PAGES).status, 'not_found');
  assert.equal(recipe.locate({find: 'agrees', replace: 'x'}, []).status, 'not_found');
});

test('searchHits lists the current page first, caps the list, and attaches rects to every hit', () => {
  const {recipe} = load();
  const list = plain(recipe.searchHits(PAGES, 'agrees best', 2, 2));
  assert.equal(list.total, 3);
  assert.equal(list.more, 1);
  assert.deepEqual(list.items.map(item => item.pageIndex), [2, 2]);
  assert.equal(list.items[0].snippet.hit, 'agrees best');
  assert.equal(list.items[0].originalText, 'agrees best');
  assert.equal(list.items[0].rects.length, 1);
  assert.ok(list.items[0].rects[0].x < list.items[1].rects[0].x);
});

test('assist defaults to manual; setAssist accepts my-ai and treats other kinds as manual', () => {
  const {recipe} = load();
  assert.deepEqual(plain(recipe.assist()), {assist: 'manual'});
  recipe.setAssist('my-ai');
  assert.deepEqual(plain(recipe.assist()), {assist: 'my-ai'});
  recipe.setAssist('agent');
  assert.deepEqual(plain(recipe.assist()), {assist: 'manual'});
  recipe.setAssist('robot');
  assert.deepEqual(plain(recipe.assist()), {assist: 'manual'});
});

test('apply opens the paper, indexes pdf.js pages, and adds BoothEdits directly', async () => {
  const ws = stubWorkspace(PAGES);
  const opened = [];
  const hook = {open: id => { opened.push(id); return Promise.resolve(true); }, current: () => ({id: '2309.15217', title: 'Ragas', license: 'cc-by-4.0'})};
  const {recipe, edits} = load({FalsifyPaperWorkspace: ws, FalsifyBoothPaper: hook});
  const progress = [];
  const result = await recipe.apply(good({
    source: 'my-ai',
    edits: [
      {page: 3, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'},
      {find: 'agrees best', replace: 'agrees least'},
      {find: 'not in this paper', replace: 'x'},
    ],
  }), {onProgress: info => progress.push(info.phase)});
  assert.deepEqual(opened, ['2309.15217']);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(plain(result.unresolved.map(item => item.reason)), ['ambiguous', 'not_found']);
  assert.equal(result.unresolved[0].edit.find, 'agrees best');
  const stored = plain(edits.list());
  assert.equal(stored.length, 1);
  assert.equal(stored[0].pageIndex, 2);
  assert.equal(stored[0].originalText, '0.95');
  assert.equal(stored[0].newText, '0.50');
  assert.equal(stored[0].source, 'myai');
  assert.deepEqual(stored[0].rects, [{x: 0.25, y: 0.15, w: 0.08, h: 0.02}]);
  assert.deepEqual(progress, ['paper', 'edit', 'edit', 'edit', 'done']);
  assert.deepEqual(plain(recipe.assist()), {assist: 'my-ai'});
  edits.remove(stored[0].id);
  assert.deepEqual(plain(recipe.assist()), {assist: 'manual'}, 'removing the recipe edit resets assist to manual');
  assert.deepEqual(plain(recipe.paperInfo()), {paperId: '2309.15217', title: 'Ragas', license: 'cc-by-4.0', pages: 3});
  assert.match(recipe.pageText(3), /^Faith\. Ans\. Rel\./);
  assert.equal(recipe.pageText(2), '');
  assert.equal(recipe.currentPage(), 3);
});

test('over-engineered and agent-code helpers are deleted', async () => {
  const {recipe} = load();
  for (const removed of ['sameSpot', 'uniqueSpan', 'mergedProposal', 'changesOf', 'applyFound', 'fromCode', 'codeFromText', 'normalizeCode', 'expiryText']) {
    assert.equal(removed in recipe, false, removed + ' is deleted');
  }
  assert.equal(source.includes('acceptProposals'), false, 'no workspace acceptProposals use');
  assert.equal(source.includes('sameSpot'), false);
  assert.equal(source.includes('uniqueSpan'), false);
  assert.equal(source.includes('mergedProposal'), false);
  assert.equal(source.includes('changesOf'), false);
  assert.equal(source.includes('compareToggle'), false);
});

test('no visitor message on the edit step sends the visitor to another feature', async () => {
  const files = ['booth.js', 'booth-recipe.js', 'booth-myai.js'];
  const referral = [
    /문단 전체 고치기」(?:로|으로|를)/,
    /["「]직접 고치기["」](?:에서|로)/,
    /목록에서 (?:먼저 )?지워/,
    /고친 곳[^']*페이지를 새로 고친/,
    /다른 기능/,
  ];
  for (const name of files) {
    const text = await readFile(fileURLToPath(new URL('../dist/' + name, import.meta.url)), 'utf8');
    const messages = [...text.matchAll(/'(?:[^'\\\n]|\\.)*'/g)].map(match => match[0]).filter(literal => /[가-힣]/.test(literal));
    assert.ok(messages.length > 10, name + ' has visitor strings');
    for (const message of messages) {
      for (const pattern of referral) assert.doesNotMatch(message, pattern, name + ': ' + message);
    }
  }
});

test('apply: no booth hook means every edit is no_paper; invalid recipes throw', async () => {
  const {recipe} = load({FalsifyPaperWorkspace: stubWorkspace(PAGES)});
  const result = await recipe.apply(good());
  assert.deepEqual(plain(result.unresolved.map(item => item.reason)), ['no_paper']);
  await assert.rejects(recipe.apply(good({source: 'robot'})), error => error.code === 'invalid_recipe' && error.errors.length === 1);
});

test('rotated items return the whole item box in rectsForSpan instead of slicing along x (P1-4)', () => {
  const {recipe} = load();
  const cases = [
    ['Rotate 90', {width: 800, height: 600, transform: [0, 1, 1, 0, 0, 0]}, {str: 'Hello World 0.95 End', transform: [10, 0, 0, 10, 100, 300], width: 120, height: 10}],
    ['Rotate 180', {width: 600, height: 800, transform: [-1, 0, 0, 1, 600, 0]}, {str: 'Hello World 0.95 End', transform: [10, 0, 0, 10, 100, 300], width: 120, height: 10}],
    ['Rotate 270', {width: 800, height: 600, transform: [0, -1, -1, 0, 800, 600]}, {str: 'Hello World 0.95 End', transform: [10, 0, 0, 10, 100, 300], width: 120, height: 10}],
    ['Rotated item on Rotate 0', {width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800]}, {str: 'Hello World 0.95 End', transform: [0, 10, -10, 0, 100, 300], width: 120, height: 10}],
  ];
  for (const [label, viewport, item] of cases) {
    const page = plain(recipe.indexPage({pageIndex: 0, viewport, items: [item]}));
    assert.equal(page.spans.length, 1, label);
    assert.equal(page.spans[0].rotated, true, label + ' marked rotated');
    const found = plain(recipe.locate({find: '0.95', replace: '0.50'}, [page]));
    assert.equal(found.status, 'resolved', label);
    assert.deepEqual(found.rects, [page.spans[0].rect], label + ' returns whole item box');
  }
  const normal = plain(recipe.indexPage({
    pageIndex: 0,
    viewport: {width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800]},
    items: [{str: 'Hello World 0.95 End', transform: [10, 0, 0, 10, 100, 300], width: 120, height: 10}],
  }));
  assert.equal(normal.spans[0].rotated, undefined, 'horizontal item is not rotated');
  const sliced = plain(recipe.locate({find: '0.95', replace: '0.50'}, [normal]));
  assert.ok(sliced.rects[0].w < normal.spans[0].rect.w * 0.5, 'horizontal item still slices along x');
});

test('case-folded no-op where replace equals originalText is unresolved as unchanged (P2-2)', async () => {
  const ws = stubWorkspace(PAGES);
  const hook = {open: () => Promise.resolve(true), current: () => ({id: '2309.15217', title: 'Ragas', license: 'cc-by-4.0'})};
  const {recipe, edits} = load({FalsifyPaperWorkspace: ws, FalsifyBoothPaper: hook});
  const result = await recipe.apply(good({
    edits: [{page: 3, find: 'ragas', replace: 'Ragas'}],
  }));
  assert.equal(result.applied.length, 0);
  assert.deepEqual(plain(result.unresolved.map(item => item.reason)), ['unchanged']);
  assert.equal(edits.list().length, 0);
});
