# Core プロトコル（応答速度に関わる部分をネイティブ実装へ差し替えるための境界）

応答速度に直接関わる処理は `server/core/` に隔離し、ホスト（Nitro の HTTP/WS、SQLite、Vue UI）からは `Engine` インターフェース（`server/core/types.ts`）だけを見ます。

```
ブラウザ ──WS(JSON / 0x01+PCM16)──▶ Nitro ws route ──Engine I/F──▶ core ──WS──▶ OpenAI Realtime
                                                     │
                                   createEngine()    ├─ ConversationEngine（TypeScript, in-process）
                                                     └─ SubprocessEngine（ネイティブ実行ファイル, stdio）
```

| 層 | 責務 | 差し替え |
|---|---|---|
| `core/pcmRing.ts` | 送信済み PCM の保持と prefix 切り出し | ネイティブで再実装対象 |
| `core/transports.ts` | Realtime WebSocket（イベント in/out） | ネイティブで再実装対象 |
| `core/engine.ts` | VAD イベント処理、preview/final、barge-in、再生指示、stale 判定、タイマー | ネイティブで再実装対象 |
| `core/runtime.ts` | 実行時設定と範囲 | 共有（JSON） |
| `core/types.ts` | `Engine` / `EngineHost` / `MetricsSink` / `AudioReadiness` | 契約 |
| `core/factory.ts` | `ENGINE_IMPL` で実装選択 | ホスト |
| `core/subprocessEngine.ts` | ネイティブ core を子プロセスとして駆動するアダプタ | ホスト |

`ConversationEngine` は Node API を直接使いません（乱数・base64・タイマー・時計・ログは `EngineHost` 経由）。ロジックは単一キューで直列化された状態機械なので、同じ順序規則を別言語で実装できます。

## 1. ホスト ⇄ core（`SubprocessEngine` の stdio 契約）

フレーミング（双方向）: `4 バイト big-endian 長さ` + `1 バイト tag` + payload。長さは tag を含む。

- `tag 0x00`: JSON（UTF-8）
- `tag 0x01`: PCM16 mono 24 kHz（ブラウザ → core のみ。WS の `0x01` タグ付きフレームの中身をそのまま転送）

### ホスト → core（JSON）
| `channel` | 内容 |
|---|---|
| `init` | 起動直後に 1 回。`session_id`, `scenario`（固定版）, `manifest`（音声 ID・テキスト・状態）, `runtime`（`RuntimeSettings`）, `realtime` `{url, model, apiKey, mock, previewAudioMode}`, `audio_paths` `{audio_id: 絶対パス}` |
| `browser` | `msg` = ブラウザからの JSON（`playback_started` / `playback_ended` / `playback_failed` / `playback_canceled` / `playback_retry` / `stop` / `client_metric` / `mock_vad` / `_disconnect`） |

### core → ホスト（JSON）
| `channel` | 内容 |
|---|---|
| `browser` | `msg` = ブラウザへ送る JSON（下記 §2 と同一） |
| `metrics` | `kind: "inc"` `{name, n}` / `kind: "event"` `{name, fields}` / `kind: "usage"` `{usage}` |
| `exit` | `{reason, phase}`。送ったら core は終了する |

ホストは `browser.msg.type === "state"` から `phase` を、`"finished"` から `phase` と `reason` を取り出してセッション記録に使います。core が `exit` を送らずに終了した場合は `ERROR` 扱いです。

API キーは `init` で渡します（stdio は同一マシン内）。ログに書かないこと。

## 2. core ⇄ ブラウザ（JSON、実装共通）

ブラウザ → core: `playback_started` / `playback_ended` / `playback_failed{error}` / `playback_canceled{position_ms, reason}` / `playback_retry` / `stop` / `client_metric{name, value_ms, playback_id, turn_id}` / `mock_vad{action, preview_branch, final_branch}`（MOCK のみ）。`_` で始まる type はホスト専用（`_disconnect`）。

core → ブラウザ:
- `state{phase, mic_enabled, speaking, node_id, node_label, node_text, turn_id, decision_generation, scenario_id, scenario_version, playing_key, interruptible, barge_in_enabled, counters, mock_realtime}`
- `play{playback_id, turn_id, decision_generation, utterance_key, audio_id, url, text, mime, terminal_after, interruptible}`
- `playback_stop{playback_id, reason}` / `interrupted{playback_id, utterance_key, text, position_ms, remaining_ms}` / `playback_error{playback_id, utterance_key, message}`
- `prefetch{audio_ids}` / `speech_started{turn_id}` / `speech_stopped{turn_id}`
- `preview{turn_id, branch_id, label, next_text, reason, provisional: true}` / `final{turn_id, branch_id, label, next_text, reason, fallback_reason, grace_ms}` / `final_invalidated{reason, turn_id}`
- `metric{name, value_ms}` / `finished{phase, reason, message, counters, realtime_usage}`

## 3. core ⇄ Realtime

`docs/API_EVENTS.md` の「OpenAI Realtime」節のとおり（`session.update`、`input_audio_buffer.append`、out-of-band `response.create`、metadata 照合、`response.cancel`、`conversation.item.delete`）。

## 4. 実装が守るべき不変条件（テストで検証しているもの）

1. 暫定分類は状態を変えず再生もしない。最終判定の許可 enum 内の分岐だけが状態を更新する。
2. preview のために通常バッファを commit/clear しない。
3. `response.done` は `session_id / scenario_version / node_id / turn_id / decision_generation / phase / request_key` を照合し、古い・別版・重複・取消後の結果を適用しない。
4. 最終判定中・猶予中の再発話は旧判定を無効化し、全 item で再判定する。
5. 参照中の item を削除しない。`input_audio_buffer.clear` は受付開始時／割り込み可能な再生の開始前だけ。
6. 再生 ack は `playback_id` で照合し、古い `playback_ended` で次の受付を開かない。terminal は ack 後に FINISHED。
7. barge-in: 確認猶予内に止まった発話は棄却、超えた発話で `playback_stop` → 中断ノードへの回答。終端・GOTO は割り込み不可。
8. 事前生成音声が無ければ合成せず安全停止（会話中に TTS/Claude を呼ばない）。
9. 発話長・バッファ・リクエスト数・送信バッファの上限超過は明示エラーで停止。
10. 遅延指標の測定境界（`docs`/README）を変えない。

`tests/session.test.ts` の `Harness` は `Engine` インターフェースだけに依存するので、ネイティブ core も `SubprocessEngine` 経由で同じテストを流せます（`tests/subprocessEngine.test.ts` の偽 core を参照）。
