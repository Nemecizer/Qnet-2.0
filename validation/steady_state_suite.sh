#!/usr/bin/env bash
# Deterministic regression gate for the added steady-state methods (Qnet 2.0).
#
#   validation/steady_state_suite.sh [Qnet.app | a folder laid out like Contents]
#
# Follows 0.90.34's validation/steady_state_suite.sh step for step. What the
# 2.0 layout changes:
#   - make runs in the build copy outside Dropbox (~/Library/Caches/qnet/solvers/build,
#     made by scripts/stage-solvers.sh), never in the repository's solvers/;
#   - the solvers under test are the shipped ones: the argument's (or $QNET_APP's)
#     Contents/Resources/bin, by default the stage ~/Library/Caches/qnet/solvers/stage;
#   - the steps that compiled Swift sources into harnesses run the Rust and
#     Vitest tests that replaced them (validation/README.md has the mapping);
#   - every step runs even after a failure, and a summary ends the run
#     (0.90.34 stopped at the first failure).
#
# Environment: QNET_APP (the bundle, when no argument is given), QNET_SOLVER_BUILD,
# CARGO_TARGET_DIR (default ~/Library/Caches/qnet/target).

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
QNET_CACHE="$HOME/Library/Caches/qnet/solvers"
SOLVER_BUILD="${QNET_SOLVER_BUILD:-$QNET_CACHE/build}"
SUITE_TARGET="${1:-${QNET_APP:-$QNET_CACHE/stage}}"
if [[ -d "$SUITE_TARGET/Contents" ]]; then
    SUITE_CONTENTS="$SUITE_TARGET/Contents"
else
    SUITE_CONTENTS="$SUITE_TARGET"
fi

export QNET_SOLVER_BUILD="$SOLVER_BUILD"
export QNET_SOLVER_BIN="$SUITE_CONTENTS/Resources/bin"
if [[ -d "$SUITE_CONTENTS/Resources/examples" ]]; then
    export QNET_EXAMPLES="$SUITE_CONTENTS/Resources/examples"
else
    export QNET_EXAMPLES="$PROJECT_ROOT/examples"
fi
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/Library/Caches/qnet/target}"

# ── Preconditions: a build copy that matches solvers/, and something to test ──
[[ -d "$SOLVER_BUILD" && -d "$QNET_SOLVER_BIN" ]] || {
    echo "steady-state suite: no build copy at $SOLVER_BUILD or no solvers at $QNET_SOLVER_BIN." >&2
    echo "Run scripts/stage-solvers.sh first." >&2
    exit 2
}
stale="$(rsync -a --checksum --dry-run --itemize-changes "$PROJECT_ROOT/solvers/" "$SOLVER_BUILD/" \
    | awk '$1 ~ /^>f/ { print "  " $2 }')"
if [[ -n "$stale" ]]; then
    echo "steady-state suite: the build copy is older than solvers/ in:" >&2
    printf '%s\n' "$stale" | head -20 >&2
    echo "Run scripts/stage-solvers.sh first." >&2
    exit 2
fi
printf 'Solvers under test: %s\nBuild copy:         %s\nExamples:           %s\n' \
    "$QNET_SOLVER_BIN" "$SOLVER_BUILD" "$QNET_EXAMPLES"

FAILED=()
PASSED=0
step() {
    local name="$1"
    shift
    printf '\n==> %s\n' "$name"
    if "$@"; then
        printf -- '-- %s: ok\n' "$name"
        PASSED=$((PASSED + 1))
    else
        printf -- '-- %s: FAILED (exit %s)\n' "$name" "$?"
        FAILED+=("$name")
    fi
}

run() {
    step "$1 ($2)" make -C "$SOLVER_BUILD/$1" "$2"
}

# A Rust test that replaced a Swift harness: cargo test, filtered by name. A
# filter that matches nothing is a failure, so a renamed test cannot pass silently.
rust() {
    local output status
    output="$(cd "$PROJECT_ROOT" && cargo test --quiet "$@" 2>&1)"
    status=$?
    printf '%s\n' "$output" | tail -n 12
    [[ "$status" -eq 0 ]] || return "$status"
    if ! printf '%s\n' "$output" | grep -Eq 'test result: ok\. [1-9][0-9]* passed'; then
        echo "no test matched: cargo test $*" >&2
        return 1
    fi
}

