# Validation harnesses

Qnet 0.90.34's harnesses that do not depend on Swift, copied from `2_QNET/validation/`
(PLAN.md §4) and changed only where the 2.0 layout forces it.

```sh
scripts/stage-solvers.sh                       # once, and after any change under solvers/
validation/steady_state_suite.sh               # against the stage
validation/steady_state_suite.sh /path/Qnet.app   # against a bundle (or QNET_APP=/path/Qnet.app)
validation/solver_bundle_audit.sh <Qnet.app | folder laid out like Contents>
```

Three places, where 0.90.34 had one source tree:

| What | Where | Variable |
|---|---|---|
| Solver sources, makefiles and their tests | the build copy `~/Library/Caches/qnet/solvers/build` | `QNET_SOLVER_BUILD` |
| The solvers under test, as shipped | `Contents/Resources/bin` of the stage `~/Library/Caches/qnet/solvers/stage` or of a bundle | `QNET_SOLVER_BIN` |
| The examples | `examples/`, or a bundle's `Contents/Resources/examples` | `QNET_EXAMPLES` |

`make` runs only in the build copy. Nothing is built or written in the repository; scratch
files go under `$TMPDIR`. The suite refuses to start when the build copy differs from
`solvers/` (run `scripts/stage-solvers.sh`).

## What changed in each copied file

| File | Change | Why |
|---|---|---|
| `required_release_executables.txt` | none | |
| `research_fixtures/` (fixtures, `ledger.json`, `make_fixtures.py`, `oracle_check.py`, `README.md`) | none | The gates and the fixtures are 0.90.34's. Its README still says `./build_all_algorithms.sh`; here that is `scripts/stage-solvers.sh`. |
| `research_fixtures/run_solvers.py` | A solver is looked for in `QNET_SOLVER_BIN` first, then in `QNET_SOLVER_BUILD` (`locate`); the work folder is `$TMPDIR/qnet-research-fixtures`, not `.build/`; `--write-ledger` prints the ledger's full path. | 0.90.34 ran the binaries in the tree they were built in. Here the shipped copies are measured; `infinite/BNAfm/bna_fm` is not shipped, so it comes from the build copy (the suite builds it there). |
| `example_contracts.py` | Reads `examples/` (or `QNET_EXAMPLES`) instead of `input/examples`. | The folder moved. |
| `mlmc_native_check.sh` | Compiles `infinite/BNAmc/rbm_mlmc.c` from the build copy. Its OpenMP variant links the libomp `scripts/build-deps.sh` built (`~/Library/Caches/qnet/deps/prefix`), with Homebrew's as the fallback it was. | `solvers/` is at a different path, and the build copy is the tree that was built. The shipped solvers no longer link Homebrew's libomp, so the check uses the runtime they do link. |
| `rqna_integration_check.sh` | Greps `scripts/stage-solvers.sh` where it grepped `build_app.sh`; `make bna_rqna` runs in the build copy; the self-test and the compact run use the shipped `bna_rqna`; the example is `examples/3d3ctandem.inf.bnet`; the `.qna` input is written by `qnet-cli export qna` (the Rust exporter), and the seven sections the Swift harness required are checked with `grep`. | The packager's list moved to `stage-solvers.sh`. `QNAExporter.swift` and the `swiftc` harness (`validation/rqna_exporter/`) do not exist in 2.0. |
| `sbd_cyclic_validation.sh` | Runs the shipped `bna_sbd` (which finds the shipped `bnet` beside it) on the test inputs in the build copy; raw outputs go to a temporary folder; it no longer builds a missing solver, it says to run `stage-solvers.sh`. | 0.90.34 built in, and wrote `sbd_test_*.out` into, the source tree. |
| `solver_bundle_audit.sh` | Takes `Qnet.app` or a folder laid out like `Contents`. When that folder has a `MacOS` directory or an `Info.plist`, `Contents/MacOS/qnet` must be a Mach-O executable and everything in `MacOS/` goes through the dependency scan. A `/opt/homebrew` or `/usr/local` dependency is named as such (it was already refused as an external absolute dependency). A missing `Frameworks` folder is an error. | The stage is audited before a bundle exists; the 2.0 app's executable is a Rust binary that 0.90.34's audit never looked at. The app is not launched: the loader probe stays for solvers only. |
| `solver_bundle_audit_check.sh` | 0.90.34's five cases unchanged; added after them: a `Contents`-like folder is accepted, an application without `MacOS/qnet` is refused, a self-contained main executable is accepted, one linked from `/opt/homebrew` or `/usr/local` is refused, an `@rpath` dependency is refused until the library is in `Frameworks`. The Mach-O cases compile small fixtures with `cc` in `$TMPDIR`. | The new rules need a test, and 0.90.34's self-test never exercised the dependency scan. |
| `steady_state_suite.sh` | Written for 2.0 in 0.90.34's order (below). | |

