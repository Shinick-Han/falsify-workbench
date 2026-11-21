import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assembleJobBody, buildBlueRequest, configHash, idempotencyKey } from '../lib/blue.mjs';
import { jobFailure, recordFailure } from '../lib/commands.mjs';
import { COMMON_COLUMNS, KEY_COLUMNS, SCORE_COLUMNS } from '../lib/constants.mjs';
import { drawWinners } from '../lib/draw.mjs';
import { commonRows, renderExport, scoreRows } from '../lib/export.mjs';
import { findingPageIndex, findingPageIndexes, findingsFromJob } from '../lib/findings.mjs';
import { mapVerdict } from '../lib/labels.mjs';
import { matchEdit, suggestOutcome } from '../lib/score.mjs';
import { csvCell } from '../lib/text.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

function withPdf(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-unit-'));
  const pdfPath = path.join(dir, 'edited.pdf');
  fs.writeFileSync(pdfPath, PDF);
  try {
    return fn(pdfPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('BLUE builder keeps only profile settings', () => {
  withPdf(pdfPath => {
    const profile = {
      name: 'quick-blind',
      prompt: 'Review the PDF only.',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      maxCalls: 8,
      useEvidence: false,
      declared: [{ after: 'SENTINEL_AFTER', reason: 'SENTINEL_REASON' }],
      nickname: 'SENTINEL_NICK',
      paper: { title: 'SENTINEL_TITLE' },
      reason: 'SENTINEL_REASON',
      before: 'before',
      after: 'after',
    };
    const settings = buildBlueRequest({ pdfPath, profile });
    const body = assembleJobBody(settings, {
      uploadId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: 'a'.repeat(64),
    });
    assert.deepEqual(Object.keys(body).sort(), [
      'budget', 'effort', 'idempotencyKey', 'model', 'prompt', 'role', 'uploadId', 'useEvidence',
    ]);
    assert.equal(body.role, 'blue');
    assert.equal(body.useEvidence, false);
    assert.equal(body.budget.maxCalls, 8);
    const packed = JSON.stringify(body);
    for (const needle of ['SENTINEL_AFTER', 'SENTINEL_REASON', 'SENTINEL_NICK', 'SENTINEL_TITLE', 'declared']) {
      assert.equal(packed.includes(needle), false, needle);
    }
  });
});

test('harness is copied field by field and unknown keys fail', () => {
  withPdf(pdfPath => {
    const settings = buildBlueRequest({
      pdfPath,
      profile: {
        prompt: 'Review the PDF only.',
        harness: {
          schema: 'falsify.harness.v1',
          role: 'blue',
          instructions: 'operator harness text',
          adapter: { type: 'hosted', model: 'claude-sonnet-5-5', effort: 'high' },
        },
      },
    });
    assert.equal(settings.harness.instructions, 'operator harness text');
    assert.equal(settings.harness.adapter.type, 'hosted');
    assert.throws(() => buildBlueRequest({
      pdfPath,
      profile: { prompt: 'Review the PDF only.', harness: { endpoint: 'http://bad' } },
    }), /unknown keys/);
  });
});

test('PDF bytes stay out of the BLUE JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-unit-'));
  const pdfPath = path.join(dir, 'edited.pdf');
  fs.writeFileSync(pdfPath, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('SENTINEL_PDF_BYTES')]));
  const settings = buildBlueRequest({ pdfPath, profile: { prompt: 'Review the PDF only.' } });
  assert.equal(JSON.stringify(settings).includes('SENTINEL_PDF_BYTES'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('idempotency key repeats and changes with the prompt or the edited PDF', () => {
  const base = { name: 'quick-blind', prompt: 'Review the PDF only.', model: 'm', effort: 'high', maxCalls: 4, useEvidence: true };
  const hash = configHash(base);
  const pdfSha256 = 'ab'.repeat(32);
  const args = { receipt: 'F-0001', profileName: 'quick-blind', repeatIndex: 0, configHash: hash, pdfSha256 };
  const first = idempotencyKey(args);
  const second = idempotencyKey(args);
  const otherPrompt = idempotencyKey({ ...args, configHash: configHash({ ...base, prompt: 'Other.' }) });
  const otherPdf = idempotencyKey({ ...args, pdfSha256: 'cd'.repeat(32) });
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.notEqual(first, otherPrompt);
  assert.notEqual(first, otherPdf);
  assert.throws(() => idempotencyKey({ ...args, pdfSha256: 'abcd' }), /pdf sha256/);
});

test('score matches same-page after text, changed numbers, and misses another page', () => {
  const caught = matchEdit(
    { pageIndex: 1, before: 'p < 0.05', after: 'p < 0.50', defectType: 'number' },
    [{ finding: { pageIndex: 1, quote: 'reported p < 0.50 in the table' }, profile: 'quick-blind', repeat: 0 }],
  );
  assert.equal(caught.verdict, 'caught');
  const partial = matchEdit(
    { pageIndex: 2, before: 'n = 40', after: 'n = 400', defectType: 'number' },
    [{ finding: { page: 3, quote: 'the arm enrolled 400 people' }, profile: 'quick-blind', repeat: 1 }],
  );
  assert.equal(partial.verdict, 'partial');
  const missed = matchEdit(
    { pageIndex: 0, before: 'p < 0.05', after: 'p < 0.50', defectType: 'number' },
    [{ finding: { pageIndex: 4, quote: 'p < 0.50' }, profile: 'quick-blind', repeat: 0 }],
  );
  assert.equal(missed.verdict, 'missed');
  assert.equal(suggestOutcome([]), 'missed');
  assert.equal(suggestOutcome(['caught']), 'caught');
  assert.equal(suggestOutcome(['partial']), 'partial');
  assert.equal(suggestOutcome(['missed']), 'missed');
  assert.equal(suggestOutcome(['']), 'missed');
  assert.equal(suggestOutcome(['caught', 'caught']), 'caught');
  assert.equal(suggestOutcome(['caught', 'partial']), 'partial');
  assert.equal(suggestOutcome(['partial', 'partial']), 'partial');
  assert.equal(suggestOutcome(['caught', 'missed']), 'missed');
  assert.equal(suggestOutcome(['partial', 'missed']), 'missed');
  assert.equal(suggestOutcome(['caught', 'partial', 'missed']), 'missed');
  assert.equal(suggestOutcome(['caught', '']), 'missed');
  assert.equal(suggestOutcome(['missed', 'missed']), 'missed');
});

const HOSTED_RAGAS = JSON.parse(fs.readFileSync(new URL('./fixtures/hosted-blue-ragas.job.json', import.meta.url), 'utf8'));

test('hosted BLUE findings without pageIndex get pages from segmentId and evidence', () => {
  const findings = findingsFromJob(HOSTED_RAGAS);
  assert.equal(findings.length, 2);
  for (const finding of findings) {
    assert.equal(finding.pageIndex, undefined);
    assert.equal(finding.page, undefined);
    assert.equal(findingPageIndex(finding), 4);
  }
  assert.equal(findingPageIndex({ segmentId: 'p12-b3' }), 11);
  assert.equal(findingPageIndex({ segmentId: 'b3' }), null);
  assert.equal(findingPageIndex({ pageIndex: 2, segmentId: 'p9-b1' }), 2);
  assert.deepEqual([...findingPageIndexes({ segmentId: 'p9-b4', evidence: [{ segmentId: 'p5-b16' }, { segmentId: 'p9-b2' }] })].sort(), [4, 8]);
  const wrapped = findings.map(finding => ({ finding, profile: 'balanced', repeat: 0, model: HOSTED_RAGAS.model, job: HOSTED_RAGAS }));
  const row = { receipt: 'R1', paper: { id: 'ragas' } };
  assert.deepEqual(commonRows(row, wrapped).map(item => item['물리 페이지']), ['5', '5']);
  assert.deepEqual(scoreRows(row, wrapped).map(item => item.location), ['p5', 'p5']);
});

test('score catches a hosted BLUE finding whose edited number is only in evidence', () => {
  const findings = findingsFromJob(HOSTED_RAGAS).map(finding => ({ finding, profile: 'balanced', repeat: 0 }));
  const edit = { pageIndex: 4, before: 'Ragas 0.95 0.78 0.70', after: 'Ragas 0.50 0.78 0.70', defectType: 'number' };
  // Neither finding quotes the edited row itself; both cite it in evidence[].
  for (const { finding } of findings) assert.ok(!finding.quote.includes('0.50'));
  const caught = matchEdit(edit, findings);
  assert.equal(caught.verdict, 'caught');
  assert.equal(caught.profile, 'balanced');
  // The changed number in the rationale alone is a partial.
  const rationaleOnly = findings.map(({ finding }) => ({ finding: { ...finding, evidence: [] } }));
  assert.equal(matchEdit(edit, rationaleOnly).verdict, 'partial');
  // A finding on another page that cites the edited page through evidence still counts.
  const elsewhere = [{ finding: { ...findings[0].finding, segmentId: 'p9-b2' } }];
  assert.equal(matchEdit(edit, elsewhere).verdict, 'caught');
  assert.equal(matchEdit({ ...edit, pageIndex: 3 }, findings).verdict, 'missed');
});

test('verdict words follow BLUE on the common sheet and score.py on the score sheet', () => {
  assert.deepEqual(mapVerdict('아님'), { blue: '아님', score: '맞음', known: true });
  assert.deepEqual(mapVerdict('맞음'), { blue: '맞음', score: '아님', known: true });
  assert.deepEqual(mapVerdict('확인필요'), { blue: '확인필요', score: '확인필요', known: true });
  assert.equal(mapVerdict('defect').score, '맞음');
  assert.equal(mapVerdict('clean').blue, '맞음');
  assert.equal(mapVerdict('mystery').score, '확인필요');
  assert.equal(COMMON_COLUMNS.length, 15);
  assert.equal(SCORE_COLUMNS.length, 12);
  assert.equal(KEY_COLUMNS.length, 11);
});

test('CSV cells that start with a formula character are prefixed in every CSV format', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell('@sum'), "'@sum");
  assert.equal(csvCell('\tcmd'), "'\tcmd");
  assert.equal(csvCell('\r'), '"\'\r"');
  assert.equal(csvCell('=a,b'), '"\'=a,b"');
  assert.equal(csvCell('safe'), 'safe');
  assert.equal(csvCell(' =1'), ' =1');
  assert.equal(csvCell(''), '');
  const common = renderExport('common', {
    common: [{ '정확한 원문 인용': '=HYPERLINK("http://evil")' }],
    score: [],
    key: [],
    jsonl: [],
  });
  assert.equal(common.includes(`"'=HYPERLINK(""http://evil"")"`), true);
  const score = renderExport('score', {
    common: [],
    score: [{ evidence: '+danger' }],
    key: [],
    jsonl: [],
  });
  assert.equal(score.includes("'+danger"), true);
  const key = renderExport('key', {
    common: [],
    score: [],
    key: [{ before: '-old', why_hard: '@cmd' }],
    jsonl: [],
  });
  assert.equal(key.includes("'-old"), true);
  assert.equal(key.includes("'@cmd"), true);
  const jsonl = renderExport('jsonl', {
    common: [],
    score: [],
    key: [],
    jsonl: [{ evidence: '=cmd' }],
  });
  assert.equal(jsonl, '{"evidence":"=cmd"}\n');
});

