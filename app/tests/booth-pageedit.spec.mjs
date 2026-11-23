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

test('clusterBlock stays inside one column with overshooting spans and stops at >1.3x pitch or font-size change', () => {
  // Real page-5-like two-column layout where left-column spans slightly overshoot past x=0.5143
  // into the right column, plus an inset GPT Score prompt box above "Ties, where...".
  const items = [
    // Prompt box in left column (y=0.784..0.8323, pitch=0.0161)
    {text: 'Given an answer and context, assign a', rect: R(0.155, 0.7840, 0.306, 0.013), fontSize: 10.91},
    {text: 'score for faithfulness in the range 0-10.', rect: R(0.1557, 0.8001, 0.3053, 0.013), fontSize: 10.91},
    {text: 'context: [context]', rect: R(0.1557, 0.8162, 0.1462, 0.0133), fontSize: 10.91},
    {text: 'answer: [answer]', rect: R(0.1557, 0.8323, 0.1375, 0.0132), fontSize: 10.91},
    // Target paragraph below prompt box (step = 0.0246 = 1.53x pitch)
    {text: 'Ties, where the same score is assigned by the LLM', rect: R(0.1185, 0.8569, 0.3807, 0.013), fontSize: 10.91},
    // Overshoots to x2 = 0.5163 > right column x = 0.5143!
    {text: 'to both answer candidates, were broken randomly.', rect: R(0.1190, 0.8730, 0.3973, 0.013), fontSize: 10.91},
    {text: 'The second baseline, shown as GPT Ranking, in-', rect: R(0.1185, 0.8891, 0.3726, 0.013), fontSize: 10.91},
    {text: 'stead asks ChatGPT to select the preferred answer/-', rect: R(0.1190, 0.9052, 0.3856, 0.013), fontSize: 10.91},
    // Right column on exact same baselines (x = 0.5143)
    {text: 'of any ground truth. Our evaluation on WikiEval', rect: R(0.5143, 0.8408, 0.3921, 0.013), fontSize: 10.91},
    {text: 'has shown that the predictions from Ragas are', rect: R(0.5143, 0.8569, 0.3889, 0.013), fontSize: 10.91},
    {text: 'closely aligned with human predictions, especially', rect: R(0.5143, 0.8730, 0.3952, 0.013), fontSize: 10.91},
    {text: 'for faithfulness and answer relevance.', rect: R(0.5143, 0.8891, 0.2934, 0.013), fontSize: 10.91},
  ];
  const para = plain(pe.clusterBlock(items, 5));
  assert.deepEqual(para.map(l => l.text), [
    'Ties, where the same score is assigned by the LLM',
    'to both answer candidates, were broken randomly.',
    'The second baseline, shown as GPT Ranking, in-',
    'stead asks ChatGPT to select the preferred answer/-',
  ]);
  for (const line of para) {
    assert.ok(line.rect.x < 0.2 && line.rect.x + line.rect.w < 0.53, 'line stays in left column: ' + JSON.stringify(line.rect));
  }

  // Font-size change stops clustering even when vertical pitch matches
  const mixedFont = [
    {text: 'Heading line', rect: R(0.12, 0.200, 0.20, 0.013), fontSize: 13},
    {text: 'Body line one', rect: R(0.12, 0.216, 0.35, 0.013), fontSize: 10.9},
    {text: 'Body line two', rect: R(0.12, 0.232, 0.35, 0.013), fontSize: 10.9},
  ];
  assert.deepEqual(plain(pe.clusterBlock(mixedFont, 1)).map(l => l.text), ['Body line one', 'Body line two']);

  // Vertical gap > 1.3x line pitch stops clustering even with identical font size and line height
  const gapped = [
    {text: 'Para 1 line 1', rect: R(0.12, 0.200, 0.35, 0.013), fontSize: 10.9},
    {text: 'Para 1 line 2', rect: R(0.12, 0.216, 0.35, 0.013), fontSize: 10.9},
    // Step = 0.024 = 1.5x pitch (0.016)
    {text: 'Para 2 line 1', rect: R(0.12, 0.240, 0.35, 0.013), fontSize: 10.9},
    {text: 'Para 2 line 2', rect: R(0.12, 0.256, 0.35, 0.013), fontSize: 10.9},
  ];
  assert.deepEqual(plain(pe.clusterBlock(gapped, 2)).map(l => l.text), ['Para 2 line 1', 'Para 2 line 2']);
});

