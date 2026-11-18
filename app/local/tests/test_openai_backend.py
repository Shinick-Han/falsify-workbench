"""OpenAI Responses backend contracts: offline transport only, no live calls or credentials."""
import hashlib
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import blue_service
import openai_backend
import red_service
import review_limits
from openai_backend import EFFORT_MAP, MODELS, OpenAIBackend, wire_schema
from red_multimodal import extend_candidate_schema

SCHEMA = {'type': 'object', 'properties': {'status': {'type': 'string', 'enum': ['ok', 'abstain']},
                                           'items': {'type': 'array', 'items': {'type': 'string'}, 'minItems': 1,
                                                     'maxItems': 3}},
          'required': ['status', 'items'], 'additionalProperties': False}
OPTIONAL = {'type': 'object', 'properties': {'status': {'type': 'string', 'enum': ['ok']},
                                             'note': {'type': 'string', 'enum': ['keep']}},
            'required': ['status'], 'additionalProperties': False}
KEY = 'unit-test-key-9f3a'
HIGH = {'low': 'low', 'medium': 'medium', 'high': 'high', 'xhigh': 'high', 'max': 'high'}
XHIGH = {'low': 'low', 'medium': 'medium', 'high': 'high', 'xhigh': 'xhigh', 'max': 'xhigh'}
FULL = {'low': 'low', 'medium': 'medium', 'high': 'high', 'xhigh': 'xhigh', 'max': 'max'}
EXPECTED_EFFORT = {
    'gpt-5': HIGH, 'gpt-5-mini': HIGH, 'gpt-5-nano': HIGH, 'gpt-5.1': HIGH, 'o3': HIGH,
    'gpt-5.2': XHIGH, 'gpt-5.4': XHIGH, 'gpt-5.4-mini': XHIGH, 'gpt-5.4-nano': XHIGH, 'gpt-5.5': XHIGH,
    'gpt-5.6-luna': FULL, 'gpt-5.6-sol': FULL, 'gpt-5.6-terra': FULL, 'gpt-6-astra': FULL, 'gpt-6-luna': FULL,
    'gpt-6-sol': FULL, 'gpt-6.1-sol': FULL, 'gpt-6.1-terra': FULL, 'gpt-6.2-astra': FULL, 'gpt-6.2-sol': FULL,
}
USAGE = {'input_tokens': 11, 'output_tokens': 7, 'total_tokens': 23,
         'input_tokens_details': {'cached_tokens': 2, 'cache_write_tokens': 4},
         'output_tokens_details': {'reasoning_tokens': 5}}


def message(text, usage=None, model='gpt-6.2-astra', status='completed', incomplete=None, output=None):
    body = {'id': 'resp_test', 'object': 'response', 'status': status, 'model': model,
            'incomplete_details': incomplete, 'usage': USAGE if usage is None else usage}
    if output is None:
        body['output'] = [{'type': 'reasoning', 'summary': []},
                          {'type': 'message', 'role': 'assistant',
                           'content': [{'type': 'output_text', 'text': text}]}]
    else:
        body['output'] = output
    return json.dumps(body).encode()


class Transport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def backend(transport, **kwargs):
    return OpenAIBackend(max_calls=kwargs.pop('max_calls', 3), key=kwargs.pop('key', KEY),
                         endpoint=kwargs.pop('endpoint', 'https://api.openai.com'), transport=transport, **kwargs)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def minimal(schema):
    if not isinstance(schema, dict):
        return 'x'
    if 'anyOf' in schema:
        return minimal(schema['anyOf'][0])
    if 'enum' in schema:
        return schema['enum'][0]
    kind = schema.get('type')
    if isinstance(kind, list):
        kind = next(item for item in kind if item != 'null')
    if kind == 'object':
        return {key: minimal(value) for key, value in schema['properties'].items()}
    if kind == 'array':
        count = schema.get('minItems') or 0
        return [minimal(schema['items']) for _ in range(count)]
    if kind == 'integer':
        return schema.get('minimum', 0)
    if kind == 'number':
        return schema.get('minimum', 0)
    if kind == 'boolean':
        return False
    return 'x'


def assert_closed(case, schema):
    if isinstance(schema, list):
        for item in schema:
            assert_closed(case, item)
        return
    if not isinstance(schema, dict):
        return
    if schema.get('type') == 'object' and isinstance(schema.get('properties'), dict):
        if schema.get('additionalProperties') is not False:
            raise AssertionError('object is not closed')
        if list(schema.get('required')) != list(schema['properties']):
            raise AssertionError('required mismatch')
    for value in schema.values():
        assert_closed(case, value)


