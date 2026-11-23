import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {rewrite, warm} from '../dist/browser-pdf.mjs';

const require = createRequire(import.meta.url);
const pdfOracle = require('./helpers/pdf-oracle.cjs');

// The mission paper is a private local copy (not in the repo or CI). Tests that read it skip without it.
const MISSION_PDF_PATH = [
  process.env.FALSIFY_BOOTH_MISSION_PDF,
  fileURLToPath(new URL('../../data/missions/2309.15217.pdf', import.meta.url)),
].find(p => p && existsSync(p));
const NO_MISSION = MISSION_PDF_PATH ? false : 'FALSIFY_BOOTH_MISSION_PDF is not set';
const missionBytes = MISSION_PDF_PATH ? new Uint8Array(readFileSync(MISSION_PDF_PATH)) : new Uint8Array();

/**
 * Extract structured-text characters & line boxes from a page via MuPDF,
 * returning both raw chars and a helper converting display boxes to page fractions.
 */
function inspectPage(pdfBytes, pageIndex) {
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf').asPDF();
  try {
    const page = doc.loadPage(pageIndex);
    try {
      const bounds = page.getBounds();
      const bx0 = bounds[0], by0 = bounds[1];
      const bw = bounds[2] - bx0, bh = bounds[3] - by0;
      const st = page.toStructuredText('preserve-whitespace');
      const lines = new Map();
      const chars = [];
      let lineId = -1;
      try {
        st.walk({
          beginLine() { lineId += 1; },
          onChar(c, _origin, font, size, quad) {
            try {
              const x0 = Math.min(quad[0], quad[2], quad[4], quad[6]);
              const y0 = Math.min(quad[1], quad[3], quad[5], quad[7]);
              const x1 = Math.max(quad[0], quad[2], quad[4], quad[6]);
              const y1 = Math.max(quad[1], quad[3], quad[5], quad[7]);
              const entry = {c, lineId, size, font: font.getName(), box: [x0, y0, x1, y1]};
              chars.push(entry);
              let arr = lines.get(lineId);
              if (!arr) { arr = []; lines.set(lineId, arr); }
              arr.push(entry);
            } finally {
              font.destroy();
            }
          },
        });
        const text = st.asText();
        const toFrac = ([x0, y0, x1, y1]) => ({
          x: (x0 - bx0) / bw,
          y: (y0 - by0) / bh,
          w: (x1 - x0) / bw,
          h: (y1 - y0) / bh,
        });
        const lineList = [...lines.entries()].map(([id, arr]) => {
          const drawn = arr.filter(ch => ch.c.trim());
          const src = drawn.length ? drawn : arr;
          const box = [
            Math.min(...src.map(ch => ch.box[0])),
            Math.min(...src.map(ch => ch.box[1])),
            Math.max(...src.map(ch => ch.box[2])),
            Math.max(...src.map(ch => ch.box[3])),
          ];
          return {id, text: arr.map(ch => ch.c).join(''), chars: arr, box, frac: toFrac(box)};
        });
        return {bounds, text, chars, lines: lineList, toFrac};
      } finally {
        st.destroy();
      }
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/**
 * Find every occurrence of `needle` inside MuPDF structured-text lines and return its page-fraction rect.
 */
function findStructuredRects(pdfBytes, pageIndex, needle) {
  const info = inspectPage(pdfBytes, pageIndex);
  const results = [];
  for (const line of info.lines) {
    let from = 0;
    while (from <= line.text.length) {
      const at = line.text.indexOf(needle, from);
      if (at < 0) break;
      from = at + needle.length;
      const slice = line.chars.slice(at, at + needle.length).filter(ch => ch.c.trim());
      if (!slice.length) continue;
      const box = [
        Math.min(...slice.map(ch => ch.box[0])),
        Math.min(...slice.map(ch => ch.box[1])),
        Math.max(...slice.map(ch => ch.box[2])),
        Math.max(...slice.map(ch => ch.box[3])),
      ];
      results.push({rect: info.toFrac(box), box, lineText: line.text});
    }
  }
  return results;
}

/**
 * R2 oracle: open output PDF with MuPDF, verify valid %PDF-, no NUL bytes, page count,
 * extract text and search, and read raw /Contents stream bytes per page.
 */
function readOracle(pdfBytes) {
  assert.ok(pdfBytes instanceof Uint8Array, 'output must be Uint8Array');
  assert.equal(String.fromCharCode(...pdfBytes.slice(0, 5)), '%PDF-');
  const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf').asPDF();
  try {
    const pageCount = doc.countPages();
    const pages = [];
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const st = page.toStructuredText('preserve-whitespace');
        let text;
        try {
          text = st.asText();
        } finally {
          st.destroy();
        }
        assert.equal(text.includes('\0'), false, `page ${i + 1} extracted text must not contain NUL bytes`);
        const contentsObj = page.getObject().get('Contents');
        const streams = [];
        const decodedStreams = [];
        const pushStream = (obj) => {
          const resolved = obj.resolve();
          if (resolved.isStream()) {
            const raw = resolved.readRawStream();
            try { streams.push(raw.asUint8Array().slice()); } finally { raw.destroy(); }
            const dec = resolved.readStream();
            try { decodedStreams.push(Buffer.from(dec.asUint8Array()).toString('latin1')); } finally { dec.destroy(); }
          }
        };
        if (contentsObj.isArray()) {
          for (let j = 0; j < contentsObj.length; j++) pushStream(contentsObj.get(j));
        } else if (!contentsObj.isNull()) {
          pushStream(contentsObj);
        }
        pages.push({
          text,
          streams,
          decodedText: decodedStreams.join('\n'),
          search(needle) {
            const d2 = mupdf.Document.openDocument(pdfBytes, 'application/pdf').asPDF();
            try {
              const p2 = d2.loadPage(i);
              try { return p2.search(needle).length; } finally { p2.destroy(); }
            } finally {
              d2.destroy();
            }
          },
        });
      } finally {
        page.destroy();
      }
    }
    return {pageCount, pages};
  } finally {
    doc.destroy();
  }
}

function streamsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) {
      if (a[i][j] !== b[i][j]) return false;
    }
  }
  return true;
}

const sourceOracle = MISSION_PDF_PATH ? readOracle(missionBytes) : null;

