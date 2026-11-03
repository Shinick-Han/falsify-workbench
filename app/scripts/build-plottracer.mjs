import {build,version} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=resolve(app,'vendor-sources/plottracer'),out=resolve(app,'dist/plottracer-vendor');
const manifest=JSON.parse(readFileSync(resolve(source,'UPSTREAM.json'),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
if(version!=='0.28.2')throw Error('PlotTracer build requires esbuild 0.28.2');
for(const f of manifest.files){if(sha(readFileSync(resolve(source,f.path)))!==f.sha256)throw Error('Pinned PlotTracer source mismatch: '+f.path);}
mkdirSync(out,{recursive:true});
const result=await build({entryPoints:[resolve(source,'adapter.ts')],bundle:true,write:false,format:'iife',platform:'neutral',target:'es2020',minify:true,legalComments:'inline',charset:'utf8',banner:{js:'/* PlotTracer 2.6.0, AGPL-3.0; upstream '+manifest.commit+'. See NOTICE.md and LICENSE. */'}});
const bytes=result.outputFiles[0].contents;writeFileSync(resolve(out,'engine.js'),bytes);
copyFileSync(resolve(source,'LICENSE'),resolve(out,'LICENSE'));
const notice='PlotTracer 2.6.0\nhttps://github.com/katalystnord/plottracer\nCommit '+manifest.commit+'\nAGPL-3.0. Copyright David Sandquist and upstream authors.\nXY/calibration and color extraction include WebPlotDigitizer code, Copyright Ankit Rohatgi, AGPL-3.0.\nVendored sources are unchanged. Falsify adapter and build script are in app/vendor-sources/plottracer and app/scripts.\n';
writeFileSync(resolve(out,'NOTICE.md'),notice);
writeFileSync(resolve(out,'manifest.json'),JSON.stringify({schema:'falsify.plottracer-runtime.v1',upstream:manifest.repository,commit:manifest.commit,version:'2.6.0',license:'AGPL-3.0',esbuild:version,engine:{path:'engine.js',bytes:bytes.length,sha256:sha(bytes)},sourceFiles:manifest.files},null,2)+'\n');
console.log('PlotTracer runtime '+bytes.length+' bytes '+sha(bytes));
