#!/usr/bin/env bash
# Builds every shipped solver and stages it, ready to bundle, outside Dropbox.
#
#   ~/Library/Caches/qnet/deps/                the libraries the solvers link, built from pinned
#                                              sources by scripts/build-deps.sh (run from here)
#   ~/Library/Caches/qnet/solvers/build/       a copy of solvers/ that make builds in (the
#                                              repository's solvers/ stays source-only)
#   ~/Library/Caches/qnet/solvers/stage/
#     Resources/bin/{finite,infinite}/<dir>/   17 native executables + the Python solvers,
#                                              in the source tree's layout (bna_sbd finds bnet,
#                                              and the Python solvers their neighbours, by it)
#     Resources/solver-runtime-status-v1.tsv   what is available, read by the runner (P3)
#     Frameworks/*.dylib                       the libraries the solvers link
#     deps-manifest.json                       where those libraries come from (build-deps.sh's
#                                              manifest, read by scripts/notices.mjs --native)
#
# Everything is compiled by Apple clang for macOS 14.0 and later, against the libraries and
# headers build-deps.sh made: nothing is taken from Homebrew, and the stage fails if any staged
# file needs a newer macOS or links anything but the system and Frameworks/.
#
# The stage mirrors Qnet.app/Contents, so each executable's rpath is relative to where it will
# sit in the bundle. The relocation, loadability probe and manifest follow 2_QNET's
# build_app.sh (0.90.34) step for step; what changed is listed in docs/PARITY.md. Every
# executable is ad-hoc signed here; P8 re-signs with the release identity.
#
# The stage carries two stamps, written last, that scripts/assemble-bundle.sh checks:
#   SOURCE_STAMP      a hash of solvers/ as it was when the stage was built
#   TOOLCHAIN_STAMP   everything else that decides a byte of a solver: the compiler and SDK
#                     versions, the minimum macOS, the compiler command and every make variable
#                     given to each solver's makefile, the hash of build-deps.sh (the libraries'
#                     recipe) and the hash of this script. --stamp prints it.
# When the build copy was made under another toolchain stamp it is thrown away, because make
# compares timestamps and would keep objects compiled with the old flags.
#
# Usage: scripts/stage-solvers.sh [--clean | --stamp]
#   No option: does nothing when the stage already carries both stamps as they would be now.
#   --clean rebuilds the solvers from scratch. The libraries are rebuilt only when
#   build-deps.sh changed; scripts/build-deps.sh --clean rebuilds them from the archives.
#   --stamp prints the toolchain stamp a stage built now would carry, and builds nothing.
set -euo pipefail

