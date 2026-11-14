#!/usr/bin/env bash
# Writes the golden corpus (golden/<example>/…): what Qnet 0.90.34 produces for each of the 50
# shipped examples, so the Rust port can be checked against it byte for byte (PLAN.md §5).
#
# It never builds in or writes to 2_QNET. It extracts one commit of it with `git archive` into
# ~/Library/Caches/qnet/legacy-0.90.34/src, adds golden/tools/GoldenDump.swift to that copy (and
# one call at the end of QnetGUIApp.init), builds the copy with SwiftPM, and runs it headless:
#
#   Qnet --golden <bnet> <dir>        re-saved document, every exporter, Analyze and Primitives
#   Qnet --dump-rho <bnet>            traffic equations, utilisation, SRBM existence, tractability
#   Qnet --export-cmp <bnet> <dir>    File › Export › All Solver Inputs to Folder
#   Qnet --golden-generators <dir>    every archetype and a spread of seeded random networks,
#                                     into golden/generators/
#
# Each run gets a scratch CFFIXED_USER_HOME, so the old app's start-up (a defaults migration, the
# tab-restore read) touches neither your preferences nor its own Application Support folder.
#
# Usage: scripts/make-golden.sh [--generators-only] [commit]     (default dc066f0, Qnet 0.90.34)
#
# --generators-only rebuilds the copy but writes only golden/generators/, leaving the per-example
# folders as they are (a full run rewrites the `# Generated:` timestamp line in 100 of their files).
# golden/runs/ is scripts/make-golden-runs.sh's, with its own provenance; this script leaves it alone.
# PROVENANCE.json is rewritten over every file either way.
set -euo pipefail

GENERATORS_ONLY=0
COMMIT=dc066f0
for arg in "$@"; do
    case "$arg" in
        --generators-only) GENERATORS_ONLY=1 ;;
        -*) printf 'ERROR: unknown option %s\n' "$arg" >&2; exit 2 ;;
        *) COMMIT="$arg" ;;
    esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
QNET090="$(cd "$ROOT/../../2_QNET" && pwd -P)"
LEGACY="$HOME/Library/Caches/qnet/legacy-0.90.34"
SRC="$LEGACY/src"
SCRATCH_HOME="$LEGACY/home"
OUT="$ROOT/golden"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

full_commit="$(git -C "$QNET090" rev-parse --verify "$COMMIT^{commit}")" || die "no commit $COMMIT in $QNET090"
printf '==> Extracting %s of %s into %s\n' "$full_commit" "$QNET090" "$SRC"
rm -rf "$SRC"
mkdir -p "$SRC"
git -C "$QNET090" archive "$full_commit" | tar -x -C "$SRC"

printf '==> Adding the golden dump to the copy\n'
APP="$SRC/Sources/Qnet/QnetGUIApp.swift"
python3 - "$APP" "$ROOT/golden/tools/GoldenDump.swift" <<'PY'
import sys
app, dump = sys.argv[1], sys.argv[2]
text = open(app, encoding="utf-8").read()
anchor = "            _activeTabID = State(initialValue: activeID ?? restoredTabs[0].id)\n        }\n    }\n"
if text.count(anchor) != 1:
    raise SystemExit("QnetGUIApp.init's end was not found exactly once; the dump can't be added")
text = text.replace(anchor, anchor[: -len("    }\n")] + "        runGoldenDumpIfRequested()\n    }\n")
text += "\n" + open(dump, encoding="utf-8").read()
open(app, "w", encoding="utf-8").write(text)
PY

# SwiftTerm compiles one Metal shader for its GPU renderer, and Xcode 27 ships without its Metal
# toolchain (`xcodebuild -downloadComponent MetalToolchain` installs it). Without that toolchain the
# copy leaves the shader out: the dump never draws a terminal, and SwiftTerm only looks the shader
# up at run time, so the Swift code that writes the corpus compiles unchanged either way.
COPY_CHANGES="QnetGUIApp.swift: GoldenDump.swift appended, and one call (runGoldenDumpIfRequested) at the end of QnetGUIApp.init"
if xcrun metal --version >/dev/null 2>&1; then
    printf '  the Metal toolchain is installed; SwiftTerm builds unchanged\n'
