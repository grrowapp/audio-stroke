# Flutter 電話クライアント（`apps/flutter-phone`）

iPhone（実機）で音声入出力を担う電話クライアント。`cli/phone.ts`（SoX 版）の Dart 移植で、サーバーとは `docs/API_EVENTS.md` の WebSocket 契約をそのまま話す。サーバー側の変更は無い。

> **状態**: プロトコル層は実サーバー（mock）に対して headless で検証済み。**iOS 実機ビルド・実機での音声入出力は未検証**（このリポジトリの開発ホストは Linux で iOS ビルド不可）。設定ファイルの正しさと手順までが成果物。

## 構成

```
apps/flutter-phone/
  lib/protocol/   プラグイン非依存の純 Dart（dart:io のみ）
    api_client.dart    セッション API（Origin 付き、POST は application/json + Content-Length）、READY シナリオ一覧
    ws_connection.dart WebSocket（Origin ヘッダ付き、バイナリ/JSON、送信側 backlog の計測）
    frame_packer.dart  可変長 PCM16 → 20 ms = 960 バイトへ切り直し + 0x01 タグ。48 kHz 入力は 2:1 間引きで 24 kHz
    audio_io.dart      AudioSource / AudioSink / PlaybackHandle 抽象、無音ソース、即完了シンク
    phone_client.dart  cli/phone.ts 相当: state / play / playback_stop / prefetch…、mic_enabled ゲート、
                       再生の世代管理と ack、client_metric
  lib/audio/      iOS/Android 実機用（record / audio_session / just_audio）
  lib/ui/         画面 1 枚（サーバー URL、バックエンド、シナリオ、開始/停止/再生スキップ、ログ）
  test/protocol/  unit テスト
  test/integration/ 実サーバー結合テスト
  tool/run_integration.sh  mock サーバーを一時起動して結合テストを実行
```

層の約束: `lib/protocol/` はプラグインを import しない。音源・再生先は `AudioSource` / `AudioSink` で差し替える（headless 実行や、パッケージ API が想定と違った場合の吸収は `lib/audio/` 側で行う）。

動作は `cli/phone.ts` と同じ。再生は `playback_started`（実際に音が出始めた時点）→ `playback_ended`、`playback_stop` を受けたら止めて `playback_canceled{position_ms, reason:"barge_in"}`、「再生スキップ」は `reason:"user_skip"`。新しい `play` が来たら旧再生は無言で止め、旧再生の完了では ack を送らない（世代管理）。送信側の滞留が 1 秒分（48000 バイト）を超えたら `stop` を送る（ただし下記の既知の制約のとおり dart:io では実質働かない）。MOCK セッション（`mock_realtime`）ではマイクを使わず無音フレームを送る。半二重が既定で、割り込み（`barge_in_enabled`）は画面のスイッチ（ヘッドセット前提）。

## Mac での iOS ビルド（実機）

前提: macOS、Xcode（App Store から。初回起動でライセンス同意と iOS ランタイム導入）、CocoaPods、Flutter SDK、Apple ID。

```
# 1. Flutter SDK（~/flutter-sdk の例。版は下の「検証した版」に合わせる）
git clone https://github.com/flutter/flutter.git -b stable ~/flutter-sdk
export PATH="$HOME/flutter-sdk/bin:$PATH"
# 2. CocoaPods
brew install cocoapods          # または sudo gem install cocoapods
# 3. 診断（Xcode / CocoaPods / 実機接続を確認）
flutter doctor
# 4. 依存取得
cd apps/flutter-phone
flutter pub get
```

署名（Personal Team = 無料 Apple ID）:

1. `open ios/Runner.xcworkspace`（`Podfile` と `Pods/` は初回の `flutter run` / `flutter build ios` が生成する。Xcode で署名を設定するだけなら `flutter build ios --config-only` で先に作れる）。
2. Runner ターゲット → Signing & Capabilities → *Automatically manage signing* → Team に自分の Apple ID の Personal Team を選ぶ。
3. Bundle Identifier は他人と衝突しない値に変える（既定は `jp.grrow.flutterPhone`。無料署名では自分専用の一意な ID が必要）。
4. iPhone を USB 接続 → 「信頼」。iOS 16 以降は 設定 → プライバシーとセキュリティ → デベロッパモード をオンにして再起動。
5. 実機にインストール: `flutter run --release -d <device-id>`（`flutter devices` で確認）。初回は 設定 → 一般 → VPN とデバイス管理 で自分の開発元を信頼する。

