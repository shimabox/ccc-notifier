# Codex 対応 実装オーケストレーションプラン(2026-07-10)

機能仕様は [2026-07-10-codex-support.md](2026-07-10-codex-support.md)(実機検証済み)。
本書は「誰が・何を・どの順で・どのモデルで」実装するかを定める。

- ベース: main = v0.2.0(`3cf3139`、PR #7 通知なしモード込み)
- ブランチ: `feat/codex-support`

## 0. 役割分担(大原則)

| 役割 | 担当 | 責務 |
|---|---|---|
| オーケストレーター | **私(Fable 5)** | タスク分解・契約設計・モデル選定・各 Wave 完了時のレビューゲート(typecheck / 全テスト / 差分・契約準拠レビュー)・実データ検証・コミット分割・PR。**実装はしない** |
| 実装 | サブエージェント(Agent ツール) | 担当ファイルのみを契約どおりに実装 + 自タスクのテスト同梱 |
| 最終 E2E | ユーザー | 実機での `init --codex` → codex 起動 → hook 信頼承認 → 通知確認 |

### 実行の仕組み

- 各 Wave の独立タスクは **Agent ツールで並列起動**(1メッセージで複数同時)。`model` を明示指定
- 修正依頼は同一エージェントに SendMessage(コンテキスト維持)。**2回失敗 → 上位モデルの新規エージェントに交代**(Sonnet→Opus→Fable)
- エージェントはコミットしない。コミットは私がゲート通過後に機能単位で作成

### 並列実装を成立させる鍵: 契約ファースト + ファイル所有権

- Wave 0 で `src/types.ts` 追記・`src/contracts.md` 追記・テストフィクスチャ(正解値つき)を確定(契約全文は §4。設計は本書=私、転記と検証は T0)
- 各タスクは**所有ファイル以外に触れない**(§2 の表)。契約と食い違う実装が必要になったら、改変せず報告して停止

## 1. 共通実装規約(全エージェントのプロンプトに埋め込む)

1. 契約(`src/contracts.md` と本プラン抜粋)は不可侵。矛盾を見つけたら実装せず報告
2. 所有ファイル以外を編集しない。新規依存パッケージを追加しない
3. コメント・命名・エラーメッセージは既存コードの流儀(日本語コメント・バイリンガル CLI 出力)に合わせる
4. 終了前に `npx tsc --noEmit` と `npx vitest run test/<担当>.test.ts` を通す。**`npm run build` と全体 vitest は禁止**(並列中の競合防止。全体検証は私のゲートで実施)
5. 既存テストを書き換えない(自タスクで追加するテストのみ)。仕様上どうしても既存テストの更新が必要な場合は報告
6. 秘密情報・実在の webhook/パスをフィクスチャに入れない(`/home/user` 系プレースホルダ)

## 2. Wave 構成・ファイル所有権・依存

```
W0  T0 契約転記 + fixtures                     [Sonnet]                     1体
W1  T1 pricing/format [Sonnet] ∥ T2 codex core [Fable] ∥ T3 hooks.json編集 [Opus]   3体並列
W2  T4 track/cli [Opus] ∥ T5 init/uninstall/doctor [Opus] ∥ T6 sweep [Opus] ∥ T7 dashboard [Opus]   4体並列
W3  T8 docs + e2e テスト                        [Sonnet]                     1体
G   最終ゲート(私 + ユーザー実機確認)
```

| タスク | 所有ファイル | 依存 |
|---|---|---|
| T0 契約 | `src/types.ts` `src/contracts.md` `src/store.ts`(sanitizeCursor のみ) `test/fixtures/codex/*` `test/store.test.ts`(1ケース追記) | — |
| T1 pricing/format | `src/pricing.ts` `src/format.ts` `test/pricing.test.ts` `test/format.test.ts`(新規) | T0 |
| T2 codex core | `src/codex/env.ts` `src/codex/transcript.ts` `test/codex-transcript.test.ts` | T0(fixtures) |
| T3 hooks.json 編集 | `src/codex/setup.ts` `test/codex-setup.test.ts` | T0 |
| T4 track/cli | `src/track.ts` `src/cli.ts` `test/track.test.ts` | T2(aggregateCodexTurn), T1 |
| T5 init/uninstall/doctor | `src/setup.ts` `src/doctor.ts` `test/setup.test.ts` `test/cli.test.ts` | T3(registerCodexHook 等) |
| T6 sweep | `src/sweep.ts` `test/sweep.test.ts` | T2(splitIntoCodexTurnDrafts) |
| T7 dashboard | `src/dashboard.ts` `test/dashboard.test.ts` | T0(TurnRecord.source のみ) |
| T8 docs+e2e | `README.md` `docs/codex.md`(新規) `docs/faq.md` `test/e2e.test.ts` | W2 完了 |

Wave 内でファイル所有は完全に素(そ)。types.ts / contracts.md は W0 以降凍結(変更が必要になったら私が判断して単独コミット)。

## 3. モデル選定と理由

| タスク | モデル | 理由 |
|---|---|---|
| T0 契約転記 + fixtures | **Sonnet 5** | 本書からの転記 + フィクスチャ整形。判断の余地が少ない |
| T1 pricing/format | **Sonnet 5** | 単価転記・フィルタ拡張・表示名。仕様が完全に規定済み |
| T2 codex core(rollout パーサ) | **Fable 5** | **金額の正確性を握る最重要部**。累積差分カーソル・負差分フォールバック・ターン分割・hook↔sweep 相互運用の意味論はこのタスクが定義する。ここの誤りは全額を狂わせる(初期実装で transcript パーサに Opus を使った前例より一段上げる: 差分方式は新規設計のため) |
| T3 hooks.json 編集 | **Opus 4.8** | **ユーザーの `~/.codex/hooks.json` を編集 = 破壊リスク最大**。非破壊マージ・バックアップ・壊れた JSON の手動フォールバック(settings.json 編集と同格の慎重さ) |
| T4 track/cli | **Opus 4.8** | フェイルセーフ境界(Codex 本体を絶対に妨げない)+ 全モジュール統合 |
| T5 init/uninstall/doctor | **Opus 4.8** | PR #7 直後の setup.ts への追記(4択チャネルとの直交性・排他フラグの整合)+ doctor の診断品質 |
| T6 sweep | **Opus 4.8** | 二重計上防止・active guard・カーソル相互運用。契約(T2 が定義)への忠実さが問われる |
| T7 dashboard | **Opus 4.8** | 埋め込み JS(文字列内クライアントコード)へのフィルタ追加は壊しやすい。XSS 不変条件の維持必須 |
| T8 docs + e2e | **Sonnet 5** | 手順書と E2E シナリオは仕様プランに規定済み |

エスカレーション上限: Fable 5。

## 4. 契約(W0 で転記する全文)

### 4-1. `src/types.ts` 追記

```ts
// Cursor に追加(optional・後方互換):
codexTotals?: { input: number; cached: number; output: number };
// Codex rollout の total_token_usage 累積スナップショット(差分集計用)。Claude transcript では常に undefined。

// TurnRecord に追加(optional・後方互換、schemaVersion は 1 のまま):
source?: 'codex';  // 無し = Claude Code。ingest と同じ流儀
```

`store.ts` の `sanitizeCursor` は codexTotals(3キーとも有限な非負 number のときのみ)を通す。不正なら undefined に落とす。

### 4-2. `src/codex/env.ts`

```ts
export function codexHome(): string;   // CCCN_CODEX_HOME || join(homedir(), '.codex')
export function detectCodex(): boolean; // codexHome() がディレクトリとして存在するか(statSync, 例外は false)
```

### 4-3. `src/codex/transcript.ts`

```ts
export function aggregateCodexTurn(rolloutPath: string, cursor: Cursor | null): Promise<TurnAggregate | null>;
export function splitIntoCodexTurnDrafts(rolloutPath: string, cursor: Cursor | null): Promise<CodexTurnDraft[] | null>;
export interface CodexTurnDraft {
  agg: TurnAggregate;      // ターン1件分(下記規約で構築)
  endTs: string | null;    // そのターン最後のイベント timestamp(record.ts に使う)
}
```

共通パース規約:
- カーソル: `offset`(バイト)から EOF まで。行は `\n` 終端のみ処理(書きかけ行は次回)。破損 JSON 行はスキップして続行
- `offset > ファイルサイズ` はフルリスキャン(offset 0 から。`lastTs` 以前の行はスキップ)— 既存 aggregateNewTurn と同じガード
- token 集計 = **逐次ステップ差分方式**(リセット・重複イベントの両方に免疫):
  ```
  prev = cursor.codexTotals ?? {input:0, cached:0, output:0}
  acc  = {0,0,0}
  ウィンドウ内の各 token_count(info あり)について:
    step = info.total_token_usage − prev            // 成分ごと
    if (stepのいずれかが負) step = info.last_token_usage   // リセット(コンパクション等)フォールバック
    acc += step; prev = info.total_token_usage       // prev は常に「最後に観測した実カウンタ」
  ```
  - 重複/集計イベント(同じ total が再送)→ step = 0 で自然に無害
  - リセット後も prev が実カウンタに追従するため、次ウィンドウから差分方式に自己復帰する
- `info` が null/欠損の token_count はスキップ。acc がゼロ(token_count ゼロ件含む)なら **null を返す**(新規 usage なし)
- TokenBuckets 写像(acc に適用): `input = max(0, acc.input − acc.cached)` / `cacheRead = acc.cached` /
  `output = acc.output` / `cacheWrite5m = cacheWrite1h = 0`
- モデル: ウィンドウ内最後の `turn_context.payload.model`。無ければ `"unknown"`(呼び出し側 track は hook payload の `model` を優先できるよう、TurnAggregate.main のキーに使う)
- プロンプト: ウィンドウ内最後の `event_msg/user_message` の `message`。cwd: 最後の `turn_context.payload.cwd` → `session_meta.payload.cwd`
- `sessionId`: `session_meta.payload.session_id` → 無ければファイル名の uuid 部
- sidechain = `{}`、gitBranch = null、apiCalls = ウィンドウ内 token_count(info あり・step≠0)件数
- newCursor: `offset` = 処理済み末尾、`codexTotals` = prev(最後に観測した total_token_usage。フォールバック発生時も同じ)、
  `lastTs` = 最後のイベント timestamp、`lastUuid` = null、`seenMessageKeys` = []
- `splitIntoCodexTurnDrafts` は同じウィンドウを `task_complete` 境界で分割し、**各セグメントに同じ逐次ステップ規約**を適用
  (prev はセグメントを跨いで持ち回る。末尾に task_complete 後の token_count が残る場合は最後のドラフトに含める)。
  **全ドラフトの acc 合計・適用後の newCursor は、同一ウィンドウに対する aggregateCodexTurn の結果と一致**(hook ↔ sweep 相互運用)

### 4-4. `src/codex/setup.ts`

```ts
export function codexHooksFile(): string; // join(codexHome(), 'hooks.json')
export function codexHookCommand(nodePath: string, cliPath: string): string; // `"<node>" "<cli>" track --codex`(空白対応の quote は Claude 側 hook と同じ流儀)
export interface CodexHookResult { status: 'written' | 'unchanged' | 'manual'; backupPath: string | null; manualSnippet?: string; }
export function registerCodexHook(nodePath: string, cliPath: string): CodexHookResult;
export function removeCodexHook(): CodexHookResult;  // マーカー一致エントリを除去。hooks.json が無ければ unchanged
```

- 非破壊マージ: 既存の他イベント(PermissionRequest 等)・他 Stop エントリを一切変更しない。`hooks.Stop` 配列に
  `{ hooks: [{ type: 'command', command }] }` を追記。マーカー(`matchesMarker` を command に適用)一致の既存エントリがあれば置換(重複登録防止)
- 書き込み前に `hooks.json.bak-<timestamp>` バックアップ(新規作成時はバックアップなし)
- JSON パース不能 → 書き込まず `status: 'manual'` + 追記スニペット返却(呼び出し側が表示)
- 末尾改行付き・2スペースインデントで整形(既存ファイルの見た目を維持)

### 4-5. `src/pricing.ts` / `src/format.ts`

- `builtinPriceTable()` に追加(USD/1M・write 系 0):
  `gpt-5.5`(5, 30, cacheRead 0.5)/ `gpt-5.1` `gpt-5` `gpt-5-codex` `gpt-5.1-codex`(1.25, 10, 0.125)/ `o3`(2, 8, 0.5)
- LiteLLM 取り込み: 既存 claude フィルタに加え、`litellm_provider === 'openai'` かつキーが `/^(gpt-|o3($|-)|codex-)/` に一致し
  `input_cost_per_token`+`output_cost_per_token` を持つエントリを採用。`cache_read_input_token_cost` → cacheRead、write 系 0
- `modelDisplayName`: `gpt-5.5-codex → GPT-5.5 Codex` / `gpt-5-codex → GPT-5 Codex` / `gpt-5.5 → GPT-5.5` /
  `o3 → o3`。一般規則: `gpt` プレフィックスを `GPT` に、`-codex` サフィックスを ` Codex` に、その他ハイフン区切りは既存 claude 系の流儀に準拠

### 4-6. `src/track.ts` / `src/cli.ts`

- `runTrack(stdinText: string, opts?: { codex?: boolean }): Promise<void>`(既存呼び出しは無変更で互換)
- codex 経路: transcript_path → `aggregateCodexTurn`。モデルは **hook payload の `model` を優先**し、
  agg 側が `"unknown"` のときの代替にも使う。TurnRecord に `source: 'codex'` を付与。
  subagents 収集(collectSubagentUsage)は**呼ばない**。それ以外(価格・fx・appendTurn・通知判定・
  ダッシュボード再生成・ミュート・通知なしモード)は既存共通経路
- cli.ts: `track` コマンドの引数に `--codex` を追加して runTrack へ伝える。ヘルプ文言は変更しない(内部コマンドのため)

### 4-7. `src/setup.ts` / `src/doctor.ts`

- init フラグ追加: `--codex`(Codex hook を導入)/ `--no-codex`(スキップ)。排他(併用は exit 1)。
  `--yes` のみ(どちらも未指定)では **Codex に触らない**
- 対話: 既存質問の後、`detectCodex()` が真のときのみ confirm「Codex CLI を検出しました。Codex にもコスト通知を入れますか?」(既定 Yes)。
  導入した場合は完了メッセージで信頼確認の案内:
  「次回 codex 起動時に『Hooks need review』が表示されます。『Trust all and continue』を選ぶと有効になります(承認までは動きません)」
- uninstall: `removeCodexHook()` も実行(未導入なら黙ってスキップ)。`--purge` は従来どおり
- doctor: hook 登録セクションの後に Codex ブロック(検出時のみ): hooks.json のマーカーエントリ有無(コマンド全文表示)、
  sessions/ 存在、「登録済みでも codex 側で未承認だと動かない」注意書き。未検出なら1行 info。通知なしモードの早期 return より前に置く

### 4-8. `src/sweep.ts`

- 既存 Claude 走査の後に Codex 走査: `codexHome()/sessions` 配下の `rollout-*.jsonl`(`YYYY/MM/DD` 3階層・
  readdir 再帰は深さ4まで)。`detectCodex()` 偽 or sessions 不在なら黙ってスキップ
- 各ファイル: `loadCursor` → `splitIntoCodexTurnDrafts` → `--days` フィルタ(endTs 基準・カーソルは進める)→
  TurnRecord(`source: 'codex'`, `ingest: 'sweep'`)。active guard(mtime 5分)・`--dry-run`・去重(カーソル)は共通
- サマリーに Codex 分の件数/金額を1行追加(「Codex: N ターン $X」。0件なら出さない)

### 4-9. `src/dashboard.ts`

- embed の turn に `sc: 'codex' | undefined` を追加(Claude は undefined で容量節約)
- ソースフィルタチップ `[全体] [Claude] [Codex]` を粒度トグルの隣に表示(**Codex レコードが1件も無ければ非表示**)。
  選択は sessionStorage `cccn-src`(値: `all` | `claude` | `codex`、既定 all)で自動リロードを跨いで保持
- フィルタはチャート・モデル別・プロジェクト別・ターン履歴・KPI に適用。**月予算カードは常に合算**(カード内に「全ソース合算」を小さく明記)
- ターン履歴の行に `Codex` バッジ(source が codex のとき)。XSS 不変条件(textContent / < エスケープ)維持
- slot 配色ロジックは不変(全履歴のモデル別総コスト)

### 4-10. フィクスチャ(T0 が `test/fixtures/codex/` に作成・正解値つき)

実機捕獲データ(無害化)を基に:
1. `rollout-basic.jsonl` — 1ターン(session_meta / turn_context(gpt-5.5) / user_message / token_count(info: total=last= input 17272, cached 4992, output 7) / task_complete)
   - 期待値: uncached 12280 → $0.061400、cached 4992 → $0.002496、output 7 → $0.000210 = **$0.064106**
2. `rollout-multiturn.jsonl` — 3ターン(累積 total が増加・turn 2 は token_count 2回・turn 3 の途中に info:null の token_count)
3. `rollout-reset.jsonl` — 途中で total_token_usage が減る(リセット)ケース(負差分フォールバック検証)
4. `stop-payload.json` — 実機捕獲の Stop hook stdin(パス・uuid を無害化)

## 5. レビューゲート(私が各 Wave 後に実施)

1. `npx tsc --noEmit` / `npx vitest run`(全体)/ 差分レビュー(所有ファイル逸脱・契約準拠・既存スタイル)
2. W1 後: fixtures の正解値どおりに T2 が計算するか手元で確認
3. W2 後: `CCCN_HOME=$(mktemp -d)` で `init --codex --yes` 相当 → hooks.json 形状確認、`track --codex` に fixture payload を流して DRY_RUN 確認
4. W3 後(最終ゲート):
   - `npm run build` + 全テスト + `npm pack --dry-run`
   - **実データ検証**: 実 `~/.codex/sessions`(73ファイル)へ `sweep --dry-run`(読み取りのみ)→ クラッシュなし・金額妥当性
   - **実機 E2E(ユーザー)**: `init` で Codex 導入 → codex 起動 → Hooks need review 承認 → 1ターン → 通知・ダッシュボード確認
   - コミット分割(§6)・push・PR 作成
5. 失敗時: 同一エージェントに SendMessage で修正依頼(最大2回)→ 上位モデルに交代

## 6. コミット分割(最終ゲートで私が作成)

1. `feat(pricing): OpenAI モデルの単価と表示名を追加`
2. `feat(codex): rollout パーサとカーソル差分集計`(types/contracts/fixtures 含む)
3. `feat(track): Codex の Stop hook 経路(track --codex)`
4. `feat(init): Codex への hook 導入・削除・診断`
5. `feat(sweep): Codex セッションの過去分取り込み`
6. `feat(dashboard): ソースフィルタと Codex バッジ`
7. `docs: Codex 対応の README / docs/codex.md`