# Physical paths: ~/Dropbox is a symlink to ~/Library/CloudStorage/Dropbox, and building through
# two spellings of one folder poisons compiler caches (2_QNET/CLAUDE.md).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CACHE="${QNET_SOLVER_CACHE:-$HOME/Library/Caches/qnet/solvers}"
DEPS="${QNET_DEPS_DIR:-$HOME/Library/Caches/qnet/deps}"
DEPS_PREFIX="$DEPS/prefix"
# The oldest macOS the solvers run on. Every compiler command carries it, because the solvers'
# makefiles un-export MACOSX_DEPLOYMENT_TARGET and clang would then target this Mac's version.
SOLVER_MIN_MACOS="14.0"
BUILD="$CACHE/build"
STAGE="$CACHE/stage"
BIN="$STAGE/Resources/bin"
FRAMEWORKS="$STAGE/Frameworks"

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Every solver a menu item runs. A release is invalid if any of these can't be built (from
# build_app.sh REQUIRED_C_TARGETS; validation/required_release_executables.txt is the
# independent inventory the audit below checks against).
REQUIRED_C_TARGETS=(
    "infinite/BNAsbd:bna_sbd"
    "infinite/BNAqna:bna_qna"
    "infinite/BNArqna:bna_rqna"
    "infinite/BNAsim:jackson_sim"
    "infinite/BNAsm:bnet"
    "infinite/BNAlp:srbm_lp"
    "infinite/BNAmc:rbm_mlmc"
    "finite/fBNAfm:bna_fm_gauss bna_fm_cbc"
    "finite/fBNAlp:fBNAlp_solver"
    "finite/fBNAsim:fBNAsim"
    "finite/fBNAsm:srbm_solver"
    "infinite/BNArmc:bna_rmc"
    "infinite/BNAqbd:bna_qbd"
    "infinite/BNAtc:bna_tc"
    "finite/fBNAgc:fbna_gc"
)
# The experimental multiclass solver needs cJSON; without it the method is unavailable.
OPTIONAL_C_TARGETS=(
    "infinite/BNAmd:mc_solver"
)
# Python solvers, in the source layout. infinite/BNApf/mva.py is new here: solver.py imports it,
# and 0.90.34 shipped without it (PLAN.md §5, a Changed row in docs/PARITY.md).
PYTHON_SUPPORT_FILES=(
    "finite/fBNActmc/ctmc_dtandem.py"
    "finite/fBNAgc/solver.py"
    "finite/fBNAdecomp/fbna_decomp.py"
    "infinite/BNAtc/truncated_ctmc.py"
    "infinite/BNAalr/low_rank_bar.py"
    "infinite/BNAbb/__init__.py"
    "infinite/BNAbb/bar_bounds.py"
    "infinite/BNAbb/cvxpy_backend.py"
    "infinite/BNAbb/solver.py"
    "infinite/BNAbb/schema.json"
    "infinite/BNArmc/regenerative_mc.py"
    "infinite/BNAqbd/qbd_solver.py"
    "infinite/BNApf/__init__.py"
    "infinite/BNApf/bcmp.py"
    "infinite/BNApf/common.py"
    "infinite/BNApf/kaufman_roberts.py"
    "infinite/BNApf/mixed_bcmp.py"
    "infinite/BNApf/mva.py"
    "infinite/BNApf/open_bcmp.py"
    "infinite/BNApf/schema.json"
    "infinite/BNApf/solver.py"
)
# Modules beyond the standard library, recorded in the manifest and checked by the runner.
PYTHON_SUPPORT_REQUIREMENTS=(
    "finite/fBNActmc/ctmc_dtandem.py:numpy"
)

python_requirements_for() {
    local entry
    for entry in "${PYTHON_SUPPORT_REQUIREMENTS[@]}"; do
        if [ "${entry%%:*}" = "$1" ]; then printf '%s' "${entry#*:}"; fi
    done
}

# Non-zero only for a loader or architecture failure. A solver's usage error is fine: reaching
# main proves its libraries load (build_app.sh loader_probe, unchanged).
loader_probe() {
    local target="$1" err pid running=1 step
    err="$(mktemp "${TMPDIR:-/tmp}/qnet-loader.XXXXXX")"
    QNET_RUNTIME_PROBE=1 "$target" --qnet-loadability-probe </dev/null >/dev/null 2>"$err" &
    pid=$!
    for step in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
        if ! kill -0 "$pid" 2>/dev/null; then running=0; break; fi
        sleep 0.05
    done
    if [ "$running" -eq 1 ]; then
        kill -TERM "$pid" 2>/dev/null || true
        sleep 0.05
        kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
    if grep -Eiq 'library not loaded|dyld:|dyld\[|symbol not found|dependent dylib|code signature invalid|mapped file has no cdhash|bad cpu type' "$err"; then
        warn "loader rejected $target: $(tr '\n' ' ' < "$err" | cut -c 1-500)"
        rm -f "$err"
        return 1
    fi
    rm -f "$err"
    return 0
}

