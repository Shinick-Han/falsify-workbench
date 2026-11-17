"""Order-swapped pre-adjudication of unmatched BLUE findings."""
from __future__ import annotations

import csv
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parents[1]
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import adjudication_swap as mod  # noqa: E402
import arena_runner  # noqa: E402

CLI_PATH = EVAL_DIR / 'adjudication_swap.py'
PY_CCN_PATH = REPO_ROOT / 'tools' / 'quality' / 'python-functions.py'
SCORE_KEYS = frozenset({'pureFp', 'recall', 'precision'})


def _finding(run_id, finding_id, quote, page=0, **extra):
    row = {'runId': run_id, 'findingId': finding_id, 'pageIndex': page, 'quote': quote}
    row.update(extra)
    return row


def _pass_ids(packet, pass_id):
    for block in packet['passes']:
        if block['passId'] == pass_id:
            return [item['itemId'] for item in block['items']]
    raise AssertionError(pass_id)


def _category_ids(packet, pass_id):
    for block in packet['passes']:
        if block['passId'] == pass_id:
            return [row['id'] for row in block['categories']]
    raise AssertionError(pass_id)


def _response(pass_id, pairs):
    return {
        'schema': mod.RESPONSE_SCHEMA,
        'passId': pass_id,
        'verdicts': [
            {'itemId': item_id, 'category': category, 'reason': 'noted'}
            for item_id, category in pairs
        ],
    }


def _keys(value, found):
    if isinstance(value, dict):
        for key, child in value.items():
            found.add(key)
            _keys(child, found)
    elif isinstance(value, list):
        for child in value:
            _keys(child, found)


def _assert_no_score_keys(testcase, payload):
    found = set()
    _keys(payload, found)
    testcase.assertFalse(SCORE_KEYS & found)


class PacketTests(unittest.TestCase):
    def _assert_categories(self, packet):
        cats_a = _category_ids(packet, 'A')
        cats_b = _category_ids(packet, 'B')
        self.assertEqual(cats_a, list(mod.CATEGORY_IDS))
        self.assertNotEqual(cats_b, cats_a)
        self.assertNotEqual(cats_b[0], cats_a[0])
        self.assertCountEqual(cats_b, cats_a)
        labels = {row['id']: row['label'] for row in packet['passes'][0]['categories']}
        self.assertEqual(labels['real_source_defect'], '실제 원문 결함')
        self.assertEqual(labels['spin_boundary'], '스핀/과장 경계')
        self.assertEqual(labels['gold_error'], '정답지 오류 (Gold v2 후보)')
        self.assertEqual(labels['pure_fp'], '순수 오탐')

    def _assert_instruction(self, packet):
        for block in packet['passes']:
            text = block['instruction']
            self.assertIn(mod.RESPONSE_SCHEMA, text)
            self.assertIn(f'"passId": "{block["passId"]}"', text)
            self.assertIn('exactly one category id', text)
            self.assertIn('"category": "abstain"', text)
            self.assertIn(block['categories'][0]['id'], text)

    def test_item_id_is_sha256_of_run_finding_and_quote(self):
        row = _finding('run', 'find', 'quote')
        packet = mod.prepare_packet([row], seed='locked')
        digest = hashlib.sha256(b'runfindquote').hexdigest()[:16]
        self.assertEqual(packet['items'][0]['itemId'], digest)
        self.assertNotIn('context', packet['items'][0])

    def test_packet_is_deterministic_and_orders_swap(self):
        one = [_finding('r', 'only', 'solo quote')]
        two = [_finding('r', 'a', 'alpha quote'), _finding('r', 'b', 'beta quote')]
        many = [_finding('r', f'f{index}', f'quote number {index} distinct') for index in range(6)]
        for seed in ('', 'seed-a', 'seed-b', '7'):
            single = mod.prepare_packet(one, seed=seed)
            self.assertEqual(single, mod.prepare_packet(one, seed=seed))
            self.assertEqual(_pass_ids(single, 'A'), _pass_ids(single, 'B'))
            self.assertEqual(_pass_ids(single, 'A'), [item['itemId'] for item in single['items']])
            self._assert_categories(single)
            self._assert_instruction(single)

            pair = mod.prepare_packet(two, seed=seed)
            self.assertEqual(pair, mod.prepare_packet(two, seed=seed))
            self.assertNotEqual(_pass_ids(pair, 'A'), _pass_ids(pair, 'B'))
            self.assertCountEqual(_pass_ids(pair, 'A'), _pass_ids(pair, 'B'))
            self._assert_categories(pair)

            wide = mod.prepare_packet(many, seed=seed)
            self.assertEqual(wide, mod.prepare_packet(many, seed=seed))
            self.assertNotEqual(_pass_ids(wide, 'A'), _pass_ids(wide, 'B'))
            self.assertCountEqual(_pass_ids(wide, 'A'), _pass_ids(wide, 'B'))
            self.assertEqual(_pass_ids(wide, 'A'), [item['itemId'] for item in wide['items']])
            self._assert_categories(wide)
            self.assertEqual(wide['modelCalls'], 0)
            self.assertEqual(wide['schema'], mod.PACKET_SCHEMA)

    def test_context_prefers_run_finding_key_and_caps_length(self):
        row = _finding('run', 'f', 'quoted line', page=3)
        bare = mod.prepare_packet([row])
        item_id = bare['items'][0]['itemId']
        packet = mod.prepare_packet([row], context={
            'f': 'generic page',
            'run:f': 'specific page',
            item_id: 'ignored because the finding key wins',
        })
        judge = packet['passes'][0]['items'][0]
        self.assertEqual(judge['context'], 'specific page')
        self.assertNotIn('runId', judge)
        self.assertNotIn('findingId', judge)

        long_text = '가' * 1201
        capped = mod.prepare_packet([row], context={'run:f': long_text})
        context = capped['passes'][0]['items'][0]['context']
        self.assertEqual(len(context), 1200)
        self.assertTrue(context.startswith('가'))

    def test_prose_may_mention_answer_key_words(self):
        row = _finding('r', 'f', 'before after gold rationale defectId patch')
        packet = mod.prepare_packet([row], context={'f': 'why_hard is ordinary prose'})
        self.assertEqual(packet['passes'][0]['items'][0]['quote'], row['quote'])

    def test_answer_key_field_exits_3(self):
        clean = _finding('r', 'f', 'ordinary quote')
        payloads = [
            _finding('r', 'f', 'ordinary quote', before='10'),
            _finding('r', 'f', 'ordinary quote', after='20'),
            _finding('r', 'f', 'ordinary quote', gold=True),
            _finding('r', 'f', 'ordinary quote', rationale='hidden'),
            _finding('r', 'f', 'ordinary quote', defectId='g1'),
            _finding('r', 'f', 'ordinary quote', patch='x'),
            _finding('r', 'f', 'ordinary quote', why_hard='because'),
            _finding('r', 'f', 'ordinary quote', candidateRationales=['a']),
            {'runId': 'r', 'findingId': 'f', 'quote': 'q', 'extra': [{'Before': 'x'}]},
        ]
        for payload in payloads:
            with self.subTest(payload=sorted(payload)):
                with self.assertRaises(mod.AdjudicationError) as caught:
                    mod.prepare_packet([payload])
                self.assertEqual(caught.exception.code, 'answer_key_field')
                self.assertEqual(caught.exception.exit_code, 3)
        with self.assertRaises(mod.AdjudicationError) as nested:
            mod.prepare_packet([clean], context={'f': {'rationale': 'leaked'}})
        self.assertEqual(nested.exception.exit_code, 3)


