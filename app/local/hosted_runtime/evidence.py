"""Hosted structured PDF evidence and selected visual/text edit application.

This module is the runtime seam over the existing evidence, table/figure and PDF
engines.  It never invents evidence, never stores document bytes outside the
process, and reports only bounded metadata to artifacts.
"""

from __future__ import annotations

import base64
import hashlib
import threading

MAX_EVIDENCE_DOCUMENTS = 32
EVIDENCE_TTL_SECONDS = 43200
MAX_ARTIFACT_ITEMS = 200
MAX_CAPTION_CHARS = 500

_STORE = None
_ORIGINAL_DEFAULT = None
_USERS = 0
_STORE_LOCK = threading.Lock()


class EvidenceError(ValueError):
    """Fixed-code evidence/apply failure; carries no document text or provider data."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def configure_store():
    """Acquire one runtime-owned EvidenceStore and install it for the existing services.

    The previous module default is restored when the last runtime service closes, so tests and
    embedded uses do not leak the larger store into unrelated code.
    """
    global _STORE, _ORIGINAL_DEFAULT, _USERS
    with _STORE_LOCK:
        if _STORE is None:
            import paper_evidence
            from paper_evidence import EvidenceStore
            _ORIGINAL_DEFAULT = paper_evidence.default_store
            _STORE = EvidenceStore(ttl_seconds=EVIDENCE_TTL_SECONDS,
                                   max_documents=MAX_EVIDENCE_DOCUMENTS)
        import paper_evidence
        paper_evidence.default_store = _STORE
        _USERS += 1
        return _STORE


def release_store():
    """Release one runtime service's use of the shared EvidenceStore."""
    global _USERS
    with _STORE_LOCK:
        if _USERS > 0:
            _USERS -= 1
        if _USERS == 0 and _STORE is not None:
            import paper_evidence
            if paper_evidence.default_store is _STORE:
                paper_evidence.default_store = _ORIGINAL_DEFAULT


def _extraction_code(error):
    code = error.args[0] if error.args and isinstance(error.args[0], str) else ''
    if code in ('over_budget', 'evidence_over_budget'):
        return 'evidence_too_large'
    if code in ('hash_mismatch', 'pdf_invalid', 'hash_invalid'):
        return 'evidence_input_invalid'
    return 'evidence_extraction_failed'


def prepare(store, pdf_bytes, file_hash, *, cancelled=None):
    """Prepare structured evidence; failures are fixed codes, never text-only fallbacks."""
    try:
        summary = store.prepare(pdf_bytes, file_hash, cancelled=cancelled)
    except Exception as error:
        if cancelled is not None and cancelled.is_set():
            raise EvidenceError('evidence_cancelled') from None
        if isinstance(error, ValueError):
            raise EvidenceError(_extraction_code(error)) from None
        raise EvidenceError('evidence_extraction_failed') from None
    if not isinstance(summary, dict) or summary.get('fileHash') != file_hash:
        raise EvidenceError('evidence_extraction_failed')
    return summary


def handle(summary):
    return {'paperId': summary['paperId'], 'fileHash': summary['fileHash']}


def _artifact_items(store, paper_id):
    items = []
    offset = 0
    total = 0
    try:
        while len(items) < MAX_ARTIFACT_ITEMS:
            page = store.list_items(paper_id, offset=offset, limit=50)
            total = page.get('total', 0)
            batch = page.get('items') or []
            for item in batch:
                if len(items) >= MAX_ARTIFACT_ITEMS:
                    break
                caption = item.get('caption')
                items.append({
                    'id': item.get('id'),
                    'type': item.get('type'),
                    'pageIndex': item.get('pageIndex'),
                    'caption': (caption[:MAX_CAPTION_CHARS]
                                if isinstance(caption, str) else None),
                })
            next_offset = page.get('nextOffset')
            if not batch or next_offset is None or next_offset <= offset:
                break
            offset = next_offset
    except (KeyError, ValueError):
        raise EvidenceError('evidence_unavailable') from None
    except Exception:
        raise EvidenceError('evidence_unavailable') from None
    return items, total


def artifact(store, summary):
    """Bounded evidence.json: store summary and ids/types/pages/captions/counts only."""
    items, total = _artifact_items(store, summary['paperId'])
    counts = summary.get('counts') if isinstance(summary.get('counts'), dict) else {}
    if not total:
        total = int(counts.get('tables', 0) or 0) + int(counts.get('figures', 0) or 0)
    return {
        'schema': 'falsify.hosted-evidence.v1',
        'summary': {key: summary.get(key) for key in (
            'schema', 'paperId', 'fileHash', 'status', 'pageCount', 'counts',
            'engine', 'limitations', 'expiresAt')},
        'items': items,
        'coverage': {
            'status': summary.get('status'),
            'listedItems': len(items),
            'totalItems': total,
            'complete': summary.get('status') == 'ready' and len(items) >= total,
            'meaning': ('Structured table/figure evidence prepared from the uploaded PDF. '
                        'Only bounded item metadata is recorded; cell text, image bytes and '
                        'document bytes stay in the evidence store.'),
        },
    }


