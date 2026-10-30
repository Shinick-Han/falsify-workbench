// CI-only end-to-end source-project proof. All inputs are synthetic and local.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');
const {zipSync} = require('fflate');
const root = path.resolve(__dirname, '../dist');
const prefix = '/falsify-workbench/';
const before = 'An initial claim62 remains conditional.';
const after = 'An altered claim63 remains provisional.';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const timeout = 180000;
const types = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.wasm':'application/wasm', '.data':'application/octet-stream', '.json':'application/json', '.pdf':'application/pdf', '.svg':'image/svg+xml'};
async function fixtureZip(dir, relative = '') {
  const files = {};
  for (const entry of await fs.readdir(path.join(dir, relative), {withFileTypes:true})) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(files, await fixtureZip(dir, name));
    else if (entry.isFile()) files[name] = new Uint8Array(await fs.readFile(path.join(dir, name)));
    else throw new Error('Unexpected fixture entry');
  }
  return files;
}
async function main() {
  if (!process.env.CI) throw new Error('This browser test runs only in CI');
  const manifest = require('../latex-compiler-manifest.json');
  for (const name of ['busytex.wasm','texlive-basic.data']) {
    const entry=manifest.files.find(f=>f.name===name);
    const bytes=await fs.readFile(path.join(root,'latex-compiler-vendor',name));
    assert.ok(entry && bytes.length===entry.bytes && hash(bytes)===entry.sha256, 'Pinned compiler asset mismatch');
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
      const rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const data = await fs.readFile(file);
      res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream'}).end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const context = await browser.newContext({acceptDownloads:true});
    const origin = `http://127.0.0.1:${server.address().port}`;
    const failures = [], assets = [], posts = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:' || (url.origin === origin)) return route.continue();
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', () => failures.push('pageerror'));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(m.text())) failures.push('console error'); });
    page.on('request', r => {
      const u = new URL(r.url());
      if (u.origin === origin && /(?:latex-compiler-vendor|pdf\.worker)/.test(u.pathname)) assets.push(u.pathname);
      if (r.method() === 'POST' && /\/api\/(?:blue|red)\/jobs/.test(u.pathname)) posts.push(u.pathname);
      if (u.origin === origin && !u.pathname.startsWith(prefix)) failures.push('root-origin request');
    });
    page.on('response', r => { const u = new URL(r.url()); if (u.origin === origin && r.status() >= 400) failures.push(`local HTTP ${r.status()}`); });
    await page.goto(origin + prefix);
    await page.waitForFunction(() => !!window.FalsifyLatexWorkbench);
    const zip = Buffer.from(zipSync(await fixtureZip(path.join(__dirname, 'fixtures/latex-source/project'))));
    await page.locator('#paper-file').setInputFiles({name:'synthetic-project.zip',mimeType:'application/zip',buffer:zip});
    const waitOutput = async () => {
      await page.waitForFunction(() => { const w=window.FalsifyLatexWorkbench, s=w?.getSession()?.snapshot(); return w?.getCurrentOutput() && s?.artifact?.success && !s.busy; }, null, {timeout});
      return page.evaluate(() => { const w=window.FalsifyLatexWorkbench, a=w.getSession().snapshot().artifact; return {hash:w.getCurrentOutput().sha256, bytes:a.pdfBytes.length, synctex:a.synctex?.length || 0, engine:a.engineManifest}; });
    };
    const initial = await waitOutput();
    assert.ok(initial.bytes > 0 && initial.synctex > 0);
    assert.equal(initial.engine.version, '1.4.1');
    assert.equal(initial.engine.source, '61b83cde2836d42cf941f6559d36c9678d52cbf2');
    await page.locator('#external-red-paste').fill(JSON.stringify({changes:[{before,after}]}));
    await page.locator('#external-red').getByRole('button',{name:'응답 가져오기'}).click();
    await page.waitForFunction(() => document.querySelector('.latex-change-row input')?.checked, null, {timeout});
    const edited = await waitOutput();
    assert.notEqual(edited.hash, initial.hash);
    const download = async button => { const pending=page.waitForEvent('download'); await button.click(); return (await pending).createReadStream(); };
    const streamBytes = async stream => { const chunks=[]; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
    const pdf = await streamBytes(await download(page.locator('#latex-source-workbench').getByRole('button',{name:'PDF 다운로드'})));
    assert.equal(hash(pdf), edited.hash);
    const extract = async bytes => page.evaluate(async b64 => {
      const pdfjs=await import('./vendor/pdf.mjs'); pdfjs.GlobalWorkerOptions.workerSrc=new URL('vendor/pdf.worker.mjs', document.baseURI).href;
      const binary=atob(b64), data=Uint8Array.from(binary, c=>c.charCodeAt(0));
      const doc=await pdfjs.getDocument({data}).promise; let text='';
      for(let i=1;i<=doc.numPages;i++) text+=(await (await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ')+' ';
      await doc.destroy(); return text.replace(/\s+/g,' ');
    }, bytes.toString('base64'));
    const text = await extract(pdf);
    for (const expected of ['An altered claim', '63', 'remains provisional.', 'Synthetic unchanged figure.', 'Synthetic reference', 'original note remains available', 'Following evidence stays readable']) assert.ok(text.includes(expected), `Missing PDF content: ${expected}`);
    assert.match(text, /x\s*n\s*\+\s*1/);
    await page.locator('#latex-source-workbench').getByRole('button',{name:'BLUE로 보내기'}).click();
    await page.waitForFunction(h => window.FalsifyDocumentBlueExternal?.getSource()?.fileHash === h, edited.hash, {timeout});
    assert.equal(await page.locator('#doc-blue-consent').isChecked(), false);
    await page.locator('#doc-blue-request').evaluate(e => e.closest('details').open = true);
    const request = JSON.parse((await streamBytes(await download(page.locator('#doc-blue-request')))).toString());
    const requestText = JSON.stringify(request);
    for (const forbidden of ['sourceSession','sourceChanges','proposals','responseId','sections/body.tex','An initial claim']) assert.ok(!requestText.includes(forbidden), 'RED/source metadata leaked into BLUE request');
    assert.equal(posts.length, 0);
    await page.locator('[data-view="workbench"]').first().click();
    await page.locator('#latex-source-workbench').getByRole('button',{name:'실행 취소'}).click();
    assert.equal((await waitOutput()).hash, initial.hash);
    const undoPdf=await streamBytes(await download(page.locator('#latex-source-workbench').getByRole('button',{name:'PDF 다운로드'})));
    assert.equal(hash(undoPdf), initial.hash);
    assert.ok((await extract(undoPdf)).includes('remains conditional.'));
    await page.locator('#latex-source-workbench').getByRole('button',{name:'다시 실행'}).click();
    assert.equal((await waitOutput()).hash, edited.hash);
    const redoPdf=await streamBytes(await download(page.locator('#latex-source-workbench').getByRole('button',{name:'PDF 다운로드'})));
    assert.equal(hash(redoPdf), edited.hash);
    assert.ok((await extract(redoPdf)).includes('remains provisional.'));
    await page.getByText('작업 저장 및 불러오기',{exact:true}).click();
    const archive = await streamBytes(await download(page.getByRole('button',{name:'작업 JSON 저장'})));
    await page.getByLabel('작업 JSON 불러오기').setInputFiles({name:'session.json',mimeType:'application/json',buffer:archive});
    await page.waitForFunction(() => {const w=window.FalsifyLatexWorkbench; return w?.getArchiveState()?.changes?.length && !w.getCurrentOutput() && !w.getSession().snapshot().busy;}, null, {timeout});
    assert.equal(await page.locator('.latex-change-row input').isChecked(), true);
    await page.locator('#latex-source-workbench').getByRole('button',{name:'PDF 만들기'}).click();
    const restored = await waitOutput();
    const snap = await page.evaluate(() => {const s=FalsifyLatexWorkbench.getSession().snapshot();return {baseline:s.baseline?.pdfHash, changes:s.changes};});
    assert.ok(snap.baseline && snap.changes.some(c=>c.enabled));
    assert.notEqual(restored.hash, snap.baseline);
    const baseline64 = await page.evaluate(() => {const b=FalsifyLatexWorkbench.getSession().snapshot().baseline.pdfBytes; let s=''; for (const v of b) s+=String.fromCharCode(v); return btoa(s);});
    assert.equal(hash(Buffer.from(baseline64,'base64')), snap.baseline);
    assert.ok((await extract(Buffer.from(baseline64,'base64'))).includes('remains conditional.'));
    assert.ok(await page.locator('.latex-change-row input').isEnabled());
    const restoredPdf=await streamBytes(await download(page.locator('#latex-source-workbench').getByRole('button',{name:'PDF 다운로드'})));
    assert.equal(hash(restoredPdf),restored.hash);
    assert.ok((await extract(restoredPdf)).includes('remains provisional.'));
    const pdfInput = await fs.readFile(path.join(__dirname,'fixtures/paragraph-marker-synthetic.pdf'));
    await page.locator('#paper-file').setInputFiles({name:'paragraph-marker-synthetic.pdf',mimeType:'application/pdf',buffer:pdfInput});
    await page.waitForFunction(h => !FalsifyLatexWorkbench.active && FalsifyPaperWorkspace.getSource()?.fileHash===h, hash(pdfInput), {timeout});
    await page.waitForFunction(h => FalsifyPaperWorkspace.getCurrentOutput()?.sha256===h, hash(pdfInput), {timeout});
    assert.equal(posts.length,0);
    assert.ok(assets.some(x=>x.endsWith('/busytex.wasm')) && assets.some(x=>x.endsWith('/texlive-basic.data')) && assets.some(x=>x.endsWith('/pdf.worker.mjs')));
    assert.ok(assets.every(x=>x.startsWith(prefix)));
    assert.deepEqual(failures, []);
    await context.close();
    console.log('Synthetic LaTeX source browser flow passed');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
