#!/usr/bin/env bash
# Fail-closed launcher for the Falsify hosted runtime (internal API).
# Secrets are read from the environment and are never printed. `--check` validates the
# configuration and the state directory without binding a socket.
set -euo pipefail

check_only=0
if [ "${1:-}" = "--check" ]; then
  check_only=1
  shift
fi

fail() {
  printf 'hosted-runtime: %s\n' "$1" >&2
  exit 2
}

if [ "$(id -u)" = "0" ]; then
  fail "refusing to run as root; use the unprivileged image user (uid 10001)"
fi

# Required: the shared service token and the durable state directory. Never echo either value.
if [ -z "${HOSTED_AI_SERVICE_TOKEN:-}" ]; then
  fail "HOSTED_AI_SERVICE_TOKEN is required"
fi
if [ -z "${HOSTED_AI_STATE_DIR:-}" ]; then
  fail "HOSTED_AI_STATE_DIR is required"
fi

state_dir="${HOSTED_AI_STATE_DIR}"
mkdir -p -- "$state_dir" || fail "state directory is not creatable"
[ -w "$state_dir" ] || fail "state directory is not writable by uid $(id -u)"

# All temporary files stay inside the explicit state directory, never in image layers.
tmp_dir="${state_dir%/}/tmp"
mkdir -p -- "$tmp_dir" || fail "state tmp directory is not creatable"
[ -w "$tmp_dir" ] || fail "state tmp directory is not writable"
export TMPDIR="$tmp_dir"

# Container-internal bind. The network boundary is the gateway; never publish this port.
bind="${HOSTED_AI_BIND:-0.0.0.0}"
port="${HOSTED_AI_PORT:-8787}"

if [ "$check_only" = "1" ]; then
  printf 'hosted-runtime: configuration ok\n'
  exit 0
fi

cd /app/app/local || fail "application source directory is missing"
# The runtime validates the token shape, model/effort allowlists and numeric ranges itself and
# exits 2 on a configuration error (fail closed, no partial start).
exec python -m hosted_runtime --bind "$bind" --port "$port" --state-dir "$state_dir"
