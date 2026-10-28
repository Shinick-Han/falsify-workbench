// PdfEngine.create() is deliberately not used: runtime.mjs initializes the
// verified local module and library and invokes the original constructor.
export const ENGINE_BUILD = 'falsify-pdfium-local-5eca1dab';
export function createEngineModule() { throw new Error('Use verified paragraph runtime factory'); }
