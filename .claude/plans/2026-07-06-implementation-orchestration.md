# agent-cost-notifier 実装オーケストレーションプラン

- 作成日: 2026-07-06
- 前提: [機能プラン](./2026-07-06-agent-cost-notifier.md) 承認済みの内容を実装に落とす
- ステータス: レビュー待ち(承認後 Wave 0 から実行)

---

## 0. 役割分担(本プランの大原則)

| 役割 | 担当 | やること |
|---|---|---|
| オーケストレーター | **私(Fable 5)** | タスク分解・詳細仕様の指示・モデル選定・各Wave完了時のレビューゲート(ビルド/テスト実行・差分レビュー・受け入れ判定)・E2E最終確認 |
| 実装 | **subagent(Opus 4.8 / Sonnet 5 / Haiku 4.5 を適材適所)** | 本プランの仕様に従いコードとユニットテストを書く |
| 私による直接実装 | **原則なし** | エスカレーション最終段(下記プロトコル)でのみ発動 |

### 実行の仕組み

- 各 Wave の独立タスクは **Agent ツールで並列起動**(1メッセージで複数同時)
- タスクごとに `model` を明示指定(選定理由は §4)
- **Wave 間に必ず私のレビューゲート**を挟む: `npm run build && npm test` 実行 → 全差分を読む → 受け入れ基準判定 → 合格で次Wave
- 失敗時のエスカレーション・プロトコル:
  1. 指摘事項を添えて**同じエージェントに差し戻し**(SendMessage で文脈維持)
  2. 2回失敗 → **上位モデルで新規エージェント**に交代(Sonnet→Opus→Fable)
  3. それでも解決しない場合のみ、**私が直接実装**(ユーザー指示どおり最終手段)
- 進捗はタスクリスト(TaskCreate/TaskUpdate)で管理し、ユーザーがいつでも状況を把握できるようにする

### 並列実装を成立させる鍵: 契約ファースト

Wave 0 で **`src/types.ts`(全モジュールの型と関数シグネチャの契約)** と **テストフィクスチャ(正解値つき)** を確定させる。以降の各エージェントは契約に対してコードを書くため、互いのファイルに触れず並列実装できる。契約の全文は §5 に記載済み(私が設計、転記と検証は W0 エージェントが実施)。

---

## 1. 共通実装規約(全エージェントのプロンプトに埋め込む)

1. **担当ファイル以外を編集しない**(package.json への依存追加も禁止。必要なら報告して終了)
2. TypeScript strict / ESM / Node 20 target。`any` 禁止(やむを得ない場合は `unknown` + 絞り込み)
3. `src/types.ts` の契約(型・シグネチャ)を**変更しない**。不整合を見つけたら実装せず報告
4. 各タスクは自分のユニットテスト(vitest)を同梱し、終了前に `npx tsc --noEmit` と `npx vitest run test/<担当>.test.ts` を通す(**`npm run build` や全体テストは走らせない** — 並列実行中の dist/ 競合防止。全体ビルドは私のゲートで実施)
5. `track` 実行経路では: 例外を外に漏らさない・stdout に何も出さない・エラーは `logError()` へ・**プロセスは必ず exit 0**
6. ファイル書き込みは store.ts の paths() 経由のみ(`ACN_HOME` / `ACN_CLAUDE_SETTINGS` 環境変数でテスト時に差し替え可能にするため)
7. コメントは「コードから読めない制約」のみ。日本語コメント可
8. ネットワークアクセスには必ずタイムアウト(fx: 1.5s、Slack: 3s)と失敗時フォールバック

---

## 2. 確定済みの技術要素(機能プランより)

- Node.js 20+ / TypeScript、esbuild(tsup)で単一 JS にバンドル、npm 配布(bin: `agent-cost-notifier`, `acn`)
- ランタイム依存は **node-notifier / @clack/prompts の2つのみ**。Chart.js はダッシュボード HTML にビルド時インライン化(vendored、ランタイム依存にしない)
- データ: `~/.agent-cost-notifier/{config.json, history.jsonl, cursors.json, cache/fx.json, error.log}`
- hook 登録先: `~/.claude/settings.json` の `hooks.Stop`(マージ+バックアップ、コマンドはマーカー文字列 `agent-cost-notifier` を含む絶対パス node 実行)

---

## 3. Wave 構成と依存関係

