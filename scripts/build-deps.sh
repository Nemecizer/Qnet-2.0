#!/usr/bin/env bash
# Builds the libraries the solvers link, from pinned upstream sources, for macOS 14 and later.
#
#   ~/Library/Caches/qnet/deps/
#     downloads/       the release archives, each checked against the sha256 recorded below
#     src/<key>/       the unpacked sources (one folder per archive)
#     build/<key>/     cmake's build trees
#     prefix/          include/ and lib/: what scripts/stage-solvers.sh compiles and links against
#     licenses/<key>/  the licence texts, copied out of the sources (scripts/notices.mjs --native)
#     manifest.json    name, version, URL, sha256 and licence of everything fetched, and the
#                      libraries built from it
#
# Nothing comes from Homebrew except the cmake program itself: the compiler is Apple clang, BLAS
# and LAPACK are Apple's Accelerate, and cmake is told to ignore /opt/homebrew and /usr/local.
# Every library is an arm64 dylib with install name @rpath/<name> and deployment target 14.0.
# Nothing is installed outside ~/Library/Caches/qnet/deps.
#
# Usage: scripts/build-deps.sh [--clean]
#   No option: does nothing when prefix/ was built by this version of this script.
#   --clean:   rebuilds from the downloaded archives (which are kept, and re-verified).
set -euo pipefail

DEPS="${QNET_DEPS_DIR:-$HOME/Library/Caches/qnet/deps}"
MIN_MACOS="14.0"
ARCH="arm64"

# ── The pinned sources ──────────────────────────────────────────────────────────────────────
# key | name | version | URL | sha256 | SPDX licence of what is built from it
# The versions are the ones Qnet bundled from Homebrew before this script existed, and the
# archives and checksums are the ones Homebrew's formulae name; LLVM's is also the digest GitHub
# publishes for the release asset.
SOURCES=(
"libomp|LLVM OpenMP runtime (libomp)|23.1.5|https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.5/llvm-project-23.1.5.src.tar.xz|fb50b1eac93ddeb3aa8dab4cfe324dff74f4a9c2bdee6160c9e36188f8d06a6e|Apache-2.0 WITH LLVM-exception"
"suite-sparse|SuiteSparse|7.14.1|https://github.com/DrTimothyAldenDavis/SuiteSparse/archive/refs/tags/v7.14.1.tar.gz|81e560e1f74546df139edb765b3f5bc865866da23062312ffe8fd821063c8397|BSD-3-Clause AND LGPL-2.1-or-later AND GPL-2.0-or-later AND Apache-2.0"
"highs|HiGHS|1.16.0|https://github.com/ERGO-Code/HiGHS/releases/download/v1.16.0/source-archive.tar.gz|05ba0a408e31fe933e4ee4ec9d0e244a0e3c5bd2613e7b138701f62708eceed9|MIT"
"cjson|cJSON|1.7.19|https://github.com/DaveGamble/cJSON/archive/refs/tags/v1.7.19.tar.gz|7fa616e3046edfa7a28a32d5f9eacfd23f92900fe1f8ccd988c1662f30454562|MIT"
)
# The SuiteSparse packages the solvers link (CHOLMOD and UMFPACK need the four orderings).
SUITESPARSE_PROJECTS="suitesparse_config;amd;camd;colamd;ccolamd;cholmod;umfpack;cxsparse"

log()  { printf '\n==> %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
field() { printf '%s' "$1" | cut -d'|' -f"$2"; }
source_for() { local s; for s in "${SOURCES[@]}"; do [ "$(field "$s" 1)" = "$1" ] && { printf '%s' "$s"; return; }; done; die "no source $1"; }

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "$ARCH" ] || die "this script builds on an Apple silicon Mac"
CMAKE="$(command -v cmake || true)"
[ -n "$CMAKE" ] || die "cmake is needed to build the libraries (it is a build tool only; nothing of it is shipped)"
for tool in /usr/bin/clang /usr/bin/clang++ /usr/bin/curl /usr/bin/shasum /usr/bin/tar /usr/bin/python3 /usr/bin/otool; do
    [ -x "$tool" ] || die "missing $tool (install the Xcode command line tools)"