# A Vitest file (or files) that replaced a Swift or grep harness.
vitest() {
    (cd "$PROJECT_ROOT" && npx vitest run "$@")
}

# The shared C headers first: three engines depend on them, so a defect here
# would surface as three unrelated parity failures further down.
run common test

run finite/fBNAdecomp test
# fBNAgc's check compares the Python engine with the C one digit for digit. Python 3.12 made the
# built-in sum() compensated, which moves the last digit of a printed residual away from the C
# engine's plain addition; the gate is run under the system Python (3.9), where the 48 comparisons
# are byte-identical. Owner's decision, 2026-11-11. QNET_FBNAGC_PYTHON chooses another.
step "finite/fBNAgc (check)" make -C "$SOLVER_BUILD/finite/fBNAgc" check PYTHON="${QNET_FBNAGC_PYTHON:-/usr/bin/python3}"
run infinite/BNAlp check
run infinite/BNAqbd check
run infinite/BNApf check
run infinite/BNAtc check
run infinite/BNAbb check
run infinite/BNArmc check
run infinite/BNAalr check
run infinite/BNAmd check

printf '\n==> Native solver safety contracts\n'
step "mlmc_native_check" bash "$PROJECT_ROOT/validation/mlmc_native_check.sh"
step "rqna_integration_check" bash "$PROJECT_ROOT/validation/rqna_integration_check.sh"

# Exact SRBM fixtures (Plans.md E04-E08): first the oracles themselves, then
# the existence/stability module, then every SRBM solver against the truth.
# The last step needs the native solvers built (scripts/stage-solvers.sh), and
# infinite/BNAfm/bna_fm, which is not shipped: 0.90.34's build_all_algorithms.sh
# built it, here it is built in the build copy.
printf '\n==> SRBM oracles, existence checks and solver accuracy\n'
step "research_fixtures/oracle_check" python3 "$PROJECT_ROOT/validation/research_fixtures/oracle_check.py" --quiet
# was srbm_existence_check.sh: the 36 harness checks are unit tests of core/src/existence.rs
step "srbm_existence_check -> qnet-core existence::" rust -p qnet-core --lib existence::
step "infinite/BNAfm (build the unshipped wrapper)" make -C "$SOLVER_BUILD/infinite/BNAfm" bna_fm
# The MLMC solver's random streams depend on its thread count, and the ledger's gates were
# recorded on an 18-core Mac: the same pin the runner's golden tests use (runner/tests/common).
step "research_fixtures/run_solvers" env OMP_NUM_THREADS="${QNET_SUITE_THREADS:-18}" python3 "$PROJECT_ROOT/validation/research_fixtures/run_solvers.py"

printf '\n==> GUI/export/runtime contracts\n'
step "example_contracts" python3 "$PROJECT_ROOT/validation/example_contracts.py"
# was result_output_parser_check.sh: the harness's 11 check functions, ported with the same inputs
step "result_output_parser_check -> qnet-core results::harness::" rust -p qnet-core --lib results::harness::
# was product_form_exporter_check.sh / qbd_exporter_check.sh: the harness's documents and refusals
step "product_form_exporter_check -> qnet-core export::product_form::tests::harness_" \
    rust -p qnet-core --lib export::product_form::tests::harness_
step "qbd_exporter_check -> qnet-core export::qbd::tests::harness_" \
    rust -p qnet-core --lib export::qbd::tests::harness_
