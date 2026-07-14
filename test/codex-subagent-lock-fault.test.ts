import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fsFault = vi.hoisted(() => ({
  linkMode: "none" as "none" | "eperm-always" | "eexist-once" | "eexist-always",
  linkCalls: 0,
  renameDestination: null as string | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync(...args: Parameters<typeof actual.linkSync>) {
      fsFault.linkCalls += 1;
      if (fsFault.linkMode === "eperm-always") {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      if (fsFault.linkMode === "eexist-always" ||
        (fsFault.linkMode === "eexist-once" && fsFault.linkCalls === 1)) {
        throw Object.assign(new Error("canonical existed during publication"), { code: "EEXIST" });
      }
      return actual.linkSync(...args);
    },
    renameSync(...args: Parameters<typeof actual.renameSync>) {
      if (fsFault.renameDestination !== null && String(args[1]) === fsFault.renameDestination) {
        throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
      }
      return actual.renameSync(...args);
    },
  };
});

const ROLLOUT = fileURLToPath(new URL("./fixtures/codex/rollout-basic.jsonl", import.meta.url));
const STOP = fileURLToPath(new URL("./fixtures/codex/stop-payload.json", import.meta.url));

let home: string;

function stagingFiles(): string[] {
  return readdirSync(home).filter((name) => name.includes(".init-"));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cccn-codex-link-fault-"));
  process.env.CCCN_HOME = home;
  process.env.CCCN_DRY_RUN = "1";
  fsFault.linkMode = "eperm-always";
  fsFault.linkCalls = 0;
  fsFault.renameDestination = null;
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
});

afterEach(() => {
  fsFault.linkMode = "none";
  fsFault.renameDestination = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.CCCN_HOME;
  delete process.env.CCCN_DRY_RUN;
  rmSync(home, { recursive: true, force: true });
});

