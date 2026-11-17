---
name: falsify-corpus-author
description: Write a synthetic clinical or statistical source case so source_case validate, falsify corpus build, corpus mutate, and corpus verify pass, with raw-table numbers, declarative figures, a synthetic literature pool, and mutation sets.
license: AGPL-3.0-only
---

# Falsify corpus author

Use this when a person, or the host agent they are running, needs a new source case under `tools/corpus/fixtures/`. The skill is instructions only. Nothing in this repository calls a model to author a case. The corpus tools set `modelCalls` to 0.

Read `tools/corpus/fixtures/rct_minimal` and `tools/corpus/fixtures/survival_minimal` end to end before writing. They are fictional. Copy their layout and the kind of arithmetic, not their sentences or numbers. Five domains already exist: `clinical-rct`, `diagnostic-accuracy`, `meta-analysis`, `clinical-cohort`, and `time-to-event`. Stay in that clinical and statistical field.

Run the commands from the repository root. `CASE` is the case directory. `SPEC` is one mutation file. `DIR`, `DIR-A`, `DIR-B`, `BUNDLE`, and `PDFDIR` are empty directories outside the repository. An output directory must be absent or empty. Do not commit those directories.

## Rules

- Synthetic content only. No real patients, no private or unpublished papers, and no sentences or numbers copied from a published paper.
- A published open-access paper may supply only the structure and the kind of analysis (upstream candidate 50). Record that paper's title and licence in `inputs/idea.md`. Do not carry over its sentences, counts, estimates, or identifiers, and do not put a URL or DOI anywhere the case schema stores text.
- Answer keys stay under `sealed/`. After `mutate`, rationales and before/after text belong in `DIR/sealed/`. Do not copy them into the paper, the blind PDF, stdout that you save, or any file outside `sealed/`.
- Do not trust model output until `validate`, two identical builds, `mutate`, and `verify` have all passed.
- Do not commit the case until a human has read it.

## Case layout

`case.json` is `falsify.source-case.v1`. Required fields: `caseId` (`^[a-z0-9][a-z0-9-]{0,47}$`), `title`, `domain`, `synthetic` true, `oracleScope` `P0`, `documentClass` `article`, and `files` with exactly these keys:

| Key | Path |
| --- | --- |
| `idea` | `inputs/idea.md` |
| `log` | `inputs/experimental_log.md` |
| `values` | `inputs/values.json` |
| `figures` | `inputs/figures.json` |
| `references` | `inputs/refs.json` |
| `tex` | `source/paper.tex` |

Paths are relative to the case directory. No absolute path and no `..`. `inputs/idea.md` is not rendered. It states the fictional design, the arithmetic you will recompute, and, when a published paper supplied the structure, that paper's title and licence.

There is no `init` subcommand. `init_case(dest, case_id)` in `tools/corpus/source_case.py` writes this skeleton and refuses a directory that already has entries (`schema_invalid`, message `directory not empty`). Replace the skeleton text and numbers; do not start from a fixture's values.

Optional `gate/baseline-exemptions.json` (`falsify.source-baseline-exemptions.v1`) is only for a clean-PDF Layer 0 signal that is legitimate reporting, such as randomized N in the abstract and analyzed N in a table. Prefer fixing the arithmetic. An exemption that matches nothing fails the gate.

Mutation specs live in `mutations/*.json`. They are not part of `validate`.

## Raw tables

`inputs/values.json` is the source of truth, and the raw table is where those numbers are born. Write the counts first. Every later percentage, difference, interval endpoint, and plotted point is a `{{v:ID}}` token whose `text` is derived from those counts.

`source_case.py` loads vendored `extract_metrics.py` through `load_vendor_module`. Do not edit `app/vendor-sources/`. The helper `find_raw_data_section` keeps the slice from a line matching `## 2. Raw Numeric Data` (the period after `2` is optional) through the line before the next `## ` heading. `parse_markdown_tables` then reads each markdown table in that slice. A table is a row containing `|`, a separator row of dashes and pipes, and body rows.

