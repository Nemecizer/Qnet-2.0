#!/usr/bin/env bash
# Shows that the build toolchain refuses what it must refuse: each check below breaks one thing
# on purpose and passes only when the scripts stop with the right message.
#
#   scripts/toolchain-selftest.sh           run every check (about two and a half minutes)
#   scripts/toolchain-selftest.sh --keep    the same, and keep the scratch folder to look at
#
# Everything happens in one throwaway folder under $TMPDIR: copies of the four scripts (which the
# checks edit), of solvers/, of the libraries build-deps.sh made and of the Python downloads, and
# solver and Python stages built there from those copies. The real caches under
# ~/Library/Caches/qnet are only read (copied from); nothing is downloaded (curl is replaced by a
# program that fails) and nothing in the repository is written.
#
# It needs what a build needs: scripts/build-deps.sh and scripts/stage-python.sh must have run
# once on this Mac (for the libraries and the three downloaded archives), and zstd must be on PATH.
#
#   1  stage-python.sh    a stage is stamped with its pins and recipe; a run that fails midway
#                         (download, tar, verification) leaves the old stage, and
#                         assemble-bundle.sh refuses it; a stage with no stamp is refused
#   2  stage-solvers.sh   a changed compiler flag changes the stamp, is refused by
#                         assemble-bundle.sh, and makes the next run recompile
#   3  relocate           a failing cp or install_name_tool stops the script, also in the recursion
#   4  the launcher       starts from a path with spaces, through symbolic links, through PATH and
#                         with no folder in $0; tar's own error is shown, the zstd hint only when
#                         there is no zstd
#   5  the build machine  /opt/homebrew or /usr/local in a load command of a Python runtime binary
#                         fails the bundle and the stage check; in a data file it is reported
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REAL_DEPS="${QNET_DEPS_DIR:-$HOME/Library/Caches/qnet/deps}"
REAL_PYTHON="${QNET_PYTHON_CACHE:-$HOME/Library/Caches/qnet/python}"
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1
STARTED=$SECONDS

T="$(mktemp -d "${TMPDIR:-/tmp}/qnet-toolchain-selftest.XXXXXX")" || exit 1
T="$(cd "$T" && pwd -P)"
finish() { if [ "$KEEP" -eq 1 ]; then printf 'Kept: %s\n' "$T"; else rm -rf "$T"; fi; }
trap finish EXIT

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '  ok    %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$1"; if [ -n "${2:-}" ] && [ -f "$2" ]; then tail -15 "$2" | sed 's/^/        | /'; fi; }
section() { printf '\n%s\n' "$*"; }
abort() { printf 'CANNOT RUN: %s\n' "$*" >&2; exit 2; }
LOGN=0
# run <command…>: runs it with output in a new log file, named in $LOG; status in $RC.
run() { LOGN=$((LOGN + 1)); LOG="$T/logs/$LOGN.log"; "$@" >"$LOG" 2>&1; RC=$?; }
# refused "<what>" "<text the refusal must contain>": the last run must have failed, saying that.
refused() {
    if [ "$RC" -eq 0 ]; then fail "$1 (it succeeded)" "$LOG"
    elif ! grep -q -F -e "$2" "$LOG"; then fail "$1 (it failed, but without saying: $2)" "$LOG"
    else pass "$1"; fi
}
succeeded() { if [ "$RC" -eq 0 ]; then pass "$1"; else fail "$1 (exit $RC)" "$LOG"; fi; }
says() { if grep -q -F -e "$2" "$LOG"; then pass "$1"; else fail "$1 (missing: $2)" "$LOG"; fi; }
says_not() { if grep -q -F -e "$2" "$LOG"; then fail "$1 (it said: $2)" "$LOG"; else pass "$1"; fi; }
check() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi; }

# ── The scratch copy ────────────────────────────────────────────────────────────────────────
[ -f "$REAL_DEPS/prefix/.built-by" ] && [ -f "$REAL_DEPS/manifest.json" ] || abort "no solver libraries in $REAL_DEPS: run scripts/build-deps.sh once"
[ "$(cat "$REAL_DEPS/prefix/.built-by")" = "$(shasum -a 256 "$REPO/scripts/build-deps.sh" | cut -d' ' -f1)" ] \
    || abort "the solver libraries in $REAL_DEPS are older than scripts/build-deps.sh: run it once"
