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
  sessionKey: string;
  agentKey: string;
  agentTypeLabel: string;
}

export interface ValidatedCodexRootEvent {
  sessionKey: string;
  rootKey: string;
}

interface RawCodexSubagentEvent {
  kind: CodexSubagentEventKind;
  sessionId: string;
  agentId: string;
  agentTypeLabel: string;
}

interface RawCodexRootEvent {
  sessionId: string;
  turnId: string;
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

interface LedgerV1 {
  schemaVersion: 1;
  keyCheck?: string;
  agents: Record<string, CodexSubagentActivityState>;
}

interface RootState {
  sessionKey: string;
  status: "open" | "closed" | "abandoned";
  openedAt: string;
  openedSequence: number;
  closedAt?: string;
  closedSequence?: number;
  agents: Record<string, CodexSubagentActivityState>;
}

interface SessionState {
  activeRootKey: string | null;
  latestRootKey: string | null;
}

interface LedgerV2 {
  schemaVersion: 2;
  keyCheck: string;
  sequence: number;
  sessions: Record<string, SessionState>;
  roots: Record<string, RootState>;
  agentAssignments: Record<string, string>;
  conflictedAgents: Record<string, true>;
  legacyV1?: { agents: Record<string, CodexSubagentActivityState> };
}

type Ledger = LedgerV1 | LedgerV2;

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

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowlist = new Set(allowed);
  return Object.keys(value).every((key) => allowlist.has(key));
}

function activityPaths() {
  const home = paths().home;
  return {
    ledger: join(home, "codex-subagent-activity.json"),
    salt: join(home, "codex-subagent-key"),
    lock: join(home, "codex-subagent-activity.lock"),
    keyLock: join(home, "codex-subagent-key.lock"),
    legacyBackup: join(home, "codex-subagent-activity.v1.json"),
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

function keyedV2(secret: Buffer, domain: string, ...values: string[]): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`ccc-notifier:${domain}\0`);
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
  const raw = validateRawCodexSubagentPayload(payload, expectedKind);
  if (raw === null) return null;
  return deriveCodexSubagentEvent(loadVerifiedSecret(), raw);
}

function validateRawCodexSubagentPayload(
  payload: unknown,
  expectedKind?: CodexSubagentEventKind,
): RawCodexSubagentEvent | null {
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

  return {
    kind,
    sessionId,
    agentId,
    agentTypeLabel: normalizeAgentType(payload.agent_type),
  };
}

function deriveCodexSubagentEvent(secret: Buffer, raw: RawCodexSubagentEvent): ValidatedCodexSubagentEvent {
  return {
    kind: raw.kind,
    sessionKey: keyedV2(secret, "root-session-v2", raw.sessionId),
    agentKey: keyedV2(secret, "agent-identity-v2", raw.sessionId, raw.agentId),
    agentTypeLabel: raw.agentTypeLabel,
  };
}

function validateCodexRootPayload(payload: unknown, expectedEvent: "UserPromptSubmit" | "Stop"): RawCodexRootEvent | null {
  if (!isObject(payload)) return null;
  if (payload.hook_event_name !== expectedEvent) return null;
  const { session_id: sessionId, turn_id: turnId } = payload;
  if (
    typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 1024 ||
    typeof turnId !== "string" || turnId.length === 0 || turnId.length > 1024
  ) return null;
  return { sessionId, turnId };
}

function deriveCodexRootEvent(secret: Buffer, raw: RawCodexRootEvent): ValidatedCodexRootEvent {
  return {
    sessionKey: keyedV2(secret, "root-session-v2", raw.sessionId),
    rootKey: keyedV2(secret, "root-turn-v2", raw.sessionId, raw.turnId),
  };
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
  projectionKey = previous?.projectionKey,
): CodexSubagentActivityState {
  if (projectionKey === undefined) throw new Error("missing root assignment");
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
    projectionKey,
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
  return isObject(value) &&
    hasOnlyKeys(value, [
      "schemaVersion", "projectionKey", "agentKey", "agentTypeLabel", "startObserved", "stopObserved",
      "firstObservedAt", "lastObservedAt",
    ]) && value.schemaVersion === 1 &&
    typeof value.projectionKey === "string" && /^[a-f0-9]{64}$/.test(value.projectionKey) &&
    typeof value.agentKey === "string" && /^[a-f0-9]{64}$/.test(value.agentKey) &&
    typeof value.agentTypeLabel === "string" && SAFE_AGENT_TYPES.has(value.agentTypeLabel) &&
    typeof value.startObserved === "boolean" && typeof value.stopObserved === "boolean" &&
    typeof value.firstObservedAt === "string" && Number.isFinite(Date.parse(value.firstObservedAt)) &&
    typeof value.lastObservedAt === "string" && Number.isFinite(Date.parse(value.lastObservedAt)) &&
    value.firstObservedAt <= value.lastObservedAt;
}

function isHexKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validateV1(value: unknown): LedgerV1 {
  if (!isObject(value) || !hasOnlyKeys(value, ["schemaVersion", "keyCheck", "agents"]) ||
    value.schemaVersion !== 1 || !isObject(value.agents)) {
    throw new Error("invalid activity ledger");
  }
  if (value.keyCheck !== undefined && !isHexKey(value.keyCheck)) {
    throw new Error("invalid activity ledger keyCheck");
  }
  for (const [key, state] of Object.entries(value.agents)) {
    if (!validState(state) || state.agentKey !== key) throw new Error("invalid activity ledger entry");
  }
  return value as unknown as LedgerV1;
}

function validSessionState(value: unknown): value is SessionState {
  return isObject(value) && hasOnlyKeys(value, ["activeRootKey", "latestRootKey"]) &&
    (value.activeRootKey === null || isHexKey(value.activeRootKey)) &&
    (value.latestRootKey === null || isHexKey(value.latestRootKey));
}

function validRootState(value: unknown): value is RootState {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "sessionKey", "status", "openedAt", "openedSequence", "closedAt", "closedSequence", "agents",
  ]) || !isHexKey(value.sessionKey) ||
    (value.status !== "open" && value.status !== "closed" && value.status !== "abandoned") ||
    typeof value.openedAt !== "string" || !Number.isFinite(Date.parse(value.openedAt)) ||
    typeof value.openedSequence !== "number" || !Number.isSafeInteger(value.openedSequence) || value.openedSequence < 1 ||
    !isObject(value.agents)) return false;
  if (value.closedAt !== undefined &&
    (typeof value.closedAt !== "string" || !Number.isFinite(Date.parse(value.closedAt)))) return false;
  if (value.closedSequence !== undefined &&
    (typeof value.closedSequence !== "number" || !Number.isSafeInteger(value.closedSequence) || value.closedSequence < 1)) return false;
  if (value.status === "closed" && (value.closedAt === undefined || value.closedSequence === undefined)) return false;
  if (value.status !== "closed" && (value.closedAt !== undefined || value.closedSequence !== undefined)) return false;
  for (const [key, state] of Object.entries(value.agents)) {
    if (!validState(state) || state.agentKey !== key) return false;
  }
  return true;
}

