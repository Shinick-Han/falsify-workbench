(function (root) {
  'use strict';
  const script = document.currentScript;
  const target = new URL('./blind-pdf.mjs', script.src);target.search=new URL(script.src).search;
  const url = target.href;
  const workerUrl = new URL('./blind-pdf-worker.mjs', script.src);workerUrl.search=new URL(script.src).search;
  /* MuPDF opens, extracts and rasterises every page here, so it runs in a module worker. Results are
     kept per source SHA-256: warm() starts the job while the visitor edits, prepare() reuses it. */
  const results = new Map();
  /* SHA-256 of PDFs the booth fetched itself from arXiv through the Falsify API. They are original
     author files and cannot carry the RED training marker, so prepare() skips MuPDF for them. */
  const trusted = new Set();
  let worker = null, nextId = 1;
  const jobs = new Map();
  function aborted() { return new DOMException('Aborted', 'AbortError'); }
  function spawn() {
    if (worker) return worker;
    if (typeof Worker !== 'function') return null;
    try { worker = new Worker(workerUrl.href, {type: 'module'}); } catch { return null; }
    worker.onmessage = function (event) {
      const data = event.data || {};
      const job = jobs.get(data.id);
      if (!job) return;
      jobs.delete(data.id);
      if (!data.ok) { job.reject(Object.assign(new Error(data.error.message), {code: data.error.code})); return; }
      job.resolve(data);
    };
    worker.onerror = function () {
      const failed = worker;
      worker = null;
      try { failed.terminate(); } catch { /* gone */ }
      for (const [id, job] of jobs) { jobs.delete(id); job.reject(new Error('blind worker failed')); }
    };
    return worker;
  }
  async function hashOf(bytes) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
  }
  function inWorker(bytes, name) {
    const live = spawn();
    if (!live) return null;
    const id = nextId++;
    return new Promise(function (resolve, reject) {
      jobs.set(id, {resolve, reject});
      const copy = bytes.slice().buffer;
      live.postMessage({id, name, bytes: copy}, [copy]);
    });
  }
  async function readBytes(file) {
    return file.bytes instanceof Uint8Array ? new Uint8Array(file.bytes) : new Uint8Array(await file.arrayBuffer());
  }
  async function run(file, bytes) {
    const job = inWorker(bytes, file.name || 'document.pdf');
    if (!job) return (await import(url)).prepare({file});
    const data = await job;
    if (!data.result.changed) return {file, sha256: data.result.sha256, changed: false, removed: [], verification: data.result.verification};
    return {...data.result, file: new File([data.bytes], data.name || file.name || 'document.pdf', {type: 'application/pdf'})};
  }
  async function prepare(options) {
    const file = options && options.file, signal = options && options.signal;
    if (signal && signal.aborted) throw aborted();
    const bytes = await readBytes(file);
    const key = await hashOf(bytes);
    if (trusted.has(key)) return {file, sha256: key, changed: false, removed: [], verification: {status: 'passed', unchangedBytes: true, source: 'arxiv'}};
    let task = results.get(key);
    if (!task) {
      task = run(file, bytes);
      results.set(key, task);
      task.catch(function () { if (results.get(key) === task) results.delete(key); });
    }
    const result = await (signal ? Promise.race([task, new Promise(function (_, reject) { signal.addEventListener('abort', function () { reject(aborted()); }, {once: true}); })]) : task);
    if (signal && signal.aborted) throw aborted();
    return result.changed ? result : {...result, file};
  }
  /* Best effort: start the work for this source now; prepare() with the same bytes picks it up. */
  function warm(file) {
    if (!file || results.size > 4) return;
    prepare({file}).catch(function () { /* prepare() reports errors later */ });
  }
  async function trust(file) {
    if (!file) return;
    trusted.add(await hashOf(await readBytes(file)));
  }
  root.FalsifyBlindPdf = {prepare, warm, trust};
})(globalThis);
