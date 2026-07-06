# agent-cost-notifier

Claude Code で **プロンプトを実行するたび**、そのターンにかかったコストを **$(USD)と¥(JPY)の両方** で自動通知するツールです。**5分で導入できます。**

```
💰 API換算 $0.267(¥40)| Fable 5
in 1.2k(cache 40%)/ out 480 · 📁 my-app · 今日: $1.85
バグを直してテストを通してください
```

上が通知の例です(1行目がタイトル、2〜3行目が本文)。応答が完了するたびに OS 通知(任意で Slack 通知も)としてこれが届きます。

<!-- TODO: screenshot -->

## 特徴 / Features

- **ターン毎に自動通知** — Claude Code の応答が完了するたび(Stop hook)に、そのターンのコストを自動でプッシュ通知します。自分から `/cost` を見に行く必要はありません
- **$ と ¥ を併記** — USD と JPY の両方を毎回表示します(為替レートは自動取得 + キャッシュ + 固定フォールバックの三段構え)
- **プロンプト全文をローカルに履歴保存** — `~/.agent-cost-notifier/history.jsonl` にそのターンのプロンプト全文を保存します(外部には送信されません)
- **HTMLダッシュボード** — `dashboard` コマンドで、サマリー・日別コストの積み上げ棒グラフ・モデル別/プロジェクト別内訳・検索できるターン履歴を1枚の HTML(完全自己完結・ライト/ダーク対応)に書き出してブラウザで開きます
- **Mac・Windows 両対応** — [node-notifier](https://github.com/mikaelbr/node-notifier) 経由の OS ネイティブ通知に対応しています
- **全処理ローカル・フェイルセーフ設計** — 通知や集計の処理が失敗しても、Claude Code 本体の応答は絶対にブロックしません

## 必要環境 / Requirements

- Node.js 20 以上
- Claude Code(インストール・利用中であること)

## セットアップ / Setup

1. **セットアップコマンドを実行**

   ```bash
   npx agent-cost-notifier@latest init
   ```

2. **質問に答える**

   対話形式で次の3点を聞かれます。

   - 通知チャネル(OS通知のみ / OS通知+Slack)
   - コスト表示ラベル(API換算 / 実額)
   - USD/JPY のフォールバック為替レート(既定 150円)

   完了すると Claude Code の `~/.claude/settings.json` に Stop hook が自動で追記されます。**既存の設定内容(他の hook や設定)は一切変更されず**、書き込み前に必ず `settings.json.bak-<タイムスタンプ>` としてバックアップが作成されます。settings.json が壊れている(JSONとして解析できない)場合は自動編集を諦め、手動で追記する内容を画面に表示するだけで、ファイルには一切書き込みません。

3. **Claude Code で何か実行してみる**

   ひとこと実行して応答が完了すると、通知が届きます。

届かない場合は次のコマンドで診断できます。

```bash
npx agent-cost-notifier doctor
```

hook登録・設定ファイル・単価表・為替レート・テスト通知・直近セッション合計などを ✅ / ⚠️ / ❌ で表示し、❌ が1つでもあれば終了コード1を返します。

### 非対話実行(CI・スクリプト向け)/ Non-interactive flags

毎回 `npx` するのが面倒な場合は `npm install -g agent-cost-notifier` でグローバルインストールもできます(コマンドは `agent-cost-notifier` または短縮形の `acn` になります)。CI などから非対話で `init` したい場合は次のフラグが使えます。

| フラグ | 説明 |
|---|---|
| `--yes`, `-y` | 対話プロンプトを出さずに実行(非対話には必須) |
| `--os-only` | Slack を無効化し OS通知のみにする |
| `--slack-webhook <url>` | Slack Incoming Webhook URL を指定して有効化 |
| `--label <api_equivalent\|actual>` | コスト表示ラベルを指定 |
| `--rate <number>` | USD/JPY フォールバックレートを指定 |

## コマンド一覧 / Commands

| コマンド | 説明 |
|---|---|
| `init` | Stop hook を対話形式でセットアップ(前述のフラグで非対話実行も可) |
| `doctor` | hook登録・設定・単価表・為替・通知・直近セッション合計を診断 |
| `report [--days N] [--json]` | 蓄積した履歴を集計してターミナルに表示(`--days` の既定は30、不正な値も30扱い)。`--json` で機械可読な出力 |
| `dashboard [--days N] [--no-open] [--out <path>] [--refresh <sec>\|--no-refresh]` | 履歴を可視化した HTML ダッシュボードを生成してブラウザで開く(`--days` の既定は30、不正な値も30扱い。`--no-open` で生成のみ、`--out` で出力先を上書き。`--refresh <sec>` で自動リロード間隔を上書き、`--no-refresh` で自動リロードを無効化) |
| `uninstall [--purge] [--yes]` | Stop hook を削除。`--purge` を付けると `~/.agent-cost-notifier` のデータ(設定・履歴・キャッシュ)も削除 |
| `track` | Stop hook から自動的に呼ばれる**内部コマンド**。stdin 経由で JSON を受け取ります。手動実行は不要です |
| `--version`, `-v` | バージョン表示 |
| `--help`, `-h` | ヘルプ表示 |

`report --json` は次のような形の JSON を出力します(スクリプト等への取り込み用)。

```json
{
  "days": 30,
  "daily": [{ "date": "2026-07-06", "turns": 3, "inputTokens": 12345, "outputTokens": 678, "costUSD": 0.42, "costJPY": 63 }],
  "byModel": { "claude-fable-5": { "turns": 2, "costUSD": 0.3, "costJPY": 45 } },
  "total": { "turns": 3, "inputTokens": 12345, "outputTokens": 678, "costUSD": 0.42, "costJPY": 63 }
}
```

## ダッシュボード / Dashboard

`dashboard` コマンドは、蓄積した履歴を1枚の HTML(既定 `~/.agent-cost-notifier/report.html`)に書き出してブラウザで開きます。サマリーカード(今日 / 今週(直近7日)/ 今月(暦月)/ 期間合計)、日別コストのモデル別積み上げ棒グラフ、モデル別・プロジェクト別の内訳、検索・行展開できるターン履歴を表示します。生成物は CSS/JS/SVG をすべてインライン化した**完全自己完結・オフライン動作・外部通信ゼロ**のファイルで、OS のライト/ダーク設定に追従します。プロンプト全文はブラウザで実行されない形(JSON 埋め込み + textContent 描画)で安全に展開されます。

```bash
npx agent-cost-notifier dashboard            # 既定30日・生成してブラウザで開く
npx agent-cost-notifier dashboard --days 7   # 対象期間を直近7日に
npx agent-cost-notifier dashboard --no-open --out ./cost.html  # 開かずに任意パスへ出力
npx agent-cost-notifier dashboard --refresh 10   # 自動リロード間隔を10秒に上書き
npx agent-cost-notifier dashboard --no-refresh   # 自動リロードを無効化して生成
```

`--days` はダッシュボード全体(チャート・内訳・履歴テーブル・サマリーカード)が対象とする期間です(既定30、不正値は30)。すべての集計はこの期間内に記録されたターンから計算されます。

### 開くたびに最新に近いダッシュボード / Near-live dashboard

Claude Code の応答が完了するたび(Stop hook の `track` 実行時)に、この `report.html` を**自動で再生成**します。さらに生成される HTML には**自動リロード**(既定30秒ごと)が仕込まれているため、`report.html` をブラウザのタブで開きっぱなしにしておくと、Claude Code を使っている間そのタブが**約30秒ごとに最新の内容へ更新**されていきます(最新化のタイミングは Claude Code の応答完了時)。自動リロードを跨いでも、**検索ボックスの入力内容とスクロール位置は保持**されるので、見ていた場所を見失いません。

- **自動再生成を止める**: `config.json` で `dashboard.autoRegenerate` を `false` にします(以後は手動で `dashboard` コマンドを実行したときだけ生成されます)。
- **自動リロードを止める**: `config.json` で `dashboard.autoReloadSec` を `0` にします(生成物から meta refresh が消えます)。一時的に切りたいときは `dashboard --no-refresh`、間隔だけ変えたいときは `dashboard --refresh <秒>` を使います。
- **自動再生成の対象期間**は `dashboard.days`(既定30日)です。

自動リロードは meta refresh による軽量なもので、**外部通信は一切発生しません**(生成物は従来どおり完全自己完結・オフライン動作です)。

## 金額の意味 / What the Cost Means

`costLabel` は **表示ラベルを変えるだけ** で、計算方法そのものは変わりません。常にトークン数 × 単価で計算した同じ金額を使います。

- **`api_equivalent`(既定)**: Claude Pro / Max などの**定額プラン**を使っている場合、これは実際の請求額ではなく「もし従量課金の API で同じやり取りをしたらいくらか」の**参考換算値**です。通知の先頭に「API換算」と表示されます
- **`actual`**: **API キー**で従量課金利用している場合、この金額はほぼ実費に一致します。この場合は「API換算」ラベルを外して表示できます(`--label actual` または `config.json` で切替)

単価は Anthropic 公式レートを内蔵した単価表をベースに、[LiteLLM](https://github.com/BerriAI/litellm) が公開している価格データで自動更新されます(キャッシュ24時間、取得できない場合は内蔵値・キャッシュへフォールバック)。プロンプトキャッシュも「5分保持」か「1時間保持」かで単価が異なる点まで区別して計算しています。

## 設定 / Configuration

`init` で答えた内容は `~/.agent-cost-notifier/config.json` に保存されます(Claude Code 自体の `~/.claude/settings.json` とは別のファイルです)。直接編集しても構いません。

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `notify.os` | boolean | `true` | OS通知(macOS通知センター / Windowsトースト通知など)を送るか |
| `notify.slack.webhookUrl` | string | - | Slack Incoming Webhook の URL。無効化する場合は `notify.slack` 自体を `null` にする |
| `notify.slack.promptChars` | number | `100` | Slack に送るプロンプト冒頭の文字数 |
| `notify.slack.sendFullPrompt` | boolean | `false` | `true` にするとプロンプト全文を Slack に送信(既定は冒頭のみ) |
| `minNotifyUSD` | number | `0` | この金額(USD)未満のターンは通知しない。**履歴には常に記録されます** |
| `costLabel` | `"api_equivalent"` \| `"actual"` | `"api_equivalent"` | 金額ラベルの意味づけ(詳細は前項「金額の意味」) |
| `fx.fallbackRate` | number | `150` | 為替取得に失敗した際に使う固定 USD→JPY レート |
| `fx.cacheHours` | number | `12` | 為替レートのキャッシュ有効時間(時間単位) |
| `includeDailyTotal` | boolean | `true` | 通知本文に「今日の累計コスト」を含めるか |
| `dashboard.autoRegenerate` | boolean | `true` | 応答完了(`track`)のたびに `report.html` を自動再生成するか |
| `dashboard.autoReloadSec` | number | `30` | 生成 HTML の自動リロード間隔(秒)。`0` で自動リロードを無効化 |
| `dashboard.days` | number | `30` | 自動再生成時に集計する対象期間(日数) |

補足: データ保存先(既定 `~/.agent-cost-notifier`)は環境変数 `ACN_HOME` で上書きできます。

## Slack 通知の有効化 / Enabling Slack Notifications

1. Slack で Incoming Webhook を発行します(Slack App の管理画面で *Incoming Webhooks* を有効化 → *Add New Webhook to Workspace* → 通知したいチャンネルを選択すると `https://hooks.slack.com/services/...` 形式の URL が発行されます)
2. 次のいずれかの方法で設定します。
   - `npx agent-cost-notifier init` を実行し、「通知チャネル」で *OS通知 + Slack* を選んで URL を貼り付ける
   - 非対話: `npx agent-cost-notifier init --yes --slack-webhook "https://hooks.slack.com/services/XXX"`
   - `~/.agent-cost-notifier/config.json` を直接編集し、`notify.slack` に `{ "webhookUrl": "...", "promptChars": 100, "sendFullPrompt": false }` を設定
3. Slack にはタイトル・トークン/コスト概要・プロンプト冒頭(既定100字、`sendFullPrompt: true` で全文)の3ブロックが送信されます。送信は3秒でタイムアウトし、失敗しても(Webhook設定ミスなどがあっても)Claude Code の応答自体には一切影響しません

## プライバシー / Privacy

- プロンプトの全文は **ローカルの `~/.agent-cost-notifier/history.jsonl` にのみ** 保存されます
- OS通知に表示されるプロンプトは、ローカル上で先頭50字程度に切り詰めたものです
- Slack を設定した場合のみ、既定でプロンプト冒頭100字(`sendFullPrompt` で文字数変更・全文送信も可能)がその Slack Webhook 宛に送信されます
- それ以外に外部へ送信されるのは次の2種類の API 呼び出しだけです。いずれもプロンプトやコードの内容を一切含まない、レート・価格を取得するだけのリクエストです
  - 為替レート取得([frankfurter.dev](https://frankfurter.dev/) → 失敗時は [open.er-api.com](https://open.er-api.com/))
  - 単価表取得([LiteLLM の公開JSON](https://github.com/BerriAI/litellm))

## 仕組み / How it Works

1. Claude Code の **Stop hook**(1ターンの応答完了)から `track` コマンドが呼ばれる
2. transcript(`*.jsonl`)を集計し、トークン数 × 単価表 = USD、さらに為替レートで JPY を算出する
3. 結果を `history.jsonl` に追記し、しきい値以上なら OS通知 / Slack通知(両方ベストエフォート・並行実行)を送る

```
Claude Code が1ターンの応答を完了
        │  Stop hook 発火 (stdin で session_id / transcript_path / cwd を渡す)
        ▼
 node dist/cli.js track
        │
        ├─ transcript の「前回読んだ位置」より後ろだけを読む
        │  (message.id + requestId で重複排除。壊れた行やカーソルがあっても続行)
        ▼
 単価表(内蔵 + LiteLLM自動更新) × トークン数 = USD
        ▼
 USD × 為替レート(キャッシュ / 実取得 / 固定フォールバック) = JPY
        │
        ├─→ ~/.agent-cost-notifier/history.jsonl に1行追記
        └─→ 金額がしきい値(minNotifyUSD)以上なら OS通知 / Slack通知
```

設計上、**Claude Code 本体の動作を絶対にブロックしません**。`track` 全体が1つの try/catch で囲われており、何が起きても標準出力には何も出さず常に終了コード0を返します(失敗の詳細は `~/.agent-cost-notifier/error.log` にのみ記録)。ネットワークアクセス(為替取得・単価表取得・Slack送信・OS通知)にはすべて個別にタイムアウトが設定されており、無限に待ち続けることはありません。

## よくある質問 / FAQ

**通知が来ない**

```bash
npx agent-cost-notifier doctor
```

を実行し、❌ が出ている項目を確認してください。よくある原因:

- hook が未登録 → `npx agent-cost-notifier init` を再実行してください
- `config.json` の `notify.os` が `false` → 意図的に無効化されています
- そのターンの金額が `minNotifyUSD` 未満 → 通知は来ませんが、履歴(`report`)には記録されています

**金額が Claude Code の `/cost` と少し違う**

- `/cost` は「セッション累積」、agent-cost-notifier は「1ターンごと」の金額です。比較する際はターンを合計するか、`doctor` が表示する直近セッションの合計値と `/cost` の Total cost を見比べてください
- 単価表は LiteLLM から最大24時間おきに自動更新されるため、価格改定の直後は反映にタイムラグがあります
- 通知や `report` の表示金額は見やすさのため丸めています。内部的には丸めない金額を保持しており、`report --json` で確認できます

**ダッシュボードを開きっぱなしにしても自動で新しくならない / 自動更新を止めたい**

- `report.html` は Claude Code の応答完了(Stop hook)ごとに再生成され、既定では約30秒ごとに自動リロードされます。タブを**閉じずに開いたまま**にしておいてください(再生成した瞬間ではなく、次の自動リロードのタイミングで最新化されます)。リロードを跨いでも検索語・スクロール位置は保持されます
- 自動リロードだけを止めたい場合は `config.json` の `dashboard.autoReloadSec` を `0` に、応答完了ごとの再生成自体を止めたい場合は `dashboard.autoRegenerate` を `false` にしてください(その場合は必要なときに手動で `dashboard` コマンドを実行します)

**Windows で通知が届かない**

Claude Code は Windows 上では hook コマンドを Git Bash 経由で実行します。[Git for Windows](https://git-scm.com/download/win) などで Git Bash が使える状態にしてください。

**アンインストールしたい**

```bash
npx agent-cost-notifier uninstall
```

Stop hook のエントリだけを `~/.claude/settings.json` から取り除きます(他の hook・設定はそのまま残ります)。蓄積した履歴・設定・キャッシュも含めて完全に削除したい場合は `--purge` を付けてください(`--yes` を省略すると削除前に確認が入ります)。

```bash
npx agent-cost-notifier uninstall --purge
```

## License

MIT
