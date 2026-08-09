# 仕組み / How it Works

[← README に戻る](../README.md)

1. Claude Code の **Stop hook**(1ターンの応答完了)から `track` コマンドが呼ばれる
2. transcript(`*.jsonl`)を集計し、トークン数 × 単価表 = USD、さらに為替レートで JPY を算出する
3. さらに、そのターンで動いた**サブエージェント/バックグラウンドの usage**(transcript の兄弟ディレクトリ `<session>/subagents/agent-*.jsonl` に保存されます)も増分集計し、「サブエージェント」枠として履歴に含める
4. 結果を `history.jsonl` に追記し、しきい値以上なら OS通知 / Slack通知(両方ベストエフォート・並行実行)を送る

サブエージェント分は履歴・`report`・ダッシュボードの**総額に合算**されますが、**通知の金額と発火しきい値はメイン(その場の応答)のコストのみ**で判定します(通知の挙動は従来と変わりません)。

サブエージェントが親の応答より後に完了することもあります。その場合は、同じセッションで次にStop hookが動いたとき、または`sweep`を実行したときに回収します。次のStopでメインの応答も同時に記録された場合は、その履歴にサブエージェント分が含まれることがあります。メインの応答が無い場合や、`sweep`で完了後の親ターンが見つからない場合は、**メイン金額 `$0`・プロンプトなし**の独立した履歴として表示します。

このため、サブエージェント分がどのターン・日・月に入るかは概算です。金額はダッシュボードや`report`の総額に含まれますが、独立した履歴からOS/Slack通知は送りません。

```
Claude Code が1ターンの応答を完了
        │  Stop hook 発火 (stdin で session_id / transcript_path / cwd を渡す)
        ▼
 node dist/cli.js track
        │
        ├─ transcript の「前回読んだ位置」より後ろだけを読む
        │  (message.id + requestId で重複排除。壊れた行やカーソルがあっても続行)
        ▼
 単価表(内蔵 + LiteLLMキャッシュ) × トークン数 = USD
        ▼
 USD × 為替レート(キャッシュ / 実取得 / 固定フォールバック) = JPY
        │
        ├─→ ~/.ccc-notifier/history.jsonl に1行追記
        └─→ 金額がしきい値(minNotifyUSD)以上なら OS通知 / Slack通知
```

設計上、**Claude Code 本体の動作を絶対にブロックしません**。`track` 全体が1つの try/catch で囲われており、何が起きても標準出力には何も出さず常に終了コード0を返します(失敗の詳細は `~/.ccc-notifier/error.log` にのみ記録)。Stop hookは単価表をネットワーク取得せず、キャッシュと内蔵表を読みます。為替取得・Slack送信・OS通知には個別のタイムアウトがあり、無限に待ち続けることはありません。単価キャッシュは通常の`init`、`doctor`、`sweep`でbest-effort更新します。

## hook非依存の増分取り込み(scan)/ Hook-independent incremental ingest

Claude デスクトップアプリ(macOS)やCodex Desktopは、専用のサンドボックス領域やアプリ内から利用され、上記のStop hookが発火しない、または発火が保証できないことがあります。この取りこぼしを埋めるため、ccc-notifierはhookの発火に依存しない**増分取り込み(ingest)**を持ちます。

- **`ccc-notifier scan`**: 手動実行できるコマンドです。`~/.claude/projects`(既定)に加え、macOSでは`~/Library/Application Support/Claude/local-agent-mode-sessions`配下のClaudeデスクトップサンドボックスのtranscriptも走査対象にします(存在しない場合は黙ってスキップします)。`~/.codex/sessions`配下のCodex rollout(Codex Desktop由来を含む)も同様に走査します。`--dry-run`で取り込み予定の件数・金額を確認でき、履歴は変更しません
- **track実行時の便乗り取込**: `track`(Stop hookから発火)実行のたびに、上記と同じ増分取り込みをベストエフォートで追加実行します。ファイルの更新時刻(mtime)と取り込み位置(カーソル)で未処理分だけを軽量に判定するため、hookが正常に動いているCLI利用が主な環境でも大きな負荷にはなりません。この処理が失敗しても`track`本来の記録・通知は失敗しません(失敗は`error.log`にのみ記録)
- `sweep`(全リセット再構築)とは別物で、`scan`・便乗り取込は既存の履歴を壊さない**追記型**です

取り込んだ新規ターン群の合計金額が通知しきい値(`minNotifyUSD`)以上の場合、サーフェス(利用元)・件数・合計USD/JPYをまとめた通知が1通送られます(ミュート設定は尊重されます)。取り込んだ各ターンには利用元を示す`surface`(`cli` / `desktop` / `vscode` / `claude-code` / `chrome-extension` / `other`)が記録され、`report`とダッシュボードにサーフェス別の内訳が表示されます(単一サーフェスのみの場合は表示されません)。`doctor`はデスクトップスキャンルートの検出状況・未追跡ファイル数・Codexのoriginator内訳・同一セッションが複数ルートに重複していないかを診断します。

デスクトップアプリのサンドボックス構造は非公開のため、アプリ更新でレイアウトが変わる可能性があります。走査ルートが見つからない場合は黙ってスキップされ、本体の記録・通知には影響しません。環境変数`CCCN_CLAUDE_DESKTOP_ROOTS`(パス区切り文字で複数指定可)で走査ルートを追加・上書きできます。Windows / Linuxのデスクトップアプリパスは今回未対応です(env上書きで拡張余地は残しています)。
