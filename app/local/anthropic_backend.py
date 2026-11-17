"""Operator-funded Anthropic Messages API backend for hosted RED/BLUE execution.

The server process is the only holder of ANTHROPIC_API_KEY. This module never logs, returns or embeds the key,
never retries a paid call by itself and never invents usage or completion. Structured output uses
``output_config.format`` with adaptive thinking (omitted) and ``output_config.effort``; unsupported JSON-Schema
keywords are removed from the wire schema and still enforced locally with jsonschema.

Current model IDs and request/error semantics follow the official Claude API documentation checked on
2026-11-17: https://platform.claude.com/docs/en/api/messages and /docs/en/build-with-claude/structured-outputs.
"""
import base64
import json
import os
import socket
import ssl
import threading
import time
import urllib.error
import urllib.request

API_VERSION = '2026-10-21'
DEFAULT_BASE_URL = 'https://api.anthropic.com'
DEFAULT_MODEL = 'claude-opus-5-5'
MODELS = ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5')
EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max')
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_IMAGES = 64
IMAGE_TYPES = (('image/png', b'\x89PNG\r\n\x1a\n'), ('image/jpeg', b'\xff\xd8\xff'), ('image/gif', b'GIF8'),
               ('image/webp', b'RIFF'))
# Wire schemas reject these; local Draft 2020-12 validation still runs against the original schema.
_UNSUPPORTED = frozenset({'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'pattern',
                          'uniqueItems', 'contains', 'propertyNames', 'patternProperties', 'dependentRequired',
                          'dependentSchemas', 'if', 'then', 'else', 'not'})
_FIXED_ERRORS = frozenset({'prompt_limit', 'schema_limit', 'output_limit', 'invalid_output', 'auth_required',
                           'permission_denied', 'invalid_request', 'request_too_large', 'rate_limited',
                           'provider_error', 'overloaded', 'timeout', 'cancelled', 'budget_exhausted',
                           'transport_error', 'config_error'})


def api_key():
    return os.environ.get('ANTHROPIC_API_KEY', '').strip()


def workspace_id():
    return os.environ.get('ANTHROPIC_WORKSPACE_ID', '').strip() or None


def base_url():
    value = (os.environ.get('ANTHROPIC_BASE_URL') or DEFAULT_BASE_URL).rstrip('/')
    if not value.startswith('https://') and not value.startswith('http://127.0.0.1'):
        raise ValueError('config_error')
    return value


