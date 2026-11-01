import test from 'node:test';
import assert from 'node:assert/strict';
import {requestLayoutDecision,mountPaperLayoutAgent} from '../src/paper-layout-agent-ui.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {createLatexProject} from '../src/latex-project.mjs';

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.hidden=false;this.disabled=false;this.textContent='';}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(){}
}
const document={createElement:tag=>new Element(tag)};
const makeProject=(extra={})=>createLatexProject({files:[{path:'main.tex',bytes:new TextEncoder().encode('\\documentclass{article}\n\\begin{document}RED 71\\end{document}')}],mainFile:'main.tex',...extra});
const find=(host,text)=>{if(host.textContent===text)return host;for(const child of host.children||[]){const result=find(child,text);if(result)return result;}};
const action={tool:'finish',path:'',before:'',after:'',pages:[],message:''};

test('one-click handoff reveals and focuses the running panel without a second start',async()=>{
 const host=new Element('host'),nodes=[],doc={createElement(tag){const n=new Element(tag);n.attributes={};n.setAttribute=(k,v)=>n.attributes[k]=v;n.focus=()=>{n.focused=true;};n.scrollIntoView=()=>{n.scrolled=(n.scrolled||0)+1;};nodes.push(n);return n;}};
 const project=await makeProject(),bytes=Uint8Array.of(1,2),artifact={projectId:project.id,pdfBytes:bytes,pdfHash:hex(bytes)},session={snapshot:()=>({changes:[]}),compile:async()=>artifact,getCurrentProject:async()=>project};let calls=0,finish;
 const agent=mountPaperLayoutAgent({doc,host,getSession:()=>session,getEpoch:()=>1,download(){},bridge:{session:()=>({})},compilerFactory:()=>({dispose(){}}),readerFactory:()=>({dispose(){}}),runAgent:()=>{calls++;return new Promise(r=>finish=r);}});
 const running=agent.start({goal:'Keep source content.'});await new Promise(r=>setImmediate(r));
 const panel=nodes.find(n=>n.className==='paper-layout-agent');assert.equal(panel.open,true);assert.equal(panel.focused,true);assert.equal(panel.scrolled,1);assert.equal(panel.attributes['aria-busy'],'true');assert.equal(calls,1);
 assert.equal(await agent.start(),false);assert.equal(calls,1);
 finish({project,artifact,status:'unresolved'});assert.equal(await running,true);assert.equal(panel.attributes['aria-busy'],'false');
});

