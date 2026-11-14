#!/usr/bin/env bash
# Writes golden/canvas/ and golden/edits/: what Qnet 0.90.34's canvas draws for each of the 50
# shipped examples, and what its editor model does with a set of scripted edit sequences, so the
# TypeScript canvas and editor (P5) can be checked against them field by field and byte by byte.
#
# Like make-golden.sh it never builds in or writes to 2_QNET. It extracts one commit with
# `git archive` into ~/Library/Caches/qnet/legacy-0.90.34-canvas/src, appends
# golden/tools/GoldenCanvas.swift to the copy's QnetGUIApp.swift with one call at the end of
# QnetGUIApp.init, drops `private` from NetworkNodeView's two label-row properties (detailText,
# rateText) so the dump can read them, builds the copy with SwiftPM and runs it headless:
#
#   Qnet --golden-canvas <bnet> <out.json>                    the scene, per example and per
#                                                             golden/tools/canvas-fixtures network
#   Qnet --golden-edits <scenario.json> <dir> <examples-dir>  one edit scenario
#
# Each run gets a scratch CFFIXED_USER_HOME and TMPDIR, so the old app's start-up (a defaults
# migration, the tab-restore read) and its parameter cache touch neither your preferences nor its
# own Application Support folder.
#
# Usage: scripts/make-golden-canvas.sh [--canvas-only | --edits-only] [scenario ...]
#
# Scenario names (golden/tools/edit-scenarios/<name>.json) limit the edit runs to those and skip
# the canvas runs. Each PROVENANCE.json is rewritten over every file in its folder either way.
set -euo pipefail

COMMIT=dc066f0
DO_CANVAS=1
DO_EDITS=1
NAMES=()
for arg in "$@"; do
    case "$arg" in
        --canvas-only) DO_EDITS=0 ;;
        --edits-only) DO_CANVAS=0 ;;
        -*) printf 'ERROR: unknown option %s\n' "$arg" >&2; exit 2 ;;
        *) NAMES+=("$arg"); DO_CANVAS=0 ;;
    esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
QNET090="$(cd "$ROOT/../../2_QNET" && pwd -P)"
LEGACY="$HOME/Library/Caches/qnet/legacy-0.90.34-canvas"
SRC="$LEGACY/src"
# SwiftPM's build folder is kept beside the copy (not inside it), so a re-run recompiles only the
# Qnet module rather than every dependency.
BUILD="$LEGACY/build"
SCRATCH_HOME="$LEGACY/home"
SCENARIOS="$ROOT/golden/tools/edit-scenarios"
OUT_CANVAS="$ROOT/golden/canvas"
OUT_EDITS="$ROOT/golden/edits"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

full_commit="$(git -C "$QNET090" rev-parse --verify "$COMMIT^{commit}")" || die "no commit $COMMIT in $QNET090"
printf '==> Extracting %s of %s into %s\n' "$full_commit" "$QNET090" "$SRC"
rm -rf "$SRC"
mkdir -p "$SRC"
git -C "$QNET090" archive "$full_commit" | tar -x -C "$SRC"

printf '==> Adding the canvas dump to the copy\n'
python3 - "$SRC/Sources/Qnet" "$ROOT/golden/tools/GoldenCanvas.swift" <<'PY'
import pathlib, sys
src, dump = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

def edit(path, before, after):
    text = path.read_text(encoding="utf-8")
    if text.count(before) != 1:
        raise SystemExit(f"{path.name}: anchor not found exactly once:\n{before}")
    path.write_text(text.replace(before, after), encoding="utf-8")

app = src / "QnetGUIApp.swift"
edit(app,
     "            _activeTabID = State(initialValue: activeID ?? restoredTabs[0].id)\n        }\n    }\n",
     "            _activeTabID = State(initialValue: activeID ?? restoredTabs[0].id)\n        }\n"
     "        runGoldenCanvasIfRequested()\n    }\n")
