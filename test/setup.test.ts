import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit, runUninstall } from "../src/setup";

// ============ 実ホーム保護 ============
// すべてのテストで CCCN_CLAUDE_SETTINGS / CCCN_HOME / CCCN_CLI_PATH / CCCN_DRY_RUN を一時値に固定する。
// これにより「環境変数を設定し忘れた経路」から実ホーム(~/.claude や ~/.ccc-notifier)へ
// 書き込む余地を無くす。settingsPath() / paths() / resolveCliPath() は呼び出しのたびに env を評価する。

let tmpDir: string;
let settingsFile: string;
let homeDir: string;
let cliPath: string;

// 識別マーカー "ccc-notifier" を含む CLI パス(生成 command に marker が載る前提)。
function cliUnder(dir: string, name = "cli.js"): string {
  return join(dir, "node_modules", "ccc-notifier", "dist", name);
}

function fixtureRaw(): string {
  return readFileSync(new URL("./fixtures/settings-existing.json", import.meta.url), "utf8");
}

function readSettings(): Record<string, any> {
  return JSON.parse(readFileSync(settingsFile, "utf8"));
}

function backupsInTmp(): string[] {
  return readdirSync(tmpDir).filter((f) => f.startsWith("settings.json.bak-"));
}

function stopCommand(settings: Record<string, any>): string {
  return settings.hooks.Stop[0].hooks[0].command;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cccn-setup-"));
  settingsFile = join(tmpDir, "settings.json");
  homeDir = join(tmpDir, "cccn-home");
  cliPath = cliUnder(tmpDir);

  process.env.CCCN_CLAUDE_SETTINGS = settingsFile;
  process.env.CCCN_HOME = homeDir;
  process.env.CCCN_CLI_PATH = cliPath;
  process.env.CCCN_DRY_RUN = "1";
});

