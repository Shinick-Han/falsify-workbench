// Reuse the document-flow glyph provenance and raw annotation adapter for
// ordinary page edits. Unsupported mappings remain explicit failures.
import {createHash} from 'node:crypto';
import {deriveNativeLinkMoves, readLinkPageCharacters} from './paragraph-vendor/document-flow-links.mjs';
import {expectedPageText, readGlyphs} from './paragraph-vendor/quality.mjs';
import {canonicalPage} from './paragraph-geometry-conservation.mjs';

const intersects=(a,b)=>Math.min(a.r,b.r)-Math.max(a.l,b.l)>1e-4&&Math.min(a.t,b.t)-Math.max(a.b,b.b)>1e-4;
const sameBox=(a,b)=>['l','r','b','t'].every(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])&&Math.abs(a[k]-b[k])<=.05);

// Prove identity locally before attempting page-wide reading order. The edit
// spans bind source characters, including unchanged-looking replacement text.
function stationaryLinks(links, source, target, edits) {
  let text='', indices=[];
  for(const c of source.chars) {
    const ch=String.fromCharCode(c.u);
    if(/\s/u.test(ch)) { if(text && !text.endsWith(' ')){text+=' ';indices.push(null);} }
    else {text+=ch;indices.push(c.index);}
  }
  if(text.endsWith(' ')){text=text.slice(0,-1);indices.pop();}
  const expected=expectedPageText(text,edits,{includeSpans:true});
  if(!expected.ok)return new Set();
  const edited=new Set(expected.spans.flatMap(s=>indices.slice(s.a,s.b).filter(i=>i!==null)));
  const proved=new Set();
  for(const link of links) {
    if(!Array.isArray(link.rect)||link.rect.length!==4||!link.rect.every(Number.isFinite))continue;
    const [x1,y1,x2,y2]=link.rect,rect={l:Math.min(x1,x2),r:Math.max(x1,x2),b:Math.min(y1,y2),t:Math.max(y1,y2)};
    const owned=source.chars.filter(c=>c.box&&intersects(c.box,rect));
    if(!owned.length||owned.some(c=>edited.has(c.index)))continue;
    const outputOwned=target.chars.filter(c=>c.box&&intersects(c.box,rect));
    if(outputOwned.length!==owned.length)continue;
    const used=new Set();let ok=true;
    for(const c of owned) {
      const matches=outputOwned.filter(t=>t.u===c.u&&sameBox(c.box,t.box)&&
        (!c.style||!t.style||JSON.stringify(c.style)===JSON.stringify(t.style)));
      if(matches.length!==1||used.has(matches[0].index)){ok=false;break;}
      used.add(matches[0].index);
    }
    if(ok)proved.add(link.annotationIndex);
  }
  return proved;
}

