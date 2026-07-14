# 設定 / Configuration

[← README に戻る](../README.md)

`init` で答えた内容は `~/.ccc-notifier/config.json` に保存されます(Claude Code 自体の `~/.claude/settings.json` とは別のファイルです)。直接編集しても構いません。

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `notify.os` | boolean | `true` | OS通知(macOS通知センター / Windowsトースト通知など)を送るか |
| `notify.slack.webhookUrl` | string | - | Slack Incoming Webhook の URL。無効化する場合は `notify.slack` 自体を `null` にする |
| `notify.slack.promptChars` | number | `100` | Slack に送るプロンプト冒頭の文字数 |
| `notify.slack.sendFullPrompt` | boolean | `false` | `true` にするとプロンプト全文を Slack に送信(既定は冒頭のみ) |
| `minNotifyUSD` | number | `0` | この金額(USD)未満のターンは通知しない。**履歴には常に記録されます** |
| `costLabel` | `"api_equivalent"` \| `"actual"` | `"api_equivalent"` | 金額ラベルの意味づけ(詳細は [金額の意味](cost.md)) |
| `fx.fallbackRate` | number | `150` | 為替取得に失敗した際に使う固定 USD→JPY レート |
| `fx.cacheHours` | number | `12` | 為替レートのキャッシュ有効時間(時間単位) |
| `includeDailyTotal` | boolean | `true` | 通知本文に「今日の累計コスト」を含めるか |
| `monthlyBudgetUSD` | number | `0` | 月予算(USD)。`0` で無効。ダッシュボードに当月の使用率カードを表示(`budget` コマンド / `init` の `--budget` で設定。詳細は [月予算](monthly-budget.md)) |
| `dashboard.autoRegenerate` | boolean | `true` | 応答完了(`track`)ごとの直近版と、日次の全履歴版を自動生成するか |
| `dashboard.autoReloadSec` | number | `30` | 生成 HTML の自動リロード間隔(秒)。`0` で自動リロードを無効化 |
| `dashboard.days` | number | `30` | 自動生成と引数なしの手動 `dashboard` で作る `report.html` の対象期間(正の整数・日数)。不正値は安全に `30` へフォールバック。`report-all.html` には影響しない |

補足: データ保存先(既定 `~/.ccc-notifier`)は環境変数 `CCCN_HOME` で上書きできます。

## 通知の一時停止と再開 / Pausing & Resuming Notifications

「集中したいから今だけ通知を止めたい」というときは `mute` / `unmute` を使います。止まるのは **OS/Slack 通知だけ**で、コストの記録・ダッシュボードの自動更新はそのまま続きます(あとから履歴で確認できます)。

```bash
npx ccc-notifier mute       # 無期限で停止(unmute するまで)
npx ccc-notifier mute 2h    # 2時間だけ停止(期限が来ると自動で再開)
npx ccc-notifier mute 30m   # 30分だけ停止(m=分 / h=時間 / d=日)
npx ccc-notifier unmute     # すぐに再開
```

- 停止状態は `~/.ccc-notifier/muted.json` に保存されます。`config.json` は変更しません
- 停止中かどうかは `doctor` でも確認できます(停止中は ⚠️ で表示)
- 恒久的に OS 通知を切りたい場合は `config.json` の `notify.os: false`、金額の小さいターンだけ通知を抑えたい場合は `minNotifyUSD` が向いています(前項「設定」参照)。通知を恒久的にすべて切って記録・ダッシュボードだけ使いたい場合は次項の「通知なしモード」を使います

## 通知なしモード(記録・ダッシュボードのみ)/ Dashboard-only Mode

通知を一切送らず、コストの記録と[ダッシュボード](dashboard.md)だけを使うモードです。次のいずれかで設定できます。

- `init` の対話で「**通知なし(記録・ダッシュボードのみ)**」を選ぶ
- 非対話なら `init --yes --no-notify`
- `config.json` を直接編集して `"notify": { "os": false, "slack": null }` にする(専用のキーはなく、この値そのものがこのモードの表現です)

このモードでも Stop hook は登録され、コストの記録、毎ターンの `report.html`、日次の `report-all.html` の自動生成は行われます(通知の送信だけがスキップされます)。設定状態は `doctor` が「通知なし・ダッシュボードのみモード」として表示します。

- **mute との違い**: `mute` は一時停止(`muted.json`、`unmute` で再開)、通知なしモードは `config.json` に保存される恒久的な設定です
- **注意**: `init` を再実行してチャネルを選び直す(または素の `init --yes`)と通知は再有効化されます。対話の初期選択には現在の設定が反映されるため、通知なしのまま再 init する場合はそのまま Enter で維持できます。ただし、既存 `config.json` がある環境での素の `init --yes --codex` はCodex hook限定移行のため例外で、通知設定・予算・単価表示・為替・Claude settingsを変更せず、テスト通知も送りません。設定フラグを追加した場合は通常initに戻ります