制約: 無料署名のプロビジョニングは **7 日で失効**し、アプリが起動しなくなる。再度 Xcode / `flutter run --release` で入れ直す（同一 Bundle ID なら上書きされる）。同時に入れられる自分のアプリ数にも上限がある。デバッグビルドは Xcode / flutter から切り離すと起動できないので、持ち歩きには `--release` を使う。

`Info.plist`（`ios/Runner/Info.plist`）に設定済みの項目:

| キー | 理由 |
|---|---|
| `NSMicrophoneUsageDescription` | マイク権限ダイアログの文言 |
| `NSLocalNetworkUsageDescription` | LAN / Tailscale 上のサーバーへの接続 |
| `UIBackgroundModes` = `audio` | 画面ロック・バックグラウンドでも会話を続ける |
| `NSAppTransportSecurity` / `NSAllowsArbitraryLoads` | Tailscale の `100.x` への平文 `http` / `ws` |

最低 iOS は Flutter 既定の 15.0（使用パッケージの要件は record_ios 12 / just_audio 12 / audio_session 12 でいずれも下回る）。

## サーバー側の注意（EXTRA_ALLOWED_HOSTS）

サーバーは Host と Origin を許可リストで検証する（`server/middleware/00.guard.ts`、`server/routes/ws.ts`）。端末から入力する URL の `host:port` を、サーバー起動時の環境変数に加える:

```
EXTRA_ALLOWED_HOSTS=100.122.237.76:8000 npm start      # 画面に入れる URL が http://100.122.237.76:8000 の場合
```

クライアントは Origin に `http://<入力した host:port>` を付けるので、URL の書き方（IP / ホスト名 / ポート）を許可リストと一致させる。不一致だと `POST /api/sessions` が 421/403、WS upgrade が 403 になる。サーバーは既定で `127.0.0.1` のみ待ち受けるため、端末から届くアドレス（Tailscale IP 等）で待ち受ける設定も別途必要。

## テスト

```
cd apps/flutter-phone
flutter analyze
flutter test test/protocol            # unit（フレーム整形、48→24 kHz、ack と世代管理、playback_canceled の position_ms、mic ゲート 等）
tool/run_integration.sh               # 実サーバー結合（要: リポジトリ直下で npm ci 済み）
```

結合テスト（`test/integration/server_session_test.dart`）は環境変数 `AUDIO_STROKE_SERVER` が未設定ならスキップ。`tool/run_integration.sh` は Nitro を build し、`.env` 無し・一時 `DATA_DIR`・空きポート（8000 以外）の mock 構成で起動して、mock の generate → approve でシナリオを作り、無音 `AudioSource` と即完了 `AudioSink` で play → ack → finished まで走らせる。

## 既知の制約・未検証

- **iOS 実機未検証**: ビルド、署名、マイク/スピーカー、バックグラウンド動作は未確認。
- **24 kHz 入力の実機確認未了**: `record` に 24000 Hz を要求しているが、iOS 実機がそのレートで PCM を返すかは未確認。画面の「48kHz 入力」スイッチで 48 kHz 取得 + 2:1 間引きの fallback に切り替えられる（単純間引きで事前ローパスは無い）。
- **just_audio の再生開始遅延**: バイト列再生は just_audio 内蔵のローカル HTTP プロキシ経由で、1 発話目は読み込み分の遅延が出うる。`prefetch` ヒントで先読みしたプレイヤーは `play` だけで始まる。遅延は `client_metric`（`decision_message_to_playback_started_ms`）で測れる。`playback_started` は「再生中かつ ready」になった時点で送る。
- **送信 backlog 監視は実質無効**: dart:io の `WebSocket.add` / `addStream` は背圧を返さず、読まない相手に 30 MB 送っても滞留が見えない（VM 上で実測）。`bufferedBytes` を `addStream` の完了待ちで数える実装にしてあるが、`cli/phone.ts` の「滞留 1 秒超で stop」は再現できていない。ネットワーク断は WS の close / error で検出される。必要なら TCP レベルの制御が要る（未対応）。
- エコーキャンセルは `voiceChat` モード + `echoCancel` 任せ。完全な割り込み検知は保証しない（API_EVENTS.md と同じ前提）。半二重を既定にしている。
- Basic 認証（`--auth` 相当）は `PhoneApi(auth:)` に実装済みだが画面からは入力できない。
