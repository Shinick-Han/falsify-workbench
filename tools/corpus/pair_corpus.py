"""Build a source-native / PDF-edit pair corpus and score it.

``build`` imports ``source_mutator.build_twin``, ``twin_gate.verify_twin``, and
``pdf_twin.make_pdf_twin``. Blind directories use opaque ids. The sealed index
keeps the set-name and arm-role mapping. ``--layer0-runs`` reads each blind
PDF with ``benchmark_suite._sensor_signals`` and writes the detector report
from ``benchmark_suite._signals_to_run`` (agentId ``layer0-sensor``).
``measure`` imports ``leak_dependence.evaluate_manifest``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path, PurePosixPath

from pdf_twin import PdfTwinError, make_pdf_twin
from render import RenderError
from source_mutator import MutationError, build_twin, load_spec
from twin_gate import GateError, GateTimeout, verify_twin

SCHEMA = "falsify.source-pdf-pair-corpus.v1"
INPUT_SCHEMA = "falsify.leak-dependence-input.v1"
SOURCE = "source-native"
PDF = "pdf-mutation"
_ABS_RE = re.compile(r"[A-Za-z]:[\\/]|/Users/|/home/")
_FINDING_KEYS = (
    "decision", "detail", "excerpt", "family", "id", "itemId",
    "pageIndex", "quote", "supplementName",
)
_BANNED = {
    "before", "after", "rationale", "defectId", "operationId", "overridesApplied",
}


class PairError(ValueError):
    """Invalid input or a refused measurement. ``code`` is the public error."""

    def __init__(self, code: str, exit_code: int = 2):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


def _dump(data) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if _ABS_RE.search(text):
        raise PairError("path_leak")
    return text


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _write_json(path: Path, data) -> None:
    _write_text(path, _dump(data))


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _copy_named(src: Path, dest: Path) -> None:
    if src.is_file():
        _write_bytes(dest, src.read_bytes())


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def _pair_key(case_id: str, set_id: str) -> str:
    return _digest(f"pair\n{case_id}\n{set_id}")


def _arm_id(pair_key: str, role: str) -> str:
    return _digest(f"arm\n{pair_key}\n{role}")


def _match(rel: str, pattern: str | None) -> bool:
    if pattern is None:
        name = rel.rsplit("/", 1)[-1]
        return name.startswith("p") and "-pair-" in name and name.endswith(".json")
    return PurePosixPath(rel).match(pattern)


def _spec_paths(fixtures: Path, pattern: str | None) -> list[Path]:
    found = []
    cases = [path for path in fixtures.iterdir() if (path / "case.json").is_file()]
    for case in sorted(cases, key=lambda path: path.name):
        folder = case / "mutations"
        if not folder.is_dir():
            continue
        for spec in sorted(folder.glob("*.json"), key=lambda path: path.name):
            rel = spec.relative_to(fixtures).as_posix()
            if _match(rel, pattern):
                found.append(spec)
    return found


def _gate_codes(report: dict) -> list[str]:
    codes = []
    for item in report.get("failures") or []:
        if isinstance(item, dict):
            check = str(item.get("check") or "gate")
            code = str(item.get("code") or "refused")
            codes.append(f"{check}:{code}")
    return codes or ["gate_refused"]


def _compile_error(identity: dict, exc) -> dict:
    code = getattr(exc, "code", "invalid_input")
    if code in {"compile_timeout", "timeout"} or isinstance(exc, GateTimeout):
        raise PairError("timeout", 124) from exc
    return {**identity, "status": "refused", "reasons": [str(code)]}


def _invoke_make(bundle_dir: Path, pdf_dir: Path) -> dict:
    try:
        return make_pdf_twin(bundle_dir, pdf_dir)
    except PdfTwinError as exc:
        return {"reasons": [exc.code], "status": "unsupported", "unsupported": 1}


def _from_make(identity, bundle_dir, pdf_dir, made, report) -> dict:
    applied = made.get("status") == "applied"
    reasons = [str(item) for item in (made.get("reasons") or []) if item]
    if not applied and not reasons:
        reasons = ["unsupported"]
    return {
        **identity,
        "bundle": bundle_dir,
        "gate": report,
        "pdfDir": pdf_dir,
        "reasons": [] if applied else reasons,
        "status": "paired" if applied else "source_only",
    }


def _compile_set(case_dir: Path, spec_path: Path, scratch: Path) -> dict:
    spec = load_spec(spec_path)
    identity = {"caseId": spec["caseId"], "mutationSetId": spec["mutationSetId"]}
    build_dir = scratch / "build"
    bundle_dir = scratch / "bundle"
    pdf_dir = scratch / "pdf"
    try:
        build_twin(case_dir, spec, build_dir, compile_pdf=True)
        report = verify_twin(build_dir, case_dir, bundle_out=bundle_dir)
    except (MutationError, RenderError, GateError) as exc:
        return _compile_error(identity, exc)
    if not report.get("pass"):
        refused = {**identity, "gate": report, "reasons": _gate_codes(report), "status": "refused"}
        return refused
    return _from_make(identity, bundle_dir, pdf_dir, _invoke_make(bundle_dir, pdf_dir), report)


def _ensure_eval() -> None:
    root = Path(__file__).resolve().parents[2]
    for entry in (root / "tools" / "evaluation", root / "app" / "local"):
        text = str(entry)
        if text not in sys.path:
            sys.path.insert(0, text)


def _finding(item: dict) -> dict:
    return {key: item[key] for key in _FINDING_KEYS if key in item}


def _finding_key(item: dict):
    page = item.get("pageIndex")
    page_no = page if type(page) is int else -1
    return (page_no, str(item.get("excerpt") or ""), str(item.get("id") or ""))


def _stable_run(report: dict) -> dict:
    findings = [_finding(item) for item in report.get("findings") or [] if isinstance(item, dict)]
    findings.sort(key=_finding_key)
    return {"agentId": "layer0-sensor", "findings": findings, "runId": "layer0-sensor"}


def layer0_run(pdf: bytes, run_id: str) -> dict:
    """Layer 0 sensor report. ``benchmark_suite._signals_to_run`` builds findings."""
    del run_id
    _ensure_eval()
    import benchmark_suite

    benchmark_suite._ensure_local()
    signals = benchmark_suite._sensor_signals({"blindPdfBytes": pdf})
    return _stable_run(benchmark_suite._signals_to_run(signals, "layer0-sensor"))


def _run_layer0(dest: Path, arm_id: str, data: bytes, enabled: bool) -> None:
    if not enabled:
        return
    _write_json(dest / "runs" / arm_id / "layer0.json", layer0_run(data, "layer0-sensor"))


def _place_arm(dest: Path, key: str, role: str, data: bytes, layer0: bool):
    arm_id = _arm_id(key, role)
    _write_bytes(dest / "blind" / key / arm_id / "paper.pdf", data)
    _run_layer0(dest, arm_id, data, layer0)
    return arm_id, {"armId": arm_id, "pdfSha256": _sha256(data)}


def _copy_common(dest: Path, key: str, record: dict) -> None:
    sealed = dest / "sealed" / key
    bundle = Path(record["bundle"]) / "sealed"
    _copy_named(bundle / "gold-ledger.json", sealed / SOURCE / "gold-ledger.json")
    _copy_named(bundle / "baseline-signals.json", sealed / "baseline-signals.json")
    gate = bundle / "gate.json"
    if gate.is_file():
        _copy_named(gate, sealed / "gate.json")
    elif record.get("gate") is not None:
        _write_json(sealed / "gate.json", record["gate"])


def _copy_pair(dest: Path, key: str, record: dict) -> None:
    pdf_dir = record.get("pdfDir")
    if pdf_dir is None:
        return
    _copy_named(Path(pdf_dir) / "sealed" / "pair.json", dest / "sealed" / key / "pair.json")


def _copy_pdf_ledger(dest: Path, key: str, record: dict) -> None:
    pdf_dir = record.get("pdfDir")
    if pdf_dir is None:
        return
    src = Path(pdf_dir) / "sealed" / "gold-ledger.json"
    _copy_named(src, dest / "sealed" / key / PDF / "gold-ledger.json")


def _source_pdf(record: dict) -> bytes:
    return (Path(record["bundle"]) / "blind" / "paper.pdf").read_bytes()


def _pdf_arm_bytes(record: dict) -> bytes:
    return (Path(record["pdfDir"]) / "blind" / "paper.pdf").read_bytes()


def _leak_arm(key: str, role: str, arm_id: str) -> dict:
    return {
        "arm": role,
        "baselineSignals": f"{key}/baseline-signals.json",
        "blueRuns": [f"../runs/{arm_id}/layer0.json"],
        "gold": f"{key}/{role}/gold-ledger.json",
        "pairId": key,
    }


def _write_arms(dest: Path, key: str, record: dict, layer0: bool):
    source_id, source_arm = _place_arm(dest, key, SOURCE, _source_pdf(record), layer0)
    arms = {SOURCE: source_arm}
    leak = []
    if record["status"] != "paired":
        return arms, leak
    pdf_id, pdf_arm = _place_arm(dest, key, PDF, _pdf_arm_bytes(record), layer0)
    arms[PDF] = pdf_arm
    leak.append(_leak_arm(key, PDF, pdf_id))
    leak.append(_leak_arm(key, SOURCE, source_id))
    return arms, leak


def _write_refused(dest: Path, key: str, record: dict) -> None:
    if record.get("gate") is not None:
        _write_json(dest / "sealed" / key / "gate.json", record["gate"])


def _index_entry(record: dict, key: str, arms: dict) -> dict:
    return {
        "arms": arms,
        "caseId": record["caseId"],
        "mutationSetId": record["mutationSetId"],
        "pairKey": key,
        "reasons": list(record["reasons"]),
        "status": record["status"],
    }


def _write_one(dest: Path, record: dict, layer0: bool):
    key = _pair_key(record["caseId"], record["mutationSetId"])
    if record["status"] == "refused":
        _write_refused(dest, key, record)
        return _index_entry(record, key, {}), []
    _copy_common(dest, key, record)
    _copy_pair(dest, key, record)
    if record["status"] == "paired":
        _copy_pdf_ledger(dest, key, record)
    arms, leak = _write_arms(dest, key, record, layer0)
    return _index_entry(record, key, arms), leak


def _summary(records: list[dict]) -> dict:
    paired = sum(item["status"] == "paired" for item in records)
    source_only = sum(item["status"] == "source_only" for item in records)
    refused = len(records) - paired - source_only
    return {
        "paired": paired,
        "refused": refused,
        "schema": SCHEMA,
        "sets": len(records),
        "sourceOnly": source_only,
    }


def _write_corpus(dest: Path, records: list[dict], layer0: bool) -> dict:
    dest.mkdir(parents=True)
    (dest / "runs").mkdir()
    entries = []
    arms = []
    for record in records:
        entry, leak = _write_one(dest, record, layer0)
        entries.append(entry)
        arms.extend(leak)
    arms.sort(key=lambda item: (item["pairId"], item["arm"]))
    _write_json(dest / "sealed" / "index.json", {"schema": SCHEMA, "sets": entries})
    _write_json(
        dest / "sealed" / "leak-dependence-input.json",
        {"arms": arms, "schema": INPUT_SCHEMA},
    )
    return _summary(records)


def _compile_at(spec_path: Path, work: Path, index: int) -> dict:
    scratch = work / f"set-{index:03d}"
    scratch.mkdir(parents=True)
    return _compile_set(spec_path.parents[1], spec_path, scratch)


def _publish(corpus: Path, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.rmdir()
    shutil.move(str(corpus), str(out))


def build_corpus(fixtures, out_dir, *, sets_glob=None, layer0_runs=False) -> dict:
    """Build the pair corpus. The returned summary has counts only."""
    root = Path(fixtures)
    if not root.is_dir():
        raise PairError("invalid_input")
    specs = _spec_paths(root, sets_glob)
    if not specs:
        raise PairError("sets_missing")
    out = Path(out_dir)
    if out.exists() and any(out.iterdir()):
        raise PairError("output_not_empty")
    work = Path(tempfile.mkdtemp(prefix="pair-corpus-"))
    try:
        records = [_compile_at(spec, work, index) for index, spec in enumerate(specs)]
        summary = _write_corpus(work / "corpus", records, layer0_runs)
        _publish(work / "corpus", out)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return summary


def _run_files(root: Path) -> list[Path]:
    runs = root / "runs"
    if not runs.is_dir():
        return []
    return sorted(runs.glob("*/*.json"))


def _scrub(value):
    if isinstance(value, dict):
        return {key: _scrub(item) for key, item in value.items() if key not in _BANNED}
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    return value


def _evaluate(manifest: Path) -> dict:
    _ensure_eval()
    from leak_dependence import LeakDependenceError, evaluate_manifest

    try:
        return evaluate_manifest(manifest)
    except LeakDependenceError as exc:
        raise PairError(exc.code, exc.exit_code) from exc


def _markdown(report: dict) -> str:
    from leak_dependence import render_markdown

    return render_markdown(report)


def _measure_summary(report: dict) -> dict:
    return {
        "interpretation": report.get("interpretation"),
        "pairCount": report.get("pairCount"),
        "paired": report.get("paired"),
        "schema": report.get("schema"),
    }


def measure_corpus(corpus_dir, out_file, markdown=None) -> dict:
    """Score the sealed manifest. Exit ``runs_empty`` when no detector JSON exists."""
    root = Path(corpus_dir)
    if not _run_files(root):
        raise PairError("runs_empty")
    manifest = root / "sealed" / "leak-dependence-input.json"
    if not manifest.is_file():
        raise PairError("invalid_input")
    report = _scrub(_evaluate(manifest))
    _write_text(Path(out_file), _dump(report))
    if markdown:
        _write_text(Path(markdown), _markdown(report))
    return report


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pair_corpus")
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--fixtures", required=True)
    build.add_argument("--out", required=True)
    build.add_argument("--sets")
    build.add_argument("--layer0-runs", action="store_true")
    measure = sub.add_parser("measure")
    measure.add_argument("--corpus", required=True)
    measure.add_argument("--out", required=True)
    measure.add_argument("--markdown")
    return parser


def _status(code) -> int:
    if code in (None, 0):
        return 0
    if isinstance(code, int):
        return code
    return 2


def main(argv=None) -> int:
    """Build or measure a pair corpus. JSON on stdout has no answer-key keys."""
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return _status(exc.code)
    try:
        if args.command == "build":
            summary = build_corpus(
                args.fixtures, args.out, sets_glob=args.sets, layer0_runs=args.layer0_runs,
            )
            sys.stdout.write(_dump(summary))
            return 0
        report = measure_corpus(args.corpus, args.out, markdown=args.markdown)
        sys.stdout.write(_dump(_measure_summary(report)))
        return 0
    except PairError as exc:
        sys.stdout.write(_dump({"error": exc.code, "schema": SCHEMA}))
        return exc.exit_code


if __name__ == "__main__":
    sys.exit(main())
