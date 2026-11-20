// FalsifyBoothPageEdit pure helpers: line grouping, block clustering, existing-edit substitution,
// line trimming, token picking, popover placement, numeric tokens, hint zoom and keyboard inset.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const source = await readFile(fileURLToPath(new URL('../dist/booth-pageedit.js', import.meta.url)), 'utf8');
const context = vm.createContext({console, setTimeout, clearTimeout});
vm.runInContext(source, context, {filename: 'booth-pageedit.js'});
const pe = context.FalsifyBoothPageEdit;
const plain = value => JSON.parse(JSON.stringify(value));
const R = (x, y, w, h) => ({x, y, w, h});

test('groupLines groups spans on the same row and splits across two-column gutters', () => {
  const items = [
    {text: 'Table 1:', rect: R(0.118, 0.177, 0.060, 0.011)},
    {text: 'Agreement with human', rect: R(0.184, 0.177, 0.200, 0.011)},
    {text: 'annotators', rect: R(0.390, 0.178, 0.094, 0.011)},
    // Same baseline, right column after 0.030 gutter: must stay a separate line segment.
    {text: 'context. In this case', rect: R(0.514, 0.177, 0.366, 0.011)},
    // Tight split inside one word (e.g. ligature or superscript): joined with no extra space.
    {text: 'x', rect: R(0.118, 0.193, 0.010, 0.011)},
    {text: '2', rect: R(0.1285, 0.192, 0.008, 0.010)},
    {text: 'value', rect: R(0.142, 0.193, 0.050, 0.011)},
  ];
  const lines = plain(pe.groupLines(items));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].text, 'Table 1: Agreement with human annotators');
  assert.ok(lines[0].rect.x + lines[0].rect.w < 0.5, 'left column line stays left of gutter');
  assert.equal(lines[1].text, 'context. In this case');
  assert.ok(lines[1].rect.x > 0.5, 'right column line stays right of gutter');
  assert.equal(lines[2].text, 'x2 value', 'adjacent spans with tiny gap join without space');
});

test('clusterBlock clusters a multi-line caption without pulling in the table, body, or right column', () => {
  // Real-like page 5 geometry from arXiv 2309.15217.
  const items = [
    // Table 1 bottom row (gap 0.020 above caption)
    {text: 'GPT Ranking', rect: R(0.128, 0.146, 0.101, 0.011)},
    {text: '0.54', rect: R(0.254, 0.146, 0.032, 0.011)},
    {text: '0.40', rect: R(0.328, 0.146, 0.032, 0.011)},
    {text: '0.52', rect: R(0.420, 0.146, 0.032, 0.011)},
    // Table 1 caption (3 lines, indices 4, 5, 6)
    {text: 'Table 1: Agreement with human annotators in pairwise', rect: R(0.118, 0.177, 0.366, 0.010)},
    {text: 'comparisons of faithfulness, answer relevance and con-', rect: R(0.118, 0.191, 0.368, 0.010)},
    {text: 'text relevance, using the WikEval dataset (accuracy).', rect: R(0.118, 0.205, 0.370, 0.010)},
    // Body paragraph below (gap 0.043)
    {text: 'answering the question. For the few pages with-', rect: R(0.118, 0.258, 0.370, 0.011)},
    // Right column at the exact same y as the caption
    {text: 'Answer Relevancy measures the degree', rect: R(0.549, 0.177, 0.294, 0.011)},
    {text: 'to which a response directly addresses', rect: R(0.549, 0.191, 0.292, 0.011)},
    {text: 'and is appropriate for a given question.', rect: R(0.549, 0.205, 0.296, 0.011)},
  ];
  // Tap on middle caption line (index 5)
  const cap = plain(pe.clusterBlock(items, 5));
  assert.deepEqual(cap.map(l => l.text), [
    'Table 1: Agreement with human annotators in pairwise',
    'comparisons of faithfulness, answer relevance and con-',
    'text relevance, using the WikEval dataset (accuracy).',
  ]);
  // Tap on last line of right-column block (index 10)
  const right = plain(pe.clusterBlock(items, 10));
  assert.deepEqual(right.map(l => l.text), [
    'Answer Relevancy measures the degree',
    'to which a response directly addresses',
    'and is appropriate for a given question.',
  ]);
  // Tap by fraction rect also works
  const byRect = plain(pe.clusterBlock(items, R(0.12, 0.178, 0.05, 0.01)));
  assert.equal(byRect.length, 3);
  assert.equal(byRect[0].text, items[4].text);
});