```
Wave 0  基盤契約     [T0]                                （1体・直列）
Wave 1  コア5モジュール [T1 transcript][T2 pricing][T3 fx][T4 store][T5 notify] （5体・並列）
Wave 2  統合層       [T6 track][T7 setup/uninstall][T8 cli/doctor/report]      （3体・並列）
Wave 3  結合検証     [T9 integration tests + README]                            （1体）
        └ 私の総合ゲート(E2E・実データスモーク)
Wave 4  可視化       [T10 dashboard]                                            （1体）
Wave 5  CI           [T11 GitHub Actions (mac/win/linux)]                       （1体）
        └ 私の最終確認 → ユーザーへ完成報告
```

Wave 2 が Wave 1 の完了を待たず着手できない理由: track/cli は実モジュールを import してテストするため。ただし契約が固定なので待ち時間は最小。

---

## 4. モデル選定一覧と理由

| タスク | モデル | 理由 |
|---|---|---|
| T0 基盤契約・スキャフォールド | **Sonnet 5** | 契約全文は本プランに記載済み。転記+設定ファイル作成が主で、判断の余地が少ない |
| T1 transcript パーサ | **Opus 4.8** | **本ツールで最も正確性が要求される部分**(重複排除・カーソル・破損耐性・エッジケース)。ここの誤りは全ての金額を狂わせる |
| T2 pricing | Sonnet 5 | 単価表転記+前方一致+マージ。仕様が完全に規定されている |
| T3 fx | Sonnet 5 | フォールバック連鎖とタイムアウトの丁寧な実装が必要だが定型 |
| T4 store | Sonnet 5 | 追記の原子性・ログローテーション。定型だが慎重さは必要 |
| T5 notify (OS/Slack) | Sonnet 5 | クロスプラットフォーム差異の吸収。node-notifier が大半を担う |
| T6 track 統合 | **Opus 4.8** | フェイルセーフ境界(Claude Code を絶対に妨げない)+ 全モジュール統合。障害設計の質が問われる |
| T7 setup/uninstall | **Opus 4.8** | **ユーザーの `~/.claude/settings.json` を編集する = 破壊リスク最大**。マージ・バックアップ・冪等性・Windows 対応 |
| T8 cli/doctor/report | Sonnet 5 | 配線とチェックリスト実行。report の表整形のみなら Haiku 級だが同一タスクに含めるため Sonnet |
| T9 結合テスト+README | Sonnet 5 | E2E シナリオは本プランで規定済み。README は「5分で導入」の分かりやすさ重視 |
| T10 dashboard | **Opus 4.8** + dataviz スキル必須 | デザイン品質・情報設計が価値に直結(ユーザー要求「わかりやすさが大事」) |
| T11 CI | **Haiku 4.5** | 定型 YAML。3 OS マトリクスでテストを回すだけ |

エスカレーション時の上限モデル: Fable 5(=私。ユーザー指示により最終手段としてのみ)。

---

## 5. 契約: `src/types.ts`(Wave 0 でこの全文を確定)

