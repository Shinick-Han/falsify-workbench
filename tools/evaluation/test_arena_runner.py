"""Unit and CLI tests for headless arena evaluator and blind-bundle verifier."""
from __future__ import annotations

import json
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

import arena_runner as mod  # noqa: E402

CLI_PATH = EVAL_DIR / 'arena_runner.py'
PY_CCN_PATH = REPO_ROOT / 'tools' / 'quality' / 'python-functions.py'

try:
    import pymupdf  # type: ignore
except ImportError:
    pymupdf = None


def _build_pdf_bytes(
    title: str = 'Clean Clinical Trial',
    xmp: str | None = None,
    annot_text: str | None = None,
    annot_title: str | None = None,
    widget_value: str | None = None,
    link_uri: str | None = None,
) -> bytes:
    if pymupdf is None:
        return _build_raw_pdf_bytes(title=title, xmp=xmp, annot_text=annot_text, annot_title=annot_title)
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 72), 'Clinical outcome report body text.')
    doc.set_metadata({'title': title, 'author': 'Trial Consortium'})
    if xmp:
        doc.set_xml_metadata(xmp)
    if annot_text or annot_title:
        annot = page.add_text_annot((100, 120), annot_text or 'note')
        info = dict(annot.info or {})
        if annot_title:
            info['title'] = annot_title
        annot.set_info(info)
        annot.update()
    if widget_value:
        widget = pymupdf.Widget()
        widget.rect = pymupdf.Rect(72, 160, 260, 190)
        widget.field_name = 'reviewer_notes'
        widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
        widget.field_value = widget_value
        page.add_widget(widget)
    if link_uri:
        page.insert_link({'kind': pymupdf.LINK_URI, 'from': pymupdf.Rect(72, 200, 220, 220), 'uri': link_uri})
    raw = doc.tobytes()
    doc.close()
    return raw


def _build_raw_pdf_bytes(
    title: str = 'Clean Clinical Trial',
    xmp: str | None = None,
    annot_text: str | None = None,
    annot_title: str | None = None,
    comment: str | None = None,
    widget_value: str | None = None,
) -> bytes:
    parts = [b'%PDF-1.4\n']
    if comment:
        parts.append(f'% {comment}\n'.encode('utf-8'))
    parts.append(b'1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n')
    parts.append(b'2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n')
    parts.append(b'3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\n')
    parts.append(f'4 0 obj << /Title ({title}) /Author (Trial Consortium) >> endobj\n'.encode('utf-8'))
    if xmp:
        parts.append(f'5 0 obj << /Type /Metadata /Subtype /XML >> stream\n{xmp}\nendstream endobj\n'.encode('utf-8'))
    if annot_text or annot_title:
        parts.append(
            f'6 0 obj << /Type /Annot /Subtype /Popup /Contents ({annot_text or ""}) /T ({annot_title or ""}) >> endobj\n'.encode('utf-8')
        )
    if widget_value:
        parts.append(
            f'7 0 obj << /Type /Annot /Subtype /Widget /FT /Tx /T (notes) /V ({widget_value}) >> endobj\n'.encode('utf-8')
        )
    parts.append(b'trailer << /Root 1 0 R /Info 4 0 R >>\n%%EOF\n')
    return b''.join(parts)


