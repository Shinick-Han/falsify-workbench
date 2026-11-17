# Corpus source cases

A source case is a small synthetic paper. `inputs/values.json` is the source of truth. `source_case.py` validates the case, lists `{{v:ID}}` bindings, and resolves a clean or overridden text. It does not compile PDF.

Run the commands from the repository root. `DIR`, `BUNDLE`, `PDFDIR`, `REPORT.json`, and `TABLE.md` are paths you choose. An output directory must be absent or empty. JSON goes to stdout. Paths in that JSON stay relative.

The fixtures under `tools/corpus/fixtures/` are fictional. They are not real studies. `corpus list` on this tree reports five cases and 46 mutation sets:

| Directory | `caseId` | Domain | Sets |
| --- | --- | --- | --- |
| `fixtures/rct_minimal` | `rct-minimal` | `clinical-rct` | 12 |
| `fixtures/dta_minimal` | `dta-minimal` | `diagnostic-accuracy` | 8 |
| `fixtures/meta_minimal` | `meta-minimal` | `meta-analysis` | 8 |
| `fixtures/cohort_minimal` | `cohort-minimal` | `clinical-cohort` | 9 |
| `fixtures/survival_minimal` | `survival-minimal` | `time-to-event` | 9 |

## List cases

`corpus list` prints case ids and mutation set ids. It does not print rationales or values.

```
python app/local/falsify_cli.py corpus list
python app/local/falsify_cli.py corpus list --root tools/corpus/fixtures
```

There is no `tools/corpus` list command. To inspect one case without the CLI:

```
python tools/corpus/source_case.py validate tools/corpus/fixtures/rct_minimal
python tools/corpus/source_case.py bindings tools/corpus/fixtures/rct_minimal
python tools/corpus/source_case.py resolve tools/corpus/fixtures/rct_minimal
python tools/corpus/vendor.py verify
```

`init_case(dest, case_id)` writes a minimal valid skeleton and refuses a directory that already contains entries (`SourceCaseError` code `schema_invalid`, message `directory not empty`). Table cells are read with the vendored `extract_metrics.py`. Table ids come from `### Table <ID>: <label>` headings. `verify_receipt` accepts CRLF copies because hashes are computed after LF normalization.

## Build a clean case

`render.py` turns a resolved case into deterministic LaTeX, replaces `\falsifytable`, `\falsifyfigure`, and `\falsifybibliography`, draws figures with the vendored matplotlib helper, and compiles `paper.pdf` with `pdflatex` (two passes). `requirements.txt` pins `matplotlib==3.11.2` for this corpus tooling.

The renderer writes three preamble injections, each at most once. `\input{glyphtounicode}` and `\pdfgentounicode=1` make pdfTeX emit ToUnicode maps. `\usepackage{lmodern}` is placed on the line after the case's `fontenc` package, or immediately before `\begin{document}` when that package is absent. When the case does not already set `\date`, `\date{}` is inserted before `\begin{document}`.

```
python tools/corpus/render.py render tools/corpus/fixtures/rct_minimal --out DIR
python app/local/falsify_cli.py corpus build --case tools/corpus/fixtures/rct_minimal --out DIR
```

`corpus build` prints `falsify.agent-cli.v1` with `command` `corpus build`, the case id, whether a PDF was compiled, and relative file hashes. It does not print the paper text.

## Build a defect twin

`source_mutator.py` turns a `falsify.source-mutation.v1` spec into overrides, renders the clean and defect sides, and writes a sealed gold ledger. It makes no model calls and does not use the network.

```
python tools/corpus/source_mutator.py plan tools/corpus/fixtures/rct_minimal --spec tools/corpus/fixtures/rct_minimal/mutations/p01-pair-abs-p.json
python tools/corpus/source_mutator.py build tools/corpus/fixtures/rct_minimal --spec tools/corpus/fixtures/rct_minimal/mutations/p01-pair-abs-p.json --out DIR
python app/local/falsify_cli.py corpus mutate --case tools/corpus/fixtures/rct_minimal --spec tools/corpus/fixtures/rct_minimal/mutations/p01-pair-abs-p.json --out DIR
```

