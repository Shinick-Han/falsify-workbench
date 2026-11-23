"""Local AGY CLI backend contracts: mocked transports plus optional live smoke probe."""
import hashlib
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))

import agy_backend
import blue_service
import blue_visual
import harness
import harness_adapter
import review_limits
from agy_backend import AgyBackend, DEFAULT_EFFORT, DEFAULT_MODEL, PROVIDER, bounded_cli_transport
from hosted_runtime import service as hosted_service

SCHEMA = {
    'type': 'object',
    'properties': {
        'status': {'type': 'string', 'enum': ['ok', 'abstain', 'refusal']},
        'items': {'type': 'array', 'items': {'type': 'string'}, 'minItems': 1, 'maxItems': 3},
    },
    'required': ['status', 'items'],
    'additionalProperties': False,
}

PNG_BYTES = b'\x89PNG\r\n\x1a\n' + b'x' * 40


def _agy_stream(
    response_text='',
    *,
    conversation_id='conv-fresh-001',
    model=DEFAULT_MODEL,
    permission_mode='strict',
    tools=None,
    mcp_servers=None,
    status='SUCCESS',
    finished_reason=None,
    error=None,
    structured_output=None,
    usage=None,
    omit_usage=False,
    step_usages=None,
    extra_events=None,
    returncode=0,
    stderr='',
    include_init=True,
    include_result=True,
    quota_info=None,
):
    events = []
    if include_init:
        init_body = {'cwd': '/tmp/empty', 'permission_mode': permission_mode}
        if model is not None:
            init_body['model'] = model
        if tools is not None:
            init_body['tools'] = tools
        if mcp_servers is not None:
            init_body['mcp_servers'] = mcp_servers
        events.append({'event': 'init', 'conversation_id': conversation_id, 'init': init_body})
    events.append({
        'event': 'step_update',
        'step_update': {
            'conversation_id': conversation_id, 'step_index': 0,
            'state': 'DONE', 'step_type': 'user_input',
        },
    })
    if step_usages is not None:
        for idx, su in enumerate(step_usages, start=1):
            step = {
                'conversation_id': conversation_id, 'step_index': idx,
                'state': 'DONE', 'step_type': 'agent_response',
                'text_delta': response_text if idx == len(step_usages) else '',
            }
            if su is not None:
                step['usage'] = su
            events.append({'event': 'step_update', 'step_update': step})
    else:
        default_usage = {
            'input_tokens': 10302, 'output_tokens': 582, 'thinking_tokens': 551,
            'cache_read_tokens': 8113, 'total_tokens': 10884,
        }
        step_usage = None if omit_usage else (default_usage if usage is None else usage)
        step = {
            'conversation_id': conversation_id, 'step_index': 1,
            'state': 'DONE', 'step_type': 'agent_response',
            'text_delta': response_text,
        }
        if step_usage is not None:
            step['usage'] = step_usage
        events.append({'event': 'step_update', 'step_update': step})
    if structured_output is not None:
        events.append({
            'event': 'step_update',
            'step_update': {
                'conversation_id': conversation_id, 'step_index': 2,
                'state': 'DONE', 'step_type': 'finish',
            },
        })
    if extra_events:
        events.extend(extra_events)
    if include_result:
        res = {'conversation_id': conversation_id, 'status': status, 'num_turns': 1}
        if response_text:
            res['response'] = response_text
        if finished_reason is not None:
            res['finished_reason'] = finished_reason
        if error is not None:
            res['error'] = error
        if structured_output is not None:
            res['structured_output'] = structured_output
        if not omit_usage and step_usages is None:
            res['usage'] = {
                'input_tokens': 10302, 'output_tokens': 582, 'thinking_tokens': 551,
                'cache_read_tokens': 8113, 'total_tokens': 10884,
            } if usage is None else usage
        if quota_info is not None:
            res['quota_info'] = quota_info
        events.append({'event': 'result', 'result': res})
    return {
        'returncode': returncode,
        'stdout': '\n'.join(json.dumps(e) for e in events) + '\n',
        'stderr': stderr,
    }


class MockTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, command, *, cwd, env, stdin, timeout_seconds, max_output_bytes):
        cwd_entries = list(Path(cwd).iterdir())
        schema_arg = command[command.index('--json-schema') + 1] if '--json-schema' in command else None
        schema_file_content = None
        if schema_arg and not schema_arg.lstrip().startswith('{'):
            schema_path = Path(schema_arg)
            if schema_path.is_file():
                schema_file_content = schema_path.read_text(encoding='utf-8')
        self.calls.append({
            'command': list(command),
            'cwd': cwd,
            'cwd_empty': len(cwd_entries) == 0,
            'env': dict(env),
            'stdin': stdin,
            'timeout_seconds': timeout_seconds,
            'max_output_bytes': max_output_bytes,
            'schema_file_content': schema_file_content,
        })
        if not self.responses:
            raise AssertionError('Unexpected extra CLI call')
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def _backend(transport, **kwargs):
    return AgyBackend(
        kwargs.pop('max_calls', 3),
        kwargs.pop('timeout_seconds', 180),
        kwargs.pop('max_prompt_chars', 100000),
        model=kwargs.pop('model', DEFAULT_MODEL),
        effort=kwargs.pop('effort', DEFAULT_EFFORT),
        max_tokens=kwargs.pop('max_tokens', 32000),
        max_images=kwargs.pop('max_images', 64),
        transport=transport,
        executable=kwargs.pop('executable', ['/usr/local/bin/agy']),
        **kwargs,
    )


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


