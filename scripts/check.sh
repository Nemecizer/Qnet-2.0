#!/bin/sh
# Everything that has to pass before a change is done: types, the interface tests (the colour
# policy and contrast checks over every stylesheet included) and the Rust tests. Runs every step
# even after a failure and prints a summary at the end. (NetMon's check.sh, without its Windows
# agent step; the solver harnesses join in P3 and P8, PLAN.md §5.)
# Set CARGO_TARGET_DIR to keep cargo's build separate from the dev app's.
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.cargo/bin:$PATH"
sh scripts/cargo-config.sh
failed=""
skipped=""

step() {
  name="$1"
  shift
  printf '\n== %s\n' "$name"
  if "$@"; then
    printf -- '-- %s: ok\n' "$name"
  else
    printf -- '-- %s: FAILED\n' "$name"
    failed="$failed $name"
  fi
}

step "typescript" npx tsc --noEmit
step "vitest" npx vitest run
step "help-lint" node scripts/help-lint.mjs
step "verify-version" node scripts/verify-version.mjs
step "notices" node scripts/notices.mjs --check
# --no-fail-fast: one crate's failing test doesn't hide the other crates' results.
step "cargo" cargo test --workspace --quiet --no-fail-fast
# The Python package (python/qnet) against the debug qnet-cli cargo has just built. Without a
# Python this step cannot run: it says so here and in the summary, and does not fail the check.
if scripts/check-python.sh --have-python; then
  step "python" scripts/check-python.sh
else
  printf '\n== python\n-- python: SKIPPED (no python3 on PATH and no staged Python: the qnet package tests did not run)\n'
  skipped="$skipped python"
fi

if [ -n "$skipped" ]; then
  printf '\nSkipped:%s\n' "$skipped"
fi
if [ -n "$failed" ]; then
  printf '\nFailed:%s\n' "$failed"
  exit 1
fi
printf '\nAll checks passed.\n'
