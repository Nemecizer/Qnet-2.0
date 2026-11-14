#!/bin/sh
# Writes .cargo/config.toml when it is missing: cargo's target folder must be outside Dropbox
# (hard links fail there, and gigabytes of artifacts would sync), and a cargo configuration can
# only name it by an absolute path, which is this Mac's own. So the file is made here, not tracked.
cd "$(dirname "$0")/.." || exit 1
[ -f .cargo/config.toml ] && exit 0
mkdir -p .cargo
{
  echo '# Made by scripts/cargo-config.sh; not tracked. Override with CARGO_TARGET_DIR when needed.'
  echo '[build]'
  echo "target-dir = \"$HOME/Library/Caches/qnet/target\""
} > .cargo/config.toml
