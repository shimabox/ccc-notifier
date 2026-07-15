// test/sweep.test.ts — sweep(過去分の一括回収)の単体/結合テスト。
//
// 契約: src/contracts.md の "src/sweep.ts(2026-07-07 追加)"、GOLDEN 値は
// test/fixtures/GOLDEN.md(transcript-multiturn.jsonl / subagent-basic.jsonl)を参照。
//
// 一時 CCCN_HOME + 一時 projects ルート(--projects かつ CCCN_CLAUDE_PROJECTS で指定)に
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
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatJPY, formatUSD } from "../src/format";
import { runSweep } from "../src/sweep";
import { runTrack } from "../src/track";
import type { TurnRecord } from "../src/types";
// Codex sweep テスト用の追加 import(既存 import ブロックは不変。新規行のみ追加)。
import { writeFileSync } from "node:fs";
import { saveCursor } from "../src/store";
import { runHistory } from "../src/history";
import { acquireDataLock } from "../src/data-lock";

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
  prevHome = process.env.CCCN_HOME;
  prevProjects = process.env.CCCN_CLAUDE_PROJECTS;
  prevDryRun = process.env.CCCN_DRY_RUN;

  tmpHome = mkdtempSync(join(tmpdir(), "cccn-sweep-home-"));
  projectsRoot = mkdtempSync(join(tmpdir(), "cccn-sweep-projects-"));
  process.env.CCCN_HOME = tmpHome;
  process.env.CCCN_CLAUDE_PROJECTS = projectsRoot;
  process.env.CCCN_DRY_RUN = "1"; // track の通知は last-notify.json へ

  // 実ネットワークに出ない保険。config/cache不在なので単価は builtin、fx は既定の fixed(160)になる。
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

  mainPath = join(projectsRoot, "projA", "t1.jsonl");
  saPath = join(projectsRoot, "projA", "t1", "subagents", "agent-x.jsonl");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(projectsRoot, { recursive: true, force: true });

  if (prevHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = prevHome;
  if (prevProjects === undefined) delete process.env.CCCN_CLAUDE_PROJECTS;
  else process.env.CCCN_CLAUDE_PROJECTS = prevProjects;
  if (prevDryRun === undefined) delete process.env.CCCN_DRY_RUN;
  else process.env.CCCN_DRY_RUN = prevDryRun;
});

// ---- helpers --------------------------------------------------------------

/**
 * projA/t1.jsonl(+ 任意で SA)を配置する。
 * mtime は 10 分前に戻す(コピー直後 = 現在 mtime のままだと進行中セッション保護で
 * スキップされるため。「完了済みセッション」を模すのが既定)。
 */
