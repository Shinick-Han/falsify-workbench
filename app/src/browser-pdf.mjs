/* Browser PDF content edit. MuPDF.js (AGPL-3.0-or-later) removes matched glyphs
 * with redaction (text only; images and line art stay) and appends a real text
 * showing operator. Not a white overlay, annotation, or full-page raster.
 * Vendor notices: dist/browser-pdf-vendor/NOTICE.md
 */
import * as mupdf from 'mupdf';
import {parseFont, familyKey} from './browser-fonts.mjs';
import {scanTextShows} from './paragraph-pdf-content-operators.mjs';

export const ENGINE = Object.freeze({
  name: 'mupdf.js',
  version: '1.28.1',
  license: 'AGPL-3.0-or-later',
  redaction: 'pdf-redact-text-remove-image-none-line-art-none',
});

/* Public anchors use one space only: the top-left of the page view, y down,
 * in points, plus that view's width, height, and /Rotate. PDF user space
 * (bottom-left, y up) is never accepted as an anchor. */
export const COORDINATE_SPACE = 'top-left-page';
export const COORDINATES = Object.freeze({
  space: COORDINATE_SPACE,
  origin: 'top-left',
  yAxis: 'down',
  unit: 'pt',
});

export const LIMITS = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxPages: 200,
  maxEdits: 24,
  maxChars: 4000,
  maxWrapLines: 8,
});

const SCHEMA = 'falsify.browser-pdf.v1';
const BASE14 = [
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats',
];
const FACE_ALIAS = {
  ArialMT: 'Helvetica', Arial: 'Helvetica', 'Arial-BoldMT': 'Helvetica-Bold',
  TimesNewRomanPSMT: 'Times-Roman', 'TimesNewRomanPS-BoldMT': 'Times-Bold',
  'TimesNewRomanPS-ItalicMT': 'Times-Italic', CourierNewPSMT: 'Courier',
};
/* Windows-1252 bytes that are not Latin-1. */
const WINANSI_EXTRA = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

const fonts = new Map();
let queue = Promise.resolve();

export class BrowserPdfError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BrowserPdfError';
    this.code = code;
    this.details = details;
  }
}

function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

function aborted() {
  return new BrowserPdfError('aborted', '편집이 취소되었습니다. PDF는 만들지 않았습니다.');
}

function checkAbort(signal) {
  if (signal?.aborted) throw aborted();
}

export async function prepare(request) {
  request ||= {};
  const snapshot = captureFontSnapshot(request.fontSnapshot);
  return exclusive(() => prepareExclusive({...request, fontSnapshot: snapshot}));
}

async function prepareExclusive(request) {
  checkAbort(request.signal);
  const parsed = parseRequest(request);
  const snapshot = await validateFontSnapshot(request.fontSnapshot);
  checkAbort(request.signal);
  const bytes = await readBytes(parsed.file);
  checkAbort(request.signal);
  const sourceSha256 = await sha256(bytes);
  const enabled = validateSourceEdits(parsed, sourceSha256);

  let doc;
  try {
    doc = openPdf(bytes);
    checkAbort(request.signal);
    const pageCount = doc.countPages();
    if (pageCount < 1 || pageCount > LIMITS.maxPages) throw new BrowserPdfError('limit', `페이지 수는 1..${LIMITS.maxPages}만 지원합니다.`);
    const models = [];
    for (let i = 0; i < pageCount; i++) {
      checkAbort(request.signal);
      models.push(readPage(doc.loadPage(i)));
    }
    const {plans, failures} = locateEditPlans(enabled, models, pageCount, snapshot);
    checkAbort(request.signal);

    const warnings = [];
    const byPage = layoutEditPlans(plans, models, doc, failures, warnings);

    applyPageEdits(byPage, models, doc, request);
    checkAbort(request.signal);
    const saved = doc.saveToBuffer('garbage=compact');
    const out = new Uint8Array(saved.asUint8Array());
    doc.destroy();
    doc = null;
    checkAbort(request.signal);
    if (out.length < 5 || String.fromCharCode(...out.slice(0, 5)) !== '%PDF-') {
      throw new BrowserPdfError('verification-failed', '저장된 출력이 PDF가 아닙니다. 파일을 반환하지 않습니다.');
    }
    const outputSha256 = await sha256(out);
    const quality = verify(bytes, out, plans, models, outputSha256 === sourceSha256);
    warnings.push(...quality.warnings);
    const checks = quality.checks;
    const status = checks.length ? 'failed' : warnings.some(item => item.severity === 'warning') ? 'warning' : 'applied';
    const file = new File([out], editedName(parsed.name), {type: 'application/pdf'});
    const pageMap = models.map((model, index) => pageMapEntry(model, index));
    const verification = {
      schema: SCHEMA,
      engine: ENGINE.name,
      engineVersion: ENGINE.version,
      license: ENGINE.license,
      redaction: ENGINE.redaction,
      coordinateSpace: COORDINATE_SPACE,
      sourceSha256,
      outputSha256,
      status,
      layoutVerified: status === 'applied',
      independent: false,
      pageCount: {source: pageCount, output: pageCount},
      pages: models.map((model, index) => verificationPage(model, index)),
      edits: plans.map(plan => {
        const editChecks = checks.filter(item => item.id === plan.edit.id);
        return {
          id: plan.edit.id,
          pageIndex: plan.pageIndex,
          status: editChecks.length ? 'failed' : 'applied',
          font: plan.layout.font,
          sourceFont: plan.sourceFont,
          fontSubstituted: plan.layout.substituted,
          encoding: plan.layout.encoding,
          size: plan.size,
          color: plan.color,
          wrappedLines: plan.layout.lines.length,
          checks: editChecks,
        };
      }),
      checks,
      quality: {
        independent: false,
        method: 'mupdf.js structured text, same engine',
        removedBefore: !checks.some(item => item.code === 'removed-before'),
        presentAfter: !checks.some(item => item.code === 'present-after'),
        untouchedText: !checks.some(item => item.code === 'untouched-text'),
        figures: !checks.some(item => item.code === 'figure-changed'),
        limitations: 'Same-engine structural check only. A failed check still returns this readable candidate. Not typography, pixel identity, independent QA, or scientific verification.',
      },
      warnings,
    };
    return {file, sha256: outputSha256, verification, pageMap, warnings};
  } catch (error) {
    if (error instanceof BrowserPdfError) throw error;
    throw new BrowserPdfError('engine', 'PDF 편집 중 엔진 오류가 났습니다. 출력 파일은 만들지 않았습니다.', {reason: error?.name || 'Error'});
  } finally {
    try { doc?.destroy(); } catch { /* already closed */ }
    for (const face of snapshot || []) { try { face.font?.destroy(); } catch { /* already closed */ } }
  }
}

function validateSourceEdits(parsed, sourceSha256) {
  if (parsed.fileHash && parsed.fileHash !== sourceSha256) {
    throw new BrowserPdfError('stale-source', '원본 PDF 해시가 편집 세션과 다릅니다. 파일을 다시 연 뒤 적용하세요. 출력은 만들지 않았습니다.', {
      sourceSha256, expectedSha256: parsed.fileHash,
    });
  }
  const enabled = parsed.edits.filter(edit => edit.enabled !== false);
  if (!enabled.length) throw new BrowserPdfError('no-edits', '적용할 편집이 없습니다. 원본을 변경된 파일로 반환하지 않습니다.');
  if (enabled.length > LIMITS.maxEdits) throw new BrowserPdfError('limit', `편집은 한 번에 ${LIMITS.maxEdits}개까지입니다.`);

  return enabled;
}

function locateEditPlans(enabled, models, pageCount, snapshot) {
    const plans = [];
    const failures = [];
    enabled.forEach((edit, index) => {
      const result = locate(edit, index, models, pageCount, snapshot);
      if (result.ok) plans.push(result.plan);
      else failures.push(result.failure);
    });
    const overlaps = overlapping(plans);
    if (overlaps.length) failures.push(...overlaps);
    if (failures.length) throw unsupported(failures, models);
    return {plans, failures};
}

function layoutEditPlans(plans, models, doc, failures, warnings) {
    const byPage = new Map();
    for (const plan of plans) {
      const laid = layout(plan, models[plan.pageIndex], doc.loadPage(plan.pageIndex));
      if (laid.error) failures.push(failure(plan.edit, plan.pageIndex, laid.error));
      else {
        plan.layout = laid;
        if (plan.anchorApproximate) warnings.push(warn('selection-font-metrics', 'warning', plan.pageIndex, plan.edit.id));
        if (laid.substituted) warnings.push(warn('font-substituted', 'warning', plan.pageIndex, plan.edit.id));
        if (laid.lines.length > 1) warnings.push(warn('wrapped-after', 'info', plan.pageIndex, plan.edit.id));
        if (plan.partialLine) warnings.push(warn('extraction-gap', 'info', plan.pageIndex, plan.edit.id));
        const list = byPage.get(plan.pageIndex) || [];
        list.push(plan);
        byPage.set(plan.pageIndex, list);
      }
    }
    if (failures.length) throw unsupported(failures, models);

    return byPage;
}

function applyPageEdits(byPage, models, doc, request) {
    for (const [pageIndex, group] of byPage) {
      checkAbort(request.signal);
      const turned = group.filter(plan => plan.rotation !== 0);
      if (turned.length) throw unsupported(turned.map(plan => failure(plan.edit, plan.pageIndex, 'rotated-page')), models);
      const page = doc.loadPage(pageIndex);
      const selected = new Set(group.flatMap(plan => plan.chars));
      const protectedBoxes = removalBoxes(models[pageIndex].chars.filter(ch => !selected.has(ch)));
      for (const plan of group) redact(page, plan.chars, protectedBoxes);
      page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      const piece = group.map(plan => showText(doc, page, plan)).join('');
      if (piece) appendStream(doc, page, piece);
    }
}

function parseRequest(request) {
  const file = request.file;
  const signal = request.signal;
  let edits = request.edits;
  let fileHash = typeof request.fileHash === 'string' ? request.fileHash : '';
  if (edits && !Array.isArray(edits)) {
    if (edits.schema && edits.schema !== 'falsify.paper-edits.v1') {
      throw new BrowserPdfError('invalid', '편집 스냅샷 스키마를 알 수 없습니다.');
    }
    if (typeof edits.fileHash === 'string' && edits.fileHash) {
      if (fileHash && fileHash !== edits.fileHash) throw new BrowserPdfError('stale-source', '요청 해시와 스냅샷 해시가 다릅니다. 출력은 만들지 않았습니다.');
      fileHash = edits.fileHash;
    }
    edits = edits.edits;
  }
  if (!Array.isArray(edits)) throw new BrowserPdfError('invalid', 'edits 배열 또는 falsify.paper-edits.v1 스냅샷이 필요합니다.');
  if (fileHash && !/^[a-f0-9]{64}$/i.test(fileHash)) throw new BrowserPdfError('invalid', 'fileHash는 SHA-256 16진수여야 합니다.');
  return {file, signal, fileHash: fileHash.toLowerCase(), edits, name: file?.name || 'document.pdf'};
}

async function readBytes(file) {
  let bytes;
  if (file instanceof Uint8Array) bytes = new Uint8Array(file);
  else if (file && typeof file.arrayBuffer === 'function') bytes = new Uint8Array(await file.arrayBuffer());
  else if (file?.bytes instanceof Uint8Array) bytes = new Uint8Array(file.bytes);
  else throw new BrowserPdfError('invalid', 'PDF File 또는 bytes가 필요합니다.');
  if (bytes.byteLength > LIMITS.maxFileBytes) throw new BrowserPdfError('limit', 'PDF가 크기 제한을 넘습니다.');
  if (bytes.byteLength < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new BrowserPdfError('invalid', 'PDF 서명이 없습니다.');
  return bytes;
}

function openPdf(bytes) {
  let doc;
  try { doc = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF(); }
  catch { throw new BrowserPdfError('invalid', 'PDF를 열 수 없습니다.'); }
  if (!doc) throw new BrowserPdfError('invalid', 'PDF 문서가 아닙니다.');
  if (doc.needsPassword()) throw new BrowserPdfError('unsupported', '암호화된 PDF는 이 브라우저 편집에서 지원하지 않습니다. 파일을 만들지 않았습니다.');
  return doc;
}

function readPage(page) {
  const transform = page.getTransform();
  const toPdf = mupdf.Matrix.invert(transform);
  const chars = [];
  const images = [];
  const text = page.toStructuredText('preserve-whitespace,preserve-images');
  let lineId = -1;
  let lastY = null;
  text.walk({
    onChar(ch, origin, font, size, quad, color) {
      const pdf = apply(toPdf, origin[0], origin[1]);
      if (lastY === null || Math.abs(pdf[1] - lastY) > 1.25) { lineId += 1; lastY = pdf[1]; }
      chars.push({
        c: ch, origin: [origin[0], origin[1]], pdf, lineId,
        fontName: font.getName(), font, size: Number(size), quad: [...quad], color: rgb(color),
      });
    },
    onImageBlock(bbox) { images.push([...bbox]); },
  });
  return {chars, images, transform, toPdf, bounds: page.getBounds(), rotation: rotationOf(page)};
}

function validateEditText(edit, pageIndex, pageCount, fail) {
  if (!edit || typeof edit !== 'object') return fail('invalid-edit');
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) return fail('invalid-page');
  if (typeof edit.before !== 'string' || !edit.before.trim() || edit.before.length > LIMITS.maxChars) return fail('invalid-before');
  if (typeof edit.after !== 'string' || edit.after.length > LIMITS.maxChars) return fail('invalid-after');
  return null;
}

