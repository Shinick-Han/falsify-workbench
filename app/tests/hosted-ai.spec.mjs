'use strict';
// Focused Node regression for the hosted AI web client. Synthetic DOM, storage and fetch only.
// No browser, network, real account, provider call, private paper or answer key.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const source=await readFile(fileURLToPath(new URL('../dist/hosted-ai.js',import.meta.url)),'utf8');
const context=vm.createContext({console,URL,Event,setTimeout,clearTimeout,TextEncoder});
vm.runInContext(source,context,{filename:'hosted-ai.js'});
const api=context.FalsifyHostedAi;
const webcrypto=globalThis.crypto;
const SESSION_KEY='falsify.hosted-ai.session.v1';
const RUNS_KEY='falsify.hosted-ai.runs.v1';
const TOKEN='fss_'+'A'.repeat(43);
const FUTURE=new Date(Date.now()+864e5).toISOString();
const CAPS={enabled:true,provider:'anthropic',execution:'server',
  models:['claude-opus-5-5','claude-sonnet-5-5'],efforts:['low','medium','high'],
  limits:{maxUploadBytes:33554432,maxPromptChars:8000}};
const BYTES=Buffer.from('%PDF-1.7 synthetic hosted-ai fixture bytes\n%%EOF\n');
const SHA=createHash('sha256').update(BYTES).digest('hex');
const FILE_NAME='Synthetic paper.pdf';
const PROMPT='Check the methods section only.';
const INVITE='fsi_'+'B'.repeat(43);
const live=[];
after(()=>{for(const entry of live){try{entry.app.destroy();}catch{}}});

const job=(over={})=>Object.assign({
  id:'job-1',role:'red',state:'queued',
  progress:{completedCalls:0,requiredCalls:3,phase:'queued'},
  model:'claude-opus-5-5',effort:'high',provider:'anthropic',
  usage:null,result:null,artifacts:[],
  createdAt:'2026-11-17T00:00:00.000Z',updatedAt:'2026-11-17T00:00:01.000Z'
},over);

