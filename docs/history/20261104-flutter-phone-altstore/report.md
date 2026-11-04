# Flutter 電話クライアントの AltStore 配布 report

## 未検証事項（先頭）
- Actions の実行は完了（下記「Actions 実行結果」）。実機で AltStore から入るか、署名なし ipa が再署名後に動くかは未検証。
- （解消済み）当初は workflow scope が無く workflows-pending に退避していたが、scope 付与後に `.github/workflows/` へ移した。
- 実機で AltStore から入るか、apps.json の `appPermissions` と ipa の一致検査（AltStore は不一致だと拒否）、Runner.app の署名なし ipa が再署名で動くか。
- Homebrew cask `altserver` の有無、AltStore での source 追加の画面表記は確認できておらず、docs では断定していない。AltServer 1.8 のメニュー名（Install AltStore / Sideload .ipa / Launch at Login / Install・Uninstall Mail Plug-in / Check for Updates... / Quit AltServer）と Mail プラグイン方式は、依頼者から受けた mac200 の AltServer 1.8 での確認結果として docs に記載した（公式資料には記載なし。公式 FAQ で確認できたのは zip URL、macOS 11 以降、Install AltStore、Install Mail Plug-in...、Show this iPhone/iPad when on WiFi のみ。本 worker は AltServer 実物を未確認）。

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
- `.github/workflows/flutter-phone-ipa.yml`、`docs/history/20261104-flutter-phone-altstore/report.md`
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

## レビュー指摘対応
- source に `"nsfw": false` を追加（公式で必須扱い）。release-ipa.sh は JSON を読み書きするだけで nsfw を保持する。
- release-ipa.sh: ipa 名の version と pubspec の version（+ より前）が不一致なら中断。workflow の build ジョブにも tag 起動時のみ tag と pubspec の一致検査を追加。
- workflow の release ジョブ: 同名 Release があれば `upload --clobber`、無ければ create。


## Actions 実行結果
- run: https://github.com/grrowapp/audio-stroke/actions/runs/41807556602 （success、約 5 分 11 秒、macos-latest、Flutter 3.47.9）。
- artifact `AudioStrokePhone-ipa` の ipa: `AudioStrokePhone-1.0.0.ipa`、7405912 バイト（実測。ログの sha256=0e3414940ffe6ff72bf2fd73d898aca7fcdb9f388adb0412b4d33ae19ebb2c81）。Runner.app は 17.7MB、Xcode build 98.4 秒。
- ipa 内 Info.plist: CFBundleIdentifier=jp.grrow.flutterPhone、CFBundleShortVersionString=1.0.0、CFBundleVersion=1、MinimumOSVersion=15.0、UsageDescription は NSMicrophoneUsageDescription / NSLocalNetworkUsageDescription の 2 つ（apps.json の privacy と一致）、embedded.mobileprovision なし。
- ビルドで直した点: なし（初回で成功。Podfile 生成、CocoaPods、record / just_audio の iOS ビルドも通った）。
- dispatch が 404 になった原因: `gh workflow run` は workflow が default branch（main）に無く、かつ GitHub に未登録だと `workflow not found on the default branch` で 404 になる。branch 上に push しただけでは、トリガが workflow_dispatch と tag のみの workflow は登録されなかった（`/actions/workflows` が空）。そこで一時的に当 branch の push トリガ（paths で workflow ファイルに限定）を足して push し、その push で走った run が上記。実行後にそのトリガは外した。以後、branch 上の workflow を `gh workflow run --ref` で動かせるかは未確認（登録は済んだので動く可能性はあるが検証していない）。
- apps.json の初回エントリ: 上記 ipa の実測サイズ 7405912、date は記録時刻。downloadURL は将来の tag `phone-flutter-v1.0.0` の形式で、GitHub Release は作っていない（URL は現時点で 404）。
- 残る未検証: 実機で AltStore から入るか、再署名後に動くか、tag 起動の release ジョブ（実行していない）、tag と pubspec の一致検査ステップ（dispatch / branch push 時は skip されたまま）。
