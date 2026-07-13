# Codex CLI 対応 / Codex CLI Support

[← README に戻る](../README.md)

ccc-notifier は Claude Code だけでなく **OpenAI Codex CLI**(`codex` コマンド)のコストも、同じ通知・履歴・ダッシュボードの仕組みで扱えます。Codex 側のセットアップも `init` に統合されており、追加のツールやアカウント登録は不要です。

## 導入 / Setup

`init` を対話で実行すると、既存の質問(通知チャネル・コスト表示ラベル・為替レート・月予算)の後に、Codex CLI(`~/.codex` ディレクトリ)を検出した場合だけ次の確認が追加されます(既定 Yes)。

```
Codex CLI を検出しました。Codex にもコスト通知を入れますか?
```

CI・スクリプトなど非対話で実行する場合はフラグで指定します。

```bash
npx ccc-notifier init --yes --codex     # Codex にも Stop hook を導入する
npx ccc-notifier init --yes --no-codex  # Codex には触らない(検出しても何もしない)
```

- `--codex` は `~/.codex` が未検出でも強制的に導入します(このとき `~/.codex` ディレクトリと `hooks.json` を新規作成します)。
- `--codex` と `--no-codex` は同時に指定できません。
- `--yes` だけ(`--codex` / `--no-codex` のどちらも未指定)を渡した場合、Codex 側には一切触れません(非対話実行で意図しないファイルを書き換えないための方針です)。
- Codex 連携は通知チャネルの選択(`--no-notify` を含む)とは独立しています。通知なしモードで導入した場合でも `--codex` を付ければ Codex 分の記録・ダッシュボードは有効にできます。

登録先は Claude Code の `~/.claude/settings.json` とは別ファイルの **`~/.codex/hooks.json`** です。既存の `PermissionRequest` などの他イベント・他エントリは一切変更せず、書き込み前には `hooks.json.bak-<タイムスタンプ>` としてバックアップを作成します(新規作成時はバックアップ不要)。`hooks.json` が壊れていて自動編集できない場合は、Claude 側と同じ方針で自動編集を諦め、手動で追記すべき JSON を画面に表示するだけに留めます。

アンインストールする場合は通常どおり `ccc-notifier uninstall` を実行してください。Claude 側の Stop hook に加えて、Codex の `hooks.json` に登録された本ツールのエントリも(導入していれば)あわせて削除します。`--purge` で `~/.ccc-notifier` の記録・設定・キャッシュを削除する点も共通です。

`ccc-notifier doctor` はuserとproject candidateの `hooks.json` / `config.toml` を確認します。JSONでは本ツールのhandler、path、timeout、重複を検査しますが、`config.toml` のinline hookは独自解析せず候補の存在だけを表示します。project trust、hook review、個別disabled、plugin・managed・session sourceを含む実効状態は静的診断だけでは確定できないため、最終状態はCodex内の `/hooks` で確認してください。

## 重要: hook の信頼承認 / Trusting the hook

**Codex に hook を登録しただけでは通知は動きません。** Codex CLI には hook ごとの信頼確認の仕組みがあり、未承認の hook はサイレントに実行されません(エラーも出ずに黙ってスキップされます)。

`init` で Codex 連携を導入すると、完了メッセージに次の案内が表示されます。

```
次回 codex 起動時に『Hooks need review』が表示されます。『Trust all and continue』を選ぶと有効になります(承認までは動きません)
```

実際の手順:

1. `init` 実行後、次に `codex` を起動する
2. 「**Hooks need review**」(1個以上の hook が新規/変更された旨)が表示される
3. 「**Trust all and continue**」を選ぶ(または「Review hooks」で内容を確認してから個別に承認する)
4. 以降のセッションから Stop hook が発火し、通知・記録が始まる

