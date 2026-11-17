"""Order-swapped pre-adjudication for BLUE findings that matched no gold defect.

The tool builds two judge packets whose item order and category order differ,
then keeps a preliminary label only when both answers agree. It never calls a
model and never writes a score. A person still confirms every item.

Category ids are the four buckets named for this pass. The review workbench
exports a different eight-way vocabulary (``supported``, ``pre-existing``,
``spin-boundary``, ``gold-error``, ``unsupported``, and three others), so those
machine ids are not reused.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path
import sys


PACKET_SCHEMA = 'falsify.adjudication-swap-packet.v1'
RESPONSE_SCHEMA = 'falsify.adjudication-swap-response.v1'
RESULT_SCHEMA = 'falsify.adjudication-swap.v1'

CATEGORIES = (
    ('real_source_defect', '실제 원문 결함'),
    ('spin_boundary', '스핀/과장 경계'),
    ('gold_error', '정답지 오류 (Gold v2 후보)'),
    ('pure_fp', '순수 오탐'),
)
CATEGORY_IDS = tuple(item[0] for item in CATEGORIES)
LABELS = dict(CATEGORIES)
UNRESOLVED = 'needs_review'
UNRESOLVED_LABEL = '확인필요'
ABSTAIN = 'abstain'
ALLOWED_CATEGORIES = frozenset(CATEGORY_IDS) | {ABSTAIN}
ANSWER_KEY_FIELDS = frozenset({
    'before', 'after', 'gold', 'rationale', 'defectid', 'patch',
    'why_hard', 'candidaterationales',
})
CONTEXT_LIMIT = 1200
_KEY_DEPTH = 16
CSV_COLUMNS = (
    'itemId', 'runId', 'findingId', 'pageIndex', 'quote',
    'categoryA', 'categoryB', 'agreed', 'preliminary', 'label',
    'reasonCode', 'humanReviewRequired', 'finalCategory',
)


class AdjudicationError(ValueError):
    """Fixed-code failure. ``exit_code`` is the process status."""

    def __init__(self, code: str, exit_code: int = 2) -> None:
        self.code = code
        self.exit_code = exit_code
        super().__init__(code)


def _answer_key_hit(value, depth: int = 0) -> str | None:
    if depth > _KEY_DEPTH:
        return None
    if isinstance(value, dict):
        return _dict_key_hit(value, depth)
    if isinstance(value, list):
        return _list_key_hit(value, depth)
    return None


def _dict_key_hit(value: dict, depth: int) -> str | None:
    for key, child in value.items():
        if str(key).lower() in ANSWER_KEY_FIELDS:
            return str(key)
        hit = _answer_key_hit(child, depth + 1)
        if hit:
            return hit
    return None


def _list_key_hit(value: list, depth: int) -> str | None:
    for child in value:
        hit = _answer_key_hit(child, depth + 1)
        if hit:
            return hit
    return None


def _reject_answer_keys(value) -> None:
    if value is None:
        return
    if _answer_key_hit(value):
        raise AdjudicationError('answer_key_field', 3)


def _item_id(run_id: str, finding_id: str, quote: str) -> str:
    blob = f'{run_id}{finding_id}{quote}'.encode('utf-8')
    return hashlib.sha256(blob).hexdigest()[:16]


def _material(seed: str, item_ids: list[str]) -> str:
    payload = json.dumps([seed, item_ids], ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def _ranked(tokens: list[str], material: str, salt: str) -> list[str]:
    decorated = [
        (hashlib.sha256(f'{salt}\0{material}\0{token}'.encode('utf-8')).hexdigest(), index, token)
        for index, token in enumerate(tokens)
    ]
    decorated.sort()
    return [token for _digest, _index, token in decorated]


def _rotate_away(tokens: list[str], material: str, salt: str) -> list[str]:
    if len(tokens) < 2:
        return list(tokens)
    offset = 1 + (hashlib.sha256(f'{salt}\0{material}'.encode('utf-8')).digest()[0] % (len(tokens) - 1))
    return tokens[offset:] + tokens[:offset]


def category_order_b(seed: str, item_ids: list[str]) -> list[str]:
    """Category ids for pass B: never the canonical order, never the same first id."""
    canonical = list(CATEGORY_IDS)
    material = _material(seed, item_ids)
    ranked = _ranked(canonical, material, 'categories')
    if ranked[0] != canonical[0]:
        return ranked
    return _rotate_away(canonical, material, 'category-rotate')


def item_order_b(item_ids: list[str], seed: str) -> list[str]:
    """Item ids for pass B. One item stays put; two or more always move."""
    if len(item_ids) < 2:
        return list(item_ids)
    material = _material(seed, item_ids)
    ranked = _ranked(list(item_ids), material, 'items')
    if ranked != list(item_ids):
        return ranked
    return _rotate_away(list(item_ids), material, 'item-rotate')


def _require_text(value, code: str) -> str:
    if not isinstance(value, str):
        raise AdjudicationError(code, 2)
    return value


def _page_index(value):
    if value is None:
        return None
    if type(value) is not int or value < 0:
        raise AdjudicationError('finding_invalid', 2)
    return value


def _quote_of(raw: dict) -> str:
    if 'quote' in raw:
        return _require_text(raw.get('quote'), 'finding_invalid')
    return _require_text(raw.get('excerpt', ''), 'finding_invalid')


def _finding_id_of(raw: dict) -> str:
    if 'findingId' in raw:
        return _require_text(raw.get('findingId'), 'finding_invalid')
    return _require_text(raw.get('id', ''), 'finding_invalid')


def _normalize_finding(raw) -> dict:
    if not isinstance(raw, dict):
        raise AdjudicationError('finding_invalid', 2)
    _reject_answer_keys(raw)
    finding_id = _finding_id_of(raw)
    if not finding_id:
        raise AdjudicationError('finding_invalid', 2)
    return {
        'runId': _require_text(raw.get('runId', ''), 'finding_invalid'),
        'findingId': finding_id,
        'pageIndex': _page_index(raw.get('pageIndex')),
        'quote': _quote_of(raw),
    }


def _runs_false_positives(runs) -> list:
    found = []
    for run in runs:
        if not isinstance(run, dict):
            raise AdjudicationError('evaluation_invalid', 2)
        rows = run.get('pureFalsePositives', [])
        if not isinstance(rows, list):
            raise AdjudicationError('evaluation_invalid', 2)
        found.extend(rows)
    return found


def collect_findings(evaluation) -> list[dict]:
    """Pure false positives from an arena report, or a plain finding list."""
    if isinstance(evaluation, list):
        return [_normalize_finding(item) for item in evaluation]
    if isinstance(evaluation, dict) and isinstance(evaluation.get('runs'), list):
        return [_normalize_finding(item) for item in _runs_false_positives(evaluation['runs'])]
    if isinstance(evaluation, dict) and isinstance(evaluation.get('pureFalsePositives'), list):
        return [_normalize_finding(item) for item in evaluation['pureFalsePositives']]
    raise AdjudicationError('evaluation_invalid', 2)


def _context_text(value) -> str:
    if isinstance(value, dict):
        _reject_answer_keys(value)
        text = value.get('text')
        if not isinstance(text, str):
            text = value.get('context')
    else:
        text = value
    if not isinstance(text, str):
        raise AdjudicationError('context_invalid', 2)
    return text[:CONTEXT_LIMIT]


def _lookup_context(row: dict, item_id: str, context: dict | None) -> str | None:
    if context is None:
        return None
    for key in (f"{row['runId']}:{row['findingId']}", row['findingId'], item_id):
        if key in context:
            return _context_text(context[key])
    return None


def _catalog_row(raw, context) -> dict:
    row = _normalize_finding(raw)
    item_id = _item_id(row['runId'], row['findingId'], row['quote'])
    row['itemId'] = item_id
    row['context'] = _lookup_context(row, item_id, context)
    return row


def _build_catalog(findings, context) -> list[dict]:
    if not isinstance(findings, list):
        raise AdjudicationError('findings_invalid', 2)
    rows = [_catalog_row(item, context) for item in findings]
    ids = [row['itemId'] for row in rows]
    if len(ids) != len(set(ids)):
        raise AdjudicationError('duplicate_item', 2)
    return rows


def _category_rows(ids: list[str]) -> list[dict]:
    return [{'id': cid, 'label': LABELS[cid]} for cid in ids]


def _instruction(pass_id: str, categories: list[dict]) -> str:
    listed = ', '.join(row['id'] for row in categories)
    shape = (
        '{"schema": "%s", "passId": "%s", "verdicts": [{"itemId","category","reason"}]}'
        % (RESPONSE_SCHEMA, pass_id)
    )
    return (
        f'Pass {pass_id}. Choose exactly one category id for each item from: {listed}. '
        f'You may answer "category": "abstain". Reply with JSON only: {shape}'
    )


def _judge_item(row: dict) -> dict:
    item = {
        'itemId': row['itemId'],
        'pageIndex': row['pageIndex'],
        'quote': row['quote'],
    }
    if row.get('context') is not None:
        item['context'] = row['context']
    return item


def _operator_item(row: dict) -> dict:
    return {
        'itemId': row['itemId'],
        'runId': row['runId'],
        'findingId': row['findingId'],
        'pageIndex': row['pageIndex'],
        'quote': row['quote'],
    }


def _pass_block(pass_id: str, category_ids: list[str], rows: list[dict]) -> dict:
    categories = _category_rows(category_ids)
    return {
        'passId': pass_id,
        'instruction': _instruction(pass_id, categories),
        'categories': categories,
        'items': [_judge_item(row) for row in rows],
    }


def _assemble_packet(rows: list[dict], seed: str) -> dict:
    item_ids = [row['itemId'] for row in rows]
    by_id = {row['itemId']: row for row in rows}
    order_b = item_order_b(item_ids, seed)
    return {
        'schema': PACKET_SCHEMA,
        'seed': seed,
        'items': [_operator_item(row) for row in rows],
        'passes': [
            _pass_block('A', list(CATEGORY_IDS), [by_id[item_id] for item_id in item_ids]),
            _pass_block('B', category_order_b(seed, item_ids), [by_id[item_id] for item_id in order_b]),
        ],
        'modelCalls': 0,
    }


def prepare_packet(findings, *, context=None, seed: str = '') -> dict:
    """Two presentation orders of the same findings. Same input, same bytes."""
    if not isinstance(seed, str):
        raise AdjudicationError('seed_invalid', 2)
    if context is not None and not isinstance(context, dict):
        raise AdjudicationError('context_invalid', 2)
    _reject_answer_keys(context)
    return _assemble_packet(_build_catalog(findings, context), seed)


def _known_item_ids(packet: dict) -> list[str]:
    items = packet.get('items')
    if not isinstance(items, list):
        raise AdjudicationError('packet_invalid', 2)
    ids = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('itemId'), str):
            raise AdjudicationError('packet_invalid', 2)
        ids.append(item['itemId'])
    if len(ids) != len(set(ids)):
        raise AdjudicationError('packet_invalid', 2)
    return ids


def _pass_block_by_id(packet: dict, pass_id: str) -> dict:
    passes = packet.get('passes')
    if not isinstance(passes, list):
        raise AdjudicationError('packet_invalid', 2)
    for block in passes:
        if isinstance(block, dict) and block.get('passId') == pass_id:
            return block
    raise AdjudicationError('packet_invalid', 2)


def _category_ids_of(block: dict) -> list[str]:
    rows = block.get('categories')
    if not isinstance(rows, list) or not rows:
        raise AdjudicationError('packet_invalid', 2)
    ids = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id']:
            raise AdjudicationError('packet_invalid', 2)
        ids.append(row['id'])
    return ids


def _one_verdict(raw, known: set[str], seen: set[str]) -> tuple[str, str]:
    if not isinstance(raw, dict):
        raise AdjudicationError('verdict_invalid', 2)
    item_id = raw.get('itemId')
    category = raw.get('category')
    if not isinstance(item_id, str) or item_id not in known:
        raise AdjudicationError('unknown_item', 2)
    if item_id in seen:
        raise AdjudicationError('duplicate_item', 2)
    if category not in ALLOWED_CATEGORIES:
        raise AdjudicationError('unknown_category', 2)
    seen.add(item_id)
    return item_id, category


def _read_response(response, expected_pass: str, known: set[str]) -> dict[str, str]:
    if not isinstance(response, dict):
        raise AdjudicationError('response_invalid', 2)
    if response.get('schema') != RESPONSE_SCHEMA:
        raise AdjudicationError('response_schema', 2)
    if response.get('passId') != expected_pass:
        raise AdjudicationError('pass_id_mismatch', 2)
    verdicts = response.get('verdicts')
    if not isinstance(verdicts, list):
        raise AdjudicationError('verdicts_invalid', 2)
    seen: set[str] = set()
    found = {}
    for raw in verdicts:
        item_id, category = _one_verdict(raw, known, seen)
        found[item_id] = category
    return found


def _reason_code(cat_a, cat_b) -> str:
    if cat_a is None or cat_b is None:
        return 'missing_verdict'
    if cat_a == ABSTAIN or cat_b == ABSTAIN:
        return 'abstained'
    return 'order_sensitive'


def _decision(cat_a, cat_b) -> dict:
    agreed = (
        cat_a is not None
        and cat_b is not None
        and cat_a == cat_b
        and cat_a != ABSTAIN
    )
    if agreed:
        return {
            'agreed': True,
            'preliminary': cat_a,
            'label': LABELS[cat_a],
            'reasonCode': None,
        }
    return {
        'agreed': False,
        'preliminary': UNRESOLVED,
        'label': UNRESOLVED_LABEL,
        'reasonCode': _reason_code(cat_a, cat_b),
    }


def _result_row(item: dict, cat_a, cat_b) -> dict:
    decision = _decision(cat_a, cat_b)
    return {
        'itemId': item['itemId'],
        'runId': item.get('runId', ''),
        'findingId': item.get('findingId', ''),
        'pageIndex': item.get('pageIndex'),
        'quote': item.get('quote', ''),
        'categoryA': cat_a,
        'categoryB': cat_b,
        'agreed': decision['agreed'],
        'preliminary': decision['preliminary'],
        'label': decision['label'],
        'reasonCode': decision['reasonCode'],
        'humanReviewRequired': True,
        'finalCategory': None,
    }


def _round4(value: float) -> float:
    rounded = round(float(value), 4)
    if rounded == 0.0:
        return 0.0
    return rounded


def _pick_rate(choices: dict[str, str], item_ids: list[str], first: str):
    picks = 0
    hits = 0
    for item_id in item_ids:
        category = choices.get(item_id)
        if category is None or category == ABSTAIN:
            continue
        picks += 1
        if category == first:
            hits += 1
    if picks == 0:
        return None
    return _round4(hits / picks)


def _summary(rows: list[dict], rate_a, rate_b) -> dict:
    counts = {cid: 0 for cid in CATEGORY_IDS}
    needs = 0
    agreed = 0
    order_sensitive = 0
    for row in rows:
        if row['agreed']:
            agreed += 1
            counts[row['preliminary']] += 1
        else:
            needs += 1
        if row['reasonCode'] == 'order_sensitive':
            order_sensitive += 1
    total = len(rows)
    rate = None if total == 0 else _round4(agreed / total)
    return {
        'counts': counts,
        'needsReview': needs,
        'agreementRate': rate,
        'orderSensitiveCount': order_sensitive,
        'firstOptionPickRate': {'A': rate_a, 'B': rate_b},
        'modelCalls': 0,
        'scoreChanged': False,
    }


def reconcile(packet, response_a, response_b) -> dict:
    """Keep a preliminary category only when both passes choose the same one."""
    if not isinstance(packet, dict) or packet.get('schema') != PACKET_SCHEMA:
        raise AdjudicationError('packet_invalid', 2)
    item_ids = _known_item_ids(packet)
    known = set(item_ids)
    choices_a = _read_response(response_a, 'A', known)
    choices_b = _read_response(response_b, 'B', known)
    by_id = {item['itemId']: item for item in packet['items']}
    rows = [
        _result_row(by_id[item_id], choices_a.get(item_id), choices_b.get(item_id))
        for item_id in item_ids
    ]
    rate_a = _pick_rate(choices_a, item_ids, _category_ids_of(_pass_block_by_id(packet, 'A'))[0])
    rate_b = _pick_rate(choices_b, item_ids, _category_ids_of(_pass_block_by_id(packet, 'B'))[0])
    return {
        'schema': RESULT_SCHEMA,
        'items': rows,
        'summary': _summary(rows, rate_a, rate_b),
    }


def _csv_cell(value):
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'true' if value else 'false'
    return value


def write_csv(path: Path, result: dict) -> None:
    with path.open('w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS, extrasaction='ignore')
        writer.writeheader()
        for row in result['items']:
            writer.writerow({key: _csv_cell(row.get(key)) for key in CSV_COLUMNS})


def _load_json(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AdjudicationError('input_invalid', 2) from exc


def _write_json(path: Path, payload: dict) -> None:
    Path(path).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(',', ':')) + '\n')


def _error_payload(command: str, code: str, exit_code: int) -> dict:
    return {'ok': False, 'command': command, 'error': code, 'exitCode': exit_code}


def _findings_argument(args) -> list:
    if args.evaluation is not None:
        return collect_findings(_load_json(args.evaluation))
    loaded = _load_json(args.findings)
    if isinstance(loaded, list):
        return loaded
    if isinstance(loaded, dict) and isinstance(loaded.get('findings'), list):
        return loaded['findings']
    raise AdjudicationError('findings_invalid', 2)


def _cmd_prepare(args) -> dict:
    context = _load_json(args.context) if args.context is not None else None
    packet = prepare_packet(_findings_argument(args), context=context, seed=args.seed)
    _write_json(args.out, packet)
    return packet


def _prepare_summary(packet: dict) -> dict:
    return {
        'ok': True,
        'command': 'prepare',
        'schema': PACKET_SCHEMA,
        'items': len(packet['items']),
        'modelCalls': 0,
    }


def _agreed_count(rows: list[dict]) -> int:
    total = 0
    for row in rows:
        if row['agreed']:
            total += 1
    return total


def _cmd_reconcile(args) -> dict:
    result = reconcile(
        _load_json(args.packet),
        _load_json(args.response_a),
        _load_json(args.response_b),
    )
    _write_json(args.out, result)
    if args.csv is not None:
        write_csv(args.csv, result)
    return result


def _reconcile_summary(result: dict) -> dict:
    summary = result['summary']
    return {
        'ok': True,
        'command': 'reconcile',
        'schema': RESULT_SCHEMA,
        'items': len(result['items']),
        'agreed': _agreed_count(result['items']),
        'needsReview': summary['needsReview'],
        'agreementRate': summary['agreementRate'],
        'orderSensitiveCount': summary['orderSensitiveCount'],
        'modelCalls': summary['modelCalls'],
        'scoreChanged': summary['scoreChanged'],
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Order-swapped pre-adjudication of unmatched BLUE findings.')
    sub = parser.add_subparsers(dest='command', required=True)
    prepare = sub.add_parser('prepare')
    source = prepare.add_mutually_exclusive_group(required=True)
    source.add_argument('--evaluation', type=Path)
    source.add_argument('--findings', type=Path)
    prepare.add_argument('--context', type=Path)
    prepare.add_argument('--seed', default='')
    prepare.add_argument('--out', type=Path, required=True)
    reconcile_cmd = sub.add_parser('reconcile')
    reconcile_cmd.add_argument('--packet', type=Path, required=True)
    reconcile_cmd.add_argument('--response-a', type=Path, required=True)
    reconcile_cmd.add_argument('--response-b', type=Path, required=True)
    reconcile_cmd.add_argument('--out', type=Path, required=True)
    reconcile_cmd.add_argument('--csv', type=Path)
    return parser


def _run_command(args) -> int:
    if args.command == 'prepare':
        _emit(_prepare_summary(_cmd_prepare(args)))
        return 0
    if args.command == 'reconcile':
        _emit(_reconcile_summary(_cmd_reconcile(args)))
        return 0
    _emit(_error_payload(args.command or '', 'command_invalid', 2))
    return 2


def main(argv: list[str] | None = None) -> int:
    """CLI: prepare a swapped packet, or reconcile two judge responses."""
    try:
        args = _build_parser().parse_args(argv)
    except SystemExit as exc:
        code = exc.code
        return code if isinstance(code, int) else 2
    command = getattr(args, 'command', '') or ''
    try:
        return _run_command(args)
    except AdjudicationError as error:
        _emit(_error_payload(command, error.code, error.exit_code))
        return error.exit_code
    except TimeoutError:
        _emit(_error_payload(command, 'timeout', 124))
        return 124
    except OSError:
        _emit(_error_payload(command, 'input_invalid', 2))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
