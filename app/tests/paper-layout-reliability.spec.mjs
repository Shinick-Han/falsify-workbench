import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatexProject} from '../src/latex-project.mjs';
import {createLayoutToolHandlers} from '../src/paper-layout-toolbox.mjs';
import {createLayoutPreviewController} from '../src/paper-layout-preview.mjs';
import {layoutStepDecision} from '../src/paper-layout-transport.mjs';
import {createLatexDraftStore} from '../src/latex-draft-store.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
const enc=new TextEncoder(),HASH='a'.repeat(64);
const request={schema:'falsify.paper-layout-agent-step.v1',consent:true,projectId:HASH,step:0,maxSteps:8};
const response={schema:'falsify.paper-layout-agent-action.v1',projectId:HASH,step:0,action:{tool:'finish',args:{},message:'끝'}};
const receipt=(state='completed',extra={})=>({schema:'falsify.layout-step-receipt.v1',runId:'r1',stepId:'r1-s0',fingerprint:HASH,state,result:response,...extra});

test('typed handler adapters keep a previously observed target after editing another paragraph',async()=>{
 const project=await createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('\\documentclass{article}\n\\begin{document}\nFirst RED 71 paragraph.\n\nSecond original paragraph.\n\\end{document}')}]});
 const handlers=createLayoutToolHandlers({project});const read=await handlers.inspect_document({project,args:{}}),items=read.observation.blocks.items;
 const a=items.find(b=>b.textPreview.includes('First RED')),b=items.find(b=>b.textPreview.includes('Second original'));assert.ok(b.id.startsWith('lt1_'));
 const updated=await handlers.update_layout({project,args:{blockId:a.id,gapBeforeBp:4}});
 const found=await handlers.get_block({project:updated.project,args:{blockId:b.id}});assert.equal(found.observation.block.id,b.id);assert.match(found.observation.block.text,/Second original/);
 const restored=createLayoutToolHandlers({project:updated.project,targetMetadata:handlers.getTargetMetadata()});assert.equal((await restored.get_block({project:updated.project,args:{blockId:b.id}})).observation.block.id,b.id);
});

test('step transport posts once, then polls matching receipts and returns the selected action',async()=>{
 const calls=[],saved=[];let reads=0;const link={request:async(path,body)=>{calls.push({path,body});return body?receipt('running'):receipt(++reads===1?'running':'completed');}};
 const out=await layoutStepDecision(link,request,{runId:'r1',pollMs:0,onPending:p=>saved.push(p)});assert.equal(out.response.action.tool,'finish');assert.equal(calls.filter(c=>c.body).length,1);assert.equal(calls.filter(c=>!c.body).length,2);assert.equal(saved.at(-1).state,'completed');
});

test('unknown POST is recovered by GET only and wrong fingerprint is refused',async()=>{
 let saved;await assert.rejects(layoutStepDecision({request:async()=>{throw Error('network');}},request,{runId:'r1',onPending:p=>{saved=p;}}),/network/);
 const calls=[];await layoutStepDecision({request:async(path,body)=>{calls.push(body);return receipt();}},request,{runId:'r2',pendingStep:saved,pollMs:0});assert.deepEqual(calls,[null]);
 await assert.rejects(layoutStepDecision({request:async()=>receipt()},request,{runId:'r2',pendingStep:{...saved,fingerprint:'b'.repeat(64)}}),/저장한 요청/);
 await assert.rejects(layoutStepDecision({request:async()=>receipt()},request,{runId:'r2',pendingStep:{...saved,companionInstance:'old'},companionInstance:'new'}),/이전 companion/);
});

test('failed receipt has a disposition and never triggers a second submission',async()=>{
 let calls=0;await assert.rejects(layoutStepDecision({request:async()=>{calls++;return receipt('failed',{error:{message:'모델 실행 실패'}});}},request,{runId:'r1'}),e=>e.disposition==='failed');assert.equal(calls,1);
});

test('content correspondence follows text onto another page and retains ambiguity',async()=>{
 const passage='The complete experimental evidence describes the selected intervention and its exact numerical outcomes for all enrolled participants.';
 const texts={original:['Different unrelated introductory material about another experiment entirely.',passage],candidate:[passage]};
 const input=name=>{const pdfBytes=enc.encode('%PDF-'+name);return {pdfBytes,pdfHash:hex(pdfBytes)};};
 const viewer=createLayoutPreviewController({loadPdf:bytes=>{const name=new TextDecoder().decode(bytes).slice(5);return {promise:Promise.resolve({numPages:texts[name].length,getPage:async n=>({getTextContent:async()=>({items:[{str:texts[name][n-1]}]})})}),destroy(){}};}});
 await viewer.setDocuments({original:input('original'),candidate:input('candidate')});assert.deepEqual((await viewer.findCorrespondingPage({from:'candidate',pageIndex:0})).pageIndex,1);
 texts.original[0]=passage;const duplicate={pdfBytes:enc.encode('%PDF-duplicate'),pdfHash:hex(enc.encode('%PDF-duplicate'))};texts.duplicate=[passage,passage];await viewer.setDocuments({original:duplicate,candidate:input('candidate')});assert.equal((await viewer.findCorrespondingPage({from:'candidate',pageIndex:0})).status,'ambiguous');viewer.dispose();
});

test('source draft storage keeps work in memory on unavailable IDB, respects consent and expiry',async()=>{
 let now=100;const store=createLatexDraftStore({indexedDB:null,now:()=>now});assert.equal((await store.put('private',{consent:false})).persisted,false);assert.equal(await store.get(),null);
 const saved=await store.put('source + candidate',{consent:true});assert.equal(saved.persisted,false);assert.equal((await store.get()).archive,'source + candidate');now+=12*60*60*1000;assert.equal(await store.get(),null);await store.put('later',{consent:true});await store.clear();assert.equal(await store.get(),null);store.dispose();
});
