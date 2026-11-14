#!/usr/bin/env bash
# Makes the Python that Qnet carries, so the Python solvers run on a Mac with no Python installed
# (ROADMAP A2). It downloads one pinned CPython (python-build-standalone, arm64 macOS,
# "install_only_stripped") and one pinned NumPy wheel, checks each against the sha256 recorded
# below, and assembles a small runtime laid out as it will sit in the app:
#
#   ~/Library/Caches/qnet/python/stage/Resources/python/   →  Qnet.app/Contents/Resources/python/
#       bin/python3            a /bin/sh launcher: no PYTHON* variable, no user site-packages,
#                              no bytecode written; it starts bin/python3.15 beside it, however
#                              it was reached (a path, a symbolic link, or by name through PATH)
#       bin/python3.15         the interpreter (one self-contained executable; the standard
#                              library's C modules, OpenSSL, SQLite and the rest are linked in)
#       lib/python3.15/        the standard library and site-packages/numpy
#       licenses/              the licence texts of CPython and of what is linked into it
#   ~/Library/Caches/qnet/python/stage/python-components.json   what was bundled, for the notices
#       (node scripts/notices.mjs --python copies it to ThirdPartyLicenses/python-components.json)
#   ~/Library/Caches/qnet/python/downloads/                     the archives, kept between runs
#
#   ~/Library/Caches/qnet/python/stage/STAGE_STAMP              what the stage was made from: the pins
#       below (versions, archives, sha256s) and this script's own sha256. scripts/assemble-bundle.sh
#       refuses a stage whose stamp is not the one this script prints with --stamp, so a runtime
#       left over from before a pin was changed (or before a run that failed midway) cannot ship.
#
#   scripts/stage-python.sh            build the runtime (downloads only what is not there yet);
#                                      does nothing when the stage already carries this stamp
#   scripts/stage-python.sh --force    build it again whatever the stamp says
#   scripts/stage-python.sh --check    verify the runtime already staged, change nothing
#   scripts/stage-python.sh --stamp    print the stamp this script would give a stage, build nothing
#
# The runtime is assembled in a temporary folder beside the stage (stage.new.<pid>) and moved into
# place only when every check has passed: a run that fails leaves the previous stage as it was,
# with its previous stamp.
#
# Why a launcher and not `python3 -I`: -I also stops Python putting a script's own folder on its
# module path, and the solvers import their neighbours (`from common import …`). The launcher
# passes -E -s -B, which is -I without that, and clears the variables for any child Python too.
#
# Why bytecode is in the runtime: without it every start compiles the standard library and NumPy
# again (1.3 s to import NumPy instead of 0.1 s, against the resolver's 2 s check). The caches
# shipped in the archives are dropped and remade here as "unchecked-hash" files, which hold no
# timestamp and no path of this Mac and are never rewritten, so the signed app stays as signed.
#
# To move to another CPython or NumPy: change the pins, run this, then run the golden comparisons
# (cargo test -p qnet-runner --no-fail-fast); the corpus was recorded with CPython 3.15.2 and
# NumPy 2.5.4, and Python's sum() and NumPy's linear algebra decide printed digits.
set -euo pipefail

# ── The pins ─────────────────────────────────────────────────────────────────────────────────
PBS_RELEASE=20261110
PY_VERSION=3.15.2
PY_SERIES=3.15
PBS_BASE="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE"
PY_FILE="cpython-$PY_VERSION+$PBS_RELEASE-aarch64-apple-darwin-install_only_stripped.tar.gz"
PY_SHA256=7e58607647b5b4832092a339ff1c55eeeccee128221232509b8fc8d27957065e
# The same build's full archive: only its licences/ folder and PYTHON.json are taken from it (the
# install_only archives leave out the licence texts of the libraries linked into the interpreter).
PYFULL_FILE="cpython-$PY_VERSION+$PBS_RELEASE-aarch64-apple-darwin-pgo+lto-full.tar.zst"
PYFULL_SHA256=53af18af034de253bac9b08d95c861d5b08a6d46a87ec5c9d8b34577fe48b4ad

