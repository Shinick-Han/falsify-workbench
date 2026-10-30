import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planInlineChange} from '../src/paragraph-vendor/inline-preservation.mjs';
const run=(text,rgba,other={})=>({text,family:'Times LT Std',size:8,rise:4.483,hScale:1,rgba,...other});
function plan(runs,after='35') {const chars=runs.flatMap((r,ri)=>Array.from(r.text,(ch,o)=>({ch,pi:0,ri,o})));return planInlineChange([{runs}],chars,chars.map((_,i)=>[i,i]),0,chars.map(c=>c.ch).join(''),after);}
test('consolidating colored citation digits uses their common raised style',()=>{
 const p=plan([run('2',65535),run(',',255),run('3',65535)]);
 assert.equal(p.failure,undefined);assert.deepEqual(p.inserts,[{pi:0,ri:0,o:0,text:'35'}]);assert.equal(p.del.length,3);assert.equal(p.warning,'numeric_marker_style_from_digits');
});
test('link separator rule supports a numeric range without flattening surrounding text',()=>{
 const p=plan([run('See ',255),run('2',65535),run('–',255),run('3',65535),run(' for details.',255)],'See 35 for details.');
 assert.equal(p.failure,undefined);assert.deepEqual(p.inserts,[{pi:0,ri:1,o:0,text:'35'}]);assert.deepEqual(p.del.map(c=>c.ch),['2','–','3']);
});
test('different digit styles or true font/geometry changes remain unresolved',()=>{
 for(const runs of [[run('2',65535),run(',',255),run('3',255)],[run('2',65535),run(',',255,{size:10}),run('3',65535)],[run('2',65535),run(',',255,{rise:0}),run('3',65535)],[run('2',65535),run(',',255,{family:'Other'}),run('3',65535)]])assert.equal(plan(runs).failure,'AMBIGUOUS_STYLE');
});
test('mixed prose and newly punctuated alternatives do not assume a marker style',()=>{
 assert.equal(plan([run('item2',65535),run(',',255),run('3',65535)]).failure,'AMBIGUOUS_STYLE');
 assert.equal(plan([run('2',65535),run(',',255),run('3',65535)],'3,5').failure,'AMBIGUOUS_STYLE');
});
