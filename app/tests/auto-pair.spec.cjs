'use strict';
// Offline click-pairing client. Mocked fetch only: no browser, network, model, or real credential.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const L=require('../dist/local-bridge.js'),A=require('../dist/auto-pair.js');
const CAP={red:true,blue:true,pdf:false,model:'gpt-6.1-sol'};
const CRED='rc1.'+'A'.repeat(80)+'.'+'B'.repeat(43);
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
function memory(){const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),dump:()=>[...m.entries()]};}
function bridgeFor(queue){
  const calls=[];
  const fetch=(url,init)=>{calls.push({url,init:init||{}});const next=queue.shift();if(!next)return Promise.reject(new TypeError('no mock'));return Promise.resolve(next);};
  const bridge=L.create({fetch,location:{hostname:'shinick-han.github.io',port:'',origin:'https://shinick-han.github.io'},emit:()=>{}});
  return {bridge,calls,fetch};
}
const reply=(data,status=200)=>({ok:status>=200&&status<300,status,redirected:false,type:'cors',json:async()=>data});
function bytes(seed){let n=seed;return buf=>{for(let i=0;i<buf.length;i++){n=(n*1103515245+12345)>>>0;buf[i]=n&255;}};}

test('pairing URI carries nonces only',()=>{
  const triple=A.mint(bytes(7));
  const uri=A.pairingUri(7816,triple);
  assert.match(uri,/^falsify:\/\/connect\?port=7816&challenge=[A-Za-z0-9_-]{43}&state=[A-Za-z0-9_-]{43}&proof=[A-Za-z0-9_-]{43}$/);
  assert.equal(A.forbidden(uri),false);
  for(const bad of ['falsify://connect?port=7816&token=abc','falsify://connect?port=7816&cmd=calc','falsify://connect?port=7816&password=x','falsify://connect?port=7816&command=calc'])assert.equal(A.forbidden(bad),true);
  assert.equal(A.pairingUri(80,triple),null);
  assert.equal(A.b64url(new Uint8Array(32)).length,43);
});

test('user cancel never stores a credential or posts a model',async()=>{
  const {bridge,calls,fetch}=bridgeFor([reply({error:'unknown_challenge'},403)]);
  const storage=memory();const opened=[];
  const api=A.create({fetch,storage,random:bytes(3),attempts:1});
  const result=await api.begin({bridge,port:'7816',open:uri=>opened.push(uri)});
  assert.equal(result.ok,false);
  assert.match(result.error,/취소/);
  assert.equal(storage.dump().length,0);
  assert.equal(bridge.state().status,'manual');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'http://127.0.0.1:7816/api/pair/redeem');
  assert.equal(calls[0].init.method,'POST');
  assert.equal(calls[0].init.headers.Authorization,undefined);
  const body=JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(),['challenge','proof','state']);
  assert.equal(calls.some(c=>String(c.url).includes('/api/red/jobs')||String(c.url).includes('/api/blue/jobs')),false);
  assert.equal(opened.length,1);
  assert.equal(opened[0].includes('bearer')||opened[0].includes(A.ORIGIN),false);
});

