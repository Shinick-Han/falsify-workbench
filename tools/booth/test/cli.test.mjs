import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startFake } from './fake-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BOOTH = path.join(ROOT, 'tools', 'booth', 'booth.mjs');
const TOKEN = `fso_${'a'.repeat(43)}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const SENTINELS = ['SENTINEL_AFTER_zz91', 'SENTINEL_REASON_zz91', 'SENTINEL_NICK_zz91', 'SENTINEL_TITLE_zz91'];

function run(args, { env, cwd = ROOT } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BOOTH, ...args], {
      cwd,
      env: { ...process.env, FALSIFY_BOOTH_TOKEN: TOKEN, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function submission(seq, extra = {}) {
  const receipt = `F-${String(seq).padStart(4, '0')}`;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    receipt,
    status: 'received',
    course: 'quick',
    nickname: 'SENTINEL_NICK_zz91',
    declared: [{
      pageIndex: 1,
      segmentId: 'p2-s1',
      before: 'p < 0.05',
      after: 'SENTINEL_AFTER_zz91 p < 0.50',
      defectType: 'number',
      reason: 'SENTINEL_REASON_zz91',
    }],
    paper: { source: 'arxiv', id: '2503.10497', title: 'SENTINEL_TITLE_zz91', license: 'cc-by-4.0' },
    jobId: `10000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    artifactId: `artifact-${seq}`,
    outcome: null,
    operatorNote: null,
    publicNote: null,
    prizeMessage: null,
    aiSummary: null,
    published: false,
    publishedAt: null,
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: '2026-11-22T00:00:00.000Z',
    ...extra,
  };
}

