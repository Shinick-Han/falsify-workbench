# Experimental log

## 1. Experimental Setup

Fictional single-cohort comparison of the QS-4 strip with a two-reader panel for nacre spot at Brindle Annex Clinic and Quill Lane Ward. No real participants were enrolled. Percentages are 100 times the stated numerator divided by the stated denominator, rounded half up to one decimal. Interval endpoints are 95% Wald bounds with multiplier 1.96, rounded half up to one decimal, and contain the printed percentage.

## 2. Raw Numeric Data

### Table T1: Index strip against the panel reference

| Reading | Reference positive | Reference negative | Row total |
| --- | --- | --- | --- |
| Strip positive | {{v:tp}} | {{v:fp}} | {{v:n_idx_pos}} |
| Strip negative | {{v:fn}} | {{v:tn}} | {{v:n_idx_neg}} |
| Column total | {{v:n_ref_pos}} | {{v:n_ref_neg}} | {{v:n_analyzed}} |

### Table T2: Scores on the QS-4 strip

| Score | True positive | False positive | False negative | True negative | Sensitivity | Specificity |
| --- | --- | --- | --- | --- | --- | --- |
| {{v:cut_main}} | {{v:tp}} | {{v:fp}} | {{v:fn}} | {{v:tn}} | {{v:sens_pct}} ({{v:sens_lo}} to {{v:sens_hi}}) | {{v:spec_pct}} ({{v:spec_lo}} to {{v:spec_hi}}) |
| {{v:cut_high}} | {{v:tp6}} | {{v:fp6}} | {{v:fn6}} | {{v:tn6}} | {{v:sens6_pct}} ({{v:sens6_lo}} to {{v:sens6_hi}}) | {{v:spec6_pct}} ({{v:spec6_lo}} to {{v:spec6_hi}}) |

## 3. Observations

The case is fictional. Screened adults minus the two early exclusions equal the eligible count, and the eligible count minus the two later exclusions equals the analyzed count. The four cells at each score add to the analyzed count, and each percentage matches its numerator and denominator.
