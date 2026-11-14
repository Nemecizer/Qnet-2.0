#!/bin/sh
# Build an identified candidate without replacing or launching an existing app (from NetMon).
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

die() { printf '%s\n' "$*" >&2; exit 1; }
if [ "${1:-}" = "--help" ]; then
    printf '%s\n' 'Usage: scripts/build-candidate.sh <what-is-being-tested>' \
        'Builds ../Qnet-builds/YYYY-MM-DD-HH-MM-<what-is-being-tested>/Qnet.app (solvers, libraries,' \
        'examples and licences inside), a ZIP with its checksum and PROVENANCE.json,' \
        'e.g. scripts/build-candidate.sh testing-empty-workspace → 2026-11-10-17-57-testing-empty-workspace.' \
        'Requires a clean tree. Signs with an Apple identity when there is one, else ad hoc.' \
        'Never overwrites a candidate or launches Qnet. Reuses the Cargo build cache.'
    exit 0
fi
[ "$#" -eq 1 ] || die 'Pass one title saying what the build tests, e.g. testing-empty-workspace.'
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die 'This packaging procedure targets Apple Silicon macOS.'
[ -z "$(git status --porcelain)" ] || die 'Commit the source first; the candidate requires a clean Git tree.'
[ -d node_modules ] || die 'Install the locked frontend dependencies with npm ci first.'
python3 -c 'import sys; assert sys.version_info >= (3, 12), "Use Python 3.12 or newer on PATH"'

# Automatic updates (docs/UPDATES.md): off, and this block idle, unless both variables are set.
# Then the candidate also gets update/ (the signed archive and latest.json), which needs the
# owner's private signing key: asked for here, before an hour of building, never stored.
if [ -n "${QNET_UPDATE_ENDPOINT:-}${QNET_UPDATE_PUBKEY:-}" ]; then
    [ -n "${QNET_UPDATE_ENDPOINT:-}" ] && [ -n "${QNET_UPDATE_PUBKEY:-}" ] || die 'Set both QNET_UPDATE_ENDPOINT and QNET_UPDATE_PUBKEY, or neither (docs/UPDATES.md).'
    [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}${TAURI_SIGNING_PRIVATE_KEY:-}" ] || die 'Updates are switched on but there is no signing key: set TAURI_SIGNING_PRIVATE_KEY_PATH (docs/UPDATES.md).'
    export QNET_UPDATE_ENDPOINT QNET_UPDATE_PUBKEY
fi

candidate_commit=$(git rev-parse HEAD)
candidate_short=$(git rev-parse --short HEAD)
candidate_title=$(printf '%s' "$1" | tr 'A-Z ' 'a-z-')
case "$candidate_title" in
    ''|*[!a-z0-9-]*) die 'Use a title of letters, numbers and hyphens, e.g. testing-empty-workspace.' ;;
esac
candidate_name="$(date +%Y-%m-%d-%H-%M)-$candidate_title"

mkdir -p "$PWD/../Qnet-builds"
candidate_dir="$(cd "$PWD/../Qnet-builds" && pwd -P)/$candidate_name"
[ ! -e "$candidate_dir" ] && [ ! -L "$candidate_dir" ] || die "Already exists: $candidate_dir (choose a new folder name)."
APPLE_SIGNING_IDENTITY=$(scripts/sign-identity.sh)
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    export APPLE_SIGNING_IDENTITY
else
    unset APPLE_SIGNING_IDENTITY
    printf '%s\n' 'No Apple signing identity: building with an ad-hoc signature.' >&2
