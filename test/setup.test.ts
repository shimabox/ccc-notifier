import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? join(prefix, entry.name) : entry.name;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = "directory";
        walk(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        snapshot[relative] = "symlink";
      } else {
        snapshot[relative] = readFileSync(absolute, "utf8");
      }
    }
  };
  walk(root, "");
  return snapshot;
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
  // uninstall(removeCodexHook)が実 ~/.codex/hooks.json に触れないよう隔離(2026-07-10)。
  // 存在しないパスに固定する(Codex 系テストは自前 beforeEach の一時 dir で上書きする)。
  process.env.CCCN_CODEX_HOME = join(tmpDir, "no-codex");
});

afterEach(() => {
  delete process.env.CCCN_CLAUDE_SETTINGS;
  delete process.env.CCCN_HOME;
  delete process.env.CCCN_CLI_PATH;
  delete process.env.CCCN_DRY_RUN;
  delete process.env.CCCN_CODEX_HOME;
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

// ============ 10. 通知なしモード(--no-notify) ============

describe("runInit — 通知なしモード(--no-notify)", () => {
  it("--yes --no-notify で notify.os=false / slack=null になり、hook は登録され、テスト通知は送られない", async () => {
    const code = await runInit(["--yes", "--no-notify"]);
    expect(code).toBe(0);

    const cfg = JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8"));
    expect(cfg.notify.os).toBe(false);
    expect(cfg.notify.slack).toBeNull();

    // 通知なしでも Stop フックは登録される(記録・ダッシュボードの供給源)。
    const settings = readSettings();
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(stopCommand(settings)).toContain("ccc-notifier");

    // CCCN_DRY_RUN=1 でもテスト通知自体をスキップするため last-notify.json は書かれない。
    expect(existsSync(join(homeDir, "last-notify.json"))).toBe(false);
  });

  it("--no-notify とチャネル系フラグの併用はエラー(exit 1)で、config も settings も書かれない", async () => {
    expect(await runInit(["--yes", "--no-notify", "--os-only"])).toBe(1);
    expect(
      await runInit([
        "--yes",
        "--no-notify",
        "--slack-only",
        "--slack-webhook",
        "https://hooks.slack.com/services/XXX",
      ]),
    ).toBe(1);
    expect(
      await runInit(["--yes", "--no-notify", "--slack-webhook", "https://hooks.slack.com/services/XXX"]),
    ).toBe(1);

    expect(existsSync(join(homeDir, "config.json"))).toBe(false);
    expect(existsSync(settingsFile)).toBe(false);
  });

  it("--no-notify でも --label / --budget は反映される", async () => {
    const code = await runInit(["--yes", "--no-notify", "--label", "actual", "--budget", "123"]);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8"));
    expect(cfg.costLabel).toBe("actual");
    expect(cfg.monthlyBudgetUSD).toBe(123);
  });

  it("--no-notify の後に素の --yes で再 init すると OS 通知が再有効化される(既存の流儀)", async () => {
    await runInit(["--yes", "--no-notify"]);
    await runInit(["--yes"]);
    const cfg = JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8"));
    expect(cfg.notify.os).toBe(true);
    expect(cfg.notify.slack).toBeNull();
  });
});

// ============ 11. Codex 対応 ============
// 上位 beforeEach が CCCN_CLAUDE_SETTINGS / CCCN_HOME / CCCN_CLI_PATH / CCCN_DRY_RUN を張る。
// ここでは CCCN_CODEX_HOME を tmpDir 配下の一時ディレクトリへ固定し、実ホーム(~/.codex/hooks.json)へ
// 触れないようにする(未設定だと codexHome() が実ホームを見てしまうため必ず張る)。

/** console.log / console.error を捕捉し、戻り値と各出力(改行連結)を返す(setup.ts の完了メッセージ検証用)。 */
async function captureIO(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  const outLines: string[] = [];
  const errLines: string[] = [];
  console.log = (...args: unknown[]) => {
    outLines.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errLines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await fn();
    return { code, out: outLines.join("\n"), err: errLines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("runInit / runUninstall — Codex 対応", () => {
  let codexHome: string;
  let codexHooks: string;

  // PermissionRequest を持つユーザー実ファイル(codex-setup.test.ts と同形・minify)。
  const PERMISSION_RAW =
    '{"hooks":{"PermissionRequest":[{"hooks":[{"type":"command","command":"\'/home/user/.codex/hooks/notify-permission.sh\'"}]}]}}';

  function readCodexHooks(): Record<string, any> {
    return JSON.parse(readFileSync(codexHooks, "utf8"));
  }
  function codexBackups(): string[] {
    return readdirSync(codexHome).filter((f) => f.startsWith("hooks.json.bak-"));
  }

  beforeEach(() => {
    // tmpDir 配下に作るので上位 afterEach の rmSync(tmpDir) で一緒に消える。
    codexHome = mkdtempSync(join(tmpDir, "codex-"));
    codexHooks = join(codexHome, "hooks.json");
    process.env.CCCN_CODEX_HOME = codexHome;
  });

  afterEach(() => {
    delete process.env.CCCN_CODEX_HOME;
  });

  it("--codex --no-codex の併用は exit 1(config も settings も hooks.json も書かれない)", async () => {
    const { code } = await captureIO(() => runInit(["--yes", "--codex", "--no-codex"]));
    expect(code).toBe(1);
    expect(existsSync(codexHooks)).toBe(false);
    expect(existsSync(join(homeDir, "config.json"))).toBe(false);
    expect(existsSync(settingsFile)).toBe(false);
  });

  it("--yes --codex で hooks.json を作成し、4イベントの専用commandと信頼案内を出す", async () => {
    const { code, out } = await captureIO(() => runInit(["--yes", "--codex"]));
    expect(code).toBe(0);
    expect(existsSync(codexHooks)).toBe(true);

    const hook = readCodexHooks().hooks.Stop[0].hooks[0];
    expect(hook.command).toContain("ccc-notifier");
    expect(hook.command).toContain("__ccc-notifier-codex-hook Stop");
    expect(hook.timeout).toBe(20);
    expect(readCodexHooks().hooks.SubagentStart).toHaveLength(1);
    expect(readCodexHooks().hooks.SubagentStop).toHaveLength(1);
    expect(readCodexHooks().hooks.UserPromptSubmit).toHaveLength(1);

    // 完了メッセージに登録の旨と信頼確認の案内が stdout に出る。
    expect(out).toContain("Codex に Stop/UserPromptSubmit/SubagentStart/SubagentStop hook を登録しました");
    expect(out).toContain("Trust all and continue");
  });

  it("既存 config の素の --yes --codex は Codex hook だけを移行し、他ファイルと通知をバイト不変に保つ", async () => {
    mkdirSync(homeDir, { recursive: true });
    const configRaw = `{
  "notify": { "os": false, "slack": { "webhookUrl": "https://hooks.slack.com/services/XXX", "promptChars": 77, "sendFullPrompt": true } },
  "minNotifyUSD": 1.25,
  "costLabel": "actual",
  "fx": { "fallbackRate": 177, "cacheHours": 3 },
  "includeDailyTotal": false,
  "monthlyBudgetUSD": 0,
  "dashboard": { "autoRegenerate": false, "autoReloadSec": 9, "days": 14 },
  "unknownFutureKey": { "preserve": true }
}`;
    const settingsRaw = fixtureRaw();
    const lastNotifyRaw = '{"sentinel":"do-not-touch"}\n';
    const legacyCommand = `"${process.execPath}" "${cliPath}" track --codex`;
    const codexRaw = JSON.stringify({
      futureTopLevel: { preserve: true },
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: legacyCommand, timeout: 15 }] }],
        PermissionRequest: [{ hooks: [{ type: "command", command: "/other/tool" }] }],
      },
    });
    writeFileSync(join(homeDir, "config.json"), configRaw, "utf8");
    writeFileSync(settingsFile, settingsRaw, "utf8");
    writeFileSync(join(homeDir, "last-notify.json"), lastNotifyRaw, "utf8");
    mkdirSync(join(homeDir, "cache"), { recursive: true });
    writeFileSync(join(homeDir, "cache", "pricing.json"), '{"sentinel":"cache"}', "utf8");
    writeFileSync(join(homeDir, "history.jsonl"), '{"sentinel":"history"}\n', "utf8");
    writeFileSync(join(homeDir, "cursors.json"), '{"sentinel":"cursor"}', "utf8");
    writeFileSync(join(homeDir, "report.html"), "<p>recent</p>", "utf8");
    writeFileSync(join(homeDir, "report-all.html"), "<p>all</p>", "utf8");
    writeFileSync(join(homeDir, "muted.json"), '{"until":null}', "utf8");
    writeFileSync(join(homeDir, "codex-subagent-activity.json"), '{"schemaVersion":1,"agents":{}}\n', "utf8");
    writeFileSync(codexHooks, codexRaw, "utf8");
    const homeTreeBefore = snapshotTree(homeDir);

    const { code, out } = await captureIO(() => runInit(["--yes", "--codex"]));

    expect(code).toBe(0);
    expect(snapshotTree(homeDir)).toEqual(homeTreeBefore);
    expect(readFileSync(join(homeDir, "config.json"), "utf8")).toBe(configRaw);
    expect(readFileSync(settingsFile, "utf8")).toBe(settingsRaw);
    expect(readFileSync(join(homeDir, "last-notify.json"), "utf8")).toBe(lastNotifyRaw);
    expect(backupsInTmp()).toHaveLength(0);
    expect(readdirSync(homeDir).filter((name) => name.startsWith("config.json.bak-"))).toHaveLength(0);
    expect(codexBackups()).toHaveLength(1);
    expect(readFileSync(join(codexHome, codexBackups()[0]), "utf8")).toBe(codexRaw);

    const migrated = readCodexHooks();
    expect(migrated.futureTopLevel).toEqual({ preserve: true });
    expect(migrated.hooks.PermissionRequest).toEqual(JSON.parse(codexRaw).hooks.PermissionRequest);
    expect(migrated.hooks.Stop[0].matcher).toBe("");
    expect(migrated.hooks.Stop[0].hooks[0].command).toContain("__ccc-notifier-codex-hook Stop");
    expect(migrated.hooks.SubagentStart).toHaveLength(1);
    expect(migrated.hooks.SubagentStop).toHaveLength(1);
    expect(migrated.hooks.UserPromptSubmit).toHaveLength(1);
    expect(out).toContain("Codex hook のみを確認・更新しました");
    expect(out).toContain("テスト通知も送信していません");
    expect(out).toContain("Codex を再起動");
    expect(out).not.toContain("settings を更新しました");
  });

  it("既存 config が不正 JSON でも読み込まず、Codex hook 限定移行を行う", async () => {
    mkdirSync(homeDir, { recursive: true });
    const brokenConfig = "{ broken config";
    writeFileSync(join(homeDir, "config.json"), brokenConfig, "utf8");
    const absentClaudeDir = join(tmpDir, "absent-claude-home");
    process.env.CCCN_CLAUDE_SETTINGS = join(absentClaudeDir, "settings.json");

    const { code, out } = await captureIO(() => runInit(["-y", "--codex"]));

    expect(code).toBe(0);
    expect(readFileSync(join(homeDir, "config.json"), "utf8")).toBe(brokenConfig);
    expect(existsSync(join(homeDir, "error.log"))).toBe(false);
    expect(existsSync(join(homeDir, "cache"))).toBe(false);
    expect(existsSync(absentClaudeDir)).toBe(false);
    expect(readCodexHooks().hooks.SubagentStop).toHaveLength(1);
    expect(out).toContain("Codex hook のみを確認・更新しました");
  });

  it("既存 config でも設定変更フラグ付き --codex は通常 init として明示設定を反映する", async () => {
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, "config.json"),
      JSON.stringify({ notify: { os: true, slack: null }, monthlyBudgetUSD: 0 }),
      "utf8",
    );

    const { code, out } = await captureIO(() =>
      runInit(["--yes", "--codex", "--budget", "500"]),
    );

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8")).monthlyBudgetUSD).toBe(500);
    expect(existsSync(settingsFile)).toBe(true);
    expect(existsSync(join(homeDir, "last-notify.json"))).toBe(true);
    expect(out).toContain("settings を更新しました");
    expect(out).not.toContain("Codex hook のみを確認・更新しました");
  });

  it("値欠落フラグや未知フラグを含む argv は Codex hook 限定移行に入らない", async () => {
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, "config.json"),
      JSON.stringify({ notify: { os: false, slack: null }, monthlyBudgetUSD: 0 }),
      "utf8",
    );

    const missingValue = await captureIO(() => runInit(["--yes", "--codex", "--budget"]));
    expect(missingValue.code).toBe(0);
    expect(missingValue.out).toContain("settings を更新しました");
    expect(missingValue.out).not.toContain("Codex hook のみを確認・更新しました");

    const unknown = await captureIO(() => runInit(["--yes", "--codex", "--unknown"]));
    expect(unknown.code).toBe(0);
    expect(unknown.out).toContain("settings を更新しました");
    expect(unknown.out).not.toContain("Codex hook のみを確認・更新しました");
  });

  it("dangling symlink の config path entry も既存扱いにして限定移行し、symlink を保持する", async () => {
    mkdirSync(homeDir, { recursive: true });
    const configPath = join(homeDir, "config.json");
    symlinkSync(join(homeDir, "missing-target.json"), configPath);

    const { code, out } = await captureIO(() => runInit(["--yes", "--codex"]));

    expect(code).toBe(0);
    expect(out).toContain("Codex hook のみを確認・更新しました");
    expect(existsSync(configPath)).toBe(false); // target は依然として不在
    expect(existsSync(settingsFile)).toBe(false);
    expect(readCodexHooks().hooks.SubagentStart).toHaveLength(1);
  });

  it("config path entry を ENOENT 以外で判定できない場合は全変更を中止して exit 1", async () => {
    symlinkSync(homeDir, homeDir); // config.json の lstat が ELOOP になる自己参照symlink

    const { code, err } = await captureIO(() => runInit(["--yes", "--codex"]));

    expect(code).toBe(1);
    expect(err).toContain("config.json の存在を安全に確認できませんでした");
    expect(err).toContain("すべての変更を中止しました");
    expect(existsSync(codexHooks)).toBe(false);
    expect(existsSync(settingsFile)).toBe(false);
  });

  it("--yes のみ(--codex 未指定)は Codex に一切触れず hooks.json を作らない", async () => {
    const { code } = await captureIO(() => runInit(["--yes", "--os-only"]));
    expect(code).toBe(0);
    expect(existsSync(codexHooks)).toBe(false);
    expect(codexBackups()).toHaveLength(0);
  });

  it("--no-codex は Codex に触れない(hooks.json を作らない)", async () => {
    const { code } = await captureIO(() => runInit(["--yes", "--no-codex"]));
    expect(code).toBe(0);
    expect(existsSync(codexHooks)).toBe(false);
  });

  it("--yes --codex を2回実行すると2回目は『登録済み』でバックアップは増えない", async () => {
    await captureIO(() => runInit(["--yes", "--codex"]));
    expect(existsSync(codexHooks)).toBe(true);
    expect(codexBackups()).toHaveLength(0); // 新規作成はバックアップ無し

    const { code, out } = await captureIO(() => runInit(["--yes", "--codex"]));
    expect(code).toBe(0);
    expect(out).toContain("Codex の Stop/UserPromptSubmit/SubagentStart/SubagentStop hook は登録済みです");
    // unchanged は書き込まないためバックアップは増えず、エントリも1件のまま。
    expect(codexBackups()).toHaveLength(0);
    expect(readCodexHooks().hooks.Stop).toHaveLength(1);
  });

  it("uninstall は Codex の Stop エントリを除去し、PermissionRequest を保持してメッセージを出す", async () => {
    // ユーザーの既存 hooks.json(PermissionRequest 入り)に登録してから uninstall する。
    writeFileSync(codexHooks, PERMISSION_RAW, "utf8");
    const before = JSON.parse(PERMISSION_RAW);

    await captureIO(() => runInit(["--yes", "--codex"]));
    expect(readCodexHooks().hooks.Stop).toHaveLength(1);

    const { code, out } = await captureIO(() => runUninstall([]));
    expect(code).toBe(0);
    expect(out).toContain("Codex の Stop/UserPromptSubmit/SubagentStart/SubagentStop hook を削除しました");

    const after = readCodexHooks();
    // Stop は空になりキーごと消え、PermissionRequest は1項目も変わらない。
    expect("Stop" in after.hooks).toBe(false);
    expect(after.hooks.PermissionRequest).toEqual(before.hooks.PermissionRequest);
  });

  it("Codex 未登録での uninstall は Codex 関連メッセージを一切出さない", async () => {
    // hooks.json が無い(未登録)状態での uninstall。
    const { code, out } = await captureIO(() => runUninstall([]));
    expect(code).toBe(0);
    expect(out).not.toContain("Codex の Stop/UserPromptSubmit/SubagentStart/SubagentStop hook を削除しました");
    expect(existsSync(codexHooks)).toBe(false);
  });

  it("壊れた hooks.json の限定移行は manual 案内を出し、ファイル不変で exit 1", async () => {
    const broken = "{ this is not valid json ";
    mkdirSync(homeDir, { recursive: true });
    const configRaw = '{"sentinel":"preserve"}';
    writeFileSync(join(homeDir, "config.json"), configRaw, "utf8");
    writeFileSync(codexHooks, broken, "utf8");

    const { code, err } = await captureIO(() => runInit(["--yes", "--codex"]));
    expect(code).toBe(1);
    // ファイルは1バイトも変わらず、バックアップも作らない。
    expect(readFileSync(codexHooks, "utf8")).toBe(broken);
    expect(codexBackups()).toHaveLength(0);
    expect(readFileSync(join(homeDir, "config.json"), "utf8")).toBe(configRaw);
    expect(existsSync(settingsFile)).toBe(false);
    expect(existsSync(join(homeDir, "last-notify.json"))).toBe(false);
    // 手動追記スニペット(4イベントを含む)が stderr に案内される。
    expect(err).toContain("4イベント");
    expect(err).toContain("__ccc-notifier-codex-hook SubagentStop");
    expect(err).toContain("限定移行を完了できませんでした");
  });

  it("config 不在の通常 init は壊れた Codex hooks を副次エラーとして扱い exit 0 を維持する", async () => {
    const broken = "{ this is not valid json ";
    writeFileSync(codexHooks, broken, "utf8");

    const { code, err } = await captureIO(() => runInit(["--yes", "--codex"]));

    expect(code).toBe(0);
    expect(readFileSync(codexHooks, "utf8")).toBe(broken);
    expect(err).toContain("4イベント");
    expect(existsSync(join(homeDir, "config.json"))).toBe(true);
    expect(existsSync(settingsFile)).toBe(true);
  });
});
