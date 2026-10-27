import * as mupdf from 'mupdf';
import {hex} from './paragraph-pdf-crypto.mjs';

const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 25 * 1024 * 1024;
const id = (kind, value) => `${kind}-${hex(new TextEncoder().encode(JSON.stringify(value))).slice(0, 24)}`;
const checkAbort = signal => { if (signal?.aborted) { const e = new Error('Document reading cancelled'); e.name = 'AbortError'; e.code = 'aborted'; throw e; } };
const boxOK = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];
const cloneBox = b => boxOK(b) ? [...b] : null;
const quadBox = q => q?.length === 8 ? [Math.min(q[0],q[2],q[4],q[6]),Math.min(q[1],q[3],q[5],q[7]),Math.max(q[0],q[2],q[4],q[6]),Math.max(q[1],q[3],q[5],q[7])] : null;

/** Normalize observed structured-text blocks, retaining reader character order and UTF-16 offsets. */
export function normalizeDocument({sourceSha256, pages, signal} = {}) {
  checkAbort(signal);
  if (typeof sourceSha256 !== 'string' || !HASH.test(sourceSha256) || !Array.isArray(pages)) throw new TypeError('Expected lowercase sourceSha256 and observed pages');
  const model = {schema:'falsify.paper-document.v1',sourceSha256,pages:[],blocks:[],styles:[],assets:[],relations:[],diagnostics:[]};
  const styles = new Map();
  for (let pageIndex=0; pageIndex<pages.length; pageIndex++) {
    checkAbort(signal);
    const page=pages[pageIndex];
    if (!page || !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width<=0 || page.height<=0 || !Array.isArray(page.blocks) || !Array.isArray(page.images)) throw new TypeError('Invalid observed page');
    let offset=0, pageText=''; const blocks=[];
    for (let index=0; index<page.blocks.length; index++) {
      checkAbort(signal);
      const item=page.blocks[index]; if (!Array.isArray(item.chars)) throw new TypeError('Invalid observed block characters');
      const start=offset, chars=[], styleIds=[]; let text='';
      for (const c of item.chars) {
        if (typeof c.text !== 'string') throw new TypeError('Invalid observed character');
        const from=offset; offset+=c.text.length; text+=c.text;
        const style={fontName:typeof c.fontName==='string'?c.fontName:null,size:Number.isFinite(c.size)?c.size:null,color:Array.isArray(c.color)?[...c.color]:null};
        const key=JSON.stringify(style); let styleId=styles.get(key);
        if (!styleId) {styleId=id('style',[sourceSha256,style]); styles.set(key,styleId); model.styles.push({id:styleId,...style});}
        styleIds.push(styleId); chars.push({start:from,end:offset,bbox:cloneBox(c.bbox),styleId});
      }
      pageText+=text;
      if (!text.length) continue;
      const bbox=cloneBox(item.bbox);
      if (!bbox || chars.some(c=>!c.bbox)) model.diagnostics.push({code:'text-geometry-unavailable',pageIndex,blockIndex:index});
      if (item.lines && (!Array.isArray(item.lines) || item.lines.some(line=>!Number.isInteger(line.start) || !Number.isInteger(line.end) || line.start<0 || line.start>line.end || line.end>chars.length))) throw new TypeError('Invalid observed line ranges');
      const lines = Array.isArray(item.lines) ? item.lines.map(line => ({
        range:{start:line.start === chars.length ? offset : chars[line.start].start,end:line.end === 0 ? start : chars[line.end-1].end},
        bbox:cloneBox(line.bbox), direction:Array.isArray(line.direction)?[...line.direction]:null,
        writingMode:Number.isFinite(line.writingMode)?line.writingMode:null, baseline:line.baseline ? line.baseline.map(p=>[...p]) : null
      })) : [];
      if (!lines.length) model.diagnostics.push({code:'line-boundaries-unavailable',pageIndex,blockIndex:index});
      blocks.push({id:id('block',[sourceSha256,pageIndex,start,offset]),kind:'paragraph',text,source:{pageIndex,bbox,range:{start,end:offset},characters:chars,lines},styleId:styleIds.every(s=>s===styleIds[0])?styleIds[0]:null,assetIds:[],captionIds:[]});
    }
    // Only order columns when every block falls on one side of an empty vertical strip.
    let ordered=blocks, gutter=null;
    if (blocks.length>=2 && blocks.every(b=>b.source.bbox)) {
      const edges=[...new Set(blocks.flatMap(b=>[b.source.bbox[0],b.source.bbox[2]]))].sort((a,b)=>a-b);
      const candidates=[];
      for(let i=0;i<edges.length-1;i++) {const l=edges[i],r=edges[i+1],mid=(l+r)/2;
        if (r-l>=Math.max(12,page.width*0.025) && blocks.every(b=>b.source.bbox[2]<=mid || b.source.bbox[0]>=mid)) {
          const left=blocks.filter(b=>b.source.bbox[2]<=mid),right=blocks.filter(b=>b.source.bbox[0]>=mid);
          if(left.length>=2 && right.length>=2 && Math.max(...left.map(b=>b.source.bbox[3]))>=Math.min(...right.map(b=>b.source.bbox[1])) && Math.max(...right.map(b=>b.source.bbox[3]))>=Math.min(...left.map(b=>b.source.bbox[1]))) candidates.push({l,r,left,right});
        }
      }
      if(candidates.length===1) {const c=candidates[0]; gutter=[c.l,c.r]; const order=(a,b)=>a.source.bbox[1]-b.source.bbox[1] || a.source.bbox[0]-b.source.bbox[0] || a.source.range.start-b.source.range.start; ordered=[...c.left.sort(order),...c.right.sort(order)];}
    }
    if (!gutter && blocks.length>1) model.diagnostics.push({code:'reading-order-unresolved',pageIndex,detail:'Reader order retained; no unique page-wide column gutter established.'});
    model.pages.push({sourcePageIndex:pageIndex,width:page.width,height:page.height,text:pageText,geometry:page.geometry ?? {frame:'caller-observed',originalPageMapping:'unverified'},readingOrder:gutter?'geometry-columns':'reader',columnGutter:gutter});
    if (gutter) model.diagnostics.push({code:'reading-order-heuristic',pageIndex,detail:'Column gutter ordering is geometric, not semantic proof.'});
    if (page.geometry?.originalPageMapping !== 'verified') model.diagnostics.push({code:'original-page-geometry-unverified',pageIndex,detail:'Source boxes are in the observed frame; mapping to original PDF coordinates is not established.'});
    model.blocks.push(...ordered);
    for (let index=0;index<page.images.length;index++) {const bbox=cloneBox(page.images[index].bbox); const assetId=id('asset',[sourceSha256,pageIndex,index,bbox]); model.assets.push({id:assetId,kind:'image',source:{pageIndex,bbox,occurrence:index}}); if(!bbox)model.diagnostics.push({code:'image-geometry-unavailable',pageIndex,occurrence:index});}
    if (!blocks.length) model.diagnostics.push({code:'no-extracted-text',pageIndex});
  }
  model.diagnostics.push({code:'semantic-structure-unavailable',detail:'Block kinds are text-block placeholders; caption links, font files, vector assets and OCR are not recovered.'});
  return model;
}

