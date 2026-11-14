# SPECTRAL METHOD — INFINITE BUFFERS (BNAsm / `bnet`)

## WHAT IT IS

Solves the SRBM stationary PDE on the positive orthant directly, using a polynomial basis fit. Returns the joint stationary density p(x\_1, ..., x\_d) and per-station moments E\[Q\_i\]. Implementation: `infinite/BNAsm/bnet`.

## HOW IT WORKS

1. Build SRBM primitives (drift θ, covariance Γ, reflection R) from the queueing network via the Harrison–Reiman / GJN workload transformation.
2. Choose a polynomial basis (default: monomials of total degree ≤ m; optionally Legendre for better conditioning at large m).
3. Form the BAR-orthogonality system: for each pair of basis functions (f, g), compute the matrix entry

   ```
    A_{fg} = ⟨L* f, g⟩
   ```

   where L\* is the adjoint generator of the SRBM. The density coefficients satisfy A·c = b plus a normalization constraint.

4. Solve the linear system. Extract per-station means by integrating x\_i against the polynomial density.

## WHEN IT WORKS WELL

- Heavy-traffic networks (ρ ≥ 0.92). Spectral converges to the heavy-traffic SRBM limit, so the diffusion approximation is asymptotically exact and the polynomial basis captures it.
- Smooth densities. Light- to moderate-traffic networks where the orthant density is smooth (no boundary layers) admit clean polynomial fits at modest degree.
- Low-d networks. d ≤ 3 with degree m = 10 rivals analytical closed forms to several decimal places.
- Re-entrant networks where the workload is well-mixed across stations — Spectral handles non-trivial Γ off-diagonals cleanly because the basis spans the full d-cube.

## WHEN IT DOESN'T WORK + ALTERNATIVES

- Moderate traffic (ρ ≤ 0.85): Spectral systematically under-predicts queue means by 5–15% on Markovian-style random networks. The diffusion approximation itself is biased here, not the basis fit.
- → Use QNA or SBD for accurate moment estimates at moderate ρ.
- Light traffic (ρ ≤ 0.5): the M/M/1 geometric tail dominates and the SRBM Gaussian tail under-counts.
- → Use the Jackson formula (Help ▸ Method Reference ▸ Analytical Tractability) directly when applicable, or QNA for non-Jackson systems.
- d ≥ 5: cost grows as O(m^(2d)) for matrix assembly and O(m^(3d)) for solve. At d = 5, m = 6 the matrix is already ~16K × 16K.
- → Use QNA / RQNA / SBD (cheap regardless of d). Or SRBM MLMC when statistical noise is acceptable.

## ROBUSTNESS / CURSE OF DIMENSIONALITY

Cost: O(m^(2d)) memory, O(m^(3d)) time. Practical envelope:

```
d = 2:  m ≤ 16, time < 1 s
d = 3:  m ≤ 10, time ~ a few seconds
d = 4:  m ≤ 8,  time ~ a minute
d ≥ 5:  m ≤ 5,  time ~ minutes; basis under-resolved
```

Failure modes by dimension:

```
d ≤ 4:  numerically robust; use Legendre basis at m > 8 to
        avoid monomial-basis ill-conditioning.
d = 5:  watch for plausibility — saturated values at low m
        are the basis, not the answer.
d ≥ 6:  basically out of practical range — switch methods.
```

## HINTS FOR BETTER RESULTS

- Enable Legendre basis (Settings ▸ Spectral Method) whenever m > 8. The orthogonal basis avoids the explosive condition number of monomials at high degree.
- Convergence check: rerun with m → m + 2; if E\[Q\_i\] moves by > 1% the answer hasn't converged — raise m further.
- For ρ \< 0.85 networks, expect the systematic Spectral bias and don't chase it by raising m — the bias is in the model, not the basis. Compare against QNA to bound the gap.
- If the network is approximately feed-forward and ρ is moderate, the Sequential Bottleneck Decomposition (SBD) is comparable in accuracy and ~ 100× faster.

## TRY IT

[Example network: three stations in a line (3dtandem.inf)](qnet-example:3dtandem.inf?run=run:spectral-infinite)

Keep the settings the sheet offers. In the Results pane, read the mean number in system at each station; then press Check with Another Method to see how close this diffusion model comes on a small network.
