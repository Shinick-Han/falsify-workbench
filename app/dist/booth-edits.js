/* Booth edit store (event.html only). One flat list; every edit is a place on the page plus new text.
   An edit never needs a text search later: rects are the original glyph boxes the visitor chose.
   BoothEdit = {id, pageIndex, rects:[{x,y,w,h}] (page fractions, top-left origin), originalText, newText,
                source:'tap'|'find'|'paragraph'|'recipe'|'myai', assist?:object}
   Overlap rule: adding an edit removes every older edit whose rects overlap its rects (the newest wins). */
(function(root){
  'use strict';
  const listeners=new Set();
  let edits=[];
  let seq=0;
  function plainRect(r){
    const n=v=>Math.min(1,Math.max(0,Number(v)||0));
    return {x:n(r&&r.x),y:n(r&&r.y),w:n(r&&r.w),h:n(r&&r.h)};
  }
  function overlaps(a, b){
    return a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
  }
  function touches(a, b){
    return a.pageIndex===b.pageIndex&&a.rects.some(r=>b.rects.some(s=>overlaps(r,s)));
  }
  function clean(input){
    const rects=(Array.isArray(input&&input.rects)?input.rects:[]).map(plainRect).filter(r=>r.w>0&&r.h>0);
    if(!rects.length||!Number.isInteger(input.pageIndex)||input.pageIndex<0) throw new TypeError('a booth edit needs a page and at least one rect');
    return {
      id:typeof input.id==='string'&&input.id?input.id:'e-'+(++seq),
      pageIndex:input.pageIndex,
      rects,
      originalText:String(input.originalText==null?'':input.originalText),
      newText:String(input.newText==null?'':input.newText),
      source:typeof input.source==='string'?input.source:'tap',
      ...(input.assist&&typeof input.assist==='object'?{assist:input.assist}:{})
    };
  }
  function emit(){
    const snapshot=list();
    for(const fn of Array.from(listeners)){ try{fn(snapshot);}catch(_e){} }
  }
  function list(){
    return edits.map(e=>({...e,rects:e.rects.map(r=>({...r}))}));
  }
  /* Adds an edit (the newest wins over older overlapping ones). An edit whose new text equals its
     original text is a no-op and only removes what it overlaps. Returns the stored edit or null. */
  function add(input){
    const next=clean(input);
    edits=edits.filter(e=>e.id!==next.id&&!touches(e,next));
    const stored=next.newText===next.originalText?null:next;
    if(stored) edits.push(stored);
    emit();
    return stored?{...stored}:null;
  }
  function update(id, newText){
    const hit=edits.find(e=>e.id===id);
    if(!hit) return null;
    if(String(newText)===hit.originalText){remove(id);return null;}
    hit.newText=String(newText==null?'':newText);
    emit();
    return {...hit};
  }
  function remove(id){
    const before=edits.length;
    edits=edits.filter(e=>e.id!==id);
    if(edits.length!==before) emit();
  }
  function clear(){ if(edits.length){edits=[];emit();} }
  function at(pageIndex, x, y){
    for(let i=edits.length-1;i>=0;i-=1){
      const e=edits[i];
      if(e.pageIndex===pageIndex&&e.rects.some(r=>x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h)) return {...e};
    }
    return null;
  }
  function forPage(pageIndex){ return list().filter(e=>e.pageIndex===pageIndex); }
  function serialize(){ return JSON.stringify(list()); }
  function restore(text){
    let parsed=[];
    try{parsed=JSON.parse(text);}catch(_e){parsed=[];}
    edits=[];
    for(const item of Array.isArray(parsed)?parsed:[]){ try{edits.push(clean(item));}catch(_e){} }
    emit();
    return list();
  }
  function subscribe(fn){ listeners.add(fn); return ()=>listeners.delete(fn); }
  root.FalsifyBoothEdits=Object.freeze({add,update,remove,clear,list,at,forPage,serialize,restore,subscribe,overlaps});
})(typeof window!=='undefined'?window:globalThis);