class BlindVerificationTests(unittest.TestCase):
    def test_clean_pdf_and_link_only_pass(self):
        pdf = _build_pdf_bytes(
            title='Randomized Cardiology Study',
            link_uri='https://doi.org/10.1000/falsify-link-uri-ignored',
        )
        res = mod.verify_blind_bundle(
            pdf,
            blind_supplements=[{'name': 'Table_S1.csv', 'text': 'arm,n,events\nA,100,12\nB,100,18\n'}],
        )
        self.assertEqual(res['schema'], mod.BLIND_SCHEMA)
        self.assertTrue(res['blindClean'])
        self.assertEqual(res['leakCount'], 0)
        self.assertEqual(res['supplementCount'], 1)
        self.assertEqual(len(res['pdfSha256']), 64)

    def test_docinfo_xmp_popup_widget_comment_and_supplement_leaks_fail(self):
        xmp_leak = '<x:xmpmeta><rdf:RDF><dc:description>why_hard: hidden drift</dc:description></rdf:RDF></x:xmpmeta>'
        pdf_docinfo = _build_pdf_bytes(title='Paper falsify red-plan')
        res_doc = mod.verify_blind_bundle(pdf_docinfo)
        self.assertFalse(res_doc['blindClean'])
        self.assertTrue(any(lk['surface'] == 'docinfo' for lk in res_doc['leaks']))

        pdf_xmp = _build_pdf_bytes(xmp=xmp_leak)
        res_xmp = mod.verify_blind_bundle(pdf_xmp)
        self.assertFalse(res_xmp['blindClean'])
        self.assertTrue(any(lk['surface'] == 'xmp' for lk in res_xmp['leaks']))

        pdf_annot = _build_pdf_bytes(annot_text='candidateRationales injected', annot_title='red-plan')
        res_annot = mod.verify_blind_bundle(pdf_annot)
        self.assertFalse(res_annot['blindClean'])
        self.assertTrue(any(lk['surface'] == 'annotation' for lk in res_annot['leaks']))

        pdf_widget = _build_pdf_bytes(widget_value='stealth_audit internal note')
        res_widget = mod.verify_blind_bundle(pdf_widget)
        self.assertFalse(res_widget['blindClean'])
        self.assertTrue(any(lk['surface'] == 'acroform' for lk in res_widget['leaks']))

        pdf_comment = _build_raw_pdf_bytes(comment='generated by falsify gold_ledger')
        res_comment = mod.verify_blind_bundle(pdf_comment)
        self.assertFalse(res_comment['blindClean'])
        self.assertTrue(any(lk['surface'] == 'trailer_comment' for lk in res_comment['leaks']))

        clean_pdf = _build_pdf_bytes()
        bad_supplements = [
            {'name': 'leak.json', 'text': json.dumps({'items': [{'defectId': 'g1', 'before': '10', 'after': '20'}]})},
            {'name': 'notes.txt', 'bytes': b'{"goldLedger": [], "why_hard": "cross-table"}'},
        ]
        res_sup = mod.verify_blind_bundle(clean_pdf, blind_supplements=bad_supplements)
        self.assertFalse(res_sup['blindClean'])
        tokens = {lk['token'].lower() for lk in res_sup['leaks']}
        self.assertTrue({'defectid', 'before', 'after', 'goldledger', 'why_hard'}.issubset(tokens))

    def test_source_inherited_before_and_after_title_is_exempted(self):
        source = _build_pdf_bytes(title='Heart attack before and after')
        blind_clean = _build_pdf_bytes(title='Heart attack before and after')
        res = mod.verify_blind_bundle(blind_clean, source_pdf_bytes=source)
        self.assertTrue(res['blindClean'])
        self.assertEqual(res['leakCount'], 0)

        with mock.patch.object(mod, 'pymupdf', None):
            raw_src = _build_raw_pdf_bytes(title='Heart attack before and after')
            raw_blind = _build_raw_pdf_bytes(title='Heart attack before and after')
            res_fallback = mod.verify_blind_bundle(raw_blind, source_pdf_bytes=raw_src)
            self.assertTrue(res_fallback['blindClean'])

            raw_leaked = _build_raw_pdf_bytes(
                title='Heart attack before and after',
                annot_text='injected why_hard clue',
                widget_value='gold_ledger',
            )
            res_fallback_leak = mod.verify_blind_bundle(raw_leaked, source_pdf_bytes=raw_src)
            self.assertFalse(res_fallback_leak['blindClean'])
            surfaces = {lk['surface'] for lk in res_fallback_leak['leaks']}
            self.assertEqual(surfaces, {'annotation', 'acroform'})


