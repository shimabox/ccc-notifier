import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregateCodexTurn, splitIntoCodexTurnDrafts } from "../src/codex/transcript";
import type { Cursor, TokenBuckets, TurnAggregate } from "../src/types";

// 読み取り専用のゴールデン fixture。正解値は test/fixtures/codex/README.md。
// ファイルを加工するテストは一時 dir へのコピー/部分書き出しで行う(fixture を汚さない)。
const FX_BASIC = fileURLToPath(new URL("./fixtures/codex/rollout-basic.jsonl", import.meta.url));
const FX_MULTI = fileURLToPath(new URL("./fixtures/codex/rollout-multiturn.jsonl", import.meta.url));
const FX_RESET = fileURLToPath(new URL("./fixtures/codex/rollout-reset.jsonl", import.meta.url));

// ---- ヘルパー ---------------------------------------------------------------

/** Codex は cacheWrite を持たないので (input, cacheRead, output) だけで組み立てる。 */
function buckets(input: number, cacheRead: number, output: number): TokenBuckets {
  return { input, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead };
}

/** main(Codex は常に1モデル1エントリ)を全部足す。ドラフト合計 = 全体集計の検算に使う。 */
function sumMain(aggs: TurnAggregate[]): TokenBuckets {
  const total = buckets(0, 0, 0);
  for (const a of aggs) {
    for (const b of Object.values(a.main)) {
      total.input += b.input;
      total.output += b.output;
      total.cacheWrite5m += b.cacheWrite5m;
      total.cacheWrite1h += b.cacheWrite1h;
      total.cacheRead += b.cacheRead;
    }
  }
  return total;
}

// ---- suite ------------------------------------------------------------------

