import fs from 'node:fs';
import path from 'node:path';

import { assembleJobBody, buildBlueRequest, configHash, idempotencyKey } from './blue.mjs';
import { OUTCOMES, STATUSES, TERMINAL_JOB } from './constants.mjs';
import { resolveApiBase, resolveBluePlan, resolveDataDir } from './config.mjs';
import { drawWinners } from './draw.mjs';
import { BoothError } from './errors.mjs';
import { jsonlRows, keyRows, commonRows, renderExport, scoreRows } from './export.mjs';
import { runsForReceipt } from './findings.mjs';
import { createClient } from './http.mjs';
import { mapPool } from './pool.mjs';
import { scoreSubmission } from './score.mjs';
import {
  appendWithdrawnTombstone, blueRecordPath, fileSha256, listReceipts, loadBlueRecords,
  loadSubmission, pdfPath, readJsonOptional, submissionDir, writeAtomic, writeJson,
} from './store.mjs';
import { parseCsvSet, sha256Hex } from './text.mjs';

function progress(io, line) {
  io.stderr.write(`[booth] ${line}\n`);
}

function print(io, value) {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function clientFor(ctx) {
  return createClient({ apiBase: resolveApiBase(ctx.config, ctx.flags), token: ctx.token });
}

function dataDir(ctx) {
  return resolveDataDir(ctx.config, ctx.flags);
}

function receiptSet(flags) {
  const set = parseCsvSet(flags.only);
  if (!set) return null;
  for (const receipt of set) {
    if (!/^F-\d{4,}$/.test(receipt)) throw new BoothError('booth_config', `receipt shape: ${receipt}`);
  }
  return set;
}

function statusSet(flags, fallback = null) {
  const set = parseCsvSet(flags.status) || (fallback ? new Set(fallback) : null);
  if (!set) return null;
  for (const status of set) {
    if (!STATUSES.includes(status)) throw new BoothError('booth_config', `unknown status ${status}`);
  }
  return set;
}

function outcomeSet(value) {
  const set = parseCsvSet(value);
  if (!set) return null;
  for (const outcome of set) {
    if (!OUTCOMES.includes(outcome)) throw new BoothError('booth_config', `unknown outcome ${outcome}`);
  }
  return set;
}

function selected(row, { only, statuses, outcomes }) {
  if (only && !only.has(row.receipt)) return false;
  if (statuses && !statuses.has(row.status)) return false;
  if (outcomes && !outcomes.has(row.outcome)) return false;
  return true;
}

async function listPages(client, flags, { onePage = false } = {}) {
  const limit = flags.limit !== undefined && flags.limit !== true ? Number(flags.limit) : 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new BoothError('booth_config', 'limit must be an integer from 1 to 200');
  }
  let after = flags.after !== undefined && flags.after !== true ? Number(flags.after) : null;
  if (after != null && (!Number.isSafeInteger(after) || after < 0)) throw new BoothError('booth_config', 'after must be a seq integer');
  const submissions = [];
  for (;;) {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (flags.status && flags.status !== true) params.set('status', String(flags.status));
    if (after != null) params.set('after', String(after));
    const page = await client.json(`/v1/booth/admin/submissions?${params}`);
    const rows = Array.isArray(page.submissions) ? page.submissions : [];
    submissions.push(...rows);
    if (onePage || page.nextAfter == null) return { submissions, nextAfter: page.nextAfter ?? null };
    if (page.nextAfter === after) throw new BoothError('booth_api', 'submission page did not advance');
    after = page.nextAfter;
    if (submissions.length > 100000) throw new BoothError('booth_api', 'submission list exceeded 100000 rows');
  }
}

function localRows(dir, flags) {
  const only = receiptSet(flags);
  const statuses = statusSet(flags);
  const rows = [];
  for (const receipt of listReceipts(dir)) {
    if (only && !only.has(receipt)) continue;
    const row = loadSubmission(dir, receipt);
    if (statuses && !statuses.has(row.status)) continue;
    rows.push(row);
  }
  return rows;
}

function activeRows(rows) {
  return rows.filter(row => row.status !== 'withdrawn');
}

