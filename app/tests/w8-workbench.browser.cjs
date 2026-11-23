// Uses the same localhost static server as the other Pages browser tests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const playwright = require(process.env.W8_PLAYWRIGHT || 'playwright');

const url = new URL('workbench.html', process.env.FALSIFY_UI_TEST_URL || 'http://127.0.0.1:7851/');
const source = path.join(__dirname, '../dist/examples/seedling-growth.pdf');
const webkit = process.env.W8_BROWSER === 'webkit';

async function edit(page, original, replacement, mobile) {
  const span = page.locator('#paper-before-stage .paper-text-layer span[data-i]').filter({hasText: original}).first();
  await span.scrollIntoViewIfNeeded();
  if (mobile) {
    await span.tap();
    const input = page.locator('#booth-pe-input');
    if (!await input.isVisible()) await span.tap();
  } else await span.click();
  await page.locator('#booth-pe-input').fill(replacement);
  await page.locator('.booth-pe-apply:visible').first().click();
}

async function verifyMyAi(page, mobile) {
  const original = Buffer.concat([await fs.readFile(source), Buffer.from('\n%Uploaded paper\n')]);
  const name = 'My paper.pdf';
  await page.locator('#w8-choose').click();
  await page.locator('#w8-file').setInputFiles({name, mimeType:'application/pdf', buffer:original});
  await page.getByRole('heading', {name, exact:true}).waitFor();
  const tab = page.getByRole('tab', {name:'내 AI에게'});
  await tab.click();
  assert.equal(await tab.getAttribute('aria-selected'), 'true');
  const id = 'local:' + createHash('sha256').update(original).digest('hex');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', {name:'원문 PDF 받기'}).click();
  const download = await downloadEvent;
  assert.equal(await page.locator('#booth-myai-pdf').getAttribute('download'), name);
  assert.equal(download.suggestedFilename().replaceAll('_', ' '), name);
  assert.deepEqual(await fs.readFile(await download.path()), original);

  if (webkit) {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {value:{writeText(text) { window.copiedPrompt = text; }}});
    });
  }
  await page.locator('#booth-myai-copy').click();
  await page.locator('#booth-myai-copy-status:not(:empty)').waitFor({state:'attached'});
  const prompt = await page.evaluate(() => window.copiedPrompt || navigator.clipboard.readText());
  assert.ok(prompt.includes(id) && prompt.includes(name) && prompt.includes('첨부'));
  assert.doesNotMatch(prompt, /arXiv|CC BY/i);
  const answer = page.getByRole('textbox', {name:'AI 답', exact:true});
  const apply = page.locator('#booth-myai-apply');
  const cue = 'Compare the two changed heights with the results sentence.';
  const edit = {edits:[{page:1, find:'18', replace:'38'}, {page:1, find:'24', replace:'48'}], reason:cue, source:'my-ai', paperId:id};
  await answer.fill(JSON.stringify(edit));
  await apply.click();
  const applied = page.locator('.booth-myai-count:visible').filter({hasText:/^2곳 적용했어요$/});
  await applied.waitFor();
  assert.deepEqual(await page.evaluate(() => window.FalsifyW8Paper.edits().map(e => [e.originalText,e.newText,e.source])), [['18','38','myai'],['24','48','myai']]);
  const goBlue = page.getByRole('button', {name:'BLUE 검수로 이동',exact:true});
  const countBox = await applied.boundingBox(), buttonBox = await goBlue.boundingBox();
  assert.ok(buttonBox && Math.abs(countBox.y - buttonBox.y) < 250, 'review is one action from the applied count');
  await goBlue.click();
  await page.locator('#w8-review').waitFor();
  await page.locator('#w8-edit-tab').click();
  const redDownload = page.waitForEvent('download');
  await page.locator('#w8-red-key-export').click();
  const keyFile = await redDownload;
  assert.equal(keyFile.suggestedFilename(), '정답지_W8.csv');
  const key = await fs.readFile(await keyFile.path(), 'utf8');
  assert.match(key, /W8-01/);
  assert.match(key, /W8-02/);
  assert.equal(key.split(cue).length - 1, 2);
  const editedEvent = page.waitForEvent('download');
  await page.locator('#w8-download').click();
  const edited = await fs.readFile(await (await editedEvent).path());
  assert.notDeepEqual(edited, original);
  if (process.env.W8_VERIFY_MYAI_PDF) await fs.writeFile(process.env.W8_VERIFY_MYAI_PDF, edited);
  await page.reload();
  await page.locator('#w8-choose:enabled').waitFor();
  assert.deepEqual(await page.evaluate(() => window.FalsifyW8Paper.edits().map(e => e.newText)), ['38','48']);
  assert.deepEqual(await page.evaluate(() => window.FalsifyW8Paper.edits().map(e => e.assist?.reason)), [cue,cue]);
  await tab.click();
  await answer.fill('현재 논문에 쓰던 답');
  await page.locator('#w8-choose').click();
  await page.locator('#w8-example').click();
  await page.getByRole('heading', {name:'Seedling growth.pdf', exact:true}).waitFor();
  if (await page.locator('#w8-review').isVisible()) await page.locator('#w8-edit-tab').click();
  await tab.click();
  assert.equal(await answer.inputValue(), '');
  await answer.fill(JSON.stringify(edit));
  await apply.click();
  await page.getByText('다른 PDF에 대한 답이에요. 그 PDF를 열고 적용해 주세요.').waitFor();
  assert.deepEqual(await page.evaluate(() => window.FalsifyW8Paper.edits().map(e => e.newText)), ['28','34']);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
}

