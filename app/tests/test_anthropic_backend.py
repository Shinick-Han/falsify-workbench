"""Anthropic API backend contracts: offline transport only, no live calls or credentials."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))

import anthropic_backend
import harness
from anthropic_backend import AnthropicBackend, wire_schema

SCHEMA = {'type': 'object', 'properties': {'status': {'type': 'string', 'enum': ['ok', 'abstain']},
                                           'items': {'type': 'array', 'items': {'type': 'string'},
                                                     'minItems': 1, 'maxItems': 3}},
          'required': ['status', 'items'], 'additionalProperties': False}


def message(text, usage=None, model='claude-opus-5-5', stop='end_turn'):
    return json.dumps({'id': 'msg_test', 'type': 'message', 'role': 'assistant', 'model': model,
                       'content': [{'type': 'text', 'text': text}], 'stop_reason': stop,
                       'usage': usage or {'input_tokens': 11, 'output_tokens': 7,
                                          'cache_read_input_tokens': 2, 'cache_creation_input_tokens': 3}}).encode()


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
    return AnthropicBackend(max_calls=kwargs.pop('max_calls', 3), key=kwargs.pop('key', 'test-key'),
                            workspace=kwargs.pop('workspace', 'ws-test'),
                            endpoint=kwargs.pop('endpoint', 'https://api.anthropic.com'),
                            transport=transport, **kwargs)


class WireTests(unittest.TestCase):
    def test_structured_output_headers_workspace_and_schema_transform(self):
        transport = Transport([{'status': 200, 'headers': {'request-id': 'req_1'},
                                'body': message('{"status":"ok","items":["a"]}')}])
        result = backend(transport).infer('Inspect the document.', SCHEMA)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['response'], {'status': 'ok', 'items': ['a']})
        self.assertEqual(result['usage']['input_tokens'], 11)
        self.assertEqual(result['request_id'], 'req_1')
        request = transport.requests[0]
        self.assertEqual(request['url'], 'https://api.anthropic.com/v1/messages')
        self.assertEqual(request['headers']['anthropic-workspace-id'], 'ws-test')
        self.assertEqual(request['headers']['anthropic-version'], anthropic_backend.API_VERSION)
        self.assertEqual(request['headers']['x-api-key'], 'test-key')
        body = request['body']
        self.assertEqual(body['model'], 'claude-opus-5-5')
        self.assertEqual(body['output_config']['effort'], 'medium')
        schema = body['output_config']['format']['schema']
        self.assertNotIn('maxItems', schema['properties']['items'])
        self.assertEqual(schema['properties']['items']['minItems'], 1)
        self.assertNotIn('test-key', json.dumps(result))

    def test_workspace_header_is_optional(self):
        transport = Transport([{'status': 200, 'headers': {}, 'body': message('{"status":"ok","items":["a"]}')}])
        backend(transport, workspace='').infer('x', SCHEMA)
        self.assertNotIn('anthropic-workspace-id', transport.requests[0]['headers'])

    def test_wire_schema_strips_unsupported_numeric_and_array_bounds(self):
        schema = {'type': 'object', 'properties': {
            'n': {'type': 'integer', 'minimum': 0, 'maximum': 4},
            's': {'type': 'string', 'minLength': 2, 'maxLength': 8, 'pattern': '^a'},
            'a': {'type': 'array', 'minItems': 2, 'maxItems': 9},
            'b': {'type': 'array', 'minItems': 1, 'maxItems': 3},
        }}
        wire = wire_schema(schema)
        self.assertNotIn('minimum', wire['properties']['n'])
        self.assertNotIn('minLength', wire['properties']['s'])
        self.assertNotIn('pattern', wire['properties']['s'])
        self.assertNotIn('maxItems', wire['properties']['a'])
        self.assertNotIn('minItems', wire['properties']['a'])
        self.assertEqual(wire['properties']['b']['minItems'], 1)
        self.assertEqual(schema['properties']['a']['minItems'], 2)


class ResultSemanticsTests(unittest.TestCase):
    def test_usage_model_stop_reason_and_request_id_are_recorded_truthfully(self):
        transport = Transport([{'status': 200, 'headers': {'request-id': 'req_usage'},
                                'body': message('{"status":"ok","items":[]}', model='claude-sonnet-5-5',
                                                stop='end_turn')}])
        result = backend(transport, model='claude-sonnet-5-5', effort='high').infer('x', SCHEMA)
        self.assertEqual(result['provider_model'], 'claude-sonnet-5-5')
        self.assertEqual(result['observed_models'], ['claude-sonnet-5-5'])
        self.assertEqual(result['stop_reason'], 'end_turn')
        self.assertEqual(result['usage'], {'input_tokens': 11, 'output_tokens': 7,
                                           'cache_read_input_tokens': 2, 'cache_creation_input_tokens': 3})
        self.assertEqual(transport.requests[0]['body']['output_config']['effort'], 'high')

    def test_rate_limit_error_is_retryable_and_carries_request_id(self):
        body = json.dumps({'type': 'error', 'error': {'type': 'rate_limit_error', 'message': 'slow'},
                           'request_id': 'req_rate'}).encode()
        result = backend(Transport([{'status': 429, 'headers': {'retry-after': '30'}, 'body': body}])).infer('x', SCHEMA)
        self.assertEqual((result['status'], result['error_code']), ('error', 'rate_limited'))
        self.assertTrue(result['retryable'])
        self.assertEqual(result['retry_after'], '30')
        self.assertEqual(result['error_request_id'], 'req_rate')
        self.assertNotIn('slow', json.dumps(result))

    def test_authentication_and_server_errors_use_fixed_codes(self):
        auth = backend(Transport([{'status': 401, 'headers': {},
                                   'body': b'{"error":{"type":"authentication_error","message":"bad key"}}'}])).infer('x', SCHEMA)
        self.assertEqual((auth['status'], auth['error_code'], auth['retryable']), ('error', 'auth_required', False))
        server = backend(Transport([{'status': 529, 'headers': {}, 'body': b'{}'}])).infer('x', SCHEMA)
        self.assertEqual((server['status'], server['error_code'], server['retryable']), ('error', 'overloaded', True))

    def test_timeout_transport_and_invalid_output(self):
        timeout = backend(Transport([TimeoutError()])).infer('x', SCHEMA)
        self.assertEqual((timeout['status'], timeout['error_code']), ('timeout', 'timeout'))
        broken = backend(Transport([{'status': 200, 'headers': {}, 'body': b'not json'}])).infer('x', SCHEMA)
        self.assertEqual((broken['status'], broken['error_code']), ('error', 'invalid_output'))
        invalid = backend(Transport([{'status': 200, 'headers': {}, 'body': message('{"status":"ok"}')}])).infer('x', SCHEMA)
        self.assertEqual(invalid['error_code'], 'invalid_output')
        truncated = backend(Transport([{'status': 200, 'headers': {},
                                        'body': message('{"status":"ok","items":[]}', stop='max_tokens')}])).infer('x', SCHEMA)
        self.assertEqual(truncated['error_code'], 'output_limit')

    def test_budget_cancellation_and_limits_without_extra_calls(self):
        transport = Transport([{'status': 200, 'headers': {}, 'body': message('{"status":"ok","items":["a"]}')},
                               {'status': 200, 'headers': {}, 'body': message('{"status":"ok","items":["a"]}')}])
        engine = backend(transport, max_calls=1)
        self.assertEqual(engine.infer('x', SCHEMA)['status'], 'ok')
        self.assertEqual(engine.infer('x', SCHEMA)['status'], 'budget_exhausted')
        self.assertEqual(len(transport.requests), 1)
        cancelled = backend(Transport([]), cancelled=lambda: True).infer('x', SCHEMA)
        self.assertEqual((cancelled['status'], cancelled['error_code']), ('cancelled', 'cancelled'))
        missing_key = backend(Transport([]), key='').infer('x', SCHEMA)
        self.assertEqual(missing_key['error_code'], 'config_error')
        prompt = backend(Transport([]), max_prompt_chars=10).infer('x' * 11, SCHEMA)
        self.assertEqual(prompt['error_code'], 'prompt_limit')

    def test_images_are_batched_without_a_six_image_cap(self):
        transport = Transport([{'status': 200, 'headers': {}, 'body': message('{"status":"ok","items":["a"]}')}])
        images = [b'\x89PNG\r\n\x1a\n' + bytes([i]) + b'x' * 40 for i in range(8)]
        result = backend(transport).infer_visual('x', SCHEMA, images)
        self.assertEqual(result['status'], 'ok')
        content = transport.requests[0]['body']['messages'][0]['content']
        self.assertEqual(sum(1 for block in content if block['type'] == 'image'), 8)
        self.assertTrue(all(block['source']['media_type'] == 'image/png' for block in content if block['type'] == 'image'))


class HostedHarnessTests(unittest.TestCase):
    def hosted(self, max_calls=12, model='claude-opus-5-5', effort='high'):
        return {'schema': 'falsify.harness.v1', 'id': 'hosted-anthropic', 'name': 'Hosted Anthropic',
                'version': '1', 'role': 'red', 'instructions': 'Find internal contradictions.',
                'maxCalls': max_calls, 'adapter': {'type': 'hosted', 'model': model, 'effort': effort}}

    def test_hosted_adapter_selection_and_record(self):
        value = harness.validate(self.hosted(), 'red')
        selected = harness.selection(value)
        self.assertEqual((selected['provider'], selected['model'], selected['effort']),
                         ('anthropic-api', 'claude-opus-5-5', 'high'))
        self.assertEqual(harness.record(value)['hostedSelection']['provider'], 'anthropic-api')
        self.assertEqual(harness.model_label(value), 'claude-opus-5-5')
        self.assertTrue(harness.builtin(value))

    def test_hosted_budget_above_cli_limit_but_still_bounded(self):
        harness.validate(self.hosted(max_calls=100), 'red')
        with self.assertRaises(ValueError):
            harness.validate(self.hosted(max_calls=513), 'red')
        cli = {**harness.default('red'), 'maxCalls': 33}
        with self.assertRaises(ValueError):
            harness.validate(cli, 'red')

    def test_hosted_model_effort_and_extra_fields_are_rejected(self):
        with self.assertRaises(ValueError):
            harness.validate(self.hosted(model='claude-unknown-9'), 'red')
        with self.assertRaises(ValueError):
            harness.validate(self.hosted(effort='maximum'), 'red')
        value = self.hosted()
        value['adapter']['url'] = 'https://example.test'
        with self.assertRaises(ValueError):
            harness.validate(value, 'red')


if __name__ == '__main__':
    unittest.main()
