import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireDataLock, waitForDataLock, type DataLockOwner } from "../src/data-lock";
import { paths } from "../src/store";
import { saveCursor } from "../src/store";
import type { Cursor } from "../src/types";

let home: string;
let oldHome: string | undefined;

beforeEach(() => {
  oldHome = process.env.CCCN_HOME;
  home = mkdtempSync(join(tmpdir(), "cccn-data-lock-"));
  process.env.CCCN_HOME = home;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = oldHome;
});

function seedOwner(dir: string, overrides: Partial<DataLockOwner> = {}): DataLockOwner {
  const owner: DataLockOwner = {
    token: `seed-${Math.random()}`,
    pid: 999_999,
    hostname: hostname(),
    acquiredAt: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    ...overrides,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owner.json"), JSON.stringify(owner), "utf8");
  return owner;
}

function killError(code: string): never {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  throw err;
}

describe("data lock", () => {
  it("excludes a second owner and releases via quarantine", () => {
    const first = acquireDataLock();
    expect(first).not.toBeNull();
    const owner = JSON.parse(readFileSync(join(paths().dataLockDir, "owner.json"), "utf8")) as DataLockOwner;
    expect(owner).toMatchObject({ token: first!.token, pid: process.pid, hostname: hostname() });
    expect(owner.acquiredAt).toBe(owner.heartbeatAt);
    expect(acquireDataLock()).toBeNull();
    expect(readdirSync(paths().cacheDir).filter((name) => name.includes(".acquire-"))).toEqual([]);
    first!.release();
    expect(existsSync(paths().dataLockDir)).toBe(false);
  });

  it("leaves no fixed or staging lock when initial metadata write fails", () => {
    expect(acquireDataLock({ metadataWriter: () => { throw new Error("metadata write failed"); } })).toBeNull();
    expect(existsSync(paths().dataLockDir)).toBe(false);
    expect(readdirSync(paths().cacheDir).filter((name) => name.includes("data.lock.acquire-"))).toEqual([]);
  });

  it("reclaims only a stale same-host owner whose PID is definitely ESRCH", () => {
    const old = seedOwner(paths().dataLockDir);
    vi.spyOn(process, "kill").mockImplementation((() => killError("ESRCH")) as typeof process.kill);
    const lock = acquireDataLock({ now: new Date("2030-01-01T00:00:00Z"), leaseMs: 1 });
    expect(lock).not.toBeNull();
    expect(lock!.token).not.toBe(old.token);
    expect(readFileSync(join(paths().dataLockDir, "owner.json"), "utf8")).toContain(lock!.token);
    lock!.release();
  });

  it.each([
    ["alive", null],
    ["eperm", "EPERM"],
  ])("never reclaims a stale same-host %s owner", (_label, code) => {
    const old = seedOwner(paths().dataLockDir);
    vi.spyOn(process, "kill").mockImplementation((() => {
      if (code) return killError(code);
      return true;
    }) as typeof process.kill);
    expect(acquireDataLock({ now: new Date("2030-01-01T00:00:00Z"), leaseMs: 1 })).toBeNull();
    expect(readFileSync(join(paths().dataLockDir, "owner.json"), "utf8")).toContain(old.token);
  });

  it("never probes or reclaims a foreign-host owner", () => {
    const old = seedOwner(paths().dataLockDir, { hostname: "other-host.invalid" });
    const kill = vi.spyOn(process, "kill");
    expect(acquireDataLock({ now: new Date("2030-01-01T00:00:00Z"), leaseMs: 1 })).toBeNull();
    expect(kill).not.toHaveBeenCalled();
    expect(readFileSync(join(paths().dataLockDir, "owner.json"), "utf8")).toContain(old.token);
  });

  it("an old release cannot delete a replacement owner", () => {
    const old = acquireDataLock();
    expect(old).not.toBeNull();
    const displaced = `${paths().dataLockDir}.externally-displaced`;
    renameSync(paths().dataLockDir, displaced);
    const replacement = acquireDataLock();
    expect(replacement).not.toBeNull();
    old!.release();
    expect(readFileSync(join(paths().dataLockDir, "owner.json"), "utf8")).toContain(replacement!.token);
    replacement!.release();
    rmSync(displaced, { recursive: true, force: true });
  });

  it("only one contender owns the lock after dead-owner reclaim", async () => {
    seedOwner(paths().dataLockDir);
    vi.spyOn(process, "kill").mockImplementation((() => killError("ESRCH")) as typeof process.kill);
    const [a, b, c] = await Promise.all([
      waitForDataLock(20, 1),
      waitForDataLock(20, 1),
      waitForDataLock(20, 1),
    ]);
    const owners = [a, b, c].filter((v) => v !== null);
    expect(owners).toHaveLength(1);
    owners[0]!.release();
  });

  it("a dead stale reclaimer guard does not block acquisition when main lock is absent", () => {
    seedOwner(paths().dataReclaimDir);
    vi.spyOn(process, "kill").mockImplementation((() => killError("ESRCH")) as typeof process.kill);
    const lock = acquireDataLock({ now: new Date("2030-01-01T00:00:00Z"), leaseMs: 1 });
    expect(lock).not.toBeNull();
    expect(existsSync(paths().dataReclaimDir)).toBe(true);
    lock!.release();
  });

  it("a dead stale reclaimer guard does not disrupt a live main owner", () => {
    const main = acquireDataLock();
    expect(main).not.toBeNull();
    seedOwner(paths().dataReclaimDir);
    vi.spyOn(process, "kill").mockImplementation((() => killError("ESRCH")) as typeof process.kill);
    expect(main!.heartbeat()).toBe(true);
    main!.release();
    expect(existsSync(paths().dataLockDir)).toBe(false);
  });

  it("main+guard both orphaned remains safely blocked", () => {
    seedOwner(paths().dataLockDir);
    seedOwner(paths().dataReclaimDir);
    vi.spyOn(process, "kill").mockImplementation((() => killError("ESRCH")) as typeof process.kill);
    expect(acquireDataLock({ now: new Date("2030-01-01T00:00:00Z"), leaseMs: 1 })).toBeNull();
    expect(existsSync(paths().dataLockDir)).toBe(true);
    expect(existsSync(paths().dataReclaimDir)).toBe(true);
  });

  it("serializes cursor writers so both dictionary entries survive", async () => {
    const cursor: Cursor = { offset: 1, lastUuid: null, lastTs: null, seenMessageKeys: [] };
    const write = async (key: string): Promise<void> => {
      const lock = await waitForDataLock();
      expect(lock).not.toBeNull();
      try { saveCursor(key, cursor); } finally { lock!.release(); }
    };
    await Promise.all([write("/a.jsonl"), write("/b.jsonl")]);
    const dict = JSON.parse(readFileSync(paths().cursorsFile, "utf8")) as Record<string, Cursor>;
    expect(Object.keys(dict).sort()).toEqual(["/a.jsonl", "/b.jsonl"]);
  });
});
