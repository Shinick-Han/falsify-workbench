"""End-to-end runtime HTTP test: upload -> hosted RED job -> artifacts, without a live provider."""
import hashlib
import json
import os
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

import anthropic_backend
from hosted_runtime.config import RuntimeConfig
from hosted_runtime.http_api import create_server
from hosted_runtime.service import RuntimeService

TOKEN = 'integration-service-token'
OWNER = 'usr:integration-owner'
PDF_TEXT = 'Group A had p = 0.04. The treatment was effective in this synthetic report.'


def make_pdf():
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), PDF_TEXT, fontsize=11)
    raw = doc.tobytes(garbage=4, deflate=True)
    doc.close()
    return raw


class FakeProvider:
    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()

    def __call__(self, request, timeout):
        with self.lock:
            self.requests.append(request)
        import re
        prompt = request['body']['messages'][0]['content'][-1]['text']
        match = re.search(r'"id":\s*"([^"]+)"', prompt)
        segment_id = match.group(1) if match else 'p1-b0'
        text = json.dumps({
            'status': 'ok',
            'candidates': [{
                'id': 'candidate-1', 'segmentId': segment_id, 'attackTypes': ['numeric-drift'],
                'before': 'Group A had p = 0.04', 'after': 'Group A had p = 0.40',
                'rationale': 'The reported p value changed within the same paragraph.',
                'uncertainty': None,
                'evidence': [{'segmentId': segment_id, 'quote': 'Group A had p = 0.04', 'relation': 'source'}],
            }],
        })
        return {'status': 200, 'headers': {'request-id': 'req_integration'},
                'body': json.dumps({'model': request['body']['model'], 'stop_reason': 'end_turn',
                                    'content': [{'type': 'text', 'text': text}],
                                    'usage': {'input_tokens': 100, 'output_tokens': 20}}).encode()}


class RuntimeHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='falsify-runtime-')
        cls.config = RuntimeConfig(state_dir=Path(cls.directory.name), service_token=TOKEN,
                                   max_calls=4, bind_port=0, max_concurrency=2)
        cls.service = RuntimeService(cls.config)
        cls.server = create_server(cls.service, host='127.0.0.1', port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:%d' % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.service.close()
        cls.directory.cleanup()

    def request(self, method, path, body=None, owner=OWNER, headers=None, token=TOKEN):
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if token is not None:
            req.add_header('X-Falsify-Service-Token', token)
        req.add_header('X-Falsify-Owner-Id', owner)
        if body is not None and not isinstance(body, bytes):
            req.add_header('Content-Type', 'application/json')
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.status, response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, error.read(), dict(error.headers)

    def json_request(self, method, path, body=None, owner=OWNER):
        status, raw, headers = self.request(method, path, body, owner)
        return status, (json.loads(raw) if raw else None), headers

    def test_hosted_red_job_end_to_end_with_workspace_header_and_usage(self):
        provider = FakeProvider()
        env = {'ANTHROPIC_API_KEY': 'test-only-key', 'ANTHROPIC_WORKSPACE_ID': 'ws-integration'}
        with patch.dict(os.environ, env), patch.object(anthropic_backend, '_http_transport', provider):
            raw_pdf = make_pdf()
            status, upload, _ = self.request(
                'POST', '/internal/v1/uploads?name=paper.pdf&mime=application/pdf', raw_pdf)
            self.assertEqual(status, 201)
            upload = json.loads(upload)['upload']
            self.assertEqual(upload['sha256'], hashlib.sha256(raw_pdf).hexdigest())

            body = {'jobId': 'job-integration-1', 'ownerId': OWNER, 'idempotencyKey': 'idem-integration-1',
                    'requestHash': 'hash-integration-1', 'role': 'red',
                    'prompt': 'Find a numeric inconsistency in the supplied document.',
                    'uploadId': upload['id'], 'model': 'claude-opus-5-5', 'effort': 'high',
                    'budget': {'maxCalls': 4}}
            status, submitted, _ = self.json_request('POST', '/internal/v1/jobs', body)
            self.assertEqual(status, 202)
            job_id = submitted['id']
            self.assertIn(submitted['state'], ('queued', 'running'))

            # A duplicate submission is read back, never a second paid call.
            status, replay, _ = self.json_request('POST', '/internal/v1/jobs', body)
            self.assertEqual(status, 200)
            self.assertEqual(replay['id'], job_id)

            snapshot = None
            for _ in range(200):
                status, snapshot, _ = self.json_request('GET', '/internal/v1/jobs/' + job_id)
                self.assertEqual(status, 200)
                if snapshot['state'] in ('completed', 'failed', 'cancelled', 'interrupted'):
                    break
                threading.Event().wait(0.05)
            self.assertEqual(snapshot['state'], 'completed', snapshot)
            self.assertGreaterEqual(len(provider.requests), 1)
            self.assertEqual(len(provider.requests), 1)
            request = provider.requests[0]
            self.assertEqual(request['headers']['anthropic-workspace-id'], 'ws-integration')
            self.assertEqual(request['body']['model'], 'claude-opus-5-5')
            self.assertEqual(request['body']['output_config']['effort'], 'high')

            self.assertEqual(snapshot['usage'], {'inputTokens': 100, 'outputTokens': 20})
            self.assertNotIn('cacheReadInputTokens', snapshot['usage'])
            self.assertEqual(snapshot['result']['candidates'][0]['after'], 'Group A had p = 0.40')
            self.assertEqual(snapshot['result']['provider']['requestId'], 'req_integration')
            names = {item['name'] for item in snapshot['artifacts']}
            self.assertIn('review.json', names)
            self.assertIn('extracted.json', names)

            artifact = next(item for item in snapshot['artifacts'] if item['name'] == 'review.json')
            status, raw, headers = self.request(
                'GET', '/internal/v1/jobs/%s/artifacts/%s' % (job_id, artifact['id']))
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(raw)['schema'], 'falsify.document-red.v1')
            self.assertEqual(hashlib.sha256(raw).hexdigest(), artifact['sha256'])

            # Foreign owners cannot read the job or artifact.
            status, _, _ = self.json_request('GET', '/internal/v1/jobs/' + job_id, owner='usr:other')
            self.assertEqual(status, 404)
            status, _, _ = self.request(
                'GET', '/internal/v1/jobs/%s/artifacts/%s' % (job_id, artifact['id']), owner='usr:other')
            self.assertEqual(status, 404)

    def test_conflicting_idempotency_and_service_token(self):
        with patch.dict(os.environ, {'ANTHROPIC_API_KEY': ''}):
            self._conflict_and_auth()

    def _conflict_and_auth(self):
        status, upload, _ = self.request(
            'POST', '/internal/v1/uploads?name=b.pdf&mime=application/pdf', make_pdf())
        self.assertEqual(status, 201)
        upload = json.loads(upload)['upload']
        base = {'jobId': 'job-conflict-1', 'ownerId': OWNER, 'idempotencyKey': 'idem-conflict-1',
                'requestHash': 'hash-a', 'role': 'blue', 'prompt': 'Review the document.',
                'uploadId': upload['id']}
        status, first, _ = self.json_request('POST', '/internal/v1/jobs', base)
        self.assertEqual(status, 202)
        status, payload, _ = self.json_request('POST', '/internal/v1/jobs', {**base, 'jobId': 'job-conflict-2',
                                                                             'requestHash': 'hash-b'})
        self.assertEqual(status, 409)
        self.assertEqual(payload['error']['code'], 'idempotency_conflict')
        for _ in range(200):
            status, state, _ = self.json_request('GET', '/internal/v1/jobs/' + first['id'])
            self.assertEqual(status, 200)
            if state['state'] in ('completed', 'failed', 'cancelled', 'interrupted'):
                break
            threading.Event().wait(0.05)
        self.assertIn(state['state'], ('failed', 'completed', 'cancelled', 'interrupted'))
        status, raw, _ = self.request('GET', '/internal/v1/jobs/' + first['id'], token=None)
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(raw)['error']['code'], 'unauthorized')


if __name__ == '__main__':
    unittest.main()