```ts
// ============ 環境変数(テスト・サンドボックス用) ============
// ACN_HOME            : データディレクトリ上書き(既定 ~/.agent-cost-notifier)
// ACN_CLAUDE_SETTINGS : Claude settings.json パス上書き(既定 ~/.claude/settings.json)
// ACN_DRY_RUN=1       : 通知を実送信せず、送信ペイロードを ACN_HOME/last-notify.json に書く

export interface TokenBuckets {
  input: number;        // usage.input_tokens
  output: number;       // usage.output_tokens
  cacheWrite5m: number; // usage.cache_creation.ephemeral_5m_input_tokens
  cacheWrite1h: number; // usage.cache_creation.ephemeral_1h_input_tokens
  cacheRead: number;    // usage.cache_read_input_tokens
}

export type UsageByModel = Record<string, TokenBuckets>; // key: message.model (例 "claude-fable-5")

export interface Cursor {
  offset: number;             // 処理済みバイトオフセット
  lastUuid: string | null;    // 整合性検証用
  lastTs: string | null;      // フルリスキャン時の下限(これ以前の行はスキップ)
  seenMessageKeys: string[];  // 直近の "messageId:requestId"(最大500・リングバッファ)
}

export interface TurnAggregate {
  sessionId: string;
  main: UsageByModel;         // isSidechain !== true の集計
  sidechain: UsageByModel;    // isSidechain === true の集計
  apiCalls: number;           // 重複排除後の assistant メッセージ数
  prompt: string | null;      // 期間内の最後の「実ユーザープロンプト」全文
  cwd: string | null;
  gitBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
  newCursor: Cursor;
}

export interface ModelPrice {  // 単位: USD / 100万トークン
  input: number; output: number;
  cacheWrite5m: number; cacheWrite1h: number; cacheRead: number;
  source: 'builtin' | 'litellm';
}
export type PriceTable = Record<string, ModelPrice>; // key: モデルIDプレフィックス(最長一致)

export interface CostBreakdown {
  usd: number;
  byModel: Record<string, number>;
  unknownModels: string[];   // 単価が見つからずコスト0扱いにしたモデル
}

export interface FxResult { rate: number; source: 'live' | 'cache' | 'fixed'; fetchedAt: string; }

export interface TurnRecord {
  schemaVersion: 1;
  ts: string;                // ターン終了時刻(ISO8601)
  sessionId: string;
  project: string;           // cwd
  gitBranch: string | null;
  models: string[];
  tokens: TokenBuckets;      // main 合算
  sidechainTokens: TokenBuckets | null; // sidechain 合算(無ければ null)
  apiCalls: number;
  costUSD: number;           // 丸めず保存(表示時に丸める)
  costJPY: number;
  fxRate: number;
  fxSource: 'live' | 'cache' | 'fixed';
  prompt: string;            // 全文(ローカルのみ)。null 時は ""
  unknownModels?: string[];
}

export interface SlackConfig { webhookUrl: string; promptChars: number; sendFullPrompt: boolean; }

export interface Config {
  notify: { os: boolean; slack: SlackConfig | null };
  minNotifyUSD: number;                    // 既定 0
  costLabel: 'api_equivalent' | 'actual';  // 既定 'api_equivalent'
  fx: { fallbackRate: number; cacheHours: number }; // 既定 150 / 12
  includeDailyTotal: boolean;              // 既定 true
}
export declare const DEFAULT_CONFIG: Config;

export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  [k: string]: unknown;      // 未知フィールドは無視(将来互換)
}
```

### モジュール間の関数契約(実装は各タスク、シグネチャは W0 で types.ts 隣の `contracts.md` に固定)

```ts
// T1 transcript.ts
aggregateNewTurn(transcriptPath: string, cursor: Cursor | null): Promise<TurnAggregate | null>
// 新規 usage が1件も無ければ null(track は何もせず終了)

// T2 pricing.ts
builtinPriceTable(): PriceTable
loadPriceTable(cacheDir: string, opts?: { offline?: boolean }): Promise<PriceTable> // LiteLLMマージ+24hキャッシュ
resolvePrice(modelId: string, table: PriceTable): ModelPrice | null // 正規化+最長プレフィックス一致
computeCost(main: UsageByModel, sidechain: UsageByModel, table: PriceTable): CostBreakdown

// T3 fx.ts
getUsdJpy(cfg: Config, cacheDir: string): Promise<FxResult>

// T4 store.ts
paths(): AcnPaths                       // ACN_HOME 反映・ディレクトリ自動作成
readConfig(): Config                    // 不在/破損時は DEFAULT_CONFIG(破損は error.log へ)
loadCursor(transcriptPath: string): Cursor | null
saveCursor(transcriptPath: string, c: Cursor): void
appendTurn(record: TurnRecord): void    // 1行 JSON 追記
readTurns(days?: number): TurnRecord[]  // 破損行スキップ
todayTotalUSD(): number
logError(context: string, err: unknown): void // 1MB 超で .old へローテーション

// T5 format.ts / notify/os.ts / notify/slack.ts
formatSummary(record: TurnRecord, cfg: Config, todayUSD?: number): { title: string; body: string }
notifyOS(record: TurnRecord, cfg: Config, todayUSD?: number): Promise<void>     // 失敗しても throw しない
notifySlack(record: TurnRecord, cfg: Config, todayUSD?: number): Promise<void>  // 同上

// T6 track.ts
runTrack(stdinText: string): Promise<void> // 例外を絶対に外へ出さない

// T7 setup.ts
runInit(argv: string[]): Promise<number>       // 対話ウィザード
runUninstall(argv: string[]): Promise<number>

// T8 cli.ts / doctor.ts / report.ts
main(argv: string[]): Promise<number>
runDoctor(): Promise<number>
runReport(argv: string[]): Promise<number>
```