class ArenaEvaluationTests(unittest.TestCase):
    def _sample_gold_and_baseline(self):
        gold = {
            'schema': 'falsify.red-gold-ledger.v1',
            'defects': [
                {
                    'defectId': 'g-prose',
                    'world': 'W1',
                    'family': 'D1',
                    'difficulty': 'L1',
                    'pageIndex': 1,
                    'after': 'Overall mortality was 14.2% (p = 0.041) in the intervention arm.',
                    'stealthPass': False,
                },
                {
                    'defectId': 'g-bbox',
                    'world': 'W2',
                    'family': 'D5',
                    'difficulty': 'L2',
                    'pageIndex': 2,
                    'bbox': [100.0, 200.0, 300.0, 360.0],
                    'after': 'Kaplan-Meier figure bar height altered.',
                    'stealthPass': True,
                },
                {
                    'defectId': 'g-table',
                    'world': 'W3',
                    'family': 'D3',
                    'difficulty': 'L3',
                    'pageIndex': 3,
                    'itemId': 'table-1',
                    'after': 'Row total 48 disagrees with 21 + 24.',
                    'stealthPass': True,
                },
                {
                    'defectId': 'g-supp',
                    'world': 'W5',
                    'family': 'D6',
                    'difficulty': 'L4',
                    'supplementName': 'Table_S1.csv',
                    'after': 'Supplemental subgroup N=190 mismatches main N=180.',
                    'stealthStatus': 'clean',
                },
            ],
        }
        baseline = {
            'schema': 'falsify.blue-defect-sensor.v1',
            'signals': [
                {
                    'id': 'sens-1',
                    'family': 'D2',
                    'pageIndex': 4,
                    'excerpt': 'Reference 12 DOI 10.1000/preexisting-error disagrees with link.',
                },
            ],
        }
        return gold, baseline

    def test_bipartite_matching_baseline_exemption_stratified_metrics_and_stealth_yield(self):
        gold, baseline = self._sample_gold_and_baseline()
        blue_run = {
            'runId': 'blue-main',
            'agentId': 'agent-a',
            'findings': [
                {
                    'id': 'f1',
                    'decision': 'defect',
                    'pageIndex': 1,
                    'quote': 'In Results, overall mortality was 14.2% (p = 0.041) in the intervention arm.',
                },
                {
                    'id': 'f2',
                    'decision': 'defect',
                    'pageIndex': 2,
                    'bbox': [110.0, 210.0, 290.0, 350.0],
                    'quote': 'Visual inconsistency in figure curve.',
                },
                {
                    'id': 'f3',
                    'decision': 'defect',
                    'pageIndex': 3,
                    'itemId': 'table-1',
                    'quote': 'Table 1 arithmetic discrepancy.',
                },
                {
                    'id': 'f4',
                    'decision': 'defect',
                    'supplementName': 'Table_S1.csv',
                    'quote': 'Supplemental file N=190 conflicts with main text.',
                },
                {
                    'id': 'f5',
                    'decision': 'defect',
                    'pageIndex': 4,
                    'excerpt': 'Reference 12 DOI 10.1000/preexisting-error disagrees with link.',
                },
            ],
        }
        report = mod.evaluate_arena_match(gold, [blue_run], baseline_signals=baseline)
        self.assertEqual(report['schema'], mod.ARENA_SCHEMA)
        run = report['runs'][0]
        self.assertEqual(run['tp'], 4)
        self.assertEqual(run['fn'], 0)
        self.assertEqual(run['pureFp'], 0)
        self.assertEqual(run['preExistingExempted'], 1)
        self.assertEqual(run['precision'], 1.0)
        self.assertEqual(run['recall'], 1.0)
        self.assertEqual(run['stealthYield'], 0.0)
        self.assertEqual(run['byWorld']['W1']['recall'], 1.0)
        self.assertEqual(run['byWorld']['W2']['recall'], 1.0)
        self.assertEqual(run['byWorld']['W3']['recall'], 1.0)
        self.assertEqual(run['byWorld']['W5']['recall'], 1.0)
        self.assertEqual(run['byFamily']['D1']['recall'], 1.0)
        self.assertEqual(run['byFamily']['D5']['recall'], 1.0)
        self.assertEqual(run['byFamily']['D3']['recall'], 1.0)
        self.assertEqual(run['byFamily']['D6']['recall'], 1.0)
        self.assertEqual(run['byDifficulty']['L4']['recall'], 1.0)

    def test_multi_agent_alpha_selective_prediction_and_stealth_evasion(self):
        gold, baseline = self._sample_gold_and_baseline()
        run1 = {
            'runId': 'b1',
            'findings': [
                {'id': 'b1-1', 'decision': 'defect', 'pageIndex': 1, 'quote': 'mortality was 14.2% (p = 0.041)'},
                {'id': 'b1-2', 'decision': 'defect', 'pageIndex': 2, 'bbox': [105.0, 205.0, 295.0, 355.0], 'quote': 'fig'},
                {'id': 'b1-3', 'decision': '확인필요', 'pageIndex': 3, 'itemId': 'table-1', 'quote': 'possible table sum issue'},
                {'id': 'b1-4', 'decision': '확인필요', 'pageIndex': 0, 'quote': 'borderline abstract phrasing'},
            ],
        }
        run2 = {
            'runId': 'b2',
            'findings': [
                {'id': 'b2-1', 'decision': 'defect', 'pageIndex': 1, 'quote': 'mortality was 14.2% (p = 0.041)'},
                {'id': 'b2-2', 'decision': 'defect', 'pageIndex': 2, 'bbox': [105.0, 205.0, 295.0, 355.0], 'quote': 'fig'},
                {'id': 'b2-3', 'decision': 'needs_check', 'pageIndex': 3, 'itemId': 'table-1', 'quote': 'table check'},
                {'id': 'b2-4', 'decision': 'uncertain', 'pageIndex': 0, 'quote': 'uncertain sample size phrasing'},
            ],
        }
        run3 = {
            'runId': 'b3',
            'findings': [
                {'id': 'b3-1', 'decision': 'defect', 'pageIndex': 1, 'quote': 'mortality was 14.2% (p = 0.041)'},
                {'id': 'b3-2', 'decision': 'needs_check', 'pageIndex': 2, 'bbox': [105.0, 205.0, 295.0, 355.0], 'quote': 'fig'},
                {'id': 'b3-3', 'decision': 'defect', 'pageIndex': 5, 'quote': 'completely fabricated hallucination'},
                {'id': 'b3-4', 'decision': 'defect', 'pageIndex': 4, 'excerpt': 'Reference 12 DOI 10.1000/preexisting-error disagrees with link.'},
            ],
        }
        report = mod.evaluate_arena_match(gold, [run1, run2, run3], baseline_signals=baseline)
        # run1 caught 2/4 (missed g-table, g-supp; both are stealthPass out of 3 stealthPass total -> 2/3)
        self.assertAlmostEqual(report['runs'][0]['stealthYield'], 0.6667, places=4)
        self.assertEqual(report['runs'][0]['abstainedCount'], 2)
        self.assertEqual(report['runs'][2]['pureFp'], 1)
        self.assertEqual(report['runs'][2]['preExistingExempted'], 1)

        agreement = report['agreement']
        self.assertIsNotNone(agreement['nominalAlpha'])
        self.assertIsNotNone(agreement['ordinalAlpha'])
        self.assertGreater(agreement['ordinalAlpha'], agreement['nominalAlpha'])

        sel = report['selectivePrediction']
        self.assertGreater(sel['abstentionGain'], 0.0)
        self.assertIsNotNone(sel['aurc'])
        self.assertEqual(len(sel['riskCoverageCurve']), 3)

        digest = report['feedbackDigest']
        self.assertEqual(digest['evadedGoldDefectIds'], ['g-table', 'g-supp'])
        self.assertEqual(digest['triviallyCaughtDefectIds'], ['g-prose'])
        self.assertEqual(len(digest['pureFalsePositives']), 1)

    def test_coordinated_red_record_input_shape(self):
        coord = {
            'schema': 'falsify.coordinated-red-record.v1',
            'changes': [
                {'id': 'op-1', 'kind': 'uri-link', 'pageIndex': 0, 'afterUri': 'https://doi.org/10.1000/wrong'},
            ],
        }
        blue = {
            'status': 'ok',
            'findings': [
                {'id': 'f1', 'verdict': 'defect', 'pageIndex': 0, 'quote': 'https://doi.org/10.1000/wrong'},
            ],
        }
        report = mod.evaluate_arena_match(coord, blue)
        self.assertEqual(report['goldCount'], 1)
        self.assertEqual(report['runs'][0]['tp'], 1)


