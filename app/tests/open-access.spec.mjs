'use strict';
// Open-access page behavior. Synthetic DOM, storage and fetch only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const source=await readFile(fileURLToPath(new URL('../dist/open-access.js',import.meta.url)),'utf8');
const html=await readFile(fileURLToPath(new URL('../dist/index.html',import.meta.url)),'utf8');
const css=await readFile(fileURLToPath(new URL('../dist/styles.css',import.meta.url)),'utf8');
const bridgeSource=await readFile(fileURLToPath(new URL('../dist/local-bridge.js',import.meta.url)),'utf8');
const L=require('../dist/local-bridge.js');
const A=require('../dist/auto-pair.js');
const TOKEN='fsg_'+'c'.repeat(43);
const KEY='booth-key';

function memoryStore(){
  const map=new Map();
  return {
    map,
    getItem:key=>map.has(key)?map.get(key):null,
    setItem:(key,value)=>{map.set(key,String(value));},
    removeItem:key=>{map.delete(key);}
  };
}
function load(options={}){
  const store=options.store||memoryStore();
  const calls=[];
  let release=null;
  const location={
    hash:options.hash===undefined?'#k='+KEY:options.hash,
    pathname:'/index.html',search:'',href:'https://example.test/index.html'
  };
  const history={replaceState(_state,_title,url){
    const next=new URL(String(url),location.href);
    location.assigned=next.pathname+next.search;
    location.hash='';
    location.pathname=next.pathname;
    location.search=next.search;
    location.href=next.href;
  }};
  const anchors={};
  function anchor(id){
    const node={
      id,children:[],nextElementSibling:null,
      after(child){child.previous=this;this.nextElementSibling=child;},
      insertBefore(child){this.children.unshift(child);},
      querySelector(selector){return selector==='[data-open-access-note]'?this.children.find(item=>item.note):null;},
      getAttribute(){return null;}
    };
    anchors[id]=node;
    return node;
  }
  anchor('hosted-ai');
  anchor('view-blue');
  const links=[{href:'http://127.0.0.1:7816/',removeAttribute(){this.href='';}}];
  const document={
    documentElement:{dataset:{}},
    getElementById:id=>anchors[id]||null,
    createElement(){return {className:'',textContent:'',note:true,setAttribute(){},getAttribute(name){return name==='data-open-access-note'?'':null;}};},
    querySelectorAll(selector){return selector==='[data-bridge-local]'?links:[];}
  };
  const fetchImpl=async(url,init={})=>{
    calls.push({url:String(url),init});
    if(options.hang) return new Promise(resolve=>{release=()=>resolve(options.response);});
    if(options.fetch) return options.fetch(url,init);
    return options.response;
  };
  const context={
    URL,URLSearchParams,JSON,Date,Math,Number,String,Object,Error,Promise,
    sessionStorage:store,
    location,history,document,fetch:fetchImpl,
    FalsifyCloudConfig:options.config
  };
  vm.createContext(context);
  vm.runInContext(source,context,{filename:'open-access.js'});
  return {context,store,calls,location,document,links,anchors,release:()=>release&&release()};
}
function openConfig(){
  return Object.freeze({
    apiBase:'https://worker.test',provider:'confluence',
    hostedAi:Object.freeze({enabled:true,apiBase:'https://worker.test'}),
    openAccess:Object.freeze({enabled:true})
  });
}
function guestResponse(token=TOKEN){
  return {
    ok:true,status:201,
    headers:{get(){return null;}},
    json:async()=>({guest:{token,expiresAt:new Date(Date.now()+3600_000).toISOString()}})
  };
}

