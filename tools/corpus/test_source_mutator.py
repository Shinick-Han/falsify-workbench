"""Tests for the source mutator, its ledger, and the fixture mutation sets."""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest import mock

CORPUS = Path(__file__).resolve().parent
EVAL = CORPUS.parents[0] / "evaluation"
for entry in (EVAL, CORPUS):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

import arena_runner
import source_mutator
from render import RenderError, find_engine
from source_case import list_bindings, load_case
from source_mutator import (
    MINIMIZE_LIMITATION,
    REMOVE_HEDGE,
    STRENGTHEN_CLAIM,
    MutationError,
    build_twin,
    load_spec,
    plan_mutations,
)

FIXTURE = CORPUS / "fixtures" / "rct_minimal"
SCRIPT = CORPUS / "source_mutator.py"
MUTATIONS = FIXTURE / "mutations"
_SECRET_KEYS = {"before", "after", "rationale", "defectId", "operationId", "overridesApplied"}
_LEDGER_KEYS = {
    "schema", "paperId", "sourceSha256", "blindPdfSha256", "stealthPass", "producer",
    "caseId", "mutationSetId", "defects",
}
_DEFECT_KEYS = {
    "defectId", "operationId", "kind", "pageIndex", "bbox", "itemId", "supplementName",
    "before", "after", "quote", "location", "world", "family", "difficulty", "rationale",
    "stealthStatus", "source",
}
_SOURCE_KEYS = {"valueId", "operator", "changedSurfaces", "unchangedSurfaces", "contexts"}


def _values():
    payload = json.loads((FIXTURE / "inputs" / "values.json").read_text(encoding="utf-8"))
    return payload["values"]


def _value(value_id):
    return _values()[value_id]["text"]


def _other(value_id):
    return _value(value_id) + "9"


def _surfaces(value_id, case=FIXTURE):
    found = []
    for item in list_bindings(case):
        if item["valueId"] == value_id and item["surface"] not in found:
            found.append(item["surface"])
    return found


def _spec(mutations, set_id="m-test"):
    return {
        "schema": "falsify.source-mutation.v1",
        "caseId": "rct-minimal",
        "mutationSetId": set_id,
        "mutations": mutations,
    }


def _mut(operator, value_id, surfaces="*", **extra):
    item = {
        "defectId": extra.pop("defectId", "d1"),
        "operator": operator,
        "valueId": value_id,
        "surfaces": surfaces,
        "family": extra.pop("family", "D1"),
        "difficulty": extra.pop("difficulty", "L1"),
        "rationale": extra.pop("rationale", "Synthetic mutation for the unit test."),
    }
    item.update(extra)
    return item


def _places(text):
    if "." not in text:
        return 0
    return len(text.split(".", 1)[1])


def _copy_case(tmp):
    dest = Path(tmp) / "case"
    shutil.copytree(FIXTURE, dest)
    return dest


def _set_value(case, value_id, text):
    path = case / "inputs" / "values.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["values"][value_id]["text"] = text
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8", newline="\n")


def _load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _walk_keys(node, found):
    if isinstance(node, dict):
        for key, value in node.items():
            found.add(key)
            _walk_keys(value, found)
        return
    if isinstance(node, list):
        for value in node:
            _walk_keys(value, found)


def _outside_text(root):
    sealed = root / "sealed"
    for path in root.rglob("*"):
        if not path.is_file() or sealed in path.parents:
            continue
        if path.suffix.lower() in {".png", ".pdf"}:
            continue
        yield path


def _first_swap(text):
    chars = list(text)
    indexes = [index for index, char in enumerate(chars) if char.isdigit()]
    for pos in range(len(indexes) - 1):
        left, right = indexes[pos], indexes[pos + 1]
        if chars[left] == chars[right]:
            continue
        swapped = list(chars)
        swapped[left], swapped[right] = swapped[right], swapped[left]
        candidate = "".join(swapped)
        body = candidate[1:] if candidate.startswith("-") else candidate
        integer = body.split(".", 1)[0]
        if len(integer) > 1 and integer.startswith("0"):
            continue
        return candidate
    return None


