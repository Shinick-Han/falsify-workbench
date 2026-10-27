const boxOK = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3];
const overlap = (a,b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const union = boxes => [Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
const contains = (a,b) => b[0]>=a[0]-1 && b[1]>=a[1]-1 && b[2]<=a[2]+1 && b[3]<=a[3]+1;
const median = xs => { const a=[...xs].sort((x,y)=>x-y); return a.length ? a[Math.floor(a.length/2)] : 0; };
const reading = (a,b) => (a.pos ?? Infinity)-(b.pos ?? Infinity) || a.index-b.index;
const geom = (a,b) => a.box[1]-b.box[1] || a.box[0]-b.box[0] || reading(a,b);

/** Produce a deterministic, source-bound reading order and ownership proposal. */
export function buildPaperFlow(document) {
  if (document?.schema !== 'falsify.paper-document.v1' || !Array.isArray(document.pages) || !Array.isArray(document.blocks) || !Array.isArray(document.assets)) throw new TypeError('Expected falsify.paper-document.v1');
  const items=[],relations=[],diagnostics=[];
  const styles=new Map((document.styles || []).map(s=>[s.id,s]));
  const textBlocks=document.blocks.filter(b=>b.text);
  const sizeOf=b=>median((b.source?.characters || []).map(c=>styles.get(c.styleId)?.size).filter(Number.isFinite)) || styles.get(b.styleId)?.size || 0;
  const bodySize=median(textBlocks.map(sizeOf).filter(Boolean));
  const repeats=new Map();
  for(const b of textBlocks) {const page=document.pages.find(p=>p.sourcePageIndex===b.source?.pageIndex),box=b.source?.bbox;if(!page || !boxOK(box) || !(box[1]<page.height*.12 || box[3]>page.height*.88)) continue;const key=b.text.trim().replace(/\s+/g,' ');if(key) {if(!repeats.has(key)) repeats.set(key,new Set()); repeats.get(key).add(b.source.pageIndex);}}
  for (const page of document.pages) {
    const pi=page.sourcePageIndex;
    const blocks=document.blocks.map((b,index)=>({b,index,box:b.source?.bbox,pos:b.source?.readerPosition})).filter(x=>x.b.source?.pageIndex===pi);
    const assets=document.assets.map((a,index)=>({a,index,box:a.source?.bbox,pos:a.source?.readerPosition})).filter(x=>x.a.source?.pageIndex===pi);
    const owned=new Set(), represented=new Set(); let serial=0;
    const make=(kind,bs,as,box,pos,index)=>({id:`flow-${pi}-${serial++}`,kind,blockIds:bs.map(x=>x.b.id),assetIds:as.map(x=>x.a.id),source:{pageIndex:pi,bbox:boxOK(box)?[...box]:null},columns:1,span:'page',captionIds:[],box,pos,index});
    const entries=[];
    // Group overlapping image occurrences. Only fully contained text is owned as artwork.
    for(const a of assets) {
      if(represented.has(a.a.id)) continue;
      const group=[a];represented.add(a.a.id);
      if(boxOK(a.box)) for(let i=0;i<group.length;i++) for(const other of assets) if(!represented.has(other.a.id) && boxOK(other.box) && overlap(group[i].box,other.box)) {group.push(other);represented.add(other.a.id);}
      const box=group.every(x=>boxOK(x.box))?union(group.map(x=>x.box)):null;
      const bs=blocks.filter(x=>!owned.has(x.b.id) && ((x.b.assetIds || []).some(id=>group.some(y=>y.a.id===id)) || (x.b.text && x.b.text.trim().length <= 12 && (x.b.source?.lines?.length || 1) === 1 && boxOK(box) && boxOK(x.box) && group.some(y=>y.box[3]-y.box[1]>=20 && contains(y.box,x.box)))));
      bs.forEach(x=>owned.add(x.b.id));
      entries.push(make('asset',bs,group,box,a.pos,a.index));
    }
    for(const x of blocks) {
      if(owned.has(x.b.id)) continue;
      owned.add(x.b.id); const b=x.b, box=x.box;
      let kind='paragraph';
      if(b.kind==='figure' || b.kind==='table') kind='asset';
      else if(b.kind==='caption' || /^\s*(?:fig(?:ure)?\.?|table)\s*\d+[\w.:-]*/i.test(b.text || '')) kind='caption';
      else if(boxOK(box) && repeats.get((b.text || '').trim().replace(/\s+/g,' '))?.size>=2 && box[1]<page.height*.12) kind='header';
      else if(boxOK(box) && repeats.get((b.text || '').trim().replace(/\s+/g,' '))?.size>=2 && box[3]>page.height*.88) kind='footer';
      else if(b.kind==='heading' || (bodySize>0 && sizeOf(b)>bodySize*1.3 && (b.text || '').trim().length>1 && (b.text || '').length<150)) kind='heading';
      entries.push(make(kind,[x],[],box,x.pos,x.index));
    }
    // Link only an unambiguous nearby caption, never absorb it into the image.
    for(const caption of entries.filter(x=>x.kind==='caption' && boxOK(x.box))) {
      const near=entries.filter(x=>x.kind==='asset' && boxOK(x.box) && x.box[0]<caption.box[2] && caption.box[0]<x.box[2] && Math.abs(caption.box[1]-x.box[3])<=Math.max(30,page.height*.05)).sort((a,b)=>Math.abs(caption.box[1]-a.box[3])-Math.abs(caption.box[1]-b.box[3]));
      if(near.length===1 || (near.length>1 && Math.abs(caption.box[1]-near[1].box[3])-Math.abs(caption.box[1]-near[0].box[3])>10)) {near[0].captionIds.push(...caption.blockIds);relations.push({kind:'caption',assetItemId:near[0].id,captionItemId:caption.id});}
      else diagnostics.push({code:'caption-association-unresolved',pageIndex:pi,itemId:caption.id});
    }
    if(entries.some(x=>!boxOK(x.box)) || !Number.isFinite(page.width)) {
      diagnostics.push({code:'reading-order-fallback',pageIndex:pi,detail:'Missing geometry; reader order retained.'}); entries.sort(reading);
    } else {
      // Find central gaps using individual source line boxes, excluding wide spanning lines.
      const lineBoxes=blocks.filter(x=>x.b.text && !ownedByAsset(x,entries)).flatMap(x=>{const lines=x.b.source?.lines?.map(l=>l.bbox).filter(boxOK) || [];return lines.length?lines:[x.box];}).filter(boxOK);
      const candidates=[];
      for(let mid=page.width*.25;mid<=page.width*.75;mid+=Math.max(1,page.width/400)) {
        const left=lineBoxes.filter(b=>b[2]<mid && b[2]>page.width*.2),right=lineBoxes.filter(b=>b[0]>mid && b[0]<page.width*.8);
        if(left.length<2 || right.length<2 || !left.some(a=>right.some(b=>a[1]<b[3] && b[1]<a[3]))) continue;
        const l=Math.max(...left.map(b=>b[2])),r=Math.min(...right.map(b=>b[0]));
        if(r-l>=Math.max(8,page.width*.015)) candidates.push({mid:(l+r)/2,l,r,score:left.length+right.length});
      }
      candidates.sort((a,b)=>b.score-a.score || Math.abs(a.mid-page.width/2)-Math.abs(b.mid-page.width/2));
      const g=candidates[0];
      if(!g) {entries.sort(geom); diagnostics.push({code:'single-column-or-unresolved',pageIndex:pi});}
      else {
        const spans=entries.filter(x=>x.box[0]<g.mid && x.box[2]>g.mid).sort(geom);
        const side=entries.filter(x=>!spans.includes(x));
        // Spanning objects define local bands; overlapping side objects stay in the same band.
        const groups=[]; for(const s of spans) {const last=groups.at(-1);if(last && s.box[1]<last.bottom) {last.items.push(s);last.bottom=Math.max(last.bottom,s.box[3]);} else groups.push({items:[s],top:s.box[1],bottom:s.box[3]});}
        const bands=Array.from({length:groups.length+1},()=>[]);
        for(const x of side) {let n=groups.findIndex(g=>x.box[1]<g.bottom && x.box[3]>g.top);if(n>=0) {groups[n].items.push(x);diagnostics.push({code:'band-overlap',pageIndex:pi,itemId:x.id});} else {n=groups.findIndex(g=>x.box[3]<=g.top);bands[n<0?groups.length:n].push(x);}}
        const orderBand=xs=>{const left=xs.filter(x=>x.box[2]<=g.mid).sort(geom),right=xs.filter(x=>x.box[0]>=g.mid).sort(geom);const both=left.length && right.length;for(const x of xs) {x.columns=both?2:1;x.span=both?'column':'page';}return [...left,...right];};
        const ordered=[];for(let i=0;i<bands.length;i++){ordered.push(...orderBand(bands[i]));if(groups[i]) ordered.push(...groups[i].items.sort(geom));} entries.splice(0,entries.length,...ordered);
        diagnostics.push({code:'geometry-order-heuristic',pageIndex:pi,gutter:[g.l,g.r]});
      }
    }
    items.push(...entries.map(({box,pos,index,...item})=>item));
  }
  return {schema:'falsify.paper-flow.v1',sourceSha256:document.sourceSha256,items,relations,diagnostics};
}
function ownedByAsset(x,entries) {return entries.some(e=>e.kind==='asset' && e.blockIds.includes(x.b.id));}
