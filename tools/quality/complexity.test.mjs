import {test} from 'node:test';
import assert from 'node:assert/strict';
import {javascriptFunctions,pythonFunctions,violations} from './complexity.mjs';

test('regex punctuation is not control flow; nested functions have separate counts',()=>{
  const list=javascriptFunctions(String.raw`function outer(x) { const r=/if|while\?\//; function inner(y) { if(y && x) return 1; } if(x) return r; }`);
  assert.deepEqual(list.map(x=>[x.id,x.ccn]),[['/outer#1',2],['/outer#1/inner#1',3]]);
});
test('Python nested decisions belong to the inner function',()=>{
  const list=pythonFunctions('def outer(x):\n    def inner(y):\n        if y and x:\n            return 1\n    if x:\n        return inner(x)\n');
  assert.deepEqual(list.map(x=>[x.id,x.ccn]),[['/outer#1',2],['/outer#1/inner#1',3]]);
});
test('threshold rejects increases and permits unchanged and retained baselines',()=>{
  const old=[{id:'/a#1',ccn:55,source:'old'}];
  assert.equal(violations(old,[{id:'/a#1',ccn:56,source:'new'}]).length,1);
  assert.equal(violations(old,[{id:'/a#1',ccn:55,source:'new'}]).length,0);
  assert.equal(violations(old,[{id:'/a#1',ccn:55,source:'old'}],1).length,0);
  assert.equal(violations([], [{id:'/a#1',ccn:51,source:'new'}]).length,1);
  assert.equal(violations([], [{id:'/a#1',ccn:51,source:'new'}],50,{'/a#1':{reason:'tracked rationale',ceiling:51}}).length,0);
  assert.throws(()=>violations([],[],-1));
});
