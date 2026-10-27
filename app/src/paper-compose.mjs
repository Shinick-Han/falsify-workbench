import {readSourceGlyphs} from './paper-source-glyphs.mjs';
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
function separators(block) {
  const raw=block.text, base=block.source.range.start;
  const hints=new Set((block.source.wordSpaceOffsets || []).filter(x=>Number.isInteger(x) && x>base && x<base+raw.length).map(x=>x-base));
  const guessed=lineBoundaries(block).filter(i=>i>0 && i<raw.length && !/\s/u.test(raw[i-1]) && !/\s/u.test(raw[i]) && raw[i-1]!=='-' && !(raw[i-1]==='−' && /[0-9]/u.test(raw[i])));
  return new Set([...guessed,...hints].filter(i=>! /\s/u.test(raw[i-1]) && ! /\s/u.test(raw[i])));
}
function logicalText(block, changes, omitted = new Set(), spaces = separators(block)) {
  const raw=block.text;
  let logical=''; const before=[], after=[];
  // Map each source offset to both sides of any inserted line separator.
  for (let i=0;i<=raw.length;i++) {
    before[i]=logical.length;
    if (spaces.has(i)) logical+=' ';
    after[i]=logical.length;
    if (i<raw.length && !omitted.has(i)) logical+=raw[i];
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
  return lineBoundaries(block).filter(i=>!(block.source.wordSpaceOffsets||[]).includes(i+block.source.range.start) && i>0 && i<raw.length &&
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
  const originalFonts=fonts, glyphLookup=fonts.hasGlyph;
  const snapshots=(fonts.candidates || []).map(c=>{const b=c.getBytes?.(); const bytes=b instanceof Uint8Array ? Uint8Array.from(b) : null; return {id:c.id,family:c.family,sha256:c.sha256,getBytes:()=>bytes?.slice() ?? null};});
  const glyphResults=new Map();
  if(typeof glyphLookup==='function') for(const cp of new Set(Array.from((document?.blocks||[]).map(b=>b.text||'').join('')+edits.map(e=>e.after||'').join('')+' ', c=>c.codePointAt(0)))) {
    if(cp===9 || cp===10 || cp===13) continue;
    try {glyphResults.set(cp,Promise.resolve(glyphLookup.call(originalFonts,cp)));} catch(error) {glyphResults.set(cp,Promise.reject(error));}
  }
  fonts={...fonts,candidates:snapshots,selected:fonts.selected ? {...fonts.selected} : null,fallback:(fonts.fallback || []).map(x=>({...x})),hasGlyph:typeof glyphLookup==='function' ? cp=>glyphResults.get(cp) : undefined};
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
  const projectedSpaces=new Map(), projectedAmbiguous=[];
  if (flow?.fragments?.length) {
    const parents=new Map(document.blocks.map(b=>[b.id,b])), groups=new Map();
    for(const f of flow.fragments) {
      const parent=parents.get(f.parentBlockId), r=f.source?.range, pr=parent?.source?.range;
      if(!parent || !r || !pr || f.id===parent.id || ids.has(f.id) || f.source.pageIndex!==parent.source.pageIndex || r.start<pr.start || r.end>pr.end || r.start>=r.end || f.text!==parent.text.slice(r.start-pr.start,r.end-pr.start)) fail('Invalid flow fragment');
      ids.add(f.id); const group=groups.get(parent.id)||[]; group.push(f); groups.set(parent.id,group);
    }
    for(const [id,group] of groups) {
      const parent=parents.get(id), pr=parent.source.range; group.sort((a,b)=>a.source.range.start-b.source.range.start);
      let cursor=pr.start; for(const f of group) {if(f.source.range.start!==cursor) fail('Flow fragments do not cover parent exactly'); cursor=f.source.range.end;} if(cursor!==pr.end) fail('Flow fragments do not cover parent exactly');
      const parentChanges=changes.get(id)||[], parentSpaces=separators(parent);
      const ambiguous=new Set(ambiguousBoundaries(parent,parentChanges));
      for(const f of group) {
        const start=f.source.range.start-pr.start, end=f.source.range.end-pr.start;
        const spaces=new Set([...parentSpaces].filter(i=>i>=start && i<end && !parentChanges.some(e=>e.start<i && i<e.end)).map(i=>i-start));
        projectedSpaces.set(f.id,spaces);
        for(const i of ambiguous) if(i>=start && i<end) projectedAmbiguous.push({blockId:f.id,offset:pr.start+i});
      }
      for(const edit of parentChanges) {
        const a=pr.start+edit.start, b=pr.start+edit.end, overlap=group.filter(x=>a<x.source.range.end && b>x.source.range.start);
        for(const [i,f] of overlap.entries()) {const r=f.source.range, list=changes.get(f.id)||[]; list.push({start:Math.max(a,r.start)-r.start,end:Math.min(b,r.end)-r.start,after:i===0?edit.after:''}); changes.set(f.id,list);}
      }
      changes.delete(id);
    }
    document.blocks=document.blocks.flatMap(b=>groups.get(b.id)||[b]);
    for(const id of groups.keys()) ids.delete(id);
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
  // An inline joiner already ending in whitespace supplies a fragment's leading separator.
  for(const item of flow?.items || []) if(item.inline && Array.isArray(item.joiners)) for(let i=1;i<(item.blockIds||[]).length;i++) {
    if (/\s$/u.test(item.joiners[i-1] || '')) projectedSpaces.get(item.blockIds[i])?.delete(0);
  }
  const spacesFor=b=>projectedSpaces.get(b.id) || separators(b);
  const assetOwned = new Set((flow?.items || []).filter(item=>item.kind==='asset').flatMap(item=>item.blockIds || []));
  const orderedById=new Map(document.blocks.map(b=>[b.id,b]));
  const linked=new Set((flow?.items||[]).filter(i=>i.kind==='asset').flatMap(i=>i.captionIds||[]));
  const orderedBlocks=flow ? flow.items.flatMap(i=>i.kind==='asset' ? (i.captionIds||[]).map(id=>orderedById.get(id)) : (i.blockIds||[]).filter(id=>!linked.has(id)).map(id=>orderedById.get(id))) : document.blocks;
  const sourceGlyphResult=readSourceGlyphs({bytes:sourceBytes,document:{...document,blocks:document.blocks.filter(b=>!assetOwned.has(b.id))},changes});
  const glyphsByBlock=new Map();
  for(const glyph of sourceGlyphResult.glyphs) {const list=glyphsByBlock.get(glyph.blockId)||[]; list.push(glyph); glyphsByBlock.set(glyph.blockId,list);}
  const omittedFor=b=>new Set((glyphsByBlock.get(b.id)||[]).flatMap(g=>Array.from({length:g.end-g.start},(_,i)=>g.start-b.source.range.start+i)));
  let expectedBlocks=orderedBlocks.filter(b=>typeof b?.text==='string' && b.text.length).map(b=>({id:b.id,text:logicalText(b,changes.get(b.id)||[],omittedFor(b),spacesFor(b))}));
  if(flow) for(const item of flow.items.filter(i=>i.inline)) {
    if(!Array.isArray(item.joiners) || item.joiners.length!==(item.blockIds||[]).length-1 || item.joiners.some(j=>typeof j!=='string')) fail('Invalid inline joiners');
    const indexes=item.blockIds.map(id=>expectedBlocks.findIndex(b=>b.id===id));
    if(indexes.some((x,i)=>x<0 || (i && x!==indexes[0]+i))) fail('Inline blocks must be consecutive');
    const text=indexes.map((idx,i)=>expectedBlocks[idx].text+(item.joiners[i]||'')).join('');
    expectedBlocks.splice(indexes[0],indexes.length,{id:item.blockIds[0],text});
  }
  const artworkBlocks=document.blocks.filter(b=>assetOwned.has(b.id) && b.text).map(b=>({id:b.id,text:logicalText(b,[],new Set(),spacesFor(b))}));
  const texts=expectedBlocks.map(b=>b.text);
  const ambiguous=[...projectedAmbiguous,...document.blocks.filter(b=>!projectedSpaces.has(b.id) && typeof b.text==='string' && b.text.length).flatMap(b=>ambiguousBoundaries(b,changes.get(b.id)||[]).map(offset=>({blockId:b.id,offset:offset+b.source.range.start})))];
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
  const textById = new Map(document.blocks.filter(b=>typeof b.text==='string' && b.text.length && !assetOwned.has(b.id)).map(b=>[b.id,logicalText(b,changes.get(b.id)||[],new Set(),spacesFor(b))]));
  const placedAssets = new Set(), assetFindings=[];
  if(assets?.sourceSha256 && assets.sourceSha256!==document.sourceSha256) fail('Asset source hash mismatch');
  const suppliedIds=new Set(); for(const a of assetList) {if(!a?.id || suppliedIds.has(a.id)) fail('Unknown or duplicate asset occurrence ID'); suppliedIds.add(a.id);}
  const ownedIds=new Set(); for(const item of flow?.items || []) for(const id of item.assetIds || []) {if(ownedIds.has(id)) fail('Duplicate flow asset ownership'); ownedIds.add(id);}
  for(const a of document.assets || []) if(flow && !ownedIds.has(a.id)) assetFindings.push({code:'asset-unowned',assetId:a.id});
  function renderBlock(block) {
    const text=textById.get(block.id); if (!text) return '';
    const marker=`#context [#let p = here().position(); #metadata((id: ${typstString(block.id)}, page: p.page, x: p.x / 1pt, y: p.y / 1pt)) <paper-block>]`;

    const chars=block.source?.characters || [];
    if ((!chars.length || !styleById.size) && !fonts.fallback?.length && !(glyphsByBlock.get(block.id)||[]).length) return marker+`#text(${typstString(text)})`;
    // Build source-indexed styles, then apply the same line separators and edits.
    const raw=block.text, spaces=spacesFor(block);
    let logical='', styles=[], glyphMap=[], before=[], after=[];
    const sourceGlyphs=new Map((glyphsByBlock.get(block.id)||[]).map(g=>[g.start-block.source.range.start,g]));
    const styleAt=i=>chars.find(c=>c.start<=i+block.source.range.start && c.end>i+block.source.range.start)?.styleId || block.styleId;
    for(let i=0;i<=raw.length;i++) {
      before[i]=logical.length;
      if(spaces.has(i)) {logical+=' ';styles.push(styleAt(Math.max(0,i-1)));glyphMap.push(null);}
      after[i]=logical.length;
      if(i<raw.length) {logical+=raw[i];styles.push(styleAt(i));glyphMap.push(sourceGlyphs.get(i)||null);}
    }
    let result='', mapped=[], mappedGlyphs=[], cursor=0;
    for(const edit of [...(changes.get(block.id)||[])].sort((a,b)=>a.start-b.start)) {
      const a=after[edit.start], b=before[edit.end]; result+=logical.slice(cursor,a)+edit.after;
      for(let i=cursor;i<a;i++) {mapped.push(styles[i]);mappedGlyphs.push(glyphMap[i]);}
      const editStyle=styleAt(edit.start);
      for(let i=0;i<edit.after.length;i++) {mapped.push(editStyle);mappedGlyphs.push(null);}
      cursor=b;
    }
    result+=logical.slice(cursor); for(let i=cursor;i<styles.length;i++) {mapped.push(styles[i]);mappedGlyphs.push(glyphMap[i]);}
    const familyAt=i=>fonts.fallback?.find(entry=>entry.codepoint===result.codePointAt(i) && entry.kind==='glyph')?.family || null;
    const runs=[]; for(let i=0;i<result.length;) {if(mappedGlyphs[i]) {runs.push([null,null,null,mappedGlyphs[i]]);i++;continue;} let j=i+(result.codePointAt(i)>0xffff?2:1); const family=familyAt(i); while(j<result.length && !mappedGlyphs[j] && mapped[j]===mapped[i] && familyAt(j)===family) j+=result.codePointAt(j)>0xffff?2:1; runs.push([result.slice(i,j),styleById.get(mapped[i]),family]); i=j;}
    return marker+runs.map(([value,style,family,glyph])=>{if(glyph) {const path=`source-glyphs/${glyph.pageIndex}-${glyph.start}.svg`;files[path]=new Uint8Array(glyph.bytes);return `#box(width: ${glyph.advance}pt, height: ${glyph.height}pt, baseline: ${glyph.baselineShift}pt)[#move(dx: ${glyph.offsetX}pt)[#image(${typstString(path)}, width: ${glyph.width}pt)]]`;} const size=style?.size; let opts=Number.isFinite(size)&&size>0 ? `size: ${size}pt, ` : ''; if(family) opts+=`font: ${typstString(family)}, `; const name=style?.fontName || ''; if(/bold/i.test(name)) opts+='weight: "bold", '; if(/italic|oblique/i.test(name)) opts+='style: "italic", '; return `#text(${opts}${typstString(value)})`;}).join('');
  }
  function renderAsset(id, item) {
    const asset=assetList.find(a=>a.id===id); const original=(document.assets||[]).find(a=>a.id===id);
    if(original?.source && (!asset?.source || asset.source.pageIndex!==original.source.pageIndex || JSON.stringify(asset.source.bbox)!==JSON.stringify(original.source.bbox))) {assetFindings.push({code:'asset-source-mismatch',assetId:id}); return '';}
    const content=asset?.content; const bytes=content?.bytes;
    const rep=String(content?.representation || '').toLowerCase();
    const ext=rep.includes('svg')?'svg':rep.includes('png')?'png':null;
    const validPng=ext==='png' && bytes instanceof Uint8Array && bytes.length>=45 && [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82].every((b,i)=>bytes[i]===b) && [73,69,78,68,174,66,96,130].every((b,i)=>bytes[bytes.length-8+i]===b);
    const validSvg=ext==='svg' && bytes instanceof Uint8Array && /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(new TextDecoder().decode(bytes));
    if(!validPng && !validSvg) {assetFindings.push({code:asset?'asset-invalid-format':'asset-missing',assetId:id}); return '';}
    if(content?.mask || asset?.mask) {assetFindings.push({code:'asset-mask-unsupported',assetId:id}); return '';}
    const path=`assets/${placedAssets.size}.${ext}`; files[path]=new Uint8Array(bytes); placedAssets.add(id);
    const bbox=asset.source?.bbox || item?.source?.bbox;
    const sourceWidth=Array.isArray(bbox) ? bbox[2]-bbox[0] : null;
    const sourceHeight=Array.isArray(bbox) ? bbox[3]-bbox[1] : null;
    const available=(page.width-72)/(item?.span==='page' || item?.columns!==2 ? 1 : 2);
    // Reserve a line for the caption when a source region is nearly page-high.
    // Scaling the width from the source rectangle preserves the capture's ratio.
    const maxHeight=Math.max(1,page.height-72-((item?.captionIds || []).length ? 20 : 0));
    const heightLimited=Number.isFinite(sourceHeight) && sourceHeight>0 && Number.isFinite(sourceWidth) && sourceWidth>0 ? maxHeight*sourceWidth/sourceHeight : Infinity;
    const width=Number.isFinite(sourceWidth) && sourceWidth>0 ? `${Math.min(sourceWidth,available,heightLimited)}pt` : '100%';
    return `#image(${typstString(path)}, width: ${width})`;
  }
  if (flow) {
    if(flow.schema!=='falsify.paper-flow.v1' || flow.sourceSha256!==document.sourceSha256 || !Array.isArray(flow.items)) fail('Invalid paper flow');
    let group=[], columns=0;
    const flush=()=>{if(!group.length)return; source+=columns===2 ? `#columns(2)[\n${group.join('\n\n')}\n]\n` : group.join('\n\n')+'\n';group=[];};
    const captionById=new Map(flow.items.filter(i=>i.kind==='caption').flatMap(i=>(i.blockIds||[]).map(id=>[id,i]))), linkedCaptions=new Set();
    for(const item of flow.items) if(item.kind==='asset') for(const id of item.captionIds||[]) {if(!captionById.has(id) || linkedCaptions.has(id)) fail('Unknown or duplicate caption link'); linkedCaptions.add(id);}
    for(const item of flow.items) {
      const count=item.span==='page'?1:(item.columns===2?2:1); if(count!==columns){flush();columns=count;}
      let parts=[];
      if(item.kind==='asset') {
        if(item.renderAssetId) {
          const capture=assetList.find(a=>a.id===item.renderAssetId), owned=capture?.source?.assetIds || [], blocks=capture?.source?.blockIds || [];
          const same=(a,b)=>a.length===b.length && a.every(x=>b.includes(x));
          if(!capture || !same(owned,item.assetIds||[]) || !same(blocks,item.blockIds||[]) || capture.source.pageIndex!==item.source?.pageIndex || JSON.stringify(capture.source.bbox)!==JSON.stringify(item.source?.bbox)) assetFindings.push({code:'asset-capture-mismatch',assetId:item.renderAssetId});
          else {parts=[renderAsset(item.renderAssetId,item)].filter(Boolean); if(parts.length) for(const id of item.assetIds||[]) placedAssets.add(id);}
        } else if((item.assetIds||[]).length>1) assetFindings.push({code:'asset-union-required',assetIds:[...item.assetIds]});
        else parts=(item.assetIds||[]).map(id=>renderAsset(id,item)).filter(Boolean);
        const captions=(item.captionIds||[]).map(id=>renderBlock(blockById.get(id))).filter(Boolean);
        if(parts.length && captions.length) parts=[`#block(sticky: true)[${parts.join('\n')}]`,...captions]; else parts.push(...captions);
      } else {
        parts=(item.blockIds||[]).filter(id=>!linkedCaptions.has(id)).map(id=>blockById.get(id)).filter(Boolean).map(renderBlock);
        if(!item.inline) parts=parts.filter(Boolean);
      }
      if(parts.length) group.push(item.inline ? parts.map((p,i)=>p+(i<parts.length-1 ? `#text(${typstString(item.joiners[i])})` : '')).join('') : parts.join('\n'));
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
  const warnings=['Content, layout and asset preservation have not been independently verified.'];
  if(sourceGlyphResult.glyphs.length) warnings.push('Source glyph artwork has unknown Unicode and is excluded from searchable-text expectations.');
  if(sourceGlyphResult.unavailable.length) warnings.push('Source glyph artwork unavailable for '+sourceGlyphResult.unavailable.length+' character(s).');
  if(compiled?.queryError) warnings.push(`Output location query failed: ${compiled.queryError}`);
  if(document.assets?.some(a=>!placedAssets.has(a.id)) || document.blocks.some(b=>(b.assetIds?.length || b.kind==='figure' || b.kind==='table' || b.kind==='formula') && !(b.assetIds?.length && b.assetIds.every(id=>placedAssets.has(id))))) warnings.push('Source assets and non-text figure, table or formula content are not placed by this candidate, including image blocks without source ranges.');
  if(assetFindings.length) warnings.push('Source asset findings: '+assetFindings.map(f=>`${f.code} (${f.assetId || f.assetIds.join(', ')})`).join('; '));
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
  const verification={status:outputTextCheck==='finding' || assetFindings.length?'finding':'warning', sourceSha256:document.sourceSha256, contentVerified:outputTextCheck==='pass' && !ambiguous.length && !assetOwned.size && !assetFindings.length && !sourceGlyphResult.glyphs.length && !sourceGlyphResult.unavailable.length, sourceGlyphs:sourceGlyphResult, layoutVerified:false, coverage, outputTextCheck, checkReport, artworkBlocks, assetFindings, ambiguousBoundaries:ambiguous, edits:edits.map(e=>({blockId:e.blockId,start:e.start,end:e.end,status:'bound'}))};
  return {file:new File([bytes],'recomposed.pdf',{type:'application/pdf'}),sha256,verification,pageMap:null,blockMap:compiled?.blockMap ?? null,warnings};
}
