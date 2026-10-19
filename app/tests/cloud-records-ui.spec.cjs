'use strict';
// Node VM regression for the shared-records section: synthetic DOM, stubbed fetch/storage/ledger hooks/core. No browser, network, server or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const src=fs.readFileSync(path.resolve(__dirname,'../dist/cloud-records.js'),'utf8'),BASE='https://api.test',KEY='falsify.cloud-session.v1';
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const flush=async(n=20)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const until=async(f,label)=>{for(let i=0;i<300&&!f();i++)await new Promise(r=>setTimeout(r,5));assert.ok(f(),label);};
const H='a'.repeat(64),S='b'.repeat(64),F='c'.repeat(64),FUTURE=new Date(Date.now()+864e5).toISOString(),TOKEN='t'.repeat(43);

class El extends EventTarget{
  constructor(tag){super();Object.assign(this,{tagName:tag.toUpperCase(),children:[],parent:null,attrs:{},dataset:{},_text:'',id:'',className:'',value:'',checked:false,disabled:false,hidden:false,open:false});
    const set=()=>new Set(this.className.split(/\s+/).filter(Boolean));this.classList={toggle:(c,on)=>{const s=set();(on??!s.has(c))?s.add(c):s.delete(c);this.className=[...s].join(' ');},contains:c=>set().has(c)};}
  get textContent(){return this._text+this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
  set textContent(v){this.children=[];this._text=String(v);}
  append(...kids){for(const c of kids){if(typeof c==='object')c.parent=this;this.children.push(c);}}
  prepend(...kids){for(const c of kids)if(typeof c==='object')c.parent=this;this.children.unshift(...kids);}
  replaceChildren(...kids){this.children=[];this._text='';this.append(...kids);}
  setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}
  focus(){}scrollIntoView(){}
  click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
  change(value){if(value!==undefined)this.value=value;this.dispatchEvent(new Event('change'));}
  *walk(){yield this;for(const c of this.children)if(typeof c==='object')yield* c.walk();}
  find(f){for(const n of this.walk())if(f(n))return n;return null;}
  visible(){for(let n=this;n;n=n.parent)if(n.hidden)return false;return true;}
}
const rec=(id,kind,payload,o={})=>({id,owner:{id:o.owner||'author-other',displayName:o.name||'Other',username:o.user||'other'},kind,visibility:o.visibility||'shared',createdAt:'2026-10-19T00:00:00Z',updatedAt:'2026-10-19T00:00:00Z',revision:o.revision||1,payload,attestation:'client-reported'});
const harnessConfig={schema:'falsify.harness.v1',id:'syn-blue',name:'Synthetic BLUE',version:'1',role:'blue',instructions:'Synthetic instruction.',maxCalls:4};
const runPayload={role:'blue',harnessHash:H,sourceHash:S,fileHash:F,model:'synthetic-model',level:null,maxCalls:4,status:'ok',calls:2,provenance:'local-codex',caseLabel:'case-A',protocolVersion:'p1',createdAt:'2026-10-18T00:00:00Z'};
const sharedRecords=[rec('rec-h1','harness',{config:harnessConfig,hash:H}),rec('rec-r1','run',runPayload)];
const meSession=(over={})=>JSON.stringify({apiBase:BASE,token:TOKEN,author:{id:'author-me',username:'me',displayName:'Me'},expiresAt:FUTURE,...over});
const localRun={id:'local-run-1',role:'blue',harnessHash:H,sourceHash:S,fileHash:F,model:'synthetic-model',maxCalls:4,provenance:'local-codex',createdAt:'2026-10-18T00:00:00Z',segments:[{id:'s0',label:'p1',text:'Synthetic paper text'}]};
function labStub(){const calls=[],db={harnesses:[{config:harnessConfig,hash:H}],runs:[localRun],reviews:[{id:'local-review-1',runId:'local-run-1',reviewer:'Local label',caseLabel:'case-A',verdict:'supported',score:4,note:'Synthetic note.',createdAt:'2026-10-18T01:00:00Z'}]},before=JSON.stringify(db);
  return {calls,db,unchanged:()=>JSON.stringify(db)===before,ready:Promise.resolve(),cloudSnapshot:async()=>{calls.push('cloudSnapshot');return JSON.parse(JSON.stringify(db));},previewSharedHarness:async(c,expected)=>{calls.push(['preview',c,expected]);return expected;}};}
