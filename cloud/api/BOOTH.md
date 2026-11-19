# Booth API

Visitor submissions for the AWS Community Day event page. The routes live on the event Worker. Production behaviour is unchanged when `BOOTH_ENABLED` is unset: every `/v1/booth/*` path is `404 not_found` before authentication.

Guests use the existing `fsg_` session. The operator uses a separate bearer and is not a guest.

## Operator token

Generate a token locally. It is `fso_` plus 43 base64url characters. Do not commit it, log it, or pass it as a Wrangler var.

```bash
node -e "console.log('fso_'+require('crypto').randomBytes(32).toString('base64url'))"
```

Store it as the event Worker secret:

```bash
npx wrangler secret put BOOTH_OPERATOR_TOKEN --env event
```

The secret must match the same pattern. If it is unset, malformed, or different from the bearer, operator routes and operator AI calls return `401 unauthorized`. Comparison uses SHA-256 digests so it does not depend on a shared prefix. The owner id is `opr:booth`.

Apply the D1 migration to the event database when you are ready to deploy. This is an operator step; workers do not run it:

```bash
npx wrangler d1 migrations apply falsify-harness-records-event --env event --remote
```

Run both commands from `cloud/api`. `--remote` writes the event database. Do not point it at production.

Event vars (already in `wrangler.jsonc`, not secrets): `AI_GUESTS_PER_IP_HOUR=600`, `AI_GUESTS_PER_HOUR=800`, `AI_GUEST_UPLOADS_PER_HOUR=400`, `AI_GUEST_JOBS_PER_OWNER_HOUR=20`, `AI_GUEST_APPLY_JOBS_PER_HOUR=600`, `AI_GUEST_BLUE=false`, `AI_GUEST_MODEL_JOBS=false`, `AI_MODEL_JOBS_OPERATOR_ONLY=true`, `BOOTH_ENABLED=true`, `BOOTH_CONSENT_VERSION=2026-11-22.v2`, `BOOTH_SUBMISSIONS_PER_IP_HOUR=400`, `BOOTH_CLAIMS_PER_IP_HOUR=8000`, `BOOTH_CLAIMS_PER_HOUR=15000`, `BOOTH_OPERATOR_ACTIVE_JOBS=2`, `BOOTH_MAX_PDF_BYTES=16777216`, `BOOTH_STORED_PDF_BYTES=3221225472`, `PAPER_SEARCH_ENABLED=true`, `PAPER_SEARCH_PER_IP_HOUR=2000`, `PAPER_PDF_PER_IP_HOUR=600`, `AI_PAPER_TOOLS_ENABLED=false`. The operator may turn `AI_PAPER_TOOLS_ENABLED` back on. The event environment also sets `limits.cpu_ms` to 5000. Production stays at 1000. Production and staging vars are unchanged. `BOOTH_OPERATOR_TOKEN_BUDGET` is not an event var. It defaults to 0, which leaves the operator token-budget gate off.

## Routes

