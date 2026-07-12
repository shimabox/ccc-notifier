// history.jsonl / cursors.json / canonical dashboard の整合性を守るプロセス間ロック。
// 固定パスの削除は行わず、token確認後に固有quarantineへatomic renameしてから削除する。

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { paths } from "./store";

export const DATA_LOCK_LEASE_MS = 30_000;
const HEARTBEAT_MS = 5_000;

export interface DataLockOwner {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface DataLockHandle {
  token: string;
  heartbeat(): boolean;
  release(): void;
}

function ownerFile(dir: string): string {
  return join(dir, "owner.json");
}

function readOwner(dir: string): DataLockOwner | null {
  try {
    const v = JSON.parse(readFileSync(ownerFile(dir), "utf8")) as Partial<DataLockOwner>;
    if (
      typeof v.token !== "string" ||
      typeof v.pid !== "number" ||
      typeof v.hostname !== "string" ||
      typeof v.acquiredAt !== "string" ||
      typeof v.heartbeatAt !== "string"
    ) return null;
    return v as DataLockOwner;
  } catch {
    return null;
  }
}

function writeOwner(dir: string, owner: DataLockOwner): void {
  const tmp = join(dir, `owner.${owner.token}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(owner)}\n`, "utf8");
    renameSync(tmp, ownerFile(dir));
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** token一致を再確認し、固定pathを固有pathへrenameしてから削除する。 */
function quarantineOwned(dir: string, token: string, label: string): boolean {
  const before = readOwner(dir);
  if (before?.token !== token) return false;
  const quarantine = `${dir}.${label}-${token}-${randomUUID()}`;
  try {
    renameSync(dir, quarantine);
  } catch {
    return false;
  }
  const moved = readOwner(quarantine);
  if (moved?.token !== token) {
    // protocol外の置換を検出。誤削除を避け、固有pathを残す。
    return false;
  }
  rmSync(quarantine, { recursive: true, force: true });
  return true;
}

/** metadata完成済みの固有staging dirを固定pathへrenameする。 */
function claimDir(
  fixed: string,
  label: string,
  now: Date,
  metadataWriter: (dir: string, owner: DataLockOwner) => void = writeOwner,
): { token: string; owner: DataLockOwner } | null {
  const token = randomUUID();
  const staging = `${fixed}.${label}-${token}`;
  const iso = now.toISOString();
  const owner: DataLockOwner = { token, pid: process.pid, hostname: hostname(), acquiredAt: iso, heartbeatAt: iso };
  try {
    mkdirSync(staging);
    metadataWriter(staging, owner);
    renameSync(staging, fixed);
    return { token, owner };
  } catch {
    rmSync(staging, { recursive: true, force: true });
    return null;
  }
}

function processDefinitelyDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function reclaimerGuardBlocks(now: Date, leaseMs: number): boolean {
  const owner = readOwner(paths().dataReclaimDir);
  if (owner === null) return true;
  if (owner.hostname !== hostname()) return true;
  const heartbeat = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeat) || now.getTime() - heartbeat <= leaseMs) return true;
  return !processDefinitelyDead(owner.pid);
}

/** guard保持中だけ、死亡が確定した同一host ownerを回収する。 */
function tryReclaim(now: Date, leaseMs: number): boolean {
  const p = paths();
  // guard自身は自動回収しない。孤児guardを誤って新ownerごと消すより安全側に倒す。
  const guard = claimDir(p.dataReclaimDir, "claim", now);
  if (guard === null) return false;
  try {
    const first = readOwner(p.dataLockDir);
    if (first === null || first.hostname !== hostname()) return false;
    const heartbeatMs = Date.parse(first.heartbeatAt);
    if (!Number.isFinite(heartbeatMs) || now.getTime() - heartbeatMs <= leaseMs) return false;
    if (!processDefinitelyDead(first.pid)) return false; // alive / EPERM / unknown は回収禁止

    const second = readOwner(p.dataLockDir);
    if (second === null || second.token !== first.token || second.heartbeatAt !== first.heartbeatAt) return false;
    const orphan = `${p.dataLockDir}.orphan-${first.token}-${randomUUID()}`;
    try {
      renameSync(p.dataLockDir, orphan);
    } catch {
      return false;
    }
    const moved = readOwner(orphan);
    if (moved?.token !== first.token || moved.heartbeatAt !== first.heartbeatAt) return false;
    rmSync(orphan, { recursive: true, force: true });
    return true;
  } finally {
    quarantineOwned(p.dataReclaimDir, guard.token, "released");
  }
}

export function acquireDataLock(opts: {
  now?: Date;
  leaseMs?: number;
  /** failure-path test injection; production callers must omit. */
  metadataWriter?: (dir: string, owner: DataLockOwner) => void;
} = {}): DataLockHandle | null {
  const now = opts.now ?? new Date();
  const leaseMs = opts.leaseMs ?? DATA_LOCK_LEASE_MS;
  const p = paths();
  if (existsSync(p.dataReclaimDir) && reclaimerGuardBlocks(now, leaseMs)) return null;

  let claim = claimDir(p.dataLockDir, "acquire", now, opts.metadataWriter);
  if (claim === null) {
    if (!tryReclaim(now, leaseMs)) return null;
    if (existsSync(p.dataReclaimDir) && reclaimerGuardBlocks(now, leaseMs)) return null;
    claim = claimDir(p.dataLockDir, "acquire", now, opts.metadataWriter);
    if (claim === null) return null;
  }

  // guardとの同時開始競合。guard出現後に成立したownerは自分で退く。
  if (existsSync(p.dataReclaimDir) && reclaimerGuardBlocks(now, leaseMs)) {
    quarantineOwned(p.dataLockDir, claim.token, "yielded");
    return null;
  }

  let released = false;
  const heartbeat = (): boolean => {
    if (released) return false;
    const current = readOwner(p.dataLockDir);
    if (current?.token !== claim!.token) return false;
    writeOwner(p.dataLockDir, { ...current, heartbeatAt: new Date().toISOString() });
    return readOwner(p.dataLockDir)?.token === claim!.token;
  };
  const timer = setInterval(() => {
    try { heartbeat(); } catch { /* lease失効後はreclaimerに委ねる */ }
  }, HEARTBEAT_MS);
  timer.unref();

  return {
    token: claim.token,
    heartbeat,
    release(): void {
      if (released) return;
      released = true;
      clearInterval(timer);
      quarantineOwned(p.dataLockDir, claim!.token, "released");
    },
  };
}

export async function waitForDataLock(timeoutMs?: number, pollMs = 25): Promise<DataLockHandle | null> {
  const envTimeout = Number.parseInt(process.env.CCCN_LOCK_TIMEOUT_MS ?? "", 10);
  timeoutMs = timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout >= 0 ? envTimeout : 5000);
  const deadline = Date.now() + timeoutMs;
  do {
    const lock = acquireDataLock();
    if (lock !== null) return lock;
    if (Date.now() >= deadline) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  } while (true);
}
