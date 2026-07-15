# GOLDEN 値(test/fixtures/transcript-basic.jsonl に対する正解値)

後続の全テストはこの値をアサートすること。

- 単価($/100万トークン):
  - claude-fable-5 = input 10 / output 50 / cacheWrite5m 12.5 / cacheWrite1h 20 / cacheRead 1.0
  - claude-haiku-4-5 = input 1 / output 5 / cacheWrite5m 1.25 / cacheWrite1h 2 / cacheRead 0.10
- fable-5(main): 100×10/1e6 + 200×50/1e6 + 10000×20/1e6 + 50000×1/1e6 = 0.001+0.01+0.2+0.05 = **0.261 USD**
- haiku-4-5(sidechain): 1000×1/1e6 + 500×5/1e6 + 2000×1.25/1e6 = 0.001+0.0025+0.0025 = **0.006 USD**
- **合計 costUSD = 0.267**(浮動小数比較は toBeCloseTo(0.267, 10) 推奨)
- 固定レート150円時 **costJPY = 40.05**
- **apiCalls = 2**(msg_A は2行あるが1件に重複排除)
- **prompt = "テスト用プロンプトです"**(tool_result 行と `<` 始まり行は対象外)
- main tokens 合算: { input:100, output:200, cacheWrite5m:0, cacheWrite1h:10000, cacheRead:50000 }
- sidechain tokens 合算: { input:1000, output:500, cacheWrite5m:2000, cacheWrite1h:0, cacheRead:0 }
- models = ["claude-fable-5","claude-haiku-4-5"]
- sessionId = "sess-1" / project(cwd) = "/tmp/proj" / gitBranch = "main"
- costByModel = `{ "claude-fable-5": 0.261, "claude-haiku-4-5": 0.006 }`(computeCost の byModel をそのまま保存。丸めない)

## サブエージェント(test/fixtures/subagent-basic.jsonl に対する正解値)

`test/fixtures/subagent-basic.jsonl` はメイン transcript の兄弟ディレクトリ
`<transcript(.jsonl除去)>/subagents/agent-*.jsonl` に置かれる1エージェント分の JSONL。
2行あるが同一 `message.id "msg_SA1"` + `requestId "req_SA1"` のため 1 件に重複排除される。

- 単価($/100万トークン): claude-sonnet-4-6 = input 3 / output 15 / cacheWrite5m 3.75 / cacheWrite1h 6 / cacheRead 0.30
- SA usage 合算: { input:1000, output:2000, cacheWrite5m:0, cacheWrite1h:0, cacheRead:0 }
- **SA コスト = 1000×3/1e6 + 2000×15/1e6 = 0.003 + 0.030 = 0.033 USD**(claude-sonnet-4-6)
- **apiCalls = 1**(msg_SA1 は2行あるが1件に重複排除)
- record.subagents = `{ costUSD: 0.033, costByModel: { "claude-sonnet-4-6": 0.033 }, tokens: {input:1000,output:2000,...0}, apiCalls: 1, agentFiles: 1 }`
- メイン(transcript-basic.jsonl)と合わせた**総額 = 0.267 + 0.033 = 0.300 USD**
- 固定レート150円時の SA 分 JPY = 0.033 × 150 = 4.95(表示は ¥5)、総額 JPY = 40.05 + 4.95 = 45.0(表示は ¥45)
- **通知金額はメインのみ(0.267)** — SA は通知に混入しない(通知は一切変えない)

## sweep 用マルチターン(test/fixtures/transcript-multiturn.jsonl に対する正解値)

実プロンプト2ターン構成(先行プロンプトあり)。sweep はこれを **ターン単位** に分割して取り込む
(track/aggregateNewTurn は窓を1レコードに集約するのに対し、sweep は境界=実ユーザープロンプト行で分割)。

- ターン1: prompt "ターン1のプロンプト" / assistant `msg_M1`+`req_M1` claude-fable-5 output 100 →
  100×50/1e6 = **0.005 USD** / ts = 2026-07-06T10:00:05.000Z(= lastTs)
- ターン2: prompt "ターン2のプロンプト" / assistant `msg_M2`+`req_M2` claude-sonnet-4-6 output 1000 →
  1000×15/1e6 = **0.015 USD** / ts = 2026-07-06T10:01:05.000Z
- **sweep 合計 = 0.005 + 0.015 = 0.020 USD**(summary.totalUSD)。両レコードとも `ingest: "sweep"`。
- subagent-basic.jsonl を併用(`<main>/subagents/agent-x.jsonl`)した場合、**最終ターン(ターン2)の record に
  SA 0.033**(claude-sonnet-4-6 / apiCalls 1 / agentFiles 1)が `subagents` ブロックとして添付される。
  SA は summary.totalUSD(0.020)には**含めない**(GOLDEN のメイン基準)。SA 回収額は
  **summary.subagentsUSD = 0.033** として別枠で集計され、コンソールに
  「うちサブエージェント: $0.033(¥5)」(固定レート150円時)と1行表示される。
- splitIntoTurnDrafts の newCursor は、同一ウィンドウに対する aggregateNewTurn の newCursor と互換
  (seenMessageKeys = `["msg_M1:req_M1","msg_M2:req_M2"]`、offset = ファイル末尾)。hook ↔ sweep は
  互いのカーソルを尊重し、二重計上しない。
