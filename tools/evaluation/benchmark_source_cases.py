"""Turn gate-passed source-native bundles into benchmark cases.

Discovery reads ``tools/corpus/fixtures/*/mutations/*.json``, builds each twin,
and keeps a set only when ``twin_gate.verify_twin`` passes. Toolchain gaps and
gate refusals stay out of the scored corpus.
"""
from __future__ import annotations

import importlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile

_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$')
_CODE_RE = re.compile(r'^[a-z][a-z0-9_]{0,63}$')
_GOLD_SCHEMA = 'falsify.red-gold-ledger.v1'
_CACHE = {}
_CACHE_DIR = None


class _SpecFailure(Exception):
    """One mutation set failed before it could become a case."""

    def __init__(self, case_id: str, set_id: str, code: str):
        super().__init__(code)
        self.case_id = case_id
        self.set_id = set_id
        self.code = code


def default_fixtures_root() -> Path:
    """Return the hand-written source-case fixtures directory."""
    return Path(__file__).resolve().parents[1] / 'corpus' / 'fixtures'


def _label(value, fallback: str) -> str:
    if isinstance(value, str) and _ID_RE.fullmatch(value):
        return value
    if _ID_RE.fullmatch(fallback):
        return fallback
    return 'source'


def _public_code(code, fallback: str) -> str:
    if isinstance(code, str) and _CODE_RE.fullmatch(code):
        return code
    return fallback


def _text(value) -> str:
    if isinstance(value, str):
        return value
    return ''


def _page_index(value) -> int:
    if type(value) is int and value >= 0:
        return value
    return 0


def _ids_from_path(spec_path: Path) -> tuple[str, str]:
    return _label(spec_path.parent.parent.name, 'source'), _label(spec_path.stem, 'set')


def _toolchain_gaps() -> list[str]:
    gaps = []
    if shutil.which('pdflatex') is None:
        gaps.append('pdflatex_missing')
    if importlib.util.find_spec('pymupdf') is None:
        gaps.append('pymupdf_missing')
    if importlib.util.find_spec('matplotlib') is None:
        gaps.append('matplotlib_missing')
    return gaps


def _skipped(reasons) -> dict:
    return {
        'built': [],
        'refused': [],
        'skipped': [{'reason': reason} for reason in reasons],
    }


def _empty_status() -> dict:
    return {'built': [], 'refused': [], 'skipped': []}


def _work_dir() -> Path:
    global _CACHE_DIR
    if _CACHE_DIR is None:
        _CACHE_DIR = Path(tempfile.mkdtemp(prefix='falsify-bench-v5-'))
    return _CACHE_DIR


def _import_corpus():
    corpus = Path(__file__).resolve().parents[1] / 'corpus'
    entry = str(corpus)
    if entry not in sys.path:
        sys.path.append(entry)
    import source_mutator
    import twin_gate
    return source_mutator, twin_gate


def _stealth(defect: dict, ledger: dict):
    if isinstance(defect.get('stealthPass'), bool):
        return defect['stealthPass']
    if isinstance(ledger.get('stealthPass'), bool):
        return ledger['stealthPass']
    return None


def _scoring_defect(defect: dict, ledger: dict) -> dict:
    quote = _text(defect.get('quote')) or _text(defect.get('excerpt')) or _text(defect.get('after'))
    item = {
        'defectId': _label(defect.get('defectId'), 'source-defect'),
        'world': _text(defect.get('world')).strip().upper(),
        'family': _text(defect.get('family')).strip().upper(),
        'difficulty': _text(defect.get('difficulty')).strip().upper(),
        'pageIndex': _page_index(defect.get('pageIndex')),
        'excerpt': quote,
        'quote': quote,
        'stealthPass': _stealth(defect, ledger),
    }
    after = _text(defect.get('after'))
    before = _text(defect.get('before'))
    if after:
        item['after'] = after
    if before:
        item['before'] = before
    return item


