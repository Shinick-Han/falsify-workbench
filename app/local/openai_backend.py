"""Operator-funded OpenAI Responses API backend for hosted RED/BLUE execution.

The server process is the only holder of OPENAI_API_KEY. This module never logs, returns or embeds the key,
never retries a paid call by itself and never invents usage or completion. Structured output uses
``text.format`` with ``json_schema`` and ``strict`` true. Optional properties are sent as nullable required
fields. Keywords outside the structured-output subset are removed from the wire schema and still enforced
locally with jsonschema against the original schema. Nulls for properties that were optional are dropped
before that local check so callers keep today's object shape.

Documentation checked on 2026-11-18:
https://developers.openai.com/api/docs/guides/reasoning
https://developers.openai.com/api/docs/guides/structured-outputs
https://developers.openai.com/api/docs/guides/images-vision
https://developers.openai.com/api/docs/guides/error-codes
https://developers.openai.com/api/reference/resources/responses/methods/create
https://developers.openai.com/api/docs/models
https://developers.openai.com/api/docs/models/gpt-6.2-astra
https://developers.openai.com/api/docs/guides/latest-model/gpt-5
https://developers.openai.com/api/docs/guides/latest-model/gpt-5.2
"""
import base64
import json
import os
import threading
import time

from anthropic_backend import _FIXED_ERRORS, _decode_json, _http_transport, _image_type, _response_parts, _valid_schema

DEFAULT_BASE_URL = 'https://api.openai.com'
DEFAULT_MODEL = 'gpt-6.2-astra'
SCHEMA_NAME = 'falsify_result'
EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max')
MAX_IMAGES = 64
# Ascending reasoning.effort. UI max maps to the last entry; xhigh maps to xhigh or else high.
# gpt-5 / mini / nano: https://developers.openai.com/api/docs/guides/latest-model/gpt-5
# o3 low/medium/high: https://developers.openai.com/api/docs/guides/latest-model/gpt-5.2
# gpt-6.2 positive set is the models-index chip list; the model pages state that none is rejected.
_GPT5 = ('minimal', 'low', 'medium', 'high')
_TO_HIGH = ('none', 'low', 'medium', 'high')
_TO_XHIGH = ('none', 'low', 'medium', 'high', 'xhigh')
_TO_MAX = ('none', 'low', 'medium', 'high', 'xhigh', 'max')
_UI_MAX = ('low', 'medium', 'high', 'xhigh', 'max')
MODEL_EFFORTS = {
    'gpt-5': _GPT5, 'gpt-5-mini': _GPT5, 'gpt-5-nano': _GPT5, 'gpt-5.1': _TO_HIGH, 'o3': ('low', 'medium', 'high'),
    'gpt-5.2': _TO_XHIGH, 'gpt-5.4': _TO_XHIGH, 'gpt-5.4-mini': _TO_XHIGH, 'gpt-5.4-nano': _TO_XHIGH, 'gpt-5.5': _TO_XHIGH,
    'gpt-5.6-luna': _TO_MAX, 'gpt-5.6-sol': _TO_MAX, 'gpt-5.6-terra': _TO_MAX,
    'gpt-6-astra': _UI_MAX, 'gpt-6-luna': _TO_MAX, 'gpt-6-sol': _TO_MAX,
    'gpt-6.1-sol': _UI_MAX, 'gpt-6.1-terra': _TO_MAX, 'gpt-6.2-astra': _UI_MAX, 'gpt-6.2-sol': _UI_MAX,
}
# Pro ids are omitted: docs give them different effort sets, multi-minute runs, or no structured_outputs feature.
MODELS = (
    'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.5',
    'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol',
    'gpt-6.1-terra', 'gpt-6.2-astra', 'gpt-6.2-sol', 'o3',
)
# Structured Outputs subset checked 2026-11-18. minItems/maxItems/minimum stay; composition keywords do not.
_UNSUPPORTED = frozenset({
    'allOf', 'not', 'dependentRequired', 'dependentSchemas', 'if', 'then', 'else', 'oneOf', 'patternProperties',
    'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'uniqueItems', 'contains', 'minContains',
    'maxContains', 'prefixItems', '$ref', '$defs', '$schema', '$id', '$comment', '$anchor', '$dynamicRef',
    'definitions', 'default', 'examples', 'example', 'deprecated', 'readOnly', 'writeOnly', 'contentMediaType',
    'contentEncoding',
})
_QUOTA = frozenset({
    'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
})
_STATUS = {400: 'invalid_request', 401: 'auth_required', 403: 'permission_denied', 404: 'invalid_request',
           413: 'request_too_large', 429: 'rate_limited', 503: 'overloaded', 504: 'timeout'}
