"""Hosted execution profile: wider batching, partial results and re-anchored BLUE locations (offline fakes)."""
import hashlib
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))

import blue_service
import red_service

TEXT = 'Group A had p = 0.04. Group B had p = 0.04. The conclusion claims the treatment is effective.'
SEGMENTS = [{'id': 's0', 'label': 'page 1', 'text': TEXT}]
SOURCE_HASH = hashlib.sha256(TEXT.encode('utf-8')).hexdigest()


def hosted(role, max_calls=64, model='claude-opus-5-5', effort='high'):
    return {'schema': 'falsify.harness.v1', 'id': 'hosted-anthropic', 'name': 'Hosted Anthropic',
            'version': '1', 'role': role, 'instructions': 'Review the supplied document.',
            'maxCalls': max_calls, 'adapter': {'type': 'hosted', 'model': model, 'effort': effort}}


def red_data(**extra):
    return {'schema': 'falsify.document-red.v1', 'consent': True, 'revision': 'r1', 'requestId': 'req1',
            'segments': SEGMENTS, 'sourceHash': SOURCE_HASH, 'level': 4, 'maxCalls': 32,
            'harness': hosted('red'), **extra}


def blue_data(**extra):
    return {'schema': 'falsify.document-blue.v1', 'consent': True, 'revision': 'r1', 'requestId': 'req1',
            'segments': SEGMENTS, 'sourceHash': SOURCE_HASH, 'maxCalls': 8,
            'harness': hosted('blue'), **extra}


def candidate(index, before='Group A had p = 0.04', after='Group A had p = 0.40'):
    return {'id': 'c' + str(index), 'segmentId': 's0', 'level': 1, 'before': before, 'after': after,
            'attackTypes': ['contradiction'], 'rationale': 'The value changes.', 'uncertainty': None,
            'evidence': [{'segmentId': 's0', 'quote': 'Group A had p = 0.04', 'relation': 'source'}]}


def finding(fid, quote, occurrence=None):
    value = {'id': fid, 'segmentId': 's0', 'quote': quote, 'rationale': 'Related statements differ.',
             'uncertainty': None,
             'evidence': [{'segmentId': 's0', 'quote': 'Group A had p = 0.04', 'relation': 'source'}]}
    if occurrence is not None:
        value['occurrence'] = occurrence
    return value


class Fake:
    calls = 0
    prompts = []
    schemas = []

    def __init__(self, *args, **kwargs):
        type(self).calls += 1

    def infer(self, prompt, schema):
        type(self).prompts.append(prompt)
        type(self).schemas.append(schema)
        response = type(self).response
        return {'status': 'ok', 'response': response}


class HostedRedTests(unittest.TestCase):
    def test_hosted_budget_and_candidate_batch_exceed_legacy_limits(self):
        class Batch(Fake):
            response = {'status': 'ok', 'candidates': [candidate(i) for i in range(14)]}
        Batch.prompts, Batch.schemas = [], []
        result = red_service.run_review(red_data(), lambda _: None, threading.Event(), hosted_factory=Batch)
        self.assertEqual(len(result['candidates']), 14)
        self.assertEqual(result['coverage']['resultCoverage']['accepted'], 14)
        self.assertEqual(Batch.schemas[0]['properties']['candidates']['maxItems'], 40)
        self.assertIn('up to 40 candidates', Batch.prompts[0])

    def test_one_invalid_candidate_keeps_the_valid_results(self):
        bad = candidate(1)
        bad['evidence'] = [{'segmentId': 's0', 'quote': 'not in source', 'relation': 'source'}]
        class Mixed(Fake):
            response = {'status': 'ok', 'candidates': [candidate(0), bad, candidate(2)]}
        result = red_service.run_review(red_data(), lambda _: None, threading.Event(), hosted_factory=Mixed)
        self.assertEqual([c['id'] for c in result['candidates']], ['c0', 'c2'])
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['coverage']['resultCoverage']['rejected'], 1)
        self.assertEqual(result['coverage']['resultCoverage']['rejectedItems'][0]['code'], 'evidence_not_in_source')

    def test_one_bad_item_does_not_fail_the_job(self):
        class Bad(Fake):
            response = {'status': 'ok', 'candidates': [candidate(0, after='Group A had p = 0.04')]}
        result = red_service.run_review(red_data(), lambda _: None, threading.Event(), hosted_factory=Bad)
        self.assertEqual(result['candidates'], [])
        self.assertEqual(result['status'], 'abstain')
        self.assertEqual(result['coverage']['resultCoverage']['rejected'], 1)

    def test_local_profile_still_rejects_more_than_twelve(self):
        data = red_data()
        data.pop('harness')
        with self.assertRaises(ValueError):
            red_service.validate_request({**data, 'maxCalls': 33})


class HostedBlueTests(unittest.TestCase):
    def test_ambiguous_quote_is_an_explicit_location_request(self):
        class Ambiguous(Fake):
            response = {'status': 'ok', 'findings': [
                finding('f1', 'The conclusion claims the treatment is effective.'),
                finding('f2', 'p = 0.04'),
            ]}
        result = blue_service.run_review(blue_data(allowOccurrenceTargeting=True), lambda _: None, threading.Event(), hosted_factory=Ambiguous)
        self.assertEqual([f['id'] for f in result['findings']], ['f1'])
        self.assertEqual(result['coverage']['resultCoverage']['unresolvedItems'][0]['code'], 'ambiguous_location')
        self.assertIn('occurrence', Ambiguous.schemas[0]['properties']['findings']['items']['properties'])

    def test_occurrence_resolves_repeated_quote_and_span(self):
        class Occ(Fake):
            response = {'status': 'ok', 'findings': [finding('f1', 'p = 0.04', occurrence=1)]}
        result = blue_service.run_review(blue_data(allowOccurrenceTargeting=True), lambda _: None, threading.Event(), hosted_factory=Occ)
        start = TEXT.index('p = 0.04', TEXT.index('p = 0.04') + 1)
        self.assertEqual(result['findings'][0]['span'], [start, start + len('p = 0.04')])
        self.assertEqual(result['coverage']['resultCoverage']['unresolved'], 0)

    def test_invalid_finding_does_not_drop_valid_findings_and_uncertainty_is_optional(self):
        bad = finding('f2', 'invented quotation')
        class Mixed(Fake):
            response = {'status': 'ok', 'findings': [
                finding('f1', 'The conclusion claims the treatment is effective.'), bad,
                finding('f3', 'Group B had p = 0.04')]}
        result = blue_service.run_review(blue_data(), lambda _: None, threading.Event(), hosted_factory=Mixed)
        self.assertEqual([f['id'] for f in result['findings']], ['f1', 'f3'])
        self.assertIsNone(result['findings'][0]['uncertainty'])
        self.assertEqual(result['coverage']['resultCoverage']['rejected'], 1)
        self.assertEqual(Mixed.schemas[0]['properties']['findings']['maxItems'], 40)


if __name__ == '__main__':
    unittest.main()