`plan` prints a `falsify.source-mutation-plan.v1` document and does not write a twin. `build` writes:

```
DIR/clean/    paper.tex, figures, and paper.pdf when compiled
DIR/defect/   the same layout with the overrides applied
DIR/twin.json
DIR/sealed/mutation-plan.json
DIR/sealed/gold-ledger.json
```

`twin.json` is the twin payload with `overridesApplied` replaced by `overridesAppliedCount`. Defect ids, rationales, and before/after text stay in `sealed/`. `corpus mutate` prints counts and relative changed paths only.

Each defect's `source.contexts` has one entry for every changed visible unit, and several entries may share a surface. A changed body line, table row (header included), or caption is the de-TeXed text of that unit as the PDF shows it, including TeX dashes (`---` is an em dash). A figure value used under `spec` (the plotted data, including axis labels) records the numeric rendering and `figureFile`, and `figures/<ID>.png` must change. A figure value used only in the caption changes `paper.tex` and, when compiled, `paper.pdf`; that context is the caption text and has no `figureFile`. A value used in both records both. A PNG that changes without a plotted binding, or stays byte-identical when there is one, is `diff_mismatch`. When a text unit changed, the defect's top-level `quote` is text from the defect document. When the only change is a plotted figure, `quote` is the numeric rendering.

## Verify and write a bundle

`twin_gate.py` checks a mutator build and writes a benchmark bundle only when every check passes.

```
python tools/corpus/twin_gate.py verify DIR --case tools/corpus/fixtures/rct_minimal --bundle-out BUNDLE
python app/local/falsify_cli.py corpus verify --build DIR --case tools/corpus/fixtures/rct_minimal --bundle-out BUNDLE
```

The bundle layout is `blind/paper.pdf`, `manifest.json` (`falsify.source-bundle.v1`), and `sealed/` (`gold-ledger.json`, `baseline-signals.json`, `clean.pdf`, `gate.json`). `corpus verify` prints the public report. On a refusal it still prints that report, sets `error` to `gate_refused`, and exits 3. The bundle directory is left unwritten when the gate does not pass.

## PDF-edited counterpart

`pdf_twin.py` edits `sealed/clean.pdf` inside a gate-passed bundle whose ledger `producer` is `source-native`. Visible text goes through `paper_text_span_mutator.mutate_pdf_text_spans` with `allow_trace=False` (the text-span editor `paper_red_mcp` calls). The command writes `PDFDIR/blind/paper.pdf`, `PDFDIR/sealed/gold-ledger.json` (`producer` `pdf-mutation`), and `PDFDIR/sealed/pair.json` (`falsify.source-pdf-pair.v1`). Stdout is counts and statuses.

```
python tools/corpus/pdf_twin.py make BUNDLE --out PDFDIR
```

There is no `falsify corpus` command for this step.

## Paired corpus

`pair_corpus.py build` compiles each selected spec, runs the gate, then asks `pdf_twin.py` for a counterpart. Without `--sets` it selects only mutation files whose names match `p*-pair-*.json` (16 files in this tree). `--sets` is a `pathlib.PurePosixPath.match` pattern against the path relative to `--fixtures`, such as `rct_minimal/mutations/m03-figure-y.json`.

```
python tools/corpus/pair_corpus.py build --fixtures tools/corpus/fixtures --out DIR
python tools/corpus/pair_corpus.py build --fixtures tools/corpus/fixtures --out DIR --sets "rct_minimal/mutations/p01-pair-abs-p.json" --layer0-runs
```

