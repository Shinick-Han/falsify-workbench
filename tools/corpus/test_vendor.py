"""Tests for the PaperOrchestra vendor receipt."""

import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import vendor
from vendor import load_vendor_module, verify_receipt

ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "app" / "vendor-sources" / "paper-orchestra"
EXTRACT = "upstream/skills/section-writing-agent/scripts/extract_metrics.py"


def _copy_tree(tmp):
    dest_root = Path(tmp)
    shutil.copytree(VENDOR, dest_root / "app" / "vendor-sources" / "paper-orchestra")
    return dest_root


def _upstream(root):
    return root / "app" / "vendor-sources" / "paper-orchestra" / "upstream"


class VendorTests(unittest.TestCase):
    def test_receipt_matches_repo(self):
        result = verify_receipt()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["checked"], 16)
        self.assertEqual(result["mismatched"], [])
        self.assertEqual(result["missing"], [])
        self.assertEqual(result["extra"], [])

    def test_tampered_file_is_mismatched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _copy_tree(tmp)
            license_path = _upstream(root) / "LICENSE"
            license_path.write_bytes(license_path.read_bytes() + b"\n")
            result = verify_receipt(root)
            self.assertFalse(result["ok"])
            self.assertIn("upstream/LICENSE", result["mismatched"])
            self.assertEqual(result["missing"], [])
            self.assertEqual(result["extra"], [])

    def test_missing_and_extra_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _copy_tree(tmp)
            (_upstream(root) / "LICENSE").unlink()
            extra = _upstream(root) / "EXTRA.md"
            extra.write_text("extra\n", encoding="utf-8", newline="\n")
            result = verify_receipt(root)
            self.assertFalse(result["ok"])
            self.assertIn("upstream/LICENSE", result["missing"])
            self.assertIn("upstream/EXTRA.md", result["extra"])

    def test_crlf_copy_still_verifies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = _copy_tree(tmp)
            for path in _upstream(root).rglob("*"):
                if path.is_file():
                    data = path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
                    path.write_bytes(data)
            result = verify_receipt(root)
            self.assertTrue(result["ok"], result)

    def test_load_vendor_module_refuses_tamper_and_escape(self):
        module = load_vendor_module(EXTRACT)
        self.assertTrue(callable(module.find_raw_data_section))
        self.assertTrue(callable(module.parse_markdown_tables))
        with tempfile.TemporaryDirectory() as tmp:
            root = _copy_tree(tmp)
            target = root / "app" / "vendor-sources" / "paper-orchestra" / Path(EXTRACT)
            target.write_bytes(target.read_bytes() + b"\n# tamper\n")
            with self.assertRaises(ValueError) as caught:
                load_vendor_module(EXTRACT, root=root)
            self.assertEqual(str(caught.exception), "vendor_unverified")
        with self.assertRaises(ValueError) as caught:
            load_vendor_module("../vendor.py")
        self.assertEqual(str(caught.exception), "path_escape")
        with self.assertRaises(ValueError) as caught:
            load_vendor_module("upstream/../../tools/corpus/vendor.py")
        self.assertEqual(str(caught.exception), "path_escape")

    def test_cli_exit_codes(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = vendor.main(["verify"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(buf.getvalue())["ok"])
        with tempfile.TemporaryDirectory() as tmp:
            root = _copy_tree(tmp)
            license_path = _upstream(root) / "LICENSE"
            license_path.write_bytes(license_path.read_bytes() + b"x")
            failed = io.StringIO()
            with contextlib.redirect_stdout(failed):
                status = vendor.main(["verify", "--root", str(root)])
            self.assertEqual(status, 3)
            self.assertFalse(json.loads(failed.getvalue())["ok"])
            self.assertNotIn(str(root), failed.getvalue())


if __name__ == "__main__":
    unittest.main()
