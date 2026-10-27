(function (root) {
  'use strict';
  const script = document.currentScript;
  const url = new URL('./blind-pdf.mjs', script.src).href;
  root.FalsifyBlindPdf = {prepare: async function (options) { return (await import(url)).prepare(options); }};
})(globalThis);
