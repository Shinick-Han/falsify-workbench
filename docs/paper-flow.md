# Paper flow

`buildPaperFlow(document)` returns a deterministic `falsify.paper-flow.v1` proposal. Each item owns source block and asset IDs; original text, UTF-16 ranges, and the document remain unchanged. Caption relations use flow item IDs, and `captionIds` contain original caption block IDs. A contained short single-line label can belong to an image; other text stays separate. Missing geometry falls back to reader order.

Column gutters are inferred from source line boxes and spanning objects divide local bands. `geometry-order-heuristic`, `band-overlap`, `single-column-or-unresolved`, and `caption-association-unresolved` record uncertainty. A gutter is a candidate, not proof of reading order. Vector-only figures and table cells without raster occurrences are not reconstructed as artwork. Overlapping, multi-column and mixed layouts need review before using this flow for an automatic output.
