#!/bin/sh
# check_inputs.sh <mc_solver> — runs every case in tests/inputs/.
#
# A case is <name>.bnet with <name>.expect beside it:
#     args=<arguments before the file>
#     exit=<the exit status it must end with>
#     stderr=<text standard error must contain>     (optional)
#     stdout=<text standard output must contain>    (optional)
# Lines starting with # say what the case is for.
#
# Whatever the expectation, a case fails if the solver ends on a signal, takes
# longer than the time limit, or prints a sanitizer report: a damaged or
# oversized input must end in a message and exit status 1, never in a crash.
set -u
solver=${1:?usage: check_inputs.sh <mc_solver>}
here=$(cd "$(dirname "$0")" && pwd)
limit=${MC_CHECK_TIMEOUT:-300}
work=$(mktemp -d "${TMPDIR:-/tmp}/qnet-mc-check.XXXXXX") || exit 1
trap 'rm -rf "$work"' EXIT

ASAN_OPTIONS=${ASAN_OPTIONS:-detect_leaks=0:allocator_may_return_null=1}
UBSAN_OPTIONS=${UBSAN_OPTIONS:-print_stacktrace=1:halt_on_error=1}
export ASAN_OPTIONS UBSAN_OPTIONS

pass=0
fail=0
for expect in "$here"/inputs/*.expect; do
    [ -f "$expect" ] || continue
    name=$(basename "$expect" .expect)
    input="$here/inputs/$name.bnet"
    args=$(sed -n 's/^args=//p' "$expect")
    want_exit=$(sed -n 's/^exit=//p' "$expect")
    want_err=$(sed -n 's/^stderr=//p' "$expect")
    want_out=$(sed -n 's/^stdout=//p' "$expect")

    # shellcheck disable=SC2086  # the arguments are meant to split on spaces
    perl -e 'alarm shift; exec @ARGV or exit 127' "$limit" "$solver" $args "$input" \
        > "$work/out" 2> "$work/err"
    got=$?

    why=""
    if [ "$got" -ge 128 ]; then
        why="ended on signal $((got - 128)) (exit $got)"
    elif grep -q -e 'AddressSanitizer' -e 'runtime error:' "$work/err"; then
        why="sanitizer report"
    elif [ "$got" != "$want_exit" ]; then
        why="exit $got, expected $want_exit"
    elif [ "$got" -ne 0 ] && [ ! -s "$work/err" ]; then
        why="failed without a message"
    elif [ -n "$want_err" ] && ! grep -q -F -e "$want_err" "$work/err"; then
        why="standard error lacks \"$want_err\""
    elif [ -n "$want_out" ] && ! grep -q -F -e "$want_out" "$work/out"; then
        why="standard output lacks \"$want_out\""
    fi

    if [ -z "$why" ]; then
        pass=$((pass + 1))
    else
        fail=$((fail + 1))
        echo "FAIL $name: $why"
        sed 's/^/    | /' "$work/err" | head -12
    fi
done

echo "multiclass input checks ($(basename "$solver")): $pass passed, $fail failed"
[ "$fail" -eq 0 ] && [ "$pass" -gt 0 ]
