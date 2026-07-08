import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTurn,
  loadCursor,
  logError,
  paths,
  readConfig,
  readTurns,
  sanitizeCursor,
  saveCursor,
  todayTotalUSD,
} from "../src/store";
import { DEFAULT_CONFIG } from "../src/types";
import type { Cursor, TurnRecord } from "../src/types";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "cccn-store-test-"));
  process.env.CCCN_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.CCCN_HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

function makeTurnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    sessionId: "sess-1",
    project: "/tmp/proj",
    gitBranch: "main",
    models: ["claude-fable-5"],
    tokens: { input: 10, output: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    sidechainTokens: null,
    apiCalls: 1,
    costUSD: 0.01,
    costJPY: 1.5,
    fxRate: 150,
    fxSource: "fixed",
    prompt: "test prompt",
    ...overrides,
  };
}

function makeCursor(overrides: Partial<Cursor> = {}): Cursor {
  return {
    offset: 100,
    lastUuid: "uuid-1",
    lastTs: new Date().toISOString(),
    seenMessageKeys: ["m1:r1", "m2:r2"],
    ...overrides,
  };
}

describe("paths", () => {
  it("CCCN_HOME を反映してディレクトリを自動作成し、呼び出しのたびに評価する", () => {
    const nestedHome = join(tmpHome, "nested", "home");
    process.env.CCCN_HOME = nestedHome;
    expect(existsSync(nestedHome)).toBe(false);

    const p = paths();

    expect(p.home).toBe(nestedHome);
    expect(p.configFile).toBe(join(nestedHome, "config.json"));
    expect(p.historyFile).toBe(join(nestedHome, "history.jsonl"));
    expect(p.cursorsFile).toBe(join(nestedHome, "cursors.json"));
    expect(p.cacheDir).toBe(join(nestedHome, "cache"));
    expect(p.errorLog).toBe(join(nestedHome, "error.log"));
    expect(p.lastNotifyFile).toBe(join(nestedHome, "last-notify.json"));

    // 存在しないネストしたディレクトリでも自動作成される(冪等)
    expect(existsSync(nestedHome)).toBe(true);
    expect(existsSync(p.cacheDir)).toBe(true);
    expect(() => paths()).not.toThrow();

    // env を変えると、モジュールロード時ではなく呼び出し時に再評価される
    const otherHome = mkdtempSync(join(tmpdir(), "cccn-store-test-other-"));
    try {
      process.env.CCCN_HOME = otherHome;
      const p2 = paths();
      expect(p2.home).toBe(otherHome);
      expect(p2.home).not.toBe(p.home);
      expect(existsSync(otherHome)).toBe(true);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });
});

describe("readConfig", () => {
  it("config.json が無ければ DEFAULT_CONFIG のディープコピーを返す", () => {
    const cfg = readConfig();

    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg).not.toBe(DEFAULT_CONFIG);
    expect(cfg.notify).not.toBe(DEFAULT_CONFIG.notify);
    expect(cfg.fx).not.toBe(DEFAULT_CONFIG.fx);
  });

  it("部分的な config は既知キーを深マージし、欠損キーはデフォルト補完する", () => {
    const p = paths();
    writeFileSync(p.configFile, JSON.stringify({ minNotifyUSD: 0.05 }), "utf8");

    const cfg = readConfig();

    expect(cfg).toEqual({ ...DEFAULT_CONFIG, minNotifyUSD: 0.05 });
  });

  it("notify.slack が null でもユーザー値として尊重される", () => {
    const p = paths();
    writeFileSync(
      p.configFile,
      JSON.stringify({ notify: { os: false, slack: null } }),
      "utf8",
    );

    const cfg = readConfig();

    expect(cfg.notify).toEqual({ os: false, slack: null });
    expect(cfg.minNotifyUSD).toBe(DEFAULT_CONFIG.minNotifyUSD);
    expect(cfg.fx).toEqual(DEFAULT_CONFIG.fx);
  });

  it("notify.slack にオブジェクトを指定すればそのまま採用される", () => {
    const p = paths();
    const slack = { webhookUrl: "https://example.com/hook", promptChars: 200, sendFullPrompt: true };
    writeFileSync(p.configFile, JSON.stringify({ notify: { slack } }), "utf8");

    const cfg = readConfig();

    expect(cfg.notify).toEqual({ os: DEFAULT_CONFIG.notify.os, slack });
  });

  it("fx の一部だけ指定した場合、残りはデフォルト補完される", () => {
    const p = paths();
    writeFileSync(p.configFile, JSON.stringify({ fx: { cacheHours: 24 } }), "utf8");

    const cfg = readConfig();

    expect(cfg.fx).toEqual({ fallbackRate: DEFAULT_CONFIG.fx.fallbackRate, cacheHours: 24 });
  });

  it("dashboard の一部だけ指定した場合、残りはデフォルト補完される", () => {
    const p = paths();
    writeFileSync(p.configFile, JSON.stringify({ dashboard: { autoReloadSec: 60 } }), "utf8");

    const cfg = readConfig();

    expect(cfg.dashboard).toEqual({
      autoRegenerate: DEFAULT_CONFIG.dashboard.autoRegenerate,
      autoReloadSec: 60,
      days: DEFAULT_CONFIG.dashboard.days,
    });
  });

  it("dashboard キーの無い旧 config はデフォルトで dashboard を補完する", () => {
    const p = paths();
    writeFileSync(p.configFile, JSON.stringify({ minNotifyUSD: 0.05 }), "utf8");

    const cfg = readConfig();

    expect(cfg.dashboard).toEqual(DEFAULT_CONFIG.dashboard);
  });

  it("破損 JSON なら DEFAULT_CONFIG を返し、元ファイルは変更せず error.log に記録する", () => {
    const p = paths();
    const brokenJson = "{ this is not valid json";
    writeFileSync(p.configFile, brokenJson, "utf8");

    const cfg = readConfig();

    expect(cfg).toEqual(DEFAULT_CONFIG);
    // ユーザーのファイルを勝手に修復・上書きしない
    expect(readFileSync(p.configFile, "utf8")).toBe(brokenJson);

    const errLog = readFileSync(p.errorLog, "utf8");
    expect(errLog).toContain("[readConfig]");
  });
});

