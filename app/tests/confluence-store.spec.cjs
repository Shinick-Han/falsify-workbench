'use strict';
// Focused UI regression: synthetic DOM, mock popup, gateway and codec. No browser, network, OAuth app or model.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const src=fs.readFileSync(path.resolve(__dirname,'../dist/confluence-store.js'),'utf8');
const BASE='https://api.test',ORIGIN='https://api.test',PAGE='https://shinick-han.github.io';
const SESSION_KEY='falsify.confluence-session.v1',LEDGER_KEY='falsify.experiment-ledger.v1';
const H='a'.repeat(64),HASH='ab'.repeat(32),FUTURE=new Date(Date.now()+864e5).toISOString();
const TOKEN='sealed-SESSION-TOKEN-9f3a-not-a-secret-field';
const tests=[]; const test=(name,fn)=>tests.push([name,fn]);
const flush=async(n=30)=>{for(let i=0;i<n;i++) await new Promise(r=>setImmediate(r));};
const until=async(f,label)=>{for(let i=0;i<400&&!f();i++) await new Promise(r=>setTimeout(r,5)); assert.ok(f(),label);};

class El extends EventTarget{
  constructor(tag){super(); Object.assign(this,{tagName:tag.toUpperCase(),children:[],parent:null,attrs:{},dataset:{},_text:'',id:'',className:'',value:'',checked:false,disabled:false,hidden:false,type:''});
    const set=()=>new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList={toggle:(c,on)=>{const s=set(); (on??!s.has(c))?s.add(c):s.delete(c); this.className=[...s].join(' ');},contains:c=>set().has(c)};}
  get textContent(){return this._text+this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
  set textContent(v){this.children=[]; this._text=String(v);}
  append(...kids){for(const c of kids){if(c&&typeof c==='object') c.parent=this; this.children.push(c);}}
  replaceChildren(...kids){for(const c of this.children) if(c&&typeof c==='object') c.parent=null; this.children=[]; this._text=''; this.append(...kids);}
  setAttribute(k,v){this.attrs[k]=String(v); if(k==='id') this.id=String(v);} getAttribute(k){return this.attrs[k]??null;}
  querySelector(sel){const id=sel.startsWith('#')?sel.slice(1):''; const mode=sel.match(/^\[data-confluence-mode="(.+)"\]$/); return this.find(n=>(id&&n.id===id)||(mode&&n.getAttribute('data-confluence-mode')===mode[1]))||null;}
  *walk(){yield this; for(const c of this.children) if(c&&typeof c==='object'&&c.walk) yield* c.walk();}
  find(f){for(const n of this.walk()) if(f(n)) return n; return null;}
  click(){if(!this.disabled) this.dispatchEvent(new Event('click'));}
  change(){this.dispatchEvent(new Event('change'));}
}
const b64=(s)=>Buffer.from(s,'binary').toString('base64');
const ub64=(s)=>Buffer.from(s,'base64').toString('binary');

function labStub(extraRuns=[]){
  const calls=[], db={schema:LEDGER_KEY,harnesses:[{config:{schema:'falsify.harness.v1',id:'syn',name:'Synthetic BLUE',version:'1',role:'blue',instructions:'Synthetic.',maxCalls:4},hash:H},{config:{schema:'falsify.harness.v1',id:'syn-red',name:'Synthetic RED',version:'1',role:'red',instructions:'Synthetic.',maxCalls:4},hash:'b'.repeat(64)}],
    runs:[{id:'keep-local',role:'red',harnessHash:'b'.repeat(64)}, ...extraRuns], reviews:[]};
  const before=JSON.stringify(db);
  return {calls,db,before,unchanged:()=>JSON.stringify(db)===before,ready:Promise.resolve(),
    cloudSnapshot:async()=>{calls.push('snapshot'); return JSON.parse(JSON.stringify(db));},
    restoreArchive:async(archive)=>{calls.push(['restore',archive.kind,archive.data&&archive.data.selectedRunId]); if(labStub.fail) throw Error('같은 실행 ID의 내용이 달라 병합을 차단했습니다.');
      for(const r of archive.data?.ledger?.runs||[]) if(r&&!db.runs.some(x=>x.id===r.id)) db.runs.push(JSON.parse(JSON.stringify(r)));
      return {kind:'experiment',runId:archive.data.selectedRunId};},
    review:async(id)=>{calls.push(['review',id]); return true;},
    previewSharedHarness:async(config,hash)=>{calls.push(['preview',hash,config&&config.role]); return hash;},
    record:async()=>{calls.push('record'); throw Error('model');},
    bind:async()=>{calls.push('bind'); throw Error('cli');}};
}
function codecStub(){
  const calls=[]; let last=null;
  return {calls,last:()=>last,HASH,
    buildExperimentArchive:async(snapshot,selectedRunId,validators)=>{calls.push(['buildExperiment',selectedRunId,snapshot,validators]);
      const runs=snapshot.runs||[], reviews=snapshot.reviews||[]; const want=new Set([selectedRunId]);
      for(let guard=0;guard<8;guard++){const n=want.size; for(const r of runs) if(want.has(r.id)){if(r.sourceRunId) want.add(r.sourceRunId); if(r.snapshotOf) want.add(r.snapshotOf);} for(const v of reviews) if(want.has(v.runId)&&v.comparison?.sourceRunId) want.add(v.comparison.sourceRunId); if(want.size===n) break;}
      const included=runs.filter(r=>want.has(r.id));
      last={schema:'falsify.confluence-archive.v1',kind:'experiment',id:selectedRunId,title:'Synthetic '+((included.find(r=>r.id===selectedRunId)||{}).role||'run'),data:{schema:'falsify.review-bundle.v1',selectedRunId,ledger:{schema:'falsify.experiment-ledger.v1',harnesses:(snapshot.harnesses||[]).filter(h=>included.some(r=>r.harnessHash===h.hash)),runs:included,reviews:reviews.filter(v=>want.has(v.runId))}}};
      return JSON.parse(JSON.stringify(last));},
    buildHarnessArchive:async(record)=>{calls.push(['buildHarness',record.hash]); last={schema:'falsify.confluence-archive.v1',kind:'harness',id:record.hash,title:record.config.name,data:{config:record.config,hash:record.hash}}; return JSON.parse(JSON.stringify(last));},
    validateArchive:async(archive)=>{calls.push(['validate',archive.kind]); if(archive.schema!=='falsify.confluence-archive.v1'||!archive.kind) throw Error('bad archive'); last=JSON.parse(JSON.stringify(archive)); return JSON.parse(JSON.stringify(last));},
    archiveHash:async()=>HASH};}
function caps(over={}){return {provider:'confluence',configured:true,siteUrl:'https://falsify.atlassian.net',spaceKey:'Falsify',spaceId:'65737',maxArchiveBytes:6*1024*1024,...over};}
function teamApi(){
  const archives=[]; let seq=1000;
  function routes(method,path,init){
    const url=new URL(BASE+path), body=init.body?JSON.parse(init.body):null, token=(init.headers.authorization||'').replace(/^Bearer /,'');
    if(method==='GET'&&url.pathname==='/v1/confluence/capabilities') return {status:200,body:caps()};
    if(method==='POST'&&url.pathname==='/v1/confluence/auth/start') return {status:200,body:{authorizeUrl:'https://auth.atlassian.com/authorize?state='+encodeURIComponent(body.nonce)}};
    if(method==='POST'&&url.pathname==='/v1/confluence/auth/refresh') return token?{status:200,body:{session:'rotated-'+token,expiresAt:FUTURE}}:{status:401,body:{error:{code:'unauthorized'}}};
    if(method==='GET'&&url.pathname==='/v1/confluence/archives') return {status:200,body:{items:archives.map(({archive,...item})=>item),nextCursor:null}};
    const one=url.pathname.match(/^\/v1\/confluence\/archives\/([^/]+)$/);
    if(method==='GET'&&one){const found=archives.find(a=>a.pageId===decodeURIComponent(one[1])); return found?{status:200,body:{pageId:found.pageId,webUrl:found.webUrl,archive:found.archive,archiveSha256:found.archiveSha256}}:{status:404,body:{error:{code:'not_found'}}};}
    if(method==='POST'&&url.pathname==='/v1/confluence/archives'){
      if(!token) return {status:401,body:{error:{code:'unauthorized'}}};
      if(body.teamShare!==true||body.visibility) return {status:400,body:{error:{code:'invalid_request'}}};
      const existing=archives.find(a=>JSON.stringify(a.archive)===JSON.stringify(body.archive));
      if(existing) return {status:200,body:{pageId:existing.pageId,webUrl:existing.webUrl,archiveSha256:HASH,stored:true,alreadyExisted:true}};
      const pageId=String(++seq), item={pageId,title:body.archive.title,webUrl:'https://falsify.atlassian.net/wiki/spaces/Falsify/pages/'+pageId,updatedAt:'2026-10-26T00:00:00.000Z',archive:body.archive,archiveSha256:HASH};
      archives.push(item); return {status:201,body:{pageId,webUrl:item.webUrl,archiveSha256:HASH,stored:true,alreadyExisted:false}};
    }
    return {status:404,body:{error:{code:'not_found'}}};
  }
  return {archives,routes};
}
function setup({store=new Map(),routes,lab,codec,config}={}){
  const body=new El('body'), review=new El('section'), results=new El('section'), agents=new El('section'), manager=new El('section'), board=new El('section');
  review.id='human-evaluation'; const run=new El('select'); run.id='evaluation-run'; review.append(run);
  results.id='view-results'; board.id='ledger-board'; const exp=new El('button'); exp.id='ledger-export'; exp.textContent='전체 기록 JSON 백업'; const imp=new El('input'); imp.id='ledger-import'; board.append(exp,imp); results.append(board);
  agents.id='view-agents'; manager.id='harness-manager'; const reg=new El('button'); reg.id='harness-register'; reg.textContent='새 harness 버전 등록'; let registered=0; reg.addEventListener('click',()=>{registered++;}); const red=new El('select'); red.id='red-harness'; const blue=new El('select'); blue.id='blue-harness'; manager.append(reg,red,blue); agents.append(manager); body.append(review,results,agents);
  const opened=[]; const window=new EventTarget(); window.open=(url,name,features)=>{const popup={closed:false,url,name,features,close(){this.closed=true;}}; opened.push(popup); return popup;};
  const calls=[]; const fetch=async(url,init)=>{const u=new URL(url); calls.push({url,method:init.method,path:u.pathname+u.search,headers:{...init.headers},body:init.body===undefined?undefined:JSON.parse(init.body),credentials:init.credentials,redirect:init.redirect});
    const answer=await (routes||teamApi().routes)(init.method,u.pathname+u.search,init); if(answer==='hang') return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted'))));
    return {ok:answer.status>=200&&answer.status<300,status:answer.status,headers:{get:n=>answer.headers?.[n.toLowerCase()]??null},text:async()=>answer.body===undefined?'':typeof answer.body==='string'?answer.body:JSON.stringify(answer.body)};};
  const localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{if(k===LEDGER_KEY) throw Error('ledger write'); store.set(k,String(v));},removeItem:k=>store.delete(k)};
  store.set(LEDGER_KEY,'{"schema":"falsify.experiment-ledger.v1","runs":[{"id":"keep-local"}]}');
  const document=new EventTarget(); Object.assign(document,{readyState:'complete',body,currentScript:null,createElement:t=>{const e=new El(t); e.ownerDocument=document; return e;},querySelector:s=>s.startsWith('#')?body.find(n=>n.id===s.slice(1)):null});
  body.ownerDocument=document;
  const ctx=vm.createContext({document,window,location:{origin:PAGE,href:PAGE+'/falsify-workbench/'},localStorage,fetch,crypto:globalThis.crypto,FalsifyCloudConfig:config||{apiBase:BASE,provider:'confluence'},FalsifyLab:lab||labStub(),FalsifyReviewBundle:codec||codecStub(),URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,Event,Uint8Array,btoa:b64,atob:ub64,setTimeout:(f,ms)=>setTimeout(f,ms>=15000?30:ms),clearTimeout,setInterval,clearInterval,console});
  vm.runInContext(src,ctx,{filename:'confluence-store.js'});
  const $=id=>body.find(n=>n.id===id);
  return {ctx,calls,store,body,window,opened,$,registered:()=>registered,lab:ctx.FalsifyLab,codec:ctx.FalsifyReviewBundle,ready:ctx.FalsifyConfluenceStore.ready};
}
async function connect(t,token=TOKEN){
  t.$('confluence-review-connect').click();
  await until(()=>t.opened.length===1,'popup');
  const nonce=t.calls.find(c=>c.path==='/v1/confluence/auth/start').body.nonce;
  const ev=new Event('message'); ev.origin=ORIGIN; ev.source=t.opened[0]; ev.data={type:'falsify.confluence.session.v1',nonce,session:token,expiresAt:FUTURE};
  t.window.dispatchEvent(ev); await until(()=>/팀 공간에 연결했습니다/.test(t.$('confluence-review-status').textContent),'connected');
}
function arm(t,id='blue-1'){t.$('evaluation-run').value=id; t.$('evaluation-run').change(); t.$('confluence-review-consent').checked=true; t.$('confluence-review-consent').change();}
function openSaved(t,listId){const btn=t.$(listId).find(n=>n.tagName==='BUTTON'&&n.textContent==='이 보관 열기'); assert.ok(btn,'open button'); btn.click();}

