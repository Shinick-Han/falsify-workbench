import fs from 'node:fs';
import path from 'node:path';

import { configHash, idempotencyKey } from './blue.mjs';
import {
  archiveSubmission, assertClosedUnlessAllowed, blueMaxBytes, clientFor, compactSummary, dataDir,
  forgetWithdrawn, listPages, progress, receiptSet, recordFailure, resumeJobRecord, runBlue,
  SLOT_QUEUE_RETRY_MAX,
} from './commands.mjs';
import { integer, resolveBluePlan } from './config.mjs';
import { TERMINAL_JOB } from './constants.mjs';
import { assistOf, recipeCodeOf } from './export.mjs';
import { BoothError } from './errors.mjs';
import { runsForReceipt } from './findings.mjs';
import { buildPublicNote, clip, notePage } from './note.mjs';
import { mapPool } from './pool.mjs';
import { bestMatchedFinding, scoreSubmission } from './score.mjs';
import { blueRecordPath, listBlueRecordsForHash, listLiveMarkers, pdfPath, readJsonOptional, writeJson } from './store.mjs';

const MISSING_PDF = new Set(['not_found', 'artifact_expired']);
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_REPLAY_SKIPS = 20;
const MAX_RETRY_BACKOFF_MS = 60_000;

function retryDelayMs(baseMs, retryNumber, retryAfterSec = 0) {
  const base = Math.max(0, Number(baseMs) || 0);
  const exp = Math.min(MAX_RETRY_BACKOFF_MS, base * (2 ** Math.max(0, retryNumber - 1)));
  const serverMs = retryAfterSec > 0 ? Math.min(MAX_RETRY_BACKOFF_MS, retryAfterSec * 1000) : 0;
  return Math.max(exp, serverMs);
}

