import base64
import http.client
import json
from pathlib import Path
import struct
import sys
import threading
import unittest
from unittest.mock import patch
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import layout_agent_service as service
import server

def request():
    return {'schema': service.REQUEST_SCHEMA, 'consent': True, 'projectId': 'a' * 64,
            'step': 0, 'maxSteps': 12, 'instruction': 'Improve layout', 'tools': list(service.TOOLS),
            'observations': [], 'images': [], 'sourceFiles': [{'path': 'main.tex', 'text': 'hello'}]}

def action():
    return {'tool': 'finish', 'path': '', 'before': '', 'after': '', 'pages': [], 'message': 'done'}

def png():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b'\x00\xff\xff\xff')) + chunk(b'IEND', b''))

class FakeBackend:
    instances = []
    def __init__(self, **kwargs):
        self.kwargs, self.calls, self.argv = kwargs, 0, []
        self.transport = self.run
        self.instances.append(self)
    def run(self, argv, **kwargs):
        self.argv.append(argv)
        image_path = Path(argv[argv.index('--image') + 1])
        assert image_path.read_bytes() == png()
        return {}
    def infer(self, prompt, schema):
        self.calls += 1
        self.prompt = prompt
        if '"pageIndex": 2' in prompt: self.transport(['codex', 'exec'])
        return {'status': 'ok', 'response': action()}

class ServiceTests(unittest.TestCase):
    def test_existing_codex_transport_disables_tools_and_sends_image(self):
        calls = []
        def transport(argv, **kwargs):
            calls.append(argv)
            if 'login' in argv: return {'returncode': 0, 'stdout': 'Logged in using ChatGPT'}
            self.assertEqual(Path(argv[argv.index('--image') + 1]).read_bytes(), png())
            events = [{'type': 'item.completed', 'item': {'type': 'agent_message', 'text': json.dumps(action())}},
                      {'type': 'turn.completed', 'usage': {}}]
            return {'returncode': 0, 'stdout': '\n'.join(map(json.dumps, events))}
        data = request(); data['images'] = [{'pageIndex': 2, 'mime': 'image/png', 'base64': base64.b64encode(png()).decode()}]
        def factory(**kwargs):
            return service.CodexBackend(transport=transport, executable=['codex-test'], skill_folders=[], **kwargs)
        service.decide(service.validate_request(data), backend_factory=factory)
        self.assertEqual(len(calls), 2)  # one local login check, one model decision
        command = calls[1]
        self.assertIn('features.shell_tool=false', command)
        self.assertIn('features.view_image=false', command)
        self.assertIn('--ignore-user-config', command)
        self.assertIn('--image', command)

    def test_single_decision_and_image_transport(self):
        data = request(); data['images'] = [{'pageIndex': 2, 'mime': 'image/png', 'base64': base64.b64encode(png()).decode()}]
        result = service.decide(service.validate_request(data), backend_factory=FakeBackend)
        backend = FakeBackend.instances[-1]
        self.assertEqual(backend.calls, 1)
        self.assertEqual(backend.kwargs['max_calls'], 1)
        self.assertEqual(result['action'], action())
        self.assertEqual(result['step'], 0)
        self.assertEqual(len(result['skillHash']), 64)
        self.assertFalse(Path(backend.argv[0][backend.argv[0].index('--image') + 1]).exists())
        for term in ('read_source', 'replace_source', 'compile_pdf', 'inspect_pdf', 'render_pages', 'finish',
                     'TASK INSTRUCTION', 'DOCUMENT AND TOOL DATA', 'at most four', 'selected RED edits'):
            self.assertIn(term, backend.prompt)
        self.assertIn('Improve layout', backend.prompt)

    def test_request_rejections(self):
        service.validate_request({**request(), 'sourceFiles': [{'path': '논문 폴더/Main.TEX', 'text': 'hello'}]})
        bad = [dict(consent=False), dict(step=12), dict(projectId='x'), dict(sourceFiles=[{'path': '../secret.tex', 'text': ''}]),
               dict(sourceFiles=[{'path': 'C:/secret.tex', 'text': ''}]), dict(images=[{'pageIndex': 0, 'mime': 'image/jpeg', 'base64': ''}]),
               dict(images=[{'pageIndex': 0, 'mime': 'image/png', 'base64': base64.b64encode(png()[:-1]).decode()}])]
        for change in bad:
            with self.subTest(change=change), self.assertRaises(ValueError): service.validate_request({**request(), **change})

    def test_invalid_response_and_no_retry(self):
        class Bad(FakeBackend):
            def infer(self, prompt, schema):
                self.calls += 1
                return {'status': 'ok', 'response': {**action(), 'tool': 'read_source', 'path': '../secret.tex'}}
        with self.assertRaises(service.LayoutAgentError) as ctx:
            service.decide(service.validate_request(request()), backend_factory=Bad)
        self.assertEqual(ctx.exception.code, 'invalid_action')
        self.assertEqual(Bad.instances[-1].calls, 1)

    def test_action_schema_and_runtime_limits(self):
        from jsonschema import Draft202012Validator
        validator = Draft202012Validator(service.ACTION_SCHEMA)
        self.assertTrue(validator.is_valid(action()))
        for bad in ({**action(), 'tool': 'shell'}, {**action(), 'pages': [0, 1, 2, 3, 4]},
                    {**action(), 'extra': ''}, {k: v for k, v in action().items() if k != 'message'}):
            self.assertFalse(validator.is_valid(bad))
            with self.assertRaises(service.LayoutAgentError): service._action(bad, {'main.tex'})
        for pages in ([0, 0], [500], [True]):
            with self.assertRaises(service.LayoutAgentError): service._action({**action(), 'pages': pages}, {'main.tex'})
        self.assertEqual(service._action({**action(), 'pages': [0, 1, 2, 3]}, {'main.tex'})['pages'], [0, 1, 2, 3])

    def test_fixed_errors_do_not_expose_provider_diagnostics(self):
        for status, code, expected in [('timeout', 'secret token', 'model_timeout'),
                                      ('error', 'chatgpt_login_required', 'cli_login_required'),
                                      ('error', 'secret token', 'model_failed')]:
            class Bad(FakeBackend):
                def infer(self, prompt, schema): return {'status': status, 'error_code': code, 'diagnostics': 'private'}
            with self.assertRaises(service.LayoutAgentError) as ctx:
                service.decide(service.validate_request(request()), backend_factory=Bad)
            payload = ctx.exception.payload()
            self.assertEqual(payload['error'], expected)
            self.assertTrue(payload['message'])
            self.assertNotIn('secret', json.dumps(payload)); self.assertNotIn('private', json.dumps(payload))