[ -d "$REAL_PYTHON/downloads" ] || abort "no Python downloads in $REAL_PYTHON: run scripts/stage-python.sh once"
ZSTD_DIR="$(dirname "$(command -v zstd || echo /nowhere/zstd)")"
[ -x "$ZSTD_DIR/zstd" ] || abort "zstd is not on PATH (tar needs it to open the CPython archive)"

R="$T/repo"   # the copy of the repository the scripts run from
mkdir -p "$R/scripts" "$R/validation" "$T/logs" "$T/stubs" "$T/pristine" "$T/deps" "$T/python" "$T/solvers"
PRISTINE_SCRIPTS=(stage-solvers.sh stage-python.sh build-deps.sh assemble-bundle.sh)
fresh_scripts() { local s; for s in "${PRISTINE_SCRIPTS[@]}"; do cp "$REPO/scripts/$s" "$R/scripts/$s"; done; }
fresh_scripts
cp -R "$REPO/solvers" "$REPO/examples" "$REPO/python" "$REPO/ThirdPartyLicenses" "$REPO/LICENSE" "$R/"
cp "$REPO/validation/required_release_executables.txt" "$R/validation/"
mkdir -p "$R/docs" && cp "$REPO/docs/CLI.md" "$R/docs/"
# -c: a clone where the disk can make one (APFS), so these cost no time and no space.
cp -Rc "$REAL_DEPS/prefix" "$REAL_DEPS/manifest.json" "$T/deps/"
cp -Rc "$REAL_PYTHON/downloads" "$T/python/downloads"

# Programs that stand in for the real ones. curl always fails: nothing is ever downloaded. node
# always succeeds: the version and notices checks at the ends of assemble-bundle.sh are about the
# real repository and are not what is tested here.
printf '#!/bin/sh\necho "curl: SELFTEST no network here" >&2\nexit 22\n' > "$T/stubs/curl"
printf '#!/bin/sh\nexit 0\n' > "$T/stubs/node"
chmod 755 "$T/stubs/curl" "$T/stubs/node"

export QNET_DEPS_DIR="$T/deps" QNET_SOLVER_CACHE="$T/solvers" QNET_PYTHON_CACHE="$T/python"
export QNET_SOLVER_STAGE="$T/solvers/stage" QNET_PYTHON_STAGE="$T/python/stage"
unset QNET_SKIP_STAGE_STAMP QNET_NUMPY_BLAS
SYSTEM_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
export PATH="$T/stubs:$ZSTD_DIR:$SYSTEM_PATH"

# A stand-in Qnet.app: two small programs and an Info.plist, enough for assemble-bundle.sh.
mkdir -p "$T/app-template/Qnet.app/Contents/MacOS" "$T/app-src"
printf 'int main(void) { return 0; }\n' > "$T/app-src/main.c"
for name in qnet qnet-cli; do
    /usr/bin/clang -mmacosx-version-min=14.0 -o "$T/app-template/Qnet.app/Contents/MacOS/$name" "$T/app-src/main.c" || abort "clang could not build the stand-in app"
done
cat > "$T/app-template/Qnet.app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>qnet</string>
<key>CFBundleIdentifier</key><string>org.qnet.selftest</string>
<key>CFBundleName</key><string>Qnet</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.0</string>
<key>CFBundleVersion</key><string>0</string>
</dict></plist>
PLIST
APP="$T/app/Qnet.app"
assemble() { rm -rf "$T/app"; mkdir -p "$T/app"; cp -R "$T/app-template/Qnet.app" "$APP"; run "$R/scripts/assemble-bundle.sh" "$APP"; }
# The identity of a stage: its stamp and the bytes of what it stages, by name.
fingerprint() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1); }