---

## 6. タスク詳細仕様

### T0 基盤契約・スキャフォールド(Sonnet 5)

**成果物**: `package.json` `tsconfig.json` `tsup.config.ts` `vitest.config.ts` `.gitignore` `src/types.ts` `src/contracts.md` `test/fixtures/transcript-basic.jsonl` `test/fixtures/settings-existing.json` `test/fixtures/GOLDEN.md`

指示内容:
- `src/types.ts` は §5 の全文を転記(変更禁止)
- package.json: `"type": "module"`, engines node>=20, bin 2つ, deps: `node-notifier` `@clack/prompts`, devDeps: `typescript` `tsup` `vitest` `@types/node` `@types/node-notifier`。scripts: `build`(tsup→dist/cli.js 単一バンドル+shebang), `test`(vitest run), `typecheck`
- **フィクスチャ `transcript-basic.jsonl`**(下記構造で合成データを作る。実ログのコピー禁止):
  1. user 行(実プロンプト): `{"type":"user","uuid":"u1","timestamp":"2026-07-06T10:00:00Z","cwd":"/tmp/proj","sessionId":"sess-1","gitBranch":"main","message":{"role":"user","content":"テスト用プロンプトです"}}`
  2. assistant 行 A(fable): input 100 / output 200 / cache_creation{5m:0, 1h:10000} / cache_read 50000、`message.id:"msg_A"` `requestId:"req_A"` — **同一内容で2行重複させる**(uuid は別)
  3. assistant 行 B(haiku, `isSidechain:true`): input 1000 / output 500 / cache_creation{5m:2000, 1h:0} / cache_read 0
  4. tool_result のみの user 行(プロンプト抽出対象外であることのテスト用)
  5. 壊れた JSON 行(パーサ耐性テスト用)
- **`GOLDEN.md`(手計算の正解値。全テストがこれに一致すること)**:
  - fable-5: 100×10 + 200×50 + 10000×20 + 50000×1 = 0.001+0.01+0.2+0.05 = **$0.261**
  - haiku-4-5(sidechain): 1000×1 + 500×5 + 2000×1.25 = 0.001+0.0025+0.0025 = **$0.006**
  - 合計 **$0.267**、¥(150円固定) = **40.05**、apiCalls = **2**(重複排除後)、prompt = "テスト用プロンプトです"
- `settings-existing.json`: ユーザー実環境を模した既存設定(hooks.PermissionRequest + hooks.SessionStart + statusLine + permissions を含む)— T7 のマージテスト用
- `git init` + 初回コミット(コミットは各 Wave 完了時に私が承認してから)

**受け入れ基準**: `npm install` 成功 / `npm run typecheck` 成功 / フィクスチャが GOLDEN.md と整合

---

### T1 transcript.ts(Opus 4.8)⭐ 最重要

**成果物**: `src/transcript.ts` `test/transcript.test.ts`

実装ルール(全て仕様として明記済み・裁量に任せない):
1. ファイルを `cursor.offset` から読む。offset がファイルサイズ超過・または offset 位置の最初の行の uuid 検証が不整合 → **offset=0 からフルリスキャン**し、`seenMessageKeys` と `lastTs`(これより古い行はスキップ)で二重計上を防ぐ
2. 行ごとに JSON.parse。失敗行はカウントして黙ってスキップ(1行の破損で全体を壊さない)
3. assistant 行: `message.usage` が無ければスキップ。**重複キー = `${message.id}:${requestId}`、同一キーは最後の行を採用**
4. トークン抽出: `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` を使用。`cache_creation` オブジェクトが無い旧形式は `cache_creation_input_tokens` 全量を **5m 扱い**(保守的=安い方に倒さない: 5m の方が安いが旧形式時代は 5m のみだったため正確)
5. `isSidechain === true` は sidechain バケットへ、それ以外は main へ。モデル別(UsageByModel)に積む
6. プロンプト抽出: `type==="user"` かつ `message.content` が string かつ 先頭が `<` でない行(`<command-name>` `<local-command-stdout>` `<system-reminder>` 等の擬似メッセージを除外)。配列 content の場合は `tool_result` を含まず text ブロックのみなら連結して採用。**期間内の最後の1件**を全文で
7. 戻り値の `newCursor`: 読み切った EOF オフセット・最終行 uuid・最終 timestamp・更新済み seenMessageKeys(最大500、古い順に破棄)
8. 新規 assistant usage が 0 件なら null を返す

