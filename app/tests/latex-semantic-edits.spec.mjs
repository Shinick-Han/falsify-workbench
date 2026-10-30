import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReferencePatch} from '../src/latex-reference-policy.mjs';
import {resolveSourceProposals} from '../src/latex-semantic-edits.mjs';
const make = (source, kind, content) => { const start=source.indexOf('\\'); const end=source.length; const contentStart=source.indexOf('{',start)+1, contentEnd=source.lastIndexOf('}'); return {project:{id:'p',files:[{path:'a.tex',bytes:new TextEncoder().encode(source)}]},node:{id:'n',path:'a.tex',kind,start,end,contentStart,contentEnd,sourceText:source.slice(start),text:content}}; };
test('superscript display and footnote display preserve source and counter operation',()=>{
  let {project,node}=make('Text\\textsuperscript{62}','superscript','62');
  assert.equal(buildReferencePatch(project,node,{after:'63',mode:'display-override'}).afterSource,'\\textsuperscript{63}');
  ({project,node}=make('Text\\footnote{Original note.}','footnote','Original note.'));
  const patch=buildReferencePatch(project,node,{after:'63',mode:'display-override'});
  assert.equal(patch.afterSource,'\\begingroup\\renewcommand{\\thefootnote}{63}\\footnote{Original note.}\\endgroup');
  assert.equal(buildReferencePatch(project,node,{after:'New & note',mode:'content'}).afterSource,'\\footnote{New \\& note}');
});
test('citation content keeps command and rejects unsafe override',()=>{
  const {project,node}=make('Text\\cite{old}','citation','old');
  assert.equal(buildReferencePatch(project,node,{after:'new',mode:'content'}).afterSource,'\\cite{new}');
  assert.equal(buildReferencePatch(project,node,{after:'63',mode:'display-override'}).diagnostics[0].code,'unsupported-display-override');
  node.sourceText='stale'; assert.equal(buildReferencePatch(project,node,{after:'new',mode:'content'}).diagnostics[0].code,'stale-anchor');
});
test('response identity and stale anchors prevent application',()=>{
  const anchor={projectId:'p',nodeId:'n',path:'a.tex',start:4,end:24,kind:'superscript'};
  const project={id:'p'}, node={id:'n',path:'a.tex',start:4,end:24,kind:'superscript'};
  const model={projectId:'p',nodes:[node],locateSourceText:()=>({status:'matched',candidates:[{anchor,before:'62'}]})};
  let r=resolveSourceProposals(project,{id:'response',schema:'falsify.external-batch.v1',items:[{before:'62',after:'63'}]}, {model});
  assert.equal(r.proposals[0].provenance.responseId,'response'); assert.equal(r.proposals[0].kind,'superscript');
  r=resolveSourceProposals(project,{items:[{before:'62',after:'63',anchor:{...anchor,projectId:'old'}}]}, {model}); assert.equal(r.proposals[0].status,'stale-anchor');
  r=resolveSourceProposals(project,{diagnostics:[{code:'file-hash-mismatch'}],items:[{before:'62',after:'63'}]}, {model}); assert.equal(r.proposals[0].enabled,false);
});
test('whole sentence narrows the changed marker without replacing surrounding TeX',()=>{
  const sentence='An initial claim62 remains conditional.', after='An initial claim63 remains conditional.';
  const outer={projectId:'p',nodeId:'sentence',path:'a.tex',start:0,end:60,kind:'text'};
  const marker={projectId:'p',nodeId:'marker',path:'a.tex',start:32,end:33,kind:'superscript'};
  const model={projectId:'p',nodes:[],locateSourceText:(_p,{before})=>before===sentence?{status:'matched',candidates:[{before,anchor:outer}]}:before==='2'?{status:'matched',candidates:[{before,anchor:marker}]}:{status:'missing',candidates:[]}};
  const result=resolveSourceProposals({id:'p'},[{before:sentence,after}],{model});
  assert.equal(result.proposals[0].sourceChanges[0].after,'3');
  assert.equal(result.proposals[0].sourceChanges[0].anchor.kind,'superscript');
});
