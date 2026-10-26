/* RED paper surface: one original PDF page, direct edits, and the exact generated file.
   Edit core, external import, and browser export are optional globals. Missing ones stay unavailable. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  const doc=typeof document!=='undefined'?document:null;
  if(doc&&typeof doc.querySelector==='function'&&doc.querySelector('#paper-workspace')&&!root.FalsifyPaperWorkspace){
    root.FalsifyPaperWorkspace=api.create({document:doc});
    const fire=()=>doc.dispatchEvent(new CustomEvent('falsify:paper-workspace-ready'));
    if(typeof setTimeout==='function')setTimeout(fire,0);else fire();
  }
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const ORIGINS=new Set(['human','external-ai-import','ai-proposal']);
  const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
  const HEX=/^[0-9a-f]{64}$/;
  const SECRET=/^(file|bytes|data|token|password|authorization|secret|pdfbytes)$/i;
  const ZOOMS=[0.75,1,1.25,1.5,2];
  const TTL=12*60*60*1000;
  const SVG='http://www.w3.org/2000/svg';
  const round=n=>Math.round(n*1000)/1000;

  function pageIndexFromLabel(label){
    const m=/^PDF p\. (\d+)$/.exec(String(label||''));
    if(!m)return null;
    const n=Number(m[1]);
    return Number.isSafeInteger(n)&&n>=1?n-1:null;
  }
  function segmentPage(seg){
    if(!seg||typeof seg!=='object')return null;
    if(Number.isSafeInteger(seg.pageIndex)&&seg.pageIndex>=0)return seg.pageIndex;
    return pageIndexFromLabel(seg.label);
  }
  function normalizeOrigin(options){
    const o=options&&typeof options==='object'?options:{};
    const origin=typeof o.origin==='string'&&o.origin?o.origin:'external-ai-import';
    if(!ORIGINS.has(origin))return {ok:false,origin:null,model:undefined};
    const model=origin==='ai-proposal'&&typeof o.model==='string'&&MODEL.test(o.model)?o.model:undefined;
    return {ok:true,origin,model};
  }
  function classifyOne(p,segs){
    const before=p&&typeof p.before==='string'?p.before:'';
    const after=p&&typeof p.after==='string'?p.after:'';
    const base={before,after,segmentId:null,pageIndex:null,anchor:null,status:'missing',matches:[],reason:'형식이 맞지 않습니다.'};
    if(!p||typeof p!=='object'||!before.trim()||!after.trim()||before===after||before.length>4000||after.length>4000)return base;
    let pool=segs;
    if(typeof p.segmentId==='string'&&p.segmentId){
      pool=segs.filter(s=>s&&s.id===p.segmentId);
      if(!pool.length)return {...base,reason:'해당 구간이 원문에 없습니다.'};
    }
    const matches=[];
    for(const seg of pool){
      if(!seg||typeof seg.text!=='string'||typeof seg.id!=='string')continue;
      const at=seg.text.indexOf(before);
      if(at<0)continue;
      if(seg.text.indexOf(before,at+1)>=0)return {...base,status:'ambiguous',reason:'한 구간 안에 같은 Before가 둘 이상입니다.'};
      matches.push({segmentId:seg.id,pageIndex:segmentPage(seg),start:at,end:at+before.length});
    }
    if(!matches.length)return {...base,reason:'원문에서 정확히 한 번 찾지 못했습니다.'};
    if(matches.length>1)return {...base,status:'ambiguous',matches,reason:'같은 Before가 둘 이상의 구간에 있습니다.'};
    const m=matches[0];
    if(!Number.isSafeInteger(m.pageIndex)||m.pageIndex<0)return {...base,matches,reason:'쪽 번호를 확정하지 못했습니다.'};
    if(Number.isSafeInteger(p.pageIndex)&&p.pageIndex!==m.pageIndex)return {...base,status:'ambiguous',matches,reason:'제안의 쪽 번호와 원문 위치가 다릅니다.'};
    return {before,after,segmentId:m.segmentId,pageIndex:m.pageIndex,anchor:{start:m.start,end:m.end,occurrence:0},status:'matched',matches,reason:''};
  }
  function classifyProposals(proposals,segments,options){
    const norm=normalizeOrigin(options);
    const segs=Array.isArray(segments)?segments:[];
    const items=(Array.isArray(proposals)?proposals:[]).map(p=>classifyOne(p,segs));
    return {...norm,items};
  }
  function indexItems(items){
    let text='';
    const spans=[];
    (items||[]).forEach((item,i)=>{
      if(!item||typeof item.str!=='string')return;
      const start=text.length;
      text+=item.str;
      if(item.str)spans.push({i,start,end:text.length,str:item.str});
      if(item.hasEOL)text+='\n';
    });
    return {text,spans};
  }
  function itemTopLeft(item,viewBox){
    const tr=item&&item.transform;
    if(!tr||tr.length<6||!viewBox||viewBox.length<4)return null;
    const [a,b,c,d,e,f]=tr,w=Number(item.width)||0,h=Number(item.height)||0;
    if(![a,b,c,d,e,f,w,h].every(Number.isFinite))return null;
    const pts=[[0,0],[w,0],[0,h],[w,h]].map(([x,y])=>[a*x+c*y+e,b*x+d*y+f]);
    const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
    const pdf=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
    const left=Math.min(pdf[0],pdf[2])-viewBox[0],right=Math.max(pdf[0],pdf[2])-viewBox[0];
    const top=viewBox[3]-Math.max(pdf[1],pdf[3]),bottom=viewBox[3]-Math.min(pdf[1],pdf[3]);
    if(!(left<right&&top<bottom))return null;
    return [round(left),round(top),round(right),round(bottom)];
  }
  function union(boxes){
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const b of boxes){x0=Math.min(x0,b[0]);y0=Math.min(y0,b[1]);x1=Math.max(x1,b[2]);y1=Math.max(y1,b[3]);}
    return [round(x0),round(y0),round(x1),round(y1)];
  }
  function occurrenceOf(text,needle,start){
    if(!needle)return null;
    let count=0,from=0;
    while(from<=start){
      const at=text.indexOf(needle,from);
      if(at<0||at>start)return null;
      if(at===start)return count;
      count+=1;from=at+needle.length;
    }
    return null;
  }
  function anchorFromSelection(items,viewBox,hitIndexes){
    if(!Array.isArray(items)||!Array.isArray(hitIndexes)||!hitIndexes.length)return null;
    const index=indexItems(items),wanted=new Set(hitIndexes);
    const ordered=index.spans.filter(s=>wanted.has(s.i));
    if(ordered.length!==wanted.size)return null;
    const first=index.spans.indexOf(ordered[0]),last=index.spans.indexOf(ordered[ordered.length-1]);
    if(last-first+1!==ordered.length)return null;
    for(let k=1;k<ordered.length;k++){
      const gap=index.text.slice(ordered[k-1].end,ordered[k].start);
      if(gap!==''&&gap!=='\n')return null;
    }
    const start=ordered[0].start,end=ordered[ordered.length-1].end,before=index.text.slice(start,end);
    if(!before.trim())return null;
    const occurrence=occurrenceOf(index.text,before,start);
    if(!Number.isSafeInteger(occurrence))return null;
    const boxes=[];
    for(const span of ordered){
      const box=itemTopLeft(items[span.i],viewBox);
      if(!box)return null;
      boxes.push(box);
    }
    return {before,anchor:{bbox:union(boxes),occurrence,start,end}};
  }
  function clampScale(base,stageWidth,factor,fitScale){
    if(!base||typeof fitScale!=='function')return 0;
    const fit=fitScale(base,stageWidth>0?stageWidth:720,1);
    let s=(fit>0?fit:0)*(factor>0?factor:1);
    const w=base.width,h=base.height;
    if(!(w>0&&h>0)||!(s>0))return 0;
    const cap=Math.min(2,4096/w,4096/h,Math.sqrt((4096*4096)/(w*h)));
    if(s>cap)s=cap;
    return s>0?s:0;
  }
  function isFile(f){return !!f&&typeof f.arrayBuffer==='function'&&typeof f.size==='number'&&typeof f.name==='string';}
  function isPdf(file){return String(file&&file.name||'').toLowerCase().endsWith('.pdf')||file&&file.type==='application/pdf';}
  function clone(v){try{return JSON.parse(JSON.stringify(v));}catch{return null;}}
  function scrub(value,depth){
    if(depth>5)return null;
    if(Array.isArray(value))return value.slice(0,24).map(v=>scrub(v,depth+1));
    if(!value||typeof value!=='object')return typeof value==='string'?value.slice(0,400):value;
    const out={};
    for(const [k,v] of Object.entries(value)){if(SECRET.test(k))continue;out[k]=scrub(v,depth+1);}
    return out;
  }
  function draftUnsafe(value,depth){
    if(depth>8)return true;
    if(typeof value==='string')return value.length>12000;
    if(!value||typeof value!=='object')return false;
    for(const [k,v] of Object.entries(value)){if(SECRET.test(k)||draftUnsafe(v,depth+1))return true;}
    return false;
  }
  function safeMessage(e){
    const m=e&&typeof e.message==='string'?e.message:'';
    if(!m||m.length>240||/[<>]/.test(m))return '이유를 표시하지 않습니다.';
    return m;
  }
  function originText(origin,model){
    if(origin==='ai-proposal')return model?'AI 제안 · '+model:'AI 제안 · 모델 식별 없음';
    if(origin==='human')return '직접 편집';
    return '외부 제안 · 모델 실행으로 기록하지 않음';
  }

  function create(deps){
    deps=deps||{};
    const doc=deps.document;
    if(!doc||typeof doc.querySelector!=='function')throw new Error('document required');
    const need=id=>{const node=doc.querySelector('#'+id);if(!node)throw new Error('missing #'+id);return node;};
    const ui={
      root:need('paper-workspace'),status:need('paper-workspace-status'),file:need('paper-file'),
      original:need('paper-original-download'),prev:need('paper-page-prev'),pageLabel:need('paper-page-label'),next:need('paper-page-next'),
      zoomOut:need('paper-zoom-out'),zoomLabel:need('paper-zoom-label'),zoomIn:need('paper-zoom-in'),
      beforeStage:need('paper-before-stage'),beforeStatus:need('paper-before-status'),
      afterLabel:need('paper-after-label'),afterStage:need('paper-after-stage'),afterStatus:need('paper-after-status'),
      inline:need('paper-inline'),inlineMeta:need('paper-inline-meta'),inlineBefore:need('paper-inline-before'),inlineAfter:need('paper-inline-after'),
      inlineApply:need('paper-inline-apply'),inlineCancel:need('paper-inline-cancel'),
      coreNote:need('paper-core-note'),editStatus:need('paper-edit-status'),undo:need('paper-undo'),redo:need('paper-redo'),edits:need('paper-edits'),
      exportNote:need('paper-export-note'),generate:need('paper-generate'),genStatus:need('paper-generate-status'),hash:need('paper-output-hash'),
      current:need('paper-current-download'),team:need('paper-team-share'),blue:need('paper-blue-handoff'),
      draftOpt:need('paper-draft-opt'),draftSave:need('paper-draft-save'),draftRestore:need('paper-draft-restore'),draftDelete:need('paper-draft-delete'),draftStatus:need('paper-draft-status'),
      proposals:need('paper-proposals'),proposalList:need('paper-proposal-list'),proposalStatus:need('paper-proposal-status')
    };
    const timers=deps.timers||globalThis,urls=deps.urls||globalThis.URL;
    const now=()=>typeof deps.now==='function'?deps.now():Date.now();
    const previewApi=()=>deps.preview||globalThis.FalsifyPreview||null;
    const editsApi=()=>deps.edits||globalThis.FalsifyPaperEdits||null;
    const exporterApi=()=>deps.exporter||globalThis.FalsifyBrowserPdf||null;
    const store=()=>deps.storage||globalThis.localStorage||null;
    let epoch=0,source=null,session=null,unsub=null,snapshot=null,output=null,inline=null,pageText=null;
    let proposalQueue=null,accepted=new Set(),modelById=new Map(),draftRaw=null,pendingFocus=null;
    let page=1,pages=0,zoom=1,drawSeq=0,afterSeq=0,loadTask=null,textLayerHandle=null,genCtl=null,genId=0,generating=false,afterTask=null,afterRender=null;

    function emit(name,detail){doc.dispatchEvent(new CustomEvent(name,{detail}));}
    function say(node,text,error){if(!node)return;node.textContent=text||'';node.classList.toggle('error',!!error);}
    function setStatus(text,error){say(ui.status,text,error);}
    function setBeforeStatus(text,error){say(ui.beforeStatus,text,error);}
    function setAfterStatus(text,error){say(ui.afterStatus,text,error);}
    function setEditStatus(text,error){say(ui.editStatus,text,error);}
    function setGenStatus(text,error){say(ui.genStatus,text,error);}
    function setDraftStatus(text,error){say(ui.draftStatus,text,error);}
    function setProposalStatus(text,error){say(ui.proposalStatus,text,error);}
    async function sha256Hex(bytes){
      const subtle=deps.subtle||globalThis.crypto?.subtle;
      if(!subtle)throw new Error('해시를 계산할 수 없습니다.');
      return Array.from(new Uint8Array(await subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    }
    function buttons(node){
      const out=[];
      (function walk(n){for(const c of n.children||[]){if(c.tagName==='button'||c.tagName==='BUTTON')out.push(c);walk(c);}})(node);
      return out;
    }
    function wipe(node){
      if(!node)return;
      for(const c of [...(node.children||[])])wipe(c);
      if(String(node.tagName||'').toLowerCase()==='canvas'){node.width=0;node.height=0;}
    }
    function clearStage(stage){if(!stage)return;wipe(stage);stage.replaceChildren();}
    function fieldTarget(target){
      const tag=target&&target.tagName;
      if(tag==='textarea'||tag==='TEXTAREA'||tag==='select'||tag==='SELECT')return true;
      if(tag==='input'||tag==='INPUT')return target.type!=='checkbox'&&target.type!=='button';
      return false;
    }
    function stale(){return !!output&&(!snapshot||snapshot.revision!==output.revision);}
    function enabledEdits(){return (snapshot&&snapshot.edits||[]).filter(e=>e&&e.enabled!==false);}
    function draftKey(){return source&&source.fileHash?'falsify.paper-draft.v1.'+source.fileHash:null;}

    function paintIcon(node,name){
      if(!node||typeof doc.createElementNS!=='function'||buttons(node).length&&node.querySelector)return;
      if(typeof node.querySelector==='function'&&node.querySelector('svg'))return;
      try{
        const svg=doc.createElementNS(SVG,'svg'),use=doc.createElementNS(SVG,'use');
        svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
        use.setAttribute('href','./vendor/lucide.svg#'+name);svg.append(use);node.prepend(svg);
      }catch{/* the text label remains */}
    }
    function handFocus(active,disabled,alt){
      if(active===disabled&&disabled.disabled&&alt&&!alt.disabled)alt.focus();
    }
    function syncNav(){
      ui.prev.disabled=!(pages>1&&page>1);
      ui.next.disabled=!(pages>1&&page<pages);
      ui.pageLabel.textContent=pages?page+' / '+pages+'쪽':'';
      const active=doc.activeElement;
      handFocus(active,ui.next,ui.prev);handFocus(active,ui.prev,ui.next);
      if((doc.activeElement===ui.prev||doc.activeElement===ui.next)&&ui.prev.disabled&&ui.next.disabled)ui.beforeStage.focus();
      const zi=ZOOMS.indexOf(zoom);
      ui.zoomOut.disabled=!source||!source.doc||zi<=0;
      ui.zoomIn.disabled=!source||!source.doc||zi<0||zi>=ZOOMS.length-1;
      ui.zoomLabel.textContent=Math.round(zoom*100)+'%';
      handFocus(doc.activeElement,ui.zoomIn,ui.zoomOut);handFocus(doc.activeElement,ui.zoomOut,ui.zoomIn);
    }
    function renderChrome(){
      const pdf=!!(source&&source.pdf),ready=!!(source&&source.fileHash);
      ui.original.disabled=!source;
      ui.coreNote.textContent=editsApi()?'':'편집 코어가 아직 없습니다. 쪽 보기와 원본 다운로드는 사용할 수 있지만 편집은 저장되지 않습니다.';
      ui.exportNote.textContent=!pdf&&source?'PDF가 아니라 브라우저에서 생성본을 만들지 않습니다.':exporterApi()?'':'브라우저 PDF 편집 모듈이 아직 없습니다. 생성본을 만들지 않으며, 성공으로 표시하지 않습니다.';
      ui.generate.disabled=generating||!exporterApi()||!pdf||!enabledEdits().length;
      ui.draftSave.disabled=!(ui.draftOpt.checked&&session&&ready);
      ui.draftRestore.hidden=!draftRaw;
      ui.draftDelete.disabled=!draftRaw;
      const blocked=!output||output.blocked;
      ui.current.disabled=blocked;
      ui.current.textContent=output&&stale()?'마지막 생성본 다운로드':'현재 생성본 다운로드';
      ui.team.disabled=blocked;
      ui.blue.disabled=blocked;
      ui.hash.textContent=output&&!output.blocked?'SHA-256 '+output.sha256:'';
      ui.afterLabel.textContent=!output?'아직 생성본이 없습니다':stale()?'마지막 생성본 · 현재 편집과 다름':'현재 생성본';
      syncNav();
    }
    function renderInline(){
      ui.inline.hidden=!inline;
      if(!inline){ui.inlineBefore.textContent='';ui.inlineMeta.textContent='';ui.inlineAfter.value='';return;}
      ui.inlineBefore.textContent=inline.before;
      ui.inlineAfter.value=inline.after||'';
      const box=inline.anchor&&inline.anchor.bbox;
      ui.inlineMeta.textContent='쪽 '+(inline.pageIndex+1)+(Number.isSafeInteger(inline.anchor&&inline.anchor.occurrence)?' · occurrence '+inline.anchor.occurrence:'')+(box?' · 좌표 '+box.join(', '):'');
    }
    function renderEdits(){
      const active=doc.activeElement;
      const keep=!pendingFocus&&active&&ui.edits.contains&&ui.edits.contains(active)?{id:active.dataset&&active.dataset.edit,act:active.dataset&&active.dataset.act}:pendingFocus;
      pendingFocus=null;
      ui.edits.replaceChildren();
      const edits=snapshot&&snapshot.edits||[];
      if(!edits.length){const li=doc.createElement('li');li.textContent='아직 편집이 없습니다.';ui.edits.append(li);}
      for(const edit of edits){
        const li=doc.createElement('li');
        const jump=doc.createElement('button');jump.type='button';jump.className='button secondary';jump.dataset.edit=edit.id;jump.dataset.act='jump';
        jump.textContent='쪽 '+(Number(edit.pageIndex)+1)+' · '+String(edit.before||'').slice(0,40)+' → '+String(edit.after||'').slice(0,40);
        const toggle=doc.createElement('button');toggle.type='button';toggle.className='button secondary';toggle.dataset.edit=edit.id;toggle.dataset.act='toggle';
        toggle.textContent=edit.enabled===false?'켜기':'끄기';toggle.setAttribute('aria-pressed',String(edit.enabled!==false));
        const change=doc.createElement('button');change.type='button';change.className='button secondary';change.dataset.edit=edit.id;change.dataset.act='edit';change.textContent='After 수정';
        const del=doc.createElement('button');del.type='button';del.className='button secondary';del.dataset.edit=edit.id;del.dataset.act='delete';del.textContent='삭제';
        const note=doc.createElement('span');note.className='paper-edit-origin';note.textContent=originText(edit.origin,modelById.get(edit.id));
        jump.addEventListener('click',()=>onJump(edit));
        toggle.addEventListener('click',()=>{if(session)session.setEnabled(edit.id,edit.enabled===false);});
        change.addEventListener('click',()=>loadInline(edit));
        del.addEventListener('click',()=>onDelete(edit));
        li.append(jump,toggle,change,del,note);ui.edits.append(li);
      }
      ui.undo.disabled=!snapshot||!snapshot.canUndo;
      ui.redo.disabled=!snapshot||!snapshot.canRedo;
      if(keep&&keep.act==='undo')ui.undo.focus();
      else if(keep&&keep.id){
        const found=buttons(ui.edits).find(b=>b.dataset.edit===keep.id&&(!keep.act||b.dataset.act===keep.act))||buttons(ui.edits).find(b=>b.dataset.edit===keep.id);
        if(found)found.focus();else ui.undo.focus();
      }
      renderChrome();
    }
    function paintProposals(){
      const queue=proposalQueue;
      ui.proposals.hidden=!queue||!queue.proposals.length;
      ui.proposalList.replaceChildren();
      if(!queue)return;
      const classified=classifyProposals(queue.proposals,source&&source.segments||[],{origin:queue.origin,model:queue.model});
      classified.items.forEach((item,index)=>{
        const li=doc.createElement('li'),title=doc.createElement('span');
        title.textContent=originText(queue.origin,queue.model)+(item.status==='matched'?' · 한 곳':' · '+item.reason);
        const accept=doc.createElement('button');accept.type='button';accept.className='button secondary';accept.textContent='이 제안 받아들이기';
        accept.disabled=item.status!=='matched'||accepted.has(index);
        accept.addEventListener('click',()=>{if(!accept.disabled)acceptOne(index);});
        const body=doc.createElement('p');body.textContent=String(item.before||'').slice(0,80)+' → '+String(item.after||'').slice(0,80);
        li.append(title,body,accept);ui.proposalList.append(li);
      });
    }
    function onSnapshot(snap){snapshot=snap;emit('falsify:paper-workspace-edits',clone(snap));renderEdits();paintProposals();void drawAfter();}
    function ensureSession(force){
      const api=editsApi();
      if(!api||typeof api.create!=='function'||!source||!source.fileHash)return;
      const hasEdits=snapshot&&Array.isArray(snapshot.edits)&&snapshot.edits.length;
      if(session&&!force)return;
      if(session&&hasEdits)return;
      if(typeof unsub==='function')unsub();
      try{
        session=api.create({fileHash:source.fileHash,name:source.name,segments:source.segments,now:now()});
        unsub=typeof session.subscribe==='function'?session.subscribe(onSnapshot):null;
        onSnapshot(typeof session.snapshot==='function'?session.snapshot():{schema:'falsify.paper-edits.v1',fileHash:source.fileHash,name:source.name,revision:0,edits:[],canUndo:false,canRedo:false});
      }catch(e){session=null;snapshot=null;setEditStatus('편집 코어가 세션을 만들지 않았습니다. '+safeMessage(e),true);}
    }
    function adoptSegments(raw){
      if(!source)return;
      source.segments=raw.map((s,i)=>{
        const id=s&&typeof s.id==='string'&&s.id?s.id:'s'+i;
        const pageIndex=s&&Number.isSafeInteger(s.pageIndex)?s.pageIndex:pageIndexFromLabel(s&&s.label);
        return Object.assign({},s,{id},pageIndex==null?{}:{pageIndex});
      });
      ensureSession(!(snapshot&&snapshot.edits&&snapshot.edits.length));
      if(source.fileHash)emit('falsify:paper-workspace-source',{fileHash:source.fileHash,name:source.name});
      paintProposals();
    }
    function stopPdf(){
      drawSeq++;
      try{source&&source.render&&source.render.cancel&&source.render.cancel();}catch{}
      try{textLayerHandle&&textLayerHandle.cancel&&textLayerHandle.cancel();}catch{}
      try{loadTask&&loadTask.destroy&&loadTask.destroy();}catch{}
      loadTask=null;textLayerHandle=null;
      if(source){source.doc=null;source.render=null;}
    }
    function releaseAfter(){
      try{afterRender&&afterRender.cancel&&afterRender.cancel();}catch{}
      try{afterTask&&afterTask.destroy&&afterTask.destroy();}catch{}
      afterTask=null;afterRender=null;
    }
    function closeAfter(){afterSeq++;releaseAfter();}
    function abortGen(){genId++;if(genCtl){genCtl.abort();genCtl=null;}generating=false;}
    function clearSource(){
      epoch++;abortGen();stopPdf();closeAfter();
      if(typeof unsub==='function')unsub();
      unsub=null;session=null;snapshot=null;output=null;inline=null;pageText=null;proposalQueue=null;accepted=new Set();draftRaw=null;
      source=null;pages=0;page=1;zoom=1;
      clearStage(ui.beforeStage);clearStage(ui.afterStage);
      renderInline();renderEdits();paintProposals();renderChrome();
      setStatus('');setBeforeStatus('');setAfterStatus('');
      emit('falsify:paper-workspace-source',{fileHash:null,name:''});
    }
    function lookDraft(){
      draftRaw=null;
      const key=draftKey(),box=store();
      if(!key||!box){renderChrome();return;}
      try{draftRaw=box.getItem(key)||null;}catch{draftRaw=null;}
      if(draftRaw)setDraftStatus('이 파일의 초안이 있습니다. 복구는 직접 눌렀을 때만, 12시간 검사를 거친 뒤에 됩니다.');
      renderChrome();
    }
    async function openFile(file){
      const mine=++epoch;
      abortGen();stopPdf();closeAfter();
      if(typeof unsub==='function')unsub();
      unsub=null;session=null;snapshot=null;output=null;inline=null;pageText=null;proposalQueue=null;accepted=new Set();draftRaw=null;
      pages=0;page=1;zoom=1;
      source={file,fileHash:null,name:String(file.name||'').slice(0,160),segments:[],pdf:isPdf(file),doc:null,lib:null,render:null};
      clearStage(ui.beforeStage);clearStage(ui.afterStage);renderInline();renderEdits();paintProposals();renderChrome();
      setStatus('원본 파일을 확인하는 중입니다.');
      try{
        const bytes=new Uint8Array(await file.arrayBuffer());
        if(epoch!==mine)return;
        const hash=await sha256Hex(bytes);
        if(epoch!==mine)return;
        source.fileHash=hash;
        ensureSession(false);lookDraft();
        emit('falsify:paper-workspace-source',{fileHash:hash,name:source.name});
        if(source.pdf)await openPdf(bytes,mine);
        else{setStatus('이 형식은 쪽 뷰어가 없습니다. 원본 다운로드는 사용할 수 있습니다.');renderChrome();}
      }catch(e){if(epoch===mine)setStatus('원본을 열지 못했습니다. 다운로드는 그대로 사용할 수 있습니다.',true);}
    }
    async function openPdf(bytes,mine){
      const preview=previewApi();
      if(!preview||typeof preview.defaultImport!=='function'||typeof preview.pdfParams!=='function'||typeof preview.fitScale!=='function'){
        setStatus('PDF.js 도우미가 없어 쪽을 그리지 못했습니다. 원본 다운로드는 사용할 수 있습니다.',true);return;
      }
      if(new TextDecoder().decode(bytes.subarray(0,1024)).indexOf('%PDF-')<0){
        setStatus('PDF 서명이 없어 쪽을 그리지 않았습니다. 원본 다운로드는 사용할 수 있습니다.',true);return;
      }
      setStatus('PDF를 이 브라우저에서 여는 중입니다.');
      let settled=false;
      const timer=timers.setTimeout(()=>{
        if(epoch!==mine||settled)return;settled=true;stopPdf();
        setStatus('60초 안에 PDF를 열지 못해 쪽 보기를 멈췄습니다. 원본 다운로드는 사용할 수 있습니다.',true);
      },60000);
      try{
        const lib=await preview.defaultImport();
        if(epoch!==mine||settled)return;
        source.lib=lib;
        if(lib.GlobalWorkerOptions)lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',doc.baseURI).href;
        const task=lib.getDocument(preview.pdfParams(bytes.slice(),doc.baseURI));
        loadTask=task;
        const pdf=await task.promise;
        if(epoch!==mine||settled)return;
        settled=true;timers.clearTimeout(timer);
        source.doc=pdf;pages=pdf.numPages;renderChrome();
        setStatus('');
        await drawBefore(1,mine);
      }catch(e){
        if(epoch!==mine||settled)return;
        settled=true;timers.clearTimeout(timer);
        const name=e&&e.name;
        const msg=name==='PasswordException'?'암호가 걸린 PDF라 쪽을 그리지 못했습니다.':name==='InvalidPDFException'?'PDF 구조를 읽지 못해 쪽을 그리지 못했습니다.':'이 브라우저에서 쪽을 그리지 못했습니다.';
        setStatus(msg+' 원본 다운로드는 사용할 수 있습니다.',true);
      }
    }
    async function drawBefore(n,mine){
      mine=mine==null?epoch:mine;
      if(!source||!source.doc||!Number.isSafeInteger(n)||n<1||n>pages||epoch!==mine)return;
      const seq=++drawSeq,live=()=>epoch===mine&&seq===drawSeq;
      page=n;renderChrome();
      try{source.render&&source.render.cancel&&source.render.cancel();}catch{}
      try{textLayerHandle&&textLayerHandle.cancel&&textLayerHandle.cancel();}catch{}
      setBeforeStatus(n+' / '+pages+'쪽을 그리는 중입니다.');
      let canvas=null,pdfPage=null;
      try{
        pdfPage=await source.doc.getPage(n);
        if(!live())return;
        const base=pdfPage.getViewport({scale:1});
        const preview=previewApi();
        const scale=clampScale(base,ui.beforeStage.clientWidth||0,zoom,preview&&preview.fitScale);
        if(!(scale>0))throw new Error('scale');
        const viewport=pdfPage.getViewport({scale});
        const pageEl=doc.createElement('div');pageEl.className='paper-page';
        pageEl.style.width=viewport.width+'px';pageEl.style.height=viewport.height+'px';
        pageEl.style.setProperty('--total-scale-factor',String(scale));
        pageEl.style.setProperty('--scale-round-x','1px');pageEl.style.setProperty('--scale-round-y','1px');
        pageEl.style.setProperty('--text-scale-factor','1');
        canvas=doc.createElement('canvas');canvas.className='paper-canvas';
        canvas.width=Math.max(1,Math.floor(viewport.width));canvas.height=Math.max(1,Math.floor(viewport.height));
        canvas.setAttribute('role','img');canvas.setAttribute('aria-label','원본 '+n+'쪽');
        const textEl=doc.createElement('div');textEl.className='paper-text-layer textLayer';
        pageEl.append(canvas,textEl);
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('canvas');
        const renderTask=pdfPage.render({canvasContext:ctx,canvas,viewport});
        source.render=renderTask;
        const contentPromise=pdfPage.getTextContent();
        await renderTask.promise;
        if(!live()){canvas.width=0;canvas.height=0;pdfPage.cleanup&&pdfPage.cleanup();return;}
        const content=await contentPromise;
        if(!live()){pdfPage.cleanup&&pdfPage.cleanup();return;}
        const items=Array.isArray(content.items)?content.items:[];
        if(source.lib&&source.lib.TextLayer){
          const handle=new source.lib.TextLayer({textContentSource:content,container:textEl,viewport});
          textLayerHandle=handle;
          await handle.render();
          if(!live()){handle.cancel&&handle.cancel();pdfPage.cleanup&&pdfPage.cleanup();return;}
          const divs=handle.textDivs||[];
          items.forEach((item,i)=>{if(divs[i]&&divs[i].dataset)divs[i].dataset.i=String(i);});
        }
        pageText={items,viewBox:viewport.viewBox||[0,0,base.width,base.height],pageIndex:n-1,textEl};
        clearStage(ui.beforeStage);ui.beforeStage.append(pageEl);
        pdfPage.cleanup&&pdfPage.cleanup();source.render=null;
        setBeforeStatus(n+' / '+pages+'쪽 · 원본 바이트');
        renderChrome();void drawAfter();
      }catch(e){
        if(!live()||e&&e.name==='RenderingCancelledException')return;
        if(canvas){canvas.width=0;canvas.height=0;}
        clearStage(ui.beforeStage);
        setBeforeStatus(n+'쪽을 그리지 못했습니다. 다른 쪽은 이전·다음으로 시도할 수 있습니다.',true);
      }
    }
    function captureSelection(){
      const sel=typeof doc.getSelection==='function'?doc.getSelection():null;
      if(!sel||sel.isCollapsed||!sel.rangeCount||!pageText||!pageText.textEl)return;
      const textEl=pageText.textEl,range=sel.getRangeAt(0);
      const inside=node=>textEl.contains&&node&&textEl.contains(node);
      if(!inside(range.commonAncestorContainer)&&!inside(sel.anchorNode))return;
      const hits=[];
      for(const node of textEl.querySelectorAll?textEl.querySelectorAll('span'):[]){
        if(!node.dataset||node.dataset.i==null)continue;
        let hit=false;
        try{hit=range.intersectsNode?range.intersectsNode(node):false;}catch{hit=false;}
        if(hit)hits.push(Number(node.dataset.i));
      }
      if(!hits.length&&sel.anchorNode){
        const el=sel.anchorNode.dataset?sel.anchorNode:sel.anchorNode.parentElement;
        if(el&&el.dataset&&el.dataset.i!=null&&inside(el))hits.push(Number(el.dataset.i));
      }
      if(!hits.length){setEditStatus('선택한 글의 위치를 한 곳으로 확정하지 못해 편집으로 넣지 않았습니다.',true);return;}
      const located=anchorFromSelection(pageText.items,pageText.viewBox,hits);
      if(!located){setEditStatus('선택한 글의 위치를 한 곳으로 확정하지 못해 편집으로 넣지 않았습니다.',true);return;}
      const same=(source.segments||[]).filter(s=>typeof s.text==='string'&&s.text.indexOf(located.before)===s.text.lastIndexOf(located.before)&&s.text.includes(located.before)&&segmentPage(s)===pageText.pageIndex);
      inline={before:located.before,after:'',anchor:located.anchor,pageIndex:pageText.pageIndex,segmentId:same.length===1?same[0].id:undefined,editId:null};
      renderInline();ui.inlineAfter.focus();
    }
    function loadInline(edit){
      inline={before:edit.before,after:edit.after,anchor:edit.anchor,pageIndex:edit.pageIndex,segmentId:edit.segmentId,editId:edit.id};
      onJump(edit);renderInline();ui.inlineAfter.focus();
    }
    function applyInline(){
      const api=editsApi();
      if(!api||!session){setEditStatus('편집 코어가 없어 편집을 저장하지 않았습니다.',true);return;}
      const after=ui.inlineAfter.value;
      if(!inline||typeof after!=='string'||!after.trim()||after===inline.before){setEditStatus('After가 비어 있거나 Before와 같아 저장하지 않았습니다.',true);return;}
      try{
        if(inline.editId)session.update(inline.editId,{after});
        else{
          const body={pageIndex:inline.pageIndex,before:inline.before,after,anchor:inline.anchor,origin:'human'};
          if(inline.segmentId)body.segmentId=inline.segmentId;
          session.add(body);
        }
        inline=null;renderInline();ui.beforeStage.focus();
        setEditStatus('직접 편집으로 기록했습니다. 모델 실행으로 기록하지 않습니다.');
      }catch(e){setEditStatus('편집을 저장하지 않았습니다. '+safeMessage(e),true);}
    }
    function onJump(edit){
      const n=Number(edit.pageIndex)+1;
      if(!(n>=1&&n<=pages)){setEditStatus('원본에 그 쪽이 없어 이동하지 못했습니다.',true);return;}
      void drawBefore(n);
    }
    function onDelete(edit){
      if(!session||!snapshot)return;
      const items=snapshot.edits||[],idx=items.findIndex(e=>e.id===edit.id);
      const neighbor=items[idx+1]||items[idx-1];
      pendingFocus=neighbor?{id:neighbor.id,act:'jump'}:{act:'undo'};
      session.remove(edit.id);
    }
    function acceptOne(index){
      if(!proposalQueue)return;
      const item=classifyProposals(proposalQueue.proposals,source&&source.segments||[],{origin:proposalQueue.origin,model:proposalQueue.model}).items[index];
      if(!item||item.status!=='matched'||accepted.has(index)){setProposalStatus('확정되지 않은 제안은 적용하지 않습니다.',true);return;}
      if(!session){setProposalStatus('편집 코어가 없어 제안을 적용하지 않았습니다.',true);return;}
      try{
        const id=session.add({pageIndex:item.pageIndex,segmentId:item.segmentId,before:item.before,after:item.after,anchor:item.anchor,origin:proposalQueue.origin});
        if(id&&proposalQueue.model)modelById.set(id,proposalQueue.model);
        accepted.add(index);paintProposals();
        setProposalStatus(originText(proposalQueue.origin,proposalQueue.model)+' 제안을 편집 목록에 넣었습니다.');
      }catch(e){setProposalStatus('제안을 적용하지 않았습니다. '+safeMessage(e),true);}
    }
    function acceptProposals(proposals,options){
      const norm=normalizeOrigin(options);
      if(!norm.ok){setProposalStatus('알 수 없는 제안 출처라 보여 주지 않았습니다.',true);return;}
      proposalQueue={proposals:Array.isArray(proposals)?proposals:[],origin:norm.origin,model:norm.model};
      accepted=new Set();paintProposals();
      ui.proposals.hidden=!proposalQueue.proposals.length;
    }
    async function drawAfter(){
      const seq=++afterSeq,mine=epoch,current=output;
      if(!current||current.blocked){clearStage(ui.afterStage);setAfterStatus(current?'생성 파일의 바이트가 해시와 달라 그리지 않았습니다.':'아직 생성본이 없습니다.');return;}
      const preview=previewApi();
      if(!preview){setAfterStatus('PDF.js 도우미가 없어 생성본을 그리지 못했습니다. 다운로드는 해시가 맞는 동안 사용할 수 있습니다.',true);return;}
      setAfterStatus((stale()?'마지막 생성본':'현재 생성본')+'을 확인하는 중입니다.');
      let canvas=null;
      try{
        const bytes=new Uint8Array(await current.file.arrayBuffer());
        if(seq!==afterSeq||epoch!==mine||output!==current)return;
        if(await sha256Hex(bytes)!==current.sha256){current.blocked=true;clearStage(ui.afterStage);setAfterStatus('생성 파일의 바이트가 해시와 달라 미리보기와 다시 받기를 멈췄습니다.',true);renderChrome();return;}
        const lib=source&&source.lib||await preview.defaultImport();
        if(seq!==afterSeq||epoch!==mine)return;
        if(lib.GlobalWorkerOptions)lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',doc.baseURI).href;
        releaseAfter();
        const task=lib.getDocument(preview.pdfParams(bytes.slice(),doc.baseURI));
        afterTask=task;
        const pdf=await task.promise;
        if(seq!==afterSeq||epoch!==mine||output!==current)return;
        if(page>pdf.numPages){setAfterStatus('이 생성본에는 원본 '+page+'쪽이 없습니다.');return;}
        const pdfPage=await pdf.getPage(page);
        if(seq!==afterSeq||epoch!==mine)return;
        const base=pdfPage.getViewport({scale:1});
        const scale=clampScale(base,ui.afterStage.clientWidth||ui.beforeStage.clientWidth||0,1,preview.fitScale);
        const viewport=pdfPage.getViewport({scale:scale>0?scale:1});
        canvas=doc.createElement('canvas');canvas.className='paper-canvas';
        canvas.width=Math.max(1,Math.floor(viewport.width));canvas.height=Math.max(1,Math.floor(viewport.height));
        canvas.setAttribute('role','img');canvas.setAttribute('aria-label',(stale()?'마지막 생성본 ':'현재 생성본 ')+page+'쪽');
        const ctx=canvas.getContext('2d');if(!ctx)throw new Error('canvas');
        const renderTask=pdfPage.render({canvasContext:ctx,canvas,viewport});
        afterRender=renderTask;await renderTask.promise;
        if(seq!==afterSeq||epoch!==mine||output!==current){canvas.width=0;canvas.height=0;return;}
        clearStage(ui.afterStage);ui.afterStage.append(canvas);pdfPage.cleanup&&pdfPage.cleanup();
        setAfterStatus((stale()?'마지막 생성본':'현재 생성본')+' · 받은 파일 바이트');
      }catch(e){
        if(seq!==afterSeq||epoch!==mine||e&&e.name==='RenderingCancelledException')return;
        if(canvas){canvas.width=0;canvas.height=0;}
        setAfterStatus('생성본 쪽을 그리지 못했습니다. 해시가 맞는 파일은 다운로드할 수 있습니다.',true);
      }
    }
    async function generate(){
      const api=exporterApi();
      if(!api||typeof api.prepare!=='function'){setGenStatus('브라우저 PDF 편집 모듈이 없어 생성하지 않았습니다. 원본 다운로드는 사용할 수 있습니다.',true);return;}
      if(!source||!source.pdf||!source.fileHash){setGenStatus('PDF 원본이 없어 생성하지 않았습니다.',true);return;}
      const edits=enabledEdits();
      if(!edits.length||!snapshot){setGenStatus('켠 편집이 없어 생성하지 않았습니다.',true);return;}
      const mine=++genId,epochAt=epoch,hash=source.fileHash,revision=snapshot.revision,file=source.file;
      if(genCtl)genCtl.abort();
      const ctl=typeof AbortController==='function'?new AbortController():{abort(){},signal:undefined};
      genCtl=ctl;generating=true;renderChrome();
      setGenStatus('생성 중입니다. 끝나기 전에 성공으로 표시하지 않습니다.');
      try{
        const result=await api.prepare({file,edits:JSON.parse(JSON.stringify(edits)),signal:ctl.signal});
        if(mine!==genId||epoch!==epochAt||!source||source.fileHash!==hash)return;
        if(!isFile(result&&result.file)||typeof result.sha256!=='string'||!HEX.test(result.sha256))throw new Error('생성 결과가 실제 파일이 아닙니다.');
        const bytes=new Uint8Array(await result.file.arrayBuffer());
        if(mine!==genId||epoch!==epochAt)return;
        if(await sha256Hex(bytes)!==result.sha256)throw new Error('생성 파일의 바이트와 해시가 달라 받지 않았습니다.');
        if(new TextDecoder().decode(bytes.subarray(0,1024)).indexOf('%PDF-')<0)throw new Error('생성 결과에 PDF 서명이 없어 받지 않았습니다.');
        output={file:result.file,sha256:result.sha256,verification:result.verification==null?null:result.verification,revision,blocked:false};
        emit('falsify:paper-workspace-output',{sha256:output.sha256,revision:output.revision,verification:scrub(output.verification,0)});
        setGenStatus(stale()?'생성본을 받았지만 그 사이 편집이 바뀌어 마지막 생성본으로만 표시합니다.':'생성본을 받았습니다. 미리보기와 다운로드는 이 파일의 바이트입니다.');
        await drawAfter();
      }catch(e){
        if(mine!==genId||epoch!==epochAt||!source||source.fileHash!==hash)return;
        if(ctl.signal&&ctl.signal.aborted){setGenStatus('생성을 중단했습니다. 마지막 생성본은 그대로입니다.');return;}
        setGenStatus('생성하지 못했습니다. 마지막 생성본은 그대로입니다. '+safeMessage(e),true);
      }finally{if(genCtl===ctl)genCtl=null;if(mine===genId&&epoch===epochAt){generating=false;renderChrome();}}
    }
    function download(file){
      if(!isFile(file))return;
      const url=urls.createObjectURL(file),a=doc.createElement('a');
      a.href=url;a.download=file.name||'download.pdf';(doc.body||ui.root).append(a);a.click();a.remove();
      timers.setTimeout(()=>urls.revokeObjectURL(url),1000);
    }
    function saveDraft(){
      const api=editsApi();
      if(!ui.draftOpt.checked){setDraftStatus('초안 보관은 직접 켠 뒤에만 저장합니다.',true);return;}
      if(!api||typeof api.draft!=='function'||!session||!source||!source.fileHash){setDraftStatus('편집 코어가 없어 초안을 저장하지 않았습니다.',true);return;}
      const box=store();if(!box){setDraftStatus('이 브라우저 저장소를 쓸 수 없어 초안을 저장하지 않았습니다.',true);return;}
      let envelope;
      try{envelope=api.draft({snapshot:session.snapshot(),now:now()});}catch(e){setDraftStatus('초안을 만들지 못했습니다. '+safeMessage(e),true);return;}
      if(!envelope||draftUnsafe(envelope,0)){setDraftStatus('초안에 파일 바이트나 비밀로 보이는 값이 있어 저장하지 않았습니다.',true);return;}
      const raw=JSON.stringify(envelope);
      if(raw.length>200000){setDraftStatus('초안이 너무 커서 저장하지 않았습니다.',true);return;}
      try{box.setItem(draftKey(),raw);draftRaw=raw;setDraftStatus('12시간 뒤 만료되는 초안을 이 브라우저에 저장했습니다. 원본 PDF는 넣지 않았습니다.');}
      catch(e){setDraftStatus('초안을 저장하지 못했습니다. '+safeMessage(e),true);}
      renderChrome();
    }
    function restoreDraft(){
      const api=editsApi();
      if(!api||typeof api.restoreDraft!=='function'||!draftRaw||!source||!source.fileHash){setDraftStatus('편집 코어가 없어 초안을 복구하지 않았습니다.',true);return;}
      let envelope,restored;
      try{envelope=JSON.parse(draftRaw);}catch{setDraftStatus('초안을 읽지 못했습니다.',true);return;}
      try{restored=api.restoreDraft(envelope,{fileHash:source.fileHash,now:now()});}
      catch(e){setDraftStatus('초안을 복구하지 않았습니다. '+safeMessage(e),true);return;}
      if(!restored||!Array.isArray(restored.edits)){setDraftStatus('초안은 확인됐지만 편집 목록이 없어 복구하지 않았습니다.',true);return;}
      if(typeof unsub==='function')unsub();
      try{
        session=api.create({fileHash:source.fileHash,name:source.name,segments:source.segments,now:now()});
        unsub=typeof session.subscribe==='function'?session.subscribe(onSnapshot):null;
        onSnapshot(session.snapshot());
        for(const edit of restored.edits){
          if(!edit||typeof edit.before!=='string'||typeof edit.after!=='string'||!Number.isSafeInteger(edit.pageIndex)||!ORIGINS.has(edit.origin))throw new Error('초안 편집 형식이 맞지 않습니다.');
          const body={pageIndex:edit.pageIndex,before:edit.before,after:edit.after,anchor:edit.anchor,origin:edit.origin};
          if(typeof edit.segmentId==='string')body.segmentId=edit.segmentId;
          const id=session.add(body);
          if(edit.enabled===false&&id)session.setEnabled(id,false);
        }
        setDraftStatus('초안 편집을 이 세션에 다시 넣었습니다. 실행 취소 기록은 복구 이후부터입니다.');
      }catch(e){setDraftStatus('초안을 세션에 넣지 못했습니다. '+safeMessage(e),true);}
    }
    function deleteDraft(){
      const key=draftKey(),box=store();
      if(!key||!box){setDraftStatus('지울 초안이 없습니다.',true);return;}
      try{box.removeItem(key);}catch(e){setDraftStatus('초안을 지우지 못했습니다. '+safeMessage(e),true);return;}
      draftRaw=null;setDraftStatus('이 브라우저의 초안을 지웠습니다.');renderChrome();
    }
    function share(){
      if(!output||output.blocked)return;
      emit('falsify:paper-team-share',{sha256:output.sha256,revision:output.revision,verification:scrub(output.verification,0),name:output.file.name});
      setGenStatus('팀 공개 요청만 보냈습니다. 동의 화면 없이 업로드하지 않으며, 비공개 초안은 포함하지 않습니다.');
    }
    function handoff(){
      if(!output||output.blocked)return;
      const ev=new CustomEvent('falsify:blue-file',{cancelable:true,detail:{file:output.file}});
      if(!doc.dispatchEvent(ev)){setGenStatus('BLUE가 인계를 받지 않았습니다. 생성본은 그대로입니다.');return;}
      const nav=[...doc.querySelectorAll('[data-view="blue"]')].find(b=>b.getClientRects&&b.getClientRects().length)||doc.querySelector('[data-view="blue"]');
      if(nav&&typeof nav.click==='function')nav.click();
    }
    function onKey(e){
      if(e.key==='Escape'&&inline){e.preventDefault();inline=null;renderInline();ui.beforeStage.focus();return;}
      if(fieldTarget(e.target))return;
      if((e.ctrlKey||e.metaKey)&&(e.key==='z'||e.key==='Z')){
        e.preventDefault();
        if(!session)return;
        if(e.shiftKey){if(snapshot&&snapshot.canRedo)session.redo();}
        else if(snapshot&&snapshot.canUndo)session.undo();
        return;
      }
      if(e.key==='ArrowRight'&&page<pages){e.preventDefault();void drawBefore(page+1);}
      else if(e.key==='ArrowLeft'&&page>1){e.preventDefault();void drawBefore(page-1);}
      else if((e.key==='+'||e.key==='=')&&!ui.zoomIn.disabled)ui.zoomIn.click();
      else if(e.key==='-'&&!ui.zoomOut.disabled)ui.zoomOut.click();
    }
    function onFileChange(){
      const file=ui.file.files&&ui.file.files[0]||null;
      if(!file){clearSource();return;}
      if(source&&source.file===file)return;
      void openFile(file);
    }
    function onDocument(event){
      const detail=event.detail||{},file=detail.file||null;
      const segments=detail.result&&Array.isArray(detail.result.segments)?detail.result.segments:null;
      if(!segments)return;
      if(source&&file&&source.file&&file!==source.file)return;
      if(!source){
        if(!file)return;
        const pending=openFile(file);
        void Promise.resolve(pending).then(()=>{if(source&&source.file===file)adoptSegments(segments);});
        return;
      }
      adoptSegments(segments);
    }
    ui.file.addEventListener('change',onFileChange);
    doc.addEventListener('falsify:document',onDocument);
    doc.addEventListener('falsify:document-clear',clearSource);
    doc.addEventListener('falsify:workspace-reset',clearSource);
    ui.prev.addEventListener('click',()=>{if(page>1)void drawBefore(page-1);});
    ui.next.addEventListener('click',()=>{if(page<pages)void drawBefore(page+1);});
    ui.zoomIn.addEventListener('click',()=>{const i=ZOOMS.indexOf(zoom);if(i<0||i>=ZOOMS.length-1)return;zoom=ZOOMS[i+1];syncNav();if(source&&source.doc)void drawBefore(page);});
    ui.zoomOut.addEventListener('click',()=>{const i=ZOOMS.indexOf(zoom);if(i<=0)return;zoom=ZOOMS[i-1];syncNav();if(source&&source.doc)void drawBefore(page);});
    ui.original.addEventListener('click',()=>{if(source)download(source.file);});
    ui.current.addEventListener('click',()=>{if(output&&!output.blocked)download(output.file);});
    ui.generate.addEventListener('click',()=>{if(!ui.generate.disabled)void generate();});
    ui.team.addEventListener('click',share);
    ui.blue.addEventListener('click',handoff);
    ui.undo.addEventListener('click',()=>{if(session&&snapshot&&snapshot.canUndo)session.undo();});
    ui.redo.addEventListener('click',()=>{if(session&&snapshot&&snapshot.canRedo)session.redo();});
    ui.inlineApply.addEventListener('click',applyInline);
    ui.inlineCancel.addEventListener('click',()=>{inline=null;renderInline();ui.beforeStage.focus();});
    ui.draftOpt.addEventListener('change',renderChrome);
    ui.draftSave.addEventListener('click',saveDraft);
    ui.draftRestore.addEventListener('click',restoreDraft);
    ui.draftDelete.addEventListener('click',deleteDraft);
    ui.beforeStage.addEventListener('pointerup',captureSelection);
    ui.beforeStage.addEventListener('mouseup',captureSelection);
    ui.beforeStage.addEventListener('keyup',captureSelection);
    ui.root.addEventListener('keydown',onKey);
    ui.beforeStage.addEventListener('keydown',onKey);
    ui.inlineAfter.addEventListener('keydown',onKey);
    for(const [node,name] of [[ui.original,'download'],[ui.generate,'pencil'],[ui.team,'users'],[ui.blue,'arrow-right'],[ui.undo,'refresh-cw'],[ui.current,'download'],[ui.draftDelete,'x']])paintIcon(node,name);
    renderChrome();renderInline();renderEdits();
    if(ui.file.files&&ui.file.files[0])void openFile(ui.file.files[0]);
    return {
      acceptProposals,
      getSource(){if(!source||!source.file||!source.fileHash)return null;return {file:source.file,fileHash:source.fileHash,segments:source.segments.map(s=>Object.assign({},s))};},
      getEditSnapshot(){if(session&&typeof session.snapshot==='function')return session.snapshot();return snapshot?clone(snapshot):null;},
      getOutput(){if(!output)return null;return {file:output.file,sha256:output.sha256,verification:output.verification,revision:output.revision};}
    };
  }
  return {create,pageIndexFromLabel,classifyProposals,anchorFromSelection,clampScale,TTL};
});