**テスト**(フィクスチャ使用): 重複排除(apiCalls=2)/ GOLDEN トークン数一致 / sidechain 分離 / プロンプト抽出(tool_result 行と `<` 行を無視)/ 破損行耐性 / カーソル継続(1回目→追記→2回目で新規分のみ)/ カーソル破損時のフルリスキャンで二重計上なし / 空ファイル・存在しないファイルで null

---

### T2 pricing.ts(Sonnet 5)

**成果物**: `src/pricing.ts` `test/pricing.test.ts`

- 内蔵単価表($/MTok): fable-5=mythos-5: 10/50/12.5/20/1.0、opus-4-8=4-7=4-6=4-5: 5/25/6.25/10/0.5、opus-4-1=4-0(および `claude-opus-4-2025` 系旧ID): 15/75/18.75/30/1.5、sonnet-5: 3/15/3.75/6/0.30、sonnet-4-6=4-5=4-0: 同上、haiku-4-5: 1/5/1.25/2/0.10、haiku-3-5: 0.8/4/1/1.6/0.08、haiku-3: 0.25/1.25/0.3125/0.5/0.025
- `resolvePrice`: モデルID正規化(末尾の日付 `-20\d{6}` と `[1m]` を除去、小文字化)→ テーブルキーの**最長プレフィックス一致**。不一致は null
- `computeCost`: モデルごとに resolvePrice して 5 バケット × 単価を合算(main + sidechain 両方)。単価不明モデルは cost 0 で `unknownModels` に記録
- `loadPriceTable`: `cache/pricing.json`(24h TTL)→ 期限切れなら LiteLLM の `model_prices_and_context_window.json` を 3s タイムアウトで取得し、`claude-` エントリの input/output/cache_read/cache_creation(+`_1h` があれば)を $/tok→$/MTok 換算してマージ(**LiteLLM 値が内蔵より優先**)。失敗時は キャッシュ→内蔵 にフォールバック。`offline:true`(track 経路のデフォルト)ではネットワークに出ず キャッシュ→内蔵 のみ ※単価取得のネットワーク待ちで通知を遅らせない。ネット更新は doctor / dashboard 実行時に行う
- 丸め禁止(計算は倍精度のまま、丸めは表示層)

**テスト**: GOLDEN 一致($0.261 / $0.006 / 合計 $0.267)/ 日付サフィックス付きID(`claude-sonnet-4-5-20250929`)解決 / `[1m]` 除去 / 未知モデル→unknownModels / LiteLLM マージ(モック fetch)と換算 / オフライン時フォールバック

---

### T3 fx.ts(Sonnet 5)

**成果物**: `src/fx.ts` `test/fx.test.ts`

- 優先順: (1) キャッシュが `cacheHours` 以内なら**ネットワークに出ず**即返す(hook 速度最優先) (2) 期限切れ→ frankfurter.dev(1.5s タイムアウト)→ open.er-api.com(1.5s)の順に試行 (3) 全滅→期限切れキャッシュを `source:'cache'` で使用 (4) キャッシュも無い→ `cfg.fx.fallbackRate` を `source:'fixed'`
- 成功時は `cache/fx.json` に `{rate, fetchedAt}` を保存。fetch は AbortController でタイムアウト、例外は握って次へ
- **テスト**: fetch をモックし、フレッシュキャッシュでネット不使用 / 1次失敗→2次成功 / 全滅→stale キャッシュ / 完全初回オフライン→fixed

### T4 store.ts(Sonnet 5)

**成果物**: `src/store.ts` `test/store.test.ts`