# The makefiles stay as 0.90.34 has them. They name gcc or cc (both Apple clang here), and find
# OpenMP, SuiteSparse, HiGHS and cJSON through `brew --prefix` or a /opt/homebrew path held in a
# make variable; a variable given on make's command line wins over the makefile's own value, so
# each of those is pointed at the libraries build-deps.sh made. The deployment target rides in
# CC, which reaches every compile and link command whatever a makefile does with CFLAGS. So does
# -headerpad_max_install_names: the libraries' install names are already @rpath/<name>, so
# relocation only adds a search path, and without the padding there may be no room for it (there
# was none in rbm_mlmc). A compile-only command has no use for a linker option, hence the -Wno.
#
# BNAsm (bnet) is the one makefile whose flags have to be given whole: it asks for Homebrew's
# gcc-13 and a bare -fopenmp, which Apple clang's driver refuses. That was its only reason for
# gcc: the K&R-style source compiles with clang as it stands. clang takes OpenMP as
# `-Xclang -fopenmp` with libomp linked by name, so bnet now shares the one LLVM OpenMP runtime
# with SuiteSparse instead of loading libgomp beside it. The other flags are the makefile's.
# The search path to the libraries' own folder lets a solver run in the build copy (the
# validation suite's `make check` targets do); relocation removes it from the staged copy.
SOLVER_CC="/usr/bin/clang -mmacosx-version-min=$SOLVER_MIN_MACOS -Wl,-headerpad_max_install_names -Wl,-rpath,$DEPS_PREFIX/lib -Wno-unused-command-line-argument"
SUITESPARSE_INCLUDE="$DEPS_PREFIX/include/suitesparse"
MAKE_ARGS=()
make_args_for() {
    MAKE_ARGS=("CC=$SOLVER_CC")
    case "$1" in
        finite/fBNAfm)
            MAKE_ARGS+=("HOMEBREW_PREFIX=$DEPS_PREFIX" "SUITESPARSE_INC=$SUITESPARSE_INCLUDE" "SUITESPARSE_LIB=$DEPS_PREFIX/lib" "LIBOMP_PREFIX=$DEPS_PREFIX") ;;
        finite/fBNAlp|infinite/BNAlp)
            MAKE_ARGS+=("OMP_PREFIX=$DEPS_PREFIX" "HIGHS_PREFIX=$DEPS_PREFIX") ;;
        finite/fBNAsim|infinite/BNAsim)
            MAKE_ARGS+=("OMP_PREFIX=$DEPS_PREFIX") ;;
        finite/fBNAsm)
            MAKE_ARGS+=("LIBOMP_PATH=$DEPS_PREFIX" "SUITESPARSE_ROOT=$DEPS_PREFIX") ;;
        infinite/BNAmc)
            MAKE_ARGS+=("SS_CFLAGS=-I$SUITESPARSE_INCLUDE" "SS_LDFLAGS=-L$DEPS_PREFIX/lib -lcxsparse" "LIBOMP_PREFIX=$DEPS_PREFIX") ;;
        infinite/BNAmd)
            MAKE_ARGS+=("HB_INC=-I$DEPS_PREFIX/include" "HB_LIB=-L$DEPS_PREFIX/lib" "OMP_DIR=$DEPS_PREFIX" "SUITE_INC=-I$SUITESPARSE_INCLUDE") ;;
        infinite/BNAsm)
            MAKE_ARGS+=(
                "HBINC=$DEPS_PREFIX/include" "HBLIB=$DEPS_PREFIX/lib"
                "CFLAGS=-DANSI_C -DLINUX -O3 -w -Xclang -fopenmp -I$DEPS_PREFIX/include -I$SUITESPARSE_INCLUDE"
                "LDFLAGS=-L$DEPS_PREFIX/lib -lcholmod -lumfpack -lamd -lcolamd -lcamd -lccolamd -lsuitesparseconfig -framework Accelerate -lm -lomp -Wl,-headerpad_max_install_names"
            ) ;;
    esac
}

