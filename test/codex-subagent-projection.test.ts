import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDashboard } from "../src/dashboard";
import { runReport } from "../src/report";
import { appendTurn, paths, readTurns } from "../src/store";
import { runTrack } from "../src/track";
import {
  openCodexRootContext,
  readCodexSubagentActivity,
  recordCodexSubagentEvent,
  validateCodexSubagentPayload,
} from "../src/codex/subagent-store";
import type { TurnRecord } from "../src/types";

const ROLLOUT = fileURLToPath(new URL("./fixtures/codex/rollout-basic.jsonl", import.meta.url));
const STOP = fileURLToPath(new URL("./fixtures/codex/stop-payload.json", import.meta.url));

let home: string;
let activeRootKey: string;

function parentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...JSON.parse(readFileSync(STOP, "utf8")), ...overrides } as Record<string, unknown>;
}

function agentPayload(
  kind: "SubagentStart" | "SubagentStop",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...parentPayload(),
    hook_event_name: kind,
    agent_id: "private-agent-a",
    agent_type: "explorer",
    ...overrides,
  };
}

function observe(kind: "SubagentStart" | "SubagentStop", overrides: Record<string, unknown> = {}): string {
  const event = validateCodexSubagentPayload(agentPayload(kind, overrides))!;
  const state = recordCodexSubagentEvent(event, { observedAt: "2026-07-13T00:00:00.000Z" });
  return state?.projectionKey ?? activeRootKey;
}

function makeRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    sessionId: "stored-session",
    project: "/tmp/project",
    gitBranch: null,
    models: ["gpt-5.5"],
    tokens: { input: 10, output: 2, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    sidechainTokens: null,
    apiCalls: 1,
    costUSD: 0.25,
    costByModel: { "gpt-5.5": 0.25 },
    costJPY: 37.5,
    fxRate: 150,
    fxSource: "fixed",
    prompt: "private prompt",
    source: "codex",
    ...overrides,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cccn-codex-projection-"));
  process.env.CCCN_HOME = home;
  process.env.CCCN_DRY_RUN = "1";
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  activeRootKey = openCodexRootContext({
    ...parentPayload(),
    hook_event_name: "UserPromptSubmit",
  }, { observedAt: "2026-07-13T00:00:00.000Z" })!;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.CCCN_HOME;
  delete process.env.CCCN_DRY_RUN;
  rmSync(home, { recursive: true, force: true });
});