test('page 5: 0.95 -> 0.50 and only the second 0.52 -> 0.11 by rect geometry, untouched pages byte-identical', {skip: NO_MISSION}, async () => {
  const hits095 = findStructuredRects(missionBytes, 4, '0.95');
  const hits052 = findStructuredRects(missionBytes, 4, '0.52');
  assert.equal(hits095.length, 1);
  assert.equal(hits052.length, 2);

  const out = await rewrite(missionBytes, [
    {id: 'e1', pageIndex: 4, rects: [hits095[0].rect], originalText: '0.95', newText: '0.50', source: 'tap'},
    {id: 'e2', pageIndex: 4, rects: [hits052[1].rect], originalText: '0.52', newText: '0.11', source: 'tap'},
  ]);

  const oracle = readOracle(out);
  assert.equal(oracle.pageCount, sourceOracle.pageCount);
  const p5 = oracle.pages[4];
  assert.equal(p5.search('0.95'), 0, 'original 0.95 must be removed');
  assert.equal(p5.text.includes('0.95'), false, 'original 0.95 must not extract');
  assert.equal(p5.decodedText.includes('0.95'), false, 'original 0.95 must be gone from page content stream');
  assert.ok(p5.search('0.50') >= 1 && p5.text.includes('0.50'), 'replacement 0.50 must be extractable and searchable');
  assert.ok(p5.search('0.11') >= 1 && p5.text.includes('0.11'), 'replacement 0.11 must be extractable and searchable');
  assert.equal(p5.search('0.52'), 1, 'only the second 0.52 must be replaced; first 0.52 stays');

  for (let i = 0; i < oracle.pageCount; i++) {
    if (i === 4) continue;
    assert.equal(streamsEqual(sourceOracle.pages[i].streams, oracle.pages[i].streams), true, `untouched page ${i + 1} content stream must stay byte-identical`);
  }
});

test('page 5: deleting the whole Table 1 caption removes all caption text and preserves surrounding table/body', {skip: NO_MISSION}, async () => {
  const p5Info = inspectPage(missionBytes, 4);
  const captionLines = p5Info.lines.filter(l =>
    l.text.includes('Table 1: Agreement') ||
    l.text.includes('comparisons of faithfulness') ||
    l.text.includes('using the WikEval dataset')
  );
  assert.equal(captionLines.length, 3, 'expected 3 caption lines on page 5');

  const out = await rewrite(missionBytes, [
    {
      id: 'del-caption',
      pageIndex: 4,
      rects: captionLines.map(l => l.frac),
      originalText: captionLines.map(l => l.text).join(' '),
      newText: '',
      source: 'paragraph',
    },
  ]);

  const oracle = readOracle(out);
  const p5 = oracle.pages[4];
  assert.equal(p5.search('Agreement with human annotators'), 0);
  assert.equal(p5.search('Table 1:'), 0);
  assert.equal(p5.text.includes('Agreement with human annotators'), false);
  assert.equal(p5.text.includes('comparisons of faithfulness'), false);
  assert.equal(p5.decodedText.includes('Agreement'), false, 'redacted caption must be gone from content stream');
  assert.equal(p5.decodedText.includes('WikEval'), false, 'redacted WikEval must be gone from content stream');
  // Table values and body prose stay intact
  assert.ok(p5.search('0.95') >= 1);
  assert.ok(p5.search('0.78') >= 1);
  assert.ok(p5.search('5 Experiments') >= 1);

  for (let i = 0; i < oracle.pageCount; i++) {
    if (i === 4) continue;
    assert.equal(streamsEqual(sourceOracle.pages[i].streams, oracle.pages[i].streams), true, `untouched page ${i + 1} content stream must stay byte-identical`);
  }
});

test('page 1: dagger † -> 1 by rect keeps neighboring letters and other daggers intact', {skip: NO_MISSION}, async () => {
  const daggers = findStructuredRects(missionBytes, 0, '†');
  assert.equal(daggers.length, 3);

  const out = await rewrite(missionBytes, [
    {id: 'dagger', pageIndex: 0, rects: [daggers[0].rect], originalText: '†', newText: '1', source: 'tap'},
  ]);

  const oracle = readOracle(out);
  const p1 = oracle.pages[0];
  assert.equal(p1.search('†'), 2, 'only the targeted dagger must be replaced');
  assert.ok(p1.text.includes('Shahul Es'), 'neighboring author name stays intact');
  assert.ok(p1.search('1') >= 1 && p1.text.includes('1'), 'replacement 1 must be extractable');

  for (let i = 1; i < oracle.pageCount; i++) {
    assert.equal(streamsEqual(sourceOracle.pages[i].streams, oracle.pages[i].streams), true, `untouched page ${i + 1} content stream must stay byte-identical`);
  }
});

test('page 4: 95% -> 950 by rect', {skip: NO_MISSION}, async () => {
  const hits = findStructuredRects(missionBytes, 3, '95%');
  assert.equal(hits.length, 1);

  const out = await rewrite(missionBytes, [
    {id: 'pct', pageIndex: 3, rects: [hits[0].rect], originalText: '95%', newText: '950', source: 'tap'},
  ]);

  const oracle = readOracle(out);
  const p4 = oracle.pages[3];
  assert.equal(p4.search('95%'), 0);
  assert.equal(p4.text.includes('95%'), false);
  assert.ok(p4.search('950') >= 1 && p4.text.includes('950'));

  for (let i = 0; i < oracle.pageCount; i++) {
    if (i === 3) continue;
    assert.equal(streamsEqual(sourceOracle.pages[i].streams, oracle.pages[i].streams), true);
  }
});

test('long replacement text (single-rect overflow + multi-rect wrap) never refuses and extracts cleanly', {skip: NO_MISSION}, async () => {
  const hits095 = findStructuredRects(missionBytes, 4, '0.95');
  const p5Info = inspectPage(missionBytes, 4);
  const captionLines = p5Info.lines.filter(l =>
    l.text.includes('Table 1: Agreement') ||
    l.text.includes('comparisons of faithfulness') ||
    l.text.includes('using the WikEval dataset')
  );
  const longSingle = '0.9512345 (extended synthetic confidence interval note)';
  const longMulti = 'Table 1: Greatly expanded multi-line replacement caption verifying that automatic word wrapping flows across all selected line rects and continues cleanly even when the new text is much longer than the original three-line caption on page five.';

  const out = await rewrite(missionBytes, [
    {id: 'long-single', pageIndex: 4, rects: [hits095[0].rect], originalText: '0.95', newText: longSingle, source: 'tap'},
    {id: 'long-multi', pageIndex: 4, rects: captionLines.map(l => l.frac), originalText: 'Table 1', newText: longMulti, source: 'paragraph'},
  ]);

  const oracle = readOracle(out);
  const p5 = oracle.pages[4];
  const flat = p5.text.replace(/\s+/g, ' ');
  assert.equal(p5.search('0.9512345') >= 1, true);
  assert.ok(flat.includes('extended synthetic confidence interval note'));
  assert.ok(flat.includes('Greatly expanded multi-line replacement caption'));
  assert.ok(flat.includes('longer than the original three-line caption on page five.'));
});

