import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {inspectLayoutQuality} from '../src/paper-layout-quality.mjs';

function fixture({overlap=false,outside=false,small=false,separated=false,clip=false}={}) {
  const d=new mupdf.PDFDocument(), font=d.addSimpleFont(new mupdf.Font('Helvetica'));
  const pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],true);pix.clear(128);
  const image=new mupdf.Image(pix), im=d.addImage(image);
  const line=(text,x,y,size=12)=>`BT /F ${size} Tf ${x} ${y} Td (${text}) Tj ET\n`;
  let stream='q 100 0 0 80 80 200 cm /Im Do Q\n';
  stream+=line('Figure label',100,240,10);
  stream+=line('Figure 1. A useful illustration',80,separated?90:180,10);
  stream+=line('This is normal body text with enough characters.',30,140,small?6:12);
  if(overlap) stream+=line('Another overlapping sentence',65,140,12);
  if(outside) stream+=line('Outside',-10,320);
  if(clip) stream+='q 30 310 12 20 re W n '+line('Clipped text',30,315)+'Q\n';
  d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font},XObject:{Im:im}},stream));
  const buf=d.saveToBuffer(),bytes=buf.asUint8Array().slice();buf.destroy();image.destroy();pix.destroy();d.destroy();return bytes;
}
const profile={bodyFontSize:12,captions:[{text:'Figure 1. A useful illustration',assetPageIndex:0,assetBbox:[80,120,180,200]}]};
test('real output PDF reports localized defects and a corrected candidate improves score',()=>{
  const bad=inspectLayoutQuality({bytes:fixture({overlap:true,outside:true,small:true,separated:true}),mupdf,profile});
  const good=inspectLayoutQuality({bytes:fixture(),mupdf,profile});
  assert.equal(bad.status,'partial',JSON.stringify(bad));
  for(const type of ['text-overlap','ink-outside-page','small-body-text','caption-separated']) assert.ok(bad.issues.some(i=>i.type===type),`${type}: ${JSON.stringify(bad)}`);
  assert.ok(good.score>bad.score);
  assert.ok(!good.issues.some(i=>['text-image-overlap','small-body-text','caption-separated'].includes(i.type)),JSON.stringify(good));
  assert.ok(bad.issues.every(i=>i.pageIndex===0 && i.bbox.length===4 && i.penalty>0));
});
test('missing engine and unmatched caption never claim verification',()=>{
  assert.equal(inspectLayoutQuality({bytes:fixture()}).status,'unavailable');
  const r=inspectLayoutQuality({bytes:fixture(),mupdf,profile:{captions:[{text:'Invented caption',assetPageIndex:0,assetBbox:[80,120,180,200]}]}});
  assert.ok(r.limitations.some(x=>x.includes('could not be uniquely observed')));
  assert.equal(r.coverage.clipping,'unverified');
});
test('profiled headings and columns report observable orphan and empty column candidates',()=>{
  const r=inspectLayoutQuality({bytes:fixture(),mupdf,profile:{headings:[{text:'This is normal body text with enough characters.'}],columns:[{pageIndex:0,bbox:[220,20,290,80]}]}});
  assert.ok(r.issues.some(i=>i.type==='heading-orphan'));
  assert.ok(r.issues.some(i=>i.type==='blank-column'));
});


test('a real clipped paint operation is explicitly unverified',()=>{
  const r=inspectLayoutQuality({bytes:fixture({clip:true}),mupdf});
  assert.equal(r.coverage.clipping,'unverified');
  assert.ok(r.limitations.some(x=>x.includes('Clip paths')));
});