class ReconcileTests(unittest.TestCase):
    def _packet(self):
        findings = [
            _finding('r', 'a', 'quote alpha', claim='alpha overstates the rate'),
            _finding('r', 'b', 'quote beta', claim='beta disagrees with the table'),
            _finding('r', 'c', 'quote gamma', claim='gamma sits on a spin boundary'),
            _finding('r', 'd', 'quote delta', claim='delta is internally inconsistent'),
            _finding('r', 'e', 'quote epsilon', claim='epsilon is not supported'),
        ]
        return mod.prepare_packet(findings, seed='reconcile')

    def test_agreement_disagreement_abstain_and_missing(self):
        packet = self._packet()
        ids = [item['itemId'] for item in packet['items']]
        response_a = _response('A', [
            (ids[0], 'pure_fp'),
            (ids[1], 'pure_fp'),
            (ids[2], 'abstain'),
            (ids[4], 'abstain'),
        ])
        response_b = _response('B', [
            (ids[0], 'pure_fp'),
            (ids[1], 'spin_boundary'),
            (ids[2], 'pure_fp'),
            (ids[3], 'pure_fp'),
            (ids[4], 'abstain'),
        ])
        result = mod.reconcile(packet, response_a, response_b)
        rows = {row['findingId']: row for row in result['items']}
        self.assertEqual(result['schema'], mod.RESULT_SCHEMA)
        self.assertTrue(rows['a']['agreed'])
        self.assertEqual(rows['a']['preliminary'], 'pure_fp')
        self.assertEqual(rows['a']['label'], '순수 오탐')
        self.assertIsNone(rows['a']['reasonCode'])
        self.assertEqual(rows['b']['preliminary'], 'needs_review')
        self.assertEqual(rows['b']['label'], '확인필요')
        self.assertEqual(rows['b']['reasonCode'], 'order_sensitive')
        self.assertFalse(rows['b']['agreed'])
        self.assertEqual(rows['c']['reasonCode'], 'abstained')
        self.assertEqual(rows['c']['categoryA'], 'abstain')
        self.assertEqual(rows['d']['reasonCode'], 'missing_verdict')
        self.assertIsNone(rows['d']['categoryA'])
        self.assertEqual(rows['e']['reasonCode'], 'abstained')
        self.assertFalse(rows['e']['agreed'])
        for row in result['items']:
            self.assertTrue(row['humanReviewRequired'])
            self.assertIsNone(row['finalCategory'])
        summary = result['summary']
        self.assertEqual(summary['counts']['pure_fp'], 1)
        self.assertEqual(summary['counts']['real_source_defect'], 0)
        self.assertEqual(summary['needsReview'], 4)
        self.assertEqual(summary['agreementRate'], 0.2)
        self.assertEqual(summary['orderSensitiveCount'], 1)
        self.assertEqual(summary['modelCalls'], 0)
        self.assertIs(summary['scoreChanged'], False)
        _assert_no_score_keys(self, result)

    def test_position_bias_rates_ignore_abstain_and_missing(self):
        findings = [
            _finding('r', 'a', 'quote a', claim='a is wrong'),
            _finding('r', 'b', 'quote b', claim='b is overstated'),
            _finding('r', 'c', 'quote c', claim='c is unsupported'),
        ]
        packet = mod.prepare_packet(findings, seed='bias')
        ids = [item['itemId'] for item in packet['items']]
        first_b = _category_ids(packet, 'B')[0]
        self.assertEqual(_category_ids(packet, 'A')[0], 'real_source_defect')
        self.assertNotEqual(first_b, 'real_source_defect')
        response_a = _response('A', [
            (ids[0], 'real_source_defect'),
            (ids[1], 'spin_boundary'),
        ])
        response_b = _response('B', [
            (ids[0], first_b),
            (ids[1], 'abstain'),
        ])
        result = mod.reconcile(packet, response_a, response_b)
        rates = result['summary']['firstOptionPickRate']
        self.assertEqual(rates['A'], 0.5)
        self.assertEqual(rates['B'], 1.0)

        abstained = mod.reconcile(
            packet,
            _response('A', [(ids[0], 'abstain')]),
            _response('B', [(ids[0], 'abstain')]),
        )
        self.assertIsNone(abstained['summary']['firstOptionPickRate']['A'])
        self.assertIsNone(abstained['summary']['firstOptionPickRate']['B'])

    def test_unknown_item_or_category_exits_2(self):
        packet = mod.prepare_packet([_finding('r', 'a', 'quote a'), _finding('r', 'b', 'quote b')])
        ids = [item['itemId'] for item in packet['items']]
        unknown_item = _response('A', [(ids[0], 'pure_fp'), ('missing-item', 'pure_fp')])
        with self.assertRaises(mod.AdjudicationError) as unknown:
            mod.reconcile(packet, unknown_item, _response('B', [(ids[0], 'pure_fp')]))
        self.assertEqual(unknown.exception.exit_code, 2)
        self.assertEqual(unknown.exception.code, 'unknown_item')

        bad_category = _response('A', [(ids[0], 'spin-boundary')])
        with self.assertRaises(mod.AdjudicationError) as category:
            mod.reconcile(packet, bad_category, _response('B', []))
        self.assertEqual(category.exception.exit_code, 2)
        self.assertEqual(category.exception.code, 'unknown_category')

        duplicate = _response('A', [(ids[0], 'pure_fp'), (ids[0], 'gold_error')])
        with self.assertRaises(mod.AdjudicationError) as dup:
            mod.reconcile(packet, duplicate, _response('B', []))
        self.assertEqual(dup.exception.code, 'duplicate_item')
        self.assertEqual(dup.exception.exit_code, 2)

    def test_response_answer_key_still_exits_3(self):
        packet = self._packet()
        item_id = packet['items'][0]['itemId']
        other = _response('B', [(item_id, 'pure_fp')])
        for key in ('rationale', 'before', 'defectId'):
            leaked = _response('A', [(item_id, 'pure_fp')])
            leaked['verdicts'][0][key] = 'hidden'
            with self.subTest(key=key):
                with self.assertRaises(mod.AdjudicationError) as caught:
                    mod.reconcile(packet, leaked, other)
                self.assertEqual(caught.exception.code, 'answer_key_field')
                self.assertEqual(caught.exception.exit_code, 3)


