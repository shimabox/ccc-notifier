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
- `paths(): CccnPaths`  // CccnPaths 型は store.ts が export: { home, configFile, historyFile, cursorsFile, cacheDir, errorLog, lastNotifyFile }
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
- `runInit(argv: string[]): Promise<number>`      // 非対話用フラグ --yes --os-only --no-notify を必ずサポート
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

## 2026-07-07 追加: TurnRecord.subagents(オーケストレーター認可)
サブエージェント(バックグラウンド/サブエージェント)usage の取り込みを認可した。
TurnRecord に optional の `subagents` を追加(schemaVersion は 1 のまま、旧レコード後方互換):
```ts
subagents?: {
  costUSD: number;                     // サブエージェント合計(丸めない)
  costByModel: Record<string, number>; // モデルID → USD
  tokens: TokenBuckets;                // 全エージェント合算
  apiCalls: number;                    // 重複排除後メッセージ数
  agentFiles: number;                  // 今回集計対象になったファイル数
};
```
- サブエージェントの usage は、メイン transcript の兄弟ディレクトリ
  `<mainTranscriptPath(.jsonl 除去)>/subagents/agent-*.jsonl` に恒久保存される
  (メインとほぼ同一スキーマ・全行 isSidechain:true)。これを増分集計して SA 枠に記録する。
- **通知は一切変えない**: 通知のしきい値判定・通知金額は従来どおり `record.costUSD`(メインのみ)。
  `record.costUSD` に SA を加算しない。
- 表示側(dashboard / report)は「総額 = costUSD + subagents.costUSD」を表示の基準にする
  (ヒーロー合計・KPI・日別・プロジェクト・byModel・total)。byModel は `subagents.costByModel` の
  各モデルもマージする(参加カウント +1)。トークン列(in/out)は従来どおり main+sidechain のみ。

## src/subagents.ts(2026-07-07 追加)
- `collectSubagentUsage(mainTranscriptPath: string): Promise<SubagentUsage | null>`
  ```ts
  interface SubagentUsage {
    perModel: UsageByModel;                        // 全ファイル合算(main+sidechain をマージ)
    apiCalls: number;                              // 全ファイル合算(重複排除後)
    agentFiles: number;                            // 今回新規 usage があったファイル数
    newCursors: Array<{ path: string; cursor: Cursor }>; // 各ファイルの新カーソル(保存は呼び出し側)
  }
  ```
  - 対象ディレクトリ = mainTranscriptPath の末尾 `.jsonl` を除いたパス + `/subagents`
    (例: `/x/abc.jsonl` → `/x/abc/subagents`)。ディレクトリが無い/読めない → **null**(旧形式環境)。
  - `agent-` で始まり `.jsonl` で終わる通常ファイルのみ対象(`.meta.json` は読まない・symlink は辿らない)。
    ファイル数が 200 超なら更新時刻の新しい順に 200 件で打ち切る(異常系ガード)。
  - 各ファイル: `loadCursor` → `sanitizeCursor` → `aggregateNewTurn`(transcript.ts をそのまま再利用)。
    全行 isSidechain だが、将来フラグが変わっても取りこぼさないよう main と sidechain の両方を
    perModel にマージする。新規なし(null)はスキップ。1ファイルの失敗は握りつぶして次へ。
  - **カーソル保存はここでは行わない**(track.ts が履歴追記後に SA 分を saveCursor する)。

## 2026-07-07 追加: TurnRecord.ingest / sweep コマンド(オーケストレーター認可)
TurnRecord に optional の `ingest?: 'sweep'` を追加した(schemaVersion は 1 のまま、後方互換)。
- `sweep`(過去分の一括回収)由来の記録に `ingest: 'sweep'` を付与する。hook(track)経由の
  記録には付与しない(= undefined)。読む側は無視してよい(表示・集計には影響しない)。

### src/transcript.ts — export 追加(挙動不変)
sweep がメイン(aggregateNewTurn)とパース規約を完全に踏襲するため、既存 private ヘルパー
`extractBucket` / `promptCandidate` を export に変更した(**実装・シグネチャは不変**)。

