# Booth submission contract (AWS Community Day, 2026-11-22)

Status: binding for the booth workers. Base branch: `feat/booth-submissions-20261120`.
Orchestrator: Claude Code seat (integration, review, docs, CHANGELOG, deploy). Workers never push,
deploy, apply D1 migrations remotely, or post to Jira/Confluence.

## 1. Flow

1. A visitor scans the booth QR -> `event.html` (guest open access, existing `fsg_` session).
2. The visitor picks a **mission paper** or **searches** CC BY / CC BY-SA / CC0 arXiv papers. The PDF is
   fetched through the event Worker and opened in the existing paper intake.
3. The visitor plants defects with the existing RED editor and applies them with the existing hosted
   **RED applyOnly** job (no model call). The runtime produces `edited.pdf`.
4. A booth panel shows the applied edits pre-filled. The visitor adds, per edit, a defect type and a
   reason, picks a course (quick / deep), ticks consent, and submits. The server returns a
   **receipt** (`F-0042`) and a **claim key** (`7Q3K-M9XD`). No name, phone or email is collected.
5. Near closing the operator runs BLUE in batch from the operator CLI with freely configurable
   settings, judges, and publishes outcomes and prize messages.
6. The visitor opens `event.html#booth-result`, enters receipt + claim key (pre-filled from this
   phone's localStorage), and sees status, outcome and the prize message (e.g. a gift code or
   "show this screen at the booth").
7. Guests can never start BLUE on the event deployment (server-enforced, UI hidden).

## 2. Ownership (disjoint files; touching anything else needs orchestrator approval)

| Worker | Branch | Owns |
|---|---|---|
| API | `booth/api` | `cloud/api/src/booth.mjs` (new), `cloud/api/src/ai-identity.mjs`, `cloud/api/src/ai-gateway.mjs`, `cloud/api/src/index.js`, `cloud/api/migrations/0006_booth.sql` (new), `cloud/api/wrangler.jsonc`, `cloud/api/test/booth.test.mjs` (new), `cloud/api/BOOTH.md` (new) |
| SEARCH | `booth/search` | `cloud/api/src/paper-search.mjs` (new), `cloud/api/test/paper-search.test.mjs` (new), `cloud/api/PAPER-SEARCH.md` (new) |
| FE | `booth/fe` | `app/dist/booth.js` (new), `app/dist/booth.css` (new), `app/dist/hosted-ai.js`, `scripts/build-event-page.mjs`, `scripts/event-page.spec.mjs`, `app/dist/event.html` (generated), `app/dist/cloud-config.event.js` (generated), `app/tests/booth.spec.mjs` (new), `app/scripts/test.mjs` (registration line only) |
| OPS | `booth/ops` | `tools/booth/**` (new) |
| Orchestrator | base branch | this file, `docs/privacy.md`, `CHANGELOG.md`, version files, the one-line paper-search mount in `index.js` at integration |

`app/dist/index.html` and the default `cloud-config.js` must not change. Production behaviour must be
identical when the new env vars are unset.

## 3. Identities

- Guest: `gst:<uuid>` from an `fsg_` bearer (unchanged).
- **Operator**: bearer `fso_` + 43 base64url chars (`/^fso_[A-Za-z0-9_-]{43}$/`). Valid only when the Worker
  secret `BOOTH_OPERATOR_TOKEN` is set, matches that pattern, and equals the bearer (compare SHA-256
  digests in constant time). Owner id `opr:booth`; `resolveAiOwner` returns
  `{ ownerId: 'opr:booth', kind: 'operator', refreshed: null }`. Works whether or not open access is on.
  Secret unset or mismatched: 401 `unauthorized`. `OWNER_ID` accepts `opr:booth`.
- The runtime owner regex already accepts `opr:booth`; no runtime change is allowed or needed.

## 4. Gateway changes (API worker, `ai-gateway.mjs`)

| Env var | Default (unset) | Meaning |
|---|---|---|
| `AI_GUEST_BLUE` | `true` | `false`: a guest `role:'blue'` job is 403 `guest_blue_disabled` before any upload lookup, rate slot or runtime call |
| `BOOTH_OPERATOR_JOBS_PER_HOUR` | 600 | operator replacement for `jobsPerOwnerHour` |
| `BOOTH_OPERATOR_ACTIVE_JOBS` | 4 | operator `activeJobsPerOwner` |
| `BOOTH_OPERATOR_UPLOADS_PER_HOUR` | 600 | operator `uploadsPerOwnerHour` |
| `BOOTH_OPERATOR_MAX_CALLS_PER_JOB` | `AI_MAX_CALLS_PER_JOB` | operator `maxCallsPerJob` (hard cap 64) |
| `BOOTH_OPERATOR_TOKEN_BUDGET` | 0 (no gate) | operator `ownerTokenBudget` |
| `AI_GUEST_APPLY_JOBS_PER_HOUR` | `AI_GUEST_JOBS_PER_HOUR` | global hourly cap for guest **applyOnly** RED jobs (no model call). When set, applyOnly jobs count against this bucket instead of the model-job bucket `AI_GUEST_JOBS_PER_HOUR`; unset keeps today's single bucket |

- `effectiveAiSettings` applies the operator overrides for `opr:booth`. The operator may use every
  model and effort in `AI_MODELS` / `AI_EFFORTS`, any prompt, harness, `maxCalls` and `useEvidence`
  the existing job contract accepts. Nothing about the operator's BLUE settings is fixed server-side.
