/* Hosted paper tools session. Maps companion paper paths onto POST /v1/ai/paper.
   Auth comes from FalsifyHostedAI.paperAuth. Errors match the local bridge shape. */
(function(root){
  'use strict';
  const ROUTE='/v1/ai/paper';
  const PATH=/^\/api\/paper\/(?:evidence\/prepare|evidence\/query|visual\/export|chart\/prepare|evidence\/jobs(?:\/[a-f0-9]{32}(?:\/cancel)?)?)$/;
  const CODE=/^[a-z0-9_]{1,64}$/;
  function ai(){return root.FalsifyHostedAI||root.FalsifyHostedAi||null;}
  function tools(){
    const host=ai();
    const value=host&&host.paperTools;
    return value&&value.enabled===true?value:null;
  }
  function available(){return !!tools();}
  function offered(key){
    const value=tools();
    if(!value) return false;
    if(typeof value[key]==='boolean') return value[key];
    return true;
  }
  function flag(on,schema){return Object.freeze({supported:on,schema});}
  function capabilities(){
    if(!available()) return null;
    const visual=offered('visualEditor');
    const chart=offered('chartEdit');
    const analysis=offered('analysis');
    return Object.freeze({
      visualEditor:flag(visual,'falsify.visual-edit-request.v1'),
      chartEditor:Object.freeze({available:chart,schema:'falsify.chart-edit-plan.v1'}),
      paperEvidence:Object.freeze({available:visual,schema:'falsify.paper-evidence.v1'}),
      paperEnrichment:Object.freeze({supported:analysis,runtimeConfigured:analysis,schema:'falsify.paper-analysis.v1'})
    });
  }
  function aborted(){
    const error=new Error('로컬 요청을 중단했습니다.');
    error.name='AbortError';
    return error;
  }
  function authFailed(){
    const error=new Error('로컬 broker가 인증을 거부했습니다 (401). 토큰·포트·--web-origin을 확인하세요.');
    error.httpStatus=401;
    return error;
  }
  function badPath(){return new Error('허용되지 않은 로컬 경로입니다.');}
  function networkError(){
    return new Error('로컬 broker에 닿지 못했습니다. 서버 미실행·포트 불일치·--web-origin 누락(CORS 거부)·브라우저 로컬 네트워크 권한 차단 중 하나일 수 있습니다. 브라우저는 원인을 구분해 알려주지 않습니다.');
  }
  function pathOk(path){return typeof path==='string'&&PATH.test(path);}
  function signalOf(opts){return opts&&typeof opts==='object'?opts.signal:undefined;}
  function stopped(signal){return !!(signal&&signal.aborted);}
  function authOk(session){
    return !!(session&&typeof session.apiBase==='string'&&session.apiBase&&typeof session.token==='string'&&session.token);
  }
  function statusMessage(status, code){
    if(status===401||status===403) return '로컬 broker가 인증을 거부했습니다 ('+status+'). 토큰·포트·--web-origin을 확인하세요.';
    if(code) return code;
    return '로컬 요청 실패 ('+status+')';
  }
  function errorCode(detail, data){
    if(detail&&typeof detail.code==='string'&&CODE.test(detail.code)) return detail.code;
    if(data&&typeof data.error==='string') return data.error.slice(0,300);
    return '';
  }
  function statusError(status, data){
    const detail=data&&data.error&&typeof data.error==='object'&&!Array.isArray(data.error)?data.error:null;
    const code=errorCode(detail, data);
    const error=new Error(statusMessage(status, code));
    error.httpStatus=status;
    if(code) error.code=code;
    return error;
  }
  async function authorize(signal){
    if(stopped(signal)) throw aborted();
    const auth=ai();
    if(!auth||typeof auth.paperAuth!=='function') throw authFailed();
    let session=null;
    try{session=await auth.paperAuth();}catch(error){
      if(stopped(signal)||error&&error.name==='AbortError') throw aborted();
      if(error&&(error.httpStatus===401||error.httpStatus===403)) throw error;
      throw authFailed();
    }
    if(stopped(signal)) throw aborted();
    if(!authOk(session)) throw authFailed();
    return session;
  }
  async function postPaper(session, payload, signal){
    try{
      return await root.fetch(session.apiBase+ROUTE,{
        method:'POST',
        headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},
        body:payload,
        signal,
        credentials:'omit',
        redirect:'error',
        cache:'no-store',
        mode:'cors'
      });
    }catch(error){
      if(stopped(signal)||error&&error.name==='AbortError') throw aborted();
      throw networkError();
    }
  }
  async function readJson(res){
    try{return await res.json();}catch{return null;}
  }
  function acceptBody(res, data, signal){
    if(stopped(signal)) throw aborted();
    if(res&&(res.redirected||res.type==='opaqueredirect')) throw new Error('로컬 broker 리디렉션을 거부했습니다.');
    if(!res||!res.ok) throw statusError(res&&res.status||0, data);
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('로컬 broker 응답이 JSON 객체가 아닙니다.');
    return data;
  }
  async function request(path, body, opts){
    if(!pathOk(path)) throw badPath();
    const signal=signalOf(opts);
    const session=await authorize(signal);
    const payload=JSON.stringify({path,body:body==null?null:body});
    const res=await postPaper(session, payload, signal);
    return acceptBody(res, await readJson(res), signal);
  }
  function session(){
    if(!available()) return null;
    return Object.freeze({request});
  }
  const api=Object.freeze({available,session,capabilities});
  root.FalsifyHostedPaperSession=api;
  if(typeof module==='object'&&module.exports) module.exports=api;
})(typeof globalThis==='object'?globalThis:this);
