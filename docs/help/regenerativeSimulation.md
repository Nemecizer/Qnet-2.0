# REGENERATIVE MONTE CARLO — QUEUEING PROCESS

## WHAT IT IS

A continuous-time discrete-event simulation whose IID observations are complete empty-system-to-empty-system cycles. It estimates steady-state reward ratios and their uncertainty without pretending individual events or time slices are independent. Implementation: `infinite/BNArmc/regenerative_mc.py`.

## SEQUENTIAL PRECISION

Precision is checked only at complete regeneration epochs. Every selected metric must meet its absolute or relative half-width target, minimum effective-cycle count and rare-event positive-cycle safeguard. Summable alpha spending covers repeated scheduled looks and monitored metrics. Intervals remain asymptotic regenerative-ratio t intervals; they are not advertised as exact finite-sample confidence sequences.

## SCOPE

- Open multiclass Markovian routing with no class changes.
- Poisson arrivals and FCFS M/M/c stations.
- One service rate per station shared across classes.
- Either all infinite buffers or all finite loss-on-full buffers.
- Strict Jackson offered-load stability for infinite networks.

Runs retain a 64-bit base seed and deterministic stream identifier. Per-cycle time/event guards stop explicitly rather than truncating a long cycle into a biased observation. A likelihood-ratio importance sampler is available only for the documented one-node M/M/1/K rare-event case; unsupported models are rejected.

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p30.inf)](qnet-example:OpenJackson.d2.feedback.p30.inf?run=run:regenerative-infinite)

Keep the settings the sheet offers. Look at the interval beside each mean number in system, then run Exact Open Product Form on the same network: the exact value should fall inside the interval.