export async function transportParagraphLinks({engineFactory, sourceBytes, outputBytes, edits, sourcePageMap, flowGroups=[], annotationAdapter}) {
  const failures=[], moves=[];
  const skipped=new Set(flowGroups.flatMap(g=>(g.sourcePages||[]).map(p=>p.sourcePageIndex)));
  const pages=[...new Set(edits.map(e=>e.pageIndex))].filter(p=>!skipped.has(p));
  let src,out,model;
  try {
    src=await engineFactory(sourceBytes); out=await engineFactory(outputBytes);
    for(const pageIndex of pages){
      src.loadPage(pageIndex);
      const count=src.M._FPDFPage_GetAnnotCount?.(src.page);
      if(!Number.isInteger(count)||count<0){failures.push({code:'paragraph_link_inventory_unverified',pageIndex});continue;}
      if(!count)continue;
      if(!annotationAdapter){failures.push({code:'paragraph_link_adapter_unavailable',pageIndex});continue;}
      try {
        model ||= await annotationAdapter.inspect({sourceBytes,sourceSha256:createHash('sha256').update(sourceBytes).digest('hex')});
        const links=model.annotations.filter(a=>a.sourcePageIndex===pageIndex&&a.kind==='link');
        if(!links.length)continue;
        const map=sourcePageMap.find(m=>m.sourcePageIndex===pageIndex);
        if(!map||map.continuationPageIndices?.length)throw Object.assign(new Error(),{code:'paragraph_link_continuation_unverified'});
        const pageEdits=edits.filter(e=>e.pageIndex===pageIndex);
        const sourceRaw=readLinkPageCharacters(src,pageIndex),targetRaw=readLinkPageCharacters(out,map.outputPageIndex);
        const sourceGeometry=readGlyphs(src,pageIndex),targetGeometry=readGlyphs(out,map.outputPageIndex);
        const withStyle=(chars,geometry)=>{const styles=new Map(geometry.glyphs.map(g=>[g.i,g.style]));return chars.map(c=>({...c,style:styles.get(c.index)}));};
        const ownership=new Map();
        for(const link of links)if(Array.isArray(link.rect)&&link.rect.length===4&&link.rect.every(Number.isFinite)){
          const [x1,y1,x2,y2]=link.rect,rect={l:Math.min(x1,x2),r:Math.max(x1,x2),b:Math.min(y1,y2),t:Math.max(y1,y2)};
          for(const c of sourceRaw.filter(c=>c.box&&intersects(c.box,rect))){
            const owners=ownership.get(c.index)||[];owners.push(link.annotationIndex);ownership.set(c.index,owners);
          }
        }
        const overlapping=new Set([...ownership.values()].filter(a=>a.length>1).flat());
        for(const link of links.filter(a=>overlapping.has(a.annotationIndex)))failures.push({code:'paragraph_link_unverified',pageIndex,annotationIndex:link.annotationIndex,reason:'document_flow_link_overlapping_ownership'});
        const candidates=links.filter(a=>!overlapping.has(a.annotationIndex));
        const stationary=stationaryLinks(candidates,{chars:withStyle(sourceRaw,sourceGeometry)},{chars:withStyle(targetRaw,targetGeometry)},pageEdits);
        const remaining=candidates.filter(a=>!stationary.has(a.annotationIndex));
        if(!remaining.length)continue;
        const band={sourcePageIndex:pageIndex,floor:-100000,bodyTop:100000};
        let sourcePage,outputPage,expected,targets,globalError;
        const ordered=(canonical,raw)=>canonical.chars.map(c=>{
          if(c.virtual)return {u:c.u,index:null,box:null};
          const native=raw[c.i];
          if(!native||native.index!==c.i||native.u!==c.u||(c.u>32&&!native.box))throw Object.assign(new Error(),{code:'document_flow_link_text_mapping_mismatch'});
          return native;
        });
        try {
          sourcePage=canonicalPage(sourceGeometry);
          outputPage=canonicalPage(targetGeometry,sourcePage.partition);
          if(!sourcePage.ok||!outputPage.ok)throw Object.assign(new Error(),{code:'document_flow_link_text_mapping_mismatch'});
          expected=expectedPageText(sourcePage.text,pageEdits,{includeSpans:true});
          if(!expected.ok)throw Object.assign(new Error(),{code:'document_flow_link_edit_mapping_ambiguous'});
          if(expected.text!==outputPage.text.replace(/\s+/gu,' ').trim())throw Object.assign(new Error(),{code:'document_flow_link_text_mapping_mismatch'});
          targets=ordered(outputPage,targetRaw).filter(c=>c.u>32);
        } catch(error) { globalError=error; }
        for(const link of remaining){
          try {
            if(globalError)throw globalError;
            const linkModel={...model,annotations:[link]};
            const pageMoves=deriveNativeLinkMoves(src,[band],targets.map(c=>({...c,outputPageIndex:map.outputPageIndex})),edits,linkModel,expectedPageText,new Set(),(_band,raw)=>ordered(sourcePage,raw));
            moves.push(...pageMoves);
          } catch(error) {failures.push({code:'paragraph_link_unverified',pageIndex,annotationIndex:link.annotationIndex,reason:error?.code||'paragraph_link_mapping_failed'});}
        }
      } catch(error) {
        const links=model?.annotations?.filter(a=>a.sourcePageIndex===pageIndex&&a.kind==='link')||[];
        if(links.length)for(const a of links)failures.push({code:'paragraph_link_unverified',pageIndex,annotationIndex:a.annotationIndex,reason:error?.code||'paragraph_link_mapping_failed'});
        else failures.push({code:'paragraph_link_inventory_unverified',pageIndex,reason:error?.code||'annotation_inspection_failed'});
      }
    }
    if(model){
      try {
        const request={model,sourceBytes,outputBytes,sourcePageMap,moves,preserveUnmovedUnsupported:true,reflowedSourcePages:[...new Set(moves.map(m=>m.sourcePageIndex))]};
        const pdf=moves.length?new Uint8Array((await annotationAdapter.transport(request)).pdf):outputBytes;
        const verified=await annotationAdapter.validate({...request,outputBytes:pdf});
        if(!verified?.ok)throw Object.assign(new Error(),{code:verified?.code||'annotation_validation_failed'});
        return {pdf,moves,failures};
      } catch(error) {
        const affected=moves.length?moves:model.annotations.filter(a=>a.kind==='link'&&pages.includes(a.sourcePageIndex));
        for(const move of affected)failures.push({code:'paragraph_link_unverified',pageIndex:move.sourcePageIndex,annotationIndex:move.annotationIndex,reason:error?.code||'annotation_transport_failed'});
      }
    }
    return {pdf:outputBytes,moves:[],failures};
  } catch(error) {
    return {pdf:outputBytes,moves:[],failures:[...failures,...pages.map(pageIndex=>({code:'paragraph_link_inventory_unverified',pageIndex,reason:error?.code||'paragraph_link_check_failed'}))]};
  } finally {try{src?.close();}finally{out?.close();}}
}
