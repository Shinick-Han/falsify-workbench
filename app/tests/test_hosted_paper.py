"""Hosted runtime paper-tools route. Synthetic PDFs only; no network or model calls."""

import base64
import hashlib
import http.client
import io
import json
import logging
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

try:
    import pymupdf
except ImportError:
    pymupdf = None

from hosted_runtime import ConfigError, RuntimeConfig, RuntimeService
from hosted_runtime.http_api import JSON_LIMIT, PAPER_JSON_LIMIT, create_server
from hosted_runtime.paper_tools import IDLE_TTL, PaperTools

OWNER = 'usr:11111111-1111-1111-1111-111111111111'
OTHER = 'usr:22222222-2222-2222-2222-222222222222'
TOKEN = 'test-service-token-0123456789'
MODEL = 'claude-opus-5-5'
MARKER = 'pbdy-7f3a9c2e'
PAPER_URL = '/internal/v1/paper'


def digest_of(raw):
    return hashlib.sha256(raw).hexdigest()


def draw_table(page):
    specs = [(0, 0, 1, 1, 'Metric'), (0, 1, 1, 2, 'Groups'), (1, 0, 2, 1, 'span'),
             (1, 1, 1, 1, '1'), (1, 2, 1, 1, '2'), (2, 1, 1, 1, ''), (2, 2, 1, 1, '5')]
    origin, col_w, row_h = (72, 90), 100, 28
    for row, column, row_span, col_span, text in specs:
        rect = pymupdf.Rect(origin[0] + column * col_w, origin[1] + row * row_h,
                            origin[0] + (column + col_span) * col_w,
                            origin[1] + (row + row_span) * row_h)
        page.draw_rect(rect, color=(0, 0, 0), width=1)
        if text:
            page.insert_textbox(pymupdf.Rect(rect.x0 + 3, rect.y0 + 6, rect.x1 - 3, rect.y1 - 3),
                                text, fontsize=10, fontname='helv')


def table_pdf(label):
    document = pymupdf.open()
    try:
        page = document.new_page(width=595, height=842)
        page.insert_text((72, 78), label, fontsize=11)
        draw_table(page)
        return document.tobytes()
    finally:
        document.close()


def text_pdf(text):
    document = pymupdf.open()
    try:
        page = document.new_page()
        page.insert_text((72, 72), text, fontsize=11)
        return document.tobytes()
    finally:
        document.close()


class BlockRunner:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()

    def __call__(self, data, progress, cancelled):
        self.started.set()
        self.release.wait(30)
        return {'schema': data.get('schema'), 'revision': data.get('revision'),
                'sourceHash': data.get('sourceHash'), 'status': 'ok'}


class PaperCase(unittest.TestCase):
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

    def service(self, runner=None, **overrides):
        service = RuntimeService(self.config(**overrides), review_runner=runner)
        self.addCleanup(service.close)
        return service

    def serve(self, service):
        server = create_server(service, '127.0.0.1', 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def request(self, port, method, path, *, token=TOKEN, owner=OWNER, body=None,
                headers=None, content_type=None, timeout=30):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
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
            return response.status, response.read()
        finally:
            connection.close()

    def headers_only(self, port, path, *, token=TOKEN, owner=None, content_length=None,
                     content_type='application/json'):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=8)
        connection.putrequest('POST', path)
        if token is not None:
            connection.putheader('X-Falsify-Service-Token', token)
        if owner is not None:
            connection.putheader('X-Falsify-Owner-Id', owner)
        if content_type is not None:
            connection.putheader('Content-Type', content_type)
        if content_length is not None:
            connection.putheader('Content-Length', str(content_length))
        connection.endheaders()
        try:
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def post(self, port, path, body, *, owner=OWNER, timeout=90):
        raw = json.dumps({'ownerId': owner, 'path': path, 'body': body},
                         separators=(',', ':')).encode('utf-8')
        status, data = self.request(port, 'POST', PAPER_URL, owner=None, body=raw,
                                    content_type='application/json', timeout=timeout)
        return status, json.loads(data.decode('utf-8'))


