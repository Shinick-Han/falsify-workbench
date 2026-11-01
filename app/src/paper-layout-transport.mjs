const ROOT='/api/paper/layout-agent/jobs';
const aborted=()=>new DOMException('취소했습니다.','AbortError');
const pause=(ms,signal)=>new Promise((resolve,reject)=>{if(signal?.aborted){reject(aborted());return;}const cancel=()=>{clearTimeout(timer);reject(aborted());};const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);signal?.addEventListener('abort',cancel,{once:true});});

/** Receipt lookup never submits a model request. Unknown delivery remains recoverable. */
export async function layoutStepDecision(link,request,{runId,signal,pendingStep,onPending=()=>{},pollMs=350,companionInstance}={}){
  const recovering=!!pendingStep;
  const id=recovering?pendingStep.stepId:runId+'-s'+request.step;
  const owner=recovering?pendingStep.runId:runId;
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(owner))throw new Error('레이아웃 요청 ID를 확인하세요.');
  const original=recovering?pendingStep.request:request;
  if(!original||original.projectId!==request.projectId)throw Object.assign(new Error('저장한 요청의 소스가 다릅니다. 보류 중인 요청을 버리거나 원본에서 다시 시작하세요.'),recovering?{recovery:'mismatch'}:{});
  let saved={runId:owner,stepId:id,projectId:original.projectId,step:original.step,request:original,state:'unknown',...(companionInstance?{companionInstance}:{}),...(recovering?pendingStep:{})};
  if(recovering&&saved.companionInstance&&companionInstance&&saved.companionInstance!==companionInstance)throw Object.assign(new Error('이전 companion의 요청입니다. 보류 중인 요청을 버리거나 원본에서 다시 시작하세요.'),{recovery:'mismatch'});
  await onPending(saved);
  let receipt;
  const validate=r=>{
    if(r?.schema!=='falsify.layout-step-receipt.v1'||r.runId!==owner||r.stepId!==id||!['running','completed','failed','cancelled'].includes(r.state)||!/^[0-9a-f]{64}$/.test(r.fingerprint||''))throw Object.assign(new Error('레이아웃 접수 정보가 요청과 다릅니다.'),{recovery:'mismatch'});
    if(saved.fingerprint&&saved.fingerprint!==r.fingerprint)throw Object.assign(new Error('저장한 요청과 조회 결과가 다릅니다.'),{recovery:'mismatch'});
    if(saved.companionInstance&&r.companionInstance&&saved.companionInstance!==r.companionInstance)throw Object.assign(new Error('companion이 변경되었습니다. 보류 중인 요청을 버리거나 원본에서 다시 시작하세요.'),{recovery:'mismatch'});
    return r;
  };
  try{
    receipt=validate(await link.request(recovering?ROOT+'/'+id:ROOT,recovering?null:{runId:owner,stepId:id,request:original},{signal}));
    while(true){
      saved={...saved,state:receipt.state,fingerprint:receipt.fingerprint,...(receipt.companionInstance?{companionInstance:receipt.companionInstance}:{})};await onPending(saved);
      if(receipt.state!=='running')break;
      await pause(pollMs,signal);receipt=validate(await link.request(ROOT+'/'+id,null,{signal}));
    }
  }catch(error){if(signal?.aborted)throw aborted();if(recovering&&error&&typeof error==='object'&&!error.recovery)error.recovery=error.httpStatus===404?'not-found':'unreachable';throw error;}
  if(signal?.aborted)throw aborted();
  if(receipt.state!=='completed')throw Object.assign(new Error(receipt.error?.message||'요청을 마치지 못했습니다. 다시 실행할 수 있습니다.'),{disposition:receipt.state,stepReceipt:saved});
  const response=receipt.result;
  if(response?.schema!=='falsify.paper-layout-agent-action.v1'||response.projectId!==original.projectId||response.step!==original.step||!response.action)throw new Error('레이아웃 응답의 소스·단계가 다릅니다.');
  return {response,pendingStep:saved};
}
