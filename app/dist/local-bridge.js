/* Shared local broker link: same-origin session on the companion itself, or explicit token pairing from the hosted page. */
(function(root){
  'use strict';
  const HOST='127.0.0.1',DEFAULT_PORT=7816,WEB_ORIGIN='https://shinick-han.github.io';
  const PATH=/^\/api\/(?:capabilities|export|(?:red|blue)\/jobs(?:\/[A-Za-z0-9%._~-]+(?:\/cancel)?)?)$/;
  // Strict decimal port only; host and scheme are never user input.
  function parsePort(value){const s=String(value??'').trim();if(s==='')return DEFAULT_PORT;if(!/^[1-9][0-9]{3,4}$/.test(s))return null;const n=Number(s);return n>=1024&&n<=65535?n:null;}
  function validToken(t){return typeof t==='string'&&t.length>=16&&t.length<=512&&/^[A-Za-z0-9._~+/-]+=*$/.test(t);}
  function command(port){return 'python app/local/server.py --web-origin '+WEB_ORIGIN+(port&&port!==DEFAULT_PORT?' --port '+port:'');}
  function launcher(port){return 'powershell -NoProfile -ExecutionPolicy Bypass -File ./start-companion.ps1'+(port&&port!==DEFAULT_PORT?' -Port '+port:'');}
  function capSnapshot(d){if(!d||typeof d!=='object'||Array.isArray(d)||typeof d.red!=='boolean'||typeof d.blue!=='boolean')return null;
    return Object.freeze({red:d.red,blue:d.blue,pdf:d.pdf===true,officeLayoutVerifiedExport:d.officeLayoutVerifiedExport===true,model:typeof d.model==='string'?d.model.slice(0,80):null,isolation:typeof d.isolation==='string'?d.isolation.slice(0,200):null});}
  const NETWORK='로컬 broker에 닿지 못했습니다. 서버 미실행·포트 불일치·--web-origin 누락(CORS 거부)·브라우저 로컬 네트워크 권한 차단 중 하나일 수 있습니다. 브라우저는 원인을 구분해 알려주지 않습니다.';

  function create({fetch:fetchImpl,location:loc,emit=()=>{}}){
    const local=loc.hostname===HOST;
    let status=local?'checking':'manual',error='',link=null,cap=null,attempt=0,port=local?Number(loc.port)||80:DEFAULT_PORT;
    const busy={red:false,blue:false};
    const frozen=()=>busy.red||busy.blue||!!link&&link.inflight>0;
    function state(){return Object.freeze({mode:local?'local':'hosted',status,error,port,frozen:frozen(),busy:Object.freeze({...busy}),connected:status==='local'||status==='paired',cap,command:command(port)});}
    const changed=()=>emit(state());
    function drop(l){if(l){l.alive=false;l.token=null;}}
    // One request against a fixed link snapshot. The token travels only in the Authorization header.
    async function call(l,path,body){
      if(!l||!l.alive||!l.token)throw new Error(local?'인증된 로컬 작업대 세션이 없습니다.':'로컬 broker에 먼저 연결하세요. 연결 없이는 수동 JSON 교환만 가능합니다.');
      if(typeof path!=='string'||!PATH.test(path)||/\/\.{1,2}(?:\/|$)/.test(path))throw new Error('허용되지 않은 로컬 경로입니다.');
      const init={method:body?'POST':'GET',headers:{Authorization:'Bearer '+l.token,...(body?{'Content-Type':'application/json'}:{})},credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'};
      if(body)init.body=JSON.stringify(body);
      if(l.remote){init.mode='cors';init.targetAddressSpace='loopback';}
      l.inflight++;if(l===link)changed();
      try{
        let res;try{res=await fetchImpl(l.remote?l.base+path:path,init);}catch{throw new Error(NETWORK);}
        if(res.redirected||res.type==='opaqueredirect')throw new Error('로컬 broker 리디렉션을 거부했습니다.');
        let data=null;try{data=await res.json();}catch{}
        if(!res.ok){if(res.status===401||res.status===403)throw new Error('로컬 broker가 인증을 거부했습니다 ('+res.status+'). 토큰·포트·--web-origin을 확인하세요.');throw new Error(typeof data?.error==='string'?data.error.slice(0,300):'로컬 요청 실패 ('+res.status+')');}
        if(!data||typeof data!=='object')throw new Error('로컬 broker 응답이 JSON 객체가 아닙니다.');
        return data;
      }finally{l.inflight--;if(l===link)changed();}
    }
    function session(){const l=link;if(!l||!l.alive||!(status==='local'||status==='paired'))return null;return Object.freeze({request:(path,body)=>call(l,path,body)});}
    async function boot(){
      if(!local){changed();return;}
      try{const r=await fetchImpl('/api/session',{cache:'no-store',redirect:'error'});if(!r.ok)throw new Error();const s=await r.json();if(!validToken(s?.token))throw new Error();
        const l={token:s.token,base:'',remote:false,alive:true,inflight:0},next=capSnapshot(await call(l,'/api/capabilities'));if(!next){drop(l);throw new Error();}
        link=l;cap=next;status='local';error='';}
      catch{status='local-unavailable';error='';}
      changed();
    }
    // Pairing only verifies authenticated capabilities. It never starts jobs, records consent or calls a CLI.
    async function pair(rawToken,rawPort){
      const fail=message=>{error=message;changed();return {ok:false,error:message};};
      if(local)return fail('로컬 작업대는 same-origin 세션을 사용합니다. 페어링이 필요 없습니다.');
      if(frozen())return fail('RED/BLUE 작업 중에는 연결을 바꿀 수 없습니다.');
      const p=parsePort(rawPort);if(p===null)return fail('포트는 1024–65535 사이 정수만 허용합니다. 주소는 항상 http://127.0.0.1입니다.');
      const t=typeof rawToken==='string'?rawToken.trim():'';if(!t)return fail('터미널에 표시된 페어링 토큰을 붙여넣으세요.');if(!validToken(t))return fail('토큰 형식이 올바르지 않습니다. 터미널의 페어링 토큰 한 줄만 붙여넣으세요.');
      const id=++attempt;drop(link);link=null;cap=null;port=p;status='connecting';error='';changed();
      const candidate={token:t,base:'http://'+HOST+':'+p,remote:true,alive:true,inflight:0};
      try{const next=capSnapshot(await call(candidate,'/api/capabilities'));
        if(id!==attempt){drop(candidate);return {ok:false,error:'stale'};}
        if(!next)throw new Error('capabilities 응답 형식이 올바르지 않아 연결하지 않았습니다.');
        link=candidate;cap=next;status='paired';error='';changed();return {ok:true};}
      catch(e){drop(candidate);if(id!==attempt)return {ok:false,error:'stale'};status='manual';return fail(e.message);}
    }
    function disconnect(){if(local)return {ok:false,error:'로컬 작업대 세션은 끊지 않습니다.'};if(frozen()){error='RED/BLUE 작업 중에는 연결을 끊을 수 없습니다.';changed();return {ok:false,error};}
      attempt++;drop(link);link=null;cap=null;status='manual';error='';changed();return {ok:true};}
    function setBusy(role,value){if(!Object.hasOwn(busy,role))return;value=!!value;if(busy[role]===value)return;busy[role]=value;changed();}
    function setPort(value){if(local||status==='connecting'||link)return null;const p=parsePort(value);if(p!==null&&p!==port){port=p;changed();}return p;}
    const ready=boot();
    return Object.freeze({ready,state,session,pair,disconnect,busy:setBusy,setPort,capabilities:()=>cap});
  }

  function mount(bridge,doc){
    const $=id=>doc.getElementById(id),panel=$('local-bridge');if(!panel)return;
    const statusEl=$('bridge-status'),pairEl=$('bridge-pair'),portEl=$('bridge-port'),tokenEl=$('bridge-token'),connectEl=$('bridge-connect'),disconnectEl=$('bridge-disconnect'),commandEl=$('bridge-command'),launcherEl=$('bridge-launcher'),feedbackEl=$('bridge-feedback');
    function text(s){const c=s.cap,detail=c?' · RED '+(c.red?'가능':'불가')+' · BLUE '+(c.blue?'가능':'불가')+' · PDF 보존 '+(c.pdf?'가능':'불가'):'';
      if(s.status==='checking')return '로컬 작업대 세션 확인 중';
      if(s.status==='local')return '로컬 작업대 · same-origin 세션 (페어링 불필요)'+detail;
      if(s.status==='local-unavailable')return '정적 미리보기 · 인증된 로컬 broker 없음 · 파일 추출과 수동 JSON 교환만 가능';
      if(s.status==='connecting')return 'http://127.0.0.1:'+s.port+' 인증 확인 중';
      if(s.status==='paired')return '페어링됨 · http://127.0.0.1:'+s.port+' · 인증된 capabilities 확인'+detail;
      return '연결 안 됨 · 수동 JSON 교환 모드';}
    function render(s=bridge.state()){
      panel.dataset.state=s.status;statusEl.textContent=text(s)+(s.frozen&&s.connected?' · 작업 중이라 연결 변경 잠김':'');
      if(pairEl)pairEl.hidden=s.mode==='local';
      if(feedbackEl){feedbackEl.textContent=s.error;feedbackEl.classList?.toggle('error',!!s.error);}
      const linked=s.status==='paired'||s.status==='connecting';
      if(portEl)portEl.disabled=s.frozen||linked;if(tokenEl)tokenEl.disabled=s.frozen||linked;
      if(connectEl)connectEl.disabled=s.frozen||linked;if(disconnectEl){disconnectEl.hidden=!linked;disconnectEl.disabled=s.frozen;}
      const p=linked?s.port:parsePort(portEl?.value)??s.port;if(commandEl)commandEl.textContent=command(p);if(launcherEl)launcherEl.textContent=launcher(p);
      for(const a of doc.querySelectorAll?.('[data-bridge-local]')||[])a.href='http://127.0.0.1:'+(s.mode==='local'?s.port:p)+'/';
    }
    render();
    doc.addEventListener('falsify:local-bridge',e=>render(e.detail));
    portEl?.addEventListener('input',()=>{bridge.setPort(portEl.value);render();});
    // The token field is cleared on every attempt; the value lives only inside the bridge closure after success.
    connectEl?.addEventListener('click',async()=>{const t=tokenEl.value;tokenEl.value='';await bridge.pair(t,portEl?.value);});
    tokenEl?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();connectEl.click();}});
    disconnectEl?.addEventListener('click',()=>bridge.disconnect());
  }

  if(typeof module==='object'&&module.exports){module.exports={create,mount,parsePort,validToken,command,launcher,DEFAULT_PORT};return;}
  const bridge=create({fetch:(...args)=>root.fetch(...args),location:root.location,emit:detail=>root.document.dispatchEvent(new CustomEvent('falsify:local-bridge',{detail}))});
  root.FalsifyLocalBridge=bridge;mount(bridge,root.document);
})(typeof window==='object'?window:globalThis);
