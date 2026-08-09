// test/doctor-duplicate-history.test.ts — doctor の重複ターン検知(2026-08-09 本番事故の回帰確認)。
//
// runDoctor() を直接 import して呼ぶ(dist/cli.js は使わない)。他のチェック(hook 登録・通知等)は
// 失敗・警告してもよく、ここでは「history.jsonl に同一 sessionId+ts の重複ターンがあるとき、
// doctor がそれを検知して警告する」ことだけを検証する。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../src/doctor";
import { appendTurn } from "../src/store";
import type { TurnRecord } from "../src/types";

let tmpHome: string;
let prevHome: string | undefined;
let prevCodexHome: string | undefined;
let prevClaudeProjects: string | undefined;
let prevClaudeSettings: string | undefined;
let logs: string[];

beforeEach(() => {
  prevHome = process.env.CCCN_HOME;
  prevCodexHome = process.env.CCCN_CODEX_HOME;
  prevClaudeProjects = process.env.CCCN_CLAUDE_PROJECTS;
  prevClaudeSettings = process.env.CCCN_CLAUDE_SETTINGS;

  tmpHome = mkdtempSync(join(tmpdir(), "cccn-doctor-dup-"));
  process.env.CCCN_HOME = tmpHome;
  process.env.CCCN_CODEX_HOME = join(tmpHome, "no-codex-home");
  process.env.CCCN_CLAUDE_PROJECTS = join(tmpHome, "no-claude-projects");
  process.env.CCCN_CLAUDE_SETTINGS = join(tmpHome, "no-settings.json");

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

  if (prevHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = prevHome;
  if (prevCodexHome === undefined) delete process.env.CCCN_CODEX_HOME;
  else process.env.CCCN_CODEX_HOME = prevCodexHome;
  if (prevClaudeProjects === undefined) delete process.env.CCCN_CLAUDE_PROJECTS;
  else process.env.CCCN_CLAUDE_PROJECTS = prevClaudeProjects;
  if (prevClaudeSettings === undefined) delete process.env.CCCN_CLAUDE_SETTINGS;
  else process.env.CCCN_CLAUDE_SETTINGS = prevClaudeSettings;
});

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    ts: "2026-07-11T12:12:15.857Z",
    sessionId: "f524dff5-59ae-4f4e-918a-568b119d8667",
    project: "/home/tester/tab-maker",
    gitBranch: "main",
    models: ["claude-fable-5"],
    tokens: { input: 10, output: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    sidechainTokens: null,
    apiCalls: 3,
    costUSD: 2.55,
    costJPY: 382.5,
    fxRate: 150,
    fxSource: "fixed",
    prompt: "",
    ...overrides,
  };
}

describe("doctor: duplicate history turn detection", () => {
  it("同一 sessionId+ts が複数行あると warn で検知する(2026-08-09 本番事故の再現形)", async () => {
    // 事故の実形: track の正規レコード(apiCalls=3) + ingest がカーソルを見失って
    // ファイル先頭から丸ごと再集計した重複レコード(apiCalls=406、ts は完全一致)。
    appendTurn(makeTurn({ apiCalls: 3, costUSD: 2.549929 }));
    appendTurn(makeTurn({ apiCalls: 406, costUSD: 250.572689, ingest: "scan" }));

    await runDoctor();

    const out = logs.join("\n");
    expect(out).toContain("同一 sessionId+ts の重複ターンを検出しました");
    expect(out).toContain("apiCalls 3/406");
  });

  it("重複が無ければ ok で報告する", async () => {
    appendTurn(makeTurn({ ts: "2026-07-11T12:12:15.857Z" }));
    appendTurn(makeTurn({ ts: "2026-07-12T09:00:00.000Z" }));

    await runDoctor();

    const out = logs.join("\n");
    expect(out).toContain("同一 sessionId+ts の重複ターンは検出されませんでした");
  });
});
