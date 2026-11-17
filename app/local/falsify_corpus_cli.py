"""Product CLI for source-corpus list, build, mutate, and verify.

Corpus modules stay lazy so a packaged app/local tree still imports when
tools/corpus is absent. Stdout is the agent envelope and omits answer-key fields.
"""
from __future__ import annotations

import importlib
import json
import re
import sys
import time
from pathlib import Path

_CASE_SCHEMA = "falsify.source-case.v1"
_MUTATION_SCHEMA = "falsify.source-mutation.v1"
_GATE_SCHEMA = "falsify.source-twin-gate.v1"
_SECRET_KEYS = frozenset({
    "before", "after", "rationale", "operationId", "overridesApplied",
})
_DETAIL_KEYS = (
    "caseId", "mutationSetId", "pairs", "signals", "exemptions", "contexts",
    "pages", "newSignals", "status", "checked", "references", "skipped",
)
_DRIVE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]|/Users/|/home/")


def _repo() -> Path:
    return Path(__file__).resolve().parents[2]


def _schema() -> str:
    return importlib.import_module("falsify_cli").SCHEMA


def _error(code: str, message: str, exit_code: int, hint: str, extra: dict | None = None):
    cli = importlib.import_module("falsify_cli")
    raise cli._CliError(code, message, exit_code=exit_code, recovery_hint=hint, extra=extra)


def _check(deadline):
    importlib.import_module("falsify_cli")._check_deadline(deadline)


def _guard(path, protected) -> None:
    if not path:
        return
    importlib.import_module("falsify_cli")._guard_output_paths([path], protected)


def _tools_root() -> Path:
    return _repo() / "tools" / "corpus"


def _require_tools() -> Path:
    root = _tools_root()
    if not (root / "source_case.py").is_file():
        _error(
            "corpus_tools_unavailable",
            "Corpus tools are not installed.",
            2,
            "Use a checkout that includes tools/corpus.",
        )
    return root


def _ensure_path(root: Path) -> None:
    text = str(root)
    if text not in sys.path:
        sys.path.append(text)


def _tools_unavailable():
    _error(
        "corpus_tools_unavailable",
        "Corpus tools are not installed.",
        2,
        "Use a checkout that includes tools/corpus.",
    )


def _missing_dep(name: str):
    _error(
        "dependency_missing",
        f"Missing dependency: {name}.",
        2,
        f"Install {name}. For TeX, install pdflatex or pass --no-compile.",
        extra={"dependency": name},
    )


def _timeout():
    _error(
        "timeout",
        "Command exceeded configured timeout.",
        124,
        "Increase --timeout or pass --no-compile.",
    )


def _input_error(code: str):
    _error(code or "invalid_input", "Corpus input was rejected.", 2, "Check the case directory and flags.")


def _mutation_error(code: str):
    exit_code = 3 if code == "diff_mismatch" else 2
    _error(code or "mutation_failed", "Mutation was rejected.", exit_code, "Check the mutation spec against the case.")


def _render_error(code: str):
    _error(code or "render_failed", "Render was refused.", 3, "Check the case and choose an empty --out directory.")


def _vendor_error():
    _error("vendor_unverified", "Vendored corpus helper failed its receipt check.", 3, "Restore tools/corpus vendor files.")


def _dep_name(code: str) -> str:
    if code == "figure_engine_unavailable":
        return "matplotlib"
    return "pdflatex"


def _missing_module(exc) -> None:
    missing = getattr(exc, "name", "") or ""
    if missing == "matplotlib" or missing.startswith("matplotlib.") or missing == "numpy":
        _missing_dep("matplotlib")
    _tools_unavailable()


def _import_named(name: str):
    root = _require_tools()
    _ensure_path(root)
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError as exc:
        _missing_module(exc)


def _reraise(exc: Exception) -> None:
    name = type(exc).__name__
    code = getattr(exc, "code", "") or ""
    if name == "GateTimeout" or code == "compile_timeout":
        _timeout()
    if code in ("figure_engine_unavailable", "engine_unavailable"):
        _missing_dep(_dep_name(code))
    if name == "SourceCaseError":
        _input_error(code)
    if name == "MutationError":
        _mutation_error(code)
    if name == "RenderError":
        _render_error(code)
    if name == "GateError":
        _input_error(code)
    if name == "ValueError" and str(exc) == "vendor_unverified":
        _vendor_error()
    raise exc


def _seconds(deadline):
    if deadline is None:
        return None
    left = deadline - time.monotonic()
    if left <= 0:
        _timeout()
    return left


def _require_dir(path: str, label: str) -> Path:
    candidate = Path(path)
    if not candidate.is_dir():
        _error("file_not_found", f"{label} directory not found.", 2, f"Pass an existing directory to {label}.")
    return candidate