「Continue without trusting (hooks won't run)」を選んだ場合は hook が動かないままになるので注意してください。この承認状態は Codex 側の `~/.codex/config.toml` に保存されます。ccc-notifier はこのファイルを一切読み書きしません(信頼の可否を確認する手段が無いため、`doctor` は「登録はされているが承認済みかは確認できない」という注意書きに留まります)。

## 仕組み / How it works

Codex CLI にも Claude Code と同様の **Stop hook**(1ターンの応答完了で発火)があり、ccc-notifier はそこに `track --codex` を登録します。

1. Codex がターンを完了すると Stop hook が発火し、`session_id` / `transcript_path`(rollout ファイルのパス)/ `model` などを stdin で渡す
2. `track --codex` が `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` を読み、前回からの**累積トークンカウンタの差分**を集計してそのターンの usage を復元する(Claude の transcript と違い、Codex の rollout は「セッション累積カウンタ」しか記録しないため)
3. 単価表(内蔵 + LiteLLM 自動更新)× トークン数で USD を算出し、為替レートで JPY に換算する
4. Claude Code と**同じ** `~/.ccc-notifier/history.jsonl` に、目印として `source: "codex"` を付けて追記する

記録先が共有されているため、通知本文の「今日: $X」や[月予算](monthly-budget.md)の使用率は常に **Claude Code + Codex の合算**で計算されます(財布は1つです)。通知のフォーマット自体も Claude Code と同じで、モデル名が `GPT-5.5` のように表示されることで区別できます。

## ダッシュボード / Dashboard

Codex 由来のレコードが1件でもあると、`dashboard` に次の要素が追加されます([ダッシュボード](dashboard.md)の共通機能はすべてそのまま使えます)。

- コスト推移グラフの粒度トグルの隣に **[全体] [Claude] [Codex]** のソースフィルタチップが表示され、チャート・モデル別/プロジェクト別内訳・ターン履歴・KPI をソースで絞り込めます
- ターン履歴の該当行に **Codex** バッジが付きます
- Codexでサブエージェントの利用を検出したターンには、**「利用あり・料金未集計」**と開始・終了数が表示されます。これは利用検出だけで、サブエージェント分の料金を総額へ加算するものではありません
- **月予算カードだけはソースフィルタの影響を受けず、常に全ソース合算**です(カード内に「全ソース合算 / all sources」と小さく明記されます)

Codex のレコードが無い環境ではソースフィルタ自体が表示されず、既存の見た目は変わりません。

## 過去分の取り込み / Backfilling (sweep)

`init` で hook を承認する前に使っていたセッションや、まだ Codex を使い始めたばかりで過去のやり取りをまとめて取り込みたい場合は [sweep](sweep.md) が使えます。Codex 対応後は `~/.codex/sessions` 配下も自動的に走査対象になります(`~/.codex` が無い/未使用の環境では黙ってスキップされ、何も表示されません)。

```bash
npx ccc-notifier sweep --dry-run   # 何がいくら取り込まれるか確認するだけ(書き込みなし)
npx ccc-notifier sweep             # 実際に履歴へ取り込む
```

Codex 分の取り込みがあると、サマリーに次の行が追加されます(Claude 側の「うちサブエージェント」行と同じ書式・同じ字下げです)。

```
  Codex: 3 ターン $0.018(¥3)
```

sweep は rollout を `task_complete` イベントの境界でターンに分割して復元するため、hook 導入前のセッションもターン単位で取り込めます。hook(`track --codex`)と同じカーソル管理を使うため、二重計上はありません。

## 金額の意味 / What the cost means

計算方法や「概算値である」という位置づけは Claude Code と同じです。詳しくは [金額の意味](cost.md) を参照してください。ChatGPT Plus / Pro のような**定額プラン**を使っている場合、表示される金額は実際の請求額ではなく「もし従量課金 API で同じやり取りをしたらいくらか」という**参考換算値**です(通知先頭の「API換算」ラベル)。

単価は Anthropic 系と同じ仕組み(内蔵表 + [LiteLLM](https://github.com/BerriAI/litellm) による自動更新)で管理されます。内蔵表には次のモデルの単価が入っています。

- `gpt-5.5` / `gpt-5.1` / `gpt-5` / `gpt-5-codex` / `gpt-5.1-codex` / `o3`

これ以外の新しいモデルも、LiteLLM 側にレートが公開され次第、自動更新で追従します(取得できない未知モデルは通知・`doctor` に unknown model として表示されます)。

## 制限 / Limitations

- **サブエージェント/collab スレッドの usage・料金は未集計です**(将来対応予定)。公式hookで利用の有無と開始・終了は検出しますが、子のtokenや料金は推測しません。そのため履歴の総額・月予算・通知は従来どおりメインスレッド分だけです
- SubagentStart / SubagentStop hookは検出台帳だけを更新し、履歴追記・料金計算・通知・ダッシュボード再生成は行いません。親応答の記録後に開始・終了イベントが届いた場合も、次の通常ターンによるダッシュボード再生成、または手動で`report` / `dashboard`を実行すると、元のターンへ利用表示が反映されます。料金・総額・月予算・通知は変わりません。匿名join keyを持たない導入前の旧履歴には遡及反映されない場合があります
- **reasoning トークンは output トークンに含まれて課金されます**。これは ccc-notifier 側の仕様ではなく OpenAI の課金仕様そのもので、Codex の `token_count` イベントが運ぶ `output_tokens` にはもともと `reasoning_output_tokens` が含まれています

## トラブルシュート / Troubleshooting

**Codex の通知が来ない**場合は次を確認してください。

1. `codex` 側で hook を承認したか(上記「hook の信頼承認」参照。**承認するまで通知は一切動きません**)
2. `npx ccc-notifier doctor` を実行し、「Codex」のブロックを確認する。hook が未登録なら `init --codex` を再実行、登録済みでも承認していない可能性がある旨の注意が出ます

`error.log` に `key integrity mismatch; manual recovery required` がある場合は、検出台帳の匿名identityを守るため自動修復されません。正しい元のkeyを復元して既存identityを維持するか、検出台帳・keyを一組として退避して新規identityで初期化するかを明示的に選んでください。通常hook処理はkeyや台帳を勝手に上書きしません。

`error.log` に `activity lock timeout` が繰り返し記録される場合、同じ端末内でPIDが再利用され、古いlockのPIDが無関係な稼働中processを指している可能性があります。誤って稼働中のwriterを壊さないため、この状態は時間が経っても自動回収しません。まず該当PIDがccc-notifier/Codexの処理でないことを確認し、そのうえで `~/.ccc-notifier/codex-subagent-activity.lock` または `codex-subagent-key.lock` を退避してから再実行してください。確認できない場合は削除せず、そのprocessの終了後に再試行してください。

同じ保存先を複数hostから共有している場合、key/ledgerの一時ファイルはhostnameそのものではなく匿名host tagで所有元を区別します。60秒以上残った一時ファイルでも、自host tagとdead PIDの両方を確認できるものだけを自動回収します。旧形式のhost tag無しファイルや別hostのファイルは安全のため残ることがありますが、通常の記録には使われません。

**データの保存先を変えたい**場合は環境変数 `CCCN_CODEX_HOME` で `~/.codex` の代わりに使うディレクトリを指定できます(`init` / `doctor` / `sweep` / `track --codex` のすべてがこの値を参照します)。
