import { clip, splitRationale } from './note.mjs';
import { findingPageIndex, findingPageIndexes } from './findings.mjs';
import { changedNumbers, fold, jaccard, numberAppears } from './text.mjs';

const ALNUM = /[\p{L}\p{N}]/u;

// The finding's own quote, its source quote, and every evidence quote it cites.
function quoteTexts(finding) {
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  const parts = [finding.quote, finding.sourceQuote, ...evidence.map(item => item?.quote)];
  return parts.filter(part => typeof part === 'string' && part);
}

// Only quotes that belong to the edit's actual page.
function pageQuotes(finding, pageIndex) {
  const parts = [];
  if (findingPageIndex(finding) === pageIndex) parts.push(finding.quote, finding.sourceQuote);
  for (const item of finding.evidence || []) {
    if (findingPageIndex(item) === pageIndex) parts.push(item.quote);
  }
  return parts.filter(part => typeof part === 'string' && part);
}

function bestQuote(finding) {
  if (typeof finding.quote === 'string' && finding.quote) return finding.quote;
  if (typeof finding.sourceQuote === 'string') return finding.sourceQuote;
  return '';
}

function isWordBoundary(text, start, end) {
  const left = start === 0 || !ALNUM.test(text[start - 1]) || !ALNUM.test(text[start]);
  const right = end === text.length || !ALNUM.test(text[end - 1]) || !ALNUM.test(text[end]);
  return left && right;
}

function findWhole(haystack, needle, from = 0) {
  if (!haystack || !needle) return -1;
  let pos = from;
  while (pos <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, pos);
    if (at < 0) return -1;
    if (isWordBoundary(haystack, at, at + needle.length)) return at;
    pos = at + 1;
  }
  return -1;
}

// Common prefix/suffix diff in folded after, plus a small word-bounded window around the change.
function changedRegion(before, after) {
  const b = fold(before || '');
  const a = fold(after || '');
  if (!b || !a || b === a) return null;
  let start = 0;
  while (start < b.length && start < a.length && b[start] === a[start]) start += 1;
  let suffix = 0;
  while (suffix < b.length - start && suffix < a.length - start
    && b[b.length - 1 - suffix] === a[a.length - 1 - suffix]) suffix += 1;
  const end = a.length - suffix;
  let winStart = Math.max(0, start - 6);
  while (winStart > 0 && ALNUM.test(a[winStart - 1])) winStart -= 1;
  while (winStart < start && /\s/.test(a[winStart])) winStart += 1;
  let winEnd = Math.min(a.length, end + 6);
  while (winEnd < a.length && ALNUM.test(a[winEnd])) winEnd += 1;
  while (winEnd > end && /\s/.test(a[winEnd - 1])) winEnd -= 1;
  const win = a.slice(winStart, winEnd);
  const windowOk = win.length >= 12
    && findWhole(b, win) < 0
    && (start < end || (start - winStart >= 4 && winEnd - start >= 4));
  return { before: b, after: a, start, end, window: windowOk ? win : '' };
}

function quoteHitsChange(region, text) {
  if (!region) return false;
  const q = fold(text);
  if (q.length < 12 || findWhole(region.before, q) >= 0) return false;
  if (region.window && findWhole(q, region.window) >= 0) return true;
  let at = findWhole(region.after, q);
  if (at < 0) return false;
  let hits = false;
  while (at >= 0) {
    const stop = at + q.length;
    const spans = region.start === region.end
      ? (at < region.start && stop > region.start && region.start - at >= 4 && stop - region.start >= 4)
      : (at <= region.start && stop >= region.end && (q.length - (region.end - region.start) >= 4 || region.end - region.start >= 12));
    if (!spans) return false;
    hits = true;
    at = findWhole(region.after, q, at + 1);
  }
  return hits;
}

// Same page is required: the finding's own page or any page its evidence cites.
// Caught is containment, a same-page quote spanning the changed region, or high token overlap.
// Partial is weaker overlap, or a number that changed between before and after
// appearing in a quote, an evidence quote, or the rationale.
function judge(edit, finding) {
  const after = typeof edit.after === 'string' ? edit.after : '';
  const foldedAfter = fold(after);
  const texts = quoteTexts(finding);
  const contained = foldedAfter.length >= 4 && texts.some(text => fold(text).includes(foldedAfter));
  const region = changedRegion(edit.before || '', after);
  const spanHit = Boolean(region && pageQuotes(finding, edit.pageIndex).some(text => quoteHitsChange(region, text)));
  const ratio = Math.max(0, ...texts.map(text => {
    const q = fold(text);
    if (region && q && findWhole(region.before, q) >= 0 && !q.includes(foldedAfter)) return 0;
    return jaccard(after, text);
  }));
  const numberText = [...texts, finding.rationale].filter(part => typeof part === 'string').join('\n');
  const numbers = changedNumbers(edit.before || '', after);
  const numHit = numbers.some(number => numberAppears(numberText, number));
  let verdict = '';
  if (contained || spanHit || ratio >= 0.6) verdict = 'caught';
  else if (ratio >= 0.3 || numHit) verdict = 'partial';
  return { verdict, ratio, numHit };
}

