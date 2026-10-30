import {createReconstructionProject,createReconstructionLineage} from './pdf-latex-baseline.mjs';
import {createLatexCompiler} from './latex-compiler-adapter.mjs';
import {exportLatexProject} from './latex-project.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
import {createReconstructionReader} from './pdf-latex-reader.mjs';

const base=new URL('.',import.meta.url);
// A generation may become stale while its library or PDF documents are loading.
// Only the owning generation may detach the displayed preview or install its pair.
export async function replaceReconstructionPreview({library,isCurrent,dispose,load,install}) {
  const lib=await library();
  if(!isCurrent())return false;
  await dispose();
  if(!isCurrent())return false;
  const settled=await Promise.allSettled(load(lib));
  const loaded=settled.filter(r=>r.status==='fulfilled').map(r=>r.value);
  if(!isCurrent()||loaded.length!==2){
    for(const p of loaded)try{await (p.loadingTask||p).destroy();}catch{}
    if(isCurrent())throw new Error('미리보기를 열지 못했습니다. 생성 PDF는 다운로드할 수 있습니다.');
    return false;
  }
  install(loaded);
  return true;
}

/** Optional PDF-to-source route. Existing PDF editing stays the default. */
export function mountPdfLatexWorkbench(doc=globalThis.document){
  const workspace=doc.getElementById('paper-workspace'),options=doc.getElementById('paper-recompose')?.closest('details');
  if(!workspace||!options)return null;
  const element=(tag,text='',className='')=>{const n=doc.createElement(tag);n.textContent=text;if(className)n.className=className;return n;};
  const button=text=>{const b=element('button',text,'button secondary');b.type='button';return b;};
  const launch=button('PDF를 LaTeX 소스로 편집 (실험)');launch.id='pdf-latex-start';options.append(launch);
  const panel=element('section','','pdf-latex-workbench');panel.hidden=true;panel.setAttribute('aria-label','PDF 소스 재구성');workspace.after(panel);
  const heading=element('h2','원본과 재구성본을 확인하세요'),status=element('p');status.setAttribute('role','status');
  const stop=button('취소'),close=button('PDF 편집으로 돌아가기'),controls=element('div','','button-row');controls.append(stop,close);
  const pager=element('div','','button-row'),previous=button('←'),next=button('→'),pageLabel=element('span');previous.setAttribute('aria-label','재구성 이전 쪽');next.setAttribute('aria-label','재구성 다음 쪽');pager.append(previous,pageLabel,next);
  const panes=element('div','','latex-preview-panes'),originalPane=element('div','','latex-preview-pane'),baselinePane=element('div','','latex-preview-pane'),originalCanvas=element('canvas'),baselineCanvas=element('canvas');
  originalCanvas.setAttribute('aria-label','재구성 원본 PDF');baselineCanvas.setAttribute('aria-label','공격 없는 재구성 기준본 PDF');originalPane.append(element('h3','원본 PDF'),originalCanvas);baselinePane.append(element('h3','공격 없는 재구성 기준본'),baselineCanvas);panes.append(originalPane,baselinePane);
  const summary=element('p'),details=element('details'),detailsTitle=element('summary','복원 차이와 인식 내용'),report=element('pre'),corrections=element('div'),rebuild=button('보정한 기준본 만들기');details.append(detailsTitle,report,corrections,rebuild);
  const actions=element('div','','button-row'),download=button('재구성 PDF 다운로드'),sourceDownload=button('LaTeX ZIP 다운로드'),accept=button('이 기준본으로 편집');actions.append(download,sourceDownload,accept);panel.append(heading,status,controls,pager,panes,summary,details,actions);
  const reader=createReconstructionReader();let ticket=0,abort=null,compiler=null,draft=null,prepared=null,artifact=null,pdfjs=null,pdfs=[],pageIndex=0,renderTicket=0,originalBytes=null,busy=false,sourceIdentity=null,accepting=false;
  function save(bytes,name,type){const url=URL.createObjectURL(new Blob([bytes],{type})),a=element('a');a.href=url;a.download=name;doc.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  function buttons(){download.disabled=busy||!artifact;sourceDownload.disabled=busy||!prepared;accept.disabled=busy||!artifact||!prepared;rebuild.disabled=busy||!draft;stop.hidden=!busy;previous.disabled=!pdfs.length||pageIndex===0;next.disabled=!pdfs.length||pageIndex>=Math.max(...pdfs.map(p=>p.numPages))-1;}
  function currentSource(){return globalThis.FalsifyPaperWorkspace?.getSource?.();}
  function stillCurrent(own){return own===ticket&&sourceIdentity===currentSource()?.fileHash&&!globalThis.FalsifyLatexWorkbench?.active;}
  async function disposePdfs(){++renderTicket;const old=pdfs;pdfs=[];for(const p of old)try{await (p.loadingTask||p).destroy();}catch{}}
  async function cancel(){++ticket;++renderTicket;abort?.abort();reader.cancel();compiler?.cancel();compiler?.dispose();compiler=null;prepared=artifact=null;busy=false;buttons();}
  async function render(){if(pdfs.length!==2)return;const own=++renderTicket,documents=pdfs,requestedPage=pageIndex;pageLabel.textContent=`${requestedPage+1} / ${Math.max(...documents.map(p=>p.numPages))}쪽`;buttons();try{for(const[i,pdf]of documents.entries()){if(own!==renderTicket)return;const canvas=i?baselineCanvas:originalCanvas;if(requestedPage>=pdf.numPages){canvas.width=canvas.height=1;continue;}const page=await pdf.getPage(requestedPage+1);if(own!==renderTicket)return;const viewport=page.getViewport({scale:1.2}),scratch=doc.createElement('canvas');scratch.width=Math.ceil(viewport.width);scratch.height=Math.ceil(viewport.height);await page.render({canvasContext:scratch.getContext('2d'),viewport}).promise;if(own!==renderTicket)return;canvas.width=scratch.width;canvas.height=scratch.height;canvas.getContext('2d').drawImage(scratch,0,0);}}catch(e){if(own===renderTicket)throw e;}}
  previous.onclick=()=>{pageIndex=Math.max(0,pageIndex-1);void render();};next.onclick=()=>{pageIndex++;void render();};
  function decisions(){return [...corrections.querySelectorAll('textarea')].filter(t=>t.value.trim()).map(t=>{const item=draft.model.items.find(i=>i.id===t.dataset.itemId);return {itemId:item.id,sourceSha256:draft.sourceSha256,tex:t.value,evidence:structuredClone(item.evidence)};});}
  function correctionInputs(){corrections.replaceChildren();for(const item of draft.model.items.filter(i=>['math','superscript','subscript','footnote','citation','unknown'].includes(i.kind)||i.status==='unsupported'||i.extensions?.candidates?.length)){const label=element('label',`${(item.evidence?.[0]?.pageIndex??0)+1}쪽 · ${item.kind}`),quote=element('p',item.text||'그림으로 보존한 영역'),input=element('textarea');input.rows=2;input.dataset.itemId=item.id;input.setAttribute('aria-label',`${item.id} LaTeX 보정`);label.append(quote,input);corrections.append(label);}}
  async function compile(own){if(!stillCurrent(own)||!draft)return;const ownDraft=draft,ownDecisions=decisions(),signal=abort.signal,ownOriginal=originalBytes.slice();busy=true;prepared=artifact=null;buttons();try{const nextPrepared=await createReconstructionProject(ownDraft,ownDecisions);if(!stillCurrent(own))return;status.textContent='공격을 넣기 전 기준본을 만들고 있습니다.';compiler?.dispose();const ownCompiler=createLatexCompiler({assetBase:new URL('latex-compiler-vendor/',base).href});compiler=ownCompiler;const result=await ownCompiler.compile({project:nextPrepared.project,signal});if(!stillCurrent(own))return;if(!result.success)throw new Error(result.diagnostics?.find(d=>d.severity==='error')?.message||'PDF를 만들지 못했습니다.');
      const bytes=result.pdfBytes.slice(),sha256=hex(bytes);if(result.pdfHash&&result.pdfHash!==sha256)throw new Error('생성 파일 해시가 다릅니다.');
      const comparison=await reader.compare({sourceDocument:ownDraft.evidence.document,bytes,signal});if(!stillCurrent(own))return;const nextArtifact={...result,pdfBytes:bytes,pdfHash:sha256,comparison};
      const lineage=createReconstructionLineage({project:nextPrepared.project,artifact:nextArtifact,comparison,bindings:nextPrepared.bindings,decisions:ownDecisions});
      prepared={...nextPrepared,lineage};artifact=nextArtifact;busy=false;buttons();
      summary.textContent=`원본 ${comparison.sourcePages}쪽 → 기준본 ${comparison.baselinePages}쪽 · 숫자 토큰 차이 ${comparison.numbers.missing.length+comparison.numbers.added.length}개`;
      report.textContent=JSON.stringify({comparison,diagnostics:prepared.diagnostics,regions:draft.model.items.filter(i=>i.assetId).map(i=>({kind:i.kind,page:(i.evidence?.[0]?.pageIndex??0)+1,editable:false}))},null,2);
      status.textContent=prepared.status==='ready'?'편집할 기준본이 준비됐습니다.':'재구성본이 준비됐습니다. 원본과 차이를 확인하고 필요한 곳을 보정하세요.';
      const installed=await replaceReconstructionPreview({
        library:async()=>{const lib=pdfjs??await import('./vendor/pdf.mjs');pdfjs=lib;lib.GlobalWorkerOptions.workerSrc=new URL('vendor/pdf.worker.mjs',base).href;return lib;},
        isCurrent:()=>stillCurrent(own),dispose:disposePdfs,
        load:lib=>[ownOriginal,bytes].map(data=>lib.getDocument({data:data.slice(),cMapUrl:new URL('vendor/cmaps/',base).href,cMapPacked:true,standardFontDataUrl:new URL('vendor/standard_fonts/',base).href,wasmUrl:new URL('vendor/wasm/',base).href}).promise),
        install:loaded=>{pdfs=loaded;pageIndex=0;}
      });
      if(installed&&stillCurrent(own))await render();
    }catch(e){if(stillCurrent(own)&&e.name!=='AbortError')status.textContent=e.message;}finally{if(own===ticket){busy=false;buttons();}}}
  launch.onclick=async()=>{const source=currentSource();if(!source?.file||source.file.type!=='application/pdf'&&!/\.pdf$/i.test(source.file.name))return;void cancel();const own=ticket;sourceIdentity=source.fileHash;const controller=new AbortController();abort=controller;draft=prepared=artifact=null;originalCanvas.width=originalCanvas.height=baselineCanvas.width=baselineCanvas.height=1;summary.textContent=report.textContent='';corrections.replaceChildren();panel.hidden=false;busy=true;status.textContent='원본의 글·그림·표를 읽고 있습니다.';buttons();panel.scrollIntoView({block:'start'});try{await disposePdfs();if(!stillCurrent(own))return;const nextOriginal=new Uint8Array(await source.file.arrayBuffer());if(!stillCurrent(own))return;const nextDraft=await reader.read({file:source.file,signal:controller.signal,onProgress:message=>{if(stillCurrent(own))status.textContent=message;}});if(!stillCurrent(own))return;originalBytes=nextOriginal;draft=nextDraft;correctionInputs();await compile(own);}catch(e){if(stillCurrent(own)&&e.name!=='AbortError')status.textContent=e.message;}finally{if(own===ticket){busy=false;buttons();}}};
  rebuild.onclick=()=>{void cancel();abort=new AbortController();void compile(ticket);};stop.onclick=()=>{void cancel();status.textContent='취소했습니다. 원본 PDF는 그대로입니다.';};close.onclick=()=>{void cancel();void disposePdfs();panel.hidden=true;workspace.scrollIntoView({block:'start'});};
  download.onclick=()=>{if(artifact)save(artifact.pdfBytes,'reconstructed-baseline.pdf','application/pdf');};sourceDownload.onclick=async()=>{if(!prepared||busy)return;const own=ticket,captured=prepared;try{const zip=await exportLatexProject(captured.project);if(stillCurrent(own)&&prepared===captured&&!busy)save(zip,'reconstructed-source.zip','application/zip');}catch(e){if(stillCurrent(own))status.textContent=e.message;}};
  corrections.addEventListener('input',()=>{void cancel();status.textContent='보정 내용을 입력했습니다. 기준본을 다시 만드세요.';});
  accept.onclick=async()=>{if(!artifact||!prepared||busy||!stillCurrent(ticket))return;const own=++ticket,accepted=prepared,acceptedArtifact=artifact,signal=abort.signal;accepting=true;busy=true;buttons();try{await globalThis.FalsifyLatexWorkbench.loadReconstructed({project:accepted.project,file:draft.file,initialArtifact:acceptedArtifact,reconstruction:accepted.lineage,signal});if(own!==ticket||signal.aborted)throw new DOMException('취소했습니다.','AbortError');panel.hidden=true;await disposePdfs();}catch(e){if(own===ticket&&e.name!=='AbortError')status.textContent=e.message;}finally{accepting=false;if(own===ticket){busy=false;buttons();}}};
  doc.addEventListener('falsify:latex-state',()=>{if(!panel.hidden&&!accepting&&globalThis.FalsifyLatexWorkbench?.active){void cancel();void disposePdfs();panel.hidden=true;}});
  doc.addEventListener('falsify:paper-workspace-source',()=>{if(sourceIdentity&&sourceIdentity!==currentSource()?.fileHash){void cancel();void disposePdfs();panel.hidden=true;}});
  buttons();const api={cancel,getState:()=>({busy,sourceSha256:sourceIdentity,project:prepared?.project,artifact:artifact?structuredClone(artifact):null,lineage:prepared?.lineage})};globalThis.FalsifyPdfLatexWorkbench=api;return api;
}
