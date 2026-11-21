import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { configHash, idempotencyKey } from '../lib/blue.mjs';
import { readMarker } from '../lib/live.mjs';
import { startFake } from './fake-api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const BOOTH = path.join(ROOT, 'tools', 'booth', 'booth.mjs');
const TOKEN = `fso_${'i'.repeat(43)}`;
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
      pageIndex: 4,
      segmentId: 'p5-b2',
      defectType: 'number',
      reason: 'changed faithfulness',
      before: 'For faithfulness, the Ragas prediction are mostly inaccurate.',
      after: 'For faithfulness, the Ragas prediction are in general highly accurate.',
    }],
    paper: { source: 'arxiv', id: '2309.15217', title: 'Ragas', license: 'cc-by-4.0' },
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

function writeConfig(dir, apiBase, { blue = {}, live = {} } = {}) {
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
      ...blue,
    },
    live: {
      concurrency: 2,
      intervalSec: 1,
      retries: 1,
      retryBackoffMs: 20,
      prizeMessage: 'PRIZE_LIVE',
      finalPrizeMessage: 'PRIZE_FINAL',
      finalCaughtMessage: 'FINAL_CAUGHT',
      ...live,
    },
  };
  const file = path.join(dir, 'booth.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

function liveProfileHash(dir) {
  const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
  return configHash({ name: 'live', model: 'claude-sonnet-5-5', effort: 'high', maxCalls: 8, useEvidence: true, prompt });
}

async function withFake(options, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-recovery-incomplete-'));
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

test('unusable completed jobs: watch never spawns duplicate paid jobs; explicit recover advances repeat for exact pdf/profile', async () => {
  const rows = [makeRow(1), makeRow(2)];
  let phase = 'unusable';
  const resultFn = body => {
    if (phase === 'fixed') return HOSTED;
    // First receipt gets refusal, second gets incomplete multi-batch.
    return body.idempotencyKey === firstKey0
      ? { schema: 'falsify.document-blue.v1', status: 'refusal', findings: [], coverage: { complete: false } }
      : { ...HOSTED, coverage: { complete: false, remainingBatches: [{ textBatch: 2, segmentIds: ['p20-b1'], chars: 40000 }] } };
  };
  let firstKey0 = '';

  await withFake({ submissions: rows, result: resultFn }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, { live: { retries: 2 } });
    const data = path.join(dir, 'data');
    const hash = liveProfileHash(dir);
    firstKey0 = idempotencyKey({ receipt: 'F-0001', profileName: 'live', repeatIndex: 0, configHash: hash, pdfSha256: PDF_SHA });
    const secondKey0 = idempotencyKey({ receipt: 'F-0002', profileName: 'live', repeatIndex: 0, configHash: hash, pdfSha256: PDF_SHA });

    // 1. Normal watch runs repeat 0 once per receipt, refuses unusable completed outputs, zero duplicate paid jobs.
    const w1 = await runBooth(['--config', config, 'watch', '--cycles', '1', '--concurrency', '1']);
    assert.equal(w1.code, 0, w1.stderr);
    assert.equal(fake.state.newJobs, 2, 'normal watch must create only 1 job per receipt');
    for (const [receipt, expectedCode] of [['F-0001', 'review_refusal'], ['F-0002', 'review_incomplete']]) {
      const sub = fake.state.submissions.find(item => item.receipt === receipt);
      assert.equal(sub.status, 'reviewing');
      assert.equal(sub.published, false);
      const marker = readMarker(data, receipt);
      assert.equal(marker.state, 'failed');
      assert.equal(marker.code, expectedCode);
      assert.equal(marker.retryable, false);
      assert.equal(marker.repeat, 0);
    }

    // 2. Even if a crash left marker.state='running' with saved unusable completed record on disk,
    //    restarting normal watch must NOT create duplicate paid jobs.
    for (const receipt of ['F-0001', 'F-0002']) {
      const marker = readMarker(data, receipt);
      fs.writeFileSync(path.join(data, 'live', `${receipt}.json`), JSON.stringify({ ...marker, state: 'running' }));
    }
    const w2 = await runBooth(['--config', config, 'watch', '--cycles', '1', '--concurrency', '1']);
    assert.equal(w2.code, 0, w2.stderr);
    assert.equal(fake.state.newJobs, 2, 'watch restart must not spawn duplicate paid jobs for permanent unusable completions');
    assert.equal(readMarker(data, 'F-0001').state, 'failed');
    assert.equal(readMarker(data, 'F-0001').code, 'review_refusal');
    assert.equal(readMarker(data, 'F-0002').state, 'failed');
    assert.equal(readMarker(data, 'F-0002').code, 'review_incomplete');

    // 3. recover --dry-run must NOT offer resume_completed; it must plan reprocess at repeat #1 with fresh keys.
    const dry = await runBooth(['--config', config, 'recover', '--only', 'F-0001,F-0002', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    const dryBody = JSON.parse(dry.stdout);
    const plan1 = dryBody.results.find(r => r.receipt === 'F-0001');
    const plan2 = dryBody.results.find(r => r.receipt === 'F-0002');
    assert.equal(plan1.action, 'reprocess');
    assert.equal(plan1.existingAttempts, 1);
    assert.equal(plan1.nextRepeat, 1);
    assert.equal(plan1.lastFailure.code, 'review_refusal');
    assert.equal(plan1.lastFailure.jobState, 'completed');
    assert.notEqual(plan1.nextIdempotencyKey, firstKey0);
    assert.equal(plan2.action, 'reprocess');
    assert.equal(plan2.existingAttempts, 1);
    assert.equal(plan2.nextRepeat, 1);
    assert.equal(plan2.lastFailure.code, 'review_incomplete');
    assert.notEqual(plan2.nextIdempotencyKey, secondKey0);
    assert.equal(fake.state.newJobs, 2, 'dry-run sends no jobs');

    // 4. After underlying issue is fixed, explicit recover advances repeat to #1, preserves #0, and judges both.
    phase = 'fixed';
    const rec = await runBooth(['--config', config, 'recover', '--all-failed', '--concurrency', '1']);
    assert.equal(rec.code, 0, rec.stderr);
    const recBody = JSON.parse(rec.stdout);
    assert.equal(recBody.done, 2);
    assert.equal(recBody.failed, 0);
    assert.equal(fake.state.newJobs, 4, 'one fresh paid job per receipt on recover');
    for (const receipt of ['F-0001', 'F-0002']) {
      const r = recBody.results.find(item => item.receipt === receipt);
      assert.equal(r.action, 'done');
      assert.equal(r.repeat, 1);
      assert.equal(r.outcome, 'caught');
      assert.equal(fs.existsSync(path.join(data, 'blue', receipt, 'live', '0', `${hash}.json`)), true, 'repeat 0 preserved');
      assert.equal(fs.existsSync(path.join(data, 'blue', receipt, 'live', '1', `${hash}.json`)), true, 'repeat 1 written');
      const sub = fake.state.submissions.find(item => item.receipt === receipt);
      assert.equal(sub.status, 'judged');
      assert.equal(sub.published, true);
      assert.equal(readMarker(data, receipt).state, 'done');
    }
  });
});

test('recover skips server-replayed unusable completed repeats on a fresh host and stops after one persistent fresh refusal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-recover-unusable-replay-'));
  writeConfig(dir, 'http://127.0.0.1:1');
  const hash = liveProfileHash(dir);
  const key0 = idempotencyKey({ receipt: 'F-0021', profileName: 'live', repeatIndex: 0, configHash: hash, pdfSha256: PDF_SHA });
  const key1 = idempotencyKey({ receipt: 'F-0022', profileName: 'live', repeatIndex: 0, configHash: hash, pdfSha256: PDF_SHA });
  const seedJobs = [
    {
      id: '00000000-0000-4000-8000-000000000210',
      role: 'blue',
      state: 'completed',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      useEvidence: true,
      idempotencyKey: key0,
      requestBody: {},
      polls: 0,
      result: { schema: 'falsify.document-blue.v1', status: 'refusal', findings: [], coverage: { complete: false } },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      createdAt: '2026-11-21T10:00:00.000Z',
      completedAt: '2026-11-21T10:00:05.000Z',
    },
    {
      id: '00000000-0000-4000-8000-000000000220',
      role: 'blue',
      state: 'completed',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      useEvidence: true,
      idempotencyKey: key1,
      requestBody: {},
      polls: 0,
      result: { schema: 'falsify.document-blue.v1', status: 'refusal', findings: [], coverage: { complete: false } },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      createdAt: '2026-11-21T10:00:00.000Z',
      completedAt: '2026-11-21T10:00:05.000Z',
    },
  ];
  const row21 = makeRow(21, { status: 'reviewing' });
  const row22 = makeRow(22, { status: 'reviewing' });
  const key21Fresh = idempotencyKey({ receipt: 'F-0021', profileName: 'live', repeatIndex: 1, configHash: hash, pdfSha256: PDF_SHA });

  const fake = await startFake({
    token: TOKEN,
    submissions: [row21, row22],
    pdfs: new Map([['F-0021', Buffer.from(PDF)], ['F-0022', Buffer.from(PDF)]]),
    seedJobs,
    result: body => (body.idempotencyKey === key21Fresh
      ? HOSTED
      : { schema: 'falsify.document-blue.v1', status: 'refusal', findings: [], coverage: { complete: false } }),
  });
  try {
    const config = writeConfig(dir, fake.url, { live: { retries: 2 } });
    const rec = await runBooth(['--config', config, 'recover', '--only', 'F-0021,F-0022', '--concurrency', '1']);
    assert.equal(rec.code, 3, rec.stderr);
    const body = JSON.parse(rec.stdout);
    assert.equal(body.done, 1);
    assert.equal(body.failed, 1);
    assert.equal(fake.state.newJobs, 2, 'one fresh attempt per receipt after skipping replayed repeat #0');
    const r21 = body.results.find(item => item.receipt === 'F-0021');
    const r22 = body.results.find(item => item.receipt === 'F-0022');
    assert.equal(r21.action, 'done');
    assert.equal(r21.repeat, 1);
    assert.equal(r22.action, 'failed');
    assert.equal(r22.code, 'review_refusal');
    assert.equal(r22.repeat, 1);
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('long-duration transient 503 poll outage keeps saved running job durable, surfaces delayed in ticket, and resumes without new job', async () => {
  // pollFailures=5 exceeds 1 + retries(1) = 2 polls in cycle 1, forcing deferral across cycles.
  await withFake({
    submissions: [makeRow(30)],
    result: HOSTED,
    queued: true,
    pollFailures: 5,
  }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, {
      blue: { pollIntervalMs: 15 },
      live: { retries: 1, retryBackoffMs: 15, intervalSec: 1 },
    });
    const data = path.join(dir, 'data');

    // Run 1 cycle during the outage -> must NOT mark failed, must preserve jobId, must surface delayed note.
    const c1 = await runBooth(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(c1.code, 0, c1.stderr);
    assert.equal(fake.state.newJobs, 1);
    assert.equal(fake.state.jobPosts, 1);
    const [savedJob] = [...fake.state.jobs.values()];
    const end1 = jsonLines(c1.stdout).at(-1);
    assert.equal(end1.failed, 0, 'transient poll outage must not fail the row');
    assert.equal(end1.delayed, 1);
    assert.equal(end1.delayedReceipts[0].receipt, 'F-0030');
    assert.equal(end1.delayedReceipts[0].code, 'unavailable');
    assert.equal(end1.delayedReceipts[0].jobId, savedJob.id);

    const marker1 = readMarker(data, 'F-0030');
    assert.equal(marker1.state, 'running', 'marker stays running for durable resume');
    assert.equal(marker1.delayed, true);
    assert.equal(marker1.delayCount, 1);
    assert.equal(marker1.jobId, savedJob.id);
    assert.equal(marker1.lastTransientError.code, 'unavailable');
    assert.equal(marker1.lastTransientError.retryable, true);

    const sub1 = fake.state.submissions.find(item => item.receipt === 'F-0030');
    assert.equal(sub1.status, 'reviewing');
    assert.equal(sub1.published, false);
    assert.match(sub1.operatorNote, /^live: failed transient unavailable \(delayed; resuming job=/,
      'operatorNote prefix matches booth.mjs review_delayed selector');

    // Dry-run recover while delayed still plans resume_job and surfaces delayed metadata.
    const dry = await runBooth(['--config', config, 'recover', '--only', 'F-0030', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    const dryPlan = JSON.parse(dry.stdout).results[0];
    assert.equal(dryPlan.action, 'resume_job');
    assert.equal(dryPlan.delayed, true);
    assert.equal(dryPlan.jobId, savedJob.id);

    // Outage ends (remaining pollFailures cleared) -> restart watch resumes exact job id.
    fake.state.pollFailures = 0;
    const c2 = await runBooth(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(c2.code, 0, c2.stderr);
    assert.equal(fake.state.jobPosts, 1, 'resumed saved job without creating a second job');
    assert.equal(fake.state.newJobs, 1);
    const end2 = jsonLines(c2.stdout).at(-1);
    assert.equal(end2.done, 1);
    assert.equal(end2.failed, 0);
    assert.equal(end2.delayed, 0);
    const sub2 = fake.state.submissions.find(item => item.receipt === 'F-0030');
    assert.equal(sub2.status, 'judged');
    assert.equal(sub2.outcome, 'caught');
    assert.equal(sub2.published, true);
    const marker2 = readMarker(data, 'F-0030');
    assert.equal(marker2.state, 'done');
    assert.equal(marker2.delayed, false);
    assert.equal(marker2.delayCount, 0);
    assert.equal(marker2.lastTransientError, null);
  });

  // Also verify multi-cycle in-process watch recovery without restart when outage drains across cycles.
  await withFake({
    submissions: [makeRow(32)],
    result: HOSTED,
    queued: true,
    pollFailures: 3,
  }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, {
      blue: { pollIntervalMs: 15 },
      live: { retries: 1, retryBackoffMs: 15, intervalSec: 1 },
    });
    const res = await runBooth(['--config', config, 'watch', '--cycles', '3']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(fake.state.jobPosts, 1, 'multi-cycle outage must never POST a second job');
    assert.equal(fake.state.newJobs, 1);
    const end = jsonLines(res.stdout).at(-1);
    assert.equal(end.done, 1);
    assert.equal(end.failed, 0);
    assert.equal(end.delayed, 0);
    const sub = fake.state.submissions.find(item => item.receipt === 'F-0032');
    assert.equal(sub.status, 'judged');
    assert.equal(sub.outcome, 'caught');
    assert.equal(readMarker(path.join(dir, 'data'), 'F-0032').delayed, false);
  });
});

test('network outage (socket drop -> booth_network) across watcher restart durably resumes saved job without duplicate POST', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-network-outage-'));
  const data = path.join(dir, 'data');
  const row = makeRow(31);
  let dropJobGets = true;
  let jobPosts = 0;
  let jobGets = 0;
  let savedJob = null;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://127.0.0.1');
    const sendJson = (status, payload) => {
      const buf = Buffer.from(JSON.stringify(payload));
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
      res.end(buf);
    };
    if (req.method === 'GET' && url.pathname === '/v1/booth/admin/submissions') {
      sendJson(200, { submissions: [row], nextAfter: null });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/booth/admin/submissions/F-0031') {
      sendJson(200, row);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/booth/admin/submissions/F-0031/pdf') {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': PDF.length,
        'X-Falsify-Pdf-Sha256': PDF_SHA,
      });
      res.end(PDF);
      return;
    }
    if (req.method === 'PATCH' && url.pathname === '/v1/booth/admin/submissions/F-0031') {
      const patch = JSON.parse(body.toString('utf8'));
      Object.assign(row, patch);
      if (patch.published === true) row.publishedAt = new Date().toISOString();
      row.updatedAt = new Date().toISOString();
      sendJson(200, row);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/ai/uploads') {
      sendJson(201, { upload: { id: randomUUID(), sha256: PDF_SHA, mime: 'application/pdf', bytes: PDF.length } });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/ai/jobs') {
      jobPosts += 1;
      const reqBody = JSON.parse(body.toString('utf8'));
      savedJob = {
        id: randomUUID(),
        role: 'blue',
        state: 'queued',
        model: reqBody.model,
        effort: reqBody.effort,
        useEvidence: true,
        idempotencyKey: reqBody.idempotencyKey,
        result: null,
        usage: { inputTokens: 11, outputTokens: 7 },
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      sendJson(202, { job: savedJob, replayed: false });
      return;
    }
    if (req.method === 'GET' && savedJob && url.pathname === `/v1/ai/jobs/${savedJob.id}`) {
      jobGets += 1;
      if (dropJobGets) {
        req.socket.destroy();
        return;
      }
      savedJob.state = 'completed';
      savedJob.result = HOSTED;
      savedJob.completedAt = new Date().toISOString();
      sendJson(200, { job: savedJob });
      return;
    }
    sendJson(404, { error: { code: 'not_found', message: 'not_found', retryable: false } });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const apiBase = `http://127.0.0.1:${port}`;
  try {
    const config = writeConfig(dir, apiBase, {
      blue: { pollIntervalMs: 15 },
      live: { retries: 1, retryBackoffMs: 15, intervalSec: 1 },
    });

    // Cycle 1: POST succeeds, then every GET /v1/ai/jobs/:id drops the TCP socket (booth_network).
    const first = await runBooth(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(jobPosts, 1);
    assert.ok(jobGets >= 2, `expected retries during outage, got ${jobGets}`);
    const marker1 = readMarker(data, 'F-0031');
    assert.equal(marker1.state, 'running', 'network drop must not write irrevocable failed marker');
    assert.equal(marker1.delayed, true);
    assert.equal(marker1.jobId, savedJob.id);
    assert.equal(marker1.lastTransientError.code, 'booth_network');
    assert.match(row.operatorNote, /^live: failed transient booth_network \(delayed; resuming job=/);

    // Network recovers; watcher restarts and resumes the exact saved job without POSTing a new job.
    dropJobGets = false;
    const second = await runBooth(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(jobPosts, 1, 'must never create a duplicate job after network returns');
    assert.equal(row.status, 'judged');
    assert.equal(row.outcome, 'caught');
    assert.equal(row.published, true);
    const marker2 = readMarker(data, 'F-0031');
    assert.equal(marker2.state, 'done');
    assert.equal(marker2.delayed, false);
    assert.equal(marker2.jobId, savedJob.id);
  } finally {
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('terminal retryable host errors stay bounded across restarts and recover cleanly after host fix', async () => {
  let hostDown = true;
  const retryableHostErr = () => (hostDown
    ? { code: 'provider_unavailable', retryable: true, message: 'Host temporarily overloaded.' }
    : null);

  await withFake({
    submissions: [makeRow(40)],
    result: HOSTED,
    failSpec: retryableHostErr,
  }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url, { live: { retries: 2, retryBackoffMs: 15 } });
    const data = path.join(dir, 'data');
    const hash = liveProfileHash(dir);

    // Seed 2 prior failed retryable repeats (0 and 1) with marker still 'running' (simulating crash mid-retry).
    fs.mkdirSync(path.join(data, 'live'), { recursive: true });
    fs.writeFileSync(path.join(data, 'live', 'F-0040.json'), JSON.stringify({
      receipt: 'F-0040',
      state: 'running',
      receivedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    }));
    for (const repeat of [0, 1]) {
      const key = idempotencyKey({ receipt: 'F-0040', profileName: 'live', repeatIndex: repeat, configHash: hash, pdfSha256: PDF_SHA });
      const recPath = path.join(data, 'blue', 'F-0040', 'live', String(repeat), `${hash}.json`);
      fs.mkdirSync(path.dirname(recPath), { recursive: true });
      fs.writeFileSync(recPath, JSON.stringify({
        idempotencyKey: key,
        profile: 'live',
        repeat,
        configHash: hash,
        replayed: false,
        job: {
          id: `00000000-0000-4000-8000-00000000040${repeat}`,
          role: 'blue',
          state: 'failed',
          model: 'claude-sonnet-5-5',
          failure: { code: 'provider_unavailable', retryable: true, message: 'Host temporarily overloaded.' },
        },
      }));
    }
    fake.state.submissions[0].status = 'reviewing';

    // Watch runs ONLY repeat #2 (respecting persistent 1 + retries = 3 bound), then stops as failed for operator recover.
    const w = await runBooth(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(w.code, 0, w.stderr);
    assert.equal(fake.state.newJobs, 1, 'only repeat #2 should run to honor total bound of 3 attempts');
    const marker = readMarker(data, 'F-0040');
    assert.equal(marker.state, 'failed');
    assert.equal(marker.code, 'provider_unavailable');
    assert.equal(marker.retryable, true);
    assert.equal(marker.repeat, 2);

    // Next watch cycle does not burn more paid retries.
    const w2 = await runBooth(['--config', config, 'watch', '--cycles', '1']);
    assert.equal(w2.code, 0, w2.stderr);
    assert.equal(fake.state.newJobs, 1);

    // Host recovers -> explicit operator recover allocates repeat #3 and publishes.
    hostDown = false;
    const rec = await runBooth(['--config', config, 'recover', '--all-failed']);
    assert.equal(rec.code, 0, rec.stderr);
    const recBody = JSON.parse(rec.stdout);
    assert.equal(recBody.done, 1);
    assert.equal(recBody.results[0].repeat, 3);
    assert.equal(recBody.results[0].outcome, 'caught');
    assert.equal(fake.state.newJobs, 2);
    assert.equal(fake.state.submissions[0].status, 'judged');
  });
});

test('recover reuses valid completed record (0 new jobs) while advancing repeat after unusable completed record', async () => {
  const validRow = makeRow(50, { status: 'reviewing' });
  const unusableRow = makeRow(51, { status: 'reviewing' });
  await withFake({ submissions: [validRow, unusableRow], result: HOSTED }, async (fake, dir) => {
    const config = writeConfig(dir, fake.url);
    const data = path.join(dir, 'data');
    const hash = liveProfileHash(dir);
    for (const [receipt, result] of [
      ['F-0050', HOSTED],
      ['F-0051', { schema: 'falsify.document-blue.v1', status: 'abstain', findings: [], coverage: { complete: false } }],
    ]) {
      const key = idempotencyKey({ receipt, profileName: 'live', repeatIndex: 0, configHash: hash, pdfSha256: PDF_SHA });
      const recPath = path.join(data, 'blue', receipt, 'live', '0', `${hash}.json`);
      fs.mkdirSync(path.dirname(recPath), { recursive: true });
      fs.writeFileSync(recPath, JSON.stringify({
        idempotencyKey: key,
        profile: 'live',
        repeat: 0,
        configHash: hash,
        replayed: false,
        job: { id: `00000000-0000-4000-8000-00000000${receipt.slice(2)}`, role: 'blue', state: 'completed', model: 'claude-sonnet-5-5', result },
      }));
    }

    const dry = await runBooth(['--config', config, 'recover', '--only', 'F-0050,F-0051', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    const plans = JSON.parse(dry.stdout).results;
    assert.equal(plans.find(p => p.receipt === 'F-0050').action, 'resume_completed');
    assert.equal(plans.find(p => p.receipt === 'F-0051').action, 'reprocess');
    assert.equal(plans.find(p => p.receipt === 'F-0051').nextRepeat, 1);

    const rec = await runBooth(['--config', config, 'recover', '--only', 'F-0050,F-0051', '--concurrency', '1']);
    assert.equal(rec.code, 0, rec.stderr);
    const body = JSON.parse(rec.stdout);
    assert.equal(body.done, 2);
    assert.equal(fake.state.newJobs, 1, 'valid F-0050 reused with 0 new jobs; unusable F-0051 ran 1 fresh job at repeat #1');
    assert.equal(body.results.find(r => r.receipt === 'F-0050').resumed, true);
    assert.equal(body.results.find(r => r.receipt === 'F-0050').repeat, 0);
    assert.equal(body.results.find(r => r.receipt === 'F-0051').resumed, false);
    assert.equal(body.results.find(r => r.receipt === 'F-0051').repeat, 1);
  });
});
