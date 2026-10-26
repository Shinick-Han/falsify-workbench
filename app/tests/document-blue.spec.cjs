const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const C=require('../dist/document-blue-core.js');
const doc={revision:'r1',sourceHash:'h1',fileHash:'f1',segments:[{id:'s0',label:'PDF p. 1',text:'Full invariance was found. Only partial invariance holds.'}],secretRed:'never send'};
const req=C.request(doc,3);assert.deepEqual(Object.keys(req).sort(),['schema','revision','sourceHash','requestId','maxCalls','consent','segments'].sort());assert.equal(JSON.stringify(req).includes('secretRed'),false);assert.throws(()=>C.request(doc,0));
const f={id:'f1',segmentId:'s0',quote:'Full invariance was found.',rationale:'Internal conflict.',evidence:[{segmentId:'s0',quote:'Only partial invariance holds.',relation:'contradicts'}],uncertainty:'Requires domain review.'};
const res={schema:C.VERSION,revision:'r1',sourceHash:'h1',status:'ok',findings:[f]};assert.equal(C.validateResponse(doc,res).length,1);
assert.throws(()=>C.validateResponse(doc,{...res,sourceHash:'other'}));assert.throws(()=>C.validateResponse(doc,{...res,status:'refusal'}));assert.throws(()=>C.validateResponse(doc,{...res,findings:[{...f,quote:'fabricated'}]}));assert.throws(()=>C.validateResponse(doc,{...res,findings:[{...f,evidence:[{segmentId:'s0',quote:'fabricated',relation:'x'}]}]}));
assert.equal(C.validateResponse(doc,{...res,status:'abstain',findings:[]}).length,0);assert.equal(C.validateResponse(doc,{...res,findings:[]}).length,0);
const plan={schema:'falsify.document-edit-plan.v1',outputFileHash:'f1',selected:[{id:'c1',label:'PDF p. 1',before:'Partial invariance was found.',after:'Full invariance was found.'}]};const p=C.validatePlan(doc,plan)[0];assert.deepEqual(C.overlaps(p,[f]),['f1']);assert.throws(()=>C.validatePlan(doc,{...plan,outputFileHash:'original-hash'}));assert.throws(()=>C.validatePlan(doc,{...plan,selected:[{...plan.selected[0],after:'absent'}]}));assert.deepEqual(C.overlaps(p,[]),[]);
const ui=fs.readFileSync(path.join(__dirname,'../dist/document-blue.js'),'utf8');
assert.doesNotMatch(ui,/innerHTML|insertAdjacentHTML|outerHTML/);assert.equal(/\btoken\b/.test(ui),false);assert.match(ui,/doc-blue-failure/);assert.match(ui,/safeFailure/);
assert.match(ui,/doc-blue-attempt-context/);assert.match(ui,/새 시도용 Harness 선택/);assert.match(ui,/unavailable/);assert.doesNotMatch(ui,/selectedOptions|blue-harness-detail/);
console.log('document-blue: 22 assertions passed');

