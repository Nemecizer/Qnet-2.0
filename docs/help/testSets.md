# HELP — Run Test Set (Infinite / Finite)

## WHAT IT DOES

Test ▸ Run Infinite Test Set …  (or  Run Finite Test Set …)  generates N random networks under the bounds you specify (stations, classes, ρ, topology), runs every algorithm in the chosen regime on each one, and prints an aggregate accuracy table at the end.

The simulation result (jackson\_sim for infinite, fBNAsim for finite) is treated as the queue-process reference. Every other algorithm is scored against its point estimate, with the simulation confidence interval retained as essential context.

## WHAT EACH PER-CASE NUMBER MEANS

For each case, for each non-reference algorithm, we compute one number:

```
per_case_err = mean over stations k of  |algo_k - Sim_k| / |Sim_k| * 100%
```

That is a single percent error summarising the algorithm's performance on that one case (averaged across the K stations in the network). With N test cases, you get N such numbers per algorithm — that is the population the table aggregates.

## HOW TO READ THE TABLE

```
Algorithm    Mean %err     P50      P90      Max     N

Mean %err  Average per-case error across the test set.  Sensitive
           to outliers — one near-ρ=1 case where an approximation
           blows up can pull the mean up substantially.

P50        Median per-case error: half the cases came in below
           this number, half above.  This is the "typical case"
           metric.  When a few outliers are inflating Mean,
           compare Mean vs P50 to spot it.

P90        90th percentile: 90% of cases were at or below this
           number; the worst 10% were higher.  This is the
           "tail" metric — useful for picking between methods
           that have similar means but different worst-case
           behaviour.

Max        Single worst-case error in the entire sweep.  If
           Max is much larger than P90, one or two cases hit
           a pathological regime; widening N or narrowing ρ
           usually clarifies whether it's a one-off.

N          Number of cases that contributed to this row.  A
           case drops out for a given algorithm when its
           output file is missing or empty (for example, the
           LP solver timing out, or the Spectral solver
           hitting an internal numerical guard).
```

## PICKING THE SWEEP PARAMETERS

The popup is pre-populated from your saved defaults in Settings ▸ Test Sets (one set of defaults for Infinite, one for Finite).  Anything you change in the popup overrides the default for that one run; it does not write back to Settings.

Hints:

- Stations: the FE solver cost scales as n²ᵈ, so for finite sweeps keep the upper station bound modest (≤ 4 is comfortable; ≥ 5 will dominate sweep time).  The runner auto-caps the FE mesh size by station count.
- ρ: rates closer to 1 are where every approximation gets worse.  Sweeping a wide ρ range (e.g. 0.5…0.95) makes the Mean / P90 spread informative.  Sweeping a narrow band (e.g. 0.85…0.9) tells you how the methods stack up at a specific operating point.
- \# cases: 20 is a reasonable default for getting stable statistics.  Below ~10 the percentiles get noisy.

## PROGRESS DISPLAY

Each case prints one line in the Shell pane:

```
[3/20] d=4 K=2 ρ=0.812  done in 4.71s
```

A spinner ticks while the case's binaries are running, then the line is overwritten with `done in X.XXs` showing the per-case wall-clock time.  When the sweep completes, the aggregate table is printed below.

## NOTES

- The simulation reference for finite cases uses the Blocking mode of Settings ▸ Discrete-Event Simulation.  Its default, BAS + external loss, matches the SRBM convention and is the recommended default in Run Comparison as well.
- Random networks are generated fresh on every run unless "Fixed random seed" is on in the popup.  With it off, re-running the same sweep parameters will give a different sample but should produce comparable aggregate statistics if N is large enough.

## WHY SPECTRAL UNDERPERFORMS AT MODERATE ρ (INFINITE TEST SETS)

Spectral on a random infinite test set typically reports 5–15% mean error per case, while QNA / RQNA / SBD report ≤ 1%.  This is not a wiring bug — it is structural and reflects what the methods are actually solving.

The random network generator produces:

- Sources: Poisson (squared coefficient of variation c²\_a = 1)
- Service: a mix of Exponential, Erlang-2/3, Gamma, and Uniform (c²\_s mostly in 0.2–1.0)
- Single server per station, target ρ in the popup-specified band.

On these Markovian-style networks:

- QNA / RQNA / SBD do moment matching — they are exact or near exact for Jackson networks and degrade gracefully for the modest c²\_s deviations the random generator introduces.
- Spectral solves the SRBM diffusion approximation, which is a heavy-traffic-asymptotic model.  At moderate ρ the parabolic Brownian motion cannot reproduce the geometric M/M/1 tail, so steady-state queue lengths come out systematically low.

Empirical sweep on a fixed network (d=4, K=1, feed-forward) shows Spectral's error closing as ρ rises:

```
ρ       Spectral worst-station error
----    ---------------------------
0.50    -15%
0.70    - 9.5%
0.85    - 5%
0.92    - 2.6%
0.97    + 1.0%
```

Increasing the polynomial degree does NOT help — the answer saturates by degree 4–6 and stays biased. The bias is in the model, not the basis resolution.

## PRACTICAL ADVICE

- To benchmark Spectral fairly, narrow the ρ band toward the heavy-traffic regime (e.g. 0.92…0.97) where SRBM is designed to be accurate.  Spectral closes to within ~1–2% of the other methods there.
- To sweep moderate-load networks, expect Spectral to be the least accurate column.  This is correct — the test set is reporting the SRBM approximation's actual quality on this class of random networks, and is a useful signal for picking methods on real networks of similar load.
- Spectral remains valuable for finite-buffer cases (where it is one of three SRBM-based options compared head-to-head) and for high-d networks where direct M/M/1 product-form analysis is not available.

## FINITE-BUFFER ACCURACY: BAS vs LOSS

For finite-buffer networks, simulator blocking mode and SRBM model assumptions interact and set a floor on how close the algorithms can match simulation.

The SRBM hypercube model (Spectral, Finite Element, Finite-Buffer LP) applies continuous reflection at the upper face of each station's buffer. That is not BAS and not Loss — it's closer to "production blocking with infinite-server downstream". When the simulator runs in BAS or BAS+ExtLoss the algorithms tend to UNDER-predict queue means at near-saturated stations (no back-pressure modeling); when the simulator runs in Loss they tend to OVER-predict (no throughput shrinkage from rejected arrivals).

Loss-mode correction (applied automatically when "Loss" is chosen in the Run Comparison popup): the SRBM exporter iteratively solves an M/M/1/K-style loss fixed point and feeds the throughput-reduced drift into Spectral / FEM / LP. Typical effect on tandem networks at ρ ≈ 0.9 with buffer 10: average error vs the Loss simulator drops from ~25% to ~5%.

BAS correction (applied automatically for BAS and BAS+ExtLoss): the SRBM exporter iteratively shrinks the effective service rate of each upstream station by its estimated blocking probability, which introduces the back-pressure the raw SRBM lacks. Typical effect on tandem networks at ρ ≈ 0.9 with buffer 10: average error vs the BAS simulator drops from ~8% to ~3%.

Practical guidance for tight finite-buffer comparisons:

- Choose the regime that matches your real system; the matching correction is applied automatically.
- Or move out of near-saturation (ρ ≤ 0.9 with comfortable buffer headroom) so all three protocols nearly agree.
- For very small tandems (d ≤ 4, buffer ≤ ~10) consider a direct CTMC solve — `finite/fBNActmc/ctmc_tandem.py` is exact in that regime.
