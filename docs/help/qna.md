# QNA — QUEUEING NETWORK ANALYZER (BNAqna)

## WHAT IT IS

Whitt's Queueing Network Analyzer (1983, 1995). Approximates every station as a GI/G/1 queue with arrival and service squared-coefficients-of-variation (SCVs) computed by a network-wide recursion. Returns mean queue length, sojourn time, and effective inter-arrival/service moments per station. Implementation: `infinite/BNAqna/bna_qna`.

## HOW IT WORKS

1. Solve the traffic equations: α = (I − Pᵀ)⁻¹ λ to get the per-station throughput α\_i.
2. Compute the per-station traffic intensity ρ\_i = α\_i / μ\_i.
3. Recursively solve for the per-station arrival SCV:

   ```
    c_a²_i = (sum_j w_ji · departure SCV from j)
   ```

   where w\_ji is a weighted blend of routing and arrival shares.

4. Compute departure SCV at each station from arrival SCV + service SCV via a Marshall-style approximation.
5. Iterate to fixed point (typically 5–20 iterations).
6. Plug into the Allen-Cunneen GI/G/m formula:

   ```
    E[W_q] = ρ / (1 − ρ) · (c_a² + c_s²) / 2 · (1/μ)
   ```

   to get per-station mean wait, then E\[Q\] = α · E\[W\_q\] + (1 in service if busy).

## WHEN IT WORKS WELL

- Markovian-style networks (exponential or near-exponential arrivals and service). QNA is exact for Jackson networks.
- Mid-to-heavy traffic (ρ in 0.5 – 0.95). The Allen-Cunneen formula is most accurate here.
- Feed-forward and modestly feedback networks. The recursion on arrival SCVs converges quickly and stably.
- Quick exploration. QNA runs in milliseconds even for d = 50; useful as a sanity check on any longer-running method.

## WHEN IT DOESN'T WORK + ALTERNATIVES

- Heavy feedback networks. The arrival-SCV recursion has weak coupling that can mis-attribute variability around feedback loops, leading to ~10% errors at re-entrant stations.
- → Use RQNA — its per-class SCV at each timescale handles feedback better.
- Highly bursty arrivals (c\_a² > 5) or low-CV² service (c\_s² \< 0.2). The Marshall departure-SCV approximation biases moment-matching at the extremes.
- → Use Spectral (heavy traffic) or simulation (always possible, just slow).
- Multi-class networks with strong class asymmetries (e.g., one class is 90% of arrivals, another 10%). QNA aggregates all classes' moments into a single (c\_a², c\_s²) per station, losing per-class structure.
- → Use RQNA with per-class flag enabled.

## ROBUSTNESS / CURSE OF DIMENSIONALITY

Cost: O(d^2) per iteration (for the routing-matrix solve), and typically converges in O(20) iterations. For d = 100 the whole method runs in tens of milliseconds. Memory O(d^2). The curse of dimensionality does not bite QNA at all — it's O(d^2) regardless of network depth or load.

## HINTS FOR BETTER RESULTS

- Always run QNA first as a baseline: it's free relative to the cost of any other method, and disagreements between QNA and Spectral / SBD usually localize the issue.
- If QNA disagrees with simulation by > 5%, check feedback cycles in the routing graph (Help ▸ Method Reference ▸ Feedback Networks). QNA struggles with strong feedback; switch to RQNA.
- For best agreement with simulation, use BAS+ExtLoss in the sim popup — that's the protocol the SRBM/QNA approximation is closest to.

## TRY IT

[Example network: three stations in a line (3dtandem.inf)](qnet-example:3dtandem.inf?run=run:qna)

QNA finishes at once. Read the utilization and the mean number in system at each station, then run a simulation on the same network and compare the two in the Agreement view.
