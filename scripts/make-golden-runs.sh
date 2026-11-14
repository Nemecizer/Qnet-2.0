#!/usr/bin/env bash
# Writes golden/runs/: what Qnet 0.90.34's Run menu produces for each of the 50 shipped examples,
# by running 0.90.34's own pipeline headless (PLAN.md §7 P3). For every method of the example's
# buffer mode it keeps the generated wrapper, the full-precision archive the parser read, the
# filtered display stream, the Status lines, and the Results record the parser filed. Read
# golden/tools/GoldenRuns.swift for what each file is.
#
# Like make-golden.sh it never builds in or writes to 2_QNET: it extracts one commit with
# `git archive` into ~/Library/Caches/qnet/legacy-0.90.34-runs/src, adds GoldenDump.swift and
# GoldenRuns.swift, makes the five hook edits GoldenRuns.swift lists (inert unless its dump runs),
# and builds the copy. Solvers come from the staged tree (scripts/stage-solvers.sh) through
# QNET_SOLVER_ROOT, so 0.90.34 and 2.0 run the very same binaries.
#
# Settings are 0.90.34's defaults except: fixed seeds; simulations shortened to 8 replications,
# warm-up 10,000 and run length 200,000, run sequentially; Run Comparison uses the stored blocking
# regime without asking (GoldenRuns.swift goldenPrepareSettings).
#
# The solver output files each run leaves in the temporary folder (what its awk tables read) are
# moved to ~/Library/Caches/qnet/legacy-0.90.34-runs/tmp/<example>/<method>/, outside the repository.
#
# Usage: scripts/make-golden-runs.sh [--jobs N] [--testsets-only] [example-stem ...]
set -euo pipefail

COMMIT=dc066f0
JOBS=4
TESTSETS_ONLY=0
STEMS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --jobs) JOBS="$2"; shift 2 ;;
        --testsets-only) TESTSETS_ONLY=1; shift ;;
        -*) printf 'ERROR: unknown option %s\n' "$1" >&2; exit 2 ;;
        *) STEMS+=("$1"); shift ;;
    esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
QNET090="$(cd "$ROOT/../../2_QNET" && pwd -P)"
LEGACY="$HOME/Library/Caches/qnet/legacy-0.90.34-runs"
SRC="$LEGACY/src"
OUT="$ROOT/golden/runs"
SOLVER_ROOT="$HOME/Library/Caches/qnet/solvers/stage/Resources"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ -d "$SOLVER_ROOT/bin" ] || die "no staged solvers at $SOLVER_ROOT (run scripts/stage-solvers.sh)"

full_commit="$(git -C "$QNET090" rev-parse --verify "$COMMIT^{commit}")" || die "no commit $COMMIT in $QNET090"
printf '==> Extracting %s of %s into %s\n' "$full_commit" "$QNET090" "$SRC"
rm -rf "$SRC"
mkdir -p "$SRC"
git -C "$QNET090" archive "$full_commit" | tar -x -C "$SRC"

printf '==> Adding the run dump and its hooks to the copy\n'
python3 - "$SRC/Sources/Qnet" "$ROOT/golden/tools" <<'PY'
import pathlib, sys
src, tools = map(pathlib.Path, sys.argv[1:])

def edit(path, before, after):
    text = path.read_text(encoding="utf-8")
    if text.count(before) != 1:
        raise SystemExit(f"{path.name}: anchor not found exactly once:\n{before}")
    path.write_text(text.replace(before, after), encoding="utf-8")

app = src / "QnetGUIApp.swift"
edit(app,
     "            _activeTabID = State(initialValue: activeID ?? restoredTabs[0].id)\n        }\n    }\n",
     "            _activeTabID = State(initialValue: activeID ?? restoredTabs[0].id)\n        }\n"
     "        runGoldenDumpIfRequested()\n        goldenRetitleIfRequested()\n        runGoldenRunsIfRequested()\n    }\n")
edit(app,
     "        onRun: @escaping (RunParameterValues) -> Void\n    ) {\n",
     "        onRun: @escaping (RunParameterValues) -> Void\n    ) {\n"
     "        if GoldenRunHook.active { onRun(spec.values); return }\n")
edit(app,
     "    private func showAlert(title: String, message: String, style: NSAlert.Style) {\n",
     "    private func showAlert(title: String, message: String, style: NSAlert.Style) {\n"
     "        if GoldenRunHook.active { GoldenRunHook.notes.append(\"ALERT \\(title): \\(message)\"); return }\n")

term = src / "TerminalModel.swift"
edit(term, "        if let activeRun {\n", "        if !GoldenRunHook.active, let activeRun {\n")
edit(term,
     "        runPollTask = Task { @MainActor [weak self] in\n",
     "        if !GoldenRunHook.active { runPollTask = Task { @MainActor [weak self] in\n")
edit(term,
     "        return RunHandle(\n            id: id,\n            donePath: donePath,\n            pidPath: pidPath,\n"
     "            statusPath: statusPath,\n            outputPath: outputPath\n        )\n",
     "        }\n        let goldenHandle = RunHandle(\n            id: id,\n            donePath: donePath,\n"
     "            pidPath: pidPath,\n            statusPath: statusPath,\n            outputPath: outputPath\n        )\n"
     "        GoldenRunHook.lastHandle = goldenHandle\n        GoldenRunHook.lastLabel = label\n"
     "        return goldenHandle\n")