_RETRYABLE = frozenset({'rate_limited', 'overloaded', 'provider_error', 'timeout'})
_SCHEMA_BYTES = 65536


def _map_effort(supported, effort):
    if effort == 'max':
        return supported[-1]
    if effort == 'xhigh' and 'xhigh' not in supported:
        return 'high'
    return effort


def _effort_row(supported):
    return {effort: _map_effort(supported, effort) for effort in EFFORTS}


EFFORT_MAP = {model: _effort_row(supported) for model, supported in MODEL_EFFORTS.items()}


def api_key():
    return os.environ.get('OPENAI_API_KEY', '').strip()


def organization_id():
    return os.environ.get('OPENAI_ORG_ID', '').strip() or None


def project_id():
    return os.environ.get('OPENAI_PROJECT_ID', '').strip() or None


def base_url():
    value = (os.environ.get('OPENAI_BASE_URL') or DEFAULT_BASE_URL).rstrip('/')
    if not value.startswith('https://') and not value.startswith('http://127.0.0.1'):
        raise ValueError('config_error')
    return value


def _object_schema(schema):
    kind = schema.get('type')
    properties = schema.get('properties')
    if kind == 'object':
        return True
    if isinstance(kind, list) and 'object' in kind and isinstance(properties, dict):
        return True
    return 'type' not in schema and isinstance(properties, dict)


