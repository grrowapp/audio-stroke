#!/bin/bash
# Builds dist/AudioStrokePhone.app (universal) and dist/AudioStrokePhone-<version>.zip for the Homebrew cask.
#   apps/mac-phone/build.sh [version]      (default: version from package.json)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/apps/mac-phone"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
APP="$ROOT/dist/AudioStrokePhone.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 1. client bundle (ws is inlined; node is the only runtime dependency)
"$ROOT/node_modules/.bin/esbuild" "$ROOT/cli/phone.ts" --bundle --platform=node --target=node22 --format=cjs \
  --outfile="$APP/Contents/Resources/phone.cjs" --log-level=warning

# 2. launcher script + plist
cp "$SRC/phone.sh" "$APP/Contents/Resources/phone.sh"
chmod +x "$APP/Contents/Resources/phone.sh"
sed "s/__VERSION__/$VERSION/g" "$SRC/Info.plist" > "$APP/Contents/Info.plist"

# 3. window app (arm64 + x86_64)
TMP="$(mktemp -d)"
for arch in arm64 x86_64; do
  xcrun swiftc -O -target "$arch-apple-macos13.0" "$SRC/main.swift" -o "$TMP/AudioStrokePhone-$arch"
done
lipo -create "$TMP/AudioStrokePhone-arm64" "$TMP/AudioStrokePhone-x86_64" -output "$APP/Contents/MacOS/AudioStrokePhone"
rm -rf "$TMP"

# 4. ad-hoc signature (no developer certificate; the cask strips quarantine on install)
codesign --force --deep --sign - "$APP"

# 5. zip for the release asset
ZIP="$ROOT/dist/AudioStrokePhone-$VERSION.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "built $APP"
echo "zip   $ZIP"
echo "sha256 $(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