def _bundle_ids(bundle: dict, ledger: dict) -> tuple[str, str]:
    case_id = _label(bundle.get('caseId'), _label(ledger.get('caseId'), 'source-case'))
    set_id = _label(bundle.get('mutationSetId'), _label(ledger.get('mutationSetId'), 'set'))
    return case_id, set_id


def _restore_signal(item: dict) -> dict:
    if item.get('excerpt') or item.get('quote') or item.get('detail'):
        return item
    texts = item.get('texts')
    text = texts[0] if isinstance(texts, list) and texts else ''
    return {
        'id': item.get('signalId') or item.get('id'),
        'pageIndex': item.get('pageIndex'),
        'excerpt': text,
        'bbox': item.get('bbox'),
        'itemId': item.get('itemId'),
        'supplementName': item.get('supplementName'),
    }


def _signal_items(payload):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return None
    items = payload.get('signals')
    if isinstance(items, list):
        return items
    items = payload.get('findings')
    if isinstance(items, list):
        return items
    return None


def _restore_baseline(payload):
    items = _signal_items(payload)
    if items is None:
        return None
    restored = [_restore_signal(item) for item in items if isinstance(item, dict)]
    return {'signals': restored}


def _pdf_bytes(bundle: dict):
    pdf = bundle.get('blindPdfBytes')
    if pdf is None:
        pdf = bundle.get('blindPdf')
    if isinstance(pdf, bytearray):
        return bytes(pdf)
    if isinstance(pdf, bytes):
        return pdf
    return None


def case_from_source_bundle(bundle: dict) -> dict:
    """Map a gate bundle dict onto one ``build_benchmark_corpus`` case."""
    if not isinstance(bundle, dict):
        raise ValueError('bundle_invalid')
    pdf = _pdf_bytes(bundle)
    ledger = bundle.get('goldLedger')
    if pdf is None or not isinstance(ledger, dict):
        raise ValueError('bundle_invalid')
    raw_defects = ledger.get('defects')
    if not isinstance(raw_defects, list):
        raise ValueError('bundle_invalid')
    defects = [_scoring_defect(item, ledger) for item in raw_defects if isinstance(item, dict)]
    if not defects:
        raise ValueError('bundle_invalid')
    case_id, set_id = _bundle_ids(bundle, ledger)
    first = defects[0]
    return {
        'caseId': f'{case_id}--{set_id}',
        'world': first['world'],
        'family': first['family'],
        'difficulty': first['difficulty'],
        'isHoldout': False,
        'blindPdfBytes': pdf,
        'supplements': [],
        'goldLedger': {'schema': _GOLD_SCHEMA, 'defects': defects},
        'baselineSignals': _restore_baseline(bundle.get('baselineSignals')),
        'producer': 'source-native',
    }


def _read_json(path: Path):
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError('bundle_invalid')
    return data


def bundle_dir_to_dict(bundle_dir) -> dict:
    """Read a gate bundle directory into the dict ``case_from_source_bundle`` accepts."""
    root = Path(bundle_dir)
    manifest = _read_json(root / 'manifest.json')
    ledger = _read_json(root / 'sealed' / 'gold-ledger.json')
    return {
        'caseId': manifest.get('caseId') or ledger.get('caseId'),
        'mutationSetId': manifest.get('mutationSetId') or ledger.get('mutationSetId'),
        'blindPdfBytes': (root / 'blind' / 'paper.pdf').read_bytes(),
        'goldLedger': ledger,
        'baselineSignals': _read_json(root / 'sealed' / 'baseline-signals.json'),
    }


def _fresh_slot(cache_dir: Path, case_id: str, set_id: str) -> tuple[Path, Path]:
    slot = cache_dir / case_id / set_id
    if slot.exists():
        shutil.rmtree(slot)
    slot.mkdir(parents=True)
    return slot / 'build', slot / 'bundle'


