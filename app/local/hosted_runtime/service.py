"""Durable hosted review service: validation, engine seam, cancellation and artifacts."""

from __future__ import annotations

import importlib
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from .config import EFFORTS, RuntimeConfig
from .pdf_input import PdfInputError, extract_pdf
from .store import (IdempotencyConflict, JobIdConflict, Store, StoreError,
                    StoreNotFound)

JOB_ID_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_:-]{0,127}')
OWNER_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}')
HASH_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}')
OPAQUE_RE = re.compile(r'[!-~]{8,128}')
UPLOAD_MIMES = ('application/pdf', 'application/octet-stream', 'text/plain')
USAGE_KEYS = ('inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens')
_USAGE_SOURCES = (
    ('inputTokens', ('inputTokens', 'input_tokens')),
    ('outputTokens', ('outputTokens', 'output_tokens')),
    ('cacheReadInputTokens', ('cacheReadInputTokens', 'cache_read_input_tokens')),
    ('cacheCreationInputTokens', ('cacheCreationInputTokens', 'cache_creation_input_tokens')),
)

ERROR_MESSAGES = {
    'unauthorized': 'Service authentication failed.',
    'not_found': 'The requested resource was not found.',
    'invalid_request': 'The request is invalid.',
    'idempotency_conflict': 'This idempotency key was already used with a different request.',
    'job_id_conflict': 'This job id is already in use.',
    'payload_too_large': 'The request body exceeds the configured limit.',
    'upload_empty': 'The uploaded file is empty.',
    'unsupported_media_type': 'This file type is not supported.',
    'method_not_allowed': 'This HTTP method is not allowed.',
    'ai_unavailable': 'The AI runtime is unavailable.',
    'internal_error': 'The runtime could not complete the request.',
}

FAILURE_MESSAGES = {
    'runtime_restarted': 'The runtime restarted before this job completed; it was not replayed.',
    'runtime_unavailable': 'The runtime could not start this job.',
    'engine_error': 'The review engine could not complete this job.',
    'invalid_output': 'The review engine returned an unusable result.',
    'input_unavailable': 'The stored input for this job is unavailable.',
    'edit_invalid': 'The requested PDF edit could not be applied safely.',
    'pdf_corrupt': 'The PDF could not be read.',
    'pdf_encrypted': 'Encrypted PDFs are not supported.',
    'pdf_empty_text': 'The PDF contains no extractable text.',
    'pdf_too_large': 'The extracted document exceeds the review limit.',
    'unsupported_media_type': 'This input file type is not supported for hosted review.',
    'auth_required': 'Provider authentication failed.',
    'permission_denied': 'The provider denied this request.',
    'invalid_request': 'The provider rejected the request.',
    'not_found': 'The provider could not find the requested resource.',
    'request_too_large': 'The provider rejected the request size.',
    'rate_limited': 'The provider rate limit was reached.',
    'timeout': 'The provider request timed out.',
    'provider_error': 'The provider returned an error.',
    'overloaded': 'The provider is overloaded.',
    'provider_not_configured': 'The hosted provider key is not configured.',
    'provider_unavailable': 'The hosted provider is temporarily unavailable.',
    'provider_rejected': 'The provider rejected the hosted request.',
}
RETRYABLE_FAILURES = frozenset({'rate_limited', 'timeout', 'provider_error', 'overloaded', 'provider_unavailable'})
RETRYABLE_ERRORS = frozenset({'ai_unavailable'})


class ServiceError(Exception):
    """Public runtime error with a fixed code and a fixed message."""

    def __init__(self, code, status=400, retryable=None):
        self.code = code
        self.status = status
        self.message = ERROR_MESSAGES.get(code, ERROR_MESSAGES['invalid_request'])
        self.retryable = (code in RETRYABLE_ERRORS) if retryable is None else retryable
        super().__init__(self.message)


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':')).encode('utf-8')


def _failure(code, provider_request_id=None):
    if code not in FAILURE_MESSAGES:
        code = 'engine_error'
    failure = {
        'code': code,
        'message': FAILURE_MESSAGES[code],
        'retryable': code in RETRYABLE_FAILURES,
    }
    if provider_request_id:
        failure['requestId'] = provider_request_id
    return failure


