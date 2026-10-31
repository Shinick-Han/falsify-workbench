import test from 'node:test';import assert from 'node:assert/strict';import {serializeFlowReconstruction} from '../src/pdf-latex-flow-serialize.mjs';import {inferTypographyProfile} from '../src/paper-typography-profile.mjs';import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {analyzeLatexSource,locateSourceText} from '../src/latex-source-model.mjs';
import {createLatexProject,exportLatexProject,importLatexProject} from '../src/latex-project.mjs';
const hash='a'.repeat(64),ref={sourceSha256:hash,pageIndex:0,frame:'mupdf-display',bbox:[40,40,500,70]};
const item=(id,text,extra={})=>({id,text,kind:'paragraph',status:'observed',evidence:[ref],...extra});
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64'));
const model=items=>({schema:'falsify.pdf-latex-reconstruction.v1',sourceSha256:hash,pages:[{pageIndex:0,width:612,height:792,frame:'mupdf-display'}],items,assets:[],relations:[],diagnostics:[]});
const text=r=>new TextDecoder().decode(r.files[0].bytes);
test('native long paragraph and document profiles preserve actual content and bindings',()=>{const long='Result 63.5 μ 漢 & 20%. '.repeat(1000),m=model([item('p',long),item('q','Another paragraph.'),item('h','Section 1',{kind:'heading'})]),original=structuredClone(m);for(const columns of [1,2]){const p=inferTypographyProfile(m,{page:{columns},body:{sizeBp:10,leadingBp:12}}),r=serializeFlowReconstruction({model:m,profile:p}),s=text(r);assert.deepEqual(m,original);assert.equal(r.engine,'lualatex');assert.equal(s.includes('twocolumn'),columns===2);assert.doesNotMatch(s,/\\newpage|\\begin\{minipage\}|\\fbox/);assert.match(s,/μ 漢 \\& 20\\%/);assert.equal((s.match(/\\fontsize\{10bp\}\{12bp\}/g)||[]).length,2);assert.equal(s.slice(r.bindings[0].start,r.bindings[0].end),long.replaceAll('&','\\&').replaceAll('%','\\%'));assert.ok(r.diagnostics.some(d=>d.code==='UNICODE_GLYPH_COVERAGE_UNVERIFIED'));assert.match(s,/\\Needspace\{4\\baselineskip\}/);}});
test('figure and caption retained; explicit transcription is evidence bound',()=>{const m=model([item('f','',{kind:'figure',assetId:'a'}),item('c','Figure 1: 63%',{reason:'caption-proposal'}),item('x','x2',{reason:'inline-script-candidate'})]);m.assets=[{id:'a',bytes:png,sha256:hex(png),mediaType:'image/png',representation:'image',editable:false,evidence:[ref]}];m.relations=[{kind:'caption',from:'f',to:'c',status:'proposed',evidence:[ref,ref]}];const r=serializeFlowReconstruction({model:m,decisions:[{itemId:'x',sourceSha256:hash,evidence:[ref],tex:'$x^2$'}]}),s=text(r);assert.match(s,/\\includegraphics/);assert.match(s,/Figure 1: 63\\%/);assert.equal(s.slice(r.bindings[2].start,r.bindings[2].end),'$x^2$');assert.equal(r.files.length,2);assert.equal((s.match(/\\Needspace\{5\\baselineskip\}/g)||[]).length,2);assert.throws(()=>serializeFlowReconstruction({model:m,decisions:[{itemId:'x',sourceSha256:'b'.repeat(64),evidence:[ref],tex:'$x^2$'}]}),{code:'INVALID_DECISION'});});

