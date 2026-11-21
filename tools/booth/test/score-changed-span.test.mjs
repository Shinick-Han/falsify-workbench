import assert from 'node:assert/strict';
import test from 'node:test';

import { matchEdit, scoreSubmission } from '../lib/score.mjs';

const LONG_BEFORE = [
  'We have highlighted the need for automated reference-free evaluation of RAG systems.',
  'In particular, we have argued the need for an evaluation framework that can assess faithfulness,',
  'answer relevance, and context relevance across retrieval pipelines.',
  'To support the development of such a framework, we have introduced WikiEval, a dataset with human judgements.',
  'Finally, we have also described Ragas, our implementation of the three considered quality aspects.',
  'This framework is easy to use and can provide developers of RAG systems with valuable insights.',
  'Our evaluation on WikiEval has shown that the predictions from Ragas are closely aligned with humans.',
].join(' ');

const LONG_AFTER = LONG_BEFORE.replace('predictions from Ragas', 'predictions asdasdasdfrom Ragas');

function wrapped(quote, { segmentId = 'p5-b1', rationale = '삽입 오류 || EN: Garbled insertion.', evidence = [] } = {}) {
  return { finding: { segmentId, quote, rationale, evidence }, profile: 'live', repeat: 0 };
}

test('catches F-0004 style changed-span quote and preserves per-edit evidence snippet', () => {
  const edit = { pageIndex: 4, before: LONG_BEFORE, after: LONG_AFTER, defectType: 'other' };
  const runs = [
    wrapped('automated reference-free evaluation of RAG systems', { segmentId: 'p5-b2', rationale: 'unrelated' }),
    wrapped('predictions asdasdasdfrom Ragas', { segmentId: 'p5-b9' }),
  ];
  const scored = scoreSubmission({ receipt: 'F-0004-SYN', declared: [edit] }, runs);
  assert.equal(scored.suggestedOutcome, 'caught');
  assert.equal(scored.edits[0].verdict, 'caught');
  assert.equal(scored.edits[0].quote, 'predictions asdasdasdfrom Ragas');
  assert.equal(scored.edits[0].evidence.quote, 'predictions asdasdasdfrom Ragas');
  assert.equal(scored.edits[0].evidence.rationale, '삽입 오류');
  assert.equal(scored.edits[0].evidence.rationaleEn, 'Garbled insertion.');
});

test('never matches unchanged portions of the edited paragraph or off-page changed quotes', () => {
  const edit = { pageIndex: 4, before: LONG_BEFORE, after: LONG_AFTER, defectType: 'other' };
  const unrelated = [
    wrapped('automated reference-free evaluation of RAG systems'),
    wrapped('our implementation of the three considered quality aspects'),
    wrapped('closely aligned with humans'),
    wrapped('0.40'),
    // Changed quote cited on page 4, with only an unrelated evidence item on page 5.
    wrapped('predictions asdasdasdfrom Ragas', {
      segmentId: 'p4-b1',
      evidence: [{ segmentId: 'p5-b2', quote: 'closely aligned with humans' }],
    }),
  ];
  const scored = scoreSubmission({ receipt: 'F-NEG', declared: [edit] }, unrelated);
  assert.equal(scored.suggestedOutcome, 'missed');
  assert.equal(scored.edits[0].evidence, undefined);
});

test('matches replacement inside or extending past after, while ignoring unchanged prefix/suffix', () => {
  const before = 'A. B. C. D. E. F. The model reports an accuracy of 81% on the held-out set across five benchmarks. G. H. I. J.';
  const after = 'A. B. C. D. E. F. The model reports an accuracy of 81% on the training set across five benchmarks. G. H. I. J.';
  const edit = { pageIndex: 2, before, after, defectType: 'method' };

  assert.equal(matchEdit(edit, [wrapped('accuracy of 81% on the training set', { segmentId: 'p3-b2' })]).verdict, 'caught');
  assert.equal(matchEdit(edit, [wrapped('on the training set across five benchmarks. G. H. I. J. Extra.', { segmentId: 'p3-b2' })]).verdict, 'caught');
  assert.equal(matchEdit(edit, [wrapped('The model reports an accuracy of 81%', { segmentId: 'p3-b2' })]).verdict, 'missed');
});

test('guards short tokens, short numbers, repeated before text, and deletions', () => {
  // Short common token: unrelated or too-short quote stays missed; anchored quote is caught.
  const tokenEdit = {
    pageIndex: 1,
    before: 'In our main experiment, we apply a novel calibration method to every baseline.',
    after: 'In our main experiment, we apply the novel calibration method to every baseline.',
  };
  assert.equal(matchEdit(tokenEdit, [wrapped('the results vary across seeds', { segmentId: 'p2-b1' })]).verdict, 'missed');
  assert.equal(matchEdit(tokenEdit, [wrapped('the novel', { segmentId: 'p2-b1' })]).verdict, 'missed');
  assert.equal(matchEdit(tokenEdit, [wrapped('we apply the novel calibration method', { segmentId: 'p2-b1' })]).verdict, 'caught');

  // F-0006 style single-digit after without context stays partial, not caught.
  assert.equal(matchEdit({ pageIndex: 4, before: '0.70', after: '1' }, [wrapped('Ragas\n0.95\n0.78\n1')]).verdict, 'partial');

  // Bare deletion / bare sign flip without context stay missed.
  assert.equal(matchEdit({ pageIndex: 2, before: 'not ', after: '' }, [wrapped('The effect is significant.', { segmentId: 'p3-b1' })]).verdict, 'missed');
  assert.equal(matchEdit({ pageIndex: 2, before: '<', after: '>' }, [wrapped('all models with p > 0.05 were kept', { segmentId: 'p3-b1' })]).verdict, 'missed');

  // Contextual deletion: straddling quote catches, adjacent unchanged pieces miss.
  const delEdit = {
    pageIndex: 2,
    before: 'Across all ablations, the measured effect is not significant under the paired test.',
    after: 'Across all ablations, the measured effect is significant under the paired test.',
  };
  assert.equal(matchEdit(delEdit, [wrapped('the measured effect is significant under the paired test', { segmentId: 'p3-b1' })]).verdict, 'caught');
  assert.equal(matchEdit(delEdit, [wrapped('the measured effect is', { segmentId: 'p3-b1' })]).verdict, 'missed');
  assert.equal(matchEdit(delEdit, [wrapped('significant under the paired test', { segmentId: 'p3-b1' })]).verdict, 'missed');

  // Ambiguous phrase already present verbatim in before cannot catch.
  const dupEdit = {
    pageIndex: 0,
    before: 'Model Alpha achieves 80% accuracy on Set X. Model Beta achieves 90% accuracy on Set X.',
    after: 'Model Alpha achieves 90% accuracy on Set X. Model Beta achieves 90% accuracy on Set X.',
  };
  assert.notEqual(matchEdit(dupEdit, [wrapped('achieves 90% accuracy on Set X', { segmentId: 'p1-b1' })]).verdict, 'caught');
  assert.equal(matchEdit(dupEdit, [wrapped('Model Alpha achieves 90% accuracy on Set X', { segmentId: 'p1-b1' })]).verdict, 'caught');
});
