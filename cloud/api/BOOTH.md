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

Event vars (already in `wrangler.jsonc`, not secrets): `BOOTH_ENABLED=true`, `BOOTH_CONSENT_VERSION=2026-11-22.v1`, `AI_GUEST_BLUE=false`, `PAPER_SEARCH_ENABLED=true`, `AI_GUESTS_PER_IP_HOUR=600`, `AI_GUEST_APPLY_JOBS_PER_HOUR=600`.

## Routes

Preflight answers `OPTIONS` with methods `GET, POST, PATCH, PUT, DELETE, OPTIONS` and headers `Authorization, Content-Type`. JSON errors use the hosted AI envelope (`error.code`, `error.message`, `error.requestId`, `error.retryable`) plus `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

| Method | Path | Auth | Success |
|---|---|---|---|
| GET | `/v1/booth/config` | none | 200 config |
| POST | `/v1/booth/submissions` | guest, password, or Confluence owner | 201 receipt and claim key |
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

The PDF route streams the stored `edited.pdf` from the runtime as that submission's owner, not as `opr:booth`. The file name is the receipt.

Claim and withdraw share one per-IP hourly bucket (`BOOTH_CLAIMS_PER_IP_HOUR`, default 120) so the two key checks cannot be alternated to double the guess rate.

## Error codes

| Code | Status | When |
|---|---|---|
| `not_found` | 404 | Booth disabled, unknown path, unknown or foreign job, unknown receipt, wrong claim key |
| `unauthorized` | 401 | Missing bearer, wrong or unset operator token, any other rejected session |
| `forbidden` | 403 | Operator calling submit, or a non-operator calling an admin route |
| `booth_closed` | 403 | `submissionsOpen` is false |
| `guest_blue_disabled` | 403 | Guest `role:"blue"` job while `AI_GUEST_BLUE` is false. Checked before upload lookup, rate slots and runtime calls |
| `invalid_request` | 400 | Body shape, types, or lengths |
| `pii_not_allowed` | 400 | Nickname contains `@` or 7 consecutive digits |
| `consent_outdated` | 409 | `consentVersion` is not `BOOTH_CONSENT_VERSION` |
| `job_not_ready` | 409 | Job is not a completed RED apply-only job with `edited.pdf` |
| `already_submitted` | 409 | That job was already submitted. Body also includes `receipt` |
| `withdrawn` | 409 | PATCH on a withdrawn row with anything other than `operatorNote` |
| `rate_limited` | 429 | Per-owner row cap, per-IP hour, global hour, or the claim-key bucket |
| `artifact_expired` | 404 | Runtime no longer has the edited PDF |
| `method_not_allowed` | 405 | Verb does not match the route |
| `payload_too_large` | 413 | JSON body over 64 KiB |
| `unsupported_media_type` | 415 | JSON routes require `application/json` |

`rate_limited` is retryable. The other booth codes are not.

## Privacy

- No name, phone number or email is collected. A nickname is optional, at most 24 characters, and is rejected when it contains `@` or seven digits in a row.
- The claim key is returned once, in the 201 response. Only its SHA-256, prefixed with `booth-claim:v1:<receipt>:`, is stored. The key is not in the admin view.
- `owner_id` and `claim_hash` are never returned. The admin PDF proxy uses `owner_id` only as the runtime owner header.
- Booth tables do not store an IP address, user agent or token. Rate limits use the existing truncated hash buckets.
- `aiSummary` is operator JSON (at most 16 KiB) and is never included in the visitor claim view.
- `prizeMessage`, `outcome`, `publicNote` and `publishedAt` are omitted from the claim view until the row is published. Withdraw clears the prize and the publication timestamp.
- On the event Worker, `AI_GUEST_BLUE=false`. A guest cannot start a BLUE job. Unsigned and guest capability views report `blueJobs: false`. When `AI_GUEST_BLUE` is unset, guest BLUE stays allowed and `blueJobs` stays true.
