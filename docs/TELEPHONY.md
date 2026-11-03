# 電話着信接続（設計）

状態: 設計（未実装）。2026-11-01 ユーザー承認の方式に基づく。

## 1. 要件

- 顧客がアプリ／Web で指定した電話番号への着信を、本システムへ転送して応対する。
- **どの指定番号に掛かったか** で発話内容（シナリオ）を切り替える。
- 電話機（設置端末）による転送ではなく、より上流（キャリア網／クラウド）で転送する。

## 2. 方式（確定）

**指定番号 1 件ごとに専用の受付番号（Twilio 番号）を割り当て、顧客が自分の回線のキャリア網内転送で、指定番号から専用番号へ転送を設定する。**
着信時は Twilio の `To`（着信先 = 専用番号）で指定番号を一意に特定し、紐づいたシナリオで応対する。

| 比較した方式 | 判定 | 理由 |
|---|---|---|
| 専用番号 + キャリア網内転送 | **採用** | 顧客の番号は動かない。即日開始・転送解除で即復旧。`To` で確実に判別できる |
| 共有番号 1 つ + `ForwardedFrom` で判別 | 不採用 | `ForwardedFrom` はキャリアによっては値が入らない（Twilio 公式）。判別不能な着信が出る |
| 番号ポータビリティ（指定番号を当社 Twilio へ移転） | 不採用 | 3〜4 週間・委任状が必要。当社が番号の再販扱い。障害時に元回線へ戻す逃げ道が無い |
| 当社がキャリアの遠隔操作で転送を自動設定 | 不採用 | 顧客の暗証番号を預かる必要がある。転送先は登録リストからのみ。アクセス番号が地域ごとに異なる |
| OpenAI Realtime の SIP 直結 | 不採用 | 本システムは「事前生成音声の再生 + Realtime はテキストで分類のみ」。SIP 経路でアプリ自身の音声を流す手段は公式資料に記載が無い |

キャリア網内転送の例: NTT 東西「ボイスワープ」（無条件転送は電話機を鳴らさず転送。転送区間の通話料は契約者負担）、携帯各社の転送でんわサービス。

## 3. 全体構成

```
発信者 ─PSTN─▶ 指定番号（顧客の回線）
                 │ キャリア網内転送（顧客が設定）
                 ▼
             専用番号（Twilio）
                 │ ① voice webhook (HTTPS POST, To/From/CallSid)
                 ▼
  Nitro  POST /api/telephony/voice ── To で番号ルート表を引く → セッション作成 → TwiML 応答
                 │ ② <Connect><Stream url="wss://…/ws/twilio"> (<Parameter session_id>)
                 ▼
  Nitro  /ws/twilio ── 電話アダプタ（ホスト層）──Engine I/F──▶ core（既存のまま）──▶ OpenAI Realtime
```

**設計原則: core（`server/core/`）は変更しない。** 電話アダプタはホスト層に置き、core から見て「もう 1 種類のブラウザ」として振る舞う。`docs/CORE_PROTOCOL.md` の不変条件と既存の `Harness` テストはそのまま成立する。

## 4. 着信フロー

1. **voice webhook** `POST /api/telephony/voice`（Twilio の form-urlencoded）
   - `X-Twilio-Signature` を検証（不一致は 403）。
   - `To`（E.164）で番号ルート表を引く。無い・無効なら `<Reject/>`。
   - 紐づく版について、`sessions/index.post.ts` と同じ検査（READY、グラフ検証、manifest 欠落、音声内容一致）を行う。HTTP 経由で呼ばず、検査とセッション作成を共有関数に切り出して両方から使う。
   - 電話用音声アセット（§6）の欠落も検査する。
   - 同時セッション上限（`MAX_CONCURRENT_SESSIONS`、ブラウザと共用）を超えるなら `<Reject reason="busy"/>`。
   - 失敗判定はすべてこの時点で行う。Stream 接続後に失敗すると発信者は無音になるため。
   - Twilio の webhook は 15 秒が上限（超過で通話失敗）。応答は DB 参照のみで返し、外部 API を呼ばない。
   - 応答 TwiML:
     ```xml
     <Response>
       <Connect>
         <Stream url="wss://{PUBLIC_HOST}/ws/twilio">
           <Parameter name="session_id" value="{session_id}"/>
         </Stream>
       </Connect>
       <Hangup/>
     </Response>
     ```
     Stream の URL にクエリは付けられないため、`session_id` は `<Parameter>` で渡す。
