import test from 'node:test';
import assert from 'node:assert/strict';
import {createLatexProject} from '../src/latex-project.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {runPaperLayoutAgent} from '../src/paper-layout-agent.mjs';
import {deriveLayoutOutcome} from '../src/paper-layout-outcome.mjs';
const enc=new TextEncoder();
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64);
const list=(items=[])=>({total:items.length,offset:0,limit:20,nextOffset:null,items});
const comparison=(over={})=>({schema:'falsify.layout-document-comparison.v1',baselineProjectId:'base',baselineHash:A,projectId:'cand',outputHash:B,tokens:{method:'extracted-token-multiset',text:{missing:list(),added:list()},numbers:{missing:list(),added:list()}},sourceContent:{unchanged:true,changes:list(),numbers:{missing:list(),added:list()}},assets:{counts:{unchanged:1,changed:0,added:0,missing:0}},links:{missing:list(),added:list()},...over});
const inspection=(issues=[],over={})=>({schema:'falsify.layout-quality.v1',status:'partial',pdfHash:B,issues,coverage:{pages:2},...over});
const overlap={type:'text_overlap',pageIndex:1,bbox:[10,20,30,40],penalty:5,evidence:{blocks:['u1','u2']}};

test('partial inspection with overlap and missing numbers reports issues and changed content',()=>{
 const c=comparison();c.tokens.numbers.missing=list(['63','0.71']);
 const q=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'cand',baselinePdfHash:A,baselineProjectId:'base',inspection:inspection([overlap]),comparison:c,observedPages:[1,0,1,-1]});
 assert.equal(q.content,'changed');assert.equal(q.layout,'issues');assert.deepEqual(q.observedPages,[0,1]);
 const numbers=q.findings.find(f=>f.code==='NUMBERS_MISSING');assert.equal(numbers.severity,'error');assert.deepEqual(numbers.evidence.items,['63','0.71']);
 const layout=q.findings.find(f=>f.code==='text_overlap');assert.equal(layout.pageIndex,1);assert.deepEqual(layout.bbox,[10,20,30,40]);assert.equal(layout.severity,'error');assert.equal(layout.document,'candidate');
});

test('clean current evidence is unchanged and clear; identical source without comparison is unchanged',()=>{
 let q=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'cand',baselinePdfHash:A,baselineProjectId:'base',inspection:inspection(),comparison:comparison()});
 assert.equal(q.content,'unchanged');assert.equal(q.layout,'clear');assert.deepEqual(q.findings,[]);
 q=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'base',baselineProjectId:'base'});assert.equal(q.content,'unchanged');assert.equal(q.layout,'unverified');
});

test('stale, mismatched or incomplete evidence stays unverified rather than failing',()=>{
 const stale=deriveLayoutOutcome({candidatePdfHash:C,candidateProjectId:'cand',baselinePdfHash:A,baselineProjectId:'base',inspection:inspection([overlap]),comparison:comparison()});
 assert.equal(stale.content,'unverified');assert.equal(stale.layout,'unverified');assert.deepEqual(stale.findings,[]);
 const otherBaseline=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'cand',baselinePdfHash:C,baselineProjectId:'base',comparison:comparison()});assert.equal(otherBaseline.content,'unverified');
 const noTokens=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'cand',baselinePdfHash:A,baselineProjectId:'base',comparison:comparison({tokens:{method:'unavailable'}})});assert.equal(noTokens.content,'unverified');assert.deepEqual(noTokens.findings,[]);
 const unavailable=deriveLayoutOutcome({candidatePdfHash:B,inspection:inspection([],{status:'unavailable'})});assert.equal(unavailable.layout,'unverified');
 const sourceOnly=deriveLayoutOutcome({candidatePdfHash:null,candidateProjectId:'cand',baselineProjectId:'base',inspection:inspection([overlap])});assert.equal(sourceOnly.pdfHash,null);assert.equal(sourceOnly.content,'unverified');assert.equal(sourceOnly.layout,'unverified');
 assert.equal(deriveLayoutOutcome().content,'unverified');assert.equal(deriveLayoutOutcome(null).layout,'unverified');
});

