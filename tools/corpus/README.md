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
