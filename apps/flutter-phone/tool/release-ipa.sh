#!/usr/bin/env bash
# 使い方: tool/release-ipa.sh <ipa> [--no-release]
# ipa 名 AudioStrokePhone-<version>.ipa から version を取り、
# buildVersion は pubspec.yaml の version の +build 部を使う。
#  1) GitHub Release phone-flutter-v<version> を作成（既にあれば ipa を上書きアップロード）
#  2) altstore/apps.json の versions 先頭に新版を追加（同じ version は置換、冪等）
# --no-release: Release 操作を飛ばし apps.json だけ更新。要: gh（ログイン済み）, node。
set -euo pipefail

ipa=${1:?usage: release-ipa.sh <ipa> [--no-release]}
mode=${2:-}
[[ -f "$ipa" ]] || { echo "no such file: $ipa" >&2; exit 1; }

root=$(cd "$(dirname "$0")/../../.." && pwd)
repo=grrowapp/audio-stroke
name=$(basename "$ipa")
version=${name#AudioStrokePhone-}; version=${version%.ipa}
[[ "$version" =~ ^[0-9]+(\.[0-9]+)*$ ]] || { echo "bad ipa name: $name" >&2; exit 1; }
tag=phone-flutter-v$version
size=$(stat -f%z "$ipa" 2>/dev/null || stat -c%s "$ipa")
line=$(grep -E '^version:' "$root/apps/flutter-phone/pubspec.yaml" | head -n1)
build=1; [[ "$line" == *+* ]] && build=$(echo "${line#*+}" | tr -d '[:space:]')
url=https://github.com/$repo/releases/download/$tag/$name

if [[ "$mode" != "--no-release" ]]; then
  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    gh release upload "$tag" "$ipa" --clobber --repo "$repo"
  else
    gh release create "$tag" "$ipa" --repo "$repo" --title "$tag" --notes "Unsigned ipa for AltStore / SideStore."
  fi
fi

node - "$root/altstore/apps.json" "$version" "$build" "$size" "$url" <<'JS'
const fs = require('fs');
const [file, version, build, size, url] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const app = j.apps.find(a => a.bundleIdentifier === 'jp.grrow.flutterPhone');
if (!app) throw new Error('app not found in apps.json');
const entry = { version, buildVersion: build, date: new Date().toISOString(), localizedDescription: `Audio Stroke Phone ${version}`, downloadURL: url, size: Number(size) };
app.versions = [entry, ...app.versions.filter(v => v.version !== version)];
fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
console.log('apps.json updated:', JSON.stringify(entry));
JS