// Mirrors the contract core signatures (cloud-records-core.mjs); the real core is exercised below when it is present.
function coreStub(){const calls=[];return {calls,
  validatePayload:async(kind,p)=>{calls.push(['validate',kind]);if(kind==='review'&&(p.verdict==='uncertain'&&p.score!==null||typeof p.caseLabel!=='string'))throw Error('Invalid payload field: review');return p;},
  runFromLocal:(r,{includeEvidence=false,caseLabel,protocolVersion}={})=>({localId:r.id,role:r.role,harnessHash:r.harnessHash,sourceHash:r.sourceHash,fileHash:r.fileHash,model:r.model,level:null,maxCalls:r.maxCalls,status:'ok',calls:1,provenance:r.provenance,createdAt:r.createdAt,...(caseLabel!==undefined?{caseLabel}:{}),protocolVersion:protocolVersion??'p1',...(includeEvidence?{evidence:{segments:r.segments,response:{status:'ok'}}}:{})}),
  reviewFromLocal:(v,runId,{protocolVersion,supersedes}={})=>({runId,verdict:v.verdict,score:v.score,note:v.note,caseLabel:v.caseLabel,...(protocolVersion!==undefined?{protocolVersion}:{}),...(supersedes!==undefined?{supersedes}:{})}),
  compareRecords:records=>{calls.push(['compare',records.length]);return {groups:[{conditionKey:'k',conditions:{sourceHash:S,role:'blue',model:'synthetic-model',level:null,maxCalls:4,protocolVersion:'p1',caseLabel:'case-A'},attestation:'client-reported',runCount:1,
    harnesses:[{hash:H,origin:'executed',harnessAvailable:true,runIds:['rec-r1'],runCount:1,statuses:{ok:1,abstain:0},calls:2,callsUnknown:0,reviewCount:0,uncertainCount:0,scoreCount:0,scoreMean:null,reviewerCount:0}]}],
    warnings:[{code:'client_reported',message:'x',recordIds:[]},{code:'incomparable_missing_condition',message:'x',recordIds:['rec-x']},{code:'review_condition_mismatch',message:'x',recordIds:['rec-v9']}]};}};}
// routes(method,path,init) returns {status,body} | 'hang'.
function setup({apiBase=BASE,store=new Map(),routes=()=>({status:404,body:{error:{code:'not_found',message:'x'}}}),lab=labStub(),core=coreStub()}={}){
  const body=new El('body'),results=new El('section');results.id='view-results';const ledger=new El('section');ledger.id='ledger-board';results.append(ledger);body.append(results);
  const anchors=[],saved=[];class TURL extends URL{static createObjectURL(b){saved.push(b);return 'blob:synthetic/'+saved.length;}static revokeObjectURL(){}}
  const document=new EventTarget();Object.assign(document,{readyState:'complete',body,createElement:t=>{const e=new El(t);if(t==='a')anchors.push(e);return e;},querySelector:s=>s.startsWith('#')?body.find(n=>n.id===s.slice(1)):null});
  const calls=[],fetch=async(url,init)=>{const u=new URL(url);calls.push({url,method:init.method,headers:{...init.headers},body:init.body===undefined?undefined:JSON.parse(init.body),init});
    const r=await routes(init.method,u.pathname+u.search,init);if(r==='hang')return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted'))));
    return {ok:r.status>=200&&r.status<300,status:r.status,text:async()=>r.body===undefined?'':typeof r.body==='string'?r.body:JSON.stringify(r.body)};};
  const localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
  const ctx=vm.createContext({document,FalsifyCloudConfig:{apiBase},localStorage,fetch,FalsifyLab:lab,FalsifyCloudCore:core,URL:TURL,URLSearchParams,Blob,AbortController,TextEncoder,Event,console,setTimeout:(f,ms)=>setTimeout(f,ms>=15000?20:ms),clearTimeout,location:{href:'https://shinick-han.github.io/falsify-workbench/'}});
  vm.runInContext(src,ctx,{filename:'cloud-records.js'});
  const $=id=>body.find(n=>n.id===id),records=()=>[...$('cloud-list').walk()].filter(n=>n.tagName==='ARTICLE'),action=(article,name)=>article.find(n=>n.dataset.action===name);
  return {ctx,calls,store,lab,core,body,results,$,records,action,anchors,saved,ready:ctx.FalsifyCloudRecords.ready};}
const sharedRoute=(m,p)=>m==='GET'&&p.startsWith('/v1/records?scope=shared')?{status:200,body:{records:sharedRecords,nextCursor:null}}:null;
async function login(t){t.$('cloud-username').value='synthetic_me';t.$('cloud-password').value='correct horse battery';t.$('cloud-auth-form').dispatchEvent(new Event('submit',{cancelable:true}));await flush();}
const authOk=(m,p)=>m==='POST'&&p==='/v1/auth/login'?{status:200,body:{token:TOKEN,author:{id:'author-me',username:'me',displayName:'Me'},expiresAt:FUTURE}}:null;