test('a disconnected handoff exposes the connection error at the revealed panel',async()=>{
 const host=new Element('host');let calls=0;const agent=mountPaperLayoutAgent({doc:document,host,getSession:()=>({}),getEpoch:()=>1,download(){},bridge:{session:()=>null},runAgent:()=>{calls++;}});
 assert.equal(await agent.start(),false);assert.equal(calls,0);assert.ok(find(host,'PC 연결이 끊겼습니다. 연결 후 다시 누르세요.'));assert.equal(find(host,'AI 배치 다듬기').tag,'summary');
});
test('decision uses authenticated JSON bridge and rejects mismatched identity',async()=>{
  const input={projectId:'a'.repeat(64),step:1,maxSteps:2,instruction:'x',tools:[],observations:[],images:[],sourceFiles:[]};
  let captured;const link={request:async (...args)=>{captured=args;return {schema:'falsify.paper-layout-agent-action.v1',projectId:input.projectId,step:1,action};}};
  assert.deepEqual(await requestLayoutDecision(link,input),action);assert.equal(captured[0],'/api/paper/layout-agent/step');assert.equal(captured[1].consent,true);
  await assert.rejects(requestLayoutDecision({request:async()=>({schema:'falsify.paper-layout-agent-action.v1',projectId:'wrong',step:1,action})},input));
});
test('explicit start retains candidate PDF without changing session and aborts stale runs',async()=>{
  const host=new Element('host'),downloads=[],changes=[];let resolveRun,signal,epoch=1;
  const project=await makeProject(),artifact={projectId:project.id,pdfBytes:new Uint8Array([1,2]),pdfHash:hex(new Uint8Array([1,2]))};
  const session={snapshot:()=>({changes}),compile:async()=>artifact,getCurrentProject:async()=>project};
  const agent=mountPaperLayoutAgent({doc:document,host,getSession:()=>session,getEpoch:()=>epoch,download:(...args)=>downloads.push(args),bridge:{session:()=>({})},compilerFactory:()=>({dispose(){}}),readerFactory:()=>({dispose(){}}),runAgent:args=>{signal=args.signal;return new Promise(r=>{resolveRun=r;});}});
  const start=find(host,'AI로 배치 다듬기'),pdf=find(host,'후보 PDF 다운로드');
  const running=start.onclick();await new Promise(r=>setImmediate(r));assert.equal(signal.aborted,false);
  resolveRun({project,artifact,status:'unresolved',message:'partial'});await running;
  assert.equal(agent.getCandidate().status,'unresolved');pdf.onclick();assert.deepEqual(downloads[0][0],artifact.pdfBytes);assert.deepEqual(changes,[]);
  const stale=start.onclick();await new Promise(r=>setImmediate(r));epoch++;agent.invalidate();assert.equal(signal.aborted,true);
  resolveRun({project,artifact,status:'complete'});await stale;assert.equal(agent.getCandidate().status,'unresolved');
});
test('no companion means no run',async()=>{
  const host=new Element('host');let calls=0;mountPaperLayoutAgent({doc:document,host,getSession:()=>({}),getEpoch:()=>1,download(){},bridge:{session:()=>null},runAgent:()=>{calls++;}});
  await find(host,'AI로 배치 다듬기').onclick();assert.equal(calls,0);
});

test('adapters forward current project, inspect generated bytes and render bounded page coverage',async()=>{
  const previous=globalThis.File;globalThis.File=class {constructor(parts){this.parts=parts;}};
  try{
    const host=new Element('host'),bytes=new Uint8Array([1,2,3]);let inspected,compiled,seen;
    const doc={createElement(tag){const n=new Element(tag);if(tag==='canvas'){n.getContext=()=>({});n.toDataURL=()=> 'data:image/png;base64,cG5n';}return n;}};
    const project=await makeProject(),artifact={projectId:project.id,pdfBytes:bytes,pdfHash:hex(bytes)},session={snapshot:()=>({changes:[]}),compile:async()=>artifact,getCurrentProject:async()=>project};
    mountPaperLayoutAgent({doc,host,getSession:()=>session,getEpoch:()=>1,download(){},bridge:{session:()=>({})},
      compilerFactory:()=>({compile:async r=>{compiled=r;return artifact;},dispose(){}}),readerFactory:()=>({compare:async r=>{inspected=r;return {layoutAudit:{schema:'falsify.latex-layout-audit.v1',outputPdfHash:artifact.pdfHash,status:'partial',findings:[],coverage:{pages:8}}};},dispose(){}}),
      loadPdf:async()=>({getDocument:()=>({promise:Promise.resolve({numPages:8,getPage:async()=>({getViewport:()=>({width:100,height:100}),render:()=>({promise:Promise.resolve()})})}),destroy:async()=>{}})}),
      runAgent:async o=>{await o.compile({project:o.project,signal:o.signal});const audit=await o.inspect({artifact,signal:o.signal});const rendered=await o.render({artifact,pages:[0,1,2,3,4],signal:o.signal});seen={audit,rendered};return {project:o.project,artifact,status:'unresolved'};}});
    await find(host,'AI로 배치 다듬기').onclick();assert.equal(compiled.project.id,project.id);assert.deepEqual(inspected.bytes,bytes);assert.equal(seen.audit.status,'partial');assert.deepEqual(seen.rendered.coverage.renderedPages,[0,1,2,3]);assert.equal(seen.rendered.coverage.totalPages,8);
  }finally{globalThis.File=previous;}
});