describe("cursor (loadCursor / saveCursor)", () => {
  it("save したものを load すると往復一致する", () => {
    const c = makeCursor({ offset: 42 });
    saveCursor("/tmp/transcript-a.jsonl", c);

    expect(loadCursor("/tmp/transcript-a.jsonl")).toEqual(c);
  });

  it("複数の transcript キーが共存できる", () => {
    const cA = makeCursor({ offset: 1, lastUuid: "a" });
    const cB = makeCursor({ offset: 2, lastUuid: "b" });

    saveCursor("/tmp/a.jsonl", cA);
    saveCursor("/tmp/b.jsonl", cB);

    expect(loadCursor("/tmp/a.jsonl")).toEqual(cA);
    expect(loadCursor("/tmp/b.jsonl")).toEqual(cB);

    const p = paths();
    const raw = JSON.parse(readFileSync(p.cursorsFile, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["/tmp/a.jsonl", "/tmp/b.jsonl"]);
  });

  it("save 後に cursors.json.tmp が残らない", () => {
    saveCursor("/tmp/transcript-a.jsonl", makeCursor());

    const p = paths();
    expect(existsSync(`${p.cursorsFile}.tmp`)).toBe(false);
    expect(existsSync(p.cursorsFile)).toBe(true);
  });

  it("cursors.json が破損していれば null を返し、error.log に記録する", () => {
    const p = paths();
    writeFileSync(p.cursorsFile, "not valid json {{{", "utf8");

    const loaded = loadCursor("/tmp/whatever.jsonl");

    expect(loaded).toBeNull();
    const errLog = readFileSync(p.errorLog, "utf8");
    expect(errLog).toContain("[loadCursor]");
  });

  it("未登録の transcriptPath は破損ではないため null かつエラーログなし", () => {
    saveCursor("/tmp/a.jsonl", makeCursor());

    expect(loadCursor("/tmp/unknown.jsonl")).toBeNull();

    const p = paths();
    expect(existsSync(p.errorLog)).toBe(false);
  });
});

describe("sanitizeCursor", () => {
  it("正しい形のカーソルはそのまま正規化して返す(往復一致)", () => {
    const c: Cursor = {
      offset: 42,
      lastUuid: "uuid-x",
      lastTs: "2026-07-06T10:00:00.000Z",
      seenMessageKeys: ["m1:r1", "m2:r2"],
    };
    expect(sanitizeCursor(c)).toEqual(c);
    // lastUuid / lastTs が null でも許容される。
    expect(sanitizeCursor({ offset: 0, lastUuid: null, lastTs: null, seenMessageKeys: [] })).toEqual({
      offset: 0,
      lastUuid: null,
      lastTs: null,
      seenMessageKeys: [],
    });
  });

  it("オブジェクトでない / offset が数値でない場合は null に落とす", () => {
    expect(sanitizeCursor(null)).toBeNull();
    expect(sanitizeCursor("string")).toBeNull();
    expect(sanitizeCursor([1, 2, 3])).toBeNull();
    expect(sanitizeCursor({ offset: "abc", lastUuid: null, lastTs: null, seenMessageKeys: [] })).toBeNull();
    expect(
      sanitizeCursor({ offset: Number.NaN, lastUuid: null, lastTs: null, seenMessageKeys: [] }),
    ).toBeNull();
  });

  it("seenMessageKeys が配列でない / 非文字列要素を含む場合は null に落とす", () => {
    expect(sanitizeCursor({ offset: 1, lastUuid: null, lastTs: null, seenMessageKeys: 42 })).toBeNull();
    expect(
      sanitizeCursor({ offset: 1, lastUuid: null, lastTs: null, seenMessageKeys: ["ok", 123] }),
    ).toBeNull();
    // lastUuid / lastTs が string|null 以外でも null。
    expect(sanitizeCursor({ offset: 1, lastUuid: 5, lastTs: null, seenMessageKeys: [] })).toBeNull();
    expect(sanitizeCursor({ offset: 1, lastUuid: null, lastTs: {}, seenMessageKeys: [] })).toBeNull();
  });
});

describe("turns (appendTurn / readTurns / todayTotalUSD)", () => {
  it("3件 append すると readTurns() で全件読める", () => {
    const r1 = makeTurnRecord({ sessionId: "s1" });
    const r2 = makeTurnRecord({ sessionId: "s2" });
    const r3 = makeTurnRecord({ sessionId: "s3" });

    appendTurn(r1);
    appendTurn(r2);
    appendTurn(r3);

    expect(readTurns()).toEqual([r1, r2, r3]);
  });

  it("days を指定すると期限より古い record は除外される", () => {
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 86400000);

    const oldRecord = makeTurnRecord({ sessionId: "old", ts: tenDaysAgo.toISOString() });
    const recentRecord = makeTurnRecord({ sessionId: "recent", ts: now.toISOString() });

    appendTurn(oldRecord);
    appendTurn(recentRecord);

    expect(readTurns(5)).toEqual([recentRecord]);
  });

  it("破損行が混ざっていても他の行は読める(破損行は黙殺)", () => {
    const p = paths();
    const r1 = makeTurnRecord({ sessionId: "s1" });
    const r2 = makeTurnRecord({ sessionId: "s2" });

    appendTurn(r1);
    appendFileSync(p.historyFile, "not valid json\n", "utf8");
    appendTurn(r2);

    expect(readTurns()).toEqual([r1, r2]);
  });

  it("todayTotalUSD はローカルタイムゾーンで今日の costUSD のみ合算する", () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);

    appendTurn(makeTurnRecord({ sessionId: "today-1", ts: now.toISOString(), costUSD: 0.05 }));
    appendTurn(makeTurnRecord({ sessionId: "today-2", ts: now.toISOString(), costUSD: 0.07 }));
    appendTurn(
      makeTurnRecord({ sessionId: "yesterday", ts: yesterday.toISOString(), costUSD: 100 }),
    );

    expect(todayTotalUSD()).toBeCloseTo(0.12, 10);
  });
});