test('unconfigured or non-https server stays off and never touches the network',async()=>{
  for(const apiBase of ['','http://api.test','https://user:pw@api.test','https://api.test/?x=1']){const t=setup({apiBase});await t.ready;
    assert.equal(t.results.children[0].id,'ledger-board','local ledger stays first');assert.equal(t.results.children[1].id,'cloud-records');
    assert.match(t.$('cloud-connection').textContent,/꺼짐/);assert.equal(t.$('cloud-refresh').visible(),false);assert.equal(t.$('cloud-account').visible(),false);assert.equal(t.calls.length,0);}});

test('shared records are read anonymously, only on explicit refresh',async()=>{
  const t=setup({routes:sharedRoute});await t.ready;await flush();assert.equal(t.calls.length,0,'no automatic read');assert.equal(t.$('cloud-tab-mine').disabled,true,'mine needs login');
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'two shared records');
  assert.equal(t.calls[0].url,BASE+'/v1/records?scope=shared');assert.equal(t.calls[0].headers.authorization,undefined);assert.equal(t.calls[0].init.credentials,'omit');
  assert.ok(t.records().every(a=>a.textContent.includes('작성자 보고 · 미검증')),'source badge on every record');assert.equal(t.action(t.records()[1],'review'),null,'anonymous visitor cannot review');});

test('sign-in keeps the token for the configured server only and never stores the password',async()=>{
  const t=setup({routes:(m,p)=>authOk(m,p)||sharedRoute(m,p)||(m==='GET'&&p.startsWith('/v1/records?scope=mine')?{status:200,body:{records:[],nextCursor:null}}:null)});await t.ready;
  t.$('cloud-username').value='bad name';t.$('cloud-password').value='correct horse battery';t.$('cloud-auth-form').dispatchEvent(new Event('submit',{cancelable:true}));await flush();
  assert.equal(t.calls.length,0,'invalid username is refused locally');assert.equal(t.$('cloud-password').value,'','password cleared after refusal');
  await login(t);const auth=t.calls[0];assert.equal(auth.url,BASE+'/v1/auth/login');assert.deepEqual(auth.body,{username:'synthetic_me',password:'correct horse battery'});
  const stored=t.store.get(KEY);assert.ok(stored&&!stored.includes('correct horse'),'password not persisted');assert.equal(JSON.parse(stored).apiBase,BASE);assert.equal(JSON.parse(stored).token,TOKEN);
  assert.ok(![...t.body.walk()].some(n=>n.value==='correct horse battery'),'password not left in any field');assert.match(t.$('cloud-account-summary').textContent,/로그인됨 · Me/);
  t.$('cloud-tab-mine').click();await until(()=>t.calls.length===2&&!t.$('cloud-tab-shared').disabled,'mine read');assert.equal(t.calls[1].headers.authorization,'Bearer '+TOKEN);
  t.$('cloud-tab-shared').click();await until(()=>t.calls.length===3,'shared read');assert.equal(t.calls[2].headers.authorization,undefined,'shared reads stay anonymous');
  assert.ok(t.calls.every(c=>c.url.startsWith(BASE+'/v1/')),'no other destination');
  const other=setup({apiBase:'https://other.test',store:new Map([[KEY,meSession()]])});await other.ready;assert.equal(other.$('cloud-tab-mine').disabled,true,'token for another server is ignored');assert.match(other.$('cloud-account-summary').textContent,/로그인 · 가입/);});

test('expired or rejected session asks to sign in again and keeps local and shared data',async()=>{
  const old=setup({store:new Map([[KEY,meSession({expiresAt:'2020-01-01T00:00:00Z'})]])});await old.ready;assert.equal(old.store.has(KEY),false);assert.match(old.$('cloud-account-summary').textContent,/다시 로그인 필요/);assert.equal(old.$('cloud-account').open,true);
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p)=>sharedRoute(m,p)||(p.startsWith('/v1/records?scope=mine')?{status:401,body:'<html><body>proxy says hi</body></html>'}:null)});await t.ready;
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'shared loaded');t.$('cloud-tab-mine').click();await until(()=>!t.store.has(KEY),'token dropped on 401');await flush();
  assert.match(t.$('cloud-account-body').textContent,/세션이 끝났습니다/);assert.ok(!t.body.textContent.includes('proxy says hi'),'no raw server body');assert.equal(t.$('cloud-tab-shared').getAttribute('aria-pressed'),'true');assert.ok(t.lab.unchanged(),'local ledger untouched');});

