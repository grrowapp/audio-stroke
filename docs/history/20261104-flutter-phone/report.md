# Flutter 電話クライアント（feature/flutter-phone）

## 現状調査（変更前）
- 端末クライアントは `cli/phone.ts`（SoX の `rec`/`play`、Node）と、それを包む `apps/mac-phone`（起動時ダイアログで server / backend / scenario を選ぶ）だけ。iPhone 用は無い。
- WS 契約は `docs/API_EVENTS.md`。端末→サーバーは先頭 `0x01` + PCM16 mono 24 kHz のバイナリと JSON ack、サーバー→端末は state / play / playback_stop / prefetch 等。
- Host / Origin は `server/middleware/00.guard.ts` と `server/routes/ws.ts` が許可リスト（`127.0.0.1:<port>` + `EXTRA_ALLOWED_HOSTS`）で検証。POST は `application/json` と Content-Length 必須（chunked 不可）。→ Dart でも `contentLength` を明示。
- `phone.ts` の一覧は `GET /api/scenarios` + `/versions` + `/versions/{v}`（`summaries` は使っていない）。Flutter 版も同じ API に揃えた（サーバー無変更）。
- 開発ホスト（206）は Linux。Flutter SDK 無し、iOS ビルド不可。

## 設計判断
- **層分け**: `lib/protocol/`（純 Dart、`dart:io` のみ、プラグイン import 無し）/ `lib/audio/`（record・audio_session・just_audio）/ `lib/ui/`（1 画面）。`AudioSource` / `AudioSink` / `PlaybackHandle` を抽象にし、headless 実行・テストは `SilentAudioSource` / `InstantAudioSink` に差し替え。
- `PlaybackHandle` は `started`（実際に音が出始めた時点）/ `completed` / `positionMs` / `stop()`。`playback_started` と `decision_message_to_playback_started_ms` は started で出す（phone.ts は spawn 直後だったが、just_audio は読み込みが非同期なので実測値になるよう変更）。
- 世代管理: 現在の再生（`_playback`）以外の完了・失敗は ack しない。新しい `play` による置換は phone.ts と同じく無言。`playback_stop` は ID 不一致なら無視。キャンセル時の `position_ms` は `PlaybackHandle.positionMs`（再生位置）。
- 依存を最小化: HTTP と WS は `dart:io`（`http` / `web_socket_channel` を入れない。Origin ヘッダは `WebSocket.connect(headers:)` で付く）。
- **パッケージ（版は pubspec.lock）**
  - `record 7.1.2`（+ `record_ios 2.1.1`）: `startStream` で PCM16 mono を直接取れ、`echoCancel` / `noiseSuppress` / `autoGain` 指定可。`ios.manageAudioSession(false)` で音声セッションを audio_session に一本化。
  - `audio_session 0.2.4`: `playAndRecord` + `voiceChat`（+ defaultToSpeaker / allowBluetooth）。
  - `just_audio 0.10.6`: バイト列再生は `StreamAudioSource`（experimental 警告は `ignore_for_file` で抑止）。完了・位置・先読み用の複数プレイヤーを持てる。`handleAudioSessionActivation:false`（セッションは自前）。
  - `shared_preferences 2.5.6`: サーバー URL の保存のみ。
  - dev: `test ^1.31.1`（lib/protocol のテストは Flutter バインディングを使わず実 HTTP/WS を許すため `package:test`）、`flutter_lints ^6.0.0`（flutter create 既定）。
- 最低 iOS: Flutter 既定の 15.0（record_ios / just_audio / audio_session の要件はいずれも 12.0）。Android minSdk は Flutter 既定 24。
- 24 kHz 取得が実機で出なかった場合の fallback: 画面の「48kHz 入力」スイッチ（`FramePacker(inputRate: 48000)`、単純 2:1 間引き）。
- **想定と違った点（audio 層で吸収せず記録）**
  - dart:io の `WebSocket.add` / `addStream` は背圧を返さず、読まない相手に 30 MB 送っても滞留が見えない（VM 上で実測）。phone.ts の「`bufferedAmount` > 1 秒で stop」は protocol 層に実装したが **実質無効**。ネットワーク断は close/error で検出される。
  - `just_audio` の `AudioSource` と protocol 層の `AudioSource` が名前衝突 → audio 層で `hide AudioSource`。