test('diffChangedRange and changedBlockEdit map changed substrings to character rects', () => {
  const block = plain(pe.groupLines([
    {text: 'Ties, where the same score is assigned by the LLM', rect: R(0.118, 0.857, 0.381, 0.013)},
    {text: 'to both answer candidates, were broken randomly.', rect: R(0.119, 0.873, 0.370, 0.013)},
    {text: 'The second baseline asks ChatGPT to pick one.', rect: R(0.118, 0.889, 0.360, 0.013)},
  ]));
  const orig = block.map(l => l.text).join('\n');

  // 1. No change -> null
  assert.equal(pe.diffChangedRange(orig, orig), null);
  assert.equal(pe.changedBlockEdit(block, orig.replace(/\n/g, '\r\n')), null);

  // 2. Middle change: "broken randomly." -> "broken deterministically." snaps outward to word boundaries
  const mid = plain(pe.changedBlockEdit(block, orig.replace('broken randomly', 'broken deterministically')));
  assert.equal(mid.originalText, 'randomly.');
  assert.equal(mid.newText, 'deterministically.');
  assert.equal(mid.rects.length, 1, 'middle change covers only the 1 touched line');
  assert.ok(mid.rects[0].y === block[1].rect.y, 'rect is on line 1');
  assert.ok(mid.rects[0].x > block[1].rect.x + 0.25 && mid.rects[0].w < block[1].rect.w * 0.3,
    'rect covers only the changed word, not the full line: ' + JSON.stringify(mid.rects[0]));

  // 3. Change at the start
  const atStart = plain(pe.changedBlockEdit(block, orig.replace('Ties,', 'Draws,')));
  assert.equal(atStart.originalText, 'Ties,');
  assert.equal(atStart.newText, 'Draws,');
  assert.equal(atStart.rects.length, 1);
  assert.ok(Math.abs(atStart.rects[0].x - block[0].rect.x) < 1e-6, 'start rect begins at line 0 start');
  assert.ok(atStart.rects[0].w < block[0].rect.w * 0.2, 'start rect covers only first word');

  // 4. Change at the end
  const atEnd = plain(pe.changedBlockEdit(block, orig.replace('one.', 'two.')));
  assert.equal(atEnd.originalText, 'one.');
  assert.equal(atEnd.newText, 'two.');
  assert.equal(atEnd.rects.length, 1);
  assert.ok(atEnd.rects[0].y === block[2].rect.y, 'end rect is on last line');
  assert.ok(Math.abs((atEnd.rects[0].x + atEnd.rects[0].w) - (block[2].rect.x + block[2].rect.w)) < 1e-6, 'end rect ends at line 2 end');
  assert.ok(atEnd.rects[0].w < block[2].rect.w * 0.2, 'end rect covers only last word');

  // 5. Two separate changes in one sheet -> ONE range spanning both
  const twoChanges = plain(pe.changedBlockEdit(
    block,
    orig.replace('same', 'exact').replace('broken', 'settled')
  ));
  assert.equal(twoChanges.originalText, 'same score is assigned by the LLM\nto both answer candidates, were broken');
  assert.equal(twoChanges.newText, 'exact score is assigned by the LLM\nto both answer candidates, were settled');
  assert.equal(twoChanges.rects.length, 2, 'spans lines 0 and 1 only, not line 2');
  assert.equal(twoChanges.rects[0].y, block[0].rect.y);
  assert.equal(twoChanges.rects[1].y, block[1].rect.y);
  assert.ok(twoChanges.rects[0].x > block[0].rect.x + 0.08, 'line 0 rect starts at "same"');
  assert.ok(twoChanges.rects[1].x + twoChanges.rects[1].w < block[1].rect.x + block[1].rect.w - 0.05, 'line 1 rect stops at "broken"');

  // 6. Full deletion -> whole block with newText ''
  const delAll = plain(pe.changedBlockEdit(block, ''));
  assert.deepEqual(delAll.rects, block.map(l => l.rect));
  assert.equal(delAll.originalText, orig);
  assert.equal(delAll.newText, '');
  const delBlank = plain(pe.changedBlockEdit(block, '  \n\t '));
  assert.equal(delBlank.newText, '');
  assert.equal(delBlank.rects.length, 3);
});

test('commitParagraphChange preserves untouched earlier edits, replaces covered ones, and removes reverted ones', () => {
  const block = plain(pe.groupLines([
    {text: 'Table 1: Agreement with human annotators in pairwise', rect: R(0.118, 0.177, 0.366, 0.010)},
    {text: 'comparisons of faithfulness, answer relevance and con-', rect: R(0.118, 0.191, 0.368, 0.010)},
    {text: 'text relevance, using the WikEval dataset (accuracy).', rect: R(0.118, 0.205, 0.370, 0.010)},
  ]));
  const earlier = [{
    id: 'e-1', pageIndex: 4,
    rects: [R(0.28, 0.205, 0.055, 0.010)],
    originalText: 'WikEval', newText: 'MyBench', source: 'tap',
  }];
  const prefill = pe.applyEditsToBlock(block, earlier);
  assert.ok(prefill.includes('MyBench'));

  // Untouched earlier edit on line 2 survives when only line 1 changes
  const keepEarlier = plain(pe.commitParagraphChange(block, earlier, prefill.replace('faithfulness', 'accuracy')));
  assert.deepEqual(keepEarlier.removeIds, []);
  assert.equal(keepEarlier.edit.originalText, 'faithfulness,');
  assert.equal(keepEarlier.edit.newText, 'accuracy,');
  assert.equal(keepEarlier.edit.rects.length, 1);
  assert.equal(keepEarlier.edit.rects[0].y, block[1].rect.y, 'new edit sits on line 1 only so line 2 edit survives');

  // Earlier edit reverted while line 1 changes -> earlier edit id is removed, only line 1 edit emitted
  const revertEarlier = plain(pe.commitParagraphChange(
    block, earlier, prefill.replace('faithfulness', 'accuracy').replace('MyBench', 'WikEval')
  ));
  assert.deepEqual(revertEarlier.removeIds, ['e-1']);
  assert.equal(revertEarlier.edit.originalText, 'faithfulness,');
  assert.equal(revertEarlier.edit.newText, 'accuracy,');
  assert.equal(revertEarlier.edit.rects.length, 1);

  // Earlier edit modified in place -> new edit covers original "WikEval" rect so overlap rule replaces e-1
  const modifyEarlier = plain(pe.commitParagraphChange(block, earlier, prefill.replace('MyBench', 'YourBench')));
  assert.deepEqual(modifyEarlier.removeIds, []);
  assert.equal(modifyEarlier.edit.originalText, 'WikEval');
  assert.equal(modifyEarlier.edit.newText, 'YourBench');
  assert.equal(modifyEarlier.edit.rects.length, 1);
  assert.equal(modifyEarlier.edit.rects[0].y, block[2].rect.y);

  // No change from prefill -> no-op
  assert.deepEqual(plain(pe.commitParagraphChange(block, earlier, prefill)), {removeIds: [], edit: null});
});

