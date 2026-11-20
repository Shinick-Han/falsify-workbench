/*!
 * FalsifyBrowserPdf classic loader. Evaluating this script does not import
 * MuPDF or the WASM. The first prepare(), rewrite(), or warm() starts
 * dist/browser-pdf-worker.mjs, which loads browser-pdf.mjs and the AGPL
 * runtime. See browser-pdf-vendor/NOTICE.md.
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

  function unavailableError(cause) {
    var message = cause && cause.message ? String(cause.message) : 'PDF 엔진을 불러오지 못했습니다.';
    var error = new Error(message);
    error.name = 'BrowserPdfError';
    error.code = 'engine_unavailable';
    error.details = cause && cause.details || {};
    return error;
  }

  function resetWorker(target, error) {
    if (!target || target._reset) return;
    target._reset = true;
    if (worker === target) worker = null;
    var pending = [];
    jobs.forEach(function (job) { if (job.worker === target) pending.push(job); });
    if (typeof target._settleReady === 'function') target._settleReady(error);
    try { target.terminate(); } catch (terminateError) { /* already stopped */ }
    pending.forEach(function (job) {
      job.finish(job.kind === 'rewrite' ? unavailableError(error) : error);
    });
  }

  function spawn(scriptUrl) {
    var workerUrl = new URL('./browser-pdf-worker.mjs', scriptUrl);
    workerUrl.search = new URL(scriptUrl).search;
    var created = new Worker(workerUrl, {type: 'module'});
    var readySettled = false;
    var markReady, rejectReady;
    created.ready = new Promise(function (resolve, reject) {
      markReady = resolve;
      rejectReady = reject;
    });
    created.ready.catch(function () {});
    created._settleReady = function (error) {
      if (readySettled) return;
      readySettled = true;
      if (error) rejectReady(error);
      else markReady();
    };
    created.onmessage = function (event) {
      var data = event.data || {};
      if (data.ready) { created._settleReady(); return; }
      var job = jobs.get(data.id);
      if (!job || job.worker !== created) return;
      if (!data.ok) {
        job.finish(job.kind === 'rewrite' ? unavailableError(data.error) : engineError(data.error));
        return;
      }
      var bytes = new Uint8Array(data.bytes);
      if (job.kind === 'rewrite') {
        job.finish(null, bytes);
        return;
      }
      var file = new File([bytes], data.name, {type: data.type || 'application/pdf'});
      job.finish(null, {file: file, sha256: data.sha256, verification: data.verification, pageMap: data.pageMap, warnings: data.warnings});
    };
    created.onerror = function () {
      resetWorker(created, engineError({code: 'engine', message: 'PDF 워커가 실패했습니다. 출력 파일은 만들지 않았습니다.'}));
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
    if (file instanceof ArrayBuffer) return new Uint8Array(file);
    if (ArrayBuffer.isView(file)) return new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    if (file && typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
    if (file && file.bytes instanceof Uint8Array) return new Uint8Array(file.bytes);
    throw engineError({code: 'invalid', message: 'PDF File 또는 bytes가 필요합니다.'});
  }

  root.FalsifyBrowserPdf = {
    COORDINATE_SPACE: coordinates.space,
    COORDINATES: coordinates,
    warm: function () {
      if (!current || typeof Worker !== 'function') return Promise.resolve(false);
      try {
        if (!worker || worker._reset) worker = spawn(current);
        return worker.ready.then(function () { return true; }, function () { return false; });
      } catch (error) {
        return Promise.resolve(false);
      }
    },
    rewrite: function (sourceBytes, edits) {
      if (!current || typeof Worker !== 'function') return Promise.reject(unavailableError(new Error('FalsifyBrowserPdf 로더는 script URL과 Worker가 필요합니다.')));
      var id = nextId++;
      return new Promise(function (resolve, reject) {
        var settled = false;
        function finish(error, value) {
          if (settled) return;
          settled = true;
          jobs.delete(id);
          if (error) reject(unavailableError(error));
          else resolve(value);
        }
        readFileBytes(sourceBytes).then(function (bytes) {
          try {
            if (!worker || worker._reset) worker = spawn(current);
            var target = worker;
            if (target._reset) {
              if (worker === target) worker = null;
              finish(unavailableError(new Error('PDF 워커가 실패했습니다.')));
              return;
            }
            jobs.set(id, {finish: finish, worker: target, kind: 'rewrite'});
            target.ready.then(function () {
              if (settled) return;
              var buffer = freshBuffer(bytes);
              try {
                target.postMessage({
                  id: id,
                  op: 'rewrite',
                  edits: edits,
                  bytes: buffer,
                }, [buffer]);
              } catch (error) {
                var failure = unavailableError(error);
                finish(failure);
                resetWorker(target, failure);
              }
            }, function (error) {
              finish(unavailableError(error));
            });
          } catch (error) {
            finish(unavailableError(error));
          }
        }, function (error) {
          finish(unavailableError(error));
        });
      });
    },
    prepare: function (request) {
      if (!current) return Promise.reject(new Error('FalsifyBrowserPdf 로더는 script URL이 필요합니다.'));
      var signal = request && request.signal;
      var fontSnapshot = request && request.fontSnapshot ? structuredClone(request.fontSnapshot) : undefined;
      if (signal && signal.aborted) return Promise.reject(abortedError());
      var id = nextId++;
      return new Promise(function (resolve, reject) {
        var settled = false;
        function finish(error, value) {
          if (settled) return;
          settled = true;
          if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', cancel);
          jobs.delete(id);
          if (error) reject(error);
          else resolve(value);
        }
        function cancel() {
          if (settled) return;
          var job = jobs.get(id);
          var target = job && job.worker;
          finish(abortedError());
          if (target) resetWorker(target, abortedError());
        }
        if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', cancel);
        readFileBytes(request && request.file).then(function (bytes) {
          try {
            if (settled || (signal && signal.aborted)) { finish(abortedError()); return; }
            if (!worker || worker._reset) worker = spawn(current);
            var target = worker;
            if (target._reset) {
              if (worker === target) worker = null;
              finish(engineError({code: 'engine', message: 'PDF 워커가 실패했습니다. 출력 파일은 만들지 않았습니다.'}));
              return;
            }
            jobs.set(id, {finish: finish, worker: target, kind: 'prepare'});
            target.ready.then(function () {
              if (settled) return;
              if (signal && signal.aborted) {
                finish(abortedError());
                resetWorker(target, abortedError());
                return;
              }
              var buffer = freshBuffer(bytes);
              try {
                target.postMessage({
                  id: id,
                  name: request.file && request.file.name || 'document.pdf',
                  type: request.file && request.file.type || 'application/pdf',
                  fileHash: request.fileHash || '',
                  fontSnapshot: fontSnapshot,
                  edits: request.edits,
                  bytes: buffer,
                }, [buffer]);
              } catch (error) {
                var failure = engineError({code: 'engine', message: String(error && error.message || error)});
                finish(failure);
                resetWorker(target, failure);
              }
            }, function (error) {
              finish(error && error.code ? error : engineError({code: 'engine', message: String(error && error.message || error)}));
            });
          } catch (error) {
            finish(engineError({code: 'engine', message: String(error && error.message || error)}));
          }
        }, function (error) {
          finish(error && error.code ? error : engineError({code: 'engine', message: String(error && error.message || error)}));
        });
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