# was solver_runtime_resolver_check.sh: the resolver's cases, and the bundle list naming ctmc_dtandem.py
step "solver_runtime_resolver_check -> qnet-runner --test resolver" rust -p qnet-runner --test resolver
ctmc_dtandem_is_listed() {
    grep -Fqx '    "finite/fBNActmc/ctmc_dtandem.py"' "$PROJECT_ROOT/scripts/stage-solvers.sh" \
        || { echo "ctmc_dtandem.py is absent from the bundle support list" >&2; return 1; }
    grep -Fqx '    "finite/fBNActmc/ctmc_dtandem.py:numpy"' "$PROJECT_ROOT/scripts/stage-solvers.sh" \
        || { echo "ctmc_dtandem.py NumPy dependency metadata is absent" >&2; return 1; }
    [[ -f "$PROJECT_ROOT/solvers/finite/fBNActmc/ctmc_dtandem.py" ]] \
        || { echo "ctmc_dtandem.py source is absent" >&2; return 1; }
}
step "solver_runtime_resolver_check -> ctmc_dtandem.py in scripts/stage-solvers.sh" ctmc_dtandem_is_listed
# was startup_dependency_check.sh: catalog and launch rule in Rust, the sheet's behaviour in Vitest
step "startup_dependency_check -> qnet analysis_windows::deps::" rust -p qnet --lib analysis_windows::deps::
step "startup_dependency_check -> src/analysis/deps.test.tsx" vitest src/analysis/deps.test.tsx
# was settings_anchor_check.sh: every Settings row is reachable by search under its own title
step "settings_anchor_check -> qnet settings_schema::" rust -p qnet --lib settings_schema::
step "settings_anchor_check -> src/windows/settings/settings.test.tsx" vitest src/windows/settings/settings.test.tsx
step "solver_bundle_audit_check" bash "$PROJECT_ROOT/validation/solver_bundle_audit_check.sh"
# was gui_runtime_contracts.sh: the shell wrappers it pinned are gone (PLAN D1); the supervisor
# tests hold what they guaranteed (temp files removed on every exit path, Stop reaches the group).
# Its other pins (state-space cap, CTMC sentinel and provenance, MLMC replication line, the
# engine fallback) are golden comparisons in runner/tests/methods_*.rs: `npm run check`, cargo step.
step "gui_runtime_contracts -> qnet-runner --test supervisor_processes" rust -p qnet-runner --test supervisor_processes
step "gui_runtime_contracts -> qnet-runner --test supervisor_jobs" rust -p qnet-runner --test supervisor_jobs
# was embedded_formatter_parse_check.sh: the perl filter and the awk aggregators are Rust now,
# compared with 0.90.34's own programs
step "embedded_formatter_parse_check -> qnet-core --test output_precision" rust -p qnet-core --test output_precision
step "embedded_formatter_parse_check -> qnet-core --test output_table" rust -p qnet-core --test output_table
step "embedded_formatter_parse_check -> qnet-core --test output_aggregators" rust -p qnet-core --test output_aggregators

# Not part of 0.90.34's suite, run here because Qnet 2.0 has no build_app.sh to run them:
# the design lint (0.90.34: build_app.sh refused to build on a violation), the bundle
# audit of the thing under test (0.90.34: build_app.sh and make_pkg.sh ran it), and the SBD
# comparison with Dai-Nguyen-Reiman, which prints numbers and gates nothing.
printf '\n==> Design lint, bundle audit, SBD report\n'
step "design_lint -> src/test/contrast.test.ts, colour-policy.test.ts" \
    vitest src/test/contrast.test.ts src/test/colour-policy.test.ts
step "design_lint -> scripts/help-lint.mjs" node "$PROJECT_ROOT/scripts/help-lint.mjs"
step "solver_bundle_audit $SUITE_TARGET" bash "$PROJECT_ROOT/validation/solver_bundle_audit.sh" "$SUITE_TARGET"
step "sbd_cyclic_validation (report only)" bash "$PROJECT_ROOT/validation/sbd_cyclic_validation.sh"

if [[ "${#FAILED[@]}" -ne 0 ]]; then
    printf '\n%d step(s) passed, %d failed:\n' "$PASSED" "${#FAILED[@]}"
    printf '  %s\n' "${FAILED[@]}"
    exit 1
fi
printf '\nAll added steady-state method checks passed (%d steps).\n' "$PASSED"