class CollectTests(unittest.TestCase):
    def test_collect_findings_from_arena_report(self):
        gold = {
            'schema': 'falsify.red-gold-ledger.v1',
            'defects': [{
                'defectId': 'g1',
                'world': 'W1',
                'family': 'D1',
                'difficulty': 'L1',
                'pageIndex': 0,
                'after': 'alpha beta gamma',
            }],
        }
        run_one = {
            'runId': 'run-1',
            'findings': [
                {'id': 'hit', 'decision': 'defect', 'pageIndex': 0, 'quote': 'alpha beta gamma'},
                {'id': 'fp-1', 'decision': 'defect', 'pageIndex': 2, 'quote': 'zebra quilt mosaic'},
            ],
        }
        run_two = {
            'runId': 'run-2',
            'findings': [
                {'id': 'fp-2', 'decision': 'defect', 'pageIndex': 4, 'quote': 'marble sundial echo'},
            ],
        }
        report = arena_runner.evaluate_arena_match(gold, [run_one, run_two])
        self.assertEqual(report['runs'][0]['pureFp'], 1)
        self.assertEqual(report['runs'][1]['pureFp'], 1)
        found = mod.collect_findings(report)
        self.assertEqual(found, [
            {'runId': 'run-1', 'findingId': 'fp-1', 'pageIndex': 2, 'quote': 'zebra quilt mosaic'},
            {'runId': 'run-2', 'findingId': 'fp-2', 'pageIndex': 4, 'quote': 'marble sundial echo'},
        ])
        packet = mod.prepare_packet(found, seed='arena')
        self.assertEqual(len(packet['items']), 2)
        self.assertNotEqual(_pass_ids(packet, 'A'), _pass_ids(packet, 'B'))
        _assert_no_score_keys(self, packet)


