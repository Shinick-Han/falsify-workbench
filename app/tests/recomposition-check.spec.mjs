import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import {checkRecomposition} from '../src/paper-compose-check.mjs';
import {blocks,after,corpus,geometryCorpus} from './recomposition-corpus.mjs';
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
