#!/usr/bin/env bash
# Install the Falsify hosted runtime as a systemd service on a host with a persistent disk.
#
# This is the no-Docker deployment option. It creates a dedicated venv, copies the runtime source
# layout, creates the state directory and installs the unit. It never writes a secret: the service
# environment is read by systemd from /etc/falsify/runtime.env (mode 0600, outside the repository).
#
# Usage:
#   sudo bash cloud/runtime/install-venv.sh            # install / update
#   bash cloud/runtime/install-venv.sh --check         # prerequisites only, no system changes
set -euo pipefail

PREFIX=/opt/falsify
VENV="$PREFIX/venv"
STATE_DIR=/var/lib/falsify
ENV_DIR=/etc/falsify
ENV_FILE=/etc/falsify/runtime.env
UNIT_NAME=falsify-runtime.service
UNIT_PATH=/etc/systemd/system/falsify-runtime.service
SERVICE_USER=falsify-runtime
SERVICE_GROUP=falsify-runtime
SERVICE_UID=10001
SERVICE_GID=10001

check_only=0
if [ "${1:-}" = "--check" ]; then
  check_only=1
elif [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
elif [ "$#" -gt 0 ]; then
  printf 'install-venv.sh: unknown argument: %s\n' "$1" >&2
  exit 2
fi

fail() {
  printf 'install-venv.sh: %s\n' "$1" >&2
  exit 2
}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"

# ---------------------------------------------------------------- prerequisites
command -v python3 >/dev/null 2>&1 || fail "python3 is required"
python3 - <<'PY' || fail "hosted runtime requires Python 3.12 (the pinned wheels are tested there)"
import sys
raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)
PY
python3 -c "import ensurepip" >/dev/null 2>&1 || fail "python3-venv is required (apt-get install python3-venv)"

LDCONFIG="$(command -v ldconfig || echo /sbin/ldconfig)"
[ -x "$LDCONFIG" ] || fail "ldconfig is required to verify OpenCV shared libraries"
missing=""
for lib in libGL.so.1 libglib-2.0.so.0 libgomp.so.1 libSM.so.6 libXext.so.6 libXrender.so.1; do
  "$LDCONFIG" -p 2>/dev/null | grep -q "$lib" || missing="$missing $lib"
done
if [ -n "$missing" ]; then
  printf 'install-venv.sh: missing shared libraries:%s\n' "$missing" >&2
  printf '  apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 libsm6 libxext6 libxrender1\n' >&2
  exit 2
fi

command -v systemctl >/dev/null 2>&1 || fail "systemctl is required (this option targets a systemd host)"

for required in \
  "$here/requirements-runtime.txt" \
  "$here/systemd/$UNIT_NAME" \
  "$repo_root/app/local/hosted_runtime/__main__.py" \
  "$repo_root/experiments/selfplay_codex.py" \
  "$repo_root/app/dist/font-assets" \
  "$repo_root/app/dist/recomposition-vendor/LiberationSans-Regular.ttf" \
  "$repo_root/app/dist/recomposition-vendor/LiberationSans-Bold.ttf" \
  "$repo_root/app/dist/recomposition-vendor/LiberationSans-Italic.ttf" \
  "$repo_root/app/dist/recomposition-vendor/LiberationSans-BoldItalic.ttf" \
  "$repo_root/app/dist/vendor/standard_fonts" \
  "$repo_root/app/dist/chart-shape-core.js" \
  "$repo_root/app/dist/chart-shape-vendor" \
  "$repo_root/app/dist/plottracer-vendor"; do
  [ -e "$required" ] || fail "missing required source: $required"
done

if [ "$check_only" = "1" ]; then
  printf 'install-venv.sh: prerequisites ok\n'
  printf '  source root: %s\n' "$repo_root"
  printf '  venv:        %s\n' "$VENV"
  printf '  source:      %s/app/local, %s/app/dist (subset), %s/experiments\n' "$PREFIX" "$PREFIX" "$PREFIX"
  printf '  state:       %s\n' "$STATE_DIR"
  printf '  unit:        %s\n' "$UNIT_PATH"
  printf '  env file:    %s (created with no secret values, mode 0600)\n' "$ENV_FILE"
  printf '  run without --check as root to install\n'
  exit 0
fi

[ "$(id -u)" = "0" ] || fail "run as root (sudo) to install the service"

# ---------------------------------------------------------------- identity and state
if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  groupadd --gid "$SERVICE_GID" "$SERVICE_GROUP"
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --uid "$SERVICE_UID" --gid "$SERVICE_GROUP" \
    --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
SERVICE_UID="$(id -u "$SERVICE_USER")"
SERVICE_GID="$(id -g "$SERVICE_USER")"

install -d -m 0700 -o "$SERVICE_UID" -g "$SERVICE_GID" "$STATE_DIR"
install -d -m 0700 -o "$SERVICE_UID" -g "$SERVICE_GID" "$STATE_DIR/tmp"
# Keep an existing state directory usable after a uid change; this is the durable database.
chown -R "$SERVICE_UID:$SERVICE_GID" "$STATE_DIR"
chmod 0700 "$STATE_DIR" "$STATE_DIR/tmp"