done
SDK="$(/usr/bin/xcrun --show-sdk-path)"

SELF="${BASH_SOURCE[0]}"
RECIPE="$(/usr/bin/shasum -a 256 "$SELF" | cut -d' ' -f1)"
STAMP="$DEPS/prefix/.built-by"
PREFIX="$DEPS/prefix"

if [ "${1:-}" = "--clean" ]; then
    rm -rf "$DEPS/src" "$DEPS/build" "$DEPS/prefix" "$DEPS/licenses" "$DEPS/manifest.json"
elif [ -n "${1:-}" ]; then
    die "usage: scripts/build-deps.sh [--clean]"
fi
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$RECIPE" ] && [ -f "$DEPS/manifest.json" ]; then
    printf 'Solver libraries are up to date: %s\n' "$PREFIX"
    exit 0
fi
# A prefix from another version of this script, or half a build: start over (downloads are kept).
rm -rf "$DEPS/src" "$DEPS/build" "$DEPS/prefix" "$DEPS/licenses" "$DEPS/manifest.json"
mkdir -p "$DEPS/downloads" "$DEPS/src" "$DEPS/build" "$PREFIX" "$DEPS/licenses"

# The build sees the system and nothing else: no Homebrew compiler wrappers, pkg-config or paths.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH PKG_CONFIG_PATH CFLAGS CXXFLAGS LDFLAGS CPPFLAGS CC CXX MACOSX_DEPLOYMENT_TARGET SDKROOT
export ZERO_AR_DATE=1
JOBS="$(/usr/sbin/sysctl -n hw.ncpu)"

# ── 1. Fetch and verify ─────────────────────────────────────────────────────────────────────
archive_of() { printf '%s/downloads/%s-%s-%s' "$DEPS" "$(field "$1" 1)" "$(field "$1" 3)" "$(basename "$(field "$1" 4)")"; }
log "Fetching the pinned sources"
for s in "${SOURCES[@]}"; do
    file="$(archive_of "$s")"; url="$(field "$s" 4)"; want="$(field "$s" 5)"
    if [ ! -f "$file" ] || [ "$(/usr/bin/shasum -a 256 "$file" | cut -d' ' -f1)" != "$want" ]; then
        printf '  %s\n' "$url"
        rm -f "$file" "$file.part"
        /usr/bin/curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 -A "qnet-build-deps" -o "$file.part" "$url" \
            || die "could not download $url"
        mv "$file.part" "$file"
    fi
    have="$(/usr/bin/shasum -a 256 "$file" | cut -d' ' -f1)"
    [ "$have" = "$want" ] || die "$(basename "$file") has sha256 $have; this script records $want. Nothing was built from it."
    printf '  verified %s %s\n' "$(field "$s" 2)" "$(field "$s" 3)"
done

# ── 2. Unpack, each archive into its own folder ─────────────────────────────────────────────
log "Unpacking"
unpack() { # key, then the members to take (none: all)
    local key="$1" s; shift
    s="$(source_for "$key")"
    mkdir -p "$DEPS/src/$key"
    /usr/bin/tar -xf "$(archive_of "$s")" -C "$DEPS/src/$key" --strip-components 1 "$@"
}
# Of LLVM, only what the OpenMP runtime's build reads.
L="llvm-project-23.1.5.src"
unpack libomp "$L/openmp" "$L/runtimes" "$L/cmake" "$L/llvm/cmake" "$L/llvm/utils/llvm-lit" "$L/llvm/utils/lit" "$L/third-party/unittest"
unpack suite-sparse
unpack cjson
# HiGHS's release archive has no top folder.
mkdir -p "$DEPS/src/highs"
/usr/bin/tar -xf "$(archive_of "$(source_for highs)")" -C "$DEPS/src/highs"
if [ ! -f "$DEPS/src/highs/CMakeLists.txt" ]; then
    inner="$(find "$DEPS/src/highs" -maxdepth 2 -name CMakeLists.txt | head -1)"
    [ -n "$inner" ] || die "HiGHS's archive has no CMakeLists.txt"
    HIGHS_SRC="$(dirname "$inner")"