test('Hangul replacement extracts exact Unicode via MuPDF', {skip: NO_MISSION}, async () => {
  const hits095 = findStructuredRects(missionBytes, 4, '0.95');
  const hangul = '수정된 정확도 0.50';

  const out = await rewrite(missionBytes, [
    {id: 'ko', pageIndex: 4, rects: [hits095[0].rect], originalText: '0.95', newText: hangul, source: 'tap'},
  ]);

  const oracle = readOracle(out);
  const p5 = oracle.pages[4];
  assert.equal(p5.search('0.95'), 0);
  assert.ok(p5.text.includes('수정된'), 'Hangul word 1 must extract');
  assert.ok(p5.text.includes('정확도'), 'Hangul word 2 must extract');
  assert.ok(p5.search('수정된') >= 1);
  assert.ok(p5.search('0.50') >= 1);
});

test('math symbols ± × ≤ extract exact Unicode via MuPDF', {skip: NO_MISSION}, async () => {
  const hits095 = findStructuredRects(missionBytes, 4, '0.95');
  const expr = '0.50 ± 0.02 × 10 ≤ 6';

  const out = await rewrite(missionBytes, [
    {id: 'sym', pageIndex: 4, rects: [hits095[0].rect], originalText: '0.95', newText: expr, source: 'tap'},
  ]);

  const oracle = readOracle(out);
  const p5 = oracle.pages[4];
  assert.equal(p5.search('0.95'), 0);
  assert.ok(p5.text.includes('±') && p5.search('±') >= 1, '± must extract and be searchable');
  assert.ok(p5.text.includes('×') && p5.search('×') >= 1, '× must extract and be searchable');
  assert.ok(p5.text.includes('≤') && p5.search('≤') >= 1, '≤ must extract and be searchable');
  assert.ok(p5.text.includes('0.50') && p5.text.includes('0.02'));
});

test('never refuses empty-glyph rects or overlapping edits; rejects invalid PDF only with engine_unavailable', {skip: NO_MISSION}, async () => {
  // Empty margin rect (no underlying glyphs) still inserts text
  const outEmpty = await rewrite(missionBytes, [
    {id: 'blank', pageIndex: 0, rects: [{x: 0.02, y: 0.02, w: 0.2, h: 0.02}], originalText: '', newText: 'MARGIN_NOTE', source: 'tap'},
  ]);
  const oracleEmpty = readOracle(outEmpty);
  assert.ok(oracleEmpty.pages[0].text.includes('MARGIN_NOTE'));

  // Overlapping edits on the same rect never throw
  const hits095 = findStructuredRects(missionBytes, 4, '0.95');
  const outOverlap = await rewrite(missionBytes, [
    {id: 'ov1', pageIndex: 4, rects: [hits095[0].rect], originalText: '0.95', newText: '0.40', source: 'tap'},
    {id: 'ov2', pageIndex: 4, rects: [hits095[0].rect], originalText: '0.95', newText: '0.60', source: 'tap'},
  ]);
  const oracleOverlap = readOracle(outOverlap);
  assert.equal(oracleOverlap.pages[4].search('0.95'), 0);
  assert.ok(oracleOverlap.pages[4].text.includes('0.60'));

  // Invalid bytes -> rejects ONLY with code 'engine_unavailable'
  await assert.rejects(rewrite(new Uint8Array([1, 2, 3]), []), err => {
    assert.equal(err.code, 'engine_unavailable');
    return true;
  });

  // warm() resolves cleanly
  assert.equal(await warm(), true);
});

test('classic loader warm() pre-spawns worker and rewrite() resolves Uint8Array or rejects engine_unavailable', async () => {
  const loaderSource = readFileSync(new URL('../dist/browser-pdf.js', import.meta.url), 'utf8');
  const workers = [];
  let failStartup = false;
  class StubWorker {
    constructor(url, options) {
      this.url = String(url);
      this.options = options;
      this.terminated = false;
      this.messages = [];
      workers.push(this);
      queueMicrotask(() => {
        if (this.terminated) return;
        if (failStartup) { this.onerror?.(); return; }
        this.onmessage?.({data: {ready: true}});
      });
    }
    postMessage(data, transfer) {
      this.messages.push({data, transfer});
      const reply = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]).buffer;
      queueMicrotask(() => {
        if (!this.terminated) this.onmessage?.({data: {id: data.id, ok: true, op: 'rewrite', bytes: reply}});
      });
    }
    terminate() { this.terminated = true; }
  }

  const prev = {document: globalThis.document, Worker: globalThis.Worker};
  globalThis.document = {currentScript: {src: 'http://127.0.0.1:19900/dist/browser-pdf.js'}};
  globalThis.Worker = StubWorker;
  try {
    vm.runInThisContext(loaderSource, {filename: 'dist/browser-pdf.js'});
    const api = globalThis.FalsifyBrowserPdf;
    assert.equal(workers.length, 0, 'evaluating loader does not spawn worker');
    assert.equal(await api.warm(), true);
    assert.equal(workers.length, 1, 'warm() pre-spawns the persistent worker');

    const src = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const out = await api.rewrite(src, [{pageIndex: 0, rects: [{x: 0.1, y: 0.1, w: 0.1, h: 0.02}], originalText: 'a', newText: 'b'}]);
    assert.equal(workers.length, 1, 'rewrite() reuses the warmed worker');
    assert.ok(out instanceof Uint8Array);
    assert.equal(out.byteLength, 6);
    assert.equal(src.byteLength, 5, 'caller sourceBytes buffer is not neutered');
    assert.equal(workers[0].messages[0].data.op, 'rewrite');

    // Simulate worker offline failure -> warm() resolves false, rewrite() rejects with code 'engine_unavailable'
    workers[0].onerror();
    failStartup = true;
    assert.equal(await api.warm(), false);
    await assert.rejects(api.rewrite(src, []), err => {
      assert.equal(err.code, 'engine_unavailable');
      return true;
    });
  } finally {
    globalThis.document = prev.document;
    globalThis.Worker = prev.Worker;
  }
});