def _require_file(path: str, label: str) -> Path:
    candidate = Path(path)
    if not candidate.is_file():
        _error("file_not_found", f"{label} file not found.", 2, f"Pass an existing file to {label}.")
    return candidate


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        _input_error("schema_invalid")
    if not isinstance(data, dict):
        _input_error("schema_invalid")
    return data


def _mutation_id(path: Path) -> str:
    data = _read_json(path)
    if data.get("schema") != _MUTATION_SCHEMA:
        _input_error("schema_invalid")
    set_id = data.get("mutationSetId")
    if not isinstance(set_id, str) or not set_id:
        _input_error("schema_invalid")
    return set_id


def _mutation_ids(case_dir: Path) -> list[str]:
    folder = case_dir / "mutations"
    if not folder.is_dir():
        return []
    found = [_mutation_id(path) for path in sorted(folder.glob("*.json"))]
    return sorted(set(found))


def _case_record(case_dir: Path) -> dict:
    data = _read_json(case_dir / "case.json")
    if data.get("schema") != _CASE_SCHEMA:
        _input_error("schema_invalid")
    case_id = data.get("caseId")
    if not isinstance(case_id, str) or not case_id:
        _input_error("schema_invalid")
    return {"caseId": case_id, "name": case_dir.name, "mutationSetIds": _mutation_ids(case_dir)}


def _case_dirs(root: Path) -> list[Path]:
    if (root / "case.json").is_file():
        return [root]
    found = []
    for child in sorted(root.iterdir(), key=lambda item: item.name):
        if child.is_dir() and (child / "case.json").is_file():
            found.append(child)
    return found


def _display_root(path: Path, default: bool) -> str:
    if default:
        return "tools/corpus/fixtures"
    try:
        relative = path.resolve().relative_to(_repo())
    except ValueError:
        return path.name or "."
    text = relative.as_posix()
    return text or "."


def _list_root(args) -> tuple[Path, bool]:
    raw = getattr(args, "root", None)
    if raw:
        return Path(raw), False
    return _repo() / "tools" / "corpus" / "fixtures", True


def _reject_key(key: str, in_defects: bool) -> None:
    leaked = key in _SECRET_KEYS or (key == "defectId" and not in_defects)
    if leaked:
        _error("blind_leak", "Output contained a sealed field.", 2, "Corpus stdout omits answer-key fields.")


def _reject_text(value) -> None:
    if isinstance(value, str) and _DRIVE.search(value):
        _error(
            "absolute_path",
            "Output contained an absolute path.",
            2,
            "Keep generated paths relative to the output directory.",
        )


def _walk_dict(node: dict, in_defects: bool) -> None:
    for key, value in node.items():
        _reject_key(key, in_defects)
        _reject_text(value)
        _walk_safe(value, in_defects or key == "defects")


def _walk_safe(node, in_defects: bool) -> None:
    if isinstance(node, dict):
        _walk_dict(node, in_defects)
    elif isinstance(node, list):
        for item in node:
            _walk_safe(item, in_defects)


def _assert_stdout_safe(payload) -> None:
    _walk_safe(payload, False)


def _rel_text(value) -> str:
    text = value if isinstance(value, str) else ""
    _reject_text(text)
    return text.replace("\\", "/")


def cmd_list(args, deadline=None) -> tuple[dict, int]:
    """List case ids and mutation set ids. Omit rationales and values."""
    _check(deadline)
    _require_tools()
    root, default = _list_root(args)
    if not root.is_dir():
        _error("file_not_found", "Case root directory not found.", 2, "Pass an existing directory via --root.")
    payload = {
        "schema": _schema(),
        "ok": True,
        "command": "corpus list",
        "root": _display_root(root, default),
        "cases": [_case_record(path) for path in _case_dirs(root)],
    }
    _assert_stdout_safe(payload)
    return payload, 0


def _engine_name(engine, compiled):
    if not compiled:
        return None
    if isinstance(engine, dict) and engine.get("name") == "pdflatex":
        return "pdflatex"
    if engine:
        return "pdflatex"
    return None


def _public_files(files) -> list[dict]:
    rows = []
    for item in files or []:
        if isinstance(item, dict):
            rows.append({"path": _rel_text(item.get("path")), "sha256": item.get("sha256")})
    return rows


def _build_payload(result: dict) -> dict:
    return {
        "schema": _schema(),
        "ok": True,
        "command": "corpus build",
        "caseId": result.get("caseId"),
        "compiled": bool(result.get("compiled")),
        "engine": _engine_name(result.get("engine"), result.get("compiled")),
        "files": _public_files(result.get("files")),
        "pageCount": result.get("pageCount"),
        "modelCalls": result.get("modelCalls", 0),
    }


