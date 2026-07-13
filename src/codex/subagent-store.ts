import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { hostname } from "node:os";

import { logError, paths } from "../store";
import type { TurnRecord } from "../types";

export type CodexSubagentEventKind = "start" | "stop";

export interface ValidatedCodexSubagentEvent {
  kind: CodexSubagentEventKind;
  projectionKey: string;
  agentKey: string;
  agentTypeLabel: string;
}

export interface CodexSubagentActivityState {
  schemaVersion: 1;
  projectionKey: string;
  agentKey: string;
  agentTypeLabel: string;
  startObserved: boolean;
  stopObserved: boolean;
  firstObservedAt: string;
  lastObservedAt: string;
}

interface Ledger {
  schemaVersion: 1;
  keyCheck?: string;
  agents: Record<string, CodexSubagentActivityState>;
}

const KNOWN_AGENT_TYPES = new Map([
  ["default", "default"],
  ["explorer", "explorer"],
  ["worker", "worker"],
  ["reviewer", "reviewer"],
  ["researcher", "researcher"],
  ["general", "general"],
]);
const UNKNOWN_AGENT_TYPE = "unknown";
const MALFORMED_LOCK_GRACE_MS = 100;
const CRASH_STAGING_GRACE_MS = 60_000;
const KEY_CHECK_CONTEXT = "ccc-notifier:codex-subagent-key-check:v1";
const SAFE_AGENT_TYPES = new Set([...KNOWN_AGENT_TYPES.values(), UNKNOWN_AGENT_TYPE]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activityPaths() {
  const home = paths().home;
  return {
    ledger: join(home, "codex-subagent-activity.json"),
    salt: join(home, "codex-subagent-key"),
    lock: join(home, "codex-subagent-activity.lock"),
    keyLock: join(home, "codex-subagent-key.lock"),
  };
}

function loadOrCreateSecret(): Buffer {
  const { salt: file, keyLock, ledger } = activityPaths();
  const lock = acquireOwnedLock(keyLock, 2_000);
  try {
    // keyLockを保持している間だけ、厳格な製品命名・regular file・十分な経過時間・
    // same-host dead PIDをすべて満たす秘密keyのcrash stagingを限定回収する。
    cleanupStaleFileStaging(file, 16);
    if (existsSync(file)) {
      const value = readFileSync(file);
      if (value.length === 32) return value;
      // Once activity exists, rotating the key would silently change every deterministic identity.
      // Preserve both files byte-for-byte and require explicit manual recovery instead.
      if (existsSync(ledger)) throw new Error("invalid activity key with existing ledger");
    }
    if (!existsSync(file) && existsSync(ledger)) {
      throw new Error("missing activity key with existing ledger");
    }
    const value = randomBytes(32);
    const staging = `${file}.${stagingHostTag()}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(staging, value, { mode: 0o600 });
      renameSync(staging, file);
    } finally {
      // rename前後の通常エラーで秘密keyの複製を残さない。成功時は既に存在しない。
      rmSync(staging, { force: true });
    }
    return value;
  } finally {
    lock.release();
  }
}

function keyed(secret: Buffer, domain: string, ...values: string[]): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`ccc-notifier:${domain}:v1\0`);
  for (const value of values) {
    hmac.update(String(Buffer.byteLength(value)));
    hmac.update(":");
    hmac.update(value);
    hmac.update("\0");
  }
  return hmac.digest("hex");
}

function computeKeyCheck(secret: Buffer): string {
  return createHmac("sha256", secret).update(KEY_CHECK_CONTEXT).digest("hex");
}

function keyCheckMatches(secret: Buffer, persisted: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(persisted)) return false;
  const actual = Buffer.from(computeKeyCheck(secret), "hex");
  const expected = Buffer.from(persisted, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function normalizeAgentType(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_AGENT_TYPE;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 64).toLowerCase();
  return KNOWN_AGENT_TYPES.get(cleaned) ?? UNKNOWN_AGENT_TYPE;
}

export function validateCodexSubagentPayload(
  payload: unknown,
  expectedKind?: CodexSubagentEventKind,
): ValidatedCodexSubagentEvent | null {
  if (!isObject(payload)) return null;
  const eventName = payload.hook_event_name;
  const kind = eventName === "SubagentStart" ? "start" : eventName === "SubagentStop" ? "stop" : null;
  if (kind === null || (expectedKind !== undefined && kind !== expectedKind)) return null;
  const { session_id: sessionId, turn_id: turnId, agent_id: agentId } = payload;
  if (
    typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 1024 ||
    typeof turnId !== "string" || turnId.length === 0 || turnId.length > 1024 ||
    typeof agentId !== "string" || agentId.length === 0 || agentId.length > 1024
  ) return null;

  const secret = loadVerifiedSecret();
  const projectionKey = keyed(secret, "parent-turn", sessionId, turnId);
  return {
    kind,
    projectionKey,
    agentKey: keyed(secret, "agent", projectionKey, agentId),
    agentTypeLabel: normalizeAgentType(payload.agent_type),
  };
}

/** Parent Stop payloadからkeyCheck検証済みlocal secretの匿名turn keyだけを導出する。 */
export function codexActivityProjectionKey(payload: unknown): string | null {
  if (!isObject(payload)) return null;
  const { session_id: sessionId, turn_id: turnId } = payload;
  if (
    typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 1024 ||
    typeof turnId !== "string" || turnId.length === 0 || turnId.length > 1024
  ) return null;
  return keyed(loadVerifiedSecret(), "parent-turn", sessionId, turnId);
}

function isoMin(a: string, b: string): string {
  return a <= b ? a : b;
}

function isoMax(a: string, b: string): string {
  return a >= b ? a : b;
}

export function reduceCodexSubagentActivity(
  previous: CodexSubagentActivityState | undefined,
  event: ValidatedCodexSubagentEvent,
  observedAt: string,
): CodexSubagentActivityState {
  const incomingLabel = event.agentTypeLabel;
  const label = previous === undefined
    ? incomingLabel
    : previous.agentTypeLabel === UNKNOWN_AGENT_TYPE
      ? incomingLabel
      : incomingLabel === UNKNOWN_AGENT_TYPE
        ? previous.agentTypeLabel
        : [previous.agentTypeLabel, incomingLabel].sort()[0];
  return {
    schemaVersion: 1,
    projectionKey: event.projectionKey,
    agentKey: event.agentKey,
    agentTypeLabel: label,
    startObserved: (previous?.startObserved ?? false) || event.kind === "start",
    stopObserved: (previous?.stopObserved ?? false) || event.kind === "stop",
    firstObservedAt: previous ? isoMin(previous.firstObservedAt, observedAt) : observedAt,
    lastObservedAt: previous ? isoMax(previous.lastObservedAt, observedAt) : observedAt,
  };
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export interface CodexActivityLock {
  token: string;
  release(): void;
}

function readLockOwner(lock: string): LockOwner | null {
  try {
    const ownerPath = statSync(lock).isDirectory() ? join(lock, "owner.json") : lock;
    const value: unknown = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (!isObject(value) || typeof value.token !== "string" || !/^[a-f0-9]{32}$/.test(value.token) ||
      typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      typeof value.hostname !== "string" || typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))) return null;
    return value as unknown as LockOwner;
  } catch {
    return null;
  }
}

function processLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (!isObject(error)) return "unknown";
    if (error.code === "EPERM") return "alive";
    if (error.code === "ESRCH") return "dead";
    return "unknown";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stagingHostTag(): string {
  return createHash("sha256")
    .update("ccc-notifier:staging-host:v1\0")
    .update(hostname())
    .digest("hex")
    .slice(0, 16);
}

/** Caller must hold the lock corresponding to file. */
function cleanupStaleFileStaging(file: string, randomHexLength: number): void {
  const parent = dirname(file);
  const pattern = new RegExp(
    `^${escapeRegExp(basename(file))}\\.([a-f0-9]{16})\\.(\\d+)\\.[a-f0-9]{${randomHexLength}}\\.tmp$`,
  );
  const localHostTag = stagingHostTag();
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    const match = pattern.exec(name);
    if (match === null) continue;
    // Hostless legacy names and foreign host tags are intentionally never auto-deleted.
    if (match[1] !== localHostTag) continue;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || processLiveness(pid) !== "dead") continue;
    const candidate = join(parent, name);
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile() || Date.now() - stat.mtimeMs < CRASH_STAGING_GRACE_MS) continue;
      rmSync(candidate);
    } catch {
      // Cleanup is best-effort. Never weaken the enclosing lock operation.
    }
  }
}

function releaseOwnedLock(lock: string, token: string): void {
  const owner = readLockOwner(lock);
  if (owner?.token !== token) return;
  const releasing = `${lock}.release-${token}`;
  try {
    renameSync(lock, releasing);
  } catch {
    return;
  }
  const movedOwner = readLockOwner(releasing);
  if (movedOwner?.token === token) rmSync(releasing, { recursive: true, force: true });
}

function claimAndRemove(lock: string): boolean {
  const recovery = `${lock}.recovery-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(lock, recovery);
  } catch {
    return !existsSync(lock);
  }
  rmSync(recovery, { recursive: true, force: true });
  return true;
}

function tryRecoverExistingLock(lock: string, malformedGraceMs: number): boolean {
  let stat;
  try {
    stat = statSync(lock);
  } catch (error) {
    return isObject(error) && error.code === "ENOENT";
  }
  const owner = readLockOwner(lock);
  if (owner !== null) {
    if (owner.hostname !== hostname()) return false;
    if (processLiveness(owner.pid) !== "dead") return false;
    return claimAndRemove(lock);
  }

  if (!stat.isDirectory()) return false;
  if (Date.now() - stat.mtimeMs < malformedGraceMs) return false;
  // A legacy writer may still be publishing owner.json. Re-read immediately before the claim.
  const rechecked = readLockOwner(lock);
  if (rechecked !== null) {
    if (rechecked.hostname !== hostname() || processLiveness(rechecked.pid) !== "dead") return false;
  }
  return claimAndRemove(lock);
}

function publishOwnedLock(lock: string, owner: LockOwner): boolean {
  const staging = `${lock}.init-${owner.token}`;
  const ownerTmp = join(staging, "owner.json.tmp");
  try {
    mkdirSync(staging);
    writeFileSync(ownerTmp, `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 });
    const ownerPath = join(staging, "owner.json");
    renameSync(ownerTmp, ownerPath);
    try {
      // A hard link is an atomic no-replace publication: an existing canonical file or
      // legacy directory can never be overwritten by a contender.
      linkSync(ownerPath, lock);
      return true;
    } catch (error) {
      // EEXIST proves contention even if the winning owner releases before our check.
      // Other errors fail closed when canonical is absent and are treated conservatively
      // as contention while it still exists.
      const errorCode = isObject(error) && typeof error.code === "string" ? error.code : null;
      if (errorCode === "EEXIST" || existsSync(lock)) return false;
      const code = errorCode !== null && /^[A-Z0-9_]+$/.test(errorCode)
        ? ` (${errorCode})`
        : "";
      throw new Error(`activity lock publication failed${code}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Caller owns canonical lock. Recover only old, valid, same-host dead-owner init directories. */
function cleanupStaleLockInitializations(lock: string): void {
  const parent = dirname(lock);
  const pattern = new RegExp(`^${escapeRegExp(basename(lock))}\\.init-([a-f0-9]{32})$`);
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    const match = pattern.exec(name);
    if (match === null) continue;
    const candidate = join(parent, name);
    try {
      const stat = lstatSync(candidate);
      const ownerStat = lstatSync(join(candidate, "owner.json"));
      const owner = readLockOwner(candidate);
      if (!stat.isDirectory() || Date.now() - stat.mtimeMs < CRASH_STAGING_GRACE_MS ||
        !ownerStat.isFile() || Date.now() - ownerStat.mtimeMs < CRASH_STAGING_GRACE_MS ||
        owner === null || owner.token !== match[1] || owner.hostname !== hostname() ||
        Date.now() - Date.parse(owner.createdAt) < CRASH_STAGING_GRACE_MS ||
        processLiveness(owner.pid) !== "dead") continue;
      const recovery = `${candidate}.recovery-${randomBytes(8).toString("hex")}`;
      try {
        renameSync(candidate, recovery);
      } catch {
        continue;
      }
      const movedOwner = readLockOwner(recovery);
      const movedStat = lstatSync(recovery);
      const movedOwnerStat = lstatSync(join(recovery, "owner.json"));
      if (movedStat.isDirectory() && Date.now() - movedStat.mtimeMs >= CRASH_STAGING_GRACE_MS &&
        movedOwnerStat.isFile() && Date.now() - movedOwnerStat.mtimeMs >= CRASH_STAGING_GRACE_MS &&
        movedOwner?.token === owner.token && movedOwner.hostname === owner.hostname &&
        movedOwner.pid === owner.pid && Date.now() - Date.parse(movedOwner.createdAt) >= CRASH_STAGING_GRACE_MS &&
        processLiveness(movedOwner.pid) === "dead") {
        rmSync(recovery, { recursive: true, force: true });
      } else if (!existsSync(candidate)) {
        try {
          renameSync(recovery, candidate);
        } catch {
          // Fail closed: an unverified recovery artifact is never deleted.
        }
      }
    } catch {
      // Cleanup is best-effort and may not disturb lock acquisition.
    }
  }
}

function acquireOwnedLock(
  lock: string,
  timeoutMs: number,
  malformedGraceMs = MALFORMED_LOCK_GRACE_MS,
): CodexActivityLock {
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(16).toString("hex");
  for (;;) {
    // Check at loop entry so an ENOENT recovery/continue race cannot bypass the bound.
    if (Date.now() >= deadline) throw new Error("activity lock timeout");
    const owner: LockOwner = { token, pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() };
    if (publishOwnedLock(lock, owner)) {
      cleanupStaleLockInitializations(lock);
      return { token, release: () => releaseOwnedLock(lock, token) };
    }
    if (tryRecoverExistingLock(lock, malformedGraceMs)) continue;
    if (Date.now() >= deadline) throw new Error("activity lock timeout");
    sleep(10);
  }
}

export function acquireCodexActivityLock(
  timeoutMs = 2_000,
  options: { staleMs?: number } = {},
): CodexActivityLock {
  // staleMs is retained as a test/backward-compatible alias for malformed initialization grace.
  return acquireOwnedLock(activityPaths().lock, timeoutMs, options.staleMs ?? MALFORMED_LOCK_GRACE_MS);
}

function validState(value: unknown): value is CodexSubagentActivityState {
  return isObject(value) && value.schemaVersion === 1 &&
    typeof value.projectionKey === "string" && /^[a-f0-9]{64}$/.test(value.projectionKey) &&
    typeof value.agentKey === "string" && /^[a-f0-9]{64}$/.test(value.agentKey) &&
    typeof value.agentTypeLabel === "string" && SAFE_AGENT_TYPES.has(value.agentTypeLabel) &&
    typeof value.startObserved === "boolean" && typeof value.stopObserved === "boolean" &&
    typeof value.firstObservedAt === "string" && Number.isFinite(Date.parse(value.firstObservedAt)) &&
    typeof value.lastObservedAt === "string" && Number.isFinite(Date.parse(value.lastObservedAt)) &&
    value.firstObservedAt <= value.lastObservedAt;
}

function readLedger(): Ledger {
  const file = activityPaths().ledger;
  if (!existsSync(file)) return { schemaVersion: 1, agents: {} };
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isObject(parsed) || parsed.schemaVersion !== 1 || !isObject(parsed.agents)) {
    throw new Error("invalid activity ledger");
  }
  if (parsed.keyCheck !== undefined &&
    (typeof parsed.keyCheck !== "string" || !/^[a-f0-9]{64}$/.test(parsed.keyCheck))) {
    throw new Error("invalid activity ledger keyCheck");
  }
  for (const [key, state] of Object.entries(parsed.agents)) {
    if (!validState(state) || state.agentKey !== key) throw new Error("invalid activity ledger entry");
  }
  return parsed as unknown as Ledger;
}

function atomicWriteLedger(ledger: Ledger): void {
  const file = activityPaths().ledger;
  const tmp = `${file}.${stagingHostTag()}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(ledger)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function verifyOrBackfillKeyCheck(secret: Buffer, ledger: Ledger): Ledger {
  if (ledger.keyCheck !== undefined) {
    if (!keyCheckMatches(secret, ledger.keyCheck)) throw new Error("activity key integrity mismatch; manual recovery required");
    return ledger;
  }
  const migrated: Ledger = { ...ledger, keyCheck: computeKeyCheck(secret) };
  atomicWriteLedger(migrated);
  return migrated;
}

function loadVerifiedSecret(): Buffer {
  const lock = acquireCodexActivityLock();
  try {
    cleanupStaleFileStaging(activityPaths().ledger, 12);
    const secret = loadOrCreateSecret();
    verifyOrBackfillKeyCheck(secret, readLedger());
    return secret;
  } finally {
    lock.release();
  }
}

export function recordCodexSubagentEvent(
  event: ValidatedCodexSubagentEvent,
  options: { observedAt?: string; lockTimeoutMs?: number } = {},
): CodexSubagentActivityState {
  const lock = acquireCodexActivityLock(options.lockTimeoutMs ?? 2_000);
  try {
    cleanupStaleFileStaging(activityPaths().ledger, 12);
    const secret = loadOrCreateSecret();
    const ledger = verifyOrBackfillKeyCheck(secret, readLedger());
    const prior = ledger.agents[event.agentKey];
    const observedAt = options.observedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error("invalid observation timestamp");
    const next = reduceCodexSubagentActivity(prior, event, observedAt);
    ledger.agents[event.agentKey] = next;
    atomicWriteLedger(ledger);
    return next;
  } finally {
    lock.release();
  }
}

export function readCodexSubagentActivity(projectionKey?: string): CodexSubagentActivityState[] {
  try {
    return Object.values(readLedger().agents).filter(
      (state) => projectionKey === undefined || state.projectionKey === projectionKey,
    );
  } catch (error) {
    logError("codex-subagent:read-ledger", error);
    return [];
  }
}

/** canonical台帳のunique stateをreader用runtime値へ投影する。料金は推測しない。 */
export function projectCodexSubagentActivity(
  states: readonly CodexSubagentActivityState[],
): TurnRecord["subagentActivity"] {
  if (states.length === 0) return undefined;
  return {
    started: states.filter((state) => state.startObserved).length,
    stopped: states.filter((state) => state.stopObserved).length,
    agentTypes: [...new Set(states.map((state) => state.agentTypeLabel))].sort(),
    usageStatus: "unavailable",
  };
}

/** Passive boundary: never throws and logs only a fixed, secret-free context string. */
export function handleCodexSubagentHook(rawText: string, kind: CodexSubagentEventKind): void {
  try {
    const parsed: unknown = JSON.parse(rawText);
    const event = validateCodexSubagentPayload(parsed, kind);
    if (event === null) throw new Error("invalid hook payload");
    recordCodexSubagentEvent(event);
  } catch (error) {
    const integrityFailure = error instanceof Error &&
      (error.message.includes("activity key integrity mismatch") ||
        error.message.includes("activity key with existing ledger") ||
        error.message.includes("activity ledger keyCheck"));
    logError(
      "codex-subagent-hook",
      new Error(integrityFailure
        ? "key integrity mismatch; manual recovery required; hook event was not recorded"
        : "hook event was not recorded"),
    );
  }
}