test('page 5 (a): 2-line Ties paragraph randomly -> deterministically extracts contiguously and keeps other text byte-equal', {skip: NO_MISSION}, async () => {
  const p5Info = inspectPage(missionBytes, 4);
  const tiesLines = p5Info.lines.filter(l =>
    l.text.includes('Ties, where the same score') ||
    l.text.includes('broken randomly.')
  );
  assert.equal(tiesLines.length, 2, 'expected 2 lines for the Ties paragraph on page 5');
  const origPara = tiesLines.map(l => l.text).join('\n');
  const newPara = origPara.replace('randomly', 'deterministically');
  assert.notEqual(newPara, origPara);

  const out = await rewrite(missionBytes, [{
    id: 'ties-para',
    pageIndex: 4,
    rects: tiesLines.map(l => l.frac),
    originalText: origPara,
    newText: newPara,
    source: 'paragraph',
  }]);

  const origText = await pdfOracle.extractText(missionBytes, 4);
  const outText = await pdfOracle.extractText(out, 4);
  const expectedContiguous = newPara.replace(/\s+/g, ' ').trim();
  const flatOut = outText.replace(/\s+/g, ' ');

  for (const word of expectedContiguous.split(' ')) {
    assert.equal(outText.includes(word), true, `missing word ${JSON.stringify(word)} from Ties paragraph`);
  }
  assert.equal(flatOut.includes(expectedContiguous), true, 'inserted paragraph must extract as one contiguous readable string');
  assert.ok((await pdfOracle.search(out, 4, 'deterministically')).length >= 1, 'search(pdf, 4, "deterministically") must hit');
  assert.ok((await pdfOracle.search(out, 4, 'broken deterministically.')).length >= 1, 'phrase search must hit');
  assert.equal((await pdfOracle.search(out, 4, 'randomly')).length, 0, 'original "randomly" must be removed');

  // Other text on page 5 outside the replaced paragraph must stay byte-equal in extraction
  const stripOrig = origText.replace(/Ties,[\s\S]*?broken randomly\.\s*/g, '');
  const stripOut = outText.replace(/Ties,[\s\S]*?broken deterministically\.\s*/g, '');
  assert.equal(stripOut, stripOrig, 'other text on page 5 must stay byte-equal outside the replaced paragraph');

  const oracle = readOracle(out);
  for (let i = 0; i < oracle.pageCount; i++) {
    if (i === 4) continue;
    assert.equal(streamsEqual(sourceOracle.pages[i].streams, oracle.pages[i].streams), true, `untouched page ${i + 1} content stream must stay byte-identical`);
  }
});

test('page 5 (b): 10 line rects with newText twice as long extracts every word contiguously (mid-column and bottom-of-page)', {skip: NO_MISSION}, async () => {
  const p5Info = inspectPage(missionBytes, 4);
  const midStart = p5Info.lines.findIndex(l => l.text.includes('Table 1 analyses the agreement'));
  assert.ok(midStart >= 0, 'expected Experiments body paragraph on page 5');
  const midTen = p5Info.lines.slice(midStart, midStart + 10);
  const botTen = p5Info.lines.slice(p5Info.lines.length - 10);
  assert.equal(midTen.length, 10);
  assert.equal(botTen.length, 10);

  for (const [label, slice] of [['mid-10', midTen], ['bottom-10', botTen]]) {
    const orig = slice.map(l => l.text).join('\n');
    const doubled = `${orig}\n${orig.replace(/WikiEval/g, 'DoubledEval').replace(/Ragas/g, 'DoubledRagas')} FINAL_TAIL_MARKER`;
    assert.ok(doubled.length > orig.length * 2, `${label}: newText must be at least 2x original length`);

    const out = await rewrite(missionBytes, [{
      id: label,
      pageIndex: 4,
      rects: slice.map(l => l.frac),
      originalText: orig,
      newText: doubled,
      source: 'paragraph',
    }]);

    const outText = await pdfOracle.extractText(out, 4);
    const flatOut = outText.replace(/\s+/g, ' ');
    const expectedFlat = doubled.replace(/\s+/g, ' ').trim();
    const words = expectedFlat.split(' ');
    for (const word of words) {
      assert.equal(flatOut.includes(word), true, `${label}: missing word ${JSON.stringify(word)}`);
    }
    assert.equal(flatOut.includes(expectedFlat), true, `${label}: full 2x replacement must extract contiguously`);
    assert.ok((await pdfOracle.search(out, 4, 'FINAL_TAIL_MARKER')).length >= 1, `${label}: overflow tail marker must be searchable`);
  }
});

test('page 5 (c): one-word rect with 60-character newText extracts every character (mid-line and right-edge)', {skip: NO_MISSION}, async () => {
  const hits095 = findStructuredRects(missionBytes, 4, '0.95');
  const hitsEspecially = findStructuredRects(missionBytes, 4, 'especially');
  assert.equal(hits095.length, 1);
  assert.ok(hitsEspecially.length >= 1);

  const spaced60 = 'sixty character replacement text replacing one single word!!';
  const unbroken60 = 'supercalifragilistic_replacement_word_spanning_sixty_chars00';
  assert.equal(spaced60.length, 60);
  assert.equal(unbroken60.length, 60);

  for (const [label, targetRect, origWord, nextText] of [
    ['mid-spaced-60', hits095[0].rect, '0.95', spaced60],
    ['right-spaced-60', hitsEspecially[hitsEspecially.length - 1].rect, 'especially', spaced60],
    ['right-unbroken-60', hitsEspecially[hitsEspecially.length - 1].rect, 'especially', unbroken60],
  ]) {
    const out = await rewrite(missionBytes, [{
      id: label,
      pageIndex: 4,
      rects: [targetRect],
      originalText: origWord,
      newText: nextText,
      source: 'tap',
    }]);
    const outText = await pdfOracle.extractText(out, 4);
    const flatOut = outText.replace(/\s+/g, ' ');
    assert.equal(flatOut.includes(nextText), true, `${label}: all 60 characters must extract contiguously`);
    const firstToken = nextText.split(' ')[0];
    const lastToken = nextText.split(' ').at(-1);
    assert.ok((await pdfOracle.search(out, 4, firstToken)).length >= 1, `${label}: search for start token must hit`);
    assert.ok((await pdfOracle.search(out, 4, lastToken)).length >= 1, `${label}: search for end token must hit`);
  }
});

