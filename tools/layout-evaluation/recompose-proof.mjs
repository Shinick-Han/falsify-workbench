import {readFile, mkdir, writeFile, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join, resolve, relative, isAbsolute} from 'node:path';
import {File} from 'node:buffer';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const digest=b=>createHash('sha256').update(b).digest('hex');
const bytes=async file=>file?.bytes instanceof Uint8Array ? Uint8Array.from(file.bytes) : new Uint8Array(await file.arrayBuffer());
const fail=message=>{throw new Error(message)};
function options(argv) {
 const values={};
 for(let i=0;i<argv.length;i+=2) {
  const k=argv[i]; if(!['--matrix','--case','--output-dir','--layout-mode'].includes(k)||!argv[i+1]||values[k]) fail('Invalid or duplicate argument: '+k);
  values[k]=argv[i+1];
 }
 for(const k of ['--matrix','--case','--output-dir']) if(!values[k]) fail('Required: '+k);
 if(values['--layout-mode'] && values['--layout-mode']!=='measured-continuous') fail('Invalid layout mode');
 return values;
}
async function main() {
 const args=options(process.argv.slice(2)), matrixPath=resolve(args['--matrix']), output=resolve(args['--output-dir']);
 const gitRoot=await realpath(root), parent=await realpath(dirname(output));
 const rel=relative(gitRoot,parent); if(!rel || (!rel.startsWith('..')&&!isAbsolute(rel))) fail('Output must be outside the repository');
 const matrixBytes=await readFile(matrixPath), matrix=JSON.parse(matrixBytes), matches=matrix.cases.filter(c=>c.id===args['--case']);
 if(matches.length!==1) fail('Case must match exactly once');
 const item=structuredClone(matches[0]), source=resolve(dirname(matrixPath),item.source), original=await readFile(source);
 if(!/^[a-f0-9]{64}$/.test(item.fileHash)||digest(original)!==item.fileHash) fail('Matrix source hash mismatch');
 // Reserve a new directory atomically before running; existing evidence is never overwritten.
 await mkdir(output);
 globalThis.File ||= File;
 const {runRequest,loadAssets}=await import(pathToFileURL(join(root,'app/src/paper-recompose-worker.mjs')));
 const {createTypstCompile}=await import(pathToFileURL(join(root,'app/src/paper-typst.mjs')));
 const clean=(await import(pathToFileURL(join(root,'app/dist/blind-pdf.mjs')))).prepare;
 const manifestPath=join(root,'app/dist/recomposition-vendor/manifest.json');
 const assets=await loadAssets(pathToFileURL(manifestPath).href,async url=>{
  try { const data=await readFile(fileURLToPath(url)); return {ok:true,json:async()=>JSON.parse(data),arrayBuffer:async()=>Uint8Array.from(data).buffer}; }
  catch {return {ok:false};}
 });
 const facade=await import(pathToFileURL(join(root,'app/dist/recomposition-typst.mjs')));
 const wasm=process.env.FALSIFY_TYPST_WASM ? await readFile(process.env.FALSIFY_TYPST_WASM) : assets.wasm;
 if(digest(wasm)!==digest(assets.wasm)) fail('Compiler WASM differs from pinned manifest');
 const compile=createTypstCompile({...facade,getModule:()=>wasm});
 const pdfjsModule=await import(pathToFileURL(join(root,'app/node_modules/pdfjs-dist/legacy/build/pdf.mjs')));
 pdfjsModule.GlobalWorkerOptions.workerSrc=pathToFileURL(join(root,'app/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
 const pdfjs={...pdfjsModule,GlobalWorkerOptions:null};
 let prepared;
 const result=await runRequest({file:original,fileHash:item.fileHash,revision:item.id,bindings:item.bindings||[],layoutMode:args['--layout-mode'],edits:{schema:'falsify.paper-edits.v1',fileHash:item.fileHash,revision:item.id,edits:item.edits}},{assets,facade:{},compile,pdfjs,clean:async request=>{const out=await clean(request); prepared=await bytes(out.file); return out;}});
 if(!prepared || digest(prepared)!==result.sourceBinding.preparedSha256) fail('Captured prepared source hash mismatch');
 if(digest(await readFile(source))!==item.fileHash) fail('Original source changed during run');
 const {file,...metadata}=result, pdf=await bytes(file);
 if(digest(pdf)!==result.sha256) fail('Output hash mismatch');
 const manifest={schema:'falsify.recompose-proof.v1',caseId:item.id,layoutMode:args['--layout-mode']||'existing',codeVersion:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),toolSha256:digest(await readFile(fileURLToPath(import.meta.url))),matrixSha256:digest(matrixBytes),originalSha256:item.fileHash,preparedSha256:digest(prepared),outputSha256:digest(pdf),wasmSha256:digest(wasm),node:process.version,files:['prepared.pdf','output.pdf','metadata.json','plan.json']};
 for(const [name,data] of [['prepared.pdf',prepared],['output.pdf',pdf],['metadata.json',JSON.stringify(metadata,null,2)],['plan.json',JSON.stringify(item,null,2)],['manifest.json',JSON.stringify(manifest,null,2)]]) await writeFile(join(output,name),data,{flag:'wx'});
 console.log(JSON.stringify(manifest));
}
main().catch(e=>{console.error(e.stack||String(e));process.exitCode=1});


