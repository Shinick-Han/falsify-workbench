# BLUE Evidence v0.4.2 (argument outline + quote gate)

Extends `v0.4.1` and delegates inner model stages to `v0.3.5` without modifying `v0.3.1`–`v0.4.1`.

## What v0.4.2 Adds
- **Argument outline.** Before the model stage, `paper_argument_outline.audit_argument_outline` builds a per-section topic-sentence outline and a claim–evidence map from the paper text. The compact digest is stored on `deterministicTriage.argumentOutline` and copied into the review request as `argumentOutlineDigest`.
- **D3/S1 advisory hints.** `argumentHints` may include `conclusion_claim_without_results_support`, `causal_or_absolute_language_without_hedge`, and `limitations_absent`. Each row is `advisoryOnly` and labelled `unverified`. This auditor confirms nothing: its `signals` list stays empty. Values already reported by the internal-consistency mismatch signals, and sentences already covered by the flow/spin triage hints, are not repeated.
- **Devil's advocate block.** `devilsAdvocate` tells the reviewer to argue that each conclusion does not follow from the results, to check unsupported quantitative claims against the paper text, and to report only findings it can quote verbatim. The block does not add a model call.
- **Quote / Zero-Drop gate.** Post-model enforcement is still `v0.3.9`'s quote gate (`reconcile_candidate_ledger`, one repair turn, downgrade of ungrounded defect quotes to `확인필요`). Predecessor bundles are not edited.

D3/S1 output is advisory. It is not a confirmed defect.

Method adapted from Ar9av/PaperOrchestra (MIT), commit 6a31913.

## Local Profile Build & Offline Testing
```powershell
python app/examples/evidence_blue_v042/build_profile.py
python -m unittest discover -s app/examples/evidence_blue_v042 -p "test_*.py" -v
```
`test_offline.py` uses standard-library `unittest` only. Transports stay injected; tests do not open the network.
