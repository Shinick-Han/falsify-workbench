import {unzipSync, zipSync} from 'fflate';
import {hex} from './paragraph-pdf-crypto.mjs';
const enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function fail(code,message,details={}) { throw Object.assign(new Error(message),{code,details}); }
function pathOf(p) { if(typeof p!=='string'||!p||p.includes('\\')||p.startsWith('/')||/^[A-Za-z]:/.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..')) fail('INVALID_PATH','Invalid project path'); return p; }
export async function createLatexProject({files,mainFile=null,engine='pdflatex',origin='original-source',sourcePdfHash}={}) {
 if(!Array.isArray(files)||!files.length) fail('EMPTY_PROJECT','Project has no files');
 if(!['pdflatex','xelatex','lualatex'].includes(engine)||!['original-source','reconstructed-pdf'].includes(origin)) fail('INVALID_PROJECT','Invalid project options');
 const seen=new Set(); const result=files.map(f=>{const path=pathOf(f.path); if(seen.has(path)) fail('DUPLICATE_PATH','Duplicate path',{path}); seen.add(path); const bytes=new Uint8Array(f.bytes); if(/\.tex$/i.test(path)) try{dec.decode(bytes)}catch{fail('INVALID_UTF8','Source is not UTF-8',{path})} return {path,bytes,sha256:hex(bytes)};}).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(mainFile!==null) { pathOf(mainFile); if(!seen.has(mainFile)||!/\.tex$/i.test(mainFile)) fail('MISSING_MAIN','Main file is missing',{path:mainFile}); }
 const id=hex(enc.encode(JSON.stringify({files:result.map(({path,sha256})=>[path,sha256]),mainFile,engine,origin})));
 return {schema:'falsify.latex-project.v1',id,revision:0,origin,mainFile,engine,files:result,...(sourcePdfHash?{sourcePdfHash}:{})};
}
export function analyzeProjectFiles(project) {
 const paths=new Set(project.files.map(f=>f.path)); const mainCandidates=[],missingFiles=[],diagnostics=[];
 for(const f of project.files.filter(f=>/\.tex$/i.test(f.path))) { let text;try{text=dec.decode(f.bytes)}catch{diagnostics.push({code:'INVALID_UTF8',message:'Source is not UTF-8',path:f.path});continue} text=text.replace(/(^|[^\\])%.*/gm,'$1'); if(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{/.test(text)&&/\\begin\s*\{document\}/.test(text))mainCandidates.push(f.path);
 const re=/\\(input|include|bibliography|addbibresource|includegraphics)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g; for(const m of text.matchAll(re)) for(const ref of m[2].split(',')) { const r=ref.trim(); if(!r||r.includes('\\'))continue; const dir=f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')+1):''; const base=dir+r; const options=m[1]==='includegraphics'?[base,base+'.pdf',base+'.png',base+'.jpg',base+'.jpeg',r,r+'.pdf',r+'.png',r+'.jpg']:m[1]==='bibliography'||m[1]==='addbibresource'?[base,base+'.bib',r,r+'.bib']:[base,base+'.tex',r,r+'.tex']; if(!options.some(p=>paths.has(p))) missingFiles.push({path:f.path,reference:r,command:m[1]}); }
 }
 if(!project.mainFile&&mainCandidates.length!==1)diagnostics.push({code:mainCandidates.length?'AMBIGUOUS_MAIN':'MISSING_MAIN',message:mainCandidates.length?'Multiple main files found':'No main file found'});
 for(const m of missingFiles)diagnostics.push({code:'MISSING_FILE',message:'Referenced file is missing',...m}); return {mainCandidates,missingFiles,diagnostics};
}
export async function importLatexProject(file,{mainFile,engine,signal}={}) { if(signal?.aborted) fail('ABORTED','Import cancelled'); const bytes=new Uint8Array(await file.arrayBuffer()); if(signal?.aborted) fail('ABORTED','Import cancelled'); let files; if(/\.tex$/i.test(file.name)) {const name=pathOf(file.name);files=[{path:name,bytes}];mainFile??=name;} else if(/\.zip$/i.test(file.name)) {let entries;try{let count=0,total=0;const names=new Set();unzipSync(bytes,{filter:f=>{if(++count>20000||names.has(f.name))fail('INVALID_ZIP','Duplicate or excessive ZIP entries');names.add(f.name);total+=f.originalSize;if(total>128*1024*1024||f.originalSize>Math.max(f.size*200,1000000))fail('INVALID_ZIP','ZIP size limit exceeded');return false;}});entries=unzipSync(bytes);}catch(e){if(e.code)throw e;fail('INVALID_ZIP','Invalid ZIP archive')} files=Object.entries(entries).filter(([p])=>!p.endsWith('/')).map(([path,bytes])=>({path,bytes}));} else fail('INVALID_FORMAT','Expected a .tex or .zip file');
 let p=await createLatexProject({files,mainFile:mainFile??null,engine}); if(!p.mainFile){const a=analyzeProjectFiles(p);if(a.mainCandidates.length===1)p=await createLatexProject({files,mainFile:a.mainCandidates[0],engine});}return p;
}
export async function exportLatexProject(project) { const entries=Object.create(null); for(const f of project.files)entries[pathOf(f.path)]=new Uint8Array(f.bytes);return zipSync(entries); }
