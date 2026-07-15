// sweep --rebuild の「単純に捨てて全再生成する」契約を固定する。
//
// この suite は堅牢版の WAL / tombstone / generation を要求しない。失敗時の回復方法は
// 同じコマンドの再実行だけであり、clear / redact した内容も source が残っていれば復活する。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireDataLock } from "../src/data-lock";
import { runHistory } from "../src/history";
import { builtinPriceTable } from "../src/pricing";
import { runSweep } from "../src/sweep";
import type { DataLockHandle } from "../src/data-lock";
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
  // Ledgerは残すが、再生成した履歴への activityProjectionKey の再joinまでは要求しない。
  writeFileSync(file("codex-subagent-activity.json"), "activity-ledger-sentinel\n");
  writeFileSync(cacheFile("keep-me.bin"), "cache-sentinel\0bytes");

  // pricing / FX の通常loaderによる更新と、rebuildのreset範囲は別契約。
  // fresh cacheにして、このsuite自身をnetworkや実時間から隔離する。
  writeFileSync(
    cacheFile("pricing.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), table: builtinPriceTable() }),
  );
  writeFileSync(cacheFile("fx.json"), JSON.stringify({ rate: 123, fetchedAt: new Date().toISOString() }));
}

async function captureSweep(
  argv: string[],
  deps?: {
    lockProvider?: () => Promise<DataLockHandle | null>;
    confirm?: (opts: { message: string; initialValue: boolean }) => Promise<unknown>;
  },
): Promise<{ code: number; output: string; error: string }> {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // Wave 1ではsourceを変更しないため、confirm seamは将来のrunSweep deps型へcastする。
    // production既定値は @clack/prompts.confirm、テスト時だけ同じ形の関数を差し込む想定。
    const code = await runSweep(argv, deps as unknown as Parameters<typeof runSweep>[1]);
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

beforeEach(() => {
  priorEnv = {
    CCCN_HOME: process.env.CCCN_HOME,
    CCCN_CLAUDE_PROJECTS: process.env.CCCN_CLAUDE_PROJECTS,
    CCCN_CODEX_HOME: process.env.CCCN_CODEX_HOME,
    CCCN_DRY_RUN: process.env.CCCN_DRY_RUN,
    CCCN_LOCK_TIMEOUT_MS: process.env.CCCN_LOCK_TIMEOUT_MS,
  };
  home = mkdtempSync(join(tmpdir(), "cccn-simple-rebuild-home-"));
  projects = mkdtempSync(join(tmpdir(), "cccn-simple-rebuild-claude-"));
  codexHome = mkdtempSync(join(tmpdir(), "cccn-simple-rebuild-codex-"));
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

describe("sweep --rebuild CLI contract", () => {
  it("確認をキャンセルすると全対象がbyte-stableで、警告に破壊範囲を表示する", async () => {
    placeClaude();
    seedPreservedAndResetFiles();
    const before = canonicalSnapshot();
    let confirmation = "";

    const result = await captureSweep(["--rebuild"], {
      confirm: async ({ message }) => {
        confirmation = message;
        return false;
      },
    });

    expect(result.code).toBe(0);
    expect(canonicalSnapshot()).toEqual(before);
    expect(confirmation).toMatch(/履歴|history/i);
    expect(confirmation).toMatch(/取り込み位置|cursor/i);
    expect(confirmation).toMatch(/backup|バックアップ/i);
    expect(confirmation).toMatch(/金額|cost/i);
    expect(confirmation).toMatch(/prompt|プロンプト/i);
    expect(confirmation).toMatch(/元.*JSONL|source/i);
  });

  it.each([
    ["dry-run", ["--rebuild", "--dry-run"]],
    ["days", ["--rebuild", "--days", "7"]],
    ["include-active", ["--rebuild", "--include-active"]],
    ["projects", ["--rebuild", "--projects", "/tmp/other"]],
    ["unknown option", ["--rebuild", "--unknown"]],
    ["days missing value", ["--rebuild", "--days"]],
    ["projects missing value", ["--rebuild", "--projects"]],
    ["extra positional", ["--rebuild", "extra"]],
  ])("%sをmutation前にexit 1で拒否する", async (_label, argv) => {
    placeClaude();
    seedPreservedAndResetFiles();
    const before = canonicalSnapshot();

    const result = await captureSweep(argv);

    expect(result.code).toBe(1);
    expect(canonicalSnapshot()).toEqual(before);
  });
});

describe("sweep --rebuild reset and regeneration", () => {
  it("--yesはglobal lockを1回だけ使い、activeなClaude main/agent/Codexを先頭から再生成する", async () => {
    placeClaude({ agent: true, active: true });
    placeCodex({ active: true });
    seedPreservedAndResetFiles();
    const configBefore = bytes(file("config.json"));
    const muteBefore = bytes(file("muted.json"));
    const notifyBefore = bytes(file("last-notify.json"));
    const activityBefore = bytes(file("codex-subagent-activity.json"));
    const cacheSentinelBefore = bytes(cacheFile("keep-me.bin"));
    let lockCalls = 0;
    let recordsAtLockRelease = -1;
    let cursorsExistedAtLockRelease = false;

    const result = await captureSweep(["--rebuild", "--yes"], {
      lockProvider: async () => {
        lockCalls += 1;
        const held = acquireDataLock();
        if (held === null) return null;
        return {
          token: held.token,
          heartbeat: () => held.heartbeat(),
          release: () => {
            // reset開始から全sourceのcursor保存まで同じlockを保持することを観測する。
            // この時点までlockが残るため、通常trackはcanonical history/cursorへ割り込めない。
            recordsAtLockRelease = rows().length;
            cursorsExistedAtLockRelease = existsSync(file("cursors.json"));
            held.release();
          },
        };
      },
    });

    expect(result.code).toBe(0);
    expect(lockCalls).toBe(1);
    expect(recordsAtLockRelease).toBe(3);
    expect(cursorsExistedAtLockRelease).toBe(true);
    const rebuilt = rows();
    expect(rebuilt).toHaveLength(3); // Claude 2ターン + Codex 1ターン。agentはClaude turnへ添付。
    expect(rebuilt.filter((row) => row.source === "codex")).toHaveLength(1);
    expect(rebuilt.some((row) => row.subagents?.agentFiles === 1)).toBe(true);
    expect(rebuilt.every((row) => row.ingest === "sweep")).toBe(true);
    expect(rebuilt.every((row) => row.fxRate === 123)).toBe(true);
    expect(rebuilt.every((row) => row.costUSD !== 999)).toBe(true);
    expect(readFileSync(file("cursors.json"), "utf8")).toContain(mainPath);
    expect(readFileSync(file("cursors.json"), "utf8")).toContain(rolloutPath);

    expect(existsSync(file("report.html"))).toBe(false);
    expect(existsSync(file("report-all.html"))).toBe(false);
    expect(existsSync(cacheFile("dashboard-full-state.json"))).toBe(false);
    expect(bytes(file("config.json"))).toBe(configBefore); // budget / Slack / OS設定を含む
    expect(bytes(file("muted.json"))).toBe(muteBefore);
    expect(bytes(file("last-notify.json"))).toBe(notifyBefore); // rebuild自身は通知しない
    expect(bytes(file("codex-subagent-activity.json"))).toBe(activityBefore);
    expect(bytes(cacheFile("keep-me.bin"))).toBe(cacheSentinelBefore);
    expect(readdirSync(home).some((name) => name.endsWith(".bak"))).toBe(false);
  });

  it("通常sweepでdays=0により進んだcursorを捨て、古い履歴を復活させる", async () => {
    placeClaude();
    expect((await captureSweep(["--days", "0"])).code).toBe(0);
    expect(rows()).toHaveLength(0);
    expect(existsSync(file("cursors.json"))).toBe(true);

    expect((await captureSweep(["--rebuild", "--yes"])).code).toBe(0);
    expect(rows().map((row) => row.prompt)).toEqual(["ターン1のプロンプト", "ターン2のプロンプト"]);
  });

  it("history clear/redactはsourceに残る全履歴とpromptを保護せず、再rebuildでも倍増しない", async () => {
    placeClaude({ agent: true });
    placeCodex();
    expect((await captureSweep(["--rebuild", "--yes"])).code).toBe(0);
    expect(rows()).toHaveLength(3);

    expect(await runHistory(["redact", "--yes"])).toBe(0);
    expect(rows().every((row) => row.prompt === "")).toBe(true);
    expect((await captureSweep(["--rebuild", "--yes"])).code).toBe(0);
    expect(rows()).toHaveLength(3);
    expect(rows().some((row) => row.prompt === "ターン1のプロンプト")).toBe(true);
    expect(rows().some((row) => row.prompt === "1+1は？")).toBe(true);

    expect(await runHistory(["clear", "--yes"])).toBe(0);
    expect(rows()).toHaveLength(0);
    expect((await captureSweep(["--rebuild", "--yes"])).code).toBe(0);
    expect(rows()).toHaveLength(3);
    expect((await captureSweep(["--rebuild", "--yes"])).code).toBe(0);
    expect(rows()).toHaveLength(3);
  });

  it("Claudeのみ、Codexのみでも全再生成できる", async () => {
    placeClaude();
    expect((await captureSweep(["--rebuild", "--yes"])).code).toBe(0);
    expect(rows()).toHaveLength(2);

    rmSync(projects, { recursive: true, force: true });
    placeCodex();
    expect((await captureSweep(["--rebuild", "--yes"])).code).toBe(0);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.source).toBe("codex");
  });
});

describe("sweep --rebuild failure and retry", () => {
  it("global data lockを取得できない場合はhistory/cursors/dashboardを変更しない", async () => {
    placeClaude();
    seedPreservedAndResetFiles();
    const before = canonicalSnapshot();
    const held = acquireDataLock();
    expect(held).not.toBeNull();
    process.env.CCCN_LOCK_TIMEOUT_MS = "0";
    try {
      const result = await captureSweep(["--rebuild", "--yes"]);
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

    const result = await captureSweep(["--rebuild", "--yes"]);

    expect(result.code).toBe(1);
    expect(canonicalSnapshot()).toEqual(before);
  });

  it("個別sourceのread失敗は部分成功をexit 1にし、権限復旧後の再実行で最初から回復する", async () => {
    placeClaude();
    placeCodex(); // 少なくとも一方は正常なのでreset後の個別失敗経路へ進む。
    chmodSync(mainPath, 0o000);
    try {
      const first = await captureSweep(["--rebuild", "--yes"]);
      expect(first.code).toBe(1);
      expect(`${first.output}\n${first.error}`).toMatch(/一部|再実行|retry/i);

      chmodSync(mainPath, 0o600);
      const second = await captureSweep(["--rebuild", "--yes"]);
      expect(second.code).toBe(0);
      expect(rows()).toHaveLength(3);
    } finally {
      chmodSync(mainPath, 0o600);
    }
  });
});
