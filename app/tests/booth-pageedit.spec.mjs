// FalsifyBoothPageEdit pure helpers: token picking, context windows, popover placement, crop fit,
// numeric tokens, word walk, dense number clusters and the soft-keyboard inset. No DOM.
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

test('tokenAt takes the whole token and drops wrapping punctuation', () => {
  const text = 'Ragas 0.95, (43%) "WikiEval".';
  const word = at => { const t = pe.tokenAt(text, at); return text.slice(t.start, t.end); };
  assert.equal(word(7), '0.95');
  assert.equal(word(10), '0.95', 'the comma belongs to no token');
  assert.equal(word(13), '43%');
  assert.equal(word(20), 'WikiEval');
  assert.equal(word(5), 'Ragas', 'a space snaps to the nearest ink');
  assert.equal(pe.tokenAt('   ', 1), null);
  assert.deepEqual(plain(pe.tokenAt('...', 1)), {start: 0, end: 3}, 'all punctuation keeps the token');
});

test('contextWindow centres the token in the joined neighbour text', () => {
  const ctx = pe.contextWindow(['Faith. Ans. Rel.', 'Ragas', '0.95', '0.78'], 2, 0, 4);
  assert.equal(ctx, 'Faith. Ans. Rel. Ragas 0.95 0.78');
  assert.equal(pe.contextWindow(['x'.repeat(100), '0.95'], 1, 0, 4).length, 40 + 4, 'forty characters (the space included) before the token');
});

test('placePopover goes below, flips above, then clamps into bounds', () => {
  const bounds = {left: 8, top: 8, right: 382, bottom: 760};
  assert.deepEqual(plain(pe.placePopover({left: 100, right: 120, top: 100, bottom: 110}, {w: 300, h: 150}, bounds)), {left: 8, top: 118, above: false});
  assert.deepEqual(plain(pe.placePopover({left: 300, right: 340, top: 700, bottom: 710}, {w: 300, h: 150}, bounds)), {left: 82, top: 542, above: true});
  assert.equal(pe.placePopover({left: 0, right: 10, top: 50, bottom: 60}, {w: 300, h: 740}, bounds).top, 20, 'too tall for either side: clamped to the bottom bound');
});

test('fitCrop keeps the paragraph aspect inside the allowed box', () => {
  assert.deepEqual(plain(pe.fitCrop({x: 0, y: 0, w: 0.5, h: 0.1}, 1.29, 300, 200)), {w: 300, h: 77});
  assert.deepEqual(plain(pe.fitCrop({x: 0, y: 0, w: 0.4, h: 0.5}, 1.29, 300, 200)), {w: 124, h: 200});
  assert.equal(pe.fitCrop({x: 0, y: 0, w: 0, h: 0.1}, 1.29, 300, 200), null);
});

test('overlapShare, paragraphAt and padRect work in page fractions', () => {
  assert.equal(pe.overlapShare({x: 0, y: 0, w: 1, h: 1}, {x: 2, y: 2, w: 1, h: 1}), 0);
  assert.equal(pe.overlapShare({x: 0, y: 0, w: 0.2, h: 0.1}, {x: 0.05, y: 0, w: 0.1, h: 0.1}), 1);
  const items = [{segmentId: 'big', rect: {x: 0, y: 0, w: 1, h: 1}}, {segmentId: 'small', rect: {x: 0.1, y: 0.1, w: 0.2, h: 0.1}}];
  assert.equal(pe.paragraphAt(items, 0.15, 0.15).segmentId, 'small');
  assert.equal(pe.paragraphAt(items, 2, 2), null);
  assert.deepEqual(Object.values(plain(pe.padRect({x: 0, y: 0.5, w: 0.5, h: 0.1}, 0.01))).map(n => Math.round(n * 1000) / 1000), [0, 0.49, 0.51, 0.12]);
});

