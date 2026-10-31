import {runPaperLayoutAgent} from './paper-layout-agent.mjs';
import {createLatexCompiler} from './latex-compiler-adapter.mjs';
import {createReconstructionReader} from './pdf-latex-reader.mjs';
import {exportLatexProject} from './latex-project.mjs';

const base=new URL('.',import.meta.url);
const aborted=()=>new DOMException('취소했습니다.','AbortError');
const actionLabels={read_source:'소스 확인',replace_source:'배치 수정',compile_pdf:'PDF 생성',inspect_pdf:'겹침·잘림 검사',render_pages:'페이지 확인',finish:'마무리'};
const runLabels={complete:'작업 완료',unresolved:'확인할 부분이 남았습니다',cancelled:'중단했습니다'};

// The companion returns a JSON object through the existing authenticated bridge.
export async function requestLayoutDecision(link,input,signal,onReceipt){
  const response=await link.request('/api/paper/layout-agent/step',{schema:'falsify.paper-layout-agent-step.v1',consent:true,...input},{signal});
  if(signal?.aborted)throw aborted();
  if(response?.schema!=='falsify.paper-layout-agent-action.v1'||response.projectId!==input.projectId||response.step!==input.step||!response.action)throw new Error('레이아웃 응답이 현재 작업과 일치하지 않습니다.');
  onReceipt?.({projectId:response.projectId,step:response.step,model:response.model,skillHash:response.skillHash});
  return response.action;
}

