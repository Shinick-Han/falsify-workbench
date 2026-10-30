import {hex} from './paragraph-pdf-crypto.mjs';
const HASH=/^[a-f0-9]{64}$/,MAX_BYTES=25*1024*1024;
const error=(code,message)=>Object.assign(new Error(message),{code});
const aborted=()=>Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError',code:'ABORTED'});
let sequence=0;
/** Each read or comparison gets a fresh Worker and privately owned input bytes. */
export function createReconstructionReader({workerFactory}={}){
  const create=workerFactory||(()=>{if(typeof Worker!=='function')throw error('WORKER_UNAVAILABLE','이 브라우저에서 PDF 재구성 작업자를 사용할 수 없습니다.');return new Worker(new URL('./pdf-latex-reader-worker.mjs',import.meta.url),{type:'module'});});
  let active=null,disposed=false;
  function cancel(){active?.abort();}
  function dispose(){disposed=true;cancel();}
  function run(kind,request){
    if(disposed)return Promise.reject(error('READER_DISPOSED','작업자가 종료되었습니다.'));
    cancel();const id=++sequence,signal=request?.signal;
    return new Promise((resolve,reject)=>{
      let worker=null,done=false;
      const finish=(fn,value)=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}if(active?.id===id)active=null;fn(value);};
      const abort=()=>finish(reject,aborted());active={id,abort};signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)return abort();
      (async()=>{
        let bytes,file=null,sourceDocument=null;
        if(kind==='read'){
          file=request.file;if(!file||typeof file.arrayBuffer!=='function'||(Number.isFinite(file.size)&&file.size>MAX_BYTES))throw error('INVALID_INPUT','PDF 파일을 확인하세요.');
          bytes=new Uint8Array(await file.arrayBuffer()).slice();
        }else{
          if(!(request.bytes instanceof Uint8Array))throw error('INVALID_INPUT','기준 PDF 바이트가 필요합니다.');
          bytes=request.bytes.slice();sourceDocument=structuredClone(request.sourceDocument);
          if(!sourceDocument||!HASH.test(sourceDocument.sourceSha256)||!Array.isArray(sourceDocument.pages)||!sourceDocument.pages.length||sourceDocument.pages.some(p=>typeof p?.text!=='string'))throw error('INVALID_INPUT','원본 추출 결과를 확인하세요.');
        }
        if(done)return;if(!bytes.length||bytes.length>MAX_BYTES)throw error('INVALID_INPUT','PDF 크기가 허용 범위를 벗어났습니다.');
        const sha=hex(bytes);worker=create();if(done){worker.terminate();return;}
        worker.onmessage=({data})=>{
          if(done||data?.id!==id)return;
          if(data.type==='progress'){try{request.onProgress?.('원본의 글·그림·표를 읽고 있습니다.');}catch{}return;}
          if(data.type==='error')return finish(reject,error('WORKER_FAILED','PDF 재구성 작업에 실패했습니다.'));
          if(data.type!=='result')return finish(reject,error('INVALID_RESULT','PDF 재구성 결과를 확인할 수 없습니다.'));
          const r=data.result;
          if(kind==='read'){
            if(!r||r.sourceSha256!==sha||r.model?.schema!=='falsify.pdf-latex-reconstruction.v1'||r.model.sourceSha256!==sha||r.evidence?.document?.sourceSha256!==sha||!Array.isArray(r.evidence.document.pages)||!r.evidence.document.pages.length||r.evidence.document.pages.some(p=>typeof p?.text!=='string')||!Array.isArray(r.model.assets)||r.model.assets.some(a=>!(a?.bytes instanceof Uint8Array)||!HASH.test(a.sha256)||hex(a.bytes)!==a.sha256))return finish(reject,error('INVALID_RESULT','PDF 재구성 결과가 원본과 다릅니다.'));
            return finish(resolve,{...r,file});
          }
          if(!r||r.schema!=='falsify.reconstruction-comparison.v1'||r.sourcePdfHash!==sourceDocument.sourceSha256||r.baselinePdfHash!==sha||r.sourcePages!==sourceDocument.pages.length||!Number.isSafeInteger(r.baselinePages)||r.baselinePages<1||r.method!=='extracted-token-multiset'||r.readingOrderVerified!==false||r.visualLayoutVerified!==false||![r.text?.missing,r.text?.added,r.numbers?.missing,r.numbers?.added].every(a=>Array.isArray(a)&&a.every(v=>typeof v==='string')))return finish(reject,error('INVALID_RESULT','PDF 비교 결과가 입력과 다릅니다.'));
          finish(resolve,r);
        };
        worker.onerror=()=>finish(reject,error('WORKER_FAILED','PDF 재구성 작업에 실패했습니다.'));
        worker.onmessageerror=()=>finish(reject,error('WORKER_FAILED','PDF 재구성 결과를 읽지 못했습니다.'));
        worker.postMessage({id,type:kind,bytes,sourceDocument},[bytes.buffer]);
      })().catch(e=>{if(done)return;if(e?.code==='WORKER_UNAVAILABLE'||e?.code==='INVALID_INPUT')finish(reject,e);else finish(reject,error('WORKER_FAILED','PDF 재구성 작업에 실패했습니다.'));});
    });
  }
  return {read:request=>run('read',request||{}),compare:request=>run('compare',request||{}),cancel,dispose};
}
