"""Offline regression tests for long hosted BLUE papers with structured evidence (e.g. math/0106063)."""
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'app' / 'local'))

import anthropic_backend
import blue_service as blue
import review_limits
from hosted_runtime.config import RuntimeConfig
from hosted_runtime.service import RuntimeService

FILE_HASH = 'ab' * 32
PAPER_ID = 'paper-long-0106063'
BOOTH_LIVE_PROMPT = (ROOT / 'tools' / 'booth' / 'prompts' / 'blue-live.txt').read_text(encoding='utf-8').strip()


def make_structured(chars=24000, tables=1, figures=23):
    body = 'prepared-evidence falsify.paper-evidence.v1\n' + ('Table/figure summary row. ' * 1000)
    text = body[:chars]
    return {
        'text': text,
        'coverage': {
            'paperId': PAPER_ID,
            'fileHash': FILE_HASH,
            'engine': 'pymupdf',
            'status': 'ready',
            'limitations': [],
            'pageCount': 491,
            'counts': {'tables': tables, 'figures': figures},
            'omittedIds': [f'fig-{i}' for i in range(10)],
            'truncated': True,
        },
    }


def make_math_0106063_segments():
    """Match math/0106063 measured shape: 491 pages, 11,487 blocks, ~929,897 extracted chars."""
    segments = []
    pages = 491
    total_blocks = 11487
    per_page = total_blocks // pages
    extra = total_blocks % pages
    for page in range(1, pages + 1):
        count = per_page + (1 if page <= extra else 0)
        for block in range(1, count + 1):
            if page == pages and block == count:
                text = 'FINAL_PAGE_DEFECT Theorem 491 asserts x = 99 instead of x = 42 in Section 1.'
            else:
                text = (f'Section {page} block {block}: lemma proof sequence alpha_{page}_{block} = beta + 1 '
                        'in compact space.')
            segments.append({'id': f'p{page}-b{block}', 'label': f'page {page}', 'text': text})
    source = '\n\n'.join(s['text'] for s in segments)
    return segments, hashlib.sha256(source.encode('utf-8')).hexdigest(), len(source)


def hosted_evidence_request(segments, source_hash, max_calls=8, *, prompt=BOOTH_LIVE_PROMPT,
                            model='claude-sonnet-5-5', extra=None):
    data = {
        'schema': blue.VERSION,
        'consent': True,
        'revision': 'r-long',
        'requestId': 'req-long-1',
        'segments': segments,
        'sourceHash': source_hash,
        'maxCalls': max_calls,
        'fileHash': FILE_HASH,
        'paperEvidence': {'paperId': PAPER_ID, 'fileHash': FILE_HASH},
        'paperEvidenceConsent': True,
        'harness': {
            'schema': 'falsify.harness.v1',
            'id': 'hosted-anthropic',
            'name': 'Hosted Anthropic',
            'version': '1',
            'role': 'blue',
            'instructions': prompt,
            'maxCalls': max_calls,
            'adapter': {'type': 'hosted', 'model': model, 'effort': 'high'},
        },
    }
    if extra:
        data.update(extra)
    return data


def reconstruct_by_segment(batches):
    rebuilt = {}
    for batch in batches:
        for frag in batch:
            rebuilt.setdefault(frag['id'], []).append(frag['text'])
    return {sid: ''.join(parts) for sid, parts in rebuilt.items()}