async function verifyArxiv(page, mobile) {
  const picker = page.locator('#w8-search');
  const base = await picker.getAttribute('data-api-base');
  const paper = {id:'2309.15217', title:'Public paper', license:{id:'cc-by-4.0'}, licenseVerified:true};
  const guest = 'fsg_' + 'p'.repeat(43);
  const bytes = Buffer.concat([await fs.readFile(source), Buffer.from('\n%Public paper\n')]);
  let pdfRequests = 0;
  await page.route(base + '/v1/**', async route => {
    const req = route.request();
    const endpoint = new URL(req.url());
    const headers = {'Access-Control-Allow-Origin':url.origin, 'Access-Control-Allow-Headers':'Authorization,Content-Type'};
    if (req.method() === 'OPTIONS') return route.fulfill({status:204,headers});
    if (endpoint.pathname === '/v1/ai/guest') {
      assert.deepEqual(req.postDataJSON(), {});
      return route.fulfill({headers,json:{guest:{token:guest}}});
    }
    if (endpoint.pathname.startsWith('/v1/w8/paper-links/')) return route.fulfill({headers,status:503,body:''});
    assert.equal(await req.headerValue('authorization'), 'Bearer ' + guest);
    if (endpoint.pathname.endsWith('/search')) {
      const second = endpoint.searchParams.get('page') === '2';
      const results = second ? [paper] : [{...paper,licenseVerified:false}, {...paper,license:{id:'cc-by-nd-4.0'}}];
      return route.fulfill({headers,json:{results,hasMore:!second}});
    }
    assert.equal(endpoint.searchParams.get('id'), paper.id);
    pdfRequests++;
    return route.fulfill({headers,contentType:'application/pdf',body:bytes});
  });
  await page.locator('#w8-choose').click();
  if (mobile) await picker.locator('summary').click();
  await picker.getByRole('searchbox').fill('paper');
  await picker.getByRole('searchbox').press('Enter');
  await picker.getByText('검색 결과가 없어요. 다른 단어로 찾아볼까요?').waitFor();
  assert.equal(await picker.locator('#booth-search-results button').count(), 0);
  await picker.getByRole('button', {name:'다음'}).click();
  const select = picker.getByRole('button', {name:'Public paper · 논문 열기'});
  await select.click();
  await page.getByRole('heading', {name:'Public paper'}).waitFor();
  assert.equal(await page.locator('#w8-paper-credit a').first().getAttribute('href'), 'https://arxiv.org/abs/' + paper.id);
  await page.getByRole('tab', {name:'내 AI에게'}).click();
  if (webkit) {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText(text) { window.copiedPrompt = text; }}}));
  }
  await page.locator('#booth-myai-copy').click();
  await page.locator('#booth-myai-copy-status:not(:empty)').waitFor({state:'attached'});
  const prompt = await page.evaluate(() => window.copiedPrompt || navigator.clipboard.readText());
  assert.ok(prompt.startsWith('PDF: https://arxiv.org/pdf/' + paper.id + '\n'));
  assert.ok(prompt.includes('cannot_read_paper') && prompt.length < 900);
  await page.locator('#w8-choose').click();
  await select.click();
  assert.equal(pdfRequests, 1);
  await page.reload();
  await page.getByRole('heading', {name:'Public paper'}).waitFor();
  assert.equal(await page.locator('#w8-paper-credit a').last().textContent(), 'CC BY 4.0');
}

