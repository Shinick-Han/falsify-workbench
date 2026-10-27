import {readDocument} from './paper-document.mjs';
import {recoverSourceSpaces} from './paper-source-spacing.mjs';
import {buildPaperFlow} from './paper-flow.mjs';
import {readSourceAssets} from './paper-source-assets.mjs';
import {createFontPlan} from './paper-fonts.mjs';
import {composeDocument} from './paper-compose.mjs';
import {checkRecomposition} from './paper-compose-check.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';

const abort = signal => { if (signal?.aborted) throw new DOMException('Recomposition cancelled', 'AbortError'); };
const fail = (code, message, details={}) => { const e=new Error(message); e.code=code; e.details=details; throw e; };
const box = b => Array.isArray(b) && b.length===4 && b.every(Number.isFinite) && b[0]<b[2] && b[1]<b[3];
const overlaps = (a,b) => a[0]<b[2] && b[0]<a[2] && a[1]<b[3] && b[1]<a[3];

// Keep one map entry per UTF-16 unit. Generated separators have no source.
function pageStreams(document, flow, visibleWrap=false) {
  const lookup=new Map([...document.blocks,...(flow.fragments||[])].map(b=>[b.id,b]));
  const streams=new Map();
  for(const item of flow.items) {
    if(item.kind==='asset') continue;
    const blocks=(item.blockIds||[]).map(id=>lookup.get(id)).filter(b=>b?.text);
    for(const [index,b] of blocks.entries()) {
      const p=b.source.pageIndex, s=streams.get(p)||{chars:[]}; streams.set(p,s);
      if(s.chars.length) {
        const sep=index && item.inline ? item.joiners[index-1] : ' ';
        for(const ch of sep) s.chars.push({ch,source:null});
      }
      const boundaries=new Set((b.source.lines||[]).slice(1).map(l=>l.range.start-b.source.range.start));
      const spaces=new Set(b.source.wordSpaceOffsets||[]);
      for(let i=0;i<b.text.length;i++) {
        if(boundaries.has(i) && i>0 && !/\s/u.test(b.text[i-1]) && !/\s/u.test(b.text[i]) && (visibleWrap || b.text[i-1]!=='-') && !(b.text[i-1]==='−' && /[0-9]/u.test(b.text[i]))) s.chars.push({ch:' ',source:null});
        const offset=b.source.range.start+i;
        const parent=lookup.get(b.parentBlockId||b.id), parentIndex=offset-(parent?.source?.range?.start??offset);
        if(spaces.has(offset) && parentIndex>0 && !/\s/u.test(parent.text[parentIndex-1]) && !/\s/u.test(b.text[i])) s.chars.push({ch:' ',source:null});
        const character=(b.source.characters||[]).find(c=>c.start<=offset && c.end>offset);
        s.chars.push({ch:b.text[i],source:{blockId:b.parentBlockId||b.id,start:offset,end:offset+1,bbox:character?.bbox||null,fragmentId:b.id}});
      }
    }
  }
  for(const s of streams.values()) {
    s.text=''; s.map=[];
    for(const entry of s.chars) {
      if(/\s/u.test(entry.ch)) {
        if(s.text.endsWith(' ')) {s.map.at(-1).push(entry.source); continue;}
        s.text+=' '; s.map.push([entry.source]);
      } else {s.text+=entry.ch; s.map.push([entry.source]);}
    }
  }
  return streams;
}
export function bindEdits(document, flow, edits) {
  const streams=pageStreams(document,flow), wrapped=pageStreams(document,flow,true), blocks=new Map(document.blocks.map(b=>[b.id,b]));
  const bindings=[], changes=[], used=new Map();
  for(const [index,e] of edits.entries()) {
    if(!Number.isInteger(e.pageIndex) || typeof e.before!=='string' || !e.before.trim() || typeof e.after!=='string') fail('invalid-edit','Edit requires pageIndex, Before and After.',{index,id:e.id});
    const needle=e.before.replace(/\s+/gu,' '), hits=[];
    const variants=/-[^\S\r\n]*[\r\n]/u.test(e.before)?[streams,wrapped]:[streams];
    for(const variant of variants) { const stream=variant.get(e.pageIndex);
    if(stream) for(let at=stream.text.indexOf(needle);at>=0;at=stream.text.indexOf(needle,at+1)) {
      if(/[0-9]/u.test(needle[0]) && /[-+−]/u.test(stream.text[at-1]||'')) continue;
      const refs=[];
      for(let pos=at;pos<at+needle.length;pos++) {
        refs.push(...stream.map[pos]);
      }
      const selected=refs.filter(Boolean);
      refs.splice(0,refs.length,...selected);
      if(!refs.length) continue;
      const segmentKnown=blocks.has(e.segmentId) || (flow.fragments||[]).some(f=>f.id===e.segmentId);
      if(segmentKnown && !refs.some(r=>r.blockId===e.segmentId || r.fragmentId===e.segmentId)) continue;
      const geometry=e.anchor?.bbox;
      if(box(geometry) && !refs.some(r=>box(r.bbox) && overlaps(geometry,r.bbox))) continue;
      if(!hits.some(hit=>JSON.stringify(hit.map(r=>[r.blockId,r.start,r.end]))===JSON.stringify(refs.map(r=>[r.blockId,r.start,r.end])))) hits.push(refs);
    }}
    if(hits.length!==1) fail('source-binding',hits.length?'Source quote is ambiguous.':'Source quote was not found.',{index,id:e.id,pageIndex:e.pageIndex,code:hits.length?'AMBIGUOUS_MATCH':'NO_MATCH',hits:hits.length});
    const parts=[];
    for(const r of hits[0]) {
      const last=parts.at(-1);
      if(last && last.blockId===r.blockId && last.end===r.start) last.end=r.end;
      else if(!last || last.blockId!==r.blockId || last.end!==r.end) parts.push({blockId:r.blockId,pageIndex:e.pageIndex,start:r.start,end:r.end});
    }
    for(const [i,p] of parts.entries()) {
      const b=blocks.get(p.blockId); if(!b || !b.source.range) fail('source-binding','Source block is unavailable.',{index,id:e.id});
      const before=b.text.slice(p.start-b.source.range.start,p.end-b.source.range.start);
      if(!before || before.length!==p.end-p.start) fail('source-binding','Source range is invalid.',{index,id:e.id});
      const prior=used.get(p.blockId)||[]; if(prior.some(x=>p.start<x.end && p.end>x.start)) fail('source-binding','Selected edits overlap.',{index,id:e.id,code:'OVERLAP'});
      prior.push(p); used.set(p.blockId,prior);
      p.before=before; changes.push({...p,after:i===0?e.after:''});
    }
    bindings.push({id:e.id||`edit-${index}`,pageIndex:e.pageIndex,segmentId:e.segmentId??null,before:e.before,after:e.after,request:structuredClone(e),sourceBefore:parts.map(p=>p.before).join(''),parts});
  }
  return {bindings,changes};
}

