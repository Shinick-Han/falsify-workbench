import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,copyFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {createHash} from 'node:crypto';
import {createAnnotationTransport} from '../src/document-flow-annotations.mjs';

const app=resolve('app'),temp=mkdtempSync(join(tmpdir(),'paragraph-links-'));
mkdirSync(join(temp,'paragraph-vendor'));
for(const f of ['editcore.js','editcore.wasm'])copyFileSync(join(app,'src/paragraph-vendor/runtime',f),join(temp,'paragraph-vendor',f));
copyFileSync(join(app,'dist/paragraph-vendor/package.json'),join(temp,'paragraph-vendor/package.json'));
const plugin={name:'adapt',setup(b){
  b.onResolve({filter:/^\.\/browser-pdf-vendor\/mupdf\.js$/},()=>({path:pathToFileURL(join(app,'dist/browser-pdf-vendor/mupdf.js')).href,external:true}));
  b.onResolve({filter:/^node:crypto$/},()=>({path:join(app,'src/paragraph-pdf-crypto.mjs')}));
  b.onResolve({filter:/^\.\/runtime\.mjs$/},a=>a.importer.replaceAll('\\','/').endsWith('paragraph-vendor/editor.mjs')?({path:join(app,'src/paragraph-pdf-runtime.mjs')}):undefined);
  b.onResolve({filter:/^\.\/engine-loader\.js$/},()=>({path:join(app,'src/paragraph-pdf-engine-loader.mjs')}));
  b.onResolve({filter:/freetext-script$/},()=>({path:join(app,'src/paragraph-vendor/utils/freetext-script.ts')}));
}};
await build({entryPoints:[join(app,'src/paragraph-pdf.mjs')],outfile:join(temp,'candidate.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',plugins:[plugin]});
const {prepare}=await import(pathToFileURL(join(temp,'candidate.mjs')).href);
globalThis.fetch=async input=>new Response(readFileSync(new URL(input)));
function fixture(widget=false,wide=false,duplicate=false,wrapped=false){
 const d=new mupdf.PDFDocument();try{
  const font=d.addSimpleFont(new mupdf.Font('Times-Roman'));
  const text='BT /F1 11 Tf 40 700 Td (An initial claim includes supporting REFERENCE.) Tj ET BT /F1 11 Tf 40 686 Td (All measurement conditions remain explicitly stated.) Tj ET BT /F1 11 Tf 40 672 Td (The remaining evidence stays available for review.) Tj ET BT /F1 11 Tf 40 560 Td (Following paragraph remains separate and readable.) Tj ET BT /F1 11 Tf 350 700 Td (The right column is independent.) Tj ET BT /F1 11 Tf 350 686 Td (Its contents and positions should remain unchanged.) Tj ET BT /F1 11 Tf 350 672 Td (No change is requested in this column.) Tj ET';
  d.insertPage(-1,d.addPage([0,0,640,800],0,{Font:{F1:font}},(wrapped?text.replace('REFERENCE.','REF').replace('(All measurement conditions remain explicitly stated.)','(All measurement conditions)')+' BT /F1 11 Tf 201 686 Td (ERENCE) Tj ET':text)+(duplicate?' BT /F1 11 Tf 350 650 Td (REFERENCE) Tj ET':'')));
  d.insertPage(-1,d.addPage([0,0,640,800],0,{Font:{F1:font}},'BT /F1 11 Tf 40 700 Td (Unchanged page.) Tj ET'));
  const page=d.findPage(0),annots=[d.addObject({Type:'Annot',Subtype:'Link',Rect:wrapped?[200,683,264,711]:wide?[145,697,263.982,711]:[201.029,697,263.982,711],A:{S:'URI',URI:d.newString('https://example.invalid/reference')}})];
  if(widget)annots.push(d.addObject({Type:'Annot',Subtype:'Text',Rect:[400,400,420,420],Contents:d.newString('keep')}));
  page.put('Annots',annots);const b=d.saveToBuffer();try{return b.asUint8Array().slice();}finally{b.destroy();}
 }finally{d.destroy();}
}
const edit={id:'link',pageIndex:0,before:'An initial claim',after:'An expanded explanation of the measured outcome and its interpretation under the experimental conditions'};
test('ordinary expansion moves a raw URI link and validates saved geometry',async()=>{
 const src=fixture(), result=await prepare({file:src,edits:[edit]}),pdf=new Uint8Array(await result.file.arrayBuffer());
 assert.equal(result.verification.report.paragraphLinkMoves.length,1,JSON.stringify(result.verification.report.selfCheck.failures));
 const a=new mupdf.PDFDocument(src),b=new mupdf.PDFDocument(pdf);try{
  const old=a.findPage(0).get('Annots',0),link=b.findPage(0).get('Annots',0);
  assert.equal(link.get('A','URI').asString(),old.get('A','URI').asString());
  assert.notEqual(link.get('Rect',1).asNumber(),old.get('Rect',1).asNumber());
  const page=b.loadPage(0),hits=page.search('REFERENCE');
  try {const q=hits[0][0],r=Array.from({length:4},(_,i)=>link.get('Rect',i).asNumber());
    assert.ok(Math.min(r[2],q[2])-Math.max(r[0],q[0])>0);
    assert.ok(Math.min(800-r[1],q[7])-Math.max(800-r[3],q[1])>0);
  } finally {page.destroy();}
  assert.equal(b.countPages(),2);
  const pa=a.loadPage(1),pb=b.loadPage(1),ra=pa.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false),rb=pb.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false);
  try {assert.deepEqual(ra.getPixels(),rb.getPixels());} finally {ra.destroy();rb.destroy();pa.destroy();pb.destroy();}
 }finally{a.destroy();b.destroy();}
});
test('link moves while the complete comment dictionary remains bound',async()=>{
 const src=fixture(true),result=await prepare({file:src,edits:[edit]}),report=result.verification.report,pdf=new Uint8Array(await result.file.arrayBuffer());
 assert.equal(report.paragraphLinkMoves.length,1,JSON.stringify(report.selfCheck.failures));
 const api=createAnnotationTransport({mupdf}),model=await api.inspect({sourceBytes:src,sourceSha256:createHash('sha256').update(src).digest('hex')});
 const request={model,sourceBytes:src,outputBytes:pdf,sourcePageMap:[0,1].map(i=>({sourcePageIndex:i,outputPageIndex:i})),moves:report.paragraphLinkMoves,reflowedSourcePages:[0],preserveUnmovedUnsupported:true};
 assert.equal((await api.validate(request)).ok,true);
 assert.equal((await api.validate({...request,preserveUnmovedUnsupported:false})).code,'annotation-subtype-unsupported');
 assert.equal((await api.validate({...request,moves:[{...report.paragraphLinkMoves[0],annotationIndex:1}]})).code,'annotation-move-invalid');
 assert.equal((await api.validate({...request,model:{...model}})).code,'annotation-model-unverified');
 const a=new mupdf.PDFDocument(src),b=new mupdf.PDFDocument(pdf);try{
  const old=a.findPage(0).get('Annots',0),link=b.findPage(0).get('Annots',0),comment=b.findPage(0).get('Annots',1);
  assert.equal(link.get('A','URI').asString(),old.get('A','URI').asString());
  assert.notEqual(link.get('Rect',1).asNumber(),old.get('Rect',1).asNumber());
  assert.equal(comment.get('Contents').asString(),'keep');
  const pa=a.loadPage(0),pb=b.loadPage(0),ra=pa.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false),rb=pb.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false);
  try {const x=ra.getPixels(),y=rb.getPixels(),stride=ra.getWidth()*ra.getNumberOfComponents();for(let row=0;row<ra.getHeight();row++)assert.deepEqual(x.slice(row*stride+320*3,(row+1)*stride),y.slice(row*stride+320*3,(row+1)*stride));} finally {ra.destroy();rb.destroy();pa.destroy();pb.destroy();}
 }finally{a.destroy();b.destroy();}
 for(const change of [d=>d.findPage(0).get('Annots',1).put('Contents',d.newString('changed')),d=>d.findPage(0).get('Annots').delete(1),d=>d.findPage(0).get('Annots').push(d.addObject({Type:'Annot',Subtype:'Text',Rect:[1,1,2,2]}))]){
  const d=new mupdf.PDFDocument(pdf);let bad;try{change(d);const buf=d.saveToBuffer();try{bad=buf.asUint8Array().slice();}finally{buf.destroy();}}finally{d.destroy();}
  assert.equal((await api.validate({...request,outputBytes:bad})).ok,false);
 }
});

test('a wrapped link with non-rigid mapping is explicitly unverified',async()=>{
 const result=await prepare({file:fixture(false,false,false,true),edits:[edit]});
 assert.equal(result.verification.report.paragraphLinkMoves.length,0);
 assert.ok(result.verification.report.selfCheck.failures.some(f=>f.code==='paragraph_link_unverified'&&f.reason==='document_flow_link_not_rigid_translation'));
});


test('an edited link label is explicitly unverified in the saved draft',async()=>{
 const result=await prepare({file:fixture(),edits:[{id:'label',pageIndex:0,before:'REFERENCE',after:'A different linked label'}]});
 assert.ok(result.verification.report.selfCheck.failures.some(f=>f.code==='paragraph_link_unverified'));
 assert.ok((await result.file.arrayBuffer()).byteLength>0);
});

test('duplicate labels do not redirect the source-owned link to the other column',async()=>{
 const result=await prepare({file:fixture(false,false,true),edits:[edit]});
 const report=result.verification.report;
 assert.equal(report.paragraphLinkMoves.length,1,JSON.stringify(report.selfCheck.failures));
 assert.ok(report.paragraphLinkMoves[0].dx<0);
});