test('index loads Confluence controls only and cloud-config names that provider',()=>{
  const html=fs.readFileSync(path.resolve(__dirname,'../dist/index.html'),'utf8');
  assert.match(html,/confluence-store\.js/); assert.match(html,/confluence-store\.css/);
  assert.ok(!/cloud-records\.(js|css)/.test(html),'old account UI is not loaded');
  const cfg=fs.readFileSync(path.resolve(__dirname,'../dist/cloud-config.js'),'utf8');
  assert.match(cfg,/provider:\s*'confluence'/); assert.ok(!/CLIENT_SECRET|ATLASSIAN_CLIENT_SECRET|password|apiKey/i.test(cfg));
});

test('startup does not upload, and the local ledger tools stay on the results board',async()=>{
  const t=setup(); await t.ready; await flush();
  assert.equal(t.calls.length,0,'no automatic request');
  assert.equal(t.$('view-results').children[0].id,'ledger-board');
  assert.equal(t.$('view-results').children[1].id,'confluence-panel-results');
  assert.equal(t.$('ledger-export').textContent,'전체 기록 JSON 백업');
  assert.equal(t.$('ledger-import').id,'ledger-import');
  for(const id of ['confluence-review-connect','confluence-review-share','confluence-review-load','confluence-results-connect','confluence-harness-connect']) assert.equal(t.$(id).textContent, id.endsWith('connect')?'Confluence에 연결':id.endsWith('share')?'Confluence에 팀 공유':'팀 기록 불러오기');
  assert.equal([...t.body.walk()].some(n=>n.type==='password'||/api.?key|비밀번호|비공개\/공유|username/i.test(n.textContent+n.id)),false);
  assert.match(t.$('confluence-panel-review').textContent,/원본 PDF/);
  assert.ok(!/과학적 결론이 아닙니다/.test('')&&!/gold|정확도 검증|온라인 표시/.test(t.body.textContent));
  assert.equal(t.store.get(LEDGER_KEY).includes('keep-local'),true);
});

