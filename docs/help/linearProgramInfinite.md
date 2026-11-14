# LINEAR PROGRAM — INFINITE BUFFERS (BNAlp / `srbm_lp`)

## WHAT IT IS

A linear-programming relaxation of the SRBM stationary distribution on the positive orthant, after Saure, Glynn and Zeevi (2008). Instead of solving the Basic Adjoint Relationship (BAR) exactly, it asks for a density that satisfies the BAR at a finite set of grid points and is spanned by a small polynomial basis, then lets an LP solver pick the coefficients. The answer is a set of stationary moments — the mean workload per station, which Qnet converts to a mean queue length with the effective service rate μ\_eff. Implementation: `infinite/BNAlp/srbm_lp`.

## HOW IT WORKS

1. Build the SRBM primitives (drift θ, covariance Γ, reflection R) from the network exactly as the spectral method does.
2. Lay a grid S\_n over the orthant with n points per coordinate. Three spacings are offered: exponential (points thin out with distance from the origin, matching the exponential decay of the density), dyadic (halving intervals) and exponential with random jitter (breaks grid artefacts at the cost of reproducibility between runs).
3. Choose m monomial basis functions per coordinate. The density is represented by its moments against this basis, so m is the number of moments the LP can see.
4. Write the BAR as one linear equality per grid point and basis function, add the normalisation and non-negativity constraints, and solve the LP. The solver is HiGHS by default; GLPK and CPLEX are used when they are compiled in and selected.
5. Read the first moments off the solution: E\[Y\_i\] per station.

## WHAT THE PARAMETERS MEAN

- Grid size n — constraint points per dimension. More points tighten the relaxation and grow the LP as n^d. Leave blank for a size chosen from the number of stations:

```
d = 1, 2:  n = 100, m = 6
d = 3:     n = 25,  m = 5
d = 4:     n = 12,  m = 4
d = 5:     n = 10,  m = 3
d = 6:     n = 8,   m = 3
d ≥ 7:     n = 6,   m = 3
```

- Basis size m — monomial basis functions per coordinate. More functions fit a richer density and make the program harder to condition; above m ≈ 8 switch on basis normalisation.
- Grid type — exponential is the paper's choice and the right default; dyadic is cheaper on very wide domains; exponential (random) is for checking that a result is not a grid artefact.
- LP backend — Auto lets the binary pick the first solver it was built with (HiGHS in the shipped build).
- Smoothness weight — a penalty on the total variation of the fitted density, applied lexicographically after the BAR residual (paper §6.3). Zero disables it; 0.1–1 smooths the marginals when the solution shows ripples between grid points.
- Normalise monomial basis — scales each monomial row by the grid extent so the constraint matrix is well conditioned. Strongly recommended for d ≥ 3 or m ≥ 6.
- Multi-level refinement — runs a coarse preview at half the grid (never below 6 points) first, then the full grid, so a long run shows a first answer early. Only applies when n ≥ 8.

Settings ▸ Linear Program keeps the defaults; tick "Ask for parameters before each run" there and Run ▸ Run Linear Program opens the parameter sheet every time.

## WHEN IT IS TRUSTWORTHY

- Heavy traffic (ρ ≥ 0.8 at the bottleneck), where the SRBM itself is a good model of the network.
- Moderate dimension (d ≤ 4) with the automatic grid: the first moments agree with the spectral method to within a few percent and the run takes seconds.
- As a cross-check on the spectral method: both solve the same SRBM, so a disagreement between them points at a discretisation error in one of them, not at the model.

## WHEN IT IS NOT

- Light traffic (ρ ≤ 0.5): the diffusion approximation itself is off, whichever solver is used. Use QNA or simulation.
- d ≥ 5 with a grid the LP can afford: the relaxation is too loose to trust beyond the first moment.
- → Compare with SRBM MLMC (BNAmc), which has no spatial grid.
- An infeasible LP (the solver reports it): usually heavy traffic with an unnormalised basis.
- → Turn on basis normalisation, lower m by one, or change the backend.

## WHAT IT PRINTS

Per station: E\[Q\_i\] (workload E\[Y\_i\] × μ\_eff,i), plus the solver name, the LP objective and the wall-clock time. This method emits moments only — no ρ, Γ or sojourn rows — so its column in Run Comparison is shorter than the others.

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p30.inf)](qnet-example:OpenJackson.d2.feedback.p30.inf?run=run:lp)

The Linear Program reports one quantity per station, the mean reported occupancy. Read it beside the station on the canvas or in the Table view of the Results pane.
