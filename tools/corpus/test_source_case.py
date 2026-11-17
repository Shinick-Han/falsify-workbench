"""Tests for the falsify.source-case.v1 loader."""

import contextlib
import hashlib
import io
import json
import math
import os
import shutil
import subprocess
import tempfile
import unittest
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

import source_case
from source_case import SourceCaseError, init_case, list_bindings, load_case, resolve_case

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "rct_minimal"


def _copy_case(tmp):
    dest = Path(tmp) / "case"
    shutil.copytree(FIXTURE, dest)
    return dest


def _write(path, text):
    Path(path).write_text(text, encoding="utf-8", newline="\n")


def _replace(path, old, new):
    text = Path(path).read_text(encoding="utf-8")
    if old not in text:
        raise AssertionError(old)
    _write(path, text.replace(old, new, 1))


def _load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


class SourceCaseTests(unittest.TestCase):
    def test_fixture_validates_without_warnings(self):
        loaded = load_case(FIXTURE)
        self.assertEqual(loaded["warnings"], [])
        self.assertEqual(loaded["manifest"]["caseId"], "rct-minimal")
        self.assertTrue(loaded["manifest"]["synthetic"])
        self.assertIn("source/paper.tex", loaded["texts"])

    def test_bindings_are_ordered_and_cross_surface(self):
        bindings = list_bindings(FIXTURE)
        ordered = sorted(bindings, key=lambda item: (item["file"], item["line"], item["valueId"]))
        self.assertEqual(bindings, ordered)
        surfaces = defaultdict(set)
        for binding in bindings:
            self.assertFalse(Path(binding["file"]).is_absolute())
            surfaces[binding["valueId"]].add(binding["surface"])
        multi = [key for key, found in surfaces.items() if len(found) >= 3]
        self.assertGreaterEqual(len(multi), 6)
        for key in (
            "n_screened", "n_randomized", "n_alloc_fx", "n_alloc_pb",
            "n_analyzed_fx", "n_analyzed_pb", "chg_w8_fx", "chg_w8_pb",
        ):
            self.assertGreaterEqual(len(surfaces[key]), 3, key)
        tex = (FIXTURE / "source" / "paper.tex").read_text(encoding="utf-8")
        line_no = next(i for i, line in enumerate(tex.splitlines(), 1) if "{{v:n_screened}}" in line)
        found = [item for item in bindings if item["valueId"] == "n_screened" and item["line"] == line_no]
        self.assertEqual(found[0]["surface"], "tex:abstract")
        self.assertEqual(found[0]["file"], "source/paper.tex")
        self.assertTrue(any(item["valueId"] == "age_fx" and item["surface"] == "table:T1" for item in bindings))
        figures = (FIXTURE / "inputs" / "figures.json").read_text(encoding="utf-8")
        fig_line = next(i for i, line in enumerate(figures.splitlines(), 1) if "{{v:chg_w8_fx}}" in line)
        fig_hits = [
            item for item in bindings
            if item["valueId"] == "chg_w8_fx" and item["file"] == "inputs/figures.json" and item["line"] == fig_line
        ]
        self.assertEqual(fig_hits[0]["surface"], "figure:F1")

    def test_resolve_is_deterministic_and_closed(self):
        first = resolve_case(FIXTURE)
        second = resolve_case(FIXTURE)
        self.assertEqual(first, second)
        self.assertNotIn("{{v:", json.dumps(first))
        self.assertIn(r"\falsifytable{T1}", first["tex"])
        self.assertIn(r"\falsifyfigure{F1}", first["tex"])
        self.assertEqual(
            [item["key"] for item in first["references"]],
            ["hale2018", "okonkwo2020", "brant2021", "voss2019", "chen2022", "ibrahim2017"],
        )
        raw = (FIXTURE / "inputs" / "values.json").read_bytes().replace(b"\r\n", b"\n")
        self.assertEqual(first["inputHashes"]["inputs/values.json"], hashlib.sha256(raw).hexdigest())

    def test_figure_tokens_become_floats(self):
        resolved = resolve_case(FIXTURE)
        spec = resolved["figures"][0]["spec"]
        values = _load_json(FIXTURE / "inputs" / "values.json")["values"]
        series = {item["name"]: item["y"] for item in spec["series"]}
        self.assertEqual(series["FX-217"][0], float(values["chg_w4_fx"]["text"]))
        self.assertEqual(series["FX-217"][1], float(values["chg_w8_fx"]["text"]))
        self.assertEqual(series["Placebo"][0], float(values["chg_w4_pb"]["text"]))
        self.assertEqual(series["Placebo"][1], float(values["chg_w8_pb"]["text"]))
        self.assertTrue(all(isinstance(item, float) for item in series["FX-217"]))
        self.assertIsInstance(resolved["figures"][0]["caption"], str)
        table = next(item for item in resolved["tables"] if item["tableId"] == "T2")
        flat = [cell for row in table["rows"] for cell in row]
        self.assertTrue(any(isinstance(cell, str) and "-12.4" in cell for cell in flat))

    def test_surface_override_is_local(self):
        resolved = resolve_case(FIXTURE, [{
            "valueId": "n_randomized",
            "text": "999",
            "surfaces": ["tex:abstract"],
        }])
        abstract = _abstract(resolved["tex"])
        methods = _section(resolved["tex"], "Methods")
        self.assertIn("999", abstract)
        self.assertNotIn("240", abstract)
        self.assertIn("240", methods)
        self.assertNotIn("999", methods)
        rows = [item for item in resolved["bindings"] if item["valueId"] == "n_randomized"]
        by_surface = {item["surface"]: item["resolved"] for item in rows}
        self.assertEqual(by_surface["tex:abstract"], "999")
        self.assertEqual(by_surface["tex:methods"], "240")
        self.assertEqual(by_surface["tex:results"], "240")
        self.assertEqual(resolved["overridesApplied"], [{
            "valueId": "n_randomized",
            "surface": "tex:abstract",
            "before": "240",
            "after": "999",
        }])

    def test_star_override_covers_bound_surfaces(self):
        resolved = resolve_case(FIXTURE, [{
            "valueId": "n_randomized",
            "text": "999",
            "surfaces": "*",
        }])
        rows = [item for item in resolved["bindings"] if item["valueId"] == "n_randomized"]
        self.assertGreaterEqual(len(rows), 3)
        self.assertTrue(all(item["resolved"] == "999" for item in rows))
        screened = [item for item in resolved["bindings"] if item["valueId"] == "n_screened"]
        self.assertTrue(all(item["resolved"] == "300" for item in screened))
        applied = {item["surface"] for item in resolved["overridesApplied"]}
        self.assertEqual(applied, {item["surface"] for item in rows})
        self.assertTrue(all(item["before"] == "240" and item["after"] == "999" for item in resolved["overridesApplied"]))

    def test_fixture_arithmetic(self):
        payload = _load_json(FIXTURE / "inputs" / "values.json")["values"]
        numeric = {key: item for key, item in payload.items() if not key.startswith("ph_")}
        texts = {key: item["text"] for key, item in numeric.items()}
        values = {key: Decimal(item["text"]) for key, item in numeric.items()}
        self.assertEqual(values["n_excluded_ineligible"] + values["n_excluded_declined"], values["n_excluded"])
        self.assertEqual(values["n_screened"], values["n_excluded"] + values["n_randomized"])
        self.assertEqual(values["n_randomized"], values["n_alloc_fx"] + values["n_alloc_pb"])
        self.assertEqual(values["n_alloc_fx"], values["n_disc_fx"] + values["n_analyzed_fx"])
        self.assertEqual(values["n_alloc_pb"], values["n_disc_pb"] + values["n_analyzed_pb"])
        self.assertEqual(values["n_disc_fx"], values["n_disc_fx_ae"] + values["n_disc_fx_wd"])
        self.assertEqual(values["n_disc_pb"], values["n_disc_pb_ae"] + values["n_disc_pb_wd"])
        self.assertEqual(values["chg_w8_fx"] - values["chg_w8_pb"], values["diff_w8"])
        self.assertEqual(values["resp_fx_pct"] - values["resp_pb_pct"], values["resp_diff"])
        self._between(values, "chg_w8_fx", "chg_w8_fx_lo", "chg_w8_fx_hi")
        self._between(values, "chg_w8_pb", "chg_w8_pb_lo", "chg_w8_pb_hi")
        self._between(values, "diff_w8", "diff_w8_lo", "diff_w8_hi")
        self._percent(values, texts, "female_fx_k", "n_alloc_fx", "female_fx_pct")
        self._percent(values, texts, "female_pb_k", "n_alloc_pb", "female_pb_pct")
        self._percent(values, texts, "resp_fx_k", "n_analyzed_fx", "resp_fx_pct")
        self._percent(values, texts, "resp_pb_k", "n_analyzed_pb", "resp_pb_pct")
        self._percent(values, texts, "ae_fx_k", "n_analyzed_fx", "ae_fx_pct")
        self._percent(values, texts, "ae_pb_k", "n_analyzed_pb", "ae_pb_pct")

    def test_week8_intervals_match_normal_approximation(self):
        values = _load_json(FIXTURE / "inputs" / "values.json")["values"]
        fx = _reconstructed_ci(values, "chg_w8_fx", "chg_w8_fx_lo", "chg_w8_fx_hi")
        pb = _reconstructed_ci(values, "chg_w8_pb", "chg_w8_pb_lo", "chg_w8_pb_hi")
        diff = _reconstructed_ci(values, "diff_w8", "diff_w8_lo", "diff_w8_hi")
        self.assertEqual(fx["low"], values["chg_w8_fx_lo"]["text"])
        self.assertEqual(fx["high"], values["chg_w8_fx_hi"]["text"])
        self.assertEqual(pb["low"], values["chg_w8_pb_lo"]["text"])
        self.assertEqual(pb["high"], values["chg_w8_pb_hi"]["text"])
        self.assertEqual(diff["low"], values["diff_w8_lo"]["text"])
        self.assertEqual(diff["high"], values["diff_w8_hi"]["text"])
        places = _decimal_places(values["diff_w8"]["text"])
        self.assertEqual(f"{fx['point'] - pb['point']:.{places}f}", values["diff_w8"]["text"])
        se_diff = math.sqrt(fx["se"] ** 2 + pb["se"] ** 2)
        half = _NORMAL_95 * se_diff
        self.assertLessEqual(abs(diff["lo"] - (diff["point"] - half)), 0.1)
        self.assertLessEqual(abs(diff["hi"] - (diff["point"] + half)), 0.1)
        printed_p = values["p_primary"]["text"]
        z = abs(diff["point"]) / se_diff
        self.assertEqual(_expected_p_text(_two_sided_normal_p(z), printed_p), printed_p)
        self._assert_plausible_sd(fx["se"], values["n_analyzed_fx"]["text"])
        self._assert_plausible_sd(pb["se"], values["n_analyzed_pb"]["text"])

    def test_warnings_for_unused_and_unreferenced(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _copy_case(tmp)
            values = _load_json(case / "inputs" / "values.json")
            values["values"]["spare_count"] = {"text": "1", "note": "unused"}
            _write(case / "inputs" / "values.json", json.dumps(values, indent=2) + "\n")
            tex = (case / "source" / "paper.tex").read_text(encoding="utf-8")
            tex = tex.replace("\\falsifyfigure{F1}\n", "")
            tex = tex.replace("\\falsifytable{T1}\n", "")
            _write(case / "source" / "paper.tex", tex)
            loaded = load_case(case)
            found = {
                (item["code"], item.get("valueId") or item.get("tableId") or item.get("figureId"))
                for item in loaded["warnings"]
            }
            self.assertIn(("unused_value", "spare_count"), found)
            self.assertIn(("unreferenced_figure", "F1"), found)
            self.assertIn(("unreferenced_table", "T1"), found)

    def test_error_missing_file(self):
        self._raises("missing_file", self._drop_tex)

    def test_error_path_escape(self):
        for rel in ("../outside.tex", "C:/outside.tex", "/tmp/outside.tex", "inputs/../../outside.tex"):
            with self.subTest(rel=rel):
                self._raises("path_escape", lambda case, rel=rel: self._retarget_tex(case, rel))

    def test_error_symlink_escape(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _copy_case(tmp)
            outside = Path(tmp) / "outside-source"
            shutil.copytree(case / "source", outside)
            shutil.rmtree(case / "source")
            if not _link_dir(case / "source", outside):
                self.skipTest("symlink not permitted")
            with self.assertRaises(SourceCaseError) as caught:
                load_case(case)
            self.assertEqual(caught.exception.code, "path_escape")

    def test_error_schema_invalid(self):
        self._raises("schema_invalid", self._break_schema)

    def test_error_unknown_value(self):
        self._raises("unknown_value", lambda case: _replace(
            case / "source" / "paper.tex", "{{v:n_screened}}", "{{v:not_defined}}",
        ))

    def test_error_unbound_directive(self):
        self._raises("unbound_directive", lambda case: _replace(
            case / "source" / "paper.tex", r"\falsifytable{T1}", r"\falsifytable{T9}",
        ))

    def test_error_unknown_citation(self):
        self._raises("unknown_citation", lambda case: _replace(
            case / "source" / "paper.tex", r"\cite{hale2018,okonkwo2020}", r"\cite{hale2018,missingkey}",
        ))

    def test_error_forbidden_tex(self):
        self._raises("forbidden_tex", lambda case: _replace(
            case / "source" / "paper.tex", r"\end{document}", "\\input{secret}\n\\end{document}",
        ))

    def test_error_token_unresolved(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _copy_case(tmp)
            values = _load_json(case / "inputs" / "values.json")
            values["values"]["n_screened"]["text"] = "{{v:n_alloc_fx}}"
            _write(case / "inputs" / "values.json", json.dumps(values, indent=2) + "\n")
            with self.assertRaises(SourceCaseError) as caught:
                resolve_case(case)
            self.assertEqual(caught.exception.code, "token_unresolved")

    def test_error_override_unbound(self):
        with self.assertRaises(SourceCaseError) as caught:
            resolve_case(FIXTURE, [{"valueId": "n_screened", "text": "1", "surfaces": ["tex:title"]}])
        self.assertEqual(caught.exception.code, "override_unbound")
        with self.assertRaises(SourceCaseError) as caught:
            resolve_case(FIXTURE, [{"valueId": "not_defined", "text": "1", "surfaces": "*"}])
        self.assertEqual(caught.exception.code, "override_unbound")

    def test_error_override_conflict(self):
        overrides = [
            {"valueId": "n_screened", "text": "1", "surfaces": ["tex:abstract"]},
            {"valueId": "n_screened", "text": "2", "surfaces": "*"},
        ]
        with self.assertRaises(SourceCaseError) as caught:
            resolve_case(FIXTURE, overrides)
        self.assertEqual(caught.exception.code, "override_conflict")

    def test_init_case_writes_valid_skeleton(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "skel"
            created = init_case(dest, "skeleton-one")
            self.assertIn("case.json", created)
            self.assertTrue(all(not Path(rel).is_absolute() for rel in created))
            loaded = load_case(dest)
            self.assertEqual(loaded["warnings"], [])
            self.assertEqual(loaded["manifest"]["domain"], "clinical-rct")
            before = (dest / "case.json").read_text(encoding="utf-8")
            with self.assertRaises(SourceCaseError) as caught:
                init_case(dest, "skeleton-two")
            self.assertEqual(caught.exception.code, "schema_invalid")
            self.assertIn("directory not empty", str(caught.exception))
            self.assertEqual((dest / "case.json").read_text(encoding="utf-8"), before)

    def test_init_case_rejects_bad_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SourceCaseError) as caught:
                init_case(Path(tmp) / "bad", "Bad_Id")
            self.assertEqual(caught.exception.code, "schema_invalid")

    def test_cli_validate_and_usage(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = source_case.main(["validate", str(FIXTURE)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(buf.getvalue())["warnings"], [])
        self.assertNotIn(str(FIXTURE), buf.getvalue())
        self.assertEqual(source_case.main([]), 2)

    def _assert_plausible_sd(self, se, n_text):
        sd = se * math.sqrt(float(n_text))
        self.assertGreaterEqual(sd, 8)
        self.assertLessEqual(sd, 30)

    def _between(self, values, point, low, high):
        self.assertLessEqual(values[low], values[point])
        self.assertLessEqual(values[point], values[high])

    def _percent(self, values, texts, count, total, pct):
        places = 0 if "." not in texts[pct] else len(texts[pct].split(".")[1])
        quant = Decimal(1).scaleb(-places)
        computed = (values[count] / values[total] * Decimal(100)).quantize(quant)
        self.assertEqual(computed, values[pct])

    def _raises(self, code, mutate):
        with tempfile.TemporaryDirectory() as tmp:
            case = _copy_case(tmp)
            mutate(case)
            with self.assertRaises(SourceCaseError) as caught:
                load_case(case)
            self.assertEqual(caught.exception.code, code)

    def _drop_tex(self, case):
        (case / "source" / "paper.tex").unlink()

    def _retarget_tex(self, case, rel):
        data = _load_json(case / "case.json")
        data["files"]["tex"] = rel
        _write(case / "case.json", json.dumps(data, indent=2) + "\n")

    def _break_schema(self, case):
        data = _load_json(case / "case.json")
        data["schema"] = "falsify.nope"
        _write(case / "case.json", json.dumps(data, indent=2) + "\n")


def _link_dir(link, target):
    try:
        os.symlink(target, link, target_is_directory=True)
        return True
    except OSError:
        completed = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
        )
        return completed.returncode == 0 and link.exists()


_NORMAL_95 = 1.96


def _decimal_places(text):
    if "." not in text:
        return 0
    return len(text.split(".", 1)[1])


def _reconstructed_ci(values, point_key, lo_key, hi_key):
    point = float(values[point_key]["text"])
    lo = float(values[lo_key]["text"])
    hi = float(values[hi_key]["text"])
    se = (hi - lo) / (2.0 * _NORMAL_95)
    return {
        "point": point,
        "lo": lo,
        "hi": hi,
        "se": se,
        "low": f"{point - _NORMAL_95 * se:.{_decimal_places(values[lo_key]['text'])}f}",
        "high": f"{point + _NORMAL_95 * se:.{_decimal_places(values[hi_key]['text'])}f}",
    }


def _two_sided_normal_p(z):
    return math.erfc(z / math.sqrt(2.0))


def _expected_p_text(computed, printed):
    if computed < 0.001:
        return "<0.001"
    return f"{computed:.{_decimal_places(printed)}f}"


def _abstract(tex):
    return tex.split(r"\begin{abstract}", 1)[1].split(r"\end{abstract}", 1)[0]


def _section(tex, name):
    marker = "\\section{" + name + "}"
    rest = tex.split(marker, 1)[1]
    nxt = rest.find("\\section{")
    if nxt < 0:
        nxt = len(rest)
    return rest[:nxt]


if __name__ == "__main__":
    unittest.main()
