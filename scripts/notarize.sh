#!/usr/bin/env bash
# Notarizes a candidate: sends its app to Apple, waits for the verdict, staples the ticket to the
# app, and rewrites the zip (and the installer, if there is one) from the stapled app.
#
#   scripts/notarize.sh ../Qnet-builds/<candidate folder>
#
# It needs two things on this Mac, both set up once by the owner (the script never sees a password):
#   1. A "Developer ID Application" certificate in the keychain, and the candidate built with it
#      (scripts/build-candidate.sh prefers it when it is there). Apple notarizes nothing else.
#   2. Credentials stored for notarytool under the profile name "qnet-notary"
#      (QNET_NOTARY_PROFILE names another):
#        xcrun notarytool store-credentials qnet-notary --apple-id <Apple ID> --team-id <team>
#      which asks for an app-specific password made at account.apple.com.
# Sending the app to Apple is the point of this script; nothing else leaves the Mac.
set -euo pipefail
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 1 ] || die "usage: scripts/notarize.sh <candidate folder>"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DIR="$(cd "$1" 2>/dev/null && pwd -P)" || die "no such folder: $1"
APP="$DIR/Qnet.app"
PROFILE="${QNET_NOTARY_PROFILE:-qnet-notary}"
[ -d "$APP" ] || die "$DIR holds no Qnet.app"
[ ! -e "$DIR/INCOMPLETE.txt" ] || die "that candidate did not finish building"
[ ! -e "$DIR/NOTARIZED.txt" ] || die "that candidate is already notarized"

codesign --verify --deep --strict "$APP" || die "the app's signature does not verify"
authority="$(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
case "$authority" in
    "Developer ID Application:"*) ;;
    *) die "the app is signed by “${authority:-nothing (ad hoc)}”. Apple notarizes only a Developer ID Application signature: create that certificate (Xcode ▸ Settings ▸ Accounts ▸ Manage Certificates), then build a new candidate." ;;
esac
# Every binary needs the hardened runtime and Apple's timestamp, or the submission is refused.
while IFS= read -r -d '' f; do
    file -b "$f" | grep -q 'Mach-O' || continue
    info="$(codesign -dvv "$f" 2>&1)"
    printf '%s' "$info" | grep -q 'flags=.*runtime' || die "${f#"$APP"/} is not signed with the hardened runtime"
    printf '%s' "$info" | grep -q '^Timestamp=' || die "${f#"$APP"/} has no secure timestamp"
done < <(find "$APP/Contents" -type f ! -name '*.bnet' ! -name '*.py' ! -name '*.txt' ! -name '*.md' -print0)
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
    || die "no notarytool credentials under “$PROFILE”. Store them once: xcrun notarytool store-credentials $PROFILE --apple-id <Apple ID> --team-id <team>"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/qnet-notarize.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$DIR/evidence"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$WORK/Qnet.zip"
printf 'Sending Qnet.app to Apple and waiting for the verdict…\n'
xcrun notarytool submit "$WORK/Qnet.zip" --keychain-profile "$PROFILE" --wait --output-format json > "$DIR/evidence/notarization.json" \
    || { cat "$DIR/evidence/notarization.json" >&2; die "the submission failed; see evidence/notarization.json"; }
id="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$DIR/evidence/notarization.json")"
status="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$DIR/evidence/notarization.json")"
xcrun notarytool log "$id" --keychain-profile "$PROFILE" "$DIR/evidence/notarization-log.json" >/dev/null 2>&1 || true
[ "$status" = Accepted ] || die "Apple's verdict: $status. The reasons are in evidence/notarization-log.json"

xcrun stapler staple "$APP" >/dev/null || die "stapling failed"
xcrun stapler validate "$APP" >/dev/null || die "the stapled ticket does not validate"
codesign --verify --deep --strict "$APP" || die "the signature no longer verifies"
spctl --assess --type execute -vv "$APP" > "$DIR/evidence/gatekeeper.txt" 2>&1 || die "Gatekeeper refuses the app; see evidence/gatekeeper.txt"

# The zip is remade from the stapled app; the installer, made before stapling, is removed so
# scripts/make-pkg.sh makes it again from this app.
for zip in "$DIR"/Qnet-*.zip; do
    [ -f "$zip" ] || continue
    rm -f "$zip" "$zip.sha256"
    ditto -c -k --sequesterRsrc --keepParent "$APP" "$zip"
    (cd "$DIR" && shasum -a 256 "$(basename "$zip")" > "$(basename "$zip").sha256")
done
rm -f "$DIR"/Qnet-*.pkg "$DIR"/Qnet-*.pkg.sha256
printf 'Notarized by Apple (submission %s) and stapled on %s.\nThe app and the zip are the stapled ones; PROVENANCE.json describes the app before stapling.\n' "$id" "$(date '+%Y-%m-%d %H:%M')" > "$DIR/NOTARIZED.txt"
printf 'Notarized and stapled: %s\nRun scripts/make-pkg.sh on the folder for a new installer.\n' "$APP"
