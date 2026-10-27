import test from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from 'mupdf';
import {readDocument} from '../src/paper-document.mjs';
import {readSourceAssets} from '../src/paper-source-assets.mjs';

function fixture() {
  const doc=new mupdf.PDFDocument();
  const page=doc.addPage([0,0,200,300],90,{},'0 0 0 RG 2 w 30 40 80 70 re S 30 40 m 110 110 l S\n');
  doc.insertPage(0,page);
  const p=doc.loadPage(0); p.setPageBox('CropBox',[10,20,180,280]); p.destroy();
  const buffer=doc.saveToBuffer(''); const bytes=buffer.asUint8Array().slice(); buffer.destroy(); doc.destroy(); return bytes;
}
test('crop follows rotated display coordinates and preserves source bytes', async()=>{
  const bytes=fixture(), original=bytes.slice(), document=await readDocument({file:bytes});
  const region={id:'plot',pageIndex:0,bbox:[40,20,140,120],blockIds:[]};
  const result=await readSourceAssets({bytes,document,regions:[region]});
  assert.deepEqual(bytes,original);
  const asset=result.assets.find(a=>a.id==='plot'); assert.equal(asset.content.representation,'mupdf-cropped-svg');
  const svg=new TextDecoder().decode(asset.content.bytes);
  assert.match(svg, /<svg\b/); assert.match(svg, /width="100" height="100"/); assert.match(svg, /<path\b/);
  const source=mupdf.Document.openDocument(bytes,'application/pdf').asPDF(), p=source.loadPage(0);
  const croppedDoc=new mupdf.PDFDocument(); croppedDoc.graftPage(0,source,0); const crop=croppedDoc.loadPage(0);
  crop.setPageBox('CropBox',region.bbox); const saved=croppedDoc.saveToBuffer('');
  const reread=mupdf.Document.openDocument(saved.asUint8Array().slice(),'application/pdf').asPDF(), page=reread.loadPage(0);
  assert.deepEqual(page.getBounds(),[0,0,100,100]);
  const full=p.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false,false);
  const cropped=page.toPixmap(mupdf.Matrix.identity,mupdf.ColorSpace.DeviceRGB,false,false);
  const a=full.getPixels(), b=cropped.getPixels(), stride=full.getStride(), n=full.getNumberOfComponents();
  let diff=0; for(let y=0;y<100;y++) for(let x=0;x<100;x++) for(let c=0;c<n;c++) diff+=Math.abs(b[(y*100+x)*n+c]-a[(y+20)*stride+(x+40)*n+c]); assert.ok(diff/(100*100*n)<1, String(diff/(100*100*n)));
  cropped.destroy(); full.destroy(); page.destroy(); reread.destroy(); saved.destroy(); crop.destroy(); croppedDoc.destroy(); p.destroy(); source.destroy();
});
test('rejects stale source',async()=>{const bytes=fixture(); await assert.rejects(readSourceAssets({bytes,document:{sourceSha256:'bad'}}),/hash mismatch/);});





test('extracts embedded resource bytes with page-scoped identity and measured glyph coverage', async()=>{
  const d=new mupdf.PDFDocument(), font=new mupdf.Font('Helvetica'), ref=d.addFont(font);
  const p=d.addPage([0,0,200,200],0,{Font:{F1:ref}},'BT /F1 14 Tf 20 50 Td (Plot) Tj ET'); d.insertPage(0,p);
  const buffer=d.saveToBuffer(''); const bytes=buffer.asUint8Array().slice(); buffer.destroy(); d.destroy(); font.destroy();
  const document=await readDocument({file:bytes}); const result=await readSourceAssets({bytes,document});
  assert.equal(result.fonts.length,1); const extracted=result.fonts[0];
  assert.equal(extracted.source.resourcePath,'Resources/Font/F1'); assert.ok(extracted.source.objectNumber>0); assert.ok(extracted.bytes.length>100); assert.equal(extracted.embedded,true);
  const {createFontPlan}=await import('../src/paper-fonts.mjs');
  const plan=await createFontPlan({text:'Plot',fonts:[{id:extracted.id,family:extracted.family,bytes:extracted.bytes}]},{mupdf});
  assert.equal(plan.candidates[0].coverage.status,'covered');
});
