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
  const MIME_TYPES=['application/pdf','application/octet-stream','text/plain'];
  const TERMINAL_STATES=['cancelled','completed','failed','interrupted'];
  const POLL_DELAYS=[1200,2000,3000,5000,8000,12000];
  const MAX_POLL_FAILURES=6;
  const MAX_PROMPT_FALLBACK=8000;
  const MAX_UPLOAD_FALLBACK=33554432;
  const TIMEOUTS={auth:20000,upload:60000,job:20000,cancel:20000,artifact:120000};
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
    internal_error:'서버 내부 오류입니다'
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

  function create(options={}){
    const doc=options.document||document;
    const host=options.host||null;
    const fetchImpl=options.fetch||((url,init)=>fetch(url,init));
    const storage=options.storage||sessionStorage;
    const cryptoApi=options.crypto||(typeof crypto!=='undefined'?crypto:null);
    const now=options.now||(()=>Date.now());
    const setT=options.setTimeout||((fn,ms)=>setTimeout(fn,ms));
    const clearT=options.clearTimeout||(id=>clearTimeout(id));
    const UrlApi=options.URL||URL;
    const Encoder=options.TextEncoder||TextEncoder;
    const Abort=options.AbortController||(typeof AbortController!=='undefined'?AbortController:null);
    const configFn=options.config||(()=>(typeof globalThis!=='undefined'?globalThis.FalsifyCloudConfig:undefined));
    const providerFn=options.sessionProvider||(()=>(typeof globalThis!=='undefined'?globalThis.FalsifyHostedSession:undefined));

    const state={
      apiBase:'', gate:'checking', disabledMessage:'', status:'', error:'',
      session:null, capabilities:null, restored:false,
      file:null, fileSha:'', fileError:'', upload:null,
      job:null, busy:'', model:'', effort:'', activeDigest:'',
      pollTimer:null, pollAttempt:0, pollFailures:0, downloadStatus:'', timers:new Set()
    };
    const nodes={};
    let readyResolve=null;
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
      const expires=s.expiresAt&&Number.isFinite(Date.parse(s.expiresAt))?` · 세션 만료 ${new Date(s.expiresAt).toISOString().slice(0,16).replace('T',' ')} UTC`:'';
      return `로그인됨: ${name}${user&&user!==name?` (${user})`:''}${expires}`;
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
      if(status===415) return '지원하지 않는 파일 형식입니다. PDF 또는 텍스트 파일만 올릴 수 있습니다.';
      if(status===429) return '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.';
      if(status===503) return '웹 실행 엔진이 지금 응답하지 않습니다. 잠시 뒤 다시 시도하거나 로컬 실행을 사용하세요.';
      if(status===400) return '요청이 올바르지 않습니다. 입력을 확인하세요.';
      if(status>=500) return '서버 오류입니다. 자동으로 다시 시도하지 않았습니다.';
      return '요청을 처리하지 못했습니다.';
    }
    function describe(error,context){
      if(error&&(error.kind==='network'||error.kind==='timeout'||error.kind==='config'||error.kind==='protocol')) return networkText(error)+failureSuffix(error);
      const base=httpText(error);
      if(context==='login'&&error&&error.status===401) return '아이디 또는 비밀번호가 올바르지 않습니다.';
      if(context==='login'&&(error&&error.code)==='membership_required') return '이 계정은 팀 멤버로 승인되지 않았습니다. 운영자에게 확인하세요.';
      if(context==='login'&&error&&error.status===410) return '이 서버는 비밀번호 로그인을 받지 않습니다(Confluence 전용 설정일 수 있습니다). 운영자가 웹 실행 로그인을 켜야 합니다.';
      return base+failureSuffix(error);
    }

    function capabilitiesFailure(error){
      const detail=describe(error,'capabilities');
      return `웹 실행 기능을 확인하지 못했습니다. ${detail} 이 패널은 아무 작업도 보내지 않습니다. 로컬 실행 연결 또는 수동 JSON 교환을 대신 쓰세요.`;
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

    async function probe(){
      state.capabilities=null;
      state.status='웹 실행 기능을 확인하는 중…';
      state.error='';
      render();
      let data;
      try{
        data=await jsonCall('/v1/ai/capabilities',{token:currentToken(),timeout:TIMEOUTS.auth});
      }catch(error){
        if(error&&(error.status===401||error.status===403)){
          if(state.session&&state.session.source!=='hook'){
            dropSessionStores();
            state.session=null;
            state.status='세션이 끝났습니다. 다시 로그인하면 웹 실행을 이어서 쓸 수 있습니다. 진행 중인 작업은 서버에 남아 있습니다.';
          }else if(state.session){
            state.session=null;
            state.status='페이지 로그인 세션이 서버에서 확인되지 않습니다. 로그인 상태를 다시 확인하세요.';
          }else{
            state.status='웹 실행이 설정되어 있습니다. 로그인하면 사용할 수 있는 모델과 한도를 확인합니다.';
          }
          state.gate='ready';
          render();
          return;
        }
        disable(capabilitiesFailure(error));
        render();
        return;
      }
      const caps=normalizeCapabilities(data);
      if(!caps){
        disable('서버의 웹 실행 설정(capabilities)을 해석하지 못했습니다. 운영자 배포 설정을 확인해야 합니다. 로컬 실행 연결은 그대로 쓸 수 있습니다.');
        render();
        return;
      }
      if(caps.enabled!==true){
        disable('운영자가 서버에서 웹 실행을 켜지 않았습니다(capabilities.enabled=false). 로컬 companion·CLI 실행이나 수동 JSON 교환을 대신 쓰세요.');
        render();
        return;
      }
      state.capabilities=caps;
      state.gate='ready';
      state.model=caps.models.includes(state.model)?state.model:(caps.models[0]||'');
      state.effort=caps.efforts.includes(state.effort)?state.effort:(caps.efforts.includes('high')?'high':(caps.efforts[0]||''));
      fillSelect(nodes.model,caps.models,'서버 기본값');
      fillSelect(nodes.effort,caps.efforts,'서버 기본값');
      state.status=state.session?'웹 실행 준비됨.':'웹 실행이 설정되어 있습니다. 로그인하면 실행할 수 있습니다.';
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
        disable('이 페이지에서는 웹 실행이 켜져 있지 않습니다(운영자 설정 hostedAi.enabled=false). 이 패널은 서버로 아무것도 보내지 않습니다.');
        render();
        finish();
        return;
      }
      const base=parseBase(hosted.apiBase,true)||parseBase(config&&config.apiBase,true);
      if(!base){
        disable('웹 실행 서버 주소(hostedAi.apiBase)가 올바른 https 주소가 아닙니다. 운영자 설정을 확인해야 합니다. 이 패널은 서버로 아무것도 보내지 않습니다.');
        render();
        finish();
        return;
      }
      state.apiBase=base;
      if(!(cryptoApi&&cryptoApi.subtle&&typeof cryptoApi.subtle.digest==='function')){
        disable('이 브라우저에서는 웹 실행을 쓸 수 없습니다(보안 컨텍스트의 crypto.subtle 필요). https 페이지에서 열거나 로컬 실행을 쓰세요.');
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
        const token=typeof data.token==='string'?data.token:'';
        if(!TOKEN_RE.test(token)) throw Object.assign(Error('bad token'),{kind:'protocol'});
        const author=data.author&&typeof data.author==='object'?{
          id:typeof data.author.id==='string'?data.author.id.slice(0,64):'',
          username:safeName(data.author.username),
          displayName:safeName(data.author.displayName)
        }:null;
        const session={source:'password',token,apiBase:state.apiBase,author,
          expiresAt:typeof data.expiresAt==='string'?data.expiresAt:''};
        state.session=session;
        state.restored=false;
        if(writeStore(SESSION_KEY,{apiBase:session.apiBase,token:session.token,author:session.author,expiresAt:session.expiresAt})){
          state.status='로그인했습니다.';
        }else{
          state.status='로그인했습니다. 이 브라우저는 세션 저장을 막아 새로고침하면 다시 로그인해야 합니다.';
        }
        nodes.username.value='';
        nodes.password.value='';
        state.error='';
        await probe();
        await restore();
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

    async function onFile(){
      state.file=null;state.fileSha='';state.fileError='';state.upload=null;state.error='';
      const files=nodes.file&&nodes.file.files?nodes.file.files:[];
      const file=files&&files[0]?files[0]:null;
      if(!file){render();return;}
      if(state.gate!=='ready'||!state.capabilities){fail('먼저 로그인하고 서버 한도를 확인하세요.');render();return;}
      const name=safeName(file.name);
      const limit=maxUpload();
      if(!(Number(file.size)>0)){
        state.fileError=(name||'선택한 파일')+'이 비어 있어 업로드할 수 없습니다.';
        fail(state.fileError);render();return;
      }
      if(Number(file.size)>limit){
        state.fileError=`${name||'선택한 파일'} 파일이 서버 한도 ${sizeLabel(limit)}(${limit} bytes)를 넘어 업로드하지 않았습니다.`;
        fail(state.fileError);render();return;
      }
      state.file=file;
      state.status='파일 해시를 계산하는 중…';
      render();
      try{
        const bytes=new Uint8Array(await file.arrayBuffer());
        if(state.file!==file) return;
        if(bytes.byteLength>limit){
          state.file=null;
          state.fileError=`${name||'선택한 파일'} 파일이 서버 한도 ${sizeLabel(limit)}(${limit} bytes)를 넘어 업로드하지 않았습니다.`;
          fail(state.fileError);render();return;
        }
        state.fileSha=await sha256Hex(bytes);
        const stored=readUploadStore();
        state.upload=stored&&stored.sha256===state.fileSha?stored:null;
        state.status=state.upload?'같은 파일이 이미 서버에 등록되어 있어 다시 올리지 않습니다.':'파일을 올릴 준비가 되었습니다. 실행 버튼을 누르면 업로드와 접수를 한 번에 합니다.';
        state.error='';
        render();
      }catch(error){
        state.fileSha='';
        fail(describe(error,'upload'));
        render();
      }
    }

    async function ensureUpload(){
      const file=state.file;
      if(!file) throw Object.assign(Error('no file'),{kind:'local'});
      if(!state.fileSha) throw Object.assign(Error('no hash'),{kind:'local'});
      if(state.upload&&state.upload.sha256===state.fileSha) return state.upload;
      const limit=maxUpload();
      if(Number(file.size)>limit){
        throw Object.assign(Error('too large'),{kind:'local',message:`파일이 서버 한도 ${sizeLabel(limit)}(${limit} bytes)를 넘어 업로드하지 않았습니다.`});
      }
      const bytes=new Uint8Array(await file.arrayBuffer());
      if(bytes.byteLength>limit){
        throw Object.assign(Error('too large'),{kind:'local',message:`파일이 서버 한도 ${sizeLabel(limit)}(${limit} bytes)를 넘어 업로드하지 않았습니다.`});
      }
      const mime=MIME_TYPES.includes(file.type)?file.type:'application/octet-stream';
      const name=safeName(file.name)||'upload.bin';
      const data=await jsonCall('/v1/ai/uploads',{
        method:'POST',token:currentToken(),body:bytes,timeout:TIMEOUTS.upload,
        headers:{'Content-Type':mime,'X-Falsify-File-Name':encodeURIComponent(name)}
      });
      const upload=data.upload&&typeof data.upload==='object'&&typeof data.upload.id==='string'?data.upload:null;
      if(!upload||typeof upload.sha256!=='string'||!upload.sha256){
        throw Object.assign(Error('bad upload'),{kind:'protocol'});
      }
      if(upload.sha256!==state.fileSha){
        throw Object.assign(Error('hash mismatch'),{kind:'protocol'});
      }
      const descriptor={id:upload.id,sha256:upload.sha256,apiBase:state.apiBase,name:safeName(upload.name)||name,mime,
        bytes:positiveInt(upload.bytes),deduplicated:upload.deduplicated===true};
      state.upload=descriptor;
      storeUpload(descriptor);
      return descriptor;
    }

    /* ---------- runs / idempotency ---------- */
    function readRunsDoc(){
      const data=readJsonStore(RUNS_KEY);
      const runs=data&&data.runs&&typeof data.runs==='object'?data.runs:{};
      const clean={};
      for(const [digest,entry] of Object.entries(runs)){
        if(!/^[0-9a-f]{64}$/.test(digest)||!entry||typeof entry!=='object') continue;
        if(entry.apiBase!==state.apiBase) continue;
        if(typeof entry.key!=='string'||entry.key.length<8||entry.key.length>128) continue;
        clean[digest]={
          apiBase:entry.apiBase,key:entry.key,role:entry.role==='blue'?'blue':'red',
          uploadId:typeof entry.uploadId==='string'?entry.uploadId:'',
          sha256:typeof entry.sha256==='string'?entry.sha256:'',
          jobId:typeof entry.jobId==='string'?entry.jobId:'',
          pending:entry.pending===true,
          model:typeof entry.model==='string'?entry.model.slice(0,64):'',
          effort:typeof entry.effort==='string'?entry.effort.slice(0,16):'',
          updatedAt:typeof entry.updatedAt==='string'?entry.updatedAt:''
        };
      }
      return {runs:clean,active:data&&typeof data.active==='string'?data.active:''};
    }
    function saveRun(digest,entry){
      const doc=readRunsDoc();
      doc.runs[digest]=Object.assign({},entry,{apiBase:state.apiBase,updatedAt:new Date(now()).toISOString()});
      doc.active=digest;
      const keys=Object.keys(doc.runs);
      if(keys.length>RUNS_LIMIT){
        keys.sort((a,b)=>String(doc.runs[a].updatedAt).localeCompare(String(doc.runs[b].updatedAt)));
        for(const key of keys.slice(0,keys.length-RUNS_LIMIT)) delete doc.runs[key];
      }
      writeStore(RUNS_KEY,{runs:doc.runs,active:doc.active});
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

    /* ---------- run / submit ---------- */
    async function run(){
      if(state.busy||state.gate!=='ready'||!state.session||!state.capabilities) return;
      const role=nodes.role.value==='blue'?'blue':'red';
      const prompt=String(nodes.prompt.value||'').normalize('NFC').trim();
      const model=selectedValue(nodes.model)||state.model;
      const effort=selectedValue(nodes.effort)||state.effort;
      const max=maxPrompt();
      if(!prompt){fail('검토 지시를 입력하세요.');return;}
      if(codePoints(prompt)>max){fail(`검토 지시가 서버 한도 ${max}자를 넘습니다.`);return;}
      if(!state.file){fail(state.fileError||'검토할 파일을 먼저 고르세요.');return;}
      if(state.job&&!TERMINAL_STATES.includes(state.job.state)){
        fail('이미 실행 중인 작업이 있습니다. 완료·취소·중단된 뒤에 새 작업을 실행할 수 있습니다.');
        return;
      }
      state.busy='upload';state.error='';state.downloadStatus='';
      setStatus('파일을 서버에 등록하는 중…');
      let upload=null,digest='';
      try{
        upload=await ensureUpload();
        /* The key must match the gateway's request hash: role, upload, instruction, model and effort.
           Changing only the model or effort is a different paid request, not an idempotent replay. */
        digest=await digestOf(`${role}\n${upload.id}\n${prompt}\n${model}\n${effort}`);
        state.activeDigest=digest;
        const key='fssjob-'+digest.slice(0,40);
        const doc=readRunsDoc();
        const existing=doc.runs[digest];
        if(existing&&existing.jobId&&!existing.pending){
          state.status='같은 파일·역할·지시·모델·강도로 이미 접수한 작업을 다시 불러옵니다. 새 유료 호출은 없습니다.';
          render();
          state.busy='';
          await refreshJob(existing.jobId);
          return;
        }
        state.busy='submit';
        setStatus('작업을 접수하는 중…');
        const body={role,prompt,uploadId:upload.id,idempotencyKey:key};
        if(model) body.model=model;
        if(effort) body.effort=effort;
        const data=await jsonCall('/v1/ai/jobs',{
          method:'POST',token:currentToken(),headers:{'Content-Type':'application/json'},
          body:JSON.stringify(body),timeout:TIMEOUTS.job
        });
        const job=data.job&&typeof data.job==='object'?data.job:null;
        if(!job||typeof job.id!=='string'||!job.id) throw Object.assign(Error('bad job'),{kind:'protocol'});
        saveRun(digest,{key,role,uploadId:upload.id,sha256:upload.sha256,jobId:job.id,pending:false,model,effort});
        state.busy='';
        applyJob(job,{replayed:data.replayed===true});
      }catch(error){
        if(error&&error.kind==='local'&&error.message){
          fail(error.message);
        }else if(error&&(error.kind==='network'||error.kind==='timeout')){
          try{
            if(!digest&&upload){
              digest=await digestOf(`${role}\n${upload.id}\n${prompt}\n${model}\n${effort}`);
            }
            if(digest&&upload){
              saveRun(digest,{key:'fssjob-'+digest.slice(0,40),role,uploadId:upload.id,sha256:upload.sha256,jobId:'',pending:true,model,effort});
            }
          }catch{}
          fail('제출 응답을 확인하지 못했습니다. 접수되었는지 알 수 없어 자동으로 다시 보내지 않았습니다. 같은 파일·역할·지시·모델·강도로 다시 실행하면 같은 요청 키를 재사용하므로 서버가 기존 작업을 돌려주고, 새 유료 호출은 생기지 않습니다.');
        }else{
          fail(describe(error,'submit'));
        }
      }finally{
        state.busy='';
        render();
      }
    }

    /* ---------- job ---------- */
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
        if(TERMINAL_STATES.includes(state.job.state)){
          stopPoll();
          state.pollAttempt=0;
        }else{
          schedulePoll();
        }
      }catch(error){
        if(error&&error.status===401){
          stopPoll();
          if(state.session&&state.session.source!=='hook'){dropSessionStores();state.session=null;}
          state.gate='ready';
          fail('세션이 끝났습니다. 다시 로그인하면 서버에 남아 있는 작업을 다시 확인할 수 있습니다.');
          return;
        }
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
          fail('작업 상태를 계속 확인하지 못했습니다. 서버의 작업은 그대로 있습니다. 「상태 새로고침」으로 다시 확인하세요.');
          return;
        }
        if(state.job&&!TERMINAL_STATES.includes(state.job.state)) schedulePoll();
        state.status='작업 상태를 확인하지 못해 다시 확인합니다.';
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
        ?'이미 접수된 작업을 다시 불러왔습니다. 새 유료 호출은 없습니다.'
        :'작업이 접수되었습니다. 진행 상태를 계속 확인합니다.';
      if(!TERMINAL_STATES.includes(job.state)) schedulePoll();
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
        const res=await http('/v1/ai/jobs/'+encodeURIComponent(state.job.id)+'/artifacts/'+encodeURIComponent(artifact.id),{
          token:currentToken(),timeout:TIMEOUTS.artifact
        });
        if(!res.ok){
          const error=Error('http '+res.status);
          error.status=Number(res.status)||0;
          throw error;
        }
        const blob=await res.blob();
        const href=UrlApi.createObjectURL(blob);
        const anchor=doc.createElement('a');
        anchor.href=href;
        anchor.download=safeName(artifact.name)||'result.bin';
        anchor.rel='noopener';
        anchor.hidden=true;
        anchor.click();
        const rid=later(()=>{try{UrlApi.revokeObjectURL(href);}catch{}},30000);
        state.downloadStatus='결과 파일을 내려받았습니다: '+safeName(artifact.name)+'. 링크는 이 페이지 메모리에만 있습니다.';
        void rid;
      }catch(error){
        state.downloadStatus='';
        fail(describe(error,'artifact'));
      }finally{
        state.busy='';render();
      }
    }

    /* ---------- restore ---------- */
    async function restore(){
      if(state.gate!=='ready'||!state.session||!state.capabilities||state.restored) return;
      state.restored=true;
      const doc=readRunsDoc();
      const digest=doc.active;
      const entry=digest&&doc.runs[digest]?doc.runs[digest]:null;
      if(!entry) return;
      state.activeDigest=digest;
      const upload=readUploadStore();
      if(upload&&(!entry.sha256||upload.sha256===entry.sha256)) state.upload=upload;
      if(typeof entry.jobId==='string'&&entry.jobId){
        state.status='이전 작업을 불러오는 중…';
        render();
        await refreshJob(entry.jobId);
        return;
      }
      if(entry.pending===true){
        state.status='이전 제출의 접수 여부를 확인하지 못했습니다. 같은 파일·역할·지시·모델·강도로 다시 실행하면 같은 요청 키를 재사용하므로 새 유료 호출 없이 기존 작업을 확인합니다.';
        render();
      }
    }

    /* ---------- rendering ---------- */
    function el(tag,props,...kids){
      const node=doc.createElement(tag);
      for(const [key,value] of Object.entries(props||{})){
        if(value===undefined||value===null||value===false) continue;
        if(key==='textContent') node.textContent=String(value);
        else if(key==='className') node.className=String(value);
        else if(key==='hidden'||key==='disabled'||key==='checked'||key==='value'||key==='id'||key==='type') node[key]=value;
        else node.setAttribute(key,String(value));
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
            el('h2',{id:'hosted-ai-title',textContent:'웹 실행 · 운영자 API'}),
            el('p',{id:'hosted-ai-intro',className:'muted',textContent:'로그인하면 PDF를 올려 RED/BLUE 검토를 서버에서 실행합니다. API 키·로컬 경로 입력은 없습니다. 로컬 CLI·companion은 선택 사항입니다.'}))),
        el('p',{id:'hosted-ai-status',className:'form-feedback',role:'status','aria-live':'polite'}),
        el('p',{id:'hosted-ai-error',className:'form-feedback error',role:'alert',hidden:true}));

      const loginForm=el('form',{id:'hosted-ai-login-form',className:'hosted-ai-login',hidden:true,novalidate:'true'},
        el('h3',{textContent:'로그인'}),
        el('p',{className:'muted',textContent:'Falsify 계정으로 로그인합니다. 비밀번호는 전송만 하고 저장하지 않으며, 새로고침하면 다시 입력합니다.'}),
        el('label',{for:'hosted-ai-username'},'아이디',
          el('input',{id:'hosted-ai-username',type:'text',autocomplete:'username',maxlength:'200',spellcheck:'false'})),
        el('label',{for:'hosted-ai-password'},'비밀번호',
          el('input',{id:'hosted-ai-password',type:'password',autocomplete:'current-password',maxlength:'256'})),
        el('div',{className:'button-row'},
          el('button',{id:'hosted-ai-login',type:'button',className:'button primary',textContent:'로그인'})));
      loginForm.addEventListener('submit',event=>{if(event&&event.preventDefault)event.preventDefault();login();});

      const sessionRow=el('div',{id:'hosted-ai-session',className:'hosted-ai-session',hidden:true},
        el('p',{id:'hosted-ai-session-text'}),
        el('button',{id:'hosted-ai-logout',type:'button',className:'text-button',textContent:'로그아웃'}));

      const externalBox=el('div',{id:'hosted-ai-external',hidden:true},
        el('p',{className:'muted',textContent:'이 페이지의 로그인 세션이 필요합니다. 로그인한 뒤 「로그인 상태 다시 확인」을 누르세요. 이 패널은 비밀번호를 묻지 않습니다.'}),
        el('div',{className:'button-row'},
          el('button',{id:'hosted-ai-recheck',type:'button',className:'button secondary',textContent:'로그인 상태 다시 확인'})));

      const disabledBox=el('div',{id:'hosted-ai-disabled',hidden:true},
        el('p',{id:'hosted-ai-disabled-message'}),
        el('p',{className:'muted'},
          '선택 사항인 로컬 실행은 이 페이지의 「로컬 실행 연결」 패널에서 companion과 토큰으로 연결하거나, ',
          el('a',{className:'text-link',href:'./guide.html',target:'_blank',rel:'noopener noreferrer',textContent:'사용 설명서'}),
          '의 수동 JSON 교환 절차를 따르세요. 이 패널은 위 상태에서 서버로 아무 작업도 보내지 않습니다.'));

      const configBox=el('div',{id:'hosted-ai-config',hidden:true},
        el('label',{for:'hosted-ai-file'},'검토할 논문 파일 (PDF · TXT · MD)',
          el('input',{id:'hosted-ai-file',type:'file',accept:'.pdf,.txt,.md,.markdown,.text'})),
        el('p',{id:'hosted-ai-file-status',className:'muted',textContent:'아직 파일을 고르지 않았습니다.'}),
        el('div',{className:'hosted-ai-grid'},
          el('label',{for:'hosted-ai-role'},'역할',
            el('select',{id:'hosted-ai-role'},
              el('option',{value:'red',textContent:'RED · 결함 주입'}),
              el('option',{value:'blue',textContent:'BLUE · 결함 검증'}))),
          el('label',{for:'hosted-ai-model'},'모델',el('select',{id:'hosted-ai-model'})),
          el('label',{for:'hosted-ai-effort'},'추론 강도',el('select',{id:'hosted-ai-effort'}))),
        el('label',{for:'hosted-ai-prompt',id:'hosted-ai-prompt-label',textContent:'검토 지시 (최대 8000자)'}),
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
        el('section',{id:'hosted-ai-result-section',hidden:true,'aria-label':'결과 요약'},
          el('h3',{textContent:'결과 요약'}),
          el('p',{id:'hosted-ai-result-counts'}),
          el('ul',{id:'hosted-ai-result-items',className:'hosted-ai-items'}),
          el('p',{id:'hosted-ai-result-note',className:'muted'})),
        el('section',{id:'hosted-ai-artifacts-section',hidden:true,'aria-label':'결과 파일'},
          el('h3',{textContent:'결과 파일'}),
          el('p',{className:'muted',textContent:'내려받기는 로그인 세션으로 인증합니다. 결과 링크는 이 페이지 메모리에만 있습니다.'}),
          el('ul',{id:'hosted-ai-artifacts',className:'hosted-ai-items'}),
          el('p',{id:'hosted-ai-download-status',className:'form-feedback',role:'status','aria-live':'polite'})));

      host.append(loginForm,sessionRow,externalBox,disabledBox,configBox);

      Object.assign(nodes,{
        status:find('hosted-ai-status'),error:find('hosted-ai-error'),
        loginForm,sessionRow,externalBox,disabledBox,
        sessionText:find('hosted-ai-session-text'),logout:find('hosted-ai-logout'),
        username:find('hosted-ai-username'),password:find('hosted-ai-password'),login:find('hosted-ai-login'),
        recheck:find('hosted-ai-recheck'),
        disabledMessage:find('hosted-ai-disabled-message'),
        config:configBox,
        file:find('hosted-ai-file'),fileStatus:find('hosted-ai-file-status'),
        role:find('hosted-ai-role'),model:find('hosted-ai-model'),effort:find('hosted-ai-effort'),
        prompt:find('hosted-ai-prompt'),promptLabel:find('hosted-ai-prompt-label'),promptCount:find('hosted-ai-prompt-count'),
        run:find('hosted-ai-run'),cancel:find('hosted-ai-cancel'),refresh:find('hosted-ai-refresh'),
        progress:find('hosted-ai-progress'),
        jobBox:find('hosted-ai-job'),jobState:find('hosted-ai-job-state'),jobProgress:find('hosted-ai-job-progress'),
        jobModel:find('hosted-ai-job-model'),jobUsage:find('hosted-ai-job-usage'),jobFailure:find('hosted-ai-job-failure'),
        resultSection:find('hosted-ai-result-section'),resultCounts:find('hosted-ai-result-counts'),
        resultItems:find('hosted-ai-result-items'),resultNote:find('hosted-ai-result-note'),
        artifactsSection:find('hosted-ai-artifacts-section'),artifacts:find('hosted-ai-artifacts'),
        downloadStatus:find('hosted-ai-download-status')
      });

      nodes.file.addEventListener('change',()=>{onFile();});
      nodes.role.addEventListener('change',()=>{render();});
      nodes.model.addEventListener('change',()=>{state.model=nodes.model.value;render();});
      nodes.effort.addEventListener('change',()=>{state.effort=nodes.effort.value;render();});
      nodes.prompt.addEventListener('input',()=>{render();});
      nodes.login.addEventListener('click',()=>{login();});
      nodes.logout.addEventListener('click',()=>{logout();});
      nodes.recheck.addEventListener('click',()=>{recheck();});
      nodes.run.addEventListener('click',()=>{run();});
      nodes.cancel.addEventListener('click',()=>{cancel();});
      nodes.refresh.addEventListener('click',()=>{if(state.job) refreshJob(state.job.id);});
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

    function fileStatusText(){
      if(state.fileError) return state.fileError;
      if(!state.file) return '아직 파일을 고르지 않았습니다.';
      const name=safeName(state.file.name)||'선택한 파일';
      const size=sizeLabel(state.file.size);
      const sha=state.fileSha?' · sha256 '+state.fileSha:' · 해시 계산 중…';
      let upload='';
      if(state.upload&&state.upload.sha256===state.fileSha){
        upload=state.upload.deduplicated?' · 서버 등록됨 · 기존 업로드 재사용':' · 서버 등록됨 · 새 업로드';
      }
      return name+' · '+size+sha+upload;
    }
    function roleLabel(){return nodes.role&&nodes.role.value==='blue'?'BLUE 검토 실행':'RED 검토 실행';}
    function jobStateText(){
      const job=state.job;
      if(!job) return '';
      const raw=typeof job.state==='string'?job.state.slice(0,32):'';
      const label=STATE_LABELS[raw];
      return label?label+' · '+raw:(raw||'상태 정보 없음');
    }
    function jobProgressText(){
      const job=state.job;
      if(!job) return '';
      const p=job.progress&&typeof job.progress==='object'?job.progress:{};
      const done=Number.isFinite(Number(p.completedCalls))&&Number(p.completedCalls)>=0?Math.floor(Number(p.completedCalls)):null;
      const required=Number.isFinite(Number(p.requiredCalls))&&Number(p.requiredCalls)>0?Math.floor(Number(p.requiredCalls)):null;
      const phase=typeof p.phase==='string'?safeName(p.phase):'';
      const parts=[];
      if(done!==null) parts.push('완료 호출 '+done+(required!==null?' / '+required:''));
      else parts.push('호출 진행 정보 없음');
      if(phase) parts.push('단계 '+phase);
      return parts.join(' · ');
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
    function summarizeResult(result){
      const out={available:false,total:null,accepted:null,rejected:null,unresolved:null,partial:false,incomplete:false,rows:[]};
      if(!result||typeof result!=='object') return out;
      out.available=true;
      const number=value=>value===null||value===undefined
        ?null
        :(Number.isFinite(Number(value))&&Number(value)>=0?Math.floor(Number(value)):null);
      const aggregate=result.counts&&typeof result.counts==='object'?result.counts
        :(result.summary&&typeof result.summary==='object'?result.summary:{});
      const coverage=result.coverage&&typeof result.coverage==='object'?result.coverage:null;
      const reported=coverage&&coverage.resultCoverage&&typeof coverage.resultCoverage==='object'
        ?coverage.resultCoverage:null;
      const firstNumber=(...values)=>{
        for(const value of values){const found=number(value);if(found!==null) return found;}
        return null;
      };
      out.accepted=firstNumber(reported&&reported.accepted,aggregate.accepted);
      out.rejected=firstNumber(reported&&reported.rejected,aggregate.rejected,result.rejected);
      out.unresolved=firstNumber(reported&&reported.unresolved,aggregate.unresolved,result.unresolved);
      out.partial=result.partial===true;
      out.incomplete=!!(coverage&&coverage.complete===false);
      const remaining=coverage&&Array.isArray(coverage.remainingBatches)?coverage.remainingBatches:[];
      out.remaining=remaining.length;
      const rejectedItems=reported&&Array.isArray(reported.rejectedItems)?reported.rejectedItems:[];
      const unresolvedItems=reported&&Array.isArray(reported.unresolvedItems)?reported.unresolvedItems:[];
      for(const item of rejectedItems){
        if(out.rows.length>=12) break;
        out.rows.push({status:'rejected',label:itemLabel(item)});
      }
      for(const item of unresolvedItems){
        if(out.rows.length>=12) break;
        out.rows.push({status:'unresolved',label:itemLabel(item)});
      }
      let list=null;
      for(const key of ITEM_KEYS){
        if(Array.isArray(result[key])){list=result[key];break;}
      }
      if(list){
        out.total=list.length;
        if(!out.rows.length){
          let rejected=0,unresolved=0;
          for(const item of list){
            const status=String(item&&(item.status||item.state||item.verdict)||'').toLowerCase();
            if(status==='rejected'||status==='unresolved'){
              if(status==='rejected') rejected++;
              else unresolved++;
              if(out.rows.length<12) out.rows.push({status,label:itemLabel(item)});
            }
          }
          if(out.rejected===null) out.rejected=rejected;
          if(out.unresolved===null) out.unresolved=unresolved;
        }
      }
      if(out.total===null&&out.accepted!==null&&out.rejected!==null&&out.unresolved!==null){
        out.total=out.accepted+out.rejected+out.unresolved;
      }
      return out;
    }

    function render(){
      if(!nodes.status) return;
      const caps=state.capabilities;
      const signed=!!state.session;
      nodes.status.textContent=state.status||'';
      nodes.error.textContent=state.error||'';
      setHidden(nodes.error,!state.error);

      const locked=state.gate==='disabled';
      setHidden(nodes.loginForm,!(state.gate!=='disabled'&&!signed&&!hookPresent()));
      setHidden(nodes.externalBox,!(state.gate!=='disabled'&&!signed&&hookPresent()));
      setHidden(nodes.sessionRow,!(signed&&!locked));
      setHidden(nodes.logout,!signed||state.session.source==='hook');
      if(signed) nodes.sessionText.textContent=sessionLabel();
      setHidden(nodes.disabledBox,state.gate!=='disabled');
      if(state.gate==='disabled') nodes.disabledMessage.textContent=state.disabledMessage||'';

      const operate=state.gate==='ready'&&!!caps&&signed;
      setHidden(nodes.config,!operate);

      const max=caps?caps.maxPromptChars:MAX_PROMPT_FALLBACK;
      if(nodes.prompt){
        if(nodes.prompt.getAttribute('maxlength')!==String(max)) nodes.prompt.setAttribute('maxlength',String(max));
        nodes.promptLabel.textContent='검토 지시 (최대 '+max+'자)';
      }
      const count=codePoints(nodes.prompt?nodes.prompt.value:'');
      nodes.promptCount.textContent=count+' / '+max+'자';
      nodes.fileStatus.textContent=fileStatusText();
      if(nodes.role) nodes.role.value=nodes.role.value==='blue'?'blue':'red';
      if(caps){
        if(nodes.model) nodes.model.value=caps.models.includes(state.model)?state.model:(caps.models[0]||'');
        if(nodes.effort) nodes.effort.value=caps.efforts.includes(state.effort)?state.effort:(caps.efforts.includes('high')?'high':(caps.efforts[0]||''));
      }

      const activeJob=!!state.job&&!TERMINAL_STATES.includes(state.job.state);
      const overPrompt=count>max;
      const canRun=operate&&signed&&!!caps&&!!state.file&&!!state.fileSha&&!state.busy&&!activeJob&&!state.fileError&&count>0&&!overPrompt;
      nodes.run.disabled=!canRun;
      nodes.run.textContent=state.busy==='upload'?'파일 업로드 중…':state.busy==='submit'?'작업 접수 중…':roleLabel();
      const busy=!!state.busy;
      nodes.file.disabled=!operate||busy;
      nodes.role.disabled=!operate||busy;
      nodes.prompt.disabled=!operate||busy;
      nodes.model.disabled=!operate||busy||!caps||caps.models.length===0;
      nodes.effort.disabled=!operate||busy||!caps||caps.efforts.length===0;
      setHidden(nodes.cancel,!(activeJob&&signed));
      nodes.cancel.disabled=busy;
      setHidden(nodes.refresh,!(state.job&&!busy&&!state.pollTimer&&(activeJob||state.pollFailures>0)));

      setHidden(nodes.jobBox,!state.job);
      if(state.job){
        nodes.jobState.textContent=jobStateText();
        nodes.jobProgress.textContent=jobProgressText();
        nodes.jobModel.textContent=jobModelText();
        nodes.jobUsage.textContent=usageText();
        const failure=failureLine();
        nodes.jobFailure.textContent=failure;
        setHidden(nodes.jobFailure,!failure);
        nodes.progress.textContent=`${jobStateText()} · ${jobProgressText()}`;
      }else{
        nodes.progress.textContent='';
        setHidden(nodes.jobFailure,true);
        nodes.jobFailure.textContent='';
      }

      const summary=state.job?summarizeResult(state.job.result):null;
      const showResult=!!summary&&summary.available;
      setHidden(nodes.resultSection,!showResult);
      clearList(nodes.resultItems);
      if(showResult){
        const parts=[];
        if(summary.total!==null) parts.push('항목 '+summary.total);
        if(summary.accepted!==null) parts.push('수용 '+summary.accepted);
        if(summary.rejected!==null) parts.push('거절 '+summary.rejected);
        if(summary.unresolved!==null) parts.push('미해결 '+summary.unresolved);
        if(summary.partial||summary.incomplete) parts.push('부분 결과');
        if(summary.remaining) parts.push('미검토 배치 '+summary.remaining+'개');
        nodes.resultCounts.textContent=parts.length?parts.join(' · '):'서버가 항목 수를 제공하지 않았습니다.';
        for(const row of summary.rows){
          nodes.resultItems.append(el('li',{className:'hosted-ai-item'},
            el('span',{className:'hosted-ai-item-status',textContent:row.status==='rejected'?'거절':'미해결'}),
            el('span',{className:'hosted-ai-item-name',textContent:row.label||'(설명 없음)'})));
        }
        const notes=[];
        if(summary.partial||summary.incomplete||state.job.state==='interrupted') notes.push('실행이 완료되지 않아 일부 결과만 있을 수 있습니다. 서버가 보고한 미검토 배치는 다시 실행하기 전까지 검토되지 않았습니다. 자동으로 다시 실행하지 않았습니다.');
        if(summary.total===null&&summary.accepted===null&&summary.rejected===null&&summary.unresolved===null) notes.push('결과 요약 형식이 이 화면과 다릅니다. 결과 파일이 있으면 내려받아 확인하세요.');
        nodes.resultNote.textContent=notes.join(' ');
        setHidden(nodes.resultNote,!notes.length);
      }

      const artifacts=state.job&&Array.isArray(state.job.artifacts)
        ?state.job.artifacts.filter(a=>a&&typeof a.id==='string'&&a.id)
        :[];
      setHidden(nodes.artifactsSection,!artifacts.length);
      clearList(nodes.artifacts);
      for(const artifact of artifacts){
        const button=el('button',{type:'button',className:'button secondary',textContent:'내려받기'});
        button.addEventListener('click',()=>{downloadArtifact(artifact);});
        const meta=[artifact.mime,sizeLabel(artifact.bytes)].filter(value=>typeof value==='string'&&value&&value!=='크기 정보 없음');
        nodes.artifacts.append(el('li',{className:'hosted-ai-item hosted-ai-artifact'},
          el('span',{className:'hosted-ai-item-name',textContent:safeName(artifact.name)||'결과 파일'}),
          el('span',{className:'muted',textContent:meta.join(' · ')||'파일 정보 없음'}),
          button));
      }
      nodes.downloadStatus.textContent=state.downloadStatus||'';
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
