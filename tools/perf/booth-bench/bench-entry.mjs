// Bench entry: the event Worker with a counting/latency-injecting D1 proxy (D1_LAT_MS), stubbed arXiv/OAI/OpenAlex
// (UP_OAI_MS, UP_PDF_MS, MISSION_PDF_B64) and a stubbed hosted runtime (RT_MS). NOCACHE=1 models a no-op Cache API.
// Every response carries X-Bench-D1: <queries>;<batches>. Local only; nothing leaves the process.

import worker from '../../../cloud/api/src/index.js';
import { setAiFetchForTests } from '../../../cloud/api/src/ai-runtime-client.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function pdfOf(n){ const b = new Uint8Array(n); b.set(new TextEncoder().encode('%PDF-1.7\n')); for (let i=9;i<n;i++) b[i]=(i*31)&255; return b; }
let JOBS = new Map();
async function runtimeStub(url, init, env){
  const u = new URL(url); const m = (init&&init.method)||'GET';
  await sleep(Number(env.RT_MS||0));
  const reply=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{'Content-Type':'application/json'}});
  if (u.pathname==='/internal/v1/uploads' && m==='POST'){ const body=init.body; let bytes; if (body instanceof ArrayBuffer) bytes=new Uint8Array(body); else if (ArrayBuffer.isView(body)) bytes=body; else bytes=new Uint8Array(await new Response(body).arrayBuffer()); const d=await crypto.subtle.digest('SHA-256',bytes); const sha=[...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join(''); return reply(201,{upload:{id:'rt-'+sha.slice(0,32),sha256:sha,bytes:bytes.byteLength,name:'x.pdf',mime:'application/pdf',createdAt:new Date().toISOString()}}); }
  if (u.pathname==='/internal/v1/jobs' && m==='POST'){ const p=JSON.parse(init.body); const at=new Date().toISOString(); JOBS.set(p.jobId,{id:p.jobId,role:p.role,state:'queued',model:p.model,effort:p.effort,artifacts:[],createdAt:at,updatedAt:at}); return reply(202,JOBS.get(p.jobId)); }
  const s=/^\/internal\/v1\/jobs\/([^/]+)$/.exec(u.pathname); if (s){ const j=JOBS.get(s[1])||{id:s[1],role:'blue',state:'running',artifacts:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; return reply(200,{...j,state:'running'}); }
  return new Response('nf',{status:404});
}
setAiFetchForTests(runtimeStub);
let ENV = {};
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input==='string'?input:input.url);
  if (u.hostname==='oaipmh.arxiv.org'){ await sleep(Number(ENV.UP_OAI_MS||0)); return new Response('<OAI-PMH><GetRecord><record><metadata><arXiv><license>http://creativecommons.org/licenses/by/4.0/</license></arXiv></metadata></record></GetRecord></OAI-PMH>',{status:200,headers:{'Content-Type':'text/xml'}}); }
  if (u.hostname==='arxiv.org'){ await sleep(Number(ENV.UP_PDF_MS||0)); const b=ENV.MISSION_PDF_B64?Uint8Array.from(atob(ENV.MISSION_PDF_B64),c=>c.charCodeAt(0)):pdfOf(Number(ENV.PDF_BYTES||232000)); return new Response(b,{status:200,headers:{'Content-Type':'application/pdf','Content-Length':String(b.byteLength)}}); }
  if (u.hostname==='api.openalex.org'){ await sleep(Number(ENV.UP_OAI_MS||0)); return new Response(JSON.stringify({meta:{count:1},results:[]}),{status:200,headers:{'Content-Type':'application/json'}}); }
  // Local only: any other host is refused, so a bench run can never reach a live endpoint.
  throw new TypeError('booth-bench: refusing to fetch ' + u.origin);
};
function wrapStmt(st, stats, lat){
  return new Proxy(st, { get(t, k){
    if (k==='__raw') return t;
    if (k==='bind') return (...a)=>wrapStmt(t.bind(...a), stats, lat);
    if (k==='first'||k==='run'||k==='all'||k==='raw') return async (...a)=>{ stats.q++; const t0=Date.now(); if(lat) await sleep(lat); const r=await t[k](...a); stats.ms+=Date.now()-t0; return r; };
    const v=t[k]; return typeof v==='function'?v.bind(t):v; } });
}
function wrapDb(db, stats, lat){
  return new Proxy(db, { get(t,k){
    if (k==='prepare') return sql=>wrapStmt(t.prepare(sql), stats, lat);
    if (k==='batch') return async (list)=>{ stats.q++; stats.batch++; const t0=Date.now(); if(lat) await sleep(lat); const r=await t.batch(list.map(s=>s.__raw||s)); stats.ms+=Date.now()-t0; return r; };
    const v=t[k]; return typeof v==='function'?v.bind(t):v; } });
}
export default { async fetch(request, env, ctx){
  ENV = env;
  if (env.NOCACHE==='1' && !globalThis.__noCache) { globalThis.__noCache=true; Object.defineProperty(globalThis,'caches',{value:{default:{match:async()=>undefined,put:async()=>{}}},configurable:true}); }
  const stats={q:0,batch:0,ms:0};
  const lat = Number(env.D1_LAT_MS||0);
  const env2 = Object.assign({}, env, { DB: wrapDb(env.DB, stats, lat) });
  const res = await worker.fetch(request, env2, ctx);
  const h = new Headers(res.headers); h.set('X-Bench-D1', stats.q+';'+stats.batch);
  return new Response(res.body, {status: res.status, headers: h});
} };