test('source content, link and added-text differences are content changes',()=>{
 for(const [over,code] of [[{sourceContent:{unchanged:false,changes:list(['main.tex']),numbers:{missing:list(),added:list()}}},'SOURCE_CONTENT_CHANGED'],[{links:{missing:list([{uri:'https://x',external:true,targetPage:null}]),added:list()}},'LINKS_MISSING']]){
  const q=deriveLayoutOutcome({candidatePdfHash:B,candidateProjectId:'cand',baselinePdfHash:A,baselineProjectId:'base',comparison:comparison(over)});assert.equal(q.content,'changed',code);assert.ok(q.findings.some(f=>f.code===code),code);
 }
 const c=comparison();c.tokens.text.added=list(['injected']);assert.equal(deriveLayoutOutcome({candidatePdfHash:B,baselinePdfHash:A,comparison:c}).content,'changed');
});

test('compiler diagnostics for the current PDF become findings without input mutation',()=>{
 const input={candidatePdfHash:B,diagnostics:[{code:'TEX_OVERFULL_BOX',message:'overflow',severity:'warning',count:2}],inspection:inspection([overlap])};const copy=structuredClone(input);
 const q=deriveLayoutOutcome(input);assert.deepEqual(input,copy);assert.ok(q.findings.some(f=>f.code==='TEX_OVERFULL_BOX'&&f.evidence.count===2));
});

const action=(tool,extra={})=>['checkpoint','restore_revision','compare_document'].includes(tool)?{tool,args:extra,message:''}:({tool,path:'',before:'',after:'',pages:[],message:'',...extra});
const artifactFor=p=>{const bytes=enc.encode('%PDF '+p.id);return {success:true,projectId:p.id,engine:p.engine,pdfBytes:bytes,pdfHash:hex(bytes),diagnostics:[]};};

test('workflow finish stays complete while quality exposes overlap and missing numbers',async()=>{
 const project=await createLatexProject({mainFile:'main.tex',files:[{path:'main.tex',bytes:enc.encode('Evidence 63 and RED 71. \\vspace{2pt} Text.')},{path:'asset.png',bytes:Uint8Array.of(1,2)}]});
 const baseline=artifactFor(project),states=[];
 const actions=[action('replace_source',{path:'main.tex',before:'\\vspace{2pt}',after:'\\vspace{4pt}'}),action('compile_pdf'),action('inspect_pdf'),action('render_pages',{pages:[1]}),action('compare_document'),action('finish',{message:'done'})];
 const out=await runPaperLayoutAgent({project,artifact:baseline,decide:async()=>actions.shift(),compile:async({project})=>artifactFor(project),
  inspect:async({artifact})=>({schema:'falsify.layout-quality.v1',status:'partial',pdfHash:artifact.pdfHash,issues:[overlap],coverage:{pages:2}}),
  render:async()=>({images:[{pageIndex:1,mime:'image/png',base64:'iVBORw0KGgo='}],coverage:{pages:[1],complete:false}}),
  handlers:{compare_document:async({project,artifact,baselineProject,baselineArtifact})=>{const c=comparison({baselineProjectId:baselineProject.id,baselineHash:baselineArtifact.pdfHash,projectId:project.id,outputHash:artifact.pdfHash});c.tokens.numbers.missing=list(['63']);return {observation:c};}},
  onState:s=>{states.push(s);throw new Error('observer failure');}});
 assert.equal(out.status,'complete');assert.equal(out.runState,'completed');
 assert.equal(out.quality.content,'changed');assert.equal(out.quality.layout,'issues');assert.deepEqual(out.quality.observedPages,[1]);assert.equal(out.quality.pdfHash,out.artifact.pdfHash);
 assert.ok(out.quality.findings.some(f=>f.code==='NUMBERS_MISSING'));assert.ok(out.quality.findings.some(f=>f.code==='text_overlap'&&f.pageIndex===1));
 assert.equal(out.coverage.render.complete,false);assert.ok(out.artifact.pdfBytes.length>0);
 assert.equal(states[0].runState,'running');assert.equal(states.at(-1).runState,'completed');assert.equal(states.at(-1).status,'complete');assert.equal(states.at(-1),out.sessionState);
 assert.ok(states.length>=6);assert.ok(Object.isFrozen(out.sessionState)&&Object.isFrozen(out.sessionState.candidate.project.files));
 assert.equal(out.sessionState.baselineProject.id,project.id);assert.equal(out.sessionState.baselineArtifact.pdfHash,baseline.pdfHash);assert.equal(out.sessionState.stepCount,6);
 assert.equal(states[1].baselineProject.files[0].bytes,states.at(-1).baselineProject.files[0].bytes,'asset buffers are shared, not cloned per snapshot');
});
