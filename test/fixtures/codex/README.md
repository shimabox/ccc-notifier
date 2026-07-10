# Codex フィクスチャの正解値

後続タスク(T2: `src/codex/env.ts` / `src/codex/transcript.ts` 等)のテストはこの値をアサートすること。
逐次ステップ差分方式・TokenBuckets 写像・モデル/プロンプト/cwd 抽出規約は
`.claude/plans/2026-07-10-codex-implementation-orchestration.md` §4-3(および `src/contracts.md`
「2026-07-10 追加: Codex CLI 対応」節)を参照。

すべて `cursor = null`(初回・全体)から読んだ場合の値。浮動小数比較は `toBeCloseTo(x, 10)` 推奨。

## rollout-basic.jsonl(1ターン)

- `session_meta.payload.session_id` = `01234567-aaaa-7000-8000-000000000001`
- token_count は1回のみ(total = last):`{input_tokens:17272, cached_input_tokens:4992, output_tokens:7}`
- 逐次差分: `prev={0,0,0}` → `step = total - prev = total`(負なし)→ `acc = {input:17272, cached:4992, output:7}`
- TokenBuckets 写像: `input = max(0, 17272-4992) = 12280` / `cacheRead = 4992` / `output = 7` /
  `cacheWrite5m = cacheWrite1h = 0`
- 単価(gpt-5.5): input $5/M, output $30/M, cacheRead $0.5/M
- costUSD = `12280×5e-6 + 4992×0.5e-6 + 7×30e-6` = `0.0614 + 0.002496 + 0.00021` = **0.064106**
- model = `gpt-5.5`(turn_context 由来)/ prompt = `"1+1は？"` / cwd = `/home/user/proj-a`
- apiCalls = **1**(token_count 1件・info あり・step≠0)
- newCursor.codexTotals = `{input:17272, cached:4992, output:7}`(= 最後に観測した total_token_usage)

## rollout-multiturn.jsonl(3ターン・累積カウンタ増加)

3ターン構成。turn2 は token_count が2回(間に破損 JSON 行 `{{{this line is intentionally corrupt json`
を挟む)。turn3 は先頭に `info:null` の token_count(スキップ対象)を挟んでから実カウンタが来る。

### aggregateCodexTurn(ウィンドウ全体を1レコードに集約した場合)

逐次差分を4件の有効な token_count(info あり)に順に適用:

| # | total_token_usage | prev(直前) | step | acc(累積) |
|---|---|---|---|---|
| A(turn1) | {1000,400,50} | {0,0,0} | {1000,400,50} | {1000,400,50} |
| B(turn2-1) | {2500,1200,120} | {1000,400,50} | {1500,800,70} | {2500,1200,120} |
| (破損行はスキップ・prev/acc に影響なし) | | | | |
| C(turn2-2) | {4000,2000,200} | {2500,1200,120} | {1500,800,80} | {4000,2000,200} |
| (turn3 の `info:null` はスキップ・prev/acc に影響なし) | | | | |
| D(turn3) | {4600,2300,260} | {4000,2000,200} | {600,300,60} | {4600,2300,260} |

- 最終 acc = `{input:4600, cached:2300, output:260}`
- TokenBuckets = `{input: max(0,4600-2300)=2300, cacheRead:2300, output:260, cacheWrite5m:0, cacheWrite1h:0}`
- model(ウィンドウ内最後の turn_context)= `gpt-5-codex`(turn3 の turn_context)
- apiCalls = **4**(A/B/C/D。`info:null` の1件はカウントしない)
- newCursor.codexTotals = `{input:4600, cached:2300, output:260}`

### splitIntoCodexTurnDrafts(task_complete 境界でターン分割・prev はセグメントを跨いで持ち回る)

| ターン | acc | TokenBuckets | model |
|---|---|---|---|
| t1 | {1000,400,50} | `{input:600, cacheRead:400, output:50}` | gpt-5.5 |
| t2 | {3000,1600,150}(B+C の2ステップ合算) | `{input:1400, cacheRead:1600, output:150}` | gpt-5.5 |
| t3 | {600,300,60} | `{input:300, cacheRead:300, output:60}` | gpt-5-codex |

- 検算: 各ターンの TokenBuckets 合計 = ウィンドウ全体の TokenBuckets(input 600+1400+300=2300 /
  cacheRead 400+1600+300=2300 / output 50+150+60=260)— hook ↔ sweep 相互運用の一致点
- prompt: t1=`"ターン1です"` / t2=`"ターン2です"` / t3=`"ターン3です"`
- endTs: t1=`2026-07-10T13:00:06.000Z`(task_complete)/ t2=`2026-07-10T13:01:21.000Z` /
  t3=`2026-07-10T13:02:11.000Z`(ファイル末尾がそのまま最後のドラフトの終端)

## rollout-reset.jsonl(2ターン・途中でリセット=負差分)

- turn1: token_count total=last=`{input:2000, cached:500, output:100}`。`prev={0,0,0}` からの通常差分
  → `step = {2000,500,100}`(負なし)→ `acc_t1 = {2000,500,100}`、`prev` 更新後 `{2000,500,100}`
- turn2: token_count total=`{input:300, cached:100, output:20}`(カウンタリセット)。
  `step = total - prev = {-1700,-400,-80}` → 成分に負あり → **フォールバック**: `step = last_token_usage
  = {300,100,20}`
- acc(ウィンドウ全体) = `acc_t1 + step_t2 = {2300,600,120}`
- TokenBuckets = `{input: max(0,2300-600)=1700, cacheRead:600, output:120, cacheWrite5m:0, cacheWrite1h:0}`
- **newCursor.codexTotals = `{input:300, cached:100, output:20}`**
  (= turn2 の `info.total_token_usage` そのもの。フォールバックが発生してもここは常に
  「最後に観測した実カウンタ」を保持する — 次回の差分計算はこの値を `prev` として再開する)
- prompt(最後)= `"リセット後"` / model = `gpt-5.5` / cwd = `/home/user/proj-c`

### splitIntoCodexTurnDrafts

| ターン | acc | TokenBuckets |
|---|---|---|
| t1 | {2000,500,100} | `{input:1500, cacheRead:500, output:100}` |
| t2 | {300,100,20}(フォールバック適用後) | `{input:200, cacheRead:100, output:20}` |

- 検算: t1+t2 の TokenBuckets 合計 = ウィンドウ全体(input 1500+200=1700 / cacheRead 500+100=600 /
  output 100+20=120)
- prompt: t1=`"リセット前"` / t2=`"リセット後"`

## stop-payload.json

実機捕獲の Codex Stop hook stdin を無害化したもの(パス・uuid をプレースホルダ化)。
`session_id` / `turn_id` は `rollout-basic.jsonl` の session_meta / turn_context と対応させてある
(このフィクスチャの `track --codex` 入力として使う想定。`transcript_path` は実ファイルではないため、
テスト側で `rollout-basic.jsonl` 等を任意の一時パスにコピーしてから読ませること)。

- `model` = `gpt-5.5`(hook payload 優先のテストに使う。transcript 側の turn_context.model と
  一致させてあるため、優先関係を区別したいテストは payload 側を別値に差し替えて使うこと)
- `last_assistant_message` = `"2です。"`
