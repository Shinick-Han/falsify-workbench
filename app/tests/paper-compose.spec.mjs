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


test('source-to-logical edit mapping keeps boundaries and literal neighbors',async()=>{
 const cases=[
  ['helloworld',[5],5,10,'earth','hello earth'],
  ['helloworld',[5],0,5,'hi','hi world'],
  ['helloworld',[5],3,7,'X','helXrld'],
  ['helloworld',[5],5,10,'','hello '],
  ['hello world',[5],6,11,'earth','hello earth'],
  ['hard-repeat',[5],5,11,'word','hard-word'],
  ['hard-repeat',[5],0,5,'soft-','soft-repeat'],
  ['−12',[1],1,3,'34','−34'],
 ];
 for(const [raw,bounds,start,end,after,expected] of cases){
  const d=make(); const points=[0,...bounds,raw.length];
  d.blocks=[{id:'x',text:raw,source:{pageIndex:0,range:{start:0,end:raw.length},lines:points.slice(1).map((end,i)=>({range:{start:points[i],end}}))}}];
  const original=structuredClone(d); let captured, checkedText;
  const out=await composeDocument({document:d,sourceBytes:src,edits:[{blockId:'x',pageIndex:0,start,end,before:raw.slice(start,end),after}]},{compile:async p=>(captured=p.source,pdf),outputCheck:async ({expectedBlocks})=>{checkedText=expectedBlocks[0].text;return {checks:{content:{status:'pass'}},findings:[]}}});
  assert.equal(checkedText,expected); assert.ok(captured.includes(typstString(expected)),raw); assert.deepEqual(d,original); assert.equal(out.verification.contentVerified, !out.verification.ambiguousBoundaries.length);
 }
});

test('signed numeric boundaries preserve independent literal expectations',async()=>{
 for(const [raw,cut,expected] of [['−12',1,'−12'],['-12',1,'-12'],['hard-repeat',5,'hard-repeat'],['helloWorld',5,'hello World']]){
  const d=make();d.blocks=[{id:'x',text:raw,source:{pageIndex:0,range:{start:0,end:raw.length},lines:[{range:{start:0,end:cut}},{range:{start:cut,end:raw.length}}]}}];
  let checkedText;
  await composeDocument({document:d,sourceBytes:src},{compile:async ({source})=>{assert.ok(source.includes(typstString(expected)));return pdf},outputCheck:async ({expectedBlocks})=>{checkedText=expectedBlocks[0].text;return {checks:{content:{status:'pass'}},findings:[]}}});
  assert.equal(checkedText,expected);
 }
});

test('Buffer snapshots own source, compiler result and checker bytes',async()=>{
 const input=Buffer.from(src), bytes=Buffer.from(pdf), inputOriginal=Buffer.from(input), bytesOriginal=Buffer.from(bytes), d=make(); let release, checkedSnapshot;
 const gate=new Promise(r=>release=r);
 const pending=composeDocument({document:d,sourceBytes:input},{fonts:{hasGlyph:async()=>{await gate;return true}},compile:async()=>bytes,outputCheck:async ({bytes:checked})=>{checkedSnapshot=new Uint8Array(checked);checked.fill(1);bytes.fill(2);return {checks:{content:{status:'pass'}},findings:[]}}});
 input.fill(3);release(); const out=await pending;
 assert.deepEqual(checkedSnapshot,new Uint8Array(bytesOriginal)); assert.equal(out.verification.sourceSha256,sha(inputOriginal)); assert.equal(out.sha256,sha(bytesOriginal));
 const fileBytes=new Uint8Array(await out.file.arrayBuffer());assert.deepEqual(fileBytes,new Uint8Array(bytesOriginal));assert.equal(sha(fileBytes),out.sha256);
 assert.deepEqual(input,Buffer.alloc(input.length,3));assert.deepEqual(bytes,Buffer.alloc(bytes.length,2));
});

test('worker settles and cleans handlers on each completion path',async()=>{
 for(const mode of ['throw','messageerror','error','success','abort']){
  const c=new AbortController();let terminated=0, removes=0;const originalRemove=c.signal.removeEventListener.bind(c.signal);c.signal.removeEventListener=(...args)=>{removes++;return originalRemove(...args)};
  const w={terminate(){terminated++},postMessage(){if(mode==='throw')throw new DOMException('clone error','DataCloneError');if(mode==='messageerror')this.onmessageerror({});if(mode==='error')this.onerror({message:'failed'});if(mode==='success')this.onmessage({data:{bytes:pdf}});if(mode==='abort')c.abort()}};
  const pending=compileInWorker(w,{},c.signal);
  if(mode==='success') assert.equal(await pending,pdf);else await assert.rejects(pending);
  c.abort();assert.equal(terminated,1,mode);assert.equal(removes,1,mode);assert.equal(w.onmessage,null);assert.equal(w.onerror,null);assert.equal(w.onmessageerror,null);
 }
});

test('ambiguous line break cannot claim content verification from a guessed separator',async()=>{
 const d=make();d.blocks=[{id:'x',text:'helloworld',source:{pageIndex:0,range:{start:0,end:10},lines:[{range:{start:0,end:5}},{range:{start:5,end:10}}]}}];
 let checkedText;
 const out=await composeDocument({document:d,sourceBytes:src},{compile:async()=>pdf,outputCheck:async ({expectedBlocks})=>{checkedText=expectedBlocks[0].text;return {checks:{content:{status:'pass'}},findings:[]}}});
 assert.equal(checkedText,'hello world');assert.equal(out.verification.contentVerified,false);assert.equal(out.verification.outputTextCheck,'pass');assert.deepEqual(out.verification.ambiguousBoundaries,[{blockId:'x',offset:5}]);
});

test('ordered flow carries mixed styles, long edit and image bytes without mutating inputs',async()=>{
 const d=make();d.styles=[{id:'small',size:9},{id:'large',size:18}];d.blocks[0].source.characters=[{start:0,end:6,styleId:'large'},{start:6,end:26,styleId:'small'}];
 const long='After −12 [1] '.repeat(1000); const png=new Uint8Array([137,80,78,71]);
 const flow={schema:'falsify.paper-flow.v1',sourceSha256:d.sourceSha256,items:[{kind:'heading',columns:1,span:'page',blockIds:['a']},{kind:'asset',columns:2,assetIds:['pic']},{kind:'caption',columns:2,blockIds:['b']}]};
 const assets=[{id:'pic',content:{representation:'png',bytes:png}}]; const snapshot=structuredClone({d,flow,assets});let payload;
 await composeDocument({document:d,sourceBytes:src,flow,assets,edits:[{...edit,after:long}]},{compile:async p=>(payload=p,pdf)});
 assert.ok(payload.source.indexOf('18pt')<payload.source.indexOf('#image('));assert.ok(payload.source.indexOf('#image(')<payload.source.indexOf(typstString(long)));assert.deepEqual(payload.files['assets/0.png'],png);assert.deepEqual({d,flow,assets},snapshot);
});

test('font coverage ignores layout controls',async()=>{const {inspectFonts}=await import('../src/paper-fonts.mjs');const result=await inspectFonts('a\t\n\r',{hasGlyph:cp=>cp===97});assert.equal(result.status,'covered');});