else
    HIGHS_SRC="$DEPS/src/highs"
fi

# ── 3. Build ────────────────────────────────────────────────────────────────────────────────
# -ffile-prefix-map keeps this Mac's folder names out of the libraries.
#
# -Os, not cmake's -O3 for a Release build, and this is deliberate: it is the level Homebrew's
# bottles were compiled at, which is what 0.90.34 shipped and the golden corpus was recorded
# with. It matters for HiGHS. The finite-buffer LPs have objective 0 and many optimal vertices,
# and which one HiGHS returns follows its floating-point path: HiGHS 1.16.0 at -O3 moved 14 of
# the 15 finite LP golden results in the displayed digits (Tandem2.MM1.K5.fin sojourn_1 2.776 ->
# 2.905), and at -Os it reproduces Homebrew's library exactly. The other libraries get the same
# level so that the whole set is built as the set it replaces was.
OPT="-Os -DNDEBUG"
MAP="-ffile-prefix-map=$DEPS/src=src -ffile-prefix-map=$DEPS/build=build"
COMMON=(
    -DCMAKE_BUILD_TYPE=Release
    -DCMAKE_C_COMPILER=/usr/bin/clang
    -DCMAKE_CXX_COMPILER=/usr/bin/clang++
    -DCMAKE_OSX_ARCHITECTURES="$ARCH"
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_MACOS"
    -DCMAKE_OSX_SYSROOT="$SDK"
    -DCMAKE_INSTALL_PREFIX="$PREFIX"
    -DCMAKE_INSTALL_LIBDIR=lib
    -DCMAKE_INSTALL_NAME_DIR=@rpath
    -DCMAKE_BUILD_WITH_INSTALL_NAME_DIR=ON
    -DCMAKE_SKIP_RPATH=ON
    -DCMAKE_POLICY_DEFAULT_CMP0068=NEW
    -DCMAKE_PREFIX_PATH="$PREFIX"
    "-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local;/opt/local"
    -DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF
    -DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF
    -DCMAKE_FIND_FRAMEWORK=LAST
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5
    "-DCMAKE_C_FLAGS=$MAP"
    "-DCMAKE_CXX_FLAGS=$MAP"
    "-DCMAKE_C_FLAGS_RELEASE=$OPT"
    "-DCMAKE_CXX_FLAGS_RELEASE=$OPT"
    -DBUILD_SHARED_LIBS=ON
)
build() { # key, source folder, then cmake options
    local key="$1" src="$2"; shift 2
    log "Building $(field "$(source_for "$key")" 2) $(field "$(source_for "$key")" 3)"
    local out="$DEPS/build/$key" logf="$DEPS/build/$key.log"
    { "$CMAKE" -S "$src" -B "$out" "${COMMON[@]}" "$@" \
        && "$CMAKE" --build "$out" --parallel "$JOBS" \
        && "$CMAKE" --install "$out"; } >"$logf" 2>&1 \
        || { tail -40 "$logf" >&2; die "building $key failed (log: $logf)"; }
}

# LLVM OpenMP first: SuiteSparse links it. No libgomp alias, no tools, no offloading, no Fortran
# module; the one runtime every solver and library shares.
build libomp "$DEPS/src/libomp/runtimes" \
    -DLLVM_ENABLE_RUNTIMES=openmp \
    -DLIBOMP_INSTALL_ALIASES=OFF \
    -DOPENMP_ENABLE_OMPT_TOOLS=OFF \
    -DOPENMP_ENABLE_LIBOMPTARGET=OFF \
    -DLIBOMP_FORTRAN_MODULES=OFF \
    -DLLVM_INCLUDE_TESTS=OFF \
    -DOPENMP_STANDALONE_BUILD=OFF
[ -f "$PREFIX/lib/libomp.dylib" ] && [ -f "$PREFIX/include/omp.h" ] || die "libomp.dylib or omp.h was not installed"

