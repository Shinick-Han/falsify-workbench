"""Score existing BLUE runs for PDF-edit versus source-native leak dependence.

Each manifest arm is passed to ``arena_runner.evaluate_arena_match``. A trial is
one gold defect scored by one BLUE run. The run detects the defect only when
its rating is ``detected``; ``uncertain`` and ``missed`` are misses. Paired
McNemar observations align those runs by agentId/model label. This tool does
not call a model and does not run BLUE.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
from decimal import Decimal, ROUND_HALF_EVEN, localcontext
from pathlib import Path

_EVAL_DIR = Path(__file__).resolve().parent
if str(_EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(_EVAL_DIR))

from arena_runner import evaluate_arena_match

SCHEMA = 'falsify.leak-dependence.v1'
INPUT_SCHEMA = 'falsify.leak-dependence-input.v1'
ARM_PDF = 'pdf-mutation'
ARM_SOURCE = 'source-native'
ARMS = frozenset({ARM_PDF, ARM_SOURCE})
MIN_CELL = 5
MIN_PAIRS = 10
WILSON_Z = Decimal('1.959963984540054')
_QUANTUM = Decimal('0.000001')
_GOLD_KEYS = ('defects', 'changes', 'entries', 'operations')
_PAIR_KEYS = ('defects', 'entries', 'items')
_RATINGS = frozenset({'detected', 'missed', 'uncertain'})
_BANNED_OUTPUT_KEYS = frozenset({
    'before', 'after', 'rationale', 'operationId', 'overridesApplied',
})
_FORBIDDEN_REASON = (
    'before', 'after', 'rationale', 'defectid', 'operationid', 'overridesapplied',
)
_ARM_HEADER = (
    'arm', 'family', 'difficulty', 'total', 'detected', 'recall',
    'wilsonLow', 'wilsonHigh', 'insufficient',
)
_PAIRED_HEADER = (
    'family', 'difficulty', 'total', 'both', 'neither', 'pdfOnly', 'sourceOnly',
    'pdfRecall', 'sourceRecall', 'pairedRecallDifference', 'mcnemarP', 'insufficient',
)
_UNPAIRED_HEADER = ('pairId', 'arm', 'reason', 'count')
_CSV_COLUMNS = (
    'view', 'arm', 'family', 'difficulty', 'total', 'detected', 'recall',
    'wilsonLow', 'wilsonHigh', 'insufficient', 'both', 'neither', 'pdfOnly',
    'sourceOnly', 'pdfRecall', 'sourceRecall', 'pairedRecallDifference',
    'mcnemarP', 'mcnemarNumerator', 'mcnemarDenominator', 'pairId', 'reason', 'count',
)


class LeakDependenceError(ValueError):
    """Invalid manifest or a comparability refusal. ``code`` is the public error."""

    def __init__(self, code: str, exit_code: int = 2):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise LeakDependenceError('invalid_input') from exc


def _require_text(value, code: str) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise LeakDependenceError(code)


def _is_absolute_text(text: str) -> bool:
    if text.startswith(('/', '\\')):
        return True
    if Path(text).is_absolute():
        return True
    return len(text) >= 2 and text[1] == ':'


def _relative_file(root: Path, value) -> Path:
    text = _require_text(value, 'path_invalid')
    if _is_absolute_text(text):
        raise LeakDependenceError('path_invalid')
    path = (root / text).resolve()
    if not path.is_file():
        raise LeakDependenceError('path_missing')
    return path


def _parse_manifest(doc) -> list[dict]:
    if not isinstance(doc, dict) or doc.get('schema') != INPUT_SCHEMA:
        raise LeakDependenceError('invalid_input')
    arms = doc.get('arms')
    if not isinstance(arms, list) or len(arms) < 2:
        raise LeakDependenceError('single_arm')
    entries = [_parse_entry(item) for item in arms]
    _require_both_kinds(entries)
    _reject_duplicate_arms(entries)
    return entries


def _parse_entry(item) -> dict:
    if not isinstance(item, dict):
        raise LeakDependenceError('invalid_input')
    arm = item.get('arm')
    if arm not in ARMS:
        raise LeakDependenceError('invalid_input')
    blues = item.get('blueRuns')
    if not isinstance(blues, list) or not blues:
        raise LeakDependenceError('invalid_input')
    return {
        'arm': arm,
        'baselineSignals': item.get('baselineSignals'),
        'blueRuns': list(blues),
        'gold': item.get('gold'),
        'pairId': _require_text(item.get('pairId'), 'invalid_input'),
    }


def _require_both_kinds(entries) -> None:
    kinds = {entry['arm'] for entry in entries}
    if kinds != ARMS:
        raise LeakDependenceError('single_arm')


def _reject_duplicate_arms(entries) -> None:
    seen = set()
    for entry in entries:
        key = (entry['pairId'], entry['arm'])
        if key in seen:
            raise LeakDependenceError('duplicate_arm')
        seen.add(key)


def _gold_items(doc) -> list:
    if isinstance(doc, list):
        return doc
    if isinstance(doc, dict):
        for key in _GOLD_KEYS:
            if isinstance(doc.get(key), list):
                return doc[key]
    raise LeakDependenceError('gold_ledger_invalid')


def _axis(raw: dict, key: str) -> str:
    if key == 'family':
        value = raw.get('family') or raw.get('defectType') or raw.get('defect_type') or ''
    else:
        value = raw.get(key) or ''
    return str(value).strip()


def _gold_records(items) -> list[dict]:
    records = []
    seen = set()
    for index, raw in enumerate(items):
        if not isinstance(raw, dict):
            continue
        defect_id = str(raw.get('defectId') or raw.get('id') or f'gold-{index + 1}')
        if defect_id in seen:
            raise LeakDependenceError('duplicate_defect')
        seen.add(defect_id)
        records.append({
            'defectId': defect_id,
            'difficulty': _axis(raw, 'difficulty'),
            'family': _axis(raw, 'family'),
            'raw': raw,
        })
    return records


def _agent_label(raw: dict) -> str:
    parts = []
    agent = raw.get('agentId')
    model = raw.get('model')
    if isinstance(agent, str) and agent.strip():
        parts.append('agentId=' + agent.strip())
    if isinstance(model, str) and model.strip():
        parts.append('model=' + model.strip())
    if parts:
        return '|'.join(parts)
    return 'unlabeled'


def _load_blues(paths) -> tuple[list, list[str]]:
    blues = []
    labels = []
    for path in paths:
        raw = _read_json(path)
        if not isinstance(raw, dict):
            raise LeakDependenceError('invalid_input')
        blues.append(raw)
        labels.append(_agent_label(raw))
    return blues, labels


def _load_baseline(root: Path, value):
    if value is None:
        return None
    return _read_json(_relative_file(root, value))


def _unit_ratings(unit, defect_id: str, run_count: int) -> list[bool] | None:
    if not isinstance(unit, dict) or unit.get('unitId') != defect_id:
        return None
    ratings = unit.get('ratings')
    if not isinstance(ratings, list) or len(ratings) != run_count:
        return None
    if any(rating not in _RATINGS for rating in ratings):
        return None
    return [rating == 'detected' for rating in ratings]


def _flags_from_units(report, defect_ids: list[str]) -> dict[str, list[bool]] | None:
    agreement = report.get('agreement') if isinstance(report, dict) else None
    units = agreement.get('units') if isinstance(agreement, dict) else None
    runs = report.get('runs') if isinstance(report, dict) else None
    if not isinstance(units, list) or not isinstance(runs, list):
        return None
    if len(units) != len(defect_ids):
        return None
    flags = {}
    for unit, defect_id in zip(units, defect_ids):
        ratings = _unit_ratings(unit, defect_id, len(runs))
        if ratings is None:
            return None
        flags[defect_id] = ratings
    return flags


def _id_set(value) -> set[str] | None:
    if not isinstance(value, list):
        return None
    if any(not isinstance(item, str) for item in value):
        return None
    return set(value)


def _matched_ids(value) -> set[str] | None:
    if not isinstance(value, list):
        return None
    found = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get('defectId'), str):
            return None
        found.append(item['defectId'])
    return set(found)


def _run_detected_set(run, defect_ids: list[str]) -> set[str] | None:
    if not isinstance(run, dict):
        return None
    missed = _id_set(run.get('missedDefectIds'))
    matched = _matched_ids(run.get('matchedPairs'))
    if missed is None or matched is None:
        return None
    if not set(defect_ids) <= (missed | matched):
        return None
    if missed & matched:
        return None
    return matched


def _flags_from_run_lists(report, defect_ids: list[str]) -> dict[str, list[bool]] | None:
    runs = report.get('runs') if isinstance(report, dict) else None
    if not isinstance(runs, list):
        return None
    flags = {defect_id: [] for defect_id in defect_ids}
    for run in runs:
        detected = _run_detected_set(run, defect_ids)
        if detected is None:
            return None
        for defect_id in defect_ids:
            flags[defect_id].append(defect_id in detected)
    return flags


def _single_gold(gold_doc, raw: dict):
    if isinstance(gold_doc, list):
        return [raw]
    cloned = dict(gold_doc)
    for key in _GOLD_KEYS:
        if isinstance(cloned.get(key), list):
            cloned[key] = [raw]
            return cloned
    raise LeakDependenceError('gold_ledger_invalid')


def _rescore_one(gold_doc, record, blues, baseline) -> dict[str, list[bool]]:
    try:
        report = evaluate_arena_match(
            _single_gold(gold_doc, record['raw']), blues, baseline_signals=baseline,
        )
    except (TypeError, ValueError) as exc:
        raise LeakDependenceError('evaluation_failed') from exc
    flags = _flags_from_units(report, [record['defectId']])
    if flags is None:
        flags = _flags_from_run_lists(report, [record['defectId']])
    if flags is None:
        raise LeakDependenceError('evaluation_failed')
    return flags


def _rescore_defects(gold_doc, records, blues, baseline) -> dict[str, list[bool]]:
    flags = {}
    for record in records:
        flags.update(_rescore_one(gold_doc, record, blues, baseline))
    return flags


def _evaluate_full(gold_doc, blues, baseline) -> dict:
    try:
        return evaluate_arena_match(gold_doc, blues, baseline_signals=baseline)
    except (TypeError, ValueError) as exc:
        raise LeakDependenceError('evaluation_failed') from exc


def _detect_flags(gold_doc, records, blues, baseline):
    defect_ids = [record['defectId'] for record in records]
    report = _evaluate_full(gold_doc, blues, baseline)
    flags = _flags_from_units(report, defect_ids)
    if flags is not None:
        return flags, 'agreement-units', 1
    flags = _flags_from_run_lists(report, defect_ids)
    if flags is not None:
        return flags, 'run-id-lists', 1
    return _rescore_defects(gold_doc, records, blues, baseline), 'single-defect-rescore', 1 + len(records)


def _require_flag_width(flags, records, width: int) -> None:
    for record in records:
        detected = flags.get(record['defectId'])
        if not isinstance(detected, list) or len(detected) != width:
            raise LeakDependenceError('evaluation_failed')


def _defect_map(records, flags) -> dict:
    return {
        record['defectId']: {
            'detected': list(flags[record['defectId']]),
            'difficulty': record['difficulty'],
            'family': record['family'],
        }
        for record in records
    }


def _safe_reason(value) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    lowered = text.lower()
    if any(token in lowered for token in _FORBIDDEN_REASON):
        return None
    return text


def _pair_items(doc) -> list:
    if not isinstance(doc, dict):
        return []
    for key in _PAIR_KEYS:
        if isinstance(doc.get(key), list):
            return doc[key]
    return []


def _store_reason(reasons: dict, item) -> None:
    if not isinstance(item, dict):
        return
    defect_id = item.get('defectId') or item.get('id')
    if not isinstance(defect_id, str) or not defect_id.strip():
        return
    reason = _safe_reason(item.get('reason', item.get('reasonCode')))
    if reason is None:
        return
    key = defect_id.strip()
    preferred = item.get('status') == 'unsupported'
    current = reasons.get(key)
    if current is None or (preferred and not current['preferred']):
        reasons[key] = {'preferred': preferred, 'reason': reason}


def _pair_reasons(gold_path: Path) -> dict[str, str]:
    pair_path = gold_path.parent / 'pair.json'
    if not pair_path.is_file():
        return {}
    try:
        doc = json.loads(pair_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    reasons = {}
    for item in _pair_items(doc):
        _store_reason(reasons, item)
    return {key: value['reason'] for key, value in reasons.items()}


def _score_entry(entry: dict, root: Path) -> dict:
    gold_path = _relative_file(root, entry['gold'])
    blues, labels = _load_blues([_relative_file(root, item) for item in entry['blueRuns']])
    gold_doc = _read_json(gold_path)
    records = _gold_records(_gold_items(gold_doc))
    baseline = _load_baseline(root, entry['baselineSignals'])
    flags, method, calls = _detect_flags(gold_doc, records, blues, baseline)
    _require_flag_width(flags, records, len(labels))
    return {
        'arm': entry['arm'],
        'calls': calls,
        'defects': _defect_map(records, flags),
        'labels': labels,
        'method': method,
        'pairId': entry['pairId'],
        'reasons': _pair_reasons(gold_path),
    }


def _group_pairs(scored: list[dict]) -> dict[str, dict]:
    groups = {}
    for item in scored:
        groups.setdefault(item['pairId'], {})[item['arm']] = item
    return groups


def _pair_mode(pdf: dict, source: dict, allow_mixed: bool) -> str:
    if sorted(pdf['labels']) == sorted(source['labels']):
        return 'aligned-run'
    if allow_mixed:
        return 'union-per-defect'
    raise LeakDependenceError('arms_not_comparable', 3)


def _aligned_order(labels: list[str]) -> list[int]:
    return sorted(range(len(labels)), key=lambda index: (labels[index], index))


def _observation_flags(pdf_item, source_item, pdf_labels, source_labels, mode: str):
    if mode == 'union-per-defect':
        return [(any(pdf_item['detected']), any(source_item['detected']))]
    pdf_order = _aligned_order(pdf_labels)
    source_order = _aligned_order(source_labels)
    return [
        (pdf_item['detected'][left], source_item['detected'][right])
        for left, right in zip(pdf_order, source_order)
    ]


def _blank_counts() -> dict:
    return {'both': 0, 'neither': 0, 'pdfOnly': 0, 'sourceOnly': 0, 'total': 0}


def _add_pair(counts: dict, pdf_flag: bool, source_flag: bool) -> None:
    counts['total'] += 1
    if pdf_flag and source_flag:
        counts['both'] += 1
    elif pdf_flag:
        counts['pdfOnly'] += 1
    elif source_flag:
        counts['sourceOnly'] += 1
    else:
        counts['neither'] += 1


def _stratum_key(pdf_item, source_item):
    if pdf_item['family'] != source_item['family']:
        return None
    if pdf_item['difficulty'] != source_item['difficulty']:
        return None
    return pdf_item['family'], pdf_item['difficulty']


def _collect_shared(pdf, source, shared, mode, overall, strata) -> int:
    mismatches = 0
    for defect_id in shared:
        pdf_item = pdf['defects'][defect_id]
        source_item = source['defects'][defect_id]
        observations = _observation_flags(
            pdf_item, source_item, pdf['labels'], source['labels'], mode,
        )
        key = _stratum_key(pdf_item, source_item)
        if key is None:
            mismatches += len(observations)
        for pdf_flag, source_flag in observations:
            _add_pair(overall, pdf_flag, source_flag)
            if key is not None:
                _add_pair(strata.setdefault(key, _blank_counts()), pdf_flag, source_flag)
    return mismatches


def _unpaired_row(arm: dict, defect_id: str, reason) -> dict:
    return {
        'arm': arm['arm'],
        'defectId': defect_id,
        'pairId': arm['pairId'],
        'reason': reason,
    }


def _reason_for(arm: dict, other: dict, defect_id: str):
    reason = arm['reasons'].get(defect_id)
    if reason is None:
        return other['reasons'].get(defect_id)
    return reason


def _append_unpaired(arm: dict, other: dict, unpaired: list) -> None:
    shared = set(other['defects'])
    for defect_id in arm['defects']:
        if defect_id in shared:
            continue
        unpaired.append(_unpaired_row(arm, defect_id, _reason_for(arm, other, defect_id)))


def _all_unpaired(arm: dict, unpaired: list) -> None:
    for defect_id in arm['defects']:
        unpaired.append(_unpaired_row(arm, defect_id, arm['reasons'].get(defect_id)))


def _empty_state() -> dict:
    return {
        'mismatches': 0,
        'modes': [],
        'overall': _blank_counts(),
        'pair_count': 0,
        'strata': {},
        'unpaired': [],
    }


def _assemble_group(group: dict, allow_mixed: bool, state: dict) -> None:
    pdf = group.get(ARM_PDF)
    source = group.get(ARM_SOURCE)
    if pdf is None or source is None:
        _all_unpaired(pdf or source, state['unpaired'])
        return
    mode = _pair_mode(pdf, source, allow_mixed)
    state['modes'].append(mode)
    state['pair_count'] += 1
    shared = set(pdf['defects']) & set(source['defects'])
    state['mismatches'] += _collect_shared(
        pdf, source, shared, mode, state['overall'], state['strata'],
    )
    _append_unpaired(pdf, source, state['unpaired'])
    _append_unpaired(source, pdf, state['unpaired'])


def _add_arm_cells(cells: dict, scored: dict) -> None:
    for item in scored['defects'].values():
        key = (scored['arm'], item['family'], item['difficulty'])
        bucket = cells.setdefault(key, {'detected': 0, 'total': 0})
        for flag in item['detected']:
            bucket['total'] += 1
            if flag:
                bucket['detected'] += 1


def _assemble(scored: list[dict], allow_mixed: bool) -> dict:
    state = _empty_state()
    groups = _group_pairs(scored)
    for pair_id in sorted(groups):
        _assemble_group(groups[pair_id], allow_mixed, state)
    cells = {}
    for item in scored:
        _add_arm_cells(cells, item)
    return _report(scored, allow_mixed, state, cells)


def _quantize(value: Decimal) -> str:
    return format(value.quantize(_QUANTUM, rounding=ROUND_HALF_EVEN), 'f')


def proportion(numerator: int, denominator: int):
    """Decimal recall quantized to 6 places, or None when the denominator is 0."""
    if denominator <= 0:
        return None
    return _quantize(Decimal(numerator) / Decimal(denominator))


def _wilson_radicand(p_hat: Decimal, total: Decimal, z2: Decimal) -> Decimal:
    return p_hat * (Decimal(1) - p_hat) / total + z2 / (Decimal(4) * total * total)


def _clamp(value: Decimal, upper: bool = False) -> Decimal:
    if not upper and value < 0:
        return Decimal(0)
    if upper and value > 1:
        return Decimal(1)
    return value


def _wilson_bounds(detected: Decimal, total: Decimal) -> tuple[Decimal, Decimal]:
    z2 = WILSON_Z * WILSON_Z
    denom = Decimal(1) + z2 / total
    center = (detected / total + z2 / (Decimal(2) * total)) / denom
    margin = WILSON_Z * _wilson_radicand(detected / total, total, z2).sqrt() / denom
    return _clamp(center - margin), _clamp(center + margin, upper=True)


def wilson_interval(detected: int, total: int) -> tuple[str, str]:
    """Wilson 95% interval using z = 1.959963984540054, quantized to 6 places."""
    if total <= 0:
        raise ValueError('wilson_total')
    with localcontext() as ctx:
        ctx.prec = 50
        low, high = _wilson_bounds(Decimal(detected), Decimal(total))
    return _quantize(low), _quantize(high)


def mcnemar_exact(pdf_only: int, source_only: int) -> tuple[int, int]:
    """Exact two-sided McNemar p as an unreduced dyadic rational (numerator, 2**n)."""
    discordant = pdf_only + source_only
    if discordant == 0:
        return 1, 1
    observed = math.comb(discordant, pdf_only)
    numerator = sum(
        math.comb(discordant, index)
        for index in range(discordant + 1)
        if math.comb(discordant, index) <= observed
    )
    return numerator, 2 ** discordant


def _fraction(numerator: int, denominator: int) -> str:
    divisor = math.gcd(numerator, denominator)
    return f'{numerator // divisor}/{denominator // divisor}'


def _recall_difference(pdf_detected: int, source_detected: int, total: int):
    if total <= 0:
        return None
    gap = Decimal(pdf_detected) - Decimal(source_detected)
    return _quantize(gap / Decimal(total))


def _finish_cell(total: int, detected: int) -> dict:
    recall = None
    low = None
    high = None
    if total:
        recall = proportion(detected, total)
        low, high = wilson_interval(detected, total)
    return {
        'detected': detected,
        'insufficient': total < MIN_CELL,
        'recall': recall,
        'total': total,
        'wilson95': {'high': high, 'low': low},
    }


def _finish_paired(counts: dict) -> dict:
    total = counts['total']
    pdf_detected = counts['both'] + counts['pdfOnly']
    source_detected = counts['both'] + counts['sourceOnly']
    numerator, denominator = mcnemar_exact(counts['pdfOnly'], counts['sourceOnly'])
    return {
        'both': counts['both'],
        'insufficient': total < MIN_CELL,
        'mcnemarDenominator': denominator,
        'mcnemarNumerator': numerator,
        'mcnemarP': _fraction(numerator, denominator),
        'neither': counts['neither'],
        'pairedRecallDifference': _recall_difference(pdf_detected, source_detected, total),
        'pdfDetected': pdf_detected,
        'pdfOnly': counts['pdfOnly'],
        'pdfRecall': proportion(pdf_detected, total),
        'sourceDetected': source_detected,
        'sourceOnly': counts['sourceOnly'],
        'sourceRecall': proportion(source_detected, total),
        'total': total,
    }


def _cell_rows(cells: dict) -> list[dict]:
    rows = []
    for arm, family, difficulty in sorted(cells):
        row = _finish_cell(cells[(arm, family, difficulty)]['total'], cells[(arm, family, difficulty)]['detected'])
        row['arm'] = arm
        row['difficulty'] = difficulty
        row['family'] = family
        rows.append(row)
    return rows


def _stratum_rows(strata: dict) -> list[dict]:
    rows = []
    for family, difficulty in sorted(strata):
        row = _finish_paired(strata[(family, difficulty)])
        row['difficulty'] = difficulty
        row['family'] = family
        rows.append(row)
    return rows


def _method_label(scored: list[dict]) -> str:
    methods = sorted({item['method'] for item in scored})
    if methods == ['agreement-units']:
        return (
            "agreement.units ratings from one evaluate_arena_match call per arm; "
            "detected means rating == 'detected'; uncertain and missed count as missed"
        )
    if methods == ['run-id-lists']:
        return (
            'runs[].matchedPairs versus missedDefectIds from one evaluate_arena_match call per arm; '
            'uncertain ids sit inside missedDefectIds and count as missed'
        )
    if methods == ['single-defect-rescore']:
        return (
            'single-defect evaluate_arena_match rescore because the full-ledger output did not '
            'expose per-defect ratings; cost is one extra call per gold defect per arm after the first call'
        )
    return 'mixed:' + ','.join(methods)


def _pairing_label(modes: list[str]) -> str:
    unique = sorted(set(modes))
    if not unique:
        return 'none'
    if len(unique) == 1:
        return unique[0]
    return 'mixed'


def _interpretation(pair_count: int, insufficient: bool, paired: dict) -> str:
    reasons = []
    if pair_count < MIN_PAIRS:
        reasons.append(f'fewer than 10 pairs ({pair_count})')
    if insufficient:
        reasons.append('one or more cells have fewer than 5 trials')
    if reasons:
        return 'The comparison is not conclusive: ' + '; '.join(reasons) + '.'
    return (
        f'Across {pair_count} pairs, pdf-mutation recall minus source-native recall is '
        f'{paired["pairedRecallDifference"]} (exact McNemar p = {paired["mcnemarP"]}).'
    )


def _any_insufficient(cells: list[dict], paired: dict, strata: list[dict]) -> bool:
    if paired['insufficient']:
        return True
    if any(cell['insufficient'] for cell in cells):
        return True
    return any(row['insufficient'] for row in strata)


def _scrub(value):
    if isinstance(value, dict):
        return {key: _scrub(item) for key, item in value.items() if key not in _BANNED_OUTPUT_KEYS}
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    return value


def _report(scored, allow_mixed: bool, state: dict, cells: dict) -> dict:
    cell_rows = _cell_rows(cells)
    paired = _finish_paired(state['overall'])
    stratum_rows = _stratum_rows(state['strata'])
    insufficient = _any_insufficient(cell_rows, paired, stratum_rows)
    unpaired = sorted(state['unpaired'], key=lambda row: (row['pairId'], row['arm'], row['defectId']))
    return _scrub({
        'allowMixed': allow_mixed,
        'byArmFamilyDifficulty': cell_rows,
        'evaluationCalls': sum(item['calls'] for item in scored),
        'interpretation': _interpretation(state['pair_count'], insufficient, paired),
        'pairCount': state['pair_count'],
        'paired': paired,
        'pairedByFamilyDifficulty': stratum_rows,
        'pairing': _pairing_label(state['modes']),
        'perDefectOutcomeMethod': _method_label(scored),
        'schema': SCHEMA,
        'strataMismatchTrials': state['mismatches'],
        'uncertainCountsAsMissed': True,
        'unpaired': unpaired,
    })


def evaluate_manifest(manifest_path, *, allow_mixed: bool = False) -> dict:
    """Load a leak-dependence manifest and return a ``falsify.leak-dependence.v1`` report."""
    path = Path(manifest_path)
    entries = _parse_manifest(_read_json(path))
    scored = [_score_entry(entry, path.parent) for entry in entries]
    return _assemble(scored, allow_mixed)


def _md(value) -> str:
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'true' if value else 'false'
    return str(value).replace('|', '/').replace('\n', ' ')


def _markdown_table(header, rows) -> str:
    head = '| ' + ' | '.join(header) + ' |'
    rule = '| ' + ' | '.join('---' for _ in header) + ' |'
    body = ['| ' + ' | '.join(_md(cell) for cell in row) + ' |' for row in rows]
    return '\n'.join([head, rule, *body])


def _arm_markdown_row(row: dict) -> tuple:
    wilson = row['wilson95']
    return (
        row['arm'], row['family'], row['difficulty'], row['total'], row['detected'],
        row['recall'], wilson['low'], wilson['high'], row['insufficient'],
    )


def _paired_markdown_rows(report: dict) -> list[dict]:
    rows = [dict(row) for row in report['pairedByFamilyDifficulty']]
    overall = dict(report['paired'])
    overall['difficulty'] = 'all'
    overall['family'] = 'all'
    rows.append(overall)
    return rows


def _paired_markdown_row(row: dict) -> tuple:
    return (
        row['family'], row['difficulty'], row['total'], row['both'], row['neither'],
        row['pdfOnly'], row['sourceOnly'], row['pdfRecall'], row['sourceRecall'],
        row['pairedRecallDifference'], row['mcnemarP'], row['insufficient'],
    )


def _unpaired_counts(report: dict) -> list[dict]:
    counts = {}
    for row in report['unpaired']:
        key = (row['pairId'], row['arm'], row['reason'] or '')
        counts[key] = counts.get(key, 0) + 1
    rows = []
    for pair_id, arm, reason in sorted(counts):
        rows.append({
            'arm': arm,
            'count': counts[(pair_id, arm, reason)],
            'pairId': pair_id,
            'reason': reason,
        })
    return rows


def _unpaired_markdown_row(row: dict) -> tuple:
    return row['pairId'], row['arm'], row['reason'], row['count']


def render_markdown(report: dict) -> str:
    """One table each for arm cells, the paired view, and unpaired counts."""
    parts = [
        '# Leak dependence',
        '',
        report['interpretation'],
        '',
        '## Arm by family and difficulty',
        '',
        _markdown_table(_ARM_HEADER, [_arm_markdown_row(row) for row in report['byArmFamilyDifficulty']]),
        '',
        '## Paired comparison',
        '',
        _markdown_table(_PAIRED_HEADER, [_paired_markdown_row(row) for row in _paired_markdown_rows(report)]),
        '',
        '## Unpaired',
        '',
        _markdown_table(_UNPAIRED_HEADER, [_unpaired_markdown_row(row) for row in _unpaired_counts(report)]),
        '',
    ]
    return '\n'.join(parts)


def _csv_text(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if value is None:
        return ''
    return value


def _csv_arm(row: dict) -> dict:
    wilson = row['wilson95']
    return {
        'arm': row['arm'],
        'detected': row['detected'],
        'difficulty': row['difficulty'],
        'family': row['family'],
        'insufficient': _csv_text(row['insufficient']),
        'recall': _csv_text(row['recall']),
        'total': row['total'],
        'view': 'cell',
        'wilsonHigh': _csv_text(wilson['high']),
        'wilsonLow': _csv_text(wilson['low']),
    }


def _csv_paired(view: str, row: dict) -> dict:
    return {
        'both': row['both'],
        'difficulty': row['difficulty'],
        'family': row['family'],
        'insufficient': _csv_text(row['insufficient']),
        'mcnemarDenominator': row['mcnemarDenominator'],
        'mcnemarNumerator': row['mcnemarNumerator'],
        'mcnemarP': row['mcnemarP'],
        'neither': row['neither'],
        'pairedRecallDifference': _csv_text(row['pairedRecallDifference']),
        'pdfOnly': row['pdfOnly'],
        'pdfRecall': _csv_text(row['pdfRecall']),
        'sourceOnly': row['sourceOnly'],
        'sourceRecall': _csv_text(row['sourceRecall']),
        'total': row['total'],
        'view': view,
    }


def _csv_unpaired(row: dict) -> dict:
    return {
        'arm': row['arm'],
        'count': row['count'],
        'pairId': row['pairId'],
        'reason': row['reason'],
        'view': 'unpaired',
    }


def render_csv(report: dict) -> str:
    """One CSV with a ``view`` column for cells, paired strata, and unpaired counts."""
    buffer = io.StringIO(newline='')
    writer = csv.DictWriter(
        buffer, fieldnames=_CSV_COLUMNS, lineterminator='\n', extrasaction='ignore',
    )
    writer.writeheader()
    for row in report['byArmFamilyDifficulty']:
        writer.writerow(_csv_arm(row))
    for row in report['pairedByFamilyDifficulty']:
        writer.writerow(_csv_paired('paired', row))
    overall = dict(report['paired'])
    overall['difficulty'] = 'all'
    overall['family'] = 'all'
    writer.writerow(_csv_paired('paired-overall', overall))
    for row in _unpaired_counts(report):
        writer.writerow(_csv_unpaired(row))
    return buffer.getvalue()


def dump_report(report: dict) -> str:
    return json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + '\n'


def _emit(payload: dict) -> str:
    text = dump_report(payload)
    sys.stdout.buffer.write(text.encode('utf-8'))
    return text


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Score existing BLUE runs for PDF-edit versus source-native leak dependence.',
    )
    parser.add_argument('manifest', nargs='?', type=Path, help='falsify.leak-dependence-input.v1 file')
    parser.add_argument('--markdown', type=Path, help='Write one Markdown table per view')
    parser.add_argument('--csv', type=Path, help='Write a deterministic CSV of the same views')
    parser.add_argument('--out', type=Path, help='Also write the JSON report to this path')
    parser.add_argument('--allow-mixed', action='store_true', help='Score arms whose BLUE labels differ')
    return parser


def _exit_code(code) -> int:
    if code is None:
        return 0
    return int(code)


def _write_text(path: Path | None, text: str) -> None:
    if path is not None:
        path.write_text(text, encoding='utf-8', newline='\n')


def _write_views(args, report: dict) -> None:
    _write_text(args.markdown, render_markdown(report) if args.markdown is not None else None)
    _write_text(args.csv, render_csv(report) if args.csv is not None else None)


def main(argv: list[str] | None = None) -> int:
    """CLI entry. Exit 0 on a report, 2 on invalid input, 3 when arms are not comparable."""
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return _exit_code(exc.code)
    if args.manifest is None:
        parser.print_usage(sys.stderr)
        return 2
    try:
        report = evaluate_manifest(args.manifest, allow_mixed=args.allow_mixed)
    except LeakDependenceError as exc:
        _emit({'error': exc.code, 'schema': SCHEMA})
        return exc.exit_code
    text = _emit(report)
    _write_text(args.out, text)
    _write_views(args, report)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