test('page 5 (regression): 25+ unsorted multi-column rects with long newText never drop words and keep contiguous extraction', {skip: NO_MISSION}, async () => {
  const p5Info = inspectPage(missionBytes, 4);
  const start = p5Info.lines.findIndex(l => l.text.includes('To put the results in context'));
  assert.ok(start >= 0);
  // Take 25 lines spanning left column through Ties and right column Conclusions
  const picked = [
    ...p5Info.lines.slice(start, start + 23),
    ...p5Info.lines.slice(p5Info.lines.length - 5),
  ];
  assert.ok(picked.length >= 25);
  // Reverse rect order to confirm reading-order sorting (y, then x)
  const reversedRects = [...picked].reverse().map(l => l.frac);
  const orig = picked.map(l => l.text).join('\n');
  const next = orig.replace('broken randomly', 'broken deterministically') + '\nREGRESSION_END_OK';

  const out = await rewrite(missionBytes, [{
    id: 'many-rects',
    pageIndex: 4,
    rects: reversedRects,
    originalText: orig,
    newText: next,
    source: 'paragraph',
  }]);

  const outText = await pdfOracle.extractText(out, 4);
  const flatOut = outText.replace(/\s+/g, ' ');
  const expectedFlat = next.replace(/\s+/g, ' ').trim();
  for (const word of expectedFlat.split(' ')) {
    assert.equal(flatOut.includes(word), true, `many-rects: missing word ${JSON.stringify(word)}`);
  }
  assert.equal(flatOut.includes(expectedFlat), true, 'many-rects: inserted text must extract contiguously');
  assert.ok((await pdfOracle.search(out, 4, 'deterministically')).length >= 1, 'many-rects: search("deterministically") must hit');
  assert.ok((await pdfOracle.search(out, 4, 'REGRESSION_END_OK')).length >= 1, 'many-rects: final overflow token must hit');
  assert.equal((await pdfOracle.search(out, 4, 'broken randomly')).length, 0, 'many-rects: original text must be removed');
});

test('page 5 (d): rect for "randomly." shifted right by +0.022 aligns to full word and produces "broken deterministically."', {skip: NO_MISSION}, async () => {
  const hits = findStructuredRects(missionBytes, 4, 'randomly.');
  assert.equal(hits.length, 1);
  const shifted = {...hits[0].rect, x: hits[0].rect.x + 0.022};

  const out = await rewrite(missionBytes, [{
    id: 'shift-right',
    pageIndex: 4,
    rects: [shifted],
    originalText: 'randomly.',
    newText: 'deterministically.',
    source: 'paragraph',
  }]);

  const outText = await pdfOracle.extractText(out, 4);
  assert.equal(outText.includes('broken deterministically.'), true, `expected "broken deterministically." in page 5 text, got snippet: ${JSON.stringify(outText.slice(Math.max(0, outText.indexOf('broken') - 20), outText.indexOf('broken') + 60))}`);
  assert.equal(outText.includes('broken ran'), false, 'must not leave "ran" fragment before deterministically.');
  assert.equal(outText.includes('randomly'), false, '"randomly" must not occur');
  assert.equal((await pdfOracle.search(out, 4, 'randomly')).length, 0);
  assert.ok((await pdfOracle.search(out, 4, 'broken deterministically.')).length >= 1);
});

test('page 5 (e): rect for "randomly." shifted left by -0.02 aligns to full word and preserves "broken"', {skip: NO_MISSION}, async () => {
  const hits = findStructuredRects(missionBytes, 4, 'randomly.');
  assert.equal(hits.length, 1);
  const shifted = {...hits[0].rect, x: hits[0].rect.x - 0.02};

  const out = await rewrite(missionBytes, [{
    id: 'shift-left',
    pageIndex: 4,
    rects: [shifted],
    originalText: 'randomly.',
    newText: 'deterministically.',
    source: 'paragraph',
  }]);

  const outText = await pdfOracle.extractText(out, 4);
  assert.equal(outText.includes('broken deterministically.'), true, `expected "broken deterministically." in page 5 text, got snippet: ${JSON.stringify(outText.slice(Math.max(0, outText.indexOf('broken') - 20), outText.indexOf('broken') + 60))}`);
  assert.equal(outText.includes('broken ran'), false, 'must not leave "ran" fragment before deterministically.');
  assert.equal(outText.includes('randomly'), false, '"randomly" must not occur');
  assert.equal((await pdfOracle.search(out, 4, 'randomly')).length, 0);
  assert.ok((await pdfOracle.search(out, 4, 'broken deterministically.')).length >= 1);
});

test('page 5 (f): originalText not occurring on candidate lines falls back to rect selection and still extracts newText', {skip: NO_MISSION}, async () => {
  const hits = findStructuredRects(missionBytes, 4, '0.95');
  assert.equal(hits.length, 1);

  const out = await rewrite(missionBytes, [{
    id: 'miss-orig',
    pageIndex: 4,
    rects: [hits[0].rect],
    originalText: 'NONEXISTENT_PDFJS_STRING',
    newText: '0.42',
    source: 'tap',
  }]);

  const outText = await pdfOracle.extractText(out, 4);
  assert.equal(outText.includes('0.95'), false, 'rect selection must still redact 0.95');
  assert.equal(outText.includes('0.42'), true, 'newText must still extract');
  assert.ok((await pdfOracle.search(out, 4, '0.42')).length >= 1);
});

test('page 1 (rv90 P1-5): dagger † -> 1 in "Shahul Es†, Jithin" preserves comma and extracts "Es1,"', {skip: NO_MISSION}, async () => {
  const daggers = findStructuredRects(missionBytes, 0, '†');
  assert.equal(daggers.length, 3);
  // Widen rect slightly to simulate pdf.js span box bordering the adjacent comma
  const widened = {...daggers[0].rect, w: daggers[0].rect.w + 0.004};

  const out = await rewrite(missionBytes, [{
    id: 'dagger-comma',
    pageIndex: 0,
    rects: [widened],
    originalText: '†',
    newText: '1',
    source: 'tap',
  }]);

  const outText = await pdfOracle.extractText(out, 0);
  const flat = outText.replace(/\s+/g, ' ');
  assert.equal(flat.includes('Es1,'), true, `expected "Es1," in page 1 text, got: ${JSON.stringify(flat.slice(0, 200))}`);
  assert.equal(flat.includes('Shahul Es1, Jithin'), true, `expected "Shahul Es1, Jithin" in page 1 text, got: ${JSON.stringify(flat.slice(0, 200))}`);
  assert.equal((await pdfOracle.search(out, 0, '†')).length, 2, 'only the first dagger must be replaced');
});

function makeRotatedPdf(rotateDeg, lines = ['Hello World 0.95 End']) {
  const doc = new mupdf.PDFDocument();
  try {
    const font = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
    const resources = doc.newDictionary();
    const fontsDict = doc.newDictionary();
    fontsDict.put('F1', font);
    resources.put('Font', fontsDict);
    let stream = 'BT /F1 12 Tf ';
    lines.forEach((line, idx) => {
      stream += `1 0 0 1 72 ${700 - idx * 18} Tm (${line}) Tj `;
    });
    stream += 'ET\n';
    const pageObj = doc.addPage([0, 0, 612, 792], rotateDeg, resources, stream);
    doc.insertPage(-1, pageObj);
    const buf = doc.saveToBuffer('garbage=compact');
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    doc.destroy();
  }
}

