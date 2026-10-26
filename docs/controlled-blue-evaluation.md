# Controlled BLUE comparison preparation

Offline check for a later comparison of three input arms, `ORIGINAL`, `E1` and `H1`, under one fixed portable strategy, one requested model and one call budget. The tool is `tools/evaluation`. It does not call a model, read a private paper, score scientific gold, or certify a release.

A summary from this tool means the packet is internally consistent enough to prepare a comparison. It is not a detection rate, a ranking, or evidence that a run succeeded scientifically.

## Fixed factors

These must be the same on every included trial:

- portable strategy: harness id, version, `settings.bundleSha256`, and the portable harness projection
- requested model (`fixed.requestedModel` and `settings.model`)
- app call budget (`maxCalls`) and recorded internal budget (`internalMaxCalls`)
- gold version, protocol `falsify.document-blue.v1`, and case label

`ORIGINAL`, `E1` and `H1` are input arms. Each arm declares its own `sourceHash`, `fileHash` and document `revision`. Different source hashes across arms are case identity. They are not a strategy change. A trial whose source hash, file hash or revision disagrees with its own arm is an incompatible condition and is left out of that arm's denominators.

The recorded `sourceHash` must be the SHA-256 of the supplied segment texts joined by a blank line, the same join as shared-record evidence checks. `fileHash` is echoed and is not recomputed: this tool never sees PDF bytes.

## Portable strategy versus machine config

Strategy identity is the portable projection: harness id, version, bundle hash, instructions, budgets, requested model and scope. These fields are removed before that projection, because they are machine config:

- `adapter.executable`
- `adapter.args`
- `settings.auditDirectory`

The machine config hash is `harness.digest` of the full stored harness (the same canonical JSON digest as `app/local/harness.py`). It is the hash a local profile gets when absolute paths differ. Repeats that share a portable projection and differ only by those machine fields stay on the same strategy. The summary sets `machineConfigIsStrategyIdentity` to false and warns `machine_config_not_strategy_identity` when more than one machine hash appears inside an arm.

A different bundle, instruction, budget or requested model is an incompatible condition even if a companion instance string is reused. Machine hashes are not compared as strategy identity.

The bundle hash is the hash recorded in the packet. This tool does not recompute `bundle_identity()` from the working tree, so a later edit to frozen harness files does not silently rewrite a packet.

## Outcomes and denominators

Each included trial has one primary class:

| Class | When |
| --- | --- |
| `failed` | Job state `failed`. No final result is accepted. |
| `cancelled` | Job state `cancelled`. The result is discarded. |
| `refusal` | Completed response status `refusal` and no findings. |
| `abstain` | Completed response status `abstain` and no findings. |
| `completed-zero-findings` | Completed status `ok` and an empty findings list. |
| `human-unreviewed` | Completed status `ok` with findings and no condition-matched human review. |
| `matched-findings` | A condition-matched human review accepts at least one `matched` judgment. |
| `human-reviewed-no-match` | A condition-matched review exists and accepts no `matched` judgment. |
| `gold-unknown` | Completed status `ok` with findings and a review, while gold version is absent. Match counts stay `unknown`. |

`failed` and `cancelled` are in `attempts` and are not in `completedResponses`. They are also outside the zero-findings denominator. A failed job with no final findings is never `completed-zero-findings`. The preparer rejects a failed or cancelled trial that still carries a result object (`discarded_result`), matching the companion rule that cancel drops the result and failure does not store one.

The zero-findings denominator is included trials whose completed status is `ok`. Refusal and abstention have their own counts and are not zero findings.

`matched-findings` counts human judgments. It is not a detection score. `detectionCorrectness` is `not-inferred`. `ranking` is `not-computed`. Subjective review verdicts (`supported`, `unsupported`, `mixed`, `uncertain`) are stored on the review and are not turned into a mean.