- Event env values (`env.event.vars` in `wrangler.jsonc`; production env untouched): `BOOTH_ENABLED: "true"`,
  `BOOTH_CONSENT_VERSION: "2026-11-22.v1"`, `AI_GUEST_BLUE: "false"`, `PAPER_SEARCH_ENABLED: "true"`,
  `AI_GUESTS_PER_IP_HOUR: "600"` (venue Wi-Fi NAT), `AI_GUEST_APPLY_JOBS_PER_HOUR: "600"`. The secret
  `BOOTH_OPERATOR_TOKEN` is documented in `cloud/api/BOOTH.md`, never committed.
- Capabilities gain one boolean, `blueJobs`: `false` for unsigned and guest views when
  `AI_OPEN_ACCESS` is on and `AI_GUEST_BLUE` is `false`; otherwise `true`.

## 5. Booth API (API worker, `booth.mjs`)

Module exports `matchBooth(pathname)` -> `{ template, params } | null` and `handleBoothRequest(ctx)`
with the same `ctx` that `handleAiRequest` receives (`{ request, env, url, match, fetchImpl, deps }`).
It answers its own OPTIONS preflight (methods `GET, POST, PATCH, PUT, DELETE, OPTIONS`, headers
`Authorization, Content-Type`) and uses the same JSON error envelope, `Cache-Control: no-store` and
`nosniff` headers as `/v1/ai/*`. `index.js` routes `/v1/booth/*` to it before the Confluence and
legacy routers. `BOOTH_ENABLED` not `"true"`: every `/v1/booth/*` path is 404 `not_found` before auth.

### 5.1 D1 (`0006_booth.sql`)

```sql
CREATE TABLE booth_submissions (
  id TEXT PRIMARY KEY,                 -- uuid
  seq INTEGER NOT NULL UNIQUE,         -- 1, 2, 3 ...
  receipt TEXT NOT NULL UNIQUE,        -- 'F-' || printf('%04d', seq)
  claim_hash TEXT NOT NULL,            -- sha256hex('booth-claim:v1:' || receipt || ':' || normalizedKey)
  owner_id TEXT NOT NULL,              -- submitting owner; never returned by any route
  job_id TEXT NOT NULL UNIQUE,         -- guest RED applyOnly job
  artifact_id TEXT NOT NULL,           -- that job's edited.pdf artifact
  course TEXT NOT NULL CHECK (course IN ('quick', 'deep')),
  nickname TEXT,
  declared TEXT NOT NULL,              -- JSON array, see 5.3
  paper TEXT,                          -- JSON object or NULL
  consent_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'reviewing', 'judged', 'invalid', 'withdrawn')),
  outcome TEXT CHECK (outcome IN ('missed', 'caught', 'partial', 'invalid')),
  operator_note TEXT,
  public_note TEXT,
  prize_message TEXT,
  ai_summary TEXT,                     -- operator JSON, <= 16 KiB, never shown to visitors
  published_at TEXT,
  created_at TEXT NOT NULL,            -- ISO 8601 UTC
  updated_at TEXT NOT NULL
);
CREATE INDEX booth_submissions_owner ON booth_submissions (owner_id, created_at);
CREATE INDEX booth_submissions_status ON booth_submissions (status, seq);
CREATE TABLE booth_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
```

No IP, user agent or token is stored in these tables.

### 5.2 Receipt and claim key

- Receipt `F-` + 4-digit zero-padded seq (5+ digits past 9999). Seq is allocated in the INSERT
  (`COALESCE(MAX(seq), 0) + 1`), retried once on a UNIQUE conflict.
- Claim key: 8 random chars from Crockford base32 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, shown as
  `XXXX-XXXX`. Normalize input: uppercase, drop `-` and spaces, `O->0`, `I->1`, `L->1`. Returned once, only in the 201 response.

### 5.3 Visitor routes

`GET /v1/booth/config` (no auth, no D1 write) ->
```json
{ "enabled": true, "submissionsOpen": true, "consentVersion": "2026-11-22.v1",
  "courses": [{"id":"quick","label":"빠른 코스"},{"id":"deep","label":"정밀 코스"}],
  "defectTypes": [{"id":"number","label":"수치·통계"},{"id":"figure","label":"그림·표"},
    {"id":"citation","label":"인용·출처"},{"id":"logic","label":"논리·결론"},
    {"id":"method","label":"방법·실험 설계"},{"id":"other","label":"기타"}],
  "limits": {"maxDeclared":5,"maxReason":500,"maxNickname":24},
  "missions": [], "announcement": null }
```
`submissionsOpen`, `missions` and `announcement` come from `booth_settings` (keys `submissions_open`,
`missions`, `announcement`); when a key is absent `submissionsOpen` falls back to env
`BOOTH_SUBMISSIONS_OPEN` (default `true`). `consentVersion` is env `BOOTH_CONSENT_VERSION`
(default `2026-11-22.v1`). Mission: `{ id (slug <= 40), title (<= 300), source: "arxiv", paperId, license, course: "quick"|"deep"|"any", hint (<= 300) }`.

`POST /v1/booth/submissions` (owner bearer: guest, password or Confluence; operator -> 403 `forbidden`)
```json
{ "jobId": "<uuid>", "course": "quick",
  "declared": [{ "pageIndex": 3, "segmentId": "p4-s2", "before": "p < 0.05", "after": "p < 0.5",
                 "defectType": "number", "reason": "유의수준을 바꿔 결론이 성립하지 않음" }],
  "paper": { "source": "arxiv", "id": "2503.10497", "title": "...", "license": "cc-by-4.0" },
  "nickname": "부스방문자", "consentVersion": "2026-11-22.v1" }
```
- Exact keys only. `declared`: 1..5 items; `pageIndex` int 0..9999; `before` 1..2000 chars;
  `after` 0..2000; `defectType` one of the ids above; `reason` 1..500; `segmentId` optional <= 120.
  `paper` optional (`source` in `arxiv|mission|upload`, `id` <= 64, `title` <= 300, `license` <= 40).
  `nickname` optional 1..24, no control chars; containing `@` or 7+ consecutive digits -> 400
  `pii_not_allowed`. Any other shape -> 400 `invalid_request`.
