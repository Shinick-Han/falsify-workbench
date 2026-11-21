"""Offline regression tests for BLUE review completeness vs clean zero-finding semantics."""
import hashlib
import json
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))

import blue_service as blue

A = 'UNIQUE-A claim in abstract. ' + ('alpha prose sentence. ' * 4500)
B = 'UNIQUE-B claim in discussion. ' + ('beta prose sentence. ' * 4500)
TWO_BATCH_SEGMENTS = [
    {'id': 'p1-b1', 'label': 'page 1', 'text': A},
    {'id': 'p20-b1', 'label': 'page 20', 'text': B},
]
TWO_BATCH_HASH = hashlib.sha256('\n\n'.join([A, B]).encode('utf-8')).hexdigest()

LONG_A = 'UNIQUE-LONG-A claim. ' + ('first section prose. ' * 3500)
LONG_B = 'UNIQUE-LONG-B qualifier. ' + ('second section prose. ' * 3500)
LONG_SEGMENTS = [
    {'id': 'p1-b1', 'label': 'page 1', 'text': LONG_A},
    {'id': 'p12-b1', 'label': 'page 12', 'text': LONG_B},
]
LONG_HASH = hashlib.sha256('\n\n'.join([LONG_A, LONG_B]).encode('utf-8')).hexdigest()

SHORT_TEXT = 'Table 1 reports accuracy 0.85 across 120 samples. Conclusion states accuracy is 0.85.'
SHORT_SEGMENTS = [{'id': 'p1-b1', 'label': 'page 1', 'text': SHORT_TEXT}]
SHORT_HASH = hashlib.sha256(SHORT_TEXT.encode('utf-8')).hexdigest()


def hosted_harness(max_calls=8):
    return {
        'schema': 'falsify.harness.v1',
        'id': 'hosted-anthropic',
        'name': 'Hosted Anthropic',
        'version': '1',
        'role': 'blue',
        'instructions': 'Review the supplied document.',
        'maxCalls': max_calls,
        'adapter': {'type': 'hosted', 'model': 'claude-sonnet-5-5', 'effort': 'high'},
    }


def hosted_batch_request(segments, source_hash, max_calls=8):
    return {
        'schema': blue.VERSION,
        'consent': True,
        'revision': 'r1',
        'requestId': 'req1',
        'segments': segments,
        'sourceHash': source_hash,
        'maxCalls': max_calls,
        'harness': hosted_harness(max_calls=max(max_calls, 8)),
    }


def hosted_evidence_request(segments, source_hash, max_calls=8):
    fhash = 'ab' * 32
    return {
        **hosted_batch_request(segments, source_hash, max_calls=max_calls),
        'fileHash': fhash,
        'paperEvidence': {'paperId': 'paper-test-1', 'fileHash': fhash},
        'paperEvidenceConsent': True,
    }


def run_with_responses(data, responses):
    it = iter(responses)

    class FakeHosted:
        def __init__(self, *args, **kwargs):
            pass

        def infer(self, prompt, schema):
            item = next(it)
            resp = item(prompt, schema) if callable(item) else item
            return {'status': 'ok', 'response': resp}

    return blue.run_review(data, lambda _: None, threading.Event(), hosted_factory=FakeHosted)


def make_finding(fid, sid, quote):
    return {
        'id': fid,
        'segmentId': sid,
        'quote': quote,
        'rationale': 'Internal inconsistency found.',
        'uncertainty': None,
        'evidence': [{'segmentId': sid, 'quote': quote, 'relation': 'source'}],
    }


def pick_first_evidence_ref(prompt, _schema):
    marker = '{"allChunkNotes":'
    body = json.loads(prompt[prompt.rindex(marker):])
    ref = body['evidenceRefs'][0]
    return {
        'status': 'ok',
        'targets': [{'segmentId': ref['segmentId'], 'anchor': ref['id'], 'reason': 'verify claim'}],
    }


STRUCTURED = {
    'text': 'Table 1: synthetic structured evidence',
    'coverage': {'paperId': 'paper-test-1', 'fileHash': 'ab' * 32, 'omittedIds': [], 'truncated': False},
}


