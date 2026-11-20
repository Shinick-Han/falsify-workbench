#!/usr/bin/env bash
# Usage (from the repo root): bash tools/perf/booth-bench/run.sh <scenario.mjs|hol.mjs|ba.mjs|browser-bench.mjs> [ENV=VALUE ...]
# Needs cloud/api/node_modules (miniflare, esbuild) and app/node_modules (playwright) plus BROWSER_EXECUTABLE for the browser bench.
# scenario: route latency and D1 calls per route (D1_LAT_MS, CACHE, N, ACTIVE). hol: submission size vs concurrent claims.
# ba: PDF repeat and claim poll cost. browser-bench: event.html steps under CDP CPU/network throttling (PROFILES, RUNS, OUT,
# MISSION_PDF = a local copy of arXiv 2309.15217; BENCH_PAGE_PORT / BENCH_API_PORT, default 8951 / 8952).
# Everything runs locally: the Worker's upstream fetches are stubbed and refused otherwise, and the browser aborts
# any request that is not the local page server or the local Worker.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
script="$1"; shift
vars="$(node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8").split("\n").map(l=>l.replace(/^\s*\/\/.*$/,"")).join("\n");process.stdout.write(JSON.stringify(JSON.parse(t).env.event.vars))' "$root/cloud/api/wrangler.jsonc")"
cd "$here"
env API_ROOT="$root/cloud/api" APP_ROOT="$root/app" ENTRY="$here/bench-entry.mjs" EVENT_VARS="$vars" "$@" node "$script"