function validAnchorRange(anchor) {
  if (anchor && (anchor.start !== undefined || anchor.end !== undefined)) {
    if (!Number.isInteger(anchor.start) || !Number.isInteger(anchor.end) || anchor.end <= anchor.start) return false;
  }
  return true;
}

function validateEditAnchor(edit, pageIndex, pageCount, fail) {
  const anchor = edit.anchor && typeof edit.anchor === 'object' ? edit.anchor : null;
  if (anchorConvention(edit, anchor)) return fail('invalid-anchor');
  if (anchor?.bbox && !validBox(anchor.bbox)) return fail('invalid-anchor');
  if (anchor && anchor.occurrence !== undefined && (!Number.isInteger(anchor.occurrence) || anchor.occurrence < 0)) return fail('invalid-anchor');
  if (!validAnchorRange(anchor)) return fail('invalid-anchor');
  return {anchor};
}

function findAnchoredQuotes(model, edit, anchor) {
  const {text, map} = normalized(model.chars);
  const needle = edit.before.replace(/\s+/g, ' ').trim();
  const hits = [];
  let from = 0, ordinal = 0, foundQuote = false;
  const requestedOrdinal = anchor?.occurrence;
  while (true) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    const chars = [];
    for (let i = at; i < at + needle.length; i++) if (map[i] !== null && map[i] !== undefined) chars.push(model.chars[map[i]]);
    if (!chars.length) continue;
    foundQuote = true;
    const occurrence = ordinal++;
    // Numeric table values can repeat many times. Apply the caller's verified
    // geometry while scanning; never truncate the page before reaching its cell.
    if (requestedOrdinal !== undefined && occurrence !== requestedOrdinal) continue;
    if (anchor?.bbox) {
      const box = union(chars);
      if (!contains(box, anchor.bbox, Math.max(4, Math.min(8, (box[3] - box[1]) / 2)))) continue;
    }
    hits.push({at, chars});
    // Two surviving matches already prove ambiguity. A supplied ordinal still
    // counts page-global quotes, before geometry, as in the original contract.
    if (requestedOrdinal !== undefined || hits.length > 1) break;
  }
  return {hits, foundQuote};
}

function buildLocatedPlan(edit, id, pageIndex, model, anchor, chars, snapshot, fail) {
  const drawn = chars.filter(ch => ch.c.trim());
  if (!drawn.length) return fail('not-found');
  if (!drawn.every(ch => horizontalLine(chars.filter(item => item.lineId === ch.lineId)))) return fail('rotated-text');
  const fontsUsed = [...new Set(drawn.map(ch => ch.fontName))];
  const sizes = [...new Set(drawn.map(ch => Math.round(ch.size * 100) / 100))];
  const colors = [...new Set(drawn.map(ch => ch.color ? ch.color.map(n => Math.round(n * 1000) / 1000).join(',') : 'none'))];
  if (fontsUsed.length !== 1 || sizes.length !== 1 || colors.length !== 1 || colors[0] === 'none') return fail(colors[0] === 'none' ? 'unsupported-color' : 'mixed-style');
  const face = base14(fontsUsed[0], drawn[0].font);
  if (!face) return fail('font-unavailable');
  const supplied = snapshot ? chooseSnapshotFont(snapshot, fontsUsed[0], drawn[0].font, edit.after) : null;
  if (snapshot && !supplied) return fail('font-unavailable');
  const encoded = supplied ? {encoding: 'glyph-id', substituted: supplied.substituted} : textEncoding(face, edit.after);
  if (encoded.error) return fail(encoded.error);
  const box = pdfSpan(model.toPdf, chars.filter(ch => ch.lineId === chars[0].lineId));
  const partialLine = model.chars.some(ch => ch.lineId === chars[0].lineId && !chars.includes(ch) && ch.c.trim());
  return {ok: true, plan: {
    edit: {...edit, id}, pageIndex, chars, charIndex: new Set(chars.map(ch => model.chars.indexOf(ch))),
    anchorApproximate: !!anchor?.bbox && !contains(union(chars), anchor.bbox, 4),
    sourceFont: fontsUsed[0], face, supplied, encoding: encoded.encoding, substituted: encoded.substituted,
    size: sizes[0], color: drawn[0].color,
    origin: chars[0].pdf, hole: box[1] - box[0], partialLine, rotation: model.rotation,
  }};
}

function locate(edit, index, models, pageCount, snapshot) {
  const id = typeof edit?.id === 'string' && edit.id ? edit.id : `edit-${index}`;
  const pageIndex = edit?.pageIndex;
  const fail = (code) => ({ok: false, failure: {id, pageIndex: Number.isInteger(pageIndex) ? pageIndex : null, status: 'unapplied', code}});
  const invalid = validateEditText(edit, pageIndex, pageCount, fail);
  if (invalid) return invalid;
  const validated = validateEditAnchor(edit, pageIndex, pageCount, fail);
  if (validated.ok === false) return validated;
  const {anchor} = validated;
  /* start/end are raw segment offsets. They are not page-string offsets and do not choose a hit. */
  const model = models[pageIndex];
  if (model.rotation !== 0) return fail('rotated-page');
  const {hits, foundQuote} = findAnchoredQuotes(model, edit, anchor);
  const pool = hits;
  if (!pool.length) return fail(foundQuote ? 'anchor-mismatch' : 'not-found');
  if (pool.length > 1) return fail('ambiguous');
  const chars = pool[0].chars;
  return buildLocatedPlan(edit, id, pageIndex, model, anchor, chars, snapshot, fail);
}

function layout(plan, model, page) {
  const font = plan.supplied?.font || (plan.encoding === 'uniks-utf16' ? cjkFont() : metrics(plan.face.name));
  const fontName = plan.supplied?.name || (plan.encoding === 'uniks-utf16' ? 'ko' : plan.face.name);
  const after = plan.edit.after;
  const placed = (lines) => ({lines, font: fontName, substituted: plan.substituted, encoding: plan.encoding});
  if (!after) return placed([]);
  const width = measure(font, plan.size, after);
  if (width === null) return {error: 'missing-glyphs'};
  if (width <= plan.hole + 0.8) return placed([after]);
  if (plan.rotation !== 0) return {error: 'long-after-no-room'};
  const room = roomRight(plan, model, page);
  if (width <= room + 0.8) return placed([after]);
  const wrapWidth = Math.max(36, Math.min(room, 468));
  const lines = wrap(font, plan.size, after, wrapWidth);
  if (!lines) return {error: 'missing-glyphs'};
  if (lines.length > LIMITS.maxWrapLines) return {error: 'long-after-no-room'};
  if (!clear(lines, plan, model, font)) return {error: 'long-after-no-room'};
  return placed(lines);
}

/* MuPDF 1.28.1 sizes every horizontal glyph's redaction test from font
 * ascender to descender (FontDescriptor Ascent/Descent), then insets that box
 * by 10%. A raw structured-text quad is the same full metric box. On a tight
 * title those boxes cross the next baseline, and applyRedactions then deletes
 * each intersecting glyph whole. Edge contact counts as a hit. The quad used
 * here stays inside the selected glyph's inset box and outside every other
 * glyph's inset box. */
const REDACTION_GAP = 0.05;
const GLYPH_ORIGIN = 0.01;

function quadBounds(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    x0 = Math.min(x0, points[i]);
    y0 = Math.min(y0, points[i + 1]);
    x1 = Math.max(x1, points[i]);
    y1 = Math.max(y1, points[i + 1]);
  }
  return [x0, y0, x1, y1];
}

function removalBox(ch) {
  const [x0, y0, x1, y1] = quadBounds(ch.quad);
  const width = x1 - x0;
  const height = y1 - y0;
  if (!(width > 0) || !(height > 0)) return null;
  return [x0 + width / 10, y0 + height / 10, x1 - width / 10, y1 - height / 10];
}

function removalBoxes(chars) {
  const boxes = [];
  for (const ch of chars) {
    const box = removalBox(ch);
    if (box) boxes.push(box);
  }
  return boxes;
}

function subtractRect(rect, obstacle) {
  const [x0, y0, x1, y1] = rect;
  const grown = [obstacle[0] - REDACTION_GAP, obstacle[1] - REDACTION_GAP, obstacle[2] + REDACTION_GAP, obstacle[3] + REDACTION_GAP];
  if (x1 <= grown[0] || x0 >= grown[2] || y1 <= grown[1] || y0 >= grown[3]) return rect;
  const candidates = [];
  if (grown[1] > y0) candidates.push([x0, y0, x1, Math.min(y1, grown[1])]);
  if (grown[3] < y1) candidates.push([x0, Math.max(y0, grown[3]), x1, y1]);
  if (grown[0] > x0) candidates.push([x0, y0, Math.min(x1, grown[0]), y1]);
  if (grown[2] < x1) candidates.push([Math.max(x0, grown[2]), y0, x1, y1]);
  let best = null;
  let area = 0;
  for (const candidate of candidates) {
    const width = candidate[2] - candidate[0];
    const height = candidate[3] - candidate[1];
    if (width > 0 && height > 0 && width * height > area) {
      best = candidate;
      area = width * height;
    }
  }
  return best;
}

function safeRedactionRect(ch, protectedBoxes) {
  let rect = removalBox(ch);
  if (!rect) return null;
  for (let guard = 0; guard < 12; guard++) {
    let next = rect;
    for (const box of protectedBoxes) {
      next = subtractRect(next, box);
      if (!next) return null;
    }
    if (next.every((value, index) => value === rect[index])) return next;
    rect = next;
  }
  if (rect[2] - rect[0] <= 0.02 || rect[3] - rect[1] <= 0.02) return null;
  return rect;
}

function redact(page, chars, protectedBoxes) {
  const quads = [];
  for (const ch of chars) {
    const rect = safeRedactionRect(ch, protectedBoxes);
    if (!rect) {
      if (!ch.c.trim()) continue;
      throw new BrowserPdfError('unsupported', '선택한 글자의 글꼴 상자가 인접 글자와 겹쳐 그 글자만 지울 수 없습니다. 부분 적용 파일은 만들지 않았습니다.', {
        code: 'glyph-overlap',
      });
    }
    const [x0, y0, x1, y1] = rect;
    quads.push([x0, y1, x1, y1, x0, y0, x1, y0]);
  }
  if (!quads.length) return;
  const annot = page.createAnnotation('Redact');
  /* quads.flat() is 8 numbers per glyph. The Rect has to cover every one. */
  const box = quadBounds(quads.flat());
  annot.setRect(box);
  annot.setQuadPoints(quads);
  annot.update();
}

/* Tm is PDF user space and is written only after a zero /Rotate check.
 * The public anchor is never converted into this space. */
function showText(doc, page, plan) {
  if (!plan.layout.lines.length) return '';
  const cjk = plan.layout.encoding === 'uniks-utf16';
  const resource = plan.supplied ? ensureSnapshotFont(doc, page, plan) : cjk ? ensureCjkFont(doc, page) : ensureFont(doc, page, plan.layout.font);
  const [r, g, b] = plan.color;
  const leading = plan.size * 1.2;
  let body = `q BT /${resource} ${num(plan.size)} Tf ${num(r)} ${num(g)} ${num(b)} rg\n`;
  plan.layout.lines.forEach((line, index) => {
    const literal = plan.supplied ? glyphHex(plan.supplied.font, line) : cjk ? utf16hex(line) : winAnsi(line);
    body += `1 0 0 1 ${num(plan.origin[0])} ${num(plan.origin[1] - index * leading)} Tm ${literal} Tj\n`;
  });
  return body + 'ET Q\n';
}

function appendStream(doc, page, text) {
  const stream = doc.addStream(new TextEncoder().encode(text), {});
  const obj = page.getObject();
  const contents = obj.get('Contents');
  if (contents.isArray()) { contents.push(stream); return; }
  const array = doc.newArray();
  if (!contents.isNull()) array.push(contents);
  array.push(stream);
  obj.put('Contents', array);
}

function verify(sourceBytes, outBytes, plans, models, unchanged) {
  const warnings = [];
  const checks = [];
  let check;
  try { check = mupdf.Document.openDocument(outBytes, 'application/pdf').asPDF(); }
  catch { throw new BrowserPdfError('engine', '저장 결과를 다시 열 수 없습니다. 파일을 반환하지 않습니다.'); }
  try {
    if (check.countPages() !== models.length) checks.push({pageIndex: null, status: 'failed', code: 'page-count'});
    verifyUneditedContent(check, plans, models, checks);
    verifyEditText(check, plans, models, warnings, checks);
    if (unchanged || (outBytes.length === sourceBytes.length && outBytes.every((byte, index) => byte === sourceBytes[index]))) {
      checks.push({status: 'failed', code: 'unchanged-output'});
    }
  } finally {
    try { check.destroy(); } catch { /* ignore */ }
  }
  return {warnings, checks};
}

