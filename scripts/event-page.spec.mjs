import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import {
  DEFAULT_EVENT_API_BASE, EVENT_TITLE_SUFFIX, eventApiOrigin, eventBytesDiffer, eventHtmlFromIndex,
  parseEventArgs, planEventFiles,
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

function revertEventHtml(eventHtml, indexHtml, origin) {
  const nl = newlineOf(indexHtml);
  let text = eventHtml;
  assert.equal(count(text, 'cloud-config.event.js?v='), 1);
  assert.equal(count(text, 'cloud-config.js?v='), 0);
  text = text.replace('cloud-config.event.js?v=', 'cloud-config.js?v=');
  const robots = `  <meta name="robots" content="noindex">${nl}`;
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
  ${extra}<script src="cloud-config.js?v=0.2.0-alpha.78" defer></script>
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
  for (const extra of ['', '<script src="open-access.js?v=0.2.0-alpha.78" defer></script>\n  ']) {
    const index = fixture(extra);
    const planned = planEventFiles(index, DEFAULT_EVENT_API_BASE);
    assert.equal(revertEventHtml(planned.html, index, DEFAULT_EVENT_API_BASE), index);
    assert.equal(count(planned.html, 'open-access.js?v=0.2.0-alpha.78'), count(index, 'open-access.js?v=0.2.0-alpha.78'));
    assert.match(planned.html, /<title>Falsify · Paper Workbench · Event<\/title>/);
    assert.match(planned.html, /<meta name="robots" content="noindex">/);
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

test('committed event page matches index.html except the four event edits', () => {
  const index = readFileSync(indexPath, 'utf8');
  const planned = planEventFiles(index, DEFAULT_EVENT_API_BASE);
  const event = readFileSync(eventPath, 'utf8');
  const config = readFileSync(configPath, 'utf8');
  assert.equal(event, planned.html);
  assert.equal(config, planned.config);
  assert.equal(revertEventHtml(event, index, DEFAULT_EVENT_API_BASE), index);
  assert.equal(eventBytesDiffer(Buffer.from(event), planned.html), false);
  const sandbox = {};
  vm.runInNewContext(config, sandbox);
  const cfg = sandbox.FalsifyCloudConfig;
  assert.deepEqual(JSON.parse(JSON.stringify(cfg)), {
    apiBase: DEFAULT_EVENT_API_BASE,
    provider: 'confluence',
    hostedAi: {enabled: true, apiBase: DEFAULT_EVENT_API_BASE},
    openAccess: {enabled: true},
  });
  assert.equal(Object.isFrozen(cfg), true);
  assert.equal(Object.isFrozen(cfg.openAccess), true);
  assert.equal(Object.isFrozen(cfg.hostedAi), true);
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