def cmd_build(args, deadline=None) -> tuple[dict, int]:
    """Render one clean case. --out is the render directory, not a JSON file."""
    _check(deadline)
    _require_tools()
    case = _require_dir(args.case, "--case")
    _guard(args.out, [args.case])
    render = _import_named("render")
    try:
        result = render.render_case(case, args.out, compile_pdf=not bool(args.no_compile))
    except Exception as exc:
        _reraise(exc)
    _check(deadline)
    payload = _build_payload(result)
    _assert_stdout_safe(payload)
    return payload, 0


def _mutate_payload(summary: dict) -> dict:
    changed = [_rel_text(item) for item in summary.get("changedFiles") or []]
    return {
        "schema": _schema(),
        "ok": True,
        "command": "corpus mutate",
        "caseId": summary.get("caseId"),
        "mutationSetId": summary.get("mutationSetId"),
        "compiled": bool(summary.get("compiled")),
        "texDiffLines": summary.get("texDiffLines"),
        "changedFiles": changed,
        "samePageCount": summary.get("samePageCount"),
        "defectCount": summary.get("defectCount"),
        "overrideCount": summary.get("overrideCount"),
        "modelCalls": summary.get("modelCalls", 0),
    }


def cmd_mutate(args, deadline=None) -> tuple[dict, int]:
    """Build a twin. The summary omits before/after text and rationales."""
    _check(deadline)
    _require_tools()
    case = _require_dir(args.case, "--case")
    spec_path = _require_file(args.spec, "--spec")
    _guard(args.out, [args.case, args.spec])
    mutator = _import_named("source_mutator")
    try:
        spec = mutator.load_spec(spec_path)
        summary = mutator.build_twin(case, spec, args.out, compile_pdf=not bool(args.no_compile))
    except Exception as exc:
        _reraise(exc)
    _check(deadline)
    payload = _mutate_payload(summary)
    _assert_stdout_safe(payload)
    return payload, 0


def _detail_ok(value) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, str)


def _public_details(details) -> dict:
    if not isinstance(details, dict):
        return {}
    safe = {}
    for key in _DETAIL_KEYS:
        if key not in details:
            continue
        value = details[key]
        if _detail_ok(value):
            safe[key] = value
    return safe


def _public_checks(items) -> list[dict]:
    rows = []
    for item in items or []:
        if isinstance(item, dict):
            rows.append({
                "check": item.get("check"),
                "pass": bool(item.get("pass")),
                "details": _public_details(item.get("details")),
            })
    return rows


def _public_failures(items) -> list[dict]:
    rows = []
    for item in items or []:
        if isinstance(item, dict):
            rows.append({"check": item.get("check"), "code": item.get("code")})
    return rows


def _public_defects(items) -> list[dict]:
    rows = []
    for item in items or []:
        if isinstance(item, dict):
            rows.append({
                "defectId": str(item.get("defectId") or ""),
                "layer0Detected": bool(item.get("layer0Detected")),
            })
    return rows


def _public_report(report) -> dict:
    if not isinstance(report, dict):
        _input_error("gate_report")
    return {
        "schema": report.get("schema") or _GATE_SCHEMA,
        "caseId": report.get("caseId"),
        "mutationSetId": report.get("mutationSetId"),
        "pass": bool(report.get("pass")),
        "checks": _public_checks(report.get("checks")),
        "failures": _public_failures(report.get("failures")),
        "defects": _public_defects(report.get("defects")),
        "modelCalls": report.get("modelCalls", 0),
    }


def _verify_payload(report: dict) -> dict:
    return {
        "schema": _schema(),
        "ok": bool(report.get("pass")),
        "command": "corpus verify",
        "report": report,
    }


def _refused(payload: dict) -> dict:
    refused = dict(payload)
    refused["ok"] = False
    refused["error"] = "gate_refused"
    refused["message"] = "Twin gate refused the build."
    refused["recoveryHint"] = "Read report.failures, then rebuild the twin."
    return refused


def cmd_verify(args, deadline=None) -> tuple[dict, int]:
    """Run the twin gate. A refusal still prints the report and exits 3."""
    _check(deadline)
    _require_tools()
    _require_dir(args.build, "--build")
    _require_dir(args.case, "--case")
    bundle = getattr(args, "bundle_out", None)
    if bundle:
        _guard(bundle, [args.build, args.case])
    gate = _import_named("twin_gate")
    try:
        report = gate.verify_twin(
            args.build, args.case, bundle_out=bundle, timeout=_seconds(deadline),
        )
    except Exception as exc:
        _reraise(exc)
    _check(deadline)
    payload = _verify_payload(_public_report(report))
    if not payload["report"]["pass"]:
        payload = _refused(payload)
    _assert_stdout_safe(payload)
    return payload, (0 if payload["ok"] else 3)
