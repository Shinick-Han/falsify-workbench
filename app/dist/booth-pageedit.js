/* Event-page in-place editing (simplify/tap): the paper page itself is the editor. event.html only.
   Every edit is stored in FalsifyBoothEdits ({pageIndex, rects, originalText, newText, source}).
   A tap on a text-layer token captures Range.getClientRects() as page fractions and opens a small
   popover (mouse) or bottom edit bar (touch). Tapping an existing edit edits it in place.
   "문단 전체 고치기" is always enabled: it clusters single-column paragraph lines around the tap,
   substitutes existing edits inside that block, opens a simple textarea sheet, and on commit emits
   one changed-range edit covering only the characters that changed (or the whole block on full delete).
   Overlays (.booth-patch) are stateless and store-driven: white rect over each original rect plus
   newText, repainted on store changes, page draws and resizes. DOM text uses textContent only. */
(function(root){
  'use strict';
  const ZOOM=2.5;
  const TABLE_ZOOM=3.5;
  const DESK='(min-width:1024px)';
  const LEAD=/^[(\[{"'“‘]+/;
  const TAIL=/[)\]}"'”’,;:.!?]+$/;
  const SPACE=/\s/;
  const SERIF='"Times New Roman","Nimbus Roman","Liberation Serif","Noto Serif",serif';
  const MIN_SCALE_X=0.7;

  /* ---------- pure helpers ---------- */
  function clamp01(n){return Math.min(1,Math.max(0,Number(n)||0));}
  function clampRect(r){
    const x=clamp01(r&&r.x);
    const y=clamp01(r&&r.y);
    return {x,y,w:Math.min(1-x,Math.max(0,Number(r&&r.w)||0)),h:Math.min(1-y,Math.max(0,Number(r&&r.h)||0))};
  }
  function overlaps(a, b){
    return a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
  }
  function union(a, b){
    const x=Math.min(a.x,b.x);
    const y=Math.min(a.y,b.y);
    return {x,y,w:Math.max(a.x+a.w,b.x+b.w)-x,h:Math.max(a.y+a.h,b.y+b.h)-y};
  }
  function rectUnion(rects){
    return rects.reduce((acc,r)=>acc?union(acc,r):{x:r.x,y:r.y,w:r.w,h:r.h},null);
  }
  function padRect(rect, pad){
    const x=Math.max(0,rect.x-pad);
    const y=Math.max(0,rect.y-pad);
    return {x,y,w:Math.min(1,rect.x+rect.w+pad)-x,h:Math.min(1,rect.y+rect.h+pad)-y};
  }
  function nearestInk(text, index){
    if(index>=0&&index<text.length&&!SPACE.test(text[index])) return index;
    for(let d=1;d<text.length;d+=1){
      if(index-d>=0&&index-d<text.length&&!SPACE.test(text[index-d])) return index-d;
      if(index+d<text.length&&index+d>=0&&!SPACE.test(text[index+d])) return index+d;
    }
    return -1;
  }
  /* Whitespace-delimited token around index, without wrapping brackets, quotes or trailing punctuation. */
  function tokenAt(text, index){
    const value=typeof text==='string'?text:'';
    const at=nearestInk(value,Math.floor(Number(index)||0));
    if(at<0) return null;
    let start=at;
    let end=at+1;
    while(start>0&&!SPACE.test(value[start-1])) start-=1;
    while(end<value.length&&!SPACE.test(value[end])) end+=1;
    const word=value.slice(start,end);
    const lead=(LEAD.exec(word)||[''])[0].length;
    const tail=(TAIL.exec(word.slice(lead))||[''])[0].length;
    if(lead+tail>=word.length) return {start,end};
    return {start:start+lead,end:end-tail};
  }
  /* Every token of a line, in order, as tokenAt would select it. */
  function tokensIn(text){
    const out=[];
    const value=typeof text==='string'?text:'';
    const re=/\S+/g;
    let m=re.exec(value);
    while(m){
      const t=tokenAt(value,m.index);
      if(t&&!out.some(o=>o.start===t.start)) out.push(t);
      m=re.exec(value);
    }
    return out;
  }
  /* Digits with . , % or a sign only: touch keyboards can show the decimal pad. */
  function numericToken(text){
    return typeof text==='string'&&/^[-+−–]?[\d.,%]+$/.test(text)&&/\d/.test(text);
  }
  /* Below the anchor when it fits above the bottom bound, else above it; always inside bounds. */
  function placePopover(anchor, size, bounds){
    const centre=(anchor.left+anchor.right)/2;
    const maxLeft=Math.max(bounds.left,bounds.right-size.w);
    const left=Math.min(maxLeft,Math.max(bounds.left,centre-size.w/2));
    const below=anchor.bottom+8;
    if(below+size.h<=bounds.bottom) return {left,top:below,above:false};
    const above=anchor.top-8-size.h;
    if(above>=bounds.top) return {left,top:above,above:true};
    return {left,top:Math.max(bounds.top,Math.min(below,bounds.bottom-size.h)),above:false};
  }
  /* Height of whatever covers the bottom of the layout viewport (the soft keyboard). */
  function keyboardInset(innerHeight, vv){
    if(!vv||!(vv.height>0)) return 0;
    return Math.max(0,Math.round(innerHeight-(vv.offsetTop+vv.height)));
  }
  /* The point with the most neighbours within radius (a dense table of numbers). */
  function densest(points, radius){
    let best=null;
    for(const p of Array.isArray(points)?points:[]){
      const count=points.filter(q=>Math.hypot(q.x-p.x,q.y-p.y)<=radius).length;
      if(!best||count>best.count) best={x:p.x,y:p.y,count};
    }
    return best;
  }
  /* The hint block around a number cluster (page fractions): grows from the seed cluster across
     same-row table cells/row names (stopping before a column gutter) and up to header rows. */
  function hintBlock(items, seed, lineH){
    const boxes=new Set((Array.isArray(items)?items:[]).map(item=>item&&item.rect).filter(r=>r&&r.w>0&&r.h>0));
    let block={x:seed.x,y:seed.y,w:seed.w,h:seed.h};
    const vReach=Math.max(0,Number(lineH)||0)*1.6;
    const hReach=Math.max(0.03,Math.min(0.035,(Number(lineH)||0)*2.5));
    for(let changed=true;changed;){
      changed=false;
      for(const r of boxes){
        const inBlock=r.x>=block.x&&r.y>=block.y&&r.x+r.w<=block.x+block.w&&r.y+r.h<=block.y+block.h;
        if(inBlock||r.h>block.h*3+vReach) continue;
        const aboveBand={x:block.x,y:block.y-vReach,w:block.w,h:block.h+vReach};
        const rowBand={x:Math.max(0,block.x-hReach),y:block.y,w:block.w+hReach*2,h:block.h};
        if(!overlaps(r,aboveBand)&&!overlaps(r,rowBand)) continue;
        block=union(block,r);
        boxes.delete(r);
        changed=true;
      }
    }
    return block;
  }
  /* The zoom that fits a block of width w (page fractions, padded by pad each side) across the column, capped. */
  function fitZoom(w, pad, cap){
    if(!(w>0)) return 1;
    return Math.max(1,Math.min(cap,Math.floor(100/(w+2*pad))/100));
  }

  /* ---------- line grouping, block clustering and changed-range edits ---------- */
  function midY(r){return r.y+r.h/2;}
  function joinLineSpansWithMap(spans){
    let raw='';
    const rawParts=[];
    for(let i=0;i<spans.length;i+=1){
      const cur=spans[i];
      if(i>0){
        const prev=spans[i-1];
        const gap=cur.rect.x-(prev.rect.x+prev.rect.w);
        const minH=Math.min(prev.rect.h,cur.rect.h);
        if(!/\s$/.test(prev.text)&&!/^\s/.test(cur.text)&&gap>0.15*minH) raw+=' ';
      }
      const rawStart=raw.length;
      raw+=cur.text;
      rawParts.push({cur,rawStart,rawEnd:raw.length});
    }
    const lead=(/^\s*/.exec(raw)||[''])[0].length;
    const text=raw.trim();
    const trimmedEnd=lead+text.length;
    const parts=[];
    for(const p of rawParts){
      const s=Math.max(lead,p.rawStart);
      const e=Math.min(trimmedEnd,p.rawEnd);
      if(e<=s) continue;
      parts.push({
        span:p.cur.span||null,
        rect:p.cur.rect,
        index:p.cur.index,
        textLen:p.cur.text.length,
        lineStart:s-lead,
        lineEnd:e-lead,
        spanStart:s-p.rawStart,
        spanEnd:e-p.rawStart
      });
    }
    return {text,parts};
  }
  function lineFontSize(spans){
    let bestSize=0;
    let bestWeight=0;
    const weights=new Map();
    for(const s of spans){
      const fs=Number(s.fontSize)||0;
      if(!(fs>0)) continue;
      const key=Math.round(fs*10)/10;
      const w=(weights.get(key)||0)+Math.max(1,s.text.trim().length);
      weights.set(key,w);
      if(w>bestWeight){bestWeight=w;bestSize=key;}
    }
    return bestSize;
  }
  function normalizeSpanItems(items){
    return (Array.isArray(items)?items:[])
      .map((item,idx)=>item&&item.rect&&typeof item.text==='string'&&item.text.trim()&&item.rect.w>0&&item.rect.h>0
        ?{text:item.text,rect:clampRect(item.rect),index:idx,span:item.span||null,fontSize:Number(item.fontSize)||0}:null)
      .filter(Boolean);
  }
  function clusterColumnStarts(xs){
    const clusters=[];
    for(const x of xs){
      const last=clusters[clusters.length-1];
      if(last&&x-last.min<=0.008){
        last.sum+=x;
        last.count+=1;
        last.max=x;
      }else{
        clusters.push({min:x,max:x,sum:x,count:1});
      }
    }
    return clusters;
  }
  function isValidColumnSplit(valid, colX){
    const rightYs=new Set();
    const leftYs=new Set();
    let deepCross=0;
    for(const it of valid){
      const rowKey=Math.round(midY(it.rect)*100);
      const x=it.rect.x;
      const x2=x+it.rect.w;
      if(x>=colX-0.008&&x<=colX+0.008) rightYs.add(rowKey);
      else if(x<colX-0.12&&x2<=colX+0.03) leftYs.add(rowKey);
      if(x<colX-0.05&&x2>colX+0.05) deepCross+=1;
    }
    return rightYs.size>=3&&leftYs.size>=3&&deepCross<Math.max(2,rightYs.size*0.25);
  }
  /* Detects strong vertical column boundaries (e.g. two-column papers where right-column lines
     align near x ≈ 0.51) so line grouping and block clustering never merge across columns even
     when text-layer spans slightly overshoot the gutter. */
  function detectColumnSplits(valid){
    if(!Array.isArray(valid)||valid.length<6) return [];
    const xs=valid.map(it=>it.rect.x).filter(x=>x>=0.32&&x<=0.72).sort((a,b)=>a-b);
    if(xs.length<3) return [];
    const splits=[];
    for(const c of clusterColumnStarts(xs)){
      if(c.count<3) continue;
      const colX=c.sum/c.count;
      if(isValidColumnSplit(valid,colX)&&!splits.some(s=>Math.abs(s-colX)<0.05)) splits.push(colX);
    }
    return splits.sort((a,b)=>a-b);
  }
  /* Groups span items [{text, rect, span?, fontSize?}] (page fractions) into horizontal line segments
     [{text, rect, spans, parts, fontSize}]. Splits across horizontal gutters and detected column splits
     so two-column baselines never merge into one line. */
  function groupLines(items){
    const valid=normalizeSpanItems(items);
    const colSplits=detectColumnSplits(valid);
    valid.sort((a,b)=>midY(a.rect)-midY(b.rect)||a.rect.x-b.rect.x);
    const rows=[];
    for(const item of valid){
      const my=midY(item.rect);
      let row=null;
      for(let i=rows.length-1;i>=0;i-=1){
        const cand=rows[i];
        const minH=Math.min(cand.h,item.rect.h);
        if(Math.abs(my-cand.midY)<0.5*minH){row=cand;break;}
        if(my-cand.midY>cand.h) break;
      }
      if(!row){
        rows.push({midY:my,h:item.rect.h,items:[item]});
      }else{
        row.items.push(item);
        row.midY=row.items.reduce((s,it)=>s+midY(it.rect),0)/row.items.length;
        row.h=Math.min(row.h,item.rect.h);
      }
    }
    const buildLine=seg=>{
      const joined=joinLineSpansWithMap(seg);
      return {text:joined.text,rect:rectUnion(seg.map(s=>s.rect)),spans:seg,parts:joined.parts,fontSize:lineFontSize(seg)};
    };
    const lines=[];
    for(const row of rows){
      row.items.sort((a,b)=>a.rect.x-b.rect.x);
      const rowH=row.items.reduce((m,it)=>Math.max(m,it.rect.h),0);
      const gutter=Math.max(0.022,1.8*rowH);
      let seg=[row.items[0]];
      for(let i=1;i<row.items.length;i+=1){
        const prev=row.items[i-1];
        const cur=row.items[i];
        const gap=cur.rect.x-(prev.rect.x+prev.rect.w);
        const crossesCol=colSplits.some(sx=>seg[0].rect.x<sx-0.05&&prev.rect.x+prev.rect.w<=sx+0.03&&cur.rect.x>=sx-0.008);
        if(gap>gutter||crossesCol){
          lines.push(buildLine(seg));
          seg=[cur];
        }else{
          seg.push(cur);
        }
      }
      lines.push(buildLine(seg));
    }
    lines.sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x);
    return lines;
  }
  function medianOf(values){
    if(!values.length) return 0;
    const sorted=values.slice().sort((a,b)=>a-b);
    return sorted[Math.floor(sorted.length/2)];
  }
  function nearestLineIndex(lines, target, requireOverlap){
    let best=-1;
    let bestDist=Infinity;
    const cx=target.x+(target.w||0)/2;
    const cy=target.y+(target.h||0)/2;
    for(let i=0;i<lines.length;i+=1){
      const line=lines[i];
      if(requireOverlap&&!overlaps(line.rect,target)) continue;
      const d=Math.hypot(line.rect.x+line.rect.w/2-cx,midY(line.rect)-cy);
      if(d<bestDist){best=i;bestDist=d;}
    }
    return best;
  }
  function findSeedLineIndex(lines, target){
    if(typeof target==='number') return lines.findIndex(line=>line.spans.some(s=>s.index===target));
    if(!target||typeof target!=='object') return -1;
    const hit=nearestLineIndex(lines,target,true);
    return hit>=0?hit:nearestLineIndex(lines,target,false);
  }
  function columnBoundsFor(seed, colSplits){
    let left=0;
    let right=1;
    for(const sx of colSplits){
      const spansAcross=seed.rect.x<sx-0.05&&seed.rect.x+seed.rect.w>sx+0.05;
      if(spansAcross) continue;
      if(seed.rect.x>=sx-0.008) left=Math.max(left,sx);
      else right=Math.min(right,sx);
    }
    return {left,right};
  }
  function matchesColumnAndStyle(cand, seed, bounds, colLeft, colRight){
    if(bounds.left>0&&cand.rect.x<bounds.left-0.008) return false;
    if(bounds.right<1&&(cand.rect.x>=bounds.right-0.008||cand.rect.x+cand.rect.w>bounds.right+0.05)) return false;
    const xOv=Math.min(cand.rect.x+cand.rect.w,colRight)-Math.max(cand.rect.x,colLeft);
    const minW=Math.min(cand.rect.w,colRight-colLeft);
    if(!(xOv>0&&(xOv>=minW*0.25||(minW<=0.04&&xOv>=minW*0.1)))) return false;
    if(Math.max(cand.rect.h,seed.rect.h)/Math.min(cand.rect.h,seed.rect.h)>1.08) return false;
    const seedFs=seed.fontSize||0;
    if(seedFs>0&&cand.fontSize>0&&Math.max(cand.fontSize,seedFs)/Math.min(cand.fontSize,seedFs)>1.06) return false;
    return true;
  }
  function stepAllowed(step, gap, refH, pitch){
    if(step>1.65*refH||gap>0.75*refH) return false;
    return !(pitch>0&&step>1.32*pitch);
  }
  function checkBlockAbove(cand, state, pitch){
    const refH=Math.max(cand.rect.h,state.topLine.rect.h);
    const step=midY(state.topLine.rect)-midY(cand.rect);
    const gap=state.topLine.rect.y-(cand.rect.y+cand.rect.h);
    return stepAllowed(step,gap,refH,pitch)?step:-1;
  }
  function checkBlockBelow(cand, state, pitch, indentThresh){
    if(cand.rect.x-state.colLeft>indentThresh&&state.botLine.rect.x-state.colLeft<=indentThresh) return -1;
    const refH=Math.max(cand.rect.h,state.botLine.rect.h);
    const step=midY(cand.rect)-midY(state.botLine.rect);
    const gap=cand.rect.y-(state.botLine.rect.y+state.botLine.rect.h);
    return stepAllowed(step,gap,refH,pitch)?step:-1;
  }
  function findBlockNeighbors(lines, state, seed, bounds, indentThresh){
    const pitch=medianOf(state.steps);
    const topIndented=state.picked.size>1&&state.topLine.rect.x-state.colLeft>indentThresh;
    let bestAbove=-1;
    let aboveStep=Infinity;
    let bestBelow=-1;
    let belowStep=Infinity;
    for(let i=0;i<lines.length;i+=1){
      if(state.picked.has(i)) continue;
      const cand=lines[i];
      if(!matchesColumnAndStyle(cand,seed,bounds,state.colLeft,state.colRight)) continue;
      if(!topIndented&&cand.rect.y<state.topLine.rect.y){
        const step=checkBlockAbove(cand,state,pitch);
        if(step>=0&&(bestAbove<0||cand.rect.y>lines[bestAbove].rect.y)){bestAbove=i;aboveStep=step;}
      }else if(cand.rect.y>state.botLine.rect.y){
        const step=checkBlockBelow(cand,state,pitch,indentThresh);
        if(step>=0&&(bestBelow<0||cand.rect.y<lines[bestBelow].rect.y)){bestBelow=i;belowStep=step;}
      }
    }
    return {bestAbove,aboveStep,bestBelow,belowStep};
  }
  function acceptBlockLine(lines, state, idx, step){
    state.picked.add(idx);
    if(step>0) state.steps.push(step);
    const r=lines[idx].rect;
    state.colLeft=Math.min(state.colLeft,r.x);
    state.colRight=Math.max(state.colRight,r.x+r.w);
    if(r.y<state.topLine.rect.y) state.topLine=lines[idx];
    if(r.y>state.botLine.rect.y) state.botLine=lines[idx];
  }
  /* Clusters text-layer lines around target (item index or fraction rect) into one single-column
     paragraph: stays inside the tapped line's column, stops at a vertical step larger than ~1.3x the
     line pitch, at a font size or line height change, or at a first-line paragraph indent boundary. */
  function clusterBlock(items, target){
    const valid=normalizeSpanItems(items);
    const colSplits=detectColumnSplits(valid);
    const lines=groupLines(valid);
    const seedIdx=findSeedLineIndex(lines,target);
    if(seedIdx<0) return [];
    const seed=lines[seedIdx];
    const bounds=columnBoundsFor(seed,colSplits);
    const indentThresh=Math.max(0.010,0.9*seed.rect.h);
    const state={
      picked:new Set([seedIdx]),
      colLeft:seed.rect.x,
      colRight:seed.rect.x+seed.rect.w,
      topLine:seed,
      botLine:seed,
      steps:[]
    };
    for(;;){
      const {bestAbove,aboveStep,bestBelow,belowStep}=findBlockNeighbors(lines,state,seed,bounds,indentThresh);
      if(bestAbove<0&&bestBelow<0) break;
      if(!state.steps.length&&bestAbove>=0&&bestBelow>=0){
        if(belowStep<=aboveStep) acceptBlockLine(lines,state,bestBelow,belowStep);
        else acceptBlockLine(lines,state,bestAbove,aboveStep);
        continue;
      }
      if(bestAbove>=0) acceptBlockLine(lines,state,bestAbove,aboveStep);
      if(bestBelow>=0) acceptBlockLine(lines,state,bestBelow,belowStep);
    }
    return [...state.picked].map(i=>lines[i]).sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x);
  }
  /* Vertical overlap strictly greater than 40% of the shorter box: avoids grazing adjacent lines. */
  function sameLineBand(a, b){
    if(!overlaps(a,b)) return false;
    const vh=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
    return vh>0.4*Math.min(a.h,b.h);
  }
  function blockLineOffsets(blockLines){
    const offsets=[];
    let at=0;
    for(let i=0;i<blockLines.length;i+=1){
      offsets.push(at);
      at+=blockLines[i].text.length+1;
    }
    return offsets;
  }
  function findLineHits(blockLines, edit){
    if(!edit||!Array.isArray(edit.rects)||!edit.rects.length) return [];
    const hits=[];
    for(let i=0;i<blockLines.length;i+=1){
      if(edit.rects.some(r=>sameLineBand(r,blockLines[i].rect))) hits.push(i);
    }
    return hits;
  }
  function findNearestNeedle(region, needle, approx){
    let best=-1;
    for(let at=region.indexOf(needle);at>=0;at=region.indexOf(needle,at+1)){
      if(best<0||Math.abs(at-approx)<Math.abs(best-approx)) best=at;
    }
    return best;
  }
  function expandWholeLineDelete(origText, start, end){
    if(end<origText.length&&origText[end]==='\n') return {origStart:start,origEnd:end+1};
    if(start>0&&origText[start-1]==='\n') return {origStart:start-1,origEnd:end};
    return {origStart:start,origEnd:end};
  }
  function findNeedleSpan(edit, firstLine, regionStart, regionEnd, blockLines, origLines, origText, needle){
    if(!needle) return null;
    const lineR=blockLines[firstLine].rect;
    const approx=lineR.w>0?Math.round(((edit.rects[0].x-lineR.x)/lineR.w)*origLines[firstLine].length):0;
    const best=findNearestNeedle(origText.slice(regionStart,regionEnd),needle,approx);
    return best>=0?{origStart:regionStart+best,origEnd:regionStart+best+needle.length}:null;
  }
  function isWholeRegionEdit(hits, needle, newVal, firstLineText){
    return hits.length>1||needle.includes('\n')||newVal.includes('\n')||needle===firstLineText;
  }
  function isFullBlockDelete(allLines, newVal, needle, origText){
    return allLines&&newVal===''&&(!needle||needle===origText);
  }
  function locateEditInBlock(edit, hits, blockLines, origLines, origText, offsets){
    const firstLine=hits[0];
    const lastLine=hits[hits.length-1];
    const regionStart=offsets[firstLine];
    const regionEnd=offsets[lastLine]+origLines[lastLine].length;
    const needle=String(edit.originalText||'');
    const newVal=String(edit.newText==null?'':edit.newText);
    const allLines=firstLine===0&&lastLine===blockLines.length-1;
    if(isFullBlockDelete(allLines,newVal,needle,origText)){
      return {edit,origStart:0,origEnd:origText.length,origSlice:origText,newSlice:''};
    }
    let span=findNeedleSpan(edit,firstLine,regionStart,regionEnd,blockLines,origLines,origText,needle);
    if(!span){
      if(!isWholeRegionEdit(hits,needle,newVal,origLines[firstLine])) return null;
      span={origStart:regionStart,origEnd:regionEnd};
    }
    if(newVal===''&&span.origStart===regionStart&&span.origEnd===regionEnd&&!allLines){
      span=expandWholeLineDelete(origText,span.origStart,span.origEnd);
    }
    return {edit,origStart:span.origStart,origEnd:span.origEnd,origSlice:origText.slice(span.origStart,span.origEnd),newSlice:newVal};
  }
  function selectNonOverlappingReps(reps){
    reps.sort((a,b)=>a.origStart-b.origStart||b.origEnd-a.origEnd);
    const chosen=[];
    let cursor=0;
    for(const r of reps){
      if(r.origStart<cursor) continue;
      chosen.push(r);
      cursor=r.origEnd;
    }
    return chosen;
  }
  /* Substitutes existing BoothEdits that overlap blockLines into prefill text and records exact
     original <-> prefill spans so unchanged earlier edits survive and reverted ones clean up. */
  function applyEditsToBlockWithMap(blockLines, edits){
    if(!Array.isArray(blockLines)||!blockLines.length) return {origText:'',prefill:'',subs:[]};
    const origLines=blockLines.map(l=>l.text);
    const origText=origLines.join('\n');
    const offsets=blockLineOffsets(blockLines);
    const reps=[];
    for(const edit of Array.isArray(edits)?edits:[]){
      const hits=findLineHits(blockLines,edit);
      if(!hits.length) continue;
      const rep=locateEditInBlock(edit,hits,blockLines,origLines,origText,offsets);
      if(rep) reps.push(rep);
    }
    let prefill='';
    let last=0;
    const subs=[];
    for(const r of selectNonOverlappingReps(reps)){
      prefill+=origText.slice(last,r.origStart);
      const prefillStart=prefill.length;
      prefill+=r.newSlice;
      subs.push({...r,prefillStart,prefillEnd:prefill.length});
      last=r.origEnd;
    }
    prefill+=origText.slice(last);
    return {origText,prefill,subs};
  }
  function applyEditsToBlock(blockLines, edits){
    return applyEditsToBlockWithMap(blockLines,edits).prefill;
  }
  function commonPrefixLength(a, b){
    let p=0;
    while(p<a.length&&p<b.length&&a[p]===b[p]) p+=1;
    return p;
  }
  function commonSuffixLength(a, b, prefix){
    let s=0;
    while(a.length-1-s>=prefix&&b.length-1-s>=prefix&&a[a.length-1-s]===b[b.length-1-s]) s+=1;
    return s;
  }
  function snapStartLeft(orig, range){
    while(range.origStart>0&&!SPACE.test(orig[range.origStart-1])){
      range.origStart-=1;
      range.nextStart-=1;
    }
  }
  function snapEndRight(orig, range){
    while(range.origEnd<orig.length&&!SPACE.test(orig[range.origEnd])){
      range.origEnd+=1;
      range.nextEnd+=1;
    }
  }
  function expandEmptyOrigRange(orig, range){
    const prevStart=range.origStart;
    const prevEnd=range.origEnd;
    snapStartLeft(orig,range);
    snapEndRight(orig,range);
    if(range.origStart!==prevStart||range.origEnd!==prevEnd) return;
    if(/\S/.test(orig.slice(0,range.origStart))){
      while(range.origStart>0&&SPACE.test(orig[range.origStart-1])){range.origStart-=1;range.nextStart-=1;}
      snapStartLeft(orig,range);
    }else if(/\S/.test(orig.slice(range.origEnd))){
      while(range.origEnd<orig.length&&SPACE.test(orig[range.origEnd])){range.origEnd+=1;range.nextEnd+=1;}
      snapEndRight(orig,range);
    }
  }
  function trimDeletedSpaces(orig, range){
    while(range.origStart<range.origEnd&&SPACE.test(orig[range.origStart])) range.origStart+=1;
    while(range.origEnd>range.origStart&&SPACE.test(orig[range.origEnd-1])) range.origEnd-=1;
  }
  /* Computes the changed character range between originalText and newText using common prefix/suffix,
     snapped outward to word boundaries (whitespace). Returns null if unchanged; returns the whole
     range with newText '' on full deletion. */
  function diffChangedRange(originalText, newText){
    const orig=String(originalText==null?'':originalText).replace(/\r\n?/g,'\n');
    const next=String(newText==null?'':newText).replace(/\r\n?/g,'\n');
    if(next===orig) return null;
    if(next===''||!next.trim()){
      return {start:0,end:orig.length,nextStart:0,nextEnd:0,originalText:orig,newText:'',fullDelete:true};
    }
    const prefix=commonPrefixLength(orig,next);
    const suffix=commonSuffixLength(orig,next,prefix);
    const range={origStart:prefix,origEnd:orig.length-suffix,nextStart:prefix,nextEnd:next.length-suffix};
    const origHasInk=/\S/.test(orig.slice(range.origStart,range.origEnd));
    const nextIsEmpty=range.nextStart===range.nextEnd;
    if(!(origHasInk&&nextIsEmpty&&SPACE.test(orig[range.origStart]))) snapStartLeft(orig,range);
    if(!(origHasInk&&nextIsEmpty&&SPACE.test(orig[range.origEnd-1]))) snapEndRight(orig,range);
    if(!/\S/.test(orig.slice(range.origStart,range.origEnd))) expandEmptyOrigRange(orig,range);
    if(range.nextStart===range.nextEnd) trimDeletedSpaces(orig,range);
    return {
      start:range.origStart,
      end:range.origEnd,
      nextStart:range.nextStart,
      nextEnd:range.nextEnd,
      originalText:orig.slice(range.origStart,range.origEnd),
      newText:next.slice(range.nextStart,range.nextEnd),
      fullDelete:false
    };
  }
  function trimmedLineRange(lineText, lineOff, start, end){
    let s=Math.max(start,lineOff)-lineOff;
    let e=Math.min(end,lineOff+lineText.length)-lineOff;
    while(s<e&&SPACE.test(lineText[s])) s+=1;
    while(e>s&&SPACE.test(lineText[e-1])) e-=1;
    return e>s?{s,e}:null;
  }
  function measurePartRects(part, charStart, charEnd, measureSpanRange){
    const measured=typeof measureSpanRange==='function'?measureSpanRange(part,charStart,charEnd):null;
    if(Array.isArray(measured)&&measured.length) return measured.filter(r=>r&&r.w>0&&r.h>0);
    if(!(part.rect&&part.textLen>0)) return [];
    const x=part.rect.x+part.rect.w*(charStart/part.textLen);
    const w=part.rect.w*((charEnd-charStart)/part.textLen);
    return w>0&&part.rect.h>0?[clampRect({x,y:part.rect.y,w,h:part.rect.h})]:[];
  }
  function mapLinePartsToRect(line, s, e, measureSpanRange){
    const lineRects=[];
    if(Array.isArray(line.parts)&&line.parts.length){
      for(const part of line.parts){
        const pS=Math.max(s,part.lineStart);
        const pE=Math.min(e,part.lineEnd);
        if(pE<=pS) continue;
        const charStart=part.spanStart+(pS-part.lineStart);
        const charEnd=part.spanStart+(pE-part.lineStart);
        lineRects.push(...measurePartRects(part,charStart,charEnd,measureSpanRange));
      }
    }else if(line.rect&&line.text.length>0){
      const x=line.rect.x+line.rect.w*(s/line.text.length);
      const w=line.rect.w*((e-s)/line.text.length);
      if(w>0&&line.rect.h>0) lineRects.push(clampRect({x,y:line.rect.y,w,h:line.rect.h}));
    }
    return lineRects.length?rectUnion(lineRects):null;
  }
  /* Maps character range [start, end] in blockLines' joined text back to per-line merged rects.
     Uses measureSpanRange(part, charStart, charEnd) when provided (DOM Range.getClientRects),
     falling back to proportional sub-rects for pure tests. */
  function mapRangeToBlockLines(blockLines, start, end, measureSpanRange){
    if(!Array.isArray(blockLines)||!blockLines.length||!(end>start)) return [];
    const offsets=blockLineOffsets(blockLines);
    const rects=[];
    for(let i=0;i<blockLines.length;i+=1){
      const span=trimmedLineRange(blockLines[i].text,offsets[i],start,end);
      if(!span) continue;
      const rect=mapLinePartsToRect(blockLines[i],span.s,span.e,measureSpanRange);
      if(rect) rects.push(rect);
    }
    return rects;
  }
  function changedBlockEdit(blockLines, newText, measureSpanRange){
    if(!Array.isArray(blockLines)||!blockLines.length) return null;
    const origText=blockLines.map(l=>l.text).join('\n');
    const diff=diffChangedRange(origText,newText);
    if(!diff) return null;
    if(diff.fullDelete){
      return {rects:blockLines.map(l=>l.rect),originalText:diff.originalText,newText:'',start:0,end:origText.length};
    }
    const rects=mapRangeToBlockLines(blockLines,diff.start,diff.end,measureSpanRange);
    return {
      rects:rects.length?rects:blockLines.map(l=>l.rect),
      originalText:diff.originalText,
      newText:diff.newText,
      start:diff.start,
      end:diff.end
    };
  }
  function rawDiffSpan(a, b){
    const p=commonPrefixLength(a,b);
    const s=commonSuffixLength(a,b,p);
    return {start:p,end:a.length-s};
  }
  function prefillPosToOrig(pos, subs, isEnd){
    let shift=0;
    for(const sub of subs){
      const before=isEnd?(sub.prefillEnd<=pos&&sub.prefillStart<pos):(sub.prefillEnd<=pos);
      if(before) shift+=(sub.origEnd-sub.origStart)-(sub.prefillEnd-sub.prefillStart);
    }
    return pos+shift;
  }
  function tryRevertOneSub(curPrefill, curSubs, raw){
    const span=rawDiffSpan(curPrefill,raw);
    for(let i=0;i<curSubs.length;i+=1){
      const sub=curSubs[i];
      const touches=sub.prefillStart===sub.prefillEnd
        ?(sub.prefillStart>=span.start&&sub.prefillStart<=span.end)
        :(sub.prefillStart<span.end&&sub.prefillEnd>span.start);
      if(!touches) continue;
      const cand=curPrefill.slice(0,sub.prefillStart)+sub.origSlice+curPrefill.slice(sub.prefillEnd);
      const cSpan=rawDiffSpan(cand,raw);
      const cleanRevert=cand===raw||sub.prefillStart+sub.origSlice.length<=cSpan.start||sub.prefillStart>=cSpan.end;
      if(!cleanRevert) continue;
      const delta=sub.origSlice.length-(sub.prefillEnd-sub.prefillStart);
      const nextSubs=curSubs.slice();
      nextSubs.splice(i,1);
      for(let j=i;j<nextSubs.length;j+=1){
        nextSubs[j]={...nextSubs[j],prefillStart:nextSubs[j].prefillStart+delta,prefillEnd:nextSubs[j].prefillEnd+delta};
      }
      return {prefill:cand,subs:nextSubs,removedId:sub.edit&&sub.edit.id||null};
    }
    return null;
  }
  function stripRevertedSubs(prefill, subs, raw){
    let curPrefill=prefill;
    let curSubs=subs.map(s=>({...s}));
    const removeIds=[];
    while(curPrefill!==raw){
      const step=tryRevertOneSub(curPrefill,curSubs,raw);
      if(!step) break;
      if(step.removedId) removeIds.push(step.removedId);
      curPrefill=step.prefill;
      curSubs=step.subs;
    }
    return {prefill:curPrefill,subs:curSubs,removeIds};
  }
  function expandRangeOverSubs(range, curSubs){
    for(let expanded=true;expanded;){
      expanded=false;
      for(const sub of curSubs){
        if(sub.prefillStart<range.pStart&&sub.prefillEnd>range.pStart){
          const d=range.pStart-sub.prefillStart;
          range.pStart-=d;range.nStart-=d;expanded=true;
        }
        if(sub.prefillStart<range.pEnd&&sub.prefillEnd>range.pEnd){
          const d=sub.prefillEnd-range.pEnd;
          range.pEnd+=d;range.nEnd+=d;expanded=true;
        }
      }
    }
  }
  function mapPrefillRangeToOrig(range, subs){
    if(range.pStart===range.pEnd){
      const zeroSub=subs.find(s=>s.prefillStart===range.pStart&&s.prefillEnd===range.pEnd);
      if(zeroSub) return {oStart:zeroSub.origStart,oEnd:zeroSub.origEnd};
    }
    return {
      oStart:prefillPosToOrig(range.pStart,subs,false),
      oEnd:prefillPosToOrig(range.pEnd,subs,true)
    };
  }
  function widenPrefillRangeToAdjacentWord(prefill, range){
    if(/\S/.test(prefill.slice(0,range.pStart))){
      while(range.pStart>0&&SPACE.test(prefill[range.pStart-1])){range.pStart-=1;range.nStart-=1;}
      while(range.pStart>0&&!SPACE.test(prefill[range.pStart-1])){range.pStart-=1;range.nStart-=1;}
      return true;
    }
    if(/\S/.test(prefill.slice(range.pEnd))){
      while(range.pEnd<prefill.length&&SPACE.test(prefill[range.pEnd])){range.pEnd+=1;range.nEnd+=1;}
      while(range.pEnd<prefill.length&&!SPACE.test(prefill[range.pEnd])){range.pEnd+=1;range.nEnd+=1;}
      return true;
    }
    return false;
  }
  function resolveNonEmptyOrigRange(origText, prefill, raw, range, subs){
    expandRangeOverSubs(range,subs);
    let mapped=mapPrefillRangeToOrig(range,subs);
    if(/\S/.test(origText.slice(mapped.oStart,mapped.oEnd))) return mapped;
    if(!/\S/.test(origText)) return mapped;
    if(widenPrefillRangeToAdjacentWord(prefill,range)){
      expandRangeOverSubs(range,subs);
      mapped=mapPrefillRangeToOrig(range,subs);
      if(/\S/.test(origText.slice(mapped.oStart,mapped.oEnd))) return mapped;
    }
    range.nStart=0;
    range.nEnd=raw.length;
    return {oStart:0,oEnd:origText.length};
  }
  /* Computes the commit action for a paragraph sheet: removes any earlier edits inside the block that
     were reverted to original, leaves untouched earlier edits outside the changed range intact, and
     emits ONE changed-range BoothEdit (or full-block delete) covering only the touched characters. */
  function commitParagraphChange(blockLines, pageEdits, newText, measureSpanRange){
    if(!Array.isArray(blockLines)||!blockLines.length) return {removeIds:[],edit:null};
    const {origText,prefill,subs}=applyEditsToBlockWithMap(blockLines,pageEdits);
    const raw=String(newText==null?'':newText).replace(/\r\n?/g,'\n');
    if(raw===prefill) return {removeIds:[],edit:null};
    if(raw===''||!raw.trim()){
      return {removeIds:[],edit:{rects:blockLines.map(l=>l.rect),originalText:origText,newText:''}};
    }
    const stripped=stripRevertedSubs(prefill,subs,raw);
    const diff=diffChangedRange(stripped.prefill,raw);
    if(!diff) return {removeIds:stripped.removeIds,edit:null};
    const range={pStart:diff.start,pEnd:diff.end,nStart:diff.nextStart,nEnd:diff.nextEnd};
    const {oStart,oEnd}=resolveNonEmptyOrigRange(origText,stripped.prefill,raw,range,stripped.subs);
    const originalSub=origText.slice(oStart,oEnd);
    const newSub=raw.slice(range.nStart,range.nEnd);
    if(originalSub===newSub) return {removeIds:stripped.removeIds,edit:null};
    const rects=mapRangeToBlockLines(blockLines,oStart,oEnd,measureSpanRange);
    return {
      removeIds:stripped.removeIds,
      edit:{rects:rects.length?rects:blockLines.map(l=>l.rect),originalText:originalSub,newText:newSub}
    };
  }

  /* ---------- page edit UI ---------- */
  function canMount(doc, force){
    const html=doc&&doc.documentElement;
    return !!(force||(doc&&doc.getElementById('booth-step-edit'))||(html&&html.dataset&&html.dataset.boothStep==='edit'));
  }
  function mount(doc, opts){
    const stage=doc&&doc.getElementById('paper-before-stage');
    if(!stage||!canMount(doc,opts&&opts.force)||doc.getElementById('booth-pe-bar')) return false;
    const html=doc.documentElement;
    const st={sel:null,sheet:null,focus:null,pendingClick:null,fileHash:'',pageEl:null,auto:new Set(),autoOff:false,composing:false,hoverFrame:0};
    const ws=()=>root.FalsifyPaperWorkspace||null;
    const store=()=>root.FalsifyBoothEdits||null;
    function el(tag, className, text){
      const node=doc.createElement(tag);
      if(className) node.className=className;
      if(text!=null) node.textContent=text;
      return node;
    }
    function button(className, text, label){
      const node=el('button',className,text);
      node.type='button';
      if(label) node.setAttribute('aria-label',label);
      return node;
    }
    function call(name, ...args){
      const w=ws();
      try{return w&&typeof w[name]==='function'?w[name](...args):null;}catch{return null;}
    }
    const media=query=>!!(root.matchMedia&&root.matchMedia(query).matches);
    const desk=()=>media(DESK);
    const coarse=()=>media('(pointer:coarse)');
    const touch=()=>coarse()||!desk();
    const editing=()=>html.dataset.boothStep==='edit';
    const zoomed=()=>(Number(call('getZoom'))||1)>1.01;
    const pageEl=()=>stage.querySelector(':scope>.paper-page');

    /* Bar above the page (phones): one-line tip, zoom buttons and 전체 쪽 while zoomed. */
    const tip=el('p','booth-pe-tip');
    tip.setAttribute('role','status');
    tip.setAttribute('aria-live','polite');
    const fit=button('booth-pe-fit','전체 쪽');
    fit.id='booth-pe-fit';
    const zoomOut=button('booth-pe-fit booth-pe-zoom','−','축소');
    zoomOut.id='booth-pe-zoom-out';
    const zoomIn=button('booth-pe-fit booth-pe-zoom','+','확대');
    zoomIn.id='booth-pe-zoom-in';
    const tools=el('div','booth-pe-tools');
    tools.append(zoomOut,zoomIn,fit);
    const bar=el('div','booth-pe-bar');
    bar.id='booth-pe-bar';
    bar.append(tip,tools);
    stage.before(bar);
    const pane=doc.getElementById('booth-pane-find');
    if(pane){
      const deskTip=el('div','booth-pe-desk-tip');
      deskTip.append(el('p','','쪽 위의 숫자나 단어를 누르면 그 자리에서 바로 고칠 수 있어요.'),
        el('p','booth-pe-keys','키보드: ← → 쪽 넘기기, + − 확대, Enter 바꾸기, Esc 취소'));
      pane.prepend(deskTip);
    }
    const zoomLevels=()=>desk()?[1,1.25,1.5,2]:[1,1.5,ZOOM,TABLE_ZOOM];
    function syncBar(keepZoomedClass){
      const on=zoomed();
      if(on||!keepZoomedClass) html.classList.toggle('booth-pe-zoomed',on);
      fit.hidden=!on;
      const z=Number(call('getZoom'))||1;
      const levels=zoomLevels();
      zoomOut.disabled=z<=levels[0]+0.01;
      zoomIn.disabled=z>=levels[levels.length-1]-0.01;
      tip.textContent=on?'고칠 숫자나 단어를 눌러 주세요.':'고칠 곳을 누르면 크게 보여요.';
    }
    function setZoom(factor){
      const ok=call('setZoom',factor)===true;
      syncBar(ok&&factor<=1.01);
      return ok;
    }
    fit.addEventListener('click',()=>{closePop(false);setZoom(1);});
    function zoomStep(dir){
      const page=pageEl();
      const z=Number(call('getZoom'))||1;
      const levels=zoomLevels();
      const next=dir>0?levels.find(level=>level>z+0.01):levels.slice().reverse().find(level=>level<z-0.01);
      if(!page||!next) return;
      const box=page.getBoundingClientRect();
      const view=stage.getBoundingClientRect();
      const cx=(Math.max(view.left,box.left)+Math.min(view.right,box.right))/2;
      const cy=(Math.max(view.top,box.top)+Math.min(view.bottom,box.bottom,root.innerHeight||view.bottom))/2;
      closePop(false);
      st.pendingClick=null;
      st.focus={fx:(cx-box.left)/box.width,fy:(cy-box.top)/box.height,fromButton:true};
      if(!setZoom(next)) st.focus=null;
    }
    function placeTools(){
      const toolbar=doc.querySelector('#paper-workspace .paper-toolbar');
      const home=desk()&&toolbar?toolbar:bar;
      if(tools.parentElement!==home) home.append(tools);
    }
    zoomOut.addEventListener('click',()=>zoomStep(-1));
    zoomIn.addEventListener('click',()=>zoomStep(1));

    /* Word editor: anchored popover on desktop, bottom bar above the soft keyboard on touch. */
    const pop=el('div','booth-pe-pop');
    pop.id='booth-pe-pop';
    pop.hidden=true;
    pop.setAttribute('role','dialog');
    pop.setAttribute('aria-labelledby','booth-pe-pop-label');
    const label=el('p','booth-pe-pop-label');
    label.id='booth-pe-pop-label';
    const input=el('input','booth-pe-input');
    Object.assign(input,{type:'text',id:'booth-pe-input',maxLength:300,autocomplete:'off',spellcheck:false});
    for(const [key,value] of [['aria-label','새 글자'],['enterkeyhint','done'],['autocapitalize','off'],['autocorrect','off']]) input.setAttribute(key,value);
    const apply=button('booth-pe-apply','바꾸기');
    const whole=button('booth-pe-whole','문단 전체 고치기');
    const revert=button('booth-pe-revert','원래대로');
    revert.hidden=true;
    const cancel=button('booth-pe-cancel','취소');
    const prev=button('booth-pe-step booth-pe-prev','‹','앞 단어');
    const next=button('booth-pe-step booth-pe-next','›','다음 단어');
    pop.append(label,prev,input,next,apply,whole,revert,cancel);
    doc.body.append(pop);
    const hover=el('div','booth-pe-hover');
    hover.setAttribute('aria-hidden','true');

    /* Paragraph sheet: simple booth-owned textarea dialog for "문단 전체 고치기". */
    const sheet=el('div','booth-pe-sheet');
    sheet.id='booth-pe-sheet';
    sheet.hidden=true;
    sheet.setAttribute('role','dialog');
    sheet.setAttribute('aria-modal','true');
    sheet.setAttribute('aria-labelledby','booth-pe-sheet-label');
    const sheetCard=el('div','booth-pe-sheet-card');
    const sheetLabel=el('p','booth-pe-sheet-label');
    sheetLabel.id='booth-pe-sheet-label';
    const sheetArea=el('textarea','booth-pe-sheet-text');
    sheetArea.id='booth-pe-sheet-text';
    sheetArea.rows=6;
    sheetArea.maxLength=2000;
    sheetArea.spellcheck=false;
    sheetArea.setAttribute('aria-label','문단 전체 고치기');
    sheetArea.setAttribute('lang','en');
    const sheetActions=el('div','booth-pe-sheet-actions');
    const sheetApply=button('booth-pe-apply','바꾸기');
    const sheetCancel=button('booth-pe-cancel','취소');
    sheetActions.append(sheetApply,sheetCancel);
    sheetCard.append(sheetLabel,sheetArea,sheetActions);
    sheet.append(sheetCard);
    doc.body.append(sheet);

    function selBox(){
      return st.sel&&st.sel.box&&st.sel.box.isConnected?st.sel.box:null;
    }
    function closePop(refocus){
      if(st.sel&&st.sel.box) st.sel.box.remove();
      st.sel=null;
      pop.hidden=true;
      syncTyping();
      if(refocus){try{stage.focus({preventScroll:true});}catch{}}
    }
    function closeSheet(refocus){
      if(st.sheet&&Array.isArray(st.sheet.boxes)) for(const b of st.sheet.boxes) b.remove();
      st.sheet=null;
      sheet.hidden=true;
      sheet.style.paddingBottom='';
      syncTyping();
      if(refocus){try{stage.focus({preventScroll:true});}catch{}}
    }
    function bounds(){
      const dock=doc.getElementById('booth-dock');
      const dockTop=dock&&dock.offsetParent!==null?dock.getBoundingClientRect().top:root.innerHeight;
      return {left:8,top:8,right:(root.innerWidth||360)-8,bottom:Math.min(root.innerHeight||640,dockTop)-8};
    }
    const barMode=touch;
    function placeBar(){
      const inset=keyboardInset(root.innerHeight||0,root.visualViewport);
      pop.style.left='';
      pop.style.top='';
      pop.style.width='';
      pop.style.bottom=inset+'px';
      if(desk()){
        const canvas=stage.querySelector(':scope>.paper-page>canvas');
        const column=(canvas||stage).getBoundingClientRect();
        pop.style.left=Math.round(column.left)+'px';
        pop.style.width=Math.round(column.width)+'px';
      }
      keepWordVisible();
    }
    function placeSheet(){
      if(sheet.hidden) return;
      const inset=keyboardInset(root.innerHeight||0,root.visualViewport);
      sheet.style.paddingBottom=inset>0?inset+'px':'';
    }
    function keepWordVisible(){
      const box=selBox();
      if(!box||pop.hidden) return;
      const r=box.getBoundingClientRect();
      const barTop=pop.getBoundingClientRect().top;
      const vvTop=root.visualViewport?root.visualViewport.offsetTop:0;
      const below=r.bottom-(barTop-12);
      const above=(vvTop+8)-r.top;
      if(below>0) panBy(below);
      else if(above>0) panBy(-above);
    }
    function panBy(dy){
      const inside=zoomed()?stage:null;
      let left=dy;
      if(inside){
        const before=inside.scrollTop;
        inside.scrollTop=before+dy;
        left=dy-(inside.scrollTop-before);
      }
      if(Math.abs(left)>0.5) root.scrollBy(0,left);
    }
    function placeAnchored(){
      const box=selBox();
      if(!box) return;
      const spot=placePopover(box.getBoundingClientRect(),{w:pop.offsetWidth,h:pop.offsetHeight},bounds());
      pop.style.bottom='';
      pop.style.left=Math.round(spot.left)+'px';
      pop.style.top=Math.round(spot.top)+'px';
      pop.classList.toggle('above',spot.above);
    }
    function placePop(){
      placeSheet();
      if(pop.hidden) return;
      pop.classList.toggle('is-bar',barMode());
      if(barMode()) placeBar(); else placeAnchored();
    }
    function makeRoom(box){
      const anchor=box.getBoundingClientRect();
      const limit=bounds();
      const need=anchor.bottom+8+pop.offsetHeight-limit.bottom;
      const spare=anchor.top-limit.top-56;
      if(need>0&&spare>0) root.scrollBy(0,Math.min(need,spare));
    }

    /* ---------- hit testing on the text layer ---------- */
    function spansOf(page){
      return [...page.querySelectorAll('.paper-text-layer span[data-i]')].filter(span=>span.textContent.trim());
    }
    function ordered(page){
      return spansOf(page).sort((a,b)=>Number(a.dataset.i)-Number(b.dataset.i));
    }
    function distance(r, x, y){
      const dx=x<r.left?r.left-x:(x>r.right?x-r.right:0);
      const dy=y<r.top?r.top-y:(y>r.bottom?y-r.bottom:0);
      return Math.hypot(dx,dy);
    }
    function spanAt(spans, x, y, snap){
      let best=null;
      for(const span of spans){
        const r=span.getBoundingClientRect();
        const d=distance(r,x,y);
        if(d>Math.max(snap,r.height*0.35)) continue;
        if(!best||d<best.d||(d===best.d&&r.width*r.height<best.area)) best={span,d,area:r.width*r.height};
      }
      return best&&best.span;
    }
    function textNodes(span){
      const out=[];
      const walk=node=>{for(const kid of node.childNodes){if(kid.nodeType===3) out.push(kid); else walk(kid);}};
      walk(span);
      return out;
    }
    function rangeFor(span, start, end){
      const range=doc.createRange();
      let at=0;
      let started=false;
      for(const node of textNodes(span)){
        const len=node.nodeValue.length;
        if(!started&&start<=at+len){range.setStart(node,start-at);started=true;}
        if(started&&end<=at+len){range.setEnd(node,end-at);return range;}
        at+=len;
      }
      return started?range:null;
    }
    function charAt(span, x){
      const text=span.textContent;
      let best=0;
      let gap=Infinity;
      for(let i=0;i<text.length;i+=1){
        const range=rangeFor(span,i,i+1);
        if(!range) continue;
        const r=range.getBoundingClientRect();
        const d=x<r.left?r.left-x:(x>r.right?x-r.right:0);
        if(d<gap){gap=d;best=i;}
        if(d===0) break;
      }
      return best;
    }
    /* A short, isolated span (a table cell such as "GPT Score") is taken whole. */
    function cellRange(span, spans){
      const text=span.textContent;
      const trimmed=text.trim();
      if(trimmed.length>24||trimmed.split(/\s+/).length>3) return null;
      const r=span.getBoundingClientRect();
      const mid=(r.top+r.bottom)/2;
      const reach=r.height*0.8;
      const near=spans.some(other=>{
        if(other===span) return false;
        const q=other.getBoundingClientRect();
        if(Math.abs((q.top+q.bottom)/2-mid)>r.height/2) return false;
        return Math.abs(q.left-r.right)<reach||Math.abs(r.left-q.right)<reach;
      });
      if(near) return null;
      const start=text.indexOf(trimmed);
      return {start,end:start+trimmed.length};
    }
    function fraction(r, page){
      const box=page.getBoundingClientRect();
      if(!(box.width>0&&box.height>0)) return {x:0,y:0,w:0,h:0};
      return clampRect({x:(r.left-box.left)/box.width,y:(r.top-box.top)/box.height,w:(r.right-r.left)/box.width,h:(r.bottom-r.top)/box.height});
    }
    function makeWord(page, span, token){
      const range=token&&rangeFor(span,token.start,token.end);
      if(!range) return null;
      const line=span.getBoundingClientRect();
      const raw=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);
      const list=raw.length?raw:[range.getBoundingClientRect()].filter(r=>r.width>0&&r.height>0);
      /* Keep horizontal bounds from Range.getClientRects() and clamp vertical bounds to the pdf.js
         span's line-height:1 box so fallback font leading never spills into neighbouring lines. */
      const rects=list.map(r=>fraction({
        left:r.left,right:r.right,
        top:line.height>0?line.top:r.top,
        bottom:line.height>0?line.bottom:r.bottom
      },page)).filter(r=>r.w>0&&r.h>0);
      if(!rects.length) return null;
      return {span,token,text:span.textContent.slice(token.start,token.end),rect:rectUnion(rects),rects};
    }
    function wordAt(page, x, y){
      const spans=ordered(page);
      const span=spanAt(spans,x,y,touch()?24:3);
      if(!span) return null;
      const token=cellRange(span,spans)||tokenAt(span.textContent,charAt(span,x));
      return makeWord(page,span,token);
    }
    function pageWords(page){
      const out=[];
      for(const span of ordered(page)) for(const token of tokensIn(span.textContent)) out.push({span,token});
      return out;
    }
    function spanItems(page){
      const cs=typeof root.getComputedStyle==='function'?root.getComputedStyle.bind(root):null;
      return ordered(page).map(span=>({
        span,
        text:span.textContent,
        rect:fraction(span.getBoundingClientRect(),page),
        fontSize:cs?parseFloat(cs(span).fontSize)||0:0
      })).filter(item=>item.rect.w>0&&item.rect.h>0);
    }

    /* ---------- stateless, store-driven overlay preview ---------- */
    function paintEditOverlay(page, edit, box, layer){
      const lines=edit.newText===''?[]:edit.newText.split('\n');
      const count=edit.rects.length;
      edit.rects.forEach((r,i)=>{
        const node=el('div','booth-patch');
        node.dataset.editId=edit.id;
        node.dataset.pageIndex=String(edit.pageIndex);
        node.setAttribute('aria-hidden','true');
        node.setAttribute('translate','no');
        Object.assign(node.style,{
          left:r.x*100+'%',top:r.y*100+'%',width:r.w*100+'%',height:r.h*100+'%'
        });
        let text='';
        let multi=false;
        if(lines.length){
          if(i<count-1){
            text=i<lines.length?lines[i]:'';
          }else if(i<lines.length){
            const rest=lines.slice(i);
            text=rest.join('\n');
            multi=rest.length>1;
          }
        }
        if(text){
          const span=el('span',multi?'booth-patch-text is-multi':'booth-patch-text',text);
          const pxH=r.h*box.height;
          span.style.fontFamily=SERIF;
          span.style.fontSize=Math.max(4,pxH*0.88)+'px';
          span.style.lineHeight=Math.max(4,pxH)+'px';
          node.append(span);
          if(layer) page.insertBefore(node,layer); else page.append(node);
          if(!multi){
            const need=span.getBoundingClientRect().width;
            const have=r.w*box.width;
            if(need>have&&have>0) span.style.transform='scaleX('+Math.max(MIN_SCALE_X,have/need)+')';
          }
        }else{
          if(layer) page.insertBefore(node,layer); else page.append(node);
        }
      });
    }
    function renderOverlays(page, pageIndex){
      if(!page) return;
      for(const node of [...page.querySelectorAll('.booth-patch')]) node.remove();
      const api=store();
      if(!api||!Number.isInteger(pageIndex)) return;
      const edits=api.forPage(pageIndex);
      if(!edits.length) return;
      const box=page.getBoundingClientRect();
      if(!(box.width>0&&box.height>0)) return;
      const layer=page.querySelector('.paper-text-layer');
      for(const edit of edits) paintEditOverlay(page,edit,box,layer);
    }
    function repaintCurrent(){
      const page=pageEl();
      const pageIndex=call('getPageIndex');
      if(page&&Number.isInteger(pageIndex)) renderOverlays(page,pageIndex);
    }

    /* ---------- selection, popover and paragraph sheet ---------- */
    function outline(page, rect, className){
      const box=el('div',className||'booth-pe-sel');
      box.setAttribute('aria-hidden','true');
      Object.assign(box.style,{left:rect.x*100+'%',top:rect.y*100+'%',width:rect.w*100+'%',height:rect.h*100+'%'});
      page.append(box);
      return box;
    }
    function isBlockEdit(edit){
      return !!(edit&&(edit.source==='paragraph'||edit.rects.length>1||edit.originalText.includes('\n')||edit.newText.includes('\n')));
    }
    function openPop(page, pageIndex, word, existing){
      closeSheet(false);
      closePop(false);
      const rect=existing?rectUnion(existing.rects):word.rect;
      st.sel={pageIndex,page,word,existing:existing||null,rect,box:outline(page,rect)};
      label.textContent=(pageIndex+1)+'쪽 · '+(existing?'고친 글자 · 원문 '+existing.originalText:'이 글자 고치기');
      input.value=existing?existing.newText:word.text;
      input.setAttribute('inputmode',numericToken(input.value)?'decimal':'text');
      whole.disabled=false;
      revert.hidden=!existing;
      pop.classList.toggle('has-existing',!!existing);
      pop.hidden=false;
      pop.classList.toggle('is-bar',barMode());
      if(!barMode()) makeRoom(st.sel.box);
      placePop();
      try{input.focus({preventScroll:true});input.select();}catch{}
      syncTyping();
      if(barMode()) root.setTimeout(placePop,0);
    }
    function selectWord(page, word){
      const pageIndex=call('getPageIndex');
      if(!word||!Number.isInteger(pageIndex)) return;
      const api=store();
      const existing=api?api.at(pageIndex,word.rect.x+word.rect.w/2,word.rect.y+word.rect.h/2):null;
      if(existing&&isBlockEdit(existing)){openParagraphSheet(page,pageIndex,word,existing);return;}
      openPop(page,pageIndex,word,existing);
    }
    function step(delta){
      const sel=st.sel;
      if(!sel||!sel.word) return;
      const words=pageWords(sel.page);
      const at=words.findIndex(w=>w.span===sel.word.span&&w.token.start===sel.word.token.start);
      const target=words[at+delta];
      if(!target) return;
      const word=makeWord(sel.page,target.span,target.token);
      if(!word) return;
      revealInStage(word);
      selectWord(sel.page,makeWord(sel.page,target.span,target.token));
    }
    function revealInStage(word){
      if(!word||!zoomed()) return;
      const page=word.span.closest('.paper-page');
      const box=page.getBoundingClientRect();
      const x=word.rect.x*box.width;
      if(x<stage.scrollLeft+8||x+word.rect.w*box.width>stage.scrollLeft+stage.clientWidth-8) stage.scrollLeft=Math.max(0,x-stage.clientWidth/3);
    }
    function revertPop(){
      const sel=st.sel;
      const api=store();
      if(!sel||!sel.existing||!api) return;
      api.remove(sel.existing.id);
      closePop(true);
    }
    function commitPop(){
      const sel=st.sel;
      const api=store();
      if(!sel||!api) return;
      const value=input.value;
      if(sel.existing){
        if(value===sel.existing.newText){closePop(true);return;}
        api.update(sel.existing.id,value);
        closePop(true);
        return;
      }
      if(value===sel.word.text){closePop(true);return;}
      api.add({pageIndex:sel.pageIndex,rects:sel.word.rects,originalText:sel.word.text,newText:value,source:'tap'});
      closePop(true);
    }
    function openParagraphSheet(page, pageIndex, word, existing){
      closePop(false);
      closeSheet(false);
      const items=spanItems(page);
      let blockLines=[];
      if(word&&word.span){
        const idx=items.findIndex(item=>item.span===word.span);
        blockLines=idx>=0?clusterBlock(items,idx):clusterBlock(items,word.rect);
      }else if(existing&&existing.rects.length){
        blockLines=clusterBlock(items,existing.rects[0]);
      }
      if(!blockLines.length&&existing){
        const origLines=existing.originalText.split('\n');
        blockLines=existing.rects.map((rect,i)=>({text:origLines[i]||'',rect}));
      }
      if(!blockLines.length&&word){
        blockLines=[{text:word.text,rect:word.rect}];
      }
      if(!blockLines.length) return;
      const api=store();
      const pageEdits=api?api.forPage(pageIndex):[];
      const prefill=applyEditsToBlock(blockLines,pageEdits);
      const origText=blockLines.map(l=>l.text).join('\n');
      const boxes=blockLines.map(l=>outline(page,l.rect));
      st.sheet={pageIndex,page,blockLines,pageEdits,origText,prefill,boxes};
      sheetLabel.textContent=(pageIndex+1)+'쪽 · 문단 전체 고치기';
      sheetArea.value=prefill;
      sheet.hidden=false;
      placeSheet();
      syncTyping();
      try{sheetArea.focus({preventScroll:true});}catch{}
    }
    function measureSpanRange(page, part, charStart, charEnd){
      const span=part&&part.span;
      if(!span||!span.isConnected) return null;
      const range=rangeFor(span,charStart,charEnd);
      if(!range) return null;
      const line=span.getBoundingClientRect();
      const raw=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);
      const list=raw.length?raw:[range.getBoundingClientRect()].filter(r=>r.width>0&&r.height>0);
      const rects=list.map(r=>fraction({
        left:r.left,right:r.right,
        top:line.height>0?line.top:r.top,
        bottom:line.height>0?line.bottom:r.bottom
      },page)).filter(r=>r.w>0&&r.h>0);
      return rects.length?rects:null;
    }
    function commitSheet(){
      const cur=st.sheet;
      const api=store();
      if(!cur||!api) return;
      const raw=sheetArea.value.replace(/\r\n?/g,'\n');
      if(raw===cur.prefill){closeSheet(true);return;}
      const plan=commitParagraphChange(cur.blockLines,cur.pageEdits,raw,(part,s,e)=>measureSpanRange(cur.page,part,s,e));
      for(const id of plan.removeIds) api.remove(id);
      if(plan.edit){
        api.add({
          pageIndex:cur.pageIndex,
          rects:plan.edit.rects,
          originalText:plan.edit.originalText,
          newText:plan.edit.newText,
          source:'paragraph'
        });
      }
      closeSheet(true);
    }

    function isPageClickTarget(page, target){
      if(!editing()||!page||!(target instanceof root.Node)||!page.contains(target)) return false;
      return !(target.closest&&target.closest('textarea,.booth-pe-sheet,button,input'));
    }
    function handlePagePoint(page, pageIndex, clientX, clientY){
      if(!desk()&&!zoomed()){zoomAt(page,clientX,clientY);return;}
      const box=page.getBoundingClientRect();
      const px=box.width>0?(clientX-box.left)/box.width:-1;
      const py=box.height>0?(clientY-box.top)/box.height:-1;
      const api=store();
      const hitEdit=api?api.at(pageIndex,px,py):null;
      const word=wordAt(page,clientX,clientY);
      const existing=hitEdit||(word&&api?api.at(pageIndex,word.rect.x+word.rect.w/2,word.rect.y+word.rect.h/2):null);
      if(existing){
        if(isBlockEdit(existing)) openParagraphSheet(page,pageIndex,word,existing);
        else openPop(page,pageIndex,word,existing);
        return;
      }
      if(word) openPop(page,pageIndex,word,null);
    }
    function replayPendingClick(page){
      const pending=st.pendingClick;
      if(!pending||!editing()||!spansOf(page).length) return;
      st.pendingClick=null;
      const pageIndex=call('getPageIndex');
      if(pageIndex!==pending.pageIndex) return;
      const box=page.getBoundingClientRect();
      if(!(box.width>0&&box.height>0)) return;
      handlePagePoint(page,pageIndex,box.left+pending.fx*box.width,box.top+pending.fy*box.height);
    }
    function onPageClick(event){
      const page=pageEl();
      if(!isPageClickTarget(page,event.target)) return;
      event.stopPropagation();
      const pageIndex=call('getPageIndex');
      if(!Number.isInteger(pageIndex)) return;
      if(st.focus){
        if(st.focus.fromButton){
          const box=page.getBoundingClientRect();
          if(box.width>0&&box.height>0){
            st.pendingClick={pageIndex,fx:(event.clientX-box.left)/box.width,fy:(event.clientY-box.top)/box.height};
          }
        }
        return;
      }
      handlePagePoint(page,pageIndex,event.clientX,event.clientY);
    }

    /* ---------- phone tap-zoom and mission hint zoom ---------- */
    function numberPoints(page){
      const box=page.getBoundingClientRect();
      return spansOf(page).filter(span=>numericToken(span.textContent.trim())).map(span=>{
        const r=span.getBoundingClientRect();
        return {x:(r.left+r.right)/2-box.left,y:(r.top+r.bottom)/2-box.top};
      });
    }
    function zoomFor(page, x, y){
      const box=page.getBoundingClientRect();
      const radius=box.width*0.12;
      const near=numberPoints(page).filter(p=>Math.hypot(p.x-(x-box.left),p.y-(y-box.top))<=radius);
      return near.length>=3?TABLE_ZOOM:ZOOM;
    }
    function zoomAt(page, x, y){
      const box=page.getBoundingClientRect();
      if(!(box.width>0&&box.height>0)) return;
      st.focus={fx:(x-box.left)/box.width,fy:(y-box.top)/box.height};
      if(!setZoom(zoomFor(page,x,y))) st.focus=null;
    }
    function applyFocus(page){
      const focus=st.focus;
      st.focus=null;
      if(!focus||!zoomed()){stage.scrollTo(0,0);return;}
      const box=page.getBoundingClientRect();
      if(focus.block){
        stage.scrollLeft=Math.max(0,focus.block.x*box.width);
        stage.scrollTop=Math.max(0,focus.block.y*box.height);
        bar.scrollIntoView({block:'start'});
        return;
      }
      stage.scrollLeft=Math.max(0,focus.fx*box.width-stage.clientWidth/2);
      stage.scrollTop=Math.max(0,focus.fy*box.height-stage.clientHeight/2);
      bar.scrollIntoView({block:'start'});
    }
    function missionHintPaper(){
      const paper=root.FalsifyBoothPaper&&typeof root.FalsifyBoothPaper.current==='function'?root.FalsifyBoothPaper.current():null;
      return paper&&paper.source==='mission'?paper:null;
    }
    function autoZoomTarget(page){
      if(desk()||!editing()||st.autoOff||zoomed()) return null;
      const src=call('getSource');
      const paper=missionHintPaper();
      if(!src||st.auto.has(src.fileHash)||!paper) return null;
      if(call('getPageIndex')!==(paper.pageHint||1)-1) return null;
      const spans=spansOf(page);
      const box=page.getBoundingClientRect();
      return spans.length&&box.width>0&&box.height>0?{src,spans,box}:null;
    }
    function nearNumberRects(spans, box, spot, radius){
      return spans.filter(span=>numericToken(span.textContent.trim()))
        .map(span=>span.getBoundingClientRect())
        .filter(r=>Math.hypot((r.left+r.right)/2-box.left-spot.x,(r.top+r.bottom)/2-box.top-spot.y)<=radius);
    }
    /* A mission opens zoomed on its hint page's number table, once per paper, using text-layer spans only. */
    function autoZoom(page){
      const ctx=autoZoomTarget(page);
      if(!ctx) return;
      const radius=ctx.box.width*0.12;
      const spot=densest(numberPoints(page),radius);
      st.auto.add(ctx.src.fileHash);
      if(!spot||spot.count<3) return;
      const near=nearNumberRects(ctx.spans,ctx.box,spot,radius);
      if(!near.length) return;
      const seed=near.map(r=>fraction(r,page)).reduce((a,b)=>union(a,b));
      const lineH=near.reduce((h,r)=>Math.max(h,r.height),0)/ctx.box.height;
      const block=padRect(hintBlock(spanItems(page),seed,lineH),0.015);
      st.focus={block};
      if(!setZoom(fitZoom(block.w,0,TABLE_ZOOM))) st.focus=null;
    }
    function cancelAutoZoom(event){
      if(!event.isTrusted||!editing()||st.autoOff) return;
      st.autoOff=true;
      const src=call('getSource');
      if(src&&src.fileHash) st.auto.add(src.fileHash);
    }

    /* ---------- desktop hover hairline ---------- */
    function onMove(event){
      if(!desk()||!media('(pointer:fine)')||st.hoverFrame) return;
      const x=event.clientX;
      const y=event.clientY;
      st.hoverFrame=root.requestAnimationFrame(()=>{st.hoverFrame=0;showHover(x,y);});
    }
    function showHover(x, y){
      const page=pageEl();
      const inside=page&&editing()&&sheet.hidden&&distance(page.getBoundingClientRect(),x,y)===0;
      const word=inside?wordAt(page,x,y):null;
      if(!word){hover.remove();return;}
      Object.assign(hover.style,{left:word.rect.x*100+'%',top:word.rect.y*100+'%',width:word.rect.w*100+'%',height:word.rect.h*100+'%'});
      if(hover.parentNode!==page) page.append(hover);
    }

    /* ---------- lifecycle ---------- */
    let refitTimer=0;
    function refit(){
      root.clearTimeout(refitTimer);
      refitTimer=root.setTimeout(()=>{
        const canvas=stage.querySelector(':scope>.paper-page>canvas');
        if(!canvas||zoomed()||!sheet.hidden) return;
        if(Math.abs(canvas.getBoundingClientRect().width-stage.clientWidth)>2) call('setZoom',Number(call('getZoom'))||1,true);
      },150);
    }
    function syncTyping(){
      const active=doc.activeElement;
      const typing=(!pop.hidden&&barMode())||!sheet.hidden||!!(active&&active.matches&&active.matches('input[type="text"],input:not([type]),input[type="search"],textarea'));
      html.classList.toggle('booth-pe-typing',typing&&touch());
    }
    function onSource(event){
      const hash=event&&event.detail&&event.detail.fileHash||'';
      if(hash===st.fileHash) return;
      st.fileHash=hash;
      st.pendingClick=null;
      closePop(false);
      closeSheet(false);
      repaintCurrent();
    }
    function onClear(){
      st.pendingClick=null;
      closePop(false);
      closeSheet(false);
      repaintCurrent();
    }
    function onPage(page){
      st.pageEl=page;
      const layer=page.querySelector('.paper-text-layer');
      if(layer){
        if(!layer.hasAttribute('lang')) layer.setAttribute('lang','');
        layer.setAttribute('translate','no');
      }
      closePop(false);
      closeSheet(false);
      syncBar();
      if(!editing()&&zoomed()) setZoom(1);
      const pageIndex=call('getPageIndex');
      if(Number.isInteger(pageIndex)) renderOverlays(page,pageIndex);
      applyFocus(page);
      autoZoom(page);
      replayPendingClick(page);
    }
    function onMutate(){
      const page=pageEl();
      if(page&&page!==st.pageEl) onPage(page);
      else if(page&&spansOf(page).length){
        autoZoom(page);
        replayPendingClick(page);
      }
    }
    function onStep(){
      if(editing()){const page=pageEl();if(page) autoZoom(page);return;}
      st.autoOff=false;
      st.pendingClick=null;
      closePop(false);
      closeSheet(false);
      if(zoomed()) setZoom(1);
    }
    function onDown(event){
      if(pop.hidden) return;
      const target=event.target;
      if(pop.contains(target)) return;
      const page=pageEl();
      if(page&&page.contains(target)) return;
      closePop(false);
    }
    function onKey(event){
      if(event.isComposing||st.composing||event.keyCode===229) return;
      if(event.key==='Enter'){event.preventDefault();commitPop();}
      else if(event.key==='Escape'){event.preventDefault();closePop(true);}
    }
    function onSheetKey(event){
      if(event.isComposing||st.composing||event.keyCode===229) return;
      if(event.key==='Escape'){event.preventDefault();closeSheet(true);}
      else if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();commitSheet();}
    }

    apply.addEventListener('click',commitPop);
    revert.addEventListener('click',revertPop);
    whole.addEventListener('click',()=>{
      const sel=st.sel;
      if(!sel) return;
      openParagraphSheet(sel.page,sel.pageIndex,sel.word,sel.existing);
    });
    cancel.addEventListener('click',()=>closePop(true));
    prev.addEventListener('click',()=>step(-1));
    next.addEventListener('click',()=>step(1));
    for(const node of [prev,next,apply,revert]) node.addEventListener('pointerdown',event=>event.preventDefault());
    input.addEventListener('keydown',onKey);
    input.addEventListener('compositionstart',()=>{st.composing=true;});
    input.addEventListener('compositionend',()=>{st.composing=false;});
    input.addEventListener('focus',()=>{try{input.select();}catch{}});
    sheetApply.addEventListener('click',commitSheet);
    sheetCancel.addEventListener('click',()=>closeSheet(true));
    sheet.addEventListener('click',event=>{if(event.target===sheet) closeSheet(true);});
    sheetArea.addEventListener('keydown',onSheetKey);
    sheetArea.addEventListener('compositionstart',()=>{st.composing=true;});
    sheetArea.addEventListener('compositionend',()=>{st.composing=false;});
    doc.addEventListener('click',onPageClick,true);
    doc.addEventListener('pointerdown',onDown,true);
    for(const kind of ['pointerdown','keydown','wheel']) doc.addEventListener(kind,cancelAutoZoom,{capture:true,passive:true});
    doc.addEventListener('mousemove',onMove,{passive:true});
    doc.addEventListener('focusin',syncTyping);
    doc.addEventListener('focusout',()=>root.setTimeout(syncTyping,0));
    doc.addEventListener('falsify:paper-workspace-source',onSource);
    doc.addEventListener('falsify:document-clear',onClear);
    stage.addEventListener('scroll',()=>{if(!barMode()) placePop();},{passive:true});
    root.addEventListener('scroll',()=>{if(!barMode()) placePop();},{passive:true});
    root.addEventListener('resize',()=>{placeTools();if(desk()&&zoomed()&&!coarse()) setZoom(1);placePop();repaintCurrent();refit();});
    if(root.visualViewport){
      root.visualViewport.addEventListener('resize',placePop);
      root.visualViewport.addEventListener('scroll',placePop);
    }
    const api=store();
    if(api&&typeof api.subscribe==='function') api.subscribe(()=>repaintCurrent());
    const Observer=root.MutationObserver;
    if(typeof Observer==='function'){
      new Observer(onMutate).observe(stage,{childList:true,subtree:true});
      new Observer(onStep).observe(html,{attributes:true,attributeFilter:['data-booth-step']});
    }
    placeTools();
    syncBar();
    onMutate();
    return true;
  }

  root.FalsifyBoothPageEdit=Object.freeze({
    tokenAt,tokensIn,numericToken,placePopover,keyboardInset,padRect,overlaps,union,
    densest,hintBlock,fitZoom,detectColumnSplits,groupLines,clusterBlock,
    applyEditsToBlock,applyEditsToBlockWithMap,diffChangedRange,mapRangeToBlockLines,
    changedBlockEdit,commitParagraphChange,
    mount:(targetDoc, opts)=>mount(targetDoc||root.document, opts),
    ZOOM,TABLE_ZOOM
  });
  const doc=root.document;
  if(!doc||typeof doc.getElementById!=='function') return;
  const start=()=>mount(doc);
  if(canMount(doc,false)) start();
  else if(doc.readyState==='loading') doc.addEventListener('DOMContentLoaded',start);
  else root.setTimeout(start,0);
})(typeof window==='object'?window:globalThis);