async function verifyLinkedCopies(page, mobile) {
  if (webkit) await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText(text) { window.copiedPrompt = text; }}}));
  const base = url.origin;
  // This archive is served by the preview gateway on the same origin as the page.
  await page.locator('#w8-search').evaluate((node, origin) => { node.dataset.apiBase = origin; }, base);
  await page.route(base + '/v1/ai/guest', route => route.fulfill({json:{guest:{token:'fsg_' + 'a'.repeat(43)}}}));
  const files = new Map();
  await page.route(base + '/v1/w8/paper-links/**', async route => {
    const req = route.request();
    const key = new URL(req.url()).pathname.split('/').pop();
    const headers = {'Access-Control-Allow-Origin':url.origin, 'Access-Control-Allow-Headers':'Authorization, Content-Type',
      'Access-Control-Allow-Methods':'PUT, DELETE, OPTIONS, GET, HEAD'};
    if (req.method() === 'OPTIONS') return route.fulfill({status:204,headers});
    if (req.method() === 'DELETE') { files.delete(key.slice(0,32)); return route.fulfill({status:200,headers,json:{deleted:true}}); }
    assert.equal(req.method(), 'PUT');
    assert.ok(await req.headerValue('authorization'));
    const buffer = req.postDataBuffer();
    assert.equal(createHash('sha256').update(buffer).digest('hex'), key);
    const token = key.slice(0,32);
    files.set(token, buffer);
    return route.fulfill({headers,json:{token,sha256:key,expiresAt:new Date(Date.now()+86400000).toISOString()}});
  });
  await page.locator('#w8-choose').click();
  const file = Buffer.concat([await fs.readFile(source), Buffer.from('\n%Public link fixture\n')]);
  await page.locator('#w8-file').setInputFiles({name:'Linked.pdf', mimeType:'application/pdf', buffer:file});
  await page.getByRole('heading', {name:'Linked.pdf', exact:true}).waitFor();
  await page.getByRole('tab', {name:'내 AI에게'}).click();
  await page.locator('#booth-myai-copy').click();
  await page.locator('#booth-myai-copy-status:not(:empty)').waitFor({state:'attached'});
  const readClipboard = () => page.evaluate(() => window.copiedPrompt || navigator.clipboard.readText());
  const red = await readClipboard();
  const sourceLink = await page.locator('#w8-source-link').getAttribute('href');
  assert.ok(sourceLink && red.startsWith('PDF: ' + sourceLink));
  assert.ok(!red.includes('첨부') && red.length < 900);
  const readFile = link => files.get(link.split('/').pop().split('.')[0]);
  assert.deepEqual(readFile(sourceLink), file);
  await page.locator('#booth-myai-answer').fill(JSON.stringify({edits:[{page:1,find:'18',replace:'48'}]}));
  await page.locator('#booth-myai-apply').click();
  await page.locator('#w8-revision-link[href]').waitFor({state:'attached'});
  await page.locator('#w8-review-tab').click();
  await page.locator('#w8-blue-tab-external').click();
  const copyPrompt = page.locator('#w8-blue-copy-prompt');
  if (mobile) await copyPrompt.tap();
  else await copyPrompt.click();
  await page.locator('#w8-blue-copy-status:not(:empty)').waitFor({state:'attached'});
  const blue = await readClipboard();
  const revisionLink = await page.locator('#w8-revision-link').getAttribute('href');
  assert.ok(revisionLink && blue.includes(revisionLink) && !blue.includes(sourceLink));
  assert.equal(createHash('sha256').update(readFile(revisionLink)).digest('hex'),
    await page.evaluate(async () => (await window.FalsifyW8Paper.artifact()).sha256));
  await page.locator('#w8-archive summary').click();
  await page.locator('#w8-archive-action').click();
  await page.locator('#w8-archive-status').filter({hasText:'껐어요'}).waitFor({state:'attached'});
  assert.equal(readFile(revisionLink), undefined);
  assert.equal(readFile(sourceLink), undefined);
}

