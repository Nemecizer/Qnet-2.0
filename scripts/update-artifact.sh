#!/usr/bin/env bash
# Makes what the in-app updater downloads, from a finished candidate (docs/UPDATES.md):
#
#   scripts/update-artifact.sh ../Qnet-builds/<candidate folder>
#
#   <candidate>/update/Qnet.app.tar.gz        the whole assembled, signed (and, if notarize.sh has
#                                             run, stapled) Qnet.app
#   <candidate>/update/Qnet.app.tar.gz.sig    its signature, made with the owner's private key
#   <candidate>/update/latest.json            what the update address must serve
#
# The archive is made here and not by Tauri's own `createUpdaterArtifacts`, because Tauri would
# archive the bare app it bundles, before scripts/assemble-bundle.sh has put the solvers, libraries
# and Python inside and signed the result.
#
# It needs the private key, which is never in the repository: TAURI_SIGNING_PRIVATE_KEY_PATH names
# its file (or TAURI_SIGNING_PRIVATE_KEY holds it), and TAURI_SIGNING_PRIVATE_KEY_PASSWORD its
# password. QNET_UPDATE_DOWNLOAD_URL is the https address the archive will be downloaded from; if
# it is not set, latest.json is written with a placeholder to fill in. build-candidate.sh runs this
# only when updates are switched on; run it again after scripts/notarize.sh. Nothing is uploaded.
set -euo pipefail
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 1 ] || die "usage: scripts/update-artifact.sh <candidate folder>"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DIR="$(cd "$1" 2>/dev/null && pwd -P)" || die "no such folder: $1"
APP="$DIR/Qnet.app"
[ -d "$APP" ] || die "$DIR holds no Qnet.app"
[ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}${TAURI_SIGNING_PRIVATE_KEY:-}" ] || die "no signing key: set TAURI_SIGNING_PRIVATE_KEY_PATH to the private key's file (docs/UPDATES.md)"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
    [ -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ] || die "no such key file: $TAURI_SIGNING_PRIVATE_KEY_PATH"
    key="$(cd "$(dirname "$TAURI_SIGNING_PRIVATE_KEY_PATH")" && pwd -P)/$(basename "$TAURI_SIGNING_PRIVATE_KEY_PATH")"
    case "$key" in "$ROOT"/*) die "the private key is inside the repository ($key). Move it out before anything else: it must never be committed or synced." ;; esac
fi
case "${QNET_UPDATE_DOWNLOAD_URL:-https://}" in https://*) ;; *) die "QNET_UPDATE_DOWNLOAD_URL must be an https:// address" ;; esac
codesign --verify --deep --strict "$APP" || die "the app's signature does not verify"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[ -n "$version" ] || die "the app states no version"
arch="$(lipo -archs "$APP/Contents/MacOS/qnet" | tr ' ' '\n' | head -1)"
case "$arch" in arm64) target=darwin-aarch64 ;; x86_64) target=darwin-x86_64 ;; *) die "unexpected architecture: $arch" ;; esac

OUT="$DIR/update"
rm -rf "$OUT"
mkdir "$OUT"
# COPYFILE_DISABLE: no ._ AppleDouble entries, which would break the app's signature when unpacked.
COPYFILE_DISABLE=1 tar -czf "$OUT/Qnet.app.tar.gz" -C "$DIR" Qnet.app
# The round trip the updater will make: unpacked, the app must still verify.
check="$(mktemp -d "${TMPDIR:-/tmp}/qnet-update.XXXXXX")"
trap 'rm -rf "$check"' EXIT
tar -xzf "$OUT/Qnet.app.tar.gz" -C "$check"
codesign --verify --deep --strict "$check/Qnet.app" || die "the app does not verify after the archive round trip"

# --app-version binds the signature to this version: the app refuses an archive whose signature
# names another one (requireSignedVersion, src-tauri/src/updates.rs).
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}"
(cd "$ROOT" && npx tauri signer sign --app-version "$version" "$OUT/Qnet.app.tar.gz" >/dev/null) || die "signing failed (wrong key password?)"
[ -s "$OUT/Qnet.app.tar.gz.sig" ] || die "the signer left no signature"

python3 -I - "$OUT" "$version" "$target" "${QNET_UPDATE_DOWNLOAD_URL:-}" "${QNET_UPDATE_NOTES_FILE:-}" <<'PY'
import datetime, json, pathlib, sys
out, version, target, url, notes_file = sys.argv[1:]
out = pathlib.Path(out)
notes = pathlib.Path(notes_file).read_text(encoding="utf-8").strip() if notes_file else f"Qnet {version}"
latest = {
    "version": version,
    "notes": notes,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {target: {"signature": (out / "Qnet.app.tar.gz.sig").read_text(encoding="utf-8").strip(), "url": url or "https://REPLACE-WITH-THE-DOWNLOAD-ADDRESS/Qnet.app.tar.gz"}},
}
(out / "latest.json").write_text(json.dumps(latest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
(cd "$OUT" && shasum -a 256 Qnet.app.tar.gz > Qnet.app.tar.gz.sha256)
printf 'Update archive for Qnet %s (%s): %s\nNothing was uploaded.\n' "$version" "$target" "$OUT"
[ -n "${QNET_UPDATE_DOWNLOAD_URL:-}" ] || printf 'latest.json has a placeholder download address: set it before publishing.\n'
