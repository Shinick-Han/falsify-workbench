'use strict';
// Node VM regression for the ledger cloud hooks: FalsifyLab.cloudSnapshot(), FalsifyLab.previewSharedHarness()
// and FalsifyLab.restoreArchive(). Synthetic DOM and storage, synthetic paper and responses; no browser, network, server, CLI or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const H=require('../dist/harness-core.js'),R=require('../dist/document-red-core.js'),dist=path.resolve(__dirname,'../dist'),KEY='falsify.experiment-ledger.v1';
const tests=[];const test=(name,fn)=>tests.push([name,fn]);let ReviewBundle=null;
const flush=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const plain=x=>JSON.parse(JSON.stringify(x));
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
// Same synthetic DOM as ledger-provenance.spec.cjs: elements register by id; querySelector('#id') resolves or creates.
function ledger(stored,opts={}){
  const els=new Map(),store=new Map(stored||[]),writes=[],events=[],network=[];
  function element(tag){const e=new EventTarget(),classes=new Set();let id='';
    Object.defineProperty(e,'id',{get:()=>id,set:v=>{id=v;els.set(v,e);}});
    Object.assign(e,{tagName:String(tag).toUpperCase(),disabled:false,hidden:false,checked:false,value:'',textContent:'',placeholder:'',children:[],files:[],parent:null,dataset:{},attrs:{},
      classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
      setAttribute(k,v){this.attrs[k]=v;},append(...c){for(const x of c){if(x&&typeof x==='object')x.parent=this;this.children.push(x);}},replaceChildren(...c){this.children=[];this.append(...c);},prepend(...c){this.children.unshift(...c);},after(){},remove(){},reset(){},focus(){},
      closest(sel){let n=this;while(n){if(n.tagName===sel.toUpperCase())return n;n=n.parent;}return null;}});
    Object.defineProperty(e,'innerHTML',{set(){}});Object.defineProperty(e,'firstChild',{get(){return this.children[0]??null;}});return e;}
  const get=id=>{if(!els.has(id))element('div').id=id;return els.get(id);};
  const document=new EventTarget();Object.assign(document,{readyState:'complete',createElement:element,querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],body:element('body')});
  for(const type of ['falsify:harness-change','falsify:harness-consent'])document.addEventListener(type,e=>events.push(type+':'+e.detail.role));
  const ctx=vm.createContext({document,FalsifyReview:require('../dist/review-workbench.js'),FalsifyHarness:H,FalsifyReviewBundle:ReviewBundle,FalsifyLocalBridge:{capabilities:()=>null,state:()=>({status:'manual',connected:false,cap:null})},FalsifyDocumentRed:R,FalsifyDocumentBlue:require('../dist/document-blue-core.js'),
    localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>{if(opts.failWrite?.()){const e=Error('QuotaExceededError');e.name='QuotaExceededError';throw e;}writes.push(k);store.set(k,v);}},
    fetch(){network.push('fetch');throw Error('network disabled');},WebSocket(){network.push('WebSocket');throw Error('network disabled');},
    crypto:globalThis.crypto,TextEncoder,CustomEvent,Event,URL,Blob,setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync(path.join(dist,'experiment-ledger.js'),'utf8'),ctx,{filename:'experiment-ledger.js'});
  return {get,lab:ctx.FalsifyLab,store,writes,events,network};
}
const segments=[{id:'s0',label:'p1',text:'Study does not show benefit.'},{id:'s1',label:'p2',text:'Only an association was observed.'}];
const candidate={id:'c1',segmentId:'s0',level:1,before:'Study does not show benefit.',after:'Study does show benefit.',rationale:'Synthetic contradiction.',evidence:[{segmentId:'s1',quote:'Only an association was observed.',relation:'Synthetic qualification.'}],uncertainty:'Synthetic fixture only.'};
async function paper(){return {revision:'synthetic-rev',sourceHash:await sha(segments.map(s=>s.text).join('\n\n')),fileHash:'f'.repeat(64),name:'synthetic.txt',format:'TXT',segments};}
async function recordRun(w){const doc=await paper(),request=plain(await w.lab.bind('red',R.request(doc,1,8)));
  const response={schema:R.VERSION,revision:doc.revision,sourceHash:doc.sourceHash,status:'ok',candidates:[candidate],harness:request.harness,harnessHash:await H.hash(request.harness),model:'gpt-6.1-sol',coverage:{complete:true,completedChunks:1,chunks:1,calls:2}};
  return w.lab.record('red',doc,request,response,'local-codex');}