async function verifyFullArchive(page, mobile) {
  const base = await page.locator('#w8-search').getAttribute('data-api-base');
  await page.route(base + '/v1/w8/paper-links/**', route => {
    const headers = {'Access-Control-Allow-Origin':url.origin, 'Access-Control-Allow-Headers':'Authorization, Content-Type',
      'Access-Control-Allow-Methods':'PUT, OPTIONS'};
    if (route.request().method() === 'OPTIONS') return route.fulfill({status:204, headers});
    return route.fulfill({status:507, headers, json:{error:{code:'storage_full'}}});
  });
  await page.locator('#w8-choose').click();
  const file = Buffer.concat([await fs.readFile(source), Buffer.from('\n%Full archive fixture\n')]);
  await page.locator('#w8-file').setInputFiles({name:'Quota.pdf', mimeType:'application/pdf', buffer:file});
  await page.getByRole('heading', {name:'Quota.pdf', exact:true}).waitFor();
  await page.locator('#w8-archive-status').filter({hasText:'2TB'}).waitFor({state:'attached'});
  await page.getByRole('tab', {name:'내 AI에게'}).click();
  await page.locator('#booth-myai-copy').click();
  await page.locator('#booth-myai-copy-status:not(:empty)').waitFor({state:'attached'});
  assert.match(await page.evaluate(() => window.copiedPrompt || navigator.clipboard.readText()), /첨부/);
  await page.getByRole('tab', {name:'직접 고치기'}).click();
  await edit(page, /^18$/, '52', mobile);
  const download = page.waitForEvent('download');
  await page.locator('#w8-download').click();
  const bytes = await fs.readFile(await (await download).path());
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    await page.evaluate(async () => (await FalsifyW8Paper.artifact()).sha256));
}