def unsupported_keys(schema, found=None):
    found = [] if found is None else found
    if isinstance(schema, dict):
        for key, value in schema.items():
            if key in openai_backend._UNSUPPORTED:
                found.append(key)
            unsupported_keys(value, found)
    elif isinstance(schema, list):
        for item in schema:
            unsupported_keys(item, found)
    return found


class RequestTests(unittest.TestCase):
    def test_request_shape_usage_and_success_parse(self):
        transport = Transport([{'status': 200, 'headers': {'X-Request-Id': 'req_1'},
                                'body': message('{"status":"ok","items":["a"]}')}])
        engine = backend(transport, organization='org-test', project='proj-test')
        result = engine.infer('Inspect the document.', SCHEMA)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['response'], {'status': 'ok', 'items': ['a']})
        self.assertEqual(result['usage'], {'input_tokens': 11, 'output_tokens': 7,
                                           'cache_read_input_tokens': 2, 'cache_creation_input_tokens': 0})
        self.assertNotIn('reasoning_tokens', result['usage'])
        self.assertEqual(result['request_id'], 'req_1')
        self.assertEqual(result['provider_model'], 'gpt-6.2-astra')
        self.assertEqual(result['observed_models'], ['gpt-6.2-astra'])
        self.assertEqual(result['stop_reason'], 'completed')
        self.assertEqual(result['observed_tool_calls'], 0)
        self.assertEqual(result['provider'], 'openai-api')
        request = transport.requests[0]
        self.assertEqual(request['url'], 'https://api.openai.com/v1/responses')
        self.assertEqual(request['headers']['Authorization'], 'Bearer ' + KEY)
        self.assertEqual(request['headers']['OpenAI-Organization'], 'org-test')
        self.assertEqual(request['headers']['OpenAI-Project'], 'proj-test')
        body = request['body']
        self.assertEqual(body['model'], 'gpt-6.2-astra')
        self.assertIs(body['store'], False)
        self.assertEqual(body['max_output_tokens'], 16000)
        self.assertEqual(body['reasoning'], {'effort': 'medium'})
        self.assertNotIn('tools', body)
        formatted = body['text']['format']
        self.assertEqual(formatted['type'], 'json_schema')
        self.assertEqual(formatted['name'], 'falsify_result')
        self.assertIs(formatted['strict'], True)
        self.assertEqual(formatted['schema']['properties']['items']['minItems'], 1)
        self.assertNotIn(KEY, json.dumps(result))
        self.assertNotIn(KEY, json.dumps(body))
        self.assertNotIn(KEY, repr(engine))
        config = engine.capability_config
        self.assertEqual(config['provider'], 'openai-api')
        self.assertEqual(config['retries'], 0)
        self.assertEqual(config['effort'], 'medium')
        self.assertEqual(config['reasoning_effort'], 'medium')
        self.assertIn('none', config['tools'])
        self.assertNotIn(KEY, json.dumps(config))

    def test_organization_and_project_headers_are_optional(self):
        transport = Transport([{'status': 200, 'headers': {}, 'body': message('{"status":"ok","items":["a"]}')}])
        backend(transport, organization='', project='').infer('x', SCHEMA)
        headers = transport.requests[0]['headers']
        self.assertNotIn('OpenAI-Organization', headers)
        self.assertNotIn('OpenAI-Project', headers)

    def test_images_use_data_urls_without_a_six_image_cap(self):
        transport = Transport([{'status': 200, 'headers': {}, 'body': message('{"status":"ok","items":["a"]}')}])
        images = [b'\x89PNG\r\n\x1a\n' + bytes([index]) + b'x' * 40 for index in range(8)]
        result = backend(transport).infer_visual('x', SCHEMA, images)
        self.assertEqual(result['status'], 'ok')
        content = transport.requests[0]['body']['input'][0]['content']
        pictures = [block for block in content if block['type'] == 'input_image']
        self.assertEqual(len(pictures), 8)
        self.assertTrue(all(block['image_url'].startswith('data:image/png;base64,') for block in pictures))
        self.assertEqual(content[-1]['type'], 'input_text')

    def test_effort_map_is_the_documented_table_and_is_sent(self):
        self.assertEqual(set(MODELS), set(EXPECTED_EFFORT))
        self.assertEqual(EFFORT_MAP, EXPECTED_EFFORT)
        self.assertNotIn('gpt-5-pro', MODELS)
        self.assertEqual(openai_backend.DEFAULT_MODEL, 'gpt-6.2-astra')
        samples = (('gpt-5', 'max', 'high'), ('gpt-5', 'xhigh', 'high'), ('gpt-5.5', 'max', 'xhigh'),
                   ('gpt-6.2-astra', 'max', 'max'), ('gpt-6.2-astra', 'xhigh', 'xhigh'), ('o3', 'xhigh', 'high'))
        for model, effort, mapped in samples:
            transport = Transport([{'status': 200, 'headers': {}, 'body': message('{"status":"ok","items":["a"]}')}])
            result = backend(transport, model=model, effort=effort).infer('x', SCHEMA)
            self.assertEqual(result['status'], 'ok')
            self.assertEqual(transport.requests[0]['body']['reasoning']['effort'], mapped)
            self.assertIn(mapped, openai_backend.MODEL_EFFORTS[model])


