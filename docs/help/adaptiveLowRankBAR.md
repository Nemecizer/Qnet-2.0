# ADAPTIVE LOW-RANK BAR — ORTHANT SRBM

## WHAT IT IS

A grid-free numerical approximation of an orthant SRBM's stationary transform by a nonnegative mixture of separable exponentials. Implementation: `infinite/BNAalr/low_rank_bar.py`.

## HOW IT WORKS

The solver fits the Basic Adjoint Relationship (BAR) on a deterministic training set, checks it on a separate held-out collocation set, and increases mixture rank. It stops only after both the held-out residual and successive moment change meet their requested tolerances twice. Storage grows roughly with rank times dimension instead of a full tensor grid.

## EVIDENCE AND CLAIMS

The displayed BAR residual and moment-refinement change are numerical diagnostics, not error bounds. A finite set of transform points may miss local or tail behavior. The method claims an exact rank-one result only when the Harrison–Williams skew-symmetry identity holds exactly for the supplied decimals and held-out BAR also passes; all other results are labeled approximations.

## SCOPE

- Stable orthant SRBM with constant drift and covariance.
- Positive-semidefinite covariance with positive diagonal.
- Nonsingular M-matrix reflection and −R⁻¹μ > 0.
- One to sixteen station-workload dimensions.

This solves the diffusion exported from the queue network. Agreement with Spectral, LP, or SRBM MLMC checks the SRBM numerics, not the diffusion's approximation error relative to the discrete queue.

## TRY IT

[Example network: three stations and two customer classes (3d2ctandem.inf)](qnet-example:3d2ctandem.inf?run=run:low-rank-bar)

This method reports the mean workload and its variance as well as the mean queue length; look at how the workload is split among the three stations.
