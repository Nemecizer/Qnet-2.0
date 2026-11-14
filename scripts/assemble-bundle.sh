#!/usr/bin/env bash
# Makes a bare Qnet.app (as `tauri build` leaves it) into the whole application: the solvers, the
# libraries they load, the examples and the licences go in, the stated minimum macOS is made the
# real one, everything is signed in order, and the result is checked to stand on its own.
#
#   scripts/assemble-bundle.sh <path/to/Qnet.app> [signing identity]
#
# It follows 0.90.34's build_app.sh steps 3a-ter to 5 (ledger PKG-001…016):
#
#   Contents/MacOS/qnet-cli                      the command-line tool (put there by the caller)
#   Contents/Resources/bin/{finite,infinite}/…   the staged solvers, in the source tree's layout
#   Contents/Resources/solver-runtime-status-v1.tsv
#   Contents/Frameworks/*.dylib                  the libraries the solvers link (scripts/build-deps.sh)
#   Contents/Resources/python/                   Qnet's own Python and NumPy (scripts/stage-python.sh)
#   Contents/Resources/examples/*.bnet           the example networks (the count must match)
#   Contents/Resources/scripting/                the Python package `qnet` over qnet-cli (python/), source only
#   Contents/Resources/ThirdPartyLicenses/, THIRD-PARTY-NOTICES.md, LICENSE
#
# The solvers come from scripts/stage-solvers.sh's stage (~/Library/Caches/qnet/solvers/stage),
# which already mirrors Contents/, so every rpath is right as it stands. The stage must have been
# made from this checkout's solvers/ by this checkout's stage-solvers.sh, compiler and flags: its
# SOURCE_STAMP is compared with solvers/, and its TOOLCHAIN_STAMP with `stage-solvers.sh --stamp`.
# The Python stage's STAGE_STAMP is compared with `stage-python.sh --stamp` in the same way, so a
# runtime staged before a pin changed cannot be bundled.
#
# Signing order (PKG-014): extended attributes cleared, then each library, then each solver
# executable (text scripts are resources, not code), then the app. With no identity the signature
# is ad hoc. Nothing here launches Qnet.
#
# The Python runtime comes from scripts/stage-python.sh's stage (~/Library/Caches/qnet/python/stage),
# laid out as Contents/Resources/python. Its interpreter and NumPy's modules are signed with the
# solver executables; its scripts and bytecode are resources. Its libraries find each other
# through @loader_path, which the self-containment check follows to a file inside the bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
STAGE="${QNET_SOLVER_STAGE:-$HOME/Library/Caches/qnet/solvers/stage}"
PYSTAGE="${QNET_PYTHON_STAGE:-$HOME/Library/Caches/qnet/python/stage}"
log()  { printf '\n==> %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$#" -ge 1 ] || die "usage: scripts/assemble-bundle.sh <path/to/Qnet.app> [signing identity]"
APP="$(cd "$1" 2>/dev/null && pwd -P)" || die "no such bundle: $1"
IDENTITY="${2:--}"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
FRAMEWORKS="$CONTENTS/Frameworks"
[ -f "$CONTENTS/Info.plist" ] && [ -x "$CONTENTS/MacOS/qnet" ] || die "$APP is not a built Qnet.app"
# The command-line tool (0.90.34's `Qnet --dump-rho` and friends were flags of the app's own
# binary; 2.0's are `Contents/MacOS/qnet-cli`, ledger CLI-001). The caller builds it and puts it there.
[ -x "$CONTENTS/MacOS/qnet-cli" ] || die "no Contents/MacOS/qnet-cli: build it (cargo build --release -p qnet-cli) and copy it in first"
case "$APP" in "$ROOT"/*) die "assemble the bundle outside the repository (it lives in Dropbox)";; esac
[ -d "$STAGE/Resources/bin" ] && [ -d "$STAGE/Frameworks" ] || die "no staged solvers at $STAGE: run scripts/stage-solvers.sh"

[ -x "$PYSTAGE/Resources/python/bin/python3" ] || die "no staged Python runtime at $PYSTAGE: run scripts/stage-python.sh"
# The runtime must be the one the current stage-python.sh makes: same pins, same recipe. A stage
# with no stamp was made by an older script, or by nothing that finished.
PYSTAMP="$("$ROOT/scripts/stage-python.sh" --stamp)" || die "scripts/stage-python.sh --stamp failed"
[ -n "$PYSTAMP" ] || die "scripts/stage-python.sh --stamp printed nothing"
[ -f "$PYSTAGE/STAGE_STAMP" ] || die "the Python stage at $PYSTAGE has no STAGE_STAMP: run scripts/stage-python.sh"
if [ "$(cat "$PYSTAGE/STAGE_STAMP")" != "$PYSTAMP" ]; then
    # Shown so that what changed (a version, a checksum, the script) can be read off.
    diff <(cat "$PYSTAGE/STAGE_STAMP") <(printf '%s\n' "$PYSTAMP") | sed 's/^/  /' >&2 || true # diff exits 1 when they differ, which they do
    die "the staged Python runtime is not the one scripts/stage-python.sh makes now (stage '<', now '>'): run scripts/stage-python.sh"
fi

source_stamp() { (cd "$ROOT/solvers" && find . -type f ! -name '.DS_Store' -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1); }
if [ "${QNET_SKIP_STAGE_STAMP:-0}" != 1 ]; then
    [ -f "$STAGE/SOURCE_STAMP" ] || die "the stage has no SOURCE_STAMP: run scripts/stage-solvers.sh"
    [ "$(cat "$STAGE/SOURCE_STAMP")" = "$(source_stamp)" ] || die "the staged solvers were not built from this checkout's solvers/: run scripts/stage-solvers.sh"
    # …and with this compiler, SDK, flags, libraries' recipe and stage-solvers.sh.
    SOLVERSTAMP="$("$ROOT/scripts/stage-solvers.sh" --stamp)" || die "scripts/stage-solvers.sh --stamp failed"
    [ -n "$SOLVERSTAMP" ] || die "scripts/stage-solvers.sh --stamp printed nothing"
    [ -f "$STAGE/TOOLCHAIN_STAMP" ] || die "the stage has no TOOLCHAIN_STAMP: run scripts/stage-solvers.sh"
    if [ "$(cat "$STAGE/TOOLCHAIN_STAMP")" != "$SOLVERSTAMP" ]; then
        diff <(cat "$STAGE/TOOLCHAIN_STAMP") <(printf '%s\n' "$SOLVERSTAMP") | cut -c 1-300 | sed 's/^/  /' >&2 || true # diff exits 1 when they differ, which they do
        die "the staged solvers were not built with the compiler, flags and libraries scripts/stage-solvers.sh uses now (stage '<', now '>'): run scripts/stage-solvers.sh"
    fi
fi

log "Solvers, libraries and their status manifest"
rm -rf "$RESOURCES/bin" "$FRAMEWORKS" "$RESOURCES/examples" "$RESOURCES/ThirdPartyLicenses" "$RESOURCES/python" "$RESOURCES/scripting"
mkdir -p "$RESOURCES" "$FRAMEWORKS"
rsync -a --exclude '__pycache__' --exclude '.DS_Store' "$STAGE/Resources/bin" "$RESOURCES/"
cp "$STAGE/Resources/solver-runtime-status-v1.tsv" "$RESOURCES/"
rsync -a --exclude '.DS_Store' "$STAGE/Frameworks/" "$FRAMEWORKS/"
[ "$(head -1 "$RESOURCES/solver-runtime-status-v1.tsv")" = "QNET_SOLVER_RUNTIME_V1" ] || die "the status manifest is not QNET_SOLVER_RUNTIME_V1"

log "Python runtime"
# The bytecode stays (it is made by stage-python.sh without timestamps or paths, and nothing
# rewrites it): without it every solver start would compile the standard library again.
rsync -a --exclude '.DS_Store' "$PYSTAGE/Resources/python" "$RESOURCES/"
[ -x "$RESOURCES/python/bin/python3" ] || die "the Python runtime was not copied"
printf '  %s MB\n' "$(( $(du -sk "$RESOURCES/python" | cut -f1) / 1024 ))"

log "Example networks"
mkdir -p "$RESOURCES/examples"
cp "$ROOT"/examples/*.bnet "$RESOURCES/examples/"
# The closed-network examples (new in 2.1) are one folder down (src-tauri/src/welcome.rs).
mkdir -p "$RESOURCES/examples/closed"
cp "$ROOT"/examples/closed/*.bnet "$RESOURCES/examples/closed/"
# The examples of priorities, batch arrivals and rate profiles (new in 2.1), likewise.
mkdir -p "$RESOURCES/examples/extended"
cp "$ROOT"/examples/extended/*.bnet "$RESOURCES/examples/extended/"
have=$(find "$RESOURCES/examples" -name '*.bnet' | wc -l | tr -d ' ')
want=$(find "$ROOT/examples" -name '*.bnet' | wc -l | tr -d ' ')
[ "$have" = "$want" ] && [ "$have" -gt 0 ] || die "bundled $have examples, the source has $want"
printf '  %s examples\n' "$have"

log "Python package"
# The `qnet` package over qnet-cli (new in 2.1; python/README.md, Help ▸ Scripting with Python):
# plain source, no bytecode and no tests, so nothing in it is a binary to sign.
[ -f "$ROOT/python/qnet/__init__.py" ] && [ -f "$ROOT/python/pyproject.toml" ] && [ -f "$ROOT/docs/CLI.md" ] || die "no Python package at $ROOT/python, or no docs/CLI.md"
rsync -a --exclude '__pycache__' --exclude '.DS_Store' --exclude '*.egg-info' --exclude 'build' --exclude 'dist' --exclude 'tests' "$ROOT/python/" "$RESOURCES/scripting/"
# The JSON documents the package reads, described (docs/CLI.md), beside it.
cp "$ROOT/docs/CLI.md" "$RESOURCES/scripting/CLI.md"
[ -f "$RESOURCES/scripting/qnet/__init__.py" ] && [ -f "$RESOURCES/scripting/CLI.md" ] || die "the Python package was not copied"
printf '  %s files\n' "$(find "$RESOURCES/scripting" -type f | wc -l | tr -d ' ')"

log "Licences"
rsync -a --exclude '.DS_Store' "$ROOT/ThirdPartyLicenses" "$RESOURCES/"
cp "$ROOT/LICENSE" "$RESOURCES/LICENSE"
if [ -f "$ROOT/THIRD-PARTY-NOTICES.md" ]; then cp "$ROOT/THIRD-PARTY-NOTICES.md" "$RESOURCES/"; fi

# Every Mach-O file in the bundle, whatever its name or mode.
machos() {
    find "$CONTENTS" -type f ! -name '*.bnet' ! -name '*.py' ! -name '*.pyc' ! -name '*.txt' ! -name '*.md' -print0 | while IFS= read -r -d '' f; do
        if file -b "$f" | grep -q 'Mach-O'; then printf '%s\n' "$f"; fi
    done
}

log "Minimum macOS"
# The stated minimum is the highest any bundled binary was built for (PKG-009): the Homebrew
# libraries are built on the build machine, so in practice that is this Mac's macOS.
minimum=$(machos | while IFS= read -r f; do otool -l "$f" | awk '/LC_BUILD_VERSION/{b=1} b&&/minos/{print $2; b=0}'; done | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
[ -n "$minimum" ] || die "no bundled binary states a minimum macOS"
# The stated minimum is what the binaries need, floor 14.0 — whatever the plist said before (a
# re-assembled app would otherwise keep an older, higher figure).
highest=$(printf '%s\n14.0\n' "$minimum" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
/usr/libexec/PlistBuddy -c "Set :LSMinimumSystemVersion $highest" "$CONTENTS/Info.plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :LSMinimumSystemVersion string $highest" "$CONTENTS/Info.plist"
plutil -lint "$CONTENTS/Info.plist" >/dev/null || die "Info.plist is invalid"
printf '  LSMinimumSystemVersion %s\n' "$highest"

log "Signing: libraries, solver executables, app ($([ "$IDENTITY" = - ] && echo 'ad hoc' || echo "$IDENTITY"))"
xattr -cr "$APP"
# With an Apple identity everything keeps the hardened runtime the Tauri bundler signs with, and a
# Developer ID signature gets Apple's timestamp (both needed to notarize); ad hoc has neither.
SIGN_FLAGS=(--timestamp=none)
if [ "$IDENTITY" != - ]; then
    SIGN_FLAGS=(--options runtime --timestamp=none)
    if security find-identity -v -p codesigning 2>/dev/null | grep -F "$IDENTITY" | grep -q 'Developer ID Application'; then SIGN_FLAGS=(--options runtime --timestamp); fi
fi
sign() { codesign --force --sign "$IDENTITY" "${SIGN_FLAGS[@]}" "$@"; }
while IFS= read -r f; do
    case "$f" in "$CONTENTS/MacOS/qnet") continue ;; esac
    said="$(sign "$f" 2>&1)" || die "could not sign $f: $said"
done < <(machos | grep "^$FRAMEWORKS/"; machos | grep -v "^$FRAMEWORKS/")
sign "$APP" || die "could not sign $APP"
node "$ROOT/scripts/verify-version.mjs" --app "$APP" || die "the bundle's version disagrees with the source"
codesign --verify --deep --strict "$APP" || die "the signature does not verify"

log "Self-containment"
# A developer's Mac cannot notice this by running the app: /opt/homebrew is here and absent on
# the Mac the app is sent to (INV-046, PKG-016).
problems=0
while IFS= read -r f; do
    # What it loads, without its own install name (a library's first entry; NumPy's carry the
    # path of the machine that built the wheel, which nothing reads).
    own=$(otool -D "$f" | tail -n +2)
    loads=$(otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -v -x -F -e "${own:-//}" || true)
    # A reference relative to the file itself (or to the program that loads it, for a program)
    # must lead to a file inside the bundle.
    for ref in $(printf '%s\n' "$loads" | grep -E '^@(loader_path|executable_path)/' || true); do
        target="$(dirname "$f")/${ref#@*/}"
        resolved="$(cd "$(dirname "$target")" 2>/dev/null && pwd -P)/$(basename "$target")"
        case "$resolved" in "$APP"/*) [ -f "$resolved" ] || resolved="" ;; *) resolved="" ;; esac
        [ -n "$resolved" ] || { printf '  ! %s needs %s, which is not in the bundle\n' "${f#"$APP"/}" "$ref" >&2; problems=$((problems + 1)); }
    done
    outside=$(printf '%s\n' "$loads" | grep -v -E '^(/usr/lib/|/System/|@rpath/|@loader_path/|@executable_path/|$)' || true)
    if [ -n "$outside" ]; then printf '  ! %s links %s\n' "${f#"$APP"/}" "$(printf '%s' "$outside" | tr '\n' ' ')" >&2; problems=$((problems + 1)); fi
    rpaths=$(otool -l "$f" | awk '/LC_RPATH/{r=1} r&&/ path /{print $2; r=0}')
    for name in $(printf '%s\n' "$loads" | awk '$1 ~ /^@rpath\//{sub("@rpath/","",$1); print $1}'); do
        # It must be found the way dyld will look: through one of this file's own search paths.
        found=0
        for rp in $rpaths; do
            case "$rp" in @loader_path*) [ -f "$(dirname "$f")${rp#@loader_path}/$name" ] && found=1 ;;
                          @executable_path*) [ -f "$(dirname "$f")${rp#@executable_path}/$name" ] && found=1 ;; esac
        done
        [ "$found" = 1 ] || { printf '  ! %s needs %s and has no search path that reaches it in the bundle\n' "${f#"$APP"/}" "$name" >&2; problems=$((problems + 1)); }
    done
    if printf '%s\n' "$rpaths" | grep -q '^/'; then
        printf '  ! %s has an absolute search path: %s\n' "${f#"$APP"/}" "$(printf '%s\n' "$rpaths" | grep '^/' | tr '\n' ' ')" >&2; problems=$((problems + 1))
    fi
    [ "$(lipo -archs "$f" 2>/dev/null)" = arm64 ] || { printf '  ! %s is not arm64 only\n' "${f#"$APP"/}" >&2; problems=$((problems + 1)); }
    # No load command of any kind may name a package manager's folder: not a library to load or a
    # search path (caught above too), and not an install name, a linker option or a dyld
    # environment either. This reads every load command of every binary: the app, the solvers,
    # the libraries, and the Python interpreter and each of its and NumPy's .so and .dylib files.
    foreign=$(otool -l "$f" | grep -E '/opt/homebrew|/usr/local/' || true) # grep finding nothing is the good case
    if [ -n "$foreign" ]; then
        printf '  ! %s has a load command naming /opt/homebrew or /usr/local: %s\n' "${f#"$APP"/}" "$(printf '%s' "$foreign" | tr -s ' \n' ' ')" >&2; problems=$((problems + 1))
    fi
done < <(machos)
[ "$problems" -eq 0 ] || die "$problems self-containment problem(s)"
printf '  %s binaries (%s of them in the Python runtime), none linking outside the bundle and the system,\n  no load command naming /opt/homebrew or /usr/local\n' \
    "$(machos | wc -l | tr -d ' ')" "$(machos | grep -c "^$RESOURCES/python/" || true)"

# The signed interpreter must start with nothing of the user's and load NumPy's own modules
# (under the hardened runtime that is library validation: every module carries the app's signature).
"$RESOURCES/python/bin/python3" -c 'import sys; assert sys.flags.ignore_environment and sys.flags.no_user_site' 2>/dev/null \
    || die "the bundled Python is not isolated from the user's environment"
said=$(cd / && env -i "$RESOURCES/python/bin/python3" -c 'import numpy as np; a = np.array([[4.0, 1.0], [2.0, 3.0]]); assert np.allclose(np.linalg.solve(a, a @ np.ones(2)), 1.0); import sys; print("Python %s, NumPy %s" % (sys.version.split()[0], np.__version__))' 2>&1) \
    || die "the bundled Python does not start or cannot import NumPy once signed: $said"
printf '  the bundled interpreter starts with an empty environment: %s\n' "$said"

log "Nothing of the build machine"
# No file in the bundle may name this Mac's home folder or the checkout: the program needs neither,
# and a released app would carry them to everyone (scripts/build-app.sh remaps them away).
leaks="$(grep -rl -a -F -e "$HOME" -e "$ROOT" "$APP" 2>/dev/null || true)"
if [ -n "$leaks" ]; then
    printf '%s\n' "$leaks" | sed "s|^$APP/|  ! |" >&2
    die "the files above contain this Mac's home folder path"
fi
printf '  no file names %s or the checkout\n' "$HOME"
# The Python package must import with the bundled interpreter, from anywhere and with nothing of
# the user's, and must find this bundle's own qnet-cli (python/qnet/_cli.py). -B: no bytecode is
# written into the signed bundle.
said=$(cd / && env -i "$RESOURCES/python/bin/python3" -B -c 'import sys; sys.path.insert(0, sys.argv[1]); import qnet; print(qnet.find_cli())' "$RESOURCES/scripting" 2>&1) \
    || die "the bundled Python package does not import: $said"
[ "$said" = "$(cd "$CONTENTS/MacOS" && pwd -P)/qnet-cli" ] || die "the bundled Python package finds $said, not this bundle's qnet-cli"
[ -z "$(find "$RESOURCES/scripting" -name '__pycache__' -o -name '*.pyc')" ] || die "the Python package in the bundle holds bytecode"
printf '  the Python package imports and finds %s\n' "${said#"$APP"/}"

# Reported, not refused: the words /opt/homebrew in the Python runtime's own files (sysconfig's
# record of how the interpreter was built, a search list in the standard library). Nothing loads
# from there (the load commands were checked above), so whether a mention matters is for a person
# to judge. Bytecode is left out: each .pyc repeats its .py.

mentions="$(grep -r -a -c -F -e /opt/homebrew --exclude-dir=__pycache__ "$RESOURCES/python" 2>/dev/null | grep -v ':0$' || true)" # none: the good case
if [ -n "$mentions" ]; then
    printf '  note: /opt/homebrew is mentioned in these Python runtime files (file: lines), which is reported and not refused:\n'
    printf '%s\n' "$mentions" | sed "s|^$RESOURCES/python/|    |"
else
    printf '  /opt/homebrew is mentioned in no file of the Python runtime\n'
fi

if [ -x "$ROOT/validation/solver_bundle_audit.sh" ]; then
    log "Bundle audit"
    bash "$ROOT/validation/solver_bundle_audit.sh" "$APP" || die "the bundle audit failed"
fi
log "Third-party notices"
node "$ROOT/scripts/notices.mjs" --check --app "$APP" || die "the bundle's libraries or licences differ from the committed notices (after a re-stage or a rebuild of the libraries with scripts/build-deps.sh: node scripts/notices.mjs --native)"
printf '\nAssembled: %s\n' "$APP"