test('preview, download, BLUE and new source session use the candidate; stale actions are blocked',async()=>{
  const previousFile=globalThis.File,previousEvent=globalThis.CustomEvent;
  globalThis.File=class {constructor(parts,name,options){this.parts=parts;this.name=name;this.type=options.type;}};
  globalThis.CustomEvent=class {constructor(type,options){this.type=type;Object.assign(this,options);}};
  try{
    const {createLatexProject}=await import('../src/latex-project.mjs');
    const project=await createLatexProject({files:[{path:'main.tex',bytes:new TextEncoder().encode('\\documentclass{article}')}],mainFile:'main.tex'});
    const bytes=new Uint8Array([37,80,68,70,45,1]),artifact={projectId:project.id,pdfBytes:bytes,pdfHash:hex(bytes)},host=new Element('host');let epoch=1,event,previewBytes,downloaded,adopted,goalSent;
    const session={snapshot:()=>({changes:[]}),compile:async()=>artifact,getCurrentProject:async()=>project};
    const doc={createElement(tag){const n=new Element(tag);if(tag==='canvas'){n.getContext=()=>({drawImage(){}});n.toDataURL=()=> 'data:image/png;base64,cG5n';}return n;},dispatchEvent:e=>{event=e;return false;},querySelector:()=>null};
    const bridge={session:()=>({request:async(_path,body)=>{goalSent=body.instruction;return {schema:'falsify.paper-layout-agent-action.v1',projectId:body.projectId,step:body.step,action};}})};
    const agent=mountPaperLayoutAgent({doc,host,getSession:()=>session,getEpoch:()=>epoch,download:b=>{downloaded=b;},loadCandidate:async f=>{adopted=f;},bridge,compilerFactory:()=>({dispose(){}}),readerFactory:()=>({dispose(){}}),loadPdf:async()=>({getDocument:({data})=>{previewBytes=data;return {promise:Promise.resolve({numPages:1,getPage:async()=>({getViewport:()=>({width:100,height:100}),render:()=>({promise:Promise.resolve()})})}),destroy:async()=>{}};}}),runAgent:async o=>{await o.decide({projectId:project.id,step:0,instruction:'preserve',maxSteps:1,tools:[],observations:[],images:[],sourceFiles:[]});return {project,artifact,status:'unresolved'};}});
    const goal=host.children[0].children.find(n=>n.tag==='label').children[0];goal.value='줄 간격을 조정';
    await find(host,'AI로 배치 다듬기').onclick();await new Promise(r=>setImmediate(r));
    assert.match(goalSent,/줄 간격을 조정/);assert.deepEqual(previewBytes,bytes);find(host,'후보 PDF 다운로드').onclick();assert.deepEqual(downloaded,bytes);
    find(host,'이 PDF로 BLUE 검토').onclick();assert.equal(event.type,'falsify:blue-file');assert.equal(event.cancelable,true);assert.deepEqual(Object.keys(event.detail),['file']);assert.deepEqual(event.detail.file.parts[0],bytes);assert.equal(event.detail.file.type,'application/pdf');
    await find(host,'후보 소스로 계속 편집').onclick();assert.equal(adopted.name,'layout-candidate-source.zip');assert.equal(adopted.type,'application/zip');
    epoch++;agent.invalidate();assert.equal(find(host,'이 PDF로 BLUE 검토').disabled,true);assert.equal(find(host,'후보 소스로 계속 편집').disabled,true);event=null;find(host,'이 PDF로 BLUE 검토').onclick();assert.equal(event,null);
  }finally{globalThis.File=previousFile;globalThis.CustomEvent=previousEvent;}
});

