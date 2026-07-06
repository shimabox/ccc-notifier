// test/sweep.test.ts — sweep(過去分の一括回収)の単体/結合テスト。
//
// 契約: src/contracts.md の "src/sweep.ts(2026-07-07 追加)"、GOLDEN 値は
// test/fixtures/GOLDEN.md(transcript-multiturn.jsonl / subagent-basic.jsonl)を参照。
//
// 一時 ACN_HOME + 一時 projects ルート(--projects かつ ACN_CLAUDE_PROJECTS で指定)に
//   projA/t1.jsonl                     … multiturn fixture(実プロンプト2ターン)
//   projA/t1/subagents/agent-x.jsonl   … subagent fixture(SA 0.033)
// を配置して検証する。実データ(~/.claude)には一切触れない。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatJPY, formatUSD } from "../src/format";
import { runSweep } from "../src/sweep";
import { runTrack } from "../src/track";
import type { TurnRecord } from "../src/types";

const FIXTURE_MULTITURN = fileURLToPath(new URL("./fixtures/transcript-multiturn.jsonl", import.meta.url));
const FIXTURE_SUBAGENT = fileURLToPath(new URL("./fixtures/subagent-basic.jsonl", import.meta.url));

let tmpHome: string;
let projectsRoot: string;
let mainPath: string; // projA/t1.jsonl
let saPath: string; // projA/t1/subagents/agent-x.jsonl
let prevHome: string | undefined;
let prevProjects: string | undefined;
let prevDryRun: string | undefined;

beforeEach(() => {
  prevHome = process.env.ACN_HOME;
  prevProjects = process.env.ACN_CLAUDE_PROJECTS;
  prevDryRun = process.env.ACN_DRY_RUN;

  tmpHome = mkdtempSync(join(tmpdir(), "acn-sweep-home-"));
  projectsRoot = mkdtempSync(join(tmpdir(), "acn-sweep-projects-"));
  process.env.ACN_HOME = tmpHome;
  process.env.ACN_CLAUDE_PROJECTS = projectsRoot;
  process.env.ACN_DRY_RUN = "1"; // track の通知は last-notify.json へ

  // 実ネットワークに出ない保険。単価は builtin、fx は fixed(150)にフォールバックし決定的になる。
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

  mainPath = join(projectsRoot, "projA", "t1.jsonl");
  saPath = join(projectsRoot, "projA", "t1", "subagents", "agent-x.jsonl");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(projectsRoot, { recursive: true, force: true });

  if (prevHome === undefined) delete process.env.ACN_HOME;
  else process.env.ACN_HOME = prevHome;
  if (prevProjects === undefined) delete process.env.ACN_CLAUDE_PROJECTS;
  else process.env.ACN_CLAUDE_PROJECTS = prevProjects;
  if (prevDryRun === undefined) delete process.env.ACN_DRY_RUN;
  else process.env.ACN_DRY_RUN = prevDryRun;
});

// ---- helpers --------------------------------------------------------------

/** projA/t1.jsonl(+ 任意で SA)を配置する。 */
function placeFixtures(opts: { withSA: boolean }): void {
  mkdirSync(join(projectsRoot, "projA"), { recursive: true });
  copyFileSync(FIXTURE_MULTITURN, mainPath);
  if (opts.withSA) {
    mkdirSync(join(projectsRoot, "projA", "t1", "subagents"), { recursive: true });
    copyFileSync(FIXTURE_SUBAGENT, saPath);
  }
}

function historyFile(): string {
  return join(tmpHome, "history.jsonl");
}
function cursorsFile(): string {
  return join(tmpHome, "cursors.json");
}

function readHistory(): TurnRecord[] {
  if (!existsSync(historyFile())) return [];
  return readFileSync(historyFile(), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TurnRecord);
}

/** console.log を spy して runSweep を実行し、code と連結出力を返す。 */
async function sweep(args: string[]): Promise<{ code: number; output: string }> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const code = await runSweep(["--projects", projectsRoot, ...args]);
    const output = spy.mock.calls.map((a) => a.map((x) => String(x)).join(" ")).join("\n");
    return { code, output };
  } finally {
    spy.mockRestore();
  }
}

