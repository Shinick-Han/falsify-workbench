# Open access guest sessions

Contract `falsify.cloud.v1` hosted AI routes, plus the fixed guest interface for an event page. Fake examples only. No new dependency. The Worker does not store the guest bearer, the access key, or the review prompt.

Open access is off unless `AI_OPEN_ACCESS` is the string `true`. Any other value, including an unset variable, leaves today's password and Confluence owners on the hosted AI routes and rejects guest bearers. `AI_HOSTING_ENABLED` still has to be `true`; with hosting off, `/v1/ai/guest` and the other execution routes stay `404`, the same as a deployment that has no hosted AI routes.

## POST /v1/ai/guest

Unsigned. `Content-Type: application/json`. Body `{}` or `{"accessKey":"<string, at most 128 characters>"}`. At most 1 KiB. `OPTIONS` is allowed. `GET` is `405`.

```http
POST /v1/ai/guest
Content-Type: application/json

{"accessKey":"booth-example-key"}
```

`201`, `Cache-Control: no-store`

```json
{"guest":{"token":"fsg_exampleGuestTokenNotASecret0123456789abc","expiresAt":"2026-11-18T18:00:00.000Z"}}
```

The token is `fsg_` plus 43 base64url characters (32 random bytes). `expiresAt` is ISO 8601.

- Hosting on and open access off: `403 open_access_disabled`.
- A non-empty `AI_OPEN_ACCESS_KEY` is required. Missing and wrong keys are both `403 invalid_access_key`. The compare is SHA-256 then a constant-time digest compare. The body is not echoed.
- Per-IP and global mint caps run before the key check and before the insert. Over the cap: `429 rate_limited` with `Retry-After`.
- Extra fields, a non-string key, or a key longer than 128 characters: `400 invalid_request`.
- Over 1 KiB: `413 payload_too_large`. Other content types: `415 unsupported_media_type`.
- A foreign `Origin` is `403 origin_not_allowed`, same as the other routes.

## Using the token

`Authorization: Bearer fsg_…` is accepted only on `/v1/ai/uploads`, `/v1/ai/jobs`, `/v1/ai/jobs/:id`, cancel, and artifacts. The owner id is `gst:<uuid v4>`, one per session. Uploads and jobs are isolated to that owner. Another owner's job is `404`, the same as a missing job.

While open access is off, every `fsg_` bearer on those routes is `403 open_access_disabled`, including a token that was issued earlier, a malformed `fsg_` string, and an expired one. While open access is on, expired, revoked, unknown, and malformed bearers are `401 unauthorized`.

Records, `/v1/me`, logout, password change, session revoke, and Confluence reject `fsg_` the same way they reject an unknown bearer. A guest token is not a password session and not a Confluence session.

## Capabilities

`GET /v1/ai/capabilities` stays public. The body always includes:

```json
"openAccess": {"enabled": false, "accessKeyRequired": false}
```

`enabled` follows `AI_OPEN_ACCESS`. `accessKeyRequired` is true only when open access is on and `AI_OPEN_ACCESS_KEY` is a non-empty string. When open access is off the pair is `false` / `false`, even if a key is still stored. The key value is never returned.

## Settings

All optional. Unset values use the default. Non-guest owners keep `AI_UPLOADS_PER_OWNER_HOUR`, `AI_JOBS_PER_OWNER_HOUR`, `AI_ACTIVE_JOBS_PER_OWNER`, `AI_MAX_CALLS_PER_JOB`, and `AI_OWNER_TOKEN_BUDGET`.