test('reconstructed reference is hash verified and original pages are labeled and bounded',async()=>{
  const {hex}=await import('../src/paragraph-pdf-crypto.mjs');
  const bytes=new Uint8Array([11,22,33]),host=new Element('host');let seen;
  const page={getViewport:()=>({width:100,height:200}),getTextContent:async()=>({items:[{str:'Synthetic title'},{str:'Synthetic body'}]}),render:()=>({promise:Promise.resolve()})};
  const lib={getDocument:()=>({promise:Promise.resolve({numPages:1,getPage:async()=>page}),destroy:async()=>{}})};
  const doc={createElement(tag){const n=new Element(tag);if(tag==='canvas'){n.getContext=()=>({drawImage(){}});n.toDataURL=()=> 'data:image/png;base64,cG5n';}return n;}};
  const project=await makeProject({origin:'reconstructed-pdf',sourcePdfHash:hex(bytes)}),artifact={projectId:project.id,pdfBytes:bytes,pdfHash:hex(bytes)},session={snapshot:()=>({changes:[]}),compile:async()=>artifact,getCurrentProject:async()=>project};
  mountPaperLayoutAgent({doc,host,getSession:()=>session,getEpoch:()=>1,getReferenceFile:()=>({arrayBuffer:async()=>bytes.buffer}),download(){},bridge:{session:()=>({})},compilerFactory:()=>({dispose(){}}),readerFactory:()=>({dispose(){}}),loadPdf:async()=>lib,runAgent:async args=>{seen=args;const rendered=await args.renderReference({pages:[0]});assert.equal(rendered.images[0].document,'original');assert.equal(rendered.sourcePdfHash,project.sourcePdfHash);const read=await args.readReference({pages:[0]});assert.equal(read.sourcePdfHash,project.sourcePdfHash);assert.equal(read.pages[0].text,'Synthetic title Synthetic body');await assert.rejects(args.readReference({pages:[1]}));return {project,artifact,status:'unresolved'};}});
  await find(host,'AI로 배치 다듬기').onclick();assert.equal(seen.reference.sourcePdfHash,hex(bytes));
});

test('reference mismatch refuses to invoke agent',async()=>{
  const host=new Element('host');let called=false;
  const project={id:'p',origin:'reconstructed-pdf',sourcePdfHash:'0'.repeat(64)},artifact={projectId:'p',pdfBytes:new Uint8Array([1])};
  const session={snapshot:()=>({changes:[]}),compile:async()=>artifact,getCurrentProject:async()=>project};
  mountPaperLayoutAgent({doc:document,host,getSession:()=>session,getEpoch:()=>1,getReferenceFile:()=>({arrayBuffer:async()=>new Uint8Array([1]).buffer}),download(){},bridge:{session:()=>({})},compilerFactory:()=>({dispose(){}}),readerFactory:()=>({dispose(){}}),runAgent:async()=>{called=true;}});
  await find(host,'AI로 배치 다듬기').onclick();assert.equal(called,false);assert.ok(find(host,'원본 PDF와 현재 소스가 일치하지 않습니다.'));
});

test('a failed fresh retry preserves the preceding PDF, quality and run record',async()=>{
 const project=await makeProject(),bytes=new TextEncoder().encode('%PDF-safe'),artifact={schema:'falsify.latex-artifact.v1',success:true,projectId:project.id,engine:project.engine,pdfBytes:bytes,pdfHash:hex(bytes)};let fail=false;
 const session={getInputIdentity:()=>({projectId:project.id,changes:[]}),snapshot:()=>({project,changes:[]}),compile:async()=>{if(fail)throw Error('compile failed');return artifact;},getCurrentProject:async()=>project};
 const host=new Element('host'),downloads=[];const agent=mountPaperLayoutAgent({doc:document,host,getSession:()=>session,getEpoch:()=>1,download:(...args)=>downloads.push(args),bridge:{session:()=>({})},compilerFactory:()=>({dispose(){}}),readerFactory:()=>({dispose(){}}),previewFactory:()=>({setDocuments:async()=>{},show:async()=>({candidate:{pageIndex:0,totalPages:1}}),dispose(){}}),runAgent:async()=>({project,artifact,status:'complete',runState:'completed',quality:{content:'changed',layout:'issues',observedPages:[0],findings:[{code:'NUMBERS_MISSING',severity:'error',message:'missing'}]}})});
 await find(host,'AI로 배치 다듬기').onclick();const previous=agent.getCandidate();fail=true;await find(host,'원본에서 다시 시작').onclick();assert.equal(agent.getCandidate().artifact.pdfHash,previous.artifact.pdfHash);assert.equal(find(host,'후보 PDF 다운로드').disabled,false);assert.ok(find(host,'숫자 누락'));find(host,'후보 PDF 다운로드').onclick();assert.deepEqual(downloads[0][0],bytes);
});

