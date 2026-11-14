# Exact SRBM fixtures

The SRBM fixtures of `Plans.md` section 4 (E04–E08), with an independent check
of every expected value and a runner that measures every SRBM solver in the
tree against them. Before these existed, two SRBM solvers agreeing was the only
evidence available. Now each solver is compared with an exact answer.

These are **SRBM** oracles. A solver that matches them solves the Brownian
model accurately; that says nothing about how well the Brownian model
approximates a queue (`docs/STEADY_STATE_METHODS.md`).

## Files

| File | What it does |
|---|---|
| `make_fixtures.py` | Writes `fixtures/*.json` from closed forms. |
| `oracle_check.py` | Re-derives every expected value without a solver: the numbers `Plans.md` prints, the BAR identities (θ + Rβ = 0, the transform identity, the 1-D polynomial identities), exact rational moments for E07, 80-digit hypoexponential tails for E08. Includes two negative controls: a transposed R must break the transform identity, and P16's misprinted r^(+1/2) density must give means (0.75, 1.40625), not (0.5, 0.75). |
| `run_solvers.py` | Runs BNAsm, BNAfm, BNAlp, BNAmc, BNAbb, BNAalr, fBNAsm, fBNAfm and fBNAlp on every fixture they accept, at the GUI's default settings, and applies `ledger.json`. |
| `ledger.json` | The gate for each fixture/solver cell, with the reason for every known deviation. |

```sh
python3 validation/research_fixtures/oracle_check.py      # about 3 s
python3 validation/research_fixtures/run_solvers.py       # about 20 s; needs ./build_all_algorithms.sh
python3 validation/research_fixtures/run_solvers.py --only E07 --solver BNAlp
```

`validation/steady_state_suite.sh` runs both.

## Fixture format

One JSON file per fixture: `model`, `expected`, `evidence` (the `Plans.md`
0.3 vocabulary: `published_exact` or `derived_exact`), `source` and `notes`.

- `covariance` is the covariance Γ, never a square root of it or Γ/2.
- `reflection` is d×d and row-major. **Column** j is the direction pushed along on face {z_j = 0}.
- `upper_reflection` and `upper_bounds` (box only) do the same for the faces {z_j = K_j}.
- `boundary_rates` are regulator rates E[Y_j(1)], not probabilities.

This is a local format. When F00 freezes the shared model schema
(`docs/ROADMAP.md`), these files should move to it; their numbers carry over
unchanged.

| Fixture | Domain | Law | What it catches |
|---|---|---|---|
| E04 | orthant, d = 1 | Exp(1) | confusing Γ with Γ/2 |
| E05a, E05b | box [0, 2] | truncated exponential; uniform | upper-face handling, 1-D paths |
| E05c | 2-D box, sides 2 and 3 | independent truncated exponentials, one drifting up | swapped axes or faces |
| E06 | orthant, d = 2 | skew-symmetric product form, nonsymmetric R | reading R by rows |
| E07 | orthant, d = 2 | Harrison's non-product form, Cov = 3/32 | any product-form shortcut |
| E08_d3, _d5, _d20, _d30 | orthant | Dai–Zhang family, Z_j ~ Exp(j) | high-dimensional accuracy |

## Results on 21 Oct 2026 (GUI defaults)

Maximum relative error of the stationary means. "Exact" means below 1e-5.

| Solver | E04 | E05a | E05b | E05c | E06 | E07 | E08 d3 | E08 d5 | E08 d20 | E08 d30 |
|---|---|---|---|---|---|---|---|---|---|---|
| BNAsm | exact | | | | exact | 0.24% | exact | exact | 8e-6 | Cholesky breakdown |
| BNAlp | exact | | | | 6.8% | 3.0% | 6.1% | 26% | d > 10 | d > 10 |
| BNAmc (MLMC) | 3.3% | | | | 2.5% | 1.4% | 5.1% | 5.5% | 28%¹ | 31%¹ |
| BNAbb | exact | | | | exact | bounds contain the exact means | exact | exact | exact | exact |
| BNAalr | exact | | | | exact | 4.2% | exact | exact | exact | exact |
| BNAfm | K ≥ 2 | | | | diverges | diverges | > 2 min | refused | K ≤ 8 | K ≤ 8 |
| fBNAsm | | exact | exact | exact | | | | | | |
| fBNAfm | | 7.5e-5 | exact | 1.1e-4 | | | | | | |
| fBNAlp | | 3.7e-5 | exact | 0.13% | | | | | | |

¹ The relative error of a mean as small as 1/30 is large even when the absolute
error is at the requested ε = 0.01. The MLMC errors are up to 3.6 standard
errors, because the standard error excludes discretization and horizon bias.

The sweep found and fixed two defects:

- **fBNAfm in one dimension** skipped every boundary term (an `if (K > 1)`
  guard), so the GUI's FEM on a single finite-buffer station returned E[X] = 14.9
  in a box of length 11. The exact value is 4.4616, which fBNAsm and fBNAlp
  both give. It is now exact to the mesh.
- **MLMC in one dimension** used one level and 20 sample paths whatever ε was
  requested. The cause was the log(log d) term of its level count, which is −∞
  at d = 1. E04 read 0.495 against an exact 1; it now reads 1.033 ± 0.034.

It also found these, recorded in `ledger.json` and not fixed:

- BNAfm's box-growth loop diverges whenever a coordinate has zero drift. It
  then prints the last iterate with exit status 0. The GUI does not call BNAfm.
- BNAsm cannot factor its matrix at d = 30, even at degree 3, the highest
  degree the GUI allows there.
- BNAlp at the GUI's grids is off by 3–26%. The error falls as the basis
  grows.

## Not yet here

- **Other `Plans.md` fixtures:** the queue fixtures (E01–E03), E09–E14 and
  BAR face-transform checks for E07 are not built.
- **Other exact cases:** Dieker–Moriarty 2-D cases, oblique box product forms
  and Dai–Miyazawa decay rates are missing. They need the original papers: the
  Williams (1987) upper-face condition and the sign of each Dieker–Moriarty
  coefficient have not been checked against them.
- **Existence tests:** the solver-independent tests (completely-S, R⁻¹θ < 0,
  the 2-D and 3-D recurrence decisions) live in `Sources/Qnet/SRBMExistence.swift`
  and are checked by `validation/srbm_existence_check.sh`.