| Name | Kind | Default | Effect |
|---|---|---|---|
| `AI_OPEN_ACCESS` | var | off | `true` enables guest minting and `fsg_` bearers |
| `AI_OPEN_ACCESS_KEY` | secret | empty | non-empty requires `accessKey` on `POST /v1/ai/guest` |
| `AI_GUEST_SESSION_SECONDS` | var | `21600` | session lifetime |
| `AI_GUESTS_PER_IP_HOUR` | var | `10` | new sessions per IP per hour |
| `AI_GUESTS_PER_HOUR` | var | `600` | new sessions for the whole worker per hour |
| `AI_GUEST_UPLOADS_PER_OWNER_HOUR` | var | `10` | uploads for one `gst:` owner |
| `AI_GUEST_JOBS_PER_OWNER_HOUR` | var | `6` | jobs for one `gst:` owner |
| `AI_GUEST_ACTIVE_JOBS_PER_OWNER` | var | `1` | queued, running, or cancelling jobs for one guest |
| `AI_GUEST_MAX_CALLS_PER_JOB` | var | `8` | also capped by `AI_MAX_CALLS_PER_JOB` |
| `AI_GUEST_JOBS_PER_HOUR` | var | `150` | jobs for every `gst:` owner combined |
| `AI_GUEST_TOKEN_BUDGET` | var | `0` | `0` is off. Otherwise the sum of recorded terminal usage for every `gst:` owner in `AI_TOKEN_WINDOW_SECONDS` |
| `AI_TOKEN_WINDOW_SECONDS` | var | `86400` | existing window, shared with the per-owner budget |

IP buckets store a truncated hash. A failed access-key check still spends a mint slot.

## Worst case at the defaults

Paid calls per hour are bounded by the tighter of the per-guest product and the global job cap, then by calls per job:

`min(AI_GUESTS_PER_HOUR × AI_GUEST_JOBS_PER_OWNER_HOUR, AI_GUEST_JOBS_PER_HOUR) × min(AI_GUEST_MAX_CALLS_PER_JOB, AI_MAX_CALLS_PER_JOB)`

`min(600 × 6, 150) × min(8, 24) = 150 × 8 = 1200` provider calls per hour.

The per-guest product alone would be `600 × 6 × 8 = 28800`. The global job cap is what stops that. The active-job cap limits concurrency, not this hourly total, once jobs finish. Uploads are separate: `600 × 10 = 6000` guest uploads per hour. There is no second global upload cap. The token budget default `0` does not reduce the 1200. `applyOnly` jobs spend a job slot and make no provider call, so they do not add to the 1200.

An anonymous caller can mint sessions, upload, and run jobs until those caps. They cannot read another owner's jobs, records, or Confluence archives, and they cannot change a password or revoke a password session.

## Storage

Migration `0005_guest_sessions.sql` adds `guest_sessions`: `token_hash` (SHA-256, primary key), `guest_id`, `created_at`, `expires_at`, `revoked_at`, plus an index on `expires_at`. Apply it to the event database before the first mint. A revoked row is `401` while open access is on. There is no public revoke route; an operator sets `revoked_at` to a unix millisecond timestamp.

## Event deployment

This repo's `wrangler.jsonc` is not the event environment. Add a separate Worker env named `event` at deploy time:

- Worker name: `falsify-cloud-api-event`
- Its own D1 database and `migrations_dir`
- `ALLOWED_ORIGINS` includes `https://shinick-han.github.io` (exact origin, comma-separated, no paths)
- `AI_HOSTING_ENABLED` = `true`
- `AI_OPEN_ACCESS` = `true`
- `AI_RUNTIME_URL` for that environment's runtime origin
- Secret `HOSTED_AI_SERVICE_TOKEN` for that runtime
- Secret `AI_OPEN_ACCESS_KEY` when the event link should carry a key
- The guest vars in the table above
- The existing hosted AI vars the other environments already set (`AI_MAX_CALLS_PER_JOB` and the rest)

Do not put the access key or the service token in `vars` or in this file. Example names only:

```sh
npx wrangler secret put AI_OPEN_ACCESS_KEY --env event
npx wrangler secret put HOSTED_AI_SERVICE_TOKEN --env event
npx wrangler d1 migrations apply <event-database-name> --env event --remote
```

Those commands are for the operator at deploy time.

## Kill switch

Set the var `AI_OPEN_ACCESS` to `false` and redeploy. Minting returns `403 open_access_disabled`. Every `fsg_` bearer on `/v1/ai/*` returns the same `403`, including sessions that were already issued. Password sessions and Confluence sessions keep working. Hosting can stay on.

Rotating or deleting `AI_OPEN_ACCESS_KEY` only changes which new mints succeed. It does not reject a token that was already issued. The kill switch is `AI_OPEN_ACCESS`, not the secret.

To drop one session without turning the feature off, set that row's `revoked_at`. The bearer itself is not in the database; match `token_hash`.