# ── Stages to start from ────────────────────────────────────────────────────────────────────
section "Building a solver stage and a Python stage in $T"
run "$R/scripts/stage-solvers.sh"
[ "$RC" -eq 0 ] || { fail "stage-solvers.sh builds a stage from the copy" "$LOG"; abort "nothing else can be tested without a solver stage"; }
pass "stage-solvers.sh builds a stage from the copy"
run "$R/scripts/stage-python.sh"
[ "$RC" -eq 0 ] || { fail "stage-python.sh builds a stage from the copy, without downloading" "$LOG"; abort "nothing else can be tested without a Python stage"; }
pass "stage-python.sh builds a stage from the copy, without downloading"
cp -Rc "$T/solvers/stage" "$T/pristine/solver-stage"
cp -Rc "$T/python/stage" "$T/pristine/python-stage"
PYSTAGE_PRINT="$(fingerprint "$T/python/stage")"
fresh_python_stage() { rm -rf "$T/python/stage"; cp -Rc "$T/pristine/python-stage" "$T/python/stage"; }
fresh_solver_stage() { rm -rf "$T/solvers/stage"; cp -Rc "$T/pristine/solver-stage" "$T/solvers/stage"; }
# The stage is as it was, and no half-made stage or work folder is left beside it.
python_stage_untouched() {
    [ "$(fingerprint "$T/python/stage")" = "$PYSTAGE_PRINT" ] && [ -z "$(find "$T/python" -maxdepth 1 \( -name 'stage.*' -o -name work \))" ]
}

assemble
succeeded "control: assemble-bundle.sh accepts the two fresh stages and assembles a bundle"
says "control: the bundle check read the Python runtime's binaries" "of them in the Python runtime"

# ── 1. A stale Python runtime ───────────────────────────────────────────────────────────────
section "1. stage-python.sh: stamp, and a run that fails midway"
check "the stage carries the stamp --stamp prints" test "$(cat "$T/python/stage/STAGE_STAMP")" = "$("$R/scripts/stage-python.sh" --stamp)"
run "$R/scripts/stage-python.sh"
says "a second run does nothing" "is up to date"

# 1a. A pin is bumped and the download fails.
sed -i '' 's/^PY_SHA256=7e/PY_SHA256=00/' "$R/scripts/stage-python.sh"
check "bumping a sha256 pin changes --stamp" test "$(cat "$T/python/stage/STAGE_STAMP")" != "$("$R/scripts/stage-python.sh" --stamp)"
run "$R/scripts/stage-python.sh"
refused "pin bumped, download fails: stage-python.sh fails" "could not download"
check "…and the old stage is left exactly as it was" python_stage_untouched
assemble
refused "…and assemble-bundle.sh refuses that old stage" "the staged Python runtime is not the one scripts/stage-python.sh makes now"
fresh_scripts

# 1b. The recipe changes and tar fails on the .tar.zst (also 4: tar's own words are shown).
mkdir -p "$T/stubs-tar"
cat > "$T/stubs-tar/tar" <<'STUB'
#!/bin/sh
for a in "$@"; do case "$a" in *.tar.zst) echo "tar: SELFTEST-REAL-ERROR no space left on device" >&2; exit 1 ;; esac; done
exec /usr/bin/tar "$@"
STUB
chmod 755 "$T/stubs-tar/tar"
printf '\n# selftest: a changed recipe\n' >> "$R/scripts/stage-python.sh"
PATH="$T/stubs-tar:$PATH" run "$R/scripts/stage-python.sh"
refused "recipe changed, tar fails: stage-python.sh fails" "could not read"
says "4: tar's own error is shown" "SELFTEST-REAL-ERROR no space left on device"
says_not "4: no zstd hint when zstd is on PATH" "no zstd program"
check "…and the old stage is left exactly as it was" python_stage_untouched
assemble
refused "…and assemble-bundle.sh refuses that old stage" "the staged Python runtime is not the one scripts/stage-python.sh makes now"
# The same with the real tar and no zstd anywhere on PATH.
PATH="$T/stubs:$SYSTEM_PATH" run "$R/scripts/stage-python.sh"
if [ "$RC" -eq 0 ]; then
    pass "4: (this Mac's tar opens .tar.zst without a zstd program: the hint cannot arise)"
    fresh_python_stage
