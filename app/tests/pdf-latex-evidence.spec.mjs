import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as mupdf from 'mupdf';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {extractReconstructionEvidence,buildReconstructionModel} from '../src/pdf-latex-evidence.mjs';

function synthetic(){
  const d=new mupdf.PDFDocument(),font=d.addSimpleFont(new mupdf.Font('Helvetica'));
  const line=(s,y)=>`BT /F 11 Tf 30 ${y} Td (${s}) Tj ET\n`;
  const stream=line('Group A: 42 participants.',350)+line('Group B: 42 participants.',320)+line('Group A: 43 participants.',290);
  d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font}},stream));
  const buffer=d.saveToBuffer(),bytes=buffer.asUint8Array().slice();buffer.destroy();d.destroy();return bytes;
}
const extract=bytes=>extractReconstructionEvidence({bytes,sourceSha256:hex(bytes)});
test('actual PDF observations are deterministic, immutable and preserve contradictions and every occurrence',async()=>{
  const bytes=synthetic(),copy=bytes.slice(),a=await extract(bytes),b=await extract(bytes);
  assert.deepEqual(bytes,copy);assert.deepEqual(a,b);
  const model=buildReconstructionModel(a);assert.deepEqual(model,buildReconstructionModel(b));
  const text=model.items.map(i=>i.text||'').join(' ');
  assert.match(text,/Group A: 42 participants/);assert.match(text,/Group B: 42 participants/);assert.match(text,/Group A: 43 participants/);
  const segments=model.items.flatMap(i=>i.extensions.segments);
  for(const s of segments){const e=s.evidence;assert.equal(a.document.pages[e.pageIndex].text.slice(e.range.start,e.range.end),s.text);}
  assert.equal(segments.reduce((n,s)=>n+s.text.length,0),a.document.pages[0].text.length);
  assert.equal(new Set(model.items.map(i=>i.id)).size,model.items.length);
});
test('mixed scripts, image ownership, and caption remain separate source evidence',async()=>{
  const bytes=new Uint8Array(await readFile(new URL('./fixtures/paragraph-marker-synthetic.pdf',import.meta.url))),input=await extract(bytes),model=buildReconstructionModel(input);
  const sentence=model.items.find(i=>i.text?.includes('An initial claim62'));
  assert.equal(sentence.reason,'inline-script-candidate');assert.ok(sentence.extensions.candidates.some(c=>c.kind==='script'));
  assert.ok(sentence.extensions.candidates.some(c=>c.kind==='citation'));
  assert.ok(model.items.some(i=>i.kind==='figure'&&i.status==='unsupported'));
  const segments=model.items.flatMap(i=>i.extensions.segments),ids=segments.flatMap(s=>[s.evidence.blockId+':'+s.evidence.range.start+':'+s.evidence.range.end]);
  assert.equal(ids.length,new Set(ids).size);
  assert.ok(model.items.some(i=>i.text?.includes('Figure 1: Synthetic unchanged figure.')));
  assert.ok(model.pages.every(p=>p.frame==='mupdf-display'&&p.transform.length===6));
});
test('invalid hash, cancellation, frame, tampered ranges and duplicated ownership fail closed',async()=>{
  const bytes=synthetic();await assert.rejects(extractReconstructionEvidence({bytes,sourceSha256:'0'.repeat(64)}),{code:'stale-source'});
  const c=new AbortController();c.abort();await assert.rejects(extractReconstructionEvidence({bytes,sourceSha256:hex(bytes),signal:c.signal}),{name:'AbortError'});
  const a=await extract(bytes),bad=structuredClone(a);bad.document.pages[0].geometry.frame='unknown';assert.throws(()=>buildReconstructionModel(bad),{code:'invalid-page-frame'});
  const stale=structuredClone(a);stale.flow.sourceSha256='0'.repeat(64);assert.throws(()=>buildReconstructionModel(stale),{code:'stale-evidence'});
  const range=structuredClone(a);range.document.blocks.find(b=>b.text).text+='X';assert.throws(()=>buildReconstructionModel(range),{code:'invalid-evidence'});
  const dup=structuredClone(a);dup.flow.items.push({...structuredClone(dup.flow.items[0]),id:'duplicate'});assert.throws(()=>buildReconstructionModel(dup),{code:'ambiguous-provenance'});
});

