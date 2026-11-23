# Hosted Python runtime packaging

Minimal container packaging for the existing `app/local/hosted_runtime` service and the
evidence/PDF/chart engines it imports. This directory adds packaging only; no runtime source is
modified here.

The service is a **container-internal** HTTP API for the Cloudflare Worker gateway. It is the only
process that reads the provider key. Never expose it publicly.

## Build

```bash
# Recommended: stages a minimal context (source + referenced app/dist assets) and builds.
bash cloud/runtime/build.sh falsify-hosted-runtime:local

# Equivalent direct build from the repository root (uploads the whole worktree as context):
docker build -f cloud/runtime/Dockerfile -t falsify-hosted-runtime:local .
```

Base image: `python:3.12.10-slim-bookworm` (`ARG PYTHON_BASE`). Pin the image digest at deploy time;
this packaging can only pin the tag offline.

Dependencies are pinned in `requirements-runtime.txt` from `app/local/requirements.txt` and installed
without build tools. See the file header for the import site justifying each package.

## Run

Required environment variable **names** (values come from the orchestrator's secret/volume config;
nothing is baked into the image):

| Name | Required | Meaning |
|---|---|---|
| `HOSTED_AI_SERVICE_TOKEN` | yes | Shared gateway→runtime token (`X-Falsify-Service-Token`). Never printed. |
| `HOSTED_AI_STATE_DIR` | yes | Durable state directory (SQLite + content-addressed blobs). Must be a mounted POSIX volume owned by uid/gid `10001`. |
| `ANTHROPIC_API_KEY` | yes for RED/BLUE model jobs | Read only by the provider backend; never logged or returned. |
| `HOSTED_AI_BIND` | no | Bind address inside the container (default `0.0.0.0`; keep the network private). |
| `HOSTED_AI_PORT` | no | Bind port (default `8787`, matching `EXPOSE`). |
| `ANTHROPIC_WORKSPACE_ID` | no | Sent as `anthropic-workspace-id` when set. |
| `ANTHROPIC_BASE_URL` | no | HTTPS provider endpoint override (tests inject transport instead). |
| `OPENAI_API_KEY` | yes for OpenAI model jobs | Read only by `openai_backend.py`; never logged or returned. |
| `OPENAI_ORG_ID` | no | Sent as `OpenAI-Organization` when set. |
| `OPENAI_PROJECT_ID` | no | Sent as `OpenAI-Project` when set. |
| `OPENAI_BASE_URL` | no | HTTPS provider endpoint override (`http://127.0.0.1` allowed for tests). |
| `HOSTED_AI_MODELS` | no | Comma-separated model allowlist. |
| `HOSTED_AI_DEFAULT_MODEL` | no | Default model (must be in the allowlist). |
| `HOSTED_AI_BLUE_DEFAULT_MODEL` | no | Default for BLUE when a client omits its model. Production uses `gemini-4-neon-high` at high effort. |
| `HOSTED_AI_AGY_SOCKET` | no | Unix socket for local Gemini inference under the operator’s agy login. Production uses `/run/falsify-agy/blue.sock`. |
| `HOSTED_AI_DEFAULT_EFFORT` | no | Default effort (must be in the effort allowlist). |
| `HOSTED_AI_MAX_UPLOAD_BYTES` | no | Per-upload limit (default 32 MiB). |
| `HOSTED_AI_MAX_CONCURRENCY` | no | Worker threads (default 2). Production Workbench runs 15, matching the local agy broker. |
| `HOSTED_AI_MAX_CALLS` | no | Default/hard job call budget. |
| `HOSTED_AI_JOB_RETENTION_SECONDS` | no | Job/blob retention (default 7 days). |

The entrypoint fails closed (exit 2) when a required variable is missing, when the state directory
is not writable by the runtime uid, or when started as root. It also supports a non-binding check:

```bash
docker run --rm -e HOSTED_AI_STATE_DIR=/var/lib/falsify-runtime -e HOSTED_AI_SERVICE_TOKEN \
  -v /srv/falsify-runtime:/var/lib/falsify-runtime falsify-hosted-runtime:local --check
```

Example same-host run (test only; never publish the port publicly):

```bash
docker run --rm --read-only --tmpfs /tmp:rw,size=64m \
  -v /srv/falsify-runtime:/var/lib/falsify-runtime \
  -e HOSTED_AI_STATE_DIR=/var/lib/falsify-runtime \
  -e HOSTED_AI_SERVICE_TOKEN -e ANTHROPIC_API_KEY \
  -p 127.0.0.1:8787:8787 \
  falsify-hosted-runtime:local
```

