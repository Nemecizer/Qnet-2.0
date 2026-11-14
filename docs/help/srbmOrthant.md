# ABOUT SRBM IN AN ORTHANT

Infinite-buffer Run Comparison ships diffusion-based algorithms (Spectral, QNA, RQNA, SBD) and a discrete-event simulator (jackson\_sim). Three of the four diffusion algorithms (Spectral, QNA in its two-moment formulation, SBD) approximate the network as a Semimartingale Reflected Brownian Motion (SRBM) on the positive orthant \[0, ∞)^d. RQNA is built on the same primitives but solves a per-station fixed-point system instead of the SRBM PDE. This page explains the SRBM model and the assumptions underlying it.

## WHY DIFFUSION AT ALL?

A multi-class queueing network has a complicated state — buffer contents, server occupancy, per-class flows, service-time histories. The exact stationary distribution is intractable except for very special cases (Jackson networks, BCMP networks, skew-symmetric covariance, etc.). Diffusion approximation replaces the discrete state with a continuous-time stochastic process whose first two moments match the original network's drift and noise. Two ingredients make this useful:

1. Heavy-traffic limit theorem (Reiman 1984, Williams 1998): under appropriate scaling as ρ → 1, the workload process converges weakly to an SRBM. Hence SRBM is asymptotically exact in heavy traffic — and progressively less accurate at moderate ρ.
2. The SRBM is parametrised by just three pieces of data: drift θ ∈ Rᵈ, covariance Γ ∈ Rᵈˣᵈ, reflection R ∈ Rᵈˣᵈ. These can be computed from the network's arrival-rate vector, service-rate vector, and routing matrix in closed form via the Harrison–Reiman / Gershwin–Newman (GJN) workload transformation.

## THE MATH, IN ONE LINE

The workload process W\_t ∈ \[0, ∞)^d evolves as

```
dW_t = θ dt + σ dB_t + R dL_t                        (*)
```

where θ is the drift (= α − capacity), σ σ^T = Γ is Brownian noise, R is the reflection matrix (R = I − Pᵀ for the standard Harrison–Reiman setup with routing matrix P), and L\_t is a "regulator" process (one component per station) that pushes W back into the orthant whenever a coordinate would go negative. L\_t increases only when W\_t is on the lower face W\_i = 0.

The reflection direction at face W\_i = 0 is the i-th column of R — it tells the workload how to bounce back into the interior. Physically, when station i has no work (W\_i = 0) the regulator "credits" idle capacity; that capacity propagates to other stations through the off-diagonal entries of R, modelling the fact that an idle server isn't producing flow for downstream.

For stability, every component of θ must be NEGATIVE (each station has more capacity than offered load: ρ\_i = α\_i / c\_i \< 1). Under this condition (and a regularity condition on R called the "completely-S matrix" property) (\*) has a unique stationary distribution.

## WHAT'S APPROXIMATED, WHAT'S EXACT

Exact in the SRBM:

- Mass conservation across stations
- Steady-state throughput = α at each station (sub-stochastic)
- Per-station ρ via boundary measure: P(W\_i = 0) = 1 − ρ\_i

Approximated (exact only in the heavy-traffic limit):

- Stationary distribution shape (continuous Gaussian-like vs discrete geometric M/M/1 tail)
- Mean queue length E\[Q\_i\]
- Sojourn-time distribution (only first moment is reliable)
- Tail probabilities (the SRBM's Gaussian-style tails decay slower than the geometric tails of an M/M/1 queue at light traffic, so high quantiles are over-predicted at moderate ρ)

## ACCURACY VS ρ

A 4-station feed-forward tandem, single class, exponential service, swept across ρ:

```
ρ        Spectral worst-station error    QNA error
----     ----------------------------    ---------
0.50     -15%                            ~ 0.5%
0.70     - 9.5%                          ~ 0.5%
0.85     - 5%                            ~ 1%
0.92     - 2.6%                          ~ 1%
0.97     + 1.0%                          ~ 1%
```

Spectral converges to the heavy-traffic SRBM; its accuracy improves toward ρ → 1. QNA does moment-matching (which is asymptotically exact for Jackson networks) and is uniformly accurate to ~1% on Markovian-style random networks regardless of ρ. So:

- In heavy traffic (ρ ≥ 0.92), all four diffusion algorithms agree with each other and with simulation to within a few percent.
- In moderate traffic (ρ ≤ 0.85), Spectral is the systematic outlier — under-predicting queue means by 5–15%. This is not a bug; it is the SRBM diffusion limit telling the truth about its accuracy domain.
- In light traffic (ρ ≤ 0.5), prefer Jackson formula or analytical closed-forms over any diffusion method.

## DIFFERENCES BETWEEN THE FOUR INFINITE ALGORITHMS

All four start from the same SRBM primitives (θ, Γ, R), but they extract E\[Q\_i\] differently:

```
Spectral    Solves the SRBM stationary PDE directly via
            polynomial basis fit. Accuracy bounded by the
            diffusion approximation; gets better in heavy
            traffic. O(m^(2d)) cost in basis degree m.

QNA         Whitt's two-moment approximation: treats every
            station as a GI/G/1 with arrival/service SCVs
            computed by the QNA recursion. Exact for Jackson
            networks, very good for Markovian-style networks
            uniformly in ρ. Cheap (O(d) per iteration).

RQNA        Whitt-You 2022 robust refinement: replaces QNA's
            single SCV with a *per-class* SCV at each timescale,
            catching covariances QNA aggregates away. Better on
            feed-back networks and re-entrant flows; same cost
            order as QNA.

SBD         Sequential Bottleneck Decomposition (Dai-Harrison
            1991): solves a 1-D SRBM per station in topological
            order, propagating departure-process moments. Almost
            as cheap as QNA; better than QNA on tandems, worse
            on complex feedback graphs.
```

## REFERENCES

```
Harrison & Reiman (1981)     — Reflected Brownian motion on the
                               positive orthant.
Reiman (1984)                — Open queueing networks in heavy
                               traffic.
Williams (1998)              — Diffusion approximations for open
                               multiclass queueing networks.
Whitt (1983, 1995)           — QNA: Queueing Network Analyzer.
Whitt & You (2022)           — Refined diffusion approximations
                               (RQNA framework).
Dai & Harrison (1991, 1992)  — SRBM polynomial methods + SBD.
Gamarnik-Cao-Dai-Glynn 2025  — Asymptotic product-form structure
                               for feed-forward / M-matrix R.
```

## SEE ALSO

"About finite-dimensional SRBM in a Hypercube" — same theory extended to bounded buffers, plus the BAS / Loss / SRBM protocol comparison and the corrections Run Comparison applies.
