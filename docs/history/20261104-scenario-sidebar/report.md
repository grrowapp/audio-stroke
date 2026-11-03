# シナリオ一覧サイドメニュー（feature/scenario-sidebar）

## 現状調査（変更前）
- 保存: `DATA_DIR`（既定 `data/`）の SQLite `mvp.sqlite3`（`node:sqlite`）。`scenario_versions(scenario_id, version, status, data_json, validation_json, generator, parent_version, voice_json, manifest_json, created_at, approved_at)`。版は不変、編集は新版。
- 状態: `REVIEW`(下書き) / `AUDIO_PREPARING` / `AUDIO_FAILED` / `READY`（`server/lib/scenarioStore.ts`）。承認済み = `approved_at` あり。
- 分岐グラフ型: `server/lib/scenarioSchema.ts`（title, nodes[edges], control_nodes, policy, design_notes, source_instruction/source_facts/constraints）。音声は manifest（`utterance key = node:<id>|control:<id>`）。
- API: `GET /api/scenarios`（`{scenario_id, latest, updated}` のみ。`cli/phone.ts` が使用）、`GET /api/scenarios/:sid/versions[/:ver[/manifest]]`、`/api/sessions`。
- UI: `ssr:false` の SPA。`app/app.vue` は `<NuxtPage/>` のみ、ページは `app/pages/index.vue` 1 枚（PolicyForm→ReviewEditor→AudioPrep→ConversationPanel）。既存ナビ・既存のシナリオ詳細画面なし。
- テスト: vitest。`tests/app.test.ts` はビルド済み Nitro を別プロセス起動して HTTP/WS 検証、他は unit。ブラウザ e2e の仕組みは無い。

## 変更ファイル
- `server/lib/scenarioStore.ts` — `listScenarioSummaries()` 追加（読み取りのみ）
- `server/api/scenarios/summaries.get.ts` — 新規 `GET /api/scenarios/summaries`
- `app/app.vue` — サイドバー + コンテンツのレイアウト
- `app/components/ScenarioSidebar.vue` — 新規（一覧・空状態・エラー・折りたたみ・15 秒ごと再読込）
- `app/pages/scenarios/[sid].vue` — 新規 読み取り専用詳細
- `app/composables/scenarioView.ts` — 状態ラベル/日時整形
- `app/assets/css/main.css` — 追記のみ
- `tests/scenarioSummaries.test.ts`（新規 unit 3 件）、`tests/app.test.ts`（HTTP 1 件追加）
- `README.md` — サイドメニューと API の説明を追記
- 新しい依存の追加: なし（動作確認用の playwright-core は /tmp にのみ導入、repo 非追加）

## 動作確認手順
1. `npm run build && PORT=8123 npm start`（または `npm run dev`）→ `http://127.0.0.1:8123/` の左側にサイドメニュー。
2. 項目クリック → `/scenarios/<scenario_id>`（版は `?v=`）。
3. 「◀ 閉じる」で折りたたみ。幅 720px 以下は初期状態で閉じる。

## テスト結果
- `npm test`: 13 ファイル / 116 件合格（既存 112 + 追加 4）。`nuxt build` 成功。
- 別ポート 8123（mock プロバイダ、一時 DATA_DIR）+ Chrome(playwright-core) で確認:
  - 0 件: 「作成済みのシナリオはまだありません。」表示、コンソール/ページエラー 0
  - 一覧に 下書き / 承認済み・利用可能 が表示、項目選択で入力文・音声 13/13・発話文・グラフ表が表示、下書きは音声「なし」
  - 存在しない ID は「シナリオが見つかりません」表示
  - 27 件でサイドメニュー内スクロール（ページ全体は伸びない）
  - 折りたたみ/再展開、390px 幅で初期閉じ・選択後閉じ、横スクロールなし（グラフ表は表内スクロール）

## 解釈した点
- シナリオ名 = `scenario.title`（欠損時は ID）。作成日時 = 全版の最小 `created_at`。状態は最新版の `status` を既存 4 値の日本語ラベルで表示（承認済み = `READY`/`AUDIO_*`）。
- 既存 `GET /api/scenarios` は cli が使うため形を変えず、別 endpoint `summaries` を追加。
- 既存詳細画面が無いため、読み取り専用の詳細ページを新設。編集・承認・会話開始は従来のトップ画面のまま（トップから既存シナリオを開き直す機能は範囲外）。
- 「承認版の発話文」は承認済みの版でそう表記し、未承認版は「発話文（下書き。未承認）」と表示。
- ブラウザ e2e の基盤が無く依存追加を避けたため、追加テストは unit + HTTP API、UI は上記手動 playwright 確認。