Calls are `unknown` unless every included trial in that arm reports an integer. A missing count is not zero. Cost is always `unknown`: this preparer accepts only `cost: null` because it has no verified spend.

## Models

`model.requested` is the requested id and must match the fixed requested model. The BLUE result field `model` must equal `harness.model_label` for that harness. For a stdio harness that label is `custom-stdio-model-unverified`. That placeholder is not a verified model.

`model.verified` is reported only when it is a non-empty string and `provenance` is `local-codex`, and then only as `{observed, certified: false}`. Any other claim, including a manual or imported record that names a model, is `unknown` (`unverified_model`). If any included trial lacks one shared observation, the arm and the packet stay `unknown`.

## Gold

Gold in a packet is an operator-supplied fixture list with `scientificGold: false`. `scientificGold: true` is rejected. This repository does not contain scientific gold, and the tool does not invent any.

Duplicate gold ids are not usable. Judgments on them are not matches (`duplicate_gold`), and side-by-side preparation is not ready. A judgment whose gold id is absent is `unmatched_gold` and is not a match. An explicit `unmatched` or `duplicate` judgment is counted on its own field. Gold items nobody judged are not automatically misses.

If `fixed.goldVersion` is null, the packet must not include a gold object. Matched findings, unmatched judgments and the usable-item count are the string `unknown`, not zero.

Quote overlap is not used to create a match. A `matched` judgment counts only when the human record names a gold id and a finding id that is actually on that completed response.

## Blind inputs, frozen responses, human validation

A BLUE request may contain only the document-blue request fields: schema, revision, request id, source hash, segments (`id`, `label`, `text`), maxCalls, consent, the harness, and execution consent. Keys for gold, plans, reviews, filenames, prior findings or secrets are a blind-protocol violation and fail the packet. Segment text in fixtures must be synthetic. Do not commit private papers.

A completed result is immutable: `rawResponseSha256` must be the canonical digest of the stored result object, and `result.harness` must be the same object as the trial harness. A mismatch is `response_not_immutable` or `harness_not_frozen` and the trial is outside the denominators. The tool does not rewrite the harness or the response. The digest covers the stored final response, not an unseen provider event stream.

Findings are checked with `blue_service.validate_findings`: exact unique finding quotes, evidence present in the supplied segment, and no findings on refusal or abstention. A failed check is `evidence_rejected`. Passing that check does not mean the finding is scientifically correct.

Human reviews count only when `caseLabel` and `protocolVersion` match the fixed conditions. A mismatched review does not hide the trial; the trial stays `human-unreviewed`. Two matching reviews on one trial are not applied.

Repeats are separate trials. Two included repeats in one arm that share `requestBytesDigest` or `rawResponseSha256` are not independent and are removed from denominators.

## CLI

From the repository root, with the system Python and no extra packages:

```bash
python tools/evaluation/cli.py tools/evaluation/fixtures/comparable.json
python -m unittest discover -s tools/evaluation -p "test_*.py" -q
```

Exit 0 prints a `falsify.controlled-blue-summary.v1` object. The packet can still carry warnings. `comparisonReady` is true only when every arm has an included trial, gold version is present, gold ids are unique, and no trial was removed for an incompatible condition or a non-independent repeat.

Exit 2 prints `ok: false` and `errors`. That is a structural refusal (schema, blind-input key, scientific-gold flag, unreadable file), not a model failure.

`--out path` also writes the summary. The command does not contact a network and does not read `.local` audits.

## Limits

- No model call, provider login, deployment, or production database.
- No private paper, gold set, or user record. The committed fixture is synthetic text.
- Bundle hash and file hash are taken from the packet, not recomputed from a tree or a PDF.
- Provider raw event streams are not in the packet. Immutability is the stored final response.
- Cost is not representable here and stays unknown.
- A local-codex observation is still not a certified model id.
- Identical final responses on different arms are not removed.
- This is preparation for a controlled comparison, not a performance claim.
