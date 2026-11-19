// Build the event page next to the default Pages entry.
//
// Usage:
//   node scripts/build-event-page.mjs [--api-base https://origin] [--check]
//
// --api-base  HTTPS origin only: no userinfo, path, query, fragment, or trailing
//             slash. Default: https://falsify-cloud-api-event.ai-gongbu.workers.dev
//             (the planned event Worker; it does not need to exist to build the page).
// --check     Exit non-zero when app/dist/event.html or app/dist/cloud-config.event.js
//             differ from what this command would write. Does not write.
//
// Reads app/dist/index.html and never modifies it. The event HTML changes only the
// cloud-config script name, the CSP connect-src origin, a title suffix, a
// noindex robots meta, and event-theme.css/booth.css/booth.js after hosted-ai.js.
// event-theme.css comes first so booth.css can override it. Whatever else
// index.html contains, including open-access.js, is copied through.
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_REL = 'app/dist/index.html';
const HTML_REL = 'app/dist/event.html';
const CONFIG_REL = 'app/dist/cloud-config.event.js';
const SCRIPT = /<script src="cloud-config\.js\?v=([^"]*)" defer><\/script>/;
const HOSTED = /<script src="hosted-ai\.js\?v=([^"]*)" defer><\/script>/;
const CSP = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/;
const TITLE = /<title>([^<]*)<\/title>/;
const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/;

export const DEFAULT_EVENT_API_BASE = 'https://falsify-cloud-api-event.ai-gongbu.workers.dev';
export const EVENT_TITLE_SUFFIX = ' · Event';

function fail(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function usage(message) {
  return fail(`Usage: node scripts/build-event-page.mjs [--api-base https://origin] [--check]. ${message}`, 2);
}

function badApi() {
  return fail('apiBase must be an https origin with no path, query, fragment, or userinfo', 2);
}

export function eventApiOrigin(value) {
  if (typeof value !== 'string') throw badApi();
  let url;
  try { url = new URL(value); }
  catch { throw badApi(); }
  if (url.origin !== value || !ORIGIN.test(value)) throw badApi();
  return value;
}

export function parseEventArgs(argv) {
  let apiBase = DEFAULT_EVENT_API_BASE;
  let check = false;
  let sawBase = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      if (check) throw usage('duplicate --check');
      check = true;
    } else if (arg === '--api-base') {
      if (sawBase) throw usage('duplicate --api-base');
      sawBase = true;
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw usage('missing --api-base value');
      apiBase = value;
      i += 1;
    } else throw usage('unknown argument');
  }
  return {apiBase: eventApiOrigin(apiBase), check};
}

function sole(html, pattern, label) {
  const found = [...html.matchAll(new RegExp(pattern.source, 'g'))];
  if (found.length !== 1) throw fail(`index.html must contain exactly one ${label}`, 2);
  return found[0];
}

function assertDefaultIndex(html) {
  if (html.includes('name="robots"') || html.includes('cloud-config.event.js')) {
    throw fail('index.html must stay the default page', 2);
  }
}

function replaceConnect(part, origin, count) {
  const body = part.trim();
  if (body === '' || body.split(/\s+/)[0] !== 'connect-src') return part;
  count();
  return `${part.match(/^\s*/)[0]}connect-src 'self' ${origin}`;
}

export function rewriteConnectSrc(policy, origin) {
  let seen = 0;
  const next = policy.split(';').map(part => replaceConnect(part, origin, () => { seen += 1; }));
  if (seen !== 1) throw fail('CSP must contain exactly one connect-src', 2);
  const rewritten = next.join(';');
  if (rewritten.includes('http://127.0.0.1')) throw fail('event CSP must not allow loopback', 2);
  return rewritten;
}

function replaceOnce(text, needle, replacement) {
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + needle.length) !== -1) throw fail('expected one unique page edit', 2);
  return text.slice(0, at) + replacement + text.slice(at + needle.length);
}

function withEventTitle(html, title, newline) {
  const line = `  ${title[0]}`;
  if (html.split(line).length !== 2) throw fail('index.html title must be one indented tag', 2);
  const next = `  <title>${title[1]}${EVENT_TITLE_SUFFIX}</title>`;
  const robots = `  <meta name="robots" content="noindex">${newline}`;
  return replaceOnce(html, line, `${robots}${next}`);
}

