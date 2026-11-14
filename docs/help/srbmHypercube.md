# ABOUT FINITE-DIMENSIONAL SRBM IN A HYPERCUBE

Finite Run Comparison ships SRBM-based algorithms (Spectral, Finite Element, Finite-Buffer LP) and a discrete-event simulator (fBNAsim). The algorithms and the simulator can disagree even on a "correct" run — not because of numerical bugs but because they're not modeling \*quite\* the same protocol. This page explains the mismatch and the corrections that close it.

## THE TWO REAL PROTOCOLS THE SIMULATOR IMPLEMENTS

fBNAsim picks one of three discrete blocking protocols based on the flag passed by Run Comparison's popup:

```
Loss            (-l)  — A customer arriving to a full buffer is
                        rejected at the door. A server that
                        completes service when the next buffer is
                        full also drops its customer (internal
                        loss). No back-pressure: every server
                        keeps running at full speed.
BAS             (default)
                      — "Blocking After Service": when a server
                        completes and the next buffer is full,
                        the customer stays in the server slot and
                        the server idles until a downstream slot
                        frees. Back-pressure propagates upstream.
                        External arrivals to a full first buffer
                        are blocked at the source (closed system).
BAS + ExtLoss   (-e)  — Same as BAS internally; external arrivals
                        to a full first buffer are dropped (open).
```

All three are well-defined queueing protocols a real factory or telecom system would actually exhibit.

## WHAT THE SRBM ALGORITHMS ARE SOLVING

Spectral, FE, LP all solve the \*same\* mathematical object: a Semimartingale Reflected Brownian Motion on the hypercube \[0, K\_1\] × ... × \[0, K\_d\], where K\_i = buffer\_i + servers\_i. The workload vector W\_t evolves as

```
dW_t = θ dt + σ dB_t + R dL_t
```

where θ is drift (= α − capacity), σ is noise (covariance Γ), R is the reflection matrix, and L\_t is a regulator that pushes W back into the box at each face. Two regulators:

- Lower face (W\_i = 0)  — pushes UP. Physical meaning: the server idles when there is no work.
- Upper face (W\_i = K\_i) — pushes DOWN. Physical meaning: ???

The upper-face regulator is what makes finite-buffer SRBM "in between" the discrete protocols, because it's a CONTINUOUS, INSTANT regulator: the moment work tries to push above K\_i, an exactly balancing amount is removed. It does not distinguish "this excess came from an arriving customer" from "this excess came from upstream service" from "an upstream customer is blocked from delivering" — it just decrements the workload variable continuously.

So the honest answer to "what protocol does SRBM implement?" is: a continuum approximation that doesn't correspond to any of the discrete protocols above, because the discrete protocols make distinctions about \*who\* gets affected when a buffer fills, and SRBM erases those distinctions.

## SIDE-BY-SIDE: BUFFER i+1 JUST HIT K\_{i+1}, ANOTHER ARRIVAL FROM i

```
                    Real Loss        Real BAS         Raw SRBM
                    ----------       --------         --------
Arriving customer:  rejected         server i idles   work trimmed
                    at the door                       continuously
Buffer i+1:         stays at K       stays at K       stays at K
Server i state:     keeps serving    IDLES            keeps serving
                    (next enters)    (back-pressure)  (no back-pressure)
Buffer i:           drains normal    BUILDS UP        drains normal
                                     (back-pressure)
Throughput at i:    full × (1−P_f)   reduced          full (over-predicts!)
Upstream queue:     modest           large            modest
```

## WHICH DISCRETE PROTOCOL IS THE SRBM CLOSER TO?

SRBM upper reflection most resembles LOSS in spirit:

- Both lose mass at the boundary (continuously vs. at-arrival).
- Neither propagates back-pressure to upstream stations — so upstream queues stay smaller than BAS would predict.

But it differs from real Loss because:

- Real Loss only loses \*arrivals\*  (P\_loss × λ); SRBM loses any work that tries to push past the boundary, regardless of source. This can over-count rejections.
- The continuous workload approximation smears out the discrete distribution that real Loss queues actually have.

It differs from BAS catastrophically because:

