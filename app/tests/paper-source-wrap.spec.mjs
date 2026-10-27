import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDocument} from '../src/paper-document.mjs';
import {findSourceWrapOmissions,sourceWrapOffsetsForBlock} from '../src/paper-source-wrap.mjs';

function model(lines, other=['similar']) {
  let y=10;
  function block(parts) {const chars=[], ranges=[]; const top=y;
    for(const text of parts) {const start=chars.length; let x=10; for(const c of text) {chars.push({text:c,bbox:[x,y,x+1,y+1]});x++;} ranges.push({start,end:chars.length,bbox:[10,y,x,y+1],direction:[1,0],writingMode:0,baseline:[[10,y+0.8],[x-1,y+0.8]]}); y+=3;}
    return {bbox:[10,top,100,y],chars,lines:ranges};}
  return normalizeDocument({sourceSha256:'a'.repeat(64),pages:[{width:200,height:300,geometry:{frame:'mupdf-display',pageTransform:[1,0,0,-1,0,300]},blocks:[block(lines),...other.map(x=>block([x]))],images:[]}]});
}
const run=d=>findSourceWrapOmissions({document:d}).omissions;
test('source-located omission and fragment mapping preserve input',()=>{const d=model(['simi-','lar text']); const before=structuredClone(d), [o]=run(d), b=d.blocks[0]; assert.deepEqual(d,before); assert.equal(o.start,4); assert.equal(o.end,5); assert.equal(o.evidence.joined,'similar'); assert.equal(o.evidence.corroboration.length,1); assert.deepEqual(sourceWrapOffsetsForBlock(b,[o]),[4]); const f={...b,id:'existing-fragment',parentBlockId:b.id,text:b.text.slice(2,6),source:{...b.source,range:{start:2,end:6}}}; assert.deepEqual(sourceWrapOffsetsForBlock(f,[o]),[2]);});
test('real compounds, ambiguous corroboration, scientific tokens and missing corroboration stay literal',()=>{for(const [parts,other] of [[['two-','step'],['twostep','two-step']],[['simi-','lar'],['similar','simi-lar']],[['gene2-','alpha'],['gene2alpha']],[['αsimi-','lar'],['similar']],[['ABC-','def'],['ABCdef']],[['simi−','lar'],['similar']],[['simi-','lar'],['unrelated']]]) assert.equal(run(model(parts,other)).length,0,JSON.stringify(parts));});
test('explicit spaces and recovered spacing prevent joining',()=>{for(const parts of [['simi- ','lar'],['simi-',' lar']]) assert.equal(run(model(parts)).length,0); const d=model(['simi-','lar']);d.blocks[0].source.wordSpaceOffsets=[5];assert.equal(run(d).length,0);});
test('unsupported geometry, incomplete characters, source frames and stale hashes fail closed',()=>{for(const change of [d=>d.blocks[0].source.lines[0].direction=[0,1],d=>d.blocks[0].source.lines[1].baseline=null,d=>d.blocks[0].source.characters[0].bbox=null,d=>d.pages[0].geometry.frame='unknown',d=>d.pages[0].geometry.pageTransform=[0,1,1,0,0,0],d=>d.pages[0].text='wrong',d=>d.blocks[0].source.lines[1].range.start++]) {const d=model(['simi-','lar']);change(d);assert.equal(run(d).length,0);} assert.throws(()=>findSourceWrapOmissions({document:model(['simi-','lar']),bytes:new Uint8Array([1])}),{code:'stale-source'});});
