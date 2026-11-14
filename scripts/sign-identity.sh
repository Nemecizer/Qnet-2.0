#!/bin/sh
# Prints the code-signing identity Qnet builds use, or nothing.
# Set QNET_SIGN_IDENTITY to choose one; otherwise the Developer ID Application certificate in
# your keychain that expires last is used, or failing that the Apple Development one.
# It is printed as its SHA-1 fingerprint, not its name: Xcode can leave two
# certificates with the same name (one per renewal), and codesign refuses a name
# that matches both ("ambiguous").
#
# Why sign at all: macOS remembers "Always Allow" for Qnet's Keychain item and
# its file-access permissions per signing team. Unsigned builds have no team, so
# every rebuild looks like a new app. Builds signed by the same team keep them.
if [ -n "$QNET_SIGN_IDENTITY" ]; then
  echo "$QNET_SIGN_IDENTITY"
  exit 0
fi
# A Developer ID Application certificate wins when there is one: it is the only kind Apple
# notarizes (scripts/notarize.sh). QNET_SIGN_KIND="Apple Development" asks for the other.
kind="${QNET_SIGN_KIND:-}"
if [ -z "$kind" ]; then
  if security find-identity -v -p codesigning 2>/dev/null | grep -q '"Developer ID Application: '; then
    kind="Developer ID Application"
  else
    kind="Apple Development"
  fi
fi
best=""
best_end=0
for hash in $(security find-identity -v -p codesigning 2>/dev/null \
  | sed -nE "s/^ *[0-9]+\\) ([0-9A-F]{40}) \"$kind: .*/\\1/p"); do
  pem=$(security find-certificate -a -Z -p 2>/dev/null | awk -v h="$hash" '
    /^SHA-1 hash:/ { take = ($3 == h) }
    take && /BEGIN CERTIFICATE/ { on = 1 }
    on { print }
    on && /END CERTIFICATE/ { exit }')
  end=$(printf '%s\n' "$pem" | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
  [ -n "$end" ] || continue
  secs=$(date -j -f "%b %e %T %Y %Z" "$end" +%s 2>/dev/null || echo 0)
  if [ "$secs" -gt "$best_end" ]; then
    best="$hash"
    best_end="$secs"
  fi
done
[ -n "$best" ] && echo "$best"
exit 0