### src/sweep.ts(2026-07-07 追加)
- `runSweep(argv: string[]): Promise<number>`
  - `~/.claude/projects`(既定・`CCCN_CLAUDE_PROJECTS` または `--projects <dir>` で上書き)配下の
    各プロジェクトディレクトリ内の `*.jsonl`(1階層のみ)を走査し、hook のカーソルで「未計上分」を
    **ターン単位に復元**して history へ取り込む。サブエージェント(`<main>/subagents/agent-*.jsonl`)も
    `collectSubagentUsage` で回収する。二重計上はカーソル + message.id 去重で防ぐ。
  - フラグ: `--dry-run`(書き込みなしで集計表示)/ `--days <N>`(N 日より古いターンは取り込まない。
    カーソルは進める)/ `--projects <dir>`(走査ルート上書き)。
  - 円換算は sweep 実行時のレート(`getUsdJpy`)。単価は `loadPriceTable(cacheDir, { offline: false })`。
  - 実行後サマリ(`SweepSummary`)の `totalUSD` / `byModel` は**メイン基準**(SA を含めない)。SA の回収額は
    `subagentsUSD` に別枠で集計し、新規があるとき(`newRecords > 0 && subagentsUSD > 0`)はコンソールにも
    「うちサブエージェント: $X(¥Y)」(¥ は fx.rate 換算)として1行表示する。
  - `splitIntoTurnDrafts(path, cursor)`: aggregateNewTurn と同一のパース規約(開始位置・改行終端・破損行
    スキップ・rescan ガード・去重・コンテキスト採取)で、実ユーザープロンプト行をターン境界に分割する。
    戻り値の newCursor は同一ウィンドウに対する aggregateNewTurn の newCursor と互換(hook ↔ sweep 相互運用)。

## src/store.ts に sanitizeCursor を移設(2026-07-07)
`sanitizeCursor(raw: unknown): Cursor | null` を track.ts の private 関数から store.ts の export へ
移設した(挙動不変)。track.ts と subagents.ts の双方から使う。

## 2026-07-07 追加: 通知ミュート(mute / unmute)
- 状態は `CCCN_HOME/muted.json`(`{ until: string | null }`。null = 無期限、ISO 文字列 = 期限付き)。
  config.json は書き換えない(readConfig の「ユーザーのファイルを勝手に修復・上書きしない」方針を維持)。
- src/store.ts export 追加: `MuteState` / `readMuteState()` / `isMuted(now?)` / `writeMuteState(state)` / `clearMuteState()`。
  壊れた muted.json は「ミュートなし」に倒す(通知が止まりっぱなしになる側に倒さない)。
- src/mute.ts(新規): `runMute(args): number`(`cccn mute [30m|2h|1d]`、省略で無期限)/ `runUnmute(): number`。
- track.ts: 通知判定を `costUSD >= minNotifyUSD && !isMuted()` に変更。**記録(appendTurn)・カーソル保存・
  ダッシュボード再生成はミュートの影響を受けない**(通知のみ抑止)。
- doctor.ts: テスト通知チェックの冒頭でミュート中なら ⚠️ を表示(テスト通知自体は送る)。

## 2026-07-07 追加: sweep の進行中セッション保護(active-session guard)
- 背景: 応答完了と同時に sweep が走ると、hook(track)より先にそのターンを読み切ってカーソルを
  進めてしまい、track は aggregateNewTurn が null で即 return → そのターンだけ通知・再生成が消える
  競合があった(データは sweep 側に記録されるので喪失はしない)。
- 対策: mtime が直近 5 分以内(ACTIVE_GUARD_MS)の transcript は既定でスキップし、カーソルも進めない
  (丸ごと後回し。次回 sweep か hook が拾う)。スキップ件数はサマリに必ず表示する(黙って落とさない)。
- `--include-active` でガードを解除できる(全セッション完了済みと分かっているとき用)。
- 判定は stat の mtime のみ・メイン transcript 単位(stat 失敗は従来どおり処理へ)。

## 2026-07-08 追加: doctor の hook 登録ログにコマンド全文を表示
`checkHookRegistration` の成功ログを `hooks.Stop に ccc-notifier のエントリが登録されています(N件)` から
`(N件): <command> / <command> ...` に変更し、実際に登録されている絶対パス入りコマンドを表示するようにした。
複数クローン/グローバルインストールが混在する環境で「どの実体が hook として動いているか」を doctor 一発で判別できる
ようにするため(README の「アンインストールしたい」節から誘導)。ログレベル・件数計算・他チェックの挙動は不変。

## 2026-07-08 追加: ダッシュボードの期間切替(日/週/月・通算)
ダッシュボードを「サーバ側で固定期間を集計・SVG 描画」から「全履歴を埋め込み、ブラウザ側で期間集計・描画」へ
作り替えた。

