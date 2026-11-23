/* Open-access guest session for the event page. Active only when
   FalsifyCloudConfig.openAccess.enabled === true. The token and access key
   stay in sessionStorage and the guest request body; they are never logged. */
(function(root){
  'use strict';
  const TOKEN_RE=/^fsg_[A-Za-z0-9_-]{43}$/;
  const KEY_STORE='falsify.open-access.key.v1';
  const GUEST_PREFIX='falsify.open-access.guest.v1:';
  const NOTE='RED 검토, 수정 적용, BLUE 검토는 웹 실행 패널에서 로그인 없이 실행합니다.';
  const NOTE_NO_BLUE='RED 검토와 수정 적용은 웹 실행 패널에서 로그인 없이 실행합니다. BLUE 검토는 이 행사 화면에서 열리지 않습니다.';

  function readConfig(){
    try{return root.FalsifyCloudConfig||null;}catch{return null;}
  }
  function enabled(){
    const cfg=readConfig();
    return !!(cfg&&cfg.openAccess&&cfg.openAccess.enabled===true);
  }
  function parseBase(value){
    if(typeof value!=='string'||!value) return '';
    try{
      const url=new URL(value,root.location&&root.location.href);
      const loop=url.hostname==='127.0.0.1'||url.hostname==='localhost';
      if(url.protocol!=='https:'&&!(loop&&url.protocol==='http:')) return '';
      if(url.username||url.password||url.search||url.hash) return '';
      return url.origin+url.pathname.replace(/\/+$/,'');
    }catch{return '';}
  }
  function apiBase(){
    const cfg=readConfig();
    if(!cfg) return '';
    const hosted=cfg.hostedAi&&typeof cfg.hostedAi==='object'?cfg.hostedAi:null;
    return parseBase(hosted&&hosted.apiBase)||parseBase(cfg.apiBase);
  }
  function bag(){
    try{return root.sessionStorage||null;}catch{return null;}
  }
  function readItem(key){
    const store=bag();
    if(!store) return '';
    try{const value=store.getItem(key);return typeof value==='string'?value:'';}catch{return '';}
  }
  function writeItem(key,value){
    const store=bag();
    if(!store) return;
    try{store.setItem(key,value);}catch{}
  }
  function removeItem(key){
    const store=bag();
    if(!store) return;
    try{store.removeItem(key);}catch{}
  }
  function rememberKey(value){
    if(typeof value==='string'&&value.length>0&&value.length<=128) writeItem(KEY_STORE,value);
  }
  function storedKey(){
    const value=readItem(KEY_STORE);
    return value.length>0&&value.length<=128?value:'';
  }
  function stripFragment(loc){
    try{
      const path=(loc.pathname||'/')+(loc.search||'');
      root.history.replaceState(null,'',path||'/');
    }catch{}
  }
  function captureFragment(){
    const loc=root.location;
    if(!loc||typeof loc.hash!=='string'||loc.hash.length<3) return;
    const raw=loc.hash.charAt(0)==='#'?loc.hash.slice(1):loc.hash;
    let params=null;
    try{params=new URLSearchParams(raw);}catch{return;}
    if(!params.has('k')) return;
    rememberKey(params.get('k')||'');
    stripFragment(loc);
  }
  function guestPayload(){
    const key=storedKey();
    const body=key?JSON.stringify({accessKey:key}):'{}';
    return body.length<=1024?body:'{}';
  }
  function allowCode(value){
    return typeof value==='string'&&/^[a-z0-9_]{1,64}$/.test(value)?value:'';
  }
  function retryAfter(res){
    const headers=res&&res.headers;
    if(!headers||typeof headers.get!=='function') return 0;
    const raw=headers.get('Retry-After');
    const seconds=Number(raw);
    if(!Number.isFinite(seconds)||seconds<0||seconds>86400) return 0;
    return Math.ceil(seconds);
  }
  function guestError(res,data){
    const error=Error('guest');
    error.status=Number(res&&res.status)||0;
    const detail=data&&data.error&&typeof data.error==='object'?data.error:null;
    error.code=allowCode(detail&&detail.code);
    const wait=retryAfter(res);
    if(wait) error.retryAfter=wait;
    return error;
  }
  function createSession(baseOf,bodyOf){
    function guestStoreKey(){return GUEST_PREFIX+baseOf();}
    function guestFresh(data){
      if(!data.expiresAt) return true;
      const expires=Date.parse(data.expiresAt);
      return !Number.isFinite(expires)||expires>Date.now();
    }
    function readGuest(){
      const base=baseOf();
      if(!base) return '';
      let data=null;
      try{data=JSON.parse(readItem(guestStoreKey())||'');}catch{return '';}
      if(!data||data.apiBase!==base||typeof data.token!=='string'||!TOKEN_RE.test(data.token)) return '';
      if(!guestFresh(data)) return '';
      return data.token;
    }
    function writeGuest(token,expiresAt){
      const base=baseOf();
      if(!base||!TOKEN_RE.test(token)) return;
      const record={apiBase:base,token,expiresAt:typeof expiresAt==='string'?expiresAt:''};
      writeItem(guestStoreKey(),JSON.stringify(record));
    }
    function dropGuest(){
      const base=baseOf();
      if(base) removeItem(guestStoreKey());
    }
    function acceptGuest(data){
      const guest=data&&data.guest&&typeof data.guest==='object'?data.guest:null;
      const token=guest&&typeof guest.token==='string'?guest.token:'';
      const expiresAt=guest&&typeof guest.expiresAt==='string'?guest.expiresAt:'';
      if(!TOKEN_RE.test(token)) return '';
      writeGuest(token,expiresAt);
      return token;
    }
    let flight=null;
    let flightStamp=0;
    async function requestGuest(stamp){
      const base=baseOf();
      if(!base||typeof root.fetch!=='function'||stamp!==flightStamp) return '';
      let res=null;
      try{
        res=await root.fetch(base+'/v1/ai/guest',{
          method:'POST',headers:{'Content-Type':'application/json'},body:bodyOf(),
          credentials:'omit',redirect:'error',cache:'no-store',mode:'cors'
        });
      }catch{return '';}
      if(stamp!==flightStamp) return '';
      let data=null;
      try{data=await res.json();}catch{data=null;}
      if(stamp!==flightStamp) return '';
      if(!res.ok) throw guestError(res,data);
      return acceptGuest(data);
    }
    function invalidate(){flightStamp++;dropGuest();flight=null;}
    async function token(){
      const cached=readGuest();
      if(cached) return cached;
      if(!flight){
        const stamp=flightStamp;
        const run=requestGuest(stamp).finally(()=>{if(flight===run) flight=null;});
        flight=run;
      }
      return flight;
    }
    return {token,invalidate};
  }
  function markPage(){
    const doc=root.document;
    const el=doc&&doc.documentElement;
    if(el&&el.dataset) el.dataset.openAccess='';
  }
  function makeNote(){
    const doc=root.document;
    if(!doc||typeof doc.createElement!=='function') return null;
    const node=doc.createElement('p');
    node.className='muted';
    node.setAttribute('data-open-access-note','');
    node.textContent=NOTE;
    return node;
  }
  function placeAfter(id){
    const doc=root.document;
    if(!doc||typeof doc.getElementById!=='function') return;
    const anchor=doc.getElementById(id);
    if(!anchor||typeof anchor.after!=='function') return;
    const next=anchor.nextElementSibling;
    if(next&&typeof next.getAttribute==='function'&&next.getAttribute('data-open-access-note')!==null) return;
    const node=makeNote();
    if(node) anchor.after(node);
  }
  function placeInside(id){
    const doc=root.document;
    if(!doc||typeof doc.getElementById!=='function') return;
    const anchor=doc.getElementById(id);
    if(!anchor||typeof anchor.insertBefore!=='function') return;
    if(typeof anchor.querySelector==='function'&&anchor.querySelector('[data-open-access-note]')) return;
    const node=makeNote();
    if(node) anchor.insertBefore(node,anchor.firstChild||null);
  }
  function clearLoopback(){
    const doc=root.document;
    if(!doc||typeof doc.querySelectorAll!=='function') return;
    let nodes=[];
    try{nodes=[...doc.querySelectorAll('[data-bridge-local]')];}catch{nodes=[];}
    for(const node of nodes){
      if(node&&typeof node.removeAttribute==='function') node.removeAttribute('href');
    }
  }
  function notes(){
    const doc=root.document;
    if(!doc||typeof doc.querySelectorAll!=='function') return [];
    try{return [...doc.querySelectorAll('[data-open-access-note]')];}catch{return [];}
  }
  /* blueJobs === false must not promise a guest BLUE run. Absent or true keeps NOTE. */
  function applyBlueNote(allowed){
    const text=allowed===false?NOTE_NO_BLUE:NOTE;
    for(const node of notes()) if(node) node.textContent=text;
  }
  function watchCapabilities(){
    const doc=root.document;
    if(!doc||typeof doc.addEventListener!=='function') return;
    doc.addEventListener('falsify:hosted-capabilities',event=>{
      const detail=event&&event.detail;
      applyBlueNote(!(detail&&detail.blueJobs===false));
    });
  }
  function install(){
    markPage();
    captureFragment();
    clearLoopback();
    placeAfter('hosted-ai');
    placeInside('view-blue');
    watchCapabilities();
    const session=createSession(apiBase,guestPayload);
    root.FalsifyHostedSession={...session,forBase(base){
      if(base===apiBase()) return session;
      return createSession(()=>base,()=>'{}');
    }};
  }
  if(enabled()) install();
})(typeof window==='object'?window:globalThis);
