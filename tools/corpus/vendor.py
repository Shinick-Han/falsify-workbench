"""Verify and load unmodified PaperOrchestra files for tools/corpus.

The receipt ``hash`` is the sha256 of LF-normalized file bytes in ascending
path order. Each file is prefixed by its UTF-8 path and a newline, and is
followed by a newline. Per-file ``sha256`` values use the same LF normalization
(``\\r\\n`` replaced by ``\\n``).
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

RECEIPT_NAME = "receipt.json"
UPSTREAM = "upstream"
VENDOR_REL = Path("app") / "vendor-sources" / "paper-orchestra"
COMMIT = "6a319132932ee031e2d759b0f7f5075cf77bd1cf"


def _repo_root(root: Path | None) -> Path:
    if root is not None:
        return Path(root)
    return Path(__file__).resolve().parents[2]


def _vendor_root(root: Path | None) -> Path:
    return _repo_root(root) / VENDOR_REL


def _lf_bytes(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _aggregate_hash(parts: list[tuple[str, bytes]]) -> str:
    chunks: list[bytes] = []
    for path, data in sorted(parts):
        chunks.append(path.encode("utf-8"))
        chunks.append(b"\n")
        chunks.append(data)
        chunks.append(b"\n")
    return _sha256(b"".join(chunks))


def _load_receipt(root: Path | None) -> dict | None:
    path = _vendor_root(root) / RECEIPT_NAME
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"_invalid": True}
    if not isinstance(data, dict):
        return {"_invalid": True}
    return data


def _entries(receipt: dict) -> dict[str, str]:
    files = receipt.get("files")
    if not isinstance(files, list):
        return {}
    found: dict[str, str] = {}
    for item in files:
        if not isinstance(item, dict):
            continue
        rel = item.get("path")
        digest = item.get("sha256")
        if isinstance(rel, str) and isinstance(digest, str):
            found[rel.replace("\\", "/")] = digest
    return found


def _result(ok: bool, checked: int, mismatched: list[str], missing: list[str], extra: list[str]) -> dict:
    return {
        "schema": "falsify.vendor-verify.v1",
        "ok": ok,
        "checked": checked,
        "mismatched": sorted(set(mismatched)),
        "missing": sorted(set(missing)),
        "extra": sorted(set(extra)),
    }


def _within(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _read_rel(vendor: Path, rel: str) -> bytes | None:
    upstream = vendor / UPSTREAM
    path = vendor.joinpath(*rel.split("/"))
    if not _within(upstream, path):
        raise ValueError("path_escape")
    if not path.is_file():
        return None
    return path.read_bytes()


def _compare(vendor: Path, expected: dict[str, str]) -> tuple[list[str], list[str], list[tuple[str, bytes]]]:
    mismatched: list[str] = []
    missing: list[str] = []
    matched: list[tuple[str, bytes]] = []
    for rel, digest in expected.items():
        try:
            data = _read_rel(vendor, rel)
        except ValueError:
            mismatched.append(rel)
            continue
        if data is None:
            missing.append(rel)
            continue
        normalized = _lf_bytes(data)
        if _sha256(normalized) != digest:
            mismatched.append(rel)
            continue
        matched.append((rel, normalized))
    return mismatched, missing, matched


def _extras(vendor: Path, expected: dict[str, str]) -> list[str]:
    upstream = vendor / UPSTREAM
    if not upstream.is_dir():
        return []
    found: list[str] = []
    for path in upstream.rglob("*"):
        if path.is_file():
            rel = f"{UPSTREAM}/{path.relative_to(upstream).as_posix()}"
            if rel not in expected:
                found.append(rel)
    return found


def _metadata_ok(receipt: dict) -> bool:
    return (
        receipt.get("schema") == "falsify.vendor-receipt.v1"
        and receipt.get("name") == "paper-orchestra"
        and receipt.get("repository") == "https://github.com/Ar9av/PaperOrchestra"
        and receipt.get("commit") == COMMIT
        and receipt.get("license") == "MIT"
        and receipt.get("licenseFile") == "upstream/LICENSE"
        and receipt.get("modified") is False
    )


def _receipt_mismatch(receipt: dict, matched: list[tuple[str, bytes]]) -> list[str]:
    bad_meta = not _metadata_ok(receipt)
    bad_hash = receipt.get("hash") != _aggregate_hash(matched)
    if bad_meta or bad_hash:
        return [RECEIPT_NAME]
    return []


def verify_receipt(root=None) -> dict:
    """Recompute vendored hashes. ``root`` defaults to the workbench repository."""
    receipt = _load_receipt(root)
    if receipt is None:
        return _result(False, 0, [], [RECEIPT_NAME], [])
    if receipt.get("_invalid"):
        return _result(False, 0, [RECEIPT_NAME], [], [])
    expected = _entries(receipt)
    vendor = _vendor_root(root)
    mismatched, missing, matched = _compare(vendor, expected)
    extra = _extras(vendor, expected)
    if not mismatched and not missing:
        mismatched.extend(_receipt_mismatch(receipt, matched))
    ok = not mismatched and not missing and not extra
    return _result(ok, len(expected), mismatched, missing, extra)


def _safe_upstream(relative_path: str) -> str:
    if not isinstance(relative_path, str):
        raise ValueError("path_escape")
    raw = relative_path.replace("\\", "/").strip()
    if not raw or raw.startswith("/") or (len(raw) >= 2 and raw[1] == ":"):
        raise ValueError("path_escape")
    parts = [part for part in raw.split("/") if part != "."]
    if not parts or ".." in parts or parts[0] != UPSTREAM:
        raise ValueError("path_escape")
    return "/".join(parts)


def load_vendor_module(relative_path, root=None):
    """Load a vendored Python file after its receipt hash matches."""
    rel = _safe_upstream(relative_path)
    if not rel.endswith(".py"):
        raise ValueError("vendor_unverified")
    receipt = _load_receipt(root)
    expected = {} if receipt is None or receipt.get("_invalid") else _entries(receipt)
    if rel not in expected:
        raise ValueError("vendor_unverified")
    data = _read_rel(_vendor_root(root), rel)
    if data is None or _sha256(_lf_bytes(data)) != expected[rel]:
        raise ValueError("vendor_unverified")
    path = _vendor_root(root).joinpath(*rel.split("/"))
    name = "_falsify_vendor_" + expected[rel][:16]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError("vendor_unverified")
    module = importlib.util.module_from_spec(spec)
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="vendor")
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("--root", default=None)
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    payload = verify_receipt(args.root)
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    if payload["ok"]:
        return 0
    return 3


if __name__ == "__main__":
    sys.exit(main())