test('1-line single-word delete keeps rest of line in prefill and pure insertions never emit empty originalText', () => {
  // P0-3 case 1: 1-line block with a single-word delete -> prefill shows the line minus that word
  const oneLine = plain(pe.groupLines([
    {text: 'Table 1: Agreement with human annotators.', rect: R(0.118, 0.177, 0.366, 0.011)},
  ]));
  const delWord = [{
    id: 'e-del', pageIndex: 4,
    rects: [R(0.32, 0.177, 0.055, 0.011)],
    originalText: 'human', newText: '', source: 'tap',
  }];
  const prefill = pe.applyEditsToBlock(oneLine, delWord);
  assert.equal(prefill, 'Table 1: Agreement with  annotators.');

  // Editing another word on that 1-line block emits non-empty originalText and preserves the single-word delete
  const editOther = plain(pe.commitParagraphChange(oneLine, delWord, prefill.replace('Agreement', 'Consensus')));
  assert.deepEqual(editOther.removeIds, []);
  assert.equal(editOther.edit.originalText, 'Agreement');
  assert.equal(editOther.edit.newText, 'Consensus');

  // Typing a replacement right where the word was deleted also gives non-empty originalText
  const insertBack = plain(pe.commitParagraphChange(oneLine, delWord, 'Table 1: Agreement with expert annotators.'));
  assert.ok(insertBack.edit && insertBack.edit.originalText.length > 0, 'originalText must never be empty: ' + JSON.stringify(insertBack));
  assert.ok(insertBack.edit.newText.includes('expert'));

  // Re-editing a previously full-deleted block never emits originalText ''
  const fullDel = [{
    id: 'e-all', pageIndex: 4,
    rects: [oneLine[0].rect],
    originalText: oneLine[0].text, newText: '', source: 'paragraph',
  }];
  assert.equal(pe.applyEditsToBlock(oneLine, fullDel), '');
  const retype = plain(pe.commitParagraphChange(oneLine, fullDel, 'Brand new heading'));
  assert.equal(retype.edit.originalText, oneLine[0].text);
  assert.equal(retype.edit.newText, 'Brand new heading');

  // P0-3 case 2: pure insertion "a b" -> "a X b" (plus start/end insertions) gives non-empty originalText
  const ab = plain(pe.groupLines([{text: 'a b', rect: R(0.12, 0.20, 0.10, 0.012)}]));
  const midIns = plain(pe.commitParagraphChange(ab, [], 'a X b'));
  assert.ok(midIns.edit && midIns.edit.originalText.length > 0, 'middle pure insertion has non-empty originalText: ' + JSON.stringify(midIns));
  assert.ok(midIns.edit.newText.includes('X'), 'middle pure insertion includes inserted token');

  const startIns = plain(pe.commitParagraphChange(ab, [], 'X a b'));
  assert.equal(startIns.edit.originalText, 'a');
  assert.equal(startIns.edit.newText, 'X a');

  const endIns = plain(pe.commitParagraphChange(ab, [], 'a b X'));
  assert.equal(endIns.edit.originalText, 'b');
  assert.equal(endIns.edit.newText, 'b X');
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
  // The far edge rounds down when represented as x + width.
  const rounded = pe.hintBlock([{rect: R(0.09, 0.1, 0.12, 0.02)}], R(0.05, 0.1, 0.06, 0.02), 0.02);
  assert.ok(Math.abs(rounded.w - 0.16) < 1e-12);
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

/* plan97s-6 */
test('booth-pageedit.css never uses a CSS-wide keyword as a grid-area name', async () => {
  const css = await readFile(fileURLToPath(new URL('../dist/booth-pageedit.css', import.meta.url)), 'utf8');
  assert.doesNotMatch(css, /grid-area\s*:\s*(revert|revert-layer|initial|inherit|unset)\b/);
});
