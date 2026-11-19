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

Event vars (already in `wrangler.jsonc`, not secrets): `AI_GUESTS_PER_IP_HOUR=600`, `AI_GUESTS_PER_HOUR=800`, `AI_GUEST_UPLOADS_PER_HOUR=400`, `AI_GUEST_JOBS_PER_OWNER_HOUR=20`, `AI_GUEST_APPLY_JOBS_PER_HOUR=600`, `AI_GUEST_BLUE=false`, `AI_GUEST_MODEL_JOBS=false`, `BOOTH_ENABLED=true`, `BOOTH_CONSENT_VERSION=2026-11-22.v1`, `BOOTH_SUBMISSIONS_PER_IP_HOUR=400`, `BOOTH_CLAIMS_PER_IP_HOUR=2000`, `BOOTH_CLAIMS_PER_HOUR=5000`, `BOOTH_OPERATOR_ACTIVE_JOBS=2`, `PAPER_SEARCH_ENABLED=true`, `PAPER_SEARCH_PER_IP_HOUR=2000`, `PAPER_PDF_PER_IP_HOUR=600`. Production and staging vars are unchanged.

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

`GET /v1/booth/admin/submissions` takes `status` (comma-separated), `after` (seq cursor, exclusive) and `limit` (1..200, default 100). The page is ordered by `seq`. `nextAfter` is the last seq on the page when another row remains, otherwise null.

`POST /v1/booth/submissions` is `multipart/form-data` with exactly two parts: `meta` (JSON text) and `pdf` (the edited PDF). `meta` is the submission object without `jobId`, plus `editedSha256` (lowercase hex SHA-256 of the PDF bytes) and optional `paper.sourceSha256` (lowercase hex). The operator bearer is still `403 forbidden` before the body is read.

`BOOTH_MAX_PDF_BYTES` defaults to `AI_GUEST_MAX_UPLOAD_BYTES` when that is a positive integer, otherwise 20 MiB. The resolved value is capped at 32 MiB. The whole multipart body must be at most that limit plus 64 KiB (`413 payload_too_large`). The PDF part has the same byte cap. It must be non-empty and start with `%PDF-`. The server SHA-256 must equal `editedSha256`, and it must differ from `paper.sourceSha256` when that field is present. The same owner and the same PDF hash is `409 already_submitted` with the earlier receipt. A different owner may submit those same bytes.

The PDF is stored in `booth_files` as 512 KiB BLOBs, in one `db.batch` with the submission row. `pdf_sha256`, `pdf_bytes` and `source_sha256` are columns on `booth_submissions`. There is no `job_id` or `artifact_id`. Visitor submission does not call the runtime.

The admin PDF route reads those chunks in `idx` order and returns `application/pdf` with `X-Falsify-Pdf-Sha256`. The file name is the receipt. The admin view has `pdfSha256`, `pdfBytes` and `sourceSha256` instead of `jobId` and `artifactId`.

Checks run in this order: authentication, `Content-Type` and the whole-body cap, multipart and `meta` shape (including the paper allowlist and the nickname), `submissionsOpen`, consent, then the PDF checks (magic, part length, hash, source hash, duplicate), the owner cap, and the rate buckets.

Claim and withdraw share one per-IP hourly bucket (`BOOTH_CLAIMS_PER_IP_HOUR`, default 120) and one global hourly bucket (`BOOTH_CLAIMS_PER_HOUR`, default 2000). A global rejection gives the per-IP slot back. Receipt numbers retry up to 5 times on a seq collision.

`paper.source` must be `arxiv` or `mission`. `paper.license` must be `cc-by`, `cc-by-<n.n>`, `cc-by-sa`, `cc-by-sa-<n.n>`, `cc0`, `cc0-1.0`, or `public-domain`. Anything else, including a missing paper, is `400 paper_not_allowed`.

Withdraw is a tombstone. It keeps the id, seq, receipt, course, PDF hash, PDF byte length, source hash, consent version, claim hash, operator note, and timestamps, and it clears the nickname, paper, declared defects, public note, prize, AI summary, outcome, and publication time. It also deletes that submission's `booth_files` rows. `DELETE` deletes the row and the chunks together. `created_at` stays; `updated_at` becomes the withdraw time. Withdrawn rows do not count toward `BOOTH_SUBMISSIONS_PER_OWNER`. The admin PDF route answers `404 withdrawn` before it reads any chunk. The PDF hash stays on the row, so that owner cannot submit the same bytes again.

