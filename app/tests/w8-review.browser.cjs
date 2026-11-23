const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');

const base = process.env.FALSIFY_UI_TEST_URL || 'http://127.0.0.1:7851/';
const url = new URL('workbench.html', base);
const fixture = path.join(__dirname, '../dist/examples/seedling-growth.pdf');
const quotes = ['Forty seedlings', '20', 'growth', '6 cm', 'unlocated synthetic text'];
function findings() {
  return quotes.map((quote, i) => ({id: 'f' + i, quote, rationale: 'Check ' + quote, evidence: [{quote, relation: 'Numeric comparison'}]}));
}

async function check() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    const errors = [], calls = [];
    let uploadHash;
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://**/*', async route => {
      const req = route.request(), apiPath = new URL(req.url()).pathname;
      const done = data => route.fulfill({json: data});
      if (apiPath.endsWith('/capabilities')) return done({enabled: true, models: ['synthetic-model'], efforts: ['high'], openAccess: {enabled: true}, limits: {maxUploadBytes: 33554432, maxPromptChars: 32000}});
      if (apiPath.endsWith('/guest')) return done({guest: {token: 'fsg_' + 'a'.repeat(43), expiresAt: '2099-01-01T00:00:00Z'}});
      if (apiPath.endsWith('/uploads')) {
        uploadHash = createHash('sha256').update(req.postDataBuffer()).digest('hex');
        return done({upload:{id:'upload-test-1',sha256:uploadHash}});
      }
      if (apiPath.endsWith('/jobs') && req.method() === 'POST') {
        calls.push(req.postDataJSON());
        return done({job:{id:'w8-test-job',state:'queued',role:'blue',model:'synthetic-model'}});
      }
      if (apiPath.endsWith('/jobs/w8-test-job')) return done({job:{id:'w8-test-job',state:'completed',role:'blue',model:'synthetic-model',result:{status:'ok',findings:findings()}}});
      return route.abort();
    });
    await page.goto(url.href);
    await page.locator('#w8-file').setInputFiles(fixture);
    await page.locator('#w8-review-tab').click();
    await page.locator('#w8-blue-tab-external').click();
    const answer = JSON.stringify({role:'blue', findings:findings()});
    await page.locator('#w8-blue-external-answer').fill(answer);
    await page.locator('#w8-blue-external-import').click();
    await page.waitForFunction(() => window.FalsifyW8Blue.runs().some(r => r.findings.length === 5));
    assert.equal(await page.locator('#w8-blue-hosted-run').isVisible(),false);
    await page.locator('#w8-blue-launcher-summary').click();
    await page.locator('#w8-blue-tab-hosted').click();
    await page.locator('#w8-blue-hosted-run').click();
    await page.waitForFunction(() => window.FalsifyW8Blue.runs().filter(r => r.findings.length === 5).length === 2);
    assert.equal(await page.locator('#w8-blue-findings-list article').count(), 10);
    assert.equal(uploadHash, await page.evaluate(async () => (await FalsifyW8Paper.artifact()).sha256));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].role, 'blue');
    assert.ok(Object.keys(calls[0]).every(k => ['role','prompt','uploadId','idempotencyKey','model','effort','useEvidence','budget','harness'].includes(k)));
    assert.equal(await page.locator('[data-w8-field="participant"]').isVisible(),false);
    await page.locator('[data-w8-csv-summary]').click();
    await page.locator('[data-w8-field="participant"]').fill('테스트');
    const started = page.waitForEvent('download');
    await page.locator('[data-w8-action="download"]').click();
    const csv = await started;
    assert.equal(csv.suggestedFilename(),'Blue_W8_테스트_A.csv');
    const text = await fs.readFile(await csv.path(), 'utf8');
    assert.equal(text.charCodeAt(0), 0xFEFF);
    assert.equal(text.trimEnd().split('\r\n').filter(line => line.startsWith('테스트,')).length, 10);
    assert.equal(text.split('unlocated synthetic text').length > 2, true);
    const rows = await page.evaluate(() => FalsifyW8Blue.runs().map(r => r.findings.length));
    assert.deepEqual(rows, [5,5]);
    await page.reload();
    await page.locator('#w8-blue-findings-summary').click();
    await page.locator('#w8-blue-findings-list article').first().waitFor();
    assert.equal(await page.locator('#w8-blue-findings-list article').count(), 10);
    await page.locator('#w8-blue-launcher-summary').click();
    await page.locator('#w8-blue-tab-external').click();
    await page.locator('#w8-blue-external-answer').fill(answer);
    await page.locator('#w8-blue-external-import').click();
    await page.locator('#w8-blue-external-force-new').waitFor();
    assert.equal(await page.locator('#w8-blue-findings-list article').count(), 5);
    await page.getByRole('button', {name:'전체 실행 (2)',exact:true}).click();
    assert.equal(await page.locator('#w8-blue-findings-list article').count(), 10);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
check().catch(e => { console.error(e); process.exitCode = 1; });