function writeConfig(dir, apiBase, extraBlue = {}) {
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'Review the PDF only. Report findings from the PDF text.\n');
  const config = {
    apiBase,
    dataDir: path.join(dir, 'data'),
    blue: { concurrency: 2, repeat: 1, pollIntervalMs: 20, pollTimeoutMs: 3000, profiles: [{
      name: 'quick-blind', model: 'claude-sonnet-5-5', effort: 'high', maxCalls: 4, useEvidence: true, promptFile: 'prompt.txt',
    }], ...extraBlue },
  };
  const file = path.join(dir, 'booth.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

function containsSentinel(state) {
  for (const request of state.requests) {
    const blob = `${request.method}\n${request.url}\n${JSON.stringify(request.headers)}\n${request.body.toString('utf8')}`;
    for (const needle of SENTINELS) {
      if (blob.includes(needle)) return needle;
    }
  }
  return '';
}

test('--help prints every command', async () => {
  const result = await run(['--help'], { env: { FALSIFY_BOOTH_TOKEN: '' } });
  assert.equal(result.code, 0);
  for (const name of ['status', 'list', 'pull', 'blue', 'score', 'judge', 'publish', 'unpublish', 'draw', 'export', 'missions', 'open', 'close', 'announce']) {
    assert.equal(result.stdout.includes(name), true, name);
  }
});

test('pull, blind BLUE, resume, score, judge, publish, draw, export, settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-cli-'));
  const rows = [submission(1), submission(2), submission(3, { status: 'withdrawn', outcome: null })];
  const pdfs = new Map(rows.map(row => [row.receipt, Buffer.from(PDF)]));
  const fake = await startFake({ token: TOKEN, submissions: rows, pdfs });
  const config = writeConfig(dir, fake.url);
  const base = ['--config', config];
  try {
    const pulled = await run([...base, 'pull']);
    assert.equal(pulled.code, 0, pulled.stderr);
    const again = await run([...base, 'pull']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fake.state.pdfGets['F-0001'], 1);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'submissions', 'F-0001', 'edited.pdf')), true);

    const first = await run([...base, 'blue', '--only', 'F-0001,F-0002']);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(containsSentinel(fake.state), '');
    const jobBodies = fake.state.requests.filter(request => request.method === 'POST' && request.url === '/v1/ai/jobs');
    assert.equal(jobBodies.length, 2);
    for (const request of jobBodies) {
      const body = JSON.parse(request.body.toString('utf8'));
      assert.equal(body.role, 'blue');
      assert.equal(Object.hasOwn(body, 'edits'), false);
      assert.equal(Object.hasOwn(body, 'visualEdits'), false);
      assert.equal(Object.hasOwn(body, 'applyOnly'), false);
      assert.equal(body.prompt.includes('Review the PDF only'), true);
    }
    assert.equal(fake.state.newJobs, 2);
    assert.ok(fake.state.maxJobInFlight <= 2);
    assert.ok(fake.state.maxJobInFlight >= 1);

    const replay = await run([...base, 'blue', '--only', 'F-0001']);
    assert.equal(replay.code, 0, replay.stderr);
    assert.equal(fake.state.newJobs, 2);
    const postsAfterResume = fake.state.requests.filter(request => request.method === 'POST' && request.url === '/v1/ai/jobs').length;
    assert.equal(postsAfterResume, 2);

    fs.rmSync(path.join(dir, 'data', 'blue', 'F-0002'), { recursive: true, force: true });
    const serverReplay = await run([...base, 'blue', '--only', 'F-0002']);
    assert.equal(serverReplay.code, 0, serverReplay.stderr);
    assert.equal(fake.state.newJobs, 2);
    assert.equal(serverReplay.stdout.includes('"replayed": true'), true);

    const scored = await run([...base, 'score']);
    assert.equal(scored.code, 0, scored.stderr);
    const score = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'score.json'), 'utf8'));
    const receipts = score.submissions.map(item => item.receipt);
    assert.deepEqual(receipts, ['F-0001', 'F-0002']);
    assert.equal(fake.state.patches.length, 0);

    const judged = await run([...base, 'judge', '--only', 'F-0001']);
    assert.equal(judged.code, 0, judged.stderr);
    const patch = fake.state.patches.find(item => item.receipt === 'F-0001');
    assert.equal(patch.body.status, 'judged');
    assert.ok(['caught', 'missed', 'partial'].includes(patch.body.outcome));
    assert.equal(Object.hasOwn(patch.body, 'published'), false);
    assert.equal(JSON.stringify(patch.body).includes('SENTINEL_REASON_zz91'), false);

    const published = await run([...base, 'publish', '--only', 'F-0001', '--prize', 'show this screen']);
    assert.equal(published.code, 0, published.stderr);
    const pub = fake.state.patches.find(item => item.receipt === 'F-0001' && item.body.published === true);
    assert.equal(pub.body.prizeMessage, 'show this screen');
    const hidden = await run([...base, 'unpublish', '--only', 'F-0001']);
    assert.equal(hidden.code, 0, hidden.stderr);
    assert.equal(fake.state.submissions.find(row => row.receipt === 'F-0001').published, false);

    const drawn = await run([...base, 'draw', '--count', '1', '--status', 'judged', '--outcome', 'caught,partial,missed']);
    assert.equal(drawn.code, 0, drawn.stderr);
    const drawFiles = fs.readdirSync(path.join(dir, 'data', 'draws'));
    assert.equal(drawFiles.length, 1);
    const draw = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'draws', drawFiles[0]), 'utf8'));
    assert.equal(draw.winners.length, 1);
    assert.equal(draw.winners[0].receipt, 'F-0001');

    const exported = await run([...base, 'export', '--format', 'common']);
    assert.equal(exported.code, 0, exported.stderr);
    const csv = fs.readFileSync(path.join(dir, 'data', 'exports', 'common.csv'));
    assert.equal(csv[0], 0xef);
    assert.equal(csv[1], 0xbb);
    assert.equal(csv[2], 0xbf);
    const text = csv.toString('utf8');
    assert.equal(text.includes('F-0003'), false);
    assert.equal(text.includes('참가자'), true);

    const key = await run([...base, 'export', '--format', 'key']);
    assert.equal(key.code, 0, key.stderr);
    const keyText = fs.readFileSync(path.join(dir, 'data', 'exports', 'key.csv'), 'utf8');
    assert.equal(keyText.includes('paper_id,team,defect_type'), true);
    assert.equal(keyText.includes('F-0003'), false);
    assert.equal(keyText.includes('SENTINEL_AFTER_zz91'), true);

    const closed = await run([...base, 'close', '--dry-run']);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(fake.state.puts.length, 0);
    const reallyClosed = await run([...base, 'close']);
    assert.equal(reallyClosed.code, 0, reallyClosed.stderr);
    assert.deepEqual(fake.state.puts.at(-1), { submissionsOpen: false });
    await run([...base, 'open']);
    assert.equal(fake.state.settings.submissionsOpen, true);

    const missionFile = path.join(dir, 'missions.json');
    fs.writeFileSync(missionFile, JSON.stringify([{
      id: 'paper-one', title: '첫 논문', source: 'arxiv', paperId: '2503.10497', license: 'cc-by-4.0', course: 'quick', hint: '표만 보세요',
    }]));
    const set = await run([...base, 'missions', 'set', missionFile]);
    assert.equal(set.code, 0, set.stderr);
    assert.equal(fake.state.puts.at(-1).missions[0].id, 'paper-one');
    assert.equal(Object.keys(fake.state.puts.at(-1)).join(','), 'missions');

    const said = await run([...base, 'announce', '--text', '접수를 마감합니다']);
    assert.equal(said.code, 0, said.stderr);
    assert.equal(fake.state.settings.announcement, '접수를 마감합니다');

    const listed = await run([...base, 'status']);
    assert.equal(listed.code, 0, listed.stderr);
    const status = JSON.parse(listed.stdout);
    assert.equal(status.config.enabled, true);
    assert.equal(status.total, 3);

    const archive = fs.readFileSync(path.join(dir, 'data', 'submissions', 'F-0001', 'submission.json'), 'utf8')
      + fs.readFileSync(path.join(dir, 'data', 'score.json'), 'utf8');
    assert.equal(archive.includes(TOKEN), false);
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run blue and judge send nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-dry-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(path.join(data, 'submissions', 'F-0004'), { recursive: true });
  fs.writeFileSync(path.join(data, 'submissions', 'F-0004', 'edited.pdf'), PDF);
  fs.writeFileSync(path.join(data, 'submissions', 'F-0004', 'submission.json'), JSON.stringify(submission(4)));
  fs.writeFileSync(path.join(data, 'score.json'), JSON.stringify({
    submissions: [{ receipt: 'F-0004', suggestedOutcome: 'caught', edits: [{ index: 0, pageIndex: 1, verdict: 'caught' }] }],
  }));
  const config = writeConfig(dir, 'http://127.0.0.1:1');
  try {
    const blue = await run(['--config', config, 'blue', '--dry-run']);
    assert.equal(blue.code, 0, blue.stderr);
    assert.equal(blue.stdout.includes('F-0004'), true);
    assert.equal(blue.stdout.includes('SENTINEL_AFTER_zz91'), false);
    const judge = await run(['--config', config, 'judge', '--dry-run']);
    assert.equal(judge.code, 0, judge.stderr);
    const body = JSON.parse(judge.stdout);
    assert.equal(body.actions[0].body.published, undefined);
    assert.equal(body.actions[0].body.outcome, 'caught');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queued BLUE jobs are polled until completed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-poll-'));
  const row = submission(5, { nickname: 'guest', paper: { source: 'arxiv', id: '1', title: 't', license: 'cc0' }, declared: [{
    pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: 'because',
  }] });
  const fake = await startFake({ token: TOKEN, submissions: [row], pdfs: new Map([['F-0005', Buffer.from(PDF)]]), queued: true });
  const config = writeConfig(dir, fake.url);
  try {
    const pulled = await run(['--config', config, 'pull', '--only', 'F-0005']);
    assert.equal(pulled.code, 0, pulled.stderr);
    const result = await run(['--config', config, 'blue', '--only', 'F-0005']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.includes('"state": "completed"'), true);
    assert.ok(fake.state.jobs.size === 1);
    const job = [...fake.state.jobs.values()][0];
    assert.ok(job.polls >= 1);
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrency stays at the configured limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-pool-'));
  const rows = [1, 2, 3, 4].map(seq => submission(seq, {
    nickname: `g${seq}`,
    paper: null,
    declared: [{ pageIndex: 0, before: 'a', after: 'b', defectType: 'other', reason: 'r' }],
  }));
  const pdfs = new Map(rows.map(row => [row.receipt, Buffer.from(PDF)]));
  const fake = await startFake({ token: TOKEN, submissions: rows, pdfs, jobDelayMs: 200 });
  const config = writeConfig(dir, fake.url, { concurrency: 2 });
  try {
    const pulled = await run(['--config', config, 'pull']);
    assert.equal(pulled.code, 0, pulled.stderr);
    const result = await run(['--config', config, 'blue', '--concurrency', '2']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.state.maxJobInFlight, 2);
    assert.equal(fake.state.newJobs, 4);
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wrong bearer is unauthorized and a foreign bearer is forbidden', async () => {
  const fake = await startFake({ token: TOKEN, submissions: [], pdfs: new Map() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-auth-'));
  const config = writeConfig(dir, fake.url);
  try {
    const missing = await run(['--config', config, 'status'], { env: { FALSIFY_BOOTH_TOKEN: '' } });
    assert.equal(missing.code, 1);
    assert.equal(missing.stderr.includes('booth_auth'), true);
    const foreign = await run(['--config', config, 'status'], { env: { FALSIFY_BOOTH_TOKEN: `fso_${'b'.repeat(43)}` } });
    assert.equal(foreign.code, 2);
    assert.equal(foreign.stderr.includes('forbidden'), true);
    assert.equal(foreign.stderr.includes(`fso_${'b'.repeat(43)}`), false);
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