class PhraseBindingTests(unittest.TestCase):
    def test_phrase_values_bind_in_the_discussion(self):
        loaded = load_case(FIXTURE)
        self.assertEqual(loaded["warnings"], [])
        for value_id in ("ph_concl_claim", "ph_hedge", "ph_limitation"):
            self.assertEqual(_surfaces(value_id), ["tex:discussion"])
            self.assertLessEqual(len(_value(value_id)), 240)

    def test_rule_tables_have_six_rules(self):
        self.assertGreaterEqual(len(STRENGTHEN_CLAIM), 6)
        self.assertGreaterEqual(len(REMOVE_HEDGE), 6)
        self.assertGreaterEqual(len(MINIMIZE_LIMITATION), 6)


class OperatorTests(unittest.TestCase):
    def test_set_text_partial_surfaces_are_exact(self):
        spec = _spec([_mut("set_text", "p_primary", ["tex:abstract"], text=_other("p_primary"))])
        defect = plan_mutations(FIXTURE, spec)["defects"][0]
        self.assertEqual(defect["after"], _other("p_primary"))
        self.assertEqual(defect["before"], _value("p_primary"))
        self.assertEqual(defect["changedSurfaces"], ["tex:abstract"])
        unchanged = [item for item in _surfaces("p_primary") if item != "tex:abstract"]
        self.assertEqual(defect["unchangedSurfaces"], unchanged)
        self.assertTrue(unchanged)

    def test_star_leaves_unchanged_empty(self):
        spec = _spec([_mut("set_text", "diff_w8", text=_other("diff_w8"))])
        defect = plan_mutations(FIXTURE, spec)["defects"][0]
        self.assertEqual(defect["changedSurfaces"], _surfaces("diff_w8"))
        self.assertEqual(defect["unchangedSurfaces"], [])

    def test_shift_number_keeps_decimals(self):
        before = _value("age_fx")
        spec = _spec([_mut("shift_number", "age_fx", [_surfaces("age_fx")[0]], delta=1)])
        after = plan_mutations(FIXTURE, spec)["defects"][0]["after"]
        self.assertEqual(Decimal(after), Decimal(before) + 1)
        self.assertEqual(_places(after), _places(before))
        self.assertNotIn("\u2212", after)

    def test_scale_number(self):
        before = _value("n_screened")
        spec = _spec([_mut("scale_number", "n_screened", ["tex:methods"], factor=2)])
        after = plan_mutations(FIXTURE, spec)["defects"][0]["after"]
        self.assertEqual(Decimal(after), Decimal(before) * 2)
        self.assertEqual(_places(after), _places(before))

    def test_transpose_digits(self):
        before = _value("n_randomized")
        spec = _spec([_mut("transpose_digits", "n_randomized", ["tex:abstract"])])
        after = plan_mutations(FIXTURE, spec)["defects"][0]["after"]
        self.assertEqual(after, _first_swap(before))
        self.assertNotEqual(after, before)

    def test_swap_values_writes_two_overrides(self):
        spec = _spec([_mut(
            "swap_values", "p_primary", ["tex:abstract"], withValueId="n_analyzed_fx",
        )])
        plan = plan_mutations(FIXTURE, spec)
        self.assertEqual(plan["overrides"], [
            {"valueId": "p_primary", "text": _value("n_analyzed_fx"), "surfaces": ["tex:abstract"]},
            {"valueId": "n_analyzed_fx", "text": _value("p_primary"), "surfaces": ["tex:abstract"]},
        ])
        defect = plan["defects"][0]
        self.assertEqual(defect["overrideIndexes"], [0, 1])
        self.assertEqual(defect["before"], _value("p_primary"))
        self.assertEqual(defect["after"], _value("n_analyzed_fx"))
        self.assertEqual(defect["changedSurfaces"], ["tex:abstract"])

    def test_set_phrase_and_templates(self):
        replacement = "A plain rewritten claim for this synthetic paper."
        phrase = _spec([_mut(
            "set_phrase", "ph_concl_claim", text=replacement, family="S1",
        )])
        self.assertEqual(plan_mutations(FIXTURE, phrase)["defects"][0]["after"], replacement)
        strengthen = _spec([_mut(
            "apply_template", "ph_concl_claim", template="strengthen_claim", family="S1",
        )])
        strengthened = plan_mutations(FIXTURE, strengthen)["defects"][0]["after"]
        self.assertEqual(strengthened, _value("ph_concl_claim").replace("was associated with", "caused"))
        hedge = _spec([_mut(
            "apply_template", "ph_hedge", template="remove_hedge", family="S1",
        )])
        removed = plan_mutations(FIXTURE, hedge)["defects"][0]["after"]
        self.assertEqual(removed, re.sub(r"\s+", " ", _value("ph_hedge").replace("possibly", "")).strip())
        limit = _spec([_mut(
            "apply_template", "ph_limitation", template="minimize_limitation", family="D3",
        )])
        minimized = plan_mutations(FIXTURE, limit)["defects"][0]["after"]
        self.assertEqual(minimized, _value("ph_limitation").replace("is limited by", "is unaffected by"))

    def test_not_numeric(self):
        shift = _spec([_mut("shift_number", "ph_concl_claim", delta=1, family="S1")])
        figure = _spec([_mut("set_text", "chg_w8_fx", ["figure:F1"], text="wide")])
        for spec in (shift, figure):
            with self.assertRaises(MutationError) as caught:
                plan_mutations(FIXTURE, spec)
            self.assertEqual(caught.exception.code, "not_numeric")

    def test_no_change(self):
        same = _spec([_mut("set_text", "p_primary", ["tex:abstract"], text=_value("p_primary"))])
        zero = _spec([_mut("shift_number", "n_screened", ["tex:methods"], delta=0)])
        for spec in (same, zero):
            with self.assertRaises(MutationError) as caught:
                plan_mutations(FIXTURE, spec)
            self.assertEqual(caught.exception.code, "no_change")
        with tempfile.TemporaryDirectory() as tmp:
            case = _copy_case(tmp)
            _set_value(case, "n_screened", "100")
            stuck = _spec([_mut("transpose_digits", "n_screened", ["tex:methods"])])
            with self.assertRaises(MutationError) as caught:
                plan_mutations(case, stuck)
            self.assertEqual(caught.exception.code, "no_change")

    def test_surface_unbound_and_unknown_value(self):
        missing = _spec([_mut("set_text", "not_a_value", text="1")])
        unbound = _spec([_mut("set_text", "p_primary", ["tex:title"], text=_other("p_primary"))])
        with self.assertRaises(MutationError) as unknown:
            plan_mutations(FIXTURE, missing)
        self.assertEqual(unknown.exception.code, "unknown_value")
        with self.assertRaises(MutationError) as surface:
            plan_mutations(FIXTURE, unbound)
        self.assertEqual(surface.exception.code, "surface_unbound")

    def test_template_no_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            case = _copy_case(tmp)
            _set_value(case, "ph_hedge", "Sites named here are imaginary.")
            spec = _spec([_mut(
                "apply_template", "ph_hedge", template="remove_hedge", family="S1",
            )])
            with self.assertRaises(MutationError) as caught:
                plan_mutations(case, spec)
            self.assertEqual(caught.exception.code, "template_no_match")

    def test_duplicate_conflict_and_unknown_operator(self):
        duplicate = _spec([
            _mut("set_text", "p_primary", ["tex:abstract"], text=_other("p_primary"), defectId="same-id"),
            _mut("set_text", "n_screened", ["tex:methods"], text=_other("n_screened"), defectId="same-id"),
        ])
        conflict = _spec([
            _mut("set_text", "p_primary", ["tex:abstract"], text=_other("p_primary"), defectId="one-id"),
            _mut("set_text", "p_primary", ["tex:abstract"], text=_other("n_screened"), defectId="two-id"),
        ])
        unknown = _spec([_mut("set_text", "p_primary", ["tex:abstract"], text=_other("p_primary"))])
        unknown["mutations"][0]["operator"] = "frobnicate"
        with self.assertRaises(MutationError) as dup:
            plan_mutations(FIXTURE, duplicate)
        self.assertEqual(dup.exception.code, "duplicate_defect")
        with self.assertRaises(MutationError) as clash:
            plan_mutations(FIXTURE, conflict)
        self.assertEqual(clash.exception.code, "conflict")
        with self.assertRaises(MutationError) as bad:
            plan_mutations(FIXTURE, unknown)
        self.assertEqual(bad.exception.code, "unknown_operator")

    def test_phrase_family_restriction(self):
        wrong_family = _spec([_mut(
            "set_phrase", "ph_concl_claim", text="A different synthetic claim.", family="D1",
        )])
        numeric = _spec([_mut("set_phrase", "p_primary", text="0.2", family="S1")])
        template = _spec([_mut(
            "apply_template", "n_screened", template="remove_hedge", family="S1",
        )])
        for spec in (wrong_family, numeric, template):
            with self.assertRaises(MutationError) as caught:
                plan_mutations(FIXTURE, spec)
            self.assertEqual(caught.exception.code, "schema_invalid")