NUMPY_VERSION=2.5.4
# NumPy publishes two arm64 wheels. "openblas" (macosx_11_0) carries OpenBLAS and the GNU Fortran
# runtime inside the wheel; "accelerate" (macosx_14_0) uses Apple's Accelerate, is 17 MB smaller
# and adds no library of its own. The app ships "openblas": the golden corpus was recorded with an
# OpenBLAS NumPy and this wheel reproduces all of it, while with Accelerate the adaptive BAR
# method (low_rank_bar.py) prints different last digits on 23 of its 35 examples (measured
# 2026-11-12: at most 1.4e-8 relative in a variance, more in the residual lines).
# QNET_NUMPY_BLAS=accelerate stages the other one, to measure that again.
NUMPY_BLAS="${QNET_NUMPY_BLAS:-openblas}"
case "$NUMPY_BLAS" in
    openblas)
        NUMPY_FILE="numpy-$NUMPY_VERSION-cp315-cp315-macosx_11_0_arm64.whl"
        NUMPY_URL="https://files.pythonhosted.org/packages/be/75/fee0b8c6d94b44b2fdfae74f6a4ad5a138739589a8aebaec28ce4e713ed5/$NUMPY_FILE"
        NUMPY_SHA256=81e3420b27048b65eb14c3acf0c174a8cb0e023277716110347d2dcb26026dad ;;
    accelerate)
        NUMPY_FILE="numpy-$NUMPY_VERSION-cp315-cp315-macosx_14_0_arm64.whl"
        NUMPY_URL="https://files.pythonhosted.org/packages/47/c0/d0b335a499a04b65f532c3f034346ef390f81299060f928492dabc1e0272/$NUMPY_FILE"
        NUMPY_SHA256=0b4724a19de67bea8cfc4970798efa78bcbbe2ac2613cfac16721a42d44de2a5 ;;
    *) printf 'ERROR: QNET_NUMPY_BLAS must be openblas or accelerate\n' >&2; exit 1 ;;
esac
# No bundled binary may need a newer macOS than this.
MAX_MINOS=14.0

# What a stage made by this script, with these pins, is stamped with. Everything that decides a
# byte of the runtime is a pin above or a line of this script, so the two together identify it.
stage_stamp() {
    printf 'qnet-python-stage 1\n'
    printf 'python-build-standalone %s\n' "$PBS_RELEASE"
    printf 'cpython %s %s %s\n' "$PY_VERSION" "$PY_FILE" "$PY_SHA256"
    printf 'cpython-full %s %s\n' "$PYFULL_FILE" "$PYFULL_SHA256"
    printf 'numpy %s %s %s %s\n' "$NUMPY_VERSION" "$NUMPY_BLAS" "$NUMPY_FILE" "$NUMPY_SHA256"
    printf 'numpy-url %s\n' "$NUMPY_URL"
    printf 'max-minimum-macos %s\n' "$MAX_MINOS"
    printf 'recipe %s\n' "$(shasum -a 256 "${BASH_SOURCE[0]}" | cut -d' ' -f1)"
}
if [ "${1:-}" = "--stamp" ]; then
    [ "$#" -eq 1 ] || { printf 'ERROR: --stamp takes nothing else\n' >&2; exit 1; }
    stage_stamp
    exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CACHE="${QNET_PYTHON_CACHE:-$HOME/Library/Caches/qnet/python}"
