import * as mupdf from 'mupdf';
import {hex} from './paragraph-pdf-crypto.mjs';
import {readDocument} from './paper-document.mjs';
import {readSourceAssets} from './paper-source-assets.mjs';
import {readSourceLinks} from './paper-source-links.mjs';
import {buildPaperFlow} from './paper-flow.mjs';

const HASH=/^[a-f0-9]{64}$/;
const LIMIT={bytes:25*1024*1024,pages:100,dimension:14400,characters:200000,blocks:8000,assets:1000,drawings:50000};
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const abort=signal=>{if(signal?.aborted){const e=new Error('aborted');e.name='AbortError';e.code='aborted';throw e;}};
const box=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]<=b[2]&&b[1]<=b[3];
const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>Number.isFinite(v)&&Math.abs(v-b[i])<.01);
const stable=(hash,kind,value)=>`${kind}-${hex(new TextEncoder().encode(JSON.stringify([hash,kind,value]))).slice(0,24)}`;

function validateDocument(document){
  if(document?.schema!=='falsify.paper-document.v1'||!HASH.test(document.sourceSha256)||!Array.isArray(document.pages)||!Array.isArray(document.blocks)||!Array.isArray(document.assets))fail('invalid-evidence');
  if(!document.pages.length||document.pages.length>LIMIT.pages||document.blocks.length>LIMIT.blocks||document.assets.length>LIMIT.assets)fail('budget-exceeded');
  let chars=0;
  for(const [i,p] of document.pages.entries()){
    const g=p?.geometry,t=g?.pageTransform;
    if(p?.sourcePageIndex!==i||!Number.isFinite(p.width)||!Number.isFinite(p.height)||p.width<=0||p.height<=0||p.width>LIMIT.dimension||p.height>LIMIT.dimension||g?.frame!=='mupdf-display'||!same(g.bounds,[0,0,p.width,p.height])||!Array.isArray(t)||t.length!==6||!t.every(Number.isFinite)||Math.abs(t[0]*t[3]-t[1]*t[2])<1e-9||typeof p.text!=='string')fail('invalid-page-frame');
    chars+=p.text.length;
  }
  if(chars>LIMIT.characters)fail('budget-exceeded');
  const ids=new Set();
  for(const b of document.blocks){if(!b?.id||ids.has(b.id))fail('ambiguous-provenance');ids.add(b.id);const s=b.source,p=document.pages[s?.pageIndex];if(!p||!box(s.bbox))fail('invalid-evidence');if(b.text){const r=s.range;if(!r||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end>p.text.length||r.start>=r.end||p.text.slice(r.start,r.end)!==b.text)fail('invalid-evidence');}}
}

/** Offline source observations. Input and all reader inputs are owned copies. */
export async function extractReconstructionEvidence({bytes,sourceSha256,signal}={}){
  abort(signal);if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>LIMIT.bytes)fail('invalid-source');
  if(!HASH.test(sourceSha256||''))fail('invalid-source-hash');
  const snapshot=Uint8Array.from(bytes);if(hex(snapshot)!==sourceSha256)fail('stale-source');
  let pdf;
  try{pdf=mupdf.Document.openDocument(snapshot.slice(),'application/pdf').asPDF();if(!pdf||pdf.needsPassword())fail('unsupported-source');const count=pdf.countPages();if(!count||count>LIMIT.pages)fail('budget-exceeded');for(let i=0;i<count;i++){abort(signal);const page=pdf.loadPage(i);try{const b=page.getBounds();if(!box(b)||b[0]!==0||b[1]!==0||b[2]<=0||b[3]<=0||b[2]>LIMIT.dimension||b[3]>LIMIT.dimension)fail('invalid-page-frame');}finally{page.destroy();}}}catch(e){if(e.code||e.name==='AbortError')throw e;fail('unsupported-source');}finally{pdf?.destroy();}
  let document,assets,links;
  try{
    document=await readDocument({file:snapshot.slice(),fileHash:sourceSha256,signal});validateDocument(document);abort(signal);
    assets=await readSourceAssets({bytes:snapshot.slice(),document,signal});if(assets.drawings.length>LIMIT.drawings)fail('budget-exceeded');abort(signal);
    links=await readSourceLinks({bytes:snapshot.slice(),document,signal});abort(signal);
  }catch(e){if(e.code||e.name==='AbortError')throw e;fail('evidence-unavailable');}
  if(links.frames.some(f=>!f.verified))fail('invalid-page-frame');
  const flow=buildPaperFlow(document,{drawings:assets.drawings,links});abort(signal);
  return {document,flow,links,assets,diagnostics:[...document.diagnostics,...assets.diagnostics,...flow.diagnostics].map(d=>({code:d.code,severity:'warning',...(Number.isInteger(d.pageIndex)?{pageIndex:d.pageIndex}:{})}))};
}