function placeFixtures(opts: { withSA: boolean }): void {
  const aged = new Date(Date.now() - 10 * 60_000);
  mkdirSync(join(projectsRoot, "projA"), { recursive: true });
  copyFileSync(FIXTURE_MULTITURN, mainPath);
  utimesSync(mainPath, aged, aged);
  if (opts.withSA) {
    mkdirSync(join(projectsRoot, "projA", "t1", "subagents"), { recursive: true });
    copyFileSync(FIXTURE_SUBAGENT, saPath);
    utimesSync(saPath, aged, aged);
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
  it("data lock timeout leaves history and cursors unchanged", async () => {
    placeFixtures({ withSA: false });
    const lock = acquireDataLock();
    expect(lock).not.toBeNull();
    process.env.CCCN_LOCK_TIMEOUT_MS = "0";
    try {
      const result = await sweep([]);
      expect(result.code).toBe(1);
      expect(existsSync(historyFile())).toBe(false);
      expect(existsSync(cursorsFile())).toBe(false);
    } finally {
      delete process.env.CCCN_LOCK_TIMEOUT_MS;
      lock!.release();
    }
  });

  it("clear完了後のsweepはsourceから履歴2件とcursorを決定的に再生成する", async () => {
    placeFixtures({ withSA: false });
    writeFileSync(historyFile(), `${JSON.stringify({ schemaVersion: 1, ts: new Date().toISOString(), prompt: "old-secret" })}\n`, "utf8");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runHistory(["clear", "--yes"])).toBe(0);
    expect(readHistory()).toHaveLength(0);

    expect(await runSweep(["--projects", projectsRoot])).toBe(0);
    expect(readHistory()).toHaveLength(2);
    const cursors = JSON.parse(readFileSync(cursorsFile(), "utf8")) as Record<string, unknown>;
    expect(cursors[mainPath]).toBeDefined();
  });

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
    expect(t1.costJPY).toBeCloseTo(0.8, 10); // 0.005 × 160
    expect(t1.fxRate).toBe(160);
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
    // summary.subagentsUSD = 0.033 は別枠の1行としてコンソールに出る(¥ は既定 fx.rate=160 換算)。
    expect(output).toContain(
      `うちサブエージェント: ${formatUSD(0.033)}(${formatJPY(0.033 * 160)})`,
    );
  });

  // 2. 再 sweep → cursorを捨てて同じsourceから全件を置換再生成する。
  it("2. a second sweep rebuilds the same two records without duplication", async () => {
    placeFixtures({ withSA: true });

    await sweep([]);
    expect(readHistory()).toHaveLength(2);

    const { code, output } = await sweep([]);
    expect(code).toBe(0);
    expect(output).toContain("2 ターン");
    expect(readHistory()).toHaveLength(2);
  });

  // 3. hook→sweep: hook cursorを捨て、sourceをターン単位で全再生成する。
  it("3. hook then sweep: sweep replaces hook history from the source beginning", async () => {
    placeFixtures({ withSA: true });

    await runTrack(stdinForMain());
    expect(readHistory()).toHaveLength(1); // track は窓を1レコードに集約する

    const { output } = await sweep([]);
    expect(output).toContain("2 ターン");
    expect(readHistory()).toHaveLength(2);
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

  // 6. --days 0 はreset後に期間内だけを保存し、制限なしsweepで全期間を戻せる。
  it("6. --days 0 keeps only the period and a full sweep restores old turns", async () => {
    placeFixtures({ withSA: false }); // SA 無し(SA-only レコードで history が濁らないように)

    const { code, output } = await sweep(["--days", "0"]);
    expect(code).toBe(0);
    expect(output).toMatch(/(?:新規|再生成対象).*ありません/);
    expect(readHistory()).toHaveLength(0);
    // 古いターンでもカーソルは進む(再走査しない)。
    expect(existsSync(cursorsFile())).toBe(true);

    // --days 0 で再実行しても期間外なので履歴は空。
    await sweep(["--days", "0"]);
    expect(readHistory()).toHaveLength(0);

    // 制限なしsweepはcursorを捨てるため全期間を復活させる。
    const again = await sweep([]);
    expect(again.output).toContain("2 ターン");
    expect(readHistory()).toHaveLength(2);
  });

  // 7. SAだけ追記後も、全再生成した同じ2 main turnの末尾へ全SA usageを付ける。
  it("7. an agent-only append is included in a full rebuild without adding a stale third row", async () => {
    placeFixtures({ withSA: true });

    await sweep([]); // メインもSAも処理済みにする
    expect(readHistory()).toHaveLength(2);

    // メインには新規行を足さず、SA にだけ新規行を追記する。
    appendFileSync(saPath, NEW_SA_LINE + "\n", "utf8");

    const { code, output } = await sweep([]);
    expect(code).toBe(0);
    // 元0.033 + 追記0.015 = 0.048を全再集計する。
    expect(output).toContain(
      `うちサブエージェント: ${formatUSD(0.048)}(${formatJPY(0.048 * 160)})`,
    );

    const rows = readHistory();
    expect(rows).toHaveLength(2);
    const last = rows[1];
    expect(last.prompt).toBe("ターン2のプロンプト");
    expect(last.subagents).toBeDefined();
    expect(last.subagents!.costUSD).toBeCloseTo(0.048, 10);
    expect(last.subagents!.apiCalls).toBe(2);
  });

  // 8. 進行中sourceも既定でbest-effort走査する。
  it("8. ingests a recently-modified transcript by default", async () => {
    placeFixtures({ withSA: false });
    const now = new Date();
    utimesSync(mainPath, now, now); // 「今まさに書かれている」状態を模す

    const first = await sweep([]);
    expect(first.code).toBe(0);
    expect(first.output).toContain("2 ターン");
    expect(first.output).not.toContain("スキップ:");
    expect(readHistory()).toHaveLength(2);
  });

  // 9. --include-active は廃止され、不正optionとしてmutation前に拒否する。
  it("9. rejects the removed --include-active flag", async () => {
    placeFixtures({ withSA: false });
    const now = new Date();
    utimesSync(mainPath, now, now);

    const { code } = await sweep(["--include-active"]);
    expect(code).toBe(1);
    expect(readHistory()).toHaveLength(0);
    expect(existsSync(cursorsFile())).toBe(false);
  });
});

