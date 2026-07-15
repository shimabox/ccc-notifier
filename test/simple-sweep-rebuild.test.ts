// sweep の「既存履歴とcursorを捨て、sourceから概算を全再生成する」標準契約を固定する。
// WAL / tombstone / backup / rollback は要求せず、失敗時は同じ sweep を再実行する。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  promises as fsPromises,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireDataLock } from "../src/data-lock";
import type { DataLockHandle } from "../src/data-lock";
import { runHistory } from "../src/history";
import { builtinPriceTable } from "../src/pricing";
import { runSweep } from "../src/sweep";
import { runTrack } from "../src/track";
import * as dashboard from "../src/dashboard";
import type { TurnRecord } from "../src/types";

const CLAUDE_MAIN = fileURLToPath(new URL("./fixtures/transcript-multiturn.jsonl", import.meta.url));
const CLAUDE_AGENT = fileURLToPath(new URL("./fixtures/subagent-basic.jsonl", import.meta.url));
const CODEX_BASIC = fileURLToPath(new URL("./fixtures/codex/rollout-basic.jsonl", import.meta.url));
const CODEX_NAME = "rollout-2026-07-10T12-09-25-01234567-aaaa-7000-8000-000000000001.jsonl";

let home: string;
let projects: string;
let codexHome: string;
let mainPath: string;
let agentPath: string;
let rolloutPath: string;
let priorEnv: Record<string, string | undefined>;

function file(name: string): string {
  return join(home, name);
}

function cacheFile(name: string): string {
  return join(home, "cache", name);
}

function bytes(path: string): string | null {
  return existsSync(path) ? readFileSync(path).toString("base64") : null;
}

function canonicalSnapshot(): Record<string, string | null> {
  return Object.fromEntries(
    [
      "history.jsonl",
      "cursors.json",
      "report.html",
      "report-all.html",
      "cache/dashboard-full-state.json",
      "config.json",
      "muted.json",
      "last-notify.json",
      "error.log",
      "codex-subagent-activity.json",
      "cache/keep-me.bin",
    ].map((name) => [name, bytes(file(name))]),
  );
}

