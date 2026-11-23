"""Tests for the local Unix domain socket AGY inference broker and client integration."""

import json
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

import pymupdf

import agy_backend
import agy_broker
from agy_backend import AgyBackend, DEFAULT_EFFORT, DEFAULT_MODEL, PROVIDER, SOCKET_ENV
from agy_broker import (
    AgyBrokerServer,
    BrokerConfig,
    BrokerConfigError,
    MAX_CONCURRENCY_CAP,
    PROTOCOL,
    _HEADER,
    infer_over_socket,
    ping_socket,
)
from hosted_runtime import RuntimeConfig, RuntimeService, ServiceError

SCHEMA = {
    'type': 'object',
    'properties': {
        'status': {'type': 'string', 'enum': ['ok', 'abstain', 'refusal']},
        'items': {'type': 'array', 'items': {'type': 'string'}, 'minItems': 1, 'maxItems': 3},
    },
    'required': ['status', 'items'],
    'additionalProperties': False,
}

OWNER = 'usr:33333333-3333-3333-3333-333333333333'
TOKEN = 'broker-test-service-token-0123456789'


def _synthetic_pdf(text):
    doc = pymupdf.open()
    try:
        page = doc.new_page()
        page.insert_text((72, 72), text, fontsize=11)
        return doc.tobytes()
    finally:
        doc.close()


def _agy_stream(response_obj, *, conversation_id='conv-broker-1', model=DEFAULT_MODEL):
    text = json.dumps(response_obj, separators=(',', ':'))
    events = [
        {'event': 'init', 'conversation_id': conversation_id,
         'init': {'cwd': '/tmp/empty', 'permission_mode': 'strict', 'model': model}},
        {'event': 'step_update', 'step_update': {
            'conversation_id': conversation_id, 'step_index': 1, 'state': 'DONE',
            'step_type': 'agent_response', 'text_delta': text,
            'usage': {'input_tokens': 100, 'output_tokens': 25, 'thinking_tokens': 10,
                      'cache_read_tokens': 40, 'total_tokens': 125},
        }},
        {'event': 'result', 'result': {
            'conversation_id': conversation_id, 'status': 'SUCCESS', 'num_turns': 1,
            'response': text, 'structured_output': response_obj,
            'usage': {'input_tokens': 100, 'output_tokens': 25, 'thinking_tokens': 10,
                      'cache_read_tokens': 40, 'total_tokens': 125},
        }},
    ]
    return {'returncode': 0, 'stdout': '\n'.join(json.dumps(e) for e in events) + '\n', 'stderr': ''}


def _raw_round_trip(socket_path, raw_bytes):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(5.0)
        conn.connect(socket_path)
        conn.sendall(raw_bytes)
        header = conn.recv(4)
        if not header:
            return None
        (length,) = _HEADER.unpack(header)
        buf = bytearray()
        while len(buf) < length:
            chunk = conn.recv(length - len(buf))
            if not chunk:
                break
            buf.extend(chunk)
        return json.loads(buf.decode('utf-8'))


def _start_broker(config, *, backend_factory=None):
    server = AgyBrokerServer(config, backend_factory=backend_factory)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


