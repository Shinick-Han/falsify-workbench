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
  const raw=block.text, bounds=new Set(lineBoundaries(block));
  let logical=''; const before=[], after=[];
  // Map each source offset to both sides of any inserted line separator.
  for (let i=0;i<=raw.length;i++) {
    before[i]=logical.length;
    if (bounds.has(i) && i>0 && i<raw.length && !/\s/u.test(raw[i-1]) && !/\s/u.test(raw[i]) && raw[i-1]!=='-' && !(raw[i-1]==='−' && /[0-9]/u.test(raw[i]))) logical+=' ';
    after[i]=logical.length;
    if (i<raw.length) logical+=raw[i];
  }
  let out='', cursor=0;
  for (const edit of [...changes].sort((a,b)=>a.start-b.start)) {
    const start=after[edit.start], end=before[edit.end];
    out+=logical.slice(cursor,start)+edit.after;
    cursor=end;
  }
  return out+logical.slice(cursor);
}
// A source line break without whitespace does not prove whether two fragments
// were separate words. The inserted space is a layout convention, not evidence.
function ambiguousBoundaries(block, changes) {
  const raw=block.text;
  return lineBoundaries(block).filter(i=>i>0 && i<raw.length &&
    !changes.some(e=>e.start<i && i<e.end) &&
    !/\s/u.test(raw[i-1]) && !/\s/u.test(raw[i]) && raw[i-1]!=='-' &&
    !(raw[i-1]==='−' && /[0-9]/u.test(raw[i])));
}
export async function composeDocument({document, edits=[], flow, assets, signal, sourceBytes}={}, {compile, fonts={}, outputCheck}={}) {
  abort(signal);
  // Own the data used by this attempt before any asynchronous operation.
  if (document) document = structuredClone(document);
  flow = flow == null ? null : structuredClone(flow);
  assets = assets == null ? null : structuredClone(assets);
  edits = edits.map(e=>({...e}));
  sourceBytes = sourceBytes instanceof Uint8Array ? new Uint8Array(sourceBytes) : sourceBytes;
  fonts = {...fonts};
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
  if (flow) {
    if(flow.schema!=='falsify.paper-flow.v1' || flow.sourceSha256!==document.sourceSha256 || !Array.isArray(flow.items)) fail('Invalid paper flow');
    const owners=new Set();
    for(const item of flow.items) for(const id of item.blockIds || []) {
      if(!ids.has(id) || owners.has(id)) fail('Unknown or duplicate flow block');
      owners.add(id);
      if(item.kind==='asset' && changes.has(id)) fail('Cannot edit text owned by a source asset');
    }
    for(const block of document.blocks) if(block.text && !owners.has(block.id)) fail('Flow omits text block');
  }
  const assetOwned = new Set((flow?.items || []).filter(item=>item.kind==='asset').flatMap(item=>item.blockIds || []));
  const expectedBlocks=document.blocks.filter(b=>typeof b.text==='string' && b.text.length && !assetOwned.has(b.id)).map(b=>({id:b.id,text:logicalText(b,changes.get(b.id)||[])}));
  const texts=expectedBlocks.map(b=>b.text);
  const ambiguous=document.blocks.filter(b=>typeof b.text==='string' && b.text.length).flatMap(b=>ambiguousBoundaries(b,changes.get(b.id)||[]).map(offset=>({blockId:b.id,offset:offset+b.source.range.start})));
  const coverage=await inspectFonts(texts.join('\n'),fonts); abort(signal);
  const page=document.pages[0]; if(!Number.isFinite(page.width)||!Number.isFinite(page.height)||page.width<=0||page.height<=0) fail('Invalid page size');
  // Every paper string remains an argument to text(), never executable markup.
  let source=`#set page(width: ${page.width}pt, height: ${page.height}pt, margin: 36pt)\n`;
  const candidates = fonts.candidates?.filter(c=>c.getBytes?.()) || [];
  const families = [...new Set([fonts.selected?.family, ...candidates.map(c=>c.family)].filter(Boolean))];
  if (!families.length && fonts.family) families.push(String(fonts.family));
  if (families.length) source+=`#set text(font: (${families.map(typstString).join(', ')},), size: 10pt)\n`;
  const files = {};
  const assetList = Array.isArray(assets) ? assets : assets?.assets || document.assets || [];
  const blockById = new Map(document.blocks.map(b=>[b.id,b]));
  const styleById = new Map((document.styles || []).map(s=>[s.id,s]));
  const textById = new Map(expectedBlocks.map(b=>[b.id,b.text]));
  const placedAssets = new Set();
  function renderBlock(block) {
    const text=textById.get(block.id); if (!text) return '';
    const chars=block.source?.characters || [];
    if ((!chars.length || !styleById.size) && !fonts.fallback?.length) return `#text(${typstString(text)})`;
    // Build source-indexed styles, then apply the same line separators and edits.
    const raw=block.text, bounds=new Set(lineBoundaries(block));
    let logical='', styles=[], before=[], after=[];
    const styleAt=i=>chars.find(c=>c.start<=i+block.source.range.start && c.end>i+block.source.range.start)?.styleId || block.styleId;
    for(let i=0;i<=raw.length;i++) {
      before[i]=logical.length;
      if(bounds.has(i) && i>0 && i<raw.length && !/\s/u.test(raw[i-1]) && !/\s/u.test(raw[i]) && raw[i-1]!=='-' && !(raw[i-1]==='−' && /[0-9]/u.test(raw[i]))) {logical+=' ';styles.push(styleAt(i-1));}
      after[i]=logical.length;
      if(i<raw.length) {logical+=raw[i];styles.push(styleAt(i));}
    }
    let result='', mapped=[], cursor=0;
    for(const edit of [...(changes.get(block.id)||[])].sort((a,b)=>a.start-b.start)) {
      const a=after[edit.start], b=before[edit.end]; result+=logical.slice(cursor,a)+edit.after;
      mapped.push(...styles.slice(cursor,a),...Array(edit.after.length).fill(styleAt(edit.start))); cursor=b;
    }
    result+=logical.slice(cursor); mapped.push(...styles.slice(cursor));
    const familyAt=i=>fonts.fallback?.find(entry=>entry.codepoint===result.codePointAt(i) && entry.kind==='glyph')?.family || null;
    const runs=[]; for(let i=0;i<result.length;) {let j=i+(result.codePointAt(i)>0xffff?2:1); const family=familyAt(i); while(j<result.length && mapped[j]===mapped[i] && familyAt(j)===family) j+=result.codePointAt(j)>0xffff?2:1; runs.push([result.slice(i,j),styleById.get(mapped[i]),family]); i=j;}
    return runs.map(([value,style,family])=>{const size=style?.size; let opts=Number.isFinite(size)&&size>0 ? `size: ${size}pt, ` : ''; if(family) opts+=`font: ${typstString(family)}, `; const name=style?.fontName || ''; if(/bold/i.test(name)) opts+='weight: "bold", '; if(/italic|oblique/i.test(name)) opts+='style: "italic", '; return `#text(${opts}${typstString(value)})`;}).join('');
  }
  function renderAsset(id) {
    const asset=assetList.find(a=>a.id===id); const content=asset?.content; const bytes=content?.bytes;
    const rep=String(content?.representation || '').toLowerCase();
    const ext=rep.includes('svg')?'svg':rep.includes('png')?'png':null;
    if(!ext || !(bytes instanceof Uint8Array) || !bytes.length) return '';
    const path=`assets/${placedAssets.size}.${ext}`; files[path]=new Uint8Array(bytes); placedAssets.add(id);
    return `#image(${typstString(path)}, width: 100%)`;
  }
  if (flow) {
    if(flow.schema!=='falsify.paper-flow.v1' || flow.sourceSha256!==document.sourceSha256 || !Array.isArray(flow.items)) fail('Invalid paper flow');
    let group=[], columns=0;
    const flush=()=>{if(!group.length)return; source+=columns===2 ? `#columns(2)[\n${group.join('\n\n')}\n]\n` : group.join('\n\n')+'\n';group=[];};
    for(const item of flow.items) {
      const count=item.span==='page'?1:(item.columns===2?2:1); if(count!==columns){flush();columns=count;}
      let parts=[];
      if(item.kind==='asset') parts=(item.assetIds||[]).map(renderAsset).filter(Boolean);
      else parts=(item.blockIds||[]).map(id=>blockById.get(id)).filter(Boolean).map(renderBlock).filter(Boolean);
      if(parts.length) group.push(parts.join('\n'));
    }
    flush();
  } else {
    source+=`#columns(2)[\n${document.blocks.map(renderBlock).filter(Boolean).join('\n\n')}\n]`;
  }
  const compiled=await compile({source, fonts, files, signal}); abort(signal);
  const returnedBytes=compiled instanceof Uint8Array ? compiled : compiled?.bytes;
  const bytes=returnedBytes instanceof Uint8Array ? new Uint8Array(returnedBytes) : returnedBytes;
  if (!(bytes instanceof Uint8Array) || new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-') fail('Compiler did not return PDF bytes');
  const sha256=await hash(bytes); abort(signal);
  const warnings=['Content, layout, output mappings and asset preservation have not been independently verified.'];
  if(document.assets?.some(a=>!placedAssets.has(a.id)) || document.blocks.some(b=>(b.assetIds?.length || b.kind==='figure' || b.kind==='table' || b.kind==='formula') && !(b.assetIds?.length && b.assetIds.every(id=>placedAssets.has(id))))) warnings.push('Source assets and non-text figure, table or formula content are not placed by this candidate, including image blocks without source ranges.');
  if(coverage.status!=='covered') warnings.push(`Font coverage ${coverage.status}; output may lose glyphs.`);
  let outputTextCheck='unavailable', checkReport=null;
  if (typeof outputCheck==='function') {
    try { checkReport=await outputCheck({bytes:new Uint8Array(bytes), expectedBlocks:expectedBlocks.map(b=>({...b}))}); abort(signal);
      outputTextCheck=checkReport?.findings?.some(f=>f.code==='content-mismatch') ? 'finding' : checkReport?.checks?.content?.status || 'unavailable';
    } catch (error) { abort(signal); warnings.push(`Output text check unavailable: ${error.message}`); }
  }
  if (ambiguous.length) {
    warnings.push('Ambiguous source line boundaries use a spacing convention; content verification is unavailable.');
  }
  if (outputTextCheck==='finding') warnings.push('Output text check found content loss or mismatch.');
  const verification={status:outputTextCheck==='finding'?'finding':'warning', sourceSha256:document.sourceSha256, contentVerified:outputTextCheck==='pass' && !ambiguous.length, layoutVerified:false, coverage, outputTextCheck, checkReport, ambiguousBoundaries:ambiguous, edits:edits.map(e=>({blockId:e.blockId,start:e.start,end:e.end,status:'bound'}))};
  return {file:new File([bytes],'recomposed.pdf',{type:'application/pdf'}),sha256,verification,pageMap:null,blockMap:null,warnings};
}
