import { DEFAULT_NOTES } from './config.mjs';
import { findingPageIndexes, physicalPage } from './findings.mjs';

export const NOTE_MAX = 1000;
const QUOTE_MAX = 200;
const RATIONALE_MAX = 300;

function squash(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function clip(value, max) {
  const text = squash(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// The finding's own page, else the first page its evidence cites. 1-based, '' when unknown.
export function notePage(finding) {
  const own = physicalPage(finding);
  if (own !== '') return own;
  const pages = [...findingPageIndexes(finding)].sort((a, b) => a - b);
  return pages.length ? pages[0] + 1 : '';
}

// BLUE writes "<Korean> || EN: <English>" in its one rationale field (the runtime schema has no second field).
const EN_MARK = /\s*\|\|\s*EN:\s*/i;

export function splitRationale(value) {
  const text = squash(value);
  const at = text.search(EN_MARK);
  if (at < 0) return { ko: text, en: '' };
  return { ko: text.slice(0, at), en: text.slice(at).replace(EN_MARK, '') };
}

function fill(template, values) {
  const lines = values.rationaleEn ? template : template.split('\n').filter(line => !line.includes('{rationaleEn}')).join('\n');
  return lines.replace(/\{(page|quote|rationaleEn|rationale)\}/g, (_, key) => String(values[key] ?? ''));
}

// Built only from the AI finding: page, quote and rationale. The visitor's declared text is not an input.
export function buildPublicNote({ outcome, matched, first, templates }) {
  const escaped = outcome === 'missed' && Boolean(matched);
  const finding = escaped ? matched : (outcome === 'missed' ? first : matched);
  if (!finding || (outcome === 'missed' && !escaped && notePage(finding) === '')) {
    return (templates?.missedNone ?? DEFAULT_NOTES.missedNone).slice(0, NOTE_MAX);
  }
  const template = escaped
    ? (templates?.escaped ?? DEFAULT_NOTES.escaped)
    : (templates?.[outcome] || templates?.missed || DEFAULT_NOTES.missed);
  const reason = splitRationale(finding.rationale || '');
  const values = {
    page: notePage(finding) || '?',
    quote: clip(finding.quote || finding.sourceQuote || '', QUOTE_MAX),
    rationale: clip(reason.ko || reason.en, RATIONALE_MAX),
    rationaleEn: reason.ko ? clip(reason.en, RATIONALE_MAX) : '',
  };
  return fill(template, values).slice(0, NOTE_MAX);
}
