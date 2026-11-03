# 判定バックエンド（DecisionBackend）: 「聞く・判定する」の差し替え境界

通話中に音声を聞いて分岐を決める部分を、会話エンジンから切り離して差し替え可能にする。
エンジン（`server/core/engine.ts`）は状態機械・再生・上限・stale 判定を持ち続け、バックエンドは
「発話の始まり・終わりの合図」と「許可された分岐 ID から 1 つ選ぶ」だけを担う。

```
会話エンジン ──DecisionBackend（server/core/decision.ts）──┬─ RealtimeBackend   OpenAI Realtime（VAD＋音声判定を 1 本で）
                                                          └─ SttJudgeBackend   SttProvider ＋ JudgeProvider ＋ 内蔵 VAD
                                                                 ├─ SttProvider:   revai / deepgram / google / mock
                                                                 └─ JudgeProvider: clef / jev / openai_compat（ローカル LLM）/ mock
```

## 契約（`server/core/decision.ts`）

| 方向 | 名前 | 意味 |
|---|---|---|
| エンジン → BE | `start` | 接続・設定。受け入れ可能になったら `ready` |
| エンジン → BE | `pushAudio(pcm)` | 通話者の PCM16 24 kHz |
| エンジン → BE | `clearInput()` | 参照されていない時だけ呼ぶ。取り込み済み音声を捨てる |
| エンジン → BE | `classify(req)` | `key`, `phase`(preview/final), 選択肢 `allowed`, ノード, 直前の質問, 履歴, この turn の `utteranceIds`, preview 時は `activeUtteranceId` と `prefixPcm`, `metadata` |
| エンジン → BE | `cancel(key)` / `release(ids)` / `close()` | 取消 / 参照解除 / 終了 |
| BE → エンジン | `ready` | 最初の案内を流してよい |
| BE → エンジン | `speech_started{utterance_id, audio_start_ms}` / `speech_stopped{…}` | VAD の合図 |
| BE → エンジン | `utterance_ready{utterance_id}` | その発話を `classify` で参照できる（Realtime: committed＋item.done、STT: 文字あり） |
| BE → エンジン | `decision{key, ok, branch_id, reason, confidence, metadata_ok, error, usage}` | 判定結果。`ok=false` は不正出力・エラー |
| BE → エンジン | `error{key?, code, message}` | `key` 付きはその要求だけ失敗 |

エンジンが守る不変条件（`docs/CORE_PROTOCOL.md` §4）はそのまま。バックエンドが返す `branch_id` が
`allowed` の外なら `ok=false` にする（エンジン側でも再検査する）。

## RealtimeBackend

既存の `RealtimeTransport` を包み、OpenAI のイベント（`session.update`, `input_audio_buffer.*`,
`conversation.item.*`, `response.create/cancel/done`, metadata の往復）を上の契約に翻訳する。
preview の音声渡し（inline / item）と temp item の削除はバックエンド内部で完結する。
テストの `ScriptedTransport` と UI の MOCK（`MockRealtimeTransport`）はこの経路で従来通り動く。

## SttJudgeBackend

- **VAD**: SttProvider が合図を持つなら（Deepgram の SpeechStarted / UtteranceEnd、mock）それを使う。
  無ければ内蔵のエネルギー VAD（RMS しきい値 `STT_VAD_RMS`、無音長は runtime の `silence_duration_ms`、
  先頭余白は `prefix_padding_ms`）。音声の時間軸は push した総サンプル数（clear で巻き戻さない）。
- **文字の帰属**: provider の partial / final に付く時刻（Rev.ai `ts/end_ts`、Deepgram `start/duration`）で
  発話区間に割り当てる。時刻が無い provider は「発話中に届いた文字はその発話」とみなす。
- **utterance_ready**: `speech_stopped` 後、final が届いたら即。届かなければ `STT_FINAL_WAIT_MS` 後に
  最後の partial で確定。文字が無ければ空文字（判定は `ctrl_unclear`）。
- **classify**: preview は `activeUtteranceId` の現在の文字（partial 可）＋前の発話の final を連結。
  final は `utteranceIds` の final を連結。JudgeProvider に「選択肢 → 説明」と文脈を渡し、
  確率付きで 1 つ受け取る。`confidence < JUDGE_UNCLEAR_THRESHOLD` なら `ctrl_unclear`。
- **JudgeProvider**: 契約は 1 つ（`decide(context, options) → {choice, confidence, probabilities}`）。
  - clef / jev: System One 形式（`state` + `questions.branch{type:choice, criteria}`）。
  - openai_compat: OpenAI 互換 `chat/completions`（vLLM, llama.cpp 等のローカル LLM）。`response_format` の
    JSON Schema で `branch_id` を enum に固定し、確率は返らないので `confidence` は 1.0 固定。
  - mock: 外部から選択を与える（テスト / UI）。

## 設定

| 変数 | 値 | 既定 |
|---|---|---|
| `DECISION_BACKEND` | `realtime` / `stt_judge` / `mock` | `REALTIME_PROVIDER=openai` なら `realtime`、それ以外 `mock` |
| `STT_PROVIDER` | `revai` / `deepgram` / `google` / `mock` | `mock` |
| `JUDGE_PROVIDER` | `clef` / `jev` / `openai_compat` / `mock` | `mock` |
| `JUDGE_MODEL` | 例 `clef-flash`, `clef`, `jev-latest`, ローカルのモデル名 | `clef-flash` |
| `JUDGE_UNCLEAR_THRESHOLD` | 0〜1 | `0.5` |
| `JUDGE_URL` / `JUDGE_API_KEY` | openai_compat のベース URL（例 `http://127.0.0.1:8000/v1`）と任意のキー | |
| `STT_VAD_RMS` / `STT_FINAL_WAIT_MS` | 内蔵 VAD の RMS しきい値 / final 待ち | `500` / `1200` |
| 各社キー | `REVAI_ACCESS_TOKEN`, `DEEPGRAM_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`+`GOOGLE_PROJECT_ID`, `CF_ACCOUNT_ID`+`CF_API_TOKEN`, `TYPESAFE_API_KEY` | |

バックエンドは起動時に固定（通話途中の切替はしない）。`/api/config` の `providers.decision` と
セッションの `state.backend` に名前が出る。

## 評価との関係

`server/scripts/evalStt.ts`（STT 3 社 ＋ Clef / Jev の比較）は provider 実装より先に書かれ、接続コードを
自前に持つ。`server/core/stt/*` / `server/core/judge/*` への置き換えは段階 3 で行う。
評価で測った「話し終わり → 文字確定」「判定」の時間は、エンジン側の `vad_event_to_branch_ms` /
`request_to_branch_ms` と同じ境界で比較できる。

## ネイティブ core（subprocess）

`SubprocessEngine` の `init` には従来どおり `realtime` 設定を渡す。ネイティブ側が STT+Judge を実装する
場合は `decision` 設定を追加する（未実装、契約は本書のとおり）。

## 段階

| 段階 | 内容 | 状態 |
|---|---|---|
| 1 | 契約の導入、engine を契約だけに依存させる、RealtimeBackend（既存テストが通る） | 済 |
| 2 | SttJudgeBackend ＋ revai / deepgram / google / mock、clef / jev / openai_compat / mock、テスト（`tests/sttJudge.test.ts`）、設定・`/api/config`・UI 表示 | 済 |
| 3 | ブラウザ実機での Realtime vs Rev.ai+Clef 比較、評価スクリプトの provider 共用化、ネイティブ core への `decision` 設定 | 未着手 |