# SuiteSparse: Accelerate for BLAS and LAPACK (32-bit integers), the OpenMP just built, no
# Fortran (so no libgfortran), no CUDA, shared libraries only.
build suite-sparse "$DEPS/src/suite-sparse" \
    "-DSUITESPARSE_ENABLE_PROJECTS=$SUITESPARSE_PROJECTS" \
    -DBUILD_STATIC_LIBS=OFF \
    -DBLA_VENDOR=Apple \
    -DSUITESPARSE_USE_64BIT_BLAS=OFF \
    -DSUITESPARSE_USE_FORTRAN=OFF \
    -DSUITESPARSE_USE_CUDA=OFF \
    -DSUITESPARSE_USE_OPENMP=ON \
    -DSUITESPARSE_USE_STRICT=ON \
    -DSUITESPARSE_DEMOS=OFF \
    -DBUILD_TESTING=OFF \
    "-DOpenMP_C_FLAGS=-Xclang -fopenmp -I$PREFIX/include" \
    "-DOpenMP_CXX_FLAGS=-Xclang -fopenmp -I$PREFIX/include" \
    -DOpenMP_C_LIB_NAMES=omp \
    -DOpenMP_CXX_LIB_NAMES=omp \
    "-DOpenMP_omp_LIBRARY=$PREFIX/lib/libomp.dylib"

# HiGHS as it is released: its own simplex, interior-point and MIP code, zlib from the system.
# It also builds libhighs_extras (for the optional HiPO solver, which is off); libhighs does not
# link it and no solver loads it, so it is never staged.
build highs "$HIGHS_SRC" \
    -DBUILD_TESTING=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DBUILD_CXX_EXE=OFF \
    -DHIGHS_NO_DEFAULT_THREADS=OFF

build cjson "$DEPS/src/cjson" \
    -DENABLE_CJSON_TEST=OFF \
    -DENABLE_CJSON_UTILS=OFF \
    -DBUILD_SHARED_AND_STATIC_LIBS=OFF \
    -DENABLE_CUSTOM_COMPILER_FLAGS=OFF

