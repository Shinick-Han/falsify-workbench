/* Event-page in-place patch renderer (alpha.88 page-edit contract, PE2).
   globalThis.FalsifyBoothPatch: paint, remove, clear, repaint, measure.
   A patch is an absolutely positioned .booth-patch overlay inside a page element, between the page
   canvas and the pdf.js text layer. It covers the old word's box with the page background sampled
   from the canvas (white when the canvas cannot be read) and draws the new word as DOM text in a
   serif face (sans or mono when the hint says so) on the old baseline and at the old em size,
   compressed with scaleX down to 0.7 and overflowing to the right beyond that. Rectangles are page
   fractions, font sizes are kept as a fraction of the page width, so a patch survives zoom, resize
   and re-render through repaint(). Overlays never take pointer events. The module knows nothing
   about the workspace. globalThis.FalsifyBoothPatchCore exposes the pure geometry for tests.
   DOM text is set with textContent only. */
(function(root){
  'use strict';
  const SERIF='"Times New Roman", "Nimbus Roman", "Nimbus Roman No9 L", "Liberation Serif", "Noto Serif", serif';
  const SANS='Helvetica, Arial, "Nimbus Sans", "Liberation Sans", "Noto Sans", sans-serif';
  const MONO='"Courier New", "Nimbus Mono PS", "Liberation Mono", "Noto Sans Mono", monospace';
  const MIN_SCALE_X=0.7;
  const DEFAULT_BASELINE=0.8;
  const FALLBACK_BG='#ffffff';
  /* Ink coverage of the em box: regular Times digits and words measure 0.16-0.21, bold 0.27. */
  const BOLD_COVERAGE=0.235;
  /* How far past the box the old word's ink may reach and still be covered, in em. */
  const INK_REACH=0.6;
  const WORD_GAP=0.16;
  /* Darkness (0..1 below the background) that counts as ink, low enough to catch anti-aliased edges. */
  const INK_FLOOR=0.12;
  /* Cover margin around the old ink, in em; word spaces are about 0.25 em. */
  const INK_PAD=0.07;
  const patches=new Map();
  let metricsCtx=null;

  function finite(n){return typeof n==='number'&&Number.isFinite(n);}
  function clamp01(n){return Math.min(1,Math.max(0,n));}
  function familyFor(hint){
    const text=String(hint||'').toLowerCase();
    if(/mono|courier|typewriter|code/.test(text))return MONO;
    if(/sans|helvet|arial|gothic/.test(text))return SANS;
    return SERIF;
  }
  /* {x,y,w,h} in page fractions, clipped to the page; null when it is not a usable box. */
  function normalizeRect(rect){
    if(!rect||![rect.x,rect.y,rect.w,rect.h].every(finite))return null;
    const x=clamp01(rect.x),y=clamp01(rect.y);
    const w=Math.min(1-x,Math.max(0,rect.w)),h=Math.min(1-y,Math.max(0,rect.h));
    return w>0&&h>0?{x,y,w,h}:null;
  }
  function rectToPx(rect,pageW,pageH){
    return {left:rect.x*pageW,top:rect.y*pageH,width:rect.w*pageW,height:rect.h*pageH};
  }
  /* Horizontal compression so the natural width fits the box: 1 when it fits, never below 0.7. */
  function fitScaleX(naturalW,boxW){
    if(!(naturalW>0)||!(boxW>0)||naturalW<=boxW)return 1;
    return Math.max(MIN_SCALE_X,boxW/naturalW);
  }
  /* Vertical scale of a CSS transform ("none", matrix() or matrix3d()). */
  function transformScale(transform){
    const m=/^matrix(3d)?\(([^)]*)\)$/.exec(String(transform||'').trim());
    if(!m)return {sx:1,sy:1};
    const v=m[2].split(',').map(Number);
    const sx=Math.hypot(v[0],v[1]);
    const sy=m[1]?Math.hypot(v[4],v[5]):Math.hypot(v[2],v[3]);
    return {sx:sx>0?sx:1,sy:sy>0?sy:1};
  }
  /* Font size and baseline of a patch at the current page width. */
  function patchFont(font,rectPx,pageW){
    const frac=font&&finite(font.fontFrac)&&font.fontFrac>0?font.fontFrac:0;
    const fontPx=frac?frac*pageW:rectPx.height;
    const baselineFrac=font&&finite(font.baselineFrac)&&font.baselineFrac>0&&font.baselineFrac<=1.5?font.baselineFrac:DEFAULT_BASELINE;
    return {fontPx,baselineY:baselineFrac*rectPx.height,family:familyFor(font&&font.family)};
  }

  function colourKey(r,g,b){return [r,g,b].map(v=>Math.round(v/4)*4).join(',');}
  function luminance(key){const [r,g,b]=key.split(',').map(Number);return 0.2126*r+0.7152*g+0.0722*b;}
  /* Most frequent opaque colour among samples; ties go to the lighter one. */
  function pickBackground(samples){
    const counts=new Map();
    for(const s of samples){
      if(!s||s.length<4||s[3]<250)continue;
      const key=colourKey(s[0],s[1],s[2]);
      counts.set(key,(counts.get(key)||0)+1);
    }
    let best=null,bestCount=0;
    for(const [key,count] of counts){
      if(count>bestCount||count===bestCount&&luminance(key)>luminance(best)){best=key;bestCount=count;}
    }
    if(!best)return FALLBACK_BG;
    const [r,g,b]=best.split(',').map(v=>Math.min(255,Number(v)));
    return 'rgb('+r+', '+g+', '+b+')';
  }
  /* Backing-store points just outside the box: left, right, above and below, several along each edge. */
  function ringPoints(box,width,height){
    const pad=Math.max(2,Math.round(Math.min(box.w,box.h)*0.08));
    const xs=[0.15,0.5,0.85].map(t=>box.x+box.w*t),ys=[0.25,0.5,0.75].map(t=>box.y+box.h*t);
    const pts=[];
    for(const y of ys){pts.push([box.x-pad,y],[box.x+box.w+pad,y]);}
    for(const x of xs){pts.push([x,box.y-pad],[x,box.y+box.h+pad]);}
    return pts.map(([x,y])=>[Math.round(x),Math.round(y)]).filter(([x,y])=>x>=0&&y>=0&&x<width&&y<height);
  }
  function readPixel(ctx,x,y){
    try{return ctx.getImageData(x,y,1,1).data;}catch{return null;}
  }
  /* rect is in fractions of the canvas box. */
  function readableContext(canvas){
    if(!canvas||!(canvas.width>0)||!(canvas.height>0)||typeof canvas.getContext!=='function')return null;
    let ctx=null;
    try{ctx=canvas.getContext('2d',{willReadFrequently:true});}catch{ctx=null;}
    return ctx&&typeof ctx.getImageData==='function'?ctx:null;
  }
  function backingBox(canvas,box){
    return {x:box.x*canvas.width,y:box.y*canvas.height,w:box.w*canvas.width,h:box.h*canvas.height};
  }
  function sampleBackground(canvas,rect){
    const box=normalizeRect(rect),ctx=box&&readableContext(canvas);
    if(!ctx)return FALLBACK_BG;
    const px=backingBox(canvas,box);
    return pickBackground(ringPoints(px,canvas.width,canvas.height).map(([x,y])=>readPixel(ctx,x,y)));
  }
  function backgroundLum(colour){
    const m=/(\d+),\s*(\d+),\s*(\d+)/.exec(colour);
    return m?0.2126*m[1]+0.7152*m[2]+0.0722*m[3]:255;
  }
  /* The old word's ink around a canvas-fraction box: how far it reaches left and right of the box
     (fractions of the canvas width, never negative) and its weight. Null when the canvas is unreadable. */
  function inkAround(canvas,rect,emFrac,background){
    const box=normalizeRect(rect),ctx=box&&readableContext(canvas);
    if(!ctx)return null;
    const px=backingBox(canvas,box),reach=Math.ceil(INK_REACH*emFrac*canvas.width);
    const x0=Math.max(0,Math.floor(px.x)-reach),x1=Math.min(canvas.width,Math.ceil(px.x+px.w)+reach);
    const y0=Math.max(0,Math.round(px.y)),y1=Math.min(canvas.height,Math.round(px.y+px.h));
    if(x1<=x0||y1<=y0)return null;
    let data=null;
    try{data=ctx.getImageData(x0,y0,x1-x0,y1-y0).data;}catch{return null;}
    const cols=inkColumns(data,x1-x0,y1-y0,backgroundLum(background));
    const ink=wordInk(cols,px.x-x0,px.x+px.w-x0,Math.max(1,WORD_GAP*emFrac*canvas.width));
    const pad=INK_PAD*emFrac*canvas.width;
    const left=ink?Math.max(0,px.x-(x0+ink.start-pad)):0,right=ink?Math.max(0,x0+ink.end+pad-(px.x+px.w)):0;
    return {left:left/canvas.width,right:right/canvas.width,inset:ink?pad/canvas.width:0,weight:inkWeight(cols,ink,y1-y0)};
  }

  function lum(d,i){return 0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];}
  /* Ink per column of an RGBA block (w x h): how much darker than the background each column gets. */
  function inkColumns(data,w,h,bgLum){
    const cols=new Array(w).fill(0);
    const floor=Math.max(1,bgLum);
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const dark=1-lum(data,(y*w+x)*4)/floor;
        if(dark>INK_FLOOR)cols[x]+=dark;
      }
    }
    return cols;
  }
  /* Runs of inked columns; gaps narrower than gapMin stay inside one word. */
  function inkClusters(cols,gapMin){
    const out=[];let cur=null,gap=0;
    cols.forEach((v,x)=>{
      if(v>0){
        if(cur&&gap<gapMin)cur.end=x+1;else{cur={start:x,end:x+1};out.push(cur);}
        gap=0;
      }else gap++;
    });
    return out;
  }
  /* Ink of the word the box points at: clusters mostly inside [lo,hi) or holding its centre.
     Returns {start,end} in block columns, or null when the box holds no ink. */
  function wordInk(cols,lo,hi,gapMin){
    const mid=(lo+hi)/2;
    const picked=inkClusters(cols,gapMin).filter(c=>{
      const overlap=Math.min(hi,c.end)-Math.max(lo,c.start);
      return overlap>0.3*(c.end-c.start)||c.start<=mid&&mid<c.end;
    });
    if(!picked.length)return null;
    return {start:Math.min(...picked.map(c=>c.start)),end:Math.max(...picked.map(c=>c.end))};
  }
  /* Bold when the word's ink covers more of its em box than regular text does. */
  function inkWeight(cols,ink,h){
    if(!ink||!(h>0))return 400;
    let sum=0;
    for(let x=ink.start;x<ink.end;x++)sum+=cols[x];
    return sum/((ink.end-ink.start)*h)>BOLD_COVERAGE?700:400;
  }

  function fontMetrics(doc,family,size){
    try{
      if(!metricsCtx)metricsCtx=doc.createElement('canvas').getContext('2d');
      metricsCtx.font=size+'px '+family;
      const m=metricsCtx.measureText('');
      const ascent=m.fontBoundingBoxAscent,descent=Math.abs(m.fontBoundingBoxDescent);
      if(ascent>0&&descent>=0)return {ascent,descent};
    }catch{/* measured below */}
    return {ascent:0.89*size,descent:0.22*size};
  }
  /* pdf.js places a text-layer span's top at baseline - ascent * em, with the ascent ratio measured
     the same way for the span's fallback family (TextLayer #getAscent). */
  function ascentRatio(doc,family){
    const m=fontMetrics(doc,family,100);
    return m.ascent>0?m.ascent/(m.ascent+m.descent):DEFAULT_BASELINE;
  }

  function pageBox(pageEl){
    return {w:pageEl.clientWidth||pageEl.offsetWidth||0,h:pageEl.clientHeight||pageEl.offsetHeight||0};
  }
  function pageCanvas(pageEl){
    return [...pageEl.children].find(node=>node.tagName==='CANVAS')||null;
  }
  /* Page rect fractions to fractions of the canvas box (the canvas may be inset by a border). */
  function canvasRect(pageEl,canvas,rect){
    const page=pageBox(pageEl),cw=canvas.clientWidth||page.w,ch=canvas.clientHeight||page.h;
    if(!(cw>0)||!(ch>0))return rect;
    const left=canvas.offsetLeft+(canvas.clientLeft||0),top=canvas.offsetTop+(canvas.clientTop||0);
    return {x:(rect.x*page.w-left)/cw,y:(rect.y*page.h-top)/ch,w:rect.w*page.w/cw,h:rect.h*page.h/ch};
  }
  function insertOverlay(pageEl,overlay){
    const layer=[...pageEl.children].find(node=>node.classList&&node.classList.contains('textLayer'));
    if(layer)pageEl.insertBefore(overlay,layer);else pageEl.append(overlay);
  }
  function detach(patch){
    if(patch&&patch.el&&patch.el.parentNode)patch.el.parentNode.removeChild(patch.el);
    if(patch)patch.el=null;
  }
  /* Background and old-ink reach for a patch, in page CSS pixels. */
  function readPage(pageEl,patch,font,page){
    const canvas=pageCanvas(pageEl);
    if(!canvas)return {background:FALLBACK_BG,left:0,right:0,inset:0,weight:400};
    const crect=canvasRect(pageEl,canvas,patch.rect);
    const background=sampleBackground(canvas,crect);
    const cw=canvas.clientWidth||page.w;
    const ink=inkAround(canvas,crect,font.fontPx/cw,background);
    if(!ink)return {background,left:0,right:0,inset:0,weight:400};
    return {background,left:ink.left*cw,right:ink.right*cw,inset:Math.min(ink.left,ink.inset)*cw,weight:ink.weight};
  }
  function buildOverlay(doc,patch,look){
    const overlay=doc.createElement('div');
    overlay.className='booth-patch';
    overlay.dataset.patchId=patch.id;overlay.dataset.pageIndex=String(patch.pageIndex);
    overlay.setAttribute('aria-hidden','true');
    const st=overlay.style;
    st.left=(patch.rect.x*100)+'%';st.top=(patch.rect.y*100)+'%';
    st.width=(patch.rect.w*100)+'%';st.height=(patch.rect.h*100)+'%';
    st.backgroundColor=look.background;
    const cover=doc.createElement('span');
    cover.className='booth-patch-cover';
    cover.style.left=(-look.left)+'px';cover.style.right=(-look.right)+'px';
    cover.style.backgroundColor=look.background;
    overlay.append(cover);
    return overlay;
  }
  function buildText(doc,patch,font,look){
    const text=doc.createElement('span');
    text.className='booth-patch-text';
    text.textContent=patch.text;
    const metrics=fontMetrics(doc,font.family,font.fontPx);
    const ts=text.style;
    ts.fontFamily=font.family;ts.fontSize=font.fontPx+'px';ts.fontWeight=String(look.weight);
    ts.lineHeight=(metrics.ascent+metrics.descent)+'px';
    ts.top=(font.baselineY-metrics.ascent)+'px';
    /* The new word starts where the old ink started (the cover margin is not part of the word). */
    ts.left=(look.inset-look.left)+'px';
    return text;
  }
  function draw(pageEl,patch){
    detach(patch);
    const doc=pageEl.ownerDocument,page=pageBox(pageEl);
    const px=rectToPx(patch.rect,page.w,page.h);
    const font=patchFont(patch.font,px,page.w);
    const look=readPage(pageEl,patch,font,page);
    if(patch.font.weight)look.weight=patch.font.weight;
    const overlay=buildOverlay(doc,patch,look),text=buildText(doc,patch,font,look);
    overlay.append(text);
    insertOverlay(pageEl,overlay);
    const natural=text.getBoundingClientRect().width,zoom=page.w>0?overlay.getBoundingClientRect().width/px.width:1;
    const box=(px.width+look.left+look.right-look.inset)*(zoom>0?zoom:1);
    const scale=fitScaleX(natural,box);
    text.style.transform=scale<1?'scaleX('+scale+')':'';
    overlay.classList.toggle('booth-patch-overflow',natural*scale>box+0.5);
    patch.el=overlay;patch.pageEl=pageEl;
  }

  function weightHint(weight){
    if(weight==='bold'||Number(weight)>=600)return 700;
    return weight==='normal'||Number(weight)>0?400:0;
  }
  /* The caller's font at paint time, stored relative to the page width (weight 0: read from the ink). */
  function storedFont(f,pageW){
    const fontPx=finite(f.fontPx)&&f.fontPx>0?f.fontPx:0;
    return {fontFrac:fontPx&&pageW>0?fontPx/pageW:0,baselineFrac:f.baselineFrac,family:f.family,weight:weightHint(f.weight)};
  }
  function paint(pageEl,spec){
    if(!pageEl||typeof pageEl.appendChild!=='function')throw new TypeError('FalsifyBoothPatch.paint: pageEl');
    const s=spec||{};
    const rect=normalizeRect(s.rect);
    if(s.id==null||String(s.id)===''||!rect)throw new TypeError('FalsifyBoothPatch.paint: id and rect are required');
    const id=String(s.id);
    if(patches.has(id))remove(id);
    const font=storedFont(s.font||{},pageBox(pageEl).w);
    const patch={id,pageIndex:Number(s.pageIndex),rect,text:String(s.text==null?'':s.text),font,el:null,pageEl:null};
    patches.set(id,patch);
    draw(pageEl,patch);
  }
  function remove(id){
    const key=String(id);
    detach(patches.get(key));
    patches.delete(key);
  }
  function clear(){
    for(const patch of patches.values())detach(patch);
    patches.clear();
  }
  /* Draw every patch of pageIndex into pageEl at its current size; stale overlays in pageEl go. */
  function repaint(pageEl,pageIndex){
    if(!pageEl||typeof pageEl.querySelectorAll!=='function')return;
    const index=Number(pageIndex);
    for(const node of [...pageEl.querySelectorAll('.booth-patch')]){
      const patch=patches.get(node.dataset.patchId);
      if(!patch||patch.el!==node||patch.pageIndex!==index)node.remove();
    }
    for(const patch of patches.values()){
      if(patch.pageIndex===index)draw(pageEl,patch);
    }
  }
  /* fontPx, baseline and family from a pdf.js text-layer span; rect is its box in page fractions. */
  function measure(span){
    const doc=span.ownerDocument,view=doc.defaultView;
    const cs=view.getComputedStyle(span);
    const scale=transformScale(cs.transform);
    const fontPx=(parseFloat(cs.fontSize)||0)*scale.sy;
    const pageEl=span.closest('.paper-page')||span.closest('.textLayer')?.parentElement||span.offsetParent||span.parentElement;
    const page=pageEl.getBoundingClientRect(),box=span.getBoundingClientRect();
    const zoom=page.width>0&&pageEl.offsetWidth>0?page.width/pageEl.offsetWidth:1;
    /* pdf.js names only a generic fallback ("sans-serif" for most embedded LaTeX fonts), so only
       monospace is trusted; body and table text are drawn serif. */
    const family=/monospace/i.test(cs.fontFamily)?'mono':'serif';
    const baselinePx=ascentRatio(doc,cs.fontFamily||'serif')*fontPx*zoom;
    const rect={x:(box.left-page.left)/page.width,y:(box.top-page.top)/page.height,w:box.width/page.width,h:box.height/page.height};
    return {fontPx,baselineFrac:box.height>0?baselinePx/box.height:DEFAULT_BASELINE,family,rect};
  }

  root.FalsifyBoothPatch={paint,remove,clear,repaint,measure};
  root.FalsifyBoothPatchCore={normalizeRect,rectToPx,fitScaleX,transformScale,patchFont,pickBackground,ringPoints,sampleBackground,inkColumns,inkClusters,wordInk,inkWeight,familyFor,MIN_SCALE_X,FALLBACK_BG};
})(globalThis);
