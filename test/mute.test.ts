// test/mute.test.ts — 通知ミュート(cccn mute / unmute)のユニット + track 統合テスト。
//
// 観点:
//   - mute/unmute が muted.json を正しく作成・削除する
//   - 期間付きミュートの期限判定(isMuted)
//   - 壊れた muted.json は「ミュートなし」に倒れる(通知が止まりっぱなしにならない)
//   - track 統合: ミュート中は記録はされるが通知されない / 期限切れなら通知される

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runMute, runUnmute } from "../src/mute";
import { isMuted, readMuteState, writeMuteState } from "../src/store";
import { runTrack } from "../src/track";

const FIXTURE_TRANSCRIPT = fileURLToPath(new URL("./fixtures/transcript-basic.jsonl", import.meta.url));
const FIXTURE_STDIN = fileURLToPath(new URL("./fixtures/stop-hook-stdin.json", import.meta.url));

let tmpHome: string;
let prevHome: string | undefined;
let prevDryRun: string | undefined;

beforeEach(() => {
  prevHome = process.env.CCCN_HOME;
  prevDryRun = process.env.CCCN_DRY_RUN;

  tmpHome = mkdtempSync(join(tmpdir(), "cccn-mute-test-"));
  process.env.CCCN_HOME = tmpHome;
  process.env.CCCN_DRY_RUN = "1";

  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });

  if (prevHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = prevHome;
  if (prevDryRun === undefined) delete process.env.CCCN_DRY_RUN;
  else process.env.CCCN_DRY_RUN = prevDryRun;
});

function muteFile(): string {
  return join(tmpHome, "muted.json");
}

describe("mute / unmute", () => {
  it("1. mute(引数なし)は無期限ミュートを muted.json に書く", () => {
    expect(runMute([])).toBe(0);
    expect(readMuteState()).toEqual({ until: null });
    expect(isMuted()).toBe(true);
  });

  it("2. mute 2h は期限付きミュートを書き、期限内は muted・期限後は unmuted", () => {
    const before = Date.now();
    expect(runMute(["2h"])).toBe(0);

    const state = readMuteState();
    expect(state).not.toBeNull();
    const until = new Date(state!.until!).getTime();
    // おおよそ now+2h(実行時間ぶんの誤差を許容)
    expect(until).toBeGreaterThanOrEqual(before + 2 * 3_600_000 - 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + 2 * 3_600_000 + 1000);

    expect(isMuted()).toBe(true);
    expect(isMuted(new Date(until + 1))).toBe(false);
  });

  it("3. 不正な期間指定は exit 1 で muted.json を作らない", () => {
    expect(runMute(["2x"])).toBe(1);
    expect(runMute(["0h"])).toBe(1);
    expect(runMute(["abc"])).toBe(1);
    expect(existsSync(muteFile())).toBe(false);
  });

  it("4. unmute は muted.json を削除して再開する(未ミュート時も exit 0)", () => {
    expect(runUnmute()).toBe(0); // 未ミュートでも成功

    runMute([]);
    expect(isMuted()).toBe(true);
    expect(runUnmute()).toBe(0);
    expect(existsSync(muteFile())).toBe(false);
    expect(isMuted()).toBe(false);
  });

  it("5. 壊れた muted.json は「ミュートなし」に倒れる", () => {
    writeFileSync(muteFile(), "{ broken json", "utf8");
    expect(readMuteState()).toBeNull();
    expect(isMuted()).toBe(false);

    writeFileSync(muteFile(), JSON.stringify({ until: "not-a-date" }), "utf8");
    expect(isMuted()).toBe(false);

    writeFileSync(muteFile(), JSON.stringify(["array"]), "utf8");
    expect(isMuted()).toBe(false);
  });
});

describe("track との統合", () => {
  let transcriptPath: string;

  beforeEach(() => {
    transcriptPath = join(tmpHome, "transcript.jsonl");
    copyFileSync(FIXTURE_TRANSCRIPT, transcriptPath);
  });

  function stdinFor(path: string): string {
    const raw = readFileSync(FIXTURE_STDIN, "utf8");
    return raw.replace('"__TRANSCRIPT_PATH__"', () => JSON.stringify(path));
  }

  function readHistoryLines(): string[] {
    const f = join(tmpHome, "history.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
  }

  it("6. ミュート中: history には記録するが last-notify.json は作られない", async () => {
    writeMuteState({ until: null });

    await runTrack(stdinFor(transcriptPath));

    expect(readHistoryLines()).toHaveLength(1);
    expect(existsSync(join(tmpHome, "last-notify.json"))).toBe(false);
  });

  it("7. 期限切れミュート: 通常どおり通知される", async () => {
    writeMuteState({ until: new Date(Date.now() - 60_000).toISOString() });

    await runTrack(stdinFor(transcriptPath));

    expect(readHistoryLines()).toHaveLength(1);
    expect(existsSync(join(tmpHome, "last-notify.json"))).toBe(true);
  });
});