else
    printf '  no Metal toolchain: leaving SwiftTerm'"'"'s shader out of the copy\n'
    COPY_CHANGES="$COPY_CHANGES
Vendor/SwiftTerm/Package.swift: Apple/Metal/Shaders.metal excluded (no Metal toolchain installed; the shader is a run-time resource of the terminal's GPU renderer, which the dump never uses)"
TERM_PKG="$SRC/Vendor/SwiftTerm/Package.swift"
python3 - "$TERM_PKG" <<'PY'
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
if ! swift build -c release --product Qnet >"$LEGACY/build.log" 2>&1; then
    # 2_QNET's run_qnet.sh fallback, when that SDK is installed: one that matches the compiler.
    [ -d "$FALLBACK_SDK" ] || { tail -30 "$LEGACY/build.log" >&2; die "the 0.90.34 copy did not build (log: $LEGACY/build.log)"; }
    printf '  first build failed; retrying with %s\n' "$FALLBACK_SDK"
    SDKROOT="$FALLBACK_SDK" swift build -c release --product Qnet >"$LEGACY/build.log" 2>&1 \
        || { tail -30 "$LEGACY/build.log" >&2; die "the 0.90.34 copy did not build (log: $LEGACY/build.log)"; }
fi
BIN="$(swift build -c release --product Qnet --show-bin-path)/Qnet"
[ -x "$BIN" ] || die "no Qnet binary at $BIN"
version="$("$BIN" --version)"
[ "$version" = "Qnet 0.90.34" ] || die "the copy says “$version”, not Qnet 0.90.34"

# The generator networks as they are now, before anything below removes the folder.
PREVIOUS_GENERATORS="$LEGACY/previous-generators"
rm -rf "$PREVIOUS_GENERATORS"
[ -d "$OUT/generators" ] && cp -R "$OUT/generators" "$PREVIOUS_GENERATORS"
if [ "$GENERATORS_ONLY" = 0 ]; then
printf '==> Writing the corpus into %s\n' "$OUT"
# Keep the corpus as it was, to restore files whose only change is their timestamp line below.
PREVIOUS="$LEGACY/previous-corpus"
rm -rf "$PREVIOUS"; mkdir -p "$PREVIOUS"
find "$OUT" -mindepth 1 -maxdepth 1 -type d ! -name tools ! -name generators ! -name runs -exec cp -R {} "$PREVIOUS/" \;
find "$OUT" -mindepth 1 -maxdepth 1 -type d ! -name tools ! -name runs ! -name canvas ! -name edits -exec rm -rf {} +
for example in "$ROOT"/examples/*.bnet; do
    base="$(basename "$example")"
    stem="${base%.bnet}"
    dir="$OUT/$stem"
    mkdir -p "$dir"
    rm -rf "$SCRATCH_HOME"; mkdir -p "$SCRATCH_HOME"
    CFFIXED_USER_HOME="$SCRATCH_HOME" "$BIN" --golden "$example" "$dir" >/dev/null
    CFFIXED_USER_HOME="$SCRATCH_HOME" "$BIN" --dump-rho "$example" >"$dir/dump-rho.txt"
    CFFIXED_USER_HOME="$SCRATCH_HOME" "$BIN" --export-cmp "$example" "$dir/export-all" >/dev/null
    # Run Comparison's loss and BAS corrections change the finite-buffer SRBM inputs only.
    if ! grep -q '"infiniteBuffers"[[:space:]]*:[[:space:]]*true' "$example"; then
        CFFIXED_USER_HOME="$SCRATCH_HOME" "$BIN" --export-cmp "$example" "$dir/export-all-loss" --loss-fix >/dev/null
        CFFIXED_USER_HOME="$SCRATCH_HOME" "$BIN" --export-cmp "$example" "$dir/export-all-bas" --bas-fix >/dev/null
    fi
done
# The fBNAsim files carry a "# Generated: <time>" line. Where that line is all that changed, the
# earlier file is put back, so regenerating the corpus doesn't rewrite a hundred files for nothing.
python3 - "$OUT" "$PREVIOUS" <<'PY'
import pathlib, sys
out, prev = map(pathlib.Path, sys.argv[1:])
kept = 0
for new in out.rglob("*.txt"):
    old = prev / new.relative_to(out)
    if not old.is_file():
        continue
    strip = lambda p: [l for l in p.read_text().splitlines() if not l.startswith("# Generated:")]
    if new.read_bytes() != old.read_bytes() and strip(new) == strip(old):
        new.write_bytes(old.read_bytes())
        kept += 1
print(f"  kept the earlier timestamp in {kept} files that differed only there")
PY
rm -rf "$PREVIOUS"
fi

printf '==> Writing the generators into %s/generators\n' "$OUT"
rm -rf "$OUT/generators" "$SCRATCH_HOME"; mkdir -p "$SCRATCH_HOME"
CFFIXED_USER_HOME="$SCRATCH_HOME" "$BIN" --golden-generators "$OUT/generators" \
    || die "the generator dump failed"
rm -rf "$SCRATCH_HOME"
# 0.90.34 gives every generated node and link a fresh UUID, so each run rewrites every network
# though nothing else changed. Where the ids (numbered in order of first appearance) are the
# only difference, the earlier file is put back; tests/golden_generators.rs maps ids the same way.
if [ -d "$PREVIOUS_GENERATORS" ]; then
python3 - "$OUT/generators" "$PREVIOUS_GENERATORS" <<'PY'
import pathlib, re, sys
new_dir, old_dir = map(pathlib.Path, sys.argv[1:])
uuid = re.compile(r"[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}")
def norm(text):
    ids = {}
    return uuid.sub(lambda m: ids.setdefault(m.group(0), f"ID{len(ids)}"), text)
kept = 0
for new in new_dir.glob("*.bnet"):
    old = old_dir / new.name
    if old.is_file() and new.read_bytes() != old.read_bytes() and norm(new.read_text()) == norm(old.read_text()):
        new.write_bytes(old.read_bytes())
        kept += 1
print(f"  kept the earlier ids in {kept} generator networks that differed only there")
PY
rm -rf "$PREVIOUS_GENERATORS"
fi
# The examples on record: the per-example folders now in the corpus, however they were written.
count="$(find "$OUT" -mindepth 2 -maxdepth 2 -name resave.bnet | wc -l | tr -d ' ')"
generated="$(find "$OUT/generators" -type f | wc -l | tr -d ' ')"

printf '==> Recording provenance\n'
python3 - "$OUT" "$full_commit" "$version" "$(swift --version 2>&1 | head -1)" "$(sw_vers -productVersion)" "$count" "$COPY_CHANGES" "$generated" "$GENERATORS_ONLY" <<'PY'
import hashlib, json, pathlib, sys, datetime
out, commit, version, swift, macos, count, changes, generated, generators_only = sys.argv[1:]
files = []
for p in sorted(pathlib.Path(out).rglob("*")):
    if p.is_file() and p.relative_to(out).parts[0] not in ("tools", "runs", "canvas", "edits") and p.name not in ("PROVENANCE.json", "README.md"):
        files.append({"path": str(p.relative_to(out)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
record = {
    "made_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "source": "2_QNET",
    "commit": commit,
    "app_version": version,
    "swift": swift,
    "macos": macos,
    "examples": int(count),
    "generator_files": int(generated),
    "run": "--generators-only: golden/generators rewritten, the example folders kept from an earlier run" if generators_only == "1" else "full",
    "dump": "golden/tools/GoldenDump.swift, added to the extracted copy only",
    "copy_changes": changes.split("\n"),
    "files": files,
}
(pathlib.Path(out) / "PROVENANCE.json").write_text(json.dumps(record, indent=1) + "\n")
print(f"  {len(files)} files from {count} examples and the generators ({generated})")
PY
printf 'Done: %s\n' "$OUT"