test('connect checks origin, popup source and nonce, and stores only an encrypted session',async()=>{
  const t=setup(); await t.ready; t.$('confluence-review-connect').click(); await until(()=>t.opened.length===1,'popup');
  const start=t.calls.find(c=>c.path==='/v1/confluence/auth/start');
  assert.deepEqual(Object.keys(start.body).sort(),['nonce','returnOrigin']); assert.equal(start.body.returnOrigin,PAGE);
  assert.equal(t.opened[0].name,'falsify-confluence-oauth'); assert.match(t.opened[0].url,/^https:\/\/auth\.atlassian\.com\/authorize/);
  assert.ok(!t.body.textContent.includes(start.body.nonce),'nonce is not rendered');
  const bad=new Event('message'); bad.origin='https://evil.test'; bad.source=t.opened[0]; bad.data={type:'falsify.confluence.session.v1',nonce:start.body.nonce,session:TOKEN,expiresAt:FUTURE};
  t.window.dispatchEvent(bad); const wrong=new Event('message'); wrong.origin=ORIGIN; wrong.source={}; wrong.data=bad.data; t.window.dispatchEvent(wrong);
  const stale=new Event('message'); stale.origin=ORIGIN; stale.source=t.opened[0]; stale.data={...bad.data,nonce:'other-nonce'}; t.window.dispatchEvent(stale); await flush();
  assert.equal(t.store.has(SESSION_KEY),false,'mixed-up callbacks are ignored');
  const ok=new Event('message'); ok.origin=ORIGIN; ok.source=t.opened[0]; ok.data={type:'falsify.confluence.session.v1',nonce:start.body.nonce,session:TOKEN,expiresAt:FUTURE};
  t.window.dispatchEvent(ok); await until(()=>t.store.has(SESSION_KEY),'cached');
  assert.ok(![...t.store.values()].some(v=>v.includes(TOKEN)),'plaintext session is not stored');
  assert.ok(!t.body.textContent.includes(TOKEN));
  assert.equal(t.store.get(LEDGER_KEY).includes('keep-local'),true);
});