test('page budget is enforced before native extraction and cancellation is observed between pages',async()=>{
  const d=new mupdf.PDFDocument();
  for(let i=0;i<101;i++)d.insertPage(-1,d.addPage([0,0,100,100],0,{},''));
  const buffer=d.saveToBuffer(),bytes=buffer.asUint8Array().slice();buffer.destroy();d.destroy();
  await assert.rejects(extract(bytes),{code:'budget-exceeded'});
  const d2=new mupdf.PDFDocument();for(let i=0;i<5;i++)d2.insertPage(-1,d2.addPage([0,0,100,100],0,{},''));
  const b=d2.saveToBuffer(),short=b.asUint8Array().slice();b.destroy();d2.destroy();
  const controller=new AbortController(),pending=extractReconstructionEvidence({bytes:short,sourceSha256:hex(short),signal:controller.signal});
  setTimeout(()=>controller.abort(),0);await assert.rejects(pending,{name:'AbortError'});
});

// A 36-page model exercises thousands of independently owned source ranges;
// its geometry and text are synthetic and it is not a substitute for PDF parsing.
function largeEvidence(pageCount=36,perPage=56,textWidth=72){
  const hash='a'.repeat(64),pages=[],blocks=[],items=[],frames=[];
  for(let pageIndex=0;pageIndex<pageCount;pageIndex++){
    let text='';const geometry={frame:'mupdf-display',bounds:[0,0,612,792],pageTransform:[1,0,0,-1,0,792]};
    for(let i=0;i<perPage;i++){
      const value=textWidth===1?'x':`Page ${pageIndex} block ${i} value 42. `.padEnd(textWidth,'x'),start=text.length; text+=value;
      const id=`b-${pageIndex}-${i}`,bbox=[20,20+i*10,400,29+i*10],source={pageIndex,bbox,range:{start,end:text.length},characters:[],lines:[]};
      blocks.push({id,text:value,source});items.push({id:`f-${pageIndex}-${i}`,kind:'paragraph',blockIds:[id],assetIds:[],source:{pageIndex,bbox},columns:1,span:'page'});
    }
    pages.push({sourcePageIndex:pageIndex,width:612,height:792,text,geometry});frames.push({pageIndex,bounds:geometry.bounds,pageTransform:geometry.pageTransform,verified:true});
  }
  return {document:{schema:'falsify.paper-document.v1',sourceSha256:hash,pages,blocks,assets:[],styles:[],diagnostics:[]},flow:{schema:'falsify.paper-flow.v1',sourceSha256:hash,items,fragments:[],regions:[],relations:[],diagnostics:[]},links:{schema:'falsify.paper-source-links.v1',sourceSha256:hash,frames,links:[]},assets:{sourceSha256:hash,assets:[],diagnostics:[]}};
}
test('36-page evidence keeps all 2016 blocks and exact text within finite budgets',()=>{
  const evidence=largeEvidence(),model=buildReconstructionModel(evidence);
  assert.equal(model.items.length,2016);
  assert.equal(model.items.reduce((n,item)=>n+item.text.length,0),36*56*72);
  assert.equal(new Set(model.items.map(item=>item.id)).size,2016);
  const limit=largeEvidence(1,8000,1);assert.equal(buildReconstructionModel(limit).items.length,8000);
  const exceeded=largeEvidence(1,8001,1);assert.throws(()=>buildReconstructionModel(exceeded),{code:'budget-exceeded'});
});
test('indexed range ownership still rejects overlapping fragments and missing source text',async()=>{
  const evidence=await extract(synthetic()),item=evidence.flow.items.find(x=>x.blockIds.length===1&&evidence.document.blocks.find(b=>b.id===x.blockIds[0]&&b.text));
  const missing=structuredClone(evidence);missing.flow.items=missing.flow.items.filter(x=>x.id!==item.id);assert.throws(()=>buildReconstructionModel(missing),{code:'uncovered-source-text'});
  const overlap=structuredClone(evidence),parent=overlap.document.blocks.find(b=>b.id===item.blockIds[0]),r=parent.source.range;
  const fragment={...structuredClone(parent),id:'overlap-fragment',parentBlockId:parent.id,source:{...structuredClone(parent.source),range:{...r}}};
  overlap.flow.fragments.push(fragment);overlap.flow.items.push({...structuredClone(item),id:'overlap-flow',blockIds:[fragment.id]});
  assert.throws(()=>buildReconstructionModel(overlap),{code:'ambiguous-provenance'});
});

test('drawing observation budget remains finite',async()=>{
  const d=new mupdf.PDFDocument(),stream='1 w\n'+'0 0 m 20 20 l S\n'.repeat(50001);
  d.insertPage(-1,d.addPage([0,0,100,100],0,{},stream));const b=d.saveToBuffer(),bytes=b.asUint8Array().slice();b.destroy();d.destroy();
  await assert.rejects(extract(bytes),{code:'budget-exceeded'});
});
