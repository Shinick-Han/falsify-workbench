import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': Buffer.isBuffer(body) ? 'application/pdf' : 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...headers,
  });
  res.end(payload);
}

function fail(res, status, code, headers = {}, retryable = null) {
  const isRetryable = typeof retryable === 'boolean'
    ? retryable
    : (status === 429 || (status >= 500 && code !== 'storage_full'));
  send(res, status, { error: { code, message: code, requestId: 'fake', retryable: isRetryable } }, headers);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

export function startFake({
  token, submissions, pdfs, queued = false, jobDelayMs = 0, papers = null, pdfWithdrawn = null,
  pdfHeaders = null, result = null, failJobs = false, failSpec = null, pollFailures = 0, activeCap = 0,
  alwaysBusy = null, stuckJobs = false, seedJobs = [], pollMismatchId = null,
}) {
  const makeResult = requestBody => {
    if (typeof result === 'function') return structuredClone(result(requestBody));
    return result ? structuredClone(result) : sampleResult();
  };
  const resolveFailure = requestBody => {
    if (typeof failSpec === 'function') return failSpec(requestBody);
    if (failSpec && typeof failSpec === 'object') return structuredClone(failSpec);
    return null;
  };
  const state = {
    submissions: submissions.map(row => ({ ...row, declared: row.declared.map(edit => ({ ...edit })), paper: row.paper ? { ...row.paper } : null })),
    pdfs,
    papers,
    pdfWithdrawn: pdfWithdrawn || new Set(),
    pdfHeaders: pdfHeaders || new Map(),
    requests: [],
    settings: { submissionsOpen: true, missions: [], announcement: null },
    uploads: new Map(),
    jobs: new Map(seedJobs.map(job => [job.id, structuredClone(job)])),
    newJobs: 0,
    pdfGets: {},
    paperPdfGets: {},
    jobInFlight: 0,
    maxJobInFlight: 0,
    puts: [],
    patches: [],
    pollFailures,
    jobPosts: 0,
    jobGets: 0,
    submissionGets: 0,
    busy429: 0,
    cancels: 0,
    maxActive: 0,
  };

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, 'http://127.0.0.1');
    const headers = { ...req.headers };
    delete headers.authorization;
    state.requests.push({ method: req.method, url: req.url, headers, body });
    const bearer = String(req.headers.authorization || '');
    if (bearer !== `Bearer ${token}`) {
      fail(res, bearer.startsWith('Bearer ') ? 403 : 401, bearer.startsWith('Bearer ') ? 'forbidden' : 'unauthorized');
      return;
    }
    try {
      await route(req, res, url, body);
    } catch {
      fail(res, 500, 'fake_error');
    }
  });

  async function route(req, res, url, body) {
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/v1/booth/config') {
      send(res, 200, {
        enabled: true,
        submissionsOpen: state.settings.submissionsOpen,
        consentVersion: '2026-11-22.v1',
        courses: [{ id: 'quick', label: '빠른 코스' }, { id: 'deep', label: '정밀 코스' }],
        defectTypes: [{ id: 'number', label: '수치·통계' }],
        limits: { maxDeclared: 5, maxReason: 500, maxNickname: 24 },
        missions: state.settings.missions,
        announcement: state.settings.announcement,
      });
      return;
    }
    if (pathname === '/v1/booth/admin/settings' && req.method === 'GET') {
      send(res, 200, state.settings);
      return;
    }
    if (pathname === '/v1/booth/admin/settings' && req.method === 'PUT') {
      const patch = JSON.parse(body.toString('utf8'));
      state.puts.push(patch);
      if (Object.hasOwn(patch, 'submissionsOpen')) state.settings.submissionsOpen = patch.submissionsOpen;
      if (Object.hasOwn(patch, 'missions')) state.settings.missions = patch.missions;
      if (Object.hasOwn(patch, 'announcement')) state.settings.announcement = patch.announcement;
      send(res, 200, state.settings);
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/booth/admin/submissions') {
      let rows = state.submissions.slice().sort((a, b) => a.seq - b.seq);
      const status = url.searchParams.get('status');
      if (status) {
        const allowed = new Set(status.split(','));
        rows = rows.filter(row => allowed.has(row.status));
      }
      const after = url.searchParams.get('after');
      if (after != null) rows = rows.filter(row => row.seq > Number(after));
      const limit = Number(url.searchParams.get('limit') || 100);
      const page = rows.slice(0, limit);
      const nextAfter = rows.length > limit ? page[page.length - 1].seq : null;
      send(res, 200, { submissions: page, nextAfter });
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/papers/pdf') {
      const id = url.searchParams.get('id') || '';
      state.paperPdfGets[id] = (state.paperPdfGets[id] || 0) + 1;
      const spec = state.papers ? state.papers.get(id) : Buffer.from(`%PDF-1.4\n% ${id}\n`);
      if (spec == null) {
        fail(res, 404, 'not_found');
        return;
      }
      if (spec === 'denied') {
        fail(res, 403, 'paper_not_allowed');
        return;
      }
      send(res, 200, spec, { 'X-Falsify-Pdf-Sha256': sha256(spec) });
      return;
    }
    const pdf = pathname.match(/^\/v1\/booth\/admin\/submissions\/(F-\d+)\/pdf$/);
    if (req.method === 'GET' && pdf) {
      const receipt = pdf[1];
      state.pdfGets[receipt] = (state.pdfGets[receipt] || 0) + 1;
      const row = state.submissions.find(item => item.receipt === receipt);
      if (state.pdfWithdrawn.has(receipt) || row?.status === 'withdrawn') {
        fail(res, 404, 'withdrawn');
        return;
      }
      if (state.pdfs.get(receipt) === 'expired') {
        fail(res, 404, 'artifact_expired');
        return;
      }
      const bytes = state.pdfs.get(receipt);
      if (!bytes) {
        fail(res, 404, 'not_found');
        return;
      }
      const hash = state.pdfHeaders.get(receipt) || sha256(bytes);
      send(res, 200, bytes, {
        'Content-Disposition': `attachment; filename="${receipt}.pdf"`,
        'X-Falsify-Pdf-Sha256': hash,
      });
      return;
    }
    const one = pathname.match(/^\/v1\/booth\/admin\/submissions\/(F-\d+)$/);
    if (one && req.method === 'GET') {
      state.submissionGets += 1;
      const receipt = one[1];
      const row = state.submissions.find(item => item.receipt === receipt);
      if (!row) {
        fail(res, 404, 'not_found');
        return;
      }
      send(res, 200, row);
      return;
    }
    if (one && req.method === 'PATCH') {
      const receipt = one[1];
      const patch = JSON.parse(body.toString('utf8'));
      state.patches.push({ receipt, body: patch });
      const row = state.submissions.find(item => item.receipt === receipt);
      if (!row) {
        fail(res, 404, 'not_found');
        return;
      }
      if (row.status === 'withdrawn' && Object.keys(patch).some(key => key !== 'operatorNote')) {
        fail(res, 409, 'withdrawn');
        return;
      }
      if (Object.hasOwn(patch, 'status')) row.status = patch.status;
      if (Object.hasOwn(patch, 'outcome')) row.outcome = patch.outcome;
      if (Object.hasOwn(patch, 'publicNote')) row.publicNote = patch.publicNote;
      if (Object.hasOwn(patch, 'prizeMessage')) row.prizeMessage = patch.prizeMessage;
      if (Object.hasOwn(patch, 'operatorNote')) row.operatorNote = patch.operatorNote;
      if (Object.hasOwn(patch, 'aiSummary')) row.aiSummary = patch.aiSummary;
      if (patch.published === true) {
        row.published = true;
        row.publishedAt = new Date().toISOString();
      } else if (patch.published === false) {
        row.published = false;
        row.publishedAt = null;
      }
      row.updatedAt = new Date().toISOString();
      send(res, 200, row);
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/ai/uploads') {
      const digest = sha256(body);
      const prior = state.uploads.get(digest);
      if (prior) {
        send(res, 200, { upload: { ...prior, deduplicated: true } });
        return;
      }
      const upload = {
        id: randomUUID(),
        sha256: digest,
        name: 'edited.pdf',
        mime: 'application/pdf',
        bytes: body.length,
        deduplicated: false,
      };
      state.uploads.set(digest, upload);
      send(res, 201, { upload });
      return;
    }
    if (req.method === 'POST' && pathname === '/v1/ai/jobs') {
      state.jobPosts += 1;
      state.jobInFlight += 1;
      state.maxJobInFlight = Math.max(state.maxJobInFlight, state.jobInFlight);
      if (jobDelayMs) await delay(jobDelayMs);
      state.jobInFlight -= 1;
      const requestBody = JSON.parse(body.toString('utf8'));
      const existing = [...state.jobs.values()].find(job => job.idempotencyKey === requestBody.idempotencyKey);
      if (existing) {
        send(res, 200, { job: publicJob(existing), replayed: true });
        return;
      }
      // Like BOOTH_OPERATOR_ACTIVE_JOBS: a new job past the active cap is 429 rate_limited.
      const active = [...state.jobs.values()].filter(job => job.state === 'queued' || job.state === 'running').length;
      if ((activeCap && active >= activeCap) || alwaysBusy !== null) {
        state.busy429 += 1;
        // alwaysBusy: '' is a 429 with no Retry-After, a number string is that header.
        fail(res, 429, 'rate_limited', alwaysBusy ? { 'Retry-After': alwaysBusy } : {});
        return;
      }
      state.newJobs += 1;
      const now = new Date().toISOString();
      const failure = resolveFailure(requestBody);
      const shouldFail = Boolean(failJobs || failure);
      const job = {
        id: randomUUID(),
        role: requestBody.role,
        state: shouldFail ? (failure?.state || 'failed') : (queued ? 'queued' : 'completed'),
        model: requestBody.model || '',
        effort: requestBody.effort || '',
        useEvidence: requestBody.useEvidence !== false,
        idempotencyKey: requestBody.idempotencyKey,
        requestBody,
        polls: 0,
        result: queued || shouldFail ? null : makeResult(requestBody),
        ...(failure ? { failure: { code: failure.code, retryable: failure.retryable === true, ...(failure.message ? { message: failure.message } : {}) } } : {}),
        usage: { inputTokens: 11, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        createdAt: now,
        completedAt: queued && !shouldFail ? null : now,
      };
      state.jobs.set(job.id, job);
      state.maxActive = Math.max(state.maxActive, [...state.jobs.values()].filter(item => item.state === 'queued' || item.state === 'running').length);
      send(res, 202, { job: publicJob(job), replayed: false });
      return;
    }
    const jobPath = pathname.match(/^\/v1\/ai\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobPath) {
      state.jobGets += 1;
      const job = state.jobs.get(decodeURIComponent(jobPath[1]));
      if (!job) {
        fail(res, 404, 'not_found');
        return;
      }
      if (state.pollFailures > 0) {
        state.pollFailures -= 1;
        fail(res, 503, 'unavailable', {}, true);
        return;
      }
      job.polls += 1;
      if (stuckJobs && job.state === 'queued') job.state = 'running';
      if (job.state === 'queued' && job.polls >= 1) {
        job.state = 'completed';
        job.result = makeResult(job.requestBody);
        job.completedAt = new Date().toISOString();
      }
      const view = publicJob(job);
      if (pollMismatchId) view.id = pollMismatchId;
      send(res, 200, { job: view });
      return;
    }
    const cancelPath = pathname.match(/^\/v1\/ai\/jobs\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelPath) {
      const job = state.jobs.get(decodeURIComponent(cancelPath[1]));
      if (!job) {
        fail(res, 404, 'not_found');
        return;
      }
      state.cancels += 1;
      job.state = 'cancelled';
      job.completedAt = new Date().toISOString();
      send(res, 200, { job: publicJob(job) });
      return;
    }
    fail(res, 404, 'not_found');
  }

  function publicJob(job) {
    return {
      id: job.id,
      role: job.role,
      state: job.state,
      model: job.model,
      effort: job.effort,
      useEvidence: job.useEvidence,
      result: job.result,
      ...(job.failure ? { failure: job.failure } : {}),
      usage: job.usage,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((done, reject) => {
          server.close(error => (error ? reject(error) : done()));
        }),
      });
    });
  });
}

function sampleResult() {
  return {
    schema: 'falsify.document-blue.v1',
    status: 'ok',
    findings: [{
      id: 'f1',
      occurrence: 0,
      segmentId: 'p2-b1',
      quote: 'p < 0.50',
      evidence: [{ quote: 'p < 0.50', relation: 'the threshold moved', segmentId: 'p2-b1' }],
      rationale: 'the threshold moved',
      uncertainty: '',
    }],
  };
}
