/* Event-page defect recipes (falsify.booth.recipe.v1) and find-and-replace editing on BoothEdit.
   globalThis.FalsifyBoothRecipe: validate, apply, fromCode, pageText, paperInfo, currentPage,
   setAssist, assist, normalizeCode, normalizeText, indexPage, locate, searchHits, codeFromText,
   expiryText, SCHEMA.
   Builds one per-page text index from pdf.js getTextContent (or the rendered text layer) with
   page-fraction rects for every hit, using light normalisation (NFKC, whitespace, hyphens and
   look-alikes). Find-and-replace, recipes and 내 AI all add BoothEdit records directly to
   FalsifyBoothEdits with exact rects. DOM text is set with textContent only. */
(function(root){
  'use strict';
  const SCHEMA='falsify.booth.recipe.v1';
  const TOP_KEYS=new Set(['schema','paperId','edits','defectType','reason','source','agent']);
  const SERVER_KEYS=['code','createdAt','expiresAt'];
  const SOURCES=['manual','my-ai','agent'];
  const DEFECT_IDS=['number','figure','citation','logic','method','other'];
  const DEFECT_LABELS={number:'수치·통계',figure:'그림·표',citation:'인용·출처',logic:'논리·결론',method:'방법·실험 설계',other:'기타'};
  const PAPER_ID=/^(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/;
  const CODE=/^R-[0-9A-HJKMNP-TV-Z]{6}$/;
  /* C0, DEL, C1 and the bidi marks, embeddings, overrides and isolates (same set as the server). */
  const CONTROL=/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  const CONTROL_NL=/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  const EDIT_KEYS=new Set(['page','find','replace','context']);
  const SOFT_HYPHEN='\u00ad';
  const ZERO_WIDTH=/[\u200b-\u200d\u2060]/;
  /* Typographic look-alikes typed as plain ASCII: curly quotes, primes, dashes and minus. */
  const FOLD={'\u2018':"'",'\u2019':"'",'\u201a':"'",'\u201b':"'",'\u2032':"'",'\u00b4':"'",'`':"'",
    '\u201c':'"','\u201d':'"','\u201e':'"','\u201f':'"','\u2033':'"',
    '\u2010':'-','\u2011':'-','\u2012':'-','\u2013':'-','\u2014':'-','\u2015':'-','\u2212':'-','\ufe63':'-','\uff0d':'-'};
  const TIERS=[[false,0],[true,0],[false,1],[true,1],[false,2],[true,2]];
  const TIGHT_MIN=4;
  const WS=/\s/;
  const LETTER=/\p{L}/u;
  const MAX_BYTES=8192;
  const HIT_LIMIT=20;
  const SNIP=28;
  const WINDOW=40;
  const SIDE_MIN=8;
  const ERROR_TEXT={
    invalid_code:'코드 형식을 확인해 주세요. 예: R-7K3QXM',
    not_found:'이 코드로 찾은 레시피가 없어요. 코드를 다시 확인해 볼까요? 레시피는 6시간 동안 쓸 수 있어요.',
    invalid_recipe:'레시피 형식이 맞지 않아요. 코드를 다시 확인해 볼까요?',
    rate_limited:'지금 요청이 몰려 있어요. 잠시 뒤 다시 눌러 주세요.',
    network:'서버에 연결하지 못했어요. 네트워크를 확인해 주세요.',
    no_paper:'레시피의 논문을 열지 못했어요. 「불러오기」를 다시 눌러 주세요.'
  };
  const REASON_TEXT={
    not_found:'찾는 글자가 이 논문에 없어요.',
    ambiguous:'같은 글자가 여러 곳에 있어요. 바꿀 곳을 눌러 주세요.',
    no_paper:'논문이 아직 열리지 않았어요. 잠시 뒤 「바꾸기」를 다시 눌러 주세요.',
    unchanged:'새 글자가 원문과 같아요.'
  };

  /* ---------- validation (contract §1) ---------- */
  function isPlain(value){
    return !!value&&typeof value==='object'&&!Array.isArray(value);
  }
  function utf8Length(text){
    return typeof TextEncoder==='function'?new TextEncoder().encode(text).length:text.length*3;
  }
  function jsonSize(obj){
    try{return utf8Length(JSON.stringify(obj));}catch{return Infinity;}
  }
  function codePoints(text){
    return [...text].length;
  }
  function checkText(errors, field, value, rule){
    if(value===undefined&&rule.optional) return;
    if(typeof value!=='string'){errors.push({field,code:'type'});return;}
    if(codePoints(value)>rule.max){errors.push({field,code:'too_long'});return;}
    if((rule.newline?CONTROL_NL:CONTROL).test(value)){errors.push({field,code:'control'});return;}
    const body=rule.trim?value.trim():value;
    if(body.length<(rule.min||0)) errors.push({field,code:'empty'});
  }
  function checkPage(errors, field, page){
    if(page===undefined) return;
    if(!Number.isInteger(page)||page<1||page>500) errors.push({field,code:'page'});
  }
  function checkEdit(errors, edit, i){
    const at='edits['+i+']';
    if(!isPlain(edit)){errors.push({field:at,code:'type'});return;}
    for(const key of Object.keys(edit)){
      if(!EDIT_KEYS.has(key)) errors.push({field:at+'.'+key,code:'unknown'});
    }
    checkPage(errors,at+'.page',edit.page);
    checkText(errors,at+'.find',edit.find,{max:300,min:1,trim:true});
    checkText(errors,at+'.replace',edit.replace,{max:300});
    checkText(errors,at+'.context',edit.context,{max:600,newline:true,optional:true});
    if(typeof edit.find==='string'&&edit.replace===edit.find) errors.push({field:at+'.replace',code:'unchanged'});
  }
  function checkEdits(errors, edits){
    if(!Array.isArray(edits)||edits.length<1||edits.length>5){errors.push({field:'edits',code:'count'});return;}
    edits.forEach((edit,i)=>checkEdit(errors,edit,i));
  }
  function checkAgent(errors, agent){
    if(agent===undefined) return;
    if(!isPlain(agent)){errors.push({field:'agent',code:'type'});return;}
    for(const key of Object.keys(agent)){
      if(key!=='name'&&key!=='model') errors.push({field:'agent.'+key,code:'unknown'});
    }
    checkText(errors,'agent.name',agent.name,{max:60,optional:true});
    checkText(errors,'agent.model',agent.model,{max:60,optional:true});
  }
  function checkTop(errors, obj){
    for(const key of Object.keys(obj)){
      if(!TOP_KEYS.has(key)) errors.push({field:key,code:'unknown'});
    }
    if(obj.schema!==undefined&&obj.schema!==SCHEMA) errors.push({field:'schema',code:'schema'});
    if(typeof obj.paperId!=='string'||!PAPER_ID.test(obj.paperId)) errors.push({field:'paperId',code:'paper'});
    if(!SOURCES.includes(obj.source)) errors.push({field:'source',code:'source'});
    if(obj.defectType!==undefined&&!DEFECT_IDS.includes(obj.defectType)) errors.push({field:'defectType',code:'defect_type'});
    checkText(errors,'reason',obj.reason,{max:500,newline:true,optional:true});
  }
  function validate(obj){
    const errors=[];
    if(!isPlain(obj)) return {ok:false,errors:[{field:'',code:'type'}]};
    if(jsonSize(obj)>MAX_BYTES) return {ok:false,errors:[{field:'',code:'too_large'}]};
    checkTop(errors,obj);
    checkEdits(errors,obj.edits);
    checkAgent(errors,obj.agent);
    return {ok:errors.length===0,errors};
  }
  function withoutServerKeys(recipe){
    const copy=Object.assign({},recipe);
    for(const key of SERVER_KEYS) delete copy[key];
    return copy;
  }
  /* Crockford: case-insensitive, O reads as 0 and I/L as 1, the R- prefix optional. */
  function normalizeCode(value){
    if(typeof value!=='string') return '';
    const text=value.trim().toUpperCase().replace(/\s+/g,'');
    const body=text.startsWith('R-')?text.slice(2):text;
    const normal='R-'+body.replace(/O/g,'0').replace(/[IL]/g,'1');
    return CODE.test(normal)?normal:'';
  }
  function codeFromText(text){
    const match=/#recipe=([A-Za-z0-9-]{6,12})(?![A-Za-z0-9-])/.exec(String(text||''));
    return match?match[1]:'';
  }
  function expiryText(iso, now){
    const at=new Date(typeof iso==='string'?iso:NaN);
    if(Number.isNaN(at.getTime())) return '';
    const today=now&&typeof now.getFullYear==='function'?now:new Date();
    const pad=n=>String(n).padStart(2,'0');
    const time=pad(at.getHours())+':'+pad(at.getMinutes());
    const same=at.getFullYear()===today.getFullYear()&&at.getMonth()===today.getMonth()&&at.getDate()===today.getDate();
    return (same?'오늘 ':(at.getMonth()+1)+'월 '+at.getDate()+'일 ')+time+'까지 유효';
  }

  /* ---------- per-page text index with page-fraction rects ---------- */
  function clamp01(v){
    const n=Number(v);
    if(!Number.isFinite(n)) return 0;
    return n<0?0:(n>1?1:n);
  }
  function plainRect(r){
    if(!r||typeof r!=='object') return null;
    const x=clamp01(r.x);
    const y=clamp01(r.y);
    const w=Math.min(1-x,Math.max(0,Number(r.w)||0));
    const h=Math.min(1-y,Math.max(0,Number(r.h)||0));
    return w>0&&h>0?{x,y,w,h}:null;
  }
  function mulMat(m1, m2){
    return [
      m1[0]*m2[0]+m1[2]*m2[1],
      m1[1]*m2[0]+m1[3]*m2[1],
      m1[0]*m2[2]+m1[2]*m2[3],
      m1[1]*m2[2]+m1[3]*m2[3],
      m1[0]*m2[4]+m1[2]*m2[5]+m1[4],
      m1[1]*m2[4]+m1[3]*m2[5]+m1[5]
    ];
  }
  function viewportDims(viewport){
    const W=Number(viewport&&viewport.width)||0;
    const H=Number(viewport&&viewport.height)||0;
    if(!(W>0&&H>0)) return null;
    const vt=Array.isArray(viewport.transform)&&viewport.transform.length>=6?viewport.transform:[1,0,0,-1,0,H];
    return {W,H,vt};
  }
  function itemBounds(tx, item){
    const hLen=Math.hypot(tx[0],tx[1])||1;
    const vLen=Math.hypot(tx[2],tx[3])||hLen;
    const fontH=(Number(item.height)>0?Number(item.height):vLen)||10;
    const rawW=Number(item.width);
    const itemW=rawW>0?rawW:Math.max(fontH*0.5*String(item.str||'').length,1);
    const ux=tx[0]/hLen;
    const uy=tx[1]/hLen;
    const vx=tx[2]/vLen;
    const vy=tx[3]/vLen;
    const ox=tx[4];
    const oy=tx[5];
    const bx=ox+ux*itemW;
    const by=oy+uy*itemW;
    const asc=0.85*fontH;
    const desc=0.20*fontH;
    return {
      xs:[ox-desc*vx,bx-desc*vx,ox+asc*vx,bx+asc*vx],
      ys:[oy-desc*vy,by-desc*vy,oy+asc*vy,by+asc*vy]
    };
  }
  function isRotatedTransform(tx){
    const hLen=Math.hypot(tx[0],tx[1]);
    if(!(hLen>0)) return false;
    return tx[0]/hLen<0.99||Math.abs(tx[1]/hLen)>0.05;
  }
  function itemRotated(item, viewport){
    if(item&&typeof item.rotated==='boolean') return item.rotated;
    const dims=viewportDims(viewport);
    const t=item&&Array.isArray(item.transform)&&item.transform.length>=6?item.transform:null;
    return !!(dims&&t&&isRotatedTransform(mulMat(dims.vt,t)));
  }
  /* pdf.js getTextContent item -> page-fraction rect on the displayed viewport (top-left origin). */
  function itemRect(item, viewport){
    if(item&&item.rect) return plainRect(item.rect);
    const dims=viewportDims(viewport);
    const t=item&&Array.isArray(item.transform)&&item.transform.length>=6?item.transform:null;
    if(!dims||!t) return null;
    const {xs,ys}=itemBounds(mulMat(dims.vt,t),item);
    const x0=clamp01(Math.min(...xs)/dims.W);
    const x1=clamp01(Math.max(...xs)/dims.W);
    const y0=clamp01(Math.min(...ys)/dims.H);
    const y1=clamp01(Math.max(...ys)/dims.H);
    return x1>x0&&y1>y0?{x:x0,y:y0,w:x1-x0,h:y1-y0}:null;
  }
  function sameLine(a, b){
    const cyA=a.y+a.h/2;
    const cyB=b.y+b.h/2;
    return Math.abs(cyA-cyB)<0.55*Math.min(a.h,b.h);
  }
  function unionRect(a, b){
    const x=Math.min(a.x,b.x);
    const y=Math.min(a.y,b.y);
    const x2=Math.max(a.x+a.w,b.x+b.w);
    const y2=Math.max(a.y+a.h,b.y+b.h);
    return {x,y,w:x2-x,h:y2-y};
  }
  function mergeLineRects(list){
    const merged=[];
    for(const raw of list){
      const r=plainRect(raw);
      if(!r) continue;
      const prev=merged[merged.length-1];
      if(prev&&sameLine(prev,r)&&r.x>=prev.x-0.01&&r.x<=prev.x+prev.w+0.04){
        merged[merged.length-1]=unionRect(prev,r);
      }else{
        merged.push(r);
      }
    }
    return merged;
  }
  function itemSeparator(text, str, prevEol, prevRect, rect){
    if(!text||WS.test(text[text.length-1])||WS.test(str[0])) return '';
    if(prevEol) return '\n';
    if(!prevRect||!rect) return ' ';
    if(!sameLine(prevRect,rect)) return '\n';
    return rect.x-(prevRect.x+prevRect.w)>0.18*(rect.h/1.05)?' ':'';
  }
  function appendTextItem(state, item, viewport){
    if(!item||typeof item.str!=='string') return;
    if(!item.str){
      if(item.hasEOL&&state.text&&!state.text.endsWith('\n')) state.text+='\n';
      state.prevEol=!!item.hasEOL;
      return;
    }
    const rect=itemRect(item,viewport);
    state.text+=itemSeparator(state.text,item.str,state.prevEol,state.prevRect,rect);
    const start=state.text.length;
    state.text+=item.str;
    if(rect){
      const span={start,end:state.text.length,rect};
      if(itemRotated(item,viewport)) span.rotated=true;
      state.spans.push(span);
    }
    if(item.hasEOL&&!state.text.endsWith('\n')) state.text+='\n';
    state.prevRect=rect||state.prevRect;
    state.prevEol=!!item.hasEOL;
  }
  /* Build one indexed page from pdf.js items (or synthetic items with .rect). */
  function indexItems(pageIndex, items, viewport){
    const state={text:'',spans:[],prevRect:null,prevEol:false};
    for(const item of Array.isArray(items)?items:[]) appendTextItem(state,item,viewport);
    return {pageIndex,text:state.text,spans:state.spans};
  }
  /* Fallback synthetic line rects when a caller passes plain text without item rects. */
  function indexPlainText(pageIndex, text){
    const src=typeof text==='string'?text:'';
    const lines=src.split('\n');
    const spans=[];
    const step=Math.min(0.04,0.8/Math.max(lines.length,1));
    let at=0;
    for(let i=0;i<lines.length;i+=1){
      const line=lines[i];
      if(line.length){
        spans.push({start:at,end:at+line.length,rect:{x:0.05,y:Math.min(0.95,0.05+i*step),w:0.9,h:Math.max(0.012,step*0.8)}});
      }
      at+=line.length+1;
    }
    return {pageIndex,text:src,spans};
  }
  function indexPage(raw){
    if(!raw||typeof raw!=='object'||!Number.isSafeInteger(raw.pageIndex)||raw.pageIndex<0) return null;
    if(typeof raw.text==='string'&&Array.isArray(raw.spans)){
      const spans=raw.spans.filter(s=>s&&Number.isSafeInteger(s.start)&&Number.isSafeInteger(s.end)&&s.end>s.start&&plainRect(s.rect))
        .map(s=>s.rotated?{start:s.start,end:s.end,rect:plainRect(s.rect),rotated:true}:{start:s.start,end:s.end,rect:plainRect(s.rect)});
      return {pageIndex:raw.pageIndex,text:raw.text,spans};
    }
    if(Array.isArray(raw.items)) return indexItems(raw.pageIndex,raw.items,raw.viewport);
    if(typeof raw.text==='string') return indexPlainText(raw.pageIndex,raw.text);
    return null;
  }
  function normalizePages(list){
    return (Array.isArray(list)?list:[]).map(indexPage).filter(Boolean);
  }
  function spanSliceRect(span, start, end){
    const r=span.rect;
    if(span.rotated) return {x:r.x,y:r.y,w:r.w,h:r.h};
    const len=Math.max(1,span.end-span.start);
    const s0=Math.max(0,start-span.start);
    const s1=Math.min(len,end-span.start);
    const f0=s0/len;
    const f1=s1/len;
    return {x:r.x+r.w*f0,y:r.y,w:Math.max(0.002,r.w*(f1-f0)),h:r.h};
  }
  function rectsForSpan(page, start, end){
    const parts=[];
    for(const span of page.spans||[]){
      if(span.end<=start||span.start>=end) continue;
      parts.push(spanSliceRect(span,start,end));
    }
    const merged=mergeLineRects(parts);
    if(merged.length) return merged;
    return [{x:0.05,y:0.05,w:0.2,h:0.02}];
  }

  /* ---------- light normalisation and matching ---------- */
  function hyphenBreak(text, i){
    if(i===0||!LETTER.test(text[i-1])) return -1;
    let j=i+1;
    let newline=false;
    while(j<text.length&&WS.test(text[j])){
      if(text[j]==='\n'||text[j]==='\r') newline=true;
      j+=1;
    }
    return newline&&j<text.length&&LETTER.test(text[j])?j:-1;
  }
  function pushChars(out, chars, start, end){
    for(let k=0;k<chars.length;k+=1){out.chars.push(chars[k]);out.start.push(start);out.end.push(end);}
  }
  function spaceRun(text, i){
    let j=i+1;
    while(j<text.length&&WS.test(text[j])) j+=1;
    return j;
  }
  function folded(chunk){
    let out='';
    for(const c of chunk) out+=FOLD[c]||c;
    return out.toLowerCase();
  }
  function stepNormal(out, text, i, keepHyphen, mode){
    const ch=text[i];
    if(ch===SOFT_HYPHEN||ZERO_WIDTH.test(ch)) return i+1;
    if(ch==='-'||(mode>0&&FOLD[ch]==='-')){
      const j=hyphenBreak(text,i);
      if(j>0){if(keepHyphen) pushChars(out,'-',i,i+1);return j;}
    }
    if(WS.test(ch)){
      const j=spaceRun(text,i);
      if(out.chars.length&&mode<2) pushChars(out,' ',i,j);
      return j;
    }
    const len=text.codePointAt(i)>0xffff?2:1;
    const chunk=text.slice(i,i+len).normalize('NFKC');
    pushChars(out,mode>0?folded(chunk):chunk,i,i+len);
    return i+len;
  }
  /* NFKC, whitespace runs, line-end hyphenation and (mode 1+) look-alikes/case, keeping original offsets. */
  function normalizeText(text, keepHyphen, mode){
    const source=typeof text==='string'?text:'';
    const level=mode===1||mode===2?mode:0;
    const out={chars:[],start:[],end:[]};
    let i=0;
    while(i<source.length) i=stepNormal(out,source,i,!!keepHyphen,level);
    while(out.chars.length&&out.chars[out.chars.length-1]===' '){out.chars.pop();out.start.pop();out.end.pop();}
    return {text:out.chars.join(''),start:out.start,end:out.end};
  }
  const normCache=new Map();
  function normalized(text, keepHyphen, mode){
    const key=(keepHyphen?'1':'0')+(mode||0)+text;
    let hit=normCache.get(key);
    if(hit) return hit;
    hit=normalizeText(text,keepHyphen,mode);
    if(normCache.size>300) normCache.clear();
    normCache.set(key,hit);
    return hit;
  }
  function hitsIn(page, needle, keepHyphen, mode){
    const norm=normalized(page.text,keepHyphen,mode);
    const hits=[];
    let at=norm.text.indexOf(needle);
    while(at>=0&&hits.length<1000){
      const start=norm.start[at];
      const end=norm.end[at+needle.length-1];
      hits.push({page,norm,needle,mode:mode||0,at,len:needle.length,start,end});
      at=norm.text.indexOf(needle,at+1);
    }
    return hits;
  }
  function scan(pages, find){
    if(!normalizeText(find,false,0).text) return [];
    for(const [keep,mode] of TIERS){
      const needle=normalizeText(find,keep,mode).text;
      if(!needle||(mode===2&&needle.length<TIGHT_MIN)) continue;
      const hits=[];
      for(const page of pages) hits.push(...hitsIn(page,needle,keep,mode));
      if(hits.length) return hits;
    }
    return [];
  }
  function sideMatch(ctx, k, hit){
    const text=hit.norm.text;
    let back=0;
    while(k-1-back>=0&&hit.at-1-back>=0&&ctx[k-1-back]===text[hit.at-1-back]) back+=1;
    let fwd=0;
    const c0=k+hit.needle.length;
    const t0=hit.at+hit.len;
    while(c0+fwd<ctx.length&&t0+fwd<text.length&&ctx[c0+fwd]===text[t0+fwd]) fwd+=1;
    return back+fwd;
  }
  function windowOf(hit, n){
    const norm=hit.norm;
    const from=Math.max(0,hit.at-n);
    const to=Math.min(norm.text.length,hit.at+hit.len+n);
    return to>from?hit.page.text.slice(norm.start[from],norm.end[to-1]):'';
  }
  function wordScore(ctx, hit){
    const around=windowOf(hit,ctx.length);
    return ctx.split(' ').filter(word=>word.length>1&&around.includes(word)).length;
  }
  function contextScore(context, hit){
    const ctx=normalizeText(context||'',false,hit.mode).text;
    const out={score:0,matched:0,words:0,room:Math.max(0,ctx.length-hit.needle.length)};
    if(!ctx) return out;
    const middle=(ctx.length-hit.needle.length)/2;
    let k=ctx.indexOf(hit.needle);
    while(k>=0){
      const matched=sideMatch(ctx,k,hit);
      const score=matched*1000-Math.abs(k-middle);
      if(matched>0&&score>out.score) Object.assign(out,{score,matched});
      k=ctx.indexOf(hit.needle,k+1);
    }
    out.words=wordScore(ctx,hit);
    return out;
  }
  function pickHit(hits, context){
    if(!hits.length) return {status:'none'};
    if(hits.length===1) return {status:'hit',hit:hits[0]};
    const scored=hits.map(hit=>Object.assign({hit},contextScore(context,hit)));
    const best=(list,key)=>list.slice().sort((a,b)=>b[key]-a[key]);
    const bySide=best(scored,'score');
    const top=bySide[0];
    if(top.matched>=Math.min(SIDE_MIN,top.room)&&top.matched>0&&top.score>bySide[1].score) return {status:'hit',hit:top.hit};
    const byWords=best(scored,'words');
    if(byWords[0].words>=2&&byWords[0].words>byWords[1].words) return {status:'hit',hit:byWords[0].hit};
    return {status:'ambiguous',count:hits.length};
  }
  function snippetOf(hit){
    const text=hit.norm.text;
    const from=Math.max(0,hit.at-SNIP);
    const to=Math.min(text.length,hit.at+hit.len+SNIP);
    return {
      lead:(from>0?'…':'')+text.slice(from,hit.at),
      hit:text.slice(hit.at,hit.at+hit.len),
      tail:text.slice(hit.at+hit.len,to)+(to<text.length?'…':'')
    };
  }
  function hitRecord(hit){
    return {
      pageIndex:hit.page.pageIndex,
      start:hit.start,
      end:hit.end,
      originalText:hit.page.text.slice(hit.start,hit.end),
      rects:rectsForSpan(hit.page,hit.start,hit.end),
      context:windowOf(hit,WINDOW),
      snippet:snippetOf(hit)
    };
  }
  function locateIn(pages, edit){
    const hits=scan(pages,edit.find);
    const picked=pickHit(hits,edit.context);
    if(picked.status==='hit'){
      const rec=hitRecord(picked.hit);
      return {status:'resolved',pageIndex:rec.pageIndex,rects:rec.rects,originalText:rec.originalText,start:rec.start,end:rec.end,window:rec.context};
    }
    return picked.status==='ambiguous'?{status:'ambiguous',count:picked.count}:{status:'not_found'};
  }
  /* Page first (1-based edit.page), then the whole paper. */
  function locate(edit, pageList){
    const pages=normalizePages(pageList);
    if(!edit||typeof edit.find!=='string') return {status:'not_found'};
    if(Number.isInteger(edit.page)){
      const onPage=locateIn(pages.filter(p=>p.pageIndex===edit.page-1),edit);
      if(onPage.status!=='not_found') return onPage;
    }
    return locateIn(pages,edit);
  }
  /* Live hit list: current page first, then page order; every item carries its exact rects. */
  function searchHits(pageList, find, currentPage, limit){
    const pages=normalizePages(pageList);
    const hits=scan(pages,find||'');
    const rank=hit=>(hit.page.pageIndex===currentPage?-1:hit.page.pageIndex);
    hits.sort((a,b)=>rank(a)-rank(b)||a.page.pageIndex-b.page.pageIndex||a.at-b.at);
    const max=limit||HIT_LIMIT;
    return {
      total:hits.length,
      more:Math.max(0,hits.length-max),
      items:hits.slice(0,max).map(hitRecord)
    };
  }

  /* ---------- runtime state & PDF page indexing ---------- */
  let assistKind='manual';
  let assistCode='';
  let appliedIds=null;
  let lastRecipe=null;
  const expiryByCode=new Map();
  const listeners=new Set();
  let indexCache={key:null,pages:[],promise:null};

  function workspace(){
    try{return root.FalsifyPaperWorkspace||null;}catch{return null;}
  }
  function boothPaper(){
    try{return root.FalsifyBoothPaper||null;}catch{return null;}
  }
  function boothEdits(){
    try{return root.FalsifyBoothEdits||null;}catch{return null;}
  }
  function liveEdits(){
    const store=boothEdits();
    try{return store&&typeof store.list==='function'?store.list():[];}catch{return [];}
  }
  function source(){
    const ws=workspace();
    try{return ws&&typeof ws.getSource==='function'?ws.getSource():null;}catch{return null;}
  }
  function pdfDocOf(){
    const ws=workspace();
    try{return ws&&typeof ws.getPdfDoc==='function'?ws.getPdfDoc():null;}catch{return null;}
  }
  function currentPageIndex(){
    const ws=workspace();
    try{return ws&&typeof ws.getPageIndex==='function'?ws.getPageIndex():null;}catch{return null;}
  }
  function currentPage(){
    const idx=currentPageIndex();
    return Number.isInteger(idx)&&idx>=0?idx+1:0;
  }
  function boothCurrent(){
    const hook=boothPaper();
    try{return hook&&typeof hook.current==='function'?hook.current():null;}catch{return null;}
  }
  function sleep(ms){
    return new Promise(resolve=>{root.setTimeout(resolve,ms);});
  }
  async function waitFor(check, ms, step){
    const until=Date.now()+ms;
    for(;;){
      const value=check();
      if(value) return value;
      if(Date.now()>=until) return null;
      await sleep(step||100);
    }
  }
  function emit(kind, detail){
    for(const fn of listeners){try{fn(kind,detail);}catch{}}
  }
  function dispatchIndexReady(){
    const doc=root.document;
    if(doc&&typeof doc.dispatchEvent==='function'&&typeof root.CustomEvent==='function'){
      try{doc.dispatchEvent(new root.CustomEvent('falsify:booth-index-ready'));}catch{}
    }
  }
  function textLayerBox(doc){
    const stage=doc.getElementById('paper-before-stage');
    const pageEl=stage&&stage.querySelector&&stage.querySelector('.paper-page');
    const layer=pageEl&&pageEl.querySelector('.paper-text-layer');
    if(!pageEl||!layer) return null;
    const box=pageEl.getBoundingClientRect();
    return box.width>0&&box.height>0?{layer,box}:null;
  }
  function textLayerItems(layer, box){
    const items=[];
    for(const span of layer.querySelectorAll('span')){
      const str=span.textContent||'';
      if(!str) continue;
      const r=span.getBoundingClientRect();
      if(!(r.width>0&&r.height>0)) continue;
      items.push({str,rect:{x:(r.left-box.left)/box.width,y:(r.top-box.top)/box.height,w:r.width/box.width,h:r.height/box.height}});
    }
    return items;
  }
  /* Rendered DOM text layer fallback when no pdf.js document is exposed yet. */
  function indexFromTextLayer(){
    const doc=root.document;
    const idx=currentPageIndex();
    if(!doc||idx==null) return [];
    const found=textLayerBox(doc);
    if(!found) return [];
    const items=textLayerItems(found.layer,found.box);
    return items.length?[indexItems(idx,items,null)]:[];
  }
  /* Fallback for unit-test stubs that supply source.pages or source.segments without pdf.js. */
  function fallbackPagesFromSource(src){
    if(!src) return [];
    if(Array.isArray(src.pages)&&src.pages.length) return normalizePages(src.pages);
    if(Array.isArray(src.segments)&&src.segments.length){
      const byPage=new Map();
      for(const seg of src.segments){
        if(!seg||typeof seg.text!=='string'||!Number.isSafeInteger(seg.pageIndex)||seg.pageIndex<0) continue;
        const id=String(seg.id||'');
        if(id.startsWith('paragraph:')) continue;
        const list=byPage.get(seg.pageIndex)||[];
        list.push(seg.text.trim());
        byPage.set(seg.pageIndex,list);
      }
      const out=[];
      for(const [pageIndex,parts] of [...byPage.entries()].sort((a,b)=>a[0]-b[0])){
        out.push(indexPlainText(pageIndex,parts.filter(Boolean).join('\n\n')));
      }
      return out;
    }
    return [];
  }
  async function indexPdfDoc(pdf){
    const total=Number(pdf&&pdf.numPages)||0;
    const pages=[];
    for(let p=1;p<=total;p+=1){
      const page=await pdf.getPage(p);
      try{
        const viewport=page.getViewport({scale:1});
        const content=await page.getTextContent();
        pages.push(indexItems(p-1,content&&content.items||[],viewport));
      }finally{
        if(typeof page.cleanup==='function') page.cleanup();
      }
    }
    return pages;
  }
  function clearIndex(){
    indexCache={key:null,pages:[],promise:null};
  }
  function indexedPages(){
    const pdf=pdfDocOf();
    const src=source();
    const key=pdf||(src&&(src.fileHash||src.file))||null;
    if(key&&indexCache.key===key&&indexCache.pages.length) return indexCache.pages;
    if(!pdf){
      const fb=fallbackPagesFromSource(src);
      if(fb.length) return fb;
      return indexFromTextLayer();
    }
    return indexCache.pages;
  }
  function canPreviewFile(src){
    return !!(src&&src.file&&typeof src.file.arrayBuffer==='function'&&root.FalsifyPreview&&typeof root.FalsifyPreview.defaultImport==='function');
  }
  async function indexSourceFile(src){
    const preview=root.FalsifyPreview;
    const lib=await preview.defaultImport();
    if(lib.GlobalWorkerOptions&&!lib.GlobalWorkerOptions.workerSrc&&root.document){
      lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',root.document.baseURI).href;
    }
    const bytes=new Uint8Array(await src.file.arrayBuffer());
    const doc=await lib.getDocument(preview.pdfParams(bytes,root.document?root.document.baseURI:'')).promise;
    try{return await indexPdfDoc(doc);}finally{doc.destroy&&doc.destroy();}
  }
  async function runIndexTask(key, task){
    indexCache={key,pages:[],promise:task};
    try{
      const pages=await task;
      if(indexCache.key===key) indexCache={key,pages,promise:null};
      dispatchIndexReady();
      return pages;
    }catch{
      if(indexCache.key===key) indexCache={key:null,pages:[],promise:null};
      return indexFromTextLayer();
    }
  }
  function indexKeyOf(pdf, src){
    return pdf||(src&&(src.fileHash||src.file))||null;
  }
  async function ensureIndex(){
    const pdf=pdfDocOf();
    const src=source();
    const key=indexKeyOf(pdf,src);
    if(!key) return [];
    if(indexCache.key===key&&indexCache.pages.length) return indexCache.pages;
    if(indexCache.key===key&&indexCache.promise) return indexCache.promise;
    if(pdf) return runIndexTask(key,indexPdfDoc(pdf));
    const fb=fallbackPagesFromSource(src);
    if(fb.length){indexCache={key,pages:fb,promise:null};return fb;}
    if(canPreviewFile(src)) return runIndexTask(key,indexSourceFile(src));
    return indexFromTextLayer();
  }

  function setAssist(kind, recipeCode){
    assistKind=SOURCES.includes(kind)?kind:'manual';
    const code=normalizeCode(recipeCode||'');
    assistCode=assistKind==='agent'&&code?code:'';
    appliedIds=null;
  }
  function assist(){
    const live=liveEdits();
    if(appliedIds&&!live.some(edit=>edit&&appliedIds.has(edit.id))) return {assist:'manual'};
    const out={assist:assistKind};
    if(assistKind==='agent'&&assistCode) out.recipeCode=assistCode;
    return out;
  }
  function baseOf(value){
    if(typeof value!=='string'||!value) return '';
    try{
      const url=new URL(value);
      const loop=url.hostname==='127.0.0.1'||url.hostname==='localhost';
      if(url.protocol!=='https:'&&!(loop&&url.protocol==='http:')) return '';
      return url.origin+url.pathname.replace(/\/+$/,'');
    }catch{return '';}
  }
  function apiBase(){
    const cfg=root.FalsifyCloudConfig||{};
    const hosted=cfg.hostedAi&&typeof cfg.hostedAi==='object'?cfg.hostedAi.apiBase:'';
    return baseOf(hosted)||baseOf(cfg.apiBase);
  }
  function coded(code){
    const error=new Error(ERROR_TEXT[code]||code);
    error.code=code;
    return error;
  }
  function fetchStatusCode(status){
    if(status===404) return 'not_found';
    if(status===429) return 'rate_limited';
    return status===400?'invalid_code':'network';
  }
  async function fetchJson(path, headers){
    const base=apiBase();
    if(!base||typeof root.fetch!=='function') throw coded('network');
    let res=null;
    try{
      res=await root.fetch(base+path,{method:'GET',headers:Object.assign({Accept:'application/json'},headers||{}),credentials:'omit',cache:'no-store',redirect:'error'});
    }catch{throw coded('network');}
    if(!res||!res.ok) throw coded(fetchStatusCode(res&&res.status));
    try{return await res.json();}catch{throw coded('invalid_recipe');}
  }
  function invalidRecipe(errors){
    const error=coded('invalid_recipe');
    error.errors=errors;
    return error;
  }
  async function fromCode(code){
    const normal=normalizeCode(code);
    if(!normal) throw coded('invalid_code');
    const data=await fetchJson('/v1/booth/recipes/'+encodeURIComponent(normal));
    const clean=isPlain(data)?withoutServerKeys(data):null;
    const checked=validate(clean);
    if(!checked.ok) throw invalidRecipe(checked.errors);
    if(typeof data.expiresAt==='string') expiryByCode.set(normal,data.expiresAt);
    return Object.assign(clean,{code:normal});
  }
  async function bearer(){
    const session=root.FalsifyHostedSession;
    try{
      const token=session&&typeof session.token==='function'?await session.token():'';
      return typeof token==='string'?token:'';
    }catch{return '';}
  }
  async function searchMeta(paperId){
    const token=await bearer();
    if(!token) return {};
    try{
      const data=await fetchJson('/v1/papers/search?q='+encodeURIComponent(paperId)+'&page=1',{Authorization:'Bearer '+token});
      const item=(data&&Array.isArray(data.results)?data.results:[]).find(row=>row&&row.id===paperId);
      if(!item) return {};
      const license=typeof item.license==='string'?item.license:(item.license&&item.license.id)||'';
      return {title:typeof item.title==='string'?item.title:'',license};
    }catch{return {};}
  }
  function isMission(paperId){
    const doc=root.document;
    const box=doc&&doc.getElementById('booth-missions');
    if(!box||typeof box.querySelectorAll!=='function') return false;
    return [...box.querySelectorAll('.booth-mission .booth-lab')].some(node=>{
      const match=/^arXiv (\S+)/.exec(String(node.textContent||''));
      return !!match&&match[1]===paperId;
    });
  }
  function paperIndexReady(previousHash, previousPdf){
    const pdf=pdfDocOf();
    if(pdf&&pdf!==previousPdf) return true;
    const src=source();
    if(!src||src.fileHash===previousHash) return false;
    return !!(Array.isArray(src.pages)&&src.pages.length||Array.isArray(src.segments)&&src.segments.length);
  }
  function sameOpenPaper(paperId){
    const current=boothCurrent();
    return !!(current&&current.id===paperId&&(pdfDocOf()||source()));
  }
  function hasLoadedPages(){
    return !!(pdfDocOf()||fallbackPagesFromSource(source()).length);
  }
  async function paperMetaFor(paperId, same){
    return same||isMission(paperId)?{}:await searchMeta(paperId);
  }
  async function ensurePaper(paperId){
    const hook=boothPaper();
    if(!hook||typeof hook.open!=='function') return false;
    const same=sameOpenPaper(paperId);
    const previousHash=same?null:(source()||{}).fileHash;
    const previousPdf=same?null:pdfDocOf();
    const meta=await paperMetaFor(paperId,same);
    const pending=await waitFor(()=>hook.open(paperId,meta),15000,200);
    if(!pending||!(await pending)) return false;
    if(same&&hasLoadedPages()) return true;
    return !!(await waitFor(()=>paperIndexReady(previousHash,previousPdf),60000,150));
  }
  function addBoothEdit(hit, replace, editSource, assistMeta){
    const store=boothEdits();
    if(!store||typeof store.add!=='function') return {ok:false,reason:'no_paper'};
    if(hit.originalText===replace) return {ok:false,reason:'unchanged'};
    const added=store.add({
      pageIndex:hit.pageIndex,
      rects:hit.rects,
      originalText:hit.originalText,
      newText:replace,
      source:editSource||'find',
      ...(assistMeta?{assist:assistMeta}:{})
    });
    if(!added) return {ok:false,reason:'unchanged'};
    return {
      ok:true,
      id:added.id,
      pageIndex:hit.pageIndex,
      before:hit.originalText,
      after:replace,
      rects:hit.rects
    };
  }
  function recordAssist(recipe, code, ids){
    assistKind=recipe.source;
    const normal=normalizeCode(code||'');
    assistCode=recipe.source==='agent'&&normal?normal:'';
    appliedIds=new Set(ids.filter(Boolean));
  }
  function progressFn(options){
    const onProgress=options&&typeof options.onProgress==='function'?options.onProgress:null;
    return info=>{
      if(onProgress){try{onProgress(info);}catch{}}
      emit('progress',info);
    };
  }
  function recipeSourceMeta(clean, normalCode){
    const editSource=clean.source==='my-ai'?'myai':(clean.source==='agent'?'recipe':'find');
    const assistMeta=clean.source==='agent'&&normalCode
      ?{kind:'agent',code:normalCode}
      :(clean.source==='my-ai'?{kind:'my-ai'}:undefined);
    return {editSource,assistMeta};
  }
  function applyRecipeEdits(clean, pages, normalCode, progress){
    const applied=[];
    const unresolved=[];
    const {editSource,assistMeta}=recipeSourceMeta(clean,normalCode);
    for(let i=0;i<clean.edits.length;i+=1){
      const edit=clean.edits[i];
      progress({phase:'edit',index:i,total:clean.edits.length});
      const found=locate(edit,pages);
      if(found.status==='resolved'){
        const result=addBoothEdit(found,edit.replace,editSource,assistMeta);
        if(result.ok) applied.push(Object.assign({edit},result));
        else unresolved.push({edit,reason:result.reason});
      }else{
        unresolved.push({edit,reason:found.status==='ambiguous'?'ambiguous':'not_found'});
      }
    }
    return {applied,unresolved};
  }
  async function apply(recipe, options){
    const clean=isPlain(recipe)?withoutServerKeys(recipe):recipe;
    const checked=validate(clean);
    if(!checked.ok) throw invalidRecipe(checked.errors);
    const progress=progressFn(options);
    const code=typeof recipe.code==='string'?recipe.code:'';
    const normalCode=normalizeCode(code);
    progress({phase:'paper',paperId:clean.paperId});
    const opened=await ensurePaper(clean.paperId);
    const pages=opened?await ensureIndex():[];
    const outcome=opened&&pages.length
      ?applyRecipeEdits(clean,pages,normalCode,progress)
      :{applied:[],unresolved:clean.edits.map(edit=>({edit,reason:'no_paper'}))};
    recordAssist(clean,code,outcome.applied.map(item=>item.id));
    lastRecipe={recipe:clean,code:assistCode,fileHash:(source()||{}).fileHash||'',outcome};
    progress({phase:'done'});
    emit('applied',lastRecipe);
    return outcome;
  }
  function pageText(page){
    if(!Number.isInteger(page)||page<1) return '';
    const hit=indexedPages().find(p=>p.pageIndex===page-1);
    return hit?hit.text:'';
  }
  function paperInfo(){
    const paper=boothCurrent();
    const ws=workspace();
    const pages=indexedPages().length||(ws&&typeof ws.getPageCount==='function'?ws.getPageCount():0);
    return {
      paperId:paper&&paper.id||'',
      title:paper&&paper.title||'',
      license:paper&&paper.license||'',
      pages
    };
  }

  /* ---------- edit-step UI (event.html only: needs #booth-step-edit from booth.js) ---------- */
  const PROPS=new Set(['className','textContent','id','type','value','hidden','disabled']);
  function mountUi(doc){
    const editStep=doc.getElementById('booth-step-edit');
    if(!editStep||doc.getElementById('booth-recipe')) return;
    const html=doc.documentElement;
    const ui={tab:'find',myai:false,busy:false,seq:0,summary:null};
    function el(tag, props, ...kids){
      const node=doc.createElement(tag);
      for(const [key,value] of Object.entries(props||{})){
        if(value==null||value===false) continue;
        if(PROPS.has(key)) node[key]=value;
        else node.setAttribute(key,String(value));
      }
      for(const kid of kids){
        if(kid!=null) node.append(typeof kid==='string'?doc.createTextNode(kid):kid);
      }
      return node;
    }
    function say(node, text){
      if(node) node.textContent=text||'';
    }
    function field(input, label){
      return el('label',{className:'booth-field',for:input.id},el('span',{className:'booth-klab',textContent:label}),input);
    }
    function hitButton(item, chosen, pick){
      const selected=!!chosen&&chosen.pageIndex===item.pageIndex&&chosen.start===item.start&&chosen.end===item.end;
      const button=el('button',{type:'button',className:'booth-find-hit'+(selected?' on':''),role:'option','aria-selected':String(selected)},
        el('span',{className:'pg',textContent:(item.pageIndex+1)+'쪽'}),
        el('span',{className:'snip'},item.snippet.lead,el('mark',{textContent:item.snippet.hit}),item.snippet.tail));
      button.addEventListener('click',()=>pick(item));
      return button;
    }
    function findForm(opts){
      const o=opts||{};
      ui.seq+=1;
      const id='booth-find-'+ui.seq;
      const state={chosen:null,armed:false,busy:false,timer:0,list:{total:0,more:0,items:[]}};
      const find=el('input',{id:id+'-q',type:'text',maxlength:'300',autocomplete:'off',spellcheck:'false',value:o.find||''});
      const repl=el('input',{id:id+'-r',type:'text',maxlength:'300',autocomplete:'off',spellcheck:'false',value:o.replace||''});
      const hits=el('div',{className:'booth-find-hits',role:'listbox','aria-label':'찾은 곳'});
      const ask=el('p',{className:'booth-find-ask',role:'status','aria-live':'polite',hidden:true});
      const more=el('p',{className:'booth-find-more',hidden:true});
      const go=el('button',{type:'submit',className:'booth-btn ink',textContent:'바꾸기'});
      const status=el('p',{className:'booth-feedback',role:'status','aria-live':'polite'});
      const note=o.note?el('p',{className:'booth-find-note',textContent:o.note}):null;
      const form=el('form',{className:'booth-find'+(o.row?' row':''),novalidate:'novalidate'},
        note,field(find,'바꿀 글자'),ask,hits,more,field(repl,'새 글자'),go,status);
      function tell(text){
        const asking=!!state.armed&&!!text;
        say(ask,asking?text:'');
        ask.hidden=!asking;
        say(status,asking?'':text);
        if(asking&&typeof ask.scrollIntoView==='function') ask.scrollIntoView({block:'nearest'});
      }
      function paint(){
        hits.textContent='';
        for(const item of state.list.items) hits.append(hitButton(item,state.chosen,pick));
        more.hidden=!state.list.more;
        say(more,state.list.more?state.list.more+'곳 더 있어요. 더 길게 적으면 줄어들어요.':'');
      }
      function render(typed){
        const query=find.value;
        state.list=query.trim()?searchHits(indexedPages(),query,currentPageIndex(),HIT_LIMIT):{total:0,more:0,items:[]};
        if(typed===true) say(status,query.trim()&&!state.list.total?REASON_TEXT.not_found:'');
        else if(state.list.total&&status.textContent===REASON_TEXT.not_found) say(status,'');
        paint();
      }
      function applyChosen(item){
        const editSource=o.source||'find';
        const result=addBoothEdit(item,repl.value,editSource,o.assist);
        if(!result.ok){tell(REASON_TEXT[result.reason]||REASON_TEXT.no_paper);return;}
        const ws=workspace();
        if(ws&&typeof ws.showPage==='function'){try{ws.showPage(result.pageIndex+1,{scroll:false});}catch{}}
        if(typeof o.onDone==='function'){o.onDone(result);return;}
        find.value='';
        repl.value='';
        state.chosen=null;
        state.armed=false;
        tell('');
        render();
        say(status,'바꿨어요 · '+(result.pageIndex+1)+'쪽');
      }
      function pick(item){
        state.chosen=item;
        paint();
        if(state.armed||o.row){
          if(repl.value===find.value){tell('새 글자가 바꿀 글자와 같아요.');return;}
          applyChosen(item);
        }
      }
      find.addEventListener('input',()=>{
        state.chosen=null;
        state.armed=false;
        tell('');
        root.clearTimeout(state.timer);
        state.timer=root.setTimeout(()=>{void ensureIndex().then(()=>render(true));},120);
      });
      async function submit(){
        if(state.busy) return;
        root.clearTimeout(state.timer);
        if(!find.value.trim()){tell('바꿀 글자를 적어 주세요.');return;}
        if(repl.value===find.value){tell('새 글자가 바꿀 글자와 같아요.');return;}
        state.busy=true;
        go.disabled=true;
        try{
          const pages=await ensureIndex();
          if(!pages.length){tell(REASON_TEXT.no_paper);return;}
          render();
          state.armed=false;
          if(state.chosen){applyChosen(state.chosen);return;}
          if(state.list.total===0){tell(REASON_TEXT.not_found);return;}
          if(state.list.total===1){applyChosen(state.list.items[0]);return;}
          state.armed=true;
          tell('같은 글자가 '+state.list.total+'곳에 있어요. 바꿀 곳을 눌러 주세요.');
        }finally{
          state.busy=false;
          go.disabled=false;
        }
      }
      form.addEventListener('submit',event=>{event.preventDefault();void submit();});
      if(find.value) root.setTimeout(()=>{void ensureIndex().then(()=>render());},0);
      return {form,render};
    }

    const main=findForm({});
    const fix=el('div',{id:'booth-recipe-fix',className:'booth-recipe-fix',hidden:true});
    const myaiBox=el('div',{id:'booth-myai'});
    const myaiWait=el('p',{className:'booth-small booth-myai-wait',hidden:true,textContent:'준비 중'});
    const codeInput=el('input',{id:'booth-agent-code',type:'text',maxlength:'300',autocomplete:'off',spellcheck:'false',autocapitalize:'characters',placeholder:'예: R-7K3QXM'});
    codeInput.addEventListener('input',()=>{
      const code=codeFromText(codeInput.value);
      if(code&&code!==codeInput.value) codeInput.value=code;
    });
    const agentStatus=el('p',{id:'booth-agent-status',className:'booth-feedback',role:'status','aria-live':'polite'});
    const agentForm=el('form',{id:'booth-agent-form',className:'booth-find booth-agent',novalidate:'novalidate'},
      field(codeInput,'Agent 코드'),
      el('button',{type:'submit',className:'booth-btn ink',textContent:'불러오기'}),
      agentStatus,
      el('p',{className:'booth-small',textContent:'AI agent가 만든 레시피 코드를 넣으면 고친 곳을 이 논문에 바로 적용해요. 확인과 제출은 직접 해요.'}));
    const card=el('section',{id:'booth-recipe-result',className:'booth-panel booth-recipe-card',hidden:true,'aria-live':'polite'});
    const tabs=[['find','직접 고치기'],['myai','내 AI에게'],['agent','Agent 코드']];
    const tabButtons={};
    const panes={
      find:el('div',{id:'booth-pane-find',className:'booth-pane',role:'tabpanel','aria-labelledby':'booth-tab-find'},fix,main.form),
      myai:el('div',{id:'booth-pane-myai',className:'booth-pane',role:'tabpanel','aria-labelledby':'booth-tab-myai',hidden:true},myaiBox,myaiWait),
      agent:el('div',{id:'booth-pane-agent',className:'booth-pane',role:'tabpanel','aria-labelledby':'booth-tab-agent',hidden:true},agentForm)
    };
    const bar=el('div',{className:'booth-tabs',role:'tablist','aria-label':'고치는 방법'});
    for(const [key,label] of tabs){
      const button=el('button',{id:'booth-tab-'+key,type:'button',className:'booth-tab',role:'tab','aria-controls':'booth-pane-'+key,'aria-selected':String(key==='find'),textContent:label});
      button.addEventListener('click',()=>selectTab(key));
      tabButtons[key]=button;
      bar.append(button);
    }
    const section=el('section',{id:'booth-recipe',className:'booth-recipe','aria-label':'고치는 방법'},card,bar,panes.find,panes.myai,panes.agent);
    const hint=doc.getElementById('booth-hint');
    if(hint) hint.after(section); else editStep.append(section);
    const pickStatus=el('p',{id:'booth-recipe-pick-status',className:'booth-feedback',role:'status','aria-live':'polite'});
    const missionStatus=doc.getElementById('booth-mission-status');
    if(missionStatus) missionStatus.after(pickStatus);

    function mountMyAi(){
      if(ui.myai) return;
      const myai=root.FalsifyBoothMyAI;
      if(myai&&typeof myai.mount==='function'){
        ui.myai=true;
        myaiWait.hidden=true;
        try{myai.mount(myaiBox);}catch{myaiWait.hidden=false;}
        return;
      }
      myaiWait.hidden=false;
    }
    const findMore=el('details',{id:'booth-find-fold',className:'booth booth-find-fold'},el('summary',{textContent:'찾아 바꾸기'}));
    function placeFind(){
      const wide=!!(root.matchMedia&&root.matchMedia('(min-width:1024px)').matches);
      const wsEl=doc.getElementById('paper-workspace');
      if(!wide&&wsEl){
        if(findMore.parentElement!==wsEl) wsEl.append(findMore);
        if(main.form.parentElement!==findMore) findMore.append(main.form);
      }else{
        if(main.form.parentElement!==panes.find) panes.find.append(main.form);
        findMore.remove();
      }
      findMore.hidden=ui.tab!=='find';
    }
    function placeFix(key){
      const pane=panes[key]||panes.find;
      if(pane===panes.find&&main.form.parentElement===pane) pane.insertBefore(fix,main.form);
      else if(fix.parentElement!==pane||pane.lastChild!==fix) pane.append(fix);
    }
    function selectTab(key){
      ui.tab=key;
      placeFix(key);
      for(const [name] of tabs){
        tabButtons[name].setAttribute('aria-selected',String(name===key));
        panes[name].hidden=name!==key;
      }
      findMore.hidden=key!=='find';
      if(key==='myai'){mountMyAi();void ensureIndex();}
      if(key==='find') void ensureIndex().then(()=>main.render());
    }

    /* Result card and one-tap fix rows for ties/misses. */
    function byLine(entry){
      const agent=entry.recipe.agent||{};
      const who=[agent.name,agent.model].filter(Boolean).join(' · ');
      const kind={agent:'AI agent 레시피','my-ai':'내 AI 레시피',manual:'레시피'}[entry.recipe.source];
      const until=expiryText(entry.code&&expiryByCode.get(entry.code));
      return [kind,who,entry.code].filter(Boolean).join(' · ')+(until?' · '+until:'');
    }
    function paintCount(){
      const s=ui.summary;
      if(!s) return;
      const count=doc.getElementById('booth-recipe-count');
      if(count) count.textContent=s.unresolved?s.applied+'곳 적용 · '+s.unresolved+'곳은 직접 골라 주세요':s.applied+'곳 적용했어요';
    }
    function fixRow(item, entry){
      const holder={};
      const editSource=entry.recipe.source==='my-ai'?'myai':'recipe';
      const assistMeta=entry.recipe.source==='agent'&&entry.code?{kind:'agent',code:entry.code}:(entry.recipe.source==='my-ai'?{kind:'my-ai'}:undefined);
      holder.view=findForm({
        row:true,find:item.edit.find,replace:item.edit.replace,source:editSource,assist:assistMeta,
        note:REASON_TEXT[item.reason]||REASON_TEXT.not_found,
        onDone(result){
          holder.view.form.remove();
          if(appliedIds&&result&&result.id) appliedIds.add(result.id);
          if(ui.summary){ui.summary.applied+=1;ui.summary.unresolved-=1;}
          paintCount();
          fix.hidden=!fix.querySelector('.booth-find');
        }
      });
      return holder.view.form;
    }
    function renderResult(entry){
      const out=entry.outcome;
      ui.summary={applied:out.applied.length,unresolved:out.unresolved.length};
      card.textContent='';
      card.append(
        el('p',{className:'booth-lab',textContent:'RECIPE'}),
        el('h3',{id:'booth-recipe-count',className:'booth-recipe-count'}),
        el('p',{className:'booth-small booth-recipe-by',textContent:byLine(entry)}),
        el('p',{className:'booth-small',textContent:'바뀐 곳은 「다음」에서 원문과 나란히 확인해요. 제출은 직접 해요.'}));
      paintCount();
      card.hidden=false;
      fix.textContent='';
      if(out.unresolved.length) fix.append(el('p',{className:'booth-klab',textContent:'확인 필요 · 바꿀 곳을 골라 주세요'}));
      for(const item of out.unresolved) fix.append(fixRow(item,entry));
      fix.hidden=!out.unresolved.length;
      placeFix(ui.tab);
    }
    function resetResult(){
      card.hidden=true;
      card.textContent='';
      fix.textContent='';
      fix.hidden=true;
      ui.summary=null;
    }
    function progressText(info){
      if(info.phase==='paper') return '논문을 여는 중…';
      if(info.phase==='edit') return '고친 곳 적용 중 · '+(info.index+1)+' / '+info.total;
      return '';
    }
    function sayAll(text){
      say(pickStatus,text);
      say(agentStatus,text);
    }
    function confirmText(count, differentPaper){
      if(differentPaper&&count) return {text:'지금 고친 곳 '+count+'개가 사라져요. 레시피를 불러올까요?',yes:'지금 것 지우고 불러오기',no:'지금 것 유지'};
      if(differentPaper) return {text:'지금 연 논문이 레시피의 논문으로 바뀌어요. 레시피를 불러올까요?',yes:'논문 바꿔서 불러오기',no:'그대로 두기'};
      return {text:'지금 고친 곳 '+count+'개는 그대로 두고 레시피를 더해요. 레시피를 불러올까요?',yes:'더해서 불러오기',no:'그대로 두기'};
    }
    function placeConfirm(box){
      const old=doc.getElementById('booth-recipe-confirm');
      if(old) old.remove();
      if(html.dataset.boothStep==='edit') card.before(box);
      else pickStatus.after(box);
    }
    function askConfirm(ask){
      return new Promise(resolve=>{
        const yes=el('button',{id:'booth-recipe-confirm-yes',type:'button',className:'booth-btn ink',textContent:ask.yes});
        const no=el('button',{id:'booth-recipe-confirm-no',type:'button',className:'booth-btn line',textContent:ask.no});
        const box=el('div',{id:'booth-recipe-confirm',className:'booth-panel booth-recipe-confirm',role:'alertdialog','aria-labelledby':'booth-recipe-confirm-text'},
          el('p',{id:'booth-recipe-confirm-text',className:'booth-recipe-confirm-text',textContent:ask.text}),
          el('div',{className:'booth-row'},yes,no));
        const done=value=>{box.remove();resolve(value);};
        yes.addEventListener('click',()=>done(true));
        no.addEventListener('click',()=>done(false));
        placeConfirm(box);
        if(typeof box.scrollIntoView==='function') box.scrollIntoView({block:'center'});
        try{yes.focus({preventScroll:true});}catch{}
      });
    }
    function confirmLoad(recipe){
      const count=liveEdits().length;
      const current=boothCurrent();
      const differentPaper=!!(pdfDocOf()||source())&&!(current&&current.id===recipe.paperId);
      if(!count&&!differentPaper) return Promise.resolve(true);
      return askConfirm(confirmText(count,differentPaper));
    }
    async function loadCode(raw){
      if(ui.busy) return;
      const code=normalizeCode(codeFromText(raw)||raw);
      if(!code){sayAll(ERROR_TEXT.invalid_code);return;}
      ui.busy=true;
      sayAll('레시피를 불러오는 중…');
      try{
        const recipe=await fromCode(code);
        sayAll('');
        if(!(await confirmLoad(recipe))){sayAll('레시피를 불러오지 않았어요.');return;}
        setAssist('agent',code);
        await apply(recipe,{onProgress:info=>sayAll(progressText(info))});
        sayAll('');
        if(typeof card.scrollIntoView==='function') card.scrollIntoView({block:'start'});
      }catch(error){
        sayAll(ERROR_TEXT[error&&error.code]||ERROR_TEXT.network);
      }finally{ui.busy=false;}
    }
    agentForm.addEventListener('submit',event=>{event.preventDefault();void loadCode(codeInput.value);});

    function hashCode(){
      const match=/^#recipe=([A-Za-z0-9-]{6,12})$/.exec(String(root.location&&root.location.hash||''));
      return match?match[1]:'';
    }
    function clearHash(){
      try{root.history.replaceState(null,'',root.location.pathname+root.location.search);}catch{}
    }
    function fromHash(){
      const code=hashCode();
      if(!code) return;
      clearHash();
      codeInput.value=normalizeCode(code)||code;
      selectTab('agent');
      void loadCode(code);
    }

    /* Send step: prefill recipe reason/chip and side-by-side page comparison using edit.rects. */
    const pdfCache=new Map();
    function pdfFor(lib, preview, file){
      if(pdfCache.has(file)) return pdfCache.get(file);
      if(pdfCache.size>=3){
        const [oldest,task]=pdfCache.entries().next().value;
        pdfCache.delete(oldest);
        task.then(pdf=>pdf.destroy()).catch(()=>{});
      }
      const task=file.arrayBuffer().then(buffer=>lib.getDocument(preview.pdfParams(new Uint8Array(buffer),doc.baseURI)).promise);
      pdfCache.set(file,task);
      task.catch(()=>pdfCache.delete(file));
      return task;
    }
    async function pdfLib(){
      const preview=root.FalsifyPreview;
      if(!preview||typeof preview.defaultImport!=='function') throw new Error('preview');
      const lib=await preview.defaultImport();
      if(lib.GlobalWorkerOptions&&!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',doc.baseURI).href;
      return {preview,lib};
    }
    async function renderPage(file, pageNumber, cssWidth, label){
      const {preview,lib}=await pdfLib();
      const pdf=await pdfFor(lib,preview,file);
      const page=await pdf.getPage(Math.min(Math.max(1,pageNumber),pdf.numPages));
      const viewport=page.getViewport({scale:preview.fitScale(page.getViewport({scale:1}),cssWidth,root.devicePixelRatio||1)});
      const canvas=el('canvas',{className:'booth-recipe-page',role:'img','aria-label':label});
      canvas.width=Math.max(1,Math.floor(viewport.width));
      canvas.height=Math.max(1,Math.floor(viewport.height));
      await page.render({canvasContext:canvas.getContext('2d'),canvas,viewport}).promise;
      page.cleanup();
      return canvas;
    }
    function rectsPercentBox(rects){
      const list=Array.isArray(rects)?rects.map(plainRect).filter(Boolean):[];
      if(!list.length) return null;
      let box=list[0];
      for(let i=1;i<list.length;i+=1) box=unionRect(box,list[i]);
      return {left:box.x*100,top:box.y*100,right:(box.x+box.w)*100,bottom:(box.y+box.h)*100};
    }
    function grow(from, to, pad, min){
      const extra=Math.max(pad,(min-(to-from))/2);
      return [Math.max(0,from-extra),Math.min(100,to+extra)];
    }
    function drawOutline(surface, box){
      const [left,right]=grow(box.left,box.right,1.5,8);
      const [top,bottom]=grow(box.top,box.bottom,1,4);
      const outline=el('span',{className:'booth-recipe-outline','aria-hidden':'true'});
      Object.assign(outline.style,{left:left+'%',top:top+'%',width:(right-left)+'%',height:(bottom-top)+'%'});
      surface.append(outline);
    }
    function shotFigure(caption, canvas){
      const surface=el('div',{className:'booth-recipe-shot'},canvas);
      return {surface,figure:el('figure',{},el('figcaption',{textContent:caption}),surface)};
    }
    function currentOutput(){
      const hook=boothPaper();
      try{if(hook&&typeof hook.output==='function') return hook.output();}catch{}
      return null;
    }
    async function fillCompare(view, edit){
      const status=el('p',{className:'booth-small',textContent:'쪽 그림을 그리는 중…'});
      view.textContent='';
      view.append(status);
      const src=source();
      const out=currentOutput();
      if(!src||!src.file||!out||!out.file){say(status,'쪽 미리보기를 불러오지 못했어요. 수정본 PDF는 그대로 제출할 수 있어요.');return;}
      const pageIndex=edit.pageIndex;
      const width=Math.max(120,Math.floor((view.clientWidth||300)/2)-6);
      try{
        const [beforeCanvas,afterCanvas]=await Promise.all([
          renderPage(src.file,pageIndex+1,width,'원본 '+(pageIndex+1)+'쪽'),
          renderPage(out.file,pageIndex+1,width,'수정본 '+(pageIndex+1)+'쪽')
        ]);
        const left=shotFigure('원본',beforeCanvas);
        const right=shotFigure('수정본 · '+(pageIndex+1)+'쪽',afterCanvas);
        view.textContent='';
        view.append(left.figure,right.figure);
        const box=rectsPercentBox(edit.rects);
        if(box){drawOutline(right.surface,box);right.surface.dataset.mark='rects';}
      }catch{say(status,'쪽 그림을 그리지 못했어요. 수정본 PDF는 그대로 제출할 수 있어요.');}
    }

    const aiMarks=new Map();
    function marksFor(id){
      if(!aiMarks.has(id)) aiMarks.set(id,{reason:'',chip:true});
      return aiMarks.get(id);
    }
    function draftLabel(reason, marks){
      if(!marks.reason||reason.previousElementSibling&&reason.previousElementSibling.classList.contains('booth-recipe-draft')) return;
      const note=el('p',{className:'booth-recipe-draft'});
      const paint=()=>{note.textContent=marks.reason==='mine'?'내가 고침':'AI가 채운 초안 · 내 말로 고쳐도 돼요';};
      paint();
      reason.before(note);
      reason.addEventListener('input',event=>{if(event.isTrusted){marks.reason='mine';paint();}});
    }
    function chipTag(node, label, marks){
      const chip=[...node.querySelectorAll('.booth-chip')].find(item=>item.textContent===label);
      if(!chip||!marks.chip||!chip.classList.contains('on')||node.querySelector('.booth-recipe-ai-pick')) return;
      const tag=el('span',{className:'booth-recipe-ai-pick',textContent:'AI 선택'});
      chip.after(tag);
      chip.parentElement.addEventListener('click',event=>{
        if(event.isTrusted&&event.target!==chip&&event.target!==tag){marks.chip=false;tag.remove();}
      });
    }
    function prefillCard(node, edit){
      const entry=lastRecipe;
      if(!entry||!appliedIds||!appliedIds.has(edit.id)) return;
      const marks=marksFor(edit.id);
      const reason=node.querySelector('textarea');
      if(reason&&!reason.value&&marks.reason!=='mine'&&entry.recipe.reason){
        reason.value=entry.recipe.reason;
        reason.dispatchEvent(new Event('input',{bubbles:true}));
        marks.reason='ai';
      }
      if(reason) draftLabel(reason,marks);
      const label=DEFECT_LABELS[entry.recipe.defectType];
      if(!label) return;
      if(!node.querySelector('.booth-chip.on')){
        const chip=[...node.querySelectorAll('.booth-chip')].find(item=>item.textContent===label);
        if(chip) chip.click();
      }
      chipTag(node,label,marks);
    }
    function compareToggle(edit){
      const button=el('button',{type:'button',className:'booth-btn line slim booth-recipe-compare-toggle','aria-expanded':'false',textContent:'수정본 쪽 보기'});
      const view=el('div',{className:'booth-recipe-compare',hidden:true});
      button.addEventListener('click',()=>{
        const open=view.hidden;
        view.hidden=!open;
        button.setAttribute('aria-expanded',String(open));
        say(button,open?'수정본 쪽 닫기':'수정본 쪽 보기');
        if(open) void fillCompare(view,edit);
      });
      return [button,view];
    }
    function decorateCard(node, edit){
      if(!edit||node.querySelector('.booth-recipe-compare-toggle')) return;
      prefillCard(node,edit);
      const anchor=node.querySelector('.booth-diff');
      const parts=compareToggle(edit);
      if(anchor) anchor.after(...parts); else node.append(...parts);
    }
    function decorateRows(){
      const box=doc.getElementById('booth-rows');
      if(!box) return;
      const edits=liveEdits();
      [...box.querySelectorAll('.booth-card')].forEach((node,i)=>decorateCard(node,edits[i]));
    }
    function onStep(){
      const step=html.dataset.boothStep;
      if(step==='edit'&&lastRecipe&&lastRecipe.fileHash!==((source()||{}).fileHash||'')) resetResult();
      if(step==='edit'&&ui.tab==='find') void ensureIndex().then(()=>main.render());
      if(step==='send') decorateRows();
    }
    const Observer=root.MutationObserver;
    if(typeof Observer==='function'){
      new Observer(onStep).observe(html,{attributes:true,attributeFilter:['data-booth-step']});
      const rows=doc.getElementById('booth-rows');
      if(rows) new Observer(decorateRows).observe(rows,{childList:true});
    }
    function clearPdfCache(){
      for(const task of pdfCache.values()) task.then(pdf=>pdf&&typeof pdf.destroy==='function'&&pdf.destroy()).catch(()=>{});
      pdfCache.clear();
      aiMarks.clear();
    }
    listeners.add((kind,entry)=>{if(kind==='applied') renderResult(entry);});
    doc.addEventListener('falsify:document-clear',()=>{clearIndex();clearPdfCache();resetResult();});
    doc.addEventListener('falsify:paper-workspace-source',()=>{void ensureIndex().then(()=>{if(ui.tab==='find') main.render();});});
    doc.addEventListener('falsify:paper-workspace-pdf',()=>{void ensureIndex().then(()=>{if(ui.tab==='find') main.render();});});
    root.addEventListener('hashchange',fromHash);
    root.addEventListener('resize',placeFind);
    placeFind();
    onStep();
    fromHash();
  }

  root.FalsifyBoothRecipe=Object.freeze({
    validate,apply,fromCode,pageText,paperInfo,currentPage,setAssist,assist,
    normalizeCode,normalizeText,indexPage,locate,searchHits,codeFromText,expiryText,
    SCHEMA
  });
  if(root.document&&typeof root.document.getElementById==='function') mountUi(root.document);
})(typeof window==='object'?window:globalThis);
