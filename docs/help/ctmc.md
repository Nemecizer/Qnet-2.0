# EXACT SPARSE CTMC — FINITE MARKOV CHAIN

## WHAT IT IS

An exact queue-process solver for finite-capacity open Markovian networks under loss-on-full semantics. It supports arbitrary routing, feedback, multiple FCFS servers, multiple classes, and class changes. Queue order is retained, so class-dependent service rates remain exact. Implementation: `finite/fBNAgc/solver.py`.

## HOW IT WORKS

1. Begin with the empty network and enumerate every reachable state. A station state is the complete ordered FCFS class sequence, not merely one count per class.
2. Store the continuous-time generator as sparse transition lists. Arrivals or routed transfers that find a full destination are loss rewards; they do not create a state transition.
3. Uniformize the generator and iterate the stationary row vector until its L1 step meets the requested tolerance.
4. Independently report ||pi Q||\_1, flow conservation, population, utilization, full/loss probabilities, throughput, and Little's-law waiting and sojourn times.

## EXACT SCOPE

- Independent Poisson external-arrival processes.
- Exponential service by station and class, FCFS, one or more servers.
- Finite total capacity, including customers in service.
- Loss on full for external and internally routed arrivals.
- State-independent routing with an exit path from every reachable station/class pair.

The result has numerical iteration tolerance but no diffusion or Monte Carlo error. General BAS is not silently approximated because it needs additional blocked-server state; use finite simulation or the explicitly approximate finite-buffer decomposition instead.

## LIMITS AND SAFE FAILURE

Ordered multiclass state spaces can grow exponentially in capacity, classes, and stations. The default reachable-state limit is 200,000. Hitting it stops the run with an actionable error; the solver never reports a silently truncated chain as exact. For larger networks, use finite-buffer decomposition for a fast queue approximation or simulation for a direct queue-process estimate with confidence intervals.

## TRY IT

[Example network: one station with a finite buffer (M/M/1/K) (MM1K.d1.c1.fin)](qnet-example:MM1K.d1.c1.fin?run=run:generic-ctmc)

This is an exact result. Look at the full probability: it is the fraction of time the buffer is full, which is how often an arriving customer finds no room.