test('clusterBlock keeps indented first line and short last line, and separates headings', () => {
  const items = [
    {text: '5 Experiments', rect: R(0.118, 0.317, 0.139, 0.012)},
    {text: 'The results in Table 1 show that our proposed', rect: R(0.133, 0.342, 0.355, 0.011)},
    {text: 'metrics are much closer aligned with human', rect: R(0.118, 0.358, 0.370, 0.011)},
    {text: 'judgements.', rect: R(0.118, 0.374, 0.090, 0.011)},
  ];
  // Starting from the short last line expands up through the indented first line, stops before heading
  const para = plain(pe.clusterBlock(items, 3));
  assert.deepEqual(para.map(l => l.text), [
    'The results in Table 1 show that our proposed',
    'metrics are much closer aligned with human',
    'judgements.',
  ]);
  const heading = plain(pe.clusterBlock(items, 0));
  assert.deepEqual(heading.map(l => l.text), ['5 Experiments']);
});

test('applyEditsToBlock substitutes existing tap, repeated-word, deletion and multi-line edits', () => {
  const block = [
    {text: 'Table 1: the agreement and the score', rect: R(0.118, 0.177, 0.366, 0.010)},
    {text: 'comparisons of faithfulness and relevance', rect: R(0.118, 0.191, 0.368, 0.010)},
    {text: 'using the WikEval dataset (accuracy).', rect: R(0.118, 0.205, 0.370, 0.010)},
  ];
  // Second "the" on line 0 (around 75% across line 0) -> "a", plus "WikEval" -> "MyBench" on line 2
  const edits = [
    {id: 'e-1', pageIndex: 4, rects: [R(0.39, 0.177, 0.03, 0.010)], originalText: 'the', newText: 'a'},
    {id: 'e-2', pageIndex: 4, rects: [R(0.22, 0.205, 0.07, 0.010)], originalText: 'WikEval', newText: 'MyBench'},
    // Unrelated edit elsewhere on the page must be ignored
    {id: 'e-3', pageIndex: 4, rects: [R(0.60, 0.50, 0.05, 0.010)], originalText: 'other', newText: 'nope'},
  ];
  assert.equal(
    pe.applyEditsToBlock(block, edits),
    'Table 1: the agreement and a score\ncomparisons of faithfulness and relevance\nusing the MyBench dataset (accuracy).'
  );

  // Two inline edits on the same line
  const twoOnLine = [
    {id: 'e-4', pageIndex: 4, rects: [R(0.118, 0.177, 0.05, 0.010)], originalText: 'Table', newText: 'Fig.'},
    {id: 'e-5', pageIndex: 4, rects: [R(0.43, 0.177, 0.05, 0.010)], originalText: 'score', newText: 'rank'},
  ];
  assert.equal(
    pe.applyEditsToBlock(block, twoOnLine).split('\n')[0],
    'Fig. 1: the agreement and the rank'
  );

  // Earlier full-block deletion edit gives empty string
  const deleted = [{
    id: 'e-6', pageIndex: 4,
    rects: block.map(l => l.rect),
    originalText: block.map(l => l.text).join('\n'),
    newText: '',
  }];
  assert.equal(pe.applyEditsToBlock(block, deleted), '');

  // Earlier multi-line replacement edit covering lines 0..1
  const multi = [{
    id: 'e-7', pageIndex: 4,
    rects: [block[0].rect, block[1].rect],
    originalText: block[0].text + '\n' + block[1].text,
    newText: 'Short header',
  }];
  assert.equal(pe.applyEditsToBlock(block, multi), 'Short header\nusing the WikEval dataset (accuracy).');

  // A tap rect whose vertical padding slightly grazes the previous line stays on its own line
  const grazing = [{
    id: 'e-8', pageIndex: 4,
    rects: [R(0.22, 0.200, 0.07, 0.015)], // overlaps line 1 bottom (0.201) by 0.001, line 2 fully
    originalText: 'WikEval',
    newText: 'Bench',
  }];
  assert.equal(
    pe.applyEditsToBlock(block, grazing),
    'Table 1: the agreement and the score\ncomparisons of faithfulness and relevance\nusing the Bench dataset (accuracy).'
  );
});

