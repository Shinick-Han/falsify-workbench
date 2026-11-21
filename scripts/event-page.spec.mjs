import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import {
  BOOTH_SCRIPTS, BOOTH_STYLES, DEFAULT_EVENT_API_BASE, EVENT_OMIT, EVENT_TITLE_SUFFIX, eventApiOrigin, eventBytesDiffer, eventHtmlFromIndex,
  omitWorkbench, parseEventArgs, planEventFiles,
} from './build-event-page.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = join(root, 'app/dist/index.html');
const eventPath = join(root, 'app/dist/event.html');
const configPath = join(root, 'app/dist/cloud-config.event.js');

function count(text, needle) {
  return text.split(needle).length - 1;
}

function newlineOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function stripBoothAssets(text, newline) {
  const escape = name => name.replace(/[.]/g, '\\.');
  for (const pattern of [
    ...BOOTH_STYLES.map(name => new RegExp(` {2}<link rel="stylesheet" href="${escape(name)}\\?v=[^"]+">`, 'g')),
    ...BOOTH_SCRIPTS.map(name => new RegExp(` {2}<script src="${escape(name)}\\?v=[^"]+" defer><\\/script>`, 'g')),
  ]) {
    const found = text.match(pattern) || [];
    assert.ok(found.length <= 1);
    if (found.length === 1) {
      const needle = found[0] + newline;
      assert.equal(count(text, needle), 1);
      text = text.replace(needle, '');
    }
  }
  return text;
}

function revertEventHtml(eventHtml, indexHtml, origin) {
  const nl = newlineOf(indexHtml);
  let text = stripBoothAssets(eventHtml, nl);
  assert.equal(count(text, 'cloud-config.event.js?v='), 1);
  assert.equal(count(text, 'cloud-config.js?v='), 0);
  text = text.replace('cloud-config.event.js?v=', 'cloud-config.js?v=');
  const robots = `  <meta name="robots" content="noindex">${nl}  <meta name="color-scheme" content="only light">${nl}`;
  assert.equal(count(text, robots), 1);
  text = text.replace(robots, '');
  const suffix = `${EVENT_TITLE_SUFFIX}</title>`;
  assert.equal(count(text, suffix), 1);
  text = text.replace(suffix, '</title>');
  const indexConnect = indexHtml.match(/connect-src [^;]*/)[0];
  const eventConnect = text.match(/connect-src [^;]*/)[0];
  assert.equal(eventConnect, `connect-src 'self' ${origin}`);
  assert.equal(eventConnect.includes('http://127.0.0.1'), false);
  text = text.replace(eventConnect, indexConnect);
  return text;
}

