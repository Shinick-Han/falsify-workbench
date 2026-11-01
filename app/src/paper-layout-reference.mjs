import {hex} from './paragraph-pdf-crypto.mjs';
// Read the existing PDF reference with independent text and unit cursors.
// Keep every returned page below its share of the agent observation budget.
export async function readLayoutReference({bytes,sourcePdfHash,structure,loadPdf,baseUrl,pages=[],offset=0,textOffset,unitOffset,signal}){
 const check=()=>{if(signal?.aborted)throw new DOMException('취소했습니다.','AbortError');};
 check();if(!(bytes instanceof Uint8Array)||hex(bytes)!==sourcePdfHash)throw new Error('원본 PDF가 일치하지 않습니다.');
 const startText=textOffset??offset*1000,startUnit=unitOffset??offset*20;
 if(![offset,startText,startUnit].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('원본 조회 위치를 확인하세요.');
 const lib=await loadPdf();check();const task=lib.getDocument({data:bytes.slice(),cMapUrl:new URL('vendor/cmaps/',baseUrl).href,cMapPacked:true,standardFontDataUrl:new URL('vendor/standard_fonts/',baseUrl).href,wasmUrl:new URL('vendor/wasm/',baseUrl).href});
 try{
  const pdf=await task.promise;check();const selected=pages.length?pages:[0];
  if(selected.length>4||new Set(selected).size!==selected.length||selected.some(p=>!Number.isSafeInteger(p)||p<0||p>=pdf.numPages))throw new Error('요청한 원본 페이지가 없습니다.');
  const result=[],budget=Math.floor(9000/selected.length);
  for(const pageIndex of selected){
   const page=await pdf.getPage(pageIndex+1),content=await page.getTextContent();check();
   const text=content.items.map(i=>i.str||'').join(' '),viewport=page.getViewport({scale:1}),units=structure?.units.filter(u=>u.pageIndex===pageIndex)||[];
   let textCount=Math.min(1000,Math.max(0,text.length-startText)),unitCount=Math.min(20,Math.max(0,units.length-startUnit)),entry;
   const make=()=>({pageIndex,width:viewport.width,height:viewport.height,text:text.slice(startText,startText+textCount),textOffset:startText,textTruncated:startText+textCount<text.length,...(structure?{units:units.slice(startUnit,startUnit+unitCount).map(({id,bbox,kind,role,span})=>{const group=structure.groups?.find(g=>g.includes(id));return {id,bbox,kind,role,span,sourceOrderIndex:structure.plan?.order?.indexOf(id)??-1,sourceFrontMatter:structure.plan?.frontMatter?.includes(id)??false,sourcePlacement:structure.plan?.furniture?.find(f=>f.id===id)?.placement??null,group:group?.slice(0,4)??null,groupSize:group?.length??0,groupTruncated:(group?.length??0)>4,planScope:'initial-source-proposal'};}),unitOffset:startUnit,unitsTruncated:startUnit+unitCount<units.length}:{}),next:startText+textCount<text.length||startUnit+unitCount<units.length?{pages:[pageIndex],textOffset:startText+textCount,unitOffset:startUnit+unitCount}:null});
   entry=make();while(JSON.stringify(entry).length>budget&&(unitCount>1||textCount>1)){if(unitCount>1)unitCount=Math.max(1,Math.floor(unitCount/2));else textCount=Math.max(1,Math.floor(textCount/2));entry=make();}
   if(JSON.stringify(entry).length>budget)throw Object.assign(new Error('원본 영역 정보가 너무 큽니다.'),{code:'request_limit'});
   result.push(entry);
  }
  return {sourcePdfHash,totalPages:pdf.numPages,pages:result};
 }finally{await task.destroy();}
}
