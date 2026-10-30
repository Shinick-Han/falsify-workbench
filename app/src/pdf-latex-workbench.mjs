import {prepareReconstruction,createReconstructionProject,compareReconstruction} from './pdf-latex-baseline.mjs';
import {createLatexCompiler} from './latex-compiler-adapter.mjs';
import {exportLatexProject} from './latex-project.mjs';
import {readDocument} from './paper-document.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';

const base=new URL('.',import.meta.url);
/** Optional PDF-to-source route. Existing PDF editing stays the default. */
export function mountPdfLatexWorkbench(doc=globalThis.document){
  const workspace=doc.getElementById('paper-workspace'),options=doc.getElementById('paper-recompose')?.closest('details');
  if(!workspace||!options)return null;
  const element=(tag,text='',className='')=>{const n=doc.createElement(tag);n.textContent=text;if(className)n.className=className;return n;};
  const button=text=>{const b=element('button',text,'button secondary');b.type='button';return b;};
  const launch=button('PDF를 LaTeX 소스로 편집');launch.id='pdf-latex-start';options.append(launch);
  const panel=element('section','','pdf-latex-workbench');panel.hidden=true;panel.setAttribute('aria-label','PDF 소스 재구성');workspace.after(panel);
  const heading=element('h2','원본과 재구성본을 확인하세요'),status=element('p');status.setAttribute('role','status');
  const stop=button('취소'),close=button('PDF 편집으로 돌아가기'),controls=element('div','','button-row');controls.append(stop,close);
  const pager=element('div','','button-row'),previous=button('←'),next=button('→'),pageLabel=element('span');previous.setAttribute('aria-label','재구성 이전 쪽');next.setAttribute('aria-label','재구성 다음 쪽');pager.append(previous,pageLabel,next);
  const panes=element('div','','latex-preview-panes'),originalPane=element('div','','latex-preview-pane'),baselinePane=element('div','','latex-preview-pane'),originalCanvas=element('canvas'),baselineCanvas=element('canvas');
  originalCanvas.setAttribute('aria-label','재구성 원본 PDF');baselineCanvas.setAttribute('aria-label','공격 없는 재구성 기준본 PDF');originalPane.append(element('h3','원본 PDF'),originalCanvas);baselinePane.append(element('h3','공격 없는 재구성 기준본'),baselineCanvas);panes.append(originalPane,baselinePane);
  const summary=element('p'),details=element('details'),detailsTitle=element('summary','복원 차이와 인식 내용'),report=element('pre'),corrections=element('div'),rebuild=button('보정한 기준본 만들기');details.append(detailsTitle,report,corrections,rebuild);
  const actions=element('div','','button-row'),download=button('재구성 PDF 다운로드'),sourceDownload=button('LaTeX ZIP 다운로드'),accept=button('이 기준본으로 편집');actions.append(download,sourceDownload,accept);panel.append(heading,status,controls,pager,panes,summary,details,actions);
  let ticket=0,abort=null,compiler=null,draft=null,prepared=null,artifact=null,pdfjs=null,pdfs=[],pageIndex=0,renderTicket=0,originalBytes=null,busy=false,sourceIdentity=null;
  function save(bytes,name,type){const url=URL.createObjectURL(new Blob([bytes],{type})),a=element('a');a.href=url;a.download=name;doc.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  function buttons(){download.disabled=!artifact;sourceDownload.disabled=!prepared;accept.disabled=busy||!artifact;rebuild.disabled=busy||!draft;stop.hidden=!busy;previous.disabled=!pdfs.length||pageIndex===0;next.disabled=!pdfs.length||pageIndex>=Math.max(...pdfs.map(p=>p.numPages))-1;}
  function currentSource(){return globalThis.FalsifyPaperWorkspace?.getSource?.();}
  function stillCurrent(own){return own===ticket&&sourceIdentity===currentSource()?.fileHash&&!globalThis.FalsifyLatexWorkbench?.active;}
  async function disposePdfs(){++renderTicket;for(const p of pdfs)try{await p.destroy();}catch{}pdfs=[];}
  async function cancel(){++ticket;abort?.abort();compiler?.cancel();compiler?.dispose();compiler=null;busy=false;buttons();}
  async function render(){if(pdfs.length!==2)return;const own=++renderTicket;pageLabel.textContent=`${pageIndex+1} / ${Math.max(...pdfs.map(p=>p.numPages))}쪽`;buttons();for(const[i,pdf]of pdfs.entries()){const canvas=i?baselineCanvas:originalCanvas;if(pageIndex>=pdf.numPages){canvas.width=canvas.height=1;continue;}const page=await pdf.getPage(pageIndex+1),viewport=page.getViewport({scale:1.2}),scratch=doc.createElement('canvas');scratch.width=Math.ceil(viewport.width);scratch.height=Math.ceil(viewport.height);await page.render({canvasContext:scratch.getContext('2d'),viewport}).promise;if(own!==renderTicket)return;canvas.width=scratch.width;canvas.height=scratch.height;canvas.getContext('2d').drawImage(scratch,0,0);}}
  previous.onclick=()=>{pageIndex=Math.max(0,pageIndex-1);void render();};next.onclick=()=>{pageIndex++;void render();};
  function decisions(){return [...corrections.querySelectorAll('textarea')].filter(t=>t.value.trim()).map(t=>{const item=draft.model.items.find(i=>i.id===t.dataset.itemId);return {itemId:item.id,sourceSha256:draft.sourceSha256,tex:t.value,evidence:structuredClone(item.evidence)};});}
  function correctionInputs(){corrections.replaceChildren();for(const item of draft.model.items.filter(i=>['math','superscript','subscript','footnote','citation','unknown'].includes(i.kind)||i.status==='unsupported')){const label=element('label',`${(item.evidence?.[0]?.pageIndex??0)+1}쪽 · ${item.kind}`),quote=element('p',item.text||'그림으로 보존한 영역'),input=element('textarea');input.rows=2;input.dataset.itemId=item.id;input.setAttribute('aria-label',`${item.id} LaTeX 보정`);label.append(quote,input);corrections.append(label);}}
  async function compile(own){busy=true;artifact=null;buttons();try{prepared=await createReconstructionProject(draft,decisions());if(!stillCurrent(own))return;status.textContent='공격을 넣기 전 기준본을 만들고 있습니다.';compiler?.dispose();compiler=createLatexCompiler({assetBase:new URL('latex-compiler-vendor/',base).href});const result=await compiler.compile({project:prepared.project,signal:abort.signal});if(!stillCurrent(own))return;if(!result.success)throw new Error(result.diagnostics?.find(d=>d.severity==='error')?.message||'PDF를 만들지 못했습니다.');
      const bytes=result.pdfBytes.slice(),sha256=hex(bytes);if(result.pdfHash&&result.pdfHash!==sha256)throw new Error('생성 파일 해시가 다릅니다.');
      const document=await readDocument({file:bytes,signal:abort.signal});if(!stillCurrent(own))return;const comparison=compareReconstruction(draft.evidence.document,document);artifact={...result,pdfBytes:bytes,pdfHash:sha256,comparison};
      summary.textContent=`원본 ${comparison.sourcePages}쪽 → 기준본 ${comparison.baselinePages}쪽 · 숫자 토큰 차이 ${comparison.numbers.missing.length+comparison.numbers.added.length}개`;
      report.textContent=JSON.stringify({comparison,diagnostics:prepared.diagnostics,regions:draft.model.items.filter(i=>i.assetId).map(i=>({kind:i.kind,page:(i.evidence?.[0]?.pageIndex??0)+1,editable:false}))},null,2);
      status.textContent=prepared.status==='ready'?'편집할 기준본이 준비됐습니다.':'재구성본이 준비됐습니다. 원본과 차이를 확인하고 필요한 곳을 보정하세요.';
      pdfjs??=await import('./vendor/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc=new URL('vendor/pdf.worker.mjs',base).href;await disposePdfs();if(!stillCurrent(own))return;
      const loaded=await Promise.all([originalBytes,bytes].map(data=>pdfjs.getDocument({data:data.slice(),cMapUrl:new URL('vendor/cmaps/',base).href,cMapPacked:true,standardFontDataUrl:new URL('vendor/standard_fonts/',base).href,wasmUrl:new URL('vendor/wasm/',base).href}).promise));if(!stillCurrent(own)){for(const p of loaded)await p.destroy();return;}pdfs=loaded;pageIndex=0;await render();
    }catch(e){if(stillCurrent(own)&&e.name!=='AbortError')status.textContent=e.message;}finally{if(own===ticket){busy=false;buttons();}}}
  launch.onclick=async()=>{const source=currentSource();if(!source?.file||source.file.type!=='application/pdf'&&!/\.pdf$/i.test(source.file.name))return;await cancel();await disposePdfs();const own=ticket;sourceIdentity=source.fileHash;abort=new AbortController();draft=prepared=artifact=null;originalCanvas.width=baselineCanvas.width=1;summary.textContent=report.textContent='';corrections.replaceChildren();panel.hidden=false;busy=true;buttons();panel.scrollIntoView({block:'start'});try{originalBytes=new Uint8Array(await source.file.arrayBuffer());draft=await prepareReconstruction({file:source.file,signal:abort.signal,onProgress:message=>{if(stillCurrent(own))status.textContent=message;}});if(!stillCurrent(own))return;correctionInputs();await compile(own);}catch(e){if(stillCurrent(own)&&e.name!=='AbortError')status.textContent=e.message;}finally{if(own===ticket){busy=false;buttons();}}};
  rebuild.onclick=()=>{if(abort?.signal.aborted)abort=new AbortController();void compile(ticket);};stop.onclick=()=>{void cancel();status.textContent='취소했습니다. 원본 PDF는 그대로입니다.';};close.onclick=()=>{void cancel();void disposePdfs();panel.hidden=true;workspace.scrollIntoView({block:'start'});};
  download.onclick=()=>{if(artifact)save(artifact.pdfBytes,'reconstructed-baseline.pdf','application/pdf');};sourceDownload.onclick=async()=>{if(prepared)save(await exportLatexProject(prepared.project),'reconstructed-source.zip','application/zip');};
  accept.onclick=async()=>{if(!artifact||busy||!stillCurrent(ticket))return;busy=true;buttons();try{await globalThis.FalsifyLatexWorkbench.loadReconstructed({project:prepared.project,file:draft.file});panel.hidden=true;await disposePdfs();}catch(e){status.textContent=e.message;}finally{busy=false;buttons();}};
  doc.addEventListener('falsify:paper-workspace-source',()=>{if(sourceIdentity&&sourceIdentity!==currentSource()?.fileHash){void cancel();void disposePdfs();panel.hidden=true;}});
  buttons();return {cancel,getState:()=>({busy,sourceSha256:sourceIdentity,project:prepared?.project,artifact})};
}
