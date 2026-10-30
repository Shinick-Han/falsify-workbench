import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serializeReconstruction} from '../src/pdf-latex-serialize.mjs';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {createLatexProject} from '../src/latex-project.mjs';
import {locateSourceText} from '../src/latex-source-model.mjs';
const hash='a'.repeat(64), enc=new TextEncoder(), dec=new TextDecoder();
const ref=(pageIndex=0)=>({sourceSha256:hash,pageIndex,frame:'mupdf-display',bbox:[1,2,10,12],range:{start:0,end:2}});
const item=(id,text,extra={})=>({id,kind:'paragraph',status:'observed',text,evidence:[ref()],...extra});
const make=(items,extra={})=>({schema:'falsify.pdf-latex-reconstruction.v1',sourceSha256:hash,pages:[{pageIndex:0,width:612,height:792,frame:'mupdf-display',transform:[1,0,0,-1,0,792]}],items,assets:[],diagnostics:[],relations:[],...extra});
const source=r=>dec.decode(r.files[0].bytes);
const image=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64'));
const asset={id:'a',bytes:image,sha256:hex(image),mediaType:'image/png',representation:'region-raster',editable:false,evidence:[ref()]};
test('deterministic editable source, escaped text and exact UTF-16 bindings',()=>{
 const m=make([item('a','A & B #1 $2 {x} 50% _ ^ ~ \\'),item('b','The effect is 63. The effect is not 63.',{kind:'heading'})]);
 const original=structuredClone(m), r=serializeReconstruction({model:m});
 assert.deepEqual(m,original); assert.deepEqual(r,serializeReconstruction({model:m})); assert.equal(r.status,'needs-review');
 const s=source(r); assert.match(s,/The effect is 63\. The effect is not 63\./);
 assert.equal(s.slice(r.bindings[0].start,r.bindings[0].end),'A \\& B \\#1 \\$2 \\{x\\} 50\\% \\_ \\textasciicircum{} \\textasciitilde{} \\textbackslash{}');
});
test('reviewed transcription is evidence-bound and scripts are never guessed',()=>{
 const i=item('math','x2',{reason:'inline-script-candidate'}), m=make([i]);
 assert.equal(serializeReconstruction({model:m}).status,'needs-review');
 const decision={itemId:'math',sourceSha256:hash,tex:'$x^2$',evidence:[ref()]};
 const r=serializeReconstruction({model:m,decisions:[decision]}); assert.equal(r.status,'needs-review'); assert.equal(source(r).slice(r.bindings[0].start,r.bindings[0].end),'$x^2$'); assert.equal(r.bindings[0].status,'reviewed');
 assert.throws(()=>serializeReconstruction({model:m,decisions:[{...decision,sourceSha256:'b'.repeat(64)}]}),{code:'INVALID_DECISION'});
 assert.throws(()=>serializeReconstruction({model:m,decisions:[decision,decision]}),{code:'INVALID_DECISION'});
});
test('region PNG, verified table, missing and Unicode remain visible and reviewable',()=>{
 const table=item('t','',{kind:'table',table:{rows:[[{text:'A',evidence:[ref()]},{text:'2 & 3',evidence:[ref()]}],[{text:'B',evidence:[ref()]},{text:'4',evidence:[ref()]}]]}});
 const m=make([table,item('fig','',{kind:'figure',assetId:'a'}),item('unicode','naïve'),item('missing','',{kind:'unknown'})],{assets:[asset]});
 const r=serializeReconstruction({model:m}); assert.equal(r.status,'unsupported'); assert.match(source(r),/\\begin\{tabular\}\{ll\}/); assert.match(source(r),/naïve/); assert.ok(r.diagnostics.some(d=>d.code==='UNICODE_RENDER_REVIEW')); assert.match(source(r),/Content missing/); assert.equal(r.bindings.find(b=>b.itemId==='fig').status,'noneditable'); assert.deepEqual(r.files[1].bytes,image);
 const invalid=structuredClone(m); invalid.assets[0].bytes[9]^=1; assert.throws(()=>serializeReconstruction({model:invalid}),{code:'INVALID_ASSET'});
 const merged=structuredClone(table); merged.table.rows[0][0].colSpan=2; assert.notEqual(serializeReconstruction({model:make([merged])}).status,'ready');
});
test('reject stale evidence, cross-page items, invalid geometry and engine',()=>{
 const two=make([item('x','a',{evidence:[ref(),ref(1)]})],{pages:[...make([]).pages,{pageIndex:1,width:612,height:792,frame:'mupdf-display',transform:[1,0,0,-1,0,792]}]});
 assert.throws(()=>serializeReconstruction({model:two}),{code:'INVALID_ITEM'});
 const bad=make([item('x','x',{evidence:[{...ref(),sourceSha256:'b'.repeat(64)}]})]); assert.throws(()=>serializeReconstruction({model:bad}),{code:'INVALID_ITEM'});
 assert.throws(()=>serializeReconstruction({model:make([]),engine:'xelatex'}),{code:'UNSUPPORTED_ENGINE'});
});
test('page order, missing assets, unresolved relations and Unicode are explicit',()=>{
 const pages=[...make([]).pages,{pageIndex:1,width:500,height:700,frame:'mupdf-display',transform:[1,0,0,-1,0,700]}];
 const m=make([item('second','Second',{evidence:[ref(1)]}),item('first','First')],{pages,relations:[{status:'unresolved'}]});
 const r=serializeReconstruction({model:m}); assert.equal(r.status,'needs-review'); assert.ok(r.diagnostics.some(d=>d.code==='PAGE_ORDER_REVIEW')); assert.ok(r.diagnostics.some(d=>d.code==='RELATION_REVIEW')); assert.match(source(r),/\\newpage/); assert.ok(source(r).indexOf('First')<source(r).indexOf('Second'));
 assert.throws(()=>serializeReconstruction({model:make([item('f','',{kind:'figure',assetId:'missing'})])}),{code:'INVALID_ASSET_REFERENCE'});
 const unicode=serializeReconstruction({model:make([item('u','naïve')])}); assert.equal(unicode.status,'needs-review'); assert.match(source(unicode),/naïve/); assert.equal(unicode.bindings[0].status,'review-required');
});
test('source geometry uses bp, bounded regions, and observed font only with complete evidence',async()=>{
 const small={...asset,evidence:[{...ref(),bbox:[20,30,32,42]}]};
 const text='Observed body'; const styled=item('p',text,{extensions:{columns:1,styles:[{id:'style1',size:9.5}],segments:[{text,styleIds:['style1']}]}});
 const result=serializeReconstruction({model:make([styled,item('f','',{kind:'figure',assetId:'a'})],{assets:[small]})}); const tex=source(result);
 assert.match(tex,/\\pdfpagewidth=612bp\\pdfpageheight=792bp/);
 assert.match(tex,/\\includegraphics\[width=12bp,height=12bp,keepaspectratio\]/);
 assert.match(tex,/\\fontsize\{9\.5bp\}\{11\.4bp\}\\selectfont/);
 const project=await createLatexProject({files:result.files,mainFile:result.mainFile}); assert.equal(locateSourceText(project,{before:text}).status,'matched');
 assert.ok(result.diagnostics.some(d=>d.code==='LEADING_UNVERIFIED')); assert.ok(result.diagnostics.some(d=>d.code==='LAYOUT_OVERFLOW_UNVERIFIED'));
 const large={...small,evidence:[{...ref(),bbox:[0,0,1000,500]}]}; const bounded=serializeReconstruction({model:make([item('f','',{kind:'figure',assetId:'a'})],{assets:[large]})});
 assert.match(source(bounded),/width=540bp,height=270bp/); assert.ok(bounded.diagnostics.some(d=>d.code==='REGION_SCALED_DOWN'));
 const column=structuredClone(styled); column.extensions.columns=2; const r=serializeReconstruction({model:make([column])}); assert.doesNotMatch(source(r),/\\fontsize/); assert.ok(r.diagnostics.some(d=>d.code==='MULTICOLUMN_REVIEW'));
});
test('small image and multi-page text retain measured physical geometry',t=>{
 const probe=spawnSync('pdflatex',['--version'],{encoding:'utf8'}); if(probe.error?.code==='ENOENT'){t.skip('pdflatex not installed');return;}
 const check=spawnSync('python',['-c','import pymupdf'],{encoding:'utf8'}); if(check.status!==0){t.skip('PyMuPDF not installed for geometry inspection');return;}
 const pages=[...make([]).pages,{pageIndex:1,width:500,height:700,frame:'mupdf-display',transform:[1,0,0,-1,0,700]}];
 const small={...asset,evidence:[{...ref(1),bbox:[20,30,32,42]}]};
 const r=serializeReconstruction({model:make([item('long','A sentence with numbers 63 and 64. '.repeat(20)),item('fig','',{kind:'figure',assetId:'a',evidence:[ref(1)]})],{pages,assets:[small]})});
 const dir=mkdtempSync(join(tmpdir(),'falsify-geometry-')); try {for(const f of r.files){const p=join(dir,...f.path.split('/'));mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,f.bytes);} const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000});assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
 const py=spawnSync('python',['-c',"import pymupdf,json; d=pymupdf.open('main.pdf'); print(json.dumps({'pages':[[p.rect.width,p.rect.height] for p in d], 'images':[[list(r) for im in p.get_images() for r in p.get_image_rects(im)] for p in d]}))"],{cwd:dir,encoding:'utf8'}); assert.equal(py.status,0,py.stderr); const data=JSON.parse(py.stdout); assert.deepEqual(data.pages,[[612,792],[500,700]]); assert.equal(data.images[1].length,1); const box=data.images[1][0]; assert.ok(Math.abs(box[2]-box[0]-12)<.1 && Math.abs(box[3]-box[1]-12)<.1,JSON.stringify(box));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('mapped Unicode remains editable and unknown glyphs remain reviewable',async()=>{
 const text='Measurement (−3 ± μ µ β × ∞ 9°) naïve ﬀ – ‘x’';
 const r=serializeReconstruction({model:make([item('unicode',text),item('unknown','unknown 漢')])});
 assert.match(source(r),/Measurement \(−3 ± μ µ β × ∞ 9°\) naïve ﬀ – ‘x’/); assert.match(source(r),/U\+6F22/);
 assert.equal(r.bindings[0].status,'review-required'); assert.equal(r.bindings[1].status,'review-required');
 assert.ok(r.diagnostics.some(d=>d.code==='UNICODE_RENDER_REVIEW')); assert.ok(r.diagnostics.some(d=>d.code==='UNICODE_REVIEW'));
 const project=await createLatexProject({files:r.files,mainFile:r.mainFile}); assert.equal(locateSourceText(project,{before:text}).status,'matched');
});
test('pdflatex and MuPDF retain representative mapped glyphs without codepoint boxes',t=>{
 const probe=spawnSync('pdflatex',['--version'],{encoding:'utf8'}); if(probe.error?.code==='ENOENT'){t.skip('pdflatex not installed');return;}
 const check=spawnSync('python',['-c','import pymupdf'],{encoding:'utf8'}); if(check.status!==0){t.skip('PyMuPDF not installed');return;}
 const text='Measurement (−3 ± μ µ β × ∞ 9°) naïve ﬀ – ‘x’'; const result=serializeReconstruction({model:make([item('unicode',text)])});
 const dir=mkdtempSync(join(tmpdir(),'falsify-unicode-'));try{writeFileSync(join(dir,'main.tex'),result.files[0].bytes); const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000});assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
 const py=spawnSync('python',['-c',"import pymupdf,json; d=pymupdf.open('main.pdf'); chars=[c for b in d[0].get_text('rawdict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans'] for c in s['chars']]; print(json.dumps({'text':d[0].get_text(), 'glyphs':len(chars), 'visible':[c['c'] for c in chars if c['bbox'][2]>c['bbox'][0] and c['bbox'][3]>c['bbox'][1]]},ensure_ascii=True))"],{cwd:dir,encoding:'utf8'});assert.equal(py.status,0,py.stderr);const observed=JSON.parse(py.stdout);assert.ok(observed.glyphs>15);for(const glyph of ['−','±','µ','β','×','∞','°','(',')'])assert.ok(observed.text.includes(glyph),JSON.stringify({glyph,observed:observed.text}));for(const glyph of ['−','±','µ','β','×','∞','°','(',')']) assert.ok(observed.visible.includes(glyph)); assert.equal((observed.text.match(/µ/g)||[]).length,2); assert.match(observed.text,/ff/); assert.doesNotMatch(observed.text,/U\+[0-9A-F]/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('emitted source compiles with local pdflatex when available',t=>{
 const probe=spawnSync('pdflatex',['--version'],{encoding:'utf8'}); if(probe.error?.code==='ENOENT'){t.skip('pdflatex not installed');return;}
 const table=item('t','',{kind:'table',table:{rows:[[{text:'A',evidence:[ref()]},{text:'2',evidence:[ref()]}]]}});
 const r=serializeReconstruction({model:make([item('p','A & B 63%.'),table,item('fig','',{kind:'figure',assetId:'a'})],{assets:[asset]})});
 const dir=mkdtempSync(join(tmpdir(),'falsify-latex-')); try { for(const f of r.files){const p=join(dir,...f.path.split('/')); mkdirSync(join(p,'..'),{recursive:true}); writeFileSync(p,f.bytes);} const run=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','main.tex'],{cwd:dir,encoding:'utf8',env:{...process.env,MIKTEX_ENABLEINSTALLER:'0'},timeout:60000}); assert.equal(run.status,0,run.stdout+'\n'+run.stderr); assert.ok(readFileSync(join(dir,'main.pdf')).length>0); const extracted=spawnSync('pdftotext',['-layout','main.pdf','-'],{cwd:dir,encoding:'utf8'}); if (!extracted.error) {assert.equal(extracted.status,0); assert.match(extracted.stdout,/A & B 63%/); assert.match(extracted.stdout,/A\s+2/);} } finally {rmSync(dir,{recursive:true,force:true});}
});
