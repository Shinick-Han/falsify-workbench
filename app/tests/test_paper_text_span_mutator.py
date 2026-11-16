"""Word-level text-span mutation: subset fonts stay alive and no NUL glyphs leak."""
import sys
import unittest
from pathlib import Path
from unittest import mock

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

import paper_text_span_mutator as mutator  # noqa: E402
from paper_text_span_mutator import SpanMutationError, mutate_pdf_text_spans  # noqa: E402

SERIF = ROOT / 'app' / 'dist' / 'font-assets' / 'LiberationSerif-Regular.ttf'


def _pdf_bytes(doc) -> bytes:
    raw = doc.tobytes(garbage=4, deflate=True)
    doc.close()
    return raw


def _subset_font_pdf() -> bytes:
    """Paragraph drawn with an embedded TrueType font, then subset like a real paper."""
    doc = pymupdf.open()
    page = doc.new_page(width=460, height=220)
    for y, line in ((80, 'The total sampling time is computed via 10 independent'),
                    (100, 'replicas of 10 us during the calibration stage.')):
        page.insert_text((60, y), line, fontsize=11, fontname='LSerif', fontfile=str(SERIF))
    doc.subset_fonts()
    return _pdf_bytes(doc)


def _single_span_pdf(text: str) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=460, height=160)
    page.insert_text((60, 80), text, fontsize=11, fontname='helv')
    return _pdf_bytes(doc)


def _words(page, needle: str):
    return [w for w in page.get_text('words') if w[4] == needle]


def _line_words(page) -> list[tuple[float, str]]:
    return [(w[0], w[4]) for w in sorted(page.get_text('words'), key=lambda w: (round(w[1], 1), w[0]))]


class NoSpaceGlyphMetrics:
    """Font metrics that report no space glyph, like a LaTeX CMR10 subset.

    The double only removes glyph 0x20; letters and digits resolve exactly as the
    wrapped base-14 font so width fitting still behaves like production.
    """

    def __init__(self, inner):
        self._inner = inner

    def has_glyph(self, code: int) -> int:
        return 0 if code == 32 else self._inner.has_glyph(code)

    def text_length(self, text: str, fontsize: float = 11.0) -> float:
        return self._inner.text_length(text, fontsize=fontsize)


class RecordingPage:
    """Minimal page double that records the text handed to insert_text."""

    def __init__(self):
        self.inserted: list[tuple[float, float, str]] = []

    def add_redact_annot(self, *args, **kwargs):
        return None

    def apply_redactions(self, *args, **kwargs):
        return None

    def insert_text(self, point, text, **kwargs):
        self.inserted.append((float(point[0]), float(point[1]), text))


class SubsetFontMutationTests(unittest.TestCase):
    def test_subset_embedded_font_numeric_replacement_survives_redaction(self):
        raw = _subset_font_pdf()
        result = mutate_pdf_text_spans(raw, [{
            'id': 'subset-1',
            'kind': 'text-span',
            'pageIndex': 0,
            'before': 'via 10',
            'after': 'via 25',
        }])
        self.assertEqual(result['appliedCount'], 1)
        page = pymupdf.open(stream=result['pdfBytes'], filetype='pdf')[0]
        self.assertIn('via 25', page.get_text('text'))
        self.assertNotIn('\x00', page.get_text('text'))


class SpaceGlyphTests(unittest.TestCase):
    def test_font_without_space_glyph_leaves_no_nul_bytes(self):
        raw = _single_span_pdf('The replicas of 10 us were pooled.')
        metrics = NoSpaceGlyphMetrics(pymupdf.Font(fontname='helv'))
        self.assertEqual(metrics.has_glyph(32), 0)
        calls = []

        def fake_font(doc, page, span, text, number):
            calls.append(text)
            return 'helv', False, metrics

        with mock.patch.object(mutator, '_font', fake_font):
            result = mutate_pdf_text_spans(raw, [{
                'id': 'space-1',
                'kind': 'text-span',
                'pageIndex': 0,
                'before': 'of 10',
                'after': 'of 25',
            }])
        self.assertEqual(result['appliedCount'], 1)
        self.assertTrue(calls and all(' ' in text for text in calls), calls)
        self.assertEqual(len(calls), 2, 'font must be re-registered after redaction')
        text = pymupdf.open(stream=result['pdfBytes'], filetype='pdf')[0].get_text('text')
        self.assertNotIn('\x00', text)
        self.assertIn('of', text.split())
        self.assertIn('25', text.split())

    def test_word_placement_never_inserts_whitespace(self):
        page = RecordingPage()
        plan = {
            'op': {'after': 'of 25', 'pageIndex': 0},
            'rect': pymupdf.Rect(60, 70, 90, 84),
            'modBbox': [60.0, 70.0, 90.0, 84.0],
            'fittedSize': 11.0,
            'origSize': 11.0,
            'originY': 80.0,
            'color': (0.0, 0.0, 0.0),
            'doc': None,
            'span': {},
            'fontIdx': 0,
            'origWords': [(60.0, 70.0, 73.0, 84.0, 'of'), (76.0, 70.0, 90.0, 84.0, '10')],
            'words': ['of', '25'],
            'keepOriginal': True,
            'maxWidth': 30.0,
        }
        with mock.patch.object(mutator, '_font', lambda *a: ('helv', False, pymupdf.Font(fontname='helv'))):
            mutator._apply_page_text_plans(page, [plan])
        self.assertEqual([text for _, _, text in page.inserted], ['of', '25'])
        self.assertTrue(all(' ' not in text for _, _, text in page.inserted))