def _table_position(edit):
    item_id = edit.get('itemId')
    row, column = edit.get('row'), edit.get('column')
    if (not isinstance(item_id, str) or not item_id
            or type(row) is not int or row < 0
            or type(column) is not int or column < 0):
        raise EvidenceError('visual_edit_invalid')
    return item_id, row, column


def _table_cell(store, summary, edit):
    item_id, row, column = _table_position(edit)
    try:
        item = store.read_item(summary['paperId'], item_id)
    except (KeyError, ValueError):
        raise EvidenceError('visual_edit_invalid') from None
    if not isinstance(item, dict) or item.get('type') != 'table':
        raise EvidenceError('visual_edit_invalid')
    table = item.get('table') if isinstance(item.get('table'), dict) else {}
    cell = next((candidate for candidate in (table.get('cells') or [])
                 if candidate.get('row') == row and candidate.get('column') == column), None)
    if cell is None or edit.get('before') != cell.get('text'):
        raise EvidenceError('visual_edit_invalid')
    return item_id, row, column


def _validate_table_replacement(before, after, rationale):
    if (not isinstance(after, str) or len(after) > 4000
            or after == before or '\x00' in after):
        raise EvidenceError('visual_edit_invalid')
    if rationale is not None and (not isinstance(rationale, str)
                                  or len(rationale) > 3000):
        raise EvidenceError('visual_edit_invalid')


def _table_operation(store, summary, edit, index):
    if not isinstance(edit, dict):
        raise EvidenceError('visual_edit_invalid')
    if edit.get('kind') != 'table-cell':
        raise EvidenceError('visual_edit_kind_unsupported')
    item_id, row, column = _table_cell(store, summary, edit)
    before, after = edit.get('before'), edit.get('after')
    _validate_table_replacement(before, after, edit.get('rationale'))
    return {
        'id': 've-%d' % (index + 1),
        'kind': 'table-cell',
        'itemId': item_id,
        'row': row,
        'column': column,
        'before': before,
        'after': after,
    }


def _table_operations(store, summary, visual_edits):
    if visual_edits is None:
        return []
    if not isinstance(visual_edits, list) or len(visual_edits) > 12:
        raise EvidenceError('visual_edit_invalid')
    operations = []
    for index, edit in enumerate(visual_edits):
        operations.append(_table_operation(store, summary, edit, index))
    return operations


def _page_count(raw):
    import pymupdf
    try:
        with pymupdf.open(stream=raw, filetype='pdf') as document:
            return document.page_count
    except Exception:
        raise EvidenceError('apply_verify_failed') from None


def _minimal_changes(changes):
    result = []
    for change in changes if isinstance(changes, list) else []:
        if not isinstance(change, dict):
            continue
        entry = {}
        if isinstance(change.get('id'), str):
            entry['id'] = change['id']
        if type(change.get('pageIndex')) is int:
            entry['pageIndex'] = change['pageIndex']
        result.append(entry)
    return result


def check_text_ambiguity(pdf_bytes, text_edits):
    """Refuse implicit occurrence 0 when a quote has multiple page matches."""
    import pymupdf
    with pymupdf.open(stream=pdf_bytes, filetype='pdf') as document:
        for operation in text_edits:
            if not isinstance(operation, dict):
                raise EvidenceError('apply_edit_invalid')
            if 'spanId' in operation or 'bbox' in operation:
                continue
            page_index = operation.get('pageIndex')
            before = operation.get('before')
            if type(page_index) is not int or not 0 <= page_index < document.page_count \
                    or not isinstance(before, str) or not before:
                continue
            try:
                matches = document[page_index].search_for(before)
            except Exception:
                raise EvidenceError('apply_edit_invalid') from None
            if len(matches) > 1:
                raise EvidenceError('apply_edit_ambiguous')


def _validate_apply_source(summary, visual_edits, source_sha):
    if visual_edits and summary is None:
        raise EvidenceError('apply_source_mismatch')
    if summary is not None and summary.get('fileHash') != source_sha:
        raise EvidenceError('apply_source_mismatch')


def _decode_visual_output(visual_result):
    try:
        return base64.b64decode(visual_result['file'], validate=True)
    except (KeyError, TypeError, ValueError):
        raise EvidenceError('apply_verify_failed') from None


def _verify_visual_result(visual_result, current, source_sha, source_pages, operations):
    if (visual_result.get('sourceSha256') != source_sha
            or visual_result.get('outputSha256') != _sha(current)
            or visual_result.get('pageCount') != source_pages):
        raise EvidenceError('apply_verify_failed')
    verification = visual_result.get('verification')
    if (not isinstance(verification, dict)
            or verification.get('status') != 'passed'):
        raise EvidenceError('apply_verify_failed')
    if len(visual_result.get('changes') or []) != len(operations):
        raise EvidenceError('apply_edit_incomplete')