class HostedBatchReviewResultTests(unittest.TestCase):
    def test_clean_zero_findings_single_and_multi_batch_stay_ok(self):
        for segments, shash, n_calls in (
            (SHORT_SEGMENTS, SHORT_HASH, 1),
            (TWO_BATCH_SEGMENTS, TWO_BATCH_HASH, 2),
        ):
            res = run_with_responses(
                hosted_batch_request(segments, shash, max_calls=8),
                [{'status': 'ok', 'findings': []} for _ in range(n_calls)],
            )
            self.assertEqual(res['status'], 'ok')
            self.assertEqual(res['findings'], [])
            self.assertTrue(res['coverage']['complete'])
            self.assertEqual(res['coverage']['batchStatuses'], ['ok'] * n_calls)
            self.assertEqual(res['coverage']['resultCoverage']['modelStatus'], 'ok')
            self.assertEqual(res['coverage']['resultCoverage']['rejected'], 0)

    def test_partial_rejected_finding_does_not_block_valid_findings(self):
        good = make_finding('f1', 'p1-b1', 'UNIQUE-A claim in abstract.')
        bad = make_finding('f2', 'p1-b1', 'invented quote not in source')
        res = run_with_responses(
            hosted_batch_request(TWO_BATCH_SEGMENTS, TWO_BATCH_HASH, max_calls=8),
            [{'status': 'ok', 'findings': [good, bad]}, {'status': 'ok', 'findings': []}],
        )
        self.assertEqual(res['status'], 'ok')
        self.assertTrue(res['coverage']['complete'])
        self.assertEqual([f['id'] for f in res['findings']], ['f1'])
        self.assertEqual(res['coverage']['resultCoverage']['rejected'], 1)
        self.assertEqual(res['coverage']['resultCoverage']['modelStatus'], 'ok')

    def test_all_findings_rejected_abstains_while_preserving_model_status_ok(self):
        bad = make_finding('f1', 'p1-b1', 'invented quote not in source')
        res = run_with_responses(
            hosted_batch_request(SHORT_SEGMENTS, SHORT_HASH, max_calls=8),
            [{'status': 'ok', 'findings': [bad]}],
        )
        self.assertEqual(res['status'], 'abstain')
        self.assertEqual(res['findings'], [])
        self.assertTrue(res['coverage']['complete'])
        self.assertEqual(res['coverage']['resultCoverage']['modelStatus'], 'ok')
        self.assertEqual(res['coverage']['resultCoverage']['rejected'], 1)

    def test_batch_refusal_after_valid_batch_marks_coverage_incomplete(self):
        good = make_finding('f1', 'p1-b1', 'UNIQUE-A claim in abstract.')
        res = run_with_responses(
            hosted_batch_request(TWO_BATCH_SEGMENTS, TWO_BATCH_HASH, max_calls=8),
            [{'status': 'ok', 'findings': [good]}, {'status': 'refusal', 'findings': []}],
        )
        self.assertEqual([f['id'] for f in res['findings']], ['f1'])
        self.assertFalse(res['coverage']['complete'])
        self.assertEqual(res['coverage']['batchStatuses'], ['ok', 'refusal'])
        self.assertEqual(res['coverage']['resultCoverage']['modelStatus'], 'refusal')
        self.assertEqual(res['coverage']['resultCoverage']['rejectedItems'][0]['code'], 'model_refusal')
        self.assertIn('abstain or refusal', res['coverage']['meaning'])

    def test_first_batch_refusal_and_second_batch_empty_ok_returns_refusal_incomplete(self):
        res = run_with_responses(
            hosted_batch_request(TWO_BATCH_SEGMENTS, TWO_BATCH_HASH, max_calls=8),
            [{'status': 'refusal', 'findings': []}, {'status': 'ok', 'findings': []}],
        )
        self.assertEqual(res['status'], 'refusal')
        self.assertEqual(res['findings'], [])
        self.assertFalse(res['coverage']['complete'])
        self.assertEqual(res['coverage']['batchStatuses'], ['refusal', 'ok'])
        self.assertEqual(res['coverage']['resultCoverage']['modelStatus'], 'refusal')

    def test_budget_exhausted_with_zero_findings_is_incomplete(self):
        res = run_with_responses(
            hosted_batch_request(TWO_BATCH_SEGMENTS, TWO_BATCH_HASH, max_calls=1),
            [{'status': 'ok', 'findings': []}],
        )
        self.assertEqual(res['status'], 'ok')
        self.assertFalse(res['coverage']['complete'])
        self.assertEqual(len(res['coverage']['remainingBatches']), 1)
        self.assertEqual(res['coverage']['remainingBatches'][0]['textBatch'], 2)


