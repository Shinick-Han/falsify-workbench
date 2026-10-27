# Source link plan

`buildLinkPlan({document, flow, links, edits=[]})` combines the source-link inventory with flow ownership. All three source hashes must match. It returns `falsify.paper-link-plan.v1` with `sourceSha256`, `sourceRuns`, `sourceAssets`, `targets`, `changes` and `diagnostics`. Inputs are left unchanged.

`sourceRuns` contain `blockId`, `parentBlockId`, page-absolute UTF-16 `start` and `end`, the original `uri`, occurrence `linkIds`, and, for a resolved internal link, `destinationLabel`. Runs with distinct overlapping destinations are marked `conflicted` and reported. Identical overlapping runs merge and retain their occurrence IDs. `sourceAssets` relate source asset IDs and flow asset item IDs to their destinations. Text owned by an asset is excluded from text runs.

`targets` identify a stable label and source page plus a flow block range or asset item. A page anchor selects the first source-bound body or asset item on that page. A target intersecting a native edit instead has `status: 'deleted'` or `'replaced'`, source relation and edit IDs; its source run carries `destinationStatus`. Unresolved destinations also retain source runs and a diagnostic.

`changes` describe explicit composer-style native edits (`blockId`, `pageIndex`, `start`, `end`, `before`, `after`, optional `id` and `enabled`). Each includes intersecting link portions and an `inherit` destination only when one compatible original destination covers the entire edit. Segment-local `anchor` offsets are not native edit ranges and receive `edit-unmapped`. The renderer must map these ranges through its own raw-to-logical-to-edited character mapping and decide how to render conflicts. This plan does not generate or verify PDF annotations.

Typst's [link reference](https://typst.app/docs/reference/model/link/) specifies URL string and label destinations. Pass URIs as escaped typed strings and labels as label values when generating Typst; never insert an original URI as code. The plan does not execute or fetch URIs.

Run `node --test app/tests/paper-link-plan.spec.mjs` for the synthetic cases. Existing flow and source-link tests exercise their respective upstream contracts.
