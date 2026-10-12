'use strict';
// Node VM contract for the PDF editor capability descriptor and the RED export surface.
// Synthetic DOM, mocked bridge/ledger/broker; no browser, network, CLI, model or private PDF access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),nodeCrypto=require('node:crypto');
const C=require('../dist/document-red-core.js'),L=require('../dist/local-bridge.js'),SOURCE=fs.readFileSync(path.resolve(__dirname,'../dist/document-red.js'),'utf8');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
// Export hashing uses real off-thread WebCrypto: while the page is busy but no broker reply is outstanding, wait (bounded) for it to settle.
let current=null;
const flush=async(n=12)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));for(let i=0;i<400&&current&&current.bridge.busyCalls.at(-1)&&!current.inflight;i++)await new Promise(r=>setTimeout(r,5));for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const sha=b=>nodeCrypto.createHash('sha256').update(b).digest('hex'),WASM='ab'.repeat(32);
const EDITOR={available:true,engine:'falsify-pdf-editor',version:'0.4.1',wasmSha256:WASM,reflow:true,pagination:true,limits:{maxAddedPages:4,maxPatchChars:4000},sourceUrl:'https://github.com/Shinick-Han/falsify-pdf-editor'};
const SEG0='The trial shows a modest benefit in adults.',SEG1='Effects were observed only in the treated cohort.';
const BEFORE0='shows a modest benefit',BEFORE1='only in the treated cohort';
const SRC=Buffer.from('%PDF-1.7 synthetic fixture'),OUT=Buffer.from('%PDF-1.7 synthetic reflowed output');
function element(id){
  const e=new EventTarget(),classes=new Set();
  Object.assign(e,{id,disabled:false,hidden:false,checked:false,value:'',textContent:'',children:[],
    classList:{toggle:(c,on)=>{(on??!classes.has(c))?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)},
    replaceChildren(...c){this.children=c;},append(...c){this.children.push(...c);},after(){},remove(){},click(){this.dispatchEvent(new Event('click'));},getClientRects:()=>[]});
  return e;
}
function world(cap){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,element(id));return els.get(id);},created=[],downloads=[],calls=[],handoffs=[];
  const document=new EventTarget();
  Object.assign(document,{querySelector:s=>s.startsWith('#')?get(s.slice(1)):null,querySelectorAll:()=>[],createElement:()=>{const e=element('');created.push(e);return e;},body:element('body')});
  get('red-level').value='1';get('red-budget').value='4';get('document-red').hidden=true;
  let reply=async()=>{throw new Error('no broker reply configured');};
  const lab={busy(){},allowed:()=>true,ready:Promise.resolve(),bind:(_,r)=>r,record:async()=>nodeCrypto.randomUUID()};
  const bridge={busyCalls:[],busy(role,v){if(role==='red')bridge.busyCalls.push(!!v);},state:()=>({status:'paired',connected:true,cap}),capabilities:()=>cap,
    session:()=>({request:(p,body)=>{calls.push({path:p,body});const out=Promise.resolve().then(()=>reply(p,body));w.inflight++;out.then(()=>{w.inflight--;},()=>{w.inflight--;});return out;}})};
  const URLmock={createObjectURL:blob=>{downloads.push(blob);return 'blob:'+downloads.length;},revokeObjectURL(){}};
  const ctx=vm.createContext({document,crypto:globalThis.crypto,FalsifyDocumentRed:C,FalsifyLocalBridge:bridge,FalsifyLab:lab,FalsifyExport:{},TextEncoder,TextDecoder,CustomEvent,Event,URL:URLmock,Blob,File,setTimeout,clearTimeout,confirm:()=>true,addEventListener(){},btoa,atob,Uint8Array,Array,Promise,Error,Map,JSON,Number,String,Object});
  vm.runInContext(SOURCE,ctx,{filename:'document-red.js'});
  document.addEventListener('falsify:blue-file',e=>handoffs.push(e.detail));
  const fire=(type,detail)=>document.dispatchEvent(new CustomEvent(type,{cancelable:true,detail}));
  const w={cap,get,created,downloads,calls,handoffs,fire,bridge,set reply(f){reply=f;},
    status:()=>get('red-export-status').textContent,
    // Real WebCrypto digests finish off-thread, so wait for the bound panel instead of a fixed number of ticks.
    async load(){fire('falsify:document',{file:{name:'paper.pdf',type:'application/pdf',arrayBuffer:async()=>new Uint8Array(SRC).buffer},result:{text:SEG0+'\n'+SEG1,format:'PDF',segments:[{label:'p1',text:SEG0},{label:'p2',text:SEG1}]}});
      for(let i=0;i<400&&get('document-red').hidden;i++)await new Promise(r=>setTimeout(r,5));assert.equal(get('document-red').hidden,false,'document bound');await flush();},
    async candidates(){get('red-request').click();await flush();const r=JSON.parse(await downloads.pop().text());
      const cand=(id,seg,before,after,quote)=>({id,segmentId:seg,level:1,before,after,rationale:'Synthetic contradiction.',evidence:[{segmentId:seg,quote,relation:'Synthetic relation.'}],uncertainty:'Domain review required.'});
      get('red-response').value=JSON.stringify({schema:r.schema,revision:r.revision,sourceHash:r.sourceHash,status:'ok',candidates:[cand('c1','s0',BEFORE0,'shows a clear benefit',SEG0),cand('c2','s1',BEFORE1,'in every cohort regardless of treatment',SEG1)]});
      get('red-import-response').click();await flush();},
    boxes:()=>created.filter(e=>e.type==='checkbox'),area:i=>created.find(e=>e.id==='red-after-'+i),
    check(i){const b=w.boxes()[i];b.checked=true;b.dispatchEvent(new Event('change'));},
    edit(i,v){const a=w.area(i);a.value=v;a.dispatchEvent(new Event('input'));},
    consent(){const c=get('red-export-consent');c.checked=true;c.dispatchEvent(new Event('change'));},
    clickDoc(sel){const ev=new Event('click');Object.defineProperty(ev,'target',{value:{closest:s=>s===sel?{}:null}});document.dispatchEvent(ev);},
    async ready(){await w.load();await w.candidates();w.check(1);w.edit(1,'in every cohort, including the untreated one');w.consent();}};
  w.inflight=0;current=w;return w;
}
const ok=(verification,file=OUT)=>async()=>({file:file.toString('base64'),sourceFileHash:sha(SRC),outputFileHash:sha(file),verification});
const NEW={red:true,blue:true,pdf:true,pdfEditor:EDITOR},OLD={red:true,blue:true,pdf:true},REFLOWED={engine:'falsify-pdf-editor',layoutVerified:true,reflow:{wrappedLines:3},pagination:{inputPages:10,outputPages:11},limits:'Synthetic engine limits.'};

