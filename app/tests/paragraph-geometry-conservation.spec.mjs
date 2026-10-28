import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalPage,compareSourceGeometry} from '../src/paragraph-geometry-conservation.mjs';
import {expectedPageText} from '../src/paragraph-vendor/quality.mjs';
const frame={rotation:0,transform:[1,0,0,1,0,0]};
function page(text) {
  const chars=[],glyphs=[]; let x=10;
  for(const [i,ch] of [...text].entries()) {
    const u=ch.charCodeAt(0); chars.push({u,generated:false,box:[x,x+2,10,20],origin:[x,10]});
    if(ch!==' ') glyphs.push({i,u,l:x,r:x+4,b:10,t:20,origin:[x,10],style:{size:10,mat:[1,0,0,1]}});
    x+=6;
  }
  return {W:200,H:200,frame,chars,glyphs};
}
const compare=(a,b,edits=[])=>compareSourceGeometry(a,b,edits,{expectedPageText});
test('complete index coverage and exact edits',()=>{
  const s=page('alpha beta'), o=page('alpha zeta');
  const result=compare(s,o,[{id:'e',before:'beta',after:'zeta'}]);
  assert.equal(result.match,true); assert.equal(result.sourceEvidence.mapped.length,s.chars.length);
  assert.equal(result.outputEvidence.mapped.length,o.chars.length);
});
test('missing extra swapped words and literal space fail',()=>{
  for(const text of ['alpha','alpha beta extra','beta alpha','alphabeta','alpha  beta']) {
    const result=compare(page('alpha beta'),page(text));
    // whitespace runs intentionally normalize like quality.normStr.
    if(text==='alpha  beta') assert.equal(result.match,true); else assert.equal(result.match,false,text);
  }
});
test('generated whitespace is recorded but cannot replace literal space',()=>{
  const a=page('alpha beta'), b=page('alpha beta'); b.chars[5].generated=true;
  assert.equal(compare(a,b).match,false);
  assert.deepEqual(canonicalPage(b).evidence.generatedWhitespace,[5]);
});
test('ambiguities and unsupported geometry fail closed',()=>{
  assert.equal(compare(page('a a'),page('a a'),[{before:'a',after:'b'}]).reason,'before_ambiguous');
  const r=page('abc'); r.frame={...frame,rotation:1}; assert.equal(canonicalPage(r).reason,'unsupported_frame');
  const m=page('a b'); m.chars[1].box=null; assert.equal(canonicalPage(m).reason,'literal_whitespace_geometry_unavailable');
  const c=page('ab'); c.chars[1].u=2; c.chars[1].discretionary=true; c.glyphs.pop(); assert.equal(canonicalPage(c).reason,'discretionary_break_unproven');
});
test('raised marker attaches to the body line before following punctuation',()=>{
  const p=page('ab1.'); const marker=p.glyphs[2]; marker.origin[1]=14; marker.b=14; marker.t=20; marker.style.size=6;
  assert.equal(canonicalPage(p).text,'ab1.');
});
