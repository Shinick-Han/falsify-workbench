'use strict';
// Panels stay unavailable without paperTools, and the visual editor uses /v1/ai/paper when it is on.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);

const root=fileURLToPath(new URL('..',import.meta.url));
const read=(name)=>readFileSync(new URL(name,import.meta.url),'utf8');
const indexHtml=read('../dist/index.html');
const blueSource=read('../dist/document-blue.js');
const integrationSource=read('../dist/paper-visual-integration.js');
if(typeof URL.createObjectURL!=='function'){
  URL.createObjectURL=()=>'blob:hosted-paper/1';
  URL.revokeObjectURL=()=>{};
}

globalThis.FalsifyHostedAI={
  paperTools:null,
  async paperAuth(){return {apiBase:'https://paper.test',token:'fsg_'+'c'.repeat(43)};}
};
globalThis.FalsifyHostedAi=globalThis.FalsifyHostedAI;
globalThis.FalsifyLocalBridge={
  state:()=>({connected:false}),
  session:()=>null,
  capabilities:()=>null
};
const fetched=[];
globalThis.fetch=async(url,init={})=>{
  const record={url:String(url),init};
  fetched.push(record);
  const body=JSON.parse(init.body);
  if(body.path==='/api/paper/evidence/prepare'&&globalThis.prepareStatus) return jsonResponse(globalThis.prepareStatus);
  return jsonResponse(answer(body));
};
function jsonResponse(body,status=200){
  return {ok:status>=200&&status<300,status,redirected:false,type:'basic',json:async()=>body,text:async()=>JSON.stringify(body)};
}
const PDF=Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
let HASH='';
function answer(body){
  if(body.path==='/api/paper/evidence/prepare'){
    return {schema:'falsify.paper-evidence.v1',paperId:'paper-visual',fileHash:body.body.fileHash,status:'ready',pageCount:2,
      counts:{tables:1,figures:0},engine:'test',limitations:[],expiresAt:new Date(Date.now()+3600000).toISOString()};
  }
  if(body.path==='/api/paper/evidence/query'&&body.body.operation==='list'){
    return {paperId:'paper-visual',fileHash:HASH,items:[{id:'t1',type:'table',pageIndex:0,bbox:[1,2,40,50],caption:'표 하나'}],total:1,nextOffset:null};
  }
  if(body.path==='/api/paper/evidence/query'&&body.body.operation==='analyses') return {paperId:'paper-visual',fileHash:HASH,items:[]};
  if(body.path==='/api/paper/evidence/query'&&body.body.operation==='item'){
    return {id:'t1',type:'table',paperId:'paper-visual',fileHash:HASH,pageIndex:0,bbox:[1,2,40,50],caption:'표 하나',
      table:{rows:1,columns:1,cells:[{row:0,column:0,rowSpan:1,columnSpan:1,text:'A',bbox:[1,2,10,12]}]}};
  }
  if(body.path==='/api/paper/visual/export'){
    const bytes=Buffer.concat([PDF,Buffer.from('\n%ok\n')]);
    return {schema:'falsify.visual-edit-export.v1',sourceSha256:HASH,outputSha256:'',file:'',pageCount:1,
      changes:[{id:'srv',kind:'table-cell',pageIndex:0,bbox:[1,2,11,12],before:'A',after:'B',author:'human'}],
      verification:{status:'passed',issues:[]},bytes};
  }
  return {ok:false};
}

require('../dist/hosted-paper-session.js');
require('../dist/paper-visual-integration.js');
const UI=require('../dist/paper-visual-edit-ui.js');
const integration=globalThis.FalsifyPaperVisualIntegration;

function element(tag){
  const el=new EventTarget(),classes=new Set(),attrs={};
  el.tagName=tag.toUpperCase();
  el.children=[];
  el.hidden=false;
  el.disabled=false;
  el.value='';
  el.type='';
  el._text='';
  el.style={};
  el.classList={
    add(...xs){for(const x of xs)classes.add(x);},
    remove(...xs){for(const x of xs)classes.delete(x);},
    contains:x=>classes.has(x),
    toggle(x,on){const v=on==null?!classes.has(x):!!on;if(v)classes.add(x);else classes.delete(x);return v;}
  };
  Object.defineProperty(el,'className',{get(){return [...classes].join(' ');},set(v){classes.clear();for(const x of String(v||'').split(/\s+/))if(x)classes.add(x);}});
  Object.defineProperty(el,'textContent',{get(){return el._text;},set(v){el._text=v==null?'':String(v);el.children=[];}});
  el.setAttribute=(k,v)=>{attrs[k]=String(v);};
  el.getAttribute=k=>Object.hasOwn(attrs,k)?attrs[k]:null;
  el.removeAttribute=k=>{delete attrs[k];};
  el.append=(...nodes)=>{el.children.push(...nodes);};
  el.replaceChildren=(...nodes)=>{el.children=nodes;};
  el.focus=()=>{};
  el.querySelectorAll=()=>[];
  el.click=()=>{if(!el.disabled)el.dispatchEvent(new Event('click'));};
  return el;
}
let tail=Promise.resolve();
function serial(name,fn){
  test(name,async()=>{
    const run=tail.then(fn,fn);
    tail=run.then(()=>{},()=>{});
    return run;
  });
}
function all(node){
  const out=[];
  (function walk(n){for(const child of n.children||[]){if(child?.tagName)out.push(child);if(child)walk(child);}})(node);
  return out;
}
function fileOf(bytes){
  const copy=Uint8Array.from(bytes);
  return {name:'t.pdf',size:copy.length,type:'application/pdf',arrayBuffer:async()=>copy.slice().buffer};
}
async function sha256(bytes){
  return Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
}
function postedBodies(){
  return fetched.map(call=>({url:call.url,body:JSON.parse(call.init.body),auth:call.init.headers.Authorization}));
}