test('restore exposes candidate and issue navigation without model calls; another source stays detached',async()=>{
 const project=await makeProject(),bytes=new TextEncoder().encode('%PDF-restored'),artifact={schema:'falsify.latex-artifact.v1',success:true,projectId:project.id,engine:project.engine,pdfBytes:bytes,pdfHash:hex(bytes)},host=new Element('host');let modelCalls=0;const pages=[];
 const session={getInputIdentity:()=>({projectId:project.id,changes:[]}),snapshot:()=>({project,changes:[]}),getCurrentProject:async()=>project};
 const state={schema:'falsify.layout-run-state.v1',runId:'saved-run',baselineProject:project,baselineArtifact:artifact,currentProject:project,candidate:{project,artifact},checkpoints:[],trace:[],coverage:{},quality:{content:'unchanged',layout:'issues',observedPages:[0],findings:[{code:'text_overlap',message:'overlap',pageIndex:1,document:'candidate'}]},status:'unresolved',runState:'paused',stepCount:1};
 const agent=mountPaperLayoutAgent({doc:document,host,getSession:()=>session,getEpoch:()=>1,download(){},bridge:{session:()=>({})},runAgent:()=>{modelCalls++;},previewFactory:()=>({setDocuments:async()=>{},show:async args=>{pages.push(args);return {candidate:{pageIndex:args.candidatePageIndex,totalPages:3}};},dispose(){}})});
 await agent.restoreRun(state);assert.equal(modelCalls,0);assert.equal(agent.getRunState().runId,'saved-run');assert.equal(find(host,'이 PDF로 BLUE 검토').disabled,false);find(host,'2쪽 · 글자 겹침').onclick();await new Promise(r=>setImmediate(r));assert.equal(pages.at(-1).candidatePageIndex,1);
 const other=await makeProject({files:[{path:'main.tex',bytes:new TextEncoder().encode('\\documentclass{article}\\begin{document}Another source\\end{document}')}]});const otherArtifact={...artifact,projectId:other.id};await agent.restoreRun({...state,runId:'other-run',baselineProject:other,baselineArtifact:otherArtifact,currentProject:other,candidate:{project:other,artifact:otherArtifact}});assert.equal(find(host,'이 PDF로 BLUE 검토').disabled,true);
});

// --- LQ UI state repair regressions ---
const findAll=(host,pred,out=[])=>{if(pred(host))out.push(host);for(const child of host.children||[])findAll(child,pred,out);return out;};
const tick=()=>new Promise(r=>setImmediate(r));
const pdfArtifact=(project,text)=>{const bytes=new TextEncoder().encode(text);return {schema:'falsify.latex-artifact.v1',success:true,projectId:project.id,engine:project.engine,pdfBytes:bytes,pdfHash:hex(bytes)};};
const memoryStore=puts=>()=>({put:async s=>{puts.push(s);return {};},get:async()=>null,setConsent:async()=>{},dispose(){}});
const quietPreview=()=>({setDocuments:async()=>{},show:async()=>({candidate:{pageIndex:0,totalPages:1}}),dispose(){}});
const savedState=(baselineProject,baselineArtifact,project,artifact,extra={})=>({schema:'falsify.layout-run-state.v1',runId:'saved-run',baselineProject,baselineArtifact,currentProject:project,candidate:{project,artifact},checkpoints:[],trace:[],coverage:{},quality:{content:'unchanged',layout:'unverified',observedPages:[],findings:[]},status:'unresolved',runState:'paused',stepCount:1,...extra});

