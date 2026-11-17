"""Argument-outline auditor. Stdlib unittest only. No network."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

import pymupdf

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "app" / "local"))
import paper_argument_outline as audit
import paper_flow_and_spin_triage as spin
import paper_internal_consistency as consistency

MORTALITY = (
    "Mortality was 8.2% (p = 0.03) in the enrolled cohort overall across the prespecified follow-up."
)
BENIGN = [
    {"pageIndex": 0, "text": "Abstract\n" + MORTALITY},
    {
        "pageIndex": 1,
        "text": (
            "Introduction\n"
            "Patients in the treatment arm completed the planned follow-up without any protocol deviations today overall."
        ),
    },
    {"pageIndex": 2, "text": "Results\n" + MORTALITY},
    {
        "pageIndex": 3,
        "text": (
            "Discussion\n"
            "This study has several limitations including a single centre and a short follow-up period today."
        ),
    },
    {
        "pageIndex": 4,
        "text": (
            "Conclusion\n"
            "These findings suggest that treatment may be associated with a lower mortality in this cohort."
        ),
    },
]
IC_PAGES = [
    {"pageIndex": 0, "text": "Abstract\nMortality was 8.2% (p = 0.012)."},
    {"pageIndex": 1, "text": "Methods\nThe primary endpoint was 12-month mortality."},
    {"pageIndex": 2, "text": "Results\nMortality was 14.5% (p = 0.18)."},
    {
        "pageIndex": 3,
        "text": (
            "Discussion\n"
            "This study has several limitations including a single centre and a short follow-up period today."
        ),
    },
]
SPIN_PAGES = [
    {
        "pageIndex": 0,
        "text": (
            "Methods\n"
            "This retrospective single-arm study in mice was non-significant (p = 0.27).\n"
            "Conclusion\n"
            "The regimen proves that the drug eliminates mortality.\n"
            "Discussion\n"
            "This study has several limitations including a single centre and a short follow-up period today."
        ),
    },
]


def _kinds(report):
    return [hint["kind"] for hint in report["triageHints"]]


def _pdf(text):
    doc = pymupdf.open()
    try:
        page = doc.new_page(width=595, height=842)
        y_pos = 72
        for line in str(text).splitlines():
            if line.strip():
                page.insert_text((72, y_pos), line.strip(), fontsize=11)
                y_pos += 16
        return doc.tobytes()
    finally:
        doc.close()


def _overlong_paragraph():
    parts = []
    for index in range(9):
        parts.append(f"Sentence {index} records a complete observation for the reader today.")
    return " ".join(parts)


def _flag_text():
    paragraphs = [
        "Results",
        "",
        "However the opening claim of this results section still needs a clearer topic sentence today. Investigators recorded the cohort in the appendix.",
        "",
        "The drug lowered mortality in the primary cohort overall. However the control arm differed during follow-up today. In contrast the subgroup remained small and unstable.",
        "",
        "Prior reports described the cohort in detail [1] [2] [3] without a new measurement overall. The second sentence adds context for the reader today.",
        "",
        "Patients in the treatment arm completed the planned follow-up without any protocol deviations today overall.",
        "",
        "Patients who remained in the analytic cohort completed both scheduled visits. Investigators recorded outcomes on the prespecified form.",
        "",
        _overlong_paragraph(),
        "",
        "Discussion",
        "This study has several limitations including a single centre and a short follow-up period today.",
    ]
    return "\n".join(paragraphs)


def _by_prefix(report, prefix):
    for row in report["outline"]:
        if row["topicSentence"].startswith(prefix):
            return row
    raise AssertionError(prefix)


def _ccn_over(path):
    proc = subprocess.run(
        [sys.executable, str(REPO / "tools" / "quality" / "python-functions.py")],
        input=path.read_bytes(),
        capture_output=True,
        check=True,
    )
    functions = json.loads(proc.stdout.decode("utf-8"))
    return [f"{path.name}:{item['id']}:{item['ccn']}" for item in functions if item["ccn"] > 15]


class ArgumentOutlineTests(unittest.TestCase):
    def test_benign_paper_has_supported_claims_and_zero_hints(self):
        report = audit.audit_argument_outline(segments=BENIGN)
        self.assertEqual(report["schema"], audit.SCHEMA)
        self.assertEqual(report["signals"], [])
        self.assertEqual(report["triageHints"], [])
        self.assertEqual(report["hintCount"], 0)
        self.assertFalse(report["truncatedHints"])
        values = {row["value"]: row for row in report["claimEvidenceMap"]}
        self.assertEqual(values["8.2%"]["status"], "supported")
        self.assertEqual(values["0.03"]["status"], "supported")
        self.assertEqual(values["8.2%"]["evidencePageIndex"], 2)
        orphan = _by_prefix(report, "Patients in the treatment")
        self.assertEqual(orphan["flags"], ["orphan"])
        self.assertEqual(orphan["section"], "introduction")
        blob = json.dumps(report)
        self.assertNotIn("C:\\", blob)
        self.assertNotIn("C:/", blob)

    def test_each_outline_flag(self):
        report = audit.audit_argument_outline(segments=_flag_text())
        self.assertEqual(_by_prefix(report, "However the opening")["flags"], ["no_topic_sentence"])
        self.assertEqual(_by_prefix(report, "The drug lowered")["flags"], ["multi_pivot"])
        self.assertEqual(_by_prefix(report, "Prior reports described")["flags"], ["citation_dump"])
        self.assertEqual(_by_prefix(report, "Patients in the treatment")["flags"], ["orphan"])
        self.assertEqual(_by_prefix(report, "Patients who remained")["flags"], [])
        overlong = _by_prefix(report, "Sentence 0 records")
        self.assertEqual(overlong["flags"], ["overlong"])
        self.assertEqual(overlong["sentenceCount"], 9)
        self.assertNotIn("conclusion_claim_without_results_support", _kinds(report))

    def test_supported_unsupported_and_uncertain_claims(self):
        unsupported = [
            {
                "pageIndex": 0,
                "text": "Abstract\nThe response rate was 40% in the enrolled cohort overall across follow-up.",
            },
            {"pageIndex": 2, "text": "Results\n" + MORTALITY},
            {
                "pageIndex": 3,
                "text": "Discussion\nThis study has several limitations including a single centre and a short follow-up period today.",
            },
        ]
        report = audit.audit_argument_outline(segments=unsupported)
        row = report["claimEvidenceMap"][0]
        self.assertEqual(row["status"], "unsupported")
        self.assertIsNone(row["evidencePageIndex"])
        self.assertEqual(row["section"], "abstract")
        self.assertIn("conclusion_claim_without_results_support", _kinds(report))

        uncertain = [
            {
                "pageIndex": 0,
                "text": (
                    "Abstract\n"
                    "Mortality was 8.2% in the enrolled cohort overall across the prespecified follow-up. "
                    "The odds ratio was 1.5 in the enrolled cohort overall across the prespecified follow-up."
                ),
            },
            {
                "pageIndex": 1,
                "text": (
                    "Results\n"
                    "Mortality was 8.20% in the enrolled cohort overall across the prespecified follow-up. "
                    "The odds ratio was 1.47 in the enrolled cohort overall across the prespecified follow-up."
                ),
            },
            {
                "pageIndex": 2,
                "text": "Conclusion\nThese findings suggest that treatment may be associated with a lower mortality in this cohort.",
            },
            {
                "pageIndex": 3,
                "text": "Discussion\nThis study has several limitations including a single centre and a short follow-up period today.",
            },
        ]
        report = audit.audit_argument_outline(segments=uncertain)
        statuses = {row["value"]: row["status"] for row in report["claimEvidenceMap"]}
        self.assertEqual(statuses["8.2%"], "uncertain")
        self.assertEqual(statuses["1.5"], "uncertain")
        self.assertEqual(report["triageHints"], [])

    def test_table_text_supports_a_claim(self):
        segments = [
            {
                "pageIndex": 0,
                "text": "Abstract\nThe response rate was 33% in the enrolled cohort overall across follow-up.",
            },
            {
                "pageIndex": 1,
                "text": "Results\nThe cohort completed follow-up without a stated percentage today overall.",
            },
            {
                "pageIndex": 1,
                "kind": "table",
                "caption": "Response",
                "rows": [["response rate", "33%"]],
            },
            {
                "pageIndex": 2,
                "text": "Discussion\nThis study has several limitations including a single centre and a short follow-up period today.",
            },
        ]
        report = audit.audit_argument_outline(segments=segments)
        row = report["claimEvidenceMap"][0]
        self.assertEqual(row["status"], "supported")
        self.assertEqual(row["evidencePageIndex"], 1)
        self.assertEqual(report["triageHints"], [])

    def test_each_hint_and_limit(self):
        causal = [
            {
                "pageIndex": 0,
                "text": "Abstract\nThe trial definitively demonstrates that aspirin causes remission in the enrolled cohort.",
            },
            {
                "pageIndex": 1,
                "text": "Discussion\nThis study has several limitations including a single centre and a short follow-up period today.",
            },
        ]
        report = audit.audit_argument_outline(segments=causal)
        self.assertEqual(_kinds(report), ["causal_or_absolute_language_without_hedge"])
        self.assertEqual(report["triageHints"][0]["family"], "D3")
        self.assertTrue(report["triageHints"][0]["advisoryOnly"])

        absolute = [
            {
                "pageIndex": 0,
                "text": "Conclusion\nThe committee definitively endorses this regimen for every patient in the cohort.",
            },
            {
                "pageIndex": 1,
                "text": "Discussion\nThis study has several limitations including a single centre and a short follow-up period today.",
            },
        ]
        report = audit.audit_argument_outline(segments=absolute)
        self.assertEqual(report["triageHints"][0]["family"], "S1")

        hedged = [
            {
                "pageIndex": 0,
                "text": "Abstract\nThe trial may definitively demonstrate benefit for the enrolled cohort today.",
            },
            {
                "pageIndex": 1,
                "text": "Discussion\nThis study has several limitations including a single centre and a short follow-up period today.",
            },
        ]
        self.assertEqual(audit.audit_argument_outline(segments=hedged)["triageHints"], [])

        missing = [
            {"pageIndex": 0, "text": "Results\n" + MORTALITY},
            {"pageIndex": 1, "text": "Conclusion\nThese findings suggest that treatment may be associated with a lower mortality in this cohort."},
        ]
        report = audit.audit_argument_outline(segments=missing)
        self.assertEqual(_kinds(report), ["limitations_absent"])
        self.assertEqual(report["triageHints"][0]["family"], "S1")

        triple = [
            {
                "pageIndex": 0,
                "text": (
                    "Abstract\n"
                    "The trial definitively demonstrates that aspirin causes remission and the response rate was 40% overall."
                ),
            },
            {"pageIndex": 1, "text": "Results\n" + MORTALITY},
        ]
        report = audit.audit_argument_outline(segments=triple, limit=1)
        self.assertEqual(len(report["triageHints"]), 1)
        self.assertTrue(report["truncatedHints"])
        self.assertEqual(report["triageHints"][0]["kind"], "conclusion_claim_without_results_support")

    def test_dedupes_sibling_mismatch_and_spin_hints(self):
        internal = consistency.audit_internal_consistency(IC_PAGES)
        self.assertTrue(any("mismatch" in sig["kind"] for sig in internal["signals"]))
        report = audit.audit_argument_outline(segments=IC_PAGES)
        self.assertNotIn("conclusion_claim_without_results_support", _kinds(report))
        self.assertTrue(any(row["status"] == "unsupported" for row in report["claimEvidenceMap"]))
        self.assertEqual(report["signals"], [])

        flow = spin.audit_flow_and_spin_triage(SPIN_PAGES)
        self.assertTrue(any(hint["kind"] == "d3_causal_overclaim_hint" for hint in flow["triageHints"]))
        report = audit.audit_argument_outline(segments=SPIN_PAGES)
        self.assertNotIn("causal_or_absolute_language_without_hedge", _kinds(report))
        self.assertEqual(report["triageHints"], [])

    def test_digest_cap_determinism_topic_cap_and_pdf(self):
        first = audit.audit_argument_outline(segments=BENIGN)
        second = audit.audit_argument_outline(segments=BENIGN)
        self.assertEqual(first, second)
        self.assertLessEqual(len(first["digest"]), audit.DIGEST_CAP)
        self.assertEqual(first["digestCap"], 6000)
        self.assertIn("ARGUMENT OUTLINE", first["digest"])

        chunks = ["Results", ""]
        for index in range(80):
            chunks.append("word " * 30 + f"item {index}.")
            chunks.append("")
        chunks.extend([
            "Discussion",
            "This study has several limitations including a single centre and a short follow-up period today.",
        ])
        capped = audit.audit_argument_outline(segments="\n".join(chunks))
        self.assertEqual(len(capped["digest"]), audit.DIGEST_CAP)

        long_sentence = "Mortality " * 80
        long_report = audit.audit_argument_outline(segments="Abstract\n" + long_sentence.strip() + ".")
        self.assertEqual(len(long_report["outline"][0]["topicSentence"]), audit.TOPIC_CAP)

        pdf_report = audit.audit_argument_outline(_pdf("Abstract\n" + MORTALITY + "\nResults\n" + MORTALITY))
        self.assertEqual(pdf_report["claimEvidenceMap"][0]["status"], "supported")
        self.assertEqual(pdf_report["signals"], [])
        self.assertEqual(pdf_report, audit.audit_argument_outline(_pdf("Abstract\n" + MORTALITY + "\nResults\n" + MORTALITY)))

    def test_forbidden_red_key_and_bad_inputs(self):
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            audit.audit_argument_outline(segments=[{"text": "Abstract\nHello", "gold": "secret"}])
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            audit.audit_argument_outline(segments=[{"text": "Abstract", "rows": [{"before": "x"}]}])
        with self.assertRaisesRegex(ValueError, "forbidden_red_key"):
            audit.audit_argument_outline({"plan": "hidden"})
        with self.assertRaisesRegex(ValueError, "pdf_bytes"):
            audit.audit_argument_outline(b"not a pdf")
        with self.assertRaisesRegex(ValueError, "limit"):
            audit.audit_argument_outline(segments="Abstract\nHello", limit=0)
        with self.assertRaisesRegex(ValueError, "limit"):
            audit.audit_argument_outline(segments="Abstract\nHello", limit=True)

    def test_owned_functions_stay_within_ccn_limit(self):
        over = _ccn_over(REPO / "app" / "local" / "paper_argument_outline.py")
        over.extend(_ccn_over(Path(__file__)))
        self.assertEqual(over, [])


if __name__ == "__main__":
    unittest.main()
