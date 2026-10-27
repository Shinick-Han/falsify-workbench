import {hex} from './paragraph-pdf-crypto.mjs';
const boxOK = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
const overlap = (a,b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const union = boxes => [Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
const contains = (a,b) => b[0]>=a[0]-1 && b[1]>=a[1]-1 && b[2]<=a[2]+1 && b[3]<=a[3]+1;
const median = xs => { const a=[...xs].sort((x,y)=>x-y); return a.length ? a[Math.floor(a.length/2)] : 0; };
const reading = (a,b) => (a.pos ?? Infinity)-(b.pos ?? Infinity) || a.index-b.index;
const geom = (a,b) => a.box[1]-b.box[1] || a.box[0]-b.box[0] || reading(a,b);

// Split only on complete, contiguous observed line ranges. Each fragment is a
// view of the original page text and retains the corresponding character data.
function splitBlock(b, hash, styles) {
  const {lines,characters,range}=b.source || {};
  if (!b.text || !Array.isArray(lines) || lines.length<2 || !Array.isArray(characters) || !range || lines.some(l=>!boxOK(l.bbox) || !l.range)) return [b];
  if (lines[0].range.start!==range.start || lines.at(-1).range.end!==range.end || lines.some((l,i)=>l.range.start>=l.range.end || (i && lines[i-1].range.end!==l.range.start))) return [b];
  const groups=[];
  for(const line of lines) {
    const group=groups.at(-1), prev=group?.at(-1), h=line.bbox[3]-line.bbox[1];
    const gap=prev ? line.bbox[1]-prev.bbox[3] : 0;
    const sameColumn=prev && Math.min(line.bbox[2],prev.bbox[2])-Math.max(line.bbox[0],prev.bbox[0]) > Math.min(line.bbox[2]-line.bbox[0],prev.bbox[2]-prev.bbox[0])*.3;
    const indent=prev && line.bbox[0]-prev.bbox[0]>h;
    const lineSize=l=>median(characters.filter(c=>c.start>=l.range.start && c.end<=l.range.end).map(c=>styles.get(c.styleId)?.size).filter(Number.isFinite));
    const a=prev && lineSize(prev), z=lineSize(line);
    const sizeChange=a && z && Math.max(a,z)>Math.min(a,z)*1.2;
    if (!prev || !sameColumn || gap < -h*.5 || gap > h*.8 || indent || sizeChange) groups.push([line]); else group.push(line);
  }
  if(groups.length===1) return [b];
  return groups.map(group=>{
    const start=group[0].range.start,end=group.at(-1).range.end;
    const chars=characters.filter(c=>c.start>=start && c.end<=end);
    const id=`fragment-${hex(new TextEncoder().encode(JSON.stringify([hash,b.source.pageIndex,start,end]))).slice(0,24)}`;
    return {...b,id,parentBlockId:b.id,text:b.text.slice(start-range.start,end-range.start),source:{...b.source,bbox:union(group.map(l=>l.bbox)),range:{start,end},characters:chars,lines:group}};
  });
}

// Split a parent only at observed character boundaries when another source run
// lies inside one of its lines. All fragments remain exact views of source text.
function inlineFragments(blocks, hash) {
  const replacements=new Map(), groups=[];
  for (const host of blocks) {
    const lines=host.source?.lines, chars=host.source?.characters, range=host.source?.range;
    if (replacements.has(host.id) || !host.text || !Array.isArray(lines) || !Array.isArray(chars) || !range || lines.length<1 || !boxOK(host.source?.bbox)) continue;
    const inserts=[];
    for (const guest of blocks) {
      if (guest===host || replacements.has(guest.id) || !guest.text || guest.text.length>80 || !boxOK(guest.source?.bbox) || guest.source.pageIndex!==host.source.pageIndex) continue;
      const gb=guest.source.bbox;
      if (!contains(host.source.bbox,gb) || gb[2]-gb[0] > (host.source.bbox[2]-host.source.bbox[0])*.45) continue;
      const line=lines.filter(l=>boxOK(l.bbox) && l.range && gb[1]<l.bbox[3] && gb[3]>l.bbox[1] && gb[2]>=l.bbox[0]-20 && gb[0]<=l.bbox[2]+3).sort((a,b)=>Math.min(gb[3],b.bbox[3])-Math.max(gb[1],b.bbox[1])-(Math.min(gb[3],a.bbox[3])-Math.max(gb[1],a.bbox[1])))[0];
      if (!line) continue;
      const lc=chars.filter(c=>c.start>=line.range.start && c.end<=line.range.end && boxOK(c.bbox));
      const next=lc.find(c=>(c.bbox[0]+c.bbox[2])/2 >= (gb[0]+gb[2])/2);
      const at=next?.start ?? line.range.end;
      if (at<range.start || at>=range.end) continue;
      inserts.push({guest,at});
    }
    if (!inserts.length) continue;
    inserts.sort((a,b)=>a.at-b.at || a.guest.source.bbox[0]-b.guest.source.bbox[0]);
    const cuts=[range.start,...new Set(inserts.map(x=>x.at).filter(at=>at>range.start)),range.end], parts=[];
    for(let i=0;i<cuts.length-1;i++) {
      const start=cuts[i],end=cuts[i+1], partChars=chars.filter(c=>c.start>=start && c.end<=end);
      const partLines=lines.filter(l=>l.range && l.range.start<end && l.range.end>start).map(l=>({...l,range:{start:Math.max(start,l.range.start),end:Math.min(end,l.range.end)},bbox:union(partChars.filter(c=>c.start<l.range.end && c.end>l.range.start && boxOK(c.bbox)).map(c=>c.bbox))})).filter(l=>boxOK(l.bbox));
      if (!partLines.length) {parts.length=0;break;}
      const id=`fragment-${hex(new TextEncoder().encode(JSON.stringify([hash,host.source.pageIndex,start,end]))).slice(0,24)}`;
      parts.push({...host,id,parentBlockId:host.parentBlockId || host.id,text:host.text.slice(start-range.start,end-range.start),source:{...host.source,bbox:union(partLines.map(l=>l.bbox)),range:{start,end},characters:partChars,lines:partLines}});
    }
    if (!parts.length) continue;
    const order=inserts.filter(x=>x.at===range.start).map(x=>x.guest); for(let i=0;i<parts.length;i++){order.push(parts[i]);order.push(...inserts.filter(x=>x.at===cuts[i+1]).map(x=>x.guest));}
    replacements.set(host.id,parts); for(const x of inserts) replacements.set(x.guest.id,null);
    groups.push(order);
  }
  return {replacements,groups};
}

// Preserve original IDs and text in the model; flow fragments are exact views.
function occlusionFragments(block, evidence, hash) {
  const range=block.source?.range, chars=block.source?.characters, lines=block.source?.lines;
  if(!range || !chars?.length || !lines?.length) return [block];
  const cuts=new Set([range.start,range.end]);
  for(const e of evidence) for(const r of e.ranges) if(r.start>=range.start && r.end<=range.end) {cuts.add(r.start);cuts.add(r.end);}
  const sorted=[...cuts].sort((a,b)=>a-b); if(sorted.length===2) return [block];
  const parts=[];
  for(let i=0;i<sorted.length-1;i++) {
    const start=sorted[i],end=sorted[i+1], cs=chars.filter(c=>c.start>=start && c.end<=end);
    if(!cs.length || cs.some(c=>!boxOK(c.bbox))) return [block];
    const ls=lines.filter(l=>l.range.start<end && l.range.end>start).map(l=>({...l,range:{start:Math.max(start,l.range.start),end:Math.min(end,l.range.end)},bbox:union(cs.filter(c=>c.start<l.range.end && c.end>l.range.start).map(c=>c.bbox))}));
    parts.push({...block,id:`fragment-${hex(new TextEncoder().encode(JSON.stringify([hash,block.source.pageIndex,start,end]))).slice(0,24)}`,parentBlockId:block.id,text:block.text.slice(start-range.start,end-range.start),source:{...block.source,range:{start,end},characters:cs,lines:ls,bbox:union(cs.map(c=>c.bbox))}});
  }
  return parts;
}

/** Produce a deterministic, source-bound reading order and ownership proposal. */
export function buildPaperFlow(document, {drawings=document?.drawings || []} = {}) {
  if (document?.schema !== 'falsify.paper-document.v1' || !Array.isArray(document.pages) || !Array.isArray(document.blocks) || !Array.isArray(document.assets)) throw new TypeError('Expected falsify.paper-document.v1');
  const items=[],relations=[],diagnostics=[],fragments=[],regions=[];
  const styles=new Map((document.styles || []).map(s=>[s.id,s]));
  const evidence=(document.occlusions || []).filter(e=>e.sourceSha256===document.sourceSha256 && Array.isArray(e.ranges) && e.proof?.changedChannels===0 && e.proof?.removedCharacters>0);
  let flowBlocks=document.blocks.flatMap(b=>occlusionFragments(b,evidence.filter(e=>e.pageIndex===b.source?.pageIndex),document.sourceSha256)).flatMap(b=>splitBlock(b,document.sourceSha256,styles));
  const inline=inlineFragments(flowBlocks,document.sourceSha256);
  flowBlocks=flowBlocks.flatMap(b=>inline.replacements.has(b.id) ? (inline.replacements.get(b.id) || [b]) : [b]);
  fragments.push(...flowBlocks.filter(b=>b.parentBlockId));
  const textBlocks=flowBlocks.filter(b=>b.text);
  const sizeOf=b=>median((b.source?.characters || []).map(c=>styles.get(c.styleId)?.size).filter(Number.isFinite)) || styles.get(b.styleId)?.size || 0;
  const bodySize=median(textBlocks.flatMap(b=>(b.source?.characters || []).map(c=>styles.get(c.styleId)?.size).filter(Number.isFinite))) || median(textBlocks.map(sizeOf).filter(Boolean));
  const repeats=new Map();
  for(const b of textBlocks) {const page=document.pages.find(p=>p.sourcePageIndex===b.source?.pageIndex),box=b.source?.bbox;if(!page || !boxOK(box) || !(box[1]<page.height*.12 || box[3]>page.height*.88)) continue;const key=b.text.trim().replace(/\s+/g,' ');if(key) {if(!repeats.has(key)) repeats.set(key,new Set()); repeats.get(key).add(b.source.pageIndex);}}
  for (const page of document.pages) {
    const pi=page.sourcePageIndex;
    const blocks=flowBlocks.map((b,index)=>({b,index,box:b.source?.bbox,pos:b.source?.readerPosition})).filter(x=>x.b.source?.pageIndex===pi);
    const assets=document.assets.map((a,index)=>({a,index,box:a.source?.bbox,pos:a.source?.readerPosition})).filter(x=>x.a.source?.pageIndex===pi);
    const owned=new Set(), represented=new Set(); let serial=0;
    const make=(kind,bs,as,box,pos,index)=>({id:`flow-${pi}-${serial++}`,kind,blockIds:bs.map(x=>x.b.id),assetIds:as.map(x=>x.a.id),source:{pageIndex:pi,bbox:boxOK(box)?[...box]:null},columns:1,span:'page',captionIds:[],box,pos,index});
    const entries=[];
    // Connected line grids are evidence of a vector table. Keep captions and
    // notes outside the measured grid and capture the grid with its cell text.
    const paths=drawings.filter(d=>d.pageIndex===pi && boxOK(d.bbox)).map(d=>d.bbox);
    // Outline-heavy forms may have no extractable labels at all. Restrict this
    // classification to pages without ordinary central body text, and include
    // every observed occurrence in the measured crop.
    const centralText=blocks.filter(x=>x.b.text?.trim() && (!boxOK(x.box) || (x.box[1]<page.height*.9 && x.box[3]>page.height*.1)));
    let form=false;
    if(paths.length>=2000 && centralText.length===0 && blocks.every(x=>boxOK(x.box)) && assets.every(x=>boxOK(x.box))) {
      const raw=union([...paths,...blocks.map(x=>x.box),...assets.map(x=>x.box)]);
      const box=[Math.max(0,raw[0]-1),Math.max(0,raw[1]-1),Math.min(page.width,raw[2]+1),Math.min(page.height,raw[3]+1)];
      if(boxOK(box) && box[2]-box[0]>page.width*.5 && box[3]-box[1]>page.height*.5 && [...paths,...blocks.map(x=>x.box),...assets.map(x=>x.box)].every(b=>contains(box,b))) {
        const id=`region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256,pi,box]))).slice(0,24)}`;
        const entry=make('asset',blocks,assets,box,Math.min(...blocks.map(x=>x.pos ?? Infinity)),0);
        entry.renderAssetId=id; entries.push(entry);
        regions.push({id,pageIndex:pi,bbox:[...box],blockIds:blocks.map(x=>x.b.id),assetIds:assets.map(x=>x.a.id),classification:'outline-artwork'});
        blocks.forEach(x=>owned.add(x.b.id)); assets.forEach(x=>represented.add(x.a.id)); form=true;
      }
    }
    const captions=blocks.filter(x=>boxOK(x.box) && /^\s*(?:extended\s+data\s+)?(?:fig(?:ure)?\.?|table)\s*\d/i.test(x.b.text || ''));
    const plotBottom=Math.min(page.height*.9,...captions.map(x=>x.box[1]));
    const plotBlocks=blocks.filter(x=>x.b.text && boxOK(x.box) && x.box[1]>=page.height*.05 && x.box[3]<=plotBottom);
    const plotPaths=paths.filter(b=>b[0]>=0 && b[1]>=page.height*.05 && b[2]<=page.width && b[3]<=plotBottom);
    let plot=false;
    // Multiple separated image occurrences can be panels of one figure. Use
    // narrative and caption geometry as hard vertical boundaries; a crop is
    // accepted only when no excluded text or image intersects it.
    if(!form) {
      const central=blocks.filter(x=>x.b.text && boxOK(x.box) && x.box[1]>=page.height*.05 && x.box[3]<=page.height*.9);
      const narrative=x=>{
        const lines=x.b.source?.lines || [];
        return captions.includes(x) || (bodySize && sizeOf(x.b)>=bodySize*.88 && x.box[2]-x.box[0]>=page.width*.3 && (lines.length>=2 || x.b.text.trim().length>=55));
      };
      const barriers=central.filter(narrative).sort(geom);
      const limits=[page.height*.05,...barriers.flatMap(x=>[x.box[1],x.box[3]]),page.height*.9].sort((a,b)=>a-b);
      for(let i=0;i<limits.length-1;i++) {
        const top=limits[i],bottom=limits[i+1];
        if(bottom<=top || barriers.some(x=>x.box[1]<bottom && x.box[3]>top)) continue;
        const as=assets.filter(x=>!represented.has(x.a.id) && boxOK(x.box) && x.box[1]>=top && x.box[3]<=bottom);
        if(as.length<2) continue;
        const labels=central.filter(x=>!owned.has(x.b.id) && !narrative(x) && x.box[1]>=top && x.box[3]<=bottom);
        if(labels.length<3) continue;
        const ps=paths.filter(b=>b[1]>=top && b[3]<=bottom);
        const raw=union([...as.map(x=>x.box),...labels.map(x=>x.box),...ps]);
        // Painted strokes and glyph ink can extend beyond their geometric
        // bounds. Include a small margin, subject to the same exclusion check.
        const box=[Math.max(0,raw[0]-2),Math.max(0,raw[1]-2),Math.min(page.width,raw[2]+2),Math.min(page.height,raw[3]+2)];
        if(box[2]-box[0]<page.width*.4 || box[3]-box[1]<page.height*.2) continue;
        if(blocks.some(x=>x.b.text && boxOK(x.box) && overlap(box,x.box) && !labels.includes(x)) || assets.some(x=>boxOK(x.box) && overlap(box,x.box) && !as.includes(x))) continue;
        const bs=[...labels,...blocks.filter(x=>!owned.has(x.b.id) && (x.b.assetIds || []).some(id=>as.some(a=>a.a.id===id)))];
        bs.forEach(x=>owned.add(x.b.id)); as.forEach(x=>represented.add(x.a.id));
        const id=`region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256,pi,box]))).slice(0,24)}`;
        const entry=make('asset',bs,as,box,Math.min(...bs.map(x=>x.pos ?? Infinity)),Math.min(...bs.map(x=>x.index)));
        entry.renderAssetId=id; entries.push(entry);
        regions.push({id,pageIndex:pi,bbox:[...box],blockIds:bs.map(x=>x.b.id),assetIds:as.map(x=>x.a.id),classification:'compound-figure'});
        plot=true;
      }
    }
    if(!form && !plot && plotPaths.length>=1000 && plotBlocks.length>=20 && plotBlocks.every(x=>x.b.text.length<=200 && !/^\s*(?:fig(?:ure)?\.?|table)\s*\d/i.test(x.b.text)) && plotBlocks.filter(x=>x.b.text.length<=100).length/plotBlocks.length>=.95) {
      let box=union([...plotPaths,...plotBlocks.map(x=>x.box)]);
      const touching=assets.filter(x=>boxOK(x.box) && overlap(box,x.box));
      if(touching.every(x=>x.box[0]>=0 && x.box[1]>=page.height*.05 && x.box[2]<=page.width && x.box[3]<=plotBottom)) box=union([box,...touching.map(x=>x.box)]);
      if(touching.every(x=>contains(box,x.box)) && box[2]-box[0]>page.width*.4 && box[3]-box[1]>page.height*.2) {
        const as=assets.filter(x=>boxOK(x.box) && contains(box,x.box));
        const figureBlocks=blocks.filter(x=>(x.b.assetIds || []).some(id=>as.some(a=>a.a.id===id)));
        plotBlocks.push(...figureBlocks.filter(x=>!plotBlocks.includes(x)));
        plotBlocks.forEach(x=>owned.add(x.b.id)); as.forEach(x=>represented.add(x.a.id));
        const id=`region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256,pi,box]))).slice(0,24)}`;
        const entry=make('asset',plotBlocks,as,box,Math.min(...plotBlocks.map(x=>x.pos ?? Infinity)),plotBlocks[0].index);
        entry.renderAssetId=id;entries.push(entry);
        regions.push({id,pageIndex:pi,bbox:[...box],blockIds:plotBlocks.map(x=>x.b.id),assetIds:as.map(x=>x.a.id)});
        plot=true;
      }
    }
    if(!form && !plot && paths.length>2000) diagnostics.push({code:'dense-vector-region-unresolved',pageIndex:pi});
    const seen=new Set();
    for(let n=0;n<(form || plot || paths.length>2000?0:paths.length);n++) {
      if(seen.has(n)) continue;
      const cluster=[n];seen.add(n);
      for(let k=0;k<cluster.length;k++) for(let j=0;j<paths.length;j++) {
        if(seen.has(j)) continue;
        const a=paths[cluster[k]],b=paths[j];
        if(a[0]<=b[2]+1 && b[0]<=a[2]+1 && a[1]<=b[3]+1 && b[1]<=a[3]+1) {seen.add(j);cluster.push(j);}
      }
      if(cluster.length<10) continue;
      const boxes=cluster.map(i=>paths[i]), box=union(boxes);
      const horizontal=boxes.filter(b=>b[2]-b[0]>10 && b[3]-b[1]<3).length;
      const vertical=boxes.filter(b=>b[3]-b[1]>10 && b[2]-b[0]<3).length;
      if(horizontal<3 || vertical<3 || box[2]-box[0]<40 || box[3]-box[1]<20) continue;
      const bs=blocks.filter(x=>x.b.text && !owned.has(x.b.id) && boxOK(x.box) && contains(box,x.box));
      if(bs.length<4 || blocks.some(x=>x.b.text && boxOK(x.box) && overlap(box,x.box) && !bs.includes(x)) || assets.some(x=>boxOK(x.box) && overlap(box,x.box) && !contains(box,x.box))) continue;
      const as=assets.filter(x=>!represented.has(x.a.id) && boxOK(x.box) && contains(box,x.box));
      bs.push(...blocks.filter(x=>!owned.has(x.b.id) && !bs.includes(x) && (x.b.assetIds || []).some(id=>as.some(a=>a.a.id===id))));
      bs.forEach(x=>owned.add(x.b.id)); as.forEach(x=>represented.add(x.a.id));
      const id=`region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256,pi,box]))).slice(0,24)}`;
      const entry=make('asset',bs,as,box,Math.min(...bs.map(x=>x.pos ?? Infinity)),bs[0].index);
      entry.renderAssetId=id; entries.push(entry);
      regions.push({id,pageIndex:pi,bbox:[...box],blockIds:bs.map(x=>x.b.id),assetIds:as.map(x=>x.a.id)});
    }
    // Group overlapping image occurrences. Only fully contained text is owned as artwork.
    for(const a of assets) {
      if(represented.has(a.a.id)) continue;
      const group=[a];represented.add(a.a.id);
      if(boxOK(a.box)) for(let i=0;i<group.length;i++) for(const other of assets) if(!represented.has(other.a.id) && boxOK(other.box) && overlap(group[i].box,other.box)) {group.push(other);represented.add(other.a.id);}
      const box=group.every(x=>boxOK(x.box))?union(group.map(x=>x.box)):null;
      const proofs=evidence.filter(e=>e.pageIndex===pi && group.some(y=>y.a.id===e.assetId));
      const confirmed=x=>x.b.text && x.b.source?.range && proofs.some(e=>{const r=x.b.source.range;return e.ranges.some(z=>z.start<=r.start && z.end>=r.end);});
      const bs=blocks.filter(x=>!owned.has(x.b.id) && ((x.b.assetIds || []).some(id=>group.some(y=>y.a.id===id)) || confirmed(x)));
      bs.forEach(x=>owned.add(x.b.id));
      const entry=make('asset',bs,group,box,a.pos,a.index);
      if(proofs.length && bs.some(confirmed) && boxOK(box)) {
        const id=`region-${hex(new TextEncoder().encode(JSON.stringify([document.sourceSha256,pi,box]))).slice(0,24)}`;
        entry.renderAssetId=id;regions.push({id,pageIndex:pi,bbox:[...box],blockIds:bs.map(x=>x.b.id),assetIds:group.map(x=>x.a.id),classification:'verified-occlusion'});
      }
      entries.push(entry);
    }
    for(const x of blocks) {
      if(owned.has(x.b.id)) continue;
      owned.add(x.b.id); const b=x.b, box=x.box;
      let kind='paragraph';
      if(b.kind==='figure' || b.kind==='table') kind='asset';
      else if(b.kind==='caption' || /^\s*(?:extended\s+data\s+)?(?:fig(?:ure)?\.?|table)\s*\d+[\w.:-]*/i.test(b.text || '')) kind='caption';
      else if(boxOK(box) && repeats.get((b.text || '').trim().replace(/\s+/g,' '))?.size>=2 && box[1]<page.height*.12) kind='header';
      else if(boxOK(box) && repeats.get((b.text || '').trim().replace(/\s+/g,' '))?.size>=2 && box[3]>page.height*.88) kind='footer';
      else if(b.kind==='heading' || (bodySize>0 && sizeOf(b)>bodySize*1.3 && (b.text || '').trim().length>=12 && (b.text || '').length<150)) kind='heading';
      entries.push(make(kind,[x],[],box,x.pos,x.index));
    }
    // Short adjacent fragments from one parent often describe styled runs of
    // a single line cluster (for example, an author list and superscripts).
    const parentGroups=new Map();
    for(const b of flowBlocks.filter(b=>b.parentBlockId && b.source.pageIndex===pi)) {
      if(!parentGroups.has(b.parentBlockId)) parentGroups.set(b.parentBlockId,[]);
      parentGroups.get(b.parentBlockId).push(b);
    }
    for(const group of parentGroups.values()) {
      if(group.length<3 || group.some(b=>inline.groups.some(g=>g.includes(b)))) continue;
      group.sort((a,b)=>a.source.range.start-b.source.range.start);
      const box=union(group.map(b=>b.source.bbox));
      if(!boxOK(box) || box[3]-box[1]>60 || group.some((b,i)=>i && group[i-1].source.range.end!==b.source.range.start)) continue;
      const members=group.map(b=>entries.find(e=>e.blockIds.length===1 && e.blockIds[0]===b.id));
      if(members.some(x=>!x || x.kind!=='paragraph')) continue;
      const first=members[0]; first.blockIds=group.map(b=>b.id); first.inline=true; first.joiners=Array(group.length-1).fill('');
      first.box=box; first.source.bbox=[...box];
      for(const member of members.slice(1)) entries.splice(entries.indexOf(member),1);
    }
    for(const group of inline.groups) {
      const members=group.map(b=>entries.find(e=>e.blockIds.length===1 && e.blockIds[0]===b.id));
      if(members.some(x=>!x || x.kind!=='paragraph')) continue;
      const first=members[0]; first.blockIds=group.map(b=>b.id); first.inline=true; first.joiners=Array(group.length-1).fill('');
      first.box=union(members.map(x=>x.box)); first.source.bbox=[...first.box];
      for(const member of members.slice(1)) entries.splice(entries.indexOf(member),1);
    }
    // Link only an unambiguous nearby caption, never absorb it into the image.
    for(const caption of entries.filter(x=>x.kind==='caption' && boxOK(x.box))) {
      const near=entries.filter(x=>x.kind==='asset' && boxOK(x.box) && x.box[0]<caption.box[2] && caption.box[0]<x.box[2] && Math.abs(caption.box[1]-x.box[3])<=Math.max(30,page.height*.05)).sort((a,b)=>Math.abs(caption.box[1]-a.box[3])-Math.abs(caption.box[1]-b.box[3]));
      if(near.length===1 || (near.length>1 && Math.abs(caption.box[1]-near[1].box[3])-Math.abs(caption.box[1]-near[0].box[3])>10)) {near[0].captionIds.push(...caption.blockIds);relations.push({kind:'caption',assetItemId:near[0].id,captionItemId:caption.id});}
      else diagnostics.push({code:'caption-association-unresolved',pageIndex:pi,itemId:caption.id});
    }
    const headers=entries.filter(x=>x.kind==='header').sort(geom), footers=entries.filter(x=>x.kind==='footer').sort(geom);
    for(const edge of [...headers,...footers]) entries.splice(entries.indexOf(edge),1);
    if(entries.some(x=>!boxOK(x.box)) || !Number.isFinite(page.width)) {
      diagnostics.push({code:'reading-order-fallback',pageIndex:pi,detail:'Missing geometry; reader order retained.'}); entries.sort(reading);
    } else {
      // Find central gaps using individual source line boxes, excluding wide spanning lines.
      const lineBoxes=blocks.filter(x=>x.b.text && !ownedByAsset(x,entries)).flatMap(x=>{const lines=x.b.source?.lines?.map(l=>l.bbox).filter(boxOK) || [];return lines.length?lines:[x.box];}).filter(boxOK);
      const candidates=[];
      for(let mid=page.width*.25;mid<=page.width*.75;mid+=Math.max(1,page.width/400)) {
        const left=lineBoxes.filter(b=>b[2]<mid && b[2]>page.width*.2 && b[2]-b[0]>page.width*.25),right=lineBoxes.filter(b=>b[0]>mid && b[0]<page.width*.8 && b[2]-b[0]>page.width*.25);
        if(left.length<2 || right.length<2 || !left.some(a=>right.some(b=>a[1]<b[3] && b[1]<a[3]))) continue;
        const l=Math.max(...left.map(b=>b[2])),r=Math.min(...right.map(b=>b[0]));
        if(r-l>=Math.max(8,page.width*.015)) candidates.push({mid:(l+r)/2,l,r,score:Math.min(left.length,right.length)});
      }
      candidates.sort((a,b)=>b.score-a.score || Math.abs(a.mid-page.width/2)-Math.abs(b.mid-page.width/2));
      const g=candidates[0];
      if(!g) {entries.sort(geom); diagnostics.push({code:'single-column-or-unresolved',pageIndex:pi});}
      else {
        const spans=entries.filter(x=>x.box[0]<g.mid && x.box[2]>g.mid).sort(geom);
        const side=entries.filter(x=>!spans.includes(x));
        // Spanning objects define local bands; overlapping side objects stay in the same band.
        const groups=[]; for(const s of spans) {const last=groups.at(-1);if(last && s.box[1]<last.bottom) {last.items.push(s);last.bottom=Math.max(last.bottom,s.box[3]);} else groups.push({items:[s],top:s.box[1],bottom:s.box[3]});}
        // A caption beginning below body text starts a new two-column band.
        for(const c of side.filter(x=>x.kind==='caption')) if(side.some(x=>x!==c && x.kind==='paragraph' && x.box[3]<c.box[1]-5) && !groups.some(g=>c.box[1]>=g.top && c.box[1]<g.bottom)) groups.push({items:[],top:c.box[1],bottom:c.box[1]});
        groups.sort((a,b)=>a.top-b.top);
        const bands=Array.from({length:groups.length+1},()=>[]);
        for(const x of side) {let n=groups.findIndex(g=>x.box[1]<g.bottom && x.box[3]>g.top);if(n>=0) {groups[n].items.push(x);diagnostics.push({code:'band-overlap',pageIndex:pi,itemId:x.id});} else {n=groups.findIndex(g=>x.box[3]<=g.top);bands[n<0?groups.length:n].push(x);}}
        const orderBand=xs=>{const left=xs.filter(x=>x.box[2]<=g.mid).sort(geom),right=xs.filter(x=>x.box[0]>=g.mid).sort(geom);const both=left.length && right.length;for(const x of xs) {x.columns=both?2:1;x.span=both?'column':'page';}return [...left,...right];};
        const ordered=[];for(let i=0;i<bands.length;i++){ordered.push(...orderBand(bands[i]));if(groups[i]) ordered.push(...groups[i].items.sort(geom));} entries.splice(0,entries.length,...ordered);
        diagnostics.push({code:'geometry-order-heuristic',pageIndex:pi,gutter:[g.l,g.r]});
      }
    }
    for(const header of headers) {
      const at=entries.findIndex(e=>boxOK(e.box) && e.box[1]>=header.box[1]);
      entries.splice(at<0?entries.length:at,0,header);
    }
    items.push(...[...entries,...footers].map(({box,pos,index,...item})=>item));
  }
  return {schema:'falsify.paper-flow.v1',sourceSha256:document.sourceSha256,items,relations,diagnostics,fragments,regions};
}
function ownedByAsset(x,entries) {return entries.some(e=>e.kind==='asset' && e.blockIds.includes(x.b.id));}