The image runs as uid/gid `10001`, with the application tree read-only and the state directory as
the only writable path. `TMPDIR` is set to `<state>/tmp`, so native worker scratch never lands in
image layers.

## systemd + venv deployment (no Docker, recommended for the existing GCE host)

Docker is optional. On a Debian/Ubuntu host with systemd, a persistent boot disk and Python 3.12
(`python3-venv`), `cloud/runtime/install-venv.sh` installs the same runtime directly:

```bash
# 1. Prerequisites only (no system changes; safe to run as any user):
bash cloud/runtime/install-venv.sh --check

# 2. Install/update from a checkout (creates the user, venv, source tree, state dir and unit):
sudo bash cloud/runtime/install-venv.sh

# 3. Fill the two required values in the root-only env file (names only here):
sudoedit /etc/falsify/runtime.env

# 4. Start and inspect:
sudo systemctl start falsify-runtime
systemctl status falsify-runtime --no-pager
sudo journalctl -u falsify-runtime -n 50 --no-pager

# 5. Health probe on loopback (export the token from the env file in the calling shell first):
curl -fsS -H "X-Falsify-Service-Token: $HOSTED_AI_SERVICE_TOKEN" \
  -H "X-Falsify-Owner-Id: usr:00000000-0000-4000-8000-000000000000" \
  http://127.0.0.1:8787/internal/v1/health
```