afterEach(() => {
  delete process.env.CCCN_CLAUDE_SETTINGS;
  delete process.env.CCCN_HOME;
  delete process.env.CCCN_CLI_PATH;
  delete process.env.CCCN_DRY_RUN;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============ 1. 既存設定の完全保持 ============

describe("runInit — 既存設定の完全保持", () => {
  it("hooks.Stop に1件だけ追加し、他の既存キーを deep-equal で不変に保つ。バックアップも一致する", async () => {
    const raw = fixtureRaw();
    writeFileSync(settingsFile, raw, "utf8");
    const before = JSON.parse(raw);

    const code = await runInit(["--yes", "--os-only"]);
    expect(code).toBe(0);

    const after = readSettings();

    // 既存トップレベルキーは1項目も変わらない。
    expect(after.permissions).toEqual(before.permissions);
    expect(after.model).toEqual(before.model);
    expect(after.statusLine).toEqual(before.statusLine);
    expect(after.effortLevel).toEqual(before.effortLevel);
    expect(after.unknownFutureKey).toEqual(before.unknownFutureKey);

    // 既存の他 hooks イベントも不変。
    expect(after.hooks.PermissionRequest).toEqual(before.hooks.PermissionRequest);
    expect(after.hooks.SessionStart).toEqual(before.hooks.SessionStart);

    // Stop に本ツールのエントリが1件だけ追加される。
    expect(Array.isArray(after.hooks.Stop)).toBe(true);
    expect(after.hooks.Stop).toHaveLength(1);
    const hook = after.hooks.Stop[0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toContain("ccc-notifier");
    expect(hook.command).toContain("track");
    expect(hook.timeout).toBe(15);

    // バックアップ .bak-* が1つ生成され、内容は元ファイルとバイト一致。
    const backups = backupsInTmp();
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(tmpDir, backups[0]), "utf8")).toBe(raw);
  });
});

// ============ 2. 冪等性 ============

describe("runInit — 冪等性", () => {
  it("2回実行してもマーカー一致エントリは1件のまま(command は最新値へ更新)", async () => {
    writeFileSync(settingsFile, fixtureRaw(), "utf8");

    await runInit(["--yes", "--os-only"]);
    expect(readSettings().hooks.Stop).toHaveLength(1);

    // 2回目は CLI パスを変える → command は更新されるが重複追加はされない。
    process.env.CCCN_CLI_PATH = cliUnder(tmpDir, "cli-v2.js");
    await runInit(["--yes", "--os-only"]);

    const after = readSettings();
    expect(after.hooks.Stop).toHaveLength(1);
    expect(stopCommand(after)).toContain("cli-v2.js");
    // 既存の他イベントは保持されている。
    expect(after.hooks.PermissionRequest).toBeDefined();
    expect(after.hooks.SessionStart).toBeDefined();
  });
});

// ============ 3. 破損 settings ============

describe("runInit — 破損 settings", () => {
  it("不正 JSON には一切書き込まず(バイト不変)、戻り値 1 を返す。バックアップも作らない", async () => {
    const broken = "{ this is not valid json ";
    writeFileSync(settingsFile, broken, "utf8");

    const code = await runInit(["--yes", "--os-only"]);

    expect(code).toBe(1);
    expect(readFileSync(settingsFile, "utf8")).toBe(broken);
    expect(backupsInTmp()).toHaveLength(0);
  });
});

// ============ 4. settings 不在 ============

describe("runInit — settings 不在", () => {
  it("新規作成し、hooks.Stop のみを持つ。バックアップは作らない", async () => {
    expect(existsSync(settingsFile)).toBe(false);

    const code = await runInit(["--yes", "--os-only"]);
    expect(code).toBe(0);

    const created = readSettings();
    expect(Object.keys(created)).toEqual(["hooks"]);
    expect(Object.keys(created.hooks)).toEqual(["Stop"]);
    expect(created.hooks.Stop).toHaveLength(1);
    expect(stopCommand(created)).toContain("ccc-notifier");

    expect(backupsInTmp()).toHaveLength(0);
  });
});

// ============ 5. config 反映 ============

describe("runInit — config.json への反映", () => {
  it("--slack-webhook / --label / --rate が config.json に反映される", async () => {
    const code = await runInit([
      "--yes",
      "--slack-webhook",
      "https://hooks.slack.com/services/XXX",
      "--label",
      "actual",
      "--rate",
      "155",
    ]);
    expect(code).toBe(0);

    const cfg = JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8"));
    expect(cfg.notify.os).toBe(true);
    expect(cfg.notify.slack.webhookUrl).toBe("https://hooks.slack.com/services/XXX");
    expect(cfg.notify.slack.promptChars).toBe(100);
    expect(cfg.notify.slack.sendFullPrompt).toBe(false);
    expect(cfg.costLabel).toBe("actual");
    expect(cfg.fx.fallbackRate).toBe(155);
  });

  it("--budget 未指定なら月予算の既定 $400 が設定される", async () => {
    const code = await runInit(["--yes", "--os-only"]);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8"));
    expect(cfg.monthlyBudgetUSD).toBe(400);
  });

  it("--budget N で月予算を上書きでき、0 で無効化できる", async () => {
    await runInit(["--yes", "--os-only", "--budget", "1000"]);
    expect(JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8")).monthlyBudgetUSD).toBe(1000);

    await runInit(["--yes", "--os-only", "--budget", "0"]);
    expect(JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8")).monthlyBudgetUSD).toBe(0);
  });

  it("既存の月予算は --budget 未指定の再 init でも維持される", async () => {
    await runInit(["--yes", "--os-only", "--budget", "750"]);
    await runInit(["--yes", "--os-only"]); // --budget 無し
    expect(JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8")).monthlyBudgetUSD).toBe(750);
  });

  it("--budget が負値ならエラー(exit 1)", async () => {
    const code = await runInit(["--yes", "--os-only", "--budget", "-5"]);
    expect(code).toBe(1);
  });

  it("--slack-only --slack-webhook で OS 通知を無効化し Slack のみにする", async () => {
    const code = await runInit([
      "--yes",
      "--slack-only",
      "--slack-webhook",
      "https://hooks.slack.com/services/XXX",
    ]);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8"));
    expect(cfg.notify.os).toBe(false);
    expect(cfg.notify.slack.webhookUrl).toBe("https://hooks.slack.com/services/XXX");
  });

  it("--slack-only を webhook 無しで指定するとエラー(exit 1)", async () => {
    expect(await runInit(["--yes", "--slack-only"])).toBe(1);
  });

  it("--slack-only と --os-only の同時指定はエラー(exit 1)", async () => {
    expect(
      await runInit(["--yes", "--slack-only", "--os-only", "--slack-webhook", "https://hooks.slack.com/services/XXX"]),
    ).toBe(1);
  });
});

// ============ 6. uninstall ============

describe("runUninstall — 我々のエントリのみ除去", () => {
  it("本ツールの Stop エントリのみ消し、既存 hooks は不変。Stop が空になれば Stop キーを削除", async () => {
    const raw = fixtureRaw();
    writeFileSync(settingsFile, raw, "utf8");
    const before = JSON.parse(raw);

    await runInit(["--yes", "--os-only"]);
    expect(readSettings().hooks.Stop).toHaveLength(1);

    const code = await runUninstall([]);
    expect(code).toBe(0);

    const after = readSettings();
    // Stop は空になったのでキーごと削除される。
    expect("Stop" in after.hooks).toBe(false);
    // 既存 hooks / その他キーは完全に元通り。
    expect(after.hooks.PermissionRequest).toEqual(before.hooks.PermissionRequest);
    expect(after.hooks.SessionStart).toEqual(before.hooks.SessionStart);
    expect(after.permissions).toEqual(before.permissions);
    expect(after.statusLine).toEqual(before.statusLine);
    expect(after.unknownFutureKey).toEqual(before.unknownFutureKey);
  });

  it("既存の他 Stop エントリがある場合、それは残して我々のものだけ除去する", async () => {
    const settings = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "bash /some/other/hook.sh", timeout: 5 }] },
        ],
      },
    };
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf8");

    await runInit(["--yes", "--os-only"]);
    expect(readSettings().hooks.Stop).toHaveLength(2);

    await runUninstall([]);
    const after = readSettings();
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0].hooks[0].command).toBe("bash /some/other/hook.sh");
  });

  it("マーカー未登録なら「登録なし」で settings を変更しない", async () => {
    const raw = fixtureRaw();
    writeFileSync(settingsFile, raw, "utf8");

    const code = await runUninstall([]);
    expect(code).toBe(0);
    // 変更なし(Stop キーは元々存在しない)。
    expect("Stop" in readSettings().hooks).toBe(false);
    expect(backupsInTmp()).toHaveLength(0);
  });
});