test('failed reads and writes keep what is on screen and are never retried',async()=>{
  let page=0;const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p)=>{if(m==='GET'&&p.startsWith('/v1/records?scope=shared')){page++;return page===1?{status:200,body:{records:sharedRecords,nextCursor:'c1'}}:{status:502,body:'<html>Bad gateway from proxy</html>'};}if(m==='POST'&&p==='/v1/records')return 'hang';}});await t.ready;
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'first page');assert.equal(t.$('cloud-more').hidden,false);t.$('cloud-more').click();await until(()=>t.$('cloud-status').classList.contains('error'),'error shown');
  assert.equal(t.calls[1].url,BASE+'/v1/records?scope=shared&cursor=c1');assert.equal(t.records().length,2,'loaded records kept');assert.match(t.$('cloud-status').textContent,/공유 서버 오류/);assert.ok(!t.body.textContent.includes('Bad gateway'));
  t.$('cloud-upload').open=true;t.$('cloud-upload-read').click();await flush();t.$('cloud-upload-item').change('0');await until(()=>t.$('cloud-upload-preview').textContent.length>0,'preview');
  t.$('cloud-upload-consent').checked=true;t.$('cloud-upload-consent').change();t.$('cloud-upload-send').click();await until(()=>/15초/.test(t.$('cloud-upload-status').textContent),'timeout message');await flush();
  assert.equal(t.calls.filter(c=>c.method==='POST').length,1,'write sent once');assert.ok(t.$('cloud-upload-preview').textContent.includes('Synthetic BLUE'),'preview kept');assert.equal(t.$('cloud-upload-consent').checked,false,'resend needs fresh consent');assert.equal(t.$('cloud-upload-send').disabled,true);assert.ok(t.lab.unchanged());});

test('upload is private by default, previews the exact body and needs consent; evidence is opt-in and private only',async()=>{
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p,init)=>m==='POST'&&p==='/v1/records'?{status:201,body:{record:{...rec('srv-1',JSON.parse(init.body).kind,JSON.parse(init.body).payload,{owner:'author-me',name:'Me',user:'me',visibility:JSON.parse(init.body).visibility})}}}:null});await t.ready;
  assert.equal(t.$('cloud-upload-visibility').value,'private');t.$('cloud-upload-read').click();await flush();assert.deepEqual(t.lab.calls,['cloudSnapshot']);assert.equal(t.calls.length,0,'reading local records sends nothing');
  t.$('cloud-upload-kind').change('run');t.$('cloud-upload-item').change('0');await until(()=>t.$('cloud-upload-preview').textContent.length>0,'run preview');
  let shown=JSON.parse(t.$('cloud-upload-preview').textContent);assert.equal(shown.visibility,'private');assert.equal('evidence' in shown.payload,false,'evidence off by default');assert.equal(t.$('cloud-upload-send').disabled,true,'consent required');
  t.$('cloud-upload-case').value='case-A';t.$('cloud-upload-case').dispatchEvent(new Event('input'));await until(()=>t.$('cloud-upload-preview').textContent.includes('case-A'),'case label in preview');
  t.$('cloud-upload-evidence').checked=true;t.$('cloud-upload-evidence').change();await until(()=>t.$('cloud-upload-preview').textContent.includes('evidence'),'evidence opt-in');
  t.$('cloud-upload-visibility').change('shared');await until(()=>t.$('cloud-upload-preview').textContent.includes('"shared"'),'shared preview');
  shown=JSON.parse(t.$('cloud-upload-preview').textContent);assert.equal('evidence' in shown.payload,false,'shared never carries evidence');assert.equal(t.$('cloud-upload-evidence').disabled,true);assert.equal(t.$('cloud-upload-consent').checked,false);
  t.$('cloud-upload-visibility').change('private');await until(()=>t.$('cloud-upload-preview').textContent.includes('"private"'),'private again');
  t.$('cloud-upload-consent').checked=true;t.$('cloud-upload-consent').change();assert.equal(t.$('cloud-upload-send').disabled,false);t.$('cloud-upload-send').click();await until(()=>/올렸습니다/.test(t.$('cloud-upload-status').textContent),'uploaded');
  const post=t.calls.find(c=>c.method==='POST');assert.deepEqual(post.body,JSON.parse(t.$('cloud-upload-preview').textContent),'sent body equals preview');assert.equal(post.headers.authorization,'Bearer '+TOKEN);assert.ok(t.lab.unchanged(),'local ledger untouched');
  t.$('cloud-upload-kind').change('review');t.$('cloud-upload-item').change('0');await until(()=>/먼저 올리고/.test(t.$('cloud-upload-status').textContent)||t.$('cloud-upload-preview').textContent.includes('srv-1'),'review links to cloud run');
  assert.ok(t.$('cloud-upload-preview').textContent.includes('"runId": "srv-1"'),'review points at uploaded cloud run');assert.ok(!t.$('cloud-upload-preview').textContent.includes('Local label'),'local reviewer label not sent');
  assert.ok(!t.$('cloud-upload-preview').textContent.includes('protocolVersion'),'an unconfirmed local review keeps its protocol unknown');assert.match(t.$('cloud-upload-review-conditions').textContent,/프로토콜 미상.*빠집니다/);
  t.$('cloud-upload-review-protocol').checked=true;t.$('cloud-upload-review-protocol').change();await until(()=>t.$('cloud-upload-preview').textContent.includes('"protocolVersion": "p1"'),'confirmed protocol');assert.equal(t.$('cloud-upload-consent').checked,false,'confirming resets consent');});

