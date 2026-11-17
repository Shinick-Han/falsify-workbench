"""Deterministic PDF text extraction into review segments.

Only text blocks are read; document content is never executed.  Segment text preserves the
PDF's page/block reading order and the source hash is exactly
``sha256('\\n\\n'.join(segment texts))``.
"""

from __future__ import annotations

import hashlib

import pymupdf

MAX_PAGES = 5000
MAX_BLOCKS = 50000
MAX_SOURCE_CHARS = 4000000


class PdfInputError(ValueError):
    """Fixed-code PDF intake failure; carries no document text."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _sha256(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def extract_pdf(data, *, max_pages=MAX_PAGES, max_blocks=MAX_BLOCKS,
               max_chars=MAX_SOURCE_CHARS):
    if not isinstance(data, (bytes, bytearray)) or not bytes(data).startswith(b'%PDF-'):
        raise PdfInputError('pdf_corrupt')
    raw = bytes(data)
    try:
        document = pymupdf.open(stream=raw, filetype='pdf')
    except Exception:
        raise PdfInputError('pdf_corrupt') from None
    try:
        if document.needs_pass or document.is_encrypted:
            raise PdfInputError('pdf_encrypted')
        page_count = document.page_count
        if page_count < 1:
            raise PdfInputError('pdf_empty_text')
        if page_count > max_pages:
            raise PdfInputError('pdf_too_large')
        segments = []
        total_chars = 0
        for page_index in range(page_count):
            try:
                blocks = document[page_index].get_text('blocks', sort=True)
            except Exception:
                raise PdfInputError('pdf_corrupt') from None
            block_number = 0
            for block in blocks:
                if len(block) < 7 or block[6] != 0:
                    continue
                text = block[4].strip() if isinstance(block[4], str) else ''
                if not text:
                    continue
                block_number += 1
                total_chars += len(text)
                if len(segments) >= max_blocks or total_chars > max_chars:
                    raise PdfInputError('pdf_too_large')
                segments.append({
                    'id': 'p%d-b%d' % (page_index + 1, block_number),
                    'label': 'page %d' % (page_index + 1),
                    'text': text,
                })
        if not segments:
            raise PdfInputError('pdf_empty_text')
        source_text = '\n\n'.join(segment['text'] for segment in segments)
        if '\0' in source_text:
            raise PdfInputError('pdf_corrupt')
        return {
            'segments': segments,
            'sourceHash': _sha256(source_text),
            'pageCount': page_count,
            'blockCount': len(segments),
            'characters': len(source_text),
        }
    finally:
        document.close()