test('a fresh retry that fails at the real agent decide keeps the earlier candidate and its saved state primary',async()=>{
 const previousFile=globalThis.File,previousEvent=globalThis.CustomEvent;globalThis.File=class {constructor(parts,name,options){this.parts=parts;this.name=name;this.type=options?.type;}};globalThis.CustomEvent=class {constructor(type,options){this.type=type;Object.assign(this,options);}};
 try{
  const base=await makeProject(),edited=await makeProject({files:[{path:'main.tex',bytes:new TextEncoder().encode('\\documentclass{article}\n\\begin{document}RED 71 tuned\\end{document}')}]});
  const baseline=pdfArtifact(base,'%PDF-baseline'),good=pdfArtifact(edited,'%PDF-good-candidate'),puts=[],downloads=[];let decides=0,blueFile=null;
  const session={getInputIdentity:()=>({projectId:base.id,changes:[]}),snapshot:()=>({project:base,changes:[]}),compile:async()=>baseline,getCurrentProject:async()=>base};
  const doc={createElement:tag=>new Element(tag),dispatchEvent:e=>{blueFile=e.detail.file;return false;},querySelector:()=>null};
  const host=new Element('host'),agent=mountPaperLayoutAgent({doc,host,getSession:()=>session,getEpoch:()=>1,download:(...a)=>downloads.push(a),storeFactory:memoryStore(puts),previewFactory:quietPreview,bridge:{session:()=>({request:async()=>{decides++;throw new Error('model request failed');}})},compilerFactory:()=>({compile:async()=>baseline,dispose(){}}),readerFactory:()=>({dispose(){}})});
  await agent.restoreRun(savedState(base,baseline,edited,good));assert.equal(agent.getCandidate().artifact.pdfHash,good.pdfHash);
  await find(host,'원본에서 다시 시작').onclick();
  assert.equal(decides,1,'the real agent reached decide once');
  assert.equal(agent.getFailedRun().runState,'failed');assert.notEqual(agent.getFailedRun().runId,'saved-run');
  assert.equal(agent.getCandidate().artifact.pdfHash,good.pdfHash);assert.equal(agent.getRunState().runId,'saved-run');assert.equal(agent.getRunState().candidate.artifact.pdfHash,good.pdfHash);
  assert.equal(puts.at(-1).runId,'saved-run','the device store ends on the kept run, not the failed one');
  assert.ok(findAll(host,n=>typeof n.textContent==='string'&&n.textContent.includes('이전 후보를 유지')).length);
  find(host,'후보 PDF 다운로드').onclick();assert.deepEqual(downloads.at(-1)[0],good.pdfBytes);
  assert.equal(find(host,'이 PDF로 BLUE 검토').disabled,false);find(host,'이 PDF로 BLUE 검토').onclick();assert.deepEqual(blueFile.parts[0],good.pdfBytes);
 }finally{globalThis.File=previousFile;globalThis.CustomEvent=previousEvent;}
});

test('a source switch shows a foreign candidate as detached, excludes it from the new archive and reset clears it',async()=>{
 const {encodeSourceSession}=await import('../src/latex-session-archive.mjs');const {layoutRunForSource}=await import('../src/paper-layout-agent-ui.mjs');
 const hashA=hex(new Uint8Array([1,1,1])),hashB=hex(new Uint8Array([2,2,2]));
 const a=await makeProject({origin:'reconstructed-pdf',sourcePdfHash:hashA}),b=await makeProject({origin:'reconstructed-pdf',sourcePdfHash:hashB,files:[{path:'main.tex',bytes:new TextEncoder().encode('\\documentclass{article}\n\\begin{document}Paper B\\end{document}')}]});
 const artifactA=pdfArtifact(a,'%PDF-A');let current=a;
 const session={getInputIdentity:()=>({projectId:current.id,changes:[]}),snapshot:()=>({project:current,changes:[]}),getCurrentProject:async()=>current};
 const host=new Element('host'),agent=mountPaperLayoutAgent({doc:document,host,getSession:()=>session,getEpoch:()=>1,download(){},storeFactory:memoryStore([]),previewFactory:quietPreview,bridge:{session:()=>({})},runAgent:()=>{throw new Error('restore must not run the model');}});
 await agent.restoreRun(savedState(a,artifactA,a,artifactA));const note=find(host,'이전 소스에서 만든 후보입니다. 현재 소스의 BLUE 검토나 계속 편집에는 쓸 수 없습니다.');
 assert.equal(note.hidden,true);assert.equal(find(host,'이 PDF로 BLUE 검토').disabled,false);assert.equal(layoutRunForSource(agent.getRunState(),a.id).runId,'saved-run');
 current=b;agent.invalidate();
 assert.equal(note.hidden,false);assert.equal(find(host,'이 PDF로 BLUE 검토').disabled,true);assert.equal(find(host,'후보 소스로 계속 편집').disabled,true);
 assert.equal(layoutRunForSource(agent.getRunState(),b.id),null);
 await assert.rejects(encodeSourceSession({project:b,changes:[],layoutRun:agent.getRunState()},{createLatexProject}),/mismatched/,'embedding the other paper run breaks the archive');
 const json=await encodeSourceSession({project:b,changes:[],layoutRun:layoutRunForSource(agent.getRunState(),b.id)},{createLatexProject});assert.equal(JSON.parse(json).payload.layoutRun,undefined);
 agent.reset();assert.equal(agent.getCandidate(),null);assert.equal(agent.getRunState(),null);assert.equal(find(host,'이 PDF로 BLUE 검토').disabled,true);
});

