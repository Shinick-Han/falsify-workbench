#!/usr/bin/env bash
# Build the hosted runtime image from a minimal, staged build context.
#
# The repository root is the natural build context, but it also carries the whole built web app,
# caches and worktree metadata. This script copies only the source, the referenced app/dist assets
# and the packaging files into a temporary context with the same relative layout, then builds.
#
# Usage: bash cloud/runtime/build.sh [image-tag]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
image="${1:-falsify-hosted-runtime:local}"

command -v docker >/dev/null 2>&1 || {
  printf 'build.sh: docker is not available on this host\n' >&2
  exit 2
}

context="$(mktemp -d "${TMPDIR:-/tmp}/falsify-runtime-context.XXXXXX")"
cleanup() { rm -rf "$context"; }
trap cleanup EXIT

# Fail fast if the source tree no longer provides a file the Dockerfile copies.
for required in \
  app/local/hosted_runtime/__main__.py \
  experiments/selfplay_codex.py \
  app/dist/font-assets \
  app/dist/recomposition-vendor/LiberationSans-Regular.ttf \
  app/dist/recomposition-vendor/LiberationSans-Bold.ttf \
  app/dist/recomposition-vendor/LiberationSans-Italic.ttf \
  app/dist/recomposition-vendor/LiberationSans-BoldItalic.ttf \
  app/dist/vendor/standard_fonts \
  app/dist/chart-shape-core.js \
  app/dist/chart-shape-vendor \
  app/dist/plottracer-vendor; do
  [ -e "$repo_root/$required" ] || {
    printf 'build.sh: missing required source %s\n' "$required" >&2
    exit 2
  }
done

mkdir -p "$context/app/dist/vendor" "$context/experiments" "$context/cloud/runtime"

# Application source, without interpreter caches from the developer machine.
cp -a "$repo_root/app/local" "$context/app/local"
find "$context/app/local" -name __pycache__ -type d -prune -exec rm -rf {} +
find "$context/app/local" -name '*.pyc' -delete

# repo-root experiments/selfplay_codex.py is imported by red_service.py and cli_backend.py.
cp -a "$repo_root/experiments/." "$context/experiments/"
find "$context/experiments" -name __pycache__ -type d -prune -exec rm -rf {} +
find "$context/experiments" -name '*.pyc' -delete

# Only the dist assets the runtime path reads. See cloud/runtime/README.md for the references.
cp -a "$repo_root/app/dist/font-assets" "$context/app/dist/font-assets"
cp -a "$repo_root/app/dist/vendor/standard_fonts" "$context/app/dist/vendor/standard_fonts"
cp -a "$repo_root/app/dist/chart-shape-core.js" "$context/app/dist/chart-shape-core.js"
cp -a "$repo_root/app/dist/chart-shape-vendor" "$context/app/dist/chart-shape-vendor"
cp -a "$repo_root/app/dist/plottracer-vendor" "$context/app/dist/plottracer-vendor"

mkdir -p "$context/app/dist/recomposition-vendor"
for font in LiberationSans-Regular.ttf LiberationSans-Bold.ttf \
            LiberationSans-Italic.ttf LiberationSans-BoldItalic.ttf; do
  cp -a "$repo_root/app/dist/recomposition-vendor/$font" "$context/app/dist/recomposition-vendor/$font"
done

cp "$here/Dockerfile" "$context/cloud/runtime/Dockerfile"
cp "$here/entrypoint.sh" "$context/cloud/runtime/entrypoint.sh"
cp "$here/requirements-runtime.txt" "$context/cloud/runtime/requirements-runtime.txt"
cp "$here/.dockerignore" "$context/.dockerignore"

docker build -f "$context/cloud/runtime/Dockerfile" -t "$image" "$context"
printf 'built %s\n' "$image"
