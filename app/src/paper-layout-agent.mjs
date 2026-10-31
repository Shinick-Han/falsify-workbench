import {createLatexProject} from './latex-project.mjs';
import {hex} from './paragraph-pdf-crypto.mjs';
import {readLayoutStructure} from './paper-layout-structure.mjs';

const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true});
const tools = ['read_source','replace_source','compile_pdf','inspect_pdf','render_pages','read_reference','render_reference_pages','restructure_source','finish'];
const instruction = 'Preserve all source content, references, assets and selected RED edits. Use exact unique before/after replacements for literal layout settings only. Example: \\setlength{\\parskip}{4pt} -> \\setlength{\\parskip}{6pt}; \\fontsize{10}{12}\\selectfont -> \\fontsize{10}{13}\\selectfont. Compile, inspect and render current PDF, then finish. Completion reports workflow only, not a visual quality pass.';
const descriptions = {
  read_source:'Read an existing .tex file by path in 8,000-character chunks: pages:[chunkIndex] (default 0). before can locate a known substring instead. sourceFiles contains previews only; result gives totalChunks and offset.',
  replace_source:'Replace one exact unique source span. Layout values: parindent, parskip, baselineskip, textfloatsep, columnsep, linewidth, vspace/hspace; fontsize and selectfont; font family; widow/club penalties; figure/table placement, graphic width/height/scale, geometry margins, and documentclass font size/columns. Preserve prose, numbers, comments, definitions and structure. Example: \\setlength{\\parskip}{4pt} -> \\setlength{\\parskip}{6pt}.',
  compile_pdf:'Compile the current project; unsuccessful or stale outputs remain unresolved.',
  inspect_pdf:'Inspect the current compiled artifact and return its hash-bound layout observations.',
  render_pages:'Render up to four zero-based pages of the current compiled artifact.',
  read_reference:'Read original PDF text and region geometry for up to four zero-based pages. Use original evidence to preserve title, authors, abstract, body, captions and furniture.',
  render_reference_pages:'Render up to four zero-based pages of the original PDF, separately labelled original. Compare them with candidate pages.',
  restructure_source:'after is JSON {schema:"falsify.paper-layout-plan.v1",sourcePdfHash,frontMatter:[unitIds],order:[ALL unitIds exactly once],furniture:[{id,placement:"header"|"footer"}],columns:1|2}. Use structure units and current plan. Move layout units without rewriting their content; preserve established figure/caption groups.',
  finish:'Finish only after observing compile, inspection and rendered candidate pages; when an original PDF is present, also read and visually observe its pages. Partial coverage is not a quality pass.'
};
const toolDescriptors = tools.map(name=>({name,description:descriptions[name]}));
const length = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:pt|mm|cm|in|em|ex|bp|pc|dd|cc|sp|\\(?:textwidth|linewidth|columnwidth))`;
const number = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)`;
const patterns = [
  [new RegExp(String.raw`^\\setlength\s*\{\s*\\(parindent|parskip|baselineskip|textfloatsep|columnsep|linewidth)\s*\}\s*\{\s*${length}\s*\}`), m=>`<setlength:${m[1]}>`],
  [new RegExp(String.raw`^\\(parindent|parskip|baselineskip|textfloatsep|columnsep|linewidth)\s*=\s*${length}\b`),m=>`<length:${m[1]}>`],
  [new RegExp(String.raw`^\\(vspace|hspace)(\*?)\s*\{\s*${length}\s*\}`),m=>`<space:${m[1]}${m[2]}>`],
  [new RegExp(String.raw`^\\fontsize\s*\{\s*${number}(?:pt|bp)?\s*\}\s*\{\s*${number}(?:pt|bp)?\s*\}\s*\\selectfont\b`),()=>'<fontsize>'],
  [new RegExp(String.raw`^\\FalsifyImage\s*\{\s*${length}\s*\}\s*\{\s*${length}\s*\}\s*\{([^{}\n%]+)\}`),m=>'<falsify-image:'+m[1].replaceAll('<','<<')+'>'],
  [/^\\(?:rmfamily|sffamily|ttfamily)\b/,()=>'<family>'],
  [/^\\fontfamily\s*\{\s*(?:cmr|cmss|cmtt|lmr|lmss|lmtt|ptm|phv|pcr)\s*\}\s*\\selectfont\b/,()=>'<family-select>'],
  [/^\\(widowpenalty|clubpenalty|displaywidowpenalty)\s*=\s*\d{1,5}\b/,m=>`<penalty:${m[1]}>`],
  [/^\\(newpage|clearpage|pagebreak|nopagebreak|smallskip|medskip|bigskip)\b/,m=>`<break:${m[1]}>`],
  [/^\\begin\s*\{(figure\*?|table\*?)\}\s*\[([htbp!]+)\]/,m=>`\\begin{${m[1]}}<placement>`],
  [/^\\documentclass\s*\[([^\]\n%{}]+)\]/,m=>{const parts=m[1].split(',');return String.raw`\documentclass[`+parts.map(part=>{const v=part.trim();if(/^(?:10|11|12)pt$/.test(v))return '<class-size>';if(/^(?:onecolumn|twocolumn)$/.test(v))return '<class-columns>';return part.replaceAll('<','<<');}).join(',')+']';}],
  [new RegExp(String.raw`^\\geometry\s*\{((?:(?:margin|left|right|top|bottom|hmargin|vmargin)\s*=\s*${length}\s*,?\s*)+)\}`),m=>'<geometry:'+m[1].split(',').filter(x=>x.trim()).map(x=>x.split('=')[0].trim()).join(',')+'>'],
  [new RegExp(String.raw`^\\includegraphics\s*\[(?:(?:width|height)\s*=\s*${length}|scale\s*=\s*${number}|keepaspectratio)(?:\s*,\s*(?:(?:width|height)\s*=\s*${length}|scale\s*=\s*${number}|keepaspectratio))*\]`),()=>String.raw`\includegraphics<dimensions>`],
];
// Lex full source. Only top-level literal layout values are normalized; comments,
// math, nested arguments and everything else remain byte-for-byte evidence.
function sourceSignature(text, editStart=-1, editEnd=-1) {
  let out='', depth=0, math=false, comment=false, line='', safe=true;const groups=[];
  const literal=value=>value.replaceAll('<','<<');
  for(let i=0;i<text.length;) {
    if ((i===editStart || i===editEnd) && (comment || groups.includes('argument') || math || /\\(?:def|gdef|edef|xdef|newcommand|renewcommand|providecommand|DeclareRobustCommand|catcode)\b/.test(line))) safe=false;
    const c=text[i];
    if (!comment && !math && c==='\\') {
      const verb=/^\\verb\*?([^A-Za-z\s])/.exec(text.slice(i));
      const env=/^\\begin\s*\{(verbatim\*?|lstlisting|minted)\}/.exec(text.slice(i));
      if (verb || env) {
        const end=verb ? text.indexOf(verb[1],i+verb[0].length) : text.indexOf('\\end{'+env[1]+'}',i+env[0].length);
        const stop=end<0 ? text.length : end+(verb?1:('\\end{'+env[1]+'}').length);
        if(editStart<stop && editEnd>i) safe=false;
        const segment=text.slice(i,stop); out+=literal(segment); line=segment.includes('\n')?segment.slice(segment.lastIndexOf('\n')+1):line+segment; i=stop; continue;
      }
    }
    if (comment) {out+=literal(c); i++; if(c==='\n'){comment=false;line='';} else line+=c; continue;}
    if (c==='%' ) {comment=true;out+=literal(c);line+=c;i++;continue;}
    if (c==='\\' && !math && !groups.includes('argument') && !/\\(?:def|gdef|edef|xdef|newcommand|renewcommand|providecommand|DeclareRobustCommand|catcode)\b/.test(line)) {
      let found=false;
      for(const [re,normal] of patterns) {const m=re.exec(text.slice(i)); if(m){ if(editStart>=0 && ((i<editStart && i+m[0].length>editStart)||(i<editEnd && i+m[0].length>editEnd))) safe=false; out+=normal(m);line+=m[0];i+=m[0].length;found=true;break; }}
      if(found) continue;
    }
    if(c==='\\' && i+1<text.length && !/[A-Za-z@]/.test(text[i+1])) {const pair=text.slice(i,i+2); if(pair==='\\('||pair==='\\[')math=true;else if(pair==='\\)'||pair==='\\]')math=false;out+=literal(pair);line+=pair;i+=2;continue;}
    if(c==='$') math=!math;
    if(!math && c==='{'){depth++;groups.push(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?\s*$/.test(line)||line.trimEnd().endsWith('}')?'argument':'layout');}
    if(!math && c==='}'){depth--;groups.pop();}
    if(depth<0) safe=false;
    out+=literal(c);i++;line=c==='\n'?'':line+c;
  }
  return {signature:out,safe};
}
function safeReplacement(text, start, before, after) {
  if (!before || before===after || /%|\\(?:def|gdef|edef|xdef|newcommand|renewcommand|providecommand|DeclareRobustCommand|catcode)\b/.test(before+after)) return false;
  const updated=text.slice(0,start)+after+text.slice(start+before.length);
  for(const match of updated.matchAll(/\\includegraphics\s*\[([^\]]+)\]/g)){
    if(match.index>start+after.length||match.index+match[0].length<start)continue;
    if(/\bwidth\s*=/.test(match[1])&&/\bheight\s*=/.test(match[1])&&!/(?:^|,)\s*keepaspectratio\s*(?:,|$)/.test(match[1]))return false;
  }
  const old=sourceSignature(text,start,start+before.length), next=sourceSignature(updated,start,start+after.length);
  return old.safe && next.safe && old.signature===next.signature;
}
function validAction(a) {
  return a && typeof a === 'object' && !Array.isArray(a) && tools.includes(a.tool) &&
    ['path','before','after','message'].every(k => typeof a[k] === 'string' && a[k].length <= 20000) &&
    Array.isArray(a.pages) && a.pages.length <= 4 && a.pages.every(n => Number.isSafeInteger(n) && n >= 0 && n < 500) && new Set(a.pages).size === a.pages.length;
}
function bounded(value) {
    try { const text = JSON.stringify(value); return text.length <= 12000 ? JSON.parse(text) : {status:'truncated', detail:'Tool result exceeded observation limit.'}; }
  catch { return {status:'unavailable', detail:'Tool result was not serializable.'}; }
}
function validArtifact(a, p) {
  return a?.success === true && a.projectId === p.id && a.engine === p.engine && a.pdfBytes instanceof Uint8Array && a.pdfBytes.length > 0 && typeof a.pdfHash === 'string' && hex(a.pdfBytes) === a.pdfHash;
}