export async function status(ctx) {
  const client = clientFor(ctx);
  const config = await client.json('/v1/booth/config');
  const settings = await client.json('/v1/booth/admin/settings');
  const { submissions } = await listPages(client, { ...ctx.flags, status: undefined, after: undefined, limit: 200 });
  const counts = {};
  for (const row of submissions) counts[row.status] = (counts[row.status] || 0) + 1;
  print(ctx.io, { apiBase: client.apiBase, config, settings, counts, total: submissions.length });
}

export async function list(ctx) {
  const client = clientFor(ctx);
  const page = await listPages(client, ctx.flags);
  print(ctx.io, page);
}

export async function pull(ctx) {
  const client = clientFor(ctx);
  const dir = dataDir(ctx);
  const only = receiptSet(ctx.flags);
  statusSet(ctx.flags);
  const { submissions } = await listPages(client, ctx.flags);
  let saved = 0;
  let skipped = 0;
  let kept = 0;
  let withdrawn = 0;
  for (const row of submissions) {
    if (only && !only.has(row.receipt)) continue;
    const result = await archiveSubmission(ctx.io, client, dir, row);
    if (result === 'saved') saved += 1;
    else if (result === 'kept') kept += 1;
    else if (result === 'withdrawn') withdrawn += 1;
    else skipped += 1;
  }
  print(ctx.io, { dataDir: dir, saved, skipped, kept, withdrawn, seen: submissions.length });
}

function forgetWithdrawn(io, dir, row) {
  fs.rmSync(submissionDir(dir, row.receipt), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'blue', row.receipt), { recursive: true, force: true });
  const added = appendWithdrawnTombstone(dir, row);
  progress(io, `pull ${row.receipt} withdrawn; local files removed${added ? '' : '; tombstone already recorded'}`);
  return 'withdrawn';
}

async function archiveSubmission(io, client, dir, row) {
  if (!/^F-\d{4,}$/.test(row.receipt)) throw new BoothError('booth_api', 'server returned a bad receipt');
  if (row.status === 'withdrawn') return forgetWithdrawn(io, dir, row);
  const folder = submissionDir(dir, row.receipt);
  const pdf = path.join(folder, 'edited.pdf');
  const hashFile = path.join(folder, 'pdf.sha256');
  const meta = path.join(folder, 'submission.json');
  const previous = readJsonOptional(meta);
  const previousHash = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8').trim() : '';
  if (
    previous
    && previous.updatedAt === row.updatedAt
    && previous.pdfSha256 === row.pdfSha256
    && previous.pdfBytes === row.pdfBytes
    && previous.sourceSha256 === row.sourceSha256
    && previousHash === row.pdfSha256
    && fs.existsSync(pdf)
    && fileSha256(pdf) === previousHash
  ) {
    progress(io, `pull ${row.receipt} unchanged`);
    return 'skipped';
  }
  let downloaded;
  try {
    downloaded = await client.file(`/v1/booth/admin/submissions/${encodeURIComponent(row.receipt)}/pdf`);
  } catch (error) {
    if (error instanceof BoothError && error.code === 'withdrawn') return forgetWithdrawn(io, dir, row);
    if (error instanceof BoothError && error.code === 'artifact_expired' && fs.existsSync(pdf)) {
      writeJson(meta, row);
      progress(io, `pull ${row.receipt} remote PDF expired; local file kept`);
      return 'kept';
    }
    throw error;
  }
  const bytes = downloaded.bytes;
  const hash = verifiedPdf(row, bytes, downloaded.headers);
  writeAtomic(pdf, bytes);
  writeAtomic(hashFile, `${hash}\n`);
  writeJson(meta, row);
  progress(io, `pull ${row.receipt} sha256=${hash} bytes=${bytes.length}`);
  return 'saved';
}

