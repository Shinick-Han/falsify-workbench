# Source glyph artwork

When structured text contains an unmapped replacement character or invalid source scalar, the compositor attempts to match its page, font and character geometry to exactly one MuPDF text paint glyph. It reconstructs that glyph as an SVG path with its original font, glyph ID, paint transform and color. The inline box uses the original glyph advance and the source line baseline. Ambiguous or unsupported matches remain explicit unavailable results.

The source range and geometry remain attached to each result. A replacement or deletion covering that range suppresses the artwork and renders the requested text. New text is never converted into source artwork. Searchable-text expectations omit artwork-owned characters, and content verification remains false when those characters have unknown Unicode. Body text remains typeset text.

The implementation supports horizontal, filled glyphs whose origin and font match uniquely; other paint modes or transforms can be unavailable. Source line baselines and character geometry must be present. The source PDF remains unchanged.

Typst's inline box baseline is a relative shift: a negative shift moves the contents up. The pinned compiler accepts the length form. See the [Typst box reference](https://typst.app/docs/reference/layout/box/#parameters-baseline).
