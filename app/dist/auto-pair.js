/* Click pairing: the page mints challenge/state/proof and opens falsify:// with those nonces only.
   No bearer, password, command, or origin is placed in the link. After local approval the page
   redeems a short-lived reconnect credential. Refresh checks /api/pair/status and never posts a model job. */
(function(root){
  'use strict';
  const ORIGIN='https://shinick-han.github.io',HOST='127.0.0.1',STORE='falsify.reconnect.v1';
  const NONCE=/^[A-Za-z0-9_-]{43}$/,CRED=/^rc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function b64url(bytes){
    let out='',i=0;
    for(;i+3<=bytes.length;i+=3){const n=(bytes[i]<<16)|(bytes[i+1]<<8)|bytes[i+2];out+=ALPHABET[(n>>>18)&63]+ALPHABET[(n>>>12)&63]+ALPHABET[(n>>>6)&63]+ALPHABET[n&63];}
    if(i<bytes.length){const n=(bytes[i]<<16)|((i+1<bytes.length?bytes[i+1]:0)<<8);out+=ALPHABET[(n>>>18)&63]+ALPHABET[(n>>>12)&63];if(i+1<bytes.length)out+=ALPHABET[(n>>>6)&63];}
    return out;
  }
  function mint(random){
    const one=()=>{const b=new Uint8Array(32);random(b);const text=b64url(b);if(!NONCE.test(text))throw new Error('nonce');return text;};
    const triple={challenge:one(),state:one(),proof:one()};
    if(new Set([triple.challenge,triple.state,triple.proof]).size!==3)throw new Error('nonce');
    return triple;
  }
  function pairingUri(port,triple){
    if(!Number.isInteger(port)||port<1024||port>65535||!triple||!NONCE.test(triple.challenge)||!NONCE.test(triple.state)||!NONCE.test(triple.proof))return null;
    return 'falsify://connect?port='+port+'&challenge='+triple.challenge+'&state='+triple.state+'&proof='+triple.proof;
  }
  function forbidden(uri){return !uri||/bearer|password|(?:^|[?&])(?:cmd|token|command|model|origin)=/i.test(uri)||uri.includes(ORIGIN)||uri.includes(' ');}

  function create(options={}){
    const fetchImpl=options.fetch,storage=options.storage,random=options.random,sleep=options.sleep||(()=>Promise.resolve());
    const attempts=options.attempts||8;
    if(typeof fetchImpl!=='function'||!storage||typeof random!=='function')throw new Error('auto-pair dependencies');
    function read(){
      let raw;try{raw=storage.getItem(STORE);}catch{return null;}
      if(typeof raw!=='string'||!raw)return null;
      let data;try{data=JSON.parse(raw);}catch{return null;}
      if(!data||typeof data!=='object'||data.origin!==ORIGIN||!CRED.test(data.credential)||!Number.isInteger(data.port)||data.port<1024||data.port>65535)return null;
      return {credential:data.credential,port:data.port,origin:ORIGIN,expiresAt:Number.isInteger(data.expiresAt)?data.expiresAt:null};
    }
    function write(data){storage.setItem(STORE,JSON.stringify({credential:data.credential,port:data.port,origin:ORIGIN,expiresAt:data.expiresAt}));}
    function forget(){try{storage.removeItem(STORE);}catch{}}
    async function redeemOnce(port,triple){
      const res=await fetchImpl('http://'+HOST+':'+port+'/api/pair/redeem',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challenge:triple.challenge,state:triple.state,proof:triple.proof}),credentials:'omit',redirect:'error',cache:'no-store',mode:'cors',referrerPolicy:'no-referrer',targetAddressSpace:'loopback'});
      if(res.redirected||res.type==='opaqueredirect')return {ok:false,error:'redirect',terminal:true};
      let data=null;try{data=await res.json();}catch{data=null;}
      if(!res.ok){const error=typeof data?.error==='string'?data.error:'rejected';return {ok:false,error,terminal:error!=='unknown_challenge'};}
      const credential=data?.credential;
      if(!CRED.test(credential)||credential.includes(triple.proof)||credential.includes(triple.challenge)||credential.includes(triple.state)||data.origin!==ORIGIN||data.port!==port)return {ok:false,error:'malformed',terminal:true};
      return {ok:true,credential,expiresAt:data.expiresAt,port};
    }
    async function begin({bridge,port,open}){
      const held=bridge.hold(port);
      if(!held.ok)return held;
      let triple;try{triple=mint(random);}catch{bridge.releaseHold();return bridge.report('일회용 연결 값을 만들지 못했습니다.');}
      const uri=pairingUri(held.port,triple);
      if(forbidden(uri)){bridge.releaseHold();return bridge.report('연결 링크가 거절되었습니다.');}
      if(typeof open!=='function'){bridge.releaseHold();return bridge.report('이 브라우저에서는 연결 앱 열기를 쓸 수 없습니다. 수동 실행을 쓰세요.');}
      try{open(uri);}catch{bridge.releaseHold();return bridge.report('브라우저가 연결 앱 열기를 막았습니다. 수동 실행을 쓰세요.');}
      let last='unknown_challenge';
      for(let i=0;i<attempts;i++){
        if(i)await sleep();
        try{
          const result=await redeemOnce(held.port,triple);
          if(result.ok){write(result);const paired=await bridge.pair(result.credential,String(held.port));if(!paired.ok)forget();return paired;}
          last=result.error||last;if(result.terminal)break;
        }catch{last='network';}
      }
      bridge.releaseHold();
      if(last==='unknown_challenge')return bridge.report('로컬 승인이 없거나 취소되었습니다. 연결 앱이 없으면 아무 일도 없을 수 있습니다. 브라우저는 설치 여부를 알려주지 않습니다. 수동 토큰을 쓰세요.');
      if(last==='network')return bridge.report('로컬 broker에 닿지 못했습니다. 브라우저의 로컬 네트워크 권한은 이 페이지가 대신 받을 수 없습니다.');
      return bridge.report('일회용 연결이 거절되었습니다 ('+String(last).slice(0,80)+').');
    }
    async function refresh(bridge){
      if(!bridge||bridge.state().mode==='local'||bridge.state().status==='paired'||bridge.state().status==='connecting')return {ok:false,skipped:true};
      const saved=read();
      if(!saved)return {ok:false,skipped:true};
      let res;
      try{res=await fetchImpl('http://'+HOST+':'+saved.port+'/api/pair/status',{method:'GET',headers:{Authorization:'Bearer '+saved.credential},credentials:'omit',redirect:'error',cache:'no-store',mode:'cors',referrerPolicy:'no-referrer',targetAddressSpace:'loopback'});}
      catch{return {ok:false,error:'network'};}
      let data=null;try{data=await res.json();}catch{data=null;}
      if(!res.ok||data?.paired!==true||data.origin!==ORIGIN||data.port!==saved.port){forget();return {ok:false,error:typeof data?.error==='string'?data.error:'rejected'};}
      const paired=await bridge.pair(saved.credential,String(saved.port));
      if(!paired.ok)forget();
      return paired;
    }
    let hooked=false;
    const api={begin,refresh,forget,read,pairingUri,mint};
    api.attach=(bridge,doc)=>{
      if(hooked)return Promise.resolve({ok:false,skipped:true});
      hooked=true;
      return attach(bridge,doc,api);
    };
    return Object.freeze(api);
  }

  function attach(bridge,doc,api){
    const launch=doc&&typeof doc.getElementById==='function'?doc.getElementById('bridge-launch'):null;
    if(launch)launch.hidden=false;
    if(!bridge||bridge.state().mode==='local')return Promise.resolve({ok:false,skipped:true});
    return Promise.resolve(bridge.ready).then(()=>api.refresh(bridge));
  }

  if(typeof module==='object'&&module.exports){module.exports={create,pairingUri,mint,b64url,attach,forbidden,ORIGIN,STORE,NONCE,CRED};return;}
  const api=create({fetch:(...args)=>root.fetch(...args),storage:root.sessionStorage,random:buf=>root.crypto.getRandomValues(buf)});
  root.FalsifyAutoPair=api;
  if(root.FalsifyLocalBridge)api.attach(root.FalsifyLocalBridge,root.document);
})(typeof window==='object'?window:globalThis);
