# ダッシュボード / Dashboard

[← README に戻る](../README.md)

`dashboard` コマンドは、蓄積した履歴を HTML に書き出してブラウザで開きます。既定の物理パスは、毎ターン更新する直近版 `~/.ccc-notifier/report.html` と、1日1回更新する全履歴版 `~/.ccc-notifier/report-all.html` の2つです。片方が未生成でも軽量な案内ページをそのパスに置くため、ヘッダーの相互リンクは常にリンク切れになりません。履歴(`history.jsonl`)と `config.json` だけを読むため、通知をすべて無効にした[通知なしモード](configuration.md#通知なしモード記録ダッシュボードのみ--dashboard-only-mode)でもそのまま動作します。生成物は CSS/JS/SVG をすべてインライン化した**完全自己完結・オフライン動作・外部通信ゼロ**のファイルで、OS のライト/ダーク設定に追従します。プロンプト全文はブラウザで実行されない形(JSON 埋め込み + textContent 描画)で安全に展開されます。

**期間の切り替え・過去の閲覧・連動**(すべてブラウザ側で完結。再取得なし):

- 手動 `dashboard` の引数なしは、`dashboard.days`(既定30日)分を `report.html` に生成します。全履歴が必要なときだけ `dashboard --all` で `report-all.html` を更新します。どちらもコスト推移グラフを **日 / 週 / 月** に切り替えられます。
- グラフの**棒をクリックするとその期間が選択**され、下の「モデル別内訳」「プロジェクト別」「ターン履歴」がその期間に**連動**します。もう一度クリックで解除、**「通算」ボタン**でいつでも全期間に戻せます。
- 選択した粒度・期間・検索語・スクロール位置は自動リロードを跨いでも保持されます。
- 全履歴版はプロンプトが多いとファイルが大きくなるため、自動更新をローカル日ごとの最初の正常なターンに限定しています。

```bash
npx ccc-notifier dashboard            # 設定期間(既定30日)を report.html に生成して開く
npx ccc-notifier dashboard --all      # 全履歴を report-all.html に生成して開く
npx ccc-notifier dashboard --days 7   # 直近7日を report.html に生成して開く
npx ccc-notifier dashboard --no-open --out ./cost.html  # 互換動作: 全履歴を任意パスだけへ出力
npx ccc-notifier dashboard --days 7 --out ./cost.html   # 直近7日を任意パスだけへ出力
npx ccc-notifier dashboard --refresh 10   # 自動リロード間隔を10秒に上書き
npx ccc-notifier dashboard --no-refresh   # 自動リロードを無効化して生成
```

検索・行クリックでプロンプト全文を確認できます([ページ全体のスクリーンショット](images/dashboard-full.png)):

![ターン履歴(検索と全文展開)](images/history-expand.png)

引数と出力の対応は次のとおりです。`--all` と `--days` は同時に指定できません。`--days` の欠落、0、負数、小数、非数値は終了コード1の引数エラーとなります。`--refresh` は0以上の整数だけを受け付け、`0` で自動リロードを無効化します。値の欠落、小数、負数、数値以外はエラーです。未定義のオプションや余分な位置引数も無視せずエラーにします。これらの引数エラーはHTML・日次状態を変更せず、ブラウザも開きません。

| 指定 | 対象 | 出力 |
|---|---|---|
| なし | `dashboard.days` 日分(既定30日) | `report.html` |
| `--all` | 全履歴 | `report-all.html` |
| `--days N` | 直近N日 | `report.html` |
| `--out X` | 全履歴(従来互換) | Xのみ |
| `--all --out X` | 全履歴 | Xのみ |
| `--days N --out X` | 直近N日 | Xのみ |

`--out X` を指定した場合は X だけを生成し、canonical 2ファイルや日次状態には触れず、相互リンクも付けません。canonical の全履歴版を正常に生成した `dashboard --all` だけが、その日の全履歴版を生成済みとして日次状態を更新します。

> **0.3系からの変更:** 以前は引数なしの `dashboard` が全履歴版を生成しましたが、現在は毎ターン更新される直近版を開きます。全履歴を手動更新する場合は `dashboard --all` を使用してください。履歴が増えるほど全履歴HTMLの生成・ブラウザ描画が重くなるため、日常操作を軽い直近版へ寄せ、全履歴版は必要時と1日1回に分離しました。なお、既存スクリプトとの互換性のため `--out X` 単独は引き続き全履歴です。

サマリー・日別チャート・モデル別/プロジェクト別・合計はいずれも**サブエージェント分を含む総額**で表示します。サブエージェントを使ったターンがあると、ヒーローの合計の下に「うちサブエージェント $X(¥Y)」が表示され、モデル別内訳にはサブエージェントが使ったモデル(Sonnet 5 など)も並びます。ターン履歴では該当ターンのモデル欄に `+SA` が付き、行を展開すると「サブエージェント: $X(¥Y)· モデル名 · APIコール N」の内訳が出ます(サブエージェントの完了タイミングにより、その分が次ターン以降の日に計上されることがあります)。

## 開くたびに最新に近いダッシュボード / Near-live dashboard

Claude Code / Codex の正常な新規ターンを記録した後、次の2ファイルを更新します。

- `report.html`: `dashboard.days`(既定30日)分だけを埋め込み、**正常な新規ターンごと**に更新します。
- `report-all.html`: 全履歴を埋め込み、**ローカル日の最初の正常な新規ターンだけ**更新します。手動 `dashboard --all` でも直ちに更新できます。

全履歴版の生成済み状態は `~/.ccc-notifier/cache/dashboard-full-state.json` に保存します。状態がない・壊れている・未来を示す・タイムゾーンが変わった・実体の全履歴版がない場合は再生成します。履歴・カーソル・dashboard snapshotの競合は、所有tokenとheartbeat leaseを持つatomic directory lock `cache/data.lock/` で直列化します。trackは記録commitとdashboard生成でlockを分け、通知・価格・為替処理はlock外に置きます。生成に失敗した場合は状態を進めず、次の正常な新規ターンで再試行します。

期限切れlockの回収は、同じhostnameでheartbeatが期限切れ、かつ `process.kill(pid, 0)` が `ESRCH` を返して死亡を確定できた場合だけです。`EPERM`、別hostname、生存PIDは回収しません。回収者は `cache/data.lock.reclaim/` をatomic取得し、owner token/heartbeatを再確認してから旧directoryを固有orphan pathへrenameします。reclaimer guardだけが孤児化した場合はmain lockの通常利用を妨げません。ただしmain lockとguardが両方孤児化した場合は安全な自動復旧ができないため、全ccc-notifierプロセスの停止を確認して両directoryを手動で退避・削除してください。

履歴ファイルは両版で共有して1回だけ全件を読み込み・解析してから配列を期間で絞るため、読み込み処理自体は履歴総量に比例します(当月予算を正確に集計するためです)。生成 HTML の自動リロード(既定30秒)を跨いでも、**選択中の粒度・選択期間・検索語・スクロール位置は保持**されます。

- **自動再生成を止める**: `config.json` で `dashboard.autoRegenerate` を `false` にします。両HTML・日次stateは更新しませんが、履歴・カーソルを安全に記録するためdata lockは使用します。
- **自動再生成の対象期間を変える**: `config.json` の `dashboard.days` に正の整数を指定します。不正値は30日にフォールバックします。
- **自動リロードを止める**: `config.json` で `dashboard.autoReloadSec` を `0` にします(生成物から meta refresh が消えます)。一時的に切りたいときは `dashboard --no-refresh`、間隔だけ変えたいときは `dashboard --refresh <秒>` を使います。

相手側のcanonical HTMLがまだ未生成の場合、そのパスには生成方法と戻るリンクを載せたplaceholderを作ります。全履歴版の案内は `ccc-notifier dashboard --all`、直近版の案内は `ccc-notifier dashboard` を示し、実体を生成した時点でplaceholderをatomicに上書きします。

自動リロードは meta refresh による軽量なもので、**外部通信は一切発生しません**(生成物は従来どおり完全自己完結・オフライン動作です)。

月予算カードは `report.html` の**期間限定版では全履歴から集計した当月の値に固定**され、グラフの期間選択には連動しません。`report-all.html` の**全履歴版では選択した暦月に連動**します。どちらも Claude Code / Codex CLI の全ソース合算です。

## 履歴の削除 / Deleting history

全履歴版 `report-all.html` は全期間のプロンプト全文を含むため、履歴が増えるとファイルが大きくなります。プライバシー上プロンプトを残したくない場合や、古い履歴を消したい場合は `history` コマンドを使います。**元に戻せない操作**なので、`--yes` を付けなければ対象件数を表示して確認します。

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
- 後から`sweep`を実行すると、元JSONLが残っている`clear`済み履歴と`redact`済みpromptは再生成されます。sweepは削除状態を永続化せず、実行前backupも作りません。完全な削除が必要な場合は元JSONL側の保管方針も確認してください。
- どちらも `--days N` で「N 日より前」だけを対象にできます(省略で全期間)。`--yes` で確認を省略します。
- `--yes` なしでは、確認前の対象レコード集合を内容ベースのfingerprintで記録します。確認中に履歴が追加・差し替えされた場合は何も削除せず、再実行を促して終了コード1を返します。`--yes` はdata lock内で読み直した最新snapshotへ実行します。
- 確認をキャンセルしなかった `clear` / `redact` は、data lock取得後にまず `report.html`、`report-all.html`、日次stateを無効化してから履歴を書き換え、成功後にも再度無効化します。履歴書き換えが失敗・前回途中終了しても古いプロンプトHTMLを残さず、履歴なし/対象なしで再実行しても安全な状態へ収束します。`--out` で作った任意ファイルは対象外です。
