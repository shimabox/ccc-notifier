# 可逆な sweep バックフィル(最小構成)実装計画

- 日付: 2026-08-13
- ブランチ: plan/2026-08-13-reversible-sweep-minimal
- 状態: **実装前計画**(このファイルは計画のみ。ソースコード・テストは変更しない)
- 前提コード: `main`(eec5a70、PR #16 マージ後)。本文の行番号はこの時点のもの
- 旧計画: リポジトリルートの `REVERSIBLE_SWEEP_BACKFILL_IMPLEMENTATION_PLAN.md`(2026-07-14)。同じ利用者価値を、現在の実装(呼び出し指紋 `countedCalls` / `ingestKey`)を前提に最小の変更で達成し直す

## 1. 何を解決するのか

### いまの不便

`sweep --days 7` を実行すると、7日より古い履歴は**後から足せない**。

```bash
ccc-notifier sweep --days 7   # 直近7日だけで履歴を作る
# …後日「やっぱり過去分も見たい」となったとき、
ccc-notifier scan             # → 0件(カーソルが末尾にあるので古い分を読み直さない)
ccc-notifier sweep            # → 全期間が戻るが、reset + 全再生成
```

唯一の回復手段である引数なしの `sweep` は「reset + 全再生成」なので、

- 取り込み済みの直近分も含めて**全レコードを実行時点の単価表・為替で作り直す**(記録済みの `fxRate` / `costJPY` が変わる。hook が当時記録した値も失われる)
- `history clear` で消した履歴・`history redact` で消したプロンプトが**元 JSONL から復活する**(docs/sweep.md:47 に明記された現行仕様)
- 全 source を先頭から走査し直す(重い)

つまり「まず直近だけ取り込んで様子を見て、後から過去分を**追加**する」という段階的な使い方ができない。docs/sweep.md:25 も「後から古い履歴も戻したい場合は、引数なしの `sweep` で全期間を再生成してください」と案内している。

### なぜ起きているのか(現行コードで確認済みの事実)

1. `sweep` の通常実行は無条件に `resetHistoryAndCursors()`(src/sweep.ts:1079、src/store.ts:575)で `history.jsonl` と `cursors.json` を削除してから走査する。`--days N` は「reset 後、期間内だけを保存する」の意味(src/contracts.md「2026-07-15 変更: sweepを単純な全再生成へ統一」)。
2. `--days` で期間外と判定したターンは**記録せずにカーソルだけ進める**。
   - Claude: src/sweep.ts:583 `if (tsMs < daysCutoff) continue;` の後、src/sweep.ts:625 でウィンドウ全体の `newCursor` を保存
   - Codex: src/sweep.ts:708(捨てる)+ src/sweep.ts:730-731(最終ドラフトのカーソルを保存。コメントに「--days で捨てたターンぶんもここで消費され、次回以降に再取り込みされない」と明記)
3. 増分取り込み(`scan` / track 便乗り取込 = src/ingest.ts)は**カーソルがあるファイルはカーソルより後ろしか読まない**。カーソルは末尾にあるので、捨てられた古いターンは二度と読まれない。

一方で、**二重計上防止の真実源はもうカーソルではない**。2026-08-11 の変更(src/counted-calls.ts、src/contracts.md「append の冪等化」)で、計上済みの API 呼び出し1件ごとの指紋(`TurnRecord.countedCalls`)とレコード一意キー(`ingestKey`)が history 側に保存され、取り込み側(src/ingest.ts:429-468、src/track.ts:154-210)はカーソルが無い・信用できないとき history 由来の指紋で呼び出し単位に除外する。`reset-cursors` コマンド(src/reset-cursors.ts)は「カーソルを全損させても履歴側の指紋で二重計上を防ぐ」ことを前提に既に出荷されており、コード内コメントに「cursors.json 全損と同じ状態で、実データでの検証済み」とある。

つまり、**「古いターンをもう一度読み直しても二重計上しない」仕組みは既に存在する**。欠けているのは「カーソルを無視して先頭から読み直し、指紋に無い分だけを追記する」操作を、安全なプレビュー付きの1コマンドとして提供することだけである。

## 2. どんな価値をユーザーに届けるのか

利用者から見て、次の段階的な手順が成立する。

```bash
# 1. まず直近7日だけで始める(dry-run で件数と概算を確認してから)
ccc-notifier sweep --dry-run --days 7
ccc-notifier sweep --days 7

# 2. 後日、残りの過去分を「追加」する(これも dry-run で確認してから)
ccc-notifier scan --backfill --dry-run
ccc-notifier scan --backfill
```

このとき利用者が得る体験:

- **既に取り込んだ分はそのまま**。直近7日のレコード(金額・為替・プロンプト)は1バイトも変わらない。hook が記録してきた履歴も壊れない
- **足りない分だけが増える**。同じコマンドを何度実行しても件数は増えない(冪等)
- **消した・秘匿したものは尊重される(prompt について)**。`history redact` で消したプロンプトは、バックフィルを実行しても復活しない(§6)
- **途中で失敗しても壊れない**。中断後に再実行すれば残りだけが入る
- 全期間 `sweep` のような「一度全部消して作り直す」賭けをしなくてよい

## 3. 旧計画からの前提の変化(計画を立て直す根拠)

旧計画書と現行コードを突き合わせて確認した差分。旧計画の記述は現状を表していない箇所がある。

| 旧計画の記述 | 現在の事実 |
|---|---|
| 2.2「カーソルは高速化と二重計上防止を兼務。単純に `--days` 時だけカーソルを進めない案は採用できない」 | **兼務は解消済み**。真実源は history 側の `countedCalls` / `ingestKey`(src/counted-calls.ts、contracts.md 2026-08-11)。カーソルは高速化ヒント |
| 2.1「現在のテストも『--days 0 後に無制限 sweep しても古い履歴は復活しない』を期待値として固定」 | **逆**。test/sweep.test.ts:391-410(Claude)・:704-(Codex)は「制限なし sweep は全期間を復活させる」を固定している |
| 3章の CLI 契約(`--rescan` / `--rebuild` / `--include-active`) | 現行 sweep は単純な reset+全再生成に統一済みで、旧 `--rebuild` / `--yes` / `--include-active` は**使用不可**(docs/sweep.md:14) |
| 2.3「`--days` cutoff が SA の子ファイルへ適用されない」 | 適用済み。sweep は `collectSubagentUsage` に `minTimestampMs: daysCutoff` を渡す(src/sweep.ts:596。test/sweep.test.ts:263「1c」が固定) |
| 2.7「append 後・カーソル保存前のクラッシュで二重計上」 | 保留マーカー(`cache/pending-append.json`、src/store.ts:441-559)+指紋で解決済み。WAL は導入されていないし不要になった |
| 2.6「`history clear` / `redact` はカーソルを残す」 | **現在も真**(src/history.ts はカーソルに触れない)。この性質は §6 の判断で使う |
| 9-13章(WAL / ingest state / 匿名 identity 基盤) | 未実装のまま。同等の目的(冪等・カーソル非依存)は指紋方式で達成されており、本計画では導入しない |

## 4. 方針

### 検討した案

**案A: `--days` のとき期間外分のカーソルを進めない(旧計画が却下した素朴案の復活)**

指紋があるので二重計上はしない。しかし採用しない。カーソルが無い(または手前にある)ファイルは、次の取り込み——`scan` だけでなく **track の便乗り取込(毎 Stop hook)** ——が自動的に先頭から読み直して**残り全部をその場で取り込んでしまう**(src/ingest.ts:585-591 は「カーソルが無いファイルは mtime が動かなくても必ず走査する」)。つまり「7日だけにしておく」という利用者の選択が、次のターンで黙って取り消される。deferred(保留)を表現するには「読んだが取り込まない」状態の永続化が要り、それは旧計画の ingest state 基盤に逆戻りする。

**案B: 何も作らず `reset-cursors` + `scan` を案内する(現状で可能な回避策)**

`reset-cursors`(カーソル全破棄・履歴保持)→ `scan` で、実は今日でもバックフィルは概ね成立する(指紋が守るため)。ただし: (1) 実行前プレビューができない——`scan --dry-run` はカーソルを見るので、先に `reset-cursors` で**状態を壊してから**でないと予告が出ない、(2) `reset-cursors` した瞬間から次の Stop hook の便乗り取込が走り得て、dry-run で確認する前に本取り込みが始まる、(3) 全カーソル破棄は無関係な進行中セッションの取り込みも一度遅くする。回避策としては docs に載せる価値があるが、主経路にはしない。

**案C(採用): `scan --backfill` —— カーソルを「メモリ上でだけ」無視する追記型の再走査**

`scan`(src/ingest.ts の `runIngest`)に backfill モードを足す。動作は「全対象ファイルをカーソル無しとして先頭から読み直し、history 指紋・`ingestKey` に無い分だけを追記する」。これは **ingest が『カーソル欠損ファイル』に対して今やっていることと同一のコードパス**であり(src/ingest.ts:477-523・525-563 の cursor === null 分岐)、新しい正しさの仕組みを何も導入しない。dry-run は状態を一切変えずにプレビューできる(runIngest の dryRun パスは既に read-only)。

### 採用する設計の骨子

1. **`sweep` は一切変えない**。`sweep --days N` の「reset 後、期間内だけ保存・カーソルは末尾へ」という契約(contracts.md 2026-07-15、テスト固定済み)はそのまま。指紋が真実源である今、「捨ててカーソルを進める」ことは無害になった——後から `scan --backfill` で読み直せば、指紋に無い分だけが入るため
2. **`scan --backfill [--dry-run] [--json]` を追加**。runIngest にオプション(例: `ignoreCursors: true`)を1つ通し、
   - `cursors.json` は読み飛ばす(ファイルは変更せず、メモリ上で全ファイル cursor=null 扱い。SA 子ファイルのカーソル参照 `readCursor` も同様に null を返す)
   - mtime プリフィルタを無効化(全ファイル走査)
   - 除外条件は現行どおり: history 由来の指紋(`countedCalls`)/ `ingestKey` 照合 / 指紋を持たない旧レコード向けのセッション別 ts 下限(legacyFloors)
   - 取り込み成功後は現行 commit と同じくカーソルを末尾へ保存(次回以降の通常 scan/hook を速く保つ)
3. **バックフィルでは取り込みサマリー通知(`notifyIngestSummary`)を送らない**。過去分の一括取り込みは「新たな支出」ではなく、月をまたぐ大きな合計で通知が鳴るのは誤報に近い(`sweep` も通知しない)。通常 `scan` の通知挙動は変えない
4. レコードには現行の `ingest: "scan"` をそのまま付ける(`TurnRecord.ingest` の型 `'sweep' | 'scan'`(src/types.ts:89)を広げない。スキーマ変更ゼロ)
5. ダッシュボードの即時再生成はしない(現行 `scan` と同じ)。完了メッセージで `dashboard` / `dashboard --all` を案内する。次の Stop hook でも直近版は自動更新される

### この最小構成で足りる根拠

- 二重計上防止・冪等性は既存機構(指紋 + `ingestKey` 照合 + legacyFloors)をそのまま使う。バックフィル固有の正しさの仕組みを新設しない
- 「カーソル欠損ファイルを先頭から読み直して差分だけ追記する」コードパスは ingest に実装済みで、`reset-cursors` の出荷によって実運用の検証も済んでいる(src/reset-cursors.ts のコメント: カーソル全損状態を実データで検証済み)。backfill はその適用条件を「カーソルが無いとき」から「利用者が明示したとき」へ広げるだけ
- 途中クラッシュ: レコード append 済み・カーソル未保存で落ちても、再実行時に指紋・`ingestKey` が重複を落とす(現行 ingest と同じ倒し方。src/ingest.ts:441-459)

## 5. スコープ

### やること

- `scan --backfill`(`--dry-run` / `--json` と併用可)の追加。src/ingest.ts へのオプション追加、src/scan.ts のフラグ、src/cli.ts のヘルプ
- バックフィル時の通知抑止
- テスト(§8 の受け入れ基準を固定するもの)
- docs 更新: docs/sweep.md:25 の「全期間を再生成してください」を「追記型の `scan --backfill` で後から足せる(単価・為替は実行時点。clear 済み履歴は復活し得る)」へ、README のコマンド表、docs/how-it-works.md の scan 節、src/contracts.md への契約追記

### やらないこと

- `sweep` / `--days` の意味論変更(reset+再生成のまま。additive な sweep は作らない)
- 旧計画 5〜13章の基盤(WAL / ingest transaction / 匿名 ingest state / HMAC stable key / `--rescan` / `--rebuild`)の導入
- `history clear` の削除意図を守る tombstone の新設(§6 で理由を述べてスコープ外にする)
- 過去時点の単価・為替の復元(バックフィルで追加される分は実行時点の単価表・為替で計算する。既存レコードは触らないので変わらない)
- Codex child rollout の料金集計(現行どおり取り込まない。src/ingest.ts:543-548)
- 通知・ダッシュボードのデザイン変更、スケジューラ等の常駐物

## 6. 旧計画7章(clear / redact tombstone 契約)の扱い

**結論: `redact` の意図は本計画の範囲内で自然に守られる(テストで固定する)。`clear` の tombstone は今回のスコープに含めない。**

### redact — 守られる(実装不要、テストで固定のみ)

`history redact` はレコードの `prompt` だけを空にし、**`countedCalls` / `ingestKey` を含む他のフィールドを保持する**(src/history.ts:172-176 は `{ ...rec, prompt: "" }` で書き戻す)。バックフィルは指紋に載っている呼び出しを集計から除外するため、redact 済みレコードに対応するターンは**そもそも再生成されない**。プロンプトが復活する経路が存在しない。旧計画が turn-level promptPolicy などの機構で守ろうとした性質が、指紋方式の副産物として成立している。これは仕様として明文化し、テストで固定する。

### clear — 今回は守らない(理由つき)

`history clear` はレコードを行ごと削除するため、**指紋も一緒に消える**。したがってバックフィル(および既存の `reset-cursors`+`scan`、引数なし `sweep`)は clear 済みターンを元 JSONL から再取り込みする。

スコープ外とする理由:

1. **現行製品の公開契約と整合する**。docs/sweep.md:47 と contracts.md(2026-07-15)は既に「clear 済み履歴も source にあれば sweep で復活する」と明記している。バックフィルが同じ性質を持つのは新しい裏切りではなく、既存契約の追記型版である
2. **通常運用では復活しない**。`history clear` はカーソルに触れない(src/history.ts)ので、hook / 通常 `scan` は clear 済み範囲を読み直さない。復活が起きるのは利用者が明示的に再走査を指示した(`sweep` / `scan --backfill` / `reset-cursors`)ときだけ
3. **守るには新しい永続状態が要る**。削除済み指紋の台帳(tombstone ファイル)を `history clear` が書き、ingest / sweep が参照する設計になる。「sweep(全 reset)は tombstone を消すのか尊重するのか」「`clear --days N` 部分削除との整合」「台帳の破損時の倒し方」という契約設計が必要で、本計画の「最小の変更」と両立しない

軽減策(本計画に含む): docs と `scan --backfill` の完了/dry-run 出力に「`history clear` で削除した履歴は、元 JSONL が残っていれば復活します」を明記する(sweep の既存文言と同じ流儀)。

なお、clear tombstone を将来やる場合の最小案は「`history clear` 時に削除レコードの `countedCalls` を tombstone ファイルへ退避し、ingest の除外集合へ合流する」形で、指紋がそのまま identity になるため旧計画の HMAC key 基盤は不要になっている——という見立てだけを残す(別計画)。

## 7. タスク分解(依存順)

1. **T1: runIngest のバックフィルモード**(src/ingest.ts)
   - `IngestOptions` に `ignoreCursors?: boolean`(名前は実装時に確定)を追加
   - true のとき: `cursorsDict` 参照を null 扱い / mtime プリフィルタをスキップ / `collectSubagentUsage` へ渡す `readCursor` も null を返す / commit のカーソル保存は現行どおり
   - legacyFloors・指紋除外・`ingestKey` 照合は現行コードのまま効かせる(変更しない)
   - バックフィルモードのとき `notifyIngestSummary` を呼ばない(呼び出し元 scan 側で分岐でも可)
2. **T2: `scan --backfill` フラグ**(src/scan.ts、src/cli.ts)— T1 に依存
   - `--dry-run` / `--json` と併用可。未知オプションは現行どおり終了コード1
   - 非 dry-run の完了サマリーと dry-run 出力に、追加件数・合計と「clear 済み履歴は復活し得る」「追加分は実行時点の単価・為替で計算」の注意書き
3. **T3: テスト**— T2 に依存(§8 参照)
4. **T4: docs / contracts**— T2 に依存
   - docs/sweep.md:25 の書き換え、docs/how-it-works.md の scan 節、README コマンド表
   - src/contracts.md へ「2026-08-13 追加: scan --backfill」節(意味論・通知抑止・redact/clear の扱い)
   - `reset-cursors`+`scan` が同等の効果を持つことには触れてよいが、案内する主経路は `scan --backfill` に統一

見積もり感: 変更は src/ingest.ts / src/scan.ts / src/cli.ts の3ファイル+テスト+docs。新規ファイル・新規永続状態・スキーマ変更なし。

## 8. 完了条件・受け入れ基準

すべて自動テストで固定する(`npm run typecheck` / `npm test`(vitest)が通ること)。

1. **バックフィル本体**: `sweep --days 0`(全ターン期間外→履歴0件・カーソル末尾)の後、`scan --backfill` で全ターンが履歴に入る。Claude(SA 含む)・Codex 両 fixture で件数・金額が引数なし `sweep` 相当と一致する
2. **追記型であること**: `sweep --days N` で直近分を取り込んだ後の `scan --backfill` は、既存レコードの行を変更しない(バックフィル前後で既存行がバイト同一)。追加されるのは期間外だったターンだけ
3. **冪等**: `scan --backfill` を2回連続で実行しても2回目は追加0件
4. **dry-run**: `scan --backfill --dry-run` は履歴・cursors.json・mtime キャッシュのいずれも変更せず、本実行と同じ追加候補件数を表示する
5. **redact 尊重**: 取り込み済みレコードを `history redact` した後の `scan --backfill` は、レコードを追加せずプロンプトも復活させない
6. **clear の現行契約の明示**: `history clear` 後の `scan --backfill` はレコードを再取り込みする(復活する)ことをテストで固定し、docs に注意書きがある
7. **通知**: バックフィルは取り込みがあっても通知を送らない。通常 `scan` の通知挙動は変わらない
8. **既存挙動の不変**: 既存の sweep / scan / track / history テストがすべて無修正で通る(`--backfill` を付けない限り一切の挙動が変わらない)

## 9. 未確定事項・リスクと判断の委ね方

### 未確定事項(実装前にユーザー判断を仰ぐもの)

1. **コマンドの形**: 推奨は `scan --backfill`(scan と同じ追記型・同じ走査対象であることが名前から分かる)。代案は独立サブコマンド `backfill`。`sweep --backfill` は「sweep=reset」の現行契約と混ざるため推奨しない
2. **`--days N` 付きバックフィル(段階的に広げる: 7日→30日→全期間)を v1 に含めるか**: 含めなくても本計画の価値(後から全部足せる)は成立する。含める場合はドラフトの ts 下限判定(sweep と同じ規則)+SA への `minTimestampMs` を ingest に足すだけで、「期間外を捨ててカーソルを進める」ことは指紋+バックフィル存在下では安全(次回の backfill が拾う)。**推奨: v1 では外し、必要になったら小さく足す**
3. **バックフィル完了後のダッシュボード**: 推奨は「再生成しない+案内メッセージ」(現行 scan と同じ)。sweep 同様の即時再生成を望むなら T2 に小タスクを足す

### リスクと倒し方

- **実行時間と data lock**: バックフィルは全 source を先頭から読む(引数なし `sweep` の走査と同等)。runIngest は書き込み区間を lock で囲むため、その間に発火した Stop hook は lock timeout(1秒)で当該ターンの即時記録・通知を見送る。ただし transcript は残るので後続の hook / scan が回収し、恒久的な取りこぼしにはならない(sweep の既存注意書きと同じ性質)。docs に明記する
- **指紋を持たない旧レコード(2026-08-11 の指紋導入前に記録された履歴)が残っている場合**: ingest は legacyFloors(セッション別 ts 下限)で「下限以前は計上済み」とみなすため、そのセッションでは下限より前の未取り込みターンをバックフィルで拾えない(取りこぼし側に倒れ、二重計上はしない)。完全に戻したい場合の手段は従来どおり引数なし `sweep`。docs の注意事項に載せる
- **部分計上済みターン**: hook がターンの一部の呼び出しだけ計上した状態でバックフィルすると、残りの呼び出しだけの別レコードができる(金額合計は正しい)。これは現行 ingest のカーソル欠損時と同一挙動であり、新規のリスクではない
- **追加分の金額は実行時点の単価・為替**: 過去時点の再現はしない(sweep と同じ契約)。dry-run と完了サマリーに明記する
- **「原理的に保証」への注意**: 二重計上ゼロ・冪等の根拠は、指紋方式の設計(内容から決まる指紋・追記専用 rollout のオフセット不変性)と、既存テスト+`reset-cursors` 出荷時の実データ検証に置く。本計画のテスト(§8)で backfill 経路についても同じ性質を観測可能な形で固定する
