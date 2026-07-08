import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseBudgetAmount, runBudget } from "../src/budget";
import type { TurnRecord } from "../src/types";

let tmpHome: string;
let prevHome: string | undefined;
let logs: string[];

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    sessionId: "s",
    project: "/tmp/p",
    gitBranch: null,
    models: ["claude-opus-4-8"],
    tokens: { input: 1, output: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    sidechainTokens: null,
    apiCalls: 1,
    costUSD: 10,
    costByModel: { "claude-opus-4-8": 10 },
    costJPY: 1500,
    fxRate: 150,
    fxSource: "fixed",
    prompt: "x",
    ...overrides,
  };
}

function seedThisMonth(costs: number[]): void {
  const now = new Date();
  const recs = costs.map((c, i) =>
    makeTurn({
      ts: new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - i), 12).toISOString(),
      costUSD: c,
      costByModel: { "claude-opus-4-8": c },
      costJPY: c * 150,
    }),
  );
  writeFileSync(join(tmpHome, "history.jsonl"), recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function readConfigRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tmpHome, "config.json"), "utf8"));
}

function run(argv: string[]): number {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  return runBudget(argv);
}

beforeEach(() => {
  prevHome = process.env.CCCN_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "cccn-budget-"));
  process.env.CCCN_HOME = tmpHome;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = prevHome;
});

describe("parseBudgetAmount", () => {
  it("accepts plain / $ / comma-separated numbers", () => {
    expect(parseBudgetAmount("400")).toBe(400);
    expect(parseBudgetAmount("$400")).toBe(400);
    expect(parseBudgetAmount("1,000")).toBe(1000);
    expect(parseBudgetAmount("0")).toBe(0);
  });
  it("rejects negatives and non-numbers", () => {
    expect(parseBudgetAmount("-5")).toBeNull();
    expect(parseBudgetAmount("abc")).toBeNull();
    expect(parseBudgetAmount("")).toBeNull();
  });
});

describe("runBudget", () => {
  it("shows 'not set' and this-month usage when budget is unset", () => {
    seedThisMonth([10, 20]);
    expect(run([])).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("未設定");
    expect(out).toContain("$30.00"); // 今月の使用
  });

  it("sets the budget and persists it to config.json", () => {
    seedThisMonth([124]);
    expect(run(["400"])).toBe(0);
    expect(readConfigRaw().monthlyBudgetUSD).toBe(400);
    expect(logs.join("\n")).toContain("$400.00");
  });

  it("shows usage and percentage when a budget is set", () => {
    seedThisMonth([124]);
    run(["400"]);
    logs = [];
    run([]);
    const out = logs.join("\n");
    expect(out).toContain("$124.00 / $400.00");
    expect(out).toContain("31.0% used");
  });

  it("accepts $-prefixed amounts", () => {
    run(["$250"]);
    expect(readConfigRaw().monthlyBudgetUSD).toBe(250);
  });

  it("clears the budget with 0 (and with 'off')", () => {
    run(["400"]);
    expect(run(["0"])).toBe(0);
    expect(readConfigRaw().monthlyBudgetUSD).toBe(0);
    run(["400"]);
    run(["off"]);
    expect(readConfigRaw().monthlyBudgetUSD).toBe(0);
  });

  it("rejects invalid amounts with exit 1 and does not write", () => {
    expect(run(["-10"])).toBe(1);
    expect(existsSync(join(tmpHome, "config.json"))).toBe(false);
    expect(run(["abc"])).toBe(1);
  });
});
