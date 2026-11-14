#!/bin/sh
# Regression checks for fBNAlp_solver (run by `make check`).  usage: check.sh ./fBNAlp_solver
#
# 1. A problem whose sizes do not fit the solver's int indices ends with one line on stderr
#    that starts "fBNAlp: this problem is too large for the LP solver", nothing on stdout and
#    exit status 1, before any memory is taken. Before srbm_params_check_size() the grid size
#    grid_n^dimension was formed in an int and wrapped around: oversized_points.in (12^10) went on
#    with 864,813,056 points per face and stopped only when an allocation of 106,669 GB was
#    refused (status 2), and oversized_entries.in (2,985,984 points × 924 basis functions) spent
#    20 s evaluating into a matrix it indexed with a wrapped int, then asked for 17,179,869,176 GB.
# 2. The two small problems (examples/1d.in, examples/2d.in) still solve, with the first
#    moments they have always printed.
set -u
solver="$1"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/fbnalp_check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
failed=0
fail() { printf 'FAIL: %s\n' "$1" >&2; failed=1; }

for name in oversized_points oversized_entries; do
    "$solver" --input "$here/$name.in" --output "$work/out" >"$work/stdout" 2>"$work/stderr"
    rc=$?
    [ "$rc" -eq 1 ] || fail "$name: exit status $rc, expected 1"
    [ "$(wc -l <"$work/stderr" | tr -d ' ')" = "1" ] || { fail "$name: stderr is not one line:"; cat "$work/stderr" >&2; }
    grep -q '^fBNAlp: this problem is too large for the LP solver: dimension [0-9]* with grid_n 12 and basis_m 6 ' "$work/stderr" || { fail "$name: stderr was:"; cat "$work/stderr" >&2; }
    grep -q 'Use a smaller grid_n or basis_m, or a network with fewer stations\.$' "$work/stderr" || fail "$name: the message does not say what to do"
    [ ! -s "$work/stdout" ] || fail "$name: something was printed on stdout"
done

# 3. A basis too large for an int (oversized_basis.in) is refused the same way; it is the input
#    that walks the binomial product in srbm_params_check_size().
name=oversized_basis
"$solver" --input "$here/$name.in" --output "$work/out" >"$work/stdout" 2>"$work/stderr"
rc=$?
[ "$rc" -eq 1 ] || fail "$name: exit status $rc, expected 1"
grep -q '^fBNAlp: this problem is too large for the LP solver: dimension 2 with grid_n 12 and basis_m 2147483647 ' "$work/stderr" || { fail "$name: stderr was:"; cat "$work/stderr" >&2; }
[ ! -s "$work/stdout" ] || fail "$name: something was printed on stdout"

"$solver" --input "$here/../1d.in" --output "$work/out" -c >"$work/stdout" 2>"$work/stderr"
rc=$?
[ "$rc" -eq 0 ] || fail "1d: exit status $rc, expected 0"
grep -q '^E\[X_1\] = 0\.999860$' "$work/stdout" || fail "1d: E[X_1] is not 0.999860"

"$solver" --input "$here/../2d.in" --output "$work/out" -c >"$work/stdout" 2>"$work/stderr"
rc=$?
[ "$rc" -eq 0 ] || fail "2d: exit status $rc, expected 0"
grep -q '^E\[X_1\] = 0\.430507$' "$work/stdout" || fail "2d: E[X_1] is not 0.430507"
grep -q '^E\[X_2\] = 0\.430507$' "$work/stdout" || fail "2d: E[X_2] is not 0.430507"

[ "$failed" -eq 0 ] || exit 1
printf 'fBNAlp check: 5 inputs passed\n'
