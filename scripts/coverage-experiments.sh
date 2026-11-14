#!/bin/sh
# The coverage experiments of the simulation estimators (core/src/simstat/tests.rs and
# tests_extended.rs): every `#[ignore]`d experiment, in release mode, on every core.
#
# Each runs the whole method 200 times from fixed seeds on a model whose exact answer is known
# and counts how often the 95 % interval covers it; the band is 182 to 198 of 200. They are what
# the coverage claims in the ledger and in docs/help/replicatedSimulation.md rest on. The
# default suite (`npm run check`) runs only a 12-run smoke check of each, because the full
# experiments take minutes of every core and starve the suite's timed tests.
#
# Part of the release checklist (docs/DEVELOPING.md, "Building a release"). Run it on a quiet machine; it
# prints every count (`--nocapture`) and fails if any is outside its band.
#
# Usage: scripts/coverage-experiments.sh [filter]     e.g. scripts/coverage-experiments.sh coverage_mmc
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.cargo/bin:$PATH"
sh scripts/cargo-config.sh
exec cargo test --release -p qnet-core --lib "simstat::${1:-}" -- --ignored --nocapture