class PaperConfigTests(PaperCase):
    def test_flag_defaults_off_and_accepts_only_one(self):
        env = {'HOSTED_AI_STATE_DIR': self._tmp.name, 'HOSTED_AI_SERVICE_TOKEN': TOKEN}
        self.assertFalse(RuntimeConfig.from_env(env).paper_tools)
        env['HOSTED_PAPER_TOOLS'] = '0'
        self.assertFalse(RuntimeConfig.from_env(env).paper_tools)
        env['HOSTED_PAPER_TOOLS'] = '1'
        config = RuntimeConfig.from_env(env)
        self.assertTrue(config.paper_tools)
        self.assertEqual(config.paper_max_owners, 32)
        self.assertEqual(config.paper_max_concurrency, 2)
        self.assertEqual(config.paper_max_analysis, 1)
        env['HOSTED_PAPER_TOOLS'] = 'true'
        with self.assertRaises(ConfigError):
            RuntimeConfig.from_env(env)

    def test_owner_lru_and_idle_ttl(self):
        clock = {'t': 1_700_000_000.0}
        tools = PaperTools(self.config(paper_tools=True, paper_max_owners=2),
                           clock=lambda: clock['t'])
        self.addCleanup(tools.close)

        def seen(owner):
            status, payload = tools.handle({
                'ownerId': owner, 'path': '/api/paper/evidence/prepare', 'body': {'n': 1},
            })
            self.assertEqual(status, 200)
            self.assertTrue(payload['ok'])

        stores = []
        tools.handlers['prepare'] = lambda state, body: stores.append(state.store) or {'ok': True}
        seen('a1')
        first = stores[-1]
        seen('b1')
        seen('c1')
        seen('a1')
        self.assertIsNot(stores[-1], first)
        clock['t'] += 7199
        seen('a1')
        held = stores[-1]
        clock['t'] += IDLE_TTL
        seen('a1')
        self.assertIsNot(stores[-1], held)

    def test_active_analysis_is_not_idle_evicted(self):
        clock = {'t': 1_700_000_000.0}
        holder = {}
        tools = PaperTools(self.config(paper_tools=True), clock=lambda: clock['t'])
        self.addCleanup(tools.close)

        def grab(state, body):
            holder['state'] = state
            return {'id': id(state.store)}

        tools.handlers['prepare'] = grab
        status, payload = tools.handle({
            'ownerId': 'a1', 'path': '/api/paper/evidence/prepare', 'body': {},
        })
        self.assertEqual(status, 200)
        holder['state'].active_analysis = 1
        clock['t'] += IDLE_TTL + 5
        status, again = tools.handle({
            'ownerId': 'a1', 'path': '/api/paper/evidence/prepare', 'body': {},
        })
        self.assertEqual(status, 200)
        self.assertEqual(again['id'], payload['id'])