test('cancel, unconfigured gateway and wrong site never create a session',async()=>{
  const cancel=setup(); await cancel.ready; cancel.$('confluence-review-connect').click(); await until(()=>cancel.opened.length===1,'popup');
  cancel.opened[0].closed=true; await until(()=>/취소했습니다/.test(cancel.$('confluence-review-status').textContent),'cancel');
  assert.equal(cancel.store.has(SESSION_KEY),false); assert.equal(cancel.calls.filter(c=>c.path==='/v1/confluence/archives').length,0);
  const off=setup({routes:(m,p)=>m==='GET'&&p==='/v1/confluence/capabilities'?{status:200,body:caps({configured:false})}:{status:500,body:{error:{code:'unexpected'}}}});
  await off.ready; off.$('confluence-review-connect').click(); await until(()=>/운영자/.test(off.$('confluence-review-status').textContent),'operator');
  assert.equal(off.opened.length,0); assert.equal(off.calls.some(c=>c.path==='/v1/confluence/auth/start'),false);
  const wrong=setup({routes:(m,p)=>m==='GET'&&p==='/v1/confluence/capabilities'?{status:200,body:caps({siteUrl:'https://evil.atlassian.net'})}:{status:500,body:{error:{code:'unexpected'}}}});
  await wrong.ready; wrong.$('confluence-results-connect').click(); await until(()=>/Falsify Confluence가 아니어서/.test(wrong.$('confluence-results-status').textContent),'site');
  assert.equal(wrong.opened.length,0);
});