class BuildTests(unittest.TestCase):
    def test_fixture_sets_match_their_surfaces(self):
        expected = {
            "m01-abstract-p.json": ["paper.tex"],
            "m02-table-n.json": ["paper.tex"],
            "m03-figure-y.json": ["figures/F1.png"],
            "m04-all-estimate.json": ["paper.tex"],
            "m05-strengthen-claim.json": ["paper.tex"],
            "m06-minimize-limitation.json": ["paper.tex"],
            "m07-remove-hedge.json": ["paper.tex"],
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in sorted(expected):
                self._assert_set(root / name, MUTATIONS / name, expected[name])

    def _assert_set(self, out, spec_path, changed):
        spec = load_spec(spec_path)
        summary = build_twin(FIXTURE, spec, out, compile_pdf=False)
        self.assertEqual(summary["changedFiles"], changed)
        self.assertEqual(summary["modelCalls"], 0)
        self.assertFalse(summary["compiled"])
        ledger = _load(out / "sealed" / "gold-ledger.json")
        mutation = spec["mutations"][0]
        defect = ledger["defects"][0]
        self.assertEqual(defect["after"], _load(out / "sealed" / "mutation-plan.json")["defects"][0]["after"])
        self.assertTrue(_DEFECT_KEYS <= set(defect))
        self.assertTrue(_SOURCE_KEYS <= set(defect["source"]))
        self.assertEqual(defect["source"]["changedSurfaces"], _expected_changed(mutation))
        self.assertIsNone(ledger["sourceSha256"])
        self.assertIsNone(defect["pageIndex"])
        self.assertEqual(defect["stealthStatus"], "not_audited")

    def test_layout_ledger_blindness_and_arena_match(self):
        spec = load_spec(MUTATIONS / "m01-abstract-p.json")
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            summary = build_twin(FIXTURE, spec, out, compile_pdf=False)
            self._assert_layout(out, summary)
            ledger = _load(out / "sealed" / "gold-ledger.json")
            self._assert_ledger(ledger, spec)
            self._assert_blind(out, ledger)
            self._assert_arena(ledger)

    def _assert_layout(self, out, summary):
        self.assertTrue((out / "clean" / "paper.tex").is_file())
        self.assertTrue((out / "defect" / "paper.tex").is_file())
        self.assertTrue((out / "clean" / "figures" / "F1.png").is_file())
        self.assertTrue((out / "defect" / "figures" / "F1.png").is_file())
        self.assertTrue((out / "twin.json").is_file())
        self.assertTrue((out / "sealed" / "gold-ledger.json").is_file())
        self.assertTrue((out / "sealed" / "mutation-plan.json").is_file())
        self.assertFalse((out / "paper.pdf").exists())
        twin = _load(out / "twin.json")
        self.assertEqual(twin["schema"], "falsify.source-twin.v1")
        self.assertEqual(twin["changedFiles"], summary["changedFiles"])
        self.assertNotIn("overridesApplied", twin["clean"])
        self.assertNotIn("overridesApplied", twin["defect"])
        self.assertIsInstance(twin["clean"]["overridesAppliedCount"], int)
        self.assertIsInstance(twin["defect"]["overridesAppliedCount"], int)
        self.assertGreater(twin["defect"]["overridesAppliedCount"], 0)

    def _assert_ledger(self, ledger, spec):
        self.assertTrue(_LEDGER_KEYS <= set(ledger))
        self.assertEqual(ledger["schema"], "falsify.red-gold-ledger.v1")
        self.assertEqual(ledger["producer"], "source-native")
        self.assertIsNone(ledger["stealthPass"])
        self.assertEqual(ledger["paperId"], spec["caseId"])
        defect = ledger["defects"][0]
        mutation = spec["mutations"][0]
        self.assertEqual(defect["defectId"], mutation["defectId"])
        self.assertEqual(defect["operationId"], mutation["defectId"])
        self.assertEqual(defect["kind"], "source-value")
        self.assertEqual(defect["after"], mutation["text"])
        self.assertIn(mutation["text"], defect["quote"])
        self.assertEqual(defect["location"], "abstract")
        self.assertEqual(defect["source"]["valueId"], "p_primary")
        context = defect["source"]["contexts"][0]
        self.assertEqual(context["surface"], "tex:abstract")
        self.assertEqual(len(defect["source"]["contexts"]), 1)
        self.assertNotIn("\\", context["after"])

    def test_table_mutation_records_every_changed_row(self):
        spec = load_spec(MUTATIONS / "m02-table-n.json")
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            build_twin(FIXTURE, spec, out, compile_pdf=False)
            contexts = _load(out / "sealed" / "gold-ledger.json")["defects"][0]["source"]["contexts"]
            self.assertEqual([item["surface"] for item in contexts], ["table:T2", "table:T2", "table:T2"])
            self.assertIn("(n=90)", contexts[0]["after"])
            self.assertIn("45/90", contexts[1]["after"])
            self.assertIn("20/90", contexts[2]["after"])
            self.assertIn("\u2014", contexts[2]["after"])
            self.assertNotIn("---", contexts[2]["after"])

    def _assert_blind(self, out, ledger):
        secrets = [ledger["defects"][0]["defectId"], ledger["defects"][0]["rationale"]]
        for path in _outside_text(out):
            text = path.read_text(encoding="utf-8")
            for secret in secrets:
                self.assertNotIn(secret, text, path.name)
            if path.suffix.lower() == ".json":
                keys = set()
                _walk_keys(_load(path), keys)
                self.assertTrue(_SECRET_KEYS.isdisjoint(keys), path.name)

    def _assert_arena(self, ledger):
        quote = ledger["defects"][0]["quote"]
        hit = arena_runner.evaluate_arena_match(ledger, [_blue(quote)])
        self.assertEqual(hit["aggregate"]["tp"], 1)
        self.assertEqual(hit["aggregate"]["pureFp"], 0)
        miss = arena_runner.evaluate_arena_match(ledger, [_blue("zzzzz qqqqq vvvvv")])
        self.assertEqual(miss["aggregate"]["tp"], 0)
        self.assertEqual(miss["aggregate"]["pureFp"], 1)

    def test_diff_mismatch_leaves_no_sealed_directory(self):
        real = source_mutator.plan_mutations
        spec = _spec([_mut("set_text", "p_primary", ["tex:abstract"], text=_other("p_primary"))])
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            with mock.patch.object(source_mutator, "plan_mutations", side_effect=_extra(real)):
                with self.assertRaises(MutationError) as caught:
                    build_twin(FIXTURE, spec, out, compile_pdf=False)
            self.assertEqual(caught.exception.code, "diff_mismatch")
            self.assertFalse((out / "sealed").exists())
            self.assertTrue((out / "defect" / "paper.tex").is_file())


def _expected_changed(mutation):
    bound = _surfaces(mutation["valueId"])
    if mutation["surfaces"] == "*":
        return bound
    return list(mutation["surfaces"])


def _blue(quote):
    return {
        "runId": "blue-1",
        "agentId": "synthetic",
        "findings": [{"id": "f1", "decision": "defect", "quote": quote}],
    }


def _extra(real):
    def wrapped(case_dir, spec):
        plan = real(case_dir, spec)
        extra = {
            "valueId": "n_screened",
            "text": _other("n_screened"),
            "surfaces": ["tex:methods"],
        }
        plan["overrides"] = list(plan["overrides"]) + [extra]
        return plan
    return wrapped


class CliTests(unittest.TestCase):
    def test_plan_and_usage_exit_codes(self):
        spec = MUTATIONS / "m05-strengthen-claim.json"
        done = _cli(["plan", str(FIXTURE), "--spec", str(spec)])
        self.assertEqual(done.returncode, 0, done.stderr)
        payload = json.loads(done.stdout)
        self.assertEqual(payload["schema"], "falsify.source-mutation-plan.v1")
        self.assertNotIn("C:\\", done.stdout)
        usage = _cli(["plan"])
        self.assertEqual(usage.returncode, 2)
        missing = _cli(["plan", str(FIXTURE), "--spec", str(FIXTURE / "missing.json")])
        self.assertEqual(missing.returncode, 2)
        self.assertIn("schema_invalid", missing.stderr)

    def test_build_mismatch_and_timeout_exit_codes(self):
        spec = MUTATIONS / "m01-abstract-p.json"
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            code = source_mutator.main([
                "build", str(FIXTURE), "--spec", str(spec), "--out", str(out), "--no-compile",
            ])
            self.assertEqual(code, 0)
            self.assertTrue((out / "sealed" / "gold-ledger.json").is_file())
            real = source_mutator.plan_mutations
            with mock.patch.object(source_mutator, "plan_mutations", side_effect=_extra(real)):
                mismatch = source_mutator.main([
                    "build", str(FIXTURE), "--spec", str(spec),
                    "--out", str(Path(tmp) / "bad"), "--no-compile",
                ])
            self.assertEqual(mismatch, 3)
            self.assertFalse((Path(tmp) / "bad" / "sealed").exists())
        with mock.patch.object(
            source_mutator.render, "render_twin", side_effect=RenderError("compile_timeout", "pdflatex"),
        ):
            timed = source_mutator.main([
                "build", str(FIXTURE), "--spec", str(spec), "--out", str(Path(tempfile.gettempdir()) / "unused-out"),
            ])
        self.assertEqual(timed, 124)


def _cli(args):
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


@unittest.skipUnless(find_engine(), "pdflatex unavailable")
class PdfMutationTests(unittest.TestCase):
    def test_each_fixture_mutation_compiles(self):
        for spec_path in sorted(MUTATIONS.glob("*.json")):
            with self.subTest(spec=spec_path.name):
                self._assert_pdf(spec_path)

    def _assert_pdf(self, spec_path):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            summary = build_twin(FIXTURE, load_spec(spec_path), out, compile_pdf=True)
            self.assertTrue(summary["compiled"])
            self.assertTrue(summary["samePageCount"])
            self.assertEqual(summary["modelCalls"], 0)
            self.assertTrue((out / "clean" / "paper.pdf").is_file())
            self.assertTrue((out / "defect" / "paper.pdf").is_file())
            twin = _load(out / "twin.json")
            self.assertGreater(twin["clean"]["pageCount"], 0)
            self.assertEqual(twin["clean"]["pageCount"], twin["defect"]["pageCount"])
            ledger = _load(out / "sealed" / "gold-ledger.json")
            self.assertIsInstance(ledger["sourceSha256"], str)
            self.assertIsInstance(ledger["blindPdfSha256"], str)
            for defect in ledger["defects"]:
                self.assertIsInstance(defect["pageIndex"], int)


if __name__ == "__main__":
    unittest.main()