function fixture(extra = '') {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self' http://127.0.0.1:* https://falsify-cloud-api.ai-gongbu.workers.dev; object-src 'none'">
  <title>Falsify · Paper Workbench</title>
  ${extra}<script src="cloud-config.js?v=0.2.0-alpha.86" defer></script>
</head>
</html>
`;
}

function run(args) {
  return spawnSync(process.execPath, [join(root, 'scripts/build-event-page.mjs'), ...args], {
    cwd: root, encoding: 'utf8',
  });
}

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('api base must be a canonical https origin', () => {
  assert.equal(eventApiOrigin(DEFAULT_EVENT_API_BASE), DEFAULT_EVENT_API_BASE);
  assert.equal(parseEventArgs([]).apiBase, DEFAULT_EVENT_API_BASE);
  assert.equal(parseEventArgs(['--check']).check, true);
  for (const value of [
    'http://example.com', 'https://example.com/v1', 'https://example.com/', 'https://example.com?x=1',
    'https://example.com#frag', 'https://user@example.com', 'https://example.com:443', 'not a url', '',
  ]) assert.throws(() => eventApiOrigin(value), /https origin/);
  assert.throws(() => parseEventArgs(['--api-base']), /missing --api-base/);
  assert.throws(() => parseEventArgs(['--nope']), /unknown argument/);
});

test('event HTML keeps every other byte, with or without open-access.js', () => {
  for (const extra of ['', '<script src="open-access.js?v=0.2.0-alpha.86" defer></script>\n  ']) {
    const index = fixture(extra);
    const planned = planEventFiles(index, DEFAULT_EVENT_API_BASE);
    assert.equal(revertEventHtml(planned.html, index, DEFAULT_EVENT_API_BASE), index);
    assert.equal(count(planned.html, 'open-access.js?v=0.2.0-alpha.86'), count(index, 'open-access.js?v=0.2.0-alpha.86'));
    assert.match(planned.html, /<title>Falsify · Paper Workbench · Event<\/title>/);
    assert.match(planned.html, /<meta name="robots" content="noindex">/);
    assert.match(planned.html, /<meta name="color-scheme" content="only light">/);
  }
});

test('malformed index or CSP fails closed', () => {
  const index = fixture();
  assert.throws(() => eventHtmlFromIndex(index.replace('cloud-config.js', 'missing.js'), DEFAULT_EVENT_API_BASE), /cloud-config script/);
  assert.throws(() => eventHtmlFromIndex(index + fixture(), DEFAULT_EVENT_API_BASE), /exactly one/);
  assert.throws(() => eventHtmlFromIndex(index.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''), DEFAULT_EVENT_API_BASE), /CSP meta/);
  const doubled = index.replace('connect-src', 'connect-src \'self\' https://a.example; connect-src');
  assert.throws(() => planEventFiles(doubled, DEFAULT_EVENT_API_BASE), /connect-src/);
  assert.throws(() => planEventFiles(index.replace('<title>', '<title>').replace('</title>', '</title>\n  <meta name="robots" content="noindex">'), DEFAULT_EVENT_API_BASE), /default page/);
});

test('the event page drops the Workbench-only assets and index.html keeps them', () => {
  const index = readFileSync(indexPath, 'utf8');
  const event = readFileSync(eventPath, 'utf8');
  for (const required of [
    'latex-workbench.mjs', 'paper-recompose-entry.mjs', 'table-pdf.js', 'paragraph-pdf.js',
    'pdf-edit-pipeline.js', 'paper-font-service.js', 'paper-change-marks.js', 'paper-generation.js',
  ]) {
    assert.ok(EVENT_OMIT.includes(required), required + ' must be in EVENT_OMIT');
  }
  for (const name of EVENT_OMIT) {
    assert.equal(count(index, '"' + name + '?'), 1, name + ' in index.html');
    assert.equal(count(event, '"' + name + '?'), 0, name + ' in event.html');
  }
  assert.equal(omitWorkbench(fixture()), fixture());
  const extra = '<script type="module" src="latex-workbench.mjs?v=1&amp;build=x"></script>\n  ';
  assert.equal(omitWorkbench(fixture(extra)), fixture());
  assert.throws(() => omitWorkbench(fixture(extra + extra)), /at most one/);
});

test('committed event page matches index.html except the four event edits', () => {
  const index = readFileSync(indexPath, 'utf8');
  const planned = planEventFiles(index, DEFAULT_EVENT_API_BASE);
  const event = readFileSync(eventPath, 'utf8');
  const config = readFileSync(configPath, 'utf8');
  assert.equal(event, planned.html);
  assert.equal(config, planned.config);
  assert.equal(revertEventHtml(event, index, DEFAULT_EVENT_API_BASE), omitWorkbench(index, newlineOf(index)));
  assert.equal(eventBytesDiffer(Buffer.from(event), planned.html), false);
  const sandbox = {};
  vm.runInNewContext(config, sandbox);
  const cfg = sandbox.FalsifyCloudConfig;
  assert.deepEqual(JSON.parse(JSON.stringify(cfg)), {
    apiBase: DEFAULT_EVENT_API_BASE,
    provider: 'confluence',
    hostedAi: {enabled: true, apiBase: DEFAULT_EVENT_API_BASE},
    openAccess: {enabled: true},
    booth: {enabled: true},
  });
  assert.equal(Object.isFrozen(cfg), true);
  assert.equal(Object.isFrozen(cfg.openAccess), true);
  assert.equal(Object.isFrozen(cfg.hostedAi), true);
  assert.equal(Object.isFrozen(cfg.booth), true);
  assert.equal(index.includes('booth.js'), false);
  assert.equal(index.includes('booth.css'), false);
  assert.equal(index.includes('event-theme.css'), false);
  const hostedAt = event.indexOf('hosted-ai.js?v=');
  const boothAt = event.indexOf('booth.js?v=');
  assert.ok(hostedAt >= 0 && boothAt > hostedAt);
  const themeAt = event.indexOf('event-theme.css?v=');
  const boothCssAt = event.indexOf('booth.css?v=');
  assert.ok(themeAt > hostedAt && boothCssAt > themeAt, 'event-theme.css loads before booth.css');
  assert.equal(count(event, 'event-theme.css'), 1);
  const order = [...BOOTH_STYLES, ...BOOTH_SCRIPTS].map(name => event.indexOf(`"${name}?v=`));
  assert.ok(order.every((at, i) => at > hostedAt && (i === 0 || at > order[i - 1])), 'booth assets keep the contract order');
  for (const name of ['booth-i18n', 'booth-recipe', 'booth-myai', 'booth-runtime', 'booth-edits', 'booth-pageedit']) assert.equal(index.includes(name), false, name + ' stays off index.html');
  const footOf = doc => (doc.match(/<footer class="page-foot">[\s\S]*?<\/footer>/) || [''])[0];
  assert.equal(footOf(event), footOf(index), 'event footer matches index footer with no extra agent link');
  assert.equal(count(event, 'id="source-link"'), 1, 'event footer keeps source link');
});

