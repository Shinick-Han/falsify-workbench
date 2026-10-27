import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {readOutputGlyphs} from '../src/paper-output-glyphs.mjs';
import {checkRecomposition} from '../src/paper-compose-check.mjs';
import {blocks,after,corpus,geometryCorpus,pageCorpus} from './recomposition-corpus.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
const check = (variant, options={}) => checkRecomposition({bytes:corpus(variant), expectedBlocks:blocks, pdfjs, exporter:'MuPDF', ...options});
test('byte-derived comparison accepts wrapping and page movement separately', async () => {
  for (const v of ['baseline','wrapped','moved']) assert.equal((await check(v)).checks.content.status,'pass',v);
  assert.deepEqual((await check('moved')).checks.movement.locations[2].pageIndexes,[1]);
});
test('selected After must match exactly', async () => {
  assert.equal((await check('edit',{edits:{c:after}})).checks.content.status,'pass');
  assert.equal((await check('edit',{edits:{c:after+' altered'}})).checks.content.status,'finding');
});
test('missing text, changed number or sign and duplication are findings', async () => {
  for (const v of ['missing','number','sign','duplicate']) assert.equal((await check(v)).checks.content.status,'finding',v);
});
test('out of bounds and unavailable checks are explicit', async () => {
  const r=await check('bounds'); assert.ok(r.findings.some(f=>f.code==='text-outside-page'));
  assert.equal(r.checks.visual.status,'unavailable'); assert.equal(r.checks.overlap.status,'unavailable'); assert.equal(r.checks.captionOwnership.status,'unavailable');
  assert.equal((await check('baseline',{exporter:'PDF.js'})).checks.independent.status,'unavailable');
});

const geometryCheck = (variant, text) => checkRecomposition({bytes:geometryCorpus(variant), expectedBlocks:[{id:'x',text}], pdfjs});
test('styled fragments preserve word boundaries and actual internal spaces', async () => {
  assert.equal((await geometryCheck('split','regulation')).checks.content.status,'pass');
  assert.equal((await geometryCheck('gap','regul ation')).checks.content.status,'pass');
  assert.equal((await geometryCheck('internal-space','regulation')).checks.content.status,'finding');
  assert.equal((await geometryCheck('wrap','hello world')).checks.content.status,'pass');
  assert.equal((await geometryCheck('split','regul ation')).checks.content.status,'finding');
  const ambiguous = await geometryCheck('ambiguous','regulation');
  assert.equal(ambiguous.checks.content.status,'unavailable');
  assert.ok(ambiguous.findings.some(f => f.code === 'ambiguous-text-geometry'));
});
test('upright font bounds detect each page edge and unsupported transforms', async () => {
  for (const v of ['bottom','top','right']) assert.equal((await geometryCheck(v,'control')).checks.bounds.status,'finding',v);
  assert.equal((await geometryCheck('control','control')).checks.bounds.status,'checked');
  assert.equal((await geometryCheck('rotated','control')).checks.bounds.status,'unavailable');
});

test('nonfinite geometry and a baseline below the viewport cannot pass', async () => {
  // Retain real bytes and extraction, then exercise values PDF.js clips before returning.
  const wrap = transform => ({getDocument(options) {
    const task = pdfjs.getDocument(options);
    return {destroy:() => task.destroy(), promise:task.promise.then(doc => ({numPages:doc.numPages, async getPage(n) {
      const page = await doc.getPage(n);
      return {getViewport: options => page.getViewport(options), cleanup:() => page.cleanup(), async getTextContent() {
        const content = await page.getTextContent(); transform(content.items[0]); return content;
      }};
    }}))};
  }});
  const base = {bytes:geometryCorpus('control'),expectedBlocks:[{id:'x',text:'control'}]};
  const below = await checkRecomposition({...base,pdfjs:wrap(item => {item.transform[5] = -3;})});
  assert.equal(below.checks.bounds.status,'finding');
  const bad = await checkRecomposition({...base,pdfjs:wrap(item => {item.transform[4] = NaN;})});
  assert.equal(bad.checks.bounds.status,'unavailable');
  assert.equal(bad.checks.content.status,'unavailable');
});


test('locations require complete validated alignment and supported geometry', async () => {
  const prefix = await geometryCheck('control','con');
  assert.equal(prefix.checks.content.status,'finding');
  assert.deepEqual(prefix.checks.movement.locations,null);
  assert.equal(prefix.checks.movement.status,'unavailable');
  for (const variant of ['ambiguous','rotated']) {
    const r = await geometryCheck(variant,variant === 'ambiguous' ? 'regulation' : 'control');
    assert.equal(r.checks.movement.status,'unavailable',variant);
    assert.equal(r.checks.movement.locations,null,variant);
  }
  const changed = await check('edit',{edits:{c:after+' altered'}});
  assert.equal(changed.checks.movement.status,'unavailable');
  assert.equal(changed.checks.movement.locations,null);
});

