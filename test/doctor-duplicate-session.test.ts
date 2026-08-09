// test/doctor-duplicate-session.test.ts — doctor の「同一 sessionId が複数ルートに現れる」検知。
//
// runDoctor() を直接 import して呼ぶ(dist/cli.js は使わない)。他のチェック(hook 登録・通知等)は
// 失敗・警告してもよく、ここでは transcript ファイル側の sessionId 重複検知だけを検証する。
// 判定はサーフェスの種類ではなくファイル単位。デスクトップルートが2つある構成のように、
// 同じサーフェスのルート間で複製されたケースも検知対象に入る。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { runDoctor } from "../src/doctor";

let tmpHome: string;
let cliProjects: string;
let desktopA: string;
let desktopB: string;
let logs: string[];
const prev: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "CCCN_HOME",
  "CCCN_CODEX_HOME",
  "CCCN_CLAUDE_PROJECTS",
  "CCCN_CLAUDE_DESKTOP_ROOTS",
  "CCCN_CLAUDE_SETTINGS",
];

beforeEach(() => {
  for (const k of ENV_KEYS) prev[k] = process.env[k];

  tmpHome = mkdtempSync(join(tmpdir(), "cccn-doctor-dupsess-"));
  cliProjects = join(tmpHome, "claude-projects");
  desktopA = join(tmpHome, "desktop-a", ".claude", "projects");
  desktopB = join(tmpHome, "desktop-b", ".claude", "projects");
  mkdirSync(join(cliProjects, "proj"), { recursive: true });
  mkdirSync(join(desktopA, "proj"), { recursive: true });
  mkdirSync(join(desktopB, "proj"), { recursive: true });

  process.env.CCCN_HOME = tmpHome;
  process.env.CCCN_CODEX_HOME = join(tmpHome, "no-codex-home");
  process.env.CCCN_CLAUDE_PROJECTS = cliProjects;
  process.env.CCCN_CLAUDE_DESKTOP_ROOTS = [desktopA, desktopB].join(delimiter);
  process.env.CCCN_CLAUDE_SETTINGS = join(tmpHome, "no-settings.json");

  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
});

function writeTranscript(dir: string, sessionId: string): void {
  writeFileSync(
    join(dir, "proj", `${sessionId}.jsonl`),
    JSON.stringify({ type: "user", sessionId, cwd: "/tmp/proj", timestamp: "2026-07-06T10:00:00.000Z" }) + "\n",
    "utf8",
  );
}

describe("doctor: 同一 sessionId の transcript 重複検知", () => {
  it("同じサーフェスの別ルート(デスクトップルート2つ)に同一 sessionId があっても検知する", async () => {
    writeTranscript(desktopA, "dup-session-1");
    writeTranscript(desktopB, "dup-session-1");

    await runDoctor();

    const out = logs.join("\n");
    expect(out).toContain("同一 sessionId が複数の transcript ファイルに現れています");
    expect(out).toContain("うち複数ルートにまたがるもの 1件");
    expect(out).toContain("dup-sess…(2ファイル)");
  });

  it("cli ルートとデスクトップルートにまたがる場合も検知する", async () => {
    writeTranscript(cliProjects, "dup-session-2");
    writeTranscript(desktopA, "dup-session-2");

    await runDoctor();

    expect(logs.join("\n")).toContain("同一 sessionId が複数の transcript ファイルに現れています");
  });

  it("重複が無ければ ok で報告する", async () => {
    writeTranscript(cliProjects, "only-here-1");
    writeTranscript(desktopA, "only-here-2");

    await runDoctor();

    expect(logs.join("\n")).toContain(
      "同一 sessionId が複数の Claude transcript ファイルに重複するケースは検出されませんでした",
    );
  });
});
