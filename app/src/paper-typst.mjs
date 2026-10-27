// Thin host adapter for Typst.ts 0.7.0; the caller owns the compiler worker.
export function createTypstCompile({createTypstCompiler, createTypstFontBuilder, loadFonts, getModule, getWrapper}) {
  return async ({source, files={}, fonts={}, signal}) => {
    const abort=()=>{if(signal?.aborted) throw new DOMException('Composition cancelled','AbortError');};
    abort();
    const options={getModule,getWrapper};
    const compiler=createTypstCompiler();
    await compiler.init({...options,beforeBuild:[loadFonts([], {assets:false})]}); abort();
    const builder=createTypstFontBuilder(); await builder.init(options); abort();
    for(const candidate of fonts.candidates || []) {const bytes=candidate.getBytes?.(); if(bytes) await builder.addFontData(bytes);}
    return builder.build(async resolved=>{
      abort(); compiler.setFonts(resolved);
      compiler.addSource('/main.typ',source);
      for(const [path, bytes] of Object.entries(files)) compiler.mapShadow('/'+path, bytes);
      try {
        const result=await compiler.compile({mainFilePath:'/main.typ',format:1}); abort();
        const bytes=result instanceof Uint8Array ? result : result?.result;
        if(!(bytes instanceof Uint8Array)) throw new Error('Typst PDF compilation failed');
        return bytes;
      } finally {compiler.resetShadow();}
    });
  };
}
