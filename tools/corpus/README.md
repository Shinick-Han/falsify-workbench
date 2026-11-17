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