This case loader is stricter than the vendor parser:

- The heading line is `### Table <ID>: <label>`. `<ID>` matches `^[A-Z][A-Za-z0-9]{0,15}$`.
- The label after the colon must equal the label `extract_metrics.py` captured, and the number of such headings must equal the number of tables the vendor parser returns.
- `{{v:ID}}` is allowed only on the header and body lines of those tables. A token in the heading, or anywhere outside those lines, is `schema_invalid` (`token in table heading` or `token outside table cell`).
- Do not put an extra markdown table in the raw section. It changes the vendor count and fails `table count`.

`\falsifytable{ID}` in `paper.tex` prints that table. Surface names for mutations are `table:<ID>`.

## Derive, then recompute

`inputs/values.json` is `falsify.source-values.v1`. Each id matches `^[a-z][a-z0-9_]{0,47}$` and has `text` plus an optional `note`. The note says which raw cells produced it (`60/120`, `screened minus excluded`, `previous at risk minus events minus censored`).

Before you accept the case, recompute every derived `text` yourself from the raw cells. Wave 15 found fixture statistics that did not recompute. A p value, confidence limit, standard deviation, hazard ratio, or survival percent that you cannot recompute from the printed raw inputs is not acceptable because it looks plausible. Add the raw inputs and show the arithmetic in the note, or do not print the statistic.

Check at least:

- Flow parts sum to the parent count (screened minus excluded equals randomized; allocations sum to randomized; analyzed equals allocated minus discontinued).
- A percentage is the count divided by its own denominator, rounded the way `inputs/idea.md` states. The survival fixture rounds the unrounded product half up to one decimal; say the rule you actually use.
- A difference equals one arm minus the other.
- A printed interval contains its point estimate.
- In a life table, the next count at risk equals the previous count minus events minus censored, and the survival percent is the product-limit of those counts.

`{{v:ID}}` in `paper.tex`, in a table cell, or in `figures.json` must name a value. `bindings` lists every occurrence and its surface.

## Figures

Figures are declarative JSON only. Do not write matplotlib or any other plotting code. `render.py` draws them with vendored `render_matplotlib.py`.

