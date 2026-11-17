"""Source-native and pdf-mutation arena scoring, plus base-SHA invariance."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import unittest

EVAL_DIR = Path(__file__).resolve().parent
if str(EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(EVAL_DIR))

import arena_runner as mod  # noqa: E402

# Per-run numbers and canonical JSON digests were computed on base SHA
# 8cf646028d0fb0c500923f7651417e53ae9bd04f before this scorer change.
BASE_SHA = '8cf646028d0fb0c500923f7651417e53ae9bd04f'
FLOAT_KEYS = frozenset({'recall', 'precision', 'f1', 'stealthYield'})
BASE_RUN_LITERALS = {
    'test_bipartite_matching_baseline_exemption_stratified_metrics_and_stealth_yield': [
        {
            'tp': 4, 'fn': 0, 'pureFp': 0, 'preExistingExempted': 1, 'abstainedCount': 0,
            'recall': 1.0, 'precision': 1.0, 'f1': 1.0,
            'stealthTotal': 3, 'stealthEvaded': 0, 'stealthYield': 0.0,
        },
    ],
    'test_coordinated_red_record_input_shape': [
        {
            'tp': 1, 'fn': 0, 'pureFp': 0, 'preExistingExempted': 0, 'abstainedCount': 0,
            'recall': 1.0, 'precision': 1.0, 'f1': 1.0,
            'stealthTotal': 0, 'stealthEvaded': 0, 'stealthYield': None,
        },
    ],
    'test_multi_agent_alpha_selective_prediction_and_stealth_evasion': [
        {
            'tp': 2, 'fn': 2, 'pureFp': 0, 'preExistingExempted': 0, 'abstainedCount': 2,
            'recall': 0.5, 'precision': 1.0, 'f1': 0.6667,
            'stealthTotal': 3, 'stealthEvaded': 2, 'stealthYield': 0.6667,
        },
        {
            'tp': 2, 'fn': 2, 'pureFp': 0, 'preExistingExempted': 0, 'abstainedCount': 2,
            'recall': 0.5, 'precision': 1.0, 'f1': 0.6667,
            'stealthTotal': 3, 'stealthEvaded': 2, 'stealthYield': 0.6667,
        },
        {
            'tp': 1, 'fn': 3, 'pureFp': 1, 'preExistingExempted': 1, 'abstainedCount': 1,
            'recall': 0.25, 'precision': 0.5, 'f1': 0.3333,
            'stealthTotal': 3, 'stealthEvaded': 3, 'stealthYield': 1.0,
        },
    ],
}

_TABLE_CONTEXTS = [
    {'surface': 'table:T2', 'before': 'arm n was 10', 'after': 'arm n was 90'},
    {'surface': 'table:T2', 'before': 'events were 11', 'after': 'events were 91'},
    {'surface': 'table:T2', 'before': 'loss was 12', 'after': 'loss was 92'},
]


def _finding(finding_id, quote, page=0):
    item = {'id': finding_id, 'decision': 'defect', 'quote': quote}
    if page is not None:
        item['pageIndex'] = page
    return item


def _defect(**overrides):
    item = {
        'defectId': 'd1',
        'family': 'D1',
        'world': 'W1',
        'difficulty': 'L2',
        'pageIndex': 0,
        'quote': 'quoted surface stays the primary text',
        'before': 'old primary wording',
        'after': 'new primary wording',
        'stealthPass': False,
    }
    item.update(overrides)
    return item


def _ledger(defects, producer=None):
    document = {'schema': 'falsify.red-gold-ledger.v1', 'defects': defects}
    if producer is not None:
        document['producer'] = producer
    return document


def _evaluate(defects, findings, producer=None):
    gold = _ledger(defects, producer=producer)
    blue = {'runId': 'blue', 'findings': findings}
    return mod.evaluate_arena_match(gold, [blue])


def _sha(report, *, sort_keys):
    blob = json.dumps(report, ensure_ascii=False, sort_keys=sort_keys, separators=(',', ':'))
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()


def _assert_numbers(test, run, expected, label):
    for key, value in expected.items():
        if key in FLOAT_KEYS:
            if value is None:
                test.assertIsNone(run[key], (label, key))
            else:
                test.assertAlmostEqual(run[key], value, places=4, msg=f'{label} {key}')
        else:
            test.assertEqual(run[key], value, (label, key))


class SourceNativeScoringTests(unittest.TestCase):
    def test_extra_validator_families_appear_only_when_gold_has_them(self):
        plain = _evaluate([_defect(family='D1', quote='plain family stays inside the base buckets', after='plain family stays inside the base buckets')], [
            _finding('f1', 'plain family stays inside the base buckets'),
        ])
        self.assertEqual(list(plain['runs'][0]['byFamily']), list(mod.FAMILIES))
        self.assertEqual(list(plain['aggregate']['byFamily']), list(mod.FAMILIES))
        self.assertNotIn('S1', plain['runs'][0]['byFamily'])
        self.assertNotIn('D4-1', plain['aggregate']['byFamily'])
        self.assertNotIn('goldProducer', plain)
        self.assertNotIn('stealthNotAudited', plain['runs'][0])

        mixed = _evaluate([
            _defect(defectId='sub', family='D4-1', quote='subgroup row was split from the parent', after='subgroup row was split from the parent'),
            _defect(defectId='spin', family='S1', quote='association was rewritten as causation', after='association was rewritten as causation'),
        ], [
            _finding('f-sub', 'subgroup row was split from the parent'),
        ])
        for block in (mixed['runs'][0]['byFamily'], mixed['aggregate']['byFamily']):
            keys = list(block)
            self.assertEqual(keys[:len(mod.FAMILIES)], list(mod.FAMILIES))
            self.assertEqual(keys[len(mod.FAMILIES):], ['D4-1', 'S1'])
            self.assertEqual(block['D4-1']['total'], 1)
            self.assertEqual(block['D4-1']['detected'], 1)
            self.assertEqual(block['S1']['total'], 1)
            self.assertEqual(block['S1']['missed'], 1)

    def test_extra_family_bucket_is_pooled_across_runs(self):
        gold = _ledger([_defect(family='S1', quote='association was rewritten as causation', after='association was rewritten as causation')])
        caught = {'runId': 'caught', 'findings': [_finding('f1', 'association was rewritten as causation')]}
        missed = {'runId': 'missed', 'findings': []}
        report = mod.evaluate_arena_match(gold, [caught, missed])
        pooled = report['aggregate']['byFamily']['S1']
        self.assertEqual(pooled['total'], 2)
        self.assertEqual(pooled['detected'], 1)
        self.assertEqual(pooled['missed'], 1)
        self.assertAlmostEqual(pooled['recall'], 0.5, places=4)

    def test_not_audited_defects_are_excluded_from_stealth_yield(self):
        audited = _defect(
            defectId='audited', family='D2', stealthPass=True,
            quote='figure axis was rescaled on purpose', after='figure axis was rescaled on purpose',
        )
        native = _defect(
            defectId='native', family='S1', pageIndex=1, stealthPass=True, stealthStatus='not_audited',
            quote='hedge removed from the limitation', after='hedge removed from the limitation',
        )
        gold = _ledger([audited, native], producer='source-native')
        missed = {'runId': 'missed', 'findings': []}
        caught = {'runId': 'caught', 'findings': [_finding('f1', 'figure axis was rescaled on purpose')]}
        report = mod.evaluate_arena_match(gold, [missed, caught])
        self.assertEqual(report['goldProducer'], 'source-native')
        miss_run, hit_run = report['runs']
        self.assertEqual(miss_run['stealthTotal'], 1)
        self.assertEqual(miss_run['stealthEvaded'], 1)
        self.assertAlmostEqual(miss_run['stealthYield'], 1.0, places=4)
        self.assertEqual(miss_run['stealthNotAudited'], 1)
        self.assertEqual(hit_run['stealthTotal'], 1)
        self.assertEqual(hit_run['stealthEvaded'], 0)
        self.assertAlmostEqual(hit_run['stealthYield'], 0.0, places=4)
        self.assertEqual(hit_run['stealthNotAudited'], 1)
        self.assertAlmostEqual(report['aggregate']['stealthYield'], 0.5, places=4)

    def test_context_after_matches_once_and_a_second_context_is_not_a_false_positive(self):
        defect = _defect(stealthStatus='not_audited', source={'contexts': _TABLE_CONTEXTS})
        report = _evaluate([defect], [
            _finding('f-quote', 'quoted surface stays the primary text'),
            _finding('f-row', 'events were 91'),
            _finding('f-other', 'loss was 92'),
        ], producer='source-native')
        run = report['runs'][0]
        self.assertEqual(run['tp'], 1)
        self.assertEqual(run['fn'], 0)
        self.assertEqual(run['pureFp'], 0)
        self.assertEqual(run['precision'], 1.0)
        self.assertEqual(run['pureFalsePositives'], [])
        self.assertEqual(run['matchedPairs'][0]['findingId'], 'f-quote')
        self.assertEqual(run['splitOfMatchedFindingIds'], ['f-row', 'f-other'])
        self.assertEqual(run['stealthNotAudited'], 1)
        self.assertEqual(run['stealthTotal'], 0)
        self.assertIsNone(run['stealthYield'])

        row_only = _evaluate([defect], [
            _finding('f-mid', 'events were 91'),
            _finding('f-last', 'loss was 92'),
        ], producer='source-native')
        row_run = row_only['runs'][0]
        self.assertEqual(row_run['tp'], 1)
        self.assertEqual(row_run['fn'], 0)
        self.assertEqual(row_run['pureFp'], 0)
        self.assertEqual(row_run['matchedPairs'][0]['findingId'], 'f-mid')
        self.assertEqual(row_run['splitOfMatchedFindingIds'], ['f-last'])

    def test_context_matching_follows_existing_page_tolerance(self):
        defect = _defect(pageIndex=2, stealthStatus='not_audited', source={'contexts': _TABLE_CONTEXTS})
        same_page = _evaluate([defect], [_finding('f1', 'events were 91', page=2)], producer='pdf-mutation')
        self.assertEqual(same_page['goldProducer'], 'pdf-mutation')
        self.assertEqual(same_page['runs'][0]['tp'], 1)
        self.assertEqual(same_page['runs'][0]['pureFp'], 0)

        other_page = _evaluate([defect], [_finding('f1', 'events were 91', page=4)], producer='pdf-mutation')
        self.assertEqual(other_page['runs'][0]['tp'], 0)
        self.assertEqual(other_page['runs'][0]['pureFp'], 1)

        unpaged = _defect(pageIndex=None, stealthStatus='not_audited', source={'contexts': _TABLE_CONTEXTS})
        tolerant = _evaluate([unpaged], [_finding('f1', 'loss was 92', page=3)], producer='source-native')
        self.assertEqual(tolerant['runs'][0]['tp'], 1)
        self.assertEqual(tolerant['runs'][0]['pureFp'], 0)

    def test_context_text_does_not_match_unless_producer_opts_in(self):
        defect = _defect(source={'contexts': _TABLE_CONTEXTS})
        for producer in (None, 'legacy'):
            report = _evaluate([defect], [_finding('f1', 'events were 91')], producer=producer)
            self.assertEqual(report['runs'][0]['tp'], 0, producer)
            self.assertEqual(report['runs'][0]['pureFp'], 1, producer)
            if producer is None:
                self.assertNotIn('goldProducer', report)
            else:
                self.assertEqual(report['goldProducer'], 'legacy')

        stripped = _evaluate(
            [_defect(stealthStatus='not_audited', source={'contexts': _TABLE_CONTEXTS})],
            [_finding('f1', 'events were 91')],
            producer='  source-native  ',
        )
        self.assertEqual(stripped['goldProducer'], 'source-native')
        self.assertEqual(stripped['runs'][0]['tp'], 1)

        listed = mod.evaluate_arena_match(
            [_defect(quote='value 99.1 percent shown', after='value 99.1 percent shown')],
            {'findings': [_finding('f1', 'value 99.1 percent shown')]},
        )
        self.assertNotIn('goldProducer', listed)
        self.assertEqual(listed['runs'][0]['tp'], 1)


class BaseShaInvarianceTests(unittest.TestCase):
    def test_every_existing_fixture_matches_base_sha_json(self):
        self.assertEqual(BASE_SHA, '8cf646028d0fb0c500923f7651417e53ae9bd04f')
        seen = set()
        for case in _BASE_FIXTURES:
            seen.add(case['test'])
            report = mod.evaluate_arena_match(
                case['gold'], case['blue'], baseline_signals=case['baseline'],
            )
            self.assertEqual(_sha(report, sort_keys=True), case['sha256'], case['test'])
            self.assertEqual(_sha(report, sort_keys=False), case['orderSha256'], case['test'])
            self.assertNotIn('goldProducer', report)
            self.assertEqual(len(report['runs']), len(case['runs']), case['test'])
            for run, expected in zip(report['runs'], case['runs']):
                self.assertNotIn('stealthNotAudited', run, case['test'])
                self.assertEqual(list(run['byFamily']), expected['byFamilyKeys'], case['test'])
                metrics = {key: value for key, value in expected.items() if key != 'byFamilyKeys'}
                _assert_numbers(self, run, metrics, case['test'])
            literals = BASE_RUN_LITERALS.get(case['test'])
            if literals is None:
                continue
            self.assertEqual(len(literals), len(report['runs']), case['test'])
            for run, expected in zip(report['runs'], literals):
                _assert_numbers(self, run, expected, case['test'])
        self.assertEqual(len(_BASE_FIXTURES), 11)
        self.assertTrue(set(BASE_RUN_LITERALS) <= seen)


_BASE_FIXTURES = json.loads(r'''
[
  {
    "test": "test_bipartite_matching_baseline_exemption_stratified_metrics_and_stealth_yield",
    "sha256": "e50ed29f59de569a352aecf025540839d40901bafbc371ff31e123634840a1c5",
    "orderSha256": "d9c558c4128265f301ad656672b159eaaaca3bcb296bd18104f5b7803c34112d",
    "gold": {
      "schema": "falsify.red-gold-ledger.v1",
      "defects": [
        {
          "defectId": "g-prose",
          "world": "W1",
          "family": "D1",
          "difficulty": "L1",
          "pageIndex": 1,
          "after": "Overall mortality was 14.2% (p = 0.041) in the intervention arm.",
          "stealthPass": false
        },
        {
          "defectId": "g-bbox",
          "world": "W2",
          "family": "D5",
          "difficulty": "L2",
          "pageIndex": 2,
          "bbox": [
            100.0,
            200.0,
            300.0,
            360.0
          ],
          "after": "Kaplan-Meier figure bar height altered.",
          "stealthPass": true
        },
        {
          "defectId": "g-table",
          "world": "W3",
          "family": "D3",
          "difficulty": "L3",
          "pageIndex": 3,
          "itemId": "table-1",
          "after": "Row total 48 disagrees with 21 + 24.",
          "stealthPass": true
        },
        {
          "defectId": "g-supp",
          "world": "W5",
          "family": "D6",
          "difficulty": "L4",
          "supplementName": "Table_S1.csv",
          "after": "Supplemental subgroup N=190 mismatches main N=180.",
          "stealthStatus": "clean"
        }
      ]
    },
    "blue": [
      {
        "runId": "blue-main",
        "agentId": "agent-a",
        "findings": [
          {
            "id": "f1",
            "decision": "defect",
            "pageIndex": 1,
            "quote": "In Results, overall mortality was 14.2% (p = 0.041) in the intervention arm."
          },
          {
            "id": "f2",
            "decision": "defect",
            "pageIndex": 2,
            "bbox": [
              110.0,
              210.0,
              290.0,
              350.0
            ],
            "quote": "Visual inconsistency in figure curve."
          },
          {
            "id": "f3",
            "decision": "defect",
            "pageIndex": 3,
            "itemId": "table-1",
            "quote": "Table 1 arithmetic discrepancy."
          },
          {
            "id": "f4",
            "decision": "defect",
            "supplementName": "Table_S1.csv",
            "quote": "Supplemental file N=190 conflicts with main text."
          },
          {
            "id": "f5",
            "decision": "defect",
            "pageIndex": 4,
            "excerpt": "Reference 12 DOI 10.1000/preexisting-error disagrees with link."
          }
        ]
      }
    ],
    "baseline": {
      "schema": "falsify.blue-defect-sensor.v1",
      "signals": [
        {
          "id": "sens-1",
          "family": "D2",
          "pageIndex": 4,
          "excerpt": "Reference 12 DOI 10.1000/preexisting-error disagrees with link."
        }
      ]
    },
    "runs": [
      {
        "runId": "blue-main",
        "tp": 4,
        "fn": 0,
        "pureFp": 0,
        "preExistingExempted": 1,
        "abstainedCount": 0,
        "recall": 1.0,
        "precision": 1.0,
        "f1": 1.0,
        "stealthTotal": 3,
        "stealthEvaded": 0,
        "stealthYield": 0.0,
        "missedDefectIds": [],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [
          "f5"
        ],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      }
    ]
  },
  {
    "test": "test_coordinated_red_record_input_shape",
    "sha256": "035bcc7c0ddaa2e157bd402ed4d32b8942d2cdac6dd274399ee19cea7fc13933",
    "orderSha256": "0789d9df5efa43d788aa89aa6c7e06e43e49a7eadee8a7a2b6ade47a36e8f696",
    "gold": {
      "schema": "falsify.coordinated-red-record.v1",
      "changes": [
        {
          "id": "op-1",
          "kind": "uri-link",
          "pageIndex": 0,
          "afterUri": "https://doi.org/10.1000/wrong"
        }
      ]
    },
    "blue": {
      "status": "ok",
      "findings": [
        {
          "id": "f1",
          "verdict": "defect",
          "pageIndex": 0,
          "quote": "https://doi.org/10.1000/wrong"
        }
      ]
    },
    "baseline": null,
    "runs": [
      {
        "runId": "run-1",
        "tp": 1,
        "fn": 0,
        "pureFp": 0,
        "preExistingExempted": 0,
        "abstainedCount": 0,
        "recall": 1.0,
        "precision": 1.0,
        "f1": 1.0,
        "stealthTotal": 0,
        "stealthEvaded": 0,
        "stealthYield": null,
        "missedDefectIds": [],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      }
    ]
  },
  {
    "test": "test_multi_agent_alpha_selective_prediction_and_stealth_evasion",
    "sha256": "5f4efecf3ffd6d9eae4a548228adf5676f9d5de651bc0ac4732e5f49192a96eb",
    "orderSha256": "bd3a0804320632699553c1c31125d4f4d70d7a1048ae9e1d0209e20a368152f5",
    "gold": {
      "schema": "falsify.red-gold-ledger.v1",
      "defects": [
        {
          "defectId": "g-prose",
          "world": "W1",
          "family": "D1",
          "difficulty": "L1",
          "pageIndex": 1,
          "after": "Overall mortality was 14.2% (p = 0.041) in the intervention arm.",
          "stealthPass": false
        },
        {
          "defectId": "g-bbox",
          "world": "W2",
          "family": "D5",
          "difficulty": "L2",
          "pageIndex": 2,
          "bbox": [
            100.0,
            200.0,
            300.0,
            360.0
          ],
          "after": "Kaplan-Meier figure bar height altered.",
          "stealthPass": true
        },
        {
          "defectId": "g-table",
          "world": "W3",
          "family": "D3",
          "difficulty": "L3",
          "pageIndex": 3,
          "itemId": "table-1",
          "after": "Row total 48 disagrees with 21 + 24.",
          "stealthPass": true
        },
        {
          "defectId": "g-supp",
          "world": "W5",
          "family": "D6",
          "difficulty": "L4",
          "supplementName": "Table_S1.csv",
          "after": "Supplemental subgroup N=190 mismatches main N=180.",
          "stealthStatus": "clean"
        }
      ]
    },
    "blue": [
      {
        "runId": "b1",
        "findings": [
          {
            "id": "b1-1",
            "decision": "defect",
            "pageIndex": 1,
            "quote": "mortality was 14.2% (p = 0.041)"
          },
          {
            "id": "b1-2",
            "decision": "defect",
            "pageIndex": 2,
            "bbox": [
              105.0,
              205.0,
              295.0,
              355.0
            ],
            "quote": "fig"
          },
          {
            "id": "b1-3",
            "decision": "확인필요",
            "pageIndex": 3,
            "itemId": "table-1",
            "quote": "possible table sum issue"
          },
          {
            "id": "b1-4",
            "decision": "확인필요",
            "pageIndex": 0,
            "quote": "borderline abstract phrasing"
          }
        ]
      },
      {
        "runId": "b2",
        "findings": [
          {
            "id": "b2-1",
            "decision": "defect",
            "pageIndex": 1,
            "quote": "mortality was 14.2% (p = 0.041)"
          },
          {
            "id": "b2-2",
            "decision": "defect",
            "pageIndex": 2,
            "bbox": [
              105.0,
              205.0,
              295.0,
              355.0
            ],
            "quote": "fig"
          },
          {
            "id": "b2-3",
            "decision": "needs_check",
            "pageIndex": 3,
            "itemId": "table-1",
            "quote": "table check"
          },
          {
            "id": "b2-4",
            "decision": "uncertain",
            "pageIndex": 0,
            "quote": "uncertain sample size phrasing"
          }
        ]
      },
      {
        "runId": "b3",
        "findings": [
          {
            "id": "b3-1",
            "decision": "defect",
            "pageIndex": 1,
            "quote": "mortality was 14.2% (p = 0.041)"
          },
          {
            "id": "b3-2",
            "decision": "needs_check",
            "pageIndex": 2,
            "bbox": [
              105.0,
              205.0,
              295.0,
              355.0
            ],
            "quote": "fig"
          },
          {
            "id": "b3-3",
            "decision": "defect",
            "pageIndex": 5,
            "quote": "completely fabricated hallucination"
          },
          {
            "id": "b3-4",
            "decision": "defect",
            "pageIndex": 4,
            "excerpt": "Reference 12 DOI 10.1000/preexisting-error disagrees with link."
          }
        ]
      }
    ],
    "baseline": {
      "schema": "falsify.blue-defect-sensor.v1",
      "signals": [
        {
          "id": "sens-1",
          "family": "D2",
          "pageIndex": 4,
          "excerpt": "Reference 12 DOI 10.1000/preexisting-error disagrees with link."
        }
      ]
    },
    "runs": [
      {
        "runId": "b1",
        "tp": 2,
        "fn": 2,
        "pureFp": 0,
        "preExistingExempted": 0,
        "abstainedCount": 2,
        "recall": 0.5,
        "precision": 1.0,
        "f1": 0.6667,
        "stealthTotal": 3,
        "stealthEvaded": 2,
        "stealthYield": 0.6667,
        "missedDefectIds": [
          "g-table",
          "g-supp"
        ],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      },
      {
        "runId": "b2",
        "tp": 2,
        "fn": 2,
        "pureFp": 0,
        "preExistingExempted": 0,
        "abstainedCount": 2,
        "recall": 0.5,
        "precision": 1.0,
        "f1": 0.6667,
        "stealthTotal": 3,
        "stealthEvaded": 2,
        "stealthYield": 0.6667,
        "missedDefectIds": [
          "g-table",
          "g-supp"
        ],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      },
      {
        "runId": "b3",
        "tp": 1,
        "fn": 3,
        "pureFp": 1,
        "preExistingExempted": 1,
        "abstainedCount": 1,
        "recall": 0.25,
        "precision": 0.5,
        "f1": 0.3333,
        "stealthTotal": 3,
        "stealthEvaded": 3,
        "stealthYield": 1.0,
        "missedDefectIds": [
          "g-bbox",
          "g-table",
          "g-supp"
        ],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [
          "b3-4"
        ],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      }
    ]
  },
  {
    "test": "test_baseline_signals_without_changed_tokens_keep_exemption",
    "sha256": "1ae43052b4a0d1cb8d53144081560b6764d7432ec85cf98e554f0fbb12696f6d",
    "orderSha256": "510a9bf953c6ec518e6291363545b33f1beafa489664fabac3d340c3ad7384fc",
    "gold": {
      "schema": "falsify.red-gold-ledger.v1",
      "defects": [
        {
          "defectId": "g-other",
          "world": "W1",
          "family": "D1",
          "difficulty": "L1",
          "pageIndex": 1,
          "before": "the subgroup total read 24 percent",
          "after": "the subgroup total read 42 percent"
        }
      ]
    },
    "blue": [
      {
        "runId": "changed-token-blue",
        "findings": [
          {
            "id": "f-base",
            "decision": "defect",
            "pageIndex": 5,
            "excerpt": "reference 4 citation style differs from the journal template",
            "rationale": "pre-existing style drift, not a RED edit"
          }
        ]
      }
    ],
    "baseline": {
      "schema": "falsify.blue-defect-sensor.v1",
      "signals": [
        {
          "id": "sens-keep",
          "family": "D2",
          "pageIndex": 5,
          "excerpt": "reference 4 citation style differs from the journal template"
        }
      ]
    },
    "runs": [
      {
        "runId": "changed-token-blue",
        "tp": 0,
        "fn": 1,
        "pureFp": 0,
        "preExistingExempted": 1,
        "abstainedCount": 0,
        "recall": 0.0,
        "precision": null,
        "f1": null,
        "stealthTotal": 0,
        "stealthEvaded": 0,
        "stealthYield": null,
        "missedDefectIds": [
          "g-other"
        ],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [
          "f-base"
        ],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      }
    ]
  },
  {
    "test": "test_cross_page_contradiction_matches_with_rationale_overlap",
    "sha256": "ec1d4cb7af7a9cdeabcbe675626ae3a7afcede16b13cece3e83afd0e6b50983e",
    "orderSha256": "d680845f05195b4f03ba5311ade89f8d3ef2ef81d488e54a43a2fb6e55dfed8d",
    "gold": {
      "schema": "falsify.red-gold-ledger.v1",
      "defects": [
        {
          "defectId": "g-cross",
          "world": "W1",
          "family": "D1",
          "difficulty": "L3",
          "pageIndex": 2,
          "before": "the assay held 0.30 units",
          "after": "the assay held 0.90 units",
          "rationale": "Section 3 contrasts the abstract value 0.30 with the section value 0.90 for the identical sample set."
        }
      ]
    },
    "blue": [
      {
        "runId": "changed-token-blue",
        "findings": [
          {
            "id": "f-cross",
            "decision": "defect",
            "pageIndex": 0,
            "quote": "abstract reports 0.30 units",
            "rationale": "the abstract states 0.30 but the section states 0.90 for the same sample set"
          }
        ]
      }
    ],
    "baseline": null,
    "runs": [
      {
        "runId": "changed-token-blue",
        "tp": 1,
        "fn": 0,
        "pureFp": 0,
        "preExistingExempted": 0,
        "abstainedCount": 0,
        "recall": 1.0,
        "precision": 1.0,
        "f1": 1.0,
        "stealthTotal": 0,
        "stealthEvaded": 0,
        "stealthYield": null,
        "missedDefectIds": [],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      }
    ]
  },
  {
    "test": "test_cross_page_numeric_overlap_without_rationale_overlap_stays_unmatched",
    "sha256": "4b404760340297b1c471eee5797dc3d89a7fb7ff900704f6a9a94dd788c97445",
    "orderSha256": "0380ba7632924a98b1c82dee9a0b693024a6a73ebc9bb3eea61f35db4d8326fd",
    "gold": {
      "schema": "falsify.red-gold-ledger.v1",
      "defects": [
        {
          "defectId": "g-chance",
          "world": "W5",
          "family": "D5",
          "difficulty": "L3",
          "pageIndex": 6,
          "before": "the cluster score read 0.30",
          "after": "the cluster score read 0.90",
          "rationale": "Discussion restates the retention rate for the collapsed model."
        }
      ]
    },
    "blue": [
      {
        "runId": "changed-token-blue",
        "findings": [
          {
            "id": "f-chance",
            "decision": "defect",
            "pageIndex": 9,
            "quote": "grid values 0.30 and 0.90",
            "rationale": "Table 4 caption lists the axis tick labels."
          }
        ]
      }
    ],
    "baseline": null,
    "runs": [
      {
        "runId": "changed-token-blue",
        "tp": 0,
        "fn": 1,
        "pureFp": 1,
        "preExistingExempted": 0,
        "abstainedCount": 0,
        "recall": 0.0,
        "precision": 0.0,
        "f1": 0.0,
        "stealthTotal": 0,
        "stealthEvaded": 0,
        "stealthYield": null,
        "missedDefectIds": [
          "g-chance"
        ],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      }
    ]
  },
  {
    "test": "test_same_page_without_the_changed_value_stays_unmatched",
    "sha256": "374212b0aeaad0453e6cb14877ea74c967e10ed9b55a0089758241f6eb0db005",
    "orderSha256": "7819e65adcf258245821a9265c1f559e3093d604d960e441f1a4d005bf82250c",
    "gold": {
      "schema": "falsify.red-gold-ledger.v1",
      "defects": [
        {
          "defectId": "g-quiet",
          "world": "W1",
          "family": "D1",
          "difficulty": "L2",
          "pageIndex": 2,
          "before": "the mean settled at 0.45 units",
          "after": "the mean settled at 0.55 units",
          "rationale": "The reported mean moved from 0.45 to 0.55."
        }
      ]
    },
    "blue": [
      {
        "runId": "changed-token-blue",
        "findings": [
          {
            "id": "f-quiet",
            "decision": "defect",
            "pageIndex": 2,
            "quote": "the mean is summarised in Table 5",
            "rationale": "Table 5 caption wording is inconsistent with the column order."
          }
        ]
      }
    ],
    "baseline": null,
    "runs": [
      {
        "runId": "changed-token-blue",
        "tp": 0,
        "fn": 1,
        "pureFp": 1,
        "preExistingExempted": 0,
        "abstainedCount": 0,
        "recall": 0.0,
        "precision": 0.0,
        "f1": 0.0,
        "stealthTotal": 0,
        "stealthEvaded": 0,
        "stealthYield": null,
        "missedDefectIds": [
          "g-quiet"
        ],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      }
    ]
  },
  {
    "test": "test_short_changed_value_cited_only_in_rationale_matches",
    "sha256": "abd87d65eb6323fa6e664d0af414d025488d19ce2997430b6d7dcbb04c366aa3",
    "orderSha256": "f05f8c80be51e8bbe96a2bbff3ed1c82ee70007284bc88eb7829322b188e4b56",
    "gold": {
      "schema": "falsify.red-gold-ledger.v1",
      "defects": [
        {
          "defectId": "g-short",
          "world": "W1",
          "family": "D1",
          "difficulty": "L2",
          "pageIndex": 0,
          "before": "the retention coefficient was 0.11 for the cohort",
          "after": "the retention coefficient was 0.44 for the cohort",
          "rationale": "Section 2 prints a retention coefficient of 0.44 for the cohort that Section 1 measured as 0.11."
        }
      ]
    },
    "blue": [
      {
        "runId": "changed-token-blue",
        "findings": [
          {
            "id": "f-short",
            "decision": "defect",
            "pageIndex": 0,
            "quote": "reported effect size in the second table",
            "rationale": "the value 0.44 differs from 0.11 in the first table"
          }
        ]
      }
    ],
    "baseline": null,
    "runs": [
      {
        "runId": "changed-token-blue",
        "tp": 1,
        "fn": 0,
        "pureFp": 0,
        "preExistingExempted": 0,
        "abstainedCount": 0,
        "recall": 1.0,
        "precision": 1.0,
        "f1": 1.0,
        "stealthTotal": 0,
        "stealthEvaded": 0,
        "stealthYield": null,
        "missedDefectIds": [],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      }
    ]
  },
  {
    "test": "test_split_observation_of_matched_gold_is_not_a_pure_false_positive",
    "sha256": "5a330d2ab7536f950f85e5bfb376851c85e0745e6f05f6d503deba3ec875fee9",
    "orderSha256": "7a1459816be2352fc93207b43ff184267e8d04bf93ea147db2278c1b67fec272",
    "gold": {
      "schema": "falsify.red-gold-ledger.v1",
      "defects": [
        {
          "defectId": "g-split",
          "world": "W3",
          "family": "D6",
          "difficulty": "L2",
          "pageIndex": 1,
          "before": "offset = 1.0\nscale = 5.0",
          "after": "offset = 3.0\nscale = 7.0",
          "rationale": "Both constants in the snippet were rewritten."
        }
      ]
    },
    "blue": [
      {
        "runId": "changed-token-blue",
        "findings": [
          {
            "id": "f-first",
            "decision": "defect",
            "pageIndex": 1,
            "quote": "offset = 3.0"
          },
          {
            "id": "f-second",
            "decision": "defect",
            "pageIndex": 1,
            "quote": "scale = 7.0"
          }
        ]
      }
    ],
    "baseline": null,
    "runs": [
      {
        "runId": "changed-token-blue",
        "tp": 1,
        "fn": 0,
        "pureFp": 0,
        "preExistingExempted": 0,
        "abstainedCount": 0,
        "recall": 1.0,
        "precision": 1.0,
        "f1": 1.0,
        "stealthTotal": 0,
        "stealthEvaded": 0,
        "stealthYield": null,
        "missedDefectIds": [],
        "splitOfMatchedCount": 1,
        "splitOfMatchedFindingIds": [
          "f-second"
        ],
        "exemptedFindingIds": [],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      }
    ]
  },
  {
    "test": "test_uri_link_gold_matches_visible_identifier_citation",
    "sha256": "ad8d4a852c438f74e02642f2adca18829a99153a3f86884df4a902d3d2a5a63e",
    "orderSha256": "4666dd393dc08399673b8a3ccc7d5664423cf609eca1acc0a67f07b89cc73822",
    "gold": {
      "schema": "falsify.red-gold-ledger.v1",
      "defects": [
        {
          "defectId": "g-link",
          "kind": "uri-link",
          "world": "W2",
          "family": "D2",
          "difficulty": "L2",
          "pageIndex": 4,
          "beforeUri": "https://doi.org/10.7777/alpha000",
          "afterUri": "https://doi.org/10.7777/zeta999",
          "rationale": "Reference 9 prints 10.7777/alpha000 while its embedded link targets 10.7777/zeta999."
        }
      ]
    },
    "blue": [
      {
        "runId": "changed-token-blue",
        "findings": [
          {
            "id": "f-link",
            "decision": "defect",
            "pageIndex": 4,
            "quote": "10.7777/alpha000",
            "rationale": "the embedded target is 10.7777/zeta999 for that reference"
          }
        ]
      }
    ],
    "baseline": null,
    "runs": [
      {
        "runId": "changed-token-blue",
        "tp": 1,
        "fn": 0,
        "pureFp": 0,
        "preExistingExempted": 0,
        "abstainedCount": 0,
        "recall": 1.0,
        "precision": 1.0,
        "f1": 1.0,
        "stealthTotal": 0,
        "stealthEvaded": 0,
        "stealthYield": null,
        "missedDefectIds": [],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      }
    ]
  },
  {
    "test": "test_wrapped_two_line_gold_is_coupled_to_the_matching_finding",
    "sha256": "1bed852d7d948845a46cfe16facd4c0077c71553c29a0fa20f0b3ce648f868a9",
    "orderSha256": "26c9df25700dc44188534b52ddceea075055800ab5efe52de334fc281297ffda",
    "gold": {
      "schema": "falsify.red-gold-ledger.v1",
      "defects": [
        {
          "defectId": "g-line-a",
          "world": "W5",
          "family": "D3",
          "difficulty": "L4",
          "pageIndex": 8,
          "bbox": [
            100.0,
            400.0,
            160.0,
            410.0
          ],
          "before": "as nominal",
          "after": "as scaled",
          "rationale": "Section 5 says affinities should be read as scaled rather than bounded values."
        },
        {
          "defectId": "g-line-b",
          "world": "W5",
          "family": "D3",
          "difficulty": "L4",
          "pageIndex": 8,
          "bbox": [
            60.0,
            412.0,
            120.0,
            422.0
          ],
          "before": "than fixed",
          "after": "than bounded",
          "rationale": "Second half of the same two-line rewrite."
        }
      ]
    },
    "blue": [
      {
        "runId": "changed-token-blue",
        "findings": [
          {
            "id": "f-line",
            "decision": "defect",
            "pageIndex": 8,
            "quote": "considered as scaled rather than bounded",
            "rationale": "the sentence now reads as scaled and than bounded, so the earlier as nominal / than fixed wording was inverted"
          }
        ]
      }
    ],
    "baseline": null,
    "runs": [
      {
        "runId": "changed-token-blue",
        "tp": 2,
        "fn": 0,
        "pureFp": 0,
        "preExistingExempted": 0,
        "abstainedCount": 0,
        "recall": 1.0,
        "precision": 1.0,
        "f1": 1.0,
        "stealthTotal": 0,
        "stealthEvaded": 0,
        "stealthYield": null,
        "missedDefectIds": [],
        "splitOfMatchedCount": 0,
        "splitOfMatchedFindingIds": [],
        "exemptedFindingIds": [],
        "byFamilyKeys": [
          "D1",
          "D2",
          "D3",
          "D4",
          "D5",
          "D6",
          "D7"
        ]
      }
    ]
  }
]
''')
