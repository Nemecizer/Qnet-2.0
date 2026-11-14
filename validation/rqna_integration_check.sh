#!/usr/bin/env bash
# Build-and-run contract for the RQNA path exposed by the GUI.

set -euo pipefail

CHECK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Qnet 2.0: the executable under test is the shipped one (QNET_SOLVER_BIN: the stage's or a
# bundle's Contents/Resources/bin); make runs in the build copy outside Dropbox
# (QNET_SOLVER_BUILD), never in the repository; the example is examples/ (0.90.34:
# input/examples); and the .qna input comes from the Rust exporter through qnet-cli, where
# 0.90.34 compiled QNAExporter.swift into a harness (validation/rqna_exporter/).
CHECK_CACHE="$HOME/Library/Caches/qnet/solvers"
CHECK_SOLVER_BIN="${QNET_SOLVER_BIN:-$CHECK_CACHE/stage/Resources/bin}"
CHECK_SOLVER_BUILD="${QNET_SOLVER_BUILD:-$CHECK_CACHE/build}"
CHECK_BINARY="$CHECK_SOLVER_BIN/infinite/BNArqna/bna_rqna"
CHECK_EXAMPLE="${QNET_EXAMPLES:-$CHECK_ROOT/examples}/3d3ctandem.inf.bnet"
CHECK_INPUT="$(mktemp "${TMPDIR:-/tmp}/qnet-rqna-input.XXXXXX")"
CHECK_OUTPUT="$(mktemp "${TMPDIR:-/tmp}/qnet-rqna-output.XXXXXX")"
CHECK_ERROR="$(mktemp "${TMPDIR:-/tmp}/qnet-rqna-error.XXXXXX")"
trap 'rm -f "$CHECK_INPUT" "$CHECK_OUTPUT" "$CHECK_ERROR"' EXIT

fail() {
    printf 'RQNA integration check failed: %s\n' "$*" >&2
    if [[ -s "$CHECK_ERROR" ]]; then
        sed 's/^/  /' "$CHECK_ERROR" >&2
    fi
    exit 1
}

# The packager and the independent release inventory must both name RQNA.
# Checking both closes the exact gap that let an app ship without this binary.
grep -Fqx '    "infinite/BNArqna:bna_rqna"' "$CHECK_ROOT/scripts/stage-solvers.sh" \
    || fail "scripts/stage-solvers.sh does not require infinite/BNArqna:bna_rqna"
grep -Fqx 'infinite/BNArqna/bna_rqna' \
    "$CHECK_ROOT/validation/required_release_executables.txt" \
    || fail "the release audit inventory does not require RQNA"

make -C "$CHECK_SOLVER_BUILD/infinite/BNArqna" bna_rqna >/dev/null \
    || fail "the native executable did not build"
[[ -x "$CHECK_BINARY" ]] || fail "the shipped executable is missing: $CHECK_BINARY"
"$CHECK_BINARY" --selftest >"$CHECK_OUTPUT" 2>"$CHECK_ERROR" \
    || fail "the native self-test failed"
grep -Fq 'PASS: all tests passed' "$CHECK_OUTPUT" \
    || fail "the native self-test did not report success"

# Export a real three-class GUI document with the production exporter (Rust,
# core/src/export/qna.rs, through qnet-cli) and pass its complete extended .qna
# output to the native parser.  This covers the boundary that a hand-written
# legacy fixture would miss (tau/alpha/mu/cs/lambda_ext/P_ex/ca0).
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/Library/Caches/qnet/target}"
cargo run --quiet --manifest-path "$CHECK_ROOT/Cargo.toml" -p qnet-cli -- \
    export qna "$CHECK_EXAMPLE" "$CHECK_INPUT" >/dev/null 2>"$CHECK_ERROR" \
    || fail "the QNA exporter did not produce the RQNA input"
# The sections 0.90.34's harness (validation/rqna_exporter/main.swift) required.
for section in \
    'customer_classes 3' \
    '# Per-class throughput alpha[k][i] (K rows x d cols)' \
    '# Per-class service rate mu[k][i] (K rows x d cols)' \
    '# Per-class service SCV cs[k][i] (K rows x d cols)' \
    '# Per-class external arrival rate at station lambda_ext[k][i] (K rows x d cols)' \
    "# Per-(class, station) routing P_ex[k*d+i][k'*d+j] ((K*d) x (K*d))" \
    '# Per-class external SCV ca0_pc[k][i] (K rows x d cols)'; do
    grep -Fq -- "$section" "$CHECK_INPUT" || fail "export omitted section: $section"
done

: > "$CHECK_ERROR"
"$CHECK_BINARY" "$CHECK_INPUT" -c >"$CHECK_OUTPUT" 2>"$CHECK_ERROR" \
    || fail "compact analysis did not run"

grep -Fqx 'RQNA (BNArqna)' "$CHECK_OUTPUT" \
    || fail "compact output omitted the RQNA banner"
for metric in 'rho_' 'Gamma_' 'sojourn_' 'E[Q_'; do
    metric_count="$(grep -F -c "$metric" "$CHECK_OUTPUT")"
    [[ "$metric_count" -eq 3 ]] \
        || fail "compact output contains $metric_count $metric rows instead of 3"
done

printf 'RQNA build, self-test, GUI export, compact run, and release contracts passed.\n'
