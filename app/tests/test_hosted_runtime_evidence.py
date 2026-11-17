"""Offline hosted evidence/apply tests on synthetic PDFs (no private papers)."""

import base64
import hashlib
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

import pymupdf

import paper_visual_edit
import hosted_runtime.service as service_module
from hosted_runtime import (EvidenceError, RuntimeConfig, RuntimeService, ServiceError,
                            Store, StoreError, StoreNotFound)
from hosted_runtime.evidence import configure_store
from hosted_runtime.pdf_input import extract_pdf
from paper_evidence import EvidenceStore
from paper_evidence_blue import context_for_review
from red_multimodal import resolve_paper_context
from red_service import ReviewCancelled

OWNER = 'usr:33333333-3333-3333-3333-333333333333'
OTHER = 'usr:44444444-4444-4444-4444-444444444444'
TOKEN = 'evidence-test-service-token-0123456789'
MODEL = 'claude-opus-5-5'
TERMINAL = {'cancelled', 'completed', 'failed', 'interrupted'}


def fixture():
    """Synthetic PDF with one real table, one image figure, and reviewable prose."""
    document = pymupdf.open()
    page = document.new_page(width=400, height=400)
    page.insert_text((40, 35), 'Table 1. Observed counts')
    for y in (50, 80, 110, 140):
        page.draw_line((40, y), (280, y))
    for x in (40, 160, 280):
        page.draw_line((x, 50), (x, 140))
    for x, y, text in [(50, 70, 'Group'), (170, 70, 'Count'),
                       (50, 100, 'Control'), (170, 100, '7'),
                       (50, 130, 'Treatment'), (170, 130, '11')]:
        page.insert_text((x, y), text)
    page.insert_text((40, 175), 'The count was 9 in the treatment group.')
    pixmap = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 50, 40), False)
    pixmap.clear_with(140)
    page.insert_image(pymupdf.Rect(40, 200, 140, 280), stream=pixmap.tobytes('png'))
    page.insert_text((40, 300), 'Figure 1. Group illustration')
    raw = document.tobytes()
    document.close()
    return raw


PDF = fixture()
PDF_SHA = hashlib.sha256(PDF).hexdigest()