describe("codex transcript (aggregateCodexTurn / splitIntoCodexTurnDrafts)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cccn-codex-transcript-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. rollout-basic: README の正解値をすべて再現する。
  it("1. rollout-basic を正解値どおりに集計する", async () => {
    const r = await aggregateCodexTurn(FX_BASIC, null);
    expect(r).not.toBeNull();
    if (r === null) return;

    expect(r.main).toEqual({ "gpt-5.5": buckets(12280, 4992, 7) });
    expect(r.sidechain).toEqual({});
    expect(r.apiCalls).toBe(1);
    expect(r.prompt).toBe("1+1は？");
    expect(r.cwd).toBe("/home/user/proj-a");
    expect(r.gitBranch).toBeNull();
    expect(r.sessionId).toBe("01234567-aaaa-7000-8000-000000000001");
    expect(r.firstTs).toBe("2026-07-10T12:09:25.000Z");
    expect(r.lastTs).toBe("2026-07-10T12:09:34.000Z");
    expect(r.newCursor).toEqual({
      offset: statSync(FX_BASIC).size, // 末尾改行まで読み切っている
      lastUuid: null,
      lastTs: "2026-07-10T12:09:34.000Z",
      seenMessageKeys: [],
      codexTotals: { input: 17272, cached: 4992, output: 7 },
    });
  });

  // 2. rollout-multiturn 全体: 逐次差分で4件を積み、破損 JSON 行・info:null の token_count・
  //    response_item はスキップされる(正解値どおりならスキップできている)。
  it("2. rollout-multiturn 全体を1レコードに集約する(破損行・info:null・response_item はスキップ)", async () => {
    const r = await aggregateCodexTurn(FX_MULTI, null);
    expect(r).not.toBeNull();
    if (r === null) return;

    expect(r.main).toEqual({ "gpt-5-codex": buckets(2300, 2300, 260) }); // model はウィンドウ内最後の turn_context
    expect(r.apiCalls).toBe(4); // A/B/C/D。info:null の1件は数えない
    expect(r.prompt).toBe("ターン3です");
    expect(r.cwd).toBe("/home/user/proj-b");
    expect(r.sessionId).toBe("01234567-aaaa-7000-8000-000000000002");
    expect(r.lastTs).toBe("2026-07-10T13:02:11.000Z");
    expect(r.newCursor.offset).toBe(statSync(FX_MULTI).size);
    expect(r.newCursor.codexTotals).toEqual({ input: 4600, cached: 2300, output: 260 });
  });

  // 3. rollout-multiturn を task_complete 境界で3ターンに分割。ドラフト合計と最終カーソルは
  //    同一ウィンドウの aggregateCodexTurn と一致する(hook ↔ sweep 相互運用の不変条件)。
  it("3. rollout-multiturn を3ドラフトに分割する(合計・newCursor は aggregate と一致)", async () => {
    const drafts = await splitIntoCodexTurnDrafts(FX_MULTI, null);
    const whole = await aggregateCodexTurn(FX_MULTI, null);
    expect(drafts).not.toBeNull();
    expect(whole).not.toBeNull();
    if (drafts === null || whole === null) return;

    expect(drafts.length).toBe(3);
    const [d1, d2, d3] = drafts;

    expect(d1.agg.main).toEqual({ "gpt-5.5": buckets(600, 400, 50) });
    expect(d1.agg.prompt).toBe("ターン1です");
    expect(d1.agg.apiCalls).toBe(1);
    expect(d1.endTs).toBe("2026-07-10T13:00:06.000Z"); // task_complete がターンの終端
    expect(d1.agg.firstTs).toBe("2026-07-10T13:00:00.000Z"); // session_meta 行から

    expect(d2.agg.main).toEqual({ "gpt-5.5": buckets(1400, 1600, 150) }); // B+C の2ステップ合算
    expect(d2.agg.prompt).toBe("ターン2です");
    expect(d2.agg.apiCalls).toBe(2);
    expect(d2.endTs).toBe("2026-07-10T13:01:21.000Z");

    expect(d3.agg.main).toEqual({ "gpt-5-codex": buckets(300, 300, 60) });
    expect(d3.agg.prompt).toBe("ターン3です");
    expect(d3.agg.apiCalls).toBe(1);
    expect(d3.endTs).toBe("2026-07-10T13:02:11.000Z"); // ファイル末尾がそのまま最後のドラフトの終端

    // sessionId / cwd は全ドラフトでファイルの値
    for (const d of drafts) {
      expect(d.agg.sessionId).toBe("01234567-aaaa-7000-8000-000000000002");
      expect(d.agg.cwd).toBe("/home/user/proj-b");
      expect(d.agg.sidechain).toEqual({});
      expect(d.agg.gitBranch).toBeNull();
    }

    // 相互運用不変条件: 合計 = aggregate、最後のドラフトの newCursor = aggregate の newCursor
    expect(sumMain(drafts.map((d) => d.agg))).toEqual(buckets(2300, 2300, 260));
    expect(d3.agg.newCursor).toEqual(whole.newCursor);

    // 途中のドラフトのカーソルもそのセグメント末尾の有効な再開点(prev を持ち回る)
    expect(d1.agg.newCursor.codexTotals).toEqual({ input: 1000, cached: 400, output: 50 });
    expect(d2.agg.newCursor.codexTotals).toEqual({ input: 4000, cached: 2000, output: 200 });
  });

  // 4. rollout-reset: 負差分は last_token_usage にフォールバックし、カーソルの codexTotals は
  //    常に「最後に観測した実カウンタ」を保持する。
  it("4. rollout-reset はフォールバックで積み、カーソルは実カウンタを保持する", async () => {
    const whole = await aggregateCodexTurn(FX_RESET, null);
    expect(whole).not.toBeNull();
    if (whole === null) return;

    expect(whole.main).toEqual({ "gpt-5.5": buckets(1700, 600, 120) });
    expect(whole.apiCalls).toBe(2);
    expect(whole.prompt).toBe("リセット後");
    expect(whole.cwd).toBe("/home/user/proj-c");
    expect(whole.newCursor.codexTotals).toEqual({ input: 300, cached: 100, output: 20 });

    const drafts = await splitIntoCodexTurnDrafts(FX_RESET, null);
    expect(drafts).not.toBeNull();
    if (drafts === null) return;
    expect(drafts.length).toBe(2);
    const [d1, d2] = drafts;
    expect(d1.agg.main).toEqual({ "gpt-5.5": buckets(1500, 500, 100) });
    expect(d1.agg.prompt).toBe("リセット前");
    expect(d2.agg.main).toEqual({ "gpt-5.5": buckets(200, 100, 20) }); // フォールバック適用後
    expect(d2.agg.prompt).toBe("リセット後");

    // 相互運用不変条件(リセットを跨いでも成立する)
    expect(sumMain(drafts.map((d) => d.agg))).toEqual(buckets(1700, 600, 120));
    expect(d2.agg.newCursor).toEqual(whole.newCursor);
  });

  // 5. カーソル継続: 1回目はファイル前半だけを書いた状態、2回目に全行を書いた状態で読む。
  //    2回目は前回カーソル(offset + codexTotals)からの差分だけが計上される。
  it("5. カーソル継続で2回目は差分のみ計上される", async () => {
    const all = readFileSync(FX_MULTI, "utf8");
    const lines = all.split("\n");
    const part1 = lines.slice(0, 6).join("\n") + "\n"; // turn1 の task_complete 行まで
    const f = join(dir, "rollout-2026-07-10T13-00-00-01234567-aaaa-7000-8000-000000000002.jsonl");

    writeFileSync(f, part1);
    const r1 = await aggregateCodexTurn(f, null);
    expect(r1).not.toBeNull();
    if (r1 === null) return;
    expect(r1.main).toEqual({ "gpt-5.5": buckets(600, 400, 50) });
    expect(r1.apiCalls).toBe(1);
    expect(r1.prompt).toBe("ターン1です");
    expect(r1.newCursor.offset).toBe(Buffer.byteLength(part1));
    expect(r1.newCursor.codexTotals).toEqual({ input: 1000, cached: 400, output: 50 });

    writeFileSync(f, all); // 全行に追記された状態
    const r2 = await aggregateCodexTurn(f, r1.newCursor);
    expect(r2).not.toBeNull();
    if (r2 === null) return;
    expect(r2.main).toEqual({ "gpt-5-codex": buckets(1700, 1900, 210) }); // B+C+D の差分のみ
    expect(r2.apiCalls).toBe(3);
    expect(r2.prompt).toBe("ターン3です");
    expect(r2.newCursor.offset).toBe(Buffer.byteLength(all));
    expect(r2.newCursor.codexTotals).toEqual({ input: 4600, cached: 2300, output: 260 });

    // 2回に分けても合計はウィンドウ全体の集計と同じ(二重計上も取りこぼしも無い)
    expect(sumMain([r1, r2])).toEqual(buckets(2300, 2300, 260));
  });

  // 6. 新規 usage が無ければ null(aggregateNewTurn と同じ意味論。カーソルは進めず、
  //    同じカーソルで読み直しても null のまま = 二重計上しない)。
  it("6. 新規 usage が無ければ null を返す", async () => {
    const r1 = await aggregateCodexTurn(FX_BASIC, null);
    expect(r1).not.toBeNull();
    if (r1 === null) return;

    expect(await aggregateCodexTurn(FX_BASIC, r1.newCursor)).toBeNull();
    expect(await splitIntoCodexTurnDrafts(FX_BASIC, r1.newCursor)).toBeNull();
    // もう一度読み直しても同じ(冪等)
    expect(await aggregateCodexTurn(FX_BASIC, r1.newCursor)).toBeNull();
  });

  // 7. ENOENT → null。offset > ファイルサイズ → 先頭からのフルリスキャン(lastTs 以前の行は
  //    スキップ)で、未計上分だけが復元される。
  it("7. ENOENT は null、offset 超過はフルリスキャン(lastTs ガード)", async () => {
    const missing = join(dir, "does-not-exist.jsonl");
    expect(await aggregateCodexTurn(missing, null)).toBeNull();
    expect(await splitIntoCodexTurnDrafts(missing, null)).toBeNull();

    const size = statSync(FX_MULTI).size;
    // (a) 全部計上済み(lastTs = 最終行)なら、リスキャンしても何も数えない
    const done: Cursor = {
      offset: size + 100,
      lastUuid: null,
      lastTs: "2026-07-10T13:02:11.000Z",
      seenMessageKeys: [],
      codexTotals: { input: 4600, cached: 2300, output: 260 },
    };
    expect(await aggregateCodexTurn(FX_MULTI, done)).toBeNull();

    // (b) turn2 まで計上済みなら、turn3 だけが差分として復元される
    const mid: Cursor = {
      offset: size + 100,
      lastUuid: null,
      lastTs: "2026-07-10T13:01:21.000Z",
      seenMessageKeys: [],
      codexTotals: { input: 4000, cached: 2000, output: 200 },
    };
    const r = await aggregateCodexTurn(FX_MULTI, mid);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.main).toEqual({ "gpt-5-codex": buckets(300, 300, 60) });
    expect(r.apiCalls).toBe(1);
    expect(r.prompt).toBe("ターン3です");
    expect(r.firstTs).toBe("2026-07-10T13:02:00.000Z"); // floor 以前の行は読んでいない
    expect(r.newCursor.offset).toBe(size);
    expect(r.newCursor.codexTotals).toEqual({ input: 4600, cached: 2300, output: 260 });
  });

  // 8. 書きかけ行(末尾 \n なし)は処理されず、オフセットはその行頭で止まる。行が完成したら
  //    次回そこから読む(完成分に usage が無ければ null)。
  it("8. 書きかけの最終行は処理せず、オフセットは行頭で止まる", async () => {
    const all = readFileSync(FX_BASIC, "utf8");
    const lines = all.split("\n");
    const head = lines.slice(0, 4).join("\n") + "\n"; // token_count 行まで完全
    const partial = lines[4].slice(0, 30); // task_complete 行の書きかけ(改行なし)
    const f = join(dir, "rollout-2026-07-10T12-09-25-01234567-aaaa-7000-8000-000000000001.jsonl");

    writeFileSync(f, head + partial);
    const r1 = await aggregateCodexTurn(f, null);
    expect(r1).not.toBeNull();
    if (r1 === null) return;
    expect(r1.main).toEqual({ "gpt-5.5": buckets(12280, 4992, 7) });
    expect(r1.lastTs).toBe("2026-07-10T12:09:33.000Z"); // 書きかけの task_complete は読んでいない
    expect(r1.newCursor.offset).toBe(Buffer.byteLength(head)); // 書きかけ行の行頭で停止

    writeFileSync(f, all); // 行が完成した(usage は増えていない)
    expect(await aggregateCodexTurn(f, r1.newCursor)).toBeNull();
  });

  // 9. task_complete がまだ無いウィンドウ(進行中/中断)は、残り全体が1ドラフトになり、
  //    カーソルは aggregate と一致する(usage を取りこぼさない)。
  it("9. task_complete が無いウィンドウは残り全体が1ドラフトになる", async () => {
    const all = readFileSync(FX_BASIC, "utf8");
    const head = all.split("\n").slice(0, 4).join("\n") + "\n"; // task_complete 行なし
    const f = join(dir, "rollout-2026-07-10T12-09-25-01234567-aaaa-7000-8000-000000000001.jsonl");
    writeFileSync(f, head);

    const drafts = await splitIntoCodexTurnDrafts(f, null);
    const whole = await aggregateCodexTurn(f, null);
    expect(drafts).not.toBeNull();
    expect(whole).not.toBeNull();
    if (drafts === null || whole === null) return;

    expect(drafts.length).toBe(1);
    expect(drafts[0].agg.main).toEqual(whole.main);
    expect(drafts[0].agg.prompt).toBe("1+1は？");
    expect(drafts[0].endTs).toBe("2026-07-10T12:09:33.000Z");
    expect(drafts[0].agg.newCursor).toEqual(whole.newCursor);
  });

  // 10. session_meta が無いファイルは、ファイル名 rollout-<ISO>-<uuid>.jsonl の uuid 部が
  //     sessionId になる(cwd は turn_context から)。
  it("10. session_meta 欠損時はファイル名の uuid 部を sessionId にする", async () => {
    const noMeta = readFileSync(FX_BASIC, "utf8").split("\n").slice(1).join("\n"); // 1行目を除去
    const f = join(dir, "rollout-2026-07-10T12-09-25-99999999-aaaa-7000-8000-000000000009.jsonl");
    writeFileSync(f, noMeta);

    const r = await aggregateCodexTurn(f, null);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.sessionId).toBe("99999999-aaaa-7000-8000-000000000009");
    expect(r.cwd).toBe("/home/user/proj-a"); // turn_context.payload.cwd 由来
    expect(r.main).toEqual({ "gpt-5.5": buckets(12280, 4992, 7) });
  });
});