Installed layout (paths are fixed and match the engines' relative-path lookups):

| Path | Contents |
|---|---|
| `/opt/falsify/venv` | Virtualenv built from `requirements-runtime.txt` |
| `/opt/falsify/app/local` | Runtime source (`WorkingDirectory`, `python -m hosted_runtime`) |
| `/opt/falsify/app/dist` | Only the referenced font/chart/plot-tracer assets |
| `/opt/falsify/experiments` | `selfplay_codex.py`, imported by the RED/BLUE engine modules |
| `/var/lib/falsify` | **Durable state**: `state.sqlite3`, `blobs/`, `tmp/` |
| `/etc/falsify/runtime.env` | Service environment, mode `0600`, outside the repository |
| `/etc/systemd/system/falsify-runtime.service` | Unit |

The installer creates a dedicated non-root user/group `falsify-runtime` (uid/gid `10001`), owns the
state directory with it, installs the tree root-owned and not group/other-writable, and enables the
unit without starting it. It never writes a secret: `/etc/falsify/runtime.env` is created with
commented names only, and the service fails closed until the operator fills it.

The unit runs unprivileged with `NoNewPrivileges=true`, `ProtectSystem=strict`,
`ProtectHome=true`, `PrivateTmp=true`, `ReadWritePaths=/var/lib/falsify` and `UMask=0077`, and
`Environment=HOSTED_AI_STATE_DIR=/var/lib/falsify` is authoritative over the env file.
`MemoryDenyWriteExecute` and `SystemCallFilter` are intentionally not enabled: mini-racer's V8 and
the native PDF workers need writable+executable mappings and extra syscalls.

To upgrade, re-run the installer and `sudo systemctl restart falsify-runtime`; the state directory is
not touched.

## Workbench W8 single-SHA release layout

All live W8 components deploy from one clean git commit SHA (`<sha>`) staged into a versioned release directory (`/opt/falsify/releases/<release-id>`):

1. **Stage the release tree** from `<sha>` using `git archive` (no worktree state, no `.env`, no secrets):
   ```bash
   sudo install -d -m 0755 "/opt/falsify/releases/<release-id>"
   git archive "<sha>" | sudo tar -x -C "/opt/falsify/releases/<release-id>"
   sudo chown -R root:root "/opt/falsify/releases/<release-id>"
   sudo chmod -R go-w "/opt/falsify/releases/<release-id>"
   ```
2. **Host services** pointing at `/opt/falsify/releases/<release-id>`:
   - `falsify-agy-broker.service`: template in `cloud/runtime/systemd/falsify-agy-broker.service`. Runs `/opt/falsify/venv/bin/python -m agy_broker --socket /run/falsify-agy/blue.sock --socket-group falsify-production --socket-mode 0660 --max-concurrency 15` with `WorkingDirectory=/opt/falsify/releases/<release-id>/app/local`.
   - `falsify-production.service`: drop-in `/etc/systemd/system/falsify-production.service.d/15-gemini-runtime.conf` orders after `falsify-agy-broker.service`, sets `WorkingDirectory=/opt/falsify/releases/<release-id>/app/local`, and loads `/etc/falsify/workbench-blue-gemini.env`.
   - `falsify-w8-pdf-store.service` (user unit): template in `cloud/runtime/systemd/falsify-w8-pdf-store.service`. Sets `WorkingDirectory=/opt/falsify/releases/<release-id>` and runs `/usr/bin/python3 tools/w8/pdf_store.py` behind Caddy `/w8-archive/*` (`127.0.0.1:18241`).
3. **Cloudflare Workers and D1** from the same `<sha>` inside `cloud/api`:
   - D1 migration `0010_w8_paper_titles.sql` on `falsify-harness-records-staging` (`--env staging`) and `falsify-w8-papers` (`--config wrangler.w8-papers.jsonc`) when not yet applied.
   - `falsify-cloud-api` (`wrangler.jsonc`): production hosted AI Worker (Gemini 4 Neon high default for BLUE, 15 active jobs per owner).
   - `falsify-cloud-api-staging` (`wrangler.jsonc --env staging`): Confluence/Jira team Worker.
   - `falsify-w8-papers` (`wrangler.w8-papers.jsonc`): public paper search, PDF proxy, and private PDF link Worker.
4. **GitHub Pages**: push `<sha>` to `main` so `.github/workflows/pages.yml` builds and publishes `app/dist`.

Operator-local values stay outside git: `/etc/falsify/*.env`, `~/.local/state/falsify/w8-drive-archive/store.env` (including `W8_PDF_STORE_TOKEN` and `RCLONE_CONFIG_DRIVE_ROOT_FOLDER_ID`), host account names in `falsify-agy-broker.service`, and Wrangler secrets.




## Durable storage requirement (exact)

The runtime store is **stateful and local**:

- `<state>/state.sqlite3` plus SQLite `-wal` / `-shm` side files (jobs, uploads, artifacts metadata,
  idempotency keys, usage).
- `<state>/blobs/` content-addressed upload and artifact bytes.
- `<state>/tmp/` short-lived native-worker scratch.

SQLite requires a **real local POSIX filesystem** with working advisory locks, atomic rename,
`fsync`, and directory durability. The volume must persist across service and container restarts and
be host-attached:

- **Viable:** a persistent volume attached to the runtime host (block/local SSD mount, or a Docker
  named volume on durable storage), owned by uid/gid `10001`.
- **Not viable:** the Cloudflare container disk (ephemeral; state is lost on restart), any
  object-store FUSE mount (S3/GCS via s3fs/gcsfuse: unsupported locking/rename/fsync semantics can
  corrupt SQLite), or a tmpfs.
- **Alternative (not implemented here):** redesign `Store` to external durable services — managed
  SQL (Postgres) for metadata with a conditional-write CAS layer, and object storage with checksum
  verification for blobs. That is a runtime code change, not packaging.

Back up the state directory as one unit (database + blobs are mutually referenced by SHA-256).

## Resource notes

- CPU/memory: one Python process plus a short-lived `paper_native_worker.py` child per visual/PDF
  operation (V8, OpenCV, PyMuPDF). `HOSTED_AI_MAX_CONCURRENCY` bounds parallel jobs; the default of
  2 fits ~2 vCPU / 4 GiB RAM with headroom for a 32 MiB upload and raster work. Lower concurrency if
  memory-constrained; chart raster paths are the peak consumers.
- Disk: image is roughly 0.9–1.2 GB (estimates, not measured here): OpenCV ~0.25–0.3 GB, numpy
  ~0.07 GB, mini-racer/V8 ~0.05 GB, PyMuPDF ~0.03 GB, fonts ~0.04 GB, base ~0.05 GB. State grows
  with uploads (default ≤32 MiB each) and generated artifacts; retention prunes jobs by default
  after 7 days.
- No GPU. Building needs registry access (Debian apt + PyPI wheels); running needs egress only to
  the provider endpoint in addition to the gateway's private network.

## What the image contains (and why the layout is flat)

The container keeps the repository-relative layout because the source computes paths:

- `app/local` → `/app/app/local` (`WORKDIR`, `python -m hosted_runtime`) because
  `red_service.py`/`harness_adapter.py` insert `Path(__file__).parents[2]` (repo root) to import
  `experiments/`.
- `experiments/` → `/app/experiments` (imported at module load by `red_service.py` and
  `cli_backend.py`).
- `app/dist/font-assets/`, `app/dist/recomposition-vendor/LiberationSans-*.ttf`,
  `app/dist/vendor/standard_fonts/`, `app/dist/chart-shape-core.js`,
  `app/dist/chart-shape-vendor/`, `app/dist/plottracer-vendor/` → `/app/app/dist/...` because
  `paper_visual_edit.py`, `paper_chart_shape_core.py`, `paper_chart.py` and `paper_plottracer.py`
  resolve `Path(__file__).parents[1]/dist`.

`PYTHONPATH=/app` makes the repo-root packages importable for every process, including the native
worker's parent. No provider SDK, no `.env`, no key, token or document is copied into any layer.

## Offline validation performed

From the repository root / `app/local` (Docker and the container runtime are not installed here):

```text
python -m hosted_runtime --help
  -> usage text: --bind/--port/--state-dir, exit 0
python -m hosted_runtime
  -> "configuration error: HOSTED_AI_STATE_DIR is required", exit 2
bash -n cloud/runtime/entrypoint.sh   -> syntax OK
bash -n cloud/runtime/build.sh        -> syntax OK
bash cloud/runtime/entrypoint.sh                     -> exit 2 (HOSTED_AI_SERVICE_TOKEN required)
bash cloud/runtime/entrypoint.sh                     -> exit 2 (HOSTED_AI_STATE_DIR required)
bash cloud/runtime/entrypoint.sh --check  (env set)  -> "configuration ok", exit 0; creates <state>/tmp
```

`build.sh` was exercised end-to-end with a stubbed `docker` command: it staged a 46 MB context with
`.dockerignore` at its root, no `__pycache__`, and every Dockerfile COPY source present. Pinned
versions in `requirements-runtime.txt` were checked against `app/local/requirements.txt` (all match;
the darwin-only pikepdf pin is intentionally omitted).

A loopback-only start of the exact entrypoint command
(`python -m hosted_runtime --bind 127.0.0.1 --port <p> --state-dir <tmp>`) with a synthetic service
token created `<state>/state.sqlite3` and `<state>/blobs/` and answered the authenticated
`GET /internal/v1/health` probe. No provider call was made.

`paper_chart_edit_service.capability()` reported `available: true`, confirming the six modules the
chart engine declares (`pymupdf`, `pikepdf`, `PIL`, `numpy`, `cv2`, `py_mini_racer`) are the right
dependency set.

systemd/venv option (added in this follow-up):

```text
bash -n cloud/runtime/install-venv.sh        -> syntax OK
bash -n cloud/runtime/entrypoint.sh          -> syntax OK
install-venv.sh --check                      -> "prerequisites ok" with host shims for the
                                                Linux-only commands (python3 3.12.10 present)
systemd unit structural check (configparser) -> sections Unit/Service/Install; User/Group
                                                falsify-runtime; WorkingDirectory /opt/falsify/app/local;
                                                EnvironmentFile /etc/falsify/runtime.env;
                                                ExecStart /opt/falsify/venv/bin/python -m hosted_runtime;
                                                HOSTED_AI_STATE_DIR=/var/lib/falsify; hardening keys
                                                present; no token name/value in the unit
```

`systemd-analyze verify` is **not available** in this environment (no systemd on the build host), so
the unit was validated structurally instead of by systemd itself. The real install path
(user/venv/systemctl) was not executed here: it needs root and systemd on the target GCE host.

The image itself was not built, so layer contents and size are unverified; the Dockerfile was checked
by inspection.

## Known blockers

- No `docker` binary here: image size, wheel availability for the pinned versions, and container
  startup are unverified. The first real build should be run by the coordinator.
- The systemd/venv install path was not executed (no root/systemd here), and `systemd-analyze verify`
  is unavailable; the unit was validated structurally. The host must provide systemd, Python 3.12
  with `python3-venv`, and the OpenCV shared libraries.
- The base image tag is pinned, not a digest; resolve and pin the digest at deploy time.
- OpenCV system libraries (`libgl1`, `libglib2.0-0`, `libgomp1`, `libsm6`, `libxext6`,
  `libxrender1`) are the bookworm set; if `import cv2` fails on a different base, add the missing
  X/GL libraries.
- Provider model IDs/effort allowlists and the live provider smoke remain outside this packaging.