test('choosing a checkpoint drops the old pending receipt so continuation does not look it up',async()=>{
 const base=await makeProject(),edited=await makeProject({files:[{path:'main.tex',bytes:new TextEncoder().encode('\\documentclass{article}\n\\begin{document}RED 71 cp\\end{document}')}]}),baseline=pdfArtifact(base,'%PDF-base'),cp=pdfArtifact(edited,'%PDF-cp');
 const pendingStep={runId:'saved-run',stepId:'saved-run-s1',projectId:edited.id,step:1,request:{projectId:edited.id,step:1},state:'unknown'};let resumed;
 const session={getInputIdentity:()=>({projectId:base.id,changes:[]}),snapshot:()=>({project:base,changes:[]}),getCurrentProject:async()=>base};
 const host=new Element('host'),agent=mountPaperLayoutAgent({doc:document,host,getSession:()=>session,getEpoch:()=>1,download(){},storeFactory:memoryStore([]),previewFactory:quietPreview,bridge:{session:()=>({}),state:()=>({cap:{paperLayoutJobs:true}})},compilerFactory:()=>({dispose(){}}),readerFactory:()=>({dispose(){}}),runAgent:async o=>{resumed=o.resumeState;return {project:o.resumeState.candidate.project,artifact:o.resumeState.candidate.artifact,status:'unresolved',runState:'paused'};}});
 await agent.restoreRun(savedState(base,baseline,edited,cp,{pendingStep,checkpoints:[{revisionId:'r1',label:'cp',project:edited,artifact:cp}]}));assert.equal(agent.getRunState().pendingStep.stepId,'saved-run-s1');
 const revision=findAll(host,n=>n.tag==='select')[1];revision.value='r1';revision.onchange();for(let i=0;i<5;i++)await tick();
 assert.equal(agent.getRunState().pendingStep,null);
 await find(host,'AI로 배치 다듬기').onclick();assert.ok(resumed,'continuation used the checkpoint state');assert.equal(resumed.pendingStep,null);
});