// The best match plus the finding it came from (null when missed).
export function matchEditDetailed(edit, wrappedFindings) {
  const page = edit.pageIndex;
  let best = null;
  let bestFinding = null;
  for (const wrapped of wrappedFindings) {
    const finding = wrapped.finding || wrapped;
    if (!findingPageIndexes(finding).has(page)) continue;
    const { verdict, ratio, numHit } = judge(edit, finding);
    if (!verdict) continue;
    const rank = verdict === 'caught' ? 2 : 1;
    if (!best || rank > best.rank || (rank === best.rank && ratio > best.ratio)) {
      best = {
        verdict,
        rank,
        ratio: Number(ratio.toFixed(4)),
        numHit,
        profile: wrapped.profile || '',
        repeat: wrapped.repeat ?? null,
        quote: bestQuote(finding).slice(0, 240),
      };
      bestFinding = finding;
    }
  }
  if (!best) return { match: { verdict: 'missed', ratio: 0, numHit: false, profile: '', repeat: null, quote: '' }, finding: null };
  return { match: best, finding: bestFinding };
}

export function matchEdit(edit, wrappedFindings) {
  return matchEditDetailed(edit, wrappedFindings).match;
}

// Across every declared edit: the strongest match and its finding, or null when all are missed.
export function bestMatchedFinding(row, wrappedFindings) {
  const declared = Array.isArray(row.declared) ? row.declared : [];
  let best = null;
  for (const edit of declared) {
    const { match, finding } = matchEditDetailed(edit, wrappedFindings);
    if (!finding) continue;
    if (!best || match.rank > best.match.rank || (match.rank === best.match.rank && match.ratio > best.match.ratio)) {
      best = { match, finding };
    }
  }
  return best;
}

export function suggestOutcome(verdicts) {
  if (!verdicts.length) return 'missed';
  if (verdicts.some(verdict => verdict === 'missed' || verdict === '')) return 'missed';
  if (verdicts.every(verdict => verdict === 'caught')) return 'caught';
  return 'partial';
}

// Show the quote at the edit, including a cited table cell when the primary finding is on another page.
function editEvidence(edit, finding) {
  const candidates = pageQuotes(finding, edit.pageIndex);
  const after = fold(edit.after || '');
  const region = changedRegion(edit.before || '', edit.after || '');
  const numbers = changedNumbers(edit.before || '', edit.after || '');
  let quote = '';
  let best = -1;
  for (const text of candidates) {
    const contains = after.length > 0 && fold(text).includes(after);
    const spanHit = Boolean(region && quoteHitsChange(region, text));
    const numHit = numbers.some(number => numberAppears(text, number));
    const strength = (contains || spanHit ? 4 : 0) + (numHit ? 2 : 0) + jaccard(edit.after || '', text);
    if (strength > best) {
      best = strength;
      quote = text;
    }
  }
  const reason = splitRationale(finding.rationale);
  const evidence = {};
  for (const [key, value, limit] of [['quote', quote, 240], ['rationale', reason.ko, 300], ['rationaleEn', reason.en, 300]]) {
    if (value) evidence[key] = clip(value.replace(/[\u0000-\u001f]/g, ' '), limit);
  }
  return evidence;
}

export function scoreSubmission(row, wrappedFindings) {
  const declared = Array.isArray(row.declared) ? row.declared : [];
  const edits = declared.map((edit, index) => {
    const { match, finding } = matchEditDetailed(edit, wrappedFindings);
    return {
      index,
      pageIndex: edit.pageIndex,
      defectType: edit.defectType || '',
      verdict: match.verdict,
      ratio: match.ratio,
      numberHit: match.numHit,
      profile: match.profile,
      repeat: match.repeat,
      quote: match.quote,
      ...(finding ? { evidence: editEvidence(edit, finding) } : {}),
    };
  });
  return {
    receipt: row.receipt,
    suggestedOutcome: suggestOutcome(edits.map(edit => edit.verdict)),
    noBlueResult: wrappedFindings.length === 0,
    edits,
  };
}