test('the page and BLUE panel use the shared paper session',()=>{
  assert.ok(indexHtml.indexOf('hosted-paper-session.js')<indexHtml.indexOf('paper-visual-integration.js'));
  assert.match(integrationSource,/getSession:\(\)=>paperSession\(\)/);
  assert.match(integrationSource,/getCapabilities:\(\)=>paperCapabilities\(\)/);
  assert.match(blueSource,/getSession:panelSession/);
  assert.match(blueSource,/getCapabilities:panelCapabilities/);
  assert.doesNotMatch(read('../dist/paper-workspace.js'),/FalsifyHostedPaperSession/);
});

serial('without paperTools the visual editor still asks for the PC',async()=>{
  HASH=await sha256(PDF);
  globalThis.FalsifyHostedAI.paperTools=null;
  globalThis.FalsifyLocalBridge={state:()=>({connected:false}),session:()=>null,capabilities:()=>null};
  const before=fetched.length;
  const host=element('div');
  host.ownerDocument={createElement:tag=>element(tag),addEventListener(){}};
  const ui=UI.create({host,getSource:()=>({file:fileOf(PDF),fileHash:HASH,revision:'r1'}),getSession:()=>integration.paperSession(),onOutput(){}});
  await ui.refresh();
  const status=all(host).find(el=>el.getAttribute('aria-live')==='polite');
  assert.equal(status.textContent,'PC 연결 후 다시 시도하세요.');
  assert.equal(fetched.length,before);
  assert.equal(integration.paperUsesHosted(),false);
});

serial('paperTools routes prepare, query, and export through /v1/ai/paper',async()=>{
  HASH=await sha256(PDF);
  globalThis.prepareStatus=null;
  globalThis.FalsifyHostedAI.paperTools={enabled:true};
  globalThis.FalsifyLocalBridge={state:()=>({connected:false}),session:()=>null,capabilities:()=>null};
  fetched.length=0;
  const host=element('div');
  const doc=new EventTarget();
  doc.createElement=tag=>element(tag);
  host.ownerDocument=doc;
  const source={file:fileOf(PDF),fileHash:HASH,revision:'r1'};
  const outputs=[];
  const ui=UI.create({
    host,
    getSource:()=>source,
    getSession:()=>integration.paperSession(),
    onOutput:payload=>outputs.push(payload)
  });
  const connect=all(host).find(el=>el.tagName==='BUTTON'&&(el.textContent==='내 PC 연결'||el.textContent==='웹 실행 다시 시도'));
  assert.equal(connect.textContent,'웹 실행 다시 시도');
  assert.equal(connect.hidden,true);
  await ui.refresh();
  const paths=postedBodies().map(call=>call.body.path);
  assert.ok(paths.includes('/api/paper/evidence/prepare'));
  assert.ok(paths.includes('/api/paper/evidence/query'));
  assert.equal(postedBodies().every(call=>call.url==='https://paper.test/v1/ai/paper'),true);
  assert.equal(postedBodies().every(call=>call.auth==='Bearer '+'fsg_'+'c'.repeat(43)),true);
  const radio=all(host).find(el=>el.tagName==='INPUT'&&el.value==='item:t1');
  radio.checked=true;
  radio.dispatchEvent(new Event('change'));
  for(let i=0;i<50&&!all(host).some(el=>el.getAttribute('aria-label')==='행 1 열 1');i++) await new Promise(resolve=>setTimeout(resolve,10));
  const input=all(host).find(el=>el.getAttribute('aria-label')==='행 1 열 1');
  assert.ok(input,'cell');
  input.value='Z';
  input.dispatchEvent(new Event('input'));
  const exportBody=postedBodies().find(call=>call.body.path==='/api/paper/visual/export');
  assert.equal(exportBody,undefined);
  const original=answer;
  globalThis.fetch=async(url,init={})=>{
    const record={url:String(url),init};
    fetched.push(record);
    const body=JSON.parse(init.body);
    if(body.path!=='/api/paper/visual/export') return jsonResponse(answer(body));
    const bytes=Buffer.concat([PDF,Buffer.from('\n%ok\n')]);
    const outputSha=await sha256(bytes);
    return jsonResponse({schema:'falsify.visual-edit-export.v1',sourceSha256:HASH,outputSha256:outputSha,file:bytes.toString('base64'),pageCount:1,
      changes:[{id:'srv',kind:'table-cell',pageIndex:0,bbox:[1,2,11,12],before:'A',after:'Z',author:'human'}],verification:{status:'passed',issues:[]}});
  };
  all(host).find(el=>el.tagName==='BUTTON'&&el.textContent==='PDF에 적용').click();
  for(let i=0;i<80&&!postedBodies().some(call=>call.body.path==='/api/paper/visual/export');i++) await new Promise(resolve=>setTimeout(resolve,10));
  const exported=postedBodies().find(call=>call.body.path==='/api/paper/visual/export');
  assert.equal(exported.url,'https://paper.test/v1/ai/paper');
  assert.equal(exported.body.body.schema,'falsify.visual-edit-request.v1');
  assert.equal(exported.body.body.operations[0].kind,'table-cell');
  assert.equal(exported.body.body.operations[0].after,'Z');
  void original;
});

