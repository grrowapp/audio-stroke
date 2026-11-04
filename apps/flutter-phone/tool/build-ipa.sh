#!/usr/bin/env bash
# 署名なし ipa を作る（AltStore / SideStore が再署名する）。macOS + Flutter + Xcode + CocoaPods が必要。
# 出力: dist/AudioStrokePhone-<version>.ipa （<version> = pubspec の version の "+" より前）
# build 番号（"+" より後）は CFBundleVersion として Info.plist に入る（Flutter が pubspec から設定）。
set -euo pipefail

cd "$(dirname "$0")/.."

line=$(grep -E '^version:' pubspec.yaml | head -n1 | sed -E 's/^version:[[:space:]]*//; s/[[:space:]]+$//')
version=${line%%+*}
build=1
[[ "$line" == *+* ]] && build=${line#*+}
echo "version=$version build=$build"

flutter pub get
flutter build ios --release --no-codesign --build-name "$version" --build-number "$build"

app=build/ios/iphoneos/Runner.app
[[ -d "$app" ]] || { echo "not found: $app" >&2; exit 1; }

out_dir=$PWD/dist
ipa=$out_dir/AudioStrokePhone-$version.ipa
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/Payload" "$out_dir"
cp -R "$app" "$work/Payload/"
rm -f "$ipa"
(cd "$work" && zip -qry "$ipa" Payload)

size=$(stat -f%z "$ipa" 2>/dev/null || stat -c%s "$ipa")
if command -v shasum >/dev/null; then sha=$(shasum -a 256 "$ipa" | cut -d' ' -f1); else sha=$(sha256sum "$ipa" | cut -d' ' -f1); fi
echo "ipa=$ipa"
echo "size=$size"
echo "sha256=$sha"