function rows(): TurnRecord[] {
  if (!existsSync(file("history.jsonl"))) return [];
  return readFileSync(file("history.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnRecord);
}

function dashboardTurns(name: "report.html" | "report-all.html"): unknown[] {
  const html = readFileSync(file(name), "utf8");
  const marker = '<script id="cccn-data" type="application/json">';
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const dataStart = start + marker.length;
  const end = html.indexOf("</script>", dataStart);
  expect(end).toBeGreaterThan(dataStart);
  return (JSON.parse(html.slice(dataStart, end)) as { turns: unknown[] }).turns;
}

function setDashboardConfig(overrides: {
  autoRegenerate?: boolean;
  autoReloadSec?: number;
  days?: number;
}): void {
  const configPath = file("config.json");
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
  cfg.dashboard = { ...cfg.dashboard, ...overrides };
  writeFileSync(configPath, `${JSON.stringify(cfg)}\n`, "utf8");
}

function placeClaude(opts: { agent?: boolean; active?: boolean } = {}): void {
  mkdirSync(join(projects, "project-a"), { recursive: true });
  copyFileSync(CLAUDE_MAIN, mainPath);
  if (opts.agent) {
    mkdirSync(join(projects, "project-a", "session-a", "subagents"), { recursive: true });
    copyFileSync(CLAUDE_AGENT, agentPath);
  }
  const stamp = opts.active ? new Date() : new Date(Date.now() - 10 * 60_000);
  utimesSync(mainPath, stamp, stamp);
  if (opts.agent) utimesSync(agentPath, stamp, stamp);
}

function placeCodex(opts: { active?: boolean } = {}): void {
  mkdirSync(join(codexHome, "sessions", "2026", "07", "10"), { recursive: true });
  copyFileSync(CODEX_BASIC, rolloutPath);
  const stamp = opts.active ? new Date() : new Date(Date.now() - 10 * 60_000);
  utimesSync(rolloutPath, stamp, stamp);
}

function seedPreservedAndResetFiles(): void {
  mkdirSync(join(home, "cache"), { recursive: true });
  writeFileSync(file("history.jsonl"), '{"old":"history","costUSD":999}\n');
  writeFileSync(file("cursors.json"), '{"old":"cursor"}\n');
  writeFileSync(file("report.html"), "old recent dashboard");
  writeFileSync(file("report-all.html"), "old full dashboard");
  writeFileSync(cacheFile("dashboard-full-state.json"), '{"old":"dashboard-state"}\n');
  writeFileSync(
    file("config.json"),
    `${JSON.stringify({
      notify: { os: true, slack: { webhookUrl: "https://example.invalid/slack" } },
      minNotifyUSD: 0,
      costLabel: "api_equivalent",
      fx: { fallbackRate: 123, cacheHours: 24 },
      includeDailyTotal: true,
      monthlyBudgetUSD: 321,
      dashboard: { autoRegenerate: false, autoReloadSec: 0, days: 30 },
    })}\n`,
  );
  writeFileSync(file("muted.json"), '{"until":"2099-01-01T00:00:00.000Z"}\n');
  writeFileSync(file("last-notify.json"), "notification-sentinel\n");
  writeFileSync(file("codex-subagent-activity.json"), "activity-ledger-sentinel\n");
  writeFileSync(cacheFile("keep-me.bin"), "cache-sentinel\0bytes");
  writeFileSync(
    cacheFile("pricing.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), table: builtinPriceTable() }),
  );
  writeFileSync(cacheFile("fx.json"), JSON.stringify({ rate: 123, fetchedAt: new Date().toISOString() }));
}

/** sourceを全消費済みの有効cursor。dry-runがこれを無視することを検証する。 */
function seedConsumedCursors(): void {
  const dict: Record<string, unknown> = {
    [mainPath]: {
      offset: readFileSync(mainPath).length,
      lastUuid: "done-main",
      lastTs: "9999-01-01T00:00:00.000Z",
      seenMessageKeys: [],
    },
    [rolloutPath]: {
      offset: readFileSync(rolloutPath).length,
      lastUuid: null,
      lastTs: "9999-01-01T00:00:00.000Z",
      seenMessageKeys: [],
      codexTotals: { input: 17272, cached: 4992, output: 7 },
    },
  };
  if (existsSync(agentPath)) {
    dict[agentPath] = {
      offset: readFileSync(agentPath).length,
      lastUuid: "done-agent",
      lastTs: "9999-01-01T00:00:00.000Z",
      seenMessageKeys: [],
    };
  }
  writeFileSync(file("cursors.json"), JSON.stringify(dict));
}

async function captureSweep(
  argv: string[],
  deps?: { lockProvider?: () => Promise<DataLockHandle | null> },
): Promise<{ code: number; output: string; error: string }> {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await runSweep(argv, deps as Parameters<typeof runSweep>[1]);
    return {
      code,
      output: out.mock.calls.flat().map(String).join("\n"),
      error: err.mock.calls.flat().map(String).join("\n"),
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

function expectProgressInOrder(output: string, patterns: RegExp[]): void {
  let cursor = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(output.slice(cursor + 1));
    expect(match, `進捗が見つかりません: ${pattern}\n${output}`).not.toBeNull();
    cursor += 1 + match!.index;
  }
}

beforeEach(() => {
  priorEnv = {
    CCCN_HOME: process.env.CCCN_HOME,
    CCCN_CLAUDE_PROJECTS: process.env.CCCN_CLAUDE_PROJECTS,
    CCCN_CODEX_HOME: process.env.CCCN_CODEX_HOME,
    CCCN_DRY_RUN: process.env.CCCN_DRY_RUN,
    CCCN_LOCK_TIMEOUT_MS: process.env.CCCN_LOCK_TIMEOUT_MS,
  };
  home = mkdtempSync(join(tmpdir(), "cccn-simple-sweep-home-"));
  projects = mkdtempSync(join(tmpdir(), "cccn-simple-sweep-claude-"));
  codexHome = mkdtempSync(join(tmpdir(), "cccn-simple-sweep-codex-"));
  mainPath = join(projects, "project-a", "session-a.jsonl");
  agentPath = join(projects, "project-a", "session-a", "subagents", "agent-a.jsonl");
  rolloutPath = join(codexHome, "sessions", "2026", "07", "10", CODEX_NAME);
  process.env.CCCN_HOME = home;
  process.env.CCCN_CLAUDE_PROJECTS = projects;
  process.env.CCCN_CODEX_HOME = codexHome;
  process.env.CCCN_DRY_RUN = "1";
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("sweep CLI contract", () => {
  it.each([
    ["rebuild", ["--rebuild"]],
    ["yes", ["--yes"]],
    ["short yes", ["-y"]],
    ["include-active", ["--include-active"]],
    ["unknown option", ["--unknown"]],
    ["days missing value", ["--days"]],
    ["projects missing value", ["--projects"]],
    ["extra positional", ["extra"]],
  ])("%sをmutation前にexit 1で拒否する", async (_label, argv) => {
    placeClaude();
    seedPreservedAndResetFiles();
    const before = canonicalSnapshot();

    const result = await captureSweep(argv);

    expect(result.code).toBe(1);
    expect(`${result.output}\n${result.error}`).not.toMatch(
      /単価.*為替|走査開始|走査完了|(?:dashboard|ダッシュボード).*生成開始|lock.*取得/i,
    );
    expect(canonicalSnapshot()).toEqual(before);
  });
});

describe("sweep reset and regeneration", () => {
  it("成功かつautoRegenerate=trueなら同じglobal lock内でrecent/full/stateを実体生成し、recentはconfig.daysを使う", async () => {
    placeClaude();
    seedPreservedAndResetFiles();
    setDashboardConfig({ autoRegenerate: true, autoReloadSec: 0, days: 1 });
    let lockCalls = 0;
    let dashboardsReadyAtRelease = false;

    const result = await captureSweep(["--days", "9999"], {
      lockProvider: async () => {
        lockCalls += 1;
        const held = acquireDataLock();
        if (held === null) return null;
        return {
          token: held.token,
          heartbeat: () => held.heartbeat(),
          release: () => {
            dashboardsReadyAtRelease =
              existsSync(file("report.html")) &&
              existsSync(file("report-all.html")) &&
              existsSync(cacheFile("dashboard-full-state.json")) &&
              !readFileSync(file("report.html"), "utf8").includes('name="cccn-placeholder"') &&
              !readFileSync(file("report-all.html"), "utf8").includes('name="cccn-placeholder"');
            held.release();
          },
        };
      },
    });

    expect(result.code).toBe(0);
    expectProgressInOrder(result.output, [
      /単価.*為替/,
      /lock.*取得/i,
      /走査開始.*Claude project 1.*Codex rollout 0/i,
      /走査完了/,
      /(?:dashboard|ダッシュボード).*生成開始/i,
    ]);
    expect(result.output).not.toMatch(
      /走査進捗:|(?:Claude transcript|Codex rollout).*走査.*\d+\s*\/\s*\d+/i,
    );
    expect(lockCalls).toBe(1);
    expect(dashboardsReadyAtRelease).toBe(true);
    expect(rows()).toHaveLength(2); // sweep --days 9999 の再生成対象
    expect(dashboardTurns("report.html")).toHaveLength(0); // config.dashboard.days=1 を使用
    expect(dashboardTurns("report-all.html")).toHaveLength(2);
    const state = JSON.parse(readFileSync(cacheFile("dashboard-full-state.json"), "utf8")) as {
      localDate: string;
      generatedAt: string;
    };
    expect(state.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isFinite(Date.parse(state.generatedAt))).toBe(true);
  });

  it("sweepはglobal lockを1回だけ使い、activeなClaude main/agent/Codexを先頭から全再生成する", async () => {
    placeClaude({ agent: true, active: true });
    placeCodex({ active: true });
    seedPreservedAndResetFiles();
    const preserved = {
      config: bytes(file("config.json")),
      mute: bytes(file("muted.json")),
      notify: bytes(file("last-notify.json")),
      activity: bytes(file("codex-subagent-activity.json")),
      cache: bytes(cacheFile("keep-me.bin")),
    };
    let lockCalls = 0;
    let recordsAtRelease = -1;
    let cursorsAtRelease = false;

    const result = await captureSweep([], {
      lockProvider: async () => {
        lockCalls += 1;
        const held = acquireDataLock();
        if (held === null) return null;
        return {
          token: held.token,
          heartbeat: () => held.heartbeat(),
          release: () => {
            recordsAtRelease = rows().length;
            cursorsAtRelease = existsSync(file("cursors.json"));
            held.release();
          },
        };
      },
    });

    expect(result.code).toBe(0);
    expect(lockCalls).toBe(1);
    expect(recordsAtRelease).toBe(3);
    expect(cursorsAtRelease).toBe(true);
    expect(rows()).toHaveLength(3);
    expect(rows().filter((row) => row.source === "codex")).toHaveLength(1);
    expect(rows().some((row) => row.subagents?.agentFiles === 1)).toBe(true);
    expect(rows().every((row) => row.ingest === "sweep" && row.fxRate === 123)).toBe(true);
    expect(readFileSync(file("cursors.json"), "utf8")).toContain(mainPath);
    expect(readFileSync(file("cursors.json"), "utf8")).toContain(agentPath);
    expect(readFileSync(file("cursors.json"), "utf8")).toContain(rolloutPath);
    expect(existsSync(file("report.html"))).toBe(false);
    expect(existsSync(file("report-all.html"))).toBe(false);
    expect(existsSync(cacheFile("dashboard-full-state.json"))).toBe(false);
    expect(bytes(file("config.json"))).toBe(preserved.config);
    expect(bytes(file("muted.json"))).toBe(preserved.mute);
    expect(bytes(file("last-notify.json"))).toBe(preserved.notify);
    expect(bytes(file("codex-subagent-activity.json"))).toBe(preserved.activity);
    expect(bytes(cacheFile("keep-me.bin"))).toBe(preserved.cache);
    expect(readdirSync(home).some((name) => name.endsWith(".bak"))).toBe(false);
  });

  it("sweep --days 0はreset後に期間内だけを保存し、引数なしsweepで全期間を戻す", async () => {
    placeClaude();
    seedPreservedAndResetFiles();

    expect((await captureSweep(["--days", "0"])).code).toBe(0);
    expect(rows()).toHaveLength(0);
    expect(existsSync(file("cursors.json"))).toBe(true);
    expect(existsSync(file("report.html"))).toBe(false);

    expect((await captureSweep([])).code).toBe(0);
    expect(rows().map((row) => row.prompt)).toEqual(["ターン1のプロンプト", "ターン2のプロンプト"]);
  });

  it("clear/redactした履歴とpromptも、引数なしsweepでsourceから復活する", async () => {
    placeClaude({ agent: true });
    placeCodex();
    expect((await captureSweep([])).code).toBe(0);
    expect(rows()).toHaveLength(3);

    expect(await runHistory(["redact", "--yes"])).toBe(0);
    expect(rows().every((row) => row.prompt === "")).toBe(true);
    expect((await captureSweep([])).code).toBe(0);
    expect(rows()).toHaveLength(3);
    expect(rows().some((row) => row.prompt === "ターン1のプロンプト")).toBe(true);
    expect(rows().some((row) => row.prompt === "1+1は？")).toBe(true);

    expect(await runHistory(["clear", "--yes"])).toBe(0);
    expect(rows()).toHaveLength(0);
    expect((await captureSweep([])).code).toBe(0);
    expect(rows()).toHaveLength(3);
  });

  it("sweepは201 agentを全件取り込み、全cursorを保存する", async () => {
    placeClaude();
    const dir = join(projects, "project-a", "session-a", "subagents");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 201; i++) {
      copyFileSync(CLAUDE_AGENT, join(dir, `agent-${String(i).padStart(3, "0")}.jsonl`));
    }

    expect((await captureSweep([])).code).toBe(0);
    expect(rows()).toHaveLength(2);
    expect(rows()[1]?.subagents?.agentFiles).toBe(201);
    expect(rows()[1]?.subagents?.apiCalls).toBe(201);
    const cursors = JSON.parse(readFileSync(file("cursors.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(cursors)).toHaveLength(202);
    expect(cursors[join(dir, "agent-000.jsonl")]).toBeDefined();
    expect(cursors[join(dir, "agent-200.jsonl")]).toBeDefined();
  });

  it("sweep読取後の追記は後続hookが追加分だけ回収し、既存行を倍増させない", async () => {
    placeClaude();
    expect((await captureSweep([])).code).toBe(0);
    expect(rows()).toHaveLength(2);

    appendFileSync(
      mainPath,
      [
        JSON.stringify({
          parentUuid: "m-a2", isSidechain: false, cwd: "/tmp/proj", sessionId: "sess-M", gitBranch: "main",
          type: "user", message: { role: "user", content: "sweep後の追記" }, uuid: "m-u3",
          timestamp: "2026-07-06T10:02:00.000Z",
        }),
        JSON.stringify({
          parentUuid: "m-u3", isSidechain: false, cwd: "/tmp/proj", sessionId: "sess-M", gitBranch: "main",
          type: "assistant", requestId: "req_M3",
          message: {
            id: "msg_M3", role: "assistant", model: "claude-sonnet-5",
            usage: {
              input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100,
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
            },
          },
          uuid: "m-a3", timestamp: "2026-07-06T10:02:05.000Z",
        }),
      ].join("\n") + "\n",
    );

    await runTrack(JSON.stringify({
      session_id: "sess-M", transcript_path: mainPath, cwd: "/tmp/proj", hook_event_name: "Stop",
    }));
    expect(rows().map((row) => row.prompt)).toEqual([
      "ターン1のプロンプト",
      "ターン2のプロンプト",
      "sweep後の追記",
    ]);
  });
});

describe("sweep dry-run", () => {
  it("既存cursorを無視して先頭からpreviewし、history/cursor/dashboardを含む全状態を変更しない", async () => {
    placeClaude({ agent: true, active: true });
    placeCodex({ active: true });
    seedPreservedAndResetFiles();
    seedConsumedCursors();
    const before = canonicalSnapshot();
    let lockCalls = 0;

    const result = await captureSweep(["--dry-run"], {
      lockProvider: async () => {
        lockCalls += 1;
        return acquireDataLock();
      },
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain("dry-run");
    expect(result.output).toContain("3 ターン");
    expectProgressInOrder(result.output, [
      /単価.*為替/,
      /走査開始.*Claude project 1.*Codex rollout 1/i,
      /走査完了/,
    ]);
    expect(result.output).not.toMatch(/lock.*取得/i);
    expect(result.output).not.toMatch(/(?:dashboard|ダッシュボード).*生成開始/i);
    expect(result.output).not.toMatch(
      /走査進捗:|(?:Claude transcript|Codex rollout).*走査.*\d+\s*\/\s*\d+/i,
    );
    expect(lockCalls).toBe(0);
    expect(canonicalSnapshot()).toEqual(before);
  });

  it("--dry-run --days 0はread-onlyのまま期間外turnをpreviewから除外する", async () => {
    placeClaude();
    seedPreservedAndResetFiles();
    const before = canonicalSnapshot();

    const result = await captureSweep(["--dry-run", "--days", "0"]);

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/(?:新規|再生成対象).*ありません/);
    expect(canonicalSnapshot()).toEqual(before);
  });

  it("sourceのhard failureでもdry-runはerror.log等を永続化せず、stderrだけでexit 1にする", async () => {
    placeClaude();
    seedPreservedAndResetFiles();
    const before = canonicalSnapshot();
    vi.spyOn(fsPromises, "open").mockRejectedValueOnce(
      Object.assign(new Error("injected source read failure"), { code: "EACCES" }),
    );

    const result = await captureSweep(["--dry-run"]);

    expect(result.code).toBe(1);
    expect(result.error).toMatch(/失敗|source|再実行/i);
    expect(canonicalSnapshot()).toEqual(before);
    expect(existsSync(file("error.log"))).toBe(false);
  });

  it("malformed configでもdry-runはerror.logを含む永続状態を変更しない", async () => {
    placeClaude();
    seedPreservedAndResetFiles();
    writeFileSync(file("config.json"), "{malformed-config", "utf8");
    const before = canonicalSnapshot();

    const result = await captureSweep(["--dry-run"]);

    expect(result.code).toBe(0);
    expect(result.output).toContain("dry-run");
    expect(canonicalSnapshot()).toEqual(before);
    expect(existsSync(file("error.log"))).toBe(false);
  });
});

describe("sweep failure and retry", () => {
  it("dashboard writer失敗時は履歴/cursorを維持してexit 1にし、canonicalを再無効化して手動復旧を案内する", async () => {
    placeClaude();
    seedPreservedAndResetFiles();
    setDashboardConfig({ autoRegenerate: true });
    vi.spyOn(dashboard, "writeDashboardHtml").mockImplementation(() => {
      throw new Error("injected dashboard writer failure");
    });

    const result = await captureSweep([]);

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/(?:dashboard|ダッシュボード).*生成開始/i);
    expect(rows()).toHaveLength(2);
    const cursors = JSON.parse(readFileSync(file("cursors.json"), "utf8")) as Record<string, unknown>;
    expect(cursors[mainPath]).toBeDefined();
    expect(existsSync(file("report.html"))).toBe(false);
    expect(existsSync(file("report-all.html"))).toBe(false);
    expect(existsSync(cacheFile("dashboard-full-state.json"))).toBe(false);
    expect(result.error).toContain("履歴は再生成済み");
    expect(result.error).toContain("dashboard");
    expect(result.error).toContain("dashboard --all");
  });

  it("global data lockを取得できない場合はhistory/cursors/dashboardを変更しない", async () => {
    placeClaude();
    seedPreservedAndResetFiles();
    const before = canonicalSnapshot();
    const held = acquireDataLock();
    expect(held).not.toBeNull();
    process.env.CCCN_LOCK_TIMEOUT_MS = "0";
    try {
      const result = await captureSweep([]);
      expect(result.code).toBe(1);
      expect(canonicalSnapshot()).toEqual(before);
    } finally {
      held!.release();
    }
  });

  it("両sourceが走査不能ならreset前にexit 1する", async () => {
    rmSync(projects, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    seedPreservedAndResetFiles();
    const before = canonicalSnapshot();

    expect((await captureSweep([])).code).toBe(1);
    expect(canonicalSnapshot()).toEqual(before);
  });

  it("Claude root不在かつCodex sessionsがsymlinkならreset前にexit 1で状態を維持する", async () => {
    rmSync(projects, { recursive: true, force: true });
    seedPreservedAndResetFiles();
    const target = join(codexHome, "sessions-target");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(codexHome, "sessions"), process.platform === "win32" ? "junction" : "dir");
    const before = canonicalSnapshot();

    const result = await captureSweep([]);

    expect(result.code).toBe(1);
    expect(canonicalSnapshot()).toEqual(before);
  });

  it("個別sourceのread失敗は部分成功をexit 1にし、復旧後のsweepで最初から回復する", async () => {
    placeClaude();
    placeCodex();
    vi.spyOn(fsPromises, "open").mockRejectedValueOnce(
      Object.assign(new Error("injected source read failure"), { code: "EACCES" }),
    );

    const first = await captureSweep([]);
    expect(first.code).toBe(1);
    expect(first.output).toMatch(/走査完了:.*失敗 [1-9]\d*/);
    expect(`${first.output}\n${first.error}`).toMatch(/一部|再実行|retry/i);
    expect(existsSync(file("report.html"))).toBe(false);
    expect(existsSync(file("report-all.html"))).toBe(false);
    expect(existsSync(cacheFile("dashboard-full-state.json"))).toBe(false);

    expect((await captureSweep([])).code).toBe(0);
    expect(rows()).toHaveLength(3);
  });
});
