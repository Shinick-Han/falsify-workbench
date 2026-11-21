import { clip, splitRationale } from './note.mjs';
import { findingPageIndex, findingPageIndexes } from './findings.mjs';
import { changedNumbers, fold, jaccard, numberAppears } from './text.mjs';

// The finding's own quote, its source quote, and every evidence quote it cites.
function quoteTexts(finding) {
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  const parts = [finding.quote, finding.sourceQuote, ...evidence.map(item => item?.quote)];
  return parts.filter(part => typeof part === 'string' && part);
}

function bestQuote(finding) {
  if (typeof finding.quote === 'string' && finding.quote) return finding.quote;
  if (typeof finding.sourceQuote === 'string') return finding.sourceQuote;
  return '';
}

// Same page is required: the finding's own page or any page its evidence cites.
// Caught is containment or high token overlap with a quote or evidence quote.
// Partial is weaker overlap, or a number that changed between before and after
// appearing in a quote, an evidence quote, or the rationale.
function judge(edit, finding) {
  const after = typeof edit.after === 'string' ? edit.after : '';
  const foldedAfter = fold(after);
  const texts = quoteTexts(finding);
  const contained = foldedAfter.length >= 4 && texts.some(text => fold(text).includes(foldedAfter));
  const ratio = Math.max(0, ...texts.map(text => jaccard(after, text)));
  const numberText = [...texts, finding.rationale].filter(part => typeof part === 'string').join('\n');
  const numbers = changedNumbers(edit.before || '', after);
  const numHit = numbers.some(number => numberAppears(numberText, number));
  let verdict = '';
  if (contained || ratio >= 0.6) verdict = 'caught';
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
  const candidates = [];
  if (findingPageIndex(finding) === edit.pageIndex) candidates.push(finding.quote, finding.sourceQuote);
  for (const item of finding.evidence || []) {
    if (findingPageIndex(item) === edit.pageIndex) candidates.push(item.quote);
  }
  const after = fold(edit.after || '');
  const numbers = changedNumbers(edit.before || '', edit.after || '');
  let quote = '';
  let best = -1;
  for (const text of candidates) {
    if (typeof text !== 'string' || !text) continue;
    const contains = after.length > 0 && fold(text).includes(after);
    const numHit = numbers.some(number => numberAppears(text, number));
    const strength = (contains ? 4 : 0) + (numHit ? 2 : 0) + jaccard(edit.after || '', text);
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
