# Experimental log

## 1. Experimental Setup

Two-arm comparison of a Kelp-9 lozenge with a blank lozenge at Amber Quay Infirmary and Saltglass Day Ward. The outcome is time to return of linen wheeze, recorded in bands ending at 3, 6, 9, and 12 months. Each band is one product-limit step. The count at risk for the next band is the count at risk minus events minus censored. Percentages, Greenwood standard errors, and interval endpoints are taken from the unrounded product and then rounded half up to one decimal. The interval uses the multiplier 1.96 on the probability scale.

## 2. Raw Numeric Data

### Table T1: Allocation and the opening of follow-up

| Step | Count |
| --- | --- |
| Screened | {{v:n_screened}} |
| Criteria not met | {{v:n_inelig}} |
| Declined | {{v:n_declined}} |
| Excluded before randomization | {{v:n_excluded}} |
| Randomized | {{v:n_randomized}} |
| Allocated to Kelp-9 | {{v:n_alloc_k}} |
| Allocated to blank | {{v:n_alloc_b}} |
| Kelp-9 missed the opening visit | {{v:n_miss_k}} |
| Blank missed the opening visit | {{v:n_miss_b}} |
| Kelp-9 entered follow-up | {{v:n_enter_k}} |
| Blank entered follow-up | {{v:n_enter_b}} |

### Table T2: Life table and product-limit survival percent

| Arm | Month | Entered | Events | Censored | Survival |
| --- | --- | --- | --- | --- | --- |
| Kelp-9 | {{v:m3}} | {{v:n_enter_k}} | {{v:d_k0}} | {{v:c_k0}} | {{v:s_k3}} |
| Kelp-9 | {{v:m6}} | {{v:n_k1}} | {{v:d_k1}} | {{v:c_k1}} | {{v:s_k6}} |
| Kelp-9 | {{v:m9}} | {{v:n_k2}} | {{v:d_k2}} | {{v:c_k2}} | {{v:s_k9}} |
| Kelp-9 | {{v:m12}} | {{v:n_k3}} | {{v:d_k3}} | {{v:c_k3}} | {{v:s_k12}} |
| Blank | {{v:m3}} | {{v:n_enter_b}} | {{v:d_b0}} | {{v:c_b0}} | {{v:s_b3}} |
| Blank | {{v:m6}} | {{v:n_b1}} | {{v:d_b1}} | {{v:c_b1}} | {{v:s_b6}} |
| Blank | {{v:m9}} | {{v:n_b2}} | {{v:d_b2}} | {{v:c_b2}} | {{v:s_b9}} |
| Blank | {{v:m12}} | {{v:n_b3}} | {{v:d_b3}} | {{v:c_b3}} | {{v:s_b12}} |

## 3. Observations

Screened adults minus the two early exclusions equal the randomized count. The two allocation counts equal the randomized count. Each arm's allocation minus the adults who missed the opening visit equals the first count at risk. Within an arm, each later count at risk equals the previous count minus events minus censored. Survival percents are the product-limit values for those counts.
