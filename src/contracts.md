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