Preflight answers `OPTIONS` with methods `GET, POST, PATCH, PUT, DELETE, OPTIONS` and headers `Authorization, Content-Type`. JSON errors use the hosted AI envelope (`error.code`, `error.message`, `error.requestId`, `error.retryable`) plus `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

| Method | Path | Auth | Success |
|---|---|---|---|
| GET | `/v1/booth/config` | none | 200 config |
| POST | `/v1/booth/submissions` | guest, password, or Confluence owner | 201 receipt and claim key. `multipart/form-data` with `meta` and `pdf`. `paper` is required |
| POST | `/v1/booth/claim` | none | 200 claim view |
| POST | `/v1/booth/withdraw` | none (same body as claim) | 200 claim view, status `withdrawn` |
| GET | `/v1/booth/admin/submissions` | operator | 200 page |
| GET | `/v1/booth/admin/submissions/:receipt` | operator | 200 admin view |
| GET | `/v1/booth/admin/submissions/:receipt/pdf` | operator | 200 `application/pdf` |
| PATCH | `/v1/booth/admin/submissions/:receipt` | operator | 200 admin view |
| DELETE | `/v1/booth/admin/submissions/:receipt` | operator | 204 |
| GET | `/v1/booth/admin/settings` | operator | 200 settings |
| PUT | `/v1/booth/admin/settings` | operator | 200 settings |

The operator bearer is rejected on `POST /v1/booth/submissions` with `403 forbidden`. Any other valid bearer on an admin route is `403 forbidden`. A missing bearer is `401 unauthorized`.

`GET /v1/booth/config` needs no bearer and does not write. `limits` is integers only. It keeps `maxDeclared` (5, the same maximum the submit parser enforces), `maxReason` (500), and `maxNickname` (24). It also returns `maxPdfBytes`, the effective PDF cap, and `perOwner`, from `BOOTH_SUBMISSIONS_PER_OWNER` (default 5). `maxPdfBytes` is `BOOTH_MAX_PDF_BYTES` when that is a positive integer, otherwise `AI_GUEST_MAX_UPLOAD_BYTES` when that is a positive integer, otherwise 20971520, and never above 33554432. The event Worker therefore publishes 16777216, which is the number the page uses for "16MB 이하". The object does not include secrets, hourly caps, or the storage cap.

`GET /v1/booth/admin/submissions` takes `status` (comma-separated), `after` (seq cursor, exclusive) and `limit` (1..200, default 100). The page is ordered by `seq`. `nextAfter` is the last seq on the page when another row remains, otherwise null.

`POST /v1/booth/submissions` is `multipart/form-data` parsed with `request.formData()`. The PDF is never decoded as text. Exactly two fields, in either order: `meta` (a text field) and `pdf` (a file field with a filename and type `application/pdf`). Anything else is `400 invalid_request`. `meta` is the submission object without `jobId`, plus `editedSha256` (lowercase hex SHA-256 of the PDF file bytes) and required `paper.sourceSha256` (lowercase hex). The operator bearer is still `403 forbidden` before the body is read.

`Content-Length` is required (`411 length_required`). A declared length above `BOOTH_MAX_PDF_BYTES` plus 65536 is `413 payload_too_large` before the body is read. The PDF file size is checked again after parsing.

`BOOTH_MAX_PDF_BYTES` defaults to `AI_GUEST_MAX_UPLOAD_BYTES` when that is a positive integer, otherwise 20 MiB. The resolved value is capped at 32 MiB. The event Worker sets it to 16777216. The PDF must be non-empty and start with `%PDF-`. One SHA-256 of those bytes must equal `editedSha256`, and it must differ from `paper.sourceSha256` (`400 pdf_unchanged`). The same owner and the same PDF hash is `409 already_submitted` with the earlier receipt. A different owner may submit those same bytes.

`BOOTH_STORED_PDF_BYTES` defaults to 2147483648. The event Worker sets it to 3221225472. The cap is the sum of `pdf_bytes` on rows that still have `booth_files` rows, plus this file. A withdrawn row keeps `pdf_bytes` but its files are gone, so it does not count. Over the cap is `503 storage_full`, and that code is not retryable.

The PDF is stored in `booth_files` as 512 KiB BLOBs. One `db.batch` inserts the submission row and the chunks. The row insert is `INSERT … SELECT … WHERE` the next seq is still `MAX(seq)+1`, the owner's non-withdrawn count is under `BOOTH_SUBMISSIONS_PER_OWNER`, and the stored-bytes sum still fits. Each chunk is `INSERT … SELECT` bound bytes `WHERE EXISTS` the new row, so a rejected row leaves no chunk. The handler accepts the batch only when every statement reports `changes` 1. Otherwise it discards the attempt, then answers `429 rate_limited` (owner cap), `503 storage_full`, `409 already_submitted`, or retries the whole batch for a seq race, at most 5 times. An attempt that does not land gives back the hourly slots. `pdf_sha256`, `pdf_bytes` and `source_sha256` are columns on `booth_submissions`. There is no `job_id` or `artifact_id`. Visitor submission does not call the runtime.

The admin PDF route reads one `idx` at a time through a stream and returns `application/pdf` with `Content-Length` equal to `pdf_bytes` and `X-Falsify-Pdf-Sha256`. Each chunk read joins `booth_files` to a submission that is not withdrawn, and the stream aborts if that row is gone. A missing or gapped index before the stream starts is `500 internal_error` with a JSON body. List and detail queries do not select `booth_files.data`. The file name is the receipt. The admin view has `pdfSha256`, `pdfBytes` and `sourceSha256` instead of `jobId` and `artifactId`.

Checks run in this order: authentication, `Content-Length` (missing is 411, over the body cap is 413, both before the body is read), form fields and `meta` shape (including required `sourceSha256`, the paper allowlist and the nickname), `submissionsOpen`, consent, then the PDF checks (magic, file size, hash, unchanged source, mission source hash), the duplicate lookup, the rate buckets, and the atomic batch. The batch's `WHERE` also enforces the owner cap and the stored-bytes cap. A closed booth still wins over a bad PDF. `411` and `413` happen before the closed and consent checks.

Claim and withdraw share one per-IP hourly bucket (`BOOTH_CLAIMS_PER_IP_HOUR`, default 120) and one global hourly bucket (`BOOTH_CLAIMS_PER_HOUR`, default 2000). The event environment raises them to 8000 and 15000 because visitors poll the claim route for the live result from behind one venue NAT. A global rejection gives the per-IP slot back. Both always run the constant-time claim-key compare, using a dummy digest when the receipt is unknown. An unknown receipt and a wrong key are both `404 not_found`. Receipt numbers retry up to 5 times on a seq collision.

`paper.source` must be `arxiv` or `mission`. `paper.license` must be `cc-by`, `cc-by-<n.n>`, `cc-by-sa`, `cc-by-sa-<n.n>`, `cc0`, `cc0-1.0`, or `public-domain`. Anything else, including a missing paper, is `400 paper_not_allowed`. `paper.sourceSha256` is required. When `paper.source` is `mission` and that mission in `booth_settings` has a `sourceSha256`, a different value is `400 paper_not_allowed`. A mission may also carry `pageHint` (an integer from 1 to 9999) and `sourceSha256` (lowercase hex). Both are returned on `GET /v1/booth/config`.

Withdraw is one batch: the tombstone plus `DELETE FROM booth_files` for that id. It keeps the id, seq, receipt, course, PDF hash, PDF byte length, source hash, consent version, claim hash, and `created_at`. It sets `operator_note` to NULL and clears the nickname, paper, declared defects, public note, prize, AI summary, outcome, and publication time. `updated_at` becomes the withdraw time. `DELETE` deletes the row and the chunks together. Withdrawn rows do not count toward `BOOTH_SUBMISSIONS_PER_OWNER`. The admin PDF route answers `404 withdrawn` before it reads any chunk. The PDF hash stays on the row, so that owner cannot submit the same bytes again. A withdrawn row still accepts a later `operatorNote` patch. Any other patch updates only while `status <> 'withdrawn'`. If a withdraw lands after the read and before that update, the response is `409 withdrawn` and the tombstone stays.

A valid `fso_` bearer on `GET /v1/ai/capabilities` reports `blueJobs: true` and `modelJobs: true`. Unsigned and guest views report each flag false only when open access is on and that flag is explicitly false. `AI_GUEST_MODEL_JOBS` defaults to true. When it is false, a guest job must be RED and `applyOnly`; anything else is `403 guest_model_disabled` before upload lookup. A disabled BLUE job still returns `guest_blue_disabled`. `AI_MODEL_JOBS_OPERATOR_ONLY` defaults off and is `true` on the event Worker. When it is on, any job other than RED `applyOnly` from an owner other than `opr:booth` is `403 model_jobs_operator_only` before upload lookup, rate slots or the runtime, and non-operator capability views report both flags false. The operator can still start any job. When `AI_MODEL_JOBS_OPERATOR_ONLY` is on, that gate runs before the guest flags, so a non-operator job other than RED `applyOnly` is `model_jobs_operator_only` even if the guest flags are also off. When the flag is off, a disabled BLUE job is still `guest_blue_disabled` and a guest model job is still `guest_model_disabled`. `BOOTH_OPERATOR_TOKEN_BUDGET` defaults to 0. A positive value applies the existing owner token-budget gate to `opr:booth`.

`membership_required` and `open_access_disabled` are `403` with those codes, the same messages as `/v1/ai/*`, and they are not retryable. A Confluence session that refreshes inside the 60 second skew is copied onto booth success and error responses as `X-Falsify-Confluence-Session`. Every booth response sets `Access-Control-Expose-Headers` to `X-Falsify-Confluence-Session, Retry-After`, so the event page can read the wait on a `429` from the claim route, which has no session. `/v1/ai/*` and `/v1/papers/*` set the same value.

`BOOTH_PARSE_TIMING=1`, `BOOTH_TEST_SEQ_BIAS`, `BOOTH_TEST_PATCH_GATE`, and `BOOTH_TEST_PDF_GATE` are test-only. None of them is an operator var, and none is set in `wrangler.jsonc`. The timing header is `X-Falsify-Parse-Ms`. The seq bias makes the first insert attempt expect a later receipt number so the retry lands the real one. The two gates pause after the admin read, or after the PDF index check, until the test sets that `booth_settings` key to `go`. A 16 MiB submit measured in Miniflare on this worker took 2272.000 ms in the handler (`X-Falsify-Parse-Ms`, after auth through formData, the digest, and the insert) and 2335.084 ms of `dispatchFetch` wall time. The handler span stays under the event `cpu_ms` of 5000. Miniflare did not expose a tail `cpuTime`.

## Error codes

| Code | Status | When |
|---|---|---|
| `not_found` | 404 | Booth disabled, unknown path, unknown receipt, wrong claim key |
| `unauthorized` | 401 | Missing bearer, wrong or unset operator token, any other rejected session |
| `membership_required` | 403 | Password bearer whose team membership is not active |
| `open_access_disabled` | 403 | `fsg_` bearer while `AI_OPEN_ACCESS` is off |
| `forbidden` | 403 | Operator calling submit, or a non-operator calling an admin route |
| `booth_closed` | 403 | `submissionsOpen` is false |
| `guest_blue_disabled` | 403 | Guest `role:"blue"` job while `AI_GUEST_BLUE` is false. Checked before upload lookup, rate slots and runtime calls |
| `invalid_request` | 400 | Body shape, types, or lengths |
| `pii_not_allowed` | 400 | Nickname contains `@` or 7 consecutive digits |
| `paper_not_allowed` | 400 | Paper is missing, its source or license is not on the allowlist, or a mission `sourceSha256` does not match |
| `guest_model_disabled` | 403 | Guest job is not RED `applyOnly` while `AI_GUEST_MODEL_JOBS` is false. Checked before upload lookup |
| `model_jobs_operator_only` | 403 | A non-operator job is not RED `applyOnly` while `AI_MODEL_JOBS_OPERATOR_ONLY` is true. Checked after the guest gates and before upload lookup |
| `consent_outdated` | 409 | `consentVersion` is not `BOOTH_CONSENT_VERSION` |
| `invalid_pdf` | 400 | The PDF part is empty or does not start with `%PDF-` |
| `pdf_mismatch` | 400 | The PDF bytes do not match `editedSha256` |
| `pdf_unchanged` | 400 | The PDF hash equals `paper.sourceSha256` |
| `already_submitted` | 409 | This owner already submitted this PDF hash. Body also includes `receipt` |
| `withdrawn` | 409 or 404 | PATCH on a withdrawn row with anything other than `operatorNote` is 409. The admin PDF of a withdrawn row is 404 |
| `rate_limited` | 429 | Per-owner row cap, per-IP hour, global hour, or the claim-key bucket |
| `method_not_allowed` | 405 | Verb does not match the route |
| `length_required` | 411 | `POST /v1/booth/submissions` has no `Content-Length` |
| `payload_too_large` | 413 | Declared body over the PDF cap plus 64 KiB, or a PDF part over `BOOTH_MAX_PDF_BYTES`. JSON bodies over 64 KiB use the same code |
| `storage_full` | 503 | Stored PDF bytes plus this file would exceed `BOOTH_STORED_PDF_BYTES` |
| `unsupported_media_type` | 415 | Submissions require `multipart/form-data`. JSON routes require `application/json` |

`rate_limited` is retryable. `storage_full`, `length_required`, `membership_required`, `open_access_disabled` and `model_jobs_operator_only` are not. The other booth codes are not.

## Privacy

- No name, phone number or email is collected. A nickname is optional, at most 24 characters, and is rejected when it contains `@` or seven digits in a row.
- The claim key is returned once, in the 201 response. Only its SHA-256, prefixed with `booth-claim:v1:<receipt>:`, is stored. The key is not in the admin view.
- `owner_id` and `claim_hash` are never returned. The admin PDF is read from `booth_files`. It does not use `owner_id` and it does not call the runtime.
- Booth tables do not store an IP address, user agent or token. Rate limits use the existing truncated hash buckets.
- `aiSummary` is operator JSON (at most 16 KiB) and is never included in the visitor claim view.
- `prizeMessage`, `outcome`, `publicNote` and `publishedAt` are omitted from the claim view until the row is published. Withdraw clears those fields, the nickname, the paper, the declared defects, and the operator note, and it deletes the stored PDF chunks.
- On the event Worker, `AI_GUEST_BLUE=false`, `AI_GUEST_MODEL_JOBS=false` and `AI_MODEL_JOBS_OPERATOR_ONLY=true`. A guest cannot start a BLUE job or a model job. A password or Confluence owner cannot start one either, except a RED `applyOnly` job. Unsigned and other non-operator capability views report `blueJobs: false` and `modelJobs: false`. A valid operator bearer still sees both as true and can still start any job. When the operator-only flag is unset, the older guest flags decide.