async function verifyPaperSync(page, mobile) {
  const base = url.origin;
  const syncCalls = [];
  const sealedToken = 'sealed-browser-test-token-0123456789abcdef';
  const site = 'https://falsify.atlassian.net';
  await page.locator('#w8-search').evaluate((node, origin) => { node.dataset.syncBase = origin; }, base);
  await page.route(base + '/v1/w8/capabilities', route => route.fulfill({
    json: { provider: 'atlassian-w8', configured: true, siteUrl: site, spaceKey: 'Falsify', spaceId: '65737', issueKey: 'FLS-18' }
  }));
  await page.route(base + '/v1/w8/paper-auth/start', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { authorizeUrl: 'https://auth.atlassian.com/authorize?state=' + encodeURIComponent(body.nonce) } });
  });
  await page.route(base + '/v1/w8/paper-sync', route => {
    const req = route.request();
    assert.equal(req.method(), 'PUT');
    assert.equal(req.headers().authorization, 'Bearer ' + sealedToken);
    const body = req.postDataJSON();
    syncCalls.push(body);
    return route.fulfill({ json: { pageId: '9501', pageUrl: site + '/wiki/spaces/Falsify/pages/9501/Synced' } });
  });

  // Unauthenticated / guest: no submit button in Workbench and zero paper-sync calls so far.
  assert.equal(await page.locator('[data-w8-action="submit"]').count(), 0);
  assert.equal(syncCalls.length, 0);
  assert.equal(await page.locator('#w8-sync-connect').isVisible(), true);

  // Stub window.open only for the OAuth popup inside user-gesture click of 'Confluence 연결'.
  await page.evaluate(({ token, origin }) => {
    window.__w8PopupCount = 0;
    window.open = () => {
      window.__w8PopupCount += 1;
      const popup = { closed: false, opener: window, close() { this.closed = true; } };
      popup.location = {
        set href(value) {
          const nonce = new URL(value).searchParams.get('state');
          setTimeout(() => {
            const ev = new Event('message');
            Object.defineProperties(ev, {
              origin: { value: origin },
              source: { value: popup },
              data: {
                value: {
                  type: 'falsify.confluence.session.v1',
                  nonce,
                  session: token,
                  expiresAt: new Date(Date.now() + 3600000).toISOString(),
                },
              },
            });
            window.dispatchEvent(ev);
          }, 5);
        }
      };
      return popup;
    };
  }, { token: sealedToken, origin: base });

  const connectedPaper = await page.evaluate(() => window.FalsifyW8Paper.state().sourceSha256);
  await page.locator('#w8-sync-connect').click();
  await page.locator('#w8-sync-disconnect').waitFor();
  assert.equal(await page.evaluate(() => window.__w8PopupCount), 1);
  assert.equal(await page.evaluate(tok => localStorage.getItem('falsify.w8-session.v1')?.includes(tok), sealedToken), false);

  // Open a fresh PDF while authenticated -> auto-syncs original with NO submit button.
  await page.locator('#w8-choose').click();
  const paperBytes = Buffer.concat([await fs.readFile(source), Buffer.from('\n%Confluence sync fixture\n')]);
  const paperSha = createHash('sha256').update(paperBytes).digest('hex');
  await page.locator('#w8-file').setInputFiles({ name: 'SyncPaper.pdf', mimeType: 'application/pdf', buffer: paperBytes });
  await page.getByRole('heading', { name: 'SyncPaper.pdf', exact: true }).waitFor();
  await page.locator('#w8-sync-link[href]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#w8-sync-link').getAttribute('href'), site + '/wiki/spaces/Falsify/pages/9501/Synced');
  assert.ok(syncCalls.some(c => c.sourceSha256 === paperSha && c.title === 'SyncPaper.pdf'));
  assert.ok(syncCalls.some(c => c.sourceSha256 === connectedPaper), 'record the paper held open at explicit connection');
  assert.ok(syncCalls.every(c => [connectedPaper, paperSha].includes(c.sourceSha256)), 'only explicitly open papers');

  // Edit the PDF -> auto-syncs revisionSha256.
  const revisionRecorded = page.waitForResponse(response =>
    response.url() === base + '/v1/w8/paper-sync' && response.request().postDataJSON()?.revisionSha256);
  await edit(page, /^18$/, '64', mobile);
  await revisionRecorded;
  const revSha = await page.evaluate(async () => (await window.FalsifyW8Paper.artifact()).sha256);
  assert.ok(syncCalls.some(c => c.sourceSha256 === paperSha && c.revisionSha256 === revSha));

  // External BLUE run -> auto-syncs runs joined to source+revision, CSV download still works, still no submit button.
  await page.locator('#w8-review-tab').click();
  await page.locator('#w8-review').waitFor();
  await page.locator('#w8-blue-tab-external').click();
  const blueAnswer = { role: 'blue', findings: [{ id: 's1', quote: '64', rationale: 'Table discrepancy', severity: '높음', verdictLabel: '아님' }] };
  await page.locator('#w8-blue-external-answer').fill(JSON.stringify(blueAnswer));
  const reviewRecorded = page.waitForResponse(response =>
    response.url() === base + '/v1/w8/paper-sync' && response.request().postDataJSON()?.runs?.length);
  await page.locator('#w8-blue-external-import').click();
  await reviewRecorded;
  assert.ok(syncCalls.some(c => c.sourceSha256 === paperSha && c.revisionSha256 === revSha && Array.isArray(c.runs) && c.runs.some(r => r.findings.some(f => f.quote === '64' && f.verdict === '아님'))));
  assert.equal(await page.locator('[data-w8-action="submit"]').count(), 0);
  await page.locator('[data-w8-field="participant"]').fill('동기화테스터');
  const csvDownload = page.waitForEvent('download');
  await page.locator('[data-w8-action="download"]').click();
  assert.equal((await csvDownload).suggestedFilename(), 'Blue_W8_동기화테스터_A.csv');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  // Reload restores encrypted session + synced link without redundant PUT or retro-publishing.
  const callsBeforeReload = syncCalls.length;
  await page.reload();
  await page.locator('#w8-search').evaluate((node, origin) => { node.dataset.apiBase = origin; }, base);
  await page.locator('#w8-choose:enabled').waitFor();
  await page.locator('#w8-sync-disconnect').waitFor();
  assert.equal(await page.locator('[data-w8-action="submit"]').count(), 0);
  assert.equal(syncCalls.length, callsBeforeReload, 'reload must not duplicate PUT or retro-publish');
}