class ContractAndCommandTests(unittest.TestCase):
    def test_constructor_signature_bounds_and_capability_config(self):
        engine = AgyBackend(4, 300, 400000, model='gemini-4-neon-high', effort='high', max_tokens=32000, max_images=64)
        self.assertEqual((engine.model, engine.effort, engine.max_calls), ('gemini-4-neon-high', 'high', 4))
        self.assertEqual((engine.timeout_seconds, engine.max_prompt_chars, engine.max_tokens, engine.max_images),
                         (300.0, 400000, 32000, 64))
        self.assertEqual(engine.capability_config['provider'], PROVIDER)
        self.assertEqual(engine.capability_config['retries'], 0)
        self.assertIs(engine.capability_config['multimodal_input'], False)
        self.assertIn('gemini-4-neon-high', repr(engine))

        with self.assertRaisesRegex(ValueError, '^budget_exhausted$'):
            AgyBackend(0, 180, 100000)
        for bad in [
            {'model': 'gpt-6.2-astra'},
            {'model': 'claude-opus-5-5'},
            {'model': '-rf'},
            {'effort': 'none'},
            {'effort': 'maximum'},
            {'timeout_seconds': 0},
            {'timeout_seconds': True},
            {'max_prompt_chars': 0},
            {'max_tokens': 0},
            {'max_images': 0},
        ]:
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, '^config_error$'):
                AgyBackend(**bad)

    def test_flags_empty_cwd_clean_env_stdin_prompt_and_usage(self):
        secret_prompt = 'UNIQUE_PROMPT_PAYLOAD_928374'
        transport = MockTransport([
            _agy_stream(
                '{"status":"ok","items":["a"]}',
                structured_output={'status': 'ok', 'items': ['a']},
            )
        ])
        dirty_env = {
            'OPENAI_API_KEY': 'sk-openai-secret',
            'ANTHROPIC_API_KEY': 'sk-ant-secret',
            'GEMINI_API_KEY': 'AIzaSyFakeKey12345678901234567890',
            'GOOGLE_API_KEY': 'AIzaSyOtherKey12345678901234567890',
            'GOOGLE_GENAI_USE_VERTEXAI': 'true',
            'VERTEX_PROJECT': 'proj-x',
            'CLAUDE_CODE_OAUTH_TOKEN': 'oauth-secret',
            'AWS_BEARER_TOKEN_BEDROCK': 'aws-secret',
            'AWS_SECRET_ACCESS_KEY': 'aws-sec',
            'STACKBITE_TOKEN': 'sb-secret',
            'FALSIFY_TOKEN': 'falsify-secret',
            'HOSTED_AI_SERVICE_TOKEN': 'hosted-secret',
            'CLOUDFLARE_API_TOKEN': 'cf-secret',
            'GOOGLE_APPLICATION_CREDENTIALS': '/tmp/gcp-creds.json',
            'CUSTOM_AUTH_TOKEN': 'tok-secret',
            'CUSTOM_SECRET_KEY': 'sec-secret',
            'KEEP_OAUTH_HOME': '/home/tester',
        }
        with patch.dict(os.environ, dirty_env):
            engine = _backend(transport)
            result = engine.infer(secret_prompt, SCHEMA)

        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['response'], {'status': 'ok', 'items': ['a']})
        self.assertEqual(result['provider'], 'agy-cli')
        self.assertEqual(result['model'], 'gemini-4-neon-high')
        self.assertEqual(result['effort'], 'high')
        self.assertEqual(result['provider_model'], 'gemini-4-neon-high')
        self.assertEqual(result['observed_models'], ['gemini-4-neon-high'])
        self.assertEqual(result['observed_tool_calls'], 0)
        self.assertEqual(result['observed_event_types'], ['init', 'result', 'step_update'])
        self.assertIs(result['retryable'], False)
        self.assertIsNone(result['request_id'])
        self.assertEqual(result['usage'], {
            'input_tokens': 10302,
            'output_tokens': 582,
            'thinking_tokens': 551,
            'cache_read_input_tokens': 8113,
            'total_tokens': 10884,
        })

        self.assertEqual(len(transport.calls), 1)
        call = transport.calls[0]
        cmd = call['command']
        self.assertTrue(call['cwd_empty'])
        self.assertEqual(cmd[cmd.index('--input-format') + 1], 'stream-json')
        self.assertEqual(cmd[cmd.index('--output-format') + 1], 'stream-json')
        self.assertEqual(cmd[cmd.index('--model') + 1], 'gemini-4-neon-high')
        self.assertEqual(cmd[cmd.index('--effort') + 1], 'high')
        self.assertIn('--disable-slash-commands', cmd)
        self.assertNotIn('--continue', cmd)
        self.assertNotIn('-c', cmd)
        self.assertNotIn('--conversation', cmd)
        self.assertNotIn('--dangerously-skip-permissions', cmd)
        self.assertFalse(any(secret_prompt in arg for arg in cmd))

        settings = json.loads(cmd[cmd.index('--settings') + 1])
        self.assertEqual(settings['toolPermission'], 'strict')
        self.assertEqual(settings['agentMode'], '')
        self.assertIs(settings['allowNonWorkspaceAccess'], False)
        self.assertIs(settings['useG1Credits'], False)
        self.assertEqual(settings['modelProvider'], '')
        self.assertEqual(settings['permissions']['allow'], [])
        self.assertEqual(settings['permissions']['ask'], [])
        for denied in ('command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'):
            self.assertIn(denied, settings['permissions']['deny'])

        stdin_obj = json.loads(call['stdin'])
        self.assertEqual(stdin_obj['event'], 'user')
        self.assertIn(secret_prompt, stdin_obj['message']['content'])

        for key in dirty_env:
            if key == 'KEEP_OAUTH_HOME':
                self.assertEqual(call['env'][key], '/home/tester')
            else:
                self.assertNotIn(key, call['env'])

    def test_large_schema_uses_separate_temp_file_keeping_cwd_empty(self):
        large_schema = {
            'type': 'object',
            'properties': {
                'status': {'type': 'string', 'enum': ['ok'], 'description': 'd' * 36000},
            },
            'required': ['status'],
            'additionalProperties': False,
        }
        transport = MockTransport([_agy_stream('{"status":"ok"}', structured_output={'status': 'ok'})])
        result = _backend(transport).infer('Check.', large_schema)
        self.assertEqual(result['status'], 'ok')
        call = transport.calls[0]
        self.assertTrue(call['cwd_empty'])
        schema_arg = call['command'][call['command'].index('--json-schema') + 1]
        self.assertNotEqual(Path(schema_arg).parent.resolve(), Path(call['cwd']).resolve())
        self.assertEqual(json.loads(call['schema_file_content']), large_schema)


