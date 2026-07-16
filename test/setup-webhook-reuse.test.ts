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

import { maskWebhookUrl, runInit } from "../src/setup";

const OLD_WEBHOOK = "https://hooks.slack.com/services/T0123456/B0123456/oldsecretoldsecret";
const NEW_WEBHOOK = "https://hooks.slack.com/services/T0123456/B0123456/newsecretnewsecret";

let tmpDir: string;
let homeDir: string;

function config(): Record<string, any> {
  return JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8"));
}

/** 既存の Slack 設定(手動カスタマイズ込み)を作る。 */
async function seedSlackConfig(): Promise<void> {
  expect(await runInit(["--yes", "--slack-webhook", OLD_WEBHOOK])).toBe(0);
  const cfgPath = join(homeDir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.notify.slack.promptChars = 77;
  cfg.notify.slack.sendFullPrompt = true;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  vi.clearAllMocks();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cccn-setup-webhook-reuse-"));
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

describe("runInit — 既存 Slack Webhook URL の再利用", () => {
  it("既存URLありでYesなら入力を求めず、URLとカスタマイズ値を維持する", async () => {
    await seedSlackConfig();
    prompts.select.mockResolvedValueOnce("both").mockResolvedValueOnce("api_equivalent");
    prompts.confirm.mockResolvedValueOnce(true); // 再利用する
    prompts.text.mockResolvedValueOnce("").mockResolvedValueOnce(""); // rate / budget

    expect(await runInit(["--no-codex"])).toBe(0);

    const slack = config().notify.slack;
    expect(slack.webhookUrl).toBe(OLD_WEBHOOK);
    expect(slack.promptChars).toBe(77);
    expect(slack.sendFullPrompt).toBe(true);
    // webhook の text 入力は発生しない(rate と budget の2回のみ)
    expect(prompts.text).toHaveBeenCalledTimes(2);
    // 確認メッセージには伏せ字のURLを表示する(生のシークレットを出さない)
    expect(prompts.confirm).toHaveBeenCalledTimes(1);
    const message: string = prompts.confirm.mock.calls[0][0].message;
    expect(message).toContain(maskWebhookUrl(OLD_WEBHOOK));
    expect(message).not.toContain(OLD_WEBHOOK);
  });

  it("既存URLありでNoなら新しいURLを入力して上書きする", async () => {
    await seedSlackConfig();
    prompts.select.mockResolvedValueOnce("both").mockResolvedValueOnce("api_equivalent");
    prompts.confirm.mockResolvedValueOnce(false); // 入力し直す
    prompts.text
      .mockResolvedValueOnce(NEW_WEBHOOK)
      .mockResolvedValueOnce("") // rate
      .mockResolvedValueOnce(""); // budget

    expect(await runInit(["--no-codex"])).toBe(0);

    expect(config().notify.slack.webhookUrl).toBe(NEW_WEBHOOK);
  });

  it("既存URLがなければ確認せずURL入力を求める", async () => {
    prompts.select.mockResolvedValueOnce("slack").mockResolvedValueOnce("api_equivalent");
    prompts.text
      .mockResolvedValueOnce(NEW_WEBHOOK)
      .mockResolvedValueOnce("") // rate
      .mockResolvedValueOnce(""); // budget

    expect(await runInit(["--no-codex"])).toBe(0);

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(config().notify.slack.webhookUrl).toBe(NEW_WEBHOOK);
  });
});

describe("maskWebhookUrl", () => {
  it("長いURLは先頭34文字と末尾4文字だけ残す", () => {
    expect(maskWebhookUrl(OLD_WEBHOOK)).toBe("https://hooks.slack.com/services/T…cret");
  });

  it("40文字以下のURLはそのまま返す", () => {
    expect(maskWebhookUrl("https://example.com/hook")).toBe("https://example.com/hook");
  });
});
