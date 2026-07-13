import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { runCodexPassiveHook } from "../src/cli";
import {
  acquireCodexActivityLock,
  normalizeAgentType,
  readCodexSubagentActivity,
  recordCodexSubagentEvent,
  reduceCodexSubagentActivity,
  validateCodexSubagentPayload,
} from "../src/codex/subagent-store";

describe("Codex subagent Gate D activity", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cccn-codex-activity-"));
    process.env.CCCN_HOME = home;
  });
  afterEach(() => {
    delete process.env.CCCN_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const start = {
    hook_event_name: "SubagentStart",
    session_id: "raw-session-secret",
    turn_id: "raw-turn-secret",
    agent_id: "raw-agent-secret",
    agent_type: "explorer",
    cwd: "/private/secret",
    transcript_path: "/private/parent.jsonl",
    agent_transcript_path: "/private/child.jsonl",
    last_assistant_message: "private body",
  };

  function localStagingHostTag(): string {
    return createHash("sha256")
      .update("ccc-notifier:staging-host:v1\0")
      .update(hostname())
      .digest("hex")
      .slice(0, 16);
  }

  it("unknown境界を検証し、必須identity欠落・型不正・event不一致を拒否する", () => {
    expect(validateCodexSubagentPayload(null)).toBeNull();
    expect(validateCodexSubagentPayload({ ...start, turn_id: undefined })).toBeNull();
    expect(validateCodexSubagentPayload({ ...start, agent_id: 3 })).toBeNull();
    expect(validateCodexSubagentPayload(start, "stop")).toBeNull();
    expect(validateCodexSubagentPayload(start, "start")).not.toBeNull();
  });

  it("local secret内ではkeyが決定的で、異なるturn/agentは別keyになる", () => {
    const a = validateCodexSubagentPayload(start)!;
    const b = validateCodexSubagentPayload({ ...start })!;
    const otherTurn = validateCodexSubagentPayload({ ...start, turn_id: "turn-b" })!;
    const otherAgent = validateCodexSubagentPayload({ ...start, agent_id: "agent-b" })!;
    expect(a).toEqual(b);
    expect(a.projectionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(a.agentKey).not.toBe(otherAgent.agentKey);
    expect(a.projectionKey).not.toBe(otherTurn.projectionKey);
  });

  it("Start/Stop逆順・再送・複数Stopを同じunique stateへ収束させる", () => {
    const startEvent = validateCodexSubagentPayload(start)!;
    const stopEvent = validateCodexSubagentPayload({ ...start, hook_event_name: "SubagentStop" })!;
    const t1 = "2026-07-13T00:00:00.000Z";
    const t2 = "2026-07-13T00:01:00.000Z";
    const normal = reduceCodexSubagentActivity(
      reduceCodexSubagentActivity(undefined, startEvent, t1), stopEvent, t2,
    );
    const reverse = reduceCodexSubagentActivity(
      reduceCodexSubagentActivity(undefined, stopEvent, t2), startEvent, t1,
    );
    const resent = reduceCodexSubagentActivity(normal, stopEvent, t2);
    expect(reverse).toEqual(normal);
    expect(resent).toEqual(normal);
    expect(normal).toMatchObject({ startObserved: true, stopObserved: true });
  });

  it("台帳はraw payload・本文・path・生IDを一切保存しない", () => {
    const event = validateCodexSubagentPayload(start)!;
    recordCodexSubagentEvent(event, { observedAt: "2026-07-13T00:00:00.000Z" });
    const raw = readFileSync(join(home, "codex-subagent-activity.json"), "utf8");
    for (const forbidden of [
      "raw-session-secret", "raw-turn-secret", "raw-agent-secret", "/private/secret",
      "parent.jsonl", "child.jsonl", "private body", "agent_transcript_path", "transcript_path", "cwd",
    ]) expect(raw).not.toContain(forbidden);
    expect(JSON.parse(raw).agents[event.agentKey]).toMatchObject({ agentTypeLabel: "explorer" });
  });

  it("agent_typeは制御文字・過長・未知値を固定safe labelへ落とす", () => {
    expect(normalizeAgentType("exp\u0000lorer")).toBe("explorer");
    expect(normalizeAgentType("<script>alert(1)</script>")).toBe("unknown");
    expect(normalizeAgentType("x".repeat(1000))).toBe("unknown");
  });

  it("atomic台帳へ多数のwriter入力を冪等mergeする", async () => {
    const events = Array.from({ length: 50 }, (_, i) => validateCodexSubagentPayload({
      ...start,
      hook_event_name: i % 2 === 0 ? "SubagentStart" : "SubagentStop",
      agent_id: `agent-${i % 5}`,
    })!);
    await Promise.all(events.map(async (event) => recordCodexSubagentEvent(event)));
    expect(readCodexSubagentActivity()).toHaveLength(5);
  });

  it("lock timeoutと破損台帳はfail-safeで既存データを上書きしない", () => {
    const event = validateCodexSubagentPayload(start)!;
    mkdirSync(join(home, "codex-subagent-activity.lock"));
    expect(() => recordCodexSubagentEvent(event, { lockTimeoutMs: 20 })).toThrow("lock timeout");
    rmSync(join(home, "codex-subagent-activity.lock"), { recursive: true });
    const broken = "{broken";
    writeFileSync(join(home, "codex-subagent-activity.json"), broken);
    expect(readCodexSubagentActivity()).toEqual([]);
    expect(readFileSync(join(home, "codex-subagent-activity.json"), "utf8")).toBe(broken);
  });

  it("leaseを超えてもsame-host live PIDのlockを誤回収しない", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    const lockPath = join(home, "codex-subagent-activity.lock");
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        token: "a".repeat(32), pid: child.pid!, hostname: hostname(), createdAt: "2000-01-01T00:00:00.000Z",
      }));
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);
      expect(() => acquireCodexActivityLock(30, { staleMs: 1 })).toThrow("lock timeout");
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      child.kill();
      rmSync(lockPath, { recursive: true, force: true });
    }
  });

  it("same-host dead PIDのorphanだけを回収する", () => {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = join(home, "codex-subagent-activity.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      token: "b".repeat(32), pid: dead.pid, hostname: hostname(), createdAt: "2000-01-01T00:00:00.000Z",
    }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const lock = acquireCodexActivityLock(100, { staleMs: 1 });
    expect(lock.token).not.toBe("b".repeat(32));
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("production defaultで新しいsame-host dead PID lockをstale待ちせず即時回収してeventを1回記録する", () => {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = join(home, "codex-subagent-activity.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      token: "c".repeat(32), pid: dead.pid, hostname: hostname(), createdAt: new Date().toISOString(),
    }));
    const event = validateCodexSubagentPayload(start)!;
    recordCodexSubagentEvent(event, { observedAt: "2026-07-13T00:00:00.000Z" });
    expect(readCodexSubagentActivity()).toHaveLength(1);
  });

  it("production defaultでowner publish前crashのmalformed canonical lockを短い猶予後claim回収する", () => {
    const lockPath = join(home, "codex-subagent-activity.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json.tmp-crash"), "truncated-owner");
    const old = new Date(Date.now() - 1_000);
    utimesSync(lockPath, old, old);
    const event = validateCodexSubagentPayload(start)!;
    recordCodexSubagentEvent(event, { observedAt: "2026-07-13T00:00:00.000Z" });
    expect(readCodexSubagentActivity()).toHaveLength(1);
  });

  it("malformed grace中にvalid live ownerへ遷移したcanonical lockを回収しない", async () => {
    const lockPath = join(home, "codex-subagent-activity.lock");
    mkdirSync(lockPath);
    const ownerPath = join(lockPath, "owner.json");
    const script = [
      "const fs=require('node:fs');",
      "const os=require('node:os');",
      "process.stdout.write('started\\n');",
      "setTimeout(()=>fs.writeFileSync(process.argv[1], JSON.stringify({token:'d'.repeat(32),pid:process.pid,hostname:os.hostname(),createdAt:new Date().toISOString()})),25);",
      "setInterval(()=>{},1000);",
    ].join("");
    const child = spawn(process.execPath, ["-e", script, ownerPath], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", resolve);
        child.once("error", reject);
      });
      expect(() => acquireCodexActivityLock(500, { staleMs: 250 })).toThrow("lock timeout");
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      child.kill();
      rmSync(lockPath, { recursive: true, force: true });
    }
  });

  it("foreign-host valid ownerはageに関係なくfail-closedで回収しない", () => {
    const lockPath = join(home, "codex-subagent-activity.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      token: "e".repeat(32), pid: 999999, hostname: `${hostname()}-foreign`, createdAt: "2000-01-01T00:00:00.000Z",
    }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    expect(() => acquireCodexActivityLock(30, { staleMs: 1 })).toThrow("lock timeout");
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath, { recursive: true, force: true });
  });

  it("old ownerのreleaseは後から取得したnew ownerのlockを削除しない", () => {
    const lockPath = join(home, "codex-subagent-activity.lock");
    const old = acquireCodexActivityLock();
    renameSync(lockPath, `${lockPath}.orphaned-for-test`);
    const newer = acquireCodexActivityLock();
    old.release();
    expect(existsSync(lockPath)).toBe(true);
    newer.release();
    rmSync(`${lockPath}.orphaned-for-test`, { recursive: true, force: true });
  });

  it("0byte/破損keyを回復し、key lock内で厳格命名の古いdead-PID秘密stagingだけを削除する", () => {
    const keyFile = join(home, "codex-subagent-key");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const hostTag = localStagingHostTag();
    const staleStaging = `${keyFile}.${hostTag}.${dead.pid}.${"a".repeat(16)}.tmp`;
    const liveStaging = `${keyFile}.${hostTag}.${process.pid}.${"b".repeat(16)}.tmp`;
    const foreignStaging = `${keyFile}.${"0".repeat(16)}.${dead.pid}.${"c".repeat(16)}.tmp`;
    const legacyHostlessStaging = `${keyFile}.${dead.pid}.${"d".repeat(16)}.tmp`;
    writeFileSync(keyFile, "");
    writeFileSync(staleStaging, Buffer.alloc(32, 0x4a));
    writeFileSync(liveStaging, Buffer.alloc(32, 0x5b));
    writeFileSync(foreignStaging, Buffer.alloc(32, 0x6c));
    writeFileSync(legacyHostlessStaging, Buffer.alloc(32, 0x7d));
    const old = new Date(Date.now() - 120_000);
    utimesSync(staleStaging, old, old);
    utimesSync(liveStaging, old, old);
    utimesSync(foreignStaging, old, old);
    utimesSync(legacyHostlessStaging, old, old);
    expect(validateCodexSubagentPayload(start)).not.toBeNull();
    expect(readFileSync(keyFile)).toHaveLength(32);
    expect(existsSync(staleStaging)).toBe(false);
    expect(existsSync(liveStaging)).toBe(true);
    expect(existsSync(foreignStaging)).toBe(true);
    expect(existsSync(legacyHostlessStaging)).toBe(true);
    rmSync(join(home, "codex-subagent-activity.json"));
    writeFileSync(keyFile, "bad");
    expect(validateCodexSubagentPayload(start)).not.toBeNull();
    expect(readFileSync(keyFile)).toHaveLength(32);
  });

  it("activity lock内で厳格命名の古いdead-PID ledger stagingだけを削除する", () => {
    expect(validateCodexSubagentPayload(start)).not.toBeNull();
    const event = validateCodexSubagentPayload(start)!;
    const ledgerFile = join(home, "codex-subagent-activity.json");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const hostTag = localStagingHostTag();
    const staleStaging = `${ledgerFile}.${hostTag}.${dead.pid}.${"c".repeat(12)}.tmp`;
    const liveStaging = `${ledgerFile}.${hostTag}.${process.pid}.${"d".repeat(12)}.tmp`;
    writeFileSync(staleStaging, "stale-ledger-copy");
    writeFileSync(liveStaging, "live-ledger-copy");
    const old = new Date(Date.now() - 120_000);
    utimesSync(staleStaging, old, old);
    utimesSync(liveStaging, old, old);
    recordCodexSubagentEvent(event);
    expect(existsSync(staleStaging)).toBe(false);
    expect(existsSync(liveStaging)).toBe(true);
  });

  it("canonical lock取得後にvalid ownerを持つ古いdead-PID init残骸だけを回収する", () => {
    const lockPath = join(home, "codex-subagent-activity.lock");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const staleToken = "e".repeat(32);
    const liveToken = "f".repeat(32);
    const staleInit = `${lockPath}.init-${staleToken}`;
    const liveInit = `${lockPath}.init-${liveToken}`;
    mkdirSync(staleInit);
    mkdirSync(liveInit);
    const staleOwner = join(staleInit, "owner.json");
    const liveOwner = join(liveInit, "owner.json");
    writeFileSync(staleOwner, JSON.stringify({
      token: staleToken, pid: dead.pid, hostname: hostname(), createdAt: "2000-01-01T00:00:00.000Z",
    }));
    writeFileSync(liveOwner, JSON.stringify({
      token: liveToken, pid: process.pid, hostname: hostname(), createdAt: "2000-01-01T00:00:00.000Z",
    }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(staleInit, old, old);
    utimesSync(liveInit, old, old);
    utimesSync(staleOwner, old, old);
    utimesSync(liveOwner, old, old);

    const lock = acquireCodexActivityLock();
    expect(existsSync(staleInit)).toBe(false);
    expect(existsSync(liveInit)).toBe(true);
    lock.release();
  });

  it("既存ledger+invalid keyは両ファイル不変でfail-closed、手動key復旧後の再送identityは不変", async () => {
    const before = validateCodexSubagentPayload(start)!;
    recordCodexSubagentEvent(before, { observedAt: "2026-07-13T00:00:00.000Z" });
    const keyFile = join(home, "codex-subagent-key");
    const ledgerFile = join(home, "codex-subagent-activity.json");
    const validKey = readFileSync(keyFile);
    const ledgerBefore = readFileSync(ledgerFile, "utf8");
    const invalidKey = Buffer.from("short");
    writeFileSync(keyFile, invalidKey);

    expect(() => validateCodexSubagentPayload(start)).toThrow("invalid activity key with existing ledger");
    expect(readFileSync(keyFile)).toEqual(invalidKey);
    expect(readFileSync(ledgerFile, "utf8")).toBe(ledgerBefore);

    await expect(runCodexPassiveHook("SubagentStart", JSON.stringify(start))).resolves.toEqual(Buffer.alloc(0));
    expect(readFileSync(keyFile)).toEqual(invalidKey);
    expect(readFileSync(ledgerFile, "utf8")).toBe(ledgerBefore);
    const errorLog = readFileSync(join(home, "error.log"), "utf8");
    expect(errorLog).toContain("hook event was not recorded");
    for (const secret of ["raw-session-secret", "raw-turn-secret", "raw-agent-secret", "/private/"]) {
    expect(errorLog).not.toContain(secret);
    }

    rmSync(keyFile);
    expect(() => validateCodexSubagentPayload(start)).toThrow("missing activity key with existing ledger");
    expect(readFileSync(ledgerFile, "utf8")).toBe(ledgerBefore);

    writeFileSync(keyFile, validKey);
    expect(validateCodexSubagentPayload(start)).toEqual(before);
  });

  it("同長32-byte key置換と1bit破損をkeyCheckで拒否しledger identityを増やさない", async () => {
    const event = validateCodexSubagentPayload(start)!;
    recordCodexSubagentEvent(event, { observedAt: "2026-07-13T00:00:00.000Z" });
    const keyFile = join(home, "codex-subagent-key");
    const ledgerFile = join(home, "codex-subagent-activity.json");
    const originalKey = readFileSync(keyFile);
    const ledgerBefore = readFileSync(ledgerFile, "utf8");
    expect(JSON.parse(ledgerBefore).keyCheck).toMatch(/^[a-f0-9]{64}$/);
    expect(ledgerBefore).not.toContain(originalKey.toString("hex"));
    expect(ledgerBefore).not.toContain(originalKey.toString("base64"));

    const replaced = Buffer.alloc(32, 0xa5);
    writeFileSync(keyFile, replaced);
    await runCodexPassiveHook("SubagentStart", JSON.stringify(start));
    expect(readFileSync(keyFile)).toEqual(replaced);
    expect(readFileSync(ledgerFile, "utf8")).toBe(ledgerBefore);

    const oneBit = Buffer.from(originalKey);
    oneBit[0] ^= 1;
    writeFileSync(keyFile, oneBit);
    await runCodexPassiveHook("SubagentStart", JSON.stringify(start));
    expect(readFileSync(keyFile)).toEqual(oneBit);
    expect(readFileSync(ledgerFile, "utf8")).toBe(ledgerBefore);
    expect(readFileSync(join(home, "error.log"), "utf8")).toContain("key integrity mismatch; manual recovery required");
  });

  it("keyCheck 1bit破損を拒否してkey/check/agentsを上書きしない", async () => {
    const event = validateCodexSubagentPayload(start)!;
    recordCodexSubagentEvent(event, { observedAt: "2026-07-13T00:00:00.000Z" });
    const keyFile = join(home, "codex-subagent-key");
    const ledgerFile = join(home, "codex-subagent-activity.json");
    const keyBefore = readFileSync(keyFile);
    const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
    ledger.keyCheck = `${ledger.keyCheck[0] === "0" ? "1" : "0"}${ledger.keyCheck.slice(1)}`;
    const corruptLedger = `${JSON.stringify(ledger)}\n`;
    writeFileSync(ledgerFile, corruptLedger);
    await runCodexPassiveHook("SubagentStart", JSON.stringify(start));
    expect(readFileSync(keyFile)).toEqual(keyBefore);
    expect(readFileSync(ledgerFile, "utf8")).toBe(corruptLedger);
  });

  it("keyCheck無しの正常な既存v1 ledgerをlock内で一度だけbackfillする", () => {
    const event = validateCodexSubagentPayload(start)!;
    const ledgerFile = join(home, "codex-subagent-activity.json");
    writeFileSync(ledgerFile, `${JSON.stringify({ schemaVersion: 1, agents: {} })}\n`);
    recordCodexSubagentEvent(event, { observedAt: "2026-07-13T00:00:00.000Z" });
    const first = readFileSync(ledgerFile, "utf8");
    expect(JSON.parse(first).keyCheck).toMatch(/^[a-f0-9]{64}$/);
    recordCodexSubagentEvent(event, { observedAt: "2026-07-13T00:00:00.000Z" });
    expect(readFileSync(ledgerFile, "utf8")).toBe(first);
  });

  it("台帳agentTypeLabelのscript/control/長大なsemantic破損をfail-closedにする", () => {
    const event = validateCodexSubagentPayload(start)!;
    recordCodexSubagentEvent(event);
    const file = join(home, "codex-subagent-activity.json");
    for (const bad of ["<script>", "worker\u0000", "x".repeat(1000)]) {
      const ledger = JSON.parse(readFileSync(file, "utf8"));
      ledger.agents[event.agentKey].agentTypeLabel = bad;
      writeFileSync(file, JSON.stringify(ledger));
      expect(readCodexSubagentActivity()).toEqual([]);
      ledger.agents[event.agentKey].agentTypeLabel = "worker";
      writeFileSync(file, JSON.stringify(ledger));
    }
  });

  it("wireはStart 0 bytes、Stop系 exact {}+LFで内部失敗時も同じ", async () => {
    expect(await runCodexPassiveHook("SubagentStart", JSON.stringify(start))).toEqual(Buffer.alloc(0));
    expect(await runCodexPassiveHook("SubagentStart", "not json")).toEqual(Buffer.alloc(0));
    expect(await runCodexPassiveHook("SubagentStop", "not json")).toEqual(Buffer.from("{}\n"));
    expect(await runCodexPassiveHook("Stop", "not json")).toEqual(Buffer.from("{}\n"));
  });
});