class UsageAndSchemaTests(unittest.TestCase):
    def test_cli_observation_null_usage_fields_are_omitted_not_fabricated(self):
        obs_usage = {
            'input_tokens': 2141,
            'output_tokens': 26,
            'thinking_tokens': None,
            'cache_read_tokens': None,
            'total_tokens': 2167,
        }
        transport = MockTransport([
            _agy_stream(
                '{"status":"ok","items":["a"]}',
                permission_mode=None,
                tools=None,
                usage=obs_usage,
            )
        ])
        result = _backend(transport).infer('Check.', SCHEMA)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['usage'], {'input_tokens': 2141, 'output_tokens': 26, 'total_tokens': 2167})
        self.assertNotIn('thinking_tokens', result['usage'])
        self.assertNotIn('cache_read_input_tokens', result['usage'])

    def test_additive_cache_and_separate_thinking_and_step_fallback(self):
        additive = _agy_stream(
            '{"status":"ok","items":["a"]}',
            conversation_id='c-add',
            usage={'input_tokens': 1000, 'cache_read_tokens': 4000, 'output_tokens': 40, 'thinking_tokens': 200, 'total_tokens': 5240},
        )
        step_only = _agy_stream(
            '{"status":"ok","items":["a"]}',
            conversation_id='c-step',
            step_usages=[
                {'input_tokens': 500, 'output_tokens': 30, 'thinking_tokens': 20},
                {'input_tokens': 700, 'output_tokens': 50, 'thinking_tokens': 35},
            ],
        )
        partial_step = _agy_stream(
            '{"status":"ok","items":["a"]}',
            conversation_id='c-partial',
            step_usages=[{'input_tokens': 500, 'output_tokens': 30}, None],
        )
        engine = _backend(MockTransport([additive, step_only, partial_step]), max_calls=5)
        r1 = engine.infer('x', SCHEMA)
        self.assertEqual(r1['usage']['input_tokens'], 5000)
        self.assertEqual(r1['usage']['output_tokens'], 240)
        self.assertEqual(r1['usage']['thinking_tokens'], 200)
        self.assertEqual(r1['usage']['cache_read_input_tokens'], 4000)

        r2 = engine.infer('x', SCHEMA)
        self.assertEqual(r2['usage'], {'input_tokens': 1200, 'output_tokens': 80, 'thinking_tokens': 55})

        r3 = engine.infer('x', SCHEMA)
        self.assertEqual(r3['usage'], {})

    def test_fenced_json_and_all_real_blue_schemas_without_mutating_schema(self):
        schemas = (
            blue_service.RESULT,
            blue_service.result_schema(review_limits.HOSTED),
            blue_service.result_schema(review_limits.HOSTED, allow_occurrence=True),
            blue_service.SCAN,
            blue_service.SELECTION,
        )
        for idx, schema in enumerate(schemas):
            before = _digest(schema)
            if 'findings' in schema['properties']:
                payload = {'status': 'ok', 'findings': []}
            elif 'summary' in schema['properties']:
                payload = {'status': 'ok', 'summary': 'ok', 'evidence': []}
            else:
                payload = {'status': 'ok', 'targets': []}
            fenced = '```json\n' + json.dumps(payload) + '\n```'
            result = _backend(MockTransport([_agy_stream(fenced, conversation_id=f'c-{idx}')])).infer('Check.', schema)
            self.assertEqual(result['status'], 'ok', result['error_code'])
            self.assertEqual(result['response'], payload)
            self.assertEqual(_digest(schema), before)


