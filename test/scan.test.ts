// test/scan.test.ts — `cccn scan` サブコマンド(src/scan.ts)の単体テスト。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runScan } from "../src/scan";

const FIXTURE_TRANSCRIPT = fileURLToPath(new URL("./fixtures/transcript-basic.jsonl", import.meta.url));

let tmpHome: string;
let cliProjects: string;
let prevHome: string | undefined;
let prevProjects: string | undefined;
let prevDesktopRoots: string | undefined;
let prevCodexHome: string | undefined;
let prevDryRun: string | undefined;
let logs: string[];
let errs: string[];

beforeEach(() => {
  prevHome = process.env.CCCN_HOME;
  prevProjects = process.env.CCCN_CLAUDE_PROJECTS;
  prevDesktopRoots = process.env.CCCN_CLAUDE_DESKTOP_ROOTS;
  prevCodexHome = process.env.CCCN_CODEX_HOME;
  prevDryRun = process.env.CCCN_DRY_RUN;

  tmpHome = mkdtempSync(join(tmpdir(), "cccn-scan-test-"));
  cliProjects = join(tmpHome, "claude-projects");
  mkdirSync(join(cliProjects, "proj"), { recursive: true });
  copyFileSync(FIXTURE_TRANSCRIPT, join(cliProjects, "proj", "session.jsonl"));

  process.env.CCCN_HOME = tmpHome;
  process.env.CCCN_CLAUDE_PROJECTS = cliProjects;
  process.env.CCCN_CLAUDE_DESKTOP_ROOTS = join(tmpHome, "no-desktop-roots");
  process.env.CCCN_CODEX_HOME = join(tmpHome, "no-codex-home");
  process.env.CCCN_DRY_RUN = "1";

  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });

  if (prevHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = prevHome;
  if (prevProjects === undefined) delete process.env.CCCN_CLAUDE_PROJECTS;
  else process.env.CCCN_CLAUDE_PROJECTS = prevProjects;
  if (prevDesktopRoots === undefined) delete process.env.CCCN_CLAUDE_DESKTOP_ROOTS;
  else process.env.CCCN_CLAUDE_DESKTOP_ROOTS = prevDesktopRoots;
  if (prevCodexHome === undefined) delete process.env.CCCN_CODEX_HOME;
  else process.env.CCCN_CODEX_HOME = prevCodexHome;
  if (prevDryRun === undefined) delete process.env.CCCN_DRY_RUN;
  else process.env.CCCN_DRY_RUN = prevDryRun;
});

describe("runScan", () => {
  it("1. --dry-run は件数・金額をプレビューし history を変更しない", async () => {
    const code = await runScan(["--dry-run"]);
    expect(code).toBe(0);
    expect(existsSync(join(tmpHome, "history.jsonl"))).toBe(false);
    expect(logs.join("\n")).toContain("dry-run");
    expect(logs.join("\n")).toContain("取り込み");
  });

  it("2. 通常実行は history.jsonl に取り込み、再実行では増えない", async () => {
    const code1 = await runScan([]);
    expect(code1).toBe(0);
    const history1 = readFileSync(join(tmpHome, "history.jsonl"), "utf8").trim().split("\n");
    expect(history1.length).toBeGreaterThanOrEqual(1);

    const code2 = await runScan([]);
    expect(code2).toBe(0);
    const history2 = readFileSync(join(tmpHome, "history.jsonl"), "utf8").trim().split("\n");
    expect(history2.length).toBe(history1.length);
  });

  it("3. --json は構造化出力を返す", async () => {
    const code = await runScan(["--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed).toHaveProperty("records");
    expect(parsed).toHaveProperty("bySurface");
  });

  it("4. 不明なオプションはエラーで exit 1", async () => {
    const code = await runScan(["--bogus"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("不明なoption");
  });
});
