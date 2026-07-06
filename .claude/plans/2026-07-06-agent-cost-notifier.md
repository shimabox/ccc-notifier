# agent-cost-notifier 実装プラン

- 作成日: 2026-07-06
- ステータス: レビュー待ち(承認後 Phase 1 着手)
- 結論: **実現可能。** Claude Code の Stop hook + transcript(JSONL)+ 料金表の組み合わせで、1プロンプト実行ごとのコスト通知(ドル/円)・履歴蓄積・HTML可視化がすべて実現できる。

---

## 1. 課題とゴール

| 要求 | 本プランでの実現方法 |
|---|---|
| 1プロンプト実行ごとにコストを知りたい | Stop hook(毎ターン発火)で自動計算して通知 |
| ドルと円の両方 | 為替レートを自動取得して併記 |
| どの場面・どのモデル・どんなプロンプトか | transcript から プロジェクト / モデル / プロンプト全文 を記録 |
| 履歴が溜まり、簡単にビジュアライズ | ローカル履歴 + `dashboard` コマンドで自己完結HTMLレポート生成 |
| 誰でも設定できる / Mac・Windows 両対応 | `npx agent-cost-notifier init` の一発セットアップ(Node.js製) |
| わかりやすさ | 通知は1行で要点、レポートはグラフ中心、README は5分で導入完了する構成 |

### ヒアリング済みの決定事項

| 論点 | 決定 |
|---|---|
| 課金形態 | 混在 / わからない → 金額ラベルを設定で切替(デフォルト「API換算額」表記。サブスクでも「もしAPIならいくら」が分かる) |
| 通知先 | **OS通知(デフォルト・設定不要)+ Slack(Webhook設定した人だけ有効)** |
| 実装技術 | **Node.js 20+ / TypeScript**、npm で配布(`npx` 一発導入) |
| 可視化 | **自己完結HTMLレポート**(サーバ不要・ファイルとして保存/共有可能) |

---

## 2. 実現可能性の検証結果(2026-07-06 実施)

### 検証1: transcript にコスト計算の材料が揃っている ✅(この環境の実データで確認)

`~/.claude/projects/<プロジェクト>/<セッションID>.jsonl` の assistant 行に以下が記録されている:

```jsonc
{
  "type": "assistant",
  "requestId": "req_011Cck...",
  "message": {
    "id": "msg_013WjV...",
    "model": "claude-fable-5",
    "usage": {
      "input_tokens": 2,                        // キャッシュ外の入力
      "cache_creation_input_tokens": 319035,    // キャッシュ書込
      "cache_creation": {
        "ephemeral_1h_input_tokens": 319035,    // 1時間TTL(単価が5分TTLと異なる)
        "ephemeral_5m_input_tokens": 0
      },
      "cache_read_input_tokens": 23113,         // キャッシュ読取
      "output_tokens": 3697
    }
  },
  "cwd": "...", "gitBranch": "...", "isSidechain": false, "timestamp": "..."
}
```

- コストの直接記録(costUSD)は無い → **トークン数 × 単価で計算する**(定番ツール ccusage と同方式)
- ⚠️ 同一メッセージが複数行に重複して現れることを実データで確認 → **`message.id` + `requestId` での重複排除が必須**
- ⚠️ `input_tokens` が極小(例: 2)に見えるのは仕様。実効入力 = input + cache_creation + cache_read の合算。単価がバケットごとに違うので**バケット別に計算すれば正確**
- user 行にはプロンプト全文・timestamp・cwd がある → 「どんなプロンプトか」を記録できる

### 検証2: Stop hook が「1プロンプト実行ごと」のトリガーになる ✅(公式ドキュメントで確認)

- Stop hook は **ユーザープロンプト → 応答完了 のサイクルごとに1回発火**
- stdin の JSON で `session_id` / `transcript_path` / `cwd` / `hook_event_name` を受け取れる
- `~/.claude/settings.json`(ユーザーレベル)に設定すれば**全プロジェクトで有効**
- Windows: shell 形式の hook は Git Bash(デフォルト)/ PowerShell で実行される → 対応可能
- ⚠️ hook が **exit code 2 を返すと「応答の停止をブロック」する意味になる** → 本ツールは何があっても exit 0(後述のフェイルセーフ設計)