test('rotated pages (rv90 P1-4): "0.95" -> "0.50" on /Rotate 90, 180, and 270', async () => {
  for (const deg of [90, 180, 270]) {
    const src = makeRotatedPdf(deg, ['Hello World 0.95 End', 'Second line value 1.23']);
    const hits = findStructuredRects(src, 0, '0.95');
    assert.equal(hits.length, 1, `expected 0.95 on /Rotate ${deg}`);

    const out = await rewrite(src, [{
      id: `rot-${deg}`,
      pageIndex: 0,
      rects: [hits[0].rect],
      originalText: '0.95',
      newText: '0.50',
      source: 'tap',
    }]);

    const outText = await pdfOracle.extractText(out, 0);
    assert.equal((await pdfOracle.search(out, 0, '0.50')).length >= 1, true, `/Rotate ${deg}: search("0.50") must hit (text=${JSON.stringify(outText)})`);
    assert.equal((await pdfOracle.search(out, 0, '0.95')).length, 0, `/Rotate ${deg}: "0.95" must be gone`);
    assert.equal(outText.includes('0.95'), false, `/Rotate ${deg}: "0.95" must not extract`);
    assert.equal(outText.includes('0.50'), true, `/Rotate ${deg}: "0.50" must extract`);
    assert.equal(outText.includes('Second line value 1.23'), true, `/Rotate ${deg}: second line must stay intact`);
  }
});

test('overlapping direct edits (rv90 P2-5): newest edit wins and emits only one inserted text', {skip: NO_MISSION}, async () => {
  const hits095 = findStructuredRects(missionBytes, 4, '0.95');
  assert.equal(hits095.length, 1);

  const out = await rewrite(missionBytes, [
    {id: 'old-edit', pageIndex: 4, rects: [hits095[0].rect], originalText: '0.95', newText: 'FIRST_VAL', source: 'tap'},
    {id: 'new-edit', pageIndex: 4, rects: [hits095[0].rect], originalText: '0.95', newText: 'SECOND_VAL', source: 'tap'},
  ]);

  const outText = await pdfOracle.extractText(out, 4);
  assert.equal(outText.includes('0.95'), false, 'original 0.95 must be removed');
  assert.equal(outText.includes('SECOND_VAL'), true, 'newest overlapping edit must extract');
  assert.equal(outText.includes('FIRST_VAL'), false, 'superseded older edit must not be emitted');
  assert.equal((await pdfOracle.search(out, 4, 'FIRST_VAL')).length, 0);
  assert.ok((await pdfOracle.search(out, 4, 'SECOND_VAL')).length >= 1);
});

function makeStreamPdf(streamText) {
  const doc = new mupdf.PDFDocument();
  try {
    const font = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
    const resources = doc.newDictionary();
    const fontsDict = doc.newDictionary();
    fontsDict.put('F1', font);
    resources.put('Font', fontsDict);
    const pageObj = doc.addPage([0, 0, 612, 792], 0, resources, streamText);
    doc.insertPage(-1, pageObj);
    const buf = doc.saveToBuffer('garbage=compact');
    try {
      return buf.asUint8Array().slice();
    } finally {
      buf.destroy();
    }
  } finally {
    doc.destroy();
  }
}

function wordBoxesOnPage(pdfBytes, pageIndex) {
  const info = inspectPage(pdfBytes, pageIndex);
  const words = [];
  for (const line of info.lines) {
    let i = 0;
    while (i < line.chars.length) {
      while (i < line.chars.length && !line.chars[i].c.trim()) i++;
      if (i >= line.chars.length) break;
      const start = i;
      while (i < line.chars.length && line.chars[i].c.trim()) i++;
      const slice = line.chars.slice(start, i);
      const text = slice.map(ch => ch.c).join('');
      const box = [
        Math.min(...slice.map(ch => ch.box[0])),
        Math.min(...slice.map(ch => ch.box[1])),
        Math.max(...slice.map(ch => ch.box[2])),
        Math.max(...slice.map(ch => ch.box[3])),
      ];
      words.push({text, box, frac: info.toFrac(box), lineId: line.id});
    }
  }
  return words;
}

test('rv90b P0-2: -8000 TJ gap does not teleport wordA when replacing "in" -> "on"', async () => {
  const src = makeStreamPdf('BT /F1 10 Tf 1 0 0 1 70 700 Tm [(col1)-8000(wordA)-300(in)-300(wordB)]TJ ET\n');
  const srcWords = wordBoxesOnPage(src, 0);
  const wIn = srcWords.find(w => w.text === 'in');
  const wWordA = srcWords.find(w => w.text === 'wordA');
  const wWordB = srcWords.find(w => w.text === 'wordB');
  assert.ok(wIn && wWordA && wWordB);

  const out = await rewrite(src, [{
    id: 'tj-8000',
    pageIndex: 0,
    rects: [wIn.frac],
    originalText: 'in',
    newText: 'on',
    source: 'tap',
  }]);

  const outInfo = inspectPage(out, 0);
  const outAllChars = outInfo.lines.flatMap(l => l.chars);
  const findSpanX = (token) => {
    const text = outAllChars.map(c => c.c).join('');
    const idx = text.indexOf(token);
    return idx >= 0 ? outAllChars[idx].box[0] : NaN;
  };
  const outWordAX = findSpanX('wordA');
  const outOnX = findSpanX('on');
  const outWordBX = findSpanX('wordB');
  assert.ok(Number.isFinite(outWordAX) && Number.isFinite(outOnX) && Number.isFinite(outWordBX), 'wordA, on, and wordB must survive intact');
  assert.ok(Math.abs(outWordAX - wWordA.box[0]) < 0.5, `wordA must not teleport (was ${wWordA.box[0]}, now ${outWordAX})`);
  assert.ok(Math.abs(outOnX - wIn.box[0]) < 0.5, `"on" must sit at "in"'s origin (was ${wIn.box[0]}, now ${outOnX})`);
  assert.ok(Math.abs(outWordBX - wWordB.box[0]) < 0.5, `wordB must not move (was ${wWordB.box[0]}, now ${outWordBX})`);
  const flat = (await pdfOracle.extractText(out, 0)).replace(/\s+/g, ' ').trim();
  assert.equal(flat.includes('onwordA'), false, `wordA must not be placed after "on": ${JSON.stringify(flat)}`);
  assert.equal(/wordA\s+on\s*wordB/.test(flat), true, `expected "wordA on wordB" order, got ${JSON.stringify(flat)}`);
});

