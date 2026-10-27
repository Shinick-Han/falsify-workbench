# Flow inline and artwork repair

Base: 0a76605045825a9df3974c87de01d163a122bdb9.

Flow can group source-bound fragments into inline items, isolate repeated edge headers from column ordering, and discover connected vector grids or dense plots from observed drawing bounds. The original document is unchanged. The caller must capture the returned regions from the source and pass the captures to the compositor. Region detection is geometric and requires review on unfamiliar layouts.

The extraction, layout and flow suites pass (20 tests). The two local source probes retained every source range and asset occurrence exactly once. The measured table region excludes its caption, notes and subsequent body; a dense plot region excludes its caption. Original source renders and cropped artwork were inspected locally. These checks do not establish semantic accuracy for every page or a successful composed PDF.

Four dense source pages with text represented as vector outlines remain unresolved. The detector does not rasterize whole body pages. Page-edge headers with changing text and ambiguous overlapping inline runs also require further validation. Consumer integration and real no-edit composition are separate checks.