test('trimBlockLines trims unchanged leading and trailing lines and handles deletion, insertion and no-op', () => {
  const block = [
    {text: 'Line 1', rect: R(0.1, 0.10, 0.4, 0.012)},
    {text: 'Line 2', rect: R(0.1, 0.12, 0.4, 0.012)},
    {text: 'Line 3', rect: R(0.1, 0.14, 0.4, 0.012)},
    {text: 'Line 4', rect: R(0.1, 0.16, 0.4, 0.012)},
  ];
  // Unchanged returns null
  assert.equal(pe.trimBlockLines(block, 'Line 1\nLine 2\nLine 3\nLine 4'), null);
  assert.equal(pe.trimBlockLines(block, 'Line 1\r\nLine 2\r\nLine 3\r\nLine 4'), null);

  // Single middle line edited: only its rect is kept
  const mid = plain(pe.trimBlockLines(block, 'Line 1\nLine 2 edited\nLine 3\nLine 4'));
  assert.deepEqual(mid, {rects: [block[1].rect], originalText: 'Line 2', newText: 'Line 2 edited'});

  // Middle two lines edited
  const span = plain(pe.trimBlockLines(block, 'Line 1\nTwo\nThree\nLine 4'));
  assert.deepEqual(span, {rects: [block[1].rect, block[2].rect], originalText: 'Line 2\nLine 3', newText: 'Two\nThree'});

  // Deleting one middle line produces newText '' over that line's rect only
  const delOne = plain(pe.trimBlockLines(block, 'Line 1\nLine 3\nLine 4'));
  assert.deepEqual(delOne, {rects: [block[1].rect], originalText: 'Line 2', newText: ''});

  // Deleting first line
  const delFirst = plain(pe.trimBlockLines(block, 'Line 2\nLine 3\nLine 4'));
  assert.deepEqual(delFirst, {rects: [block[0].rect], originalText: 'Line 1', newText: ''});

  // Deleting last line
  const delLast = plain(pe.trimBlockLines(block, 'Line 1\nLine 2\nLine 3'));
  assert.deepEqual(delLast, {rects: [block[3].rect], originalText: 'Line 4', newText: ''});

  // Deleting everything produces all rects and newText ''
  const delAll = plain(pe.trimBlockLines(block, ''));
  assert.deepEqual(delAll, {
    rects: block.map(l => l.rect),
    originalText: 'Line 1\nLine 2\nLine 3\nLine 4',
    newText: '',
  });
  const delBlank = plain(pe.trimBlockLines(block, '   \n  '));
  assert.equal(delBlank.newText, '');
  assert.equal(delBlank.rects.length, 4);

  // Inserting a new line between unchanged lines keeps at least one rect so BoothEdit stays valid
  const ins = plain(pe.trimBlockLines(block, 'Line 1\nLine 2\nInserted\nLine 3\nLine 4'));
  assert.equal(ins.rects.length, 1);
  assert.deepEqual(ins.rects[0], block[2].rect);
  assert.equal(ins.originalText, 'Line 3');
  assert.equal(ins.newText, 'Inserted\nLine 3');

  // Splitting one line into two keeps only that line's rect
  const split = plain(pe.trimBlockLines(block, 'Line 1\nLine 2a\nLine 2b\nLine 3\nLine 4'));
  assert.deepEqual(split, {rects: [block[1].rect], originalText: 'Line 2', newText: 'Line 2a\nLine 2b'});

  // Merging two lines into one covers both rects
  const merged = plain(pe.trimBlockLines(block, 'Line 1\nLine 2 + 3\nLine 4'));
  assert.deepEqual(merged, {rects: [block[1].rect, block[2].rect], originalText: 'Line 2\nLine 3', newText: 'Line 2 + 3'});
});

