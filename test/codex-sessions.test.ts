import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { findLatestCodexRollout, listCodexRollouts } from "../src/codex/sessions";

describe("Codex rollout discovery", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cccn-codex-sessions-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeRollout(relative: string, mtime: Date): string {
    const file = join(root, relative);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{}\n");
    utimesSync(file, mtime, mtime);
    return resolve(file);
  }

  it("深さ4以内の通常rolloutだけを列挙しsymlink・別名・深さ超過を追わない", async () => {
    const valid = writeRollout("2026/07/14/rollout-valid.jsonl", new Date(1000));
    writeRollout("2026/07/14/not-rollout.jsonl", new Date(2000));
    writeRollout("2026/07/14/extra/rollout-too-deep.jsonl", new Date(3000));
    mkdirSync(join(root, "2026/07/14/rollout-directory.jsonl"));
    const outside = writeRollout("outside.jsonl", new Date(4000));
    symlinkSync(outside, join(root, "2026/07/14/rollout-symlink.jsonl"));
    symlinkSync(join(root, "2026"), join(root, "linked-year"));

    const result = await listCodexRollouts(root);
    expect(result.rollouts).toEqual([valid]);
    expect(result.unreadableDirs).toBe(0);
  });

  it("mtime最大を選び、同値なら絶対path辞書順で決定する", async () => {
    writeRollout("2026/07/13/rollout-old.jsonl", new Date(1000));
    const sameB = writeRollout("2026/07/14/rollout-b.jsonl", new Date(3000));
    const sameA = writeRollout("2026/07/14/rollout-a.jsonl", new Date(3000));
    const result = await findLatestCodexRollout(root);
    expect(result.latest).toBe([sameA, sameB].sort()[0]);
    expect(result.unreadableDirs).toBe(0);
    expect(result.unreadableFiles).toBe(0);
  });

  it("sessions root自体がsymlinkなら追跡せず最新を確定不能として返す", async () => {
    const realRoot = join(root, "real-sessions");
    mkdirSync(realRoot);
    writeFileSync(join(realRoot, "rollout-hidden.jsonl"), "{}\n");
    const linkedRoot = join(root, "linked-sessions");
    symlinkSync(realRoot, linkedRoot);
    const result = await findLatestCodexRollout(linkedRoot);
    expect(result.latest).toBeNull();
    expect(result.unreadableDirs).toBe(1);
  });
});