@unittest.skipUnless(hasattr(socket, 'AF_UNIX'), 'AF_UNIX required')
class BrokerConfigAndPermissionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='agy-brk-')
        self.addCleanup(self._tmp.cleanup)
        self.sock_path = os.path.join(self._tmp.name, 'agy-broker.sock')

    def test_config_bounds_and_concurrency_cap_15(self):
        cfg = BrokerConfig(socket_path=self.sock_path)
        self.assertEqual(cfg.max_concurrency, 15)
        self.assertEqual(cfg.socket_mode, 0o600)

        cfg15 = BrokerConfig(socket_path=self.sock_path, max_concurrency=MAX_CONCURRENCY_CAP, socket_mode=0o660)
        self.assertEqual(cfg15.max_concurrency, 15)
        self.assertEqual(cfg15.socket_mode, 0o660)

        for bad in (
            {'socket_path': 'relative.sock'},
            {'socket_path': ''},
            {'socket_path': self.sock_path, 'max_concurrency': 0},
            {'socket_path': self.sock_path, 'max_concurrency': 16},
            {'socket_path': self.sock_path, 'max_concurrency': True},
            {'socket_path': self.sock_path, 'socket_mode': 0o666},
            {'socket_path': self.sock_path, 'socket_mode': 0o777},
            {'socket_path': self.sock_path, 'socket_mode': 0o604},
            {'socket_path': self.sock_path, 'socket_mode': 0o700},
            {'socket_path': self.sock_path, 'socket_mode': '0666'},
            {'socket_path': self.sock_path, 'max_timeout_seconds': 0},
            {'socket_path': self.sock_path, 'max_timeout_seconds': 3601},
        ):
            with self.subTest(bad=bad), self.assertRaises(BrokerConfigError):
                BrokerConfig(**bad)

    def test_socket_permissions_stale_cleanup_and_in_use_protection(self):
        cfg = BrokerConfig(socket_path=self.sock_path, socket_mode=0o660, max_concurrency=4)
        server, thread = _start_broker(cfg)
        try:
            st = os.lstat(self.sock_path)
            self.assertTrue(stat.S_ISSOCK(st.st_mode))
            self.assertEqual(stat.S_IMODE(st.st_mode), 0o660)

            ping = ping_socket(self.sock_path)
            self.assertEqual(ping['status'], 'ok')
            self.assertEqual(ping['provider'], PROVIDER)
            self.assertEqual(ping['model'], DEFAULT_MODEL)
            self.assertEqual(ping['effort'], DEFAULT_EFFORT)
            self.assertEqual(ping['max_concurrency'], 4)

            # A second broker must fail closed with socket_in_use while the first is live.
            with self.assertRaisesRegex(BrokerConfigError, '^socket_in_use$'):
                AgyBrokerServer(cfg)
        finally:
            server.close()
            thread.join(timeout=3.0)
        self.assertFalse(os.path.exists(self.sock_path))

        # Refuse to unlink a regular file or symlink at the socket path.
        regular = os.path.join(self._tmp.name, 'regular.sock')
        Path(regular).write_text('not a socket', encoding='utf-8')
        with self.assertRaisesRegex(BrokerConfigError, '^socket_path_not_socket$'):
            AgyBrokerServer(BrokerConfig(socket_path=regular))
        self.assertTrue(os.path.isfile(regular))

        link = os.path.join(self._tmp.name, 'link.sock')
        os.symlink(regular, link)
        with self.assertRaisesRegex(BrokerConfigError, '^socket_path_not_socket$'):
            AgyBrokerServer(BrokerConfig(socket_path=link))

        # Stale socket (not listening) is safely replaced.
        stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stale.bind(self.sock_path)
        stale.close()
        server2, thread2 = _start_broker(BrokerConfig(socket_path=self.sock_path, socket_mode=0o600))
        try:
            self.assertEqual(stat.S_IMODE(os.lstat(self.sock_path).st_mode), 0o600)
            self.assertEqual(ping_socket(self.sock_path)['status'], 'ok')
        finally:
            server2.close()
            thread2.join(timeout=3.0)

    def test_client_refuses_world_accessible_or_non_socket_path(self):
        cfg = BrokerConfig(socket_path=self.sock_path, socket_mode=0o600)
        server, thread = _start_broker(cfg)
        try:
            os.chmod(self.sock_path, 0o666)
            engine = AgyBackend(1, 10, 10000, socket_path=self.sock_path)
            res = engine.infer('Check.', SCHEMA)
            self.assertEqual((res['status'], res['error_code'], res['retryable']),
                             ('error', 'config_error', False))
        finally:
            server.close()
            thread.join(timeout=3.0)

        regular = os.path.join(self._tmp.name, 'file.sock')
        Path(regular).write_text('hello', encoding='utf-8')
        res = AgyBackend(1, 10, 10000, socket_path=regular).infer('Check.', SCHEMA)
        self.assertEqual((res['status'], res['error_code']), ('error', 'config_error'))