test('public harness preview only loads the editor and links to the existing Harness view',async()=>{
  const t=setup({routes:sharedRoute});await t.ready;t.$('cloud-refresh').click();await until(()=>t.records().length===2,'loaded');
  t.action(t.records()[0],'preview').click();await until(()=>t.lab.calls.length===1,'preview called');await flush();
  assert.equal(JSON.stringify(t.lab.calls[0]),JSON.stringify(['preview',harnessConfig,H]),'config and recorded hash only');assert.match(t.$('cloud-status').textContent,/등록·선택·실행은 하지 않았습니다/);
  const go=t.action(t.records()[0],'open-agents');assert.ok(go,'navigation button');assert.equal(go.dataset.view,'agents');assert.equal(t.calls.length,1,'no extra request');assert.ok(t.lab.unchanged());});

test('owner share, unshare and delete send the revision; conflicts change nothing',async()=>{
  const mine=rec('rec-m1','run',{...runPayload,localId:'local-run-1'},{owner:'author-me',name:'Me',user:'me',visibility:'private',revision:3});let patch=0;
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p,init)=>{if(m==='GET')return {status:200,body:{records:[mine],nextCursor:null}};if(m==='PATCH'){patch++;return patch===1?{status:409,body:{error:{code:'revision_conflict',message:'stale'}}}:{status:200,body:{record:{...mine,visibility:'shared',revision:4}}};}if(m==='DELETE')return {status:204};}});await t.ready;
  t.$('cloud-tab-mine').click();await until(()=>t.records().length===1,'mine');t.action(t.records()[0],'visibility').click();assert.match(t.records()[0].textContent,/로그인하지 않은 사람도 읽습니다/);assert.equal(t.calls.length,1,'share asks first');
  t.action(t.records()[0],'confirm').click();await until(()=>t.$('cloud-status').classList.contains('error'),'conflict');assert.match(t.$('cloud-status').textContent,/먼저 바뀌었습니다/);assert.deepEqual(t.calls[1].body,{expectedRevision:3,visibility:'shared'});assert.match(t.records()[0].textContent,/비공개/);
  t.action(t.records()[0],'visibility').click();t.action(t.records()[0],'confirm').click();await until(()=>/공유했습니다/.test(t.$('cloud-status').textContent),'shared');assert.match(t.records()[0].textContent,/버전 4/);
  t.action(t.records()[0],'delete').click();t.action(t.records()[0],'confirm').click();await until(()=>t.records().length===0,'deleted');const del=t.calls.at(-1);assert.equal(del.method,'DELETE');assert.equal(del.headers['if-match'],'4');assert.equal(del.url,BASE+'/v1/records/rec-m1');});

test('reviews of others\' shared runs are the author\'s own judgment; uncertain carries no score',async()=>{
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p,init)=>sharedRoute(m,p)||(m==='POST'?{status:201,body:{record:rec('srv-v1','review',JSON.parse(init.body).payload,{owner:'author-me',visibility:'private'})}}:null)});await t.ready;
  t.$('cloud-refresh').click();await until(()=>t.records().length===2,'loaded');t.action(t.records()[1],'review').click();assert.equal(t.$('cloud-review').hidden,false);
  t.$('cloud-review-score').change('5');t.$('cloud-review-verdict').change('uncertain');t.$('cloud-review-note').value='Synthetic: cannot judge from the reported summary.';t.$('cloud-review-note').dispatchEvent(new Event('input'));
  await until(()=>t.$('cloud-review-preview').textContent.length>0,'review preview');const body=JSON.parse(t.$('cloud-review-preview').textContent);
  assert.equal(body.visibility,'private');assert.equal(body.payload.score,null);assert.equal(body.payload.runId,'rec-r1');assert.equal(body.payload.caseLabel,'case-A');assert.equal(t.$('cloud-review-score').disabled,true);
  assert.equal(t.$('cloud-review-send').disabled,true);t.$('cloud-review-consent').checked=true;t.$('cloud-review-consent').change();t.$('cloud-review-send').click();await until(()=>/검수로 올렸습니다/.test(t.$('cloud-review-status').textContent),'review sent');
  assert.deepEqual(t.calls.at(-1).body,body);assert.equal(t.core.calls.some(c=>c[0]==='compare'),false,'no automatic comparison or model call');});