const shared={...H.builtin('blue'),id:'shared-blue',name:'Shared BLUE',adapter:{type:'stdio',executable:'C:\\Synthetic\\harness.exe',args:[]}};

test('cloudSnapshot waits for ready and returns a deep copy of the validated ledger',async()=>{
  const w=ledger(),pending=w.lab.cloudSnapshot();const first=await pending;assert.deepEqual(plain(first.harnesses.map(h=>h.config.id).sort()),['builtin-blue','builtin-red']);
  const id=await recordRun(w),snap=await w.lab.cloudSnapshot(),raw=w.store.get(KEY);assert.equal(snap.runs.length,1);assert.equal(snap.runs[0].id,id);
  snap.runs[0].response.status='mutated';snap.harnesses.length=0;snap.runs.push({});
  const again=await w.lab.cloudSnapshot();assert.equal(again.runs.length,1);assert.equal(again.runs[0].response.status,'ok');assert.equal(again.harnesses.length,2);assert.equal(w.store.get(KEY),raw,'snapshot never writes storage');});

test('cloudSnapshot refuses to export unreadable storage and leaves it untouched',async()=>{
  const w=ledger([[KEY,'{"schema":"corrupt"']]);await assert.rejects(w.lab.cloudSnapshot(),/백업 JSON을 복원/);assert.equal(w.store.get(KEY),'{"schema":"corrupt"');assert.deepEqual(w.writes,[]);
  const bad=ledger([[KEY,JSON.stringify({schema:KEY,harnesses:[{config:H.builtin('red'),hash:'0'.repeat(64)}],runs:[],reviews:[]})]]);await assert.rejects(bad.lab.cloudSnapshot());assert.deepEqual(bad.writes,[]);});

test('cloud payloads built from a snapshot validate against the shared core',async()=>{
  const C=await import('../dist/cloud-records-core.mjs'),w=ledger();await recordRun(w);const snap=await w.lab.cloudSnapshot(),run=snap.runs[0];
  const payload=C.runFromLocal(run,{harness:H,caseLabel:'case-1'});assert.deepEqual(await C.validatePayload('run',payload,{harness:H}),payload);assert.equal(payload.calls,2);assert.ok(!('evidence' in payload));
  const h=plain(snap.harnesses.find(x=>x.hash===run.harnessHash));assert.deepEqual(await C.validatePayload('harness',{config:h.config,hash:h.hash},{harness:H}),h);
  const full=C.runFromLocal(run,{harness:H,includeEvidence:true});assert.deepEqual(await C.validatePayload('run',full,{harness:H}),full);});

test('previewSharedHarness fills editor and review panel only: no registration, selection, events or storage',async()=>{
  const w=ledger(),pending=w.lab.previewSharedHarness(plain(shared));const hash=await pending;await flush();
  assert.equal(hash,await H.hash(shared));assert.deepEqual(JSON.parse(w.get('harness-editor').value),H.validate(shared),'ready default editor value does not overwrite the shared config');
  const box=w.get('harness-preview');assert.equal(box.hidden,false);assert.equal(box.children[0].textContent,'공유 Harness 검토');assert.match(JSON.stringify(box.children.map(c=>c.children.map(x=>x.textContent))),/미등록/);
  assert.match(w.get('harness-status').textContent,/등록·선택·실행은 하지 않았습니다/);
  assert.deepEqual(w.writes,[]);assert.equal(w.store.get(KEY),undefined);const snap=await w.lab.cloudSnapshot();assert.ok(!snap.harnesses.some(h=>h.hash===hash));
  assert.deepEqual(w.get('blue-harness').children.map(o=>o.value),[await H.hash(H.builtin('blue'))],'selection menu lists registered versions only');assert.ok(!w.events.some(e=>e.startsWith('falsify:harness-change')));
  assert.equal(await w.lab.previewSharedHarness(plain(shared),hash),hash,'matching expected hash accepted');});