class El extends EventTarget{
  constructor(tag,owner){
    super();
    Object.assign(this,{tagName:String(tag).toUpperCase(),ownerDocument:owner,children:[],parent:null,attrs:{},dataset:{},_text:'',
      id:'',className:'',value:'',checked:false,disabled:false,hidden:false,type:'',files:[],download:'',href:'',rel:''});
  }
  get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
  set textContent(value){this.children=[];this._text=String(value);}
  append(...kids){
    for(const kid of kids){
      if(kid&&typeof kid==='object') kid.parent=this;
      this.children.push(kid);
    }
  }
  replaceChildren(...kids){this.textContent='';this.append(...kids);}
  setAttribute(key,value){this.attrs[key]=String(value);if(key==='id')this.id=String(value);}
  getAttribute(key){return Object.prototype.hasOwnProperty.call(this.attrs,key)?this.attrs[key]:null;}
  click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
  change(value){
    if(value!==undefined) this.value=value;
    this.dispatchEvent(new Event('change'));
  }
  *walk(){yield this;for(const child of this.children) if(child&&typeof child==='object'&&child.walk) yield* child.walk();}
  find(predicate){for(const node of this.walk()) if(predicate(node)) return node;return null;}
  querySelector(selector){
    if(typeof selector!=='string'||!selector.startsWith('#')) return null;
    const id=selector.slice(1);
    return this.find(node=>node.id===id);
  }
}
function makeDocument(){
  const doc=new EventTarget();
  const body=new El('body',doc);
  doc.body=body;
  doc.activeElement=body;
  doc.readyState='complete';
  doc.created=[];
  doc.createElement=tag=>{const node=new El(tag,doc);doc.created.push(node);return node;};
  doc.getElementById=id=>body.find(node=>node.id===id);
  return doc;
}
function storageStub(map){
  return {
    map,
    getItem:key=>map.has(key)?map.get(key):null,
    setItem:(key,value)=>{map.set(key,String(value));},
    removeItem:key=>{map.delete(key);}
  };
}
function setup(options={}){
  const doc=makeDocument();
  const host=new El('section',doc);
  host.id='hosted-ai';
  doc.body.append(host);
  const store=options.store||new Map();
  const calls=[];
  const objects=[];
  class TURL extends URL{
    static createObjectURL(blob){objects.push(blob);return 'blob:hosted/'+objects.length;}
    static revokeObjectURL(){objects.revoked=(objects.revoked||0)+1;}
  }
  const fetchStub=async(url,init={})=>{
    const record={url:String(url),path:new URL(url).pathname,method:String(init.method||'GET').toUpperCase(),
      headers:Object.assign({},init.headers||{}),body:init.body,init};
    calls.push(record);
    const route=options.routes?options.routes(record):{status:404,body:{error:{code:'not_found'}}};
    if(route==='hang') return new Promise((resolve,reject)=>{
      if(init.signal) init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));
    });
    return {
      ok:route.status>=200&&route.status<300,
      status:route.status,
      text:async()=>route.body===undefined?'':(typeof route.body==='string'?route.body:JSON.stringify(route.body)),
      blob:async()=>route.blob||new Blob([route.blobText||'{}'],{type:'application/json'})
    };
  };
  const config=options.config||Object.freeze({
    apiBase:'https://worker.test',provider:'confluence',
    hostedAi:Object.freeze({enabled:true,apiBase:'https://worker.test'})
  });
  const app=api.create({
    document:doc,host,fetch:fetchStub,storage:storageStub(store),crypto:options.crypto===undefined?webcrypto:options.crypto,
    URL:TURL,TextEncoder,AbortController,
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(Number(ms)||0,15)),clearTimeout,
    config:()=>config,
    sessionProvider:options.sessionProvider||(()=>undefined)
  });
  const $=id=>host.find(node=>node.id===id);
  const text=id=>{const node=$(id);return node?node.textContent:'';};
  const isVisible=id=>{
    let node=$(id);
    if(!node) return false;
    for(;node;node=node.parent) if(node.hidden) return false;
    return true;
  };
  const entry={app,doc,host,$,text,isVisible,calls,store,objects,
    anchors:()=>doc.created.filter(node=>node.tagName==='A'),
    storedText:()=>[...store.entries()].map(([key,value])=>key+'='+value).join('\n'),
    destroy:()=>app.destroy()};
  live.push(entry);
  return entry;
}
const until=async(predicate,label)=>{
  for(let i=0;i<600&&!predicate();i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(predicate(),label);
};
function makeRouter(options={}){
  let jobGetCount=0,jobsPostCount=0,loginCount=0,uploadCount=0,cancelCount=0,artifactCount=0;
  const router=record=>{
    const path=record.path;
    if(path==='/v1/ai/capabilities') return options.caps===null
      ?{status:503,body:{error:{code:'ai_unavailable',retryable:true}}}
      :{status:200,body:options.caps||CAPS};
    if(path==='/v1/auth/login'){
      loginCount++;
      if(options.login) return options.login(record);
      return {status:200,body:{token:TOKEN,author:{id:'author-1',username:'synthetic',displayName:'Synthetic Reviewer'},expiresAt:FUTURE}};
    }
    if(path==='/v1/auth/register'){
      if(options.register) return options.register(record);
      return {status:201,body:{token:TOKEN,
        author:{id:'author-2',username:'invited',displayName:'Invited Reviewer'},expiresAt:FUTURE}};
    }
    if(path==='/v1/logout') return {status:200,body:{revoked:true}};
    if(path==='/v1/ai/uploads'){
      uploadCount++;
      if(options.uploads) return options.uploads(record);
      return {status:201,body:{upload:{id:'up-1',sha256:SHA,name:FILE_NAME,mime:'application/pdf',
        bytes:BYTES.length,createdAt:'2026-11-17T00:00:00.000Z',deduplicated:false}}};
    }
    if(path==='/v1/ai/jobs'&&record.method==='POST'){
      jobsPostCount++;
      if(options.jobsPost) return options.jobsPost(record);
      return {status:202,body:{job:job({state:'queued'}),replayed:false}};
    }
    if(/^\/v1\/ai\/jobs\/[^/]+\/artifacts\/[^/]+$/.test(path)){
      artifactCount++;
      if(options.artifact) return options.artifact(record);
      return {status:200,blob:new Blob(['synthetic artifact'],{type:'application/json'})};
    }
    if(/^\/v1\/ai\/jobs\/[^/]+\/cancel$/.test(path)&&record.method==='POST'){
      cancelCount++;
      if(options.cancel) return options.cancel(record);
      return {status:202,body:{job:job({state:'cancelling'})}};
    }
    if(/^\/v1\/ai\/jobs\/[^/]+$/.test(path)&&record.method==='GET'){
      jobGetCount++;
      if(options.jobGet) return options.jobGet(record,jobGetCount);
      return {status:200,body:{job:job({state:'completed'})}};
    }
    return {status:404,body:{error:{code:'not_found',requestId:'req_unknown'}}};
  };
  router.counts=()=>({jobGetCount,jobsPostCount,loginCount,uploadCount,cancelCount,artifactCount});
  return router;
}
async function signIn(entry){
  entry.$('hosted-ai-username').value='synthetic';
  entry.$('hosted-ai-password').value='correct horse battery';
  entry.$('hosted-ai-login-form').dispatchEvent(new Event('submit'));
  await until(()=>entry.store.has(SESSION_KEY),'login stores the session');
  await until(()=>entry.isVisible('hosted-ai-config'),'config panel opens after login');
}
async function selectFile(entry,bytes,{name=FILE_NAME,type='application/pdf'}={}){
  const input=entry.$('hosted-ai-file');
  input.files=[{name,size:bytes.length,type,
    arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}];
  input.dispatchEvent(new Event('change'));
  await until(()=>/sha256/.test(entry.text('hosted-ai-file-status')),'file hash is shown');
}
function setPrompt(entry,value){
  const node=entry.$('hosted-ai-prompt');
  node.value=value;
  node.dispatchEvent(new Event('input'));
}
function fillRegistration(entry,{username='invited_user',password='correct horse battery',
  displayName='Invited Reviewer',inviteCode=INVITE}={}){
  entry.$('hosted-ai-register-username').value=username;
  entry.$('hosted-ai-register-password').value=password;
  entry.$('hosted-ai-register-display-name').value=displayName;
  entry.$('hosted-ai-register-invite').value=inviteCode;
}
const runsOf=map=>JSON.parse(map.get(RUNS_KEY)||'{"runs":{},"active":""}');

test('disabled cloud configuration renders a truthful inert panel with the local fallback',async()=>{
  const entry=setup({config:Object.freeze({apiBase:'https://worker.test',provider:'confluence',
    hostedAi:Object.freeze({enabled:false,apiBase:'https://worker.test'})})});
  await entry.app.ready;
  assert.equal(entry.calls.length,0,'no request when hostedAi.enabled is false');
  assert.equal(entry.$('hosted-ai-disabled').hidden,false);
  assert.match(entry.text('hosted-ai-disabled-message'),/켜져 있지 않습니다/);
  assert.match(entry.text('hosted-ai-disabled-message'),/아무것도 보내지 않습니다/);
  assert.equal(entry.$('hosted-ai-config').hidden,true);
  assert.equal(entry.$('hosted-ai-login-form').hidden,true);
  assert.match(entry.text('hosted-ai-disabled'),/로컬 실행 연결/);
});

test('capabilities that are off or unreachable disable the panel without sending a job',async()=>{
  const off=setup({routes:makeRouter({caps:{enabled:false,provider:'anthropic',execution:'server',models:[],efforts:[],limits:{}}})});
  await off.app.ready;
  assert.equal(off.calls.length,1);
  assert.match(off.text('hosted-ai-disabled-message'),/켜져 있지 않습니다/);
  assert.equal(off.$('hosted-ai-config').hidden,true);

  const unreachable=setup({routes:makeRouter({caps:null})});
  await unreachable.app.ready;
  assert.match(unreachable.text('hosted-ai-disabled-message'),/확인하지 못했습니다/);
  assert.match(unreachable.text('hosted-ai-disabled-message'),/아무 작업도 보내지 않습니다/);
  assert.equal(unreachable.calls.filter(call=>call.method==='POST').length,0);

  const badBase=setup({config:Object.freeze({apiBase:'http://insecure.example',provider:'confluence',
    hostedAi:Object.freeze({enabled:true,apiBase:'http://insecure.example'})})});
  await badBase.app.ready;
  assert.equal(badBase.calls.length,0);
  assert.match(badBase.text('hosted-ai-disabled-message'),/https 주소/);
});

test('login gate sends only username and password and keeps the password out of storage and DOM',async()=>{
  const router=makeRouter({jobGet:()=>({status:200,body:{job:job({state:'completed'})}})});
  const entry=setup({routes:router});
  await entry.app.ready;
  assert.equal(entry.$('hosted-ai-login-form').hidden,false);
  assert.equal(entry.$('hosted-ai-config').hidden,true);
  assert.equal(entry.$('hosted-ai-run').disabled,true);

  await signIn(entry);

  const login=entry.calls.find(call=>call.path==='/v1/auth/login');
  assert.equal(login.method,'POST');
  assert.equal(login.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(login.body),{username:'synthetic',password:'correct horse battery'});
  assert.equal(entry.$('hosted-ai-password').value,'','password field cleared');
  assert.match(entry.text('hosted-ai-session'),/Synthetic Reviewer/);

  const probes=entry.calls.filter(call=>call.path==='/v1/ai/capabilities');
  assert.equal(probes.length,2,'capabilities is re-read with the session');
  assert.equal(probes[0].headers.Authorization,undefined);
  assert.equal(probes[1].headers.Authorization,'Bearer '+TOKEN);

  const stored=entry.storedText();
  assert.ok(!stored.includes('correct horse battery'),'password is never persisted');
  assert.ok(!entry.doc.body.textContent.includes(TOKEN),'session token is not rendered');
  assert.ok(!stored.includes(TOKEN)||stored.includes('"token":"'+TOKEN+'"'),'token only lives in its session record');

  entry.$('hosted-ai-logout').click();
  await until(()=>!entry.store.has(SESSION_KEY),'logout clears the stored session');
  await until(()=>entry.$('hosted-ai-login-form').hidden===false,'login form returns');
  const logoutCall=entry.calls.find(call=>call.path==='/v1/logout');
  assert.equal(logoutCall.method,'POST');
  assert.equal(logoutCall.headers.Authorization,'Bearer '+TOKEN);
  assert.equal(entry.store.has(RUNS_KEY),false);
});

test('upload uses raw bytes, content type and an encoded file name, then submits one idempotent job',async()=>{
  const router=makeRouter();
  const entry=setup({routes:router});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  assert.match(entry.text('hosted-ai-file-status'),new RegExp('sha256 '+SHA));
  assert.match(entry.text('hosted-ai-file-status'),/bytes|KiB|MiB/);

  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-role').value='red';
  assert.equal(entry.$('hosted-ai-run').disabled,false);
  entry.$('hosted-ai-run').click();
  await until(()=>entry.calls.some(call=>call.path==='/v1/ai/jobs'&&call.method==='POST'),'job submitted');

  const upload=entry.calls.find(call=>call.path==='/v1/ai/uploads');
  assert.equal(upload.method,'POST');
  assert.equal(upload.headers.Authorization,'Bearer '+TOKEN);
  assert.equal(upload.headers['Content-Type'],'application/pdf');
  assert.equal(upload.headers['X-Falsify-File-Name'],encodeURIComponent(FILE_NAME));
  assert.equal(Buffer.from(upload.body).equals(BYTES),true,'raw file bytes are uploaded');
  assert.equal(entry.calls.filter(call=>call.path==='/v1/ai/uploads').length,1);

  const post=entry.calls.find(call=>call.path==='/v1/ai/jobs'&&call.method==='POST');
  assert.equal(post.headers['Content-Type'],'application/json');
  assert.equal(post.headers.Authorization,'Bearer '+TOKEN);
  const body=JSON.parse(post.body);
  assert.deepEqual(Object.keys(body).sort(),['effort','idempotencyKey','model','prompt','role','uploadId','useEvidence']);
  assert.equal(body.role,'red');
  assert.equal(body.prompt,PROMPT);
  assert.equal(body.uploadId,'up-1');
  assert.equal(body.model,'claude-opus-5-5');
  assert.equal(body.useEvidence,true,'structured evidence is on by default');
  assert.equal(body.effort,'high');
  assert.match(body.idempotencyKey,/^fssjob-[0-9a-f]{40}$/);
  assert.ok(!/harness|anthropic|apiKey|provider/i.test(post.body),'no key, provider or harness field is sent');

  const runs=runsOf(entry.store);
  const digest=Object.keys(runs.runs)[0];
  assert.match(digest,/^[0-9a-f]{64}$/);
  assert.equal(runs.active,digest);
  assert.equal(runs.runs[digest].key,body.idempotencyKey);
  assert.equal(runs.runs[digest].jobId,'job-1');
  assert.equal(runs.runs[digest].pending,false);
  assert.ok(!entry.storedText().includes(PROMPT),'the review instruction is not persisted');

  await until(()=>entry.isVisible('hosted-ai-job'),'job panel opens');
  assert.match(entry.text('hosted-ai-job-state'),/대기 중|실행 중/);
});

test('a model or effort change derives a new key and submits normally instead of conflicting',async()=>{
  let postCount=0;
  const router=makeRouter({
    jobsPost:record=>{
      postCount++;
      const body=JSON.parse(record.body);
      return {status:202,body:{job:job({id:'job-'+postCount,state:'completed',
        progress:{completedCalls:1,requiredCalls:1,phase:'done'},
        model:body.model,effort:body.effort,result:{counts:{rejected:0,unresolved:0}}})}};
    }
  });
  const entry=setup({routes:router});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  const posts=()=>entry.calls.filter(call=>call.path==='/v1/ai/jobs'&&call.method==='POST');

  entry.$('hosted-ai-run').click();
  await until(()=>posts().length===1,'first submit');
  const first=JSON.parse(posts()[0].body);
  assert.equal(first.model,'claude-opus-5-5');
  assert.equal(first.effort,'high');
  await until(()=>/완료/.test(entry.text('hosted-ai-job-state')),'first run completes');

  entry.$('hosted-ai-run').click();
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(posts().length,1,'identical inputs restore the stored job instead of resubmitting');

  entry.$('hosted-ai-model').value='claude-sonnet-5-5';
  entry.$('hosted-ai-model').dispatchEvent(new Event('change'));
  entry.$('hosted-ai-effort').value='medium';
  entry.$('hosted-ai-effort').dispatchEvent(new Event('change'));
  assert.equal(entry.$('hosted-ai-run').disabled,false);
  entry.$('hosted-ai-run').click();
  await until(()=>posts().length===2,'a changed model and effort submits a new request');
  const second=JSON.parse(posts()[1].body);
  assert.equal(second.model,'claude-sonnet-5-5');
  assert.equal(second.effort,'medium');
  assert.equal(second.role,first.role);
  assert.equal(second.prompt,first.prompt);
  assert.equal(second.uploadId,first.uploadId);
  assert.notEqual(second.idempotencyKey,first.idempotencyKey,'the digest covers model and effort');
  assert.match(second.idempotencyKey,/^fssjob-[0-9a-f]{40}$/);
  assert.equal(new Set([first.idempotencyKey,second.idempotencyKey]).size,2);

  const runs=Object.values(runsOf(entry.store).runs);
  assert.equal(runs.length,2);
  assert.equal(runs.filter(run=>run.jobId).length,2);
  assert.deepEqual(runs.map(run=>run.key).sort(),[first.idempotencyKey,second.idempotencyKey].sort());
  assert.ok(!entry.storedText().includes(PROMPT),'the instruction is still not persisted');
});

test('reload reuses the stored job and idempotency key without a second submission',async()=>{
  const shared=new Map();
  const first=setup({store:shared,routes:makeRouter({
    jobsPost:()=>({status:202,body:{job:job({state:'running',progress:{completedCalls:1,requiredCalls:3,phase:'analyzing'}}),replayed:false}}),
    jobGet:()=>({status:200,body:{job:job({state:'completed',progress:{completedCalls:3,requiredCalls:3,phase:'done'},
      result:{items:[{id:'d1',status:'rejected',title:'Synthetic rejected claim'}]},artifacts:[]})}})
  })});
  await first.app.ready;
  await signIn(first);
  await selectFile(first,BYTES);
  setPrompt(first,PROMPT);
  first.$('hosted-ai-run').click();
  await until(()=>/완료/.test(first.text('hosted-ai-job-state')),'first run completes');
  const key=runsOf(shared).runs[runsOf(shared).active].key;
  first.app.destroy();

  const second=setup({store:shared,routes:makeRouter({
    jobsPost:()=>{throw Error('a reload must never submit a second paid run');},
    jobGet:()=>({status:200,body:{job:job({state:'completed',progress:{completedCalls:3,requiredCalls:3,phase:'done'},
      result:{items:[{id:'d1',status:'rejected',title:'Synthetic rejected claim'}]},artifacts:[]})}})
  })});
  await second.app.ready;
  await until(()=>/완료/.test(second.text('hosted-ai-job-state')),'stored job is restored');
  assert.equal(second.calls.filter(call=>call.path==='/v1/ai/jobs'&&call.method==='POST').length,0);
  const get=second.calls.find(call=>call.path==='/v1/ai/jobs/job-1'&&call.method==='GET');
  assert.equal(get.headers.Authorization,'Bearer '+TOKEN);
  assert.equal(runsOf(shared).runs[runsOf(shared).active].key,key,'the same key is kept');
  assert.match(second.text('hosted-ai-result-counts'),/거절 1/);
  assert.equal(second.calls.some(call=>call.path==='/v1/auth/login'),false,'stored session is reused');
});

test('polling shows queued, running and completed progress with truthful counts',async()=>{
  const snapshots=[
    job({state:'queued',progress:{completedCalls:0,requiredCalls:4,phase:'queued'}}),
    job({state:'running',progress:{completedCalls:2,requiredCalls:4,phase:'analyzing'}}),
    job({state:'completed',progress:{completedCalls:4,requiredCalls:4,phase:'completed'},
      result:{schema:'falsify.document-red.v1',status:'ok',
        coverage:{complete:true,resultCoverage:{accepted:1,rejected:2,unresolved:1,
          rejectedItems:[{index:0,code:'numeric_drift'},{index:3,code:'condition_omission'}],
          unresolvedItems:[{index:2,code:'ambiguous_location'}]}},
        candidates:[{id:'c1'},{id:'c2'},{id:'c3'},{id:'c4'}]}})
  ];
  const entry=setup({routes:makeRouter({jobGet:(record,count)=>({status:200,body:{job:snapshots[Math.min(count,snapshots.length)-1]}})})});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/완료/.test(entry.text('hosted-ai-job-state')),'job completes through polling');
  assert.match(entry.text('hosted-ai-job-state'),/완료 · completed/);
  assert.match(entry.text('hosted-ai-job-progress'),/완료 호출 4 \/ 4/);
  assert.match(entry.text('hosted-ai-job-progress'),/단계 completed/);
  assert.match(entry.text('hosted-ai-result-counts'),/항목 4/);
  assert.match(entry.text('hosted-ai-result-counts'),/수용 1/);
  assert.match(entry.text('hosted-ai-result-counts'),/거절 2/);
  assert.match(entry.text('hosted-ai-result-counts'),/미해결 1/);
  assert.match(entry.text('hosted-ai-job-usage'),/서버가 제공하지 않음/);
  const items=entry.$('hosted-ai-result-items').children.map(child=>child.textContent).join('\n');
  assert.match(items,/numeric_drift/);
  assert.match(items,/condition_omission/);
  assert.match(items,/ambiguous_location/);
  assert.equal(entry.$('hosted-ai-result-note').textContent,'','a complete run does not claim partial coverage');
  assert.equal(entry.calls.filter(call=>call.path==='/v1/ai/jobs'&&call.method==='POST').length,1);
});