test('two browser stores share one team archive without model calls or losing local runs',async()=>{
  const api=teamApi();
  const blue={id:'blue-1',role:'blue',harnessHash:H,sourceRunId:'red-root',segments:[{id:'s0',text:'EXTRACTED_TEXT_MARKER'}],response:{raw:'RAW_RESPONSE_MARKER'}};
  const red={id:'red-root',role:'red',harnessHash:'b'.repeat(64),response:{raw:'RED_RAW'}};
  const snap={id:'red-final',role:'red',snapshotOf:'red-root',harnessHash:'b'.repeat(64)};
  const review={id:'rev-1',runId:'blue-1',comparison:{sourceRunId:'red-final'},findingAssessments:[{id:'F1',verdict:'supported'}],reviewContext:{mode:'red-assisted'}};
  const labA=labStub([blue,red,snap]); labA.db.reviews=[review]; const beforeA=JSON.stringify(labA.db);
  const labB=labStub(); labB.db.runs[0].id='keep-b';
  const a=setup({lab:labA,codec:codecStub(),routes:api.routes,store:new Map()}); const b=setup({lab:labB,codec:codecStub(),routes:api.routes,store:new Map()});
  await a.ready; await b.ready; await connect(a); await connect(b,TOKEN+'B');
  assert.equal(a.calls.length>0&&b.calls.length>0,true);
  arm(a); assert.equal(a.$('confluence-review-share').disabled,false); a.$('confluence-review-share').click(); a.$('confluence-review-share').click();
  await until(()=>api.archives.length===1,'published'); await flush();
  const posts=a.calls.filter(c=>c.method==='POST'&&c.path==='/v1/confluence/archives');
  assert.equal(posts.length,1,'duplicate click sends one write');
  assert.equal(posts[0].body.teamShare,true); assert.equal('visibility' in posts[0].body,false);
  assert.equal(posts[0].headers.authorization.startsWith('Bearer rotated-'),true,'refresh runs before the write');
  const ids=posts[0].body.archive.data.ledger.runs.map(r=>r.id).sort();
  assert.deepEqual(ids,['blue-1','red-final','red-root']);
  assert.equal(posts[0].body.archive.data.ledger.reviews[0].reviewContext.mode,'red-assisted');
  assert.equal(posts[0].body.archive.data.ledger.reviews[0].findingAssessments[0].id,'F1');
  assert.equal(JSON.stringify(labA.db),beforeA,'publish does not change the local ledger');
  assert.ok(!a.body.textContent.includes('EXTRACTED_TEXT_MARKER')&&!a.body.textContent.includes('RAW_RESPONSE_MARKER'));
  b.$('confluence-results-load').click(); await until(()=>b.$('confluence-results-list').textContent.includes('Synthetic blue'),'listed');
  assert.ok(!b.body.textContent.includes('EXTRACTED_TEXT_MARKER'));
  assert.equal(b.calls.some(c=>c.method==='POST'&&c.path==='/v1/confluence/archives'),false,'loading does not upload');
  openSaved(b,'confluence-results-list');
  await until(()=>labB.calls.some(c=>c[0]==='review'),'review selected');
  assert.deepEqual(labB.calls.filter(c=>c[0]==='restore')[0],[ 'restore','experiment','blue-1' ]);
  assert.deepEqual(labB.calls.filter(c=>c[0]==='review')[0],['review','blue-1']);
  assert.ok(labB.db.runs.some(r=>r.id==='keep-b')&&labB.db.runs.some(r=>r.id==='blue-1')&&labB.db.runs.some(r=>r.id==='red-final'));
  assert.equal(labB.calls.includes('record')||labB.calls.includes('bind'),false);
  assert.equal(a.lab.calls.includes('record')||b.lab.calls.some(c=>c==='record'||c==='bind'),false);
  assert.ok(![...b.store.values()].join('\n').includes(TOKEN));
});

