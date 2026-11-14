#!/bin/bash
# Regenerates the awk programs 0.90.34 generated, the oracles of tests/output_*.rs:
#   comparison_awk.txt   buildComparisonAwk for a spread of parameter sets
#   lp_summary.txt       lpSummaryAwk (with OUT for the stage's output file)
#   testset_awk.txt      testSetAggregatorAwk, infinite and finite (work folder W)
#   spectral_awk.txt     spectralConvergenceAggregatorAwk (work folder W)
#   adaptive_bar.txt     runAdaptiveLowRankBAR's queue-length stage (w=2, capacities "2 0.5")
#   mlmc_check.awk, mlmc_aggregate.awk   runExactSim's replication check and aggregator programs
# The functions (and the adaptive-BAR expression) are copied verbatim (only `private` dropped) out
# of 2_QNET's QnetGUIApp.swift into a scratch Swift program under ~/Library/Caches/qnet, with
# `appSettings.outputDecimals` stubbed, compiled and run; the two MLMC programs are plain text in a
# Swift multi-line literal and are cut out of it directly. 2_QNET is only read.
# Usage: make-awk-oracles.sh [path/to/QnetGUIApp.swift]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
swift_src="${1:-$here/../../../../../../2_QNET/Sources/Qnet/QnetGUIApp.swift}"
work="$HOME/Library/Caches/qnet/output-oracles"
mkdir -p "$work"
extract() { # $1 = function name: from its declaration to the first line that is exactly "    }"
  awk -v name="$1" '
    !on && index($0, "func " name "(") { on = 1 }
    on { sub(/^    (nonisolated )?private /, "    "); print }
    on && $0 == "    }" { exit }' "$swift_src"
}
{
  echo 'import Foundation'
  echo 'struct Settings { var outputDecimals = 3 }'
  echo 'var appSettings = Settings()'
  extract buildComparisonAwk
  extract lpSummaryAwk
  extract testSetAggregatorAwk
  extract spectralConvergenceAggregatorAwk
  echo 'func adaptiveBarAwk(indexWidth: Int, muList: String) -> String {'
  awk '/let awk = "awk -v w=/ { on = 1 } on { print } on && /u\[i\]}}/ { exit }' "$swift_src"
  echo '  return awk'
  echo '}'
  cat <<'SWIFT'
func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
struct Case { var n: Int; var labels: [String]; var v: String; var g: Bool; var s: Bool; var xc: Bool
              var an: Int; var anLabel: String?; var avg: Bool; var dec: Int }
var cases: [Case] = []
let labelsets: [[String]] = [["QNA"], ["Spectral", "Simulation"], ["Spectral", "FE (Gauss)", "Simulation"],
    ["Spectral", "FE (Gauss)", "Finite LP", "Simulation"], ["Spectral", "QNA", "RQNA", "SBD", "Simulation"]]
for (li, labels) in labelsets.enumerated() {
  for an in 0...2 {
    for v in ["X", "Q"] {
      let avg = li >= 2 && v == "X"
      cases.append(Case(n: labels.count, labels: labels, v: v, g: true, s: true, xc: false, an: an,
                        anLabel: an == 1 ? "Exact E[N]  (Jackson)" : (an == 2 ? "  " : nil), avg: avg, dec: 3))
    }
  }
}
cases.append(Case(n: 1, labels: ["Simulation"], v: "Q", g: false, s: true, xc: true, an: 1, anLabel: "Asymptotic E[X]", avg: false, dec: 3))
cases.append(Case(n: 3, labels: ["A", "B", "C"], v: "Q", g: true, s: false, xc: true, an: 2, anLabel: nil, avg: true, dec: 3))
cases.append(Case(n: 4, labels: ["Spectral", "FE (Gauss)", "Finite LP", "Simulation"], v: "X", g: true, s: true, xc: true, an: 0, anLabel: nil, avg: false, dec: 3))
for d in [0, 1, 2, 4, 5, 6, 7, 8, 9] {
  cases.append(Case(n: 4, labels: ["Spectral", "FE (Gauss)", "Finite LP", "Simulation"], v: "X", g: true, s: true, xc: false, an: 1, anLabel: "Exact E[N]  (Jackson)", avg: true, dec: d))
}
let which = CommandLine.arguments.dropFirst().first ?? "comparison"
if which == "lp" { print(lpSummaryAwk(outFile: "OUT")); exit(0) }
if which == "testset" {
  print("### infinite"); print(testSetAggregatorAwk(workDir: "W", varName: "Q", algoOrder: ["Spectral", "QNA", "RQNA", "SBD", "Sim"], referenceKey: "Sim"), terminator: "")
  print("### finite"); print(testSetAggregatorAwk(workDir: "W", varName: "X", algoOrder: ["Spectral", "FE", "LP", "Sim"], referenceKey: "Sim"), terminator: "")
  exit(0)
}
if which == "spectral" { print(spectralConvergenceAggregatorAwk(workDir: "W", rhoValues: [0.5, 0.7, 0.85, 0.95, 0.99]), terminator: ""); exit(0) }
if which == "adaptive" { print(adaptiveBarAwk(indexWidth: 2, muList: "2 0.5")); exit(0) }
for c in cases {
  appSettings.outputDecimals = c.dec
  let outputs = (1...c.n).map { (file: "F\($0)", label: c.labels[$0 - 1]) }
  let cmd = buildComparisonAwk(outputs: outputs, varName: c.v, showGamma: c.g, showSojourn: c.s, showXClass: c.xc,
                               analyticalPath: c.an == 0 ? nil : "AN", analyticalLabel: c.anLabel,
                               analyticalIsExact: c.an == 1, showAverageAlgorithm: c.avg)
  print("### n=\(c.n) labels=\(c.labels.joined(separator: "|")) var=\(c.v) gamma=\(c.g ? 1 : 0) sojourn=\(c.s ? 1 : 0) xclass=\(c.xc ? 1 : 0) an=\(c.an) anlabel=\(c.anLabel ?? "") avg=\(c.avg ? 1 : 0) decimals=\(c.dec)")
  print(cmd)
}
SWIFT
} > "$work/main.swift"
swiftc -O -o "$work/oracle" "$work/main.swift"
"$work/oracle" > "$here/comparison_awk.txt"
"$work/oracle" lp > "$here/lp_summary.txt"
"$work/oracle" testset > "$here/testset_awk.txt"
"$work/oracle" spectral > "$here/spectral_awk.txt"
"$work/oracle" adaptive > "$here/adaptive_bar.txt"

# The MLMC programs: the lines between the one opening the program and the one closing it, with
# the literal's 12-space indentation removed and Swift's `\\` read as `\`.
python3 -I - "$swift_src" "$here" <<'PY'
import sys
src, here = sys.argv[1], sys.argv[2]
lines = open(src, encoding="utf-8").read().split("\n")
def cut(opener, closer, out):
    i = next(n for n, l in enumerate(lines) if opener in l)
    j = next(n for n in range(i + 1, len(lines)) if closer in lines[n])
    body = []
    for l in lines[i + 1:j]:
        assert l == "" or l.startswith(" " * 12), l
        assert "\\(" not in l, "an interpolation inside the program: " + l
        body.append(l[12:].replace("\\\\", "\\"))
    open(f"{here}/{out}", "w", encoding="utf-8").write("\n".join(body) + "\n")
cut("if ! awk -v expected=", "' \"\\(outFileBase).$k\"; then", "mlmc_check.awk")
cut('awk -v mu="$MU" -v K=$K -v critical=', "' < /dev/null", "mlmc_aggregate.awk")
PY
echo "wrote the oracles in $here ($(grep -c '^###' "$here/comparison_awk.txt") comparison programs)"