test('rv90b P0-2: two holes in one TJ ("in" -> "at" and "faithfulness" -> "accuracy") preserve positions and order', async () => {
  const src = makeStreamPdf('BT /F1 10 Tf 1 0 0 1 70 700 Tm [(first)-300(in)-300(middle)-300(faithfulness)-300(last)]TJ ET\n');
  const srcWords = wordBoxesOnPage(src, 0);
  const wIn = srcWords.find(w => w.text === 'in');
  const wFaith = srcWords.find(w => w.text === 'faithfulness');
  const wMid = srcWords.find(w => w.text === 'middle');
  const wLast = srcWords.find(w => w.text === 'last');
  assert.ok(wIn && wFaith && wMid && wLast);

  const out = await rewrite(src, [
    {id: 'two-1', pageIndex: 0, rects: [wIn.frac], originalText: 'in', newText: 'at', source: 'tap'},
    {id: 'two-2', pageIndex: 0, rects: [wFaith.frac], originalText: 'faithfulness', newText: 'accuracy', source: 'tap'},
  ]);

  const outWords = wordBoxesOnPage(out, 0);
  const outMid = outWords.find(w => w.text === 'middle');
  const outLast = outWords.find(w => w.text === 'last');
  assert.ok(outMid && outLast, 'middle and last must survive intact');
  assert.ok(Math.abs(outMid.box[0] - wMid.box[0]) < 0.5, `middle must not move (was ${wMid.box[0]}, now ${outMid.box[0]})`);
  assert.ok(Math.abs(outLast.box[0] - wLast.box[0]) < 0.5, `last must not move (was ${wLast.box[0]}, now ${outLast.box[0]})`);
  const flat = (await pdfOracle.extractText(out, 0)).replace(/\s+/g, ' ').trim();
  assert.equal(flat, 'first at middle accuracy last', `expected exact order, got ${JSON.stringify(flat)}`);
});

test('rv90b P1-2: 5 Ts text rise does not split TJ or shift "gamma" vertically', async () => {
  const src = makeStreamPdf('BT /F1 10 Tf 5 Ts 1 0 0 1 70 700 Tm [(alpha)-300(beta)-300(gamma)]TJ ET\n');
  const srcWords = wordBoxesOnPage(src, 0);
  const wBeta = srcWords.find(w => w.text === 'beta');
  const wGamma = srcWords.find(w => w.text === 'gamma');
  assert.ok(wBeta && wGamma);

  const out = await rewrite(src, [{
    id: 'rise-5',
    pageIndex: 0,
    rects: [wBeta.frac],
    originalText: 'beta',
    newText: 'BETA',
    source: 'tap',
  }]);

  const outWords = wordBoxesOnPage(out, 0);
  const outGamma = outWords.find(w => w.text === 'gamma');
  assert.ok(outGamma, 'gamma must survive');
  assert.ok(Math.abs(outGamma.box[1] - wGamma.box[1]) < 0.5, `gamma y must not shift (was ${wGamma.box[1]}, now ${outGamma.box[1]})`);
  assert.ok(Math.abs(outGamma.box[0] - wGamma.box[0]) < 0.5, `gamma x must not shift (was ${wGamma.box[0]}, now ${outGamma.box[0]})`);
  const outText = await pdfOracle.extractText(out, 0);
  assert.equal(outText.includes('BETA'), true);
  assert.equal(outText.includes('beta'), false);
});

test('rv90b P1-1: cross-column "the" in "the following prompt:" does not splice into left-column Table 1 "0.63"', {skip: NO_MISSION}, async () => {
  const p5Info = inspectPage(missionBytes, 4);
  const promptLine = p5Info.lines.find(l => l.text.trim() === 'the following prompt:');
  assert.ok(promptLine, 'expected right-column "the following prompt:" on page 5');
  const theSlice = promptLine.chars.slice(0, 3);
  const theBox = [
    Math.min(...theSlice.map(c => c.box[0])),
    Math.min(...theSlice.map(c => c.box[1])),
    Math.max(...theSlice.map(c => c.box[2])),
    Math.max(...theSlice.map(c => c.box[3])),
  ];

  const out = await rewrite(missionBytes, [{
    id: 'cross-col-the',
    pageIndex: 4,
    rects: [p5Info.toFrac(theBox)],
    originalText: 'the',
    newText: 'ZZZ',
    source: 'tap',
  }]);

  const flat = (await pdfOracle.extractText(out, 4)).replace(/\s+/g, ' ');
  assert.equal(flat.includes('ZZZ 0.63'), false, 'must not splice ZZZ next to left-column 0.63');
  assert.equal(flat.includes('0.63 ZZZ'), false, 'must not splice ZZZ after left-column 0.63');
  assert.equal(flat.includes('0.72 0.52 0.63'), true, 'Table 1 GPT Score row must stay intact');
  assert.equal(flat.includes('ZZZ'), true, 'replacement ZZZ must extract');
});

test('rv90b P0-1: "in" next to "line" with +18 pt drifted rect replaces "in" and keeps "line" intact', {skip: NO_MISSION}, async () => {
  const p5Info = inspectPage(missionBytes, 4);
  const bw = p5Info.bounds[2] - p5Info.bounds[0];
  const targetLine = p5Info.lines.find(l => l.text.includes('in line with that'));
  assert.ok(targetLine, 'expected "in line with that" line on page 5');
  const at = targetLine.text.indexOf('in line');
  const inSlice = targetLine.chars.slice(at, at + 2);
  const inBox = [
    Math.min(...inSlice.map(c => c.box[0])),
    Math.min(...inSlice.map(c => c.box[1])),
    Math.max(...inSlice.map(c => c.box[2])),
    Math.max(...inSlice.map(c => c.box[3])),
  ];
  const drifted = {...p5Info.toFrac(inBox), x: p5Info.toFrac(inBox).x + 18 / bw};

  const out = await rewrite(missionBytes, [{
    id: 'drift-in-line',
    pageIndex: 4,
    rects: [drifted],
    originalText: 'in',
    newText: 'ZZZ',
    source: 'tap',
  }]);

  const flat = (await pdfOracle.extractText(out, 4)).replace(/\s+/g, ' ');
  assert.equal(flat.includes('lZZZe'), false, 'must not hijack "in" inside "line"');
  assert.equal(flat.includes('answer/context in line'), false, 'original "in" must be replaced');
  const lineAt = flat.indexOf('line with that');
  assert.equal(/answer\/context ZZZ\s*line with that/.test(flat), true, `expected "answer/context ZZZ line with that", got snippet: ${JSON.stringify(flat.slice(Math.max(0, lineAt - 35), lineAt + 30))}`);
});

