# よくある質問 / FAQ

[← README に戻る](../README.md)

**通知が来ない**

```bash
npx ccc-notifier doctor
```

を実行し、❌ が出ている項目を確認してください。よくある原因:

- hook が未登録 → `npx ccc-notifier init` を再実行してください
- `config.json` の `notify.os` が `false` → 意図的に無効化されています
- 通知なしモード(`notify.os: false` かつ `notify.slack: null`)になっている → `doctor` が「通知なし・ダッシュボードのみモード」と明示します。通知を使いたければ `init` を再実行してチャネルを選び直してください(詳細は [設定 / 通知なしモード](configuration.md#通知なしモード記録ダッシュボードのみ--dashboard-only-mode))
- そのターンの金額が `minNotifyUSD` 未満 → 通知は来ませんが、履歴(`report`)には記録されています

**Codex の通知が来ない**

Codex CLI 側の**信頼承認**がまだの可能性があります。`ccc-notifier init --codex`(または対話で Yes)を実行しただけでは hook は動かず、次回 `codex` 起動時に表示される「Hooks need review」で「Trust all and continue」を選ぶまで**サイレントに何も起きません**。

1. `codex` を起動し、「Hooks need review」が出たら「Trust all and continue」(または Review して個別に承認)を選ぶ
2. `npx ccc-notifier doctor` を実行し、「Codex」のブロックを確認する(hook が未登録なら `init --codex` を再実行)
3. それでも来ない場合は [Codex CLI 対応](codex.md) のトラブルシュートを参照してください

**Node を更新・削除したら通知が来なくなった**

hook には `init` を実行した時点の Node.js の絶対パスがそのまま記録されています。mise などで Node.js のバージョンを切り替えたり、そのバージョン自体をアンインストールしたりすると、記録されていたパスが無効になり通知が届かなくなることがあります。

`doctor` はこの状態(hook に記録された Node 実行パスが実在しない)を検知し、⚠️「hook の Node 実行パスが見つかりません(mise 等での更新が原因の可能性)。init を再実行してください」と該当パス付きで知らせます(この警告は診断の終了コードには影響しません)。

対処: リポジトリのディレクトリで `init` を再実行してください。hook の登録が今使っている Node.js のパスで上書きされます。

```bash
node dist/cli.js init          # グローバルインストール済みなら ccc-notifier init
```

あわせて次を実行すると、他に問題が無いかも確認できます。

```bash
node dist/cli.js doctor        # グローバルインストール済みなら ccc-notifier doctor
```

**通知の送信元表示が「スクリプトエディタ」「Windows PowerShell」になっている**

これは正常な動作です。OS通知は追加ライブラリなしで OS 標準の仕組み(macOS: `osascript` / Windows: PowerShell 標準のトースト通知)を直接呼び出して表示しているため、通知の送信元(表示名義)はそれぞれ macOS では「スクリプトエディタ」、Windows では「Windows PowerShell」になります。通知がすぐ消えて見逃しがちな場合は、OS 側の通知設定でその名義の通知スタイルを変更してください(例: macOS はシステム設定 → 通知 →「スクリプトエディタ」→ 通知スタイルを「通知パネル」に変更すると、自動的に消えず手動で閉じるまで表示され続けます)。

**サブエージェント/バックグラウンドのコストはどう扱われる?**

- Claude Code のサブエージェント(バックグラウンドで動くエージェント)の usage も自動で集計し、そのターンの「サブエージェント」枠として記録します。履歴・`report`・ダッシュボードの**合計金額にはこのサブエージェント分が含まれます**(ダッシュボードのヒーロー下やモデル別内訳、`report` の `total.subagentsUSD` で内訳を確認できます)
- 一方で、**OS/Slack 通知の金額と発火しきい値(`minNotifyUSD`)はメイン(その場の応答)のコストだけ**で判定します。サブエージェント分が通知金額に混ざったり、通知の有無を左右したりすることはありません
- サブエージェントは応答完了のタイミングがメインとずれることがあるため、その分が**次のターン以降の日付に計上**されて見えることがあります(取りこぼしや二重計上はしません)
- 古いバージョンの Claude Code(サブエージェントの usage が別ディレクトリに保存されない形式)では、この枠は付かず従来どおりの集計になります

**金額が Claude Code の `/cost` と少し違う**

- `/cost` は「セッション累積」、ccc-notifier は「1ターンごと」の金額です。比較する際はターンを合計するか、`doctor` が表示する直近セッションの合計値と `/cost` の Total cost を見比べてください
- 単価表は LiteLLM から最大24時間おきに自動更新されるため、価格改定の直後は反映にタイムラグがあります
- 通知や `report` の表示金額は見やすさのため丸めています。内部的には丸めない金額を保持しており、`report --json` で確認できます

**ダッシュボードを開きっぱなしにしても自動で新しくならない / 自動更新を止めたい**

- 直近版 `report.html` は Claude Code / Codex の正常な新規ターンごと、全履歴版 `report-all.html` はローカル日の最初の正常な新規ターンに再生成されます。既定では約30秒ごとにファイルを再読込します。タブを**閉じずに開いたまま**にしておいてください。未生成側には案内placeholderが置かれるためヘッダーのリンクは常に有効で、リロードを跨いでも検索語・スクロール位置は保持されます
- 自動リロードだけを止めたい場合は `config.json` の `dashboard.autoReloadSec` を `0` に、応答完了ごとの再生成自体を止めたい場合は `dashboard.autoRegenerate` を `false` にしてください(その場合は必要なときに手動で `dashboard` コマンドを実行します)

**Windows で通知が届かない**

Claude Code は Windows 上では hook コマンドを Git Bash 経由で実行します。[Git for Windows](https://git-scm.com/download/win) などで Git Bash が使える状態にしてください(詳細は [Windows / WSL2 での導入](windows-wsl2.md))。

**アンインストールしたい**

```bash
npx ccc-notifier uninstall
```

Stop hook のエントリだけを `~/.claude/settings.json` から取り除きます(他の hook・設定はそのまま残ります)。蓄積した履歴・設定・キャッシュも含めて完全に削除したい場合は `--purge` を付けてください(`--yes` を省略すると削除前に確認が入ります)。

```bash
npx ccc-notifier uninstall --purge
```
