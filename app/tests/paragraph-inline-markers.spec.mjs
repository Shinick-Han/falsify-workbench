import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planInlineMarkers} from '../src/paragraph-inline-markers.mjs';
const bodyStyle={size:1,mat:[10,0,0,10],font:'body',fill:[0,0,0,255]};
const markerStyle={size:1,mat:[6,0,0,6],font:'note',fill:[0,0,255,255]};
function fixture({shift=0,duplicate=false}={}) {
 let i=0, gs=[];
 function sentence(y,obj,dx=0) {let x=30+dx; for(const c of 'alpha bravo charlie delta') {if(c===' '){x+=4;continue;} gs.push({u:c.codePointAt(0),l:x,r:x+4,b:y,t:y+8,i:i++,obj,origin:[x,y],style:bodyStyle});x+=4;}return x;}
 const end=sentence(100,1,shift);
 if(duplicate) sentence(80,3,shift);
 const x=end-shift;
 gs.push({u:49,l:x,r:x+3,b:104,t:109,i:i++,obj:2,origin:[x,104],style:markerStyle});
 return {glyphs:gs,W:600};
}
test('moves a uniquely anchored superscript with its reflowed body',()=>{
 const plan=planInlineMarkers(fixture(),fixture({shift:15}));
 assert.equal(plan.repairs.length,1);assert.equal(plan.repairs[0].dx,15);assert.equal(plan.repairs[0].dy,0);
});
test('duplicate body context is left unresolved',()=>{
 const plan=planInlineMarkers(fixture(),fixture({shift:15,duplicate:true}));
 assert.equal(plan.repairs.length,0);assert.ok(plan.warnings.some(w=>w.code==='inline_marker_ambiguous'));
});

