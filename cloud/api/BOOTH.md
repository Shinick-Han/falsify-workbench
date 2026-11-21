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

Event vars (already in `wrangler.jsonc`, not secrets): `AI_GUESTS_PER_IP_HOUR=3000`, `AI_GUESTS_PER_HOUR=4000`, `AI_GUEST_UPLOADS_PER_HOUR=400`, `AI_GUEST_JOBS_PER_OWNER_HOUR=20`, `AI_GUEST_APPLY_JOBS_PER_HOUR=600`, `AI_GUEST_BLUE=false`, `AI_GUEST_MODEL_JOBS=false`, `AI_MODEL_JOBS_OPERATOR_ONLY=true`, `BOOTH_ENABLED=true`, `BOOTH_CONSENT_VERSION=2026-11-22.v3`, `BOOTH_SUBMISSIONS_PER_OWNER=3`, `BOOTH_SUBMISSIONS_PER_IP_HOUR=2000`, `BOOTH_CLAIMS_PER_IP_HOUR=40000`, `BOOTH_CLAIMS_PER_HOUR=75000`, `BOOTH_OPERATOR_ACTIVE_JOBS=2`, `BOOTH_MAX_PDF_BYTES=16777216`, `BOOTH_STORED_PDF_BYTES=3221225472`, `PAPER_SEARCH_ENABLED=true`, `PAPER_SEARCH_PER_IP_HOUR=10000`, `PAPER_PDF_PER_IP_HOUR=3000`, `AI_PAPER_TOOLS_ENABLED=false`. The operator may turn `AI_PAPER_TOOLS_ENABLED` back on. The event environment also sets `limits.cpu_ms` to 5000. Production stays at 1000. Production and staging vars are unchanged. `BOOTH_OPERATOR_TOKEN_BUDGET` is not an event var. It defaults to 0, which leaves the operator token-budget gate off.

## Routes

