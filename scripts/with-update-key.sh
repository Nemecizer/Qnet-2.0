#!/usr/bin/env bash
# Runs one command with automatic updates switched on for the published releases (docs/UPDATES.md):
#
#   scripts/with-update-key.sh scripts/build-candidate.sh qnet-2-1-2-release
#   scripts/with-update-key.sh scripts/update-artifact.sh ../Qnet-builds/<candidate folder>
#
# It sets, for that command only:
#   QNET_UPDATE_ENDPOINT      the latest.json of the newest GitHub release of the public repository
#   QNET_UPDATE_PUBKEY        the public key, from ~/.qnet-keys/qnet-update.key.pub
#   QNET_UPDATE_DOWNLOAD_URL  the archive in this version's release (the version from tauri.conf.json)
#   TAURI_SIGNING_PRIVATE_KEY_PATH, TAURI_SIGNING_PRIVATE_KEY_PASSWORD
# The password is read from the login keychain (item "qnet-update-key"), which the owner put there
# once; it is never printed, written to a file or kept after the command ends. Nothing in the
# repository holds the key, its password or the endpoint; without this wrapper every build has
# updates off, as before. The owner's one-time set-up is in docs/UPDATES.md.
set -euo pipefail
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ "$#" -ge 1 ] || die "usage: scripts/with-update-key.sh <command> [arguments…]"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

REPO="${QNET_UPDATE_REPO:-Nemecizer/Qnet-2.0}"
KEY="${QNET_UPDATE_KEY:-$HOME/.qnet-keys/qnet-update.key}"
[ -f "$KEY" ] || die "no private key at $KEY: make it first (docs/UPDATES.md, step 1)"
[ -f "$KEY.pub" ] || die "no public key at $KEY.pub"
case "$(cd "$(dirname "$KEY")" && pwd -P)/" in "$ROOT"/*) die "the private key is inside the repository; move it out first" ;; esac
password="$(security find-generic-password -s qnet-update-key -a "$USER" -w 2>/dev/null)" \
    || die 'no keychain item "qnet-update-key": add the key'"'"'s password once (docs/UPDATES.md, step 1)'
version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$ROOT/src-tauri/tauri.conf.json")"

export QNET_UPDATE_ENDPOINT="https://github.com/$REPO/releases/latest/download/latest.json"
export QNET_UPDATE_PUBKEY="$(cat "$KEY.pub")"
export QNET_UPDATE_DOWNLOAD_URL="https://github.com/$REPO/releases/download/v$version/Qnet.app.tar.gz"
export TAURI_SIGNING_PRIVATE_KEY_PATH="$KEY"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$password"
unset password
printf 'Updates on for %s: %s\n' "$version" "$QNET_UPDATE_ENDPOINT"
exec "$@"
