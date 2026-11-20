
import { start, client, pdfBytes, multipart, meta, OPERATOR, median, SOURCE } from './bench-lib.mjs';
const D1 = process.env.D1_LAT_MS || '22';
const mf = await start({ D1_LAT_MS: D1, BOOTH_OPERATOR_ACTIVE_JOBS: '50' });
const call = client(mf);
await call('PUT','/v1/booth/admin/settings',{token:OPERATOR, body:{submissionsOpen:true, missions:[{id:'ragas',title:'Ragas',source:'arxiv',paperId:'2309.15217',license:'cc-by-4.0',course:'quick',pageHint:5,hint:'h'}]}});
const out = { sizes: {}, hol: {} };
let n = 0;
async function guest(){ const g = await call('POST','/v1/ai/guest',{body:{},ip:'198.51.100.'+(++n%200)}); return g.json.guest.token; }
async function submit(size, seed){ const tok = await guest(); const pdf = pdfBytes(size, seed); const raw = multipart(meta(pdf), pdf);
  return call('POST','/v1/booth/submissions',{token:tok, raw, headers:{'Content-Type':'multipart/form-data; boundary=----benchboundary'}, ip:'198.51.100.'+(n%200)}); }
let seed = 1;
for (const size of [250e3, 1.7e6, 8e6, 16e6]) {
  const ms = [];
  for (let i=0;i<3;i++){ const r = await submit(size, seed++); if (r.status!==201) console.error(size, r.status, JSON.stringify(r.json)); ms.push(r.ms); }
  out.sizes[(size/1e6)+'MB'] = { median: +median(ms).toFixed(0), all: ms.map(x=>+x.toFixed(0)) };
}
// claim baseline
const s0 = await submit(250e3, seed++); const rc = s0.json;
async function claims(k){ const t=[]; await Promise.all(Array.from({length:k},async(_,i)=>{ await new Promise(r=>setTimeout(r,i*40)); const r=await call('POST','/v1/booth/claim',{body:{receipt:rc.receipt,claimKey:rc.claimKey},ip:'192.0.2.'+i}); t.push(r.ms); })); return t; }
const base = await claims(20);
out.hol.claimBaseline = { median: +median(base).toFixed(0), max: +Math.max(...base).toFixed(0) };
for (const size of [8e6, 16e6]) {
  const subP = submit(size, seed++);
  const during = await claims(20);
  const sub = await subP;
  out.hol['claimDuring'+(size/1e6)+'MB'] = { median: +median(during).toFixed(0), max: +Math.max(...during).toFixed(0), submitMs: +sub.ms.toFixed(0) };
}
console.log('RESULT ' + JSON.stringify(out));
await mf.dispose();
