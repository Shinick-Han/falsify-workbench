import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import {checkRecomposition} from '../src/paper-compose-check.mjs';
import {blocks,after,corpus} from './recomposition-corpus.mjs';
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
