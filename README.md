# ccc-notifier

**ccc = Claude Code Cost.** Claude Code で **プロンプトを実行するたび**、そのターンにかかったコストを **$(USD)と¥(JPY)の両方** で自動通知するツールです。**5分で導入できます。**

```
💰 API換算 $0.267(¥40)| Fable 5
in 1.2k(cache 40%)/ out 480 · 📁 my-app · 今日: $1.85
バグを直してテストを通してください
```

上が通知の例です(1行目がタイトル、2〜3行目が本文)。応答が完了するたびに OS 通知(任意で Slack 通知も)としてこれが届きます。

> **⚠️ 表示される金額はあくまで概算値です。** transcript のトークン数 × 公開単価表からローカルで計算した参考値であり、Anthropic の請求額と一致することを保証するものではありません。「使いすぎに気づく」ための目安としてご利用ください(詳細は「[金額の意味](#金額の意味--what-the-cost-means)」)。

![通知の実例](docs/images/notification.png)

![ダッシュボード](docs/images/dashboard.png)

## 特徴 / Features

- **ターン毎に自動通知** — Claude Code の応答が完了するたび(Stop hook)に、そのターンのコストを自動でプッシュ通知します。自分から `/cost` を見に行く必要はありません
- **$ と ¥ を併記** — USD と JPY の両方を毎回表示します(為替レートは自動取得 + キャッシュ + 固定フォールバックの三段構え)
- **プロンプト全文をローカルに履歴保存** — `~/.ccc-notifier/history.jsonl` にそのターンのプロンプト全文を保存します(外部には送信されません)
- **HTMLダッシュボード** — `dashboard` コマンドで、サマリー・コスト推移(**日 / 週 / 月**で切替、横スクロールで過去まで)・モデル別/プロジェクト別内訳・検索できるターン履歴を1枚の HTML(完全自己完結・ライト/ダーク対応)に書き出してブラウザで開きます。棒をクリックするとその期間が選択され、内訳・履歴が連動(「通算」で全期間)
- **月予算(monthly budget)** — 月に使える金額(USD)を設定すると、ダッシュボードに**当月の使用額 / 予算・使用率(%)**をプログレスバーで表示します(`init` の対話、または `ccc-notifier budget <金額>` で設定)
- **OS 標準の通知機構のみ使用・追加依存ゼロ** — 通知は macOS では `osascript`、Windows では PowerShell 標準のトースト通知機能のみで送信します(node-notifier 等の外部通知ライブラリには一切依存しません)
- **全処理ローカル・フェイルセーフ設計** — 通知や集計の処理が失敗しても、Claude Code 本体の応答は絶対にブロックしません

## 必要環境 / Requirements

- Node.js 20 以上(未導入の場合は下の「Node.js の用意」を参照してください)
- Claude Code(インストール・利用中であること)

## Node.js の用意(まだ入っていない方へ)/ Installing Node.js

すでに Node.js 20 以上をお使いの方は、この節を読み飛ばして次の「インストール / Install」に進んでください。

### 推奨: mise

このリポジトリには [mise](https://mise.jdx.dev)(プログラミング言語のバージョン管理ツール)用の設定ファイル `mise.toml` が同梱されています。mise を使うとプロジェクトごとのバージョン切り替えが楽になり、`mise install` の1コマンドで本リポジトリが必要とする Node.js 20 が入ります。

1. **mise をインストールする**

   macOS・Linux 共通(公式インストールスクリプト):

   ```bash
   curl https://mise.run | sh
   ```

   macOS で Homebrew を使っている場合はこちらでも構いません。

   ```bash
   brew install mise
   ```

2. **シェルに mise を認識させる(activate)**

   お使いのシェルの設定ファイルに1行追記し、シェルを再読み込みします。

   zsh の場合:

   ```bash
   echo 'eval "$(~/.local/bin/mise activate zsh)"' >> ~/.zshrc && source ~/.zshrc
   ```

   bash の場合:

   ```bash
   echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc && source ~/.bashrc
   ```

3. **Node.js 20 を入れる**

   本リポジトリを clone する前でも実行できるように、まずはグローバルの既定バージョンとして Node.js 20 を入れます。

   ```bash
   mise use -g node@20
   ```

   (この後「インストール / Install」で本リポジトリを clone すると、同梱の `mise.toml` を使って `mise install` を実行する手順が出てきます。リポジトリのディレクトリ内で `mise install` を実行した場合も、`mise.toml` が指定する Node.js 20 が同様に入ります。)

4. **確認する**

   ```bash
   node -v
   ```

   `v20.x.x` のように表示されれば成功です。

補足: Windows での mise は、公式ドキュメントによると現時点では shim 経由の実行のみのサポートで、`mise.toml` の内容が素直に反映されない場合があります。Windows をお使いの方は下の「代替」の方法をおすすめします。

### 代替: 公式インストーラ

mise を使わない場合は、[nodejs.org](https://nodejs.org/en/download) の公式インストーラ(macOS・Windows・Linux 共通)から Node.js 20 以上を入れてください。

- **Windows**: winget が使える場合は次のコマンドでも入ります(LTS版が入ります)。

  ```powershell
  winget install -e --id OpenJS.NodeJS.LTS
  ```

  winget が使えない場合は [nodejs.org](https://nodejs.org/en/download) から公式インストーラをダウンロードしてください。

## インストール / Install

### 方法A: ソースから(現時点ではこちらをご利用ください)

```bash
git clone https://github.com/shimabox/ccc-notifier.git
cd ccc-notifier
mise install          # mise 利用時(Node.js 20 が自動で入ります)。mise が無ければ上の「Node.js の用意」を参考に Node.js 20 以上を用意してください
npm ci
npm run build
node dist/cli.js init
```

最後の `node dist/cli.js init` が次の「セットアップ / Setup」の内容(対話形式のセットアップ)です。

### 方法B: npm から(公開後に有効)

```bash
npm install -g ccc-notifier
ccc-notifier init
```

※ 現在 npm 公開準備中です。公開されるまでは方法Aをご利用ください。

## セットアップ / Setup

> **補足**: このセクション以降に出てくる `npx ccc-notifier <command>` や `npm install -g ccc-notifier` は、npm 公開後(上記「インストール / Install」の方法B)を前提にした表記です。**方法A(ソースから)でインストールした場合は、`npx ccc-notifier <command>` を `node dist/cli.js <command>` に読み替えてください**(リポジトリのディレクトリで実行します)。

1. **セットアップコマンドを実行**

   「インストール / Install」で行った方法に応じて `init` を実行します。

   - 方法A(ソースから)の場合: `node dist/cli.js init`
   - 方法B(npm、公開後)の場合: `npx ccc-notifier@latest init`

2. **質問に答える**

   対話形式で次の4点を聞かれます。

   - 通知チャネル(OS通知のみ / OS通知+Slack / Slackのみ)
   - コスト表示ラベル(API換算 / 実額)
   - USD/JPY のフォールバック為替レート(既定 150円)
   - 月の予算(USD、既定 $400。`0` で無効。ダッシュボードに当月の使用率を表示。詳細は「[月予算](#月予算--monthly-budget)」)

   完了すると Claude Code の `~/.claude/settings.json` に Stop hook が自動で追記されます。**既存の設定内容(他の hook や設定)は一切変更されず**、書き込み前に必ず `settings.json.bak-<タイムスタンプ>` としてバックアップが作成されます。settings.json が壊れている(JSONとして解析できない)場合は自動編集を諦め、手動で追記する内容を画面に表示するだけで、ファイルには一切書き込みません。

3. **Claude Code で何か実行してみる**

   ひとこと実行して応答が完了すると、通知が届きます。

届かない場合は次のコマンドで診断できます。

```bash
npx ccc-notifier doctor
```

hook登録・設定ファイル・単価表・為替レート・テスト通知・直近セッション合計などを ✅ / ⚠️ / ❌ で表示し、❌ が1つでもあれば終了コード1を返します。

### 非対話実行(CI・スクリプト向け)/ Non-interactive flags

毎回 `npx` するのが面倒な場合は `npm install -g ccc-notifier` でグローバルインストールもできます(コマンドは `ccc-notifier` または短縮形の `ccc` になります)。CI などから非対話で `init` したい場合は次のフラグが使えます。

| フラグ | 説明 |
|---|---|
| `--yes`, `-y` | 対話プロンプトを出さずに実行(非対話には必須) |
| `--os-only` | Slack を無効化し OS通知のみにする |
| `--slack-webhook <url>` | Slack Incoming Webhook URL を指定して有効化 |
| `--slack-only` | Slack のみにする(OS 通知を無効化)。`--slack-webhook` と併用が必須 |
| `--label <api_equivalent\|actual>` | コスト表示ラベルを指定 |
| `--rate <number>` | USD/JPY フォールバックレートを指定 |
| `--budget <USD>` | 月予算(USD)を指定(0 で無効)。未指定なら既定 **$400**(既存設定があれば維持) |

## コマンド一覧 / Commands

| コマンド | 説明 |
|---|---|
| `init` | Stop hook を対話形式でセットアップ(前述のフラグで非対話実行も可) |
| `doctor` | hook登録・設定・単価表・為替・通知・直近セッション合計を診断 |
| `report [--days N] [--json]` | 蓄積した履歴を集計してターミナルに表示(`--days` の既定は30、不正な値も30扱い)。`--json` で機械可読な出力 |
| `dashboard [--days N] [--no-open] [--out <path>] [--refresh <sec>\|--no-refresh]` | 履歴を可視化した HTML ダッシュボードを生成してブラウザで開く(**既定で全履歴**を埋め込み、日/週/月・通算をブラウザ側で切り替え。`--days N` で埋め込む範囲を直近N日に絞れます。`--no-open` で生成のみ、`--out` で出力先を上書き。`--refresh <sec>` で自動リロード間隔を上書き、`--no-refresh` で自動リロードを無効化) |
| `sweep [--dry-run] [--days N] [--include-active]` | 過去の未計上分(hook 導入前のセッションや、後から完了したサブエージェント分)を一括で履歴に取り込む。ローカル走査のみで **Claude API を呼ばず料金ゼロ**・二重計上なし。直近5分以内に更新された transcript(進行中セッションの可能性)は自動スキップ(`--include-active` で解除)。`--dry-run` で取り込み前に確認、`--days N` で N 日より古いターンを除外(詳細は「過去分の取り込み」) |
| `history <clear\|redact> [--days N] [--yes]` | 履歴(`history.jsonl`)を削除。`clear` はレコードごと削除(チャート・集計からも消える)、`redact` はプロンプト全文だけ消去(コスト・チャートは残る)。`--days N` で「N 日より前」だけを対象(省略で全期間)。`--yes` を付けなければ対象件数を示して確認します(詳細は「履歴の削除」) |
| `budget [<USD>]` | 月予算(USD)の表示/設定。金額省略で現在の予算と当月の使用率を表示、`budget 400` で設定、`budget 0` で解除。ダッシュボードに当月の使用率カードを表示します(詳細は「月予算」) |
| `mute [30m\|2h\|1d]` | 通知(OS/Slack)を一時停止する。期間を省略すると無期限、`30m`/`2h`/`1d` 形式で期限付き(期限が来ると自動で再開)。**停止中もコストの記録とダッシュボード更新は続きます**(詳細は「通知の一時停止と再開」) |
| `unmute` | 停止した通知を再開する |
| `uninstall [--purge] [--yes]` | Stop hook を削除。`--purge` を付けると `~/.ccc-notifier` のデータ(設定・履歴・キャッシュ)も削除 |
| `track` | Stop hook から自動的に呼ばれる**内部コマンド**。stdin 経由で JSON を受け取ります。手動実行は不要です |
| `--version`, `-v` | バージョン表示 |
| `--help`, `-h` | ヘルプ表示 |

`report --json` は次のような形の JSON を出力します(スクリプト等への取り込み用)。

```json
{
  "days": 30,
  "daily": [{ "date": "2026-07-06", "turns": 3, "inputTokens": 12345, "outputTokens": 678, "costUSD": 0.42, "costJPY": 63 }],
  "byModel": { "claude-fable-5": { "turns": 2, "costUSD": 0.3, "costJPY": 45 }, "claude-sonnet-5": { "turns": 1, "costUSD": 0.03, "costJPY": 4.5 } },
  "total": { "turns": 3, "inputTokens": 12345, "outputTokens": 678, "costUSD": 0.42, "costJPY": 63, "subagentsUSD": 0.03 }
}
```

金額(`daily` / `byModel` / `total` の `costUSD`・`costJPY`)は**サブエージェント分を含む総額**です。`total.subagentsUSD` はそのうちサブエージェントが占める金額(なければ 0)、`byModel` にはサブエージェントが使ったモデル(上例の `claude-sonnet-5` など)も含まれます。

## ダッシュボード / Dashboard

`dashboard` コマンドは、蓄積した履歴を1枚の HTML(既定 `~/.ccc-notifier/report.html`)に書き出してブラウザで開きます。サマリーカード(今日 / 今週(直近7日)/ 今月(暦月)/ 通算)、コスト推移のモデル別積み上げ棒グラフ、モデル別・プロジェクト別の内訳、検索・行展開できるターン履歴を表示します。生成物は CSS/JS/SVG をすべてインライン化した**完全自己完結・オフライン動作・外部通信ゼロ**のファイルで、OS のライト/ダーク設定に追従します。プロンプト全文はブラウザで実行されない形(JSON 埋め込み + textContent 描画)で安全に展開されます。

**期間の切り替え・過去の閲覧・連動**(すべてブラウザ側で完結。再取得なし):

- **既定で全履歴を埋め込みます。** コスト推移グラフは **日 / 週 / 月** をボタンで切り替えられ、横スクロールで過去まで遡れます。
- グラフの**棒をクリックするとその期間が選択**され、下の「モデル別内訳」「プロジェクト別」「ターン履歴」がその期間に**連動**します。もう一度クリックで解除、**「通算」ボタン**でいつでも全期間に戻せます。
- 選択した粒度・期間・検索語・スクロール位置は自動リロードを跨いでも保持されます。
- 全履歴を埋め込むためプロンプトが多いとファイルが大きくなります。気になる場合は後述の **`history redact` / `history clear`** で履歴を整理できます。

```bash
npx ccc-notifier dashboard            # 既定30日・生成してブラウザで開く
npx ccc-notifier dashboard --days 7   # 対象期間を直近7日に
npx ccc-notifier dashboard --no-open --out ./cost.html  # 開かずに任意パスへ出力
npx ccc-notifier dashboard --refresh 10   # 自動リロード間隔を10秒に上書き
npx ccc-notifier dashboard --no-refresh   # 自動リロードを無効化して生成
```

検索・行クリックでプロンプト全文を確認できます([ページ全体のスクリーンショット](docs/images/dashboard-full.png)):

![ターン履歴(検索と全文展開)](docs/images/history-expand.png)

既定では**全履歴**を埋め込み、粒度(日/週/月)や期間の選択はブラウザ側で行います。ファイルを小さくしたい場合は `--days N` で埋め込む範囲を直近N日に絞れます(不正値・省略で全履歴)。

サマリー・日別チャート・モデル別/プロジェクト別・合計はいずれも**サブエージェント分を含む総額**で表示します。サブエージェントを使ったターンがあると、ヒーローの合計の下に「うちサブエージェント $X(¥Y)」が表示され、モデル別内訳にはサブエージェントが使ったモデル(Sonnet 5 など)も並びます。ターン履歴では該当ターンのモデル欄に `+SA` が付き、行を展開すると「サブエージェント: $X(¥Y)· モデル名 · APIコール N」の内訳が出ます(サブエージェントの完了タイミングにより、その分が次ターン以降の日に計上されることがあります)。

### 開くたびに最新に近いダッシュボード / Near-live dashboard

Claude Code の応答が完了するたび(Stop hook の `track` 実行時)に、この `report.html` を**自動で再生成**します(全履歴を埋め込みます)。さらに生成される HTML には**自動リロード**(既定30秒ごと)が仕込まれているため、`report.html` をブラウザのタブで開きっぱなしにしておくと、Claude Code を使っている間そのタブが**約30秒ごとに最新の内容へ更新**されていきます(最新化のタイミングは Claude Code の応答完了時)。自動リロードを跨いでも、**選択中の粒度(日/週/月)・選択期間・検索語・スクロール位置は保持**されるので、見ていた場所を見失いません。

- **自動再生成を止める**: `config.json` で `dashboard.autoRegenerate` を `false` にします(以後は手動で `dashboard` コマンドを実行したときだけ生成されます)。
- **自動リロードを止める**: `config.json` で `dashboard.autoReloadSec` を `0` にします(生成物から meta refresh が消えます)。一時的に切りたいときは `dashboard --no-refresh`、間隔だけ変えたいときは `dashboard --refresh <秒>` を使います。

自動リロードは meta refresh による軽量なもので、**外部通信は一切発生しません**(生成物は従来どおり完全自己完結・オフライン動作です)。

## 月予算 / Monthly budget

月に使える金額(USD)を決めておくと、ダッシュボードに**その月の使用額 / 予算・使用率(%)**をプログレスバーで表示できます(使用率が 70% を超えると黄色、100% を超えると赤で警告)。コスト推移のグラフで**過去の月(や日・週)を選ぶと、そのカレンダー月に連動**して表示が切り替わります(「通算」時は今月)。**予算の設定だけで、使用を止めたり通知したりはしません**(あくまで「使いすぎに気づく」ための可視化です)。

設定方法は2通り:

- **`init` の対話**で「月の予算(USD)」を聞かれます。既定は **$400**(空欄のままだと $400。`0` で無効)。
- **`budget` コマンド**でいつでも変更できます。

```bash
ccc-notifier budget            # 現在の予算と当月の使用率を表示
ccc-notifier budget 400        # 月予算を $400 に設定
ccc-notifier budget 0          # 予算を解除(未設定に戻す)
```

予算は USD で設定します(コストが USD 基準のため)。ダッシュボードでは $ と ¥(¥ は `fx.fallbackRate` 換算)を併記します。予算未設定(0)のときはカードを表示しません。設定は `config.json` の `monthlyBudgetUSD` に保存されます。

## 履歴の削除 / Deleting history

ダッシュボードは全履歴(プロンプト全文を含む)を埋め込むため、履歴が増えるとファイルが大きくなります。プライバシー上プロンプトを残したくない場合や、古い履歴を消したい場合は `history` コマンドを使います。**元に戻せない操作**なので、`--yes` を付けなければ対象件数を表示して確認します。

```bash
# プロンプト全文だけ消す(コスト集計・チャートは残る)
ccc-notifier history redact            # 全期間
ccc-notifier history redact --days 30  # 30日より前のプロンプトだけ

# 履歴レコードごと削除(チャート・集計からも消える)
ccc-notifier history clear             # 全削除
ccc-notifier history clear --days 90   # 90日より前だけ
```

- **`redact`** はコスト・トークン等の集計値を保持したままプロンプト本文だけを消すので、金額の推移やモデル別内訳はそのまま見られます。ファイル削減・プライバシー目的ならこちらで十分です。
- **`clear`** はレコードそのものを消すため、その期間はチャート・集計からも消えます。
- どちらも `--days N` で「N 日より前」だけを対象にできます(省略で全期間)。`--yes` で確認を省略します。

## 過去分の取り込み / Backfilling (sweep)

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

**進行中セッションの自動スキップ**: 直近5分以内に更新された transcript は「今まさに動いているセッション」の可能性があるため、`sweep` は自動でスキップします(スキップした件数はサマリに表示されます)。これは、応答完了の瞬間に sweep が重なると hook より先にそのターンを取り込んでしまい、**そのターンの通知だけが出なくなる**競合を防ぐためです。スキップされた分は、セッション完了後に `sweep` を再実行するか、通常どおり hook が拾うので取りこぼしにはなりません。全セッションが完了していると分かっている場合は `--include-active` でスキップせずに取り込めます。

> **円換算(JPY)について**: 過去分の円換算は、当時のレートではなく **`sweep` を実行した時点の為替レート**で計算します(USD 額はトークン数 × 単価で当時どおりに算出されます)。

## 金額の意味 / What the Cost Means

`costLabel` は **表示ラベルを変えるだけ** で、計算方法そのものは変わりません。常にトークン数 × 単価で計算した同じ金額を使います。

- **`api_equivalent`(既定)**: Claude Pro / Max などの**定額プラン**を使っている場合、これは実際の請求額ではなく「もし従量課金の API で同じやり取りをしたらいくらか」の**参考換算値**です。通知の先頭に「API換算」と表示されます
- **`actual`**: **API キー**で従量課金利用している場合、この金額はほぼ実費に一致します。この場合は「API換算」ラベルを外して表示できます(`--label actual` または `config.json` で切替)

単価は Anthropic 公式レートを内蔵した単価表をベースに、[LiteLLM](https://github.com/BerriAI/litellm) が公開している価格データで自動更新されます(キャッシュ24時間、取得できない場合は内蔵値・キャッシュへフォールバック)。プロンプトキャッシュも「5分保持」か「1時間保持」かで単価が異なる点まで区別して計算しています。

### 概算値である理由 / Why the numbers are estimates

`actual` 設定であっても、表示額は**請求書の代わりにはなりません**。あくまで概算値・目安として見てください。ズレが生じうる主な理由:

- **計算がローカルの近似**: Claude Code が transcript に記録した usage(トークン数)× 単価表で計算しており、Anthropic 側の請求計算そのものではありません
- **単価表の鮮度**: 単価は LiteLLM の公開データ + 内蔵表に依存します。新モデルの追加や価格改定への反映が遅れることがあり、単価が見つからないモデルは計上できません(その場合は通知・`doctor` で unknown model として表示されます)
- **為替は変動**: ¥ 表示は取得時点のレート(キャッシュ最大12時間、取得失敗時は固定フォールバックレート)で換算します。`sweep` で取り込んだ過去分も**実行時点のレート**で換算します
- **取りこぼしの可能性**: hook が発火しなかったターン(強制終了など)は記録されません(`sweep` で後から回収できます)

正確な請求額は [Anthropic Console](https://console.anthropic.com/)(API 利用)や各プランの請求情報で確認してください。

## 設定 / Configuration

`init` で答えた内容は `~/.ccc-notifier/config.json` に保存されます(Claude Code 自体の `~/.claude/settings.json` とは別のファイルです)。直接編集しても構いません。

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
| `monthlyBudgetUSD` | number | `0` | 月予算(USD)。`0` で無効。ダッシュボードに当月の使用率カードを表示(`budget` コマンド / `init` の `--budget` で設定) |
| `dashboard.autoRegenerate` | boolean | `true` | 応答完了(`track`)のたびに `report.html` を自動再生成するか |
| `dashboard.autoReloadSec` | number | `30` | 生成 HTML の自動リロード間隔(秒)。`0` で自動リロードを無効化 |
| `dashboard.days` | number | `30` | 自動再生成時に集計する対象期間(日数) |

補足: データ保存先(既定 `~/.ccc-notifier`)は環境変数 `ACN_HOME` で上書きできます。

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
- 恒久的に OS 通知を切りたい場合は `config.json` の `notify.os: false`、金額の小さいターンだけ通知を抑えたい場合は `minNotifyUSD` が向いています(前項「設定」参照)

## Slack 通知の有効化 / Enabling Slack Notifications

1. Slack で Incoming Webhook を発行します(Slack App の管理画面で *Incoming Webhooks* を有効化 → *Add New Webhook to Workspace* → 通知したいチャンネルを選択すると `https://hooks.slack.com/services/...` 形式の URL が発行されます)
2. 次のいずれかの方法で設定します。
   - `npx ccc-notifier init` を実行し、「通知チャネル」で *OS通知 + Slack*(OS通知と併用)または *Slackのみ*(OS通知なし)を選んで URL を貼り付ける
   - 非対話: `npx ccc-notifier init --yes --slack-webhook "https://hooks.slack.com/services/XXX"`(OS通知も併用)。Slack だけにしたい場合は `--slack-only` を併用します
   - `~/.ccc-notifier/config.json` を直接編集し、`notify.slack` に `{ "webhookUrl": "...", "promptChars": 100, "sendFullPrompt": false }` を設定(OS通知を切るなら `notify.os` を `false` に)
3. Slack にはタイトル・トークン/コスト概要・プロンプト冒頭(既定100字、`sendFullPrompt: true` で全文)の3ブロックが送信されます。送信は3秒でタイムアウトし、失敗しても(Webhook設定ミスなどがあっても)Claude Code の応答自体には一切影響しません
4. `init` を実行した時点で、Slack を設定していれば **Slack にテスト通知が1回送信**されます(OS通知も有効なら同時に送られます)。あとから確認したいときは `npx ccc-notifier doctor` でも同じテスト通知を送れます。実送信せず中身だけ見たい場合は `ACN_DRY_RUN=1 npx ccc-notifier doctor` とすると `~/.ccc-notifier/last-notify.json` に書き出されます。届かないときは `~/.ccc-notifier/error.log` に `notifySlack` の記録が残ります

## プライバシー / Privacy

- プロンプトの全文は **ローカルの `~/.ccc-notifier/history.jsonl` にのみ** 保存されます
- OS通知に表示されるプロンプトは、ローカル上で先頭50字程度に切り詰めたものです
- Slack を設定した場合のみ、既定でプロンプト冒頭100字(`sendFullPrompt` で文字数変更・全文送信も可能)がその Slack Webhook 宛に送信されます
- それ以外に外部へ送信されるのは次の2種類の API 呼び出しだけです。いずれもプロンプトやコードの内容を一切含まない、レート・価格を取得するだけのリクエストです
  - 為替レート取得([frankfurter.dev](https://frankfurter.dev/) → 失敗時は [open.er-api.com](https://open.er-api.com/))
  - 単価表取得([LiteLLM の公開JSON](https://github.com/BerriAI/litellm))

## 仕組み / How it Works

1. Claude Code の **Stop hook**(1ターンの応答完了)から `track` コマンドが呼ばれる
2. transcript(`*.jsonl`)を集計し、トークン数 × 単価表 = USD、さらに為替レートで JPY を算出する
3. さらに、そのターンで動いた**サブエージェント/バックグラウンドの usage**(transcript の兄弟ディレクトリ `<session>/subagents/agent-*.jsonl` に保存されます)も増分集計し、「サブエージェント」枠として同じターンの記録に含める
4. 結果を `history.jsonl` に追記し、しきい値以上なら OS通知 / Slack通知(両方ベストエフォート・並行実行)を送る

サブエージェント分は履歴・`report`・ダッシュボードの**総額に合算**されますが、**通知の金額と発火しきい値はメイン(その場の応答)のコストのみ**で判定します(通知の挙動は従来と変わりません)。

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
        ├─→ ~/.ccc-notifier/history.jsonl に1行追記
        └─→ 金額がしきい値(minNotifyUSD)以上なら OS通知 / Slack通知
```

設計上、**Claude Code 本体の動作を絶対にブロックしません**。`track` 全体が1つの try/catch で囲われており、何が起きても標準出力には何も出さず常に終了コード0を返します(失敗の詳細は `~/.ccc-notifier/error.log` にのみ記録)。ネットワークアクセス(為替取得・単価表取得・Slack送信・OS通知)にはすべて個別にタイムアウトが設定されており、無限に待ち続けることはありません。

## よくある質問 / FAQ

**通知が来ない**

```bash
npx ccc-notifier doctor
```

を実行し、❌ が出ている項目を確認してください。よくある原因:

- hook が未登録 → `npx ccc-notifier init` を再実行してください
- `config.json` の `notify.os` が `false` → 意図的に無効化されています
- そのターンの金額が `minNotifyUSD` 未満 → 通知は来ませんが、履歴(`report`)には記録されています

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

- `report.html` は Claude Code の応答完了(Stop hook)ごとに再生成され、既定では約30秒ごとに自動リロードされます。タブを**閉じずに開いたまま**にしておいてください(再生成した瞬間ではなく、次の自動リロードのタイミングで最新化されます)。リロードを跨いでも検索語・スクロール位置は保持されます
- 自動リロードだけを止めたい場合は `config.json` の `dashboard.autoReloadSec` を `0` に、応答完了ごとの再生成自体を止めたい場合は `dashboard.autoRegenerate` を `false` にしてください(その場合は必要なときに手動で `dashboard` コマンドを実行します)

**Windows で通知が届かない**

Claude Code は Windows 上では hook コマンドを Git Bash 経由で実行します。[Git for Windows](https://git-scm.com/download/win) などで Git Bash が使える状態にしてください。

**アンインストールしたい**

```bash
npx ccc-notifier uninstall
```

Stop hook のエントリだけを `~/.claude/settings.json` から取り除きます(他の hook・設定はそのまま残ります)。蓄積した履歴・設定・キャッシュも含めて完全に削除したい場合は `--purge` を付けてください(`--yes` を省略すると削除前に確認が入ります)。

```bash
npx ccc-notifier uninstall --purge
```

## License

MIT