- Order of checks: `submissionsOpen` false -> 403 `booth_closed`; consent version differs -> 409
  `consent_outdated`; job not found or not the caller's -> 404 `not_found`; job not
  (role red, applyOnly, state completed, has an `edited.pdf` artifact) -> 409 `job_not_ready`
  (read the stored D1 snapshot; if it lacks artifacts, one live runtime GET with the caller's owner);
  same job already submitted -> 409 `already_submitted` with body `{ "error": ..., "receipt": "F-0042" }`;
  more than `BOOTH_SUBMISSIONS_PER_OWNER` (5) rows for this owner, `BOOTH_SUBMISSIONS_PER_IP_HOUR`
  (60) per IP or `BOOTH_SUBMISSIONS_PER_HOUR` (600) global -> 429 `rate_limited` (use `deps.rateLimit`).
- 201 -> `{ "receipt": "F-0042", "claimKey": "7Q3K-M9XD", "status": "received", "course": "quick", "declaredCount": 1, "createdAt": "..." }`

`POST /v1/booth/claim` (no auth; `{ receipt, claimKey }`; per-IP `BOOTH_CLAIMS_PER_IP_HOUR` 120) ->
`{ receipt, status, course, declaredCount, createdAt, published, outcome?, publicNote?, prizeMessage?, publishedAt? }`;
the last four only while published. Unknown receipt and wrong key are the same 404 `not_found`.

`POST /v1/booth/withdraw` (same body and limits) -> status `withdrawn`, clears prize and publication;
returns the claim view.

### 5.4 Operator routes (`fso_` bearer only; no bearer 401, any other valid bearer 403 `forbidden`)

AdminView = `{ id, seq, receipt, status, course, nickname, declared, paper, jobId, artifactId, outcome, operatorNote, publicNote, prizeMessage, aiSummary, published, publishedAt, createdAt, updatedAt }` (never `owner_id` or `claim_hash`).

- `GET /v1/booth/admin/submissions?status=a,b&after=<seq>&limit=<1..200, default 100>` -> `{ submissions: AdminView[], nextAfter: number|null }` ordered by seq.
- `GET /v1/booth/admin/submissions/:receipt` -> AdminView.
- `GET /v1/booth/admin/submissions/:receipt/pdf` -> streams `edited.pdf` via
  `getRuntimeArtifact(env, { ownerId: row.owner_id, jobId: row.job_id, artifactId: row.artifact_id })`;
  `application/pdf`, `Content-Disposition: attachment; filename="F-0042.pdf"`. Runtime 404 -> 404
  `artifact_expired` (runtime retention is 7 days; the CLI archives early).
- `PATCH /v1/booth/admin/submissions/:receipt` with any subset of
  `{ status: received|reviewing|judged|invalid, outcome: missed|caught|partial|invalid|null, operatorNote <= 2000, publicNote <= 1000, prizeMessage <= 500, aiSummary: object (JSON <= 16 KiB), published: boolean }`
  -> AdminView. `published: true` sets `published_at`; `false` clears it. A withdrawn row accepts only `operatorNote` (else 409 `withdrawn`).
- `DELETE /v1/booth/admin/submissions/:receipt` -> 204.
- `GET /v1/booth/admin/settings` / `PUT /v1/booth/admin/settings` with any subset of
  `{ submissionsOpen: boolean, missions: Mission[] (<= 20), announcement: string <= 300 | null }` -> `{ submissionsOpen, missions, announcement }`.

## 6. Paper search API (SEARCH worker, `paper-search.mjs`)

Exports `matchPaperSearch(pathname)` and `handlePaperSearchRequest(ctx)` (same ctx shape; upstream
calls go through `ctx.fetchImpl` so tests inject a fake). Own OPTIONS preflight, same error envelope.
`PAPER_SEARCH_ENABLED` not `"true"` -> 404 before auth. Auth: any owner `resolveAiOwner` accepts.
Limits via `deps.rateLimit`: `PAPER_SEARCH_PER_OWNER_HOUR` 60, `PAPER_SEARCH_PER_IP_HOUR` 300,
`PAPER_PDF_PER_OWNER_HOUR` 20, `PAPER_PDF_PER_IP_HOUR` 120, global `PAPER_SEARCH_PER_HOUR` 3000.

- `GET /v1/papers/search?q=<1..200 chars>&page=<1..5>` ->
  `{ source: "arxiv", page, hasMore, results: Paper[] }` (10 per page).
  Paper = `{ source: "arxiv", id, title, authors: string[] (<= 6), year, abstract (<= 700 chars), license: { id, url } | null, licenseVerified: boolean, landingUrl }`.
  Primary: OpenAlex works search restricted to arXiv (`best_oa_location.source.id:S4306400194`) and
  licenses `cc-by`, `cc-by-sa`, `public-domain` (optional secret `OPENALEX_API_KEY`). On OpenAlex
  failure fall back to the arXiv Atom API with `licenseVerified: false`. Cache responses in
  `caches.default` for 1 h (key = normalized query + page only).
- `GET /v1/papers/pdf?id=<arXiv id>` -> license check via arXiv OAI-PMH `GetRecord`
  (`metadataPrefix=arXiv`): allow CC BY (any version), CC BY-SA, CC0 / public domain; otherwise 403
  `license_not_allowed` (cache the verdict 24 h). Then fetch `https://arxiv.org/pdf/<id>`. Require HTTP
  200, `%PDF-` magic, size <= the caller's effective `maxUploadBytes` (else 413 `payload_too_large`).
  Response: `application/pdf`, `Content-Disposition: attachment; filename="arxiv-<id>.pdf"`,
  `X-Falsify-Paper-License: <id>`, `Cache-Control: no-store`.
- IDs: `^\d{4}\.\d{4,5}(v\d{1,3})?$` or `^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d{1,3})?$`. Never accept a URL.
  Upstream hosts are fixed (`api.openalex.org`, `export.arxiv.org`, `oaipmh.arxiv.org`, `arxiv.org`);
  a redirect is followed only to `https://arxiv.org/` or `https://export.arxiv.org/`.
- Upstream `User-Agent: falsify-workbench-booth/1.0 (+https://github.com/Shinick-Han/falsify-workbench)`.
  No personal email or owner id is ever sent upstream.

## 7. Frontend (FE worker)

- `build-event-page.mjs` writes `booth: Object.freeze({ enabled: true })` into
  `cloud-config.event.js` and injects `booth.css` and `booth.js` (deferred, after `hosted-ai.js`)
  into `event.html` only. `--check` stays exact.
- `hosted-ai.js` (shared with index.html; every change gated so index.html behaves the same):
  - dispatches `document` CustomEvent `falsify:hosted-apply-complete` with
    `{ jobId, artifactId, fileName, edits: [{ pageIndex, segmentId?, before, after }] }` when a RED
    applyOnly job completes with an `edited.pdf` artifact;
  - hides BLUE run and RED->BLUE hosted handoff controls when capabilities report `blueJobs === false`.
- `booth.js` exposes `globalThis.FalsifyBooth` (UMD like the other modules) and renders only when
  `FalsifyCloudConfig.booth.enabled` and `GET /v1/booth/config` says `enabled`:
  1. Mission and search panel: mission cards from config; search box calling `/v1/papers/search`
     with the guest bearer; "이 논문으로 시작" fetches `/v1/papers/pdf`, wraps it in a `File` and opens
     it through the app's existing intake (reuse an existing open-file path; no parallel viewer).
  2. Submit panel after `falsify:hosted-apply-complete`: one row per applied edit (page, before -> after),
     defect type select + reason (required), course, optional nickname, consent checkbox, submit.
  3. Receipt card: receipt and claim key large, copy button, "결과 확인" link
     (`event.html#booth-result`), saved to localStorage `falsify.booth.receipts.v1` (list of `{ receipt, claimKey, createdAt }`, max 10).
  4. `#booth-result` view: receipt + key form (pre-filled from storage), shows status, outcome label,
     public note, prize message; withdraw button with confirmation.
  - Mobile first (360-430 px wide), Korean copy, keeps the airport visual system. Never sends the
    visitor's declared reasons anywhere except `/v1/booth/submissions`.
  - Consent copy (version `2026-11-22.v1`):
    "제출한 수정본 PDF와 결함 설명(쪽·유형·이유)은 가짜연구소 Falsify 스터디의 AI 검증 실험과 사람이 만든 결함 데이터로 저장·분석됩니다. 이름·연락처 같은 개인정보는 받지 않으며, 결과와 경품 안내는 접수번호와 확인키로만 확인할 수 있습니다. 확인키로 언제든 제출을 철회할 수 있습니다."

## 8. Operator CLI (OPS worker, `tools/booth`)

- `node tools/booth/booth.mjs <command> [options]`, Node >= 20, no dependencies. Token from env
  `FALSIFY_BOOTH_TOKEN` (never a flag, never logged). API base from config or `--api`.
- Config JSON (`--config`, example committed as `tools/booth/booth.config.example.json`):
  `{ apiBase, dataDir, blue: { concurrency, repeat, profiles: [{ name, model, effort, maxCalls, useEvidence, prompt | promptFile, harness | harnessFile }] } }`.
  Every BLUE setting is operator-chosen; flags override per run (`--profile`, `--model`, `--effort`,
  `--max-calls`, `--use-evidence`, `--prompt-file`, `--harness-file`, `--concurrency`, `--repeat`,
  `--only F-0001,F-0002`, `--status received,reviewing`).
- Default data dir `$HOME/falsify-booth-data` (outside the repo).
- Commands: `status`, `list`, `pull` (submission.json + edited.pdf per receipt, sha256 recorded,
  idempotent), `blue` (per submission x profile x repeat: upload the edited PDF via `/v1/ai/uploads`,
  create a `role:'blue'` job via `/v1/ai/jobs` with a deterministic idempotency key, poll, save the
  result; resumable), `score` (heuristic declared-vs-found matching -> suggested outcome per
  submission), `judge`, `publish` / `unpublish`, `draw` (crypto-random winners from a filter),
  `export --format common|score|key|jsonl`, `missions get|set <file>`, `open`, `close`, `announce`.
- **BLUE requests contain only the edited PDF and the operator's prompt/harness settings.** Declared
  edits, reasons, types, nickname and paper metadata are never sent to BLUE (tested).
- `export --format common` uses the study's 15 common columns: 참가자, 조건, 탐지기, 모델, 실행번호, ID,
  물리 페이지, 위치(절·그림·표), 유형, 판정(아님/확인필요), 심각도, 정확한 원문 인용, 대응 근거·이유·검산, 확신,
  추가로 필요한 정보. `--format score` writes the Falsify `tools/score.py` prediction columns
  (paper_id, team, judge_type, model, iteration, location, defect_type, label, evidence, time_sec,
  tokens, is_holdout); `--format key` writes the answer-key rows from declared edits.

## 9. Acceptance (each worker, in its own worktree)

- API/SEARCH: `cd cloud/api && npm ci && npm test` green, including the new test file; existing tests
  unchanged and green; `npm run build:check` green after the orchestrator mount.
- FE: `node scripts/build-event-page.mjs --check` green; `cd app && node scripts/test.mjs` green;
  `node --test scripts/event-page.spec.mjs` green; new spec covers the booth module's pure logic.
- OPS: `node --test tools/booth/test/` green against a local fake API (node:http), including the
  "nothing declared reaches BLUE" test.
- No secrets, real tokens, private papers, PDFs or answer keys committed.

## 10. Round-2 amendments (2026-11-19, from the risk review; binding, supersede earlier text)

**API**
- R2-1 `AI_GUEST_MODEL_JOBS` (default `true`). `false`: a guest job must be `role:'red'` with `applyOnly:true`; anything else is 403 `guest_model_disabled`, checked at the same point as `guest_blue_disabled` (blue keeps its own code). Capabilities gain `modelJobs` with the same view rule as `blueJobs`.
- R2-2 Capabilities called with a valid `fso_` bearer report `blueJobs: true` and `modelJobs: true`.
- R2-3 `paper` becomes **required** in `POST /v1/booth/submissions`: `source` must be `arxiv` or `mission`, and `license` must be one of `cc-by`, `cc-by-<n.n>`, `cc-by-sa`, `cc-by-sa-<n.n>`, `cc0`, `cc0-1.0`, `public-domain`; otherwise 400 `paper_not_allowed`.
- R2-4 Withdraw is a tombstone: set `declared` to `[]`, and `nickname`, `paper`, `public_note`, `prize_message`, `ai_summary`, `outcome`, `published_at` to NULL; keep id, seq, receipt, course, job/artifact ids, consent version, timestamps, `operator_note`. The admin PDF route answers 404 `withdrawn` for such rows. Withdrawn rows do not count toward `BOOTH_SUBMISSIONS_PER_OWNER`.
- R2-5 Global claim/withdraw cap `BOOTH_CLAIMS_PER_HOUR` (default 2000) in addition to the per-IP one. Seq allocation retries up to 5 times.
- R2-6 Event env values (`env.event.vars`) become: `AI_GUESTS_PER_IP_HOUR: "600"`, `AI_GUESTS_PER_HOUR: "800"`, `AI_GUEST_UPLOADS_PER_HOUR: "400"`, `AI_GUEST_JOBS_PER_OWNER_HOUR: "20"`, `AI_GUEST_APPLY_JOBS_PER_HOUR: "600"`, `AI_GUEST_BLUE: "false"`, `AI_GUEST_MODEL_JOBS: "false"`, `BOOTH_ENABLED: "true"`, `BOOTH_CONSENT_VERSION: "2026-11-22.v1"`, `BOOTH_SUBMISSIONS_PER_IP_HOUR: "400"`, `BOOTH_CLAIMS_PER_IP_HOUR: "2000"`, `BOOTH_CLAIMS_PER_HOUR: "5000"`, `BOOTH_OPERATOR_ACTIVE_JOBS: "2"`, `PAPER_SEARCH_ENABLED: "true"`, `PAPER_SEARCH_PER_IP_HOUR: "2000"`, `PAPER_PDF_PER_IP_HOUR: "600"`.

**SEARCH**
- R2-7 Cache the PDF bytes of an *allowed* arXiv id in the cache for 24 h (key by normalized id; never cache denied ids' bytes); the browser response stays `no-store`. The 413 size rule still applies to cached bytes.
- R2-8 Send `OPENALEX_API_KEY` as `Authorization: Bearer <key>`, never in the URL.

**FE**
- R2-9 Hide the hosted model RED run (and any other hosted model control) when `capabilities.modelJobs === false`; apply stays available.
- R2-10 The booth submit panel always sends `paper` (mission or search pick). If the current document was not opened through the booth picker, the panel says "미션이나 검색에서 논문을 골라 시작해 주세요" and does not submit.
- R2-11 `app/dist/open-access.js` joins the FE scope: its intro sentence must no longer promise guest BLUE runs when `blueJobs === false`.
- R2-12 Consent copy (same version `2026-11-22.v1`, nothing has shipped yet):
  "제출한 수정본 PDF와 결함 설명(쪽·유형·이유)은 가짜연구소 Falsify 스터디가 저장하고 운영자가 읽습니다. 마감 후 AI 검증에는 수정본 PDF만 모델 제공자(Anthropic 또는 OpenAI)에 보내며, 결함 설명은 AI에 보내지 않습니다. 이름·연락처는 받지 않으니 이유란에도 적지 마세요. 원 논문은 CC BY·CC BY-SA·CC0 공개 논문이며, 수정본을 스터디 밖에 공개할 때는 저자·arXiv 번호·라이선스와 수정 사실을 밝힙니다. 결과와 경품 안내는 접수번호와 확인키로만 확인할 수 있습니다. 확인키로 언제든 철회할 수 있고, 철회하면 설명과 결과는 즉시 삭제되며 수정본 PDF는 운영자 보관본에서 지우고 서버 사본은 7일 안에 자동 삭제됩니다. 보관 자료는 스터디 종료 후 삭제합니다."

**OPS**
- R2-13 CSV formula-injection guard: prefix `'` when a cell starts with `=`, `+`, `-`, `@`, tab or CR (all formats).
- R2-14 The BLUE idempotency key also covers the edited PDF sha256.
- R2-15 `draw` defaults to outcome `missed` (prizes go to defects the AI missed).
- R2-16 `blue` refuses to start while `submissionsOpen` is true unless `--allow-open` is given (visitors and BLUE share runtime threads).
- R2-17 `pull` deletes local files of withdrawn submissions (keeps a tombstone line in a local log).
- R2-18 `missions warm`: GET `/v1/papers/pdf?id=...` for every configured mission with the operator token (verifies licence and warms the PDF cache); report sizes and failures.

**Verdict vocabulary (all exports)**: Workbench BLUE `verdictLabel` uses `아님` = the passage is wrong (defect found), `확인필요` = suspicious, needs verification, `맞음` = passage is fine. The common CSV column 판정(아님/확인필요) carries these words as-is.

## 11. Round-3 amendments (2026-11-19): submissions carry the edited PDF (binding; supersede §5.1, §5.3, §7 and R2 where they differ)

Why: the hosted applyOnly job only applies candidates from a completed hosted model RED review. Human edits are made in the
paper workspace (`FalsifyPaperWorkspace`) and the PDF is generated in the browser, so no server job exists for them.

**API**
- R3-1 `POST /v1/booth/submissions` is `multipart/form-data` with exactly two parts: `meta` (JSON text: the §5.3 object
  **without** `jobId`, plus `editedSha256` = lowercase hex SHA-256 of the PDF bytes, and optional `paper.sourceSha256`
  hex64) and `pdf` (the edited PDF). Limits: `BOOTH_MAX_PDF_BYTES` (default = `AI_GUEST_MAX_UPLOAD_BYTES` default 20 MiB,
  hard cap 32 MiB); whole body <= that + 64 KiB (413 `payload_too_large`). Checks after the §5.3 order (closed, consent):
  non-empty, `%PDF-` magic (else 400 `invalid_pdf`), server SHA-256 equals `editedSha256` (else 400 `pdf_mismatch`),
  differs from `paper.sourceSha256` when given (else 400 `pdf_unchanged`); same owner + same PDF hash already
  submitted -> 409 `already_submitted` with the receipt. All job/artifact checks are removed. Auth unchanged (visitor bearer).
- R3-2 Storage: new table `booth_files (submission_id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (submission_id, idx))`, 512 KiB chunks, written together with the submission row in one `db.batch`.
  `booth_submissions` drops `job_id` and `artifact_id` and adds `pdf_sha256 TEXT NOT NULL`, `pdf_bytes INTEGER NOT NULL`,
  `source_sha256 TEXT`, with `UNIQUE (owner_id, pdf_sha256)`. Nothing is deployed yet, so edit `0006_booth.sql` in place.
- R3-3 `GET /v1/booth/admin/submissions/:receipt/pdf` streams the chunks in `idx` order (no runtime call);
  `X-Falsify-Pdf-Sha256` header; 404 `withdrawn` for withdrawn rows. AdminView replaces `jobId`/`artifactId` with
  `pdfSha256`, `pdfBytes`, `sourceSha256`.
- R3-4 Withdraw (R2-4 tombstone) also deletes that submission's `booth_files` rows. DELETE does too.
- R3-5 The runtime is not used by visitor submissions at all.

**FE**
- R3-6 The booth flow uses the paper workspace, not the hosted panel: edits from `FalsifyPaperWorkspace.getEditSnapshot()`
  (enabled edits: pageIndex, segmentId, before, after), source from `getSource()`, and the PDF the workspace generates.
  `app/dist/paper-workspace.js` joins the FE scope for one small change only: after every successful generation, dispatch a
  non-cancelable `document` CustomEvent `falsify:paper-generated` with `{ file, sourceFileHash, revision, edits }` (reuse an
  existing hook instead if one already exists). The booth panel offers "제출할 수정본 만들기" (triggers the workspace's own
  generation when there is no current output), pre-fills one declared row per enabled edit (max 5; with more, ask the
  visitor to keep at most 5 enabled), computes `editedSha256` with `crypto.subtle`, and posts FormData (`meta` JSON +
  `pdf`). Map the new error codes (`invalid_pdf`, `pdf_mismatch`, `pdf_unchanged`) to Korean messages.
- R3-7 On the event page, when `capabilities.modelJobs === false`, the hosted AI panel shows a short note that this page
  runs no AI and points to the booth flow, instead of its run/apply controls. index.html is unchanged.
- R3-8 Consent copy (replaces R2-12, same version `2026-11-22.v1`):
  "제출한 수정본 PDF와 결함 설명(쪽·유형·이유)은 가짜연구소 Falsify 스터디가 저장하고 운영자가 읽습니다. 마감 후 AI 검증에는 수정본 PDF만 모델 제공자(Anthropic 또는 OpenAI)에 보내며, 결함 설명은 AI에 보내지 않습니다. 이름·연락처는 받지 않으니 이유란에도 적지 마세요. 원 논문은 CC BY·CC BY-SA·CC0 공개 논문이며, 수정본을 스터디 밖에 공개할 때는 저자·arXiv 번호·라이선스와 수정 사실을 밝힙니다. 결과와 경품 안내는 접수번호와 확인키로만 확인할 수 있습니다. 확인키로 언제든 철회할 수 있고, 철회하면 설명·결과·수정본 PDF가 서버에서 즉시 삭제되며 운영자 보관본도 지웁니다. 보관 자료는 스터디 종료 후 삭제합니다."

**OPS**
- R3-9 AdminView field change (R3-3). `pull` verifies the downloaded PDF against `pdfSha256`; the BLUE idempotency key
  uses `pdfSha256` (this satisfies R2-14). Update the fake API.

**E2E / BROWSER**
- R3-10 The E2E flow submits multipart with an edited PDF made locally (e.g. PyMuPDF text replacement); BROWSER phase 2
  drives the paper workspace edit -> generate -> booth submit path.

## 12. Round-4 amendments (2026-11-19): storage, CPU, atomic writes, consent (binding; supersede earlier text where they differ)

Sources: RISK round 2 (`wt/reports/risk.md` "## Round 2") and the SEARCH cross-review (`wt/reports/search-review-api.md`).

**Submission body and limits (API)**
- R4-1 Parse with the runtime's native `request.formData()`; never decode the PDF as text. Exactly two fields, in any order:
  `meta` (a text field) and `pdf` (a file field with a filename and type `application/pdf`); anything else is 400
  `invalid_request`. `editedSha256` is the SHA-256 of the `pdf` file's bytes as received; compute one digest and cut
  chunks with `subarray`. Require `Content-Length` (else 411 `length_required`) and reject it above
  `BOOTH_MAX_PDF_BYTES` + 65536 before reading the body (413 `payload_too_large`); re-check the file size after parsing.
- R4-2 Interop vector, used by both the API and FE tests: the 109 bytes
  `"%PDF-1.7\n% falsify booth interop fixture\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"` have SHA-256 `241e9c74200e288d5bc4b11ef565745b1c5495930790689240bb7168ad111019`.
- R4-3 `paper.sourceSha256` (hex64) is now **required**; equal to `editedSha256` -> 400 `pdf_unchanged`. When the
  submission's `paper.source` is `mission` and that mission in `booth_settings` has a `sourceSha256`, a different value is
  400 `paper_not_allowed`. Missions may also carry optional `pageHint` (1-based) and `sourceSha256`; validate and return them.
- R4-4 Stored-bytes cap `BOOTH_STORED_PDF_BYTES` (default 2147483648; event 3221225472): the sum of `pdf_bytes` over rows
  that still have files, plus this file, must not exceed it, else 503 `storage_full` (retryable false). Event vars:
  `BOOTH_MAX_PDF_BYTES` 16777216, `BOOTH_STORED_PDF_BYTES` 3221225472, and `env.event.limits.cpu_ms` 5000 (production
  and staging unchanged). Measure a 16 MiB submit under Miniflare and report CPU/wall time.

**Atomic writes (API)**
- R4-5 One `db.batch` per attempt: (a) `INSERT INTO booth_submissions … SELECT … WHERE` seq is still `MAX(seq)+1` AND the
  owner's non-withdrawn count < `BOOTH_SUBMISSIONS_PER_OWNER` AND the stored-bytes predicate holds; (b) one
  `INSERT INTO booth_files (submission_id, idx, data) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM booth_submissions WHERE id = ?1)`
  per 512 KiB chunk, the chunk always a bound parameter. If the row did not land, re-read and answer 429 `rate_limited`
  (owner cap), 503 `storage_full`, 409 `already_submitted`, or retry the whole batch for a seq race (max 5). Release the
  hourly slots taken for an attempt that did not land. Tests: two overlapping submits at the owner cap (exactly one wins),
  the global hourly cap actually returning 429, a forced seq conflict retrying, a rejected attempt leaving zero chunk rows.
- R4-6 Admin PDF streams one `idx` row per read (a `ReadableStream`), with `Content-Length` = `pdf_bytes` and
  `X-Falsify-Pdf-Sha256`. List and detail queries never select `booth_files.data`.
- R4-7 Withdraw = one batch: the R2-4 tombstone (also set `operator_note` to NULL) + `DELETE FROM booth_files` for that id.
  Admin DELETE also removes the chunks in the same batch.

**Auth and envelope (API)**
- R4-8 Booth maps `membership_required` and `open_access_disabled` to 403 with those codes (as `/v1/ai/*` does), adds them
  to its messages, and returns a Confluence refresh (`X-Falsify-Confluence-Session` + `Access-Control-Expose-Headers`) on
  success and error responses exactly like `withRefreshed` in ai-gateway.mjs.
- R4-9 Claim/withdraw always run the constant-time compare (dummy digest when the receipt is unknown).
- R4-10 `AI_MODEL_JOBS_OPERATOR_ONLY` (event `true`, default off): any job other than red `applyOnly` from an owner other
  than `opr:booth` is 403 `model_jobs_operator_only` before upload lookup, rate slots or runtime; capabilities report
  `modelJobs`/`blueJobs` false for such viewers. `BOOTH_OPERATOR_TOKEN_BUDGET` (default 0 = no gate) applies the existing
  owner token-budget gate to `opr:booth` so the operator can set a BLUE spend ceiling without a code change.

**FE**
- R4-11 Consent copy (replaces R3-8; version stays `2026-11-22.v1` because nothing is deployed):
  "제출한 수정본 PDF와 결함 설명(쪽·유형·이유)은 가짜연구소 Falsify 스터디가 저장하고 운영자가 읽습니다. 마감 후 AI 검증에는 수정본 PDF만 모델 제공자(Anthropic 또는 OpenAI)에 보내며, 결함 설명은 AI에 보내지 않습니다. 이름·연락처는 받지 않으니 이유란에도 적지 마세요. 원 논문은 미션이나 검색에서 고른 공개 논문(CC BY·CC BY-SA·CC0)이며, 수정본을 스터디 밖에 공개할 때는 저자·arXiv 번호·라이선스와 수정 사실을 밝히고, CC BY-SA 논문의 수정본은 같은 라이선스로 공개합니다. 결과와 경품 안내는 접수번호와 확인키로만 확인할 수 있습니다. 확인키로 언제든 철회할 수 있습니다. 철회하면 서버의 수정본 PDF·설명·결과를 바로 지우고, 운영자 보관본은 다음 동기화 때 지웁니다. 이미 AI 검증에 보낸 사본은 모델 제공자에게서 회수할 수 없고, 웹 실행 서버 사본은 7일, 데이터베이스 백업은 최대 30일 뒤에 사라집니다. 보관 자료는 스터디 종료 후 삭제합니다."
- R4-12 FormData: `meta` as a string field, `pdf` as a `File` named `edited.pdf` with type `application/pdf`; send
  `paper.sourceSha256` from the loaded original (compute it if the workspace hash is not SHA-256 hex). Korean messages for
  411/413 (show the 16MB limit from `BOOTH_MAX_PDF_BYTES` if the API exposes it, else a generic size message), 503
  `storage_full` ("오늘 접수 저장 공간이 가득 찼습니다. 부스 운영자에게 알려 주세요."), `model_jobs_operator_only`. Add the
  R4-2 vector to booth.spec.mjs.

**OPS**
- R4-13 BLUE-while-open message: say BLUE shares the production runtime (not the visitor path); keep `--allow-open`.
- R4-14 `missions warm --write` stores each mission's fetched `sourceSha256` (and keeps `pageHint`) into booth settings.
- R4-15 BLUE refuses a local PDF over `--max-bytes` (default 16777216) or not starting with `%PDF-`; README and the runbook
  say booth PDFs are opened only in a browser's built-in PDF viewer, never a desktop viewer.

## 13. Live BLUE (2026-11-19, release 0.2.0-alpha.85; binding; supersedes §1 steps 5-6, R2-6 and R4-11 where they differ)

**Flow**
- L-1 RED (AI planting help) stays off at the booth. The operator runs `booth watch` (tools/booth) on one host while
  submissions are open. Every `--interval` seconds (default 10) it lists `received` rows and, up to `--concurrency` at a
  time (default 12), PATCHes `status: reviewing`, pulls the PDF (same sha256 and length checks as `pull`), runs BLUE with
  the `live` profile (Claude Sonnet 5.5), scores it, and sends one PATCH
  `{ status: "judged", outcome, publicNote, aiSummary, published: true }` (plus `prizeMessage` when `missed`).
  So a visitor's row goes `received` -> `reviewing` -> `judged` + published, usually within 1-3 minutes.
  A withdraw (409) or missing PDF is skipped. A run that still fails after retries stays `reviewing` with
  `operatorNote: live: failed <code>`. A restart resumes the same job without a new charge.
- L-2 After closing, `booth final` re-runs the `final` profile (Claude Opus 5.5) on live `missed` rows and writes
  `final/candidates.json`. Nothing is published until a person reviews it and runs `final --apply`. An instant prize
  already given stays valid when the final round catches the defect. A person confirms the final prize list.
- L-3 `publicNote` uses only the AI finding's page, quote and rationale, never the visitor's reason, type or edited text.

**Claim polling (FE)**
- L-4 After a submit, the page polls `POST /v1/booth/claim` every 15 s for the first 3 minutes, then every 30 s, and stops
  at 15 minutes (the visitor can still check by hand). An unpublished row shows as pending. A `429` waits for
  `Retry-After` when it is readable, else 60 s; a Retry-After wait only lengthens a step.
- L-5 `Access-Control-Expose-Headers` on booth, `/v1/ai/*` and `/v1/papers/*` responses is
  `X-Falsify-Confluence-Session, Retry-After` on every response, not only when a session refreshed.
- L-6 Event vars: `BOOTH_CLAIMS_PER_IP_HOUR` "8000" and `BOOTH_CLAIMS_PER_HOUR` "15000" (venue NAT plus polling).
  Code defaults (120 and 2000), `AI_RUNTIME_URL` and `BOOTH_OPERATOR_ACTIVE_JOBS` are unchanged.

**Consent v2**
- L-7 Event `BOOTH_CONSENT_VERSION` was `2026-11-22.v2` (now v3, see L-9). The v2 copy says the edited PDF alone is sent to Anthropic right
  after submitting, and may be sent once more after closing; the declared edits are never sent. The code default stays
  `2026-11-22.v1`. A submit with any other version is still 409 `consent_outdated`.
- L-8 The FE keys the consent copy by version (`CONSENT_COPY` in `app/dist/booth.js`, holding v1, v2 and v3) and shows the text
  for the `consentVersion` that `GET /v1/booth/config` returns. A version with no copy on the page cannot be submitted, and
  the page asks the visitor to reload. Changing the copy means a new version on both sides. Until the config
  answers, the page shows no consent text and the checkbox stays off, so no older version can flash.

**Consent v3 (2026-11-20)**
- L-9 Event `BOOTH_CONSENT_VERSION` is `2026-11-22.v3`. v3 is v2 in 해요체 with the same facts; its three-line summary
  equals v2's. v1 and v2 stay in `CONSENT_COPY` because stored submissions reference them.
