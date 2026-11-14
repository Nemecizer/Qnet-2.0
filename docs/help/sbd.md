# SBD — SEQUENTIAL BOTTLENECK DECOMPOSITION (BNAsbd)

## WHAT IT IS

Dai-Harrison (1991) sequential decomposition: solves a 1-D SRBM per station in topological order (or, for cyclic networks, in a heuristic order based on bottleneck severity), propagating departure-process moments downstream. Comparable accuracy to QNA for ρ in 0.7–0.95, often better on tandems. Implementation: `infinite/BNAsbd/bna_sbd`.

## HOW IT WORKS

1. Solve the traffic equations and build the routing graph.
2. Find a topological order (or use bottleneck-severity heuristic if the graph is cyclic).
3. For each station k in order:

   ```
   a. Aggregate inbound flow from already-solved upstream
      stations into a single GI/G/1 arrival process.
   b. Solve the 1-D SRBM stationary distribution for station k.
   c. Compute the departure-process moments of station k and
      propagate them to downstream successors per the routing
      matrix.
   ```

4. Report per-station means and the global throughput.

## WHEN IT WORKS WELL

- Pure feed-forward tandems. SBD is essentially exact for single-class M/M/1 tandems, and very good for general feed-forward networks.
- Light feedback (small re-entry probability). The heuristic ordering still works.
- Heavy traffic (ρ close to 1). The 1-D SRBM solver is accurate in this regime.

## WHEN IT DOESN'T WORK + ALTERNATIVES

- Strong feedback / re-entrant networks. The topological-order heuristic breaks down when feedback dominates.
- → Use RQNA (designed for feedback) or Spectral (handles arbitrary R).
- Heavily multi-class networks with shared bottleneck servers. SBD aggregates classes per station, losing per-class detail.
- → Use RQNA for per-class accuracy.
- Very-low-traffic networks (ρ ≤ 0.3). The 1-D SRBM approximation breaks down at light load.
- → Use the Jackson formula directly (closed form).

## ROBUSTNESS / CURSE OF DIMENSIONALITY

Cost: O(d) station solves, each O(1) for the closed-form 1-D SRBM. Total: milliseconds for any reasonable d. Memory O(d). Curse of dimensionality is essentially absent.

## HINTS FOR BETTER RESULTS

- SBD is the cheapest non-trivial option — always run it alongside QNA as a cross-check.
- If SBD and QNA disagree by > 5%, the network has strong coupling that 1-D decomposition can't capture; trust Spectral (heavy traffic) or RQNA (feedback) instead.
- SBD's accuracy degrades toward downstream stations on deep tandems (d > 8) because the propagated moments accumulate approximation error. Compare with simulation on the last station to gauge this.

## TRY IT

[Example network: five stations in a line (5stationtandem.inf)](qnet-example:5stationtandem.inf?run=run:sbd)

Look at which station SBD reports as the busiest: on the canvas it carries the bottleneck marker, and the mean number in system is largest there.
