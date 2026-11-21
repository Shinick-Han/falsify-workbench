import fs from 'node:fs';
import path from 'node:path';

import { configHash } from './blue.mjs';
import {
  archiveSubmission, assertClosedUnlessAllowed, blueMaxBytes, clientFor, compactSummary, dataDir,
  forgetWithdrawn, listPages, progress, receiptSet, runBlue,
} from './commands.mjs';
import { integer, resolveBluePlan } from './config.mjs';
import { TERMINAL_JOB } from './constants.mjs';
import { assistOf, recipeCodeOf } from './export.mjs';
import { BoothError } from './errors.mjs';
import { runsForReceipt } from './findings.mjs';
import { buildPublicNote, clip, notePage } from './note.mjs';
import { mapPool } from './pool.mjs';
import { bestMatchedFinding, scoreSubmission } from './score.mjs';
import { blueRecordPath, readJsonOptional, writeJson } from './store.mjs';

const MISSING_PDF = new Set(['not_found', 'artifact_expired']);

function line(io, value) {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

function codeOf(error) {
  return error instanceof BoothError ? error.code : 'booth_internal';
}

function isWithdrawn(error) {
  return error instanceof BoothError && (error.status === 409 || error.code === 'withdrawn');
}

function markerPath(dir, receipt) {
  return path.join(dir, 'live', `${receipt}.json`);
}

export function readMarker(dir, receipt) {
  return readJsonOptional(markerPath(dir, receipt));
}

function writeMarker(dir, receipt, patch) {
  const next = { ...(readMarker(dir, receipt) || {}), receipt, ...patch, updatedAt: new Date().toISOString() };
  writeJson(markerPath(dir, receipt), next);
  return next;
}

function patchRow(client, receipt, body) {
  return client.json(`/v1/booth/admin/submissions/${encodeURIComponent(receipt)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function flagInt(flags, key, label, min, max, fallback) {
  if (flags[key] === undefined || flags[key] === true) return fallback;
  return integer(flags[key], label, min, max);
}

// One BLUE profile resolved like `blue --profile <name>`, so flags such as --model still override.
function liveEnv(ctx, profileName) {
  const plan = resolveBluePlan(ctx.config, { ...ctx.flags, profile: profileName });
  const profile = plan.profiles[0];
  return {
    io: ctx.io,
    client: clientFor(ctx),
    dir: dataDir(ctx),
    live: ctx.config.live,
    run: { plan, profile, hash: configHash(profile), maxBytes: blueMaxBytes(ctx.flags) },
  };
}

function recordFile(env, receipt, repeat) {
  return blueRecordPath(env.dir, receipt, env.run.profile.name, repeat, env.run.hash);
}

// A retry after a job that ended failed needs a new key, so it takes the next repeat index.
// A completed or unfinished record keeps its index, so a restart resumes and never bills twice.
function pickRepeat(env, receipt) {
  for (let repeat = 0; repeat <= env.live.retries; repeat += 1) {
    const state = readJsonOptional(recordFile(env, receipt, repeat))?.job?.state;
    if (!state || !TERMINAL_JOB.has(state) || state === 'completed') return repeat;
  }
  return -1;
}

async function attemptBlue(env, row) {
  const pulled = await archiveSubmission(env.io, env.client, env.dir, row);
  if (pulled === 'withdrawn') return { skip: 'withdrawn' };
  const repeat = pickRepeat(env, row.receipt);
  if (repeat < 0) return { error: 'booth_job' };
  const { plan, profile, hash, maxBytes } = env.run;
  const result = await runBlue(env.io, env.client, env.dir, plan, { row, profile, repeat, hash, maxBytes });
  if (!result.ok) return { error: result.code || 'booth_job' };
  return { record: readJsonOptional(recordFile(env, row.receipt, repeat)) };
}

// Up to live.retries more tries with doubling backoff. A missing PDF or a withdrawal is not retried.
async function blueWithRetry(env, row) {
  let last = 'booth_job';
  for (let attempt = 0; attempt <= env.live.retries; attempt += 1) {
    if (attempt) await delay(env.live.retryBackoffMs * (2 ** (attempt - 1)));
    let outcome;
    try {
      outcome = await attemptBlue(env, row);
    } catch (error) {
      if (error instanceof BoothError && MISSING_PDF.has(error.code)) return { skip: 'no_pdf' };
      outcome = { error: codeOf(error) };
    }
    if (!outcome.error) return outcome;
    // No free server slot for pollTimeoutMs is a full queue, not a failed row: no retry budget is spent here.
    if (outcome.error === 'slot_busy') return { busy: true };
    last = outcome.error;
    progress(env.io, `live ${row.receipt} attempt ${attempt + 1} failed ${last}`);
  }
  return { failed: last };
}

function verdictFor(row, record) {
  const runs = runsForReceipt([record]);
  const scored = scoreSubmission(row, runs);
  const best = bestMatchedFinding(row, runs);
  return {
    scored,
    outcome: scored.suggestedOutcome,
    matched: best ? best.finding : null,
    quote: best ? best.match.quote : '',
    first: runs.length ? runs[0].finding : null,
    model: record?.job?.model || '',
    jobId: record?.job?.id || '',
    findings: runs.length,
  };
}

function summaryFor(verdict, round, liveOutcome, profileName) {
  const summary = compactSummary(verdict.scored, verdict.outcome);
  return {
    ...summary,
    round,
    liveOutcome,
    profile: profileName,
    model: verdict.model,
    jobId: verdict.jobId,
    findings: verdict.findings,
    quote: verdict.quote,
  };
}

function judgedBody(env, verdict, { round, liveOutcome, prize }) {
  const body = {
    status: 'judged',
    outcome: verdict.outcome,
    publicNote: buildPublicNote({ ...verdict, templates: env.live.publicNote }),
    aiSummary: summaryFor(verdict, round, liveOutcome, env.run.profile.name),
    published: true,
  };
  if (verdict.outcome === 'missed' && prize) body.prizeMessage = prize;
  return body;
}

function skipWithdrawn(env, row) {
  forgetWithdrawn(env.io, env.dir, row);
  fs.rmSync(markerPath(env.dir, row.receipt), { force: true });
  progress(env.io, `live ${row.receipt} skipped withdrawn`);
  return { state: 'skipped', receipt: row.receipt, reason: 'withdrawn' };
}

async function noteOnRow(env, receipt, operatorNote) {
  try {
    await patchRow(env.client, receipt, { operatorNote });
  } catch (error) {
    progress(env.io, `live ${receipt} operatorNote not saved ${codeOf(error)}`);
  }
}

async function skipMissing(env, row) {
  writeMarker(env.dir, row.receipt, { state: 'skipped', code: 'no_pdf' });
  await noteOnRow(env, row.receipt, 'live: skipped no_pdf');
  progress(env.io, `live ${row.receipt} skipped missing PDF`);
  return { state: 'skipped', receipt: row.receipt, reason: 'no_pdf' };
}

async function failRow(env, row, code) {
  writeMarker(env.dir, row.receipt, { state: 'failed', code });
  await noteOnRow(env, row.receipt, `live: failed ${code}`);
  progress(env.io, `live ${row.receipt} FAILED ${code}; left reviewing`);
  return { state: 'failed', receipt: row.receipt, code };
}

async function startReview(env, row) {
  writeMarker(env.dir, row.receipt, { state: 'running', receivedAt: row.createdAt, startedAt: new Date().toISOString() });
  if (row.status === 'reviewing') return true;
  try {
    await patchRow(env.client, row.receipt, { status: 'reviewing' });
  } catch (error) {
    if (isWithdrawn(error)) return false;
    throw error;
  }
  progress(env.io, `live ${row.receipt} reviewing`);
  return true;
}

function latencySec(row, view) {
  const start = Date.parse(row.createdAt);
  const end = Date.parse(view?.publishedAt || '') || Date.now();
  return Number.isFinite(start) ? Math.max(0, (end - start) / 1000) : null;
}

// received -> reviewing -> BLUE -> score -> judged + published, in one PATCH at the end.
async function liveJob(env, row) {
  if (!(await startReview(env, row))) return skipWithdrawn(env, row);
  const blue = await blueWithRetry(env, { ...row, status: 'reviewing' });
  if (blue.skip === 'withdrawn') return skipWithdrawn(env, row);
  if (blue.skip) return skipMissing(env, row);
  if (blue.busy) {
    // The running marker stays, so the next list cycle picks the row up again (reviewing + running).
    progress(env.io, `live ${row.receipt} still waiting for a job slot; next cycle retries`);
    return { state: 'error', receipt: row.receipt, code: 'slot_busy' };
  }
  if (blue.failed) return failRow(env, row, blue.failed);
  const verdict = verdictFor(row, blue.record);
  const body = judgedBody(env, verdict, { round: 'live', liveOutcome: verdict.outcome, prize: env.live.prizeMessage });
  let view;
  try {
    view = await patchRow(env.client, row.receipt, body);
  } catch (error) {
    if (isWithdrawn(error)) return skipWithdrawn(env, row);
    throw error;
  }
  writeMarker(env.dir, row.receipt, { state: 'done', outcome: verdict.outcome, publishedAt: view?.publishedAt || null });
  progress(env.io, `live ${row.receipt} judged outcome=${verdict.outcome} published`);
  return { state: 'done', receipt: row.receipt, outcome: verdict.outcome, latencySec: latencySec(row, view) };
}

async function safeLiveJob(env, row) {
  try {
    return await liveJob(env, row);
  } catch (error) {
    progress(env.io, `live ${row.receipt} error ${codeOf(error)}; retry next cycle`);
    return { state: 'error', receipt: row.receipt, code: codeOf(error) };
  }
}

function createScheduler(limit, runJob, onResult) {
  const queue = [];
  const active = new Map();
  const seen = new Set();
  function pump() {
    while (active.size < limit && queue.length) {
      const row = queue.shift();
      const job = runJob(row).then(result => {
        active.delete(row.receipt);
        if (result.state === 'error') seen.delete(row.receipt);
        onResult(result);
        pump();
      });
      active.set(row.receipt, job);
    }
  }
  return {
    enqueue(rows) {
      for (const row of rows) {
        if (seen.has(row.receipt)) continue;
        seen.add(row.receipt);
        queue.push(row);
      }
      pump();
    },
    get queued() { return queue.length; },
    get inFlight() { return active.size; },
    async drain() {
      while (active.size) await Promise.all([...active.values()]);
    },
  };
}

// received rows, plus reviewing rows this tool started and did not finish (restart resume).
async function liveCandidates(env) {
  const { submissions } = await listPages(env.client, { status: 'received,reviewing', limit: 200 });
  return submissions.filter(row => {
    if (row.status === 'received') return true;
    return row.status === 'reviewing' && readMarker(env.dir, row.receipt)?.state === 'running';
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(1));
}

function cycleLine(type, cycle, scheduler, stats) {
  const sorted = stats.latencies.slice().sort((a, b) => a - b);
  return {
    type,
    at: new Date().toISOString(),
    cycle,
    queued: scheduler.queued,
    inFlight: scheduler.inFlight,
    done: stats.done,
    failed: stats.failed.length,
    skipped: stats.skipped,
    failedReceipts: stats.failed.slice(),
    p50Sec: percentile(sorted, 50),
    p95Sec: percentile(sorted, 95),
  };
}

function recordResult(stats, result) {
  if (result.state === 'done') {
    stats.done += 1;
    if (result.latencySec != null) stats.latencies.push(result.latencySec);
  } else if (result.state === 'failed') {
    stats.failed.push({ receipt: result.receipt, code: result.code });
  } else if (result.state === 'skipped') {
    stats.skipped += 1;
  }
}

function installStop() {
  let stopped = false;
  let wake = () => {};
  const onSignal = () => {
    stopped = true;
    wake();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return {
    get stopped() { return stopped; },
    sleep(ms) {
      return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
    dispose() {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

async function listCycle(env, scheduler) {
  try {
    scheduler.enqueue(await liveCandidates(env));
  } catch (error) {
    progress(env.io, `watch list failed ${codeOf(error)}; next cycle retries`);
  }
}

export async function watch(ctx) {
  const env = liveEnv(ctx, ctx.config.live.liveProfile);
  const intervalMs = flagInt(ctx.flags, 'interval', 'interval', 1, 3600, env.live.intervalSec) * 1000;
  const concurrency = flagInt(ctx.flags, 'concurrency', 'concurrency', 1, 256, env.live.concurrency);
  const cycles = flagInt(ctx.flags, 'cycles', 'cycles', 1, Number.MAX_SAFE_INTEGER, Infinity);
  const stats = { done: 0, failed: [], skipped: 0, latencies: [] };
  const scheduler = createScheduler(concurrency, row => safeLiveJob(env, row), result => recordResult(stats, result));
  const stop = installStop();
  progress(env.io, `watch profile=${env.run.profile.name} concurrency=${concurrency} interval=${intervalMs / 1000}s`);
  let cycle = 0;
  while (cycle < cycles && !stop.stopped) {
    cycle += 1;
    await listCycle(env, scheduler);
    line(env.io, cycleLine('cycle', cycle, scheduler, stats));
    if (cycle < cycles) await stop.sleep(intervalMs);
  }
  stop.dispose();
  if (stop.stopped) {
    line(env.io, cycleLine('stopped', cycle, scheduler, stats));
    progress(env.io, `watch stopped; ${scheduler.inFlight} in-flight job(s) resume on the next start`);
    (ctx.exit || (code => process.exit(code)))(130);
    return;
  }
  await scheduler.drain();
  line(env.io, cycleLine('end', cycle, scheduler, stats));
}

function parseSummary(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function liveOutcomeOf(dir, row) {
  return parseSummary(row.aiSummary)?.liveOutcome || readMarker(dir, row.receipt)?.outcome || row.outcome || null;
}

// Candidates carry assist so the operator sees AI-planted (my-ai, agent) entries; all are equally eligible.
async function finalOne(env, row) {
  const liveVerdict = liveOutcomeOf(env.dir, row);
  const who = { receipt: row.receipt, assist: assistOf(row), recipeCode: recipeCodeOf(row) };
  const blue = await blueWithRetry(env, row);
  if (blue.skip || blue.failed || blue.busy) {
    return { ...who, liveVerdict, finalVerdict: null, error: blue.skip || blue.failed || 'slot_busy' };
  }
  const verdict = verdictFor(row, blue.record);
  progress(env.io, `final ${row.receipt} live=${liveVerdict} final=${verdict.outcome}`);
  const bestQuote = verdict.quote || clip(verdict.first?.quote || '', 240);
  return { ...who, liveVerdict, finalVerdict: verdict.outcome, bestQuote, verdict };
}

async function applyFinal(env, item) {
  const prize = env.live.finalPrizeMessage || env.live.prizeMessage;
  const body = judgedBody(env, item.verdict, { round: 'final', liveOutcome: item.liveVerdict, prize });
  // Missed live, found in the final round: the instant prize stays valid, so the message says so.
  if (item.verdict.outcome !== 'missed') body.prizeMessage = env.live.finalCaughtMessage;
  try {
    await patchRow(env.client, item.receipt, body);
  } catch (error) {
    if (isWithdrawn(error)) {
      progress(env.io, `final ${item.receipt} skipped withdrawn`);
      return false;
    }
    throw error;
  }
  progress(env.io, `final ${item.receipt} applied outcome=${item.verdict.outcome}`);
  return true;
}

function candidatesFile(ctx, dir) {
  if (ctx.flags.out && ctx.flags.out !== true) return path.resolve(String(ctx.flags.out));
  return path.join(dir, 'final', 'candidates.json');
}

// Judged rows the live round missed get the final profile. Candidates go to a local file; --apply PATCHes.
export async function finalCommand(ctx) {
  await assertClosedUnlessAllowed(ctx);
  const env = liveEnv(ctx, ctx.flags.profile && ctx.flags.profile !== true ? String(ctx.flags.profile) : ctx.config.live.finalProfile);
  const only = receiptSet(ctx.flags);
  const concurrency = flagInt(ctx.flags, 'concurrency', 'concurrency', 1, 256, env.live.concurrency);
  const { submissions } = await listPages(env.client, { status: 'judged', limit: 200 });
  const rows = submissions.filter(row => (!only || only.has(row.receipt)) && liveOutcomeOf(env.dir, row) === 'missed');
  const results = await mapPool(rows, concurrency, row => finalOne(env, row));
  const apply = ctx.flags.apply === true;
  let applied = 0;
  if (apply) {
    for (const item of results) {
      if (item.verdict && (await applyFinal(env, item))) applied += 1;
    }
  }
  const candidates = results.map(({ verdict, ...item }) => ({ ...item, page: verdict ? verdictPage(verdict) : null }));
  const file = candidatesFile(ctx, env.dir);
  writeJson(file, { generatedAt: new Date().toISOString(), profile: env.run.profile.name, applied: apply, candidates });
  const stillMissed = candidates.filter(item => item.finalVerdict === 'missed').length;
  progress(env.io, `final wrote ${file}${apply ? '' : '; not published (pass --apply)'}`);
  env.io.stdout.write(`${JSON.stringify({ file, candidates: candidates.length, stillMissed, failed: candidates.filter(item => item.error).length, applied }, null, 2)}\n`);
}

function verdictPage(verdict) {
  const finding = verdict.outcome === 'missed' ? (verdict.matched || verdict.first) : verdict.matched;
  const page = finding ? notePage(finding) : '';
  return page === '' ? null : page;
}