function verifiedPdf(row, bytes, headers) {
  if (typeof row.pdfSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.pdfSha256)) {
    throw new BoothError('booth_api', `${row.receipt} pdfSha256 is missing`, { exitCode: 2 });
  }
  if (!Number.isSafeInteger(row.pdfBytes) || row.pdfBytes < 0) {
    throw new BoothError('booth_api', `${row.receipt} pdfBytes is missing`, { exitCode: 2 });
  }
  const hash = sha256Hex(bytes);
  const header = String(headers.get('x-falsify-pdf-sha256') || '').trim().toLowerCase();
  if (hash !== row.pdfSha256 || header !== row.pdfSha256 || bytes.length !== row.pdfBytes) {
    throw new BoothError('pdf_mismatch', `${row.receipt} PDF does not match pdfSha256`);
  }
  return hash;
}

function submissionPdfSha256(dir, row) {
  if (typeof row.pdfSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.pdfSha256)) {
    throw new BoothError('booth_local', `${row.receipt} is missing pdfSha256; pull again`);
  }
  const actual = fileSha256(pdfPath(dir, row.receipt));
  if (actual !== row.pdfSha256) {
    throw new BoothError('pdf_mismatch', `${row.receipt} local PDF does not match pdfSha256`);
  }
  return row.pdfSha256;
}

export async function blue(ctx) {
  const dir = dataDir(ctx);
  const plan = resolveBluePlan(ctx.config, ctx.flags);
  if (ctx.flags.allowOpen !== true) {
    const gate = clientFor(ctx);
    const settings = await gate.json('/v1/booth/admin/settings');
    if (!settings || settings.submissionsOpen !== false) {
      throw new BoothError(
        'booth_config',
        'submissions are open; pass --allow-open to run BLUE while visitors share the runtime',
      );
    }
  }
  const rows = activeRows(localRows(dir, ctx.flags));
  const tasks = [];
  for (const row of rows) {
    for (const profile of plan.profiles) {
      const hash = configHash(profile);
      for (let repeat = 0; repeat < plan.repeat; repeat += 1) {
        tasks.push({ row, profile, repeat, hash });
      }
    }
  }
  if (ctx.flags.dryRun === true) {
    const actions = tasks.map(task => dryBlueAction(dir, task));
    progress(ctx.io, `dry-run blue ${actions.length} job(s); no request sent`);
    print(ctx.io, { dryRun: true, jobs: actions });
    return;
  }
  const client = clientFor(ctx);
  const results = await mapPool(tasks, plan.concurrency, task => runBlue(ctx.io, client, dir, plan, task));
  const failed = results.filter(result => !result.ok);
  print(ctx.io, { dataDir: dir, jobs: results });
  if (failed.length) {
    throw new BoothError('booth_partial', `${failed.length} of ${results.length} BLUE job(s) failed`, { exitCode: 3 });
  }
}

function blueKey(dir, task) {
  return idempotencyKey({
    receipt: task.row.receipt,
    profileName: task.profile.name,
    repeatIndex: task.repeat,
    configHash: task.hash,
    pdfSha256: submissionPdfSha256(dir, task.row),
  });
}

function dryBlueAction(dir, task) {
  const file = pdfPath(dir, task.row.receipt);
  const settings = buildBlueRequest({ pdfPath: file, profile: task.profile });
  const key = blueKey(dir, task);
  return {
    receipt: task.row.receipt,
    profile: task.profile.name,
    repeat: task.repeat,
    idempotencyKey: key,
    bodyKeys: Object.keys(assembleJobBody(settings, {
      uploadId: '00000000-0000-4000-8000-000000000000',
      idempotencyKey: key,
    })).filter(name => name !== 'uploadId'),
  };
}