class StrictValidationAndRetryErrorTests(unittest.TestCase):
    def test_strict_model_result_schema_and_tool_boundary_rejections(self):
        cases = [
            ('missing_model', _agy_stream('{"status":"ok","items":["a"]}', model=None)),
            ('wrong_model', _agy_stream('{"status":"ok","items":["a"]}', model='gemini-4-argon-high')),
            ('missing_result', _agy_stream('{"status":"ok","items":["a"]}', include_result=False)),
            ('duplicate_result', _agy_stream(
                '{"status":"ok","items":["a"]}',
                extra_events=[{'event': 'result', 'result': {'status': 'SUCCESS', 'response': '{"status":"ok","items":["a"]}'}}],
            )),
            ('bad_permission_mode', _agy_stream('{"status":"ok","items":["a"]}', permission_mode='auto')),
            ('mcp_servers', _agy_stream('{"status":"ok","items":["a"]}', mcp_servers=['evil-mcp'])),
            ('mcp_tool_advertised', _agy_stream('{"status":"ok","items":["a"]}', tools=['mcp__fs_read'])),
            ('tool_step', _agy_stream(
                '{"status":"ok","items":["a"]}',
                extra_events=[{'event': 'step_update', 'step_update': {'step_type': 'tool', 'tool_name': 'read_file'}}],
            )),
            ('subagent_step', _agy_stream(
                '{"status":"ok","items":["a"]}',
                extra_events=[{'event': 'step_update', 'step_update': {'step_type': 'subagent', 'subagent_info': {'role': 'x'}}}],
            )),
            ('headless_tool_denial', _agy_stream(
                '{"status":"ok","items":["a"]}',
                stderr='Tool read_file was auto-denied by permission rule',
            )),
            ('schema_violation', _agy_stream('{"status":"ok","items":[]}', structured_output={'status': 'ok', 'items': []})),
            ('extra_key_violation', _agy_stream('{"status":"ok","items":["a"],"extra":1}')),
            ('duplicate_json_key', _agy_stream('{"status":"ok","status":"abstain","items":["a"]}')),
            ('nonfinite_json', _agy_stream('{"status":"ok","items":[NaN]}')),
            ('empty_response', _agy_stream('   ')),
            ('waiting_status', _agy_stream('{"status":"ok","items":["a"]}', status='WAITING')),
            ('malformed_ndjson', {'returncode': 0, 'stdout': 'not-json\n', 'stderr': ''}),
        ]
        for label, payload in cases:
            with self.subTest(label=label):
                result = _backend(MockTransport([payload])).infer('Check.', SCHEMA)
                self.assertEqual(result['status'], 'error')
                self.assertEqual(result['error_code'], 'protocol_violation')
                self.assertIs(result['retryable'], False)
                if label in ('tool_step', 'subagent_step', 'headless_tool_denial'):
                    self.assertGreater(result['observed_tool_calls'], 0)
                failure = hosted_service._failure(hosted_service._classify_engine_error(
                    harness_adapter.cli_failure(result['error_code'])))
                self.assertEqual(failure['code'], 'invalid_output')
                self.assertIs(failure['retryable'], False)

        not_object = _backend(MockTransport([_agy_stream('["a"]', structured_output=['a'])])).infer('Check.', SCHEMA)
        self.assertEqual((not_object['status'], not_object['error_code'], not_object['retryable']),
                         ('error', 'response_not_object', False))
        self.assertEqual(harness_adapter.cli_failure(not_object['error_code']).code, 'invalid_output')

    def test_reused_conversation_id_across_calls_is_rejected(self):
        transport = MockTransport([
            _agy_stream('{"status":"ok","items":["a"]}', conversation_id='same-conv'),
            _agy_stream('{"status":"ok","items":["a"]}', conversation_id='same-conv'),
        ])
        engine = _backend(transport, max_calls=2)
        self.assertEqual(engine.infer('first', SCHEMA)['status'], 'ok')
        second = engine.infer('second', SCHEMA)
        self.assertEqual((second['status'], second['error_code'], second['retryable']),
                         ('error', 'protocol_violation', False))

    def test_retryable_and_non_retryable_errors_match_hosted_retry_pipeline(self):
        cases = [
            ('timeout', TimeoutError('timeout'), 'timeout', 'timeout', True, 'timeout'),
            ('rate_limited_stderr', _agy_stream('', status='ERROR', returncode=1,
                                                stderr='429 RESOURCE_EXHAUSTED retry-after: 42 bearer ya29.secret'),
             'error', 'rate_limited', True, 'rate_limited'),
            ('overloaded_stderr', _agy_stream('', status='ERROR', returncode=1,
                                              stderr='503 Service Unavailable model overloaded'),
             'error', 'overloaded', True, 'provider_unavailable'),
            ('cli_error', _agy_stream('', status='ERROR', returncode=1, error='internal backend crash secret_xyz'),
             'error', 'provider_error', True, 'provider_unavailable'),
            ('interrupted', _agy_stream('', status='INTERRUPTED', returncode=143),
             'error', 'provider_error', True, 'provider_unavailable'),
            ('transport_oserror', OSError('broken pipe secret_pipe'),
             'error', 'transport_error', True, 'provider_unavailable'),
            ('auth_required', _agy_stream('', status='ERROR', returncode=1, stderr='401 Authentication required: please sign in'),
             'error', 'auth_required', False, 'auth_required'),
            ('missing_binary', FileNotFoundError('agy_unavailable'),
             'error', 'config_error', False, 'provider_not_configured'),
            ('refusal', _agy_stream('', status='REFUSED', finished_reason='safety', returncode=0),
             'error', 'invalid_request', False, 'provider_rejected'),
            ('output_limit', ValueError('output_limit'),
             'error', 'output_limit', False, 'invalid_output'),
        ]
        for label, resp, exp_status, exp_code, exp_retryable, exp_hosted_code in cases:
            with self.subTest(label=label):
                result = _backend(MockTransport([resp])).infer('Check.', SCHEMA)
                self.assertEqual((result['status'], result['error_code'], result['retryable']),
                                 (exp_status, exp_code, exp_retryable))
                dumped = json.dumps(result)
                self.assertNotIn('ya29.secret', dumped)
                self.assertNotIn('secret_xyz', dumped)
                self.assertNotIn('secret_pipe', dumped)
                if label == 'rate_limited_stderr':
                    self.assertEqual(result['retry_after'], '42')
                adapted = harness_adapter.cli_failure(result['error_code'])
                hosted_failure = hosted_service._failure(hosted_service._classify_engine_error(adapted))
                self.assertEqual(hosted_failure['code'], exp_hosted_code)
                self.assertEqual(hosted_failure['retryable'], exp_retryable)

    def test_budget_cancellation_and_preflight_limits_make_no_cli_call(self):
        transport = MockTransport([_agy_stream('{"status":"ok","items":["a"]}', structured_output={'status': 'ok', 'items': ['a']})])
        engine = _backend(transport, max_calls=1)
        self.assertEqual(engine.infer('x', SCHEMA)['status'], 'ok')
        exhausted = engine.infer('x', SCHEMA)
        self.assertEqual((exhausted['status'], exhausted['error_code'], exhausted['retryable']),
                         ('budget_exhausted', 'budget_exhausted', False))
        self.assertEqual(len(transport.calls), 1)

        empty_transport = MockTransport([])
        cancelled = _backend(empty_transport, cancelled=lambda: True).infer('x', SCHEMA)
        self.assertEqual((cancelled['status'], cancelled['error_code'], cancelled['retryable']),
                         ('cancelled', 'cancelled', False))
        self.assertEqual(_backend(empty_transport, max_prompt_chars=5).infer('123456', SCHEMA)['error_code'], 'prompt_limit')
        self.assertEqual(_backend(empty_transport).infer('', SCHEMA)['error_code'], 'prompt_limit')
        self.assertEqual(_backend(empty_transport).infer('x', ['not-dict'])['error_code'], 'schema_limit')
        self.assertEqual(_backend(empty_transport).infer('x', {'type': 'object', 'required': 'bad'})['error_code'], 'schema_limit')
        with patch.object(agy_backend, 'discover_agy', side_effect=FileNotFoundError('agy_unavailable')):
            missing = AgyBackend(transport=empty_transport).infer('x', SCHEMA)
            self.assertEqual((missing['error_code'], missing['retryable']), ('config_error', False))
        self.assertEqual(len(empty_transport.calls), 0)

    def test_infer_visual_refuses_without_dropping_images_or_calling_cli(self):
        transport = MockTransport([])
        engine = _backend(transport, max_calls=2)
        direct = engine.infer_visual('Inspect chart.', SCHEMA, [PNG_BYTES])
        self.assertEqual((direct['status'], direct['error_code'], direct['retryable'], direct['provider']),
                         ('error', 'invalid_request', False, 'agy-cli'))
        self.assertEqual(engine.calls, 0)
        self.assertEqual(len(transport.calls), 0)

        delegated = blue_visual.infer_visual(engine, 'Inspect chart.', SCHEMA, [PNG_BYTES])
        self.assertEqual((delegated['status'], delegated['error_code'], delegated['retryable']),
                         ('error', 'invalid_request', False))
        self.assertEqual(engine.calls, 0)
        self.assertEqual(len(transport.calls), 0)
        self.assertEqual(harness_adapter.cli_failure(delegated['error_code']).code, 'provider_rejected')