function verifyUneditedContent(check, plans, models, checks) {
    const edited = new Set(plans.map(plan => plan.pageIndex));
    for (let i = 0; i < models.length; i++) {
      const page = check.loadPage(i);
      const again = readPage(page);
      if (!sameImages(models[i].images, again.images)) checks.push({pageIndex: i, status: 'failed', code: 'figure-changed'});
      if (!edited.has(i)) {
        if (normalizeText(again.chars) !== normalizeText(models[i].chars)) checks.push({pageIndex: i, status: 'failed', code: 'untouched-text'});
      } else if (!keptOutsideSelection(models[i].chars, again.chars, selectedCharIndexes(plans, i))) {
        checks.push({pageIndex: i, status: 'failed', code: 'untouched-text'});
      }
    }
}

function verifyEditText(check, plans, models, warnings, checks) {
    for (const plan of plans) {
      const text = normalizeText(readPage(check.loadPage(plan.pageIndex)).chars);
      const before = plan.edit.before.replace(/\s+/g, ' ').trim();
      const after = plan.edit.after.replace(/\s+/g, ' ').trim();
      const sourceText = normalizeText(models[plan.pageIndex].chars);
      if (after && !text.includes(after)) {
        const words = after.split(' ').filter(Boolean);
        if (words.length && words.every(word => text.includes(word))) warnings.push(warn('after-extraction-order', 'warning', plan.pageIndex, plan.edit.id));
        else checks.push({id: plan.edit.id, pageIndex: plan.pageIndex, status: 'failed', code: 'present-after'});
      }
      const expected = Math.max(0, count(sourceText, before) - 1 + count(after, before));
      if (count(text, before) > expected) checks.push({id: plan.edit.id, pageIndex: plan.pageIndex, status: 'failed', code: 'removed-before'});
    }
}

function selectedCharIndexes(plans, pageIndex) {
  const selected = new Set();
  for (const plan of plans) {
    if (plan.pageIndex !== pageIndex) continue;
    for (const index of plan.charIndex) selected.add(index);
  }
  return selected;
}

/* Saved bytes of an edited page: every unselected drawn glyph must come back
 * once, same character, within GLYPH_ORIGIN of its PDF origin. A miss is a
 * failed check on the returned candidate. Spaces are outside the selection map. */
function keptOutsideSelection(sourceChars, outputChars, selected) {
  const pool = outputChars.map(ch => ({c: ch.c, x: ch.pdf[0], y: ch.pdf[1], used: false}));
  for (let index = 0; index < sourceChars.length; index++) {
    if (selected.has(index)) continue;
    const ch = sourceChars[index];
    if (!ch.c.trim()) continue;
    let found = -1;
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      if (item.used || item.c !== ch.c) continue;
      if (Math.abs(item.x - ch.pdf[0]) <= GLYPH_ORIGIN && Math.abs(item.y - ch.pdf[1]) <= GLYPH_ORIGIN) {
        found = i;
        break;
      }
    }
    if (found < 0) return false;
    pool[found].used = true;
  }
  return true;
}

function unsupported(failures, models) {
  const indexes = [...new Set(failures.map(item => item.pageIndex).filter(index => Number.isInteger(index)))];
  return new BrowserPdfError('unsupported', `적용하지 않은 편집이 있습니다 (${failures.map(item => item.code).join(', ')}). 페이지 ${indexes.map(index => index + 1).join(', ') || '-'}. 부분 적용 파일은 만들지 않았습니다.`, {
    coordinateSpace: COORDINATE_SPACE,
    pages: models.map((model, index) => verificationPage(model, index)),
    edits: failures,
  });
}

function anchorConvention(edit, anchor) {
  const spaces = [edit?.coordinateSpace, anchor?.coordinateSpace].filter(value => value !== undefined);
  if (spaces.some(value => value !== COORDINATE_SPACE)) return 'invalid-anchor';
  if (anchor?.origin !== undefined && anchor.origin !== COORDINATES.origin) return 'invalid-anchor';
  const axes = [edit?.yAxis, anchor?.yAxis].filter(value => value !== undefined);
  if (axes.some(value => value !== COORDINATES.yAxis)) return 'invalid-anchor';
  const units = [edit?.unit, anchor?.unit].filter(value => value !== undefined);
  if (units.some(value => value !== COORDINATES.unit)) return 'invalid-anchor';
  return null;
}

function pageMapEntry(model, index) {
  const view = pageView(model);
  return {
    sourcePageIndex: index,
    outputPageIndex: index,
    continuationPageIndices: [],
    coordinateSpace: COORDINATE_SPACE,
    origin: COORDINATES.origin,
    yAxis: COORDINATES.yAxis,
    unit: COORDINATES.unit,
    width: view.width,
    height: view.height,
    rotation: model.rotation,
  };
}

function verificationPage(model, index) {
  const entry = pageMapEntry(model, index);
  return {
    pageIndex: index,
    coordinateSpace: entry.coordinateSpace,
    origin: entry.origin,
    yAxis: entry.yAxis,
    unit: entry.unit,
    width: entry.width,
    height: entry.height,
    rotation: entry.rotation,
    editable: entry.rotation === 0,
  };
}

function pageView(model) {
  const bounds = model.bounds;
  return {
    width: Math.round((bounds[2] - bounds[0]) * 1000) / 1000,
    height: Math.round((bounds[3] - bounds[1]) * 1000) / 1000,
  };
}

function failure(edit, pageIndex, code) {
  return {id: edit.id, pageIndex, status: 'unapplied', code};
}

function warn(code, severity, pageIndex, editId) {
  return {code, severity, pageIndex, editId};
}

function overlapping(plans) {
  const failures = [];
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      if (plans[i].pageIndex !== plans[j].pageIndex) continue;
      for (const index of plans[i].charIndex) if (plans[j].charIndex.has(index)) {
        failures.push(failure(plans[j].edit, plans[j].pageIndex, 'overlap'));
        break;
      }
    }
  }
  return failures;
}

function normalized(chars) {
  let text = '';
  const map = [];
  let gap = false;
  let line = null;
  for (let index = 0; index < chars.length; index++) {
    const ch = chars[index];
    if (line !== null && ch.lineId !== line) gap = true;
    line = ch.lineId;
    if (!ch.c.trim()) { gap = true; continue; }
    if (gap && text) { text += ' '; map.push(null); }
    gap = false;
    text += ch.c;
    map.push(index);
  }
  return {text, map};
}

function normalizeText(chars) {
  return normalized(chars).text;
}

function horizontalLine(chars) {
  if (chars.length < 2) return true;
  const ys = chars.map(ch => ch.pdf[1]);
  if (Math.max(...ys) - Math.min(...ys) > 1.5) return false;
  for (let i = 1; i < chars.length; i++) if (chars[i].pdf[0] + 0.4 < chars[i - 1].pdf[0]) return false;
  return true;
}


// A snapshot is immutable input to this request, never stored in the global metrics cache.
function captureFontSnapshot(snapshot) {
  if (snapshot == null) return null;
  if (!Array.isArray(snapshot.fonts) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || typeof snapshot.digest !== 'string')
    throw new BrowserPdfError('invalid', 'Invalid font snapshot.');
  return {...snapshot, fonts: snapshot.fonts.map(face => {
    if (!face || !(face.bytes instanceof Uint8Array)) throw new BrowserPdfError('invalid', 'Invalid font snapshot bytes.');
    return {...face, bytes: face.bytes.slice()};
  })};
}
async function validateFontSnapshot(snapshot) {
  if (snapshot == null) return null;
  if (!Array.isArray(snapshot.fonts) || !Number.isInteger(snapshot.revision) || typeof snapshot.digest !== 'string')
    throw new BrowserPdfError('invalid', 'Invalid font snapshot.');
  const faces = [];
  for (const face of snapshot.fonts) {
    if (!(face.bytes instanceof Uint8Array) || typeof face.sha256 !== 'string')
      throw new BrowserPdfError('invalid', 'Invalid font snapshot bytes.');
    const bytes = face.bytes.slice();
    if (await sha256(bytes) !== face.sha256.toLowerCase())
      throw new BrowserPdfError('invalid', 'Font snapshot bytes do not match their SHA-256.');
    let parsed;
    try { parsed = parseFont(bytes); } catch { throw new BrowserPdfError('unsupported', 'Font is invalid or embedding is restricted.'); }
    if (typeof face.id !== 'string' || !['local', 'file', 'bundled'].includes(face.source) ||
        ['family', 'postscriptName', 'weight', 'italic', 'fsType'].some(field => face[field] !== parsed[field]))
      throw new BrowserPdfError('invalid', 'Font snapshot metadata does not match its bytes.');
    // MuPDF addFont embeds the complete font. Never invoke save-time font subsetting.
    faces.push({...face, bytes});
  }
  const metadata = snapshot.fonts.map(({bytes, ...rest}) => rest);
  if (await sha256(new TextEncoder().encode(JSON.stringify(metadata))) !== snapshot.digest.toLowerCase())
    throw new BrowserPdfError('invalid', 'Font snapshot metadata digest does not match.');
  return faces;
}

function chooseSnapshotFont(faces, sourceName, sourceFont, text) {
  const source = familyKey(sourceName);
  const matches = face => source && (source === familyKey(face.postscriptName) || source === familyKey(face.family));
  const ranked = faces.filter(face => matches(face) || face.source === 'bundled').sort((a, b) =>
    (matches(a) ? 0 : 10000) - (matches(b) ? 0 : 10000) +
    (a.italic === sourceFont.isItalic() ? 0 : 1000) - (b.italic === sourceFont.isItalic() ? 0 : 1000) +
    Math.abs(a.weight - (sourceFont.isBold() ? 700 : 400)) - Math.abs(b.weight - (sourceFont.isBold() ? 700 : 400)));
  for (const face of ranked) {
    let font;
    try { font = face.font || new mupdf.Font(face.postscriptName || face.family, face.bytes); }
    catch { continue; }
    if ([...text].every(ch => font.encodeCharacter(ch.codePointAt(0))))
      { face.font = font; return {font, name: font.getName(), substituted: !matches(face), face}; }
    if (!face.font) font.destroy();
  }
  return null;
}
function glyphHex(font, text) {
  return '<' + [...text].map(ch => font.encodeCharacter(ch.codePointAt(0)).toString(16).padStart(4, '0')).join('') + '>';
}
function ensureSnapshotFont(doc, page, plan) {
  const resources = ownResources(doc, page);
  let dict = resources.get('Font');
  if (dict.isNull()) { dict = doc.newDictionary(); resources.put('Font', dict); }
  else dict = dict.resolve();
  const taken = new Set(); dict.forEach((_value, key) => taken.add(String(key)));
  let name = 'FwEmbedded'; while (taken.has(name)) name += 'x';
  const pdfFont = doc.addFont(plan.supplied.font);
  const mappings = new Map();
  for (const line of plan.layout.lines) for (const ch of line) {
    const gid = plan.supplied.font.encodeCharacter(ch.codePointAt(0));
    if (mappings.has(gid) && mappings.get(gid) !== ch) throw new BrowserPdfError('unsupported', 'Font maps multiple Unicode characters to one glyph.');
    mappings.set(gid, ch);
  }
  const entries = [...mappings].map(([gid, ch]) => `<${gid.toString(16).padStart(4, '0')}> ${utf16hex(ch)}`);
  let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /FwUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100); cmap += `${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar\n`;
  }
  cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  pdfFont.put('ToUnicode', doc.addStream(new TextEncoder().encode(cmap), {}));
  dict.put(name, pdfFont);
  return name;
}

function base14(fontName, font) {
  const bare = String(fontName || '').replace(/^[A-Z]{6}\+/, '');
  if (BASE14.includes(bare)) return {name: bare, substituted: false};
  if (FACE_ALIAS[bare]) return {name: FACE_ALIAS[bare], substituted: true};
  if (!font) return null;
  const bold = font.isBold();
  const italic = font.isItalic();
  const family = font.isMono() ? 'Courier' : font.isSerif() ? 'Times' : 'Helvetica';
  const name = base14Style(family, bold, italic);
  return {name, substituted: true};
}