test('comparison draws the core result with its warnings and no ranking language',async()=>{
  const t=setup({routes:sharedRoute});await t.ready;t.$('cloud-refresh').click();await until(()=>t.records().length===2,'loaded');t.$('cloud-compare-run').click();await until(()=>t.$('cloud-compare-out').textContent.includes('조건 1'),'table');
  const out=t.$('cloud-compare-out').textContent;assert.equal(t.core.calls.find(c=>c[0]==='compare')[1],2);assert.match(out,/Synthetic BLUE v1/);assert.match(out,/로컬 broker 실행\(보고\)/);assert.match(out,/미평가/);
  assert.match(out,/사례 라벨이나 프로토콜이 없는 실행은 비교할 수 없어 뺐습니다\. \(1건\)/);assert.match(out,/대상 실행과 다른 검수는 검수 수·평균에서 뺐습니다\. \(1건\)/);assert.match(out,/검증되지 않았습니다/);assert.ok(!/1위|우승|정확도 검증됨/.test(out.replace('순위가 아닙니다','')));});

test('record JSON download fetches one record only on click: owner authenticated with private evidence, others anonymous, identity checked',async()=>{
  const full={...runPayload,localId:'local-run-1',evidence:{segments:[{id:'s0',label:'p1',text:'Synthetic paper text'}],response:{status:'ok'}}},mine=rec('rec-m1','run',runPayload,{owner:'author-me',name:'Me',user:'me',visibility:'private'});
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p)=>{if(m!=='GET')return null;if(p.startsWith('/v1/records?scope=mine'))return {status:200,body:{records:[mine],nextCursor:null}};if(p.startsWith('/v1/records?scope=shared'))return {status:200,body:{records:sharedRecords,nextCursor:null}};
    if(p==='/v1/records/rec-m1')return {status:200,body:{record:{...mine,payload:full}}};if(p==='/v1/records/rec-r1')return {status:200,body:{record:sharedRecords[1]}};if(p==='/v1/records/rec-h1')return {status:200,body:{record:{...sharedRecords[0],id:'rec-other'}}};return null;}});await t.ready;
  t.$('cloud-tab-mine').click();await until(()=>t.records().length===1,'mine');assert.equal(t.calls.length,1,'listing fetches no record detail');assert.equal(t.saved.length,0,'nothing downloads automatically');assert.match(t.records()[0].textContent,/비공개 증거/);
  t.action(t.records()[0],'download').click();await until(()=>t.saved.length===1,'owner saved');const get=t.calls[1];
  assert.equal(get.method,'GET');assert.equal(get.url,BASE+'/v1/records/rec-m1');assert.equal(get.headers.authorization,'Bearer '+TOKEN,'owner reads the full record signed in');
  assert.deepEqual(JSON.parse(await t.saved[0].text()).payload,full);assert.equal(t.anchors.at(-1).getAttribute('download'),'falsify-run-rec-m1.json');assert.match(t.$('cloud-status').textContent,/비공개 증거.*공유하지 마세요/);
  assert.ok(!t.body.textContent.includes('Synthetic paper text'),'private evidence is never rendered');
  t.$('cloud-tab-shared').click();await until(()=>t.records().length===2,'shared');
  t.action(t.records()[1],'download').click();await until(()=>t.saved.length===2,'public saved');assert.equal(t.calls.at(-1).url,BASE+'/v1/records/rec-r1');assert.equal(t.calls.at(-1).headers.authorization,undefined,'other authors are read anonymously');assert.match(t.$('cloud-status').textContent,/공개본/);
  t.action(t.records()[0],'download').click();await until(()=>t.$('cloud-status').classList.contains('error'),'identity mismatch');assert.equal(t.saved.length,2,'a different record is never saved');assert.match(t.$('cloud-status').textContent,/맞지 않아 저장하지 않았습니다/);
  // The downloaded full record lets a local review link to a run uploaded from another PC.
  t.$('cloud-upload-read').click();await flush();t.$('cloud-upload-kind').change('review');t.$('cloud-upload-item').change('0');await until(()=>t.$('cloud-upload-preview').textContent.includes('"runId": "rec-m1"'),'review linked via downloaded record');
  assert.equal(t.calls.filter(c=>c.method!=='GET').length,0,'no writes');assert.ok(t.lab.unchanged());});