# ── The stamps ──────────────────────────────────────────────────────────────────────────────
# Every input of a solver binary other than solvers/ itself. The libraries are named by the hash
# of build-deps.sh, which is what build-deps.sh stamps its prefix with (prefix/.built-by): a
# stage linked against libraries from another build-deps.sh does not match. The variables make
# would take from the environment are listed too, since a makefile may read them.
toolchain_stamp() {
    local entry var
    printf 'qnet-solver-stage 1\n'
    printf 'compiler %s\n' "$(/usr/bin/clang --version | head -1)"
    printf 'sdk %s\n' "$(/usr/bin/xcrun --show-sdk-version 2>/dev/null || echo unknown)"
    printf 'minimum-macos %s\n' "$SOLVER_MIN_MACOS"
    printf 'libraries-recipe %s\n' "$(shasum -a 256 "$ROOT/scripts/build-deps.sh" | cut -d' ' -f1)"
    printf 'recipe %s\n' "$(shasum -a 256 "${BASH_SOURCE[0]}" | cut -d' ' -f1)"
    printf 'cc %s\n' "$SOLVER_CC"
    for entry in "${REQUIRED_C_TARGETS[@]}" "${OPTIONAL_C_TARGETS[@]}"; do
        make_args_for "${entry%%:*}"
        printf 'make %s:' "$entry"; printf ' [%s]' "${MAKE_ARGS[@]}"; printf '\n'
    done
    for var in CFLAGS CPPFLAGS LDFLAGS LDLIBS CPATH C_INCLUDE_PATH LIBRARY_PATH SDKROOT MAKEFLAGS; do
        printf 'env %s=%s\n' "$var" "${!var-<unset>}"
    done
}
source_stamp() { (cd "$ROOT/solvers" && find . -type f ! -name '.DS_Store' -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1); }
[ -x /usr/bin/clang ] || die "missing /usr/bin/clang (install the Xcode command line tools)"
case "${1:-}" in
    --stamp) [ "$#" -eq 1 ] || die "--stamp takes nothing else"; toolchain_stamp; exit 0 ;;
    ''|--clean) [ "$#" -le 1 ] || die "usage: scripts/stage-solvers.sh [--clean | --stamp]" ;;
    *) die "usage: scripts/stage-solvers.sh [--clean | --stamp]" ;;
esac
for tool in make otool install_name_tool codesign python3 rsync; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

# ── 0. The libraries (does nothing when they are already built by this build-deps.sh) ───────
"$ROOT/scripts/build-deps.sh"
[ -f "$DEPS/manifest.json" ] && [ -f "$DEPS_PREFIX/.built-by" ] || die "scripts/build-deps.sh left no libraries in $DEPS"
TOOLCHAIN="$(toolchain_stamp)"
SOURCES_NOW="$(source_stamp)"
[ -n "$SOURCES_NOW" ] || die "could not hash solvers/"
if [ "${1:-}" != "--clean" ] && [ -f "$STAGE/TOOLCHAIN_STAMP" ] && [ -f "$STAGE/SOURCE_STAMP" ] \
    && [ "$(cat "$STAGE/TOOLCHAIN_STAMP")" = "$TOOLCHAIN" ] && [ "$(cat "$STAGE/SOURCE_STAMP")" = "$SOURCES_NOW" ]; then
    printf 'The staged solvers are up to date: %s\n(scripts/stage-solvers.sh --clean rebuilds them)\n' "$STAGE"
    exit 0
fi

# ── 1. Build, in a copy outside Dropbox ─────────────────────────────────────────────────────
# --clean removes the build copy, the stage and this script's own logs and stamp: nothing else
# that may live beside them in the cache folder.
if [ "${1:-}" = "--clean" ]; then
    rm -rf "$BUILD" "$STAGE"
    rm -f "$CACHE"/make-*.log "$CACHE/TOOLCHAIN_STAMP"
