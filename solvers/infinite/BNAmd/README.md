# Class-aware workload diffusion

This directory contains Qnet's richer multiclass diffusion path. It preserves
class-specific external arrivals, service-time moments, visit ratios, and
routing covariance while retaining one workload coordinate per station. The
resulting SRBM is solved by the included finite-element engine and then mapped
back to class-level delay and population summaries.

This is the maintained location of the former ignored `experiment/` solver.
Keeping it under `infinite/` makes the implementation part of the source tree,
allows the application bundle to include it, and prevents the GUI's
“Multi-Class SRBM” command from referring to an absent binary.

## What is richer than the station-aggregate export

- Per-class traffic equations are solved before aggregation.
- Service means are mixed as a compound service-time distribution. Thus the
  effective rate is the reciprocal of the throughput-weighted mean service
  time, not an arithmetic average of class rates.
- Second service moments retain both within-class variation and variation
  between class means.
- Multinomial routing covariance is accumulated class by class before the
  covariance matrix is aggregated.
- The output retains per-class visit ratios and service rates for mapping the
  workload solution back to per-class estimates.

The `--legacy-params` option remains available solely for controlled
comparisons with the older station-aggregate formulas.

## Model boundary

This is still a **workload SRBM approximation**, not a full station-by-class
state descriptor. It assumes state-space collapse is a reasonable
heavy-traffic model and uses class proportions for post-processing. It cannot
represent every scheduling discipline, priority interaction, re-entrant
instability, or class-dependent service order. The finite-element solve also
uses a finite upper truncation for an infinite orthant; increase the mesh/domain
and compare refinements before treating a result as settled.

The GUI labels the method experimental for these reasons. A comparison with a
queue-process simulation is the appropriate modeling check; agreement with a
different SRBM solver checks only the diffusion numerics.

## Build and verification

The complete solver requires cJSON, SuiteSparse, OpenMP, and Apple Accelerate:

```sh
make solver
./mc_solver --dump-params network.bnet
./mc_solver -G network.bnet
```

The parameter layer has a dependency-light deterministic test, so its traffic,
compound-service, routing, covariance, drift, reflection, and distribution
moment formulas can be checked even on a machine without those solver
libraries:

```sh
make check
```

`make check` also runs the input-handling cases in `tests/inputs/` when the
full solver builds (`tests/check_inputs.sh`): damaged, oversized and formerly
crashing `.bnet` files, each with the exit status and message it must end in.
`make check-asan` runs the same cases against `mc_solver_asan`, a build with
AddressSanitizer and UndefinedBehaviorSanitizer; `validation/fuzz/` uses that
build for mutation fuzzing. `tests/make_inputs.py` writes the hand-made cases;
those named `fuzz-*` were found by the fuzzer and are kept as found.

## Size limits

The finite-element matrix is assembled as a list of entries counted in a
32-bit integer (the SuiteSparse interfaces used here are int-indexed), and
each element contributes a dense block of 4^d × 4^d entries. The solver works
this out before it allocates anything and refuses, with a message naming the
largest mesh that fits, a problem it cannot index:

| Stations | Automatic mesh | Largest mesh that fits |
|---:|---:|---:|
| 1–4 | 80, 40, 16, 8 | the automatic mesh |
| 5 | 6 (refused) | 4 |
| 6 | 4 (refused) | 1 |
| 7 | 4 (refused) | 1 |
| 8 | 4 (refused) | none |

A mesh that fits can still need tens of gigabytes: five stations at mesh 4
assemble 1.7 × 10⁹ entries. Until 2.0 the five-station case ended in
`Segmentation fault: 11` (the entry count overflowed `int`, and a fixed
256-entry scratch array was too small for the 512 basis functions of a
five-dimensional face element).

A file that is not a Qnet network, a customer class that is not a whole number
from 0 up, a parameter that is not a finite number, or a mesh (`-n`) below 1
ends in a one-line message on standard error and exit status 1.

Supported input is the Qnet `.bnet` document format, with at most eight
stations and eight classes. The application invokes the same binary directly,
so the network snapshot used for the run remains available in result
provenance.

## References

- J. G. Dai and V. Nguyen, “On the Convergence of Multiclass Queueing Networks
  in Heavy Traffic,” *Annals of Applied Probability* 4 (1994), 26–42.
- J. G. Dai and J. M. Harrison, “Reflected Brownian Motion in an Orthant:
  Numerical Methods for Steady-State Analysis,” *Annals of Applied
  Probability* 2 (1992), 65–86.
- M. I. Reiman, “Open Queueing Networks in Heavy Traffic,” *Mathematics of
  Operations Research* 9 (1984), 441–458.