test('open mode strips the fragment, keeps the key only in the guest body, and shares one request',async()=>{
  const page=load({config:openConfig(),response:guestResponse()});
  assert.equal(page.document.documentElement.dataset.openAccess,'');
  assert.equal(page.location.hash,'');
  assert.equal(page.location.assigned.includes(KEY),false);
  assert.equal(page.links[0].href,'');
  const session=page.context.FalsifyHostedSession;
  const first=session.token();
  const second=session.token();
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a,TOKEN);
  assert.equal(b,TOKEN);
  assert.equal(page.calls.length,1);
  assert.equal(page.calls[0].url,'https://worker.test/v1/ai/guest');
  assert.equal(page.calls[0].url.includes(KEY),false);
  assert.deepEqual(JSON.parse(page.calls[0].init.body),{accessKey:KEY});
  assert.equal(page.calls[0].init.body.includes('fsg_'),false);
  const stored=[...page.store.map.values()].join('\n');
  assert.equal(stored.includes(KEY),true);
  assert.equal(stored.includes(TOKEN),true);
  await session.token();
  assert.equal(page.calls.length,1,'a fresh token is reused');
  session.invalidate();
  await session.token();
  assert.equal(page.calls.length,2,'invalidate requests a new guest token');
  assert.equal(page.calls.some(call=>call.url.includes('127.0.0.1')),false);
});

test('an absent open-access flag does not install a session or touch the fragment',async()=>{
  const page=load({
    config:Object.freeze({apiBase:'https://worker.test',provider:'confluence',hostedAi:Object.freeze({enabled:true,apiBase:'https://worker.test'})}),
    hash:'#k='+KEY,
    response:guestResponse()
  });
  assert.equal(page.context.FalsifyHostedSession,undefined);
  assert.equal(page.document.documentElement.dataset.openAccess,undefined);
  assert.equal(page.location.hash,'#k='+KEY);
  assert.equal(page.calls.length,0);
  assert.equal(page.store.map.size,0);
});

test('the bridge and click pairing do not call loopback while open access is on',async()=>{
  globalThis.FalsifyCloudConfig=openConfig();
  try{
    const calls=[];
    const fetch=url=>{calls.push(String(url));return Promise.reject(new Error('network'));};
    const bridge=L.create({fetch,location:{hostname:'example.test',port:''},emit(){}});
    await bridge.ready;
    assert.equal((await bridge.pair('A'.repeat(32),'7816')).ok,false);
    assert.equal(bridge.launch('7816',()=>{calls.push('falsify');}).ok,false);
    const api=A.create({fetch,random(bytes){bytes.fill(7);},attempts:1,storage:memoryStore()});
    assert.equal((await api.begin({bridge,port:'7816',open:()=>{calls.push('falsify');}})).skipped,true);
    assert.equal((await api.refresh(bridge)).skipped,true);
    assert.equal(calls.some(item=>item.includes('127.0.0.1')||item==='falsify'),false);
  }finally{
    delete globalThis.FalsifyCloudConfig;
  }
});

test('the page wires open-access before hosted AI and hides bridge-only sections',()=>{
  const scripts=[...html.matchAll(/<script src="([^"]+)"/g)].map(item=>item[1].split('?')[0]);
  assert.ok(scripts.indexOf('cloud-config.js')<scripts.indexOf('open-access.js'));
  assert.ok(scripts.indexOf('open-access.js')<scripts.indexOf('app.js'));
  assert.ok(scripts.indexOf('open-access.js')<scripts.indexOf('hosted-ai.js'));
  assert.match(html,/id="local-bridge"[^>]*data-requires-bridge/);
  assert.match(html,/class="connection-plan"[^>]*data-requires-bridge/);
  assert.match(html,/data-requires-bridge>\s*<details class="red-help" id="red-ai-optional"><summary>AI 검토 · 선택 사항<\/summary>/);
  assert.match(html,/data-requires-bridge><summary>수동 JSON 교환 \(로컬 연결 없이\)<\/summary><div class="button-row"><button id="doc-blue-request"/);
  assert.match(css,/\[data-open-access\] \[data-requires-bridge\]\{display:none!important\}/);
  assert.equal(source.includes('console.'),false);
  assert.equal(bridgeSource.includes('localStorage'),false);
  assert.equal((html.match(/type="password"/g)||[]).length,1);
});
