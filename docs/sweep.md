# 過去分の取り込み / Backfilling (sweep)

[← README に戻る](../README.md)

`sweep` コマンドは、`~/.claude/projects` 配下の全 transcript(メイン + サブエージェント)を走査して、**まだ履歴に取り込まれていない過去分**を後からまとめて回収します。hook の発火タイミングに依存せず、セッションを**ターン単位に復元**して取り込みます。次のようなケースで役立ちます。

- **hook を導入する前のセッション** — `init` 前のやり取りは記録されていませんが、Claude Code 側の transcript は残っているので後から取り込めます
- **後から完了したサブエージェント** — サブエージェントは応答完了のタイミングがメインとずれることがあり、その場の hook では拾い切れなかった分もここで回収されます

`sweep` は**ローカルの transcript を読むだけで Claude の API は一切呼びません**(トークンを消費しないので**料金はゼロ**です。単価表・為替の取得だけは通常どおり行いますが、これは金額に無関係な無料のメタデータ取得です)。**二重計上もしません**(hook と同じカーソル + `message.id`+`requestId` の去重で、すでに計上済みの分は自動的にスキップされます)。

まず `--dry-run` で「何がいくら取り込まれるか」を確認してから本実行するのがおすすめです。

```bash
npx ccc-notifier sweep --dry-run   # 集計結果を表示するだけ(書き込みは一切なし)
npx ccc-notifier sweep             # 実際に履歴へ取り込む
npx ccc-notifier sweep --days 30   # 直近30日より古いターンは取り込まない(既定は無制限)
```

取り込んだレコードには目印として `ingest: "sweep"` が付きます。取り込み後は `report` / `dashboard` にそのまま反映されます。

各transcript / rolloutの履歴・カーソル更新はdata lockで独立にcommitします。一部の対象でlockを取得できなかった場合、正常な対象は保持したまま、未処理対象のカーソルは進めず「未完了」と表示して終了コード1を返します。「新規なし」とは扱わないため、同じ `sweep` を再実行すれば未処理分を回収できます。`--dry-run` は書き込みもdata lock取得も行いません。

**進行中セッションの自動スキップ**: 直近5分以内に更新された transcript は「今まさに動いているセッション」の可能性があるため、`sweep` は自動でスキップします(スキップした件数はサマリに表示されます)。これは、応答完了の瞬間に sweep が重なると hook より先にそのターンを取り込んでしまい、**そのターンの通知だけが出なくなる**競合を防ぐためです。スキップされた分は、セッション完了後に `sweep` を再実行するか、通常どおり hook が拾うので取りこぼしにはなりません。全セッションが完了していると分かっている場合は `--include-active` でスキップせずに取り込めます。

> **単価・円換算について**: 過去分も、USDは`sweep`実行時に取得した単価表、JPYは実行時の為替レートで計算する概算です。過去時点の単価・為替は保存・再現しないため、後から取り込んだ表示額が当時の条件と一致する保証はありません。

## 履歴を捨てて全再生成 / Rebuild

期間を限定したsweepなどで進んだ取り込み位置をリセットし、手元に残っているClaude Code / Codexの元JSONLからコスト履歴を最初から作り直すには、次の1コマンドを使います。Claude CodeとCodexは起動したままでよく、終了・再起動は不要です。

```bash
npx ccc-notifier sweep --rebuild       # 内容を確認してから実行
npx ccc-notifier sweep --rebuild --yes # 確認を省略
```

この操作はコスト履歴と取り込み位置を削除してから全件を再生成し、古い自動生成dashboardも削除します。**backupは作成しません**。

- コスト履歴 `history.jsonl`
- 取り込み位置 `cursors.json`
- 自動生成したcanonical dashboard (`report.html` / `report-all.html`)と日次更新state

一方、`config.json`、月間予算、Slack / OS通知設定、mute設定、単価表・為替cache、Codex hook設定、**Codexサブエージェント利用記録**はresetしません。単価表・為替cacheは削除しませんが、通常のオンライン取得により実行時に更新されることはあります。

rebuild自身は新しいdashboard HTMLを生成しません。`dashboard.autoRegenerate=true`なら完了後の次の正常なターンで自動生成されます。無効にしている場合やすぐ見たい場合は、`dashboard`または`dashboard --all`を手動実行してください。元JSONLをローカル走査するためClaude/Codex APIの利用料は増えませんが、価格表・為替レート取得の通信は通常どおり行われる場合があります。

### 実行前に知っておくこと

- 全レコードを**実行時点の単価表と為替レート**で計算し直すため、過去のUSD/JPY表示額は以前と変わる場合があります。
- `history clear`で消した履歴と、`history redact`で消したpromptも、元JSONLが残っていれば復活します。
- 削除・移動された元JSONLや、JSONL内の破損行は復元できません。
- 進行中のsourceもbest-effortで読みます。同時にtruncate/rewriteされた部分の完全な取り込みは保証せず、読み取り後に増えた末尾は後続hookまたは通常`sweep`が回収します。
- rebuildがdata lockを保持している間に完了したターンは、hookが記録できず通知が欠ける場合があります。通知の再送はありません。完了後は自動的に通常動作へ戻り、再起動や停止markerの解除は不要です。
- 途中で失敗してもrollbackしないため、履歴・取り込み位置が部分生成の状態で残る場合があります。同じ`ccc-notifier sweep --rebuild`を再実行すると、もう一度捨てて最初から作り直します。
- Codexサブエージェント利用記録のファイルは残ります。ただし再生成行は過去の表示用join keyを再構成しないため、過去turnに「利用あり」を表示する紐付けは失われる場合があります。料金履歴とは別の**Codexサブエージェント利用記録**です。

`--rebuild`は常に標準のClaude / Codex sourceを全走査します。そのため、履歴を一度捨てた後に対象外データが生じる次の組み合わせは拒否します。

```text
--rebuild --dry-run
--rebuild --days N
--rebuild --include-active
--rebuild --projects DIR
```

未知option、値のないoption、余分な位置引数も、履歴を変更する前に終了コード1で拒否します。