layers = src / "NetworkCanvasLayers.swift"
edit(layers, "    private var detailText: String? {\n", "    var detailText: String? {\n")
edit(layers, "    private var rateText: String? {\n", "    var rateText: String? {\n")
app.write_text(app.read_text(encoding="utf-8") + "\n" + dump.read_text(encoding="utf-8"), encoding="utf-8")
PY

COPY_CHANGES="QnetGUIApp.swift: GoldenCanvas.swift appended, and one call (runGoldenCanvasIfRequested) at the end of QnetGUIApp.init
NetworkCanvasLayers.swift: NetworkNodeView.detailText and .rateText made internal (were private), so the dump reads the label rows the node view draws"
# SwiftTerm's Metal shader: see make-golden.sh. Without Xcode's Metal toolchain it is left out.
if xcrun metal --version >/dev/null 2>&1; then
    printf '  the Metal toolchain is installed; SwiftTerm builds unchanged\n'
else
    printf '  no Metal toolchain: leaving SwiftTerm'"'"'s shader out of the copy\n'
    COPY_CHANGES="$COPY_CHANGES
Vendor/SwiftTerm/Package.swift: Apple/Metal/Shaders.metal excluded (no Metal toolchain installed; the shader is a run-time resource of the terminal's GPU renderer, which the dump never uses)"
    python3 - "$SRC/Vendor/SwiftTerm/Package.swift" <<'PY'
import sys
p = sys.argv[1]
text = open(p, encoding="utf-8").read()
before = 'exclude: ["Mac/README.md"],\n            resources: [\n                .process("Apple/Metal/Shaders.metal")\n            ]\n'
after = 'exclude: ["Mac/README.md", "Apple/Metal/Shaders.metal"]\n'
if text.count(before) != 1:
    raise SystemExit("SwiftTerm's manifest is not the one this script knows; the shader can't be left out")
open(p, "w", encoding="utf-8").write(text.replace(before, after))
PY
fi

printf '==> Building the copy (swift build -c release)\n'
cd "$SRC"
export CLANG_MODULE_CACHE_PATH="$LEGACY/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$LEGACY/module-cache"
FALLBACK_SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
started=$(date +%s)
if ! swift build -c release --product Qnet --scratch-path "$BUILD" >"$LEGACY/build.log" 2>&1; then
    [ -d "$FALLBACK_SDK" ] || { grep -E "error:" "$LEGACY/build.log" | head -30 >&2; die "the 0.90.34 copy did not build (log: $LEGACY/build.log)"; }
    printf '  first build failed; retrying with %s\n' "$FALLBACK_SDK"
    SDKROOT="$FALLBACK_SDK" swift build -c release --product Qnet --scratch-path "$BUILD" >"$LEGACY/build.log" 2>&1 \
        || { grep -E "error:" "$LEGACY/build.log" | head -30 >&2; die "the 0.90.34 copy did not build (log: $LEGACY/build.log)"; }
fi
printf '  built in %ss\n' "$(( $(date +%s) - started ))"
BIN="$(swift build -c release --product Qnet --scratch-path "$BUILD" --show-bin-path)/Qnet"
[ -x "$BIN" ] || die "no Qnet binary at $BIN"
version="$("$BIN" --version)"
[ "$version" = "Qnet 0.90.34" ] || die "the copy says “$version”, not Qnet 0.90.34"

fresh_home() {
    rm -rf "$SCRATCH_HOME"; mkdir -p "$SCRATCH_HOME/tmp"
}

if [ "$DO_CANVAS" = 1 ]; then
    printf '==> Writing the canvas scenes into %s\n' "$OUT_CANVAS"
    # Everything but the README is rewritten.
    mkdir -p "$OUT_CANVAS"
    find "$OUT_CANVAS" -mindepth 1 ! -name README.md -delete
    for example in "$ROOT"/examples/*.bnet; do
        base="$(basename "$example")"; stem="${base%.bnet}"
        fresh_home
        CFFIXED_USER_HOME="$SCRATCH_HOME" TMPDIR="$SCRATCH_HOME/tmp/" "$BIN" --golden-canvas "$example" "$OUT_CANVAS/$stem.json" >/dev/null \
            || die "the canvas dump failed on $base"
    done
    # Hand-made networks for what no shipped example has: self-loops on every kind, nested multi-class
    # loops, routing chips, a dangling link, opposite pairs, a dense grid and a solved (off-ladder) bow.
    mkdir -p "$OUT_CANVAS/fixtures"
    for fixture in "$ROOT"/golden/tools/canvas-fixtures/*.bnet; do
        base="$(basename "$fixture")"; stem="${base%.bnet}"
        fresh_home
        CFFIXED_USER_HOME="$SCRATCH_HOME" TMPDIR="$SCRATCH_HOME/tmp/" "$BIN" --golden-canvas "$fixture" "$OUT_CANVAS/fixtures/$stem.json" >/dev/null \
            || die "the canvas dump failed on $base"
    done
    printf '  %s scenes\n' "$(find "$OUT_CANVAS" -name '*.json' | wc -l | tr -d ' ')"
fi

if [ "$DO_EDITS" = 1 ]; then
    printf '==> Replaying the edit scenarios into %s\n' "$OUT_EDITS"
    mkdir -p "$OUT_EDITS"
    if [ ${#NAMES[@]} -gt 0 ]; then
        list=(); for n in "${NAMES[@]}"; do list+=("$SCENARIOS/$n.json"); done
    else
        list=("$SCENARIOS"/*.json)
        # A full run owns the folder: scenarios that no longer exist leave no output behind.
        find "$OUT_EDITS" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
    fi
    for scenario in "${list[@]}"; do
        [ -f "$scenario" ] || die "no scenario $scenario"
        name="$(basename "$scenario" .json)"
        rm -rf "$OUT_EDITS/$name" "$LEGACY/edits-out/$name"
        fresh_home
        # Written outside Dropbox first: the replay times its steps (nudge and inspector runs coalesce
        # by time), and a stalled write inside the synced folder must not change what it records.
        if ! CFFIXED_USER_HOME="$SCRATCH_HOME" TMPDIR="$SCRATCH_HOME/tmp/" "$BIN" --golden-edits "$scenario" "$LEGACY/edits-out/$name" "$ROOT/examples" \
            >"$LEGACY/log-$name.txt" 2>&1; then
            cat "$LEGACY/log-$name.txt" >&2
            die "scenario $name failed (log: $LEGACY/log-$name.txt)"
        fi
        cp -R "$LEGACY/edits-out/$name" "$OUT_EDITS/$name"
        printf '  %s (%s steps)\n' "$name" "$(( $(find "$OUT_EDITS/$name" -name 'step-*.json' | wc -l) - 1 ))"
    done
fi
rm -rf "$SCRATCH_HOME"

printf '==> Recording provenance\n'
record() {
    python3 - "$1" "$full_commit" "$version" "$(swift --version 2>&1 | head -1)" "$(sw_vers -productVersion)" "$COPY_CHANGES" "$2" <<'PY'
import hashlib, json, pathlib, sys, datetime
out, commit, version, swift, macos, changes, what = sys.argv[1:]
out = pathlib.Path(out)
files = [{"path": str(p.relative_to(out)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
         for p in sorted(out.rglob("*")) if p.is_file() and p.name not in ("PROVENANCE.json", "README.md")]
(out / "PROVENANCE.json").write_text(json.dumps({
    "made_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "source": "2_QNET",
    "commit": commit,
    "app_version": version,
    "swift": swift,
    "macos": macos,
    "made_by": "scripts/make-golden-canvas.sh",
    "dump": "golden/tools/GoldenCanvas.swift (" + what + "), added to the extracted copy only",
    "copy_changes": changes.split("\n"),
    "files": files,
}, indent=1) + "\n")
print(f"  {out.name}: {len(files)} files")
PY
}
[ -d "$OUT_CANVAS" ] && record "$OUT_CANVAS" "--golden-canvas"
[ -d "$OUT_EDITS" ] && record "$OUT_EDITS" "--golden-edits, scenarios in golden/tools/edit-scenarios"
printf 'Done.\n'