fi
CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$HOME/Library/Caches/qnet/target}
case "$CARGO_TARGET_DIR" in /*) ;; *) CARGO_TARGET_DIR="$PWD/$CARGO_TARGET_DIR" ;; esac
export CARGO_BUILD_JOBS CARGO_TARGET_DIR

mkdir "$candidate_dir"
mkdir "$candidate_dir/evidence"
# Until the last check has passed the folder says so itself: a build that stops half way must not
# leave something that looks like a candidate.
printf '%s\n' 'This candidate did not finish building. Do not use it; see evidence/.' > "$candidate_dir/INCOMPLETE.txt"
candidate_stage=$(mktemp -d "${TMPDIR:-/tmp}/qnet-bundle.XXXXXX")
trap 'rm -rf "$candidate_stage"' 0
trap 'exit 130' INT
trap 'exit 143' HUP TERM
printf 'Staging the solvers; log: %s/evidence/solvers.log\n' "$candidate_dir"
if ! { bash scripts/build-deps.sh && bash scripts/stage-python.sh; } > "$candidate_dir/evidence/libraries.log" 2>&1; then
    die "Building Qnet's own libraries or Python failed; inspect $candidate_dir/evidence/libraries.log."
fi
if ! bash scripts/stage-solvers.sh > "$candidate_dir/evidence/solvers.log" 2>&1; then
    die "Building the solvers failed; inspect $candidate_dir/evidence/solvers.log."
fi
printf 'Building %s; log: %s/evidence/build.log\n' "$candidate_short" "$candidate_dir"
if ! npm run build:app -- --no-bundle > "$candidate_dir/evidence/build.log" 2>&1; then
    die "Build failed; inspect $candidate_dir/evidence/build.log. Partial output is retained."
fi
[ "$(git rev-parse HEAD)" = "$candidate_commit" ] && [ -z "$(git status --porcelain)" ] || die 'Source changed during the build; no candidate was packaged.'
# The same path remapping as scripts/build-app.sh, so the tool carries no build-machine path either.
[ -n "${QNET_REMAPPED:-}" ] || export QNET_REMAPPED=1 RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME/.cargo=/cargo --remap-path-prefix=$HOME/.rustup=/rustup --remap-path-prefix=$HOME=/build"
if ! cargo build --release -p qnet-cli >> "$candidate_dir/evidence/build.log" 2>&1; then
    die "Building qnet-cli failed; inspect $candidate_dir/evidence/build.log."
fi
mkdir "$candidate_stage/release"
cp "$CARGO_TARGET_DIR/release/qnet" "$candidate_stage/release/qnet"
if ! CARGO_TARGET_DIR="$candidate_stage" npx tauri bundle --bundles app --ci > "$candidate_dir/evidence/package.log" 2>&1; then
    die "Packaging failed; inspect $candidate_dir/evidence/package.log."
fi
cp "$CARGO_TARGET_DIR/release/qnet-cli" "$candidate_stage/release/bundle/macos/Qnet.app/Contents/MacOS/qnet-cli"
# The solvers, their libraries, the examples and the licences; signed in order (libraries, solver
# executables, app; ad hoc without an Apple identity), then checked to stand on its own and audited.
if ! scripts/assemble-bundle.sh "$candidate_stage/release/bundle/macos/Qnet.app" "${APPLE_SIGNING_IDENTITY:--}" > "$candidate_dir/evidence/assemble.log" 2>&1; then
    die "Assembling the bundle failed; inspect $candidate_dir/evidence/assemble.log."
fi
codesign --verify --deep --strict "$candidate_stage/release/bundle/macos/Qnet.app"
ditto "$candidate_stage/release/bundle/macos/Qnet.app" "$candidate_dir/Qnet.app"
codesign --verify --deep --strict "$candidate_dir/Qnet.app"
ditto -c -k --sequesterRsrc --keepParent "$candidate_dir/Qnet.app" "$candidate_dir/Qnet-$candidate_short.zip"
mkdir "$candidate_stage/extracted"
ditto -x -k "$candidate_dir/Qnet-$candidate_short.zip" "$candidate_stage/extracted"
codesign --verify --deep --strict "$candidate_stage/extracted/Qnet.app"
[ "$(git rev-parse HEAD)" = "$candidate_commit" ] && [ -z "$(git status --porcelain)" ] || die 'Source changed during packaging; do not distribute this candidate.'
python3 scripts/candidate-provenance.py "$candidate_dir" "$candidate_stage/extracted"
(cd "$candidate_dir" && shasum -a 256 "Qnet-$candidate_short.zip" > "Qnet-$candidate_short.zip.sha256")
if [ -n "${QNET_UPDATE_ENDPOINT:-}" ]; then
    # Re-run this by hand after scripts/notarize.sh, so the archive holds the stapled app.
    scripts/update-artifact.sh "$candidate_dir" > "$candidate_dir/evidence/update.log" 2>&1 || die "Making the update archive failed; inspect $candidate_dir/evidence/update.log."
fi
rm "$candidate_dir/INCOMPLETE.txt"
printf 'Built and verified: %s/Qnet.app\nQnet was not launched.\n' "$candidate_dir"
