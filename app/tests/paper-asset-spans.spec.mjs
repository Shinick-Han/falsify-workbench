import test from 'node:test';
import assert from 'node:assert/strict';
import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
import {resolveOutputAssetSpans as resolve} from '../src/paper-asset-spans.mjs';
function pdf(content,rotation=0) {
 const d=new mupdf.PDFDocument(), pix=new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,[0,0,2,2],false), image=new mupdf.Image(pix);
 try {const ref=d.addImage(image);d.insertPage(-1,d.addPage([0,0,300,400],rotation,{XObject:{im:ref}},content));const b=d.saveToBuffer();try{return b.asUint8Array().slice();}finally{b.destroy();}} finally {image.destroy();pix.destroy();d.destroy();}
}
const placement='q 100 0 0 50 20 250 cm /im Do Q';
const flow={items:[{kind:'asset',renderAssetId:'capture',assetIds:['original'],source:{pageIndex:0,bbox:[2,3,202,103]}}]};
const marker={id:'capture',sourcePage:0,start:{page:1,x:20,y:100},end:{page:1,x:20,y:150}};
const run=(content=placement, f=flow, m=[marker])=>resolve({bytes:pdf(content),mupdf,flow:f,blockSpans:m});
test('unique actual image placement with source-bound aliases',()=>{const r=run();assert.deepEqual(r.spans,[{id:'capture',pageIndex:0,bbox:[20,100,120,150]},{id:'original',pageIndex:0,bbox:[20,100,120,150]}]);assert.equal(r.evidence[0].reason,'resolved');});
test('ambiguous duplicate occurrences are unavailable',()=>{assert.equal(run(placement+' '+placement).evidence[0].reason,'ambiguous-placement');});
test('offset marker, wrong aspect and stale IDs remain unavailable',()=>{assert.equal(run(placement,flow,[{...marker,start:{...marker.start,x:40},end:{...marker.end,x:40}}]).spans.length,0);assert.equal(run(placement,{items:[{...flow.items[0],source:{pageIndex:0,bbox:[0,0,10,100]}}]}).spans.length,0);assert.equal(run(placement,flow,[{...marker,id:'stale'}]).spans.length,0);});
test('cross page, missing end, vector and rotated placement are unavailable',()=>{assert.equal(run(placement,flow,[{...marker,end:{...marker.end,page:2}}]).spans.length,0);assert.equal(run(placement,flow,[{...marker,end:null}]).spans.length,0);assert.equal(run('20 250 100 50 re f').spans.length,0);assert.equal(run('q 0 100 -50 0 120 250 cm /im Do Q').spans.length,0);});
test('same image resource repeated elsewhere only selects nominated occurrence',()=>{assert.deepEqual(run(placement+' q 100 0 0 50 160 250 cm /im Do Q').spans[0].bbox,[20,100,120,150]);});
test('shared source ownership, clipping and wrong scale fail closed',()=>{assert.equal(run(placement,{items:[flow.items[0],{...flow.items[0],renderAssetId:'other'}]}).spans.length,0);assert.equal(run('q 20 260 50 40 re W n '+placement+' Q').spans.length,0);assert.equal(run('q 100 0 0 60 20 240 cm /im Do Q').spans.length,0);});

test('overlapping panel image is not mistaken for a unique capture',()=>{const r=run(placement+' q 30 0 0 20 40 260 cm /im Do Q');assert.equal(r.evidence[0].reason,'overlapping-placement');assert.deepEqual(r.spans,[]);});