class HostedBlueEnvelopeIntegrationTests(unittest.TestCase):
    def test_hosted_booth_blue_envelope_text_and_structured_paper_evidence(self):
        text = 'Sample size was n = 40 in Methods, whereas Results report n = 48 participants.'
        source_hash = hashlib.sha256(text.encode('utf-8')).hexdigest()
        file_hash = hashlib.sha256(b'%PDF-1.4 synthetic').hexdigest()
        segments = [{'id': 'p1', 'label': 'Page 1', 'text': text}]
        envelope = hosted_service.build_review_envelope(
            'blue',
            revision=file_hash,
            request_id='booth-req-1',
            source_hash=source_hash,
            segments=segments,
            prompt='Find explicit internal contradictions.',
            model='gemini-4-neon-high',
            effort='high',
            max_calls=4,
            paper_evidence={'paperId': 'paper-booth-1', 'fileHash': file_hash},
            file_hash=file_hash,
        )
        finding_payload = {
            'status': 'ok',
            'findings': [{
                'id': 'f1',
                'segmentId': 'p1',
                'quote': text,
                'rationale': 'Methods n = 40 conflicts with Results n = 48 and Table 1.',
                'evidence': [{'segmentId': 'p1', 'quote': 'n = 40 in Methods', 'relation': 'contradicts'}],
                'uncertainty': None,
            }],
        }
        transport = MockTransport([
            _agy_stream(
                json.dumps(finding_payload),
                conversation_id='booth-conv-1',
                structured_output=finding_payload,
            )
        ])
        fake_structured = {
            'text': 'TABLE T1: Cohort N=40 vs Results N=48',
            'coverage': {'tables': 1, 'figures': 0, 'truncated': False},
            'omittedItems': [],
        }

        with patch.dict(os.environ, {'HOSTED_AI_MODELS': 'gemini-4-neon-high', 'HOSTED_AI_DEFAULT_MODEL': 'gemini-4-neon-high'}), \
                patch.object(agy_backend, 'bounded_cli_transport', transport), \
                patch.object(agy_backend, 'discover_agy', return_value=['/usr/local/bin/agy']), \
                patch('paper_evidence_blue.context_for_review', return_value=fake_structured):
            review = blue_service.run_review(envelope, lambda _: None, threading.Event())

        self.assertEqual(review['schema'], 'falsify.document-blue.v1')
        self.assertEqual(review['status'], 'ok')
        self.assertEqual(len(review['findings']), 1)
        self.assertEqual(review['provider'], {'id': 'agy-cli', 'models': ['gemini-4-neon-high'], 'requestId': None})
        self.assertEqual(review['hostedSelection'], {
            'provider': 'agy-cli', 'model': 'gemini-4-neon-high', 'effort': 'high',
        })
        self.assertEqual(review['usage']['input_tokens'], 10302)
        self.assertEqual(review['usage']['output_tokens'], 582)
        self.assertEqual(review['usage']['thinking_tokens'], 551)
        self.assertEqual(review['usage']['cache_read_input_tokens'], 8113)
        self.assertEqual(review['coverage']['paperEvidence']['tables'], 1)
        self.assertEqual(len(transport.calls), 1)
        stdin_content = json.loads(transport.calls[0]['stdin'])['message']['content']
        self.assertIn('TABLE T1: Cohort N=40 vs Results N=48', stdin_content)
        self.assertTrue(transport.calls[0]['cwd_empty'])

    def test_bounded_cli_transport_real_subprocess_timeout_limit_and_cancel(self):
        with tempfile.TemporaryDirectory() as tmp:
            ok = bounded_cli_transport(
                [sys.executable, '-c', 'import sys; print(sys.stdin.read().strip())'],
                cwd=tmp, env=os.environ.copy(), stdin='hello\n',
                timeout_seconds=5, max_output_bytes=4096,
            )
            self.assertEqual((ok['returncode'], ok['stdout'].strip()), (0, 'hello'))

            with self.assertRaises(TimeoutError):
                bounded_cli_transport(
                    [sys.executable, '-c', 'import time; time.sleep(5)'],
                    cwd=tmp, env=os.environ.copy(), stdin='',
                    timeout_seconds=0.2, max_output_bytes=4096,
                )
            with self.assertRaisesRegex(ValueError, '^output_limit$'):
                bounded_cli_transport(
                    [sys.executable, '-c', 'print("x" * 10000)'],
                    cwd=tmp, env=os.environ.copy(), stdin='',
                    timeout_seconds=5, max_output_bytes=128,
                )
            cancel_flag = threading.Event()
            threading.Timer(0.1, cancel_flag.set).start()
            with self.assertRaisesRegex(ValueError, '^cancelled$'):
                bounded_cli_transport(
                    [sys.executable, '-c', 'import time; time.sleep(5)'],
                    cwd=tmp, env=os.environ.copy(), stdin='',
                    timeout_seconds=5, max_output_bytes=4096,
                    cancelled=cancel_flag.is_set,
                )


class LiveLocalAgyProbeTest(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('RUN_LIVE_AGY_PROBE') == '1', 'Set RUN_LIVE_AGY_PROBE=1 for live local AGY smoke')
    def test_real_local_agy_structured_json_probe(self):
        schema = {
            'type': 'object',
            'properties': {
                'status': {'type': 'string', 'enum': ['ok']},
                'findings': {'type': 'array', 'maxItems': 0},
            },
            'required': ['status', 'findings'],
            'additionalProperties': False,
        }
        engine = AgyBackend(1, 120, 20000, model='gemini-4-neon-high', effort='high', max_tokens=2048, max_images=1)
        result = engine.infer('Return {"status":"ok","findings":[]}.', schema)
        self.assertEqual(result['status'], 'ok', result)
        self.assertEqual(result['provider'], 'agy-cli')
        self.assertEqual(result['provider_model'], 'gemini-4-neon-high')
        self.assertEqual(result['response'], {'status': 'ok', 'findings': []})
        self.assertGreater(result['usage'].get('input_tokens', 0), 0)
        self.assertGreater(result['usage'].get('output_tokens', 0), 0)
        self.assertEqual(result['observed_tool_calls'], 0)


if __name__ == '__main__':
    unittest.main()
