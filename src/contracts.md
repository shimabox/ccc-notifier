# モジュール契約(変更禁止。不整合は実装せずオーケストレーターへ報告)

## src/transcript.ts (T1)
- `aggregateNewTurn(transcriptPath: string, cursor: Cursor | null): Promise<TurnAggregate | null>`
  - 新規 assistant usage が 0 件なら null

## src/pricing.ts (T2)
- `builtinPriceTable(): PriceTable`
- `loadPriceTable(cacheDir: string, opts?: { offline?: boolean }): Promise<PriceTable>`
- `resolvePrice(modelId: string, table: PriceTable): ModelPrice | null`
- `computeCost(main: UsageByModel, sidechain: UsageByModel, table: PriceTable): CostBreakdown`

## src/fx.ts (T3)
- `getUsdJpy(cfg: Config, cacheDir: string): Promise<FxResult>`

## src/store.ts (T4)
- `paths(): AcnPaths`  // AcnPaths 型は store.ts が export: { home, configFile, historyFile, cursorsFile, cacheDir, errorLog, lastNotifyFile }
- `readConfig(): Config`
- `loadCursor(transcriptPath: string): Cursor | null`
- `saveCursor(transcriptPath: string, c: Cursor): void`
- `appendTurn(record: TurnRecord): void`
- `readTurns(days?: number): TurnRecord[]`
- `todayTotalUSD(): number`
- `logError(context: string, err: unknown): void`

## src/format.ts, src/notify/os.ts, src/notify/slack.ts (T5)
- `formatUSD(n: number): string` / `formatJPY(n: number): string` / `formatTokens(n: number): string`
- `formatSummary(record: TurnRecord, cfg: Config, todayUSD?: number): { title: string; body: string }`
- `notifyOS(record: TurnRecord, cfg: Config, todayUSD?: number): Promise<void>`   // throw しない
- `notifySlack(record: TurnRecord, cfg: Config, todayUSD?: number): Promise<void>` // throw しない

## src/track.ts (T6)
- `runTrack(stdinText: string): Promise<void>`  // 例外を絶対に外へ出さない

## src/setup.ts (T7)
- `runInit(argv: string[]): Promise<number>`      // 非対話用フラグ --yes --os-only を必ずサポート
- `runUninstall(argv: string[]): Promise<number>` // --purge サポート

## src/cli.ts, src/doctor.ts, src/report.ts (T8)
- `main(argv: string[]): Promise<number>`
- `runDoctor(): Promise<number>`
- `runReport(argv: string[]): Promise<number>`

## TurnRecord.models の定義
main のモデル → sidechain のみのモデル の順、重複排除。

## 2026-07-07 追加: Config.dashboard(オーケストレーター認可)
Config に `dashboard: { autoRegenerate: boolean; autoReloadSec: number; days: number }` を追加した。
既定は `{ autoRegenerate: true, autoReloadSec: 30, days: 30 }`。
- `autoRegenerate`: track 実行のたびに report.html を再生成する(通知しきい値とは独立)。
- `autoReloadSec`: 生成 HTML の `<meta http-equiv="refresh">` 間隔秒。0 で無効。
- `days`: 自動再生成時の対象期間。
mergeConfig は他キーと同じ流儀で dashboard を深いマージする(欠損サブキーはデフォルト補完)。

## src/dashboard.ts — writeDashboardHtml(2026-07-07 追加)
- `writeDashboardHtml(opts: { days: number; outPath: string; autoReloadSec: number }): void`
  - readTurns(days) → HTML 生成 → mkdir(dirname) + writeFileSync。
  - console 出力・ブラウザ起動はしない。失敗は throw(呼び出し側が処理)。
  - `autoReloadSec > 0` のとき生成 HTML の `<head>` に `<meta http-equiv="refresh" content="N">` を出力する。
  - runDashboard(挙動不変)と track の自動再生成(フェイルセーフ経路)の共通コア。

## 2026-07-07 追加: TurnRecord.costByModel(オーケストレーター認可)
TurnRecord に `costByModel?: Record<string, number>` を追加した(schemaVersion は 1 のまま、
旧レコードとの後方互換のため optional)。
- モデルID → そのターンの USD(main+sidechain 合算、丸めない)。computeCost の
  `CostBreakdown.byModel` をそのまま保存する(unknownModels 由来の 0 エントリを含みうる)。
- 旧レコード(このフィールドが無い、または空)を読む側は「先頭モデル(models[0])に costUSD を
  全額帰属」させるフォールバックで解釈する(dashboard.ts / report.ts 各々の
  `turnCostByModel(rec)` ヘルパー参照。小さいため共有モジュール化はせず各ファイルに重複実装する)。
- これにより、モデル別集計(dashboard のモデル別表・日別スタック、report の byModel)は
  「主モデルに全額帰属」の簡易方式から「実配分」に変わった。複数モデルを使ったターンは
  各モデルの行に1ずつ計上される(参加カウント)ため、モデル別のターン数合計は総ターン数を
  超えうる。