# ── 4. Check what was built ─────────────────────────────────────────────────────────────────
log "Checking the libraries"
bad=0
libs=()
while IFS= read -r f; do
    [ -L "$f" ] && continue
    libs+=("$f")
    base="$(basename "$f")"
    minos="$(/usr/bin/otool -l "$f" | awk '/LC_BUILD_VERSION/{b=1} b&&/minos/{print $2; b=0}')"
    [ "$minos" = "$MIN_MACOS" ] || { printf '  ! %s is built for macOS %s, not %s\n' "$base" "$minos" "$MIN_MACOS" >&2; bad=1; }
    /usr/bin/lipo -archs "$f" | grep -qx "$ARCH" || { printf '  ! %s is not %s only\n' "$base" "$ARCH" >&2; bad=1; }
    case "$(/usr/bin/otool -D "$f" | tail -1)" in @rpath/*) ;; *) printf '  ! %s has install name %s\n' "$base" "$(/usr/bin/otool -D "$f" | tail -1)" >&2; bad=1 ;; esac
    while IFS= read -r dep; do
        case "$dep" in /usr/lib/*|/System/Library/*|@rpath/*) ;; *) printf '  ! %s links %s\n' "$base" "$dep" >&2; bad=1 ;; esac
    done < <(/usr/bin/otool -L "$f" | tail -n +2 | awk '{print $1}')
    # No search path of its own: whoever stages a library says where its neighbours are.
    rpaths="$(/usr/bin/otool -l "$f" | awk '/LC_RPATH/{r=1} r&&/ path /{print $2; r=0}' | tr '\n' ' ')"
    [ -z "$rpaths" ] || { printf '  ! %s carries search paths: %s\n' "$base" "$rpaths" >&2; bad=1; }
done < <(find "$PREFIX/lib" -maxdepth 1 -name '*.dylib' | sort)
[ "${#libs[@]}" -gt 0 ] || die "no library was built"
for want in libomp libsuitesparseconfig libamd libcamd libcolamd libccolamd libcholmod libumfpack libcxsparse libhighs libcjson; do
    ls "$PREFIX/lib/$want".*dylib >/dev/null 2>&1 || { printf '  ! %s was not built\n' "$want" >&2; bad=1; }
done
[ "$bad" -eq 0 ] || die "the libraries above are not fit to ship"
printf '  %s libraries, each %s, macOS %s, linking only the system and each other\n' "${#libs[@]}" "$ARCH" "$MIN_MACOS"

# ── 5. Licence texts, from the sources ──────────────────────────────────────────────────────
log "Collecting licence texts"
lic() { # key, file in the sources, name to keep it under
    mkdir -p "$DEPS/licenses/$1"
    [ -f "$2" ] || die "licence text not found in the sources: $2"
    cp "$2" "$DEPS/licenses/$1/$3"
}
lic libomp       "$DEPS/src/libomp/openmp/LICENSE.TXT"            LICENSE.TXT
lic suite-sparse "$DEPS/src/suite-sparse/LICENSE.txt"             LICENSE.txt
# SuiteSparse's LICENSE.txt names the GPL 2 and the LGPL 2.1; these are the copies it ships.
lic suite-sparse "$DEPS/src/suite-sparse/UMFPACK/Doc/gpl.txt"     GPL-2.0.txt
lic suite-sparse "$DEPS/src/suite-sparse/CXSparse/Doc/lesser.txt" LGPL-2.1.txt
lic highs        "$HIGHS_SRC/LICENSE.txt"                         LICENSE.txt
lic cjson        "$DEPS/src/cjson/LICENSE"                        LICENSE

# ── 6. The manifest ─────────────────────────────────────────────────────────────────────────
/usr/bin/python3 -I - "$DEPS" "$MIN_MACOS" "$ARCH" "$("$CMAKE" --version | head -1)" "$(/usr/bin/clang --version | head -1)" "$(/usr/bin/xcrun --show-sdk-version)" "${SOURCES[@]}" <<'PY'
import hashlib, json, os, subprocess, sys
deps, minos, arch, cmake, clang, sdk, *sources = sys.argv[1:]
lib = os.path.join(deps, "prefix", "lib")
OWNER = [("libomp", "libomp"), ("libhighs", "highs"), ("libcjson", "cjson")]
def owner(name):
    for prefix, key in OWNER:
        if name.startswith((prefix + ".", prefix + "_")):
            return key
    return "suite-sparse"
def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()
built = {}
for name in sorted(os.listdir(lib)):
    path = os.path.join(lib, name)
    if not name.endswith(".dylib") or os.path.islink(path):
        continue
    # The name the solvers load it by (libamd.3.dylib for libamd.3.3.4.dylib).
    install = subprocess.run(["/usr/bin/otool", "-D", path], capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1]
    built.setdefault(owner(name), []).append({"file": name, "loaded_as": os.path.basename(install)})
components = []
for s in sources:
    key, name, version, url, digest, licence = s.split("|")
    folder = os.path.join(deps, "licenses", key)
    components.append({
        "key": key, "name": name, "version": version, "url": url, "sha256": digest, "licence": licence,
        "licence_files": {f: sha(os.path.join(folder, f)) for f in sorted(os.listdir(folder))},
        "libraries": built.get(key, []),
    })
manifest = {
    "note": "Written by scripts/build-deps.sh. The libraries the solvers link, built from these sources.",
    "target": {"arch": arch, "minimum_macos": minos},
    "built_with": {"compiler": clang, "cmake": cmake, "sdk": sdk, "optimisation": "-Os", "blas_lapack": "Apple Accelerate (system framework, not redistributed)"},
    "components": components,
}
with open(os.path.join(deps, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY

printf '%s\n' "$RECIPE" > "$STAMP"
printf '\nBuilt %s libraries for macOS %s and later.\nPrefix:   %s\nManifest: %s\n' "${#libs[@]}" "$MIN_MACOS" "$PREFIX" "$DEPS/manifest.json"
