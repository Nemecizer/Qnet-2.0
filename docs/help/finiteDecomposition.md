# FINITE-BUFFER DECOMPOSITION — fBNAdecomp

## WHAT IT IS

A fast queue-level approximation for open multiclass finite-capacity networks. Each station is solved as an M/M/c/K birth-death queue; routed offered flows and admitted throughputs are reconciled by a damped fixed point. Implementation: `finite/fBNAdecomp/fbna_decomp.py`.

## MODEL AND OUTPUT

- Poisson external arrivals and exponential FCFS service.
- Multiple classes, servers, feedback, and class-changing routes.
- Exact isolated-station M/M/c/K probabilities computed in log space.
- Station/class population, queue, utilization, throughput, full/loss probability, waiting/sojourn, routed-flow and conservation results.
- Iteration count, residual history, local balance checks and warnings.

## BLOCKING SEMANTICS

Loss mode discards external or internal arrivals that see a full station. Its network result is still approximate because station occupancies and internal departure processes are decoupled.

BAS and BAS + external loss use an additional frozen-server and enabled-arrival independence closure. These modes preserve flow by construction but do not reproduce joint blocking-duration correlations. Qnet labels them "BAS approximation" everywhere; treat them cautiously when full probabilities or feedback are large.

## WHEN TO USE IT

Use this between exact CTMC and simulation: it is useful when the exact state space is too large and a quick estimate of finite-capacity effects is needed. Check its residual and conservation diagnostics, then compare important cases against seeded simulation. It is not a certified bound.

## TRY IT

[Example network: a two-station line with buffers of five (Tandem2.MM1.K5.fin)](qnet-example:Tandem2.MM1.K5.fin?run=run:decomposition)

Look at the full probability of each station and how the first station is held back when the second one fills. Then run the exact CTMC on the same network to see how close the decomposition is.
