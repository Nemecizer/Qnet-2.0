# FINITE ELEMENT METHOD — fBNAfm

## WHAT IT IS

Tensor-product finite-element discretization of the SRBM PDE on the bounded hypercube. Solves the stationary density via direct sparse linear solve (CHOLMOD / UMFPACK). Two sub-solvers shipped: Gauss-Legendre (deterministic quadrature) and CBC Quasi Monte Carlo (lattice rule). Implementation: `finite/fBNAfm/bna_fm_gauss` (default) and `finite/fBNAfm/bna_fm_cbc`.

## HOW IT WORKS

1. Build SRBM primitives (with Loss/BAS popup correction applied by the SRBM exporter if relevant).
2. Build a tensor-product mesh over the hypercube of size (mesh)^d cells. Over each cell, the density is represented by a polynomial basis (typically degree 2 per dimension).
3. Assemble the BAR matrix: ⟨L\* φ\_i, φ\_j⟩ for every pair of basis functions, plus boundary integrals at the upper and lower faces.
4. Solve the resulting sparse linear system (CHOLMOD for symmetric positive-definite parts, UMFPACK for the rest).
5. Extract per-station moments by integrating x\_i against the discrete density.

## WHEN IT WORKS WELL

- Networks where the SRBM density has sharp features that polynomial basis (Spectral) can't capture. The tensor-product mesh resolves boundary layers cleanly.
- d ≤ 3 with mesh ≥ 12. Best accuracy among the three SRBM algorithms in this regime.
- Smooth-coefficient SRBMs where the linear solve is well-conditioned.

## WHEN IT DOESN'T WORK + ALTERNATIVES

- d ≥ 5. Mesh count grows as mesh^d; even mesh=4 gives 4^5 = 1024 cells, often slow to assemble.
- → Switch to CBC Quasi-MC sub-solver (Settings ▸ Finite Element ▸ Quadrature method = CBC quasi-Monte Carlo). It absorbs dimension cost much better than Gauss-Legendre at the price of a small integration error.
- → Or use Spectral with low degree (cheap) or LP (sparse and dimension-tolerant).
- Very heavy traffic (ρ ≥ 0.97). The boundary layer is sharp and needs a refined mesh near the upper face.
- → Increase mesh and/or use BAS correction; or compare with Spectral which handles heavy traffic gracefully.
- Memory pressure. Sparse matrices for high mesh / high d can exceed memory. The runtime auto-caps mesh size by dimension to keep things tractable.

## ROBUSTNESS / CURSE OF DIMENSIONALITY

Cost: assembly O(mesh^d), solve O((mesh^d)^1.5) for sparse Cholesky in the well-conditioned case. Practical envelope:

```
d = 2:  mesh ≤ 30, runs in seconds
d = 3:  mesh ≤ 15, tens of seconds
d = 4:  mesh ≤ 8,  ~ a minute
d ≥ 5:  mesh ≤ 4,  switch to CBC sub-solver
```

## HINTS FOR BETTER RESULTS

- For d ≤ 4, Gauss-Legendre with mesh = 20 is the gold standard among approximations. Use it as a baseline when comparing Spectral / LP.
- For d ≥ 5, CBC Quasi-MC is the practical choice.
- Convergence check: double the mesh and rerun; if E\[X\_i\] moves > 1% the mesh wasn't fine enough.
- Memory cap: the GUI auto-limits mesh by dimension. To override, use `bna_fm_gauss` directly from the command line with explicit mesh value.

## TRY IT

[Example network: the two-station network of Dai and Harrison (1991) (DaiHarrison91.d2.c1.fin)](qnet-example:DaiHarrison91.d2.c1.fin?run=run:finite-element)

Keep the mesh the sheet offers. Compare the mean reported occupancy with the Spectral Method on the same network: both solve the same Brownian model in a box.
