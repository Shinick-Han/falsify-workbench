'use strict';
// Node VM regression for the ledger cloud hooks: FalsifyLab.cloudSnapshot(), FalsifyLab.previewSharedHarness()
// and FalsifyLab.restorePrivateBundle(). Synthetic DOM and storage, synthetic paper and responses; no browser, network, server, CLI or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const H=require('../dist/harness-core.js'),R=require('../dist/document-red-core.js'),dist=path.resolve(__dirname,'../dist'),KEY='falsify.experiment-ledger.v1';
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
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
  const ctx=vm.createContext({document,FalsifyReview:require('../dist/review-workbench.js'),FalsifyHarness:H,FalsifyLocalBridge:{capabilities:()=>null,state:()=>({status:'manual',connected:false,cap:null})},FalsifyDocumentRed:R,FalsifyDocumentBlue:require('../dist/document-blue-core.js'),
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

const BUNDLE='falsify.private-review-bundle.v1';
const tree=e=>[e.textContent,...(e.children||[]).filter(c=>c&&typeof c==='object').flatMap(tree)].join('\n');
const tags=(e,tag)=>{const out=[];if(e.tagName===tag)out.push(e.textContent);for(const c of e.children||[])if(c&&typeof c==='object')out.push(...tags(c,tag));return out;};
const optionValues=e=>{const out=[];if(e&&e.value)out.push(e.value);for(const c of e?.children||[])if(c&&typeof c==='object')out.push(...optionValues(c));return out;};
function bundleOf(snap,selectedRunId,ids){
  const keep=new Set(ids),runs=snap.runs.filter(r=>keep.has(r.id)),hashes=new Set(runs.map(r=>r.harnessHash));
  return {schema:BUNDLE,selectedRunId,ledger:{schema:KEY,harnesses:snap.harnesses.filter(h=>hashes.has(h.hash)),runs,reviews:snap.reviews.filter(v=>keep.has(v.runId))}};
}
// Minimal closure a private bundle must carry: selected run, snapshot/source ancestors, review comparison RED, and the latest file-hash RED when BLUE has no explicit source.
function closureIds(snap,selectedRunId){
  const byId=new Map(snap.runs.map(r=>[r.id,r])),ids=new Set();
  const add=id=>{if(!id||ids.has(id)||!byId.has(id))return;ids.add(id);const r=byId.get(id);add(r.snapshotOf);add(r.sourceRunId);};
  add(selectedRunId);let grew=true;
  while(grew){grew=false;for(const v of snap.reviews){if(!ids.has(v.runId))continue;const red=v.comparison?.sourceRunId;if(red&&!ids.has(red)){add(red);grew=true;}}
    for(const id of [...ids]){const r=byId.get(id);if(r?.role!=='blue'||r.sourceRunId)continue;const src=snap.runs.filter(x=>x.role==='red'&&x.finalState?.outputFileHash===r.fileHash).at(-1);if(src&&!ids.has(src.id)){add(src.id);grew=true;}}}
  return [...ids];
}
function saveReview(w,note='Synthetic overall note.'){
  w.get('evaluation-patch-0').value='detected';w.get('evaluation-patch-0').dispatchEvent(new Event('change'));
  w.get('evaluation-patch-note-0').value='Synthetic matching conflict.';w.get('evaluation-patch-note-0').dispatchEvent(new Event('input'));
  w.get('evaluation-finding-0').value='supported';w.get('evaluation-finding-0').dispatchEvent(new Event('change'));
  w.get('evaluation-finding-note-0').value='Synthetic source supports finding.';w.get('evaluation-finding-note-0').dispatchEvent(new Event('input'));
  w.get('evaluation-reviewer').value='Synthetic reviewer';w.get('evaluation-case').value='Synthetic condition';w.get('evaluation-verdict').value='supported';w.get('evaluation-score').value='4';w.get('evaluation-note').value=note;
  w.get('evaluation-form').dispatchEvent(new Event('submit',{cancelable:true}));
}
async function judgedPair(){
  const w=ledger();await w.lab.ready;
  const redDoc=await paper(),blueSegments=[{...segments[0],text:candidate.after},segments[1]];
  const blueDoc={...redDoc,revision:'synthetic-blue',fileHash:'a'.repeat(64),sourceHash:await sha(blueSegments.map(s=>s.text).join('\n\n')),segments:blueSegments};
  const redReq=plain(await w.lab.bind('red',R.request(redDoc,1,4)));redReq.requestId='synthetic-red-exec';
  const redResponse={schema:R.VERSION,revision:redDoc.revision,sourceHash:redDoc.sourceHash,status:'ok',candidates:[candidate],harness:redReq.harness,harnessHash:await H.hash(redReq.harness),model:'gpt-6.1-sol',coverage:{complete:true,completedChunks:1,chunks:1,calls:2}};
  const rootId=await w.lab.record('red',redDoc,redReq,redResponse,'local-codex');
  const snapId=await w.lab.record('red',redDoc,redReq,redResponse,'local-codex',{finalState:{outputFileHash:blueDoc.fileHash,verification:{synthetic:true},selected:[{id:candidate.id,segmentId:'s0',label:'p1',before:candidate.before,after:candidate.after,offset:0,edited:false}]},snapshotOf:rootId});
  const blueReq=plain(await w.lab.bind('blue',require('../dist/document-blue-core.js').request(blueDoc,4)));
  const blueResponse={schema:'falsify.document-blue.v1',revision:blueDoc.revision,sourceHash:blueDoc.sourceHash,status:'ok',findings:[{id:'F1',segmentId:'s0',quote:candidate.after,rationale:'Synthetic conflicting interpretation.',evidence:candidate.evidence,uncertainty:'Synthetic only.'}]};
  const blueId=await w.lab.record('blue',blueDoc,blueReq,blueResponse,'manual-unverified');
  await w.lab.review(blueId);saveReview(w);
  const laterReq=plain(await w.lab.bind('red',R.request(redDoc,1,4)));laterReq.requestId='synthetic-red-later';
  const laterId=await w.lab.record('red',redDoc,laterReq,{...redResponse,harness:laterReq.harness,harnessHash:await H.hash(laterReq.harness)},'manual-unverified',{finalState:{outputFileHash:blueDoc.fileHash,verification:null,selected:[{id:candidate.id,segmentId:'s0',label:'p1',before:candidate.before,after:'show benefit',offset:0,edited:true}]}});
  const unrelatedId=await recordRun(w);
  const snap=await w.lab.cloudSnapshot();
  return {w,snap,blueId,rootId,snapId,laterId,unrelatedId};
}
async function untouched(w,fn){const raw=w.store.get(KEY),writes=w.writes.length,runs=plain((await w.lab.cloudSnapshot()).runs);await assert.rejects(fn());assert.equal(w.store.get(KEY),raw);assert.equal(w.writes.length,writes);assert.deepEqual(plain((await w.lab.cloudSnapshot()).runs),runs);assert.equal(w.network.length,0);}

test('restorePrivateBundle rejects corrupt storage, a bad envelope, truncation-sized input, hash tamper and missing ancestors',async()=>{
  const corrupt=ledger([[KEY,'{"schema":"corrupt"']]);await assert.rejects(corrupt.lab.restorePrivateBundle({schema:BUNDLE,selectedRunId:'x',ledger:{schema:KEY,harnesses:[],runs:[],reviews:[]}}),/백업 JSON을 복원/);assert.equal(corrupt.store.get(KEY),'{"schema":"corrupt"');assert.deepEqual(corrupt.writes,[]);
  const {w,snap,blueId,snapId,rootId}=await judgedPair(),ids=closureIds(snap,blueId),full=bundleOf(snap,blueId,ids);
  assert.deepEqual(ids.slice().sort(),[blueId,snapId,rootId,snap.runs.find(r=>r.finalState&&!r.snapshotOf&&r.id!==rootId).id].sort(),'closure keeps the review RED and the later file-hash RED, not only one of them');
  const empty=ledger();await empty.lab.ready;
  for(const bundle of [null,{schema:BUNDLE,selectedRunId:blueId},{schema:'falsify.other',selectedRunId:blueId,ledger:full.ledger},{...full,gold:true},{...full,selectedRunId:''},{...full,selectedRunId:'x'.repeat(161)},{...full,selectedRunId:'missing-run'},{...full,ledger:{...full.ledger,gold:true}}])await untouched(empty,()=>empty.lab.restorePrivateBundle(bundle));
  const huge={schema:BUNDLE,selectedRunId:blueId,ledger:full.ledger,pad:'x'.repeat(4500001)};await untouched(empty,()=>empty.lab.restorePrivateBundle(huge));assert.match(empty.get('ledger-status').textContent,/4\.5MB/);assert.equal(empty.get('ledger-status').textContent.includes(huge.pad.slice(0,20)),false);
  const tampered=plain(full);tampered.ledger.runs.find(r=>r.id===blueId).sourceHash='0'.repeat(64);await untouched(empty,()=>empty.lab.restorePrivateBundle(tampered));
  const hash=plain(full);hash.ledger.harnesses[0].hash='ab'+hash.ledger.harnesses[0].hash.slice(2);await untouched(empty,()=>empty.lab.restorePrivateBundle(hash));
  await untouched(empty,()=>empty.lab.restorePrivateBundle(bundleOf(snap,blueId,ids.filter(id=>id!==snapId))));
  await untouched(empty,()=>empty.lab.restorePrivateBundle(bundleOf(snap,snapId,ids.filter(id=>id!==rootId))));
  assert.match(empty.get('ledger-status').textContent,/비공개 검수 복원 차단/);assert.equal(empty.network.length,0);
});

test('fresh browser restores RED+BLUE into native side-by-side review and keeps item judgments across reload',async()=>{
  const {snap,blueId,rootId,snapId,laterId,unrelatedId}=await judgedPair(),full=bundleOf(snap,blueId,closureIds(snap,blueId));
  const fresh=ledger();await fresh.lab.ready;const selectedHarness=fresh.get('red-harness').value,writes=fresh.writes.length;
  assert.equal(await fresh.lab.restorePrivateBundle(plain(full)),blueId);
  assert.equal(fresh.get('evaluation-run').value,blueId);assert.equal(fresh.get('red-harness').value,selectedHarness);
  assert.equal(fresh.get('red-harness-consent').checked,false);assert.equal(fresh.get('blue-harness-consent').checked,false);assert.equal(fresh.get('red-cli-type').value,'');
  assert.ok(fresh.writes.length>writes);assert.equal(fresh.network.length,0);
  const restored=await fresh.lab.cloudSnapshot();
  assert.ok(restored.runs.every(r=>r.provenance==='imported-unverified'));assert.ok(!restored.runs.some(r=>r.id===unrelatedId));
  assert.equal(restored.runs.find(r=>r.id===rootId).snapshotOf,undefined);assert.equal(restored.runs.find(r=>r.id===snapId).snapshotOf,rootId);
  assert.equal(restored.runs.find(r=>r.id===snapId).finalState.selected[0].after,candidate.after);assert.equal(restored.runs.find(r=>r.id===laterId).finalState.selected[0].after,'show benefit');
  assert.deepEqual(plain(restored.runs.find(r=>r.id===blueId).response),plain(snap.runs.find(r=>r.id===blueId).response));
  const review=restored.reviews[0];assert.equal(restored.reviews.length,1);assert.equal(review.comparison.sourceRunId,snapId);assert.equal(review.comparison.assessments[0].verdict,'detected');assert.equal(review.comparison.assessments[0].note,'Synthetic matching conflict.');
  assert.equal(review.reviewContext.mode,'red-assisted');assert.equal(review.findingAssessments[0].verdict,'supported');assert.equal(review.findingAssessments[0].note,'Synthetic source supports finding.');assert.equal(review.score,4);assert.match(review.note,/RED 공개 대조 · 블라인드 아님/);
  assert.match(fresh.get('ledger-summary').textContent,/로컬 broker 실행 0건/);assert.match(fresh.get('ledger-summary').textContent,/가져온 기록 3건/);assert.match(fresh.get('ledger-summary').textContent,/최종 스냅샷 1건/);
  assert.ok(!JSON.stringify(restored).includes('"gold"'));
  const output=fresh.get('evaluation-output');assert.ok(tags(output,'DEL').some(t=>t.includes('Study does not show benefit.')));assert.ok(tags(output,'INS').includes('show benefit'));
  assert.match(tree(fresh.get('evaluation-history')),new RegExp(snapId.slice(0,8)));assert.match(tree(fresh.get('evaluation-history')),/타당함/);
  assert.ok(optionValues(fresh.get('evaluation-run')).includes(blueId));assert.ok(!optionValues(fresh.get('evaluation-run')).includes(unrelatedId));
  const snapIds=closureIds(snap,snapId).sort();assert.deepEqual(snapIds,[rootId,snapId].sort(),'snapshot closure is the final RED and its response root');
  const snapBundle=bundleOf(snap,snapId,snapIds);
  const finals=ledger();assert.equal(await finals.lab.restorePrivateBundle(plain(snapBundle)),snapId);
  assert.match(finals.get('evaluation-binding').textContent,/최종 스냅샷/);assert.match(tree(finals.get('evaluation-output')),/사용자 최종 선택/);assert.match(tree(finals.get('evaluation-output')),/Study does show benefit/);
  assert.equal((await finals.lab.cloudSnapshot()).runs.find(r=>r.id===rootId).response.candidates[0].after,candidate.after);
  const loaded=ledger([[KEY,fresh.store.get(KEY)]]);assert.deepEqual(plain((await loaded.lab.cloudSnapshot()).reviews),plain(restored.reviews));
  assert.equal(await loaded.lab.review(blueId),true);assert.ok(tags(loaded.get('evaluation-output'),'INS').includes('show benefit'));
  saveReview(loaded,'Synthetic second note.');
  const both=await loaded.lab.cloudSnapshot();assert.equal(both.reviews.length,2);assert.ok(both.reviews.some(v=>v.note.includes('Synthetic second note.')));assert.deepEqual(plain(both.runs.find(r=>r.id===blueId).response),plain(restored.runs.find(r=>r.id===blueId).response));
  const again=ledger([[KEY,loaded.store.get(KEY)]]);assert.equal((await again.lab.cloudSnapshot()).reviews.length,2);assert.ok((await again.lab.cloudSnapshot()).runs.every(r=>r.provenance==='imported-unverified'));
});

test('repeat restore is idempotent and does not upgrade or erase existing provenance',async()=>{
  const {w,snap,blueId,rootId,unrelatedId}=await judgedPair(),full=bundleOf(snap,blueId,closureIds(snap,blueId));
  const before=await w.lab.cloudSnapshot(),writes=w.writes.length;
  assert.equal(await w.lab.restorePrivateBundle(plain(full)),blueId);
  const after=await w.lab.cloudSnapshot();assert.equal(after.runs.length,before.runs.length);assert.equal(after.reviews.length,before.reviews.length);assert.equal(w.writes.length,writes);assert.equal(w.network.length,0);
  for(const r of before.runs){const got=after.runs.find(x=>x.id===r.id);assert.equal(got.provenance,r.provenance);assert.deepEqual(plain(got.response),plain(r.response));assert.deepEqual(plain(got.finalState??null),plain(r.finalState??null));assert.equal(got.snapshotOf??null,r.snapshotOf??null);assert.equal(got.sourceRunId??null,r.sourceRunId??null);}
  assert.equal(after.runs.find(r=>r.id===rootId).provenance,'local-codex');assert.equal(after.runs.find(r=>r.id===unrelatedId).provenance,'local-codex');
  assert.match(w.get('ledger-status').textContent,/추가하지 않았습니다/);
  const fresh=ledger();await fresh.lab.restorePrivateBundle(plain(full));const once=fresh.store.get(KEY),n=fresh.writes.length;
  assert.equal(await fresh.lab.restorePrivateBundle(plain(full)),blueId);assert.equal(fresh.writes.length,n);assert.equal(fresh.store.get(KEY),once);
  assert.ok((await fresh.lab.cloudSnapshot()).runs.every(r=>r.provenance==='imported-unverified'));
});

test('collision, snapshot provenance clash, storage failure and count quota roll back with no partial write',async()=>{
  const {w,snap,blueId,rootId,snapId,unrelatedId}=await judgedPair(),ids=closureIds(snap,blueId),full=bundleOf(snap,blueId,ids);
  const host=ledger([[KEY,w.store.get(KEY)]]);await host.lab.ready;const raw=host.store.get(KEY);
  const bad=plain(full);bad.ledger.runs.find(r=>r.id===blueId).response.findings[0].rationale='Tampered synthetic rationale.';
  const extra=plain(snap.runs.find(r=>r.id===unrelatedId));extra.id='extra-run-not-stored';extra.requestId='extra-request';bad.ledger.runs.unshift(extra);
  await untouched(host,()=>host.lab.restorePrivateBundle(bad));assert.match(host.get('ledger-status').textContent,/같은 실행 ID/);assert.equal(host.store.get(KEY),raw);
  const onlyRoot={schema:KEY,harnesses:snap.harnesses.filter(h=>h.hash===snap.runs.find(r=>r.id===rootId).harnessHash),runs:[plain(snap.runs.find(r=>r.id===rootId))],reviews:[]};
  const clash=ledger([[KEY,JSON.stringify(onlyRoot)]]);await clash.lab.ready;const clashRaw=clash.store.get(KEY);
  await untouched(clash,()=>clash.lab.restorePrivateBundle(bundleOf(snap,snapId,closureIds(snap,snapId))));
  assert.match(clash.get('ledger-status').textContent,/다시 읽기 검증/);assert.equal((await clash.lab.cloudSnapshot()).runs.map(r=>r.id).join(),rootId);assert.equal((await clash.lab.cloudSnapshot()).runs[0].provenance,'local-codex');assert.equal(clash.store.get(KEY),clashRaw);
  const gate={fail:false},dest=ledger(undefined,{failWrite:()=>gate.fail});await dest.lab.ready;gate.fail=true;
  await assert.rejects(dest.lab.restorePrivateBundle(plain(full)),/기존 기록은 그대로입니다/);assert.equal(dest.store.get(KEY),undefined);assert.equal((await dest.lab.cloudSnapshot()).runs.length,0);assert.deepEqual(dest.writes,[]);assert.equal(dest.network.length,0);
  const seed=plain(snap.runs.find(r=>r.id===unrelatedId)),harness=snap.harnesses.find(h=>h.hash===seed.harnessHash);
  const packed={schema:KEY,harnesses:[harness],runs:Array.from({length:99},(_,i)=>({...plain(seed),id:'quota-'+i,requestId:'quota-req-'+i})),reviews:[]};
  const box=ledger([[KEY,JSON.stringify(packed)]]);await box.lab.ready;assert.equal((await box.lab.cloudSnapshot()).runs.length,99);const stored=box.store.get(KEY);
  const a={...plain(seed),id:'quota-new-a',requestId:'quota-new-a'},b={...plain(seed),id:'quota-new-b',requestId:'quota-new-b'};
  await untouched(box,()=>box.lab.restorePrivateBundle({schema:BUNDLE,selectedRunId:a.id,ledger:{schema:KEY,harnesses:[harness],runs:[a,b],reviews:[]}}));
  assert.match(box.get('ledger-status').textContent,/수량 한도/);assert.equal(box.store.get(KEY),stored);assert.equal((await box.lab.cloudSnapshot()).runs.length,99);
});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
  console.log(JSON.stringify({passed,total:tests.length}));if(passed!==tests.length)process.exit(1);})();
