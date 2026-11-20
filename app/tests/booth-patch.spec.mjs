// FalsifyBoothPatch geometry (app/dist/booth-patch.js): page-fraction rects to CSS px at several page
// widths, the scaleX clamp at 0.7, transform parsing for measure(), font size kept as a fraction of the
// page width, background sampling with its white fallback, and the old-ink word finder. No real DOM.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const source = await readFile(fileURLToPath(new URL('../dist/booth-patch.js', import.meta.url)), 'utf8');

function load() {
  const context = vm.createContext({console});
  vm.runInContext(source, context, {filename: 'booth-patch.js'});
  return {api: context.FalsifyBoothPatch, core: context.FalsifyBoothPatchCore};
}
const plain = value => JSON.parse(JSON.stringify(value));
const close = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, label + ': ' + a + ' vs ' + b);

/* A canvas stub whose pixels come from fn(x, y) -> [r, g, b, a]. */
function fakeCanvas(width, height, fn, {throws = false, noContext = false} = {}) {
  return {
    width, height,
    getContext() {
      if (noContext) return null;
      return {
        getImageData(x, y, w, h) {
          if (throws) throw new Error('SecurityError: tainted');
          const data = new Uint8ClampedArray(w * h * 4);
          for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data.set(fn(x + i, y + j), (j * w + i) * 4);
          return {data};
        },
      };
    },
  };
}

test('the API is exactly the contract', () => {
  const {api} = load();
  assert.deepEqual(Object.keys(api).sort(), ['clear', 'measure', 'paint', 'remove', 'repaint']);
  for (const key of Object.keys(api)) assert.equal(typeof api[key], 'function');
});

test('rect fractions map to CSS px at any page width and survive a resize', () => {
  const {core} = load();
  const rect = core.normalizeRect({x: 0.25, y: 0.1, w: 0.05, h: 0.015});
  for (const width of [360, 660, 924, 1320]) {
    const height = width * 792 / 612;
    const px = core.rectToPx(rect, width, height);
    close(px.left, 0.25 * width, 'left at ' + width);
    close(px.top, 0.1 * height, 'top at ' + width);
    close(px.width, 0.05 * width, 'width at ' + width);
    close(px.height, 0.015 * height, 'height at ' + width);
  }
  const a = core.rectToPx(rect, 660, 854), b = core.rectToPx(rect, 924, 1195.6);
  close(b.left / a.left, 1.4, 'left ratio');
  close(b.width / a.width, 1.4, 'width ratio');
});

test('normalizeRect clips to the page and rejects unusable boxes', () => {
  const {core} = load();
  assert.deepEqual(plain(core.normalizeRect({x: -0.1, y: 0.95, w: 0.3, h: 0.2})), {x: 0, y: 0.95, w: 0.3, h: 0.050000000000000044});
  assert.equal(core.normalizeRect({x: 0.1, y: 0.1, w: 0, h: 0.1}), null);
  assert.equal(core.normalizeRect({x: 0.1, y: 0.1, w: NaN, h: 0.1}), null);
  assert.equal(core.normalizeRect({x: 0.1, y: 0.1, w: '0.2', h: 0.1}), null);
  assert.equal(core.normalizeRect(null), null);
});

test('scaleX compresses to fit and clamps at 0.7, after which the word overflows', () => {
  const {core} = load();
  assert.equal(core.MIN_SCALE_X, 0.7);
  assert.equal(core.fitScaleX(20, 21), 1, 'fits');
  assert.equal(core.fitScaleX(21, 21), 1, 'exact fit');
  close(core.fitScaleX(25, 20), 0.8, 'compressed');
  close(core.fitScaleX(20 / 0.7, 20), 0.7, 'at the clamp');
  assert.equal(core.fitScaleX(100, 20), 0.7, 'clamped');
  assert.equal(core.fitScaleX(0, 20), 1);
  assert.equal(core.fitScaleX(20, 0), 1);
});

test('transformScale reads pdf.js span transforms', () => {
  const {core} = load();
  assert.deepEqual(plain(core.transformScale('none')), {sx: 1, sy: 1});
  const m = core.transformScale('matrix(0.998113, 0, 0, 1.10873, 0, 0)');
  close(m.sx, 0.998113, 'sx'); close(m.sy, 1.10873, 'sy');
  const r = core.transformScale('matrix(0, 2, -3, 0, 0, 0)');
  close(r.sx, 2, 'rotated sx'); close(r.sy, 3, 'rotated sy');
  const d = core.transformScale('matrix3d(2, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)');
  close(d.sx, 2, '3d sx'); close(d.sy, 1.5, '3d sy');
});

