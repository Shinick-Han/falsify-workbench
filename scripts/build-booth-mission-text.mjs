#!/usr/bin/env node
// Builds cloud/api/src/booth-mission-text.json (falsify.booth.mission-text.v1) from mission PDFs.
// Recipe contract v1 sections 2 and 4: the event Worker serves this bundle at
// GET /v1/booth/missions/:paperId/text and through the agent MCP endpoint.
//
// Usage:
//   node scripts/build-booth-mission-text.mjs <pdf-dir> [--list <papers.json>] [--out <file>] [--check]
//
// <pdf-dir> holds <arXiv id>.pdf files. The PDFs are never committed.
// --list    Paper list (default scripts/booth-mission-papers.json): [{paperId,title,license,url,licenseSource}].
//           Titles, licenses and ids come from this list, never from guesses.
// --out     Output path (default cloud/api/src/booth-mission-text.json).
// --check   Rebuild in memory and exit 1 when the output file differs.
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA = 'falsify.booth.mission-text.v1';
export const DEFAULT_LIST = join(root, 'scripts/booth-mission-papers.json');
export const DEFAULT_OUT = join(root, 'cloud/api/src/booth-mission-text.json');
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/;
const CC_BY_4 = /creativecommons\.org\/licenses\/by\/4\.0/;

export function parseArgs(argv) {
  const opts = {dir: null, list: DEFAULT_LIST, out: DEFAULT_OUT, check: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--list' || arg === '--out') opts[arg.slice(2)] = resolve(argv[++i] ?? '');
    else if (!arg.startsWith('--') && !opts.dir) opts.dir = resolve(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.dir) throw new Error('Usage: build-booth-mission-text.mjs <pdf-dir> [--list file] [--out file] [--check]');
  return opts;
}

export function readPaperList(path) {
  const list = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(list)) throw new Error('Paper list must be an array');
  const byId = new Map();
  for (const item of list) {
    if (!ARXIV_ID.test(item?.paperId ?? '')) throw new Error(`Bad paperId in list: ${item?.paperId}`);
    for (const key of ['title', 'license', 'url']) {
      if (typeof item[key] !== 'string' || !item[key].trim()) throw new Error(`${item.paperId}: missing ${key}`);
    }
    if (!['pdf-xmp', 'asserted'].includes(item.licenseSource)) throw new Error(`${item.paperId}: licenseSource must be pdf-xmp or asserted`);
    byId.set(item.paperId, item);
  }
  return byId;
}

// Text items to lines (by baseline) and paragraphs (by a vertical gap well above the line pitch).
function itemLines(items) {
  const lines = [];
  let line = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const [, , , , x, y] = item.transform;
    const size = Math.abs(item.transform[3]) || item.height || 10;
    if (!line || Math.abs(y - line.y) > size * 0.5) {
      line = {y, size, x: x, end: x, text: ''};
      lines.push(line);
    } else if (x - line.end > size * 0.15 && !/\s$/.test(line.text) && !/^\s/.test(item.str)) {
      line.text += ' ';
    }
    line.text += item.str;
    line.end = Math.max(line.end, x + (item.width || 0));
    line.size = Math.max(line.size, size);
  }
  return lines.map(l => ({...l, text: l.text.replace(/\s+/g, ' ').trim()})).filter(l => l.text);
}

export function linesToText(lines) {
  let out = '';
  let prev = null;
  for (const line of lines) {
    if (prev) {
      const gap = Math.abs(prev.y - line.y);
      out += gap > Math.max(prev.size, line.size) * 1.75 ? '\n\n' : '\n';
    }
    out += line.text;
    prev = line;
  }
  return out;
}

export function pageTextFromItems(items) {
  return linesToText(itemLines(items));
}

async function loadPdfjs() {
  const path = join(root, 'app/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
  return import(pathToFileURL(path).href);
}

export async function extractPages(bytes, pdfjs) {
  const task = pdfjs.getDocument({data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false});
  const doc = await task.promise;
  try {
    const pages = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      pages.push({page, text: pageTextFromItems(content.items)});
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

export function pdfDeclaresCcBy4(bytes) {
  return CC_BY_4.test(Buffer.from(bytes).toString('latin1'));
}

function checkLicense(entry, bytes, warnings) {
  const declared = pdfDeclaresCcBy4(bytes);
  if (entry.licenseSource === 'pdf-xmp' && !declared) throw new Error(`${entry.paperId}: list says pdf-xmp but the PDF has no CC BY 4.0 URL`);
  if (entry.licenseSource === 'asserted' && declared) warnings.push(`${entry.paperId}: PDF declares CC BY 4.0; licenseSource could be pdf-xmp`);
}

export async function buildBundle(dir, list, {pdfjs, warnings = []} = {}) {
  const lib = pdfjs ?? await loadPdfjs();
  const files = readdirSync(dir).filter(name => name.toLowerCase().endsWith('.pdf')).sort();
  if (!files.length) throw new Error(`No PDFs in ${dir}`);
  const papers = {};
  for (const name of files) {
    const paperId = name.slice(0, -4);
    const entry = list.get(paperId);
    if (!entry) throw new Error(`${name}: not in the paper list`);
    const bytes = readFileSync(join(dir, name));
    checkLicense(entry, bytes, warnings);
    const pages = await extractPages(bytes, lib);
    papers[paperId] = {paperId, title: entry.title, license: entry.license, url: entry.url, pages};
  }
  return {schema: SCHEMA, papers};
}

export function serialize(bundle) {
  return JSON.stringify(bundle, null, 1) + '\n';
}

async function main(argv) {
  const opts = parseArgs(argv);
  const warnings = [];
  const text = serialize(await buildBundle(opts.dir, readPaperList(opts.list), {warnings}));
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (opts.check) {
    let current = '';
    try { current = readFileSync(opts.out, 'utf8'); } catch {}
    if (current !== text) {
      console.error(`${opts.out} is stale; rerun without --check`);
      return 1;
    }
    console.log(`${opts.out} is up to date`);
    return 0;
  }
  writeFileSync(opts.out, text);
  const count = Object.keys(JSON.parse(text).papers).length;
  console.log(`wrote ${opts.out}: ${count} papers, ${Buffer.byteLength(text)} bytes`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
