"""Bounded prompt-only local Antigravity CLI (``agy``) backend for hosted BLUE.

Runs real local ``agy`` with its persisted OAuth session in headless NDJSON
streaming mode (``--input-format stream-json --output-format stream-json``):
- fresh empty working directory and independent conversation per call
- external model API keys and provider switches stripped from the environment
- strict session-only ``--settings`` denying all tools, commands, files, URLs,
  and MCP servers, plus ``--disable-slash-commands``
- prompt sent only via stdin; structured output enforced via ``--json-schema``
  and validated locally against Draft 2020-12 JSON Schema
- zero internal retries; fixed error codes align with hosted retry behavior
- observed token usage (including thinking and cache tokens when reported)
  without ever inferring counts from prompt length or leaking CLI diagnostics
- ``infer_visual`` fails closed and never silently drops supplied images
- optionally routes inference over a local Unix domain socket broker
  (``HOSTED_AI_AGY_SOCKET`` or ``socket_path``) when the hosted runtime runs
  under an isolated service account (e.g. ``ProtectHome=true``) without copying
  operator credentials
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

_REPO_ROOT = str(Path(__file__).resolve().parents[2])
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from cli_backend import _search_path
from experiments.selfplay_codex import strict_json_object

PROVIDER = 'agy-cli'
DEFAULT_MODEL = 'gemini-4-neon-high'
DEFAULT_EFFORT = 'high'
SOCKET_ENV = 'HOSTED_AI_AGY_SOCKET'
MAX_UNIX_SOCKET_PATH_BYTES = 107
MAX_IMAGES = 64
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_SCHEMA_BYTES = 65536
MAX_INLINE_SCHEMA_BYTES = 32768

MODEL_PATTERN = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}', re.ASCII)
_EVENT_NAME_RE = re.compile(r'[a-z][a-z0-9_]{0,63}', re.ASCII)
_STOP_REASON_RE = re.compile(r'[a-z0-9][a-z0-9_.-]{0,63}', re.ASCII)
_CODE_FENCE_RE = re.compile(r'^\s*```(?:json)?\s*\n(.*?)\n?\s*```\s*$', re.DOTALL | re.IGNORECASE)
_RETRY_AFTER_RE = re.compile(r'retry[- ]after[:\s]+(\d{1,5})\b', re.IGNORECASE)

_BLOCKED_ENV_PREFIXES = (
    'ANTHROPIC_', 'CLAUDE_', 'CLAUDECODE', 'OPENAI_', 'CODEX_',
    'GEMINI_', 'GOOGLE_API', 'GOOGLE_GENAI', 'GOOGLE_CLOUD_API',
    'VERTEX_', 'AWS_', 'STACKBITE_', 'FALSIFY_', 'HOSTED_AI_', 'CLOUDFLARE_',
    'AGY_BROKER_', 'GOOGLE_APPLICATION_CREDENTIALS',
)

_STRICT_NO_TOOLS_SETTINGS = {
    'toolPermission': 'strict',
    'agentMode': '',
    'allowNonWorkspaceAccess': False,
    'disableSlashCommands': True,
    'useG1Credits': False,
    'modelProvider': '',
    'permissions': {
        'allow': [],
        'ask': [],
        'deny': [
            'command(*)',
            'read_file(*)',
            'write_file(*)',
            'read_url(*)',
            'execute_url(*)',
            'mcp(*)',
        ],
    },
}
_STRICT_SETTINGS_JSON = json.dumps(_STRICT_NO_TOOLS_SETTINGS, separators=(',', ':'), ensure_ascii=True)

_FIXED_ERRORS = frozenset({
    'prompt_limit', 'schema_limit', 'output_limit', 'response_not_object',
    'protocol_violation', 'auth_required', 'permission_denied', 'invalid_request',
    'request_too_large', 'rate_limited', 'overloaded', 'provider_error',
    'transport_error', 'timeout', 'cancelled', 'budget_exhausted', 'config_error',
})
_RETRYABLE_ERRORS = frozenset({'rate_limited', 'overloaded', 'provider_error', 'transport_error', 'timeout'})

_AUTH_PHRASES = (
    'authentication required', 'authentication_required', 'authentication_failed',
    'not authenticated', 'not logged in', 'login required', 'please sign in',
    'sign in required', 'unauthorized', 'invalid credentials', 'oauth', '401',
)
_QUOTA_PHRASES = (
    'quota', 'rate limit', 'rate_limit', 'resource_exhausted', 'resource exhausted',
    'usage limit', 'hit your limit', '5-hour limit', 'five-hour limit',
    'weekly limit', 'daily limit', 'hourly limit', 'too many requests',
    'credits exhausted', 'credit balance', 'exhausted', '429',
)
_OVERLOADED_PHRASES = ('overloaded', 'capacity', 'service unavailable', '503', 'temporarily unavailable')
_REFUSAL_REASONS = frozenset({
    'refusal', 'safety', 'recitation', 'blocklist', 'prohibited_content',
    'spii', 'content_filter', 'policy_violation',
})
_INTERRUPTION_STATUSES = frozenset({'INTERRUPTED', 'CANCELED', 'CANCELLED'})
_INTERRUPTION_REASONS = frozenset({'interrupted', 'canceled', 'cancelled', 'sigint', 'sigterm'})
_TOOL_DENIAL_PHRASES = (
    'headless mode cannot prompt for', 'was auto-denied',
    'tool permission denied', 'denied by permission rule',
)

_PROMPT_GUARDRAIL = (
    'Answer directly from the provided input without calling any tools, '
    'reading files, running commands, or spawning subagents. '
    'Return ONLY valid JSON matching the enforced schema.'
)


def _kill_tree(process):
    if process.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=10, check=False, creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        import signal
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.kill()
    except OSError:
        pass
    process.wait(timeout=10)


def _cleanup_process(process, stop, threads):
    stop.set()
    _kill_tree(process)
    for pipe in (process.stdin, process.stdout, process.stderr):
        if pipe and not pipe.closed:
            pipe.close()
    for thread in threads:
        thread.join(timeout=0.2)


def _drain_chunks(chunks, *, command, deadline, max_output_bytes, capture_stderr, cancelled):
    output, diagnostics = bytearray(), bytearray()
    total, closed = 0, 0
    while closed < 2:
        if cancelled and cancelled():
            raise ValueError('cancelled')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('timeout')
        try:
            name, block = chunks.get(timeout=min(0.1, remaining))
        except queue.Empty:
            continue
        if block is None:
            closed += 1
            continue
        total += len(block)
        if total > max_output_bytes:
            raise ValueError('output_limit')
        if name == 'stdout' or command[-2:] == ['login', 'status']:
            output.extend(block)
        elif capture_stderr:
            diagnostics.extend(block)
    return output, diagnostics


def bounded_cli_transport(command, *, cwd, env, stdin, timeout_seconds, max_output_bytes,
                          capture_stderr=True, cancelled=None):
    """Drain stdout/stderr with bounded chunks and kill the process tree on limit, timeout, or cancel."""
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
        **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt'
           else {'start_new_session': True}),
    )
    chunks = queue.Queue(maxsize=8)
    stop = threading.Event()

    def read(pipe, name):
        try:
            while not stop.is_set():
                block = pipe.read(4096)
                if not block:
                    break
                while not stop.is_set():
                    try:
                        chunks.put((name, block), timeout=0.05)
                        break
                    except queue.Full:
                        pass
        finally:
            while not stop.is_set():
                try:
                    chunks.put((name, None), timeout=0.05)
                    break
                except queue.Full:
                    pass

    def write():
        try:
            process.stdin.write(stdin.encode('utf-8'))
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    threads = [
        threading.Thread(target=read, args=(process.stdout, 'stdout'), daemon=True),
        threading.Thread(target=read, args=(process.stderr, 'stderr'), daemon=True),
        threading.Thread(target=write, daemon=True),
    ]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + timeout_seconds
    try:
        output, diagnostics = _drain_chunks(
            chunks,
            command=command,
            deadline=deadline,
            max_output_bytes=max_output_bytes,
            capture_stderr=capture_stderr,
            cancelled=cancelled,
        )
        process.wait(timeout=max(0.001, deadline - time.monotonic()))
        result = {'returncode': process.returncode, 'stdout': output.decode('utf-8', errors='strict')}
        if capture_stderr:
            result['stderr'] = diagnostics.decode('utf-8', errors='replace')
        return result
    finally:
        _cleanup_process(process, stop, threads)


_DEFAULT_TRANSPORT = bounded_cli_transport


def discover_agy():
    """Locate the local ``agy`` binary via absolute PATH entries and ``~/.local/bin``."""
    entries = _search_path()
    launcher = shutil.which('agy', path=os.pathsep.join(entries))
    if not launcher:
        raise FileNotFoundError('agy_unavailable')
    resolved = Path(launcher).absolute()
    if not any(resolved.parent == Path(entry).absolute() for entry in entries):
        raise FileNotFoundError('agy_unavailable')
    return [str(resolved)]


def clean_environment():
    """Keep persisted AGY OAuth session paths while dropping external model keys/providers."""
    env = {}
    for key, value in os.environ.items():
        upper = key.upper()
        if 'API_KEY' in upper or 'AUTH_TOKEN' in upper or 'SECRET_KEY' in upper:
            continue
        if upper.startswith(_BLOCKED_ENV_PREFIXES):
            continue
        env[key] = value
    if sys.platform == 'darwin':
        env['PATH'] = os.pathsep.join(_search_path())
    return env


def validate_socket_path(value):
    """Validate an optional absolute Unix domain socket path; returns str or None."""
    if value is None or value == '' or value is False:
        return None
    if isinstance(value, Path):
        raw = str(value)
    elif type(value) is str:
        raw = value.strip()
    else:
        raise ValueError('config_error')
    if not raw:
        return None
    if any(ord(ch) < 32 for ch in raw) or not Path(raw).is_absolute():
        raise ValueError('config_error')
    encoded = raw.encode('utf-8')
    if len(encoded) > MAX_UNIX_SOCKET_PATH_BYTES:
        raise ValueError('config_error')
    return raw


def _reject_nonfinite(_token):
    raise ValueError('nonfinite_response')


def _nonneg_int(value):
    return value if type(value) is int and value >= 0 else None


def _valid_model(value):
    if type(value) is str:
        stripped = value.strip()
        if stripped and MODEL_PATTERN.fullmatch(stripped):
            return stripped
    return None


def _safe_stop_reason(value):
    if type(value) is str:
        norm = value.strip().lower()
        if _STOP_REASON_RE.fullmatch(norm):
            return norm
    return None


def _hash_id(value):
    if type(value) is str and value.strip():
        return hashlib.sha256(value.strip().encode('utf-8')).hexdigest()[:16]
    return None


def _first_nonneg_int(raw, *keys):
    for key in keys:
        val = _nonneg_int(raw.get(key))
        if val is not None:
            return val
    return None


def _compute_input_tokens(raw_in, raw_cr, raw_cc, raw_out, raw_total):
    in_val, cr_val, cc_val, out_val = raw_in or 0, raw_cr or 0, raw_cc or 0, raw_out or 0
    if cr_val == 0 and cc_val == 0:
        return in_val
    if cr_val > in_val or (
        raw_total is not None and raw_total == in_val + cr_val + cc_val + out_val and cr_val > 0
    ):
        return in_val + cr_val + cc_val
    return in_val + cc_val


def _parse_usage_entry(raw):
    """Parse one AGY usage dict; never infers tokens or fabricates zeros for omitted fields."""
    if not isinstance(raw, dict) or not raw:
        return None
    raw_in = _nonneg_int(raw.get('input_tokens'))
    raw_out = _nonneg_int(raw.get('output_tokens'))
    raw_think = _nonneg_int(raw.get('thinking_tokens'))
    raw_cr = _first_nonneg_int(raw, 'cache_read_tokens', 'cache_read_input_tokens')
    raw_cc = _first_nonneg_int(raw, 'cache_creation_tokens', 'cache_creation_input_tokens')
    raw_total = _nonneg_int(raw.get('total_tokens'))
    if (raw_in, raw_out, raw_think, raw_cr, raw_cc, raw_total) == (None,) * 6:
        return None

    usage = {}
    if (raw_in, raw_cr, raw_cc) != (None, None, None):
        usage['input_tokens'] = _compute_input_tokens(raw_in, raw_cr, raw_cc, raw_out, raw_total)
    if raw_out is not None:
        usage['output_tokens'] = raw_out + raw_think if (raw_think is not None and raw_think > raw_out) else raw_out
    for key, val in (
        ('thinking_tokens', raw_think),
        ('cache_read_input_tokens', raw_cr),
        ('cache_creation_input_tokens', raw_cc),
        ('total_tokens', raw_total),
    ):
        if val is not None:
            usage[key] = val
    return usage


def _reconcile_usage(final, step_usages):
    final_usage = _parse_usage_entry(final.get('usage') if isinstance(final, dict) else None)
    if final_usage:
        return final_usage
    if not step_usages:
        return {}
    parsed = [_parse_usage_entry(item) for item in step_usages]
    if any(entry is None for entry in parsed):
        return {}
    totals = {}
    for key in ('input_tokens', 'output_tokens', 'thinking_tokens',
                'cache_read_input_tokens', 'cache_creation_input_tokens', 'total_tokens'):
        if all(key in entry for entry in parsed):
            totals[key] = sum(entry[key] for entry in parsed)
    return totals


def _record_conversation_id(state, value):
    if state['conversation_id'] is None and isinstance(value, str) and value.strip():
        state['conversation_id'] = value.strip()


def _record_model(state, value):
    model = _valid_model(value)
    if model and model not in state['observed_models']:
        state['observed_models'].append(model)


def _is_tool_step(su):
    tname = su.get('tool_name')
    return (
        su.get('step_type') in ('tool', 'subagent', 'mcp_tool')
        or (isinstance(tname, str) and bool(tname.strip()))
        or (isinstance(su.get('tool_info'), dict) and bool(su['tool_info']))
        or (isinstance(su.get('subagent_info'), dict) and bool(su['subagent_info']))
    )


def _parse_init_event(event, state):
    payload = event.get('init')
    if not isinstance(payload, dict):
        state['protocol_error'] = True
        return
    state['init'] = payload
    _record_model(state, payload.get('model'))
    pm = payload.get('permission_mode')
    if isinstance(pm, str) and pm.strip():
        state['permission_mode'] = pm.strip()
    mcp_servers = payload.get('mcp_servers')
    if isinstance(mcp_servers, list) and mcp_servers:
        state['mcp_observed'] = True
    tools = payload.get('tools')
    if isinstance(tools, list):
        if any(isinstance(name, str) and (name.startswith('mcp__') or name.startswith('mcp/')) for name in tools):
            state['mcp_observed'] = True


def _parse_step_event(event, state):
    su = event.get('step_update')
    if not isinstance(su, dict):
        state['protocol_error'] = True
        return
    _record_conversation_id(state, su.get('conversation_id'))
    _record_model(state, su.get('model'))
    if _is_tool_step(su):
        state['observed_tool_calls'] += 1
    delta = su.get('text_delta')
    if isinstance(delta, str) and delta:
        state['text_deltas'].append(delta)
    if su.get('state') == 'DONE' and su.get('step_type') == 'agent_response':
        su_usage = su.get('usage')
        state['agent_step_usages'].append(su_usage if isinstance(su_usage, dict) else {})


def _parse_result_event(event, state):
    if state['final'] is not None:
        state['protocol_error'] = True
    payload = event.get('result')
    if not isinstance(payload, dict):
        state['protocol_error'] = True
        return
    state['final'] = payload
    _record_conversation_id(state, payload.get('conversation_id'))
    _record_model(state, payload.get('model'))
    denials = payload.get('permission_denials')
    if denials:
        state['observed_tool_calls'] += len(denials) if isinstance(denials, list) else 1
    qinfo = payload.get('quota_info') or payload.get('rate_limit_info')
    if isinstance(qinfo, dict):
        state['quota_info'] = qinfo


def _parse_stream(stdout):
    state = {
        'init': None, 'final': None, 'conversation_id': None,
        'event_types': [], 'observed_models': [], 'text_deltas': [],
        'agent_step_usages': [], 'observed_tool_calls': 0,
        'mcp_observed': False, 'permission_mode': None,
        'protocol_error': False, 'quota_info': None,
    }
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line, object_pairs_hook=strict_json_object, parse_constant=_reject_nonfinite)
        except ValueError:
            state['protocol_error'] = True
            continue
        if type(event) is not dict:
            state['protocol_error'] = True
            continue
        ev_name = event.get('event')
        if type(ev_name) is not str or not _EVENT_NAME_RE.fullmatch(ev_name):
            state['protocol_error'] = True
            continue
        if ev_name not in state['event_types'] and len(state['event_types']) < 32:
            state['event_types'].append(ev_name)
        _record_conversation_id(state, event.get('conversation_id'))
        if ev_name == 'init':
            _parse_init_event(event, state)
        elif ev_name == 'step_update':
            _parse_step_event(event, state)
        elif ev_name == 'result':
            _parse_result_event(event, state)
    return state


def _has_any_phrase(text, phrases):
    return any(p in text for p in phrases)


def _str_field(mapping, key, default=None):
    if isinstance(mapping, dict):
        val = mapping.get(key)
        if isinstance(val, str):
            return val
    return default


def _valid_retry_after_str(value):
    if type(value) is str and value.isdigit() and 0 < int(value) <= 86400:
        return value
    return None


def _extract_retry_after(diag_text, quota_info):
    if isinstance(quota_info, dict):
        for key in ('retry_after', 'retryAfter'):
            val = quota_info.get(key)
            if type(val) in (int, float) and not isinstance(val, bool) and math.isfinite(val) and 0 < val <= 86400:
                return str(int(math.ceil(val)))
            if type(val) is str:
                parsed = _valid_retry_after_str(val.strip())
                if parsed is not None:
                    return parsed
    match = _RETRY_AFTER_RE.search(diag_text)
    if match:
        seconds = int(match.group(1))
        if 0 < seconds <= 86400:
            return str(seconds)
    return None


_LOWER_ONLY_ERROR_RULES = (
    ('overloaded', _OVERLOADED_PHRASES),
    ('permission_denied', ('permission_denied', '(code 403)', '"error_code":403')),
    ('invalid_request', ('invalid_argument', '(code 400)', '"error_code":400')),
)


def _classify_cli_failure(agy_status, finished_reason, returncode, diag_text, protocol_error, has_final):
    lower = diag_text.lower()
    reason_lower = finished_reason.lower() if isinstance(finished_reason, str) else ''
    if 'auth' in reason_lower or _has_any_phrase(lower, _AUTH_PHRASES):
        return 'auth_required'
    if reason_lower in ('quota', 'rate_limited', 'resource_exhausted') or _has_any_phrase(lower, _QUOTA_PHRASES):
        return 'rate_limited'
    for code, phrases in _LOWER_ONLY_ERROR_RULES:
        if _has_any_phrase(lower, phrases):
            return code
    if _looks_like_refusal(finished_reason, agy_status, lower):
        return 'invalid_request'
    if _looks_like_interruption(agy_status, reason_lower, returncode, lower):
        return 'provider_error'
    if protocol_error or agy_status in ('WAITING', 'RUNNING', 'INVALID') or (returncode == 0 and not has_final):
        return 'protocol_violation'
    return 'provider_error'


def _looks_like_refusal(finished_reason, agy_status, diag_lower):
    if isinstance(finished_reason, str) and finished_reason.lower() in _REFUSAL_REASONS:
        return True
    if isinstance(agy_status, str) and agy_status.upper() == 'REFUSED':
        return True
    return _has_any_phrase(diag_lower, ('safety block', 'blocked by safety', 'prohibited_content', 'content_filter'))


def _looks_like_interruption(agy_status, reason_lower, returncode, diag_lower):
    if isinstance(agy_status, str) and agy_status.upper() in _INTERRUPTION_STATUSES:
        return True
    if reason_lower in _INTERRUPTION_REASONS:
        return True
    if isinstance(returncode, int) and (returncode < 0 or returncode in (130, 143)):
        return True
    return _has_any_phrase(diag_lower, ('context canceled', 'run was canceled', 'interrupted by signal'))


def _validate_json_object(payload, schema, validator_cls):
    if type(payload) is not dict:
        return None, 'response_not_object'
    try:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        parsed = json.loads(encoded, object_pairs_hook=strict_json_object, parse_constant=_reject_nonfinite)
        validator_cls(schema).validate(parsed)
    except Exception:
        return None, 'protocol_violation'
    return parsed, None


def _parse_structured_response(final, text_deltas, schema, validator_cls):
    structured = final.get('structured_output') if isinstance(final, dict) else None
    if structured is not None:
        return _validate_json_object(structured, schema, validator_cls)

    text = _str_field(final, 'response')
    if text is None:
        text = ''.join(text_deltas)
    raw = text.strip()
    if not raw:
        return None, 'protocol_violation'
    try:
        parsed = json.loads(raw, object_pairs_hook=strict_json_object, parse_constant=_reject_nonfinite)
    except ValueError:
        match = _CODE_FENCE_RE.match(raw)
        if not match:
            return None, 'protocol_violation'
        try:
            parsed = json.loads(match.group(1).strip(), object_pairs_hook=strict_json_object,
                                parse_constant=_reject_nonfinite)
        except ValueError:
            return None, 'protocol_violation'
    if type(parsed) is not dict:
        return None, 'response_not_object'
    try:
        validator_cls(schema).validate(parsed)
    except Exception:
        return None, 'protocol_violation'
    return parsed, None


def _validate_bounds(max_calls, timeout_seconds, max_prompt_chars, max_tokens, max_images):
    if type(max_calls) is not int or not 1 <= max_calls <= 10000:
        raise ValueError('budget_exhausted')
    if (isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float))
            or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 3600):
        raise ValueError('config_error')
    if type(max_prompt_chars) is not int or not 1 <= max_prompt_chars <= 2000000:
        raise ValueError('config_error')
    if type(max_tokens) is not int or not 1 <= max_tokens <= 128000:
        raise ValueError('config_error')
    if type(max_images) is not int or not 1 <= max_images <= 100:
        raise ValueError('config_error')


def _prepare_schema(schema):
    if type(schema) is not dict:
        return None, None, 'schema_limit'
    try:
        encoded = json.dumps(schema, allow_nan=False, separators=(',', ':'), ensure_ascii=False)
    except (TypeError, ValueError):
        return None, None, 'schema_limit'
    if len(encoded.encode('utf-8')) > MAX_SCHEMA_BYTES:
        return None, None, 'schema_limit'
    from jsonschema import Draft202012Validator
    try:
        Draft202012Validator.check_schema(schema)
    except Exception:
        return None, None, 'schema_limit'
    return encoded, Draft202012Validator, None


def _set_error(result, code):
    fixed = code if code in _FIXED_ERRORS else 'provider_error'
    status = ('timeout' if fixed == 'timeout'
              else 'budget_exhausted' if fixed == 'budget_exhausted'
              else 'cancelled' if fixed == 'cancelled'
              else 'error')
    result.update(status=status, error_code=fixed, retryable=fixed in _RETRYABLE_ERRORS)


def _sanitize_broker_usage(raw):
    if not isinstance(raw, dict):
        return {}
    usage = {}
    for key in ('input_tokens', 'output_tokens', 'thinking_tokens',
                'cache_read_input_tokens', 'cache_creation_input_tokens', 'total_tokens'):
        val = _nonneg_int(raw.get(key))
        if val is not None:
            usage[key] = val
    return usage


def _resolve_socket_path(socket_path, transport, executable):
    if socket_path is None:
        if transport is not None or executable is not None:
            return None
        env_socket = os.environ.get(SOCKET_ENV, '').strip()
        return validate_socket_path(env_socket) if env_socket else None
    resolved = validate_socket_path(socket_path)
    if resolved is not None and (transport is not None or executable is not None):
        raise ValueError('config_error')
    return resolved


def _apply_broker_metadata(reply, result):
    usage = _sanitize_broker_usage(reply.get('usage'))
    if usage:
        result['usage'] = usage
    observed_events = reply.get('observed_event_types')
    if isinstance(observed_events, list) and all(type(e) is str and _EVENT_NAME_RE.fullmatch(e) for e in observed_events):
        result['observed_event_types'] = sorted(set(observed_events))[:32]
    observed_models = reply.get('observed_models')
    if isinstance(observed_models, list):
        clean_models = [m for m in (_valid_model(x) for x in observed_models) if m is not None][:8]
        result['observed_models'] = clean_models
        result['provider_model'] = clean_models[0] if len(clean_models) == 1 else None
    tool_calls = _nonneg_int(reply.get('observed_tool_calls'))
    if tool_calls is not None:
        result['observed_tool_calls'] = tool_calls
    stop_reason = _safe_stop_reason(reply.get('stop_reason'))
    if stop_reason is not None:
        result['stop_reason'] = stop_reason
    retry_after = _valid_retry_after_str(reply.get('retry_after'))
    if retry_after is not None:
        result['retry_after'] = retry_after


def _broker_error_code(reply):
    code = reply.get('error_code')
    if type(code) is str and code in _FIXED_ERRORS:
        return code
    status = reply.get('status')
    return status if status in ('timeout', 'cancelled') else 'provider_error'


def _populate_stream_metadata(stream, final, stderr, agy_status, finished_reason, result):
    headless_denied = _has_any_phrase(stderr.lower(), _TOOL_DENIAL_PHRASES)
    observed_tools = stream['observed_tool_calls'] or (1 if headless_denied else 0)
    observed_models = list(stream['observed_models'])[:8]
    result['observed_event_types'] = sorted(stream['event_types'])
    result['observed_models'] = observed_models
    result['provider_model'] = observed_models[0] if len(observed_models) == 1 else None
    result['observed_tool_calls'] = observed_tools
    result['stop_reason'] = _safe_stop_reason(finished_reason) or _safe_stop_reason(agy_status)
    result['usage'] = _reconcile_usage(final, stream['agent_step_usages'])
    return observed_tools, observed_models


def _has_boundary_violation(fresh, stream, observed_tools):
    return (
        not fresh
        or stream['mcp_observed']
        or stream['permission_mode'] not in (None, 'strict')
        or observed_tools > 0
    )


def _build_diag_text(final_error, stderr, stdout, returncode, has_final):
    parts = [final_error, stderr]
    if returncode != 0 and not has_final:
        parts.append(stdout[:2048])
    return '\n'.join(part for part in parts if part)


def _record_cli_failure(agy_status, finished_reason, returncode, diag_text, stream, result):
    code = _classify_cli_failure(agy_status, finished_reason, returncode, diag_text,
                                 stream['protocol_error'], stream['final'] is not None)
    _set_error(result, code)
    if code == 'rate_limited':
        retry_after = _extract_retry_after(diag_text, stream['quota_info'])
        if retry_after is not None:
            result['retry_after'] = retry_after


class AgyBackend:
    """Drop-in ``infer``/``infer_visual`` BLUE backend over local ``agy`` CLI or Unix socket broker."""

    def __init__(
        self,
        max_calls=3,
        timeout_seconds=180,
        max_prompt_chars=100000,
        *,
        model=None,
        effort=None,
        max_tokens=32000,
        max_images=MAX_IMAGES,
        transport=None,
        executable=None,
        cancelled=None,
        socket_path=None,
    ):
        _validate_bounds(max_calls, timeout_seconds, max_prompt_chars, max_tokens, max_images)
        self.model = DEFAULT_MODEL if model is None else model
        self.effort = DEFAULT_EFFORT if effort is None else effort
        if self.model != DEFAULT_MODEL:
            raise ValueError('config_error')
        if self.effort != DEFAULT_EFFORT:
            raise ValueError('config_error')
        self.socket_path = _resolve_socket_path(socket_path, transport, executable)
        self.max_calls = max_calls
        self.timeout_seconds = float(timeout_seconds)
        self.max_prompt_chars = max_prompt_chars
        self.max_tokens = max_tokens
        self.max_images = max_images
        self.transport = transport or bounded_cli_transport
        if executable is None:
            self.executable = None
        elif isinstance(executable, str):
            self.executable = [executable]
        else:
            self.executable = list(executable)
        self.cancelled = cancelled
        self.calls = 0
        self._lock = threading.Lock()
        self._seen_conversations = set()
        self.capability_config = {
            'provider': PROVIDER,
            'model': self.model,
            'effort': self.effort,
            'auth': ('local operator AGY broker over Unix socket; no credentials in runtime'
                     if self.socket_path else
                     'persisted local AGY OAuth session; external API key/provider env removed'),
            'structured_output': '--json-schema plus local Draft 2020-12 jsonschema validation',
            'tools': 'none (strict settings deny all tools, commands, files, URLs, MCP)',
            'slash_commands': False,
            'retries': 0,
            'model_output_limit': 'managed by agy',
            'max_output_bytes': MAX_OUTPUT_BYTES,
            'multimodal_input': False,
        }
        if self.socket_path:
            self.capability_config['transport'] = 'unix_socket'

    def __repr__(self):
        return 'AgyBackend(model=%r, effort=%r, calls=%s)' % (self.model, self.effort, self.calls)

    def _cancelled(self):
        return callable(self.cancelled) and bool(self.cancelled())

    def _empty(self):
        return {
            'status': 'error',
            'response': None,
            'usage': {},
            'elapsed_seconds': 0.0,
            'provider': PROVIDER,
            'model': self.model,
            'effort': self.effort,
            'error_code': None,
            'error_request_id': None,
            'retryable': False,
            'provider_model': None,
            'stop_reason': None,
            'request_id': None,
            'observed_tool_calls': 0,
            'observed_event_types': [],
            'observed_models': [],
        }

    def command(self, executable, schema_arg):
        return list(executable) + [
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--model', self.model,
            '--effort', self.effort,
            '--disable-slash-commands',
            '--settings', _STRICT_SETTINGS_JSON,
            '--json-schema', schema_arg,
        ]

    def _stdin_payload(self, prompt):
        content = f'[Execution Rules]\n{_PROMPT_GUARDRAIL}\n[End Execution Rules]\n\n{prompt}'
        return json.dumps({'event': 'user', 'message': {'content': content}},
                          separators=(',', ':'), ensure_ascii=False) + '\n'

    def _reserve_call(self):
        with self._lock:
            if self.calls >= self.max_calls:
                return False
            self.calls += 1
        return True

    def _check_fresh_conversation(self, cid_hash):
        if cid_hash is None:
            return True
        with self._lock:
            if cid_hash in self._seen_conversations:
                return False
            self._seen_conversations.add(cid_hash)
        return True

    def _run_transport(self, cmd, *, cwd, env, stdin_text):
        kwargs = {
            'cwd': cwd, 'env': env, 'stdin': stdin_text,
            'timeout_seconds': self.timeout_seconds, 'max_output_bytes': MAX_OUTPUT_BYTES,
        }
        if self.transport is _DEFAULT_TRANSPORT:
            kwargs['cancelled'] = self.cancelled
        return self.transport(cmd, **kwargs)

    def _execute_socket(self, prompt, schema, validator_cls, result):
        from agy_broker import infer_over_socket
        reply = infer_over_socket(
            self.socket_path,
            prompt=prompt,
            schema=schema,
            timeout_seconds=self.timeout_seconds,
            max_tokens=self.max_tokens,
            cancelled=self.cancelled,
        )
        if not isinstance(reply, dict):
            _set_error(result, 'protocol_violation')
            return
        _apply_broker_metadata(reply, result)
        if reply.get('status') != 'ok':
            _set_error(result, _broker_error_code(reply))
            return
        if (reply.get('provider') != PROVIDER
                or reply.get('model') != self.model
                or reply.get('effort') != self.effort
                or result['observed_models'] != [self.model]
                or result['observed_tool_calls'] > 0):
            _set_error(result, 'protocol_violation')
            return
        parsed, err = _validate_json_object(reply.get('response'), schema, validator_cls)
        if err is not None:
            _set_error(result, err)
            return
        result.update(status='ok', response=parsed, error_code=None, retryable=False)

    def _execute_cli(self, executable, prompt, encoded_schema, schema, validator_cls, result):
        env = clean_environment()
        stdin_text = self._stdin_payload(prompt)
        with tempfile.TemporaryDirectory(prefix='falsify-agy-cwd-') as empty_cwd, \
                tempfile.TemporaryDirectory(prefix='falsify-agy-schema-') as schema_dir:
            if len(encoded_schema.encode('utf-8')) <= MAX_INLINE_SCHEMA_BYTES:
                schema_arg = encoded_schema
            else:
                schema_path = Path(schema_dir) / 'schema.json'
                schema_path.write_text(encoded_schema, encoding='utf-8')
                schema_arg = str(schema_path)
            cmd = self.command(executable, schema_arg)
            try:
                run = self._run_transport(cmd, cwd=empty_cwd, env=env, stdin_text=stdin_text)
            except (TimeoutError, subprocess.TimeoutExpired):
                _set_error(result, 'timeout')
                return
            except FileNotFoundError:
                _set_error(result, 'config_error')
                return
            except ValueError as error:
                code = str(error) if str(error) in ('output_limit', 'cancelled') else 'transport_error'
                _set_error(result, code)
                return
            except OSError:
                _set_error(result, 'transport_error')
                return
        self._interpret(run, schema, validator_cls, result)

    def _execute(self, prompt, schema, result):
        if self._cancelled():
            _set_error(result, 'cancelled')
            return
        if type(prompt) is not str or not 1 <= len(prompt) <= self.max_prompt_chars:
            _set_error(result, 'prompt_limit')
            return
        encoded_schema, validator_cls, schema_err = _prepare_schema(schema)
        if schema_err:
            _set_error(result, schema_err)
            return
        if self.socket_path is not None:
            if not self._reserve_call():
                _set_error(result, 'budget_exhausted')
                return
            self._execute_socket(prompt, schema, validator_cls, result)
            return
        try:
            executable = self.executable or discover_agy()
        except FileNotFoundError:
            _set_error(result, 'config_error')
            return
        if not self._reserve_call():
            _set_error(result, 'budget_exhausted')
            return
        self._execute_cli(executable, prompt, encoded_schema, schema, validator_cls, result)

    def _interpret(self, run, schema, validator_cls, result):
        if not isinstance(run, dict):
            _set_error(result, 'transport_error')
            return
        stdout = _str_field(run, 'stdout', '')
        stderr = _str_field(run, 'stderr', '')
        returncode = run.get('returncode')
        if len(stdout.encode('utf-8')) + len(stderr.encode('utf-8')) > MAX_OUTPUT_BYTES:
            _set_error(result, 'output_limit')
            return

        stream = _parse_stream(stdout)
        final = stream['final']
        agy_status = _str_field(final, 'status')
        finished_reason = _str_field(final, 'finished_reason')
        final_error = _str_field(final, 'error', '')
        observed_tools, observed_models = _populate_stream_metadata(
            stream, final, stderr, agy_status, finished_reason, result,
        )

        fresh = self._check_fresh_conversation(_hash_id(stream['conversation_id']))
        if _has_boundary_violation(fresh, stream, observed_tools):
            _set_error(result, 'protocol_violation')
            return

        diag_text = _build_diag_text(final_error, stderr, stdout, returncode, final is not None)
        if returncode != 0 or final is None or agy_status != 'SUCCESS':
            _record_cli_failure(agy_status, finished_reason, returncode, diag_text, stream, result)
            return
        if _looks_like_refusal(finished_reason, agy_status, diag_text.lower()):
            _set_error(result, 'invalid_request')
            return
        if stream['protocol_error'] or observed_models != [self.model]:
            _set_error(result, 'protocol_violation')
            return

        parsed, err = _parse_structured_response(final, stream['text_deltas'], schema, validator_cls)
        if err is not None:
            _set_error(result, err)
            return
        result.update(status='ok', response=parsed, error_code=None, retryable=False)

    def infer(self, prompt, schema):
        start = time.monotonic()
        result = self._empty()
        try:
            self._execute(prompt, schema, result)
        except Exception as error:
            code = str(error) if isinstance(error, ValueError) and str(error) in _FIXED_ERRORS else 'provider_error'
            _set_error(result, code)
        finally:
            result['elapsed_seconds'] = round(time.monotonic() - start, 4)
        if self._cancelled():
            result.update(status='cancelled', error_code='cancelled', retryable=False, response=None)
        return result

    def infer_visual(self, prompt, schema, images):
        """Fail closed without launching AGY or dropping supplied images."""
        start = time.monotonic()
        result = self._empty()
        _set_error(result, 'cancelled' if self._cancelled() else 'invalid_request')
        result['elapsed_seconds'] = round(time.monotonic() - start, 4)
        return result
