/* Hosted AI execution client. Cloud execution runs on the operator's API key at the server;
   this browser only holds its Falsify login session. No provider key, provider base URL, local path,
   harness JSON or executable is read, prompted for or sent from here.
   Login -> upload PDF -> RED/BLUE + instruction -> one run button -> progress/resume -> results/download.
   The local companion/CLI path stays a separate, optional fallback. */
(function(){
  'use strict';
  const VERSION='1';
  const SESSION_KEY='falsify.hosted-ai.session.v1';
  const UPLOAD_KEY='falsify.hosted-ai.upload.v1';
  const RUNS_KEY='falsify.hosted-ai.runs.v1';
  const RUNS_LIMIT=6;
  const TOKEN_RE=/^fss_[A-Za-z0-9_-]{43}$/;
  const HEADER_TOKEN_RE=/^[\x21-\x7e]{8,4096}$/;
  const TERMINAL_STATES=['cancelled','completed','failed','interrupted'];
  const POLL_DELAYS=[1200,2000,3000,5000,8000,12000];
  const MAX_POLL_FAILURES=6;
  const MAX_PROMPT_FALLBACK=32000;
  const MAX_UPLOAD_FALLBACK=33554432;
  const TIMEOUTS={auth:20000,upload:60000,job:20000,cancel:20000,artifact:120000};
  /* Apply-only jobs carry no model call. The gateway still requires a prompt, so this fixed, deterministic
     instruction is used and hashed with the selection; the user's RED instruction is never resent. */
  const APPLY_PROMPT='Apply the selected RED edits to the uploaded PDF only.';
  const MAX_EDITS=100;
  const MAX_VISUAL_EDITS=12;
  const MAX_JOB_BODY_BYTES=60000;
  const STATE_LABELS={queued:'대기 중',running:'실행 중',cancelling:'취소 중',cancelled:'취소됨',completed:'완료',failed:'실패',interrupted:'중단됨(불완전)'};
  const FAILURE_LABELS={
    auth_required:'서버의 제공자 인증이 필요합니다',
    permission_denied:'서버 계정에 이 실행 권한이 없습니다',
    invalid_request:'요청 형식이 올바르지 않습니다',
    not_found:'작업 또는 파일을 찾지 못했습니다',
    request_too_large:'입력이 서버 한도를 넘습니다',
    payload_too_large:'입력이 서버 한도를 넘습니다',
    unsupported_media_type:'지원하지 않는 파일 형식입니다',
    rate_limited:'호출 한도에 걸렸습니다',
    provider_error:'제공자 오류입니다',
    overloaded:'제공자가 과부하 상태입니다',
    timeout:'시간 제한을 넘겼습니다',
    budget_exhausted:'실행 예산을 모두 썼습니다',
    ai_unavailable:'웹 실행 엔진을 사용할 수 없습니다',
    internal_error:'서버 내부 오류입니다',
    evidence_expired:'구조화 근거가 만료되었습니다',
    evidence_unavailable:'구조화 근거를 사용할 수 없습니다',
    evidence_cancelled:'근거 준비가 취소되었습니다',
    evidence_too_large:'PDF가 구조화 근거 한도를 넘습니다',
    evidence_input_invalid:'PDF를 구조화 근거로 준비하지 못했습니다',
    evidence_extraction_failed:'표·그림 구조화 근거를 추출하지 못했습니다',
    apply_source_mismatch:'업로드된 원본과 RED 원본이 달라 적용하지 않았습니다',
    apply_no_edits:'적용할 변경이 없습니다',
    apply_verify_failed:'수정본 해시·쪽수 검증에 실패해 파일을 만들지 않았습니다',
    apply_edit_incomplete:'선택한 변경 중 일부를 PDF에서 완전히 적용하지 못했습니다',
    apply_edit_invalid:'선택한 텍스트 변경을 적용하지 못했습니다',
    visual_edit_invalid:'선택한 표·그림 변경을 이 PDF에 적용하지 못했습니다',
    visual_edit_kind_unsupported:'이 표·그림 변경 종류는 적용할 수 없습니다'
  };

  function parseBase(value,loopbackOk){
    if(typeof value!=='string'||!value) return '';
    try{
      const url=new URL(value);
      const loop=url.hostname==='127.0.0.1'||url.hostname==='localhost'||url.hostname==='::1'||url.hostname==='[::1]';
      if(url.protocol!=='https:'&&!(loopbackOk&&loop&&url.protocol==='http:')) return '';
      if(url.username||url.password||url.search||url.hash) return '';
      return url.origin+url.pathname.replace(/\/+$/,'');
    }catch{return '';}
  }
  function allowlistedCode(value){return typeof value==='string'&&/^[a-z0-9_]{1,64}$/.test(value)?value:'';}
  function allowlistedId(value){return typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,96}$/.test(value)?value:'';}
  function positiveInt(value){
    const n=Number(value);
    return Number.isFinite(n)&&n>0&&n<=Number.MAX_SAFE_INTEGER?Math.floor(n):0;
  }
  function safeName(value){
    const text=typeof value==='string'?value:'';
    return text.replace(/[\u0000-\u001f\u007f]/g,'').replace(/\s+/g,' ').trim().slice(0,200);
  }
  function sizeLabel(bytes){
    const n=Number(bytes);
    if(!Number.isFinite(n)||n<0) return '크기 정보 없음';
    if(n>=1024*1024) return (n/(1024*1024)).toFixed(1)+' MiB';
    if(n>=1024) return (n/1024).toFixed(1)+' KiB';
    return n+' bytes';
  }
  function codePoints(text){return [...String(text??'')].length;}
  /* The hosted runtime extracts PDFs only (%PDF- magic) and rejects text/plain at execution. */
  function isPdfBytes(bytes){
    return !!bytes&&bytes.byteLength>=5&&bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44
      &&bytes[3]===0x46&&bytes[4]===0x2d;
  }
  /* Mirrors the gateway's editText rejection: a control character would make the whole apply job 400. */
  const CONTROL_CHARS=/[\u0000-\u001f\u007f]/;
  function safeToken(value,maxLength=80){
    return typeof value==='string'&&value.length<=maxLength&&/^[A-Za-z0-9_.:-]+$/.test(value)?value:'';
  }
  /* Hosted extraction segment ids are p<1-based page>-b<1-based block>; the PDF mutator takes 0-based pages. */
  function pageIndexFromSegmentId(segmentId){
    const match=/^p([0-9]{1,6})-b([0-9]{1,6})$/.exec(typeof segmentId==='string'?segmentId:'');
    if(!match) return null;
    const page=Number(match[1]);
    return Number.isSafeInteger(page)&&page>=1?page-1:null;
  }
  function normalizedRationale(edit){
    if(typeof edit.rationale!=='string') return '';
    return edit.rationale.replace(CONTROL_CHARS,' ').replace(/\s+/g,' ').trim();
  }
  function validCount(value,min,max){
    return Number.isSafeInteger(value)&&value>=min&&value<=max;
  }
  function validVisualEdit(itemId,row,column,before,after,rationale){
    if(!itemId||!validCount(row,0,100000)||!validCount(column,0,100000)) return false;
    if(!before||before.length>4000||after.length>4000||after===before) return false;
    if(CONTROL_CHARS.test(before)||CONTROL_CHARS.test(after)) return false;
    return !!rationale&&rationale.length<=3000;
  }
  function parseVisualEdit(edit){
    if(!edit||typeof edit!=='object') return {status:'skip'};
    if(edit.kind!=='table-cell') return {status:edit.kind==='chart-point'?'chart':'skip'};
    const itemId=safeToken(edit.itemId,160);
    const row=Number(edit.row),column=Number(edit.column);
    const before=typeof edit.before==='string'?edit.before:'';
    const after=typeof edit.after==='string'?edit.after:'';
    const rationale=normalizedRationale(edit);
    if(!validVisualEdit(itemId,row,column,before,after,rationale)) return {status:'skip'};
    return {status:'ok',edit:{kind:'table-cell',itemId,row,column,before,after,
      rationale:rationale.slice(0,3000),key:'visual:'+itemId+':'+row+':'+column}};
  }
  function collectVisualEdit(edit,visual,counters){
    const parsed=parseVisualEdit(edit);
    if(parsed.status==='chart'){counters.chartOnly++;return;}
    if(parsed.status!=='ok'){counters.skipped++;return;}
    if(visual.some(entry=>entry.key===parsed.edit.key)) return;
    visual.push(parsed.edit);
  }
  function candidateOccurrence(value){
    if(!Number.isSafeInteger(value)) return 0;
    return validCount(value,0,100000)?value:null;
  }
  function candidateAttackTypes(candidate){
    if(!Array.isArray(candidate.attackTypes)) return [];
    return candidate.attackTypes
      .filter(type=>typeof type==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(type)).slice(0,12);
  }
  function candidateTextRange(before,after){
    if(!before||before.length>4000||after.length>4000||after===before) return false;
    return !CONTROL_CHARS.test(before)&&!CONTROL_CHARS.test(after);
  }
  function parseTextCandidate(candidate,index){
    if(!candidate||typeof candidate!=='object') return null;
    const before=typeof candidate.before==='string'?candidate.before:'';
    const after=typeof candidate.after==='string'?candidate.after:'';
    const pageIndex=pageIndexFromSegmentId(candidate.segmentId);
    if(pageIndex===null||!candidateTextRange(before,after)) return null;
    const occurrence=candidateOccurrence(candidate.occurrence);
    if(occurrence===null) return null;
    const id=safeToken(candidate.id)||('candidate-'+index);
    return {
      key:'text:'+index+':'+id,id,index,pageIndex,segmentId:String(candidate.segmentId),
      before,after,occurrence,attackTypes:candidateAttackTypes(candidate),
      rationale:typeof candidate.rationale==='string'?candidate.rationale.slice(0,2000):''
    };
  }
  function candidateSignature(text,visual,counters){
    return JSON.stringify({
      text:text.map(entry=>[entry.key,entry.pageIndex,entry.occurrence,entry.before,entry.after]),
      visual:visual.map(entry=>[entry.key,entry.before,entry.after]),
      chartOnly:counters.chartOnly,skipped:counters.skipped
    });
  }
  function parseRedCandidates(result){
    const text=[],visual=[],counters={chartOnly:0,skipped:0};
    const source=result&&typeof result==='object'?result:null;
    const topVisuals=source&&Array.isArray(source.visualEdits)?source.visualEdits:[];
    for(const edit of topVisuals) collectVisualEdit(edit,visual,counters);
    const candidates=source&&Array.isArray(source.candidates)?source.candidates:[];
    for(const [index,candidate] of candidates.entries()){
      const nested=candidate&&Array.isArray(candidate.visualEdits)?candidate.visualEdits:[];
      for(const edit of nested) collectVisualEdit(edit,visual,counters);
      const normalized=parseTextCandidate(candidate,index);
      if(normalized) text.push(normalized); else counters.skipped++;
    }
    return {text,visual,chartOnly:counters.chartOnly,skipped:counters.skipped,
      signature:candidateSignature(text,visual,counters)};
  }

  function resolveDomDependencies(options){
    return {
      doc:options.document||document,
      host:options.host||null,
      storage:options.storage||sessionStorage,
      now:options.now||(()=>Date.now()),
      setT:options.setTimeout||((fn,ms)=>setTimeout(fn,ms)),
      clearT:options.clearTimeout||(id=>clearTimeout(id))
    };
  }
  function resolveApiDependencies(options){
    return {
      fetchImpl:options.fetch||((url,init)=>fetch(url,init)),
      cryptoApi:options.crypto||(typeof crypto!=='undefined'?crypto:null),
      UrlApi:options.URL||URL,
      Encoder:options.TextEncoder||TextEncoder,
      Abort:options.AbortController||(typeof AbortController!=='undefined'?AbortController:null),
      configFn:options.config||(()=>(typeof globalThis!=='undefined'?globalThis.FalsifyCloudConfig:undefined)),
      providerFn:options.sessionProvider||(()=>(typeof globalThis!=='undefined'?globalThis.FalsifyHostedSession:undefined))
    };
  }
  function resolveDependencies(options){
    return Object.assign(resolveDomDependencies(options),resolveApiDependencies(options));
  }
  function create(options={}){
    const deps=resolveDependencies(options);
    const {doc,host,storage,now,setT,clearT,fetchImpl,cryptoApi,UrlApi,Encoder,Abort,configFn,providerFn}=deps;

    const state={
      apiBase:'', gate:'checking', disabledMessage:'', status:'', error:'',
      session:null, capabilities:null, restored:false,
      file:null, fileSha:'', fileError:'', upload:null,
      job:null, busy:'', model:'', effort:'', activeDigest:'', jobKind:'review',
      reviewJob:null, reviewUpload:null,
      candidates:[], visualCandidates:[], chartOnly:0, skippedCandidates:0, candidateSignature:'',
      selection:{}, selectionVersion:0,
      editedStatus:'', originalInput:null, blueSource:null, useEvidence:true,
      pollTimer:null, pollAttempt:0, pollFailures:0, downloadStatus:'', timers:new Set()
    };
    const nodes={};
    let readyResolve=null;
    let builtSignature='';
    const ready=new Promise(resolve=>{readyResolve=resolve;});

    function later(fn,ms){const id=setT(()=>{state.timers.delete(id);fn();},ms);state.timers.add(id);return id;}
    function cancelLater(id){if(id===null||id===undefined)return;state.timers.delete(id);clearT(id);}
    function destroy(){for(const id of [...state.timers])cancelLater(id);state.pollTimer=null;}

    function readStore(key){try{return storage.getItem(key);}catch{return null;}}
    function writeStore(key,value){try{storage.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
    function dropStore(key){try{storage.removeItem(key);}catch{}}
    function readJsonStore(key){
      const raw=readStore(key);
      if(!raw)return null;
      try{const data=JSON.parse(raw);return data&&typeof data==='object'?data:null;}catch{return null;}
    }

    function hookPresent(){const provider=providerFn();return !!provider&&typeof provider.token==='function';}
    async function hookToken(){
      const provider=providerFn();
      if(!provider||typeof provider.token!=='function') return '';
      let value=null;
      try{value=await provider.token();}catch{value=null;}
      return typeof value==='string'&&HEADER_TOKEN_RE.test(value)?value:'';
    }

    function storedSession(){
      const data=readJsonStore(SESSION_KEY);
      if(!data) return null;
      if(typeof data.apiBase!=='string'||data.apiBase!==state.apiBase) return null;
      if(typeof data.token!=='string'||!TOKEN_RE.test(data.token)) return null;
      if(data.expiresAt&&Number.isFinite(Date.parse(data.expiresAt))&&Date.parse(data.expiresAt)<=now()) return null;
      return {
        source:'password', token:data.token, apiBase:data.apiBase,
        author:data.author&&typeof data.author==='object'?data.author:null,
        expiresAt:typeof data.expiresAt==='string'?data.expiresAt:''
      };
    }
    function dropSessionStores(){
      dropStore(SESSION_KEY);dropStore(UPLOAD_KEY);dropStore(RUNS_KEY);
    }
    function sessionLabel(){
      const s=state.session;
      if(!s) return '';
      if(s.source==='hook') return '로그인됨(페이지 세션)';
      const author=s.author||{};
      const name=safeName(author.displayName||author.username)||'사용자';
      const user=safeName(author.username);
      return `로그인됨: ${name}${user&&user!==name?` (${user})`:''}`;
    }
    function currentToken(){return state.session?state.session.token:'';}

    async function http(path,opts={}){
      const base=state.apiBase;
      if(!base) throw Object.assign(Error('missing base'),{kind:'config'});
      const headers=Object.assign({},opts.headers||{});
      if(opts.token) headers.Authorization='Bearer '+opts.token;
      const controller=Abort?new Abort():null;
      let timer=null;
      if(controller&&opts.timeout) timer=setT(()=>{try{controller.abort();}catch{}},opts.timeout);
      try{
        return await fetchImpl(base+path,{
          method:opts.method||'GET',headers,body:opts.body,
          signal:controller?controller.signal:undefined,
          credentials:'omit',redirect:'error',cache:'no-store',mode:'cors'
        });
      }catch(e){
        const error=Error('request failed');
        error.kind=e&&e.name==='AbortError'?'timeout':'network';
        throw error;
      }finally{
        if(timer!==null)clearT(timer);
      }
    }
    async function jsonCall(path,opts={}){
      const res=await http(path,opts);
      let data=null;
      try{
        const text=await res.text();
        data=text?JSON.parse(text):null;
      }catch{data=null;}
      if(!res.ok){
        const error=Error('http '+res.status);
        error.status=Number(res.status)||0;
        const detail=data&&data.error&&typeof data.error==='object'?data.error:null;
        error.code=detail?allowlistedCode(detail.code):'';
        error.requestId=detail?allowlistedId(detail.requestId):'';
        error.retryable=!!(detail&&detail.retryable===true);
        throw error;
      }
      if(!data||typeof data!=='object'){
        throw Object.assign(Error('unexpected response'),{kind:'protocol'});
      }
      return data;
    }

    function failureSuffix(error){
      if(!error) return '';
      const parts=[];
      if(error.code) parts.push(error.code);
      if(error.requestId) parts.push('요청 ID '+error.requestId);
      if(error.retryable===true) parts.push('재시도 가능');
      return parts.length?' ('+parts.join(' · ')+')':'';
    }
    function networkText(error){
      if(error&&error.kind==='timeout') return '서버 응답 시간이 초과되었습니다. 자동으로 다시 보내지 않았습니다.';
      if(error&&error.kind==='config') return '웹 실행 서버 주소가 설정되지 않았습니다.';
      if(error&&error.kind==='protocol') return '서버 응답을 해석하지 못했습니다. 자동으로 다시 시도하지 않습니다.';
      return '서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요. 자동으로 다시 보내지 않았습니다.';
    }
    function httpText(error){
      const status=error?error.status:0;
      if(status===401) return '로그인이 필요합니다. 세션이 끝났으면 다시 로그인하세요.';
      if(status===403) return '이 계정에는 이 작업 권한이 없습니다.';
      if(status===404) return '작업 또는 파일을 찾지 못했습니다. 다른 계정의 작업이거나 만료되었습니다.';
      if(status===409) return '같은 요청 키에 다른 내용이 이미 접수되어 있습니다. 다시 보내지 않았습니다. 이전 결과를 확인하거나 새 검토로 시작하세요.';
      if(status===410) return '이 서버는 지금 이 로그인 방식을 받지 않습니다(운영자 설정). 웹 실행 로그인을 설정해야 합니다.';
      if(status===413) return '파일이 서버 크기 한도를 넘습니다.';
      if(status===415) return '지원하지 않는 파일 형식입니다. 웹 실행은 PDF만 지원합니다.';
      if(status===429) return '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.';
      if(status===503) return '웹 실행 엔진이 지금 응답하지 않습니다. 잠시 뒤 다시 시도하거나 로컬 실행을 사용하세요.';
      if(status===400) return '요청이 올바르지 않습니다. 입력을 확인하세요.';
      if(status>=500) return '서버 오류입니다. 자동으로 다시 시도하지 않았습니다.';
      return '요청을 처리하지 못했습니다.';
    }
    function isTransportError(error){
      if(!error) return false;
      return error.kind==='network'||error.kind==='timeout'||error.kind==='config'||error.kind==='protocol';
    }
    function loginFailureText(error){
      if(!error) return '';
      if(error.status===401) return '아이디 또는 비밀번호가 올바르지 않습니다.';
      if(error.code==='membership_required') return '이 계정은 팀 멤버로 승인되지 않았습니다. 운영자에게 확인하세요.';
      if(error.status===410) return '이 서버는 비밀번호 로그인을 받지 않습니다(Confluence 전용 설정일 수 있습니다). 운영자가 웹 실행 로그인을 켜야 합니다.';
      return '';
    }
    function describe(error,context){
      if(error&&error.kind==='local'&&error.message) return String(error.message);
      if(isTransportError(error)) return networkText(error)+failureSuffix(error);
      if(context==='login'){
        const login=loginFailureText(error);
        if(login) return login;
      }
      return httpText(error)+failureSuffix(error);
    }

    function capabilitiesFailure(error){
      const detail=describe(error,'capabilities');
      return `웹 실행 기능을 확인하지 못했습니다. ${detail} 이 패널은 아무 작업도 보내지 않습니다.`;
    }
    function disable(message){
      state.gate='disabled';
      state.disabledMessage=message;
      state.capabilities=null;
      state.status='';
      stopPoll();
    }
    function fail(message){
      state.error=message;
      render();
    }
    function setStatus(message){
      state.status=message;
      render();
    }
    /* A 401 means the Falsify session is no longer valid: end it once, everywhere, instead of leaving a
       signed-in panel. The deterministic key lets the same inputs reload the server job after re-login. */
    function sessionEnded(error){
      if(!error||error.status!==401) return false;
      stopPoll();
      if(state.session&&state.session.source!=='hook') dropSessionStores();
      state.session=null;
      state.gate='ready';
      state.busy='';
      state.downloadStatus='';
      state.editedStatus='';
      /* Owner-scoped in-memory review/apply state belongs to the ended session; do not carry it across
         a re-login. The server keeps the job, and the same inputs derive the same key after re-login. */
      state.job=null;state.jobKind='review';state.upload=null;state.file=null;state.fileSha='';state.fileError='';
      state.originalInput=null;state.blueSource=null;
      resetReview();
      fail('세션이 끝났습니다. 다시 로그인해 주세요.');
      return true;
    }

    function normalizeCapabilities(data){
      if(!data||typeof data!=='object') return null;
      const models=Array.isArray(data.models)?data.models.filter(m=>typeof m==='string'&&/^[A-Za-z0-9._-]{1,64}$/.test(m)).slice(0,20):[];
      const efforts=Array.isArray(data.efforts)?data.efforts.filter(e=>typeof e==='string'&&/^[a-z]{1,16}$/.test(e)).slice(0,12):[];
      const limits=data.limits&&typeof data.limits==='object'?data.limits:{};
      return {
        enabled:data.enabled===true,
        provider:typeof data.provider==='string'?data.provider.slice(0,32):'',
        execution:typeof data.execution==='string'?data.execution.slice(0,32):'',
        models,efforts,
        maxUploadBytes:positiveInt(limits.maxUploadBytes)||MAX_UPLOAD_FALLBACK,
        maxPromptChars:positiveInt(limits.maxPromptChars)||MAX_PROMPT_FALLBACK
      };
    }

    function probeAuthText(error){
      if(!(error&&(error.status===401||error.status===403))) return '';
      if(state.session&&state.session.source!=='hook'){
        dropSessionStores();
        state.session=null;
        return '세션이 끝났습니다. 다시 로그인해 주세요.';
      }
      if(state.session){
        state.session=null;
        return '페이지 로그인 세션을 확인하지 못했습니다. 다시 확인하세요.';
      }
      return '웹 실행이 설정되어 있습니다. 로그인해 주세요.';
    }
    function applyCapabilities(caps){
      state.capabilities=caps;
      state.gate='ready';
      state.model=caps.models.includes(state.model)?state.model:(caps.models[0]||'');
      state.effort=caps.efforts.includes(state.effort)?state.effort
        :(caps.efforts.includes('high')?'high':(caps.efforts[0]||''));
      fillSelect(nodes.model,caps.models,'서버 기본값');
      fillSelect(nodes.effort,caps.efforts,'서버 기본값');
      state.status=state.session?'웹 실행 준비됨.':'웹 실행이 설정되어 있습니다. 로그인하면 실행할 수 있습니다.';
    }
    async function probe(){
      state.capabilities=null;
      state.status='웹 실행 기능을 확인하는 중…';
      state.error='';
      render();
      let data;
      try{
        data=await jsonCall('/v1/ai/capabilities',{token:currentToken(),timeout:TIMEOUTS.auth});
      }catch(error){
        const authText=probeAuthText(error);
        if(authText){
          state.gate='ready';
          state.status=authText;
          render();
          return;
        }
        disable(capabilitiesFailure(error));
        render();
        return;
      }
      const caps=normalizeCapabilities(data);
      if(!caps){
        disable('웹 실행 설정을 확인하지 못했습니다. 운영자 설정을 확인해야 합니다.');
        render();
        return;
      }
      if(caps.enabled!==true){
        disable('이 배포에서는 웹 실행이 켜져 있지 않습니다.');
        render();
        return;
      }
      applyCapabilities(caps);
      render();
    }

    function fillSelect(select,values,emptyLabel){
      if(!select) return;
      select.textContent='';
      if(!values.length){
        select.append(el('option',{value:'',textContent:emptyLabel}));
        select.value='';
        return;
      }
      for(const value of values) select.append(el('option',{value:value,textContent:value}));
      select.value=values.includes(select.value)?select.value:values[0];
    }

    /* ---------- session ---------- */
    async function start(){
      state.gate='checking';
      state.status='웹 실행 상태를 확인하는 중…';
      render();
      let config=null;
      try{config=configFn();}catch{config=null;}
      const hosted=config&&config.hostedAi&&typeof config.hostedAi==='object'?config.hostedAi:null;
      if(!hosted||hosted.enabled!==true){
        disable('이 배포에서는 웹 실행이 켜져 있지 않습니다. 이 패널은 서버로 아무것도 보내지 않습니다.');
        render();
        finish();
        return;
      }
      const base=parseBase(hosted.apiBase,true)||parseBase(config&&config.apiBase,true);
      if(!base){
        disable('웹 실행 서버 주소가 올바른 https 주소가 아닙니다. 운영자 설정을 확인해야 합니다. 이 패널은 서버로 아무것도 보내지 않습니다.');
        render();
        finish();
        return;
      }
      state.apiBase=base;
      if(!(cryptoApi&&cryptoApi.subtle&&typeof cryptoApi.subtle.digest==='function')){
        disable('이 브라우저에서는 웹 실행을 사용할 수 없습니다. https 페이지에서 열어 주세요.');
        render();
        finish();
        return;
      }
      state.session=await resolveSession();
      await probe();
      await restore();
      render();
      finish();
    }
    function finish(){if(readyResolve){readyResolve({state:snapshot()});readyResolve=null;}}

    async function resolveSession(){
      if(hookPresent()){
        const token=await hookToken();
        if(token) return {source:'hook',token,apiBase:state.apiBase,author:null,expiresAt:''};
        return null;
      }
      return storedSession();
    }

    function normalizeAuthor(value){
      if(!value||typeof value!=='object') return null;
      return {
        id:typeof value.id==='string'?value.id.slice(0,64):'',
        username:safeName(value.username),
        displayName:safeName(value.displayName)
      };
    }
    function adoptSession(data){
      const token=typeof data.token==='string'?data.token:'';
      if(!TOKEN_RE.test(token)) throw Object.assign(Error('bad token'),{kind:'protocol'});
      const session={
        source:'password',token,apiBase:state.apiBase,
        author:normalizeAuthor(data.author),
        expiresAt:typeof data.expiresAt==='string'?data.expiresAt:''
      };
      state.session=session;
      state.restored=false;
      writeStore(SESSION_KEY,{apiBase:session.apiBase,token:session.token,
        author:session.author,expiresAt:session.expiresAt});
      return session;
    }
    async function afterSignIn(){
      state.error='';
      await probe();
      await restore();
    }
    function registerInputs(){
      return {
        username:String(nodes.registerUsername.value||'').trim(),
        password:String(nodes.registerPassword.value||''),
        displayName:String(nodes.registerDisplayName.value||'').trim(),
        inviteCode:String(nodes.registerInvite.value||'').trim()
      };
    }
    function registerValidation(input){
      if(!/^[A-Za-z0-9_-]{3,32}$/.test(input.username)){
        return '아이디는 3–32자의 영문·숫자·_·-만 쓸 수 있습니다.';
      }
      const password=[...input.password.normalize('NFC')].length;
      if(password<12||password>128) return '비밀번호는 12자 이상이어야 합니다.';
      if(input.displayName&&[...input.displayName.normalize('NFC')].length>60){
        return '표시 이름은 60자 이하로 입력하세요.';
      }
      if(!input.inviteCode) return '초대 코드를 입력하세요.';
      return '';
    }
    function registerBody(input){
      const body={username:input.username,password:input.password,inviteCode:input.inviteCode};
      if(input.displayName) body.displayName=input.displayName;
      return body;
    }
    function registerFailureText(error){
      const status=error?Number(error.status):0;
      if(status===400||status===401) return '가입 정보를 확인하세요.';
      if(status===403) return '초대 코드가 유효하지 않습니다.';
      if(status===409) return '이미 사용 중인 아이디입니다.';
      if(status===410) return '이 서버는 초대 가입을 받지 않습니다.';
      if(status===429) return '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.';
      if(error&&error.kind) return describe(error,'register');
      return '가입하지 못했습니다. 초대 코드를 확인하세요.';
    }
    function setRegisterStatus(text,isError){
      nodes.registerStatus.textContent=text;
      nodes.registerStatus.className=isError?'form-feedback error':'form-feedback';
    }
    function clearRegisterFields(){
      for(const node of [nodes.registerUsername,nodes.registerPassword,
        nodes.registerDisplayName,nodes.registerInvite]){
        if(node) node.value='';
      }
    }
    async function register(){
      if(state.busy||state.gate==='disabled'||!state.apiBase) return;
      const input=registerInputs();
      const problem=registerValidation(input);
      if(problem){setRegisterStatus(problem,true);return;}
      state.busy='register';state.error='';
      nodes.register.disabled=true;
      setRegisterStatus('계정을 만드는 중…',false);
      try{
        const data=await jsonCall('/v1/auth/register',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify(registerBody(input)),timeout:TIMEOUTS.auth
        });
        adoptSession(data);
        state.status='가입하고 로그인했습니다.';
        clearRegisterFields();
        setRegisterStatus('',false);
        await afterSignIn();
      }catch(error){
        setRegisterStatus(registerFailureText(error),true);
      }finally{
        state.busy='';nodes.register.disabled=false;render();
      }
    }
    async function login(){
      if(state.busy||state.gate==='disabled'||!state.apiBase) return;
      const username=String(nodes.username.value||'').trim();
      const password=String(nodes.password.value||'');
      nodes.password.value='';
      if(!username||!password){fail('아이디와 비밀번호를 입력하세요.');return;}
      state.busy='login';state.error='';state.status='로그인하는 중…';render();
      try{
        const data=await jsonCall('/v1/auth/login',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({username,password}),timeout:TIMEOUTS.auth
        });
        adoptSession(data);
        state.status='로그인했습니다.';
        nodes.username.value='';
        await afterSignIn();
      }catch(error){
        fail(describe(error,'login'));
      }finally{
        state.busy='';nodes.password.value='';render();
      }
    }

    async function logout(){
      if(state.busy) return;
      const session=state.session;
      state.busy='logout';stopPoll();
      try{
        if(session&&session.source!=='hook') await http('/v1/logout',{method:'POST',token:session.token,timeout:TIMEOUTS.auth});
      }catch{}
      finally{
        if(session&&session.source!=='hook') dropSessionStores();
        state.session=null;state.job=null;state.upload=null;state.file=null;state.fileSha='';state.fileError='';
        state.restored=false;state.error='';state.downloadStatus='';state.activeDigest='';
        state.jobKind='review';resetReview();state.originalInput=null;state.blueSource=null;state.editedStatus='';
        if(nodes.file) nodes.file.value='';
        state.busy='';
        state.status=state.gate==='ready'?'로그아웃했습니다.':'로그아웃했습니다.';
        render();
      }
    }

    /* ---------- upload ---------- */
    function maxUpload(){return state.capabilities?state.capabilities.maxUploadBytes:MAX_UPLOAD_FALLBACK;}
    function maxPrompt(){return state.capabilities?state.capabilities.maxPromptChars:MAX_PROMPT_FALLBACK;}
    function selectedValue(node){return node&&typeof node.value==='string'?node.value:'';}

    async function sha256Hex(bytes){
      const digest=await cryptoApi.subtle.digest('SHA-256',bytes);
      return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
    }
    async function digestOf(text){
      const bytes=Encoder?new Encoder().encode(text):Uint8Array.from(text,c=>c.charCodeAt(0));
      return sha256Hex(bytes);
    }

    function readUploadStore(){
      const data=readJsonStore(UPLOAD_KEY);
      if(!data||data.apiBase!==state.apiBase) return null;
      if(typeof data.id!=='string'||!data.id) return null;
      if(typeof data.sha256!=='string'||!/^[0-9a-f]{64}$/.test(data.sha256)) return null;
      return {
        id:data.id,sha256:data.sha256,apiBase:data.apiBase,
        name:safeName(data.name),mime:typeof data.mime==='string'?data.mime.slice(0,64):'',
        bytes:positiveInt(data.bytes),deduplicated:data.deduplicated===true
      };
    }
    function storeUpload(upload){
      writeStore(UPLOAD_KEY,{apiBase:state.apiBase,id:upload.id,sha256:upload.sha256,name:upload.name,mime:upload.mime,bytes:upload.bytes,deduplicated:upload.deduplicated===true});
    }

    function selectedFile(){
      const files=nodes.file&&nodes.file.files?nodes.file.files:[];
      return files&&files[0]?files[0]:null;
    }
    function fileSizeProblem(file,name,limit){
      if(!(Number(file.size)>0)) return (name||'선택한 파일')+'이 비어 있어 업로드할 수 없습니다.';
      if(Number(file.size)>limit) return `${name||'선택한 파일'} 파일이 서버 한도 ${sizeLabel(limit)}(${limit} bytes)를 넘어 업로드하지 않았습니다.`;
      return '';
    }
    function bytesSizeProblem(bytes,limit,name){
      if(bytes.byteLength<=limit) return '';
      return `${name||'선택한 파일'} 파일이 서버 한도 ${sizeLabel(limit)}(${limit} bytes)를 넘어 업로드하지 않았습니다.`;
    }
    function pdfProblem(bytes,name){
      if(isPdfBytes(bytes)) return '';
      return `${name||'선택한 파일'}은 PDF가 아닙니다. 다른 형식은 PDF로 변환하세요.`;
    }
    function setFileProblem(message){
      state.file=null;state.fileSha='';state.fileError=message;
      fail(message);render();
    }
    async function adoptFileHash(bytes){
      state.fileSha=await sha256Hex(bytes);
      const stored=readUploadStore();
      state.upload=stored&&stored.sha256===state.fileSha?stored:null;
      state.status=state.upload?'이미 등록된 파일입니다.':'실행 준비가 되었습니다.';
      state.error='';
      render();
    }
    async function onFile(){
      state.file=null;state.fileSha='';state.fileError='';state.upload=null;state.error='';
      state.blueSource=null;state.editedStatus='';
      const file=selectedFile();
      if(!file){render();return;}
      if(state.gate!=='ready'||!state.capabilities){
        fail('먼저 로그인하고 서버 한도를 확인하세요.');render();return;
      }
      const name=safeName(file.name),limit=maxUpload();
      const problem=fileSizeProblem(file,name,limit);
      if(problem){setFileProblem(problem);return;}
      state.file=file;
      state.status='파일 해시를 계산하는 중…';
      render();
      try{
        const bytes=new Uint8Array(await file.arrayBuffer());
        if(state.file!==file) return;
        const sizeProblem=bytesSizeProblem(bytes,limit,name);
        if(sizeProblem){setFileProblem(sizeProblem);return;}
        const notPdf=pdfProblem(bytes,name);
        if(notPdf){setFileProblem(notPdf);return;}
        await adoptFileHash(bytes);
      }catch(error){
        state.fileSha='';
        fail(describe(error,'upload'));
        render();
      }
    }

    async function postUpload(bytes,mime,name){
      const limit=maxUpload();
      if(bytes.byteLength>limit){
        throw Object.assign(Error('too large'),{kind:'local',message:`파일이 서버 한도 ${sizeLabel(limit)}(${limit} bytes)를 넘어 업로드하지 않았습니다.`});
      }
      const data=await jsonCall('/v1/ai/uploads',{
        method:'POST',token:currentToken(),body:bytes,timeout:TIMEOUTS.upload,
        headers:{'Content-Type':mime,'X-Falsify-File-Name':encodeURIComponent(name)}
      });
      const upload=data.upload&&typeof data.upload==='object'&&typeof data.upload.id==='string'?data.upload:null;
      if(!upload||typeof upload.sha256!=='string'||!/^[0-9a-f]{64}$/.test(upload.sha256)){
        throw Object.assign(Error('bad upload'),{kind:'protocol'});
      }
      return {id:upload.id,sha256:upload.sha256,apiBase:state.apiBase,
        name:safeName(upload.name)||name,mime,
        bytes:positiveInt(upload.bytes)||bytes.byteLength,deduplicated:upload.deduplicated===true};
    }
    async function ensureUpload(){
      /* An upload id restored from the session needs no local file: the server already owns those bytes. */
      if(state.upload&&(!state.fileSha||state.upload.sha256===state.fileSha)) return state.upload;
      const file=state.file;
      if(!file) throw Object.assign(Error('no file'),{kind:'local',message:'검토할 파일을 먼저 고르세요.'});
      if(!state.fileSha) throw Object.assign(Error('no hash'),{kind:'local'});
      const limit=maxUpload();
      if(Number(file.size)>limit){
        throw Object.assign(Error('too large'),{kind:'local',message:`파일이 서버 한도 ${sizeLabel(limit)}(${limit} bytes)를 넘어 업로드하지 않았습니다.`});
      }
      const bytes=new Uint8Array(await file.arrayBuffer());
      if(bytes.byteLength>limit){
        throw Object.assign(Error('too large'),{kind:'local',message:`파일이 서버 한도 ${sizeLabel(limit)}(${limit} bytes)를 넘어 업로드하지 않았습니다.`});
      }
      if(!isPdfBytes(bytes)){
        throw Object.assign(Error('not pdf'),{kind:'local',
          message:'PDF만 지원합니다. 다른 형식은 PDF로 변환하세요.'});
      }
      /* Verified PDF bytes are always declared as PDF; a browser-reported text/plain type would make the
         runtime reject the job at execution even though the bytes are a PDF. */
      const mime='application/pdf';
      const name=safeName(file.name)||'upload.bin';
      const descriptor=await postUpload(bytes,mime,name);
      if(descriptor.sha256!==state.fileSha){
        throw Object.assign(Error('hash mismatch'),{kind:'protocol'});
      }
      state.upload=descriptor;
      storeUpload(descriptor);
      return descriptor;
    }
    function fileLike(bytes,name,mime){
      try{
        if(typeof File==='function') return new File([bytes],name,{type:mime});
      }catch{}
      return {
        name,size:bytes.byteLength,type:mime,
        arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)
      };
    }

    /* ---------- runs / idempotency ---------- */
    function runDigestKey(value){return typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);}
    function runKeyText(value){return typeof value==='string'&&value.length>=8&&value.length<=128;}
    function shortEntryText(value,max){return typeof value==='string'?value.slice(0,max):'';}
    function entryText(value){return typeof value==='string'?value:'';}
    function normalizeRunEntry(digest,entry){
      if(!runDigestKey(digest)||!entry||typeof entry!=='object') return null;
      if(entry.apiBase!==state.apiBase||!runKeyText(entry.key)) return null;
      return {
        apiBase:entry.apiBase,key:entry.key,role:entry.role==='blue'?'blue':'red',
        uploadId:entryText(entry.uploadId),sha256:entryText(entry.sha256),
        jobId:entryText(entry.jobId),pending:entry.pending===true,
        kind:entry.kind==='apply'?'apply':'review',
        reviewJobId:entryText(entry.reviewJobId),
        model:shortEntryText(entry.model,64),effort:shortEntryText(entry.effort,16),
        updatedAt:entryText(entry.updatedAt)
      };
    }
    function readRunsDoc(){
      const data=readJsonStore(RUNS_KEY);
      const runs=data&&data.runs&&typeof data.runs==='object'?data.runs:{};
      const clean={};
      for(const [digest,entry] of Object.entries(runs)){
        const normalized=normalizeRunEntry(digest,entry);
        if(normalized) clean[digest]=normalized;
      }
      return {runs:clean,active:data&&typeof data.active==='string'?data.active:''};
    }

    function saveRun(digest,entry){      const doc=readRunsDoc();
      doc.runs[digest]=Object.assign({},entry,{apiBase:state.apiBase,updatedAt:new Date(now()).toISOString()});
      doc.active=digest;
      const keys=Object.keys(doc.runs);
      if(keys.length>RUNS_LIMIT){
        keys.sort((a,b)=>String(doc.runs[a].updatedAt).localeCompare(String(doc.runs[b].updatedAt)));
        for(const key of keys.slice(0,keys.length-RUNS_LIMIT)) delete doc.runs[key];
      }
      writeStore(RUNS_KEY,{runs:doc.runs,active:doc.active});
    }
    function activateRun(digest){
      const doc=readRunsDoc();
      if(!doc.runs[digest]) return;
      writeStore(RUNS_KEY,{runs:doc.runs,active:digest});
    }
    /* A 404 means this owner has no such job any more. Forget only the job binding so the next explicit
       run may submit again with the same key; the key itself is kept (an unrecorded key replays safely). */
    function clearActiveJob(digest){
      if(!digest) return;
      const doc=readRunsDoc();
      const entry=doc.runs[digest];
      if(!entry) return;
      entry.jobId='';
      entry.pending=false;
      writeStore(RUNS_KEY,{runs:doc.runs,active:doc.active});
    }
    function resetReview(){
      resetCandidates();
      state.reviewUpload=null;
    }
    function resetCandidates(){
      state.reviewJob=null;
      state.candidates=[];state.visualCandidates=[];state.chartOnly=0;state.skippedCandidates=0;state.candidateSignature='';
      state.selection={};state.selectionVersion++;
      builtSignature='';
    }
    function adoptReview(job){
      state.reviewJob=job;
      const parsed=parseRedCandidates(job&&job.result);
      state.candidates=parsed.text;
      state.visualCandidates=parsed.visual;
      state.chartOnly=parsed.chartOnly;
      state.skippedCandidates=parsed.skipped;
      state.candidateSignature=parsed.signature;
      state.selection={};
      state.selectionVersion++;
      builtSignature='';
    }
    function reviewUploadDescriptor(entry,upload){
      if(upload&&upload.sha256&&(!entry.sha256||upload.sha256===entry.sha256)) return upload;
      if(!entry.uploadId) return null;
      return {id:entry.uploadId,sha256:entry.sha256||'',apiBase:state.apiBase,
        name:safeName(upload&&upload.name)||'',mime:'application/pdf',bytes:positiveInt(upload&&upload.bytes),deduplicated:true};
    }

    /* ---------- run / submit ---------- */
    function reviewInputs(){
      const role=nodes.role.value==='blue'?'blue':'red';
      const prompt=String(nodes.prompt.value||'').normalize('NFC').trim();
      return {
        role,prompt,
        model:selectedValue(nodes.model)||state.model,
        effort:selectedValue(nodes.effort)||state.effort,
        useEvidence:state.useEvidence===true
      };
    }
    function reviewInputProblem(prompt){
      const max=maxPrompt();
      if(!prompt) return '검토 지시를 입력하세요.';
      if(codePoints(prompt)>max) return `검토 지시가 서버 한도 ${max}자를 넘습니다.`;
      if(!state.file&&!state.upload) return state.fileError||'검토할 파일을 먼저 고르세요.';
      if(state.job&&!TERMINAL_STATES.includes(state.job.state)){
        return '이미 실행 중인 작업이 있습니다. 완료·취소·중단된 뒤에 새 작업을 실행할 수 있습니다.';
      }
      return '';
    }
    function reviewKeyInput(role,upload,input){
      return `${role}\n${upload.id}\n${input.prompt}\n${input.model}\n${input.effort}\n`
        +`${input.useEvidence?'evidence':'no-evidence'}`;
    }
    function reviewBody(role,input,upload,key){
      const body={role,prompt:input.prompt,uploadId:upload.id,idempotencyKey:key,
        useEvidence:input.useEvidence};
      if(input.model) body.model=input.model;
      if(input.effort) body.effort=input.effort;
      return body;
    }
    function saveReviewRun(digest,input,upload,jobId,pending){
      saveRun(digest,{
        key:'fssjob-'+digest.slice(0,40),role:input.role,uploadId:upload.id,
        sha256:upload.sha256,jobId:jobId||'',pending:pending===true,kind:'review',
        model:input.model,effort:input.effort
      });
    }
    async function submitReviewJob(body){
      const data=await jsonCall('/v1/ai/jobs',{
        method:'POST',token:currentToken(),headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body),timeout:TIMEOUTS.job
      });
      const job=data.job&&typeof data.job==='object'?data.job:null;
      if(!job||typeof job.id!=='string'||!job.id) throw Object.assign(Error('bad job'),{kind:'protocol'});
      return {job,replayed:data.replayed===true};
    }
    async function pendingReviewDigest(digest,input,upload){
      if(digest) return digest;
      const known=upload||state.upload;
      return known?await digestOf(reviewKeyInput(input.role,known,input)):'';
    }
    async function handleReviewFailure(error,digest,input,upload){
      if(sessionEnded(error)) return;
      if(error&&error.kind==='local'&&error.message){fail(error.message);return;}
      if(error&&(error.kind==='network'||error.kind==='timeout')){
        try{
          const nextDigest=await pendingReviewDigest(digest,input,upload);
          const known=upload||state.upload;
          if(nextDigest&&known) saveReviewRun(nextDigest,input,known,'',true);
        }catch{}
        fail('제출 응답을 확인하지 못했습니다. 자동으로 다시 보내지 않았습니다. 같은 입력으로 다시 실행하면 기존 요청 키를 재사용합니다.');
        return;
      }
      fail(describe(error,'submit'));
    }
    async function run(){
      if(state.busy||state.gate!=='ready'||!state.session||!state.capabilities) return;
      const input=reviewInputs();
      const problem=reviewInputProblem(input.prompt);
      if(problem){fail(problem);return;}
      state.busy='upload';state.error='';state.downloadStatus='';state.editedStatus='';
      setStatus('파일을 서버에 등록하는 중…');
      let upload=null,digest='';
      try{
        upload=await ensureUpload();
        digest=await digestOf(reviewKeyInput(input.role,upload,input));
        state.activeDigest=digest;
        const key='fssjob-'+digest.slice(0,40);
        state.jobKind='review';
        if(input.role==='red') state.reviewUpload=upload;
        const existing=readRunsDoc().runs[digest];
        if(existing&&existing.jobId&&!existing.pending){
          activateRun(digest);
          state.status='이미 접수한 작업을 다시 불러옵니다. 새 호출은 없습니다.';
          render();
          state.busy='';
          await refreshJob(existing.jobId);
          return;
        }
        state.busy='submit';
        setStatus('작업을 접수하는 중…');
        const body=reviewBody(input.role,input,upload,key);
        const {job,replayed}=await submitReviewJob(body);
        saveReviewRun(digest,input,upload,job.id,false);
        state.busy='';
        if(input.role==='red') resetCandidates();
        applyJob(job,{replayed});
      }catch(error){
        await handleReviewFailure(error,digest,input,upload);
      }finally{
        state.busy='';render();
      }
    }

    /* ---------- RED selection -> apply-only job ---------- */
    function selectedEntries(){
      const text=[],visual=[];
      for(const candidate of state.candidates){
        if(state.selection[candidate.key]) text.push(candidate);
      }
      for(const edit of state.visualCandidates){
        if(state.selection[edit.key]) visual.push(edit);
      }
      return {text,visual};
    }
    function buildApplyEdits(selected){
      const edits=[],seen=new Set();
      for(const candidate of selected.text){
        const key=[candidate.pageIndex,candidate.occurrence,candidate.before,candidate.after].join('\u0000');
        if(seen.has(key)) continue;
        seen.add(key);
        edits.push({pageIndex:candidate.pageIndex,before:candidate.before,after:candidate.after,occurrence:candidate.occurrence});
      }
      const visualEdits=[],visualSeen=new Set();
      for(const edit of selected.visual){
        const key=[edit.itemId,edit.row,edit.column,edit.before,edit.after].join('\u0000');
        if(visualSeen.has(key)) continue;
        visualSeen.add(key);
        visualEdits.push({kind:'table-cell',itemId:edit.itemId,row:edit.row,column:edit.column,
          before:edit.before,after:edit.after,rationale:edit.rationale});
      }
      return {edits,visualEdits};
    }
    function applyBlocker(){
      const review=state.reviewJob;
      if(!review) return '먼저 RED 검토를 완료해 후보를 받으세요.';
      if(review.state!=='completed') return 'RED 검토가 완료된 뒤에 적용할 수 있습니다.';
      if(!state.candidates.length&&!state.visualCandidates.length) return '적용할 수 있는 후보가 없습니다.';
      if(state.job&&!TERMINAL_STATES.includes(state.job.state)) return '진행 중인 작업이 끝난 뒤 적용할 수 있습니다.';
      const reviewUpload=state.reviewUpload;
      if(!reviewUpload||!reviewUpload.id) return 'RED 원본 업로드를 찾지 못했습니다. RED 검토를 다시 불러오세요.';
      if(state.upload&&state.upload.id!==reviewUpload.id) return '현재 입력이 RED 원본과 다릅니다. 원본 파일을 다시 고르거나 「원본 입력으로 돌아가기」를 누른 뒤 적용하세요.';
      if(state.fileSha&&reviewUpload.sha256&&state.fileSha!==reviewUpload.sha256) return '선택한 파일이 RED 원본과 다릅니다. RED 원본을 다시 고르거나 「원본 입력으로 돌아가기」를 누른 뒤 적용하세요.';
      if(!Object.keys(state.selection).length) return '적용할 후보를 선택하세요.';
      return '';
    }
    function resolvedChoice(node,stateValue){
      return selectedValue(node)||stateValue;
    }
    function applyKeyInput(reviewUpload,model,effort,edits,visualEdits){
      return 'apply\nred\n'+reviewUpload.id+'\n'+APPLY_PROMPT+'\n'+model+'\n'+effort
        +'\n'+JSON.stringify({edits,visualEdits});
    }
    function applyBody(reviewUpload,key,model,effort,edits,visualEdits){
      const body={
        role:'red',prompt:APPLY_PROMPT,uploadId:reviewUpload.id,idempotencyKey:key,
        applyOnly:true,edits,visualEdits,
        useEvidence:visualEdits.length>0
      };
      if(model) body.model=model;
      if(effort) body.effort=effort;
      return body;
    }
    function serializedBodySize(body){
      const serialized=JSON.stringify(body);
      const bytes=Encoder?new Encoder().encode(serialized).byteLength:serialized.length;
      if(bytes>MAX_JOB_BODY_BYTES){
        throw Object.assign(Error('job body too large'),{kind:'local',
          message:'선택한 변경이 한 요청 크기 한도(약 60KB)를 넘습니다. 일부 후보만 선택해 다시 적용하세요.'});
      }
      return serialized;
    }
    function applySelectionProblem(edits,visualEdits){
      if(!edits.length&&!visualEdits.length) return '적용할 후보를 선택하세요.';
      if(edits.length>MAX_EDITS||visualEdits.length>MAX_VISUAL_EDITS){
        return '선택한 변경이 서버 한도를 넘습니다. 일부만 선택하세요.';
      }
      return '';
    }
    function saveApplyRun(digest,review,reviewUpload,model,effort,jobId,pending){
      saveRun(digest,{
        key:'fssjob-'+digest.slice(0,40),role:'red',uploadId:reviewUpload.id,
        sha256:reviewUpload.sha256,jobId:jobId||'',pending:pending===true,kind:'apply',
        reviewJobId:review.id,model,effort
      });
    }
    async function submitApplyJob(serialized){
      const data=await jsonCall('/v1/ai/jobs',{method:'POST',token:currentToken(),
        headers:{'Content-Type':'application/json'},body:serialized,timeout:TIMEOUTS.job});
      const job=data.job&&typeof data.job==='object'?data.job:null;
      if(!job||typeof job.id!=='string'||!job.id) throw Object.assign(Error('bad job'),{kind:'protocol'});
      return {job,replayed:data.replayed===true};
    }
    async function handleApplyFailure(error,digest,review,reviewUpload,model,effort){
      if(sessionEnded(error)) return;
      const network=error&&(error.kind==='network'||error.kind==='timeout');
      if(network){
        try{ if(digest) saveApplyRun(digest,review,reviewUpload,model,effort,'',true); }catch{}
        fail('적용 제출 응답을 확인하지 못했습니다. 자동으로 다시 보내지 않았습니다. 같은 후보 선택으로 다시 적용하면 기존 요청 키를 재사용합니다.');
        return;
      }
      fail(describe(error,'apply'));
    }
    async function applySelection(){
      if(state.busy||state.gate!=='ready'||!state.session||!state.capabilities) return;
      const blocker=applyBlocker();
      if(blocker){fail(blocker);return;}
      const {edits,visualEdits}=buildApplyEdits(selectedEntries());
      const selectionProblem=applySelectionProblem(edits,visualEdits);
      if(selectionProblem){fail(selectionProblem);return;}
      const review=state.reviewJob,reviewUpload=state.reviewUpload;
      const model=resolvedChoice(nodes.model,state.model);
      const effort=resolvedChoice(nodes.effort,state.effort);
      state.busy='apply';state.error='';state.editedStatus='';
      setStatus('선택한 변경을 PDF에 적용하는 작업을 접수하는 중…');
      render();
      let digest='';
      try{
        digest=await digestOf(applyKeyInput(reviewUpload,model,effort,edits,visualEdits));
        state.activeDigest=digest;
        const key='fssjob-'+digest.slice(0,40);
        const existing=readRunsDoc().runs[digest];
        if(existing&&existing.jobId&&!existing.pending){
          activateRun(digest);
          state.jobKind='apply';
          state.status='이미 접수한 적용 작업을 다시 불러옵니다.';
          render();
          state.busy='';
          await refreshJob(existing.jobId);
          return;
        }
        const body=applyBody(reviewUpload,key,model,effort,edits,visualEdits);
        const serialized=serializedBodySize(body);
        const {job,replayed}=await submitApplyJob(serialized);
        saveApplyRun(digest,review,reviewUpload,model,effort,job.id,false);
        state.jobKind='apply';
        state.busy='';
        applyJob(job,{replayed});
        state.status='선택한 변경을 적용하는 작업을 접수했습니다. 완료되면 수정본 PDF를 BLUE로 넘길 수 있습니다.';
      }catch(error){
        await handleApplyFailure(error,digest,review,reviewUpload,model,effort);
      }finally{
        state.busy='';render();
      }
    }

    /* ---------- job ---------- */
    function updatePollState(poll){
      if(TERMINAL_STATES.includes(state.job.state)){
        stopPoll();
        state.pollAttempt=0;
        if(state.jobKind==='review'&&state.job.role==='red') adoptReview(state.job);
        return;
      }
      schedulePoll();
    }
    function handlePollFailure(error){
      state.pollFailures++;
      if(error&&error.status===404){
        stopPoll();
        state.job=null;
        clearActiveJob(state.activeDigest);
        fail(describe(error,'job')+' 같은 파일·역할·지시·모델·강도로 다시 실행하면 접수 기록을 새로 확인합니다.');
        return;
      }
      if(state.pollFailures>=MAX_POLL_FAILURES){
        stopPoll();
        fail('작업 상태를 확인하지 못했습니다. 「상태 새로고침」으로 다시 확인하세요.');
        return;
      }
      if(state.job&&!TERMINAL_STATES.includes(state.job.state)) schedulePoll();
      state.status='작업 상태를 확인하지 못해 다시 확인합니다.';
    }
    async function refreshJob(id,opts={}){
      if(!state.session||!id) return;
      const poll=opts.poll===true;
      if(!poll){state.busy='refresh';state.error='';render();}
      try{
        const data=await jsonCall('/v1/ai/jobs/'+encodeURIComponent(id),{token:currentToken(),timeout:TIMEOUTS.job});
        if(!data.job||typeof data.job.id!=='string') throw Object.assign(Error('bad job'),{kind:'protocol'});
        state.pollFailures=0;
        state.job=data.job;
        if(!poll) state.status='작업 상태를 새로 불러왔습니다.';
        updatePollState(poll);
      }catch(error){
        if(sessionEnded(error)) return;
        handlePollFailure(error);
      }finally{
        if(!poll){state.busy='';}
        render();
      }
    }

    function schedulePoll(){
      if(state.pollTimer) return;
      const delay=POLL_DELAYS[Math.min(state.pollAttempt,POLL_DELAYS.length-1)];
      state.pollAttempt++;
      state.pollTimer=later(()=>{
        state.pollTimer=null;
        const id=state.job?state.job.id:'';
        if(id&&state.session) refreshJob(id,{poll:true});
      },delay);
    }
    function stopPoll(){
      if(state.pollTimer){cancelLater(state.pollTimer);state.pollTimer=null;}
      state.pollAttempt=0;
    }
    function applyJob(job,opts={}){
      if(!job||typeof job.id!=='string'||!job.id) return;
      stopPoll();
      state.job=job;
      state.pollFailures=0;
      state.status=opts.replayed===true
        ?'이미 접수된 작업을 다시 불러왔습니다.'
        :'작업이 접수되었습니다. 진행 상태를 계속 확인합니다.';
      if(!TERMINAL_STATES.includes(job.state)) schedulePoll();
      else if(state.jobKind==='review'&&job.role==='red') adoptReview(job);
      render();
    }
    async function cancel(){
      if(state.busy||!state.session||!state.job) return;
      if(TERMINAL_STATES.includes(state.job.state)) return;
      state.busy='cancel';state.error='';
      try{
        const data=await jsonCall('/v1/ai/jobs/'+encodeURIComponent(state.job.id)+'/cancel',{method:'POST',token:currentToken(),timeout:TIMEOUTS.cancel});
        const job=data.job&&typeof data.job==='object'?data.job:null;
        if(!job||typeof job.id!=='string') throw Object.assign(Error('bad job'),{kind:'protocol'});
        state.job=job;
        state.status='취소를 요청했습니다. 이미 시작한 호출은 끝난 뒤 결과가 버려집니다.';
        if(TERMINAL_STATES.includes(job.state)){stopPoll();state.pollAttempt=0;}else{schedulePoll();}
      }catch(error){
        if(sessionEnded(error)) return;
        fail(describe(error,'cancel'));
      }finally{
        state.busy='';render();
      }
    }

    /* ---------- artifacts ---------- */
    async function downloadArtifact(artifact){
      if(!state.session||!state.job||!artifact||typeof artifact.id!=='string') return;
      state.busy='download';state.downloadStatus='결과 파일을 내려받는 중…';state.error='';
      render();
      try{
        const blob=await artifactBlob(state.job.id,artifact);
        const href=UrlApi.createObjectURL(blob);
        const anchor=doc.createElement('a');
        anchor.href=href;
        anchor.download=safeName(artifact.name)||'result.bin';
        anchor.rel='noopener';
        anchor.hidden=true;
        anchor.click();
        const rid=later(()=>{try{UrlApi.revokeObjectURL(href);}catch{}},30000);
        state.downloadStatus='결과 파일을 내려받았습니다: '+safeName(artifact.name)+'.';
        void rid;
      }catch(error){
        if(sessionEnded(error)) return;
        state.downloadStatus='';
        fail(describe(error,'artifact'));
      }finally{
        state.busy='';render();
      }
    }
    async function artifactBlob(jobId,artifact){
      const res=await http('/v1/ai/jobs/'+encodeURIComponent(jobId)+'/artifacts/'+encodeURIComponent(artifact.id),{
        token:currentToken(),timeout:TIMEOUTS.artifact
      });
      if(!res.ok){
        const error=Error('http '+res.status);
        error.status=Number(res.status)||0;
        throw error;
      }
      return res.blob();
    }
    function editedArtifact(){
      const job=state.job;
      if(!job||!Array.isArray(job.artifacts)) return null;
      return job.artifacts.find(artifact=>artifact&&typeof artifact.id==='string'
        &&(artifact.name==='edited.pdf'
          ||(typeof artifact.mime==='string'&&artifact.mime==='application/pdf')))||null;
    }

    /* ---------- edited PDF -> BLUE input ---------- */
    function canHandoff(){
      return !state.busy&&state.gate==='ready'&&!!state.session&&!!state.capabilities;
    }
    async function editedHandoffBytes(job,artifact){
      const blob=await artifactBlob(job.id,artifact);
      const bytes=new Uint8Array(await blob.arrayBuffer());
      if(!bytes.byteLength){
        throw Object.assign(Error('empty'),{kind:'local',message:'수정본 파일이 비어 있습니다.'});
      }
      const sha=await sha256Hex(bytes);
      const recorded=typeof artifact.sha256==='string'?artifact.sha256:'';
      if(recorded&&recorded!==sha) throw Object.assign(Error('artifact hash mismatch'),{kind:'protocol'});
      const name=safeName(artifact.name)||('edited-'+sha.slice(0,8)+'.pdf');
      return {bytes,sha,name};
    }
    function rememberOriginalInput(){
      if(state.originalInput) return;
      state.originalInput={file:state.file,fileSha:state.fileSha,upload:state.upload||state.reviewUpload};
    }
    async function registerBlueInput(job,artifact,payload){
      const upload=await postUpload(payload.bytes,'application/pdf',payload.name);
      if(upload.sha256!==payload.sha) throw Object.assign(Error('upload hash mismatch'),{kind:'protocol'});
      rememberOriginalInput();
      state.file=fileLike(payload.bytes,payload.name,'application/pdf');
      state.fileSha=payload.sha;
      state.upload=upload;
      storeUpload(upload);
      state.blueSource={applyJobId:job.id,artifactId:artifact.id,sha256:payload.sha};
      if(nodes.role) nodes.role.value='blue';
      if(nodes.prompt) nodes.prompt.value='';
      state.editedStatus='수정본을 BLUE 입력으로 등록했습니다. BLUE 검토 지시를 입력하고 실행하세요.';
      state.status='BLUE 입력이 준비되었습니다.';
    }
    async function handoffToBlue(){
      if(!canHandoff()) return;
      const job=state.job;
      const artifact=editedArtifact();
      if(!job||!artifact){fail('BLUE로 넘길 수정본 PDF가 없습니다.');return;}
      state.busy='handoff';state.error='';state.editedStatus='수정본을 불러와 BLUE 입력으로 등록하는 중…';
      render();
      try{
        const payload=await editedHandoffBytes(job,artifact);
        await registerBlueInput(job,artifact,payload);
      }catch(error){
        if(sessionEnded(error)) return;
        state.editedStatus='';
        fail(describe(error,'handoff'));
      }finally{
        state.busy='';render();
      }
    }

    function restoreOriginalInput(){
      if(state.busy||!state.originalInput) return;
      const original=state.originalInput;
      state.file=original.file;state.fileSha=original.fileSha;state.upload=original.upload;
      if(original.upload) storeUpload(original.upload);
      state.originalInput=null;
      state.blueSource=null;
      state.editedStatus='원본 입력으로 돌아왔습니다.';
      state.status='원본 입력으로 돌아왔습니다.';
      if(nodes.role) nodes.role.value='red';
      if(nodes.prompt) nodes.prompt.value='';
      state.error='';
      render();
    }

    /* ---------- restore ---------- */
    function activeRunEntry(){
      const doc=readRunsDoc();
      const digest=doc.active;
      const entry=digest&&doc.runs[digest]?doc.runs[digest]:null;
      return {digest,entry};
    }
    async function restoreApplyEntry(entry,upload){
      state.jobKind='apply';
      state.reviewUpload=reviewUploadDescriptor(entry,upload);
      if(upload) state.upload=upload;
      if(typeof entry.jobId!=='string'||!entry.jobId){
        if(entry.pending===true){
          state.status='이전 적용 제출의 접수 여부를 확인하지 못했습니다. 같은 후보 선택으로 다시 적용하면 기존 요청 키를 재사용합니다.';
          render();
        }
        return;
      }
      state.status='이전 적용 작업을 불러오는 중…';
      render();
      await refreshJob(entry.jobId);
      const artifact=editedArtifact();
      if(artifact&&upload&&artifact.sha256===upload.sha256){
        state.blueSource={applyJobId:entry.jobId,artifactId:artifact.id,sha256:upload.sha256};
      }
      if(entry.reviewJobId) await restoreReview(entry.reviewJobId);
    }
    async function restoreReviewEntry(entry,upload){
      state.jobKind='review';
      state.reviewUpload=reviewUploadDescriptor(entry,upload);
      if(upload&&(!entry.sha256||upload.sha256===entry.sha256)) state.upload=upload;
      if(typeof entry.jobId==='string'&&entry.jobId){
        state.status='이전 작업을 불러오는 중…';
        render();
        await refreshJob(entry.jobId);
        return;
      }
      if(entry.pending===true){
        state.status='이전 제출의 접수 여부를 확인하지 못했습니다. 같은 파일·역할·지시·모델·강도·근거 설정으로 다시 실행하면 같은 요청 키를 재사용하므로 새 유료 호출 없이 기존 작업을 확인합니다.';
        render();
      }
    }
    async function restore(){
      if(state.gate!=='ready'||!state.session||!state.capabilities||state.restored) return;
      state.restored=true;
      const {digest,entry}=activeRunEntry();
      if(!entry) return;
      state.activeDigest=digest;
      const upload=readUploadStore();
      if(entry.kind==='apply') return restoreApplyEntry(entry,upload);
      return restoreReviewEntry(entry,upload);
    }

    /* The RED review that produced the candidates is a free owner-scoped read; it never starts work. */
    async function restoreReview(jobId){
      try{
        const data=await jsonCall('/v1/ai/jobs/'+encodeURIComponent(jobId),{token:currentToken(),timeout:TIMEOUTS.job});
        if(data.job&&typeof data.job.id==='string'&&data.job.role==='red') adoptReview(data.job);
      }catch{}
    }

    /* ---------- rendering ---------- */
    function elementProperty(key){
      return key==='hidden'||key==='disabled'||key==='checked'||key==='value'||key==='id'||key==='type';
    }
    function setElementProp(node,key,value){
      if(key==='textContent'){node.textContent=String(value);return;}
      if(key==='className'){node.className=String(value);return;}
      if(elementProperty(key)){node[key]=value;return;}
      node.setAttribute(key,String(value));
    }
    function el(tag,props,...kids){
      const node=doc.createElement(tag);
      for(const [key,value] of Object.entries(props||{})){
        if(value===undefined||value===null||value===false) continue;
        setElementProp(node,key,value);
      }
      for(const kid of kids){
        if(kid===null||kid===undefined||kid===false) continue;
        node.append(kid);
      }
      return node;
    }

    function build(){
      if(!host) return;
      host.textContent='';
      host.append(
        el('div',{className:'step-head'},
          el('span',{className:'step-code','aria-hidden':'true',textContent:'AI'}),
          el('div',{},
            el('h2',{id:'hosted-ai-title',textContent:'웹 실행'}),
            el('p',{id:'hosted-ai-intro',className:'muted',textContent:'로그인 → PDF → 검토 지시 → 실행 → 후보 선택 → 수정본 적용 → BLUE 순서로 진행합니다.'}))),
        el('p',{id:'hosted-ai-status',className:'form-feedback',role:'status','aria-live':'polite'}),
        el('p',{id:'hosted-ai-error',className:'form-feedback error',role:'alert',hidden:true}));

      const loginForm=el('form',{id:'hosted-ai-login-form',className:'hosted-ai-login',hidden:true,novalidate:'true'},
        el('h3',{textContent:'로그인'}),
        el('p',{className:'muted',textContent:'Falsify 계정으로 로그인합니다.'}),
        el('label',{for:'hosted-ai-username'},'아이디',
          el('input',{id:'hosted-ai-username',type:'text',autocomplete:'username',maxlength:'200',spellcheck:'false'})),
        el('label',{for:'hosted-ai-password'},'비밀번호',
          el('input',{id:'hosted-ai-password',type:'password',autocomplete:'current-password',maxlength:'256'})),
        el('div',{className:'button-row'},
          el('button',{id:'hosted-ai-login',type:'button',className:'button primary',textContent:'로그인'})));
      loginForm.addEventListener('submit',event=>{if(event&&event.preventDefault)event.preventDefault();login();});
      const registerPanel=el('details',{id:'hosted-ai-register-panel',className:'red-help hosted-ai-register',hidden:true},
        el('summary',{textContent:'초대 코드로 계정 만들기'}),
        el('label',{for:'hosted-ai-register-username'},'아이디',
          el('input',{id:'hosted-ai-register-username',type:'text',autocomplete:'username',maxlength:'32',spellcheck:'false'})),
        el('label',{for:'hosted-ai-register-password'},'비밀번호 (12자 이상)',
          el('input',{id:'hosted-ai-register-password',type:'password',autocomplete:'new-password',maxlength:'128'})),
        el('label',{for:'hosted-ai-register-display-name'},'표시 이름 (선택)',
          el('input',{id:'hosted-ai-register-display-name',type:'text',autocomplete:'nickname',maxlength:'60'})),
        el('label',{for:'hosted-ai-register-invite'},'초대 코드',
          el('input',{id:'hosted-ai-register-invite',type:'password',autocomplete:'off',spellcheck:'false',maxlength:'128'})),
        el('div',{className:'button-row'},
          el('button',{id:'hosted-ai-register',type:'button',className:'button primary',textContent:'계정 만들기'})),
        el('p',{id:'hosted-ai-register-status',className:'form-feedback',role:'status','aria-live':'polite'}));

      const sessionRow=el('div',{id:'hosted-ai-session',className:'hosted-ai-session',hidden:true},
        el('p',{id:'hosted-ai-session-text'}),
        el('button',{id:'hosted-ai-logout',type:'button',className:'text-button',textContent:'로그아웃'}));

      const externalBox=el('div',{id:'hosted-ai-external',hidden:true},
        el('p',{className:'muted',textContent:'페이지 로그인이 필요합니다. 로그인한 뒤 다시 확인하세요.'}),
        el('div',{className:'button-row'},
          el('button',{id:'hosted-ai-recheck',type:'button',className:'button secondary',textContent:'로그인 상태 다시 확인'})));

      const disabledBox=el('div',{id:'hosted-ai-disabled',hidden:true},
        el('p',{id:'hosted-ai-disabled-message'}),
        el('p',{className:'muted',textContent:'선택 사항인 로컬 실행은 「로컬 실행 연결」을 참고하세요. 이 패널은 서버로 아무 작업도 보내지 않습니다.'}));

      const configBox=el('div',{id:'hosted-ai-config',hidden:true},
        el('label',{for:'hosted-ai-file'},'검토할 논문 파일 (PDF)',
          el('input',{id:'hosted-ai-file',type:'file',accept:'.pdf,application/pdf'})),
        el('p',{id:'hosted-ai-file-status',className:'muted',textContent:'아직 파일을 고르지 않았습니다.'}),
        el('p',{id:'hosted-ai-file-hint',className:'muted',textContent:'PDF만 지원합니다. 다른 형식은 PDF로 변환하세요.'}),
        el('div',{className:'button-row',id:'hosted-ai-input-actions',hidden:true},
          el('button',{id:'hosted-ai-restore-original',type:'button',className:'text-button',textContent:'원본 입력으로 돌아가기'})),
        el('div',{className:'hosted-ai-grid'},
          el('label',{for:'hosted-ai-role'},'역할',
            el('select',{id:'hosted-ai-role'},
              el('option',{value:'red',textContent:'RED · 결함 주입'}),
              el('option',{value:'blue',textContent:'BLUE · 결함 검증'})))),
        el('details',{className:'red-help hosted-ai-advanced',id:'hosted-ai-advanced'},
          el('summary',{textContent:'고급 설정 · 구조화 근거'}),
          el('div',{className:'hosted-ai-grid'},
            el('label',{for:'hosted-ai-model'},'모델',el('select',{id:'hosted-ai-model'})),
            el('label',{for:'hosted-ai-effort'},'추론 강도',el('select',{id:'hosted-ai-effort'}))),
          el('label',{className:'check-row',for:'hosted-ai-use-evidence'},
            el('input',{id:'hosted-ai-use-evidence',type:'checkbox',checked:true}),
            el('span',{},'표·그림 구조화 근거 사용',
              el('small',{textContent:'표·그림 근거를 함께 검토합니다. 기본값은 켜짐입니다.'})))),
        el('label',{for:'hosted-ai-prompt',id:'hosted-ai-prompt-label',textContent:'검토 지시'}),
        el('textarea',{id:'hosted-ai-prompt',rows:'4',spellcheck:'false'}),
        el('p',{id:'hosted-ai-prompt-count',className:'muted',textContent:'0자'}),
        el('div',{className:'button-row'},
          el('button',{id:'hosted-ai-run',type:'button',className:'button primary',textContent:'RED 검토 실행',disabled:true}),
          el('button',{id:'hosted-ai-cancel',type:'button',className:'button secondary',textContent:'실행 취소',hidden:true}),
          el('button',{id:'hosted-ai-refresh',type:'button',className:'text-button',textContent:'상태 새로고침',hidden:true})),
        el('p',{id:'hosted-ai-progress',className:'form-feedback',role:'status','aria-live':'polite'}),
        el('div',{id:'hosted-ai-job',hidden:true},
          el('h3',{id:'hosted-ai-job-state'}),
          el('p',{id:'hosted-ai-job-progress',className:'muted'}),
          el('p',{id:'hosted-ai-job-model',className:'muted'}),
          el('p',{id:'hosted-ai-job-usage',className:'muted'}),
          el('p',{id:'hosted-ai-job-failure',className:'form-feedback error',role:'alert',hidden:true})),
        el('p',{id:'hosted-ai-handoff-context',className:'muted',hidden:true}),
        el('section',{id:'hosted-ai-selection',hidden:true,'aria-label':'RED 후보 선택과 수정본 만들기'},
          el('h3',{textContent:'RED 후보 · 수정본 만들기'}),
          el('p',{id:'hosted-ai-selection-note',className:'muted'}),
          el('div',{id:'hosted-ai-candidates',className:'hosted-ai-candidates'}),
          el('div',{id:'hosted-ai-visual-candidates',className:'hosted-ai-candidates'}),
          el('p',{id:'hosted-ai-chart-note',className:'muted',hidden:true}),
          el('div',{className:'button-row'},
            el('button',{id:'hosted-ai-apply',type:'button',className:'button primary',textContent:'선택한 후보를 PDF에 적용',disabled:true})),
          el('p',{id:'hosted-ai-apply-status',className:'form-feedback',role:'status','aria-live':'polite'})),
        el('section',{id:'hosted-ai-result-section',hidden:true,'aria-label':'결과 요약'},
          el('h3',{textContent:'결과 요약'}),
          el('p',{id:'hosted-ai-result-counts'}),
          el('ul',{id:'hosted-ai-result-items',className:'hosted-ai-items'}),
          el('p',{id:'hosted-ai-result-note',className:'muted'})),
        el('section',{id:'hosted-ai-artifacts-section',hidden:true,'aria-label':'결과 파일'},
          el('h3',{textContent:'결과 파일'}),
          el('p',{className:'muted',textContent:'로그인 세션으로 인증해 내려받습니다.'}),
          el('ul',{id:'hosted-ai-artifacts',className:'hosted-ai-items'}),
          el('p',{id:'hosted-ai-download-status',className:'form-feedback',role:'status','aria-live':'polite'})),
        el('section',{id:'hosted-ai-edited-section',hidden:true,'aria-label':'수정본과 BLUE 연결'},
          el('h3',{textContent:'수정본 · BLUE로 넘기기'}),
          el('p',{id:'hosted-ai-edited-note',className:'muted'}),
          el('div',{className:'button-row'},
            el('button',{id:'hosted-ai-edited-download',type:'button',className:'button secondary',textContent:'수정본 PDF 내려받기'}),
            el('button',{id:'hosted-ai-blue-handoff',type:'button',className:'button primary',textContent:'이 수정본으로 BLUE 검토'}))),
        el('p',{id:'hosted-ai-edited-status',className:'form-feedback',role:'status','aria-live':'polite'}));

      host.append(loginForm,registerPanel,sessionRow,externalBox,disabledBox,configBox);

      Object.assign(nodes,{
        status:find('hosted-ai-status'),error:find('hosted-ai-error'),
        loginForm,sessionRow,externalBox,disabledBox,
        sessionText:find('hosted-ai-session-text'),logout:find('hosted-ai-logout'),
        username:find('hosted-ai-username'),password:find('hosted-ai-password'),login:find('hosted-ai-login'),
        registerPanel,registerUsername:find('hosted-ai-register-username'),
        registerPassword:find('hosted-ai-register-password'),
        registerDisplayName:find('hosted-ai-register-display-name'),
        registerInvite:find('hosted-ai-register-invite'),
        register:find('hosted-ai-register'),registerStatus:find('hosted-ai-register-status'),
        recheck:find('hosted-ai-recheck'),
        disabledMessage:find('hosted-ai-disabled-message'),
        config:configBox,
        file:find('hosted-ai-file'),fileStatus:find('hosted-ai-file-status'),
        inputActions:find('hosted-ai-input-actions'),restoreOriginal:find('hosted-ai-restore-original'),
        role:find('hosted-ai-role'),model:find('hosted-ai-model'),effort:find('hosted-ai-effort'),
        useEvidence:find('hosted-ai-use-evidence'),
        prompt:find('hosted-ai-prompt'),promptLabel:find('hosted-ai-prompt-label'),promptCount:find('hosted-ai-prompt-count'),
        run:find('hosted-ai-run'),cancel:find('hosted-ai-cancel'),refresh:find('hosted-ai-refresh'),
        progress:find('hosted-ai-progress'),
        jobBox:find('hosted-ai-job'),jobState:find('hosted-ai-job-state'),jobProgress:find('hosted-ai-job-progress'),
        jobModel:find('hosted-ai-job-model'),jobUsage:find('hosted-ai-job-usage'),jobFailure:find('hosted-ai-job-failure'),
        handoffContext:find('hosted-ai-handoff-context'),
        selectionSection:find('hosted-ai-selection'),selectionNote:find('hosted-ai-selection-note'),
        candidates:find('hosted-ai-candidates'),visualCandidates:find('hosted-ai-visual-candidates'),
        chartNote:find('hosted-ai-chart-note'),apply:find('hosted-ai-apply'),applyStatus:find('hosted-ai-apply-status'),
        resultSection:find('hosted-ai-result-section'),resultCounts:find('hosted-ai-result-counts'),
        resultItems:find('hosted-ai-result-items'),resultNote:find('hosted-ai-result-note'),
        artifactsSection:find('hosted-ai-artifacts-section'),artifacts:find('hosted-ai-artifacts'),
        downloadStatus:find('hosted-ai-download-status'),
        editedSection:find('hosted-ai-edited-section'),editedNote:find('hosted-ai-edited-note'),
        editedDownload:find('hosted-ai-edited-download'),handoff:find('hosted-ai-blue-handoff'),
        editedStatus:find('hosted-ai-edited-status')
      });

      nodes.file.addEventListener('change',()=>{onFile();});
      nodes.role.addEventListener('change',()=>{render();});
      nodes.model.addEventListener('change',()=>{state.model=nodes.model.value;render();});
      nodes.effort.addEventListener('change',()=>{state.effort=nodes.effort.value;render();});
      nodes.useEvidence.addEventListener('change',()=>{state.useEvidence=nodes.useEvidence.checked===true;render();});
      nodes.prompt.addEventListener('input',()=>{render();});
      nodes.login.addEventListener('click',()=>{login();});
      nodes.register.addEventListener('click',()=>{register();});
      nodes.logout.addEventListener('click',()=>{logout();});
      nodes.recheck.addEventListener('click',()=>{recheck();});
      nodes.run.addEventListener('click',()=>{run();});
      nodes.cancel.addEventListener('click',()=>{cancel();});
      nodes.refresh.addEventListener('click',()=>{if(state.job) refreshJob(state.job.id);});
      nodes.apply.addEventListener('click',()=>{applySelection();});
      nodes.restoreOriginal.addEventListener('click',()=>{restoreOriginalInput();});
      nodes.editedDownload.addEventListener('click',()=>{const artifact=editedArtifact();if(artifact) downloadArtifact(artifact);});
      nodes.handoff.addEventListener('click',()=>{handoffToBlue();});
    }
    function find(id){return host?host.querySelector('#'+id):null;}

    async function recheck(){
      if(state.busy||state.gate==='disabled') return;
      state.busy='recheck';state.error='';
      state.session=await resolveSession();
      state.restored=false;
      if(!state.session){
        state.busy='';
        fail(hookPresent()?'페이지 로그인 세션을 찾지 못했습니다. 로그인한 뒤 다시 확인하세요.':'로그인 세션이 없습니다. 아이디와 비밀번호로 로그인하세요.');
        return;
      }
      await probe();
      await restore();
      state.busy='';render();
    }

    function setHidden(node,hidden){
      if(!node) return;
      node.hidden=!!hidden;
    }
    function clearList(node){if(node)node.textContent='';}

    function fileIdentity(file,upload){
      const name=safeName(file&&file.name)||safeName(upload&&upload.name)||'선택한 파일';
      const size=sizeLabel(file?file.size:(upload?upload.bytes:0));
      return name+' · '+size;
    }
    function fileHashText(upload){
      if(state.fileSha) return 'sha256 '+state.fileSha;
      if(upload&&upload.sha256) return 'sha256 '+upload.sha256;
      return '해시 계산 중…';
    }
    function uploadRegistrationText(upload){
      if(!upload) return '';
      if(state.fileSha&&upload.sha256!==state.fileSha) return '';
      return upload.deduplicated?'서버 등록됨 · 기존 업로드 재사용':'서버 등록됨 · 새 업로드';
    }
    function fileStatusText(){
      if(state.fileError) return state.fileError;
      const file=state.file,upload=state.upload;
      if(!file&&!upload) return '아직 파일을 고르지 않았습니다.';
      const parts=[fileIdentity(file,upload),fileHashText(upload)];
      const registration=uploadRegistrationText(upload);
      if(registration) parts.push(registration);
      if(state.blueSource&&upload&&state.blueSource.sha256===upload.sha256) parts.push('RED 수정본 입력');
      return parts.join(' · ');
    }

    function roleLabel(){return nodes.role&&nodes.role.value==='blue'?'BLUE 검토 실행':'RED 검토 실행';}
    function jobStateText(){
      const job=state.job;
      if(!job) return '';
      const raw=typeof job.state==='string'?job.state.slice(0,32):'';
      const label=STATE_LABELS[raw];
      return label?label+' · '+raw:(raw||'상태 정보 없음');
    }
    const TERMINAL_PHASES=['completed','complete','done','partial','failed','cancelled','canceled','interrupted'];
    function isFinalPhase(phase){return TERMINAL_PHASES.includes(phase);}
    function progressNumbers(progress){
      const p=progress&&typeof progress==='object'?progress:{};
      const done=Number.isFinite(Number(p.completedCalls))&&Number(p.completedCalls)>=0
        ?Math.floor(Number(p.completedCalls)):null;
      const required=Number.isFinite(Number(p.requiredCalls))&&Number(p.requiredCalls)>0
        ?Math.floor(Number(p.requiredCalls)):null;
      return {done,required,phase:typeof p.phase==='string'?safeName(p.phase):''};
    }
    function finalProgressText(done,required,phase){
      if(!isFinalPhase(phase)) return '';
      const parts=[];
      if(required!==null&&done!==null) parts.push('완료 호출 '+done+' / '+required);
      parts.push('단계 '+phase);
      return parts.join(' · ');
    }
    function liveProgressText(done,required,phase){
      const parts=[];
      if(done!==null) parts.push('완료 호출 '+done+(required!==null?' / '+required:''));
      else parts.push('호출 진행 정보 없음');
      if(phase) parts.push('단계 '+phase);
      return parts.join(' · ');
    }
    function jobProgressText(){
      const job=state.job;
      if(!job) return '';
      const {done,required,phase}=progressNumbers(job.progress);
      if(TERMINAL_STATES.includes(job.state)) return finalProgressText(done,required,phase);
      return liveProgressText(done,required,phase);
    }

    function jobModelText(){
      const job=state.job;
      if(!job) return '';
      const parts=[];
      parts.push('모델: '+(typeof job.model==='string'&&job.model?job.model.slice(0,64):'서버가 제공하지 않음'));
      parts.push('추론 강도: '+(typeof job.effort==='string'&&job.effort?job.effort.slice(0,16):'서버가 제공하지 않음'));
      if(typeof job.provider==='string'&&job.provider) parts.push('실행: '+job.provider.slice(0,32));
      return parts.join(' · ');
    }
    function usageText(){
      const job=state.job;
      if(!job) return '';
      /* The gateway fills a zero placeholder while a job is queued/running; those are not provider-reported
         values, so do not present them as usage. */
      if(!TERMINAL_STATES.includes(job.state)) return '사용량: 아직 보고되지 않음';
      const usage=job.usage&&typeof job.usage==='object'?job.usage:null;
      if(!usage) return '사용량: 서버가 제공하지 않음';
      const fields=[['inputTokens','입력'],['outputTokens','출력'],['cacheReadInputTokens','캐시 읽기'],['cacheCreationInputTokens','캐시 생성']];
      const parts=[];
      for(const [key,label] of fields){
        const value=Number(usage[key]);
        if(Number.isFinite(value)&&value>=0) parts.push(label+' '+Math.floor(value));
      }
      return parts.length?'사용량: '+parts.join(' · '):'사용량: 서버가 제공하지 않음';
    }
    function failureLine(){
      const job=state.job;
      const failure=job&&job.failure&&typeof job.failure==='object'?job.failure:null;
      if(!failure) return '';
      const code=allowlistedCode(failure.code);
      const text=FAILURE_LABELS[code]||'실행이 실패했습니다';
      const parts=[text];
      if(code) parts.push(code);
      const requestId=allowlistedId(failure.requestId);
      if(requestId) parts.push('요청 ID '+requestId);
      if(failure.retryable===true) parts.push('재시도 가능');
      return '실패: '+parts.join(' · ');
    }

    const ITEM_KEYS=['items','defects','findings','candidates','issues'];
    function itemLabel(item){
      if(!item||typeof item!=='object') return '';
      const raw=item.title||item.label||item.defectId||item.id||item.summary||item.message||item.code||'';
      const text=safeName(typeof raw==='string'?raw:String(raw)).slice(0,120);
      if(typeof item.index==='number'&&Number.isFinite(item.index)) return (text||'항목')+' #'+(Math.floor(item.index)+1);
      return text;
    }
    /* The hosted runtime returns a falsify.document-red/blue.v1 document whose coverage reports accepted,
       rejected and unresolved items (coverage.resultCoverage). Older/other shapes are read defensively; a
       count is shown only when the server actually reported it. */
    function numericOrNull(value){
      if(value===null||value===undefined) return null;
      if(!Number.isFinite(Number(value))||Number(value)<0) return null;
      return Math.floor(Number(value));
    }
    function firstNumber(...values){
      for(const value of values){
        const found=numericOrNull(value);
        if(found!==null) return found;
      }
      return null;
    }
    function coverageView(result){
      const coverage=result.coverage&&typeof result.coverage==='object'?result.coverage:null;
      const reported=coverage&&coverage.resultCoverage&&typeof coverage.resultCoverage==='object'
        ?coverage.resultCoverage:null;
      const aggregate=result.counts&&typeof result.counts==='object'?result.counts
        :(result.summary&&typeof result.summary==='object'?result.summary:{});
      return {coverage,reported,aggregate};
    }
    function coverageCounts(reported,aggregate,result){
      return {
        accepted:firstNumber(reported&&reported.accepted,aggregate.accepted),
        rejected:firstNumber(reported&&reported.rejected,aggregate.rejected,result.rejected),
        unresolved:firstNumber(reported&&reported.unresolved,aggregate.unresolved,result.unresolved)
      };
    }
    function appendCoverageRows(rows,items,status){
      const list=Array.isArray(items)?items:[];
      for(const item of list){
        if(rows.length>=12) return;
        rows.push({status,label:itemLabel(item)});
      }
    }
    function firstItemList(result){
      for(const key of ITEM_KEYS){
        if(Array.isArray(result[key])) return result[key];
      }
      return null;
    }
    function legacyCoverageRows(out,list){
      let rejected=0,unresolved=0;
      for(const item of list){
        const status=String(item&&(item.status||item.state||item.verdict)||'').toLowerCase();
        if(status==='rejected') rejected++;
        if(status==='unresolved') unresolved++;
        if((status==='rejected'||status==='unresolved')&&out.rows.length<12){
          out.rows.push({status,label:itemLabel(item)});
        }
      }
      if(out.rejected===null) out.rejected=rejected;
      if(out.unresolved===null) out.unresolved=unresolved;
    }
    function summarizeResult(result){
      const out={available:false,total:null,accepted:null,rejected:null,unresolved:null,
        partial:false,incomplete:false,rows:[],remaining:0};
      if(!result||typeof result!=='object') return out;
      out.available=true;
      const {coverage,reported,aggregate}=coverageView(result);
      const counts=coverageCounts(reported,aggregate,result);
      out.accepted=counts.accepted;
      out.rejected=counts.rejected;
      out.unresolved=counts.unresolved;
      out.partial=result.partial===true;
      out.incomplete=!!(coverage&&coverage.complete===false);
      out.remaining=coverage&&Array.isArray(coverage.remainingBatches)?coverage.remainingBatches.length:0;
      appendCoverageRows(out.rows,reported&&reported.rejectedItems,'rejected');
      appendCoverageRows(out.rows,reported&&reported.unresolvedItems,'unresolved');
      const list=firstItemList(result);
      if(list){
        out.total=list.length;
        if(!out.rows.length) legacyCoverageRows(out,list);
      }
      if(out.total===null&&out.accepted!==null&&out.rejected!==null&&out.unresolved!==null){
        out.total=out.accepted+out.rejected+out.unresolved;
      }
      return out;
    }

    function toggleSelection(key,checked){
      if(checked) state.selection[key]=true;
      else delete state.selection[key];
      state.selectionVersion++;
      render();
    }
    function textCandidateNode(candidate){
      const checkbox=el('input',{id:'hosted-ai-candidate-'+candidate.index,type:'checkbox',checked:!!state.selection[candidate.key]});
      checkbox.addEventListener('change',()=>{toggleSelection(candidate.key,checkbox.checked===true);});
      const head=el('label',{className:'check-row hosted-ai-candidate-head'},
        checkbox,
        el('span',{},
          el('strong',{textContent:'후보 '+(candidate.index+1)+' · '+(candidate.pageIndex+1)+'쪽'}),
          el('small',{textContent:candidate.segmentId+(candidate.attackTypes.length?' · '+candidate.attackTypes.join(', '):'')})));
      const diff=el('div',{className:'hosted-ai-diff'},
        el('p',{},el('span',{className:'hosted-ai-diff-label is-before',textContent:'변경 전'}),el('code',{textContent:candidate.before})),
        el('p',{},el('span',{className:'hosted-ai-diff-label is-after',textContent:'변경 후'}),el('code',{textContent:candidate.after||'(삭제)'})));
      const node=el('div',{className:'hosted-ai-candidate'},head,diff);
      if(candidate.rationale){
        node.append(el('details',{className:'red-help'},el('summary',{textContent:'근거 보기'}),el('p',{textContent:candidate.rationale})));
      }
      return node;
    }
    function visualCandidateNode(edit,index){
      const checkbox=el('input',{id:'hosted-ai-visual-'+index,type:'checkbox',checked:!!state.selection[edit.key]});
      checkbox.addEventListener('change',()=>{toggleSelection(edit.key,checkbox.checked===true);});
      const head=el('label',{className:'check-row hosted-ai-candidate-head'},
        checkbox,
        el('span',{},
          el('strong',{textContent:'표 셀 '+edit.itemId+' · 행 '+edit.row+' · 열 '+edit.column}),
          el('small',{textContent:'행·열은 0부터입니다.'})));
      const diff=el('div',{className:'hosted-ai-diff'},
        el('p',{},el('span',{className:'hosted-ai-diff-label is-before',textContent:'변경 전'}),el('code',{textContent:edit.before})),
        el('p',{},el('span',{className:'hosted-ai-diff-label is-after',textContent:'변경 후'}),el('code',{textContent:edit.after||'(삭제)'})));
      return el('div',{className:'hosted-ai-candidate'},head,diff);
    }
    function renderCandidateLists(review,list,visual){
      const signature=state.candidateSignature+'|'+state.selectionVersion;
      if(builtSignature===signature) return;
      clearList(nodes.candidates);clearList(nodes.visualCandidates);
      if(list.length){
        nodes.candidates.append(el('h4',{textContent:'텍스트 후보 ('+list.length+')'}));
        for(const candidate of list) nodes.candidates.append(textCandidateNode(candidate));
      }
      if(visual.length){
        nodes.visualCandidates.append(el('h4',{textContent:'표 셀 후보 ('+visual.length+')'}));
        for(const [index,edit] of visual.entries()) nodes.visualCandidates.append(visualCandidateNode(edit,index));
      }
      nodes.chartNote.textContent=state.chartOnly?'차트 포인트 변경 '+state.chartOnly+'건은 이 화면에서 적용하지 않습니다.':'';
      setHidden(nodes.chartNote,!state.chartOnly);
      builtSignature=signature;
    }
    function renderSelectionStatus(review){
      const partial=summarizeResult(review.result).incomplete;
      const skipped=state.skippedCandidates?' '+state.skippedCandidates+'개 후보는 적용 조건에 맞지 않아 표시하지 않았습니다.':'';
      nodes.selectionNote.textContent='RED '+review.id.slice(0,8)+'… 결과입니다. 선택한 변경만 PDF에 적용합니다.'
        +(partial?' 일부 배치만 검토했습니다.':'')+skipped;
      const count=Object.keys(state.selection).length;
      const blocker=applyBlocker();
      nodes.apply.disabled=!!blocker||!!state.busy||state.gate!=='ready'||!state.session;
      nodes.apply.textContent='선택한 후보를 PDF에 적용'+(count?' ('+count+')':'');
      nodes.applyStatus.textContent=blocker||('선택 '+count+'개 · 선택한 변경만 PDF에 적용합니다.');
    }
    function isEditedInput(){
      const upload=state.upload;
      return !!state.blueSource&&!!upload&&state.blueSource.sha256===upload.sha256;
    }
    function handoffContextText(){
      const blue=nodes.role&&nodes.role.value==='blue';
      if(isEditedInput()){
        if(blue) return '수정본으로 BLUE 검토 중입니다.';
        return '수정본 입력입니다. 「원본 입력으로 돌아가기」로 RED 후보 편집을 다시 사용할 수 있습니다.';
      }
      return blue?'BLUE 검토 중입니다.':'';
    }
    function renderHandoffContext(){
      const text=handoffContextText();
      nodes.handoffContext.textContent=text;
      setHidden(nodes.handoffContext,!text);
      return (nodes.role&&nodes.role.value==='blue')||isEditedInput();
    }
    function renderCandidates(){
      const hideEditor=renderHandoffContext();
      const review=state.reviewJob;
      const list=state.candidates,visual=state.visualCandidates;
      const show=!hideEditor&&!!review&&(list.length>0||visual.length>0||state.chartOnly>0);
      setHidden(nodes.selectionSection,!show);
      if(!show){
        clearList(nodes.candidates);clearList(nodes.visualCandidates);
        builtSignature='';
        nodes.applyStatus.textContent='';
        return;
      }
      renderCandidateLists(review,list,visual);
      renderSelectionStatus(review);
    }

    /* The runtime's apply-only result is falsify.hosted-apply.v1 (counts + hashes), not a review document.
       Show its verified counts instead of the review coverage wording. */
    function applySummary(result){
      if(!result||typeof result!=='object'||result.schema!=='falsify.hosted-apply.v1') return null;
      const number=value=>value===null||value===undefined
        ?null
        :(Number.isFinite(Number(value))&&Number(value)>=0?Math.floor(Number(value)):null);
      const text=result.textEdits&&typeof result.textEdits==='object'?result.textEdits:{};
      const visual=result.visualEdits&&typeof result.visualEdits==='object'?result.visualEdits:{};
      const parts=[];
      const textApplied=number(text.applied),visualApplied=number(visual.applied);
      if(textApplied!==null) parts.push('텍스트 변경 '+textApplied+'건 적용');
      if(visualApplied!==null) parts.push('표 셀 '+visualApplied+'건 적용');
      const output=typeof result.outputSha256==='string'&&/^[0-9a-f]{64}$/.test(result.outputSha256)
        ?result.outputSha256:'';
      const verification=result.verification&&typeof result.verification==='object'
        ?result.verification:null;
      return {parts,output,verified:!!verification&&Object.keys(verification).length>0};
    }

    function renderContext(){
      const caps=state.capabilities,signed=!!state.session;
      return {caps,signed,locked:state.gate==='disabled',hook:hookPresent(),busy:!!state.busy,
        operate:state.gate==='ready'&&!!caps&&signed};
    }
    function renderStatus(){
      nodes.status.textContent=state.status||'';
      nodes.error.textContent=state.error||'';
      setHidden(nodes.error,!state.error);
    }
    function renderSessionRow(ctx){
      setHidden(nodes.sessionRow,!ctx.signed||ctx.locked);
      setHidden(nodes.logout,!ctx.signed||(state.session&&state.session.source==='hook'));
      if(ctx.signed) nodes.sessionText.textContent=sessionLabel();
    }
    function renderGate(ctx){
      setHidden(nodes.loginForm,ctx.locked||ctx.signed||ctx.hook);
      setHidden(nodes.registerPanel,ctx.locked||ctx.signed||ctx.hook);
      setHidden(nodes.externalBox,ctx.locked||ctx.signed||!ctx.hook);
      renderSessionRow(ctx);
      setHidden(nodes.disabledBox,!ctx.locked);
      if(ctx.locked) nodes.disabledMessage.textContent=state.disabledMessage||'';
    }
    function renderPromptMeta(ctx){
      const max=ctx.caps?ctx.caps.maxPromptChars:MAX_PROMPT_FALLBACK;
      if(nodes.prompt){
        if(nodes.prompt.getAttribute('maxlength')!==String(max)){
          nodes.prompt.setAttribute('maxlength',String(max));
        }
        nodes.promptLabel.textContent='검토 지시 (최대 '+max+'자)';
      }
      const count=codePoints(nodes.prompt?nodes.prompt.value:'');
      nodes.promptCount.textContent=count+' / '+max+'자';
      return {max,count};
    }
    function selectedModelValue(caps){
      if(caps.models.includes(state.model)) return state.model;
      return caps.models[0]||'';
    }
    function selectedEffortValue(caps){
      if(caps.efforts.includes(state.effort)) return state.effort;
      if(caps.efforts.includes('high')) return 'high';
      return caps.efforts[0]||'';
    }
    function renderSelectValues(caps){
      if(!caps) return;
      if(nodes.model) nodes.model.value=selectedModelValue(caps);
      if(nodes.effort) nodes.effort.value=selectedEffortValue(caps);
    }
    function renderInputState(ctx){
      nodes.fileStatus.textContent=fileStatusText();
      if(nodes.useEvidence) nodes.useEvidence.checked=state.useEvidence===true;
      if(nodes.role) nodes.role.value=nodes.role.value==='blue'?'blue':'red';
      renderSelectValues(ctx.caps);
    }
    function renderRestoreAction(){
      const restoreAvailable=!!state.originalInput&&(!state.upload||!state.originalInput.upload
        ||state.upload.id!==state.originalInput.upload.id);
      setHidden(nodes.inputActions,!restoreAvailable);
      nodes.restoreOriginal.disabled=!!state.busy;
    }
    function runAvailability(ctx,meta){
      const activeJob=!!state.job&&!TERMINAL_STATES.includes(state.job.state);
      const fileReady=!!(state.file&&state.fileSha)||!!state.upload;
      const canRun=ctx.operate&&ctx.signed&&!!ctx.caps&&fileReady&&!ctx.busy&&!activeJob
        &&!state.fileError&&meta.count>0&&meta.count<=meta.max;
      return {activeJob,fileReady,canRun};
    }
    function refreshVisible(ctx,activeJob){
      return !!state.job&&!ctx.busy&&!state.pollTimer&&(activeJob||state.pollFailures>0);
    }
    function renderRunButtons(ctx,availability){
      nodes.run.disabled=!availability.canRun;
      nodes.run.textContent=state.busy==='upload'?'파일 업로드 중…'
        :state.busy==='submit'?'작업 접수 중…':roleLabel();
      setHidden(nodes.cancel,!(availability.activeJob&&ctx.signed));
      nodes.cancel.disabled=ctx.busy;
      setHidden(nodes.refresh,!refreshVisible(ctx,availability.activeJob));
    }
    function renderInputDisabled(ctx){
      nodes.file.disabled=!ctx.operate||ctx.busy;
      nodes.role.disabled=!ctx.operate||ctx.busy;
      nodes.prompt.disabled=!ctx.operate||ctx.busy;
      nodes.model.disabled=!ctx.operate||ctx.busy||!ctx.caps||ctx.caps.models.length===0;
      nodes.effort.disabled=!ctx.operate||ctx.busy||!ctx.caps||ctx.caps.efforts.length===0;
    }
    function renderJobSection(){
      setHidden(nodes.jobBox,!state.job);
      if(!state.job){
        nodes.progress.textContent='';
        setHidden(nodes.jobFailure,true);
        nodes.jobFailure.textContent='';
        return;
      }
      nodes.jobState.textContent=jobStateText();
      const progressText=jobProgressText();
      nodes.jobProgress.textContent=progressText;
      nodes.jobModel.textContent=jobModelText();
      nodes.jobUsage.textContent=usageText();
      const failure=failureLine();
      nodes.jobFailure.textContent=failure;
      setHidden(nodes.jobFailure,!failure);
      nodes.progress.textContent=progressText?`${jobStateText()} · ${progressText}`:jobStateText();
    }
    function resultCountParts(summary){
      const parts=[];
      if(summary.total!==null) parts.push('항목 '+summary.total);
      if(summary.accepted!==null) parts.push('수용 '+summary.accepted);
      if(summary.rejected!==null) parts.push('거절 '+summary.rejected);
      if(summary.unresolved!==null) parts.push('미해결 '+summary.unresolved);
      if(summary.partial||summary.incomplete) parts.push('부분 결과');
      if(summary.remaining) parts.push('미검토 배치 '+summary.remaining+'개');
      return parts;
    }
    function appendResultRows(rows){
      for(const row of rows){
        nodes.resultItems.append(el('li',{className:'hosted-ai-item'},
          el('span',{className:'hosted-ai-item-status',textContent:row.status==='rejected'?'거절':'미해결'}),
          el('span',{className:'hosted-ai-item-name',textContent:row.label||'(설명 없음)'})));
      }
    }
    function resultNotes(summary){
      const notes=[];
      if(summary.partial||summary.incomplete||state.job.state==='interrupted'){
        notes.push('일부 결과만 있습니다. 미검토 배치는 자동으로 다시 실행하지 않았습니다.');
      }
      if(summary.total===null&&summary.accepted===null&&summary.rejected===null
        &&summary.unresolved===null){
        notes.push('결과 요약 형식이 이 화면과 다릅니다. 결과 파일이 있으면 내려받아 확인하세요.');
      }
      return notes;
    }
    function renderReviewResult(summary){
      const parts=resultCountParts(summary);
      nodes.resultCounts.textContent=parts.length?parts.join(' · '):'서버가 항목 수를 제공하지 않았습니다.';
      appendResultRows(summary.rows);
      const notes=resultNotes(summary);
      nodes.resultNote.textContent=notes.join(' ');
      setHidden(nodes.resultNote,!notes.length);
    }
    function renderApplyResult(applied){
      const parts=applied.parts.slice();
      if(applied.output) parts.push('출력 sha256 '+applied.output);
      parts.push('모델 호출 없음');
      nodes.resultCounts.textContent=parts.join(' · ');
      nodes.resultNote.textContent=applied.verified
        ?'서버가 출력 해시와 쪽수 검증 결과를 기록했습니다.'
        :'서버가 검증 기록을 제공하지 않았습니다.';
      setHidden(nodes.resultNote,!nodes.resultNote.textContent);
    }
    function renderResults(){
      const applied=state.job?applySummary(state.job.result):null;
      const summary=state.job&&!applied?summarizeResult(state.job.result):null;
      const showResult=!!applied||(!!summary&&summary.available);
      setHidden(nodes.resultSection,!showResult);
      clearList(nodes.resultItems);
      if(applied) return renderApplyResult(applied);
      if(showResult) renderReviewResult(summary);
    }
    function artifactListForJob(){
      if(!state.job||!Array.isArray(state.job.artifacts)) return [];
      return state.job.artifacts.filter(artifact=>artifact&&typeof artifact.id==='string'&&artifact.id);
    }
    function artifactMetaText(artifact){
      return [artifact.mime,sizeLabel(artifact.bytes)]
        .filter(value=>typeof value==='string'&&value&&value!=='크기 정보 없음').join(' · ')
        ||'파일 정보 없음';
    }
    function renderArtifacts(){
      const artifacts=artifactListForJob();
      setHidden(nodes.artifactsSection,!artifacts.length);
      clearList(nodes.artifacts);
      for(const artifact of artifacts){
        const button=el('button',{type:'button',className:'button secondary',textContent:'내려받기'});
        button.addEventListener('click',()=>{downloadArtifact(artifact);});
        nodes.artifacts.append(el('li',{className:'hosted-ai-item hosted-ai-artifact'},
          el('span',{className:'hosted-ai-item-name',textContent:safeName(artifact.name)||'결과 파일'}),
          el('span',{className:'muted',textContent:artifactMetaText(artifact)}),
          button));
      }
      nodes.downloadStatus.textContent=state.downloadStatus||'';
    }
    function editedMetaText(edited){
      const meta=[safeName(edited.name)||'수정본 PDF'];
      if(typeof edited.sha256==='string'&&edited.sha256) meta.push('sha256 '+edited.sha256);
      meta.push(sizeLabel(edited.bytes));
      if((state.blueSource&&state.blueSource.sha256===edited.sha256)
        ||(state.upload&&edited.sha256&&state.upload.sha256===edited.sha256)){
        meta.push('BLUE 입력으로 등록됨');
      }
      return meta.join(' · ');
    }
    function renderEdited(){
      const edited=editedArtifact();
      setHidden(nodes.editedSection,!edited);
      if(edited){
        nodes.editedNote.textContent='수정본: '+editedMetaText(edited)
          +'. BLUE에는 이 수정본만 전달하며 RED 결과·후보·근거는 보내지 않습니다.';
        nodes.editedDownload.disabled=!!state.busy;
        nodes.handoff.disabled=!!state.busy;
      }
      nodes.editedStatus.textContent=state.editedStatus||'';
    }
    function render(){
      if(!nodes.status) return;
      const ctx=renderContext();
      renderStatus();
      renderGate(ctx);
      setHidden(nodes.config,!ctx.operate);
      if(!ctx.operate) return;
      const meta=renderPromptMeta(ctx);
      renderInputState(ctx);
      renderRestoreAction();
      const availability=runAvailability(ctx,meta);
      renderRunButtons(ctx,availability);
      renderInputDisabled(ctx);
      renderJobSection();
      renderCandidates();
      renderResults();
      renderArtifacts();
      renderEdited();
    }

    function snapshot(){
      return {gate:state.gate,signed:!!state.session,busy:state.busy,jobId:state.job?state.job.id:'',hasCapabilities:!!state.capabilities};
    }

    if(host){build();start();}
    return {ready,mount:(node)=>{if(node){host=node;build();start();}return ready;},destroy,state:snapshot};
  }

  function autoMount(){
    if(typeof document==='undefined') return;
    const host=document.getElementById?document.getElementById('hosted-ai'):null;
    if(!host) return;
    if(typeof host.getAttribute==='function'&&host.getAttribute('data-hosted-ai-mounted')==='true') return;
    if(host.setAttribute) host.setAttribute('data-hosted-ai-mounted','true');
    create({document,host});
  }

  const api={create,version:VERSION};
  if(typeof globalThis!=='undefined') globalThis.FalsifyHostedAi=api;
  if(typeof document!=='undefined'){
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',autoMount,{once:true});
    else if(document.readyState) autoMount();
  }
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
})();
