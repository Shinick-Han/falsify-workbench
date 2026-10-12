# PDF editor adapter (local companion)

The local companion can route the existing authenticated `/api/export` request through the
patched `falsify-pdf-editor` (Node 24+, verified WASM) instead of the legacy single-line
PyMuPDF path. This is opt-in at server startup; nothing in an HTTP request selects paths,
executables or the manifest.

## Configuration

```
python app/local/server.py \
  --pdf-editor-root <ABS module checkout containing src/web-bridge.mjs> \
  --pdf-editor-manifest <ABS .../candidate-manifest.json> \
  [--pdf-editor-source-root <ABS pinned app source with upstream/ checked out>] \
  [--pdf-editor-node <ABS node executable>]
```

Environment equivalents: `FALSIFY_PDF_EDITOR_ROOT`, `FALSIFY_PDF_EDITOR_MANIFEST`,
`FALSIFY_PDF_EDITOR_SOURCE_ROOT`, `FALSIFY_PDF_EDITOR_NODE`. Root and manifest must be given
together and be absolute; a partial or relative configuration refuses to start. Without them
the companion keeps the legacy export path (old/unconfigured companions).

## Behaviour

- Capability probe (`/api/capabilities` → `pdfEditor`, also warmed in the background at
  start): checks module/manifest presence, `node --version` >= 24, then runs the fixed
  `node src/web-bridge.mjs --capabilities`, which verifies the manifest, artifact digests and
  pinned app source and instantiates the WASM once. It opens no PDF and starts no agent.
  Successes are cached; failures are retried after 15 s. `available` is true only after a
  successful probe. No filesystem paths are exposed.
- `pdfEditor` = `{available, configured, engine:'falsify-pdf-editor', version, wasmSha256,
  reflow, pagination, limits, sourceUrl[, runtime][, error]}`. `reflow`/`pagination` are
  booleans; a module descriptor counts only when `.supported === true`. Until the editor
  exports `EDITOR_CAPABILITIES`, reflow is true and pagination false. The legacy `pdf`
  boolean reflects editor availability when configured.
- Export: same wire format `{format:'PDF', fileHash, file, patches:[{label:'PDF p. N',
  before, after, …}]}`. Unknown fields are rejected; labels must be exactly `PDF p. N`
  (N >= 1, no leading zero) and map to `pageIndex = N-1`; edit ids are `edit-<i>` by order.
  Before/After are passed exactly; number/citation/URL scope checks match the legacy path.
  Only edit spans reach the bridge request (no model, provider, harness, rationale or label).
- Execution: own temp directory (`source.pdf`, `request.json`, `output.pdf`, `report.json`),
  fixed argv with `shell=False`, minimal environment (no `NODE_OPTIONS`), 180 s timeout,
  stdout/report/output size budgets. Only those four names and the directory are removed.
- Result: output must start with `%PDF-`, the report must say self-check passed, its
  `outputSha256` must match, its WASM digest must equal the probed one and every edit must be
  `applied`. Response keeps `file`, `sourceFileHash`, `outputFileHash`, `verification`.
- `verification` (per output, as the UI reads it): `engine:'falsify-pdf-editor'`,
  `layoutVerified` (true only when the mandatory saved-file text/layout self-check passed with
  no failures and no error-severity warnings), `reflow:{wrappedLines}` and
  `pagination:{inputPages, outputPages}` (from the self-check page count), `addedPages`,
  `sourcePageMap` (`report.pagination.sourcePageMap` reduced to `{sourcePageIndex,
  outputPageIndex, continuationPageIndices}`; flow digests/text dropped; else null), `capabilities:{reflow,pagination}`
  booleans, runtime hashes, edit statuses, warning codes, `diagnostics` (codes only),
  `independentQA:'pending'` and the same-engine boundary. Missing facts are null, never
  invented (`wrappedLines` stays null until the editor reports it).
- Any editor failure is a 400 error; there is no automatic fallback to the legacy path.

## Limits

Same-engine self-check only; independent extraction/rendering review remains required.
Pagination is not claimed. Live GUI integration and launcher wiring are owned by root.
