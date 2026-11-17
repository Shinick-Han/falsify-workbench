"""Offline unit tests for paper_external_grounding and paper_clinical_trials."""
import hashlib
import json
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_clinical_trials as pct
import paper_external_grounding as peg


def no_network(*args, **kwargs):
    raise AssertionError('unexpected_real_network_call')


def sha_json(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode('utf-8')).hexdigest()


class ReferenceParsingTests(unittest.TestCase):
    def test_parse_numbered_dict_and_string_entries(self):
        entry = {
            'index': 4,
            'rawText': '[4] Smith J, Doe A. Effects of aspirin on cardiovascular mortality. Lancet. 2021; doi:10.1016/S0140-6736(21)0001-2 PMID: 33445566 PMCID: PMC8123456',
            'doi': '10.1016/S0140-6736(21)0001-2',
            'year': 2021,
        }
        parsed = peg.parse_reference_entry(entry)
        self.assertEqual(parsed['index'], 4)
        self.assertEqual(parsed['doi'], '10.1016/S0140-6736(21)0001-2')
        self.assertEqual(parsed['pmid'], '33445566')
        self.assertEqual(parsed['pmcid'], 'PMC8123456')
        self.assertEqual(parsed['year'], 2021)
        self.assertEqual(parsed['firstAuthorSurname'], 'Smith')
        self.assertIn('Effects of aspirin on cardiovascular mortality', parsed['titleCandidate'])

        raw_ay = 'Kim, S.-H. (2022). Deep learning triage in emergency care. BMJ Open 12:e050123. https://doi.org/10.1136/bmjopen-2022-050123'
        parsed_ay = peg.parse_reference_entry(raw_ay)
        self.assertIsNone(parsed_ay['index'])
        self.assertEqual(parsed_ay['doi'], '10.1136/bmjopen-2022-050123')
        self.assertEqual(parsed_ay['year'], 2022)
        self.assertEqual(parsed_ay['firstAuthorSurname'], 'Kim')
        self.assertIn('Deep learning triage in emergency care', parsed_ay['titleCandidate'])


class BibliographyVerificationTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, 'create_connection', side_effect=no_network)
        self._net.start()

    def tearDown(self):
        self._net.stop()

    def test_verify_doi_match_404_and_chimera_mismatch(self):
        refs = [
            '[1] Smith J. Effects of aspirin on cardiovascular mortality. Lancet. 2021; doi:10.1000/valid1',
            '[2] Doe A. Fabricated study on unicorns. Nature. 2024; doi:10.1000/missing404',
            '[3] Lee K. Novel immunotherapy for pancreatic cancer. Science. 2023; doi:10.1000/chimera1',
        ]

        def mock_transport(provider, path):
            if provider == 'crossref' and '10.1000%2Fvalid1' in path:
                data = {'message': {
                    'DOI': '10.1000/valid1',
                    'title': ['Effects of aspirin on cardiovascular mortality'],
                    'author': [{'given': 'John', 'family': 'Smith'}],
                    'published': {'date-parts': [[2021]]},
                }}
                return 200, data, sha_json(data)
            if provider == 'crossref' and '10.1000%2Fmissing404' in path:
                return 404, None, hashlib.sha256(b'Resource not found.').hexdigest()
            if provider == 'crossref' and '10.1000%2Fchimera1' in path:
                data = {'message': {
                    'DOI': '10.1000/chimera1',
                    'title': ['Soil microbiome diversity in boreal forests'],
                    'author': [{'given': 'Maria', 'family': 'Gonzalez'}],
                    'published': {'date-parts': [[2016]]},
                }}
                return 200, data, sha_json(data)
            if provider == 'europepmc':
                empty = {'resultList': {'result': []}}
                return 200, empty, sha_json(empty)
            raise AssertionError((provider, path))

        out = peg.verify_bibliography(refs, max_refs=25, transport=mock_transport)
        self.assertEqual(out['status'], 'completed')
        self.assertEqual(out['checkedCount'], 3)
        statuses = [r['status'] for r in out['results']]
        self.assertEqual(statuses, ['verified_match', 'doi_not_found_in_crossref', 'metadata_mismatch'])
        for rec in out['results']:
            self.assertIn('responseSha256', rec)
            self.assertIn('retrievedAt', rec)
            self.assertIn('provider', rec)
            self.assertIn('scope', rec)
        self.assertIn('404', out['results'][1]['scope'])
        self.assertLess(out['results'][2]['mismatchDetails']['titleOverlap'], 0.25)

    def test_verify_without_doi_match_and_missing_caveat(self):
        refs = [
            '[1] Patel R. Randomized trial of telemonitoring in heart failure. Circulation. 2022.',
            '[2] Unknown Z. Completely unindexed unpublished workshop handout. 2019.',
        ]

        def mock_transport(provider, path):
            if provider == 'europepmc' and 'telemonitoring' in path.lower():
                data = {'resultList': {'result': [{
                    'doi': '10.1161/CIRC.2022.100',
                    'title': 'Randomized trial of telemonitoring in heart failure',
                    'authorString': 'Patel R, Kumar S',
                    'pubYear': '2022',
                    'abstractText': 'Telemonitoring reduced readmissions by 22% (p < 0.01).',
                }]}}
                return 200, data, sha_json(data)
            empty = {'message': {'items': []}} if provider == 'crossref' else {'resultList': {'result': []}}
            return 200, empty, sha_json(empty)

        out = peg.verify_bibliography(refs, max_refs=25, transport=mock_transport)
        self.assertEqual(out['results'][0]['status'], 'verified_by_metadata')
        self.assertEqual(out['results'][1]['status'], 'unverified_no_match')
        self.assertIn('Missing search match is not proof of fabrication', out['results'][1]['scope'])

    def test_max_refs_bounds(self):
        with self.assertRaises(ValueError):
            peg.verify_bibliography([], max_refs=0)
        with self.assertRaises(ValueError):
            peg.verify_bibliography([], max_refs=51)

    def test_chimera_mismatch_via_year_diff_even_when_surname_collides(self):
        refs = ['[1] Smith J. Quantum baking recipes in space. Science. 2024; doi:10.1000/yeargap']

        def mock_transport(provider, path):
            if provider == 'crossref':
                data = {'message': {
                    'DOI': '10.1000/yeargap',
                    'title': ['Marine ecology of coral reefs'],
                    'author': [{'given': 'Jane', 'family': 'Smith'}],
                    'published': {'date-parts': [[2019]]},
                }}
                return 200, data, sha_json(data)
            return 200, {'resultList': {'result': []}}, sha_json({})

        out = peg.verify_bibliography(refs, transport=mock_transport)
        self.assertEqual(out['results'][0]['status'], 'metadata_mismatch')
        self.assertEqual(out['results'][0]['mismatchDetails']['yearDiff'], 5)


class ClaimGroundingTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, 'create_connection', side_effect=no_network)
        self._net.start()

    def tearDown(self):
        self._net.stop()

    def test_ground_cited_claims_prioritization_and_abstract_truncation(self):
        long_abstract = 'A' * 3600
        segments = [
            {'id': 's1', 'text': 'Several background studies exist [1].'},
            {'id': 's2', 'text': 'Treatment significantly decreased 30-day mortality by 35% (HR 0.65, p < 0.001) [1, 2].'},
            {'id': 's3', 'text': '선행 연구와 대조적으로 (Smith et al., 2020) 유병률이 18% 유의하게 증가하였다.'},
        ]
        refs = [
            '[1] Jones B. Background study. BMJ. 2019; doi:10.1000/j1',
            '[2] Smith A. Mortality trial in sepsis. NEJM. 2020; doi:10.1000/s2',
        ]

        def mock_transport(provider, path):
            if provider == 'europepmc' and '10.1000' in path:
                doi = '10.1000/s2' if 's2' in path else '10.1000/j1'
                title = 'Mortality trial in sepsis' if 's2' in path else 'Background study'
                author = 'Smith A' if 's2' in path else 'Jones B'
                year = '2020' if 's2' in path else '2019'
                data = {'resultList': {'result': [{
                    'doi': doi, 'title': title, 'authorString': author,
                    'pubYear': year, 'abstractText': long_abstract if 's2' in path else 'Short background.',
                }]}}
                return 200, data, sha_json(data)
            if provider == 'crossref':
                return 404, None, hashlib.sha256(b'not found').hexdigest()
            raise AssertionError((provider, path))

        out = peg.ground_cited_claims(segments, refs, max_claims=3, transport=mock_transport)
        self.assertEqual(out['status'], 'completed')
        self.assertEqual(len(out['claimGroundings']), 3)
        # Quantitative/causal claims in s2/s3 should rank ahead of generic background in s1.
        self.assertIn(out['claimGroundings'][0]['segmentId'], ('s2', 's3'))
        self.assertEqual(out['claimGroundings'][-1]['segmentId'], 's1')
        s2_smith = next(g for g in out['claimGroundings'] if g['refIndex'] == 2)
        rec = s2_smith['retrievedRecord']
        self.assertEqual(len(rec['abstract']), 3500)
        self.assertTrue(rec['abstractTruncated'])
        self.assertTrue(rec['textSha256'])
        self.assertTrue(rec['responseSha256'])

    def test_ground_cited_claims_expands_bracket_ranges(self):
        refs = [
            '[3] Alpha A. Trial three. JAMA. 2020; doi:10.1000/r3',
            '[4] Beta B. Trial four. JAMA. 2021; doi:10.1000/r4',
            '[5] Gamma C. Trial five. JAMA. 2022; doi:10.1000/r5',
        ]
        text = 'Prior trials showed significant mortality reduction [3-5].'

        def mock_transport(provider, path):
            if provider == 'europepmc':
                return 200, {'resultList': {'result': [{'doi': '10.1000/r3', 'title': 'Trial', 'authorString': 'Alpha A', 'pubYear': '2020', 'abstractText': 'Reduced mortality.'}]}}, sha_json({'ok': 1})
            return 404, None, hashlib.sha256(b'404').hexdigest()

        out = peg.ground_cited_claims(text, refs, max_claims=12, transport=mock_transport)
        self.assertEqual([g['refIndex'] for g in out['claimGroundings']], [3, 4, 5])


class ClinicalTrialsTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, 'create_connection', side_effect=no_network)
        self._net.start()

    def tearDown(self):
        self._net.stop()

    def test_extract_trial_ids_bounded_and_normalized(self):
        ids = [f'nct{10000000 + i}' for i in range(12)]
        text = ' '.join(ids) + ' NCT10000000 NCT123456789 (not 9 digits)'
        extracted = pct.extract_trial_ids(text)
        self.assertEqual(len(extracted), 10)
        self.assertEqual(extracted[0], 'NCT10000000')
        self.assertEqual(extracted[-1], 'NCT10000009')

    def test_fetch_and_compare_outcome_switch_and_enrollment(self):
        study = {
            'protocolSection': {
                'identificationModule': {'nctId': 'NCT04567890', 'briefTitle': 'Cardio Drug Trial', 'officialTitle': 'Official'},
                'statusModule': {
                    'overallStatus': 'COMPLETED',
                    'studyFirstPostDateStruct': {'date': '2020-05-01'},
                    'primaryCompletionDateStruct': {'date': '2022-08-15'},
                },
                'designModule': {'studyType': 'INTERVENTIONAL', 'enrollmentInfo': {'count': 500, 'type': 'ACTUAL'}},
                'outcomesModule': {
                    'primaryOutcomes': [{'measure': 'Composite cardiovascular death or myocardial infarction', 'timeFrame': '24 months', 'description': 'MACE'}],
                    'secondaryOutcomes': [{'measure': 'Change in systolic blood pressure from baseline', 'timeFrame': '12 weeks'}],
                },
            }
        }
        rec = pct.fetch_trial_record('nct04567890', transport=lambda nid: (200, study, sha_json(study)))
        self.assertEqual(rec['nctId'], 'NCT04567890')
        self.assertEqual(rec['enrollment'], {'count': 500, 'type': 'ACTUAL'})
        self.assertEqual(len(rec['primaryOutcomes']), 1)

        paper = (
            'A total of 250 patients were enrolled in NCT04567890 (125 per arm). '
            'The primary outcome was change in systolic blood pressure from baseline at 12 weeks.'
        )
        comp = pct.compare_paper_with_registry(paper, [rec])
        item = comp['registryComparisons'][0]
        self.assertIn('potential_outcome_switch', item['flags'])
        self.assertIn('enrollment_discrepancy_candidate', item['flags'])
        self.assertEqual(item['note'], pct.COMPARISON_FRAMING)

    def test_fetch_trial_404_and_invalid_id(self):
        rec_404 = pct.fetch_trial_record('NCT99999999', transport=lambda nid: (404, None, hashlib.sha256(b'404').hexdigest()))
        self.assertEqual(rec_404['status'], 'not_found')
        with self.assertRaises(ValueError):
            pct.fetch_trial_record('NCT123')


class CorroborationAndChronologyTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, 'create_connection', side_effect=no_network)
        self._net.start()

    def tearDown(self):
        self._net.stop()

    def test_title_ratio_boundaries_and_short_title_bypass(self):
        candidate = 'a' * 50
        at_70 = 'a' * 20 + 'b' * 30
        at_71 = 'a' * 21 + 'b' * 29
        self.assertEqual(peg._levenshtein_ratio(candidate, at_70), 70)
        self.assertEqual(peg._levenshtein_ratio(candidate, at_71), 71)
        self.assertEqual(peg._titles_match(candidate, at_70), (False, 70))
        self.assertEqual(peg._titles_match(candidate, at_71), (True, 71))

        tail = ' zz' * 40
        short_match, short_ratio = peg._titles_match('aa bb cc', 'aa bb cc' + tail)
        self.assertLessEqual(short_ratio, 70)
        self.assertTrue(short_match)
        long_match, long_ratio = peg._titles_match('aa bb cc dd', 'aa bb cc dd' + tail)
        self.assertLessEqual(long_ratio, 70)
        self.assertFalse(long_match)

    def test_openalex_request_validation_refuses_other_paths_and_hosts(self):
        self.assertIn('openalex', peg.PROVIDERS)
        self.assertEqual(peg.HOSTS['openalex'], 'api.openalex.org')
        self.assertEqual(
            peg._validate_request('openalex', '/works/https://doi.org/10.1000/abc'),
            'api.openalex.org',
        )
        self.assertEqual(
            peg._validate_request('openalex', '/works?search=heart+failure&per-page=3'),
            'api.openalex.org',
        )
        self.assertEqual(peg._validate_request('crossref', '/works/10.1000%2Fabc'), 'api.crossref.org')
        refused = (
            '/authors/A1',
            '/works/W123',
            '/works?search=heart&per-page=5',
            '/works?search=heart&per-page=3&mailto=a@b.c',
            '/works?filter=title.search:heart',
            '/works/https://example.org/10.1000/abc',
            '/works?search=heart&per-page=3&api_key=secret',
        )
        for path in refused:
            with self.assertRaisesRegex(ValueError, 'invalid_api_path'):
                peg._validate_request('openalex', path)
        with self.assertRaisesRegex(ValueError, 'unknown_provider'):
            peg._validate_request('api.openalex.org', '/works?search=heart&per-page=3')

    def test_high_tier_skips_openalex_and_adds_no_chronology_key(self):
        ref = '[1] Smith J. Effects of aspirin on cardiovascular mortality. Lancet. 2021; doi:10.1000/agree1'
        calls = []

        def transport(provider, path):
            calls.append((provider, path))
            if provider == 'openalex':
                raise AssertionError(path)
            if provider == 'crossref':
                return _crossref_doi('10.1000/agree1', 'Effects of aspirin on cardiovascular mortality', 'Smith', 2021)
            if provider == 'europepmc':
                return _epmc_hit('10.1000/agree1', 'Effects of aspirin on cardiovascular mortality', 'Smith J', '2021')
            raise AssertionError((provider, path))

        out = peg.verify_bibliography([ref], transport=transport)
        item = out['results'][0]
        self.assertEqual(item['status'], 'verified_match')
        self.assertEqual(item['corroboration']['tier'], 'high')
        self.assertEqual(item['corroboration']['indices'], {
            'crossref': 'match', 'europepmc': 'match', 'openalex': 'skipped',
        })
        self.assertIsInstance(item['corroboration']['titleRatio'], int)
        self.assertGreater(item['corroboration']['titleRatio'], 70)
        self.assertNotIn('triageHints', out)
        self.assertNotIn('triageHints', item)
        self.assertNotIn('_chronology', item)
        self.assertNotIn('publicationDate', item['retrievedRecord'])
        self.assertFalse(any(provider == 'openalex' for provider, _path in calls))
        self.assertEqual(out['summary']['openAlexCalls'], 0)
        self.assertEqual(out['summary']['corroborationHigh'], 1)
        allowed = {
            'index', 'rawText', 'parsed', 'requests', 'provider', 'responseSha256', 'retrievedAt',
            'status', 'retrievedRecord', 'matchDetails', 'scope', 'retracted', 'retractionType',
            'corroboration',
        }
        self.assertEqual(set(item), allowed)
        self.assertNotIn('triageHints', set(out) - {'status', 'checkedCount', 'truncated', 'summary', 'results', 'limitations'})

    def test_medium_conflict_and_low_tiers(self):
        refs = [
            '[1] Smith J. Effects of aspirin on cardiovascular mortality. Lancet. 2021; doi:10.1000/yeargap2',
            '[2] Lee K. Novel immunotherapy for pancreatic cancer. Science. 2023; doi:10.1000/chimera1',
            '[3] Unknown Z. Completely unindexed unpublished workshop handout. 2019.',
            '[4] Doe A. Fabricated study on unicorns. Nature. 2024; doi:10.1000/missing404',
        ]
        calls = []

        def transport(provider, path):
            calls.append((provider, path))
            if provider == 'crossref' and 'yeargap2' in path:
                return _crossref_doi('10.1000/yeargap2', 'Effects of aspirin on cardiovascular mortality', 'Smith', 2018)
            if provider == 'europepmc' and 'yeargap2' in path:
                return _epmc_hit('10.1000/yeargap2', 'Effects of aspirin on cardiovascular mortality', 'Smith J', '2018')
            if provider == 'crossref' and 'chimera1' in path:
                return _crossref_doi('10.1000/chimera1', 'Soil microbiome diversity in boreal forests', 'Gonzalez', 2016)
            if provider == 'crossref' and 'missing404' in path:
                return 404, None, hashlib.sha256(b'404').hexdigest()
            if provider == 'openalex' and ('chimera1' in path or 'missing404' in path):
                empty = {'results': []}
                return 200, empty, sha_json(empty)
            if provider == 'openalex' and 'search=' in path:
                self.assertTrue(path.endswith('&per-page=3'))
                self.assertNotIn('mailto', path)
                empty = {'results': []}
                return 200, empty, sha_json(empty)
            if provider == 'crossref':
                empty = {'message': {'items': []}}
                return 200, empty, sha_json(empty)
            empty = {'resultList': {'result': []}}
            return 200, empty, sha_json(empty)

        out = peg.verify_bibliography(refs, transport=transport)
        medium, conflict, low, doi_low = out['results']
        self.assertEqual(medium['status'], 'verified_match')
        self.assertEqual(medium['corroboration']['tier'], 'medium')
        self.assertEqual(medium['corroboration']['indices']['openalex'], 'skipped')
        self.assertEqual(conflict['status'], 'metadata_mismatch')
        self.assertEqual(conflict['corroboration']['tier'], 'conflict')
        self.assertEqual(conflict['corroboration']['indices']['crossref'], 'conflict')
        self.assertEqual(conflict['corroboration']['indices']['openalex'], 'miss')
        self.assertNotIn('fabricat', conflict['corroboration']['tier'])
        self.assertEqual(low['status'], 'unverified_no_match')
        self.assertEqual(low['corroboration']['tier'], 'low')
        self.assertEqual(low['corroboration']['indices']['openalex'], 'miss')
        self.assertIn(peg.MISSING_MATCH_NOTE, low['scope'])
        self.assertNotIn('phantom', json.dumps(low['corroboration']))
        self.assertEqual(doi_low['status'], 'doi_not_found_in_crossref')
        self.assertEqual(doi_low['corroboration']['tier'], 'low')
        self.assertIn('404', doi_low['scope'])
        self.assertIn(peg.MISSING_MATCH_NOTE, doi_low['scope'])
        self.assertEqual(out['summary']['corroborationMedium'], 1)
        self.assertEqual(out['summary']['corroborationConflict'], 1)
        self.assertEqual(out['summary']['corroborationLow'], 2)
        self.assertEqual(out['summary']['openAlexCalls'], 3)
        self.assertLessEqual(out['summary']['openAlexCalls'], out['checkedCount'])
        self.assertTrue(any(provider == 'openalex' and 'chimera1' in path for provider, path in calls))
        self.assertFalse(any(provider == 'openalex' and 'yeargap2' in path for provider, path in calls))

    def test_openalex_queried_on_miss_and_disagreement_and_counted(self):
        refs = [
            '[1] Smith J. Effects of aspirin on cardiovascular mortality. Lancet. 2021; doi:10.1000/miss1',
            '[2] Smith J. Effects of aspirin on cardiovascular mortality. Lancet. 2021; doi:10.1000/split1',
        ]
        calls = []

        def transport(provider, path):
            calls.append((provider, path))
            if provider == 'crossref' and 'miss1' in path:
                return 404, None, hashlib.sha256(b'404').hexdigest()
            if provider == 'europepmc' and 'miss1' in path:
                empty = {'resultList': {'result': []}}
                return 200, empty, sha_json(empty)
            if provider == 'openalex' and 'miss1' in path:
                self.assertIn('/works/https://doi.org/10.1000/miss1', path)
                work = _openalex_work(
                    '10.1000/miss1', 'Effects of aspirin on cardiovascular mortality', 'John Smith', 2021, '2021-04-01',
                )
                return 200, work, sha_json(work)
            if provider == 'crossref' and 'split1' in path:
                return _crossref_doi('10.1000/split1', 'Effects of aspirin on cardiovascular mortality', 'Smith', 2021)
            if provider == 'europepmc' and 'split1' in path:
                return _epmc_hit('10.9999/other', 'Effects of aspirin on cardiovascular mortality', 'Smith J', '2021')
            if provider == 'openalex' and 'split1' in path:
                empty = {'results': []}
                return 200, empty, sha_json(empty)
            raise AssertionError((provider, path))

        out = peg.verify_bibliography(refs, max_refs=25, transport=transport)
        missed, split = out['results']
        self.assertEqual(missed['status'], 'doi_not_found_in_crossref')
        self.assertEqual(missed['corroboration']['tier'], 'high')
        self.assertEqual(missed['corroboration']['indices'], {
            'crossref': 'miss', 'europepmc': 'miss', 'openalex': 'match',
        })
        self.assertEqual(split['corroboration']['indices']['crossref'], 'match')
        self.assertEqual(split['corroboration']['indices']['europepmc'], 'match')
        self.assertEqual(split['corroboration']['indices']['openalex'], 'miss')
        self.assertEqual(out['summary']['openAlexCalls'], 2)
        self.assertLessEqual(out['summary']['openAlexCalls'], 25)
        self.assertEqual(sum(1 for provider, _path in calls if provider == 'openalex'), 2)

    def test_chronology_precision_bases_and_invalid_date(self):
        agreeing = '[1] Smith J. Effects of aspirin on cardiovascular mortality. Lancet. 2021; doi:10.1000/time1'
        printed_only = '[2] Smith J. Effects of aspirin on cardiovascular mortality. Lancet. 2022.'

        def transport(provider, path):
            if provider == 'crossref' and 'time1' in path:
                return _crossref_doi(
                    '10.1000/time1', 'Effects of aspirin on cardiovascular mortality', 'Smith', 2021, [2021, 6, 15],
                )
            if provider == 'europepmc' and 'time1' in path:
                return _epmc_hit(
                    '10.1000/time1', 'Effects of aspirin on cardiovascular mortality', 'Smith J', '2021',
                    abstract='Aspirin reduced events.', date='2021-06-15',
                )
            if provider == 'openalex':
                raise AssertionError(path)
            if provider == 'crossref':
                empty = {'message': {'items': []}}
                return 200, empty, sha_json(empty)
            empty = {'resultList': {'result': []}}
            return 200, empty, sha_json(empty)

        later = peg.verify_bibliography([agreeing], manuscript_date='2020-01-01', transport=transport)
        self.assertEqual(len(later['triageHints']), 1)
        hint = later['triageHints'][0]
        self.assertEqual(hint['code'], 'citation_postdates_manuscript')
        self.assertIs(hint['advisoryOnly'], True)
        self.assertEqual(hint['basis'], 'provider_record')
        self.assertEqual(hint['referenceDate'], '2021-06-15')
        self.assertEqual(hint['manuscriptDate'], '2020-01-01')
        self.assertEqual(hint['refIndex'], 1)
        self.assertIn('preprint revisions', hint['note'])
        self.assertIn('"in press"', hint['note'])
        self.assertIn('online-first', hint['note'])
        self.assertEqual(later['summary']['verifiedMatch'], 1)
        self.assertNotIn('citation_postdates_manuscript', later['summary'])
        self.assertEqual(later['results'][0]['corroboration']['indices']['openalex'], 'skipped')
        suppressed = peg.verify_bibliography(
            ['[9] Smith J. Effects of aspirin on cardiovascular mortality. Lancet. 2022; doi:10.1000/time1'],
            manuscript_date='2021',
            transport=_dated_transport([2020, 1, 1]),
        )
        self.assertEqual(suppressed['triageHints'], [])
        self.assertEqual(suppressed['results'][0]['corroboration']['tier'], 'medium')

        month = peg.verify_bibliography([agreeing], manuscript_date='2021-05', transport=_dated_transport([2021, 6]))
        self.assertEqual(month['triageHints'][0]['referenceDate'], '2021-06')
        self.assertEqual(month['triageHints'][0]['basis'], 'provider_record')
        same_month = peg.verify_bibliography(
            [agreeing], manuscript_date='2021-06-20', transport=_dated_transport([2021, 6]),
        )
        self.assertEqual(same_month['triageHints'], [])
        full = peg.verify_bibliography(
            [agreeing], manuscript_date='2021-06-14', transport=_dated_transport([2021, 6, 15]),
        )
        self.assertEqual(full['triageHints'][0]['referenceDate'], '2021-06-15')
        same_year = peg.verify_bibliography(
            [agreeing], manuscript_date='2021', transport=_dated_transport([2021, 12, 31]),
        )
        self.assertEqual(same_year['triageHints'], [])

        printed = peg.verify_bibliography([printed_only], manuscript_date='2020', transport=transport)
        self.assertEqual(len(printed['triageHints']), 1)
        self.assertEqual(printed['triageHints'][0]['basis'], 'printed_year')
        self.assertEqual(printed['triageHints'][0]['referenceDate'], '2022')
        self.assertEqual(printed['triageHints'][0]['refIndex'], 2)
        same_printed = peg.verify_bibliography([printed_only], manuscript_date='2022', transport=transport)
        self.assertEqual(same_printed['triageHints'], [])

        for bad in ('2020-13', '2020-02-31', '2020/01/01', '2020-1-01', 2020, ''):
            with self.assertRaises(ValueError) as caught:
                peg.verify_bibliography([printed_only], manuscript_date=bad, transport=transport)
            self.assertEqual(caught.exception.args[0], 'invalid_manuscript_date')