### 検証3: 既存機能では足りない(= 作る意義がある)✅

| 既存手段 | ターン毎通知 | 円表示 | プロンプト記録 | 履歴可視化 | 導入の手軽さ |
|---|---|---|---|---|---|
| `/cost` `/usage` コマンド | ✗(セッション合計のみ) | ✗ | ✗ | ✗ | ◎ |
| statusline(cost.total_cost_usd) | ✗(累計表示のみ) | △(自作すれば) | ✗ | ✗ | ○ |
| OpenTelemetry(claude_code.cost.usage) | △ | ✗ | △(OTEL_LOG_USER_PROMPTS=1) | △(Grafana等が別途必要) | ✗(Collector構築が必要) |
| ccusage(OSS) | ✗(日次/セッション集計) | ✗ | ✗ | △(CLI表) | ◎ |
| **本ツール** | **◎** | **◎** | **◎(全文+検索)** | **◎(HTMLレポート)** | **◎(init一発)** |

公式ドキュメント上も「ターン毎のコスト通知」に相当する組み込み機能は存在しない。

### 参考: 実測例(このセッションの直近1 APIコール)

Fable 5 / キャッシュ書込(1h) 319,035 tok + キャッシュ読取 23,113 tok + 出力 3,697 tok
→ **約 $6.59 ≒ 約 ¥988**(1ドル150円換算)。こういう「思ったより高い1回」を即座に可視化するのが本ツールの価値。

---

## 3. アーキテクチャ

```
┌─ Claude Code ────────────────────────────────────┐
│  プロンプト実行 → 応答完了                        │
│        │ Stop hook(ターンごとに発火)             │
└────────┼─────────────────────────────────────────┘
         ▼ stdin: { session_id, transcript_path, cwd, ... }
┌─ agent-cost-notifier track ──────────────────────┐
│ 1. transcript の「前回処理位置以降」の行を読む    │
│ 2. message.id + requestId で重複排除して集計      │
│ 3. モデル別単価表 × トークン = USD                │
│ 4. 為替レート(キャッシュ付き)で JPY 併記         │
│ 5. 履歴に1行追記                                  │
│ 6. 通知送信(しきい値未満はスキップ可)            │
│    ※ 全処理 try/catch、必ず exit 0               │
└──────┬───────────────────┬───────────────────────┘
       ▼                   ▼
  OS通知               Slack Incoming Webhook
  (Mac: terminal-notifier / Win: トースト。node-notifier同梱で追加導入不要)

  ~/.agent-cost-notifier/history.jsonl(1ターン=1行、ローカルのみ)
       │
       ▼  npx agent-cost-notifier dashboard
  自己完結 HTML レポート生成 → ブラウザで自動オープン
```

---

## 4. 機能仕様

### 4.1 コスト計算エンジン

**単価表(2026-07 時点、$/100万トークン)** — 実装時はこの内蔵テーブル + LiteLLM 公開料金 JSON の自動マージ(下記)

| モデル | 入力 | 出力 | キャッシュ書込 5m (×1.25) | キャッシュ書込 1h (×2) | キャッシュ読取 (×0.1) |
|---|---|---|---|---|---|
| claude-fable-5 / mythos-5 | 10.00 | 50.00 | 12.50 | 20.00 | 1.00 |
| claude-opus-4-8 / 4-7 / 4-6 / 4-5 | 5.00 | 25.00 | 6.25 | 10.00 | 0.50 |
| claude-sonnet-5 ※ | 3.00 | 15.00 | 3.75 | 6.00 | 0.30 |
| claude-sonnet-4-6 / 4-5 | 3.00 | 15.00 | 3.75 | 6.00 | 0.30 |
| claude-haiku-4-5 | 1.00 | 5.00 | 1.25 | 2.00 | 0.10 |
| claude-opus-4-1 / 4-0 | 15.00 | 75.00 | 18.75 | 30.00 | 1.50 |

※ Sonnet 5 は 2026-08-31 まで導入価格($2/$10)あり — 単価表を日付条件付きにする
※ Claude Code は 1時間TTLキャッシュを使用(実データで `ephemeral_1h_input_tokens` を確認)。5m/1h を区別して計算する