Stdout is `falsify.source-pdf-pair-corpus.v1` with `sets`, `paired`, `sourceOnly`, and `refused`. On this fixture tree the default `build` reported `sets` 16, `paired` 14, `sourceOnly` 2, `refused` 0. The two `source_only` reasons were `figure_image` and `unit_failed`, one each. The single-set command above reported `paired` 1. The directory contains:

```
DIR/sealed/index.json
DIR/sealed/leak-dependence-input.json
DIR/sealed/<pairKey>/source-native/gold-ledger.json
DIR/sealed/<pairKey>/pdf-mutation/gold-ledger.json    only when status is paired
DIR/blind/<pairKey>/<armId>/paper.pdf
DIR/runs/<armId>/layer0.json                          only with --layer0-runs
```

`<pairKey>` and `<armId>` are 32-hex hashes. Read them from `sealed/index.json`. A `paired` entry has `arms.source-native` and `arms.pdf-mutation`. A `source_only` entry has the source-native arm and a `reasons` list. A `refused` entry records gate failure codes and does not get a blind PDF.

## Layer 0 measurement

`--layer0-runs` writes one sensor report per blind PDF at `runs/<armId>/layer0.json`. The report is `{"agentId": "layer0-sensor", "runId": "layer0-sensor", "findings": [...]}` from `benchmark_suite._signals_to_run`. `measure` refuses to score when `runs/` contains no `*/*.json` files.

```
python tools/corpus/pair_corpus.py measure --corpus DIR --out REPORT.json --markdown TABLE.md
```

`measure` loads `sealed/leak-dependence-input.json` and calls `leak_dependence.evaluate_manifest`. The manifest points at `runs/<armId>/layer0.json` for each paired arm. Stdout is a short summary (`schema`, `pairCount`, `paired`, `interpretation`). `REPORT.json` is the full `falsify.leak-dependence.v1` document. `TABLE.md` is the same three views as Markdown.

To score your own detector, build with or without `--layer0-runs`, then replace each paired arm's `runs/<armId>/layer0.json`. Use the `armId` from `sealed/index.json`. The file must be a BLUE run `evaluate_arena_match` can read: a JSON object with `findings` (or `signals`) and the same `agentId` on both arms of a pair. A finding is matched on `quote`, `excerpt`, or `detail`, plus `pageIndex` when present. Then run `measure` again. Different `agentId` or `model` labels on the two arms exit 3 with `arms_not_comparable`.

The same report can be produced without `pair_corpus.py measure`:

```
python tools/evaluation/leak_dependence.py DIR/sealed/leak-dependence-input.json --markdown TABLE.md --out REPORT.json
```

### What the tables show

`leak_dependence.py` does not call a model and does not run BLUE. It scores the JSON files already on disk. One trial is one gold defect in one run. The run detects that defect only when the arena rating is `detected`. `uncertain` and `missed` count as misses. Paired McNemar rows align runs that share an `agentId`/`model` label.

`TABLE.md` has three tables:

- Arm by family and difficulty: `total`, `detected`, `recall`, Wilson interval, `insufficient`.
- Paired comparison: `both`, `neither`, `pdfOnly`, `sourceOnly`, both recalls, `pairedRecallDifference`, exact McNemar `p`, `insufficient`.
- Unpaired: pair id, arm, reason, count. These rows are defects that were not in the paired table.

`interpretation` says the comparison is not conclusive when there are fewer than 10 pairs or any cell has fewer than 5 trials. Otherwise it states the pdf-mutation recall minus the source-native recall, and the McNemar `p`. A recall number here is a count of how the supplied reports matched the sealed gold. It is not a statement that a detector is good or bad. No model-based detector has been run on the paired corpus. That comparison is not measured. Sets with status `source_only` or `refused` are omitted from the manifest, so they are not in these tables.

## Operators

A spec names a `mutationSetId` and a list of mutations. Each mutation has a `defectId`, an operator, `surfaces` (`"*"` or a list), a `family`, a `difficulty`, and a `rationale`.