test('harness share is preview-only and consent is explicit',async()=>{
  const api=teamApi(); const t=setup({routes:api.routes}); await t.ready; await connect(t);
  assert.equal(t.$('confluence-harness-share').disabled,true);
  t.$('blue-harness').value=H; t.$('confluence-harness-role').value='blue'; t.$('confluence-harness-consent').checked=true; t.$('confluence-harness-consent').change();
  t.$('confluence-harness-share').click(); await until(()=>api.archives.length===1,'harness archived');
  const post=t.calls.find(c=>c.path==='/v1/confluence/archives'&&c.method==='POST');
  assert.equal(post.body.archive.kind,'harness'); assert.equal(post.body.archive.id,H); assert.equal(post.body.teamShare,true);
  t.$('confluence-harness-load').click(); await until(()=>t.$('confluence-harness-list').textContent.includes('Synthetic BLUE'),'list');
  openSaved(t,'confluence-harness-list'); await until(()=>t.lab.calls.some(c=>c[0]==='preview'),'preview');
  assert.equal(t.registered(),0,'registration stays with the user');
  assert.equal(t.lab.calls.some(c=>c[0]==='restore'),false);
  assert.deepEqual(t.lab.calls.find(c=>c[0]==='preview').slice(0,3),['preview',H,'blue']);
});