serial('a hosted failure uses the web-server copy and the prepare cache splits local from hosted',async()=>{
  HASH=await sha256(PDF);
  const bytes=Uint8Array.from(PDF);
  const file={name:'t.pdf',size:bytes.length,type:'application/pdf',arrayBuffer:async()=>bytes.slice().buffer};
  const localCalls=[];
  globalThis.FalsifyLocalBridge={
    state:()=>({connected:true,cap:{companionInstance:'pc-1'}}),
    session:()=>({request:async(path,body)=>{localCalls.push({path,body});return {fileHash:body.fileHash,paperId:'local-paper'};}}),
    capabilities:()=>({companionInstance:'pc-1',paperEnrichment:{supported:true,runtimeConfigured:true}})
  };
  globalThis.FalsifyHostedAI.paperTools={enabled:true};
  const seen={};
  const previousEditor=globalThis.FalsifyVisualEditUI;
  const previousEnrichment=globalThis.FalsifyPaperEnrichmentUI;
  globalThis.FalsifyVisualEditUI={create(options){seen.editor=options;return {setBusy(){},clear(){},refresh(){},snapshot:()=>({})};}};
  globalThis.FalsifyPaperEnrichmentUI={create(options){seen.enrichment=options;return {setBusy(){},clear(){}};}};
  const nodes={};
  const document=new EventTarget();
  document.readyState='complete';
  document.getElementById=id=>nodes[id]||null;
  document.createElement=()=>Object.assign(new EventTarget(),{append(){},click(){},remove(){},hidden:true,className:''});
  document.querySelectorAll=()=>[];
  for(const id of ['red-visual-edit-host','red-visual-section','red-visual-analysis','red-visual-record-status']) nodes[id]={hidden:false,textContent:'',append(){}};
  globalThis.document=document;
  globalThis.FalsifyPaperWorkspace={getSource:()=>({file,fileHash:HASH,segments:[]}),getCurrentOutput:()=>null,getEditSnapshot:()=>({revision:0,edits:[]}),getPageIndex:()=>0};
  const mounted=integration.mount();
  assert.equal(integration.paperUsesHosted(),false);
  await seen.enrichment.preparePaper();
  await seen.enrichment.preparePaper();
  assert.equal(localCalls.length,1,'the local prepare is cached');
  globalThis.FalsifyLocalBridge={state:()=>({connected:false}),session:()=>null,capabilities:()=>null};
  document.dispatchEvent(new Event('falsify:local-bridge'));
  fetched.length=0;
  await seen.enrichment.preparePaper();
  await seen.enrichment.preparePaper();
  const prepares=postedBodies().filter(call=>call.body.path==='/api/paper/evidence/prepare');
  assert.equal(prepares.length,1,'the hosted prepare uses a different cache key');
  assert.equal(prepares[0].url,'https://paper.test/v1/ai/paper');
  document.dispatchEvent(new Event('falsify:hosted-paper'));
  await seen.enrichment.preparePaper();
  assert.equal(postedBodies().filter(call=>call.body.path==='/api/paper/evidence/prepare').length,2);
  globalThis.FalsifyVisualEditUI=previousEditor;
  globalThis.FalsifyPaperEnrichmentUI=previousEnrichment;
  void mounted;
});

serial('a hosted 401 is the web-server message',async()=>{
  HASH=await sha256(PDF);
  globalThis.FalsifyHostedAI.paperTools={enabled:true};
  globalThis.FalsifyLocalBridge={state:()=>({connected:false}),session:()=>null,capabilities:()=>null};
  globalThis.fetch=async()=>jsonResponse({error:{code:'unauthorized'}},401);
  const host=element('div');
  host.ownerDocument={createElement:tag=>element(tag),addEventListener(){}};
  const ui=UI.create({host,getSource:()=>({file:fileOf(PDF),fileHash:HASH,revision:'r1'}),getSession:()=>integration.paperSession(),onOutput(){}});
  await ui.refresh();
  const status=all(host).find(el=>el.getAttribute('aria-live')==='polite');
  assert.equal(status.textContent,'웹 실행 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.');
});