- `paths()`: `ACN_HOME` 環境変数 > `~/.agent-cost-notifier`。初回アクセス時に mkdir -p(cache/ 含む)
- `readConfig`: 深いマージで欠損キーに DEFAULT_CONFIG を補完。JSON 破損時は logError して DEFAULT_CONFIG(**ユーザー設定ファイルを勝手に上書き修復しない**)
- `appendTurn`: `JSON.stringify + "\n"` を appendFileSync(flag 'a')。`readTurns`: 行単位パース・破損行スキップ・days 指定で ts フィルタ
- `cursors.json`: transcript パスをキーにした辞書。保存は tmp ファイル→rename の原子的置換
- `logError`: `[ISO時刻] [context] message\nstack` 形式で追記。1MB 超過時は `error.log.old` へ rename して新規
- **テスト**: ACN_HOME サンドボックスで全 API / 破損 config 耐性 / 破損 history 行スキップ / ローテーション

### T5 notify(Sonnet 5)

**成果物**: `src/format.ts` `src/notify/os.ts` `src/notify/slack.ts` `test/notify.test.ts`

- `format.ts`: `formatUSD`(<$0.01→4桁、<$1→3桁、以上→2桁)/ `formatJPY`(<¥1→小数1桁、以上→整数カンマ区切り)/ `formatTokens`(1234→"1.2k", 1234567→"1.2M")/ `formatSummary`:
  - title: `💰 $0.42(¥63)| Fable 5` ※ costLabel==='api_equivalent' なら `API換算 $0.42(¥63)| Fable 5`。models 複数時は主要モデル+`+1`
  - body: `in 342.1k(cache 95%)/ out 3.7k · 📁 <プロジェクト名(cwd末尾)>` + 改行 + プロンプト先頭50字(改行は空白化)+ includeDailyTotal 時 ` · 今日: $3.20`
  - cache% = (cacheRead+cacheWrite)/(実効入力合計)
- `notify/os.ts`: node-notifier。`ACN_DRY_RUN=1` なら送信せず `ACN_HOME/last-notify.json` にペイロード書き出し(E2E 検証用)。エラーは logError のみ
- `notify/slack.ts`: Block Kit(header: 金額、section fields: モデル/トークン/プロジェクト/セッション、context: プロンプト `promptChars` 字)。3s タイムアウト・非 2xx は logError。`sendFullPrompt:false` が既定
- **テスト**: フォーマット境界値 / DRY_RUN でのペイロード内容 / Slack ペイロード構造(fetch モック)/ 通知失敗でも throw しない

---

### T6 track.ts(Opus 4.8)⭐ フェイルセーフ境界

**成果物**: `src/track.ts` `test/track.test.ts`

処理順(仕様として固定):
1. stdin 全読み(500ms 以内にデータが来なければ空扱い)→ StopHookInput をパース。`transcript_path` 欠落/ファイル不存在 → 静かに終了
2. `readConfig` → `loadCursor` → `aggregateNewTurn`。null(新規なし)→ カーソルだけ保存して終了
3. `loadPriceTable(offline:true)` → `computeCost` → `getUsdJpy` → TurnRecord 組み立て(ts=aggregate.lastTs か現在時刻)
4. `appendTurn` → `saveCursor`(**この順序**。クラッシュ時は「記録済み・カーソル未更新→次回 seenMessageKeys が二重計上を防ぐ」側に倒す)
5. `costUSD >= minNotifyUSD` のとき notifyOS / notifySlack を **Promise.allSettled で並行実行**(片方の失敗が他方を止めない)
6. 全体デッドライン 10s(超過しそうな処理は打ち切って正常終了)

フェイルセーフ(最重要・受け入れ基準):
- `runTrack` 全体を try/catch、`process.on('uncaughtException'|'unhandledRejection')` でも logError → exit 0
- **いかなる経路でも exit code は 0**(exit 2 は Claude Code の「停止ブロック」を意味するため絶対禁止)
- stdout へ一切出力しない

**テスト**: 正常系(フィクスチャ→history 1行・GOLDEN 金額・DRY_RUN 通知ペイロード)/ 2回目実行で無変化(冪等)/ 不正 stdin・不存在パス・壊れた config でも exit 0 相当 / しきい値未満で通知スキップ(履歴には残る)

### T7 setup.ts — init / uninstall(Opus 4.8)⭐ ユーザー設定を触る唯一の場所

**成果物**: `src/setup.ts` `test/setup.test.ts`

