/* Full-paper RED review, candidate selection and preservation-gated export. */
(function(){
  'use strict';const C=FalsifyDocumentRed,B=FalsifyLocalBridge,$=s=>document.querySelector(s);
  let generation=0,doc=null,file=null,candidates=[],response=null,job=null,jobLink=null,busy=false,request=null,binding=null;
  // Run records: one key per (response epoch, final snapshot) so unchanged auto/manual saves never duplicate.
  let epoch=0,exported=null,lastSaved=null,failure=null,guard={};const saved=new Map(),pending=new Map(),settings={level:$('#red-level').value,budget:$('#red-budget').value};
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const msg=(s,error=false)=>{const e=$('#red-progress');e.textContent=s;e.classList.toggle('error',error);};
  function jsonDownload(value,name){download(new TextEncoder().encode(JSON.stringify(value,null,2)),name,'application/json');}
  function download(bytes,name,type){const url=URL.createObjectURL(new Blob([bytes],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  // Every job/export binds one bridge link for its whole life (start, polls, cancel); the bridge refuses to switch while busy.
  function link(){const l=B.session();if(!l)throw new Error('로컬 broker 연결이 없습니다. 위 연결 패널에서 연결하거나 수동 JSON 교환을 쓰세요.');return l;}
  function connection(){const s=B.state(),cap=s.cap;
    $('#red-connection').textContent=s.status==='checking'?'로컬 실행 상태 확인 중':s.connected?(s.status==='paired'?'페어링된 로컬 broker':'로컬 broker 연결')+(cap?.red?' · 실행 CLI·모델은 아래 Harness 선택을 따릅니다'+(cap.cliSelection?'':' · 이 companion은 기본 Codex CLI'+(cap.model?' ('+cap.model+')':'')+'만 지원 (CLI 선택은 최신 companion 필요)')+' · 사용자 harness는 자체 모델/도구를 사용하며 내부 격리는 미검증':' · 이 broker는 RED 실행을 지원하지 않습니다.'):'로컬 broker 연결 없음 · 파일 추출과 수동 JSON 교환만 가능합니다. 위 연결 패널을 확인하세요.';}
  // The record button is ledger-mounted; bridge changes before that only refresh the connection line.
  document.addEventListener('falsify:local-bridge',()=>{connection();if($('#red-record'))controls();});connection();
  function controls(){
    const active=!!doc&&!busy;
    const cap=B.capabilities();$('#red-start').disabled=!active||!cap?.red||!$('#red-consent').checked||!FalsifyLab.allowed('red');
    $('#red-record').disabled=!active||!response||pending.size>0;FalsifyLab.busy('red',busy||pending.size>0);B.busy('red',busy);
    $('#red-request').disabled=!active;$('#red-import-response').disabled=!active;
    $('#red-level').disabled=busy;$('#red-budget').disabled=busy;
    $('#red-cancel').hidden=!busy||!job;
    $('#red-plan').disabled=!active||!candidates.some(c=>c.selected);
    const count=candidates.filter(c=>c.selected).length;
    $('#red-selection-summary').textContent=count+'개 선택 · 처음에는 모두 미선택입니다. After를 바꾸면 이전 다운로드 검증은 무효입니다.';
    const plain=doc&&/^(TXT|MD|MARKDOWN|TEXT|TEX|CSV|TSV|RST)$/.test(doc.format);
    const pdf=doc?.format==='PDF'?pdfMode(cap):null,supported=plain||!!pdf&&pdf.kind!=='none';
    $('#red-download').disabled=!active||!count||!$('#red-export-consent').checked||!supported;
    const mode=$('#red-export-mode');mode.hidden=!supported||!pdf;mode.textContent=supported&&pdf?pdfModeText(pdf):'';
    if(doc&&!supported)$('#red-export-status').textContent=doc.format==='PDF'?(cap?(pdf.engine?MISSING_ENGINE+' 후보와 편집한 After는 그대로 남고, 변경 계획 JSON은 지금 저장할 수 있습니다.':'PDF 보존 검사는 PyMuPDF가 설치된 로컬 broker가 필요합니다.'):'PDF 보존 검사는 연결된 로컬 broker가 필요합니다. 변경 계획 JSON은 저장할 수 있습니다.'):'이 형식은 레이아웃 검증 렌더러가 아직 없습니다. 완성본 다운로드를 차단하고 변경 계획만 저장합니다.';
    document.querySelectorAll('#red-candidates input,#red-candidates textarea').forEach(e=>e.disabled=busy);
    renderRecord();renderHandoff();
    document.dispatchEvent(new CustomEvent('falsify:document-state',{detail:doc?{name:doc.name,count:candidates.length,selected:count,busy}:null}));
  }
  function cancelCurrent(){const old=job,l=jobLink;job=null;jobLink=null;if(old&&l)void l.request('/api/red/jobs/'+encodeURIComponent(old)+'/cancel',{}).catch(()=>{});}
  function clear(){generation++;cancelCurrent();binding=null;doc=null;file=null;candidates=[];response=null;request=null;busy=false;invalidate();$('#document-red').hidden=true;$('#red-candidates').replaceChildren();$('#red-response').value='';$('#red-record-status').textContent='';$('#red-export').hidden=true;$('#red-consent').checked=false;$('#red-harness-consent').checked=false;$('#red-export-consent').checked=false;$('#red-export-status').textContent='';msg('');controls();}
  document.addEventListener('falsify:document-clear',clear);
  // The shell asks before replacing/closing the source; cancelling the discard confirmation keeps everything.
  document.addEventListener('falsify:before-document-change',e=>{if(e.detail?.role==='red'&&!keepEdits())e.preventDefault();});
  // Source binding is a busy phase keyed by its own identity: only clear() (reset/replacement) abandons it, so a harness-change
  // that slips in mid-hash cannot drop the current input, and a stale binding never touches a newer one's busy state.
  document.addEventListener('falsify:document',async event=>{
    clear();const self={};binding=self;busy=true;const {file:source,result}=event.detail;msg('원문 해시 확인 중 · 완료 전에는 harness 변경과 실행이 잠깁니다.');controls();
    try{const sourceHash=await hash(new TextEncoder().encode(result.text)),fileHash=await hash(await source.arrayBuffer());if(binding!==self)return;
      file=source;doc={revision:crypto.randomUUID(),sourceHash,fileHash,format:String(result.format).slice(0,40),name:source.name.slice(0,160),segments:result.segments.map((s,i)=>({...s,id:'s'+i}))};
      $('#document-red').hidden=false;$('#red-document-summary').textContent=source.name+' · '+result.segments.length+'개 페이지/문단 · '+result.text.length.toLocaleString()+'자';
      msg('추출 텍스트 전체가 검토 대상입니다. 추출에서 빠진 이미지·수식·머리말 등은 읽었다고 주장하지 않습니다.');
    }catch(e){if(binding===self)msg('문서 바인딩 실패: '+e.message,true);}
    finally{if(binding===self){binding=null;busy=false;controls();}}
  });
  function renderCandidates(){
    const list=$('#red-candidates');list.replaceChildren();$('#red-empty').hidden=!!candidates.length;$('#red-export').hidden=!candidates.length;
    candidates.forEach((c,i)=>{
      const section=document.createElement('section');section.className='red-proposal';
      const choice=document.createElement('label');choice.className='check-row';const check=document.createElement('input');check.type='checkbox';check.checked=c.selected;
      const title=document.createElement('span');title.textContent='후보 '+(i+1)+' · '+c.label+' · L'+c.level;choice.append(check,title);section.append(choice);
      const rationale=document.createElement('p');rationale.textContent='공격 가설: '+c.rationale;section.append(rationale);
      const evidence=document.createElement('details'),summary=document.createElement('summary');summary.textContent='근거 인용 '+c.evidence.length+'개 · 원문 일치 확인';evidence.append(summary);
      c.evidence.forEach(e=>{const location=document.createElement('p');location.textContent=e.label+' — '+e.relation;const quote=document.createElement('blockquote');quote.textContent=e.quote;evidence.append(location,quote);});section.append(evidence);
      const comparison=document.createElement('div');comparison.className='red-ab';const before=document.createElement('div'),beforeTitle=document.createElement('h3'),beforeText=document.createElement('p');beforeTitle.textContent='Before · 원본 인용';beforeText.textContent=c.before;before.append(beforeTitle,beforeText);
      const after=document.createElement('div'),label=document.createElement('label'),area=document.createElement('textarea');area.id='red-after-'+i;area.rows=4;area.maxLength=4000;area.value=c.after;label.htmlFor=area.id;label.textContent='After · 직접 편집 가능';after.append(label,area);comparison.append(before,after);section.append(comparison);
      const uncertainty=document.createElement('p');uncertainty.className='muted';uncertainty.textContent='검증 한계: '+c.uncertainty;section.append(uncertainty);
      check.addEventListener('change',()=>{c.selected=check.checked;changed();});area.addEventListener('input',()=>{c.after=area.value;c.edited=true;changed();});list.append(section);
    });controls();
  }
  function applyResponse(res,origin,ask=false){const validated=C.validateResponse(doc,res);if(ask&&!keepEdits()){msg('응답 적용 취소: 기존 후보와 편집을 그대로 유지했습니다.');return;}invalidate();candidates=validated;response={...res,provenance:origin};renderCandidates();void save(null);msg(res.status==='refusal'?'모델이 거절했습니다. 우회하거나 자동 재시도하지 않습니다.':res.status==='abstain'?'모델이 유보했습니다. 후보를 강제로 만들지 않습니다.':validated.length+'개 후보 · 인용 위치 확인 완료, 과학적 타당성 미검증. '+(origin==='local-codex'?(res.coverage?.complete?'전체 추출 텍스트 전달 완료.':'전체 전달 미완료.'):'수동 응답의 실행·전체 전달 여부는 미검증.'));}
  async function makeRequest(){const budget=Number($('#red-budget').value);if(!Number.isInteger(budget)||budget<1||budget>32)throw new Error('호출 예산은 1–32 사이 정수입니다.');return FalsifyLab.bind('red',C.request(doc,Number($('#red-level').value),budget));}
  // While a response is retained, re-download its bound request so later final snapshots keep the root's requestId; only a fresh start mints a new execution request.
  $('#red-request').addEventListener('click',async()=>{const current=generation;try{const next=response&&request?request:await makeRequest();if(current!==generation)return;request=next;jsonDownload(request,'falsify-document-red-request.json');msg('수동 전달용 요청과 harness를 저장했습니다. 실행·전송은 하지 않았습니다.');}catch(e){msg(e.message,true);}});
  $('#red-import-response').addEventListener('click',async()=>{if(busy||!doc)return;const current=generation;try{const source=$('#red-response').value;if(source.length>150000)throw new Error('응답은 150,000자 이내입니다.');const next=request||await makeRequest();if(current!==generation)return;request=next;applyResponse(JSON.parse(source),'manual-unverified',true);}catch(e){msg('응답 적용 안 됨: '+e.message,true);}});
  $('#red-start').addEventListener('click',async()=>{
    if(busy||!doc||!$('#red-consent').checked||!FalsifyLab.allowed('red')||!keepEdits())return;const current=generation;
    busy=true;candidates=[];response=null;invalidate();$('#red-export-status').textContent='';$('#red-export-consent').checked=false;renderCandidates();controls();
    try{const l=link();request=await makeRequest();if(current!==generation)return;msg('전체 검토 예산 확인 후 선택 harness를 실행합니다.');const started=await l.request('/api/red/jobs',request);
      if(current!==generation){void l.request('/api/red/jobs/'+encodeURIComponent(started.id)+'/cancel',{}).catch(()=>{});return;}
      job=started.id;jobLink=l;controls();
      while(current===generation&&job){
        const data=await l.request('/api/red/jobs/'+encodeURIComponent(job));if(current!==generation||!job)return;
        if(data.state==='completed'){applyResponse(data.result,'local-codex');break;}
        if(['failed','cancelled'].includes(data.state))throw new Error(data.error||'검토 취소됨');
        msg('Harness 검토 중 · '+(data.progress.completedCalls||0)+' / '+(data.progress.requiredCalls||'?')+'회 완료 · 사용자 harness 내부 호출량은 별도입니다.');
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
    }catch(e){if(current===generation)msg(e.message+' 자동 재시도하지 않았습니다.',true);}
    finally{if(current===generation){busy=false;job=null;jobLink=null;controls();}}
  });
  $('#red-cancel').addEventListener('click',()=>{generation++;cancelCurrent();busy=!!binding;msg('취소 요청. 이미 시작된 CLI 호출은 종료/최대 180초까지 실행될 수 있지만 결과는 적용하지 않습니다.');controls();});
  for(const id of ['#red-consent','#red-export-consent'])$(id).addEventListener('change',controls);
  document.addEventListener('falsify:harness-consent',controls);
  document.addEventListener('falsify:harness-change',e=>{if(e.detail.role!=='red')return;snapshot();discard();msg('harness 변경: 이전 응답 무효화. 기록한 실행은 별도로 보존됩니다.');});
  $('#red-record').addEventListener('click',()=>{if(!doc||!response||busy)return;let final;try{final=finalState();}catch(e){failure={key:null,message:'현재 선택을 기록할 수 없습니다: '+e.message};renderRecord();return;}if(saved.has(key(final))){failure=null;renderRecord('변경이 없어 다시 기록하지 않았습니다. ');return;}void save(final);});
  for(const [id,name] of [['#red-level','level'],['#red-budget','budget']])$(id).addEventListener('change',()=>{const field=$(id);if(!keepEdits()){field.value=settings[name];return;}settings[name]=field.value;discard();msg('검토 설정이 바뀌어 이전 응답·후보 선택을 무효화했습니다. 새 요청을 만드세요.');});
  function plan(patches,extra={}){return {schema:'falsify.document-edit-plan.v1',revision:doc.revision,sourceHash:doc.sourceHash,sourceFileHash:doc.fileHash,sourceName:doc.name,format:doc.format,selected:patches,
    harness:request?.harness||null,harnessHash:response?.harnessHash||null,
    candidateRationales:candidates.filter(c=>c.selected).map(c=>({id:c.id,rationale:c.rationale,evidence:c.evidence,uncertainty:c.uncertainty})),reviewProvenance:response?.provenance,coverage:response?.coverage||null,
    status:{domainReview:'pending',teamApproval:'pending',gold:'pending',metric:null},...extra};}
  $('#red-plan').addEventListener('click',()=>{try{jsonDownload(plan(C.patches(doc,candidates)),'falsify-document-edit-plan.json');exportStatus('선택 변경과 근거를 저장했습니다. 이 파일은 BLUE에 전달하지 마세요.');}catch(e){exportStatus(e.message,true);}});
  function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);}
  function exportStatus(s,error=false){const e=$('#red-export-status');e.textContent=s;e.classList.toggle('error',error);}
  // PDF export path comes only from authenticated capabilities: reflow-capable editor, editor without reflow, legacy single-line preservation, or none.
  function pdfMode(cap){const e=cap?.pdfEditor||null;return {kind:e?.available?(e.reflow?'reflow':'editor'):cap?.pdf?'legacy':'none',engine:e};}
  const MISSING_ENGINE='줄바꿈 재배치 PDF 편집 엔진이 이 companion에 아직 준비되지 않았습니다. 위 연결 패널의 설치·실행 안내로 companion을 다시 준비한 뒤 연결하세요.';
  function pdfModeText(m){const e=m.engine;
    if(m.kind==='reflow')return 'PDF 편집 엔진 '+e.engine+' '+e.version+' · 원래 줄 공간을 넘는 After는 줄바꿈 재배치'+(e.pagination?'와 필요 시 페이지 추가':'(페이지 추가는 미지원)')+'를 시도합니다. 실제 줄바꿈·페이지 수는 완성본 생성 후 엔진 검증 결과로만 표시합니다.';
    if(m.kind==='editor')return 'PDF 편집 엔진 '+e.engine+' '+e.version+' · 이 버전은 줄바꿈 재배치를 지원하지 않아 원래 줄 공간에 들어가는 변경만 가능합니다.';
    return '기존 한 줄 보존 편집 · 원래 줄 공간에 들어가는 변경만 가능하며 줄바꿈·페이지 추가가 필요한 After는 차단됩니다.'+(e?' '+MISSING_ENGINE:' 긴 After의 줄바꿈 재배치는 최신 companion이 필요합니다.');}
  const whole=x=>Number.isSafeInteger(x)&&x>=0;
  function diagnostics(v){return Array.isArray(v?.diagnostics)?v.diagnostics.slice(0,5).map(x=>typeof x==='string'?x:x?.message).filter(x=>typeof x==='string'&&x.trim()).map(x=>x.slice(0,300)):[];}
  // Layout facts are read only from the engine's verification of this output; missing or malformed fields read as unverified, never assumed.
  function layoutReport(v){
    if(v?.engine==='falsify-pdf-editor'){const r=v.reflow,p=v.pagination,d=diagnostics(v),out=[];
      out.push(whole(r?.wrappedLines)?(r.wrappedLines?'줄바꿈 재배치 '+r.wrappedLines+'줄':'줄바꿈 없이 교체'):'줄바꿈 결과 미보고');
      out.push(whole(p?.inputPages)&&whole(p?.outputPages)&&p.outputPages>=p.inputPages?(p.outputPages>p.inputPages?'페이지 '+p.inputPages+' → '+p.outputPages+' (새 페이지 '+(p.outputPages-p.inputPages)+'쪽)':'페이지 수 그대로 '+p.outputPages+'쪽'):'페이지 수 변화 미검증');
      if(d.length)out.push('엔진 주의: '+d.join(' / '));
      return '엔진 검증 결과 · '+out.join(' · ')+'. 레이아웃 검사일 뿐 과학적 타당성·결함 품질 판정이 아닙니다. ';}
    if(v?.mode==='pdf-original-font-single-line')return '기존 한 줄 교체 · 줄바꿈·페이지 추가 없음'+(whole(v.pages)?' · '+v.pages+'쪽':'')+'. ';
    return '';}
  function recovery(kind){if(!kind)return '';const keep=' 선택한 후보와 직접 편집한 After는 그대로 남아 있습니다.';
    if(kind==='reflow')return keep+' 특이한 레이아웃에서는 긴 After의 재배치가 아직 지원되지 않을 수 있습니다. 해당 후보 선택을 해제하거나 After를 직접 조정해 다시 시도하거나, 변경 계획 JSON만 저장할 수 있습니다. 엔진·연결 오류라면 위 연결 패널에서 companion을 다시 실행·연결하세요.';
    return keep+' 이 companion은 원래 줄 공간에 들어가는 변경만 지원합니다. 줄바꿈 재배치 엔진이 있는 companion으로 다시 연결하거나, 다른 후보를 고르거나, 변경 계획 JSON만 저장할 수 있습니다.';}
  $('#red-download').addEventListener('click',async()=>{
    if(busy||!doc||!$('#red-export-consent').checked)return;const current=generation,pdf=doc.format==='PDF'?pdfMode(B.capabilities()):null;busy=true;controls();exportStatus('선택 변경만 적용하고 보존 검사 중');
    try{const patches=C.patches(doc,candidates);let output,reported=null;
      // Same request body as before: only checked candidates' Before plus the user's current After; progress is staged text, never an invented percentage.
      if(pdf){exportStatus('원본 PDF와 선택 변경 '+patches.length+'개를 companion에서 '+(pdf.kind==='reflow'?'교체·줄바꿈 재배치·보존 검사':'한 줄 교체·보존 검사')+'하는 중입니다. 엔진이 진행률을 알려주지 않아 퍼센트는 표시하지 않습니다.');
        const result=await link().request('/api/export',{format:doc.format,fileHash:doc.fileHash,file:base64(new Uint8Array(await file.arrayBuffer())),patches});if(current!==generation)return;
        exportStatus('companion 결과 수신 · 출력 파일과 레이아웃 검증 확인 중');reported=typeof result.outputFileHash==='string'?result.outputFileHash:null;
        output={bytes:Uint8Array.from(atob(result.file),x=>x.charCodeAt(0)),verification:result.verification};
        // Fail closed: a new-engine export downloads only with explicit layoutVerified === true; missing, null or false proof is never success.
        const v=output.verification,d=diagnostics(v),engine=pdf.kind==='reflow'||pdf.kind==='editor'||v?.engine==='falsify-pdf-editor';
        if(engine&&(v?.engine!=='falsify-pdf-editor'||v.layoutVerified!==true))throw new Error((v?.layoutVerified===false?'엔진이 이 출력의 레이아웃 검증을 통과시키지 못해':'엔진이 이 출력의 레이아웃 검증 통과를 증명하지 않아')+' 다운로드하지 않았습니다.'+(d.length?' 엔진 진단: '+d.join(' / '):''));}
      else output=await FalsifyExport.textFile(file,patches);
      if(current!==generation)return;
      const outputFileHash=await hash(output.bytes);if(current!==generation)return;
      if(reported&&reported!==outputFileHash)throw new Error('companion이 보고한 출력 해시와 받은 파일이 달라 다운로드하지 않았습니다.');
      const name=file.name.replace(/(\.[^.]+)$/,'-falsify-research$1'),type=file.type||'application/octet-stream';download(output.bytes,name,type);jsonDownload(plan(patches,{outputFileHash,verification:output.verification}),'falsify-document-edit-plan.json');
      exported={outputFileHash,verification:output.verification,file:new File([output.bytes],name,{type})};const final={selected:patches,outputFileHash,verification:output.verification};exported.key=key(final);void save(final);
      exportStatus('실험용 사본과 별도 변경 계획을 다운로드했습니다. '+(pdf?layoutReport(output.verification):'')+(typeof output.verification?.limits==='string'?output.verification.limits.slice(0,400):''));
    }catch(e){if(current===generation)exportStatus('다운로드 차단: '+e.message+recovery(pdf?.kind),true);}
    finally{if(current===generation){busy=false;controls();}}
  });
  // Final snapshot = what the user actually selected/edited; output hash only while the exported bytes still match.
  function finalState(){if(!candidates.some(c=>c.selected))return null;return {selected:C.patches(doc,candidates),outputFileHash:exported?.outputFileHash||null,verification:exported?.verification||null};}
  function key(final){return epoch+':'+JSON.stringify(final);}
  function currentKey(){try{return key(finalState());}catch{return null;}}
  function unrecorded(){return !!response&&(pending.size>0||!saved.has(key(null))||candidates.some(c=>c.selected||c.edited)&&!saved.has(currentKey()));}
  function keepEdits(){return !unrecorded()||confirm('선택·편집한 RED 후보가 아직 기록되지 않았습니다. 계속하면 후보와 편집 내용이 사라집니다. 계속할까요?');}
  function invalidate(){epoch++;exported=null;lastSaved=null;failure=null;saved.clear();pending.clear();}
  function discard(){generation++;cancelCurrent();busy=!!binding;if(doc)doc.revision=crypto.randomUUID();candidates=[];response=null;request=null;invalidate();renderCandidates();}
  function changed(){exported=null;exportStatus('');controls();}
  // One root per execution: a final snapshot first awaits (or retries) the original response save and links to it via snapshotOf.
  // If the original cannot be persisted the final snapshot is not recorded either, so no second root ever appears.
  // isCurrent is live-only: the ledger checks it right before persisting, so a source/settings reset cancels a stale save.
  function save(final){
    if(!doc||!response)return Promise.resolve(null);const k=key(final);
    if(saved.has(k))return Promise.resolve(saved.get(k));if(pending.has(k))return pending.get(k);
    const current=generation,at=epoch,live=()=>current===generation&&at===epoch,state={doc,request,response};
    const job=Promise.resolve().then(async()=>{
      try{const extras={isCurrent:live};
        if(final){const root=await save(null);if(!live())return null;if(!root)throw new Error('원본 모델 응답이 기록되지 않아 최종 선택·편집도 기록하지 않았습니다.');extras.finalState=final;extras.snapshotOf=root;}
        const id=await FalsifyLab.record('red',state.doc,state.request,state.response,state.response.provenance,extras);if(!live())return null;saved.set(k,id);lastSaved=id;return id;}
      catch(e){if(live())failure={key:k,message:e.message};return null;}
      finally{if(live()){pending.delete(k);controls();}}
    });
    pending.set(k,job);failure=null;controls();return job;
  }
  function action(id,copy,after,className){let b=$('#'+id);if(!b){b=document.createElement('button');b.type='button';b.id=id;b.className=className;b.textContent=copy;after.after(b);}return b;}
  function visibleNav(view){return [...document.querySelectorAll('[data-view='+view+']')].find(b=>b.getClientRects().length)||$('[data-view='+view+']');}
  function renderRecord(note=''){
    const status=$('#red-record-status');if(!status)return;const k=currentKey(),id=saved.get(k),base=saved.get(key(null));let text='',error=false;
    if(response){if(pending.size)text='실행 결과를 이 브라우저에 기록하는 중입니다.';
      else if(failure&&(failure.key===null||failure.key===k||failure.key===key(null)&&!base)){error=true;text=failure.key===null?failure.message:'기록되지 않음: '+failure.message+' 결과는 화면에 남아 있습니다. 「RED 실행 결과 기록」으로 다시 시도하세요.';}
      else if(id)text=note+'기록됨 · 실행 '+id.slice(0,8)+(k===key(null)?' · 모델 응답':' · 최종 선택·편집 After 포함')+(exported&&exported.key===k?' · 출력 파일 해시 포함':'')+'. 논문 추출문도 이 브라우저에 보관됩니다.';
      else if(base)text='모델 응답은 실행 '+base.slice(0,8)+'로 기록됨 · 현재 선택·편집은 아직 기록되지 않았습니다. 완성본 다운로드 또는 「RED 실행 결과 기록」으로 저장하세요.';
      else text='아직 기록되지 않았습니다.';}
    status.textContent=text;status.classList.toggle('error',error);
    action('red-evaluate','검수에서 이 실행 평가',status,'text-button').hidden=!lastSaved||!response;
  }
  function renderHandoff(){
    // No handoff while the final snapshot is still being saved; a failed save hands off with an explicitly unrecorded relation.
    const status=$('#red-export-status'),ready=!!exported&&!busy&&exported.key===currentKey()&&!pending.has(exported.key),b=action('red-handoff','이 사본으로 BLUE 실행',status,'button secondary');b.hidden=!ready;
    let note=$('#red-handoff-note');if(!note){note=document.createElement('p');note.id='red-handoff-note';note.className='muted';b.after(note);}note.hidden=!ready;
    if(ready)note.textContent='BLUE에는 이 사본 파일만 전달합니다. 변경 계획·후보·근거는 보내지 않으며, BLUE 동의와 실행은 BLUE 화면에서 따로 합니다.'+(saved.has(exported.key)?'':' 최종 선택이 기록되지 않아 BLUE 결과와 이 RED 실행의 인계 관계는 기록되지 않습니다. 먼저 「RED 실행 결과 기록」으로 다시 시도할 수 있습니다.');
  }
  document.addEventListener('click',e=>{
    if(e.target.closest?.('#red-evaluate')){if(!lastSaved)return;const select=$('#evaluation-run');if(select&&[...select.options].some(o=>o.value===lastSaved)){select.value=lastSaved;select.dispatchEvent(new Event('change'));}visibleNav('review')?.click();}
    if(e.target.closest?.('#red-handoff')){if(!exported||exported.key!==currentKey()||busy||pending.has(exported.key))return;const sourceRunId=saved.get(exported.key)||null;
      // BLUE may cancel the handoff to keep its own running job or unrecorded result.
      if(!document.dispatchEvent(new CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:exported.file,sourceRunId}}))){$('#red-export-status').textContent='BLUE의 진행 중이거나 기록되지 않은 결과를 유지하려고 인계를 취소했습니다.';return;}visibleNav('blue')?.click();}
  });
  // Harness and CLI controls belong to the ledger; guard them in capture phase so a cancelled change never reaches the ledger handler.
  const GUARDED=['red-harness','red-cli-type','red-cli-model','red-cli-effort'];
  function snapshot(){for(const id of GUARDED){const e=$('#'+id);if(e)guard[id]=e.value;}}
  document.addEventListener('change',e=>{const id=e.target?.id;if(!GUARDED.includes(id))return;const field=e.target,previous=guard[id];if(previous!==undefined&&previous!==field.value&&(id!=='red-harness'||[...field.options].some(o=>o.value===previous))&&!keepEdits()){e.stopImmediatePropagation();field.value=previous;}},true);
  FalsifyLab.ready.then(()=>{snapshot();if(B.state().connected)controls();}).catch(()=>{});
  addEventListener('beforeunload',e=>{if(unrecorded()){e.preventDefault();e.returnValue='';}});
})();
