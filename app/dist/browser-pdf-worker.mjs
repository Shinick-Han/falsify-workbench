const engineUrl = new URL('./browser-pdf.mjs', import.meta.url);
engineUrl.search = new URL(import.meta.url).search;
const {prepare, rewrite} = await import(engineUrl.href);

self.onmessage = async (event) => {
  const data = event.data || {};
  const id = data.id;
  try {
    if (data.op === 'rewrite') {
      const owned = new Uint8Array(data.bytes);
      const out = await rewrite(owned, data.edits);
      const transfer = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
        ? out.buffer
        : out.slice().buffer;
      self.postMessage({
        id,
        ok: true,
        op: 'rewrite',
        bytes: transfer,
      }, [transfer]);
      return;
    }
    const owned = new Uint8Array(data.bytes);
    const result = await prepare({
      file: {name: data.name || 'document.pdf', bytes: owned, type: data.type || 'application/pdf'},
      edits: data.edits,
      fileHash: data.fileHash || '',
      fontSnapshot: data.fontSnapshot,
    });
    const out = new Uint8Array(await result.file.arrayBuffer());
    const copy = new ArrayBuffer(out.byteLength);
    new Uint8Array(copy).set(out);
    self.postMessage({
      id,
      ok: true,
      name: result.file.name,
      type: result.file.type,
      sha256: result.sha256,
      verification: result.verification,
      pageMap: result.pageMap,
      warnings: result.warnings,
      bytes: copy,
    }, [copy]);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      op: data.op || 'prepare',
      error: {
        name: error && error.name || 'Error',
        message: String(error && error.message || 'engine'),
        code: data.op === 'rewrite' ? 'engine_unavailable' : (error && error.code || 'engine'),
        details: error && error.details || {},
      },
    });
  }
};
self.postMessage({ready: true});