2. **media stream** `/ws/twilio`
   - 既存の `/ws` は Origin 許可リスト・`session_id` クエリ・認証 cookie を要求するため、Twilio 用に別ルートを置く。
   - ハンドシェイクの `X-Twilio-Signature` を検証する（Twilio は Media Streams の WS ハンドシェイクにも署名する。検証失敗時は URL 末尾に `/` を付けて再検証せよとの公式注記あり）。
   - `start` 受信時に `customParameters.session_id` を読み、`claimSession`（1 回限り）→ `createEngine`。
   - engine 終了（`finished`）で WS を閉じる → Twilio が後続の `<Hangup/>` を実行して切断。
   - Twilio の `stop`（通話終了）→ engine に `_disconnect`。

## 5. 電話アダプタの変換規則

| 方向 | Twilio 側 | Engine 側 |
|---|---|---|
| 着信音声 | `media`（base64 μ-law 8 kHz） | μ-law → PCM16 → 24 kHz へアップサンプル → `pushBrowserAudio` |
| 再生開始 | `play{playback_id, audio_id}` を受けて、電話用アセットを `media` で送出（ヘッダ無しの生 μ-law） | 送出開始時に `playback_started` |
| 再生完了 | 送出直後に `mark{name: playback_id}`。Twilio が再生完了時に同名の mark を返す | 現行 playback の mark なら `playback_ended` |
| 割り込み停止 | `playback_stop` を受けて `clear` を送る | `playback_canceled{position_ms}` |
| 終了 | WS を閉じる | `finished` |
| 通話断 | `stop` | `_disconnect` |
| 表示系 | なし | `state` / `preview` / `final` / `metric` / `prefetch` などは送り先が無いので破棄（ログのみ） |

注意点:

- **Realtime の入力形式は PCM16 24 kHz のまま** 変えない（`pcmRing` と engine がこの前提）。Realtime の `audio/pcmu` 直接入力は core の変更になるため後段の選択肢とする。
- **`clear` 後の mark**: Twilio は `clear` 時に未再生の mark をすべて返してくる。clear 済み playback の mark は破棄する。そうしないと古い `playback_ended` で次の受付を開き、不変条件 6 に反する。
- **`position_ms`**: Twilio は再生位置を返さない。送出開始からの経過時間で推定し、音声長で頭打ちにする。
- **遅延指標の境界**: 電話では「Twilio へ最初の音声を送出した時刻」までを測る。Twilio から PSTN 区間は測れない。

## 6. 電話用音声アセット

- Twilio に送れるのはヘッダ無しの μ-law 8 kHz のみ。会話中に変換しない（不変条件 8「会話中に TTS を呼ばない」と同じ考え方で、準備は承認後の音声生成ジョブで済ませる）。
- 音声生成ジョブで、各 manifest エントリの元音声から電話用の派生アセット（μ-law 8 kHz）を作り、同じ音声ストアに保存する。派生アセットの ID は元の `audio_id` + 形式 + 変換器版から決める。
- 変換は Node だけで行う（Render に ffmpeg・mp3 デコーダを持ち込まない）。そのため **電話を有効にする場合は `TTS_FORMAT=wav`** とし、WAV ヘッダの標本化周波数を読んで 8 kHz へ（低域通過 + 間引き）→ μ-law 符号化する。`TTS_FORMAT=mp3` のまま電話を有効にした場合は起動時に設定エラーとする。
- 電話用アセットが 1 つでも欠けた版では、webhook でセッションを作らない（§4）。

## 7. データ: 番号ルート表

`phone_routes`（SQLite、既存 DB に追加）:

| 列 | 内容 |
|---|---|
| `called_number` (PK) | 専用番号（Twilio 番号、E.164） |
| `customer_number` | 顧客が指定した番号（E.164）。表示・疎通確認用 |
| `scenario_id`, `version` | 応対に使う版。**版を固定** する（既存の「承認した版を固定して使う」運用に合わせる）。版の差し替えは明示操作 |
| `enabled` | 受付可否 |
| `verified_at` | 転送の疎通確認が取れた日時（§8） |
| `created_at`, `updated_at` | 監査用 |

