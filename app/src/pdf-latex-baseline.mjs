import {extractReconstructionEvidence,buildReconstructionModel} from './pdf-latex-evidence.mjs';
import {enrichReconstructionRegions} from './pdf-latex-regions.mjs';
import {serializeReconstruction} from './pdf-latex-serialize.mjs';
import {createLatexProject} from './latex-project.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
import * as mupdf from 'mupdf';

const encoder=new TextEncoder();
const cancelled=signal=>{if(signal?.aborted)throw new DOMException('취소했습니다.','AbortError');};
const words=text=>String(text||'').normalize('NFC').replace(/(\p{L})-\s*\n\s*(\p{L})/gu,'$1$2').match(/[\p{L}\p{N}]+(?:[.,][\p{N}]+)*/gu)||[];
function difference(a,b){const counts=new Map();for(const value of b)counts.set(value,(counts.get(value)||0)+1);const out=[];for(const value of a){const count=counts.get(value)||0;if(count)counts.set(value,count-1);else out.push(value);}return out;}
/** No-op reconstruction differences are separate from later RED changes. */
export function compareReconstruction(source,baseline){
  if(!source?.pages||!baseline?.pages)throw new TypeError('두 PDF의 추출 결과가 필요합니다.');
  const original=source.pages.map(p=>p.text||'').join('\n'), rebuilt=baseline.pages.map(p=>p.text||'').join('\n');
  const a=words(original),b=words(rebuilt),numbers=list=>list.filter(v=>/^\d/.test(v));
  return {schema:'falsify.reconstruction-comparison.v1',sourcePages:source.pages.length,baselinePages:baseline.pages.length,
    text:{missing:difference(a,b),added:difference(b,a)},numbers:{missing:difference(numbers(a),numbers(b)),added:difference(numbers(b),numbers(a))},
    method:'extracted-token-multiset',readingOrderVerified:false,visualLayoutVerified:false};
}
export async function prepareReconstruction({file,signal,onProgress=()=>{}}={},dependencies={}){
  cancelled(signal);if(!file?.arrayBuffer)throw new TypeError('원본 PDF가 필요합니다.');
  const bytes=new Uint8Array(await file.arrayBuffer());cancelled(signal);const hash=hex(bytes);
  onProgress('원본의 글·그림·표를 읽고 있습니다.');
  const extract=dependencies.extract||extractReconstructionEvidence;
  const evidence=await extract({bytes,sourceSha256:hash,signal});cancelled(signal);
  const base=(dependencies.model||buildReconstructionModel)(evidence);
  const model=await(dependencies.regions||enrichReconstructionRegions)({model:base,bytes,signal,revision:hash,mupdf});cancelled(signal);
  return {file,sourceSha256:hash,evidence,model};
}
export async function createReconstructionProject(draft,decisions=[],dependencies={}){
  if(!draft?.sourceSha256||draft.model?.sourceSha256!==draft.sourceSha256)throw new Error('원본 PDF와 재구성 정보가 다릅니다.');
  const result=(dependencies.serialize||serializeReconstruction)({model:draft.model,decisions,engine:'pdflatex'});
  if(!result.mainFile||!result.files?.length)throw Object.assign(new Error('편집용 소스를 만들지 못했습니다.'),{diagnostics:result.diagnostics});
  const metadata={schema:'falsify.reconstruction-baseline.v1',sourcePdfHash:draft.sourceSha256,status:result.status,decisions:structuredClone(decisions),bindings:result.bindings,diagnostics:result.diagnostics};
  const files=[...result.files,{path:'falsify-reconstruction.json',bytes:encoder.encode(JSON.stringify(metadata))}];
  const project=await(dependencies.project||createLatexProject)({files,mainFile:result.mainFile,engine:'pdflatex',origin:'reconstructed-pdf',sourcePdfHash:draft.sourceSha256});
  return {...result,project,bindings:result.bindings.map(b=>({...b,projectId:project.id}))};
}
