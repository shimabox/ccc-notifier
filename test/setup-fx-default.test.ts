import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prompts = vi.hoisted(() => ({
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  ...prompts,
  isCancel: () => false,
}));

import { runInit } from "../src/setup";

let tmpDir: string;
let homeDir: string;

function config(): Record<string, any> {
  return JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8"));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cccn-setup-fx-default-"));
  homeDir = join(tmpDir, "home");
  process.env.CCCN_HOME = homeDir;
  process.env.CCCN_CLAUDE_SETTINGS = join(tmpDir, "settings.json");
  process.env.CCCN_CODEX_HOME = join(tmpDir, "codex");
  process.env.CCCN_CLI_PATH = join(tmpDir, "node_modules", "ccc-notifier", "dist", "cli.js");
  process.env.CCCN_DRY_RUN = "1";
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.CCCN_HOME;
  delete process.env.CCCN_CLAUDE_SETTINGS;
  delete process.env.CCCN_CODEX_HOME;
  delete process.env.CCCN_CLI_PATH;
  delete process.env.CCCN_DRY_RUN;
  vi.unstubAllGlobals();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runInit — フォールバック為替レートの既定値", () => {
  it("初回の非対話initで--rate未指定なら160円を保存する", async () => {
    expect(await runInit(["--yes", "--os-only"])).toBe(0);

    expect(config().fx.fallbackRate).toBe(160);
  });

  it("既存fallbackRateは--rate未指定の再initでも維持する", async () => {
    expect(await runInit(["--yes", "--os-only", "--rate", "177"])).toBe(0);
    expect(await runInit(["--yes", "--os-only"])).toBe(0);

    expect(config().fx.fallbackRate).toBe(177);
  });

  it("初回の対話initで為替レートを空欄にすると160円を保存する", async () => {
    prompts.select
      .mockResolvedValueOnce("os")
      .mockResolvedValueOnce("api_equivalent");
    prompts.text
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("400");

    expect(await runInit(["--no-codex"])).toBe(0);

    expect(config().fx.fallbackRate).toBe(160);
  });
});
