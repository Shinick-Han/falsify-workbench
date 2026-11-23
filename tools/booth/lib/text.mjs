import { createHash } from 'node:crypto';
import matcher from '../../../app/dist/w8-matcher.js';

export const {
  fold,
  tokens,
  jaccard,
  numbersIn,
  changedNumbers,
  numberAppears,
} = matcher;

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
