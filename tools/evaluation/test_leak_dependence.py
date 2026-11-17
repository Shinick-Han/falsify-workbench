"""Hand-built ledgers for PDF-edit versus source-native leak dependence."""

from __future__ import annotations

import csv
import io
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal, ROUND_HALF_EVEN, localcontext
from pathlib import Path
from unittest import mock

EVAL_DIR = Path(__file__).resolve().parent
REPO_ROOT = EVAL_DIR.parents[1]
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import leak_dependence as leak  # noqa: E402

CLI_PATH = EVAL_DIR / 'leak_dependence.py'
PY_CCN_PATH = REPO_ROOT / 'tools' / 'quality' / 'python-functions.py'
WILSON_Z = Decimal('1.959963984540054')
QUANTUM = Decimal('0.000001')
BEFORE = 'SEALED_BEFORE_TOKEN'
RATIONALE = 'SEALED_RATIONALE_TOKEN'
QUOTES = {
    'd1': 'alpha mortality endpoint reached fourteen percent',
    'd2': 'beta creatinine clearance dropped under thirty',
    'd3': 'gamma hospitalization count exceeded protocol limits',
    'd4': 'delta adherence fraction fell during month six',
    'd5': 'epsilon imaging volume differed from registry totals',
}


def independent_wilson(detected: int, total: int) -> tuple[str, str]:
    """Wilson interval duplicated here so the expectation is not the module output."""
    with localcontext() as ctx:
        ctx.prec = 50
        z2 = WILSON_Z * WILSON_Z
        n = Decimal(total)
        p_hat = Decimal(detected) / n
        denom = Decimal(1) + z2 / n
        center = (p_hat + z2 / (Decimal(2) * n)) / denom
        radicand = p_hat * (Decimal(1) - p_hat) / n + z2 / (Decimal(4) * n * n)
        margin = WILSON_Z * radicand.sqrt() / denom
        low = center - margin
        high = center + margin
        if low < 0:
            low = Decimal(0)
        if high > 1:
            high = Decimal(1)
        return _quantize(low), _quantize(high)


def independent_mcnemar(pdf_only: int, source_only: int) -> tuple[int, int]:
    """Exact two-sided binomial tail, duplicated from the module."""
    discordant = pdf_only + source_only
    if discordant == 0:
        return 1, 1
    observed = math.comb(discordant, pdf_only)
    numerator = sum(
        math.comb(discordant, index)
        for index in range(discordant + 1)
        if math.comb(discordant, index) <= observed
    )
    return numerator, 2 ** discordant


def _quantize(value: Decimal) -> str:
    return format(value.quantize(QUANTUM, rounding=ROUND_HALF_EVEN), 'f')


def _keys(value, found: set[str]) -> None:
    if isinstance(value, dict):
        found.update(value)
        for item in value.values():
            _keys(item, found)
    elif isinstance(value, list):
        for item in value:
            _keys(item, found)


class LeakDependenceTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _write(self, name: str, payload) -> str:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding='utf-8')
        return name.replace('\\', '/')

    def _defect(self, defect_id: str, family: str = 'D1', difficulty: str = 'L1') -> dict:
        return {
            'after': QUOTES[defect_id],
            'before': BEFORE,
            'defectId': defect_id,
            'difficulty': difficulty,
            'family': family,
            'pageIndex': 0,
            'rationale': RATIONALE,
        }

    def _gold(self, name: str, defect_ids, family: str = 'D1', difficulty: str = 'L1') -> str:
        defects = [self._defect(defect_id, family, difficulty) for defect_id in defect_ids]
        return self._write(name, {'defects': defects, 'schema': 'falsify.red-gold-ledger.v1'})

    def _blue(self, name: str, agent: str, defect_ids, model: str | None = None, decision: str = 'defect') -> str:
        findings = [
            {'decision': decision, 'id': f'f-{agent}-{defect_id}', 'pageIndex': 0, 'quote': QUOTES[defect_id]}
            for defect_id in defect_ids
        ]
        payload = {'agentId': agent, 'findings': findings, 'schema': 'falsify.blue-report.v1'}
        if model is not None:
            payload['model'] = model
        return self._write(name, payload)

    def _manifest(self, arms: list[dict]) -> Path:
        path = self.root / 'manifest.json'
        path.write_text(
            json.dumps({'arms': arms, 'schema': leak.INPUT_SCHEMA}),
            encoding='utf-8',
        )
        return path

    def _arm(self, arm: str, pair_id: str, gold: str, blues: list[str], baseline: str | None = None) -> dict:
        entry = {'arm': arm, 'blueRuns': blues, 'gold': gold, 'pairId': pair_id}
        if baseline is not None:
            entry['baselineSignals'] = baseline
        return entry

    def _pair(self, pair_id, pdf_gold, pdf_blues, source_gold, source_blues, baseline=None) -> list[dict]:
        return [
            self._arm('pdf-mutation', pair_id, pdf_gold, pdf_blues, baseline),
            self._arm('source-native', pair_id, source_gold, source_blues, baseline),
        ]

    def _evaluate(self, manifest: Path, allow_mixed: bool = False) -> dict:
        return leak.evaluate_manifest(manifest, allow_mixed=allow_mixed)

    def _main(self, argv: list[str]) -> tuple[int, str]:
        held = io.BytesIO()
        fake = mock.Mock()
        fake.buffer = held
        with mock.patch('leak_dependence.sys.stdout', fake):
            code = leak.main(argv)
        return code, held.getvalue().decode('utf-8')

    def _cell(self, report: dict, arm: str, family: str = 'D1', difficulty: str = 'L1') -> dict:
        matches = [
            row for row in report['byArmFamilyDifficulty']
            if row['arm'] == arm and row['family'] == family and row['difficulty'] == difficulty
        ]
        self.assertEqual(len(matches), 1)
        return matches[0]

    def test_wilson_and_mcnemar_match_independent_exact_values(self):
        self.assertEqual(leak.WILSON_Z, WILSON_Z)
        literals = {
            (5, 5): ('0.565518', '1.000000'),
            (0, 5): ('0.000000', '0.434482'),
            (3, 5): ('0.230724', '0.882379'),
            (1, 2): ('0.094531', '0.905469'),
        }
        for (detected, total), expected in literals.items():
            self.assertEqual(independent_wilson(detected, total), expected)
            self.assertEqual(leak.wilson_interval(detected, total), expected)
        self.assertEqual(independent_mcnemar(5, 0), (2, 32))
        self.assertEqual(leak.mcnemar_exact(5, 0), (2, 32))
        self.assertEqual(independent_mcnemar(0, 0), (1, 1))
        self.assertEqual(leak.mcnemar_exact(0, 0), (1, 1))

    def test_equal_recall_is_zero_difference_and_not_conclusive(self):
        detected = ['d1', 'd2', 'd3', 'd4']
        gold = self._gold('gold.json', ['d1', 'd2', 'd3', 'd4', 'd5'])
        blue = self._blue('blue.json', 'reader', detected)
        baseline = self._write('baseline.json', {
            'schema': 'falsify.blue-defect-sensor.v1',
            'signals': [{'excerpt': 'preexisting unrelated signal text', 'id': 'base', 'pageIndex': 4}],
        })
        manifest = self._manifest(self._pair('p1', gold, [blue], gold, [blue], baseline))
        first = self._evaluate(manifest)
        second = self._evaluate(manifest)
        self.assertEqual(leak.dump_report(first), leak.dump_report(second))
        self.assertEqual(leak.render_markdown(first), leak.render_markdown(second))
        self.assertEqual(leak.render_csv(first), leak.render_csv(second))
        self.assertEqual(first['schema'], leak.SCHEMA)
        self.assertEqual(first['pairCount'], 1)
        self.assertEqual(first['evaluationCalls'], 2)
        self.assertEqual(first['pairing'], 'aligned-run')
        self.assertIn('agreement.units', first['perDefectOutcomeMethod'])
        self.assertNotIn(str(self.root), leak.dump_report(first))
        paired = first['paired']
        self.assertEqual(paired['both'], 4)
        self.assertEqual(paired['neither'], 1)
        self.assertEqual(paired['pdfOnly'], 0)
        self.assertEqual(paired['sourceOnly'], 0)
        self.assertEqual(paired['pdfRecall'], '0.800000')
        self.assertEqual(paired['sourceRecall'], '0.800000')
        self.assertEqual(paired['pairedRecallDifference'], '0.000000')
        self.assertEqual((paired['mcnemarNumerator'], paired['mcnemarDenominator']), (1, 1))
        self.assertEqual(paired['mcnemarP'], '1/1')
        self.assertFalse(paired['insufficient'])
        for arm in ('pdf-mutation', 'source-native'):
            cell = self._cell(first, arm)
            self.assertEqual((cell['total'], cell['detected'], cell['recall']), (5, 4, '0.800000'))
            self.assertEqual(
                (cell['wilson95']['low'], cell['wilson95']['high']),
                independent_wilson(4, 5),
            )
            self.assertFalse(cell['insufficient'])
        self.assertIn('not conclusive', first['interpretation'])
        self.assertIn('fewer than 10 pairs (1)', first['interpretation'])
        self.assertNotIn('fewer than 5 trials', first['interpretation'])

    def test_pdf_only_detections_wilson_and_mcnemar(self):
        ids = ['d1', 'd2', 'd3', 'd4', 'd5']
        pdf_gold = self._gold('pdf-gold.json', ids)
        source_gold = self._gold('source-gold.json', ids)
        pdf_blue = self._blue('pdf-blue.json', 'reader', ids)
        source_blue = self._blue('source-blue.json', 'reader', [])
        report = self._evaluate(self._manifest(self._pair('p-pdf', pdf_gold, [pdf_blue], source_gold, [source_blue])))
        paired = report['paired']
        self.assertEqual(paired['pdfOnly'], 5)
        self.assertEqual(paired['sourceOnly'], 0)
        self.assertEqual(paired['both'], 0)
        self.assertEqual(paired['neither'], 0)
        self.assertEqual(paired['pairedRecallDifference'], '1.000000')
        self.assertEqual(independent_mcnemar(5, 0), (paired['mcnemarNumerator'], paired['mcnemarDenominator']))
        self.assertEqual(paired['mcnemarP'], '1/16')
        pdf_cell = self._cell(report, 'pdf-mutation')
        source_cell = self._cell(report, 'source-native')
        self.assertEqual((pdf_cell['wilson95']['low'], pdf_cell['wilson95']['high']), ('0.565518', '1.000000'))
        self.assertEqual((source_cell['wilson95']['low'], source_cell['wilson95']['high']), ('0.000000', '0.434482'))
        self.assertFalse(pdf_cell['insufficient'])
        self.assertFalse(source_cell['insufficient'])
        self.assertEqual(pdf_cell['recall'], '1.000000')
        self.assertEqual(source_cell['recall'], '0.000000')

    def test_insufficient_flag_mentions_small_cells(self):
        ids = ['d1', 'd2', 'd3', 'd4']
        gold = self._gold('gold.json', ids)
        blue = self._blue('blue.json', 'reader', ids)
        report = self._evaluate(self._manifest(self._pair('p1', gold, [blue], gold, [blue])))
        self.assertTrue(self._cell(report, 'pdf-mutation')['insufficient'])
        self.assertTrue(report['paired']['insufficient'])
        self.assertIn('not conclusive', report['interpretation'])
        self.assertIn('fewer than 10 pairs (1)', report['interpretation'])
        self.assertIn('one or more cells have fewer than 5 trials', report['interpretation'])

    def test_ten_pairs_with_adequate_cells_are_conclusive(self):
        ids = ['d1', 'd2', 'd3', 'd4', 'd5']
        gold = self._gold('gold.json', ids)
        blue = self._blue('blue.json', 'reader', ids)
        arms = []
        for index in range(10):
            arms.extend(self._pair(f'p{index:02d}', gold, [blue], gold, [blue]))
        report = self._evaluate(self._manifest(arms))
        self.assertEqual(report['pairCount'], 10)
        self.assertEqual(report['evaluationCalls'], 20)
        self.assertFalse(report['paired']['insufficient'])
        self.assertFalse(self._cell(report, 'pdf-mutation')['insufficient'])
        self.assertEqual(self._cell(report, 'pdf-mutation')['total'], 50)
        self.assertEqual(report['paired']['pairedRecallDifference'], '0.000000')
        self.assertEqual(report['paired']['mcnemarP'], '1/1')
        self.assertEqual(
            report['interpretation'],
            'Across 10 pairs, pdf-mutation recall minus source-native recall is 0.000000 '
            '(exact McNemar p = 1/1).',
        )
        self.assertNotIn('not conclusive', report['interpretation'])

    def test_runs_align_by_agent_label_not_file_order(self):
        gold = self._gold('gold.json', ['d1'])
        pdf_a = self._blue('pdf-a.json', 'agent-a', ['d1'])
        pdf_b = self._blue('pdf-b.json', 'agent-b', [])
        source_b = self._blue('source-b.json', 'agent-b', [])
        source_a = self._blue('source-a.json', 'agent-a', ['d1'])
        report = self._evaluate(self._manifest(self._pair(
            'p1', gold, [pdf_a, pdf_b], gold, [source_b, source_a],
        )))
        paired = report['paired']
        self.assertEqual(paired['both'], 1)
        self.assertEqual(paired['neither'], 1)
        self.assertEqual(paired['pdfOnly'], 0)
        self.assertEqual(paired['sourceOnly'], 0)
        self.assertEqual(paired['total'], 2)
        cell = self._cell(report, 'pdf-mutation')
        self.assertEqual((cell['total'], cell['detected'], cell['recall']), (2, 1, '0.500000'))
        self.assertEqual((cell['wilson95']['low'], cell['wilson95']['high']), ('0.094531', '0.905469'))
        self.assertTrue(cell['insufficient'])

    def test_uncertain_rating_counts_as_a_miss(self):
        gold = self._gold('gold.json', ['d1'])
        blue = self._blue('blue.json', 'reader', ['d1'], decision='uncertain')
        report = self._evaluate(self._manifest(self._pair('p1', gold, [blue], gold, [blue])))
        self.assertEqual(report['paired']['neither'], 1)
        self.assertEqual(report['paired']['pdfDetected'], 0)
        self.assertEqual(self._cell(report, 'pdf-mutation')['detected'], 0)
        self.assertTrue(report['uncertainCountsAsMissed'])

    def test_unpaired_reason_is_kept_out_of_markdown_and_csv_identifiers(self):
        pdf_gold = self._gold('pdf-gold.json', ['d1'])
        source_gold = self._gold('source-gold.json', ['d1', 'd2', 'd3'])
        self._write('pair.json', {
            'defects': [
                {'defectId': 'd2', 'reason': 'figure-image', 'status': 'unsupported'},
                {'defectId': 'd3', 'reason': 'see before text', 'status': 'unsupported'},
                {'defectId': 'd2', 'reason': 'applied-note', 'status': 'applied'},
            ],
            'pairId': 'p1',
            'schema': 'falsify.source-pdf-pair.v1',
        })
        pdf_blue = self._blue('pdf-blue.json', 'reader', ['d1'])
        source_blue = self._blue('source-blue.json', 'reader', ['d1'])
        manifest = self._manifest(self._pair('p1', pdf_gold, [pdf_blue], source_gold, [source_blue]))
        report = self._evaluate(manifest)
        by_id = {row['defectId']: row for row in report['unpaired']}
        self.assertEqual(set(by_id), {'d2', 'd3'})
        self.assertEqual(by_id['d2']['arm'], 'source-native')
        self.assertEqual(by_id['d2']['reason'], 'figure-image')
        self.assertIsNone(by_id['d3']['reason'])
        self.assertEqual(report['paired']['both'], 1)
        markdown = leak.render_markdown(report)
        rendered_csv = leak.render_csv(report)
        dumped = leak.dump_report(report)
        self.assertIn('figure-image', markdown)
        self.assertIn('d2', dumped)
        for text in (markdown, rendered_csv, dumped):
            self.assertNotIn(BEFORE, text)
            self.assertNotIn(RATIONALE, text)
            self.assertNotIn('see before text', text)
            for quote in QUOTES.values():
                self.assertNotIn(quote, text)
        for banned in ('defectId', 'before', 'after', 'rationale', 'operationId', 'overridesApplied'):
            self.assertNotIn(banned, markdown)
            self.assertNotIn(banned, rendered_csv)
        keys = set()
        _keys(report, keys)
        self.assertIn('defectId', keys)
        for banned in ('before', 'after', 'rationale', 'operationId', 'overridesApplied'):
            self.assertNotIn(banned, keys)
        self.assertEqual(markdown.count('\n## '), 3)
        views = [row['view'] for row in csv.DictReader(io.StringIO(rendered_csv))]
        self.assertIn('cell', views)
        self.assertIn('paired', views)
        self.assertIn('paired-overall', views)
        self.assertIn('unpaired', views)

    def test_family_mismatch_stays_in_the_overall_paired_view(self):
        pdf_gold = self._gold('pdf-gold.json', ['d1'], family='D1')
        source_gold = self._gold('source-gold.json', ['d1'], family='D2')
        blue = self._blue('blue.json', 'reader', ['d1'])
        report = self._evaluate(self._manifest(self._pair('p1', pdf_gold, [blue], source_gold, [blue])))
        self.assertEqual(report['paired']['both'], 1)
        self.assertEqual(report['pairedByFamilyDifficulty'], [])
        self.assertEqual(report['strataMismatchTrials'], 1)
        self.assertEqual(self._cell(report, 'pdf-mutation', 'D1')['total'], 1)
        self.assertEqual(self._cell(report, 'source-native', 'D2')['total'], 1)

    def test_comparability_guard_and_allow_mixed_union(self):
        gold = self._gold('gold.json', ['d1'])
        pdf_a = self._blue('pdf-a.json', 'agent-a', ['d1'], model='model-a')
        pdf_a_again = self._blue('pdf-a2.json', 'agent-a', ['d1'], model='model-a')
        source_b = self._blue('source-b.json', 'agent-a', [], model='model-b')
        manifest = self._manifest(self._pair('p1', gold, [pdf_a], gold, [source_b]))
        code, text = self._main([str(manifest), '--markdown', str(self.root / 'blocked.md')])
        self.assertEqual(code, 3)
        self.assertEqual(json.loads(text)['error'], 'arms_not_comparable')
        self.assertFalse((self.root / 'blocked.md').exists())
        mixed = self._evaluate(manifest, allow_mixed=True)
        self.assertEqual(mixed['pairing'], 'union-per-defect')
        self.assertTrue(mixed['allowMixed'])
        self.assertEqual(mixed['paired']['pdfOnly'], 1)
        repeated = self._manifest(self._pair('p1', gold, [pdf_a, pdf_a_again], gold, [source_b]))
        code, text = self._main([str(repeated)])
        self.assertEqual(code, 3)
        self.assertEqual(json.loads(text)['error'], 'arms_not_comparable')
        union = self._evaluate(repeated, allow_mixed=True)
        self.assertEqual(union['paired']['total'], 1)
        self.assertEqual(union['paired']['pdfOnly'], 1)
        self.assertEqual(self._cell(union, 'pdf-mutation')['total'], 2)
        self.assertEqual(self._cell(union, 'source-native')['total'], 1)

    def test_cli_exit_codes_renderers_and_determinism(self):
        ids = ['d1', 'd2', 'd3', 'd4', 'd5']
        gold = self._gold('gold.json', ids)
        pdf_blue = self._blue('pdf-blue.json', 'reader', ids)
        source_blue = self._blue('source-blue.json', 'reader', [])
        manifest = self._manifest(self._pair('p1', gold, [pdf_blue], gold, [source_blue]))
        out = self.root / 'report.json'
        markdown = self.root / 'report.md'
        table = self.root / 'report.csv'
        env = dict(os.environ)
        env['PYTHONUTF8'] = '1'
        proc = subprocess.run(
            [sys.executable, str(CLI_PATH), str(manifest), '--out', str(out), '--markdown', str(markdown), '--csv', str(table)],
            capture_output=True, check=False, env=env,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', errors='replace'))
        report = json.loads(out.read_text(encoding='utf-8'))
        self.assertEqual(json.loads(proc.stdout.decode('utf-8')), report)
        self.assertEqual(markdown.read_text(encoding='utf-8'), leak.render_markdown(report))
        self.assertEqual(table.read_text(encoding='utf-8'), leak.render_csv(report))
        again = subprocess.run(
            [sys.executable, str(CLI_PATH), str(manifest)],
            capture_output=True, check=False, env=env,
        )
        self.assertEqual(proc.stdout, again.stdout)
        code, text = self._main([])
        self.assertEqual(code, 2)
        self.assertEqual(text, '')
        code, text = self._main([str(self.root / 'missing.json')])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(text)['error'], 'invalid_input')
        single = self._manifest([self._arm('pdf-mutation', 'p1', gold, [pdf_blue])])
        code, text = self._main([str(single)])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(text)['error'], 'single_arm')
        same_kind = self._manifest([
            self._arm('pdf-mutation', 'p1', gold, [pdf_blue]),
            self._arm('pdf-mutation', 'p2', gold, [pdf_blue]),
        ])
        self.assertEqual(json.loads(self._main([str(same_kind)])[1])['error'], 'single_arm')
        duplicate = self._manifest(self._pair('p1', gold, [pdf_blue], gold, [source_blue]) * 2)
        self.assertEqual(json.loads(self._main([str(duplicate)])[1])['error'], 'duplicate_arm')
        absolute = self._manifest(self._pair('p1', 'C:/leak-dependence-absolute.json', [pdf_blue], gold, [source_blue]))
        self.assertEqual(json.loads(self._main([str(absolute)])[1])['error'], 'path_invalid')
        bad_schema = self.root / 'bad.json'
        bad_schema.write_text('{"schema": "nope", "arms": []}', encoding='utf-8')
        self.assertEqual(json.loads(self._main([str(bad_schema)])[1])['error'], 'invalid_input')

    def test_duplicate_defect_is_invalid(self):
        gold = self._write('gold.json', {
            'defects': [self._defect('d1'), self._defect('d1')],
            'schema': 'falsify.red-gold-ledger.v1',
        })
        blue = self._blue('blue.json', 'reader', ['d1'])
        code, text = self._main([str(self._manifest(self._pair('p1', gold, [blue], gold, [blue])))])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(text)['error'], 'duplicate_defect')

    def test_run_lists_and_single_defect_rescore_match_the_primary_counts(self):
        ids = ['d1', 'd2']
        gold = self._gold('gold.json', ids)
        pdf_blue = self._blue('pdf-blue.json', 'reader', ['d1'])
        source_blue = self._blue('source-blue.json', 'reader', ['d2'])
        manifest = self._manifest(self._pair('p1', gold, [pdf_blue], gold, [source_blue]))
        primary = self._evaluate(manifest)
        real = leak.evaluate_arena_match

        def hide_units(gold_doc, blues, baseline_signals=None):
            report = real(gold_doc, blues, baseline_signals=baseline_signals)
            items = gold_doc.get('defects') if isinstance(gold_doc, dict) else gold_doc
            if isinstance(items, list) and len(items) > 1:
                stripped = dict(report)
                stripped['agreement'] = None
                return stripped
            return report

        def hide_outcomes(gold_doc, blues, baseline_signals=None):
            report = real(gold_doc, blues, baseline_signals=baseline_signals)
            items = gold_doc.get('defects') if isinstance(gold_doc, dict) else gold_doc
            if isinstance(items, list) and len(items) > 1:
                return {'agreement': {'units': []}, 'runs': [{'matchedPairs': [], 'missedDefectIds': ['missing']}]}
            return report

        with mock.patch.object(leak, 'evaluate_arena_match', hide_units):
            listed = self._evaluate(manifest)
        with mock.patch.object(leak, 'evaluate_arena_match', hide_outcomes):
            rescored = self._evaluate(manifest)
        self.assertIn('matchedPairs', listed['perDefectOutcomeMethod'])
        self.assertEqual(listed['evaluationCalls'], 2)
        self.assertIn('single-defect', rescored['perDefectOutcomeMethod'])
        self.assertEqual(rescored['evaluationCalls'], 6)
        for report in (listed, rescored):
            self.assertEqual(report['paired']['pdfOnly'], primary['paired']['pdfOnly'])
            self.assertEqual(report['paired']['sourceOnly'], primary['paired']['sourceOnly'])
            self.assertEqual(report['paired']['both'], primary['paired']['both'])
            self.assertEqual(report['paired']['neither'], primary['paired']['neither'])
            self.assertEqual(self._cell(report, 'pdf-mutation')['detected'], 1)
            self.assertEqual(self._cell(report, 'source-native')['detected'], 1)

    def test_production_functions_stay_within_ccn_15(self):
        source = CLI_PATH.read_text(encoding='utf-8')
        proc = subprocess.run(
            [sys.executable, str(PY_CCN_PATH)],
            capture_output=True, check=False, input=source.encode('utf-8'),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', errors='replace'))
        functions = json.loads(proc.stdout.decode('utf-8'))
        violations = [fn for fn in functions if fn['ccn'] > 15]
        self.assertEqual([(fn['id'], fn['ccn']) for fn in violations], [])


if __name__ == '__main__':
    unittest.main()