fi
# Objects made by another compiler or SDK, for another macOS, with other flags, against other
# libraries or by another version of this script are not reused: make would keep them. The stamp
# beside the build copy says what its objects were made with; it is written before make runs, into
# a copy that is either new or was made under the same stamp, so it stays true if make fails.
# (`|| true`: there is no stamp before the first build, and that reads as "different".)
[ "$(cat "$DEPS_PREFIX/.built-by")" = "$(shasum -a 256 "$ROOT/scripts/build-deps.sh" | cut -d' ' -f1)" ] \
    || die "the libraries in $DEPS_PREFIX were not built by this scripts/build-deps.sh"
if [ -d "$BUILD" ] && [ "$(cat "$CACHE/TOOLCHAIN_STAMP" 2>/dev/null || true)" != "$TOOLCHAIN" ]; then
    log "The compiler, its flags, the libraries or this script changed: rebuilding the solvers from scratch"
    rm -rf "$BUILD"
fi
mkdir -p "$BUILD"
printf '%s\n' "$TOOLCHAIN" > "$CACHE/TOOLCHAIN_STAMP"
log "Copying solvers/ to $BUILD"
# --checksum: a source edit always reaches the build copy, whatever the timestamps say. Build
# products in the copy (objects, executables) are kept, so make stays incremental.
rsync -a --checksum "$ROOT/solvers/" "$BUILD/"

# A makefile that still reached Homebrew would say so in its commands.
no_homebrew_in_log() {
    if grep -n -E '(^|[ =])-[IL] ?(/opt/homebrew|/usr/local)|/opt/homebrew/bin/gcc' "$1" >&2; then
        die "$2 was compiled against Homebrew (see $1): scripts/stage-solvers.sh must override that makefile variable"
    fi
}

AVAILABLE_C_TARGETS=()
UNAVAILABLE_RECORDS=()
log "Building native solvers"
for entry in "${REQUIRED_C_TARGETS[@]}"; do
    dir="${entry%%:*}"; bins="${entry#*:}"
    printf '  %s\n' "$dir"
    make_args_for "$dir"
    make -C "$BUILD/$dir" "${MAKE_ARGS[@]}" >"$CACHE/make-${dir//\//-}.log" 2>&1 || { tail -20 "$CACHE/make-${dir//\//-}.log" >&2; die "make failed in $dir (log: $CACHE/make-${dir//\//-}.log)"; }
    no_homebrew_in_log "$CACHE/make-${dir//\//-}.log" "$dir"
    for bin in $bins; do
        [ -x "$BUILD/$dir/$bin" ] || die "$dir/$bin was not produced as an executable"
    done
    AVAILABLE_C_TARGETS+=("$entry")
done
for entry in "${OPTIONAL_C_TARGETS[@]}"; do
    dir="${entry%%:*}"; bins="${entry#*:}"
    printf '  %s (optional)\n' "$dir"
    reason="requires cJSON, SuiteSparse, libomp, and Accelerate; rebuild with those dependencies installed"
    make_args_for "$dir"
    if make -C "$BUILD/$dir" "${MAKE_ARGS[@]}" >"$CACHE/make-${dir//\//-}.log" 2>&1; then
        no_homebrew_in_log "$CACHE/make-${dir//\//-}.log" "$dir"
        complete=1
        for bin in $bins; do [ -x "$BUILD/$dir/$bin" ] || complete=0; done
        if [ "$complete" -eq 1 ]; then AVAILABLE_C_TARGETS+=("$entry"); continue; fi
    fi
    warn "$dir could not be built; the method will be unavailable"
    for bin in $bins; do UNAVAILABLE_RECORDS+=("executable"$'\t'"$dir/$bin"$'\t'"$reason"); done
done

log "Checking the Python solvers parse"
for relative in "${PYTHON_SUPPORT_FILES[@]}"; do
    [ -f "$ROOT/solvers/$relative" ] || die "missing Python support file solvers/$relative"
done
python3 - "$ROOT/solvers" "${PYTHON_SUPPORT_FILES[@]}" <<'PY'
import ast, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
for rel in sys.argv[2:]:
    p = root / rel
    if p.suffix == ".py":
        ast.parse(p.read_text(encoding="utf-8"), filename=str(p))
    else:
        json.loads(p.read_text(encoding="utf-8"))