async function run() {
  const engine = process.env.W8_BROWSER || 'chromium';
  const mobile = webkit && process.env.W8_DEVICE !== 'desktop';
  const browser = await playwright[engine].launch({executablePath:process.env.W8_BROWSER_PATH});
  try {
    const options = mobile ? playwright.devices['iPhone 13'] : webkit ? playwright.devices['Desktop Safari'] : {permissions:['clipboard-read','clipboard-write']};
    const context = await browser.newContext({...options, acceptDownloads: true});
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('https://**/*', route => new URL(route.request().url()).origin === url.origin ? route.continue() : route.abort());
    await page.goto(url.href + '#red');
    await page.waitForFunction(() => document.documentElement.dataset.boothStep === 'pick');
    assert.equal(new URL(page.url()).hash, '');
    await page.locator('#w8-example').click();
    await edit(page, /^18$/, '28', mobile);
    await edit(page, /^24$/, '34', mobile);
    const downloadStarted = page.waitForEvent('download');
    await page.locator('#w8-download').click();
    const download = await downloadStarted;
    const downloaded = await fs.readFile(await download.path());
    if (process.env.W8_VERIFY_PDF) await fs.writeFile(process.env.W8_VERIFY_PDF, downloaded);
    const hash = createHash('sha256').update(downloaded).digest('hex');
    assert.notEqual(hash, createHash('sha256').update(await fs.readFile(source)).digest('hex'));
    assert.equal(hash, await page.evaluate(async () => (await window.FalsifyW8Paper.artifact()).sha256));
    const newcomer = await context.newPage();
    for (const target of [url.href, url.href + '?entry=shared#red']) {
      await newcomer.goto(target);
      await newcomer.waitForFunction(() => document.documentElement.dataset.boothStep === 'pick');
      assert.equal(new URL(newcomer.url()).hash, '');
      assert.equal(new URL(newcomer.url()).search, new URL(target).search);
      assert.ok(await newcomer.locator('#w8-intake').isVisible());
      assert.equal(await newcomer.evaluate(() => window.FalsifyW8Paper.state().ready), false);
    }
    await newcomer.locator('#w8-recent-paper').selectOption({label:'Seedling growth.pdf'});
    await newcomer.locator('#w8-name').filter({hasText:'Seedling growth.pdf'}).waitFor();
    assert.equal(hash, await newcomer.evaluate(async () => (await window.FalsifyW8Paper.artifact()).sha256));
    await newcomer.locator('#w8-choose').click();
    await newcomer.reload();
    await newcomer.waitForFunction(() => document.documentElement.dataset.boothStep === 'pick');
    await newcomer.close();
    await page.bringToFront();
    await page.reload();
    await page.locator('#w8-session').waitFor();
    await page.locator('#w8-choose:enabled').waitFor();
    assert.equal(hash, await page.evaluate(async () => (await window.FalsifyW8Paper.artifact()).sha256));
    await page.locator('#w8-review-tab').click();
    await page.locator('#w8-review').waitFor();
    if (!mobile) {
      await page.locator('#w8-blue-tab-external').click();
      const response = {role:'blue', findings:[{id:'f1',quote:'28',rationale:'Compare this height with the reported difference.'}]};
      await page.locator('#w8-blue-external-answer').fill(JSON.stringify(response));
      await page.locator('#w8-blue-external-import').click();
      await page.locator('#w8-grading summary').first().click();
      const verdicts = page.locator('#w8-grading select');
      await verdicts.first().waitFor();
      assert.equal(await verdicts.count(), 2);
      await verdicts.first().selectOption('detected');
      await page.locator('#w8-grading details details summary').first().click();
      await page.locator('#w8-grading input[type=checkbox]').first().check();
      const other = Buffer.concat([await fs.readFile(source), Buffer.from('\n%Second study\n')]);
      await page.locator('#w8-choose').click();
      assert.ok(await page.locator('#w8-return').isVisible());
      await page.locator('#w8-return').click();
      await page.locator('#w8-review').waitFor();
      assert.equal(await verdicts.first().inputValue(), 'detected');
      await page.locator('#w8-choose').click();
      await page.locator('#w8-file').setInputFiles({name:'Second.pdf', mimeType:'application/pdf', buffer:other});
      await page.getByRole('heading', {name:'Second.pdf'}).waitFor();
      await page.locator('#w8-choose').click();
      const recent = page.locator('#w8-recent-paper');
      await recent.selectOption({label:'Seedling growth.pdf'});
      await page.getByRole('heading', {name:'Seedling growth.pdf'}).waitFor();
      await page.locator('#w8-review').waitFor();
      assert.equal(hash, await page.evaluate(async () => (await window.FalsifyW8Paper.artifact()).sha256));
      await page.reload();
      await page.locator('#w8-grading summary').first().click();
      assert.equal(await verdicts.first().inputValue(), 'detected');
      assert.ok(await page.locator('#w8-grading input[type=checkbox]').first().isChecked());
    }
    await verifyMyAi(page, mobile);
    await verifyArxiv(page, mobile);
    await verifyLinkedCopies(page, mobile);
    await verifyFullArchive(page, mobile);
    await verifyPaperSync(page, mobile);
    assert.deepEqual(errors, []);
    console.log(`${engine} ${browser.version()} verified direct and external AI edits, download and reload · ${hash}`);
  } finally { await browser.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
