'use strict';
// Hosted paper session: route body, bearer, bridge-shaped errors, abort, and no guest mint on load.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const hostedSource=await readFile(fileURLToPath(new URL('../dist/hosted-ai.js',import.meta.url)),'utf8');
const sessionSource=await readFile(fileURLToPath(new URL('../dist/hosted-paper-session.js',import.meta.url)),'utf8');
const TOKEN='fss_'+'A'.repeat(43);
const GUEST='fsg_'+'b'.repeat(43);
const FUTURE=new Date(Date.now()+864e5).toISOString();
const CAPS={enabled:true,provider:'anthropic',execution:'server',models:['claude-sonnet-5-5'],efforts:['high'],
  limits:{maxUploadBytes:33554432,maxPromptChars:8000}};

class El extends EventTarget{
  constructor(tag){
    super();
    Object.assign(this,{tagName:String(tag).toUpperCase(),children:[],parent:null,attrs:{},dataset:{},_text:'',
      id:'',className:'',value:'',checked:false,disabled:false,hidden:false,type:'',files:[]});
  }
  get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');}
  set textContent(value){this.children=[];this._text=String(value);}
  append(...kids){for(const kid of kids){if(kid&&typeof kid==='object')kid.parent=this;this.children.push(kid);}}
  replaceChildren(...kids){this.textContent='';this.append(...kids);}
  setAttribute(key,value){this.attrs[key]=String(value);if(key==='id')this.id=String(value);}
  getAttribute(key){return Object.prototype.hasOwnProperty.call(this.attrs,key)?this.attrs[key]:null;}
  *walk(){yield this;for(const child of this.children) if(child&&typeof child==='object'&&child.walk) yield* child.walk();}
  querySelector(selector){
    if(typeof selector!=='string'||!selector.startsWith('#')) return null;
    const id=selector.slice(1);
    for(const node of this.walk()) if(node.id===id) return node;
    return null;
  }
}
function makeDocument(){
  const doc=new EventTarget();
  const body=new El('body');
  doc.body=body;
  doc.activeElement=body;
  doc.readyState='complete';
  doc.createElement=tag=>new El(tag);
  doc.getElementById=id=>body.querySelector('#'+id);
  return doc;
}
function storageStub(map){
  return {getItem:key=>map.has(key)?map.get(key):null,setItem:(key,value)=>{map.set(key,String(value));},removeItem:key=>{map.delete(key);}};
}
function boot(options={}){
  const calls=[];
  const events=[];
  const doc=makeDocument();
  doc.addEventListener('falsify:hosted-paper',()=>events.push('falsify:hosted-paper'));
  const host=new El('section');
  host.id='hosted-ai';
  doc.body.append(host);
  const fetchStub=async(url,init={})=>{
    const record={url:String(url),path:new URL(url).pathname,method:String(init.method||'GET').toUpperCase(),
      headers:Object.assign({},init.headers||{}),body:init.body,signal:init.signal};
    calls.push(record);
    if(init.signal?.aborted) throw Object.assign(Error('aborted'),{name:'AbortError'});
    const route=options.routes?options.routes(record):{status:404,body:{error:{code:'not_found'}}};
    if(route==='hang') return new Promise((resolve,reject)=>{
      if(init.signal) init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));
    });
    return {
      ok:route.status>=200&&route.status<300,
      status:route.status,
      redirected:false,
      type:'basic',
      headers:{get(){return null;}},
      json:async()=>route.body,
      text:async()=>JSON.stringify(route.body??null)
    };
  };
  const mints={count:0};
  const config=options.config||Object.freeze({
    apiBase:'https://worker.test',provider:'confluence',
    hostedAi:Object.freeze({enabled:true,apiBase:'https://worker.test'})
  });
  const context={
    console,URL,Event,CustomEvent,setTimeout,clearTimeout,TextEncoder,AbortController,crypto:globalThis.crypto,
    fetch:fetchStub
  };
  vm.createContext(context);
  vm.runInContext(hostedSource,context,{filename:'hosted-ai.js'});
  vm.runInContext(sessionSource,context,{filename:'hosted-paper-session.js'});
  const app=context.FalsifyHostedAI.create({
    document:doc,host,fetch:fetchStub,storage:storageStub(options.store||new Map()),crypto:globalThis.crypto,
    URL,TextEncoder,AbortController,
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(Number(ms)||0,15)),clearTimeout,
    config:()=>config,
    sessionProvider:options.sessionProvider||(()=>({token:async()=>{mints.count++;return GUEST;}}))
  });
  return {app,calls,events,mints,context,destroy:()=>app.destroy()};
}
const until=async(predicate,label)=>{
  for(let i=0;i<600&&!predicate();i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(predicate(),label);
};
const live=[];
test.after(()=>{for(const entry of live){try{entry.destroy();}catch{}}});

test('paper tools absent keeps the session unavailable and does not mint a guest',async()=>{
  const entry=boot({sessionProvider:()=>null});
  live.push(entry);
  await entry.app.ready;
  assert.equal(entry.mints.count,0);
  assert.equal(entry.context.FalsifyHostedPaperSession.available(),false);
  assert.equal(entry.context.FalsifyHostedPaperSession.session(),null);
  assert.equal(entry.context.FalsifyHostedPaperSession.capabilities(),null);
  assert.equal(entry.events.length,0);
  assert.equal(entry.calls.some(call=>call.path==='/v1/ai/guest'),false);
});

test('open mode mints the guest on the first paperAuth only',async()=>{
  const entry=boot({config:Object.freeze({
    apiBase:'https://worker.test',provider:'confluence',
    hostedAi:Object.freeze({enabled:true,apiBase:'https://worker.test'}),
    openAccess:Object.freeze({enabled:true})
  }),routes:()=>({status:200,body:Object.assign({},CAPS,{paperTools:{enabled:true}})})});
  live.push(entry);
  await entry.app.ready;
  assert.equal(entry.mints.count,0,'page load does not mint');
  await until(()=>entry.context.FalsifyHostedPaperSession.available(),'paper tools');
  const first=await entry.context.FalsifyHostedAI.paperAuth();
  assert.equal(entry.mints.count,1);
  assert.deepEqual(Object.keys(first).sort(),['apiBase','token']);
  assert.equal(first.apiBase,'https://worker.test');
  assert.equal(first.token,GUEST);
  const second=await entry.context.FalsifyHostedAI.paperAuth();
  assert.equal(entry.mints.count,1,'a later paper call reuses the guest');
  assert.equal(second.token,GUEST);
});

test('a stored member session is reused and paper calls post path plus body',async()=>{
  const store=new Map();
  store.set('falsify.hosted-ai.session.v1',JSON.stringify({apiBase:'https://worker.test',token:TOKEN,expiresAt:FUTURE}));
  const file='Q'.repeat(4000);
  let hung;
  const entry=boot({
    store,
    sessionProvider:()=>null,
    routes(record){
      if(record.path==='/v1/ai/capabilities') return {status:200,body:Object.assign({},CAPS,{paperTools:{enabled:true,analysis:false,visualEditor:true}})};
      if(record.path==='/v1/ai/paper'){
        const body=JSON.parse(record.body);
        if(body.path==='/api/paper/evidence/jobs/'+'ab'.repeat(16)) return 'hang';
        if(body.path==='/api/paper/evidence/prepare') return {status:400,body:{error:{code:'paper_evidence_expired_or_missing'}}};
        if(body.path==='/api/paper/visual/export') return {status:200,body:{schema:'falsify.visual-edit-export.v1',ok:true}};
        return {status:200,body:{ok:true,path:body.path}};
      }
      return {status:404,body:{error:{code:'not_found'}}};
    }
  });
  live.push(entry);
  await entry.app.ready;
  await until(()=>entry.context.FalsifyHostedPaperSession.available(),'member paper tools');
  assert.equal(entry.events.length,1);
  const caps=entry.context.FalsifyHostedPaperSession.capabilities();
  assert.equal(caps.visualEditor.supported,true);
  assert.equal(caps.paperEnrichment.supported,false);
  assert.equal(caps.paperEnrichment.runtimeConfigured,false);
  assert.equal(caps.chartEditor.available,true);
  const auth=await entry.context.FalsifyHostedAI.paperAuth();
  assert.equal(auth.token,TOKEN);
  const session=entry.context.FalsifyHostedPaperSession.session();
  const poll='/api/paper/evidence/jobs/'+'cd'.repeat(16);
  const polled=await session.request(poll,null);
  const posted=entry.calls.filter(call=>call.path==='/v1/ai/paper').at(-1);
  assert.equal(posted.method,'POST');
  assert.equal(posted.headers.Authorization,'Bearer '+TOKEN);
  assert.equal(posted.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(posted.body),{path:poll,body:null});
  assert.equal(polled.ok,true);
  await assert.rejects(session.request('/api/paper/evidence/prepare',{fileHash:'ab',file}),error=>{
    assert.equal(error.httpStatus,400);
    assert.equal(error.code,'paper_evidence_expired_or_missing');
    assert.equal(error.message,'paper_evidence_expired_or_missing');
    return true;
  });
  const exported=await session.request('/api/paper/visual/export',{file,schema:'falsify.visual-edit-request.v1'});
  assert.equal(exported.ok,true);
  const raw=entry.calls.filter(call=>call.path==='/v1/ai/paper').at(-1).body;
  assert.equal(raw.split(file).length,2,'the PDF body is serialized once');
  await assert.rejects(session.request('/api/blue/jobs',{}),/허용되지 않은 로컬 경로/);
  assert.equal(entry.calls.filter(call=>call.path==='/v1/ai/paper').length,3);
  const controller=new AbortController();
  hung=session.request('/api/paper/evidence/jobs/'+'ab'.repeat(16),null,{signal:controller.signal});
  controller.abort();
  await assert.rejects(hung,error=>error.name==='AbortError');
  const early=new AbortController();
  early.abort();
  await assert.rejects(session.request('/api/paper/evidence/query',{},{signal:early.signal}),error=>error.name==='AbortError');
});
