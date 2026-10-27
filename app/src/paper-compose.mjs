import {inspectFonts} from './paper-fonts.mjs';
const abort = signal => { if (signal?.aborted) throw new DOMException('Composition cancelled', 'AbortError'); };
const fail = message => { throw new Error(message); };
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2,'0')).join('');
// Typst strings are data, never parsed as markup. Encode controls in Typst's own escape syntax.
export function typstString(value) {
  return '"' + Array.from(value, c => {
    const n=c.codePointAt(0);
    if (c==='"' || c==='\\') return '\\'+c;
    if (n<32 || n===127) return `\\u{${n.toString(16)}}`;
    return c;
  }).join('') + '"';
}
function lineBoundaries(block) {
  const {range,lines=[]}=block.source;
  if (!range || range.end-range.start!==block.text.length) fail('Invalid block source range');
  let prev=range.start; const bounds=[];
  for (const line of lines) {
    const r=line.range;
    if (!r || r.start!==prev || r.end<r.start || r.end>range.end) fail('Invalid line ranges');
    if (r.start>range.start) bounds.push(r.start-range.start);
    prev=r.end;
  }
  if (lines.length && prev!==range.end) fail('Incomplete line ranges');
  return bounds;
}
function logicalText(block, changes) {
  const raw=block.text, bounds=lineBoundaries(block); let out='';
  for (let i=0;i<=raw.length;) {
    const edit=changes.find(e=>e.start===i);
    if (edit) { out+=edit.after; i=edit.end; if(edit.start===edit.end) fail('Empty edit ranges are unsupported'); continue; }
    if (i===raw.length) break;
    if (bounds.includes(i) && i>0 && !/\s/u.test(raw[i-1]) && !/\s/u.test(raw[i])) out+=' ';
    out+=raw[i++];
  }
  return out;
}
export async function composeDocument({document, edits=[], signal, sourceBytes}={}, {compile, fonts={}}={}) {
  abort(signal);
  if (document?.schema!=='falsify.paper-document.v1' || !/^[a-f0-9]{64}$/.test(document.sourceSha256) || !Array.isArray(document.blocks) || !Array.isArray(document.pages) || !document.pages.length) fail('Invalid paper document');
  if (!(sourceBytes instanceof Uint8Array) || await hash(sourceBytes)!==document.sourceSha256) fail('Source hash mismatch or source bytes unavailable');
  abort(signal);
  if (typeof compile!=='function') fail('Compiler is required');
  const ids=new Set(); for(const block of document.blocks) {if(!block.id || ids.has(block.id) || (block.text != null && typeof block.text!=='string')) fail('Ambiguous block ID or invalid text'); ids.add(block.id);}
  const changes=new Map();
  for (const edit of edits) {
    const matches=document.blocks.filter(b=>b.id===edit.blockId && b.source?.pageIndex===edit.pageIndex && b.source?.range && edit.start>=b.source.range.start && edit.end<=b.source.range.end);
    if(matches.length!==1 || !Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start>=edit.end || typeof edit.before!=='string' || typeof edit.after!=='string') fail('Ambiguous or invalid edit target');
    const b=matches[0], start=edit.start-b.source.range.start, end=edit.end-b.source.range.start;
    if (b.text.slice(start,end)!==edit.before) fail('Edit before text mismatch');
    const list=changes.get(b.id)||[]; if(list.some(e=>start<e.end && end>e.start)) fail('Overlapping edit targets');
    list.push({start,end,after:edit.after}); changes.set(b.id,list);
  }
  const texts=document.blocks.filter(b=>typeof b.text==='string' && b.text.length).map(b=>logicalText(b,changes.get(b.id)||[]));
  const coverage=await inspectFonts(texts.join('\n'),fonts); abort(signal);
  const page=document.pages[0]; if(!Number.isFinite(page.width)||!Number.isFinite(page.height)||page.width<=0||page.height<=0) fail('Invalid page size');
  // Fixed program; paper and supplied font names occur only as string values.
  let source=`#set page(width: ${page.width}pt, height: ${page.height}pt, margin: 36pt, columns: 2)\n`;
  if (fonts.family) source+=`#set text(font: ${typstString(String(fonts.family))}, size: 10pt)\n`;
  source+=texts.map(t=>`#text(${typstString(t)})`).join('\n\n');
  const compiled=await compile({source, fonts, signal}); abort(signal);
  const bytes=compiled instanceof Uint8Array ? compiled : compiled?.bytes;
  if (!(bytes instanceof Uint8Array) || new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-') fail('Compiler did not return PDF bytes');
  const sha256=await hash(bytes); abort(signal);
  const warnings=['Content, layout, output mappings and asset preservation have not been independently verified.'];
  if(document.assets?.length || document.blocks.some(b=>b.assetIds?.length || b.kind==='figure' || b.kind==='table' || b.kind==='formula')) warnings.push('Source assets and non-text figure, table or formula content are not placed by this candidate, including image blocks without source ranges.');
  if(coverage.status!=='covered') warnings.push(`Font coverage ${coverage.status}; output may lose glyphs.`);
  const verification={status:'warning', sourceSha256:document.sourceSha256, contentVerified:false, layoutVerified:false, coverage, outputTextCheck:'unavailable', edits:edits.map(e=>({blockId:e.blockId,start:e.start,end:e.end,status:'bound'}))};
  return {file:new File([bytes],'recomposed.pdf',{type:'application/pdf'}),sha256,verification,pageMap:null,blockMap:null,warnings};
}