- **計算式**: `cost = input×単価 + output×単価 + cacheWrite5m×単価 + cacheWrite1h×単価 + cacheRead×単価`
- **単価の鮮度維持**: 起動時に LiteLLM の公開料金 JSON(ccusage と同じソース)を取得して内蔵テーブルにマージ。24時間キャッシュ、取得失敗時は内蔵テーブルにフォールバック。未知モデルは前方一致で推定し、通知に「単価未確認」マークを付ける
- **重複排除**: `(message.id, requestId)` ごとに最後の行を採用(実データで同一メッセージ3行重複を確認済み)
- **ターン境界**: `cursors.json` に transcript ごとの処理済み最終 uuid を保存。Stop 発火時に新規行のみ処理 → 再実行しても二重計上しない(冪等)
- **サブエージェント**: `isSidechain: true` の行も同ターンに合算(履歴には内訳を保持)
- **精度の自己検証**: statusline が受け取る `cost.total_cost_usd`(Claude Code 自身の推定)とセッション合計を突合する `doctor` チェックを用意

### 4.2 通知

**OS通知(デフォルト)** — node-notifier を使用。Mac は terminal-notifier、Windows は SnoreToast が同梱されるため**ユーザー側の追加インストール不要**

```
💰 $0.42(¥63)| Fable 5
in 342.1k(cache 95%)/ out 3.7k
「READMEのセットアップ手順を書き直して…」
📁 agent-cost-notifier
```

**Slack(オプション)** — Incoming Webhook URL を設定した場合のみ。Block Kit でリッチ表示。プロンプトはデフォルト先頭100字(全文送信は opt-in。外部送信なので慎重に)

**共通設定**
- 通知しきい値: 例 `minNotifyUSD: 0.01`(細かすぎる通知を抑制)
- 金額ラベル: `costLabel: "api_equivalent" | "actual"` → 表示が「API換算 $0.42」/「$0.42」に変わる(混在環境向け)
- 日次累計の併記: `today: $3.20` を通知末尾に付加(オプション)

**フェイルセーフ(最重要)**: 通知失敗・パース失敗・ネットワーク断でも Claude Code の動作を一切妨げない。全体を try/catch し **常に exit 0**、エラーは `~/.agent-cost-notifier/error.log` へ。タイムアウトも hook 設定で 15s 程度に制限

### 4.3 為替(USD→JPY)

1. frankfurter.dev(ECB公表、APIキー不要)
2. 失敗時 → open.er-api.com(キー不要)
3. 失敗時 → 前回取得のキャッシュ値
4. それも無ければ → 設定の固定レート(デフォルト 150)

12時間キャッシュ。**履歴レコードに適用レートを保存**する(後から見ても当時の円額が再現できる)

### 4.4 履歴ストア

`~/.agent-cost-notifier/history.jsonl`(1ターン = 1行、追記のみ)

```jsonc
{
  "ts": "2026-07-06T12:30:00Z",
  "sessionId": "d2a452fe-...",
  "project": "/Users/.../agent-cost-notifier",   // 「どの場面か」
  "gitBranch": "main",
  "models": ["claude-fable-5"],
  "tokens": { "input": 2, "output": 3697, "cacheWrite5m": 0, "cacheWrite1h": 319035, "cacheRead": 23113 },
  "sidechainTokens": { ... },                     // サブエージェント分の内訳
  "costUSD": 6.5887,
  "costJPY": 988,
  "fxRate": 150.0,
  "prompt": "READMEのセットアップ手順を…(全文)",   // ローカルのみに保存
  "schemaVersion": 1
}
```

プライバシー方針: プロンプト全文は**ローカルにのみ**保存。外部(Slack)へは要約のみがデフォルト。

### 4.5 ビジュアライズ: `dashboard` コマンド

`npx agent-cost-notifier dashboard [--days 30]` → `report.html` を生成してブラウザで自動オープン

- **サマリーカード**: 今日 / 今週 / 今月 / 累計($と¥併記)
- **日別コスト棒グラフ**(モデル別積み上げ)+ 累積線
- **モデル別・プロジェクト別の内訳表**(どの場面で使ったかが一目で分かる)
- **ターン履歴テーブル**: 時刻 / プロジェクト / モデル / トークン / $ / ¥ / プロンプト冒頭。行クリックで全文展開、テキスト検索ボックス付き
- 実装: 履歴データを JSON として HTML に埋め込み、チャートライブラリもインライン化 → **1ファイル完結・オフラインOK・共有可能**
- 補助として `report` コマンド(ターミナルに日別/モデル別の表を出す軽量版)も用意