/** stop-hook 相当の stdin(transcript_path を mainPath にした JSON)。 */
function stdinForMain(): string {
  return JSON.stringify({
    session_id: "sess-M",
    transcript_path: mainPath,
    cwd: "/tmp/proj",
    hook_event_name: "Stop",
  });
}

// 新しい SA 行(別 message.id / requestId)。sonnet-5 output 1000 → 0.015 USD。
const NEW_SA_LINE = JSON.stringify({
  parentUuid: "sa2",
  isSidechain: true,
  cwd: "/tmp/proj",
  sessionId: "sess-M",
  gitBranch: "main",
  type: "assistant",
  requestId: "req_SA2",
  message: {
    id: "msg_SA2",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: "追加のサブエージェント応答" }],
    usage: {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    },
  },
  uuid: "sa3",
  timestamp: "2026-07-06T10:05:10.000Z",
});

// ---- suite ----------------------------------------------------------------

describe("runSweep", () => {
  // 1. fresh sweep: 2 レコード(GOLDEN 一致・両方 ingest:'sweep')、2件目に SA 0.033、totalUSD ≈ 0.020。
  it("1. fresh sweep records two turn records (GOLDEN) with SA attached to the last one", async () => {
    placeFixtures({ withSA: true });

    const { code, output } = await sweep([]);
    expect(code).toBe(0);
    expect(output).toContain("2 ターン");

    const rows = readHistory();
    expect(rows).toHaveLength(2);

    // ターン1: fable output100 → 0.005
    const t1 = rows[0];
    expect(t1.prompt).toBe("ターン1のプロンプト");
    expect(t1.ts).toBe("2026-07-06T10:00:05.000Z");
    expect(t1.models).toEqual(["claude-fable-5"]);
    expect(t1.costUSD).toBeCloseTo(0.005, 10);
    expect(t1.costJPY).toBeCloseTo(0.75, 10); // 0.005 × 150
    expect(t1.fxRate).toBe(150);
    expect(t1.ingest).toBe("sweep");
    expect(t1.sessionId).toBe("sess-M");
    expect(t1.project).toBe("/tmp/proj");
    expect(t1.gitBranch).toBe("main");
    expect(t1.apiCalls).toBe(1);
    expect(t1.subagents).toBeUndefined();

    // ターン2: sonnet output1000 → 0.015、SA 0.033 添付
    const t2 = rows[1];
    expect(t2.prompt).toBe("ターン2のプロンプト");
    expect(t2.ts).toBe("2026-07-06T10:01:05.000Z");
    expect(t2.models).toEqual(["claude-sonnet-5"]);
    expect(t2.costUSD).toBeCloseTo(0.015, 10);
    expect(t2.costByModel!["claude-sonnet-5"]).toBeCloseTo(0.015, 10);
    expect(t2.ingest).toBe("sweep");
    expect(t2.subagents).toBeDefined();
    expect(t2.subagents!.costUSD).toBeCloseTo(0.033, 10);
    expect(t2.subagents!.costByModel["claude-sonnet-5"]).toBeCloseTo(0.033, 10);
    expect(t2.subagents!.apiCalls).toBe(1);
    expect(t2.subagents!.agentFiles).toBe(1);

    // summary の totalUSD はメイン基準(0.005 + 0.015 = 0.020)。SA は含めない。
    expect(output).toContain("$0.020");
    // summary.subagentsUSD = 0.033 は別枠の1行としてコンソールに出る(¥ は fx.rate=150 換算)。
    expect(output).toContain(
      `うちサブエージェント: ${formatUSD(0.033)}(${formatJPY(0.033 * 150)})`,
    );
  });

  // 2. 再 sweep → 新規 0(カーソル連携)。
  it("2. a second sweep finds nothing new", async () => {
    placeFixtures({ withSA: true });

    await sweep([]);
    expect(readHistory()).toHaveLength(2);

    const { code, output } = await sweep([]);
    expect(code).toBe(0);
    expect(output).toContain("新規はありませんでした");
    expect(readHistory()).toHaveLength(2);
  });

  // 3. hook→sweep: 先に track が t1 を処理 → sweep は新規 0(カーソル連携)。
  it("3. hook then sweep: track processes t1 first, sweep finds nothing new", async () => {
    placeFixtures({ withSA: true });

    await runTrack(stdinForMain());
    expect(readHistory()).toHaveLength(1); // track は窓を1レコードに集約する

    const { output } = await sweep([]);
    expect(output).toContain("新規はありませんでした");
    expect(readHistory()).toHaveLength(1); // sweep は追加しない
  });

  // 4. sweep→hook: sweep 後に track → 履歴が増えない。
  it("4. sweep then hook: track after sweep adds no history", async () => {
    placeFixtures({ withSA: true });

    await sweep([]);
    expect(readHistory()).toHaveLength(2);

    await runTrack(stdinForMain());
    expect(readHistory()).toHaveLength(2); // カーソル互換により track も新規 0
  });

  // 5. --dry-run → 出力はあるが history/cursors 無変化。その後の本実行で 2 レコード入る。
  it("5. --dry-run prints a summary but writes nothing; a real run afterwards inserts 2 records", async () => {
    placeFixtures({ withSA: true });

    const dry = await sweep(["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.output).toContain("dry-run: 書き込みは行っていません");
    expect(dry.output).toContain("2 ターン");
    // 一切書かない。
    expect(existsSync(historyFile())).toBe(false);
    expect(existsSync(cursorsFile())).toBe(false);

    // dry-run 後の本実行は最初からやり直せる(カーソルが進んでいない)。
    await sweep([]);
    expect(readHistory()).toHaveLength(2);
  });

  // 6. --days 0 相当 → 古いターンが捨てられ、かつ再実行でも復活しない(カーソルは進む)。
  it("6. --days 0 drops old turns and they never revive (cursor still advances)", async () => {
    placeFixtures({ withSA: false }); // SA 無し(SA-only レコードで history が濁らないように)

    const { code, output } = await sweep(["--days", "0"]);
    expect(code).toBe(0);
    expect(output).toContain("新規はありませんでした");
    expect(readHistory()).toHaveLength(0);
    // 古いターンでもカーソルは進む(再走査しない)。
    expect(existsSync(cursorsFile())).toBe(true);

    // --days 0 で再実行しても復活しない。
    await sweep(["--days", "0"]);
    expect(readHistory()).toHaveLength(0);

    // 制限なしで再実行してもカーソルが進んでいるため復活しない。
    const again = await sweep([]);
    expect(again.output).toContain("新規はありませんでした");
    expect(readHistory()).toHaveLength(0);
  });

  // 7. SA だけ新規(メインは処理済み)→ SA 回収レコード1件(costUSD 0 + subagents)。
  it("7. SA-only recovery record when only subagents have new usage", async () => {
    placeFixtures({ withSA: true });

    await sweep([]); // メインもSAも処理済みにする
    expect(readHistory()).toHaveLength(2);

    // メインには新規行を足さず、SA にだけ新規行を追記する。
    appendFileSync(saPath, NEW_SA_LINE + "\n", "utf8");

    const { code, output } = await sweep([]);
    expect(code).toBe(0);
    // summary.subagentsUSD = 0.015: SA だけの回収でも回収額がコンソールに見える
    // (totalUSD はメイン基準 0 のため、この別枠が無いと回収額が把握できない)。
    expect(output).toContain(
      `うちサブエージェント: ${formatUSD(0.015)}(${formatJPY(0.015 * 150)})`,
    );

    const rows = readHistory();
    expect(rows).toHaveLength(3);
    const saOnly = rows[2];
    // メインは全ゼロ・costUSD 0・apiCalls 0。
    expect(saOnly.costUSD).toBe(0);
    expect(saOnly.apiCalls).toBe(0);
    expect(saOnly.tokens).toEqual({
      input: 0,
      output: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    });
    expect(saOnly.ingest).toBe("sweep");
    expect(saOnly.prompt).toBe("");
    expect(saOnly.models).toEqual(["claude-sonnet-5"]);
    // SA ブロックに差分(sonnet output 1000 → 0.015)が入る。
    expect(saOnly.subagents).toBeDefined();
    expect(saOnly.subagents!.costUSD).toBeCloseTo(0.015, 10);
    expect(saOnly.subagents!.apiCalls).toBe(1);
  });
});
