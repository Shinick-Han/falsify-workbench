// Focused offline tests for probePaperPdf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probePaperPdf } from '../src/paper-pdf-probe.mjs';

const CAP = 16 * 1024 * 1024;
const bytes = text => new TextEncoder().encode(text);

test('206 Partial Content verifies %PDF- magic and exact total size against maxBytes', async () => {
  let seenId = null;
  const ok = await probePaperPdf('2503.10497', {
    maxBytes: CAP,
    fetchRange: async id => {
      seenId = id;
      return new Response(bytes('%PDF-'), {
        status: 206,
        headers: { 'Content-Type': 'application/pdf', 'Content-Range': 'bytes 0-4/730780' },
      });
    },
  });
  assert.equal(seenId, '2503.10497');
  assert.deepEqual(ok, { status: 'ok', eligible: true, definitive: true, sizeBytes: 730780, reason: 'ok' });

  const exact = await probePaperPdf('2503.10497', {
    maxBytes: CAP,
    fetchRange: async () => new Response(bytes('%PDF-'), {
      status: 206,
      headers: { 'Content-Type': 'application/pdf', 'Content-Range': `bytes 0-4/${CAP}` },
    }),
  });
  assert.equal(exact.status, 'ok');
  assert.equal(exact.eligible, true);

  const over = await probePaperPdf('2112.10752', {
    maxBytes: CAP,
    fetchRange: async () => new Response(bytes('%PDF-'), {
      status: 206,
      headers: { 'Content-Type': 'application/pdf', 'Content-Range': 'bytes 0-4/40842586' },
    }),
  });
  assert.deepEqual(over, {
    status: 'too_large',
    eligible: false,
    definitive: true,
    sizeBytes: 40842586,
    reason: 'payload_too_large',
  });
});

test('200 OK checks Content-Length and 5-byte magic then cancels stream without downloading body', async () => {
  let pulls = 0;
  let cancelled = false;
  const makeStream = () => new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(pulls === 1 ? bytes('%PDF-1.7\n') : new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });

  const over = await probePaperPdf('2311.17042', {
    maxBytes: CAP,
    fetchRange: async () => new Response(makeStream(), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': '24239957' },
    }),
  });
  assert.deepEqual(over, {
    status: 'too_large',
    eligible: false,
    definitive: true,
    sizeBytes: 24239957,
    reason: 'payload_too_large',
  });
  assert.equal(pulls, 1);
  assert.equal(cancelled, true);

  // Chunked 200 without Content-Length cancels after 5 bytes and stays unknown (not too_large).
  pulls = 0;
  cancelled = false;
  const chunked = await probePaperPdf('2503.00001', {
    maxBytes: CAP,
    fetchRange: async () => new Response(makeStream(), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    }),
  });
  assert.deepEqual(chunked, {
    status: 'unknown',
    eligible: true,
    definitive: false,
    sizeBytes: null,
    reason: 'size_unknown',
  });
  assert.equal(pulls, 1);
  assert.equal(cancelled, true);
});

test('confirmed disallows: 404/410, non-PDF content-type, bad magic, empty body, and tiny 416', async () => {
  for (const status of [404, 410]) {
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const res = await probePaperPdf('0910.4008v2', {
      maxBytes: CAP,
      fetchRange: async () => new Response(stream, { status, headers: { 'Content-Type': 'text/html' } }),
    });
    assert.deepEqual(res, { status: 'missing', eligible: false, definitive: true, sizeBytes: null, reason: 'not_found' });
    assert.equal(cancelled, true);
  }

  const html = await probePaperPdf('2503.00002', {
    maxBytes: CAP,
    fetchRange: async () => new Response(bytes('<html'), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '6000' },
    }),
  });
  assert.deepEqual(html, {
    status: 'invalid',
    eligible: false,
    definitive: true,
    sizeBytes: null,
    reason: 'invalid_content_type',
  });

  const badMagic = await probePaperPdf('2503.00003', {
    maxBytes: CAP,
    fetchRange: async () => new Response(bytes('<html'), {
      status: 206,
      headers: { 'Content-Type': 'application/pdf', 'Content-Range': 'bytes 0-4/9000' },
    }),
  });
  assert.deepEqual(badMagic, {
    status: 'invalid',
    eligible: false,
    definitive: true,
    sizeBytes: 9000,
    reason: 'invalid_magic',
  });

  const emptyBody = await probePaperPdf('2503.00005', {
    maxBytes: CAP,
    fetchRange: async () => new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': '9000' },
    }),
  });
  assert.deepEqual(emptyBody, {
    status: 'invalid',
    eligible: false,
    definitive: true,
    sizeBytes: 9000,
    reason: 'invalid_magic',
  });

  const empty416 = await probePaperPdf('2503.00004', {
    maxBytes: CAP,
    fetchRange: async () => new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */0' } }),
  });
  assert.deepEqual(empty416, {
    status: 'invalid',
    eligible: false,
    definitive: true,
    sizeBytes: 0,
    reason: 'too_small',
  });
});

test('distinguishes verified-header unknown size from unverified ranges and transient failures', async () => {
  const wildcard = await probePaperPdf('2503.00010', {
    maxBytes: CAP,
    fetchRange: async () => new Response(bytes('%PDF-'), {
      status: 206,
      headers: { 'Content-Type': 'application/pdf', 'Content-Range': 'bytes 0-4/*' },
    }),
  });
  assert.deepEqual(wildcard, {
    status: 'unknown',
    eligible: true,
    definitive: false,
    sizeBytes: null,
    reason: 'size_unknown',
  });

  const missingRange = await probePaperPdf('2503.00014', {
    maxBytes: CAP,
    fetchRange: async () => new Response(bytes('<html'), {
      status: 206,
      headers: { 'Content-Type': 'application/pdf' },
    }),
  });
  assert.deepEqual(missingRange, {
    status: 'unknown',
    eligible: true,
    definitive: false,
    sizeBytes: null,
    reason: 'range_unknown',
  });

  const nonzeroRange = await probePaperPdf('2503.00015', {
    maxBytes: CAP,
    fetchRange: async () => new Response(bytes('12345'), {
      status: 206,
      headers: { 'Content-Type': 'application/pdf', 'Content-Range': 'bytes 5-9/9000' },
    }),
  });
  assert.deepEqual(nonzeroRange, {
    status: 'unknown',
    eligible: true,
    definitive: false,
    sizeBytes: null,
    reason: 'range_unknown',
  });

  const gzip = await probePaperPdf('2503.00011', {
    maxBytes: CAP,
    fetchRange: async () => new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00]), {
      status: 206,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Encoding': 'gzip',
        'Content-Range': 'bytes 0-4/9000',
      },
    }),
  });
  assert.deepEqual(gzip, {
    status: 'unknown',
    eligible: true,
    definitive: false,
    sizeBytes: null,
    reason: 'encoded_response',
  });

  for (const status of [429, 500, 503]) {
    const res = await probePaperPdf('2503.00012', {
      maxBytes: CAP,
      fetchRange: async () => new Response('retry', { status }),
    });
    assert.deepEqual(res, {
      status: 'transient',
      eligible: true,
      definitive: false,
      sizeBytes: null,
      reason: 'upstream_unavailable',
    });
  }

  const thrown = await probePaperPdf('2503.00013', {
    maxBytes: CAP,
    fetchRange: async () => { throw new Error('network error'); },
  });
  assert.deepEqual(thrown, {
    status: 'transient',
    eligible: true,
    definitive: false,
    sizeBytes: null,
    reason: 'upstream_unavailable',
  });
});
