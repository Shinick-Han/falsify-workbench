"""Optional argument outlines on workspace triage and blue scan-workspace."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local"))
import falsify_cli  # noqa: E402
import paper_blue_sensor  # noqa: E402
import paper_evidence  # noqa: E402
import paper_mcp_workspace  # noqa: E402

ALPHA = (
    "Abstract",
    "The apparatus was calibrated before the first measurement.",
)
BETA = (
    "Abstract",
    "The response rate was 40% in the enrolled cohort overall across follow-up.",
    "Results",
    "Adverse events were similar between arms and no serious events were attributed to study treatment.",
    "Discussion",
    "The cohort completed follow-up and investigators recorded outcomes on the prespecified form today.",
)
RANK_KEYS = {
    "paperId", "name", "totalSignals", "byFamily",
    "pairedSupplementCount", "priorityScore",
}


def _write_pdf(path, lines):
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=595, height=842)
        y_pos = 72
        for line in lines:
            page.insert_text((72, y_pos), line, fontsize=11)
            y_pos += 16
        path.write_bytes(doc.tobytes())
    finally:
        doc.close()


def _workspace(root):
    _write_pdf(root / "alpha.pdf", ALPHA)
    _write_pdf(root / "beta.pdf", BETA)


def _triage(root, store, **kwargs):
    options = {
        "max_signals_per_paper": 25,
        "include_figure_forensics": False,
        "recompute_raw": False,
        "include_flow_triage": False,
        "include_internal_consistency": False,
        "store": store,
    }
    options.update(kwargs)
    return paper_mcp_workspace.triage_workspace(root, **options)


def _run_cli(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = falsify_cli.main(argv)
    return code, json.loads(buf.getvalue())


def _without_ids(result):
    papers = []
    for item in result["rankedPapers"]:
        papers.append({key: value for key, value in item.items() if key != "paperId"})
    return sorted(papers, key=lambda item: item["name"])


class WorkspaceArgumentOutlineTests(unittest.TestCase):
    def test_flag_off_omits_outline_and_flag_on_matches_compact_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _workspace(root)
            store = paper_evidence.EvidenceStore(max_documents=4)
            off = _triage(root, store)
            on_store = paper_evidence.EvidenceStore(max_documents=4)
            on = _triage(root, on_store, include_argument_outline=True)
            self.assertEqual({item["name"] for item in off["rankedPapers"]}, {"alpha.pdf", "beta.pdf"})
            for item in off["rankedPapers"]:
                self.assertEqual(set(item), RANK_KEYS)
            off_body = _without_ids(off)
            on_body = _without_ids(on)
            for item in on_body:
                self.assertIn("argumentOutline", item)
            stripped = [{key: value for key, value in item.items() if key != "argumentOutline"} for item in on_body]
            self.assertEqual(stripped, off_body)
            blob = json.dumps(on)
            self.assertNotIn(str(root), blob)
            self.assertNotIn("claimEvidenceMap", blob)
            by_name = {item["name"]: item for item in on["rankedPapers"]}
            for name, item in by_name.items():
                sensor = paper_blue_sensor.run_blue_sensor(
                    item["paperId"],
                    max_signals=25,
                    include_argument_outline=True,
                    include_figure_forensics=False,
                    include_flow_triage=False,
                    include_internal_consistency=False,
                    store=on_store,
                )
                expected = falsify_cli._compact_argument_outline(sensor["argumentOutline"])
                pack = item["argumentOutline"]
                self.assertEqual(pack, expected)
                self.assertEqual(pack["schema"], "falsify.argument-outline.v1")
                self.assertEqual(pack["signalCount"], 0)
                self.assertNotIn("outline", pack)
                self.assertNotIn("claimEvidenceMap", pack)
                self.assertLessEqual(len(pack.get("digest") or ""), 400)
                self.assertLessEqual(len(pack.get("triageHints") or []), 5)
                self.assertTrue(all(hint.get("advisoryOnly") is True for hint in pack["triageHints"]))
            self.assertTrue(by_name["beta.pdf"]["argumentOutline"]["triageHints"])

    def test_cache_misses_when_outline_flag_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            papers = root / "papers"
            papers.mkdir()
            _workspace(papers)
            cache_dir = root / "cache"
            common = {
                "include_figure_forensics": False,
                "recompute_raw": False,
                "include_flow_triage": False,
                "include_internal_consistency": False,
                "cache_dir": cache_dir,
            }
            first = paper_mcp_workspace.triage_workspace(
                papers, store=paper_evidence.EvidenceStore(max_documents=4), **common)
            second = paper_mcp_workspace.triage_workspace(
                papers, include_argument_outline=True,
                store=paper_evidence.EvidenceStore(max_documents=4), **common)
            third = paper_mcp_workspace.triage_workspace(
                papers, include_argument_outline=True,
                store=paper_evidence.EvidenceStore(max_documents=4), **common)
            fourth = paper_mcp_workspace.triage_workspace(
                papers, store=paper_evidence.EvidenceStore(max_documents=4), **common)
            self.assertEqual(first["cacheStats"]["hits"], 0)
            self.assertGreaterEqual(first["cacheStats"]["misses"], 1)
            self.assertTrue(all("argumentOutline" not in item for item in first["rankedPapers"]))
            self.assertEqual(second["cacheStats"]["hits"], 0)
            self.assertGreaterEqual(second["cacheStats"]["misses"], 1)
            self.assertTrue(all("argumentOutline" in item for item in second["rankedPapers"]))
            self.assertGreaterEqual(third["cacheStats"]["hits"], 1)
            self.assertEqual(
                [item["argumentOutline"] for item in third["rankedPapers"]],
                [item["argumentOutline"] for item in second["rankedPapers"]],
            )
            self.assertGreaterEqual(fourth["cacheStats"]["hits"], 1)
            self.assertTrue(all("argumentOutline" not in item for item in fourth["rankedPapers"]))
            self.assertNotIn(str(root), json.dumps(second))

    def test_cli_flag_and_manuscript_date_stays_on_blue_scan(self):
        usage = [line for line in falsify_cli.__doc__.splitlines() if "scan-workspace" in line]
        self.assertEqual(len(usage), 1)
        self.assertIn("--argument-outline", usage[0])
        self.assertNotIn("--manuscript-date", usage[0])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _workspace(root)
            off_code, off = _run_cli(["blue", "scan-workspace", "--workspace", str(root), "--no-recompute-raw", "--no-flow-triage", "--no-internal-consistency"])
            on_code, on = _run_cli(["blue", "scan-workspace", "--workspace", str(root), "--argument-outline", "--no-recompute-raw", "--no-flow-triage", "--no-internal-consistency"])
            self.assertEqual(off_code, 0)
            self.assertEqual(on_code, 0)
            self.assertTrue(all("argumentOutline" not in item for item in off["triage"]["rankedPapers"]))
            self.assertTrue(all(item["argumentOutline"]["schema"] == "falsify.argument-outline.v1" for item in on["triage"]["rankedPapers"]))
            self.assertNotIn(str(root), json.dumps(on))
            dated_code, dated = _run_cli(["blue", "scan-workspace", "--workspace", str(root), "--manuscript-date", "2020-01-01"])
            self.assertEqual(dated_code, 2)
            self.assertEqual(dated["error"], "invalid_arguments")
            self.assertIn("manuscript-date", dated["message"])
            self.assertNotIn("triage", dated)


if __name__ == "__main__":
    unittest.main()