test('previewSharedHarness rejects invalid configs and mismatched hashes without loading them',async()=>{
  const w=ledger();await w.lab.ready;const before=w.get('harness-editor').value;
  await assert.rejects(w.lab.previewSharedHarness({...shared,role:'gold'}));assert.equal(w.get('harness-preview').hidden,true);assert.equal(w.get('harness-editor').value,before);assert.ok(w.get('harness-status').classList.contains('error'));
  await assert.rejects(w.lab.previewSharedHarness(plain(shared),'0'.repeat(64)),/내용 해시/);assert.equal(w.get('harness-editor').value,before);assert.deepEqual(w.writes,[]);});

async function reviewBlue(w,withRed=true){
  const redDoc=await paper(),blueSegments=[{...segments[0],text:candidate.after},segments[1]],blueDoc={...redDoc,revision:'synthetic-blue',fileHash:'a'.repeat(64),sourceHash:await sha(blueSegments.map(s=>s.text).join('\n\n')),segments:blueSegments};
  if(withRed){const req=plain(await w.lab.bind('red',R.request(redDoc,1,4)));await w.lab.record('red',redDoc,req,{schema:R.VERSION,revision:redDoc.revision,sourceHash:redDoc.sourceHash,status:'ok',candidates:[candidate]},'manual-unverified',{finalState:{outputFileHash:blueDoc.fileHash,verification:null,selected:[{id:candidate.id,segmentId:'s0',label:'p1',before:candidate.before,after:candidate.after,offset:0,edited:false}]}});}
  const req=plain(await w.lab.bind('blue',require('../dist/document-blue-core.js').request(blueDoc,4)));
  const response={schema:'falsify.document-blue.v1',revision:blueDoc.revision,sourceHash:blueDoc.sourceHash,status:'ok',findings:[{id:'F1',segmentId:'s0',quote:candidate.after,rationale:'Synthetic conflicting interpretation.',evidence:candidate.evidence,uncertainty:'Synthetic only.'}]};
  const id=await w.lab.record('blue',blueDoc,req,response,'manual-unverified');await w.lab.review(id);return id;
}
test('native assisted review pairs exact RED output, persists item judgments and exposure, preserves raw response',async()=>{
  const w=ledger();await w.lab.ready;const id=await reviewBlue(w),before=plain((await w.lab.cloudSnapshot()).runs.find(r=>r.id===id).response);
  const tree=e=>[e.textContent,...e.children.filter(c=>c&&typeof c==='object').flatMap(tree)].join('\n');
  assert.match(tree(w.get('evaluation-output')).replace(/\s+/g,' '),/원래 문장[\s\S]*Study does not show benefit\.[\s\S]*바꾼 문장[\s\S]*Study does show benefit\./);
  assert.match(tree(w.get('evaluation-output')),/Synthetic contradiction/);
  w.get('evaluation-patch-0').value='detected';w.get('evaluation-patch-0').dispatchEvent(new Event('change'));
  w.get('evaluation-patch-note-0').value='Synthetic matching conflict.';w.get('evaluation-patch-note-0').dispatchEvent(new Event('input'));
  w.get('evaluation-finding-0').value='supported';w.get('evaluation-finding-0').dispatchEvent(new Event('change'));
  w.get('evaluation-finding-note-0').value='Synthetic source supports finding.';w.get('evaluation-finding-note-0').dispatchEvent(new Event('input'));
  w.get('evaluation-reviewer').value='Synthetic reviewer';w.get('evaluation-case').value='Synthetic condition';w.get('evaluation-verdict').value='supported';w.get('evaluation-note').value='Synthetic overall note.';
  w.get('evaluation-form').dispatchEvent(new Event('submit',{cancelable:true}));
  const after=await w.lab.cloudSnapshot(),v=after.reviews[0];assert.equal(after.reviews.length,1);assert.equal(v.reviewContext.mode,'red-assisted');assert.equal(v.findingAssessments[0].verdict,'supported');assert.match(v.note,/RED 공개 대조 · 블라인드 아님/);assert.equal(v.comparison.assessments[0].note,'Synthetic matching conflict.');assert.deepEqual(plain(after.runs.find(r=>r.id===id).response),before);
  const loaded=ledger([[KEY,w.store.get(KEY)]]);assert.deepEqual(plain((await loaded.lab.cloudSnapshot()).reviews),plain(after.reviews),'new optional review fields survive reload');
  const core=await import('../dist/cloud-records-core.mjs');assert.match(core.reviewFromLocal(v,'00000000-0000-4000-8000-000000000001').note,/RED 공개 대조 · 블라인드 아님/,'share retains exposure in note without publishing private comparison');
});
test('BLUE-only review works independently and item judgments require reasons',async()=>{
  const w=ledger();await w.lab.ready;await reviewBlue(w,false);w.get('evaluation-reviewer').value='Synthetic';w.get('evaluation-case').value='Synthetic';w.get('evaluation-verdict').value='uncertain';w.get('evaluation-note').value='Synthetic note';
  w.get('evaluation-finding-0').value='unsupported';w.get('evaluation-finding-0').dispatchEvent(new Event('change'));w.get('evaluation-form').dispatchEvent(new Event('submit',{cancelable:true}));assert.equal((await w.lab.cloudSnapshot()).reviews.length,0,'no reason means no saved judgment');
  w.get('evaluation-finding-note-0').value='Synthetic limitation.';w.get('evaluation-finding-note-0').dispatchEvent(new Event('input'));w.get('evaluation-form').dispatchEvent(new Event('submit',{cancelable:true}));const v=(await w.lab.cloudSnapshot()).reviews[0];assert.equal(v.comparison,null);assert.equal(v.reviewContext.mode,'blue-only');assert.equal(v.score,null);
  const Review=require('../dist/review-workbench.js'),run=(await w.lab.cloudSnapshot()).runs.at(-1);assert.throws(()=>Review.validateExtras({...v,findingAssessments:[{id:'made-up',verdict:'pending',note:''}]},run));assert.throws(()=>Review.validateExtras({...v,reviewContext:{mode:'blind-certified'}},run));assert.throws(()=>Review.validateExtras({...v,findingAssessments:[{id:'F1',verdict:'unsupported',note:''}]},run));
});
test('invalid or cancelled RED plan replacement retains displayed comparison, judgments and save binding',async()=>{
  const w=ledger();await w.lab.ready;await reviewBlue(w);const original=w.get('evaluation-patch-0');
  w.get('evaluation-patch-note-0').value='Synthetic preserved reason';w.get('evaluation-patch-note-0').dispatchEvent(new Event('input'));
  for(const file of [{size:1,text:async()=>'{bad json'},{size:200001,text:async()=>''},{size:50,text:async()=>JSON.stringify({schema:'falsify.document-edit-plan.v1',outputFileHash:'b'.repeat(64),selected:[]})}]){
    w.get('evaluation-plan').files=[file];w.get('evaluation-plan').dispatchEvent(new Event('change'));await flush();assert.match(w.get('evaluation-plan-status').textContent,/기존 RED 대조와 판정을 유지/);assert.equal(w.get('evaluation-patch-0'),original);
  }
  w.get('evaluation-plan').files=[];w.get('evaluation-plan').dispatchEvent(new Event('change'));await flush();assert.match(w.get('evaluation-plan-status').textContent,/기존 RED 대조와 판정을 유지/);
  original.value='uncertain';assert.doesNotThrow(()=>original.dispatchEvent(new Event('change')));
  w.get('evaluation-reviewer').value='Synthetic reviewer';w.get('evaluation-case').value='Synthetic condition';w.get('evaluation-verdict').value='uncertain';w.get('evaluation-note').value='Synthetic replacement probe';w.get('evaluation-form').dispatchEvent(new Event('submit',{cancelable:true}));
  const v=(await w.lab.cloudSnapshot()).reviews[0];assert.equal(v.comparison.assessments[0].note,'Synthetic preserved reason');assert.equal(v.comparison.assessments[0].verdict,'uncertain');assert.ok(v.comparison.sourceRunId);
});

