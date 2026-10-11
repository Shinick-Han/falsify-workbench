(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyHarness=api;})(globalThis,function(){
  'use strict';
  const keys=['id','instructions','maxCalls','name','role','schema','version'];
  function validate(h,role){
    if(!h||typeof h!=='object'||keys.some(k=>!Object.hasOwn(h,k))||Object.keys(h).some(k=>!keys.includes(k)&&!['adapter','settings'].includes(k))||h.schema!=='falsify.harness.v1'||!['red','blue'].includes(h.role)||role&&h.role!==role)throw Error('harness 스키마·역할·허용 필드를 확인하세요.');
    for(const k of ['id','version'])if(typeof h[k]!=='string'||! /^[A-Za-z0-9_.-]{1,80}$/.test(h[k]))throw Error('ID/버전: 영문·숫자·._- 1–80자');
    for(const [k,n] of [['name',120],['instructions',8000]])if(typeof h[k]!=='string'||!h[k].trim()||h[k].length>n||h[k].includes('\0'))throw Error('이름/지침 길이 제한 초과');
    if(!Number.isInteger(h.maxCalls)||h.maxCalls<1||h.maxCalls>32)throw Error('호출 한도는 1–32회입니다.');
    if(Object.hasOwn(h,'adapter')){const a=h.adapter;if(!a||typeof a!=='object'||!['codex','stdio','http'].includes(a.type))throw Error('adapter: codex / stdio / http');
      if(a.type==='codex'&&Object.keys(a).join()!=='type')throw Error('Codex adapter 필드 오류');
      if(a.type==='stdio'&&(Object.keys(a).sort().join()!=='args,executable,type'||typeof a.executable!=='string'||a.executable.includes('\0')||! /^(?:[A-Za-z]:[\\/]|\/)/.test(a.executable)||!Array.isArray(a.args)||a.args.length>32||a.args.some(x=>typeof x!=='string'||x.length>2000||x.includes('\0'))))throw Error('stdio: executable 절대 경로, args 문자열 배열');
      if(a.type==='http'){let u;try{u=new URL(a.url);}catch{throw Error('외부 adapter URL 오류');}if(Object.keys(a).sort().join()!=='type,url'||typeof a.url!=='string'||a.url.length>2000||u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('외부 adapter는 자격증명·쿼리 없는 HTTPS만 허용');}}
    if(Object.hasOwn(h,'settings')&&(!h.settings||typeof h.settings!=='object'||Array.isArray(h.settings)||JSON.stringify(h.settings).length>32000))throw Error('settings는 JSON 객체 32,000자 이내');
    return JSON.parse(JSON.stringify(h));
  }
  function sorted(v){return Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;}
  const canonical=h=>JSON.stringify(sorted(validate(h)));
  async function hash(h){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(h))))).map(x=>x.toString(16).padStart(2,'0')).join('');}
  const builtin=role=>validate({schema:'falsify.harness.v1',id:'builtin-'+role,name:'기본 '+role.toUpperCase(),version:'1',role,instructions:'Focus on explicit internal contradictions and quote the exact supporting evidence.',maxCalls:8});
  function summarize(runs,reviews){
    const groups=new Map();
    for(const r of runs){const key=[r.role,r.harnessHash,r.model,r.sourceHash,r.level||'-',r.maxCalls].join('|');
      if(!groups.has(key))groups.set(key,{role:r.role,harness:r.harness,hash:r.harnessHash,model:r.model,sourceHash:r.sourceHash,level:r.level,maxCalls:r.maxCalls,runs:0,reviewed:0,scores:[],uncertain:0,manual:0});
      const g=groups.get(key);g.runs++;if(r.provenance!=='local-codex')g.manual++;
      const latest=reviews.filter(v=>v.runId===r.id).at(-1);if(latest){g.reviewed++;if(latest.verdict==='uncertain')g.uncertain++;if(latest.score!==null&&latest.verdict!=='uncertain')g.scores.push(latest.score);}
    }
    return [...groups.values()].map(g=>({...g,mean:g.scores.length?g.scores.reduce((a,b)=>a+b,0)/g.scores.length:null}));
  }
  return {validate,canonical,hash,builtin,summarize};
});
