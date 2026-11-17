# Hosted AI deployment contract (no live resources created here)

2026-11-17. This document is an implementation/deployment contract for the coordinator. No account resource,
secret, migration or deployment was created by the implementation workers.

## Components

1. **Web client** (`app/dist/hosted-ai.js`): logs in, uploads a PDF, submits one job, polls progress, downloads
   artifacts. It sends no provider key, provider URL or local path. It is enabled only when
   `FalsifyCloudConfig.hostedAi.enabled` is true.
2. **Cloudflare Worker** (`cloud/api`): public auth and job edge. D1 stores only upload metadata and a sanitized job
   index (no bytes, prompt text, provider result body or key). It forwards execution to the runtime.
3. **Python runtime** (`app/local/hosted_runtime`): the only process that reads `ANTHROPIC_API_KEY`. It stores
   upload/job/artifact state and blobs under `HOSTED_AI_STATE_DIR`, runs the existing RED/BLUE services and the
   Anthropic backend, and serves an internal-only HTTP API.
4. **Anthropic Messages API**: operator-funded provider calls. Current model IDs are allowlisted server-side.

## Runtime container

- Image: Python 3.12 with `app/local/requirements.txt` plus the application source. PyMuPDF is required for PDF
  extraction and the optional PDF edit path. No Node dependency is needed for the runtime.
- Start command: from `app/local`, `python -m hosted_runtime` (or `python -m hosted_runtime.http_api`).
- Bind: `HOSTED_AI_BIND=0.0.0.0`, `HOSTED_AI_PORT=8787` on a private container network. Never publish this port to
  the public internet; only the Worker (service binding or a private authenticated origin) may reach it.
- Persistent volume: mount `HOSTED_AI_STATE_DIR` (default is required explicitly). It holds the SQLite index and
  content-addressed blobs. A restart marks in-flight jobs `interrupted`; no paid call is replayed.
- Structured evidence: the runtime prepares the uploaded PDF with the existing EvidenceStore/table/figure engines,
  writes `evidence.json`, and passes `paperEvidence`/consent/fileHash to RED/BLUE. `applyOnly` applies selected
  text/table-cell edits without a model call and emits `edited.pdf` + `apply.json`. The web client downloads that exact
  PDF and re-uploads it as the BLUE input; BLUE receives no RED candidates/rationale/gold.
- Concurrency/budget: `HOSTED_AI_MAX_CONCURRENCY` (default 2), `HOSTED_AI_MAX_CALLS` (default 12, hard max 512),
  `HOSTED_AI_MAX_UPLOAD_BYTES` (default 32 MiB), `HOSTED_AI_JOB_RETENTION_SECONDS`. Per-batch provider capacity is
  tuned with `HOSTED_AI_RED_BATCH_CHARS`/`HOSTED_AI_BLUE_BATCH_CHARS` (default 100k chars),
  `HOSTED_AI_RED_CANDIDATES_PER_BATCH`/`HOSTED_AI_BLUE_FINDINGS_PER_BATCH` (default 40),
  `HOSTED_AI_IMAGES_PER_BATCH` (default 8), `HOSTED_AI_MAX_OUTPUT_TOKENS` (default 32000) and
  `HOSTED_AI_IMAGE_CAPACITY` (default 64). Overall coverage is reported by batch; a budget stop lists remaining
  batches instead of silently truncating.
- Secrets (runtime): `ANTHROPIC_API_KEY`, `HOSTED_AI_SERVICE_TOKEN` (shared with the Worker; length >= 16).
  `ANTHROPIC_WORKSPACE_ID` is required for the currently unscoped key and is sent as `anthropic-workspace-id`.
  Optional `ANTHROPIC_BASE_URL` must be https. Never put any of these in the image, repository or client bundle.

## Worker configuration

Non-secret vars (`cloud/api/wrangler.jsonc`):
`AI_HOSTING_ENABLED` (false by default), `AI_RUNTIME_URL` (private runtime origin; empty means 503
`ai_unavailable`), `AI_MAX_UPLOAD_BYTES`, `AI_MAX_PROMPT_CHARS`, `AI_MAX_CALLS_PER_JOB`, `AI_DEFAULT_CALLS`,
`AI_UPLOADS_PER_OWNER_HOUR`, `AI_JOBS_PER_OWNER_HOUR`, `AI_ACTIVE_JOBS_PER_OWNER`, `AI_MODELS`, `AI_EFFORTS`.
Secret: `HOSTED_AI_SERVICE_TOKEN` (`wrangler secret put`). Owner-paid policy: `AI_OWNER_TOKEN_BUDGET` (0 = disabled)
and `AI_TOKEN_WINDOW_SECONDS`; usage is recorded from terminal provider responses and is an enforceable policy gate,
not an exact spend balance. In-flight jobs reserve call slots, not estimated tokens; apply-only jobs bypass the token gate.
Optional binding: an `AI_RUNTIME` service binding with a `fetch` method takes precedence over `AI_RUNTIME_URL`
and avoids public egress.

`CONFLUENCE_ONLY=true` may stay true: when `AI_HOSTING_ENABLED=true`, password session routes are not blocked and
hosted users/owners work without a Confluence archive connection. A site `cloudId` alone is never an owner.

## D1 migration

Apply `cloud/api/migrations/0003_hosted_ai.sql` and `0004_owner_usage.sql` before enabling `AI_HOSTING_ENABLED`.
They add `ai_uploads`, `ai_jobs`, recorded provider usage columns and indexes only; no bytes, prompts or results.
Do not run them against production until the coordinator approves the release.

## Verification before enabling

1. Offline: `cd cloud/api && npm test`; `cloud/api` dry-run build; Python runtime tests and the runtime HTTP
   integration test; `cd app && node --test tests/hosted-ai.spec.mjs`.
2. Staging: upload a synthetic PDF, run RED and BLUE, verify progress, cancel, reload/readback, artifact download,
   duplicate submission (no second provider call), owner isolation with two accounts, and runtime-down 503.
3. Live provider smoke is coordinator-owned. Never use private papers or answer keys as fixtures/logs.

## Known limits

- Structured table/figure evidence, selected text/table-cell edits and edited-PDF download/BLUE handoff are wired for
  hosted jobs. Chart-point apply is rejected with a fixed code (discovery still appears in RED context). Visual crops
  are accepted by the provider backend in per-request groups but the default hosted UI does not yet collect crop
  selections. `AI_RUNTIME_URL`/secret/migrations remain unset until deployment.
- The Worker buffers an upload to compute its hash before forwarding (bounded by `AI_MAX_UPLOAD_BYTES`).
- No public listing of jobs; the client stores its job id and reads it back.
