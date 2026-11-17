"""Durable hosted review service: validation, engine seam, cancellation and artifacts."""

from __future__ import annotations

import importlib
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from .config import EFFORTS, RuntimeConfig
from .evidence import (EvidenceError, apply_edits as apply_evidence_edits,
                       artifact as evidence_artifact, check_text_ambiguity,
                       configure_store, handle as evidence_handle,
                       prepare as prepare_evidence, release_store)
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
    'evidence_expired': 'The prepared PDF evidence is no longer available.',
    'evidence_unavailable': 'The prepared PDF evidence is unavailable.',
    'evidence_cancelled': 'Evidence preparation was cancelled.',
    'evidence_too_large': 'The PDF exceeds the structured evidence limit.',
    'evidence_input_invalid': 'The PDF could not be prepared as structured evidence.',
    'evidence_extraction_failed': 'Structured table/figure evidence could not be prepared.',
    'apply_source_mismatch': 'The apply request does not match the stored source PDF.',
    'apply_no_edits': 'No selected edits were supplied for the apply request.',
    'apply_verify_failed': 'The edited PDF failed hash or page-count verification.',
    'apply_edit_incomplete': 'One or more selected edits could not be fully applied.',
    'apply_edit_invalid': 'A selected text edit could not be applied safely.',
    'apply_edit_trace': 'A selected text edit would leave a text-layer trace.',
    'apply_edit_ambiguous': 'A selected text edit matches multiple locations; choose one explicitly.',
    'visual_edit_invalid': 'A selected table/figure edit is invalid for this PDF.',
    'visual_edit_kind_unsupported': 'This visual edit kind is not supported for apply.',
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
                         model, effort, max_calls, attack_types=None, level=None,
                         paper_evidence=None, file_hash=None):
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
    elif role == 'blue':
        envelope = {
            'schema': 'falsify.document-blue.v1',
            'revision': revision,
            'requestId': request_id,
            'sourceHash': source_hash,
            'segments': segments,
            'maxCalls': max_calls,
            'consent': True,
            'harness': harness,
        }
    else:
        raise ValueError('role_invalid')
    if paper_evidence is not None:
        envelope['paperEvidence'] = dict(paper_evidence)
        envelope['paperEvidenceConsent'] = True
        envelope['fileHash'] = file_hash
    return envelope


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
    from paper_text_span_mutator import SpanMutationError, mutate_pdf_text_spans
    check_text_ambiguity(pdf_bytes, list(edits))
    try:
        outcome = mutate_pdf_text_spans(pdf_bytes, edits, allow_trace=False)
    except SpanMutationError as error:
        if getattr(error, 'code', None) == 'text_span_trace_detected':
            raise EvidenceError('apply_edit_trace') from None
        raise EvidenceError('edit_invalid') from None
    except Exception:
        raise EvidenceError('edit_invalid') from None
    data = outcome.get('pdfBytes') if isinstance(outcome, dict) else None
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise EvidenceError('edit_invalid')
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
    visual_edits: tuple
    attack_types: tuple
    level: int
    apply_only: bool
    use_evidence: bool
    cancelled: threading.Event


JOB_BODY_KEYS = {'jobId', 'ownerId', 'idempotencyKey', 'requestHash', 'role', 'prompt',
                 'uploadId', 'model', 'effort', 'budget', 'harness', 'edits',
                 'visualEdits', 'attackTypes', 'level', 'applyOnly', 'useEvidence'}
HARNESS_KEYS = {'schema', 'id', 'name', 'version', 'role', 'instructions', 'maxCalls', 'adapter'}


def _require(condition):
    if not condition:
        raise ServiceError('invalid_request', 400)


def _job_owner(body, owner_id, check_owner):
    _require(isinstance(body, dict))
    _require(not (set(body) - JOB_BODY_KEYS))
    supplied = body.get('ownerId')
    _require(isinstance(supplied, str))
    check_owner(supplied)
    if owner_id is None:
        owner_id = supplied
    check_owner(owner_id)
    _require(owner_id == supplied)
    return owner_id


def _job_ids(body):
    job_id = body.get('jobId')
    _require(isinstance(job_id, str) and JOB_ID_RE.fullmatch(job_id) is not None)
    idempotency = body.get('idempotencyKey')
    _require(isinstance(idempotency, str) and OPAQUE_RE.fullmatch(idempotency) is not None)
    request_hash = body.get('requestHash')
    _require(isinstance(request_hash, str) and HASH_RE.fullmatch(request_hash) is not None)
    return job_id, idempotency, request_hash


def _job_flags(body):
    role = body.get('role')
    _require(role in ('red', 'blue'))
    apply_only = body.get('applyOnly', False)
    _require(type(apply_only) is bool)
    use_evidence = body.get('useEvidence', True)
    _require(type(use_evidence) is bool)
    _require(not (apply_only and role != 'red'))
    return role, apply_only, use_evidence


def _job_prompt(body, apply_only):
    prompt = body.get('prompt')
    if apply_only and prompt is None:
        prompt = ''
    _require(isinstance(prompt, str) and len(prompt) <= 8000 and '\0' not in prompt)
    if not apply_only:
        _require(bool(prompt.strip()))
    return prompt