async function runBlue(io, client, dir, plan, task) {
  const receipt = task.row.receipt;
  const label = `${receipt} ${task.profile.name} #${task.repeat}`;
  const recordFile = blueRecordPath(dir, receipt, task.profile.name, task.repeat, task.hash);
  try {
    const key = blueKey(dir, task);
    const existing = readJsonOptional(recordFile);
    if (existing?.job && existing.idempotencyKey === key && TERMINAL_JOB.has(existing.job.state)) {
      if (existing.job.state === 'completed') {
        progress(io, `blue ${label} resume local completed`);
        return { ok: true, receipt, profile: task.profile.name, repeat: task.repeat, state: 'completed', resumed: true, jobId: existing.job.id };
      }
      throw new BoothError('booth_job', `${label} already ${existing.job.state}; change the profile to start a new job`);
    }
    const file = pdfPath(dir, receipt);
    const settings = buildBlueRequest({ pdfPath: file, profile: task.profile });
    let job = existing?.job && existing.idempotencyKey === key ? existing.job : null;
    let replayed = false;
    if (!job) {
      const bytes = fs.readFileSync(file);
      const uploaded = await client.json('/v1/ai/uploads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf',
          'X-Falsify-File-Name': encodeURIComponent(`${receipt}.pdf`),
        },
        body: bytes,
      });
      const uploadId = uploaded.upload && uploaded.upload.id;
      const body = assembleJobBody(settings, { uploadId, idempotencyKey: key });
      const created = await client.json('/v1/ai/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      job = created.job;
      replayed = created.replayed === true;
      writeJson(recordFile, {
        idempotencyKey: key,
        profile: task.profile.name,
        repeat: task.repeat,
        configHash: task.hash,
        uploadId,
        request: body,
        replayed,
        job,
      });
    }
    if (!TERMINAL_JOB.has(job.state)) job = await pollJob(io, client, job, plan, recordFile, key, task);
    writeJson(recordFile, {
      ...(readJsonOptional(recordFile) || {}),
      idempotencyKey: key,
      profile: task.profile.name,
      repeat: task.repeat,
      configHash: task.hash,
      replayed,
      job,
    });
    if (job.state !== 'completed') throw new BoothError('booth_job', `${label} ended ${job.state}`);
    progress(io, `blue ${label} ${job.state} job=${job.id}${replayed ? ' replayed' : ''}`);
    return { ok: true, receipt, profile: task.profile.name, repeat: task.repeat, state: job.state, jobId: job.id, replayed, resumed: false };
  } catch (error) {
    const message = error instanceof BoothError ? `${error.code}: ${error.message}` : error.message;
    progress(io, `blue ${label} failed ${message}`);
    return { ok: false, receipt, profile: task.profile.name, repeat: task.repeat, error: message };
  }
}

async function pollJob(io, client, job, plan, recordFile, key, task) {
  const deadline = Date.now() + plan.pollTimeoutMs;
  let current = job;
  while (!TERMINAL_JOB.has(current.state)) {
    if (Date.now() > deadline) throw new BoothError('poll_timeout', `poll timed out for ${current.id}`);
    await delay(plan.pollIntervalMs);
    const data = await client.json(`/v1/ai/jobs/${encodeURIComponent(current.id)}`);
    if (!data.job || typeof data.job !== 'object') throw new BoothError('booth_api', 'job poll returned no job');
    current = data.job;
    const previous = readJsonOptional(recordFile) || {};
    writeJson(recordFile, {
      ...previous,
      idempotencyKey: key,
      profile: task.profile.name,
      repeat: task.repeat,
      configHash: task.hash,
      job: current,
    });
    progress(io, `blue ${task.row.receipt} ${task.profile.name} #${task.repeat} state=${current.state}`);
  }
  return current;
}

function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

export async function score(ctx) {
  const dir = dataDir(ctx);
  const rows = activeRows(localRows(dir, ctx.flags));
  const submissions = rows.map(row => scoreSubmission(row, runsForReceipt(loadBlueRecords(dir, row.receipt))));
  const counts = { caught: 0, missed: 0, partial: 0, invalid: 0 };
  for (const item of submissions) counts[item.suggestedOutcome] = (counts[item.suggestedOutcome] || 0) + 1;
  const report = { generatedAt: new Date().toISOString(), counts, submissions };
  const file = path.join(dir, 'score.json');
  writeJson(file, report);
  progress(ctx.io, `score wrote ${file}; not published`);
  print(ctx.io, { file, counts, submissions: submissions.length });
}