else
    refused "4: without zstd on PATH the real tar fails, and the hint is added" "There is no zstd program on PATH"
    check "…and the old stage is left exactly as it was" python_stage_untouched
fi
fresh_scripts

# 1c. Verification fails after the runtime was assembled.
sed -i '' 's/^MAX_MINOS=14.0$/MAX_MINOS=10.0/' "$R/scripts/stage-python.sh"
run "$R/scripts/stage-python.sh"
refused "verification fails (no binary may need macOS above 10.0): stage-python.sh fails" "problem(s) in the runtime's binaries"
check "…and the old stage is left exactly as it was, with no half-made stage beside it" python_stage_untouched
assemble
refused "…and assemble-bundle.sh refuses that old stage" "the staged Python runtime is not the one scripts/stage-python.sh makes now"
fresh_scripts

# 1d. A stage with no stamp (made by an older script).
rm "$T/python/stage/STAGE_STAMP"
assemble
refused "a Python stage with no stamp is refused" "has no STAGE_STAMP"
run "$R/scripts/stage-python.sh" --check
refused "…by stage-python.sh --check too" "was not made by this scripts/stage-python.sh"
fresh_python_stage

# ── 4. The launcher ─────────────────────────────────────────────────────────────────────────
section "4. The Python launcher finds its interpreter however it is started"
SP="$T/a folder with spaces"
mkdir -p "$SP/links/one" "$SP/links/two" "$SP/elsewhere"
cp -Rc "$T/python/stage/Resources/python" "$SP/python runtime"
RT="$SP/python runtime"
WANT="$RT/bin/python3.15"
PROBE='import sys, os, numpy; print(os.path.realpath(sys.executable))'
ln -s "$RT/bin/python3" "$SP/links/one/python3"            # an absolute link
ln -s "../one/python3" "$SP/links/two/py"                  # a relative link to a link
# The launcher as it was before: its folder is whatever precedes the last slash of $0.
cat > "$RT/bin/python3-old" <<'OLD'
#!/bin/sh
case "$0" in */*) here="${0%/*}" ;; *) here=. ;; esac
exec "$here/python3.15" -E -s -B "$@"
OLD
chmod 755 "$RT/bin/python3-old"
ln -s "$RT/bin/python3-old" "$SP/links/one/python3-old"
# starts "<what>" <command…>: must print the interpreter's real path. From /, with an empty environment.
starts() { local what="$1" got; shift; got="$(cd "$SP/elsewhere" && "$@" 2>&1)"; if [ "$got" = "$WANT" ]; then pass "$what"; else fail "$what (got: $(printf '%s' "$got" | head -2 | tr '\n' ' '))"; fi; }
fails_to_start() { local what="$1" got; shift; got="$(cd "$SP/elsewhere" && "$@" 2>&1)"; if [ "$got" = "$WANT" ]; then fail "$what (it started)"; else pass "$what"; fi; }
starts "by its path, in a folder with spaces, with an empty environment" env -i "$RT/bin/python3" -c "$PROBE"
starts "through an absolute symbolic link" env -i "$SP/links/one/python3" -c "$PROBE"
starts "through a relative link to a link" env -i "$SP/links/two/py" -c "$PROBE"
starts "by name through PATH" env -i PATH="$RT/bin" python3 -c "$PROBE"
starts "by name through PATH, where PATH holds a link to it" env -i PATH="$SP/links/two" py -c "$PROBE"
starts "with no folder in \$0, found along PATH (sh python3)" env -i PATH="/nonexistent:$RT/bin" /bin/sh python3 -c "$PROBE"
starts "with no folder in \$0, a link found along PATH (sh py)" env -i PATH="$SP/links/two" /bin/sh py -c "$PROBE"
got="$(cd "$RT/bin" && env -i /bin/sh python3 -c "$PROBE" 2>&1)"
if [ "$got" = "$WANT" ]; then pass "with no folder in \$0, in the current folder"; else fail "with no folder in \$0, in the current folder (got: $got)"; fi
starts "run by dash, a plain POSIX shell" env -i /bin/dash "$SP/links/two/py" -c "$PROBE"
got="$(cd "$SP/elsewhere" && env -i "$SP/links/two/py" -c 'import sys; print(sys.argv[1:])' 'two words' '' '*' 2>&1)"
if [ "$got" = "['two words', '', '*']" ]; then pass "arguments arrive unchanged"; else fail "arguments arrive unchanged (got: $got)"; fi
run env -i PATH=/nonexistent /bin/sh -c 'exec "$0" -c pass' "$RT/bin/python3"
succeeded "with a PATH that holds nothing"
fails_to_start "control: the launcher as it was does not start through a symbolic link" env -i "$SP/links/one/python3-old" -c "$PROBE"
fails_to_start "control: the launcher as it was does not start as sh python3-old along PATH" env -i PATH="/nonexistent:$RT/bin" /bin/sh python3-old -c "$PROBE"

# ── 2. A changed solver compile flag ────────────────────────────────────────────────────────
section "2. stage-solvers.sh: a changed compiler flag"
check "the stage carries the stamp --stamp prints" test "$(cat "$T/solvers/stage/TOOLCHAIN_STAMP")" = "$("$R/scripts/stage-solvers.sh" --stamp)"
run "$R/scripts/stage-solvers.sh" --stamp
says "the stamp names the compiler" "compiler Apple clang"
if grep -q -E '^sdk [0-9]' "$LOG"; then pass "the stamp names the SDK version"; else fail "the stamp names the SDK version" "$LOG"; fi
says "the stamp holds the compiler command" "cc /usr/bin/clang -mmacosx-version-min="
says "the stamp holds each makefile's variables" "make infinite/BNAsm:bnet: [CC="
says "the stamp holds this script's hash" "recipe $(shasum -a 256 "$R/scripts/stage-solvers.sh" | cut -d' ' -f1)"
run "$R/scripts/stage-solvers.sh"
says "a second run does nothing" "are up to date"
BEFORE="$("$R/scripts/stage-solvers.sh" --stamp)"
# One make variable of one solver (bnet's optimisation level).
sed -i '' 's/"CFLAGS=-DANSI_C -DLINUX -O3 /"CFLAGS=-DANSI_C -DLINUX -O2 /' "$R/scripts/stage-solvers.sh"
CHANGED="$(diff <(printf '%s\n' "$BEFORE") <("$R/scripts/stage-solvers.sh" --stamp))"
if printf '%s\n' "$CHANGED" | grep -q '^> make infinite/BNAsm:bnet: .*-O2 '; then
    pass "a changed make variable (bnet -O3 to -O2) changes that solver's line of the stamp"
else fail "a changed make variable (bnet -O3 to -O2) changes that solver's line of the stamp"; fi
fresh_scripts
# The compiler command every solver gets.
sed -i '' 's/^SOLVER_CC="\/usr\/bin\/clang /SOLVER_CC="\/usr\/bin\/clang -DQNET_SELFTEST_FLAG=1 /' "$R/scripts/stage-solvers.sh"
check "a changed SOLVER_CC changes --stamp" test "$BEFORE" != "$("$R/scripts/stage-solvers.sh" --stamp)"
assemble
refused "assemble-bundle.sh refuses the stage built with the old flags" "the staged solvers were not built with the compiler, flags and libraries scripts/stage-solvers.sh uses now"
run "$R/scripts/stage-solvers.sh"
succeeded "stage-solvers.sh stages again with the new flag"
says "…after throwing the old objects away" "rebuilding the solvers from scratch"
if grep -q -e '-DQNET_SELFTEST_FLAG=1' "$T/solvers/make-infinite-BNAqna.log" && grep -q -e '-DQNET_SELFTEST_FLAG=1 .*-c' "$T/solvers/make-infinite-BNAsm.log"; then
    pass "…and make compiled the sources again, with the new flag"
else fail "…and make compiled the sources again, with the new flag" "$T/solvers/make-infinite-BNAqna.log"; fi
assemble
succeeded "assemble-bundle.sh accepts the stage built with the new flags"
# A stage with no toolchain stamp (made by an older script).
rm "$T/solvers/stage/TOOLCHAIN_STAMP"
assemble
refused "a solver stage with no toolchain stamp is refused" "has no TOOLCHAIN_STAMP"

# ── 3. relocate ─────────────────────────────────────────────────────────────────────────────
section "3. relocate: a failing step stops the script"
# 3a. In the script itself: install_name_tool -id fails once the stage is being assembled.
mkdir -p "$T/stubs-int"
cat > "$T/stubs-int/install_name_tool" <<'STUB'
#!/bin/sh
case "$1" in -id) echo "install_name_tool: SELFTEST refuses -id" >&2; exit 1 ;; esac
exec /usr/bin/install_name_tool "$@"
STUB
chmod 755 "$T/stubs-int/install_name_tool"
PATH="$T/stubs-int:$PATH" run "$R/scripts/stage-solvers.sh"
refused "stage-solvers.sh stops when install_name_tool -id fails" "could not set the install name of Frameworks/"
check "…and leaves no stage that carries a stamp" test ! -e "$T/solvers/stage/TOOLCHAIN_STAMP" -a ! -e "$T/solvers/stage/SOURCE_STAMP"
assemble
refused "…so assemble-bundle.sh refuses what is left" "run scripts/stage-solvers.sh"
if grep -n -E '&&[[:space:]]*relocate|\|\|[[:space:]]*relocate' "$REPO/scripts/stage-solvers.sh" >/dev/null; then
    fail "relocate is never called from an AND/OR list"
else pass "relocate is never called from an AND/OR list"; fi
fresh_scripts
fresh_solver_stage

# 3b. The function itself, taken out of the script with the loop that calls it, on a program that
# links one library which links another, each by an absolute install name and with an absolute
# search path: every step of relocate runs, the recursion too.
FX="$T/relocate"
awk '/^is_system_lib\(\) \{/{on=1} on{print} /^relocate\(\) \{/{inrel=1} on&&inrel&&/^done < <\(find "\$BIN" -type f -perm -u\+x\)$/{exit}' "$R/scripts/stage-solvers.sh" > "$T/relocate-functions.sh"
check "the function and its calling loop were found in the script" grep -q 'then relocate "\$f"; fi' "$T/relocate-functions.sh"
build_fixture() {
    rm -rf "$FX"; mkdir -p "$FX/deps/lib" "$FX/stage/Resources/bin/x" "$FX/stage/Frameworks" "$FX/src"
    printf 'int inner(void) { return 7; }\n' > "$FX/src/inner.c"
    printf 'int inner(void); int outer(void) { return inner(); }\n' > "$FX/src/outer.c"
    printf 'int outer(void); int main(void) { return outer() == 7 ? 0 : 1; }\n' > "$FX/src/prog.c"
    local cc="/usr/bin/clang -mmacosx-version-min=14.0 -Wl,-headerpad_max_install_names"
    $cc -dynamiclib -o "$FX/deps/lib/libinner.dylib" "$FX/src/inner.c" -install_name "$FX/deps/lib/libinner.dylib" \
    && $cc -dynamiclib -o "$FX/deps/lib/libouter.dylib" "$FX/src/outer.c" -install_name "$FX/deps/lib/libouter.dylib" -L"$FX/deps/lib" -linner \
    && $cc -o "$FX/stage/Resources/bin/x/prog" "$FX/src/prog.c" -L"$FX/deps/lib" -louter -Wl,-rpath,"$FX/deps/lib"
}
# relocate_with "<shell text defining what fails>" [functions file]: status in $RC, output in $LOG.
relocate_with() {
    build_fixture || abort "clang could not build the relocate fixture"
    cat > "$T/relocate-harness.sh" <<HARNESS
set -euo pipefail
STAGE="$FX/stage"; BIN="\$STAGE/Resources/bin"; FRAMEWORKS="\$STAGE/Frameworks"; DEPS_PREFIX="$FX/deps"
warn() { printf '  ! %s\n' "\$*" >&2; }
die()  { printf 'ERROR: %s\n' "\$*" >&2; exit 1; }
$1
source "${2:-$T/relocate-functions.sh}"
echo REACHED-THE-END
HARNESS
    run bash "$T/relocate-harness.sh"
}
# (The file that is loaded brings the script's own rpath_to_frameworks and find_library, which
# replace anything of those names defined before it; what is made to fail is a program.)
relocate_with ":"
if [ "$RC" -eq 0 ] && grep -q REACHED-THE-END "$LOG" && "$FX/stage/Resources/bin/x/prog" \
    && [ "$(otool -L "$FX/stage/Resources/bin/x/prog" | tail -n +2 | grep -c -F "$FX")" = 0 ] \
    && [ "$(otool -L "$FX/stage/Frameworks/libouter.dylib" | tail -n +2 | grep -c -F "$FX")" = 0 ] \
    && [ "$(otool -D "$FX/stage/Frameworks/libinner.dylib" | tail -1)" = "@rpath/libinner.dylib" ] \
    && ! otool -l "$FX/stage/Resources/bin/x/prog" | grep -q -F "path $FX"; then
    pass "control: with nothing failing, the program is relocated, runs from the stage, and names no build folder"
else fail "control: with nothing failing, the program is relocated and runs from the stage" "$LOG"; fi
stops() { # "<what>" "<message>": the harness must have died saying so, and not gone on
    if [ "$RC" -ne 0 ] && grep -q -F -e "$2" "$LOG" && ! grep -q REACHED-THE-END "$LOG"; then pass "$1"; else fail "$1" "$LOG"; fi
}
relocate_with 'install_name_tool() { case "$1" in -change) return 1 ;; esac; command install_name_tool "$@"; }'
stops "a failing install_name_tool -change stops it" "could not point Resources/bin/x/prog at @rpath/libouter.dylib"
relocate_with 'install_name_tool() { case "$1" in -id) return 1 ;; esac; command install_name_tool "$@"; }'
stops "a failing install_name_tool -id stops it" "could not set the install name of Frameworks/libouter.dylib"
relocate_with 'install_name_tool() { case "$1" in -delete_rpath) return 1 ;; esac; command install_name_tool "$@"; }'
stops "a failing install_name_tool -delete_rpath stops it" "could not remove the search path"
relocate_with 'cp() { return 1; }'
stops "a failing cp stops it" "could not copy"
relocate_with 'cp() { case "$*" in *libinner*) return 1 ;; esac; command cp "$@"; }'
stops "a failing cp in the recursion (the library's own library) stops it" "libinner.dylib into Frameworks/"
relocate_with 'install_name_tool() { case "$1 $2" in "-change '"$FX"'/deps/lib/libinner.dylib") return 1 ;; esac; command install_name_tool "$@"; }'
stops "a failing install_name_tool -change in the recursion stops it" "could not point Frameworks/libouter.dylib at @rpath/libinner.dylib"
relocate_with 'rm "$DEPS_PREFIX/lib/libinner.dylib"'
stops "a library that build-deps.sh did not build stops it" "is not one of the libraries scripts/build-deps.sh builds"
# The same failure against the function and the call as they were. bash does apply `set -e` to
# the last command of an AND list, so the old form stopped as well, but without a word: the
# tool's message went to /dev/null and nothing else was printed. What the change adds is the
# message, and not depending on where `set -e` happens to reach.
cat > "$T/relocate-old.sh" <<'OLD'
is_system_lib() { case "$1" in /usr/lib/*|/System/*|/Library/Apple/*) return 0 ;; esac; return 1; }
find_library() { if [ -f "$DEPS_PREFIX/lib/$1" ]; then printf '%s' "$DEPS_PREFIX/lib/$1"; return 0; fi; return 1; }
relocate() {
    local target="$1" line lib base source
    install_name_tool -add_rpath "@loader_path/../../../Frameworks" "$target" 2>&1 | grep -v -E 'invalidate the code signature|would duplicate path' >&2 || true
    while IFS= read -r line; do
        lib="$(printf '%s\n' "$line" | awk '{print $1}')"
        [ -z "$lib" ] && continue
        is_system_lib "$lib" && continue
        base="$(basename "$lib")"
        [ "$lib" != "@rpath/$base" ] && install_name_tool -change "$lib" "@rpath/$base" "$target" 2>/dev/null
        [ -f "$FRAMEWORKS/$base" ] && continue
        source="$(find_library "$base")" || { warn "$base is not one of the libraries"; continue; }
        cp -f "$source" "$FRAMEWORKS/$base"
        chmod 644 "$FRAMEWORKS/$base"
        install_name_tool -id "@rpath/$base" "$FRAMEWORKS/$base" 2>/dev/null
        relocate "$FRAMEWORKS/$base"
    done < <(otool -L "$target" | tail -n +2)
}
while IFS= read -r f; do
    file -b "$f" | grep -q "Mach-O" && relocate "$f"
done < <(find "$BIN" -type f -perm -u+x)
OLD
relocate_with 'install_name_tool() { case "$1" in -id|-change) return 1 ;; esac; command install_name_tool "$@"; }' "$T/relocate-old.sh"
if [ "$RC" -ne 0 ] && [ ! -s "$LOG" ]; then pass "control: the function and call as they were stopped at the same failure, but said nothing"
else fail "control: the function and call as they were stopped at the same failure, but said nothing (exit $RC)" "$LOG"; fi

# ── 5. Nothing of the build machine ─────────────────────────────────────────────────────────
section "5. /opt/homebrew and /usr/local in the Python runtime"
PYRT="$T/python/stage/Resources/python"
resign() { codesign --force --sign - "$1" >/dev/null 2>&1; }
# An install name is the one load command the older checks leave out (they skip a file's own name).
fresh_python_stage
DYLIB="$(find "$PYRT/lib" -name 'libgfortran*.dylib' | head -1)"
[ -n "$DYLIB" ] || DYLIB="$(find "$PYRT/lib" -name '*.dylib' | head -1)"
SO="$(find "$PYRT/lib" -name '_multiarray_umath*.so' | head -1)"
if [ -z "$DYLIB" ] || [ -z "$SO" ]; then fail "the runtime has a .dylib and NumPy's .so to break"; else
    install_name_tool -id "/usr/local/lib/$(basename "$DYLIB")" "$DYLIB" 2>/dev/null && resign "$DYLIB"
    assemble
    refused "a .dylib whose install name is under /usr/local/ fails the bundle" "${DYLIB#"$PYRT"/} has a load command naming /opt/homebrew or /usr/local"
    run "$R/scripts/stage-python.sh" --check
    refused "…and stage-python.sh --check" "${DYLIB#"$PYRT"/} has a load command naming /opt/homebrew or /usr/local"
    fresh_python_stage
    install_name_tool -add_rpath /opt/homebrew/lib "$SO" 2>/dev/null && resign "$SO"
    assemble
    refused "a NumPy .so with a search path in /opt/homebrew fails the bundle" "${SO#"$PYRT"/} has a load command naming /opt/homebrew or /usr/local"
    run "$R/scripts/stage-python.sh" --check
    refused "…and stage-python.sh --check" "${SO#"$PYRT"/} has a load command naming /opt/homebrew or /usr/local"
    fresh_python_stage
    install_name_tool -add_rpath /opt/homebrew/lib "$PYRT/bin/python3.15" 2>/dev/null && resign "$PYRT/bin/python3.15"
    assemble
    refused "the interpreter with a search path in /opt/homebrew fails the bundle" "bin/python3.15 has a load command naming /opt/homebrew or /usr/local"
    fresh_python_stage
fi
# In a data file it is reported, and the bundle is still assembled.
printf "config = {'LDFLAGS': '-L/opt/homebrew/lib'}\n" > "$PYRT/lib/python3.15/_sysconfigdata_selftest.py"
assemble
succeeded "/opt/homebrew in a data file of the runtime does not fail the bundle"
says "…and is reported, with the file" "lib/python3.15/_sysconfigdata_selftest.py:1"
fresh_python_stage
assemble
says "with no mention there is nothing to report" "/opt/homebrew is mentioned in no file of the Python runtime"

# ── The real caches were only read ──────────────────────────────────────────────────────────
printf '\n%s passed, %s failed, in %s seconds.\n' "$PASSED" "$FAILED" "$((SECONDS - STARTED))"
[ "$FAILED" -eq 0 ]