class SchemaTests(unittest.TestCase):
    def engine_schemas(self):
        limits = review_limits.LOCAL
        return (red_service.RESULT, red_service.SCAN, red_service.CANDIDATE, blue_service.RESULT, blue_service.FINDING,
                blue_service.SELECTION, blue_service.VISUAL_OBSERVATION, blue_service.visual_result_schema(limits),
                blue_service.result_schema(limits, allow_occurrence=True), extend_candidate_schema(red_service.RESULT))

    def test_wire_schema_closes_objects_and_strips_unsupported_keywords(self):
        original = {'type': 'object', 'allOf': [{'type': 'object'}], 'properties': {
            'n': {'type': 'integer', 'minimum': 0, 'if': {'minimum': 0}, 'oneOf': [{'type': 'integer'}]},
            'items': {'type': 'array', 'minItems': 1, 'maxItems': 3, 'uniqueItems': True},
            'note': {'type': 'string'},
        }, 'required': ['n', 'items']}
        before = digest(original)
        wire = wire_schema(original)
        self.assertEqual(digest(original), before)
        self.assertNotIn('allOf', wire)
        self.assertNotIn('if', wire['properties']['n'])
        self.assertNotIn('oneOf', wire['properties']['n'])
        self.assertEqual(wire['properties']['n']['minimum'], 0)
        self.assertEqual(wire['properties']['items']['minItems'], 1)
        self.assertNotIn('uniqueItems', wire['properties']['items'])
        self.assertEqual(wire['properties']['note']['type'], ['string', 'null'])
        self.assertEqual(wire['required'], ['n', 'items', 'note'])
        self.assertIs(wire['additionalProperties'], False)

    def test_real_engine_schemas_round_trip_against_the_original(self):
        for schema in self.engine_schemas():
            before = digest(schema)
            wire = wire_schema(schema)
            self.assertEqual(digest(schema), before)
            self.assertEqual(unsupported_keys(wire), [])
            assert_closed(self, wire)
            payload = json.dumps(minimal(schema))
            transport = Transport([{'status': 200, 'headers': {}, 'body': message(payload)}])
            result = backend(transport).infer('x', schema)
            self.assertEqual(result['status'], 'ok', result['error_code'])
            self.assertTrue(openai_backend._valid_schema(result['response'], schema))

    def test_optional_null_is_removed_before_local_validation(self):
        transport = Transport([{'status': 200, 'headers': {}, 'body': message('{"status":"ok","note":null}')}])
        result = backend(transport).infer('x', OPTIONAL)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['response'], {'status': 'ok'})
        kept = Transport([{'status': 200, 'headers': {}, 'body': message('{"status":"ok","note":"keep"}')}])
        kept_result = backend(kept).infer('x', OPTIONAL)
        self.assertEqual(kept_result['response'], {'status': 'ok', 'note': 'keep'})
        wire = kept.requests[0]['body']['text']['format']['schema']
        self.assertIn(None, wire['properties']['note']['enum'])


