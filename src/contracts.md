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
- `dataHomePath(): string`
- `configFilePath(): string`
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
- doctorの直近額はソース別で、Claudeは`Claude Code 直近セッション合計`、Codexは`Codex 最新rollout合計`
  と表示し、両者を合算しない。Codex行は常に
  `API換算・単一rolloutのみ・親/子未分類/非合算・Claude Code分とは別集計`を明示する。
- Codex合計は、安全に検査できた標準user/project JSON sourceにccc-notifier所有Stop handlerがある場合だけ実行する。新しい
  `__ccc-notifier-codex-hook Stop`と厳格な旧`track --codex`だけを認め、Codex home/sessionsの存在や
  TOML/opaque/plugin/managed sourceやsupplemental env-extra単独から設定済みと推測しない。path/timeout不一致は既存警告とし、所有判定自体は維持する。
- Codex合計はmtime最大の**単一rollout**だけを先頭から`splitIntoCodexTurnDrafts(path, null)`で読み、全draftの
  main bucketをモデル別にmergeしてoffline単価表で算出する。親/子rollout分類や別rollout、サブエージェント料金は加算しない。
  深さ4、通常ファイル限定、symlink非追跡の探索はsweepと共通化し、mtime同値は絶対path辞書順で決定する。
  directory/statの一部でも検査不能なら最新を断定せず警告して金額をskipする。
- Codex合計診断はhistory/cursor/activity/dashboard/rolloutを変更せず、保存lock・通知・dashboard生成を行わない。
  sessions/rollout/usage不在、読取・解析・pricing失敗、unknown modelは警告止まりで、それだけではdoctorをexit 1にしない。
  unknown modelは`Cc`/`Cf`/`Zl`/`Zp`除去・長さ/件数制限した名前と過少計上の可能性を表示する。
  model別集計はnull-prototype/own-property確認を使い、`__proto__`/`constructor`等をデータkeyとして安全に扱う。

## TurnRecord.models の定義
main のモデル → sidechain のみのモデル の順、重複排除。

## 2026-07-07 追加: Config.dashboard(オーケストレーター認可)
Config に `dashboard: { autoRegenerate: boolean; autoReloadSec: number; days: number }` を追加した。
既定は `{ autoRegenerate: true, autoReloadSec: 30, days: 30 }`。
- `autoRegenerate`: 正常な新規turnごとに直近版 `report.html`、ローカル日の初回に全履歴版 `report-all.html` を生成する(通知しきい値とは独立)。falseでも履歴/cursor commitのdata lockは使用する。
- `autoReloadSec`: 生成 HTML の `<meta http-equiv="refresh">` 間隔秒。0 で無効。
- `days`: 自動再生成と、引数なしの手動 `dashboard` で HTML へ埋め込む対象期間。正の有限整数のみ採用し、異常値は既定30日にフォールバックする。
mergeConfig は他キーと同じ流儀で dashboard を深いマージする(欠損サブキーはデフォルト補完)。

## src/dashboard.ts — writeDashboardHtml(2026-07-07 追加)
- `writeDashboardHtml(opts: { days?: number | null; outPath: string; autoReloadSec: number; allTurns?: TurnRecord[]; variant?: "recent" | "full" | "custom"; generatedAt?: string }): void`
  - `allTurns` がなければ `readTurns()` で履歴を1回だけ全件 read/parse → 既に読み込んだ配列を `days` で filter → HTML 生成 →
    一時ファイル + rename でatomicに書く。期間制限は HTML 構築・書き込み・ブラウザ描画の対象を減らすが、
    履歴の read/parse は全履歴量に比例する。
  - console 出力・ブラウザ起動はしない。失敗は throw(呼び出し側が処理)。
  - `autoReloadSec > 0` のとき生成 HTML の `<head>` に `<meta http-equiv="refresh" content="N">` を出力する。
  - recent版の期間表示は、埋め込まれたturnの最古〜最新をローカル暦日で数えたspanが指定days未満なら「履歴 N 日分」(Nは実span)、十分なら「直近 N 日版」(Nは指定days)。生成後に日付が変わるだけでは静的HTMLを変更せず、次turnまたは手動生成時に追従する。
  - runDashboard、track、正常完了したsweepの自動再生成(フェイルセーフ経路)の共通コア。

## 2026-07-12 追加: 直近版と日次全履歴版の分離