export async function judge(ctx) {
  const dir = dataDir(ctx);
  const scoreFile = path.join(dir, 'score.json');
  const report = readJsonOptional(scoreFile);
  if (!report) throw new BoothError('booth_local', 'score.json is missing; run score first');
  const only = receiptSet(ctx.flags);
  const forced = ctx.flags.outcome && ctx.flags.outcome !== true ? String(ctx.flags.outcome) : '';
  if (forced && !OUTCOMES.includes(forced)) throw new BoothError('booth_config', `unknown outcome ${forced}`);
  const client = ctx.flags.dryRun === true ? null : clientFor(ctx);
  const live = client ? await listPages(client, {}) : { submissions: [] };
  const withdrawn = new Set(live.submissions.filter(row => row.status === 'withdrawn').map(row => row.receipt));
  const actions = [];
  for (const item of report.submissions || []) {
    if (only && !only.has(item.receipt)) continue;
    if (withdrawn.has(item.receipt)) continue;
    const outcome = forced || item.suggestedOutcome;
    if (!OUTCOMES.includes(outcome)) throw new BoothError('booth_local', `${item.receipt} has no suggested outcome`);
    const body = { status: 'judged', outcome, aiSummary: compactSummary(item, outcome) };
    actions.push({ receipt: item.receipt, body });
  }
  if (ctx.flags.dryRun === true) {
    progress(ctx.io, `dry-run judge ${actions.length} submission(s)`);
    print(ctx.io, { dryRun: true, actions });
    return;
  }
  for (const action of actions) {
    const view = await client.json(`/v1/booth/admin/submissions/${encodeURIComponent(action.receipt)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action.body),
    });
    progress(ctx.io, `judge ${action.receipt} outcome=${view.outcome} published=${view.published === true}`);
  }
  print(ctx.io, { judged: actions.length });
}

function compactSummary(item, outcome) {
  const summary = {
    suggestedOutcome: outcome,
    edits: (item.edits || []).map(edit => ({ index: edit.index, pageIndex: edit.pageIndex, verdict: edit.verdict })),
  };
  const bytes = Buffer.byteLength(JSON.stringify(summary));
  if (bytes > 16000) throw new BoothError('booth_local', 'aiSummary exceeds 16 KiB');
  return summary;
}

export async function publish(ctx) {
  await patchPublication(ctx, true);
}

export async function unpublish(ctx) {
  await patchPublication(ctx, false);
}

async function patchPublication(ctx, published) {
  const only = receiptSet(ctx.flags);
  const statuses = statusSet(ctx.flags, published ? ['judged'] : null);
  const note = textFlag(ctx.flags.publicNote, 'publicNote', 1000);
  const prize = textFlag(ctx.flags.prize, 'prizeMessage', 500);
  if (ctx.flags.dryRun === true) {
    progress(ctx.io, `dry-run ${published ? 'publish' : 'unpublish'}`);
    print(ctx.io, {
      dryRun: true,
      published,
      status: statuses ? [...statuses] : null,
      only: only ? [...only] : null,
      publicNote: note,
      prizeMessage: prize,
    });
    return;
  }
  const client = clientFor(ctx);
  const { submissions } = await listPages(client, { status: statuses ? [...statuses].join(',') : undefined, limit: 200 });
  let changed = 0;
  for (const row of submissions) {
    if (row.status === 'withdrawn') continue;
    if (!selected(row, { only, statuses, outcomes: null })) continue;
    if (!published && row.published !== true && !only) continue;
    const body = { published };
    if (published && note != null) body.publicNote = note;
    if (published && prize != null) body.prizeMessage = prize;
    await client.json(`/v1/booth/admin/submissions/${encodeURIComponent(row.receipt)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    changed += 1;
    progress(ctx.io, `${published ? 'publish' : 'unpublish'} ${row.receipt}`);
  }
  print(ctx.io, { published, changed });
}

function textFlag(value, label, max) {
  if (value == null || value === true) return null;
  const text = String(value);
  if (text.length > max) throw new BoothError('booth_config', `${label} is longer than ${max}`);
  return text;
}

export async function draw(ctx) {
  const count = ctx.flags.count !== undefined && ctx.flags.count !== true ? Number(ctx.flags.count) : 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new BoothError('booth_config', 'count must be an integer from 1 to 1000');
  const only = receiptSet(ctx.flags);
  const statuses = statusSet(ctx.flags, ['judged']);
  const outcomes = outcomeSet(ctx.flags.outcome || 'missed');
  const prize = textFlag(ctx.flags.prize, 'prizeMessage', 500);
  const client = clientFor(ctx);
  const { submissions } = await listPages(client, { status: [...statuses].join(','), limit: 200 });
  const pool = submissions.filter(row => row.status !== 'withdrawn' && selected(row, { only, statuses, outcomes }));
  const winners = drawWinners(pool, count).map(row => ({ receipt: row.receipt, seq: row.seq, outcome: row.outcome }));
  const record = {
    createdAt: new Date().toISOString(),
    requested: count,
    filter: { status: [...statuses], outcome: [...outcomes], only: only ? [...only] : null },
    prize: prize || '',
    winners,
  };
  if (ctx.flags.dryRun === true) {
    progress(ctx.io, `dry-run draw ${winners.length} winner(s); no file and no PATCH`);
    print(ctx.io, { dryRun: true, ...record });
    return;
  }
  const dir = dataDir(ctx);
  const stamp = record.createdAt.replace(/[:.]/g, '-');
  const file = path.join(dir, 'draws', `${stamp}.json`);
  writeJson(file, record);
  if (prize) {
    for (const winner of winners) {
      await client.json(`/v1/booth/admin/submissions/${encodeURIComponent(winner.receipt)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prizeMessage: prize }),
      });
      progress(ctx.io, `draw prize ${winner.receipt}`);
    }
  }
  progress(ctx.io, `draw wrote ${file}`);
  print(ctx.io, { file, winners: winners.length, requested: count });
}

export async function exportCommand(ctx) {
  const format = ctx.flags.format;
  if (!['common', 'score', 'key', 'jsonl'].includes(format)) {
    throw new BoothError('booth_config', 'export --format is common, score, key or jsonl');
  }
  const dir = dataDir(ctx);
  const tables = { common: [], score: [], key: [], jsonl: [] };
  for (const row of activeRows(localRows(dir, ctx.flags))) {
    const runs = runsForReceipt(loadBlueRecords(dir, row.receipt));
    tables.common.push(...commonRows(row, runs));
    tables.score.push(...scoreRows(row, runs));
    tables.key.push(...keyRows(row));
    tables.jsonl.push(...jsonlRows(row, runs));
  }
  const body = renderExport(format, tables);
  const ext = format === 'jsonl' ? 'jsonl' : 'csv';
  const file = ctx.flags.out && ctx.flags.out !== true
    ? path.resolve(String(ctx.flags.out))
    : path.join(dir, 'exports', `${format}.${ext}`);
  writeAtomic(file, body);
  const rows = format === 'common' ? tables.common.length
    : format === 'score' ? tables.score.length
      : format === 'key' ? tables.key.length
        : tables.jsonl.length;
  progress(ctx.io, `export ${format} rows=${rows} file=${file}`);
  print(ctx.io, { file, format, rows });
}

export async function missions(ctx) {
  const client = clientFor(ctx);
  const sub = ctx.rest[0];
  if (sub === 'get') {
    const settings = await client.json('/v1/booth/admin/settings');
    const body = `${JSON.stringify(settings.missions || [], null, 2)}\n`;
    if (ctx.flags.out && ctx.flags.out !== true) {
      writeAtomic(path.resolve(String(ctx.flags.out)), body);
      print(ctx.io, { file: path.resolve(String(ctx.flags.out)), missions: (settings.missions || []).length });
      return;
    }
    ctx.io.stdout.write(body);
    return;
  }
  if (sub === 'set') {
    const file = ctx.rest[1];
    if (!file) throw new BoothError('booth_config', 'missions set needs a file');
    let missionsValue;
    try {
      missionsValue = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new BoothError('booth_config', `cannot parse missions: ${error.message}`);
    }
    validateMissions(missionsValue);
    const settings = await client.json('/v1/booth/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ missions: missionsValue }),
    });
    print(ctx.io, settings);
    return;
  }
  if (sub === 'warm') {
    await warmMissions(ctx, client);
    return;
  }
  throw new BoothError('booth_config', 'missions needs get, set or warm');
}

async function warmMissions(ctx, client) {
  const settings = await client.json('/v1/booth/admin/settings');
  const configured = Array.isArray(settings.missions) ? settings.missions : [];
  const missions = [];
  const failures = [];
  for (const mission of configured) {
    const id = mission && typeof mission.id === 'string' ? mission.id : '';
    const paperId = mission && typeof mission.paperId === 'string' ? mission.paperId : '';
    if (!paperId) {
      failures.push({ id, paperId, code: 'booth_config' });
      progress(ctx.io, `warm ${id || '(missing id)'} failed booth_config`);
      continue;
    }
    try {
      const bytes = await client.bytes(`/v1/papers/pdf?id=${encodeURIComponent(paperId)}`);
      missions.push({ id, paperId, bytes: bytes.length, sha256: sha256Hex(bytes) });
      progress(ctx.io, `warm ${id} paper=${paperId} bytes=${bytes.length}`);
    } catch (error) {
      const code = error instanceof BoothError ? error.code : 'booth_api';
      failures.push({ id, paperId, code });
      progress(ctx.io, `warm ${id} paper=${paperId} failed ${code}`);
    }
  }
  print(ctx.io, { missions, failures });
  if (failures.length) {
    throw new BoothError('booth_api', `${failures.length} of ${configured.length} mission PDF(s) failed`, { exitCode: 2 });
  }
}

function validateMissions(value) {
  if (!Array.isArray(value) || value.length > 20) throw new BoothError('booth_config', 'missions must be an array of at most 20');
  for (const mission of value) {
    if (!mission || typeof mission !== 'object' || Array.isArray(mission)) throw new BoothError('booth_config', 'mission must be an object');
    const keys = ['id', 'title', 'source', 'paperId', 'license', 'course', 'hint'];
    const extra = Object.keys(mission).filter(key => !keys.includes(key));
    if (extra.length) throw new BoothError('booth_config', `mission has unknown keys: ${extra.join(', ')}`);
    if (typeof mission.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(mission.id)) {
      throw new BoothError('booth_config', 'mission id must be a slug of at most 40 chars');
    }
    if (typeof mission.title !== 'string' || mission.title.length < 1 || mission.title.length > 300) {
      throw new BoothError('booth_config', 'mission title length');
    }
    if (mission.source !== 'arxiv') throw new BoothError('booth_config', 'mission source must be arxiv');
    if (typeof mission.paperId !== 'string' || !mission.paperId || mission.paperId.length > 64) {
      throw new BoothError('booth_config', 'mission paperId length');
    }
    if (typeof mission.license !== 'string' || mission.license.length > 40) throw new BoothError('booth_config', 'mission license length');
    if (!['quick', 'deep', 'any'].includes(mission.course)) throw new BoothError('booth_config', 'mission course');
    if (mission.hint !== undefined && (typeof mission.hint !== 'string' || mission.hint.length > 300)) {
      throw new BoothError('booth_config', 'mission hint length');
    }
  }
}

export async function openBooth(ctx) {
  await putOpen(ctx, true);
}

export async function closeBooth(ctx) {
  if (ctx.flags.dryRun === true) {
    progress(ctx.io, 'dry-run close');
    print(ctx.io, { dryRun: true, submissionsOpen: false });
    return;
  }
  await putOpen(ctx, false);
}

async function putOpen(ctx, submissionsOpen) {
  const client = clientFor(ctx);
  const settings = await client.json('/v1/booth/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submissionsOpen }),
  });
  progress(ctx.io, `submissionsOpen=${settings.submissionsOpen}`);
  print(ctx.io, settings);
}

export async function announce(ctx) {
  let announcement = null;
  if (ctx.flags.clear === true) announcement = null;
  else if (typeof ctx.flags.text === 'string') announcement = ctx.flags.text;
  else if (typeof ctx.flags.file === 'string') announcement = fs.readFileSync(ctx.flags.file, 'utf8').trim();
  else throw new BoothError('booth_config', 'announce needs --text, --file or --clear');
  if (announcement != null) {
    if (announcement.length > 300) throw new BoothError('booth_config', 'announcement is longer than 300');
    if (/[\u0000-\u001f]/.test(announcement)) throw new BoothError('booth_config', 'announcement has control characters');
  }
  const client = clientFor(ctx);
  const settings = await client.json('/v1/booth/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ announcement }),
  });
  print(ctx.io, settings);
}