// ============ 7. --purge ============

describe("runUninstall — --purge", () => {
  it("--yes 併用で CCCN_HOME を削除する", async () => {
    writeFileSync(settingsFile, fixtureRaw(), "utf8");
    await runInit(["--yes", "--os-only"]);
    expect(existsSync(homeDir)).toBe(true);

    const code = await runUninstall(["--purge", "--yes"]);
    expect(code).toBe(0);
    expect(existsSync(homeDir)).toBe(false);
  });
});

// ============ 8. win32 ============

describe("runInit — win32 のパス正規化", () => {
  it("command のパスが '/' 区切り + ダブルクォートになり、バックスラッシュを含まない", async () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const winCli = "C:\\Users\\me\\node_modules\\ccc-notifier\\dist\\cli.js";
      process.env.CCCN_CLI_PATH = winCli;

      const code = await runInit(["--yes", "--os-only"]);
      expect(code).toBe(0);

      const command = stopCommand(readSettings());
      expect(command).toContain('"C:/Users/me/node_modules/ccc-notifier/dist/cli.js"');
      expect(command).not.toContain("\\");
      expect(command.startsWith('"')).toBe(true);
      expect(command.endsWith("track")).toBe(true);
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });
});

// ============ 9. テスト通知 ============

describe("runInit — テスト通知", () => {
  it("init --yes 後、last-notify.json に os キーが書かれている", async () => {
    const code = await runInit(["--yes", "--os-only"]);
    expect(code).toBe(0);

    const lastNotify = JSON.parse(readFileSync(join(homeDir, "last-notify.json"), "utf8"));
    expect(lastNotify.os).toBeDefined();
    expect(typeof lastNotify.os.title).toBe("string");
    expect(lastNotify.os.title).toContain("💰");
    expect(typeof lastNotify.os.body).toBe("string");
  });

  it("Slack 設定時は init のテスト通知に slack も含まれる", async () => {
    const code = await runInit([
      "--yes",
      "--slack-webhook",
      "https://hooks.slack.com/services/XXX",
    ]);
    expect(code).toBe(0);

    const lastNotify = JSON.parse(readFileSync(join(homeDir, "last-notify.json"), "utf8"));
    expect(lastNotify.os).toBeDefined(); // OS も併用
    expect(lastNotify.slack).toBeDefined();
    expect(lastNotify.slack.payload.blocks).toHaveLength(3);
  });

  it("--slack-only なら init のテスト通知は slack のみ(os は書かれない)", async () => {
    const code = await runInit([
      "--yes",
      "--slack-only",
      "--slack-webhook",
      "https://hooks.slack.com/services/XXX",
    ]);
    expect(code).toBe(0);

    const lastNotify = JSON.parse(readFileSync(join(homeDir, "last-notify.json"), "utf8"));
    expect(lastNotify.slack).toBeDefined();
    expect(lastNotify.os).toBeUndefined(); // OS 無効なので notifyOS は書かない
  });
});