- canonical path は `CCCN_HOME/report.html`(直近版)と `CCCN_HOME/report-all.html`(全履歴版)。未生成peerには生成方法と戻るリンクを持つ軽量placeholderをatomic生成し、固定相対hrefを常に有効にする。
- 日次状態は `cache/dashboard-full-state.json`。`localDate`、`timeZone`、`generatedAt` を持ち、全履歴HTMLのatomic成功後だけatomic更新する。不在・破損・未来・TZ変更・full HTML不在は生成対象。
- `cache/data.lock/` はmetadata完成済みstaging directoryからatomic renameで取得する。ownerはtoken/pid/hostname/acquiredAt/heartbeatAt。heartbeat lease、同host+stale+ESRCHだけをreclaimer guard下で回収し、release/reclaimはtoken確認後に固有quarantineへrenameして固定pathを直接rmしない。
- trackは価格/Fxをlock外で準備し、commit lock内でcursor再読込→aggregate/SA→record→appendTurn→全saveCursor（append先行）を行う。解放後に通知、別のdashboard lock内でreadTurns→recent/full/stateを書く。timeout時はappend/cursor双方を行わない。
- sweepは探索・価格/Fxをlock外で準備し、通常実行は全sourceのreset/再生成を1つのdata lock内で行う。正常完了時は`dashboard.autoRegenerate=true`ならrecent/full canonicalを即時再生成して相互リンクを有効にし、falseなら生成しない。source partial failureとdry-runでは生成しない。lock timeout時はhistory/cursors/dashboardを変更しない。dry-runはlock不要でsource先頭からread-only previewする。
- manual/custom dashboardはhistory snapshot→HTML writeをdata lock内で行う。customはcanonical/state副作用なし。history clear/redactの非`--yes`は確認前対象集合の内容fingerprintとlock内再snapshotを比較し、不一致ならhistory/canonical無変更でexit 1。cancelも無変更。`--yes`は最新snapshotを採用する。承認後はcanonical/state事前無効化→rewrite→再無効化し、履歴なし/対象なし/書換失敗でも古いcanonicalを残さない。
- 手動dashboardのparser結果は `scope: "recent" | "all"` を必ず持ち、`days: null` からscopeを推測しない。引数なしはrecent + `Config.dashboard.days`、`--all`はall、`--days N`はrecent。canonicalの出力先はscopeから決め、正常なcanonical allだけが日次stateを更新する。
- `--out X`単独は旧CLI互換のall custom、`--all --out X`もall custom、`--days N --out X`はrecent custom。customはいずれもcanonical/placeholder/state副作用と相互navを持たない。
- `--all`と`--days`の併用は指定順に関係なくexit 1。`--days`の欠落・0・負数・小数・非数値、および`--out`の値欠落もexit 1。`--refresh`は0以上のsafe integerだけを受け付け、値欠落、次tokenがoption、小数、負数、部分数値、NaNをexit 1とする。未知optionと余剰positionもexit 1。すべてparse完了前に判定し、HTML/state/browser-open副作用なし。full placeholderは`ccc-notifier dashboard --all`、recent placeholderは`ccc-notifier dashboard`を案内する。

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
- Claude Stop時はメインusageが無くても新規SA usageを走査し、見つかった場合はメインcost 0のSA-only
  レコードとして即時保存する。このレコードでは通知を送らない。
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
    groups: SubagentUsageGroup[];                  // agentファイル単位のusageと時刻
  }
  ```
  - 対象ディレクトリ = mainTranscriptPath の末尾 `.jsonl` を除いたパス + `/subagents`
    (例: `/x/abc.jsonl` → `/x/abc/subagents`)。ディレクトリが無い/読めない → **null**(旧形式環境)。
  - `agent-` で始まり `.jsonl` で終わる通常ファイルのみ対象(`.meta.json` は読まない・symlink は辿らない)。
    ファイル数が 200 超なら更新時刻の新しい順に 200 件で打ち切る(異常系ガード)。
  - 各ファイル: `loadCursor` → `sanitizeCursor` → `aggregateNewTurn`(transcript.ts をそのまま再利用)。
    全行 isSidechain だが、将来フラグが変わっても取りこぼさないよう main と sidechain の両方を
    perModel にマージする。新規なし(null)はスキップ。1ファイルの失敗は握りつぶして次へ。
  - `message.id + requestId`は親transcriptの同一走査窓、処理済みagent cursor、同じ収集実行内の
    agentファイルをまたいで重複排除する。重複・期間外だけのファイルもcursorを進め、後続hookで再計上しない。
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
    各プロジェクトディレクトリ内の`*.jsonl`(1階層のみ)を先頭から走査し、**ターン単位に復元**する。
    サブエージェント(`<main>/subagents/agent-*.jsonl`)も`collectSubagentUsage`で回収する。
  - 通常`sweep`はdata lockを全体で1回保持し、canonical dashboard/stateを無効化してhistory/cursorsを
    backupなしでresetした後、Claude main/agentとCodex rolloutを先頭から再生成する。
  - 全sourceの再生成が正常完了した場合、`dashboard.autoRegenerate=true`なら直近版と全履歴版のcanonical HTMLを即時再生成し、相互リンクを利用可能にする。false、`--dry-run`、source partial failureではHTMLを生成しない。
  - 実行中は単価表・為替の準備、通常実行のdata lock取得待ち、走査開始、Claude transcript / Codex rolloutの処理状況、走査完了、条件成立時のdashboard生成開始を改行区切りで出力する。sourceごとの進捗は25件ごとのみとし、25件未満の小規模sourceは走査開始・走査完了などの段階表示だけとする。TTYとredirectで同じ形式を使い、進捗には個別source pathとprompt本文を出さず件数だけを表示する。`--dry-run`はdata lock取得とdashboard生成を行わず、その段階も表示しない。
  - フラグ: `--dry-run`(source先頭からread-only preview)/ `--days <N>`(reset後、期間内turnだけを保存。
    cursorは読取末尾まで進める)/ `--projects <dir>`(Claude走査ルート上書き)。
    `--days`指定時のSAはassistant行ごとに期間判定し、agentファイル全体の最新時刻だけでは判定しない。
    agent単位のSA usageは、その完了時刻以後で最初に完了した親ターンへ寄せ、親ターンが無ければSA-only記録にする。
    `--rebuild`/`--yes|-y`/`--include-active`は廃止し、未知option・値不足・余分な位置引数とともにmutation前に拒否する。
  - 円換算はsweep実行時のレート(`getUsdJpy`)。USDもsweep実行時に`loadPriceTable(cacheDir, { offline: false })`で取得した単価表による概算とし、過去時点の単価・為替は保存・再現しない。
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

## 2026-07-08 追加: doctor の hook 登録ログにコマンド全文を表示
`checkHookRegistration` の成功ログを `hooks.Stop に ccc-notifier のエントリが登録されています(N件)` から
`(N件): <command> / <command> ...` に変更し、実際に登録されている絶対パス入りコマンドを表示するようにした。
複数クローン/グローバルインストールが混在する環境で「どの実体が hook として動いているか」を doctor 一発で判別できる
ようにするため(README の「アンインストールしたい」節から誘導)。ログレベル・件数計算・他チェックの挙動は不変。

## 2026-07-08 追加: ダッシュボードの期間切替(日/週/月・通算)
ダッシュボードを「サーバ側で固定期間を集計・SVG 描画」から「全履歴を埋め込み、ブラウザ側で期間集計・描画」へ
作り替えた。

- `src/dashboard.ts`: 手動 `dashboard` は既定で `report.html` に `Config.dashboard.days` 分(既定30日)を埋め込む。`--all` は `report-all.html` に全履歴、`--days N` は `report.html` に直近N日を埋め込む。不正な `--days` はfallbackせずexit 1とする。`track.ts` の自動再生成は
  `writeDashboardHtml({ days: cfg.dashboard.days })` で設定期間(既定30日、異常値も30日)だけを埋め込む。全履歴版は日次生成する。
  これにより HTML 構築・書き込み・ブラウザ描画の負荷を抑える。期間限定版でも保存済み全履歴の当月分を
  集計対象から落とさないため、履歴ファイルは`readTurns()`で1回だけ全件read/parseし、埋め込み対象はその配列からfilterする。この部分はO(全履歴)。
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
  壊れた行・ts 不正な行は触らない。変更成功後は両canonical dashboardと日次stateを削除する（所有中lockはfinallyでtoken一致解除）。cli.ts に `history` を配線。

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
- `store.ts` の `dataHomePath()` / `configFilePath()` は呼び出し時の `CCCN_HOME` を反映してパスだけを返し、
  home / cache ディレクトリを作らない。従来の `paths()` はこれらを利用しつつ、home / cache を作る契約を維持する。
- `dashboard.ts`: 予算>0 のとき KPI 直下に `#cccn-budget` カードを出す。手動の全履歴版では、
  ブラウザ側 `renderBudget()` が**選択中バケットの暦月**(通算時は今月)に連動して差し替える(日/週選択時は
  その月へ丸める)。自動再生成などの期間限定版では、埋め込み対象外も含む保存済み全履歴の**当月分**を
  集計対象から落とさず、その値に固定し、
  期間選択には連動しない。どちらもソースフィルタには連動せず全ソース合算。使用率でバー色分け
  (<70% ok / <100% warn / >=100% over)。バー幅は 100% 頭打ち。
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

