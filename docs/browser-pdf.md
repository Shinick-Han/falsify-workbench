# Browser PDF content edit

`FalsifyBrowserPdf.prepare({file, edits, signal})` edits PDF content in the
browser (and in Node, for tests) with the pinned MuPDF.js WASM build. It does
not call a companion, upload the file, or run a model.

## Call

`file` is a `File` or `{name, bytes}`. `edits` is an array, or a
`falsify.paper-edits.v1` snapshot. Only objects with `enabled !== false` are
applied. A snapshot `fileHash`, or a top-level `fileHash`, must match the
SHA-256 of the bytes or the call throws `stale-source`. An aborted `signal`
throws `aborted`. No output file is returned for those errors.

The result is `{file, sha256, verification, pageMap, warnings}`. `file` is the
exact PDF bytes named in `sha256`. `pageMap` is an identity map
`{sourcePageIndex, outputPageIndex, continuationPageIndices: []}` because this
editor does not add pages. `verification.schema` is `falsify.browser-pdf.v1`.
`verification.independent` is false: the structural check reopens the save
with the same MuPDF.js engine. `layoutVerified` is true only when that check
passed and every warning is informational. It is not typographic, pixel, or
scientific verification.

Text-order and extraction-gap warnings are returned with the candidate. They
do not turn a readable file into a failure. A failed removal, a missing After,
a changed figure, or a changed unedited page throws `verification-failed` and
returns no file. Unsupported edits throw `unsupported` with
`details.edits[].code` and do not write a partial PDF. The original bytes are
never returned as if they had been edited.

## What the engine does

For each enabled edit it finds one exact whitespace-normalized match of
`before` on that page. Zero matches is `not-found`. More than one match, after
the anchor filters, is `ambiguous` (no first-hit guess). The anchor may set
`bbox` in MuPDF page space (origin at the top-left of the unrotated view, y
down, points; the same space as a PDF.js viewport at scale 1), `occurrence`
(0-based), and `start`/`end` into that normalized page string.

Matched glyphs are removed with MuPDF redaction:
`applyRedactions(false, REDACT_IMAGE_NONE, REDACT_LINE_ART_NONE, REDACT_TEXT_REMOVE)`.
Images and line art are not redacted. The save uses `garbage=compact`, so the
removed text operators are not kept as unreferenced streams. The After string
is appended as a real `Tj` text showing operator in a WinAnsi Type1 resource
of the sampled size and RGB color.

The face is the source Base-14 font when MuPDF reports one. Other faces are
substituted with a Base-14 metric class only when every After glyph exists,
and the edit is marked `font-substituted` (a warning, so `layoutVerified` is
false). Glyphs outside that font, including Hangul that is not in the sampled
face, are `missing-glyphs`. A longer After stays on the same PDF baseline when
it fits the hole or the clear space to the right. Otherwise it wraps downward
only when the extra lines do not hit other text, images, or the page edge, and
only on an unrotated page. If it does not fit, the code is `long-after-no-room`.
Rotated pages (`/Rotate`) are edited when the PDF-space baseline is still
horizontal. Vertical or mixed-direction text is `rotated-text`.

## Build

`npm run build:browser-pdf` copies `mupdf@1.28.1` `dist/mupdf.js`,
`mupdf-wasm.js`, and `mupdf-wasm.wasm` into `dist/browser-pdf-vendor/` and
writes `manifest.json` plus `NOTICE.md`. `dist/browser-pdf.mjs` is the ES
module. `dist/browser-pdf.js` is the classic loader that sets
`globalThis.FalsifyBrowserPdf` and imports the module. The WASM is loaded from
the vendor directory next to that module. No MuPDF source build and no
falsify-pdf-editor candidate runtime is downloaded.

License: MuPDF.js is AGPL-3.0-or-later. Corresponding source is the upstream
1.28.1 tag recorded in the manifest. The workbench itself is AGPL-3.0-only.
`dist/browser-pdf.js` is the classic script the UI can include. It imports
`dist/browser-pdf.mjs`, which loads the vendor WASM from the same directory.

## Limits

25 MB, 200 pages, 24 enabled edits, 4000 characters per Before/After, at most
8 wrapped lines. No encrypted PDFs, no added continuation pages, no CMYK text
color, no claim that unedited content streams are byte-identical after
MuPDF's save. Tests cover a synthetic multi-page file with pdf.js and, when
`pymupdf` imports, PyMuPDF. They are candidate evidence, not a release
certification.
