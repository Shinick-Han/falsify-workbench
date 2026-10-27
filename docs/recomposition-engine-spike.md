# Recomposition engine S0 spike (2026-10-27)

## Decision

Recommend **Typst.ts 0.7.0 browser WASM as the bounded S1 candidate**, not yet the default production engine. Its actual browser PDF export flowed a handcrafted synthetic two-column document across four pages. The next bounded experiment should connect the agreed document model to a browser worker, explicitly detect unsupported glyphs before export, and test real extracted fonts and asset placement locally. Root must review this engine choice first. This is not a real-paper round trip or release acceptance.

## Search and provenance

Existing `docs/pdf-editor-reuse.md`, `app/src/paragraph-vendor/pagination.mjs` and `document-flow.mjs` were checked first. PDFium's pinned path has a single-column body assumption: `sameColumn` rejects another column as `pagination_unsupported_multi_column_flow`; compaction rejects table/column layouts as `document_flow_table_or_columns_unsupported`. Figures, tables and ambiguous ownership are further barriers. Extending it into a general compositor would require the missing flow/layout machinery. BabelDOC is a useful reference but its Python/ML runtime is not the browser-first choice. A new custom paginator is not justified by this spike.

The [Typst.ts upstream repository](https://github.com/Myriad-Dreamin/typst.ts) documents the browser WASM compiler; its [PDF method](https://github.com/Myriad-Dreamin/typst.ts/blob/main/packages/typst.ts/src/contrib/snippet.mts) calls compiler PDF export. npm registry metadata for `@myriaddreamin/typst.ts@0.7.0` and `@myriaddreamin/typst-ts-web-compiler@0.7.0` reports Apache-2.0 and gitHead `61cd6bdf5c08f508ce63406f58a92b0971ee84b8`. That [source's workspace manifest](https://github.com/Myriad-Dreamin/typst.ts/blob/61cd6bdf5c08f508ce63406f58a92b0971ee84b8/Cargo.toml) declares Typst 0.14.2; binary-to-source reproducibility and full transitive license inventory were not verified. Registry integrity values respectively: `sha512-JtO5Td/1QesH1IBKAZtbayFNK8u2sl3iz18Y67uYqBEdcXiu3z+wpZcDDKlmVJvAcCgSjHTnuk6ZLfkYclrGGQ==`, `sha512-nMwMcfOBy5pABPDuVM7/u8425SxhPUM+OJe6daqqgVOT3+neCTz4JKwx2L8XasfEHTNvd0cUI07LR9q5ADo7Gw==`. Downloaded WASM SHA-256 `1fc968438a672366dfec39c96c842c26ed29caff4eb1bcaab19a6c60867de5fd` (28,325,178 bytes). No shared package/lock was changed. [Typst columns documentation](https://typst.app/docs/reference/layout/columns/) notes unbalanced column heights and page-level columns; that is a layout limitation to evaluate.

## Experiment and results

`app/tests/recomposition-spike/index.html` constructs Typst source directly, not from extraction or the proposed paper model. It uses local Windows Arial (`arial.ttf`), a heading, a vector rectangle and caption, and 31 numbered synthetic paragraphs. In the long variant each paragraph is repeated four times; `?short=1` uses one. There is no original embedded PDF subset: reuse and rights for real fonts remain unproven. The system font is supplied locally for the experiment, not redistributed.

Chrome 154 on Windows ran the compiler WASM in the browser, fetched the installed package and font from localhost and returned PDF bytes. No paper, remote compiler or companion was used. Long: 47,247 bytes, 4 pages, 159 ms browser elapsed on one warm run; `performance.memory.usedJSHeapSize` approximately 8.1 MB is JS heap only, not process/WASM peak memory. Short: 38,704 bytes, 2 pages, 147 ms on one warm run. These are illustrative single runs, not benchmarks. Cancellation, cold start, peak memory, mobile and production worker behavior were not tested.

PyMuPDF 1.28.2 independently opened the actual long bytes and found all 124 numbered markers in sequence, caption, final marker, text blocks at x=51 and x=308 points (two columns), and embedded subset `ArialMT`; the synthetic rectangle appears as a drawing in the short PDF. The test establishes basic searchable text and flow, not pixel-level layout fidelity, overlapping or complete asset preservation. The output bytes SHA-256 for the measured long file: `1cc8e5b7fe4cc5888d4ea545251858dd440ff41ff065474efb0736759925e9ad`. The Ω probe was extracted; deliberately unsupported U+10FFFF was extracted as NUL, rather than preserved. Therefore missing-glyph handling is a **blocking correctness gap**, and a successful PDF call is not proof that all characters survived. Browser diagnostics and a robust font coverage/fallback policy remain to be tested.

## Reproduce locally

From repository root, use isolated scratch only:

```powershell
npm install --prefix .local/spike --ignore-scripts --no-audit --no-fund @myriaddreamin/typst.ts@0.7.0 @myriaddreamin/typst-ts-web-compiler@0.7.0
Copy-Item C:\Windows\Fonts\arial.ttf .local/spike/arial.ttf
python app/tests/recomposition-spike/serve.py
```

Open `http://127.0.0.1:18765/app/tests/recomposition-spike/index.html` locally. Once status shows bytes, in the browser console run `fetch('/save-synthetic', {method:'POST', body:new Uint8Array(window.spikePdf)})`; the loopback-only test server saves `.local/spike/output.pdf`. Then `python app/tests/recomposition-spike/check.py` (requires installed PyMuPDF). Add `?short=1` for the short variant; checker expects the long variant. Stop the server after use. The server serves the worktree on loopback and is solely a test harness, not an application runtime or remote service.

Unverified: source-PDF structure recovery, real font/subset reuse, mathematical glyphs, actual imported image/vector preservation, figure/caption migration across boundaries, exact block destination mapping, complete text equivalence and visual clipping, accessibility/tags/links, cancellation and end-to-end integration. Test those on local synthetic then private real papers before any default switch.
