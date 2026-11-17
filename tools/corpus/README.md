# Corpus source cases

A source case is a small synthetic paper. `inputs/values.json` is the source of truth. `source_case.py` validates the case, lists `{{v:ID}}` bindings, and resolves a clean or overridden text. It does not compile PDF.

```
python tools/corpus/source_case.py validate CASE_DIR
python tools/corpus/source_case.py bindings CASE_DIR
python tools/corpus/source_case.py resolve CASE_DIR [--overrides FILE] [--out FILE]
python tools/corpus/vendor.py verify
```

JSON goes to stdout. Exit `0` is success, `2` is usage or an invalid case, and `3` is a vendor-gate refusal. Paths in JSON stay relative to the case or the vendor tree.

`init_case(dest, case_id)` writes a minimal valid skeleton and refuses a directory that already contains entries (`SourceCaseError` code `schema_invalid`, message `directory not empty`). The contract does not name a separate code for that refusal.

Table cells are read with the vendored `extract_metrics.py` (`find_raw_data_section`, `parse_markdown_tables`). Table ids come from `### Table <ID>: <label>` headings. `verify_receipt` accepts CRLF copies because hashes are computed after LF normalization.

The fixture `fixtures/rct_minimal/` is a fictional FX-217 versus placebo trial. It is not a real study.

## Rendering

`render.py` turns a resolved source case into deterministic LaTeX. It replaces `\falsifytable`, `\falsifyfigure`, and `\falsifybibliography`, draws figures with the vendored matplotlib helper, and can compile `paper.pdf` with `pdflatex`.

```
python tools/corpus/render.py render CASE_DIR --out DIR [--overrides FILE] [--no-compile]
python tools/corpus/render.py twin CASE_DIR --out DIR --overrides FILE [--no-compile]
```

JSON goes to stdout. Exit `0` is success, `2` is usage or an invalid case, `3` is a refusal, and `124` is a compile timeout. Paths in JSON stay relative to the output directory. Figure rendering uses `requirements.txt`, which pins `matplotlib==3.11.2` for this corpus tooling only.

The renderer also writes three preamble injections, each at most once. `\input{glyphtounicode}` and `\pdfgentounicode=1` make pdfTeX emit ToUnicode maps so ligatures and dashes survive text extraction. `\usepackage{lmodern}` is placed on the line after the case's `fontenc` package, or immediately before `\begin{document}` when that package is absent, so the embedded fonts are outline fonts. When the case does not already set `\date`, `\date{}` is inserted before `\begin{document}` and the epoch date from `SOURCE_DATE_EPOCH=0` is not printed.

## Source mutator

`source_mutator.py` turns a `falsify.source-mutation.v1` spec into overrides, renders the clean and defect twin with `render.py`, and writes a sealed gold ledger. It makes no model calls and does not call a network.

A spec names a `mutationSetId` and a list of mutations. Each mutation has a `defectId`, an operator (`set_text`, `shift_number`, `scale_number`, `transpose_digits`, `swap_values`, `set_phrase`, `apply_template`, `swap_citation`), a `valueId` (`swap_citation` uses `citeKey`, `withKey`, one `tex:` surface, and optional 1-based `occurrence` instead), `surfaces` (`"*"` or a list), a `family`, a `difficulty`, and a `rationale`. Phrase operators accept only `ph_` values and families `S1` or `D3`. `swap_citation` is family `D2`. `apply_template` uses the built-in `strengthen_claim`, `remove_hedge`, or `minimize_limitation` rule table.

```
python tools/corpus/source_mutator.py plan CASE_DIR --spec SPEC
python tools/corpus/source_mutator.py build CASE_DIR --spec SPEC --out DIR [--no-compile]
```

`plan` only prints a `falsify.source-mutation-plan.v1` document. `build` writes:

```
DIR/clean/    paper.tex, figures, and paper.pdf when compiled
DIR/defect/   the same layout with the overrides applied
DIR/twin.json
DIR/sealed/mutation-plan.json
DIR/sealed/gold-ledger.json
```

`twin.json` is the `render_twin` payload with `overridesApplied` replaced by `overridesAppliedCount`. Defect ids, rationales, and before/after text stay in `sealed/`. JSON on stdout has no absolute paths. Exit `0` is success, `2` is an invalid spec or case, `3` is `diff_mismatch` or another refusal, and `124` is a compile timeout.

Each defect's `source.contexts` has one entry for every changed visible unit, and several entries may share a surface. A changed body line, table row (header included), or caption is the de-TeXed text of that unit as the PDF shows it, including TeX dashes (`---` is an em dash). A figure value used under `spec` (the plotted data, including axis labels) records the numeric rendering and `figureFile`, and `figures/<ID>.png` must change. A figure value used only in the caption changes `paper.tex` and, when compiled, `paper.pdf`; that context is the caption text and has no `figureFile`. A value used in both records both. A PNG that changes without a plotted binding, or stays byte-identical when there is one, is `diff_mismatch`. When a text unit changed, the defect's top-level `quote` is text from the defect document. When the only change is a plotted figure, `quote` is the numeric rendering.

Hand-written cases are `fixtures/rct_minimal` (randomized trial), `fixtures/dta_minimal` (diagnostic accuracy), and `fixtures/meta_minimal` (meta-analysis). Build one mutation set, then verify it:

```
python tools/corpus/source_mutator.py build CASE_DIR --spec CASE_DIR/mutations/SET.json --out DIR
python tools/corpus/twin_gate.py verify DIR --case CASE_DIR --bundle-out BUNDLE
```

## Twin gate

`twin_gate.py` checks a build from `source_mutator.py` and writes a benchmark bundle only when every check passes. It reads overrides from `sealed/mutation-plan.json`.

```
python tools/corpus/twin_gate.py verify BUILD_DIR --case CASE_DIR [--bundle-out DIR]
```

Exit `0` passes and writes the bundle, `2` is invalid input, `3` is a gate refusal with no bundle, and `124` is a timeout. The bundle layout is `blind/paper.pdf`, `manifest.json`, and `sealed/` (`gold-ledger.json`, `baseline-signals.json`, `clean.pdf`, `gate.json`).

The ten checks are `inputs`, `truth`, `clean_layer0`, `defect_survival`, `diff_attribution`, `defect_layer0`, `blind`, `anonymization`, `citations`, and `claims`. `claims` is reported as skipped (`details.skipped`): the vendored claim-evidence gate treats 95% CI labels as unsupported claims, and the experimental log stores value tokens, so a source case cannot pass that gate without changing those patterns.

PDF text is compared in one canonical form. Line and page breaks may fall anywhere, including after a real hyphen and inside a hyphenated word; a running page number cannot create or hide a difference; figure captions and bibliography entries are placed in a stable trailer so a float moving across a page is not a new edit. Survival counts occurrences: for each context, the after text occurs more often in the defect document than in the clean one, and the before text less often, by the same amount. Attribution diffs that whole document. Every hunk must be covered by a ledger context, and every text context must correspond to a real difference. A new Layer 0 signal is a detection only when its excerpt quotes a changed unit of a defect.