class ErrorTests(unittest.TestCase):
    def test_http_errors_use_fixed_codes_without_provider_text(self):
        cases = ((400, 'invalid_request', False, 'error'), (401, 'auth_required', False, 'error'),
                 (403, 'permission_denied', False, 'error'), (404, 'invalid_request', False, 'error'),
                 (413, 'request_too_large', False, 'error'), (500, 'provider_error', True, 'error'),
                 (503, 'overloaded', True, 'error'), (504, 'timeout', True, 'timeout'))
        for status, code, retryable, label in cases:
            body = json.dumps({'error': {'type': 'server_error', 'message': 'secret-detail', 'code': 'server_error'}}).encode()
            result = backend(Transport([{'status': status, 'headers': {'x-request-id': 'req_e'}, 'body': body}])).infer('x', SCHEMA)
            self.assertEqual((result['status'], result['error_code'], result['retryable']), (label, code, retryable))
            self.assertEqual(result['request_id'], 'req_e')
            self.assertEqual(result['error_request_id'], 'req_e')
            self.assertNotIn('secret-detail', json.dumps(result))

    def test_rate_limit_is_retryable_and_quota_is_not(self):
        limited = json.dumps({'error': {'type': 'rate_limit_error', 'code': 'rate_limit_exceeded',
                                        'message': 'slow-down-text'}}).encode()
        result = backend(Transport([{'status': 429, 'headers': {'retry-after': '30', 'x-request-id': 'req_rate'},
                                     'body': limited}])).infer('x', SCHEMA)
        self.assertEqual((result['status'], result['error_code'], result['retryable'], result['retry_after']),
                         ('error', 'rate_limited', True, '30'))
        self.assertNotIn('slow-down-text', json.dumps(result))
        slow = json.dumps({'error': {'type': 'rate_limit_error', 'code': 'slow_down', 'message': 'ramp'}}).encode()
        slow_result = backend(Transport([{'status': 429, 'headers': {}, 'body': slow}])).infer('x', SCHEMA)
        self.assertEqual((slow_result['error_code'], slow_result['retryable']), ('rate_limited', True))
        for code in ('insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
                     'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'):
            body = json.dumps({'error': {'type': 'insufficient_quota', 'code': code, 'message': 'billing-text'}}).encode()
            quota = backend(Transport([{'status': 429, 'headers': {'retry-after': '9'}, 'body': body}])).infer('x', SCHEMA)
            self.assertEqual((quota['error_code'], quota['retryable']), ('permission_denied', False))
            self.assertNotIn('retry_after', quota)
            self.assertNotIn('billing-text', json.dumps(quota))

    def test_timeout_transport_invalid_refusal_incomplete_and_tools(self):
        timeout = backend(Transport([TimeoutError()])).infer('x', SCHEMA)
        self.assertEqual((timeout['status'], timeout['error_code'], timeout['retryable']), ('timeout', 'timeout', True))
        broken = backend(Transport([ConnectionError('transport_error')])).infer('x', SCHEMA)
        self.assertEqual((broken['error_code'], broken['retryable']), ('transport_error', True))
        invalid = backend(Transport([{'status': 200, 'headers': {}, 'body': b'not json'}])).infer('x', SCHEMA)
        self.assertEqual(invalid['error_code'], 'invalid_output')
        extra = backend(Transport([{'status': 200, 'headers': {},
                                    'body': message('{"status":"ok","items":["a"],"extra":1}')}])).infer('x', SCHEMA)
        self.assertEqual(extra['error_code'], 'invalid_output')
        refusal = message('', output=[{'type': 'message', 'content': [{'type': 'refusal', 'refusal': 'blocked-text'}]}])
        refused = backend(Transport([{'status': 200, 'headers': {}, 'body': refusal}])).infer('x', SCHEMA)
        self.assertEqual(refused['error_code'], 'invalid_output')
        self.assertNotIn('blocked-text', json.dumps(refused))
        incomplete = message('{"status":"ok","items":["a"]}', status='incomplete',
                             incomplete={'reason': 'max_output_tokens'})
        limited = backend(Transport([{'status': 200, 'headers': {}, 'body': incomplete}])).infer('x', SCHEMA)
        self.assertEqual((limited['error_code'], limited['stop_reason']), ('output_limit', 'max_output_tokens'))
        other = message('', status='incomplete', incomplete={'reason': 'content_filter'})
        self.assertEqual(backend(Transport([{'status': 200, 'headers': {}, 'body': other}])).infer('x', SCHEMA)['error_code'],
                         'invalid_output')
        failed = message('', status='failed', output=[])
        self.assertEqual(backend(Transport([{'status': 200, 'headers': {}, 'body': failed}])).infer('x', SCHEMA)['error_code'],
                         'provider_error')
        tool = message('', output=[{'type': 'function_call', 'name': 'shell', 'arguments': '{}'}])
        called = backend(Transport([{'status': 200, 'headers': {}, 'body': tool}])).infer('x', SCHEMA)
        self.assertEqual((called['error_code'], called['observed_tool_calls']), ('invalid_output', 1))
        self.assertNotIn('shell', json.dumps(called))

    def test_budget_cancellation_limits_and_missing_key_make_no_extra_call(self):
        transport = Transport([{'status': 200, 'headers': {}, 'body': message('{"status":"ok","items":["a"]}')},
                               {'status': 200, 'headers': {}, 'body': message('{"status":"ok","items":["a"]}')}])
        engine = backend(transport, max_calls=1)
        self.assertEqual(engine.infer('x', SCHEMA)['status'], 'ok')
        self.assertEqual(engine.infer('x', SCHEMA)['status'], 'budget_exhausted')
        self.assertEqual(len(transport.requests), 1)
        cancelled = backend(Transport([]), cancelled=lambda: True).infer('x', SCHEMA)
        self.assertEqual((cancelled['status'], cancelled['error_code']), ('cancelled', 'cancelled'))
        self.assertEqual(OpenAIBackend(key='', endpoint='https://api.openai.com', transport=Transport([])).infer('x', SCHEMA)['error_code'],
                         'config_error')
        self.assertEqual(backend(Transport([]), max_prompt_chars=10).infer('x' * 11, SCHEMA)['error_code'], 'prompt_limit')
        self.assertEqual(backend(Transport([]), max_prompt_chars=10).infer('', SCHEMA)['error_code'], 'prompt_limit')
        self.assertEqual(backend(Transport([])).infer('x', ['not', 'a', 'schema'])['error_code'], 'schema_limit')
        huge = {'type': 'object', 'properties': {'a': {'type': 'string', 'description': 'x' * 70000}},
                'required': ['a'], 'additionalProperties': False}
        self.assertEqual(backend(Transport([])).infer('x', huge)['error_code'], 'schema_limit')
        self.assertEqual(backend(Transport([])).infer('x', {'type': 'object', 'required': 'bad'})['error_code'], 'schema_limit')
        images = [b'\x89PNG\r\n\x1a\nxxx', b'not-an-image']
        self.assertEqual(backend(Transport([])).infer_visual('x', SCHEMA, images)['error_code'], 'invalid_output')
        self.assertEqual(backend(Transport([]), max_images=1).infer_visual('x', SCHEMA, images[:1] * 2)['error_code'],
                         'invalid_output')
        self.assertEqual(backend(Transport([])).infer_visual('x', SCHEMA, [])['error_code'], 'invalid_output')

    def test_key_never_appears_in_results_reprs_or_exceptions(self):
        def explode(request, _timeout):
            raise RuntimeError(request['headers']['Authorization'])
        result = backend(explode).infer('x', SCHEMA)
        self.assertEqual(result['error_code'], 'provider_error')
        self.assertNotIn(KEY, json.dumps(result))
        engine = backend(Transport([]))
        self.assertNotIn(KEY, repr(engine))
        self.assertNotIn(KEY, str(engine))
        with self.assertRaises(ValueError) as caught:
            OpenAIBackend(model='gpt-unknown', key=KEY, endpoint='https://api.openai.com')
        self.assertEqual(str(caught.exception), 'config_error')
        self.assertNotIn(KEY, str(caught.exception))
        with self.assertRaises(ValueError):
            OpenAIBackend(max_calls=0, key=KEY, endpoint='https://api.openai.com')
        with self.assertRaises(ValueError):
            OpenAIBackend(effort='none', key=KEY, endpoint='https://api.openai.com')

    def test_env_readers_do_not_call_the_network(self):
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'env-key', 'OPENAI_ORG_ID': 'env-org',
                                     'OPENAI_PROJECT_ID': 'env-proj', 'OPENAI_BASE_URL': 'https://example.test/'}):
            self.assertEqual(openai_backend.api_key(), 'env-key')
            self.assertEqual(openai_backend.organization_id(), 'env-org')
            self.assertEqual(openai_backend.project_id(), 'env-proj')
            self.assertEqual(openai_backend.base_url(), 'https://example.test')
            transport = Transport([{'status': 200, 'headers': {}, 'body': message('{"status":"ok","items":["a"]}')}])
            engine = OpenAIBackend(transport=transport)
            self.assertEqual(engine.infer('x', SCHEMA)['status'], 'ok')
            self.assertEqual(transport.requests[0]['headers']['Authorization'], 'Bearer env-key')
            self.assertEqual(transport.requests[0]['headers']['OpenAI-Organization'], 'env-org')
            self.assertEqual(transport.requests[0]['url'], 'https://example.test/v1/responses')
        with patch.dict(os.environ, {'OPENAI_BASE_URL': 'http://127.0.0.1:9'}, clear=False):
            self.assertEqual(openai_backend.base_url(), 'http://127.0.0.1:9')
        with patch.dict(os.environ, {'OPENAI_BASE_URL': 'http://example.test'}, clear=False):
            with self.assertRaises(ValueError) as caught:
                openai_backend.base_url()
            self.assertEqual(str(caught.exception), 'config_error')
        with patch.dict(os.environ, {'OPENAI_BASE_URL': ''}, clear=False):
            self.assertEqual(openai_backend.base_url(), 'https://api.openai.com')


if __name__ == '__main__':
    unittest.main()
