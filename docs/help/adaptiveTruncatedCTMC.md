# ADAPTIVE TRUNCATED CTMC — INFINITE MARKOV CHAIN

## WHAT IT IS

A queue-process approximation for open, infinite-buffer, single-class M/M/c networks. It solves a sequence of finite continuous-time Markov chains obtained by capping the network's total population, rather than replacing the queues by a diffusion. Implementation: `infinite/BNAtc/truncated_ctmc.py`.

## HOW IT WORKS

1. Verify the open-network traffic equations and strict station loads.
2. Enumerate all population vectors whose total is at most the current cap and solve the sparse generator by matrix-free uniformization.
3. Enlarge the cap until both boundary probability and the successive change in mean populations meet their requested tolerances.
4. Report generator residuals, cap history, boundary mass and refinement change separately from the queue estimates.

## WHAT THE CLAIM MEANS

The stability check is rigorous for the supported Jackson-network class. Agreement between successive caps and small boundary mass are numerical truncation evidence, not by themselves a proof of error. A separate Foster–Lyapunov tail or moment certificate is reported only when the solver's explicit sufficient condition holds; it is never inferred from apparent convergence.

## SUPPORTED SCOPE

- One customer class with no class changes.
- Poisson external arrivals and exponential service.
- One or more identical servers per station and arbitrary open routing.
- Infinite buffers and a stable network.

State count grows combinatorially with the cap and number of stations. The hard state limit stops the run before an unmanageable allocation. For a finite loss network use Exact Sparse CTMC; for a broader stochastic model use direct queue simulation.

## TRY IT

[Example network: two stations with re-entrant flow (Reiman84.d2.c1.reentrant.inf)](qnet-example:Reiman84.d2.c1.reentrant.inf?run=run:truncated-ctmc)

Read the mean number in system at each station. The run's transcript reports how many states were selected and how little probability was left at the truncation boundary.
