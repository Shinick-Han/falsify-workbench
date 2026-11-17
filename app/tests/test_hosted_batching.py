"""Hosted coverage batching: more than 60 items, more than 20 images, and explicit partial coverage."""
import hashlib
import json
import re
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))

import anthropic_backend
import blue_service
import red_service
from anthropic_backend import AnthropicBackend

A = 'UNIQUE-A claim. ' + ('alpha sentence. ' * 4500)
B = 'UNIQUE-B claim. ' + ('beta sentence. ' * 4500)
SEGMENTS = [{'id': 's0', 'label': 'page 1', 'text': A}, {'id': 's1', 'label': 'page 2', 'text': B}]
SOURCE_HASH = hashlib.sha256('\n\n'.join([A, B]).encode('utf-8')).hexdigest()


def harness(role):
    return {'schema': 'falsify.harness.v1', 'id': 'hosted-anthropic', 'name': 'Hosted Anthropic',
            'version': '1', 'role': role, 'instructions': 'Review the supplied document.',
            'maxCalls': 64, 'adapter': {'type': 'hosted', 'model': 'claude-opus-5-5', 'effort': 'high'}}


def red_data(max_calls):
    return {'schema': 'falsify.document-red.v1', 'consent': True, 'revision': 'r1', 'requestId': 'req1',
            'segments': SEGMENTS, 'sourceHash': SOURCE_HASH, 'level': 4, 'maxCalls': max_calls,
            'harness': harness('red')}


def blue_data(max_calls):
    return {'schema': 'falsify.document-blue.v1', 'consent': True, 'revision': 'r1', 'requestId': 'req1',
            'segments': SEGMENTS, 'sourceHash': SOURCE_HASH, 'maxCalls': max_calls, 'harness': harness('blue')}


class BatchBackend:
    role = 'red'
    kwargs = None

    def __init__(self, *args, **kwargs):
        type(self).kwargs = kwargs

    def infer(self, prompt, schema):
        batch = int(re.search(r'"batch":\s*(\d+)', prompt).group(1))
        segment, token = (('s0', 'UNIQUE-A claim.') if batch == 1 else ('s1', 'UNIQUE-B claim.'))
        if self.role == 'red':
            items = [{'id': 'c%d-%d' % (batch, i), 'segmentId': segment, 'attackTypes': ['contradiction'],
                      'before': token, 'after': token + ' revised', 'rationale': 'Numeric claim changed.',
                      'uncertainty': None,
                      'evidence': [{'segmentId': segment, 'quote': token, 'relation': 'source'}]}
                     for i in range(35)]
            return {'status': 'ok', 'response': {'status': 'ok', 'candidates': items}}
        items = [{'id': 'f%d-%d' % (batch, i), 'segmentId': segment, 'quote': token,
                  'rationale': 'Finding %d is a distinct defect.' % i, 'uncertainty': None,
                  'evidence': [{'segmentId': segment, 'quote': token, 'relation': 'source'}]}
                 for i in range(35)]
        return {'status': 'ok', 'response': {'status': 'ok', 'findings': items}}


class BlueBatchBackend(BatchBackend):
    role = 'blue'


class HostedBatchTests(unittest.TestCase):
    def test_red_accumulates_more_than_sixty_candidates(self):
        result = red_service.run_review(red_data(2), lambda _: None, threading.Event(), hosted_factory=BatchBackend)
        self.assertEqual(len(result['candidates']), 70)
        self.assertTrue(result['coverage']['complete'])
        self.assertEqual(result['coverage']['completedBatches'], 2)
        self.assertEqual(result['coverage']['resultCoverage']['accepted'], 70)
        self.assertEqual(BatchBackend.kwargs['max_tokens'], 32000)

    def test_red_budget_reports_remaining_batches_instead_of_truncating_silently(self):
        result = red_service.run_review(red_data(1), lambda _: None, threading.Event(), hosted_factory=BatchBackend)
        self.assertEqual(len(result['candidates']), 35)
        self.assertFalse(result['coverage']['complete'])
        self.assertEqual(result['coverage']['completedBatches'], 1)
        self.assertEqual(result['coverage']['remainingBatches'][0]['index'], 2)

    def test_blue_accumulates_more_than_sixty_findings(self):
        result = blue_service.run_review(blue_data(2), lambda _: None, threading.Event(), hosted_factory=BlueBatchBackend)
        self.assertEqual(len(result['findings']), 70)
        self.assertTrue(result['coverage']['complete'])
        self.assertEqual(result['coverage']['resultCoverage']['accepted'], 70)
        self.assertEqual(BlueBatchBackend.kwargs['max_images'], 64)

    def test_blue_budget_reports_remaining_text_batches(self):
        result = blue_service.run_review(blue_data(1), lambda _: None, threading.Event(), hosted_factory=BlueBatchBackend)
        self.assertEqual(len(result['findings']), 35)
        self.assertFalse(result['coverage']['complete'])
        self.assertEqual(result['coverage']['completedPairs'], 1)
        self.assertEqual(result['coverage']['remainingBatches'][0]['textBatch'], 2)

    def test_image_batches_cover_more_than_twenty_images(self):
        images = [bytes([i]) for i in range(24)]
        groups = blue_service.image_batches(images, 8)
        self.assertEqual([len(group) for group in groups], [8, 8, 8])
        self.assertEqual(sum(len(group) for group in groups), 24)
        self.assertEqual(blue_service.image_batches([], 8), [[]])

    def test_hosted_blue_splits_twenty_four_images_into_provider_batches(self):
        calls = []

        def invoke(prompt, schema, phase, images=(), refs=()):
            calls.append(len(images))
            return {'status': 'ok', 'findings': [], 'visualObservations': []}

        limits = dict(__import__('review_limits').hosted_profile())
        data = blue_data(3)
        result = blue_service._run_hosted_blue(
            data, [SEGMENTS], list(range(24)), [{'id': 'r%d' % i} for i in range(24)],
            'policy', 'final', invoke, threading.Event(), limits, harness('blue'), 'hash',
            {}, {'request_id': None, 'models': set()}, [])
        self.assertEqual(calls, [8, 8, 8])
        self.assertTrue(result['coverage']['complete'])
        self.assertEqual(result['coverage']['imageBatches'], 3)

    def test_provider_backend_accepts_twenty_four_images_in_one_request(self):
        calls = []

        def transport(request, timeout):
            calls.append(request)
            return {'status': 200, 'headers': {}, 'body': json.dumps({
                'model': 'claude-opus-5-5', 'stop_reason': 'end_turn',
                'content': [{'type': 'text', 'text': '{"status":"ok"}'}],
                'usage': {'input_tokens': 1, 'output_tokens': 1}}).encode()}

        schema = {'type': 'object', 'properties': {'status': {'type': 'string'}}, 'required': ['status'],
                  'additionalProperties': False}
        images = [b'\x89PNG\r\n\x1a\n' + bytes([i]) + b'x' * 30 for i in range(24)]
        engine = AnthropicBackend(max_calls=1, key='test-key', workspace='ws', endpoint='https://api.anthropic.com',
                                  transport=transport, max_images=64)
        result = engine.infer_visual('Review the supplied images.', schema, images)
        self.assertEqual(result['status'], 'ok')
        blocks = calls[0]['body']['messages'][0]['content']
        self.assertEqual(sum(1 for block in blocks if block['type'] == 'image'), 24)


if __name__ == '__main__':
    unittest.main()