// ===========================================================================
// Codex 走査(過去分の一括回収)
//
// 既存の top-level beforeEach/afterEach(CCCN_HOME / CCCN_CLAUDE_PROJECTS / CCCN_DRY_RUN /
// fetch スタブ)はそのまま活かしつつ、追加で CCCN_CODEX_HOME を一時 dir に隔離する。
//
// 【重要・隔離の理由】既存 beforeEach は CCCN_CODEX_HOME を触らないため、実行マシンに実 ~/.codex/
// sessions があると runSweep が実データを走査してしまい、既存 Claude テストのレコード数アサーション
// (「2 レコード」等)まで壊す。そこで下記 top-level beforeEach で CCCN_CODEX_HOME を「sessions を
// 持たない空の一時ホーム」に既定設定する。これで全テスト(既存含む)で Codex 走査は黙ってスキップされ、
// 既存テストの挙動・アサーションは不変のまま、実データからの汚染だけを防げる(既存コードは無変更)。
// Codex 用テストはこの一時ホーム配下に sessions/YYYY/MM/DD/rollout-*.jsonl を置いて検証する。
let codexHomeDir: string;
let prevCodexHome: string | undefined;

beforeEach(() => {
  prevCodexHome = process.env.CCCN_CODEX_HOME;
  codexHomeDir = mkdtempSync(join(tmpdir(), "cccn-sweep-codex-"));
  process.env.CCCN_CODEX_HOME = codexHomeDir; // sessions 無しの空ホーム = Codex 走査は黙ってスキップ
});

afterEach(() => {
  rmSync(codexHomeDir, { recursive: true, force: true });
  if (prevCodexHome === undefined) delete process.env.CCCN_CODEX_HOME;
  else process.env.CCCN_CODEX_HOME = prevCodexHome;
});

const FIXTURES_CODEX_DIR = fileURLToPath(new URL("./fixtures/codex", import.meta.url));

// 実 Codex と同じ uuid 形式のファイル名(session_meta の session_id と対応させる)。
const NAME_MULTITURN = "rollout-2026-07-10T13-00-00-01234567-aaaa-7000-8000-000000000002.jsonl";
const NAME_BASIC = "rollout-2026-07-10T12-09-25-01234567-aaaa-7000-8000-000000000001.jsonl";

/**
 * codex fixture を codexHomeDir/sessions/2026/07/10/<fileName> に配置し、mtime を10分前に戻す
 * (コピー直後 = 現在 mtime のままだと active guard でスキップされるため。「完了済み」を模す)。
 */
function placeCodexRollout(fixtureBasename: string, fileName: string): string {
  const dir = join(codexHomeDir, "sessions", "2026", "07", "10");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, fileName);
  copyFileSync(join(FIXTURES_CODEX_DIR, fixtureBasename), dest);
  const aged = new Date(Date.now() - 10 * 60_000);
  utimesSync(dest, aged, aged);
  return dest;
}

