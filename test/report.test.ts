// test/report.test.ts — `ccc-notifier report` のサーフェス別内訳(desktop-cost-tracking)。
// 既存の report 動作(日別・モデル別)は test/e2e.test.ts の "9. report" で確認済みのため、
// ここでは新規追加分(bySurface)に絞って検証する。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runReport } from "../src/report";
import { appendTurn } from "../src/store";
import type { TurnRecord } from "../src/types";

let tmpHome: string;
let prevHome: string | undefined;
let logs: string[];

beforeEach(() => {
  prevHome = process.env.CCCN_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "cccn-report-test-"));
  process.env.CCCN_HOME = tmpHome;
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = prevHome;
});

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    sessionId: "sess",
    project: "/home/me/alpha",
    gitBranch: "main",
    models: ["claude-fable-5"],
    tokens: { input: 100, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    sidechainTokens: null,
    apiCalls: 1,
    costUSD: 0.1,
    costJPY: 15,
    fxRate: 150,
    fxSource: "fixed",
    prompt: "テストプロンプト",
    ...overrides,
  };
}

describe("runReport — サーフェス別内訳", () => {
  it("1. 複数 surface があれば表形式にサーフェス別セクションが出る", async () => {
    appendTurn(makeTurn({ costUSD: 0.1, costJPY: 15, surface: "cli" }));
    appendTurn(makeTurn({ costUSD: 0.2, costJPY: 30, surface: "desktop" }));
    const code = await runReport(["--days", "9999"]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("サーフェス別 (By surface)");
    expect(out).toContain("デスクトップアプリ");
  });

  it("2. 単一 surface(cli のみ)なら表形式にサーフェス別セクションを出さない", async () => {
    appendTurn(makeTurn({ costUSD: 0.1, costJPY: 15, surface: "cli" }));
    appendTurn(makeTurn({ costUSD: 0.2, costJPY: 30 })); // 欠損 = cli 相当
    const code = await runReport(["--days", "9999"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).not.toContain("サーフェス別 (By surface)");
  });

  it("2b. 単一 surface でも cli 以外(デスクトップ専業)なら表形式に出す", async () => {
    appendTurn(makeTurn({ costUSD: 0.1, costJPY: 15, surface: "desktop" }));
    appendTurn(makeTurn({ costUSD: 0.2, costJPY: 30, surface: "desktop" }));
    const code = await runReport(["--days", "9999"]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("サーフェス別 (By surface)");
    expect(out).toContain("デスクトップアプリ");
  });

  it("3. --json は bySurface を含む", async () => {
    appendTurn(makeTurn({ costUSD: 0.1, costJPY: 15, surface: "cli" }));
    appendTurn(makeTurn({ costUSD: 0.2, costJPY: 30, surface: "desktop" }));
    const code = await runReport(["--days", "9999", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.bySurface.cli.turns).toBe(1);
    expect(parsed.bySurface.desktop.turns).toBe(1);
    expect(parsed.bySurface.desktop.costUSD).toBeCloseTo(0.2, 10);
  });
});