describe("Codex subagent activity projection", () => {
  it("before-parent activityだけが匿名projectionKeyとして通常Codex履歴へ保存される", async () => {
    const key = observe("SubagentStart");
    expect(existsSync(paths().historyFile)).toBe(false);
    expect(existsSync(join(home, "report.html"))).toBe(false);
    const rollout = join(home, "rollout.jsonl");
    copyFileSync(ROLLOUT, rollout);
    await runTrack(JSON.stringify(parentPayload({ transcript_path: rollout })), { codex: true });

    const raw = readFileSync(paths().historyFile, "utf8");
    const stored = JSON.parse(raw) as TurnRecord;
    expect(stored.activityProjectionKey).toBe(key);
    expect(stored.subagentActivity).toBeUndefined();
    // sessionIdは既存TurnRecord契約で以前から保存される。activity投影が新たに持ち込む
    // turn/agent IDやtranscript pathは保存しない。
    for (const forbidden of ["01234567-bbbb", "private-agent-a", "rollout.jsonl"])
      expect(raw).not.toContain(forbidden);

    expect(readTurns()[0].subagentActivity).toEqual({
      started: 1,
      stopped: 0,
      agentTypes: ["explorer"],
      usageStatus: "unavailable",
    });
  });

  it("activityなし・別turn・Claude・旧recordは変えない", async () => {
    const otherKey = observe("SubagentStart", { turn_id: "other-turn" });
    appendTurn(makeRecord({
      // runtime-only値が誤ってwriterへ渡っても永続化・再利用されない。
      subagentActivity: { started: 99, stopped: 99, agentTypes: ["worker"], usageStatus: "partial" },
    }));
    appendTurn(makeRecord({ source: undefined, activityProjectionKey: otherKey }));
    appendTurn(makeRecord({ source: "codex", activityProjectionKey: "f".repeat(64) }));
    const rows = readTurns();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.subagentActivity === undefined)).toBe(true);
    expect(readFileSync(paths().historyFile, "utf8")).not.toContain("subagentActivity");
  });

  it("親Stop後の既知agent late Stopはhistory不変のまま元turnへ投影する", async () => {
    const key = observe("SubagentStart", { turn_id: "child-turn-X" });
    const rollout = join(home, "rollout.jsonl");
    copyFileSync(ROLLOUT, rollout);
    await runTrack(JSON.stringify(parentPayload({ transcript_path: rollout })), { codex: true });
    const historyBefore = readFileSync(paths().historyFile, "utf8");
    const dashboardBefore = readFileSync(join(home, "report.html"), "utf8");
    const notifyBefore = readFileSync(join(home, "last-notify.json"), "utf8");
    const stored = JSON.parse(historyBefore) as TurnRecord;
    expect(stored.activityProjectionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(readTurns()[0].subagentActivity).toMatchObject({ started: 1, stopped: 0 });
    expect(readTurns()).toHaveLength(1);
    expect(key).toBe(stored.activityProjectionKey);
    expect(readFileSync(paths().historyFile, "utf8")).toBe(historyBefore);
    expect(readFileSync(join(home, "report.html"), "utf8")).toBe(dashboardBefore);
    expect(readFileSync(join(home, "last-notify.json"), "utf8")).toBe(notifyBefore);
    observe("SubagentStop", { turn_id: "child-turn-Y" });
    observe("SubagentStop", { turn_id: "child-turn-Y" });
    const projected = readTurns();
    expect(readFileSync(paths().historyFile, "utf8")).toBe(historyBefore);
    expect(projected).toHaveLength(1);
    expect(projected[0].subagentActivity).toEqual({
      started: 1, stopped: 1, agentTypes: ["explorer"], usageStatus: "unavailable",
    });
    expect(projected[0].costUSD).toBe(stored.costUSD);
    expect(projected[0].costJPY).toBe(stored.costJPY);
    expect(projected[0].subagents).toBeUndefined();
    expect(projected[0].unknownModels).toEqual(stored.unknownModels);
  });

  it("activityが最後まで無いvalid親turnはkeyだけを持ち、report/dashboardへ利用表示を出さない", async () => {
    const rollout = join(home, "rollout-unused.jsonl");
    copyFileSync(ROLLOUT, rollout);
    await runTrack(JSON.stringify(parentPayload({ transcript_path: rollout })), { codex: true });
    const raw = readFileSync(paths().historyFile, "utf8");
    const stored = JSON.parse(raw) as TurnRecord;
    expect(stored.activityProjectionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(readTurns()[0].subagentActivity).toBeUndefined();
    const emptyLedger = JSON.parse(readFileSync(join(home, "codex-subagent-activity.json"), "utf8")) as {
      keyCheck?: string;
      roots: Record<string, { agents: Record<string, unknown> }>;
    };
    expect(emptyLedger.keyCheck).toMatch(/^[a-f0-9]{64}$/);
    expect(emptyLedger.roots[stored.activityProjectionKey!].agents).toEqual({});

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    await runReport(["--days", "9999"]);
    expect(logs.join("\n")).not.toContain("Codexサブエージェント利用あり");
    logs.length = 0;
    await runReport(["--days", "9999", "--json"]);
    const reportJson = JSON.parse(logs.join("\n")) as { total: Record<string, unknown> };
    expect(reportJson.total.turns).toBe(1);
    expect(reportJson.total.costUSD).toBe(stored.costUSD);
    expect(reportJson.total.codexSubagentActivity).toBeUndefined();

    const html = readFileSync(join(home, "report.html"), "utf8");
    expect(html).not.toContain(stored.activityProjectionKey!);
    const open = '<script id="cccn-data" type="application/json">';
    const embedded = JSON.parse(html.slice(html.indexOf(open) + open.length, html.indexOf("</script>", html.indexOf(open)))) as {
      turns: Array<{ ca?: unknown; um: number }>;
    };
    expect(embedded.turns).toHaveLength(1);
    expect(embedded.turns[0].ca).toBeUndefined();
    expect(embedded.turns[0].um).toBe(stored.costUSD);
  });

  it("未知late eventを捨て、次rootのchild turnが異なっても正しく関連付ける", async () => {
    const rolloutA = join(home, "rollout-a.jsonl");
    copyFileSync(ROLLOUT, rolloutA);
    await runTrack(JSON.stringify(parentPayload({ transcript_path: rolloutA, turn_id: "turn-a" })), { codex: true });
    const keyA = (JSON.parse(readFileSync(paths().historyFile, "utf8")) as TurnRecord).activityProjectionKey;

    observe("SubagentStart", { agent_id: "unknown-late", turn_id: "old-child" });
    activeRootKey = openCodexRootContext({
      ...parentPayload({ turn_id: "turn-b" }),
      hook_event_name: "UserPromptSubmit",
    })!;
    const keyB = observe("SubagentStart", { turn_id: "child-turn-X" });
    observe("SubagentStop", { turn_id: "child-turn-Y" });
    observe("SubagentStart", { session_id: "other-session", turn_id: "child-other" });
    expect(keyB).not.toBe(keyA);
    expect(readTurns()[0].subagentActivity).toBeUndefined();

    const rolloutB = join(home, "rollout-b.jsonl");
    copyFileSync(ROLLOUT, rolloutB);
    await runTrack(JSON.stringify(parentPayload({ transcript_path: rolloutB, turn_id: "turn-b" })), { codex: true });
    const rows = readTurns();
    expect(rows).toHaveLength(2);
    expect(rows[0].subagentActivity).toBeUndefined();
    expect(rows[1].activityProjectionKey).toBe(keyB);
    expect(rows[1].subagentActivity).toMatchObject({ started: 1, stopped: 1 });
  });

  it("invalid parent identityはkeyを推測せずmain recordだけを継続する", async () => {
    const invalids: Array<Record<string, unknown>> = [
      { session_id: undefined }, { session_id: "" }, { session_id: 7 }, { session_id: "x".repeat(1025) },
      { turn_id: undefined }, { turn_id: "" }, { turn_id: 7 }, { turn_id: "x".repeat(1025) },
    ];
    for (let i = 0; i < invalids.length; i++) {
      const rollout = join(home, `rollout-invalid-${i}.jsonl`);
      copyFileSync(ROLLOUT, rollout);
      await runTrack(JSON.stringify(parentPayload({ transcript_path: rollout, ...invalids[i] })), { codex: true });
    }
    const rows = readTurns();
    expect(rows).toHaveLength(invalids.length);
    expect(rows.every((row) => row.source === "codex" && row.activityProjectionKey === undefined)).toBe(true);
  });

  it("late eventをhistory無変更のpure mergeで元recordだけへ反映する", () => {
    const key = observe("SubagentStart");
    appendTurn(makeRecord({ activityProjectionKey: key }));
    appendTurn(makeRecord({ prompt: "next turn" }));
    const before = readFileSync(paths().historyFile, "utf8");

    observe("SubagentStop");
    const rows = readTurns();
    expect(readFileSync(paths().historyFile, "utf8")).toBe(before);
    expect(rows).toHaveLength(2);
    expect(rows[0].subagentActivity).toMatchObject({ started: 1, stopped: 1 });
    expect(rows[1].subagentActivity).toBeUndefined();
    expect(rows.reduce((sum, r) => sum + r.costUSD + (r.subagents?.costUSD ?? 0), 0)).toBe(0.5);
  });

  it("再送・既知Stopを投影し、未割当Stopはactive rootにも割り当てない", () => {
    const key = observe("SubagentStart", { agent_id: "a", agent_type: "worker" });
    observe("SubagentStart", { agent_id: "a", agent_type: "worker" });
    observe("SubagentStop", { agent_id: "b", agent_type: "<script>alert(1)</script>" });
    observe("SubagentStart", { agent_id: "c", agent_type: "<script>alert(1)</script>" });
    observe("SubagentStop", { agent_id: "c", agent_type: "<script>alert(1)</script>" });
    appendTurn(makeRecord({ activityProjectionKey: key }));
    expect(readTurns()[0].subagentActivity).toEqual({
      started: 2,
      stopped: 1,
      agentTypes: ["unknown", "worker"],
      usageStatus: "unavailable",
    });
  });

  it("破損ledgerはfail-closedで投影せず履歴・コストを変えない", () => {
    appendTurn(makeRecord({ activityProjectionKey: "a".repeat(64) }));
    writeFileSync(join(home, "codex-subagent-activity.json"), "{broken", "utf8");
    const rows = readTurns();
    expect(rows).toHaveLength(1);
    expect(rows[0].subagentActivity).toBeUndefined();
    expect(rows[0].costUSD).toBe(0.25);
  });

  it("v1完全一致Historyだけをlegacy projectionし、不一致recordへ推測再割当しない", () => {
    const legacy = {
      schemaVersion: 1,
      projectionKey: "c".repeat(64),
      agentKey: "d".repeat(64),
      agentTypeLabel: "reviewer",
      startObserved: true,
      stopObserved: true,
      firstObservedAt: "2026-07-13T00:00:00.000Z",
      lastObservedAt: "2026-07-13T00:00:01.000Z",
    };
    writeFileSync(
      join(home, "codex-subagent-activity.json"),
      `${JSON.stringify({ schemaVersion: 1, agents: { [legacy.agentKey]: legacy } })}\n`,
    );
    appendTurn(makeRecord({ activityProjectionKey: legacy.projectionKey }));
    appendTurn(makeRecord({ activityProjectionKey: "e".repeat(64), prompt: "mismatch" }));

    openCodexRootContext({
      ...parentPayload({ turn_id: "migration-root" }),
      hook_event_name: "UserPromptSubmit",
    });
    const rows = readTurns();
    expect(rows[0].subagentActivity).toEqual({
      started: 1,
      stopped: 1,
      agentTypes: ["reviewer"],
      usageStatus: "unavailable",
    });
    expect(rows[1].subagentActivity).toBeUndefined();
  });

  it("report/dashboardは利用あり・料金未集計を示し、key・ID・path・料金へ混ぜない", async () => {
    const key = observe("SubagentStart", { agent_type: "<img src=x onerror=alert(1)>" });
    appendTurn(makeRecord({ activityProjectionKey: key }));

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    await runReport(["--days", "9999"]);
    expect(logs.join("\n")).toContain("Codexサブエージェント利用あり");
    expect(logs.join("\n")).toContain("料金未集計");
    expect(logs.join("\n")).not.toContain(key);

    logs.length = 0;
    await runReport(["--days", "9999", "--json"]);
    const reportJson = JSON.parse(logs.join("\n")) as {
      total: { costUSD: number; subagentsUSD: number; codexSubagentActivity: unknown };
    };
    expect(reportJson.total.costUSD).toBe(0.25);
    expect(reportJson.total.subagentsUSD).toBe(0);
    expect(reportJson.total.codexSubagentActivity).toEqual({
      turns: 1, started: 1, stopped: 0, usageStatus: "unavailable",
    });

    vi.mocked(console.log).mockClear();
    await runDashboard(["--no-open"]);
    const html = readFileSync(join(home, "report.html"), "utf8");
    expect(html).toContain("利用あり・料金未集計");
    expect(html).not.toContain(key);
    expect(html).not.toContain("private-agent-a");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain('"um":0.25');
    expect(html).not.toContain('"subagents"');
  });

  it("projection key生成失敗でもmain turn記録は止まらない", async () => {
    observe("SubagentStart");
    writeFileSync(join(home, "codex-subagent-key"), "broken", "utf8");
    const rollout = join(home, "rollout.jsonl");
    copyFileSync(ROLLOUT, rollout);
    await runTrack(JSON.stringify(parentPayload({ transcript_path: rollout })), { codex: true });
    expect(existsSync(paths().historyFile)).toBe(true);
    const stored = JSON.parse(readFileSync(paths().historyFile, "utf8")) as TurnRecord;
    expect(stored.source).toBe("codex");
    expect(stored.activityProjectionKey).toBeUndefined();
  });

  it("破損台帳の親Stopは未検証keyを付けずmain turnだけを記録する", async () => {
    observe("SubagentStart");
    writeFileSync(join(home, "codex-subagent-activity.json"), "{broken", "utf8");
    const rollout = join(home, "rollout.jsonl");
    copyFileSync(ROLLOUT, rollout);
    await runTrack(JSON.stringify(parentPayload({ transcript_path: rollout })), { codex: true });
    const stored = JSON.parse(readFileSync(paths().historyFile, "utf8")) as TurnRecord;
    expect(stored.source).toBe("codex");
    expect(stored.activityProjectionKey).toBeUndefined();
    expect(readTurns()[0].subagentActivity).toBeUndefined();
  });

  it("同長key置換中は既存identityを変えずmainだけ記録し、正しいkey復旧後に再接続する", async () => {
    const originalProjectionKey = observe("SubagentStart");
    const firstRollout = join(home, "rollout-first.jsonl");
    copyFileSync(ROLLOUT, firstRollout);
    await runTrack(JSON.stringify(parentPayload({ transcript_path: firstRollout })), { codex: true });

    const keyFile = join(home, "codex-subagent-key");
    const ledgerFile = join(home, "codex-subagent-activity.json");
    const validKey = readFileSync(keyFile);
    const ledgerBefore = readFileSync(ledgerFile, "utf8");
    const firstRecord = JSON.parse(readFileSync(paths().historyFile, "utf8").trim()) as TurnRecord;
    expect(firstRecord.activityProjectionKey).toBe(originalProjectionKey);

    const replacedKey = Buffer.alloc(32, 0xa5);
    writeFileSync(keyFile, replacedKey);
    const secondRollout = join(home, "rollout-second.jsonl");
    copyFileSync(ROLLOUT, secondRollout);
    await runTrack(JSON.stringify(parentPayload({ transcript_path: secondRollout, turn_id: "turn-second" })), { codex: true });

    const afterReplacement = readFileSync(paths().historyFile, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as TurnRecord,
    );
    expect(afterReplacement).toHaveLength(2);
    expect(afterReplacement[0]).toEqual(firstRecord);
    expect(afterReplacement[1].source).toBe("codex");
    expect(afterReplacement[1].activityProjectionKey).toBeUndefined();
    expect(readFileSync(keyFile)).toEqual(replacedKey);
    expect(readFileSync(ledgerFile, "utf8")).toBe(ledgerBefore);

    writeFileSync(keyFile, validKey);
    const thirdPayload = parentPayload({ turn_id: "turn-third" });
    const expectedRestoredKey = openCodexRootContext({ ...thirdPayload, hook_event_name: "UserPromptSubmit" });
    const thirdRollout = join(home, "rollout-third.jsonl");
    copyFileSync(ROLLOUT, thirdRollout);
    await runTrack(JSON.stringify({ ...thirdPayload, transcript_path: thirdRollout }), { codex: true });
    const restored = readFileSync(paths().historyFile, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as TurnRecord,
    );
    expect(restored).toHaveLength(3);
    expect(restored[0]).toEqual(firstRecord);
    expect(restored[2].activityProjectionKey).toBe(expectedRestoredKey);
    expect(readFileSync(ledgerFile, "utf8")).not.toBe(ledgerBefore);
  });

  it("keyCheck破損中はkey/ledgerを変更せずmainだけ記録し、台帳復旧後に再接続する", async () => {
    observe("SubagentStart");
    const keyFile = join(home, "codex-subagent-key");
    const ledgerFile = join(home, "codex-subagent-activity.json");
    const keyBefore = readFileSync(keyFile);
    const validLedger = readFileSync(ledgerFile, "utf8");
    const ledger = JSON.parse(validLedger) as { keyCheck: string };
    ledger.keyCheck = `${ledger.keyCheck[0] === "0" ? "1" : "0"}${ledger.keyCheck.slice(1)}`;
    const corruptLedger = `${JSON.stringify(ledger)}\n`;
    writeFileSync(ledgerFile, corruptLedger, "utf8");
    expect(readCodexSubagentActivity(activeRootKey)).toEqual([]);

    const brokenRollout = join(home, "rollout-broken-check.jsonl");
    copyFileSync(ROLLOUT, brokenRollout);
    await runTrack(JSON.stringify(parentPayload({ transcript_path: brokenRollout, turn_id: "turn-broken" })), { codex: true });
    const brokenRecord = JSON.parse(readFileSync(paths().historyFile, "utf8").trim()) as TurnRecord;
    expect(brokenRecord.source).toBe("codex");
    expect(brokenRecord.activityProjectionKey).toBeUndefined();
    expect(readFileSync(keyFile)).toEqual(keyBefore);
    expect(readFileSync(ledgerFile, "utf8")).toBe(corruptLedger);

    writeFileSync(ledgerFile, validLedger, "utf8");
    const restoredPayload = parentPayload({ turn_id: "turn-restored" });
    const expectedRestoredKey = openCodexRootContext({ ...restoredPayload, hook_event_name: "UserPromptSubmit" });
    const restoredRollout = join(home, "rollout-restored-check.jsonl");
    copyFileSync(ROLLOUT, restoredRollout);
    await runTrack(JSON.stringify({ ...restoredPayload, transcript_path: restoredRollout }), { codex: true });
    const restored = readFileSync(paths().historyFile, "utf8").trim().split("\n").map(
      (line) => JSON.parse(line) as TurnRecord,
    );
    expect(restored).toHaveLength(2);
    expect(restored[1].activityProjectionKey).toBe(expectedRestoredKey);
    expect(readFileSync(keyFile)).toEqual(keyBefore);
    expect(readFileSync(ledgerFile, "utf8")).not.toBe(validLedger);
  });
});
