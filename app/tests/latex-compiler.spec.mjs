import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'fflate';
import {parseSynctex,mapPdfToSource,mapSourceToPdf} from '../src/latex-synctex-map.mjs';
import {createLatexCompiler} from '../src/latex-compiler-adapter.mjs';
const project={id:'p',mainFile:'main.tex',engine:'pdflatex',files:[{path:'main.tex',bytes:new TextEncoder().encode('hello')}]};
const synctex='SyncTeX Version:1\nInput:1:/project/main.tex\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n(1,12:65536,131072:655360,65536,0\n}\nPostamble:\n';
test('SyncTeX gzip and plain conversion uses zero based page and top-left PDF points',()=>{
 for(const input of [new TextEncoder().encode(synctex),gzipSync(new TextEncoder().encode(synctex))]){
  const map=parseSynctex(input,{project}); const hit=mapSourceToPdf(map,{path:'main.tex',line:12}).candidates[0];
  assert.equal(hit.pageIndex,0); assert.ok(Math.abs(hit.box.x-72/72.27)<1e-8); assert.ok(Math.abs(hit.box.y-72/72.27)<1e-8);
  assert.equal(mapPdfToSource(map,{pageIndex:0,x:2,y:1.5}).candidates[0].line,12); assert.equal(mapPdfToSource(map,{pageIndex:1,x:2,y:1.5}).status,'missing');
 }
});
test('worker dispatch disables remote endpoint and shell and returns worker bytes',async()=>{
 let instance; const compiler=createLatexCompiler({workerFactory:()=>instance={postMessage(m){this.sent??=[];this.sent.push(m)},terminate(){this.terminated=true}}});
 const pending=compiler.compile({project,key:'k'}); instance.onmessage({data:{initialized:true}});
 assert.equal(instance.sent[1].shell_escape,false); assert.equal(instance.sent[1].remote_endpoint,''); assert.equal(instance.sent[1].files[0].path,'main.tex');
 instance.onmessage({data:{pdf:new Uint8Array([37,80,68,70]),exit_code:0}}); const result=await pending; assert.equal(result.success,true); assert.equal(result.pdfHash.length,64); assert.equal(instance.terminated,true);
});
test('cancel and failed compilation never return stale PDF',async()=>{
 let instance; const compiler=createLatexCompiler({workerFactory:()=>instance={postMessage(){},terminate(){}}});
 let pending=compiler.compile({project}); compiler.cancel(); assert.equal((await pending).diagnostics[0].code,'CANCELLED');
 pending=compiler.compile({project}); instance.onmessage({data:{pdf:new Uint8Array([1]),exit_code:1}}); const result=await pending; assert.equal(result.success,false); assert.equal(result.pdfBytes,undefined);
 compiler.dispose(); await assert.rejects(compiler.compile({project}));
});