test('validated sequence locates repeats, edits, deletions and empty pages deterministically', async () => {
  const expectedBlocks = [{id:'a',text:'same'},{id:'b',text:'same'},{id:'c',text:'old'},{id:'d',text:'deleted'},{id:'e',text:''}];
  const result = await checkRecomposition({bytes:pageCorpus(['same','','same replacement']),expectedBlocks,edits:{c:'replacement',d:''},pdfjs});
  assert.equal(result.checks.content.status,'pass');
  assert.equal(result.checks.movement.status,'observed');
  assert.deepEqual(result.checks.movement.locations,[
    {id:'a',pageIndexes:[0]},{id:'b',pageIndexes:[2]},
    {id:'c',pageIndexes:[2]},{id:'d',pageIndexes:[]},{id:'e',pageIndexes:[]}
  ]);
  const missing = await checkRecomposition({bytes:pageCorpus(['same','replacement']),expectedBlocks,edits:{c:'replacement',d:''},pdfjs});
  assert.equal(missing.checks.content.status,'finding');
  assert.equal(missing.checks.movement.locations,null);
});


test('line ends preserve encoded hyphens, spaces and minus signs', async () => {
  const extract = async variant => {
    const task = pdfjs.getDocument({data:geometryCorpus(variant)});
    try {
      const doc = await task.promise;
      const content = await (await doc.getPage(1)).getTextContent();
      return content.items.map(({str, hasEOL, transform, width, height}) => ({str, hasEOL, transform, width, height}));
    } finally { await task.destroy(); }
  };
  assert.deepEqual(await extract('hyphen-wrap'), await extract('hyphen-space'));
  const ambiguous = await geometryCheck('hyphen-wrap','antero-posterior');
  assert.ok(ambiguous.findings.some(f => f.reason?.includes('discard an encoded space')));
  assert.equal(ambiguous.checks.movement.status,'unavailable');
  assert.equal((await geometryCheck('hyphen-wrap','antero-posterior')).checks.content.status,'unavailable');
  assert.equal((await geometryCheck('hyphen-wrap','antero- posterior')).checks.content.status,'unavailable');
  assert.equal((await geometryCheck('hyphen-space','antero- posterior')).checks.content.status,'unavailable');
  assert.equal((await geometryCheck('hyphen-space','antero-posterior')).checks.content.status,'unavailable');
  assert.equal((await geometryCheck('minus-wrap','value - 12')).checks.content.status,'pass');
  assert.equal((await geometryCheck('minus-wrap','value 12')).checks.content.status,'finding');
  assert.notEqual((await geometryCheck('soft-wrap','software')).checks.content.status,'pass');
});


test('encoded glyphs resolve only the matching hard-hyphen boundary', async () => {
  const run = (variant,text,extra={}) => checkRecomposition({bytes:geometryCorpus(variant),expectedBlocks:[{id:'x',text}],pdfjs,mupdf,...extra});
  for (const [variant,correct,opposite] of [
    ['hyphen-wrap','antero-posterior','antero- posterior'],
    ['hyphen-space','antero- posterior','antero-posterior'],
    ['repeat-hyphen','antero-posterior antero- posterior','antero- posterior antero-posterior'],
    ['unrelated-space','other space antero-posterior','other space antero- posterior']
  ]) {
    assert.equal((await run(variant,correct)).checks.content.status,'pass',variant);
    assert.equal((await run(variant,opposite)).checks.content.status,'finding',variant);
  }
  assert.equal((await run('minus-wrap','value - 12')).checks.content.status,'pass');
  assert.equal((await run('minus-wrap','value 12')).checks.content.status,'finding');
  const failed = await run('hyphen-wrap','antero-posterior',{mupdf:{}});
  assert.equal(failed.checks.content.status,'unavailable');
  const mismatch = await run('hyphen-wrap','antero-posterio9',{mupdf:{}});
  assert.ok(mismatch.findings.some(f=>f.code === 'content-mismatch'));
  const glyphs = readOutputGlyphs({bytes:geometryCorpus('hyphen-space'),mupdf});
  assert.deepEqual(glyphs[0].map(g=>g.scalar).slice(5,9),[111,45,32,112]);
  assert.ok(glyphs[0].every(g=>g.pageIndex === 0 && g.origin.every(Number.isFinite)));
});


test('glyph-resolved boundaries retain page movement and reject unknown scalars', async () => {
  const bytes = geometryCorpus('hyphen-page');
  const expectedBlocks = [{id:'a',text:'first'},{id:'b',text:'antero-posterior'}];
  const result = await checkRecomposition({bytes,expectedBlocks,pdfjs,mupdf});
  assert.equal(result.checks.content.status,'pass');
  assert.deepEqual(result.checks.movement.locations,[{id:'a',pageIndexes:[0]},{id:'b',pageIndexes:[1]}]);
  const unknown = {...mupdf, Device:class extends mupdf.Device {
    constructor(callbacks) {
      const wrapped = {...callbacks, fillText(text,ctm,cs) {
        callbacks.fillText({walk(walker) { text.walk({showGlyph(font,trm,gid,scalar) { walker.showGlyph(font,trm,gid,-1); }}); }, destroy() { text.destroy(); }},ctm,cs);
      }};
      super(wrapped);
    }
  }};
  const invalid = await checkRecomposition({bytes,expectedBlocks,pdfjs,mupdf:unknown});
  assert.equal(invalid.checks.content.status,'unavailable');
  assert.equal(invalid.checks.movement.locations,null);
});
