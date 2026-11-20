'use strict';
// Relocation fuzz on the real mission paper (arXiv 2309.15217, CC BY 4.0). event.html draws every page so the
// workspace holds its layout, page and paragraph text; then, in node, the workspace's relocation (the code of
// dist/paper-workspace.js, run in a sandbox) is asked to move three kinds of edit from every layout and page view
// onto a paragraph: a one-character change to every token (as a word tap sends it), and a change to every non-letter
// with the booth's own widening (short tokens, and single characters). A landing must be the same occurrence: the
// paragraph aligned onto the view puts it on the edited character. The only exceptions are the listed superscript
// marks whose line the view moved. Every affiliation mark of page 1 (but the lone trailing ∗ of column 2, which has
// two equal readings) and every footnote digit must still relocate, and the fraction bars of page 3 (|V| / |S|,
// "||V S||" in the paragraph) must never move.
// The API is stubbed. FALSIFY_BOOTH_MISSION_PDF names a local copy of the paper.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const dist = path.resolve(__dirname, '../dist');
const pdfPath = process.env.FALSIFY_BOOTH_MISSION_PDF || '';
if (!pdfPath) throw new Error('Set FALSIFY_BOOTH_MISSION_PDF to a local copy of arXiv 2309.15217 (the Ragas paper)');
const chrome = process.env.BROWSER_EXECUTABLE || undefined;
const api = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
const port = Number(process.env.BOOTH_RELOCATE_PORT || 8894);
const token = 'fsg_' + 'd'.repeat(43);
const pdfBytes = fs.readFileSync(pdfPath);
const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*'};
const vm = require('node:vm');