class LineWidthTests(unittest.TestCase):
    def test_longer_middle_word_is_rejected_without_room(self):
        raw = _single_span_pdf('alpha beta gamma delta')
        with self.assertRaises(SpanMutationError) as ctx:
            mutate_pdf_text_spans(raw, [{
                'id': 'room-1',
                'kind': 'text-span',
                'pageIndex': 0,
                'before': 'beta',
                'after': 'betaandthensomemoreextrawordshere',
            }])
        self.assertEqual(ctx.exception.code, 'text_span_no_room')

    def test_same_length_middle_word_keeps_a_gap_to_the_next_word(self):
        raw = _single_span_pdf('alpha beta gamma delta')
        result = mutate_pdf_text_spans(raw, [{
            'id': 'room-2',
            'kind': 'text-span',
            'pageIndex': 0,
            'before': 'beta',
            'after': 'zeta',
        }])
        self.assertEqual(result['appliedCount'], 1)
        page = pymupdf.open(stream=result['pdfBytes'], filetype='pdf')[0]
        zeta = _words(page, 'zeta')
        gamma = _words(page, 'gamma')
        self.assertEqual((len(zeta), len(gamma)), (1, 1))
        self.assertGreaterEqual(gamma[0][0] - zeta[0][2], 1.2)


class WordPlacementTests(unittest.TestCase):
    def test_equal_word_count_reuses_original_word_positions(self):
        raw = _single_span_pdf('The value was 0.20 in total.')
        before = 'value was 0.20'
        after = 'ratio was 0.62'
        result = mutate_pdf_text_spans(raw, [{
            'id': 'justify-1',
            'kind': 'text-span',
            'pageIndex': 0,
            'before': before,
            'after': after,
        }])
        self.assertEqual(result['appliedCount'], 1)
        source = pymupdf.open(stream=raw, filetype='pdf')[0]
        out = pymupdf.open(stream=result['pdfBytes'], filetype='pdf')[0]
        orig = [w[0] for w in sorted(source.get_text('words'), key=lambda w: w[0]) if w[4] in before.split()]
        new = [_words(out, word) for word in after.split()]
        self.assertEqual(len(new), 3)
        for index, hits in enumerate(new):
            self.assertEqual(len(hits), 1)
            self.assertAlmostEqual(hits[0][0], orig[index], delta=0.5)
        self.assertGreaterEqual(result['changes'][0]['bbox'][2], new[-1][0][2] - 0.5)


class ExistingBehaviourTests(unittest.TestCase):
    def test_base14_replacement_still_applies(self):
        raw = _single_span_pdf('Primary cohort showed p = 0.04 in training.')
        result = mutate_pdf_text_spans(raw, [{
            'id': 'base14-1',
            'kind': 'text-span',
            'pageIndex': 0,
            'before': 'p = 0.04',
            'after': 'p = 0.05',
        }])
        self.assertEqual(result['appliedCount'], 1)
        page = pymupdf.open(stream=result['pdfBytes'], filetype='pdf')[0]
        self.assertIn('p = 0.05', page.get_text('text'))

    def test_empty_operation_list_is_a_no_op(self):
        raw = _single_span_pdf('Nothing changes here.')
        result = mutate_pdf_text_spans(raw, [])
        self.assertEqual(result['appliedCount'], 0)
        self.assertEqual(result['changes'], [])
        self.assertEqual(result['pdfBytes'], raw)

    def test_overlapping_operations_are_rejected(self):
        raw = _single_span_pdf('The value beta appears once.')
        op = {'id': 'dup', 'kind': 'text-span', 'pageIndex': 0, 'before': 'beta', 'after': 'zulu'}
        with self.assertRaises(SpanMutationError) as ctx:
            mutate_pdf_text_spans(raw, [{**op, 'id': 'dup-1'}, {**op, 'id': 'dup-2'}])
        self.assertEqual(ctx.exception.code, 'text_span_operations_overlap')


if __name__ == '__main__':
    unittest.main()