print(f"  {len(sys.argv) - 2} files parse")
PY

# ── 2. Assemble the stage ───────────────────────────────────────────────────────────────────
log "Assembling $STAGE"
rm -rf "$STAGE"
mkdir -p "$BIN" "$FRAMEWORKS"
for entry in "${AVAILABLE_C_TARGETS[@]}"; do
    dir="${entry%%:*}"; bins="${entry#*:}"
    mkdir -p "$BIN/$dir"
    for bin in $bins; do cp "$BUILD/$dir/$bin" "$BIN/$dir/$bin" || die "could not stage $dir/$bin"; chmod 755 "$BIN/$dir/$bin"; done
done
for relative in "${PYTHON_SUPPORT_FILES[@]}"; do
    mkdir -p "$(dirname "$BIN/$relative")"
    cp "$ROOT/solvers/$relative" "$BIN/$relative"
    chmod 644 "$BIN/$relative"
done

# ── 3. Bring the libraries along (build_app.sh step 4) ──────────────────────────────────────
log "Relocating library dependencies into Frameworks/"
is_system_lib() {
    case "$1" in /usr/lib/*|/System/*|/Library/Apple/*) return 0 ;; esac
    return 1
}
# The LC_RPATH from a file's folder to Frameworks/, as the file will sit in Contents/.
rpath_to_frameworks() {
    local rel="${1#"$STAGE"/}" dir ups="" depth=0
    dir="$(dirname "$rel")"
    [ "$dir" = "." ] && dir=""
    while [ -n "$dir" ]; do
        depth=$((depth + 1))
        case "$dir" in */*) dir="${dir%/*}" ;; *) dir="" ;; esac
    done
    while [ "$depth" -gt 0 ]; do ups="${ups}../"; depth=$((depth - 1)); done
    printf '@loader_path/%sFrameworks' "$ups"
}
find_library() {
    local base="$1" prefix
    # Only the libraries build-deps.sh made. A name that is not there is a library nobody
    # pinned, and the audit below fails on it.
    for prefix in "$DEPS_PREFIX/lib"; do
        if [ -f "$prefix/$base" ]; then printf '%s' "$prefix/$base"; return 0; fi
    done
    return 1
}
# Every step that must succeed says so with `|| die`, and nothing here relies on `set -e`: it
# stops a script without a word (these tools' own messages are discarded), and it is off in any
# function reached from a test or from the left of && or ||.
relocate() {
    local target="$1" line lib base source wanted said absolute libs
    wanted="$(rpath_to_frameworks "$target")"
    # Adding a search path the file already has fails ("would duplicate path"): a library reached
    # from two solvers is relocated once per reference chain, and that failure is expected. Any
    # other message is shown, and the check after it is what decides.
    said="$(install_name_tool -add_rpath "$wanted" "$target" 2>&1)" || true
    said="$(printf '%s\n' "$said" | grep -v -E 'invalidate the code signature|would duplicate path' || true)" # no other message: the good case
    [ -z "$said" ] || printf '%s\n' "$said" >&2
    libs="$(otool -l "$target")" || die "otool could not read ${target#"$STAGE"/}"
    printf '%s\n' "$libs" | grep -q -F "path $wanted " || die "could not give ${target#"$STAGE"/} its search path to Frameworks/"
    # A search path a build leaves behind (Homebrew's libraries carried /opt/homebrew/lib) comes
    # before ours in dyld's order: on a Mac with Homebrew the solver would load that Mac's
    # library instead of the bundled one. 0.90.34 left them in (ledger PKG-008, Changed); 2.0
    # removes every one that is not relative to the file itself, and the audit below fails if
    # one is left.
    absolute="$(printf '%s\n' "$libs" | awk '/LC_RPATH/{r=1} r&&/ path /{print $2; r=0}' | grep -v '^@loader_path/' | sort -u || true)" # none to remove: the good case
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        install_name_tool -delete_rpath "$line" "$target" 2>/dev/null || die "could not remove the search path $line from ${target#"$STAGE"/}"
    done <<< "$absolute"
    libs="$(otool -L "$target")" || die "otool could not list what ${target#"$STAGE"/} links"
    while IFS= read -r line; do
        lib="$(printf '%s\n' "$line" | awk '{print $1}')"
        [ -n "$lib" ] || continue
        if is_system_lib "$lib"; then continue; fi
        base="$(basename "$lib")"
        if [ "$lib" != "@rpath/$base" ]; then
            install_name_tool -change "$lib" "@rpath/$base" "$target" 2>/dev/null || die "could not point ${target#"$STAGE"/} at @rpath/$base (it links $lib)"
        fi
        if [ -f "$FRAMEWORKS/$base" ]; then continue; fi
        # Whatever path the link recorded, the copy comes from the pinned libraries.
        source="$(find_library "$base")" || die "$base, referenced by ${target#"$STAGE"/}, is not one of the libraries scripts/build-deps.sh builds"
        cp -f "$source" "$FRAMEWORKS/$base" || die "could not copy $source into Frameworks/"
        chmod 644 "$FRAMEWORKS/$base" || die "could not set the mode of Frameworks/$base"
        install_name_tool -id "@rpath/$base" "$FRAMEWORKS/$base" 2>/dev/null || die "could not set the install name of Frameworks/$base"
        relocate "$FRAMEWORKS/$base"
    done < <(printf '%s\n' "$libs" | tail -n +2)
}
while IFS= read -r f; do
    if file -b "$f" | grep -q "Mach-O"; then relocate "$f"; fi