- 対象: `ACN_CLAUDE_SETTINGS` > `~/.claude/settings.json`
- **init フロー**(@clack/prompts):
  1. 通知チャネル選択(OS のみ / OS+Slack→URL 入力・形式検証)、金額ラベル、固定レート → `config.json` 書き込み
  2. settings.json 読み込み。**JSON パース失敗時は絶対に書き込まず**、手動追記用スニペットを表示して終了
  3. `settings.json.bak-<epoch>` にバックアップ → `hooks.Stop` 配列へ追記マージ(**既存の hooks / statusLine / permissions / 未知キーを完全保持**)
  4. hook エントリ: `{ "hooks": [{ "type": "command", "command": "<node絶対パス> <dist/cli.js絶対パス> track", "timeout": 15 }] }`。node は `process.execPath`、パスは realpath 解決。**Windows(process.platform==='win32')ではパスを forward slash 化し双方をダブルクォート**(Git Bash 実行形態対応)
  5. **冪等性**: command に `agent-cost-notifier` を含む既存エントリがあれば重複追加せず更新
  6. `ACN_DRY_RUN` を尊重しつつテスト通知 → 完了メッセージ(次の一手を1行で)
- **uninstall**: バックアップ作成 → マーカーを含む Stop エントリのみ除去(配列が空になれば Stop キーごと削除)→ データディレクトリは残す(`--purge` で削除)
- **テスト**(settings-existing.json フィクスチャ): 既存 hooks/statusLine が 1 バイトも壊れないこと(before/after の該当キー deep-equal)/ 冪等(2回実行で1エントリ)/ 破損 settings で無変更 / バックアップ生成 / uninstall で追加分のみ消える / win32 モード(platform モック)のコマンド文字列

### T8 cli.ts / doctor.ts / report.ts(Sonnet 5)

**成果物**: `src/cli.ts` `src/doctor.ts` `src/report.ts` `test/cli.test.ts`

- `cli.ts`: 手書き argv 分岐(`track` は stdin 読んで runTrack / `init` / `uninstall` / `doctor` / `report` / `dashboard` / `--version` / `--help` は日本語+英語1行ずつ)。**未知コマンドでも track と誤爆しない**
- `doctor.ts` チェックリスト(各 ✅/⚠️/❌ で表示、1つでも ❌ なら exit 1):
  1. settings.json に本ツールの Stop hook が登録済みか(コマンドのパスが実在するか)
  2. `~/.claude/projects` が読めるか+最新 transcript 1件をパースできるか
  3. config.json が有効か
  4. 単価表の鮮度(ここでは `loadPriceTable(offline:false)` でネット更新も実施)
  5. 為替取得(失敗は ⚠️ 扱い)
  6. テスト通知送信
  7. 直近セッションの合計 USD を計算して表示し「Claude Code の /cost と見比べてください」と案内(自動突合は statusline ペイロードを保存していないため手動確認とする)
- `report.ts`: `readTurns(days)` を日別・モデル別に集計したテキスト表($/¥、合計行)。`--days N`(既定30)、`--json` オプション
- **テスト**: argv 分岐 / report の集計値(フィクスチャ由来の history)/ doctor の各判定(モック)

---

### T9 結合テスト + README(Sonnet 5)

**成果物**: `test/e2e.test.ts` `README.md`

- **E2E(vitest 内で child_process 実行、ACN_HOME=一時dir、ACN_DRY_RUN=1)**:
  1. `node dist/cli.js track < stop-hook-stdin.json`(transcript_path=フィクスチャ)→ history.jsonl 1行・金額 GOLDEN 一致・last-notify.json の文言検証
  2. 同一入力を再実行 → history 増えない(冪等)
  3. フィクスチャに新ターンを追記 → 再実行 → 新規分のみ1行追加
  4. cursors.json を故意に破壊 → 再実行 → クラッシュせず二重計上なし
  5. init→doctor→uninstall を `ACN_CLAUDE_SETTINGS`=一時ファイルで一気通貫(非対話モード用に `--yes --os-only` フラグを T7 に要求済み)
  ※ このテストだけは `npm run build` 後の dist を使う(実行は私のゲートで)
- **README.md**(日本語主体+英語併記見出し): 30秒デモGIF枠 → `npx agent-cost-notifier init` 3ステップ導入 → 通知の読み方 → dashboard/report → 設定表 → 「金額は API 換算(サブスクの方へ)」の説明 → アンインストール → FAQ(通知が来ない→doctor)

### T10 dashboard(Opus 4.8、**着手前に dataviz スキルを必ずロード**)

**成果物**: `src/dashboard/template.html` `src/dashboard/index.ts` `test/dashboard.test.ts` `vendor/chart.umd.js`(ビルド時インライン)