test('the font is kept as a fraction of the page width; serif unless the hint says otherwise', () => {
  const {core} = load();
  const font = {fontFrac: 12.1 / 660, baselineFrac: 0.804, family: 'serif'};
  close(core.patchFont(font, {height: 12.1}, 660).fontPx, 12.1, 'at paint width');
  close(core.patchFont(font, {height: 16.94}, 924).fontPx, 12.1 * 1.4, 'after resize');
  close(core.patchFont(font, {height: 20}, 660).baselineY, 0.804 * 20, 'baseline in the rect');
  close(core.patchFont({}, {height: 11}, 660).fontPx, 11, 'no font: rect height');
  close(core.patchFont({baselineFrac: 9}, {height: 10}, 660).baselineY, 8, 'bad baseline: 0.8');
  assert.match(core.familyFor('serif'), /^"Times New Roman", "Nimbus Roman"/);
  assert.match(core.familyFor(undefined), /serif$/);
  assert.match(core.familyFor('sans'), /sans-serif$/);
  assert.match(core.familyFor('monospace'), /monospace$/);
});

test('background sampling falls back to white when the canvas cannot be read', () => {
  const {core} = load();
  const rect = {x: 0.4, y: 0.4, w: 0.2, h: 0.1};
  const grey = () => [200, 210, 220, 255];
  assert.equal(core.sampleBackground(null, rect), '#ffffff');
  assert.equal(core.sampleBackground(fakeCanvas(0, 0, grey), rect), '#ffffff');
  assert.equal(core.sampleBackground(fakeCanvas(100, 100, grey, {noContext: true}), rect), '#ffffff');
  assert.equal(core.sampleBackground(fakeCanvas(100, 100, grey, {throws: true}), rect), '#ffffff');
  assert.equal(core.sampleBackground(fakeCanvas(100, 100, () => [0, 0, 0, 0]), rect), '#ffffff', 'transparent pixels');
  assert.equal(core.sampleBackground(fakeCanvas(100, 100, grey), null), '#ffffff');
});

test('background sampling takes the page colour around the box, not neighbouring ink', () => {
  const {core} = load();
  const rect = {x: 0.4, y: 0.4, w: 0.2, h: 0.1};
  assert.equal(core.sampleBackground(fakeCanvas(100, 100, () => [200, 210, 220, 255]), rect), 'rgb(200, 212, 220)');
  // Ink to the left of the box (a neighbouring word) is outvoted by the paper.
  const paper = (x) => x < 39 ? [0, 0, 0, 255] : [255, 255, 255, 255];
  assert.equal(core.sampleBackground(fakeCanvas(100, 100, paper), rect), 'rgb(255, 255, 255)');
  assert.equal(core.pickBackground([[250, 250, 250, 255], [10, 10, 10, 255]]), 'rgb(252, 252, 252)', 'tie goes to the lighter');
  assert.equal(core.pickBackground([]), '#ffffff');
});

test('the old word is found by its ink, across a loose token box, and stops at word gaps', () => {
  const {core} = load();
  // Columns: word A at 0-9, gap 10-15, the target word at 16-39 (box says 18-36), gap, word C at 46-55.
  const cols = new Array(60).fill(0);
  for (const [a, b] of [[0, 10], [16, 22], [24, 40], [46, 56]]) for (let x = a; x < b; x++) cols[x] = 3;
  assert.deepEqual(plain(core.inkClusters(cols, 4)), [{start: 0, end: 10}, {start: 16, end: 40}, {start: 46, end: 56}]);
  assert.deepEqual(plain(core.wordInk(cols, 18, 36, 4)), {start: 16, end: 40});
  assert.equal(core.wordInk(new Array(30).fill(0), 5, 20, 4), null);
  // A box that only grazes the next word does not swallow it.
  assert.deepEqual(plain(core.wordInk(cols, 18, 47, 4)), {start: 16, end: 40});
});

test('ink coverage tells bold from regular', () => {
  const {core} = load();
  const h = 10, ink = {start: 0, end: 10};
  assert.equal(core.inkWeight(new Array(10).fill(1.8), ink, h), 400, 'regular coverage 0.18');
  assert.equal(core.inkWeight(new Array(10).fill(2.7), ink, h), 700, 'bold coverage 0.27');
  assert.equal(core.inkWeight([], null, h), 400);
  const block = new Uint8ClampedArray(2 * 2 * 4).fill(255);
  block.set([0, 0, 0, 255], 0);
  assert.deepEqual(Array.from(core.inkColumns(block, 2, 2, 255)), [1, 0]);
});

test('paint rejects a missing page, id or rect; remove and clear are safe on unknown ids', () => {
  const {api} = load();
  assert.throws(() => api.paint(null, {id: 'a', rect: {x: 0, y: 0, w: 0.1, h: 0.1}}), {name: 'TypeError'});
  const pageEl = {appendChild() {}, children: [], clientWidth: 600, clientHeight: 800};
  assert.throws(() => api.paint(pageEl, {id: 'a', rect: {x: 0, y: 0, w: 0, h: 0.1}}), {name: 'TypeError'});
  assert.throws(() => api.paint(pageEl, {rect: {x: 0, y: 0, w: 0.1, h: 0.1}}), {name: 'TypeError'});
  api.remove('nope');
  api.clear();
  api.repaint(null, 0);
});