describe("logError", () => {
  it("[ISO時刻] [context] メッセージ の形式で記録し、スタックがあれば追記する", () => {
    const err = new Error("boom");
    logError("ctx1", err);

    const p = paths();
    const content = readFileSync(p.errorLog, "utf8");

    const headerMatch = content.match(/^\[([^\]]+)\] \[ctx1\] boom\n/);
    expect(headerMatch).not.toBeNull();
    expect(Number.isNaN(Date.parse(headerMatch![1]))).toBe(false);

    expect(err.stack).toBeDefined();
    expect(content).toContain(err.stack as string);
    expect(content.endsWith("\n")).toBe(true);
  });

  it("Error インスタンスでない値は String 化してメッセージにし、スタックは付与しない", () => {
    logError("ctx2", "plain string error");

    const p = paths();
    const content = readFileSync(p.errorLog, "utf8");

    expect(content).toMatch(/^\[[^\]]+\] \[ctx2\] plain string error\n$/);
  });

  it("logError は例外を投げない(壊れた err でも throw しない)", () => {
    expect(() => logError("ctx3", undefined)).not.toThrow();
    expect(() => logError("ctx4", { weird: "object" })).not.toThrow();
  });

  it("error.log が1MBを超えていれば追記前に error.log.old へローテーションする", () => {
    const p = paths();
    const bigContent = "x".repeat(1024 * 1024 + 1000);
    writeFileSync(p.errorLog, bigContent, "utf8");

    logError("after-rotation", new Error("trigger"));

    expect(existsSync(`${p.errorLog}.old`)).toBe(true);
    expect(statSync(`${p.errorLog}.old`).size).toBe(Buffer.byteLength(bigContent, "utf8"));

    const newContent = readFileSync(p.errorLog, "utf8");
    expect(newContent).toContain("[after-rotation]");
    expect(newContent.length).toBeLessThan(5000);
  });

  it("既存の error.log.old は上書きされる", () => {
    const p = paths();
    const bigContent = "y".repeat(1024 * 1024 + 500);
    writeFileSync(p.errorLog, bigContent, "utf8");
    writeFileSync(`${p.errorLog}.old`, "OLD_MARKER", "utf8");

    logError("rotate-again", new Error("trigger2"));

    const oldContent = readFileSync(`${p.errorLog}.old`, "utf8");
    expect(oldContent).toBe(bigContent);
    expect(oldContent).not.toContain("OLD_MARKER");
  });

  it("1MB 以下なら追記前のローテーションは発生しない", () => {
    const p = paths();
    const smallContent = "z".repeat(1000);
    writeFileSync(p.errorLog, smallContent, "utf8");

    logError("no-rotation", new Error("small"));

    expect(existsSync(`${p.errorLog}.old`)).toBe(false);
    const content = readFileSync(p.errorLog, "utf8");
    expect(content.startsWith(smallContent)).toBe(true);
    expect(content).toContain("[no-rotation]");
  });
});