edit(term,
     "    func sendCommand(_ command: String) -> Bool {\n",
     "    func sendCommand(_ command: String) -> Bool {\n"
     "        if GoldenRunHook.active, let run = GoldenRunHook.execute { return run(command) }\n")

text = app.read_text(encoding="utf-8")
text += "\n" + (tools / "GoldenDump.swift").read_text(encoding="utf-8")
text += "\n" + (tools / "GoldenRuns.swift").read_text(encoding="utf-8")
app.write_text(text, encoding="utf-8")
PY

printf '==> Building the copy (swift build -c release)\n'
cd "$SRC"
export CLANG_MODULE_CACHE_PATH="$LEGACY/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$LEGACY/module-cache"
swift build -c release --product Qnet >"$LEGACY/build.log" 2>&1 \
    || { grep -E "error:" "$LEGACY/build.log" | head -30 >&2; die "the copy did not build (log: $LEGACY/build.log)"; }
BIN="$(swift build -c release --product Qnet --show-bin-path)/Qnet"
[ "$("$BIN" --version)" = "Qnet 0.90.34" ] || die "the copy is not Qnet 0.90.34"

export QNET_SOLVER_ROOT="$SOLVER_ROOT"
run_one() {
    local example="$1" stem home dir
    stem="$(basename "$example")"; stem="${stem%.bnet}"
    home="$LEGACY/home-$stem"
    dir="$OUT/$stem"
    rm -rf "$home" "$dir"; mkdir -p "$home" "$dir"
    # Each example in its own temporary folder: the wrappers' pid-stamped inputs must not collide
    # between parallel examples, and nothing a run leaves behind is mistaken for the next one's.
    mkdir -p "$home/tmp"
    # Solver outputs each run left in the temporary folder are kept here (outside the repository).
    rm -rf "$LEGACY/tmp/$stem"
    if GOLDEN_KEEP_TMP="$LEGACY/tmp/$stem" CFFIXED_USER_HOME="$home" TMPDIR="$home/tmp/" "$BIN" --golden-runs "$example" "$dir" \
        >"$LEGACY/log-$stem.txt" 2>&1; then
        printf '  %s\n' "$stem"
    else
        printf '  %s FAILED (log: %s)\n' "$stem" "$LEGACY/log-$stem.txt"
    fi
    rm -rf "$home"
}
export -f run_one
export LEGACY OUT BIN

mkdir -p "$OUT"
if [ "$TESTSETS_ONLY" = 0 ]; then
    printf '==> Running every Run-menu method on each example (%s at a time)\n' "$JOBS"
    if [ ${#STEMS[@]} -gt 0 ]; then
        for s in "${STEMS[@]}"; do printf '%s\n' "$ROOT/examples/$s.bnet"; done
    else
        ls "$ROOT"/examples/*.bnet
    fi | xargs -P "$JOBS" -I{} bash -c 'run_one "$@"' _ {}
fi

if [ ${#STEMS[@]} -eq 0 ]; then
    printf '==> Test sets and spectral convergence\n'
    home="$LEGACY/home-testsets"
    rm -rf "$home" "$OUT/_testsets"; mkdir -p "$home/tmp" "$OUT/_testsets"
    rm -rf "$LEGACY/tmp/_testsets"
    GOLDEN_KEEP_TMP="$LEGACY/tmp/_testsets" CFFIXED_USER_HOME="$home" TMPDIR="$home/tmp/" "$BIN" --golden-testsets "$OUT/_testsets" \
        >"$LEGACY/log-testsets.txt" 2>&1 || printf '  test sets FAILED (log: %s)\n' "$LEGACY/log-testsets.txt"
    rm -rf "$home"
fi

# The corpus is published with the source: this Mac's home folder is written as /Users/nobody
# (plain and JSON-escaped), before the hashes below are taken. The tests put the real one back
# where they compare a path (the runner's and the CLI's golden helpers).
find "$OUT" -type f ! -name PROVENANCE.json -print0 | HOME_RE="$HOME" xargs -0 perl -pi -e 'BEGIN { $h = $ENV{HOME_RE}; ($e = $h) =~ s{/}{\\/}g; } s{\Q$h\E}{/Users/nobody}g; s{\Q$e\E}{\\/Users\\/nobody}g'

python3 - "$OUT" "$full_commit" <<'PY'
import hashlib, json, pathlib, sys, datetime
out, commit = pathlib.Path(sys.argv[1]), sys.argv[2]
files = {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest()
         for p in sorted(out.rglob("*")) if p.is_file() and p.name != "PROVENANCE.json"}
(out / "PROVENANCE.json").write_text(json.dumps({
    "source": "2_QNET " + commit + " (Qnet 0.90.34), extracted with git archive",
    "copy_changes": "golden/tools/GoldenDump.swift and GoldenRuns.swift appended to QnetGUIApp.swift; "
                    "the five GoldenRunHook edits listed in GoldenRuns.swift",
    "solvers": "scripts/stage-solvers.sh's staged tree, through QNET_SOLVER_ROOT",
    "settings": "AppSettings defaults, except fixed seeds, sim.replications 8, sim.warmup 10000, "
                "sim.time 200000, sim.parallel 2 (sequential), runCompare.remember true",
    "home": "The recording Mac's home folder is written as /Users/nobody throughout.",
    "written": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "files": files,
}, indent=2, sort_keys=True) + "\n")
print(f"==> {len(files)} files under {out}")
PY