| Operator | Extra fields | Notes |
| --- | --- | --- |
| `set_text` | `text`, `valueId` | Replaces the bound value. |
| `shift_number` | `delta`, `valueId` | Adds `delta` to a number. |
| `scale_number` | `factor`, `valueId` | Multiplies a number by `factor`. |
| `transpose_digits` | `valueId` | Swaps digit characters in a number. |
| `swap_values` | `withValueId`, `valueId` | Exchanges two bound values. |
| `set_phrase` | `text`, `valueId` | `valueId` must be a `ph_` id. Family `S1` or `D3`. |
| `apply_template` | `template`, `valueId` | Built-in templates `strengthen_claim`, `remove_hedge`, `minimize_limitation`. Phrase rules: `ph_` id, family `S1` or `D3`. |
| `swap_citation` | `citeKey`, `withKey`, optional `occurrence` | One `tex:` surface. Family `D2`. No `valueId`. `occurrence` is 1-based. |

## Ledger `producer` and `kind`

The gold ledger schema is `falsify.red-gold-ledger.v1`.

`producer` is `source-native` when `source_mutator.py` wrote the ledger. `pdf_twin.py` copies that ledger, keeps the defects it actually applied, and sets `producer` to `pdf-mutation`.

`kind` is chosen per defect:

- `source-citation` when the operator is `swap_citation`
- `source-phrase` when `valueId` starts with `ph_`
- `source-value` otherwise

## Gate checks

The ten checks run in this order. One line each:

- `inputs` — the build files match the expected schemas, defects and overrides are lists, and the case id agrees.
- `truth` — clean `paper.tex` matches the resolved case, defect `paper.tex` matches the plan, and ledger surfaces match the overrides that changed.
- `clean_layer0` — Layer 0 signals on the clean PDF are exactly the case's baseline exemptions.
- `defect_survival` — for each text context, the after text occurs more often in the defect PDF than in the clean PDF, and the before text less often, by the same amount.
- `diff_attribution` — every word hunk is covered by a ledger context, every text context matches a hunk, and figure-image changes match the ledger.
- `defect_layer0` — a new Layer 0 signal passes only when its excerpt quotes a changed unit of a defect; any other new signal fails the check.
- `blind` — the blind-bundle check, the stealth audit, PDF metadata, embedded fonts, and forensic signal counters agree across the pair.
- `anonymization` — the PDFs and TeX do not carry user, host, home, or path markers, or a new RED hint token.
- `citations` — every cite key exists, every reference is cited, and the PDF has no undefined cite mark.
- `claims` — numeric tokens printed on each PDF match the resolved clean case. Section and page numbers, citation marks, reference-list entries, table and figure counters, the literal 95% label, and math subscripts stay out of that multiset. A phrase defect, a citation defect, and a value defect whose every ledger context is a figure image are `notApplicable` (reasons `phrase`, `citation`, and `figure_image_only`).

PDF text is compared in one canonical form. Line and page breaks may fall anywhere, including after a real hyphen and inside a hyphenated word. A running page number cannot create or hide a difference. Figure captions and bibliography entries are placed in a stable trailer so a float moving across a page is not a new edit.

## `source_only`

`source_only` means the source-native twin passed the gate and the PDF editor did not apply every defect. A figure context (`figureFile`), a replacement that does not fit on its line (`reflow`), a span that is not found (`not_found`), or any failed unit of a defect (`unit_failed`) is stored as unsupported. The editor does not approximate those edits. If any defect is unsupported, the pair status is `unsupported` or `partial`, and `pair_corpus` records the set as `source_only`. The leak-dependence manifest then has no row for it.

Most hand-written sets (the `m*` specs, including the `*-cite-*` sets) cannot be reproduced by that PDF edit. They were applied in LaTeX: a plotted figure, a citation key, a phrase that changes the line, or several surfaces at once. The PDF editor only replaces text spans that already sit on a line in `sealed/clean.pdf`. The default `build` therefore ignores those specs and selects the `p*-pair-*` files, which were written as line-local text edits. Building just `rct_minimal/mutations/m03-figure-y.json` reported `sourceOnly` 1 and reason `figure_image`. A `source_only` set is not a gate failure. A gate failure is `refused`.

