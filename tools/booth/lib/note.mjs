import matcher from '../../../app/dist/w8-matcher.js';
import { DEFAULT_NOTES } from './config.mjs';
import { findingPageIndexes, physicalPage } from './findings.mjs';

export const { clip, splitRationale } = matcher;

export const NOTE_MAX = 1000;
const QUOTE_MAX = 200;
const RATIONALE_MAX = 300;

// The finding's own page, else the first page its evidence cites. 1-based, '' when unknown.
export function notePage(finding) {
  const own = physicalPage(finding);
  if (own !== '') return own;
  const pages = [...findingPageIndexes(finding)].sort((a, b) => a - b);
  return pages.length ? pages[0] + 1 : '';
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
