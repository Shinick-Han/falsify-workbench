"""Offline tests for the hosted runtime (durable jobs, PDF intake, HTTP seam)."""

import hashlib
import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

import pymupdf

from hosted_runtime import (ConfigError, PdfInputError, RuntimeConfig, RuntimeService,
                            ServiceError, Store, StoreNotFound, build_review_envelope,
                            create_server, extract_pdf)
from hosted_runtime.config import DEFAULT_MODELS, provider_for_model
from hosted_runtime.service import build_harness

OWNER = 'usr:11111111-1111-1111-1111-111111111111'
OTHER = 'usr:22222222-2222-2222-2222-222222222222'
TOKEN = 'test-service-token-0123456789'
MODEL = 'claude-opus-5-5'
TERMINAL = {'cancelled', 'completed', 'failed', 'interrupted'}


def synthetic_pdf(pages):
    document = pymupdf.open()
    try:
        for blocks in pages:
            page = document.new_page()
            y = 72
            for text in blocks:
                page.insert_text((72, y), text, fontsize=11)
                y += 280
        return document.tobytes()
    finally:
        document.close()


def wait_for(predicate, timeout=8.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.01)
    raise AssertionError('condition was not reached before the timeout')


def wait_state(service, owner, job_id, states=TERMINAL, timeout=8.0):
    def current():
        snapshot = service.get_job(owner, job_id)
        return snapshot if snapshot['state'] in states else None
    return wait_for(current, timeout=timeout)