## Exit codes

These are the exits observed by running the commands above and the failure cases below. `0` is success.

Exit `2` is usage or invalid input:

- `python app/local/falsify_cli.py corpus` → `invalid_arguments`
- `python app/local/falsify_cli.py corpus list --root missing-corpus-root` → `file_not_found`
- `python tools/corpus/source_case.py validate missing-case-dir` → `missing_file`
- `python tools/corpus/source_mutator.py plan tools/corpus/fixtures/rct_minimal --spec missing-spec.json` → `schema_invalid`
- `python tools/corpus/pdf_twin.py make missing-bundle --out PDFDIR` → `bundle_invalid`
- `python tools/corpus/twin_gate.py verify missing-build --case tools/corpus/fixtures/rct_minimal` → `missing_file`
- `python app/local/falsify_cli.py corpus verify --build missing-build --case tools/corpus/fixtures/rct_minimal` → `file_not_found`
- `python tools/corpus/pair_corpus.py build --fixtures missing-fixtures --out DIR` → `invalid_input`
- `python tools/corpus/pair_corpus.py build --fixtures tools/corpus/fixtures --out NONEMPTY` → `output_not_empty`
- `python tools/corpus/pair_corpus.py measure` on a corpus whose `runs/` has no JSON → `runs_empty`
- `python tools/corpus/twin_gate.py verify DIR --case tools/corpus/fixtures/rct_minimal --bundle-out BUNDLE` when `BUNDLE` already has files → `bundle_not_empty`
- `python app/local/falsify_cli.py corpus verify --build DIR --case tools/corpus/fixtures/rct_minimal --bundle-out BUNDLE` when `BUNDLE` already has files → `bundle_not_empty`
- A missing subcommand on `source_case.py`, `render.py`, `source_mutator.py`, `twin_gate.py`, `pdf_twin.py`, or `pair_corpus.py` → usage text on stderr, exit `2`

Exit `3` is a refusal. A non-empty `--out` exited `3` with `out_dir_not_empty` for all three of these CLIs (`corpus mutate` uses the same render refusal):

- `python tools/corpus/render.py render tools/corpus/fixtures/rct_minimal --out NONEMPTY`
- `python tools/corpus/source_mutator.py build tools/corpus/fixtures/rct_minimal --spec tools/corpus/fixtures/rct_minimal/mutations/p01-pair-abs-p.json --out NONEMPTY`
- `python app/local/falsify_cli.py corpus build --case tools/corpus/fixtures/rct_minimal --out NONEMPTY`
- `python app/local/falsify_cli.py corpus mutate --case tools/corpus/fixtures/rct_minimal --spec tools/corpus/fixtures/rct_minimal/mutations/p01-pair-abs-p.json --out NONEMPTY`

`twin_gate.py verify DIR --case tools/corpus/fixtures/rct_minimal` on a build whose defect `paper.tex` no longer matched the plan exited `3`. The report had `"pass": false`, check `truth`, code `defect_not_plan`. The same build under `python app/local/falsify_cli.py corpus verify --build DIR --case tools/corpus/fixtures/rct_minimal` exited `3` with `error` `gate_refused` and the same failure. Replacing one arm's `agentId` and running `python tools/corpus/pair_corpus.py measure --corpus DIR --out REPORT.json` exited `3` with `arms_not_comparable`. `pdf_twin.py` returns `3` for `verification_failed` and `2` for its other `PdfTwinError` codes. `render.py` and `source_mutator.py` map a compile timeout to `124`. `vendor.py verify` on this checkout exited `0`; the script returns `3` when the receipt payload is not ok. This run did not hit a compile timeout, a vendor-receipt failure, or a `pdf_twin.py` `verification_failed`.
