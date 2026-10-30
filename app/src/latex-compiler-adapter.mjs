import { hex } from './paragraph-pdf-crypto.mjs';

const manifest = Object.freeze({name:'TeXlyre BusyTeX', version:'1.4.1', source:'61b83cde2836d42cf941f6559d36c9678d52cbf2', engine:'combined', data:'texlive-basic'});
function failureDiagnostic(data) {
  const log = typeof data.log === 'string' ? data.log : '';
  const missing = /(?:LaTeX Error: )?File [`']([A-Za-z0-9_./+-]{1,180}\.(?:sty|cls|tex|bib|bst|png|pdf|jpg))['`] not found/i.exec(log);
  const line = /(?:^|\n)l\.(\d+)\b/.exec(log);
  return {code:missing?'TEX_MISSING_FILE':'COMPILE_FAILED',message:missing?`Required file ${missing[1]} was not found.`:'LaTeX compilation failed; check source and available packages.',severity:'error',...(line?{line:Number(line[1])}:{})};
}
export function createLatexCompiler(options = {}) {
  let worker = null, pending = null, disposed = false;
  const finish = (code, message) => { if (!pending) return; const p = pending; pending = null; worker?.terminate(); worker = null; p.cleanup(); p.resolve({schema:'falsify.latex-artifact.v1', success:false, projectId:p.project.id, key:p.key, engine:p.project.engine, engineManifest:manifest, diagnostics:[{code,message,severity:'error'}], timings:{totalMs:Date.now()-p.started}}); };
  function cancel() { finish('CANCELLED','Compilation cancelled.'); }
  async function compile(request) {
    if (disposed) throw new Error('Compiler disposed');
    if (pending) throw new Error('Compiler already busy');
    const {project, signal, onProgress, key} = request;
    const started = Date.now();
    if (!project?.files || !project.mainFile || !['pdflatex','xelatex','lualatex'].includes(project.engine)) throw new Error('Invalid LaTeX project');
    if (project.files.some(f => !f.path || f.path.startsWith('/') || f.path.includes('\\') || f.path.split('/').some(s => !s || s === '.' || s === '..'))) throw new Error('Invalid project path');
    if (!project.files.some(f => f.path === project.mainFile)) throw new Error('Main file missing');
    return new Promise(resolve => {
      const abort = () => cancel();
      const timer = setTimeout(() => finish('TIMEOUT','LaTeX compilation timed out.'), options.timeoutMs ?? 180000);
      pending = {resolve,project,key,started,cleanup:()=>{clearTimeout(timer); signal?.removeEventListener('abort',abort);}};
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort',abort,{once:true});
      try {
        const assetBase = new URL(options.assetBase || '../dist/latex-compiler-vendor/', import.meta.url);
        worker = options.workerFactory ? options.workerFactory(assetBase) : new Worker(new URL('busytex_worker.js',assetBase));
        const fileUrl = name => new URL(name,assetBase).href;
        worker.onerror = () => finish('ENGINE_ERROR','LaTeX engine failed to initialize or compile.');
        worker.onmessage = ({data}) => {
          if (!pending) return;
          if (data.print) { onProgress?.({message:'LaTeX compilation in progress.'}); return; }
          if (data.exception) return finish('ENGINE_ERROR','LaTeX engine reported an error.');
          if (data.initialized) {
            const drivers = {pdflatex:'pdftex_bibtex8',xelatex:'xetex_bibtex8_dvipdfmx',lualatex:'luahbtex_bibtex8'};
            worker.postMessage({files:project.files.map(f=>({path:f.path,contents:new Uint8Array(f.bytes)})),main_tex_path:project.mainFile,bibtex:null,biber:false,makeindex:false,rerun:true,verbose:'silent',driver:drivers[project.engine],data_packages_js:[],remote_endpoint:'',shell_escape:false});
          } else if (data.pdf !== undefined) {
            const p = pending; pending = null; p.cleanup(); worker.terminate(); worker = null;
            const bytes = data.pdf ? new Uint8Array(data.pdf) : null;
            const success = data.exit_code === 0 && bytes?.length > 0;
            p.resolve({schema:'falsify.latex-artifact.v1',success, ...(success ? {pdfBytes:bytes,pdfHash:hex(bytes),...(data.synctex ? {synctex:new Uint8Array(data.synctex)} : {})} : {}),projectId:project.id,key,engine:project.engine,engineManifest:manifest,diagnostics:success?[]:[failureDiagnostic(data)],timings:{totalMs:Date.now()-started}});
          }
        };
        worker.postMessage({busytex_js:fileUrl('busytex.js'),busytex_wasm:fileUrl('busytex.wasm'),biber_js:fileUrl('biber.js'),biber_wasm:fileUrl('biber.wasm'),biber_data:fileUrl('biber.data'),preload_data_packages_js:[fileUrl('texlive-basic.js')],data_packages_js:[fileUrl('texlive-basic.js')],texmf_local:[],preload:true});
      } catch { finish('ENGINE_ERROR','Could not start LaTeX worker.'); }
    });
  }
  return {compile,cancel,dispose(){cancel();disposed=true;}};
}