test('interrupted jobs show partial results and are never replayed automatically',async()=>{
  const entry=setup({routes:makeRouter({
    jobGet:()=>({status:200,body:{job:job({state:'interrupted',progress:{completedCalls:1,requiredCalls:4,phase:'analyzing'},
      result:{schema:'falsify.document-blue.v1',status:'ok',
        coverage:{complete:false,remainingBatches:['p3-b1..p3-b4'],
          resultCoverage:{accepted:0,rejected:1,unresolved:1,
          rejectedItems:[{index:0,code:'partial_reject'}],
          unresolvedItems:[{index:1,code:'ambiguous_location'}]}},
        findings:[{id:'p1'},{id:'p2'}]},
      artifacts:[{id:'art-partial',name:'review-partial.json',mime:'application/json',bytes:42,sha256:'ab'.repeat(32)}]})}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/중단됨/.test(entry.text('hosted-ai-job-state')),'interrupted state is shown');
  assert.match(entry.text('hosted-ai-job-state'),/interrupted/);
  assert.match(entry.text('hosted-ai-result-counts'),/부분 결과/);
  assert.match(entry.text('hosted-ai-result-counts'),/수용 0/);
  assert.match(entry.text('hosted-ai-result-counts'),/거절 1/);
  assert.match(entry.text('hosted-ai-result-counts'),/미해결 1/);
  assert.match(entry.text('hosted-ai-result-counts'),/미검토 배치 1개/);
  assert.match(entry.text('hosted-ai-result-note'),/일부 결과만/);
  assert.match(entry.text('hosted-ai-result-note'),/다시 실행하지 않았습니다/);
  assert.equal(entry.$('hosted-ai-artifacts-section').hidden,false);
  assert.match(entry.text('hosted-ai-artifacts'),/review-partial\.json/);
  assert.equal(entry.$('hosted-ai-cancel').hidden,true);
  assert.equal(entry.calls.filter(call=>call.path==='/v1/ai/jobs'&&call.method==='POST').length,1);
});

test('cancel posts once and follows cancelling to cancelled without resubmitting',async()=>{
  let allowCancelled=false;
  const router=makeRouter({
    jobsPost:()=>({status:202,body:{job:job({state:'running',progress:{completedCalls:1,requiredCalls:3,phase:'analyzing'}}),replayed:false}}),
    cancel:()=>({status:202,body:{job:job({state:'cancelling',progress:{completedCalls:1,requiredCalls:3,phase:'analyzing'}})}}),
    jobGet:()=>{
      const state=allowCancelled?'cancelled':(router.counts().cancelCount>0?'cancelling':'running');
      return {status:200,body:{job:job({state,progress:{completedCalls:1,requiredCalls:3,phase:'analyzing'}})}};
    }
  });
  const entry=setup({routes:router});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>entry.$('hosted-ai-cancel').hidden===false,'cancel becomes available');
  entry.$('hosted-ai-cancel').click();
  await until(()=>/취소 중/.test(entry.text('hosted-ai-job-state')),'cancelling is shown');
  const cancel=entry.calls.find(call=>call.path==='/v1/ai/jobs/job-1/cancel');
  assert.equal(cancel.method,'POST');
  assert.equal(cancel.headers.Authorization,'Bearer '+TOKEN);
  allowCancelled=true;
  await until(()=>/취소됨/.test(entry.text('hosted-ai-job-state')),'cancelled is shown');
  assert.equal(entry.$('hosted-ai-cancel').hidden,true);
  assert.equal(entry.calls.filter(call=>call.path==='/v1/ai/jobs'&&call.method==='POST').length,1);
  assert.equal(entry.calls.filter(call=>call.path==='/v1/ai/jobs/job-1/cancel').length,1);
});

test('owner-scoped 404s stop polling and never echo server detail text',async()=>{
  const entry=setup({routes:makeRouter({
    jobGet:()=>({status:404,body:{error:{code:'not_found',message:'PRIVATE_PAPER_MARKER',requestId:'req_synthetic_7',retryable:false}}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/찾지 못했습니다/.test(entry.text('hosted-ai-error')),'404 is explained honestly');
  assert.match(entry.text('hosted-ai-error'),/다른 계정의 작업이거나 만료/);
  assert.match(entry.text('hosted-ai-error'),/req_synthetic_7/);
  assert.ok(!entry.doc.body.textContent.includes('PRIVATE_PAPER_MARKER'),'server message text is not echoed');
  const reads=entry.calls.filter(call=>call.method==='GET'&&call.path==='/v1/ai/jobs/job-1').length;
  await new Promise(resolve=>setTimeout(resolve,80));
  const laterReads=entry.calls.filter(call=>call.method==='GET'&&call.path==='/v1/ai/jobs/job-1').length;
  assert.equal(laterReads,reads,'polling stops after a 404');
  assert.equal(entry.calls.filter(call=>call.path==='/v1/ai/jobs'&&call.method==='POST').length,1);
});

test('artifact download uses the authenticated session and a blob link',async()=>{
  const artifact={id:'art-1',name:'review.json',mime:'application/json',bytes:42,sha256:'cd'.repeat(32)};
  const entry=setup({routes:makeRouter({
    jobGet:()=>({status:200,body:{job:job({state:'completed',progress:{completedCalls:3,requiredCalls:3,phase:'done'},artifacts:[artifact]})}}),
    artifact:()=>({status:200,blob:new Blob(['{"synthetic":true}'],{type:'application/json'})})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>entry.$('hosted-ai-artifacts-section').hidden===false,'artifact list is shown');
  const button=entry.$('hosted-ai-artifacts').find(node=>node.tagName==='BUTTON');
  assert.ok(button,'download button exists');
  button.click();
  await until(()=>entry.objects.length===1,'blob link is created');
  const request=entry.calls.find(call=>call.path==='/v1/ai/jobs/job-1/artifacts/art-1');
  assert.equal(request.method,'GET');
  assert.equal(request.headers.Authorization,'Bearer '+TOKEN);
  const anchor=entry.anchors().find(node=>node.download);
  assert.equal(anchor.download,'review.json');
  assert.equal(anchor.href,'blob:hosted/1');
  assert.match(entry.text('hosted-ai-download-status'),/내려받았습니다/);
  assert.ok(!entry.doc.body.textContent.includes('Bearer '),'bearer header is never rendered');
});

test('model, effort and usage are rendered exactly as the server reported them',async()=>{
  const entry=setup({routes:makeRouter({
    jobGet:()=>({status:200,body:{job:job({state:'completed',
      progress:{completedCalls:2,requiredCalls:2,phase:'done'},
      model:'claude-sonnet-5-5',effort:'medium',provider:'anthropic',
      usage:{inputTokens:11,outputTokens:22,cacheReadInputTokens:0,cacheCreationInputTokens:5},
      result:{counts:{rejected:0,unresolved:0}}})}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/완료/.test(entry.text('hosted-ai-job-state')),'job completes');
  assert.match(entry.text('hosted-ai-job-model'),/모델: claude-sonnet-5-5/);
  assert.match(entry.text('hosted-ai-job-model'),/추론 강도: medium/);
  assert.match(entry.text('hosted-ai-job-model'),/실행: anthropic/);
  assert.match(entry.text('hosted-ai-job-usage'),/입력 11/);
  assert.match(entry.text('hosted-ai-job-usage'),/출력 22/);
  assert.match(entry.text('hosted-ai-job-usage'),/캐시 읽기 0/);
  assert.match(entry.text('hosted-ai-job-usage'),/캐시 생성 5/);

  const silent=setup({routes:makeRouter({
    jobGet:()=>({status:200,body:{job:job({state:'completed',progress:{completedCalls:1,requiredCalls:1,phase:'done'},
      model:undefined,effort:undefined,usage:undefined,result:null})}})
  })});
  await silent.app.ready;
  await signIn(silent);
  await selectFile(silent,BYTES);
  setPrompt(silent,PROMPT);
  silent.$('hosted-ai-run').click();
  await until(()=>/완료/.test(silent.text('hosted-ai-job-state')),'silent job completes');
  assert.match(silent.text('hosted-ai-job-model'),/모델: 서버가 제공하지 않음/);
  assert.match(silent.text('hosted-ai-job-model'),/추론 강도: 서버가 제공하지 않음/);
  assert.match(silent.text('hosted-ai-job-usage'),/서버가 제공하지 않음/);
  assert.ok(!/입력 0|출력 0/.test(silent.text('hosted-ai-job-usage')),'missing usage is not invented');
  assert.equal(silent.$('hosted-ai-result-section').hidden,true);
});

test('a file over the advertised limit is rejected in the browser before any upload',async()=>{
  const small=Buffer.alloc(20,7);
  const entry=setup({routes:makeRouter({caps:{...CAPS,limits:{maxUploadBytes:10,maxPromptChars:8000}}})});
  await entry.app.ready;
  await signIn(entry);
  const input=entry.$('hosted-ai-file');
  input.files=[{name:'Synthetic over-limit.pdf',size:small.length,type:'application/pdf',
    arrayBuffer:async()=>small.buffer.slice(small.byteOffset,small.byteOffset+small.byteLength)}];
  input.dispatchEvent(new Event('change'));
  await until(()=>/한도/.test(entry.text('hosted-ai-error')),'limit error is shown');
  assert.match(entry.text('hosted-ai-error'),/넘어 업로드하지 않았습니다/);
  assert.match(entry.text('hosted-ai-file-status'),/한도/);
  setPrompt(entry,PROMPT);
  assert.equal(entry.$('hosted-ai-run').disabled,true);
  entry.$('hosted-ai-run').click();
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(entry.calls.some(call=>call.path==='/v1/ai/uploads'),false,'no upload was sent');
  assert.equal(entry.calls.some(call=>call.path==='/v1/ai/jobs'),false,'no job was sent');
});

test('an idempotency conflict is reported and not retried',async()=>{
  const entry=setup({routes:makeRouter({
    jobsPost:()=>({status:409,body:{error:{code:'idempotency_conflict',message:'conflict',requestId:'req_conflict',retryable:false}}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/다시 보내지 않았습니다/.test(entry.text('hosted-ai-error')),'conflict is explained');
  assert.match(entry.text('hosted-ai-error'),/다른 내용/);
  assert.match(entry.text('hosted-ai-error'),/req_conflict/);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(entry.calls.filter(call=>call.path==='/v1/ai/jobs'&&call.method==='POST').length,1);
});

test('an injected page session skips the password form and authenticates the API calls',async()=>{
  const entry=setup({routes:makeRouter({jobGet:()=>({status:200,body:{job:job({state:'completed'})}})}),
    sessionProvider:()=>({token:()=>TOKEN})});
  await entry.app.ready;
  assert.equal(entry.$('hosted-ai-login-form').hidden,true);
  assert.equal(entry.$('hosted-ai-external').hidden,true);
  assert.match(entry.text('hosted-ai-session'),/페이지 세션/);
  assert.equal(entry.$('hosted-ai-logout').hidden,true);
  assert.equal(entry.calls.find(call=>call.path==='/v1/ai/capabilities').headers.Authorization,'Bearer '+TOKEN);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>entry.calls.some(call=>call.path==='/v1/ai/jobs'&&call.method==='POST'),'hook session can submit');
  assert.equal(entry.calls.find(call=>call.path==='/v1/ai/jobs'&&call.method==='POST').headers.Authorization,'Bearer '+TOKEN);
  assert.ok(!entry.store.has(SESSION_KEY),'a hook token is not copied into storage');
});

test('an over-long instruction is blocked by the advertised character limit',async()=>{
  const entry=setup({routes:makeRouter({caps:{...CAPS,limits:{maxUploadBytes:33554432,maxPromptChars:20}}})});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,'x'.repeat(21));
  assert.equal(entry.$('hosted-ai-run').disabled,true);
  assert.match(entry.text('hosted-ai-prompt-count'),/21 \/ 20/);
  entry.$('hosted-ai-run').click();
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(entry.calls.some(call=>call.path==='/v1/ai/jobs'),false);
});

/* ------------------------------------------------------------------ hosted RED -> edited PDF -> BLUE */

const REVIEW_UPLOAD='11111111-1111-4111-8111-111111111111';
const EDITED_UPLOAD='22222222-2222-4222-8222-222222222222';
const EDITED=Buffer.from('%PDF-1.7 synthetic edited hosted-ai fixture\n%%EOF\n');
const EDITED_SHA=createHash('sha256').update(EDITED).digest('hex');
const RED_BEFORE_1='The mean was 4.2 (SD 1.1).';
const RED_AFTER_1='The mean was 5.8 (SD 1.1).';
const RED_BEFORE_2='We included 120 patients.';
const RED_AFTER_2='We included 210 patients.';
const RED_RATIONALE='RED_RATIONALE_MUST_STAY_OUT_OF_BLUE';
const APPLY_PROMPT='Apply the selected RED edits to the uploaded PDF only.';
const EDITED_ARTIFACT={id:'art-edited',name:'edited.pdf',mime:'application/pdf',bytes:EDITED.length,sha256:EDITED_SHA};

function redResult(){
  return {
    schema:'falsify.document-red.v1',status:'ok',
    coverage:{complete:true,resultCoverage:{accepted:2,rejected:0,unresolved:0}},
    candidates:[
      {id:'c1',segmentId:'p2-b1',attackTypes:['numeric-drift'],before:RED_BEFORE_1,after:RED_AFTER_1,occurrence:1,rationale:RED_RATIONALE},
      {id:'c2',segmentId:'p1-b2',attackTypes:['contradiction'],before:RED_BEFORE_2,after:RED_AFTER_2,rationale:RED_RATIONALE}
    ],
    visualEdits:[
      {kind:'table-cell',itemId:'tbl-1',row:0,column:2,before:'4.2',after:'5.8',rationale:RED_RATIONALE},
      {kind:'chart-point',itemId:'fig-1',seriesId:'s1',pointIndex:0,beforeY:1,afterY:2,rationale:RED_RATIONALE}
    ]
  };
}
const reviewJob=()=>job({id:'job-red',state:'completed',progress:{completedCalls:2,requiredCalls:2,phase:'done'},result:redResult()});
const applyJob=()=>job({id:'job-apply',role:'red',state:'completed',progress:{completedCalls:0,requiredCalls:0,phase:'applying'},
  model:undefined,effort:undefined,usage:null,
  result:{schema:'falsify.hosted-apply.v1',applyOnly:true,sourceSha256:SHA,outputSha256:EDITED_SHA,pageCount:1,
    visualEdits:{requested:1,applied:1,rejected:0,changes:[]},
    textEdits:{requested:2,applied:2,rejected:0,changes:[]},
    verification:{visualStatus:'ok',textFallbackCount:0}},
  artifacts:[EDITED_ARTIFACT]});
const blueJob=()=>job({id:'job-blue',role:'blue',state:'completed',progress:{completedCalls:1,requiredCalls:1,phase:'done'},
  result:{schema:'falsify.document-blue.v1',status:'ok',
    coverage:{complete:true,resultCoverage:{accepted:1,rejected:0,unresolved:0}},findings:[{id:'f1'}]}});

function editFlow(options={}){
  const uploads=[],posts=[];
  const router=makeRouter(Object.assign({
    uploads:record=>{
      const bytes=Buffer.from(record.body);
      uploads.push(bytes);
      const sha=createHash('sha256').update(bytes).digest('hex');
      const edited=sha===EDITED_SHA;
      return {status:201,body:{upload:{id:edited?EDITED_UPLOAD:REVIEW_UPLOAD,sha256:sha,
        name:edited?'edited.pdf':FILE_NAME,mime:'application/pdf',bytes:bytes.length,deduplicated:false}}};
    },
    jobsPost:record=>{
      const body=JSON.parse(record.body);
      posts.push(body);
      if(body.applyOnly===true) return {status:202,body:{job:applyJob(),replayed:false}};
      if(body.role==='blue') return {status:202,body:{job:blueJob(),replayed:false}};
      return {status:202,body:{job:reviewJob(),replayed:false}};
    },
    artifact:()=>({status:200,blob:new Blob([EDITED],{type:'application/pdf'})})
  },options.router||{}));
  const entry=setup({store:options.store,routes:router});
  return {entry,router,uploads,posts};
}
async function startReview(entry){
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>entry.isVisible('hosted-ai-selection'),'RED candidates appear');
}
function checkCandidate(entry,id){
  const box=entry.$(id);
  assert.ok(box,'checkbox '+id+' exists');
  if(!box.checked){
    box.checked=true;
    box.dispatchEvent(new Event('change'));
  }
}
function checkEveryCandidate(entry){
  const boxes=[...entry.$('hosted-ai-candidates').walk()].filter(node=>node.tagName==='INPUT');
  for(const box of boxes) checkCandidate(entry,box.id);
  const visuals=[...entry.$('hosted-ai-visual-candidates').walk()].filter(node=>node.tagName==='INPUT');
  for(const box of visuals) checkCandidate(entry,box.id);
}
async function applySelected(entry){
  entry.$('hosted-ai-apply').click();
  await until(()=>entry.isVisible('hosted-ai-edited-section'),'edited PDF is offered');
}

test('selected RED candidates become one apply-only job with exact page, before/after and table edits',async()=>{
  const flow=editFlow();
  const entry=flow.entry;
  await startReview(entry);
  assert.equal(entry.$('hosted-ai-candidate-0').checked,false);
  assert.match(entry.text('hosted-ai-candidates'),/The mean was 4\.2 \(SD 1\.1\)\./);
  assert.match(entry.text('hosted-ai-candidates'),/The mean was 5\.8 \(SD 1\.1\)\./);
  assert.match(entry.text('hosted-ai-candidates'),/후보 1 · 2쪽/);
  assert.match(entry.text('hosted-ai-candidates'),/p2-b1/);
  assert.match(entry.text('hosted-ai-visual-candidates'),/표 셀 tbl-1/);
  assert.match(entry.text('hosted-ai-chart-note'),/1건/);

  checkCandidate(entry,'hosted-ai-candidate-0');
  checkCandidate(entry,'hosted-ai-candidate-1');
  checkCandidate(entry,'hosted-ai-visual-0');
  assert.match(entry.text('hosted-ai-apply'),/\(3\)/,'one apply action shows the selection count');
  assert.match(entry.text('hosted-ai-apply-status'),/선택 3개/);

  await applySelected(entry);
  assert.equal(flow.posts.length,2,'review and apply are the only submissions');
  const review=flow.posts[0],apply=flow.posts[1];
  assert.equal(review.role,'red');
  assert.equal(review.useEvidence,true);
  assert.equal(apply.role,'red');
  assert.equal(apply.applyOnly,true);
  assert.equal(apply.uploadId,REVIEW_UPLOAD);
  assert.equal(apply.prompt,APPLY_PROMPT);
  assert.deepEqual(apply.edits,[
    {pageIndex:1,before:RED_BEFORE_1,after:RED_AFTER_1,occurrence:1},
    {pageIndex:0,before:RED_BEFORE_2,after:RED_AFTER_2,occurrence:0}
  ]);
  assert.deepEqual(apply.visualEdits,[{kind:'table-cell',itemId:'tbl-1',row:0,column:2,
    before:'4.2',after:'5.8',rationale:RED_RATIONALE}]);
  assert.equal(apply.model,'claude-opus-5-5');
  assert.equal(apply.effort,'high');
  for(const key of ['budget','harness']){
    assert.ok(!Object.hasOwn(apply,key),'apply-only job has no '+key);
  }
  assert.equal(apply.useEvidence,true,'visual table edits need structured evidence');
  assert.notEqual(apply.idempotencyKey,review.idempotencyKey,'a selection change derives a new key');
  assert.ok(!JSON.stringify(apply).includes('chart-point'),'chart points are not applied by this UI');

  const applyRun=Object.values(runsOf(entry.store).runs).find(run=>run.kind==='apply');
  assert.ok(applyRun,'the apply run is persisted');
  assert.equal(applyRun.reviewJobId,'job-red');
  assert.equal(applyRun.uploadId,REVIEW_UPLOAD);
  assert.equal(applyRun.jobId,'job-apply');
  assert.match(entry.text('hosted-ai-result-counts'),/텍스트 변경 2건 적용/);
  assert.match(entry.text('hosted-ai-result-counts'),/표 셀 1건 적용/);
  assert.match(entry.text('hosted-ai-result-counts'),/모델 호출 없음/);
  assert.match(entry.text('hosted-ai-result-counts'),new RegExp('출력 sha256 '+EDITED_SHA));
  assert.match(entry.text('hosted-ai-result-note'),/검증 결과를 기록했습니다/);
  const stored=entry.storedText();
  for(const value of [RED_RATIONALE,RED_BEFORE_1,RED_AFTER_1,PROMPT]){
    assert.ok(!stored.includes(value),'RED text and instruction stay out of sessionStorage');
  }
  assert.ok(!entry.doc.body.textContent.includes(TOKEN),'the session token is never rendered');

  entry.$('hosted-ai-edited-download').click();
  await until(()=>entry.objects.length===1,'the edited PDF is fetched as a blob');
  const artifactRequest=entry.calls.filter(call=>call.path==='/v1/ai/jobs/job-apply/artifacts/art-edited');
  assert.equal(artifactRequest.length,1);
  assert.equal(artifactRequest[0].headers.Authorization,'Bearer '+TOKEN);
  const anchor=entry.anchors().find(node=>node.download==='edited.pdf');
  assert.ok(anchor,'the edited PDF download uses its stored name');
  assert.match(entry.text('hosted-ai-edited-note'),new RegExp('sha256 '+EDITED_SHA));
  assert.match(entry.text('hosted-ai-edited-note'),/RED 결과·후보·근거는 보내지 않습니다/);
});

test('BLUE handoff uploads the exact edited bytes and sends no RED result, candidates or rationale',async()=>{
  const flow=editFlow();
  const entry=flow.entry;
  await startReview(entry);
  checkEveryCandidate(entry);
  await applySelected(entry);
  assert.equal(flow.uploads.length,1,'only the original paper was uploaded so far');

  entry.$('hosted-ai-blue-handoff').click();
  await until(()=>flow.uploads.length===2,'the edited PDF is uploaded for BLUE');
  assert.deepEqual(flow.uploads[1],EDITED,'BLUE input bytes are the edited artifact, not the RED result');
  const uploads=entry.calls.filter(call=>call.path==='/v1/ai/uploads');
  assert.equal(uploads[1].headers['Content-Type'],'application/pdf');
  assert.equal(uploads[1].headers['X-Falsify-File-Name'],encodeURIComponent('edited.pdf'));
  assert.equal(uploads[1].headers.Authorization,'Bearer '+TOKEN,'the edited upload stays owner-bound');

  await until(()=>entry.$('hosted-ai-role').value==='blue','the role switches to BLUE');
  assert.match(entry.text('hosted-ai-file-status'),new RegExp(EDITED_SHA));
  assert.match(entry.text('hosted-ai-file-status'),/RED 수정본 입력/);
  assert.match(entry.text('hosted-ai-edited-status'),/BLUE 입력으로 등록했습니다/);
  assert.equal(entry.isVisible('hosted-ai-selection'),false,'the RED candidate editor is hidden after handoff');
  assert.equal(entry.isVisible('hosted-ai-handoff-context'),true);
  assert.match(entry.text('hosted-ai-handoff-context'),/수정본으로 BLUE 검토 중/);
  assert.equal(entry.text('hosted-ai-apply-status'),'','no mismatch warning for the expected handoff');
  assert.equal(entry.$('hosted-ai-prompt').value,'','the RED instruction is not carried over');

  const bluePrompt='Verify the edited paper independently.';
  setPrompt(entry,bluePrompt);
  entry.$('hosted-ai-run').click();
  await until(()=>flow.posts.some(body=>body.role==='blue'),'the BLUE job is submitted');
  const blue=flow.posts.find(body=>body.role==='blue');
  assert.equal(blue.uploadId,EDITED_UPLOAD);
  assert.equal(blue.prompt,bluePrompt);
  assert.equal(blue.useEvidence,true);
  for(const key of ['edits','visualEdits','applyOnly','result','candidates','review','rationale','gold','approvedEdits']){
    assert.ok(!Object.hasOwn(blue,key),'BLUE body has no '+key);
  }
  assert.ok(!Object.hasOwn(blue,'ownerId')&&!Object.hasOwn(blue,'owner'),'the browser never names an owner');
  const serialized=JSON.stringify(blue);
  assert.ok(!serialized.includes(RED_RATIONALE),'no RED rationale in the BLUE request');
  assert.ok(!serialized.includes(RED_BEFORE_1),'no RED candidate text in the BLUE request');
  assert.equal(flow.uploads.length,2,'BLUE reuses the uploaded edited bytes instead of re-uploading');

  await until(()=>entry.$('hosted-ai-input-actions').hidden===false,'the original input can be restored');
  entry.$('hosted-ai-restore-original').click();
  await until(()=>entry.$('hosted-ai-role').value==='red','restoring returns to RED');
  assert.equal(entry.isVisible('hosted-ai-selection'),true,'the RED editor returns with the original input');
  assert.equal(entry.isVisible('hosted-ai-handoff-context'),false);
  assert.match(entry.text('hosted-ai-file-status'),new RegExp(SHA));
  assert.equal(entry.$('hosted-ai-prompt').value,'');
  assert.match(entry.text('hosted-ai-edited-status'),/원본 입력으로 돌아왔습니다/);
});

test('structured evidence is on by default and the advanced opt-out changes the request key',async()=>{
  const router=makeRouter({
    jobsPost:()=>({status:202,body:{job:job({state:'completed',result:null}),replayed:false}}),
    jobGet:()=>({status:200,body:{job:job({state:'completed'})}})
  });
  const entry=setup({routes:router});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  assert.equal(entry.$('hosted-ai-advanced').tagName,'DETAILS');
  assert.equal(entry.$('hosted-ai-advanced').getAttribute('open'),null,'advanced settings stay collapsed');
  assert.equal(entry.$('hosted-ai-use-evidence').checked,true);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>entry.calls.filter(call=>call.path==='/v1/ai/jobs').length===1,'first review submitted');
  const first=JSON.parse(entry.calls.filter(call=>call.path==='/v1/ai/jobs')[0].body);
  assert.equal(first.useEvidence,true);

  const box=entry.$('hosted-ai-use-evidence');
  box.checked=false;
  box.dispatchEvent(new Event('change'));
  setPrompt(entry,PROMPT+' (text only)');
  entry.$('hosted-ai-run').click();
  await until(()=>entry.calls.filter(call=>call.path==='/v1/ai/jobs').length===2,'second review submitted');
  const posts=entry.calls.filter(call=>call.path==='/v1/ai/jobs');
  const second=JSON.parse(posts[1].body);
  assert.equal(second.useEvidence,false);
  assert.notEqual(second.idempotencyKey,first.idempotencyKey,'the evidence switch is part of the key');
});

test('reload restores the applied job and RED candidates without a second apply submission',async()=>{
  const shared=new Map();
  const first=editFlow({store:shared});
  const entry=first.entry;
  await startReview(entry);
  checkCandidate(entry,'hosted-ai-candidate-0');
  checkCandidate(entry,'hosted-ai-visual-0');
  await applySelected(entry);
  const applyKey=first.posts[1].idempotencyKey;
  const applyRun=Object.values(runsOf(shared).runs).find(run=>run.kind==='apply');
  assert.equal(applyRun.jobId,'job-apply');
  entry.app.destroy();

  const second=editFlow({store:shared,router:{
    jobGet:record=>{
      if(record.path==='/v1/ai/jobs/job-apply') return {status:200,body:{job:applyJob()}};
      if(record.path==='/v1/ai/jobs/job-red') return {status:200,body:{job:reviewJob()}};
      return {status:404,body:{error:{code:'not_found'}}};
    }
  }});
  await second.entry.app.ready;
  assert.equal(second.posts.length,0,'a reload never resubmits the apply job');
  await until(()=>second.entry.isVisible('hosted-ai-edited-section'),'the applied PDF is restored');
  await until(()=>second.entry.isVisible('hosted-ai-selection'),'RED candidates are restored from the stored review job');
  assert.equal(Object.values(runsOf(shared).runs).find(run=>run.kind==='apply').key,applyKey);
  assert.equal(second.entry.calls.filter(call=>call.path==='/v1/ai/jobs').length,0);
  assert.ok(second.entry.calls.some(call=>call.path==='/v1/ai/jobs/job-red'&&call.method==='GET'));;
  const uploadsBefore=second.entry.calls.filter(call=>call.path==='/v1/ai/uploads').length;
  second.entry.$('hosted-ai-blue-handoff').click();
  await until(()=>second.entry.calls.filter(call=>call.path==='/v1/ai/uploads').length===uploadsBefore+1,
    'the restored edited PDF can be handed off');
});

test('candidates the gateway would reject are not offered for apply',async()=>{
  const skippedResult={
    schema:'falsify.document-red.v1',status:'ok',
    coverage:{complete:true,resultCoverage:{accepted:1,rejected:0,unresolved:0}},
    candidates:[
      {id:'ok',segmentId:'p1-b1',before:'valid original',after:'valid replacement'},
      {id:'bad-segment',segmentId:'page-1',before:'nope',after:'nope two'},
      {id:'noop',segmentId:'p1-b1',before:'same text',after:'same text'},
      {id:'toolong',segmentId:'p1-b1',before:'x'.repeat(4001),after:'short'},
      {id:'multiline',segmentId:'p1-b2',before:'line one\nline two',after:'merged line'}
    ],
    visualEdits:[
      {kind:'chart-point',itemId:'fig-1',seriesId:'s',pointIndex:0,beforeY:1,afterY:2,rationale:'chart rationale'},
      {kind:'table-cell',itemId:'tbl-1',row:0,column:0,before:'4.2',after:'5.8'},
      {kind:'table-cell',itemId:'tbl-2',row:1,column:1,before:'7',after:'9',rationale:'line one\nline two'}
    ]
  };
  const router=makeRouter({
    jobsPost:()=>({status:202,body:{job:job({id:'job-red-skip',state:'completed',result:skippedResult}),replayed:false}})
  });
  const entry=setup({routes:router});
  await startReview(entry);
  const boxes=[...entry.$('hosted-ai-candidates').walk()].filter(node=>node.tagName==='INPUT');
  assert.equal(boxes.length,1,'only the submittable candidate is offered');
  assert.match(entry.text('hosted-ai-chart-note'),/1건/);
  assert.match(entry.text('hosted-ai-selection-note'),/5개 후보는/);
  const visualBoxes=[...entry.$('hosted-ai-visual-candidates').walk()].filter(node=>node.tagName==='INPUT');
  assert.equal(visualBoxes.length,1,'only the table-cell with a usable rationale is offered');
  assert.match(entry.text('hosted-ai-visual-candidates'),/tbl-2/);
  assert.ok(!entry.text('hosted-ai-visual-candidates').includes('tbl-1'),'a rationale-less cell is hidden');
  checkCandidate(entry,boxes[0].id);
  checkCandidate(entry,visualBoxes[0].id);
  entry.$('hosted-ai-apply').click();
  await until(()=>entry.calls.filter(call=>call.path==='/v1/ai/jobs').length===2,'the valid candidate is applied');
  const apply=JSON.parse(entry.calls.filter(call=>call.path==='/v1/ai/jobs')[1].body);
  assert.deepEqual(apply.edits,[{pageIndex:0,before:'valid original',after:'valid replacement',occurrence:0}]);
  assert.deepEqual(apply.visualEdits,[{kind:'table-cell',itemId:'tbl-2',row:1,column:1,
    before:'7',after:'9',rationale:'line one line two'}]);
  assert.equal(apply.useEvidence,true,'a selected table edit needs structured evidence');
  assert.equal(apply.model,'claude-opus-5-5');
  assert.equal(apply.effort,'high');
});

test('an apply-only job is polled until the edited PDF appears',async()=>{
  let applyPolls=0;
  const router=makeRouter({
    jobsPost:record=>{
      const body=JSON.parse(record.body);
      if(body.applyOnly===true){
        return {status:202,body:{job:job({id:'job-apply-poll',role:'red',state:'queued',
          progress:{completedCalls:0,requiredCalls:0,phase:'applying'},
          model:undefined,effort:undefined,result:null,artifacts:[]}),replayed:false}};
      }
      return {status:202,body:{job:reviewJob(),replayed:false}};
    },
    jobGet:record=>{
      if(record.path!=='/v1/ai/jobs/job-apply-poll') return {status:404,body:{error:{code:'not_found'}}};
      applyPolls++;
      const done=applyPolls>=2;
      return {status:200,body:{job:job({id:'job-apply-poll',role:'red',state:done?'completed':'running',
        progress:{completedCalls:0,requiredCalls:0,phase:'applying'},
        model:undefined,effort:undefined,result:null,
        artifacts:done?[EDITED_ARTIFACT]:[]})}};
    }
  });
  const entry=setup({routes:router});
  await startReview(entry);
  checkCandidate(entry,'hosted-ai-candidate-0');
  entry.$('hosted-ai-apply').click();
  await until(()=>entry.isVisible('hosted-ai-edited-section'),'apply polling reaches the edited PDF');
  assert.ok(applyPolls>=2,'the apply job was polled at least twice');
  assert.equal(entry.calls.filter(call=>call.path==='/v1/ai/jobs').length,2,'only review and apply were submitted');
});

test('hosted intake accepts PDF bytes only and rejects text files client-side',async()=>{
  const entry=setup({routes:makeRouter({jobGet:()=>({status:200,body:{job:job({state:'completed'})}})})});
  await entry.app.ready;
  await signIn(entry);
  assert.equal(entry.$('hosted-ai-file').getAttribute('accept'),'.pdf,application/pdf');
  assert.match(entry.text('hosted-ai-file-hint'),/PDF만 지원/);
  const input=entry.$('hosted-ai-file');
  const text=Buffer.from('# synthetic notes\nnot a paper\n');
  input.files=[{name:'notes.md',size:text.length,type:'text/markdown',
    arrayBuffer:async()=>text.buffer.slice(text.byteOffset,text.byteOffset+text.length)}];
  input.dispatchEvent(new Event('change'));
  await until(()=>/PDF/.test(entry.text('hosted-ai-error')),'the non-PDF file is rejected');
  assert.match(entry.text('hosted-ai-file-status'),/PDF/);
  setPrompt(entry,PROMPT);
  assert.equal(entry.$('hosted-ai-run').disabled,true);
  entry.$('hosted-ai-run').click();
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(entry.calls.some(call=>call.path==='/v1/ai/uploads'),false,'no upload is attempted');
  assert.equal(entry.calls.some(call=>call.path==='/v1/ai/jobs'),false,'no job is attempted');
  await selectFile(entry,BYTES);
  assert.equal(entry.$('hosted-ai-run').disabled,false,'a real PDF is still accepted');
});

test('a server 415 is explained as PDF-only',async()=>{
  const entry=setup({routes:makeRouter({
    uploads:()=>({status:415,body:{error:{code:'unsupported_media_type',retryable:false}}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/PDF만 지원/.test(entry.text('hosted-ai-error')),'415 is explained');
});

test('a 401 on job submit ends the session and clears the stored token',async()=>{
  const entry=setup({routes:makeRouter({
    jobsPost:()=>({status:401,body:{error:{code:'unauthorized',retryable:false}}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/세션이 끝났습니다/.test(entry.text('hosted-ai-error')),'401 ends the session');
  assert.equal(entry.store.has(SESSION_KEY),false);
  assert.equal(entry.$('hosted-ai-login-form').hidden,false);
  assert.equal(entry.$('hosted-ai-config').hidden,true);
});

test('a 401 on an artifact download ends the session instead of leaving a signed-in panel',async()=>{
  const flow=editFlow({router:{
    artifact:()=>({status:401,body:{error:{code:'unauthorized',retryable:false}}})
  }});
  const entry=flow.entry;
  await startReview(entry);
  checkCandidate(entry,'hosted-ai-candidate-0');
  await applySelected(entry);
  entry.$('hosted-ai-edited-download').click();
  await until(()=>/세션이 끝났습니다/.test(entry.text('hosted-ai-error')),'artifact 401 ends the session');
  assert.equal(entry.store.has(SESSION_KEY),false);
  assert.equal(entry.$('hosted-ai-login-form').hidden,false);
});

test('a 429 submission is reported once without an automatic retry',async()=>{
  const entry=setup({routes:makeRouter({
    jobsPost:()=>({status:429,body:{error:{code:'rate_limited',retryable:true}}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/요청이 너무 많습니다/.test(entry.text('hosted-ai-error')),'429 is explained');
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(entry.calls.filter(call=>call.path==='/v1/ai/jobs'&&call.method==='POST').length,1,
    'a rate limit is not retried automatically');
});

test('verified PDF bytes are declared as application/pdf even if the browser reports another type',async()=>{
  const entry=setup({routes:makeRouter()});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES,{name:'Synthetic paper.pdf',type:'text/plain'});
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>entry.calls.some(call=>call.path==='/v1/ai/jobs'&&call.method==='POST'),'job submitted');
  const upload=entry.calls.find(call=>call.path==='/v1/ai/uploads');
  assert.equal(upload.headers['Content-Type'],'application/pdf');
});

test('applying RED candidates requires the RED source file, not a newly selected one',async()=>{
  const flow=editFlow();
  const entry=flow.entry;
  await startReview(entry);
  checkCandidate(entry,'hosted-ai-candidate-0');
  const other=Buffer.from('%PDF-1.7 synthetic other paper\n%%EOF\n');
  await selectFile(entry,other,{name:'Other paper.pdf'});
  assert.equal(entry.$('hosted-ai-apply').disabled,true);
  assert.match(entry.text('hosted-ai-apply-status'),/RED 원본과 다릅니다/);
  entry.$('hosted-ai-apply').click();
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(flow.posts.filter(body=>body.applyOnly===true).length,0,'no apply job is sent for another file');
});
test('queued and running jobs do not present placeholder usage as provider-reported',async()=>{
  const zeroUsage={inputTokens:0,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0};
  const entry=setup({routes:makeRouter({
    jobsPost:()=>({status:202,body:{job:job({state:'queued',usage:zeroUsage}),replayed:false}}),
    jobGet:()=>({status:200,body:{job:job({state:'running',usage:zeroUsage})}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/아직 보고되지 않음/.test(entry.text('hosted-ai-job-usage')),'placeholder usage is not reported');
  assert.ok(!/입력 0|출력 0/.test(entry.text('hosted-ai-job-usage')));
  entry.app.destroy();
});
test('reload after handoff keeps the edited upload as the BLUE input',async()=>{
  const shared=new Map();
  const first=editFlow({store:shared});
  await startReview(first.entry);
  checkCandidate(first.entry,'hosted-ai-candidate-0');
  await applySelected(first.entry);
  first.entry.$('hosted-ai-blue-handoff').click();
  await until(()=>first.uploads.length===2,'the edited upload is registered');
  first.entry.app.destroy();

  const second=editFlow({store:shared,router:{
    jobGet:record=>{
      if(record.path==='/v1/ai/jobs/job-apply') return {status:200,body:{job:applyJob()}};
      if(record.path==='/v1/ai/jobs/job-red') return {status:200,body:{job:reviewJob()}};
      return {status:404,body:{error:{code:'not_found'}}};
    }
  }});
  await second.entry.app.ready;
  await until(()=>new RegExp(EDITED_SHA).test(second.entry.text('hosted-ai-file-status')),
    'the edited upload is restored from sessionStorage');
  assert.match(second.entry.text('hosted-ai-file-status'),/RED 수정본 입력/);
  const uploadsBefore=second.uploads.length;
  second.entry.$('hosted-ai-role').value='blue';
  second.entry.$('hosted-ai-role').dispatchEvent(new Event('change'));
  setPrompt(second.entry,'Verify the edited paper independently.');
  second.entry.$('hosted-ai-run').click();
  await until(()=>second.posts.some(body=>body.role==='blue'),'the BLUE job starts from the restored input');
  const blue=second.posts.find(body=>body.role==='blue');
  assert.equal(blue.uploadId,EDITED_UPLOAD);
  assert.equal(second.uploads.length,uploadsBefore,'the existing edited upload is reused');
});
test('apply-only jobs send resolved model/effort and derive a new key when the defaults change',async()=>{
  const first=editFlow();
  await startReview(first.entry);
  checkCandidate(first.entry,'hosted-ai-candidate-0');
  await applySelected(first.entry);
  const applyA=first.posts.find(body=>body.applyOnly===true);
  assert.ok(applyA,'the first apply job is submitted');
  assert.equal(applyA.model,'claude-opus-5-5');
  assert.equal(applyA.effort,'high');

  const changedCaps={...CAPS,models:['claude-sonnet-5-5','claude-opus-5-5'],efforts:['low','medium']};
  const second=editFlow({router:{caps:changedCaps}});
  await startReview(second.entry);
  checkCandidate(second.entry,'hosted-ai-candidate-0');
  await applySelected(second.entry);
  const applyB=second.posts.find(body=>body.applyOnly===true);
  assert.ok(applyB,'the second apply job is submitted');
  assert.equal(applyB.model,'claude-sonnet-5-5');
  assert.equal(applyB.effort,'low');
  assert.notEqual(applyB.idempotencyKey,applyA.idempotencyKey,
    'a changed default model/effort derives a different apply key');
  assert.equal(JSON.stringify(applyB.edits),JSON.stringify(applyA.edits),
    'only the resolved defaults changed between the two apply requests');
});
test('terminal jobs never show stale in-progress counters or phases',async()=>{
  const entry=setup({routes:makeRouter({
    jobsPost:()=>({status:202,body:{job:job({id:'job-stale',state:'completed',
      progress:{completedCalls:0,requiredCalls:1,phase:'검토 중'},usage:null}),replayed:false}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/완료/.test(entry.text('hosted-ai-job-state')),'job completes');
  assert.equal(entry.$('hosted-ai-job-progress').textContent,'','stale terminal progress is hidden');
  assert.equal(entry.text('hosted-ai-progress'),entry.text('hosted-ai-job-state'),
    'the live region shows only the terminal state');
  assert.ok(!/완료 호출|단계/.test(entry.text('hosted-ai-progress')));
});

test('terminal jobs show server-supplied final progress and usage',async()=>{
  const entry=setup({routes:makeRouter({
    jobsPost:()=>({status:202,body:{job:job({id:'job-final',state:'completed',
      progress:{completedCalls:3,requiredCalls:3,phase:'completed'},
      usage:{inputTokens:5,outputTokens:7,cacheReadInputTokens:0,cacheCreationInputTokens:0}}),replayed:false}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/완료/.test(entry.text('hosted-ai-job-state')),'job completes');
  assert.match(entry.text('hosted-ai-job-progress'),/완료 호출 3 \/ 3/);
  assert.match(entry.text('hosted-ai-job-progress'),/단계 completed/);
  assert.match(entry.text('hosted-ai-job-usage'),/입력 5/);
  assert.match(entry.text('hosted-ai-job-usage'),/출력 7/);
});

test('terminal progress with requiredCalls 0 hides the call counts',async()=>{
  const entry=setup({routes:makeRouter({
    jobsPost:()=>({status:202,body:{job:job({id:'job-zero',role:'red',state:'completed',
      progress:{completedCalls:0,requiredCalls:0,phase:'completed'},
      model:undefined,effort:undefined,usage:null,result:null,artifacts:[]}),replayed:false}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  entry.$('hosted-ai-run').click();
  await until(()=>/완료/.test(entry.text('hosted-ai-job-state')),'job completes');
  assert.equal(entry.text('hosted-ai-job-progress'),'단계 completed');
  assert.ok(!/완료 호출/.test(entry.text('hosted-ai-job-progress')));
});

test('the prompt limit follows capabilities and allows 9000 characters when the server does',async()=>{
  const caps={...CAPS,limits:{maxUploadBytes:33554432,maxPromptChars:32000}};
  const entry=setup({routes:makeRouter({
    caps,
    jobsPost:()=>({status:202,body:{job:job({state:'completed'}),replayed:false}})
  })});
  await entry.app.ready;
  await signIn(entry);
  await selectFile(entry,BYTES);
  assert.match(entry.text('hosted-ai-prompt-label'),/32000/);
  assert.match(entry.text('hosted-ai-prompt-count'),/0 \/ 32000/);
  setPrompt(entry,'x'.repeat(9000));
  assert.match(entry.text('hosted-ai-prompt-count'),/9000 \/ 32000/);
  assert.equal(entry.$('hosted-ai-run').disabled,false,'9000 characters is allowed by the server limit');
  entry.$('hosted-ai-run').click();
  await until(()=>entry.calls.some(call=>call.path==='/v1/ai/jobs'&&call.method==='POST'),'job submitted');
  const body=JSON.parse(entry.calls.find(call=>call.path==='/v1/ai/jobs'&&call.method==='POST').body);
  assert.equal(body.prompt.length,9000);
});

test('the prompt limit falls back to 32000 when capabilities omit it',async()=>{
  const caps={...CAPS,limits:{}};
  const entry=setup({routes:makeRouter({caps})});
  await entry.app.ready;
  await signIn(entry);
  assert.match(entry.text('hosted-ai-prompt-label'),/32000/);
  assert.match(entry.text('hosted-ai-prompt-count'),/0 \/ 32000/);
});
test('invite registration adopts the returned session immediately',async()=>{
  const entry=setup({routes:makeRouter()});
  await entry.app.ready;
  assert.equal(entry.$('hosted-ai-register-panel').hidden,false);
  assert.equal(entry.$('hosted-ai-register-panel').getAttribute('open'),null,
    'registration stays collapsed under the primary login');
  fillRegistration(entry);
  entry.$('hosted-ai-register').click();
  await until(()=>entry.store.has(SESSION_KEY),'session stored');
  const call=entry.calls.find(item=>item.path==='/v1/auth/register');
  assert.equal(call.method,'POST');
  assert.equal(call.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(call.body),{
    username:'invited_user',password:'correct horse battery',
    displayName:'Invited Reviewer',inviteCode:INVITE
  });
  assert.equal(entry.$('hosted-ai-login-form').hidden,true);
  assert.equal(entry.$('hosted-ai-register-panel').hidden,true);
  await until(()=>entry.isVisible('hosted-ai-config'),'config opens after registration');
  const probes=entry.calls.filter(item=>item.path==='/v1/ai/capabilities');
  assert.equal(probes.at(-1).headers.Authorization,'Bearer '+TOKEN);
  assert.match(entry.text('hosted-ai-session'),/Invited Reviewer/);
  for(const id of ['hosted-ai-register-username','hosted-ai-register-password',
    'hosted-ai-register-display-name','hosted-ai-register-invite']){
    assert.equal(entry.$(id).value,'','registration fields are cleared after success');
  }
  const stored=entry.storedText(),dom=entry.doc.body.textContent;
  assert.ok(!stored.includes('correct horse battery'),'password is never persisted');
  assert.ok(!stored.includes(INVITE),'invite code is never persisted');
  assert.ok(!dom.includes('correct horse battery'),'password is never rendered as text');
  assert.ok(!dom.includes(INVITE),'invite code is never rendered as text');
  await selectFile(entry,BYTES);
  setPrompt(entry,PROMPT);
  assert.equal(entry.$('hosted-ai-run').disabled,false,'registration leaves the panel run-ready');
});

test('an invalid invitation shows a fixed error, preserves drafts and creates no session',async()=>{
  const entry=setup({routes:makeRouter({
    register:()=>({status:403,body:{error:{code:'invalid_invitation',
      message:'SECRET_INVITE_DETAIL',retryable:false}}})
  })});
  await entry.app.ready;
  fillRegistration(entry);
  entry.$('hosted-ai-register').click();
  await until(()=>/초대 코드/.test(entry.text('hosted-ai-register-status')),'fixed invitation error');
  assert.equal(entry.store.has(SESSION_KEY),false);
  assert.equal(entry.$('hosted-ai-login-form').hidden,false);
  assert.equal(entry.$('hosted-ai-register-panel').hidden,false);
  assert.equal(entry.$('hosted-ai-register-password').value,'correct horse battery',
    'draft password is preserved on failure');
  assert.equal(entry.$('hosted-ai-register-invite').value,INVITE,
    'draft invite is preserved on failure');
  assert.equal(entry.$('hosted-ai-register-username').value,'invited_user');
  assert.ok(!entry.doc.body.textContent.includes('SECRET_INVITE_DETAIL'));
  assert.ok(!entry.storedText().includes('correct horse battery'));
  assert.match(entry.$('hosted-ai-register-status').className,/error/);
});

test('registration failures use concise fixed messages and never create a session',async()=>{
  const cases=[
    [400,/가입 정보/],
    [401,/가입 정보/],
    [409,/이미 사용 중/],
    [410,/초대 가입/],
    [429,/요청이 너무 많습니다/]
  ];
  for(const [status,pattern] of cases){
    const entry=setup({routes:makeRouter({
      register:()=>({status,body:{error:{code:'fixed',message:'SERVER_DETAIL',retryable:false}}})
    })});
    await entry.app.ready;
    fillRegistration(entry);
    entry.$('hosted-ai-register').click();
    await until(()=>pattern.test(entry.text('hosted-ai-register-status')),'message for '+status);
    assert.equal(entry.store.has(SESSION_KEY),false,'no session for '+status);
    assert.equal(entry.$('hosted-ai-login-form').hidden,false,'login stays for '+status);
    assert.ok(!entry.doc.body.textContent.includes('SERVER_DETAIL'),'server text is not echoed');
  }
});

test('registration validates the existing username and 12-character password rules first',async()=>{
  const entry=setup({routes:makeRouter()});
  await entry.app.ready;
  fillRegistration(entry,{username:'ab'});
  entry.$('hosted-ai-register').click();
  await until(()=>/3–32/.test(entry.text('hosted-ai-register-status')),'username rule');
  assert.equal(entry.calls.some(call=>call.path==='/v1/auth/register'),false);
  fillRegistration(entry,{username:'invited_user',password:'short'});
  entry.$('hosted-ai-register').click();
  await until(()=>/12자 이상/.test(entry.text('hosted-ai-register-status')),'password rule');
  assert.equal(entry.calls.some(call=>call.path==='/v1/auth/register'),false);
  assert.equal(entry.$('hosted-ai-register-username').value,'invited_user');
  assert.equal(entry.$('hosted-ai-register-password').value,'short','draft is preserved');
});

test('model and effort controls live inside the existing advanced section',async()=>{
  const entry=setup({routes:makeRouter()});
  await entry.app.ready;
  await signIn(entry);
  const advanced=entry.$('hosted-ai-advanced');
  assert.equal(advanced.tagName,'DETAILS');
  assert.equal(advanced.getAttribute('open'),null,'advanced settings stay collapsed');
  const inside=node=>{
    for(let parent=node;parent;parent=parent.parent) if(parent===advanced) return true;
    return false;
  };
  assert.ok(inside(entry.$('hosted-ai-model')),'model select is inside the advanced section');
  assert.ok(inside(entry.$('hosted-ai-effort')),'effort select is inside the advanced section');
  assert.ok(!inside(entry.$('hosted-ai-role')),'role stays primary');
  assert.ok(!inside(entry.$('hosted-ai-prompt')),'prompt stays primary');
});
test('registration omits an empty optional display name',async()=>{
  const entry=setup({routes:makeRouter()});
  await entry.app.ready;
  const order=entry.host.children.map(node=>node.id);
  assert.ok(order.indexOf('hosted-ai-login-form')<order.indexOf('hosted-ai-register-panel'),
    'registration sits under the primary login');
  fillRegistration(entry,{displayName:''});
  entry.$('hosted-ai-register').click();
  await until(()=>entry.store.has(SESSION_KEY),'session stored');
  const body=JSON.parse(entry.calls.find(item=>item.path==='/v1/auth/register').body);
  assert.deepEqual(Object.keys(body).sort(),['inviteCode','password','username']);
});