def _run_visual_edit(store, summary, operations, source_bytes, source_sha,
                     source_pages, revision, cancelled):
    if not operations:
        return source_bytes, None
    from paper_visual_edit import export_visual
    request = {
        'schema': 'falsify.visual-edit-request.v1',
        'paperId': summary['paperId'],
        'fileHash': summary['fileHash'],
        'revision': str(revision),
        'operations': operations,
    }
    try:
        visual_result = export_visual(request, store=store, cancelled=cancelled)
    except Exception:
        if cancelled is not None and cancelled.is_set():
            raise EvidenceError('evidence_cancelled') from None
        raise EvidenceError('visual_edit_invalid') from None
    current = _decode_visual_output(visual_result)
    _verify_visual_result(visual_result, current, source_sha, source_pages, operations)
    return current, visual_result


def _run_text_mutation(current, text_edits, cancelled):
    from paper_text_span_mutator import SpanMutationError, mutate_pdf_text_spans
    check_text_ambiguity(current, list(text_edits))
    try:
        return mutate_pdf_text_spans(current, list(text_edits), allow_trace=False)
    except SpanMutationError as error:
        if cancelled is not None and cancelled.is_set():
            raise EvidenceError('evidence_cancelled') from None
        if getattr(error, 'code', None) == 'text_span_trace_detected':
            raise EvidenceError('apply_edit_trace') from None
        raise EvidenceError('apply_edit_invalid') from None
    except Exception:
        if cancelled is not None and cancelled.is_set():
            raise EvidenceError('evidence_cancelled') from None
        raise EvidenceError('apply_edit_invalid') from None


def _verify_text_result(text_result, current, text_edits):
    output = text_result.get('pdfBytes') if isinstance(text_result, dict) else None
    if (not isinstance(output, (bytes, bytearray))
            or text_result.get('sourceSha256') != _sha(current)
            or text_result.get('outputSha256') != _sha(output)):
        raise EvidenceError('apply_verify_failed')
    if text_result.get('appliedCount') != len(text_edits):
        raise EvidenceError('apply_edit_incomplete')
    return bytes(output)


def _run_text_edit(current, text_edits, cancelled):
    if not text_edits:
        return current, None
    text_result = _run_text_mutation(current, text_edits, cancelled)
    return _verify_text_result(text_result, current, text_edits), text_result


def _verify_output_pdf(current, source_pages):
    if len(current) < 8 or not current.startswith(b'%PDF-') or _page_count(current) != source_pages:
        raise EvidenceError('apply_verify_failed')


def _verification_view(visual_result, text_result):
    verification = {}
    if visual_result:
        detail = visual_result.get('verification') if isinstance(
            visual_result.get('verification'), dict) else {}
        verification['visualStatus'] = detail.get('status')
        verification['visualIssueCount'] = len(detail.get('issues') or [])
        verification['visualChecks'] = list(detail.get('checks') or [])
    if text_result:
        verification['textFallbackCount'] = text_result.get('fallbackCount', 0)
    return verification


def _apply_summary(source_sha, output_sha, source_pages, operations, visual_result,
                   text_edits, text_result):
    visual_changes = _minimal_changes(visual_result.get('changes')) if visual_result else []
    text_changes = _minimal_changes(text_result.get('changes')) if text_result else []
    return {
        'schema': 'falsify.hosted-apply.v1',
        'applyOnly': True,
        'sourceSha256': source_sha,
        'outputSha256': output_sha,
        'pageCount': source_pages,
        'visualEdits': {
            'requested': len(operations),
            'applied': len(visual_changes),
            'rejected': 0,
            'changes': visual_changes,
        },
        'textEdits': {
            'requested': len(text_edits or []),
            'applied': text_result.get('appliedCount', 0) if text_result else 0,
            'rejected': 0,
            'changes': text_changes,
        },
        'verification': _verification_view(visual_result, text_result),
        'meaning': ('Selected table-cell and text-span edits applied to an exact source copy; '
                    'output hash and page count verified. No model call and no token usage.'),
    }


def apply_edits(store, summary, visual_edits, text_edits, source_bytes, revision, *,
                cancelled=None):
    """Apply selected table-cell and text-span edits to an exact source PDF copy."""
    source_sha = _sha(source_bytes)
    _validate_apply_source(summary, visual_edits, source_sha)
    operations = _table_operations(store, summary, visual_edits)
    if not operations and not text_edits:
        raise EvidenceError('apply_no_edits')
    source_pages = _page_count(source_bytes)
    current, visual_result = _run_visual_edit(
        store, summary, operations, source_bytes, source_sha, source_pages,
        revision, cancelled)
    current, text_result = _run_text_edit(current, text_edits, cancelled)
    _verify_output_pdf(current, source_pages)
    output_sha = _sha(current)
    apply_summary = _apply_summary(source_sha, output_sha, source_pages, operations,
                                   visual_result, text_edits, text_result)
    return current, apply_summary
