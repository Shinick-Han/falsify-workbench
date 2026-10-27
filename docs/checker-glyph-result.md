# Encoded glyph boundary check

Base: `0059eb0f3e0e9f042ca1a6f1cb6bd7074f96e063`. Candidate: the commit containing this report.

The checker accepts an optional already-loaded MuPDF module. It reads painted glyph scalars and transformed origins in page order. A line-final hard-hyphen separator is resolved only when the page's ordered non-whitespace scalars agree with PDF.js and both boundary glyphs match its geometry. Encoded whitespace is retained. Missing, unknown, or misaligned glyph evidence leaves that boundary unavailable. PDF.js still supplies bounds and movement; locations require complete supported alignment.

`node --test app/tests/recomposition-check.spec.mjs` passed 12 tests. Real-byte fixtures cover both space variants and their opposite expectations, repeated words, unrelated whitespace, minus, failed and unknown readers, and page movement. `git diff --check` passed. PDF.js printed standard-font-data warnings in the fixture tests.

The private 71-page baseline glyph readback had 71 available page streams; page 2 contained 4,568 glyphs. With the previous full expectation, 13 ambiguous boundaries remain, down from 40. There is one whole-sequence content-mismatch finding in both runs. A whitespace-token diff with one context line produced 104 hunks before and 83 after, using the same method for each; hunk counts are alignment-dependent. Observed normalized length changed from 145,290 to 145,266; expected length is 145,552. The first mismatch now occurs at UTF-16 offset 24,340, where the expectation has U+00AD and observed text has a space. The content and movement checks remain unavailable. This baseline predates the latest flow changes, and the remaining differences have not been attributed to the checker.