- `src/dashboard.ts`: 既定で **全履歴**を読み込む(`readTurns()` を days なしで)。`--days N` は埋め込み範囲の任意の
  上限(既定・不正値は全履歴)。`track.ts` の自動再生成も `writeDashboardHtml({ days: null })` で全履歴に変更
  (config.dashboard.days はダッシュボードでは未使用になった。型・既定値は後方互換のため据え置き)。
  - 埋め込みは `{ version, generatedAt, slots:[{slot,name}], turns:[...] }`。turns は 1 ターン =
    `{ t(epoch ms), ts, p, pf, br, md, mr, ti, to, um(メインUSD), fx, bs(slot→USD/SA込み), pr, tr, sa }`。
  - slot(配色)は**全履歴のモデル別総コスト**で一度だけ決める(期間を切り替えても色が不変)。上位8 + その他。
  - ブラウザ JS が 日/週/月 でバケット集計してスタック棒を SVG 描画(帯幅はコンテナ幅から算出し、多ければ横スクロール)。
    棒クリックでその期間を選択 → モデル別内訳・プロジェクト別・ターン履歴が連動。「通算」で全期間。
  - 粒度(cccn-gran)・選択(cccn-sel)・検索(cccn-search)・スクロール(cccn-scroll)を sessionStorage に保存し、
    自動リロード(meta refresh)を跨いでも維持する。
  - セキュリティ不変条件は維持: 外部通信ゼロ / #cccn-data の < を \\u003c にエスケープ / プロンプトは textContent /
    プロンプトは最大 10000 字 + 「…(以下略)」。

## 2026-07-08 追加: 履歴削除コマンド(history clear / redact)
ダッシュボードが全履歴(プロンプト全文含む)を埋め込むため、ユーザーが履歴を整理できる CLI を追加。

- `src/history.ts`(新規): `runHistory(argv): Promise<number>`。`clear`(レコード削除)/`redact`(プロンプトのみ空に)、
  `--days N`(N 日より前だけ)、`--yes`(確認省略)。history.jsonl を tmp + rename で原子的に書き換える。
  壊れた行・ts 不正な行は触らない。cli.ts に `history` を配線。

## 2026-07-09 追加: 月予算(monthlyBudgetUSD)
月に使える金額(USD)を設定し、ダッシュボードで当月(暦月)の使用額 / 予算 / 使用率(%)を表示する
(可視化のみ。使用の停止・通知はしない)。

- `Config.monthlyBudgetUSD: number`(既定 0 = 無効)を追加。`store.ts` の mergeConfig は 0 以上の有限数のみ採用。
- `store.ts`: `currentMonthTotals()` を追加(当月・暦月の SA 込み total usd/jpy/turns)。
- `src/budget.ts`(新規): `runBudget(argv)` = 表示(引数なし)/ 設定(`budget 400`)/ 解除(`budget 0`|`off`)。
  `parseBudgetAmount` は `$`/カンマ/空白を除去し 0 以上のみ許可。設定は config.json 全体を書き戻す(init と同じ流儀)。
  cli.ts に `budget` を配線。
- `setup.ts`: init に月予算を追加。対話は既定 **$400**(既存設定があれば維持)、非対話は `--budget <USD>`
  未指定時も既定 $400 を適用(既存があれば維持)。`DEFAULT_BUDGET_USD = 400`。
- `dashboard.ts`: 予算>0 のとき KPI 直下に `#cccn-budget` カードを出す。サーバは当月の初期表示を描画し、
  ブラウザ側 `renderBudget()` が**選択中バケットの暦月**(通算時は今月)に連動して差し替える(日/週選択時は
  その月へ丸める)。使用率でバー色分け(<70% ok / <100% warn / >=100% over)。バー幅は 100% 頭打ち。
  $ と ¥(fallbackRate 換算)を併記。embed に `budget` / `budgetRate` を追加。


## 2026-07-10 追加: 通知なしモード(記録・ダッシュボードのみ)
通知を一切送らず、記録とダッシュボードだけを使うモード。**新しい config キーは追加しない**:
既存の `notify: { os: false, slack: null }` がそのままこのモードの表現である(手動編集でも成立する)。

- `setup.ts`: 対話の通知チャネル選択に4つ目の選択肢「通知なし(記録・ダッシュボードのみ)」(value: `none`)を追加。
  非対話は `--no-notify`(`--os-only` / `--slack-only` / `--slack-webhook` とは排他。併用は exit 1)。
  どちらも結果は `notify.os=false, slack=null`。このモードではテスト通知をスキップし、その旨を表示する。
  対話の初期選択は既存 config から導出する(通知なしユーザーの再 init で `none` がプリセレクトされる)。
  注意: 再 init でチャネルを選び直す(または素の `--yes`)と通知は再有効化される(従来の slack-only と同じ流儀)。
- `track.ts`: 通知判定を `(notify.os || notify.slack !== null) && costUSD >= minNotifyUSD && !isMuted()` に変更。
  両チャネル無効なら todayTotalUSD() の履歴走査ごとスキップする。**記録・カーソル保存・ダッシュボード再生成は
  影響を受けない**(mute と同じ原則)。
- `doctor.ts`: テスト通知チェックの冒頭で両チャネル無効なら ✅「通知なし・ダッシュボードのみモード」を表示して
  早期 return(ミュート表示・通知経路の診断もスキップ)。notify.os の既定は true のため、両方無効は常に意図的な
  状態であり ⚠️ ではなく ✅ とする。exit code の意味は不変。