# ---------------------------------------------------------------- source layout
# The engines resolve repo-relative paths:
#   red_service.py        -> Path(__file__).parents[2] (needs <root>/experiments)
#   paper_visual_edit.py  -> Path(__file__).parents[1]/dist (needs <root>/app/dist)
# so the deployed tree keeps <root>/app/local, <root>/app/dist and <root>/experiments.
install -d -m 0755 "$PREFIX"
rm -rf "$PREFIX/app" "$PREFIX/experiments"
mkdir -p "$PREFIX/app/dist/vendor" "$PREFIX/app/dist/recomposition-vendor"

cp -a "$repo_root/app/local" "$PREFIX/app/local"
cp -a "$repo_root/experiments" "$PREFIX/experiments"
cp -a "$repo_root/app/dist/font-assets" "$PREFIX/app/dist/font-assets"
cp -a "$repo_root/app/dist/vendor/standard_fonts" "$PREFIX/app/dist/vendor/standard_fonts"
cp -a "$repo_root/app/dist/chart-shape-core.js" "$PREFIX/app/dist/chart-shape-core.js"
cp -a "$repo_root/app/dist/chart-shape-vendor" "$PREFIX/app/dist/chart-shape-vendor"
cp -a "$repo_root/app/dist/plottracer-vendor" "$PREFIX/app/dist/plottracer-vendor"
for font in LiberationSans-Regular.ttf LiberationSans-Bold.ttf \
            LiberationSans-Italic.ttf LiberationSans-BoldItalic.ttf; do
  cp -a "$repo_root/app/dist/recomposition-vendor/$font" "$PREFIX/app/dist/recomposition-vendor/$font"
done

find "$PREFIX/app" "$PREFIX/experiments" -name __pycache__ -type d -prune -exec rm -rf {} +
find "$PREFIX/app" "$PREFIX/experiments" -name '*.pyc' -delete
# The service runs unprivileged and must never be able to modify its own code.
chown -R root:root "$PREFIX/app" "$PREFIX/experiments"
chmod -R go-w "$PREFIX/app" "$PREFIX/experiments"

# ---------------------------------------------------------------- venv
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/python" -m pip --version >/dev/null 2>&1 || fail "pip is missing from $VENV (install python3-venv)"
"$VENV/bin/python" -m pip install --disable-pip-version-check --no-cache-dir \
  --only-binary=:all: -r "$here/requirements-runtime.txt"
"$VENV/bin/python" -c "import cv2, jsonschema, numpy, PIL, pikepdf, pymupdf, py_mini_racer" \
  || fail "pinned runtime dependencies did not import in $VENV"
PYTHONPATH="$PREFIX/app/local:$PREFIX" "$VENV/bin/python" -c \
  "import hosted_runtime, red_service, blue_service, paper_evidence, paper_text_span_mutator, paper_visual_edit" \
  || fail "runtime source did not import from $PREFIX (check the app/dist and experiments layout)"

# ---------------------------------------------------------------- environment file
# The installer never writes a secret. It only creates a correctly permissioned, value-free file
# that the operator fills from their secret manager; systemd fails closed until it is filled.
install -d -m 0750 "$ENV_DIR"
if [ ! -e "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<'EOF'
# Falsify hosted runtime environment. Mode 0600, outside the repository. systemd reads this file.
# Required (fill with values from your secret manager; do not commit them):
# HOSTED_AI_SERVICE_TOKEN=
# ANTHROPIC_API_KEY=
# Optional overrides:
# HOSTED_AI_BIND=127.0.0.1
# HOSTED_AI_PORT=8787
# ANTHROPIC_WORKSPACE_ID=
# HOSTED_AI_MODELS=claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5
# HOSTED_AI_DEFAULT_MODEL=claude-opus-5-5
# HOSTED_AI_DEFAULT_EFFORT=high
# HOSTED_AI_MAX_UPLOAD_BYTES=33554432
# HOSTED_AI_MAX_CONCURRENCY=2
# HOSTED_AI_MAX_CALLS=12
# HOSTED_AI_JOB_RETENTION_SECONDS=604800
EOF
  chown root:root "$ENV_FILE"
fi
chmod 0600 "$ENV_FILE"

# ---------------------------------------------------------------- unit
install -m 0644 -o root -g root "$here/systemd/$UNIT_NAME" "$UNIT_PATH"
systemctl daemon-reload
systemctl enable "$UNIT_NAME"

printf '\nInstalled. Next steps (values never come from this repository):\n'
printf '  1. sudoedit %s   # set HOSTED_AI_SERVICE_TOKEN and ANTHROPIC_API_KEY\n' "$ENV_FILE"
printf '  2. sudo systemctl start %s\n' "$UNIT_NAME"
printf '  3. systemctl status %s --no-pager\n' "$UNIT_NAME"
printf '  4. sudo journalctl -u %s -n 50 --no-pager\n' "$UNIT_NAME"
printf '\nDurable state: %s (state.sqlite3, blobs/, tmp/). Back it up as one unit.\n' "$STATE_DIR"
printf 'Health (loopback; export the token from %s in the calling shell):\n' "$ENV_FILE"
printf '  curl -fsS -H "X-Falsify-Service-Token: $HOSTED_AI_SERVICE_TOKEN" \\\n'printf '    -H "X-Falsify-Owner-Id: usr:00000000-0000-4000-8000-000000000000" \\\n'
printf '    http://127.0.0.1:8787/internal/v1/health\n'
