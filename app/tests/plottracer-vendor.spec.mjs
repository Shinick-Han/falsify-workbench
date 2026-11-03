import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const vendor=new URL('../dist/plottracer-vendor/',import.meta.url);
const bytes=readFileSync(new URL('engine.js',vendor));
const manifest=JSON.parse(readFileSync(new URL('manifest.json',vendor)));
const ctx=vm.createContext({});vm.runInContext(bytes.toString('utf8'),ctx,{timeout:2000});
test('pinned runtime loads without a browser or Node globals',()=>{
  assert.equal(ctx.FalsifyPlotTracer.UPSTREAM_COMMIT,'dcc28a5da453ff5c4e7cadd4478523560d15c0dc');
  assert.equal(manifest.engine.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(manifest.engine.bytes,bytes.length);
  assert.match(readFileSync(new URL('LICENSE',vendor),'utf8'),/GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.equal(vm.runInContext('typeof document+"/"+typeof require',ctx),'undefined/undefined');
});
test('unmodified upstream transforms linear negative and logarithmic values',()=>{
  const axis=(v0,v1,scale='linear')=>({scale,points:[{pixel:0,value:v0},{pixel:100,value:v1}]});
  const run=y=>JSON.parse(ctx.FalsifyPlotTracer.calibrate(JSON.stringify({x:axis(0,10),y}),JSON.stringify([[50,50]]))).points;
  assert.deepEqual(run(axis(1,-5)),[[5,-2]]);
  assert.deepEqual(run(axis(1,100,'log')),[[5,10]]);
  assert.throws(()=>run(axis(0,100,'log')),/invalid-calibration/);
});
test('source files retain the recorded upstream hashes',()=>{
  const root=new URL('../vendor-sources/plottracer/',import.meta.url);
  const upstream=JSON.parse(readFileSync(new URL('UPSTREAM.json',root)));
  for(const file of upstream.files)assert.equal(createHash('sha256').update(readFileSync(new URL(file.path,root))).digest('hex'),file.sha256,file.path);
  assert.equal(upstream.commit,manifest.commit);
});
