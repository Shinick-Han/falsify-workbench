/*!
 * FalsifyBrowserPdf classic loader. Evaluating this script does not import
 * MuPDF or the WASM. The first prepare() starts dist/browser-pdf-worker.mjs,
 * which loads browser-pdf.mjs and the AGPL runtime. See browser-pdf-vendor/NOTICE.md.
 */
(function (root) {
  'use strict';
  var current = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
  var worker = null;
  var jobs = new Map();
  var nextId = 1;
  var coordinates = {space: 'top-left-page', origin: 'top-left', yAxis: 'down', unit: 'pt'};

  function abortedError() {
    var error = new Error('편집이 취소되었습니다. PDF는 만들지 않았습니다.');
    error.name = 'BrowserPdfError';
    error.code = 'aborted';
    error.details = {};
    return error;
  }

  function engineError(payload) {
    var error = new Error(payload && payload.message || 'engine');
    error.name = 'BrowserPdfError';
    error.code = payload && payload.code || 'engine';
    error.details = payload && payload.details || {};
    return error;
  }

  function dropWorker() {
    var dead = worker;
    worker = null;
    if (!dead) return;
    var pending = [];
    jobs.forEach(function (job, id) { if (job.worker === dead) pending.push(id); });
    pending.forEach(function (id) {
      var job = jobs.get(id);
      jobs.delete(id);
      job.reject(abortedError());
    });
    dead.terminate();
  }

  function spawn(scriptUrl) {
    var created = new Worker(new URL('./browser-pdf-worker.mjs', scriptUrl), {type: 'module'});
    var markReady;
    created.ready = new Promise(function (resolve) { markReady = resolve; });
    created.onmessage = function (event) {
      var data = event.data || {};
      if (data.ready) { markReady(); return; }
      var job = jobs.get(data.id);
      if (!job || job.worker !== created) return;
      jobs.delete(data.id);
      if (!data.ok) { job.reject(engineError(data.error)); return; }
      var bytes = new Uint8Array(data.bytes);
      var file = new File([bytes], data.name, {type: data.type || 'application/pdf'});
      job.resolve({file: file, sha256: data.sha256, verification: data.verification, pageMap: data.pageMap, warnings: data.warnings});
    };
    created.onerror = function () {
      var pending = [];
      jobs.forEach(function (job, id) { if (job.worker === created) pending.push(id); });
      pending.forEach(function (id) {
        var job = jobs.get(id);
        jobs.delete(id);
        job.reject(engineError({code: 'engine', message: 'PDF 워커가 실패했습니다. 출력 파일은 만들지 않았습니다.'}));
      });
      if (worker === created) worker = null;
    };
    return created;
  }

  function freshBuffer(bytes) {
    var copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
  }

  async function readFileBytes(file) {
    if (file instanceof Uint8Array) return new Uint8Array(file);
    if (file && typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
    if (file && file.bytes instanceof Uint8Array) return new Uint8Array(file.bytes);
    throw engineError({code: 'invalid', message: 'PDF File 또는 bytes가 필요합니다.'});
  }

  root.FalsifyBrowserPdf = {
    COORDINATE_SPACE: coordinates.space,
    COORDINATES: coordinates,
    prepare: function (request) {
      if (!current) return Promise.reject(new Error('FalsifyBrowserPdf 로더는 script URL이 필요합니다.'));
      var signal = request && request.signal;
      if (signal && signal.aborted) return Promise.reject(abortedError());
      var id = nextId++;
      return new Promise(function (resolve, reject) {
        var settled = false;
        function fail(error) {
          if (settled) return;
          settled = true;
          reject(error);
        }
        function cancel() {
          dropWorker();
          fail(abortedError());
        }
        if (signal) signal.addEventListener('abort', cancel, {once: true});
        readFileBytes(request && request.file).then(function (bytes) {
          if (settled || (signal && signal.aborted)) { fail(abortedError()); return; }
          if (!worker) worker = spawn(current);
          var target = worker;
          jobs.set(id, {resolve: resolve, reject: fail, worker: target});
          target.ready.then(function () {
            if (settled || (signal && signal.aborted)) { fail(abortedError()); return; }
            var buffer = freshBuffer(bytes);
            try {
              target.postMessage({
                id: id,
                name: request.file && request.file.name || 'document.pdf',
                type: request.file && request.file.type || 'application/pdf',
                fileHash: request.fileHash || '',
                edits: request.edits,
                bytes: buffer,
              }, [buffer]);
            } catch (error) {
              fail(engineError({code: 'engine', message: String(error && error.message || error)}));
            }
          }, fail);
        }, fail);
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
