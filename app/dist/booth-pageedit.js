/* Event-page in-place editing (alpha.88): the paper page itself is the editor. event.html only.
   A tap on a word of the drawn page (phones: first a 2.5x zoom around the tap, in a pannable box)
   selects that whole token from the PDF text layer, outlines it and opens a small popover with the
   word, 바꾸기, 문단 전체 고치기 and 취소. 바꾸기 locates that exact occurrence in its paragraph and
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
  const FAIL_TEXT={
    overlap:'이미 고친 곳과 겹쳐요. 고친 곳 목록에서 먼저 지워 주세요.',
    ambiguous:'같은 글자가 여러 곳에 있어 한 곳으로 정하지 못했어요. 「문단 전체 고치기」로 고쳐 주세요.',
    not_found:'원문에서 이 글자를 찾지 못했어요. 「문단 전체 고치기」로 고쳐 주세요.',
    no_paper:'논문이 아직 열리지 않았어요.'
  };

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
      return hit&&hit.editable?hit:null;
    }
    function fillPop(sel, patch){
      label.textContent=(sel.pageIndex+1)+'쪽 · '+(patch?'고친 글자 · 원문 '+patch.original:'이 글자 고치기');
      input.value=patch?patch.text:sel.word.text;
      input.setAttribute('inputmode',numericToken(input.value)?'decimal':'text');
      whole.disabled=!sel.paragraph;
    }
    function selectWord(page, word){
      closePop(false);
      const pageIndex=call('getPageIndex');
      if(!word||!Number.isInteger(pageIndex)) return;
      const patchId=patchAt(pageIndex,word.rect);
      const patch=patchId?st.patches.get(patchId):null;
      st.sel={pageIndex,page,word,patchId,paragraph:paragraphFor(word),box:outline(page,word.rect)};
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
      const spot=densest(numberPoints(page),box.width*0.12);
      if(!spot||spot.count<3) return;
      zoomAt(page,box.left+spot.x,box.top+spot.y);
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
    function locate(sel){
      const R=recipe();
      const segs=segmentsNow();
      const edit={find:sel.word.text,context:sel.word.context};
      const seg=sel.paragraph&&segs.find(item=>item.id===sel.paragraph.segmentId);
      if(seg){
        const found=R.locate(edit,[seg]);
        if(found.status==='resolved') return found;
      }
      return R.locate(Object.assign({page:sel.pageIndex+1},edit),segs);
    }
    function deleteEdit(id){
      const list=doc.getElementById('paper-edits');
      const node=list&&[...list.querySelectorAll('[data-act="delete"]')].find(item=>item.dataset.edit===id);
      if(!node||node.disabled) return false;
      node.click();
      return true;
    }
    function failText(result){
      if(result.detail==='overlap') return FAIL_TEXT.overlap;
      return FAIL_TEXT[result.reason]||FAIL_TEXT.not_found;
    }
    function fontOf(span){
      try{const m=patcher().measure(span);if(m&&m.fontPx>0) return m;}catch{}
      return {fontPx:span.getBoundingClientRect().height,baselineFrac:0.8,family:'serif'};
    }
    function paint(id, patch){
      const page=pageEl();
      if(!page||call('getPageIndex')!==patch.pageIndex) return;
      try{patcher().paint(page,{id,pageIndex:patch.pageIndex,rect:patch.rect,text:patch.text,font:patch.font});}catch{}
      coverMarks(page);
    }
    function commitWord(sel, value){
      const R=recipe();
      const found=locate(sel);
      const result=found.status==='resolved'?R.applyFound(found,value):{ok:false,reason:found.status==='ambiguous'?'ambiguous':'not_found'};
      if(!result.ok){status.textContent=failText(result);placePop();return;}
      const font=fontOf(sel.word.span);
      /* x and width from the token's own Range, y and height from measure().rect (baselineFrac refers to it). */
      const line=font.rect&&font.rect.h>0?font.rect:sel.word.rect;
      const rect={x:sel.word.rect.x,w:sel.word.rect.w,y:line.y,h:line.h};
      const patch={pageIndex:sel.pageIndex,rect,text:value,original:sel.word.text,after:result.after,
        font:{fontPx:font.fontPx,baselineFrac:font.baselineFrac,family:font.family}};
      st.patches.set(result.id,patch);
      closePop(true);
      paint(result.id,patch);
    }
    function replaceWord(){
      const sel=st.sel;
      const R=recipe();
      if(!sel) return;
      if(!R||typeof R.applyFound!=='function'){status.textContent=FAIL_TEXT.no_paper;return;}
      const value=input.value;
      const old=sel.patchId?st.patches.get(sel.patchId):null;
      if(value===(old?old.text:sel.word.text)){status.textContent='바뀐 글자가 없어요.';return;}
      if(old&&!deleteEdit(sel.patchId)){status.textContent='이전에 고친 곳을 바꾸지 못했어요. 고친 곳 목록에서 지운 뒤 다시 고쳐 주세요.';return;}
      if(old&&value===old.original){closePop(true);return;}
      commitWord(sel,value);
    }
    async function wholeParagraph(){
      const sel=st.sel;
      if(!sel||!sel.paragraph) return;
      const id=sel.paragraph.segmentId;
      closePop(false);
      st.pending={segmentId:id,rect:sel.paragraph.rect};
      if(zoomed()&&!setZoom(1)) return;
      const ready=await waitFor(()=>hasParagraph(id),6000);
      if(!ready||call('openParagraph',id)!==true){st.pending=null;tip.textContent='이 문단을 열지 못했어요. 다시 눌러 주세요.';}
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
    function syncPatches(){
      const snap=call('getEditSnapshot');
      const edits=snap&&Array.isArray(snap.edits)?snap.edits:[];
      for(const [id,patch] of [...st.patches]){
        const edit=edits.find(item=>item&&item.id===id);
        if(edit&&edit.enabled!==false&&edit.after===patch.after) continue;
        st.patches.delete(id);
        try{patcher().remove(id);}catch{}
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
      const font=fontOf(word.span);
      const line=font.rect&&font.rect.h>0?font.rect:word.rect;
      const patch={pageIndex,rect:{x:word.rect.x,w:word.rect.w,y:line.y,h:line.h},text:change.to,original:change.from,after:edit.after,
        font:{fontPx:font.fontPx,baselineFrac:font.baselineFrac,family:font.family}};
      st.patches.set(edit.id,patch);
      paint(edit.id,patch);
      return true;
    }
    /* Edits whose mark did not lead to their token on this page element are not retried on it. */
    const missed=new WeakMap();
    function adoptEdits(page){
      const pageIndex=call('getPageIndex');
      if(!page||!Number.isInteger(pageIndex)||page.querySelector(':scope>textarea')) return;
      const snap=call('getEditSnapshot');
      for(const edit of snap&&Array.isArray(snap.edits)?snap.edits:[]){
        if(!edit||edit.enabled===false||edit.pageIndex!==pageIndex||st.patches.has(edit.id)) continue;
        const key=edit.id+'|'+edit.after;
        if(!missed.has(page)) missed.set(page,new Set());
        if(missed.get(page).has(key)) continue;
        if(adoptEdit(page,pageIndex,edit)===false) missed.get(page).add(key);
      }
    }
    /* The workspace's change marks for a patched word would sit on top of the patch: hide those. */
    function coverMarks(page){
      if(!page) return;
      for(const mark of page.querySelectorAll('.paper-change-mark')){
        const covered=st.patches.has(mark.dataset.edit||'');
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

  root.FalsifyBoothPageEdit=Object.freeze({tokenAt,contextWindow,placePopover,fitCrop,overlapShare,paragraphAt,padRect,numericToken,tokensIn,densest,keyboardInset,fallbackPatch,ZOOM,TABLE_ZOOM});
  const doc=root.document;
  if(!doc||typeof doc.getElementById!=='function') return;
  const start=()=>mount(doc);
  if(doc.getElementById('booth-step-edit')) start();
  else if(doc.readyState==='loading') doc.addEventListener('DOMContentLoaded',start);
  else root.setTimeout(start,0);
})(typeof window==='object'?window:globalThis);
