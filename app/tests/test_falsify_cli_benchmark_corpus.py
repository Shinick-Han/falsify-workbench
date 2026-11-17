"""Corpus version wiring for `falsify arena benchmark`."""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

_HERE = Path(__file__).resolve()
_LOCAL = _HERE.parents[1] / "local"
_EVAL = _HERE.parents[2] / "tools" / "evaluation"
for _path in (str(_LOCAL), str(_EVAL)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import benchmark_source_cases as source_cases  # noqa: E402
import benchmark_suite  # noqa: E402
import falsify_cli  # noqa: E402

_ONE_CASE = "gold-w1-d1-stat-pvalue"


def _run(argv: list[str]) -> tuple[int, dict]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = falsify_cli.main(argv)
    raw = buf.getvalue().strip()
    payload = json.loads(raw) if raw else {}
    return code, payload


class BenchmarkCorpusCliTests(unittest.TestCase):
    def test_usage_lists_corpus_flags(self):
        usage = falsify_cli.__doc__ or ""
        self.assertIn("--corpus-version v4|v5", usage)
        self.assertIn("--fixtures-root DIR", usage)
        self.assertIn("--no-source-cases", usage)

    def test_parser_defaults_to_v4(self):
        args = falsify_cli._build_parser().parse_args(["arena", "benchmark"])
        self.assertEqual(args.corpus_version, "v4")
        self.assertIsNone(args.fixtures_root)
        self.assertFalse(args.no_source_cases)

    def test_request_helper_defaults_and_rejects(self):
        default = falsify_cli._benchmark_corpus_request(SimpleNamespace())
        self.assertEqual(default["corpus_version"], "v4")
        self.assertIsNone(default["include_source_cases"])
        self.assertIsNone(default["fixtures_root"])
        excluded = falsify_cli._benchmark_corpus_request(SimpleNamespace(
            corpus_version="v5",
            no_source_cases=True,
            fixtures_root="fixtures",
        ))
        self.assertEqual(excluded, {
            "corpus_version": "v5",
            "include_source_cases": False,
            "fixtures_root": "fixtures",
        })
        with self.assertRaises(falsify_cli._CliError) as caught:
            falsify_cli._benchmark_corpus_request(SimpleNamespace(corpus_version="v3"))
        self.assertEqual(caught.exception.exit_code, 2)
        self.assertEqual(caught.exception.code, "invalid_arguments")

    def test_default_command_stays_on_v4(self):
        code, payload = _run(["arena", "benchmark", "--case", _ONE_CASE])
        self.assertEqual(code, 0, payload.get("message"))
        bench = payload["benchmark"]
        self.assertEqual(bench["corpusVersion"], "v4")
        self.assertEqual(bench["caseCount"], 1)
        self.assertEqual(bench["caseResults"][0]["caseId"], _ONE_CASE)
        self.assertNotIn("sourceCases", bench)

    def test_v5_without_source_cases_records_exclusion(self):
        code, payload = _run([
            "arena", "benchmark",
            "--corpus-version", "v5",
            "--no-source-cases",
            "--case", _ONE_CASE,
        ])
        self.assertEqual(code, 0, payload.get("message"))
        bench = payload["benchmark"]
        self.assertEqual(bench["corpusVersion"], "v5")
        self.assertEqual(bench["caseCount"], 1)
        self.assertEqual(bench["sourceCases"], {
            "built": [],
            "refused": [],
            "skipped": [{"reason": "excluded"}],
        })

    def test_invalid_corpus_version_exits_2(self):
        code, payload = _run(["arena", "benchmark", "--corpus-version", "v9"])
        self.assertEqual(code, 2)
        self.assertEqual(payload.get("error"), "invalid_arguments")

    def test_v5_missing_toolchain_skips_and_passes_fixtures_root(self):
        seen = []
        original = source_cases.load_source_cases

        def record(root=None):
            seen.append(root)
            return original(root)

        saved = dict(source_cases._CACHE)
        source_cases._CACHE.clear()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                with (
                    patch.object(
                        source_cases, "_toolchain_gaps",
                        lambda: ["pdflatex_missing", "matplotlib_missing"],
                    ),
                    patch.object(source_cases, "load_source_cases", record),
                    patch.object(benchmark_suite, "_evaluate_case", lambda *_args, **_kwargs: {}),
                ):
                    code, payload = _run([
                        "arena", "benchmark",
                        "--mode", "sensor",
                        "--corpus-version", "v5",
                        "--fixtures-root", tmp,
                    ])
        finally:
            source_cases._CACHE.clear()
            source_cases._CACHE.update(saved)
        self.assertEqual(code, 0, payload.get("message"))
        bench = payload["benchmark"]
        self.assertEqual(bench["corpusVersion"], "v5")
        self.assertEqual(bench["caseCount"], 32)
        self.assertEqual(bench["sourceCases"]["built"], [])
        self.assertEqual(bench["sourceCases"]["refused"], [])
        self.assertEqual(bench["sourceCases"]["skipped"], [
            {"reason": "pdflatex_missing"},
            {"reason": "matplotlib_missing"},
        ])
        self.assertEqual(len(seen), 1)
        self.assertEqual(
            os.path.normcase(os.path.abspath(seen[0])),
            os.path.normcase(os.path.abspath(tmp)),
        )


if __name__ == "__main__":
    unittest.main()
