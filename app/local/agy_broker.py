"""Local Unix domain socket broker for operator-side ``AgyBackend`` inference.

Allows an isolated ``falsify-production`` hosted runtime (e.g. systemd
``ProtectHome=true``) to invoke the operator's persisted local ``agy`` CLI
without copying credentials into the runtime service:
- operator side always executes the local tool-disabled ``AgyBackend`` with
  fixed ``gemini-4-neon-high`` and ``high`` effort
- never accepts client-supplied command, executable, argv, cwd, env, model,
  effort, or settings
- enforces local filesystem socket permissions (never world-accessible;
  default ``0600``, or ``0660`` when ``--socket-group`` is specified)
- bounded length-prefixed JSON framing (``>I`` header + UTF-8 JSON payload)
- configurable capped concurrency (``1..15``, hard ceiling ``15``)
- per-call timeouts and immediate subprocess cancellation on client disconnect
  or broker shutdown

Launch from ``app/local`` (or with ``PYTHONPATH=app/local``)::

    python3 -m agy_broker --socket /run/falsify-agy/agy-broker.sock \\
        --socket-mode 0660 --socket-group falsify-production --max-concurrency 15
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import errno
import json
import math
import os
from pathlib import Path
import select
import signal
import socket
import stat
import struct
import sys
import threading
import time
import uuid

from agy_backend import (
    AgyBackend,
    DEFAULT_EFFORT,
    DEFAULT_MODEL,
    MAX_OUTPUT_BYTES,
    MAX_UNIX_SOCKET_PATH_BYTES,
    PROVIDER,
    SOCKET_ENV,
    _FIXED_ERRORS,
    _RETRYABLE_ERRORS,
    _prepare_schema,
    _reject_nonfinite,
    strict_json_object,
    validate_socket_path,
)

PROTOCOL = 'falsify.agy-broker.v1'
BROKER_SOCKET_ENV = 'AGY_BROKER_SOCKET'
BROKER_SOCKET_MODE_ENV = 'AGY_BROKER_SOCKET_MODE'
BROKER_SOCKET_GROUP_ENV = 'AGY_BROKER_SOCKET_GROUP'
BROKER_MAX_CONCURRENCY_ENV = 'AGY_BROKER_MAX_CONCURRENCY'
BROKER_MAX_PROMPT_CHARS_ENV = 'AGY_BROKER_MAX_PROMPT_CHARS'
BROKER_MAX_TIMEOUT_ENV = 'AGY_BROKER_MAX_TIMEOUT_SECONDS'
BROKER_MAX_REQUEST_BYTES_ENV = 'AGY_BROKER_MAX_REQUEST_BYTES'
DEFAULT_SOCKET_NAME = 'agy-broker.sock'

MAX_CONCURRENCY_CAP = 15
DEFAULT_MAX_CONCURRENCY = 15
DEFAULT_MAX_PROMPT_CHARS = 400000
DEFAULT_MAX_TIMEOUT_SECONDS = 600.0
DEFAULT_MAX_TOKENS = 32000
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_RESPONSE_BYTES = MAX_OUTPUT_BYTES
IO_TIMEOUT_SECONDS = 15.0
CONNECT_TIMEOUT_SECONDS = 5.0
POLL_INTERVAL_SECONDS = 0.05

_HEADER = struct.Struct('>I')
_INFER_KEYS = frozenset({'protocol', 'op', 'prompt', 'schema', 'timeout_seconds', 'max_tokens'})
_PING_KEYS = frozenset({'protocol', 'op'})
_UMASK_LOCK = threading.Lock()


class BrokerConfigError(ValueError):
    """Fixed-code broker configuration error; never includes credentials or prompts."""


def _parse_socket_mode(value, *, has_group=False):
    if value is None or value == '':
        return 0o660 if has_group else 0o600
    if type(value) is int:
        mode = value
    elif type(value) is str:
        raw = value.strip()
        if not raw or not all(ch in '01234567' for ch in raw.removeprefix('0o').removeprefix('0O')):
            raise BrokerConfigError('socket_mode_invalid')
        try:
            mode = int(raw, 8)
        except ValueError:
            raise BrokerConfigError('socket_mode_invalid') from None
    else:
        raise BrokerConfigError('socket_mode_invalid')
    # Owner must have rw; no world bits, no execute bits, no special bits.
    if (mode & 0o007) != 0 or (mode & 0o7111) != 0 or (mode & 0o600) != 0o600:
        raise BrokerConfigError('socket_mode_insecure')
    return mode


def _resolve_group_gid(group):
    if group is None or group == '':
        return None
    if os.name == 'nt':
        raise BrokerConfigError('unix_socket_unsupported')
    if type(group) is int:
        if group < 0:
            raise BrokerConfigError('socket_group_invalid')
        return group
    if type(group) is not str:
        raise BrokerConfigError('socket_group_invalid')
    raw = group.strip()
    if not raw:
        return None
    if raw.isdigit():
        return int(raw, 10)
    import grp
    try:
        return grp.getgrnam(raw).gr_gid
    except KeyError:
        raise BrokerConfigError('socket_group_unknown') from None


def _check_int_range(value, low, high, code):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise BrokerConfigError(code)
    return value


def _check_timeout_range(value, low, high, code):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or not low <= float(value) <= high):
        raise BrokerConfigError(code)
    return float(value)


def _env_int(env, name, default, low, high, code):
    raw = env.get(name)
    if raw is None or raw == '':
        return default
    try:
        val = int(raw, 10)
    except (TypeError, ValueError):
        raise BrokerConfigError(code) from None
    return _check_int_range(val, low, high, code)


def _env_float(env, name, default, low, high, code):
    raw = env.get(name)
    if raw is None or raw == '':
        return default
    try:
        val = float(raw)
    except (TypeError, ValueError):
        raise BrokerConfigError(code) from None
    return _check_timeout_range(val, low, high, code)


@dataclass(frozen=True)
class BrokerConfig:
    """Validated settings for the local operator-side AGY Unix socket broker."""

    socket_path: str
    socket_mode: int = 0o600
    socket_group: str | int | None = None
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY
    max_prompt_chars: int = DEFAULT_MAX_PROMPT_CHARS
    max_timeout_seconds: float = DEFAULT_MAX_TIMEOUT_SECONDS
    max_tokens: int = DEFAULT_MAX_TOKENS
    max_request_bytes: int = MAX_REQUEST_BYTES
    io_timeout_seconds: float = IO_TIMEOUT_SECONDS

    def __post_init__(self):
        try:
            normalized = validate_socket_path(self.socket_path)
        except ValueError:
            raise BrokerConfigError('socket_path_invalid') from None
        if normalized is None:
            raise BrokerConfigError('socket_path_required')
        gid = _resolve_group_gid(self.socket_group)
        mode = _parse_socket_mode(self.socket_mode, has_group=gid is not None)
        concurrency = _check_int_range(self.max_concurrency, 1, MAX_CONCURRENCY_CAP, 'max_concurrency_invalid')
        prompt_chars = _check_int_range(self.max_prompt_chars, 1, 2000000, 'max_prompt_chars_invalid')
        timeout = _check_timeout_range(self.max_timeout_seconds, 0.1, 3600.0, 'max_timeout_invalid')
        tokens = _check_int_range(self.max_tokens, 1, 128000, 'max_tokens_invalid')
        req_bytes = _check_int_range(self.max_request_bytes, 4096, MAX_REQUEST_BYTES, 'max_request_bytes_invalid')
        io_timeout = _check_timeout_range(self.io_timeout_seconds, 0.1, 120.0, 'io_timeout_invalid')
        object.__setattr__(self, 'socket_path', normalized)
        object.__setattr__(self, 'socket_mode', mode)
        object.__setattr__(self, 'max_concurrency', concurrency)
        object.__setattr__(self, 'max_prompt_chars', prompt_chars)
        object.__setattr__(self, 'max_timeout_seconds', timeout)
        object.__setattr__(self, 'max_tokens', tokens)
        object.__setattr__(self, 'max_request_bytes', req_bytes)
        object.__setattr__(self, 'io_timeout_seconds', io_timeout)

    @classmethod
    def from_env(cls, env=None):
        values = os.environ if env is None else env
        sock = (values.get(BROKER_SOCKET_ENV) or values.get(SOCKET_ENV) or '').strip()
        if not sock:
            raise BrokerConfigError('socket_path_required')
        group = (values.get(BROKER_SOCKET_GROUP_ENV) or '').strip() or None
        raw_mode = (values.get(BROKER_SOCKET_MODE_ENV) or '').strip()
        mode = _parse_socket_mode(raw_mode, has_group=group is not None)
        return cls(
            socket_path=sock,
            socket_mode=mode,
            socket_group=group,
            max_concurrency=_env_int(values, BROKER_MAX_CONCURRENCY_ENV, DEFAULT_MAX_CONCURRENCY,
                                     1, MAX_CONCURRENCY_CAP, 'max_concurrency_invalid'),
            max_prompt_chars=_env_int(values, BROKER_MAX_PROMPT_CHARS_ENV, DEFAULT_MAX_PROMPT_CHARS,
                                      1, 2000000, 'max_prompt_chars_invalid'),
            max_timeout_seconds=_env_float(values, BROKER_MAX_TIMEOUT_ENV, DEFAULT_MAX_TIMEOUT_SECONDS,
                                           0.1, 3600.0, 'max_timeout_invalid'),
            max_request_bytes=_env_int(values, BROKER_MAX_REQUEST_BYTES_ENV, MAX_REQUEST_BYTES,
                                       4096, MAX_REQUEST_BYTES, 'max_request_bytes_invalid'),
        )


def _error_payload(code):
    fixed = code if code in _FIXED_ERRORS else 'provider_error'
    status = ('timeout' if fixed == 'timeout'
              else 'budget_exhausted' if fixed == 'budget_exhausted'
              else 'cancelled' if fixed == 'cancelled'
              else 'error')
    return {
        'protocol': PROTOCOL,
        'status': status,
        'response': None,
        'usage': {},
        'provider': PROVIDER,
        'model': DEFAULT_MODEL,
        'effort': DEFAULT_EFFORT,
        'error_code': fixed,
        'error_request_id': None,
        'retryable': fixed in _RETRYABLE_ERRORS,
        'provider_model': None,
        'stop_reason': None,
        'request_id': None,
        'observed_tool_calls': 0,
        'observed_event_types': [],
        'observed_models': [],
    }


def _encode_frame(payload, max_bytes):
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False,
                         separators=(',', ':')).encode('utf-8')
    if len(encoded) > max_bytes:
        raise ValueError('output_limit')
    return _HEADER.pack(len(encoded)) + encoded


def _recv_exact(sock, count, *, deadline, cancelled=None):
    buf = bytearray()
    while len(buf) < count:
        if cancelled and cancelled():
            raise ValueError('cancelled')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('timeout')
        sock.settimeout(min(POLL_INTERVAL_SECONDS, remaining))
        try:
            chunk = sock.recv(min(65536, count - len(buf)))
        except socket.timeout:
            continue
        if not chunk:
            raise EOFError('unexpected_eof')
        buf.extend(chunk)
    return bytes(buf)


def _send_all(sock, data, *, deadline, cancelled=None):
    view = memoryview(data)
    sent = 0
    while sent < len(view):
        if cancelled and cancelled():
            raise ValueError('cancelled')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('timeout')
        sock.settimeout(min(POLL_INTERVAL_SECONDS, remaining))
        try:
            written = sock.send(view[sent:])
        except socket.timeout:
            continue
        if written <= 0:
            raise EOFError('send_closed')
        sent += written


def _read_frame(sock, max_bytes, *, deadline, cancelled=None):
    header = _recv_exact(sock, _HEADER.size, deadline=deadline, cancelled=cancelled)
    (length,) = _HEADER.unpack(header)
    if length == 0:
        raise ValueError('invalid_request')
    if length > max_bytes:
        raise ValueError('frame_too_large')
    raw = _recv_exact(sock, length, deadline=deadline, cancelled=cancelled)
    try:
        parsed = json.loads(raw.decode('utf-8', 'strict'),
                            object_pairs_hook=strict_json_object,
                            parse_constant=_reject_nonfinite)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ValueError('invalid_request') from None
    if type(parsed) is not dict:
        raise ValueError('invalid_request')
    return parsed


def _check_client_socket_permissions(socket_path):
    """Ensure target path is an existing local Unix socket with no world permission bits."""
    try:
        st = os.stat(socket_path)
    except FileNotFoundError:
        return 'transport_error'
    except PermissionError:
        return 'permission_denied'
    except OSError:
        return 'transport_error'
    if not stat.S_ISSOCK(st.st_mode):
        return 'config_error'
    if (st.st_mode & 0o007) != 0:
        return 'config_error'
    return None


def _close_quietly(sock):
    try:
        sock.close()
    except OSError:
        pass


def _unlink_quietly(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def _prepare_client_request(socket_path, payload):
    if not hasattr(socket, 'AF_UNIX'):
        return None, None, 'config_error'
    try:
        normalized = validate_socket_path(socket_path)
    except ValueError:
        return None, None, 'config_error'
    if normalized is None:
        return None, None, 'config_error'

    perm_err = _check_client_socket_permissions(normalized)
    if perm_err is not None:
        return None, None, perm_err

    try:
        frame = _encode_frame(payload, MAX_REQUEST_BYTES)
    except ValueError:
        return None, None, 'request_too_large'
    return normalized, frame, None


def _connect_client_socket(sock, normalized):
    try:
        sock.connect(normalized)
    except PermissionError:
        return 'permission_denied'
    except (TimeoutError, socket.timeout):
        return 'timeout'
    except OSError:
        return 'transport_error'
    return None


def _round_trip_socket(socket_path, payload, *, timeout_seconds, cancelled=None):
    normalized, frame, err = _prepare_client_request(socket_path, payload)
    if err is not None:
        return _error_payload(err)

    deadline = time.monotonic() + float(timeout_seconds)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        if cancelled and cancelled():
            return _error_payload('cancelled')
        sock.settimeout(min(CONNECT_TIMEOUT_SECONDS, max(0.05, deadline - time.monotonic())))
        connect_err = _connect_client_socket(sock, normalized)
        if connect_err is not None:
            return _error_payload(connect_err)

        _send_all(sock, frame, deadline=deadline, cancelled=cancelled)
        reply = _read_frame(sock, MAX_RESPONSE_BYTES, deadline=deadline, cancelled=cancelled)
        if reply.get('protocol') != PROTOCOL:
            return _error_payload('protocol_violation')
        return reply
    except ValueError as error:
        code = {'cancelled': 'cancelled', 'frame_too_large': 'output_limit'}.get(
            str(error), 'protocol_violation',
        )
        return _error_payload(code)
    except (TimeoutError, socket.timeout):
        return _error_payload('timeout')
    except (EOFError, OSError):
        return _error_payload('cancelled' if (cancelled and cancelled()) else 'transport_error')
    finally:
        _close_quietly(sock)


def infer_over_socket(socket_path, *, prompt, schema, timeout_seconds, max_tokens=DEFAULT_MAX_TOKENS,
                      cancelled=None):
    """Send one bounded inference request to the local AGY Unix socket broker."""
    payload = {
        'protocol': PROTOCOL,
        'op': 'infer',
        'prompt': prompt,
        'schema': schema,
        'timeout_seconds': float(timeout_seconds),
        'max_tokens': int(max_tokens),
    }
    return _round_trip_socket(socket_path, payload, timeout_seconds=timeout_seconds, cancelled=cancelled)


def ping_socket(socket_path, *, timeout_seconds=5.0):
    """Probe broker liveness and reported capacity over the Unix domain socket."""
    payload = {'protocol': PROTOCOL, 'op': 'ping'}
    return _round_trip_socket(socket_path, payload, timeout_seconds=timeout_seconds)


def _probe_socket_alive(socket_path):
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.settimeout(0.2)
        probe.connect(socket_path)
        return True
    except OSError as error:
        if error.errno in (errno.ECONNREFUSED, errno.ENOENT):
            return False
        # EACCES or other error means we cannot safely assume the socket is stale.
        return True
    finally:
        try:
            probe.close()
        except OSError:
            pass


def _prepare_socket_path(socket_path):
    parent = Path(socket_path).parent
    if not parent.exists():
        parent.mkdir(parents=True, mode=0o750, exist_ok=True)
    if not parent.is_dir():
        raise BrokerConfigError('socket_parent_not_dir')

    try:
        existing = os.lstat(socket_path)
    except FileNotFoundError:
        return parent
    if not stat.S_ISSOCK(existing.st_mode):
        raise BrokerConfigError('socket_path_not_socket')
    if _probe_socket_alive(socket_path):
        raise BrokerConfigError('socket_in_use')
    try:
        os.unlink(socket_path)
    except OSError:
        raise BrokerConfigError('socket_unlink_failed') from None
    return parent


def _bind_unix_socket(socket_path, mode, gid):
    if not hasattr(socket, 'AF_UNIX'):
        raise BrokerConfigError('unix_socket_unsupported')
    parent = _prepare_socket_path(socket_path)

    tmp_path = str(parent / ('.agy-broker-%d-%s.sock' % (os.getpid(), uuid.uuid4().hex[:8])))
    use_atomic = len(tmp_path.encode('utf-8')) <= MAX_UNIX_SOCKET_PATH_BYTES
    bind_target = tmp_path if use_atomic else socket_path

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        with _UMASK_LOCK:
            old_umask = os.umask(0o177)
            try:
                srv.bind(bind_target)
            finally:
                os.umask(old_umask)
        os.chmod(bind_target, mode)
        if gid is not None:
            os.chown(bind_target, -1, gid)
        if use_atomic:
            os.replace(tmp_path, socket_path)
        srv.listen(32)
        st = os.lstat(socket_path)
        return srv, (st.st_dev, st.st_ino)
    except BaseException:
        _close_quietly(srv)
        _unlink_quietly(bind_target)
        raise


def _monitor_disconnect(conn, future, cancel_event, shutdown_event):
    """Watch client socket while inference runs; set cancel_event on disconnect or protocol violation."""
    poller = select.poll()
    read_mask = select.POLLIN | select.POLLHUP | select.POLLERR | select.POLLNVAL
    hup_only_mask = select.POLLHUP | select.POLLERR | select.POLLNVAL
    poller.register(conn.fileno(), read_mask)
    half_closed = False
    while not future.done():
        if shutdown_event.is_set():
            cancel_event.set()
            return True
        try:
            events = poller.poll(int(POLL_INTERVAL_SECONDS * 1000))
        except OSError:
            cancel_event.set()
            return True
        for _fd, mask in events:
            if mask & (select.POLLHUP | select.POLLERR | select.POLLNVAL):
                cancel_event.set()
                return True
            if not half_closed and (mask & select.POLLIN):
                try:
                    peeked = conn.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
                except BlockingIOError:
                    continue
                except OSError:
                    cancel_event.set()
                    return True
                if peeked:
                    # Unexpected trailing client data on a single-request socket.
                    cancel_event.set()
                    return True
                # Client performed half-close (shutdown(SHUT_WR)); stay alive until POLLHUP.
                half_closed = True
                poller.modify(conn.fileno(), hup_only_mask)
    return cancel_event.is_set() or shutdown_event.is_set()


class AgyBrokerServer:
    """Operator-side Unix socket inference broker backed by local tool-disabled ``AgyBackend``."""

    def __init__(self, config, *, backend_factory=None):
        if not isinstance(config, BrokerConfig):
            raise TypeError('BrokerConfig required')
        self.config = config
        self._gid = _resolve_group_gid(config.socket_group)
        self._backend_factory = backend_factory
        self._shutdown = threading.Event()
        self._closed = False
        self._state_lock = threading.Lock()
        self._active = 0
        self._infer_slots = threading.BoundedSemaphore(config.max_concurrency)
        self._conn_slots = threading.BoundedSemaphore(config.max_concurrency + 16)
        self._conn_threads = set()
        self._executor = ThreadPoolExecutor(
            max_workers=config.max_concurrency,
            thread_name_prefix='falsify-agy-broker',
        )
        try:
            self._sock, self._sock_identity = _bind_unix_socket(
                config.socket_path, config.socket_mode, self._gid,
            )
            self._sock.settimeout(0.25)
        except BaseException:
            self._executor.shutdown(wait=False, cancel_futures=True)
            raise

    @property
    def active_inferences(self):
        with self._state_lock:
            return self._active

    def _build_backend(self, *, timeout_seconds, max_tokens, cancelled):
        kwargs = {
            'max_calls': 1,
            'timeout_seconds': timeout_seconds,
            'max_prompt_chars': self.config.max_prompt_chars,
            'model': DEFAULT_MODEL,
            'effort': DEFAULT_EFFORT,
            'max_tokens': max_tokens,
            'max_images': 1,
            'cancelled': cancelled,
            # Explicitly force local CLI mode on operator side so broker never recurses.
            'socket_path': '',
        }
        if self._backend_factory is not None:
            return self._backend_factory(**kwargs)
        return AgyBackend(**kwargs)

    def _validate_request(self, req):
        if req.get('protocol') != PROTOCOL:
            return None, 'protocol_violation'
        op = req.get('op', 'infer')
        if op == 'ping':
            if set(req) - _PING_KEYS:
                return None, 'invalid_request'
            return {'op': 'ping'}, None
        if op != 'infer':
            return None, 'invalid_request'
        if set(req) - _INFER_KEYS:
            return None, 'invalid_request'

        prompt = req.get('prompt')
        if type(prompt) is not str or not 1 <= len(prompt) <= self.config.max_prompt_chars:
            return None, 'prompt_limit'

        schema = req.get('schema')
        _, _, schema_err = _prepare_schema(schema)
        if schema_err is not None:
            return None, schema_err

        raw_timeout = req.get('timeout_seconds', self.config.max_timeout_seconds)
        if (isinstance(raw_timeout, bool) or not isinstance(raw_timeout, (int, float))
                or not math.isfinite(raw_timeout) or not 0 < float(raw_timeout) <= 3600.0):
            return None, 'invalid_request'
        timeout_seconds = min(float(raw_timeout), self.config.max_timeout_seconds)

        raw_tokens = req.get('max_tokens', self.config.max_tokens)
        if type(raw_tokens) is not int or not 1 <= raw_tokens <= 128000:
            return None, 'invalid_request'
        max_tokens = min(raw_tokens, self.config.max_tokens)

        return {
            'op': 'infer',
            'prompt': prompt,
            'schema': schema,
            'timeout_seconds': timeout_seconds,
            'max_tokens': max_tokens,
        }, None

    def _run_infer(self, parsed, is_cancelled):
        backend = self._build_backend(
            timeout_seconds=parsed['timeout_seconds'],
            max_tokens=parsed['max_tokens'],
            cancelled=is_cancelled,
        )
        result = backend.infer(parsed['prompt'], parsed['schema'])
        if not isinstance(result, dict):
            return _error_payload('provider_error')
        reply = {
            'protocol': PROTOCOL,
            'status': result.get('status', 'error'),
            'response': result.get('response'),
            'usage': result.get('usage') if isinstance(result.get('usage'), dict) else {},
            'provider': PROVIDER,
            'model': DEFAULT_MODEL,
            'effort': DEFAULT_EFFORT,
            'error_code': result.get('error_code'),
            'error_request_id': None,
            'retryable': bool(result.get('retryable', False)),
            'provider_model': result.get('provider_model'),
            'stop_reason': result.get('stop_reason'),
            'request_id': result.get('request_id'),
            'observed_tool_calls': result.get('observed_tool_calls', 0),
            'observed_event_types': result.get('observed_event_types', []),
            'observed_models': result.get('observed_models', []),
        }
        if 'retry_after' in result:
            reply['retry_after'] = result['retry_after']
        return reply

    def _send_reply(self, conn, payload):
        try:
            frame = _encode_frame(payload, MAX_RESPONSE_BYTES)
        except ValueError:
            frame = _encode_frame(_error_payload('output_limit'), MAX_RESPONSE_BYTES)
        deadline = time.monotonic() + self.config.io_timeout_seconds
        try:
            _send_all(conn, frame, deadline=deadline, cancelled=self._shutdown.is_set)
        except (OSError, EOFError, TimeoutError, ValueError):
            pass

    def _handle_connection(self, conn):
        try:
            io_deadline = time.monotonic() + self.config.io_timeout_seconds
            try:
                req = _read_frame(conn, self.config.max_request_bytes,
                                  deadline=io_deadline, cancelled=self._shutdown.is_set)
            except ValueError as error:
                code = str(error)
                if code == 'frame_too_large':
                    self._send_reply(conn, _error_payload('request_too_large'))
                elif code != 'cancelled':
                    self._send_reply(conn, _error_payload('invalid_request'))
                return
            except (TimeoutError, socket.timeout):
                self._send_reply(conn, _error_payload('timeout'))
                return
            except (EOFError, OSError):
                return

            parsed, err = self._validate_request(req)
            if err is not None:
                self._send_reply(conn, _error_payload(err))
                return

            if parsed['op'] == 'ping':
                self._send_reply(conn, {
                    'protocol': PROTOCOL,
                    'status': 'ok',
                    'provider': PROVIDER,
                    'model': DEFAULT_MODEL,
                    'effort': DEFAULT_EFFORT,
                    'max_concurrency': self.config.max_concurrency,
                    'active': self.active_inferences,
                })
                return

            if not self._infer_slots.acquire(blocking=False):
                self._send_reply(conn, _error_payload('overloaded'))
                return

            cancel_event = threading.Event()
            is_cancelled = lambda: cancel_event.is_set() or self._shutdown.is_set()
            with self._state_lock:
                self._active += 1
            try:
                try:
                    future = self._executor.submit(self._run_infer, parsed, is_cancelled)
                except RuntimeError:
                    self._send_reply(conn, _error_payload('overloaded'))
                    return
                disconnected = _monitor_disconnect(conn, future, cancel_event, self._shutdown)
                try:
                    reply = future.result()
                except Exception:
                    reply = _error_payload('provider_error')
                if not disconnected and not self._shutdown.is_set():
                    self._send_reply(conn, reply)
            finally:
                with self._state_lock:
                    self._active -= 1
                self._infer_slots.release()
        finally:
            try:
                conn.close()
            except OSError:
                pass
            self._conn_slots.release()
            with self._state_lock:
                self._conn_threads.discard(threading.current_thread())

    def serve_forever(self):
        while not self._shutdown.is_set():
            try:
                conn, _ = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                if self._shutdown.is_set():
                    break
                continue
            if not self._conn_slots.acquire(blocking=False):
                try:
                    conn.close()
                except OSError:
                    pass
                continue
            thread = threading.Thread(target=self._handle_connection, args=(conn,), daemon=True)
            with self._state_lock:
                self._conn_threads.add(thread)
            thread.start()

    def close(self):
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
        self._shutdown.set()
        try:
            self._sock.close()
        except OSError:
            pass
        self._executor.shutdown(wait=True, cancel_futures=True)
        with self._state_lock:
            threads = list(self._conn_threads)
        for thread in threads:
            if thread is not threading.current_thread():
                thread.join(timeout=2.0)
        try:
            st = os.lstat(self.config.socket_path)
            if (st.st_dev, st.st_ino) == self._sock_identity:
                os.unlink(self.config.socket_path)
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


def serve(config, *, backend_factory=None):
    server = AgyBrokerServer(config, backend_factory=backend_factory)
    previous = {}

    def _stop(_signum, _frame):
        server._shutdown.set()

    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                previous[sig] = signal.signal(sig, _stop)
            except (ValueError, OSError):
                pass
    try:
        server.serve_forever()
    finally:
        for sig, handler in previous.items():
            try:
                signal.signal(sig, handler)
            except (ValueError, OSError):
                pass
        server.close()


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog='python3 -m agy_broker',
        description='Local Unix socket inference broker for operator-side AgyBackend (fixed gemini-4-neon-high, high effort).',
    )
    parser.add_argument(
        '--socket', default=None,
        help=f'Absolute Unix socket path (default env {BROKER_SOCKET_ENV} or {SOCKET_ENV})',
    )
    parser.add_argument(
        '--socket-mode', default=None,
        help=f'Octal socket permission mode without world bits, e.g. 0600 or 0660 (default env {BROKER_SOCKET_MODE_ENV})',
    )
    parser.add_argument(
        '--socket-group', default=None,
        help=f'Optional Unix group name or gid for socket chgrp (default env {BROKER_SOCKET_GROUP_ENV})',
    )
    parser.add_argument(
        '--max-concurrency', type=int, default=None,
        help=f'Max concurrent AGY inferences, 1..{MAX_CONCURRENCY_CAP} (default {DEFAULT_MAX_CONCURRENCY}, env {BROKER_MAX_CONCURRENCY_ENV})',
    )
    parser.add_argument(
        '--max-prompt-chars', type=int, default=None,
        help=f'Max prompt characters per call, 1..2000000 (default {DEFAULT_MAX_PROMPT_CHARS}, env {BROKER_MAX_PROMPT_CHARS_ENV})',
    )
    parser.add_argument(
        '--max-timeout-seconds', type=float, default=None,
        help=f'Max timeout seconds per call, 1..3600 (default {int(DEFAULT_MAX_TIMEOUT_SECONDS)}, env {BROKER_MAX_TIMEOUT_ENV})',
    )
    args = parser.parse_args(argv)
    env = dict(os.environ)
    if args.socket is not None:
        env[BROKER_SOCKET_ENV] = args.socket
    if args.socket_mode is not None:
        env[BROKER_SOCKET_MODE_ENV] = args.socket_mode
    if args.socket_group is not None:
        env[BROKER_SOCKET_GROUP_ENV] = args.socket_group
    if args.max_concurrency is not None:
        env[BROKER_MAX_CONCURRENCY_ENV] = str(args.max_concurrency)
    if args.max_prompt_chars is not None:
        env[BROKER_MAX_PROMPT_CHARS_ENV] = str(args.max_prompt_chars)
    if args.max_timeout_seconds is not None:
        env[BROKER_MAX_TIMEOUT_ENV] = str(args.max_timeout_seconds)
    try:
        config = BrokerConfig.from_env(env)
    except BrokerConfigError as error:
        print('broker configuration error: %s' % error, file=sys.stderr)
        return 2
    print(
        'agy broker listening on %s (mode=%04o, max_concurrency=%d, model=%s, effort=%s)'
        % (config.socket_path, config.socket_mode, config.max_concurrency, DEFAULT_MODEL, DEFAULT_EFFORT),
        flush=True,
    )
    try:
        serve(config)
    except BrokerConfigError as error:
        print('broker startup error: %s' % error, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