describe("Codex activity lock publication failure", () => {
  it("canonical不在のEPERMをcontention扱いせず即時fail-closedにしてstagingを残さない", async () => {
    const { acquireCodexActivityLock } = await import("../src/codex/subagent-store");
    const startedAt = Date.now();
    expect(() => acquireCodexActivityLock(500)).toThrow(/lock publication failed.*EPERM/);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(fsFault.linkCalls).toBe(1);
    expect(stagingFiles()).toEqual([]);
  });

  it("非EEXISTでもcanonical実在中だけは保守的contentionとして扱う", async () => {
    const canonical = join(home, "codex-subagent-activity.lock");
    mkdirSync(canonical);
    writeFileSync(join(canonical, "owner.json"), JSON.stringify({
      token: "a".repeat(32),
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    }));
    const { acquireCodexActivityLock } = await import("../src/codex/subagent-store");
    expect(() => acquireCodexActivityLock(40)).toThrow("activity lock timeout");
    expect(stagingFiles()).toEqual([]);
  });

  it("EEXIST直後にcanonicalが消えても通常contentionとして再試行し取得する", async () => {
    fsFault.linkMode = "eexist-once";
    const { acquireCodexActivityLock } = await import("../src/codex/subagent-store");
    const lock = acquireCodexActivityLock(250);
    expect(fsFault.linkCalls).toBe(2);
    expect(stagingFiles()).toEqual([]);
    lock.release();
  });

  it("EEXISTとcanonical不在が連続してもrecover continueがdeadlineを迂回しない", async () => {
    fsFault.linkMode = "eexist-always";
    const { acquireCodexActivityLock } = await import("../src/codex/subagent-store");
    const startedAt = Date.now();
    expect(() => acquireCodexActivityLock(40)).toThrow("activity lock timeout");
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(fsFault.linkCalls).toBeGreaterThan(1);
    expect(stagingFiles()).toEqual([]);
  });

  it("障害時もUserPrompt/SubagentStart/親Stop wireをbyte-exactかつ有界に返し、main履歴は継続する", async () => {
    const { runCodexPassiveHook } = await import("../src/cli");
    const stopPayload = JSON.parse(readFileSync(STOP, "utf8")) as Record<string, unknown>;
    const startPayload = {
      ...stopPayload,
      hook_event_name: "SubagentStart",
      agent_id: "private-agent",
      agent_type: "explorer",
    };

    const promptAt = Date.now();
    expect(await runCodexPassiveHook("UserPromptSubmit", JSON.stringify({
      ...stopPayload,
      hook_event_name: "UserPromptSubmit",
      prompt: "PRIVATE-PROMPT-CANARY",
    }))).toEqual(Buffer.alloc(0));
    expect(Date.now() - promptAt).toBeLessThan(500);
    expect(stagingFiles()).toEqual([]);

    const startAt = Date.now();
    expect(await runCodexPassiveHook("SubagentStart", JSON.stringify(startPayload))).toEqual(Buffer.alloc(0));
    expect(Date.now() - startAt).toBeLessThan(500);
    expect(stagingFiles()).toEqual([]);

    const rollout = join(home, "rollout.jsonl");
    copyFileSync(ROLLOUT, rollout);
    const stopAt = Date.now();
    expect(await runCodexPassiveHook("Stop", JSON.stringify({ ...stopPayload, transcript_path: rollout })))
      .toEqual(Buffer.from("{}\n"));
    expect(Date.now() - stopAt).toBeLessThan(500);
    expect(stagingFiles()).toEqual([]);

    const history = readFileSync(join(home, "history.jsonl"), "utf8").trim();
    const record = JSON.parse(history) as { source?: string; activityProjectionKey?: string };
    expect(record.source).toBe("codex");
    expect(record.activityProjectionKey).toBeUndefined();
  });

  it("key/ledgerのatomic rename失敗時に自分が作った秘密stagingを必ず削除する", async () => {
    fsFault.linkMode = "none";
    const activity = await import("../src/codex/subagent-store");
    const payload = {
      hook_event_name: "SubagentStart",
      session_id: "session-a",
      turn_id: "turn-a",
      agent_id: "agent-a",
      agent_type: "explorer",
    };

    fsFault.renameDestination = join(home, "codex-subagent-key");
    expect(() => activity.validateCodexSubagentPayload(payload)).toThrow("injected rename failure");
    expect(readdirSync(home).filter((name) => /^codex-subagent-key\..+\.tmp$/.test(name))).toEqual([]);

    fsFault.renameDestination = null;
    expect(activity.validateCodexSubagentPayload(payload)).not.toBeNull();
    rmSync(join(home, "codex-subagent-activity.json"), { force: true });
    fsFault.renameDestination = join(home, "codex-subagent-activity.json");
    expect(() => activity.validateCodexSubagentPayload(payload)).toThrow("injected rename failure");
    expect(readdirSync(home).filter((name) => /^codex-subagent-activity\.json\..+\.tmp$/.test(name))).toEqual([]);
  });

  it("v1 backup/ledger rename失敗は元v1を不変に保ち、再送でmigrationを完了できる", async () => {
    fsFault.linkMode = "none";
    const activity = await import("../src/codex/subagent-store");
    const keyFile = join(home, "codex-subagent-key");
    const ledgerFile = join(home, "codex-subagent-activity.json");
    const backupFile = join(home, "codex-subagent-activity.v1.json");
    writeFileSync(keyFile, Buffer.alloc(32, 0x4a));
    const rawV1 = `${JSON.stringify({ schemaVersion: 1, agents: {} })}\n`;
    writeFileSync(ledgerFile, rawV1);
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "session-a", turn_id: "root-a" };

    fsFault.renameDestination = backupFile;
    expect(() => activity.openCodexRootContext(prompt)).toThrow("injected rename failure");
    expect(readFileSync(ledgerFile, "utf8")).toBe(rawV1);
    expect(readdirSync(home).filter((name) => name.includes("activity.v1.json.") && name.endsWith(".tmp"))).toEqual([]);

    fsFault.renameDestination = ledgerFile;
    expect(() => activity.openCodexRootContext(prompt)).toThrow("injected rename failure");
    expect(readFileSync(ledgerFile, "utf8")).toBe(rawV1);
    expect(readFileSync(backupFile, "utf8")).toBe(rawV1);

    fsFault.renameDestination = null;
    expect(activity.openCodexRootContext(prompt)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(ledgerFile, "utf8")).schemaVersion).toBe(2);
    expect(readFileSync(backupFile, "utf8")).toBe(rawV1);
  });
});