def _compile_and_verify(spec_path: Path, spec: dict, cache_dir: Path, case_id: str, set_id: str):
    mutator, gate = _import_corpus()
    case_dir = spec_path.parent.parent
    build_dir, bundle_dir = _fresh_slot(cache_dir, case_id, set_id)
    mutator.build_twin(case_dir, spec, build_dir, compile_pdf=True)
    report = gate.verify_twin(build_dir, case_dir, bundle_out=bundle_dir)
    return case_id, set_id, report, bundle_dir


def _execute_spec(spec_path: Path, cache_dir: Path):
    mutator, _gate = _import_corpus()
    try:
        spec = mutator.load_spec(spec_path)
    except Exception as exc:
        case_id, set_id = _ids_from_path(spec_path)
        raise _SpecFailure(case_id, set_id, _public_code(getattr(exc, 'code', None), 'schema_invalid')) from exc
    path_case, path_set = _ids_from_path(spec_path)
    case_id = _label(spec.get('caseId'), path_case)
    set_id = _label(spec.get('mutationSetId'), path_set)
    try:
        return _compile_and_verify(spec_path, spec, cache_dir, case_id, set_id)
    except _SpecFailure:
        raise
    except Exception as exc:
        code = _public_code(getattr(exc, 'code', None), 'build_failed')
        raise _SpecFailure(case_id, set_id, code) from exc


def _gate_codes(report) -> list[str]:
    failures = report.get('failures') if isinstance(report, dict) else None
    codes = []
    for item in failures or []:
        if isinstance(item, dict):
            code = _public_code(item.get('code'), '')
            if code:
                codes.append(code)
    if codes:
        return codes
    return ['gate_refused']


def _refusal(case_id: str, set_id: str, codes) -> dict:
    return {'caseId': case_id, 'mutationSetId': set_id, 'codes': list(codes)}


def _one_result(spec_path: Path, cache_dir: Path):
    try:
        case_id, set_id, report, bundle_dir = _execute_spec(spec_path, cache_dir)
    except _SpecFailure as exc:
        return None, _refusal(exc.case_id, exc.set_id, [exc.code])
    if not isinstance(report, dict) or not report.get('pass'):
        return None, _refusal(case_id, set_id, _gate_codes(report))
    try:
        return case_from_source_bundle(bundle_dir_to_dict(bundle_dir)), None
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        code = _public_code(getattr(exc, 'code', None), 'bundle_invalid')
        return None, _refusal(case_id, set_id, [code])


def _spec_paths(root: Path) -> list[Path]:
    paths = [path for path in root.glob('*/mutations/*.json') if path.is_file()]
    return sorted(paths, key=lambda path: path.relative_to(root).as_posix())


def _load_uncached(root: Path):
    gaps = _toolchain_gaps()
    if gaps:
        return [], _skipped(gaps)
    if not root.is_dir():
        return [], _skipped(['fixtures_missing'])
    cases = []
    refused = []
    cache_dir = _work_dir() / 'sets'
    for spec_path in _spec_paths(root):
        case, refusal = _one_result(spec_path, cache_dir)
        if refusal is not None:
            refused.append(refusal)
        elif case is not None:
            cases.append(case)
    cases.sort(key=lambda item: item['caseId'])
    refused.sort(key=lambda item: (item['caseId'], item['mutationSetId']))
    status = {'built': [item['caseId'] for item in cases], 'refused': refused, 'skipped': []}
    return cases, status


def _cache_key(root: Path) -> str:
    if root.exists():
        return str(root.resolve())
    return str(root)


def load_source_cases(fixtures_root=None):
    """Discover, build, and cache source-native cases for this process."""
    root = Path(fixtures_root) if fixtures_root is not None else default_fixtures_root()
    key = _cache_key(root)
    cached = _CACHE.get(key)
    if cached is not None:
        return cached
    result = _load_uncached(root)
    _CACHE[key] = result
    return result


def convert_mutation_spec(spec_path, *, cache_dir=None):
    """Build one mutation spec. Return ``(case, refusal)`` with one of them None."""
    spec_path = Path(spec_path)
    work = Path(cache_dir) if cache_dir is not None else _work_dir() / 'one'
    return _one_result(spec_path, work)
