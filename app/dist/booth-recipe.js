/* Event-page defect recipes (falsify.booth.recipe.v1) and find-and-replace editing.
   globalThis.FalsifyBoothRecipe: validate, apply, fromCode, pageText, paperInfo, setAssist, assist.
   Every edit goes through FalsifyPaperWorkspace.acceptProposals with a confirmed import: the same
   session.add a manual paragraph edit ends in, so #paper-edits, the booth dock and 「다음」 (the
   paragraph-flow PDF build) treat it exactly like a hand edit. Matching folds whitespace runs and
   line-end hyphenation but keeps the original offsets. The page comes first, then the whole paper;
   context breaks ties, otherwise the edit stays unresolved (ambiguous). The edit step gets three tabs
   (직접 고치기 | 내 AI에게 | Agent 코드); #recipe=CODE in the URL loads, opens and applies a recipe.
   The send step gets a per-edit 「수정본 쪽 보기」 toggle with the original and generated page images.
   DOM text is set with textContent only. */
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
  const WS=/\s/;
  const LETTER=/\p{L}/u;
  const MAX_BYTES=8192;
  const HIT_LIMIT=20;
  const SNIP=28;
  const WINDOW=40;
  const ERROR_TEXT={
    invalid_code:'코드 형식을 확인해 주세요. 예: R-7K3QXM',
    not_found:'이 코드로 찾은 레시피가 없어요. 코드를 다시 확인해 볼까요? 레시피는 6시간 동안 쓸 수 있어요.',
    invalid_recipe:'레시피를 읽지 못했어요. agent에게 다시 만들어 달라고 해 주세요.',
    rate_limited:'지금 요청이 몰려 있어요. 잠시 뒤 다시 눌러 주세요.',
    network:'서버에 연결하지 못했어요. 네트워크를 확인해 주세요.',
    no_paper:'레시피의 논문을 열지 못했어요. 「불러오기」를 다시 눌러 주세요.'
  };
  const REASON_TEXT={
    not_found:'원문에서 이 글자를 찾지 못했어요. 원문 그대로 다시 적어 주세요.',
    ambiguous:'같은 글자가 여러 곳에 있어요. 목록에서 한 곳을 골라 주세요.',
    no_paper:'논문을 열지 못해 적용하지 못했어요.'
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
  /* Lengths count Unicode code points, as the server does. */
  function codePoints(text){
    return [...text].length;
  }
  /* rule: {max, min, trim, newline, optional} */
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
  /* {ok, errors:[{field, code}]}. The same rules as contract §1. */
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

  /* ---------- matching ---------- */
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
  function stepNormal(out, text, i, keepHyphen){
    const ch=text[i];
    if(ch===SOFT_HYPHEN) return i+1;
    if(ch==='-'){
      const j=hyphenBreak(text,i);
      if(j>0){if(keepHyphen) pushChars(out,'-',i,i+1);return j;}
    }
    if(WS.test(ch)){
      const j=spaceRun(text,i);
      if(out.chars.length) pushChars(out,' ',i,j);
      return j;
    }
    const len=text.codePointAt(i)>0xffff?2:1;
    pushChars(out,text.slice(i,i+len).normalize('NFKC'),i,i+len);
    return i+len;
  }
  /* Whitespace runs become one space and line-end hyphenation is joined (or kept as "-");
     start[k]/end[k] give the original span of normalised char k. */
  function normalizeText(text, keepHyphen){
    const source=typeof text==='string'?text:'';
    const out={chars:[],start:[],end:[]};
    let i=0;
    while(i<source.length) i=stepNormal(out,source,i,!!keepHyphen);
    while(out.chars.length&&out.chars[out.chars.length-1]===' '){out.chars.pop();out.start.pop();out.end.pop();}
    return {text:out.chars.join(''),start:out.start,end:out.end};
  }
  const normCache=new Map();
  function normalized(text, keepHyphen){
    const key=(keepHyphen?'1':'0')+text;
    let hit=normCache.get(key);
    if(hit) return hit;
    hit=normalizeText(text,keepHyphen);
    if(normCache.size>300) normCache.clear();
    normCache.set(key,hit);
    return hit;
  }
  function segKind(seg){
    const id=String(seg&&seg.id||'');
    if(id.startsWith('paragraph:')) return 'paragraph';
    if(id.startsWith('layout:')) return 'layout';
    return id.includes(':')?'other':'page';
  }
  function validSegments(list){
    return (Array.isArray(list)?list:[]).filter(seg=>seg&&typeof seg.id==='string'&&typeof seg.text==='string'&&Number.isSafeInteger(seg.pageIndex));
  }
  /* Layout columns cover each page; the page segment stands in where a page has none. */
  function coverage(segs){
    const layoutPages=new Set(segs.filter(seg=>segKind(seg)==='layout').map(seg=>seg.pageIndex));
    return segs.filter(seg=>segKind(seg)==='layout'||(segKind(seg)==='page'&&!layoutPages.has(seg.pageIndex)));
  }
  function paragraphs(segs){
    return segs.filter(seg=>segKind(seg)==='paragraph');
  }
  function hitsIn(seg, needle, keepHyphen){
    const norm=normalized(seg.text,keepHyphen);
    const hits=[];
    let at=norm.text.indexOf(needle);
    while(at>=0&&hits.length<1000){
      hits.push({seg,norm,needle,at,len:needle.length,start:norm.start[at],end:norm.end[at+needle.length-1]});
      at=norm.text.indexOf(needle,at+1);
    }
    return hits;
  }
  function scan(segs, find){
    for(const keep of [false,true]){
      const needle=normalizeText(find,keep).text;
      if(!needle) return [];
      const hits=[];
      for(const seg of segs) hits.push(...hitsIn(seg,needle,keep));
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
    const text=hit.norm.text;
    return text.slice(Math.max(0,hit.at-n),Math.min(text.length,hit.at+hit.len+n));
  }
  function wordScore(ctx, hit){
    const around=windowOf(hit,ctx.length);
    return ctx.split(' ').filter(word=>word.length>1&&around.includes(word)).length;
  }
  /* Matched characters around the hit, x1000. When the context holds the needle more than once,
     the occurrence nearest the middle of the context wins the tie. */
  function contextScore(context, hit){
    const ctx=normalizeText(context||'',false).text;
    if(!ctx) return 0;
    const middle=(ctx.length-hit.needle.length)/2;
    let best=0;
    let k=ctx.indexOf(hit.needle);
    while(k>=0){
      const matched=sideMatch(ctx,k,hit);
      if(matched>0) best=Math.max(best,matched*1000-Math.abs(k-middle));
      k=ctx.indexOf(hit.needle,k+1);
    }
    return best>0?best:wordScore(ctx,hit);
  }
  /* An exact hint (from a tapped match) wins; one hit wins outright; several need a unique best
     context score above zero. */
  function pickHit(hits, context, hint){
    if(!hits.length) return {status:'none'};
    const hinted=hint?hits.find(hit=>hit.seg.id===hint.segmentId&&hit.at===hint.at):null;
    if(hinted) return {status:'hit',hit:hinted};
    if(hits.length===1) return {status:'hit',hit:hits[0]};
    const scored=hits.map(hit=>({hit,score:contextScore(context,hit)})).sort((a,b)=>b.score-a.score);
    if(scored[0].score>0&&scored[0].score>scored[1].score) return {status:'hit',hit:scored[0].hit};
    return {status:'ambiguous',count:hits.length};
  }
  function resolved(hit, kind){
    return {
      status:'resolved',kind,segmentId:hit.seg.id,pageIndex:hit.seg.pageIndex,
      start:hit.start,end:hit.end,before:hit.seg.text.slice(hit.start,hit.end),window:windowOf(hit,WINDOW)
    };
  }
  /* Coverage text decides ambiguity; a paragraph segment is preferred for the edit itself. */
  function locateIn(segs, edit){
    const cov=pickHit(scan(coverage(segs),edit.find),edit.context,edit.hint);
    if(cov.status==='ambiguous') return {status:'ambiguous',count:cov.count};
    const ctx=edit.context||(cov.hit?windowOf(cov.hit,WINDOW):'');
    const para=pickHit(scan(paragraphs(segs),edit.find),ctx);
    if(para.status==='hit') return resolved(para.hit,'paragraph');
    if(cov.status==='hit') return resolved(cov.hit,segKind(cov.hit.seg));
    return {status:para.status==='ambiguous'?'ambiguous':'not_found'};
  }
  /* Page first (1-based edit.page), then the whole paper. */
  function locate(edit, segments){
    const segs=validSegments(segments);
    if(!edit||typeof edit.find!=='string') return {status:'not_found'};
    if(Number.isInteger(edit.page)){
      const onPage=locateIn(segs.filter(seg=>seg.pageIndex===edit.page-1),edit);
      if(onPage.status!=='not_found') return onPage;
    }
    return locateIn(segs,edit);
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
  /* Live list for 바꿀 글자: the current page first, then page order; at most limit items. */
  function searchHits(segments, find, currentPage, limit){
    const segs=validSegments(segments);
    let hits=scan(coverage(segs),find||'');
    if(!hits.length) hits=scan(paragraphs(segs),find||'');
    const rank=hit=>(hit.seg.pageIndex===currentPage?-1:hit.seg.pageIndex);
    hits.sort((a,b)=>rank(a)-rank(b)||segs.indexOf(a.seg)-segs.indexOf(b.seg)||a.at-b.at);
    const max=limit||HIT_LIMIT;
    return {
      total:hits.length,more:Math.max(0,hits.length-max),
      items:hits.slice(0,max).map(hit=>({
        pageIndex:hit.seg.pageIndex,context:windowOf(hit,WINDOW),hint:{segmentId:hit.seg.id,at:hit.at},snippet:snippetOf(hit)
      }))
    };
  }
  function pageTextOf(segments, pageIndex){
    const segs=validSegments(segments).filter(seg=>seg.pageIndex===pageIndex);
    const cover=coverage(segs);
    return (cover.length?cover:paragraphs(segs)).map(seg=>seg.text.trim()).filter(Boolean).join('\n\n');
  }
  function pageCount(segments){
    let max=-1;
    for(const seg of validSegments(segments)) max=Math.max(max,seg.pageIndex);
    return max+1;
  }

  /* ---------- runtime ---------- */
  let assistKind='manual';
  let assistCode='';
  let appliedIds=null;
  let lastRecipe=null;
  const listeners=new Set();

  function workspace(){
    try{return root.FalsifyPaperWorkspace||null;}catch{return null;}
  }
  function boothPaper(){
    try{return root.FalsifyBoothPaper||null;}catch{return null;}
  }
  function source(){
    const ws=workspace();
    try{return ws&&typeof ws.getSource==='function'?ws.getSource():null;}catch{return null;}
  }
  function segments(){
    const src=source();
    return src&&Array.isArray(src.segments)?src.segments:[];
  }
  function snapshotEdits(){
    const ws=workspace();
    let snap=null;
    try{snap=ws&&typeof ws.getEditSnapshot==='function'?ws.getEditSnapshot():null;}catch{snap=null;}
    return snap&&Array.isArray(snap.edits)?snap.edits:null;
  }
  function enabledEdits(){
    return (snapshotEdits()||[]).filter(edit=>edit&&edit.enabled!==false);
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
      await sleep(step||150);
    }
  }
  function setAssist(kind, recipeCode){
    assistKind=SOURCES.includes(kind)?kind:'manual';
    const code=normalizeCode(recipeCode||'');
    assistCode=assistKind==='agent'&&code?code:'';
    appliedIds=null;
  }
  /* After apply, the assist kind holds only while one of its edits is still enabled. */
  function assist(){
    const live=snapshotEdits();
    if(appliedIds&&live&&!live.some(edit=>edit&&edit.enabled!==false&&appliedIds.has(edit.id))) return {assist:'manual'};
    const out={assist:assistKind};
    if(assistKind==='agent'&&assistCode) out.recipeCode=assistCode;
    return out;
  }
  function emit(kind, detail){
    for(const fn of listeners){try{fn(kind,detail);}catch{}}
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
  /* GET /v1/booth/recipes/:code. The stored recipe plus code; createdAt/expiresAt are dropped. */
  async function fromCode(code){
    const normal=normalizeCode(code);
    if(!normal) throw coded('invalid_code');
    const data=await fetchJson('/v1/booth/recipes/'+encodeURIComponent(normal));
    const clean=isPlain(data)?withoutServerKeys(data):null;
    const checked=validate(clean);
    if(!checked.ok) throw invalidRecipe(checked.errors);
    return Object.assign(clean,{code:normal});
  }
  async function bearer(){
    const session=root.FalsifyHostedSession;
    try{
      const token=session&&typeof session.token==='function'?await session.token():'';
      return typeof token==='string'?token:'';
    }catch{return '';}
  }
  /* Title and license of a non-mission paper, from the search the booth uses. Best effort. */
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
  /* Exact id match against the mission tickets' "arXiv <id>" labels. */
  function isMission(paperId){
    const doc=root.document;
    const box=doc&&doc.getElementById('booth-missions');
    if(!box||typeof box.querySelectorAll!=='function') return false;
    return [...box.querySelectorAll('.booth-mission .booth-lab')].some(node=>{
      const match=/^arXiv (\S+)/.exec(String(node.textContent||''));
      return !!match&&match[1]===paperId;
    });
  }
  function boothCurrent(){
    const hook=boothPaper();
    try{return hook&&typeof hook.current==='function'?hook.current():null;}catch{return null;}
  }
  function sourceReady(previousHash){
    const src=source();
    if(!src||src.fileHash===previousHash) return false;
    return validSegments(src.segments).some(seg=>segKind(seg)==='layout'||segKind(seg)==='page');
  }
  /* The booth's own mission/search load path, then the workspace's text segments. */
  async function ensurePaper(paperId){
    const hook=boothPaper();
    if(!hook||typeof hook.open!=='function') return false;
    const current=boothCurrent();
    const same=!!(current&&current.id===paperId&&source());
    const previous=same?null:(source()||{}).fileHash;
    const meta=same||isMission(paperId)?{}:await searchMeta(paperId);
    const pending=await waitFor(()=>hook.open(paperId,meta),15000,200);
    if(!pending||!(await pending)) return false;
    return !!(await waitFor(()=>sourceReady(previous),60000,200));
  }
  function paragraphsReady(pageIndex){
    return segments().some(seg=>seg.pageIndex===pageIndex&&segKind(seg)==='paragraph');
  }
  /* Paragraph segments exist once the workspace has drawn the page. */
  async function ensureParagraphs(pageIndex){
    if(paragraphsReady(pageIndex)) return true;
    const ws=workspace();
    const shown=await waitFor(()=>{try{return ws.showPage(pageIndex+1)===true;}catch{return false;}},8000,200);
    if(!shown) return false;
    return !!(await waitFor(()=>paragraphsReady(pageIndex),8000,150));
  }
  function occursOnce(text, part){
    const at=text.indexOf(part);
    return at>=0&&text.indexOf(part,at+1)<0;
  }
  /* The PDF build matches Before exactly once in its segment, so a repeated Before grows by whole
     words on both sides until it is unique, as a hand edit of the paragraph would read. */
  function uniqueSpan(text, start, end){
    let from=start;
    let to=end;
    while(!occursOnce(text,text.slice(from,to))&&(from>0||to<text.length)){
      from=Math.max(0,from-1);
      while(from>0&&!WS.test(text[from-1])) from-=1;
      to=Math.min(text.length,to+1);
      while(to<text.length&&!WS.test(text[to])) to+=1;
    }
    return {from,to};
  }
  function proposalFor(found, replace, text){
    const span=uniqueSpan(text,found.start,found.end);
    return {
      segmentId:found.segmentId,pageIndex:found.pageIndex,
      before:text.slice(span.from,span.to),
      after:text.slice(span.from,found.start)+replace+text.slice(found.end,span.to),
      anchor:{start:span.from,end:span.to}
    };
  }
  function segmentText(segmentId){
    const seg=segments().find(item=>item&&item.id===segmentId);
    return seg&&typeof seg.text==='string'?seg.text:'';
  }
  /* acceptProposals(confirmed) ends in session.add, like a manual paragraph edit. The empty call
     afterwards clears the workspace's proposal queue so no stale card is left. */
  function commit(found, replace){
    const ws=workspace();
    const before=new Set((snapshotEdits()||[]).map(edit=>edit.id));
    const text=segmentText(found.segmentId);
    if(text.slice(found.start,found.end)!==found.before) return {ok:false,reason:'not_found'};
    const proposal=proposalFor(found,replace,text);
    let result=null;
    try{result=ws.acceptProposals([proposal],{origin:'external-ai-import',confirmed:true});}
    catch{result=null;}
    try{ws.acceptProposals([],{origin:'external-ai-import'});}catch{}
    const added=(snapshotEdits()||[]).find(edit=>!before.has(edit.id));
    if(!result||result.applied!==1||!added) return {ok:false,reason:'not_found',detail:'overlap'};
    return {ok:true,id:added.id,pageIndex:found.pageIndex,segmentId:found.segmentId,before:proposal.before,after:proposal.after};
  }
  async function locateLoaded(edit){
    if(Number.isInteger(edit.page)) await ensureParagraphs(edit.page-1);
    const found=locate(edit,segments());
    if(found.status!=='resolved'||found.kind==='paragraph'||paragraphsReady(found.pageIndex)) return found;
    if(!(await ensureParagraphs(found.pageIndex))) return found;
    const again=locate({page:found.pageIndex+1,find:edit.find,replace:edit.replace,context:edit.context||found.window,hint:edit.hint},segments());
    return again.status==='resolved'?again:found;
  }
  /* One edit: {ok:true, id, ...} or {ok:false, reason: not_found | ambiguous | no_paper}. */
  async function applyEdit(edit){
    const ws=workspace();
    if(!ws||typeof ws.acceptProposals!=='function'||!source()) return {ok:false,reason:'no_paper'};
    const found=await locateLoaded(edit);
    if(found.status!=='resolved') return {ok:false,reason:found.status==='ambiguous'?'ambiguous':'not_found'};
    return commit(found,edit.replace);
  }
  function recordAssist(recipe, code, ids){
    assistKind=recipe.source;
    const normal=normalizeCode(code||'');
    assistCode=recipe.source==='agent'&&normal?normal:'';
    appliedIds=new Set(ids);
  }
  async function applyAll(clean, progress){
    const applied=[];
    const unresolved=[];
    for(let i=0;i<clean.edits.length;i+=1){
      const edit=clean.edits[i];
      progress({phase:'edit',index:i,total:clean.edits.length});
      const result=await applyEdit(edit);
      if(result.ok) applied.push(Object.assign({edit},result));
      else unresolved.push({edit,reason:result.reason});
    }
    return {applied,unresolved};
  }
  function progressFn(options){
    const onProgress=options&&typeof options.onProgress==='function'?options.onProgress:null;
    return info=>{
      if(onProgress){try{onProgress(info);}catch{}}
      emit('progress',info);
    };
  }
  async function apply(recipe, options){
    const clean=isPlain(recipe)?withoutServerKeys(recipe):recipe;
    const checked=validate(clean);
    if(!checked.ok) throw invalidRecipe(checked.errors);
    const progress=progressFn(options);
    const code=typeof recipe.code==='string'?recipe.code:'';
    progress({phase:'paper',paperId:clean.paperId});
    const opened=await ensurePaper(clean.paperId);
    const outcome=opened?await applyAll(clean,progress):{applied:[],unresolved:clean.edits.map(edit=>({edit,reason:'no_paper'}))};
    recordAssist(clean,code,outcome.applied.map(item=>item.id));
    lastRecipe={recipe:clean,code:assistCode,fileHash:(source()||{}).fileHash||'',outcome};
    progress({phase:'done'});
    emit('applied',lastRecipe);
    return outcome;
  }
  function pageText(page){
    return Number.isInteger(page)&&page>=1?pageTextOf(segments(),page-1):'';
  }
  function paperInfo(){
    const paper=boothCurrent();
    return {
      paperId:paper&&paper.id||'',title:paper&&paper.title||'',license:paper&&paper.license||'',
      pages:pageCount(segments())
    };
  }

  /* ---------- edit-step UI (event.html only: needs #booth-step-edit from booth.js) ---------- */
  const PROPS=new Set(['className','textContent','id','type','value','hidden','disabled']);
  function mountUi(doc){
    const editStep=doc.getElementById('booth-step-edit');
    if(!editStep||doc.getElementById('booth-recipe')) return;
    const html=doc.documentElement;
    const ui={tab:'find',listOpen:false,myai:false,busy:false,seq:0,summary:null};
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
    function currentPage(){
      const ws=workspace();
      try{return ws&&typeof ws.getPageIndex==='function'?ws.getPageIndex():null;}catch{return null;}
    }
    function keepScroll(task){
      const y=root.scrollY||0;
      return task().finally(()=>{try{root.scrollTo(0,y);}catch{}});
    }

    /* One 바꿀 글자 / 새 글자 / 바꾸기 form. opts.row marks an unresolved recipe edit. */
    function hitButton(item, chosen, pick){
      const selected=!!chosen&&chosen.pageIndex===item.pageIndex&&chosen.context===item.context;
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
      const state={chosen:null,timer:0,list:{total:0,more:0,items:[]}};
      const find=el('input',{id:id+'-q',type:'text',maxlength:'300',autocomplete:'off',spellcheck:'false',value:o.find||''});
      const repl=el('input',{id:id+'-r',type:'text',maxlength:'300',autocomplete:'off',spellcheck:'false',value:o.replace||''});
      const hits=el('div',{className:'booth-find-hits',role:'listbox','aria-label':'찾은 곳'});
      const more=el('p',{className:'booth-find-more',hidden:true});
      const go=el('button',{type:'submit',className:'booth-btn ink',textContent:'바꾸기'});
      const status=el('p',{className:'booth-feedback',role:'status','aria-live':'polite'});
      const note=o.note?el('p',{className:'booth-find-note',textContent:o.note}):null;
      const form=el('form',{className:'booth-find'+(o.row?' row':''),novalidate:'novalidate'},
        note,field(find,'바꿀 글자'),hits,more,field(repl,'새 글자'),go,status);
      function paint(){
        hits.textContent='';
        for(const item of state.list.items) hits.append(hitButton(item,state.chosen,pick));
        more.hidden=!state.list.more;
        say(more,state.list.more?state.list.more+'곳 더 있어요. 더 길게 적으면 줄어들어요.':'');
      }
      function render(){
        const query=find.value;
        state.list=query.trim()?searchHits(segments(),query,currentPage(),HIT_LIMIT):{total:0,more:0,items:[]};
        say(status,query.trim()&&!state.list.total?'이 논문에서 찾지 못했어요.':'');
        paint();
      }
      function pick(item){
        state.chosen=item;
        paint();
      }
      find.addEventListener('input',()=>{
        state.chosen=null;
        root.clearTimeout(state.timer);
        state.timer=root.setTimeout(render,120);
      });
      function editFor(){
        const edit={find:find.value,replace:repl.value};
        if(state.chosen) return Object.assign(edit,{page:state.chosen.pageIndex+1,context:state.chosen.context,hint:state.chosen.hint});
        if(o.context||o.page) return Object.assign(edit,{page:o.page,context:o.context});
        return edit;
      }
      function blocked(){
        if(!find.value.trim()) return '바꿀 글자를 적어 주세요.';
        if(repl.value===find.value) return '새 글자가 바꿀 글자와 같아요.';
        if(!source()) return '논문이 아직 열리지 않았어요.';
        if(!state.chosen&&!o.context&&state.list.total>1) return '같은 글자가 '+state.list.total+'곳에 있어요. 목록에서 한 곳을 골라 주세요.';
        return '';
      }
      function failText(result){
        return result.detail==='overlap'?'이미 고친 곳과 겹쳐요. 고친 곳 목록에서 먼저 지워 주세요.':REASON_TEXT[result.reason]||REASON_TEXT.not_found;
      }
      async function submit(){
        render();
        const problem=blocked();
        if(problem){say(status,problem);return;}
        go.disabled=true;
        say(status,'바꾸는 중…');
        const result=await keepScroll(()=>applyEdit(editFor()));
        go.disabled=false;
        if(!result.ok){say(status,failText(result));return;}
        if(typeof o.onDone==='function'){o.onDone(result);return;}
        find.value='';
        repl.value='';
        state.chosen=null;
        render();
        say(status,'바꿨어요 · '+(result.pageIndex+1)+'쪽. 아래 「다음」을 누르면 수정본을 만들어요.');
      }
      form.addEventListener('submit',event=>{event.preventDefault();void submit();});
      if(find.value) root.setTimeout(render,0);
      return {form,render};
    }

    const main=findForm({});
    const fix=el('div',{id:'booth-recipe-fix',className:'booth-recipe-fix',hidden:true});
    const listToggle=el('button',{id:'booth-find-list',type:'button',className:'booth-btn line slim','aria-expanded':'false',textContent:'문단 목록에서 고르기'});
    const myaiBox=el('div',{id:'booth-myai'});
    const myaiWait=el('p',{className:'booth-small booth-myai-wait',hidden:true,textContent:'준비 중'});
    const codeInput=el('input',{id:'booth-agent-code',type:'text',maxlength:'12',autocomplete:'off',spellcheck:'false',autocapitalize:'characters',placeholder:'R-7K3QXM'});
    const agentStatus=el('p',{id:'booth-agent-status',className:'booth-feedback',role:'status','aria-live':'polite'});
    const agentForm=el('form',{id:'booth-agent-form',className:'booth-find booth-agent',novalidate:'novalidate'},
      field(codeInput,'Agent 코드'),
      el('button',{type:'submit',className:'booth-btn ink',textContent:'불러오기'}),
      agentStatus,
      el('p',{className:'booth-small',textContent:'AI agent가 만든 레시피 코드를 넣으면 고친 곳을 이 논문에 그대로 적용해요. 확인과 제출은 직접 해요.'}));
    const card=el('section',{id:'booth-recipe-result',className:'booth-panel booth-recipe-card',hidden:true,'aria-live':'polite'});
    const tabs=[['find','직접 고치기'],['myai','내 AI에게'],['agent','Agent 코드']];
    const tabButtons={};
    const panes={
      find:el('div',{id:'booth-pane-find',className:'booth-pane',role:'tabpanel','aria-labelledby':'booth-tab-find'},fix,main.form,listToggle),
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

    function syncMode(){
      const on=html.dataset.boothStep==='edit'&&ui.tab==='find'&&!ui.listOpen;
      html.classList.toggle('booth-find-mode',on);
    }
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
    function selectTab(key){
      ui.tab=key;
      for(const [name] of tabs){
        tabButtons[name].setAttribute('aria-selected',String(name===key));
        panes[name].hidden=name!==key;
      }
      if(key==='myai') mountMyAi();
      if(key==='find') main.render();
      syncMode();
    }
    function openList(){
      ui.listOpen=!ui.listOpen;
      listToggle.setAttribute('aria-expanded',String(ui.listOpen));
      say(listToggle,ui.listOpen?'문단 목록 접기':'문단 목록에서 고르기');
      syncMode();
      const list=ui.listOpen?doc.querySelector('#paper-before-stage .paper-paragraph-list'):null;
      if(!list) return;
      list.open=true;
      if(typeof list.scrollIntoView==='function') list.scrollIntoView({block:'start'});
    }
    listToggle.addEventListener('click',openList);

    /* Result card: 적용 N곳 · 확인 필요 M곳, then one prefilled form per unresolved edit. */
    function byLine(entry){
      const agent=entry.recipe.agent||{};
      const who=[agent.name,agent.model].filter(Boolean).join(' · ');
      const kind={agent:'AI agent 레시피','my-ai':'내 AI 레시피',manual:'레시피'}[entry.recipe.source];
      return [kind,who,entry.code].filter(Boolean).join(' · ');
    }
    function paintCount(){
      const s=ui.summary;
      if(!s) return;
      const count=doc.getElementById('booth-recipe-count');
      if(count) count.textContent=(s.unresolved?s.applied+'곳 적용 · '+s.unresolved+'곳은 직접 골라 주세요':s.applied+'곳 적용했어요');
    }
    function fixRow(item){
      const holder={};
      holder.view=findForm({
        row:true,find:item.edit.find,replace:item.edit.replace,page:item.edit.page,context:item.edit.context,
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
      if(out.unresolved.length) fix.append(el('p',{className:'booth-klab',textContent:'확인 필요 · 바꿀 곳을 다시 골라 주세요'}));
      for(const item of out.unresolved) fix.append(fixRow(item));
      fix.hidden=!out.unresolved.length;
      if(out.unresolved.length) selectTab('find');
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
    /* A recipe that would replace the open paper or join edits already made asks first, inline. */
    function confirmText(count, differentPaper){
      if(differentPaper&&count) return '지금 고친 곳 '+count+'개가 사라져요. 레시피를 불러올까요?';
      if(differentPaper) return '지금 연 논문이 레시피의 논문으로 바뀌어요. 레시피를 불러올까요?';
      return '지금 고친 곳 '+count+'개는 그대로 두고 레시피를 더해요. 레시피를 불러올까요?';
    }
    function placeConfirm(box){
      const old=doc.getElementById('booth-recipe-confirm');
      if(old) old.remove();
      if(html.dataset.boothStep==='edit') card.before(box);
      else pickStatus.after(box);
    }
    function askConfirm(text){
      return new Promise(resolve=>{
        const yes=el('button',{id:'booth-recipe-confirm-yes',type:'button',className:'booth-btn ink',textContent:'불러오기'});
        const no=el('button',{id:'booth-recipe-confirm-no',type:'button',className:'booth-btn line',textContent:'취소'});
        const box=el('div',{id:'booth-recipe-confirm',className:'booth-panel booth-recipe-confirm',role:'alertdialog','aria-labelledby':'booth-recipe-confirm-text'},
          el('p',{id:'booth-recipe-confirm-text',className:'booth-recipe-confirm-text',textContent:text}),
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
      const count=enabledEdits().length;
      const current=boothCurrent();
      const differentPaper=!!source()&&!(current&&current.id===recipe.paperId);
      if(!count&&!differentPaper) return Promise.resolve(true);
      return askConfirm(confirmText(count,differentPaper));
    }
    async function loadCode(raw){
      if(ui.busy) return;
      const code=normalizeCode(raw);
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

    /* Send step: reason/type prefill for recipe edits and the 수정본 쪽 보기 toggle per card. */
    function outputPage(pageMap, pageIndex){
      if(!Array.isArray(pageMap)) return pageIndex;
      const row=pageMap.find(item=>item&&item.sourcePageIndex===pageIndex);
      return row&&Number.isSafeInteger(row.outputPageIndex)?row.outputPageIndex:pageIndex;
    }
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
    /* {canvas, page, lib}; the caller cleans the page up once it has painted any marks. */
    async function renderPage(file, pageNumber, cssWidth, label){
      const {preview,lib}=await pdfLib();
      const pdf=await pdfFor(lib,preview,file);
      const page=await pdf.getPage(Math.min(Math.max(1,pageNumber),pdf.numPages));
      const viewport=page.getViewport({scale:preview.fitScale(page.getViewport({scale:1}),cssWidth,root.devicePixelRatio||1)});
      const canvas=el('canvas',{className:'booth-recipe-page',role:'img','aria-label':label});
      canvas.width=Math.max(1,Math.floor(viewport.width));
      canvas.height=Math.max(1,Math.floor(viewport.height));
      await page.render({canvasContext:canvas.getContext('2d'),canvas,viewport}).promise;
      return {canvas,page,lib};
    }
    function percentBox(left, top, width, height, surface){
      const w=surface.clientWidth||1;
      const h=surface.clientHeight||1;
      return {left:left/w*100,top:top/h*100,right:(left+width)/w*100,bottom:(top+height)/h*100};
    }
    function unionBox(a, b){
      if(!a) return b;
      return {left:Math.min(a.left,b.left),top:Math.min(a.top,b.top),right:Math.max(a.right,b.right),bottom:Math.max(a.bottom,b.bottom)};
    }
    /* Workspace change marks (paper-change-marks.js) on the generated page, kept in % so they follow resizes. */
    function marksToPercent(layer, surface){
      let box=null;
      for(const mark of [...layer.children]){
        const part=percentBox(parseFloat(mark.style.left)||0,parseFloat(mark.style.top)||0,parseFloat(mark.style.width)||0,parseFloat(mark.style.height)||0,surface);
        Object.assign(mark.style,{left:part.left+'%',top:part.top+'%',width:(part.right-part.left)+'%',height:(part.bottom-part.top)+'%'});
        box=unionBox(box,part);
      }
      return box;
    }
    async function paintMarks(surface, page, lib, edit){
      const marks=root.FalsifyChangeMarks;
      const base=page.getViewport({scale:1});
      const scale=(surface.clientWidth||0)/base.width;
      if(!marks||typeof marks.paintPage!=='function'||typeof lib.TextLayer!=='function'||!(scale>0)) return null;
      const viewport=page.getViewport({scale});
      const content=await page.getTextContent();
      const text=el('div',{className:'paper-text-layer textLayer'});
      for(const [name,value] of [['--total-scale-factor',String(scale)],['--scale-round-x','1px'],['--scale-round-y','1px'],['--text-scale-factor','1']]) surface.style.setProperty(name,value);
      surface.append(text);
      const layer=new lib.TextLayer({textContentSource:content,container:text,viewport});
      await layer.render();
      const result=marks.paintPage({document:doc,container:surface,items:content.items,divs:layer.textDivs,edits:[{id:edit.id,before:edit.before,after:edit.after}],side:'after'});
      text.remove();
      if(!result.count){result.layer.remove();return null;}
      return marksToPercent(result.layer,surface);
    }
    /* Fallback: the edited segment's rectangle (anchor.bbox, page units at scale 1). */
    function anchorBox(page, edit){
      const box=edit.anchor&&edit.anchor.bbox;
      if(!Array.isArray(box)||box.length!==4||!box.every(Number.isFinite)) return null;
      const base=page.getViewport({scale:1});
      return {left:box[0]/base.width*100,top:box[1]/base.height*100,right:box[2]/base.width*100,bottom:box[3]/base.height*100};
    }
    /* At least 8% x 4% of the page and padded, so a one-word change stays easy to spot on a phone. */
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
    async function markChange(surface, rendered, edit){
      let box=null;
      let how='';
      try{box=await paintMarks(surface,rendered.page,rendered.lib,edit);how=box?'marks':'';}catch{box=null;}
      if(!box){box=anchorBox(rendered.page,edit);how=box?'bbox':'none';}
      if(box) drawOutline(surface,box);
      surface.dataset.mark=how;
    }
    function currentOutput(){
      const ws=workspace();
      try{
        if(ws&&typeof ws.getCurrentOutput==='function'&&ws.getCurrentOutput()) return ws.getCurrentOutput();
        return ws&&typeof ws.getOutput==='function'?ws.getOutput():null;
      }catch{return null;}
    }
    function shotFigure(caption, canvas){
      const surface=el('div',{className:'booth-recipe-shot'},canvas);
      return {surface,figure:el('figure',{},el('figcaption',{textContent:caption}),surface)};
    }
    async function fillCompare(view, edit){
      const status=el('p',{className:'booth-small',textContent:'쪽 그림을 그리는 중…'});
      view.textContent='';
      view.append(status);
      const src=source();
      const out=currentOutput();
      if(!src||!out||!out.file){say(status,'수정본이 아직 없어요. 「← 고치기」에서 「다음」을 다시 눌러 주세요.');return;}
      const pageIndex=edit.pageIndex;
      const outIndex=outputPage(out.pageMap,pageIndex);
      const width=Math.max(120,Math.floor((view.clientWidth||300)/2)-6);
      try{
        const [before,after]=await Promise.all([
          renderPage(src.file,pageIndex+1,width,'원본 '+(pageIndex+1)+'쪽'),
          renderPage(out.file,outIndex+1,width,'수정본 '+(outIndex+1)+'쪽')
        ]);
        const left=shotFigure('원본',before.canvas);
        const right=shotFigure('수정본 · '+(outIndex+1)+'쪽',after.canvas);
        view.textContent='';
        view.append(left.figure,right.figure);
        before.page.cleanup();
        await markChange(right.surface,after,edit);
        after.page.cleanup();
      }catch{say(status,'쪽 그림을 그리지 못했어요. 수정본 PDF는 그대로 제출할 수 있어요.');}
    }
    function prefillCard(node, edit){
      const entry=lastRecipe;
      if(!entry||!appliedIds||!appliedIds.has(edit.id)) return;
      const reason=node.querySelector('textarea');
      if(reason&&!reason.value&&entry.recipe.reason){
        reason.value=entry.recipe.reason;
        reason.dispatchEvent(new Event('input',{bubbles:true}));
      }
      const label=DEFECT_LABELS[entry.recipe.defectType];
      if(!label||node.querySelector('.booth-chip.on')) return;
      const chip=[...node.querySelectorAll('.booth-chip')].find(item=>item.textContent===label);
      if(chip) chip.click();
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
      const edits=enabledEdits();
      [...box.querySelectorAll('.booth-card')].forEach((node,i)=>decorateCard(node,edits[i]));
    }
    function onStep(){
      const step=html.dataset.boothStep;
      if(step==='edit'&&lastRecipe&&lastRecipe.fileHash!==((source()||{}).fileHash||'')) resetResult();
      if(step==='edit'&&ui.tab==='find') main.render();
      if(step==='send') decorateRows();
      syncMode();
    }
    const Observer=root.MutationObserver;
    if(typeof Observer==='function'){
      new Observer(onStep).observe(html,{attributes:true,attributeFilter:['data-booth-step']});
      const rows=doc.getElementById('booth-rows');
      if(rows) new Observer(decorateRows).observe(rows,{childList:true});
    }
    listeners.add((kind,entry)=>{if(kind==='applied') renderResult(entry);});
    doc.addEventListener('falsify:document-clear',resetResult);
    doc.addEventListener('falsify:paper-workspace-source',()=>{if(ui.tab==='find') main.render();});
    root.addEventListener('hashchange',fromHash);
    onStep();
    fromHash();
  }

  root.FalsifyBoothRecipe=Object.freeze({
    validate,apply,fromCode,pageText,paperInfo,setAssist,assist,
    normalizeCode,normalizeText,locate,searchHits,
    SCHEMA
  });
  if(root.document&&typeof root.document.getElementById==='function') mountUi(root.document);
})(typeof window==='object'?window:globalThis);
