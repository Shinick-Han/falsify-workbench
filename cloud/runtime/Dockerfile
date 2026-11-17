# Falsify hosted Python runtime (container-internal HTTP API).
# Build context: the repository root, so the app/local -> app/dist and repo-root
# experiments/ import layout is preserved exactly as in the source tree.
# Recommended: ./cloud/runtime/build.sh (stages a minimal context). See README.md.
#
# No secret, API key, workspace ID, token or private document is baked into any layer.
ARG PYTHON_BASE=python:3.12.10-slim-bookworm
FROM ${PYTHON_BASE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PYTHONPATH=/app \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Shared objects required by the pinned wheels. PyMuPDF (MuPDF), pikepdf (qpdf) and
# mini-racer (V8) ship their native libraries inside the wheels; OpenCV does not.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgl1 \
      libglib2.0-0 \
      libgomp1 \
      libsm6 \
      libxext6 \
      libxrender1 \
 && rm -rf /var/lib/apt/lists/*

COPY cloud/runtime/requirements-runtime.txt /tmp/requirements-runtime.txt
RUN python -m pip install --no-cache-dir --only-binary=:all: -r /tmp/requirements-runtime.txt \
 && rm -f /tmp/requirements-runtime.txt

# Unprivileged identity for the runtime process: no home directory, no login shell.
RUN groupadd --gid 10001 falsify \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin falsify

# The source tree layout must stay intact:
#   red_service.py inserts Path(__file__).parents[2] (the repo root) to import experiments/
#   paper_visual_edit.py and paper_chart_shape_core.py resolve Path(__file__).parents[1]/dist
# so the container keeps app/local, app/dist and experiments/ at the same relative positions.
WORKDIR /app/app/local
COPY app/local/ /app/app/local/
COPY experiments/ /app/experiments/
# Only the dist assets the runtime/evidence/chart path actually reads.
COPY app/dist/font-assets/ /app/app/dist/font-assets/
COPY app/dist/recomposition-vendor/LiberationSans-Regular.ttf \
     app/dist/recomposition-vendor/LiberationSans-Bold.ttf \
     app/dist/recomposition-vendor/LiberationSans-Italic.ttf \
     app/dist/recomposition-vendor/LiberationSans-BoldItalic.ttf \
     /app/app/dist/recomposition-vendor/
COPY app/dist/vendor/standard_fonts/ /app/app/dist/vendor/standard_fonts/
COPY app/dist/chart-shape-core.js /app/app/dist/chart-shape-core.js
COPY app/dist/chart-shape-vendor/ /app/app/dist/chart-shape-vendor/
COPY app/dist/plottracer-vendor/ /app/app/dist/plottracer-vendor/
COPY cloud/runtime/entrypoint.sh /usr/local/bin/falsify-runtime-entrypoint

# Offline build-time checks only: import the pinned wheels and the runtime/engine modules.
# No provider call, no document, no state write happens here.
RUN find /app -name __pycache__ -type d -prune -exec rm -rf {} + \
 && find /app -name '*.pyc' -delete \
 && chmod 0555 /usr/local/bin/falsify-runtime-entrypoint \
 && python -c "import cv2, jsonschema, numpy, PIL, pikepdf, pymupdf, py_mini_racer" \
 && python -c "import hosted_runtime, red_service, blue_service, paper_evidence, paper_text_span_mutator, paper_visual_edit"

# The only writable application path. Mount a durable POSIX volume here, owned by uid/gid 10001.
RUN install -d -m 0700 -o 10001 -g 10001 /var/lib/falsify-runtime

USER 10001:10001
# The port is container-internal. Never publish it publicly; only the gateway may reach it.
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/falsify-runtime-entrypoint"]