## 2026-07-10 追加: Codex CLI 対応(オーケストレーター認可)

OpenAI Codex CLI(`~/.codex`)のセッションログ(rollout jsonl)を Claude Code と同じ通知・記録・
ダッシュボード基盤に載せる。契約全文(設計根拠込み)は
`.claude/plans/2026-07-10-codex-implementation-orchestration.md` §4(4-1〜4-9)。以下はモジュール別に転記する
(見出し構成のみ本ファイルの体裁に合わせ、シグネチャ・アルゴリズム・数値・フラグ名は変更していない)。

### src/types.ts / src/store.ts — Cursor.codexTotals・TurnRecord.source
```ts
// Cursor に追加(optional・後方互換):
codexTotals?: { input: number; cached: number; output: number };
// Codex rollout の total_token_usage 累積スナップショット(差分集計用)。Claude transcript では常に undefined。

// TurnRecord に追加(optional・後方互換、schemaVersion は 1 のまま):
source?: 'codex';  // 無し = Claude Code。ingest と同じ流儀
```

`store.ts` の `sanitizeCursor` は codexTotals(3キーとも有限な非負 number のときのみ)を通す。不正なら undefined に落とす。

### src/codex/env.ts(新規)
- `codexHome(): string` // CCCN_CODEX_HOME || join(homedir(), '.codex')
- `detectCodex(): boolean` // codexHome() がディレクトリとして存在するか(statSync, 例外は false)

