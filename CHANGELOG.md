# Changelog

## 0.2.0-alpha.1

Source-only prerelease of the Workbench and local companion. The separate PDF editor remains 0.1.0-alpha.4.

- Source-derived text edit plans and independent edited-page/region quality checks.
- Exact downloaded-PDF preview using the verified output bytes, with cancellation and bounded page rendering.
- Optional structure, fixed-area layout and object-occurrence analysis modules, with synthetic regression coverage.
- Explicit authenticated PDF preflight from RED: source inventory, shared-image counts and advisory selected-text layout.
  Does not run a model, authorize a scientific attack, block text export or pass RED information into BLUE.
- Companion version and feature reporting, while retaining old-companion/manual operation compatibility.

Docling ML conversion is not enabled; structure schema compatibility was tested separately. The layout planner is metrics-only,
not a new PDF writer. Object replacement is still a synthetic-only unique-XObject prototype at this release boundary; shared
per-occurrence writing is the next implementation. BLUE remains text-only.

The source archive excludes local environments, private papers/harnesses/records, model artifacts and the locally patched WASM.
Longer PDF export requires the separately configured editor described in docs/pdf-editor.md. Existing user installations must
restart idle companions through the supported launcher; pairing tokens change on restart and browser-local records are retained.
