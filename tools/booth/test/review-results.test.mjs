import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_NOTES } from '../lib/config.mjs';
import { readMarker, reviewResultFailure, reviewResultIssue, verdictFor } from '../lib/live.mjs';
import { startFake } from './fake-api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const BOOTH = path.join(ROOT, 'tools', 'booth', 'booth.mjs');
const TOKEN = `fso_${'r'.repeat(43)}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');
const HOSTED = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'hosted-blue-ragas.job.json'), 'utf8')).result;

function runBooth(args) {
  const child = spawn(process.execPath, [BOOTH, ...args], {
    cwd: ROOT,
    env: { ...process.env, FALSIFY_BOOTH_TOKEN: TOKEN },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => {
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function jsonLines(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map(text => JSON.parse(text));
}

function makeRow(seq, extra = {}) {
  const receipt = `F-${String(seq).padStart(4, '0')}`;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    receipt,
    status: 'received',
    course: 'quick',
    nickname: 'tester',
    declared: [{
      pageIndex: 1,
      segmentId: 'p2-b4',
      defectType: 'number',
      reason: 'changed count',
      before: 'we used 12 annotators',
      after: 'we used 30 annotators',
    }],
    paper: { source: 'arxiv', id: '2302.02452', title: 'Long Paper', license: 'cc-by-4.0' },
    pdfSha256: PDF_SHA,
    pdfBytes: PDF.length,
    sourceSha256: null,
    outcome: null,
    operatorNote: null,
    publicNote: null,
    prizeMessage: null,
    aiSummary: null,
    published: false,
    publishedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: '2026-11-22T00:00:00.000Z',
    ...extra,
  };
}

function makeRecord(result, { state = 'completed', id = 'job-1', model = 'claude-sonnet-5-5' } = {}) {
  return {
    profile: 'live',
    repeat: 0,
    job: { id, state, model, result },
  };
}

function writeConfig(dir, apiBase) {
  fs.writeFileSync(path.join(dir, 'prompt.txt'), '첨부한 PDF만 읽으세요.\n');
  const profile = { effort: 'high', maxCalls: 8, useEvidence: true, promptFile: 'prompt.txt' };
  const config = {
    apiBase,
    dataDir: path.join(dir, 'data'),
    blue: {
      concurrency: 2,
      pollIntervalMs: 20,
      pollTimeoutMs: 20000,
      profiles: [
        { name: 'live', model: 'claude-sonnet-5-5', ...profile },
        { name: 'final', model: 'claude-opus-5-5', ...profile },
      ],
    },
    live: {
      concurrency: 2,
      intervalSec: 1,
      retries: 1,
      retryBackoffMs: 20,
      prizeMessage: 'PRIZE_LIVE',
      finalPrizeMessage: 'PRIZE_FINAL',
      finalCaughtMessage: 'FINAL_CAUGHT',
    },
  };
  const file = path.join(dir, 'booth.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

async function withFake(options, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-review-results-'));
  const fake = await startFake({
    token: TOKEN,
    pdfs: new Map(options.submissions.map(item => [item.receipt, Buffer.from(PDF)])),
    ...options,
  });
  try {
    await fn(fake, dir);
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('reviewResultIssue and verdictFor preserve clean 0-finding and partial-rejected ok results', () => {
  const row = makeRow(1);
  const cleanZero = makeRecord({
    schema: 'falsify.document-blue.v1',
    status: 'ok',
    findings: [],
    coverage: {
      complete: true,
      batchStatuses: ['ok', 'ok'],
      resultCoverage: { accepted: 0, rejected: 0, unresolved: 0, modelStatus: 'ok', rejectedItems: [], unresolvedItems: [] },
    },
  });
  assert.equal(reviewResultIssue(cleanZero), null);
  assert.equal(reviewResultFailure(cleanZero), null);
  const zeroVerdict = verdictFor(row, cleanZero);
  assert.equal(zeroVerdict.outcome, 'missed');
  assert.equal(zeroVerdict.findings, 0);

  const partialRejected = makeRecord({
    ...HOSTED,
    coverage: {
      complete: true,
      batchStatuses: ['ok'],
      resultCoverage: {
        accepted: 2,
        rejected: 1,
        unresolved: 0,
        modelStatus: 'ok',
        rejectedItems: [{ index: 2, code: 'finding_invalid' }],
        unresolvedItems: [],
      },
    },
  });
  assert.equal(reviewResultIssue(partialRejected), null);
  assert.equal(verdictFor(row, partialRejected).findings, 2);

  // Legacy fixture without coverage stays eligible.
  assert.equal(reviewResultIssue(makeRecord(HOSTED)), null);

  // Completed 4-call review whose reread window was truncated by budget still ran the final pass.
  const truncatedComplete = makeRecord({
    schema: 'falsify.document-blue.v1',
    status: 'ok',
    findings: [],
    coverage: { complete: true, reread: { status: 'incomplete', truncated: true } },
  });
  assert.equal(reviewResultIssue(truncatedComplete), null);
});

test('reviewResultIssue and verdictFor reject abstain, refusal, incomplete, batch-abort, and missing results', () => {
  const row = makeRow(2);
  const cases = [
    [makeRecord({ status: 'abstain', findings: [], coverage: { complete: false } }), 'review_abstain'],
    [makeRecord({ status: 'abstain', findings: [], coverage: { complete: true, resultCoverage: { accepted: 0, rejected: 1, modelStatus: 'ok', rejectedItems: [{ code: 'finding_invalid' }] } } }), 'review_abstain'],
    [makeRecord({ status: 'refusal', findings: [], coverage: { complete: false } }), 'review_refusal'],
    [makeRecord({ status: 'ok', findings: HOSTED.findings, coverage: { complete: false, remainingBatches: [{ textBatch: 2 }] } }), 'review_incomplete'],
    [makeRecord({ status: 'ok', findings: HOSTED.findings, coverage: { complete: true, batchStatuses: ['ok', 'refusal'] } }), 'review_refusal'],
    [makeRecord({ status: 'ok', findings: HOSTED.findings, coverage: { complete: true, resultCoverage: { rejectedItems: [{ textBatch: 2, code: 'model_abstain' }] } } }), 'review_abstain'],
    [makeRecord(null), 'review_missing_result'],
    [makeRecord({}), 'review_missing_result'],
    [makeRecord({ status: 'weird', findings: [] }), 'review_invalid'],
  ];
  for (const [record, expectedCode] of cases) {
    assert.equal(reviewResultIssue(record), expectedCode);
    const failure = reviewResultFailure(record);
    assert.equal(failure.code, expectedCode);
    assert.equal(failure.retryable, false);
    assert.throws(() => verdictFor(row, record), error => error.code === expectedCode);
  }
});

test('watch preserves clean 0-finding prize while blocking incomplete, abstained, and refused results', async () => {
  const rows = [makeRow(1), makeRow(2), makeRow(3), makeRow(4), makeRow(5)];
  let seq = 0;
  const resultsByReceipt = [
    // F-0001: clean 0-finding complete review -> judged missed + prize + missedNone note
    {
      schema: 'falsify.document-blue.v1',
      status: 'ok',
      findings: [],
      coverage: {
        complete: true,
        batchStatuses: ['ok', 'ok'],
        resultCoverage: { accepted: 0, rejected: 0, unresolved: 0, modelStatus: 'ok', rejectedItems: [], unresolvedItems: [] },
      },
    },
    // F-0002: complete review with valid findings + 1 rejected bad quote -> judged normally
    {
      ...HOSTED,
      coverage: {
        complete: true,
        batchStatuses: ['ok'],
        resultCoverage: { accepted: 2, rejected: 1, unresolved: 0, modelStatus: 'ok', rejectedItems: [{ code: 'finding_invalid' }], unresolvedItems: [] },
      },
    },
    // F-0003: incomplete multi-batch (batch 2 unreviewed) -> NOT judged, NO prize
    {
      ...HOSTED,
      coverage: {
        complete: false,
        remainingBatches: [{ textBatch: 2, segmentIds: ['p20-b1'], chars: 40000 }],
      },
    },
    // F-0004: selection abstain -> NOT judged, NO prize
    {
      schema: 'falsify.document-blue.v1',
      status: 'abstain',
      findings: [],
      coverage: { complete: false, reread: { status: 'incomplete', truncated: false } },
    },
    // F-0005: model refusal -> NOT judged, NO prize
    {
      schema: 'falsify.document-blue.v1',
      status: 'refusal',
      findings: [],
      coverage: { complete: false },
    },
  ];

  await withFake({
    submissions: rows,
    result: () => resultsByReceipt[seq++],
  }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const res = await runBooth(['--config', config, 'watch', '--cycles', '1', '--concurrency', '1']);
    assert.equal(res.code, 0, res.stderr);
    const byId = receipt => fake.state.submissions.find(item => item.receipt === receipt);

    const cleanZero = byId('F-0001');
    assert.equal(cleanZero.status, 'judged');
    assert.equal(cleanZero.outcome, 'missed');
    assert.equal(cleanZero.published, true);
    assert.equal(cleanZero.prizeMessage, 'PRIZE_LIVE');
    assert.equal(cleanZero.publicNote, DEFAULT_NOTES.missedNone);

    const partialRejected = byId('F-0002');
    assert.equal(partialRejected.status, 'judged');
    assert.equal(partialRejected.outcome, 'missed');
    assert.equal(partialRejected.published, true);

    for (const [receipt, code] of [['F-0003', 'review_incomplete'], ['F-0004', 'review_abstain'], ['F-0005', 'review_refusal']]) {
      const item = byId(receipt);
      assert.equal(item.status, 'reviewing', receipt);
      assert.equal(item.published, false, receipt);
      assert.equal(item.outcome, null, receipt);
      assert.equal(item.prizeMessage, null, receipt);
      const marker = readMarker(path.join(dir, 'data'), receipt);
      assert.equal(marker.state, 'failed', receipt);
      assert.equal(marker.code, code, receipt);
      assert.equal(marker.retryable, false, receipt);
    }

    const end = jsonLines(res.stdout).at(-1);
    assert.equal(end.done, 2);
    assert.equal(end.failed, 3);
  });
});

test('final --apply refuses incomplete final results and applies clean 0-finding final results', async () => {
  const row1 = makeRow(1, { status: 'judged', outcome: 'missed', published: true, prizeMessage: 'PRIZE_LIVE', aiSummary: { round: 'live', liveOutcome: 'missed' } });
  const row2 = makeRow(2, { status: 'judged', outcome: 'missed', published: true, prizeMessage: 'PRIZE_LIVE', aiSummary: { round: 'live', liveOutcome: 'missed' } });
  let call = 0;
  const finalResults = [
    { schema: 'falsify.document-blue.v1', status: 'refusal', findings: [], coverage: { complete: false } },
    { schema: 'falsify.document-blue.v1', status: 'ok', findings: [], coverage: { complete: true, batchStatuses: ['ok'] } },
  ];

  await withFake({
    submissions: [row1, row2],
    result: () => finalResults[call++],
  }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const res = await runBooth(['--config', config, 'final', '--apply', '--allow-open', '--concurrency', '1']);
    assert.equal(res.code, 0, res.stderr);
    const summary = JSON.parse(res.stdout);
    assert.equal(summary.candidates, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.applied, 1);
    assert.equal(summary.stillMissed, 1);
    const candidates = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'final', 'candidates.json'), 'utf8')).candidates;
    assert.equal(candidates.find(item => item.receipt === 'F-0001').error, 'review_refusal');
    assert.equal(candidates.find(item => item.receipt === 'F-0001').finalVerdict, null);
    assert.equal(candidates.find(item => item.receipt === 'F-0002').finalVerdict, 'missed');
    assert.equal(fake.state.patches.filter(patch => patch.receipt === 'F-0001').length, 0);
    assert.equal(fake.state.patches.filter(patch => patch.receipt === 'F-0002').length, 1);
  });
});