### 4.6 セットアップ体験(「誰でも設定できる」の核心)

```
npx agent-cost-notifier@latest init
```

対話ウィザードが以下を実施:
1. 通知チャネル選択(OS通知のみ / +Slack → Webhook URL 入力)
2. 金額ラベル(API換算 / 実費)・固定為替レートの設定
3. `~/.claude/settings.json` に Stop hook を**マージ書き込み**(既存の hooks・statusline を壊さない。書き込み前にバックアップ作成)
4. テスト通知を送信して動作確認

- hook コマンドは `npx ...` ではなく **init が解決した絶対パスの node 実行**にする(npx はコールドスタートが数秒かかり毎ターン走るには遅い)
- Windows は shell 形式 hook(Git Bash / PowerShell)で動くようコマンド文字列を OS 検知して出し分け
- `npx agent-cost-notifier doctor`: hook 登録確認 / transcript 読み取り確認 / 通知テスト / statusline 突合 / 単価表の鮮度チェック
- `uninstall` コマンドで hook をクリーンに除去

### 4.7 設定ファイル

`~/.agent-cost-notifier/config.json`

```jsonc
{
  "notify": { "os": true, "slack": { "webhookUrl": "", "promptChars": 100 } },
  "minNotifyUSD": 0,
  "costLabel": "api_equivalent",       // "actual" に切替可
  "fx": { "fallbackRate": 150, "cacheHours": 12 },
  "includeDailyTotal": true
}
```

---

## 5. 技術選定

| 項目 | 選定 | 理由 |
|---|---|---|
| ランタイム | Node.js 20+(TypeScript) | Claude Code 利用者の保有率・クロスプラットフォーム・npx 配布 |
| OS通知 | node-notifier | Mac/Win のネイティブ通知を追加インストールなしで(バイナリ同梱) |
| ビルド | esbuild/tsup で単一JSにバンドル | 起動高速化(毎ターン実行されるため重要)・依存トラブル回避 |
| テスト | vitest + 実 transcript 断片の fixture | 集計ロジック(重複排除・カーソル)の回帰防止 |
| 配布 | npm(bin: `agent-cost-notifier`, 短縮 `acn`) | `npx` 一発。将来 Homebrew 等は任意 |

依存は最小限(node-notifier + CLI補助程度)。チャートライブラリはビルド時に HTML テンプレートへインライン化。

---

## 6. 実装フェーズ

### Phase 1 — MVP(コア価値: ターン毎のOS通知)
- [ ] transcript パーサ(カーソル管理・message.id 重複排除・sidechain 合算)
- [ ] 料金計算(内蔵単価表・5m/1h キャッシュ区別)
- [ ] `track`(Stop hook エントリ、フェイルセーフ、error.log)
- [ ] OS通知(Mac/Win)
- [ ] history.jsonl 追記
- [ ] `init`(settings.json マージ・バックアップ・テスト通知)/ `doctor` / `uninstall`
- [ ] 為替は固定レート(150)でまず動かす

**受け入れ基準**: Mac でプロンプト実行ごとに通知が出て $・¥ が表示される。`doctor` の statusline 突合で誤差が概ね数%以内。hook 起因で Claude Code が遅延・ブロックしない(track 実行 < 1秒)

### Phase 2 — Slack・為替・Windows
- [ ] Slack Incoming Webhook 通知(Block Kit、プロンプト100字)
- [ ] 為替ライブ取得(frankfurter → er-api → キャッシュ → 固定値)
- [ ] 通知しきい値・日次累計併記
- [ ] LiteLLM 料金 JSON の自動マージ
- [ ] Windows 動作確認(GitHub Actions の windows-latest + 可能なら実機)

**受け入れ基準**: Slack に同内容が届く。オフラインでも通知が壊れない(フォールバック動作)

