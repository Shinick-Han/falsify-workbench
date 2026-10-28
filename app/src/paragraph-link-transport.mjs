// Reuse the document-flow glyph provenance and raw annotation adapter for
// ordinary page edits. Unsupported mappings remain explicit failures.
import {createHash} from 'node:crypto';
import {deriveNativeLinkMoves, readLinkPageCharacters} from './paragraph-vendor/document-flow-links.mjs';
import {expectedPageText} from './paragraph-vendor/quality.mjs';

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
        const band={sourcePageIndex:pageIndex,floor:-100000,bodyTop:100000};
        const targets=readLinkPageCharacters(out,map.outputPageIndex).filter(c=>c.u>32&&c.box).map(c=>({...c,outputPageIndex:map.outputPageIndex}));
        const pageMoves=deriveNativeLinkMoves(src,[band],targets,edits,model,expectedPageText);
        moves.push(...pageMoves);
      } catch(error) {
        const links=model?.annotations?.filter(a=>a.sourcePageIndex===pageIndex&&a.kind==='link')||[];
        if(links.length)for(const a of links)failures.push({code:'paragraph_link_unverified',pageIndex,annotationIndex:a.annotationIndex,reason:error?.code||'paragraph_link_mapping_failed'});
        else failures.push({code:'paragraph_link_inventory_unverified',pageIndex,reason:error?.code||'annotation_inspection_failed'});
      }
    }
    if(moves.length){
      try {
        const request={model,sourceBytes,outputBytes,sourcePageMap,moves,reflowedSourcePages:[...new Set(moves.map(m=>m.sourcePageIndex))]};
        const result=await annotationAdapter.transport(request);
        const pdf=new Uint8Array(result.pdf);
        const verified=await annotationAdapter.validate({...request,outputBytes:pdf});
        if(!verified?.ok)throw Object.assign(new Error(),{code:verified?.code||'annotation_validation_failed'});
        return {pdf,moves,failures};
      } catch(error) {
        for(const move of moves)failures.push({code:'paragraph_link_unverified',pageIndex:move.sourcePageIndex,annotationIndex:move.annotationIndex,reason:error?.code||'annotation_transport_failed'});
      }
    }
    return {pdf:outputBytes,moves:[],failures};
  } catch(error) {
    return {pdf:outputBytes,moves:[],failures:[...failures,...pages.map(pageIndex=>({code:'paragraph_link_inventory_unverified',pageIndex,reason:error?.code||'paragraph_link_check_failed'}))]};
  } finally {try{src?.close();}finally{out?.close();}}
}
