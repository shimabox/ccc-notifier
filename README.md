# ccc-notifier

Claude CodeとCodex CLIの利用コストをターンごとに通知し、履歴とダッシュボードで見えるようにするツールです。

> [!IMPORTANT]
> **表示される金額は概算です。** 実際の請求額と一致する保証はありません。「使いすぎに気づく」ための目安として使ってください。詳しくは[金額の意味](docs/cost.md)を参照してください。

```text
💰 API換算 $0.267(¥40) | Fable 5
in 1.2k(cache 40%) / out 480 · 📁 my-app · 今日: $1.85
バグを直してテストを通してください
```

![通知の実例](docs/images/notification.png)

![ダッシュボード](docs/images/dashboard.png)

## 主な機能

- Claude Codeの応答完了ごとに、USD・JPYの概算をOS通知またはSlackへ送ります
- プロンプトと概算をローカルへ保存し、あとから検索・集計できます
- 日・週・月の推移やモデル別・プロジェクト別の内訳をHTMLダッシュボードで確認できます
- 月予算を設定し、今月の使用率を確認できます
- 通知を一時停止しても、履歴の記録は続けられます
- Codex CLIも任意で追加し、Claude Codeと同じダッシュボードで確認できます

## 必要なもの

- Node.js 20以上（未導入の場合は[Node.jsの用意](docs/installing-node.md)）
- Claude Code（必須）
- Codex CLI（任意）

Windows / WSL2は[専用の導入手順](docs/windows-wsl2.md)も参照してください。

## まず試す

グローバルインストールは不要です。最新版を一度試します。

```bash
npx ccc-notifier@latest init
```

画面の質問に沿って、通知方法・金額ラベル・月予算・Codex連携を選びます。

`init`がClaude Codeの`~/.claude/settings.json`を書き換える場合は、**書き換える前にタイムスタンプ付きのバックアップ**を作ります。既存の設定を解析できない場合は自動編集せず、手動設定方法を表示します。

セットアップ後にClaude Codeで何か実行してください。通知が届かない場合は次で診断できます。

```bash
npx ccc-notifier@latest doctor
```

Codex連携を選んだ場合は、Codexを再起動し、表示されるhookの確認画面で承認してください。詳しくは[Codex CLI対応](docs/codex.md)を参照してください。

## 気に入ったらグローバルインストール

```bash
npm install -g ccc-notifier
ccc-notifier init
```

以降は`ccc-notifier doctor`のように短く実行できます。`cccn`も同じコマンドとして使えます。

## よく使うコマンド

以下はグローバルインストール後の表記です。npxで使う場合は`ccc-notifier`を`npx ccc-notifier@latest`に置き換えてください。

| コマンド | できること |
|---|---|
| `ccc-notifier init` | 通知や連携を設定する |
| `ccc-notifier doctor` | 設定と通知を診断する |
| `ccc-notifier report [--days N]` | コスト集計をターミナルに表示する |
| `ccc-notifier dashboard` | 直近のHTMLダッシュボードを開く |
| `ccc-notifier dashboard --all` | 保存済みの全履歴版を開く |
| `ccc-notifier budget [<USD>]` | 月予算を確認・設定する（`0`で解除） |
| `ccc-notifier mute [30m\|2h\|1d]` | 通知を一時停止する（期間省略で無期限） |
| `ccc-notifier unmute` | 通知を再開する |
| `ccc-notifier sweep --dry-run [--days N]` | 履歴を作り直した場合の件数と概算を確認する |
| `ccc-notifier sweep [--days N]` | 残っている利用データから履歴を作り直す |

> [!CAUTION]
> **`sweep`は履歴を作り直すコマンドです。** 保存済みの履歴をいったん消し、Claude Code / Codex CLIに残っているデータから再作成します。設定や通知は消えませんが、履歴のバックアップは作りません。以前に削除・伏せ字にした履歴も、Claude Code / Codex CLI側の元データに残っていれば再び入ります。また、再作成した時点の単価と為替を使うため、以前の金額から変わることがあります。先に`--dry-run`で確認してください。詳しくは[履歴の再生成](docs/sweep.md)を参照してください。

ダッシュボード、履歴の削除、通知なしモードなど、その他の操作は[ドキュメント](#ドキュメント)または`ccc-notifier --help`で確認できます。

## アップデート

npxで使う場合は、各コマンドに`@latest`を付ければ常に最新版が使われるため、別の更新作業は不要です。

グローバルインストールの場合は、次のコマンドだけで更新できます。

```bash
npm update -g ccc-notifier
```

hook設定の更新が必要なリリースだけ、リリース案内に従って`init`を実行してください。Codexの更新手順は[Codex CLI対応](docs/codex.md)にまとめています。

## 完全に削除する

グローバルインストールした場合は、ccc-notifierのhookと保存データを削除してからパッケージを削除します。

```bash
ccc-notifier uninstall --yes --purge
npm uninstall -g ccc-notifier
```

npxだけで使っていた場合は、最初のコマンドを`npx ccc-notifier@latest uninstall --yes --purge`に置き換え、`npm uninstall -g`は不要です。安全のため作成した`settings.json.bak-*`などのバックアップは自動削除しません。

## プライバシー

- 履歴とプロンプトは`~/.ccc-notifier`にローカル保存します
- Slackを設定した場合だけ、概算・トークン情報とプロンプトを指定したSlack Webhookへ送ります。既定はプロンプト冒頭100字で、設定により文字数の変更や全文送信もできます
- 単価表と為替レートの取得時に外部通信しますが、プロンプトやコードは送りません

詳しくは[Slack通知](docs/slack.md)と[仕組み](docs/how-it-works.md)を参照してください。

## ドキュメント

- [Node.jsの用意](docs/installing-node.md)
- [Windows / WSL2での導入](docs/windows-wsl2.md)
- [Codex CLI対応](docs/codex.md)
- [Slack通知](docs/slack.md)
- [設定・通知の一時停止](docs/configuration.md)
- [金額の意味](docs/cost.md)
- [ダッシュボードと履歴の削除](docs/dashboard.md)
- [月予算](docs/monthly-budget.md)
- [履歴の再生成（sweep）](docs/sweep.md)
- [仕組み](docs/how-it-works.md)
- [よくある質問](docs/faq.md)

## License

[MIT](LICENSE)