def wire_schema(schema):
    """Copy schema into the OpenAI strict subset. Never mutates the input."""
    if isinstance(schema, list):
        return [wire_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    cleaned = {}
    for key, value in schema.items():
        if key in _UNSUPPORTED:
            continue
        cleaned[key] = wire_schema(value)
    if _object_schema(cleaned):
        return _close_object(cleaned)
    return cleaned


def _close_object(schema):
    properties = schema.get('properties')
    if not isinstance(properties, dict):
        schema['additionalProperties'] = False
        return schema
    required = schema.get('required') if isinstance(schema.get('required'), list) else []
    closed = {}
    for name, prop in properties.items():
        closed[name] = prop if name in required else _with_null(prop)
    schema['properties'] = closed
    schema['required'] = list(closed)
    schema['additionalProperties'] = False
    return schema


def _allows_null(prop):
    kind = prop.get('type')
    if kind == 'null' or (isinstance(kind, list) and 'null' in kind):
        return True
    options = prop.get('anyOf')
    if not isinstance(options, list):
        return False
    return any(isinstance(item, dict) and item.get('type') == 'null' for item in options)


def _with_null(prop):
    if not isinstance(prop, dict):
        return {'anyOf': [prop, {'type': 'null'}]}
    if _allows_null(prop):
        return prop
    if 'anyOf' in prop:
        return {**prop, 'anyOf': [*prop['anyOf'], {'type': 'null'}]}
    return _null_type(prop)


def _null_type(prop):
    copied = dict(prop)
    kind = copied.get('type')
    if isinstance(kind, str):
        copied['type'] = [kind, 'null']
    elif isinstance(kind, list):
        copied['type'] = [*kind, 'null']
    else:
        return {'anyOf': [copied, {'type': 'null'}]}
    if isinstance(copied.get('enum'), list) and None not in copied['enum']:
        copied['enum'] = [*copied['enum'], None]
    return copied


def _validate_bounds(max_calls, timeout_seconds, max_prompt_chars, max_tokens, max_images):
    if type(max_calls) is not int or not 1 <= max_calls <= 10000:
        raise ValueError('budget_exhausted')
    if not 0 < timeout_seconds <= 3600 or not 1 <= max_prompt_chars <= 2000000:
        raise ValueError('config_error')
    if not 1 <= max_tokens <= 128000 or not 1 <= max_images <= 100:
        raise ValueError('config_error')


def _schema_ok(schema):
    try:
        from jsonschema import Draft202012Validator
        Draft202012Validator.check_schema(schema)
        return True
    except Exception:
        return False


def _schema_limit(schema):
    if type(schema) is not dict:
        return 'schema_limit'
    try:
        encoded = json.dumps(schema, allow_nan=False, separators=(',', ':'))
    except (TypeError, ValueError):
        return 'schema_limit'
    if len(encoded.encode('utf-8')) > _SCHEMA_BYTES or not _schema_ok(schema):
        return 'schema_limit'
    return None


def _content(prompt, images):
    blocks = []
    for raw in images or ():
        mime = _image_type(raw) if isinstance(raw, bytes) else None
        if mime is None:
            return None, 'invalid_output'
        encoded = base64.b64encode(raw).decode('ascii')
        blocks.append({'type': 'input_image', 'image_url': 'data:' + mime + ';base64,' + encoded, 'detail': 'auto'})
    blocks.append({'type': 'input_text', 'text': prompt})
    return blocks, None


def _reject_nonfinite(_value):
    raise ValueError('nonfinite')


def _parse_object(text):
    try:
        value = json.loads(text, parse_constant=_reject_nonfinite)
    except ValueError:
        return None
    if type(value) is not dict:
        return None
    return value


def _drop_child(item, schema):
    if isinstance(item, dict):
        return _drop_optional_nulls(item, schema if isinstance(schema, dict) else {})
    if isinstance(item, list) and isinstance(schema, dict):
        return [_drop_child(part, schema.get('items')) for part in item]
    return item


def _drop_optional_nulls(value, schema):
    if not isinstance(value, dict) or not isinstance(schema, dict) or 'anyOf' in schema:
        return value
    properties = schema.get('properties')
    if not isinstance(properties, dict):
        return value
    required = schema.get('required') if isinstance(schema.get('required'), list) else []
    cleaned = {}
    for key, item in value.items():
        if key not in required and item is None and key in properties:
            continue
        cleaned[key] = _drop_child(item, properties.get(key))
    return cleaned


def _error_code(status, error):
    if status == 429 and (error.get('code') in _QUOTA or error.get('type') in _QUOTA):
        return 'permission_denied'
    if status in _STATUS:
        return _STATUS[status]
    if error.get('code') == 'server_is_overloaded' or error.get('type') == 'service_unavailable_error':
        return 'overloaded'
    return 'provider_error'


def _set_error(result, code):
    result.update(status='timeout' if code == 'timeout' else 'error', error_code=code, retryable=code in _RETRYABLE)


def _apply_http_error(status, headers, body, result):
    payload = _decode_json(body)
    error = {}
    if isinstance(payload, dict) and isinstance(payload.get('error'), dict):
        error = payload['error']
    code = _error_code(status, error)
    result['error_request_id'] = result['request_id']
    _set_error(result, code)
    if status == 429 and code == 'rate_limited':
        result['retry_after'] = headers.get('retry-after')


def _token(value):
    if type(value) is int and not isinstance(value, bool) and value >= 0:
        return value
    return 0


def _usage(usage):
    if not isinstance(usage, dict):
        return {}
    details = usage.get('input_tokens_details')
    cached = details.get('cached_tokens') if isinstance(details, dict) else None
    return {'input_tokens': _token(usage.get('input_tokens')), 'output_tokens': _token(usage.get('output_tokens')),
            'cache_read_input_tokens': _token(cached), 'cache_creation_input_tokens': 0}


def _apply_meta(payload, result):
    model = payload.get('model')
    result['provider_model'] = model if isinstance(model, str) else None
    result['observed_models'] = [model] if result['provider_model'] else []
    result['usage'] = _usage(payload.get('usage'))


def _incomplete(payload, result):
    details = payload.get('incomplete_details')
    reason = details.get('reason') if isinstance(details, dict) else None
    result['stop_reason'] = reason if isinstance(reason, str) else 'incomplete'
    code = 'output_limit' if reason == 'max_output_tokens' else 'invalid_output'
    result.update(status='error', error_code=code)
    return True


def _stopped(payload, result):
    status = payload.get('status')
    if status == 'incomplete':
        return _incomplete(payload, result)
    if status != 'completed':
        result['stop_reason'] = status if isinstance(status, str) else None
        result.update(status='error', error_code='provider_error' if status == 'failed' else 'invalid_output')
        return True
    result['stop_reason'] = 'completed'
    return False


def _message_blocks(items):
    for item in items:
        if isinstance(item, dict) and item.get('type') == 'message' and isinstance(item.get('content'), list):
            return item['content']
    return []


def _has_tool(items):
    for item in items:
        if isinstance(item, dict) and item.get('type') not in ('message', 'reasoning'):
            return True
    return False


def _has_refusal(items):
    for block in _message_blocks(items):
        if isinstance(block, dict) and block.get('type') == 'refusal':
            return True
    return False


def _refused_or_tools(payload, result):
    output = payload.get('output')
    items = output if isinstance(output, list) else []
    if _has_tool(items):
        result['observed_tool_calls'] = 1
        result.update(status='error', error_code='invalid_output')
        return True
    if _has_refusal(items):
        result.update(status='error', error_code='invalid_output')
        return True
    return False


def _block_text(block):
    if isinstance(block, dict) and block.get('type') == 'output_text' and isinstance(block.get('text'), str):
        return block['text']
    return ''


def _output_text(payload):
    output = payload.get('output')
    items = output if isinstance(output, list) else []
    blocks = _message_blocks(items)
    if blocks:
        return ''.join(_block_text(block) for block in blocks)
    text = payload.get('output_text')
    return text if isinstance(text, str) else ''


def _apply_structured_text(text, schema, result):
    if not isinstance(text, str) or not text.strip():
        result.update(status='error', error_code='invalid_output')
        return
    value = _parse_object(text)
    if value is None or not _valid_schema(_drop_optional_nulls(value, schema), schema):
        result.update(status='error', error_code='invalid_output')
        return
    result.update(status='ok', response=_drop_optional_nulls(value, schema))


def _apply_success(body, schema, result):
    payload = _decode_json(body)
    if not isinstance(payload, dict):
        result.update(status='error', error_code='invalid_output')
        return
    _apply_meta(payload, result)
    if _stopped(payload, result) or _refused_or_tools(payload, result):
        return
    _apply_structured_text(_output_text(payload), schema, result)


def _assign_preflight(result, code):
    if code == 'budget_exhausted':
        result.update(status='budget_exhausted', error_code=code)
    elif code == 'cancelled':
        result.update(status='cancelled', error_code=code)
    else:
        result.update(status='error', error_code=code)


def _assign_exception(result, error):
    code = 'provider_error'
    if isinstance(error, ValueError) and str(error) in _FIXED_ERRORS:
        code = str(error)
    result.update(status='error', error_code=code)


class OpenAIBackend:
    """Drop-in ``infer``/``infer_visual`` engine backend with a bounded call budget."""

    def __init__(self, max_calls=3, timeout_seconds=180, max_prompt_chars=100000, *, model=None, effort=None,
                 key=None, organization=None, project=None, endpoint=None, transport=None, max_tokens=16000,
                 max_images=MAX_IMAGES, cancelled=None):
        _validate_bounds(max_calls, timeout_seconds, max_prompt_chars, max_tokens, max_images)
        self.model = DEFAULT_MODEL if model is None else model
        self.effort = 'medium' if effort is None else effort
        if self.model not in MODELS or self.effort not in EFFORTS:
            raise ValueError('config_error')
        self.max_calls, self.timeout_seconds = max_calls, timeout_seconds
        self.max_prompt_chars, self.max_tokens, self.max_images = max_prompt_chars, max_tokens, max_images
        self.key = key if key is not None else api_key()
        self.organization = organization if organization is not None else organization_id()
        self.project = project if project is not None else project_id()
        self.endpoint = endpoint if endpoint is not None else base_url()
        self.transport = transport or _http_transport
        self.cancelled = cancelled
        self.calls = 0
        self._budget_lock = threading.Lock()
        mapped = EFFORT_MAP[self.model][self.effort]
        self.capability_config = {
            'provider': 'openai-api', 'model': self.model, 'effort': self.effort, 'reasoning_effort': mapped,
            'effort_map': dict(EFFORT_MAP[self.model]),
            'auth': 'operator server key; never sent to the browser',
            'structured_output': 'text.format json_schema strict; local jsonschema on the original schema',
            'thinking': 'Responses reasoning.effort; reasoning tokens stay inside output_tokens',
            'tools': 'none by default; no shell/notebook execution',
            'retries': 0, 'max_tokens': self.max_tokens,
            'organization_scoped': self.organization is not None, 'project_scoped': self.project is not None,
        }

    def __repr__(self):
        return 'OpenAIBackend(model=%r, effort=%r, calls=%s)' % (self.model, self.effort, self.calls)

    def _cancelled(self):
        return callable(self.cancelled) and bool(self.cancelled())

    def _empty(self):
        return {'status': 'error', 'response': None, 'usage': {}, 'elapsed_seconds': 0.,
                'provider': 'openai-api', 'model': self.model, 'effort': self.effort,
                'error_code': None, 'error_request_id': None, 'retryable': False,
                'provider_model': None, 'stop_reason': None, 'request_id': None,
                'observed_tool_calls': 0, 'observed_models': []}

    def _headers(self):
        headers = {'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json',
                   'Accept': 'application/json'}
        if self.organization:
            headers['OpenAI-Organization'] = self.organization
        if self.project:
            headers['OpenAI-Project'] = self.project
        return headers

    def _body(self, blocks, schema):
        return {'model': self.model, 'input': [{'role': 'user', 'content': blocks}],
                'max_output_tokens': self.max_tokens, 'store': False,
                'reasoning': {'effort': EFFORT_MAP[self.model][self.effort]},
                'text': {'format': {'type': 'json_schema', 'name': SCHEMA_NAME, 'strict': True,
                                    'schema': wire_schema(schema)}}}

    def _preflight(self, prompt):
        if self._cancelled():
            return 'cancelled'
        if type(prompt) is not str or not 1 <= len(prompt) <= self.max_prompt_chars:
            return 'prompt_limit'
        if not self.key:
            return 'config_error'
        return None

    def _request(self, prompt, schema, images):
        code = self._preflight(prompt) or _schema_limit(schema)
        if code:
            return None, code
        blocks, code = _content(prompt, images)
        if code:
            return None, code
        return {'url': self.endpoint + '/v1/responses', 'headers': self._headers(),
                'body': self._body(blocks, schema)}, None

    def _reserve_call(self):
        with self._budget_lock:
            if self.calls >= self.max_calls:
                return False
            self.calls += 1
        return True

    def _call_transport(self, request, schema, result):
        try:
            response = self.transport(request, self.timeout_seconds)
        except TimeoutError:
            result.update(status='timeout', error_code='timeout', retryable=True)
            return
        except ConnectionError:
            result.update(status='error', error_code='transport_error', retryable=True)
            return
        self._interpret(response, schema, result)

    def _execute(self, prompt, schema, images, result):
        request, code = self._request(prompt, schema, images)
        if request is None:
            _assign_preflight(result, code)
            return
        if not self._reserve_call():
            result.update(status='budget_exhausted', error_code='budget_exhausted')
            return
        self._call_transport(request, schema, result)

    def _run(self, prompt, schema, images=()):
        start = time.monotonic()
        result = self._empty()
        try:
            self._execute(prompt, schema, images, result)
        except Exception as error:
            _assign_exception(result, error)
        finally:
            result['elapsed_seconds'] = round(time.monotonic() - start, 4)
        if self._cancelled():
            result.update(status='cancelled', error_code='cancelled', response=None)
        return result

    def _interpret(self, response, schema, result):
        status, headers, body = _response_parts(response)
        result['request_id'] = headers.get('x-request-id')
        if not isinstance(status, int):
            result.update(status='error', error_code='transport_error', retryable=True)
            return
        if status != 200:
            _apply_http_error(status, headers, body, result)
            return
        _apply_success(body, schema, result)

    def infer(self, prompt, schema):
        return self._run(prompt, schema)

    def infer_visual(self, prompt, schema, images):
        if type(images) is not list or not 1 <= len(images) <= self.max_images:
            result = self._empty()
            result.update(status='error', error_code='invalid_output')
            return result
        return self._run(prompt, schema, images)
