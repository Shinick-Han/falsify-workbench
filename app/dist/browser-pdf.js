/*!
 * FalsifyBrowserPdf classic loader. The implementation and the AGPL MuPDF.js
 * runtime are browser-pdf.mjs and browser-pdf-vendor/. See browser-pdf-vendor/NOTICE.md.
 */
(function (root) {
  'use strict';
  var current = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
  if (!current) {
    root.FalsifyBrowserPdf = {prepare: function () {
      return Promise.reject(new Error('FalsifyBrowserPdf 로더는 script URL이 필요합니다.'));
    }};
    return;
  }
  var pending = import(new URL('./browser-pdf.mjs', current));
  root.FalsifyBrowserPdf = {
    prepare: function (request) {
      return pending.then(function (mod) { return mod.prepare(request); });
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