test('an unrecoverable pending receipt is only looked up; the user discards it before a new request is sent',async()=>{
 const base=await makeProject(),edited=await makeProject({files:[{path:'main.tex',bytes:new TextEncoder().encode('\\documentclass{article}\n\\begin{document}RED 71 pending\\end{document}')}]}),baseline=pdfArtifact(base,'%PDF-base'),cand=pdfArtifact(edited,'%PDF-cand');
 const pendingStep={runId:'saved-run',stepId:'saved-run-s1',projectId:edited.id,step:1,request:{schema:'falsify.paper-layout-agent-step.v1',projectId:edited.id,step:1},state:'unknown'};const calls=[];
 const link={request:async(path,body)=>{calls.push({path,post:!!body});if(!body)throw Object.assign(new Error('layout_step_not_found'),{httpStatus:404});return {schema:'falsify.layout-step-receipt.v1',runId:body.runId,stepId:body.stepId,fingerprint:'c'.repeat(64),state:'failed',error:{message:'stopped'}};}};
 const session={getInputIdentity:()=>({projectId:base.id,changes:[]}),snapshot:()=>({project:base,changes:[]}),getCurrentProject:async()=>base};
 const host=new Element('host'),agent=mountPaperLayoutAgent({doc:document,host,getSession:()=>session,getEpoch:()=>1,download(){},storeFactory:memoryStore([]),previewFactory:quietPreview,bridge:{session:()=>link,state:()=>({cap:{paperLayoutJobs:true}})},compilerFactory:()=>({compile:async()=>cand,dispose(){}}),readerFactory:()=>({dispose(){}})});
 await agent.restoreRun(savedState(base,baseline,edited,cand,{pendingStep}));const discard=find(host,'보류 중인 요청 버리기');assert.equal(discard.hidden,true);
 await find(host,'AI로 배치 다듬기').onclick();
 assert.deepEqual(calls.map(c=>c.post),[false],'recovery is a GET only');assert.equal(calls[0].path,'/api/paper/layout-agent/jobs/saved-run-s1');
 assert.equal(discard.hidden,false);assert.equal(agent.getCandidate().artifact.pdfHash,cand.pdfHash);assert.equal(agent.getRunState().pendingStep.stepId,'saved-run-s1');
 await find(host,'AI로 배치 다듬기').onclick();assert.deepEqual(calls.map(c=>c.post),[false,false],'retrying still never submits');
 await discard.onclick();assert.equal(agent.getRunState().pendingStep,null);assert.equal(discard.hidden,true);assert.equal(calls.length,2,'discarding sends nothing');
 await find(host,'AI로 배치 다듬기').onclick();assert.deepEqual(calls.map(c=>c.post),[false,false,true],'one new request only after the user continues');assert.equal(agent.getCandidate().artifact.pdfHash,cand.pdfHash);
});

test('finding regions reach the preview; page inputs stay within the document and partial checks keep scoped wording',async()=>{
 const project=await makeProject(),artifact=pdfArtifact(project,'%PDF-region-qa'),host=new Element('host'),shown=[];
 const session={getInputIdentity:()=>({projectId:project.id,changes:[]}),getCurrentProject:async()=>project};
 const agent=mountPaperLayoutAgent({doc:document,host,getSession:()=>session,getEpoch:()=>1,download(){},storeFactory:memoryStore([]),previewFactory:({onPage})=>({setDocuments:async()=>{},show:async args=>{shown.push(args);const result={original:{pageIndex:args.originalPageIndex,totalPages:2},candidate:{pageIndex:args.candidatePageIndex,totalPages:2}};onPage(result);return result;},dispose(){}})});
 const state=savedState(project,artifact,project,artifact,{quality:{content:'unchanged',layout:'issues',observedPages:[0],findings:[{code:'text-overlap',pageIndex:1,bbox:[10,20,40,60],document:'candidate'}]}});
 await agent.restoreRun(state);find(host,'2쪽 · 글자 겹침').onclick();await tick();
 assert.deepEqual(shown.at(-1).focus,{document:'candidate',bbox:[10,20,40,60]});assert.equal(shown.at(-1).candidatePageIndex,1);
 const original=find(host,'원본 쪽').children[0];original.value='5';original.onchange();await tick();assert.equal(original.value,'2');assert.equal(shown.at(-1).originalPageIndex,1);assert.equal(shown.at(-1).focus,null);
 assert.ok(find(host,'배치 전 PDF 2 / 2쪽'));assert.ok(find(host,'원본 페이지 텍스트'));assert.ok(find(host,'후보 페이지 텍스트'));
 await agent.restoreRun({...state,quality:{content:'unchanged',layout:'clear',layoutScope:'observed',inspectionStatus:'partial',observedPages:[0],findings:[]}});
 assert.ok(findAll(host,n=>n.textContent?.includes('검사 범위에서 문제 없음')).length);assert.equal(findAll(host,n=>n.textContent?.includes('배치 검사 통과')).length,0);
});
