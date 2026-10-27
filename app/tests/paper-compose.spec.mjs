import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {File} from 'node:buffer';
import {composeDocument,typstString} from '../src/paper-compose.mjs';
import {compileInWorker} from '../src/paper-compose-worker.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;
const src=new TextEncoder().encode('source'); const sha=b=>createHash('sha256').update(b).digest('hex');
const make=()=>({schema:'falsify.paper-document.v1',sourceSha256:sha(src),pages:[{sourcePageIndex:0,width:400,height:600}],blocks:[{id:'a',text:'repeat hard-repeat −12 [1]',source:{pageIndex:0,range:{start:0,end:26},lines:[{range:{start:0,end:12}},{range:{start:12,end:26}}]}},{id:'b',text:'repeat',source:{pageIndex:0,range:{start:26,end:32},lines:[]}}],assets:[]});
const pdf=new TextEncoder().encode('%PDF-1.7\nactual bytes');
const edit={blockId:'b',pageIndex:0,start:26,end:32,before:'repeat',after:'changed'};
test('literal source, unique edits, line boundaries and immutable model',async()=>{const d=make(),original=structuredClone(d);let source;const malicious='#import "https://bad"\n\\" ] #panic() Ω';const out=await composeDocument({document:d,sourceBytes:src,edits:[{...edit,after:malicious}]},{compile:async p=>(source=p.source,pdf)});assert.deepEqual(d,original);assert.ok(source.includes(typstString(malicious)));assert.ok(source.includes(typstString('repeat hard-repeat −12 [1]')));assert.equal(out.sha256,sha(pdf));assert.deepEqual(new Uint8Array(await out.file.arrayBuffer()),pdf);assert.equal(out.verification.contentVerified,false);assert.equal(out.pageMap,null);assert.equal(out.blockMap,null);assert.equal(out.verification.coverage.status,'unavailable');});
test('rejects mismatched, duplicate and overlapping edit targets',async()=>{const d=make(),compile=async()=>pdf;for(const edits of [[{...edit,before:'wrong'}],[edit,edit],[{...edit,blockId:'missing'}]])await assert.rejects(composeDocument({document:d,sourceBytes:src,edits},{compile}));d.blocks.push({...d.blocks[1]});await assert.rejects(composeDocument({document:d,sourceBytes:src,edits:[edit]},{compile}));});
test('checks source hash and cancellation after async compile',async()=>{const d=make();await assert.rejects(composeDocument({document:d,sourceBytes:new Uint8Array([1])},{compile:async()=>pdf}),/hash/);const c=new AbortController();await assert.rejects(composeDocument({document:d,sourceBytes:src,signal:c.signal},{compile:async()=>{c.abort();return pdf;}}),{name:'AbortError'});});
test('coverage reports Omega and unsupported character without claiming preservation',async()=>{const d=make();d.blocks[1].text='Ω'+String.fromCodePoint(0x10ffff);d.blocks[1].source.range.end=29;const result=await composeDocument({document:d,sourceBytes:src},{compile:async()=>pdf,fonts:{hasGlyph:cp=>cp!==0x10ffff}});assert.deepEqual(result.verification.coverage.missing,[0x10ffff]);assert.equal(result.verification.contentVerified,false);});
test('worker abort terminates owned worker',async()=>{const c=new AbortController();let terminated=0;const w={postMessage(){c.abort();},terminate(){terminated++;}};await assert.rejects(compileInWorker(w,{},c.signal),{name:'AbortError'});assert.equal(terminated,1);});
test('figure with no source range is reported as unsupported rather than silently preserved',async()=>{const d=make();d.blocks.push({id:'fig',kind:'figure',text:'',source:{pageIndex:0},assetIds:['asset']});d.assets=[{id:'asset'}];const out=await composeDocument({document:d,sourceBytes:src},{compile:async()=>pdf});assert.match(out.warnings.join(' '),/not placed/);assert.equal(out.verification.contentVerified,false);});

 test('snapshots inputs and compiler bytes across awaits',async()=>{
 const d=make(), input=src.slice(), e={...edit}, bytes=pdf.slice(); let release;
 const gate=new Promise(r=>release=r); let captured;
 const pending=composeDocument({document:d,sourceBytes:input,edits:[e]},{fonts:{hasGlyph:async()=>{await gate; return true}},compile:async p=>{captured=p.source; return bytes},outputCheck:async ({bytes:checked,expectedBlocks})=>{bytes.fill(0); assert.equal(expectedBlocks[1].text,'changed'); assert.deepEqual(checked,pdf); return {checks:{content:{status:'pass'}},findings:[]}}});
 d.blocks[1].text='mutated'; d.pages[0].width=1; e.after='mutated'; input.fill(0); release();
 const result=await pending; assert.ok(captured.includes(typstString('changed'))); assert.equal(result.verification.edits[0].status,'bound'); assert.equal(result.sha256,sha(pdf)); assert.deepEqual(new Uint8Array(await result.file.arrayBuffer()),pdf); assert.equal(result.verification.contentVerified,true);
 });
 test('line boundaries retain hard hyphens, source whitespace and minus; selected After remains literal',async()=>{
 const d=make(); d.blocks=[{id:'x',text:'hard-repeat keep  space −12',source:{pageIndex:0,range:{start:0,end:27},lines:[{range:{start:0,end:5}},{range:{start:5,end:12}},{range:{start:12,end:17}},{range:{start:17,end:27}}]}}]; let captured;
 await composeDocument({document:d,sourceBytes:src,edits:[{blockId:'x',pageIndex:0,start:0,end:11,before:'hard-repeat',after:'new-word'}]},{compile:async p=>(captured=p.source,pdf)}); assert.ok(captured.includes(typstString('new-word keep  space −12')));
 });
 test('checker mismatch remains a finding and draft is downloadable',async()=>{const out=await composeDocument({document:make(),sourceBytes:src},{compile:async()=>pdf,outputCheck:async()=>({checks:{content:{status:'unavailable'}},findings:[{code:'content-mismatch'}]})});assert.equal(out.verification.outputTextCheck,'finding');assert.equal(out.verification.status,'finding');assert.equal(out.file.size,pdf.length);});