test('own runs can be self-assessed: labelled, bound to the run case and protocol, never claimed independent',async()=>{
  const own=rec('rec-m1','run',runPayload,{owner:'author-me',name:'Me',user:'me',visibility:'private'}),bare=rec('rec-m2','run',{...runPayload,caseLabel:undefined,protocolVersion:undefined},{owner:'author-me',name:'Me',user:'me',visibility:'shared'});
  const t=setup({store:new Map([[KEY,meSession()]]),routes:(m,p)=>m==='GET'&&p.startsWith('/v1/records?scope=mine')?{status:200,body:{records:[own,bare],nextCursor:null}}:null});await t.ready;
  t.$('cloud-tab-mine').click();await until(()=>t.records().length===2,'mine');const btn=t.action(t.records()[0],'review');assert.ok(btn,'own private run can be assessed');assert.equal(btn.textContent,'자체 평가 쓰기');btn.click();
  assert.equal(t.$('cloud-review-title').textContent,'내 실행 자체 평가 쓰기');assert.match(t.$('cloud-review-intro').textContent,/독립 검수가 아니며/);assert.match(t.$('cloud-review-target').textContent,/나 · 자체 평가/);
  assert.equal(t.$('cloud-review-case').value,'case-A');assert.equal(t.$('cloud-review-case').disabled,true,'case label bound to the run');assert.equal(t.$('cloud-review-visibility').children[1].disabled,true,'a private run gets no shared review');assert.match(t.$('cloud-review-conditions').textContent,/묶여/);
  t.$('cloud-review-verdict').change('supported');t.$('cloud-review-score').change('4');t.$('cloud-review-note').value='Synthetic self assessment.';t.$('cloud-review-note').dispatchEvent(new Event('input'));
  await until(()=>t.$('cloud-review-preview').textContent.length>0,'preview');const body=JSON.parse(t.$('cloud-review-preview').textContent);assert.deepEqual([body.visibility,body.payload.caseLabel,body.payload.protocolVersion],['private','case-A','p1']);
  t.action(t.records()[1],'review').click();assert.match(t.$('cloud-review-conditions').textContent,/사례 라벨과 프로토콜이 없어.*빠집니다/);assert.equal(t.$('cloud-review-case').disabled,false);assert.equal(t.$('cloud-review-case').value,'','nothing filled in for a missing condition');assert.equal(t.$('cloud-review-preview').textContent,'');
  t.$('cloud-review-verdict').change('mixed');t.$('cloud-review-note').value='Synthetic.';t.$('cloud-review-note').dispatchEvent(new Event('input'));t.$('cloud-review-case').value='typed-case';t.$('cloud-review-case').dispatchEvent(new Event('input'));
  await until(()=>t.$('cloud-review-preview').textContent.length>0,'bare preview');const bare2=JSON.parse(t.$('cloud-review-preview').textContent).payload;assert.equal(bare2.caseLabel,'typed-case');assert.equal('protocolVersion' in bare2,false,'no protocol invented');
  assert.equal(t.calls.length,1,'nothing sent without consent');assert.equal(t.core.calls.some(c=>c[0]==='compare'),false);});

test('a signed-in browser survives reload; sign-out revokes then clears; another PC signs in again',async()=>{
  const store=new Map([[KEY,meSession()]]),t=setup({store,routes:(m,p)=>m==='POST'&&p==='/v1/logout'?{status:204}:null});await t.ready;await flush();
  assert.match(t.$('cloud-account-summary').textContent,/로그인됨 · Me/);assert.equal(t.calls.length,0,'restoring a session makes no request');
  t.$('cloud-logout').click();await until(()=>!store.has(KEY),'cleared');assert.equal(t.calls[0].url,BASE+'/v1/logout');assert.equal(t.calls[0].headers.authorization,'Bearer '+TOKEN);assert.match(t.$('cloud-status').textContent,/로그아웃했습니다/);
  const failing=setup({store:new Map([[KEY,meSession()]]),routes:()=>({status:503,body:'down'})});await failing.ready;failing.$('cloud-logout').click();await until(()=>failing.$('cloud-status').classList.contains('error'),'logout failure');assert.ok(failing.store.has(KEY),'failed revoke does not pretend');
  failing.$('cloud-forget').click();assert.equal(failing.store.has(KEY),false);
  const pc2=setup({routes:authOk});await pc2.ready;await login(pc2);assert.equal(JSON.parse(pc2.store.get(KEY)).author.id,'author-me','same author on another PC');});

