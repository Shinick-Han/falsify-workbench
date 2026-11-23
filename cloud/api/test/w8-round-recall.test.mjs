import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTeamRecord, validateRoundGradesPayload, W8_ROUND_GRADES_SCHEMA } from '../src/w8-paper-sync.mjs';

const revisionSha256 = 'a'.repeat(64);
const other = 'b'.repeat(64);
const defects = [{ defectId: 'D1' }, { defectId: 'D2' }, { defectId: 'D3', findingType: 'numerical_mismatch' }];
const published = {
  schema: W8_ROUND_GRADES_SCHEMA,
  revisionSha256,
  roundId: 'W8',
  published: true,
  defects,
};
const initialRun = { id: 'run-1', revisionSha256, condition: 'A', findings: [{ id: 'F1', findingType: 'numerical_mismatch' }] };
const gradesFor = (run, verdicts) => verdicts.map((status, i) => ({
  runId: run.id,
  revisionSha256: run.revisionSha256,
  condition: run.condition,
  defectId: defects[i].defectId,
  status,
  ...(status === 'missed' ? { note: 'BLUE found only a separate claim.' } : {}),
}));

test('only finalized published grades for a known revision and condition count toward recall', () => {
  const otherCondition = { ...initialRun, id: 'run-2', condition: 'B' };
  const wrongRevision = { ...initialRun, id: 'wrong-revision', revisionSha256: other };
  const unknown = { ...initialRun, id: 'unknown' };
  const incomplete = { ...initialRun, id: 'incomplete' };
  const excluded = { ...initialRun, id: 'condition-mismatch' };
  const a = gradesFor(initialRun, ['detected', 'partial', 'missed']);
  const roundGrades = validateRoundGradesPayload({
    ...published,
    grades: [...a, ...a, ...gradesFor(otherCondition, ['detected', 'detected', 'missed']),
      ...gradesFor(wrongRevision, ['detected', 'detected', 'detected']),
      ...gradesFor(unknown, ['detected', 'detected', 'detected']),
      ...gradesFor(incomplete, ['detected', 'pending', 'missed']),
      ...gradesFor({ ...excluded, condition: 'C' }, ['detected', 'detected', 'missed'])],
  });
  const result = analyzeTeamRecord({
    runs: [initialRun, initialRun, otherCondition, wrongRevision, incomplete, excluded],
    roundGrades,
  });
  assert.equal(result.stats.runCount, 5);
  assert.deepEqual(result.stats.byFindingType, [{ type: 'numerical_mismatch', count: 5 }]);
  assert.equal(result.round.scoredRunCount, 2);
  assert.deepEqual(result.round.byCondition.map(row => [row.condition, row.recallPercent]), [['A', 50], ['B', 66.7]]);
  assert.equal(result.round.repeatedMisses.length, 1);
  assert.equal(result.round.repeatedMisses[0].defectId, 'D3');
  assert.equal(result.round.repeatedMisses[0].missedRunCount, 2);
  assert.deepEqual(result.round.repeatedMisses[0].runIds, ['run-1', 'run-2']);
  assert.equal(result.round.repeatedMisses[0].evidence[0].rationale, 'BLUE found only a separate claim.');
  assert.equal(analyzeTeamRecord({ roundGrades }).round.scoredRunCount, 0);
  assert.equal(analyzeTeamRecord({ runs: [initialRun] }).round, null);
  assert.equal(validateRoundGradesPayload({ ...published, grades: a, published: false }), null);
  assert.throws(() => validateRoundGradesPayload({ ...published, grades: a, redKey: '' , answerKey: 'private' }),
    err => err.code === 'forbidden_content');
});