function base14Style(family, bold, italic) {
  const name = family === 'Times'
    ? (bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman')
    : family === 'Courier'
      ? (bold && italic ? 'Courier-BoldOblique' : bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier')
      : (bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica');
  return name;
}

function metrics(name) {
  if (!fonts.has(name)) fonts.set(name, new mupdf.Font(name));
  return fonts.get(name);
}

function cjkFont() {
  return metrics('ko');
}

function textEncoding(face, after) {
  if (!after) return {encoding: 'winansi', substituted: face.substituted};
  const latin = metrics(face.name);
  const latinOk = [...after].every(ch => latin.encodeCharacter(ch)) && winAnsi(after) !== null;
  if (latinOk) return {encoding: 'winansi', substituted: face.substituted};
  const ko = cjkFont();
  if ([...after].every(ch => ko.encodeCharacter(ch))) return {encoding: 'uniks-utf16', substituted: true};
  return {error: 'missing-glyphs'};
}

function utf16hex(text) {
  let hex = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 0xffff) {
      const unit = code - 0x10000;
      hex += (0xd800 + (unit >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (unit & 0x3ff)).toString(16).padStart(4, '0');
    } else hex += code.toString(16).padStart(4, '0');
  }
  return '<' + hex + '>';
}

function measure(font, size, text) {
  let width = 0;
  for (const ch of text) {
    const gid = font.encodeCharacter(ch.codePointAt(0));
    if (!gid) return null;
    width += font.advanceGlyph(gid) * size;
  }
  return width;
}

function roomRight(plan, model, page) {
  const end = plan.origin[0] + plan.hole;
  // Limit to the visible page, in the same PDF user space as plan.origin.
  let limit = apply(model.toPdf, model.bounds[2], model.bounds[3])[0] - 36;
  for (const ch of model.chars) {
    if (plan.charIndex.has(model.chars.indexOf(ch))) continue;
    if (ch.lineId !== plan.chars[0].lineId || !ch.c.trim()) continue;
    if (ch.pdf[0] > end - 0.5) limit = Math.min(limit, ch.pdf[0] - 1);
  }
  return Math.max(0, limit - plan.origin[0]);
}

function wrap(font, size, text, maxWidth) {
  const lines = [];
  let current = '';
  const flush = () => { if (current.trim()) lines.push(current.trimEnd()); current = ''; };
  for (const part of text.split(/(\s+)/)) {
    if (!part || /^\s+$/.test(part)) {
      if (current && measure(font, size, (current + ' ').trimEnd()) <= maxWidth) current += ' ';
      continue;
    }
    const trial = current ? current + part : part;
    const width = measure(font, size, trial.trimEnd());
    if (width === null) return null;
    if (width <= maxWidth) { current = trial; continue; }
    flush();
    if (measure(font, size, part) <= maxWidth) { current = part; continue; }
    let buffer = '';
    for (const ch of part) {
      const next = buffer + ch;
      const piece = measure(font, size, next);
      if (piece === null) return null;
      if (piece > maxWidth && buffer) { lines.push(buffer); buffer = ch; }
      else buffer = next;
    }
    current = buffer;
  }
  flush();
  return lines.length ? lines : null;
}

function clear(lines, plan, model, font) {
  const leading = plan.size * 1.2;
  for (let index = 1; index < lines.length; index++) {
    const width = measure(font, plan.size, lines[index]);
    const x = plan.origin[0];
    const y = plan.origin[1] - index * leading;
    const corners = [[x, y - plan.size * 0.25], [x + width, y - plan.size * 0.25], [x, y + plan.size * 0.85], [x + width, y + plan.size * 0.85]];
    const pageBox = corners.map(point => apply(model.transform, point[0], point[1]));
    const box = [Math.min(...pageBox.map(point => point[0])), Math.min(...pageBox.map(point => point[1])), Math.max(...pageBox.map(point => point[0])), Math.max(...pageBox.map(point => point[1]))];
    const bounds = model.bounds;
    if (box[0] < -2 || box[1] < -2 || box[2] > bounds[2] + 2 || box[3] > bounds[3] + 2) return false;
    for (const image of model.images) if (intersects(box, image, 1)) return false;
    for (let charIndex = 0; charIndex < model.chars.length; charIndex++) {
      if (plan.charIndex.has(charIndex)) continue;
      if (intersects(box, union([model.chars[charIndex]]), 0.8)) return false;
    }
  }
  return true;
}

function ensureCjkFont(doc, page) {
  const resources = ownResources(doc, page);
  let fontsDict = resources.get('Font');
  if (fontsDict.isNull()) { fontsDict = doc.newDictionary(); resources.put('Font', fontsDict); }
  else fontsDict = fontsDict.resolve();
  let existing = null;
  fontsDict.forEach((value, key) => {
    if (existing) return;
    const item = value.resolve();
    const encoding = item.get('Encoding');
    if (!encoding.isNull() && encoding.asName() === 'UniKS-UTF16-H') existing = String(key);
  });
  if (existing) return existing;
  let name = 'FwKorea';
  const taken = new Set();
  fontsDict.forEach((_value, key) => taken.add(String(key)));
  while (taken.has(name)) name += 'x';
  fontsDict.put(name, doc.addCJKFont(cjkFont(), 'ko', 0, false));
  return name;
}

function ensureFont(doc, page, baseName) {
  const resources = ownResources(doc, page);
  let fontsDict = resources.get('Font');
  if (fontsDict.isNull()) { fontsDict = doc.newDictionary(); resources.put('Font', fontsDict); }
  else fontsDict = fontsDict.resolve();
  let existing = null;
  fontsDict.forEach((value, key) => {
    if (existing) return;
    const item = value.resolve();
    const base = item.get('BaseFont');
    const encoding = item.get('Encoding');
    if (!base.isNull() && base.asName() === baseName && !encoding.isNull() && encoding.asName() === 'WinAnsiEncoding') existing = String(key);
  });
  if (existing) return existing;
  let name = 'Fw' + baseName.replace(/[^A-Za-z0-9]/g, '');
  const taken = new Set();
  fontsDict.forEach((_value, key) => taken.add(String(key)));
  while (taken.has(name)) name += 'x';
  fontsDict.put(name, doc.addObject({Type: 'Font', Subtype: 'Type1', BaseFont: baseName, Encoding: 'WinAnsiEncoding'}));
  return name;
}

function ownResources(doc, page) {
  const obj = page.getObject();
  const own = obj.get('Resources');
  if (!own.isNull()) return own.resolve();
  const copy = doc.newDictionary();
  const inherited = obj.getInheritable('Resources');
  if (!inherited.isNull()) inherited.resolve().forEach((value, key) => copy.put(key, value));
  obj.put('Resources', copy);
  return copy;
}

function winAnsi(text) {
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    let byte = null;
    if (code <= 0x7f) byte = code;
    else if (code >= 0xa0 && code <= 0xff) byte = code;
    else if (WINANSI_EXTRA[code] !== undefined) byte = WINANSI_EXTRA[code];
    if (byte === null) return null;
    bytes.push(byte);
  }
  let out = '(';
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += '\\' + String.fromCharCode(byte);
    else if (byte < 32 || byte > 126) out += '\\' + byte.toString(8).padStart(3, '0');
    else out += String.fromCharCode(byte);
  }
  return out + ')';
}

function rgb(color) {
  if (!Array.isArray(color) || color.some(value => typeof value !== 'number' || !Number.isFinite(value))) return null;
  if (color.length === 1) return [color[0], color[0], color[0]];
  if (color.length === 3) return [color[0], color[1], color[2]];
  return null;
}

function rotationOf(page) {
  const value = page.getObject().get('Rotate');
  if (value.isNull()) return 0;
  return ((value.asNumber() % 360) + 360) % 360;
}

function apply(matrix, x, y) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

function union(chars) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ch of chars) for (let i = 0; i < 8; i += 2) {
    x0 = Math.min(x0, ch.quad[i]); y0 = Math.min(y0, ch.quad[i + 1]);
    x1 = Math.max(x1, ch.quad[i]); y1 = Math.max(y1, ch.quad[i + 1]);
  }
  return [x0, y0, x1, y1];
}

/* Width in PDF user space. Callers reach this only for rotation 0. */
function pdfSpan(transform, chars) {
  let x0 = Infinity, x1 = -Infinity;
  for (const ch of chars) for (let i = 0; i < 8; i += 2) {
    const x = apply(transform, ch.quad[i], ch.quad[i + 1])[0];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
  }
  return [x0, x1];
}

function contains(box, bbox, tol) {
  return box[0] >= bbox[0] - tol && box[1] >= bbox[1] - tol && box[2] <= bbox[2] + tol && box[3] <= bbox[3] + tol;
}

function intersects(a, b, pad) {
  return a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad;
}

function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every(value => typeof value === 'number' && Number.isFinite(value)) && box[0] < box[2] && box[1] < box[3];
}

function count(text, needle) {
  if (!needle) return 0;
  let found = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    found += 1;
    from = at + needle.length;
  }
  return found;
}

