# SIMULATION (FINITE BUFFERS) — fBNAsim

## WHAT IT IS

Discrete-event simulation of the queueing network with finite buffers. Same engine as the infinite-buffer simulator but with blocking semantics enforced. Three blocking modes: Loss, BAS, BAS+ExtLoss (chosen by the Run Comparison popup). Implementation: `finite/fBNAsim/fBNAsim`.

## HOW IT WORKS

1. Same event-driven engine as jackson\_sim (see "Help — Simulation (Infinite)" for the basics).
2. Per-station buffers have a hard cap = buffer\_size. When a customer arrives or completes service into a full buffer:

   ```
   Loss mode:  customer is dropped (recorded as a loss).
   BAS mode:   server idles; the customer stays in the
               server slot and the upstream pipe back-
               pressures.
   BAS+ExtLoss: same as BAS internally but external
               arrivals to a full first buffer drop.
   ```

3. Track per-station occupancy, throughput (= served rate), loss rate, sojourn time. Report mean ± SE across reps.

## WHEN IT WORKS WELL

- Queue-process reference for finite-buffer networks. The only method that literally simulates the chosen blocking protocol (Loss / BAS / BAS+ExtLoss).
- Networks with arbitrary distributions and arbitrary topology — anything you can simulate, this can do.
- Validation of the SRBM corrections (Loss correction, BAS correction): change popup, re-run, see whether the algorithm columns track the simulator.

## WHEN IT DOESN'T WORK + ALTERNATIVES

- Heavy traffic (ρ ≥ 0.97) requires a much longer warmup. Mixing slows sharply as utilisation approaches one.
- → Use Spectral with BAS / Loss correction; SRBM is asymptotically exact in heavy traffic.
- Single-class M/M/1 tandems with small buffers.
- → Use CTMC — exact and noise-free.
- Very large networks (d > 100). Event throughput drops.
- → Use QNA-equivalent methods (no finite-buffer QNA in the current shipping set, but you can run the infinite version and ignore the buffer effect for a baseline).

## ROBUSTNESS / CURSE OF DIMENSIONALITY

Cost is proportional to events processed across all replications; memory is O(d · max\_buffer). Wall time depends on both the simulated horizon and event rate. Heavy-traffic finite-buffer networks need extra warmup because BAS back-pressure causes long mixing times.

## HINTS FOR BETTER RESULTS

- Pick the blocking mode that matches your real system. The popup choice is sticky — tick "Skip this dialog from now on" to reuse it on subsequent runs.
- For tight CIs in heavy traffic: increase warmup to 5M+, use 30+ replications, run in parallel mode.
- The CTMC column (when available) has zero Monte Carlo noise. If both CTMC and Sim are shown, prefer CTMC as the reference.
- Compare loss rates (printed in the verbose output) with the SRBM Loss-correction iteration — they should agree to a few percent if the correction is well-tuned.

## TRY IT

[Example network: a two-station line with buffers of five (Tandem2.MM1.K5.fin)](qnet-example:Tandem2.MM1.K5.fin?run=run:monte-carlo-finite)

Keep the settings the sheet offers. Read the throughput and its interval, then compare with the exact CTMC, which this small network also allows.