class FakeRunner:
    """Deterministic offline engine.  Records envelopes and can block one worker."""

    def __init__(self, result_factory=None, block=False):
        self.calls = []
        self.started = threading.Event()
        self.release = threading.Event()
        if not block:
            self.release.set()
        self.result_factory = result_factory

    def __call__(self, data, progress, cancelled):
        self.calls.append(data)
        progress({'completedCalls': 0, 'requiredCalls': data['maxCalls'],
                  'phase': 'analyzing'})
        self.started.set()
        self.release.wait(10)
        if cancelled.is_set():
            raise RuntimeError('cancelled')
        progress({'completedCalls': 1, 'requiredCalls': data['maxCalls'],
                  'phase': 'analyzing'})
        if self.result_factory is not None:
            return self.result_factory(data)
        result = {
            'schema': data['schema'],
            'revision': data['revision'],
            'sourceHash': data['sourceHash'],
            'status': 'ok',
            'usage': {'input_tokens': 11, 'output_tokens': 7,
                      'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 2},
            'provider': {'id': 'anthropic-api', 'models': [MODEL],
                         'requestId': 'req_provider_123'},
        }
        if data['schema'].endswith('red.v1'):
            result['candidates'] = []
        else:
            result['findings'] = []
        return result


class RuntimeConfigTests(unittest.TestCase):
    def test_prompt_cap_default_and_env(self):
        with tempfile.TemporaryDirectory() as directory:
            config = RuntimeConfig(state_dir=Path(directory), service_token=TOKEN)
            self.assertEqual(config.max_prompt_chars, 32000)
            configured = RuntimeConfig.from_env({
                'HOSTED_AI_STATE_DIR': directory,
                'HOSTED_AI_SERVICE_TOKEN': TOKEN,
                'HOSTED_AI_MAX_PROMPT_CHARS': '45000',
            })
            self.assertEqual(configured.max_prompt_chars, 45000)
            self.assertEqual(configured.models, DEFAULT_MODELS)
            self.assertEqual(configured.provider, 'anthropic')
            self.assertEqual(configured.public_health(True)['providers'], ['anthropic'])

    def test_mixed_allowlist_rejects_unknown_ids(self):
        self.assertEqual(DEFAULT_MODELS, ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'))
        self.assertEqual(provider_for_model('claude-haiku-5-5'), 'anthropic')
        self.assertEqual(provider_for_model('gpt-5'), 'openai')
        self.assertEqual(provider_for_model('o3-mini'), 'openai')
        for model in ('opus', 'o', 'gpt', 'GPT-5', 'claude', ''):
            self.assertIsNone(provider_for_model(model))
        with tempfile.TemporaryDirectory() as directory:
            mixed = RuntimeConfig(
                state_dir=Path(directory), service_token=TOKEN,
                models=('claude-opus-5-5', 'gpt-5', 'o3'), default_model='claude-opus-5-5')
            self.assertEqual(mixed.provider, 'anthropic')
            self.assertEqual(mixed.public_health(True)['providers'], ['anthropic', 'openai'])
            openai_first = RuntimeConfig.from_env({
                'HOSTED_AI_STATE_DIR': directory,
                'HOSTED_AI_SERVICE_TOKEN': TOKEN,
                'HOSTED_AI_MODELS': 'gpt-5,claude-opus-5-5',
            })
            self.assertEqual(openai_first.models, ('gpt-5', 'claude-opus-5-5'))
            self.assertEqual(openai_first.provider, 'openai')
            self.assertEqual(openai_first.public_health(False)['provider'], 'openai')
            for models in (('claude-opus-5-5', 'llama-3'), ('gpt',), ('o',)):
                with self.assertRaises(ConfigError):
                    RuntimeConfig(state_dir=Path(directory), service_token=TOKEN,
                                  models=models, default_model=models[0])

    def test_prompt_cap_range(self):
        with tempfile.TemporaryDirectory() as directory:
            for value in (999, 200001):
                with self.assertRaises(ConfigError):
                    RuntimeConfig(state_dir=Path(directory), service_token=TOKEN,
                                  max_prompt_chars=value)


class BaseRuntimeTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.state_dir = Path(self._tmp.name)

    def config(self, **overrides):
        values = {
            'state_dir': self.state_dir,
            'service_token': TOKEN,
            'models': (MODEL,),
            'default_model': MODEL,
            'max_concurrency': 2,
            'max_calls': 12,
            'max_upload_bytes': 20000,
            'job_retention_seconds': 0,
            'bind_host': '127.0.0.1',
            'bind_port': 0,
        }
        values.update(overrides)
        return RuntimeConfig(**values)

    def service(self, runner, **overrides):
        service = RuntimeService(self.config(**overrides), review_runner=runner)
        self.addCleanup(service.close)
        return service

    def upload(self, service, data=None, owner=OWNER, mime='application/pdf',
               name='paper.pdf'):
        payload = synthetic_pdf([['The trial reported 12 events in total.']]) \
            if data is None else data
        upload, _ = service.create_upload(owner, name, mime, payload)
        return upload

    @staticmethod
    def body(upload, *, job_id='job-00000001', owner=OWNER, role='red',
             prompt='Review this paper for internal contradictions.',
             model=MODEL, effort='high', key='idem-key-0001', request_hash='hash-0001',
             budget=None, edits=None, **extra):
        value = {
            'jobId': job_id,
            'ownerId': owner,
            'idempotencyKey': key,
            'requestHash': request_hash,
            'role': role,
            'prompt': prompt,
            'uploadId': upload['id'],
            'model': model,
            'effort': effort,
        }
        if budget is not None:
            value['budget'] = budget
        if edits is not None:
            value['edits'] = edits
        value.update(extra)
        return value


class DurableJobTests(BaseRuntimeTest):
    def test_completed_job_snapshot_and_artifacts(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        snapshot, replayed = service.submit_job(self.body(upload))
        self.assertFalse(replayed)
        self.assertIn(snapshot['state'], {'queued', 'running', 'completed'})
        done = wait_state(service, OWNER, snapshot['id'])
        self.assertEqual(done['state'], 'completed')
        self.assertEqual(done['model'], MODEL)
        self.assertEqual(done['effort'], 'high')
        self.assertEqual(done['provider'], 'anthropic')
        self.assertEqual(done['usage'], {'inputTokens': 11, 'outputTokens': 7,
                                         'cacheReadInputTokens': 0,
                                         'cacheCreationInputTokens': 2})
        self.assertEqual(done['result']['usage'],
                         {'input_tokens': 11, 'output_tokens': 7,
                          'cache_read_input_tokens': 0,
                          'cache_creation_input_tokens': 2})
        stored = service.store.get_job(OWNER, done['id'])
        self.assertEqual(stored['providerRequestId'], 'req_provider_123')
        self.assertEqual(done['providerRequestId'], 'req_provider_123')
        self.assertNotIn('failure', done)
        self.assertIn('completedAt', done)
        names = [artifact['name'] for artifact in done['artifacts']]
        self.assertEqual(names, ['extracted.json', 'evidence.json', 'review.json'])
        review = next(a for a in done['artifacts'] if a['name'] == 'review.json')
        meta, data = service.get_artifact(OWNER, done['id'], review['id'])
        self.assertEqual(meta, review)
        self.assertEqual(hashlib.sha256(data).hexdigest(), review['sha256'])
        self.assertEqual(json.loads(data), done['result'])
        self.assertEqual(done['result']['sourceHash'], runner.calls[0]['sourceHash'])
        self.assertEqual(len(runner.calls), 1)

        extracted = next(a for a in done['artifacts'] if a['name'] == 'extracted.json')
        _, extracted_bytes = service.get_artifact(OWNER, done['id'], extracted['id'])
        document = json.loads(extracted_bytes)
        self.assertEqual(document['revision'], upload['sha256'])
        self.assertTrue(document['segments'])
        self.assertTrue(document['coverage']['complete'])

        cancelled = service.cancel_job(OWNER, done['id'])
        self.assertEqual(cancelled['state'], 'completed')

    def test_long_prompt_uses_runtime_cap_not_legacy_8000(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        snapshot, _ = service.submit_job(self.body(
            upload, job_id='job-long-prompt', key='idem-long-prompt',
            request_hash='hash-long-prompt', prompt='x' * 9000))
        done = wait_state(service, OWNER, snapshot['id'], {'completed'})
        self.assertEqual(done['state'], 'completed')
        self.assertEqual(len(runner.calls[0]['harness']['instructions']), 9000)

    def test_duplicate_submit_runs_runner_once(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        first, replayed = service.submit_job(self.body(upload))
        self.assertFalse(replayed)
        second, replayed = service.submit_job(
            self.body(upload, job_id='job-00000002', key='idem-key-0001',
                      request_hash='hash-0001'))
        self.assertTrue(replayed)
        self.assertEqual(second['id'], first['id'])
        wait_state(service, OWNER, first['id'])
        self.assertEqual(len(runner.calls), 1)
        with self.assertRaises(ServiceError) as conflict:
            service.submit_job(self.body(upload, job_id='job-00000003',
                                         key='idem-key-0001',
                                         request_hash='hash-different'))
        self.assertEqual(conflict.exception.code, 'idempotency_conflict')
        self.assertEqual(conflict.exception.status, 409)

    def test_completed_job_persists_across_restart(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        snapshot, _ = service.submit_job(self.body(upload))
        done = wait_state(service, OWNER, snapshot['id'], {'completed'})
        service.close()
        second_runner = FakeRunner()
        restarted = RuntimeService(self.config(), review_runner=second_runner)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.recovered, 0)
        persisted = restarted.get_job(OWNER, snapshot['id'])
        self.assertEqual(persisted['state'], 'completed')
        self.assertEqual(persisted['result'], done['result'])
        self.assertEqual(persisted['usage'], done['usage'])
        self.assertEqual(persisted['artifacts'], done['artifacts'])
        self.assertEqual(second_runner.calls, [])

    def test_cancel_before_worker_start_does_not_call_engine(self):
        runner = FakeRunner(block=True)
        service = self.service(runner, max_concurrency=1)
        upload = self.upload(service)
        first, _ = service.submit_job(self.body(upload, job_id='job-00000011',
                                                prompt='FIRST job prompt.',
                                                key='idem-first-01'))
        self.assertTrue(runner.started.wait(5))
        second, _ = service.submit_job(self.body(upload, job_id='job-00000012',
                                                 prompt='SECOND job prompt.',
                                                 key='idem-second-1'))
        wait_for(lambda: service.get_job(OWNER, second['id'])['state'] == 'queued')
        cancelled = service.cancel_job(OWNER, second['id'])
        self.assertEqual(cancelled['state'], 'cancelling')
        runner.release.set()
        wait_state(service, OWNER, first['id'], {'completed'})
        wait_state(service, OWNER, second['id'], {'cancelled'})
        self.assertEqual([call['harness']['instructions'] for call in runner.calls],
                         ['FIRST job prompt.'])

    def test_cancel_during_blocked_run_discards_result(self):
        runner = FakeRunner(block=True)
        service = self.service(runner)
        upload = self.upload(service)
        snapshot, _ = service.submit_job(self.body(upload))
        self.assertTrue(runner.started.wait(5))
        running = service.get_job(OWNER, snapshot['id'])
        self.assertEqual(running['state'], 'running')
        self.assertEqual(running['progress']['phase'], 'analyzing')
        cancel = service.cancel_job(OWNER, snapshot['id'])
        self.assertEqual(cancel['state'], 'cancelling')
        runner.release.set()
        done = wait_state(service, OWNER, snapshot['id'], {'cancelled'})
        self.assertNotIn('result', done)
        self.assertNotIn('review.json', [a['name'] for a in done['artifacts']])
        self.assertEqual(len(runner.calls), 1)
        self.assertEqual(done['progress']['phase'], 'cancelled')

    def test_restart_recovery_marks_interrupted_without_replay(self):
        store = Store(self.state_dir)
        for number, state in ((1, 'queued'), (2, 'running'), (3, 'cancelling')):
            job_id = 'job-recover-%04d' % number
            store.create_job(
                owner_id=OWNER,
                job_id=job_id,
                idempotency_key='idem-recover-%04d' % number,
                request_hash='hash-recover-%04d' % number,
                role='red', model=MODEL, effort='high', provider='anthropic',
                progress={'completedCalls': 0, 'requiredCalls': 12, 'phase': 'queued'})
            if state != 'queued':
                store.transition(OWNER, job_id, ('queued',), state)
        runner = FakeRunner()
        service = RuntimeService(self.config(), store=store, review_runner=runner)
        self.addCleanup(service.close)
        self.assertEqual(service.recovered, 3)
        for number in (1, 2, 3):
            job = service.get_job(OWNER, 'job-recover-%04d' % number)
            self.assertEqual(job['state'], 'interrupted')
            self.assertEqual(job['failure']['code'], 'runtime_restarted')
            self.assertFalse(job['failure']['retryable'])
        self.assertEqual(runner.calls, [])
        self.assertEqual(service.submit_job(self.body(
            self.upload(service), job_id='job-after-restart', key='idem-after-01'))[1],
            False)

    def test_owner_isolation_for_upload_job_cancel_and_artifact(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        with self.assertRaises(ServiceError) as foreign_upload:
            service.submit_job(self.body(upload, owner=OTHER, job_id='job-foreign-01',
                                         key='idem-foreign-1'))
        self.assertEqual(foreign_upload.exception.code, 'not_found')
        with self.assertRaises(StoreNotFound):
            service.store.get_upload(OTHER, upload['id'])

        snapshot, _ = service.submit_job(self.body(upload))
        done = wait_state(service, OWNER, snapshot['id'])
        artifact = done['artifacts'][0]
        for call in (
            lambda: service.get_job(OTHER, snapshot['id']),
            lambda: service.cancel_job(OTHER, snapshot['id']),
            lambda: service.get_artifact(OTHER, snapshot['id'], artifact['id']),
        ):
            with self.assertRaises(ServiceError) as error:
                call()
            self.assertEqual(error.exception.code, 'not_found')
            self.assertEqual(error.exception.status, 404)

    def test_engine_failure_is_reported_without_completion(self):
        runner = FakeRunner(result_factory=lambda data: None)
        service = self.service(runner)
        snapshot, _ = service.submit_job(self.body(self.upload(service)))
        done = wait_state(service, OWNER, snapshot['id'], {'failed', 'completed'})
        self.assertEqual(done['state'], 'failed')
        self.assertEqual(done['failure']['code'], 'invalid_output')
        self.assertNotIn('result', done)
        self.assertFalse(any(a['name'] == 'review.json' for a in done['artifacts']))
        self.assertEqual(done['progress']['phase'], 'failed')

    def test_usage_and_request_id_only_copy_returned_values(self):
        def factory(data):
            return {
                'schema': data['schema'],
                'revision': data['revision'],
                'sourceHash': data['sourceHash'],
                'status': 'ok',
                'candidates': [],
                'usage': {'input_tokens': 5},
            }
        runner = FakeRunner(result_factory=factory)
        service = self.service(runner)
        snapshot, _ = service.submit_job(self.body(self.upload(service)))
        done = wait_state(service, OWNER, snapshot['id'], {'completed'})
        self.assertEqual(done['usage'], {'inputTokens': 5})
        stored = service.store.get_job(OWNER, done['id'])
        self.assertIsNone(stored['providerRequestId'])
        self.assertNotIn('failure', done)

    def test_missing_provider_usage_omits_usage_instead_of_zeros(self):
        def factory(data):
            return {
                'schema': data['schema'],
                'revision': data['revision'],
                'sourceHash': data['sourceHash'],
                'status': 'ok',
                'candidates': [],
            }
        runner = FakeRunner(result_factory=factory)
        service = self.service(runner)
        snapshot, _ = service.submit_job(self.body(self.upload(service)))
        done = wait_state(service, OWNER, snapshot['id'], {'completed'})
        self.assertNotIn('usage', done)
        self.assertNotIn('providerRequestId', done)
        stored = service.store.get_job(OWNER, done['id'])
        self.assertIsNone(stored['usage'])
        self.assertIsNone(stored['providerRequestId'])

    def test_progress_is_persisted_while_engine_runs(self):
        runner = FakeRunner(block=True)
        service = self.service(runner)
        snapshot, _ = service.submit_job(self.body(self.upload(service)))
        self.assertTrue(runner.started.wait(5))
        progress = service.get_job(OWNER, snapshot['id'])['progress']
        self.assertEqual(progress, {'completedCalls': 0, 'requiredCalls': 12,
                                    'phase': 'analyzing'})
        runner.release.set()
        wait_state(service, OWNER, snapshot['id'], {'completed'})


class PdfIntakeTests(BaseRuntimeTest):
    def test_extraction_segments_hash_and_reading_order(self):
        data = synthetic_pdf([['First block alpha.', 'Second block beta.'],
                              ['Third block gamma.']])
        extraction = extract_pdf(data)
        self.assertEqual([s['id'] for s in extraction['segments']],
                         ['p1-b1', 'p1-b2', 'p2-b1'])
        self.assertEqual([s['label'] for s in extraction['segments']],
                         ['page 1', 'page 1', 'page 2'])
        self.assertEqual(extraction['segments'][0]['text'], 'First block alpha.')
        joined = '\n\n'.join(s['text'] for s in extraction['segments'])
        self.assertEqual(extraction['sourceHash'],
                         hashlib.sha256(joined.encode('utf-8')).hexdigest())
        self.assertEqual(extraction['pageCount'], 2)
        self.assertEqual(extraction['blockCount'], 3)

    def test_unmapped_glyph_preserves_offsets_and_segment_hash(self):
        blocks = [(0, 0, 1, 1, text, i, 0) for i, text in enumerate(['x\0y', '\0', 'tail'])]
        with patch.object(pymupdf.Page, 'get_text', return_value=blocks):
            result = extract_pdf(synthetic_pdf([['placeholder']]))
        self.assertEqual([(s['id'], s['text']) for s in result['segments']],
                         [('p1-b1', 'x\ufffdy'), ('p1-b2', '\ufffd'), ('p1-b3', 'tail')])
        expected = 'x\ufffdy\n\n\ufffd\n\ntail'
        self.assertEqual(result['sourceHash'], hashlib.sha256(expected.encode()).hexdigest())
        self.assertEqual(result['characters'], len(expected))

    def test_empty_pdf_is_rejected(self):
        document = pymupdf.open()
        document.new_page()
        data = document.tobytes()
        document.close()
        with self.assertRaises(PdfInputError) as error:
            extract_pdf(data)
        self.assertEqual(error.exception.code, 'pdf_empty_text')

    def test_encrypted_pdf_is_rejected(self):
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((72, 72), 'secret text', fontsize=11)
        data = document.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256,
                                owner_pw='owner', user_pw='user')
        document.close()
        with self.assertRaises(PdfInputError) as error:
            extract_pdf(data)
        self.assertEqual(error.exception.code, 'pdf_encrypted')

    def test_corrupt_and_oversized_extraction_are_rejected(self):
        with self.assertRaises(PdfInputError) as corrupt:
            extract_pdf(b'not a pdf')
        self.assertEqual(corrupt.exception.code, 'pdf_corrupt')
        data = synthetic_pdf([['A reasonably long line of text.']])
        with self.assertRaises(PdfInputError) as oversized:
            extract_pdf(data, max_chars=10)
        self.assertEqual(oversized.exception.code, 'pdf_too_large')

    def test_non_pdf_job_fails_with_fixed_code(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload, _ = service.create_upload(OWNER, 'notes.txt', 'text/plain',
                                          b'plain text is not a PDF')
        snapshot, _ = service.submit_job(self.body(upload, role='blue',
                                                   job_id='job-text-0001',
                                                   key='idem-text-01'))
        done = wait_state(service, OWNER, snapshot['id'], {'failed'})
        self.assertEqual(done['failure']['code'], 'unsupported_media_type')
        self.assertEqual(runner.calls, [])


class UploadTests(BaseRuntimeTest):
    def test_empty_oversized_and_unsupported_uploads_are_rejected(self):
        service = self.service(FakeRunner(), max_upload_bytes=64)
        with self.assertRaises(ServiceError) as empty:
            service.create_upload(OWNER, 'a.pdf', 'application/pdf', b'')
        self.assertEqual((empty.exception.code, empty.exception.status),
                         ('upload_empty', 400))
        with self.assertRaises(ServiceError) as large:
            service.create_upload(OWNER, 'a.pdf', 'application/pdf', b'x' * 65)
        self.assertEqual((large.exception.code, large.exception.status),
                         ('payload_too_large', 413))
        with self.assertRaises(ServiceError) as mime:
            service.create_upload(OWNER, 'a.exe', 'application/x-msdownload', b'x')
        self.assertEqual((mime.exception.code, mime.exception.status),
                         ('unsupported_media_type', 415))

    def test_content_addressed_dedup_is_per_owner(self):
        service = self.service(FakeRunner())
        data = synthetic_pdf([['Deduplicated content.']])
        first, created = service.create_upload(OWNER, 'one.pdf', 'application/pdf', data)
        self.assertTrue(created)
        self.assertFalse(first['deduplicated'])
        second, created = service.create_upload(OWNER, 'two.pdf', 'application/pdf', data)
        self.assertFalse(created)
        self.assertTrue(second['deduplicated'])
        self.assertEqual(first['id'], second['id'])
        third, created = service.create_upload(OTHER, 'one.pdf', 'application/pdf', data)
        self.assertTrue(created)
        self.assertNotEqual(first['id'], third['id'])
        self.assertEqual(first['sha256'], third['sha256'])


class EnvelopeTests(unittest.TestCase):
    def test_hosted_red_and_blue_envelopes(self):
        segments = [{'id': 'p1-b1', 'label': 'page 1', 'text': 'Exact text.'}]
        red = build_review_envelope(
            'red', revision='a' * 64, request_id='job-00000001',
            source_hash='b' * 64, segments=segments, prompt='Review.', model=MODEL,
            effort='high', max_calls=12)
        self.assertEqual(red['schema'], 'falsify.document-red.v1')
        self.assertTrue(red['consent'])
        self.assertEqual(red['level'], 4)
        self.assertEqual(red['maxCalls'], 12)
        self.assertEqual(red['requestId'], 'job-00000001')
        self.assertEqual(red['sourceHash'], 'b' * 64)
        self.assertEqual(red['segments'], segments)
        self.assertEqual(red['harness'], build_harness('red', 'Review.', 12, MODEL, 'high'))
        self.assertEqual((red['harness']['id'], red['harness']['name']),
                         ('hosted-anthropic', 'Hosted Anthropic'))
        openai = build_harness('red', 'Review.', 4, 'gpt-5', 'medium')
        self.assertEqual((openai['id'], openai['name'], openai['adapter']['model']),
                         ('hosted-openai', 'Hosted OpenAI', 'gpt-5'))
        self.assertEqual(red['harness']['adapter'],
                         {'type': 'hosted', 'model': MODEL, 'effort': 'high'})
        self.assertEqual(set(red['harness']),
                         {'schema', 'id', 'name', 'version', 'role', 'instructions',
                          'maxCalls', 'adapter'})

        attack = build_review_envelope(
            'red', revision='a' * 64, request_id='job-00000002',
            source_hash='b' * 64, segments=segments, prompt='Review.', model=MODEL,
            effort='high', max_calls=12, attack_types=['contradiction'])
        self.assertEqual(attack['attackTypes'], ['contradiction'])
        self.assertNotIn('level', attack)

        blue = build_review_envelope(
            'blue', revision='a' * 64, request_id='job-00000003',
            source_hash='b' * 64, segments=segments, prompt='Review.', model=MODEL,
            effort='high', max_calls=6)
        self.assertEqual(blue['schema'], 'falsify.document-blue.v1')
        self.assertTrue(blue['consent'])
        self.assertEqual(blue['maxCalls'], 6)
        self.assertEqual(blue['harness']['role'], 'blue')
        for envelope in (red, blue):
            self.assertNotIn('url', json.dumps(envelope))
            self.assertNotIn('executable', json.dumps(envelope))
            self.assertNotIn('apiKey', json.dumps(envelope))


class EditTests(BaseRuntimeTest):
    def test_valid_edit_adds_edited_pdf_only_when_requested(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service, data=synthetic_pdf(
            [['The trial was positive.']]))
        snapshot, _ = service.submit_job(self.body(
            upload, job_id='job-edit-0001', key='idem-edit-01',
            edits=[{'pageIndex': 0, 'before': 'was',
                    'after': 'is'}]))
        done = wait_state(service, OWNER, snapshot['id'], {'completed', 'failed'})
        self.assertEqual(done['state'], 'completed')
        names = [artifact['name'] for artifact in done['artifacts']]
        self.assertIn('review.json', names)
        self.assertIn('edited.pdf', names)
        edited = next(a for a in done['artifacts'] if a['name'] == 'edited.pdf')
        _, data = service.get_artifact(OWNER, done['id'], edited['id'])
        self.assertTrue(data.startswith(b'%PDF-'))
        self.assertEqual(hashlib.sha256(data).hexdigest(), edited['sha256'])

    def test_invalid_edit_preserves_review_json_and_fails(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service, data=synthetic_pdf(
            [['The trial reported 12 events in total.']]))
        snapshot, _ = service.submit_job(self.body(
            upload, edits=[{'pageIndex': 0, 'before': 'text that is absent',
                            'after': 'replacement'}]))
        done = wait_state(service, OWNER, snapshot['id'], {'failed'})
        self.assertEqual(done['failure']['code'], 'edit_invalid')
        self.assertEqual(done['failure']['requestId'], 'req_provider_123')
        self.assertFalse(done['failure']['retryable'])
        names = [artifact['name'] for artifact in done['artifacts']]
        self.assertIn('review.json', names)
        self.assertIn('extracted.json', names)
        self.assertNotIn('edited.pdf', names)
        review = next(a for a in done['artifacts'] if a['name'] == 'review.json')
        _, data = service.get_artifact(OWNER, done['id'], review['id'])
        self.assertEqual(json.loads(data), done['result'])


class HttpTests(BaseRuntimeTest):
    def _serve(self, service):
        server = create_server(service, '127.0.0.1', 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server, server.server_address[1]

    def _request(self, port, method, path, *, token=TOKEN, owner=OWNER, body=None,
                 headers=None, content_type=None):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=8)
        request_headers = dict(headers or {})
        if token is not None:
            request_headers['X-Falsify-Service-Token'] = token
        if owner is not None:
            request_headers['X-Falsify-Owner-Id'] = owner
        if content_type is not None:
            request_headers['Content-Type'] = content_type
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            data = response.read()
            return response.status, dict(response.getheaders()), data
        finally:
            connection.close()

    def test_service_token_owner_and_fixed_errors(self):
        service = self.service(FakeRunner())
        server, port = self._serve(service)
        status, _, data = self._request(port, 'GET', '/internal/v1/health', token=None)
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(data)['error']['code'], 'unauthorized')
        status, _, _ = self._request(port, 'GET', '/internal/v1/health', token='wrong')
        self.assertEqual(status, 401)
        status, _, _ = self._request(port, 'GET', '/internal/v1/health', owner=None)
        self.assertEqual(status, 401)
        status, _, data = self._request(port, 'GET', '/internal/v1/health')
        self.assertEqual(status, 200)
        health = json.loads(data)
        self.assertEqual(health, {'ok': True, 'provider': 'anthropic',
                                  'providers': ['anthropic'],
                                  'models': [MODEL], 'version': health['version'],
                                  'ready': True})
        status, _, _ = self._request(port, 'HEAD', '/internal/v1/health')
        self.assertEqual(status, 405)
        status, _, _ = self._request(port, 'PUT', '/internal/v1/health', body=b'')
        self.assertEqual(status, 405)
        status, _, data = self._request(port, 'GET', '/internal/v1/unknown')
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(data)['error']['code'], 'not_found')

    def test_upload_job_artifact_and_owner_isolation(self):
        runner = FakeRunner()
        service = self.service(runner)
        server, port = self._serve(service)
        pdf = synthetic_pdf([['The hosted report states 4 outcomes.']])
        path = '/internal/v1/uploads?name=%s&mime=application/pdf' % quote('paper.pdf')
        status, _, data = self._request(port, 'POST', path, body=pdf)
        self.assertEqual(status, 201)
        upload = json.loads(data)['upload']
        self.assertFalse(upload['deduplicated'])
        status, _, data = self._request(port, 'POST', path, body=pdf)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(data)['upload']['deduplicated'])
        self.assertEqual(json.loads(data)['upload']['id'], upload['id'])

        status, _, data = self._request(
            port, 'POST', '/internal/v1/uploads?name=x.pdf&mime=application/pdf',
            body=b'')
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(data)['error']['code'], 'upload_empty')

        body = self.body(upload)
        status, _, data = self._request(
            port, 'POST', '/internal/v1/jobs', body=json.dumps(body).encode(),
            content_type='application/json')
        self.assertEqual(status, 202)
        snapshot = json.loads(data)
        done = wait_state(service, OWNER, snapshot['id'])
        self.assertEqual(done['state'], 'completed')

        status, _, data = self._request(
            port, 'GET', '/internal/v1/jobs/%s' % snapshot['id'])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)['state'], 'completed')
        self.assertEqual(json.loads(data)['usage']['inputTokens'], 11)
        self.assertEqual(json.loads(data)['providerRequestId'], 'req_provider_123')
        status, _, _ = self._request(port, 'GET', '/internal/v1/jobs/%s' % snapshot['id'],
                                     owner=OTHER)
        self.assertEqual(status, 404)
        status, _, data = self._request(
            port, 'GET', '/internal/v1/jobs/does-not-exist')
        self.assertEqual(status, 404)

        artifact = done['artifacts'][0]
        status, headers, raw = self._request(
            port, 'GET', '/internal/v1/jobs/%s/artifacts/%s'
            % (snapshot['id'], artifact['id']))
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], artifact['mime'])
        self.assertIn('attachment; filename=', headers['Content-Disposition'])
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(hashlib.sha256(raw).hexdigest(), artifact['sha256'])

        status, _, data = self._request(
            port, 'POST', '/internal/v1/jobs/%s/cancel' % snapshot['id'], body=b'')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)['state'], 'completed')

        marker = 'PRIVATE-PROMPT-MARKER'
        status, _, data = self._request(
            port, 'POST', '/internal/v1/jobs',
            body=json.dumps(self.body(upload, job_id='job-bad-prompt',
                                      key='idem-bad-0001',
                                      prompt=marker + 'x' * 33000)).encode(),
            content_type='application/json')
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(data)['error']['code'], 'invalid_request')
        self.assertNotIn(marker.encode(), data)
        self.assertNotIn(TOKEN.encode(), data)

    def test_cancel_without_content_length_is_accepted(self):
        runner = FakeRunner()
        service = self.service(runner)
        server, port = self._serve(service)
        pdf = synthetic_pdf([['A short synthetic document.']])
        upload_path = '/internal/v1/uploads?name=%s&mime=application/pdf' % quote('a.pdf')
        _, _, data = self._request(port, 'POST', upload_path, body=pdf)
        upload = json.loads(data)['upload']
        _, _, data = self._request(
            port, 'POST', '/internal/v1/jobs',
            body=json.dumps(self.body(upload)).encode(),
            content_type='application/json')
        snapshot = json.loads(data)
        wait_state(service, OWNER, snapshot['id'], {'completed'})
        payload = (
            'POST /internal/v1/jobs/%s/cancel HTTP/1.1\r\n'
            'Host: 127.0.0.1:%d\r\n'
            'X-Falsify-Service-Token: %s\r\n'
            'X-Falsify-Owner-Id: %s\r\n'
            'Content-Type: application/json\r\n'
            'Connection: close\r\n\r\n' % (snapshot['id'], port, TOKEN, OWNER)
        ).encode()
        with socket.create_connection(('127.0.0.1', port), timeout=8) as connection:
            connection.sendall(payload)
            chunks = []
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        response = b''.join(chunks)
        head, _, body = response.partition(b'\r\n\r\n')
        self.assertIn(b' 200 ', head.split(b'\r\n')[0])
        self.assertEqual(json.loads(body)['state'], 'completed')

    def test_completed_progress_matches_result_coverage(self):
        def factory(data):
            return {'schema': data['schema'], 'revision': data['revision'],
                    'sourceHash': data['sourceHash'], 'status': 'ok',
                    'candidates': [], 'usage': {'input_tokens': 9, 'output_tokens': 4},
                    'coverage': {'complete': True, 'calls': 5, 'batches': 5,
                                 'completedBatches': 5}}
        service = self.service(FakeRunner(result_factory=factory))
        _, port = self._serve(service)
        upload = self.upload(service)
        status, _, data = self._request(
            port, 'POST', '/internal/v1/jobs',
            body=json.dumps(self.body(upload, job_id='job-final-progress',
                                      key='idem-final-progress',
                                      request_hash='hash-final-progress')).encode(),
            content_type='application/json')
        self.assertEqual(status, 202)
        job_id = json.loads(data)['id']
        wait_state(service, OWNER, job_id, {'completed'})
        status, _, raw = self._request(port, 'GET', '/internal/v1/jobs/' + job_id)
        self.assertEqual(status, 200)
        snapshot = json.loads(raw)
        self.assertEqual(snapshot['state'], 'completed')
        self.assertEqual(snapshot['progress'], {'completedCalls': 5, 'requiredCalls': 5,
                                                'phase': 'completed'})
        self.assertEqual(json.loads(json.dumps(snapshot)), snapshot)

    def test_partial_progress_is_final_and_truthful(self):
        def factory(data):
            return {'schema': data['schema'], 'revision': data['revision'],
                    'sourceHash': data['sourceHash'], 'status': 'ok',
                    'candidates': [], 'usage': {'input_tokens': 2},
                    'coverage': {'complete': False, 'calls': 2, 'batches': 5,
                                 'completedBatches': 2}}
        service = self.service(FakeRunner(result_factory=factory))
        _, port = self._serve(service)
        upload = self.upload(service)
        status, _, data = self._request(
            port, 'POST', '/internal/v1/jobs',
            body=json.dumps(self.body(upload, job_id='job-partial-progress',
                                      key='idem-partial-progress',
                                      request_hash='hash-partial-progress')).encode(),
            content_type='application/json')
        self.assertEqual(status, 202)
        job_id = json.loads(data)['id']
        wait_state(service, OWNER, job_id, {'completed'})
        status, _, raw = self._request(port, 'GET', '/internal/v1/jobs/' + job_id)
        snapshot = json.loads(raw)
        self.assertEqual(snapshot['state'], 'completed')
        self.assertEqual(snapshot['progress'], {'completedCalls': 2, 'requiredCalls': 5,
                                                'phase': 'partial'})

    def test_oversized_upload_is_rejected_before_read(self):
        service = self.service(FakeRunner(), max_upload_bytes=1024)
        server, port = self._serve(service)
        status, _, data = self._request(
            port, 'POST',
            '/internal/v1/uploads?name=big.pdf&mime=application/pdf',
            body=b'x' * 2048)
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(data)['error']['code'], 'payload_too_large')