test('emitter relation groups adjacent figure and caption; unknown relations stay separate',()=>{
 const f=item('f','raster label',{kind:'figure',assetId:'a'}),c=item('c','Figure one',{reason:'caption-proposal'}),m=model([f,c,item('p','body')]);
 m.assets=[{id:'a',bytes:png,sha256:hex(png),mediaType:'image/png',representation:'region-raster',editable:false,evidence:[ref]}];
 m.relations=[{kind:'caption',from:'f',to:'c',status:'proposed',evidence:[...f.evidence,...c.evidence]}];
 let r=serializeFlowReconstruction({model:m}),s=text(r);assert.match(s,/\\begin\{figure\}\[htbp\][\s\S]*\\includegraphics[\s\S]*Figure one[\s\S]*\\end\{figure\}/);assert.doesNotMatch(s,/raster label/);assert.ok(r.diagnostics.some(d=>d.code==='RASTER_TEXT_NONEDITABLE'));assert.equal(s.slice(r.bindings[1].start,r.bindings[1].end),'Figure one');
 m.relations=[{kind:'mystery',from:'f',to:'c',status:'proposed'}];r=serializeFlowReconstruction({model:m});assert.doesNotMatch(text(r),/\\begin\{figure\}/);assert.ok(r.diagnostics.some(d=>d.code==='RELATION_REVIEW'));
});
test('oversized image is bounded and long paragraphs remain breakable',()=>{
 const f=item('f','',{kind:'figure',assetId:'a'}),long='long paragraph '.repeat(5000),m=model([f,item('p',long),item('h','Heading',{kind:'heading'}),item('next','Next')]);m.assets=[{id:'a',bytes:png,sha256:hex(png),mediaType:'image/png',representation:'region-raster',editable:false,evidence:[ref]}];const r=serializeFlowReconstruction({model:m}),s=text(r);assert.match(s,/height=\.7\\textheight,keepaspectratio/);assert.doesNotMatch(s,/\\begin\{minipage\}/);assert.equal(s.slice(r.bindings[1].start,r.bindings[1].end),long);assert.match(s,/Heading\\par\}\s*\\nopagebreak\[4\]/);
});

test('content-hashed font paths use a safe named NFSS family, including all style faces',()=>{
 const m=model([item('p','Real font project')]),fontFiles=['regular','bold','italic','bolditalic'].map((style,n)=>({path:style+'.ttf',bytes:Uint8Array.from([0,1,2,n]),role:'serif',style}));
 const r=serializeFlowReconstruction({model:m,fontFiles}),s=text(r);
 assert.match(s,/NFSSFamily=FalsifyBody,Path=fonts\//);assert.match(s,/UprightFont=\{[a-f0-9]{64}\.ttf\}/);assert.match(s,/BoldItalicFont=\{[a-f0-9]{64}\.ttf\}/);assert.match(s,/\]\{FalsifyPublication\}/);assert.equal(r.files.filter(f=>f.path.startsWith('fonts/')).length,4);
});

test('layout commands preserve editable headings, author text and captions in the source editor',()=>{
 const m=model([item('h','A paper title',{kind:'heading'}),item('a','First Author, Second Author'),item('c','Figure 1. Exact result',{reason:'caption-proposal'}),item('p','Body result 63.5 percent.')]);
 const serialized=serializeFlowReconstruction({model:m}),project={id:'p',files:serialized.files};
 const analyzed=analyzeLatexSource(project);assert.deepEqual(analyzed.diagnostics,[]);
 for(const before of ['A paper title','Second Author','Figure 1. Exact result','Body result 63.5 percent.'])assert.equal(locateSourceText(project,{before}).status,'matched',before);
 assert.doesNotMatch(analyzed.documents[0].displayText,/\[4\]|\[5\]/);
 assert.ok(serialized.bindings.every(b=>b.status==='exact-text'));
});

test('flow source ZIP retains its compiler choice on reimport, with explicit choice taking precedence',async()=>{
 const serialized=serializeFlowReconstruction({model:model([item('p','Reopen this source')])}),p=await createLatexProject({...serialized,origin:'original-source'});
 const zip=await exportLatexProject(p),file={name:'source.zip',arrayBuffer:async()=>zip.slice().buffer};
 const reopened=await importLatexProject(file);assert.equal(reopened.engine,'lualatex');assert.equal(reopened.id,p.id);
 assert.equal((await importLatexProject(file,{engine:'pdflatex'})).engine,'pdflatex');
});
