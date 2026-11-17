"""Container-internal HTTP API for the hosted runtime (stdlib only)."""

from __future__ import annotations

import argparse
import dataclasses
import hmac
import json
import os
import re
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from .config import RuntimeConfig
from .service import OWNER_RE, RuntimeService, ServiceError

JOB_PATH = re.compile(r'/internal/v1/jobs/([A-Za-z0-9][A-Za-z0-9_:-]{0,127})')
CANCEL_PATH = re.compile(r'/internal/v1/jobs/([A-Za-z0-9][A-Za-z0-9_:-]{0,127})/cancel')
ARTIFACT_PATH = re.compile(
    r'/internal/v1/jobs/([A-Za-z0-9][A-Za-z0-9_:-]{0,127})/artifacts/'
    r'([A-Za-z0-9][A-Za-z0-9_-]{0,127})')
UPLOADS_PATH = '/internal/v1/uploads'
JOBS_PATH = '/internal/v1/jobs'
HEALTH_PATH = '/internal/v1/health'
JSON_LIMIT = 1 << 20


def _no_duplicates(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def _no_constant(_value):
    raise ValueError('non-finite JSON number')


def _json_body(raw):
    if not raw:
        raise ServiceError('invalid_request', 400)
    try:
        value = json.loads(raw.decode('utf-8', 'strict'),
                           object_pairs_hook=_no_duplicates,
                           parse_constant=_no_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ServiceError('invalid_request', 400) from None
    if not isinstance(value, dict):
        raise ServiceError('invalid_request', 400)
    return value


def _safe_filename(name):
    if not isinstance(name, str) or not name:
        return 'artifact'
    cleaned = ''.join(ch for ch in name if 32 <= ord(ch) < 127 and ch not in '"\\;')
    return cleaned or 'artifact'


class _Handler(BaseHTTPRequestHandler):
    server_version = 'FalsifyRuntime/1'
    sys_version = ''
    protocol_version = 'HTTP/1.1'

    # Never log paths, query strings, prompts, paper text or tokens.
    def log_message(self, fmt, *args):
        return

    # ------------------------------------------------------------------ responses
    def _reply(self, status, payload, mime='application/json; charset=utf-8', extra=None):
        raw = payload if isinstance(payload, (bytes, bytearray)) else \
            json.dumps(payload, ensure_ascii=False, sort_keys=True,
                       separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(raw)

    def _error(self, error):
        self.close_connection = True
        body = {'error': {'code': error.code, 'message': error.message}}
        if error.retryable is not None:
            body['error']['retryable'] = bool(error.retryable)
        self._reply(error.status, body)

    # ----------------------------------------------------------------------- auth
    def _token_ok(self):
        values = self.headers.get_all('X-Falsify-Service-Token') or []
        if len(values) != 1:
            return False
        try:
            presented = values[0].encode('utf-8', 'surrogatepass')
        except UnicodeEncodeError:
            return False
        return hmac.compare_digest(presented, self.server.service_token_bytes)

    def _authenticate(self):
        if self._token_ok():
            return True
        self._error(ServiceError('unauthorized', 401))
        return False

    def _owner(self):
        values = self.headers.get_all('X-Falsify-Owner-Id') or []
        if len(values) != 1 or not OWNER_RE.fullmatch(values[0]):
            raise ServiceError('unauthorized', 401)
        return values[0]

    # ----------------------------------------------------------------------- body
    def _read_body(self, limit, allow_missing=False):
        if self.headers.get_all('Transfer-Encoding'):
            self.close_connection = True
            raise ServiceError('invalid_request', 400)
        lengths = self.headers.get_all('Content-Length') or []
        if not lengths:
            if allow_missing:
                return b''
            self.close_connection = True
            raise ServiceError('invalid_request', 400)
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            self.close_connection = True
            raise ServiceError('invalid_request', 400)
        size = int(lengths[0], 10)
        if size > limit:
            self.close_connection = True
            raise ServiceError('payload_too_large', 413)
        raw = self.rfile.read(size) if size else b''
        if len(raw) != size:
            self.close_connection = True
            raise ServiceError('invalid_request', 400)
        return raw

    def _path(self):
        return unquote(urlsplit(self.path).path)

    # ----------------------------------------------------------------------- GET
    def do_GET(self):
        if not self._authenticate():
            return
        try:
            owner = self._owner()
            path = self._path()
            if path == HEALTH_PATH:
                self._reply(200, self.server.service.health())
                return
            match = JOB_PATH.fullmatch(path)
            if match:
                self._reply(200, self.server.service.get_job(owner, match.group(1)))
                return
            match = ARTIFACT_PATH.fullmatch(path)
            if match:
                meta, data = self.server.service.get_artifact(owner, match.group(1),
                                                              match.group(2))
                self._reply(200, data, mime=meta['mime'], extra={
                    'Content-Disposition':
                        'attachment; filename="%s"' % _safe_filename(meta['name']),
                })
                return
            raise ServiceError('not_found', 404)
        except ServiceError as error:
            self._error(error)
        except Exception:
            self._error(ServiceError('internal_error', 500))

    # ---------------------------------------------------------------------- POST
    def do_POST(self):
        if not self._authenticate():
            return
        try:
            owner = self._owner()
            path = self._path()
            if path == UPLOADS_PATH:
                self._upload(owner)
                return
            if path == JOBS_PATH:
                self._submit(owner)
                return
            match = CANCEL_PATH.fullmatch(path)
            if match:
                raw = self._read_body(65536, allow_missing=True)
                if raw.strip():
                    raise ServiceError('invalid_request', 400)
                self._reply(200, self.server.service.cancel_job(owner, match.group(1)))
                return
            raise ServiceError('not_found', 404)
        except ServiceError as error:
            self._error(error)
        except Exception:
            self._error(ServiceError('internal_error', 500))

    def _upload(self, owner):
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if set(query) - {'name', 'mime'}:
            raise ServiceError('invalid_request', 400)
        names = query.get('name') or []
        mimes = query.get('mime') or []
        if len(names) != 1 or len(mimes) != 1:
            raise ServiceError('invalid_request', 400)
        raw = self._read_body(self.server.service.config.max_upload_bytes)
        upload, created = self.server.service.create_upload(owner, names[0], mimes[0], raw)
        self._reply(201 if created else 200, {'upload': upload})

    def _submit(self, owner):
        content_type = (self.headers.get('Content-Type') or '').split(';', 1)[0].strip().lower()
        if content_type != 'application/json':
            raise ServiceError('invalid_request', 400)
        raw = self._read_body(JSON_LIMIT)
        body = _json_body(raw)
        snapshot, replayed = self.server.service.submit_job(body, owner)
        self._reply(200 if replayed else 202, snapshot)

    # ------------------------------------------------------------ other methods
    def do_HEAD(self):
        self._method_not_allowed()

    def _method_not_allowed(self):
        self._error(ServiceError('method_not_allowed', 405))

    def __getattr__(self, name):
        if name.startswith('do_'):
            return self._method_not_allowed
        raise AttributeError(name)


class RuntimeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32
    allow_reuse_address = os.name != 'nt'

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def create_server(service, host=None, port=None):
    if not isinstance(service, RuntimeService):
        raise TypeError('RuntimeService required')
    host = service.config.bind_host if host is None else host
    port = service.config.bind_port if port is None else port
    server = RuntimeHTTPServer((host, port), _Handler)
    server.service = service
    server.service_token_bytes = service.config.service_token.encode('utf-8')
    return server


def serve(config):
    if not isinstance(config, RuntimeConfig):
        raise TypeError('RuntimeConfig required')
    service = RuntimeService(config)
    server = create_server(service)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        service.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Falsify hosted AI runtime (internal API)')
    parser.add_argument('--bind', default=None, help='bind host (default HOSTED_AI_BIND)')
    parser.add_argument('--port', type=int, default=None, help='bind port (default HOSTED_AI_PORT)')
    parser.add_argument('--state-dir', default=None, help='state directory override')
    args = parser.parse_args(argv)
    try:
        config = RuntimeConfig.from_env()
    except ValueError as error:
        print('configuration error: %s' % error)
        return 2
    changes = {}
    if args.bind is not None:
        changes['bind_host'] = args.bind
    if args.port is not None:
        changes['bind_port'] = args.port
    if args.state_dir is not None:
        changes['state_dir'] = args.state_dir
    if changes:
        config = dataclasses.replace(config, **changes)
    print('hosted runtime listening on %s:%d' % (config.bind_host, config.bind_port))
    serve(config)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