/** Map reader observations and flow proposals without asserting recovered semantics. */
export function buildReconstructionModel({document,flow,links,assets}={}){
  validateDocument(document);const hash=document.sourceSha256;
  if(flow?.schema!=='falsify.paper-flow.v1'||flow.sourceSha256!==hash||links?.schema!=='falsify.paper-source-links.v1'||links.sourceSha256!==hash||assets?.sourceSha256!==hash||!Array.isArray(flow.items)||!Array.isArray(flow.fragments)||!Array.isArray(flow.regions)||!Array.isArray(assets.assets)||!Array.isArray(links.frames)||!Array.isArray(links.links)||links.frames.length!==document.pages.length)fail('stale-evidence');
  if(flow.items.length>LIMIT.blocks+LIMIT.assets||flow.fragments.length>LIMIT.blocks*4||flow.regions.length>LIMIT.assets)fail('budget-exceeded');
  for(const [i,f] of links.frames.entries()){const p=document.pages[i];if(f.pageIndex!==i||!f.verified||!same(f.bounds,p.geometry.bounds)||!same(f.pageTransform,p.geometry.pageTransform))fail('invalid-page-frame');}
  const pages=document.pages.map(p=>({pageIndex:p.sourcePageIndex,width:p.width,height:p.height,frame:'mupdf-display',transform:[...p.geometry.pageTransform]}));
  const refs=(s,extra={})=>({sourceSha256:hash,pageIndex:s.pageIndex,frame:'mupdf-display',bbox:[...s.bbox],...extra});
  const styles=new Map((document.styles||[]).map(x=>[x.id,x]));
  const blocks=new Map(document.blocks.map(b=>[b.id,b]));
  for(const b of flow.fragments){if(!b.id||blocks.has(b.id)||!blocks.has(b.parentBlockId))fail('ambiguous-provenance');const parent=blocks.get(b.parentBlockId),s=b.source,r=s?.range,p=document.pages[s?.pageIndex];if(!p||parent.source?.pageIndex!==s.pageIndex||!box(s.bbox)||!r||!parent.source?.range||r.start<parent.source.range.start||r.end>parent.source.range.end||r.start>=r.end||p.text.slice(r.start,r.end)!==b.text||JSON.stringify(s.characters)!==JSON.stringify((parent.source.characters||[]).filter(c=>c.start>=r.start&&c.end<=r.end)))fail('invalid-evidence');blocks.set(b.id,b);}
  const sourceAssets=new Map(document.assets.map(a=>[a.id,a])), regions=new Map(flow.regions.map(r=>[r.id,r]));
  const outAssets=[];
  const assetIds=new Set();for(const a of assets.assets){const orig=sourceAssets.get(a.id);if(!orig||assetIds.has(a.id)||orig.source?.pageIndex!==a.source?.pageIndex||orig.source?.occurrence!==a.source?.occurrence||!same(orig.source?.bbox,a.source?.bbox))fail('ambiguous-provenance');assetIds.add(a.id);const content=a.content;if(content?.representation==='mupdf-decoded-png'&&content.bytes instanceof Uint8Array&&content.bytes.length){if(!(orig.content?.bytes instanceof Uint8Array)||hex(orig.content.bytes)!==hex(content.bytes))fail('stale-evidence');const bytes=content.bytes.slice();outAssets.push({id:a.id,evidence:[refs(a.source,{occurrence:a.source.occurrence})],representation:'image',bytes,mediaType:'image/png',sha256:hex(bytes),editable:false,reason:'decoded-image-compositing-unverified'});}}
  if(assetIds.size!==sourceAssets.size)fail('uncovered-source-asset');
  const owned=new Set(),ownedAssets=new Set(),flowIds=new Map(),items=[],diagnostics=[...document.diagnostics,...flow.diagnostics,...(assets.diagnostics||[])].map(d=>({code:d.code,severity:'warning',...(Number.isInteger(d.pageIndex)?{pageIndex:d.pageIndex}:{})}));
  for(const [order,f] of flow.items.entries()){
    if(!f?.id||flowIds.has(f.id)||!Array.isArray(f.blockIds)||!Array.isArray(f.assetIds)||!document.pages[f.source?.pageIndex]||!box(f.source?.bbox))fail('invalid-evidence');
    const region=f.renderAssetId?regions.get(f.renderAssetId):null;if(f.renderAssetId&&(!region||region.pageIndex!==f.source.pageIndex||!same(region.bbox,f.source.bbox)||!Array.isArray(region.blockIds)||!Array.isArray(region.assetIds)||region.blockIds.length!==f.blockIds.length||region.assetIds.length!==f.assetIds.length||region.blockIds.some(id=>!f.blockIds.includes(id))||region.assetIds.some(id=>!f.assetIds.includes(id))))fail('invalid-evidence');
    const segments=[],evidence=[];
    for(const id of f.blockIds){const b=blocks.get(id);if(!b||owned.has(id)||b.source.pageIndex!==f.source.pageIndex)fail('ambiguous-provenance');owned.add(id);if(b.text){const r=b.source.range,p=document.pages[b.source.pageIndex];if(!r||p.text.slice(r.start,r.end)!==b.text)fail('invalid-evidence');const ref=refs(b.source,{blockId:b.parentBlockId||b.id,range:{...r}});evidence.push(ref);segments.push({text:b.text,evidence:ref,styleIds:[...new Set((b.source.characters||[]).map(c=>c.styleId).filter(Boolean))]});}}
    for(const id of f.assetIds){const a=sourceAssets.get(id);if(!a||ownedAssets.has(id)||a.source.pageIndex!==f.source.pageIndex||!box(a.source.bbox))fail('ambiguous-provenance');ownedAssets.add(id);evidence.push(refs(a.source,{occurrence:a.source.occurrence}));}
    if(f.kind==='asset')evidence.unshift(refs(f.source));
    if(!evidence.length)fail('invalid-evidence');
    const text=segments.map(s=>s.text).join(''),fontSizes=segments.flatMap(s=>s.styleIds.map(id=>styles.get(id)?.size).filter(Number.isFinite));
    const regionKind=region?.classification||null,kind=f.kind==='asset'?(region&&!['compound-figure','verified-occlusion'].includes(regionKind)?'unknown':'figure'):f.kind==='heading'?'heading':['header','footer'].includes(f.kind)?'furniture':'paragraph';
    const candidates=[];
    for(const id of f.blockIds){const b=blocks.get(id);if(!b?.text)continue;const cs=b.source.characters||[],sizes=cs.map(c=>styles.get(c.styleId)?.size).filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b),median=sizes[Math.floor(sizes.length/2)];if(median)for(const c of cs){const size=styles.get(c.styleId)?.size;if(box(c.bbox)&&size>0&&size<median*.8&&c.start>=b.source.range.start&&c.end<=b.source.range.end)candidates.push({kind:'script',evidence:[refs({pageIndex:b.source.pageIndex,bbox:c.bbox},{blockId:b.parentBlockId||b.id,range:{start:c.start,end:c.end}})]});}}
    // Separate, smaller inline runs may be reported by MuPDF as distinct blocks.
    if(segments.length>1&&fontSizes.length>1&&Math.min(...fontSizes)<Math.max(...fontSizes)*.8)candidates.push({kind:'script',evidence:segments.flatMap(s=>s.styleIds.some(id=>styles.get(id)?.size<Math.max(...fontSizes)*.8)?[s.evidence]:[])});
    for(const segment of segments){if(/\[\d+(?:\s*[,–-]\s*\d+)*\]/u.test(segment.text))candidates.push({kind:'citation',evidence:[segment.evidence]});if(/[=∑∫√≤≥±×÷]/u.test(segment.text))candidates.push({kind:'math',evidence:[segment.evidence]});}
    if(segments.length&&f.source.bbox[1]>document.pages[f.source.pageIndex].height*.8&&/^\s*\d+\s*\S/u.test(text))candidates.push({kind:'footnote',evidence:segments.map(s=>s.evidence)});
    const id=stable(hash,'item',[f.source.pageIndex,kind,evidence]);flowIds.set(f.id,id);
    const reason=f.kind==='asset'?'region-unverified':candidates.some(c=>c.kind==='script')?'inline-script-candidate':candidates.length?'semantic-candidate':f.columns>1?'column-order-unverified':f.kind==='caption'?'caption-proposal':f.blockIds.some(id=>(blocks.get(id)?.source?.lines?.length||0)>1)?'line-boundary-unverified':f.inline&&f.joiners?.some(Boolean)?'flow-joiner-unverified':undefined;
    items.push({id,kind,evidence,status:f.kind==='asset'?'unsupported':reason||kind!=='paragraph'?'proposed':'observed',...(text?{text}:{}),order,...(f.assetIds.length===1&&outAssets.some(a=>a.id===f.assetIds[0])?{assetId:f.assetIds[0]}:{}),...(reason?{reason}:{}),extensions:{flowId:f.id,blockIds:[...f.blockIds],assetIds:[...f.assetIds],regionId:region?.id||null,regionClassification:regionKind,columns:f.columns||1,span:f.span||'page',segments,candidates,styles:[...new Set(segments.flatMap(s=>s.styleIds))].map(id=>styles.get(id)).filter(Boolean).map(s=>({...s})),lineCount:f.blockIds.reduce((n,id)=>n+(blocks.get(id)?.source?.lines?.length||0),0)}});
    if(reason)diagnostics.push({code:reason,severity:'warning',pageIndex:f.source.pageIndex,itemId:id});
  }
  // A source occurrence may not be consumed by multiple flow fragments/items.
  const byPage=new Map(),byBlock=new Map();
  for(const item of items)for(const e of item.evidence)if(e.range){
    const pageRanges=byPage.get(e.pageIndex)||[];pageRanges.push(e.range);byPage.set(e.pageIndex,pageRanges);
    const blockRanges=byBlock.get(e.blockId)||[];blockRanges.push(e.range);byBlock.set(e.blockId,blockRanges);
  }
  for(const ranges of byPage.values()){
    ranges.sort((a,b)=>a.start-b.start||a.end-b.end);
    for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end)fail('ambiguous-provenance');
  }
  for(const b of document.blocks)if(b.text){const r=b.source.range,covered=byBlock.get(b.id)||[];covered.sort((a,b)=>a.start-b.start||a.end-b.end);if(!covered.length||covered[0].start!==r.start||covered.at(-1).end!==r.end||covered.some((x,i)=>i&&covered[i-1].end!==x.start))fail('uncovered-source-text');}
  if(ownedAssets.size!==sourceAssets.size)fail('uncovered-source-asset');
  for(const link of links.links||[]){const s=link.source;if(!s?.frameVerified||s.frame!=='mupdf-display'||!document.pages[s.pageIndex]||!box(s.bbox))fail('invalid-evidence');const matching=items.filter(item=>item.evidence.some(e=>e.pageIndex===s.pageIndex&&e.range&&(link.relation?.ranges||[]).some(r=>r.blockId===e.blockId&&r.start<e.range.end&&e.range.start<r.end)));for(const item of matching){(item.extensions.links||=[]).push({id:link.id,evidence:refs(s,{occurrence:s.occurrence}),status:'unresolved'});if(item.status==='observed'){item.status='proposed';item.reason='link-unresolved';}diagnostics.push({code:'link-unresolved',severity:'warning',pageIndex:s.pageIndex,itemId:item.id});}if(!matching.length)diagnostics.push({code:'link-unresolved',severity:'warning',pageIndex:s.pageIndex});}
  const relations=[];for(const r of flow.relations||[]){if(r.kind==='caption'){const from=flowIds.get(r.assetItemId),to=flowIds.get(r.captionItemId);if(!from||!to)fail('invalid-evidence');relations.push({kind:'caption',from,to,status:'proposed',evidence:[...items.find(i=>i.id===from).evidence,...items.find(i=>i.id===to).evidence]});}}
  for(const p of document.pages){if(!p.text.length)diagnostics.push({code:'no-extracted-text',severity:'warning',pageIndex:p.sourcePageIndex});if(!same(p.geometry.pageTransform.slice(0,4),[1,0,0,-1]))diagnostics.push({code:'page-transform-review',severity:'warning',pageIndex:p.sourcePageIndex});}
  return {schema:'falsify.pdf-latex-reconstruction.v1',sourceSha256:hash,pages,items,relations,assets:outAssets,diagnostics};
}
