/* Event-page in-place editing (simplify/tap): the paper page itself is the editor. event.html only.
   Every edit is stored in FalsifyBoothEdits ({pageIndex, rects, originalText, newText, source}).
   A tap on a text-layer token captures Range.getClientRects() as page fractions and opens a small
   popover (mouse) or bottom edit bar (touch). Tapping an existing edit edits it in place.
   "문단 전체 고치기" is always enabled: it clusters text-layer lines around the tap into a block,
   substitutes existing edits inside that block, opens a simple textarea sheet, and trims unchanged
   leading/trailing lines on commit (deleting everything stores newText '').
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
    const boxes=(Array.isArray(items)?items:[]).map(item=>item&&item.rect).filter(r=>r&&r.w>0&&r.h>0);
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

  /* ---------- line grouping, block clustering and line trim ---------- */
  function midY(r){return r.y+r.h/2;}
  function joinLineSpans(spans){
    let text='';
    for(let i=0;i<spans.length;i+=1){
      const cur=spans[i];
      if(i>0){
        const prev=spans[i-1];
        const gap=cur.rect.x-(prev.rect.x+prev.rect.w);
        const minH=Math.min(prev.rect.h,cur.rect.h);
        if(!/\s$/.test(prev.text)&&!/^\s/.test(cur.text)&&gap>0.15*minH) text+=' ';
      }
      text+=cur.text;
    }
    return text.trim();
  }
  /* Groups span items [{text, rect}] (page fractions) into horizontal line segments [{text, rect, spans}].
     Splits across wide horizontal gutters so two-column baselines never merge into one line. */
  function groupLines(items){
    const valid=(Array.isArray(items)?items:[])
      .map((item,idx)=>item&&item.rect&&typeof item.text==='string'&&item.text.trim()&&item.rect.w>0&&item.rect.h>0
        ?{text:item.text,rect:clampRect(item.rect),index:idx}:null)
      .filter(Boolean);
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
        if(gap>gutter){
          lines.push({text:joinLineSpans(seg),rect:rectUnion(seg.map(s=>s.rect)),spans:seg});
          seg=[cur];
        }else{
          seg.push(cur);
        }
      }
      lines.push({text:joinLineSpans(seg),rect:rectUnion(seg.map(s=>s.rect)),spans:seg});
    }
    lines.sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x);
    return lines;
  }
  /* Clusters text-layer lines around target (item index or fraction rect) into one contiguous block:
     expands up and down across adjacent lines within <=1.6*lineHeight (mid-to-mid) whose x-range
     overlaps the block's column x-range. */
  function clusterBlock(items, target){
    const lines=groupLines(items);
    if(!lines.length) return [];
    let seedIdx=-1;
    if(typeof target==='number'){
      seedIdx=lines.findIndex(line=>line.spans.some(s=>s.index===target));
    }else if(target&&typeof target==='object'){
      let bestDist=Infinity;
      const cx=target.x+(target.w||0)/2;
      const cy=target.y+(target.h||0)/2;
      lines.forEach((line,i)=>{
        if(overlaps(line.rect,target)){
          const d=Math.hypot(line.rect.x+line.rect.w/2-cx,midY(line.rect)-cy);
          if(seedIdx<0||d<bestDist){seedIdx=i;bestDist=d;}
        }
      });
      if(seedIdx<0){
        lines.forEach((line,i)=>{
          const d=Math.hypot(line.rect.x+line.rect.w/2-cx,midY(line.rect)-cy);
          if(d<bestDist){seedIdx=i;bestDist=d;}
        });
      }
    }
    if(seedIdx<0) return [];
    const picked=new Set([seedIdx]);
    let colLeft=lines[seedIdx].rect.x;
    let colRight=lines[seedIdx].rect.x+lines[seedIdx].rect.w;
    let topLine=lines[seedIdx];
    let botLine=lines[seedIdx];
    for(let changed=true;changed;){
      changed=false;
      let bestAbove=-1;
      let bestBelow=-1;
      for(let i=0;i<lines.length;i+=1){
        if(picked.has(i)) continue;
        const cand=lines[i];
        if(!(cand.rect.x<colRight&&colLeft<cand.rect.x+cand.rect.w)) continue;
        if(cand.rect.y<topLine.rect.y){
          const lineH=Math.max(cand.rect.h,topLine.rect.h);
          const step=midY(topLine.rect)-midY(cand.rect);
          const gap=topLine.rect.y-(cand.rect.y+cand.rect.h);
          if(step<=1.65*lineH&&gap<=0.8*lineH&&(bestAbove<0||cand.rect.y>lines[bestAbove].rect.y)) bestAbove=i;
        }else if(cand.rect.y>botLine.rect.y){
          const lineH=Math.max(cand.rect.h,botLine.rect.h);
          const step=midY(cand.rect)-midY(botLine.rect);
          const gap=cand.rect.y-(botLine.rect.y+botLine.rect.h);
          if(step<=1.65*lineH&&gap<=0.8*lineH&&(bestBelow<0||cand.rect.y<lines[bestBelow].rect.y)) bestBelow=i;
        }
      }
      for(const idx of [bestAbove,bestBelow]){
        if(idx<0) continue;
        picked.add(idx);
        const r=lines[idx].rect;
        colLeft=Math.min(colLeft,r.x);
        colRight=Math.max(colRight,r.x+r.w);
        if(r.y<topLine.rect.y) topLine=lines[idx];
        if(r.y>botLine.rect.y) botLine=lines[idx];
        changed=true;
      }
    }
    return [...picked].map(i=>lines[i]).sort((a,b)=>a.rect.y-b.rect.y||a.rect.x-b.rect.x);
  }
  /* Vertical overlap strictly greater than 40% of the shorter box: avoids grazing adjacent lines. */
  function sameLineBand(a, b){
    if(!overlaps(a,b)) return false;
    const vh=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
    return vh>0.4*Math.min(a.h,b.h);
  }
  /* Substitutes the newText of existing BoothEdits that overlap blockLines into the prefilled block text. */
  function applyEditsToBlock(blockLines, edits){
    if(!Array.isArray(blockLines)||!blockLines.length) return '';
    const out=blockLines.map(l=>l.text);
    const inline=blockLines.map(()=>[]);
    for(const edit of Array.isArray(edits)?edits:[]){
      if(!edit||!Array.isArray(edit.rects)||!edit.rects.length) continue;
      const hits=[];
      for(let i=0;i<blockLines.length;i+=1){
        if(edit.rects.some(r=>sameLineBand(r,blockLines[i].rect))) hits.push(i);
      }
      if(!hits.length) continue;
      const whole=hits.length>1||String(edit.originalText||'').includes('\n')||String(edit.newText||'').includes('\n')
        ||edit.originalText===blockLines[hits[0]].text;
      if(whole){
        out[hits[0]]=edit.newText===''?null:String(edit.newText);
        for(let k=hits[0]+1;k<=hits[hits.length-1];k+=1) out[k]=null;
      }else{
        inline[hits[0]].push(edit);
      }
    }
    for(let i=0;i<blockLines.length;i+=1){
      if(out[i]==null||!inline[i].length) continue;
      const sorted=inline[i].slice().sort((a,b)=>b.rects[0].x-a.rects[0].x);
      let text=out[i];
      let limit=text.length;
      const lineR=blockLines[i].rect;
      const origLen=blockLines[i].text.length;
      for(const edit of sorted){
        const needle=String(edit.originalText||'');
        if(!needle) continue;
        const approx=lineR.w>0?Math.round(((edit.rects[0].x-lineR.x)/lineR.w)*origLen):0;
        let best=-1;
        for(let at=text.indexOf(needle);at>=0&&at+needle.length<=limit;at=text.indexOf(needle,at+1)){
          if(best<0||Math.abs(at-approx)<Math.abs(best-approx)) best=at;
        }
        if(best>=0){
          text=text.slice(0,best)+String(edit.newText==null?'':edit.newText)+text.slice(best+needle.length);
          limit=best;
        }
      }
      out[i]=text;
    }
    return out.filter(line=>line!==null).join('\n');
  }
  /* Trims unchanged leading and trailing lines; returns {rects, originalText, newText} or null if unchanged.
     Deleting everything returns all block rects with newText ''. */
  function trimBlockLines(blockLines, newText){
    if(!Array.isArray(blockLines)||!blockLines.length) return null;
    const normalized=String(newText==null?'':newText).replace(/\r\n?/g,'\n');
    const orig=blockLines.map(l=>l.text);
    if(normalized===''||!normalized.trim()){
      return {rects:blockLines.map(l=>l.rect),originalText:orig.join('\n'),newText:''};
    }
    const next=normalized.split('\n');
    let lead=0;
    while(lead<orig.length&&lead<next.length&&orig[lead]===next[lead]) lead+=1;
    let tail=0;
    while(orig.length-1-tail>=lead&&next.length-1-tail>=lead&&orig[orig.length-1-tail]===next[next.length-1-tail]) tail+=1;
    let origEnd=orig.length-tail;
    let nextEnd=next.length-tail;
    if(origEnd===lead&&nextEnd===lead) return null;
    if(origEnd===lead){
      if(tail>0){origEnd+=1;nextEnd+=1;}
      else if(lead>0){lead-=1;}
    }
    return {
      rects:blockLines.slice(lead,origEnd).map(l=>l.rect),
      originalText:orig.slice(lead,origEnd).join('\n'),
      newText:next.slice(lead,nextEnd).join('\n')
    };
  }

  /* ---------- page edit UI ---------- */
  function mount(doc){
    const stage=doc.getElementById('paper-before-stage');
    if(!stage||!doc.getElementById('booth-step-edit')||doc.getElementById('booth-pe-bar')) return;
    const html=doc.documentElement;
    const st={sel:null,sheet:null,focus:null,fileHash:'',pageEl:null,auto:new Set(),autoOff:false,composing:false,hoverFrame:0};
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
    function syncBar(){
      const on=zoomed();
      html.classList.toggle('booth-pe-zoomed',on);
      fit.hidden=!on;
      const z=Number(call('getZoom'))||1;
      const levels=zoomLevels();
      zoomOut.disabled=z<=levels[0]+0.01;
      zoomIn.disabled=z>=levels[levels.length-1]-0.01;
      tip.textContent=on?'고칠 숫자나 단어를 눌러 주세요.':'고칠 곳을 누르면 크게 보여요.';
    }
    function setZoom(factor){
      const ok=call('setZoom',factor)===true;
      syncBar();
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
      st.focus={fx:(cx-box.left)/box.width,fy:(cy-box.top)/box.height};
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
    const cancel=button('booth-pe-cancel','취소');
    const prev=button('booth-pe-step booth-pe-prev','‹','앞 단어');
    const next=button('booth-pe-step booth-pe-next','›','다음 단어');
    pop.append(label,prev,input,next,apply,whole,cancel);
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
      return ordered(page).map(span=>({span,text:span.textContent,rect:fraction(span.getBoundingClientRect(),page)}))
        .filter(item=>item.rect.w>0&&item.rect.h>0);
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
      st.sheet={pageIndex,page,blockLines,origText,prefill,boxes};
      sheetLabel.textContent=(pageIndex+1)+'쪽 · 문단 전체 고치기';
      sheetArea.value=prefill;
      sheet.hidden=false;
      placeSheet();
      syncTyping();
      try{sheetArea.focus({preventScroll:true});}catch{}
    }
    function commitSheet(){
      const cur=st.sheet;
      const api=store();
      if(!cur||!api) return;
      const raw=sheetArea.value.replace(/\r\n?/g,'\n');
      if(raw===cur.prefill){closeSheet(true);return;}
      const trimmed=trimBlockLines(cur.blockLines,raw);
      if(!trimmed){
        /* Reverted back to original block text: remove any existing edits inside this block. */
        api.add({pageIndex:cur.pageIndex,rects:cur.blockLines.map(l=>l.rect),originalText:cur.origText,newText:cur.origText,source:'paragraph'});
        closeSheet(true);
        return;
      }
      /* If a trimmed line reverted an earlier edit back to original text, remove that earlier edit too. */
      const kept=new Set(trimmed.rects);
      const trimmedRects=cur.blockLines.map(l=>l.rect).filter(r=>!kept.has(r));
      if(trimmedRects.length){
        for(const existing of api.forPage(cur.pageIndex)){
          if(existing.rects.some(r=>trimmedRects.some(t=>sameLineBand(r,t)))) api.remove(existing.id);
        }
      }
      api.add({pageIndex:cur.pageIndex,rects:trimmed.rects,originalText:trimmed.originalText,newText:trimmed.newText,source:'paragraph'});
      closeSheet(true);
    }

    function onPageClick(event){
      const page=pageEl();
      const target=event.target;
      if(!editing()||!page||!(target instanceof root.Node)||!page.contains(target)) return;
      if(target.closest&&target.closest('textarea,.booth-pe-sheet,button,input')) return;
      event.stopPropagation();
      if(st.focus) return;
      if(!desk()&&!zoomed()){zoomAt(page,event.clientX,event.clientY);return;}
      const pageIndex=call('getPageIndex');
      if(!Number.isInteger(pageIndex)) return;
      const box=page.getBoundingClientRect();
      const px=box.width>0?(event.clientX-box.left)/box.width:-1;
      const py=box.height>0?(event.clientY-box.top)/box.height:-1;
      const api=store();
      const hitEdit=api?api.at(pageIndex,px,py):null;
      const word=wordAt(page,event.clientX,event.clientY);
      const existing=hitEdit||(word&&api?api.at(pageIndex,word.rect.x+word.rect.w/2,word.rect.y+word.rect.h/2):null);
      if(existing){
        if(isBlockEdit(existing)) openParagraphSheet(page,pageIndex,word,existing);
        else openPop(page,pageIndex,word,existing);
        return;
      }
      if(word) openPop(page,pageIndex,word,null);
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
    /* A mission opens zoomed on its hint page's number table, once per paper, using text-layer spans only. */
    function autoZoom(page){
      const src=call('getSource');
      const paper=root.FalsifyBoothPaper&&typeof root.FalsifyBoothPaper.current==='function'?root.FalsifyBoothPaper.current():null;
      if(desk()||!editing()||st.autoOff||zoomed()||!src||st.auto.has(src.fileHash)||!paper||paper.source!=='mission') return;
      if(call('getPageIndex')!==(paper.pageHint||1)-1) return;
      const spans=spansOf(page);
      if(!spans.length) return;
      const box=page.getBoundingClientRect();
      if(!(box.width>0&&box.height>0)) return;
      const radius=box.width*0.12;
      const spot=densest(numberPoints(page),radius);
      st.auto.add(src.fileHash);
      if(!spot||spot.count<3) return;
      const near=spans.filter(span=>numericToken(span.textContent.trim())).map(span=>span.getBoundingClientRect())
        .filter(r=>Math.hypot((r.left+r.right)/2-box.left-spot.x,(r.top+r.bottom)/2-box.top-spot.y)<=radius);
      if(!near.length) return;
      const seed=near.map(r=>fraction(r,page)).reduce((a,b)=>union(a,b));
      const items=spanItems(page);
      const lineH=near.reduce((h,r)=>Math.max(h,r.height),0)/box.height;
      const block=padRect(hintBlock(items,seed,lineH),0.015);
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
      closePop(false);
      closeSheet(false);
      repaintCurrent();
    }
    function onClear(){
      closePop(false);
      closeSheet(false);
      repaintCurrent();
    }
    function onPage(page){
      st.pageEl=page;
      closePop(false);
      closeSheet(false);
      syncBar();
      if(!editing()&&zoomed()) setZoom(1);
      const pageIndex=call('getPageIndex');
      if(Number.isInteger(pageIndex)) renderOverlays(page,pageIndex);
      applyFocus(page);
      autoZoom(page);
    }
    function onMutate(){
      const page=pageEl();
      if(page&&page!==st.pageEl) onPage(page);
      else if(page){
        if(spansOf(page).length) autoZoom(page);
      }
    }
    function onStep(){
      if(editing()){const page=pageEl();if(page) autoZoom(page);return;}
      st.autoOff=false;
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
    whole.addEventListener('click',()=>{
      const sel=st.sel;
      if(!sel) return;
      openParagraphSheet(sel.page,sel.pageIndex,sel.word,sel.existing);
    });
    cancel.addEventListener('click',()=>closePop(true));
    prev.addEventListener('click',()=>step(-1));
    next.addEventListener('click',()=>step(1));
    for(const node of [prev,next,apply]) node.addEventListener('pointerdown',event=>event.preventDefault());
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
  }

  root.FalsifyBoothPageEdit=Object.freeze({
    tokenAt,tokensIn,numericToken,placePopover,keyboardInset,padRect,overlaps,union,
    densest,hintBlock,fitZoom,groupLines,clusterBlock,applyEditsToBlock,trimBlockLines,
    ZOOM,TABLE_ZOOM
  });
  const doc=root.document;
  if(!doc||typeof doc.getElementById!=='function') return;
  const start=()=>mount(doc);
  if(doc.getElementById('booth-step-edit')) start();
  else if(doc.readyState==='loading') doc.addEventListener('DOMContentLoaded',start);
  else root.setTimeout(start,0);
})(typeof window==='object'?window:globalThis);