class CliTests(unittest.TestCase):
    def test_direct_exits_for_answer_key_unknown_and_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            findings = root / 'findings.json'
            packet_path = root / 'packet.json'
            findings.write_text(
                json.dumps([_finding('r', 'f', 'quote', rationale='hidden')]),
                encoding='utf-8',
            )
            code, summary = self._main(['prepare', '--findings', str(findings), '--out', str(packet_path)])
            self.assertEqual(code, 3)
            self.assertEqual(summary['error'], 'answer_key_field')
            self.assertTrue(json.dumps(summary).isascii())
            self.assertFalse(packet_path.exists())

            findings.write_text(json.dumps([_finding('r', 'f', 'quote')]), encoding='utf-8')
            code, summary = self._main(['prepare', '--findings', str(findings), '--out', str(packet_path)])
            self.assertEqual(code, 0)
            self.assertEqual(summary['items'], 1)
            packet = json.loads(packet_path.read_text(encoding='utf-8'))
            bad = root / 'bad-a.json'
            bad.write_text(json.dumps(_response('A', [('no-such-item', 'pure_fp')])), encoding='utf-8')
            empty_b = root / 'b.json'
            empty_b.write_text(json.dumps(_response('B', [])), encoding='utf-8')
            result_path = root / 'result.json'
            code, summary = self._main([
                'reconcile', '--packet', str(packet_path),
                '--response-a', str(bad), '--response-b', str(empty_b),
                '--out', str(result_path),
            ])
            self.assertEqual(code, 2)
            self.assertEqual(summary['error'], 'unknown_item')
            self.assertFalse(result_path.exists())

            with mock.patch.object(mod, 'prepare_packet', side_effect=TimeoutError()):
                code, summary = self._main(['prepare', '--findings', str(findings), '--out', str(packet_path)])
            self.assertEqual(code, 124)
            self.assertEqual(summary['error'], 'timeout')

    def _main(self, args):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main(args)
        text = buf.getvalue()
        self.assertTrue(text.isascii(), text)
        return code, json.loads(text)

    def test_cli_round_trip_csv_and_cp949_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            findings = [
                _finding('run', 'f1', '본문 인용 ⚠', claim='경고 수치가 본문과 다르다'),
                _finding('run', 'f2', '다른 문장', claim='다른 문장이 결과를 과장한다'),
            ]
            findings_path = root / 'findings.json'
            context_path = root / 'context.json'
            packet_path = root / 'packet.json'
            response_a = root / 'a.json'
            response_b = root / 'b.json'
            result_path = root / 'result.json'
            csv_path = root / 'result.csv'
            findings_path.write_text(json.dumps(findings, ensure_ascii=False), encoding='utf-8')
            context_path.write_text(json.dumps({'f1': '가' * 50}, ensure_ascii=False), encoding='utf-8')
            env = os.environ.copy()
            env['PYTHONIOENCODING'] = 'cp949'
            env['PYTHONUTF8'] = '0'

            prepared = self._run(env, [
                'prepare', '--findings', str(findings_path), '--context', str(context_path),
                '--seed', 'cli', '--out', str(packet_path),
            ])
            self.assertEqual(prepared['ok'], True)
            self.assertEqual(prepared['items'], 2)
            packet_text = packet_path.read_text(encoding='utf-8')
            self.assertIn('실제 원문 결함', packet_text)
            self.assertIn('본문 인용 ⚠', packet_text)
            self.assertNotIn(str(root), packet_text)
            packet = json.loads(packet_text)
            ids = [item['itemId'] for item in packet['items']]
            first_b = _category_ids(packet, 'B')[0]
            other = next(cid for cid in mod.CATEGORY_IDS if cid not in {'real_source_defect', first_b})
            response_a.write_text(json.dumps(_response('A', [
                (ids[0], 'real_source_defect'),
                (ids[1], 'real_source_defect'),
            ])), encoding='utf-8')
            response_b.write_text(json.dumps(_response('B', [
                (ids[0], 'real_source_defect'),
                (ids[1], other),
            ])), encoding='utf-8')
            reconciled = self._run(env, [
                'reconcile', '--packet', str(packet_path),
                '--response-a', str(response_a), '--response-b', str(response_b),
                '--out', str(result_path), '--csv', str(csv_path),
            ])
            self.assertEqual(reconciled['scoreChanged'], False)
            self.assertEqual(reconciled['modelCalls'], 0)
            result = json.loads(result_path.read_text(encoding='utf-8'))
            _assert_no_score_keys(self, result)
            self.assertNotIn(str(root), result_path.read_text(encoding='utf-8'))
            self.assertEqual(result['summary']['agreementRate'], 0.5)
            self.assertEqual(result['summary']['firstOptionPickRate']['A'], 1.0)
            self.assertEqual(result['summary']['firstOptionPickRate']['B'], 0.0)
            with csv_path.open(encoding='utf-8', newline='') as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]['preliminary'], 'real_source_defect')
            self.assertEqual(rows[0]['label'], '실제 원문 결함')
            self.assertEqual(rows[0]['humanReviewRequired'], 'true')
            self.assertEqual(rows[0]['finalCategory'], '')
            self.assertIn('본문 인용 ⚠', rows[0]['quote'])

    def _run(self, env, args):
        proc = subprocess.run(
            [sys.executable, str(CLI_PATH), *args],
            capture_output=True,
            check=False,
            env=env,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('cp949', errors='replace'))
        stdout = proc.stdout.decode('cp949')
        self.assertTrue(stdout.isascii(), stdout)
        return json.loads(stdout)

    def test_functions_stay_within_complexity_gate(self):
        source = CLI_PATH.read_bytes()
        proc = subprocess.run(
            [sys.executable, str(PY_CCN_PATH)],
            input=source,
            capture_output=True,
            check=True,
        )
        functions = json.loads(proc.stdout)
        violations = [fn['id'] for fn in functions if fn['ccn'] > 15]
        self.assertEqual(violations, [])


def _judge(packet, item_id=None):
    items = packet['passes'][0]['items']
    if item_id is None:
        return items[0]
    for item in items:
        if item['itemId'] == item_id:
            return item
    raise AssertionError(item_id)