export function eventHtmlFromIndex(indexHtml, origin) {
  const script = sole(indexHtml, SCRIPT, 'cloud-config script');
  const csp = sole(indexHtml, CSP, 'CSP meta');
  const title = sole(indexHtml, TITLE, 'title');
  assertDefaultIndex(indexHtml);
  if (!script[1]) throw fail('cloud-config version is missing', 2);
  const policy = rewriteConnectSrc(csp[1], origin);
  const newline = indexHtml.includes('\r\n') ? '\r\n' : '\n';
  const scriptTag = script[0].split('cloud-config.js?v=').join('cloud-config.event.js?v=');
  const cspTag = csp[0].split(csp[1]).join(policy);
  let html = replaceOnce(indexHtml, script[0], scriptTag);
  html = replaceOnce(html, csp[0], cspTag);
  html = withEventTitle(html, title, newline);
  return injectBooth(html, newline);
}

function injectBooth(html, newline){
  const found = [...html.matchAll(new RegExp(HOSTED.source, 'g'))];
  if (found.length === 0) return html;
  if (found.length !== 1) throw fail('index.html must contain exactly one hosted-ai script', 2);
  const version = found[0][1];
  if (!version) throw fail('hosted-ai version is missing', 2);
  const tag = found[0][0];
  const extra = [
    tag,
    `  <link rel="stylesheet" href="event-theme.css?v=${version}">`,
    `  <link rel="stylesheet" href="booth.css?v=${version}">`,
    `  <script src="booth.js?v=${version}" defer></script>`,
  ].join(newline);
  return replaceOnce(html, tag, extra);
}

export function eventConfigSource(origin, newline = '\n') {
  return [
    '// Event page only. The default Pages entry keeps cloud-config.js.',
    '// Public gateway only. Secrets, session keys and paper records never belong in this file.',
    '// provider stays confluence. hostedAi, openAccess and booth are enabled for this page.',
    'globalThis.FalsifyCloudConfig = Object.freeze({',
    `  apiBase: '${origin}',`,
    "  provider: 'confluence',",
    '  hostedAi: Object.freeze({',
    '    enabled: true,',
    `    apiBase: '${origin}'`,
    '  }),',
    '  openAccess: Object.freeze({ enabled: true }),',
    '  booth: Object.freeze({ enabled: true })',
    '});',
    '',
  ].join(newline);
}

export function planEventFiles(indexHtml, apiBase) {
  const origin = eventApiOrigin(apiBase);
  const newline = indexHtml.includes('\r\n') ? '\r\n' : '\n';
  return {html: eventHtmlFromIndex(indexHtml, origin), config: eventConfigSource(origin, newline)};
}

export function eventBytesDiffer(actual, expected) {
  return !actual || !actual.equals(Buffer.from(expected));
}

function readOrNull(abs) {
  try { return readFileSync(abs); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function requireMatch(rel, abs, expected) {
  if (eventBytesDiffer(readOrNull(abs), expected)) {
    throw fail(`${rel} differs from the event page this command would write`, 1);
  }
}

function main() {
  const args = parseEventArgs(process.argv.slice(2));
  let index;
  try { index = readFileSync(join(root, INDEX_REL)); }
  catch { throw fail('app/dist/index.html is unreadable', 2); }
  const planned = planEventFiles(index.toString('utf8'), args.apiBase);
  if (args.check) {
    requireMatch(HTML_REL, join(root, HTML_REL), planned.html);
    requireMatch(CONFIG_REL, join(root, CONFIG_REL), planned.config);
  } else {
    writeFileSync(join(root, HTML_REL), planned.html);
    writeFileSync(join(root, CONFIG_REL), planned.config);
  }
  console.log(JSON.stringify({
    schema: 'falsify.event-page.v1',
    ok: true,
    apiBase: args.apiBase,
    check: args.check,
    wrote: args.check ? [] : [HTML_REL, CONFIG_REL],
  }));
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  try { main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  }
}