test('unknown write, conflict, oversize, permission and empty list are actionable and not retried',async()=>{
  let mode='ok'; const api=teamApi();
  const routes=(m,p,init)=>{
    if(m==='POST'&&p==='/v1/confluence/archives'){
      if(mode==='hang') return 'hang';
      if(mode==='conflict') return {status:409,body:{error:{code:'conflict',message:'<html>secret</html>'}}};
      if(mode==='partial') return {status:200,body:{stored:false,pageId:'1001'}};
      if(mode==='forbidden') return {status:403,body:'<html>nope</html>'};
    }
    if(m==='GET'&&p==='/v1/confluence/archives'&&mode==='empty') return {status:200,body:{items:[],nextCursor:null}};
    if(m==='GET'&&p==='/v1/confluence/archives'&&mode==='cursor') return {status:200,body:{items:[{pageId:'1001',title:'Synthetic',webUrl:'https://evil.example/phish'}],nextCursor:'https://evil.example/next'}};
    return api.routes(m,p,init);
  };
  const codec=codecStub(); const normalBuild=codec.buildExperimentArchive.bind(codec);
  codec.buildExperimentArchive=async(snapshot,selectedRunId,validators)=>{
    if(mode==='oversize') return {schema:'falsify.confluence-archive.v1',kind:'experiment',id:selectedRunId,title:'Big',data:{pad:'가'.repeat(2200000),schema:'falsify.review-bundle.v1',selectedRunId,ledger:{schema:'falsify.experiment-ledger.v1',harnesses:[],runs:[{id:selectedRunId}],reviews:[]}}};
    return normalBuild(snapshot,selectedRunId,validators);
  };
  const t=setup({routes,codec,lab:labStub([{id:'blue-1',role:'blue',harnessHash:H}])}); await t.ready; await connect(t); arm(t);
  mode='hang'; t.$('confluence-review-share').click(); await until(()=>/올라갔는지 알 수 없어/.test(t.$('confluence-review-status').textContent),'unknown'); await flush();
  assert.equal(t.calls.filter(c=>c.method==='POST'&&c.path==='/v1/confluence/archives').length,1);
  mode='conflict'; arm(t); t.$('confluence-review-share').click(); await until(()=>/충돌했습니다/.test(t.$('confluence-review-status').textContent),'conflict');
  assert.ok(!t.body.textContent.includes('secret')); assert.equal(t.calls.filter(c=>c.method==='POST'&&c.path==='/v1/confluence/archives').length,2,'no automatic replay');
  mode='partial'; arm(t); t.$('confluence-review-share').click(); await until(()=>/확인하지 못했습니다/.test(t.$('confluence-review-status').textContent),'partial');
  mode='forbidden'; arm(t); t.$('confluence-review-share').click(); await until(()=>/권한이 없습니다/.test(t.$('confluence-review-status').textContent),'permission');
  assert.ok(!t.body.textContent.includes('nope'));
  mode='oversize'; const postsBefore=t.calls.filter(c=>c.path==='/v1/confluence/archives'&&c.method==='POST').length; arm(t); t.$('confluence-review-share').click(); await until(()=>/UTF-8 크기 한도/.test(t.$('confluence-review-status').textContent),'oversize');
  assert.equal(t.calls.filter(c=>c.path==='/v1/confluence/archives'&&c.method==='POST').length,postsBefore,'oversize is not posted');
  assert.ok(t.body.textContent.length<100000,'oversized archive is not rendered');
  mode='empty'; t.$('confluence-review-load').click(); await until(()=>/표시할 보관이 없습니다/.test(t.$('confluence-review-status').textContent),'empty');
  mode='cursor'; t.$('confluence-review-load').click(); await until(()=>/따라가지 않았습니다/.test(t.$('confluence-review-status').textContent),'cursor');
  assert.equal(t.calls.some(c=>c.url.includes('evil.example')),false); assert.ok(!t.body.textContent.includes('evil.example'));
  assert.equal(t.lab.unchanged(),true);
});