class ProviderRoutingTests(BaseRuntimeTest):
    def test_claude_job_keeps_anthropic_when_allowlist_starts_with_openai(self):
        runner = FakeRunner()
        service = RuntimeService(self.config(
            models=('gpt-5', MODEL), default_model='gpt-5'), review_runner=runner)
        self.addCleanup(service.close)
        self.assertEqual(service.health()['provider'], 'openai')
        self.assertEqual(service.health()['providers'], ['anthropic', 'openai'])
        upload = self.upload(service)
        snapshot, replayed = service.submit_job(self.body(
            upload, model=MODEL, job_id='job-claude-route', key='idem-claude-route',
            request_hash='hash-claude-route'))
        self.assertFalse(replayed)
        done = wait_state(service, OWNER, snapshot['id'])
        self.assertEqual(done['state'], 'completed', done)
        self.assertEqual(done['provider'], 'anthropic')
        self.assertEqual(runner.calls[0]['harness']['id'], 'hosted-anthropic')
        self.assertEqual(runner.calls[0]['harness']['name'], 'Hosted Anthropic')

    def test_openai_job_records_provider_and_usage_from_fake_factory(self):
        import red_service
        created = []

        class FakeOpenAI:
            def __init__(self, *args, **kwargs):
                created.append(kwargs)

            def infer(self, prompt, schema):
                return {
                    'status': 'ok',
                    'response': {'status': 'abstain', 'candidates': []},
                    'usage': {'input_tokens': 5, 'output_tokens': 2,
                              'cache_read_input_tokens': 1, 'cache_creation_input_tokens': 0},
                    'request_id': 'req_openai_fake',
                }

        real_backend = red_service.backend

        def routed(*args, **kwargs):
            kwargs['openai_factory'] = FakeOpenAI
            return real_backend(*args, **kwargs)

        env = {'HOSTED_AI_MODELS': 'claude-opus-5-5,gpt-5,o3', 'OPENAI_API_KEY': 'test-only-key'}
        with patch.dict(os.environ, env), patch('red_service.backend', routed):
            service = RuntimeService(self.config(
                models=('claude-opus-5-5', 'gpt-5', 'o3'), default_model='claude-opus-5-5',
                max_calls=4))
            self.addCleanup(service.close)
            upload = self.upload(service)
            snapshot, _ = service.submit_job(self.body(
                upload, model='gpt-5', effort='high', useEvidence=False,
                job_id='job-openai-0001', key='idem-openai-0001', request_hash='hash-openai-0001'))
            done = wait_state(service, OWNER, snapshot['id'], timeout=20)
        self.assertEqual(done['state'], 'completed', done)
        self.assertEqual(done['provider'], 'openai')
        self.assertEqual(done['usage'], {'inputTokens': 5, 'outputTokens': 2,
                                         'cacheReadInputTokens': 1, 'cacheCreationInputTokens': 0})
        self.assertEqual(done['result']['harness']['id'], 'hosted-openai')
        self.assertEqual(done['result']['harness']['name'], 'Hosted OpenAI')
        self.assertEqual(done['result']['hostedSelection']['provider'], 'openai-api')
        self.assertEqual(created[0]['model'], 'gpt-5')
        self.assertEqual(created[0]['effort'], 'high')
        self.assertEqual(len(created), 1)

    def test_missing_openai_key_fails_before_the_factory(self):
        import red_service
        created = []

        class FakeOpenAI:
            def __init__(self, *args, **kwargs):
                created.append(kwargs)

            def infer(self, prompt, schema):
                created.append('infer')
                return {'status': 'ok', 'response': {'status': 'abstain', 'candidates': []}, 'usage': {}}

        real_backend = red_service.backend

        def routed(*args, **kwargs):
            kwargs['openai_factory'] = FakeOpenAI
            return real_backend(*args, **kwargs)

        env = {'HOSTED_AI_MODELS': 'claude-opus-5-5,gpt-5', 'OPENAI_API_KEY': '   ',
               'ANTHROPIC_API_KEY': 'test-only-key'}
        with patch.dict(os.environ, env), patch('red_service.backend', routed):
            service = RuntimeService(self.config(
                models=(MODEL, 'gpt-5'), default_model=MODEL, max_calls=2))
            self.addCleanup(service.close)
            upload = self.upload(service)
            snapshot, _ = service.submit_job(self.body(
                upload, model='gpt-5', useEvidence=False, job_id='job-openai-nokey',
                key='idem-openai-nokey', request_hash='hash-openai-nokey'))
            done = wait_state(service, OWNER, snapshot['id'], timeout=20)
        self.assertEqual(done['state'], 'failed', done)
        self.assertEqual(done['failure']['code'], 'provider_not_configured')
        self.assertEqual(done['provider'], 'openai')
        self.assertNotIn('test-only-key', json.dumps(done))
        self.assertEqual(created, [])


if __name__ == '__main__':
    unittest.main()