test('descriptor: new broker keeps pdf boolean and a sanitized frozen pdfEditor; legacy broker has none',async()=>{
  const boot=async caps=>{const b=L.create({fetch:async p=>({ok:true,json:async()=>p==='/api/session'?{token:'t'.repeat(32)}:caps}),location:{hostname:'127.0.0.1',port:'7816'}});await b.ready;return b.capabilities();};
  const fresh=await boot({...NEW,pdfEditor:{...EDITOR,extra:'dropped'}});
  assert.equal(fresh.pdf,true);assert.deepEqual({...fresh.pdfEditor,limits:{...fresh.pdfEditor.limits}},EDITOR);assert.equal(Object.isFrozen(fresh.pdfEditor),true);
  const legacy=await boot(OLD);assert.equal(legacy.pdf,true);assert.equal(legacy.pdfEditor,null);
  const missing=await boot({red:true,blue:true,pdf:false,pdfEditor:{available:false,engine:'falsify-pdf-editor',version:null,wasmSha256:null,reflow:true,pagination:true}});
  assert.equal(missing.pdf,false);assert.equal(missing.pdfEditor.available,false);});

test('descriptor: malformed core fields drop it, bounded optional fields are cleaned',()=>{
  for(const bad of [null,[],'x',{...EDITOR,engine:'other'},{...EDITOR,available:'yes'},{...EDITOR,reflow:1},{...EDITOR,pagination:null},{...EDITOR,wasmSha256:'AB'.repeat(32)},{...EDITOR,wasmSha256:'ab'},{...EDITOR,version:'1 2'},{...EDITOR,version:'v'.repeat(41)},{...EDITOR,version:undefined}])
    assert.equal(L.pdfEditor(bad),null,JSON.stringify(bad));
  for(const url of ['http://github.com/Shinick-Han/x','https://evil.example/Shinick-Han/x','https://github.com/other/x','https://github.com/Shinick-Han/x?ref=1','https://u:p@github.com/Shinick-Han/x','https://github.com:444/Shinick-Han/x','javascript:alert(1)',42,'https://github.com/Shinick-Han/'+'a'.repeat(300)])
    assert.equal(L.pdfEditor({...EDITOR,sourceUrl:url}).sourceUrl,null,String(url));
  assert.deepEqual({...L.pdfEditor({...EDITOR,limits:{good:3,neg:-1,frac:1.5,'bad key':2,str:'9'}}).limits},{good:3});
  assert.equal(L.pdfEditor({...EDITOR,limits:'x'.repeat(500)}).limits.length,300);});

