// Per-candidate arXiv PDF eligibility probe for search filtering.
// Inspects one GET Range: bytes=0-4 response from a caller-provided safe fetchRange(id) callback,
// checks 206 Content-Range total or 200 Content-Length plus the 5-byte %PDF- magic, and cancels
// the body immediately so a full PDF is never downloaded.

const PDF_PREFIX_BYTES = 5;

const verdict = (status, eligible, definitive, sizeBytes, reason) => (
  { status, eligible, definitive, sizeBytes, reason }
);
const transient = () => verdict('transient', true, false, null, 'upstream_unavailable');
const unknown = reason => verdict('unknown', true, false, null, reason);
const invalid = (reason, sizeBytes = null) => verdict('invalid', false, true, sizeBytes, reason);

function parseContentLength(response) {
  const text = response.headers.get('Content-Length')?.trim() ?? '';
  return /^\d{1,12}$/.test(text) ? Number(text) : null;
}

function parseContentRange(response) {
  const text = response.headers.get('Content-Range')?.trim() ?? '';
  const satisfied = /^bytes\s+(\d{1,12})-(\d{1,12})\/(\d{1,12}|\*)$/i.exec(text);
  if (satisfied) {
    const start = Number(satisfied[1]);
    const end = Number(satisfied[2]);
    const total = satisfied[3] === '*' ? null : Number(satisfied[3]);
    if (start > end || (total !== null && end >= total)) return null;
    return { start, end, total };
  }
  const unsatisfied = /^bytes\s+\*\/(\d{1,12})$/i.exec(text);
  return unsatisfied ? { start: null, end: null, total: Number(unsatisfied[1]) } : null;
}

function contentTypeAllowsPdf(response) {
  const type = (response.headers.get('Content-Type') || '').trim().toLowerCase();
  if (!type) return true;
  return type.includes('application/pdf') || type.includes('application/octet-stream');
}

function isUncompressed(response) {
  const encoding = (response.headers.get('Content-Encoding') || '').trim().toLowerCase();
  return encoding === '' || encoding === 'identity';
}

function looksLikePdf(bytes) {
  return bytes !== null
    && bytes.byteLength >= PDF_PREFIX_BYTES
    && new TextDecoder('latin1').decode(bytes.subarray(0, PDF_PREFIX_BYTES)) === '%PDF-';
}

async function cancelBody(response) {
  try {
    if (response?.body) await response.body.cancel();
  } catch {
    // Already consumed or cancelled.
  }
}

// Reads at most 5 bytes and cancels the stream immediately so an upstream that ignores Range
// never causes a full PDF download.
async function readPrefixAndCancel(response) {
  if (!response?.body) return { ok: true, bytes: null };
  const reader = response.body.getReader();
  const out = new Uint8Array(PDF_PREFIX_BYTES);
  let filled = 0;
  try {
    while (filled < PDF_PREFIX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const take = Math.min(PDF_PREFIX_BYTES - filled, value.byteLength);
      out.set(value.subarray(0, take), filled);
      filled += take;
    }
    return { ok: true, bytes: out.subarray(0, filled) };
  } catch {
    return { ok: false, bytes: null };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function sizeVerdict(sizeBytes, cap) {
  if (cap !== null && sizeBytes > cap) {
    return verdict('too_large', false, true, sizeBytes, 'payload_too_large');
  }
  return verdict('ok', true, true, sizeBytes, 'ok');
}

function headerRejection(response) {
  if (response.status === 404 || response.status === 410) {
    return verdict('missing', false, true, null, 'not_found');
  }
  if (response.status === 416) {
    const total = parseContentRange(response)?.total;
    if (total != null && total < PDF_PREFIX_BYTES) return invalid('too_small', total);
    return unknown('range_unsatisfiable');
  }
  if (response.status !== 206 && response.status !== 200) return transient();
  if (!contentTypeAllowsPdf(response)) return invalid('invalid_content_type');
  if (!isUncompressed(response)) return unknown('encoded_response');
  return null;
}

function evaluatePrefix(prefix, sizeBytes, cap) {
  if (!prefix.ok) return transient();
  if (!looksLikePdf(prefix.bytes)) return invalid('invalid_magic', sizeBytes);
  if (sizeBytes !== null) return sizeVerdict(sizeBytes, cap);
  return unknown('size_unknown');
}

async function probePartial(response, cap) {
  const range = parseContentRange(response);
  const prefix = await readPrefixAndCancel(response);
  if (!prefix.ok) return transient();
  if (!range) return unknown('range_unknown');
  if (range.total !== null && range.total < PDF_PREFIX_BYTES) {
    return invalid('too_small', range.total);
  }
  if (range.start !== 0) {
    if (range.total !== null && cap !== null && range.total > cap) {
      return sizeVerdict(range.total, cap);
    }
    return unknown('range_unknown');
  }
  return evaluatePrefix(prefix, range.total, cap);
}

async function probeFull(response, cap) {
  const sizeBytes = parseContentLength(response);
  if (sizeBytes !== null && sizeBytes < PDF_PREFIX_BYTES) {
    await cancelBody(response);
    return invalid('too_small', sizeBytes);
  }
  const prefix = await readPrefixAndCancel(response);
  return evaluatePrefix(prefix, sizeBytes, cap);
}

export async function probePaperPdf(id, { fetchRange, maxBytes } = {}) {
  const cap = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : null;
  if (typeof fetchRange !== 'function') return transient();
  let response;
  try {
    response = await fetchRange(id);
  } catch {
    return transient();
  }
  if (!response || typeof response.status !== 'number' || !response.headers) return transient();
  const early = headerRejection(response);
  if (early) {
    await cancelBody(response);
    return early;
  }
  return response.status === 206 ? probePartial(response, cap) : probeFull(response, cap);
}
