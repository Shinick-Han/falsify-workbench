# Hosted AI execution contract (implementation working copy)

2026-11-17. Base `5e7f0bd71761b8567846c2f93ac1807a3d319fac`. This file fixes the wire contract between the
web client, the Cloudflare Worker gateway (`cloud/api`) and the Python runtime (`app/local/hosted_runtime`).
It is an implementation contract, not a deployment or release approval.

## Roles and authority

- The browser holds only its Falsify login session. It never sends an Anthropic key, provider base URL or local path.
- The Worker authenticates the user, binds every upload/job/artifact to one stable owner ID and rate-limits submissions.
- The Python runtime is the only process that reads `ANTHROPIC_API_KEY` and calls the provider. It re-checks ownership
  on every internal call and is reachable only with `HOSTED_AI_SERVICE_TOKEN`.
- Confluence archive connection is not required for login or hosted execution. A site `cloudId` alone is never an owner.
- Public/loopback concerns: the runtime listens on a container-internal address; it must never be exposed publicly.

## Stable owner ID

- Password session (`fss_...`): owner is the D1 `authors.id` UUID. Composed owner ID: `usr:<uuid>`.
- Confluence session: the Worker resolves the Atlassian current-user `accountId` with the session access token.
  Composed owner ID: `atl:<sha256hex(cloudId + ":" + accountId)>`. Never `cloudId` alone, never email/display name.
- Same inputs must map to the same owner ID across requests. Unknown/ambiguous identity is a 401, never a fallback.

## Public Worker API (`cloud/api`, origin-gated, bearer session)

All JSON error bodies: `{ "error": { "code": "<fixed_code>", "message": "<fixed text>", "requestId": "<req id>", "retryable": <bool> } }`.
No provider message, key, prompt, paper text or SQL is echoed.

### `GET /v1/ai/capabilities`
`200`:
```json
{ "enabled": true, "provider": "anthropic", "execution": "server",
  "models": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  "efforts": ["low", "medium", "high", "xhigh", "max"],
  "limits": { "maxUploadBytes": 33554432, "maxPromptChars": 8000 } }
```
`enabled` is false unless `AI_HOSTING_ENABLED` is true. Never include key presence or provider account data.

### `POST /v1/ai/uploads`
Headers: `Authorization: Bearer <session>`, `Content-Type: application/pdf|application/octet-stream|text/plain`,
`X-Falsify-File-Name: <encodeURIComponent(name)>`. Body is the raw file bytes (bounded by `maxUploadBytes`).
`201`: `{ "upload": { "id": "<uuid>", "sha256": "<hex>", "name": "...", "mime": "...", "bytes": 123,
"createdAt": "<iso>", "deduplicated": false } }`. Same owner + same sha256 returns the existing upload (`200`, `deduplicated: true`).
Errors: 400 invalid_request, 401 unauthorized, 413 payload_too_large, 415 unsupported_media_type, 429 rate_limited, 503 ai_unavailable.

### `POST /v1/ai/jobs`
```json
{ "role": "red", "prompt": "...", "uploadId": "<uuid>", "idempotencyKey": "opaque-8..128",
  "model": "claude-opus-5-5", "effort": "high", "budget": { "maxCalls": 12 } }
```
`prompt` is the user's review instruction (<= 8000 chars). `model`/`effort` are optional server-allowlisted choices.
`harness` is optional and must not carry endpoints, paths, keys or executable code. `budget` is advisory; the server
applies its own hard budget. `202`: `{ "job": <snapshot>, "replayed": false }`.
Same owner + idempotencyKey + same request hash: `200` with the existing snapshot and `replayed: true`;
same key with a different request hash: `409 idempotency_conflict`. A replayed submission never triggers another paid call.

### Job snapshot
```json
{ "id": "<uuid>", "role": "red", "state": "queued|running|cancelling|cancelled|completed|failed|interrupted",
  "progress": { "completedCalls": 2, "requiredCalls": 5, "phase": "analyzing" },
  "model": "claude-opus-5-5", "effort": "high", "provider": "anthropic",
  "usage": { "inputTokens": 1, "outputTokens": 2, "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0 },
  "result": { ... }, "artifacts": [ { "id": "...", "name": "review.json", "mime": "application/json", "bytes": 42, "sha256": "..." } ],
  "failure": { "code": "auth_required", "message": "...", "requestId": "req_...", "retryable": false },
  "createdAt": "...", "updatedAt": "...", "completedAt": "..." }
```
Only values the provider actually returned are recorded. `interrupted` means the runtime restarted or lost the worker:
not complete, no automatic replay of paid calls. Partial artifacts may still be listed.

The review result carries `coverage.complete` and batch accounting. Hosted RED records
`coverage.batches/completedBatches/remainingBatches`; hosted BLUE records
`coverage.textBatches/imageBatches/completedPairs/remainingBatches`. `resultCoverage` counts accepted, rejected and
unresolved items. If the job's call budget ends before every batch, the job still completes with the accumulated valid
items, `coverage.complete: false` and the remaining batch ranges; it never claims every batch was read.