function validateV2(value: unknown): LedgerV2 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "schemaVersion", "keyCheck", "sequence", "sessions", "roots", "agentAssignments", "conflictedAgents",
    "legacyV1",
  ]) || value.schemaVersion !== 2 || !isHexKey(value.keyCheck) ||
    typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
    !isObject(value.sessions) || !isObject(value.roots) || !isObject(value.agentAssignments) ||
    !isObject(value.conflictedAgents)) throw new Error("invalid activity ledger v2");
  for (const [key, session] of Object.entries(value.sessions)) {
    if (!isHexKey(key) || !validSessionState(session)) throw new Error("invalid activity session");
  }
  for (const [key, root] of Object.entries(value.roots)) {
    if (!isHexKey(key) || !validRootState(root)) throw new Error("invalid activity root");
  }
  for (const [agentKey, rootKey] of Object.entries(value.agentAssignments)) {
    if (!isHexKey(agentKey) || !isHexKey(rootKey) || !(rootKey in value.roots)) {
      throw new Error("invalid activity assignment");
    }
  }
  for (const [agentKey, marker] of Object.entries(value.conflictedAgents)) {
    if (!isHexKey(agentKey) || marker !== true) throw new Error("invalid activity conflict");
  }
  if (value.legacyV1 !== undefined) {
    if (!isObject(value.legacyV1) || !hasOnlyKeys(value.legacyV1, ["agents"]) ||
      !isObject(value.legacyV1.agents)) {
      throw new Error("invalid legacy activity ledger");
    }
    for (const [key, state] of Object.entries(value.legacyV1.agents)) {
      if (!validState(state) || state.agentKey !== key) throw new Error("invalid legacy activity entry");
    }
  }
  const ledger = value as unknown as LedgerV2;
  for (const [agentKey, rootKey] of Object.entries(ledger.agentAssignments)) {
    if (ledger.roots[rootKey]?.agents[agentKey] === undefined) {
      throw new Error("invalid activity assignment state");
    }
  }
  const openCount = new Map<string, number>();
  const rootedAgents = new Set<string>();
  for (const [rootKey, root] of Object.entries(ledger.roots)) {
    if (ledger.sessions[root.sessionKey] === undefined) throw new Error("missing activity session");
    if (root.status === "open") openCount.set(root.sessionKey, (openCount.get(root.sessionKey) ?? 0) + 1);
    for (const [agentKey, state] of Object.entries(root.agents)) {
      if (state.projectionKey !== rootKey) throw new Error("activity projection root mismatch");
      if (rootedAgents.has(agentKey)) throw new Error("activity agent appears in multiple roots");
      rootedAgents.add(agentKey);
      if (ledger.agentAssignments[agentKey] !== rootKey) throw new Error("missing reverse activity assignment");
    }
  }
  for (const [sessionKey, session] of Object.entries(ledger.sessions)) {
    if ((openCount.get(sessionKey) ?? 0) > 1) throw new Error("ambiguous open root state");
    if (session.activeRootKey !== null) {
      const root = ledger.roots[session.activeRootKey];
      if (root === undefined || root.sessionKey !== sessionKey || root.status !== "open") {
        throw new Error("invalid active root pointer");
      }
    }
    if (session.latestRootKey !== null) {
      const root = ledger.roots[session.latestRootKey];
      if (root === undefined || root.sessionKey !== sessionKey) throw new Error("invalid latest root pointer");
    }
  }
  return ledger;
}

