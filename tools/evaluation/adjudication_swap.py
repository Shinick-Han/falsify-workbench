"""Order-swapped pre-adjudication for BLUE findings that matched no gold defect.

The tool builds two judge packets whose item order and category order differ,
then keeps a preliminary label only when both answers agree. It never calls a
model and never writes a score. A person still confirms every item.

``from-evaluation`` turns an arena evaluation's unmatched findings into that
same packet, using the blind PDF for context and, when given, the source PDF
for the passage in the same place. PyMuPDF is imported only when that command
runs.

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
# evaluate_arena_match writes defectId on matchedPairs and abstainMatchedPairs.
# The other answer-key names are not part of that report and stay refused.
EVALUATION_ANSWER_KEYS = ANSWER_KEY_FIELDS - {'defectid'}
# A BLUE report's `rationale` is that finding's own explanation, not gold.
BLUE_REPORT_KEY_FIELDS = ANSWER_KEY_FIELDS - {'rationale'}
CONTEXT_LIMIT = 1200
_ANCHOR_WORDS = 6
CLAIM_LIMIT = 600
# Joined claim text is the first non-empty of these fields, whitespace-collapsed
# and capped at 600 characters. On a BLUE report, `rationale` is BLUE's own
# explanation and is allowed; prefixes already written by blue_report_validate
# (auto-downgrade, Zero-Drop recovery) are passed through and not stripped.
# Findings, context, source context and responses still refuse `rationale`.
# A plain finding that already has `claim` keeps it.
CLAIM_FIELDS = ('claim', 'rationale', 'suspicion', 'note')
DEFECT_FIELDS = ('defectType', 'family', 'findingType', 'defect_type', 'defectFamily')
BLUE_ID_FIELDS = ('findingId', 'id', 'reportNumber', 'candidateId')
DEFINITIONS = {
    'real_source_defect': (
        'The passage really is inconsistent or wrong, and the same problem is in the '
        'original publication (it was not introduced by the injected changes).'
    ),
    'spin_boundary': (
        'The wording overstates or sits at the edge of spin; a matter of emphasis on '
        'which careful reviewers could disagree, not a factual inconsistency.'
    ),
    'gold_error': (
        'The passage differs from the original publication, or the problem follows from '
        'such a difference, so the answer key may be missing or mislabelling an entry. '
        'Choose it only when source context is shown and differs.'
    ),
    'pure_fp': (
        'The allegation does not hold; the passage is consistent with the rest of the paper.'
    ),
}
_KEY_DEPTH = 16
CSV_COLUMNS = (
    'itemId', 'runId', 'findingId', 'pageIndex', 'quote',
    'categoryA', 'categoryB', 'agreed', 'preliminary', 'label',
    'reasonCode', 'sourceDiffers', 'humanReviewRequired', 'finalCategory',
)


class AdjudicationError(ValueError):
    """Fixed-code failure. ``exit_code`` is the process status."""

    def __init__(self, code: str, exit_code: int = 2) -> None:
        self.code = code
        self.exit_code = exit_code
        super().__init__(code)


def _answer_key_hit(value, fields: frozenset[str], depth: int = 0) -> str | None:
    if depth > _KEY_DEPTH:
        return None
    if isinstance(value, dict):
        return _dict_key_hit(value, fields, depth)
    if isinstance(value, list):
        return _list_key_hit(value, fields, depth)
    return None


def _dict_key_hit(value: dict, fields: frozenset[str], depth: int) -> str | None:
    for key, child in value.items():
        if str(key).lower() in fields:
            return str(key)
        hit = _answer_key_hit(child, fields, depth + 1)
        if hit:
            return hit
    return None


def _list_key_hit(value: list, fields: frozenset[str], depth: int) -> str | None:
    for child in value:
        hit = _answer_key_hit(child, fields, depth + 1)
        if hit:
            return hit
    return None


def _reject_answer_keys(value, fields: frozenset[str] = ANSWER_KEY_FIELDS) -> None:
    if value is None:
        return
    if _answer_key_hit(value, fields):
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


def _collapse(value) -> str:
    if not isinstance(value, str):
        return ''
    return ' '.join(value.replace('\u00ad', '').replace('\x00', ' ').split())


def _reject_evaluation(value) -> None:
    if _answer_key_hit(value, EVALUATION_ANSWER_KEYS):
        raise AdjudicationError('answer_key_field', 3)


def _is_gap_char(ch: str) -> bool:
    return ch == '\x00' or ch.isspace()


def _skip_gap(text: str, index: int) -> int:
    size = len(text)
    while index < size and (text[index] == '\u00ad' or _is_gap_char(text[index])):
        index += 1
    return index


def _collapse_origins(text: str) -> tuple[str, list[int]]:
    """Whitespace-collapsed text, and the original index of each collapsed char."""
    chars: list[str] = []
    origins: list[int] = []
    index = 0
    size = len(text)
    while index < size:
        if text[index] == '\u00ad':
            index += 1
            continue
        if _is_gap_char(text[index]):
            gap_at = index
            index = _skip_gap(text, index)
            if chars:
                chars.append(' ')
                origins.append(gap_at)
            continue
        chars.append(text[index])
        origins.append(index)
        index += 1
    return ''.join(chars), origins


def _fit_window(length: int, start: int, end: int) -> tuple[int, int]:
    if length <= CONTEXT_LIMIT:
        return 0, length
    span = max(0, end - start)
    if span >= CONTEXT_LIMIT:
        return start, min(length, start + CONTEXT_LIMIT)
    extra = CONTEXT_LIMIT - span
    begin = start - (extra // 2)
    finish = end + (extra - extra // 2)
    if begin < 0:
        finish = min(length, finish - begin)
        begin = 0
    if finish > length:
        begin = max(0, begin - (finish - length))
        finish = length
    return begin, finish


def _window(text: str, start: int, end: int) -> str:
    begin, finish = _fit_window(len(text), start, end)
    return text[begin:finish]


def _search_pages(page_index, page_count: int) -> list[int]:
    if type(page_index) is not int:
        return []
    found = []
    seen = set()
    for index in (page_index, page_index - 1, page_index + 1):
        if index < 0 or index >= page_count or index in seen:
            continue
        seen.add(index)
        found.append(index)
    return found


def _span_from_match(text: str, origins: list[int], start: int, needle_len: int) -> tuple[int, int]:
    last = start + needle_len - 1
    return origins[start], min(len(text), origins[last] + 1)


def _hit_on_page(text: str, needle: str) -> dict | None:
    collapsed, origins = _collapse_origins(text)
    found = collapsed.find(needle)
    if found < 0:
        return None
    start, end = _span_from_match(text, origins, found, len(needle))
    return {
        'text': text,
        'collapsed': collapsed,
        'origins': origins,
        'match': found,
        'needle': len(needle),
        'start': start,
        'end': end,
        'context': _window(text, start, end),
    }


def _page_text(document, index: int) -> str:
    text = document[index].get_text('text', sort=True)
    if isinstance(text, str):
        return text
    return ''


def _locate_quote(document, page_index, quote: str):
    needle = _collapse(quote)
    if not needle:
        return None
    for index in _search_pages(page_index, document.page_count):
        hit = _hit_on_page(_page_text(document, index), needle)
        if hit is not None:
            return index, hit
    return None


def _edge_words(collapsed: str, start: int, needle: int) -> tuple[str, str]:
    before = collapsed[:start].strip()
    after = collapsed[start + needle:].strip()
    prefix = ''
    suffix = ''
    if before:
        prefix = ' '.join(before.split(' ')[-_ANCHOR_WORDS:])
    if after:
        suffix = ' '.join(after.split(' ')[:_ANCHOR_WORDS])
    return prefix, suffix


def _skip_one_space(text: str, index: int) -> int:
    if index < len(text) and text[index] == ' ':
        return index + 1
    return index


def _trim_gap_end(collapsed: str, suffix_at: int) -> int:
    if suffix_at > 0 and collapsed[suffix_at - 1] == ' ':
        return suffix_at - 1
    return suffix_at


def _gap_with_both(collapsed: str, prefix: str, suffix: str):
    search = 0
    limit = len(collapsed)
    while search < limit:
        at = collapsed.find(prefix, search)
        if at < 0:
            return None
        start = _skip_one_space(collapsed, at + len(prefix))
        suffix_at = collapsed.find(suffix, start)
        if suffix_at >= 0:
            return start, _trim_gap_end(collapsed, suffix_at)
        search = at + 1
    return None


def _gap_after_prefix(collapsed: str, prefix: str):
    at = collapsed.find(prefix)
    if at < 0:
        return None
    return _skip_one_space(collapsed, at + len(prefix)), len(collapsed)


def _gap_before_suffix(collapsed: str, suffix: str):
    at = collapsed.find(suffix)
    if at < 0:
        return None
    return 0, _trim_gap_end(collapsed, at)


def _gap_between(collapsed: str, prefix: str, suffix: str):
    if prefix and suffix:
        return _gap_with_both(collapsed, prefix, suffix)
    if prefix:
        return _gap_after_prefix(collapsed, prefix)
    if suffix:
        return _gap_before_suffix(collapsed, suffix)
    if collapsed:
        return 0, len(collapsed)
    return None


def _collapsed_window(text: str, origins: list[int], gap: tuple[int, int]) -> str:
    start, end = gap
    if not origins or start >= len(origins):
        return _window(text, len(text), len(text))
    orig_start = origins[start]
    if end <= start:
        return _window(text, orig_start, orig_start)
    last = min(end, len(origins)) - 1
    orig_end = min(len(text), origins[last] + 1)
    return _window(text, orig_start, orig_end)


def _source_context(page_text: str, prefix: str, suffix: str) -> str | None:
    collapsed, origins = _collapse_origins(page_text)
    if not prefix and not suffix:
        if not collapsed:
            return None
        return _window(page_text, 0, len(page_text))
    gap = _gap_between(collapsed, prefix, suffix)
    if gap is None:
        return None
    return _collapsed_window(page_text, origins, gap)


def _source_on_page(document, page_index: int, hit: dict) -> str | None:
    if page_index < 0 or page_index >= document.page_count:
        return None
    prefix, suffix = _edge_words(hit['collapsed'], hit['match'], hit['needle'])
    return _source_context(_page_text(document, page_index), prefix, suffix)


def _row_key(row: dict) -> str:
    return f"{row['runId']}:{row['findingId']}"


def _contexts_for_findings(blind, source, findings: list[dict]):
    context = {}
    source_context = {}
    missing = []
    for row in findings:
        located = _locate_quote(blind, row.get('pageIndex'), row['quote'])
        if located is None:
            missing.append(_row_key(row))
            continue
        page, hit = located
        context[_row_key(row)] = hit['context']
        if source is None:
            continue
        extracted = _source_on_page(source, page, hit)
        if extracted is not None:
            source_context[_row_key(row)] = extracted
    return context, source_context, missing


def _mapping_or_none(mapping: dict) -> dict | None:
    if mapping:
        return mapping
    return None


def _missing_item_ids(findings: list[dict], missing_keys: list[str]) -> set[str]:
    wanted = set(missing_keys)
    found = set()
    for row in findings:
        if _row_key(row) in wanted:
            found.add(_item_id(row['runId'], row['findingId'], row['quote']))
    return found


def _mark_group(items: list, item_ids: set[str]) -> None:
    for item in items:
        if item.get('itemId') in item_ids:
            item.pop('context', None)
            item['quoteNotFound'] = True


def _mark_unlocated(packet: dict, item_ids: set[str]) -> None:
    if not item_ids:
        return
    groups = [packet['items']]
    for block in packet['passes']:
        groups.append(block['items'])
    for group in groups:
        _mark_group(group, item_ids)


def _load_pymupdf():
    try:
        import pymupdf
    except ImportError as exc:
        raise AdjudicationError('dependency_missing', 2) from exc
    return pymupdf


def _close_quietly(document) -> None:
    if document is None:
        return
    close = getattr(document, 'close', None)
    if close is not None:
        close()


def _open_pdf(path: Path):
    module = _load_pymupdf()
    try:
        return module.open(path)
    except Exception as exc:
        raise AdjudicationError('input_invalid', 2) from exc


def _packet_from_pdfs(findings, blind_path, source_path, blue, seed: str) -> dict:
    blind = _open_pdf(blind_path)
    source = None
    try:
        if source_path is not None:
            source = _open_pdf(source_path)
        context, source_context, missing = _contexts_for_findings(blind, source, findings)
    finally:
        _close_quietly(blind)
        _close_quietly(source)
    packet = prepare_packet(
        findings,
        context=_mapping_or_none(context),
        source_context=_mapping_or_none(source_context),
        blue_reports=blue,
        seed=seed,
    )
    _mark_unlocated(packet, _missing_item_ids(findings, missing))
    return packet


def packet_from_evaluation(evaluation, blind_pdf, *, source_pdf=None, blue_reports=None, seed: str = '') -> dict:
    """Same packet as ``prepare``, with context taken from the PDFs."""
    _reject_evaluation(evaluation)
    findings = collect_findings(evaluation)
    source_path = None if source_pdf is None else Path(source_pdf)
    return _packet_from_pdfs(findings, Path(blind_pdf), source_path, blue_reports, seed)


def _capped_field(raw: dict, keys: tuple[str, ...]) -> str:
    for key in keys:
        text = _collapse(raw.get(key))
        if text:
            return text[:CLAIM_LIMIT]
    return ''


def _annotation(raw: dict) -> tuple[str, str]:
    if not isinstance(raw, dict):
        return '', ''
    return _capped_field(raw, CLAIM_FIELDS), _capped_field(raw, DEFECT_FIELDS)


def _prefer(primary: str, fallback: str) -> str:
    if primary:
        return primary
    return fallback


def _filled(own: tuple[str, str], matched) -> tuple[str, str]:
    claim, defect = own
    if matched is None:
        return claim, defect
    extra_claim, extra_defect = _annotation(matched)
    return _prefer(claim, extra_claim), _prefer(defect, extra_defect)


def _blue_finding_id(raw: dict) -> str:
    for key in BLUE_ID_FIELDS:
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return ''


def _report_run(report: dict) -> str:
    value = report.get('runId')
    if isinstance(value, str):
        return value
    return ''


def _finding_run(report_run: str, finding: dict) -> str:
    value = finding.get('runId')
    if isinstance(value, str) and value:
        return value
    return report_run


def _iter_blue(reports):
    if reports is None:
        return
    if not isinstance(reports, list):
        raise AdjudicationError('blue_report_invalid', 2)
    for report in reports:
        if not isinstance(report, dict):
            raise AdjudicationError('blue_report_invalid', 2)
        _reject_answer_keys(report, BLUE_REPORT_KEY_FIELDS)
        findings = report.get('findings', [])
        if not isinstance(findings, list):
            raise AdjudicationError('blue_report_invalid', 2)
        report_run = _report_run(report)
        for finding in findings:
            if not isinstance(finding, dict):
                raise AdjudicationError('blue_report_invalid', 2)
            yield report_run, finding


def _blue_rows(reports) -> list[tuple[str, str, dict]]:
    rows = []
    for report_run, finding in _iter_blue(reports):
        finding_id = _blue_finding_id(finding)
        if finding_id:
            rows.append((_finding_run(report_run, finding), finding_id, finding))
    return rows


def _runs_compatible(packet_run: str, blue_run: str) -> bool:
    if packet_run and blue_run:
        return packet_run == blue_run
    return True


def _match_blue(row: dict, indexed: list) -> dict | None:
    for run_id, finding_id, finding in indexed:
        if finding_id != row['findingId']:
            continue
        if _runs_compatible(row['runId'], run_id):
            return finding
    return None


def _stamp_claim(row: dict, claim: str, defect: str) -> None:
    if claim:
        row['claim'] = claim
    else:
        row['claimMissing'] = True
    if defect:
        row['defectType'] = defect


def _catalog_row(raw, context, source_context, indexed) -> dict:
    row = _normalize_finding(raw)
    claim, defect = _filled(_annotation(raw), _match_blue(row, indexed))
    item_id = _item_id(row['runId'], row['findingId'], row['quote'])
    row['itemId'] = item_id
    row['context'] = _lookup_context(row, item_id, context)
    row['sourceContext'] = _lookup_context(row, item_id, source_context)
    _stamp_claim(row, claim, defect)
    return row


def _build_catalog(findings, context, source_context, indexed) -> list[dict]:
    if not isinstance(findings, list):
        raise AdjudicationError('findings_invalid', 2)
    rows = [_catalog_row(item, context, source_context, indexed) for item in findings]
    ids = [row['itemId'] for row in rows]
    if len(ids) != len(set(ids)):
        raise AdjudicationError('duplicate_item', 2)
    return rows


def _category_rows(ids: list[str]) -> list[dict]:
    return [
        {'id': cid, 'label': LABELS[cid], 'definition': DEFINITIONS[cid]}
        for cid in ids
    ]


def _instruction(pass_id: str, categories: list[dict]) -> str:
    listed = '; '.join(f"{row['id']}: {row['definition']}" for row in categories)
    shape = (
        '{"schema": "%s", "passId": "%s", "verdicts": [{"itemId","category","reason"}]}'
        % (RESPONSE_SCHEMA, pass_id)
    )
    return (
        f'Pass {pass_id}. Judge the allegation in claim against quote/context. '
        f'Choose exactly one category id for each item. '
        f'Categories in this pass, with definitions: {listed}. '
        f'You may answer "category": "abstain". '
        f'The answer is preliminary and a person decides. '
        f'Reply with JSON only: {shape}'
    )


def _project(row: dict, base: dict, names: tuple[str, ...]) -> dict:
    item = dict(base)
    for name in names:
        value = row.get(name)
        if value is not None:
            item[name] = value
    return item


def _judge_item(row: dict) -> dict:
    return _project(row, {
        'itemId': row['itemId'],
        'pageIndex': row['pageIndex'],
        'quote': row['quote'],
    }, ('claim', 'defectType', 'claimMissing', 'context', 'sourceContext'))


def _operator_item(row: dict) -> dict:
    return _project(row, {
        'itemId': row['itemId'],
        'runId': row['runId'],
        'findingId': row['findingId'],
        'pageIndex': row['pageIndex'],
        'quote': row['quote'],
    }, ('claim', 'defectType', 'claimMissing', 'sourceContext'))


def _pass_block(pass_id: str, category_ids: list[str], rows: list[dict]) -> dict:
    categories = _category_rows(category_ids)
    return {
        'passId': pass_id,
        'instruction': _instruction(pass_id, categories),
        'categories': categories,
        'items': [_judge_item(row) for row in rows],
    }


def _claim_missing_count(rows: list[dict]) -> int:
    total = 0
    for row in rows:
        if row.get('claimMissing') is True:
            total += 1
    return total


def _assemble_packet(rows: list[dict], seed: str) -> dict:
    item_ids = [row['itemId'] for row in rows]
    by_id = {row['itemId']: row for row in rows}
    order_b = item_order_b(item_ids, seed)
    return {
        'schema': PACKET_SCHEMA,
        'seed': seed,
        'claimMissingCount': _claim_missing_count(rows),
        'items': [_operator_item(row) for row in rows],
        'passes': [
            _pass_block('A', list(CATEGORY_IDS), [by_id[item_id] for item_id in item_ids]),
            _pass_block('B', category_order_b(seed, item_ids), [by_id[item_id] for item_id in order_b]),
        ],
        'modelCalls': 0,
    }


def _optional_mapping(value, code: str) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise AdjudicationError(code, 2)
    _reject_answer_keys(value)


def prepare_packet(findings, *, context=None, source_context=None, blue_reports=None, seed: str = '') -> dict:
    """Two presentation orders of the same findings. Same input, same bytes."""
    if not isinstance(seed, str):
        raise AdjudicationError('seed_invalid', 2)
    _optional_mapping(context, 'context_invalid')
    _optional_mapping(source_context, 'source_context_invalid')
    indexed = _blue_rows(blue_reports)
    return _assemble_packet(_build_catalog(findings, context, source_context, indexed), seed)


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


def _pass_items(block: dict) -> dict[str, dict]:
    items = block.get('items')
    if not isinstance(items, list):
        return {}
    found = {}
    for item in items:
        if isinstance(item, dict) and isinstance(item.get('itemId'), str):
            found[item['itemId']] = item
    return found


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
    _reject_answer_keys(response)
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


def _forced_review(reason: str) -> dict:
    return {
        'agreed': False,
        'preliminary': UNRESOLVED,
        'label': UNRESOLVED_LABEL,
        'reasonCode': reason,
    }


def _agreed_category(cat_a, cat_b):
    if cat_a is None or cat_b is None or cat_a != cat_b or cat_a == ABSTAIN:
        return None
    return cat_a


def _claim_missing(item: dict) -> bool:
    return item.get('claimMissing') is True


def _has_source(item: dict) -> bool:
    value = item.get('sourceContext')
    return isinstance(value, str) and bool(value)


def _decision(cat_a, cat_b, claim_missing: bool, has_source: bool) -> dict:
    if claim_missing:
        return _forced_review('claim_missing')
    agreed = _agreed_category(cat_a, cat_b)
    if agreed == 'gold_error' and not has_source:
        return _forced_review('gold_error_without_source')
    if agreed:
        return {
            'agreed': True,
            'preliminary': agreed,
            'label': LABELS[agreed],
            'reasonCode': None,
        }
    return {
        'agreed': False,
        'preliminary': UNRESOLVED,
        'label': UNRESOLVED_LABEL,
        'reasonCode': _reason_code(cat_a, cat_b),
    }


def _string_field(item: dict, key: str) -> str | None:
    value = item.get(key)
    if isinstance(value, str):
        return value
    return None


def _pair_texts(operator: dict, judge) -> tuple[str | None, str | None]:
    context = _string_field(operator, 'context')
    source = _string_field(operator, 'sourceContext')
    if isinstance(judge, dict):
        if context is None:
            context = _string_field(judge, 'context')
        if source is None:
            source = _string_field(judge, 'sourceContext')
    return context, source


def _source_differs(operator: dict, judge):
    """True when both passages exist and differ after whitespace collapse."""
    context, source = _pair_texts(operator, judge)
    if context is None or source is None:
        return None
    return _collapse(context) != _collapse(source)


def _result_row(item: dict, judge, cat_a, cat_b) -> dict:
    decision = _decision(cat_a, cat_b, _claim_missing(item), _has_source(item))
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
        'sourceDiffers': _source_differs(item, judge),
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


def _preliminary_counts(rows: list[dict]) -> dict[str, int]:
    counts = {cid: 0 for cid in CATEGORY_IDS}
    counts[UNRESOLVED] = 0
    for row in rows:
        preliminary = row['preliminary']
        if preliminary in counts:
            counts[preliminary] += 1
    return counts


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
        'categoryCounts': _preliminary_counts(rows),
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
    judges = _pass_items(_pass_block_by_id(packet, 'A'))
    rows = [
        _result_row(by_id[item_id], judges.get(item_id), choices_a.get(item_id), choices_b.get(item_id))
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


def _optional_json(path):
    if path is None:
        return None
    return _load_json(path)


def _load_blue_reports(paths):
    if not paths:
        return None
    return [_load_json(path) for path in paths]


def _cmd_prepare(args) -> dict:
    packet = prepare_packet(
        _findings_argument(args),
        context=_optional_json(args.context),
        source_context=_optional_json(args.source_context),
        blue_reports=_load_blue_reports(args.blue_report),
        seed=args.seed,
    )
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
        'categoryCounts': summary['categoryCounts'],
        'agreementRate': summary['agreementRate'],
        'orderSensitiveCount': summary['orderSensitiveCount'],
        'modelCalls': summary['modelCalls'],
        'scoreChanged': summary['scoreChanged'],
    }


def _quote_not_found_count(packet: dict) -> int:
    total = 0
    for item in packet['items']:
        if item.get('quoteNotFound') is True:
            total += 1
    return total


def _from_evaluation_summary(packet: dict) -> dict:
    return {
        'ok': True,
        'command': 'from-evaluation',
        'schema': PACKET_SCHEMA,
        'items': len(packet['items']),
        'quoteNotFound': _quote_not_found_count(packet),
        'modelCalls': 0,
    }


def _cmd_from_evaluation(args) -> dict:
    packet = packet_from_evaluation(
        _load_json(args.evaluation),
        args.blind_pdf,
        source_pdf=args.source_pdf,
        blue_reports=_load_blue_reports(args.blue_report),
        seed=args.seed,
    )
    _write_json(args.out, packet)
    return packet


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Order-swapped pre-adjudication of unmatched BLUE findings.')
    sub = parser.add_subparsers(dest='command', required=True)
    prepare = sub.add_parser('prepare')
    source = prepare.add_mutually_exclusive_group(required=True)
    source.add_argument('--evaluation', type=Path)
    source.add_argument('--findings', type=Path)
    prepare.add_argument('--context', type=Path)
    prepare.add_argument('--source-context', type=Path)
    prepare.add_argument('--blue-report', type=Path, action='append')
    prepare.add_argument('--seed', default='')
    prepare.add_argument('--out', type=Path, required=True)
    from_eval = sub.add_parser('from-evaluation')
    from_eval.add_argument('--evaluation', type=Path, required=True)
    from_eval.add_argument('--blind-pdf', type=Path, required=True)
    from_eval.add_argument('--source-pdf', type=Path)
    from_eval.add_argument('--blue-report', type=Path, action='append')
    from_eval.add_argument('--seed', default='')
    from_eval.add_argument('--out', type=Path, required=True)
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
    if args.command == 'from-evaluation':
        _emit(_from_evaluation_summary(_cmd_from_evaluation(args)))
        return 0
    if args.command == 'reconcile':
        _emit(_reconcile_summary(_cmd_reconcile(args)))
        return 0
    _emit(_error_payload(args.command or '', 'command_invalid', 2))
    return 2


def main(argv: list[str] | None = None) -> int:
    """CLI: prepare a swapped packet, fill one from an arena evaluation, or reconcile."""
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