class ClaimJoinTests(unittest.TestCase):
    def test_join_by_finding_id_and_run_id_keeps_plain_fields(self):
        plain = _finding('run-1', 'fp-1', 'quoted line', claim='kept claim', defectType='S1', family='D9')
        reports = [
            {'runId': 'other', 'findings': [{'id': 'fp-1', 'runId': 'run-1', 'suspicion': 'override', 'family': 'D3'}]},
            {'runId': 'run-1', 'findings': [{'id': 'fp-1', 'runId': 'other', 'suspicion': 'blocked', 'family': 'D2'}]},
            {'runId': 'run-1', 'findings': [{'id': 'fp-1', 'suspicion': 'second', 'findingType': 'D4'}]},
        ]
        packet = mod.prepare_packet([plain], blue_reports=reports, seed='join')
        judge = _judge(packet)
        self.assertEqual(judge['claim'], 'kept claim')
        self.assertEqual(judge['defectType'], 'S1')
        self.assertNotIn('claimMissing', judge)
        self.assertEqual(packet['claimMissingCount'], 0)

        joined = mod.prepare_packet(
            [_finding('run-1', 'fp-1', 'quoted line')],
            blue_reports=[{'runId': 'run-1', 'findings': [{'id': 'fp-1', 'suspicion': 'numbers disagree', 'findingType': 'D1'}]}],
        )
        self.assertEqual(_judge(joined)['claim'], 'numbers disagree')
        self.assertEqual(_judge(joined)['defectType'], 'D1')

        mismatched = mod.prepare_packet(
            [_finding('run-1', 'fp-1', 'quoted line')],
            blue_reports=[{'runId': 'run-2', 'findings': [{'id': 'fp-1', 'suspicion': 'nope', 'family': 'D2'}]}],
        )
        self.assertTrue(_judge(mismatched)['claimMissing'])
        self.assertNotIn('defectType', _judge(mismatched))
        self.assertEqual(mismatched['claimMissingCount'], 1)

        by_note = mod.prepare_packet(
            [_finding('run-1', 'fp-1', 'quoted line')],
            blue_reports=[{'findings': [{'findingId': 'fp-1', 'note': 'from note', 'defectFamily': 'S1'}]}],
        )
        self.assertEqual(_judge(by_note)['claim'], 'from note')
        self.assertEqual(_judge(by_note)['defectType'], 'S1')

        override = mod.prepare_packet(
            [_finding('run-1', 'fp-1', 'quoted line')],
            blue_reports=[{'runId': 'other', 'findings': [{
                'id': 'fp-1', 'runId': 'run-1', 'suspicion': 'override', 'family': 'D3',
            }]}],
        )
        self.assertEqual(_judge(override)['claim'], 'override')
        self.assertEqual(_judge(override)['defectType'], 'D3')
        blocked = mod.prepare_packet(
            [_finding('run-1', 'fp-1', 'quoted line')],
            blue_reports=[{'runId': 'run-1', 'findings': [{
                'id': 'fp-1', 'runId': 'other', 'suspicion': 'blocked', 'family': 'D2',
            }]}],
        )
        self.assertTrue(_judge(blocked)['claimMissing'])
        by_report_number = mod.prepare_packet(
            [_finding('', 'ZD-1', 'quoted line')],
            blue_reports=[{'findings': [{'reportNumber': 'ZD-1', 'note': 'restored', 'defectFamily': 'D2'}]}],
        )
        self.assertEqual(_judge(by_report_number)['claim'], 'restored')
        self.assertEqual(_judge(by_report_number)['defectType'], 'D2')

        first = mod.prepare_packet(
            [_finding('r', 'f', 'q')],
            blue_reports=[
                {'runId': 'r', 'findings': [{'id': 'f', 'suspicion': 'first', 'family': 'D1'}]},
                {'runId': 'r', 'findings': [{'id': 'f', 'suspicion': 'second', 'family': 'D2'}]},
            ],
        )
        self.assertEqual(_judge(first)['claim'], 'first')
        self.assertEqual(_judge(first)['defectType'], 'D1')

        own_family = mod.prepare_packet([
            _finding('r', 'f', 'q', family='   ', findingType='', defect_type='  D4-1 ', defectFamily='D1'),
        ])
        self.assertEqual(_judge(own_family)['defectType'], 'D4-1')
        self.assertTrue(_judge(own_family)['claimMissing'])

    def test_claim_and_defect_type_collapse_and_cap_at_600(self):
        spaced = '  alpha \n\t beta  '
        packet = mod.prepare_packet([_finding('r', 'f', 'q', suspicion=spaced, family='  D1 \n type ')])
        self.assertEqual(_judge(packet)['claim'], 'alpha beta')
        self.assertEqual(_judge(packet)['defectType'], 'D1 type')

        long_claim = '가' * 650
        long_type = 'T' * 650
        capped = mod.prepare_packet([_finding('r', 'f', 'q', note=long_claim, defect_type=long_type)])
        self.assertEqual(_judge(capped)['claim'], '가' * 600)
        self.assertEqual(len(_judge(capped)['claim']), 600)
        self.assertEqual(_judge(capped)['defectType'], 'T' * 600)

    def test_claim_missing_overrides_agreeing_verdicts(self):
        packet = mod.prepare_packet([_finding('r', 'a', 'quote')], seed='missing', source_context={'a': 'original differs'})
        self.assertEqual(packet['claimMissingCount'], 1)
        self.assertTrue(packet['items'][0]['claimMissing'])
        item_id = packet['items'][0]['itemId']
        result = mod.reconcile(
            packet,
            _response('A', [(item_id, 'pure_fp')]),
            _response('B', [(item_id, 'pure_fp')]),
        )
        row = result['items'][0]
        self.assertEqual(row['categoryA'], 'pure_fp')
        self.assertEqual(row['categoryB'], 'pure_fp')
        self.assertFalse(row['agreed'])
        self.assertEqual(row['preliminary'], 'needs_review')
        self.assertEqual(row['label'], '확인필요')
        self.assertEqual(row['reasonCode'], 'claim_missing')
        self.assertTrue(row['humanReviewRequired'])
        self.assertIsNone(row['finalCategory'])
        self.assertEqual(result['summary']['needsReview'], 1)
        self.assertEqual(result['summary']['agreementRate'], 0.0)

    def test_blue_rationale_becomes_claim_and_other_roles_still_exit_3(self):
        finding = _finding('r', 'f', 'quoted line')
        spaced = '  rate \n\t differs\tfrom the table  '
        report = {'runId': 'r', 'findings': [{
            'id': 'f',
            'rationale': spaced,
            'suspicion': 'should not win',
            'note': 'also later',
            'family': 'D1',
        }]}
        packet = mod.prepare_packet([finding], blue_reports=[report], seed='rationale')
        self.assertEqual(packet, mod.prepare_packet([finding], blue_reports=[report], seed='rationale'))
        self.assertEqual(_judge(packet)['claim'], 'rate differs from the table')
        self.assertEqual(_judge(packet)['defectType'], 'D1')

        ordered = [_finding('r', 'a', 'quote a'), _finding('r', 'b', 'quote b')]
        ordered_reports = [{'runId': 'r', 'findings': [
            {'id': 'a', 'rationale': 'claim a'},
            {'id': 'b', 'rationale': 'claim b'},
        ]}]
        ordered_packet = mod.prepare_packet(ordered, blue_reports=ordered_reports, seed='order')
        self.assertEqual(
            ordered_packet,
            mod.prepare_packet(ordered, blue_reports=ordered_reports, seed='order'),
        )
        self.assertNotEqual(_pass_ids(ordered_packet, 'A'), _pass_ids(ordered_packet, 'B'))
        self.assertEqual(
            [item['claim'] for item in ordered_packet['passes'][0]['items']],
            ['claim a', 'claim b'],
        )

        both = {'runId': 'r', 'findings': [{
            'id': 'f',
            'claim': '  stated claim  ',
            'rationale': 'hidden explanation',
            'suspicion': 'later',
        }]}
        self.assertEqual(
            _judge(mod.prepare_packet([finding], blue_reports=[both]))['claim'],
            'stated claim',
        )
        blank_claim = {'runId': 'r', 'findings': [{
            'id': 'f', 'claim': ' \n\t ', 'rationale': 'real text',
        }]}
        self.assertEqual(
            _judge(mod.prepare_packet([finding], blue_reports=[blank_claim]))['claim'],
            'real text',
        )
        kept = mod.prepare_packet(
            [_finding('r', 'f', 'quoted line', claim='kept claim')],
            blue_reports=[{'runId': 'r', 'findings': [{'id': 'f', 'rationale': 'from blue'}]}],
        )
        self.assertEqual(_judge(kept)['claim'], 'kept claim')

        prefix = '[인용 미검증 자동 강등] 인용이 원문에서 확인되지 않았다'
        recovered = (
            '[Zero-Drop 자동 복원] 1단계 의심 원장에 기록되었으나 2단계 판정에서 '
            '해소 근거 없이 누락됨: numbers disagree'
        )
        downgraded = '[인용 미검증 자동 강등]  line\nbreak'
        for text, expected in (
            (prefix, prefix),
            (recovered, recovered),
            (downgraded, '[인용 미검증 자동 강등] line break'),
        ):
            shown = mod.prepare_packet(
                [finding],
                blue_reports=[{'findings': [{'findingId': 'f', 'rationale': text}]}],
            )
            self.assertEqual(_judge(shown)['claim'], expected)

        long_rationale = '가' * 650
        capped = mod.prepare_packet(
            [finding],
            blue_reports=[{'findings': [{'id': 'f', 'rationale': long_rationale}]}],
        )
        self.assertEqual(_judge(capped)['claim'], '가' * 600)

        for key, value in (
            ('before', '10'),
            ('after', '20'),
            ('gold', True),
            ('defectId', 'g1'),
            ('patch', 'x'),
            ('why_hard', 'because'),
            ('candidateRationales', ['a']),
        ):
            leaked = {'findings': [{'id': 'f', 'rationale': 'visible', key: value}]}
            with self.subTest(key=key):
                with self.assertRaises(mod.AdjudicationError) as caught:
                    mod.prepare_packet([finding], blue_reports=[leaked])
                self.assertEqual(caught.exception.code, 'answer_key_field')
                self.assertEqual(caught.exception.exit_code, 3)

        nested = {'findings': [{'id': 'f', 'rationale': 'visible', 'detail': {'Before': 'x'}}]}
        with self.assertRaises(mod.AdjudicationError) as nested_hit:
            mod.prepare_packet([finding], blue_reports=[nested])
        self.assertEqual(nested_hit.exception.exit_code, 3)
        self.assertEqual(nested_hit.exception.code, 'answer_key_field')

        ledger = {
            'schema': 'falsify.red-gold-ledger.v1',
            'defects': [{
                'defectId': 'g1',
                'before': 'original sentence',
                'after': 'changed sentence',
                'rationale': 'why this edit is hard',
            }],
        }
        with self.assertRaises(mod.AdjudicationError) as ledger_hit:
            mod.prepare_packet([finding], blue_reports=[ledger])
        self.assertEqual(ledger_hit.exception.code, 'answer_key_field')
        self.assertEqual(ledger_hit.exception.exit_code, 3)

        with self.assertRaises(mod.AdjudicationError) as plain:
            mod.prepare_packet(
                [_finding('r', 'f', 'quoted line', rationale='hidden')],
                blue_reports=[{'findings': [{'id': 'f', 'rationale': 'allowed here'}]}],
            )
        self.assertEqual(plain.exception.exit_code, 3)
        for kwargs in (
            {'context': {'f': {'rationale': 'leaked'}}},
            {'source_context': {'f': {'rationale': 'leaked'}}},
            {'source_context': {'f': {'gold': 'leaked'}}},
        ):
            with self.subTest(kwargs=sorted(kwargs)):
                with self.assertRaises(mod.AdjudicationError) as other:
                    mod.prepare_packet([finding], **kwargs)
                self.assertEqual(other.exception.exit_code, 3)
                self.assertEqual(other.exception.code, 'answer_key_field')