test('export mode line distinguishes reflow engine, legacy single-line and missing editor',async()=>{
  let w=world(NEW);await w.ready();const m=w.get('red-export-mode');
  assert.equal(m.hidden,false);assert.match(m.textContent,/falsify-pdf-editor 0\.4\.1/);assert.match(m.textContent,/줄바꿈 재배치와 필요 시 페이지 추가/);assert.match(m.textContent,/엔진 검증 결과로만/);assert.equal(w.get('red-download').disabled,false);
  w=world(OLD);await w.ready();assert.match(w.get('red-export-mode').textContent,/^기존 한 줄 보존 편집/);assert.match(w.get('red-export-mode').textContent,/최신 companion/);assert.equal(w.get('red-download').disabled,false);
  w=world({...OLD,pdfEditor:{...EDITOR,available:false}});await w.ready();assert.match(w.get('red-export-mode').textContent,/아직 준비되지 않았습니다.*연결 패널/);
  w=world({red:true,blue:true,pdf:false,pdfEditor:{...EDITOR,available:false}});await w.ready();
  assert.equal(w.get('red-download').disabled,true);assert.equal(w.get('red-export-mode').hidden,true);assert.match(w.status(),/연결 패널.*After는 그대로/);assert.equal(w.get('red-plan').disabled,false,'plan JSON still available');});

test('nothing is auto-selected or auto-run; export needs a checked candidate and consent',async()=>{const w=world(NEW);await w.load();await w.candidates();
  assert.equal(w.boxes().every(b=>!b.checked),true);assert.equal(w.get('red-download').disabled,true);assert.equal(w.calls.length,0);
  w.check(0);assert.equal(w.get('red-download').disabled,true,'consent still required');w.consent();assert.equal(w.get('red-download').disabled,false);assert.equal(w.calls.length,0);});

test('same /api/export body: only checked candidates with the user-edited After; pending locks and honest progress',async()=>{const w=world(NEW);await w.ready();
  let release;w.reply=()=>new Promise(r=>{release=r;});w.get('red-download').click();await flush();
  assert.equal(w.calls.length,1);const {path:p,body}=w.calls[0];assert.equal(p,'/api/export');
  assert.deepEqual(Object.keys(body).sort(),['file','fileHash','format','patches']);assert.equal(body.format,'PDF');assert.equal(body.fileHash,sha(SRC));assert.equal(Buffer.from(body.file,'base64').equals(SRC),true);
  assert.equal(body.patches.length,1);assert.equal(body.patches[0].id,'c2');assert.equal(body.patches[0].before,BEFORE1);assert.equal(body.patches[0].after,'in every cohort, including the untreated one');assert.equal(body.patches[0].edited,true);
  for(const id of ['red-download','red-plan','red-request','red-import-response','red-level'])assert.equal(w.get(id).disabled,true,id);
  assert.equal(w.bridge.busyCalls.at(-1),true,'bridge frozen during export');assert.match(w.status(),/줄바꿈 재배치·보존 검사하는 중/);assert.doesNotMatch(w.status(),/\d+\s*%/);
  release(await ok(REFLOWED)());await flush();
  assert.equal(w.bridge.busyCalls.at(-1),false);assert.equal(w.get('red-download').disabled,false);
  assert.equal(w.area(1).value,'in every cohort, including the untreated one','After kept after export');});

