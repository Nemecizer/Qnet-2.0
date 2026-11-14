# SPECTRAL METHOD — FINITE BUFFERS (fBNAsm / `srbm_solver`)

## WHAT IT IS

Solves the SRBM stationary PDE on a bounded hypercube \[0, K\_1\] × ... × \[0, K\_d\] using a polynomial basis fit. Same technique as the infinite-buffer Spectral method, but the polynomials live on a bounded domain and the upper-face reflection adds extra boundary measures. Implementation: `finite/fBNAsm/srbm_solver`.

## HOW IT WORKS

1. Build SRBM primitives (drift θ, covariance Γ, reflection R) plus the hypercube extents (a\_i = buffer\_i + servers\_i) from the network. With Loss/BAS popup correction, drift and α are pre-corrected by the SRBM exporter.
2. Choose a polynomial basis on the hypercube — products of shifted Legendre or Chebyshev polynomials of degree ≤ m.
3. Form the BAR-orthogonality system over both interior and 2d boundary faces. Each face contributes a boundary measure term to the matrix.
4. Solve the linear system. Extract per-station means and throughputs (Γ\_i = μ\_eff\_i − δ\_lower\_i, clipped to \[0, min(μ\_eff, α)\] to suppress numerical artifacts).

## WHEN IT WORKS WELL

- Heavy-traffic finite-buffer networks. Same heavy-traffic story as the infinite case: SRBM is asymptotically exact as ρ → 1.
- Loss-mode comparisons (with Loss correction enabled automatically by the popup). Closes typical 25% over-prediction down to ~5%.
- d ≤ 4 with modest mesh / degree.
- Tandem and feed-forward networks where the SRBM upper-face reflection is a reasonable approximation to the actual blocking semantics.

## WHEN IT DOESN'T WORK + ALTERNATIVES

- Strong BAS back-pressure without correction. Raw Spectral under-predicts upstream queues by 10–15% under BAS sim.
- → Pick BAS / BAS+ExtLoss in the popup so the BAS correction is applied. Or accept ~3% residual error.
- Small single-class M/M/1 loss tandems with d ≤ 4. CTMC gives the exact answer with no diffusion approximation.
- → Look at the CTMC (exact loss) column; trust it as the benchmark only when Loss is the selected protocol.
- d ≥ 5: cost prohibitive for high-degree basis on bounded domain (state space cap typically forces m ≤ 4).
- → Use Finite-Buffer LP (lower memory) or simulation.
- Light-traffic (ρ ≤ 0.5). The diffusion approximation is biased here.
- → Use the M/M/1/K closed form for single-class, or simulation for general networks.

## ROBUSTNESS / CURSE OF DIMENSIONALITY

Cost: O(m^(2d)) memory, O(m^(3d)) time — same as infinite Spectral, but the basis must also fit boundary terms which inflates memory by ~2d. Practical envelope:

```
d = 2:  m ≤ 16, runs in seconds
d = 3:  m ≤ 8,  runs in tens of seconds
d = 4:  m ≤ 6,  minutes
d ≥ 5:  m ≤ 4,  approaching out-of-range
```

## HINTS FOR BETTER RESULTS

- Pick the popup choice that matches your real system (Loss / BAS / BAS+ExtLoss) — the matching SRBM correction is applied automatically and closes the model gap.
- Convergence check: rerun with degree m → m + 2; if E\[X\_i\] moves > 1% the answer hasn't converged.
- Compare with FE and LP (always shown side-by-side in Run Comparison). All three solve the same SRBM but with different numerical approaches; agreement to within 1% means the SRBM has converged. Disagreement means at least one solver hasn't.
- For ρ \< 0.85 expect systematic bias — see "About finite-dimensional SRBM in a Hypercube" for diagnostics.

## TRY IT

[Example network: two stations in a line with finite buffers (2dtandem)](qnet-example:2dtandem?run=run:spectral-finite)

Keep the settings the sheet offers. Read the throughput: with finite buffers some customers are blocked or lost, and the throughput shows how many get through.