test('session expiry, disconnect and restore rollback leave local records',async()=>{
  const t=setup({routes:(m,p,init)=>{if(m==='GET'&&p==='/v1/confluence/capabilities') return {status:200,body:caps()}; if(m==='POST'&&p==='/v1/confluence/auth/start') return {status:200,body:{authorizeUrl:'https://auth.atlassian.com/authorize'}}; if(m==='POST'&&p==='/v1/confluence/auth/refresh') return {status:401,body:{error:{code:'unauthorized'}}}; return {status:500,body:{error:{code:'unexpected'}}};}});
  await t.ready; await connect(t); arm(t); t.$('confluence-review-share').click(); await until(()=>/세션이 끝났습니다/.test(t.$('confluence-review-status').textContent),'expired');
  assert.equal(t.calls.some(c=>c.path==='/v1/confluence/archives'),false); assert.equal(t.store.has(SESSION_KEY),false);
  const api=teamApi(); const rollback=setup({routes:api.routes}); rollback.lab=rollback.lab; await rollback.ready; await connect(rollback);
  labStub.fail=true; rollback.$('confluence-review-load').click(); await until(()=>/표시할 보관이 없습니다|팀 보관 0건|표시합니다/.test(rollback.$('confluence-review-status').textContent)||rollback.$('confluence-review-list').textContent.length>0,'listed or empty');
  api.archives.push({pageId:'1001',title:'Synthetic blue',webUrl:'https://falsify.atlassian.net/wiki/spaces/Falsify/pages/1001',archive:{schema:'falsify.confluence-archive.v1',kind:'experiment',id:'blue-1',title:'Synthetic blue',data:{schema:'falsify.review-bundle.v1',selectedRunId:'blue-1',ledger:{schema:'falsify.experiment-ledger.v1',harnesses:[],runs:[{id:'blue-1',segments:[{text:'EXTRACTED_TEXT_MARKER'}]}],reviews:[]}}},archiveSha256:HASH});
  rollback.$('confluence-review-load').click(); await until(()=>rollback.$('confluence-review-list').textContent.includes('Synthetic blue'),'row');
  const before=JSON.stringify(rollback.lab.db); openSaved(rollback,'confluence-review-list');
  await until(()=>/병합을 차단했습니다/.test(rollback.$('confluence-review-status').textContent),'rollback');
  assert.equal(JSON.stringify(rollback.lab.db),before); assert.equal(rollback.lab.calls.filter(c=>c[0]==='restore').length,1);
  labStub.fail=false; rollback.$('confluence-review-disconnect').click(); await flush();
  assert.equal(rollback.store.has(SESSION_KEY),false); assert.ok(rollback.store.get(LEDGER_KEY).includes('keep-local'));
  assert.match(rollback.$('confluence-review-status').textContent,/권한 전체가 취소된 것은 아닙니다/);
});

test('styles keep the airport tokens and do not paint an online lamp',()=>{
  const css=fs.readFileSync(path.resolve(__dirname,'../dist/confluence-store.css'),'utf8');
  assert.match(css,/var\(--line\)/); assert.match(css,/var\(--muted\)/); assert.match(css,/#246388/); assert.match(css,/var\(--red-ink\)/);
  assert.ok(!/box-shadow|#[0-9a-f]*[fF][fF][cC][cC]00|#0f0|online/i.test(css));
});

(async()=>{let failed=0; for(const [name,fn] of tests){try{await fn(); console.log('ok - '+name);}catch(e){failed++; console.error('not ok - '+name+'\n'+(e.stack||e));}}
  console.log(JSON.stringify({passed:tests.length-failed,failed})); process.exitCode=failed?1:0;})();