test('redeem then capabilities; refresh is status plus capabilities and no model POST',async()=>{
  const queue=[reply({credential:CRED,expiresAt:1_700_000_000,origin:A.ORIGIN,port:7817}),reply(CAP),reply({revoked:true}),reply({schema:'falsify.pair-status.v1',paired:true,origin:A.ORIGIN,port:7817,via:'reconnect',expiresAt:1_700_000_000,credentialId:'ab'.repeat(16)}),reply(CAP)];
  const calls=[];
  const fetch=(url,init)=>{calls.push({url,init:init||{}});const next=queue.shift();if(!next)return Promise.reject(new TypeError('no mock'));return Promise.resolve(next);};
  const storage=memory();
  let api;
  const bridge=L.create({fetch,location:{hostname:'shinick-han.github.io',port:''},emit:()=>{},forget:()=>api.forget()});
  api=A.create({fetch,storage,random:bytes(9),attempts:1});
  assert.equal((await api.begin({bridge,port:'7817',open:()=>{}})).ok,true);
  assert.equal(bridge.state().status,'paired');
  assert.equal(bridge.state().port,7817);
  assert.equal(calls[1].url,'http://127.0.0.1:7817/api/capabilities');
  assert.equal(calls[1].init.method,'GET');
  assert.equal(calls[1].init.headers.Authorization,'Bearer '+CRED);
  assert.equal(JSON.stringify(bridge.state()).includes(CRED),false);
  const saved=storage.getItem(A.STORE);
  bridge.disconnect();
  assert.equal(storage.getItem(A.STORE),null);
  const revoke=calls.find(c=>c.url.endsWith('/api/pair/revoke'));
  assert.equal(revoke.init.method,'POST');
  assert.equal(JSON.parse(revoke.init.body).schema,'falsify.pair-revoke.v1');
  storage.setItem(A.STORE,saved);
  const again=L.create({fetch,location:{hostname:'shinick-han.github.io',port:''},emit:()=>{}});
  await again.ready;
  const before=calls.length;
  assert.equal((await api.refresh(again)).ok,true);
  const refreshCalls=calls.slice(before);
  assert.deepEqual(refreshCalls.map(c=>c.init.method),['GET','GET']);
  assert.equal(refreshCalls[0].url,'http://127.0.0.1:7817/api/pair/status');
  assert.equal(refreshCalls[1].url,'http://127.0.0.1:7817/api/capabilities');
  assert.equal(refreshCalls.some(c=>c.init.method==='POST'),false);
  assert.equal(again.state().connected,true);
});

test('revoked, expired, wrong port and wrong proof clear storage without a model call',async()=>{
  for(const error of ['revoked','expired','port_mismatch','wrong_proof','wrong_origin']){
    const {bridge,calls,fetch}=bridgeFor([reply({error},403)]);
    const storage=memory();
    storage.setItem(A.STORE,JSON.stringify({credential:CRED,port:7816,origin:A.ORIGIN,expiresAt:1}));
    const api=A.create({fetch,storage,random:bytes(1)});
    await bridge.ready;
    const result=await api.refresh(bridge);
    assert.equal(result.ok,false,error);
    assert.equal(storage.getItem(A.STORE),null,error);
    assert.equal(calls.length,1,error);
    assert.equal(calls[0].init.method,'GET');
    assert.equal(bridge.state().status,'manual');
  }
});

test('hosted load with no credential performs no fetch',async()=>{
  const {bridge,calls,fetch}=bridgeFor([]);
  const api=A.create({fetch,storage:memory(),random:bytes(2)});
  await bridge.ready;
  assert.equal((await api.refresh(bridge)).skipped,true);
  assert.equal(calls.length,0);
});

test('sources keep secrets out of logs and do not post jobs from the pairing script',()=>{
  const bridge=fs.readFileSync(path.join(__dirname,'../dist/local-bridge.js'),'utf8');
  const auto=fs.readFileSync(path.join(__dirname,'../dist/auto-pair.js'),'utf8');
  for(const bad of ['localStorage','sessionStorage','indexedDB','document.cookie','console.'])assert.equal(bridge.includes(bad),false,bad);
  assert.equal(auto.includes('localStorage'),false);
  assert.equal(auto.includes('console.'),false);
  assert.equal(auto.includes('/api/red/jobs'),false);
  assert.equal(auto.includes('/api/blue/jobs'),false);
  assert.equal(auto.includes('consent'),false);
  assert.equal(L.launchUri(7816),'falsify://connect?port=7816');
});

(async()=>{let passed=0;for(const [name,fn] of tests){try{await fn();passed++;console.log('PASS '+name);}catch(e){console.error('FAIL '+name);console.error(e);process.exitCode=1;}}
  console.log(JSON.stringify({passed,failed:tests.length-passed,skipped:0}));if(passed!==tests.length)process.exit(1);})();