test('rv90b P0-1: right-edge "to" pushed 18 pt into gutter is still aligned and replaced', {skip: NO_MISSION}, async () => {
  const p5Info = inspectPage(missionBytes, 4);
  const bw = p5Info.bounds[2] - p5Info.bounds[0];
  const targetLine = p5Info.lines.find(l => l.text.includes('and then asks to'));
  assert.ok(targetLine, 'expected "and then asks to" line on page 5');
  const at = targetLine.text.lastIndexOf('to');
  const toSlice = targetLine.chars.slice(at, at + 2);
  const toBox = [
    Math.min(...toSlice.map(c => c.box[0])),
    Math.min(...toSlice.map(c => c.box[1])),
    Math.max(...toSlice.map(c => c.box[2])),
    Math.max(...toSlice.map(c => c.box[3])),
  ];
  const drifted = {...p5Info.toFrac(toBox), x: p5Info.toFrac(toBox).x + 18 / bw};

  const out = await rewrite(missionBytes, [{
    id: 'gutter-to',
    pageIndex: 4,
    rects: [drifted],
    originalText: 'to',
    newText: 'ZZZ',
    source: 'tap',
  }]);

  const flat = (await pdfOracle.extractText(out, 4)).replace(/\s+/g, ' ');
  assert.equal(flat.includes('then asks ZZZ'), true, `expected "then asks ZZZ", got snippet: ${JSON.stringify(flat.slice(Math.max(0, flat.indexOf('then asks') - 10), flat.indexOf('then asks') + 40))}`);
  assert.equal(flat.includes('then asks to'), false, 'original "to" must be removed');
});

test('rv90b P2-1: centerNarrowSingleSlot does not shift into space-separated next word ("in" -> "Q" before "Table")', {skip: NO_MISSION}, async () => {
  const p5Info = inspectPage(missionBytes, 4);
  const targetLine = p5Info.lines.find(l => l.text.includes('Ragas in Table 1)'));
  assert.ok(targetLine);
  const at = targetLine.text.indexOf(' in Table') + 1;
  const inSlice = targetLine.chars.slice(at, at + 2);
  const inBox = [
    Math.min(...inSlice.map(c => c.box[0])),
    Math.min(...inSlice.map(c => c.box[1])),
    Math.max(...inSlice.map(c => c.box[2])),
    Math.max(...inSlice.map(c => c.box[3])),
  ];

  const out = await rewrite(missionBytes, [{
    id: 'narrow-space',
    pageIndex: 4,
    rects: [p5Info.toFrac(inBox)],
    originalText: 'in',
    newText: 'Q',
    source: 'tap',
  }]);

  const flat = (await pdfOracle.extractText(out, 4)).replace(/\s+/g, ' ');
  assert.equal(flat.includes('QTable'), false, 'must not glue Q into Table');
  assert.equal(flat.includes('Ragas Q Table 1)'), true, `expected "Ragas Q Table 1)", got snippet: ${JSON.stringify(flat.slice(Math.max(0, flat.indexOf('Ragas Q') - 10), flat.indexOf('Ragas Q') + 40))}`);
});

test('rv90b P2-3: PDF % comment after show does not trick nextOpAllowsSplice', async () => {
  const src = makeStreamPdf('BT /F1 10 Tf 1 0 0 1 70 700 Tm (hello) Tj % Tm\n ( world) Tj ET\n');
  const srcWords = wordBoxesOnPage(src, 0);
  const wWorld = srcWords.find(w => w.text === 'world');
  assert.ok(wWorld);
  const out = await rewrite(src, [{
    id: 'comment-check',
    pageIndex: 0,
    rects: [wWorld.frac],
    originalText: 'world',
    newText: 'earth',
    source: 'tap',
  }]);
  const outText = await pdfOracle.extractText(out, 0);
  assert.equal(outText.includes('hello'), true);
  assert.equal(outText.includes('earth'), true);
  assert.equal(outText.includes('world'), false);
});

test('fast mission PDF fuzzer: 8 pages x 15 words keeps every unedited word intact and extracts new word', {skip: NO_MISSION}, async () => {
  let seed = 20261120;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const docPages = sourceOracle.pageCount;
  assert.equal(docPages, 8);
  let totalEdits = 0;

  for (let p = 0; p < docPages; p++) {
    const words = wordBoxesOnPage(missionBytes, p).filter(w => /^[A-Za-z0-9.,%-]{2,}$/.test(w.text));
    const pool = [...words];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const chosen = pool.slice(0, 15);
    for (let k = 0; k < chosen.length; k++) {
      const target = chosen[k];
      const replacement = k % 2 === 0 ? `FZ${p}X${k}` : `FUZZ${p}W${k}LONG`;
      const out = await rewrite(missionBytes, [{
        id: `fz-${p}-${k}`,
        pageIndex: p,
        rects: [target.frac],
        originalText: target.text,
        newText: replacement,
        source: 'tap',
      }]);
      const outText = await pdfOracle.extractText(out, p);
      assert.equal(outText.includes(replacement), true, `p${p + 1} edit ${k} (${target.text} -> ${replacement}): new word missing`);

      // Verify every unedited word on the page stayed within 0.5 pt of its original coordinates
      const outWords = wordBoxesOnPage(out, p);
      for (const orig of words) {
        if (orig === target) continue;
        // Skip words physically overlapped by a longer replacement on the same line
        if (orig.lineId === target.lineId && orig.box[0] > target.box[0] && orig.box[0] - target.box[0] < replacement.length * 8) continue;
        const found = outWords.some(ow =>
          ow.text.includes(orig.text) &&
          Math.abs(ow.box[0] - orig.box[0]) <= 0.5 &&
          Math.abs(ow.box[1] - orig.box[1]) <= 0.5
        );
        assert.equal(found, true, `p${p + 1} edit ${k} (${target.text} -> ${replacement}): unedited word ${JSON.stringify(orig.text)} moved or lost`);
      }
      totalEdits += 1;
    }
  }
  assert.equal(totalEdits, 120);
});


test('RAGAS table replacements retain the original numeric font and size', {skip: NO_MISSION}, async () => {
  const pageIndex = 4;
  const changes = [['0.95', '0.65'], ['0.78', '0.48']];
  const hits = changes.map(([originalText, newText]) => {
    const hit = findStructuredRects(missionBytes, pageIndex, originalText)[0];
    assert.ok(hit);
    return { pageIndex, rects: [hit.rect], originalText, newText, source: 'tap' };
  });
  const out = await rewrite(missionBytes, hits);
  const before = inspectPage(missionBytes, pageIndex);
  const after = inspectPage(out, pageIndex);
  for (const [original, replacement] of changes) {
    const originalCell = before.lines.find(line => line.text.trim() === original);
    const revisedCell = after.lines.find(line => line.text.trim() === replacement);
    assert.ok(originalCell && revisedCell, replacement);
    assert.deepEqual(revisedCell.chars.map(ch => [ch.font, ch.size.toFixed(2)]), originalCell.chars.map(ch => [ch.font, ch.size.toFixed(2)]));
  }
});