class LongPaperHostedBlueTests(unittest.TestCase):
    def test_math_0106063_profile_fits_live_budget_with_full_coverage_and_evidence(self):
        segments, source_hash, total_chars = make_math_0106063_segments()
        self.assertGreater(total_chars, 900000)
        self.assertEqual(len(segments), 11487)
        structured = make_structured(chars=24000, tables=1, figures=23)
        req = hosted_evidence_request(segments, source_hash, max_calls=8)

        prompts = []
        target_quote = 'FINAL_PAGE_DEFECT Theorem 491 asserts x = 99 instead of x = 42 in Section 1.'
        last_sid = segments[-1]['id']

        class FakeLongHosted:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

            def infer(self, prompt, schema):
                prompts.append(prompt)
                findings = []
                if target_quote in prompt:
                    findings.append({
                        'id': 'f-p491',
                        'segmentId': last_sid,
                        'quote': target_quote,
                        'rationale': '491쪽 정리가 앞 절 수치와 충돌합니다. || EN: Theorem 491 contradicts Section 1.',
                        'uncertainty': None,
                        'evidence': [{'segmentId': last_sid, 'quote': target_quote, 'relation': 'contradicted claim'}],
                    })
                return {'status': 'ok', 'response': {'status': 'ok', 'findings': findings},
                        'usage': {'input_tokens': 100, 'output_tokens': 20},
                        'provider_model': 'claude-sonnet-5-5', 'request_id': f'req-{len(prompts)}'}

        with patch('paper_evidence_blue.context_for_review', return_value=structured):
            batches, required = blue.validate_request(req)
            self.assertEqual(required, 8)
            self.assertEqual(len(batches), 8)
            rebuilt = reconstruct_by_segment(batches)
            self.assertEqual(rebuilt, {s['id']: s['text'] for s in segments})

            res = blue.run_review(req, lambda _: None, threading.Event(), hosted_factory=FakeLongHosted)

        self.assertEqual(res['status'], 'ok')
        self.assertTrue(res['coverage']['complete'])
        self.assertEqual(res['coverage']['calls'], 8)
        self.assertEqual(res['coverage']['textBatches'], 8)
        self.assertEqual(res['coverage']['remainingBatches'], [])
        self.assertEqual(res['coverage']['batchStatuses'], ['ok'] * 8)
        self.assertEqual(res['coverage']['resultCoverage']['modelStatus'], 'ok')
        self.assertEqual(res['coverage']['paperEvidence']['paperId'], PAPER_ID)
        self.assertEqual(res['coverage']['paperEvidence']['fileHash'], FILE_HASH)
        self.assertEqual(res['coverage']['paperEvidence']['selectedEvidenceItems'], [])
        self.assertEqual([f['id'] for f in res['findings']], ['f-p491'])
        self.assertEqual(res['findings'][0]['segmentId'], last_sid)
        self.assertEqual(len(prompts), 8)
        for prompt in prompts:
            self.assertIn('SOURCE_PDF_STRUCTURED_EVIDENCE_V1', prompt)
            self.assertLessEqual(len(prompt), review_limits.HOSTED['blue_max_prompt'])
        # Balanced batches stay well below the 400,000-char prompt ceiling.
        self.assertLess(max(len(p) for p in prompts), 260000)

    def test_math_0106063_clean_zero_findings_and_batch_refusal_semantics(self):
        segments, source_hash, _ = make_math_0106063_segments()
        structured = make_structured()
        req = hosted_evidence_request(segments, source_hash, max_calls=8)

        class CleanZero:
            def __init__(self, **kwargs):
                pass

            def infer(self, prompt, schema):
                return {'status': 'ok', 'response': {'status': 'ok', 'findings': []}}

        class RefusalOnBatch6:
            calls = 0

            def __init__(self, **kwargs):
                pass

            def infer(self, prompt, schema):
                type(self).calls += 1
                status = 'refusal' if type(self).calls == 6 else 'ok'
                return {'status': 'ok', 'response': {'status': status, 'findings': []}}

        with patch('paper_evidence_blue.context_for_review', return_value=structured):
            clean = blue.run_review(req, lambda _: None, threading.Event(), hosted_factory=CleanZero)
            refused = blue.run_review(req, lambda _: None, threading.Event(), hosted_factory=RefusalOnBatch6)

        self.assertEqual(clean['status'], 'ok')
        self.assertEqual(clean['findings'], [])
        self.assertTrue(clean['coverage']['complete'])
        self.assertEqual(clean['coverage']['resultCoverage']['modelStatus'], 'ok')
        self.assertEqual(refused['status'], 'refusal')
        self.assertFalse(refused['coverage']['complete'])
        self.assertEqual(refused['coverage']['resultCoverage']['modelStatus'], 'refusal')

    def test_six_hundred_to_eight_hundred_k_uses_standard_batches_within_budget(self):
        segments = [{'id': f'p{i + 1}-b1', 'label': f'page {i + 1}', 'text': f'Page {i + 1} ' + ('word ' * 1990)}
                    for i in range(70)]
        source_hash = hashlib.sha256('\n\n'.join(s['text'] for s in segments).encode('utf-8')).hexdigest()
        structured = make_structured(chars=12000)
        req = hosted_evidence_request(segments, source_hash, max_calls=8)

        with patch('paper_evidence_blue.context_for_review', return_value=structured):
            batches, required = blue.validate_request(req)
        self.assertEqual(required, 7)
        self.assertEqual(len(batches), 7)
        self.assertEqual(reconstruct_by_segment(batches), {s['id']: s['text'] for s in segments})

    def test_dense_escaping_and_oversized_single_segment_stay_within_prompt_cap(self):
        # Heavy quote/backslash escaping expands JSON size well beyond raw text length.
        dense_segments = [
            {'id': f'p{i + 1}-b1', 'label': f'page {i + 1}', 'text': ('"\\"' * 600) + f' marker-{i}'}
            for i in range(420)
        ]
        source_hash = hashlib.sha256('\n\n'.join(s['text'] for s in dense_segments).encode('utf-8')).hexdigest()
        structured = make_structured(chars=20000)
        req = hosted_evidence_request(dense_segments, source_hash, max_calls=8)

        seen_prompts = []

        class Recorder:
            def __init__(self, **kwargs):
                pass

            def infer(self, prompt, schema):
                seen_prompts.append(prompt)
                return {'status': 'ok', 'response': {'status': 'ok', 'findings': []}}

        with patch('paper_evidence_blue.context_for_review', return_value=structured):
            batches, required = blue.validate_request(req)
            self.assertLessEqual(required, 8)
            self.assertEqual(reconstruct_by_segment(batches), {s['id']: s['text'] for s in dense_segments})
            res = blue.run_review(req, lambda _: None, threading.Event(), hosted_factory=Recorder)
        self.assertTrue(res['coverage']['complete'])
        self.assertTrue(all(len(p) <= review_limits.HOSTED['blue_max_prompt'] for p in seen_prompts))

        # Single 950k-char segment splits cleanly without losing any character.
        giant_text = ''.join(f'CHUNK_{i:04d} ' + ('x' * 940) for i in range(1000))
        giant_segments = [{'id': 'p1-b1', 'label': 'page 1', 'text': giant_text}]
        giant_hash = hashlib.sha256(giant_text.encode('utf-8')).hexdigest()
        giant_req = hosted_evidence_request(giant_segments, giant_hash, max_calls=8)
        with patch('paper_evidence_blue.context_for_review', return_value=structured):
            g_batches, g_req = blue.validate_request(giant_req)
        self.assertLessEqual(g_req, 8)
        self.assertEqual(reconstruct_by_segment(g_batches), {'p1-b1': giant_text})

    def test_truly_unsupported_document_fails_before_engine(self):
        # 3.6M chars cannot fit into 8 calls under a 400k prompt cap (~370k usable per call).
        segments = [{'id': f'p{i + 1}-b1', 'label': f'page {i + 1}', 'text': 'a' * 120000} for i in range(30)]
        source_hash = hashlib.sha256('\n\n'.join(s['text'] for s in segments).encode('utf-8')).hexdigest()
        structured = make_structured(chars=24000)
        req = hosted_evidence_request(segments, source_hash, max_calls=8)
        created = []

        class NeverCalled:
            def __init__(self, **kwargs):
                created.append(kwargs)

            def infer(self, prompt, schema):
                raise AssertionError('engine must not run when budget cannot cover document')

        with patch('paper_evidence_blue.context_for_review', return_value=structured):
            with self.assertRaisesRegex(ValueError, '최소'):
                blue.run_review(req, lambda _: None, threading.Event(), hosted_factory=NeverCalled)
        self.assertEqual(created, [])

    def test_auto_visual_reread_and_local_cli_preserve_strict_legacy_preflight(self):
        segments = [{'id': f'p{i + 1}-b1', 'label': f'page {i + 1}', 'text': 'x' * 95000} for i in range(7)]
        source_hash = hashlib.sha256('\n\n'.join(s['text'] for s in segments).encode('utf-8')).hexdigest()
        structured = make_structured(chars=1000)
        auto_req = hosted_evidence_request(
            segments, source_hash, max_calls=8,
            extra={'autoVisualReread': True, 'visualConsent': True},
        )
        with patch('paper_evidence_blue.context_for_review', return_value=structured):
            with self.assertRaisesRegex(ValueError, 'visual_provider_unsupported'):
                blue.validate_request(auto_req)

        local_text = 'y' * 150000
        local_req = {
            'schema': blue.VERSION,
            'revision': 'r1',
            'requestId': 'local-1',
            'sourceHash': hashlib.sha256(local_text.encode('utf-8')).hexdigest(),
            'segments': [{'id': 's0', 'label': 'page 1', 'text': local_text}],
            'maxCalls': 4,
            'consent': True,
        }
        with self.assertRaisesRegex(ValueError, '근거 재독'):
            blue.validate_request(local_req)

    def test_runtime_service_e2e_long_pdf_with_table_and_figure(self):
        from hosted_runtime.pdf_input import extract_pdf

        doc = pymupdf.open()
        # Page 1: real table + image figure so EvidenceStore prepares paperEvidence.
        p0 = doc.new_page(width=420, height=420)
        p0.insert_text((40, 35), 'Table 1. Summary values')
        for y in (50, 80, 110):
            p0.draw_line((40, y), (260, y))
        for x in (40, 150, 260):
            p0.draw_line((x, 50), (x, 110))
        for x, y, text in [(50, 70, 'Metric'), (160, 70, 'Value'), (50, 100, 'Alpha'), (160, 100, '42')]:
            p0.insert_text((x, y), text)
        pix = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 40, 30), False)
        pix.clear_with(150)
        p0.insert_image(pymupdf.Rect(40, 140, 120, 200), stream=pix.tobytes('png'))
        p0.insert_text((40, 220), 'Figure 1. Reference plot')

        # Add dense text pages to exceed the legacy 800k / maxCalls=8 cliff (~930k chars total).
        line_base = 'Consistent experimental measurement record in appendix section alpha beta gamma delta epsilon.'
        page_text = '\n'.join(f'Row {k:02d}: {line_base}' for k in range(75))
        for page_idx in range(135):
            page = doc.new_page(width=612, height=792)
            body = page_text if page_idx < 134 else page_text + '\nLAST_PAGE_CLAIM Alpha equals 99 here.'
            page.insert_textbox(pymupdf.Rect(18, 18, 594, 774), body, fontsize=6.5)
        raw_pdf = doc.tobytes()
        doc.close()
        extracted = extract_pdf(raw_pdf)
        self.assertGreater(extracted['characters'], 850000)

        prompts = []

        def fake_transport(request, timeout):
            body = request['body']
            prompt = body['messages'][0]['content'][-1]['text']
            prompts.append(prompt)
            findings = []
            if 'LAST_PAGE_CLAIM Alpha equals 99 here.' in prompt:
                # Extract the actual segmentId carrying LAST_PAGE_CLAIM from the prompt JSON.
                marker = '"segments": '
                segs = json.loads(prompt[prompt.rindex(marker) + len(marker):-1])
                target_seg = next(s for s in segs if 'LAST_PAGE_CLAIM Alpha equals 99 here.' in s['text'])
                findings.append({
                    'id': 'f-last',
                    'segmentId': target_seg['id'],
                    'quote': 'LAST_PAGE_CLAIM Alpha equals 99 here.',
                    'rationale': '표 1의 Alpha=42와 충돌합니다. || EN: Contradicts Table 1 Alpha=42.',
                    'uncertainty': None,
                    'evidence': [{'segmentId': target_seg['id'],
                                  'quote': 'LAST_PAGE_CLAIM Alpha equals 99 here.',
                                  'relation': 'contradicts Table 1'}],
                })
            return {
                'status': 200,
                'headers': {'request-id': f'req-e2e-{len(prompts)}'},
                'body': json.dumps({
                    'model': body['model'],
                    'stop_reason': 'end_turn',
                    'content': [{'type': 'text', 'text': json.dumps({'status': 'ok', 'findings': findings})}],
                    'usage': {'input_tokens': 50, 'output_tokens': 15},
                }).encode('utf-8'),
            }

        with tempfile.TemporaryDirectory(prefix='falsify-long-paper-') as tmp:
            config = RuntimeConfig(
                state_dir=Path(tmp),
                service_token='long-paper-test-token-0123456789',
                models=('claude-sonnet-5-5',),
                default_model='claude-sonnet-5-5',
                max_calls=8,
                max_concurrency=1,
                bind_port=0,
            )
            with patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'test-key', 'ANTHROPIC_WORKSPACE_ID': 'ws-long'}), \
                    patch.object(anthropic_backend, '_http_transport', fake_transport), \
                    RuntimeService(config) as service:
                upload, _ = service.create_upload('opr:booth', 'long.pdf', 'application/pdf', raw_pdf)
                job, _ = service.submit_job({
                    'jobId': 'job-long-blue-1',
                    'ownerId': 'opr:booth',
                    'idempotencyKey': 'idem-long-blue-1',
                    'requestHash': 'hash-long-blue-1',
                    'role': 'blue',
                    'prompt': BOOTH_LIVE_PROMPT,
                    'uploadId': upload['id'],
                    'model': 'claude-sonnet-5-5',
                    'effort': 'high',
                    'useEvidence': True,
                    'budget': {'maxCalls': 8},
                })
                deadline = time.monotonic() + 60
                snap = job
                while snap['state'] not in ('completed', 'failed', 'cancelled') and time.monotonic() < deadline:
                    time.sleep(0.05)
                    snap = service.get_job('opr:booth', job['id'])

        self.assertEqual(snap['state'], 'completed', snap)
        self.assertEqual(snap['result']['status'], 'ok')
        self.assertTrue(snap['result']['coverage']['complete'])
        self.assertLessEqual(snap['result']['coverage']['calls'], 8)
        self.assertEqual(snap['result']['coverage']['remainingBatches'], [])
        self.assertIn('paperEvidence', snap['result']['coverage'])
        self.assertEqual(snap['progress']['phase'], 'completed')
        self.assertEqual([f['id'] for f in snap['result']['findings']], ['f-last'])
        self.assertTrue(all('SOURCE_PDF_STRUCTURED_EVIDENCE_V1' in p for p in prompts))
        self.assertTrue(all(len(p) <= review_limits.HOSTED['blue_max_prompt'] for p in prompts))


if __name__ == '__main__':
    unittest.main()
