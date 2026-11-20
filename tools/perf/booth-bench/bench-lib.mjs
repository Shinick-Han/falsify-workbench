
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
const apiRoot = process.env.API_ROOT;
const entryFile = process.env.ENTRY;
const req = createRequire(path.join(apiRoot, 'package.json'));
const { Miniflare, convertV4MiniflareOptions } = req('miniflare');
const { build } = req('esbuild');
const repoRoot = path.resolve(apiRoot, '../..');
const ORIGIN = 'https://shinick-han.github.io';
const OPERATOR = 'fso_' + randomBytes(32).toString('base64url');
const SVC = 'svc-token-' + 'x'.repeat(30);
const CONSENT = '2026-11-22.v2';
const sha = b => createHash('sha256').update(b).digest('hex');
const median = a => { const s=[...a].sort((x,y)=>x-y); return s.length? s[Math.floor((s.length-1)/2)] : null; };

function stripSqlComments(sql){ return sql.split('\n').map(l=>{const i=l.indexOf('--'); return i>=0?l.slice(0,i):l;}).join('\n'); }
const statements = ['0001_shared_records.sql','0002_invite_membership.sql','0003_hosted_ai.sql','0004_owner_usage.sql','0005_guest_sessions.sql','0006_booth.sql','0007_booth_recipes.sql']
  .map(n=>readFileSync(path.join(apiRoot,'migrations',n),'utf8')).map(stripSqlComments).join('\n').split(';').map(s=>s.trim()).filter(Boolean);

const built = await build({ entryPoints:[entryFile], bundle:true, write:false, format:'esm', platform:'browser', external:['node:*'], logLevel:'silent' });
const script = built.outputFiles[0].text;

const WRANGLER_EVENT = JSON.parse(process.env.EVENT_VARS);
export async function start(extra = {}, { cache = true, port, origin } = {}) {
  const mf = new Miniflare(convertV4MiniflareOptions({ ...(port ? { port, host: '127.0.0.1' } : {}),
    modules: true, script, compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'],
    cache,
    bindings: { ...WRANGLER_EVENT, ALLOWED_ORIGINS: origin || ORIGIN, AI_RUNTIME_URL: 'https://runtime.test', HOSTED_AI_SERVICE_TOKEN: SVC, BOOTH_OPERATOR_TOKEN: OPERATOR, ...extra },
    d1Databases: ['DB'],
  }));
  const d1 = await mf.getD1Database('DB');
  for (const s of statements) await d1.prepare(s).run();
  return mf;
}
export function client(mf) {
  return async (method, p, { token, body, raw, headers = {}, ip = '203.0.113.7' } = {}) => {
    const h = { Origin: ORIGIN, 'CF-Connecting-IP': ip, ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    let payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    if (typeof payload === 'string' && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (payload && !h['Content-Length']) h['Content-Length'] = String(Buffer.byteLength(payload));
    const t0 = performance.now();
    const r = await mf.dispatchFetch('https://api.test' + p, { method, headers: h, body: payload });
    const bytes = new Uint8Array(await r.arrayBuffer());
    const ms = performance.now() - t0;
    let json = null; try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch {}
    return { status: r.status, ms, d1: r.headers.get('x-bench-d1'), json, bytes: bytes.byteLength, headers: r.headers };
  };
}
export const MULTI = '----benchboundary';
export function pdfBytes(n, seed) { const b = Buffer.alloc(n); b.write('%PDF-1.7\n'); for (let i=9;i<n;i++) b[i]=(i*7+seed)&255; return b; }
export function multipart(meta, pdf) {
  const head = Buffer.from('--'+MULTI+'\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'+JSON.stringify(meta)+'\r\n--'+MULTI+'\r\nContent-Disposition: form-data; name="pdf"; filename="edited.pdf"\r\nContent-Type: application/pdf\r\n\r\n');
  return Buffer.concat([head, pdf, Buffer.from('\r\n--'+MULTI+'--\r\n')]);
}
export const SOURCE = '11'.repeat(32);
export function meta(pdf) {
  return { course:'quick', declared:[{pageIndex:4,segmentId:'p5-s2',before:'0.95',after:'0.50',defectType:'number',reason:'x'}],
    paper:{source:'arxiv',id:'2309.15217',title:'Ragas',license:'cc-by-4.0',sourceSha256:SOURCE}, consentVersion:CONSENT, editedSha256: sha(pdf) };
}
export { OPERATOR, median, sha };
