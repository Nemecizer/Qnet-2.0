# RQNA — REFINED QUEUEING NETWORK ANALYZER (BNArqna)

## WHAT IT IS

The Whitt-You (2022) refinement of QNA. Replaces QNA's single arrival/service SCV per station with a \*per-class\* SCV at each \*timescale\*, capturing covariances QNA aggregates away. More accurate on feedback and re-entrant networks; comparable cost. Implementation: `infinite/BNArqna/bna_rqna`.

## HOW IT WORKS

1. Same traffic-equation step as QNA: solve α = (I − Pᵀ)⁻¹ λ.
2. For each station × class × timescale (the Index of Dispersion for Counts, IDC), compute a refined arrival/service SCV using Whitt-You's per-class moment-matching.
3. Iterate the IDC fixed point (typically 10–50 iterations) — at each step the per-class SCVs at each station are updated from the network's flow / variability propagation.
4. Plug into a refined Allen-Cunneen formula with per-class weights to get E\[W\_q\] per station.
5. Sum per-class waits weighted by visit ratios for end-to-end sojourn estimates.

## WHEN IT WORKS WELL

- Feedback / re-entrant networks. The per-class IDC framework was designed specifically for these, and improves on QNA by 5-10% on networks with strong cycles.
- Multi-class networks with class-specific routing. RQNA tracks each class separately rather than aggregating.
- Cases where QNA disagrees with simulation — RQNA usually closes most of the gap.

## WHEN IT DOESN'T WORK + ALTERNATIVES

- Very simple feed-forward networks. RQNA's extra machinery adds no value over QNA here, and may converge slower.
- → Use plain QNA.
- Networks where the Whitt-You IDC fixed point fails to converge. Symptom: error bars in the output, or values that ping-pong between iterations. This happens occasionally on networks with cycles of length > 4.
- → Use Spectral (heavy traffic) or SBD (feed-forward).
- Ultra-heavy traffic (ρ ≥ 0.99). RQNA is asymptotically accurate but the iteration takes many more steps to converge here.
- → Use Spectral, which is designed for this regime.

## ROBUSTNESS / CURSE OF DIMENSIONALITY

Cost: O(d^2 · K · T) per iteration where K is class count, T is timescale count (default 4). Typical iteration count 10-50. For d = 50, K = 4 the whole method runs in seconds. Memory O(d · K · T). Like QNA, the curse of dimensionality is mild — cost is polynomial in everything.

## HINTS FOR BETTER RESULTS

- Compare to QNA. If they agree, both are right. If they disagree, RQNA is usually closer to simulation (especially on feedback networks).
- For extremely re-entrant networks (Kumar-Seidman style), RQNA's accuracy can saturate at ~5% error — the per-class IDC structure captures most but not all of the variability propagation.
- Convergence: the per-class IDC fixed point has nothing to tune. Qnet has no RQNA settings pane and bna\_rqna takes no damping factor.

## TRY IT

[Example network: two stations with re-entrant flow (Reiman84.d2.c1.reentrant.inf)](qnet-example:Reiman84.d2.c1.reentrant.inf?run=run:rqna)

Customers visit a station more than once here, which is where RQNA and QNA part ways. Run QNA as well and look at the gap between them at each station in the Agreement view.
