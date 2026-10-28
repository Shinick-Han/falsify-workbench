import {readGlyphs} from './paragraph-vendor/quality.mjs';

const text = gs => gs.map(g => String.fromCodePoint(g.u)).join('');
const key = gs => text(gs).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const originY = g => g.origin?.[1];
const size = g => g.style.size * Math.hypot(g.style.mat?.[2] ?? 0, g.style.mat?.[3] ?? 1);
const styleKey = g => JSON.stringify(g.style);
const near = (a,b,t=.15) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=t;

// Build horizontal body lines geometrically, never using PDF text order.
function lines(glyphs) {
  const out=[];
  for(const g of glyphs.filter(g => g.obj && g.style && Number.isFinite(originY(g))).sort((a,b)=>originY(b)-originY(a)||a.l-b.l)) {
    let line=out.find(l=>near(l.y,originY(g),.5) && near(l.size,size(g),.2));
    if(!line) out.push(line={y:originY(g),size:size(g),glyphs:[]});
    line.glyphs.push(g);
  }
  for(const line of out) line.glyphs.sort((a,b)=>a.l-b.l);
  return out;
}
function objects(glyphs) {
  const groups=new Map();
  for(const g of glyphs) if(g.obj) {if(!groups.has(g.obj)) groups.set(g.obj,[]); groups.get(g.obj).push(g);}
  return [...groups.values()].map(gs=>gs.sort((a,b)=>a.i-b.i));
}
function matches(line,needle) {
  const gs=line.glyphs, chars=[];
  for(const g of gs) for(const c of key([g])) chars.push({c,g});
  const hay=chars.map(x=>x.c).join(''), found=[];
  for(let i=hay.indexOf(needle);i>=0;i=hay.indexOf(needle,i+1)) found.push(chars[i+needle.length-1].g);
  return found;
}

// Exposed for focused geometry regression; actual mutation is performed only
// after all source and target identities have been proven.
export function planInlineMarkers(source, output, pageIndex=0) {
  const warnings=[], repairs=[], sl=lines(source.glyphs), ol=lines(output.glyphs);
  const sourceObjects=objects(source.glyphs), outputObjects=objects(output.glyphs);
  for(const marker of sourceObjects) {
    if(!marker.length || marker.length>12 || marker.some(g=>!g.style || !g.origin || !near(originY(g),originY(marker[0]),.5))) continue;
    const m=marker[0], left=Math.min(...marker.map(g=>g.l));
    const candidates=[];
    for(const line of sl) {
      if(line.size < size(m)*1.2 || line.size > size(m)*3 || line.y >= originY(m) || originY(m)-line.y > line.size*.8) continue;
      const preceding=line.glyphs.filter(g=>g.r<=left+1 && left-g.r<=line.size*1.3);
      if(!preceding.length) continue;
      const parent=preceding.at(-1), gap=left-parent.r;
      if(gap < -1 || gap > line.size*1.3) continue;
      const before=line.glyphs.filter(g=>g.r<=parent.r+.01);
      // Stop at column-sized gaps and require a real multiword context.
      const words=[];
      for(const g of before) {
        const previous=words.at(-1)?.at(-1), gap=previous ? g.l-previous.r : 0;
        if(previous && gap>line.size*2.5) words.length=0;
        if(!words.length || gap>line.size*.14) words.push([]);
        words.at(-1).push(g);
      }
      if(words.length<3) continue;
      const anchor=key(words.slice(-5).flat());
      if(anchor.length<12) continue;
      candidates.push({line,parent,anchor});
    }
    if(candidates.length!==1) continue;
    const {line,parent,anchor}=candidates[0];
    const sourceHits=sl.filter(l=>near(l.size,line.size,.2)).flatMap(l=>matches(l,anchor));
    const targetHits=ol.filter(l=>near(l.size,line.size,.2)).flatMap(l=>matches(l,anchor));
    const sourceMarkers=sourceObjects.filter(gs=>text(gs)===text(marker) && gs.length===marker.length && gs.every((g,i)=>styleKey(g)===styleKey(marker[i])));
    const targetMarkers=outputObjects.filter(gs=>text(gs)===text(marker) && gs.length===marker.length && gs.every((g,i)=>styleKey(g)===styleKey(marker[i])));
    if(sourceHits.length!==1 || targetHits.length!==1 || sourceMarkers.length!==1 || targetMarkers.length!==1) {
      warnings.push({pageIndex,code:'inline_marker_ambiguous',sourceIndex:m.i}); continue;
    }
    const target=targetHits[0], outMarker=targetMarkers[0];
    if((parent.l < source.W/2)!==(target.l < output.W/2)) {warnings.push({pageIndex,code:'inline_marker_column_unproven',sourceIndex:m.i});continue;}
    const dx=(target.r+(left-parent.r))-Math.min(...outMarker.map(g=>g.l));
    const dy=(originY(target)+(originY(m)-line.y))-originY(outMarker[0]);
    if(Math.abs(dx)>.1 || Math.abs(dy)>.1) repairs.push({pageIndex,sourceIndex:m.i,object:outMarker[0].obj,dx,dy});
  }
  return {repairs,warnings};
}

export async function repairInlineMarkers({engineFactory,sourceBytes,outputBytes,pageIndices}) {
  let src,out; const repairs=[],warnings=[];
  try {
    src=await engineFactory(sourceBytes); out=await engineFactory(outputBytes);
    for(const pageIndex of pageIndices) {
      const s=readGlyphs(src,pageIndex), o=readGlyphs(out,pageIndex);
      if(!s.styled || !o.styled) {warnings.push({pageIndex,code:'inline_marker_style_unavailable'});continue;}
      const plan=planInlineMarkers(s,o,pageIndex); warnings.push(...plan.warnings);
      const seen=new Set(), counts=new Map();
      for(const move of plan.repairs) counts.set(move.object,(counts.get(move.object)||0)+1);
      for(const move of plan.repairs) {
        if(counts.get(move.object)!==1) {warnings.push({pageIndex,code:'inline_marker_object_ambiguous',sourceIndex:move.sourceIndex});continue;}
        seen.add(move.object);
        out.M._FPDFPageObj_Transform(move.object,1,0,0,1,move.dx,move.dy);
        repairs.push({pageIndex,sourceIndex:move.sourceIndex,dx:move.dx,dy:move.dy});
      }
      if(seen.size) {
        if(!out.M._FPDFPage_GenerateContent(out.page)) throw new Error('inline_marker_generate_failed');
        if(out.M._FPDFPage_GetAnnotCount?.(out.page)>0) warnings.push({pageIndex,code:'inline_marker_annotations_unverified'});
      }
    }
    return {pdf:repairs.length?new Uint8Array(out.save()):new Uint8Array(outputBytes),repairs,warnings};
  } finally {try{src?.close();}finally{out?.close();}}
}