test('event HTML injects the event theme, then booth assets, after hosted-ai.js only', () => {
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  const index = fixture(`<script src="hosted-ai.js?v=${version}" defer></script>\n  `);
  const planned = planEventFiles(index, DEFAULT_EVENT_API_BASE);
  const injected = [
    `<script src="hosted-ai.js?v=${version}" defer></script>`,
    `  <link rel="stylesheet" href="event-theme.css?v=${version}">`,
    `  <link rel="stylesheet" href="booth.css?v=${version}">`,
    `  <link rel="stylesheet" href="booth-recipe.css?v=${version}">`,
    `  <link rel="stylesheet" href="booth-myai.css?v=${version}">`,
    `  <link rel="stylesheet" href="booth-runtime.css?v=${version}">`,
    `  <link rel="stylesheet" href="booth-pageedit.css?v=${version}">`,
    `  <script src="booth-edits.js?v=${version}" defer></script>`,
    `  <script src="booth-i18n.js?v=${version}" defer></script>`,
    `  <script src="booth-runtime.js?v=${version}" defer></script>`,
    `  <script src="booth.js?v=${version}" defer></script>`,
    `  <script src="booth-recipe.js?v=${version}" defer></script>`,
    `  <script src="booth-myai.js?v=${version}" defer></script>`,
    `  <script src="booth-pageedit.js?v=${version}" defer></script>`,
  ].join('\n');
  assert.ok(planned.html.includes(injected));
  assert.equal(count(index, 'booth.js'), 0);
  assert.equal(count(planned.html, 'event-theme.css'), 1);
  assert.equal(planEventFiles(index, DEFAULT_EVENT_API_BASE).html, planned.html, 'generator is deterministic');
  assert.equal(revertEventHtml(planned.html, index, DEFAULT_EVENT_API_BASE), index);
  assert.match(planned.config, /booth: Object\.freeze\(\{ enabled: true \}\)/);
});

test('check is read-only and the verify job runs it', () => {
  const before = [indexPath, eventPath, configPath].map(sha);
  const drift = run(['--check', '--api-base', 'https://example.com']);
  assert.equal(drift.status, 1);
  for (const args of [
    ['--api-base', 'http://example.com'],
    ['--api-base', 'https://example.com/v1'],
    ['--api-base', 'https://example.com/'],
    ['--api-base', 'https://example.com?x=1'],
    ['--nope'],
  ]) assert.equal(run(args).status, 2, args.join(' '));
  const ok = run(['--check']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([indexPath, eventPath, configPath].map(sha), before);
  const workflow = readFileSync(join(root, '.github/workflows/pages.yml'), 'utf8');
  const verify = workflow.slice(0, workflow.indexOf('\n  deploy:'));
  assert.match(verify, /node --test scripts\/packaging\.spec\.mjs\n\s*node --test scripts\/event-page\.spec\.mjs\n\s*node scripts\/build-event-page\.mjs --check/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('\n  deploy:')), /build-event-page/);
});
