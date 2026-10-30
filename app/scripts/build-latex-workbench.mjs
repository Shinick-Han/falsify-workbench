import {build} from 'esbuild';
await build({entryPoints:['src/latex-workbench.mjs'],outfile:'dist/latex-workbench.mjs',bundle:true,format:'esm',target:'es2022',minify:true,legalComments:'eof',external:['./vendor/*']});
