import {build} from 'esbuild';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
await mkdir('dist/vendor', {recursive:true});
await build({entryPoints:['src/document-import.js'],outfile:'dist/document-import.js',bundle:true,format:'iife',globalName:'FalsifyImport',target:'es2022',minify:true,legalComments:'eof',external:['./vendor/*']});
await build({entryPoints:['src/document-export.js'],outfile:'dist/document-export.js',bundle:true,format:'iife',globalName:'FalsifyExport',target:'es2022',minify:true,legalComments:'eof'});
// The main thread and the PDF worker have independent JavaScript globals.
await build({entryPoints:['src/pdf-compat.mjs'],outfile:'dist/vendor/pdf-compat.mjs',bundle:true,format:'esm',target:'es2022',minify:true,legalComments:'eof'});
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
  const source = await readFile('node_modules/pdfjs-dist/build/' + name, 'utf8');
  await writeFile('dist/vendor/' + name, "import './pdf-compat.mjs';\n" + source);
}
await cp('node_modules/core-js/LICENSE', 'dist/vendor/LICENSE-CORE-JS.txt');
for (const dir of ['cmaps','standard_fonts','wasm']) await cp('node_modules/pdfjs-dist/'+dir,'dist/vendor/'+dir,{recursive:true});
for (const [pkg,name] of [['pdfjs-dist','PDFJS'],['fflate','FFLATE'],['parse5','PARSE5']]) await cp('node_modules/'+pkg+'/LICENSE','dist/vendor/LICENSE-'+name+'.txt');