class HostedEvidenceMultiChunkTests(unittest.TestCase):
    def test_clean_zero_findings_four_call_path_is_ok_and_complete(self):
        req = hosted_evidence_request(LONG_SEGMENTS, LONG_HASH, max_calls=8)
        with patch('paper_evidence_blue.context_for_review', return_value=STRUCTURED):
            res = run_with_responses(req, [
                {'status': 'ok', 'summary': 'Part 1 clean', 'evidence': []},
                {'status': 'ok', 'summary': 'Part 2 clean', 'evidence': []},
                pick_first_evidence_ref,
                {'status': 'ok', 'findings': []},
            ])
        self.assertEqual(res['status'], 'ok')
        self.assertEqual(res['findings'], [])
        self.assertTrue(res['coverage']['complete'])
        self.assertEqual(res['coverage']['reread']['status'], 'completed')
        self.assertEqual(res['coverage']['resultCoverage']['modelStatus'], 'ok')

    def test_selection_abstain_refusal_or_empty_marks_complete_false(self):
        req = hosted_evidence_request(LONG_SEGMENTS, LONG_HASH, max_calls=8)
        cases = [
            ({'status': 'abstain', 'targets': []}, 'abstain'),
            ({'status': 'refusal', 'targets': []}, 'refusal'),
            ({'status': 'ok', 'targets': []}, 'abstain'),
        ]
        for selection_response, expected_status in cases:
            with patch('paper_evidence_blue.context_for_review', return_value=STRUCTURED):
                res = run_with_responses(req, [
                    {'status': 'ok', 'summary': 'Part 1', 'evidence': []},
                    {'status': 'ok', 'summary': 'Part 2', 'evidence': []},
                    selection_response,
                ])
            self.assertEqual(res['status'], expected_status)
            self.assertFalse(res['coverage']['complete'])
            self.assertEqual(res['coverage']['reread']['status'], 'incomplete')
            self.assertEqual(res['coverage']['resultCoverage']['modelStatus'], expected_status)

    def test_hosted_scan_bad_quote_and_long_summary_do_not_crash_and_keep_valid_quote(self):
        req = hosted_evidence_request(LONG_SEGMENTS, LONG_HASH, max_calls=8)
        good_finding = make_finding('f1', 'p1-b1', 'UNIQUE-LONG-A claim.')

        def select_mixed(prompt, _schema):
            marker = '{"allChunkNotes":'
            body = json.loads(prompt[prompt.rindex(marker):])
            ref = body['evidenceRefs'][0]
            return {
                'status': 'ok',
                'targets': [
                    {'segmentId': 'p1-b1', 'anchor': 'NONEXISTENT ANCHOR', 'reason': 'bad anchor'},
                    {'segmentId': ref['segmentId'], 'anchor': ref['id'], 'reason': 'valid anchor'},
                ],
            }

        with patch('paper_evidence_blue.context_for_review', return_value=STRUCTURED):
            res = run_with_responses(req, [
                {
                    'status': 'ok',
                    'summary': 'S' * 2600,
                    'evidence': [
                        {'segmentId': 'p1-b1', 'quote': 'NOT IN SOURCE', 'relation': 'bad'},
                        {'segmentId': 'p1-b1', 'quote': 'UNIQUE-LONG-A claim.', 'relation': 'good'},
                    ],
                },
                {'status': 'ok', 'summary': 'Part 2 ok', 'evidence': []},
                select_mixed,
                {'status': 'ok', 'findings': [good_finding]},
            ])
        self.assertEqual(res['status'], 'ok')
        self.assertTrue(res['coverage']['complete'])
        self.assertEqual([f['id'] for f in res['findings']], ['f1'])

    def test_hosted_selection_all_bad_targets_abstains_incomplete_without_crashing(self):
        req = hosted_evidence_request(LONG_SEGMENTS, LONG_HASH, max_calls=8)
        with patch('paper_evidence_blue.context_for_review', return_value=STRUCTURED):
            res = run_with_responses(req, [
                {'status': 'ok', 'summary': 'Part 1', 'evidence': []},
                {'status': 'ok', 'summary': 'Part 2', 'evidence': []},
                {'status': 'ok', 'targets': [{'segmentId': 'p1-b1', 'anchor': 'BAD', 'reason': 'bad'}]},
            ])
        self.assertEqual(res['status'], 'abstain')
        self.assertFalse(res['coverage']['complete'])
        self.assertEqual(res['coverage']['reread']['status'], 'incomplete')

    def test_hosted_single_chunk_clean_zero_and_all_rejected(self):
        req = hosted_evidence_request(SHORT_SEGMENTS, SHORT_HASH, max_calls=8)
        with patch('paper_evidence_blue.context_for_review', return_value=STRUCTURED):
            clean = run_with_responses(req, [{'status': 'ok', 'findings': []}])
            self.assertEqual(clean['status'], 'ok')
            self.assertTrue(clean['coverage']['complete'])
            self.assertEqual(clean['coverage']['resultCoverage']['modelStatus'], 'ok')

            bad = make_finding('f1', 'p1-b1', 'invented text')
            all_bad = run_with_responses(req, [{'status': 'ok', 'findings': [bad]}])
            self.assertEqual(all_bad['status'], 'abstain')
            self.assertTrue(all_bad['coverage']['complete'])
            self.assertEqual(all_bad['coverage']['resultCoverage']['modelStatus'], 'ok')
            self.assertEqual(all_bad['coverage']['resultCoverage']['rejected'], 1)


if __name__ == '__main__':
    unittest.main()
