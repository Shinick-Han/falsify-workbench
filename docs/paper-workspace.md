# Paper workspace UI

Candidate RED surface for one original PDF page at a time, direct edits, and an explicit generated-file handoff. This is not an acceptance report and it does not publish anything.

The controller is `app/dist/paper-workspace.js` (`FalsifyPaperWorkspace`). It edits no package, bridge, Python, or Confluence module. `paper-edits.js`, `external-red.js`, `browser-pdf.js`, and `external-red-ui.js` are loaded in that order and may be absent. Absence is an unavailable state: the page does not invent a PDF or a saved edit.

## Public API

`acceptProposals(proposals, {origin, model}?)` only shows proposals. Origin defaults to `external-ai-import`. `ai-proposal` records a model id only when the caller passes one matching the harness model pattern. `manual-unverified` RED responses are bridged as `external-ai-import` with no model. Ambiguous and missing targets stay disabled. The workspace rechecks the current segments; a caller's `status` is not trusted.

`getSource()` returns a frozen `{file, fileHash, segments}` after the chosen file has been hashed, or `null`. `file` is the same File the user chose. `segments` is a deep copy. `getEditSnapshot()` returns a frozen deep copy of the current edit snapshot, or `null`. `getOutput()` returns a frozen `{file, sha256, verification, revision}` for the last verified generated PDF, or `null` when there is none or the stored bytes no longer match the hash. `file`, `sha256`, and `revision` are the exact values from that generation. `verification` is a copy. None of these getters share nested objects with later callers.

Events, none of which carry PDF bytes:

- `falsify:paper-workspace-ready` after the global is set (dispatched on a timer so a later script can listen)
- `falsify:paper-workspace-source` with `{fileHash, name}`
- `falsify:paper-workspace-edits` with a frozen edit snapshot
- `falsify:paper-workspace-output` with `{sha256, revision, verification}` after a verified generation
- `falsify:paper-team-share` from the team button, with hash, revision, verification, and file name only. The button does not upload. `paper-manual-records.js` owns the consent screen.
- `falsify:blue-file` with `{file}` only

`index.html` loads `auto-pair.js` after `local-bridge.js`, and `paper-manual-records.css` / `paper-manual-records.js` after the workspace. Those files belong to their owners and may be absent. `#paper-external-mount` stays empty for the import UI.

## Reader and coordinates

`#paper-file` opens a PDF with the vendored PDF.js helpers (`FalsifyPreview.pdfParams`, `fitScale`, `defaultImport`, and `TextLayer` from pdfjs-dist 6.4.299, Apache-2.0). One page is drawn. Zoom is a factor on the fit scale, then clamped to the preview side and area caps. The stage scrolls inside `max-height: min(70vh, 720px)`.

Selection uses the text layer. A bbox is `[x0, y0, x1, y1]` in top-left page coordinates: the origin is the top left of the unrotated page, y grows downward, and the units are PDF points. The anchor also carries `coordinate: 'top-left'`, `pageWidth`, `pageHeight`, and `rotation: 0`. PDF user space (origin bottom left, y up) is converted with the page `viewBox` and is never stored in `bbox`. A page whose rotation is not 0 is still drawn, and both direct selection and visual bbox attachment are refused, so a bottom-left box is never mixed with a top-left box. `occurrence` is the 0-based index of that exact string in the page text-item string (`hasEOL` becomes `\n`). For a text-layer selection, `start`/`end` are offsets in that page string. For an accepted segment proposal, `start`/`end` are offsets in that segment and `occurrence` is 0. A bbox is added only when that loaded page is upright and contains the string once, as whole text items. A second occurrence is not replaced with the first.

The browser exporter should paint a bbox only when `coordinate` is `top-left` and `rotation` is 0. Provenance, attack labels, and quality warnings stay in the workspace status and the edit list. They are not written into `after` and they are not drawn into the PDF. Generator warnings, when they are plain text, are shown beside the download as diagnostics.

## Generated file

`FalsifyBrowserPdf.prepare({file, edits, signal})` is the only generator. The preview and the generated download use that `File` after the bytes hash to the returned `sha256` and start with a PDF signature. A later edit keeps the file downloadable and labels it as the last generated file. A thrown prepare, a hash mismatch, or a missing exporter leaves the previous real file in place and does not report success. The original file stays downloadable on its own control.

Draft storage is `localStorage` key `falsify.paper-draft.v1.<fileHash>`. It is written only while the 12-hour checkbox is checked, only with the object returned by `FalsifyPaperEdits.draft`, and it is deleted by the delete control. Restore calls `restoreDraft` and does not run on load. Envelopes with file bytes, tokens, or very long strings are refused.

## Provenance

No new dependency and no new network service. PDF.js 6.4.299 is the existing vendored copy (`app/dist/vendor/LICENSE-PDFJS.txt`, Apache-2.0). The Lucide sprite is the existing vendored copy (`app/dist/vendor/LICENSE-LUCIDE.txt`, ISC). Text-layer CSS is the small set required by PDF.js inline custom properties, not a copy of `pdf_viewer.css`. The controller itself is project code under AGPL-3.0-only.

## Limits

Other workers own the edit core, the external parser, the browser exporter, the import section, manual records, and auto-pair. Until those files exist, the script tags 404 and this UI keeps the unavailable copy. `app/tests/cleanup-static.spec.cjs` still rejects the literal `paper-workspace` and requires every script to exist; that test is outside this change. `app/scripts/test.mjs` does not list the new spec. Rotated pages are visible but not editable until a later coordinate handler exists. A text-item selection uses that item's whole box; it does not scale a partial glyph range inside one item. Draft restore replays `add` and does not restore the core undo stack. This report is not release certification.
