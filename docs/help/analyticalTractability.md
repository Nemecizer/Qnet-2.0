# HELP — Analytical Tractability

## WHAT THIS IS

When the network you just loaded falls into one of a handful of well-studied special cases, the stationary distribution of the station queue lengths has a closed-form (or asymptotic product-form) expression. In those cases, Qnet sidesteps the numerical solver for the mean E\[X\_i\] and reports the analytical result as the reference column in Run Comparison. A green "This network is analytically tractable" banner appears on the canvas whenever at least one of the conditions below holds.

## HOW THE ANALYTICAL PILL DECIDES

The Analytical pill in the flag bar lights up whenever a known closed-form or asymptotic product-form distribution applies to the network. Its popover names the branch that matched: exact (Jackson product form, Harrison-Williams skew-symmetric) or asymptotic (GCDG 2025 Corollary 1 / 2 / 3). The values populate the "Exact Result" column of Run Comparison and of single-method runs. There is nothing to configure: the detector always tries every branch.

## ACCURACY

Exact branches are closed-form. The GCDG 2025 corollaries -- M-matrix R, 2-D P-matrix R, and lower-triangular R -- hold asymptotically in the multi-scaling regime (traffic slackness delta\_i = r^i); for moderate rho the means may differ from simulation by 10-30 %. The popover's detail line says which branch fired.

Detection is attempted in this order; the strongest match wins.

## (1) OPEN JACKSON NETWORK  — exact product form

Conditions:

- All external inter-arrival distributions are Poisson/exponential
- All station service distributions are exponential
- Infinite buffers, work-conserving FCFS
- One customer class -- or several, provided no station is visited by more than one of them. Classes on disjoint stations are separate Jackson networks sharing a canvas, not a multi-class network: every server still sees a single exponential stream, so this is the same theorem rather than an extension of it. Two archetypes inserted side by side are the everyday case. A station genuinely shared by two classes is not accepted here, even when both are served at the same rate.
- ρ\_i = α\_i / (s\_i · μ\_i)  \< 1  at every station

Result (Jackson 1957 / Gordon-Newell): π(n\_1, ..., n\_d) = ∏\_i π\_i(n\_i), with each station behaving as an independent M/M/s\_i queue.

```
E[N_i] = Erlang-C mean for M/M/s_i   (reduces to ρ_i/(1−ρ_i) for s_i = 1).
```

## (2) HARRISON-WILLIAMS SKEW-SYMMETRIC SRBM  — exact product form

Conditions (Harrison & Williams 1987a, eq. 2.7): 2Γ = R · diag(Γ\_ii/R\_ii) + diag(Γ\_ii/R\_ii) · Rᵀ (where Γ is the SRBM covariance and R is the reflection matrix)

Result:

```
Z has product exponential stationary distribution with
  E[Z_k] = Γ_kk / (2 · R_kk · δ_k),   δ = −R⁻¹μ.
```

## (3) GCDG 2025 MULTI-SCALING ASYMPTOTIC PRODUCT FORM

Reference: Guang, Chen, Dai, Glynn (2025). "Asymptotic Product-form Steady-state Distribution for SRBM in Multi-scaling Regime." arXiv:2503.19710.

Under the multi-scaling regime δ\_i = r^i (traffic slackness at distinct heavy-traffic speeds) and the uniform moment bound condition, the rescaled SRBM converges to a product of independent exponentials with explicit means (Theorem 1, eqs. 2.4-2.6):

```
m_k = u_k' Γ u_k / (2 · u_k' R_{:,k}),
u_k = [w_{1k}, ..., w_{k-1,k}, 1, 0, ..., 0]'
with w solving Σ_{j<k} w_{jk} R_{jℓ} + R_{kℓ} = 0 for ℓ = 1..k-1.
```

The moment bound condition has been verified for:

- Corollary 1 — R is an M-matrix (e.g. every Jackson-style SRBM with R = I − Pᵀ)
- Corollary 2 — d = 2 and R is a P-matrix
- Corollary 3 — R is lower-triangular (feed-forward / tandem with station numbering respected)

These results are ASYMPTOTIC (they hold in a heavy-traffic limit). Qnet reports the corresponding means but labels the column "Asymptotic E\[X\]" to distinguish from the two exact cases above.

## STABILITY PRECONDITION

All tests require ρ\_i \< 1 at every station. If any ρ\_i ≥ 1 the banner is suppressed (matches the red "Network Has Warnings" banner).

## HOW TO USE

Load or edit a network. The analytical check runs automatically and, if any condition matches, a green banner appears at the top-left of the canvas describing which result applies. In Run Comparison, an extra block titled with the matched condition appears after the main SM/FM/Sim (or SM/QNA/SBD/Sim) table, showing the analytical means alongside the simulation for direct % delta comparison.
