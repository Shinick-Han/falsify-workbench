import test from 'node:test';
import assert from 'node:assert/strict';
import {ruledTableRegions,inRuledTable} from '../src/paragraph-vendor/continuation-template.mjs';

function engine({missingRule=false,tooFewCells=false,dashed=false}={}) {
 const paths=[...[0,20,40].map(y=>[[0,y],[40,y]]),...[0,20,40].filter(x=>!missingRule||x!==20).map(x=>[[x,0],[x,40]])];
 const cells=[[2,2,8,8],[22,2,28,8],[2,22,8,28],[22,22,28,28]].slice(0,tooFewCells?3:4);
 const objects=[...paths.map(points=>({type:2,points})),...cells.map(box=>({type:1,box}))], heap=new ArrayBuffer(65536);
 const M={HEAPF32:new Float32Array(heap),HEAP32:new Int32Array(heap),_malloc:()=>64,_free:()=>{},
  _FPDFPage_CountObjects:()=>objects.length,_FPDFPage_GetObject:(_,i)=>i+1,_FPDFPageObj_GetType:h=>objects[h-1].type,
  _FPDFPage_GetRotation:()=>0,_FPDFPath_CountSegments:()=>2,_FPDFPageObj_GetClipPath:()=>0,_FPDFClipPath_CountPaths:()=>-1,
  _FPDFPageObj_HasTransparency:()=>0,_FPDFPageObj_GetDashCount:()=>dashed?1:0,
  _FPDFPageObj_GetMatrix:(_,p)=>{M.HEAPF32.set([1,0,0,1,0,0],p>>2);return 1;},
  _FPDFPath_GetPathSegment:(h,i)=>h*2+i,_FPDFPathSegment_GetType:s=>s%2?0:2,
  _FPDFPathSegment_GetPoint:(s,p,q)=>{const [x,y]=objects[Math.floor(s/2)-1].points[s%2];M.HEAPF32[p>>2]=x;M.HEAPF32[q>>2]=y;return 1;},
  _FPDFPath_GetDrawMode:(_,p,q)=>{M.HEAP32[p>>2]=0;M.HEAP32[q>>2]=1;return 1;},
  _FPDFPageObj_GetBounds:(h,a,b,c,d)=>{const box=objects[h-1].box;[a,b,c,d].forEach((p,i)=>{M.HEAPF32[p>>2]=box[i];});return 1;}};
 return {M,page:1,pageT:[1,0,0,1,0,0]};
}
test('only complete occupied solid grids establish cell provenance',()=>{
 const regions=ruledTableRegions(engine()); assert.equal(regions.length,1);
 assert.equal(inRuledTable({l:2,r:8,b:2,t:8},regions),true);
 assert.equal(inRuledTable({l:2,r:22,b:2,t:8},regions),false);
 assert.deepEqual(ruledTableRegions(engine({missingRule:true})),[]);
 assert.deepEqual(ruledTableRegions(engine({tooFewCells:true})),[]);
 assert.deepEqual(ruledTableRegions(engine({dashed:true})),[]);
 const rotated=engine();rotated.pageT=[0,1,-1,0,0,0];assert.deepEqual(ruledTableRegions(rotated),[]);
});
