import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config, TurnRecord } from "../src/types";
import { formatJPY, formatSummary, formatTokens, formatUSD, modelDisplayName } from "../src/format";
import { acnHome, appendNotifyError, writeDryRun } from "../src/notify/util";
import { notifyOS } from "../src/notify/os";
import { notifySlack } from "../src/notify/slack";

// node-notifier は実通知を出さないようモック化する。vi.mock は静的にホイストされるため、
// モック内で使う関数は vi.hoisted で用意する。
const { mockNotify } = vi.hoisted(() => ({ mockNotify: vi.fn() }));

vi.mock("node-notifier", () => ({
  default: {
    notify: mockNotify,
  },
}));

// ============ 共有フィクスチャ ============
// GOLDEN.md (test/fixtures/transcript-basic.jsonl の正解値) 相当の TurnRecord。
// costUSD/costJPY/tokens/models は GOLDEN の値をそのまま使い、
// prompt だけは 50 字省略ロジックを検証するため 60 字超にしてある。
const longPrompt = `${"X".repeat(20)}\n${"X".repeat(40)}`; // 61字(改行込み)

const baseRecord: TurnRecord = {
  schemaVersion: 1,
  ts: "2026-07-06T10:00:12.000Z",
  sessionId: "sess-1",
  project: "/tmp/proj",
  gitBranch: "main",
  models: ["claude-fable-5", "claude-haiku-4-5"],
  tokens: { input: 100, output: 200, cacheWrite5m: 0, cacheWrite1h: 10000, cacheRead: 50000 },
  sidechainTokens: { input: 1000, output: 500, cacheWrite5m: 2000, cacheWrite1h: 0, cacheRead: 0 },
  apiCalls: 2,
  costUSD: 0.267,
  costJPY: 40.05,
  fxRate: 150,
  fxSource: "fixed",
  prompt: longPrompt,
};

const baseConfig: Config = {
  notify: { os: true, slack: null },
  minNotifyUSD: 0,
  costLabel: "api_equivalent",
  fx: { fallbackRate: 150, cacheHours: 12 },
  includeDailyTotal: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============ format.ts ============

describe("formatUSD", () => {
  it("uses 4 decimals below $0.01", () => {
    expect(formatUSD(0.0009)).toBe("$0.0009");
  });

  it("uses 3 decimals below $1", () => {
    expect(formatUSD(0.05)).toBe("$0.050");
  });

  it("uses 2 decimals at $1 and above", () => {
    expect(formatUSD(1.234)).toBe("$1.23");
  });
});

describe("formatJPY", () => {
  it("uses 1 decimal below ¥1", () => {
    expect(formatJPY(0.4)).toBe("¥0.4");
  });

  it("rounds to the nearest integer at ¥1 and above", () => {
    expect(formatJPY(40.05)).toBe("¥40");
  });

  it("adds thousands separators", () => {
    expect(formatJPY(1234.6)).toBe("¥1,235");
  });
});

describe("formatTokens", () => {
  it("keeps counts below 1000 as-is", () => {
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with one decimal and 'k'", () => {
    expect(formatTokens(1234)).toBe("1.2k");
  });

  it("formats millions with one decimal and 'M'", () => {
    expect(formatTokens(1234567)).toBe("1.2M");
  });
});

describe("modelDisplayName", () => {
  it.each<[string, string]>([
    ["claude-fable-5", "Fable 5"],
    ["claude-haiku-4-5", "Haiku 4.5"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-sonnet-4-5-20250929", "Sonnet 4.5"],
    ["claude-3-5-haiku", "Haiku 3.5"],
    ["claude-fable-5[1m]", "Fable 5"],
  ])("formats %s as %s", (input, expected) => {
    expect(modelDisplayName(input)).toBe(expected);
  });
});

describe("formatSummary", () => {
  it("builds the golden title with cost, yen amount, and the '+1' extra-model suffix", () => {
    const { title } = formatSummary(baseRecord, baseConfig);
    expect(title).toBe("💰 API換算 $0.267(¥40)| Fable 5 +1");
  });

  it("computes the cache percentage and appends today's running total", () => {
    const { body } = formatSummary(baseRecord, baseConfig, 12.34);
    const [line1] = body.split("\n");
    expect(line1).toBe("in 63.1k(cache 98%)/ out 700 · 📁 proj · 今日: $12.34");
  });

  it("omits the daily total when todayUSD is not provided", () => {
    const { body } = formatSummary(baseRecord, baseConfig);
    const [line1] = body.split("\n");
    expect(line1).not.toContain("今日");
  });

  it("flattens newlines and truncates the prompt to 50 characters with an ellipsis", () => {
    const { body } = formatSummary(baseRecord, baseConfig);
    const [, line2] = body.split("\n");
    expect(line2).toBe(`${"X".repeat(20)} ${"X".repeat(29)}…`);
  });

  it('falls back to "(プロンプトなし)" when the prompt is empty', () => {
    const { body } = formatSummary({ ...baseRecord, prompt: "" }, baseConfig);
    const [, line2] = body.split("\n");
    expect(line2).toBe("(プロンプトなし)");
  });
});

// ============ notify/util.ts ============

describe("notify/util", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "acn-util-"));
    process.env.ACN_HOME = tmpHome;
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.ACN_HOME;
  });

  it("acnHome creates the data directory and returns its path", () => {
    const home = acnHome();
    expect(home).toBe(tmpHome);
    expect(existsSync(home)).toBe(true);
  });

  it("appendNotifyError appends a '[ISO] [context] message' line and never throws", () => {
    expect(() => appendNotifyError("ctx", new Error("boom"))).not.toThrow();
    const log = readFileSync(join(tmpHome, "error.log"), "utf8");
    expect(log).toMatch(/^\[[^\]]+\] \[ctx\] boom\n$/);
  });

  it("writeDryRun merges per-channel keys instead of overwriting the whole file", () => {
    writeDryRun("os", { a: 1 });
    writeDryRun("slack", { b: 2 });
    const parsed = JSON.parse(readFileSync(join(tmpHome, "last-notify.json"), "utf8"));
    expect(parsed.os.a).toBe(1);
    expect(parsed.slack.b).toBe(2);
    expect(typeof parsed.os.ts).toBe("string");
    expect(typeof parsed.slack.ts).toBe("string");
  });
});