done < <(find "$BIN" -type f -perm -u+x)

# ── 4. Sign: libraries first, then the executables that load them ───────────────────────────
log "Signing (ad hoc)"
xattr -cr "$STAGE" || die "could not clear the extended attributes in $STAGE"
for lib in "$FRAMEWORKS"/*.dylib; do codesign --force --sign - "$lib" 2>/dev/null || die "could not sign $lib"; done
while IFS= read -r f; do
    if file -b "$f" | grep -q "Mach-O"; then codesign --force --sign - "$f" 2>/dev/null || die "could not sign $f"; fi
done < <(find "$BIN" -type f -perm -u+x)

# ── 5. The runtime manifest the runner reads (build_app.sh step 3b, same format) ────────────
{
    printf 'QNET_SOLVER_RUNTIME_V1\n'
    for entry in "${AVAILABLE_C_TARGETS[@]}"; do
        dir="${entry%%:*}"; bins="${entry#*:}"
        for bin in $bins; do printf 'available\texecutable\t%s/%s\tload-probed during runtime resolution\n' "$dir" "$bin"; done
    done
    for relative in "${PYTHON_SUPPORT_FILES[@]}"; do
        req="$(python_requirements_for "$relative")"
        if [ -n "$req" ]; then printf 'available\tsupport\t%s\tPython support file; runtime modules: %s\n' "$relative" "$req"
        else printf 'available\tsupport\t%s\tstandard-library support file\n' "$relative"; fi
    done
    if [ "${#UNAVAILABLE_RECORDS[@]}" -gt 0 ]; then
        for r in "${UNAVAILABLE_RECORDS[@]}"; do printf 'unavailable\t%s\n' "$r"; done
    fi
} > "$STAGE/Resources/solver-runtime-status-v1.tsv"
# Where the libraries in Frameworks/ come from, for scripts/notices.mjs --native.
cp "$DEPS/manifest.json" "$STAGE/deps-manifest.json"

# ── 6. Audit ────────────────────────────────────────────────────────────────────────────────
log "Auditing the stage"
problems=0
# Every executable of the independent release inventory is present.
while IFS= read -r rel; do
    case "$rel" in ''|'#'*) continue ;; esac
    [ -x "$BIN/$rel" ] || { warn "missing release executable $rel"; problems=$((problems + 1)); }
done < "$ROOT/validation/required_release_executables.txt"
# Every Mach-O file runs on the minimum macOS (SOLVER_MIN_MACOS), links only the system and Frameworks/, searches
# only relative to itself, is arm64, is signed, and loads.
version_above() { # is $1 a later version than $2?
    [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$1" ]
}
probed=0
highest_minos=""
while IFS= read -r f; do
    file -b "$f" | grep -q "Mach-O" || continue
    name="${f#"$STAGE"/}"
    minos="$(otool -l "$f" | awk '/LC_BUILD_VERSION/{b=1} b&&/minos/{print $2; b=0} /LC_VERSION_MIN_MACOSX/{v=1} v&&/ version /{print $2; v=0}' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
    if [ -z "$minos" ]; then
        warn "$name states no minimum macOS"; problems=$((problems + 1))
    elif version_above "$minos" "$SOLVER_MIN_MACOS"; then
        warn "$name needs macOS $minos; the solvers must run on $SOLVER_MIN_MACOS"; problems=$((problems + 1))
    fi
    if [ -n "$minos" ] && { [ -z "$highest_minos" ] || version_above "$minos" "$highest_minos"; }; then highest_minos="$minos"; fi
    [ "$(lipo -archs "$f" 2>/dev/null)" = "arm64" ] || { warn "$name is not arm64 only: $(lipo -archs "$f" 2>/dev/null)"; problems=$((problems + 1)); }
    while IFS= read -r dep; do
        case "$dep" in
            /usr/lib/*|/System/Library/*) ;;
            @rpath/*)
                [ "$dep" = "@rpath/$(basename "$dep")" ] && [ -f "$FRAMEWORKS/$(basename "$dep")" ] \
                    || { warn "$name links $dep, which is not in Frameworks/"; problems=$((problems + 1)); } ;;
            *) warn "$name links $dep: only the system and Frameworks/ are allowed"; problems=$((problems + 1)) ;;
        esac
    done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
    while IFS= read -r rp; do
        case "$rp" in
            @loader_path/*) ;;
            *) warn "$name searches $rp: only @loader_path-relative search paths are allowed"; problems=$((problems + 1)) ;;
        esac
    done < <(otool -l "$f" | awk '/LC_RPATH/{r=1} r&&/ path /{print $2; r=0}')
    codesign --verify --strict "$f" 2>/dev/null || { warn "signature does not verify: $f"; problems=$((problems + 1)); }
    case "$f" in "$FRAMEWORKS"/*) continue ;; esac
    if loader_probe "$f"; then probed=$((probed + 1)); else problems=$((problems + 1)); fi
done < <(find "$BIN" "$FRAMEWORKS" -type f)
[ "$problems" -eq 0 ] || die "$problems problem(s) in the stage; nothing above is ready to bundle"

executables=$(find "$BIN" -type f -perm -u+x | while read -r f; do file -b "$f" | grep -q Mach-O && echo x; done | wc -l | tr -d ' ')
libraries=$(find "$FRAMEWORKS" -name '*.dylib' | wc -l | tr -d ' ')
python=$(find "$BIN" -type f \( -name '*.py' -o -name '*.json' \) | wc -l | tr -d ' ')
minos="$highest_minos"
printf '\nStaged %s executables (%s load-probed), %s Python solver files and %s libraries.\n' "$executables" "$probed" "$python" "$libraries"
printf 'Highest minimum macOS among them: %s\n' "${minos:-unknown}"
# What the stage was built from and with, so scripts/assemble-bundle.sh can refuse a stale one.
# Both were taken before the build started: a source edited while it ran makes the stage stale.
printf '%s\n' "$TOOLCHAIN" > "$STAGE/TOOLCHAIN_STAMP"
printf '%s\n' "$SOURCES_NOW" > "$STAGE/SOURCE_STAMP"
printf 'Stage: %s\n' "$STAGE"