function line(io, value) {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

function codeOf(error) {
  return error instanceof BoothError ? error.code : 'booth_internal';
}

function failureOf(error) {
  if (error instanceof BoothError && error.failure) {
    return {
      ...error.failure,
      code: error.failure.code || error.code,
      retryable: typeof error.failure.retryable === 'boolean' ? error.failure.retryable : error.retryable === true,
    };
  }
  const code = codeOf(error);
  const retryable = error instanceof BoothError && typeof error.retryable === 'boolean' ? error.retryable : false;
  return {
    code,
    retryable,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof BoothError && error.retryAfter > 0 ? { retryAfter: error.retryAfter } : {}),
  };
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

async function fetchSubmission(client, receipt) {
  try {
    return await client.json(`/v1/booth/admin/submissions/${encodeURIComponent(receipt)}`);
  } catch (error) {
    if (error instanceof BoothError && (error.status === 404 || error.code === 'not_found')) return null;
    throw error;
  }
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

function expectedKey(env, row, repeat) {
  if (typeof row?.pdfSha256 !== 'string' || !HEX64.test(row.pdfSha256)) return null;
  return idempotencyKey({
    receipt: row.receipt,
    profileName: env.run.profile.name,
    repeatIndex: repeat,
    configHash: env.run.hash,
    pdfSha256: row.pdfSha256,
  });
}

function savedMarkerTicket(env, row) {
  const marker = readMarker(env.dir, row.receipt);
  if (!marker?.jobId || typeof marker.profile !== 'string' || !HEX64.test(marker.configHash || '')) return null;
  if (!Number.isSafeInteger(marker.repeat) || marker.repeat < 0) return null;
  let file;
  try {
    file = blueRecordPath(env.dir, row.receipt, marker.profile, marker.repeat, marker.configHash);
  } catch {
    return null;
  }
  const record = readJsonOptional(file);
  if (!record?.job?.id || record.job.id !== marker.jobId) return null;
  // Ignore a saved job ticket for a different PDF hash.
  if (typeof row?.pdfSha256 === 'string' && HEX64.test(row.pdfSha256)) {
    const key = idempotencyKey({
      receipt: row.receipt,
      profileName: marker.profile,
      repeatIndex: marker.repeat,
      configHash: marker.configHash,
      pdfSha256: row.pdfSha256,
    });
    if (record.idempotencyKey !== key) return null;
  }
  return { marker, file, record, repeat: marker.repeat };
}

function isValidCompletedRecord(record) {
  return record?.job?.state === 'completed' && !reviewResultIssue(record);
}

function terminalRecordFailure(record) {
  if (record?.job?.state === 'completed') return reviewResultFailure(record);
  return recordFailure(record);
}

// Inspects saved local records for this receipt without mutating disk or calling the server.
// Only valid completed records and unfinished job tickets win over starting a new job.
export function inspectReceiptPlan(env, row) {
  const marker = readMarker(env.dir, row.receipt);
  const ticket = savedMarkerTicket(env, row);
  if (ticket) {
    const state = ticket.record.job.state;
    if (isValidCompletedRecord(ticket.record) && (ticket.record.configHash === env.run.hash || marker?.state === 'running' || marker?.state === 'recovering')) {
      return { kind: 'completed', repeat: ticket.repeat, record: ticket.record, recordFile: ticket.file, fromMarker: true };
    }
    if (!TERMINAL_JOB.has(state)) {
      return { kind: 'resume_job', repeat: ticket.repeat, record: ticket.record, recordFile: ticket.file, fromMarker: true };
    }
  }
  const all = listBlueRecordsForHash(env.dir, row.receipt, env.run.profile.name, env.run.hash);
  const matching = all.filter(entry => {
    const key = expectedKey(env, row, entry.repeat);
    return !key || entry.record.idempotencyKey === key;
  });
  const completed = matching.find(entry => isValidCompletedRecord(entry.record));
  if (completed) {
    return { kind: 'completed', repeat: completed.repeat, record: completed.record, recordFile: completed.file, fromMarker: false };
  }
  const unfinished = matching.find(entry => entry.record?.job?.id && !TERMINAL_JOB.has(entry.record.job.state));
  if (unfinished) {
    return { kind: 'resume_job', repeat: unfinished.repeat, record: unfinished.record, recordFile: unfinished.file, fromMarker: false };
  }
  const terminal = matching.filter(entry => entry.record?.job && TERMINAL_JOB.has(entry.record.job.state));
  const last = terminal.at(-1) || null;
  const ticketFailure = ticket && TERMINAL_JOB.has(ticket.record.job.state)
    ? terminalRecordFailure(ticket.record)
    : null;
  const lastFailure = last
    ? terminalRecordFailure(last.record)
    : (ticketFailure || marker?.failure || (marker?.code ? { code: marker.code, retryable: marker.retryable === true, message: marker.message || marker.code } : null));
  const nextRepeat = terminal.length ? terminal.at(-1).repeat + 1 : 0;
  return {
    kind: 'terminal_only',
    attempts: terminal.length,
    last,
    lastFailure,
    nextRepeat,
    nextIdempotencyKey: expectedKey(env, row, nextRepeat),
  };
}

function canRetryFailure(failure, retryAfter) {
  if (!failure || failure.retryable !== true) return false;
  const wait = retryAfter || failure.retryAfter || 0;
  return !(wait > SLOT_QUEUE_RETRY_MAX);
}

function trackJobOnMarker(env, receipt, info) {
  if (!info?.job?.id) return;
  writeMarker(env.dir, receipt, {
    profile: info.profile,
    configHash: info.configHash,
    repeat: info.repeat,
    jobId: info.job.id,
    idempotencyKey: info.idempotencyKey,
  });
}

async function ensurePdfArchived(env, row, maxRetries) {
  let failures = 0;
  for (;;) {
    try {
      const pulled = await archiveSubmission(env.io, env.client, env.dir, row);
      if (pulled === 'withdrawn') return { skip: 'withdrawn' };
      return { ok: true };
    } catch (error) {
      if (isWithdrawn(error)) return { skip: 'withdrawn' };
      if (error instanceof BoothError && MISSING_PDF.has(error.code)) return { skip: 'no_pdf' };
      const failure = failureOf(error);
      const retryAfter = error instanceof BoothError ? error.retryAfter : 0;
      progress(env.io, `live ${row.receipt} pull failed ${failure.code} retryable=${failure.retryable}`);
      if (!canRetryFailure(failure, retryAfter) || failures >= maxRetries) {
        return { failed: failure, repeat: null };
      }
      failures += 1;
      await delay(retryDelayMs(env.live.retryBackoffMs, failures, retryAfter));
    }
  }
}

// Up to maxRetries additional tries with capped doubling backoff for retryable failures only.
// Non-retryable failures and unusable completions stop automatically without creating duplicate paid jobs.
// Unfinished and valid completed job tickets are always resumed by their saved job id; long transient
// polling failures on a saved running job return `delayed` so watch/recover can resume without new jobs.
async function blueWithRetry(env, row, {
  allowNewAfterExhausted = false,
  maxRetries = env.live.retries,
  onJob = null,
} = {}) {
  const { plan, profile, hash, maxBytes } = env.run;
  let pdfArchived = false;
  let retryFailures = 0;
  let replaySkips = 0;

  for (let step = 0; ; step += 1) {
    const inspected = inspectReceiptPlan(env, row);
    if (inspected.kind === 'completed') {
      onJob?.({
        job: inspected.record.job,
        repeat: inspected.repeat,
        idempotencyKey: inspected.record.idempotencyKey,
        profile: inspected.record.profile || profile.name,
        configHash: inspected.record.configHash || hash,
        recordFile: inspected.recordFile,
      });
      progress(env.io, `blue ${row.receipt} ${inspected.record.profile || profile.name} #${inspected.repeat} resume local completed`);
      return { record: inspected.record, repeat: inspected.repeat, jobId: inspected.record.job.id, resumed: true };
    }

    let result;
    let activeRepeat;
    let activeFile;
    if (inspected.kind === 'resume_job') {
      activeRepeat = inspected.repeat;
      activeFile = inspected.recordFile;
      const useDirectResume = (inspected.fromMarker && inspected.record.configHash !== hash)
        || !fs.existsSync(pdfPath(env.dir, row.receipt));
      if (useDirectResume) {
        result = await resumeJobRecord(env.io, env.client, plan, {
          receipt: row.receipt,
          recordFile: inspected.recordFile,
          onJob,
        });
      } else {
        result = await runBlue(env.io, env.client, env.dir, plan, {
          row,
          profile,
          repeat: activeRepeat,
          hash,
          maxBytes,
          onJob,
        });
      }
    } else {
      if (!allowNewAfterExhausted) {
        if (inspected.last && !canRetryFailure(inspected.lastFailure, 0)) {
          return { failed: inspected.lastFailure, repeat: inspected.last.repeat };
        }
        if (inspected.attempts > maxRetries) {
          return {
            failed: inspected.lastFailure || { code: 'booth_job', retryable: false, message: 'retry budget exhausted' },
            repeat: inspected.last?.repeat ?? null,
          };
        }
      }
      if (!pdfArchived) {
        const archived = await ensurePdfArchived(env, row, maxRetries);
        if (!archived.ok) return archived;
        pdfArchived = true;
      }
      activeRepeat = inspected.nextRepeat;
      activeFile = recordFile(env, row.receipt, activeRepeat);
      result = await runBlue(env.io, env.client, env.dir, plan, {
        row,
        profile,
        repeat: activeRepeat,
        hash,
        maxBytes,
        onJob,
      });
    }

    if (result.ok) {
      const record = readJsonOptional(result.recordFile || activeFile);
      const reviewFailure = reviewResultFailure(record);
      if (reviewFailure && allowNewAfterExhausted && result.replayed === true && replaySkips < MAX_REPLAY_SKIPS) {
        replaySkips += 1;
        progress(env.io, `live ${row.receipt} skipped replayed unusable completed repeat #${activeRepeat} (${reviewFailure.code})`);
        continue;
      }
      return {
        record,
        repeat: result.repeat,
        jobId: result.jobId,
        resumed: result.resumed === true,
      };
    }

    // No free server slot for pollTimeoutMs is a full queue, not a failed row: no retry budget is spent here.
    if (result.code === 'slot_busy') return { busy: true };

    // Operator recovery against a fresh host whose local archive lacks prior failed repeats:
    // the server replays old terminal failed jobs for free; advance past them until a fresh key lands.
    if (allowNewAfterExhausted && result.replayed === true && replaySkips < MAX_REPLAY_SKIPS) {
      replaySkips += 1;
      progress(env.io, `live ${row.receipt} skipped replayed terminal repeat #${activeRepeat} (${result.code})`);
      continue;
    }

    const failure = result.failure || { code: result.code || 'booth_job', retryable: result.retryable === true, message: result.error || result.code || 'booth_job' };
    const savedRecord = activeFile ? readJsonOptional(activeFile) : null;
    const savedRunningJob = savedRecord?.job?.id && !TERMINAL_JOB.has(savedRecord.job.state) ? savedRecord.job : null;
    const transientPoll = Boolean(
      savedRunningJob
      && failure.code !== 'poll_timeout'
      && canRetryFailure(failure, result.retryAfter),
    );
    progress(env.io, `live ${row.receipt} attempt ${step + 1} failed ${failure.code} retryable=${failure.retryable}`);
    if (transientPoll) {
      if (retryFailures < maxRetries) {
        retryFailures += 1;
        await delay(retryDelayMs(env.live.retryBackoffMs, retryFailures, result.retryAfter || failure.retryAfter || 0));
        continue;
      }
      return {
        delayed: {
          ...failure,
          retryable: true,
          jobId: savedRunningJob.id,
          jobState: savedRunningJob.state,
        },
        repeat: activeRepeat,
        jobId: savedRunningJob.id,
      };
    }
    if (!canRetryFailure(failure, result.retryAfter) || retryFailures >= maxRetries) {
      return { failed: failure, repeat: activeRepeat };
    }
    if (!allowNewAfterExhausted) {
      const after = inspectReceiptPlan(env, row);
      if (after.kind === 'terminal_only' && after.attempts > maxRetries) {
        return { failed: failure, repeat: activeRepeat };
      }
    }
    retryFailures += 1;
    await delay(retryDelayMs(env.live.retryBackoffMs, retryFailures, result.retryAfter || failure.retryAfter || 0));
  }
}

const MODEL_ABORT_CODES = new Set(['model_abstain', 'model_refusal']);
const STATUS_ISSUES = { refusal: 'review_refusal', abstain: 'review_abstain' };

function reviewCoverageIssue(coverage) {
  if (!coverage || typeof coverage !== 'object') return null;
  if (coverage.complete === false) return 'review_incomplete';
  const statuses = Array.isArray(coverage.batchStatuses) ? coverage.batchStatuses : [];
  if (statuses.some(item => item !== 'ok')) {
    return statuses.includes('refusal') ? 'review_refusal' : 'review_abstain';
  }
  const rejectedItems = coverage.resultCoverage?.rejectedItems;
  if (!Array.isArray(rejectedItems)) return null;
  const modelAbort = rejectedItems.find(item => MODEL_ABORT_CODES.has(item?.code));
  if (!modelAbort) return null;
  return modelAbort.code === 'model_refusal' ? 'review_refusal' : 'review_abstain';
}

// Distinguish a finished, usable BLUE verdict (including a clean 0-finding pass) from an aborted,
// refused, abstained, or incomplete review that must never be auto-scored as missed + prize.
export function reviewResultIssue(record) {
  const job = record?.job;
  if (!job || job.state !== 'completed') return 'review_incomplete';
  const result = job.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'review_missing_result';
  const status = result.status;
  if (Object.hasOwn(STATUS_ISSUES, status)) return STATUS_ISSUES[status];
  if (status !== undefined && status !== 'ok') return 'review_invalid';
  if (!Array.isArray(result.findings) && !Array.isArray(result.items)) return 'review_missing_result';
  return reviewCoverageIssue(result.coverage);
}

export function reviewResultFailure(record) {
  const code = reviewResultIssue(record);
  if (!code) return null;
  const job = record?.job;
  return {
    code,
    retryable: false,
    message: `BLUE result is not eligible for verdict (${code})`,
    ...(job?.id ? { jobId: job.id } : {}),
    ...(job?.state ? { jobState: job.state } : {}),
  };
}

export function verdictFor(row, record) {
  const issue = reviewResultIssue(record);
  if (issue) throw new BoothError(issue, `${row.receipt} BLUE result is not eligible for verdict (${issue})`);
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

function protectedRow(env, row, { receipt, dryRun = false } = {}) {
  const id = row?.receipt || receipt;
  if (!row) {
    if (!dryRun && id) writeMarker(env.dir, id, { state: 'skipped', code: 'not_found' });
    progress(env.io, `live ${id} skipped not_found`);
    return { state: 'skipped', receipt: id, reason: 'not_found' };
  }
  if (row.status === 'withdrawn') {
    if (dryRun) return { state: 'skipped', receipt: row.receipt, reason: 'withdrawn', status: 'withdrawn' };
    return skipWithdrawn(env, row);
  }
  if (row.status === 'judged') {
    if (!dryRun) {
      const current = readMarker(env.dir, row.receipt);
      if (current?.state !== 'done') {
        writeMarker(env.dir, row.receipt, {
          state: 'done',
          outcome: row.outcome || null,
          publishedAt: row.publishedAt || null,
          code: null,
          retryable: null,
          message: null,
          failure: null,
          delayed: false,
          delayedSince: null,
          delayCount: 0,
          lastTransientError: null,
        });
      }
    }
    progress(env.io, `live ${row.receipt} skipped already judged`);
    return {
      state: 'skipped',
      receipt: row.receipt,
      reason: 'already_judged',
      status: 'judged',
      outcome: row.outcome || null,
      published: row.published === true,
    };
  }
  if (row.status === 'invalid') {
    if (!dryRun) writeMarker(env.dir, row.receipt, { state: 'skipped', code: 'invalid' });
    progress(env.io, `live ${row.receipt} skipped invalid`);
    return { state: 'skipped', receipt: row.receipt, reason: 'invalid', status: 'invalid' };
  }
  return null;
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

async function failRow(env, row, failure, repeat = null) {
  const prior = readMarker(env.dir, row.receipt);
  const code = failure?.code || 'booth_job';
  const retryable = failure?.retryable === true;
  const message = failure?.message || null;
  const jobId = failure?.jobId || prior?.jobId || null;
  const jobState = failure?.jobState || null;
  const resolvedRepeat = repeat ?? prior?.repeat ?? null;
  writeMarker(env.dir, row.receipt, {
    state: 'failed',
    code,
    retryable,
    message,
    jobId,
    jobState,
    repeat: resolvedRepeat,
    delayed: false,
    delayedSince: null,
    delayCount: 0,
    lastTransientError: null,
    failure: { code, retryable, ...(message ? { message } : {}), ...(jobId ? { jobId } : {}), ...(jobState ? { jobState } : {}) },
  });
  await noteOnRow(env, row.receipt, `live: failed ${code} (retryable=${retryable})`);
  progress(env.io, `live ${row.receipt} FAILED ${code} retryable=${retryable}; left reviewing`);
  return { state: 'failed', receipt: row.receipt, code, retryable, message, jobId };
}

async function delayRow(env, row, failure, repeat = null, markerState = 'running') {
  const prior = readMarker(env.dir, row.receipt);
  const now = new Date().toISOString();
  const code = failure?.code || 'booth_network';
  const message = failure?.message || null;
  const jobId = failure?.jobId || prior?.jobId || null;
  const jobState = failure?.jobState || null;
  const resolvedRepeat = repeat ?? prior?.repeat ?? null;
  const delayCount = (Number.isSafeInteger(prior?.delayCount) ? prior.delayCount : 0) + 1;
  writeMarker(env.dir, row.receipt, {
    state: markerState,
    delayed: true,
    delayedSince: prior?.delayedSince || now,
    delayCount,
    jobId,
    repeat: resolvedRepeat,
    lastTransientError: {
      code,
      retryable: true,
      ...(message ? { message } : {}),
      ...(jobId ? { jobId } : {}),
      ...(jobState ? { jobState } : {}),
      at: now,
    },
  });
  // Prefix matches booth.mjs CLAIM_SELECT (`operator_note LIKE 'live: failed %'`) so visitor tickets show reviewDelayed.
  const note = `live: failed transient ${code} (delayed; resuming${jobId ? ` job=${jobId}` : ''})`;
  if (row.operatorNote !== note) await noteOnRow(env, row.receipt, note);
  progress(env.io, `live ${row.receipt} delayed ${code} resuming${jobId ? ` job=${jobId}` : ''}; next cycle retries`);
  return { state: 'delayed', receipt: row.receipt, code, retryable: true, message, jobId, repeat: resolvedRepeat };
}

async function startReview(env, row, markerState = 'running') {
  const prior = readMarker(env.dir, row.receipt);
  const patch = {
    state: markerState,
    receivedAt: prior?.receivedAt || row.createdAt,
    startedAt: prior?.startedAt || new Date().toISOString(),
  };
  if (markerState === 'recovering') patch.recoveredAt = new Date().toISOString();
  writeMarker(env.dir, row.receipt, patch);
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
  const fresh = await fetchSubmission(env.client, row.receipt);
  const before = protectedRow(env, fresh, { receipt: row.receipt });
  if (before) return before;
  const current = fresh;
  if (!(await startReview(env, current, 'running'))) return skipWithdrawn(env, current);
  const blue = await blueWithRetry(env, { ...current, status: 'reviewing' }, {
    onJob: info => trackJobOnMarker(env, current.receipt, info),
  });
  if (blue.skip === 'withdrawn') return skipWithdrawn(env, current);
  if (blue.skip) return skipMissing(env, current);
  if (blue.busy) {
    // The running marker stays, so the next list cycle picks the row up again (reviewing + running).
    progress(env.io, `live ${current.receipt} still waiting for a job slot; next cycle retries`);
    return { state: 'error', receipt: current.receipt, code: 'slot_busy' };
  }
  if (blue.delayed) return delayRow(env, current, blue.delayed, blue.repeat, 'running');
  if (blue.failed) return failRow(env, current, blue.failed, blue.repeat);

  // Re-check server status right before PATCH so an already judged or withdrawn row is never overwritten.
  const latest = await fetchSubmission(env.client, current.receipt);
  const after = protectedRow(env, latest, { receipt: current.receipt });
  if (after) return after;

  const reviewFailure = reviewResultFailure(blue.record);
  if (reviewFailure) return failRow(env, current, reviewFailure, blue.repeat);
  const verdict = verdictFor(latest, blue.record);
  const body = judgedBody(env, verdict, { round: 'live', liveOutcome: verdict.outcome, prize: env.live.prizeMessage });
  let view;
  try {
    view = await patchRow(env.client, current.receipt, body);
  } catch (error) {
    if (isWithdrawn(error)) return skipWithdrawn(env, current);
    throw error;
  }
  writeMarker(env.dir, current.receipt, {
    state: 'done',
    outcome: verdict.outcome,
    publishedAt: view?.publishedAt || null,
    jobId: blue.jobId || verdict.jobId || null,
    repeat: blue.repeat ?? null,
    code: null,
    retryable: null,
    message: null,
    failure: null,
    delayed: false,
    delayedSince: null,
    delayCount: 0,
    lastTransientError: null,
  });
  progress(env.io, `live ${current.receipt} judged outcome=${verdict.outcome} published`);
  return { state: 'done', receipt: current.receipt, outcome: verdict.outcome, latencySec: latencySec(current, view) };
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
        if (result.state === 'error' || result.state === 'delayed') seen.delete(row.receipt);
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

// Reconcile local `running` markers whose submission left received/reviewing while watch was stopped.
async function reconcileRunningMarkers(env, activeReceipts) {
  for (const marker of listLiveMarkers(env.dir)) {
    if (marker.state !== 'running' || activeReceipts.has(marker.receipt)) continue;
    try {
      const row = await fetchSubmission(env.client, marker.receipt);
      protectedRow(env, row, { receipt: marker.receipt });
    } catch (error) {
      progress(env.io, `watch reconcile ${marker.receipt} failed ${codeOf(error)}`);
    }
  }
}

// received rows (not locally failed/recovering/skipped), plus reviewing rows this tool started and did not finish.
async function liveCandidates(env) {
  const { submissions } = await listPages(env.client, { status: 'received,reviewing', limit: 200 });
  const activeReceipts = new Set(submissions.map(row => row.receipt));
  await reconcileRunningMarkers(env, activeReceipts);
  return submissions.filter(row => {
    const markerState = readMarker(env.dir, row.receipt)?.state;
    if (row.status === 'received') {
      return markerState !== 'failed' && markerState !== 'recovering' && markerState !== 'skipped';
    }
    return row.status === 'reviewing' && markerState === 'running';
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
    delayed: stats.delayed.size,
    skipped: stats.skipped,
    failedReceipts: stats.failed.slice(),
    delayedReceipts: [...stats.delayed.values()],
    p50Sec: percentile(sorted, 50),
    p95Sec: percentile(sorted, 95),
  };
}

function recordResult(stats, result) {
  if (result.state === 'done') {
    stats.delayed.delete(result.receipt);
    stats.done += 1;
    if (result.latencySec != null) stats.latencies.push(result.latencySec);
  } else if (result.state === 'delayed') {
    stats.delayed.set(result.receipt, {
      receipt: result.receipt,
      code: result.code,
      retryable: true,
      message: result.message || null,
      jobId: result.jobId || null,
      repeat: result.repeat ?? null,
    });
  } else if (result.state === 'failed') {
    stats.delayed.delete(result.receipt);
    stats.failed.push({
      receipt: result.receipt,
      code: result.code,
      retryable: result.retryable === true,
      message: result.message || null,
      jobId: result.jobId || null,
    });
  } else if (result.state === 'skipped') {
    stats.delayed.delete(result.receipt);
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
  const stats = { done: 0, failed: [], delayed: new Map(), skipped: 0, latencies: [] };
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

function dryRecoverSummary(env, receipt, row) {
  const guarded = protectedRow(env, row, { receipt, dryRun: true });
  if (guarded) {
    return {
      receipt,
      serverStatus: row?.status || null,
      action: 'skipped',
      reason: guarded.reason,
      ...(guarded.outcome !== undefined ? { outcome: guarded.outcome } : {}),
      ...(guarded.published !== undefined ? { published: guarded.published } : {}),
    };
  }
  const inspected = inspectReceiptPlan(env, row);
  const marker = readMarker(env.dir, receipt);
  if (inspected.kind === 'completed') {
    return {
      receipt,
      serverStatus: row.status,
      markerState: marker?.state || null,
      action: 'resume_completed',
      repeat: inspected.repeat,
      jobId: inspected.record.job.id,
      idempotencyKey: inspected.record.idempotencyKey,
    };
  }
  if (inspected.kind === 'resume_job') {
    return {
      receipt,
      serverStatus: row.status,
      markerState: marker?.state || null,
      ...(marker?.delayed === true ? {
        delayed: true,
        delayedSince: marker.delayedSince || null,
        delayCount: marker.delayCount || 0,
        lastTransientError: marker.lastTransientError || null,
      } : {}),
      action: 'resume_job',
      repeat: inspected.repeat,
      jobId: inspected.record.job.id,
      jobState: inspected.record.job.state,
      idempotencyKey: inspected.record.idempotencyKey,
    };
  }
  return {
    receipt,
    serverStatus: row.status,
    markerState: marker?.state || null,
    action: 'reprocess',
    existingAttempts: inspected.attempts,
    lastFailure: inspected.lastFailure,
    nextRepeat: inspected.nextRepeat,
    nextIdempotencyKey: inspected.nextIdempotencyKey,
  };
}

async function recoverOne(env, receipt, { dryRun, maxRetries }) {
  const row = await fetchSubmission(env.client, receipt);
  if (dryRun) return dryRecoverSummary(env, receipt, row);
  const before = protectedRow(env, row, { receipt });
  if (before) {
    return {
      receipt,
      serverStatus: row?.status || null,
      action: 'skipped',
      reason: before.reason,
      ...(before.outcome !== undefined ? { outcome: before.outcome } : {}),
      ...(before.published !== undefined ? { published: before.published } : {}),
    };
  }
  if (!(await startReview(env, row, 'recovering'))) {
    skipWithdrawn(env, row);
    return { receipt, serverStatus: 'withdrawn', action: 'skipped', reason: 'withdrawn' };
  }
  const blue = await blueWithRetry(env, { ...row, status: 'reviewing' }, {
    allowNewAfterExhausted: true,
    maxRetries,
    onJob: info => trackJobOnMarker(env, row.receipt, info),
  });
  if (blue.skip === 'withdrawn') {
    skipWithdrawn(env, row);
    return { receipt, serverStatus: 'withdrawn', action: 'skipped', reason: 'withdrawn' };
  }
  if (blue.skip) {
    await skipMissing(env, row);
    return { receipt, serverStatus: row.status, action: 'skipped', reason: blue.skip };
  }
  if (blue.busy) {
    progress(env.io, `recover ${receipt} waiting for a job slot; rerun recover later`);
    return { receipt, serverStatus: 'reviewing', action: 'busy', code: 'slot_busy', retryable: true };
  }
  if (blue.delayed) {
    const delayed = await delayRow(env, row, blue.delayed, blue.repeat, 'recovering');
    return {
      receipt,
      serverStatus: 'reviewing',
      action: 'delayed',
      code: delayed.code,
      retryable: true,
      message: delayed.message,
      jobId: delayed.jobId,
      repeat: delayed.repeat,
    };
  }
  if (blue.failed) {
    const failed = await failRow(env, row, blue.failed, blue.repeat);
    return {
      receipt,
      serverStatus: 'reviewing',
      action: 'failed',
      code: failed.code,
      retryable: failed.retryable,
      message: failed.message,
      jobId: failed.jobId,
      repeat: blue.repeat,
    };
  }

  const latest = await fetchSubmission(env.client, receipt);
  const after = protectedRow(env, latest, { receipt });
  if (after) {
    return {
      receipt,
      serverStatus: latest?.status || null,
      action: 'skipped',
      reason: after.reason,
      ...(after.outcome !== undefined ? { outcome: after.outcome } : {}),
      ...(after.published !== undefined ? { published: after.published } : {}),
    };
  }

  const reviewFailure = reviewResultFailure(blue.record);
  if (reviewFailure) {
    const failed = await failRow(env, latest, reviewFailure, blue.repeat);
    return {
      receipt,
      serverStatus: 'reviewing',
      action: 'failed',
      code: failed.code,
      retryable: failed.retryable,
      message: failed.message,
      jobId: failed.jobId,
      repeat: blue.repeat,
    };
  }
  const verdict = verdictFor(latest, blue.record);
  const body = judgedBody(env, verdict, { round: 'live', liveOutcome: verdict.outcome, prize: env.live.prizeMessage });
  let view;
  try {
    view = await patchRow(env.client, receipt, body);
  } catch (error) {
    if (isWithdrawn(error)) {
      skipWithdrawn(env, latest);
      return { receipt, serverStatus: 'withdrawn', action: 'skipped', reason: 'withdrawn' };
    }
    throw error;
  }
  writeMarker(env.dir, receipt, {
    state: 'done',
    outcome: verdict.outcome,
    publishedAt: view?.publishedAt || null,
    jobId: blue.jobId || verdict.jobId || null,
    repeat: blue.repeat ?? null,
    code: null,
    retryable: null,
    message: null,
    failure: null,
    delayed: false,
    delayedSince: null,
    delayCount: 0,
    lastTransientError: null,
  });
  progress(env.io, `recover ${receipt} judged outcome=${verdict.outcome} repeat=${blue.repeat} job=${blue.jobId || verdict.jobId} published`);
  return {
    receipt,
    serverStatus: 'judged',
    action: 'done',
    outcome: verdict.outcome,
    jobId: blue.jobId || verdict.jobId || null,
    repeat: blue.repeat ?? null,
    resumed: blue.resumed === true,
    publishedAt: view?.publishedAt || null,
  };
}

function recoverTargets(dir, flags) {
  const only = receiptSet(flags);
  const allFailed = flags.allFailed === true;
  if (!only && !allFailed) {
    throw new BoothError('booth_config', 'recover needs --only <receipts> or --all-failed');
  }
  if (only) return [...only].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  return listLiveMarkers(dir)
    .filter(marker => marker.state === 'failed' || marker.state === 'recovering')
    .map(marker => marker.receipt);
}

// Explicit operator recovery for failed or interrupted receipts.
// Looks up each receipt by exact id, protects judged/withdrawn rows, resumes saved unfinished/valid-completed
// job tickets by id, and otherwise allocates a fresh repeat index (new idempotency key).
export async function recoverCommand(ctx) {
  const profileName = ctx.flags.profile && ctx.flags.profile !== true ? String(ctx.flags.profile) : ctx.config.live.liveProfile;
  const env = liveEnv(ctx, profileName);
  const targets = recoverTargets(env.dir, ctx.flags);
  const concurrency = flagInt(ctx.flags, 'concurrency', 'concurrency', 1, 256, env.live.concurrency);
  const maxRetries = flagInt(ctx.flags, 'retries', 'retries', 0, 10, env.live.retries);
  const dryRun = ctx.flags.dryRun === true;
  const results = await mapPool(targets, concurrency, receipt => recoverOne(env, receipt, { dryRun, maxRetries }));
  const failed = results.filter(item => item.action === 'failed' || item.action === 'busy' || item.action === 'delayed');
  env.io.stdout.write(`${JSON.stringify({
    dryRun,
    profile: env.run.profile.name,
    targets: targets.length,
    done: results.filter(item => item.action === 'done').length,
    skipped: results.filter(item => item.action === 'skipped').length,
    failed: failed.length,
    results,
  }, null, 2)}\n`);
  if (!dryRun && failed.length) {
    throw new BoothError('booth_partial', `${failed.length} of ${results.length} recovery target(s) did not complete`, { exitCode: 3 });
  }
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
  if (blue.skip || blue.failed || blue.busy || blue.delayed) {
    const failure = blue.failed || blue.delayed || null;
    const error = blue.skip || failure?.code || 'slot_busy';
    return {
      ...who,
      liveVerdict,
      finalVerdict: null,
      error,
      ...(failure ? { retryable: failure.retryable === true, failure } : {}),
    };
  }
  const reviewFailure = reviewResultFailure(blue.record);
  if (reviewFailure) {
    return {
      ...who,
      liveVerdict,
      finalVerdict: null,
      error: reviewFailure.code,
      retryable: reviewFailure.retryable === true,
      failure: reviewFailure,
    };
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