def wire_schema(schema):
    """Remove JSON-Schema keywords the structured-output grammar does not accept. Never mutates the input."""
    if isinstance(schema, list):
        return [wire_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    result = {}
    for key, value in schema.items():
        if key in _UNSUPPORTED:
            continue
        if key == 'minItems' and value not in (0, 1):
            continue
        result[key] = wire_schema(value)
    return result


def _image_type(raw):
    for mime, magic in IMAGE_TYPES:
        if raw.startswith(magic):
            return mime
    return None


def _error_code(status, error_type):
    if status == 400:
        return 'invalid_request'
    if status == 401:
        return 'auth_required'
    if status == 403:
        return 'permission_denied'
    if status == 404:
        return 'invalid_request'
    if status == 413:
        return 'request_too_large'
    if status == 429:
        return 'rate_limited'
    if status == 529:
        return 'overloaded'
    if status == 504:
        return 'timeout'
    if status >= 500:
        return 'provider_error'
    return 'provider_error' if error_type not in _FIXED_ERRORS else error_type


def retryable(code):
    return code in ('rate_limited', 'overloaded', 'provider_error', 'timeout')


def _http_transport(request, timeout_seconds):
    """One HTTPS request. Returns {'status', 'headers', 'body'} without raising for HTTP status errors."""
    raw = json.dumps(request['body'], ensure_ascii=False, allow_nan=False).encode('utf-8')
    req = urllib.request.Request(request['url'], data=raw, method='POST', headers=request['headers'])
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as response:
            body = response.read(MAX_OUTPUT_BYTES + 1)
            return {'status': response.status, 'headers': {k.lower(): v for k, v in response.headers.items()},
                    'body': body}
    except urllib.error.HTTPError as error:
        body = error.read(MAX_OUTPUT_BYTES + 1)
        return {'status': error.code, 'headers': {k.lower(): v for k, v in (error.headers or {}).items()},
                'body': body}
    except (socket.timeout, TimeoutError) as error:
        raise TimeoutError('timeout') from error
    except urllib.error.URLError as error:
        if isinstance(error.reason, (socket.timeout, TimeoutError)):
            raise TimeoutError('timeout') from error
        raise ConnectionError('transport_error') from error
    except (ssl.SSLError, OSError) as error:
        raise ConnectionError('transport_error') from error


class AnthropicBackend:
    """Drop-in ``infer``/``infer_visual`` engine backend with a bounded call budget."""

    def __init__(self, max_calls=3, timeout_seconds=180, max_prompt_chars=100000, *, model=None, effort=None,
                 key=None, workspace=None, endpoint=None, transport=None, max_tokens=16000, max_images=MAX_IMAGES,
                 cancelled=None):
        if type(max_calls) is not int or not 1 <= max_calls <= 10000:
            raise ValueError('budget_exhausted')
        if not 0 < timeout_seconds <= 3600 or not 1 <= max_prompt_chars <= 2000000:
            raise ValueError('config_error')
        if not 1 <= max_tokens <= 128000 or not 1 <= max_images <= 100:
            raise ValueError('config_error')
        self.model = DEFAULT_MODEL if model is None else model
        self.effort = 'medium' if effort is None else effort
        if self.model not in MODELS:
            raise ValueError('config_error')
        if self.effort not in EFFORTS:
            raise ValueError('config_error')
        self.max_calls, self.timeout_seconds = max_calls, timeout_seconds
        self.max_prompt_chars, self.max_tokens, self.max_images = max_prompt_chars, max_tokens, max_images
        self.key = key if key is not None else api_key()
        self.workspace = workspace if workspace is not None else workspace_id()
        self.endpoint = endpoint if endpoint is not None else base_url()
        self.transport = transport or _http_transport
        self.cancelled = cancelled
        self.calls = 0
        self.capability_config = {
            'provider': 'anthropic-api', 'model': self.model, 'effort': self.effort,
            'auth': 'operator server key; never sent to the browser',
            'structured_output': 'output_config.format json_schema; local jsonschema validation',
            'thinking': 'adaptive default (omitted); effort via output_config.effort',
            'tools': 'none by default; no shell/notebook execution',
            'retries': 0, 'max_tokens': self.max_tokens, 'api_version': API_VERSION,
            'workspace_scoped': self.workspace is not None,
        }

    def _cancelled(self):
        return callable(self.cancelled) and bool(self.cancelled())

    def _empty(self):
        return {'status': 'error', 'response': None, 'usage': {}, 'elapsed_seconds': 0.,
                'provider': 'anthropic-api', 'model': self.model, 'effort': self.effort,
                'error_code': None, 'error_request_id': None, 'retryable': False,
                'provider_model': None, 'stop_reason': None, 'request_id': None,
                'observed_tool_calls': 0, 'observed_models': []}

    def _request(self, prompt, schema, images):
        if self._cancelled():
            return None, 'cancelled'
        if type(prompt) is not str or not 1 <= len(prompt) <= self.max_prompt_chars:
            return None, 'prompt_limit'
        if type(schema) is not dict:
            return None, 'schema_limit'
        encoded = json.dumps(schema, allow_nan=False, separators=(',', ':'))
        if len(encoded.encode('utf-8')) > 65536:
            return None, 'schema_limit'
        from jsonschema import Draft202012Validator
        try:
            Draft202012Validator.check_schema(schema)
        except Exception:
            return None, 'schema_limit'
        if not self.key:
            return None, 'config_error'
        content = []
        for raw in images or ():
            mime = _image_type(raw) if isinstance(raw, bytes) else None
            if mime is None:
                return None, 'invalid_output'
            content.append({'type': 'image', 'source': {'type': 'base64', 'media_type': mime,
                                                         'data': base64.b64encode(raw).decode('ascii')}})
        content.append({'type': 'text', 'text': prompt})
        headers = {'content-type': 'application/json', 'anthropic-version': API_VERSION, 'x-api-key': self.key,
                   'accept': 'application/json'}
        if self.workspace:
            headers['anthropic-workspace-id'] = self.workspace
        body = {'model': self.model, 'max_tokens': self.max_tokens,
                'messages': [{'role': 'user', 'content': content}],
                'output_config': {'effort': self.effort,
                                  'format': {'type': 'json_schema', 'schema': wire_schema(schema)}}}
        return {'url': self.endpoint + '/v1/messages', 'headers': headers, 'body': body}, None

    def _run(self, prompt, schema, images=()):
        start = time.monotonic()
        result = self._empty()
        try:
            request, code = self._request(prompt, schema, images)
            if request is None:
                result.update(status='budget_exhausted' if code == 'budget_exhausted' else
                              'cancelled' if code == 'cancelled' else 'error', error_code=code)
                return result
            with threading.Lock():
                if self.calls >= self.max_calls:
                    result.update(status='budget_exhausted', error_code='budget_exhausted')
                    return result
                self.calls += 1
            try:
                response = self.transport(request, self.timeout_seconds)
            except TimeoutError:
                result.update(status='timeout', error_code='timeout', retryable=True)
                return result
            except ConnectionError:
                result.update(status='error', error_code='transport_error', retryable=True)
                return result
            self._interpret(response, schema, result)
        except Exception as error:
            # Only fixed labels are exposed; messages can contain request data.
            code = str(error) if isinstance(error, ValueError) and str(error) in _FIXED_ERRORS else 'provider_error'
            result.update(status='error', error_code=code)
        finally:
            result['elapsed_seconds'] = round(time.monotonic() - start, 4)
        if self._cancelled():
            result.update(status='cancelled', error_code='cancelled', response=None)
        return result

    def _interpret(self, response, schema, result):
        status = response.get('status') if isinstance(response, dict) else None
        headers = {str(k).lower(): str(v) for k, v in (response.get('headers') or {}).items()} if isinstance(response, dict) else {}
        body = response.get('body') if isinstance(response, dict) else None
        result['request_id'] = headers.get('request-id')
        if not isinstance(status, int):
            result.update(status='error', error_code='transport_error', retryable=True)
            return
        if status != 200:
            payload = {}
            try:
                payload = json.loads(body.decode('utf-8')) if isinstance(body, bytes) else (body or {})
            except (ValueError, UnicodeDecodeError):
                payload = {}
            error = payload.get('error') if isinstance(payload, dict) else None
            error_type = error.get('type') if isinstance(error, dict) else None
            request_id = payload.get('request_id') if isinstance(payload, dict) else None
            code = _error_code(status, error_type)
            result.update(status='timeout' if code == 'timeout' else 'error', error_code=code,
                          error_request_id=request_id if isinstance(request_id, str) else result['request_id'],
                          retryable=retryable(code) or (status == 429))
            if status == 429:
                result['retry_after'] = headers.get('retry-after')
            return
        try:
            message = json.loads(body.decode('utf-8')) if isinstance(body, bytes) else body
        except (ValueError, UnicodeDecodeError):
            result.update(status='error', error_code='invalid_output')
            return
        if not isinstance(message, dict):
            result.update(status='error', error_code='invalid_output')
            return
        returned_model = message.get('model')
        result['provider_model'] = returned_model if isinstance(returned_model, str) else None
        result['observed_models'] = [returned_model] if result['provider_model'] else []
        result['stop_reason'] = message.get('stop_reason') if isinstance(message.get('stop_reason'), str) else None
        usage = message.get('usage')
        if isinstance(usage, dict):
            result['usage'] = {k: v for k, v in usage.items()
                               if type(v) is int and v >= 0 and ('token' in k or k in ('input_tokens', 'output_tokens'))}
        content = message.get('content')
        if not isinstance(content, list):
            result.update(status='error', error_code='invalid_output')
            return
        if any(isinstance(b, dict) and b.get('type') in ('tool_use', 'server_tool_use', 'mcp_tool_use') for b in content):
            result['observed_tool_calls'] = 1
            result.update(status='error', error_code='invalid_output')
            return
        if result['stop_reason'] == 'refusal':
            result.update(status='error', error_code='invalid_request')
            return
        if result['stop_reason'] == 'max_tokens':
            result.update(status='error', error_code='output_limit')
            return
        text = ''.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')
        if not text.strip():
            result.update(status='error', error_code='invalid_output')
            return
        try:
            value = json.loads(text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
        except ValueError:
            result.update(status='error', error_code='invalid_output')
            return
        if type(value) is not dict:
            result.update(status='error', error_code='invalid_output')
            return
        try:
            from jsonschema import Draft202012Validator
            Draft202012Validator(schema).validate(value)
        except Exception:
            result.update(status='error', error_code='invalid_output')
            return
        result.update(status='ok', response=value)
        if result['stop_reason'] is None:
            result['stop_reason'] = None

    def infer(self, prompt, schema):
        return self._run(prompt, schema)

    def infer_visual(self, prompt, schema, images):
        if type(images) is not list or not 1 <= len(images) <= self.max_images:
            result = self._empty()
            result.update(status='error', error_code='invalid_output')
            return result
        return self._run(prompt, schema, images)