function num(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function sameImages(a, b) {
  if (a.length !== b.length) return false;
  const key = box => box.map(value => Math.round(value * 10) / 10).join(',');
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((value, index) => value === right[index]);
}

function editedName(name) {
  const base = String(name || 'document.pdf');
  return /\.pdf$/i.test(base) ? base.replace(/\.pdf$/i, '.edited.pdf') : base + '.edited.pdf';
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function warm() {
  return true;
}

function unavailableError(cause) {
  const error = new BrowserPdfError(
    'engine_unavailable',
    'PDF 엔진을 불러오지 못했습니다.',
    cause ? {reason: String(cause.message || cause.name || cause)} : {},
  );
  return error;
}

const SYMBOL_FALLBACK = {
  0x00a0: ' ',
  0x2009: ' ',
  0x200a: ' ',
  0x202f: ' ',
  0x2010: '-',
  0x2011: '-',
  0x2012: '-',
  0x2215: '/',
  0x2217: '*',
  0x2662: '<>',
  0x2192: '->',
  0x2190: '<-',
  0x2194: '<->',
  0x21d2: '=>',
  0x2208: 'in',
  0x2209: 'not in',
  0x226a: '<<',
  0x226b: '>>',
};

const CJK_RANGES = [
  [0x1100, 0x11ff],
  [0x2e80, 0x9fff],
  [0xa960, 0xa97f],
  [0xac00, 0xd7af],
  [0xd7b0, 0xd7ff],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xffef],
  [0x20000, 0x2fa1f],
];

function isCjkCodePoint(cp) {
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

function winAnsiByte(cp) {
  if (cp <= 0x7f) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  if (WINANSI_EXTRA[cp] !== undefined) return WINANSI_EXTRA[cp];
  return null;
}

function base14FromStyle(style) {
  const bare = String(style?.fontName || '').replace(/^[A-Z]{6}\+/, '');
  if (BASE14.includes(bare)) return bare;
  if (FACE_ALIAS[bare]) return FACE_ALIAS[bare];
  const bold = !!style?.isBold;
  const italic = !!style?.isItalic;
  const family = style?.isMono ? 'Courier' : style?.isSerif !== false ? 'Times' : 'Helvetica';
  return base14Style(family, bold, italic);
}

function readRewritePage(page) {
  const transform = page.getTransform();
  const toPdf = mupdf.Matrix.invert(transform);
  const bounds = page.getBounds();
  const chars = [];
  const st = page.toStructuredText('preserve-whitespace');
  let lineId = -1;
  let lineDir = [1, 0];
  try {
    st.walk({
      beginLine(_bbox, _wmode, dir) {
        lineId += 1;
        lineDir = [Number(dir?.[0]) || 0, Number(dir?.[1]) || 0];
        if (!lineDir[0] && !lineDir[1]) lineDir = [1, 0];
      },
      onChar(c, origin, font, size, quad, color) {
        try {
          const pdfOrigin = apply(toPdf, origin[0], origin[1]);
          chars.push({
            c,
            origin: [origin[0], origin[1]],
            pdfOrigin,
            lineId,
            lineDir,
            fontName: font.getName(),
            isBold: font.isBold(),
            isItalic: font.isItalic(),
            isSerif: font.isSerif(),
            isMono: font.isMono(),
            size: Number(size) > 0 ? Number(size) : 10,
            quad: [...quad],
            color: rgb(color) || [0, 0, 0],
          });
        } finally {
          try { font.destroy(); } catch { /* ignore */ }
        }
      },
    });
  } finally {
    try { st.destroy(); } catch { /* ignore */ }
  }
  return {chars, bounds, transform, toPdf};
}

function rectsToDisplay(rects, bounds) {
  const bx0 = bounds[0];
  const by0 = bounds[1];
  const bw = bounds[2] - bx0;
  const bh = bounds[3] - by0;
  const out = [];
  for (const r of Array.isArray(rects) ? rects : []) {
    if (!r || typeof r !== 'object') continue;
    const x = Number(r.x);
    const y = Number(r.y);
    const w = Number(r.w);
    const h = Number(r.h);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (!(w > 0) || !(h > 0)) continue;
    out.push([
      bx0 + x * bw,
      by0 + y * bh,
      bx0 + (x + w) * bw,
      by0 + (y + h) * bh,
    ]);
  }
  return out;
}

function selectGlyphsByRects(chars, displayRects) {
  const selected = [];
  for (const ch of chars) {
    const [gx0, gy0, gx1, gy1] = quadBounds(ch.quad);
    const cx = (gx0 + gx1) / 2;
    const cy = (gy0 + gy1) / 2;
    for (const [rx0, ry0, rx1, ry1] of displayRects) {
      const rw = rx1 - rx0;
      const rh = ry1 - ry0;
      const tolX = rw < rh && rw < 8 ? Math.min(0.5, rw * 0.08) : 0.5;
      const tolY = Math.min(1.5, Math.max(0.5, rh * 0.15));
      if (cx >= rx0 - tolX && cx <= rx1 + tolX && cy >= ry0 - tolY && cy <= ry1 + tolY) {
        selected.push(ch);
        break;
      }
    }
  }
  return selected;
}

const ALIGN_HYPHEN_RE = /[\u00ad\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;

function normalizeAlignText(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(ALIGN_HYPHEN_RE, '-')
    .replace(/\s+/g, '');
}

function rectCenterOf(displayRects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [rx0, ry0, rx1, ry1] of displayRects) {
    if (rx0 < x0) x0 = rx0;
    if (ry0 < y0) y0 = ry0;
    if (rx1 > x1) x1 = rx1;
    if (ry1 > y1) y1 = ry1;
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

function charBandMatchesRect(ch, rect) {
  const [gx0, gy0, gx1, gy1] = quadBounds(ch.quad);
  const [rx0, ry0, rx1, ry1] = rect;
  const dir = ch.lineDir || [1, 0];
  if (Math.abs(dir[1]) > Math.abs(dir[0])) {
    const tol = Math.min(1.5, Math.max(0.5, (rx1 - rx0) * 0.15));
    const cx = (gx0 + gx1) / 2;
    return cx >= rx0 - tol && cx <= rx1 + tol;
  }
  const tol = Math.min(1.5, Math.max(0.5, (ry1 - ry0) * 0.15));
  const cy = (gy0 + gy1) / 2;
  return cy >= ry0 - tol && cy <= ry1 + tol;
}

function candidateAlignLineIds(allChars, rectSelected, displayRects) {
  if (rectSelected.length) return new Set(rectSelected.map(ch => ch.lineId));
  const hitIds = new Set();
  for (const ch of allChars) {
    const box = quadBounds(ch.quad);
    if (displayRects.some(r => intersects(box, r, 1.5))) hitIds.add(ch.lineId);
  }
  if (hitIds.size) return hitIds;
  const bandIds = new Set();
  for (const ch of allChars) {
    if (displayRects.some(r => charBandMatchesRect(ch, r))) bandIds.add(ch.lineId);
  }
  return bandIds;
}

function buildAlignCorpus(lineChars) {
  let norm = '';
  const charMap = [];
  const indexMap = [];
  for (let idx = 0; idx < lineChars.length; idx++) {
    const ch = lineChars[idx];
    if (!ch.c.trim()) continue;
    const piece = normalizeAlignText(ch.c);
    for (let i = 0; i < piece.length; i++) {
      norm += piece[i];
      charMap.push(ch);
      indexMap.push(idx);
    }
  }
  return {norm, charMap, indexMap};
}

function scoreAlignOccurrence(charMap, at, len, selectedSet, rectCenter) {
  const occSet = new Set();
  for (let i = at; i < at + len; i++) occSet.add(charMap[i]);
  let overlap = 0;
  for (const ch of occSet) if (selectedSet.has(ch)) overlap += 1;
  const box = union([...occSet]);
  const dist = Math.hypot((box[0] + box[2]) / 2 - rectCenter[0], (box[1] + box[3]) / 2 - rectCenter[1]);
  return {at, occSet, overlap, dist};
}

function alignGlyphsToOriginalText(allChars, rectSelected, displayRects, originalText) {
  const needle = normalizeAlignText(originalText);
  if (!needle) return {chars: rectSelected, aligned: false};
  const lineIds = candidateAlignLineIds(allChars, rectSelected, displayRects);
  if (!lineIds.size) return {chars: rectSelected, aligned: false};
  const lineChars = allChars.filter(ch => lineIds.has(ch.lineId));
  const {norm, charMap, indexMap} = buildAlignCorpus(lineChars);
  if (norm.length < needle.length) return {chars: rectSelected, aligned: false};

  const selectedSet = new Set(rectSelected);
  const rectCenter = rectCenterOf(displayRects);
  let best = null;
  for (let from = 0; from <= norm.length - needle.length;) {
    const at = norm.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    const cand = scoreAlignOccurrence(charMap, at, needle.length, selectedSet, rectCenter);
    if (!best || cand.overlap > best.overlap || (cand.overlap === best.overlap && cand.dist < best.dist)) {
      best = cand;
    }
  }
  if (!best) return {chars: rectSelected, aligned: false};

  const firstIdx = indexMap[best.at];
  const lastIdx = indexMap[best.at + needle.length - 1];
  const aligned = [];
  for (let i = firstIdx; i <= lastIdx; i++) {
    const ch = lineChars[i];
    if (best.occSet.has(ch) || !ch.c.trim()) aligned.push(ch);
  }
  return {chars: aligned, aligned: aligned.length > 0};
}

function trimUnchangedSymbolEdges(selectedChars, newText) {
  const raw = String(newText == null ? '' : newText);
  if (!raw) return {chars: selectedChars, text: raw};
  const drawn = selectedChars.filter(ch => ch.c.trim());
  const next = [...raw];
  let start = 0;
  let end = drawn.length;
  let nStart = 0;
  let nEnd = next.length;
  const isSymbol = c => winAnsiByte(c.codePointAt(0)) === null && !isCjkCodePoint(c.codePointAt(0));
  while (end - start > 1 && nEnd - nStart > 1 && isSymbol(drawn[start].c) && drawn[start].c === next[nStart]) {
    start += 1;
    nStart += 1;
  }
  while (end - start > 1 && nEnd - nStart > 1 && isSymbol(drawn[end - 1].c) && drawn[end - 1].c === next[nEnd - 1]) {
    end -= 1;
    nEnd -= 1;
  }
  if (start === 0 && end === drawn.length) return {chars: selectedChars, text: raw};
  const firstIdx = selectedChars.indexOf(drawn[start]);
  const lastIdx = selectedChars.lastIndexOf(drawn[end - 1]);
  return {chars: selectedChars.slice(firstIdx, lastIdx + 1), text: next.slice(nStart, nEnd).join('')};
}
function alignedDisplayRects(selectedChars) {
  const byLine = new Map();
  for (const ch of selectedChars) {
    if (!ch.c.trim()) continue;
    let arr = byLine.get(ch.lineId);
    if (!arr) { arr = []; byLine.set(ch.lineId, arr); }
    arr.push(ch);
  }
  return [...byLine.values()].map(arr => union(arr));
}

function fallbackRedactionRect(ch, protectedBoxes) {
  const box = removalBox(ch) || quadBounds(ch.quad);
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const fracs = [0.5, 0.25, 0.75, 0.15, 0.85];
  if (w > 0.1 && h > 0.1) {
    for (const fy of fracs) {
      for (const fx of fracs) {
        const px = x0 + w * fx;
        const py = y0 + h * fy;
        const cand = [px - 0.05, py - 0.05, px + 0.05, py + 0.05];
        if (!protectedBoxes.some(obs => intersects(cand, obs, 0))) return cand;
      }
    }
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return [cx - 0.1, cy - 0.1, cx + 0.1, cy + 0.1];
}

function redactRewritePage(page, pagePlans, allChars) {
  const selectedSet = new Set();
  for (const plan of pagePlans) {
    for (const ch of plan.selectedChars) selectedSet.add(ch);
  }
  if (!selectedSet.size) return;

  const protectedBoxes = [];
  for (const ch of allChars) {
    if (selectedSet.has(ch) || !ch.c.trim()) continue;
    const box = removalBox(ch);
    if (box) protectedBoxes.push(box);
  }

  const quads = [];
  for (const ch of selectedSet) {
    if (!ch.c.trim()) continue;
    const rect = safeRedactionRect(ch, protectedBoxes) || fallbackRedactionRect(ch, protectedBoxes);
    const [x0, y0, x1, y1] = rect;
    quads.push([x0, y1, x1, y1, x0, y0, x1, y0]);
  }
  if (!quads.length) return;

  const annot = page.createAnnotation('Redact');
  try {
    annot.setRect(quadBounds(quads.flat()));
    annot.setQuadPoints(quads);
    annot.update();
    page.applyRedactions(
      false,
      mupdf.PDFPage.REDACT_IMAGE_NONE,
      mupdf.PDFPage.REDACT_LINE_ART_NONE,
      mupdf.PDFPage.REDACT_TEXT_REMOVE,
    );
  } finally {
    try { annot.destroy(); } catch { /* ignore */ }
  }
}

function pdfDirection(toPdf, dx, dy) {
  const p0 = apply(toPdf, 0, 0);
  const p1 = apply(toPdf, dx, dy);
  let ux = p1[0] - p0[0];
  let uy = p1[1] - p0[1];
  const len = Math.hypot(ux, uy) || 1;
  return [ux / len, uy / len];
}

const REWRITE_PAGE_MARGIN = 2;
const REWRITE_MIN_SCALE = 65;

function maxDistanceInBounds(ox, oy, dxPdf, dyPdf, transform, bounds, margin = REWRITE_PAGE_MARGIN) {
  const [sx, sy] = apply(transform, ox, oy);
  const [ex, ey] = apply(transform, ox + dxPdf, oy + dyPdf);
  const vx = ex - sx;
  const vy = ey - sy;
  const minX = bounds[0] + margin;
  const minY = bounds[1] + margin;
  const maxX = bounds[2] - margin;
  const maxY = bounds[3] - margin;
  let tMax = Infinity;
  if (vx > 1e-6) tMax = Math.min(tMax, (maxX - sx) / vx);
  else if (vx < -1e-6) tMax = Math.min(tMax, (minX - sx) / vx);
  if (vy > 1e-6) tMax = Math.min(tMax, (maxY - sy) / vy);
  else if (vy < -1e-6) tMax = Math.min(tMax, (minY - sy) / vy);
  return Math.max(0, Number.isFinite(tMax) ? tMax : 0);
}

function unitDisplayDir(dir) {
  const dx = Number(dir?.[0]) || 0;
  const dy = Number(dir?.[1]) || 0;
  const len = Math.hypot(dx, dy);
  return len > 1e-6 ? [dx / len, dy / len] : [1, 0];
}

function rectNormalThickness(rect, dir) {
  const [dx, dy] = unitDisplayDir(dir);
  return Math.abs(-dy) * (rect[2] - rect[0]) + Math.abs(dx) * (rect[3] - rect[1]);
}

function rectsMergeOnBand(line, r, vertical) {
  if (vertical) {
    const minW = Math.min(line[2] - line[0], r[2] - r[0]);
    const overlapX = Math.min(line[2], r[2]) - Math.max(line[0], r[0]);
    const gapY = Math.max(0, r[1] - line[3], line[1] - r[3]);
    return minW > 0 && overlapX >= minW * 0.5 && gapY <= minW * 2.5;
  }
  const minH = Math.min(line[3] - line[1], r[3] - r[1]);
  const overlapY = Math.min(line[3], r[3]) - Math.max(line[1], r[1]);
  const gapX = Math.max(0, r[0] - line[2], line[0] - r[2]);
  return minH > 0 && overlapY >= minH * 0.5 && gapX <= minH * 2.5;
}

function mergeDisplayLineRects(displayRects, dir = [1, 0]) {
  const [dx, dy] = unitDisplayDir(dir);
  const vertical = Math.abs(dy) > Math.abs(dx);
  const sorted = [...displayRects].sort((a, b) => (vertical ? (a[0] - b[0] || a[1] - b[1]) : (a[1] - b[1] || a[0] - b[0])));
  const lines = [];
  for (const r of sorted) {
    let merged = false;
    for (const line of lines) {
      if (rectsMergeOnBand(line, r, vertical)) {
        line[0] = Math.min(line[0], r[0]);
        line[1] = Math.min(line[1], r[1]);
        line[2] = Math.max(line[2], r[2]);
        line[3] = Math.max(line[3], r[3]);
        merged = true;
        break;
      }
    }
    if (!merged) lines.push([...r]);
  }
  const nxD = -dy;
  const nyD = dx;
  lines.sort((a, b) => {
    const na = ((a[0] + a[2]) / 2) * nxD + ((a[1] + a[3]) / 2) * nyD;
    const nb = ((b[0] + b[2]) / 2) * nxD + ((b[1] + b[3]) / 2) * nyD;
    if (Math.abs(na - nb) > 1) return na - nb;
    const ua = ((a[0] + a[2]) / 2) * dx + ((a[1] + a[3]) / 2) * dy;
    const ub = ((b[0] + b[2]) / 2) * dx + ((b[1] + b[3]) / 2) * dy;
    return ua - ub;
  });
  return lines;
}

function rightClearWidth(lineRect, sx, pageAvailW, lineDir, model, selectedSet) {
  if (Math.abs(lineDir[0] - 1) > 0.01 || Math.abs(lineDir[1]) > 0.01) return pageAvailW;
  const [, ry0, rx1, ry1] = lineRect;
  let maxRightX = model.bounds[2] - REWRITE_PAGE_MARGIN;
  for (const ch of model.chars) {
    if (selectedSet.has(ch) || !ch.c.trim()) continue;
    const [gx0, gy0, , gy1] = quadBounds(ch.quad);
    if (gy0 < ry1 && gy1 > ry0 && gx0 >= rx1 - 1) {
      maxRightX = Math.min(maxRightX, gx0 - 1);
    }
  }
  return Math.min(pageAvailW, Math.max(0, maxRightX - sx));
}

function splitCharsIntoLineBands(lineChars, dir = [1, 0]) {
  const [dx, dy] = unitDisplayDir(dir);
  const nxD = -dy;
  const nyD = dx;
  const items = lineChars.map(ch => {
    const box = quadBounds(ch.quad);
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    const thick = Math.max(1, Math.abs(nxD) * (box[2] - box[0]) + Math.abs(nyD) * (box[3] - box[1]));
    return {ch, box, nPos: cx * nxD + cy * nyD, uPos: cx * dx + cy * dy, thick};
  });
  items.sort((a, b) => a.nPos - b.nPos || a.uPos - b.uPos);
  const bands = [];
  for (const item of items) {
    let target = null;
    for (const band of bands) {
      const minT = Math.min(band.thick, item.thick);
      if (Math.abs(item.nPos - band.nPos) <= minT * 0.6) { target = band; break; }
    }
    if (!target) {
      bands.push({nPos: item.nPos, uPos: item.uPos, thick: item.thick, box: [...item.box], chars: [item.ch]});
    } else {
      target.chars.push(item.ch);
      target.box[0] = Math.min(target.box[0], item.box[0]);
      target.box[1] = Math.min(target.box[1], item.box[1]);
      target.box[2] = Math.max(target.box[2], item.box[2]);
      target.box[3] = Math.max(target.box[3], item.box[3]);
      const cx = (target.box[0] + target.box[2]) / 2;
      const cy = (target.box[1] + target.box[3]) / 2;
      target.nPos = cx * nxD + cy * nyD;
      target.thick = Math.max(target.thick, item.thick);
    }
  }
  bands.sort((a, b) => a.nPos - b.nPos || a.uPos - b.uPos);
  return bands;
}

function summarizeDrawnStyle(drawn) {
  const defaultStyle = {fontName: 'Times-Roman', isBold: false, isItalic: false, isSerif: true, isMono: false};
  if (!drawn.length) return {medianSize: 10, style: defaultStyle, color: [0, 0, 0]};
  const sizes = drawn.map(c => c.size).filter(s => s > 0).sort((a, b) => a - b);
  const medianSize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
  const styleCounts = new Map();
  let style = drawn[0];
  let bestCount = 0;
  for (const ch of drawn) {
    const key = `${ch.fontName}|${ch.isBold}|${ch.isItalic}|${ch.isSerif}|${ch.isMono}`;
    const next = (styleCounts.get(key) || 0) + 1;
    styleCounts.set(key, next);
    if (next > bestCount) { bestCount = next; style = ch; }
  }
  return {medianSize, style, color: style.color || [0, 0, 0]};
}

function charsInDisplayRect(drawn, lineRect) {
  const [rx0, ry0, rx1, ry1] = lineRect;
  const tolX = 0.5;
  const tolY = Math.min(1.5, Math.max(0.5, (ry1 - ry0) * 0.15));
  const out = [];
  for (const ch of drawn) {
    const [gx0, gy0, gx1, gy1] = quadBounds(ch.quad);
    const cx = (gx0 + gx1) / 2;
    const cy = (gy0 + gy1) / 2;
    if (cx >= rx0 - tolX && cx <= rx1 + tolX && cy >= ry0 - tolY && cy <= ry1 + tolY) out.push(ch);
  }
  return out;
}

function maxSpanProjection(points, ox, oy, ux, uy, toPdf) {
  let maxProj = 0;
  for (const [px, py] of points) {
    const pt = apply(toPdf, px, py);
    const proj = (pt[0] - ox) * ux + (pt[1] - oy) * uy;
    if (proj > maxProj) maxProj = proj;
  }
  return maxProj;
}

function buildGlyphBandSlot(band, refRect, summary, model, selectedSet) {
  const arr = band.chars;
  const dir = arr[0].lineDir || [1, 0];
  const [ux, uy] = pdfDirection(model.toPdf, dir[0], dir[1]);
  const [nx, ny] = pdfDirection(model.toPdf, -dir[1], dir[0]);
  arr.sort((a, b) => (a.pdfOrigin[0] * ux + a.pdfOrigin[1] * uy) - (b.pdfOrigin[0] * ux + b.pdfOrigin[1] * uy));
  const [ox, oy] = arr[0].pdfOrigin;

  const glyphPts = [];
  for (const ch of arr) {
    for (let i = 0; i < 8; i += 2) glyphPts.push([ch.quad[i], ch.quad[i + 1]]);
  }
  const maxGlyphProj = maxSpanProjection(glyphPts, ox, oy, ux, uy, model.toPdf);
  const rectPts = [[refRect[0], refRect[1]], [refRect[2], refRect[1]], [refRect[0], refRect[3]], [refRect[2], refRect[3]]];
  const maxRectProj = maxSpanProjection(rectPts, ox, oy, ux, uy, model.toPdf);

  const pageAvailW = maxDistanceInBounds(ox, oy, ux, uy, model.transform, model.bounds);
  const pageAvailH = maxDistanceInBounds(ox, oy, nx, ny, model.transform, model.bounds);
  const [sx] = apply(model.transform, ox, oy);
  const rightClearW = rightClearWidth(refRect, sx, pageAvailW, dir, model, selectedSet);
  const rawW = Math.max(summary.medianSize, maxGlyphProj, maxRectProj);
  const slotWidth = pageAvailW > 0 ? Math.min(pageAvailW, rawW) : rawW;

  return {
    ox, oy, ux, uy, nx, ny,
    size: summary.medianSize,
    slotWidth, pageAvailW, pageAvailH, rightClearW,
    color: summary.color,
    style: summary.style,
  };
}

function buildEmptyRectSlot(lineRect, hasDrawn, summary, model, selectedSet) {
  const [rx0, ry0, rx1, ry1] = lineRect;
  const [ux, uy] = pdfDirection(model.toPdf, 1, 0);
  const [nx, ny] = pdfDirection(model.toPdf, 0, 1);
  const rh = Math.max(4, ry1 - ry0);
  const size = hasDrawn ? summary.medianSize : Math.max(6, Math.min(24, rh * 0.8));
  const baseY = ry0 + rh * 0.8;
  const [ox, oy] = apply(model.toPdf, rx0, baseY);
  const [ex, ey] = apply(model.toPdf, rx1, baseY);
  const pageAvailW = maxDistanceInBounds(ox, oy, ux, uy, model.transform, model.bounds);
  const pageAvailH = maxDistanceInBounds(ox, oy, nx, ny, model.transform, model.bounds);
  const rightClearW = rightClearWidth(lineRect, rx0, pageAvailW, [1, 0], model, selectedSet);
  const rawW = Math.max(size, Math.hypot(ex - ox, ey - oy));
  const slotWidth = pageAvailW > 0 ? Math.min(pageAvailW, rawW) : rawW;

  return {
    ox, oy, ux, uy, nx, ny,
    size, slotWidth, pageAvailW, pageAvailH, rightClearW,
    color: summary.color,
    style: summary.style,
  };
}

function sortSlotsAlongNormal(slots, dir, transform) {
  if (slots.length < 2) return slots;
  const [dx, dy] = unitDisplayDir(dir);
  const nxD = -dy;
  const nyD = dx;
  const tol = Math.max(1, slots[0].size * 0.4);
  return slots.sort((a, b) => {
    const [ax, ay] = apply(transform, a.ox, a.oy);
    const [bx, by] = apply(transform, b.ox, b.oy);
    const na = ax * nxD + ay * nyD;
    const nb = bx * nxD + by * nyD;
    if (Math.abs(na - nb) > tol) return na - nb;
    return (ax * dx + ay * dy) - (bx * dx + by * dy);
  });
}

function buildRewriteSlots(selectedChars, displayRects, model) {
  const drawn = selectedChars.filter(ch => ch.c.trim());
  const selectedSet = new Set(selectedChars);
  const summary = summarizeDrawnStyle(drawn);
  const domDir = drawn.length ? unitDisplayDir(drawn[0].lineDir) : [1, 0];
  const lineRects = mergeDisplayLineRects(displayRects, domDir);
  const slots = [];

  for (const lineRect of lineRects) {
    const lineChars = charsInDisplayRect(drawn, lineRect);
    if (!lineChars.length) {
      slots.push(buildEmptyRectSlot(lineRect, drawn.length > 0, summary, model, selectedSet));
      continue;
    }
    const lineDir = unitDisplayDir(lineChars[0].lineDir);
    const thick = rectNormalThickness(lineRect, lineDir);
    const bands = thick > summary.medianSize * 1.8 ? splitCharsIntoLineBands(lineChars, lineDir) : [{box: lineRect, chars: lineChars}];
    const vertical = Math.abs(lineDir[1]) > Math.abs(lineDir[0]);
    for (const band of bands) {
      const refRect = bands.length === 1
        ? lineRect
        : vertical
          ? [band.box[0], lineRect[1], band.box[2], lineRect[3]]
          : [lineRect[0], band.box[1], lineRect[2], band.box[3]];
      slots.push(buildGlyphBandSlot(band, refRect, summary, model, selectedSet));
    }
  }
  return sortSlotsAlongNormal(slots, domDir, model.transform);
}

function sanitizeRewriteText(raw) {
  let text = String(raw == null ? '' : raw);
  text = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  text = text.normalize('NFC');
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (SYMBOL_FALLBACK[cp] !== undefined && cp !== 0x2217 && cp !== 0x2662 && cp !== 0x2192 && cp !== 0x2190 && cp !== 0x2194 && cp !== 0x21d2 && cp !== 0x2208 && cp !== 0x2209 && cp !== 0x226a && cp !== 0x226b) {
      out += SYMBOL_FALLBACK[cp];
    } else {
      out += ch;
    }
  }
  return out;
}

function normalizeCharForFont(ch, nimbusFont) {
  const cp = ch.codePointAt(0);
  if (isCjkCodePoint(cp)) return {kind: 'cjk', text: ch};
  if (winAnsiByte(cp) !== null && nimbusFont.encodeCharacter(cp)) return {kind: 'winansi', text: ch};
  if (nimbusFont.encodeCharacter(cp)) return {kind: 'cid', text: ch};
  if (SYMBOL_FALLBACK[cp] !== undefined) return {kind: 'winansi', text: SYMBOL_FALLBACK[cp]};
  const folded = ch.normalize('NFKD');
  let kept = '';
  for (const part of folded) {
    const pcp = part.codePointAt(0);
    if (pcp >= 0x0300 && pcp <= 0x036f) continue; // strip combining marks
    if (nimbusFont.encodeCharacter(pcp)) kept += part;
  }
  if (kept) {
    const allWin = [...kept].every(c => winAnsiByte(c.codePointAt(0)) !== null);
    return {kind: allWin ? 'winansi' : 'cid', text: kept};
  }
  return {kind: 'winansi', text: '?'};
}

function splitRewriteRuns(lineText, baseName) {
  const nimbusFont = metrics(baseName);
  const koFont = cjkFont();
  const pieces = [];
  let needsCid = false;
  for (const ch of lineText) {
    const item = normalizeCharForFont(ch, nimbusFont);
    if (item.kind === 'cid') needsCid = true;
    pieces.push(item);
  }
  // If any non-CJK char on the line needs Tier 2 Nimbus CID, promote all non-CJK chars
  // on this line to Nimbus CID to avoid mid-token Type1/Type0 switches.
  const runs = [];
  for (const item of pieces) {
    const kind = item.kind === 'cjk' ? 'cjk' : (needsCid ? 'cid' : 'winansi');
    const prev = runs[runs.length - 1];
    if (prev && prev.kind === kind) prev.text += item.text;
    else runs.push({kind, text: item.text, font: kind === 'cjk' ? koFont : nimbusFont, baseName});
  }
  return runs;
}

function measureRewriteRun(run, size) {
  let w = 0;
  for (const ch of run.text) {
    const cp = ch.codePointAt(0);
    const gid = run.font.encodeCharacter(cp);
    const adv = gid ? run.font.advanceGlyph(gid, 0) : (run.kind === 'cjk' ? 1.0 : 0.5);
    w += (adv > 0 ? adv : (run.kind === 'cjk' ? 1.0 : 0.5)) * size;
  }
  return w;
}

function measureRewriteLine(lineText, baseName, size) {
  if (!lineText) return 0;
  const runs = splitRewriteRuns(lineText, baseName);
  let total = 0;
  for (const run of runs) total += measureRewriteRun(run, size);
  return total;
}

function wrapRewriteText(text, baseName, size, slotWidths, scaleFactor = 1, overflowWidth = null) {
  const effWidth = (idx) => {
    const raw = idx < slotWidths.length
      ? slotWidths[idx]
      : (overflowWidth || slotWidths[slotWidths.length - 1] || size * 10);
    return Math.max(size * 0.5, raw / scaleFactor);
  };
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = '';
  for (const word of words) {
    const limit = effWidth(lines.length);
    const trial = current ? `${current} ${word}` : word;
    if (measureRewriteLine(trial, baseName, size) <= limit) {
      current = trial;
      continue;
    }
    if (current) {
      lines.push(current);
      current = '';
    }
    const nextLimit = effWidth(lines.length);
    if (measureRewriteLine(word, baseName, size) <= nextLimit) {
      current = word;
      continue;
    }
    // Break long word/CJK run by Unicode code point without ever dropping a char
    let buf = '';
    for (const ch of word) {
      const next = buf + ch;
      if (buf && measureRewriteLine(next, baseName, size) > effWidth(lines.length)) {
        lines.push(buf);
        buf = ch;
      } else {
        buf = next;
      }
    }
    current = buf;
  }
  if (current) lines.push(current);
  return lines;
}

function ensureNimbusCidFont(doc, page, baseName, cidState) {
  let entry = cidState.get(baseName);
  if (!entry) {
    const font = metrics(baseName);
    const pdfFont = doc.addFont(font);
    entry = {font, pdfFont, mappings: new Map()};
    cidState.set(baseName, entry);
  }
  const resources = ownResources(doc, page);
  let fontsDict = resources.get('Font');
  if (fontsDict.isNull()) { fontsDict = doc.newDictionary(); resources.put('Font', fontsDict); }
  else fontsDict = fontsDict.resolve();

  const resKey = 'FwCid' + baseName.replace(/[^A-Za-z0-9]/g, '');
  let existing = null;
  fontsDict.forEach((value, key) => {
    if (existing) return;
    if (String(key).startsWith(resKey) && value.asIndirect() === entry.pdfFont.asIndirect()) existing = String(key);
  });
  if (existing) return {resName: existing, entry};

  let name = resKey;
  const taken = new Set();
  fontsDict.forEach((_value, key) => taken.add(String(key)));
  while (taken.has(name)) name += 'x';
  fontsDict.put(name, entry.pdfFont);
  return {resName: name, entry};
}

function finalizeCidFonts(doc, cidState) {
  for (const entry of cidState.values()) {
    if (!entry.mappings.size) continue;
    const entries = [...entry.mappings].map(([gid, ch]) => `<${gid.toString(16).padStart(4, '0')}> ${utf16hex(ch)}`);
    let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /FwUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      cmap += `${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar\n`;
    }
    cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
    entry.pdfFont.put('ToUnicode', doc.addStream(new TextEncoder().encode(cmap), {}));
  }
}

function emitRewriteLinesOps(doc, page, items, baseName, cidState) {
  const nonEmpty = items.filter(item => item && item.lineText);
  if (!nonEmpty.length) return '';
  let out = 'q BT\n';
  for (const item of nonEmpty) {
    const runs = splitRewriteRuns(item.lineText, baseName);
    const [r, g, b] = item.color || [0, 0, 0];
    let lineFontSize = item.fontSize;
    let lineScale = item.hScale;
    const rawW = measureRewriteLine(item.lineText, baseName, lineFontSize);
    const maxW = item.pageAvailW;
    if (maxW > 0 && rawW * (lineScale / 100) > maxW) {
      const neededScale = Math.floor((maxW / rawW) * 1000) / 10;
      if (neededScale >= 30) {
        lineScale = Math.min(lineScale, neededScale);
      } else {
        lineScale = Math.min(lineScale, 30);
        lineFontSize = Math.max(1, (maxW / (rawW * (lineScale / 100))) * lineFontSize);
      }
    }
    out += `${num(r)} ${num(g)} ${num(b)} rg ${num(lineScale)} Tz `;
    out += `${num(item.ux)} ${num(item.uy)} ${num(-item.uy)} ${num(item.ux)} ${num(item.ox)} ${num(item.oy)} Tm `;
    for (const run of runs) {
      if (run.kind === 'winansi') {
        const resName = ensureFont(doc, page, baseName);
        const lit = winAnsi(run.text) || winAnsi('?');
        out += `/${resName} ${num(lineFontSize)} Tf ${lit} Tj `;
      } else if (run.kind === 'cjk') {
        const resName = ensureCjkFont(doc, page);
        out += `/${resName} ${num(lineFontSize)} Tf ${utf16hex(run.text)} Tj `;
      } else {
        const {resName, entry} = ensureNimbusCidFont(doc, page, baseName, cidState);
        let hex = '';
        for (const ch of run.text) {
          const gid = entry.font.encodeCharacter(ch.codePointAt(0)) || entry.font.encodeCharacter(0x3f);
          if (!entry.mappings.has(gid)) entry.mappings.set(gid, ch);
          hex += gid.toString(16).padStart(4, '0');
        }
        out += `/${resName} ${num(lineFontSize)} Tf <${hex}> Tj `;
      }
    }
    out += '\n';
  }
  return out + 'ET Q\n';
}

function buildOverflowItems(lastSlot, extraLines, baseName, fontSize, hScale, leading, overflowWidth) {
  if (!extraLines.length) return [];
  const availH = lastSlot.pageAvailH;
  if (availH > 0 && extraLines.length * leading <= availH) {
    return extraLines.map((lineText, idx) => {
      const step = leading * (idx + 1);
      const ox = lastSlot.ox + lastSlot.nx * step;
      const oy = lastSlot.oy + lastSlot.ny * step;
      let lineScale = hScale;
      const rawW = measureRewriteLine(lineText, baseName, fontSize);
      if (rawW * (lineScale / 100) > overflowWidth && overflowWidth > 0) {
        const needed = (overflowWidth / rawW) * 100;
        lineScale = Math.max(REWRITE_MIN_SCALE, Math.min(lineScale, Math.round(needed * 10) / 10));
      }
      return {
        ox, oy,
        ux: lastSlot.ux, uy: lastSlot.uy,
        color: lastSlot.color,
        pageAvailW: lastSlot.pageAvailW,
        lineText,
        fontSize,
        hScale: lineScale,
      };
    });
  }

  // Normal leading would cross the bottom page edge (where MuPDF clips glyphs).
  // Re-wrap the overflow text at progressively tighter fontSize/leading inside pageAvailH.
  const safeAvailH = Math.max(0, availH);
  const restText = extraLines.join(' ');
  const restW = Math.max(overflowWidth, lastSlot.pageAvailW);
  let restFontSize = fontSize;
  let restScale = Math.min(hScale, REWRITE_MIN_SCALE);
  let restLeading = Math.min(leading, restFontSize * 1.15);
  let restLines = wrapRewriteText(restText, baseName, restFontSize, [restW], restScale / 100, restW);

  while (restLines.length * restLeading > safeAvailH && restFontSize > 1.5) {
    restFontSize = Math.max(1.5, Math.round(restFontSize * 0.85 * 100) / 100);
    restLeading = Math.min(leading, restFontSize * 1.15);
    restLines = wrapRewriteText(restText, baseName, restFontSize, [restW], restScale / 100, restW);
  }
  if (restLines.length * restLeading > safeAvailH && restLines.length > 0) {
    restLeading = safeAvailH / restLines.length;
    restFontSize = Math.min(restFontSize, Math.max(1, restLeading > 0 ? restLeading * 0.9 : 1.5));
  }

  return restLines.map((lineText, idx) => {
    const step = restLeading * (idx + 1);
    return {
      ox: lastSlot.ox + lastSlot.nx * step,
      oy: lastSlot.oy + lastSlot.ny * step,
      ux: lastSlot.ux, uy: lastSlot.uy,
      color: lastSlot.color,
      pageAvailW: lastSlot.pageAvailW,
      lineText,
      fontSize: restFontSize,
      hScale: restScale,
    };
  });
}

function singleLineItem(slot, lineText, fontSize, hScale) {
  return {
    ox: slot.ox, oy: slot.oy,
    ux: slot.ux, uy: slot.uy,
    color: slot.color,
    pageAvailW: slot.pageAvailW,
    lineText,
    fontSize,
    hScale,
  };
}

function fitUnbrokenSingleToken(baseSlot, naturalW, baseSize) {
  for (const scale of [65, 50]) {
    const needed = (baseSlot.pageAvailW / (naturalW * (scale / 100))) * baseSize;
    if (needed >= 4) return {fontSize: needed, hScale: scale};
  }
  return null;
}

function centerNarrowSingleSlot(baseSlot, naturalW, rightOrigin) {
  if (!rightOrigin || Math.abs(baseSlot.ux - 1) > 0.01 || Math.abs(baseSlot.uy) > 0.01) return baseSlot;
  const totalSpan = rightOrigin[0] - baseSlot.ox;
  if (!(totalSpan > naturalW && totalSpan <= baseSlot.slotWidth + baseSlot.size * 0.25)) return baseSlot;
  const slack = totalSpan - naturalW;
  if (!(slack > baseSlot.size * 0.2 && slack < baseSlot.size)) return baseSlot;
  const shift = slack / 2;
  return {...baseSlot, ox: baseSlot.ox + baseSlot.ux * shift, oy: baseSlot.oy + baseSlot.uy * shift};
}

function emitSingleSlotRewrite(doc, page, baseSlot, text, baseName, cidState, rightOrigin = null) {
  const baseSize = baseSlot.size;
  const minSize = Math.max(Math.min(baseSize, 5), baseSize * 0.72);
  const naturalW = measureRewriteLine(text, baseName, baseSize);
  let fontSize = baseSize;
  let hScale = 100;
  let targetSlot = baseSlot;
  if (naturalW > baseSlot.slotWidth && baseSlot.slotWidth > 0) {
    const ratio = baseSlot.slotWidth / naturalW;
    if (ratio >= REWRITE_MIN_SCALE / 100) {
      hScale = Math.round(ratio * 1000) / 10;
    } else {
      hScale = REWRITE_MIN_SCALE;
      fontSize = Math.max(minSize, (baseSlot.slotWidth / (naturalW * (REWRITE_MIN_SCALE / 100))) * baseSize);
    }
  } else {
    targetSlot = centerNarrowSingleSlot(baseSlot, naturalW, rightOrigin);
  }
  const renderedW = measureRewriteLine(text, baseName, fontSize) * (hScale / 100);
  if (!(targetSlot.pageAvailW > 0) || renderedW <= targetSlot.pageAvailW) {
    return emitRewriteLinesOps(doc, page, [singleLineItem(targetSlot, text, fontSize, hScale)], baseName, cidState);
  }
  if (!/\s/.test(text.trim())) {
    const fitted = fitUnbrokenSingleToken(baseSlot, naturalW, baseSize);
    if (fitted) {
      return emitRewriteLinesOps(doc, page, [singleLineItem(baseSlot, text, fitted.fontSize, fitted.hScale)], baseName, cidState);
    }
  }
  const wrapW = Math.max(minSize * 2, baseSlot.pageAvailW);
  const wrapped = wrapRewriteText(text, baseName, minSize, [wrapW], REWRITE_MIN_SCALE / 100, wrapW);
  const items = [singleLineItem(baseSlot, wrapped[0], minSize, REWRITE_MIN_SCALE)];
  if (wrapped.length > 1) {
    items.push(...buildOverflowItems(baseSlot, wrapped.slice(1), baseName, minSize, REWRITE_MIN_SCALE, baseSize * 1.2, wrapW));
  }
  return emitRewriteLinesOps(doc, page, items, baseName, cidState);
}

function chooseMultiSlotWrap(text, baseName, baseSize, minSize, slotCount, wrapWidths, overflowWidth) {
  let fontSize = baseSize;
  let hScale = 100;
  let wrapped = wrapRewriteText(text, baseName, fontSize, wrapWidths, 1, overflowWidth);
  if (wrapped.length <= slotCount) return {fontSize, hScale, wrapped};
  const candidates = [
    {size: baseSize, scale: 85},
    {size: baseSize, scale: 75},
    {size: baseSize, scale: REWRITE_MIN_SCALE},
    {size: Math.max(Math.min(baseSize, 5), baseSize * 0.85), scale: REWRITE_MIN_SCALE},
    {size: minSize, scale: REWRITE_MIN_SCALE},
  ];
  for (const cand of candidates) {
    const trial = wrapRewriteText(text, baseName, cand.size, wrapWidths, cand.scale / 100, overflowWidth);
    if (trial.length < wrapped.length) {
      fontSize = cand.size;
      hScale = cand.scale;
      wrapped = trial;
    }
    if (wrapped.length <= slotCount) break;
  }
  return {fontSize, hScale, wrapped};
}

function measureSlotLeading(slots, baseSize) {
  const baseSlot = slots[0];
  const steps = [];
  for (let i = 1; i < slots.length; i++) {
    const step = (slots[i].ox - slots[i - 1].ox) * baseSlot.nx + (slots[i].oy - slots[i - 1].oy) * baseSlot.ny;
    if (step > baseSize * 0.5) steps.push(step);
  }
  if (!steps.length) return baseSize * 1.2;
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)];
}

function buildInSlotItems(slots, wrapped, wrapWidths, baseName, fontSize, hScale) {
  const items = [];
  const count = Math.min(wrapped.length, slots.length);
  for (let i = 0; i < count; i++) {
    const lineText = wrapped[i];
    if (!lineText) continue;
    const targetW = wrapWidths[i];
    let lineScale = hScale;
    const rawW = measureRewriteLine(lineText, baseName, fontSize);
    if (rawW * (lineScale / 100) > targetW && targetW > 0) {
      const needed = (targetW / rawW) * 100;
      lineScale = Math.max(REWRITE_MIN_SCALE, Math.min(lineScale, Math.round(needed * 10) / 10));
    }
    items.push(singleLineItem(slots[i], lineText, fontSize, lineScale));
  }
  return items;
}

function emitMultiSlotRewrite(doc, page, slots, text, baseName, cidState) {
  const baseSize = slots[0].size;
  const minSize = Math.max(Math.min(baseSize, 5), baseSize * 0.72);
  const baseWidths = slots.map(s => Math.max(baseSize, s.slotWidth));
  const lastSlot = slots[slots.length - 1];
  const blockW = Math.max(...baseWidths);
  const overflowWidth = Math.max(baseSize, lastSlot.pageAvailW > 0 ? Math.min(lastSlot.pageAvailW, blockW) : blockW);
  const wrapWidths = [...baseWidths];
  if (lastSlot.rightClearW > wrapWidths[wrapWidths.length - 1]) {
    wrapWidths[wrapWidths.length - 1] = Math.min(lastSlot.rightClearW, overflowWidth);
  }
  const {fontSize, hScale, wrapped} = chooseMultiSlotWrap(text, baseName, baseSize, minSize, slots.length, wrapWidths, overflowWidth);
  const leading = measureSlotLeading(slots, baseSize);
  const items = buildInSlotItems(slots, wrapped, wrapWidths, baseName, fontSize, hScale);
  if (wrapped.length > slots.length) {
    items.push(...buildOverflowItems(lastSlot, wrapped.slice(slots.length), baseName, fontSize, hScale, leading, overflowWidth));
  }
  return emitRewriteLinesOps(doc, page, items, baseName, cidState);
}

function emitRewriteEdit(doc, page, slots, rawNewText, cidState, rightOrigin = null) {
  const sanitized = sanitizeRewriteText(rawNewText);
  // '\n' in newText is a soft break: normalize newlines to single spaces so words reflow across slots
  const text = sanitized.replace(/^\n+|\n+$/g, '').replace(/[ ]*\n+[ ]*/g, ' ');
  if (!text.trim() || !slots.length) return '';
  const baseName = base14FromStyle(slots[0].style);
  if (slots.length === 1) return emitSingleSlotRewrite(doc, page, slots[0], text, baseName, cidState, rightOrigin);
  return emitMultiSlotRewrite(doc, page, slots, text, baseName, cidState);
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input?.bytes instanceof Uint8Array) return input.bytes;
  throw unavailableError(new TypeError('sourceBytes must be a Uint8Array'));
}