class HttpTests(unittest.TestCase):
    def test_auth_cors_admission_and_response(self):
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        httpd.web_origin = 'https://example.com'
        thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
        def post(body, token=True):
            conn = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=5)
            headers = {'Origin': httpd.web_origin, 'Content-Type': 'application/json'}
            if token: headers['Authorization'] = 'Bearer ' + server.TOKEN
            conn.request('POST', server.LAYOUT_AGENT_ROUTE, json.dumps(body), headers)
            response = conn.getresponse(); result = (response.status, dict(response.getheaders()), json.loads(response.read())); conn.close(); return result
        try:
            self.assertEqual(post(request(), False)[0], 403)
            with patch.object(service, 'decide', return_value={'ok': True}) as call:
                status, headers, body = post(request())
                self.assertEqual((status, body), (200, {'ok': True}))
                self.assertEqual(headers['Access-Control-Allow-Origin'], httpd.web_origin)
                self.assertEqual(call.call_count, 1)
                self.assertEqual(post({**request(), 'consent': False})[0], 400)
                self.assertEqual(call.call_count, 1)
                status, _, body = post({**request(), 'instruction': 'x' * 8001})
                self.assertEqual((status, body['error']), (400, 'request_limit'))
                self.assertIn('Reduce', body['message'])
                self.assertEqual(call.call_count, 1)
                server.ACTIVE.acquire()
                try: self.assertEqual(post(request())[0], 409)
                finally: server.ACTIVE.release()
        finally:
            httpd.shutdown(); thread.join(); httpd.server_close()

    def test_http_json_and_schema_regressions(self):
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        httpd.web_origin = 'https://example.com'
        thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
        def call(raw, *, origin='https://example.com', content_type='application/json', method='POST'):
            conn = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=5)
            headers = {'Origin': origin, 'Content-Type': content_type, 'Authorization': 'Bearer ' + server.TOKEN}
            if method == 'OPTIONS': headers['Access-Control-Request-Method'] = 'POST'; headers['Access-Control-Request-Headers'] = 'authorization,content-type'
            conn.request(method, server.LAYOUT_AGENT_ROUTE, raw, headers)
            response = conn.getresponse(); status, body = response.status, response.read(); conn.close(); return status, body
        try:
            with patch.object(service, 'decide') as decide:
                self.assertEqual(call(b'', method='OPTIONS')[0], 204)
                self.assertEqual(call(b'{}', origin='https://other.example')[0], 403)
                self.assertEqual(call(b'{}', content_type='text/plain')[0], 400)
                for raw in (b'{', b'{"schema":1,"schema":2}', b'{"n":NaN}', b'[]', json.dumps({**request(), 'extra': 1}).encode()):
                    with self.subTest(raw=raw): self.assertEqual(call(raw)[0], 400)
                conn = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=5)
                conn.putrequest('POST', server.LAYOUT_AGENT_ROUTE)
                for key, value in {'Origin': httpd.web_origin, 'Content-Type': 'application/json',
                                   'Authorization': 'Bearer ' + server.TOKEN, 'Content-Length': str(6 * 1024 * 1024 + 1)}.items():
                    conn.putheader(key, value)
                conn.endheaders(); response = conn.getresponse(); payload = json.loads(response.read()); conn.close()
                self.assertEqual((response.status, payload['error']), (400, 'request_limit'))
                self.assertEqual(decide.call_count, 0)
            for code in ('model_timeout', 'cli_login_required'):
                with patch.object(service, 'decide', side_effect=service.LayoutAgentError(code)):
                    status, raw = call(json.dumps(request()).encode())
                    payload = json.loads(raw)
                    self.assertEqual(status, 502); self.assertEqual(payload['error'], code); self.assertTrue(payload['message'])
            decide = service.decide
            with patch.object(service, 'decide', side_effect=lambda validated: decide(validated, backend_factory=FakeBackend)):
                status, raw = call(json.dumps(request()).encode())
                response = json.loads(raw)
                self.assertEqual(status, 200)
                self.assertEqual(set(response), {'schema', 'projectId', 'step', 'action', 'model', 'skillHash'})
                self.assertEqual(response['schema'], service.RESPONSE_SCHEMA)
                self.assertEqual((response['projectId'], response['step'], response['action']), ('a' * 64, 0, action()))
        finally:
            httpd.shutdown(); thread.join(); httpd.server_close()

class LayoutAgentLargeProjectTests(unittest.TestCase):
    def test_source_index_accepts_more_than_64_bounded_files(self):
        data = request()
        data['sourceFiles'] = [{'path': f'part-{i}.tex', 'text': 'Evidence 12.'} for i in range(100)]
        checked = service.validate_request(data)
        self.assertEqual(len(checked['paths']), 100)

if __name__ == '__main__': unittest.main()
