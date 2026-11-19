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

function fill(template, values) {
  return template.replace(/\{(page|quote|rationale)\}/g, (_, key) => String(values[key] ?? ''));
}

// Built only from the AI finding: page, quote and rationale. The visitor's declared text is not an input.
export function buildPublicNote({ outcome, matched, first, templates }) {
  const finding = outcome === 'missed' ? first : matched;
  if (!finding || (outcome === 'missed' && notePage(finding) === '')) return templates.missedNone.slice(0, NOTE_MAX);
  const template = templates[outcome] || templates.missed;
  const values = {
    page: notePage(finding) || '?',
    quote: clip(finding.quote || finding.sourceQuote || '', QUOTE_MAX),
    rationale: clip(finding.rationale || '', RATIONALE_MAX),
  };
  return fill(template, values).slice(0, NOTE_MAX);
}
