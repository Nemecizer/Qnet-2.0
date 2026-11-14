# MULTI-CLASS SRBM — EXPERIMENTAL (`mc_solver`)

## WHAT IT IS

A research solver for multi-class networks with infinite buffers. The production SRBM path (Spectral, Finite Element, Linear Program) collapses every class at a station into one aggregate service law before it builds the diffusion. This solver keeps the classes apart for as long as it can: it forms a compound service-time distribution per station from the per-class laws and their visit frequencies, derives the covariance of the Brownian motion from per-class routing variance, and builds the reflection matrix by the Harrison–Reiman construction. The resulting SRBM is then solved by a finite-element discretisation on a growing box. Implementation: `infinite/BNAmd/mc_solver`. It is part of the maintained source tree and is included in release app bundles. Its numerical-library dependencies are listed in that directory's README.

## HOW IT WORKS

1. Qnet writes the canvas to a temporary .bnet file. Unlike every other solver this one reads the network description directly, not an exporter's output, so what it sees is exactly what is drawn.
2. Per station, the per-class service laws are combined into one compound law whose first two moments respect the class mix (the "research" formulation) — or, with the legacy formulation, replaced by the same aggregate the production SRBM export uses.
3. Routing variance is computed per class and summed into the covariance matrix Γ; the reflection matrix R follows Harrison–Reiman.
4. The SRBM is discretised on a finite truncation box with a Hermite finite-element mesh. The mesh has a dimension-aware cap; this run does not itself certify truncation error, so repeat at another domain/mesh and compare.

## WHAT THE PARAMETERS MEAN

- Formulation — Research uses the compound-service and routing-variance formulas above. Legacy reproduces the production SRBM primitives, so the two formulations can be compared on one network to isolate the effect of the multi-class treatment.
- Mesh size per dimension — finite elements along each axis. Leave blank for a cap chosen from the number of stations; the element count is the mesh size raised to d, so one more cell per axis can multiply the run time.

## WHEN IT IS TRUSTWORTHY

- Multi-class networks where classes at one station have service times that differ by a factor of two or more — the case the aggregate treatment handles worst.
- Heavy traffic, as with every SRBM method.
- As an experiment beside Run Comparison: run both and read the two E\[X\] columns side by side against simulation.

## WHEN IT IS NOT

- Finite-buffer networks: the solver assumes infinite buffers and ignores capacities.
- A result that has not been checked across mesh/domain choices and against queue-process simulation. The result workspace retains the formulation and network snapshot for reproduction.
- Single-class networks: it reduces to the ordinary SRBM and the spectral method is faster and better validated.

## WHAT IT PRINTS

Per station: ρ, E\[X\], Γ and the sojourn time, in the same metric-per-row layout as the other single-method runs, with the formulation and mesh size named in the banner.

## TRY IT

[Example network: two stations and two customer classes (DaiHarrison92.d2.c2.1.inf)](qnet-example:DaiHarrison92.d2.c2.1.inf?run=run:multiclass)

Keep the settings the sheet offers. Look at the utilization and the mean sojourn time at each station, then run a simulation of the same network and compare the two in the Agreement view.
