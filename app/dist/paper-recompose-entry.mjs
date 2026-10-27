import * as runtime from './paper-recompose-runtime.mjs';
globalThis.FalsifyRecompositionPdf = Object.freeze({prepare: runtime.prepare});
document.dispatchEvent(new Event('falsify:recomposition-ready'));
