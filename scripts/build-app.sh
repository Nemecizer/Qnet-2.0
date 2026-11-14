#!/bin/sh
# Builds the whole Qnet.app in ~/Library/Caches/qnet/target/release/bundle/macos: the Tauri app,
# then the solvers, libraries, examples and licences (scripts/assemble-bundle.sh). Signed with your
# Apple certificate when there is one (see sign-identity.sh), else ad hoc. `--no-bundle` (used by
# build-candidate.sh) only compiles. For a build to hand over, use scripts/build-candidate.sh.
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/Library/Caches/qnet/target}"
identity="$(scripts/sign-identity.sh)"
if [ -n "$identity" ]; then
  echo "Signing with: $identity"
  export APPLE_SIGNING_IDENTITY="$identity"
else
  echo "No Apple Development certificate found; building with an ad-hoc signature."
fi
# Automatic updates are off unless both variables are set (docs/UPDATES.md): the app is then compiled
# able to check that address and to accept only downloads signed with that key. Unset, as always
# until Qnet is distributed publicly, this block does nothing and the app contacts no update server.
if [ -n "${QNET_UPDATE_ENDPOINT:-}${QNET_UPDATE_PUBKEY:-}" ]; then
  [ -n "${QNET_UPDATE_ENDPOINT:-}" ] && [ -n "${QNET_UPDATE_PUBKEY:-}" ] || { echo "Set both QNET_UPDATE_ENDPOINT and QNET_UPDATE_PUBKEY, or neither (docs/UPDATES.md)."; exit 1; }
  case "$QNET_UPDATE_ENDPOINT" in https://*) ;; *) echo "QNET_UPDATE_ENDPOINT must be an https:// address (docs/UPDATES.md)."; exit 1 ;; esac
  export QNET_UPDATE_ENDPOINT QNET_UPDATE_PUBKEY
  echo "Automatic updates: ON, checking $QNET_UPDATE_ENDPOINT"
fi
# Nothing of the build machine goes into the binary. rustc records the full path of every source
# file it compiles (panic messages), which would put this Mac's home folder in the app hundreds of
# times: those are remapped. And Tauri embeds its configuration, whose build folders are absolute
# paths under ~/Library/Caches: for the build they are given relative to src-tauri instead.
[ -n "${QNET_REMAPPED:-}" ] || export QNET_REMAPPED=1 RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME/.cargo=/cargo --remap-path-prefix=$HOME/.rustup=/rustup --remap-path-prefix=$HOME=/build"
override="$(python3 -I - "$PWD/src-tauri" <<'PY'
import json, os, sys
src = os.path.realpath(sys.argv[1])
conf = json.load(open(os.path.join(src, "tauri.conf.json")))
rel = lambda p: os.path.relpath(os.path.realpath(p), src) if os.path.isabs(p) else p
print(json.dumps({"build": {"frontendDist": rel(conf["build"]["frontendDist"])}, "bundle": {"icon": [rel(p) for p in conf["bundle"]["icon"]]}}))
PY
)" || exit 1
npx tauri build --bundles app --config "$override" "$@" || exit 1
case " $* " in *" --no-bundle "*) exit 0 ;; esac
cargo build --release -p qnet-cli || exit 1
cp "$CARGO_TARGET_DIR/release/qnet-cli" "$CARGO_TARGET_DIR/release/bundle/macos/Qnet.app/Contents/MacOS/qnet-cli"
# Qnet's own libraries (built once, for macOS 14) and its own Python come first; both are no-ops
# when already made.
bash scripts/build-deps.sh > "$CARGO_TARGET_DIR/build-deps.log" 2>&1 || { echo "Building the libraries failed; see $CARGO_TARGET_DIR/build-deps.log"; exit 1; }
bash scripts/stage-python.sh > "$CARGO_TARGET_DIR/stage-python.log" 2>&1 || { echo "Staging Python failed; see $CARGO_TARGET_DIR/stage-python.log"; exit 1; }
bash scripts/stage-solvers.sh > "$CARGO_TARGET_DIR/stage-solvers.log" 2>&1 || { echo "Building the solvers failed; see $CARGO_TARGET_DIR/stage-solvers.log"; exit 1; }
exec scripts/assemble-bundle.sh "$CARGO_TARGET_DIR/release/bundle/macos/Qnet.app" "${identity:--}"
