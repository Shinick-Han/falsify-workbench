import {readFile,writeFile,readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const [spikeRoot, baseArg, fallback] = process.argv.slice(2);
if (!spikeRoot || !baseArg || !fallback) throw Error('Usage: node app/scripts/prove-static-fonts.mjs SPIKE_NODE_MODULES_DIR LOCAL_DIR LIBERATION_REGULAR_TTF');
const spike=path.resolve(spikeRoot,'@myriaddreamin');
const {createTypstCompiler,createTypstFontBuilder}=await import(pathToFileURL(spike+'/typst.ts/dist/esm/compiler.mjs'));
const {loadFonts}=await import(pathToFileURL(spike+'/typst.ts/dist/esm/options.init.mjs'));
const {createTypstCompile}=await import(pathToFileURL(process.cwd()+'/app/src/paper-typst.mjs'));
const wasm=await readFile(spike+'/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm');
const base=path.resolve(baseArg);
for (const variant of ['fonts','static-font-proof']) {
 const dir=path.join(base,variant);
 const files=(await readdir(dir)).filter(n=>n.endsWith('.ttf') && (variant==='static-font-proof' || n.startsWith('notoserif-')));
 files.push(path.resolve(fallback));
 const candidates=await Promise.all(files.map(async f=>{const bytes=await readFile(path.isAbsolute(f)?f:path.join(dir,f));return {getBytes:()=>bytes}}));
 const compile=createTypstCompile({createTypstCompiler,createTypstFontBuilder,loadFonts,getModule:()=>wasm});
 const line='Sphinx of black quartz, judge my vow. Ω α − ∞ “quoted text”';
 const source=`#set page(width: 650pt, height: 300pt, margin: 30pt)\n#set text(font: ("Noto Serif", "Liberation Sans"), size: 18pt)\n#text(weight: "regular")[${line}]\n\n#text(weight: "bold")[${line}]\n\n#text(style: "italic")[${line}]\n\n#text(weight: "bold", style: "italic")[${line}]`;
 const result=await compile({source,fonts:{candidates}}); await writeFile(path.join(base,'static-font-proof',variant+'.pdf'),result.bytes); console.log(variant,result.bytes.length);
}