// ============ notify/os.ts ============

describe("notifyOS", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "acn-notify-os-"));
    process.env.ACN_HOME = tmpHome;
    delete process.env.ACN_DRY_RUN;
    mockNotify.mockReset();
    mockNotify.mockImplementation((_opts: unknown, cb?: (err: Error | null, response?: string) => void) => {
      cb?.(null, "ok");
    });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.ACN_HOME;
    delete process.env.ACN_DRY_RUN;
  });

  it("writes title/body under the 'os' key in last-notify.json during DRY_RUN", async () => {
    process.env.ACN_DRY_RUN = "1";
    await notifyOS(baseRecord, baseConfig);

    const parsed = JSON.parse(readFileSync(join(tmpHome, "last-notify.json"), "utf8"));
    expect(parsed.os.title).toBe("💰 API換算 $0.267(¥40)| Fable 5 +1");
    expect(typeof parsed.os.body).toBe("string");
    expect(typeof parsed.os.ts).toBe("string");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does nothing when cfg.notify.os is false", async () => {
    const cfgDisabled: Config = { ...baseConfig, notify: { os: false, slack: null } };
    await notifyOS(baseRecord, cfgDisabled);

    expect(existsSync(join(tmpHome, "last-notify.json"))).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("resolves even when node-notifier reports an error", async () => {
    mockNotify.mockImplementation((_opts: unknown, cb?: (err: Error | null, response?: string) => void) => {
      cb?.(new Error("native notifier boom"), "");
    });

    await expect(notifyOS(baseRecord, baseConfig)).resolves.toBeUndefined();

    const errLog = readFileSync(join(tmpHome, "error.log"), "utf8");
    expect(errLog).toContain("notifyOS");
    expect(errLog).toContain("native notifier boom");
  });

  it("resolves after the 3s timeout if node-notifier never calls back", async () => {
    vi.useFakeTimers();
    try {
      mockNotify.mockImplementation(() => {
        // コールバックを一切呼ばないことでハングを再現する。
      });
      const pending = notifyOS(baseRecord, baseConfig);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    const errLog = readFileSync(join(tmpHome, "error.log"), "utf8");
    expect(errLog).toContain("notifyOS");
  });
});

// ============ notify/slack.ts ============

describe("notifySlack", () => {
  let tmpHome: string;
  const slackConfig: Config = {
    ...baseConfig,
    notify: { os: false, slack: { webhookUrl: "https://hooks.example.com/services/T000/B000/XXXX", promptChars: 10, sendFullPrompt: false } },
  };

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "acn-notify-slack-"));
    process.env.ACN_HOME = tmpHome;
    delete process.env.ACN_DRY_RUN;
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.ACN_HOME;
    delete process.env.ACN_DRY_RUN;
  });

  it("writes header/section/context blocks and truncates the prompt during DRY_RUN", async () => {
    process.env.ACN_DRY_RUN = "1";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await notifySlack(baseRecord, slackConfig);

    const expected = formatSummary(baseRecord, slackConfig);
    const expectedLine1 = expected.body.split("\n")[0];

    const parsed = JSON.parse(readFileSync(join(tmpHome, "last-notify.json"), "utf8"));
    const blocks = parsed.slack.payload.blocks;

    expect(blocks).toEqual([
      { type: "header", text: { type: "plain_text", text: expected.title } },
      { type: "section", text: { type: "mrkdwn", text: expectedLine1 } },
      { type: "context", elements: [{ type: "mrkdwn", text: "X".repeat(10) }] },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the full prompt when sendFullPrompt is true", async () => {
    process.env.ACN_DRY_RUN = "1";
    vi.stubGlobal("fetch", vi.fn());

    const fullPromptConfig: Config = {
      ...slackConfig,
      notify: { os: false, slack: { ...slackConfig.notify.slack!, sendFullPrompt: true } },
    };
    await notifySlack(baseRecord, fullPromptConfig);

    const parsed = JSON.parse(readFileSync(join(tmpHome, "last-notify.json"), "utf8"));
    expect(parsed.slack.payload.blocks[2].elements[0].text).toBe(longPrompt);
  });

  it("resolves without throwing when the webhook responds with a non-2xx status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifySlack(baseRecord, slackConfig)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const errLog = readFileSync(join(tmpHome, "error.log"), "utf8");
    expect(errLog).toContain("notifySlack");
  });

  it("resolves without throwing when fetch throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(notifySlack(baseRecord, slackConfig)).resolves.toBeUndefined();

    const errLog = readFileSync(join(tmpHome, "error.log"), "utf8");
    expect(errLog).toContain("notifySlack");
    expect(errLog).toContain("network down");
  });

  it("does not call fetch when there is no webhook configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const cfgNoSlack: Config = { ...slackConfig, notify: { os: false, slack: null } };
    await notifySlack(baseRecord, cfgNoSlack);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(tmpHome, "last-notify.json"))).toBe(false);
  });
});
