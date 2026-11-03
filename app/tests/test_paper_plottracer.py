import hashlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart
import paper_plottracer as plot


def fixture():
    im = Image.new('RGB', (640, 480), 'white')
    d = ImageDraw.Draw(im)
    d.line([(100, 100), (300, 250), (500, 400)], fill='#1f77b4', width=4)
    buf = io.BytesIO(); im.save(buf, format='PNG')
    png = buf.getvalue()
    options = {'imageSha256': hashlib.sha256(png).hexdigest(),
        'calibration': {'x': {'scale': 'linear', 'points': [{'pixel': 100, 'value': 0}, {'pixel': 500, 'value': 10}]},
                        'y': {'scale': 'linear', 'points': [{'pixel': 100, 'value': 0}, {'pixel': 400, 'value': -3}]}},
        'series': [{'id': 'blue', 'color': '#1f77b4', 'name': 'Trial'}], 'plotBbox': [90, 80, 520, 420]}
    return png, options


class PlotTracerTests(unittest.TestCase):
    def test_negative_curve_keeps_pixels_and_real_units(self):
        png, options = fixture()
        data = paper_chart.extract_chart(png, options={'chartOptions': options})
        self.assertIn(data['status'], ('ready', 'partial'))
        self.assertEqual(data['provenance']['engine'], 'plottracer')
        self.assertEqual(data['provenance']['revision'], plot.UPSTREAM)
        self.assertEqual(data['pointKind'], 'curve-sample')
        self.assertGreater(len(data['rows']), 20)
        series = data['geometry']['series'][0]
        point = min(series['points'], key=lambda p: abs(p['x']-5))
        self.assertAlmostEqual(point['y'], -1.5, delta=.05)
        self.assertAlmostEqual(point['xPixel'], 300, delta=4)
        self.assertTrue(all(cell['origin'] == 'pixel-calibrated' for cell in data['numericCells']))
        self.assertTrue(any(cell['value'] < -2.9 for cell in data['numericCells']))

    def test_missing_axes_never_loads_a_table_model(self):
        png, _ = fixture()
        with patch.object(paper_chart, 'default_engine', side_effect=AssertionError('model fallback')):
            result = paper_chart.extract_chart(png)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['rows'], [])
        self.assertTrue({'axis-calibration-required','plottracer-runtime-missing'} & set(result['issues']))

    def test_stale_image_is_rejected(self):
        png, options = fixture()
        options['imageSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'chart_image_mismatch'):
            plot.trace_geometry(png, manual=options)

    def test_actual_upstream_log_axis_conversion(self):
        _, options = fixture()
        calibration = options['calibration']
        calibration['y'] = {'scale': 'log', 'points': [{'pixel': 100, 'value': 1}, {'pixel': 400, 'value': 100}]}
        core = plot.Core()
        try:
            result = core.convert(calibration, [[300, 250]])
        finally:
            core.close()
        self.assertAlmostEqual(result[0][0], 5)
        self.assertAlmostEqual(result[0][1], 10)

    def test_invalid_log_values_and_duplicate_axes(self):
        _, options = fixture()
        options['calibration']['y']['scale'] = 'log'
        with self.assertRaisesRegex(ValueError, 'digitizer_axis_invalid'):
            plot.validate_options(options)
        _, options = fixture()
        options['calibration']['x']['points'][1]['pixel'] = 100
        with self.assertRaisesRegex(ValueError, 'digitizer_axis_invalid'):
            plot.validate_options(options)

    def test_curve_selection_does_not_accept_an_unbounded_list(self):
        _, options = fixture()
        options['series'] = [{'id': str(i), 'color': '#123456'} for i in range(9)]
        with self.assertRaisesRegex(ValueError, 'chart_series_invalid'):
            plot.validate_options(options)

    def test_upstream_same_color_curves_and_off_tick_peaks(self):
        try:
            import cv2
        except ImportError:
            self.skipTest('Optional automatic OCR/CV preparation is not installed')
        from test_paper_chart_trace_regressions import chart, BLUE
        def curves(d):
            d.line([(120,320),(240,240),(360,160),(480,80)],fill=BLUE,width=3)
            d.line([(120,360),(240,280),(360,200),(480,120)],fill=BLUE,width=3)
        png, lines = chart(curves)
        data = plot.trace_geometry(png, ocr_lines=lines)
        self.assertGreaterEqual(len(data['series']), 2, data['issues'])
        values = [min(s['points'],key=lambda p:abs(p['x']-2))['y'] for s in data['series']]
        self.assertTrue(any(abs(v-20)<1 for v in values), values)
        self.assertTrue(any(abs(v-14.142)<1 for v in values), values)
        def peaks(d):
            d.line([(120,320),(180,80),(300,320),(420,80),(480,200)],fill=BLUE,width=4)
        png, lines = chart(peaks)
        data = plot.trace_geometry(png, ocr_lines=lines)
        points = [p for s in data['series'] for p in s['points']]
        for x, y in [(1.5,80),(2.5,10),(3.5,80)]:
            self.assertTrue(any(abs(p['x']-x)<.08 and abs(p['y']/y-1)<.08 for p in points), (x,y,data['issues']))


if __name__ == '__main__':
    unittest.main()