const Blue=require('../dist/document-blue-core.js');
const tags=(e,tag)=>{const out=[];if(e.tagName===tag)out.push(e.textContent);for(const c of e.children||[])if(c&&typeof c==='object')out.push(...tags(c,tag));return out;};
const redTexts=['Alpha does not show benefit in the cohort.','Only an association was observed in winter.','The sample excluded untreated controls.','Follow-up stopped before the endpoint.','Authors call the result conclusive.'];
const changed='Alpha does show benefit in the cohort.';
async function fiveArchive(){
  const w=ledger();await w.lab.ready;
  const redSegments=redTexts.map((text,i)=>({id:'s'+i,label:'p'+(i+1),text})),blueSegments=redSegments.map((s,i)=>i===0?{...s,text:changed}:{...s});
  const redDoc={revision:'synthetic-red',sourceHash:await sha(redSegments.map(s=>s.text).join('\n\n')),fileHash:'f'.repeat(64),name:'synthetic.txt',format:'TXT',segments:redSegments};
  const blueDoc={revision:'synthetic-blue',sourceHash:await sha(blueSegments.map(s=>s.text).join('\n\n')),fileHash:'a'.repeat(64),name:'synthetic-blue.txt',format:'TXT',segments:blueSegments};
  const redReq=plain(await w.lab.bind('red',R.request(redDoc,1,4)));redReq.requestId='synthetic-red-exec';
  const response={schema:R.VERSION,revision:redDoc.revision,sourceHash:redDoc.sourceHash,status:'ok',candidates:[{id:'c1',segmentId:'s0',level:1,before:redTexts[0],after:changed,rationale:'Synthetic contradiction.',evidence:[{segmentId:'s1',quote:redTexts[1],relation:'Synthetic qualification.'}],uncertainty:'Synthetic fixture only.'}],harness:redReq.harness,harnessHash:await H.hash(redReq.harness),model:'gpt-6.1-sol',coverage:{complete:true,completedChunks:1,chunks:1,calls:2}};
  const rootId=await w.lab.record('red',redDoc,redReq,response,'local-codex');
  const snapId=await w.lab.record('red',redDoc,redReq,response,'local-codex',{snapshotOf:rootId,finalState:{outputFileHash:blueDoc.fileHash,verification:{synthetic:true},selected:[{id:'c1',segmentId:'s0',label:'p1',before:redTexts[0],after:changed,offset:0,edited:false}]}});
  const blueReq=plain(await w.lab.bind('blue',Blue.request(blueDoc,4)));
  const findings=blueSegments.map((s,i)=>({id:'F'+(i+1),segmentId:s.id,quote:s.text,rationale:'Synthetic finding '+(i+1)+'.',evidence:[{segmentId:s.id,quote:s.text.slice(0,20),relation:'Synthetic support.'}],uncertainty:'Synthetic only.'}));
  const blueId=await w.lab.record('blue',blueDoc,blueReq,{schema:Blue.VERSION,revision:blueDoc.revision,sourceHash:blueDoc.sourceHash,status:'ok',findings},'manual-unverified');
  await w.lab.review(blueId);
  for(let i=0;i<5;i++){w.get('evaluation-finding-'+i).value='supported';w.get('evaluation-finding-'+i).dispatchEvent(new Event('change'));w.get('evaluation-finding-note-'+i).value='Synthetic source supports F'+(i+1)+'.';w.get('evaluation-finding-note-'+i).dispatchEvent(new Event('input'));}
  w.get('evaluation-patch-0').value='detected';w.get('evaluation-patch-0').dispatchEvent(new Event('change'));
  w.get('evaluation-patch-note-0').value='Synthetic matching conflict.';w.get('evaluation-patch-note-0').dispatchEvent(new Event('input'));
  w.get('evaluation-reviewer').value='Synthetic reviewer';w.get('evaluation-case').value='Synthetic condition';w.get('evaluation-verdict').value='supported';w.get('evaluation-score').value='4';w.get('evaluation-note').value='Synthetic overall note.';
  w.get('evaluation-form').dispatchEvent(new Event('submit',{cancelable:true}));
  const laterReq=plain(await w.lab.bind('red',R.request(redDoc,1,4)));laterReq.requestId='synthetic-red-later';
  const laterId=await w.lab.record('red',redDoc,laterReq,{...response,harness:laterReq.harness,harnessHash:await H.hash(laterReq.harness)},'manual-unverified',{finalState:{outputFileHash:blueDoc.fileHash,verification:null,selected:[{id:'c1',segmentId:'s0',label:'p1',before:redTexts[0],after:'show benefit',offset:0,edited:true}]}});
  const unrelatedId=await recordRun(w);
  const snap=await w.lab.cloudSnapshot();
  const archive=await ReviewBundle.buildExperimentArchive(snap,blueId,{harness:H,red:R,blue:Blue,review:require('../dist/review-workbench.js')});
  return {w,snap,archive,rootId,snapId,blueId,laterId,unrelatedId};
}
test('bind strips archive, bundle and Confluence auth material before a model request',async()=>{
  const w=ledger();await w.lab.ready;const doc=await paper();
  const request=await w.lab.bind('red',{...R.request(doc,1,4),archive:{accessToken:'synthetic-token'},bundle:{schema:'falsify.review-bundle.v1'},reviewBundle:{},restoreBundle:{},confluence:{session:'sealed'},confluenceSession:'sealed',oauth:'synthetic-oauth',accessToken:'synthetic-token',refreshToken:'synthetic-refresh',authorization:'Bearer synthetic',bearer:'synthetic',clientSecret:'synthetic-secret',archiveSha256:'ab',archiveHash:'cd',teamShare:true,nonce:'synthetic-nonce',session:'sealed',finalState:{selected:[]},gold:true});
  for(const k of ['archive','bundle','reviewBundle','restoreBundle','confluence','confluenceSession','oauth','accessToken','refreshToken','authorization','bearer','clientSecret','archiveSha256','archiveHash','teamShare','nonce','session','finalState','gold'])assert.equal(k in request,false,k);
  assert.equal(request.schema,R.VERSION);assert.ok(request.harness);assert.equal(request.segments.length,2);assert.equal(w.network.length,0);
});
test('restoreArchive opens a five-finding RED+BLUE review and reloads item judgments without executing',async()=>{
  const {w,snap,archive,rootId,snapId,blueId,laterId,unrelatedId}=await fiveArchive();
  assert.deepEqual(archive.data.ledger.runs.map(r=>r.id),[rootId,snapId,blueId,laterId]);
  assert.equal(archive.data.ledger.reviews[0].findingAssessments.length,5);
  assert.equal(archive.data.ledger.reviews[0].comparison.sourceRunId,snapId);
  assert.deepEqual(plain(archive.data.ledger.runs.find(r=>r.id===blueId).response),plain(snap.runs.find(r=>r.id===blueId).response));
  const fresh=ledger();await fresh.lab.ready;const selected=fresh.get('red-harness').value;
  const restored=await fresh.lab.restoreArchive(archive);
  assert.equal(restored.kind,'experiment');assert.equal(restored.runId,blueId);
  assert.equal(fresh.get('evaluation-run').value,blueId);assert.equal(fresh.get('red-harness').value,selected);
  assert.equal(fresh.get('red-harness-consent').checked,false);assert.equal(fresh.get('blue-harness-consent').checked,false);assert.equal(fresh.network.length,0);
  const got=await fresh.lab.cloudSnapshot();
  assert.ok(got.runs.every(r=>r.provenance==='imported-unverified'));assert.ok(!got.runs.some(r=>r.id===unrelatedId));
  assert.equal(got.runs.find(r=>r.id===snapId).snapshotOf,rootId);assert.equal(got.runs.find(r=>r.id===rootId).snapshotOf,undefined);
  assert.deepEqual(plain(got.runs.find(r=>r.id===blueId).response),plain(snap.runs.find(r=>r.id===blueId).response));
  assert.equal(got.reviews[0].findingAssessments.length,5);assert.equal(got.reviews[0].reviewContext.mode,'red-assisted');assert.equal(got.reviews[0].comparison.sourceRunId,snapId);
  assert.match(fresh.get('ledger-summary').textContent,/로컬 broker 실행 0건/);assert.match(fresh.get('ledger-summary').textContent,/가져온 기록/);
  assert.ok(tags(fresh.get('evaluation-output'),'INS').includes('show benefit'));
  assert.equal((await fresh.lab.cloudSnapshot()).runs.find(r=>r.id===snapId).finalState.selected[0].after,changed);
  const loaded=ledger([[KEY,fresh.store.get(KEY)]]);assert.equal((await loaded.lab.cloudSnapshot()).reviews[0].findingAssessments.length,5);
  assert.equal(await loaded.lab.review(blueId),true);assert.ok(tags(loaded.get('evaluation-output'),'INS').includes('show benefit'));
  const writes=w.writes.length;const repeat=await w.lab.restoreArchive(archive);assert.equal(repeat.kind,'experiment');assert.equal(repeat.runId,blueId);
  assert.equal(w.writes.length,writes);assert.equal((await w.lab.cloudSnapshot()).runs.find(r=>r.id===rootId).provenance,'local-codex');
  assert.equal((await w.lab.cloudSnapshot()).runs.find(r=>r.id===unrelatedId).provenance,'local-codex');
});
test('repeat restore, tamper, collision and storage failure do not partially write or upgrade provenance',async()=>{
  const {w,archive,blueId,unrelatedId}=await fiveArchive();
  const fresh=ledger();await fresh.lab.restoreArchive(archive);const once=fresh.store.get(KEY),n=fresh.writes.length;
  const repeat=await fresh.lab.restoreArchive(archive);assert.equal(repeat.kind,'experiment');assert.equal(repeat.runId,blueId);
  assert.equal(fresh.writes.length,n);assert.equal(fresh.store.get(KEY),once);assert.ok((await fresh.lab.cloudSnapshot()).runs.every(r=>r.provenance==='imported-unverified'));
  const tampered=plain(archive);tampered.data.ledger.runs.find(r=>r.id===blueId).sourceHash='0'.repeat(64);
  const raw=fresh.store.get(KEY);await assert.rejects(fresh.lab.restoreArchive(tampered));assert.equal(fresh.store.get(KEY),raw);assert.match(fresh.get('ledger-status').textContent,/아카이브 복원 차단/);
  const host=ledger([[KEY,w.store.get(KEY)]]);await host.lab.ready;const hostRaw=host.store.get(KEY);
  const bad=plain(archive);bad.data.ledger.runs.find(r=>r.id===blueId).response.findings[0].rationale='Tampered synthetic rationale.';
  await assert.rejects(host.lab.restoreArchive(bad),/같은 실행 ID|형식|malformed|응답/);assert.equal(host.store.get(KEY),hostRaw);
  assert.equal((await host.lab.cloudSnapshot()).runs.find(r=>r.id===unrelatedId).provenance,'local-codex');
  const gate={fail:false},dest=ledger(undefined,{failWrite:()=>gate.fail});await dest.lab.ready;gate.fail=true;
  await assert.rejects(dest.lab.restoreArchive(archive),/기존 기록은 그대로입니다/);assert.equal(dest.store.get(KEY),undefined);assert.equal((await dest.lab.cloudSnapshot()).runs.length,0);assert.deepEqual(dest.writes,[]);assert.equal(dest.network.length,0);
  const config={...H.builtin('blue'),id:'archive-blue',name:'Archive BLUE'},hash=await H.hash(config);
  const harnessArchive=await ReviewBundle.buildHarnessArchive({config,hash},{harness:H});
  const box=ledger();await box.lab.ready;const stored=box.store.get(KEY),menu=box.get('blue-harness').value;
  const loaded=await box.lab.restoreArchive(harnessArchive);assert.equal(loaded.kind,'harness');assert.equal(loaded.hash,hash);
  assert.equal(box.store.get(KEY),stored);assert.equal(box.get('blue-harness').value,menu);assert.equal(box.get('blue-harness-consent').checked,false);
  assert.equal(JSON.parse(box.get('harness-editor').value).id,'archive-blue');assert.match(box.get('harness-status').textContent,/등록·선택·실행은 하지 않았습니다/);assert.equal(box.network.length,0);
});
test('preexisting local RED root gains an imported snapshot, reloads and re-exports; a conflicting parent writes nothing',async()=>{
  const {archive,rootId,snapId,blueId}=await fiveArchive();
  const rootRun=archive.data.ledger.runs.find(r=>r.id===rootId);
  const rootOnly={schema:KEY,harnesses:archive.data.ledger.harnesses.filter(h=>h.hash===rootRun.harnessHash),runs:[plain(rootRun)],reviews:[]};
  const local=ledger([[KEY,JSON.stringify(rootOnly)]]);await local.lab.ready;
  const before=await local.lab.cloudSnapshot(),beforeCounts=H.counts(before.runs);
  assert.equal(before.runs.length,1);assert.equal(before.runs[0].id,rootId);assert.equal(before.runs[0].provenance,'local-codex');
  assert.equal(beforeCounts.executed,1);assert.equal(beforeCounts.snapshots,0);assert.equal(beforeCounts.calls,2);
  const restored=await local.lab.restoreArchive(archive);
  assert.equal(restored.kind,'experiment');assert.equal(restored.runId,blueId);
  const got=await local.lab.cloudSnapshot(),counts=H.counts(got.runs);
  assert.equal(got.runs.find(r=>r.id===rootId).provenance,'local-codex');
  assert.deepEqual(plain(got.runs.find(r=>r.id===rootId).response),plain(rootRun.response));
  assert.equal(got.runs.find(r=>r.id===snapId).provenance,'imported-unverified');
  assert.equal(got.runs.find(r=>r.id===snapId).snapshotOf,rootId);
  assert.deepEqual(plain(got.runs.find(r=>r.id===snapId).response),plain(rootRun.response));
  assert.equal(counts.executed,1);assert.equal(counts.calls,2);assert.equal(counts.snapshots,1);
  assert.match(local.get('ledger-summary').textContent,/로컬 broker 실행 1건/);
  const stored=local.store.get(KEY),writes=local.writes.length;
  const repeat=await local.lab.restoreArchive(archive);
  assert.equal(repeat.kind,'experiment');assert.equal(repeat.runId,blueId);
  assert.equal(local.writes.length,writes);assert.equal(local.store.get(KEY),stored);
  assert.equal((await local.lab.cloudSnapshot()).runs.find(r=>r.id===rootId).provenance,'local-codex');
  const loaded=ledger([[KEY,stored]]);
  const exported=await loaded.lab.cloudSnapshot();
  assert.equal(exported.runs.find(r=>r.id===rootId).provenance,'local-codex');
  assert.equal(exported.runs.find(r=>r.id===snapId).provenance,'imported-unverified');
  assert.equal(H.counts(exported.runs).executed,1);assert.equal(H.counts(exported.runs).calls,2);
  const validators={harness:H,red:R,blue:require('../dist/document-blue-core.js'),review:require('../dist/review-workbench.js')};
  const rebuilt=await ReviewBundle.buildExperimentArchive(exported,blueId,validators);
  const norm=await ReviewBundle.validateArchive(rebuilt,validators);
  assert.equal(norm.data.ledger.runs.find(r=>r.id===rootId).provenance,'local-codex');
  assert.equal(norm.data.ledger.runs.find(r=>r.id===snapId).provenance,'imported-unverified');
  assert.deepEqual(plain(norm.data.ledger.runs.find(r=>r.id===rootId).response),plain(rootRun.response));
  assert.equal((await loaded.lab.restoreArchive(rebuilt)).runId,blueId);
  assert.equal(loaded.store.get(KEY),stored);assert.deepEqual(loaded.writes,[]);
  const parent=ledger([[KEY,JSON.stringify(rootOnly)]]);await parent.lab.ready;const parentRaw=parent.store.get(KEY);
  const flipped=plain(archive);
  flipped.data.ledger.runs.find(r=>r.id===rootId).provenance='imported-unverified';
  flipped.data.ledger.runs.find(r=>r.id===snapId).provenance='local-codex';
  await assert.rejects(parent.lab.restoreArchive(flipped),e=>e.code==='missing_ref');
  assert.equal(parent.store.get(KEY),parentRaw);assert.equal((await parent.lab.cloudSnapshot()).runs.length,1);
  assert.equal((await parent.lab.cloudSnapshot()).runs[0].provenance,'local-codex');assert.ok(!(await parent.lab.cloudSnapshot()).runs.some(r=>r.snapshotOf));
  const forged=plain(archive);forged.data.ledger.runs.find(r=>r.id===snapId).response.candidates[0].rationale='Forged parent rationale.';
  const forgeHost=ledger([[KEY,JSON.stringify(rootOnly)]]);await forgeHost.lab.ready;const forgeRaw=forgeHost.store.get(KEY);
  await assert.rejects(forgeHost.lab.restoreArchive(forged),e=>e.code==='missing_ref');
  assert.equal(forgeHost.store.get(KEY),forgeRaw);assert.equal((await forgeHost.lab.cloudSnapshot()).runs.length,1);assert.equal((await forgeHost.lab.cloudSnapshot()).runs[0].provenance,'local-codex');
  const corrupt=plain(got);
  corrupt.runs.find(r=>r.id===rootId).provenance='imported-unverified';
  corrupt.runs.find(r=>r.id===snapId).provenance='local-codex';
  const rawCorrupt=JSON.stringify(corrupt);
  const refused=ledger([[KEY,rawCorrupt]]);
  await assert.rejects(refused.lab.cloudSnapshot(),/백업 JSON을 복원/);
  assert.equal(refused.store.get(KEY),rawCorrupt);assert.deepEqual(refused.writes,[]);
});

(async()=>{ReviewBundle=await import('../dist/review-bundle.mjs');let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
  console.log(JSON.stringify({passed,total:tests.length}));if(passed!==tests.length)process.exit(1);})();