## 8. 番号登録と転送の疎通確認

1. 顧客がアプリで指定番号と、使うシナリオ（承認済みの版）を登録する。
2. システムが専用番号を割り当てる（T1/T2 は事前購入した番号から手動割当。自動購入は T3）。
3. アプリが専用番号と、キャリア別の転送設定手順（ボイスワープ、携帯各社）を表示する。
4. 疎通確認:
   - **当社の検証用発信番号（Twilio 番号 1 つ、全顧客共用）から指定番号へ発信** し、専用番号に `From = 検証用番号` の着信が届いたら `verified_at` を記録する。
   - 顧客自身が専用番号へ直接掛けた着信は、転送経由の着信と区別できない（`ForwardedFrom` はキャリア依存）。そのため顧客側からのテスト発信では、指定番号の転送設定の証明にならない。

## 9. 設定（追加予定の環境変数）

| 変数 | 内容 |
|---|---|
| `TELEPHONY_PROVIDER` | `off`（既定）/ `twilio` |
| `TWILIO_ACCOUNT_SID` | 疎通確認の発信（REST）に使用 |
| `TWILIO_AUTH_TOKEN` | 署名検証と REST に使用。ログ・チャットに出さない |
| `PUBLIC_HOSTNAME` | 既存。署名検証の URL と Stream の `wss://` URL の組み立てに使用 |

## 10. 前提（ユーザー作業・リードタイムあり）

- Twilio アカウント作成。
- 日本の番号購入前の規制書類（Regulatory Bundle）提出と承認。用途は「AI 音声による着信応対」と明記する。当社が番号の利用者でない場合は再販扱いになり得る（Twilio 公式）。
- 専用番号の購入（050 / 0ABJ / 0800）。0120 はコンソールからの取得が難しいとの記載あり。

## 11. ホスティング制約（未決定）

Render の無料枠では電話の検証ができない。

- アイドル 15 分でスピンダウンし、起動に約 1 分かかる。Twilio の webhook 上限 15 秒を超え、アイドル後の最初の着信が失敗する。
- ファイルシステムが揮発し、再起動・再デプロイでシナリオ・番号ルート・音声が消える（永続ディスクは有料インスタンスのみ）。

電話の検証をどこで動かすかは未決定（候補: Render 有料インスタンス + 永続ディスク、ローカル Mac + 公開トンネル）。

## 12. 実機検証が必要な未確認事項

- ボイスワープ等の転送先に 050 番号（または 0ABJ の Twilio 番号）を指定できるか。
- 転送された着信で、元の発信者番号が `From` に届くか（発信者番号で分岐する将来要件の前提）。
- `ForwardedFrom` が日本のキャリアで入るか（入れば補助情報として記録する）。
- Twilio Media Streams の処理リージョンと、日本からの往復遅延。

## 13. 段階

| 段階 | 内容 |
|---|---|
| T1 | 専用番号 1 つ。番号ルート表（手動登録）、voice webhook、`/ws/twilio`、電話アダプタ、電話用音声アセット。実機で転送 → 応対 → 切断と遅延を測る |
| T2 | 複数番号。管理画面での登録・シナリオ紐づけ、転送設定手順の表示、疎通確認（§8） |
| T3 | Twilio API での番号自動購入・解約 |

## 出典

- Twilio Media Streams WebSocket メッセージ: https://www.twilio.com/docs/voice/media-streams/websocket-messages
- Twilio `<Stream>`: https://www.twilio.com/docs/voice/twiml/stream
- Twilio Media Streams 概要（署名検証）: https://www.twilio.com/docs/voice/media-streams
- Twilio webhook 接続上限（15 秒）: https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides
- Twilio TwiML（`ForwardedFrom` / `To`）: https://www.twilio.com/docs/voice/twiml
- Twilio 日本の番号移転・規制: https://www.twilio.com/en-us/guidelines/jp/porting / https://twilio.com/guidelines/jp/regulatory
- OpenAI Telephony and SIP: https://developers.openai.com/api/docs/guides/voice-sip
- Render 無料枠: https://render.com/docs/free / 永続ディスク: https://render.com/docs/disks
- NTT 西日本 ボイスワープ ガイド: https://flets-w.com/opt/hikaridenwa_support/pdf/voice.pdf
