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

/**
 * Codex rollout の先頭行(session_meta)。base_instructions を含むため長くなりうる。
 * ここでも 8192 バイトを確実に超える長さで書く。
 */
function writeRollout(dir: string, name: string, sessionId: string, originator: string): void {
  const meta = {
    timestamp: "2026-07-10T12:09:25.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp: "2026-07-10T12:09:25.000Z",
      cwd: "/home/user/proj",
      originator,
      cli_version: "0.142.5",
      source: "cli",
      model_provider: "openai",
      base_instructions: "指示".repeat(6000), // 先頭行を 8192 バイト超にする
    },
  };
  const line = JSON.stringify(meta);
  expect(Buffer.byteLength(line, "utf8")).toBeGreaterThan(8192);
  writeFileSync(
    join(dir, name),
    line +
      "\n" +
      '{"timestamp":"2026-07-10T12:09:34.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}\n',
    "utf8",
  );
}

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

  it("8192 バイトを超える Codex rollout の先頭行でも originator を読み取れる", async () => {
    const codexSessions = join(tmpHome, "codex-home", "sessions", "2026", "07", "10");
    mkdirSync(codexSessions, { recursive: true });
    process.env.CCCN_CODEX_HOME = join(tmpHome, "codex-home");
    writeRollout(codexSessions, "rollout-a.jsonl", "01234567-aaaa-7000-8000-00000000000a", "codex-tui");
    writeRollout(codexSessions, "rollout-b.jsonl", "01234567-bbbb-7000-8000-00000000000b", "Codex Desktop");

    await runDoctor();

    const out = logs.join("\n");
    expect(out).toContain("Codex originator 内訳: codex-tui:1 / Codex Desktop:1");
    expect(out).not.toContain("(unknown)");
    expect(out).toContain("同一 session_id が複数の Codex rollout ファイルに重複するケースは検出されませんでした");
  });

  it("同一 session_id を持つ Codex rollout が複数あれば warn で検知する", async () => {
    const codexSessions = join(tmpHome, "codex-home", "sessions", "2026", "07", "10");
    mkdirSync(codexSessions, { recursive: true });
    process.env.CCCN_CODEX_HOME = join(tmpHome, "codex-home");
    const shared = "01234567-cccc-7000-8000-00000000000c";
    writeRollout(codexSessions, "rollout-dup1.jsonl", shared, "codex-tui");
    writeRollout(codexSessions, "rollout-dup2.jsonl", shared, "codex-tui");

    await runDoctor();

    expect(logs.join("\n")).toContain("同一 session_id を持つ Codex rollout が複数ファイルにまたがっています(1件)");
  });

  it("8192 バイトを超える Claude transcript の先頭行でも sessionId を読み取れる", async () => {
    // Claude transcript も先頭行が 8192 バイトを超えることがある。
    const long = JSON.stringify({
      type: "user",
      sessionId: "long-head-session",
      cwd: "/tmp/proj",
      timestamp: "2026-07-06T10:00:00.000Z",
      message: { role: "user", content: "長いプロンプト".repeat(2000) },
    });
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(8192);
    writeFileSync(join(desktopA, "proj", "long-head-session.jsonl"), long + "\n", "utf8");
    writeFileSync(join(desktopB, "proj", "long-head-session.jsonl"), long + "\n", "utf8");

    await runDoctor();

    const out = logs.join("\n");
    expect(out).toContain("同一 sessionId が複数の transcript ファイルに現れています");
    expect(out).toContain("long-hea…(2ファイル)");
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
