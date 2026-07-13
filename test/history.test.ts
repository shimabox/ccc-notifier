import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runHistory } from "../src/history";
import { runDashboard } from "../src/dashboard";
import { acquireDataLock } from "../src/data-lock";
import type { TurnRecord } from "../src/types";

const DAY = 86_400_000;

let tmpHome: string;
let prevHome: string | undefined;
let historyFile: string;

function makeRec(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    sessionId: "s",
    project: "/tmp/proj",
    gitBranch: null,
    models: ["claude-fable-5"],
    tokens: { input: 1, output: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    sidechainTokens: null,
    apiCalls: 1,
    costUSD: 0.1,
    costByModel: { "claude-fable-5": 0.1 },
    costJPY: 15,
    fxRate: 150,
    fxSource: "fixed",
    prompt: "secret prompt text",
    ...overrides,
  };
}

/** ts を「今から days 日前」にした ISO 文字列。 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

function seed(recs: TurnRecord[]): void {
  writeFileSync(historyFile, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function readRecs(): TurnRecord[] {
  if (!existsSync(historyFile)) return [];
  return readFileSync(historyFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TurnRecord);
}

function seedDashboardArtifacts(): string {
  const cache = join(tmpHome, "cache");
  mkdirSync(cache, { recursive: true });
  for (const file of [
    join(tmpHome, "report.html"),
    join(tmpHome, "report-all.html"),
    join(cache, "dashboard-full-state.json"),
  ]) {
    writeFileSync(file, "secret prompt text", "utf8");
  }
  const custom = join(tmpHome, "custom.html");
  writeFileSync(custom, "keep", "utf8");
  return custom;
}

function expectCanonicalInvalidated(custom: string): void {
  expect(existsSync(join(tmpHome, "report.html"))).toBe(false);
  expect(existsSync(join(tmpHome, "report-all.html"))).toBe(false);
  expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(false);
  expect(existsSync(join(tmpHome, "cache", "data.lock"))).toBe(false);
  expect(readFileSync(custom, "utf8")).toBe("keep");
}

async function run(argv: string[]): Promise<number> {
  return runWith(argv);
}

async function runWith(
  argv: string[],
  deps: { confirm?: (opts: { message: string; initialValue: boolean }) => Promise<unknown> } = {},
): Promise<number> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return await runHistory(argv, deps);
}

beforeEach(() => {
  prevHome = process.env.CCCN_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "cccn-history-"));
  process.env.CCCN_HOME = tmpHome;
  historyFile = join(tmpHome, "history.jsonl");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = prevHome;
});

describe("runHistory — 引数バリデーション", () => {
  it("サブコマンドが clear/redact 以外なら usage を出して 1 を返す", async () => {
    expect(await run([])).toBe(1);
    expect(await run(["bogus"])).toBe(1);
  });

  it("history.jsonl が無ければ 0 を返す(何もしない)", async () => {
    expect(await run(["clear", "--yes"])).toBe(0);
    expect(existsSync(historyFile)).toBe(false);
  });

  it.each(["clear", "redact"])("%s with no history still invalidates stale canonical/state", async (sub) => {
    const custom = seedDashboardArtifacts();
    expect(await run([sub, "--yes"])).toBe(0);
    expectCanonicalInvalidated(custom);
  });

  it("no targeted records still invalidates stale canonical/state", async () => {
    seed([makeRec({ prompt: "" })]);
    const custom = seedDashboardArtifacts();
    expect(await run(["redact", "--yes"])).toBe(0);
    expectCanonicalInvalidated(custom);
  });
});

describe("runHistory clear", () => {
  it("--yes 全期間: 全レコードを削除しファイルを消す", async () => {
    seed([makeRec(), makeRec()]);
    const custom = seedDashboardArtifacts();
    expect(await run(["clear", "--yes"])).toBe(0);
    expect(existsSync(historyFile)).toBe(false);
    expectCanonicalInvalidated(custom);
  });

  it("--days N: N 日より前だけ削除し、新しいレコードは残す", async () => {
    const old1 = makeRec({ ts: daysAgo(100), prompt: "old-a" });
    const old2 = makeRec({ ts: daysAgo(95), prompt: "old-b" });
    const recent = makeRec({ ts: daysAgo(10), prompt: "recent" });
    seed([old1, old2, recent]);

    expect(await run(["clear", "--days", "90", "--yes"])).toBe(0);

    const remaining = readRecs();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].prompt).toBe("recent");
  });

  it("対象が 0 件なら何も変更しない", async () => {
    const recent = makeRec({ ts: daysAgo(1) });
    seed([recent]);
    expect(await run(["clear", "--days", "90", "--yes"])).toBe(0);
    expect(readRecs()).toHaveLength(1);
  });

  it("partial clear mutation failure returns 1 after pre-invalidating stale canonical", async () => {
    seed([makeRec({ ts: daysAgo(100), prompt: "old-failure-secret" }), makeRec({ ts: daysAgo(1), prompt: "recent" })]);
    const custom = seedDashboardArtifacts();
    mkdirSync(`${historyFile}.tmp`);
    expect(await run(["clear", "--days", "90", "--yes"])).toBe(1);
    expect(readRecs()).toHaveLength(2);
    expectCanonicalInvalidated(custom);
  });
});

describe("runHistory redact", () => {
  it("--yes 全期間: 全レコードのプロンプトを空にし、コストは保持する", async () => {
    seed([makeRec({ prompt: "aaa", costUSD: 0.1 }), makeRec({ prompt: "bbb", costUSD: 0.2 })]);
    const custom = seedDashboardArtifacts();

    expect(await run(["redact", "--yes"])).toBe(0);

    const recs = readRecs();
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.prompt === "")).toBe(true);
    // コスト等のフィールドは保持される。
    expect(recs.map((r) => r.costUSD)).toEqual([0.1, 0.2]);
    expectCanonicalInvalidated(custom);
  });

  it("--days N: 古いレコードのプロンプトだけ消し、新しい方は残す", async () => {
    const old = makeRec({ ts: daysAgo(100), prompt: "old-secret" });
    const recent = makeRec({ ts: daysAgo(5), prompt: "recent-secret" });
    seed([old, recent]);

    expect(await run(["redact", "--days", "90", "--yes"])).toBe(0);

    const recs = readRecs();
    const byPrompt = recs.map((r) => r.prompt);
    expect(byPrompt).toContain(""); // old が空に
    expect(byPrompt).toContain("recent-secret"); // recent は残る
    // レコード自体は消えない(件数不変)。
    expect(recs).toHaveLength(2);
  });

  it("既に空プロンプトのみなら対象 0 件として変更しない", async () => {
    seed([makeRec({ prompt: "" })]);
    expect(await run(["redact", "--yes"])).toBe(0);
    expect(readRecs()).toHaveLength(1);
  });

  it("mutation failure returns 1 after pre-invalidating stale canonical", async () => {
    seed([makeRec({ prompt: "failure-secret" })]);
    const custom = seedDashboardArtifacts();
    mkdirSync(`${historyFile}.tmp`);
    expect(await run(["redact", "--yes"])).toBe(1);
    expect(readRecs()[0].prompt).toBe("failure-secret");
    expectCanonicalInvalidated(custom);
  });
});

describe("runHistory — canonical generation concurrency", () => {
  it("fails explicitly on lock timeout without changing history or canonical files", async () => {
    seed([makeRec({ prompt: "must-stay" })]);
    writeFileSync(join(tmpHome, "report.html"), "sentinel", "utf8");
    const lock = acquireDataLock();
    expect(lock).not.toBeNull();
    process.env.CCCN_LOCK_TIMEOUT_MS = "0";
    try {
      expect(await run(["clear", "--yes"])).toBe(1);
      expect(readRecs()[0].prompt).toBe("must-stay");
      expect(readFileSync(join(tmpHome, "report.html"), "utf8")).toBe("sentinel");
    } finally {
      delete process.env.CCCN_LOCK_TIMEOUT_MS;
      lock!.release();
    }
  });

  it("serializes a waiting manual full generation so a cleared prompt cannot reappear", async () => {
    seed([makeRec({ prompt: "parallel-private-secret" })]);
    const lock = acquireDataLock();
    expect(lock).not.toBeNull();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const clearPromise = runHistory(["clear", "--yes"]);
    const dashboardPromise = runDashboard(["--no-open", "--all"]);
    setTimeout(() => lock!.release(), 10);
    const [clearCode, dashboardCode] = await Promise.all([clearPromise, dashboardPromise]);

    expect(clearCode).toBe(0);
    expect(dashboardCode).toBe(0);
    const full = join(tmpHome, "report-all.html");
    if (existsSync(full)) expect(readFileSync(full, "utf8")).not.toContain("parallel-private-secret");
    expect(existsSync(join(tmpHome, "cache", "data.lock"))).toBe(false);
  });
});

describe("runHistory — confirmation snapshot race", () => {
  it("initial 0 -> added target aborts without changing history or canonical", async () => {
    writeFileSync(join(tmpHome, "report.html"), "canonical-sentinel", "utf8");
    const lock = acquireDataLock();
    expect(lock).not.toBeNull();
    const promise = run(["clear"]);
    seed([makeRec({ prompt: "added-after-snapshot" })]);
    lock!.release();
    expect(await promise).toBe(1);
    expect(readRecs()[0].prompt).toBe("added-after-snapshot");
    expect(readFileSync(join(tmpHome, "report.html"), "utf8")).toBe("canonical-sentinel");
  });

  it("nonzero -> appended target after confirmation aborts", async () => {
    seed([makeRec({ prompt: "original" })]);
    writeFileSync(join(tmpHome, "report.html"), "canonical-sentinel", "utf8");
    const code = await runWith(["clear"], {
      confirm: async () => {
        appendFileSync(historyFile, `${JSON.stringify(makeRec({ prompt: "added" }))}\n`, "utf8");
        return true;
      },
    });
    expect(code).toBe(1);
    expect(readRecs()).toHaveLength(2);
    expect(readFileSync(join(tmpHome, "report.html"), "utf8")).toBe("canonical-sentinel");
  });

  it("same-count replacement after confirmation aborts by content fingerprint", async () => {
    seed([makeRec({ prompt: "before" })]);
    writeFileSync(join(tmpHome, "report.html"), "canonical-sentinel", "utf8");
    const code = await runWith(["redact"], {
      confirm: async () => {
        seed([makeRec({ prompt: "replacement" })]);
        return true;
      },
    });
    expect(code).toBe(1);
    expect(readRecs()[0].prompt).toBe("replacement");
    expect(readFileSync(join(tmpHome, "report.html"), "utf8")).toBe("canonical-sentinel");
  });

  it("cancel changes neither history nor canonical", async () => {
    seed([makeRec({ prompt: "keep-on-cancel" })]);
    writeFileSync(join(tmpHome, "report.html"), "canonical-sentinel", "utf8");
    expect(await runWith(["clear"], { confirm: async () => false })).toBe(0);
    expect(readRecs()[0].prompt).toBe("keep-on-cancel");
    expect(readFileSync(join(tmpHome, "report.html"), "utf8")).toBe("canonical-sentinel");
  });

  it("--yes applies to the latest lock-protected snapshot", async () => {
    seed([makeRec({ prompt: "initial" })]);
    const lock = acquireDataLock();
    expect(lock).not.toBeNull();
    const promise = run(["clear", "--yes"]);
    appendFileSync(historyFile, `${JSON.stringify(makeRec({ prompt: "newest" }))}\n`, "utf8");
    lock!.release();
    expect(await promise).toBe(0);
    expect(existsSync(historyFile)).toBe(false);
  });
});
