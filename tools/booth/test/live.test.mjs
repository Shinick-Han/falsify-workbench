import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { configHash, idempotencyKey } from '../lib/blue.mjs';
import { DEFAULT_NOTES, loadConfigFile } from '../lib/config.mjs';
import { buildPublicNote } from '../lib/note.mjs';
import { startFake } from './fake-api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const BOOTH = path.join(ROOT, 'tools', 'booth', 'booth.mjs');
const TOKEN = `fso_${'b'.repeat(43)}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');
const SENTINELS = ['SENTINEL_REASON_zz92', 'SENTINEL_NICK_zz92', 'SENTINEL_TITLE_zz92'];
// Real hosted shape: segmentId "p5-b11", evidence[], no pageIndex.
const HOSTED = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'hosted-blue-ragas.job.json'), 'utf8')).result;
const OPUS_EXTRA = {
  id: 'f9',
  occurrence: 0,
  segmentId: 'p2-b4',
  quote: 'we used 30 annotators',
  evidence: [{ quote: 'we used 30 annotators', relation: '앞 절과 수가 다릅니다.', segmentId: 'p2-b4' }],
  rationale: '주석자 수가 앞 절의 12명과 다릅니다.',
};

function spawnBooth(args) {
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
  const done = new Promise(resolve => {
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

function run(args) {
  return spawnBooth(args).done;
}

async function waitFor(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(resolve => { setTimeout(resolve, 10); });
  }
}

function jsonLines(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map(text => JSON.parse(text));
}

function row(seq, declared, extra = {}) {
  const receipt = `F-${String(seq).padStart(4, '0')}`;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    receipt,
    status: 'received',
    course: 'quick',
    nickname: 'SENTINEL_NICK_zz92',
    declared: [{ defectType: 'logic', reason: 'SENTINEL_REASON_zz92', ...declared }],
    paper: { source: 'arxiv', id: '2309.15217', title: 'SENTINEL_TITLE_zz92', license: 'cc-by-4.0' },
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

// Page 5 sentence the hosted finding quotes verbatim: caught.
const caughtRow = (seq, extra = {}) => row(seq, {
  pageIndex: 4,
  segmentId: 'p5-b11',
  before: 'For faithfulness, the Ragas prediction are in general weakly accurate.',
  after: 'For faithfulness, the Ragas prediction are in general highly accurate.',
}, extra);
// Page 2 edit no live finding touches: missed. The Opus fake finds it.
const missedRow = seq => row(seq, { pageIndex: 1, segmentId: 'p2-b4', before: 'we used 12 annotators', after: 'we used 30 annotators' });
// Page 3 edit nobody finds.
const hiddenRow = seq => row(seq, { pageIndex: 2, segmentId: 'p3-b1', before: 'the dataset has 50 rows', after: 'the dataset has 999 rows' });

function writeConfig(dir, apiBase, { blue = {}, live = {} } = {}) {
  fs.writeFileSync(path.join(dir, 'prompt.txt'), '첨부한 PDF만 읽으세요.\n');
  const profile = { effort: 'high', maxCalls: 4, useEvidence: true, promptFile: 'prompt.txt' };
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
      ...blue,
    },
    live: { concurrency: 4, intervalSec: 1, retries: 2, retryBackoffMs: 20, prizeMessage: 'PRIZE_LIVE', finalPrizeMessage: 'PRIZE_FINAL', finalCaughtMessage: 'FINAL_CAUGHT', ...live },
  };
  const file = path.join(dir, 'booth.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

function leaked(state) {
  for (const request of state.requests) {
    const blob = `${request.url}\n${JSON.stringify(request.headers)}\n${request.body.toString('utf8')}`;
    const hit = SENTINELS.find(needle => blob.includes(needle));
    if (hit) return hit;
  }
  return '';
}

function find(fake, receipt) {
  return fake.state.submissions.find(item => item.receipt === receipt);
}

async function withFake(options, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-live-'));
  const fake = await startFake({ token: TOKEN, pdfs: new Map(options.submissions.map(item => [item.receipt, Buffer.from(PDF)])), ...options });
  try {
    await fn(fake, dir);
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('public note shows the English reason on its own line and drops the line without one', () => {
  const both = { segmentId: 'p5-b1', quote: 'highly accurate', rationale: '표 1의 0.50과 맞지 않습니다. || EN: It contradicts 0.50 in Table 1.' };
  const note = buildPublicNote({ outcome: 'caught', matched: both, first: both, templates: DEFAULT_NOTES });
  assert.match(note, /\nAI 설명: 표 1의 0\.50과 맞지 않습니다\.\nAI note: It contradicts 0\.50 in Table 1\.$/);
  const koOnly = { ...both, rationale: '표 1의 0.50과 맞지 않습니다.' };
  const plain = buildPublicNote({ outcome: 'partial', matched: koOnly, first: koOnly, templates: DEFAULT_NOTES });
  assert.equal(plain.includes('AI note'), false);
  assert.match(plain, /AI 설명: 표 1의 0\.50과 맞지 않습니다\.$/);
  const enOnly = { ...both, rationale: 'It contradicts Table 1.' };
  assert.match(buildPublicNote({ outcome: 'caught', matched: enOnly, first: enOnly, templates: DEFAULT_NOTES }), /AI 설명: It contradicts Table 1\.$/);
  const long = { ...both, quote: 'q '.repeat(300), rationale: '가 '.repeat(400) + '|| EN: ' + 'a '.repeat(400) };
  const big = buildPublicNote({ outcome: 'caught', matched: long, first: long, templates: DEFAULT_NOTES });
  assert.equal(big.length <= 1000, true);
  assert.equal(big.includes('\nAI note: a a'), true);
});

test('--help lists watch, recover and final', async () => {
  const result = await run(['--help']);
  for (const name of ['watch', 'recover', 'final', '--apply', '--cycles', '--all-failed']) {
    assert.equal(result.stdout.includes(name), true, name);
  }
});

test('public note uses only the AI finding, page, quote and rationale', () => {
  const long = { segmentId: 'p7-b2', quote: 'x '.repeat(400), rationale: '이유 '.repeat(400) };
  const note = buildPublicNote({ outcome: 'caught', matched: long, first: long, templates: DEFAULT_NOTES });
  assert.equal(note.length <= 1000, true);
  assert.equal(note.includes('AI가 짚은 곳: 7쪽'), true);
  const partial = buildPublicNote({ outcome: 'partial', matched: long, first: long, templates: DEFAULT_NOTES });
  assert.match(partial, /근처를 AI가 짚었어요\. \(AI가 짚은 곳: 7쪽\)/);
  const quote = /"([^"]*)"/.exec(note)[1];
  assert.equal(quote.length <= 200, true);
  const missed = buildPublicNote({ outcome: 'missed', matched: null, first: HOSTED.findings[0], templates: DEFAULT_NOTES });
  assert.equal(missed, 'AI는 다른 곳을 짚었어요. 심어 둔 결함은 AI 눈을 피했어요.');
  const none = buildPublicNote({ outcome: 'missed', matched: null, first: null, templates: DEFAULT_NOTES });
  assert.equal(none, DEFAULT_NOTES.missedNone);
  const escaped = buildPublicNote({
    outcome: 'missed',
    matched: { segmentId: 'p5-b1', quote: 'highly accurate', rationale: '표 1과 다릅니다. || EN: Contradicts Table 1.' },
    first: HOSTED.findings[0],
    templates: DEFAULT_NOTES,
  });
  assert.match(escaped, /^심어 둔 결함 중 일부는 AI가 찾았어요\. \(AI가 짚은 곳: 5쪽\)\nAI가 짚은 문장: "highly accurate"\nAI 설명: 표 1과 다릅니다\.\nAI note: Contradicts Table 1\.$/);
  // Operator config lacking `escaped` falls back to DEFAULT_NOTES.escaped both via loadConfigFile and buildPublicNote.
  const legacyTemplates = {
    caught: DEFAULT_NOTES.caught,
    partial: DEFAULT_NOTES.partial,
    missed: DEFAULT_NOTES.missed,
    missedNone: DEFAULT_NOTES.missedNone,
  };
  const fallbackEscaped = buildPublicNote({
    outcome: 'missed',
    matched: { segmentId: 'p5-b1', quote: 'highly accurate', rationale: '표 1과 다릅니다.' },
    first: HOSTED.findings[0],
    templates: legacyTemplates,
  });
  assert.match(fallbackEscaped, /^심어 둔 결함 중 일부는 AI가 찾았어요\. \(AI가 짚은 곳: 5쪽\)/);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cfg-'));
  try {
    const cfgPath = path.join(tmpDir, 'legacy.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      apiBase: 'https://example.invalid',
      live: { publicNote: legacyTemplates },
    }));
    const loaded = loadConfigFile(cfgPath);
    assert.equal(loaded.live.publicNote.escaped, DEFAULT_NOTES.escaped);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('watch and final: any missed edit wins for the visitor and uses the escaped note when another edit was found', async () => {
  const mixed = row(10, {}, {
    declared: [
      {
        pageIndex: 4,
        segmentId: 'p5-b11',
        defectType: 'logic',
        reason: 'SENTINEL_REASON_zz92',
        before: 'For faithfulness, the Ragas prediction are in general weakly accurate.',
        after: 'For faithfulness, the Ragas prediction are in general highly accurate.',
      },
      {
        pageIndex: 1,
        segmentId: 'p2-b4',
        defectType: 'number',
        reason: 'SENTINEL_REASON_zz92',
        before: 'we used 12 annotators',
        after: 'we used 30 annotators',
      },
    ],
  });
  const result = body => (body.model === 'claude-opus-5-5' ? { ...HOSTED, findings: [...HOSTED.findings, OPUS_EXTRA] } : HOSTED);
  await withFake({ submissions: [mixed], result }, async (fake, dir) => {
    // Also verify a local config whose publicNote lacks `escaped` still produces the escaped note in live watch.
    const config = writeConfig(dir, fake.url, {
      live: {
        publicNote: {
          caught: DEFAULT_NOTES.caught,
          partial: DEFAULT_NOTES.partial,
          missed: DEFAULT_NOTES.missed,
          missedNone: DEFAULT_NOTES.missedNone,
        },
      },
    });
    const live = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(live.code, 0, live.stderr);
    const item = find(fake, 'F-0010');
    assert.equal(item.outcome, 'missed', 'one missed edit means visitor wins');
    assert.equal(item.prizeMessage, 'PRIZE_LIVE');
    assert.match(item.publicNote, /^심어 둔 결함 중 일부는 AI가 찾았어요\. \(AI가 짚은 곳: 5쪽\)/);
    assert.ok(item.aiSummary.edits[0].evidence.quote);
    assert.ok(item.aiSummary.edits[0].evidence.rationale);
    assert.equal(item.aiSummary.edits[1].evidence, undefined);
    assert.deepEqual(item.aiSummary.edits.map(({ evidence, ...edit }) => edit), [
      { index: 0, pageIndex: 4, verdict: 'caught' },
      { index: 1, pageIndex: 1, verdict: 'missed' },
    ]);
    // Final round catches the second edit too -> now every edit is caught, outcome becomes caught with finalCaughtMessage.
    const finalRes = await run(['--config', config, 'final', '--apply', '--allow-open']);
    assert.equal(finalRes.code, 0, finalRes.stderr);
    const afterFinal = find(fake, 'F-0010');
    assert.equal(afterFinal.outcome, 'caught');
    assert.equal(afterFinal.prizeMessage, 'FINAL_CAUGHT');
    assert.equal(afterFinal.aiSummary.edits[1].evidence.quote, OPUS_EXTRA.quote);
    assert.deepEqual(afterFinal.aiSummary.edits.map(({ evidence, ...edit }) => edit), [
      { index: 0, pageIndex: 4, verdict: 'caught' },
      { index: 1, pageIndex: 1, verdict: 'caught' },
    ]);
  });
});

test('watch: a full operator job cap (429) waits for a slot instead of failing the row', async () => {
  await withFake({ submissions: [caughtRow(1), missedRow(2), hiddenRow(3)], result: HOSTED, queued: true, activeCap: 1 }, async (fake, dir) => {
    // Local concurrency 4 against a server cap of 1, like the old watch default 12 against BOOTH_OPERATOR_ACTIVE_JOBS=2.
    const config = writeConfig(dir, fake.url, { live: { retries: 0 } });
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.state.busy429 > 0, true, 'the cap was hit');
    assert.equal(fake.state.maxActive, 1);
    for (const receipt of ['F-0001', 'F-0002', 'F-0003']) {
      const item = find(fake, receipt);
      assert.equal(item.status, 'judged', receipt);
      assert.equal(item.published, true, receipt);
    }
    assert.equal(fake.state.newJobs, 3, 'one paid job per row, no duplicate after waiting');
    const end = jsonLines(result.stdout).at(-1);
    assert.equal(end.done, 3);
    assert.equal(end.failed, 0);
    assert.match(result.stderr, /waiting for a free job slot/);
  });
});

test('watch: an hourly job cap (Retry-After over 60 s) fails the row at once instead of waiting', async () => {
  await withFake({ submissions: [caughtRow(1)], result: HOSTED, alwaysBusy: '1800' }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, { live: { retries: 0 } });
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.state.busy429, 1, 'no second try against an hourly cap');
    assert.doesNotMatch(result.stderr, /waiting for a free job slot/);
    const end = jsonLines(result.stdout).at(-1);
    assert.equal(end.failed, 1);
  });
});

test('watch: no free job slot within pollTimeoutMs hands the row to the next cycle, not to failed', async () => {
  await withFake({ submissions: [caughtRow(1)], result: HOSTED, alwaysBusy: '60' }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, { blue: { pollTimeoutMs: 2600 }, live: { retries: 2 } });
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(fake.state.busy429 >= 2, 'waited for a slot ' + fake.state.busy429);
    assert.equal(fake.state.newJobs, 0);
    assert.match(result.stderr, /still waiting for a job slot; next cycle retries/);
    assert.doesNotMatch(result.stderr, /attempt \d failed/, 'the retry budget is not spent on a full queue');
    const end = jsonLines(result.stdout).at(-1);
    assert.equal(end.failed, 0);
    const item = find(fake, 'F-0001');
    assert.equal(item.status, 'reviewing');
    assert.ok(!fake.state.patches.some(patch => /live: failed/.test(JSON.stringify(patch))), 'no failed note');
  });
});

test('watch: a job past pollTimeoutMs is cancelled so it stops holding a server slot', async () => {
  await withFake({ submissions: [caughtRow(1)], result: HOSTED, queued: true, stuckJobs: true }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, { blue: { pollTimeoutMs: 300 }, live: { retries: 0 } });
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.state.cancels, 1);
    assert.match(result.stderr, /cancel requested/);
    assert.equal([...fake.state.jobs.values()][0].state, 'cancelled');
    assert.equal(jsonLines(result.stdout).at(-1).failed, 1);
  });
});

test('watch: received -> reviewing -> judged + published; missed gets the prize', async () => {
  await withFake({ submissions: [caughtRow(1), missedRow(2)], result: HOSTED }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    const caught = find(fake, 'F-0001');
    assert.equal(caught.status, 'judged');
    assert.equal(caught.outcome, 'caught');
    assert.equal(caught.published, true);
    assert.equal(caught.prizeMessage, null);
    assert.match(caught.publicNote, /\(AI가 짚은 곳: 5쪽\)/);
    assert.equal(caught.publicNote.includes('For faithfulness, the Ragas prediction are in general highly accurate.'), true);
    assert.equal(caught.publicNote.length <= 1000, true);
    assert.equal(caught.aiSummary.round, 'live');
    assert.equal(caught.aiSummary.liveOutcome, 'caught');
    const patches = fake.state.patches.filter(item => item.receipt === 'F-0001');
    assert.deepEqual(patches[0].body, { status: 'reviewing' });
    assert.equal(patches.length, 2);
    assert.deepEqual(Object.keys(patches[1].body).sort(), ['aiSummary', 'outcome', 'publicNote', 'published', 'status']);
    const missed = find(fake, 'F-0002');
    assert.equal(missed.outcome, 'missed');
    assert.equal(missed.published, true);
    assert.equal(missed.prizeMessage, 'PRIZE_LIVE');
    assert.equal(missed.publicNote, 'AI는 다른 곳을 짚었어요. 심어 둔 결함은 AI 눈을 피했어요.');
    for (const item of [caught, missed]) {
      for (const needle of SENTINELS) assert.equal(item.publicNote.includes(needle), false, needle);
    }
    assert.equal(leaked(fake.state), '');
    const jobs = [...fake.state.jobs.values()];
    assert.equal(jobs.length, 2);
    assert.equal(jobs.every(job => job.model === 'claude-sonnet-5-5' && job.requestBody.effort === 'high'), true);
    const lines = jsonLines(result.stdout);
    assert.equal(lines[0].type, 'cycle');
    const end = lines.at(-1);
    assert.equal(end.type, 'end');
    assert.equal(end.done, 2);
    assert.equal(end.failed, 0);
    assert.equal(typeof end.p50Sec, 'number');
    assert.equal(typeof end.p95Sec, 'number');
    assert.match(result.stderr, /live F-0001 judged outcome=caught published/);
  });
});

test('watch: a row withdrawn mid-run is skipped and forgotten', async () => {
  await withFake({ submissions: [caughtRow(1)], result: HOSTED, queued: true }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, { blue: { pollIntervalMs: 500 } });
    const started = spawnBooth(['--config', config, 'watch', '--cycles', '1']);
    await waitFor(() => fake.state.jobPosts === 1);
    find(fake, 'F-0001').status = 'withdrawn';
    const result = await started.done;
    assert.equal(result.code, 0, result.stderr);
    const item = find(fake, 'F-0001');
    assert.equal(item.status, 'withdrawn');
    assert.equal(item.published, false);
    assert.equal(item.publicNote, null);
    const end = jsonLines(result.stdout).at(-1);
    assert.equal(end.skipped, 1);
    assert.equal(end.done, 0);
    assert.match(result.stderr, /F-0001 skipped withdrawn/);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'submissions', 'F-0001')), false);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'blue', 'F-0001')), false);
    assert.match(fs.readFileSync(path.join(dir, 'data', 'withdrawn.log'), 'utf8'), /\tF-0001\t1\twithdrawn\n$/);
  });
});

test('watch: retryable poll and job failures retry up to retries; cause and retryable are preserved', async () => {
  await withFake({ submissions: [caughtRow(1)], result: HOSTED, queued: true, pollFailures: 1 }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(find(fake, 'F-0001').outcome, 'caught');
    assert.equal(fake.state.newJobs, 1);
    assert.match(result.stderr, /attempt 1 failed unavailable retryable=true/);
  });
  const retryableSpec = { code: 'provider_unavailable', retryable: true, message: 'The hosted provider is temporarily unavailable.' };
  await withFake({ submissions: [caughtRow(1)], failSpec: retryableSpec }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    const item = find(fake, 'F-0001');
    assert.equal(item.status, 'reviewing');
    assert.equal(item.published, false);
    assert.equal(item.operatorNote, 'live: failed provider_unavailable (retryable=true)');
    assert.equal(fake.state.newJobs, 3);
    const lastJob = [...fake.state.jobs.values()].at(-1);
    const end = jsonLines(result.stdout).at(-1);
    assert.equal(end.failed, 1);
    assert.deepEqual(end.failedReceipts, [{
      receipt: 'F-0001',
      code: 'provider_unavailable',
      retryable: true,
      message: 'The hosted provider is temporarily unavailable.',
      jobId: lastJob.id,
    }]);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'live', 'F-0001.json'), 'utf8'));
    assert.equal(marker.state, 'failed');
    assert.equal(marker.code, 'provider_unavailable');
    assert.equal(marker.retryable, true);
    assert.equal(marker.jobId, lastJob.id);
    assert.equal(marker.repeat, 2);
    assert.match(result.stderr, /F-0001 FAILED provider_unavailable retryable=true; left reviewing/);
    // A failed row is not picked up again by the next start.
    const again = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fake.state.newJobs, 3);
  });
});

test('watch: non-retryable job failure (pdf_corrupt) stops after one attempt and preserves cause without blind retries', async () => {
  const corrupt = { code: 'pdf_corrupt', retryable: false, message: 'The PDF could not be read.' };
  await withFake({ submissions: [caughtRow(17)], failSpec: corrupt }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, { live: { retries: 2 } });
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.state.newJobs, 1, 'non-retryable failure must not burn retry slots');
    const [job] = [...fake.state.jobs.values()];
    const item = find(fake, 'F-0017');
    assert.equal(item.status, 'reviewing');
    assert.equal(item.published, false);
    assert.equal(item.operatorNote, 'live: failed pdf_corrupt (retryable=false)');
    const end = jsonLines(result.stdout).at(-1);
    assert.equal(end.failed, 1);
    assert.deepEqual(end.failedReceipts, [{
      receipt: 'F-0017',
      code: 'pdf_corrupt',
      retryable: false,
      message: 'The PDF could not be read.',
      jobId: job.id,
    }]);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'live', 'F-0017.json'), 'utf8'));
    assert.equal(marker.state, 'failed');
    assert.equal(marker.code, 'pdf_corrupt');
    assert.equal(marker.retryable, false);
    assert.equal(marker.message, 'The PDF could not be read.');
    assert.equal(marker.jobId, job.id);
    assert.equal(marker.repeat, 0);

    // Even if a crash left the marker in state=running after repeat 0 failed non-retryably, restart must not create repeat 1.
    fs.writeFileSync(path.join(dir, 'data', 'live', 'F-0017.json'), JSON.stringify({ ...marker, state: 'running' }));
    const restart = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(restart.code, 0, restart.stderr);
    assert.equal(fake.state.newJobs, 1, 'restart must not blindly retry non-retryable saved failure');
    const afterRestart = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'live', 'F-0017.json'), 'utf8'));
    assert.equal(afterRestart.state, 'failed');
    assert.equal(afterRestart.code, 'pdf_corrupt');
    assert.equal(afterRestart.retryable, false);
  });
});

test('watch: failed job without failure metadata defaults to non-retryable and does not blindly retry', async () => {
  await withFake({ submissions: [caughtRow(1)], failJobs: true }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, { live: { retries: 2 } });
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.state.newJobs, 1);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'live', 'F-0001.json'), 'utf8'));
    assert.equal(marker.code, 'booth_job');
    assert.equal(marker.retryable, false);
  });
});

test('watch: resumes a saved unfinished job ticket by exact job id even after prompt change', async () => {
  await withFake({ submissions: [caughtRow(1)], result: HOSTED, queued: true }, async (fake, dir) => {
    const slow = writeConfig(dir, fake.url, { blue: { pollIntervalMs: 5000 } });
    const first = spawnBooth(['--config', slow, 'watch']);
    await waitFor(() => fake.state.jobPosts === 1);
    await waitFor(() => {
      const markerFile = path.join(dir, 'data', 'live', 'F-0001.json');
      if (!fs.existsSync(markerFile)) return false;
      return Boolean(JSON.parse(fs.readFileSync(markerFile, 'utf8')).jobId);
    });
    const [savedJob] = [...fake.state.jobs.values()];
    first.child.kill('SIGINT');
    assert.equal((await first.done).code, 130);

    // Operator edits the prompt before restarting watch. Saved in-flight job ticket must still resume by exact id.
    fs.writeFileSync(path.join(dir, 'prompt.txt'), '첨부한 PDF만 읽고 결함을 찾으세요 (updated).\n');
    const fast = writeConfig(dir, fake.url);
    fs.writeFileSync(path.join(dir, 'prompt.txt'), '첨부한 PDF만 읽고 결함을 찾으세요 (updated).\n');
    const second = await run(['--config', fast, 'watch', '--cycles', '1']);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(fake.state.jobPosts, 1, 'no second POST /v1/ai/jobs');
    assert.equal(fake.state.newJobs, 1);
    assert.equal(fake.state.requests.some(req => req.method === 'GET' && req.url === `/v1/ai/jobs/${savedJob.id}`), true);
    assert.equal(find(fake, 'F-0001').status, 'judged');
    assert.equal(find(fake, 'F-0001').outcome, 'caught');
  });
});

test('recover: exhausted F-0017 dry-run and safe reprocess with new idempotency key after root-cause fix', async () => {
  const row17 = caughtRow(17, { status: 'reviewing', operatorNote: 'live: failed booth_job' });
  await withFake({ submissions: [row17], result: HOSTED }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const data = path.join(dir, 'data');
    const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
    const hash = configHash({ name: 'live', model: 'claude-sonnet-5-5', effort: 'high', maxCalls: 4, useEvidence: true, prompt });

    // Seed exact exhausted F-0017 disk state: marker failed with legacy booth_job + repeats 0, 1, 2 failed pdf_corrupt.
    fs.mkdirSync(path.join(data, 'live'), { recursive: true });
    fs.writeFileSync(path.join(data, 'live', 'F-0017.json'), JSON.stringify({
      receipt: 'F-0017',
      state: 'failed',
      receivedAt: row17.createdAt,
      startedAt: '2026-11-21T10:46:38.306Z',
      updatedAt: '2026-11-21T10:47:01.660Z',
      code: 'booth_job',
    }));
    const oldKeys = [];
    for (const repeat of [0, 1, 2]) {
      const key = idempotencyKey({ receipt: 'F-0017', profileName: 'live', repeatIndex: repeat, configHash: hash, pdfSha256: PDF_SHA });
      oldKeys.push(key);
      const jobId = `00000000-0000-4000-8000-00000000001${repeat}`;
      const recordPath = path.join(data, 'blue', 'F-0017', 'live', String(repeat), `${hash}.json`);
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      fs.writeFileSync(recordPath, JSON.stringify({
        idempotencyKey: key,
        profile: 'live',
        repeat,
        configHash: hash,
        replayed: false,
        job: {
          id: jobId,
          role: 'blue',
          state: 'failed',
          model: 'claude-sonnet-5-5',
          failure: { code: 'pdf_corrupt', retryable: false, message: 'The PDF could not be read.' },
        },
      }));
    }

    // 1. Dry-run inspects F-0017 by exact receipt id, preserves pdf_corrupt cause, and makes zero writes.
    const dry = await run(['--config', config, 'recover', '--only', 'F-0017', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    const dryBody = JSON.parse(dry.stdout);
    assert.equal(dryBody.dryRun, true);
    assert.equal(dryBody.targets, 1);
    const plan = dryBody.results[0];
    assert.equal(plan.receipt, 'F-0017');
    assert.equal(plan.serverStatus, 'reviewing');
    assert.equal(plan.action, 'reprocess');
    assert.equal(plan.existingAttempts, 3);
    assert.equal(plan.lastFailure.code, 'pdf_corrupt');
    assert.equal(plan.lastFailure.retryable, false);
    assert.equal(plan.lastFailure.jobId, '00000000-0000-4000-8000-000000000012');
    assert.equal(plan.nextRepeat, 3);
    assert.equal(oldKeys.includes(plan.nextIdempotencyKey), false);
    assert.equal(fake.state.jobPosts, 0);
    assert.equal(fake.state.patches.length, 0);
    assert.equal(fake.state.submissionGets, 1);

    // 2. Real recovery allocates repeat #3 with the new idempotency key, preserves 0..2, judges and publishes.
    const rec = await run(['--config', config, 'recover', '--only', 'F-0017']);
    assert.equal(rec.code, 0, rec.stderr);
    const recBody = JSON.parse(rec.stdout);
    assert.equal(recBody.done, 1);
    assert.equal(recBody.failed, 0);
    assert.equal(recBody.results[0].action, 'done');
    assert.equal(recBody.results[0].repeat, 3);
    assert.equal(recBody.results[0].outcome, 'caught');
    assert.equal(fake.state.newJobs, 1);
    const [freshJob] = [...fake.state.jobs.values()];
    assert.equal(freshJob.idempotencyKey, plan.nextIdempotencyKey);
    assert.equal(oldKeys.includes(freshJob.idempotencyKey), false);
    for (const repeat of [0, 1, 2, 3]) {
      assert.equal(fs.existsSync(path.join(data, 'blue', 'F-0017', 'live', String(repeat), `${hash}.json`)), true, `repeat ${repeat}`);
    }
    const after = find(fake, 'F-0017');
    assert.equal(after.status, 'judged');
    assert.equal(after.outcome, 'caught');
    assert.equal(after.published, true);
    const marker = JSON.parse(fs.readFileSync(path.join(data, 'live', 'F-0017.json'), 'utf8'));
    assert.equal(marker.state, 'done');
    assert.equal(marker.code, null);
    assert.equal(marker.failure, null);
    assert.equal(marker.repeat, 3);
    assert.equal(marker.jobId, freshJob.id);

    // 3. Running recover again on now-judged F-0017 is safely skipped with zero BLUE calls and zero PATCHes.
    const patchesBefore = fake.state.patches.length;
    const second = await run(['--config', config, 'recover', '--only', 'F-0017']);
    assert.equal(second.code, 0, second.stderr);
    const secondBody = JSON.parse(second.stdout);
    assert.equal(secondBody.skipped, 1);
    assert.equal(secondBody.done, 0);
    assert.equal(secondBody.results[0].reason, 'already_judged');
    assert.equal(fake.state.newJobs, 1);
    assert.equal(fake.state.patches.length, patchesBefore);
  });
});

test('recover: stops after one fresh attempt if non-retryable cause still persists, and resumes unfinished recovery job by id', async () => {
  const row17 = caughtRow(17, { status: 'reviewing' });
  await withFake({
    submissions: [row17],
    failSpec: { code: 'pdf_corrupt', retryable: false, message: 'The PDF could not be read.' },
  }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, { live: { retries: 2 } });
    const res = await run(['--config', config, 'recover', '--only', 'F-0017']);
    assert.equal(res.code, 3, res.stderr);
    assert.equal(fake.state.newJobs, 1, 'recover must not blindly retry non-retryable fresh failure');
    const body = JSON.parse(res.stdout);
    assert.equal(body.failed, 1);
    assert.equal(body.results[0].code, 'pdf_corrupt');
    assert.equal(body.results[0].retryable, false);
  });

  // Interrupted recovery job resumes the exact same job id on rerun without creating a second job.
  await withFake({ submissions: [caughtRow(18, { status: 'reviewing' })], result: HOSTED, queued: true }, async (fake, dir) => {
    const slow = writeConfig(dir, fake.url, { blue: { pollIntervalMs: 5000 } });
    const first = spawnBooth(['--config', slow, 'recover', '--only', 'F-0018']);
    await waitFor(() => fake.state.jobPosts === 1);
    await waitFor(() => {
      const m = path.join(dir, 'data', 'live', 'F-0018.json');
      return fs.existsSync(m) && Boolean(JSON.parse(fs.readFileSync(m, 'utf8')).jobId);
    });
    const [savedJob] = [...fake.state.jobs.values()];
    first.child.kill('SIGINT');
    await first.done;

    const fast = writeConfig(dir, fake.url);
    const second = await run(['--config', fast, 'recover', '--all-failed']);
    assert.equal(second.code, 0, second.stderr);
    const body = JSON.parse(second.stdout);
    assert.equal(body.done, 1);
    assert.equal(body.results[0].jobId, savedJob.id);
    assert.equal(body.results[0].resumed, true);
    assert.equal(fake.state.jobPosts, 1, 'resumed recovery job without new POST');
    assert.equal(fake.state.newJobs, 1);
    assert.equal(find(fake, 'F-0018').status, 'judged');
  });
});

test('recover: skips server-replayed terminal failed repeats when local history is absent and lands on fresh key', async () => {
  const row17 = caughtRow(17, { status: 'reviewing' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-recover-replay-'));
  const config = writeConfig(dir, 'http://127.0.0.1:1');
  const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
  const hash = configHash({ name: 'live', model: 'claude-sonnet-5-5', effort: 'high', maxCalls: 4, useEvidence: true, prompt });
  const seedJobs = [0, 1].map(repeat => ({
    id: `00000000-0000-4000-8000-00000000010${repeat}`,
    role: 'blue',
    state: 'failed',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    useEvidence: true,
    idempotencyKey: idempotencyKey({ receipt: 'F-0017', profileName: 'live', repeatIndex: repeat, configHash: hash, pdfSha256: PDF_SHA }),
    requestBody: {},
    polls: 0,
    result: null,
    failure: { code: 'pdf_corrupt', retryable: false, message: 'The PDF could not be read.' },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    createdAt: '2026-11-21T10:46:39.000Z',
    completedAt: '2026-11-21T10:46:39.000Z',
  }));
  const fake = await startFake({
    token: TOKEN,
    submissions: [row17],
    pdfs: new Map([['F-0017', Buffer.from(PDF)]]),
    result: HOSTED,
    seedJobs,
  });
  try {
    const liveConfig = writeConfig(dir, fake.url);
    const res = await run(['--config', liveConfig, 'recover', '--only', 'F-0017']);
    assert.equal(res.code, 0, res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.done, 1);
    assert.equal(body.results[0].repeat, 2);
    assert.equal(fake.state.newJobs, 1, 'only repeat #2 created a new server job');
    assert.equal(find(fake, 'F-0017').status, 'judged');
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recover and watch: protect already judged and withdrawn rows (including mid-run judge and offline reconcile)', async () => {
  const judgedRow = caughtRow(1, { status: 'judged', outcome: 'missed', published: true, publicNote: 'KEEP_EXISTING_NOTE' });
  const withdrawnRow = caughtRow(2, { status: 'withdrawn' });
  await withFake({ submissions: [judgedRow, withdrawnRow], result: HOSTED }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const data = path.join(dir, 'data');
    // Seed local files for withdrawn F-0002 to verify cleanup.
    fs.mkdirSync(path.join(data, 'submissions', 'F-0002'), { recursive: true });
    fs.writeFileSync(path.join(data, 'submissions', 'F-0002', 'edited.pdf'), PDF);
    fs.mkdirSync(path.join(data, 'live'), { recursive: true });
    fs.writeFileSync(path.join(data, 'live', 'F-0002.json'), JSON.stringify({ receipt: 'F-0002', state: 'failed' }));

    const noTarget = await run(['--config', config, 'recover']);
    assert.equal(noTarget.code, 1);
    assert.match(noTarget.stderr, /--only/);

    const rec = await run(['--config', config, 'recover', '--only', 'F-0001,F-0002']);
    assert.equal(rec.code, 0, rec.stderr);
    const body = JSON.parse(rec.stdout);
    assert.equal(body.skipped, 2);
    assert.equal(body.done, 0);
    assert.equal(body.results.find(item => item.receipt === 'F-0001').reason, 'already_judged');
    assert.equal(body.results.find(item => item.receipt === 'F-0002').reason, 'withdrawn');
    assert.equal(fake.state.newJobs, 0);
    assert.equal(fake.state.patches.length, 0);
    assert.equal(find(fake, 'F-0001').publicNote, 'KEEP_EXISTING_NOTE');
    assert.equal(fs.existsSync(path.join(data, 'submissions', 'F-0002')), false);
    assert.equal(fs.existsSync(path.join(data, 'live', 'F-0002.json')), false);
    assert.match(fs.readFileSync(path.join(data, 'withdrawn.log'), 'utf8'), /\tF-0002\t2\twithdrawn\n$/);
  });

  // Mid-run judge protection: if another operator judges the row while BLUE is running, watch does not overwrite it.
  await withFake({ submissions: [caughtRow(3)], result: HOSTED, queued: true }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, { blue: { pollIntervalMs: 300 } });
    const started = spawnBooth(['--config', config, 'watch', '--cycles', '1']);
    await waitFor(() => fake.state.jobPosts === 1);
    const row = find(fake, 'F-0003');
    row.status = 'judged';
    row.outcome = 'missed';
    row.publicNote = 'MANUAL_VERDICT';
    row.published = true;
    const result = await started.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(find(fake, 'F-0003').outcome, 'missed');
    assert.equal(find(fake, 'F-0003').publicNote, 'MANUAL_VERDICT');
    assert.equal(fake.state.patches.some(p => p.receipt === 'F-0003' && p.body.status === 'judged'), false);
    assert.equal(jsonLines(result.stdout).at(-1).skipped, 1);
  });

  // Stale running marker reconciliation: row withdrawn while watch was offline is cleaned up on next watch cycle.
  await withFake({ submissions: [caughtRow(4, { status: 'withdrawn' })], result: HOSTED }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const data = path.join(dir, 'data');
    fs.mkdirSync(path.join(data, 'submissions', 'F-0004'), { recursive: true });
    fs.writeFileSync(path.join(data, 'submissions', 'F-0004', 'edited.pdf'), PDF);
    fs.mkdirSync(path.join(data, 'live'), { recursive: true });
    fs.writeFileSync(path.join(data, 'live', 'F-0004.json'), JSON.stringify({ receipt: 'F-0004', state: 'running' }));
    const res = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(fs.existsSync(path.join(data, 'submissions', 'F-0004')), false);
    assert.equal(fs.existsSync(path.join(data, 'live', 'F-0004.json')), false);
    assert.match(fs.readFileSync(path.join(data, 'withdrawn.log'), 'utf8'), /\tF-0004\t4\twithdrawn\n$/);
  });
});

test('recover: reuses a saved completed job record without creating a new job, and poll rejects mismatched job id', async () => {
  const row19 = caughtRow(19, { status: 'reviewing' });
  await withFake({ submissions: [row19], result: HOSTED }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const data = path.join(dir, 'data');
    const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
    const hash = configHash({ name: 'live', model: 'claude-sonnet-5-5', effort: 'high', maxCalls: 4, useEvidence: true, prompt });
    const key = idempotencyKey({ receipt: 'F-0019', profileName: 'live', repeatIndex: 3, configHash: hash, pdfSha256: PDF_SHA });
    const recordPath = path.join(data, 'blue', 'F-0019', 'live', '3', `${hash}.json`);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify({
      idempotencyKey: key,
      profile: 'live',
      repeat: 3,
      configHash: hash,
      replayed: false,
      job: {
        id: '00000000-0000-4000-8000-000000000019',
        role: 'blue',
        state: 'completed',
        model: 'claude-sonnet-5-5',
        result: HOSTED,
      },
    }));

    const dry = await run(['--config', config, 'recover', '--only', 'F-0019', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    const dryBody = JSON.parse(dry.stdout);
    assert.equal(dryBody.results[0].action, 'resume_completed');
    assert.equal(dryBody.results[0].jobId, '00000000-0000-4000-8000-000000000019');

    const rec = await run(['--config', config, 'recover', '--only', 'F-0019']);
    assert.equal(rec.code, 0, rec.stderr);
    const recBody = JSON.parse(rec.stdout);
    assert.equal(recBody.done, 1);
    assert.equal(recBody.results[0].resumed, true);
    assert.equal(recBody.results[0].jobId, '00000000-0000-4000-8000-000000000019');
    assert.equal(fake.state.jobPosts, 0, 'must not create a new job when a completed record exists');
    assert.equal(find(fake, 'F-0019').status, 'judged');
    assert.equal(find(fake, 'F-0019').outcome, 'caught');
  });

  // Poll response returning a mismatched job id fails non-retryably without spawning a duplicate job.
  await withFake({
    submissions: [caughtRow(20)],
    result: HOSTED,
    queued: true,
    pollMismatchId: '99999999-9999-4999-8999-999999999999',
  }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, { live: { retries: 2 } });
    const res = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(fake.state.newJobs, 1);
    const end = jsonLines(res.stdout).at(-1);
    assert.equal(end.failed, 1);
    assert.equal(end.failedReceipts[0].code, 'booth_api');
    assert.equal(end.failedReceipts[0].retryable, false);
  });
});

test('final --apply keeps the instant prize valid with the default finalCaughtMessage', async () => {
  const result = body => (body.model === 'claude-opus-5-5' ? { ...HOSTED, findings: [...HOSTED.findings, OPUS_EXTRA] } : HOSTED);
  await withFake({ submissions: [missedRow(2)], result }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const raw = JSON.parse(fs.readFileSync(config, 'utf8'));
    delete raw.live.finalCaughtMessage;
    fs.writeFileSync(config, JSON.stringify(raw));
    assert.equal((await run(['--config', config, 'watch', '--cycles', '1'])).code, 0);
    assert.equal(find(fake, 'F-0002').prizeMessage, 'PRIZE_LIVE');
    const applied = await run(['--config', config, 'final', '--apply', '--allow-open']);
    assert.equal(applied.code, 0, applied.stderr);
    const item = find(fake, 'F-0002');
    assert.equal(item.outcome, 'caught');
    assert.equal(item.prizeMessage, '빠른 AI를 이겼어요. 정밀 AI는 찾아냈지만, 받은 선물은 그대로 가져가세요.');
    assert.match(item.publicNote, /주석자 수가/);
    const last = fake.state.patches.filter(patch => patch.receipt === 'F-0002').at(-1).body;
    assert.equal(last.prizeMessage, '빠른 AI를 이겼어요. 정밀 AI는 찾아냈지만, 받은 선물은 그대로 가져가세요.');
    assert.equal(last.outcome, 'caught');
  });
});

test('watch: a missing PDF is skipped, logged and not retried', async () => {
  await withFake({ submissions: [caughtRow(1)], result: HOSTED, pdfs: new Map() }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /F-0001 skipped missing PDF/);
    assert.equal(find(fake, 'F-0001').operatorNote, 'live: skipped no_pdf');
    assert.equal(fake.state.jobPosts, 0);
    assert.equal(jsonLines(result.stdout).at(-1).skipped, 1);
  });
});

test('watch: Ctrl-C stops; the next start resumes the same job', async () => {
  await withFake({ submissions: [caughtRow(1)], result: HOSTED, queued: true }, async (fake, dir) => {
    const slow = writeConfig(dir, fake.url, { blue: { pollIntervalMs: 5000 } });
    const first = spawnBooth(['--config', slow, 'watch']);
    await waitFor(() => fake.state.jobPosts === 1);
    await waitFor(() => fs.existsSync(path.join(dir, 'data', 'blue', 'F-0001', 'live', '0')));
    first.child.kill('SIGINT');
    const stopped = await first.done;
    assert.equal(stopped.code, 130, stopped.stderr);
    assert.equal(jsonLines(stopped.stdout).at(-1).type, 'stopped');
    assert.equal(find(fake, 'F-0001').status, 'reviewing');
    const fast = writeConfig(dir, fake.url);
    const second = await run(['--config', fast, 'watch', '--cycles', '1']);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(find(fake, 'F-0001').outcome, 'caught');
    assert.equal(find(fake, 'F-0001').published, true);
    assert.equal(fake.state.jobPosts, 1);
    assert.equal(fake.state.newJobs, 1);
    assert.equal(fake.state.requests.filter(item => item.url === '/v1/ai/uploads').length, 1);
    assert.equal(fake.state.patches.filter(item => item.body.status === 'reviewing').length, 1);
  });
});

test('final: Opus round on live misses; dry by default, --apply PATCHes', async () => {
  const result = body => (body.model === 'claude-opus-5-5' ? { ...HOSTED, findings: [...HOSTED.findings, OPUS_EXTRA] } : HOSTED);
  const agentRow = { ...missedRow(2), assist: 'agent', recipeCode: 'R-7K3QXM' };
  await withFake({ submissions: [caughtRow(1), agentRow, hiddenRow(3)], result }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const live = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(live.code, 0, live.stderr);
    assert.deepEqual(['F-0001', 'F-0002', 'F-0003'].map(receipt => find(fake, receipt).outcome), ['caught', 'missed', 'missed']);
    const open = await run(['--config', config, 'final']);
    assert.equal(open.code, 1);
    assert.match(open.stderr, /submissions are open/);
    assert.equal((await run(['--config', config, 'close'])).code, 0);
    const patchCount = fake.state.patches.length;

    const dry = await run(['--config', config, 'final']);
    assert.equal(dry.code, 0, dry.stderr);
    const summary = JSON.parse(dry.stdout);
    assert.equal(summary.candidates, 2);
    assert.equal(summary.stillMissed, 1);
    assert.equal(summary.applied, 0);
    assert.equal(fake.state.patches.length, patchCount);
    assert.equal(find(fake, 'F-0002').outcome, 'missed');
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'final', 'candidates.json'), 'utf8'));
    assert.equal(file.applied, false);
    const two = file.candidates.find(item => item.receipt === 'F-0002');
    assert.deepEqual([two.liveVerdict, two.finalVerdict, two.bestQuote, two.page], ['missed', 'caught', 'we used 30 annotators', 2]);
    const three = file.candidates.find(item => item.receipt === 'F-0003');
    assert.deepEqual([three.liveVerdict, three.finalVerdict], ['missed', 'missed']);
    // Operators see how each candidate was planted. A row without assist (older server) reads as manual.
    assert.deepEqual([two.assist, two.recipeCode], ['agent', 'R-7K3QXM']);
    assert.deepEqual([three.assist, three.recipeCode], ['manual', null]);
    const opus = [...fake.state.jobs.values()].filter(job => job.model === 'claude-opus-5-5');
    assert.equal(opus.length, 2);
    assert.equal(leaked(fake.state), '');

    const applied = await run(['--config', config, 'final', '--apply']);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).applied, 2);
    assert.equal([...fake.state.jobs.values()].filter(job => job.model === 'claude-opus-5-5').length, 2);
    const caught = find(fake, 'F-0002');
    assert.equal(caught.outcome, 'caught');
    assert.equal(caught.prizeMessage, 'FINAL_CAUGHT');
    assert.match(caught.publicNote, /AI가 짚은 곳: 2쪽/);
    assert.match(caught.publicNote, /^내가 심어 둔 결함을 AI가 찾았어요/);
    assert.match(caught.publicNote, /주석자 수가/);
    assert.equal(caught.aiSummary.round, 'final');
    assert.equal(caught.aiSummary.liveOutcome, 'missed');
    const hidden = find(fake, 'F-0003');
    assert.equal(hidden.outcome, 'missed');
    assert.equal(hidden.prizeMessage, 'PRIZE_FINAL');
    assert.equal(hidden.published, true);
    assert.equal(find(fake, 'F-0001').aiSummary.round, 'live');

    const only = await run(['--config', config, 'final', '--only', 'F-0003', '--out', path.join(dir, 'only.json')]);
    assert.equal(only.code, 0, only.stderr);
    assert.equal(JSON.parse(only.stdout).candidates, 1);
  });
});
