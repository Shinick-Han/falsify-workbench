import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as mupdf from 'mupdf';
import {createBrowserFontStore} from '../src/browser-fonts.mjs';
import {scanTextShows} from '../src/paragraph-pdf-content-operators.mjs';
import {trySourceMarkerEdits} from '../src/paragraph-pdf-marker-path.mjs';
const bytes=new Uint8Array(await readFile(new URL('./fixtures/paragraph-marker-synthetic.pdf',import.meta.url)));
const font=await readFile(new URL('./fixtures/LMRoman7-Regular.otf',import.meta.url));
const store=createBrowserFontStore();await store.addFiles([new File([font],'LMRoman7-Regular.otf')]);const fontSnapshot=await store.resolve([{family:'LM Roman 7'}]);
const run=edits=>trySourceMarkerEdits({bytes,edits,fontSnapshot},{mupdf,scanTextShows});
test('full sentence source marker produces localized raster proof',async()=>{const result=await run([{id:'a',pageIndex:0,before:'An initial claim62 remains conditional.',after:'An initial claim63 remains conditional.'}]);assert.ok(result);assert.equal(result.reports[0].changedPixels,58);});
test('unsupported multiple changes never returns a partial result',async()=>{assert.equal(await run([{pageIndex:0,before:'62',after:'63'},{pageIndex:0,before:'An initial claim62 remains conditional.',after:'An initial claim64 remains conditional.'}]),null);assert.equal(await run([{pageIndex:0,before:'62',after:'73'}]),null);});
test('repeated quotes reject and leave no output',async()=>{
 const d=new mupdf.PDFDocument(bytes);let doubled;try{const p=d.findPage(0),c=p.get('Contents'),a=d.newArray();if(c.isArray())c.forEach(v=>a.push(v));else a.push(c);if(c.isArray())c.forEach(v=>a.push(v));else a.push(c);p.put('Contents',a);const b=d.saveToBuffer();try{doubled=b.asUint8Array().slice();}finally{b.destroy();}}finally{d.destroy();}
 assert.equal(await trySourceMarkerEdits({bytes:doubled,edits:[{pageIndex:0,before:'62',after:'63'}],fontSnapshot},{mupdf,scanTextShows}),null);
});
test('shared resources and other page annotations and content stay unchanged',async()=>{
 const d=new mupdf.PDFDocument(bytes);let input;try{const p=d.findPage(0),resources=p.getInheritable('Resources');d.insertPage(-1,d.addPage([0,0,400,500],0,resources,'q 1 0 0 rg 10 10 20 20 re f Q'));d.findPage(1).put('Annots',[d.addObject({Type:'Annot',Subtype:'Text',Rect:[10,10,30,30],Contents:d.newString('preserved')})]);const b=d.saveToBuffer();try{input=b.asUint8Array().slice();}finally{b.destroy();}}finally{d.destroy();}
 const result=await trySourceMarkerEdits({bytes:input,edits:[{pageIndex:0,before:'An initial claim62 remains conditional.',after:'An initial claim63 remains conditional.'}],fontSnapshot},{mupdf,scanTextShows});assert.ok(result);
 const a=new mupdf.PDFDocument(input),b=new mupdf.PDFDocument(result.bytes);try{const x=a.findPage(1),y=b.findPage(1);const xs=x.get('Contents').readStream(),ys=y.get('Contents').readStream();try{assert.deepEqual(xs.asUint8Array(),ys.asUint8Array());}finally{xs.destroy();ys.destroy();}assert.equal(y.get('Annots',0,'Contents').asString(),x.get('Annots',0,'Contents').asString());assert.equal(y.get('Resources','Font').toString(),x.get('Resources','Font').toString());}finally{a.destroy();b.destroy();}
});

/* Affiliation symbols and a Times footnote number on the Ragas paper (arXiv 2309.15217, CC BY 4.0): each becomes a digit
   in place, drawn in Liberation Serif at the marker's own size and origin. Needs FALSIFY_BOOTH_MISSION_PDF. */
const missionPath=process.env.FALSIFY_BOOTH_MISSION_PDF||'';
test('superscript symbols and a raised Times footnote number change in place',{skip:!missionPath&&'FALSIFY_BOOTH_MISSION_PDF is not set'},async()=>{
 const mission=new Uint8Array(await readFile(missionPath));
 const serif=createBrowserFontStore();await serif.addFiles([new File([await readFile(new URL('../dist/font-assets/LiberationSerif-Regular.ttf',import.meta.url))],'LiberationSerif-Regular.ttf')]);
 const snapshot=await serif.resolve([{family:'Liberation Serif'}]);
 const one=edit=>trySourceMarkerEdits({bytes:mission,edits:[{id:'m',pageIndex:0,...edit}],fontSnapshot:snapshot},{mupdf,scanTextShows});
 for(const edit of [{before:'Shahul Es†',after:'Shahul Es1'},{before:'Anke∗♢,',after:'Anke∗3,'},{before:'Anke∗♢,',after:'Anke2♢,'},{before:'∗CardiffNLP,',after:'2CardiffNLP,'},{before:'Ragas1',after:'Ragas 2'}]){
  const result=await one(edit);
  assert.ok(result,JSON.stringify(edit));
  assert.equal(result.reports[0].font,'LiberationSerif');
  assert.ok(result.reports[0].changedPixels>0);
  /* No gap reads as a space: the extracted line holds the edit as typed ("Anke∗3,", not "Anke∗3 ,"). */
  const doc=new mupdf.PDFDocument(result.bytes),page=doc.loadPage(0);
  try{const words=page.toStructuredText('preserve-whitespace').asText().replace(/\s+/g,' ');if(edit.before==='Anke∗♢,'||edit.before==='Shahul Es†')assert.ok(words.includes(edit.after),edit.after);}finally{page.destroy();doc.destroy();}
 }
 assert.equal(await one({before:'With Ragas, we',after:'With Rbgas, we'}),null,'body text is not a marker');
});