test('numericToken, tokensIn, densest and keyboardInset', () => {
  for (const yes of ['0.95', '43%', '-1.2', '1,024', '−0.5']) assert.equal(pe.numericToken(yes), true, yes);
  for (const no of ['WikiEval', '.', '%', 'v2', '']) assert.equal(pe.numericToken(no), false, no);
  const line = 'Ragas 0.95, 0.78';
  assert.deepEqual(plain(pe.tokensIn(line)).map(t => line.slice(t.start, t.end)), ['Ragas', '0.95', '0.78']);
  const spot = pe.densest([{x: 0, y: 0}, {x: 10, y: 0}, {x: 20, y: 5}, {x: 300, y: 300}], 30);
  assert.equal(spot.count, 3);
  assert.equal(pe.densest([], 10), null);
  assert.equal(pe.keyboardInset(844, {height: 544, offsetTop: 0}), 300);
  assert.equal(pe.keyboardInset(844, {height: 844, offsetTop: 0}), 0);
  assert.equal(pe.keyboardInset(844, null), 0);
  assert.equal(pe.ZOOM, 2.5);
  assert.equal(pe.TABLE_ZOOM, 3.5);
});

test('spotIn maps the tapped occurrence into the paragraph text, however often the word repeats', () => {
  const table = '0.95\t 0.78\t 0.70 GPT Score\t 0.72\t 0.52\t 0.63 GPT Ranking\t 0.54\t 0.40\t 0.52';
  const cells = ['Ragas', '0.95', '0.78', '0.70', 'GPT Score', '0.72', '0.52', '0.63', 'GPT Ranking', '0.54', '0.40', '0.52'];
  const second = pe.spotIn(cells, 11, 0, 4, table);
  assert.equal(second.start, table.lastIndexOf('0.52'), 'the second 0.52, not the first');
  assert.equal(pe.spotIn(cells, 6, 0, 4, table).start, table.indexOf('0.52'));
  assert.equal(pe.spotIn(cells, 0, 0, 5, table), null, 'a row name outside the paragraph text');
  const lines = ['Table 1 analyses the agreement between the met-', 'rics proposed in Section 3 and the'];
  const text = 'Table 1 analyses the agreement between the metrics proposed in Section 3 and the';
  const the = lines[0].lastIndexOf('the');
  assert.equal(pe.spotIn(lines, 0, the, the + 3, text).start, text.indexOf('the metrics'));
  const head = pe.spotIn(lines, 0, lines[0].length - 4, lines[0].length, text);
  assert.deepEqual([head.before, head.join.side, head.join.part], ['metrics', 'right', 1], 'a hyphenated word is one word');
  const tail = pe.spotIn(lines, 1, 0, 4, text);
  assert.deepEqual([tail.before, tail.join.side], ['metrics', 'left']);
  const lig = pe.spotIn(['the \u{FB01}rst \u{FB01}eld'], 0, 9, 13, 'the first field');
  assert.equal('the first field'.slice(lig.start, lig.end), 'field', 'ligatures compare as their letters');
  const sup = pe.spotIn(['x', '2', 'and', 'x', '2'], 4, 0, 1, 'x2 and x2');
  assert.equal(sup.start, 8, 'a superscript after a repeated base');
});

test('nearestIndex, unchangedAt and splitWord', () => {
  assert.equal(pe.nearestIndex('0.52 a 0.52', '0.52', 6), 7);
  assert.equal(pe.nearestIndex('abc', 'x', 0), -1);
  assert.equal(pe.unchangedAt('0.40 0.52', '0.40 0.11', 0, 4), 0, 'in the unchanged prefix');
  assert.equal(pe.unchangedAt('between the metrics', 'between a metrics', 12, 7), 10, 'in the unchanged suffix');
  assert.equal(pe.unchangedAt('a b c', 'a X c', 2, 1), -1, 'the changed part itself');
  assert.deepEqual(plain(pe.splitWord('models', 3, 4)), ['mod-', 'els'], 'proportional halves');
  assert.deepEqual(plain(pe.splitWord('a', 3, 4)), ['a', '']);
});