function openRewriteDoc(bytes) {
  const head = String.fromCharCode(...bytes.slice(0, Math.min(1024, bytes.byteLength)));
  if (bytes.byteLength < 5 || !head.includes('%PDF-')) throw unavailableError(new Error('not a PDF'));
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF();
  if (!doc) throw unavailableError(new Error('not a PDF'));
  if (doc.needsPassword()) {
    try { doc.authenticatePassword(''); } catch { /* best effort */ }
  }
  return doc;
}

function groupRewriteEditsByPage(edits, pageCount) {
  const byPage = new Map();
  for (const edit of Array.isArray(edits) ? edits : []) {
    if (!edit || typeof edit !== 'object') continue;
    const pageIndex = edit.pageIndex;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) continue;
    if (!Array.isArray(edit.rects) || !edit.rects.length) continue;
    let group = byPage.get(pageIndex);
    if (!group) { group = []; byPage.set(pageIndex, group); }
    group.push(edit);
  }
  return byPage;
}

function isIdentityMatrix(m) {
  const id = [1, 0, 0, 1, 0, 0];
  return Array.isArray(m) && m.length === 6 && m.every((v, i) => Math.abs(v - id[i]) < 1e-3);
}

function restoreTextStateOps(show, matrix = show.lineMatrix) {
  const tm = matrix.map(num).join(' ');
  return `BT /${show.fontName} ${num(show.fontSize)} Tf ${num(show.hScale)} Tz ${num(show.charSpace)} Tc ${num(show.wordSpace)} Tw ${num(show.rise)} Ts ${show.renderMode} Tr ${num(show.leading)} TL ${tm} Tm `;
}