test('common CSV is UTF-8 with BOM and quotes embedded commas', () => {
  const csv = renderExport('common', {
    common: [{
      참가자: 'F-0001',
      조건: 'quick',
      탐지기: 'quick-blind',
      모델: 'm',
      실행번호: '1',
      ID: 'B-1',
      '물리 페이지': '2',
      '위치(절·그림·표)': 'Results',
      유형: 'D1',
      '판정(아님/확인필요)': '아님',
      심각도: '불일치',
      '정확한 원문 인용': 'say "p < 0.50", please',
      '대응 근거·이유·검산': 'threshold',
      확신: '높음',
      '추가로 필요한 정보': '',
    }],
    score: [],
    key: [],
    jsonl: [],
  });
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.includes('참가자,조건,탐지기'), true);
  assert.equal(csv.includes('"say ""p < 0.50"", please"'), true);
});

test('draw uses the injected integer generator without replacement', () => {
  const seen = [];
  const winners = drawWinners(['F-0001', 'F-0002', 'F-0003'], 2, (min, max) => {
    seen.push([min, max]);
    return 0;
  });
  assert.deepEqual(winners, ['F-0001', 'F-0002']);
  assert.deepEqual(seen, [[0, 3], [0, 2]]);
});

test('jobFailure and recordFailure preserve failure code, retryable, message and jobId', () => {
  const corrupt = jobFailure({
    id: '03ffb375-0138-4eb0-817c-6e0660b924c1',
    state: 'failed',
    failure: { code: 'pdf_corrupt', retryable: false, message: 'The PDF could not be read.' },
  });
  assert.deepEqual(corrupt, {
    code: 'pdf_corrupt',
    retryable: false,
    message: 'The PDF could not be read.',
    jobState: 'failed',
    jobId: '03ffb375-0138-4eb0-817c-6e0660b924c1',
  });

  const transient = jobFailure({
    id: '11111111-1111-4111-8111-111111111111',
    state: 'failed',
    failure: { code: 'provider_unavailable', retryable: true, message: 'Temporary outage', requestId: 'req-9' },
  });
  assert.equal(transient.code, 'provider_unavailable');
  assert.equal(transient.retryable, true);
  assert.equal(transient.requestId, 'req-9');

  const missing = jobFailure({ id: '22222222-2222-4222-8222-222222222222', state: 'failed' });
  assert.equal(missing.code, 'booth_job');
  assert.equal(missing.retryable, false);

  const interrupted = jobFailure({ id: '33333333-3333-4333-8333-333333333333', state: 'interrupted' });
  assert.equal(interrupted.code, 'job_interrupted');
  assert.equal(interrupted.retryable, false);

  const timedOut = recordFailure({
    job: { id: '44444444-4444-4444-8444-444444444444', state: 'cancelled' },
    failure: { code: 'poll_timeout', retryable: true, message: 'poll timed out', jobId: '44444444-4444-4444-8444-444444444444', jobState: 'cancelled' },
  });
  assert.equal(timedOut.code, 'poll_timeout');
  assert.equal(timedOut.retryable, true);
});
