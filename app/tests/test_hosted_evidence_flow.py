"""Cross-layer hosted evidence/edit/BLUE handoff through the real runtime HTTP API.

Uses a synthetic PDF with a real table and figure, the real Python table/figure evidence engine and the real
RED/BLUE services. The provider is an offline transport; no live call or secret is used.
"""
import hashlib
import json
import os
import re
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import anthropic_backend
import paper_evidence
from hosted_runtime.config import RuntimeConfig
from hosted_runtime.http_api import create_server
from hosted_runtime.service import RuntimeService
from test_paper_evidence import sample_pdf

TOKEN = 'evidence-flow-token'
OWNER = 'usr:evidence-flow-owner'
RED_SENTINEL = 'RED-RATIONALE-SENTINEL'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class FakeProvider:
    def __init__(self):
        self.prompts = []
        self.red = None

    def __call__(self, request, timeout):
        body = request['body']
        prompt = body['messages'][0]['content'][-1]['text']
        self.prompts.append(prompt)
        props = body['output_config']['format']['schema'].get('properties', {})
        if 'candidates' in props:
            segment = None
            for match in re.finditer(r'"id": "(p\d+-b\d+)", "label": "([^"]*)", "text": "((?:[^"\\]|\\.)*)"', prompt):
                text = json.loads('"' + match.group(3) + '"')
                if 'Groups' in text:
                    segment = match.group(1)
                    break
            assert segment is not None, 'table caption segment missing from RED prompt'
            candidate = {
                'id': 'red-candidate-1', 'segmentId': segment, 'attackTypes': ['contradiction'],
                'before': 'Groups', 'after': 'Group',
                'rationale': RED_SENTINEL, 'uncertainty': None,
                'evidence': [{'segmentId': segment, 'quote': 'Groups', 'relation': 'source'}],
            }
            self.red = candidate
            response = {'status': 'ok', 'candidates': [candidate], 'visualEdits': []}
        else:
            response = {'status': 'ok', 'findings': []}
        return {'status': 200, 'headers': {'request-id': 'req-evidence-flow'},
                'body': json.dumps({'model': body['model'], 'stop_reason': 'end_turn',
                                    'content': [{'type': 'text', 'text': json.dumps(response)}],
                                    'usage': {'input_tokens': 12, 'output_tokens': 3}}).encode()}


class HostedEvidenceFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='falsify-evidence-flow-')
        cls.config = RuntimeConfig(state_dir=Path(cls.directory.name), service_token=TOKEN,
                                   max_calls=4, bind_port=0, max_concurrency=2)
        cls.service = RuntimeService(cls.config)
        cls.server = create_server(cls.service, host='127.0.0.1', port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:%d' % cls.server.server_port
        cls.pdf = sample_pdf()
        cls.pdf_sha = sha(cls.pdf)
        cls.store = paper_evidence.EvidenceStore(ttl_seconds=3600, max_documents=2)
        cls.summary = cls.store.prepare(cls.pdf, cls.pdf_sha)
        table = cls.store.list_items(cls.summary['paperId'], kind='table')['items'][0]
        cls.table = cls.store.read_item(cls.summary['paperId'], table['id'])
        cls.cell = next(cell for cell in cls.table['table']['cells'] if cell['text'] == '1')

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.service.close()
        cls.directory.cleanup()

    def request(self, method, path, body=None, owner=OWNER, token=TOKEN):
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if token:
            req.add_header('X-Falsify-Service-Token', token)
        req.add_header('X-Falsify-Owner-Id', owner)
        if body is not None and not isinstance(body, bytes):
            req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                return response.status, response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, error.read(), dict(error.headers)

    def json_request(self, method, path, body=None, owner=OWNER):
        status, raw, headers = self.request(method, path, body, owner)
        return status, (json.loads(raw) if raw else None), headers

    def upload(self, data, name='paper.pdf'):
        status, raw, _ = self.request('POST', '/internal/v1/uploads?name=%s&mime=application/pdf' % name, data)
        self.assertEqual(status, 201, raw[:300])
        return json.loads(raw)['upload']

    def wait(self, job_id):
        snapshot = None
        for _ in range(400):
            status, snapshot, _ = self.json_request('GET', '/internal/v1/jobs/' + job_id)
            self.assertEqual(status, 200)
            if snapshot['state'] in ('completed', 'failed', 'cancelled', 'interrupted'):
                return snapshot
            threading.Event().wait(0.05)
        self.fail('job did not finish: %s' % snapshot)

    def test_table_figure_evidence_red_edit_and_blind_blue_handoff(self):
        provider = FakeProvider()
        with patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'test-only', 'ANTHROPIC_WORKSPACE_ID': 'ws-flow'}), \
                patch.object(anthropic_backend, '_http_transport', provider):
            source = self.upload(self.pdf)
            red_body = {'jobId': 'evidence-red-1', 'ownerId': OWNER, 'idempotencyKey': 'evidence-red-idem-1',
                        'requestHash': 'evidence-red-hash-1', 'role': 'red',
                        'prompt': 'Find a coordinated prose/table defect.', 'uploadId': source['id'],
                        'model': 'claude-opus-5-5', 'effort': 'high', 'useEvidence': True,
                        'budget': {'maxCalls': 4}}
            status, submitted, _ = self.json_request('POST', '/internal/v1/jobs', red_body)
            self.assertEqual(status, 202)
            red = self.wait(submitted['id'])
            self.assertEqual(red['state'], 'completed', red)
            self.assertEqual(red['result']['candidates'][0]['rationale'], RED_SENTINEL)
            names = {item['name'] for item in red['artifacts']}
            self.assertIn('evidence.json', names)
            self.assertIn('review.json', names)
            evidence = next(item for item in red['artifacts'] if item['name'] == 'evidence.json')
            status, raw, _ = self.request('GET', '/internal/v1/jobs/%s/artifacts/%s' % (red['id'], evidence['id']))
            self.assertEqual(status, 200)
            evidence_doc = json.loads(raw)
            self.assertGreaterEqual(evidence_doc['summary']['counts']['tables'], 1)
            self.assertGreaterEqual(evidence_doc['summary']['counts']['figures'], 1)

            red_prompt = next(prompt for prompt in provider.prompts
                              if 'SOURCE_PDF_STRUCTURED_EVIDENCE_V1' in prompt
                              and 'Table 1. Merged' in prompt)
            self.assertIn('Figure 1. Mark', red_prompt)
            self.assertIn('cells:', red_prompt)
            self.assertIn(self.cell['text'], red_prompt)
            self.assertIn('cell text is raw and uncorrected', red_prompt)

            # User selects the prose candidate and applies it without another model call.
            edit = {'id': 'edit-1', 'pageIndex': 0, 'before': 'Groups',
                    'after': 'Group', 'occurrence': 0}
            apply_body = {'jobId': 'evidence-apply-1', 'ownerId': OWNER,
                          'idempotencyKey': 'evidence-apply-idem-1', 'requestHash': 'evidence-apply-hash-1',
                          'role': 'red', 'prompt': 'Apply the selected change.',
                          'uploadId': source['id'], 'model': 'claude-opus-5-5', 'effort': 'high',
                          'applyOnly': True, 'edits': [edit], 'useEvidence': False, 'budget': {'maxCalls': 0}}
            status, applied_job, _ = self.json_request('POST', '/internal/v1/jobs', apply_body)
            self.assertEqual(status, 202)
            applied = self.wait(applied_job['id'])
            self.assertEqual(applied['state'], 'completed', applied)
            self.assertTrue(applied['result']['applyOnly'])
            self.assertEqual(applied['result']['textEdits']['applied'], 1)
            self.assertNotIn('usage', applied)
            edited_artifact = next(item for item in applied['artifacts'] if item['name'] == 'edited.pdf')
            status, edited_pdf, headers = self.request(
                'GET', '/internal/v1/jobs/%s/artifacts/%s' % (applied['id'], edited_artifact['id']))
            self.assertEqual(status, 200)
            self.assertTrue(edited_pdf.startswith(b'%PDF-'))
            self.assertEqual(sha(edited_pdf), edited_artifact['sha256'])
            with pymupdf.open(stream=edited_pdf, filetype='pdf') as doc:
                text = doc[0].get_text('text')
            self.assertIn('Group', text)
            self.assertNotIn('Groups', text)
            self.assertNotIn(RED_SENTINEL, text)

            # BLUE receives only the exact edited PDF bytes, not RED candidates/rationale.
            blue_source = self.upload(edited_pdf, 'edited.pdf')
            self.assertEqual(blue_source['sha256'], edited_artifact['sha256'])
            blue_body = {'jobId': 'evidence-blue-1', 'ownerId': OWNER,
                         'idempotencyKey': 'evidence-blue-idem-1', 'requestHash': 'evidence-blue-hash-1',
                         'role': 'blue', 'prompt': 'Independently review this document.',
                         'uploadId': blue_source['id'], 'model': 'claude-opus-5-5', 'effort': 'high',
                         'useEvidence': True, 'budget': {'maxCalls': 4}}
            status, blue_job, _ = self.json_request('POST', '/internal/v1/jobs', blue_body)
            self.assertEqual(status, 202)
            blue = self.wait(blue_job['id'])
            self.assertEqual(blue['state'], 'completed', blue)
            self.assertEqual(blue['result']['status'], 'ok')
            self.assertEqual(blue['result']['findings'], [])
            blue_prompts = [prompt for prompt in provider.prompts
                            if 'SOURCE_PDF_STRUCTURED_EVIDENCE_V1' in prompt
                            and 'Group' in prompt]
            self.assertTrue(blue_prompts, 'BLUE did not receive structured evidence from the edited PDF')
            self.assertIn('Group', blue_prompts[-1])
            self.assertNotIn('Groups', blue_prompts[-1])
            self.assertIn('Figure 1. Mark', blue_prompts[-1])
            self.assertNotIn(RED_SENTINEL, blue_prompts[-1])
            self.assertNotIn('"candidates"', blue_prompts[-1])

            # Cross-owner artifact read remains a 404.
            status, _, _ = self.request(
                'GET', '/internal/v1/jobs/%s/artifacts/%s' % (applied['id'], edited_artifact['id']),
                owner='usr:other')
            self.assertEqual(status, 404)


if __name__ == '__main__':
    unittest.main()
