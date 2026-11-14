#!/bin/sh
# The tests of the Python package `qnet` (python/tests, unittest) against the debug `qnet-cli`.
#
#   scripts/check-python.sh                 build qnet-cli, run the tests
#   scripts/check-python.sh --have-python   exit 0 when there is a Python to run them with
#
# The Python is `python3` from PATH, else Qnet's own staged one (scripts/stage-python.sh). The
# tool is the debug build in cargo's target folder (CARGO_TARGET_DIR, else .cargo/config.toml);
# QNET_CLI names another. Tests that need the solvers skip themselves where none are staged.
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.cargo/bin:$PATH"

staged="${QNET_PYTHON_STAGE:-$HOME/Library/Caches/qnet/python/stage}/Resources/python/bin/python3"
if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
  python=python3
elif [ -x "$staged" ]; then
  python="$staged"
else
  python=""
fi
if [ "$1" = "--have-python" ]; then
  [ -n "$python" ]
  exit
fi
[ -n "$python" ] || { echo "check-python: no python3 (3.9 or later) on PATH and no staged Python at $staged" >&2; exit 1; }

sh scripts/cargo-config.sh
if [ -z "$QNET_CLI" ]; then
  cargo build -p qnet-cli --quiet || exit 1
fi
printf 'check-python: %s\n' "$("$python" --version 2>&1)"
cd python || exit 1
# -B: no bytecode beside the sources. -W error::ResourceWarning: a temporary folder left behind fails.
exec "$python" -B -W error::ResourceWarning -m unittest discover -s tests -t .