### src/codex/transcript.ts(新規)
- `aggregateCodexTurn(rolloutPath: string, cursor: Cursor | null): Promise<TurnAggregate | null>`
- `splitIntoCodexTurnDrafts(rolloutPath: string, cursor: Cursor | null): Promise<CodexTurnDraft[] | null>`
```ts
interface CodexTurnDraft {
  agg: TurnAggregate;      // ターン1件分(下記規約で構築)
  endTs: string | null;    // そのターン最後のイベント timestamp(record.ts に使う)
  isSubagentRollout: boolean; // session_meta.payload.source.subagent を持つ child rollout か
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
  (prev はセグメントを跨いで持ち回る。末尾に task_complete 後のusageが残る場合は、進行中ターン自身のmodel/prompt/cwdを持つ独立ドラフトにする)。
  **全ドラフトの acc 合計・適用後の newCursor は、同一ウィンドウに対する aggregateCodexTurn の結果と一致**(hook ↔ sweep 相互運用)

### src/codex/setup.ts / src/codex/subagent-store.ts (Gate D 準備)
- `codexHooksFile(): string` // join(codexHome(), 'hooks.json')
- `codexHookCommand(nodePath, cliPath, event)` // `"<node>" "<cli>" __ccc-notifier-codex-hook <event>`
```ts
interface CodexHookResult { status: 'written' | 'unchanged' | 'manual'; backupPath: string | null; manualSnippet?: string; }
```
- `registerCodexHook(nodePath: string, cliPath: string): CodexHookResult`
- `removeCodexHook(): CodexHookResult`
- `Stop` / `UserPromptSubmit` / `SubagentStart` / `SubagentStop` の各handlerはtimeout 20秒。所有判定は専用内部subcommandの完全形のみ
  (旧 `track --codex` はCLI pathがccc-notifierを含む完全形だけをStopのupgrade対象にする)。
- 非破壊マージ: 自handlerだけをadd/update/removeし、同groupの他handler、group/handler/rootの未知キーを保持。
  groupが空になったときだけgroupを削除し、eventが空ならeventキーも削除する。
- 書き込み前に `hooks.json.bak-<timestamp>` バックアップ(新規作成時はバックアップなし)
- JSON パース不能・対象event異形 → 書き込まず `status: 'manual'` + 4eventスニペット返却
- 末尾改行付き・2スペースインデントで整形(既存ファイルの見た目を維持)
- v2の匿名keyは`sessionKey=HMAC(root-session-v2, session_id)`、`rootKey=HMAC(root-turn-v2, session_id, root turn_id)`、
  `agentKey=HMAC(agent-identity-v2, session_id, agent_id)`とする。subagent hook自身の`turn_id`は検証するがjoinに使わず保存しない。
  生ID、prompt、raw payload、cwd、本文、transcript pathは台帳・backup・通常ログへ保存しない。
- UserPromptSubmitはsessionごとのactive rootをopenする。同sessionの別rootがopenなら旧rootをabandonedにしactivityを移さない。
  親Stopはexactなsession+root turnでopen/abandoned rootをcloseし、closed再送では同じrootKeyを返す。root未記録なら推測作成しない。
- SubagentStartだけが未割当agentをexactly oneのopen active rootへassignmentする。SubagentStopは既存assignmentだけを更新し、
  active rootがあっても未割当Stopを新規assignmentしない。既知agentのlate Stop/再送は元rootへ更新し、未知late event、root不在、
  複数open、別root中の同agent Start(ID再利用疑い)はfail-closed。conflictは匿名markerと固定diagnosticだけを残す。
- production hookはraw identityの構造検証、secretからのHMAC導出、active root参照、assignment/writeまでを同じactivity lock内で
  完了する。UserPromptSubmit/親Stopもraw identityからroot遷移までを同じlock内で行い、並行時の帰属はlock取得順と一致させる。
- activity台帳はroot内のunique agentごとにStart/StopをOR mergeし、逆順・再送・複数Stopへ冪等。agent typeは既知safe label
  または固定`unknown`だけを保存する。lock ownerはstagingでatomic完成後にcanonicalへno-replace publishする。same-host dead PIDは
  age不要で一意claim回収し、live/foreign/生死不明ownerはfail-closed。旧malformed directoryは短い初期化猶予・再読込後に
  一意rename claimできたprocessだけ回収し、releaseはtoken一致時だけ行う。canonical publishの`EEXIST`は、その直後に
  ownerがreleaseしてcanonicalが消えても通常contentionとして再試行する。その他のpublish errorはcanonical実在時だけ
  保守的contention、不在時は即時fail-closed。acquire deadlineは回収成功による`continue`でも迂回できない。
- ledger schema v2はsession/root/assignment/conflict/sequenceと任意の`legacyV1.agents`を持つ。秘密を含まないHMAC `keyCheck`を維持し、
  valid v1は元rawの製品固有backupを一度だけ作ってatomicにv2へ移行する。復元不能なv1 keyを別rootへ推測再割当しない。
  v1/v2の全objectはschema allowlist外fieldを拒否し、raw/private fieldをmigration backupや再writeで複製しない。v2では各stateの
  `projectionKey`が外側rootKeyと一致し、全root agentがexactly one rootだけに存在して`agentAssignments`から同じrootへ双方向参照
  されることを必須とする。不一致はread/mutationともfail-closedで、元台帳を上書きしない。
  キーは32-byte長だけでなくkeyCheckもconstant-time照合し、
  同長置換・1bit破損・keyCheck破損ではkey/ledgerを変更せずfail-closed。永続化失敗はpassive wireやmain trackへ伝播させない。
- Gate D表示投影では、UserPromptSubmitで記録済みのexact rootを親Stopがcloseできた場合だけ、activityの有無と
  到着順と無関係に`activityProjectionKey`(v2 rootKey)を保存する。親Stopはpricing/FX/transcript集計より前にactivity lock内でledgerの
  `keyCheck`を検証し、key/ledger不整合やledger破損時は未検証keyを付けずmain turn記録だけを継続する。
  keyの存在だけでは利用ありと判定せず、対応するcanonical activityが無ければruntime `subagentActivity`を付けない。
  生のturn/agent ID、hook由来path、raw payloadは保存せず、key生成失敗はmain turnの記録を止めない。
  valid secretと破損ledgerの組合せでもmain turn保存は継続するが、`activityProjectionKey`は付けず投影をfail-closedにする。
- key/ledgerのatomic staging名はraw hostnameを保存せず、domain-separated SHA-256由来の固定host tagを含める。
  対応lock保持中に、製品固有の厳格命名、local host tag一致、regular file/dir、60秒以上の経過、same-host dead PIDを
  すべて満たすものだけを回収し、host tag不一致・旧hostless名・live/unknown owner・進行中stagingは削除しない。
  key/ledgerの通常write/rename失敗時はwriter自身のtmpを`finally`で削除し、特に秘密key複製を残さない。
- same-host ownerでもPID再利用により別のlive processが同じPIDを持つ場合は安全側に倒してlockを自動回収しない。
  timeoutが継続する場合は、該当PIDがccc-notifier/Codexの処理でないことを利用者が確認してからlockを手動退避・削除する。
- `TurnRecord.subagentActivity`はoptionalかつruntime-only。`readTurns`がcanonical台帳を1回だけ読み、同じ
  `activityProjectionKey`のunique agent stateから`started` / `stopped` / safeな`agentTypes` /
  `usageStatus: 'unavailable' | 'partial'`をpure mergeする。保存済みの同名フィールドは信用しない。
  assignment済みagentのlate Stopは次turnへ付けず元recordの次回readへ反映し、history行数・turn数・料金を変えない。
  v1 Historyは`legacyV1.agents`の旧projection keyと完全一致する場合だけread-only投影を継続する。
- Gate A未承認のため、Gate D表示投影はchild transcript/token/cost/pricing/unknownModels/subagents/cursor/
  sweep分類を一切作らない。現段階の投影statusは料金を推測せず`unavailable`。

### src/pricing.ts / src/format.ts
- `builtinPriceTable()` に追加(USD/1M・write 系 0):
  `gpt-5.5`(5, 30, cacheRead 0.5)/ `gpt-5.1` `gpt-5` `gpt-5-codex` `gpt-5.1-codex`(1.25, 10, 0.125)/ `o3`(2, 8, 0.5)
- LiteLLM 取り込み: 既存 claude フィルタに加え、`litellm_provider === 'openai'` かつキーが `/^(gpt-|o3($|-)|codex-)/` に一致し
  `input_cost_per_token`+`output_cost_per_token` を持つエントリを採用。`cache_read_input_token_cost` → cacheRead、write 系 0
- `modelDisplayName`: `gpt-5.5-codex → GPT-5.5 Codex` / `gpt-5-codex → GPT-5 Codex` / `gpt-5.5 → GPT-5.5` /
  `o3 → o3`。一般規則: `gpt` プレフィックスを `GPT` に、`-codex` サフィックスを ` Codex` に、その他ハイフン区切りは既存 claude 系の流儀に準拠

### src/track.ts / src/cli.ts
- `runTrack(stdinText: string, opts?: { codex?: boolean }): Promise<void>`(既存呼び出しは無変更で互換)
- codex 経路: transcript_path → `aggregateCodexTurn`。モデルは **hook payload の `model` を優先**し、
  agg 側が `"unknown"` のときの代替にも使う。TurnRecord に `source: 'codex'` を付与。
  subagents 収集(collectSubagentUsage)は**呼ばない**。それ以外(価格・fx・appendTurn・通知判定・
  ダッシュボード再生成・ミュート・通知なしモード)は既存共通経路
- UserPromptSubmit/SubagentStart/Stop hookは利用記録だけを更新し、history adjustment、料金、通知、dashboard自動生成を行わない。
  assignment済みagentの親Stop後late eventだけを匿名keyで元turnへ結合し、表示は次の通常turnによる再生成、または手動`report` /
  `dashboard`実行時に更新する。曖昧な未知late eventと導入前のkey無し旧recordには遡及適用しない。
- cli.ts: 旧`track --codex`互換に加え専用passive hookをdispatchする。`UserPromptSubmit`と`SubagentStart`はstdout 0 bytes、
  `SubagentStop`と親`Stop`は常にUTF-8 `{}\n`だけ、全経路exit 0。親Stopだけ既存Codex trackへ渡す。

### src/setup.ts / src/doctor.ts
- init フラグ追加: `--codex`(Codex hook を導入)/ `--no-codex`(スキップ)。排他(併用は exit 1)。
  `--yes` のみ(どちらも未指定)では **Codex に触らない**
- 開始時点で config path entry が存在する既存環境の、許可tokenが `--yes`/`-y` と `--codex` だけの
  非対話呼び出しは Codex hook 限定移行とする。config は parse せず、config / Claude settings / テスト通知 /
  last-notify / history / cursor / dashboard / mute / activity / cache を変更しない。config存在判定は副作用のない
  `lstat` で行い、通常symlink・dangling symlinkも既存扱い、ENOENTだけを新規扱い、その他の判定失敗は何も変更せず exit 1。
- 限定移行は `registerCodexHook` だけを実行する。`written` / `unchanged` は exit 0、壊れたhooks等の `manual` は
  手動JSONを表示して exit 1。通常initでのCodex `manual` は副次機能として従来どおり exit 0。
- config不在の初回、対話init、設定変更flagまたは未知tokenを含む呼び出しは従来の通常initであり、config・Claude
  settings・テスト通知を含む全体セットアップを行う。
- 対話: 既存質問の後、`detectCodex()` が真のときのみ confirm「Codex CLI を検出しました。Codex にもコスト通知を入れますか?」(既定 Yes)。
  導入した場合は完了メッセージで信頼確認の案内:
  「次回 codex 起動時に『Hooks need review』が表示されます。『Trust all and continue』を選ぶと有効になります(承認までは動きません)」
- uninstall: `removeCodexHook()` も実行(未導入なら黙ってスキップ)。`--purge` は従来どおり
- doctor: hook登録セクションの後にCodexブロックを置く。env指定なしでもuser `hooks.json` / `config.toml` と、cwdから
  親方向へ見つけたrepo candidateの `.codex/hooks.json` / `.codex/config.toml` を確認する。project sourceが存在すれば
  `detectCodex()` falseでもearly returnしない。JSONだけを1MiB上限・regular file・strict shapeで検査し、TOMLは存在だけを
  opaque候補として表示して内容を解釈しない。owned handlerのsource/event/actual・expected path/timeout、検査済みJSON間の
  exact duplicate、同一layerのJSON/TOML併存potential duplicateを表示する。trust、global/individual disabled、
  plugin/managed/session sourceの実効状態はunknownとし、Codexの `/hooks` を最終確認先として案内する。
  `CCCN_CODEX_HOOK_SOURCES` は標準候補を置換しないsupplemental sourceに限定する。
- setup/doctor/docsはStop / UserPromptSubmit / SubagentStart / SubagentStopの4eventを一貫して表示し、3eventからの更新後は
  Codex再起動と追加UserPromptSubmitを含む4eventのtrust確認を案内する。

### src/sweep.ts
- 既存 Claude 走査の後に Codex 走査: `codexHome()/sessions` 配下の `rollout-*.jsonl`(`YYYY/MM/DD` 3階層・
  readdir 再帰は深さ4まで)。`detectCodex()` 偽 or sessions 不在なら黙ってスキップ
- rollout列挙はdoctorとread-only helperを共有し、通常ファイル限定・symlink非追跡・深さ上限を一致させる。
- 各ファイル: cursorなしで`splitIntoCodexTurnDrafts` → `--days`フィルタ(endTs基準・cursorは読取末尾まで進める) →
  TurnRecord(`source: 'codex'`, `ingest: 'sweep'`)。進行中rolloutも常にbest-effortで走査する
- `session_meta.payload.source.subagent`を持つchild rolloutは、Codexサブエージェント料金未集計の仕様に合わせ、料金・履歴・cursorへ入れない。
  `source`欠損・未知形式は通常rolloutとして維持する。doctorの最新単一rollout診断は従来どおり親/子未分類。
- サマリーに Codex 分の件数/金額を1行追加(「Codex: N ターン $X」。0件なら出さない)

### src/dashboard.ts
- embed の turn に `sc: 'codex' | undefined` を追加(Claude は undefined で容量節約)
- ソースフィルタチップ `[全体] [Claude] [Codex]` を粒度トグルの隣に表示(**Codex レコードが1件も無ければ非表示**)。
  選択は sessionStorage `cccn-src`(値: `all` | `claude` | `codex`、既定 all)で自動リロードを跨いで保持
- フィルタはチャート・モデル別・プロジェクト別・ターン履歴・KPI に適用。**月予算カードは常に合算**(カード内に「全ソース合算」を小さく明記)
- ターン履歴の行に `Codex` バッジ(source が codex のとき)。XSS 不変条件(textContent / < エスケープ)維持
- Codex activityがある行は「利用あり・料金未集計」と開始/終了unique数・safe typeを表示する。内部key/ID/pathは
  embed/UIへ出さず、Claudeの既存`+SA`料金表示、filter、総額、月予算は変えない。
- slot 配色ロジックは不変(全履歴のモデル別総コスト)

### 2026-07-10 Wave 2 での契約修正(オーケストレーター認可・実装済み)
- **sweep の走査ルート意味論**: 従来の「Claude projects ルート不在 → 即 return 1」を廃止。Claude ルート不在でも
  Codex(`detectCodex()` かつ `codexHome()/sessions` がディレクトリ)が走査可能なら警告1行
  「Claude の走査ルートが見つかりません: <root>(Codex のみ走査します)」を出して続行(exit 0)。
  **両方**走査不能のときだけ従来メッセージ + return 1。判定は `codexSessionsRoot()` ヘルパーで
  sweepCodex と共有する(基準の一致を構造的に保証)。
- **sweep サマリーの Codex 行書式**: 「うちサブエージェント」行と一貫させ `Codex: N ターン $X(¥Y)`
  (¥ は fx.rate 換算・同じ字下げ)。
- **ダッシュボードのヒーロー(通算バナー)はソースフィルタに連動**する(合計・「うちサブエージェント」行とも。
  SA 合計ゼロ時は行ごと非表示)。「常に全ソース合算」の例外は**月予算カードのみ**。
  HAS_CODEX(=Codex レコード存在)が偽のときはクライアントはヒーロー/KPI に一切触れない(サーバ描画のまま)。
- **テスト隔離の追加規約**: sweep / doctor / init / uninstall を実行するテストは `CCCN_CODEX_HOME` を
  一時ディレクトリ(または不在パス)へ隔離すること(実 `~/.codex` の読み書きを防ぐ。読みだけでなく
  uninstall 経由の**書き込み**ハザードがある)。

## 2026-07-15 変更: sweepを単純な全再生成へ統一

- `ccc-notifier sweep [--days N]`は確認なしで既存data lockを1回取得し、canonical dashboardを無効化してから`history.jsonl`と`cursors.json`をbackupなしで削除する。その後、Claude main/agentとCodex rolloutをcursorなしで先頭から走査し、全期間または指定期間の履歴とcursorを再生成する。
- `--dry-run [--days N]`は同じsourceをcursorなしで先頭から走査するread-only preview。data lock、reset、履歴/cursor保存、dashboard無効化、設定変更を行わない。
- 実行中は単価表・為替の準備、通常実行のdata lock取得待ち、走査開始、Claude transcript / Codex rolloutの処理状況、走査完了、条件成立時のdashboard生成開始をline-basedで表示する。sourceごとの進捗は25件ごとのみとし、25件未満の小規模sourceは走査開始・走査完了などの段階表示だけとする。TTYとredirectで同じ改行区切りを使い、進捗には個別source pathやprompt本文を出さず件数だけを表示する。`--dry-run`はdata lockとdashboard生成の段階を持たない。
- 進行中sourceも常にbest-effortで読み、同時truncate/rewriteの完全性は保証しない。Claude/Codexの終了・再起動、通知停止marker、maintenance modeは使わない。sweep中に競合したhookの通知は欠け得て再送しない。lock解放後は追加操作なしで通常動作へ戻り、読取後の末尾は後続hookが回収する。
- reset対象はhistory、cursors、canonical dashboardと日次更新stateだけ。全sourceの再生成が正常完了し、`dashboard.autoRegenerate=true`なら直近版・全履歴版と日次更新stateを即時再生成して相互リンクを有効にする。false、`--dry-run`、source partial failureでは生成せず、必要なら手動`dashboard` / `dashboard --all`に委ねる。config、月予算、通知設定、mute、単価/為替cache、Codex hook、Codexサブエージェント利用記録は保持する。
- 対象履歴はsweep実行時点の単価表/FXで再計算し、過去額は変わり得る。clear済み履歴/redact済みpromptもsourceにあれば復活する。source消失・移動・破損行は復元できない。Codexサブエージェント利用記録は保持するが、再生成した過去turnへの表示joinは失われ得る。
- source単位のhard failureは終了コード1とし、部分生成をrollbackしない。同じ`sweep`を再実行すると履歴/cursorを再度resetして最初から再生成する。
