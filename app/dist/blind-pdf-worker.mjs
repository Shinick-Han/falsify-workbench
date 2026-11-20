// Runs blind-pdf.mjs (MuPDF) off the main thread. One request per message; the worker stays up for reuse.
const engineUrl = new URL('./blind-pdf.mjs', import.meta.url);
engineUrl.search = new URL(import.meta.url).search;
let engine = null;

/* The handler is set before any await: a module worker can drop messages that arrive while its
   top-level await is still pending. */
self.onmessage = async (event) => {
  const data = event.data || {};
  try {
    engine = engine || import(engineUrl.href);
    const {prepare} = await engine;
    const result = await prepare({file: {name: data.name || 'document.pdf', bytes: new Uint8Array(data.bytes)}});
    if (!result.changed) {
      self.postMessage({id: data.id, ok: true, result: {sha256: result.sha256, changed: false, removed: [], verification: result.verification}});
      return;
    }
    const out = new Uint8Array(await result.file.arrayBuffer());
    const copy = new ArrayBuffer(out.byteLength);
    new Uint8Array(copy).set(out);
    self.postMessage({id: data.id, ok: true, bytes: copy, name: result.file.name,
      result: {sha256: result.sha256, changed: true, removed: result.removed, verification: result.verification}}, [copy]);
  } catch (error) {
    self.postMessage({id: data.id, ok: false, error: {message: String(error && error.message || 'blind'), code: error && error.code || 'engine'}});
  }
};