## The suite, step by step

`steady_state_suite.sh` keeps 0.90.34's order. It runs every step even after a failure and
ends with a summary; 0.90.34 stopped at the first failure.

| 0.90.34 step | 2.0 |
|---|---|
| `make test` in `common`, `finite/fBNAdecomp`; `make check` in `finite/fBNAgc`, `infinite/BNAqbd`, `BNApf`, `BNAtc`, `BNAbb`, `BNArmc`, `BNAalr`, `BNAmd` | the same targets, in the build copy |
| `mlmc_native_check.sh` | copied |
| `rqna_integration_check.sh` | copied; the exporter half goes through `qnet-cli` |
| `research_fixtures/oracle_check.py --quiet` | copied |
| `srbm_existence_check.sh` | `cargo test -p qnet-core --lib existence::` (the 36 harness checks are unit tests in `core/src/existence.rs`) |
| `research_fixtures/run_solvers.py` | copied; before it, `make bna_fm` in the build copy's `infinite/BNAfm` (0.90.34: `build_all_algorithms.sh`) |
| `example_contracts.py` | copied |
| `result_output_parser_check.sh` | `cargo test -p qnet-core --lib results::harness::` (`core/src/results/harness.rs`, the harness's 11 check functions) |
| `product_form_exporter_check.sh` | `cargo test -p qnet-core --lib export::product_form::tests::harness_` |
| `qbd_exporter_check.sh` | `cargo test -p qnet-core --lib export::qbd::tests::harness_` |
| `solver_runtime_resolver_check.sh` | `cargo test -p qnet-runner --test resolver`, and its three checks that `ctmc_dtandem.py` is in the bundle list, now against `scripts/stage-solvers.sh` and `solvers/` |
| `startup_dependency_check.sh` | `cargo test -p qnet --lib analysis_windows::deps::` (catalog, launch rule) and `vitest run src/analysis/deps.test.tsx` (sequential, once per session, recheck) |
| `settings_anchor_check.sh` | `cargo test -p qnet --lib settings_schema::` and `vitest run src/windows/settings/settings.test.tsx` (“titles every row with its label and names a key by pane and row”, “covers every stored key with a row or a reason”) |
| `solver_bundle_audit_check.sh` | copied, with the 2.0 cases |
| `gui_runtime_contracts.sh` | `cargo test -p qnet-runner --test supervisor_processes` and `--test supervisor_jobs`. The generated shell wrappers it pinned are gone (PLAN D1). Its other pins (state-space cap, `QNET_METHOD_FAILURE_V1 method=ctmc`, CTMC runtime provenance, the MLMC replication line, the engine fallback) are golden comparisons in `runner/tests/methods_*.rs`, which the `cargo` step of `npm run check` runs; the suite does not repeat them. |
| `embedded_formatter_parse_check.sh` | `cargo test -p qnet-core --test output_precision`, `--test output_table`, `--test output_aggregators` (the perl filter and awk programs are Rust, compared with 0.90.34's own) |

Run after those, because 2.0 has no `build_app.sh` to run them:

| 0.90.34 | 2.0 |
|---|---|
| `design_lint.sh` (run by `build_app.sh`) | `vitest run src/test/contrast.test.ts src/test/colour-policy.test.ts` and `node scripts/help-lint.mjs` (also the `vitest` and `help-lint` steps of `npm run check`) |
| `solver_bundle_audit.sh` (run by `build_app.sh`, `make_pkg.sh`) | on the stage or the bundle given |
| `sbd_cyclic_validation.sh` (run by hand) | prints the SBD numbers beside Dai–Nguyen–Reiman's; it gates nothing |

Two parts of 0.90.34's harnesses have no test of the same shape in 2.0:

- `product_form_exporter_check.sh` and `qbd_exporter_check.sh` also fed the harness's own
  exported documents to `BNApf/solver.py` and `BNAqbd/qbd_solver.py` and asserted the answer
  (probability mass 1; ρ = 0.5 and mean queue length 1). The Rust tests check the exported
  text only. The solvers' answers are checked on other inputs: `make check` in `BNApf` and
  `BNAqbd` above, and the golden product-form and QBD runs in `runner/tests/methods_exact.rs`.
- `gui_runtime_contracts.sh` pinned Edit ▸ Undo routing and the menu's refresh by grepping
  Swift source. The suite runs no single test in their place; the interface's own tests
  (`npm run check`, `vitest`) cover the 2.0 menu.

Not copied, because they compile or grep Swift sources that 2.0 does not have:
`result_output_parser/`, `product_form_exporter/`, `qbd_exporter/`, `rqna_exporter/`,
`solver_runtime_resolver/`, `startup_dependency_check/`, `srbm_existence/` and their `.sh`
drivers, `settings_anchor_check.sh`, `gui_runtime_contracts.sh`,
`embedded_formatter_parse_check.sh`, `design_lint.sh`, `ds_contrast.swift`,
`source_distribution_check.sh`.

## Results that depend on the machine (measured 2026-11-11, M3 Ultra, 32 cores)

Two of 0.90.34's gates depend on what runs them, not on Qnet 2.0. Neither is adjusted here.

- `make -C finite/fBNAgc check` fails its engine parity (6 of 48 comparisons differ in the
  last printed digit of a residual, or in the order of two equally probable states) when
  `python3` is 3.12 or later: Python's built-in `sum()` has been compensated since 3.12, and
  `fbna_gc.c` adds plainly, as its makefile says the Python does. With
  `PYTHON=/usr/bin/python3` (3.9.6) all 48 are byte-identical, and so they are when
  `solver.py` runs with a plain `sum`.
- `research_fixtures/run_solvers.py` fails `E08_d20/BNAmc` and `E08_d30/BNAmc`
  (|err|/SE 4.77 and 4.29 against a gate of 4) with 32 threads: `rbm_mlmc` deals sample i to
  lane i mod threads, so the estimate depends on the thread count. With
  `OMP_NUM_THREADS=18` (the Mac the ledger was recorded on) every cell passes and the two
  values are the ledger's own (3.48 and 2.97).

## Environment pins in the suite

- `research_fixtures/run_solvers` runs with `OMP_NUM_THREADS=18` (`QNET_SUITE_THREADS` changes it): the MLMC solver's random streams depend on its thread count and the ledger's gates were recorded on an 18-core Mac.
- `finite/fBNAgc check` runs with `PYTHON=/usr/bin/python3` (`QNET_FBNAGC_PYTHON` changes it): Python 3.12 made `sum()` compensated, which moves the last digit of a residual away from the C engine's; under the system Python 3.9 all 48 comparisons are byte-identical. The owner's decision, 2026-11-11. The solver is unchanged.