def _job_upload_id(body):
    upload_id = body.get('uploadId')
    _require(isinstance(upload_id, str) and 1 <= len(upload_id) <= 128)
    return upload_id


def _job_model(config, body):
    model = body.get('model', config.default_model)
    _require(isinstance(model, str) and model in config.models)
    effort = body.get('effort', config.default_effort)
    _require(isinstance(effort, str) and effort in EFFORTS and effort in config.efforts)
    return model, effort


def _job_budget(body, apply_only, default_calls):
    budget = body.get('budget')
    requested_calls = None
    if budget is not None:
        _require(isinstance(budget, dict) and not (set(budget) - {'maxCalls'}))
        if 'maxCalls' in budget:
            requested = budget['maxCalls']
            _require(type(requested) is int and 0 <= requested <= 512)
            _require(not (requested == 0 and not apply_only))
            requested_calls = requested
    if requested_calls == 0:
        return 1
    maximum = default_calls if requested_calls is None else min(requested_calls, default_calls)
    return max(1, maximum)


def _job_harness(body):
    harness = body.get('harness')
    if harness is None:
        return
    _require(isinstance(harness, dict) and not (set(harness) - HARNESS_KEYS))
    adapter = harness.get('adapter')
    _require(isinstance(adapter, dict) and adapter.get('type') == 'hosted')
    _require(not (set(adapter) - {'type', 'model', 'effort'}))


def _job_edits(body, role, apply_only):
    edits = body.get('edits')
    if edits is not None:
        _require(role == 'red' and isinstance(edits, list) and len(edits) <= 100)
        _require(all(isinstance(edit, dict) for edit in edits))
    visual_edits = body.get('visualEdits')
    if visual_edits is not None:
        _require(role == 'red' and apply_only and isinstance(visual_edits, list)
                 and len(visual_edits) <= 12)
        _require(all(isinstance(edit, dict) for edit in visual_edits))
    if apply_only:
        _require(bool(edits or visual_edits))
    return edits, visual_edits


def _job_attack(body):
    attack_types = body.get('attackTypes')
    if attack_types is not None:
        _require(isinstance(attack_types, list))
        try:
            from red_service import attack_types as validate_attack_types
            attack_types = validate_attack_types({'attackTypes': attack_types})
        except Exception:
            raise ServiceError('invalid_request', 400) from None
    level = body.get('level')
    if level is not None:
        _require(type(level) is int and level in (1, 2, 3, 4))
    return attack_types, level


def _pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _acquire_state_lock(state_dir):
    """Fail closed when another RuntimeService owns this state directory."""
    path = Path(state_dir) / 'runtime.lock'
    for _attempt in range(2):
        try:
            descriptor = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                content = path.read_text(encoding='ascii')
            except OSError:
                content = ''
            pid = None
            try:
                pid = int(content.splitlines()[0].strip())
            except (IndexError, ValueError):
                pid = None
            if pid is not None and _pid_alive(pid):
                raise StoreError('state_in_use') from None
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                raise StoreError('state_in_use') from None
            continue
        except OSError:
            raise StoreError('state_in_use') from None
        try:
            os.write(descriptor, ('%d\n' % os.getpid()).encode('ascii'))
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return path
    raise StoreError('state_in_use')