describe("runSweep (codex)", () => {
  it("51 rolloutでも25件単位だけ進捗を出し、1件ごとの冗長な出力をしない", async () => {
    for (let i = 0; i < 51; i++) {
      placeCodexRollout(
        "rollout-basic.jsonl",
        `rollout-bulk-${String(i).padStart(3, "0")}.jsonl`,
      );
    }

    const { code, output } = await sweep([]);

    expect(code).toBe(0);
    expect(output).toMatch(/走査開始.*Claude project 0.*Codex rollout 51/i);
    const progress = output.split("\n").filter((line) =>
      /走査進捗:|(?:Claude transcript|Codex rollout).*走査.*\d+\s*\/\s*\d+/i.test(line),
    );
    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatch(/25\s*\/\s*51/);
    expect(progress[1]).toMatch(/50\s*\/\s*51/);
    expect(progress.join("\n")).not.toMatch(/(?:1|51)\s*\/\s*51/);
    expect(output.split("\n").length).toBeLessThan(30);
  });

  it("reports a Codex lock timeout as incomplete and leaves its cursor reusable", async () => {
    const rollout = placeCodexRollout("rollout-basic.jsonl", NAME_BASIC);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runSweep(["--projects", projectsRoot], { lockProvider: async () => null });
    const output = log.mock.calls.flat().join(" ");
    expect(code).toBe(1);
    expect(existsSync(historyFile())).toBe(false);
    const cursors = existsSync(cursorsFile()) ? readFileSync(cursorsFile(), "utf8") : "";
    expect(cursors).not.toContain(rollout);
  });

  it("uses one global lock for Claude and Codex instead of locking each target", async () => {
    placeFixtures({ withSA: false });
    const rollout = placeCodexRollout("rollout-basic.jsonl", NAME_BASIC);
    let calls = 0;
    const provider = async (): Promise<ReturnType<typeof acquireDataLock>> => {
      calls += 1;
      return acquireDataLock();
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runSweep(["--projects", projectsRoot], { lockProvider: provider });
    expect(code).toBe(0);
    expect(calls).toBe(1);
    expect(readHistory()).toHaveLength(3);
    const cursors = JSON.parse(readFileSync(cursorsFile(), "utf8")) as Record<string, unknown>;
    expect(cursors[mainPath]).toBeDefined();
    expect(cursors[rollout]).toBeDefined();
  });

  // 1. multiturn を取り込む → 3 レコード(source codex / ingest sweep / モデル gpt-5.5×2 + gpt-5-codex /
  //    buckets が fixtures README のドラフト正解値どおり)。サマリに「Codex: 3」。
  it("1. ingests a multiturn rollout as 3 codex records with a Codex summary line", async () => {
    placeCodexRollout("rollout-multiturn.jsonl", NAME_MULTITURN);

    const { code, output } = await sweep([]);
    expect(code).toBe(0);
    // Codex 行は「うちサブエージェント」行と同じ $(¥)書式(¥ は既定 fx.rate=160 換算)。
    // 0.0047 + 0.0123 + 0.0010125 = 0.0180125 USD。
    expect(output).toContain(
      `Codex: 3 ターン ${formatUSD(0.0180125)}(${formatJPY(0.0180125 * 160)})`,
    );
    // Codex 分は総合計にも含まれる(このテストは Codex のみなので newRecords = 3)。
    expect(output).toContain("3 ターン");

    const rows = readHistory();
    expect(rows).toHaveLength(3);

    for (const r of rows) {
      expect(r.source).toBe("codex");
      expect(r.ingest).toBe("sweep");
      expect(r.sessionId).toBe("01234567-aaaa-7000-8000-000000000002");
      expect(r.project).toBe("/home/user/proj-b");
      expect(r.gitBranch).toBeNull();
      expect(r.sidechainTokens).toBeNull();
      expect(r.subagents).toBeUndefined();
      expect(r.fxRate).toBe(160);
    }

    const [t1, t2, t3] = rows;

    // t1: gpt-5.5 / TokenBuckets {input:600, cacheRead:400, output:50} / cost 0.0047。
    expect(t1.prompt).toBe("ターン1です");
    expect(t1.ts).toBe("2026-07-10T13:00:06.000Z");
    expect(t1.models).toEqual(["gpt-5.5"]);
    expect(t1.apiCalls).toBe(1);
    expect(t1.tokens).toEqual({ input: 600, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 400 });
    expect(t1.costUSD).toBeCloseTo(0.0047, 10);
    expect(t1.costByModel!["gpt-5.5"]).toBeCloseTo(0.0047, 10);
    expect(t1.costJPY).toBeCloseTo(0.0047 * 160, 10);

    // t2: gpt-5.5 / {input:1400, cacheRead:1600, output:150}(B+C 合算・破損行はスキップ)/ cost 0.0123 / apiCalls 2。
    expect(t2.prompt).toBe("ターン2です");
    expect(t2.ts).toBe("2026-07-10T13:01:21.000Z");
    expect(t2.models).toEqual(["gpt-5.5"]);
    expect(t2.apiCalls).toBe(2);
    expect(t2.tokens).toEqual({ input: 1400, output: 150, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1600 });
    expect(t2.costUSD).toBeCloseTo(0.0123, 10);

    // t3: gpt-5-codex / {input:300, cacheRead:300, output:60}(info:null はスキップ)/ cost 0.0010125 / apiCalls 1。
    expect(t3.prompt).toBe("ターン3です");
    expect(t3.ts).toBe("2026-07-10T13:02:11.000Z");
    expect(t3.models).toEqual(["gpt-5-codex"]);
    expect(t3.apiCalls).toBe(1);
    expect(t3.tokens).toEqual({ input: 300, output: 60, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 300 });
    expect(t3.costUSD).toBeCloseTo(0.0010125, 10);
    expect(t3.costByModel!["gpt-5-codex"]).toBeCloseTo(0.0010125, 10);
  });

  // 2. --dry-run: 集計表示のみ・書き込みゼロ・カーソル進まず。その後の本実行で 3 レコード入る。
  it("2. --dry-run prints the codex summary but writes nothing (cursor does not advance)", async () => {
    placeCodexRollout("rollout-multiturn.jsonl", NAME_MULTITURN);

    const dry = await sweep(["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.output).toContain("dry-run: 書き込みは行っていません");
    expect(dry.output).toContain("Codex: 3 ターン");
    // 一切書かない。
    expect(existsSync(historyFile())).toBe(false);
    expect(existsSync(cursorsFile())).toBe(false);

    // dry-run 後の本実行はカーソルが進んでいないので最初から取り込める。
    const real = await sweep([]);
    expect(real.output).toContain("Codex: 3 ターン");
    expect(readHistory()).toHaveLength(3);
  });

  // 3. 2回目もcursorを捨てて同じ3件を置換再生成する。
  it("3. a second sweep rebuilds the same codex records without duplication", async () => {
    placeCodexRollout("rollout-multiturn.jsonl", NAME_MULTITURN);

    await sweep([]);
    expect(readHistory()).toHaveLength(3);

    const { code, output } = await sweep([]);
    expect(code).toBe(0);
    expect(output).toContain("Codex: 3 ターン");
    expect(readHistory()).toHaveLength(3);
  });

  // 4. hook cursorがEOFでも、sweepはcursorを捨てて先頭から再生成する。
  it("4. ignores a hook cursor and rebuilds the rollout from the beginning", async () => {
    const dest = placeCodexRollout("rollout-basic.jsonl", NAME_BASIC);
    // aggregateCodexTurn がウィンドウ全体を消費したときの newCursor 相当を書いておく:
    //   offset = ファイル全長 / codexTotals = 最後に観測した total / lastTs = 最後のイベント時刻。
    saveCursor(dest, {
      offset: readFileSync(dest).length, // Buffer の byte 長 = ファイルサイズ
      lastUuid: null,
      lastTs: "2026-07-10T12:09:34.000Z",
      seenMessageKeys: [],
      codexTotals: { input: 17272, cached: 4992, output: 7 },
    });

    const { code, output } = await sweep([]);
    expect(code).toBe(0);
    expect(output).toContain("Codex: 1 ターン");
    expect(readHistory()).toHaveLength(1);
  });

  // 5. --days 0は期間外を保存しないが、制限なしsweepで全期間を戻せる。
  //    実行時刻に依存しないよう、multiturn の日付を過去(2020)へずらした確定的な「古い」rollout を使う。
  it("5. --days 0 limits codex history and a full sweep restores it", async () => {
    const dir = join(codexHomeDir, "sessions", "2026", "07", "10");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, NAME_MULTITURN);
    const aged = readFileSync(join(FIXTURES_CODEX_DIR, "rollout-multiturn.jsonl"), "utf8").replaceAll(
      "2026-07-10",
      "2020-01-01",
    );
    writeFileSync(dest, aged, "utf8");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(dest, old, old); // active guard に引っかからないよう mtime も古くする

    const { code, output } = await sweep(["--days", "0"]);
    expect(code).toBe(0);
    expect(output).toMatch(/(?:新規|再生成対象).*ありません/);
    expect(output).not.toContain("Codex:");
    expect(readHistory()).toHaveLength(0);
    // 古いターンでもカーソルは進む(ウィンドウ全体消費)。
    expect(existsSync(cursorsFile())).toBe(true);

    // 制限なしsweepはcursorを捨てて先頭から復活させる。
    const again = await sweep([]);
    expect(again.output).toContain("Codex: 3 ターン");
    expect(readHistory()).toHaveLength(3);
  });

  // 6. active rolloutも既定で処理し、旧--include-activeは拒否する。
  it("6. ingests a recently-modified rollout by default and rejects --include-active", async () => {
    const dest = placeCodexRollout("rollout-multiturn.jsonl", NAME_MULTITURN);
    const now = new Date();
    utimesSync(dest, now, now); // 「今まさに書かれている」状態を模す

    const first = await sweep([]);
    expect(first.code).toBe(0);
    expect(first.output).toContain("Codex: 3 ターン");
    expect(first.output).not.toContain("スキップ:");
    expect(readHistory()).toHaveLength(3);

    const before = readFileSync(historyFile(), "utf8");
    const second = await sweep(["--include-active"]);
    expect(second.code).toBe(1);
    expect(readFileSync(historyFile(), "utf8")).toBe(before);
    expect(readHistory()).toHaveLength(3);
  });

  // 7. codex home 不在 → Claude のみで正常動作(エラーなし・Codex 行なし)。
  it("7. runs Claude-only cleanly when codex home is absent (no Codex line, no error)", async () => {
    // detectCodex() が偽になる不在パスへ向ける。
    process.env.CCCN_CODEX_HOME = join(codexHomeDir, "does-not-exist");
    placeFixtures({ withSA: false }); // Claude 側は通常どおり動くことを確認

    const { code, output } = await sweep([]);
    expect(code).toBe(0);
    expect(output).not.toContain("Codex:");
    expect(output).toContain("2 ターン");

    const rows = readHistory();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.source).toBeUndefined(); // Claude レコードは source 無し
  });

  // 8. Claude ルート不在でも Codex が走査可能なら、警告1行を出して Codex のみ走査する(exit 0)。
  //    旧挙動は「ルート不在 → 即 return 1」だったが、Codex 専用ユーザー(~/.claude/projects を
  //    持たない)の全再生成を成立させるため、両方走査不能のときだけエラーにする意味論へ変更した
  //    (オーケストレーター認可)。
  it("8. sweeps Codex-only with a warning when the Claude projects root is missing", async () => {
    placeCodexRollout("rollout-multiturn.jsonl", NAME_MULTITURN);
    rmSync(projectsRoot, { recursive: true, force: true }); // Claude ルート不在を模す

    const { code, output } = await sweep([]);
    expect(code).toBe(0);
    expect(output).toContain("Codex のみ走査します");
    expect(output).toContain("Codex: 3 ターン");
    expect(readHistory()).toHaveLength(3);
  });

  // 9. Claude ルートも Codex も走査不能なら従来どおりエラーメッセージ + exit 1。
  it("9. still fails with exit 1 when neither Claude nor Codex is sweepable", async () => {
    // codexHomeDir は sessions を持たない空ホーム(top-level 隔離のまま)= Codex 走査不能。
    rmSync(projectsRoot, { recursive: true, force: true }); // Claude ルート不在を模す

    const { code, output } = await sweep([]);
    expect(code).toBe(1);
    expect(output).toContain("走査ルートが見つかりません");
    expect(readHistory()).toHaveLength(0);
  });
});