/** Read File, Uint8Array, or {bytes: Uint8Array} using the installed MuPDF reader. */
export async function readDocument({file,fileHash,signal} = {}) {
  checkAbort(signal);
  if (fileHash !== undefined && (typeof fileHash!=='string' || !/^[a-f0-9]{64}$/i.test(fileHash))) throw new TypeError('fileHash must be a SHA-256 hex digest');
  if (Number.isFinite(file?.size) && file.size>MAX_BYTES) throw new Error('PDF exceeds 25 MiB');
  const bytes=file instanceof Uint8Array?new Uint8Array(file):file?.bytes instanceof Uint8Array?new Uint8Array(file.bytes):typeof file?.arrayBuffer==='function'?new Uint8Array(await file.arrayBuffer()):null;
  checkAbort(signal);
  if(!bytes?.length || bytes.length>MAX_BYTES) throw new Error('Expected a PDF within 25 MiB');
  const sourceSha256=hex(bytes);
  if(fileHash && sourceSha256!==fileHash.toLowerCase()) {const e=new Error('Source hash mismatch');e.code='stale-source';throw e;}
  let doc; const pages=[];
  try {
    doc=mupdf.Document.openDocument(bytes,'application/pdf').asPDF();
    if(!doc || doc.needsPassword()) throw new Error('Unsupported PDF');
    for(let i=0;i<doc.countPages();i++) {
      checkAbort(signal); let page,st;
      try {
        page=doc.loadPage(i); const bounds=page.getBounds();
        if(bounds[0]!==0 || bounds[1]!==0) throw new Error('Unsupported page origin');
        const observed={width:bounds[2]-bounds[0],height:bounds[3]-bounds[1],geometry:{frame:'mupdf-display',bounds:[...bounds],pageTransform:[...page.getTransform()],originalPageMapping:'unverified'},blocks:[],images:[]}; let block,line;
        st=page.toStructuredText('preserve-whitespace,preserve-images');
        st.walk({beginTextBlock(bbox){checkAbort(signal);block={bbox:[...bbox],chars:[],lines:[]};observed.blocks.push(block);},
          beginLine(bbox,writingMode,direction){checkAbort(signal);line={bbox:[...bbox],writingMode,direction:[...direction],start:block.chars.length,end:block.chars.length,baseline:null};block.lines.push(line);},
          onChar(text,origin,font,size,quad,color){checkAbort(signal);if(!block || !line) throw new Error('Unexpected character outside text line');block.chars.push({text,bbox:quadBox(quad),fontName:font.getName(),size,color:color?[...color]:null});line.end=block.chars.length;const point=[...origin];if(!line.baseline) line.baseline=[point,point];else line.baseline[1]=point;},
          endLine(){line=null;},endTextBlock(){block=null;},onImageBlock(bbox){checkAbort(signal);observed.images.push({bbox:[...bbox]});}});
        pages.push(observed);
      } finally {st?.destroy();page?.destroy();}
      // Yield to allow an AbortSignal from the event loop to be observed between pages.
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  } finally {doc?.destroy();}
  checkAbort(signal); return normalizeDocument({sourceSha256,pages,signal});
}