DOWNLOADS="$CACHE/downloads"
STAGE="$CACHE/stage"
RUNTIME="$STAGE/Resources/python"
log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
case "$CACHE" in "$ROOT"/*) die "the Python runtime is staged outside the repository (it lives in Dropbox)";; esac
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "this stages the arm64 macOS runtime; run it on an Apple-silicon Mac"

sha_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

# fetch <url> <file name> <sha256>: downloads into $DOWNLOADS unless a good copy is already there.
fetch() {
    local url="$1" name="$2" want="$3" dest="$DOWNLOADS/$2"
    if [ -f "$dest" ] && [ "$(sha_of "$dest")" = "$want" ]; then printf '  have %s\n' "$name"; return; fi
    printf '  downloading %s\n' "$name"
    curl --fail --location --silent --show-error --output "$dest.part" "$url" || die "could not download $url"
    local got; got="$(sha_of "$dest.part")"
    [ "$got" = "$want" ] || { rm -f "$dest.part"; die "$name has sha256 $got, expected $want: not used"; }
    mv "$dest.part" "$dest"
}

# Every Mach-O file under a folder.
machos() {
    find "$1" -type f ! -name '*.py' ! -name '*.pyc' ! -name '*.txt' ! -name '*.json' -print0 | while IFS= read -r -d '' f; do
        if file -b "$f" | grep -q 'Mach-O'; then printf '%s\n' "$f"; fi
    done
}
minos_of() { otool -l "$1" | awk '/LC_BUILD_VERSION/{b=1} b&&/minos/{print $2; b=0}'; }
not_above() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$2" ]; }

# The checks a staged runtime must pass, wherever it is. verify <runtime folder>
verify() {
    local rt="$1" problems=0 highest=0 count=0 f
    [ -x "$rt/bin/python3" ] && [ -x "$rt/bin/python$PY_SERIES" ] || die "no runtime at $rt: run scripts/stage-python.sh"
    while IFS= read -r f; do
        count=$((count + 1))
        local m; m="$(minos_of "$f")"
        [ -n "$m" ] || { printf '  ! %s states no minimum macOS\n' "${f#"$rt"/}" >&2; problems=$((problems + 1)); continue; }
        not_above "$m" "$MAX_MINOS" || { printf '  ! %s needs macOS %s\n' "${f#"$rt"/}" "$m" >&2; problems=$((problems + 1)); }
        not_above "$m" "$highest" || highest="$m"
        [ "$(lipo -archs "$f" 2>/dev/null)" = arm64 ] || { printf '  ! %s is not arm64 only\n' "${f#"$rt"/}" >&2; problems=$((problems + 1)); }
        # Each library it loads is the system's, or is found from the file's own folder.
        local dep
        while IFS= read -r dep; do
            case "$dep" in
                /usr/lib/*|/System/*) ;;
                @loader_path/*) [ -f "$(dirname "$f")/${dep#@loader_path/}" ] || { printf '  ! %s loads %s, which is not in the runtime\n' "${f#"$rt"/}" "$dep" >&2; problems=$((problems + 1)); } ;;
                *) printf '  ! %s loads %s\n' "${f#"$rt"/}" "$dep" >&2; problems=$((problems + 1)) ;;
            esac
        done < <(otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -v -F "/$(basename "$f")" || true)
        # No load command of any kind (a library to load, a search path, an install name) may name
        # a package manager's folder: it would be there on the build Mac and nowhere else.
        local foreign
        foreign="$(otool -l "$f" | grep -E '/opt/homebrew|/usr/local/' || true)" # grep finding nothing is the good case
        [ -z "$foreign" ] || { printf '  ! %s has a load command naming /opt/homebrew or /usr/local: %s\n' "${f#"$rt"/}" "$(printf '%s' "$foreign" | tr -s ' \n' ' ')" >&2; problems=$((problems + 1)); }
    done < <(machos "$rt")
    [ "$problems" -eq 0 ] || die "$problems problem(s) in the runtime's binaries"
    printf '  %s binaries, arm64, highest minimum macOS %s, nothing loaded from outside the runtime and the system\n' "$count" "$highest"

    # It must start with nothing from the user: no PATH, no HOME, and hostile PYTHON* variables.
    local trap_dir; trap_dir="$(mktemp -d "${TMPDIR:-/tmp}/qnet-python-check.XXXXXX")"
    printf 'raise SystemExit("the user PYTHONPATH leaked in")\n' > "$trap_dir/numpy.py"
    local said
    said="$(cd / && env -i PYTHONPATH="$trap_dir" PYTHONHOME="$trap_dir" PYTHONSTARTUP="$trap_dir/numpy.py" PYTHONUSERBASE="$trap_dir" "$rt/bin/python3" -c '
import sys, site, json, argparse, fractions, dataclasses, pathlib, subprocess, numpy as np
assert sys.flags.ignore_environment and sys.flags.no_user_site and sys.flags.dont_write_bytecode, sys.flags
assert not site.ENABLE_USER_SITE and not sys.flags.safe_path
root = pathlib.Path(sys.executable).resolve().parent.parent
outside = [p for p in sys.path if p and root not in pathlib.Path(p).resolve().parents]
assert not outside, outside
assert sys.implementation.cache_tag and np.__file__.startswith(str(root)), np.__file__
a = np.array([[4.0, 1.0], [2.0, 3.0]])
assert np.allclose(np.linalg.solve(a, a @ np.array([1.0, 2.0])), [1.0, 2.0])
child = subprocess.run([sys.executable, "-c", "import sys, numpy; print(len([p for p in sys.path if p]))"], capture_output=True, text=True)
assert child.returncode == 0 and child.stdout.strip() == str(len([p for p in sys.path if p])), child
print(f"Python {sys.version.split()[0]}, NumPy {np.__version__}")
')" || { rm -rf "$trap_dir"; die "the runtime does not start on its own"; }
    rm -rf "$trap_dir"
    printf '  starts with an empty environment and imports NumPy: %s\n' "$said"
    # A script's own folder is still on the module path (the solvers import their neighbours).
    local sdir; sdir="$(mktemp -d "${TMPDIR:-/tmp}/qnet-python-check.XXXXXX")"
    printf 'VALUE = 41\n' > "$sdir/neighbour.py"; printf 'import neighbour; print(neighbour.VALUE + 1)\n' > "$sdir/main.py"
    [ "$(env -i "$rt/bin/python3" -B "$sdir/main.py")" = 42 ] || { rm -rf "$sdir"; die "a script cannot import a module beside it"; }
    [ -z "$(find "$sdir" -name '__pycache__')" ] || { rm -rf "$sdir"; die "the runtime wrote bytecode beside a script"; }
    rm -rf "$sdir"
    # Nothing of the Mac that built it.
    local leaks; leaks="$(grep -rl -a -F -e "$HOME" -e "$ROOT" "$rt" 2>/dev/null || true)" # grep finding nothing is the good case
    [ -z "$leaks" ] || { printf '%s\n' "$leaks" | sed "s|^$rt/|  ! |" >&2; die "the files above name this Mac's home folder or the checkout"; }
    printf '  no file names %s or the checkout\n' "$HOME"
}

if [ "${1:-}" = "--check" ]; then
    log "Checking $RUNTIME"
    [ -f "$STAGE/STAGE_STAMP" ] && [ "$(cat "$STAGE/STAGE_STAMP")" = "$(stage_stamp)" ] \
        || die "the stage at $STAGE was not made by this scripts/stage-python.sh with these pins: run scripts/stage-python.sh"
    printf '  the stamp is the one this script gives\n'
    verify "$RUNTIME"
    exit 0
fi
FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; shift; fi
[ "$#" -eq 0 ] || die "usage: scripts/stage-python.sh [--force | --check | --stamp]"

if [ "$FORCE" -eq 0 ] && [ -f "$STAGE/STAGE_STAMP" ] && [ "$(cat "$STAGE/STAGE_STAMP")" = "$(stage_stamp)" ] \
    && [ -x "$RUNTIME/bin/python3" ] && [ -x "$RUNTIME/bin/python$PY_SERIES" ] && [ -f "$STAGE/python-components.json" ]; then
    printf 'The Python runtime is up to date: %s\n(scripts/stage-python.sh --check verifies it again; --force rebuilds it)\n' "$RUNTIME"
    exit 0
fi

log "Downloads (python-build-standalone $PBS_RELEASE, NumPy $NUMPY_VERSION $NUMPY_BLAS)"
mkdir -p "$DOWNLOADS"
fetch "$PBS_BASE/${PY_FILE//+/%2B}" "$PY_FILE" "$PY_SHA256"
fetch "$PBS_BASE/${PYFULL_FILE//+/%2B}" "$PYFULL_FILE" "$PYFULL_SHA256"
fetch "$NUMPY_URL" "$NUMPY_FILE" "$NUMPY_SHA256"

log "Unpacking"
# The archives are unpacked in work/, and the new stage is put together in stage.new.<pid>, a
# sibling of the stage: the move at the end is then a rename, and until it happens the stage that
# is there (if any) is untouched. Both are removed when this script ends, however it ends.
WORK="$CACHE/work"
NEWSTAGE="$CACHE/stage.new.$$"
cleanup() { rm -rf "$WORK" "$NEWSTAGE"; }
trap cleanup EXIT
rm -rf "$WORK" "$CACHE"/stage.new.* "$CACHE"/stage.old.*
mkdir -p "$WORK/cpython" "$WORK/full" "$WORK/numpy" "$NEWSTAGE/Resources"
tar -xzf "$DOWNLOADS/$PY_FILE" -C "$WORK/cpython" || die "could not unpack $PY_FILE (tar's own message is above)"
# tar says itself what went wrong. Apple's tar has no zstd of its own and runs the zstd program, so
# only when there is none on PATH is that the likely reason, and only then is it suggested.
if ! tar -xf "$DOWNLOADS/$PYFULL_FILE" -C "$WORK/full" python/PYTHON.json python/licenses; then
    if command -v zstd >/dev/null 2>&1 || tar --version 2>/dev/null | grep -q -i 'zstd'; then
        die "could not read $PYFULL_FILE (tar's own message is above)"
    fi
    die "could not read $PYFULL_FILE (tar's own message is above). There is no zstd program on PATH, and this tar needs one to open a .tar.zst archive"
fi
unzip -q "$DOWNLOADS/$NUMPY_FILE" -d "$WORK/numpy" || die "could not unpack $NUMPY_FILE"

log "Assembling the runtime"
NEW="$NEWSTAGE/Resources/python"
LIB="$NEW/lib/python$PY_SERIES"
mkdir -p "$NEW/bin" "$NEW/lib"
cp "$WORK/cpython/python/bin/python$PY_SERIES" "$NEW/bin/"
cp -R "$WORK/cpython/python/lib/python$PY_SERIES" "$NEW/lib/"
# Not needed to run a solver: the test suite, IDLE, Tk and turtle, pip and the tools that install
# things, the C headers' configuration and static library, pydoc's topic texts, and the two
# loadable modules (_tkinter, and _dbm, which would bring Berkeley DB's licence).
( cd "$LIB" && rm -rf test idlelib tkinter turtle.py turtledemo ensurepip venv pydoc_data \
      "config-$PY_SERIES-darwin" __phello__ __hello__.py site-packages lib-dynload/_tkinter.*.so lib-dynload/_dbm.*.so )
mkdir -p "$LIB/site-packages"
cp -R "$WORK/numpy/numpy" "$WORK/numpy/numpy-$NUMPY_VERSION.dist-info" "$LIB/site-packages/"
# NumPy's own tests, its Fortran wrapper generator, C headers, static libraries and type stubs.
( cd "$LIB/site-packages/numpy" && rm -rf f2py _pyinstaller doc conftest.py _core/include _core/lib random/lib \
      _core/_simd.*.so && find . -type d \( -name tests -o -name test_data \) -prune -exec rm -rf {} + \
      && find . -type f \( -name '*_tests.*.so' -o -name '*.pyi' -o -name '*.pxd' -o -name '*.h' -o -name '*.a' -o -name '*.c' \) -delete )
find "$NEW" \( -name '__pycache__' -o -name '.DS_Store' -o -name '.empty' \) -prune -exec rm -rf {} +

# The licence texts: CPython's and those of the libraries linked into the interpreter (the Tk,
# X11 and Berkeley DB ones belong to the two modules left out).
mkdir -p "$NEW/licenses"
for f in "$WORK"/full/python/licenses/LICENSE.*.txt; do
    case "$(basename "$f")" in LICENSE.tcl.txt|LICENSE.tix.txt|LICENSE.libX11.txt|LICENSE.libXau.txt|LICENSE.libxcb.txt|LICENSE.bdb.txt) ;; *) cp "$f" "$NEW/licenses/" ;; esac
done

# The launcher. It finds the interpreter beside itself, wherever it was started from: by a path
# (with spaces or not), through a symbolic link to it (followed link by link, as many as there
# are), or as `sh python3` with no folder in $0, where the shell looked in the current folder and
# then along PATH, so it does the same. It uses nothing but the shell and, for a link, `ls` found
# on the system's own path (`command -p`): PATH may be empty or hostile when it runs.
cat > "$NEW/bin/python3" <<LAUNCHER
#!/bin/sh
# Qnet's own Python, kept apart from any other: no PYTHON* variable, no user site-packages, no
# bytecode written. A script's own folder stays on its module path (the solvers need that).
self=\$0
case "\$self" in
*/*) ;;
*)  # No folder in \$0: the shell was given this script by name. It looks in the current folder,
    # then along PATH; so does this.
    found=
    if [ -f "./\$self" ]; then
        found="./\$self"
    else
        oldifs=\$IFS; IFS=:; set -f
        for dir in \$PATH; do
            [ -n "\$dir" ] || dir=.
            if [ -z "\$found" ] && [ -f "\$dir/\$self" ]; then found="\$dir/\$self"; fi
        done
        set +f; IFS=\$oldifs
    fi
    [ -n "\$found" ] || { echo "\$self: cannot find where Qnet's Python launcher is (started with no folder in its name, and it is not on PATH)" >&2; exit 127; }
    self=\$found ;;