const SPLICE_SAFE_NEXT_OPS = new Set(['Tm', 'Td', 'TD', 'T*', 'ET']);
const SPLICE_SKIP_OPS = new Set(['g', 'G', 'rg', 'RG', 'k', 'K', 'sc', 'SC', 'scn', 'SCN', 'cs', 'CS', 'Tf', 'Tc', 'Tw', 'Tz', 'Ts', 'Tr', 'TL']);

function nextOpAllowsSplice(latin1, offset) {
  const tail = latin1.slice(offset, offset + 256);
  const tokens = tail.match(/\/[^\s()<>[\]{}/%]+|[+-]?(?:\d+\.?\d*|\.\d+)|[A-Za-z*'"]+|[\[\]()<>]/g) || [];
  for (const tok of tokens) {
    if (tok[0] === '/' || /^[+-]?(?:\d|\.)/.test(tok)) continue;
    if (SPLICE_SKIP_OPS.has(tok)) continue;
    return SPLICE_SAFE_NEXT_OPS.has(tok);
  }
  return false;
}

function showStartX(show) {
  let sx = show.textMatrix[4];
  const scaleX = show.textMatrix[0] * (show.hScale / 100);
  for (const part of show.parts || []) {
    if (part.type !== 'adjustment') break;
    sx -= (part.value / 1000) * show.fontSize * scaleX;
  }
  return sx;
}

function findInlineSpliceTarget(shows, latin1, slot) {
  if (Math.abs(slot.ux - 1) > 0.01 || Math.abs(slot.uy) > 0.01) return null;
  let best = null;
  for (const show of shows) {
    if (!show.fontName || !isIdentityMatrix(show.ctm)) continue;
    const sx = showStartX(show);
    const sy = show.textMatrix[5];
    const dy = Math.abs(sy - slot.oy);
    const yTol = Math.max(1.5, Math.max(slot.size, show.fontSize) * 0.55);
    if (dy > yTol || sx > slot.ox - 0.5) continue;
    if (!nextOpAllowsSplice(latin1, show.end)) continue;
    if (!best || sx > best.sx + 0.5 || (Math.abs(sx - best.sx) <= 0.5 && dy < best.dy)) {
      best = {show, sx, dy};
    }
  }
  return best ? best.show : null;
}

function pageContentStreams(page) {
  const contents = page.getObject().get('Contents');
  if (contents.isNull()) return [];
  const out = [];
  const count = contents.isArray() ? contents.length : 1;
  for (let i = 0; i < count; i++) {
    const ref = contents.isArray() ? contents.get(i) : contents;
    if (ref.isStream()) out.push(ref);
  }
  return out;
}

function readStreamLatin1(streamObj) {
  const buf = streamObj.readStream();
  try {
    const u8 = buf.asUint8Array();
    let out = '';
    for (let i = 0; i < u8.length; i += 8192) {
      out += String.fromCharCode(...u8.subarray(i, i + 8192));
    }
    return {bytes: u8.slice(), latin1: out};
  } finally {
    buf.destroy();
  }
}

function writeStreamLatin1(streamObj, latin1) {
  const out = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) out[i] = latin1.charCodeAt(i) & 0xff;
  streamObj.writeStream(out);
}

function findRightSiblingOrigin(selectedChars, allChars, slot) {
  if (!slot || Math.abs(slot.ux - 1) > 0.01 || Math.abs(slot.uy) > 0.01) return null;
  const drawn = selectedChars.filter(ch => ch.c.trim());
  if (!drawn.length) return null;
  const lineId = drawn[0].lineId;
  if (drawn.some(ch => ch.lineId !== lineId)) return null;
  const selectedSet = new Set(selectedChars);
  let maxX = slot.ox;
  for (const ch of drawn) if (ch.pdfOrigin[0] > maxX) maxX = ch.pdfOrigin[0];
  let best = null;
  for (const ch of allChars) {
    if (ch.lineId !== lineId || selectedSet.has(ch) || !ch.c.trim()) continue;
    const x = ch.pdfOrigin[0];
    if (x > maxX + 0.5 && (!best || x < best[0])) best = ch.pdfOrigin;
  }
  return best;
}

function findTjHolePart(show, slot, rightOrigin) {
  if (show.kind !== 'TJ' || !rightOrigin || !Array.isArray(show.parts) || show.parts.length < 3) return null;
  const holeW = rightOrigin[0] - slot.ox;
  if (!(holeW > 0)) return null;
  const scaleX = show.textMatrix[0] * (show.hScale / 100);
  const minJump = Math.max(4, holeW * 0.65);
  let best = null;
  let bestJump = 0;
  for (let i = 1; i < show.parts.length - 1; i++) {
    const part = show.parts[i];
    if (part.type !== 'adjustment' || !(part.value < 0)) continue;
    const jumpW = (-part.value / 1000) * show.fontSize * scaleX;
    if (jumpW >= minJump && jumpW > bestJump) { best = part; bestJump = jumpW; }
  }
  return best;
}

function buildInlineSplice(entry, show, item) {
  const holePart = findTjHolePart(show, item.slots[0], item.rightOrigin);
  if (holePart) {
    const rightTm = [show.textMatrix[0], show.textMatrix[1], show.textMatrix[2], show.textMatrix[3], item.rightOrigin[0], item.rightOrigin[1]];
    const leftHalf = entry.latin1.slice(show.start, holePart.start) + ']TJ';
    const rightHalf = '[' + entry.latin1.slice(holePart.end, show.end);
    const lm = show.lineMatrix.map(num).join(' ');
    return {
      start: show.start,
      end: show.end,
      piece: `${leftHalf} ET\n${item.ops}${restoreTextStateOps(show, rightTm)}${rightHalf} ${lm} Tm `,
    };
  }
  return {
    start: show.end,
    end: show.end,
    piece: ` ET\n${item.ops}${restoreTextStateOps(show)}`,
  };
}

function spliceRewriteOpsInline(page, emittedPlans) {
  const streams = pageContentStreams(page);
  if (!streams.length) return emittedPlans.map(p => p.ops).join('');
  const scanned = streams.map(streamObj => {
    const {bytes, latin1} = readStreamLatin1(streamObj);
    const parsed = scanTextShows(bytes);
    return {streamObj, latin1, parsed, splices: []};
  });

  const usedShows = new Set();
  let fallbackOps = '';
  for (const item of emittedPlans) {
    const firstSlot = item.slots[0];
    let matched = null;
    if (firstSlot) {
      for (const entry of scanned) {
        if (entry.parsed.diagnostics.length) continue;
        const show = findInlineSpliceTarget(entry.parsed.shows, entry.latin1, firstSlot);
        if (show && !usedShows.has(show)) { matched = {entry, show}; break; }
      }
    }
    if (!matched) {
      fallbackOps += item.ops;
      continue;
    }
    usedShows.add(matched.show);
    matched.entry.splices.push(buildInlineSplice(matched.entry, matched.show, item));
  }

  for (const entry of scanned) {
    if (!entry.splices.length) continue;
    entry.splices.sort((a, b) => b.start - a.start);
    let next = entry.latin1;
    for (const sp of entry.splices) {
      next = next.slice(0, sp.start) + sp.piece + next.slice(sp.end);
    }
    writeStreamLatin1(entry.streamObj, next);
  }
  return fallbackOps;
}

function dedupeRewritePlans(pagePlans, model) {
  const claimed = new Set();
  const kept = [];
  for (let i = pagePlans.length - 1; i >= 0; i--) {
    const plan = pagePlans[i];
    const hadDrawn = plan.selectedChars.some(ch => ch.c.trim());
    const remaining = plan.selectedChars.filter(ch => !claimed.has(ch));
    const hasDrawn = remaining.some(ch => ch.c.trim());
    if (hadDrawn && !hasDrawn) continue;
    for (const ch of remaining) claimed.add(ch);
    if (remaining.length !== plan.selectedChars.length) {
      const slotRects = plan.aligned ? alignedDisplayRects(remaining) : plan.displayRects;
      plan.selectedChars = remaining;
      plan.slots = buildRewriteSlots(remaining, slotRects.length ? slotRects : plan.displayRects, model);
    }
    kept.push(plan);
  }
  return kept.reverse();
}

function applyRewritePage(doc, pageIndex, pageEdits, cidState) {
  const page = doc.loadPage(pageIndex);
  try {
    const model = readRewritePage(page);
    const rawPlans = [];
    for (const edit of pageEdits) {
      const displayRects = rectsToDisplay(edit.rects, model.bounds);
      if (!displayRects.length) continue;
      const rectSelected = selectGlyphsByRects(model.chars, displayRects);
      const alignedRes = alignGlyphsToOriginalText(model.chars, rectSelected, displayRects, edit.originalText);
      const trimmed = alignedRes.aligned
        ? trimUnchangedSymbolEdges(alignedRes.chars, edit.newText)
        : {chars: alignedRes.chars, text: edit.newText};
      const slotRects = alignedRes.aligned ? alignedDisplayRects(trimmed.chars) : displayRects;
      const slots = buildRewriteSlots(trimmed.chars, slotRects.length ? slotRects : displayRects, model);
      rawPlans.push({edit, displayRects, selectedChars: trimmed.chars, newText: trimmed.text, slots, aligned: alignedRes.aligned});
    }
    const pagePlans = dedupeRewritePlans(rawPlans, model);
    if (!pagePlans.length) return;
    redactRewritePage(page, pagePlans, model.chars);
    const emitted = [];
    for (const plan of pagePlans) {
      const rightOrigin = findRightSiblingOrigin(plan.selectedChars, model.chars, plan.slots[0]);
      const ops = emitRewriteEdit(doc, page, plan.slots, plan.newText, cidState, rightOrigin);
      if (ops) emitted.push({slots: plan.slots, ops, rightOrigin});
    }
    if (!emitted.length) return;
    const fallbackOps = spliceRewriteOpsInline(page, emitted);
    if (fallbackOps) appendStream(doc, page, fallbackOps);
  } finally {
    try { page.destroy(); } catch { /* ignore */ }
  }
}

function saveRewriteDoc(doc) {
  const saved = doc.saveToBuffer('garbage=compact');
  try {
    return saved.asUint8Array().slice();
  } finally {
    try { saved.destroy(); } catch { /* ignore */ }
  }
}

async function rewriteExclusive(sourceBytes, edits) {
  let doc = null;
  try {
    const bytes = toUint8Array(sourceBytes);
    doc = openRewriteDoc(bytes);
    const byPage = groupRewriteEditsByPage(edits, doc.countPages());
    if (!byPage.size) return bytes.slice();
    const cidState = new Map();
    for (const [pageIndex, pageEdits] of byPage) {
      applyRewritePage(doc, pageIndex, pageEdits, cidState);
    }
    finalizeCidFonts(doc, cidState);
    return saveRewriteDoc(doc);
  } catch (error) {
    if (error instanceof BrowserPdfError && error.code === 'engine_unavailable') throw error;
    throw unavailableError(error);
  } finally {
    try { doc?.destroy(); } catch { /* ignore */ }
  }
}

export async function rewrite(sourceBytes, edits) {
  return exclusive(() => rewriteExclusive(sourceBytes, edits));
}

globalThis.FalsifyBrowserPdf = {prepare, rewrite, warm, ENGINE, LIMITS, COORDINATE_SPACE, COORDINATES, BrowserPdfError};