`inputs/figures.json` is `falsify.source-figures.v1`. Each figure has `figureId`, `caption`, and `spec`. `spec.type` is one of `line`, `bar`, `grouped_bar`, `stacked_bar`, `radar`, `scatter`, `heatmap`. `spec.aspect_ratio` is one of `1:1`, `1:4`, `2:3`, `3:2`, `3:4`, `4:1`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`, or omitted (the renderer uses `16:9`). Bar types need `x_labels`. Series need `y`, and line or scatter series need `x`.

A string that is exactly `{{v:ID}}` becomes a float when the case is resolved, so the value `text` must be numeric. A caption may mix words and tokens; those stay text. The figure surface is `figure:<ID>`. `\falsifyfigure{ID}` places it. A plotted value that changes must change `figures/<ID>.png`. A caption-only change does not.

## Literature pool

`inputs/refs.json` is `falsify.source-references.v1`. Every reference has `key` (`^[a-z][a-z0-9]{0,47}$`), `authors` (list of strings), `title`, `venue`, `year` (integer), and `synthetic` true. Invent the authors, titles, and venues.

Do not include `doi`, `url`, `pmid`, `pmcid`, `issn`, or `isbn`. Do not put `http`, `doi:`, or a `10.dddd/` string in any reference field. `\cite{key}` may only use keys from this pool. Cite every reference at least once, or the gate reports `uncited_reference`. One `\falsifybibliography` emits the pool in cite order.

## paper.tex

Write the sections from `inputs/idea.md` and the log. Do not invent a number or a citation that is not already in `values.json` or `refs.json`.

`\documentclass{article}` is required, with `\begin{document}` and `\end{document}`. Packages may only be `inputenc`, `fontenc`, `graphicx`, `booktabs`, `amsmath`, `amssymb`, `geometry`, `caption`, and `array`. `\write18`, `\immediate`, `\openout`, `\input`, `\include`, `\href`, `\url`, `\pdfinfo`, and `\special` are `forbidden_tex`.

Put counts and estimates only as `{{v:ID}}`. A literal digit in the prose is a number the claim check did not bind. Phrase text that a mutation will spin uses a `ph_` id (`ph_concl_claim`, `ph_hedge`, `ph_limitation`).

Surfaces: `tex:title` inside `\title{...}`, `tex:abstract` inside the abstract, `tex:front` before the first section, otherwise `tex:` plus the section slug (lowercase, non-letters collapsed to hyphens). `\section{Results}` is `tex:results`.

Use fictional site and author names. Do not write a real person, a username, a hostname, a home directory, or a machine path. The anonymization check rejects those.

## Mutation sets

A spec is `falsify.source-mutation.v1` with `caseId`, `mutationSetId`, and `mutations`. Ids match `^[a-z0-9][a-z0-9-]{0,47}$`. Each mutation has an operator, `surfaces` (`"*"` or a non-empty list of surfaces from `bindings`), `family` (`D1` through `D7`, or `S1`), and `difficulty` (`L1` through `L4`). Read one existing file, such as `tools/corpus/fixtures/rct_minimal/mutations/p01-pair-abs-p.json`, for the field names. Do not paste a plan or a gold ledger into the case.

Eight operators:

| Operator | Extra fields | Rule |
| --- | --- | --- |
| `set_text` | `text`, `valueId` | Replace the bound text. No newline. |
| `shift_number` | `delta`, `valueId` | Add a JSON number. Keep the original decimal places, half up. The current text must be a plain number. |
| `scale_number` | `factor`, `valueId` | Multiply by a JSON number. Same formatting rule. |
| `transpose_digits` | `valueId` | Swap the first adjacent digits that change the number and do not create a leading zero. |
| `swap_values` | `withValueId`, `valueId` | Exchange two bound values on the surfaces they share. |
| `set_phrase` | `text`, `valueId` | `valueId` starts with `ph_`. Family `S1` or `D3`. No `\`, `{`, or `}`. At most 240 characters. |
| `apply_template` | `template`, `valueId` | Same phrase rules. Template is `strengthen_claim`, `remove_hedge`, or `minimize_limitation`. The current phrase must already contain wording that template rewrites. |
| `swap_citation` | `citeKey`, `withKey`, optional `occurrence` | No `valueId`. Family `D2`. Exactly one `tex:` surface. `occurrence` is a 1-based integer and defaults to 1. |

`delta` and `factor` are JSON numbers, not strings. `surfaces` must be surfaces where that value is actually bound.

Name a file `p…-pair-….json` (it starts with `p`, contains `-pair-`, and ends with `.json`) only when a PDF-edited twin should reproduce it. `pair_corpus` selects those names by default. The PDF editor replaces text spans that already sit on a line of `sealed/clean.pdf`. A pair spec is one short `set_text` that fits the existing line. A plotted figure, a citation swap, a phrase that changes the line, or several surfaces at once stays source-native: use an `m` name. `source_only` means the source twin passed and the PDF editor did not apply every defect. That is not a gate failure. `refused` is.

## Validate, build, mutate, verify

Inspect the finished fixtures, then the new case:

```bash
python tools/corpus/vendor.py verify
python tools/corpus/source_case.py validate tools/corpus/fixtures/rct_minimal
python tools/corpus/source_case.py validate tools/corpus/fixtures/survival_minimal
python tools/corpus/source_case.py validate CASE
python tools/corpus/source_case.py bindings CASE
python app/local/falsify_cli.py corpus list --root tools/corpus/fixtures
```

`validate` prints the manifest and warnings. Exit 0 with `unused_value`, `unreferenced_table`, or `unreferenced_figure` still means the case is unfinished: delete the unused value or reference the table or figure. `bindings` is the surface list for the spec. `resolve` prints a resolved case, including override fields; do not save that stdout into the tree.

```bash
python tools/corpus/source_case.py resolve CASE
```

Build the clean case twice. Compare the `files` arrays (`path` and `sha256`) in the two stdout JSON documents. They must match, and `compiled` must be true. `pdflatex` must be on `PATH`. Matplotlib is imported by the vendored figure renderer (`tools/corpus/requirements.txt` pins it). A missing engine is `engine_unavailable` or `figure_engine_unavailable`.

```bash
python app/local/falsify_cli.py corpus build --case CASE --out DIR-A
python app/local/falsify_cli.py corpus build --case CASE --out DIR-B
python tools/corpus/render.py render CASE --out DIR
```

`corpus build` prints `falsify.agent-cli.v1` with the case id, `compiled`, and relative hashes. It does not print the paper. `--no-compile` is a TeX preview only. `verify` then fails `not_compiled`, so it is not an acceptance build.

Plan, then build one spec, then gate it. Repeat per spec. `plan` prints a sealed plan and writes nothing; do not store that stdout outside `sealed/`.

```bash
python tools/corpus/source_mutator.py plan CASE --spec SPEC
python tools/corpus/source_mutator.py build CASE --spec SPEC --out DIR
python app/local/falsify_cli.py corpus mutate --case CASE --spec SPEC --out DIR
python tools/corpus/twin_gate.py verify DIR --case CASE --bundle-out BUNDLE
python app/local/falsify_cli.py corpus verify --build DIR --case CASE --bundle-out BUNDLE
```

`corpus mutate` prints counts and relative changed paths. The build directory holds `clean/`, `defect/`, `twin.json`, and `sealed/` (`mutation-plan.json`, `gold-ledger.json`). `corpus verify` prints the public report. On refusal it sets `error` to `gate_refused`, exits 3, and does not write the bundle. A passing bundle is `blind/paper.pdf`, `manifest.json`, and `sealed/`.

When the spec is a `p…-pair-….json` file and verify passed:

```bash
python tools/corpus/pdf_twin.py make BUNDLE --out PDFDIR
python tools/corpus/pair_corpus.py build --fixtures tools/corpus/fixtures --out DIR --sets "rct_minimal/mutations/p01-pair-abs-p.json"
```

`pdf_twin.py make` edits `sealed/clean.pdf` and writes a `pdf-mutation` ledger. There is no `falsify corpus` command for that step. The `pair_corpus` command is how the fixture tree builds one named set; point `--sets` at your own `mutations/p…-pair-….json` relative to the fixtures root. `source_only` is recorded with a reason (`figure_image`, `reflow`, `not_found`, `unit_failed`). It is not `refused`.

Exit 0 is success. Exit 2 is usage or invalid input. Exit 3 is a refusal. Exit 124 is a compile timeout.

## Refusal codes

`source_case.py` prints `code: message` on stderr and exits 2, except `vendor_unverified` (exit 3).

| Code | Fix |
| --- | --- |
| `missing_file` | Create the case directory and every path named in `files`. |
| `path_escape` | Make every `files` path relative and inside the case. |
| `schema_invalid` | Match the schema name, ids, `synthetic: true`, `oracleScope` `P0`, `documentClass` `article`, the six file keys, UTF-8 JSON, the raw-section heading, table ids and labels, and figure `type`. The message names the field. |
| `unknown_value` | Add the `{{v:ID}}` to `values.json` or remove the token. |
| `unknown_citation` | Add the cite key to `refs.json` or change the cite. |
| `forbidden_tex` | Remove the banned command or the package that is not on the allow list. |
| `unbound_directive` | Point `\falsifytable` / `\falsifyfigure` at an id defined in the log or `figures.json`. |
| `vendor_unverified` | Run `python tools/corpus/vendor.py verify`. Restore the vendored file. Do not edit it to make the receipt pass. |

Render and mutate refusals on stderr, usually exit 3 for render errors:

| Code | Fix |
| --- | --- |
| `out_dir_not_empty` | Choose a new empty directory. The same code is `directory not empty` when `init_case` hits an occupied folder (`schema_invalid`). |
| `engine_unavailable` | Put `pdflatex` on `PATH` and use a fresh `--out`. |
| `figure_engine_unavailable` | Install the pinned matplotlib and use a fresh `--out`. |
| `figure number` | Make the plotted token's `text` a plain number. `schema_invalid` carries this message. |
| `compile_timeout` | Exit 124. Retry in a fresh directory. Do not raise the timeout to hide a stuck engine. |
| `unknown_operator` | Use one of the eight operators. |
| `duplicate_defect` | Give each mutation a distinct id. |
| `surface_unbound` | Copy the surface from `bindings` for that value. |
| `not_numeric` | `shift_number`, `scale_number`, and `transpose_digits` need a plain numeric `text`. |
| `no_change` | The transpose or citation swap did not change anything. Pick a different value or key. |
| `template_no_match` | Put wording the named template rewrites into the `ph_` text. |
| `diff_mismatch` | A plotted binding must change the PNG, and a PNG must not change without one. |
| `absolute_path` | The render JSON contained a machine path. Keep paths relative. |

`twin_gate.py verify` exits 2 for `missing_file`, `unparsable`, `not_compiled`, and `bundle_not_empty`. Exit 3 means the report's `pass` is false. `corpus verify` wraps that as `gate_refused` and exits 3. The ten checks run in this order:

| Check | Codes | Fix |
| --- | --- | --- |
| `inputs` | `schema_mismatch`, `id_mismatch` | Rebuild from the same case and spec into an empty directory. |
| `truth` | `clean_not_truth`, `defect_not_plan`, `ledger_plan_mismatch` | The clean TeX must match `resolve`, and the defect TeX must match the plan. Do not hand-edit `clean/` or `defect/`. |
| `clean_layer0` | `clean_signal_unexempted`, `exemption_unused` | Fix the clean arithmetic, or add one exemption that matches a real signal and delete exemptions that match nothing. |
| `defect_survival` | `defect_not_visible`, `figure_unchanged` | The replacement must show up in the defect PDF more often than in the clean PDF, by the same amount the original disappears. |
| `diff_attribution` | `unexplained_diff`, `unexplained_figure_change` | Every word hunk and figure-image change must be a ledger context. |
| `defect_layer0` | `collateral_signal` | A new Layer 0 signal must quote a changed unit of a defect. Fix the edit so it does not create a second defect. |
| `blind` | `blind_leak`, `stealth_artifact`, `metadata_differs`, `fonts_differ`, `forensic_signal_differs` | Keep the blind PDF free of answer-key text. Rebuild so metadata and fonts stay paired. |
| `anonymization` | `identity_leak` | Remove user, host, home, path, and RED hint tokens from both TeX files and both PDFs. |
| `citations` | `undefined_citation`, `uncited_reference` | Cite only pool keys, cite every pool key, and keep `\falsifybibliography` so the PDF has no undefined cite mark. |
| `claims` | `clean_mismatch`, `undeclared_number`, `number_not_visible` | Every numeric token on the clean PDF must be a resolved value. A defect may introduce only the number the ledger declares, on the surface it names. |

Phrase, citation, and figure-image-only defects are `notApplicable` for `claims` (reasons `phrase`, `citation`, `figure_image_only`). They still have to pass the other checks.

`pdf_twin.py` exits 3 for `verification_failed` and `out_dir_not_empty`, and 2 for `bundle_invalid` and its other input errors (`path_leak`, `engine_missing`). Gate the bundle first. `pair_corpus.py build` exits 2 for `invalid_input` and 3 for `out_dir_not_empty`. A set listed under `refused` failed the gate; read that set's failure codes. `falsify corpus` with a missing or unknown path exits 2 (`invalid_arguments` or `file_not_found`). `corpus_tools_unavailable` means this checkout has no `tools/corpus`.