function serve() {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: dist, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PYTHONUNBUFFERED: '1'},
  });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.stderr.on('data', chunk => { text += chunk; });
  const ready = (async () => {
    const started = Date.now();
    while (Date.now() - started < 8000) {
      if (child.exitCode != null) throw new Error('http.server exited ' + child.exitCode + '\n' + text);
      try { if ((await fetch('http://127.0.0.1:' + port + '/event.html')).ok) return; } catch { /* not yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('http.server did not start\n' + text);
  })();
  return {child, ready};
}

function json(route, status, body) {
  return route.fulfill({status, contentType: 'application/json', headers: cors, body: JSON.stringify(body)});
}

function boothConfig() {
  return {
    enabled: true, submissionsOpen: true, announcement: '', consentVersion: '2026-11-22.v2',
    limits: {maxDeclared: 5, maxReason: 500, maxNickname: 24, maxPdfBytes: 16777216},
    missions: [{
      paperId: '2309.15217', title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
      license: 'cc-by-4.0', course: 'quick', hint: 'Table 1의 점수 하나를 바꿔 보세요', pageHint: 5,
    }],
  };
}

async function stubApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (!url.href.startsWith(api)) return route.abort();
  if (request.method() === 'OPTIONS') return route.fulfill({status: 204, headers: cors});
  if (request.method() === 'POST' && url.pathname === '/v1/ai/guest') {
    return json(route, 200, {guest: {token, expiresAt: new Date(Date.now() + 864e5).toISOString()}});
  }
  if (url.pathname === '/v1/ai/capabilities') {
    return json(route, 200, {enabled: true, provider: 'anthropic', execution: 'server', models: ['claude-opus-5-5'], efforts: ['high'],
      limits: {maxUploadBytes: 33554432, maxPromptChars: 8000}, modelJobs: false, blueJobs: false});
  }
  if (url.pathname === '/v1/booth/config') return json(route, 200, boothConfig());
  if (url.pathname === '/v1/papers/pdf') {
    return route.fulfill({status: 200, contentType: 'application/pdf',
      headers: {...cors, 'X-Falsify-Paper-License': 'cc-by-4.0', 'Content-Disposition': 'attachment; filename="2309.15217.pdf"'}, body: pdfBytes});
  }
  return json(route, 404, {error: {code: 'not_found'}});
}


/* The relocation functions of paper-workspace.js, from segmentKind up to widening, in a sandbox. */
function relocator(segments) {
  const code = fs.readFileSync(path.join(dist, 'paper-workspace.js'), 'utf8');
  const from = code.indexOf('    function segmentKind(id)');
  const to = code.indexOf('    function widening(api)');
  assert.ok(from > 0 && to > from, 'relocation block in paper-workspace.js');
  const body = 'const coreSegments=x=>Array.isArray(x)?x:[];' + code.slice(from, to) + ';return {repairEdit};';
  return vm.runInNewContext('(function(source){' + body + '})', {})({segments});
}
/* Semi-global affine alignment of a paragraph's ink onto a view's ink: every paragraph character is matched to a
   view character or left out; the view may skip any run (other columns, headers, marks moved to their own line)
   cheaply. Returns, for each paragraph text index, the view text index it sits on (or -1). */
function ink(text){const at=[];for(let k=0;k<text.length;k++)if(!/\s/.test(text[k]))at.push(k);return at;}
const NEG=-1e9;
function alignParagraph(view,para){
  const vi=ink(view),pi=ink(para),n=vi.length,m=pi.length,W=n+1;
  const v=vi.map(k=>view[k]),p=pi.map(k=>para[k]);
  const MATCH=2,MISS=-3,VOPEN=3,VEXT=0.05,POPEN=4,PEXT=1;
  let M=new Float64Array(W).fill(NEG),E=new Float64Array(W).fill(0),F=new Float64Array(W).fill(NEG);
  M[0]=0;
  const tM=new Uint8Array((m+1)*W),tE=new Uint8Array((m+1)*W),tF=new Uint8Array((m+1)*W);
  for(let i=1;i<=m;i++){
    const M2=new Float64Array(W),E2=new Float64Array(W),F2=new Float64Array(W);
    M2[0]=NEG;E2[0]=NEG;F2[0]=-POPEN-(i-1)*PEXT;tF[i*W]=2;
    for(let j=1;j<=n;j++){
      const s=p[i-1]===v[j-1]?MATCH:MISS;
      let best=M[j-1],t=0;if(E[j-1]>best){best=E[j-1];t=1;}if(F[j-1]>best){best=F[j-1];t=2;}
      M2[j]=best+s;tM[i*W+j]=t;
      const e1=M2[j-1]-VOPEN,e2=E2[j-1]-VEXT,e3=F2[j-1]-VOPEN;
      if(e1>=e2&&e1>=e3){E2[j]=e1;tE[i*W+j]=0;}else if(e2>=e3){E2[j]=e2;tE[i*W+j]=1;}else{E2[j]=e3;tE[i*W+j]=2;}
      const f1=M[j]-POPEN,f2=F[j]-PEXT,f3=E[j]-POPEN;
      if(f1>=f2&&f1>=f3){F2[j]=f1;tF[i*W+j]=0;}else if(f2>=f3){F2[j]=f2;tF[i*W+j]=2;}else{F2[j]=f3;tF[i*W+j]=1;}
    }
    M=M2;E=E2;F=F2;
  }
  let bj=0,bs=NEG,st=0;for(let j=0;j<=n;j++){if(M[j]>bs){bs=M[j];bj=j;st=0;}if(F[j]>bs){bs=F[j];bj=j;st=2;}}
  const out=new Map();let i=m,j=bj;
  while(i>0){
    if(st===0){out.set(pi[i-1],vi[j-1]);const t=tM[i*W+j];i--;j--;st=t;}
    else if(st===1){const t=tE[i*W+j];j--;st=t;if(j<=0&&i>0){st=2;}}
    else{out.set(pi[i-1],-1);const t=tF[i*W+j];i--;st=t;if(j===0)st=2;}
  }
  return out;
}

function occursOnce(text, part) { const at = text.indexOf(part); return at >= 0 && text.indexOf(part, at + 1) < 0; }
/* The booth's own widening (booth-recipe uniqueSpan): whole words both sides until unique in the segment. */
function uniqueSpan(text, start, end) {
  let from = start;
  let to = end;
  while (!occursOnce(text, text.slice(from, to)) && (from > 0 || to < text.length)) {
    from = Math.max(0, from - 1);
    while (from > 0 && !/\s/.test(text[from - 1])) from -= 1;
    to = Math.min(text.length, to + 1);
    while (to < text.length && !/\s/.test(text[to])) to += 1;
  }
  return {from, to};
}
const flat = text => text.replace(/\s+/g, ' ');
/* Superscript marks the views print on their own line, away from the word they belong to: the paragraph spot each
   lands on. These are the only landings the alignment cannot confirm, and each was checked by hand. */
const MOVED_MARKS = [
  /Shahul Es\[†\], Jithin/, /Jithin James\[†\], Luis/, /Anke\[∗\]♢/, /Anke∗\[♢\], Steven/,
  /Ragas\[1\], a/, /OpenAI API\[2\]\./, /this step\[3\]:/, /^2 \[3\]$/, /as WikiEval\[4\]\./, /of 2022\[5\]\./,
];
const MARK = /[†‡∗♢§¶*0-9]/;

/* Every edit of one kind on every layout and page view: word (one character of every token changed, the whole
   token as Before, as a word tap sends it), token (short tokens with a non-letter, widened as the booth widens)
   and character (one non-letter, widened). */
function edits(segments, mode, pageCount) {
  const out = [];
  for (const seg of segments) {
    if (seg.id.startsWith('paragraph:')) continue;
    const text = seg.text;
    if (mode === 'word') {
      for (const m of text.matchAll(/\S+/g)) {
        const n = pageCount(seg.pageIndex, m[0]);
        if (n === 1) continue;
        for (let i = m.index; i < m.index + m[0].length; i++) {
          const c = text[i];
          const rep = /[a-z]/.test(c) ? (c === 'x' ? 'y' : 'x') : /[A-Z]/.test(c) ? (c === 'X' ? 'Y' : 'X') : /[0-9]/.test(c) ? (c === '1' ? '2' : '1') : (c === ',' ? ';' : ',');
          out.push({seg, i, from: m.index, to: m.index + m[0].length, rep, codes: n ? ['AMBIGUOUS_MATCH'] : ['NOT_FOUND', 'AMBIGUOUS_MATCH']});
        }
      }
      continue;
    }
    for (let i = 0; i < text.length; i++) {
      if (!/[^\s\p{L}]/u.test(text[i])) continue;
      let span;
      if (mode === 'token') {
        let s = i; while (s > 0 && !/\s/.test(text[s - 1])) s--;
        let e = i; while (e < text.length && !/\s/.test(text[e])) e++;
        if (e - s > 6) continue;
        span = uniqueSpan(text, s, e);
      } else span = uniqueSpan(text, i, i + 1);
      const n = pageCount(seg.pageIndex, text.slice(span.from, span.to));
      if (mode === 'token' && n === 1) continue;
      out.push({seg, i, from: span.from, to: span.to, rep: text[i] === '1' ? '2' : '1', codes: [n ? 'AMBIGUOUS_MATCH' : 'NOT_FOUND']});
    }
  }
  return out;
}

/* A landing is right only when it is the same occurrence: the paragraph, aligned onto the view, puts the landed
   character on the very view character that was edited. */
function fuzz(segments, mode) {
  const W = relocator(segments);
  const byId = new Map(segments.map(s => [s.id, s]));
  const pageCount = (page, needle) => {
    let n = 0;
    const want = flat(needle);
    for (const seg of segments) {
      if (seg.pageIndex !== page || !seg.id.startsWith('paragraph:')) continue;
      const text = flat(seg.text);
      for (let at = text.indexOf(want); at >= 0; at = text.indexOf(want, at + 1)) n++;
    }
    return n;
  };
  const aligned = new Map();
  const rows = [];
  for (const e of edits(segments, mode, pageCount)) {
    const text = e.seg.text;
    const before = text.slice(e.from, e.to);
    const after = text.slice(e.from, e.i) + e.rep + text.slice(e.i + 1, e.to);
    const row = {seg: e.seg.id, page: e.seg.pageIndex, i: e.i, c: text[e.i], view: flat(text.slice(Math.max(0, e.i - 16), e.i) + '[' + text[e.i] + ']' + text.slice(e.i + 1, e.i + 16)), lands: []};
    for (const code of e.codes) {
      const out = W.repairEdit({id: 'x', segmentId: e.seg.id, pageIndex: e.seg.pageIndex, before, after, anchor: {start: e.from, end: e.to}}, code, []);
      if (!out || out.segmentId === e.seg.id) continue;
      let k = 0;
      while (k < out.before.length && out.before[k] === out.after[k]) k++;
      const at = out.anchor.start + k;
      const para = byId.get(out.segmentId).text;
      const key = e.seg.id + '|' + out.segmentId;
      if (!aligned.has(key)) aligned.set(key, alignParagraph(text, para));
      const land = flat(para.slice(Math.max(0, at - 12), at) + '[' + para[at] + ']' + para.slice(at + 1, at + 13)).trim();
      const same = para[at] === text[e.i] && aligned.get(key).get(at) === e.i;
      const mark = para[at] === text[e.i] && MARK.test(text[e.i]) && MOVED_MARKS.some(re => re.test(land));
      row.lands.push({land, wrong: !same && !mark});
    }
    rows.push(row);
  }
  return rows;
}

async function missionSegments(browser) {
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, deviceScaleFactor: 1, locale: 'ko-KR'});
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  const base = 'http://127.0.0.1:' + port + '/';
  await page.route('**/*', route => (route.request().url().startsWith(base) ? route.continue() : stubApi(route)));
  await page.goto(base + 'event.html');
  await page.locator('#booth-missions .booth-mission').first().click();
  await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'edit');
  for (let n = 1; n <= 8; n++) {
    let ok = false;
    for (let tries = 0; tries < 6 && !ok; tries++) {
      await page.evaluate(number => globalThis.FalsifyPaperWorkspace.showPage(number), n);
      ok = await page.waitForFunction(number => (globalThis.FalsifyPaperWorkspace.getSource().segments || []).some(s => s.pageIndex === number - 1 && s.id.startsWith('paragraph:')), n, {timeout: 8000}).then(() => true, () => false);
    }
    assert.ok(ok, 'paragraphs of page ' + n);
  }
  const segments = await page.evaluate(() => globalThis.FalsifyPaperWorkspace.getSource().segments.map(s => ({id: s.id, pageIndex: s.pageIndex, text: s.text})));
  await context.close();
  return segments;
}

async function main() {
  assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
  const server = serve();
  let browser = null;
  try {
    await server.ready;
    browser = await chromium.launch({executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    const segments = await missionSegments(browser);
    const report = [];
    for (const mode of ['word', 'token', 'character']) {
      const rows = fuzz(segments, mode);
      const moved = rows.filter(row => row.lands.length);
      const wrong = rows.filter(row => row.lands.some(land => land.wrong));
      report.push(mode + ': ' + rows.length + ' edits, ' + moved.length + ' moved, ' + wrong.length + ' wrong');
      assert.deepEqual(wrong.map(row => (row.page + 1) + ' ' + JSON.stringify(row.view) + ' -> ' + row.lands.map(land => land.land).join(' | ')), [], mode + ' landings');
      if (mode !== 'character') continue;
      const marks = rows.filter(row => row.page === 0 && /[†∗♢]/.test(row.c));
      const stayed = marks.filter(row => !row.lands.length).map(row => row.seg + ' ' + JSON.stringify(row.view));
      assert.deepEqual(stayed, ['layout:p1:column2 ' + JSON.stringify(marks.find(row => row.seg === 'layout:p1:column2' && row.i === 3).view)], 'page-1 marks that stay');
      report.push('page-1 marks moved ' + (marks.length - stayed.length) + '/' + marks.length);
      for (const re of MOVED_MARKS) assert.ok(moved.some(row => row.lands.some(land => re.test(land.land))), 'relocates onto ' + re);
      const bars = rows.filter(row => row.page === 2 && row.c === '|' && row.lands.some(land => /\[\|\]\||\|\[\|\]/.test(land.land)));
      assert.deepEqual(bars.map(row => row.view), [], 'fraction bars never move');
    }
    console.log(report.join('\n'));
  } finally {
    if (browser) await browser.close();
    server.child.kill('SIGTERM');
  }
}

main().then(() => { console.log('booth relocate browser passed'); }, error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