// With the contract core beside it (after integration, or FALSIFY_CLOUD_CORE before), run the upload/review/compare path through the real validators.
const corePath=process.env.FALSIFY_CLOUD_CORE||path.resolve(__dirname,'../dist/cloud-records-core.mjs');
if(fs.existsSync(corePath))test('real contract core: run, evidence opt-in, linked review and comparison',async()=>{
  const Hc=require('../dist/harness-core.js');globalThis.FalsifyHarness=Hc;const C=await import(require('node:url').pathToFileURL(corePath).href),outer=x=>x===undefined?x:JSON.parse(JSON.stringify(x));
  const core={validatePayload:(k,p)=>C.validatePayload(k,outer(p)),runFromLocal:(r,o)=>C.runFromLocal(outer(r),outer(o)),reviewFromLocal:(v,id,o)=>C.reviewFromLocal(outer(v),id,outer(o)),compareRecords:rs=>C.compareRecords(outer(rs))};
  const harness=Hc.builtin('red'),hash=await Hc.hash(harness),segments=[{id:'s0',label:'p1',text:'Study does not show benefit.'}],sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const run={id:'local-run-1',createdAt:'2026-10-19T01:02:03.000Z',role:'red',revision:'rev',fileHash:F,sourceHash:await sha(segments[0].text),segments,harness,harnessHash:hash,maxCalls:8,level:1,model:'synthetic-model',provenance:'local-codex',
    response:{schema:'falsify.document-red.v1',revision:'rev',sourceHash:'x',status:'abstain',candidates:[],coverage:{complete:true,completedChunks:1,chunks:1,calls:1}}};
  const lab=labStub();lab.db.harnesses=[{config:harness,hash}];lab.db.runs=[run];lab.db.reviews=[{id:'local-review-1',runId:'local-run-1',reviewer:'Local label',caseLabel:'case-1',verdict:'supported',score:4,note:'Synthetic note.',createdAt:'2026-10-19T02:00:00Z'}];const localBefore=JSON.stringify(lab.db);
  let n=0;const posted=[],t=setup({lab,core,store:new Map([[KEY,meSession()]]),routes:(m,p,init)=>{if(m!=='POST')return null;const b=JSON.parse(init.body);posted.push(b);n++;return {status:201,body:{record:rec('00000000-0000-4000-8000-00000000000'+n,b.kind,b.payload,{owner:'author-me',name:'Me',user:'me',visibility:b.visibility})}};}});await t.ready;
  const send=async label=>{await until(()=>t.$('cloud-upload-preview').textContent.length>0,label+' preview');t.$('cloud-upload-consent').checked=true;t.$('cloud-upload-consent').change();t.$('cloud-upload-send').click();await until(()=>posted.length===n&&/올렸습니다/.test(t.$('cloud-upload-status').textContent),label+' sent');};
  t.$('cloud-upload-read').click();await flush();t.$('cloud-upload-item').change('0');await send('harness');
  t.$('cloud-upload-kind').change('run');t.$('cloud-upload-item').change('0');t.$('cloud-upload-case').value='case-1';t.$('cloud-upload-case').dispatchEvent(new Event('input'));
  t.$('cloud-upload-evidence').checked=true;t.$('cloud-upload-evidence').change();await until(()=>t.$('cloud-upload-preview').textContent.includes('"evidence"'),'real evidence opt-in');
  t.$('cloud-upload-evidence').checked=false;t.$('cloud-upload-evidence').change();await until(()=>t.$('cloud-upload-preview').textContent.includes('case-1')&&!t.$('cloud-upload-preview').textContent.includes('"evidence"'),'evidence off again');await send('run');
  assert.equal(posted[1].payload.protocolVersion,'falsify.document-red.v1');assert.equal(posted[1].payload.localId,'local-run-1');
  t.$('cloud-upload-kind').change('review');t.$('cloud-upload-item').change('0');await send('unconfirmed review');assert.equal(posted[2].payload.runId,'00000000-0000-4000-8000-000000000002');assert.equal('protocolVersion' in posted[2].payload,false,'local review protocol is never inferred');assert.ok(!JSON.stringify(posted[2]).includes('Local label'));
  t.$('cloud-compare-run').click();await until(()=>/대상 실행과 다른 검수는 검수 수·평균에서 뺐습니다/.test(t.$('cloud-compare-out').textContent),'real mismatch warning');assert.match(t.$('cloud-compare-out').textContent,/0건 · 검수자 0명/);
  t.$('cloud-upload-item').change('0');await until(()=>!t.$('cloud-upload-review-protocol').disabled&&t.$('cloud-upload-preview').textContent.length>0,'relinked');t.$('cloud-upload-review-protocol').checked=true;t.$('cloud-upload-review-protocol').change();
  await until(()=>t.$('cloud-upload-preview').textContent.includes('"protocolVersion"'),'confirmed protocol');await send('confirmed review');assert.equal(posted[3].payload.protocolVersion,'falsify.document-red.v1');assert.equal(posted[3].payload.supersedes,'00000000-0000-4000-8000-000000000003');
  t.$('cloud-compare-run').click();await until(()=>/1건 · 검수자 1명/.test(t.$('cloud-compare-out').textContent),'real comparison');assert.match(t.$('cloud-compare-out').textContent,/case-1/);assert.equal(JSON.stringify(lab.db),localBefore,'local ledger untouched');});

(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('ok - '+name);}catch(e){failed++;console.error('not ok - '+name+'\n'+(e.stack||e));}}
  console.log(JSON.stringify({passed:tests.length-failed,failed}));process.exitCode=failed?1:0;})();