class PaperHttpTests(PaperCase):
    def test_disabled_is_404_and_auth_is_required(self):
        port = self.serve(self.service())
        status, data = self.request(port, 'POST', PAPER_URL, owner=None, body=b'{}',
                                    content_type='application/json')
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(data)['error']['code'], 'paper_tools_disabled')
        status, data = self.request(port, 'POST', PAPER_URL, token=None, owner=None,
                                    body=b'{}', content_type='application/json')
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(data)['error']['code'], 'unauthorized')
        status, _ = self.request(port, 'GET', '/internal/v1/health')
        health = json.loads(_)
        self.assertEqual(status, 200)
        self.assertNotIn('paperTools', health)
        self.assertEqual(set(health), {'ok', 'provider', 'providers', 'models', 'version', 'ready'})

    def test_enabled_health_reports_capability_flags(self):
        import paper_analysis_service
        import paper_chart_edit_service
        import paper_enrichment
        port = self.serve(self.service(paper_tools=True))
        status, data = self.request(port, 'GET', '/internal/v1/health')
        self.assertEqual(status, 200)
        health = json.loads(data)
        self.assertEqual(health['paperTools'], {
            'enabled': True,
            'visualEditor': bool(paper_analysis_service.capability()['available']),
            'chartEdit': bool(paper_chart_edit_service.capability()['available']),
            'analysis': bool(paper_enrichment.capability()['runtimeConfigured']),
        })

    def test_auth_unsupported_path_and_companion_code(self):
        port = self.serve(self.service(paper_tools=True))
        status, data = self.request(port, 'POST', PAPER_URL, token='wrong', owner=None,
                                    body=b'{}', content_type='application/json')
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(data)['error']['code'], 'unauthorized')
        status, payload = self.post(port, '/api/paper/chart/preview', {})
        self.assertEqual(status, 404)
        self.assertEqual(payload['error']['code'], 'paper_path_unsupported')
        status, payload = self.post(port, '/api/paper/evidence/query', None)
        self.assertEqual(status, 400)
        self.assertEqual(payload['error']['code'], 'paper_evidence_request_invalid')
        status, payload = self.post(port, '/nope', {})
        self.assertEqual(status, 404)
        self.assertEqual(payload['error']['code'], 'paper_path_unsupported')
        raw = json.dumps({'path': '/api/paper/evidence/query', 'body': {}}).encode('utf-8')
        status, data = self.request(port, 'POST', PAPER_URL, owner=None, body=raw,
                                    content_type='application/json')
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(data)['error']['code'], 'invalid_request')

    def test_body_limit_is_route_specific(self):
        port = self.serve(self.service(paper_tools=True))
        status, data = self.headers_only(port, PAPER_URL, content_length=PAPER_JSON_LIMIT + 1)
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(data)['error']['code'], 'payload_too_large')
        status, data = self.headers_only(port, '/internal/v1/jobs', owner=OWNER,
                                         content_length=JSON_LIMIT + 1)
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(data)['error']['code'], 'payload_too_large')
        pad = 'x' * (JSON_LIMIT + 32)
        status, payload = self.post(port, '/api/paper/not-a-route', {'pad': pad})
        self.assertEqual(status, 404)
        self.assertEqual(payload['error']['code'], 'paper_path_unsupported')

    def test_semaphore_full_returns_paper_busy(self):
        service = self.service(paper_tools=True, paper_max_concurrency=2)
        entered = threading.Semaphore(0)
        release = threading.Event()

        def block(state, body):
            entered.release()
            release.wait(10)
            return {'ok': True}

        service.paper.handlers['prepare'] = block
        port = self.serve(service)
        threads = []

        def call():
            self.post(port, '/api/paper/evidence/prepare', {'n': 1}, timeout=8)

        for _ in range(2):
            thread = threading.Thread(target=call)
            thread.start()
            threads.append(thread)
        try:
            self.assertTrue(entered.acquire(timeout=5))
            self.assertTrue(entered.acquire(timeout=5))
            status, payload = self.post(port, '/api/paper/evidence/prepare', {'n': 2}, timeout=5)
            self.assertEqual(status, 429)
            self.assertEqual(payload['error']['code'], 'paper_busy')
        finally:
            release.set()
            for thread in threads:
                thread.join(5)
                self.assertFalse(thread.is_alive())

    def test_log_omits_path_and_body_marker(self):
        port = self.serve(self.service(paper_tools=True))
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        root = logging.getLogger()
        previous = root.level
        root.addHandler(handler)
        root.setLevel(logging.INFO)
        stderr = io.StringIO()
        stdout = io.StringIO()
        old_err, old_out = sys.stderr, sys.stdout
        sys.stderr, sys.stdout = stderr, stdout
        try:
            status, payload = self.post(port, '/api/paper/' + MARKER, {'marker': MARKER})
        finally:
            sys.stderr, sys.stdout = old_err, old_out
            root.removeHandler(handler)
            root.setLevel(previous)
        self.assertEqual(status, 404)
        self.assertEqual(payload['error']['code'], 'paper_path_unsupported')
        self.assertNotIn(MARKER, json.dumps(payload))
        self.assertNotIn(MARKER, stream.getvalue())
        self.assertNotIn(MARKER, stderr.getvalue())
        self.assertNotIn(MARKER, stdout.getvalue())

    def test_analysis_job_is_invisible_to_another_owner(self):
        service = self.service(paper_tools=True)
        job_id = 'ab' * 16

        def seed(state, body):
            with state.jobs.lock:
                state.jobs.jobs[job_id] = {
                    'id': job_id, 'state': 'running', 'paperId': 'paper',
                    'fileHash': 'a' * 64, 'kind': 'ocr', 'progress': {'phase': 'starting'},
                    'fingerprint': 'f' * 64, 'cancel': threading.Event(),
                }
            return {'ok': True}

        service.paper.handlers['prepare'] = seed
        port = self.serve(service)
        status, payload = self.post(port, '/api/paper/evidence/prepare', {})
        self.assertEqual(status, 200)
        self.assertTrue(payload['ok'])
        path = '/api/paper/evidence/jobs/' + job_id
        status, payload = self.post(port, path, None)
        self.assertEqual(status, 200)
        self.assertEqual(payload['id'], job_id)
        status, payload = self.post(port, path, None, owner=OTHER)
        self.assertEqual(status, 404)
        self.assertEqual(payload['error']['code'], 'analysis_job_missing')
        status, payload = self.post(port, path + '/cancel', None, owner=OTHER)
        self.assertEqual(status, 400)
        self.assertEqual(payload['error']['code'], 'analysis_job_missing')
        status, payload = self.post(port, path, None)
        self.assertEqual(status, 200)
        self.assertEqual(payload['state'], 'running')


