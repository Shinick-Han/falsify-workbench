"""Hosted Anthropic execution runtime (durable jobs, artifacts, internal HTTP API).

The package intentionally exposes no provider credential and imports no model backend at
module import time.  ``RuntimeService`` only resolves ``red_service``/``blue_service`` inside
a worker when no test runner was injected.
"""

from .config import ConfigError, EFFORTS, RuntimeConfig
from .evidence import EvidenceError
from .pdf_input import PdfInputError, extract_pdf
from .service import RuntimeService, ServiceError, build_review_envelope
from .store import (IdempotencyConflict, JobIdConflict, RuntimeBusy, Store,
                    StoreError, StoreNotFound)
from .http_api import create_server, serve

__all__ = [
    'ConfigError',
    'EFFORTS',
    'EvidenceError',
    'IdempotencyConflict',
    'JobIdConflict',
    'PdfInputError',
    'RuntimeBusy',
    'RuntimeConfig',
    'RuntimeService',
    'ServiceError',
    'Store',
    'StoreError',
    'StoreNotFound',
    'build_review_envelope',
    'create_server',
    'extract_pdf',
    'serve',
]
