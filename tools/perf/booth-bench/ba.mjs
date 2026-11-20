
import { start, client, pdfBytes, multipart, meta, OPERATOR, median } from './bench-lib.mjs';
const mf = await start({ D1_LAT_MS: '22', UP_OAI_MS: '150', UP_PDF_MS: '250', RT_MS: '40', NOCACHE: '1', BOOTH_OPERATOR_ACTIVE_JOBS: '2', AI_GUESTS_PER_IP_HOUR: '5000' });
const call = client(mf);
await call('PUT','/v1/booth/admin/settings',{token:OPERATOR, body:{submissionsOpen:true, missions:[{id:'ragas',title:'Ragas',source:'arxiv',paperId:'2309.15217',license:'cc-by-4.0',course:'quick',pageHint:5,hint:'h'}]}});
const out = {};
const g = await call('POST','/v1/ai/guest',{body:{}}); const tok = g.json.guest.token;
const pdfMs = []; for (let i=0;i<6;i++) pdfMs.push((await call('GET','/v1/papers/pdf?id=2309.15217',{token:tok})).ms);
out.pdfFirst = +pdfMs[0].toFixed(0); out.pdfRepeatMedian = +median(pdfMs.slice(1)).toFixed(0);
const pdf = pdfBytes(220000, 3); const s = await call('POST','/v1/booth/submissions',{token:tok, raw: multipart(meta(pdf), pdf), headers:{'Content-Type':'multipart/form-data; boundary=----benchboundary'}});
const { receipt, claimKey } = s.json;
const post = [], get = []; let getStatus = null, d1post=null, d1get=null;
for (let i=0;i<7;i++){ const r = await call('POST','/v1/booth/claim',{body:{receipt,claimKey}}); post.push(r.ms); d1post=r.d1; }
for (let i=0;i<7;i++){ const r = await call('GET','/v1/booth/claim?receipt='+receipt+'&key='+claimKey); get.push(r.ms); getStatus=r.status; d1get=r.d1; }
out.claimPost = { median: +median(post).toFixed(0), d1: d1post };
out.claimGet = { median: +median(get).toFixed(0), status: getStatus, d1: d1get };
console.log('RESULT ' + JSON.stringify(out));
await mf.dispose();
