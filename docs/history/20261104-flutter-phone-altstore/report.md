# Flutter 電話クライアントの AltStore 配布 report

## 未検証事項（先頭）
- **GitHub Actions は未実行**。gh の token に `workflow` scope が無く、`.github/workflows/*.yml` を含む push が GitHub に拒否された（"refusing to allow an OAuth App to create or update workflow ... without `workflow` scope"）。この環境では device flow も別 token も使えないため、workflow は `flutter-phone-ipa.yml.txt`（同ディレクトリ）として commit した。iOS ビルド（Podfile 生成、CocoaPods、record / just_audio の iOS ビルド）は一度も実行していない。
- 利用者の手順: `gh auth refresh -s workflow` → `docs/history/20261104-flutter-phone-altstore/flutter-phone-ipa.yml.txt` を `.github/workflows/flutter-phone-ipa.yml` にコピーして push → `gh workflow run flutter-phone-ipa.yml --ref <branch>`（default branch に無い workflow の dispatch が 404 になる場合は、workflow を default branch / mvp に入れる必要がある可能性。未確認）。
- 実機で AltStore から入るか、apps.json の `appPermissions` と ipa の一致検査（AltStore は不一致だと拒否）、Runner.app の署名なし ipa が再署名で動くか。
- apps.json の `versions` は空。実在する ipa サイズが無く、作り話の size は入れなかった。`release-ipa.sh` の実行で埋まる。versions が空のままだと AltStore 側でアプリ表示が成立するかは未確認。
- Launch at Login、Homebrew cask `altserver`、AltStore での source 追加の画面表記は公式 FAQ で確認できず、docs では断定していない。

## 現状調査
- 基点 `feature/flutter-phone`（0bcb5d7）。`.github/` なし。ios の Bundle ID は `jp.grrow.flutterPhone`、Info.plist に `NSMicrophoneUsageDescription` / `NSLocalNetworkUsageDescription`、`UIBackgroundModes=audio`。
- pubspec `version: 1.0.0+1`。Flutter SDK は ~/flutter-sdk の 3.47.9（Dart 3.13.7）。
- AltStore source 形式は faq.altstore.io の Make a Source で確認: version に `buildVersion` が必須、`size` は数値バイト、`date` は ISO 8601、`appPermissions` 必須（ipa と照合される）。

## 設計判断
- version: `+` より前を ipa 名・`--build-name` に、`+` 以降を `--build-number`（CFBundleVersion）と apps.json の `buildVersion` に使う。ipa 名に build を含めない（downloadURL を tag と 1:1 にするため）。build だけ上げた再リリースは同名 ipa になるので Release 上書き（`--clobber`）で対応。
- build-ipa.sh は `zip -qry`（Mac / Actions の macOS ランナーに標準）、size は BSD/GNU 両対応の stat。
- workflow: build job は `contents: read`、`contents: write` は tag 時の release job のみ。Flutter は subosito/flutter-action@v2 で 3.47.9 固定。
- 初期の versions エントリは実 ipa が無いため入れない（上記）。
- アイコンは ImageMagick が無いため node（zlib）で 512x512 PNG を生成した簡易図。

## 変更ファイル
- `apps/flutter-phone/tool/build-ipa.sh`、`apps/flutter-phone/tool/release-ipa.sh`
- `altstore/apps.json`、`altstore/icon.png`
- `docs/FLUTTER_PHONE.md`（配布（AltStore）節）、`README.md`（1 文追記）
- `docs/history/20261104-flutter-phone-altstore/`（report.md、flutter-phone-ipa.yml.txt）
- ios/ 配下の変更なし（ビルド未実行のため）。

## 実行結果
- `flutter analyze`: No issues found。`flutter test`: 合格（integration はスキップ）。
- `bash -n` 2 スクリプト OK。
- build-ipa.sh ドライラン: ダミー flutter / zip 代替で version=1.0.0 build=1 の抽出、Payload/Runner.app 構造の ipa 生成、size / sha256 出力を確認（実ビルドではない）。
- release-ipa.sh `--no-release`: ダミー ipa で apps.json に追記、再実行で重複せず置換（versions 1 件）を確認。`gh release` 分岐は未実行。
- workflow YAML: actionlint なし。js-yaml で構文パースのみ（トップキー・permissions を確認）。
- apps.json: node で JSON 妥当性と必須キーを確認。
- run URL / artifact サイズ: なし（未実行）。

## 解釈した点
- 「ローカル workflow commit を作り直す」は、未 push の commit を workflow を含まない形に作り直して解釈した。
