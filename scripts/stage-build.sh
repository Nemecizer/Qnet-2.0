#!/bin/sh
# Stages everything a build copies from, outside Dropbox. The repository lives in Dropbox, whose
# file provider refuses the clone-copy macOS uses for same-volume copies (EPERM), so cargo's
# target dir, the generated schemas (src-tauri/gen, a symlink), the icons and the front-end
# bundle all live under ~/Library/Caches/qnet and tauri.conf.json points there (from NetMon).
# The solvers are staged separately (scripts/stage-solvers.sh) and join the bundle in P8.
set -eu
cd "$(dirname "$0")/.."
sh scripts/cargo-config.sh
cache="$HOME/Library/Caches/qnet"
mkdir -p "$cache/icons" "$cache/gen" "$cache/dist"
# src-tauri/gen is written by tauri-build on every run: keep it out of Dropbox.
if [ ! -L src-tauri/gen ]; then rm -rf src-tauri/gen; ln -s "$cache/gen" src-tauri/gen; fi
# The icons, as the bundler copies them from here.
cp src-tauri/icons/32x32.png src-tauri/icons/128x128.png src-tauri/icons/128x128@2x.png src-tauri/icons/icon.icns src-tauri/icons/icon.png "$cache/icons/"
echo "staged: $cache (icons, gen); front end builds into $cache/dist"
