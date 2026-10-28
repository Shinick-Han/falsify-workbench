import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve, join} from 'node:path';

const require = createRequire(import.meta.url), {build} = require('esbuild');
const root = new URL('../src/', import.meta.url);
const runtime = process.env.PARAGRAPH_RUNTIME_DIR || fileURLToPath(new URL('paragraph-vendor/runtime/', root));
const {default: create} = await import(pathToFileURL(resolve(runtime, 'editcore.js')));
const bundle = await build({entryPoints:[fileURLToPath(new URL('paragraph-vendor/engine/core.js', root))], bundle:true, write:false, format:'esm', platform:'node', plugins:[{name:'adapter', setup(b) {
  b.onResolve({filter:/^\.\/engine-loader\.js$/}, () => ({path:fileURLToPath(new URL('paragraph-pdf-engine-loader.mjs', root))}));
  b.onResolve({filter:/freetext-script$/}, () => ({path:fileURLToPath(new URL('paragraph-vendor/utils/freetext-script.ts', root))}));
}}]});
const {PdfEngine} = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

function fixture() {
  const matrices = ['8.2319 0 0 8.25', '8.2665 0 0 8.25', '8.25 0 0 8.25', '0 8.2319 -8.25 0', '0 0 0 8.25'];
  const streams = matrices.map(m => `BT /F1 1 Tf ${m} 60 200 Tm (Scale test) Tj ET`);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${streams.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] /Count ${streams.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [i,s] of streams.entries()) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 500] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`, `<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  let pdf='%PDF-1.4\n', offsets=[0];
  for (const [i,obj] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`; }
  const x=Buffer.byteLength(pdf);
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('native model retains small horizontal scales, including rotated text', async () => {
  const M=await create({wasmBinary:readFileSync(join(runtime,'editcore.wasm')),print(){},printErr(){}});
  const cfg=M._malloc(48); M.HEAPU8.fill(0,cfg,cfg+48); M.HEAPU32[cfg>>2]=2; M._FPDF_InitLibraryWithConfig(cfg); M._free(cfg);
  const e=new PdfEngine(M); e.open(fixture());
  try {
    for (const [i, expected] of [8.2319/8.25, 1.002, 1, 8.2319/8.25].entries()) {
      e.loadPage(i);
      const runs=e.buildModel().flatMap(p=>p.runs);
      const run=runs.find(r=>r.text.includes('Scale'));
      assert.ok(run, `missing text on page ${i}`);
      assert.ok(Number.isFinite(run.hScale) && run.hScale > 0);
      assert.ok(Math.abs(run.hScale-expected)<0.000001, `page ${i}: ${run.hScale} vs ${expected}`);
    }
    e.loadPage(4);
    for (const run of e.buildModel().flatMap(p=>p.runs)) assert.ok(Number.isFinite(run.hScale) && run.hScale > 0);
  } finally { e.close(); }
});
