/* Copy the pinned MuPDF.js browser build and bundle FalsifyBrowserPdf.
 * Does not compile MuPDF or download private editor artifacts.
 */
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendorSrc = join(app, 'node_modules/mupdf/dist');
const vendor = join(app, 'dist/browser-pdf-vendor');
const files = ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm'];
mkdirSync(vendor, {recursive: true});
writeFileSync(join(vendor, 'package.json'), JSON.stringify({name: 'falsify-browser-pdf-vendor', private: true, type: 'module'}) + '\n');

const digests = {};
for (const name of files) {
  const bytes = readFileSync(join(vendorSrc, name));
  writeFileSync(join(vendor, name), bytes);
  digests[name] = {sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length};
}
const pkg = JSON.parse(readFileSync(join(app, 'node_modules/mupdf/package.json'), 'utf8'));
if (pkg.version !== '1.28.1' || pkg.license !== 'AGPL-3.0-or-later') {
  throw new Error('refusing to vendor unexpected mupdf package ' + pkg.version + ' ' + pkg.license);
}

const manifest = {
  schema: 'falsify.browser-pdf.vendor.v1',
  engine: 'mupdf.js',
  version: pkg.version,
  license: pkg.license,
  npm: 'https://www.npmjs.com/package/mupdf/v/1.28.1',
  source: 'https://github.com/ArtifexSoftware/mupdf/releases/tag/1.28.1',
  correspondingSource: 'https://cgit.ghostscript.com/mupdf.git/tag/?h=1.28.1',
  provenance: 'Official npm browser/Node WASM and glue. Copied byte-for-byte from the installed mupdf@1.28.1 package. Not rebuilt from C sources and not a private falsify-pdf-editor candidate.',
  notUsed: [
    'Shinick-Han/falsify-pdf-editor b2d6ff204fc00a540eed98097895aec3f08b8047 editcore: verified stream-order WASM is an untracked patched build, and the upstream PDFium binary is not a substitute',
    'annotation-only FreeText, white overlay, raster-all-pages',
  ],
  files: digests,
};
writeFileSync(join(vendor, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(vendor, 'NOTICE.md'), `# MuPDF.js ${pkg.version}

Copyright (C) 2004-2026 Artifex Software, Inc.

MuPDF is free software under the GNU Affero General Public License,
version 3 or later. The terms are in the workbench \`LICENSE\` file
(AGPL-3.0). Upstream source for this pinned release:

- https://github.com/ArtifexSoftware/mupdf/releases/tag/1.28.1
- https://cgit.ghostscript.com/mupdf.git/tag/?h=1.28.1
- npm \`mupdf@1.28.1\` (https://www.npmjs.com/package/mupdf/v/1.28.1)

\`mupdf.js\`, \`mupdf-wasm.js\` and \`mupdf-wasm.wasm\` are the official
package artifacts named in \`manifest.json\`, with SHA-256 recorded there.
This repository does not rebuild those binaries. Alternative commercial
terms, if any, are available from Artifex and are not granted here.

Falsify workbench code that calls this engine is AGPL-3.0-only.
The browser editor removes text with MuPDF redaction and writes new text
operators. It does not ship the falsify-pdf-editor patched PDFium candidate.
`);

await build({
  entryPoints: [join(app, 'src/browser-pdf.mjs')],
  outfile: join(app, 'dist/browser-pdf.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  legalComments: 'eof',
  plugins: [{
    name: 'mupdf-vendor',
    setup(build) {
      build.onResolve({filter: /^mupdf$/}, () => ({path: './browser-pdf-vendor/mupdf.js', external: true}));
    },
  }],
});

writeFileSync(join(app, 'dist/browser-pdf.js'), `/*!
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
`);
console.log('browser-pdf vendored', pkg.version, digests['mupdf-wasm.wasm'].sha256);