test('verified success reports wrapping and new pages, downloads copy + separate plan, offers unchanged BLUE handoff',async()=>{const w=world(NEW);await w.ready();w.reply=ok(REFLOWED);w.get('red-download').click();await flush();
  const s=w.status();assert.match(s,/다운로드했습니다/);assert.match(s,/줄바꿈 재배치 3줄/);assert.match(s,/페이지 10 → 11 \(새 페이지 1쪽\)/);assert.match(s,/과학적 타당성·결함 품질 판정이 아닙니다/);assert.match(s,/Synthetic engine limits/);
  assert.equal(w.get('red-export-status').classList.contains('error'),false);
  assert.equal(w.downloads.length,2);assert.equal(Buffer.from(await w.downloads[0].arrayBuffer()).equals(OUT),true);
  const plan=JSON.parse(await w.downloads[1].text());assert.equal(plan.outputFileHash,sha(OUT));assert.deepEqual(plan.verification.pagination,REFLOWED.pagination);assert.equal(plan.status.gold,'pending');
  assert.equal(w.get('red-handoff').hidden,false);assert.equal(w.handoffs.length,0,'BLUE never started automatically');
  w.clickDoc('#red-handoff');await flush();assert.equal(w.handoffs.length,1);const h=w.handoffs[0];
  assert.deepEqual(Object.keys(h).sort(),['file','sourceRunId'],'BLUE receives only the copy and the run relation');assert.equal(Buffer.from(await h.file.arrayBuffer()).equals(OUT),true);assert.equal(typeof h.sourceRunId,'string');});

test('engine error is actionable and keeps candidates, selection, edited After and the source',async()=>{const w=world(NEW);await w.ready();
  w.reply=async()=>{throw new Error('synthetic: rotated text block cannot be reflowed');};w.get('red-download').click();await flush();
  const s=w.status();assert.match(s,/^다운로드 차단: synthetic: rotated text block/);assert.match(s,/After는 그대로 남아 있습니다/);assert.match(s,/선택을 해제하거나 After를 직접 조정/);assert.match(s,/연결 패널/);
  assert.equal(w.get('red-export-status').classList.contains('error'),true);assert.equal(w.downloads.length,0);
  assert.equal(w.boxes()[1].checked,true);assert.equal(w.boxes()[0].checked,false);assert.equal(w.area(1).value,'in every cohort, including the untreated one');
  assert.equal(w.get('red-download').disabled,false,'retry possible');assert.equal(w.get('red-handoff').hidden,true);
  w.reply=ok(REFLOWED);w.get('red-download').click();await flush();assert.equal(w.calls[1].body.patches[0].after,'in every cohort, including the untreated one');assert.equal(w.calls[1].body.file,w.calls[0].body.file);assert.match(w.status(),/다운로드했습니다/);
  w.edit(1,'in every cohort');assert.equal(w.status(),'');assert.equal(w.get('red-export-status').classList.contains('error'),false);assert.equal(w.get('red-handoff').hidden,true,'edit invalidates handoff');});

test('legacy broker error points to the single-line limit and a reflow-capable companion',async()=>{const w=world(OLD);await w.ready();
  w.reply=async()=>{throw new Error('줄바꿈이 필요한 변경입니다.');};w.get('red-download').click();await flush();
  assert.match(w.status(),/원래 줄 공간에 들어가는 변경만 지원/);assert.match(w.status(),/줄바꿈 재배치 엔진이 있는 companion/);assert.match(w.calls[0].body.patches[0].after,/untreated/);});

test('reset during a pending export discards the late result without downloading',async()=>{const w=world(NEW);await w.ready();
  let release;w.reply=()=>new Promise(r=>{release=r;});w.get('red-download').click();await flush();
  w.fire('falsify:document-clear');release(await ok(REFLOWED)());await flush();
  assert.equal(w.downloads.length,0);assert.doesNotMatch(w.status(),/다운로드했습니다/);assert.equal(w.get('document-red').hidden,true);assert.equal(w.bridge.busyCalls.at(-1),false);});