## 変更ファイル
- 新規 `apps/flutter-phone/`（flutter create 生成物 + 下記）
  - `lib/protocol/{api_client,audio_io,frame_packer,phone_client,ws_connection}.dart`
  - `lib/audio/device_audio.dart`、`lib/ui/phone_page.dart`、`lib/main.dart`
  - `test/protocol/{frame_packer,phone_client,ws_connection}_test.dart`、`test/integration/server_session_test.dart`、`tool/run_integration.sh`
  - `ios/Runner/Info.plist`（NSMicrophoneUsageDescription / NSLocalNetworkUsageDescription / UIBackgroundModes=audio / NSAppTransportSecurity.NSAllowsArbitraryLoads、表示名）、`android/app/src/main/AndroidManifest.xml`（RECORD_AUDIO / INTERNET / MODIFY_AUDIO_SETTINGS / usesCleartextTraffic、ラベル）
- 新規 `docs/FLUTTER_PHONE.md`、`docs/history/20261104-flutter-phone/report.md`
- 変更 `README.md`（端末クライアントの節に 1 段落）
- `server/` `app/` `cli/` `apps/mac-phone/` は無変更（`git diff origin/mvp -- server app cli apps/mac-phone` が空）。version bump 無し。

## テスト結果
- `flutter analyze`: No issues found（警告 0）。
- `flutter test`: 25 件合格 + 1 スキップ（結合、環境変数未設定時）。内訳: フレーム整形（可変長入力、奇数バイト、960 バイト境界）、48→24 kHz 間引き（位相・奇数バイトが分割に依存しない）、mic_enabled ゲート、backlog 超過で stop 1 回、MOCK は無音送信、play→started+client_metric→ended、speech_stopped→notification metric、世代置換で古い完了は無 ack、`playback_stop`→`playback_canceled{position_ms:1234, reason:barge_in}`、他 ID の stop 無視、skip→`user_skip`、取得失敗/再生失敗→`playback_failed`、マイク start() 失敗時に例外を再送出し WS を閉じる、prefetch、finished、WS の Origin とバイナリ/テキスト配送。
- 結合: `tool/run_integration.sh`（Nitro build → 空きポートで mock 起動、`env -i`・一時 DATA_DIR・.env 無し → mock の generate→approve で READY → `PhoneApi` で config/一覧/session → `PhoneClient` を SilentAudioSource + InstantAudioSink で実行、`mock_vad` で select_need→demo→confirm_demo→yes）。3 発話（select_need / confirm_demo / end_demo）を再生・ack し `finished FINISHED completed` に到達、サーバーの `log.jsonl` に `client_metric`（`decision_message_to_playback_started_ms`）が記録された。合格。
- `npm test`: 13 ファイル / 116 件合格。
- Info.plist の 4 項目（NSMicrophoneUsageDescription / NSLocalNetworkUsageDescription / UIBackgroundModes=audio / NSAllowsArbitraryLoads）は grep で目視確認。plist の構文検証ツール（plutil）は Linux に無く未実施。

## 206 に入れたもの
- Flutter SDK 3.47.9 stable（Dart 3.13.7）: `~/flutter-sdk`（共有資産として残す）。`flutter --disable-analytics` を実行。pub キャッシュ `~/.pub-cache`。Android SDK / Xcode は未導入。apt 追加・/usr/local 変更は無し。

## 未検証事項
- iOS ビルド・署名・実機での録音/再生/バックグラウンド動作（Linux ホストでは不可）。Android も実機・ビルド未実施。
- iOS 実機が 24 kHz PCM を返すか（返さない場合は 48kHz スイッチ）。
- just_audio の初回再生開始遅延（先読みなしの 1 発話目）。実機の `client_metric` で要測定。
- Podfile は未生成（Mac 初回ビルドで生成）。`Runner.xcodeproj` の Bundle ID は `jp.grrow.flutterPhone`（無料署名では変更が必要な場合あり）。
- 送信 backlog 監視は上記のとおり実質無効。
- UI は `flutter analyze` のみ（ウィジェットテスト・実画面確認なし）。

## レビュー指摘の修正（追加 commit）
- `PhoneClient.run()`: WS 接続後の処理全体を try/finally にし、マイク start() 失敗（権限拒否など）でも `_cleanup`（WS・マイク・再生）を通してから例外を再送出。UI 側は WS を触らないので二重 cleanup なし。unit テスト追加（start() が throw する AudioSource で WS が閉じ、stop が 1 回呼ばれる）。
- `ws.messages.listen` をマイク start() より前に移動（権限ダイアログ待ち中にサーバーのメッセージを未読にしないため）。
- `tool/run_integration.sh`: `exec env -i … node` にして `$!` を node 自身にし、cleanup で kill + wait。実行後に clone 由来の node が残らないことを確認。
- `_JustHandle`: player の dispose を 1 回に集約。`RecordAudioSource` の AudioRecorder は start() で遅延生成（MOCK では生成されない）、stop() で stop → dispose。
- 前回の後始末後に残っていた mock Nitro 2 本（PID 198132, 198930）は、親 PID 1・cwd が削除済みの `/tmp/w-abb-fp/repo` であることを確認して PID 指定で停止。
