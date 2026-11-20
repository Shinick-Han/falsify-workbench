import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function load(){
  const ctx = {};
  vm.runInNewContext(readFileSync(new URL('../dist/booth-edits.js', import.meta.url), 'utf8'), ctx);
  return ctx.FalsifyBoothEdits;
}
const R = (x, y, w = 0.02, h = 0.01) => ({x, y, w, h});

test('add, overlap replaces the older edit, update and remove', () => {
  const s = load();
  const a = s.add({pageIndex: 4, rects: [R(0.3, 0.1)], originalText: '0.95', newText: '0.50'});
  s.add({pageIndex: 4, rects: [R(0.6, 0.1)], originalText: '0.52', newText: '0.11'});
  assert.equal(s.list().length, 2);
  s.add({pageIndex: 4, rects: [R(0.29, 0.095, 0.05, 0.02)], originalText: '0.95', newText: '0.40'});
  assert.deepEqual([...s.list().map(e => e.newText)], ['0.11', '0.40'], 'the newest wins over the overlapped edit');
  const top = s.at(4, 0.3, 0.1);
  assert.equal(top.newText, '0.40');
  s.update(top.id, '0.95');
  assert.equal(s.list().length, 1, 'back to the original text removes the edit');
  s.remove(s.list()[0].id);
  assert.equal(s.list().length, 0);
  assert.notEqual(a.id, undefined);
});

test('deletion keeps an empty newText; restore drops invalid rows', () => {
  const s = load();
  s.add({pageIndex: 4, rects: [R(0.1, 0.2, 0.4, 0.03)], originalText: 'Table 1: Agreement…', newText: ''});
  const saved = s.serialize();
  const t = load();
  assert.equal(t.restore(saved).length, 1);
  assert.equal(t.list()[0].newText, '');
  assert.equal(t.restore('[{"pageIndex":-1}]').length, 0);
  assert.throws(() => t.add({pageIndex: 0, rects: []}));
});