### Phase 3 — ビジュアライズ
- [ ] `dashboard`(自己完結HTML: サマリー/日別グラフ/内訳/検索付き履歴テーブル)※ 実装時に dataviz スキル適用
- [ ] `report`(CLI 表)

**受け入れ基準**: コマンド一発でブラウザが開き、「いつ・どの場面で・どのモデルに・どんなプロンプトで・いくら」が確認できる

### Phase 4 — あると嬉しい(任意)
- [ ] 予算アラート(日次/月次のしきい値超過で警告通知)
- [ ] statusline 統合(現在セッション累計を ¥ でステータスバー常時表示)
- [ ] 週次サマリの Slack 自動投稿 / CSV エクスポート
- [ ] README 英語版・OSS 公開整備(npm publish)

---

## 7. リスクと対策

| リスク | 対策 |
|---|---|
| transcript 形式は非公式で将来変わりうる | 使用フィールドを最小限に限定。`schemaVersion` と `doctor` で異常検知。ccusage 等と同じデータソースなのでエコシステムの追随情報が早い |
| 単価の改定・新モデル登場 | LiteLLM 自動マージ + 内蔵フォールバック + 未知モデル警告 |
| hook が Claude Code を妨げる事故 | 常に exit 0 / タイムアウト設定 / 全例外捕捉(exit 2 は「停止ブロック」の意味になるため絶対に返さない) |
| Stop 多重発火・セッション再開での二重計上 | カーソル + message.id 重複排除で冪等 |
| サブスク利用者にとって金額が誤解を招く | デフォルトで「API換算」ラベルを明示(設定で切替) |
| 通知疲れ | しきい値 `minNotifyUSD` とサマリーモード |
| プロンプトの機微情報が外部に出る | 全文はローカルのみ。Slack は要約デフォルト・全文は opt-in |
| npx のコールドスタートが遅い | hook には絶対パスの node 実行を登録(init が解決) |

---

## 8. リポジトリ構成案

```
agent-cost-notifier/
├── src/
│   ├── cli.ts              # コマンド分岐 (track / init / doctor / dashboard / report / uninstall)
│   ├── track.ts            # Stop hook エントリポイント(フェイルセーフ境界)
│   ├── transcript.ts       # JSONL パース・カーソル・重複排除・ターン集計
│   ├── pricing.ts          # 単価表 + LiteLLM マージ
│   ├── fx.ts               # 為替取得・キャッシュ
│   ├── notify/os.ts        # node-notifier
│   ├── notify/slack.ts     # Incoming Webhook
│   ├── store.ts            # history.jsonl / config.json / cursors.json
│   ├── dashboard/          # HTMLテンプレート・データ埋め込み
│   └── setup.ts            # ~/.claude/settings.json マージ・バックアップ
├── test/                   # vitest + transcript fixtures
├── package.json            # bin: agent-cost-notifier, acn
└── README.md               # 5分で導入できる手順(スクショ付き)
```

---

## 9. 未決事項(実装中に確認)

- npm パッケージ名 `agent-cost-notifier` の空き確認(取れなければ `@shimabox/agent-cost-notifier`)
- Fable 5 の `[1m]`(長文コンテキスト)利用時の単価差の有無 — 実装時に最新料金ドキュメントで確認
- Slack 通知を 1セッション=1スレッドに集約するか(まずはフラット投稿で開始)
- Stop hook の `async` オプション(非ブロック実行)が安定利用できるか — 使えれば体感ゼロ遅延にできる

---

## 付録: 本日の検証ログ

- 実 transcript(このセッション)で `message.model` / `message.usage`(5m/1h キャッシュ内訳含む)/ プロンプト全文 / `cwd` / `isSidechain` / 同一 `message.id` の複数行重複を確認
- 公式ドキュメント(code.claude.com/docs)で Stop hook の発火タイミング・stdin ペイロード・ユーザーレベル settings.json・Windows での実行形態(Git Bash / PowerShell)・exit code 2 の意味・statusline の `cost.total_cost_usd` を確認
- 組み込みの「ターン毎コスト通知」機能は存在しないことを確認(/cost・/usage はセッション合計、OTel は要 Collector)
- 単価は Anthropic 公式料金(2026-07 時点)を取得済み。キャッシュ書込 5分=入力×1.25 / 1時間=入力×2、読取=×0.1
