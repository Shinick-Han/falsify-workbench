import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBrowserFontStore } from '../src/browser-fonts.mjs';

const load = async style => new Uint8Array(await readFile(new URL(`../dist/vendor/standard_fonts/LiberationSans-${style}.ttf`, import.meta.url)));
const file = (name, bytes) => ({ name, arrayBuffer: async () => bytes.slice().buffer });
const local = (name, bytes, reads) => ({ family: 'Liberation Sans', postscriptName: `LiberationSans-${name}`, style: name, blob: async () => { reads.push(name); return new Blob([bytes]); } });

test('actual font metadata, style selection, subset aliases and isolated snapshots', async () => {
  const store = createBrowserFontStore();
  await store.addFiles(await Promise.all(['Regular', 'Bold', 'Italic'].map(async s => file(`${s}.ttf`, await load(s)))));
  assert.equal(store.revision, 1);
  assert.deepEqual(store.list().map(({ family, weight, italic }) => [family, weight, italic]), [
    ['Liberation Sans', 400, false], ['Liberation Sans', 700, false], ['Liberation Sans', 400, true],
  ]);
  const first = await store.resolve([{ family: 'ABCDEF+LiberationSans-Bold', bold: true, text: 'A' }, { family: 'Liberation Sans', italic: true, text: 'B' }]);
  assert.deepEqual(first.fonts.map(f => [f.weight, f.italic]), [[700, false], [400, true]]);
  const initial = first.fonts[0].bytes[0];
  first.fonts[0].bytes[0] ^= 255;
  const again = await store.resolve([{ family: 'ABCDEF+LiberationSans-Bold', bold: true, text: 'A' }, { family: 'Liberation Sans', italic: true, text: 'B' }]);
  assert.equal(again.fonts[0].bytes[0], initial);
  assert.equal(again.digest, first.digest);
  assert.notEqual((await store.resolve([{ family: 'Liberation Sans', text: 'A' }])).digest, first.digest);
  assert.equal((await store.resolve([{ family: 'Liberation', text: 'A' }])).fonts.length, 0);
  store.clear(); assert.equal(store.revision, 2); assert.deepEqual(store.list(), []);
});

test('enumeration is lazy, retries denial, and bundled fallback is truthful', async () => {
  const reads = [], regular = await load('Regular'), bold = await load('Bold');
  let attempts = 0;
  const store = createBrowserFontStore({ queryLocalFonts: async () => {
    if (++attempts === 1) throw new Error('denied');
    return [local('Regular', regular, reads), local('Bold', bold, reads)];
  } });
  await assert.rejects(store.requestLocalFonts(), /권한/);
  assert.equal(store.revision, 0);
  await store.requestLocalFonts(); await store.requestLocalFonts();
  assert.equal(store.revision, 1); assert.deepEqual(reads, []);
  const snap = await store.resolve([{ family: 'Liberation Sans', bold: true, text: 'A' }], { fallbackFonts: [{ bytes: regular }] });
  assert.deepEqual(reads, ['Bold']);
  assert.deepEqual(snap.fonts.map(f => [f.family, f.weight, f.source]), [['Liberation Sans', 700, 'local'], ['Liberation Sans', 400, 'bundled']]);
  await assert.rejects(createBrowserFontStore({ queryLocalFonts: false }).requestLocalFonts(), /지원하지 않습니다/);
});

test('malformed, collections, variable and restricted fonts are rejected without losing prior faces', async () => {
  const bytes = await load('Regular'), store = createBrowserFontStore();
  await store.addFiles([file('ok.ttf', bytes)]);
  await assert.rejects(store.addFiles([file('bad.ttf', new Uint8Array([0, 1]))]), /올바른/);
  await assert.rejects(store.addFiles([file('bad.ttc', bytes)]), /TTF 또는 OTF/);
  const collection = bytes.slice(); collection.set([0x74, 0x74, 0x63, 0x66]);
  await assert.rejects(store.addFiles([file('collection.ttf', collection)]), /컬렉션/);
  const restricted = bytes.slice(), view = new DataView(restricted.buffer);
  for (let i = 0; i < view.getUint16(4); i++) {
    const p = 12 + i * 16;
    if (String.fromCharCode(...restricted.slice(p, p + 4)) === 'OS/2') view.setUint16(view.getUint32(p + 8) + 8, 2);
  }
  await assert.rejects(store.addFiles([file('restricted.ttf', restricted)]), /임베딩 제한/);
  const variable = bytes.slice(); variable.set([0x66, 0x76, 0x61, 0x72], 12);
  await assert.rejects(store.addFiles([file('variable.ttf', variable)]), /가변 글꼴/);
  assert.equal(store.revision, 1); assert.equal(store.list().length, 1);
});
