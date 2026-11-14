# Fuzzing the solvers' input parsers

`fuzz_mc_solver.py` damages valid `.bnet` documents and runs a sanitizer build of
`infinite/BNAmd/mc_solver` (the multi-class diffusion solver, the only solver that reads the
network document itself) on each one under a time limit. The rule it checks: a damaged or
oversized input ends in a result, or in a message on standard error and exit status 1. A signal,
an AddressSanitizer or UndefinedBehaviorSanitizer report, any other exit status, or a failure with
no message is a finding.

What it does to an input: cuts it short; replaces, deletes and repeats bytes; replaces numbers
with huge, negative and non-finite ones (`1e999`, `NaN`, 400 digits); sets the fields the solver
sizes or indexes things with (`bufferSize`, `numberOfServers`, `customerClass`,
`routingProbability`) to such values; removes keys; puts values of the wrong type anywhere; nests
arrays and objects thousands deep; renames nodes so that the station or class number taken from
the name is out of range; adds thousands of nodes or links; points links at other nodes or at
nothing; and gives distributions parameters such as `rate=nan` or `k=0`. One case in six also
leaves the mesh to the solver or passes a damaged `-n`.

## Running it

Build the sanitizer solver in a copy of `solvers/` outside the repository (nothing is built inside
Dropbox), then give the fuzzer valid documents to start from:

```sh
copy="$HOME/Library/Caches/qnet/hardening/src"
rsync -a --checksum solvers/ "$copy/"
make -C "$copy/infinite/BNAmd" asan
python3 validation/fuzz/fuzz_mc_solver.py \
    --solver "$copy/infinite/BNAmd/mc_solver_asan" --seeds examples --cases 6000
```

Standard-library Python only. `--seed` fixes the cases (the default is 20261112), `--jobs` the
number run at once, `--timeout` the seconds one case may take (60), `--work` the scratch folder
(a new one under `$TMPDIR` by default). It exits 1 if there is a finding.

A valid network at the automatic mesh can take minutes under the sanitizers, so most cases pass
`-n 1`; a case that reaches the time limit is counted and kept under `corpus/timeouts/` for a
look, but is not a finding. In the runs so far every timeout was a network that was still valid
and simply slow (four or five stations at the automatic mesh), so none is kept here.

## `corpus/`

Inputs on which the solver as it was in 0.90.34 misbehaved, each with a `.txt` saying what was
found, the arguments, how the input was made, and what the fixed solver does with it. The same
files are in `solvers/infinite/BNAmd/tests/inputs/` with their expected exit status, where
`make check` and `make check-asan` run them. A new finding is written here by the fuzzer; once
the defect is fixed, copy the input to `tests/inputs/` with an `.expect` file beside it.

| Input | What 0.90.34's solver did |
|---|---|
| `fuzz-class-index-*` | `bnet_parser.c`: a link's `customerClass` outside 0…7 indexed the routing table `P[c]` (stack overflow) |
| `fuzz-face-basis-*` | `mc_fem_gauss.c`: with five stations the 512 basis functions of a face element overran `double Df_vals[256]` |
| `fuzz-capacity-*` | `mc_fem_gauss.c`: the per-thread capacity `(n_elem / threads + 1) * 4^K * 4^K` overflowed `int` |
| `fuzz-ipow-*` | `bna_fm.h`: `ipow(4, 8)` overflowed `int` with eight stations |