def _provider_request_id(result):
    value = None
    for key in ('providerRequestId', 'providerRequestID'):
        candidate = result.get(key)
        if isinstance(candidate, str):
            value = candidate
            break
    if value is None:
        provider = result.get('provider')
        if isinstance(provider, dict) and isinstance(provider.get('requestId'), str):
            value = provider['requestId']
    if not isinstance(value, str) or not 1 <= len(value) <= 200 or any(ord(c) < 32 for c in value):
        return None
    return value


def _usage(result):
    value = result.get('usage')
    if not isinstance(value, dict):
        return None
    usage = {}
    for target, sources in _USAGE_SOURCES:
        for source in sources:
            count = value.get(source)
            if type(count) is int and count >= 0:
                usage[target] = count
                break
    return usage or None


def build_harness(role, prompt, max_calls, model, effort):
    return {
        'schema': 'falsify.harness.v1',
        'id': 'hosted-anthropic',
        'name': 'Hosted Anthropic',
        'version': '1',
        'role': role,
        'instructions': prompt,
        'maxCalls': max_calls,
        'adapter': {'type': 'hosted', 'model': model, 'effort': effort},
    }


def build_review_envelope(role, *, revision, request_id, source_hash, segments, prompt,
                         model, effort, max_calls, attack_types=None, level=None):
    """Build the documented hosted envelope.  Both roles use the hosted harness shape."""
    harness = build_harness(role, prompt, max_calls, model, effort)
    if role == 'red':
        envelope = {
            'schema': 'falsify.document-red.v1',
            'consent': True,
            'revision': revision,
            'requestId': request_id,
            'sourceHash': source_hash,
            'segments': segments,
            'maxCalls': max_calls,
            'harness': harness,
        }
        if attack_types is not None:
            envelope['attackTypes'] = list(attack_types)
        else:
            envelope['level'] = 4 if level is None else level
        return envelope
    if role == 'blue':
        return {
            'schema': 'falsify.document-blue.v1',
            'revision': revision,
            'requestId': request_id,
            'sourceHash': source_hash,
            'segments': segments,
            'maxCalls': max_calls,
            'consent': True,
            'harness': harness,
        }
    raise ValueError('role_invalid')


def _extraction_document(upload, extraction):
    return {
        'schema': 'falsify.hosted-extraction.v1',
        'revision': upload['sha256'],
        'sourceHash': extraction['sourceHash'],
        'pageCount': extraction['pageCount'],
        'segments': extraction['segments'],
        'coverage': {
            'pages': extraction['pageCount'],
            'blocks': extraction['blockCount'],
            'characters': extraction['characters'],
            'complete': True,
            'meaning': ('Every extractable text block was read in page/block order. '
                        'Images, drawings and non-text content are not included.'),
        },
    }


def _apply_pdf_edits(pdf_bytes, edits):
    from paper_text_span_mutator import mutate_pdf_text_spans
    outcome = mutate_pdf_text_spans(pdf_bytes, edits)
    data = outcome.get('pdfBytes') if isinstance(outcome, dict) else None
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise ValueError('edit_output_invalid')
    return bytes(data)


@dataclass(frozen=True)
class _JobRequest:
    owner_id: str
    job_id: str
    role: str
    prompt: str
    upload_id: str
    model: str
    effort: str
    max_calls: int
    edits: tuple
    attack_types: tuple
    level: int
    cancelled: threading.Event


