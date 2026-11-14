# BAR STEADY-STATE MOMENT BOUNDS — ORTHANT SRBM

## WHAT IT IS

A polynomial Basic Adjoint Relationship outer relaxation for stationary SRBM moments. It builds interior and boundary Stieltjes moment matrices, face-support identities and BAR equalities. Implementation: `infinite/BNAbb/solver.py`.

## CERTIFICATION POLICY

Stable one-dimensional SRBMs and exactly skew-symmetric product-form SRBMs receive exact rational point bounds and are labeled certified. General models require an optional SDP solver. Floating-point CVXPY results include independent residual, nonnegativity and eigenvalue checks, but remain explicitly uncertified. With no SDP backend, Qnet still builds and reports the auditable conic relaxation without inventing bounds. The Python inside the app does not include CVXPY, and there is nothing to install: see [What Qnet needs](help:whatQnetNeeds).

## SCOPE AND LIMITS

- Strictly positive-definite covariance.
- Nonsingular reflection M-matrix and strict SRBM stability.
- Infinite-buffer orthant diffusion only.
- Finite relaxation order; cost grows combinatorially with dimension.

The outer-relaxation interpretation assumes the relevant stationary moments exist and justify the polynomial BAR. Noncompact support means a finite upper problem can be unbounded, and no finite-order hierarchy convergence claim is made. Bounds concern the SRBM—not the discrete queue.

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p50.inf)](qnet-example:OpenJackson.d2.feedback.p50.inf?run=run:bar-bounds)

The result is a bound on the mean workload at each station, not an estimate. In the Agreement view it is marked "bound" and is not scored against the other methods.