Preflight answers `OPTIONS` with methods `GET, POST, PATCH, PUT, DELETE, OPTIONS` and headers `Authorization, Content-Type`. JSON errors use the hosted AI envelope (`error.code`, `error.message`, `error.requestId`, `error.retryable`) plus `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

| Method | Path | Auth | Success |
|---|---|---|---|
| GET | `/v1/booth/config` | none | 200 config |
| POST | `/v1/booth/submissions` | guest, password, or Confluence owner | 201 receipt and claim key. `multipart/form-data` with `meta` and `pdf`. `paper` is required |
| POST | `/v1/booth/claim` | none | 200 claim view |
| GET | `/v1/booth/claim?receipt=&key=` | none | 200 claim view. Result polling: a CORS simple request (no preflight) that reads one row and spends no rate-limit slot while the key is right; the 40-bit claim key protects it. Failed key checks draw from small per-isolate buckets (20 per IP or IPv6 /64, refill 1 per 6 s; 200 per isolate); when one is empty the GET is charged to the POST claim buckets before the key is checked, so a 429 there says Retry-After ≤ 60. Query strings are redacted from Workers logs and traces (`observability.redact_query_string`). Exactly these two query keys |
| POST | `/v1/booth/withdraw` | none (same body as claim) | 200 claim view, status `withdrawn` |
| GET | `/v1/booth/admin/submissions` | operator | 200 page |
| GET | `/v1/booth/admin/submissions/:receipt` | operator | 200 admin view |
| GET | `/v1/booth/admin/submissions/:receipt/pdf` | operator | 200 `application/pdf` |
| PATCH | `/v1/booth/admin/submissions/:receipt` | operator | 200 admin view |
| DELETE | `/v1/booth/admin/submissions/:receipt` | operator | 204 |
| GET | `/v1/booth/admin/settings` | operator | 200 settings |
| PUT | `/v1/booth/admin/settings` | operator | 200 settings |

The operator bearer is rejected on `POST /v1/booth/submissions` with `403 forbidden`. Any other valid bearer on an admin route is `403 forbidden`. A missing bearer is `401 unauthorized`.

`GET /v1/booth/config` needs no bearer and does not write. `limits` is integers only. It keeps `maxDeclared` (5, the same maximum the submit parser enforces), `maxReason` (500), and `maxNickname` (24). It also returns `maxPdfBytes`, the effective PDF cap, and `perOwner`, from `BOOTH_SUBMISSIONS_PER_OWNER` (code default 5; the event Worker sets 3). `maxPdfBytes` is `BOOTH_MAX_PDF_BYTES` when that is a positive integer, otherwise `AI_GUEST_MAX_UPLOAD_BYTES` when that is a positive integer, otherwise 20971520, and never above 33554432. The event Worker therefore publishes 16777216, which is the number the page uses for "16MB 이하". The object does not include secrets, hourly caps, or the storage cap.

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

Claim views of unpublished `received` or `reviewing` rows carry `queue: {ahead, slots, etaSec}`: `ahead` is the number of `received` rows with a lower seq, `slots` is `BOOTH_OPERATOR_ACTIVE_JOBS` (default 4), and `etaSec` is `(floor(ahead/slots)+1) * BOOTH_ETA_JOB_SECONDS` (default 120), or for a `reviewing` row the job time left since it entered review (at least 15). It is an estimate for the visitor, computed in the same query. A `429` on POST claim or withdraw says `Retry-After` of at most 60 seconds.

## Recipes and agents

Visitors may let an AI plant the defect. An agent never submits: it posts a recipe draft, and a human opens the returned link on the event page, reviews the before/after, consents and submits. Contract: recipe contract v1 (`falsify.booth.recipe.v1`). Code: `src/booth-recipes.mjs`; migration `0007_booth_recipes.sql` (apply it with the same operator command as 0006).

| Method | Path | Auth | Success |
|---|---|---|---|
| POST | `/v1/booth/recipes` | none | 201 `{code, url, expiresAt}` |
| GET | `/v1/booth/recipes/:code` | none | 200 recipe plus `code`, `createdAt`, `expiresAt` |
| GET | `/v1/booth/missions` | none | 200 `{missions:[...]}`, the same list `GET /v1/booth/config` shows |
| GET | `/v1/booth/missions/:paperId/text` | none | 200 `{paperId, title, license, url, pages:[{page, text}]}` |
| POST, OPTIONS | `/mcp` | none | the agent MCP module (`src/agent-mcp.mjs`); OPTIONS is a 204 preflight |

- All of these are `404 not_found` unless `BOOTH_ENABLED` is true. They skip the exact-origin gate, so any Origin (browser MCP clients, hosted connectors) may call them. They answer `Access-Control-Allow-Origin: *` with no credentials header, including on errors and on the `OPTIONS` preflight. The `/v1/booth/*` preflight allows `Content-Type`. Every other booth route, including `/v1/booth/config`, the admin routes and submissions, keeps the exact-origin gate. Agents read missions from `GET /v1/booth/missions`.
- POST body: JSON, at most 8 KB (`413 payload_too_large`), `application/json` (`415`). Validation follows contract section 1: `paperId` is a new- or old-style arXiv id; 1 to 5 `edits` with `find` (1..300, not blank), `replace` (0..300, different from `find`), optional `page` (1..500) and `context` (<=600); optional `defectType`, `reason` (<=500), `agent.name`/`agent.model` (<=60). Lengths count Unicode code points (`[...s].length`), not UTF-16 units, so an emoji or math letter counts as 1; the event page counts the same way. Unknown keys are rejected. These are rejected in every string: C0 controls, DEL, C1 controls (U+0080–U+009F) and the bidi controls U+200E, U+200F, U+202A–U+202E and U+2066–U+2069. A newline is allowed only in `reason` and `context`. A failure is `400 invalid_request` with `error.field` naming the first bad field. `source` is stored as `agent` whatever the body said. The server has no page text for arbitrary papers, so whether `find` occurs in the page is checked by the event page when it applies the recipe.
- The code is `R-` plus 6 Crockford base32 characters from `crypto.getRandomValues`; a collision retries up to 5 times. Lookups are case-insensitive, tolerate a missing dash and map O to 0 and I/L to 1. The url is `EVENT_PAGE_URL#recipe=<code>`.
- Recipes live 6 hours in `booth_recipes`. Each write first deletes expired rows. An expired or unknown code is `404 not_found`. No IP, user agent or token is stored.
- Rate limits: `BOOTH_RECIPES_PER_IP_HOUR` (default 120) and `BOOTH_RECIPES_PER_HOUR` (default 5000) on POST and on MCP recipe creation, in `rate_counters` with hashed bucket names. Over either is `429 rate_limited` with `Retry-After`, and the same seconds in `error.retryAfterSeconds` (also `error.retryAfter`) because MCP callers only see the body; a global rejection gives the per-IP slot back. `GET /v1/booth/recipes/:code` has its own per-IP bucket, `BOOTH_RECIPE_READS_PER_IP_HOUR` (default 600), with the same 429 shape, so codes cannot be enumerated cheaply. Every per-IP bucket keys IPv4 as-is and IPv6 on its /64 prefix (an IPv4-mapped address counts as its IPv4), because one client usually holds a whole /64. `EVENT_PAGE_URL` defaults to the GitHub Pages event page. All four are event vars.
- Mission text is the static `src/booth-mission-text.json` (`falsify.booth.mission-text.v1`), bundled at build time. A paper is served only when it is in that file AND in the current mission list from booth settings (the list `GET /v1/booth/config` shows, compared without the arXiv version suffix); otherwise `404`. `missionText` in the MCP deps applies the same rule. Old-style ids may be sent raw or with `%2F`.
- `/mcp`: POST calls `handleAgentMcp(request, env, {createRecipe, missionsList, missionText})`. The Worker answers `OPTIONS` itself with a 204 preflight: `Access-Control-Allow-Origin: *`, methods `POST, OPTIONS`, headers `Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Authorization`. GET and DELETE are `405` with `Allow: POST, OPTIONS`. Every `/mcp` response carries `Access-Control-Allow-Origin: *`. `create_recipe` rejects unknown argument keys with an `isError` result that names them; `schema` and `source` are tolerated, and `source` is forced to `agent`. The MCP server name is `falsify-booth`.

Submissions accept two optional `meta` keys: `assist` (`manual`, `my-ai` or `agent`; default `manual`) and `recipeCode` (only with `agent`, the `R-XXXXXX` format, case-insensitive; the recipe need not still exist). Anything else is `400 invalid_request`. Both are stored (`assist`, `recipe_code`) and returned by the operator list and detail views as `assist` and `recipeCode`; rows from before 0007 read as `manual` and `null`. Claim views do not include them. AI-planted and manual entries are equally eligible for prizes. The operator CLI shows `assist` in `list`, `export --format submissions|jsonl` and `final` candidates.

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
