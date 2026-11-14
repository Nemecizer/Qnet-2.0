#!/bin/sh
# Regression checks for srbm_lp (run by `make check`).  usage: check.sh ./srbm_lp
#
# 1. An input whose dimension is above SRBM_MAX_DIM (10) ends with one line on stderr,
#    "Invalid dimension d=N (must be 1..10)", nothing on stdout and exit status 1. Before the
#    fix in srbm_params.c the drift, covariance, reflection, grid_spacing and tightness_bounds
#    blocks were read into arrays sized for 10 dimensions first: d=20 aborted (status 134), and
#    d=11 to 17 overran the arrays silently before the same message. A build with
#    -fsanitize=address,undefined shows the overrun on the old code for both inputs:
#        make clean && make check CC="clang -fsanitize=address,undefined"
# 2. A small LP (examples/example1.txt, Harrison's 2-D SRBM) still solves, with the first
#    moments it has always printed.
set -u
solver="$1"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/srbm_lp_check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
failed=0
fail() { printf 'FAIL: %s\n' "$1" >&2; failed=1; }

for d in 11 20; do
    "$solver" --input "$here/oversized_d$d.in" --output "$work/out" >"$work/stdout" 2>"$work/stderr"
    rc=$?
    [ "$rc" -eq 1 ] || fail "d=$d: exit status $rc, expected 1"
    [ "$(cat "$work/stderr")" = "Invalid dimension d=$d (must be 1..10)" ] || { fail "d=$d: stderr was:"; cat "$work/stderr" >&2; }
    [ ! -s "$work/stdout" ] || fail "d=$d: something was printed on stdout"
done

"$solver" --input "$here/../example1.txt" --output "$work/out" -c >"$work/stdout" 2>"$work/stderr"
rc=$?
[ "$rc" -eq 0 ] || fail "example1: exit status $rc, expected 0"
grep -q '^E\[X_1\] = 0\.500000$' "$work/stdout" || fail "example1: E[X_1] is not 0.500000"
grep -q '^E\[X_2\] = 0\.727354$' "$work/stdout" || fail "example1: E[X_2] is not 0.727354"

[ "$failed" -eq 0 ] || exit 1
printf 'srbm_lp check: 3 inputs passed\n'
