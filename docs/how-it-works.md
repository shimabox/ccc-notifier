# 仕組み / How it Works

[← README に戻る](../README.md)

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