def wait_state(service, owner, job_id, states=TERMINAL, timeout=15.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        snapshot = service.get_job(owner, job_id)
        if snapshot['state'] in states:
            return snapshot
        time.sleep(0.02)
    raise AssertionError('job did not reach %s' % (states,))


def red_result(data):
    return {'schema': data['schema'], 'revision': data['revision'],
            'sourceHash': data['sourceHash'], 'status': 'ok', 'candidates': []}


def blue_result(data):
    return {'schema': data['schema'], 'revision': data['revision'],
            'sourceHash': data['sourceHash'], 'status': 'ok', 'findings': []}


class FakeRunner:
    def __init__(self, handler=None):
        self.calls = []
        self.handler = handler

    def __call__(self, data, progress, cancelled):
        self.calls.append(data)
        progress({'completedCalls': 0, 'requiredCalls': data['maxCalls'],
                  'phase': 'analyzing'})
        if self.handler is not None:
            return self.handler(data)
        return red_result(data) if data['schema'].endswith('red.v1') else blue_result(data)


class EvidenceBase(unittest.TestCase):
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

    def upload(self, service, data=PDF, owner=OWNER, name='paper.pdf'):
        upload, _ = service.create_upload(owner, name, 'application/pdf', data)
        return upload

    @staticmethod
    def body(upload, *, job_id='job-evidence-01', owner=OWNER, role='red',
             prompt='Review this paper for internal contradictions.',
             key='idem-evidence-01', request_hash='hash-evidence',
             **extra):
        value = {'jobId': job_id, 'ownerId': owner, 'idempotencyKey': key,
                 'requestHash': request_hash, 'role': role, 'uploadId': upload['id'],
                 'model': MODEL, 'effort': 'high'}
        if prompt is not None:
            value['prompt'] = prompt
        value.update(extra)
        return value

    def table_cell(self, service, text_value='7'):
        summary = service.evidence_store.prepare(PDF, PDF_SHA)
        item_id = service.evidence_store.list_items(
            summary['paperId'], kind='table')['items'][0]['id']
        item = service.evidence_store.read_item(summary['paperId'], item_id)
        cell = next(cell for cell in item['table']['cells']
                    if cell['text'] == text_value)
        return summary, item, cell


class CancellationTests(EvidenceBase):
    def test_review_cancelled_persists_provider_usage(self):
        class CancelRunner:
            def __call__(self, data, progress, cancelled):
                raise ReviewCancelled(
                    'cancelled after a paid call',
                    usage={'input_tokens': 5, 'output_tokens': 2,
                           'cache_read_input_tokens': 1,
                           'cache_creation_input_tokens': 0},
                    request_id='req_cancel_usage')

        service = self.service(CancelRunner())
        upload = self.upload(service)
        snapshot, _ = service.submit_job(self.body(
            upload, job_id='job-cancel-usage', key='idem-cancel-usage',
            request_hash='hash-cancel-usage'))
        done = wait_state(service, OWNER, snapshot['id'], {'cancelled'})
        self.assertEqual(done['state'], 'cancelled')
        self.assertEqual(done['usage'], {'inputTokens': 5, 'outputTokens': 2,
                                         'cacheReadInputTokens': 1,
                                         'cacheCreationInputTokens': 0})
        self.assertEqual(done['providerRequestId'], 'req_cancel_usage')
        self.assertNotIn('result', done)

    def test_cancel_after_result_persists_usage(self):
        class CancelAfterResult:
            def __call__(self, data, progress, cancelled):
                result = red_result(data)
                result['usage'] = {'input_tokens': 3, 'output_tokens': 1}
                result['provider'] = {'id': 'anthropic-api', 'models': [MODEL],
                                      'requestId': 'req_after_result'}
                cancelled.set()
                return result

        service = self.service(CancelAfterResult())
        upload = self.upload(service)
        snapshot, _ = service.submit_job(self.body(
            upload, job_id='job-cancel-after', key='idem-cancel-after',
            request_hash='hash-cancel-after'))
        done = wait_state(service, OWNER, snapshot['id'], {'cancelled'})
        self.assertEqual(done['usage'], {'inputTokens': 3, 'outputTokens': 1})
        self.assertEqual(done['providerRequestId'], 'req_after_result')
        self.assertNotIn('result', done)


class EvidenceTests(EvidenceBase):
    def test_evidence_artifact_and_red_context(self):
        seen = {}

        def handler(data):
            seen['data'] = data
            structured = resolve_paper_context(data)
            seen['text'] = structured['text']
            return red_result(data)

        runner = FakeRunner(handler)
        service = self.service(runner)
        upload = self.upload(service)
        snapshot, replayed = service.submit_job(self.body(upload))
        self.assertFalse(replayed)
        done = wait_state(service, OWNER, snapshot['id'], {'completed'})
        self.assertTrue(done['useEvidence'])
        self.assertFalse(done['applyOnly'])
        envelope = seen['data']
        self.assertEqual(envelope['paperEvidenceConsent'], True)
        self.assertEqual(envelope['fileHash'], upload['sha256'])
        self.assertEqual(envelope['paperEvidence']['fileHash'], upload['sha256'])
        self.assertIn('Control', seen['text'])
        self.assertIn('7', seen['text'])
        self.assertIn('Figure 1. Group illustration', seen['text'])

        artifact = next(a for a in done['artifacts'] if a['name'] == 'evidence.json')
        _, raw = service.get_artifact(OWNER, done['id'], artifact['id'])
        evidence = json.loads(raw)
        self.assertEqual(evidence['schema'], 'falsify.hosted-evidence.v1')
        self.assertEqual(evidence['summary']['fileHash'], upload['sha256'])
        self.assertGreaterEqual(evidence['summary']['counts']['tables'], 1)
        self.assertGreaterEqual(evidence['summary']['counts']['figures'], 1)
        self.assertEqual({item['type'] for item in evidence['items']},
                         {'table', 'figure'})
        self.assertTrue(any(item['caption'] == 'Table 1. Observed counts'
                            for item in evidence['items']))
        self.assertNotIn(b'"cells"', raw)
        self.assertNotIn(b'imageSha256', raw)

    def test_blue_receives_structured_context_but_no_red_material(self):
        seen = {}

        def handler(data):
            seen['data'] = data
            seen['keys'] = set(data)
            seen['text'] = context_for_review(
                data['paperEvidence']['paperId'], data['fileHash'],
                store=service.evidence_store)['text']
            return blue_result(data)

        runner = FakeRunner(handler)
        service = self.service(runner)
        upload = self.upload(service)
        snapshot, _ = service.submit_job(self.body(
            upload, role='blue', job_id='job-blue-evidence', key='idem-blue-ev',
            request_hash='hash-blue'))
        wait_state(service, OWNER, snapshot['id'], {'completed'})
        self.assertEqual(seen['data']['schema'], 'falsify.document-blue.v1')
        self.assertNotIn('candidates', seen['keys'])
        self.assertNotIn('visualEdits', seen['keys'])
        self.assertNotIn('rationale', json.dumps(seen['data']))
        self.assertIn('Control', seen['text'])
        self.assertIn('Figure 1. Group illustration', seen['text'])

    def test_use_evidence_false_omits_handle_and_artifact(self):
        seen = {}

        def handler(data):
            seen['keys'] = set(data)
            return red_result(data)

        runner = FakeRunner(handler)
        service = self.service(runner)
        upload = self.upload(service)
        snapshot, _ = service.submit_job(self.body(
            upload, useEvidence=False, job_id='job-no-evidence', key='idem-no-ev',
            request_hash='hash-no-ev'))
        done = wait_state(service, OWNER, snapshot['id'], {'completed'})
        self.assertFalse(done['useEvidence'])
        self.assertNotIn('paperEvidence', seen['keys'])
        self.assertNotIn('paperEvidenceConsent', seen['keys'])
        self.assertNotIn('fileHash', seen['keys'])
        self.assertNotIn('evidence.json', [a['name'] for a in done['artifacts']])
        self.assertEqual(runner.calls[0]['schema'], 'falsify.document-red.v1')

    def test_normal_red_visual_edits_are_preserved_not_auto_applied(self):
        visual = [{'kind': 'table-cell', 'itemId': 't1', 'row': 1, 'column': 1,
                   'before': '7', 'after': '8', 'rationale': 'Keep the table aligned.'}]

        def handler(data):
            result = red_result(data)
            result['visualEdits'] = visual
            return result

        runner = FakeRunner(handler)
        service = self.service(runner)
        upload = self.upload(service)
        snapshot, _ = service.submit_job(self.body(upload, job_id='job-preserve-vis',
                                                   key='idem-preserve', request_hash='hash-preserve'))
        done = wait_state(service, OWNER, snapshot['id'], {'completed'})
        self.assertEqual(done['result']['visualEdits'], visual)
        names = [a['name'] for a in done['artifacts']]
        self.assertNotIn('edited.pdf', names)
        review = next(a for a in done['artifacts'] if a['name'] == 'review.json')
        _, raw = service.get_artifact(OWNER, done['id'], review['id'])
        self.assertEqual(json.loads(raw)['visualEdits'], visual)

    def test_evidence_failure_does_not_fall_back_to_text_only(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        with patch.object(service_module, 'prepare_evidence',
                          side_effect=EvidenceError('evidence_too_large')):
            snapshot, _ = service.submit_job(self.body(upload, job_id='job-ev-fail',
                                                       key='idem-ev-fail',
                                                       request_hash='hash-ev-fail'))
            done = wait_state(service, OWNER, snapshot['id'], {'failed'})
        self.assertEqual(done['failure']['code'], 'evidence_too_large')
        self.assertEqual(runner.calls, [])
        names = [a['name'] for a in done['artifacts']]
        self.assertNotIn('review.json', names)
        self.assertNotIn('evidence.json', names)


class ApplyTests(EvidenceBase):
    def test_apply_only_table_and_text_edits(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        _, item, cell = self.table_cell(service)
        body = self.body(
            upload, prompt=None, applyOnly=True, useEvidence=False,
            job_id='job-apply-0001', key='idem-apply-01', request_hash='hash-apply',
            visualEdits=[{'kind': 'table-cell', 'itemId': item['id'],
                          'row': cell['row'], 'column': cell['column'],
                          'before': '7', 'after': '8',
                          'rationale': 'Keep table and prose aligned.'}],
            edits=[{'pageIndex': 0, 'before': 'was',
                    'after': 'is'}])
        snapshot, replayed = service.submit_job(body)
        self.assertFalse(replayed)
        done = wait_state(service, OWNER, snapshot['id'], {'completed'})
        self.assertTrue(done['applyOnly'])
        self.assertFalse(done['useEvidence'])
        self.assertEqual(runner.calls, [])
        names = [a['name'] for a in done['artifacts']]
        self.assertIn('evidence.json', names)
        self.assertIn('edited.pdf', names)
        self.assertIn('apply.json', names)
        self.assertNotIn('review.json', names)
        self.assertNotIn('usage', done)
        self.assertNotIn('providerRequestId', done)
        self.assertEqual(done['result']['schema'], 'falsify.hosted-apply.v1')
        self.assertEqual(done['result']['visualEdits']['applied'], 1)
        self.assertEqual(done['result']['textEdits']['applied'], 1)

        edited_meta = next(a for a in done['artifacts'] if a['name'] == 'edited.pdf')
        _, edited = service.get_artifact(OWNER, done['id'], edited_meta['id'])
        self.assertEqual(hashlib.sha256(edited).hexdigest(), edited_meta['sha256'])
        apply_meta = next(a for a in done['artifacts'] if a['name'] == 'apply.json')
        _, apply_raw = service.get_artifact(OWNER, done['id'], apply_meta['id'])
        apply = json.loads(apply_raw)
        self.assertEqual(apply['sourceSha256'], PDF_SHA)
        self.assertEqual(apply['outputSha256'], hashlib.sha256(edited).hexdigest())
        self.assertEqual(apply['pageCount'], 1)
        self.assertEqual(apply['visualEdits'],
                         {'requested': 1, 'applied': 1, 'rejected': 0,
                          'changes': [{'id': 've-1', 'pageIndex': 0}]})
        self.assertEqual(apply['textEdits']['requested'], 1)
        self.assertEqual(apply['textEdits']['applied'], 1)

        extracted = extract_pdf(edited)
        prose = '\n\n'.join(s['text'] for s in extracted['segments'])
        self.assertIn('The count is 9', prose)
        self.assertNotIn('The count was 9', prose)
        edited_store = EvidenceStore(max_documents=2)
        edited_summary = edited_store.prepare(edited, hashlib.sha256(edited).hexdigest())
        table_id = edited_store.list_items(edited_summary['paperId'], kind='table')['items'][0]['id']
        edited_item = edited_store.read_item(edited_summary['paperId'], table_id)
        self.assertIn('8', [cell['text'] for cell in edited_item['table']['cells']])

    def test_duplicate_apply_only_does_not_rerun(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        _, item, cell = self.table_cell(service)
        body = self.body(
            upload, prompt=None, applyOnly=True, useEvidence=False,
            job_id='job-apply-dup1', key='idem-apply-dup', request_hash='hash-apply-dup',
            visualEdits=[{'kind': 'table-cell', 'itemId': item['id'],
                          'row': cell['row'], 'column': cell['column'],
                          'before': '7', 'after': '8', 'rationale': 'Selected.'}])
        original = service_module.apply_evidence_edits
        calls = []

        def wrapped(*args, **kwargs):
            calls.append(1)
            return original(*args, **kwargs)

        with patch.object(service_module, 'apply_evidence_edits', side_effect=wrapped):
            first, replayed = service.submit_job(body)
            self.assertFalse(replayed)
            done = wait_state(service, OWNER, first['id'], {'completed'})
            second, replayed = service.submit_job({**body, 'jobId': 'job-apply-dup2'})
        self.assertTrue(replayed)
        self.assertEqual(second['id'], done['id'])
        self.assertEqual(len(calls), 1)
        self.assertEqual(second['artifacts'], done['artifacts'])

    def test_unsupported_chart_point_fails_and_preserves_source(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        body = self.body(
            upload, prompt=None, applyOnly=True, useEvidence=False,
            job_id='job-chart-apply', key='idem-chart-apply',
            request_hash='hash-chart-apply',
            visualEdits=[{'kind': 'chart-point', 'itemId': 'f1', 'seriesId': 's1',
                          'pointIndex': 0, 'beforeY': 1.0, 'afterY': 2.0,
                          'rationale': 'Selected chart point.'}])
        snapshot, _ = service.submit_job(body)
        done = wait_state(service, OWNER, snapshot['id'], {'failed'})
        self.assertEqual(done['failure']['code'], 'visual_edit_kind_unsupported')
        self.assertFalse(done['failure']['retryable'])
        names = [a['name'] for a in done['artifacts']]
        self.assertNotIn('edited.pdf', names)
        self.assertNotIn('apply.json', names)
        stored_upload, stored_bytes = service.store.read_upload_bytes(OWNER, upload['id'])
        self.assertEqual(stored_bytes, PDF)
        self.assertEqual(stored_upload['sha256'], PDF_SHA)
        self.assertEqual(runner.calls, [])

    def test_zero_budget_is_rejected_for_normal_review(self):
        service = self.service(FakeRunner())
        upload = self.upload(service)
        body = self.body(upload, job_id='job-zero-budget', key='idem-zero-budget',
                         request_hash='hash-zero-budget', budget={'maxCalls': 0})
        with self.assertRaises(ServiceError) as error:
            service.submit_job(body)
        self.assertEqual(error.exception.code, 'invalid_request')

    def test_apply_only_text_edit_without_evidence(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        body = self.body(
            upload, prompt=None, applyOnly=True, useEvidence=False,
            job_id='job-apply-text', key='idem-apply-text',
            request_hash='hash-apply-text',
            budget={'maxCalls': 0},
            edits=[{'pageIndex': 0, 'before': 'was',
                    'after': 'is'}])
        snapshot, _ = service.submit_job(body)
        done = wait_state(service, OWNER, snapshot['id'], {'completed'})
        self.assertTrue(done['applyOnly'])
        self.assertFalse(done['useEvidence'])
        self.assertEqual(done['progress']['completedCalls'], 0)
        self.assertEqual(done['progress']['requiredCalls'], 0)
        self.assertEqual(done['progress']['phase'], 'completed')
        self.assertEqual(runner.calls, [])
        names = [a['name'] for a in done['artifacts']]
        self.assertIn('edited.pdf', names)
        self.assertIn('apply.json', names)
        self.assertNotIn('evidence.json', names)
        self.assertNotIn('usage', done)
        edited_meta = next(a for a in done['artifacts'] if a['name'] == 'edited.pdf')
        _, edited = service.get_artifact(OWNER, done['id'], edited_meta['id'])
        prose = '\n\n'.join(s['text'] for s in extract_pdf(edited)['segments'])
        self.assertIn('The count is 9', prose)
        self.assertNotIn('The count was 9', prose)
        apply_meta = next(a for a in done['artifacts'] if a['name'] == 'apply.json')
        _, apply_raw = service.get_artifact(OWNER, done['id'], apply_meta['id'])
        apply = json.loads(apply_raw)
        self.assertEqual(apply['sourceSha256'], PDF_SHA)
        self.assertEqual(apply['outputSha256'], hashlib.sha256(edited).hexdigest())
        self.assertEqual(apply['visualEdits']['requested'], 0)
        self.assertEqual(apply['textEdits']['applied'], 1)

    def test_traced_text_edit_fails_without_edited_pdf(self):
        service = self.service(FakeRunner())
        upload = self.upload(service)
        body = self.body(
            upload, prompt=None, applyOnly=True, useEvidence=False,
            job_id='job-apply-trace', key='idem-apply-trace',
            request_hash='hash-apply-trace',
            edits=[{'pageIndex': 0, 'before': 'The count was 9',
                    'after': 'The count was 8'}])
        snapshot, _ = service.submit_job(body)
        done = wait_state(service, OWNER, snapshot['id'], {'failed'})
        self.assertEqual(done['failure']['code'], 'apply_edit_trace')
        names = [a['name'] for a in done['artifacts']]
        self.assertNotIn('edited.pdf', names)
        self.assertNotIn('apply.json', names)
        self.assertEqual(service.store.read_upload_bytes(OWNER, upload['id'])[1], PDF)

    def test_ambiguous_text_edit_fails_before_mutation(self):
        service = self.service(FakeRunner())
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((72, 72), 'The value 10 and the value 20.', fontsize=11)
        raw = document.tobytes()
        document.close()
        upload = self.upload(service, data=raw)
        body = self.body(
            upload, prompt=None, applyOnly=True, useEvidence=False,
            job_id='job-apply-ambiguous', key='idem-apply-ambiguous',
            request_hash='hash-apply-ambiguous',
            edits=[{'pageIndex': 0, 'before': 'value', 'after': 'number'}])
        snapshot, _ = service.submit_job(body)
        done = wait_state(service, OWNER, snapshot['id'], {'failed'})
        self.assertEqual(done['failure']['code'], 'apply_edit_ambiguous')
        self.assertNotIn('edited.pdf', [a['name'] for a in done['artifacts']])
        self.assertEqual(service.store.read_upload_bytes(OWNER, upload['id'])[1], raw)

    def test_visual_verification_warning_fails_apply(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        _, item, cell = self.table_cell(service)
        source = PDF
        fake = {
            'schema': 'falsify.visual-edit-export.v1',
            'sourceSha256': PDF_SHA,
            'outputSha256': hashlib.sha256(source).hexdigest(),
            'file': base64.b64encode(source).decode('ascii'),
            'pageCount': 1,
            'changes': [{'id': 've-1', 'pageIndex': 0, 'bbox': [0, 0, 1, 1]}],
            'verification': {'status': 'warning',
                             'issues': [{'code': 'saved-cell-text-unconfirmed'}],
                             'checks': ['page-count']},
        }
        body = self.body(
            upload, prompt=None, applyOnly=True, useEvidence=False,
            job_id='job-vis-warning', key='idem-vis-warning',
            request_hash='hash-vis-warning',
            visualEdits=[{'kind': 'table-cell', 'itemId': item['id'],
                          'row': cell['row'], 'column': cell['column'],
                          'before': '7', 'after': '8', 'rationale': 'Selected.'}])
        with patch.object(paper_visual_edit, 'export_visual', return_value=fake):
            snapshot, _ = service.submit_job(body)
            done = wait_state(service, OWNER, snapshot['id'], {'failed'})
        self.assertEqual(done['failure']['code'], 'apply_verify_failed')
        names = [a['name'] for a in done['artifacts']]
        self.assertNotIn('edited.pdf', names)
        self.assertNotIn('apply.json', names)
        self.assertEqual(service.store.read_upload_bytes(OWNER, upload['id'])[1], PDF)

    def test_use_evidence_false_still_prepares_evidence_for_visual_apply(self):
        runner = FakeRunner()
        service = self.service(runner)
        upload = self.upload(service)
        _, item, cell = self.table_cell(service)
        body = self.body(
            upload, prompt=None, applyOnly=True, useEvidence=False,
            job_id='job-apply-ev', key='idem-apply-ev', request_hash='hash-apply-ev',
            visualEdits=[{'kind': 'table-cell', 'itemId': item['id'],
                          'row': cell['row'], 'column': cell['column'],
                          'before': '7', 'after': '8', 'rationale': 'Selected.'}])
        snapshot, _ = service.submit_job(body)
        done = wait_state(service, OWNER, snapshot['id'], {'completed'})
        self.assertFalse(done['useEvidence'])
        self.assertIn('evidence.json', [a['name'] for a in done['artifacts']])
        self.assertIn('edited.pdf', [a['name'] for a in done['artifacts']])


class UploadRetentionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = Store(self._tmp.name)

    def test_upload_only_blob_is_deleted_after_retention(self):
        upload, _ = self.store.put_upload(OWNER, 'orphan.pdf', 'application/pdf', PDF)
        blob = self.store._blob_path(upload['sha256'])
        self.assertTrue(blob.is_file())
        self.store.prune_jobs(retention_seconds=1, now=time.time() + 10)
        with self.assertRaises(StoreNotFound):
            self.store.get_upload(OWNER, upload['id'])
        self.assertFalse(blob.exists())

    def test_referenced_upload_is_preserved(self):
        upload, _ = self.store.put_upload(OWNER, 'kept.pdf', 'application/pdf', PDF)
        self.store.create_job(
            owner_id=OWNER, job_id='job-kept-upload', idempotency_key='idem-kept-upload',
            request_hash='hash-kept-upload', role='red', model=MODEL, effort='high',
            provider='anthropic', progress={'completedCalls': 0, 'requiredCalls': 12,
                                            'phase': 'queued'}, upload_id=upload['id'])
        self.store.prune_jobs(retention_seconds=1, now=time.time() + 10)
        self.assertEqual(self.store.get_upload(OWNER, upload['id'])['id'], upload['id'])
        self.assertTrue(self.store._blob_path(upload['sha256']).is_file())


class RuntimeLockTests(EvidenceBase):
    def test_second_service_fails_closed_without_disturbing_first(self):
        first = self.service(FakeRunner())
        self.assertTrue(first.health()['ready'])
        with self.assertRaises(StoreError) as error:
            RuntimeService(self.config(), review_runner=FakeRunner())
        self.assertEqual(error.exception.code, 'state_in_use')
        self.assertTrue(first.health()['ready'])


if __name__ == '__main__':
    unittest.main()
