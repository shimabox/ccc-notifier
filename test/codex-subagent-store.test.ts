import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { runCodexPassiveHook } from "../src/cli";
import {
  acquireCodexActivityLock,
  closeCodexRootContext,
  normalizeAgentType,
  openCodexRootContext,
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

  function openDefaultRoot(): string {
    return openCodexRootContext({
      hook_event_name: "UserPromptSubmit",
      session_id: start.session_id,
      turn_id: "raw-root-turn-secret",
      prompt: "private prompt body",
    }, { observedAt: "2026-07-13T00:00:00.000Z" })!;
  }

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

  it("local secret内ではsession/agent keyが決定的で、child turn_idは親join identityに使わない", () => {
    const a = validateCodexSubagentPayload(start)!;
    const b = validateCodexSubagentPayload({ ...start })!;
    const otherTurn = validateCodexSubagentPayload({ ...start, turn_id: "turn-b" })!;
    const otherAgent = validateCodexSubagentPayload({ ...start, agent_id: "agent-b" })!;
    expect(a).toEqual(b);
    expect(a.sessionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(a.agentKey).not.toBe(otherAgent.agentKey);
    expect(a).toEqual(otherTurn);
  });

  it("Start/Stop逆順・再送・複数Stopを同じunique stateへ収束させる", () => {
    const startEvent = validateCodexSubagentPayload(start)!;
    const stopEvent = validateCodexSubagentPayload({ ...start, hook_event_name: "SubagentStop" })!;
    const t1 = "2026-07-13T00:00:00.000Z";
    const t2 = "2026-07-13T00:01:00.000Z";
    const normal = reduceCodexSubagentActivity(
      reduceCodexSubagentActivity(undefined, startEvent, t1, "a".repeat(64)), stopEvent, t2,
    );
    const reverse = reduceCodexSubagentActivity(
      reduceCodexSubagentActivity(undefined, stopEvent, t2, "a".repeat(64)), startEvent, t1,
    );
    const resent = reduceCodexSubagentActivity(normal, stopEvent, t2);
    expect(reverse).toEqual(normal);
    expect(resent).toEqual(normal);
    expect(normal).toMatchObject({ startObserved: true, stopObserved: true });
  });

  it("台帳はraw payload・本文・path・生IDを一切保存しない", () => {
    const rootKey = openDefaultRoot();
    const event = validateCodexSubagentPayload(start)!;
    recordCodexSubagentEvent(event, { observedAt: "2026-07-13T00:00:00.000Z" });
    const raw = readFileSync(join(home, "codex-subagent-activity.json"), "utf8");
    for (const forbidden of [
      "raw-session-secret", "raw-turn-secret", "raw-agent-secret", "/private/secret",
      "parent.jsonl", "child.jsonl", "private body", "agent_transcript_path", "transcript_path", "cwd",
    ]) expect(raw).not.toContain(forbidden);
    expect(JSON.parse(raw).roots[rootKey].agents[event.agentKey]).toMatchObject({ agentTypeLabel: "explorer" });
  });

  it("agent_typeは制御文字・過長・未知値を固定safe labelへ落とす", () => {
    expect(normalizeAgentType("exp\u0000lorer")).toBe("explorer");
    expect(normalizeAgentType("<script>alert(1)</script>")).toBe("unknown");
    expect(normalizeAgentType("x".repeat(1000))).toBe("unknown");
  });

  it("atomic台帳へ多数のwriter入力を冪等mergeする", async () => {
    openDefaultRoot();
    const events = Array.from({ length: 50 }, (_, i) => validateCodexSubagentPayload({
      ...start,
      hook_event_name: i % 2 === 0 ? "SubagentStart" : "SubagentStop",
      agent_id: `agent-${i % 5}`,
    })!);
    await Promise.all(events.map(async (event) => recordCodexSubagentEvent(event)));
    expect(readCodexSubagentActivity()).toHaveLength(5);
  });

  it("lock timeoutと破損台帳はfail-safeで既存データを上書きしない", () => {
    openDefaultRoot();
    const event = validateCodexSubagentPayload(start)!;
    const lockPath = join(home, "codex-subagent-activity.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      token: "a".repeat(32),
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    }));
    expect(() => recordCodexSubagentEvent(event, { lockTimeoutMs: 20 })).toThrow("lock timeout");
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath, { recursive: true });
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
    openDefaultRoot();
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
    openDefaultRoot();
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
    openDefaultRoot();
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
    openDefaultRoot();
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
    openDefaultRoot();
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
    openDefaultRoot();
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

  it("keyCheck無しの正常な既存v1 ledgerをlock内で一度だけv2へ移行する", () => {
    const event = validateCodexSubagentPayload(start)!;
    const ledgerFile = join(home, "codex-subagent-activity.json");
    writeFileSync(ledgerFile, `${JSON.stringify({ schemaVersion: 1, agents: {} })}\n`);
    openDefaultRoot();
    recordCodexSubagentEvent(event, { observedAt: "2026-07-13T00:00:00.000Z" });
    const first = readFileSync(ledgerFile, "utf8");
    expect(JSON.parse(first).schemaVersion).toBe(2);
    expect(JSON.parse(first).keyCheck).toMatch(/^[a-f0-9]{64}$/);
    recordCodexSubagentEvent(event, { observedAt: "2026-07-13T00:00:00.000Z" });
    expect(readFileSync(ledgerFile, "utf8")).toBe(first);
  });

  it("台帳agentTypeLabelのscript/control/長大なsemantic破損をfail-closedにする", () => {
    const rootKey = openDefaultRoot();
    const event = validateCodexSubagentPayload(start)!;
    recordCodexSubagentEvent(event);
    const file = join(home, "codex-subagent-activity.json");
    for (const bad of ["<script>", "worker\u0000", "x".repeat(1000)]) {
      const ledger = JSON.parse(readFileSync(file, "utf8"));
      ledger.roots[rootKey].agents[event.agentKey].agentTypeLabel = bad;
      writeFileSync(file, JSON.stringify(ledger));
      expect(readCodexSubagentActivity()).toEqual([]);
      ledger.roots[rootKey].agents[event.agentKey].agentTypeLabel = "worker";
      writeFileSync(file, JSON.stringify(ledger));
    }
  });

  it("v2 root/state/assignmentの双方向不整合と未知fieldをfail-closedにする", () => {
    const rootA = openDefaultRoot();
    const event = validateCodexSubagentPayload(start)!;
    recordCodexSubagentEvent(event);
    closeCodexRootContext({
      hook_event_name: "Stop", session_id: start.session_id, turn_id: "raw-root-turn-secret",
    });
    const rootB = openCodexRootContext({
      hook_event_name: "UserPromptSubmit", session_id: start.session_id, turn_id: "root-B",
    })!;
    const file = join(home, "codex-subagent-activity.json");
    const baseline = readFileSync(file, "utf8");
    const corruptions: Array<(ledger: any) => void> = [
      (ledger) => { ledger.roots[rootA].agents[event.agentKey].projectionKey = rootB; },
      (ledger) => { delete ledger.agentAssignments[event.agentKey]; },
      (ledger) => { ledger.roots[rootB].agents[event.agentKey] = ledger.roots[rootA].agents[event.agentKey]; },
      (ledger) => { ledger.roots[rootA].agents[event.agentKey].rawPayload = "PRIVATE-CANARY"; },
    ];
    for (const corrupt of corruptions) {
      const ledger = JSON.parse(baseline);
      corrupt(ledger);
      const raw = `${JSON.stringify(ledger)}\n`;
      writeFileSync(file, raw);
      expect(readCodexSubagentActivity()).toEqual([]);
      expect(() => openCodexRootContext({
        hook_event_name: "UserPromptSubmit", session_id: start.session_id, turn_id: "root-C",
      })).toThrow(/activity|ledger|assignment|projection/i);
      expect(readFileSync(file, "utf8")).toBe(raw);
    }
  });

  it("allowlist外fieldを含むv1はbackupへ複製せず元rawのまま拒否する", () => {
    const legacyState = {
      schemaVersion: 1,
      projectionKey: "a".repeat(64),
      agentKey: "b".repeat(64),
      agentTypeLabel: "worker",
      startObserved: true,
      stopObserved: false,
      firstObservedAt: "2026-07-13T00:00:00.000Z",
      lastObservedAt: "2026-07-13T00:00:00.000Z",
      prompt: "PRIVATE-V1-CANARY",
    };
    writeFileSync(join(home, "codex-subagent-key"), Buffer.alloc(32, 0x5a), { mode: 0o600 });
    const file = join(home, "codex-subagent-activity.json");
    const raw = `${JSON.stringify({ schemaVersion: 1, agents: { [legacyState.agentKey]: legacyState } })}\n`;
    writeFileSync(file, raw);

    expect(() => openDefaultRoot()).toThrow("invalid activity ledger entry");
    expect(readFileSync(file, "utf8")).toBe(raw);
    expect(existsSync(join(home, "codex-subagent-activity.v1.json"))).toBe(false);
  });

  it("root context無しの未知agentは時間に関係なくfail-closedで保存しない", () => {
    const event = validateCodexSubagentPayload(start)!;
    expect(recordCodexSubagentEvent(event)).toBeNull();
    expect(readCodexSubagentActivity()).toEqual([]);
  });

  it("root A/Bを分離し、既知late Stopだけを元rootへ収束させる", () => {
    const rootA = openDefaultRoot();
    const agentAStart = validateCodexSubagentPayload({ ...start, turn_id: "child-X" })!;
    recordCodexSubagentEvent(agentAStart, { observedAt: "2026-07-13T00:00:01.000Z" });
    expect(closeCodexRootContext({
      hook_event_name: "Stop", session_id: start.session_id, turn_id: "raw-root-turn-secret",
    })).toBe(rootA);

    const rootB = openCodexRootContext({
      hook_event_name: "UserPromptSubmit", session_id: start.session_id, turn_id: "root-B",
    })!;
    const agentB = validateCodexSubagentPayload({ ...start, turn_id: "child-B", agent_id: "agent-B" })!;
    recordCodexSubagentEvent(agentB);
    const lateAStop = validateCodexSubagentPayload({
      ...start, hook_event_name: "SubagentStop", turn_id: "child-Y",
    })!;
    recordCodexSubagentEvent(lateAStop, { observedAt: "2026-07-13T00:00:02.000Z" });

    expect(readCodexSubagentActivity(rootA)).toMatchObject([{ startObserved: true, stopObserved: true }]);
    expect(readCodexSubagentActivity(rootB)).toMatchObject([{ startObserved: true, stopObserved: false }]);
  });

  it("root A close後にroot Bがactiveでも、未割当のA late StopをBへ誤帰属しない", () => {
    const rootA = openDefaultRoot();
    closeCodexRootContext({
      hook_event_name: "Stop", session_id: start.session_id, turn_id: "raw-root-turn-secret",
    });
    const rootB = openCodexRootContext({
      hook_event_name: "UserPromptSubmit", session_id: start.session_id, turn_id: "root-B",
    })!;
    const unknownLateStop = validateCodexSubagentPayload({
      ...start,
      hook_event_name: "SubagentStop",
      turn_id: "child-from-root-A",
      agent_id: "agent-with-missing-start",
    })!;

    expect(recordCodexSubagentEvent(unknownLateStop)).toBeNull();
    expect(readCodexSubagentActivity(rootA)).toEqual([]);
    expect(readCodexSubagentActivity(rootB)).toEqual([]);
    const ledger = JSON.parse(readFileSync(join(home, "codex-subagent-activity.json"), "utf8"));
    expect(ledger.agentAssignments[unknownLateStop.agentKey]).toBeUndefined();
  });

  it("別root active中の既知agent Startはassignmentを移さずconflictとして固定する", () => {
    const rootA = openDefaultRoot();
    const event = validateCodexSubagentPayload(start)!;
    recordCodexSubagentEvent(event);
    closeCodexRootContext({
      hook_event_name: "Stop", session_id: start.session_id, turn_id: "raw-root-turn-secret",
    });
    openCodexRootContext({
      hook_event_name: "UserPromptSubmit", session_id: start.session_id, turn_id: "root-B",
    });

    expect(recordCodexSubagentEvent(event)).toBeNull();
    const ledger = JSON.parse(readFileSync(join(home, "codex-subagent-activity.json"), "utf8"));
    expect(ledger.agentAssignments[event.agentKey]).toBe(rootA);
    expect(ledger.conflictedAgents[event.agentKey]).toBe(true);
    const error = readFileSync(join(home, "error.log"), "utf8");
    expect(error).toContain("agent identity conflict");
    expect(error).not.toContain(start.session_id);
    expect(error).not.toContain(start.agent_id);
  });

  it("root A open中のroot B開始はAをabandonedにし、Aのexact StopはB activeを変えない", () => {
    const rootA = openDefaultRoot();
    const rootB = openCodexRootContext({
      hook_event_name: "UserPromptSubmit", session_id: start.session_id, turn_id: "root-B",
    })!;
    let ledger = JSON.parse(readFileSync(join(home, "codex-subagent-activity.json"), "utf8"));
    expect(ledger.roots[rootA].status).toBe("abandoned");
    expect(ledger.roots[rootB].status).toBe("open");
    expect(ledger.sessions[ledger.roots[rootB].sessionKey].activeRootKey).toBe(rootB);

    expect(closeCodexRootContext({
      hook_event_name: "Stop", session_id: start.session_id, turn_id: "raw-root-turn-secret",
    })).toBe(rootA);
    ledger = JSON.parse(readFileSync(join(home, "codex-subagent-activity.json"), "utf8"));
    expect(ledger.roots[rootA].status).toBe("closed");
    expect(ledger.sessions[ledger.roots[rootB].sessionKey].activeRootKey).toBe(rootB);
  });

  it("valid v1をraw backup付きで一度だけv2へ移行しlegacy activityを保持する", () => {
    const legacyState = {
      schemaVersion: 1,
      projectionKey: "a".repeat(64),
      agentKey: "b".repeat(64),
      agentTypeLabel: "worker",
      startObserved: true,
      stopObserved: false,
      firstObservedAt: "2026-07-13T00:00:00.000Z",
      lastObservedAt: "2026-07-13T00:00:00.000Z",
    };
    writeFileSync(join(home, "codex-subagent-key"), Buffer.alloc(32, 0x5a), { mode: 0o600 });
    const rawV1 = `${JSON.stringify({ schemaVersion: 1, agents: { [legacyState.agentKey]: legacyState } })}\n`;
    writeFileSync(join(home, "codex-subagent-activity.json"), rawV1);

    const rootKey = openDefaultRoot();
    const firstV2 = readFileSync(join(home, "codex-subagent-activity.json"), "utf8");
    expect(rootKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(firstV2).schemaVersion).toBe(2);
    expect(JSON.parse(firstV2).legacyV1.agents[legacyState.agentKey]).toEqual(legacyState);
    expect(readFileSync(join(home, "codex-subagent-activity.v1.json"), "utf8")).toBe(rawV1);
    expect(readCodexSubagentActivity(legacyState.projectionKey)).toEqual([legacyState]);

    expect(openDefaultRoot()).toBe(rootKey);
    expect(readFileSync(join(home, "codex-subagent-activity.json"), "utf8")).toBe(firstV2);
    expect(readdirSync(home).filter((name) => name === "codex-subagent-activity.v1.json")).toHaveLength(1);
  });

  it("wireはUserPrompt/Start 0 bytes、Stop系 exact {}+LFで内部失敗時も同じ", async () => {
    const promptPayload = {
      hook_event_name: "UserPromptSubmit",
      session_id: start.session_id,
      turn_id: "root-wire",
      prompt: "PROMPT-CANARY-DO-NOT-PERSIST",
      cwd: "/private/wire",
    };
    expect(await runCodexPassiveHook("UserPromptSubmit", JSON.stringify(promptPayload))).toEqual(Buffer.alloc(0));
    expect(await runCodexPassiveHook("SubagentStart", JSON.stringify(start))).toEqual(Buffer.alloc(0));
    const persisted = readFileSync(join(home, "codex-subagent-activity.json"), "utf8");
    expect(persisted).not.toContain("PROMPT-CANARY-DO-NOT-PERSIST");
    expect(persisted).not.toContain("/private/wire");
    expect(await runCodexPassiveHook("SubagentStart", "not json")).toEqual(Buffer.alloc(0));
    expect(await runCodexPassiveHook("UserPromptSubmit", "not json")).toEqual(Buffer.alloc(0));
    expect(await runCodexPassiveHook("SubagentStop", "not json")).toEqual(Buffer.from("{}\n"));
    expect(await runCodexPassiveHook("Stop", "not json")).toEqual(Buffer.from("{}\n"));
  });
});