def _release_state_lock(path):
    if path is None:
        return
    try:
        path.unlink()
    except OSError:
        pass


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
        self._state_lock_path = _acquire_state_lock(self.store.state_dir)
        configured = False
        try:
            self.evidence_store = configure_store()
            configured = True
            self.recovered = self.store.mark_recovered(_failure('runtime_restarted'))
            if config.job_retention_seconds:
                try:
                    self.store.prune_jobs(retention_seconds=config.job_retention_seconds)
                except StoreError:
                    pass
            self._executor = ThreadPoolExecutor(max_workers=config.max_concurrency,
                                                thread_name_prefix='falsify-hosted')
        except BaseException:
            _release_state_lock(self._state_lock_path)
            self._state_lock_path = None
            if configured:
                release_store()
            raise

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
            'requiredCalls': 0 if validated['applyOnly'] else validated['maxCalls'],
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
                apply_only=validated['applyOnly'],
                use_evidence=validated['useEvidence'],
                upload_id=upload['id'],
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
            visual_edits=tuple(validated['visualEdits'] or ()),
            attack_types=tuple(validated['attackTypes']) if validated['attackTypes'] is not None else None,
            level=validated['level'],
            apply_only=validated['applyOnly'],
            use_evidence=validated['useEvidence'],
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
            'applyOnly': job.get('applyOnly', False),
            'useEvidence': job.get('useEvidence', True),
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
                'requiredCalls': 0 if request.apply_only else request.max_calls,
                'phase': 'applying' if request.apply_only else 'running',
            })
            upload, raw = self.store.read_upload_bytes(request.owner_id, request.upload_id)
            if upload['mime'] == 'text/plain':
                raise ServiceError('unsupported_media_type', 415)
            if request.cancelled.is_set():
                self._finish_cancelled(request)
                return
            if request.apply_only:
                self._execute_apply(request, upload, raw)
                return
            extraction = extract_pdf(raw)
            self.store.add_artifact(request.owner_id, request.job_id, 'extracted.json',
                                    'application/json',
                                    _json_bytes(_extraction_document(upload, extraction)))
            if request.cancelled.is_set():
                self._finish_cancelled(request)
                return
            evidence = self._prepare_evidence(request, upload, raw)
            if request.cancelled.is_set():
                self._finish_cancelled(request)
                return
            evidence_handle_value = None
            if evidence is not None:
                counts = evidence.get('counts') if isinstance(evidence.get('counts'), dict) else {}
                if (int(counts.get('tables', 0) or 0) + int(counts.get('figures', 0) or 0)) > 0:
                    evidence_handle_value = evidence_handle(evidence)
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
                paper_evidence=evidence_handle_value,
                file_hash=upload['sha256'] if evidence_handle_value is not None else None,
            )
            result = self._run_engine(envelope, request)
            if request.cancelled.is_set():
                self._finish_cancelled(request, usage=_usage(result),
                                       provider_request_id=_provider_request_id(result))
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
                except EvidenceError as error:
                    self._fail(request, error.code, result=result, usage=usage,
                               provider_request_id=provider_request_id)
                    return
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
        except EvidenceError as error:
            self._fail(request, error.code)
        except ServiceError as error:
            self._fail(request, error.code)
        except StoreError:
            self._fail(request, 'input_unavailable')
        except Exception as error:
            if request.cancelled.is_set() or type(error).__name__ == 'ReviewCancelled':
                self._finish_cancelled(request, usage=getattr(error, 'usage', None),
                                       provider_request_id=getattr(error, 'request_id', None))
            else:
                self._fail(request, _classify_engine_error(error))
        finally:
            with self._lock:
                self._events.pop(request.job_id, None)

    def _prepare_evidence(self, request, upload, raw):
        """Prepare and record evidence when requested, or when visual apply needs it."""
        required = request.use_evidence or (request.apply_only and bool(request.visual_edits))
        if not required:
            return None
        summary = prepare_evidence(self.evidence_store, raw, upload['sha256'],
                                   cancelled=request.cancelled)
        self.store.add_artifact(request.owner_id, request.job_id, 'evidence.json',
                                'application/json',
                                _json_bytes(evidence_artifact(self.evidence_store, summary)))
        if request.cancelled.is_set():
            self._finish_cancelled(request)
            return None
        return summary

    def _execute_apply(self, request, upload, raw):
        """Apply only selected edits; no model call, no invented usage."""
        evidence = self._prepare_evidence(request, upload, raw)
        if request.cancelled.is_set():
            self._finish_cancelled(request)
            return
        output, apply_summary = apply_evidence_edits(
            self.evidence_store, evidence, list(request.visual_edits),
            list(request.edits), raw, upload['sha256'],
            cancelled=request.cancelled)
        if request.cancelled.is_set():
            self._finish_cancelled(request)
            return
        self.store.add_artifact(request.owner_id, request.job_id, 'edited.pdf',
                                'application/pdf', output)
        self.store.add_artifact(request.owner_id, request.job_id, 'apply.json',
                                'application/json', _json_bytes(apply_summary))
        ok = self.store.transition(
            request.owner_id, request.job_id, ('running',), 'completed',
            result=apply_summary, usage=None, provider_request_id=None, completed=True)
        if not ok:
            self._finish_cancelled(request)

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
            self._finish_cancelled(request, usage=usage,
                                   provider_request_id=provider_request_id)
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

    def _finish_cancelled(self, request, *, usage=None, provider_request_id=None):
        kwargs = {'completed': True}
        if usage is not None:
            normalized = _usage({'usage': usage})
            if normalized is not None:
                kwargs['usage'] = normalized
        if provider_request_id is not None:
            kwargs['provider_request_id'] = provider_request_id
        try:
            self.store.transition(request.owner_id, request.job_id,
                                  ('queued', 'running', 'cancelling'), 'cancelled',
                                  **kwargs)
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
        owner = _job_owner(body, owner_id, self._check_owner)
        job_id, idempotency, request_hash = _job_ids(body)
        role, apply_only, use_evidence = _job_flags(body)
        prompt = _job_prompt(body, apply_only)
        upload_id = _job_upload_id(body)
        model, effort = _job_model(self.config, body)
        max_calls = _job_budget(body, apply_only, self.config.max_calls)
        _job_harness(body)
        edits, visual_edits = _job_edits(body, role, apply_only)
        attack_types, level = _job_attack(body)
        return {
            'owner_id': owner,
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
            'visualEdits': visual_edits,
            'attackTypes': attack_types,
            'level': level,
            'applyOnly': apply_only,
            'useEvidence': use_evidence,
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
            if not getattr(self, '_store_released', False):
                self._store_released = True
                release_store()
            lock_path = getattr(self, '_state_lock_path', None)
            self._state_lock_path = None
        _release_state_lock(lock_path)

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