esac
# Follow symbolic links to the launcher itself; a relative link is relative to the link's folder.
hops=0
while [ -L "\$self" ]; do
    hops=\$((hops + 1))
    [ "\$hops" -le 40 ] || { echo "\$0: too many symbolic links" >&2; exit 126; }
    link=\$(command -p ls -ld -- "\$self") || exit 126
    link=\${link#*" \$self -> "}
    case "\$link" in
    /*) self=\$link ;;
    *)  case "\$self" in */*) self="\${self%/*}/\$link" ;; *) self="./\$link" ;; esac ;;
    esac
done
here=\${self%/*}
[ -x "\$here/python$PY_SERIES" ] || { echo "\$0: no python$PY_SERIES beside the launcher in \$here" >&2; exit 126; }
unset PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE PYTHONPYCACHEPREFIX PYTHONINSPECT PYTHONSAFEPATH
PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1
export PYTHONNOUSERSITE PYTHONDONTWRITEBYTECODE
exec "\$here/python$PY_SERIES" -E -s -B "\$@"
LAUNCHER
chmod 755 "$NEW/bin/python3" "$NEW/bin/python$PY_SERIES"
xattr -cr "$NEW"

log "Bytecode"
# Relative paths, so no compiled file names this Mac; Python puts the real path in when it loads one.
( cd "$NEW" && env -i "bin/python$PY_SERIES" -E -s -B -m compileall -q -j 0 --invalidation-mode unchecked-hash "lib/python$PY_SERIES" >/dev/null ) \
    || die "the standard library did not compile"
chmod -R u+w,go-w,a+rX "$NEW"

log "Checks"
verify "$NEW"

log "Components"
env -i "$NEW/bin/python3" - "$NEW" "$WORK/full/python/PYTHON.json" "$NEWSTAGE/python-components.json" <<PYTHON
import json, pathlib, sys
runtime, build_json, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
build = json.loads(build_json.read_text())
import ssl, sqlite3, pyexpat, decimal, numpy
try:
    from compression import zstd as _zstd
    zstd_version = _zstd.zstd_version
except Exception:
    zstd_version = None
versions = {
    "openssl-3": ssl.OPENSSL_VERSION.split()[1], "sqlite": sqlite3.sqlite_version, "expat": pyexpat.EXPAT_VERSION.replace("expat_", ""), "mpdecimal": decimal.__libmpdec_version__, "zstd": zstd_version,
}
names = {"openssl-3": "OpenSSL", "sqlite": "SQLite", "zlib": "zlib", "zlib-ng": "zlib-ng", "expat": "Expat", "mpdecimal": "mpdecimal",
         "zstd": "Zstandard", "bzip2": "bzip2", "libffi": "libffi", "liblzma": "XZ Utils (liblzma)", "libuuid": "libuuid",
         "ncurses": "ncurses", "libedit": "libedit"}
# One identifier per licence text (the build record gives them per module, several texts together).
ids = {"bzip2": "bzip2-1.0.6", "expat": "MIT", "libedit": "BSD-3-Clause", "libffi": "MIT", "liblzma": "0BSD", "libuuid": "BSD-3-Clause",
       "mpdecimal": "BSD-2-Clause", "ncurses": "X11", "openssl-3": "Apache-2.0", "sqlite": "blessing", "zlib": "Zlib", "zlib-ng": "Zlib",
       "zstd": "BSD-3-Clause"}
def texts(*relative):
    for r in relative:
        assert (runtime / r).is_file(), r
    return list(relative)
pbs = "$PBS_BASE"
components = [{
    "name": "CPython", "version": "$PY_VERSION", "role": "interpreter and standard library",
    "url": pbs + "/" + "$PY_FILE".replace("+", "%2B"), "sha256": "$PY_SHA256",
    "source": "python-build-standalone $PBS_RELEASE (https://github.com/astral-sh/python-build-standalone), build aarch64-apple-darwin install_only_stripped",
    "licence": " AND ".join(build["licenses"]), "licence_texts": texts("licenses/LICENSE.cpython.txt", "lib/python$PY_SERIES/LICENSE.txt"),
    "files": ["bin/python$PY_SERIES", "lib/python$PY_SERIES/"],
}]
# What python-build-standalone linked into the interpreter, from its own build record.
linked = {}
for module, variants in sorted(build["build_info"]["extensions"].items()):
    if module in ("_tkinter", "_dbm"):
        continue
    for v in variants:
        for path in v.get("license_paths") or []:
            key = pathlib.Path(path).name[len("LICENSE."):-len(".txt")]
            entry = linked.setdefault(key, {"modules": [], "ids": v.get("licenses") or []})
            entry["modules"].append(module)
for key, entry in sorted(linked.items()):
    components.append({
        "name": names.get(key, key), "version": versions.get(key), "role": "linked into the interpreter (modules: " + ", ".join(sorted(set(entry["modules"]))) + ")",
        "url": pbs + "/" + "$PYFULL_FILE".replace("+", "%2B"), "sha256": "$PYFULL_SHA256",
        "source": "python-build-standalone $PBS_RELEASE; licence text and identifier from that build's PYTHON.json",
        "licence": ids.get(key) or " AND ".join(entry["ids"]), "licence_texts": texts(f"licenses/LICENSE.{key}.txt"),
        "files": ["bin/python$PY_SERIES"],
    })
site = "lib/python$PY_SERIES/site-packages"
info = runtime / site / "numpy-$NUMPY_VERSION.dist-info"
meta = (info / "METADATA").read_text()
expression = next((l.split(":", 1)[1].strip() for l in meta.splitlines() if l.startswith("License-Expression:")), None)
numpy_texts = sorted(str(p.relative_to(runtime)) for p in (info / "licenses").rglob("*") if p.is_file())
components.append({
    "name": "NumPy", "version": numpy.__version__, "role": "array library the CTMC and adaptive BAR solvers import",
    "url": "$NUMPY_URL", "sha256": "$NUMPY_SHA256", "source": "PyPI wheel $NUMPY_FILE",
    "licence": expression, "licence_texts": numpy_texts, "files": [site + "/numpy/"],
})
dylibs = sorted(p.name for p in (runtime / site / "numpy" / ".dylibs").glob("*.dylib")) if (runtime / site / "numpy" / ".dylibs").is_dir() else []
if dylibs:
    components.append({
        "name": "OpenBLAS and the GNU Fortran runtime (inside the NumPy wheel)", "version": None,
        "role": "linear algebra for NumPy: " + ", ".join(dylibs),
        "url": "$NUMPY_URL", "sha256": "$NUMPY_SHA256", "source": "PyPI wheel $NUMPY_FILE",
        "licence": "BSD-3-Clause (OpenBLAS); BSD-3-Clause-Open-MPI (LAPACK inside OpenBLAS); GPL-3.0-or-later WITH GCC-exception-3.1 (libgfortran, libgcc_s); LGPL-2.1-or-later (libquadmath)",
        "licence_texts": [t for t in numpy_texts if t.endswith("licenses/LICENSE.txt")],
        "files": [site + "/numpy/.dylibs/" + d for d in dylibs],
    })
manifest = {
    "schema": 1,
    "runtime": "Contents/Resources/python",
    "python": "$PY_VERSION", "numpy": numpy.__version__, "numpy_blas": "$NUMPY_BLAS",
    "minimum_macos": build["apple_sdk_deployment_target"],
    "note": "licence_texts and files are paths inside the runtime folder",
    "components": components,
}
out.write_text(json.dumps(manifest, indent=2) + "\n")
print(f"  {len(components)} components")
PYTHON

log "Staging"
# The stamp goes in last, into the new stage, so a stage that has one passed everything above.
stage_stamp > "$NEWSTAGE/STAGE_STAMP"
# Two renames: the old stage steps aside, the new one takes its place. If the second failed the
# old one is put back; `|| true` on its removal because a stage that cannot be deleted (a file of
# it open elsewhere) is no reason to call a finished stage a failure, and the next run removes it.
if [ -e "$STAGE" ]; then mv "$STAGE" "$CACHE/stage.old.$$" || die "could not move the previous stage aside"; fi
mv "$NEWSTAGE" "$STAGE" || { [ ! -e "$CACHE/stage.old.$$" ] || mv "$CACHE/stage.old.$$" "$STAGE"; die "could not move the new stage into place"; }
rm -rf "$CACHE/stage.old.$$" || true
cmp -s "$STAGE/python-components.json" "$ROOT/ThirdPartyLicenses/python-components.json" || printf '  the components differ from ThirdPartyLicenses/python-components.json: run node scripts/notices.mjs --python\n'
size_kb=$(du -sk "$RUNTIME" | cut -f1)
cache_kb=$(find "$RUNTIME" -name '__pycache__' -prune -print0 | xargs -0 du -sk | awk '{s+=$1} END{print s+0}')
printf '  %s\n  %d MB (of which bytecode %d MB), %s files\n' "$RUNTIME" $((size_kb / 1024)) $((cache_kb / 1024)) "$(find "$RUNTIME" -type f | wc -l | tr -d ' ')"
printf '\nStaged: %s\n' "$RUNTIME"
