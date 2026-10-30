/** Resolve imported/manual proposals against an injected source model. */
export function resolveSourceProposals(project, response, {model} = {}) {
  const diagnostics = [];
  if (!model || model.projectId !== project?.id) return {proposals: [], diagnostics: [{code:'stale-model', message:'The source model is stale; analyze this project again.'}]};
  let batch = response;
  if (typeof response === 'string') {
    const parser = model.parseResponse || globalThis.FalsifyExternalExchange?.parse;
    if (!parser) return {proposals: [], diagnostics: [{code:'parser-unavailable', message:'Load the external response parser before importing a response.'}]};
    const segments = (model.nodes || []).map(n => ({id:n.id, text:n.displayText ?? n.text ?? ''}));
    batch = parser(response, {role:'red', fileHash:project.id, segments});
  }
  const entries = Array.isArray(batch) ? batch : batch?.changes || batch?.items || batch?.proposals || [];
  diagnostics.push(...(batch?.diagnostics || []));
  const identityMismatch = diagnostics.some(d => d.code === 'file-hash-mismatch');
  const proposals = entries.map((item, i) => {
    const provenance = item.provenance || {origin: typeof response === 'string' || batch?.schema === 'falsify.external-batch.v1' ? 'external-ai' : 'human', ...(batch?.id ? {responseId:batch.id} : {})};
    const base = {id:item.id || `source-change-${i+1}`, before:item.before, after:item.after, kind:item.kind && item.kind !== 'change' ? item.kind : 'text', mode:item.mode || 'content', enabled:item.enabled !== false, provenance};
    if (typeof item.before !== 'string' || typeof item.after !== 'string') return {...base, enabled:false, status:'invalid'};
    if (identityMismatch) return {...base, enabled:false, status:'identity-mismatch'};
    if (item.anchor) {
      const node = (model.nodes || []).find(n => n.id === item.anchor.nodeId);
      if (item.anchor.projectId !== project.id || !node || node.path !== item.anchor.path || item.anchor.start < node.start || item.anchor.end > node.end || item.anchor.start > item.anchor.end || node.kind !== item.anchor.kind) return {...base, enabled:false, status:'stale-anchor'};
      return {...base, kind:node.kind, anchor:item.anchor, status:'matched'};
    }
    const locate = model.locateSourceText || model.locate;
    if (typeof locate !== 'function') return {...base, enabled:false, status:'unresolved'};
    const result = locate(project, {before:item.before, ...(item.path ? {path:item.path} : {}), ...(item.nodeId ? {nodeId:item.nodeId} : {})});
    if (result.status !== 'matched' || result.candidates?.length !== 1) return {...base, enabled:false, status:result.status || 'missing'};
    const candidate = result.candidates[0];
    // Reduce a mixed displayed sentence to one independently located source node.
    let left=0, right=0;
    while (left < item.before.length && left < item.after.length && item.before[left] === item.after[left]) left++;
    while (right < item.before.length-left && right < item.after.length-left && item.before[item.before.length-1-right] === item.after[item.after.length-1-right]) right++;
    const changedBefore=item.before.slice(left,item.before.length-right), changedAfter=item.after.slice(left,item.after.length-right);
    if (changedBefore && (left || right)) {
      const narrowed=locate(project,{before:changedBefore,path:candidate.anchor.path});
      const c=narrowed.status==='matched' && narrowed.candidates?.length===1 ? narrowed.candidates[0] : null;
      if (c && c.before === changedBefore && c.anchor.start>=candidate.anchor.start && c.anchor.end<=candidate.anchor.end) {
        const change={...base,before:c.before ?? changedBefore,after:changedAfter,kind:c.anchor.kind,anchor:c.anchor};
        return {...base,anchor:candidate.anchor,status:'matched',sourceChanges:[change]};
      }
    }
    const node=(model.nodes || []).find(n=>n.id===candidate.anchor.nodeId);
    if (node && node.kind === 'text' && /\\[A-Za-z@]+/.test(node.sourceText || '')) return {...base,enabled:false,status:'unsupported-mixed-source'};
    return {...base, before:candidate.before ?? item.before, kind:candidate.anchor.kind, anchor:candidate.anchor, status:'matched'};
  });
  return {proposals, diagnostics};
}