const vm=require('node:vm');
const P=require('../dist/pending-job.js');
const H=require('../dist/harness-core.js');
const INSTANCE='ci1.'+'ab'.repeat(32);
const CITE='BLUE 재독 기준 인용이 해당 문단에 없거나 중복됩니다.';
const DROPDOWN='DEFAULT-DROPDOWN';
const DETAIL='DETAIL-DEFAULT-HARNESS';
function memory(){const raw=new Map();return {getItem:k=>raw.has(k)?raw.get(k):null,setItem:(k,v)=>raw.set(k,String(v)),removeItem:k=>raw.delete(k),raw};}
function syntheticDoc(){return {revision:'rev-1',sourceHash:'aa'.repeat(32),fileHash:'11'.repeat(32),format:'TXT',name:'synthetic.txt',segments:[{id:'s0',label:'p',text:'The claim is absolute.'}]};}
function harnessOf(over){return H.validate({...H.builtin('blue'),id:'synthetic-original',version:'2',...over});}
function blueRequest(d,harness,requestId){return {schema:C.VERSION,revision:d.revision,sourceHash:d.sourceHash,requestId,maxCalls:1,consent:true,segments:d.segments.map(s=>({id:s.id,label:s.label,text:s.text})),harness};}
async function plant(storage,harness,serverFailure){
  const d=syntheticDoc();
  const held=await P.hold({role:'blue',request:blueRequest(d,harness,'rev-1:failed-attempt'),doc:d,companionInstance:INSTANCE,storage,hashHarness:h=>H.hash(h),now:20});
  assert.equal(held.ok,true,held.message);
  const noted=await P.note(held.record,{postReceipt:'accepted',disposition:'failed',finishedAt:30,serverFailure},storage);
  assert.equal(noted.ok,true,noted.message);
  return noted.record;
}
function failedBody(record){return {id:record.requestId,role:'blue',state:'failed',sourceHash:record.sourceHash,revision:record.revision,harnessHash:record.harnessHash,companionInstance:record.companionInstance,requestBytesDigest:record.requestBytesDigest,error:record.serverFailure||'failed'};}
async function openFailed(storage,{connected=true}={}){
  let htmlWrites=0;const created=[];
  function element(id){
    const attrs=new Map();
    const e=new EventTarget();
    Object.assign(e,{id,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],files:[],className:'',htmlFor:'',type:'',labels:undefined,
      classList:{toggle(){}},replaceChildren(){},append(){},after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[],
      setAttribute(k,v){attrs.set(k,String(v));},getAttribute(k){return attrs.has(k)?attrs.get(k):null;},removeAttribute(k){attrs.delete(k);},
      addEventListener(t,f){EventTarget.prototype.addEventListener.call(this,t,f);}});
    Object.defineProperty(e,'innerHTML',{set(){htmlWrites++;},get(){return e.textContent||'';}});
    created.push(e);return e;
  }
  const find=id=>{for(const e of created)if(e.id===id)return e;return null;};
  const document=new EventTarget();
  Object.assign(document,{body:element('body'),createElement(){return element('');},querySelector:s=>{
    if(s.startsWith('#')){const id=s.slice(1),found=find(id);if(found)return found;if(id==='doc-blue-attempt-context')return null;return element(id);}
    const m=/^label\[for="([^"]+)"\]$/.exec(s);if(m){for(const e of created)if(e.htmlFor===m[1])return e;}
    return null;
  },querySelectorAll:()=>[]});
  const label=element('blue-harness-label');label.textContent='BLUE 실행 Harness';label.htmlFor='blue-harness';
  const select=element('blue-harness');select.labels=[label];
  for(const key of ['value','selectedOptions','selectedIndex','options','textContent'])Object.defineProperty(select,key,{get(){throw new Error('dropdown '+key+' inferred');},set(){throw new Error('dropdown '+key+' inferred');}});
  const detail=element('blue-harness-detail');Object.defineProperty(detail,'textContent',{get(){throw new Error('detail inferred');},set(){throw new Error('detail inferred');}});
  element('doc-blue-budget').value='4';
  const calls=[];let hashCalls=0,bindCalls=0;
  const cap={red:true,blue:true,pdf:false,companionInstance:INSTANCE};
  const bridge={busy(){},state:()=>({status:connected?'paired':'manual',connected,cap}),capabilities:()=>connected?cap:null,session:()=>connected?{request:async(p,body)=>{calls.push({path:p,body});
    if(p==='/api/blue/jobs')return {id:body.requestId,state:'running'};
    if(String(p).endsWith('/cancel'))return {};
    const saved=JSON.parse(storage.getItem(P.storageKey('blue')));
    if(p==='/api/blue/jobs/'+encodeURIComponent(saved.requestId))return failedBody(saved);
    throw new Error('unexpected '+p);
  }}:null};
  const lab={busy(){},allowed:()=>true,ready:Promise.resolve(),bind:async(role,r)=>{bindCalls++;return {...r,harness:H.builtin(role)};},record:async()=>'run-1'};
  const ctx=vm.createContext({document,crypto:globalThis.crypto,localStorage:storage,FalsifyDocumentBlue:C,FalsifyHarness:{...H,hash:async h=>{hashCalls++;return H.hash(h);}},FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyImport:{extract:async()=>{throw new Error('no file');}},TextEncoder,TextDecoder,CustomEvent,Event,AbortController,URL:{createObjectURL:()=>'blob:1',revokeObjectURL(){}},Blob,File,setTimeout,clearTimeout,confirm:()=>true,Uint8Array,Array,Map,Promise,Error,JSON,Number,String,Object,console});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../dist/pending-job.js'),'utf8'),ctx,{filename:'pending-job.js'});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../dist/document-blue.js'),'utf8'),ctx,{filename:'document-blue.js'});
  const get=id=>find(id);
  return {get,calls,label,select,htmlWrites:()=>htmlWrites,hashCalls:()=>hashCalls,bindCalls:()=>bindCalls,posts:()=>calls.filter(c=>c.path==='/api/blue/jobs'),cancels:()=>calls.filter(c=>String(c.path).endsWith('/cancel')),
    changeMenu(){document.dispatchEvent(new CustomEvent('falsify:harness-change',{detail:{role:'blue'}}));}};
}
function storedRequest(storage){return JSON.stringify(JSON.parse(storage.getItem(P.storageKey('blue'))).request);}
async function until(fn,label){for(let i=0;i<80&&!fn();i++)await new Promise(r=>setTimeout(r,25));assert.ok(fn(),label);}
function contextOf(page){const node=page.get('doc-blue-attempt-context');assert.ok(node);assert.equal(node.hidden,false);return node.textContent;}

