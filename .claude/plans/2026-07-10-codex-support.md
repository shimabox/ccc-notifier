# Codex CLI コスト通知対応 実装プラン(2026-07-10)

OpenAI Codex CLI のターン毎コストを、Claude Code と同じ体験(OS/Slack 通知・履歴・ダッシュボード・sweep)で扱えるようにする。

- ブランチ: `feat/codex-support`(ベース: main = v0.2.0 `3cf3139`。**PR #7「通知なしモード」を含む**)
- スコープ: **フル対応を1PRで**(init / track / doctor / uninstall / ダッシュボード / sweep / docs)
- 実装体制: 別紙 [2026-07-10-codex-implementation-orchestration.md](2026-07-10-codex-implementation-orchestration.md)(オーケストレーション = Fable 5、実装 = サブエージェント)

## 0. v0.2.0(PR #7)との整合

main に「通知なしモード(記録・ダッシュボードのみ)」が入ったことによる本プランへの影響:

- **init の対話**: 通知チャネルは4択(`os` / `slack` / `both` / `none`)になった。Codex の質問は**チャネルとは直交**
  (「どこの hook に入れるか」の話)なので、チャネル選択の後・独立した confirm として追加する。
  **`--no-notify` と `--codex` は併用可**(通知なしで Codex 分も記録だけしたいユースケースは正当)。
- **track の通知判定**: `(notify.os || notify.slack !== null) && costUSD >= minNotifyUSD && !isMuted()` に
  変わった(両チャネル無効なら todayTotalUSD の走査ごとスキップ)。Codex 経路は同じ共通判定を通るため**追加対応不要**。
- **doctor**: 両チャネル無効時は ✅「通知なしモード」で早期 return する構造になった。Codex 診断ブロックは
  その**手前(hook 登録系のセクション)**に置く(通知チェックとは独立)。
- **contracts.md**: 2026-07-10 の「通知なしモード」節が末尾に追加済み。本件の契約はさらにその後ろに追記する。
- バージョン: 本件マージ後は v0.3.0 を想定。
- 決定事項(ユーザー確認済み):
  1. sweep の Codex 対応も v1 に含める(ローカルに過去73セッションあり、導入直後からダッシュボードが埋まる)
  2. コストは **Claude+Codex 合算**(通知の「今日」・月予算・サマリー)+ ダッシュボードに **ソースフィルタ**(全体/Claude/Codex)とターン履歴のソースバッジ
  3. 導入 UX は **既存 `init` に統合**(~/.codex 検出時に対話で確認、非対話は `--codex` / `--no-codex`)

---

## 1. 調査結果(事実・ローカル Codex 0.142.5 で確認済み)

### 1-1. フック機構
- Codex には Claude Code とほぼ同じ **hooks 機構**がある。設定は **`~/.codex/hooks.json`**(JSON。config.toml とは別ファイル)。
- 利用可能イベント(バイナリより): `PreToolUse` / `PermissionRequest` / `PostToolUse` / `PreCompact` / `PostCompact` / `SessionStart` / `UserPromptSubmit` / `SubagentStart` / `SubagentStop` / **`Stop`**。
- 旧来の `notify = [...]`(config.toml)は `legacy_notify` 扱い。**Stop hook を使う**(トークン集計に必要な transcript_path が取れるのはこちら)。
- hooks.json の形式は Claude Code の settings.json の hooks とほぼ同じ:
  ```json
  { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "..." } ] } ] } }
  ```
- **Stop hook の stdin ペイロードは実機で捕獲済み**(2026-07-10・下記「実機検証結果」)。実物:
  ```json
  {"session_id":"019f4bee-...","turn_id":"019f4bee-...",
   "transcript_path":"/Users/<user>/.codex/sessions/2026/07/10/rollout-2026-07-10T21-09-25-<uuid>.jsonl",
   "cwd":"/Users/<user>/shimabox/github/ccc-notifier","hook_event_name":"Stop",
   "model":"gpt-5.5","permission_mode":"default","stop_hook_active":false,
   "last_assistant_message":"2です。"}
  ```
  → 既存の `StopHookInput` 型・「stdin JSON → transcript_path を読む」という track の骨格が**そのまま流用できる**。
  **`model` がペイロードに含まれる**ため、モデル特定は payload を第一ソース、rollout の `turn_context` をフォールバック(sweep 用)にできる。
- **信頼(trust)の仕組み**(ソース精読 + 実機確認済み):
  - hook は `enabled && (bypass || trust_status ∈ {Managed, Trusted})` のときだけ実行。**未信頼はサイレントに実行されない**(`codex exec` では確認 UI が無いので黙ってスキップされる)。
  - trusted_hash = イベント名+matcher+コマンド等を正規化 TOML にした sha256。config.toml に
    `[hooks.state."<hooks.jsonパス>:stop:0:0"] trusted_hash = "sha256:..."` として保存(位置インデックスキー)。
  - **TUI 起動時に「Hooks need review」**が表示され、`Review hooks` / `Trust all and continue` / `Continue without trusting (hooks won't run)` から選択。承認すると trusted_hash が書かれ、以後発火する。
  - ccc-notifier からは config.toml(信頼状態)に一切触らない。init 完了時の案内文言はこの実 UX に合わせる。
  - 自動テスト等での回避フラグは `codex exec --dangerously-bypass-hook-trust`(1回限り・危険フラグなので docs には載せない)。

### 1-2. セッション(rollout)ファイル
- 置き場所: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
- 1行 = `{ timestamp, type, payload }`。type は `session_meta` / `turn_context` / `event_msg` / `response_item`。
- 必要データの所在:
  - **セッション情報**: `session_meta.payload` → `session_id` / `cwd` / `cli_version`
  - **モデル**: `turn_context.payload.model`(例 `"gpt-5.5"`。ターン毎に記録)
  - **プロンプト**: `event_msg.payload { type: "user_message", message }`
  - **トークン**: `event_msg.payload { type: "token_count", info: { total_token_usage, last_token_usage }, rate_limits }`
    - `total_token_usage` = **セッション累積**、`last_token_usage` = 直近 API コール分
    - 内訳: `input_tokens` / `cached_input_tokens` / `output_tokens` / `reasoning_output_tokens` / `total_tokens`
    - **`input_tokens` は `cached_input_tokens` を含む**(OpenAI usage の仕様)
    - **`output_tokens` は `reasoning_output_tokens` を含む**(reasoning は output 課金)
  - **ターン境界**: `event_msg.payload { type: "task_complete", turn_id, last_agent_message }`

### 1-3. 課金モデル(OpenAI)と既存パイプラインへの写像
- OpenAI は「cache write 課金なし・cached input は割引単価」。
  cost = (input − cached) × input単価 + cached × cacheRead単価 + output × output単価
- 既存 `TokenBuckets` への写像(**computeCost / 表示系を一切変えずに済む**):
  ```
  input        := max(0, input_tokens − cached_input_tokens)   // 非キャッシュ入力
  cacheRead    := cached_input_tokens
  cacheWrite5m := 0
  cacheWrite1h := 0
  output       := output_tokens                                 // reasoning 込み
  ```
- 単価(USD/1M tok、LiteLLM 実データで確認):
  | モデル | input | output | cacheRead |
  |---|---|---|---|
  | gpt-5.5 | 5.00 | 30.00 | 0.50 |
  | gpt-5.1 / gpt-5 / gpt-5-codex / gpt-5.1-codex | 1.25 | 10.00 | 0.125 |
  | o3 | 2.00 | 8.00 | 0.50 |
- 現行 `loadPriceTable` は LiteLLM 取り込み時に **Claude 系のみにフィルタ**している(キャッシュ pricing.json が23キー)→ OpenAI 系も取り込むよう拡張が必要。

---

## 2. 設計

### 2-1. 新規/変更モジュール一覧

| ファイル | 変更 | 内容 |
|---|---|---|
| `src/codex/transcript.ts` | 新規 | rollout パーサ(`aggregateCodexTurn`) |
| `src/codex/setup.ts` | 新規 | hooks.json の追記/削除(バックアップ・非破壊マージ) |
| `src/codex/env.ts` | 新規 | `codexHome()`(`CCCN_CODEX_HOME` \|\| `~/.codex`)・検出 |
| `src/types.ts` | 変更 | `TurnRecord.source?: 'codex'`、`Cursor.codexTotals?` |
| `src/pricing.ts` | 変更 | builtin に OpenAI 単価追加・LiteLLM フィルタ拡張 |
| `src/format.ts` | 変更 | `modelDisplayName` に GPT 系追加 |
| `src/track.ts` | 変更 | `runTrack(stdin, { codex })` 分岐 |
| `src/cli.ts` | 変更 | `track --codex` 配線 |
| `src/setup.ts` | 変更 | init に Codex 質問 + `--codex`/`--no-codex`、uninstall 拡張 |
| `src/doctor.ts` | 変更 | Codex 診断ブロック追加 |
| `src/sweep.ts` | 変更 | `~/.codex/sessions` 走査を追加 |
| `src/dashboard.ts` | 変更 | ソースフィルタ・ソースバッジ・embed に `sc` |
| `docs/codex.md` | 新規 | 導入手順・仕組み・制限 |
| `README.md` | 変更 | 特徴/導入に Codex 追記 |

### 2-2. rollout パーサ(`src/codex/transcript.ts`)

```ts
aggregateCodexTurn(rolloutPath: string, cursor: Cursor | null): Promise<TurnAggregate | null>
```

- 既存 `aggregateNewTurn` と同じ契約(「カーソル以降を読み、新規 usage が無ければ null」)。戻り値も既存 `TurnAggregate` を流用(`sidechain` は常に空、`gitBranch` は null)。
- ウィンドウ内の抽出:
  - モデル: 最後の `turn_context.payload.model`(1ターン1モデル)
  - プロンプト: 最後の `user_message.message`
  - cwd: `turn_context.payload.cwd` → 無ければ hook stdin の `cwd`
- **トークン集計 = 累積カウンタの差分方式**:
  - `Cursor.codexTotals?: { input, cached, output }` に前回スナップショットを保存
  - 新規 usage = ウィンドウ内最後の `total_token_usage` − `codexTotals`
  - 重複イベント・集計イベントに免疫がある(合算方式だと二重計上リスク)
  - **差分が負**(コンパクション等でカウンタがリセットされた場合)→ ウィンドウ内 `last_token_usage` の合算にフォールバック
  - `info` が null の token_count(レートリミット更新のみ)はスキップ
- 破損行スキップ・サイズガード(2GiB)・オフセット管理は既存 transcript.ts の規約を踏襲。
- Cursor は既存 `cursors.json` に rollout パスをキーとして共存(`sanitizeCursor` に `codexTotals` の通過を追加)。

### 2-3. track(`runTrack` の分岐)

- hooks.json に登録するコマンド: `"<node絶対パス> <cli.js絶対パス> track --codex"`(マーカー判定は既存 `matchesMarker` を command 文字列に適用)
- `runTrack(stdinText, { codex: true })`:
  1. StopHookInput をパース(同形式)→ `transcript_path`
  2. `aggregateCodexTurn` → null なら即終了
  3. `loadPriceTable(offline: true)` + `computeCost`(そのまま動く)
  4. `getUsdJpy` → `TurnRecord { source: 'codex', models: ['gpt-5.5'], ... }` を appendTurn
  5. 通知判定(`costUSD >= minNotifyUSD && !isMuted()`)・OS/Slack 通知・ダッシュボード自動再生成 — **全て既存共通経路**
- `stop_hook_active` は気にしない(track は常に stdout 無し・exit 0。ループさせる要素がない)
- **サブエージェント(collab agents)は v1 対象外**(SubagentStop・`agent_transcript_path` はあるが、まずメインスレッドのみ。docs に制限として明記)

### 2-4. TurnRecord / 合算ポリシー

- `source?: 'codex'`(optional。**無し = Claude**。`ingest` と同じ後方互換パターン。schemaVersion は 1 のまま)
- `todayTotalUSD()` / `currentMonthTotals()` / report / サマリー = **合算のまま変更なし**(1つの財布)
- 通知タイトルは既存フォーマットのまま(モデル名 `GPT-5.5` で自然に区別される)

### 2-5. pricing

- `builtinPriceTable()` に追加(USD/1M):
  `gpt-5.5`(5/30/0.5)・`gpt-5.1`・`gpt-5`・`gpt-5-codex`・`gpt-5.1-codex`(各 1.25/10/0.125)・`o3`(2/8/0.5)
  ※ cacheWrite5m/1h = 0。既存の最長プレフィックス一致で `gpt-5.5-codex` 等の派生も受けられる
- LiteLLM 取り込みフィルタを拡張: 従来の claude 系に加え、`litellm_provider === 'openai'` かつキーが `gpt-` / `o3` / `codex-` で始まるエントリを採用(`cache_read_input_token_cost` → cacheRead、write 系は 0)
- `modelDisplayName`: `gpt-5.5 → GPT-5.5`、`gpt-5-codex → GPT-5 Codex` など(一般規則: `gpt` を大文字化しハイフンを空白/保持で整形。`o3` はそのまま)

### 2-6. init / uninstall(`src/setup.ts` + `src/codex/setup.ts`)

- **検出**: `codexHome()`(= `CCCN_CODEX_HOME` || `~/.codex`)ディレクトリの存在
- **対話**: 既存質問(チャネル4択・ラベル・レート・予算)の後、検出時のみ
  「Codex CLI を検出しました。Codex にもコスト通知を入れますか?」(confirm・既定 Yes)。
  通知チャネルとは直交(`none` を選んでいても Codex の記録は有効化できる)
- **案内文言**(実 UX 確認済み): init 完了時に
  「次回 `codex` 起動時に **Hooks need review** が表示されます。**Trust all and continue**(または Review して承認)を選ぶと通知が有効になります。承認するまで hook は動きません」
- **非対話**: `--codex`(強制導入)/ `--no-codex`(スキップ)。**`--yes` のみの場合は Codex に触らない**(非対話で予期しないファイルを編集しない方針)
- **hooks.json 編集**(settings.json と同じ流儀):
  - 無ければ `{ "hooks": {} }` から作成
  - 書き込み前に `hooks.json.bak-<timestamp>` バックアップ
  - `hooks.Stop` 配列にマーカー一致エントリが既にあれば置換、無ければ追記(**既存の PermissionRequest 等は一切触らない**)
  - JSON として壊れていたら自動編集を諦め、手動追記内容を表示するだけ(既存ポリシー踏襲)
- **信頼確認の案内**: init 完了時に「次回 codex 起動時に hook の承認を求められたら許可してください」を表示
- **uninstall**: hooks.json からマーカー一致の Stop エントリを削除(バックアップ付き)。`--purge` は共通データディレクトリの削除で従来どおり

### 2-7. doctor

- 「Codex」ブロックを追加(検出時のみ・未検出なら1行スキップ表示):
  - `~/.codex` 検出 / hooks.json に ccc-notifier の Stop エントリがあるか(コマンド全文表示)
  - `sessions/` ディレクトリ存在
  - config.toml の `model = "..."`(先頭レベルの1行を正規表現で読むだけ。TOML パーサは入れない)に単価があるか
  - 信頼状態は検証不能のため、未承認の可能性がある旨の注意書きのみ

### 2-8. sweep

- 既定で Claude(`~/.claude/projects`)に加えて **Codex(`codexHome()/sessions/**/rollout-*.jsonl`、YYYY/MM/DD の3階層)** も走査(未検出ならスキップ)
- ターン分割: `task_complete` イベントを境界に、境界ごとの `total_token_usage` 差分で per-turn usage を復元(hook と同じ差分規約 → カーソル相互運用可)
- 去重: 既存カーソル(rollout パスがキー)で hook 取り込み済み分を自然にスキップ
- active-session guard(mtime 5分)・`--dry-run`・`--days`・`ingest: 'sweep'` は共通。レコードに `source: 'codex'` を付与
- サマリーにソース別の件数/金額を表示

### 2-9. ダッシュボード

- embed の turn に `sc: 'codex' | undefined` を追加(容量節約で Claude は undefined)
- **ソースフィルタチップ**: 粒度トグルの隣に `[全体] [Claude] [Codex]`(Codex レコードが1件も無ければ非表示)。選択は `sessionStorage`(`cccn-src`)で自動リロードを跨いで保持
- フィルタはブラウザ側集計(チャート・モデル別・プロジェクト別・ターン履歴・KPI)に適用。**月予算カードは常に合算**(「AI全体の財布」なので。カード内に小さく明記)
- ターン履歴の行に `Codex` バッジ(モデル名でも判別できるが一目で分かるように)
- slot 配色は従来どおり全履歴のモデル別総コストで決定(gpt 系モデルが自然に色を持つ)

### 2-10. 環境変数・テスト

- 追加 env: `CCCN_CODEX_HOME`(既定 `~/.codex`。init/doctor/sweep/テストで使用)
- テスト:
  - `codex-transcript.test.ts`: 実 rollout を無害化した fixture で、差分方式・負差分フォールバック・info:null スキップ・プロンプト/モデル抽出・TokenBuckets 写像
  - `pricing.test.ts` 追加: OpenAI builtin・LiteLLM フィルタ・プレフィックス解決(`gpt-5.5-codex` → `gpt-5.5`)
  - `setup.test.ts` 追加: hooks.json 新規作成/追記/置換/バックアップ/壊れた JSON/既存 PermissionRequest 保持/`--codex`/`--no-codex`/uninstall
  - `track.test.ts` 追加: `track --codex` e2e(CCCN_DRY_RUN)・`source:'codex'` 記録
  - `sweep.test.ts` 追加: sessions 走査・ターン分割・去重・active guard
  - `dashboard.test.ts` 追加: `sc` embed・フィルタ UI 要素・バッジ
- **実データ検証**(コード外・実装後に手元で実施):
  1. `sweep --dry-run` を実際の `~/.codex/sessions`(73ファイル)に対して実行し、クラッシュなし・金額が妥当かを確認
  2. 実際に `init --codex` → codex を1ターン動かし、信頼確認 UX と通知到達を確認

---

## 3. 実装順(コミット分割)

1. `feat(pricing)`: OpenAI 単価(builtin + LiteLLM フィルタ)+ `modelDisplayName`
2. `feat(codex)`: `src/codex/env.ts` + rollout パーサ + Cursor 拡張(+ テスト)
3. `feat(track)`: `track --codex` 経路 + `TurnRecord.source`(+ テスト)
4. `feat(setup)`: init/uninstall の hooks.json 対応 + doctor(+ テスト)
5. `feat(sweep)`: Codex sessions 走査(+ テスト)
6. `feat(dashboard)`: ソースフィルタ + バッジ(+ テスト)
7. `docs`: README + `docs/codex.md`(導入・仕組み・制限・信頼確認の案内)

---

## 4. リスクと対応

| リスク | 対応 |
|---|---|
| ~~hook 信頼確認の UX が不明~~ → **実機検証済み** | TUI 起動時の「Hooks need review」で承認。init の案内文言に反映済み。**承認までサイレント不発火**なので doctor は「登録済みでも未承認の可能性」を必ず注意書きする |
| `total_token_usage` がコンパクション等でリセット | 負差分検出 → `last_token_usage` 合算へフォールバック。実データ73件で検証 |
| Codex の hooks.json スキーマ差異(matcher 等) | ユーザーの実ファイル(PermissionRequest)と同じ形を踏襲。最小構造(type/command のみ)で登録 |
| gpt-5.5 系の新派生モデル(単価未知) | LiteLLM 自動更新 + プレフィックス一致 + unknownModels 表示(既存機構) |
| Codex のサブエージェント usage 未計上 | v1 の明示的な制限として docs に記載(将来 SubagentStop で拡張可能) |
| 定額プラン(ChatGPT Plus/Pro)利用時の金額の意味 | Claude と同じ「API換算」ラベルの考え方を docs/codex.md に明記 |

## 5. 実機検証結果(2026-07-10 実施)

実装前に最大の仮定(ペイロード形式・信頼 UX)を実験で事実化した。手順と結果:

1. `~/.codex/hooks.json` に「stdin をファイルへダンプするだけの Stop hook」を一時追加(既存 PermissionRequest は保持)
2. `codex exec` では**発火しない**ことを確認 → openai/codex のソース(rust-v0.142.5 の `hook_runtime.rs` / `hooks/src/engine/discovery.rs`)を精読し、**未信頼 hook はサイレントスキップ**が原因と特定
3. ユーザーが TUI で `codex` を起動 → **「Hooks need review / 1 hook is new or changed.」**が表示 → 「Trust all and continue」承認 → 1ターン実行
4. **Stop hook が発火し、実ペイロードを捕獲**(1-1 に記載。`model` フィールド入り)。config.toml に `hooks.json:stop:0:0` の trusted_hash が書かれることも確認
5. 同セッションの rollout で `turn_context.model` / `user_message` / `token_count(total/last)` の存在を再確認
6. 実験 hook を撤去し原状復帰(config.toml に残る stop:0:0 の trusted_hash は無害な孤児エントリ。本実装の hook はコマンドが異なるので再度 review が出る=期待どおり)

これによりリスク表の上位2件(ペイロード形式・信頼 UX)が解消済み。

## 6. スコープ外(将来)

- Codex サブエージェント/collab スレッドのコスト集計
- Codex の `notify`(legacy)経路のサポート
- レートリミット情報(`rate_limits.plan_type` 等)の表示活用