def _crossref_doi(doi, title, family, year, date_parts=None):
    data = {'message': {
        'DOI': doi,
        'title': [title],
        'author': [{'given': 'Ann', 'family': family}],
        'published': {'date-parts': [date_parts or [year]]},
    }}
    return 200, data, sha_json(data)


def _epmc_hit(doi, title, author, year, abstract='', date=None):
    row = {'doi': doi, 'title': title, 'authorString': author, 'pubYear': str(year)}
    if abstract:
        row['abstractText'] = abstract
    if date:
        row['firstPublicationDate'] = date
    data = {'resultList': {'result': [row]}}
    return 200, data, sha_json(data)


def _openalex_work(doi, title, name, year, date=None):
    work = {
        'doi': 'https://doi.org/' + doi,
        'display_name': title,
        'publication_year': year,
        'authorships': [{'author': {'display_name': name}}],
    }
    if date:
        work['publication_date'] = date
    return work


def _dated_transport(date_parts):
    def transport(provider, path):
        if provider == 'crossref':
            return _crossref_doi(
                '10.1000/time1', 'Effects of aspirin on cardiovascular mortality', 'Smith', date_parts[0], date_parts,
            )
        if provider == 'europepmc':
            months = f'-{date_parts[1]:02d}' if len(date_parts) > 1 else ''
            days = f'-{date_parts[2]:02d}' if len(date_parts) > 2 else ''
            return _epmc_hit(
                '10.1000/time1', 'Effects of aspirin on cardiovascular mortality', 'Smith J', str(date_parts[0]),
                date=f'{date_parts[0]:04d}{months}{days}',
            )
        raise AssertionError((provider, path))
    return transport


class SecurityBoundaryTests(unittest.TestCase):
    def test_rejects_non_global_ips_and_bad_providers(self):
        private_addr = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]
        with patch.object(socket, 'getaddrinfo', return_value=private_addr):
            with self.assertRaisesRegex(ValueError, 'non_public_api_address'):
                peg.fetch_json('crossref', '/works/10.1000/abc')
            with self.assertRaisesRegex(ValueError, 'non_public_api_address'):
                pct.fetch_study_json('NCT01234567')

        with self.assertRaisesRegex(ValueError, 'unknown_provider'):
            peg.fetch_json('evil.example.com', '/works')


if __name__ == '__main__':
    unittest.main()
