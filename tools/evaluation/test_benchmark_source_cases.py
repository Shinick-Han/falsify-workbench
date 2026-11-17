"""Corpus v5 source-native cases: conversion, refusals, and v4 invariance."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parents[1]
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import benchmark_source_cases as source_cases  # noqa: E402
import benchmark_suite as bench  # noqa: E402

PY_CCN_PATH = REPO_ROOT / 'tools' / 'quality' / 'python-functions.py'
REAL_SPEC = REPO_ROOT / 'tools' / 'corpus' / 'fixtures' / 'rct_minimal' / 'mutations' / 'm01-abstract-p.json'
TEXT = 'Treatment reduced the error rate relative to Control.'
HIDDEN = ('before', 'after', 'rationale', 'defectId', 'operationId', 'overridesApplied')


def _ready() -> bool:
    return not source_cases._toolchain_gaps()


def _keys(node, found: set) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            found.add(key)
            _keys(value, found)
    elif isinstance(node, list):
        for item in node:
            _keys(item, found)


def _pdf(text: str) -> bytes:
    import pymupdf

    doc = pymupdf.open()
    try:
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 72), text, fontsize=11)
        return doc.tobytes()
    finally:
        doc.close()


def _hand_case(pdf: bytes | None = None) -> dict:
    defect = {
        'family': 'S1',
        'difficulty': 'L2',
        'pageIndex': 0,
        'quote': TEXT,
    }
    for name in HIDDEN:
        defect[name] = 'sealed-value'
    bundle = {
        'caseId': 'sample-case',
        'mutationSetId': 'm-hand',
        'blindPdfBytes': pdf if pdf is not None else b'%PDF-1.4 hand\n',
        'goldLedger': {
            'schema': 'falsify.red-gold-ledger.v1',
            'producer': 'source-native',
            'defects': [defect],
        },
        'baselineSignals': {'signals': []},
    }
    return source_cases.case_from_source_bundle(bundle)


def _assert_public(test, report) -> None:
    found = set()
    _keys(report, found)
    test.assertTrue(found.isdisjoint(HIDDEN))


class BundleConversionTests(unittest.TestCase):
    def test_hand_built_bundle_dict_becomes_a_benchmark_case(self):
        case = _hand_case()
        self.assertEqual(case['caseId'], 'sample-case--m-hand')
        self.assertEqual(case['producer'], 'source-native')
        self.assertEqual(case['family'], 'S1')
        self.assertEqual(case['difficulty'], 'L2')
        self.assertEqual(case['world'], '')
        self.assertFalse(case['isHoldout'])
        self.assertEqual(case['supplements'], [])
        self.assertTrue(case['blindPdfBytes'].startswith(b'%PDF'))
        self.assertEqual(case['goldLedger']['schema'], bench.GOLD_SCHEMA)
        self.assertEqual(len(case['goldLedger']['defects']), 1)
        self.assertEqual(case['goldLedger']['defects'][0]['excerpt'], TEXT)
        self.assertEqual(case['goldLedger']['defects'][0]['family'], 'S1')
        self.assertEqual(case['goldLedger']['defects'][0]['difficulty'], 'L2')

    def test_gate_refusal_is_not_a_case(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = Path(tmp) / 'demo_case' / 'mutations' / 'm-bad.json'
            spec.parent.mkdir(parents=True)
            spec.write_text('{}', encoding='utf-8')

            def fake(spec_path, cache_dir):
                return ('demo-case', 'm-bad', {
                    'pass': False,
                    'failures': [{
                        'check': 'defect_survival',
                        'code': 'defect_not_visible',
                        'detail': 'sealed-value',
                    }],
                }, Path(tmp))

            with patch.object(source_cases, '_toolchain_gaps', lambda: []):
                with patch.object(source_cases, '_execute_spec', fake):
                    cases, status = source_cases.load_source_cases(tmp)
        self.assertEqual(cases, [])
        self.assertEqual(status['built'], [])
        self.assertEqual(status['skipped'], [])
        self.assertEqual(status['refused'], [{
            'caseId': 'demo-case',
            'mutationSetId': 'm-bad',
            'codes': ['defect_not_visible'],
        }])
        self.assertNotIn('sealed-value', json.dumps(status))

    def test_invalid_spec_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = Path(tmp) / 'demo_case' / 'mutations' / 'm-bad.json'
            spec.parent.mkdir(parents=True)
            spec.write_text('{', encoding='utf-8')
            with patch.object(source_cases, '_toolchain_gaps', lambda: []):
                cases, status = source_cases.load_source_cases(tmp)
        self.assertEqual(cases, [])
        self.assertEqual(status['refused'][0]['caseId'], 'demo_case')
        self.assertEqual(status['refused'][0]['mutationSetId'], 'm-bad')
        self.assertEqual(status['refused'][0]['codes'], ['schema_invalid'])

    def test_missing_toolchain_skips_and_second_call_uses_the_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            calls = {'n': 0}

            def gaps():
                calls['n'] += 1
                return ['pdflatex_missing']

            with patch.object(source_cases, '_toolchain_gaps', gaps):
                first = source_cases.load_source_cases(tmp)
                second = source_cases.load_source_cases(tmp)
        self.assertEqual(calls['n'], 1)
        expected = ([], {
            'built': [],
            'refused': [],
            'skipped': [{'reason': 'pdflatex_missing'}],
        })
        self.assertEqual(first, expected)
        self.assertEqual(second, expected)


class ReportShapeTests(unittest.TestCase):
    def test_v4_cases_keep_their_gold_when_a_source_case_is_appended(self):
        first = [(case['caseId'], case['goldLedger']) for case in bench.build_benchmark_corpus()]
        hand = _hand_case()
        selected, status = bench._select_corpus(None, None, 'v5', True, None, [hand], None)
        kept = [
            (case['caseId'], case['goldLedger'])
            for case in selected
            if case.get('producer') != 'source-native'
        ]
        self.assertEqual(kept, first)
        self.assertEqual(selected[-1]['caseId'], hand['caseId'])
        self.assertEqual(status['built'], [hand['caseId']])
        self.assertEqual(len(first), 32)

    def test_exclude_flag_scores_v4_and_records_the_reason(self):
        report = bench.run_benchmark_suite(
            mode='sensor',
            corpus_version='v5',
            include_source_cases=False,
            case_ids=['gold-w1-d1-stat-pvalue'],
        )
        self.assertEqual(report['corpusVersion'], 'v5')
        self.assertEqual(report['caseCount'], 1)
        self.assertEqual(report['caseResults'][0]['caseId'], 'gold-w1-d1-stat-pvalue')
        self.assertEqual(report['sourceCases'], {
            'built': [],
            'refused': [],
            'skipped': [{'reason': 'excluded'}],
        })
        self.assertIn('v4', report['goldSummary']['byProducer'])
        self.assertIn('source-native', report['goldSummary']['byProducer'])
        _assert_public(self, report)

    def test_cli_selectors(self):
        excluded = self._run('--no-source-cases', '--case', 'gold-w1-d1-stat-pvalue')
        self.assertEqual(excluded.returncode, 0, excluded.stderr)
        body = json.loads(excluded.stdout)
        self.assertEqual(body['corpusVersion'], 'v5')
        self.assertEqual(body['sourceCases']['skipped'], [{'reason': 'excluded'}])
        self.assertEqual(body['caseCount'], 1)

        selected = self._run('--corpus-version', 'v4', '--case', 'gold-w1-d1-stat-pvalue')
        self.assertEqual(selected.returncode, 0, selected.stderr)
        v4_body = json.loads(selected.stdout)
        self.assertEqual(v4_body['corpusVersion'], 'v4')
        self.assertNotIn('sourceCases', v4_body)
        self.assertNotIn('byProducer', v4_body['goldSummary'])
        _assert_public(self, body)
        _assert_public(self, v4_body)

        with tempfile.TemporaryDirectory() as tmp:
            seen = []

            def fake(root):
                seen.append(Path(root))
                return [], {'built': [], 'refused': [], 'skipped': []}

            with patch.object(bench, '_load_source_cases', fake):
                code = bench.main([
                    '--fixtures-root', tmp,
                    '--case', 'missing-source-case',
                ])
        self.assertEqual(code, 2)
        self.assertEqual(seen, [Path(tmp)])

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(EVAL_DIR / 'benchmark_suite.py'), *args],
            capture_output=True, text=True, check=False,
        )

    def test_producer_stratification_keeps_s1_and_is_deterministic(self):
        hand = _hand_case(_pdf(TEXT))
        base = next(
            case for case in bench.build_benchmark_corpus()
            if case['caseId'] == 'gold-w5-s1-direction-inversion'
        )
        status = {'built': [hand['caseId']], 'refused': [], 'skipped': []}
        kwargs = {
            'mode': 'sensor',
            'cases': [base, hand],
            'corpus_version': 'v5',
            'source_case_status': status,
        }
        first = bench.run_benchmark_suite(**kwargs)
        second = bench.run_benchmark_suite(**kwargs)
        self.assertEqual(first, second)
        self.assertEqual(first['goldSummary']['byFamily']['S1']['total'], 2)
        self.assertEqual(first['goldSummary']['byDifficulty']['L4']['total'], 1)
        self.assertEqual(first['goldSummary']['byDifficulty']['L2']['total'], 1)
        self.assertIn('D1', first['goldSummary']['byProducer']['v4']['byFamily'])
        producer = first['goldSummary']['byProducer']
        self.assertEqual(producer['v4']['byFamily']['S1']['total'], 1)
        self.assertEqual(producer['source-native']['byFamily']['S1']['total'], 1)
        self.assertEqual(producer['source-native']['byDifficulty']['L2']['total'], 1)
        _assert_public(self, first)

    def test_v4_portion_matches_an_explicit_v4_run(self):
        hand = _hand_case(_pdf(TEXT))
        v4 = bench.run_benchmark_suite(mode='sensor', corpus_version='v4')
        v5 = bench.run_benchmark_suite(mode='sensor', corpus_version='v5', source_cases=[hand])
        ids = {row['caseId'] for row in v4['caseResults']}
        portion = [row for row in v5['caseResults'] if row['caseId'] in ids]
        self.assertEqual(portion, v4['caseResults'])
        self.assertEqual(v5['holdoutSummary'], v4['holdoutSummary'])
        self.assertEqual(v5['goldSummary']['byProducer']['v4'], v4['goldSummary'])
        self.assertEqual(
            v5['goldSummary']['byFamily']['S1']['total'],
            v4['goldSummary']['byFamily']['S1']['total'] + 1,
        )
        self.assertEqual(v4['goldSummary']['byFamily']['D4-1']['total'], 2)
        self.assertEqual(v4['goldSummary']['byDifficulty']['L1']['recall'], 1.0)
        self.assertEqual(v4['goldSummary']['byDifficulty']['L2']['recall'], 1.0)
        self.assertEqual(v5['corpusVersion'], 'v5')
        self.assertEqual(v4['corpusVersion'], 'v4')
        self.assertNotIn('sourceCases', v4)
        self.assertNotIn('byProducer', v4['goldSummary'])
        self.assertIn(hand['caseId'], {row['caseId'] for row in v5['caseResults']})
        _assert_public(self, v5)


class RealBundleTests(unittest.TestCase):
    @unittest.skipUnless(_ready(), 'pdflatex, pymupdf, or matplotlib missing')
    def test_gate_passed_bundle_converts(self):
        case, refusal = source_cases.convert_mutation_spec(REAL_SPEC)
        self.assertIsNone(refusal)
        self.assertIsNotNone(case)
        self.assertEqual(case['caseId'], 'rct-minimal--m01-abstract-p')
        self.assertEqual(case['producer'], 'source-native')
        self.assertEqual(case['family'], 'D1')
        self.assertEqual(case['difficulty'], 'L3')
        self.assertFalse(case['isHoldout'])
        self.assertTrue(case['blindPdfBytes'].startswith(b'%PDF'))
        self.assertEqual(case['goldLedger']['schema'], bench.GOLD_SCHEMA)
        self.assertEqual(len(case['goldLedger']['defects']), 1)
        report = bench.run_benchmark_suite(
            mode='sensor',
            corpus_version='v5',
            source_cases=[case],
            case_ids=[case['caseId']],
        )
        self.assertEqual(report['caseCount'], 1)
        self.assertEqual(report['caseResults'][0]['caseId'], case['caseId'])
        self.assertEqual(report['caseResults'][0]['difficulty'], 'L3')
        _assert_public(self, report)


class ComplexityTests(unittest.TestCase):
    def test_new_modules_stay_within_ccn_gate(self):
        for path in (EVAL_DIR / 'benchmark_source_cases.py', EVAL_DIR / 'benchmark_suite.py'):
            proc = subprocess.run(
                [sys.executable, str(PY_CCN_PATH)],
                input=path.read_bytes(), capture_output=True, check=True,
            )
            functions = json.loads(proc.stdout.decode('utf-8'))
            violations = [
                {'id': fn['id'], 'ccn': fn['ccn']}
                for fn in functions
                if fn['ccn'] > 15
            ]
            self.assertEqual(violations, [])


if __name__ == '__main__':
    unittest.main()