@unittest.skipUnless(pymupdf is not None, 'PyMuPDF is required for synthetic paper PDFs')
class PaperPdfTests(PaperCase):
    def test_prepare_query_and_table_cell_export_changes_the_pdf(self):
        port = self.serve(self.service(paper_tools=True))
        raw = table_pdf('Table 1. Merged')
        source = digest_of(raw)
        status, prepared = self.post(port, '/api/paper/evidence/prepare', {
            'fileHash': source, 'file': base64.b64encode(raw).decode('ascii'),
        })
        self.assertEqual(status, 200, prepared)
        paper_id = prepared['paperId']
        self.assertEqual(prepared['fileHash'], source)
        status, current = self.post(port, '/api/paper/evidence/query', {
            'paperId': paper_id, 'operation': 'status',
        })
        self.assertEqual(status, 200, current)
        self.assertEqual(current['paperId'], paper_id)
        status, listed = self.post(port, '/api/paper/evidence/query', {
            'paperId': paper_id, 'operation': 'list', 'kind': 'table',
        })
        self.assertEqual(status, 200, listed)
        self.assertGreaterEqual(listed['total'], 1)
        status, item = self.post(port, '/api/paper/evidence/query', {
            'paperId': paper_id, 'operation': 'item', 'itemId': listed['items'][0]['id'],
        })
        self.assertEqual(status, 200, item)
        cell = next(candidate for candidate in item['table']['cells'] if candidate['text'] == '1')
        status, rendered = self.post(port, '/api/paper/evidence/query', {
            'paperId': paper_id, 'operation': 'render', 'pageIndex': 0,
        })
        self.assertEqual(status, 200, rendered)
        self.assertEqual(rendered['mimeType'], 'image/png')
        self.assertEqual(len(rendered['sha256']), 64)
        status, exported = self.post(port, '/api/paper/visual/export', {
            'schema': 'falsify.visual-edit-request.v1',
            'paperId': paper_id,
            'fileHash': source,
            'revision': 'r1',
            'operations': [{
                'id': 'cell', 'kind': 'table-cell', 'itemId': item['id'],
                'row': cell['row'], 'column': cell['column'], 'before': '1', 'after': '-7.5',
            }],
        })
        self.assertEqual(status, 200, exported)
        output = base64.b64decode(exported['file'])
        self.assertNotEqual(exported['outputSha256'], source)
        self.assertEqual(digest_of(output), exported['outputSha256'])
        self.assertTrue(output.startswith(b'%PDF-'))
        with pymupdf.open(stream=output, filetype='pdf') as document:
            self.assertIn('-7.5', document[0].get_text())

    def test_other_owner_cannot_query_and_chart_uses_that_store(self):
        port = self.serve(self.service(paper_tools=True))
        raw = table_pdf('Owner A')
        source = digest_of(raw)
        status, prepared = self.post(port, '/api/paper/evidence/prepare', {
            'fileHash': source, 'file': base64.b64encode(raw).decode('ascii'),
        })
        self.assertEqual(status, 200, prepared)
        paper_id = prepared['paperId']
        status, payload = self.post(port, '/api/paper/evidence/query', {
            'paperId': paper_id, 'operation': 'status',
        }, owner=OTHER)
        self.assertEqual(status, 400)
        self.assertEqual(payload['error']['code'], 'paper_evidence_expired_or_missing')
        chart = {'paperId': paper_id, 'fileHash': source, 'pageIndex': 0, 'bbox': [0, 0, 0, 0]}
        status, payload = self.post(port, '/api/paper/chart/prepare', chart)
        self.assertEqual(status, 400, payload)
        self.assertEqual(payload['error']['code'], 'chart_region_invalid')
        status, payload = self.post(port, '/api/paper/chart/prepare', chart, owner=OTHER)
        self.assertEqual(status, 400, payload)
        self.assertEqual(payload['error']['code'], 'chart_source_expired')

    def test_third_paper_evicts_the_first_for_one_owner(self):
        port = self.serve(self.service(paper_tools=True))
        ids = []
        for label in ('Paper one', 'Paper two', 'Paper three'):
            raw = table_pdf(label)
            status, prepared = self.post(port, '/api/paper/evidence/prepare', {
                'fileHash': digest_of(raw), 'file': base64.b64encode(raw).decode('ascii'),
            })
            self.assertEqual(status, 200, prepared)
            ids.append(prepared['paperId'])
        status, missing = self.post(port, '/api/paper/evidence/query', {
            'paperId': ids[0], 'operation': 'status',
        })
        self.assertEqual(status, 400)
        self.assertEqual(missing['error']['code'], 'paper_evidence_expired_or_missing')
        for paper_id in ids[1:]:
            status, current = self.post(port, '/api/paper/evidence/query', {
                'paperId': paper_id, 'operation': 'status',
            })
            self.assertEqual(status, 200, current)
            self.assertEqual(current['paperId'], paper_id)

    def test_analysis_cap_returns_paper_busy(self):
        service = self.service(paper_tools=True, paper_max_analysis=2)
        port = self.serve(service)
        raw = table_pdf('Analysis cap')
        source = digest_of(raw)
        status, prepared = self.post(port, '/api/paper/evidence/prepare', {
            'fileHash': source, 'file': base64.b64encode(raw).decode('ascii'),
        })
        self.assertEqual(status, 200, prepared)
        request = {'paperId': prepared['paperId'], 'fileHash': source, 'kind': 'ocr', 'pageIndex': 0}
        state = service.paper._owners[OWNER]
        state.active_analysis = 1
        status, payload = self.post(port, '/api/paper/evidence/jobs', request)
        self.assertEqual(status, 429)
        self.assertEqual(payload['error']['code'], 'paper_busy')
        state.active_analysis = 0
        service.paper._analysis_active = 2
        status, payload = self.post(port, '/api/paper/evidence/jobs', request)
        self.assertEqual(status, 429)
        self.assertEqual(payload['error']['code'], 'paper_busy')

    def test_paper_call_does_not_wait_for_the_review_worker(self):
        runner = BlockRunner()
        service = self.service(runner, paper_tools=True, max_concurrency=1)
        service.paper.handlers['prepare'] = lambda state, body: {'ok': True}
        raw = text_pdf('The trial reported 12 events in total.')
        upload, _created = service.create_upload(OWNER, 'paper.pdf', 'application/pdf', raw)
        try:
            service.submit_job({
                'jobId': 'job-paper-0001', 'ownerId': OWNER, 'idempotencyKey': 'idem-paper-0001',
                'requestHash': 'hash-paper-0001', 'role': 'red',
                'prompt': 'Review this paper for internal contradictions.',
                'uploadId': upload['id'], 'model': MODEL, 'effort': 'high', 'useEvidence': False,
            })
            self.assertTrue(runner.started.wait(8))
            port = self.serve(service)
            status, payload = self.post(port, '/api/paper/evidence/prepare', {'n': 1}, timeout=5)
            self.assertEqual(status, 200)
            self.assertTrue(payload['ok'])
            self.assertFalse(runner.release.is_set())
        finally:
            runner.release.set()


if __name__ == '__main__':
    unittest.main()