test('tokenAt, tokensIn, numericToken, placePopover, keyboardInset and hintBlock work as expected', () => {
  const text = 'Ragas 0.95, (43%) "WikiEval".';
  const word = at => { const t = pe.tokenAt(text, at); return text.slice(t.start, t.end); };
  assert.equal(word(7), '0.95');
  assert.equal(word(10), '0.95');
  assert.equal(word(13), '43%');
  assert.equal(word(20), 'WikiEval');
  assert.equal(word(5), 'Ragas');
  assert.equal(pe.tokenAt('   ', 1), null);
  assert.deepEqual(plain(pe.tokenAt('...', 1)), {start: 0, end: 3});

  const line = 'Ragas 0.95, 0.78';
  assert.deepEqual(plain(pe.tokensIn(line)).map(t => line.slice(t.start, t.end)), ['Ragas', '0.95', '0.78']);

  for (const yes of ['0.95', '43%', '-1.2', '1,024', '−0.5']) assert.equal(pe.numericToken(yes), true, yes);
  for (const no of ['WikiEval', '.', '%', 'v2', '']) assert.equal(pe.numericToken(no), false, no);

  const bounds = {left: 8, top: 8, right: 382, bottom: 760};
  assert.deepEqual(plain(pe.placePopover({left: 100, right: 120, top: 100, bottom: 110}, {w: 300, h: 150}, bounds)), {left: 8, top: 118, above: false});
  assert.deepEqual(plain(pe.placePopover({left: 300, right: 340, top: 700, bottom: 710}, {w: 300, h: 150}, bounds)), {left: 82, top: 542, above: true});

  assert.equal(pe.keyboardInset(844, {height: 544, offsetTop: 0}), 300);
  assert.equal(pe.keyboardInset(844, null), 0);

  const spot = pe.densest([{x: 0, y: 0}, {x: 10, y: 0}, {x: 20, y: 5}, {x: 300, y: 300}], 30);
  assert.equal(spot.count, 3);
  assert.equal(pe.ZOOM, 2.5);
  assert.equal(pe.TABLE_ZOOM, 3.5);

  // hintBlock grows from Table 1 numeric spans to row names and header without crossing to right column or caption
  const tableSpans = [
    {rect: R(0.247, 0.090, 0.045, 0.011)}, // Faith.
    {rect: R(0.309, 0.090, 0.071, 0.011)}, // Ans. Rel.
    {rect: R(0.396, 0.090, 0.077, 0.011)}, // Cont. Rel.
    {rect: R(0.128, 0.114, 0.044, 0.011)}, // Ragas
    {rect: R(0.128, 0.129, 0.081, 0.011)}, // GPT Score
    {rect: R(0.128, 0.146, 0.101, 0.011)}, // GPT Ranking
    {rect: R(0.514, 0.088, 0.366, 0.011)}, // Right column
    {rect: R(0.118, 0.177, 0.366, 0.010)}, // Caption below
  ];
  const block = plain(pe.hintBlock(tableSpans, R(0.254, 0.114, 0.198, 0.043), 0.011));
  assert.ok(Math.abs(block.x - 0.128) < 1e-9, 'row names included');
  assert.ok(Math.abs(block.y - 0.090) < 1e-9, 'header row included');
  assert.ok(block.x + block.w < 0.5, 'right column stays out');
  assert.ok(block.y + block.h < 0.177, 'caption below stays out');
  assert.equal(pe.fitZoom(0.377, 0, 3.5), 2.65);
});

test('removed anchoring, merge, notText and fallbackPatch helpers are gone', () => {
  for (const gone of [
    'spotIn', 'inkChars', 'alignInk', 'hunksOf', 'unchangedAt', 'sideAgree',
    'outsideBoxes', 'splitWord', 'fallbackPatch', 'paragraphAt', 'contextWindow', 'fitCrop', 'nearestIndex',
  ]) {
    assert.equal(pe[gone], undefined, gone + ' must be deleted');
  }
});
