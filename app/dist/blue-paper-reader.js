/* Interactive BLUE PDF reader with side-by-side split view and quote jump-and-highlight.
   Reuses FalsifyPreview (PDF.js) and FalsifyChangeMarks normalization. Zero network calls. */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.FalsifyBlueReader=api;
})(typeof globalThis==='object'?globalThis:this,function(root){
  'use strict';

  const ZOOMS=Object.freeze([0.75,1,1.25,1.5,2]);

  function normalizeText(raw){
    const text=String(raw||'');
    const mapped=root.FalsifyChangeMarks?.mapped;
    if(typeof mapped==='function')return mapped(text);
    let value='';const starts=[],ends=[];
    for(let i=0;i<text.length;){
      const from=i;
      if(/\s/u.test(text[i])){while(i<text.length&&/\s/u.test(text[i]))i++;value+=' ';starts.push(from);ends.push(i);}
      else{value+=text[i];starts.push(i);ends.push(++i);}
    }
    return {value,starts,ends};
  }

  function parsePageHint(detail){
    if(!detail||typeof detail!=='object')return null;
    if(Number.isInteger(detail.pageIndex)&&detail.pageIndex>=0)return detail.pageIndex+1;
    if(Number.isInteger(detail.page)&&detail.page>=1)return detail.page;
    const label=String(detail.label||detail.locationLabel||'');
    const m=/(?:p\.?\s*|page\s*)(\d{1,4})\b|(\d{1,4})\s*쪽/i.exec(label);
    const num=m?Number(m[1]||m[2]):0;
    return num>=1?num:null;
  }

  function candidateQueries(quote){
    const clean=normalizeText(String(quote||'')).value.trim();
    if(!clean)return [];
    const out=[clean];
    const parts=clean.split(/\s*(?:\.{2,}|…|[;—])\s*/).map(s=>s.trim()).filter(s=>s.length>=16);
    for(const part of parts)if(!out.includes(part))out.push(part);
    if(clean.length>64)out.push(clean.slice(0,64).trim());
    return out;
  }

  function buildSpanIndex(items){
    let text='';const spans=[];
    const list=Array.isArray(items)?items:[];
    for(let i=0;i<list.length;i++){
      const str=typeof list[i]?.str==='string'?list[i].str:'';
      const start=text.length;
      text+=str;
      if(str)spans.push({i,start,end:text.length});
      text+=list[i]?.hasEOL?'\n':' ';
    }
    return {text,spans,hay:normalizeText(text)};
  }

  function findQuoteRange(index,quote){
    for(const needle of candidateQueries(quote)){
      const at=index.hay.value.toLowerCase().indexOf(needle.toLowerCase());
      if(at<0)continue;
      const start=index.hay.starts[at];
      const end=index.hay.ends[at+needle.length-1];
      const hits=index.spans.filter(s=>s.end>start&&s.start<end);
      if(hits.length)return {hits,start,end,matched:needle};
    }
    return null;
  }

  function isPdfLike(file){
    if(!file||typeof file.arrayBuffer!=='function')return false;
    return file.type==='application/pdf'||/\.pdf$/i.test(String(file.name||''));
  }

  function hasPdfHeader(bytes){
    return bytes.byteLength>=5&&bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46&&bytes[4]===0x2d;
  }

  function createDomHelper(doc){
    return function el(tag,cls,text){
      const node=doc.createElement(tag);
      if(cls)node.className=cls;
      if(text!==undefined)node.textContent=text;
      return node;
    };
  }

  function buildViewerDom(el,flow,viewHost){
    const aside=el('aside','blue-paper-viewer');
    aside.id='blue-paper-viewer';aside.hidden=true;
    aside.setAttribute?.('aria-label','BLUE 논문 원문 보기');
    const head=el('div','blue-reader-head');
    const titleBox=el('div','blue-reader-title-wrap');
    const badge=el('span','blue-reader-code','PDF');
    const title=el('h3','blue-reader-title','논문 원문 대조');
    titleBox.append(badge,title);
    const splitBtn=el('button','button secondary blue-split-toggle','1단 위아래 보기');
    splitBtn.id='blue-split-toggle';splitBtn.type='button';
    head.append(titleBox,splitBtn);

    const toolbar=el('div','blue-reader-toolbar');
    const makeBtn=(id,label,cls='button secondary')=>{const b=el('button',cls,label);b.id=id;b.type='button';return b;};
    const prevBtn=makeBtn('blue-page-prev','이전 쪽');prevBtn.disabled=true;
    const pageLabel=el('span','blue-reader-page','0 / 0쪽');pageLabel.id='blue-page-label';
    const nextBtn=makeBtn('blue-page-next','다음 쪽');nextBtn.disabled=true;
    const zoomOut=makeBtn('blue-zoom-out','축소');
    const zoomLabel=el('span','blue-reader-zoom','100%');zoomLabel.id='blue-zoom-label';
    const zoomIn=makeBtn('blue-zoom-in','확대');
    toolbar.append(prevBtn,pageLabel,nextBtn,zoomOut,zoomLabel,zoomIn);

    const highlightBar=el('div','blue-highlight-bar');
    highlightBar.id='blue-highlight-bar';highlightBar.hidden=true;
    const highlightText=el('span','blue-highlight-text','');highlightText.id='blue-highlight-text';
    const clearHighlightBtn=makeBtn('blue-highlight-clear','강조 지우기','text-button');
    highlightBar.append(highlightText,clearHighlightBtn);

    const stage=el('div','blue-reader-stage');stage.id='blue-reader-stage';
    const status=el('p','form-feedback blue-reader-status','');status.id='blue-reader-status';
    status.setAttribute?.('role','status');

    aside.append(head,toolbar,highlightBar,stage,status);
    if(typeof flow.before==='function')flow.before(aside);
    else viewHost.insertBefore?.(aside,flow);
    return {aside,title,splitBtn,prevBtn,pageLabel,nextBtn,zoomOut,zoomLabel,zoomIn,highlightBar,highlightText,clearHighlightBtn,stage,status};
  }

  function resolveBlueHosts(doc,suppliedView){
    const viewHost=suppliedView||doc.getElementById?.('view-blue')||doc.querySelector?.('#view-blue');
    const flow=doc.getElementById?.('document-blue')||viewHost?.querySelector?.('#document-blue');
    if(!viewHost||!flow)return null;
    const existing=doc.getElementById?.('blue-paper-viewer')||viewHost.querySelector?.('#blue-paper-viewer');
    return {viewHost,flow,existing};
  }

  function mount(doc,suppliedView){
    doc=doc||root.document;
    if(!doc)return null;
    const resolved=resolveBlueHosts(doc,suppliedView);
    if(!resolved)return null;
    if(resolved.existing?._readerApi)return resolved.existing._readerApi;
    const {viewHost,flow}=resolved;
    const el=createDomHelper(doc);
    const ui=buildViewerDom(el,flow,viewHost);

    const state={
      epoch:0,renderSeq:0,file:null,pdfDoc:null,loadingTask:null,
      page:1,pages:0,zoomIdx:1,split:true,activeQuote:'',pageTextCache:new Map()
    };
    const isLive=(epoch,seq)=>epoch===state.epoch&&seq===state.renderSeq;

    function syncSplitMode(){
      const active=!ui.aside.hidden&&state.split;
      if(viewHost.dataset)viewHost.dataset.blueLayout=active?'split':'stack';
      ui.splitBtn.textContent=state.split?'1단 위아래 보기':'원문과 나란히 보기';
      ui.splitBtn.setAttribute?.('aria-pressed',String(state.split));
    }

    function syncToolbar(){
      const ready=Boolean(state.pdfDoc&&state.pages>0);
      ui.prevBtn.disabled=!ready||state.page<=1;
      ui.nextBtn.disabled=!ready||state.page>=state.pages;
      ui.zoomOut.disabled=!ready||state.zoomIdx<=0;
      ui.zoomIn.disabled=!ready||state.zoomIdx>=ZOOMS.length-1;
      ui.pageLabel.textContent=ready?state.page+' / '+state.pages+'쪽':'0 / 0쪽';
      ui.zoomLabel.textContent=Math.round(ZOOMS[state.zoomIdx]*100)+'%';
    }

    function destroyDoc(){
      const old=state.loadingTask;
      state.loadingTask=null;state.pdfDoc=null;state.pages=0;state.pageTextCache.clear();
      if(typeof old?.destroy==='function')Promise.resolve().then(()=>old.destroy()).catch(()=>{});
    }

    function clear(){
      state.epoch++;state.renderSeq++;state.file=null;state.activeQuote='';
      destroyDoc();
      ui.stage.replaceChildren();
      ui.highlightBar.hidden=true;ui.highlightText.textContent='';ui.status.textContent='';
      ui.aside.hidden=true;
      syncSplitMode();syncToolbar();
    }

    function paintSpanHit(layer,baseBox,textNode,hit,rangeHit){
      const len=textNode.textContent.length;
      const from=Math.max(0,Math.min(len,rangeHit.start-hit.start));
      const to=Math.max(from,Math.min(len,rangeHit.end-hit.start));
      if(from>=to)return [];
      const r=doc.createRange();r.setStart(textNode,from);r.setEnd(textNode,to);
      const marks=[];
      for(const rect of r.getClientRects()){
        if(!(rect.width>0&&rect.height>0))continue;
        const mark=el('span','blue-quote-highlight');
        mark.style.left=(rect.left-baseBox.left)+'px';
        mark.style.top=(rect.top-baseBox.top)+'px';
        mark.style.width=rect.width+'px';
        mark.style.height=rect.height+'px';
        layer.append(mark);
        marks.push(mark);
      }
      return marks;
    }

    function paintQuoteRects(container,divs,rangeHit){
      if(!rangeHit||!doc.createRange)return 0;
      const layer=el('div','blue-highlight-layer');
      layer.setAttribute?.('aria-hidden','true');
      container.append(layer);
      const baseBox=container.getBoundingClientRect?.()||{left:0,top:0};
      const allMarks=[];
      for(const hit of rangeHit.hits){
        const textNode=divs?.[hit.i]?.firstChild;
        if(textNode?.nodeType===3)allMarks.push(...paintSpanHit(layer,baseBox,textNode,hit,rangeHit));
      }
      allMarks[0]?.scrollIntoView?.({block:'center',inline:'nearest'});
      return allMarks.length;
    }

    async function loadPageIndex(pageNum){
      if(state.pageTextCache.has(pageNum))return state.pageTextCache.get(pageNum);
      if(!state.pdfDoc)return null;
      const page=await state.pdfDoc.getPage(pageNum);
      const content=await page.getTextContent();
      const entry={content,indexed:buildSpanIndex(content.items)};
      state.pageTextCache.set(pageNum,entry);
      return entry;
    }

    function computePageScale(page){
      const baseWidth=Math.max(260,(ui.stage.clientWidth||520)-24);
      const fit=root.FalsifyPreview.fitScale(page.getViewport({scale:1}),baseWidth,root.devicePixelRatio||1);
      return Math.max(0.4,Math.min(3,(fit||1)*ZOOMS[state.zoomIdx]));
    }

    async function drawPageSurface(page,viewport){
      const frame=el('div','blue-page-surface paper-page');
      frame.style.width=Math.ceil(viewport.width)+'px';
      frame.style.height=Math.ceil(viewport.height)+'px';
      const canvas=el('canvas','blue-paper-canvas');
      canvas.width=Math.max(1,Math.ceil(viewport.width));
      canvas.height=Math.max(1,Math.ceil(viewport.height));
      const ctx=canvas.getContext?.('2d');
      if(ctx)await page.render({canvasContext:ctx,canvas,viewport}).promise;
      frame.append(canvas);
      return frame;
    }

    async function renderQuoteOverlay(pdfLib,pageNum,frame,viewport,scale,quote,epoch,seq){
      if(!quote||!pdfLib.TextLayer)return 0;
      const cached=await loadPageIndex(pageNum);
      if(!isLive(epoch,seq))return 0;
      const hit=cached?findQuoteRange(cached.indexed,quote):null;
      if(!hit)return 0;
      const textWrap=el('div','paper-text-layer textLayer');
      frame.style.setProperty?.('--total-scale-factor',String(scale));
      frame.append(textWrap);
      const tl=new pdfLib.TextLayer({textContentSource:cached.content,container:textWrap,viewport});
      await tl.render();
      if(!isLive(epoch,seq))return 0;
      const count=paintQuoteRects(frame,tl.textDivs,hit);
      textWrap.remove?.();
      return count;
    }

    function updateRenderStatus(pageNum,quote,highlighted,located){
      const prefix=state.file?.name?state.file.name+' · ':'';
      ui.status.textContent=prefix+pageNum+' / '+state.pages+'쪽';
      if(!quote&&!located)return;
      ui.highlightBar.hidden=false;
      if(!quote){ui.highlightText.textContent=pageNum+'쪽으로 이동했습니다.';return;}
      ui.highlightText.textContent=highlighted>0
        ?pageNum+'쪽에서 인용 구간을 강조했습니다.'
        :pageNum+'쪽으로 이동했습니다 (정확한 문자열 일치 없음).';
    }

    async function renderPage(pageNum,quoteToHighlight,located=false){
      if(!state.pdfDoc||pageNum<1||pageNum>state.pages)return false;
      const seq=++state.renderSeq,epoch=state.epoch;
      state.page=pageNum;syncToolbar();
      ui.status.textContent=pageNum+'쪽을 그리는 중…';
      try{
        const pdfLib=await root.FalsifyPreview.defaultImport();
        const page=await state.pdfDoc.getPage(pageNum);
        if(!isLive(epoch,seq))return false;
        const scale=computePageScale(page),viewport=page.getViewport({scale});
        const frame=await drawPageSurface(page,viewport);
        if(!isLive(epoch,seq))return false;
        ui.stage.replaceChildren(frame);
        const highlighted=await renderQuoteOverlay(pdfLib,pageNum,frame,viewport,scale,quoteToHighlight,epoch,seq);
        if(!isLive(epoch,seq))return false;
        updateRenderStatus(pageNum,quoteToHighlight,highlighted,located);
        return highlighted>0;
      }catch{
        if(isLive(epoch,seq))ui.status.textContent=pageNum+'쪽 미리보기를 그리지 못했습니다.';
        return false;
      }
    }

    function configureWorker(pdfLib){
      if(pdfLib.GlobalWorkerOptions&&doc.baseURI){
        pdfLib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',doc.baseURI).href;
      }
    }

    async function loadPdfDocument(preview,bytes,epoch){
      const pdfLib=await preview.defaultImport();
      if(epoch!==state.epoch)return null;
      configureWorker(pdfLib);
      const task=pdfLib.getDocument(preview.pdfParams(bytes,doc.baseURI||'http://127.0.0.1/'));
      state.loadingTask=task;
      const pdfDoc=await task.promise;
      if(epoch!==state.epoch){task.destroy?.().catch(()=>{});return null;}
      return pdfDoc;
    }

    async function openFile(file){
      const preview=root.FalsifyPreview;
      if(!isPdfLike(file)||!preview?.defaultImport){clear();return false;}
      if(state.file===file&&state.pdfDoc)return true;
      const epoch=++state.epoch;
      destroyDoc();
      state.file=file;state.activeQuote='';
      ui.aside.hidden=false;ui.title.textContent=file.name||'논문 원문 대조';
      syncSplitMode();syncToolbar();
      ui.status.textContent='PDF 원문을 여는 중…';
      try{
        const bytes=new Uint8Array(await file.arrayBuffer());
        if(epoch!==state.epoch)return false;
        if(!hasPdfHeader(bytes)){clear();return false;}
        const pdfDoc=await loadPdfDocument(preview,bytes,epoch);
        if(!pdfDoc)return false;
        state.pdfDoc=pdfDoc;state.pages=pdfDoc.numPages||1;state.page=1;
        syncToolbar();
        await renderPage(1,'');
        decorateBlueFindings();
        return true;
      }catch{
        if(epoch===state.epoch)ui.status.textContent='PDF 미리보기를 열지 못했습니다.';
        return false;
      }
    }

    async function pageContainsQuote(pageNum,quote){
      const entry=await loadPageIndex(pageNum);
      return Boolean(entry&&findQuoteRange(entry.indexed,quote));
    }

    async function searchAllPages(quote,skipPage){
      for(let p=1;p<=state.pages;p++){
        if(p!==skipPage&&await pageContainsQuote(p,quote))return p;
      }
      return null;
    }

    async function findPageForQuote(quote,hintPage){
      const validHint=hintPage&&hintPage>=1&&hintPage<=state.pages?hintPage:null;
      if(validHint&&(!quote||await pageContainsQuote(validHint,quote)))return validHint;
      if(quote){
        const found=await searchAllPages(quote,validHint);
        if(found)return found;
      }
      return validHint||state.page||1;
    }

    async function locate(detail){
      if(!detail||!state.pdfDoc)return false;
      state.split=true;syncSplitMode();
      const quote=String(detail.quote||detail.excerpt||detail.before||'').trim();
      state.activeQuote=quote;
      const targetPage=await findPageForQuote(quote,parsePageHint(detail));
      return renderPage(targetPage,quote,true);
    }

    function extractCardQuote(card){
      const bq=card.querySelector?.('blockquote, code, .blue-sensor-item-quote');
      if(bq?.textContent)return bq.textContent.replace(/^인용:\s*/,'').trim();
      for(const p of card.querySelectorAll?.('p')||[]){
        const txt=p.textContent||'';
        if(txt.startsWith('인용:'))return txt.slice(3).trim();
      }
      return '';
    }

    function decorateSingleCard(card){
      if(card.dataset?.blueLocateReady)return;
      const headText=card.querySelector?.('h4, .blue-sensor-item-head, label span')?.textContent||'';
      const quote=extractCardQuote(card);
      if(!quote&&!parsePageHint({label:headText}))return;
      if(card.dataset)card.dataset.blueLocateReady='true';
      const btn=el('button','button secondary blue-locate-btn','원문에서 보기');
      btn.type='button';
      btn.addEventListener('click',()=>{void locate({quote,label:headText});});
      card.append(btn);
    }

    function decorateCardList(selector){
      if(!state.pdfDoc)return;
      for(const card of doc.querySelectorAll?.(selector)||[])decorateSingleCard(card);
    }

    function decorateBlueFindings(){
      decorateCardList('#doc-blue-findings article, #doc-blue-findings section');
      decorateCardList('#external-blue article');
      decorateCardList('#blue-defect-sensor .blue-sensor-item');
    }

    function resolveBlueStateFile(ev){
      return ev?.detail?.file||root.FalsifyDocumentBlueExternal?.getPdfFile?.()||doc.getElementById?.('doc-blue-file')?.files?.[0]||null;
    }

    function wireControls(){
      ui.prevBtn.addEventListener('click',()=>{if(state.page>1)void renderPage(state.page-1,state.activeQuote);});
      ui.nextBtn.addEventListener('click',()=>{if(state.page<state.pages)void renderPage(state.page+1,state.activeQuote);});
      ui.zoomOut.addEventListener('click',()=>{if(state.zoomIdx>0){state.zoomIdx--;void renderPage(state.page,state.activeQuote);}});
      ui.zoomIn.addEventListener('click',()=>{if(state.zoomIdx<ZOOMS.length-1){state.zoomIdx++;void renderPage(state.page,state.activeQuote);}});
      ui.splitBtn.addEventListener('click',()=>{state.split=!state.split;syncSplitMode();if(state.pdfDoc)void renderPage(state.page,state.activeQuote);});
      ui.clearHighlightBtn.addEventListener('click',()=>{state.activeQuote='';ui.highlightBar.hidden=true;if(state.pdfDoc)void renderPage(state.page,'');});
    }

    function wireDocumentEvents(){
      doc.addEventListener?.('falsify:blue-file',ev=>{if(ev?.detail?.file)void openFile(ev.detail.file);});
      doc.addEventListener?.('falsify:blue-state',ev=>{
        const f=resolveBlueStateFile(ev);
        if(f)void openFile(f);else if(!ev?.detail?.name)clear();
      });
      doc.addEventListener?.('falsify:workspace-reset',clear);
      doc.addEventListener?.('falsify:blue-locate',ev=>{if(ev?.detail)void locate(ev.detail);});
      const hostedFile=doc.getElementById?.('hosted-ai-file');
      hostedFile?.addEventListener?.('change',()=>{
        if(doc.getElementById?.('hosted-ai-role')?.value==='blue'&&hostedFile.files?.[0])void openFile(hostedFile.files[0]);
      });
      if(typeof MutationObserver==='function'){
        for(const id of ['doc-blue-findings','external-blue','blue-defect-sensor']){
          const box=doc.getElementById?.(id);
          if(box)new MutationObserver(decorateBlueFindings).observe(box,{childList:true,subtree:true});
        }
      }
    }

    wireControls();
    wireDocumentEvents();

    const apiObj={mount,openFile,locate,clear,getState:()=>({hasPdf:Boolean(state.pdfDoc),page:state.page,pages:state.pages,split:state.split,activeQuote:state.activeQuote})};
    ui.aside._readerApi=apiObj;
    return apiObj;
  }

  let defaultInstance=null;
  function boot(){if(root.document)defaultInstance=mount(root.document);}
  if(root.document){
    if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',boot,{once:true});
    else boot();
  }

  return {
    mount,
    parsePageHint,
    candidateQueries,
    findQuoteRange,
    buildSpanIndex,
    locate:detail=>defaultInstance?.locate(detail)??Promise.resolve(false),
    openFile:file=>defaultInstance?.openFile(file)??Promise.resolve(false),
    getState:()=>defaultInstance?.getState()??null
  };
});
