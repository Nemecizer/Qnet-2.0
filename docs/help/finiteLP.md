# FINITE-BUFFER LP — fBNAlp

## WHAT IT IS

Linear-programming relaxation of the SRBM stationary distribution. Restricts the search to a polynomial basis on the hypercube and enforces the BAR equation as LP equality constraints. Solves with HiGHS, GLPK, or CPLEX. Cheap and naturally sparse. Implementation: `finite/fBNAlp/fBNAlp_solver`.

## HOW IT WORKS

1. Build SRBM primitives (with Loss/BAS popup correction).
2. Discretize the hypercube with a tensor-product grid of N nodes per dimension and a polynomial basis of degree m per dimension.
3. For each grid node, write the BAR equation as a linear equality constraint over the basis coefficients. Normalize to integrate to 1.
4. Solve the LP. The objective can be set to maximize entropy or just feasibility; both work.
5. Extract per-station means via integration of the basis polynomial.

## WHEN IT WORKS WELL

- Higher-d networks (d = 5, 6) where Spectral and FEM run out of memory. LP's sparse structure scales better.
- Cases where the SRBM density is smooth — the LP relaxation converges quickly to a clean answer.
- Heavy-traffic regimes (with BAS or Loss correction applied).

## WHEN IT DOESN'T WORK + ALTERNATIVES

- Networks where the LP becomes infeasible (numerical issue with very heavy traffic). Symptom: solver reports infeasible status.
- → Try a different solver (HiGHS / GLPK / CPLEX) via Settings ▸ Finite-Buffer LP. Some are more numerically robust.
- → Or switch to Spectral / FEM.
- Very small networks (d = 2, low buffer). The grid is coarse and Spectral / FEM both give better answers for the same effort.
- → Use Spectral or FEM.
- Light-traffic (ρ ≤ 0.5). Same diffusion-approximation bias as Spectral.
- → Use M/M/1/K closed form or simulation.

## ROBUSTNESS / CURSE OF DIMENSIONALITY

Cost: O((N × m)^d) LP variables, but the constraint matrix is sparse. HiGHS scales well to ~100K variables. Practical envelope:

```
d = 2:  N = 30, m = 8, runs in seconds
d = 3:  N = 20, m = 5, tens of seconds
d = 4:  N = 8,  m = 3, ~ a minute
d = 5:  N = 6,  m = 3, minutes
d ≥ 6:  out of practical range
```

A problem too large to index is refused before any memory is taken, in one line: "fBNAlp: this problem is too large for the LP solver: dimension d with grid\_n n and basis\_m m gives more grid points, basis functions or matrix entries than it can index". The limit is about two thousand million of each. Use a smaller grid or degree, or fewer stations. Qnet applies the same limits before it starts the solver, so a run from the app is refused with this sentence in the Status pane and nothing is launched. At the recommended settings the limit is reached at nine stations.

## HINTS FOR BETTER RESULTS

- Stick with HiGHS unless you have a CPLEX license; it's the fastest open-source LP solver and the implementation is well-tuned.
- Settings ▸ Finite-Buffer LP exposes grid type (uniform vs. Chebyshev) and basis normalization. Chebyshev grids cluster nodes near the boundaries — better for boundary-layer-heavy SRBMs (heavy traffic).
- For convergence checking, increase grid\_n by 2 and rerun; basis\_m by 1 should cover the same ground.
- Compare with Spectral and FE as a cross-check. All three solve the same SRBM, so disagreement points to a solver artifact in one of them.

## TRY IT

[Example network: two stations and two customer classes with finite buffers (2d2cfin)](qnet-example:2d2cfin?run=run:finite-lp)

Read the mean reported occupancy and the throughput at each station, then run the finite simulation and see how close the two are in the Agreement view.