- `runDashboard(argv)`: `readTurns(--days 既定30)` → 集計 JSON を template に `<script id="acn-data" type="application/json">` で埋め込み → `ACN_HOME/report.html` へ書き出し → OS 別コマンド(open/start/xdg-open)でブラウザ起動(`--no-open` あり)
- 完全自己完結(外部リクエスト 0 / オフライン動作)。ライト/ダーク両対応(prefers-color-scheme)
- 構成: ①サマリーカード(今日/今週/今月/累計、$・¥併記)②日別積み上げ棒(モデル別)+累積線 ③モデル別ドーナツ+表 ④プロジェクト別表 ⑤ターン履歴テーブル(時刻/プロジェクト/モデル/トークン/$/¥/プロンプト冒頭80字、**行クリックで全文展開・インクリメンタル検索・プロンプトは textContent で挿入(XSS 防止)**)
- 1プロンプト最大 10,000 字で埋め込み(超過は「…以下略」)
- **テスト**: 生成 HTML に data JSON・全セクション DOM・script インライン(外部 URL 参照ゼロ)を検証

### T11 CI(Haiku 4.5)

**成果物**: `.github/workflows/ci.yml`

- matrix: ubuntu / macos / **windows** × Node 20。`npm ci → build → typecheck → vitest run`(E2E 含む。DRY_RUN なので通知は飛ばない)
- Windows で T7 のパス処理・T4 のファイル操作が実際に通ることが狙い

---

## 7. 私(オーケストレーター)の検証計画

### 各 Wave ゲート(共通)
1. `npm run typecheck && npm run build && npm test` を私が実行
2. 全差分を読む: 契約違反 / 規約違反(担当外ファイル編集・依存追加・any)/ エラーハンドリング漏れ / テストが GOLDEN を実際に検証しているか(モックで空回りしていないか)
3. 不合格 → §0 のエスカレーション・プロトコル

### 最終総合検証(Wave 3 後と Wave 5 後)
1. **サンドボックス E2E**: 一時 ACN_HOME + フィクスチャで track→report→doctor→dashboard を通し実行
2. **実データスモーク**: 本セッションの実 transcript(読み取りのみ)を入力に `track` を単発実行(ACN_HOME はサンドボックス)→ 実際の Mac 通知が1件表示され、金額が妥当か目視確認 ※実行前にユーザーへ一言断る
3. **実環境インストールはユーザー判断**: `init` を本物の `~/.claude/settings.json` に適用する最終ステップは、私が差分プレビューを提示 → ユーザー承認後に実行
4. 完了報告: 実装サマリ・テスト結果・使い方 3 行

---

## 8. リスクと運用ルール

| リスク | 対策 |
|---|---|
| 並列エージェントのファイル競合 | 担当ファイル厳格分離・dist/ を触るのは私のゲートのみ・依存追加は T0 で完結 |
| エージェントが契約を勝手に変える | 規約3(変更禁止・報告義務)+ ゲートで types.ts の diff を必ず確認 |
| テストが形骸化(モックだけで通る) | GOLDEN.md の手計算値を金額アサートに強制。私がテスト内容を読んで判定 |
| ユーザーの settings.json 破壊 | T7 を Opus 指定・バックアップ必須・破損時書き込み禁止・実適用はユーザー承認制(§7-3) |
| hook が Claude Code を遅くする | track はオフライン単価+為替キャッシュ優先で通常 <1s・deadline 10s・timeout 15s |
| エージェントの手戻りコスト | 仕様を本プランで細部まで固定(裁量を減らす)。差し戻しは指摘事項を具体化して1回で直す |

### 承認をお願いしたい運用事項
- **git**: Wave ごとに私がコミット(メッセージ規約付き)。リモート push は指示があるまでしない
- **npm publish**: 本プランのスコープ外(完成後に別途相談)

---

## 9. 実行サマリ

- subagent 総数: **12体**(Opus 4.8 ×4 / Sonnet 5 ×7 / Haiku 4.5 ×1)+ 差し戻し予備
- 私のレビューゲート: **6回**(各 Wave 後)+ 最終総合検証
- ユーザー確認ポイント: ①本プラン承認 ②実データスモーク実行の一言確認 ③実環境への init 適用 ④完成受け入れ
