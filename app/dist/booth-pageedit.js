/* Event-page in-place editing (alpha.88): the paper page itself is the editor. event.html only.
   A tap on a word of the drawn page (phones: first a 2.5x zoom around the tap, in a pannable box)
   selects that whole token from the PDF text layer, outlines it and opens a small popover with the
   word, 바꾸기, 문단 전체 고치기 and 취소. The tapped token is mapped by position into its paragraph text
   (spotIn: text layer and paragraph text lined up character by character), so a repeated word is never
   ambiguous; a word re-edited or next to an earlier edit updates that edit. 바꾸기 then
   commits it through FalsifyBoothRecipe.applyFound, the same confirmed acceptProposals path as
   find-and-replace and recipes, so #paper-edits, the dock and 다음 treat it like any other edit.
   The new text is painted over the old glyphs with FalsifyBoothPatch (booth-patch.js; a plain
   fallback stands in while that file is absent) and the patch follows the edit: repainted on every
   page draw, removed when the edit is deleted or changed. 문단 전체 고치기 opens the workspace's own
   direct editor for that paragraph, shown as a paper sheet with a sharp crop of the paragraph.
   globalThis.FalsifyBoothPageEdit exposes the pure helpers for tests. DOM text uses textContent only. */
(function(root){
  'use strict';
  const ZOOM=2.5;
  const TABLE_ZOOM=3.5;
  const DESK='(min-width:1024px)';
  const LEAD=/^[(\[{"'“‘]+/;
  const TAIL=/[)\]}"'”’,;:.!?]+$/;
  const SPACE=/\s/;
  const CTX=40;
  const SERIF='"Times New Roman","Nimbus Roman","Liberation Serif","Noto Serif",serif';
  /* What is left when nothing automatic can be done; each comes with its one-tap action in place. */
  const FAIL_TEXT={
    clash:'앞서 고친 곳과 겹쳐요.',
    clashAct:'앞서 고친 것 지우고 바꾸기',
    outside:'그림이나 머리글 속 글자는 바꿀 수 없어요.',
    no_paper:'논문이 아직 열리지 않았어요.',
    rejected:'바꾸지 못했어요. 「바꾸기」를 한 번 더 눌러 주세요.',
    reopen:'문단 편집이 열리지 않았어요.',
    reopenAct:'다시 열기'
  };
  const HYPHENS=new Set(['-',String.fromCharCode(0x2010),String.fromCharCode(0x2011),String.fromCharCode(0xad)]);

  /* ---------- pure helpers ---------- */
  function nearestInk(text, index){
    if(index>=0&&index<text.length&&!SPACE.test(text[index])) return index;
    for(let d=1;d<text.length;d+=1){
      if(index-d>=0&&index-d<text.length&&!SPACE.test(text[index-d])) return index-d;
      if(index+d<text.length&&index+d>=0&&!SPACE.test(text[index+d])) return index+d;
    }
    return -1;
  }
  /* The whitespace-delimited token around index, without wrapping brackets, quotes or trailing
     sentence punctuation ("0.95," -> "0.95", "(43%)" -> "43%"). {start, end} or null. */
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
  /* Up to CTX characters either side of [start, end) in the joined neighbour text. */
  function contextWindow(parts, index, start, end){
    let offset=0;
    for(let i=0;i<index;i+=1) offset+=parts[i].length+1;
    const joined=parts.join(' ');
    const from=offset+start;
    const to=offset+end;
    return joined.slice(Math.max(0,from-CTX),Math.min(joined.length,to+CTX));
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
  /* The crop's CSS size: the paragraph's aspect, as wide as allowed, never taller than maxH. */
  function fitCrop(rect, pageAspect, maxW, maxH){
    if(!(rect&&rect.w>0&&rect.h>0&&pageAspect>0&&maxW>0&&maxH>0)) return null;
    const ratio=rect.h*pageAspect/rect.w;
    let w=maxW;
    let h=w*ratio;
    if(h>maxH){h=maxH;w=h/ratio;}
    return {w:Math.max(1,Math.round(w)),h:Math.max(1,Math.round(h))};
  }
  function overlapShare(a, b){
    const w=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x);
    const h=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
    if(!(w>0&&h>0)) return 0;
    return w*h/Math.min(a.w*a.h,b.w*b.h);
  }
  /* The smallest paragraph box holding the point (page fractions). */
  function paragraphAt(items, x, y){
    let best=null;
    for(const item of Array.isArray(items)?items:[]){
      const r=item&&item.rect;
      if(!r||x<r.x||x>r.x+r.w||y<r.y||y>r.y+r.h) continue;
      if(!best||r.w*r.h<best.rect.w*best.rect.h) best=item;
    }
    return best;
  }
  function padRect(rect, pad){
    const x=Math.max(0,rect.x-pad);
    const y=Math.max(0,rect.y-pad);
    return {x,y,w:Math.min(1,rect.x+rect.w+pad)-x,h:Math.min(1,rect.y+rect.h+pad)-y};
  }

  /* Plain stand-in for booth-patch.js (PE2), used only while FalsifyBoothPatch is absent. */
  function fallbackPatch(doc){
    const specs=new Map();
    const nodes=id=>[...doc.querySelectorAll('.booth-patch')].filter(node=>id==null||node.dataset.patchId===id);
    function draw(pageEl, spec){
      for(const node of nodes(spec.id)) node.remove();
      const box=pageEl.getBoundingClientRect();
      const r=spec.rect;
      const node=doc.createElement('div');
      node.className='booth-patch';
      node.dataset.patchId=spec.id;
      node.setAttribute('aria-hidden','true');
      Object.assign(node.style,{position:'absolute',zIndex:'1',left:r.x*100+'%',top:r.y*100+'%',width:r.w*100+'%',height:r.h*100+'%',
        background:'#fff',pointerEvents:'none',overflow:'visible',whiteSpace:'nowrap',color:'#000',fontFamily:SERIF,
        fontSize:Math.max(4,r.h*box.height*0.9)+'px',lineHeight:r.h*box.height+'px'});
      const text=doc.createElement('span');
      text.textContent=spec.text;
      Object.assign(text.style,{display:'inline-block',transformOrigin:'0 50%'});
      node.append(text);
      const layer=pageEl.querySelector('.paper-text-layer');
      if(layer) pageEl.insertBefore(node,layer); else pageEl.append(node);
      const need=text.getBoundingClientRect().width;
      const have=r.w*box.width;
      if(need>have&&have>0) text.style.transform='scaleX('+Math.max(0.7,have/need)+')';
    }
    return {
      paint(pageEl, spec){specs.set(spec.id,spec);draw(pageEl,spec);},
      remove(id){specs.delete(id);for(const node of nodes(id)) node.remove();},
      clear(){specs.clear();for(const node of nodes()) node.remove();},
      repaint(pageEl, pageIndex){for(const spec of specs.values()) if(spec.pageIndex===pageIndex) draw(pageEl,spec);},
      measure(span){const r=span.getBoundingClientRect();return {fontPx:r.height,baselineFrac:0.8,family:'serif'};}
    };
  }

  /* Digits with . , % or a sign only: the phone keyboard can be the decimal pad. */
  function numericToken(text){
    return typeof text==='string'&&/^[-+−–]?[\d.,%]+$/.test(text)&&/\d/.test(text);
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
  /* The point with the most neighbours within radius (a dense table of numbers). */
  function densest(points, radius){
    let best=null;
    for(const p of Array.isArray(points)?points:[]){
      const count=points.filter(q=>Math.hypot(q.x-p.x,q.y-p.y)<=radius).length;
      if(!best||count>best.count) best={x:p.x,y:p.y,count};
    }
    return best;
  }
  /* ---------- the tapped occurrence in its paragraph text ---------- */
  /* The ink of a text, compared after NFKC (ligatures: fi, fl; superscript digits) and without
     whitespace; at/end give each compared character's span in the original string. */
  function inkChars(text){
    const value=typeof text==='string'?text:'';
    const chars=[];
    const at=[];
    const end=[];
    for(let i=0;i<value.length;){
      const ch=String.fromCodePoint(value.codePointAt(i));
      for(const c of ch.normalize('NFKC')){
        if(SPACE.test(c)) continue;
        chars.push(c);at.push(i);end.push(i+ch.length);
      }
      i+=ch.length;
    }
    return {chars,at,end};
  }
  function resync(a, b, i, j){
    for(let d=1;d<=80;d+=1){
      for(let di=0;di<=d;di+=1){
        const i2=i+di;
        const j2=j+d-di;
        const k=Math.min(4,a.length-i2);
        if(k<=0||j2+k>b.length) continue;
        let same=true;
        for(let n=0;n<k&&same;n+=1) same=a[i2+n]===b[j2+n];
        if(same) return {i:i2,j:j2};
      }
    }
    return null;
  }
  /* Lines two ink sequences up: map[i] is the index in b of a[i], or -1. Line-end hyphens the
     paragraph text joined away and stray characters on either side are skipped. */
  function alignInk(a, b){
    const map=new Array(a.length).fill(-1);
    let i=0;
    let j=0;
    while(i<a.length&&j<b.length){
      if(a[i]===b[j]){map[i]=j;i+=1;j+=1;continue;}
      if(HYPHENS.has(a[i])){i+=1;continue;}
      if(HYPHENS.has(b[j])){j+=1;continue;}
      const next=resync(a,b,i,j);
      if(!next) break;
      i=next.i;
      j=next.j;
    }
    return map;
  }
  /* The tapped token [start, end) of parts[index] (the text-layer spans of one paragraph, in order)
     as an offset range in the paragraph's text. A word hyphenated across lines grows to the whole
     word; join names the other half ({part, char}). null when the token is not in the text. */
  function layerInk(parts){
    const layer={chars:[],part:[],char:[]};
    (Array.isArray(parts)?parts:[]).forEach((part,p)=>{
      const ink=inkChars(part);
      ink.chars.forEach((c,n)=>{layer.chars.push(c);layer.part.push(p);layer.char.push(ink.at[n]);});
    });
    return layer;
  }
  /* A token that ends in (or starts after) a line-end hyphen the paragraph text dropped grows to the whole word. */
  function hyphenJoin(layer, map, mine, index, value, range){
    const dropped=n=>n>=0&&n<map.length&&map[n]<0&&HYPHENS.has(layer.chars[n]);
    const first=mine[0];
    const last=mine[mine.length-1];
    if(dropped(last)&&last+1<layer.chars.length&&layer.part[last+1]!==index){
      while(range.to<value.length&&!SPACE.test(value[range.to])) range.to+=1;
      return {side:'right',part:layer.part[last+1],char:layer.char[last+1]};
    }
    if(dropped(first-1)&&layer.part[first-1]!==index){
      while(range.from>0&&!SPACE.test(value[range.from-1])) range.from-=1;
      return {side:'left',part:layer.part[first-1],char:layer.char[first-1]};
    }
    return null;
  }
  function spotIn(parts, index, start, end, text){
    const layer=layerInk(parts);
    const value=typeof text==='string'?text:'';
    const para=inkChars(value);
    const map=alignInk(layer.chars,para.chars);
    const mine=[];
    layer.chars.forEach((c,n)=>{if(layer.part[n]===index&&layer.char[n]>=start&&layer.char[n]<end) mine.push(n);});
    const hit=mine.filter(n=>map[n]>=0);
    if(!hit.length) return null;
    const range={from:para.at[map[hit[0]]],to:para.end[map[hit[hit.length-1]]]};
    const join=hyphenJoin(layer,map,mine,index,value,range);
    if(join){
      const word=value.slice(range.from,range.to);
      const lead=(LEAD.exec(word)||[''])[0].length;
      const tail=(TAIL.exec(word.slice(lead))||[''])[0].length;
      if(lead+tail<word.length){range.from+=lead;range.to-=tail;}
    }
    return {start:range.from,end:range.to,before:value.slice(range.from,range.to),join};
  }
  /* The occurrence of word in text nearest to index near; -1 when absent. */
  function nearestIndex(text, word, near){
    let best=-1;
    if(!word) return best;
    for(let at=text.indexOf(word);at>=0;at=text.indexOf(word,at+1)){
      if(best<0||Math.abs(at-near)<Math.abs(best-near)) best=at;
    }
    return best;
  }
  /* The real changes of an edit: before and after split into words and spaces, lined up by their
     longest common subsequence; each hunk is a changed run {bStart, bEnd, aStart, aEnd}. Two separate
     changes stay two hunks (prefix/suffix trimming would join them and everything in between). */
  /* One hunk from the common prefix and suffix, for edits too long for the word table. */
  function trimHunk(before, after){
    if(before===after) return [];
    let pre=0;
    while(pre<before.length&&pre<after.length&&before[pre]===after[pre]) pre+=1;
    let suf=0;
    const room=Math.min(before.length,after.length)-pre;
    while(suf<room&&before[before.length-1-suf]===after[after.length-1-suf]) suf+=1;
    return [{bStart:pre,bEnd:before.length-suf,aStart:pre,aEnd:after.length-suf}];
  }
  function lcsTable(a, b){
    const lcs=Array.from({length:a.length+1},()=>new Array(b.length+1).fill(0));
    for(let i=a.length-1;i>=0;i-=1) for(let j=b.length-1;j>=0;j-=1) lcs[i][j]=a[i]===b[j]?lcs[i+1][j+1]+1:Math.max(lcs[i+1][j],lcs[i][j+1]);
    return lcs;
  }
  function hunksOf(before, after){
    const a=String(before||'').split(/(\s+)/).filter(Boolean);
    const b=String(after||'').split(/(\s+)/).filter(Boolean);
    if(a.length*b.length>250000) return trimHunk(String(before||''),String(after||''));
    const lcs=lcsTable(a,b);
    const out=[];
    let i=0;let j=0;let x=0;let y=0;let open=null;
    const close=()=>{if(open){open.bEnd=x;open.aEnd=y;out.push(open);open=null;}};
    while(i<a.length||j<b.length){
      if(i<a.length&&j<b.length&&a[i]===b[j]){close();x+=a[i].length;y+=b[j].length;i+=1;j+=1;continue;}
      if(!open) open={bStart:x,aStart:y};
      if(j<b.length&&(i>=a.length||lcs[i][j+1]>=lcs[i+1][j])){y+=b[j].length;j+=1;}
      else{x+=a[i].length;i+=1;}
    }
    close();
    return out;
  }
  /* Where an unchanged range [rel, rel+len) of an edit's before sits in its after; -1 when it touches
     any of the edit's changes. */
  function unchangedAt(before, after, rel, len){
    let shift=0;
    for(const h of hunksOf(before,after)){
      if(h.bStart<rel+len&&rel<h.bEnd) return -1;
      if(len===0&&h.bStart===rel&&h.bEnd>rel) return -1;
      if(h.bEnd<=rel) shift+=(h.aEnd-h.aStart)-(h.bEnd-h.bStart);
    }
    return rel+shift;
  }
  /* How many ink characters agree right before (left) and right after (right) a spot, comparing the
     tapped word's text-layer neighbours with a candidate place in a segment text. */
  function sideAgree(layerBefore, layerAfter, textBefore, textAfter){
    const a=inkChars(layerBefore).chars;
    const b=inkChars(textBefore).chars;
    const c=inkChars(layerAfter).chars;
    const d=inkChars(textAfter).chars;
    let left=0;
    while(left<a.length&&left<b.length&&a[a.length-1-left]===b[b.length-1-left]) left+=1;
    let right=0;
    while(right<c.length&&right<d.length&&c[right]===d[right]) right+=1;
    return {left,right,score:left+right,whole:left===a.length&&right===c.length};
  }
  /* A new word split over two line halves in proportion to the old halves; the first keeps a hyphen. */
  function splitWord(value, firstLen, secondLen){
    const text=String(value||'');
    if(text.length<2||!(firstLen>0)||!(secondLen>0)) return [text,''];
    const k=Math.min(text.length-1,Math.max(1,Math.round(text.length*firstLen/(firstLen+secondLen))));
    return [text.slice(0,k)+'-',text.slice(k)];
  }
  function overlaps(a, b){
    return a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
  }
  function union(a, b){
    const x=Math.min(a.x,b.x);
    const y=Math.min(a.y,b.y);
    return {x,y,w:Math.max(a.x+a.w,b.x+b.w)-x,h:Math.max(a.y+a.h,b.y+b.h)-y};
  }
  /* The hint block around a number cluster (page fractions): the paragraph boxes that touch the cluster,
     then, growing, every box in the same column that shares its rows or sits within one line above it
     (row names, the header row). Boxes in another column never touch the growing block's x range. */
  function hintBlock(items, seed, lineH){
    const boxes=(Array.isArray(items)?items:[]).map(item=>item&&item.rect).filter(r=>r&&r.w>0&&r.h>0);
    let block={x:seed.x,y:seed.y,w:seed.w,h:seed.h};
    const reach=Math.max(0,Number(lineH)||0)*1.6;
    for(let changed=true;changed;){
      changed=false;
      for(const r of boxes){
        const band={x:block.x,y:block.y-reach,w:block.w,h:block.h+reach};
        const inBlock=r.x>=block.x&&r.y>=block.y&&r.x+r.w<=block.x+block.w&&r.y+r.h<=block.y+block.h;
        if(inBlock||!overlaps(r,band)||r.h>block.h*3+reach) continue;
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
  /* Height of whatever covers the bottom of the layout viewport (the soft keyboard). */
  function keyboardInset(innerHeight, vv){
    if(!vv||!(vv.height>0)) return 0;
    return Math.max(0,Math.round(innerHeight-(vv.offsetTop+vv.height)));
  }

  /* ---------- page edit UI ---------- */
  function mount(doc){
    const stage=doc.getElementById('paper-before-stage');
    if(!stage||!doc.getElementById('booth-step-edit')||doc.getElementById('booth-pe-bar')) return;
    const html=doc.documentElement;
    const st={sel:null,focus:null,pending:null,patches:new Map(),fileHash:'',pdf:null,pageEl:null,editing:null,auto:new Set(),autoOff:false,composing:false,hoverFrame:0};
    let stub=null;
    const ws=()=>root.FalsifyPaperWorkspace||null;
    const recipe=()=>root.FalsifyBoothRecipe||null;
    function patcher(){
      const real=root.FalsifyBoothPatch;
      if(real&&typeof real.paint==='function') return real;
      if(!stub) stub=fallbackPatch(doc);
      return stub;
    }
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
    /* The touch model (edit bar above the keyboard, tap snapping, ‹ ›, dock aside while typing) follows the
       input type: any coarse pointer, also a landscape tablet at desktop width, and every narrow screen. */
    const touch=()=>coarse()||!desk();
    const editing=()=>html.dataset.boothStep==='edit';
    const zoomed=()=>(Number(call('getZoom'))||1)>1.01;
    const pageEl=()=>stage.querySelector(':scope>.paper-page');

    /* Bar above the page (phones): a one-line tip and 전체 쪽 while zoomed. Desktop gets a tip in the find pane. */
    const tip=el('p','booth-pe-tip');
    tip.setAttribute('role','status');
    tip.setAttribute('aria-live','polite');
    const fit=button('booth-pe-fit','전체 쪽');
    fit.id='booth-pe-fit';
    /* Visible zoom steps (WCAG 2.5.7: no pinch-only zoom). */
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
    fit.addEventListener('click',()=>{closePop(false);setZoom(1);});
    const zoomLevels=()=>desk()?[1,1.25,1.5,2]:[1,1.5,ZOOM,TABLE_ZOOM];
    /* One step in or out, keeping the middle of what is in view in the middle. */
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
    /* Desktop widths: the zoom buttons join the page toolbar (이전 쪽 · n / N쪽 · 다음 쪽); phones keep them in the bar. */
    function placeTools(){
      const toolbar=doc.querySelector('#paper-workspace .paper-toolbar');
      const home=desk()&&toolbar?toolbar:bar;
      if(tools.parentElement!==home) home.append(tools);
    }
    zoomOut.addEventListener('click',()=>zoomStep(-1));
    zoomIn.addEventListener('click',()=>zoomStep(1));

    /* The editor: an anchored popover on desktop, a bar above the soft keyboard on phones. */
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
    const status=el('p','booth-pe-status');
    status.setAttribute('role','status');
    status.setAttribute('aria-live','polite');
    pop.append(label,prev,input,next,apply,whole,cancel,status);
    doc.body.append(pop);
    const hover=el('div','booth-pe-hover');
    hover.setAttribute('aria-hidden','true');

    function setZoom(factor){
      const ok=call('setZoom',factor)===true;
      syncBar();
      return ok;
    }
    function selBox(){
      return st.sel&&st.sel.box&&st.sel.box.isConnected?st.sel.box:null;
    }
    function closePop(refocus){
      if(st.sel&&st.sel.box) st.sel.box.remove();
      if(st.sel&&st.sel.halfBox) st.sel.halfBox.remove();
      st.sel=null;
      pop.hidden=true;
      status.textContent='';
      syncTyping();
      if(refocus){try{stage.focus({preventScroll:true});}catch{}}
    }
    function bounds(){
      const dock=doc.getElementById('booth-dock');
      const dockTop=dock&&dock.offsetParent!==null?dock.getBoundingClientRect().top:root.innerHeight;
      return {left:8,top:8,right:(root.innerWidth||360)-8,bottom:Math.min(root.innerHeight||640,dockTop)-8};
    }
    const barMode=touch;
    /* Phones: pinned above the keyboard (visualViewport), then the word is kept in view above it. */
    function placeBar(){
      const inset=keyboardInset(root.innerHeight||0,root.visualViewport);
      pop.style.left='';
      pop.style.top='';
      pop.style.width='';
      pop.style.bottom=inset+'px';
      /* Desktop widths with touch: the bar lines up with the page column, as wide as the page. */
      if(desk()){
        const canvas=stage.querySelector(':scope>.paper-page>canvas');
        const column=(canvas||stage).getBoundingClientRect();
        pop.style.left=Math.round(column.left)+'px';
        pop.style.width=Math.round(column.width)+'px';
      }
      keepWordVisible();
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
    /* The zoom box pans first, then the window scrolls for what is left. */
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
      if(pop.hidden) return;
      pop.classList.toggle('is-bar',barMode());
      if(barMode()) placeBar(); else placeAnchored();
    }
    /* Desktop: room for the popover under the word. */
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
    /* The nearest span; a finger may miss by up to 24 CSS px. */
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
    function rectOf(range){
      const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);
      if(!rects.length) return range.getBoundingClientRect();
      return {left:Math.min(...rects.map(r=>r.left)),right:Math.max(...rects.map(r=>r.right))};
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
    function contextFor(sorted, span, token){
      const at=sorted.indexOf(span);
      const part=sorted.slice(Math.max(0,at-2),at+3);
      return contextWindow(part.map(node=>node.textContent),part.indexOf(span),token.start,token.end);
    }
    function fraction(r, page){
      const box=page.getBoundingClientRect();
      return {x:(r.left-box.left)/box.width,y:(r.top-box.top)/box.height,w:(r.right-r.left)/box.width,h:(r.bottom-r.top)/box.height};
    }
    function makeWord(page, span, token, sorted){
      const range=token&&rangeFor(span,token.start,token.end);
      if(!range) return null;
      const box=rectOf(range);
      const line=span.getBoundingClientRect();
      const rect=fraction({left:box.left,right:box.right,top:line.top,bottom:line.bottom},page);
      return {span,token,text:span.textContent.slice(token.start,token.end),rect,context:contextFor(sorted||ordered(page),span,token)};
    }
    function wordAt(page, x, y){
      const spans=ordered(page);
      const span=spanAt(spans,x,y,touch()?24:3);
      if(!span) return null;
      const token=cellRange(span,spans)||tokenAt(span.textContent,charAt(span,x));
      return makeWord(page,span,token,spans);
    }
    /* Every word of the page in reading order, for ‹ ›. */
    function pageWords(page){
      const out=[];
      for(const span of ordered(page)) for(const token of tokensIn(span.textContent)) out.push({span,token});
      return out;
    }
    function patchAt(pageIndex, rect){
      for(const [id,patch] of st.patches){
        if(patch.pageIndex===pageIndex&&overlapShare(patch.rect,rect)>0.4) return id;
      }
      return null;
    }

    /* ---------- selection and popover ---------- */
    function outline(page, rect, className){
      const box=el('div',className||'booth-pe-sel');
      box.setAttribute('aria-hidden','true');
      Object.assign(box.style,{left:rect.x*100+'%',top:rect.y*100+'%',width:rect.w*100+'%',height:rect.h*100+'%'});
      page.append(box);
      return box;
    }
    function paragraphFor(word){
      const boxes=call('getPageParagraphs');
      const items=boxes&&Array.isArray(boxes.items)?boxes.items:[];
      const hit=paragraphAt(items,word.rect.x+word.rect.w/2,word.rect.y+word.rect.h/2);
      if(hit&&hit.editable) return hit;
      /* A box can stop short of the word (a line-end hyphen, a wide cell): the nearest editable box it touches. */
      const pad=0.01;
      const cx=word.rect.x+word.rect.w/2;
      const cy=word.rect.y+word.rect.h/2;
      const touching=items.filter(item=>item&&item.editable&&item.rect
        &&word.rect.x<item.rect.x+item.rect.w+pad&&item.rect.x-pad<word.rect.x+word.rect.w
        &&word.rect.y+word.rect.h/2>item.rect.y&&word.rect.y+word.rect.h/2<item.rect.y+item.rect.h);
      const gap=item=>Math.hypot(item.rect.x+item.rect.w/2-cx,item.rect.y+item.rect.h/2-cy);
      return touching.sort((a,b)=>gap(a)-gap(b))[0]||null;
    }
    function fillPop(sel, patch){
      label.textContent=(sel.pageIndex+1)+'쪽 · '+(patch?'고친 글자 · 원문 '+patch.original:'이 글자 고치기');
      input.value=patch?patch.value:(sel.spot?sel.spot.before:sel.word.text);
      input.setAttribute('inputmode',numericToken(input.value)?'decimal':'text');
      whole.disabled=!sel.paragraph;
      /* Neither a place in the text nor a paragraph to open: this glyph is not editable text (a figure
         label, a running head). Said in place; the field stays closed. */
      const closed=!sel.spot&&!sel.paragraph&&!patch&&!sel.word.text.trim();
      input.disabled=closed;
      apply.disabled=closed;
      status.textContent=closed?FAIL_TEXT.outside:'';
    }
    function selectWord(page, word){
      closePop(false);
      const pageIndex=call('getPageIndex');
      if(!word||!Number.isInteger(pageIndex)) return;
      const patchId=patchAt(pageIndex,word.rect);
      const patch=patchId?st.patches.get(patchId):null;
      const paragraph=paragraphFor(word);
      const spot=spotOf(page,word,paragraph,pageIndex);
      st.sel={pageIndex,page,word,patchId,paragraph,spot,box:outline(page,word.rect),halfBox:spot&&spot.half?outline(page,spot.half.rect):null};
      fillPop(st.sel,patch);
      pop.hidden=false;
      pop.classList.toggle('is-bar',barMode());
      if(!barMode()) makeRoom(st.sel.box);
      placePop();
      try{input.focus({preventScroll:true});input.select();}catch{}
      syncTyping();
      if(barMode()) root.setTimeout(placePop,0);
    }
    function step(delta){
      const sel=st.sel;
      if(!sel) return;
      const words=pageWords(sel.page);
      const at=words.findIndex(w=>w.span===sel.word.span&&w.token.start===sel.word.token.start);
      const target=words[at+delta];
      if(!target) return;
      const word=makeWord(sel.page,target.span,target.token);
      revealInStage(word);
      selectWord(sel.page,makeWord(sel.page,target.span,target.token));
    }
    /* Pan the zoom box sideways so a word reached with ‹ › is inside it. */
    function revealInStage(word){
      if(!word||!zoomed()) return;
      const page=word.span.closest('.paper-page');
      const box=page.getBoundingClientRect();
      const x=word.rect.x*box.width;
      if(x<stage.scrollLeft+8||x+word.rect.w*box.width>stage.scrollLeft+stage.clientWidth-8) stage.scrollLeft=Math.max(0,x-stage.clientWidth/3);
    }
    function onPageClick(event){
      const page=pageEl();
      const target=event.target;
      if(!editing()||!page||!(target instanceof root.Node)||!page.contains(target)) return;
      if(target.closest&&target.closest('textarea,.paper-direct-controls,.booth-pe-head,button,input')) return;
      event.stopPropagation();
      if(event.detail>1) return;
      if(!desk()&&!zoomed()){zoomAt(page,event.clientX,event.clientY);return;}
      selectWord(page,wordAt(page,event.clientX,event.clientY));
    }
    /* Numbers packed together (a table) get 3.5x; text gets 2.5x. */
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
      if(!focus||!zoomed()) {stage.scrollTo(0,0);return;}
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
    /* A mission opens zoomed on its hint page's number table, once per paper. */
    function autoZoom(page){
      const src=call('getSource');
      const paper=root.FalsifyBoothPaper&&typeof root.FalsifyBoothPaper.current==='function'?root.FalsifyBoothPaper.current():null;
      if(desk()||!editing()||st.autoOff||!src||st.auto.has(src.fileHash)||!paper||paper.source!=='mission') return;
      if(call('getPageIndex')!==(paper.pageHint||1)-1) return;
      st.auto.add(src.fileHash);
      const box=page.getBoundingClientRect();
      const radius=box.width*0.12;
      const spot=densest(numberPoints(page),radius);
      if(!spot||spot.count<3) return;
      zoomToBlock(page,box,spot,radius);
    }
    /* Fit the whole hint block (the table: row names to the last column, header included) across the
       column, at most TABLE_ZOOM, with its top just under the page toolbar. */
    async function zoomToBlock(page, box, spot, radius){
      /* Paragraph boxes arrive a moment after the page draw; the block needs them for the row names. */
      const ready=()=>{const boxes=call('getPageParagraphs');return !!(boxes&&Array.isArray(boxes.items)&&boxes.items.length);};
      await waitFor(ready,3000);
      if(st.autoOff||!editing()||zoomed()||pageEl()!==page||!page.isConnected) return;
      box=page.getBoundingClientRect();
      const near=spansOf(page).filter(span=>numericToken(span.textContent.trim())).map(span=>span.getBoundingClientRect())
        .filter(r=>Math.hypot((r.left+r.right)/2-box.left-spot.x,(r.top+r.bottom)/2-box.top-spot.y)<=radius);
      if(!near.length) return;
      const seed=near.map(r=>fraction(r,page)).reduce((a,b)=>union(a,b));
      const boxes=call('getPageParagraphs');
      const lineH=near.reduce((h,r)=>Math.max(h,r.height),0)/box.height;
      const block=padRect(hintBlock(boxes&&boxes.items,seed,lineH),0.015);
      st.focus={block};
      if(!setZoom(fitZoom(block.w,0,TABLE_ZOOM))) st.focus=null;
    }

    /* The visitor came first: any touch, click or key in the edit step (zoom, page turn, a tab, the find
       form, the page) cancels a hint zoom still waiting for its page, so it never overrides them. */
    function cancelAutoZoom(event){
      if(!event.isTrusted||!editing()||st.autoOff) return;
      st.autoOff=true;
      const src=call('getSource');
      if(src&&src.fileHash) st.auto.add(src.fileHash);
    }
    /* ---------- desktop hover: the word under the pointer gets a hairline ---------- */
    function onMove(event){
      if(!desk()||!media('(pointer:fine)')||st.hoverFrame) return;
      const x=event.clientX;
      const y=event.clientY;
      st.hoverFrame=root.requestAnimationFrame(()=>{st.hoverFrame=0;showHover(x,y);});
    }
    function showHover(x, y){
      const page=pageEl();
      const inside=page&&editing()&&!page.querySelector(':scope>textarea')&&distance(page.getBoundingClientRect(),x,y)===0;
      const word=inside?wordAt(page,x,y):null;
      if(!word){hover.remove();return;}
      Object.assign(hover.style,{left:word.rect.x*100+'%',top:word.rect.y*100+'%',width:word.rect.w*100+'%',height:word.rect.h*100+'%'});
      if(hover.parentNode!==page) page.append(hover);
    }

    /* ---------- commit ---------- */
    function segmentsNow(){
      const src=call('getSource');
      return src&&Array.isArray(src.segments)?src.segments:[];
    }
    /* The paragraph's text-layer spans, in reading order; null when the tapped span is not among them. */
    function paragraphSpans(page, rect, span){
      const pad=0.004;
      const list=ordered(page).filter(node=>{
        const r=fraction(node.getBoundingClientRect(),page);
        const cx=r.x+r.w/2;
        const cy=r.y+r.h/2;
        return cx>=rect.x-pad&&cx<=rect.x+rect.w+pad&&cy>=rect.y-pad&&cy<=rect.y+rect.h+pad;
      });
      return list.includes(span)?list:null;
    }
    /* The tapped token as an offset range in its paragraph's text. The text layer and the paragraph
       text are lined up character by character, so the exact occurrence is known however often the
       word repeats. Falls back to a text search, nearest on this page first; null when not in any text. */
    function spotOf(page, word, paragraph, pageIndex){
      const segs=segmentsNow();
      const boxes=call('getPageParagraphs');
      const items=(boxes&&Array.isArray(boxes.items)?boxes.items:[]).filter(item=>item&&item.rect&&item.editable!==false);
      /* Paragraph boxes can stop short of a line-end hyphen: the word only has to touch the box. */
      const pad=0.01;
      const inside=item=>word.rect.x<item.rect.x+item.rect.w+pad&&item.rect.x-pad<word.rect.x+word.rect.w&&word.rect.y<item.rect.y+item.rect.h+pad&&item.rect.y-pad<word.rect.y+word.rect.h;
      const order=[paragraph].concat(items.filter(item=>item!==paragraph&&inside(item))).filter(Boolean);
      for(const item of order){
        const seg=segs.find(s=>s&&s.id===item.segmentId);
        const spans=seg&&typeof seg.text==='string'?paragraphSpans(page,item.rect,word.span):null;
        if(!spans) continue;
        const spot=spotIn(spans.map(node=>node.textContent),spans.indexOf(word.span),word.token.start,word.token.end,seg.text);
        if(!spot) continue;
        let half=null;
        if(spot.join){
          const span=spans[spot.join.part];
          const token=tokenAt(span.textContent,spot.join.char);
          half=token?makeWord(page,span,token,spans):null;
        }
        return {segmentId:seg.id,pageIndex,start:spot.start,end:spot.end,before:spot.before,half,halfSide:spot.join?spot.join.side:''};
      }
      return pageViewSpot(page,word,pageIndex)||searchSpot(page,word,pageIndex);
    }
    /* The tapped word's neighbours on the drawn page, as text before and after the token. */
    function layerSides(page, word){
      const spans=ordered(page);
      const at=spans.indexOf(word.span);
      const text=word.span.textContent;
      const before=spans.slice(Math.max(0,at-4),at).map(node=>node.textContent).join(' ')+' '+text.slice(0,word.token.start);
      const after=text.slice(word.token.end)+' '+spans.slice(at+1,at+5).map(node=>node.textContent).join(' ');
      return {before:before.slice(-60),after:after.slice(0,60)};
    }
    /* No paragraph place for the tap (a superscript mark, boxes not drawn yet): the page's own text
       segments (the page view first, then layout columns) lined up with every text-layer span of the
       page, the same positional mapping as for paragraphs. A place counts only when the tapped token
       maps into the segment and its neighbours there agree with the drawn neighbours. Generation moves
       such an edit onto its paragraph when it needs to (paper-workspace). */
    function pageViewSpot(page, word, pageIndex){
      const spans=ordered(page);
      const index=spans.indexOf(word.span);
      if(index<0) return null;
      const texts=spans.map(node=>node.textContent);
      const sides=layerSides(page,word);
      const kind=seg=>String(seg.id).startsWith('layout:')?1:0;
      const segs=segmentsNow().filter(seg=>seg&&seg.pageIndex===pageIndex&&typeof seg.text==='string'
        &&!String(seg.id).startsWith('paragraph:')).sort((a,b)=>kind(a)-kind(b));
      for(const seg of segs){
        const spot=spotIn(texts,index,word.token.start,word.token.end,seg.text);
        if(!spot||spot.join) continue;
        const agree=sideAgree(sides.before,sides.after,seg.text.slice(Math.max(0,spot.start-200),spot.start),seg.text.slice(spot.end,spot.end+200));
        if(agree.left+agree.right<12&&!agree.whole) continue;
        return {segmentId:seg.id,pageIndex,start:spot.start,end:spot.end,before:spot.before,half:null,halfSide:''};
      }
      return null;
    }
    /* No paragraph place for the tap: a text search is used only when it provably finds the tapped
       occurrence: on this page, and the one place whose neighbours agree with the tapped word's
       neighbours clearly better than every other place (at least 12 characters, or all of them). */
    function searchSpot(page, word, pageIndex){
      const R=recipe();
      const segs=segmentsNow();
      if(!R||typeof R.searchHits!=='function'||typeof R.locate!=='function') return null;
      const sides=layerSides(page,word);
      const places=[];
      for(const item of R.searchHits(segs,word.text,pageIndex,200).items){
        if(item.pageIndex!==pageIndex) continue;
        const found=R.locate({page:pageIndex+1,find:word.text,hint:item.hint},segs);
        const seg=found.status==='resolved'?segs.find(s=>s&&s.id===found.segmentId):null;
        if(!seg||found.pageIndex!==pageIndex) continue;
        const agree=sideAgree(sides.before,sides.after,seg.text.slice(Math.max(0,found.start-200),found.start),seg.text.slice(found.end,found.end+200));
        places.push({found,agree});
      }
      places.sort((a,b)=>b.agree.score-a.agree.score);
      const best=places[0];
      if(!best||(places[1]&&places[1].agree.score>=best.agree.score)) return null;
      if(best.agree.score<12&&!best.agree.whole) return null;
      const found=best.found;
      return {segmentId:found.segmentId,pageIndex,start:found.start,end:found.end,before:found.before,half:null,halfSide:''};
    }
    function editsNow(){
      const snap=call('getEditSnapshot');
      return snap&&Array.isArray(snap.edits)?snap.edits.filter(edit=>edit&&edit.enabled!==false):[];
    }
    function editById(id){
      return editsNow().find(edit=>edit.id===id)||null;
    }
    /* One exact occurrence by offset: the workspace keeps the anchor, so a repeated word is fine. */
    function addExact(spot, value){
      const known=new Set(editsNow().map(edit=>edit.id));
      const proposal={segmentId:spot.segmentId,pageIndex:spot.pageIndex,before:spot.before,after:value,anchor:{start:spot.start,end:spot.end}};
      const result=call('acceptProposals',[proposal],{origin:'external-ai-import',confirmed:true});
      call('acceptProposals',[],{origin:'external-ai-import'});
      const added=editsNow().find(edit=>!known.has(edit.id));
      return result&&result.applied===1&&added?{ok:true,id:added.id,after:added.after}:{ok:false};
    }
    /* The token sits in the unchanged text of an edit already made in this paragraph: that edit takes the change too. */
    function overlapping(spot){
      return editsNow().filter(edit=>edit.segmentId===spot.segmentId&&edit.anchor&&edit.anchor.start<spot.end&&spot.start<edit.anchor.end);
    }
    function mergeInto(spot, value){
      const hits=overlapping(spot);
      const edit=hits.length===1?hits[0]:null;
      if(!edit||spot.start<edit.anchor.start||spot.end>edit.anchor.end) return {ok:false};
      const at=unchangedAt(edit.before,edit.after,spot.start-edit.anchor.start,spot.end-spot.start);
      if(at<0) return {ok:false};
      const after=edit.after.slice(0,at)+value+edit.after.slice(at+spot.end-spot.start);
      if(!updateAfter(edit.id,after)) return {ok:false};
      return {ok:true,id:edit.id,after};
    }
    /* Widened by whole words until unique (the same commit as find-and-replace and recipes), else
       that one occurrence by offset, else merged into the edit it sits in. */
    function commitSpot(spot, value){
      const R=recipe();
      /* Next to an earlier edit: that edit takes the change and keeps its id (and its patches). */
      let result=mergeInto(spot,value);
      if(result.ok) return result;
      st.holding=true;
      try{result=R&&typeof R.applyFound==='function'?R.applyFound(Object.assign({status:'resolved',kind:'paragraph'},spot),value):{ok:false};}
      finally{st.holding=false;}
      if(result.ok) adoptMerged();
      if(!result.ok) result=addExact(spot,value);
      return result;
    }
    /* applyFound folds overlapping edits into one: syncPatches finds each patch's change in the new edit
       (or drops the patch when that change is gone). */
    function adoptMerged(){
      syncPatches();
    }
    function fontOf(span){
      try{const m=patcher().measure(span);if(m&&m.fontPx>0) return m;}catch{}
      return {fontPx:span.getBoundingClientRect().height,baselineFrac:0.8,family:'serif'};
    }
    function paint(key, patch){
      const page=pageEl();
      if(!page||call('getPageIndex')!==patch.pageIndex) return;
      try{patcher().paint(page,{id:key,pageIndex:patch.pageIndex,rect:patch.rect,text:patch.text,font:patch.font});}catch{}
      coverMarks(page);
    }
    function patchRect(word){
      const font=fontOf(word.span);
      /* x and width from the token's own Range, y and height from measure().rect (baselineFrac refers to it). */
      const line=font.rect&&font.rect.h>0?font.rect:word.rect;
      return {rect:{x:word.rect.x,w:word.rect.w,y:line.y,h:line.h},font:{fontPx:font.fontPx,baselineFrac:font.baselineFrac,family:font.family}};
    }
    const keyOf=(id,start,half)=>id+'@'+start+(half?'~2':'');
    /* The patches of one tapped word: one, or two for a word hyphenated across lines (in line order). */
    function wordPatches(spotKey){
      return [...st.patches].filter(([,patch])=>patch.word===spotKey);
    }
    function paintWord(info){
      const halves=info.half?(info.halfSide==='left'?[info.half,info.word]:[info.word,info.half]):[info.word];
      const texts=halves.length===2?splitWord(info.value,halves[0].text.replace(/-$/,'').length,halves[1].text.length):[info.value];
      const wordKey=keyOf(info.edit,info.start);
      for(const [key] of wordPatches(wordKey)){st.patches.delete(key);try{patcher().remove(key);}catch{}}
      halves.forEach((word,n)=>{
        const look=patchRect(word);
        const key=keyOf(info.edit,info.start,n>0);
        const patch={word:wordKey,edit:info.edit,segmentId:info.segmentId,start:info.start,at:info.at,pageIndex:info.pageIndex,rect:look.rect,font:look.font,
          text:texts[n],value:info.value,original:info.original,after:info.after,halves:info};
        st.patches.set(key,patch);
        paint(key,patch);
      });
    }
    /* A new after for an edit with patches: they keep their words (syncPatches leaves them alone meanwhile). */
    function updateAfter(id, after){
      st.updating=id;
      let ok=false;
      try{ok=call('updateEdit',id,after)===true;}finally{st.updating=null;}
      if(ok) retag(id,after);
      return ok;
    }
    /* Every patch of an edit follows its new after. */
    function retag(id, after){
      for(const patch of st.patches.values()) if(patch.edit===id){patch.after=after;patch.halves.after=after;}
    }
    function commitWord(sel, value){
      const spot=sel.spot;
      const result=commitSpot(spot,value);
      if(!result.ok){
        if(overlapping(spot).length) showClash(sel,value);
        else{status.textContent=FAIL_TEXT.rejected;placePop();}
        return;
      }
      if(!result.id){closePop(true);return;}
      const edit=editById(result.id);
      const anchor=edit&&edit.anchor&&Number.isInteger(edit.anchor.start)?edit.anchor.start:spot.start;
      const at=nearestIndex(result.after,value,spot.start-anchor);
      retag(result.id,result.after);
      closePop(true);
      paintWord({edit:result.id,segmentId:edit?edit.segmentId:spot.segmentId,start:spot.start,at,pageIndex:sel.pageIndex,word:sel.word,
        half:spot.half,halfSide:spot.halfSide,value,original:spot.before,after:result.after});
    }
    /* A word changed before: its edit gets the new word in place (back to the original drops it). */
    function reEdit(old, value){
      const edit=editById(old.edit);
      if(!edit) return false;
      const at=nearestIndex(edit.after,old.value,old.at);
      if(at<0) return false;
      const after=edit.after.slice(0,at)+value+edit.after.slice(at+old.value.length);
      if(!updateAfter(edit.id,after)) return false;
      const info=Object.assign({},old.halves,{value,at,after});
      if(after===edit.before||value===old.original){
        for(const [key] of wordPatches(old.word)){st.patches.delete(key);try{patcher().remove(key);}catch{}}
        coverMarks(pageEl());
        return true;
      }
      paintWord(info);
      return true;
    }
    /* Nothing automatic is left: the visitor removes the earlier edit here, in one tap. */
    function showClash(sel, value){
      status.textContent=FAIL_TEXT.clash+' ';
      const act=button('booth-pe-status-act',FAIL_TEXT.clashAct);
      act.addEventListener('click',()=>{
        const spot=sel.spot;
        const page=sel.page;
        const box=page.getBoundingClientRect();
        const marks=[...page.querySelectorAll('.paper-change-mark')].filter(mark=>{
          const r=fraction(mark.getBoundingClientRect(),page);
          return box.width>0&&overlapShare(r,sel.word.rect)>0;
        }).map(mark=>mark.dataset.edit);
        const same=overlapping(spot).map(edit=>edit.id);
        for(const id of new Set(same.concat(marks))) call('removeEdit',id);
        if(st.sel===sel) commitWord(sel,value);
      });
      status.append(act);
      placePop();
    }
    function replaceWord(){
      const sel=st.sel;
      if(!sel) return;
      /* Paragraph boxes can arrive after the tap: place the word again before anything else. */
      if(!sel.spot){
        sel.paragraph=sel.paragraph||paragraphFor(sel.word);
        sel.spot=spotOf(sel.page,sel.word,sel.paragraph,sel.pageIndex);
      }
      /* The paragraph is there but the tapped place could not be pinned: its editor opens there instead of guessing. */
      if(!sel.spot&&sel.paragraph){wholeParagraph();return;}
      if(!sel.spot){status.textContent=recipe()?FAIL_TEXT.outside:FAIL_TEXT.no_paper;return;}
      const value=input.value;
      const old=sel.patchId?st.patches.get(sel.patchId):null;
      if(value===(old?old.value:sel.spot.before)){closePop(true);return;}
      if(old&&reEdit(old,value)){closePop(true);return;}
      commitWord(sel,value);
    }
    async function wholeParagraph(){
      const sel=st.sel;
      if(!sel||!sel.paragraph) return;
      const id=sel.paragraph.segmentId;
      const rect=sel.paragraph.rect;
      closePop(false);
      /* A page redraw can race the editor opening: one quiet retry first. */
      for(let tries=0;tries<2;tries+=1){
        st.pending={segmentId:id,rect};
        if(zoomed()&&!setZoom(1)){st.pending=null;return;}
        const ready=await waitFor(()=>hasParagraph(id),6000);
        if(ready&&call('openParagraph',id)===true) return;
        st.pending=null;
      }
      const page=pageEl();
      const box=page&&page.getBoundingClientRect();
      const word=box&&box.width>0?wordAt(page,box.left+(sel.word.rect.x+sel.word.rect.w/2)*box.width,box.top+(sel.word.rect.y+sel.word.rect.h/2)*box.height):null;
      if(!word){tip.textContent=FAIL_TEXT.reopen;return;}
      selectWord(page,word);
      status.textContent=FAIL_TEXT.reopen+' ';
      const act=button('booth-pe-status-act',FAIL_TEXT.reopenAct);
      act.addEventListener('click',()=>{wholeParagraph();});
      status.append(act);
      placePop();
    }
    function hasParagraph(id){
      const page=pageEl();
      const boxes=call('getPageParagraphs');
      if(!page||zoomed()||!boxes) return false;
      return boxes.items.some(item=>item.segmentId===id);
    }
    function waitFor(check, ms){
      const until=Date.now()+ms;
      return new Promise(resolve=>{
        const tick=()=>{
          if(check()) return resolve(true);
          if(Date.now()>until) return resolve(false);
          root.setTimeout(tick,60);
        };
        tick();
      });
    }

    /* ---------- patches follow the edits ---------- */
    /* Where a patch's change sits in an edit's after: the patch's original word must be one of the edit's
       real changes (hunksOf) and its new word must be in that change; -1 otherwise (reverted, replaced). */
    function placeIn(edit, patch){
      if(!edit.anchor||!Number.isInteger(edit.anchor.start)) return edit.after===patch.after?patch.at:-1;
      const rel=patch.start-edit.anchor.start;
      const len=String(patch.original||'').length;
      if(rel<0||rel+len>edit.before.length||edit.before.slice(rel,rel+len)!==patch.original) return -1;
      const hunk=hunksOf(edit.before,edit.after).find(h=>h.bStart<rel+len&&rel<h.bEnd);
      if(!hunk) return -1;
      const at=nearestIndex(edit.after.slice(hunk.aStart,hunk.aEnd),patch.value,rel-hunk.bStart);
      return at<0?-1:hunk.aStart+at;
    }
    /* Every patch follows the edit that now holds its change, even when a merge gave it a new id. */
    function syncPatches(){
      if(st.holding) return;
      const edits=editsNow();
      for(const [key,patch] of [...st.patches]){
        if(!st.patches.has(key)) continue;
        const holds=edit=>edit.segmentId===patch.segmentId&&edit.anchor&&edit.anchor.start<=patch.start
          &&patch.start+String(patch.original||'').length<=edit.anchor.end;
        const own=edits.find(edit=>edit.id===patch.edit);
        const edit=own&&placeIn(own,patch)>=0?own:edits.find(item=>item!==own&&holds(item)&&placeIn(item,patch)>=0);
        if(!edit){
          if(patch.edit===st.updating) continue;
          st.patches.delete(key);
          try{patcher().remove(key);}catch{}
          continue;
        }
        const at=placeIn(edit,patch);
        Object.assign(patch,{at,after:edit.after});
        Object.assign(patch.halves,{at,after:edit.after});
        if(edit.id===patch.edit) continue;
        moveWord(patch.word,edit.id);
      }
    }
    /* A word's patches (one, or two halves) under a new edit id: new keys, repainted. */
    function moveWord(wordKey, id){
      for(const [key,patch] of wordPatches(wordKey)){
        st.patches.delete(key);
        try{patcher().remove(key);}catch{}
        const next=keyOf(id,patch.start,key.endsWith('~2'));
        Object.assign(patch,{edit:id,word:keyOf(id,patch.start)});
        patch.halves.edit=id;
        st.patches.set(next,patch);
        paint(next,patch);
      }
    }
    /* Every one-token edit gets a patch, however it was made (word tap, find-and-replace, a recipe):
       the workspace's change mark shows where it is on the drawn page, the text layer gives the token. */
    function tokenEdit(edit){
      const before=String(edit.before||'').trim().split(/\s+/);
      const after=String(edit.after||'').trim().split(/\s+/);
      while(before.length>1&&after.length>1&&before[0]===after[0]){before.shift();after.shift();}
      while(before.length>1&&after.length>1&&before[before.length-1]===after[after.length-1]){before.pop();after.pop();}
      if(before.length!==1||after.length!==1||!before[0]||!after[0]||before[0]===after[0]) return null;
      return {from:before[0],to:after[0]};
    }
    function adoptEdit(page, pageIndex, edit){
      const change=tokenEdit(edit);
      const mark=change&&[...page.querySelectorAll('.paper-change-mark')].find(node=>node.dataset.edit===edit.id);
      const box=mark&&mark.getBoundingClientRect();
      if(!box||!(box.width>0||box.height>0)) return;
      const word=wordAt(page,box.left+box.width/2,box.top+box.height/2);
      if(!word||word.text!==change.from) return false;
      /* The one real change of the edit gives both the old word's offset and the new word's. */
      const hunk=hunksOf(edit.before,edit.after).find(h=>edit.before.slice(h.bStart,h.bEnd).trim()===change.from);
      if(!hunk||!edit.anchor||!Number.isInteger(edit.anchor.start)) return false;
      const start=edit.anchor.start+edit.before.indexOf(change.from,hunk.bStart);
      const at=edit.after.indexOf(change.to,hunk.aStart);
      paintWord({edit:edit.id,segmentId:edit.segmentId,start,at,pageIndex,word,half:null,halfSide:'',value:change.to,original:change.from,after:edit.after});
      return true;
    }
    /* Edits whose mark did not lead to their token on this page element are not retried on it. */
    const missed=new WeakMap();
    function adoptEdits(page){
      const pageIndex=call('getPageIndex');
      if(!page||!Number.isInteger(pageIndex)||page.querySelector(':scope>textarea')) return;
      const snap=call('getEditSnapshot');
      for(const edit of snap&&Array.isArray(snap.edits)?snap.edits:[]){
        if(!edit||edit.enabled===false||edit.pageIndex!==pageIndex||hasPatch(edit.id)) continue;
        const key=edit.id+'|'+edit.after;
        if(!missed.has(page)) missed.set(page,new Set());
        if(missed.get(page).has(key)) continue;
        if(adoptEdit(page,pageIndex,edit)===false) missed.get(page).add(key);
      }
    }
    /* The workspace's change marks for a patched word would sit on top of the patch: hide those. */
    function hasPatch(id){
      for(const patch of st.patches.values()) if(patch.edit===id) return true;
      return false;
    }
    function coverMarks(page){
      if(!page) return;
      for(const mark of page.querySelectorAll('.paper-change-mark')){
        const covered=hasPatch(mark.dataset.edit||'');
        if(mark.classList.contains('booth-pe-covered')!==covered) mark.classList.toggle('booth-pe-covered',covered);
      }
    }
    function clearPatches(){
      st.patches.clear();
      closePop(false);
      try{patcher().clear();}catch{}
    }
    function onSource(event){
      const hash=event&&event.detail&&event.detail.fileHash||'';
      if(hash===st.fileHash) return;
      st.fileHash=hash;
      st.pdf=null;
      clearPatches();
    }

    /* ---------- paragraph editor as a paper sheet ---------- */
    function editorRect(page, area){
      if(st.pending) return st.pending.rect;
      const s=area.style;
      const box=page.getBoundingClientRect();
      const x=parseFloat(s.left)/100;
      const y=parseFloat(s.top)/100;
      const w=parseFloat(s.width)/100;
      const h=parseFloat(s.height)/(box.height||1);
      return [x,y,w,h].every(n=>Number.isFinite(n)&&n>=0)&&w>0&&h>0?{x,y,w,h}:null;
    }
    function quickCrop(canvas, page, rect){
      const source=page.querySelector('canvas');
      const ctx=canvas.getContext('2d');
      if(!source||!ctx||!source.width) return;
      ctx.fillStyle='#fff';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(source,rect.x*source.width,rect.y*source.height,rect.w*source.width,rect.h*source.height,0,0,canvas.width,canvas.height);
    }
    async function pdfDoc(){
      const src=call('getSource');
      const preview=root.FalsifyPreview;
      if(!src||!src.file||!preview||typeof preview.defaultImport!=='function') return null;
      if(st.pdf&&st.pdf.file===src.file) return st.pdf.task;
      const task=(async()=>{
        const lib=await preview.defaultImport();
        if(lib.GlobalWorkerOptions&&!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',doc.baseURI).href;
        const bytes=new Uint8Array(await src.file.arrayBuffer());
        return lib.getDocument(preview.pdfParams(bytes,doc.baseURI)).promise;
      })();
      st.pdf={file:src.file,task};
      task.catch(()=>{if(st.pdf&&st.pdf.task===task) st.pdf=null;});
      return task;
    }
    /* Re-render just the paragraph from the PDF at the crop's device pixels, so it is sharp. */
    async function sharpCrop(canvas, rect, pageIndex){
      try{
        const pdf=await pdfDoc();
        if(!pdf) return;
        const page=await pdf.getPage(pageIndex+1);
        const base=page.getViewport({scale:1});
        const viewport=page.getViewport({scale:canvas.width/(rect.w*base.width)});
        const off=doc.createElement('canvas');
        off.width=canvas.width;
        off.height=canvas.height;
        const ctx=off.getContext('2d');
        ctx.fillStyle='#fff';
        ctx.fillRect(0,0,off.width,off.height);
        await page.render({canvasContext:ctx,canvas:off,viewport,transform:[1,0,0,1,-rect.x*viewport.width,-rect.y*viewport.height]}).promise;
        if(!canvas.isConnected) return;
        canvas.getContext('2d').drawImage(off,0,0);
        canvas.dataset.sharp='1';
      }catch{/* the quick crop stays */}
    }
    function cropCanvas(page, head, crop){
      const box=page.getBoundingClientRect();
      const size=fitCrop(crop,box.height/(box.width||1),head.clientWidth||300,desk()?168:200);
      if(!size) return null;
      const ratio=Math.min(3,root.devicePixelRatio||1);
      const canvas=el('canvas','booth-pe-crop');
      canvas.width=Math.round(size.w*ratio);
      canvas.height=Math.round(size.h*ratio);
      canvas.style.width=size.w+'px';
      canvas.style.height=size.h+'px';
      canvas.setAttribute('role','img');
      canvas.setAttribute('aria-label','고칠 문단의 원본 모습');
      stage.style.setProperty('--pe-crop-h',size.h+'px');
      return canvas;
    }
    function decorateEditor(page, area){
      const rect=editorRect(page,area);
      st.pending=null;
      const head=el('div','booth-pe-head');
      head.append(el('p','booth-pe-head-label','이 문단 고치기'));
      page.append(head);
      page.classList.add('booth-pe-editing');
      st.editing={page,head};
      area.setAttribute('lang','en');
      const crop=rect&&padRect(rect,0.006);
      const canvas=crop&&cropCanvas(page,head,crop);
      if(canvas){
        head.append(canvas);
        quickCrop(canvas,page,crop);
        const pageIndex=call('getPageIndex');
        if(Number.isInteger(pageIndex)) void sharpCrop(canvas,crop,pageIndex);
      }
      if(!desk()) head.scrollIntoView({block:'start'});
    }
    function undecorate(){
      if(!st.editing) return;
      st.editing.head.remove();
      st.editing.page.classList.remove('booth-pe-editing');
      stage.style.removeProperty('--pe-crop-h');
      st.editing=null;
    }
    function syncEditor(page){
      const area=page&&page.querySelector(':scope>textarea');
      if(area&&(!st.editing||st.editing.page!==page)){undecorate();decorateEditor(page,area);}
      else if(!area) undecorate();
    }

    /* The workspace draws the page for the stage width it saw; a changed column width redraws it. */
    let refitTimer=0;
    function refit(){
      root.clearTimeout(refitTimer);
      refitTimer=root.setTimeout(()=>{
        const canvas=stage.querySelector(':scope>.paper-page>canvas');
        if(!canvas||zoomed()||stage.querySelector('textarea')) return;
        if(Math.abs(canvas.getBoundingClientRect().width-stage.clientWidth)>2) call('setZoom',Number(call('getZoom'))||1,true);
      },150);
    }
    /* Phones: the dock steps aside while a text field or the edit bar has focus. */
    function syncTyping(){
      const active=doc.activeElement;
      const typing=!pop.hidden&&barMode()||!!(active&&active.matches&&active.matches('input[type="text"],input:not([type]),input[type="search"],textarea'));
      html.classList.toggle('booth-pe-typing',typing&&touch());
    }

    /* A new page element: close the popover, repaint patches, keep the zoom box in step. */
    function onPage(page){
      st.pageEl=page;
      closePop(false);
      undecorate();
      syncBar();
      if(!editing()&&zoomed()) setZoom(1);
      const pageIndex=call('getPageIndex');
      try{if(Number.isInteger(pageIndex)) patcher().repaint(page,pageIndex);}catch{}
      applyFocus(page);
      autoZoom(page);
    }
    function onMutate(){
      const page=pageEl();
      if(page&&page!==st.pageEl) onPage(page);
      syncEditor(page);
      adoptEdits(page);
      coverMarks(page);
    }
    function onStep(){
      if(editing()){const page=pageEl();if(page) autoZoom(page);return;}
      st.autoOff=false;
      closePop(false);
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
    /* Enter applies and Esc cancels, never in the middle of an IME (Korean) composition. */
    function onKey(event){
      if(event.isComposing||st.composing||event.keyCode===229) return;
      if(event.key==='Enter'){event.preventDefault();replaceWord();}
      else if(event.key==='Escape'){event.preventDefault();closePop(true);}
    }

    apply.addEventListener('click',replaceWord);
    whole.addEventListener('click',()=>{void wholeParagraph();});
    cancel.addEventListener('click',()=>closePop(true));
    prev.addEventListener('click',()=>step(-1));
    next.addEventListener('click',()=>step(1));
    for(const node of [prev,next,apply]) node.addEventListener('pointerdown',event=>event.preventDefault());
    input.addEventListener('keydown',onKey);
    input.addEventListener('compositionstart',()=>{st.composing=true;});
    input.addEventListener('compositionend',()=>{st.composing=false;});
    input.addEventListener('focus',()=>{try{input.select();}catch{}});
    input.addEventListener('input',()=>{status.textContent='';});
    doc.addEventListener('click',onPageClick,true);
    doc.addEventListener('pointerdown',onDown,true);
    for(const kind of ['pointerdown','keydown','wheel']) doc.addEventListener(kind,cancelAutoZoom,{capture:true,passive:true});
    doc.addEventListener('mousemove',onMove,{passive:true});
    doc.addEventListener('focusin',syncTyping);
    doc.addEventListener('focusout',()=>root.setTimeout(syncTyping,0));
    doc.addEventListener('falsify:paper-workspace-edits',syncPatches);
    doc.addEventListener('falsify:paper-workspace-source',onSource);
    doc.addEventListener('falsify:document-clear',clearPatches);
    stage.addEventListener('scroll',()=>{if(!barMode()) placePop();},{passive:true});
    root.addEventListener('scroll',()=>{if(!barMode()) placePop();},{passive:true});
    root.addEventListener('resize',()=>{placeTools();if(desk()&&zoomed()&&!coarse()) setZoom(1);placePop();refit();});
    if(root.visualViewport){
      root.visualViewport.addEventListener('resize',placePop);
      root.visualViewport.addEventListener('scroll',placePop);
    }
    const Observer=root.MutationObserver;
    if(typeof Observer==='function'){
      new Observer(onMutate).observe(stage,{childList:true,subtree:true});
      new Observer(onStep).observe(html,{attributes:true,attributeFilter:['data-booth-step']});
    }
    placeTools();
    syncBar();
    onMutate();
  }

  root.FalsifyBoothPageEdit=Object.freeze({tokenAt,contextWindow,placePopover,fitCrop,overlapShare,paragraphAt,padRect,numericToken,tokensIn,densest,keyboardInset,inkChars,alignInk,spotIn,nearestIndex,unchangedAt,hunksOf,sideAgree,splitWord,fallbackPatch,ZOOM,TABLE_ZOOM,hintBlock,fitZoom});
  const doc=root.document;
  if(!doc||typeof doc.getElementById!=='function') return;
  const start=()=>mount(doc);
  if(doc.getElementById('booth-step-edit')) start();
  else if(doc.readyState==='loading') doc.addEventListener('DOMContentLoaded',start);
  else root.setTimeout(start,0);
})(typeof window==='object'?window:globalThis);
