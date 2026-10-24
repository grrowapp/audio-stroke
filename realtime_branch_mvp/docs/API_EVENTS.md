# API / イベント仕様メモ

## HTTP API（すべて 127.0.0.1 のみ。更新系は同一 Origin + `application/json` 必須）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/config` | Provider（MOCK か実 API か）、許可された音声設定、上限値、指標の測定境界 |
| POST | `/api/scenarios/generate` | 応対方針 → 非同期生成ジョブ。`{job_id, mock}` |
| GET | `/api/jobs/{job_id}` | ジョブの状態・進捗・usage・失敗理由 |
| POST | `/api/jobs/{job_id}/cancel` | ジョブ取消 |
| GET | `/api/scenarios/{id}/versions` | 版一覧 |
| GET | `/api/scenarios/{id}/versions/{v}` | 版の内容・状態・検証結果・音声集計 |
| POST | `/api/scenarios/{id}/validate` | 保存せずに検証 `{base_version, scenario}` |
| POST | `/api/scenarios/{id}/versions` | 編集を **新しい版** として保存 `{base_version, scenario}` |
| POST | `/api/scenarios/{id}/versions/{v}/approve` | 指定版を承認して音声生成開始 `{voice, confirm_reviewed: true}` |
| POST | `/api/scenarios/{id}/versions/{v}/audio/retry` | 失敗した音声だけ再生成 |
| GET | `/api/scenarios/{id}/versions/{v}/manifest` | 音声 manifest（hash・長さ・MIME・状態・キャッシュ再利用） |
| GET | `/api/audio/{audio_id}` | 音声配信。`audio_id` は 64 桁 hex（アプリ生成のキャッシュキー）のみ |
| POST | `/api/sessions` | READY 版を固定したセッション作成 `{scenario_id, version, request_id?, runtime?}` |
| GET | `/api/sessions/{id}/log.jsonl` | 評価ログ（JSONL） |
| WS | `/ws?session_id=…` | 会話。1 セッション 1 回だけ接続可能 |

版の状態: `REVIEW`（draft）→ `AUDIO_PREPARING` → `READY` / `AUDIO_FAILED`。
ジョブの状態: `queued` / `running` / `succeeded` / `failed` / `canceled` / `interrupted`（再起動で回収）。

## WebSocket（ブラウザ ⇄ サーバー）

ブラウザ → サーバー
- バイナリフレーム: PCM16 mono 24 kHz（最大 500 ms/フレーム）。`mic_enabled` が真の間だけ送る。
- `{"type":"playback_started"|"playback_ended"|"playback_failed"|"playback_canceled","playback_id":…}`
- `{"type":"playback_retry"}` / `{"type":"stop"}`
- `{"type":"client_metric","name":…,"value_ms":…}`（ブラウザ時計 `performance.now` で計測）
- MOCK のみ: `{"type":"mock_vad","action":"start"|"stop","preview_branch":…,"final_branch":…}`

サーバー → ブラウザ
- `state`: `phase`, `mic_enabled`, `speaking`, `node_id`, `turn_id`, `decision_generation`, `scenario_version`, counters
- `play`: `playback_id`, `turn_id`, `decision_generation`, `utterance_key`, `audio_id`, `url`, `text`, `terminal_after`
- `prefetch`: 候補音声 ID（暫定分岐があればそれを先頭に）
- `speech_started` / `speech_stopped`
- `preview`（暫定。表示と prefetch 順だけに使う）/ `final`（確定）/ `final_invalidated`
- `metric`（サーバー側の遅延値）/ `playback_error` / `finished`

## OpenAI Realtime（GA 形式。openai SDK 3.37.0 の型定義で確認）

接続: `wss://api.openai.com/v1/realtime?model=$REALTIME_MODEL`、ヘッダ `Authorization: Bearer …`（`OpenAI-Beta` ヘッダは付けない）。

1. `session.update`: `type:"realtime"`, `output_modalities:["text"]`,
   `audio.input.format {type:"audio/pcm", rate:24000}`,
   `audio.input.turn_detection {type:"server_vad", silence_duration_ms, prefix_padding_ms, threshold, create_response:false, interrupt_response:false}`。
   VAD が勝手に応答を作らない設定。
2. 受付中は `input_audio_buffer.append` を送り続ける（分類中も止めない）。
3. **暫定分類（preview）**: `speech_started` 後、同じ発話の先頭からの PCM（メモリ上リングバッファから切り出し）を
   `response.create {conversation:"none", input:[…既確定item_reference, {type:"message", role:"user", content:[{type:"input_audio", audio:<b64>}]}], tools:[select_branch], tool_choice:"required", metadata:{…phase:"preview"}}`
   で送る。通常バッファは commit/clear しない。`PREVIEW_AUDIO_MODE=item` では `conversation.item.create`（クライアント指定 id）→ `conversation.item.done` を待って `item_reference` で参照し、終了後に削除する。
4. **最終判定（final）**: `speech_stopped` → `input_audio_buffer.committed` と `conversation.item.done` を確認後、そのターンの全 item を順に `item_reference` して `response.create`（`phase:"final"`）。
5. `response.done` は metadata（`session_id`, `scenario_version`, `node_id`, `turn_id`, `decision_generation`, `phase`, `request_key`）とサーバー側の対応表で照合し、status・function call 数・関数名・JSON・enum を検証。不一致や失敗は fallback（`ctrl_unclear`）。
6. 確定後は再発話確認猶予（既定 200 ms）を経て遷移・再生。猶予中に `speech_started` が来れば旧判定を無効化（generation を進める）し、新しい発話を含む全体で再判定。
7. item 削除は、その item を参照する未完了リクエストが無くなってから行う。`input_audio_buffer.clear` は受付開始時（マイク送信再開前）だけ。

`select_branch` の enum = 現在ノードの edge id + `ctrl_unclear` + `ctrl_end_request`。

## 時間軸の前提（要・実 API 照合）

`audio_start_ms` は「セッション中にバッファへ書かれた全音声の先頭からのミリ秒」（SDK 型定義の説明）として扱い、clear で 0 に戻らないと仮定しています（`RuntimeSettings.vad_timeline_resets_on_clear=False`）。切り出し開始位置は「その受付の開始サンプル」より前にならないよう下限をかけ、前ターンやアシスタント再生中の音声を混ぜません。実 API で挙動が異なる場合はこのフラグを切り替えてください。
