# SIMULATION (INFINITE BUFFERS) — jackson\_sim (BNAsim)

## WHAT IT IS

Direct discrete-event simulation of the queueing network with no buffer constraints. Tracks individual customers as they move between stations. Used as a queue-process reference against which the analytic / approximation methods (Spectral, QNA, RQNA, SBD) are validated. Implementation: `infinite/BNAsim/jackson_sim`.

## HOW IT WORKS

1. Build an event queue whose primitives are external arrivals and service completions. Each event has a timestamp drawn from the inter-arrival / service distributions specified on the canvas (exponential, gamma, deterministic, etc.).
2. Maintain a per-station FIFO buffer. Arrivals are enqueued; service completions dequeue a customer, sample a route via the outgoing link probabilities, and either move the customer to the next station or exit the network.
3. Advance the clock to the next scheduled event (event-driven; no fixed time step).
4. Discard the warmup period; accumulate time-averaged statistics afterward.
5. Run R replications, each starting empty-and-idle with a fresh seed. Report sample mean ± standard error across replications.

## WHEN IT WORKS WELL

- Queue-process reference. The only method that \*literally\* simulates the stochastic process — every other method is an approximation.
- Networks with arbitrary distributions. Anything you can sample from is supported; no Markovian assumption.
- Single-class or multi-class with no shared assumptions.
- Validation of new networks before relying on diffusion approximations.

## WHEN IT DOESN'T WORK + ALTERNATIVES

- Very large networks (d > 100). Event throughput drops as the per-event station selection cost grows.
- → Use QNA (millisecond runtime regardless of d).
- Very heavy traffic (ρ ≥ 0.99). Convergence to steady state slows sharply as ρ approaches one and may require a much longer warmup.
- → Use Spectral (asymptotically exact in the heavy-traffic limit; no warmup needed).
- Tail-probability estimates. Monte Carlo gives mean ± O(1/√N) accuracy; rare-event tails take exponential effort.
- → Use a dedicated rare-event simulation method for extreme tails; the existing SRBM solvers primarily target stationary moments.

## ROBUSTNESS / CURSE OF DIMENSIONALITY

Cost is proportional to the number of events processed across all replications; event count depends on simulated time and network rates. Memory is O(d) apart from queued customers.

## HINTS FOR BETTER RESULTS

- Confidence intervals: report mean ± 2 SE across replications. If the algorithm answer falls inside that band, declare agreement (don't chase the point estimate).
- Heavy traffic warmup: scale warmup with 1/(1−ρ)². For ρ = 0.95 use 100× more warmup than for ρ = 0.5.
- Replication count: R = 30–100 is usually plenty. More replications buys ~1/√R reduction in standard error, so going from R=30 to R=300 only halves the CI.
- Use parallel mode (Apple GCD or OpenMP) for any R > 1 — replications are embarrassingly parallel.

## TRY IT

[Example network: an open Jackson network with feedback (OpenJackson.d2.feedback.p50.inf)](qnet-example:OpenJackson.d2.feedback.p50.inf?run=run:monte-carlo-infinite)

Keep the settings the sheet offers. Each result comes with a 95 % interval; look at how wide it is, then run the simulation longer and watch the interval narrow.