class ChangedTokenEvidenceTests(unittest.TestCase):
    """Changed-token evidence rules, wrapped-line coupling, and split classification."""

    def _run(self, gold_items, findings, baseline=None):
        gold = {'schema': 'falsify.red-gold-ledger.v1', 'defects': gold_items}
        blue = {'runId': 'changed-token-blue', 'findings': findings}
        return mod.evaluate_arena_match(gold, [blue], baseline_signals=baseline)['runs'][0]

    def test_short_changed_value_cited_only_in_rationale_matches(self):
        gold = [{
            'defectId': 'g-short',
            'world': 'W1',
            'family': 'D1',
            'difficulty': 'L2',
            'pageIndex': 0,
            'before': 'the retention coefficient was 0.11 for the cohort',
            'after': 'the retention coefficient was 0.44 for the cohort',
            'rationale': 'Section 2 prints a retention coefficient of 0.44 for the cohort that Section 1 measured as 0.11.',
        }]
        findings = [{
            'id': 'f-short',
            'decision': 'defect',
            'pageIndex': 0,
            'quote': 'reported effect size in the second table',
            'rationale': 'the value 0.44 differs from 0.11 in the first table',
        }]
        run = self._run(gold, findings)
        self.assertEqual(run['tp'], 1)
        self.assertEqual(run['fn'], 0)
        self.assertEqual(run['pureFp'], 0)
        self.assertEqual(run['missedDefectIds'], [])
        pair = run['matchedPairs'][0]
        self.assertEqual(pair['defectId'], 'g-short')
        self.assertGreaterEqual(pair['score'], 0.55)
        self.assertLessEqual(pair['score'], 0.75)

    def test_uri_link_gold_matches_visible_identifier_citation(self):
        gold = [{
            'defectId': 'g-link',
            'kind': 'uri-link',
            'world': 'W2',
            'family': 'D2',
            'difficulty': 'L2',
            'pageIndex': 4,
            'beforeUri': 'https://doi.org/10.7777/alpha000',
            'afterUri': 'https://doi.org/10.7777/zeta999',
            'rationale': 'Reference 9 prints 10.7777/alpha000 while its embedded link targets 10.7777/zeta999.',
        }]
        findings = [{
            'id': 'f-link',
            'decision': 'defect',
            'pageIndex': 4,
            'quote': '10.7777/alpha000',
            'rationale': 'the embedded target is 10.7777/zeta999 for that reference',
        }]
        run = self._run(gold, findings)
        self.assertEqual(run['tp'], 1)
        self.assertEqual(run['fn'], 0)
        self.assertEqual(run['pureFp'], 0)

    def test_cross_page_contradiction_matches_with_rationale_overlap(self):
        gold = [{
            'defectId': 'g-cross',
            'world': 'W1',
            'family': 'D1',
            'difficulty': 'L3',
            'pageIndex': 2,
            'before': 'the assay held 0.30 units',
            'after': 'the assay held 0.90 units',
            'rationale': 'Section 3 contrasts the abstract value 0.30 with the section value 0.90 for the identical sample set.',
        }]
        findings = [{
            'id': 'f-cross',
            'decision': 'defect',
            'pageIndex': 0,
            'quote': 'abstract reports 0.30 units',
            'rationale': 'the abstract states 0.30 but the section states 0.90 for the same sample set',
        }]
        run = self._run(gold, findings)
        self.assertEqual(run['tp'], 1)
        self.assertEqual(run['fn'], 0)
        self.assertEqual(run['pureFp'], 0)

    def test_cross_page_numeric_overlap_without_rationale_overlap_stays_unmatched(self):
        gold = [{
            'defectId': 'g-chance',
            'world': 'W5',
            'family': 'D5',
            'difficulty': 'L3',
            'pageIndex': 6,
            'before': 'the cluster score read 0.30',
            'after': 'the cluster score read 0.90',
            'rationale': 'Discussion restates the retention rate for the collapsed model.',
        }]
        findings = [{
            'id': 'f-chance',
            'decision': 'defect',
            'pageIndex': 9,
            'quote': 'grid values 0.30 and 0.90',
            'rationale': 'Table 4 caption lists the axis tick labels.',
        }]
        run = self._run(gold, findings)
        self.assertEqual(run['tp'], 0)
        self.assertEqual(run['fn'], 1)
        self.assertEqual(run['pureFp'], 1)
        self.assertEqual([fp['findingId'] for fp in run['pureFalsePositives']], ['f-chance'])

    def test_wrapped_two_line_gold_is_coupled_to_the_matching_finding(self):
        gold = [
            {
                'defectId': 'g-line-a',
                'world': 'W5',
                'family': 'D3',
                'difficulty': 'L4',
                'pageIndex': 8,
                'bbox': [100.0, 400.0, 160.0, 410.0],
                'before': 'as nominal',
                'after': 'as scaled',
                'rationale': 'Section 5 says affinities should be read as scaled rather than bounded values.',
            },
            {
                'defectId': 'g-line-b',
                'world': 'W5',
                'family': 'D3',
                'difficulty': 'L4',
                'pageIndex': 8,
                'bbox': [60.0, 412.0, 120.0, 422.0],
                'before': 'than fixed',
                'after': 'than bounded',
                'rationale': 'Second half of the same two-line rewrite.',
            },
        ]
        findings = [{
            'id': 'f-line',
            'decision': 'defect',
            'pageIndex': 8,
            'quote': 'considered as scaled rather than bounded',
            'rationale': 'the sentence now reads as scaled and than bounded, so the earlier as nominal / than fixed wording was inverted',
        }]
        run = self._run(gold, findings)
        self.assertEqual(run['tp'], 2)
        self.assertEqual(run['fn'], 0)
        self.assertEqual(run['pureFp'], 0)
        self.assertEqual(run['missedDefectIds'], [])
        coupled = [pair for pair in run['matchedPairs'] if pair.get('coupledWith')]
        self.assertEqual(len(coupled), 1)
        self.assertEqual(coupled[0]['findingId'], 'f-line')
        self.assertIn(coupled[0]['coupledWith'], {'g-line-a', 'g-line-b'})

    def test_split_observation_of_matched_gold_is_not_a_pure_false_positive(self):
        gold = [{
            'defectId': 'g-split',
            'world': 'W3',
            'family': 'D6',
            'difficulty': 'L2',
            'pageIndex': 1,
            'before': 'offset = 1.0\nscale = 5.0',
            'after': 'offset = 3.0\nscale = 7.0',
            'rationale': 'Both constants in the snippet were rewritten.',
        }]
        findings = [
            {'id': 'f-first', 'decision': 'defect', 'pageIndex': 1, 'quote': 'offset = 3.0'},
            {'id': 'f-second', 'decision': 'defect', 'pageIndex': 1, 'quote': 'scale = 7.0'},
        ]
        run = self._run(gold, findings)
        self.assertEqual(run['tp'], 1)
        self.assertEqual(run['fn'], 0)
        self.assertEqual(run['pureFp'], 0)
        self.assertEqual(run['precision'], 1.0)
        self.assertEqual(run['splitOfMatchedCount'], 1)
        self.assertEqual(run['splitOfMatchedFindingIds'], ['f-second'])
        self.assertEqual(run['pureFalsePositives'], [])

    def test_same_page_without_the_changed_value_stays_unmatched(self):
        gold = [{
            'defectId': 'g-quiet',
            'world': 'W1',
            'family': 'D1',
            'difficulty': 'L2',
            'pageIndex': 2,
            'before': 'the mean settled at 0.45 units',
            'after': 'the mean settled at 0.55 units',
            'rationale': 'The reported mean moved from 0.45 to 0.55.',
        }]
        findings = [{
            'id': 'f-quiet',
            'decision': 'defect',
            'pageIndex': 2,
            'quote': 'the mean is summarised in Table 5',
            'rationale': 'Table 5 caption wording is inconsistent with the column order.',
        }]
        run = self._run(gold, findings)
        self.assertEqual(run['tp'], 0)
        self.assertEqual(run['fn'], 1)
        self.assertEqual(run['pureFp'], 1)

    def test_gold_without_changed_tokens_never_triggers_evidence_rules(self):
        target = mod._normalize_gold_item({'defectId': 'g-noverb', 'pageIndex': 0}, 0)
        finding = mod._normalize_finding(
            {'id': 'f-noverb', 'decision': 'defect', 'pageIndex': 0, 'quote': 'caption placement'},
            0,
        )
        self.assertEqual(target['afterTokens'], set())
        self.assertEqual(target['beforeTokens'], set())
        self.assertEqual(mod._same_location_changed_token_score(target, finding), 0.0)
        self.assertEqual(mod._cross_page_contradiction_score(target, finding), 0.0)
        self.assertEqual(mod._match_score(target, finding), 0.0)

    def test_baseline_signals_without_changed_tokens_keep_exemption(self):
        baseline = {
            'schema': 'falsify.blue-defect-sensor.v1',
            'signals': [{
                'id': 'sens-keep',
                'family': 'D2',
                'pageIndex': 5,
                'excerpt': 'reference 4 citation style differs from the journal template',
            }],
        }
        gold = [{
            'defectId': 'g-other',
            'world': 'W1',
            'family': 'D1',
            'difficulty': 'L1',
            'pageIndex': 1,
            'before': 'the subgroup total read 24 percent',
            'after': 'the subgroup total read 42 percent',
        }]
        findings = [{
            'id': 'f-base',
            'decision': 'defect',
            'pageIndex': 5,
            'excerpt': 'reference 4 citation style differs from the journal template',
            'rationale': 'pre-existing style drift, not a RED edit',
        }]
        run = self._run(gold, findings, baseline)
        self.assertEqual(run['tp'], 0)
        self.assertEqual(run['pureFp'], 0)
        self.assertEqual(run['preExistingExempted'], 1)
        self.assertEqual(run['exemptedFindingIds'], ['f-base'])
        normalized = mod._normalize_baseline_signals(baseline)
        self.assertNotIn('afterTokens', normalized[0])
        self.assertNotIn('beforeTokens', normalized[0])
        finding = mod._normalize_finding(findings[0], 0)
        self.assertEqual(mod._same_location_changed_token_score(normalized[0], finding), 0.0)