class DefinitionAndSourceTests(unittest.TestCase):
    def test_definitions_follow_each_pass_order(self):
        findings = [_finding('r', f'f{index}', f'quote {index}', claim=f'claim {index}') for index in range(4)]
        packet = mod.prepare_packet(findings, seed='defs')
        self.assertEqual(set(mod.DEFINITIONS), set(mod.CATEGORY_IDS))
        for block in packet['passes']:
            ids = [row['id'] for row in block['categories']]
            self.assertEqual(
                [row['definition'] for row in block['categories']],
                [mod.DEFINITIONS[cid] for cid in ids],
            )
            text = block['instruction']
            positions = [text.index(f'{row["id"]}: {row["definition"]}') for row in block['categories']]
            self.assertEqual(positions, sorted(positions))
            self.assertIn('Judge the allegation in claim against quote/context.', text)
            self.assertIn('The answer is preliminary and a person decides.', text)
            self.assertIn('"category": "abstain"', text)
        self.assertNotEqual(_category_ids(packet, 'A'), _category_ids(packet, 'B'))
        self.assertNotEqual(_category_ids(packet, 'B')[0], _category_ids(packet, 'A')[0])
        self.assertIn('injected changes', mod.DEFINITIONS['real_source_defect'])
        self.assertIn('careful reviewers', mod.DEFINITIONS['spin_boundary'])
        self.assertIn('source context is shown and differs', mod.DEFINITIONS['gold_error'])
        self.assertIn('consistent with the rest of the paper', mod.DEFINITIONS['pure_fp'])

    def test_gold_error_needs_source_context_and_keeps_agreement_when_it_differs(self):
        finding = _finding('r', 'a', 'injected quote', claim='the rate is wrong')
        bare = mod.prepare_packet([finding], seed='gold')
        item_id = bare['items'][0]['itemId']
        self.assertNotIn('sourceContext', _judge(bare))
        withheld = mod.reconcile(
            bare,
            _response('A', [(item_id, 'gold_error')]),
            _response('B', [(item_id, 'gold_error')]),
        )
        row = withheld['items'][0]
        self.assertEqual(row['categoryA'], 'gold_error')
        self.assertEqual(row['categoryB'], 'gold_error')
        self.assertFalse(row['agreed'])
        self.assertEqual(row['preliminary'], 'needs_review')
        self.assertEqual(row['reasonCode'], 'gold_error_without_source')

        shown = mod.prepare_packet(
            [finding],
            seed='gold',
            source_context={'a': 'original quote differs'},
        )
        self.assertEqual(_judge(shown)['sourceContext'], 'original quote differs')
        self.assertEqual(shown['items'][0]['sourceContext'], 'original quote differs')
        agreed = mod.reconcile(
            shown,
            _response('A', [(item_id, 'gold_error')]),
            _response('B', [(item_id, 'gold_error')]),
        )
        kept = agreed['items'][0]
        self.assertTrue(kept['agreed'])
        self.assertEqual(kept['preliminary'], 'gold_error')
        self.assertEqual(kept['label'], '정답지 오류 (Gold v2 후보)')
        self.assertIsNone(kept['reasonCode'])
        self.assertTrue(kept['humanReviewRequired'])
        self.assertIsNone(kept['finalCategory'])
        self.assertEqual(agreed['summary']['counts']['gold_error'], 1)

        long_text = '나' * 1300
        capped = mod.prepare_packet([finding], source_context={'r:a': long_text})
        self.assertEqual(len(_judge(capped)['sourceContext']), 1200)

    def test_cli_blue_report_and_source_context_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            findings_path = root / 'findings.json'
            report_one = root / 'blue-1.json'
            report_two = root / 'blue-2.json'
            source_path = root / 'source.json'
            packet_path = root / 'packet.json'
            findings_path.write_text(json.dumps([
                _finding('run', 'f1', '본문 인용'),
                _finding('run', 'f2', '다른 문장', claim='이미 있는 주장'),
            ], ensure_ascii=False), encoding='utf-8')
            report_one.write_text(json.dumps({
                'runId': 'run',
                'findings': [{'id': 'f1', 'suspicion': '수치가 표와 다르다', 'findingType': 'D1'}],
            }, ensure_ascii=False), encoding='utf-8')
            report_two.write_text(json.dumps({
                'runId': 'run',
                'findings': [{'id': 'f2', 'note': '덮어쓰면 안 된다', 'family': 'D9'}],
            }, ensure_ascii=False), encoding='utf-8')
            source_path.write_text(json.dumps({'f1': '원문 문장'}, ensure_ascii=False), encoding='utf-8')
            env = os.environ.copy()
            env['PYTHONIOENCODING'] = 'cp949'
            env['PYTHONUTF8'] = '0'
            prepared = self._run(env, [
                'prepare', '--findings', str(findings_path),
                '--blue-report', str(report_one), '--blue-report', str(report_two),
                '--source-context', str(source_path), '--seed', 'rev', '--out', str(packet_path),
            ])
            self.assertEqual(prepared['ok'], True)
            self.assertEqual(prepared['items'], 2)
            packet_text = packet_path.read_text(encoding='utf-8')
            self.assertNotIn(str(root), packet_text)
            packet = json.loads(packet_text)
            self.assertEqual(packet['claimMissingCount'], 0)
            by_finding = {item['findingId']: item for item in packet['items']}
            self.assertEqual(by_finding['f1']['claim'], '수치가 표와 다르다')
            self.assertEqual(by_finding['f1']['defectType'], 'D1')
            self.assertEqual(by_finding['f1']['sourceContext'], '원문 문장')
            self.assertEqual(by_finding['f2']['claim'], '이미 있는 주장')
            self.assertEqual(by_finding['f2']['defectType'], 'D9')
            judge = _judge(packet, by_finding['f1']['itemId'])
            self.assertEqual(judge['claim'], '수치가 표와 다르다')
            self.assertEqual(judge['sourceContext'], '원문 문장')
            self.assertNotIn('runId', judge)

            leaked = root / 'leaked.json'
            leaked.write_text(json.dumps({'findings': [{'id': 'f1', 'before': '10'}]}), encoding='utf-8')
            code, summary = self._main([
                'prepare', '--findings', str(findings_path), '--blue-report', str(leaked),
                '--out', str(packet_path),
            ])
            self.assertEqual(code, 3)
            self.assertEqual(summary['error'], 'answer_key_field')

    def test_cli_rationale_guard_is_scoped_to_input_role(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            findings_path = root / 'findings.json'
            clean_path = root / 'clean.json'
            context_path = root / 'context.json'
            source_path = root / 'source.json'
            blue_path = root / 'blue.json'
            ledger_path = root / 'ledger.json'
            packet_path = root / 'packet.json'
            clean_path.write_text(
                json.dumps([_finding('r', 'f', 'quoted line')]),
                encoding='utf-8',
            )
            findings_path.write_text(
                json.dumps([_finding('r', 'f', 'quoted line', rationale='hidden')]),
                encoding='utf-8',
            )
            context_path.write_text(
                json.dumps({'f': {'rationale': 'leaked'}}),
                encoding='utf-8',
            )
            source_path.write_text(
                json.dumps({'f': {'rationale': 'leaked'}}),
                encoding='utf-8',
            )
            blue_path.write_text(json.dumps({
                'runId': 'r',
                'findings': [{
                    'id': 'f',
                    'rationale': '  rate \n differs  ',
                    'findingType': 'D1',
                }],
            }, ensure_ascii=False), encoding='utf-8')
            ledger_path.write_text(json.dumps({
                'schema': 'falsify.red-gold-ledger.v1',
                'defects': [{
                    'defectId': 'g1',
                    'before': 'original sentence',
                    'after': 'changed sentence',
                }],
            }), encoding='utf-8')

            code, summary = self._main([
                'prepare', '--findings', str(findings_path), '--out', str(packet_path),
            ])
            self.assertEqual(code, 3)
            self.assertEqual(summary['error'], 'answer_key_field')
            for flag, path in (('--context', context_path), ('--source-context', source_path)):
                code, summary = self._main([
                    'prepare', '--findings', str(clean_path), flag, str(path),
                    '--out', str(packet_path),
                ])
                self.assertEqual(code, 3, flag)
                self.assertEqual(summary['error'], 'answer_key_field')

            code, summary = self._main([
                'prepare', '--findings', str(clean_path), '--blue-report', str(ledger_path),
                '--out', str(packet_path),
            ])
            self.assertEqual(code, 3)
            self.assertEqual(summary['error'], 'answer_key_field')

            code, summary = self._main([
                'prepare', '--findings', str(clean_path), '--blue-report', str(blue_path),
                '--seed', 'role', '--out', str(packet_path),
            ])
            self.assertEqual(code, 0)
            self.assertEqual(summary['ok'], True)
            packet = json.loads(packet_path.read_text(encoding='utf-8'))
            self.assertNotIn(str(root), packet_path.read_text(encoding='utf-8'))
            self.assertEqual(packet['items'][0]['claim'], 'rate differs')
            self.assertEqual(_judge(packet)['claim'], 'rate differs')
            self.assertEqual(packet['items'][0]['defectType'], 'D1')

    def _main(self, args):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = mod.main(args)
        text = buf.getvalue()
        self.assertTrue(text.isascii(), text)
        return code, json.loads(text)

    def _run(self, env, args):
        proc = subprocess.run(
            [sys.executable, str(CLI_PATH), *args],
            capture_output=True,
            check=False,
            env=env,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('cp949', errors='replace'))
        stdout = proc.stdout.decode('cp949')
        self.assertTrue(stdout.isascii(), stdout)
        return json.loads(stdout)


if __name__ == '__main__':
    unittest.main()