function atomicWriteLedger(ledger: LedgerV2): void {
  const file = activityPaths().ledger;
  const tmp = `${file}.${stagingHostTag()}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(ledger)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function emptyV2(secret: Buffer): LedgerV2 {
  return {
    schemaVersion: 2,
    keyCheck: computeKeyCheck(secret),
    sequence: 0,
    sessions: {},
    roots: {},
    agentAssignments: {},
    conflictedAgents: {},
  };
}

function writeLegacyBackup(raw: string): void {
  const file = activityPaths().legacyBackup;
  if (existsSync(file)) {
    if (readFileSync(file, "utf8") !== raw) throw new Error("activity v1 backup mismatch");
    return;
  }
  const tmp = `${file}.${stagingHostTag()}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, raw, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Caller holds the activity lock. Valid v1 is backed up once and atomically migrated. */
function readLedgerForMutation(secret: Buffer): LedgerV2 {
  const file = activityPaths().ledger;
  if (!existsSync(file)) return emptyV2(secret);
  const raw = readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (isObject(parsed) && parsed.schemaVersion === 2) {
    const ledger = validateV2(parsed);
    if (!keyCheckMatches(secret, ledger.keyCheck)) {
      throw new Error("activity key integrity mismatch; manual recovery required");
    }
    return ledger;
  }
  const legacy = validateV1(parsed);
  if (legacy.keyCheck !== undefined && !keyCheckMatches(secret, legacy.keyCheck)) {
    throw new Error("activity key integrity mismatch; manual recovery required");
  }
  writeLegacyBackup(raw);
  const migrated = emptyV2(secret);
  migrated.legacyV1 = { agents: legacy.agents };
  atomicWriteLedger(migrated);
  return migrated;
}

function loadVerifiedSecret(): Buffer {
  const lock = acquireCodexActivityLock();
  try {
    cleanupStaleFileStaging(activityPaths().ledger, 12);
    const secret = loadOrCreateSecret();
    const ledger = readLedgerForMutation(secret);
    if (!existsSync(activityPaths().ledger)) atomicWriteLedger(ledger);
    return secret;
  } finally {
    lock.release();
  }
}

function recordCodexSubagentEventInLedger(
  ledger: LedgerV2,
  event: ValidatedCodexSubagentEvent,
  observedAt: string,
): CodexSubagentActivityState | null {
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("invalid observation timestamp");
  if (ledger.conflictedAgents[event.agentKey] === true) return null;

  let rootKey = ledger.agentAssignments[event.agentKey];
  const session = ledger.sessions[event.sessionKey];
  const activeRootKey = session?.activeRootKey ?? null;
  if (rootKey !== undefined) {
    const assignedRoot = ledger.roots[rootKey];
    if (assignedRoot === undefined || assignedRoot.sessionKey !== event.sessionKey) {
      throw new Error("invalid activity assignment integrity");
    }
    if (event.kind === "start" && activeRootKey !== null && activeRootKey !== rootKey) {
      ledger.conflictedAgents[event.agentKey] = true;
      atomicWriteLedger(ledger);
      logError("codex-subagent:agent-conflict", new Error("agent identity conflict; event was not recorded"));
      return null;
    }
  } else {
    // A Stop without a prior assignment may be a late event from an older root. Even while
    // another root is active, assigning it would be a guess and could corrupt that turn.
    if (event.kind !== "start" || activeRootKey === null) return null;
    const activeRoot = ledger.roots[activeRootKey];
    if (activeRoot === undefined || activeRoot.status !== "open" || activeRoot.sessionKey !== event.sessionKey) {
      return null;
    }
    rootKey = activeRootKey;
    ledger.agentAssignments[event.agentKey] = rootKey;
  }

  const root = ledger.roots[rootKey];
  if (root === undefined) throw new Error("missing assigned activity root");
  const prior = root.agents[event.agentKey];
  const next = reduceCodexSubagentActivity(prior, event, observedAt, rootKey);
  root.agents[event.agentKey] = next;
  atomicWriteLedger(ledger);
  return next;
}

export function recordCodexSubagentEvent(
  event: ValidatedCodexSubagentEvent,
  options: { observedAt?: string; lockTimeoutMs?: number } = {},
): CodexSubagentActivityState | null {
  const lock = acquireCodexActivityLock(options.lockTimeoutMs ?? 2_000);
  try {
    cleanupStaleFileStaging(activityPaths().ledger, 12);
    const secret = loadOrCreateSecret();
    const ledger = readLedgerForMutation(secret);
    const observedAt = options.observedAt ?? new Date().toISOString();
    return recordCodexSubagentEventInLedger(ledger, event, observedAt);
  } finally {
    lock.release();
  }
}

/** Raw hook identity, HMAC derivation, active-root lookup, and write share one lock. */
export function recordCodexSubagentPayload(
  payload: unknown,
  expectedKind: CodexSubagentEventKind,
  options: { observedAt?: string; lockTimeoutMs?: number } = {},
): CodexSubagentActivityState | null {
  const lock = acquireCodexActivityLock(options.lockTimeoutMs ?? 2_000);
  try {
    const raw = validateRawCodexSubagentPayload(payload, expectedKind);
    if (raw === null) throw new Error("invalid hook payload");
    cleanupStaleFileStaging(activityPaths().ledger, 12);
    const secret = loadOrCreateSecret();
    const ledger = readLedgerForMutation(secret);
    const event = deriveCodexSubagentEvent(secret, raw);
    return recordCodexSubagentEventInLedger(ledger, event, options.observedAt ?? new Date().toISOString());
  } finally {
    lock.release();
  }
}

export function readCodexSubagentActivity(projectionKey?: string): CodexSubagentActivityState[] {
  try {
    const file = activityPaths().ledger;
    if (!existsSync(file)) return [];
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    let states: CodexSubagentActivityState[];
    if (isObject(parsed) && parsed.schemaVersion === 1) {
      const ledger = validateV1(parsed);
      if (ledger.keyCheck !== undefined) {
        const secret = readFileSync(activityPaths().salt);
        if (secret.length !== 32 || !keyCheckMatches(secret, ledger.keyCheck)) {
          throw new Error("activity key integrity mismatch; read was rejected");
        }
      }
      states = Object.values(ledger.agents);
    } else {
      const ledger = validateV2(parsed);
      const secret = readFileSync(activityPaths().salt);
      if (secret.length !== 32 || !keyCheckMatches(secret, ledger.keyCheck)) {
        throw new Error("activity key integrity mismatch; read was rejected");
      }
      states = [
        ...Object.values(ledger.roots).flatMap((root) => Object.values(root.agents)),
        ...Object.values(ledger.legacyV1?.agents ?? {}),
      ];
    }
    return states.filter(
      (state) => projectionKey === undefined || state.projectionKey === projectionKey,
    );
  } catch (error) {
    logError("codex-subagent:read-ledger", error);
    return [];
  }
}

function nextSequence(ledger: LedgerV2): number {
  if (ledger.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("activity sequence exhausted");
  ledger.sequence += 1;
  return ledger.sequence;
}

export function openCodexRootContext(
  payload: unknown,
  options: { observedAt?: string; lockTimeoutMs?: number } = {},
): string | null {
  const lock = acquireCodexActivityLock(options.lockTimeoutMs ?? 2_000);
  try {
    const raw = validateCodexRootPayload(payload, "UserPromptSubmit");
    if (raw === null) return null;
    const secret = loadOrCreateSecret();
    const ledger = readLedgerForMutation(secret);
    const event = deriveCodexRootEvent(secret, raw);
    const observedAt = options.observedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error("invalid observation timestamp");
    const existing = ledger.roots[event.rootKey];
    if (existing !== undefined) {
      return event.rootKey;
    }
    const session = ledger.sessions[event.sessionKey] ?? { activeRootKey: null, latestRootKey: null };
    if (session.activeRootKey !== null) {
      const previous = ledger.roots[session.activeRootKey];
      if (previous === undefined || previous.status !== "open") throw new Error("invalid active root state");
      previous.status = "abandoned";
    }
    const sequence = nextSequence(ledger);
    ledger.roots[event.rootKey] = {
      sessionKey: event.sessionKey,
      status: "open",
      openedAt: observedAt,
      openedSequence: sequence,
      agents: {},
    };
    session.activeRootKey = event.rootKey;
    session.latestRootKey = event.rootKey;
    ledger.sessions[event.sessionKey] = session;
    atomicWriteLedger(ledger);
    return event.rootKey;
  } finally {
    lock.release();
  }
}

export function closeCodexRootContext(
  payload: unknown,
  options: { observedAt?: string; lockTimeoutMs?: number } = {},
): string | null {
  const lock = acquireCodexActivityLock(options.lockTimeoutMs ?? 2_000);
  try {
    const raw = validateCodexRootPayload(payload, "Stop");
    if (raw === null) return null;
    const secret = loadOrCreateSecret();
    const ledger = readLedgerForMutation(secret);
    const event = deriveCodexRootEvent(secret, raw);
    const root = ledger.roots[event.rootKey];
    if (root === undefined || root.sessionKey !== event.sessionKey) return null;
    if (root.status === "closed") return event.rootKey;
    const observedAt = options.observedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error("invalid observation timestamp");
    root.status = "closed";
    root.closedAt = observedAt;
    root.closedSequence = nextSequence(ledger);
    const session = ledger.sessions[event.sessionKey];
    if (session?.activeRootKey === event.rootKey) session.activeRootKey = null;
    atomicWriteLedger(ledger);
    return event.rootKey;
  } finally {
    lock.release();
  }
}

/** Backward-compatible export: parent Stop now closes an exact v2 root context. */
export function codexActivityProjectionKey(payload: unknown): string | null {
  return closeCodexRootContext(payload);
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
    recordCodexSubagentPayload(parsed, kind);
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


/** Passive UserPromptSubmit boundary. Prompt/body/path fields are never persisted or logged. */
export function handleCodexUserPromptSubmitHook(rawText: string): void {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (openCodexRootContext(parsed) === null) throw new Error("invalid hook payload");
  } catch {
    logError("codex-root-hook", new Error("root context was not recorded"));
  }
}