export function mountPaperLayoutAgent({doc,host,getSession,getEpoch,download,loadCandidate,bridge=globalThis.FalsifyLocalBridge,runAgent=runPaperLayoutAgent,compilerFactory=()=>createLatexCompiler({assetBase:new URL('latex-compiler-vendor/',base).href}),readerFactory=createReconstructionReader,loadPdf=async()=>{const lib=await import('./vendor/pdf.mjs');lib.GlobalWorkerOptions.workerSrc=new URL('vendor/pdf.worker.mjs',base).href;return lib;}}){
  const el=(tag,text='')=>{const n=doc.createElement(tag);n.textContent=text;return n;};
  const box=el('details'),title=el('summary','고급 · AI 레이아웃 조정'),notice=el('p','시작하면 현재 선택된 변경이 반영된 LaTeX 소스와 PDF 페이지 이미지가 연결된 companion의 AI에 전달됩니다. 결과는 별도 후보로 보관됩니다.'),goalLabel=el('label','레이아웃 요청 (선택)'),goal=el('textarea'),start=el('button','AI 레이아웃 시작'),cancel=el('button','중단'),status=el('p'),identity=el('p'),previous=el('button','이전 후보 쪽'),pageLabel=el('span'),next=el('button','다음 후보 쪽'),canvas=el('canvas'),pdf=el('button','후보 PDF 다운로드'),source=el('button','후보 소스 ZIP 다운로드'),blue=el('button','이 PDF로 BLUE 검토'),adopt=el('button','후보 소스로 계속 편집'),lineage=el('p','후보 소스로 계속 편집하면 새 소스 작업을 엽니다. 기존 편집 이력과 재구성 원본 계보는 새 작업에 연결되지 않습니다.');
  goal.value='현재 단어와 선택된 RED 편집을 보존하면서 자연스럽고 읽기 좋은 배치로 조정하세요.';goal.maxLength=2000;goalLabel.append(goal);
  for(const b of [start,cancel,previous,next,pdf,source,blue,adopt])b.type='button';status.setAttribute('role','status');canvas.setAttribute('aria-label','레이아웃 후보 PDF 미리보기');box.append(title,notice,goalLabel,start,cancel,status,identity,previous,pageLabel,next,canvas,pdf,source,blue,adopt,lineage);host.append(box);
  const recordButton=el('button','작업 기록 저장');recordButton.type='button';box.append(recordButton);
  for(const b of [start,cancel,pdf,source,blue,adopt,previous,next,recordButton])b.className='button secondary';
  canvas.className='paper-layout-agent-preview';identity.className='paper-layout-agent-identity';box.className='paper-layout-agent';
  let controller=null,candidate=null,signature=null,previewTicket=0,previewPage=0,previewPages=0,receipts=[],runGoal='';
  recordButton.onclick=()=>{if(!candidate)return;download(new TextEncoder().encode(JSON.stringify({schema:'falsify.paper-layout-agent-run.v1',status:candidate.status,projectId:candidate.project?.id,pdfHash:candidate.artifact?.pdfHash,goal:runGoal,decisions:receipts,trace:candidate.trace||[],coverage:candidate.coverage,message:candidate.message},null,2)),'layout-agent-run.json','application/json');};
  const same=()=>{const s=getSession();return !!s&&signature&&signature.epoch===getEpoch()&&signature.session===s&&signature.changes===JSON.stringify(s.snapshot().changes);};
  function controls(){recordButton.disabled=!!controller||!candidate;const fresh=!!candidate&&same();start.disabled=!!controller;cancel.hidden=!controller;pdf.disabled=!candidate?.artifact?.pdfBytes;source.disabled=!candidate?.project;blue.disabled=!!controller||!fresh||!candidate?.artifact?.pdfBytes;adopt.disabled=!!controller||!fresh||!candidate?.project||typeof loadCandidate!=='function';previous.disabled=!previewPages||previewPage===0;next.disabled=!previewPages||previewPage>=previewPages-1;if(candidate)identity.textContent=`후보 소스 ${candidate.project?.id||'미확인'} · PDF ${candidate.artifact?.pdfHash||'미확인'}${fresh?' · 현재 작업에서 생성':' · 이전 작업의 후보 (BLUE 및 계속 편집 불가)'}`;else identity.textContent='';}
  function invalidate(){if(controller&&!same()){controller.abort();status.textContent='작업 중 소스가 변경되어 중단했습니다.';}controls();}
  async function preview(){const own=++previewTicket,artifact=candidate?.artifact;previewPages=0;controls();if(!artifact?.pdfBytes){canvas.width=canvas.height=1;pageLabel.textContent='';return;}let task;try{const lib=await loadPdf();if(own!==previewTicket)return;task=lib.getDocument({data:artifact.pdfBytes.slice(),cMapUrl:new URL('vendor/cmaps/',base).href,cMapPacked:true,standardFontDataUrl:new URL('vendor/standard_fonts/',base).href,wasmUrl:new URL('vendor/wasm/',base).href});const document=await task.promise;if(own!==previewTicket)return;previewPages=document.numPages;previewPage=Math.min(previewPage,previewPages-1);const page=await document.getPage(previewPage+1);if(own!==previewTicket)return;const viewport=page.getViewport({scale:1}),scratch=doc.createElement('canvas');scratch.width=Math.ceil(viewport.width);scratch.height=Math.ceil(viewport.height);await page.render({canvasContext:scratch.getContext('2d'),viewport}).promise;if(own!==previewTicket)return;canvas.width=scratch.width;canvas.height=scratch.height;canvas.getContext('2d').drawImage(scratch,0,0);pageLabel.textContent=`${previewPage+1} / ${previewPages}쪽`;controls();}catch(e){if(own===previewTicket){pageLabel.textContent='후보 미리보기를 표시하지 못했습니다. PDF는 다운로드할 수 있습니다.';previewPages=0;controls();}}finally{if(task)await task.destroy();}}
  function setCandidate(value){candidate=value;previewPage=0;canvas.width=canvas.height=1;pageLabel.textContent=value?'후보 미리보기 준비 중…':'';controls();void preview();}
  previous.onclick=()=>{if(previewPage>0){previewPage--;void preview();}};next.onclick=()=>{if(previewPage+1<previewPages){previewPage++;void preview();}};
  cancel.onclick=()=>{controller?.abort();status.textContent='중단 요청됨. 마지막 생성 PDF를 확인합니다.';};
  pdf.onclick=()=>{if(candidate?.artifact?.pdfBytes)download(candidate.artifact.pdfBytes,'layout-candidate.pdf','application/pdf');};
  source.onclick=async()=>{if(!candidate?.project)return;try{const zip=await exportLatexProject(candidate.project);download(zip,'layout-candidate-source.zip','application/zip');}catch(e){status.textContent=e.message;}};
  blue.onclick=()=>{if(controller||!same()||!candidate?.artifact?.pdfBytes)return;const ev=new CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:new File([candidate.artifact.pdfBytes],'layout-candidate.pdf',{type:'application/pdf'})}});if(doc.dispatchEvent(ev))doc.querySelector('[data-view="blue"]')?.click();};
  adopt.onclick=async()=>{if(controller||!same()||!candidate?.project||!loadCandidate)return;const selected=candidate,ownSignature=signature;adopt.disabled=true;try{const zip=await exportLatexProject(selected.project);if(candidate!==selected||signature!==ownSignature||!same())return;await loadCandidate(new File([zip],'layout-candidate-source.zip',{type:'application/zip'}));}catch(e){status.textContent=e.message;}finally{controls();}};
  start.onclick=async()=>{
    if(controller)return;const session=getSession(),link=bridge?.session?.();if(!session||!link){status.textContent='소스를 열고 companion을 연결하세요.';return;}
    const own=new AbortController();controller=own;signature={session,epoch:getEpoch(),changes:JSON.stringify(session.snapshot().changes)};setCandidate(null);receipts=[];status.textContent='현재 선택된 변경으로 PDF를 준비합니다.';const userGoal=goal.value.trim().slice(0,2000);runGoal=userGoal;
    const compiler=compilerFactory(),reader=readerFactory();
    const check=()=>{if(own.signal.aborted||!same())throw aborted();};
    try{
      const cancelInitial=()=>session.cancel?.();own.signal.addEventListener('abort',cancelInitial,{once:true});let artifact;try{artifact=await session.compile();}finally{own.signal.removeEventListener('abort',cancelInitial);}check();const project=await session.getCurrentProject();check();
      if(artifact.projectId!==project.id)throw new Error('현재 소스와 PDF가 일치하지 않습니다.');
      setCandidate({project,artifact,status:'unresolved',message:'검사와 렌더링 전 PDF'});
      const result=await runAgent({project,artifact,signal:own.signal,
        decide:input=>{check();return requestLayoutDecision(link,{...input,instruction:input.instruction+(userGoal?'\nUser-authorized layout goal (subject to preservation constraints): '+userGoal:'')},own.signal,r=>receipts.push(r));},
        compile:async request=>{check();const out=await compiler.compile(request);check();return out;},
        inspect:async ({artifact:a,signal})=>{check();const out=await reader.compare({bytes:a.pdfBytes,sourceFile:new File([a.pdfBytes],'layout.pdf',{type:'application/pdf'}),signal});check();const audit=out.layoutAudit;return typeof audit?.outputPdfHash==='string'&&/^[0-9a-f]{64}$/.test(audit.outputPdfHash)&&audit.outputPdfHash===a.pdfHash?{schema:'falsify.layout-quality.v1',status:audit.status,pdfHash:audit.outputPdfHash,issues:audit.findings,coverage:audit.coverage,limitations:audit.limitations}:{status:'unavailable'};},
        render:async ({artifact:a,pages,signal})=>{check();const lib=await loadPdf();check();const task=lib.getDocument({data:a.pdfBytes.slice(),cMapUrl:new URL('vendor/cmaps/',base).href,cMapPacked:true,standardFontDataUrl:new URL('vendor/standard_fonts/',base).href,wasmUrl:new URL('vendor/wasm/',base).href});let document;
          try{document=await task.promise;check();const selected=pages.length?pages.slice(0,4):[0];if(selected.some(p=>p>=document.numPages))throw new Error('요청한 페이지가 없습니다.');const images=[];for(const pageIndex of selected){check();const page=await document.getPage(pageIndex+1),natural=page.getViewport({scale:1});let scale=Math.min(1,2000/natural.width,2000/natural.height),encoded='';for(let attempt=0;attempt<5;attempt++){const viewport=page.getViewport({scale}),canvas=doc.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;check();const data=canvas.toDataURL('image/png');encoded=data.slice(data.indexOf(',')+1);if(encoded.length<=699052)break;scale*=0.7;}if(encoded.length>699052)throw new Error('페이지 이미지가 companion 크기 제한을 넘습니다.');images.push({pageIndex,mime:'image/png',base64:encoded});}return {images,coverage:{renderedPages:selected,totalPages:document.numPages,visualReview:'agent observation only'}};}finally{await task.destroy();}},
        onProgress:entry=>{if(!own.signal.aborted&&same())status.textContent=`${actionLabels[entry.action]||'작업'} · ${entry.result?.status==='ok'?'완료':entry.result?.status==='rejected'?'수정 방법을 다시 검토합니다':entry.result?.status==='failed'?'결과를 확인하고 있습니다':'진행 중'}`;}
      });
      if(same()){setCandidate(result);status.textContent=`${runLabels[result.status]||'작업 종료'} · ${result.message||''}`;}
    }catch(e){if(e.name!=='AbortError')status.textContent=e.message;else if(same())status.textContent='작업을 중단했습니다.';}finally{compiler.dispose();reader.dispose();if(controller===own)controller=null;controls();}
  };
  controls();return {invalidate,cancel:()=>controller?.abort(),getCandidate:()=>candidate};
}
