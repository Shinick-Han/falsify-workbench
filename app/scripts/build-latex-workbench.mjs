import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const result=await build({entryPoints:['src/latex-workbench.mjs'],outfile:'dist/latex-workbench.mjs',bundle:true,format:'esm',target:'es2022',minify:true,metafile:true,legalComments:'eof',external:['./vendor/*'],plugins:[{name:'shared-browser-mupdf',setup(build){build.onResolve({filter:/^mupdf$/},()=>({path:'./browser-pdf-vendor/mupdf.js',external:true}));}}]});
const inputs=[];for(const path of Object.keys(result.metafile.inputs).sort())if(!path.startsWith('node_modules/'))inputs.push({path,sha256:digest(await readFile(path))});
await writeFile('dist/latex-workbench-build.json',JSON.stringify({schema:'falsify.browser-bundle.v1',inputs,output:{path:'latex-workbench.mjs',sha256:digest(await readFile('dist/latex-workbench.mjs'))}},null,2)+'\n');
await build({entryPoints:['src/latex-synctex-map.mjs'],outfile:'tests/latex-compiler-harness/map-bundle.mjs',bundle:true,format:'esm',target:'es2022',legalComments:'eof'});