/** Model decisions select injected app tools. No model action executes host commands. */
export async function runPaperLayoutAgent({project, artifact=null, decide, compile, inspect, render, reference=null,readReference,renderReference,restructure,signal, onProgress, maxSteps=12}={}) {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 32 || ![decide,compile,inspect,render].every(f=>typeof f==='function')) throw new TypeError('Invalid layout agent configuration');
  const verified = await createLatexProject(project);
  if (verified.id !== project.id || project.files.some(f => hex(f.bytes) !== f.sha256)) throw new Error('Stale project identity');
  if (artifact && !validArtifact(artifact, verified)) throw new Error('Stale artifact identity');
  if(reference&&(!/^[a-f0-9]{64}$/.test(reference.sourcePdfHash||'')||reference.sourcePdfHash!==project.sourcePdfHash||typeof readReference!=='function'||typeof renderReference!=='function'))throw new Error('Original PDF reference does not match project');
  let current = verified, lastProject = verified, lastArtifact = artifact, compiled = null, inspected = null, rendered = null;
  let observations = [], images = [], trace = [], coverage = null,referenceImages=[],referenceRead=false,referenceSeen=false,candidateSeen=null;
  const referencePages={read:new Set(),rendered:new Set(),observed:new Set()};
  const result = (status, message) => ({project:lastProject, artifact:lastArtifact, status, trace, coverage:coverage?{...coverage,...(reference?{reference:{sourcePdfHash:reference.sourcePdfHash,readPages:[...referencePages.read],renderedPages:[...referencePages.rendered],observedPages:[...referencePages.observed]}}:{})}:coverage, message});
  const record = (action, data, identity=current.id, pdfHash=lastArtifact?.pdfHash ?? null) => {
    const entry = {action, result:bounded(data), projectId:identity, pdfHash};
    trace.push(entry); observations.push(entry); observations = observations.slice(-4);
    try { onProgress?.(entry); } catch { /* observers cannot alter the run */ }
  };
  const cancelled = () => signal?.aborted;
  for (let step=0; step<maxSteps; step++) {
    if (cancelled()) return result('cancelled','Layout run cancelled.');
    let a;
    try {
      const sourceFiles=current.files.filter(f=>/\.tex$/i.test(f.path)),previewSize=Math.min(3000,Math.floor(16000/Math.max(1,sourceFiles.length)));
      let structure=null;try{const s=readLayoutStructure(current);structure={schema:s.schema,sourcePdfHash:s.sourcePdfHash,plan:s.plan,unitCount:s.units.length,units:s.units.slice(0,24).map(({id,pageIndex,bbox,kind,role,span})=>({id,pageIndex,bbox,kind,role,span})),unitsTruncated:s.units.length>24};}catch{}
      const attached=referenceImages.length&&images.length?[...referenceImages.slice(0,2),...images.slice(0,2)]:[...referenceImages,...images].slice(0,4);
      const observedRead=referenceRead||observations.some(e=>e.action==='read_reference'&&e.result?.status==='ok'),originalVisible=referenceSeen||attached.some(i=>i.document==='original'),candidateVisible=candidateSeen===lastArtifact?.pdfHash||attached.some(i=>i.document!=='original');
      const execution={compiledCurrent:compiled===current.id,inspectedCurrent:inspected===lastArtifact?.pdfHash,renderedCurrent:rendered===lastArtifact?.pdfHash,originalRead:observedRead,originalVisible,candidateVisible,pdfHash:lastProject.id===current.id?lastArtifact?.pdfHash:null,remainingSteps:maxSteps-step,completedActions:trace.map(e=>({tool:e.action,status:e.result?.status}))};
      execution.canFinish=execution.compiledCurrent&&execution.inspectedCurrent&&execution.renderedCurrent&&candidateVisible&&(!reference||observedRead&&originalVisible);
      a = await decide({projectId:current.id, step, maxSteps, execution,instruction:instruction+(reference?' Compare the original PDF reference against the candidate. Read and render original pages first; retain full-width front matter, column body, anchored furniture and original content.':''), tools:structuredClone(toolDescriptors.filter(t=>!['read_reference','render_reference_pages'].includes(t.name)||reference).filter(t=>t.name!=='restructure_source'||structure&&typeof restructure==='function')), observations:structuredClone(observations), images:structuredClone(attached), sourceFiles:sourceFiles.map(f=>({path:f.path,text:dec.decode(f.bytes).slice(0,previewSize)})),...(reference?{reference:structuredClone(reference)}:{}),...(structure?{structure}: {})});
      if(attached.some(i=>i.document==='original')){referenceSeen=true;for(const i of attached.filter(i=>i.document==='original'))referencePages.observed.add(i.pageIndex);}
      if(observations.some(e=>e.action==='read_reference'&&e.result?.status==='ok'))referenceRead=true;
      if(attached.some(i=>i.document!=='original')&&compiled===current.id)candidateSeen=lastArtifact?.pdfHash;
      if (cancelled()) return result('cancelled','Layout run cancelled.');
      if (!validAction(a)) { record('invalid_action',{status:'rejected',reason:'Malformed action'}); return result('unresolved','Malformed agent action.'); }
      const action = a.tool;
      if (action === 'finish') {
        const complete = compiled === current.id && inspected === lastArtifact?.pdfHash && rendered === lastArtifact?.pdfHash && lastProject.id === current.id&&candidateSeen===lastArtifact?.pdfHash&&(!reference||referenceRead&&referenceSeen);
        record(action,{status:complete?'complete':'rejected',message:a.message});
        return result(complete?'complete':'unresolved',complete ? a.message : 'Current PDF has not been compiled, inspected and rendered.');
      }
      if(action==='read_reference'){
        if(!reference){record(action,{status:'rejected',reason:'No original PDF reference'});continue;}
        const output=await readReference({pages:[...a.pages],offset:/^\d+$/.test(a.before)?Number(a.before):0,signal});if(cancelled())return result('cancelled','Layout run cancelled.');
        if(output?.sourcePdfHash!==reference.sourcePdfHash||!Array.isArray(output.pages)||!output.pages.length||output.pages.some(p=>!Number.isSafeInteger(p.pageIndex)||p.pageIndex<0)||bounded({status:'ok',reference:output})?.status==='truncated'){record(action,{status:'rejected',reason:'Original reference is unavailable, too large, or has another hash'});continue;}
        for(const page of output.pages)referencePages.read.add(page.pageIndex);record(action,{status:'ok',reference:output});continue;
      }
      if(action==='render_reference_pages'){
        if(!reference){record(action,{status:'rejected',reason:'No original PDF reference'});continue;}
        const output=await renderReference({pages:[...a.pages],signal});if(cancelled())return result('cancelled','Layout run cancelled.');
        if(output?.sourcePdfHash!==reference.sourcePdfHash||!Array.isArray(output.images)||!output.images.length||output.images.length>4||output.images.some(i=>!Number.isSafeInteger(i.pageIndex)||i.pageIndex<0||i.mime!=='image/png'||typeof i.base64!=='string'||!i.base64.startsWith('iVBORw0KGgo')||i.base64.length>699052)||a.pages.length&&a.pages.some(p=>!output.images.some(i=>i.pageIndex===p))){record(action,{status:'rejected',reason:'Original page render does not match reference'});continue;}
        referenceImages=output.images.map(i=>({...i,document:'original'}));for(const i of referenceImages)referencePages.rendered.add(i.pageIndex);record(action,{status:'ok',sourcePdfHash:reference.sourcePdfHash,pages:referenceImages.map(i=>i.pageIndex),coverage:output.coverage});continue;
      }
      if(action==='restructure_source'){
        if(typeof restructure!=='function'){record(action,{status:'rejected',reason:'No structural editor for this source'});continue;}
        let plan;try{plan=JSON.parse(a.after);}catch{record(action,{status:'rejected',reason:'after must be a layout plan JSON object'});continue;}
        let output;try{output=await restructure({project:structuredClone(current),plan,signal});}catch{record(action,{status:'rejected',reason:'Structure plan must preserve all units, assets and source identity; use current structure.plan with every unit exactly once'});continue;}
        if(cancelled())return result('cancelled','Layout run cancelled.');
        const next=await createLatexProject(output.project);
        if(next.id!==output.project?.id||next.origin!==current.origin||next.engine!==current.engine||next.sourcePdfHash!==current.sourcePdfHash||current.files.some(f=>!(/\.tex$/i.test(f.path)||/^falsify-(?:layout-structure|reconstruction)\.json$/.test(f.path))&&!next.files.some(g=>g.path===f.path&&g.sha256===f.sha256))){record(action,{status:'rejected',reason:'Structural tool returned an unrelated project or changed source assets'});continue;}
        current=next;compiled=inspected=rendered=candidateSeen=null;images=[];coverage=null;record(action,{status:'ok',summary:output.summary});continue;
      }
      if (action === 'read_source' || action === 'replace_source') {
        const file = current.files.find(f=>f.path===a.path && /\.tex$/i.test(f.path));
        if (!file) { record(action,{status:'rejected',reason:'Unsupported path'}); continue; }
        const text = dec.decode(file.bytes);
        if (action === 'read_source') {
          const match=a.before?text.indexOf(a.before):-1,offset=match>=0?Math.max(0,match-500):(a.pages[0]||0)*8000;
          if(offset>=text.length&&text.length){record(action,{status:'rejected',reason:'Source chunk is outside this file',totalChunks:Math.ceil(text.length/8000)});continue;}
          record(action,{status:'ok',path:file.path,text:text.slice(offset,offset+8000),offset,totalCharacters:text.length,totalChunks:Math.ceil(text.length/8000)});continue;
        }
        const start=text.indexOf(a.before);
        // A layout operation must not occur within a commented line or a macro definition.
        const lineStart=text.lastIndexOf('\n',start-1)+1, prefix=text.slice(lineStart,start);
        if (start<0 || text.indexOf(a.before,start+1)!==-1 || !safeReplacement(text,start,a.before,a.after) || /(^|[^\\])%/.test(prefix) || /\\(?:def|gdef|edef|xdef|newcommand|renewcommand|catcode)\b/.test(prefix)) {
          record(action,{status:'rejected',reason:'Use a unique exact match and change only supported literal layout values; preserve prose, comments, definitions and structure. Include keepaspectratio when setting both graphic width and height. Example: \\setlength{\\parskip}{4pt} -> \\setlength{\\parskip}{6pt}.',path:file.path}); continue;
        }
        const files=current.files.map(f=>({path:f.path,bytes:f.path===file.path?enc.encode(text.slice(0,start)+a.after+text.slice(start+a.before.length)):f.bytes}));
        const next=await createLatexProject({...current,files});
        if (cancelled()) return result('cancelled','Layout run cancelled.');
        next.revision=(current.revision||0)+1; current=next; compiled=inspected=rendered=null; images=[]; coverage=null;
        record(action,{status:'ok',path:file.path,before:a.before,after:a.after}); continue;
      }
      if (action === 'compile_pdf') {
        const output=await compile({project:structuredClone(current),signal});
        if (cancelled()) return result('cancelled','Layout run cancelled.');
        if (!validArtifact(output,current)) { compiled=inspected=rendered=null; record(action,{status:'failed',diagnostics:output?.diagnostics||[]}); continue; }
        lastProject=current; lastArtifact={...output,pdfBytes:new Uint8Array(output.pdfBytes)}; compiled=current.id; inspected=rendered=null; images=[]; coverage=null;
        record(action,{status:'ok',diagnostics:output.diagnostics||[]}); continue;
      }
      if (compiled !== current.id || lastProject.id !== current.id || !validArtifact(lastArtifact,current)) { record(action,{status:'rejected',reason:'Compile current project first'}); continue; }
      if (action === 'inspect_pdf') {
        const output=await inspect({project:structuredClone(current),artifact:structuredClone(lastArtifact),signal});
        if (cancelled()) return result('cancelled','Layout run cancelled.');
        if (!output || output.schema !== 'falsify.layout-quality.v1' || !['ok','partial'].includes(output.status) || output.pdfHash !== lastArtifact.pdfHash || !Array.isArray(output.issues) || !output.coverage || typeof output.coverage !== 'object' || Array.isArray(output.coverage) || ['truncated','unavailable'].includes(bounded({status:'ok',observation:output})?.status)) { inspected=null; record(action,{status:'failed',observation:output}); continue; }
        inspected=lastArtifact.pdfHash; record(action,{status:'ok',observation:output}); continue;
      }
      const output=await render({project:structuredClone(current),artifact:structuredClone(lastArtifact),pages:[...a.pages],signal});
      if (cancelled()) return result('cancelled','Layout run cancelled.');
      if (!output || !Array.isArray(output.images) || !output.images.length || output.images.length > 4 || output.images.some(i=>!Number.isSafeInteger(i.pageIndex)||i.pageIndex<0||i.mime!=='image/png'||typeof i.base64!=='string'||!i.base64.startsWith('iVBORw0KGgo')||i.base64.length>699052)) { rendered=null; record(action,{status:'failed',reason:'No valid rendered pages'}); continue; }
      if (new Set(output.images.map(i=>i.pageIndex)).size !== output.images.length || (a.pages.length && (output.images.length !== a.pages.length || a.pages.some(p=>!output.images.some(i=>i.pageIndex===p))))) { rendered=null; record(action,{status:'failed',reason:'Rendered pages do not match request'}); continue; }
      images=output.images.map(i=>({pageIndex:i.pageIndex,mime:i.mime,base64:i.base64})); coverage={status:'partial',render:bounded(output.coverage ?? null),visualQualityVerified:false}; rendered=lastArtifact.pdfHash;
      record(action,{status:'ok',pages:images.map(i=>i.pageIndex),coverage});
    } catch (error) {
      if (cancelled()) return result('cancelled','Layout run cancelled.');
      record(a?.tool || 'decide',{status:'failed',reason:'Tool failed'});
      return result('unresolved','Layout agent tool failed.');
    }
  }
  return result('unresolved','Layout agent reached its step limit.');
}