test('no blanket success: unverified layout, hash mismatch and missing pagination are reported honestly',async()=>{
  let w=world(NEW);await w.ready();w.reply=ok({...REFLOWED,layoutVerified:false,diagnostics:['Table cell overflow on page 4',{message:'Footnote collision'},7]});w.get('red-download').click();await flush();
  assert.match(w.status(),/레이아웃 검증을 통과시키지 못해/);assert.match(w.status(),/Table cell overflow on page 4 \/ Footnote collision/);assert.equal(w.downloads.length,0);
  w=world(NEW);await w.ready();w.reply=async()=>({...(await ok(REFLOWED)()),outputFileHash:'0'.repeat(64)});w.get('red-download').click();await flush();
  assert.match(w.status(),/출력 해시와 받은 파일이 달라/);assert.equal(w.downloads.length,0);
  w=world(NEW);await w.ready();w.reply=ok({engine:'falsify-pdf-editor',layoutVerified:true,reflow:{wrappedLines:'3'},pagination:{inputPages:10,outputPages:9},diagnostics:['Hyphenation differs from source']});w.get('red-download').click();await flush();
  assert.match(w.status(),/줄바꿈 결과 미보고/);assert.match(w.status(),/페이지 수 변화 미검증/);assert.match(w.status(),/엔진 주의: Hyphenation differs/);assert.doesNotMatch(w.status(),/새 페이지/);
  assert.match(w.status(),/다운로드했습니다/,'honest missing counters only with layoutVerified true');assert.equal(w.downloads.length,2);
  w=world(OLD);await w.ready();w.reply=ok({mode:'pdf-original-font-single-line',pages:10,limits:'96dpi'});w.get('red-download').click();await flush();
  assert.match(w.status(),/기존 한 줄 교체 · 줄바꿈·페이지 추가 없음 · 10쪽/);assert.doesNotMatch(w.status(),/새 페이지|재배치 \d/);});

test('fail closed: new-engine export without layoutVerified === true never downloads or offers handoff',async()=>{
  const {layoutVerified,...unproven}=REFLOWED;void layoutVerified;
  const cases=[['undefined (field omitted)',unproven],['null',{...REFLOWED,layoutVerified:null}],['string "true"',{...REFLOWED,layoutVerified:'true'}],['1',{...REFLOWED,layoutVerified:1}],
    ['engine field missing in reflow mode',{...REFLOWED,engine:undefined}],['legacy-shaped verification from reflow mode',{mode:'pdf-original-font-single-line',pages:10}],['verification missing',undefined]];
  for(const [label,verification] of cases){const w=world(NEW);await w.ready();w.reply=ok(verification);w.get('red-download').click();await flush();
    assert.match(w.status(),/^다운로드 차단: 엔진이 이 출력의 레이아웃 검증 통과를 증명하지 않아 다운로드하지 않았습니다/,label);assert.doesNotMatch(w.status(),/다운로드했습니다|새 페이지|줄바꿈 재배치 \d/,label);
    assert.equal(w.downloads.length,0,label);assert.equal(w.get('red-handoff').hidden,true,label);assert.equal(w.handoffs.length,0,label);
    assert.equal(w.boxes()[1].checked,true,label);assert.equal(w.area(1).value,'in every cohort, including the untreated one',label);assert.equal(w.get('red-download').disabled,false,label);}
  const w=world(OLD);await w.ready();w.reply=ok({...REFLOWED,layoutVerified:null});w.get('red-download').click();await flush();
  assert.match(w.status(),/검증 통과를 증명하지 않아/,'engine claim is checked even on a legacy-mode broker');assert.equal(w.downloads.length,0);});

test('AGPL source link sits once in the shared footer, outside every tab view',()=>{const html=fs.readFileSync(path.resolve(__dirname,'../dist/index.html'),'utf8');
  const links=html.match(/<a\b[^>]*href="https:\/\/github\.com\/Shinick-Han\/falsify-workbench"[^>]*>[^<]*<\/a>/g)||[];assert.equal(links.length,1);
  assert.match(links[0],/AGPL-3\.0-only/);assert.match(links[0],/rel="noopener noreferrer"/);assert.match(links[0],/class="source-link"/);
  const foot=html.match(/<footer class="page-foot">[\s\S]*?<\/footer>/)[0],at=html.indexOf(foot),lastView=html.lastIndexOf('<section class="view',at);
  assert.ok(foot.includes(links[0]),'link lives in the footer');assert.ok(html.indexOf('</section>',lastView)<at,'footer is after the last view closes');
  assert.ok(html.indexOf('<div class="content">')<at&&html.indexOf('</main>')>at,'footer is in the shared content column');});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name+'\n'+(e.stack||e));process.exitCode=1;}}
  console.log(JSON.stringify({passed,total:tests.length}));})();