@unittest.skipUnless(hasattr(socket, 'AF_UNIX'), 'AF_UNIX required')
class BrokerInferenceAndSafetyTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='agy-brk-')
        self.addCleanup(self._tmp.cleanup)
        self.sock_path = os.path.join(self._tmp.name, 'agy-broker.sock')

    def test_operator_side_always_uses_local_tool_disabled_agy_backend_without_recursion(self):
        seen_cmds = []
        seen_cwds = []

        def fake_transport(cmd, *, cwd, env, stdin, timeout_seconds, max_output_bytes, cancelled=None):
            seen_cmds.append(list(cmd))
            seen_cwds.append((cwd, list(Path(cwd).iterdir())))
            return _agy_stream({'status': 'ok', 'items': ['verified']})

        def operator_factory(**kwargs):
            # Verify broker ALWAYS forces local mode (socket_path='') and fixed model/effort.
            self.assertEqual(kwargs['model'], DEFAULT_MODEL)
            self.assertEqual(kwargs['effort'], DEFAULT_EFFORT)
            self.assertEqual(kwargs['socket_path'], '')
            return AgyBackend(
                **kwargs,
                transport=fake_transport,
                executable=['/usr/local/bin/agy'],
            )

        cfg = BrokerConfig(socket_path=self.sock_path, max_concurrency=4)
        # Even if HOSTED_AI_AGY_SOCKET is set in the process env, operator broker must NOT recurse.
        with patch.dict(os.environ, {SOCKET_ENV: self.sock_path}):
            server, thread = _start_broker(cfg, backend_factory=operator_factory)
            try:
                client = AgyBackend(2, 30, 10000, model=DEFAULT_MODEL, effort=DEFAULT_EFFORT)
                self.assertEqual(client.socket_path, self.sock_path)
                self.assertEqual(client.capability_config.get('transport'), 'unix_socket')
                res = client.infer('Inspect this paper claim.', SCHEMA)
                self.assertEqual(res['status'], 'ok', res)
                self.assertEqual(res['response'], {'status': 'ok', 'items': ['verified']})
                self.assertEqual(res['provider'], PROVIDER)
                self.assertEqual(res['provider_model'], DEFAULT_MODEL)
                self.assertEqual(res['observed_tool_calls'], 0)
                self.assertEqual(res['usage']['input_tokens'], 100)
                self.assertEqual(res['usage']['output_tokens'], 25)
                self.assertEqual(len(seen_cmds), 1)
                cmd = seen_cmds[0]
                self.assertEqual(cmd[cmd.index('--model') + 1], DEFAULT_MODEL)
                self.assertEqual(cmd[cmd.index('--effort') + 1], DEFAULT_EFFORT)
                self.assertIn('--disable-slash-commands', cmd)
                settings = json.loads(cmd[cmd.index('--settings') + 1])
                self.assertEqual(settings['toolPermission'], 'strict')
                self.assertEqual(seen_cwds[0][1], [])

                # Visual inference still fails closed without touching the broker.
                vis = client.infer_visual('Inspect image', SCHEMA, [b'\x89PNG\r\n\x1a\n' + b'0' * 32])
                self.assertEqual((vis['status'], vis['error_code']), ('error', 'invalid_request'))
                self.assertEqual(len(seen_cmds), 1)
            finally:
                server.close()
                thread.join(timeout=3.0)

    def test_rejects_client_supplied_command_cwd_model_effort_and_oversized_frames(self):
        called = []

        def factory(**kwargs):
            called.append(kwargs)
            return AgyBackend(**kwargs, executable=['/usr/local/bin/agy'])

        cfg = BrokerConfig(socket_path=self.sock_path, max_request_bytes=4096, max_prompt_chars=200)
        server, thread = _start_broker(cfg, backend_factory=factory)
        try:
            for extra_key, extra_val in (
                ('command', ['/bin/sh', '-c', 'id']),
                ('executable', '/bin/sh'),
                ('cwd', '/etc'),
                ('env', {'PATH': '/tmp'}),
                ('model', 'claude-opus-5-5'),
                ('effort', 'low'),
                ('settings', {'toolPermission': 'auto'}),
            ):
                body = json.dumps({
                    'protocol': PROTOCOL,
                    'op': 'infer',
                    'prompt': 'hello',
                    'schema': SCHEMA,
                    extra_key: extra_val,
                }).encode('utf-8')
                reply = _raw_round_trip(self.sock_path, _HEADER.pack(len(body)) + body)
                self.assertEqual(reply['error_code'], 'invalid_request', extra_key)

            # Frame length header exceeding max_request_bytes is rejected immediately.
            reply = _raw_round_trip(self.sock_path, _HEADER.pack(cfg.max_request_bytes + 1))
            self.assertEqual(reply['error_code'], 'request_too_large')

            # Prompt exceeding max_prompt_chars rejected.
            body = json.dumps({
                'protocol': PROTOCOL, 'op': 'infer', 'prompt': 'x' * 201, 'schema': SCHEMA,
            }).encode('utf-8')
            reply = _raw_round_trip(self.sock_path, _HEADER.pack(len(body)) + body)
            self.assertEqual(reply['error_code'], 'prompt_limit')

            # Invalid schema rejected.
            body = json.dumps({
                'protocol': PROTOCOL, 'op': 'infer', 'prompt': 'hi', 'schema': {'type': 'not-a-type'},
            }).encode('utf-8')
            reply = _raw_round_trip(self.sock_path, _HEADER.pack(len(body)) + body)
            self.assertEqual(reply['error_code'], 'schema_limit')

            self.assertEqual(called, [])
        finally:
            server.close()
            thread.join(timeout=3.0)

    def test_concurrency_cap_enforced_and_overflow_returns_retryable_overloaded(self):
        slots = 15
        entered = threading.Barrier(slots + 1, timeout=10.0)
        release = threading.Event()
        active_peak = {'current': 0, 'peak': 0}
        lock = threading.Lock()

        class BlockingBackend:
            def __init__(self, **kwargs):
                self.cancelled = kwargs.get('cancelled')

            def infer(self, prompt, schema):
                with lock:
                    active_peak['current'] += 1
                    active_peak['peak'] = max(active_peak['peak'], active_peak['current'])
                try:
                    entered.wait()
                    release.wait(timeout=10.0)
                    return {
                        'status': 'ok',
                        'response': {'status': 'ok', 'items': ['done']},
                        'usage': {'input_tokens': 5, 'output_tokens': 2},
                        'provider': PROVIDER,
                        'model': DEFAULT_MODEL,
                        'effort': DEFAULT_EFFORT,
                        'error_code': None,
                        'retryable': False,
                        'provider_model': DEFAULT_MODEL,
                        'observed_tool_calls': 0,
                        'observed_event_types': ['init', 'result'],
                        'observed_models': [DEFAULT_MODEL],
                    }
                finally:
                    with lock:
                        active_peak['current'] -= 1

        cfg = BrokerConfig(socket_path=self.sock_path, max_concurrency=slots)
        server, thread = _start_broker(cfg, backend_factory=BlockingBackend)
        try:
            results = {}

            def worker(idx):
                engine = AgyBackend(1, 10, 10000, socket_path=self.sock_path)
                results[idx] = engine.infer(f'call-{idx}', SCHEMA)

            workers = [threading.Thread(target=worker, args=(idx,)) for idx in range(slots)]
            for client in workers:
                client.start()
            entered.wait()

            # Ping still succeeds while all inference slots are busy.
            ping = ping_socket(self.sock_path)
            self.assertEqual((ping['status'], ping['active'], ping['max_concurrency']), ('ok', slots, slots))

            # A request beyond the configured limit fails fast with retryable overloaded.
            overflow = AgyBackend(1, 10, 10000, socket_path=self.sock_path).infer('overflow', SCHEMA)
            self.assertEqual((overflow['status'], overflow['error_code'], overflow['retryable']),
                             ('error', 'overloaded', True))

            release.set()
            for client in workers:
                client.join(timeout=5.0)
            self.assertEqual(len(results), slots)
            self.assertTrue(all(result['status'] == 'ok' for result in results.values()))
            self.assertEqual(active_peak['peak'], slots)
        finally:
            release.set()
            server.close()
            thread.join(timeout=3.0)

    def test_timeout_and_cancellation_on_disconnect_kills_real_subprocess(self):
        pid_file = Path(self._tmp.name) / 'child.pid'
        sleeper_script = (
            'import os, sys, time; '
            f'open({str(pid_file)!r}, "w").write(str(os.getpid())); '
            'time.sleep(30)'
        )

        class RealSubprocessAgy(AgyBackend):
            def command(self, executable, schema_arg):
                return [sys.executable, '-c', sleeper_script]

        def factory(**kwargs):
            return RealSubprocessAgy(**kwargs, executable=[sys.executable])

        cfg = BrokerConfig(socket_path=self.sock_path, max_concurrency=1, max_timeout_seconds=10.0)
        server, thread = _start_broker(cfg, backend_factory=factory)
        try:
            cancel_flag = threading.Event()
            threading.Timer(0.25, cancel_flag.set).start()
            t0 = time.monotonic()
            res = AgyBackend(1, 10, 10000, socket_path=self.sock_path,
                             cancelled=cancel_flag.is_set).infer('sleep', SCHEMA)
            elapsed = time.monotonic() - t0
            self.assertEqual((res['status'], res['error_code'], res['retryable']),
                             ('cancelled', 'cancelled', False))
            self.assertLess(elapsed, 3.0)

            # Wait briefly for broker to kill subprocess and free slot.
            deadline = time.monotonic() + 3.0
            while server.active_inferences > 0 and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(server.active_inferences, 0)
            if pid_file.exists():
                child_pid = int(pid_file.read_text().strip())
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)

            # Client timeout also kills the subprocess and frees the slot.
            pid_file.unlink(missing_ok=True)
            t1 = time.monotonic()
            timed_out = AgyBackend(1, 0.25, 10000, socket_path=self.sock_path).infer('sleep', SCHEMA)
            self.assertEqual((timed_out['status'], timed_out['error_code'], timed_out['retryable']),
                             ('timeout', 'timeout', True))
            self.assertLess(time.monotonic() - t1, 3.0)
            deadline = time.monotonic() + 3.0
            while server.active_inferences > 0 and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(server.active_inferences, 0)
        finally:
            server.close()
            thread.join(timeout=3.0)

    def test_executable_python_m_agy_broker_launch_and_sigterm_cleanup(self):
        env = dict(os.environ)
        env['PYTHONPATH'] = str(LOCAL)
        proc = subprocess.Popen(
            [
                sys.executable, '-m', 'agy_broker',
                '--socket', self.sock_path,
                '--socket-mode', '0660',
                '--max-concurrency', '15',
            ],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 5.0
            while not os.path.exists(self.sock_path) and time.monotonic() < deadline:
                self.assertIsNone(proc.poll(), 'broker exited prematurely')
                time.sleep(0.02)
            self.assertTrue(os.path.exists(self.sock_path))
            self.assertEqual(stat.S_IMODE(os.lstat(self.sock_path).st_mode), 0o660)
            ping = ping_socket(self.sock_path)
            self.assertEqual((ping['status'], ping['max_concurrency'], ping['model'], ping['effort']),
                             ('ok', 15, DEFAULT_MODEL, DEFAULT_EFFORT))
            proc.send_signal(signal.SIGTERM)
            rc = proc.wait(timeout=5.0)
            self.assertEqual(rc, 0)
            self.assertFalse(os.path.exists(self.sock_path))
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5.0)
            for stream in (proc.stdout, proc.stderr):
                if stream:
                    stream.close()

    def test_end_to_end_runtime_service_blue_over_unix_socket_broker(self):
        state_dir = Path(self._tmp.name) / 'runtime-state'
        finding_reply = {'status': 'ok', 'findings': []}

        def fake_transport(cmd, *, cwd, env, stdin, timeout_seconds, max_output_bytes, cancelled=None):
            return _agy_stream(finding_reply, conversation_id='conv-e2e-1')

        def operator_factory(**kwargs):
            return AgyBackend(**kwargs, transport=fake_transport, executable=['/usr/local/bin/agy'])

        cfg = BrokerConfig(socket_path=self.sock_path, socket_mode=0o600, max_concurrency=4)
        server, thread = _start_broker(cfg, backend_factory=operator_factory)
        try:
            models = ('claude-opus-5-5', DEFAULT_MODEL)
            env = {'HOSTED_AI_MODELS': ','.join(models)}
            with patch.dict(os.environ, env, clear=True):
                rconfig = RuntimeConfig(
                    state_dir=state_dir,
                    service_token=TOKEN,
                    models=models,
                    default_model='claude-opus-5-5',
                    agy_socket=self.sock_path,
                    job_retention_seconds=0,
                    bind_port=0,
                )
                service = RuntimeService(rconfig)
                self.addCleanup(service.close)
                upload, _ = service.create_upload(
                    OWNER, 'paper.pdf', 'application/pdf',
                    _synthetic_pdf('Methods report n = 40; Results report n = 40.'),
                )
                # RED defaults still reject gemini-4-neon-high and preserve default claude-opus-5-5.
                with self.assertRaises(ServiceError):
                    service.submit_job({
                        'jobId': 'job-red-agy-reject', 'ownerId': OWNER,
                        'idempotencyKey': 'idem-red-agy-reject', 'requestHash': 'hash-red-agy',
                        'role': 'red', 'prompt': 'Check paper.', 'uploadId': upload['id'],
                        'model': DEFAULT_MODEL, 'effort': 'high', 'useEvidence': False,
                    })
                # BLUE with gemini-4-neon-high + high effort routes through the Unix socket broker.
                snap, _ = service.submit_job({
                    'jobId': 'job-blue-agy-sock', 'ownerId': OWNER,
                    'idempotencyKey': 'idem-blue-agy-sock', 'requestHash': 'hash-blue-agy',
                    'role': 'blue', 'prompt': 'Check internal consistency.', 'uploadId': upload['id'],
                    'model': DEFAULT_MODEL, 'effort': 'high', 'useEvidence': False,
                })
                deadline = time.monotonic() + 10.0
                done = None
                while time.monotonic() < deadline:
                    cur = service.get_job(OWNER, snap['id'])
                    if cur['state'] in ('completed', 'failed', 'cancelled', 'interrupted'):
                        done = cur
                        break
                    time.sleep(0.02)
                self.assertIsNotNone(done)
                self.assertEqual(done['state'], 'completed', done)
                self.assertEqual(done['provider'], PROVIDER)
                self.assertEqual(done['result']['provider']['id'], PROVIDER)
                self.assertEqual(done['result']['provider']['models'], [DEFAULT_MODEL])
                self.assertEqual(done['result']['hostedSelection'],
                                 {'provider': PROVIDER, 'model': DEFAULT_MODEL, 'effort': 'high'})
                self.assertEqual(done['usage']['inputTokens'], 100)
                self.assertEqual(done['usage']['outputTokens'], 25)
                artifact_names = [a['name'] for a in done['artifacts']]
                self.assertEqual(artifact_names, ['extracted.json', 'review.json'])
        finally:
            server.close()
            thread.join(timeout=3.0)


if __name__ == '__main__':
    unittest.main()