### `GET /v1/ai/jobs/:id`
Owner-only. Non-owner and missing are both `404 not_found`. Status is read from the runtime; when it is unavailable
return `503 ai_unavailable` rather than a fabricated state.

### `POST /v1/ai/jobs/:id/cancel`
Owner-only, idempotent. `202 { "job": <snapshot> }` with `cancelling` (or the terminal state if already finished).
In-flight provider calls are not aborted mid-request; results after cancellation are discarded.

### `GET /v1/ai/jobs/:id/artifacts/:artifactId`
Owner-only. Raw bytes with the stored content type and `Content-Disposition: attachment; filename="..."`,
`Cache-Control: no-store`. A missing/foreign artifact is `404 not_found`.

## Internal runtime API (`app/local/hosted_runtime`, container-internal)

Every request carries `X-Falsify-Service-Token: <HOSTED_AI_SERVICE_TOKEN>` and `X-Falsify-Owner-Id: <ownerId>`
(upload/job creation also via body `ownerId`). Constant-time token compare; missing/mismatch is 401.

- `GET /internal/v1/health` -> `200 {"ok": true, "provider": "anthropic", "models": [...], "version": "...", "ready": bool}`.
- `POST /internal/v1/uploads?name=<urlencoded>&mime=<urlencoded>` raw bytes -> `201 { "upload": { id, sha256, bytes, name, mime, createdAt } }`.
  Content-addressed per owner; identical bytes for the same owner are reused.
- `POST /internal/v1/jobs` -> `202`/`200` with the snapshot. Body:
  `{ "jobId": "...", "ownerId": "...", "idempotencyKey": "...", "requestHash": "...", "role": "red|blue",
     "prompt": "...", "uploadId": "...", "model": "...", "effort": "...", "budget": { "maxCalls": 12 },
     "harness": { ... } }`. Duplicate `(ownerId, idempotencyKey)` + same hash returns the existing job.
- `GET /internal/v1/jobs/<jobId>` (owner header) -> snapshot.
- `POST /internal/v1/jobs/<jobId>/cancel` -> snapshot.
- `GET /internal/v1/jobs/<jobId>/artifacts/<artifactId>` -> raw bytes.
- `404` for a foreign or unknown job/artifact. No listing of other owners' data.

## Runtime configuration (server environment only)

`ANTHROPIC_API_KEY` (never logged/echoed/returned), optional `ANTHROPIC_WORKSPACE_ID` -> `anthropic-workspace-id`
header, optional `ANTHROPIC_BASE_URL` (https only, tests inject transport), `HOSTED_AI_SERVICE_TOKEN`,
`HOSTED_AI_STATE_DIR`, `HOSTED_AI_MODELS` (default `claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5`),
`HOSTED_AI_DEFAULT_MODEL`, `HOSTED_AI_MAX_UPLOAD_BYTES`, `HOSTED_AI_MAX_CONCURRENCY`, `HOSTED_AI_MAX_CALLS`,
`HOSTED_AI_JOB_RETENTION_SECONDS`, per-batch tuning: `HOSTED_AI_RED_BATCH_CHARS`,
`HOSTED_AI_BLUE_BATCH_CHARS`, `HOSTED_AI_RED_CANDIDATES_PER_BATCH`, `HOSTED_AI_BLUE_FINDINGS_PER_BATCH`,
`HOSTED_AI_IMAGES_PER_BATCH`, `HOSTED_AI_MAX_OUTPUT_TOKENS`, `HOSTED_AI_IMAGE_CAPACITY`.

## Provider request (Anthropic Messages API)

- `POST {base}/v1/messages`, headers `x-api-key`, `anthropic-version: 2026-10-21`, `content-type: application/json`,
  optional `anthropic-workspace-id`.
- Structured output: `output_config.format = {type: "json_schema", schema: <transformed schema>}`; effort in
  `output_config.effort`; thinking omitted (adaptive default). No forced tool use on current models.
- Unsupported schema keywords (`maxItems`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, ...) are removed
  from the wire schema and still enforced locally with `jsonschema` after parsing. Never silently accept invalid output.
- Images: base64 `image` blocks (`image/png|jpeg|webp|gif`), no fixed six-image cap; batching by provider capacity.
- Usage is mapped from the response `usage` object; `request-id` header and `model`/`stop_reason` are recorded.
- Errors map to fixed codes: 400 `invalid_request`, 401 `auth_required`, 403 `permission_denied`, 404 `not_found`,
  413 `request_too_large`, 429 `rate_limited` (retryable), 500/529 `provider_error`/`overloaded` (retryable),
  504/transport timeout `timeout`. No automatic paid retry at submit time.

## Harness adapter

Hosted jobs use one server-side harness shape, not a CLI model name:
```json
{ "schema": "falsify.harness.v1", "id": "hosted-anthropic", "name": "Hosted Anthropic",
  "version": "1", "role": "red|blue", "instructions": "<user prompt, <=8000>", "maxCalls": 12,
  "adapter": { "type": "hosted", "model": "claude-opus-5-5", "effort": "high" } }
```
`adapter.type` must be `hosted`; no stdio/http/wrapper fields, no credentials, no executable paths. The model and
effort must be in the server allowlist. Recorded selection: provider `anthropic-api`, requested model and effort.
