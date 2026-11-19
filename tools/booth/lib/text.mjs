import { createHash } from 'node:crypto';

export function sha256Hex(value) {
  const hash = createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}

export function sha256File(bytes) {
  return sha256Hex(bytes);
}

// Stable JSON so a config hash changes only when a BLUE setting changes.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function fold(value) {
  return String(value ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function tokens(value) {
  return fold(value).split(/[^\p{L}\p{N}.]+/u).filter(Boolean);
}

export function jaccard(a, b) {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function numbersIn(value) {
  return [...String(value ?? '').matchAll(/\d+(?:\.\d+)?/g)].map(match => match[0]);
}

// Numbers added or removed between the declared before and after text.
export function changedNumbers(before, after) {
  const pool = numbersIn(before);
  const changed = [];
  for (const number of numbersIn(after)) {
    const index = pool.indexOf(number);
    if (index === -1) changed.push(number);
    else pool.splice(index, 1);
  }
  changed.push(...pool);
  return changed;
}

export function numberAppears(quote, number) {
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`).test(String(quote ?? ''));
}

// Spreadsheet formula injection. A leading apostrophe is applied before quoting.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

// Excel opens UTF-8 Korean when the file starts with a BOM. CRLF keeps rows intact.
export function toCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map(column => csvCell(row[column])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function parseCsvSet(value) {
  if (value == null || value === true || value === '') return null;
  const items = String(value).split(',').map(item => item.trim()).filter(Boolean);
  return new Set(items);
}
