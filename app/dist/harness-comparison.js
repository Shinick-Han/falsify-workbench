(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyComparison=api;})(globalThis,function(){
  'use strict';
  const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const sorted=x=>Array.isArray(x)?x.map(sorted):plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sorted(x[k])])):x;
  function identity(h){
    const p=h?.settings?.portableStrategy;
    if(!plain(p)||Object.keys(p).some(k=>!['schema','name','version','parameters','sourceDigest'].includes(k))||p.schema!=='falsify.portable-strategy.v1'||typeof p.name!=='string'||!p.name.trim()||typeof p.version!=='string'||!p.version.trim()||!plain(p.parameters)||('sourceDigest' in p&&!/^[a-f0-9]{64}$/.test(p.sourceDigest)))return null;
    try{return JSON.stringify(sorted(p));}catch{return null;}
  }
  async function strategyHash(h){const s=identity(h);if(!s)return null;return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');}
  const knownModel=m=>typeof m==='string'&&m.trim()&&!/unknown|unverified/i.test(m);
  const rubric=r=>{const x=r?.harness?.settings?.comparisonRubric;return typeof x==='string'&&x.trim()?x:null;};
  function differences(a,b){const out=[];for(const [name,x,y] of [['입력 해시',a.sourceHash,b.sourceHash],['역할',a.role,b.role],['출처',a.provenance,b.provenance],['예산',a.maxCalls,b.maxCalls],['RED 난이도',a.level??null,b.level??null]])if((name!=='RED 난이도'&&(x==null||y==null))||x!==y)out.push(name);
    if(!knownModel(a.model)||!knownModel(b.model)||a.model!==b.model)out.push('모델 표기 미상 또는 불일치');
    if(!rubric(a)||!rubric(b)||rubric(a)!==rubric(b))out.push('사람 rubric 미선언 또는 불일치');
    if(!identity(a.harness)||!identity(b.harness))out.push('portable 전략 미선언');return out;}
  function compare(runs,reviews,reference){const root=runs.filter(r=>!r.snapshotOf),byRoot=new Map(runs.map(r=>[r.id,r.snapshotOf||r.id]));const mapped=reviews.map(v=>({...v,runId:byRoot.get(v.runId)||v.runId}));const rows=[];
    for(const r of root){const reasons=differences(reference,r),latest=mapped.filter(v=>v.runId===r.id).at(-1);rows.push({run:r,reasons,comparable:!reasons.length,review:latest?latest.verdict:'unreviewed',strategy:identity(r.harness)});}
    const groups=new Map();for(const row of rows.filter(x=>x.comparable)){let g=groups.get(row.strategy);if(!g){g={strategy:row.strategy,runs:[],unreviewed:0,uncertain:0};groups.set(row.strategy,g);}g.runs.push(row.run);if(row.review==='unreviewed')g.unreviewed++;if(row.review==='uncertain')g.uncertain++;}
    return {rows,groups:[...groups.values()],observed:rows.filter(x=>x.comparable).length,excluded:rows.filter(x=>!x.comparable).length,unreviewed:rows.filter(x=>x.comparable&&x.review==='unreviewed').length,uncertain:rows.filter(x=>x.comparable&&x.review==='uncertain').length,missingAttempts:null,cost:null};}
  return {identity,strategyHash,differences,compare};
});
