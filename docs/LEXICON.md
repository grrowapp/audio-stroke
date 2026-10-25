# 日本語 読み替え辞書 / 誤読漢字ルール（Lexicon）

発話文の漢字を音声合成（TTS）が誤読する問題（例: 「承って」→「うやまって」、2026-10-25 実機確認）に対する基本機能。
コード: `server/lib/lexicon.ts`、初期データ: `server/lexicon/ja.json`。

## 仕組み（確定）

1 件のエントリ = `surface`（漢字表記、活用形ごと）+ `reading`（TTS に読ませるかな）+ `category`（`misread` = 誤読が確認された語 / `reading` = 読み指定のみ）+ `note`。

同じデータが 3 箇所で使われる:

| 箇所 | 動作 | 実装 |
|---|---|---|
| 音声化 | TTS に渡す文字列だけを置換。画面・ログ・評価ログの表示文は変えない。置換後の文で音声キャッシュキーを計算するため、辞書変更で該当音声だけ再生成される | `audioStore.buildManifest` → `ManifestEntry.tts_text`、`jobs.runAudio` |
| 生成 | Claude への固定ルールに「誤読しやすい語はひらがなで書く（例: 承っ→うけたまわっ…）」を自動付与（`misread` のみ） | `scenarioGenerator.buildSystemPrompt` ← `misreadGuidance` |
| レビュー | 該当語を含む発話文に警告 `misread_risk`（置換内容を表示） | `scenarioValidator` ← `scanMisreads` |

置換規則: surface の長い順に適用、全出現を置換、置換済みの読みの中は再マッチしない（`applyReadings` のテストで保証）。

## 追加のしかた（今）

- 同梱辞書: `server/lexicon/ja.json` の `entries` に追記（活用形ごとに 1 件。`note` に確認日と現象を書く）→ コミット。
- 運用側の追加: 同形式の JSON を用意し `LEXICON_PATH=/path/to/extra.json`。同じ `surface` は後勝ち（同梱 < ファイル）。
- 反映: サーバー再起動で読み込み。`/api/config` の `lexicon`（件数・ソース）で確認。既存の READY 版は辞書変更後に「承認して音声生成」をやり直すと該当音声だけ再生成される（他はキャッシュ再利用）。

## ロードマップ（確定内容）

ソースは `LexiconSource`（`name` + `load()`）で差し替え可能。段階ごとに追加する。

| 段階 | 内容 | 実装タイミング | 状態 |
|---|---|---|---|
| 1 | 同梱 JSON + 任意ファイル（`LEXICON_PATH`）。マージ・検証・3 用途への適用 | 本コミット | 済 |
| 2 | DB 格納（`node:sqlite` に `lexicon` テーブル: surface / reading / category / note / source / updated_at）。起動時 bootstrap: 同梱 JSON を `source=bundled` として冪等に登録（schema_version で版管理、手動編集行は上書きしない）。管理 API（一覧・追加・無効化）と管理画面の辞書タブ | 本番化の前（MVP 検証完了後の最初の機能追加）。辞書件数が JSON 手編集で回らなくなった時点でも前倒し | 未着手 |
| 3 | RAG 等の検索可能 DB（ベクトル/全文）へ移行し、文脈依存の読み分け（同形異音語: 行う/行く、他/ほか 等）を周辺文で判定。TTS の `gpt-realtime-2.1-mini` 移行（Speech API 停止 2027-01-06）と同時に設計 | TTS 移行着手時 | 未着手 |

段階 2・3 でも `applyReadings` / `misreadGuidance` / `scanMisreads` の契約（入力: 文 + Lexicon、出力: 置換文・適用一覧 / 指示文 / 該当一覧）は変えない。呼び出し側（manifest・生成・検証）は無変更で済む設計。

## 初期データ

| surface | reading | 経緯 |
|---|---|---|
| 承っ / 承り / 承る / 承れ | うけたまわっ / うけたまわり / うけたまわる / うけたまわれ | `gpt-4o-mini-tts` が「うやまって」と誤読（2026-10-25、ユーザー実機確認） |

未確認の語は入れない。誤読が確認できた語を、確認日と現象を `note` に残して追加する。