A valid `fso_` bearer on `GET /v1/ai/capabilities` reports `blueJobs: true` and `modelJobs: true`. Unsigned and guest views report each flag false only when open access is on and that flag is explicitly false. `AI_GUEST_MODEL_JOBS` defaults to true. When it is false, a guest job must be RED and `applyOnly`; anything else is `403 guest_model_disabled` before upload lookup. A disabled BLUE job still returns `guest_blue_disabled`.

## Error codes

| Code | Status | When |
|---|---|---|
| `not_found` | 404 | Booth disabled, unknown path, unknown receipt, wrong claim key |
| `unauthorized` | 401 | Missing bearer, wrong or unset operator token, any other rejected session |
| `forbidden` | 403 | Operator calling submit, or a non-operator calling an admin route |
| `booth_closed` | 403 | `submissionsOpen` is false |
| `guest_blue_disabled` | 403 | Guest `role:"blue"` job while `AI_GUEST_BLUE` is false. Checked before upload lookup, rate slots and runtime calls |
| `invalid_request` | 400 | Body shape, types, or lengths |
| `pii_not_allowed` | 400 | Nickname contains `@` or 7 consecutive digits |
| `paper_not_allowed` | 400 | Paper is missing, or its source or license is not on the allowlist |
| `guest_model_disabled` | 403 | Guest job is not RED `applyOnly` while `AI_GUEST_MODEL_JOBS` is false. Checked before upload lookup |
| `consent_outdated` | 409 | `consentVersion` is not `BOOTH_CONSENT_VERSION` |
| `invalid_pdf` | 400 | The PDF part is empty or does not start with `%PDF-` |
| `pdf_mismatch` | 400 | The PDF bytes do not match `editedSha256` |
| `pdf_unchanged` | 400 | The PDF hash equals `paper.sourceSha256` |
| `already_submitted` | 409 | This owner already submitted this PDF hash. Body also includes `receipt` |
| `withdrawn` | 409 or 404 | PATCH on a withdrawn row with anything other than `operatorNote` is 409. The admin PDF of a withdrawn row is 404 |
| `rate_limited` | 429 | Per-owner row cap, per-IP hour, global hour, or the claim-key bucket |
| `method_not_allowed` | 405 | Verb does not match the route |
| `payload_too_large` | 413 | Multipart body over the PDF cap plus 64 KiB, or a PDF part over `BOOTH_MAX_PDF_BYTES`. JSON bodies over 64 KiB use the same code |
| `unsupported_media_type` | 415 | Submissions require `multipart/form-data`. JSON routes require `application/json` |

`rate_limited` is retryable. The other booth codes are not.

## Privacy

- No name, phone number or email is collected. A nickname is optional, at most 24 characters, and is rejected when it contains `@` or seven digits in a row.
- The claim key is returned once, in the 201 response. Only its SHA-256, prefixed with `booth-claim:v1:<receipt>:`, is stored. The key is not in the admin view.
- `owner_id` and `claim_hash` are never returned. The admin PDF is read from `booth_files`. It does not use `owner_id` and it does not call the runtime.
- Booth tables do not store an IP address, user agent or token. Rate limits use the existing truncated hash buckets.
- `aiSummary` is operator JSON (at most 16 KiB) and is never included in the visitor claim view.
- `prizeMessage`, `outcome`, `publicNote` and `publishedAt` are omitted from the claim view until the row is published. Withdraw clears those fields, the nickname, the paper, and the declared defects, and it deletes the stored PDF chunks.
- On the event Worker, `AI_GUEST_BLUE=false` and `AI_GUEST_MODEL_JOBS=false`. A guest cannot start a BLUE job or a model job. Unsigned and guest capability views report `blueJobs: false` and `modelJobs: false`. A valid operator bearer still sees both as true. When either flag is unset, that kind of guest job stays allowed and the matching capability stays true.
