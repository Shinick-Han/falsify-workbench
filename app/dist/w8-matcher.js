/* Shared browser-safe event & W8 edit matcher (single source for tools/booth/lib/score.mjs and W8 workbench). */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root && typeof root === 'object') root.FalsifyW8Matcher = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const ALNUM = /[\p{L}\p{N}]/u;
  const NON_TOKEN = /[^\p{L}\p{N}.]+/u;
  const NUMBER_RE = /\d+(?:\.\d+)?/g;
  const DIGIT_OR_DOT = /[\d.]/;
  const EN_MARK = /\s*\|\|\s*EN:\s*/i;
  const CONTROL_CHARS = /[\u0000-\u001f]/g;
  const SEGMENT_PAGE_RE = /^p(\d{1,5})-/;

  function fold(value) {
    return String(value ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function tokens(value) {
    return fold(value).split(NON_TOKEN).filter(Boolean);
  }

  function jaccard(a, b) {
    const left = new Set(tokens(a));
    const right = new Set(tokens(b));
    if (!left.size || !right.size) return 0;
    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;
    return shared / (left.size + right.size - shared);
  }

  function numbersIn(value) {
    return String(value ?? '').match(NUMBER_RE) || [];
  }

  // Numbers added or removed between the declared before and after text.
  function changedNumbers(before, after) {
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

  // Boundary check without RegExp lookbehind for full Safari/WebKit compatibility.
  function numberAppears(quote, number) {
    const text = String(quote ?? '');
    const needle = String(number ?? '');
    let pos = 0;
    while (pos <= text.length - needle.length) {
      const at = text.indexOf(needle, pos);
      if (at < 0) return false;
      const end = at + needle.length;
      const leftOk = at === 0 || !DIGIT_OR_DOT.test(text[at - 1]);
      const rightOk = end === text.length || !DIGIT_OR_DOT.test(text[end]);
      if (leftOk && rightOk) return true;
      pos = at + 1;
    }
    return false;
  }

  function squash(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function clip(value, max) {
    const text = squash(value);
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1).trimEnd()}…`;
  }

  // BLUE writes "<Korean> || EN: <English>" in its one rationale field (the runtime schema has no second field).
  function splitRationale(value) {
    const text = squash(value);
    const at = text.search(EN_MARK);
    if (at < 0) return { ko: text, en: '' };
    return { ko: text.slice(0, at), en: text.slice(at).replace(EN_MARK, '') };
  }

  function isUsableFinding(finding) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return false;
    const state = String(finding.status || finding.state || '').trim().toLowerCase();
    return state !== 'rejected' && state !== 'unresolved';
  }

  // pageIndex is 0-based. The hosted prompt's `page` field is 1-based.
  // Hosted BLUE findings carry neither; their segmentId "p<N>-..." names the 1-based physical page.
  function declaredPageIndex(item) {
    if (Number.isInteger(item.pageIndex) && item.pageIndex >= 0 && item.pageIndex <= 9999) return item.pageIndex;
    if (Number.isInteger(item.page) && item.page >= 1 && item.page <= 10000) return item.page - 1;
    return null;
  }

  function segmentPageIndex(segmentId) {
    const match = SEGMENT_PAGE_RE.exec(typeof segmentId === 'string' ? segmentId : '');
    if (!match) return null;
    const page = Number(match[1]);
    return page >= 1 && page <= 10000 ? page - 1 : null;
  }

  function itemPageIndex(item) {
    if (!item || typeof item !== 'object') return null;
    const declared = declaredPageIndex(item);
    return declared != null ? declared : segmentPageIndex(item.segmentId);
  }

  // The finding's primary page: the page of its own quote.
  function findingPageIndex(finding) {
    return itemPageIndex(finding);
  }

  // Every page a finding points at: its own quote plus each cited evidence segment.
  function findingPageIndexes(finding) {
    const pages = new Set();
    const evidence = Array.isArray(finding?.evidence) ? finding.evidence : [];
    for (const item of [finding, ...evidence]) {
      const index = itemPageIndex(item);
      if (index != null) pages.add(index);
    }
    return pages;
  }

  function physicalPage(finding) {
    const index = findingPageIndex(finding);
    if (index != null) return index + 1;
    return '';
  }

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

  function commonPrefixLength(a, b) {
    let start = 0;
    while (start < b.length && start < a.length && b[start] === a[start]) start += 1;
    return start;
  }

  function commonSuffixLength(a, b, start) {
    let suffix = 0;
    const maxSuffix = Math.min(b.length - start, a.length - start);
    while (suffix < maxSuffix && b[b.length - 1 - suffix] === a[a.length - 1 - suffix]) suffix += 1;
    return suffix;
  }

  function expandWindowBounds(a, start, end) {
    let winStart = Math.max(0, start - 6);
    while (winStart > 0 && ALNUM.test(a[winStart - 1])) winStart -= 1;
    while (winStart < start && /\s/.test(a[winStart])) winStart += 1;
    let winEnd = Math.min(a.length, end + 6);
    while (winEnd < a.length && ALNUM.test(a[winEnd])) winEnd += 1;
    while (winEnd > end && /\s/.test(a[winEnd - 1])) winEnd -= 1;
    return { winStart, winEnd };
  }

  // Common prefix/suffix diff in folded after, plus a small word-bounded window around the change.
  function changedRegion(before, after) {
    const b = fold(before || '');
    const a = fold(after || '');
    if (!b || !a || b === a) return null;
    const start = commonPrefixLength(a, b);
    const end = a.length - commonSuffixLength(a, b, start);
    const { winStart, winEnd } = expandWindowBounds(a, start, end);
    const win = a.slice(winStart, winEnd);
    const hasSpan = start < end || (start - winStart >= 4 && winEnd - start >= 4);
    const windowOk = win.length >= 12 && findWhole(b, win) < 0 && hasSpan;
    return { before: b, after: a, start, end, window: windowOk ? win : '' };
  }

  function spanCoversChange(region, at, length) {
    const stop = at + length;
    if (region.start === region.end) {
      return at < region.start && stop > region.start && region.start - at >= 4 && stop - region.start >= 4;
    }
    const delta = region.end - region.start;
    return at <= region.start && stop >= region.end && (length - delta >= 4 || delta >= 12);
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
      if (!spanCoversChange(region, at, q.length)) return false;
      hits = true;
      at = findWhole(region.after, q, at + 1);
    }
    return hits;
  }

  function maxOverlapRatio(texts, after, foldedAfter, region) {
    return Math.max(0, ...texts.map(text => {
      const q = fold(text);
      if (region && q && findWhole(region.before, q) >= 0 && !q.includes(foldedAfter)) return 0;
      return jaccard(after, text);
    }));
  }

  const COMPARISON_PAIR = /([\p{L}\p{N}][\p{L}\p{N}.-]*)\s+than\s+(?:to\s+)?([\p{L}\p{N}][\p{L}\p{N}.-]*)/gu;

  function orderedComparisons(text) {
    return Array.from(fold(text).matchAll(COMPARISON_PAIR), match => [match[1].replace(/\.+$/, ''), match[2].replace(/\.+$/, '')]);
  }

  function citesReorderedComparison(edit, finding) {
    const before = orderedComparisons(edit.before || '')[0];
    const after = orderedComparisons(edit.after || '')[0];
    if (!before || !after || before[0] === before[1]) return false;
    if (before[0] !== after[1] || before[1] !== after[0]) return false;
    const local = pageQuotes(finding, edit.pageIndex).map(fold);
    if (!local.some(text => after.some(word => findWhole(text, word) >= 0))) return false;
    return orderedComparisons(finding.rationale || '').some(([left, right]) => left === after[0] && right === after[1]);
  }

  function citesChangedNumber(edit, finding, local) {
    const anchors = tokens(edit.after).filter(word => /\p{L}{3}/u.test(word));
    const claim = [findingPageIndex(finding) === edit.pageIndex ? bestQuote(finding) : '', finding.rationale].join(' ');
    const context = fold([...local, finding.rationale].join(' '));
    const describesChange = /\b(?:number|value|score) (?:changed|revised) to\b/i.test(finding.rationale || '');
    if (anchors.length && !describesChange && !anchors.some(word => findWhole(context, word) >= 0)) return false;
    return changedNumbers(edit.before, edit.after).some(number => numberAppears(claim, number));
  }

  function matchesNumericContext(edit, claim) {
    const anchors = tokens(edit.context).filter(word => /\p{L}{4}/u.test(word));
    if (!anchors.length) return true;
    const text = fold(claim);
    return anchors.some(word => findWhole(text, word) >= 0);
  }

  function judge(edit, finding) {
    const after = typeof edit.after === 'string' ? edit.after : '';
    const foldedAfter = fold(after);
    const texts = quoteTexts(finding);
    const local = pageQuotes(finding, edit.pageIndex);
    const numeric = /^\d+(?:\.\d+)?$/.test(foldedAfter);
    const claim = [findingPageIndex(finding) === edit.pageIndex ? bestQuote(finding) : '', finding.rationale].join(' ');
    if (numeric && !matchesNumericContext(edit, claim)) return { verdict: '', ratio: 0, numHit: false };
    const contained = foldedAfter.length >= 4 && (numeric
      ? [...local, ...unpagedEvidenceQuotes(finding, edit.pageIndex)].some(text => numberAppears(text, foldedAfter))
      : texts.some(text => fold(text).includes(foldedAfter)));
    const region = changedRegion(edit.before || '', after);
    const spanHit = Boolean(region && local.some(text => quoteHitsChange(region, text)));
    const ratio = maxOverlapRatio(texts, after, foldedAfter, region);
    const numHit = citesChangedNumber(edit, finding, local);
    let verdict = '';
    if (contained || spanHit || ratio >= 0.6 || citesReorderedComparison(edit, finding)) verdict = 'caught';
    else if (ratio >= 0.3 || numHit) verdict = 'partial';
    return { verdict, ratio, numHit };
  }

  function isBetterMatch(best, rank, ratio) {
    return !best || rank > best.rank || (rank === best.rank && ratio > best.ratio);
  }

  // The best match plus the finding it came from (null when missed).
  function matchEditDetailed(edit, wrappedFindings) {
    const page = edit.pageIndex;
    let best = null;
    let bestFinding = null;
    for (const wrapped of wrappedFindings) {
      const finding = wrapped.finding || wrapped;
      if (!findingPageIndexes(finding).has(page)) continue;
      const { verdict, ratio, numHit } = judge(edit, finding);
      if (!verdict) continue;
      const rank = verdict === 'caught' ? 2 : 1;
      if (isBetterMatch(best, rank, ratio)) {
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

  function matchEdit(edit, wrappedFindings) {
    return matchEditDetailed(edit, wrappedFindings).match;
  }

  // Across every declared edit: the strongest match and its finding, or null when all are missed.
  function bestMatchedFinding(row, wrappedFindings) {
    const declared = Array.isArray(row.declared) ? row.declared : [];
    let best = null;
    for (const edit of declared) {
      const { match, finding } = matchEditDetailed(edit, wrappedFindings);
      if (!finding) continue;
      if (isBetterMatch(best?.match, match.rank, match.ratio)) {
        best = { match, finding };
      }
    }
    return best;
  }

  function suggestOutcome(verdicts) {
    if (!verdicts.length) return 'missed';
    if (verdicts.some(verdict => verdict === 'missed' || verdict === '')) return 'missed';
    if (verdicts.every(verdict => verdict === 'caught')) return 'caught';
    return 'partial';
  }

  function quoteStrength(edit, after, region, numbers, text) {
    const contains = after.length > 0 && fold(text).includes(after);
    const spanHit = Boolean(region && quoteHitsChange(region, text));
    const numHit = numbers.some(number => numberAppears(text, number));
    return (contains || spanHit ? 4 : 0) + (numHit ? 2 : 0) + jaccard(edit.after || '', text);
  }

  function bestQuoteFrom(edit, candidates) {
    const after = fold(edit.after || '');
    const region = changedRegion(edit.before || '', edit.after || '');
    const numbers = changedNumbers(edit.before || '', edit.after || '');
    let quote = '';
    let best = -1;
    for (const text of candidates) {
      const strength = quoteStrength(edit, after, region, numbers, text);
      if (strength > best) {
        best = strength;
        quote = text;
      }
    }
    return quote;
  }

  // Show the quote at the edit, including a cited table cell when the primary finding is on another page.
  function editEvidence(edit, finding) {
    const quote = bestQuoteFrom(edit, pageQuotes(finding, edit.pageIndex));
    const reason = splitRationale(finding.rationale);
    const evidence = {};
    for (const [key, value, limit] of [['quote', quote, 240], ['rationale', reason.ko, 300], ['rationaleEn', reason.en, 300]]) {
      if (value) evidence[key] = clip(value.replace(CONTROL_CHARS, ' '), limit);
    }
    return evidence;
  }

  function scoreSubmission(row, wrappedFindings) {
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

  function toBoothEdit(edit) {
    const before = typeof edit.originalText === 'string' ? edit.originalText : (typeof edit.before === 'string' ? edit.before : '');
    const after = typeof edit.newText === 'string' ? edit.newText : (typeof edit.after === 'string' ? edit.after : '');
    return {
      pageIndex: edit.pageIndex,
      before,
      after,
      context: typeof edit.context === 'string' ? edit.context : '',
      defectType: typeof edit.defectType === 'string' ? edit.defectType : '',
    };
  }

  function unwrapFinding(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (item.finding && typeof item.finding === 'object' && !Array.isArray(item.finding)) return item.finding;
    return item;
  }

  function usableWrappedFindings(findings) {
    if (!Array.isArray(findings)) return [];
    const list = [];
    for (const item of findings) {
      const finding = unwrapFinding(item);
      if (isUsableFinding(finding)) list.push({ finding });
    }
    return list;
  }

  function mapVerdictToW8(verdict) {
    if (verdict === 'caught') return 'detected';
    if (verdict === 'partial') return 'partial';
    return 'missed';
  }

  function unpagedEvidenceQuotes(finding, pageIndex) {
    if (findingPageIndex(finding) !== pageIndex) return [];
    const list = [];
    for (const item of Array.isArray(finding.evidence) ? finding.evidence : []) {
      if (item && findingPageIndex(item) == null && typeof item.quote === 'string' && item.quote) {
        list.push(item.quote);
      }
    }
    return list;
  }

  function pickW8Quote(boothEdit, finding, evidence, fallbackQuote) {
    const unpaged = unpagedEvidenceQuotes(finding, boothEdit.pageIndex);
    if (!unpaged.length && evidence.quote) return evidence.quote;
    const candidates = [...pageQuotes(finding, boothEdit.pageIndex), ...unpaged];
    const chosen = bestQuoteFrom(boothEdit, candidates) || fallbackQuote || '';
    return chosen ? clip(chosen.replace(CONTROL_CHARS, ' '), 240) : '';
  }

  function findingLink(finding) {
    const id = finding?.id;
    return id !== undefined && id !== null && id !== '' ? [id] : [];
  }

  function match(edit, findings) {
    if (!edit || typeof edit !== 'object') return { verdict: 'missed', links: [], quote: '', rationale: '' };
    const boothEdit = toBoothEdit(edit);
    const wrapped = usableWrappedFindings(findings);
    const { match: detail, finding } = matchEditDetailed(boothEdit, wrapped);
    if (!finding) return { verdict: 'missed', links: [], quote: '', rationale: '' };
    const evidence = editEvidence(boothEdit, finding);
    return {
      verdict: mapVerdictToW8(detail.verdict),
      links: findingLink(finding),
      quote: pickW8Quote(boothEdit, finding, evidence, detail.quote),
      rationale: evidence.rationale || evidence.rationaleEn || '',
    };
  }

  return Object.freeze({
    match,
    matchEditDetailed,
    matchEdit,
    bestMatchedFinding,
    suggestOutcome,
    scoreSubmission,
    isUsableFinding,
    segmentPageIndex,
    findingPageIndex,
    findingPageIndexes,
    physicalPage,
    fold,
    tokens,
    jaccard,
    numbersIn,
    changedNumbers,
    numberAppears,
    clip,
    splitRationale,
  });
});
