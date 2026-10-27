import * as mupdf from 'mupdf';
import {hex} from './paragraph-pdf-crypto.mjs';

const abort = signal => { if (signal?.aborted) { const e = new Error('Source asset reading cancelled'); e.name = 'AbortError'; throw e; } };
const validBox = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];

// Resource identities are page/path scoped; equal names alone do not establish a match.
function collectFonts(resources, pageIndex, path, fonts, seen) {
  if (!resources || resources.isNull()) return;
  const dict = resources.get('Font');
  if (dict.isDictionary()) dict.forEach((ref, name) => {
    const obj = ref.resolve(), descendants = obj.get('DescendantFonts');
    const descendant = descendants.isArray() && descendants.length ? descendants.get(0) : null;
    const descriptor = (descendant && !descendant.isNull() ? descendant : obj).get('FontDescriptor');
    const baseName = obj.get('BaseFont').asName() || null;
    const identity = {pageIndex, resourcePath:`${path}/Font/${name}`, objectNumber:ref.isIndirect() ? ref.asIndirect() : null};
    const key = `${pageIndex}:${identity.resourcePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    let bytes = null, format = null;
    for (const field of ['FontFile','FontFile2','FontFile3']) {
      const stream = descriptor.isNull() ? null : descriptor.get(field);
      if (stream?.isStream()) { const buffer = stream.readStream(); try { bytes = buffer.asUint8Array().slice(); } finally { buffer.destroy(); } format = field; break; }
    }
    fonts.push({id:`font-${hex(new TextEncoder().encode(JSON.stringify(identity))).slice(0,24)}`, family:baseName, source:identity, bytes, format, subtype:obj.get('Subtype').asName() || null, flags:!descriptor.isNull() && descriptor.get('Flags').isNumber() ? descriptor.get('Flags').asNumber() : null, embedded:!!bytes, subset:!!baseName && /^[A-Z]{6}\+/.test(baseName), coverage:'unverified'});
  });
  const xobjects = resources.get('XObject');
  if (xobjects.isDictionary()) xobjects.forEach((ref, name) => {
    const key = ref.isIndirect() ? ref.asIndirect() : null;
    if (key !== null && seen.has(`form:${pageIndex}:${key}`)) return;
    const obj = ref.resolve();
    if (obj.get('Subtype').asName() !== 'Form') return;
    if (key !== null) seen.add(`form:${pageIndex}:${key}`);
    collectFonts(obj.get('Resources'), pageIndex, `${path}/XObject/${name}/Resources`, fonts, seen);
  });
}

/** Extract source-bound page crops and PDF font resources. Boxes use MuPDF display coordinates. */
export async function readSourceAssets({bytes, document, regions=[], signal}={}) {
  abort(signal);
  if (!(bytes instanceof Uint8Array) || !bytes.length || !document || !Array.isArray(regions)) throw new TypeError('Expected source bytes, document and regions');
  const snapshot = bytes.slice(), sourceSha256 = hex(snapshot);
  if (document.sourceSha256 !== sourceSha256) throw new Error('Source hash mismatch');
  const assets = (document.assets || []).map(a => ({...a, source:{...a.source}, content:a.content})), fonts=[], diagnostics=[];
  let pdf;
  try {
    pdf = mupdf.Document.openDocument(snapshot, 'application/pdf').asPDF();
    if (!pdf || pdf.needsPassword()) throw new Error('Unsupported PDF');
    const seen = new Set();
    for (let i=0; i<pdf.countPages(); i++) {
      abort(signal);
      const page = pdf.loadPage(i);
      try { collectFonts(page.getObject().getInheritable('Resources'), i, 'Resources', fonts, seen); } finally { page.destroy(); }
    }
    for (const region of regions) {
      abort(signal);
      if (!region || typeof region.id !== 'string' || !region.id || !Number.isInteger(region.pageIndex) || region.pageIndex<0 || region.pageIndex>=pdf.countPages() || !validBox(region.bbox) || !Array.isArray(region.blockIds)) throw new TypeError('Invalid source region');
      const page = pdf.loadPage(region.pageIndex); let writer, device, buffer;
      try {
        const bounds = page.getBounds(), b = region.bbox;
        if (b[0]<bounds[0] || b[1]<bounds[1] || b[2]>bounds[2] || b[3]>bounds[3]) throw new RangeError('Region outside source page');
        buffer = new mupdf.Buffer(); writer = new mupdf.DocumentWriter(buffer,'svg','');
        device = writer.beginPage([0,0,b[2]-b[0],b[3]-b[1]]);
        page.run(device, mupdf.Matrix.translate(-b[0],-b[1]));
        writer.endPage(); device.destroy(); device=null; writer.close();
        assets.push({id:region.id,kind:'region',source:{pageIndex:region.pageIndex,bbox:[...b],blockIds:[...region.blockIds]},content:{representation:'mupdf-cropped-svg',bytes:buffer.asUint8Array().slice(),width:b[2]-b[0],height:b[3]-b[1]}});
      } finally { device?.destroy(); writer?.destroy(); buffer?.destroy(); page.destroy(); }
    }
  } finally { pdf?.destroy(); }
  return {sourceSha256,assets,fonts,diagnostics};
}