- Real BAS reduces upstream μ\_eff when downstream is full — this is the dominant effect on tandem queue lengths.
- Raw SRBM doesn't model this at all — upstream μ\_eff stays constant. Upstream queues come out small. Downstream queues come out small too because nothing slows the bottleneck.

## "PRODUCTION BLOCKING WITH INFINITE-SERVER DOWNSTREAM"

A useful informal description of the raw SRBM:

Customers complete service at i, attempt handoff to i+1; if i+1 is full, the customer just disappears (no rejection cost upstream, no idle penalty for server i — as if i+1 had infinite-capacity ghost servers waiting to absorb the overflow).

That's nobody's real protocol — it's the continuum-limit interpretation of "instant continuous reflection at the upper face." Recognising this explains why the comparison to either real protocol is biased without a correction.

## THE CORRECTIONS RUN COMPARISON APPLIES AUTOMATICALLY

The SRBM exporter ships two iterative corrections, picked by the popup:

```
Loss correction (when popup = Loss)
  For each station, compute P̂(buffer full) using an M/M/1/K
  loss formula, propagate effective arrivals downstream via the
  routing matrix, and use α_throughput = α_arrive · (1 − P_loss)
  as the SRBM drift's α term. This shrinks the offered load at
  each station to match what a real Loss queue actually feeds
  the downstream stations.

On a 4-tandem at ρ = 0.9 with buffer 10: closed the average
absolute error vs Loss simulator from ~25% to ~5%.

BAS correction (when popup = BAS or BAS + ExtLoss)
  Iteratively shrinks effective service rate at upstream
  stations:  μ_eff_i_BAS = μ_eff_i · (1 − β · Σ_j P_ij · P̂_full_j)
  with β = 0.5 dampening (raw β = 1 over-shoots upstream by
  compounding P_block estimates from already-corrected queues).
  This INTRODUCES the back-pressure that the raw SRBM lacks.

On a 4-tandem at ρ = 0.9 with buffer 10: closed the average
absolute error vs BAS simulator from ~8% to ~3%.
```

The corrections are mutually exclusive — one or the other, never both. Infinite-buffer runs skip both (no blocking happens).

## DIAGNOSTIC FINGERPRINT

A 4-station tandem with ρ = 0.9 everywhere, buffer 10, BAS+ExtLoss simulator, NO correction:

```
Station      Sim BAS    Spectral (raw)    error
-------      -------    --------------    -----
S1            4.74          4.21          -11%   ← upstream
S2            5.62          4.87          -13%      under-predicted
S3            5.37          4.98          - 7%
S4            4.48          4.51          + 1%   ← terminal exact
```

The growing-toward-upstream error is the signature of "no back-pressure modeling." Same network with the BAS correction:

```
Station      Sim BAS    Spectral (BAS-fix)
-------      -------    -----------------
S1            4.74          4.90 (+ 3%)
S2            5.62          5.39 (- 4%)
S3            5.37          5.18 (- 3%)
S4            4.48          4.50 (+ 0%)
```

Mean abs error 8% → 2.6%.

## EXACT REFERENCE WHEN AVAILABLE: CTMC

For single-class M/M/1 loss tandems with d ≤ 4, all external flow entering station 1, and at most 1,000 joint states, Run Comparison adds a CTMC (exact loss) column ahead of Simulation. The CTMC solves that finite-state loss chain — no diffusion approximation or Monte Carlo noise. True BAS needs blocked-server state, so BAS comparisons deliberately omit this column.

## PRACTICAL GUIDANCE

- Pick the popup choice that matches your real system (Loss for loss-tolerant systems; BAS for systems with back-pressure). The matching correction is applied automatically.
- Heavy traffic + small buffers (ρ > 0.97, buffer ≤ 10) is the regime where SRBM accuracy degrades fastest. A status warning fires when both conditions hold and the popup is BAS-style.
- For CTMC-eligible loss networks (single-class M/M/1 tandem, station-1 entry, d ≤ 4, at most 1,000 states) the CTMC column is the exact queueing benchmark; compare algorithms to it rather than to simulator (which has Monte Carlo noise).
- The "Average of Algorithms" column averages Spectral / FE / LP per row. When the algorithms straddle the reference the average cancels their per-station bias; when they all bias the same way it doesn't help. Useful to see at a glance whether ensembling is paying off on your network.
