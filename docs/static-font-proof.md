# Static Noto face proof

The pinned Typst.ts 0.7.0 WASM compiler selected the regular variable Serif face for both regular and bold requests, and the italic variable face for both italic and bold-italic requests. With four instantiated Serif faces, it embedded and rendered four distinct faces. This comparison uses the same synthetic text and compiler; it does not establish variable-font behavior in other Typst versions. The static candidate is suitable for root's integration review.

## Rebuild

Use Python with FontTools **4.66.0**, the four source files identified by SHA-256 in `app/scripts/prepare-static-fonts.py`, and a separate local output directory. The input corresponds to Google Fonts commit `e7db6ca603fd4862010383ff17ffd6cc4ffac1c0`. No downloads occur.

```powershell
python app/scripts/prepare-static-fonts.py <source-directory> <output-directory>
```

The tool checks all four source hashes before writing, instantiates default width 100 and weights 400 and 700 with `updateFontNames=True`, validates the resulting weight, italic flag, static state and complete Unicode cmap against each source, and writes `manifest.json` with output hashes, names, axes, size, copyright and license metadata. Two independent runs produced byte-identical fonts and identical manifests. Source files remain unchanged. The eight faces total 4,736,092 bytes versus 8,707,424 bytes for the four variable inputs; actual deployed size depends on chosen faces and packaging.

| Face | Bytes | SHA-256 |
| --- | ---: | --- |
| NotoSerif-Regular | 513124 | `97f25608791ba8b7e7bcfc761caaed09e54a47ae3d27b57c958a561b98c4306d` |
| NotoSerif-Bold | 515000 | `bd04ea002ca7d793a4d45f5d7ba81bcd0c4af5c23f50be73479e03b61e876059` |
| NotoSerif-Italic | 541996 | `67263ab35346d102b5ad7f02743a405f50ff1c0fc2a8ad75bcff8d9bfb894ce1` |
| NotoSerif-BoldItalic | 542500 | `dc188bc4240fb7a0a342df5022c12524977c252250feed09c2774e63acf5f62a` |
| NotoSans-Regular | 646160 | `16a1ee5229882c1ba577d265014a85d8a4ddbcf5e45bd30bcfbabfdaf89cabf3` |
| NotoSans-Bold | 648284 | `5a0ee56d5fa69689702d64bef03a4a24d58a93f5ae950ff5a004705102668833` |
| NotoSans-Italic | 663520 | `4187bd3eed08928c38695ad7702515c2f4c1999e37958e6001d9a7a6bbba1e55` |
| NotoSans-BoldItalic | 665508 | `a8749f56b38e50a0073475fab205c0cf174e1d50b2e27fc509098ec57969a108` |

Each face has the expected family (`Noto Serif` or `Noto Sans`), subfamily and OS/2 weight 400/700 and italic flag. Serif upright/italic cmaps contain 2,965/2,964 scalars, Sans 3,094/3,091; each matches its variable source exactly. Coverage of both local acceptance PDFs' PyMuPDF-extracted text and supplied After strings against all eight static faces plus four installed Liberation Sans faces left U+0003, an extracted control, unresolved; 121 distinct source scalars and 47 After scalars were checked excluding tab/newline/carriage return. This is cmap coverage, not a guarantee of shaping or source extraction fidelity. Root's prior application-level coverage probe found its source and After text covered.

## Compiler proof

`app/scripts/prove-static-fonts.mjs` accepts the pinned spike's `node_modules`, a local directory containing `fonts` and `static-font-proof`, and a local Liberation Sans Regular TTF. It writes two synthetic PDFs under `static-font-proof`. The script imports the existing app compiler adapter and the pinned WASM directly in Node. It includes regular, bold, italic and bold-italic lines with Greek, minus, infinity and curly quotes. Liberation provides infinity, which the Noto cmaps lack. It uses the regular fallback for infinity on all four lines; matching styled fallback faces remains integration work.

These PDF hashes identify the recorded run; PDF bytes vary between runs. The variable PDF was 21,453 bytes, SHA-256 `e4c0249803e6192e53f08db2cb55bac4d954f15659f8c65666afa27669a7247a`; it embedded NotoSerif-Regular, NotoSerif-Italic and LiberationSans. The static PDF was 34,464 bytes, SHA-256 `f792d25c2b5c802add9b1eab1428ca54155613c81af1b301a6586e028a300fc6`; it embedded the four Noto Serif faces and LiberationSans. PyMuPDF extracted the full sample text, with distinct Noto face names and style flags in the static PDF. The first Noto segment measured 380.21, 400.88, 364.37 and 397.42 pt for the four static lines. A 2x raster was visually inspected: all four styles are readable and distinct. PDF subsets need not carry an OS/2 table; these findings use font selection, text geometry and rendered ink together. Sans static metadata and coverage were checked, but this render comparison exercised Serif.

## License and provenance

The source manifest records original URLs, commit, Git blob IDs and source hashes. Both supplied Noto OFL files identify Copyright 2022 The Noto Project Authors and contain SIL OFL 1.1, with no Reserved Font Name listed after the copyright header. OFL permits modified fonts under its conditions, including retention of the copyright notice and license with distributed copies, the same license for font software, and no sale of the font software alone. Root owns legal review and any distribution. The proof's Liberation font and its separate license come from the existing `pdfjs-dist/standard_fonts` installation. Generated fonts, manifests and PDFs remain in the ignored private wave `.local` directory.