async function offlineFailedAttempt(){
  const original=harnessOf({name:'Synthetic original BLUE'});
  const hash=await H.hash(original);
  const storage=memory();
  const record=await plant(storage,original,CITE+' <script>alert(1)</script>');
  const snap=storedRequest(storage);
  const page=await openFailed(storage);
  await until(()=>page.get('doc-blue-failure')&&page.get('doc-blue-failure').textContent.includes(CITE),'reload shows the preserved diagnostic');
  await until(()=>page.calls.some(c=>String(c.path).startsWith('/api/blue/jobs/')),'reload uses GET');
  assert.equal(page.hashCalls(),1);assert.equal(page.posts().length,0);
  const context=contextOf(page);
  assert.equal(context.includes('실패한 시도의 harness 이름 Synthetic original BLUE · 버전 2 · 해시 '+hash+' · 요청 '+record.requestId),true);
  assert.equal(context.includes(DROPDOWN),false);assert.equal(context.includes(DETAIL),false);assert.equal(context.includes('기본 BLUE'),false);
  assert.equal(context.includes('이 대기 작업 버리기'),true);assert.equal(context.includes('BLUE 독립 검토 시작'),true);assert.equal(context.includes('새 시도'),true);
  assert.equal(page.label.textContent,'새 시도용 Harness 선택');
  assert.equal(page.select.getAttribute('aria-describedby'),'doc-blue-attempt-context');
  assert.equal(page.get('doc-blue-failure').textContent.includes('<script>alert(1)</script>'),true);
  assert.equal(page.get('doc-blue-failure').textContent.includes(DROPDOWN),false);
  assert.equal(page.htmlWrites(),0);assert.equal(page.bindCalls(),0);assert.equal(page.posts().length,0);
  assert.equal(storedRequest(storage),snap);assert.equal(JSON.parse(storage.getItem(P.storageKey('blue'))).requestId,record.requestId);
  page.get('doc-blue-start').click();await new Promise(r=>setTimeout(r,40));
  assert.equal(page.posts().length,0);assert.equal(storedRequest(storage),snap);assert.equal(contextOf(page).includes('Synthetic original BLUE'),true);
  page.changeMenu();await new Promise(r=>setTimeout(r,20));
  assert.equal(page.posts().length,0);assert.equal(page.cancels().length,0);assert.equal(storedRequest(storage),snap);
  assert.equal(contextOf(page).includes('Synthetic original BLUE'),true);assert.equal(contextOf(page).includes(DROPDOWN),false);
  assert.equal(page.label.textContent,'새 시도용 Harness 선택');
  page.get('doc-blue-pending-discard').click();
  await until(()=>page.get('doc-blue-progress').textContent.includes('버렸습니다'),'deliberate discard');
  assert.equal(storage.getItem(P.storageKey('blue')),null);assert.equal(page.posts().length,0);assert.equal(page.cancels().length,0);
  assert.equal(page.get('doc-blue-attempt-context').hidden,true);assert.equal(page.get('doc-blue-attempt-context').textContent,'');
  assert.equal(page.label.textContent,'BLUE 실행 Harness');assert.equal(page.select.getAttribute('aria-describedby'),null);
  assert.equal(page.get('doc-blue-failure').textContent.includes(CITE),false);
  page.get('doc-blue-consent').checked=true;page.get('doc-blue-start').click();
  await until(()=>page.posts().length===1,'explicit start after discard posts once');
  await new Promise(r=>setTimeout(r,40));
  assert.equal(page.posts().length,1);assert.notEqual(page.posts()[0].body.requestId,record.requestId);
  assert.equal(page.posts()[0].body.harness.name,'기본 BLUE');assert.equal(JSON.stringify(page.posts()[0].body).includes('Synthetic original BLUE'),false);

  const htmlHarness=harnessOf({id:'synthetic-html',name:'Synthetic <img src=x onerror=alert(1)>',version:'3'});
  const htmlHash=await H.hash(htmlHarness);
  const htmlStore=memory();
  const htmlRecord=await plant(htmlStore,htmlHarness,CITE+' <img src=x onerror=alert(1)>');
  const htmlSnap=htmlStore.getItem(P.storageKey('blue'));
  const htmlPage=await openFailed(htmlStore,{connected:false});
  await until(()=>htmlPage.get('doc-blue-failure')&&htmlPage.get('doc-blue-failure').textContent.includes('<img src=x onerror=alert(1)>'),'safe diagnostic text');
  const htmlContext=contextOf(htmlPage);
  assert.equal(htmlContext.includes('실패한 시도의 harness 이름 Synthetic <img src=x onerror=alert(1)> · 버전 3 · 해시 '+htmlHash+' · 요청 '+htmlRecord.requestId),true);
  assert.equal(htmlPage.htmlWrites(),0);assert.equal(htmlPage.posts().length,0);assert.equal(htmlPage.hashCalls(),0);assert.equal(htmlStore.getItem(P.storageKey('blue')),htmlSnap);

  const secretHarness=harnessOf({id:'synthetic-secret',name:'Bearer zzz-synthetic-secret',version:'4'});
  const secretStore=memory();
  await plant(secretStore,secretHarness,CITE);
  const secretSnap=secretStore.getItem(P.storageKey('blue'));
  const secretPage=await openFailed(secretStore,{connected:false});
  await until(()=>secretPage.get('doc-blue-attempt-context')&&secretPage.get('doc-blue-attempt-context').textContent.includes('[redacted]'),'secret-shaped name is redacted');
  assert.equal(contextOf(secretPage).includes('zzz-synthetic-secret'),false);assert.equal(secretPage.get('doc-blue-failure').textContent.includes('zzz-synthetic-secret'),false);
  assert.equal(secretSnap.includes('zzz-synthetic-secret'),true);assert.equal(secretStore.getItem(P.storageKey('blue')),secretSnap);assert.equal(secretPage.posts().length,0);assert.equal(secretPage.htmlWrites(),0);

  const absentStore=memory();
  const absent=await plant(absentStore,original,CITE);
  const parsed=JSON.parse(absentStore.getItem(P.storageKey('blue')));
  delete parsed.request.harness.name;delete parsed.request.harness.version;parsed.request.harness={id:'leftover'};
  absentStore.setItem(P.storageKey('blue'),JSON.stringify(parsed));
  const absentSnap=absentStore.getItem(P.storageKey('blue'));
  const absentPage=await openFailed(absentStore,{connected:false});
  await until(()=>absentPage.get('doc-blue-attempt-context')&&absentPage.get('doc-blue-attempt-context').textContent.includes('unavailable'),'absent metadata');
  const absentText=contextOf(absentPage);
  assert.equal(absentText.includes('실패한 시도의 harness 이름 unavailable · 버전 unavailable · 해시 '+absent.harnessHash+' · 요청 '+absent.requestId),true);
  assert.equal(absentText.includes(DROPDOWN),false);assert.equal(absentText.includes('기본 BLUE'),false);assert.equal(absentText.includes('Synthetic original BLUE'),false);
  assert.equal(absentPage.hashCalls(),0);assert.equal(absentPage.bindCalls(),0);assert.equal(absentPage.posts().length,0);
  assert.equal(absentStore.getItem(P.storageKey('blue')),absentSnap);
  absentPage.get('doc-blue-start').click();await new Promise(r=>setTimeout(r,30));
  assert.equal(absentPage.posts().length,0);assert.equal(absentStore.getItem(P.storageKey('blue')),absentSnap);
  console.log('document-blue failed-attempt context: passed');
}
if(require.main===module){offlineFailedAttempt().catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={offlineFailedAttempt};
