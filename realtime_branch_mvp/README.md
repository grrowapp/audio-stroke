# realtime_branch_mvp — Claude 事前分岐生成 × 事前音声生成 × Realtime 音声分岐

画面に日本語で「どう応対したいか」を入力すると、**会話の前に** Claude API が会話分岐グラフ（発話文・想定返答例・分岐条件）を生成し、利用者がレビュー・編集・承認した版の発話文だけを **会話の前に** TTS で音声化します。会話中はユーザーの音声を OpenAI Realtime API にストリーミングし、Realtime が現在ノードの許可済み分岐から選び、アプリが対応する生成済み音声を再生します。

> **既存 MVP について**: 指示書が基点とする既存 `realtime_branch_mvp` のコードはこのリポジトリに無かったため、指示書 §1 に書かれた構成（`app.py` / `router.py` / `client.js` / `worklet.js` / `test_router.py` / `test_session.py` の接合点）を同じ名前・同じ接合点で再現したうえで拡張しています。元のコードとの差分確認はできていません。

## 役割分担

| 担当 | 何をするか | いつ |
|---|---|---|
| Anthropic Claude API（`scenario_generator.py`） | 分岐グラフ・発話文・予測返答例を生成 | 会話**前**のみ |
| TTS（`tts.py`、初期実装 OpenAI Speech API） | 承認済み発話文だけを音声化。**Claude とは別の処理** | 会話**前**のみ |
| OpenAI Realtime API（`realtime_session.py`） | 音声を直接聞き、`select_branch` で許可済み分岐 ID を 1 つ返す分類器。音声出力・自由回答は無効 | 会話中 |
| アプリのコード | グラフ検証・状態遷移・再生・キャンセル・タイムアウト・上限の最終決定 | 常時 |

会話中の経路で Claude API・TTS API は呼びません（テストで検証）。予測外の発言には事前生成した聞き返し・担当者案内・終了音声を使います。文字起こし → テキスト分類には置き換えていません。

## 起動

```bash
cd realtime_branch_mvp
pip install -r requirements-dev.txt
cp .env.example .env      # 何も変えなければ全部 MOCK で動く
python app.py             # http://127.0.0.1:8000
```

- 単一プロセス前提（SQLite `data/mvp.sqlite3` + `data/audio/`）。再起動時、実行中だったジョブは `interrupted`、音声生成中の版は `AUDIO_FAILED`、使用中セッションは `aborted` に回収します。
- 127.0.0.1 以外への bind は拒否します。**共有サービスではありません**。公開するには認証・権限制御・利用量制限が別途必要です。

### MOCK と実 API

`.env` の `SCENARIO_PROVIDER` / `TTS_PROVIDER` / `REALTIME_PROVIDER` を `mock` から `claude` / `openai` に切り替えます。UI 上部のバッジに常に MOCK / 実 API を表示します。

- MOCK 分岐生成: 同梱のサンプルグラフ（`fixtures/sample_scenario.json`）を返します（Claude ではありません）。
- MOCK 音声: テキスト長に応じたトーンの WAV（発話ではありません）。
- MOCK Realtime: 音声を理解しません。UI のボタンで発話区間と「暫定/最終で返す分岐」を手動指定し、状態遷移・再生・遅延計測の経路をデモします。

実 API に必要な設定（いずれも未設定なら明確なエラー。モデル ID は推測で補完しません）:

| 変数 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY`, `CLAUDE_SCENARIO_MODEL` | 分岐生成。構造化出力（`output_config.format` json_schema）を既定に、`CLAUDE_OUTPUT_MODE=tool` で strict tool 方式 |
| `OPENAI_API_KEY`, `TTS_MODEL`, `TTS_VOICE`, `TTS_FORMAT` | 音声生成（既定 mp3。ブラウザで decode 可能、サーバーでフレーム検証） |
| `REALTIME_MODEL` | 会話中の分類 |

## 使い方（画面）

1. **応対方針の入力**: 目的・指示（必須）、事実/FAQ、禁止事項、最初の発話案、最大深さ・最大ノード数・分岐数、音声設定（サーバー許可値のみ）。「サンプル指示を入れる」で指示書のサンプルが入ります。
2. **分岐スクリプト生成** → 非同期ジョブ。結果は必ず draft（`REVIEW`）。
3. **レビュー・編集**: ノードごとに発話文、分岐ラベル・種別・遷移先、意図/条件、想定返答例、否定例を編集。構造変更は JSON 編集。「新しい版として保存」で別 version になり、実行中セッションは元の版のまま。
4. **内容を承認して音声生成**（確認チェック必須、承認対象の版を明示）。進捗・完了数・失敗数・概算文字数・キャッシュ再利用数、音声ごとの再生確認、失敗分だけ再試行、ジョブ中止。
5. 全音声 ready かつ検証合格（`READY`）の版だけ **会話開始** が有効になり、サーバー側でも再確認します（音声ファイルの sha256 まで照合）。
6. **会話**: 状態、マイク送信可否、現在ノード、発話文、暫定分岐、確定分岐、次の発話文、音声キャッシュ、遅延指標、エラーを表示。停止はどの状態でも有効。

## 設計の要点

### グラフと意味規約（`scenario_schema.py`, `scenario_validator.py`）
- Pydantic の厳密スキーマ（余分なフィールド禁止）を Claude への JSON Schema と検証で共用。
- ノードに入った時にそのノードの `assistant_text` を 1 回だけ再生。edge は返答文を持たない（二重発話なし）。
- fallback は clarify 種別の control node を再生後、元ノードを再発話せずにその回答受付へ戻る（戻り先はアプリが保持）。
- control node の動作は `RETURN_TO_ORIGIN` / `END` / `GOTO_FIXED_NODE` のみ。終了希望 `ctrl_end_request` はコードが全受付ノードに付与。
- 検証: ID 重複、参照切れ、入口不備、到達不能、非終端の行き止まり、fallback/no-input/終了経路の欠落、通常分岐の循環（DAG 強制）、訂正は浅いノードへ戻るものだけ、深さ・ノード数（control 含む）・分岐数・文字数の上限、動的スロット禁止、資料に無い金額の禁止、約束表現の警告。
- 自由文の事実性はコードで保証できないため、人のレビューを必須にしています。
- Claude への修復要求は最大 2 回（修復は履歴を書き換えない単発リクエスト）。失敗時は架空の ready を作らず失敗にします。429/5xx/タイムアウトは回数制限付き指数バックオフ、ジョブは取消可能、usage を記録。

### 音声キャッシュ（`audio_store.py`, `tts.py`, `jobs.py`）
- キャッシュキー = sha256(キャッシュ仕様 version, Provider, モデル, 声, 形式, 速度, スタイル ID と本文, API 設定, 厳密な発話テキスト)。ノード ID は含めないので、同文・同設定は共有、条件だけの編集は全再利用、発話を変えたノードだけ miss。
- 一時ファイル → fsync → rename の atomic write。DB 登録はその後。WAV は `wave` で decode、MP3 はフレームヘッダを全走査して長さを算出。HTML/JSON のエラーボディは保存しません。
- 並列 2、再試行・最大文字数・最大生成数・timeout あり。音声 URL は 64 桁 hex の ID からのみ解決。

### 発話途中の暫定予測と発話後の最終判定（`realtime_session.py`）
- 受付中の PCM を Realtime に送り続けながら、同時にメモリ上のリングバッファに保持。
- 発話が約 800 ms たまったら、**同じ発話の先頭からの音声**を out-of-band `response.create`（inline `input_audio`）で暫定分類。以降最短 800 ms 間隔、1 発話最大 3 回、同時 1 件（設定可能）。通常バッファは commit/clear しません。
- 暫定結果は UI 表示と音声 prefetch の順序付けだけに使い、状態は変えず、再生もしません。
- `speech_stopped` → committed と item.done 確認後、そのターンの全 item で最終判定。最終判定が始まると暫定は取消/無視。確定分岐の生成済み音声だけを再生します（「料金…ではなくデモ」で暫定=料金でも料金音声は流れない）。
- 早期確定・先走り再生は対象外です。冒頭の数音で最終意図が確定するとは主張しません。
- stale 対策: すべての要求に `session_id / scenario_version / node_id / turn_id / decision_generation / phase / request_key` を付け、サーバー側の対応表と照合。古い版・前ノード・別ターン・重複 done・取消後の到着は適用しません。
- 最終判定中や再発話確認猶予（既定 200 ms、遅延から除外しない）中にユーザーが話し始めたら旧判定を無効化し、複数の確定 item を順に参照して回答全体で再判定。
- item 削除は参照中のリクエストが無くなってから。`input_audio_buffer.clear` は受付開始時のみ。
- 上限: 発話長、リングバッファ、分類リクエスト数、Realtime への送信バッファ。超えたら黙って捨てず明示エラーで安全停止。
- 無音はサーバーの no-input タイマーで処理（`speech_started` を前提にしない）。

### 再生とマイク（半二重）
- 必須モードは半二重。アシスタント音声の再生中はマイク送信を停止（UI に「再生中／マイク送信停止」）。ユーザー回答の受付〜分類中は送信を継続。
- **「ユーザー発話開始からの分岐予測」（実装済み）と「アシスタント発話への割り込み（barge-in）」（未実装）は別機能です。**
- `play` → `playback_started` → `playback_ended` を `playback_id` で照合。古い ended で次の受付は開きません。再生 ack タイムアウトで停止。再生失敗は再試行か停止を案内し、黙って次へ進みません。
- 再生中断ボタンは中断した発話を記録し、そのノードへの回答として受付へ移ります。
- 再生中の切断は次ノードへ進めず、再開始を求めます。開始クリックで AudioContext を resume し、最初の音声を開始前に decode します。

## 遅延指標（測定境界）

サーバーは `time.monotonic`、ブラウザは `performance.now` で計測し、異なる時計の値は引き算しません。

| 指標 | 測定境界 |
|---|---|
| `speech_start_event_to_first_preview_ms` | サーバーが `speech_started` を受信 → 最初の有効な暫定分類を受信 |
| `vad_event_to_branch_ms` | サーバーが `speech_stopped` を受信 → 有効な final 確定（**物理的な発話終了からではない**） |
| `request_to_branch_ms` | final の `response.create` 送信 → 有効な final 受信 |
| `decision_message_to_playback_started_ms` | ブラウザが再生指示を受信 → 実際の再生開始 |
| `client_notification_speech_stopped_to_playback_started_ms` | ブラウザが `speech_stopped` 通知を受信 → 再生開始（参考値） |
| `speech_start_to_next_playback_ms` | `speech_started` → 次の再生指示。**ユーザー自身の発話時間を含むので純粋なシステム遅延ではない** |

ほかに preview/final の選択、preview 変更回数・無効化回数、fallback 理由、音声 cache hit/miss、再生失敗、ターン数、Realtime/Claude の usage（プロバイダが返す範囲。料金額は計算していません）を記録します。

**費用に関する注意**: 暫定分類は発話の途中音声を繰り返し Realtime に送るため、音声入力トークンの課金が増えます（1 発話最大 3 回の preview + final）。

### ログとプライバシー
- 音声原本・全文文字起こしは保存しません。リングバッファはメモリのみで終了時に破棄。
- JSONL（`data/logs/<session>.jsonl`）は ID・タイミング・選択・エラーのみ。API キーや音声 base64 は書きません。ダウンロード前に個人情報の可能性を表示します。

## 安全性
- API キーはサーバーの環境変数のみ。`.env` は Git 管理外。
- Host ヘッダ検証、更新系 HTTP と WebSocket の Origin 検証、更新系は `application/json` 必須、HTTP body・WS フレーム・音声フレーム・生成物に上限。
- CSP（`script-src 'self'`）。モデル生成文字列は `textContent` / `value` でのみ表示（`innerHTML` 不使用をテストで確認）。
- 音声中の「前の指示を無視して」「別の branch を実行して」は分類対象の発言として扱い、許可 enum と状態遷移はコードで強制します。
- 画面に、音声が外部 API に送信されること、AI 生成音声であること、利用料金が発生することを表示しています。

## テスト

```bash
python -m pytest -q          # APIキー不要。104 passed / 3 skipped（有料スモーク）
```

| ファイル | 内容 |
|---|---|
| `tests/test_schema_validator.py` | 正常グラフ、余分なフィールド、ID 重複、参照切れ、入口不備、不正ループ、到達不能、上限、fallback 不足、終端、動的スロット、出典の無い金額 |
| `tests/test_router.py` | 旧固定 router（料金/デモ/サポート）を動的グラフで再現、動的 enum、無効 branch、複数関数、不正引数、failed、聞き返し上限、無応答、訂正、終了希望 |
| `tests/test_generator.py` | Claude Provider（偽クライアント）: 正常、壊れた JSON → 修復、修復上限 2 回、429/5xx バックオフ、timeout、4xx、refusal、取消、tool モード |
| `tests/test_jobs_tts.py` | キャッシュキー、再利用/miss、atomic write、不正形式、途中失敗と失敗分のみ再試行、取消、上限、再起動回収、版の不変性、二重開始 |
| `tests/test_ring_buffer.py` | prefix 切り出し、チャンク境界、退避、奇数バイト、実行時設定の範囲 |
| `tests/test_session.py` | E2E（入口〜終端）、半二重、preview で料金 → final でデモ、preview が final 後に到着、preview 中に commit/clear しない、item モード、final 中の再発話、猶予中の再発話、参照中 item を削除しない、不正出力 → fallback、別 version/別ターン/重複 done、取消後の到着、timeout、no-input、上限、訂正、古い playback ended、再生失敗/中断、ack タイムアウト、切断、停止、cache miss で安全停止（会話中に TTS/Claude を呼ばない）、発話長上限、送信バッファ上限、前ターン音声を含めない |
| `tests/test_app.py` | Origin/Host/Content-Type/サイズの防御、path traversal、生成 → 編集（新版）→ 承認 → READY → セッション、音声欠落で開始拒否、WebSocket E2E（MOCK Realtime）、単回使用セッション、ログ内容 |
| `tests/test_eval_and_frontend.py` | 評価 fixture の整合、`innerHTML` 不使用、秘密情報なし |
| `tests/test_real_api_smoke.py` | **有料**。`RUN_REAL_API=1` の時だけ実行 |

ブラウザ確認: ヘッドレス Chromium で MOCK 構成の UI を通しで操作（生成 → XSS 文字列入り編集の保存 → 承認 → 音声準備 → 会話開始 → 暫定=料金/最終=デモ → デモの音声 → 確認 → 終了）し、コンソールエラーが無いことと XSS が実行されないことを確認しました（Playwright スクリプトはリポジトリ外）。

### 日本語評価セット
`fixtures/eval_ja.json` に正解ラベル付きケース（「料金を知りたい」「デモを見たい」「使い方が分からない」「料金、ではなくデモです」「それは結構です」「大丈夫です」「はい、でもちょっと待って」「前の話に戻って」「終了してください」、無関係、雑音、長い間、無音、音声内の指示文）。曖昧な発言はノードごとに正解を定義しています（例: 用件選択での「大丈夫です」と確認での「大丈夫です」は別ラベル）。

`python eval_realtime.py --i-understand-this-costs-money` で実 Realtime に対して評価します（**有料**）。合成音声（TTS）と人の録音（`fixtures/human/<case_id>.wav`）を分けて集計します。テキストモックでは実音声の精度は保証できません。

## 検証状況と制約

- **実 API・実マイク未検証**です。この開発環境からは api.openai.com / api.anthropic.com へ接続できず、実 API の呼び出しは一度も行っていません。Claude 生成・TTS・Realtime の各実装はコードと偽クライアント/MOCK のテストまでです。
- Realtime のイベント形式は公式サイトに接続できなかったため、openai Python SDK 3.37.0 同梱の GA 型定義（`openai/types/realtime/*`）で確認しました。特に次は実 API で要確認です:
  - out-of-band `response.create` の `input` にインライン `input_audio` を含める方式（暫定分類の既定）。動かない場合は `PREVIEW_AUDIO_MODE=item`。
  - `audio_start_ms` の時間軸が clear で 0 に戻らない前提（`vad_timeline_resets_on_clear`）。
  - `tool_choice: "required"` と `output_modalities: ["text"]` の組み合わせ。
- Claude の構造化出力スキーマは制約キーワード（長さ・件数・pattern 等）を除いたものを送り、サーバーで完全な Pydantic 検証をしています。採用モデルで構造化出力が使えなければ `CLAUDE_OUTPUT_MODE=tool`。
- `CLAUDE_REFUSAL_FALLBACK=default` はベータ機能のため既定 off。
- TTS の `instructions`（発話スタイル）は `tts-1` 系では送りません（キャッシュキーには含めます）。
- MP3 の長さはフレーム走査による算出で、ブラウザでの実 decode はブラウザ側で確認します。
- フル二重・barge-in は未実装（任意機能）。
- 動的スロット（顧客名・日付・金額）の会話中埋め込みは仕様どおり禁止で、検証で止めます。
- 単一プロセス・ローカル専用。複数ワーカーでは動きません。

詳細なイベント仕様: [`docs/API_EVENTS.md`](docs/API_EVENTS.md)