export async function prepare(request={}, options={}) {
  const signal=request.signal; abort(signal);
  const candidates=(options.fonts||[]).map(f=>({...f,bytes:f.bytes instanceof Uint8Array?Uint8Array.from(f.bytes):f.bytes instanceof ArrayBuffer?f.bytes.slice(0):f.bytes}));
  const snapshot=Array.isArray(request.edits)?{edits:request.edits}:request.edits;
  if(!snapshot || !Array.isArray(snapshot.edits) || (snapshot.schema && snapshot.schema!=='falsify.paper-edits.v1')) fail('invalid','Expected edit array or paper edit snapshot.');
  const edits=structuredClone(snapshot.edits).filter(e=>e?.enabled!==false), revision=snapshot.revision??request.revision??null;
  const hash=request.fileHash||snapshot.fileHash;
  if(request.fileHash && snapshot.fileHash && request.fileHash.toLowerCase()!==snapshot.fileHash.toLowerCase()) fail('stale-source','Request and snapshot hashes differ.');
  const input=request.file;
  const bytes=input instanceof Uint8Array?Uint8Array.from(input):input?.bytes instanceof Uint8Array?Uint8Array.from(input.bytes):typeof input?.arrayBuffer==='function'?new Uint8Array(await input.arrayBuffer()):null;
  abort(signal); if(!bytes?.length) fail('invalid','Source PDF is required.');
  const observed=await readDocument({file:bytes,fileHash:hash,signal}); abort(signal);
  const spacing=await recoverSourceSpaces({bytes,document:observed,pdfjs:options.pdfjs,signal}); const document=spacing.document; abort(signal);
  const inventory=await readSourceAssets({bytes,document,signal}); abort(signal);
  const flow=buildPaperFlow(document,{drawings:inventory.drawings});
  const {bindings,changes}=bindEdits(document,flow,edits);
  const regions=(flow.regions||[]).map(r=>structuredClone(r));
  const ids=new Set(regions.map(r=>r.id));
  for(const item of flow.items.filter(i=>i.kind==='asset' && !i.renderAssetId)) {
    const p=document.pages[item.source.pageIndex], b=item.source.bbox;
    if(!p || !box(b)) continue;
    const clipped=[Math.max(0,b[0]),Math.max(0,b[1]),Math.min(p.width,b[2]),Math.min(p.height,b[3])];
    if(!box(clipped)) continue;
    const id=`capture-${item.id}`; if(ids.has(id)) fail('invalid','Duplicate capture ID.'); ids.add(id);
    item.source.bbox=clipped; item.renderAssetId=id;
    regions.push({id,pageIndex:item.source.pageIndex,bbox:clipped,blockIds:[...(item.blockIds||[])],assetIds:[...(item.assetIds||[])]});
  }
  const captured=await readSourceAssets({bytes,document:{...document,blocks:[...document.blocks,...(flow.fragments||[])]},regions,signal}); abort(signal);
  const fontPlan=await createFontPlan({text:document.blocks.map(b=>b.text||'').join('\n')+edits.map(e=>e.after).join('\n'),fonts:candidates},{mupdf:options.mupdf}); abort(signal);
  const result=await composeDocument({document,sourceBytes:bytes,flow,assets:captured,edits:changes,signal},{compile:options.compile,fonts:fontPlan,outputCheck:args=>checkRecomposition({...args,pdfjs:options.pdfjs,mupdf:options.mupdf,exporter:'Typst'})}); abort(signal);
  const actual=new Uint8Array(await result.file.arrayBuffer()); abort(signal);
  if(hex(actual)!==result.sha256) fail('output-hash','Output bytes do not match their hash.');
  return {...result,revision,bindings,sourceBinding:{spacing:spacing.evidence,sourceSha256:document.sourceSha256,editCount:bindings.length,partCount:changes.length},sourceAssets:{regions:regions.length,diagnostics:captured.diagnostics}};
}

