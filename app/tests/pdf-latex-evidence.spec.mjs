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
