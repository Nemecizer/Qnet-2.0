#!/usr/bin/env bash
# Makes the installer package for a candidate (0.90.34 make_pkg.sh; ledger PKG-017):
#
#   scripts/make-pkg.sh ../Qnet-builds/<candidate folder>
#
# writes <candidate folder>/Qnet-<version>-arm64.pkg, which installs that folder's Qnet.app into
# /Applications, and its .sha256. The app is taken as it is — build it with
# scripts/build-candidate.sh — and is refused if it does not verify or links outside itself.
# The package is signed when a "Developer ID Installer" certificate is in the keychain
# (QNET_INSTALLER_IDENTITY chooses one); otherwise it is unsigned, and Gatekeeper will say so on
# another Mac. Nothing is installed or launched here.
set -euo pipefail
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ "$#" -eq 1 ] || die "usage: scripts/make-pkg.sh <candidate folder>"
DIR="$(cd "$1" 2>/dev/null && pwd -P)" || die "no such folder: $1"
APP="$DIR/Qnet.app"
[ -d "$APP" ] || die "$DIR holds no Qnet.app"
for tool in pkgbuild productbuild codesign otool lipo; do command -v "$tool" >/dev/null || die "missing $tool"; done

codesign --verify --deep --strict "$APP" || die "the app's signature does not verify"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
APP_ID="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP/Contents/Info.plist")"
MINIMUM="$(/usr/libexec/PlistBuddy -c 'Print LSMinimumSystemVersion' "$APP/Contents/Info.plist")"
[ "$(lipo -archs "$APP/Contents/MacOS/qnet")" = arm64 ] || die "the app is not arm64 only"
[ -d "$APP/Contents/Resources/bin" ] && [ -d "$APP/Contents/Frameworks" ] || die "the app carries no solvers: build it with scripts/build-candidate.sh"
while IFS= read -r -d '' f; do
    file -b "$f" | grep -q 'Mach-O' || continue
    if otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -q -E '^(/opt/homebrew|/usr/local)/'; then die "${f#"$APP"/} still links Homebrew"; fi
done < <(find "$APP/Contents" -type f \( -perm -u+x -o -name '*.dylib' \) -print0)

PKG="$DIR/Qnet-$VERSION-arm64.pkg"
[ ! -e "$PKG" ] || die "already exists: $PKG"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/qnet-pkg.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/root/Applications"
ditto "$APP" "$WORK/root/Applications/Qnet.app"
# Not relocatable: the installer must put it in /Applications, not over another copy it finds.
cat > "$WORK/component.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><dict>
    <key>BundleHasStrictIdentifier</key><true/>
    <key>BundleIsRelocatable</key><false/>
    <key>BundleIsVersionChecked</key><false/>
    <key>BundleOverwriteAction</key><string>upgrade</string>
    <key>RootRelativeBundlePath</key><string>Applications/Qnet.app</string>
</dict></array></plist>
PLIST
pkgbuild --root "$WORK/root" --component-plist "$WORK/component.plist" --identifier "$APP_ID.pkg" --version "$VERSION" \
    --install-location / "$WORK/Qnet-component.pkg" >/dev/null || die "pkgbuild failed"
cat > "$WORK/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>Qnet $VERSION</title>
    <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
    <volume-check><allowed-os-versions><os-version min="$MINIMUM"/></allowed-os-versions></volume-check>
    <choices-outline><line choice="default"><line choice="qnet"/></line></choices-outline>
    <choice id="default"/>
    <choice id="qnet" visible="false"><pkg-ref id="$APP_ID.pkg"/></choice>
    <pkg-ref id="$APP_ID.pkg" version="$VERSION" onConclusion="none">Qnet-component.pkg</pkg-ref>
</installer-gui-script>
XML
productbuild --distribution "$WORK/distribution.xml" --package-path "$WORK" "$WORK/unsigned.pkg" >/dev/null || die "productbuild failed"
INSTALLER_ID="${QNET_INSTALLER_IDENTITY:-$(security find-identity -v 2>/dev/null | sed -nE 's/^ *[0-9]+\) [0-9A-F]{40} "(Developer ID Installer: [^"]*)".*/\1/p' | head -1)}"
if [ -n "$INSTALLER_ID" ]; then
    productsign --sign "$INSTALLER_ID" "$WORK/unsigned.pkg" "$WORK/final.pkg" >/dev/null || die "productsign failed"
    signed="signed by $INSTALLER_ID"
else
    cp "$WORK/unsigned.pkg" "$WORK/final.pkg"
    signed="unsigned (no Developer ID Installer certificate)"
fi
# What it would install, read back from the package itself.
# Only a package that passed is left in the candidate's folder.
pkgutil --expand-full "$WORK/final.pkg" "$WORK/expanded" || die "the package could not be read back"
packed="$(find "$WORK/expanded" -type d -path '*/Payload/Applications/Qnet.app' | head -1)"
[ -n "$packed" ] && [ -x "$packed/Contents/MacOS/qnet" ] || die "the package does not install Applications/Qnet.app"
codesign --verify --deep --strict "$packed" || die "the packaged app's signature does not verify"
mv "$WORK/final.pkg" "$PKG"
(cd "$DIR" && shasum -a 256 "$(basename "$PKG")" > "$(basename "$PKG").sha256")
printf 'Built: %s\n  Qnet %s (%s), arm64, macOS %s or later; %s\n' "$PKG" "$VERSION" "$APP_ID" "$MINIMUM" "$signed"
