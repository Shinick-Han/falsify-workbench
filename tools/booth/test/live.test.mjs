import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_NOTES } from '../lib/config.mjs';
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
const caughtRow = seq => row(seq, {
  pageIndex: 4,
  segmentId: 'p5-b11',
  before: 'For faithfulness, the Ragas prediction are in general weakly accurate.',
  after: 'For faithfulness, the Ragas prediction are in general highly accurate.',
});
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

test('--help lists watch and final', async () => {
  const result = await run(['--help']);
  for (const name of ['watch', 'final', '--apply', '--cycles']) assert.equal(result.stdout.includes(name), true, name);
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
  assert.equal(missed.includes('5쪽'), true);
  assert.equal(missed.includes('다른 곳'), true);
  const none = buildPublicNote({ outcome: 'missed', matched: null, first: null, templates: DEFAULT_NOTES });
  assert.equal(none, DEFAULT_NOTES.missedNone);
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
    assert.match(missed.publicNote, /다른 곳/);
    assert.match(missed.publicNote, /5쪽/);
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

test('watch: a poll failure is retried; a job that keeps failing is left reviewing and surfaced', async () => {
  await withFake({ submissions: [caughtRow(1)], result: HOSTED, queued: true, pollFailures: 1 }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(find(fake, 'F-0001').outcome, 'caught');
    assert.equal(fake.state.newJobs, 1);
    assert.match(result.stderr, /attempt 1 failed unavailable/);
  });
  await withFake({ submissions: [caughtRow(1)], failJobs: true }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const result = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(result.code, 0, result.stderr);
    const item = find(fake, 'F-0001');
    assert.equal(item.status, 'reviewing');
    assert.equal(item.published, false);
    assert.equal(item.operatorNote, 'live: failed booth_job');
    assert.equal(fake.state.newJobs, 3);
    const end = jsonLines(result.stdout).at(-1);
    assert.equal(end.failed, 1);
    assert.deepEqual(end.failedReceipts, [{ receipt: 'F-0001', code: 'booth_job' }]);
    assert.match(result.stderr, /F-0001 FAILED booth_job; left reviewing/);
    // A failed row is not picked up again by the next start.
    const again = await run(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fake.state.newJobs, 3);
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