class CliAndComplexityTests(unittest.TestCase):
    def test_cli_verify_blind_and_evaluate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            clean_pdf = root / 'clean.pdf'
            leaked_pdf = root / 'leaked.pdf'
            sup_json = root / 'sup.json'
            gold_json = root / 'gold.json'
            blue_json = root / 'blue.json'
            out_json = root / 'arena_report.json'

            clean_pdf.write_bytes(_build_pdf_bytes())
            leaked_pdf.write_bytes(_build_pdf_bytes(title='Leaked falsify copy'))
            sup_json.write_text('{"rows": [1, 2, 3]}', encoding='utf-8')
            gold_json.write_text(json.dumps([
                {'defectId': 'd1', 'world': 'W1', 'family': 'D1', 'difficulty': 'L1', 'pageIndex': 0, 'after': 'value 99.1%'},
            ]), encoding='utf-8')
            blue_json.write_text(json.dumps({
                'runId': 'cli-blue',
                'findings': [{'id': 'f1', 'decision': 'defect', 'pageIndex': 0, 'quote': 'value 99.1%'}],
            }), encoding='utf-8')

            proc_ok = subprocess.run(
                [sys.executable, str(CLI_PATH), 'verify-blind', '--pdf', str(clean_pdf), '--supplement', str(sup_json)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(proc_ok.returncode, 0)
            self.assertTrue(json.loads(proc_ok.stdout)['blindClean'])

            proc_leak = subprocess.run(
                [sys.executable, str(CLI_PATH), 'verify-blind', '--pdf', str(leaked_pdf)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(proc_leak.returncode, 3)
            self.assertFalse(json.loads(proc_leak.stdout)['blindClean'])

            proc_eval = subprocess.run(
                [sys.executable, str(CLI_PATH), 'evaluate', '--gold', str(gold_json), '--blue', str(blue_json), '--out', str(out_json)],
                capture_output=True, text=True, check=True,
            )
            payload = json.loads(proc_eval.stdout)
            self.assertEqual(payload['schema'], mod.ARENA_SCHEMA)
            self.assertEqual(payload['runs'][0]['tp'], 1)
            self.assertTrue(out_json.exists())

    def test_arena_runner_ccn_within_gate(self):
        source = CLI_PATH.read_text(encoding='utf-8')
        proc = subprocess.run(
            [sys.executable, str(PY_CCN_PATH)],
            input=source, capture_output=True, text=True, check=True,
        )
        functions = json.loads(proc.stdout)
        violations = [fn for fn in functions if fn['ccn'] > 15]
        self.assertEqual(violations, [])


if __name__ == '__main__':
    unittest.main()
