#!/usr/bin/env bash
# SBD validation on cyclic and feedforward inputs.
#
# Recommendation #3 from the feedforward-readiness review: confirm that the
# SBD implementation does not silently degrade on networks with feedback
# (cycles or self-loops) by comparing against published Dai-Nguyen-Reiman
# (1994) values.
#
# Inputs (all with paper-tabulated targets in their headers):
#   infinite/BNAsbd/test_3station.in   cyclic, partition {1,3}+{2}
#   infinite/BNAsbd/test_5station.in   cyclic, single 5-station group
#   infinite/BNAsbd/test_9series.in    acyclic tandem, partition {1..5}+{6..9}
#
# We compare two quantities:
#   * Per-customer total sojourn:  the program's "Mean sojourn time E[T]" line.
#   * Per-station E[T_j]:          paper Table III reports these for case 1.
#
# Set -euo pipefail and write logs into this directory.

set -euo pipefail

# Qnet 2.0: the executables are the shipped ones (QNET_SOLVER_BIN: the stage's or a bundle's
# Contents/Resources/bin; bna_sbd finds ../BNAsm/bnet beside itself), the test inputs are read
# from the build copy outside Dropbox (QNET_SOLVER_BUILD), and the raw outputs go to a
# temporary folder. 0.90.34 built in, read from and wrote into the source tree; nothing is
# built here (scripts/stage-solvers.sh does that).
QNET_CACHE="$HOME/Library/Caches/qnet/solvers"
SOLVER_BIN="${QNET_SOLVER_BIN:-$QNET_CACHE/stage/Resources/bin}"
SOLVER_BUILD="${QNET_SOLVER_BUILD:-$QNET_CACHE/build}"
SBD="$SOLVER_BIN/infinite/BNAsbd/bna_sbd"
BNET="$SOLVER_BIN/infinite/BNAsm/bnet"
OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qnet-sbd-cyclic.XXXXXX")"

if [[ ! -x "$BNET" || ! -x "$SBD" ]]; then
  echo "bna_sbd or bnet is missing under $SOLVER_BIN: run scripts/stage-solvers.sh" >&2
  exit 1
fi

run_sbd() {
  local inp="$1"
  local raw="$OUT_DIR/sbd_${inp%.in}.out"
  ( cd "$SOLVER_BUILD/infinite/BNAsbd" && "$SBD" "$inp" ) >"$raw" 2>&1
  echo "$raw"
}

extract_per_customer_sojourn() {
  awk -F: '/Mean sojourn time E\[T\]/ { gsub(/ /,"",$2); printf "%.3f", $2+0 }' "$1"
}

extract_station_ET() {
  # Returns per-station E[T] (column 5) as comma-separated string.
  awk '
    BEGIN { found=0 }
    /^Node[ ]+Util/ { found=1; next }
    found && /^[ ]*[0-9]+[ ]/ { vals = vals (vals?",":"") sprintf("%.3f",$5+0) }
    found && NF==0 { found=0 }
    END { printf "%s", vals }
  ' "$1"
}

rel_err() { awk -v s="$1" -v p="$2" 'BEGIN { printf "%+.1f%%", 100*(s-p)/p }'; }

echo "============================================================"
echo " SBD validation against Dai-Nguyen-Reiman (1994)"
echo "============================================================"

# --- 3-station cyclic --------------------------------------------------------
raw=$(run_sbd test_3station.in)
sojourn=$(extract_per_customer_sojourn "$raw")
station_ET=$(extract_station_ET "$raw")

echo
echo "[1] 3-station cyclic (DNR §3.1, System D Case 1)"
echo "    Cycle: S2 <-> S1, S2 <-> S3."
echo "    Paper Table III per-station E[T]: 2.471, 11.406, 2.585"
echo "    SBD  per-station E[T]:           ${station_ET}"
echo "    Per-customer mean sojourn (Little's law): ${sojourn}"

# --- 5-station cyclic --------------------------------------------------------
raw=$(run_sbd test_5station.in)
sojourn=$(extract_per_customer_sojourn "$raw")
echo
echo "[2] 5-station cyclic (DNR §3.2, System A Case 1)"
echo "    Cycles: each of {2,3,4,5} feeds back to S1 with prob 0.5."
echo "    Paper Table VII: SBD = 6.95, simulation = 6.725"
echo "    SBD per-customer mean sojourn:           ${sojourn}    ($(rel_err "$sojourn" 6.95) vs paper-SBD)"

# --- 9-series acyclic (control) ---------------------------------------------
raw=$(run_sbd test_9series.in)
# Paper compares total mean *waiting* time. Sum E[W] (column 3).
sum_W=$(awk '
  BEGIN { found=0 }
  /^Node[ ]+Util/ { found=1; next }
  found && /^[ ]*[0-9]+[ ]/ { s += $3 }
  found && NF==0 { found=0 }
  END { printf "%.3f", s }
' "$raw")
echo
echo "[3] 9-station tandem acyclic (DNR §3.3) — control case, no cycles"
echo "    Paper Table VIII: SBD total E[W] = 10.06, simulation = 10.05"
echo "    SBD total E[W] (sum over stations):    ${sum_W}    ($(rel_err "$sum_W" 10.06) vs paper-SBD)"

echo
echo "Raw outputs:    $OUT_DIR/sbd_test_*.out"
echo "Done."
