# HELP — Feedback Networks

## WHAT THIS IS

Qnet supports queueing networks whose routing matrix P has entries P\[i\]\[j\] > 0 for j ≤ i — i.e. jobs leaving station i can loop back to itself or to an earlier station. All solvers (spectral method, finite element, QNA, SBD, simulation, LP, MLMC) handle feedback natively; the only feed-forward-restricted feature is GCDG 2025 Corollary 3 in the analytical-tractability detector.

## EXISTENCE CONDITION (Taylor–Williams 1993)

The SRBM with reflection matrix R = I − Pᵀ on the orthant exists and is unique in law iff R is "completely-S": every principal submatrix is an S-matrix (admits a non-negative vector u with Ru > 0). For generalized Jackson networks (P sub-stochastic) this reduces to the physically intuitive condition that every station has a positive-probability path to the sink. Qnet checks this automatically — if it fails, the red banner fires and Analyze Network lists it as a CRITICAL finding.

## ALGORITHMS AND FEEDBACK

Exact / asymptotically exact under general feedback:

- Spectral method (BNAsm) — Dai–Harrison 1992, reference QNET engine. Solves the SRBM Fokker–Planck PDE on the orthant via a polynomial / Legendre expansion. No feed-forward restriction. Reference: daiHarrison92.pdf §2.
- Finite element method (BNAfm) — Shen–Chen–Dai–Dai 2002. Bounded hypercube with converging sequence of SRBMs. Handles feedback in the reflection matrix at any station. Reference: shenChenDaiDai02.pdf.
- LP method (BNAlp) — Saure–Glynn–Zeevi 2008. BAR-based linear program with polynomial test functions. General R.
- SRBM MLMC (rbm\_mlmc) — Blanchet–Chen–Si 2021. Linear-in-d cost, no feedforward assumption; estimates the Brownian model.
- Jackson simulation (jackson\_sim / fBNAsim) — queue-process reference with Monte Carlo uncertainty.

Approximate under heavy feedback — may degrade:

- QNA (Whitt 1983) uses renewal superposition / departure SCV formulas that iterate to a fixed point through feedback cycles. Convergence is slow at light loads; expect 10–30% error on E\[X\] for tight cycles with ρ \< 0.7. Accurate in heavy traffic.
- SBD (Dai–Nguyen–Reiman 1994) decomposes the network into subnetworks then calls QNET on each. Better than QNA under feedback but still two-moment fit.

Advisory findings Analyze Network emits automatically:

- "Routing has self-loops" — P\[i\]\[i\] > 0, arrivals to station i are no longer a renewal process. OK up to P ≈ 0.3.
- "Routing has feedback cycles (i ↔ j)" — the QNA / SBD fixed-point is slow to converge; prefer spectral / FEM / simulation.

## REFERENCES

Dai, J.G., and Harrison, J.M. (1992). "Reflected Brownian motion in an orthant: Numerical methods for steady-state analysis." Annals of Applied Probability 2(1): 65–86.  (QNET / BNAsm foundation.) Dai, J.G., Nguyen, V., and Reiman, M.I. (1994). "Sequential bottleneck decomposition: An approximation method for generalized Jackson networks." Operations Research 42(1): 119–136.  (SBD / BNAsbd.) Shen, X., Chen, H., Dai, J.G., and Dai, W. (2002). "The finite element method for computing the stationary distribution of an SRBM in a hypercube with applications to finite buffer queueing networks." Queueing Systems 42: 33–62.  (BNAfm.) Taylor, L.M., and Williams, R.J. (1993). "Existence and uniqueness of semimartingale reflecting Brownian motions in an orthant." Probability Theory and Related Fields 96: 283–317.  (Existence.)

## HOW TO EXERCISE FEEDBACK IN QNET

- Draw feedback edges directly on the canvas (station → earlier buffer), or
- Use Network ▸ Generate Random Network… and pick the topology "Jackson feedback" (light feedback) or "General P-matrix" (full feedback). The dialog writes a stable target-ρ network with the chosen topology into a new tab.
- Load the paper example files DaiHarrison92.d2.c2.1.inf.bnet, DaiNguyenReiman94.d3.c1.1.inf.bnet, Schwerer01.\*.inf.bnet.
