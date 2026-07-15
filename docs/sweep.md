# 履歴の再生成 / Rebuilding history (sweep)

[← README に戻る](../README.md)

`sweep`は既存のコスト履歴と取り込み位置を捨て、手元に残っているClaude Code / Codexの元JSONLを先頭から走査して概算を作り直すコマンドです。hook導入前のセッションや、後から完了したClaudeサブエージェントも含めて再生成できます。

```bash
npx ccc-notifier sweep                  # 全期間を再生成
npx ccc-notifier sweep --days 7         # reset後、直近7日だけを再生成
npx ccc-notifier sweep --dry-run        # 全期間の再生成結果をpreview
npx ccc-notifier sweep --dry-run --days 7
```

通常実行に確認promptはありません。`sweep`自体がresetと再生成を意味します。`--projects DIR`は限定したClaude sourceを走査する用途で使用できます。未知option、値不足、余分な位置引数は何も変更する前に終了コード1で拒否します。旧`--rebuild`、`--yes` / `-y`、`--include-active`は使用できません。

## 通常実行で起きること

sweep全体でdata lockを一度だけ取得し、次を削除・無効化してからClaude main / agentとCodex rolloutをsource先頭から走査します。**backupは作成しません**。

- コスト履歴 `history.jsonl`
- 取り込み位置 `cursors.json`
- 自動生成したcanonical dashboard (`report.html` / `report-all.html`)
- dashboardの日次更新state

`--days N`を指定した場合も最初にresetし、期間内のturnだけを履歴へ保存します。各sourceのcursorは読み取った末尾へ進みます。後から古い履歴も戻したい場合は、引数なしの`sweep`で全期間を再生成してください。

次はresetしません。

- `config.json`、月間予算、Slack / OS通知設定
- mute設定、Codex hook設定
- 単価表・為替cache
- **Codexサブエージェント利用記録**

単価表・為替cache自体は削除しませんが、通常のオンライン取得で更新される場合があります。元JSONLの走査はClaude/Codex APIを呼ばないためトークン料金は発生しませんが、単価表・為替レート取得の通信は行われる場合があります。

sweepが正常完了し、`dashboard.autoRegenerate=true`なら、再生成した履歴から直近版`report.html`と全履歴版`report-all.html`をその場で生成します。両HTMLの相互リンクもすぐ利用できます。`dashboard.autoRegenerate=false`ならHTMLは生成せず、必要なときに`dashboard` / `dashboard --all`を手動実行します。

## dry-run

`--dry-run [--days N]`は既存cursorを使わず、source先頭から「実行した場合に再生成される件数と概算額」を計算します。data lock取得、reset、履歴/cursor保存、dashboard無効化、HTML生成、設定変更は行わないread-only previewです。

## 注意事項

- 再生成対象の全レコードを**sweep実行時点の単価表と為替レート**で再計算します。過去時点の単価・為替は保存・再現しないため、以前の表示額や当時の条件と一致する保証はありません。
- `history clear`で削除した履歴と、`history redact`で消したpromptは、元JSONLが残っていれば次のsweepで復活します。
- 削除・移動された元JSONLや、JSONL内の破損行は復元できません。
- Claude Code / Codexの終了・再起動は不要です。進行中sourceも常にbest-effortで読みますが、同時truncate/rewriteされた内容の完全な取り込みは保証しません。読み取り後に増えた末尾は後続hookが回収します。
- sweepがdata lockを保持している間にhookが発火すると、そのturnの通知が欠ける場合があります。通知は再送しません。完了後はmarker解除などをせず自動的に通常動作へ戻ります。
- 途中で失敗してもrollbackしないため、履歴・cursorが部分生成の状態で残る場合があります。このpartial failureではdashboard HTMLを生成しません。同じ`sweep`を再実行すると、再びresetして最初から作り直します。
- Codexサブエージェント利用記録のファイルは残りますが、再生成した過去turnとの表示上の紐付けは失われる場合があります。料金履歴とは別の**Codexサブエージェント利用記録**です。

取り込んだ履歴には`ingest: "sweep"`が付きます。再生成後は`report`に反映され、正常完了かつ自動生成が有効ならdashboardにも即時反映されます。自動生成が無効なら手動で生成してください。
