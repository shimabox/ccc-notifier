// test/doctor-prompt-capture.test.ts — doctor のプロンプト取得状況チェック。
//
// runDoctor() を直接 import して呼ぶ。他のチェックは失敗・警告してもよく、ここでは
// 「直近の記録が1件もプロンプトを持たないときだけ警告する」ことだけを検証する。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../src/doctor";
import { appendTurn } from "../src/store";
import type { TurnRecord } from "../src/types";

const ENV_KEYS = ["CCCN_HOME", "CCCN_CODEX_HOME", "CCCN_CLAUDE_PROJECTS", "CCCN_CLAUDE_SETTINGS"] as const;

let tmpHome: string;
let prevEnv: Record<string, string | undefined>;
let logs: string[];

beforeEach(() => {
  prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpHome = mkdtempSync(join(tmpdir(), "cccn-doctor-prompt-"));
  process.env.CCCN_HOME = tmpHome;
  process.env.CCCN_CODEX_HOME = join(tmpHome, "no-codex-home");
  process.env.CCCN_CLAUDE_PROJECTS = join(tmpHome, "no-claude-projects");
  process.env.CCCN_CLAUDE_SETTINGS = join(tmpHome, "no-settings.json");
  // 通知なしモードにして、doctor のテスト通知で実際の OS 通知を出さない。
  writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ notify: { os: false, slack: null } }));

  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
});

function makeTurn(i: number, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    ts: `2026-09-20T10:${String(i).padStart(2, "0")}:00.000Z`,
    sessionId: `session-${i}`,
    project: "/home/tester/proj",
    gitBranch: null,
    models: ["gpt-5.5"],
    tokens: { input: 10, output: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    sidechainTokens: null,
    apiCalls: 1,
    costUSD: 0.01,
    costJPY: 1.5,
    fxRate: 150,
    fxSource: "fixed",
    prompt: "",
    ...overrides,
  };
}

const promptLines = (): string[] => logs.filter((l) => l.includes("のプロンプト取得"));

describe("doctor: prompt capture", () => {
  it("直近の記録がすべてプロンプトなしなら、そのソースだけ warn で知らせる", async () => {
    for (let i = 0; i < 12; i++) {
      appendTurn(makeTurn(i, { source: "codex" }));
      appendTurn(makeTurn(i, { sessionId: `claude-${i}`, prompt: i === 0 ? "依頼" : "" }));
    }
    await runDoctor();

    const lines = promptLines();
    expect(lines.find((l) => l.includes("Codex"))).toMatch(/^⚠️ .*直近12件の記録にプロンプトが1件もありません/);
    expect(lines.find((l) => l.includes("Claude Code"))).toMatch(/^✅ .*直近12件中1件/);
  });

  it("古い記録が空でも、直近20件にプロンプトがあれば警告しない", async () => {
    for (let i = 0; i < 30; i++) appendTurn(makeTurn(i, { source: "codex", prompt: i >= 25 ? "依頼" : "" }));
    await runDoctor();

    expect(promptLines()).toEqual([expect.stringMatching(/^✅ Codex .*直近20件中5件/)]);
  });

  it("history redact で消した記録は数えない", async () => {
    for (let i = 0; i < 12; i++) appendTurn(makeTurn(i, { source: "codex", promptRedacted: true }));
    await runDoctor();

    expect(promptLines()).toEqual([]);
  });

  it("サブエージェントだけの記録(apiCalls=0)は数えず、件数が少なければ判定しない", async () => {
    for (let i = 0; i < 9; i++) appendTurn(makeTurn(i, { source: "codex" }));
    for (let i = 9; i < 30; i++) appendTurn(makeTurn(i, { source: "codex", apiCalls: 0 }));
    await runDoctor();

    expect(promptLines()).toEqual([]);
  });
});