class RuntimeService:
    PROGRESS_INTERVAL_SECONDS = 0.5

    def __init__(self, config, *, store=None, review_runner=None, backend_factory=None):
        if not isinstance(config, RuntimeConfig):
            raise TypeError('RuntimeConfig required')
        self.config = config
        self.store = store if store is not None else Store(config.state_dir)
        self.review_runner = review_runner
        self.backend_factory = backend_factory
        self._events = {}
        self._lock = threading.RLock()
        self._closed = False
        self.recovered = self.store.mark_recovered(_failure('runtime_restarted'))
        if config.job_retention_seconds:
            try:
                self.store.prune_jobs(retention_seconds=config.job_retention_seconds)
            except StoreError:
                pass
        self._executor = ThreadPoolExecutor(max_workers=config.max_concurrency,
                                            thread_name_prefix='falsify-hosted')

    # ------------------------------------------------------------------- uploads
    def create_upload(self, owner_id, name, mime, data):
        self._check_owner(owner_id)
        if not isinstance(name, str) or not 1 <= len(name) <= 255 or any(ord(c) < 32 for c in name):
            raise ServiceError('invalid_request', 400)
        if mime not in UPLOAD_MIMES:
            raise ServiceError('unsupported_media_type', 415)
        if not isinstance(data, (bytes, bytearray)):
            raise ServiceError('invalid_request', 400)
        raw = bytes(data)
        if not raw:
            raise ServiceError('upload_empty', 400)
        if len(raw) > self.config.max_upload_bytes:
            raise ServiceError('payload_too_large', 413)
        upload, created = self.store.put_upload(owner_id, name, mime, raw)
        result = {
            'id': upload['id'],
            'sha256': upload['sha256'],
            'bytes': upload['bytes'],
            'name': upload['name'],
            'mime': upload['mime'],
            'createdAt': upload['createdAt'],
            'deduplicated': not created,
        }
        return result, created

    # ---------------------------------------------------------------------- jobs
    def submit_job(self, body, owner_id=None):
        validated = self._validate_job(body, owner_id)
        owner = validated['owner_id']
        try:
            upload = self.store.get_upload(owner, validated['uploadId'])
        except StoreNotFound:
            raise ServiceError('not_found', 404) from None
        progress = {
            'completedCalls': 0,
            'requiredCalls': validated['maxCalls'],
            'phase': 'queued',
        }
        try:
            job, created = self.store.create_job(
                owner_id=owner,
                job_id=validated['jobId'],
                idempotency_key=validated['idempotencyKey'],
                request_hash=validated['requestHash'],
                role=validated['role'],
                model=validated['model'],
                effort=validated['effort'],
                provider=self.config.provider,
                progress=progress,
            )
        except IdempotencyConflict:
            raise ServiceError('idempotency_conflict', 409) from None
        except JobIdConflict:
            raise ServiceError('job_id_conflict', 409) from None
        if not created:
            return self.snapshot(job), True
        request = _JobRequest(
            owner_id=owner,
            job_id=job['id'],
            role=validated['role'],
            prompt=validated['prompt'],
            upload_id=upload['id'],
            model=validated['model'],
            effort=validated['effort'],
            max_calls=validated['maxCalls'],
            edits=tuple(validated['edits'] or ()),
            attack_types=tuple(validated['attackTypes']) if validated['attackTypes'] is not None else None,
            level=validated['level'],
            cancelled=threading.Event(),
        )
        self._schedule(request)
        return self.snapshot(job), False

    def _schedule(self, request):
        with self._lock:
            self._events[request.job_id] = request.cancelled
        try:
            self._executor.submit(self._execute, request)
        except RuntimeError:
            with self._lock:
                self._events.pop(request.job_id, None)
            try:
                self.store.transition(request.owner_id, request.job_id, ('queued',), 'failed',
                                      failure=_failure('runtime_unavailable'), completed=True)
            except StoreError:
                pass
            raise ServiceError('ai_unavailable', 503) from None

    def get_job(self, owner_id, job_id):
        self._check_owner(owner_id)
        self._check_job_id(job_id)
        try:
            job = self.store.get_job(owner_id, job_id)
        except StoreNotFound:
            raise ServiceError('not_found', 404) from None
        return self.snapshot(job)

    def cancel_job(self, owner_id, job_id):
        self._check_owner(owner_id)
        self._check_job_id(job_id)
        try:
            job = self.store.request_cancel(owner_id, job_id)
        except StoreNotFound:
            raise ServiceError('not_found', 404) from None
        if job['state'] == 'cancelling':
            with self._lock:
                event = self._events.get(job_id)
            if event is not None:
                event.set()
        return self.snapshot(job)

    def get_artifact(self, owner_id, job_id, artifact_id):
        self._check_owner(owner_id)
        self._check_job_id(job_id)
        if not isinstance(artifact_id, str) or not artifact_id or len(artifact_id) > 128:
            raise ServiceError('not_found', 404)
        try:
            return self.store.get_artifact(owner_id, job_id, artifact_id)
        except StoreNotFound:
            raise ServiceError('not_found', 404) from None

    def snapshot(self, job):
        artifacts = self.store.list_artifacts(job['ownerId'], job['id'])
        result = {
            'id': job['id'],
            'role': job['role'],
            'state': job['state'],
            'progress': job['progress'],
            'model': job['model'],
            'effort': job['effort'],
            'provider': job['provider'],
            'artifacts': artifacts,
            'createdAt': job['createdAt'],
            'updatedAt': job['updatedAt'],
        }
        if job['usage'] is not None:
            result['usage'] = job['usage']
        if job.get('providerRequestId'):
            result['providerRequestId'] = job['providerRequestId']
        if job['result'] is not None:
            result['result'] = job['result']
        if job['failure'] is not None:
            result['failure'] = job['failure']
        if job['completedAt'] is not None:
            result['completedAt'] = job['completedAt']
        return result

    def health(self):
        return self.config.public_health(self.store.ping())

    # ------------------------------------------------------------------ execution
    def _execute(self, request):
        try:
            try:
                job = self.store.get_job(request.owner_id, request.job_id)
            except StoreNotFound:
                return
            if request.cancelled.is_set() or job['state'] == 'cancelling':
                self._finish_cancelled(request)
                return
            if job['state'] != 'queued':
                return
            if not self.store.transition(request.owner_id, request.job_id, ('queued',), 'running'):
                self._finish_cancelled(request)
                return
            self.store.update_progress(request.owner_id, request.job_id, {
                'completedCalls': 0,
                'requiredCalls': request.max_calls,
                'phase': 'running',
            })
            upload, raw = self.store.read_upload_bytes(request.owner_id, request.upload_id)
            if upload['mime'] == 'text/plain':
                raise ServiceError('unsupported_media_type', 415)
            if request.cancelled.is_set():
                self._finish_cancelled(request)
                return
            extraction = extract_pdf(raw)
            self.store.add_artifact(request.owner_id, request.job_id, 'extracted.json',
                                    'application/json',
                                    _json_bytes(_extraction_document(upload, extraction)))
            if request.cancelled.is_set():
                self._finish_cancelled(request)
                return
            envelope = build_review_envelope(
                request.role,
                revision=upload['sha256'],
                request_id=request.job_id,
                source_hash=extraction['sourceHash'],
                segments=extraction['segments'],
                prompt=request.prompt,
                model=request.model,
                effort=request.effort,
                max_calls=request.max_calls,
                attack_types=request.attack_types,
                level=request.level,
            )
            result = self._run_engine(envelope, request)
            if request.cancelled.is_set():
                self._finish_cancelled(request)
                return
            if not isinstance(result, dict) \
                    or result.get('schema') != (
                        'falsify.document-red.v1' if request.role == 'red'
                        else 'falsify.document-blue.v1'):
                raise ServiceError('invalid_output', 502)
            usage = _usage(result)
            provider_request_id = _provider_request_id(result)
            if request.role == 'red' and request.edits:
                self.store.add_artifact(request.owner_id, request.job_id, 'review.json',
                                        'application/json', _json_bytes(result))
                if request.cancelled.is_set():
                    self._finish_cancelled(request)
                    return
                try:
                    edited = _apply_pdf_edits(raw, list(request.edits))
                except Exception:
                    self._fail(request, 'edit_invalid', result=result, usage=usage,
                               provider_request_id=provider_request_id)
                    return
                if request.cancelled.is_set():
                    self._finish_cancelled(request)
                    return
                self.store.add_artifact(request.owner_id, request.job_id, 'edited.pdf',
                                        'application/pdf', edited)
                ok = self.store.transition(
                    request.owner_id, request.job_id, ('running',), 'completed',
                    result=result, usage=usage, provider_request_id=provider_request_id,
                    completed=True)
            else:
                ok = self.store.complete_job(
                    request.owner_id, request.job_id,
                    result=result, result_bytes=_json_bytes(result), usage=usage,
                    provider_request_id=provider_request_id)
            if not ok:
                self._finish_cancelled(request)
        except PdfInputError as error:
            self._fail(request, error.code)
        except ServiceError as error:
            self._fail(request, error.code)
        except StoreError:
            self._fail(request, 'input_unavailable')
        except Exception as error:
            if request.cancelled.is_set():
                self._finish_cancelled(request)
            else:
                self._fail(request, _classify_engine_error(error))
        finally:
            with self._lock:
                self._events.pop(request.job_id, None)

    def _run_engine(self, data, request):
        progress = self._progress_callback(request)
        if self.review_runner is not None:
            return self.review_runner(data, progress, request.cancelled)
        module_name = 'red_service' if request.role == 'red' else 'blue_service'
        module = importlib.import_module(module_name)
        kwargs = {}
        if self.backend_factory is not None:
            kwargs['backend_factory'] = self.backend_factory
        return module.run_review(data, progress, request.cancelled, **kwargs)

    def _progress_callback(self, request):
        last = {'persisted': False, 'phase': None, 'time': 0.0}

        def report(value):
            if request.cancelled.is_set() or not isinstance(value, dict):
                return
            completed = value.get('completedCalls')
            required = value.get('requiredCalls')
            phase = value.get('phase')
            if type(completed) is not int or not 0 <= completed <= 10000:
                return
            if type(required) is not int or not 1 <= required <= 10000:
                return
            if not isinstance(phase, str) or not phase.strip() or len(phase) > 64 \
                    or any(ord(c) < 32 for c in phase):
                phase = 'running'
            now = time.monotonic()
            if (not last['persisted'] or phase != last['phase']
                    or now - last['time'] >= self.PROGRESS_INTERVAL_SECONDS):
                progress = {'completedCalls': completed, 'requiredCalls': required,
                            'phase': phase}
                try:
                    self.store.update_progress(request.owner_id, request.job_id, progress)
                except StoreError:
                    return
                last.update(persisted=True, phase=phase, time=now)

        return report

    def _fail(self, request, code, *, result=None, usage=None, provider_request_id=None):
        if request.cancelled.is_set():
            self._finish_cancelled(request)
            return
        kwargs = {'failure': _failure(code, provider_request_id), 'completed': True}
        if result is not None:
            kwargs['result'] = result
        if usage is not None:
            kwargs['usage'] = usage
        if provider_request_id is not None:
            kwargs['provider_request_id'] = provider_request_id
        try:
            ok = self.store.transition(request.owner_id, request.job_id,
                                       ('queued', 'running'), 'failed', **kwargs)
        except StoreError:
            return
        if not ok:
            self._finish_cancelled(request)

    def _finish_cancelled(self, request):
        try:
            self.store.transition(request.owner_id, request.job_id,
                                  ('queued', 'running', 'cancelling'), 'cancelled',
                                  completed=True)
        except StoreError:
            pass

    # ----------------------------------------------------------------- validation
    @staticmethod
    def _check_owner(owner_id):
        if not isinstance(owner_id, str) or not OWNER_RE.fullmatch(owner_id):
            raise ServiceError('unauthorized', 401)

    @staticmethod
    def _check_job_id(job_id):
        if not isinstance(job_id, str) or not JOB_ID_RE.fullmatch(job_id):
            raise ServiceError('not_found', 404)

    def _validate_job(self, body, owner_id):
        if not isinstance(body, dict):
            raise ServiceError('invalid_request', 400)
        allowed = {'jobId', 'ownerId', 'idempotencyKey', 'requestHash', 'role', 'prompt',
                   'uploadId', 'model', 'effort', 'budget', 'harness', 'edits',
                   'attackTypes', 'level'}
        if set(body) - allowed:
            raise ServiceError('invalid_request', 400)
        supplied_owner = body.get('ownerId')
        if not isinstance(supplied_owner, str):
            raise ServiceError('invalid_request', 400)
        self._check_owner(supplied_owner)
        if owner_id is None:
            owner_id = supplied_owner
        self._check_owner(owner_id)
        if owner_id != supplied_owner:
            raise ServiceError('invalid_request', 400)

        job_id = body.get('jobId')
        if not isinstance(job_id, str) or not JOB_ID_RE.fullmatch(job_id):
            raise ServiceError('invalid_request', 400)
        idempotency = body.get('idempotencyKey')
        if not isinstance(idempotency, str) or not OPAQUE_RE.fullmatch(idempotency):
            raise ServiceError('invalid_request', 400)
        request_hash = body.get('requestHash')
        if not isinstance(request_hash, str) or not HASH_RE.fullmatch(request_hash):
            raise ServiceError('invalid_request', 400)
        role = body.get('role')
        if role not in ('red', 'blue'):
            raise ServiceError('invalid_request', 400)
        prompt = body.get('prompt')
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8000 \
                or '\0' in prompt:
            raise ServiceError('invalid_request', 400)
        upload_id = body.get('uploadId')
        if not isinstance(upload_id, str) or not 1 <= len(upload_id) <= 128:
            raise ServiceError('invalid_request', 400)

        if 'model' in body:
            model = body['model']
            if not isinstance(model, str) or model not in self.config.models:
                raise ServiceError('invalid_request', 400)
        else:
            model = self.config.default_model
        if 'effort' in body:
            effort = body['effort']
            if not isinstance(effort, str) or effort not in EFFORTS \
                    or effort not in self.config.efforts:
                raise ServiceError('invalid_request', 400)
        else:
            effort = self.config.default_effort

        budget = body.get('budget')
        requested_calls = None
        if budget is not None:
            if not isinstance(budget, dict) or set(budget) - {'maxCalls'}:
                raise ServiceError('invalid_request', 400)
            if 'maxCalls' in budget:
                requested = budget['maxCalls']
                if type(requested) is not int or not 1 <= requested <= 512:
                    raise ServiceError('invalid_request', 400)
                requested_calls = requested
        max_calls = min(requested_calls if requested_calls is not None
                        else self.config.max_calls, self.config.max_calls)
        max_calls = max(1, max_calls)

        harness = body.get('harness')
        if harness is not None:
            if not isinstance(harness, dict) \
                    or set(harness) - {'schema', 'id', 'name', 'version', 'role',
                                       'instructions', 'maxCalls', 'adapter'}:
                raise ServiceError('invalid_request', 400)
            adapter = harness.get('adapter')
            if not isinstance(adapter, dict) or adapter.get('type') != 'hosted' \
                    or set(adapter) - {'type', 'model', 'effort'}:
                raise ServiceError('invalid_request', 400)

        edits = body.get('edits')
        if edits is not None:
            if role != 'red' or not isinstance(edits, list) or len(edits) > 100 \
                    or any(not isinstance(edit, dict) for edit in edits):
                raise ServiceError('invalid_request', 400)

        attack_types = body.get('attackTypes')
        if attack_types is not None:
            if not isinstance(attack_types, list):
                raise ServiceError('invalid_request', 400)
            try:
                from red_service import attack_types as validate_attack_types
                attack_types = validate_attack_types({'attackTypes': attack_types})
            except Exception:
                raise ServiceError('invalid_request', 400) from None
        level = body.get('level')
        if level is not None and (type(level) is not int or level not in (1, 2, 3, 4)):
            raise ServiceError('invalid_request', 400)

        return {
            'owner_id': owner_id,
            'jobId': job_id,
            'idempotencyKey': idempotency,
            'requestHash': request_hash,
            'role': role,
            'prompt': prompt,
            'uploadId': upload_id,
            'model': model,
            'effort': effort,
            'maxCalls': max_calls,
            'edits': edits,
            'attackTypes': attack_types,
            'level': level,
        }

    # --------------------------------------------------------------------- close
    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._executor.shutdown(wait=True, cancel_futures=True)
        with self._lock:
            self._events.clear()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


def _classify_engine_error(error):
    code = getattr(error, 'code', None) or getattr(error, 'error_code', None)
    if code in FAILURE_MESSAGES:
        return code
    if isinstance(error, TimeoutError):
        return 'timeout'
    return 'engine_error'
