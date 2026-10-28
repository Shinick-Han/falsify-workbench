import test from 'node:test';
import assert from 'node:assert/strict';
import { planInlineChange, runStyleKey } from '../src/paragraph-vendor/inline-preservation.mjs';

function fixture(runs, after) {
  const paras = [{ runs }];
  const before = runs.map(r => r.text).join('');
  const chars = runs.flatMap((r, ri) => [...r.text].map((ch, o) => ({ ch, pi: 0, ri, o })));
  const map = chars.map((_, i) => [i, i]);
  const snapshot = structuredClone(paras);
  const result = planInlineChange(paras, chars, map, 0, before, after);
  assert.deepEqual(paras, snapshot);
  return { result, chars };
}
const regular = { family: 'HardingText', size: 8.25, bold: false, italic: false, rise: 0 };

test('variable-length replacement inherits the exact first anchor across justified runs', () => {
  const runs = [{ ...regular, hScale: 1.01351511, text: 'before old ' }, { ...regular, hScale: 0.991600037, text: 'words after' }];
  assert.notEqual(runStyleKey(runs[0]), runStyleKey(runs[1]));
  const { result } = fixture(runs, 'before an expanded replacement phrase after');
  assert.equal(result.failure, undefined);
  assert.deepEqual(result.inserts, [{ pi: 0, ri: 0, o: 7, text: 'an expanded replacement phrase' }]);
  assert.equal(result.del.map(c => c.ch).join(''), 'old words');
});

test('same-shape mixed semantic styles retain word anchors despite scale variation', () => {
  const runs = [{ ...regular, hScale: 1.01, text: 'old ' }, { ...regular, hScale: 0.99, bold: true, text: 'bold' }];
  const { result } = fixture(runs, 'new strong');
  assert.deepEqual(result.inserts, [{ pi: 0, ri: 0, o: 0, text: 'new' }, { pi: 0, ri: 1, o: 0, text: 'strong' }]);
  assert.equal(result.del.map(c => c.ch).join(''), 'oldbold');
});

for (const [key, value] of [['bold', true], ['italic', true], ['size', 9], ['rise', 1], ['family', 'Other'], ['rgba', 42]]) {
  test(`variable-length replacement rejects mixed ${key}`, () => {
    const runs = [{ ...regular, hScale: 1.01, text: 'old ' }, { ...regular, hScale: 0.99, [key]: value, text: 'words' }];
    assert.deepEqual(fixture(runs, 'a longer new phrase').result, { failure: 'AMBIGUOUS_STYLE' });
  });
}

test('moved word with different semantic style remains ambiguous', () => {
  const runs = [{ ...regular, hScale: 1.01, text: 'then ' }, { ...regular, hScale: 0.99, bold: true, text: 'bold' }];
  assert.deepEqual(fixture(runs, 'bold then').result, { failure: 'AMBIGUOUS_STYLE' });
});

test('insertion between justified runs chooses an existing anchor', () => {
  const runs = [{ ...regular, hScale: 1.01, text: 'one ' }, { ...regular, hScale: 0.99, text: 'two' }];
  assert.deepEqual(fixture(runs, 'one extra two').result.inserts, [{ pi: 0, ri: 1, o: 0, text: 'extra ' }]);
});
