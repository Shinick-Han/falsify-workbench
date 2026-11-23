import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { matchEditDetailed, scoreSubmission } from '../lib/score.mjs';
import { numberAppears } from '../lib/text.mjs';

const MATCHER_URL = new URL('../../../app/dist/w8-matcher.js', import.meta.url);
const BUILD_URL = new URL('../../../scripts/build-workbench-page.mjs', import.meta.url);
const MATCHER_SOURCE = fs.readFileSync(MATCHER_URL, 'utf8');

function loadBrowserMatcher() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(MATCHER_SOURCE, sandbox, { filename: 'w8-matcher.js' });
  const raw = sandbox.window.FalsifyW8Matcher;
  return {
    raw,
    match: (edit, findings) => JSON.parse(JSON.stringify(raw.match(edit, findings))),
  };
}

function toBoothEdit(edit) {
  return { pageIndex: edit.pageIndex, before: edit.originalText, after: edit.newText, defectType: '' };
}

function mapBoothVerdict(verdict) {
  if (verdict === 'caught') return 'detected';
  if (verdict === 'partial') return 'partial';
  return 'missed';
}

test('w8-matcher.js is browser-safe, Safari regex compatible, and wired before w8-blue/w8-grading', () => {
  assert.doesNotMatch(MATCHER_SOURCE, /\(\?<[=!]/, 'must not use RegExp lookbehind for Safari compatibility');
  assert.doesNotMatch(MATCHER_SOURCE, /\bfrom\s+['"]node:/, 'must not import Node built-ins');
  const matcher = loadBrowserMatcher();
  assert.equal(typeof matcher?.match, 'function');

  const buildSource = fs.readFileSync(BUILD_URL, 'utf8');
  const matcherPos = buildSource.indexOf("'w8-matcher'");
  const bluePos = buildSource.indexOf("'w8-blue'");
  const gradingPos = buildSource.indexOf("'w8-grading'");
  assert.ok(matcherPos >= 0, 'build-workbench-page.mjs must include w8-matcher');
  assert.ok(matcherPos < bluePos && matcherPos < gradingPos, 'w8-matcher must load before w8-blue and w8-grading');
});

test('numberAppears preserves exact boundary semantics without lookbehind', () => {
  assert.equal(numberAppears('0.48', '0.48'), true);
  assert.equal(numberAppears('Ragas\n0.48\n0.78\n0.70', '0.48'), true);
  assert.equal(numberAppears('Table 1 (0.48, 0.78)', '0.48'), true);
  assert.equal(numberAppears('10.48 and 0.48', '0.48'), true);
  assert.equal(numberAppears('0.485', '0.48'), false);
  assert.equal(numberAppears('10.48', '0.48'), false);
  assert.equal(numberAppears('.48', '48'), false);
  assert.equal(numberAppears('48.', '48'), false);
  assert.equal(numberAppears('p=0.48.', '0.48'), false);
});

test('RAGAS 0.65 -> 0.48 parity with Node matchEditDetailed and scoreSubmission', () => {
  const matcher = loadBrowserMatcher();
  const cellEdit = { id: 'e-cell', pageIndex: 4, originalText: '0.65', newText: '0.48' };
  const rowEdit = { id: 'e-row', pageIndex: 4, originalText: 'Ragas 0.65 0.78 0.70', newText: 'Ragas 0.48 0.78 0.70' };

  const unrelatedSamePage = {
    id: 'F-unrelated-1',
    pageIndex: 4,
    quote: 'GPT Score 0.72 0.52 0.63',
    rationale: 'Baseline formatting differs slightly from the caption.',
    evidence: [{ quote: 'GPT Score\n0.72\n0.52\n0.63', pageIndex: 4 }],
    status: '',
  };
  const unrelatedOffPage = {
    id: 'F-unrelated-2',
    pageIndex: 2,
    quote: 'Ragas 0.48 0.78 0.70',
    rationale: 'Mentions 0.48 on a different page.',
    evidence: [{ quote: 'Ragas\n0.48\n0.78\n0.70', pageIndex: 2 }],
    status: '',
  };
  const ragasFinding = {
    id: 'F-ragas-1',
    pageIndex: 4,
    quote: 'For faithfulness, the Ragas prediction are in\ngeneral highly accurate.',
    rationale: 'Table 1 gives Ragas a faithfulness accuracy of 0.48, below GPT Score at 0.72. || EN: Contradicts faithfulness claim.',
    evidence: [
      { quote: 'Ragas\n0.48\n0.78\n0.70\nGPT Score\n0.72\n0.52\n0.63', pageIndex: 4, relation: 'Table 1 shows 0.48' },
      { quote: 'The results in Table 1 show that our proposed metrics are much closer aligned.', pageIndex: 4 },
    ],
    status: '',
  };
  const findings = [unrelatedSamePage, unrelatedOffPage, ragasFinding];

  for (const edit of [cellEdit, rowEdit]) {
    const boothEdit = toBoothEdit(edit);
    const nodeDetailed = matchEditDetailed(boothEdit, findings);
    const nodeScored = scoreSubmission({ receipt: 'RAGAS', declared: [boothEdit] }, findings);
    const browserRes = matcher.match(edit, findings);

    assert.equal(nodeDetailed.match.verdict, 'caught');
    assert.equal(nodeDetailed.finding.id, 'F-ragas-1');
    assert.equal(browserRes.verdict, mapBoothVerdict(nodeDetailed.match.verdict));
    assert.deepEqual(browserRes.links, ['F-ragas-1']);
    assert.equal(browserRes.quote, nodeScored.edits[0].evidence.quote);
    assert.match(browserRes.quote, /Ragas 0\.48 0\.78 0\.70/);
    assert.equal(browserRes.rationale, 'Table 1 gives Ragas a faithfulness accuracy of 0.48, below GPT Score at 0.72.');
  }

  // Rationale-only mention of 0.48 is partial in both Node and browser.
  const rationaleOnly = [
    unrelatedSamePage,
    {
      id: 'F-ragas-partial',
      pageIndex: 4,
      quote: 'For faithfulness, the Ragas prediction are in general highly accurate.',
      rationale: 'Table 1 lists 0.48 rather than a high faithfulness score.',
      evidence: [],
      status: '',
    },
  ];
  for (const edit of [cellEdit, rowEdit]) {
    const boothEdit = toBoothEdit(edit);
    const nodeDetailed = matchEditDetailed(boothEdit, rationaleOnly);
    const browserRes = matcher.match(edit, rationaleOnly);
    assert.equal(nodeDetailed.match.verdict, 'partial');
    assert.equal(browserRes.verdict, 'partial');
    assert.deepEqual(browserRes.links, ['F-ragas-partial']);
    assert.equal(browserRes.rationale, 'Table 1 lists 0.48 rather than a high faithfulness score.');
  }

  // Cross-page finding citing page 5 (pageIndex 4) in evidence catches and returns page-4 quote.
  const crossPage = [{
    id: 'F-ragas-cross',
    pageIndex: 8,
    quote: 'Conclusion claims strong faithfulness.',
    rationale: 'Table 1 on p.5 shows 0.48.',
    evidence: [{ quote: 'Ragas\n0.48\n0.78\n0.70', pageIndex: 4 }],
    status: '',
  }];
  const crossRes = matcher.match(rowEdit, crossPage);
  assert.equal(crossRes.verdict, 'detected');
  assert.deepEqual(crossRes.links, ['F-ragas-cross']);
  assert.equal(crossRes.quote, 'Ragas 0.48 0.78 0.70');

  // Unpaged evidence entry on a same-page finding still surfaces the pertinent table quote.
  const unpagedEvidence = [{
    id: 'F-ragas-unpaged',
    pageIndex: 4,
    quote: 'For faithfulness, the Ragas prediction are in general highly accurate.',
    rationale: 'Table 1 shows 0.48.',
    evidence: [{ quote: 'Ragas\n0.48\n0.78\n0.70', relation: 'Table 1' }],
    status: '',
  }];
  const unpagedRes = matcher.match(rowEdit, unpagedEvidence);
  assert.equal(unpagedRes.verdict, 'detected');
  assert.deepEqual(unpagedRes.links, ['F-ragas-unpaged']);
  assert.equal(unpagedRes.quote, 'Ragas 0.48 0.78 0.70');
});

test('unrelated findings, off-page findings, and rejected/unresolved findings never match', () => {
  const matcher = loadBrowserMatcher();
  const edit = { id: 'e1', pageIndex: 4, originalText: 'Ragas 0.65 0.78 0.70', newText: 'Ragas 0.48 0.78 0.70' };
  const unrelated = [
    { id: 'F-u1', pageIndex: 4, quote: 'WikiEval dataset contains 50 questions.', rationale: 'Small sample size.', evidence: [], status: '' },
    { id: 'F-u2', pageIndex: 4, quote: '0.78 0.70', rationale: 'Unchanged numbers only.', evidence: [], status: '' },
    { id: 'F-u3', pageIndex: 1, quote: 'Ragas 0.48 0.78 0.70', rationale: 'Wrong page.', evidence: [], status: '' },
  ];
  assert.equal(matchEditDetailed(toBoothEdit(edit), unrelated).match.verdict, 'missed');
  assert.deepEqual(matcher.match(edit, unrelated), { verdict: 'missed', links: [], quote: '', rationale: '' });

  // Rejected and unresolved findings are excluded even when their quote matches verbatim.
  const excludedOnly = [
    { id: 'F-rej', pageIndex: 4, quote: 'Ragas 0.48 0.78 0.70', rationale: 'Exact hit but rejected.', evidence: [], status: 'rejected' },
    { id: 'F-unres', pageIndex: 4, quote: 'Ragas 0.48 0.78 0.70', rationale: 'Exact hit but unresolved.', evidence: [], status: 'UNRESOLVED' },
  ];
  assert.deepEqual(matcher.match(edit, excludedOnly), { verdict: 'missed', links: [], quote: '', rationale: '' });

  // When a rejected finding would be detected, a valid partial finding still wins.
  const mixed = [
    ...excludedOnly,
    { id: 'F-valid', pageIndex: 4, quote: 'Table 1 faithfulness summary', rationale: 'Number changed to 0.48 in Table 1.', evidence: [], status: 'confirmed' },
  ];
  const mixedRes = matcher.match(edit, mixed);
  assert.equal(mixedRes.verdict, 'partial');
  assert.deepEqual(mixedRes.links, ['F-valid']);
  assert.equal(mixedRes.quote, 'Table 1 faithfulness summary');
  assert.equal(mixedRes.rationale, 'Number changed to 0.48 in Table 1.');
});

test('handles changed-span edits, long rationales, and empty/defensive inputs', () => {
  const matcher = loadBrowserMatcher();
  const before = 'Our evaluation on WikiEval has shown that the predictions from Ragas are closely aligned with humans.';
  const after = before.replace('predictions from Ragas', 'predictions asdasdasdfrom Ragas');
  const spanEdit = { id: 'e-span', pageIndex: 4, originalText: before, newText: after };

  const longReason = '근거 '.repeat(120);
  const hitFinding = {
    id: 'F-span',
    pageIndex: 4,
    quote: 'predictions asdasdasdfrom Ragas',
    rationale: `${longReason} || EN: Garbled insertion.`,
    evidence: [],
    status: '',
  };
  const unchangedFinding = {
    id: 'F-unchanged',
    pageIndex: 4,
    quote: 'closely aligned with humans',
    rationale: 'Unchanged phrase.',
    evidence: [],
    status: '',
  };

  assert.deepEqual(matcher.match(spanEdit, [unchangedFinding]), { verdict: 'missed', links: [], quote: '', rationale: '' });
  const spanRes = matcher.match(spanEdit, [unchangedFinding, hitFinding]);
  assert.equal(spanRes.verdict, 'detected');
  assert.deepEqual(spanRes.links, ['F-span']);
  assert.equal(spanRes.quote, 'predictions asdasdasdfrom Ragas');
  assert.ok(spanRes.rationale.length <= 300 && spanRes.rationale.endsWith('…'));

  assert.deepEqual(matcher.match(null, [hitFinding]), { verdict: 'missed', links: [], quote: '', rationale: '' });
  assert.deepEqual(matcher.match(spanEdit, null), { verdict: 'missed', links: [], quote: '', rationale: '' });
  assert.deepEqual(matcher.match(spanEdit, []), { verdict: 'missed', links: [], quote: '', rationale: '' });
});
