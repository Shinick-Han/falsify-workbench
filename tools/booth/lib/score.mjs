import { findingPageIndex } from './findings.mjs';
import { changedNumbers, fold, jaccard, numberAppears } from './text.mjs';

function quoteText(finding) {
  return [finding.quote, finding.sourceQuote].filter(part => typeof part === 'string').join('\n');
}

function bestQuote(finding) {
  if (typeof finding.quote === 'string' && finding.quote) return finding.quote;
  if (typeof finding.sourceQuote === 'string') return finding.sourceQuote;
  return '';
}

// Same page is required. Caught is containment or high token overlap.
// Partial is weaker overlap, or a number that changed between before and after appearing in the quote.
export function matchEdit(edit, wrappedFindings) {
  const page = edit.pageIndex;
  let best = null;
  for (const wrapped of wrappedFindings) {
    const finding = wrapped.finding || wrapped;
    if (findingPageIndex(finding) !== page) continue;
    const quote = quoteText(finding);
    const after = typeof edit.after === 'string' ? edit.after : '';
    const foldedAfter = fold(after);
    const contained = foldedAfter.length >= 4 && (fold(finding.quote || '').includes(foldedAfter) || fold(finding.sourceQuote || '').includes(foldedAfter));
    const ratio = Math.max(jaccard(after, finding.quote || ''), jaccard(after, finding.sourceQuote || ''));
    const numbers = changedNumbers(edit.before || '', after);
    const numHit = numbers.some(number => numberAppears(quote, number));
    let verdict = '';
    if (contained || ratio >= 0.6) verdict = 'caught';
    else if (ratio >= 0.3 || numHit) verdict = 'partial';
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
    }
  }
  if (!best) return { verdict: 'missed', ratio: 0, numHit: false, profile: '', repeat: null, quote: '' };
  return best;
}

export function suggestOutcome(verdicts) {
  if (!verdicts.length) return 'missed';
  if (verdicts.every(verdict => verdict === 'caught')) return 'caught';
  if (verdicts.every(verdict => verdict === 'missed')) return 'missed';
  return 'partial';
}

export function scoreSubmission(row, wrappedFindings) {
  const declared = Array.isArray(row.declared) ? row.declared : [];
  const edits = declared.map((edit, index) => {
    const match = matchEdit(edit, wrappedFindings);
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
    };
  });
  return {
    receipt: row.receipt,
    suggestedOutcome: suggestOutcome(edits.map(edit => edit.verdict)),
    noBlueResult: wrappedFindings.length === 0,
    edits,
  };
}
