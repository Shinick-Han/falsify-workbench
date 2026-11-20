
import { start, client, pdfBytes, multipart, meta, OPERATOR, median, SOURCE } from './bench-lib.mjs';
const D1 = process.env.D1_LAT_MS || '0';
const CACHE = process.env.CACHE !== '0';
const PDFSIZE = Number(process.env.SUB_BYTES || 1700000);
const N = Number(process.env.N || 5);
const mf = await start({ D1_LAT_MS: D1, UP_OAI_MS: process.env.UP_OAI_MS||'150', UP_PDF_MS: process.env.UP_PDF_MS||'250', RT_MS: process.env.RT_MS||'40', PDF_BYTES: '232000', BOOTH_OPERATOR_ACTIVE_JOBS: process.env.ACTIVE||'2', NOCACHE: CACHE?'0':'1' }, { cache: CACHE });
const call = client(mf);
const missions = [{id:'ragas',title:'Ragas',source:'arxiv',paperId:'2309.15217',license:'cc-by-4.0',course:'quick',pageHint:5,hint:'h',sourceSha256:SOURCE}];
let r = await call('PUT','/v1/booth/admin/settings',{token:OPERATOR, body:{submissionsOpen:true, missions}});
if (r.status!==200) { console.error('settings', r.status, JSON.stringify(r.json)); process.exit(1); }
const rows = {};
const add = (k, res) => { (rows[k] ||= []).push(res); };
for (let i=0;i<N;i++){
  const ip = '198.51.100.'+(10+i);
  add('GET config', await call('GET','/v1/booth/config',{ip}));
  const g = await call('POST','/v1/ai/guest',{body:{},ip}); add('POST ai/guest', g);
  const tok = g.json?.guest?.token;
  add('GET papers/pdf', await call('GET','/v1/papers/pdf?id=2309.15217',{token:tok,ip}));
  add('GET missions/:id/text', await call('GET','/v1/booth/missions/2309.15217/text',{ip}));
  const pdf = pdfBytes(PDFSIZE, i+Number(D1)+ (CACHE?0:100));
  const raw = multipart(meta(pdf), pdf);
  const s = await call('POST','/v1/booth/submissions',{token:tok, raw, headers:{'Content-Type':'multipart/form-data; boundary=----benchboundary'}, ip});
  add('POST submissions('+(PDFSIZE/1e6).toFixed(1)+'MB)', s);
  if (s.status!==201) console.error('submit', s.status, JSON.stringify(s.json));
  const receipt = s.json?.receipt, claimKey = s.json?.claimKey;
  add('POST claim', await call('POST','/v1/booth/claim',{body:{receipt,claimKey},ip}));
  // operator pipeline
  add('OP GET admin list', await call('GET','/v1/booth/admin/submissions?status=received,reviewing&limit=200',{token:OPERATOR}));
  add('OP PATCH reviewing', await call('PATCH','/v1/booth/admin/submissions/'+receipt,{token:OPERATOR, body:{status:'reviewing'}}));
  const ap = await call('GET','/v1/booth/admin/submissions/'+receipt+'/pdf',{token:OPERATOR}); add('OP GET admin pdf', ap);
  const up = await call('POST','/v1/ai/uploads',{token:OPERATOR, raw: pdf, headers:{'Content-Type':'application/pdf','X-Falsify-File-Name':'F.pdf'}}); add('OP POST ai/uploads', up);
  const job = await call('POST','/v1/ai/jobs',{token:OPERATOR, body:{role:'blue',prompt:'find defect',uploadId:up.json?.upload?.id,idempotencyKey:'k'.repeat(10)+i+'x'+D1+(CACHE?'c':'n'),model:'claude-sonnet-5-5',effort:'high',budget:{maxCalls:8},useEvidence:true}}); add('OP POST ai/jobs', job);
  if (job.status>=300) console.error('job', job.status, JSON.stringify(job.json));
  add('OP GET ai/jobs/:id (poll)', await call('GET','/v1/ai/jobs/'+job.json?.job?.id,{token:OPERATOR}));
  add('OP PATCH judged+publish', await call('PATCH','/v1/booth/admin/submissions/'+receipt,{token:OPERATOR, body:{status:'judged',outcome:'missed',publicNote:'n',published:true}}));
  add('POST claim (result)', await call('POST','/v1/booth/claim',{body:{receipt,claimKey},ip}));
}
const out = {};
for (const [k, list] of Object.entries(rows)) out[k] = { status: [...new Set(list.map(x=>x.status))].join('/'), msMedian: +median(list.map(x=>x.ms)).toFixed(1), msFirst:+list[0].ms.toFixed(1), d1: list[0].d1, d1Later: list[list.length-1].d1 };
console.log(JSON.stringify({D1, CACHE, PDFSIZE, out}));
await mf.dispose();
