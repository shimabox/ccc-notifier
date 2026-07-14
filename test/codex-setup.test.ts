import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  codexHookCommand,
  codexHooksFile,
  registerCodexHook,
  removeCodexHook,
} from "../src/codex/setup";
import { codexHome, detectCodex } from "../src/codex/env";

// ============ 実ホーム保護 ============
// CCCN_CODEX_HOME を mkdtempSync の一時ディレクトリに固定し、実ホーム(~/.codex/hooks.json)へ
// 書き込む余地を無くす。codexHome() / codexHooksFile() は呼び出しのたびに env を評価する。

let tmpDir: string;
let hooksFile: string;

// 識別マーカー "ccc-notifier" を含む CLI パス(生成 command に marker が載る前提)。
const NODE = "/usr/local/bin/node";
const CLI = "/opt/ccc-notifier/dist/cli.js";
// 「古いパス」の marker 付きコマンド(置換テスト用)。marker は含むが CLI と異なる。
const OLD_CLI = "/old/ccc-notifier/dist/cli.js";

// PermissionRequest を持つユーザー実ファイル(タスク指定と同形・minify)。
const PERMISSION_RAW =
  '{"hooks":{"PermissionRequest":[{"hooks":[{"type":"command","command":"\'/home/user/.codex/hooks/notify-permission.sh\'"}]}]}}';
const PERMISSION_INNER_CMD = "'/home/user/.codex/hooks/notify-permission.sh'";

function readHooks(): Record<string, any> {
  return JSON.parse(readFileSync(hooksFile, "utf8"));
}

function backups(): string[] {
  return readdirSync(tmpDir).filter((f) => f.startsWith("hooks.json.bak-"));
}

/** その entry が本ツール(marker）のものか(command に "ccc-notifier" を含む hook を持つか)。 */
function isOurs(entry: any): boolean {
  return (
    entry &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes("ccc-notifier"))
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cccn-codex-"));
  hooksFile = join(tmpDir, "hooks.json");
  process.env.CCCN_CODEX_HOME = tmpDir;
});

afterEach(() => {
  delete process.env.CCCN_CODEX_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============ 1. hooks.json 無し ============

describe("registerCodexHook — hooks.json 不在", () => {
  it("新規作成し、4イベントに1件ずつ持つ。backupPath は null・バックアップも作らない", () => {
    expect(existsSync(hooksFile)).toBe(false);

    const res = registerCodexHook(NODE, CLI);
    expect(res.status).toBe("written");
    expect(res.backupPath).toBeNull();

    const h = readHooks();
    expect(Object.keys(h)).toEqual(["hooks"]);
    expect(Object.keys(h.hooks)).toEqual(["Stop", "UserPromptSubmit", "SubagentStart", "SubagentStop"]);
    expect(h.hooks.Stop).toHaveLength(1);
    expect(h.hooks.UserPromptSubmit).toHaveLength(1);

    const hook = h.hooks.Stop[0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toContain("ccc-notifier");
    expect(hook.command).toContain("__ccc-notifier-codex-hook Stop");
    expect(hook.timeout).toBe(20);
    expect(h.hooks.SubagentStart[0].hooks[0].command).toContain("__ccc-notifier-codex-hook SubagentStart");
    expect(h.hooks.SubagentStop[0].hooks[0].command).toContain("__ccc-notifier-codex-hook SubagentStop");

    // 末尾改行付き・2スペースインデント。
    const text = readFileSync(hooksFile, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "hooks"');

    expect(backups()).toHaveLength(0);
  });
});

// ============ 2. 既存 PermissionRequest の完全保持 ============

describe("registerCodexHook — 既存 PermissionRequest を壊さない", () => {
  it("PermissionRequest を不変に保ち、Stop を追加し、バックアップを生成する", () => {
    writeFileSync(hooksFile, PERMISSION_RAW, "utf8");
    const before = JSON.parse(PERMISSION_RAW);

    const res = registerCodexHook(NODE, CLI);
    expect(res.status).toBe("written");
    expect(res.backupPath).not.toBeNull();

    const after = readHooks();
    // PermissionRequest は値として1項目も変わらない。
    expect(after.hooks.PermissionRequest).toEqual(before.hooks.PermissionRequest);
    // 承認フックの command 文字列は(シングルクォート込みで)バイト列として温存されている。
    expect(readFileSync(hooksFile, "utf8")).toContain(PERMISSION_INNER_CMD);

    // Stop に本ツールのエントリが1件だけ足される。
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0].hooks[0].command).toContain("__ccc-notifier-codex-hook Stop");

    // バックアップは元ファイルとバイト一致・1つだけ。
    const b = backups();
    expect(b).toHaveLength(1);
    expect(readFileSync(join(tmpDir, b[0]), "utf8")).toBe(PERMISSION_RAW);
    expect(res.backupPath).toBe(join(tmpDir, b[0]));
  });
});

// ============ 3. 冪等性(同一コマンドの再登録) ============

describe("registerCodexHook — 冪等", () => {
  it("同一コマンドで再登録すると unchanged・ファイルもバックアップも不変", () => {
    registerCodexHook(NODE, CLI); // 新規作成(バックアップなし)
    const contentAfterFirst = readFileSync(hooksFile, "utf8");
    const mtimeAfterFirst = statSync(hooksFile).mtimeMs;

    const res = registerCodexHook(NODE, CLI);
    expect(res.status).toBe("unchanged");
    expect(res.backupPath).toBeNull();

    // 書き込みが起きていない(内容・mtime 不変、バックアップ 0)。
    expect(readFileSync(hooksFile, "utf8")).toBe(contentAfterFirst);
    expect(statSync(hooksFile).mtimeMs).toBe(mtimeAfterFirst);
    expect(backups()).toHaveLength(0);
  });

  it("既存の正準3イベントへUserPromptSubmitだけを追加し、元rawのbackupを1つ作る", () => {
    const hooks = Object.fromEntries(["Stop", "SubagentStart", "SubagentStop"].map((event) => [
      event,
      [{ hooks: [{ type: "command", command: codexHookCommand(NODE, CLI, event as "Stop" | "SubagentStart" | "SubagentStop"), timeout: 20 }] }],
    ]));
    const raw = JSON.stringify({ future: { keep: true }, hooks });
    writeFileSync(hooksFile, raw, "utf8");

    const result = registerCodexHook(NODE, CLI);
    expect(result.status).toBe("written");
    expect(readHooks().future).toEqual({ keep: true });
    expect(readHooks().hooks.UserPromptSubmit[0].hooks[0].command)
      .toBe(codexHookCommand(NODE, CLI, "UserPromptSubmit"));
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(tmpDir, backups()[0]), "utf8")).toBe(raw);
  });
});

// ============ 4. 古いマーカーエントリの置換 ============

describe("registerCodexHook — 古いコマンドの置換", () => {
  it("任意X/Yが専用subcommandを模倣してもowned扱いせずregister/uninstallで不変", () => {
    const impostor = {
      futureGroupKey: { keep: true },
      hooks: [{ type: "command", command: '"/tmp/X" "/tmp/Y" __ccc-notifier-codex-hook Stop', timeout: 20 }],
    };
    writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [impostor] } }));
    registerCodexHook(NODE, CLI);
    expect(readHooks().hooks.Stop[0]).toEqual(impostor);
    removeCodexHook();
    expect(readHooks().hooks.Stop).toEqual([impostor]);
  });

  it("絶対pathでも正規ccc-notifier dist実体でない模倣commandをowned扱いしない", () => {
    const impostor = { hooks: [{
      type: "command",
      command: '"/tmp/node" "/tmp/ccc-notifier-fake/cli.js" __ccc-notifier-codex-hook Stop',
      timeout: 20,
    }] };
    writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [impostor] } }));
    registerCodexHook(NODE, CLI);
    expect(readHooks().hooks.Stop[0]).toEqual(impostor);
    removeCodexHook();
    expect(readHooks().hooks.Stop[0]).toEqual(impostor);
  });

  it("既存non-owned empty groupと未知キーをregister/uninstallの両方でdeep-equal保持する", () => {
    const empty = { matcher: "never", future: [1, 2], hooks: [] };
    writeFileSync(hooksFile, JSON.stringify({ root: { keep: true }, hooks: { Stop: [empty] } }));
    registerCodexHook(NODE, CLI);
    expect(readHooks().hooks.Stop[0]).toEqual(empty);
    removeCodexHook();
    const after = readHooks();
    expect(after.root).toEqual({ keep: true });
    expect(after.hooks.Stop).toEqual([empty]);
  });

  it("同groupの他handler・group/handler未知キーをdeep-equalで保持し、文字列markerだけの他toolを所有しない", () => {
    const sibling = { type: "command", command: "bash ccc-notifier-helper.sh", timeout: 7, custom: { a: 1 } };
    const owned = {
      type: "command",
      command: codexHookCommand(NODE, OLD_CLI, "Stop"),
      timeout: 19,
      futureHandlerKey: { keep: true },
    };
    const group = { matcher: "", futureGroupKey: ["keep"], hooks: [sibling, owned] };
    writeFileSync(hooksFile, JSON.stringify({ rootFuture: 3, hooks: { Stop: [group] } }));

    registerCodexHook(NODE, CLI);
    const after = readHooks();
    expect(after.rootFuture).toBe(3);
    expect(after.hooks.Stop[0].futureGroupKey).toEqual(["keep"]);
    expect(after.hooks.Stop[0].hooks[0]).toEqual(sibling);
    expect(after.hooks.Stop[0].hooks[1].futureHandlerKey).toEqual({ keep: true });
    expect(after.hooks.Stop[0].hooks[1].timeout).toBe(20);
    expect(registerCodexHook(NODE, CLI).status).toBe("unchanged");

    removeCodexHook();
    const removed = readHooks();
    expect(removed.hooks.Stop).toEqual([{ matcher: "", futureGroupKey: ["keep"], hooks: [sibling] }]);
  });

  it("旧track --codexの完全形だけをStopでupgradeし、似た他commandは残す", () => {
    const legacy = { type: "command", command: `"${NODE}" "${OLD_CLI}" track --codex` };
    const similar = { type: "command", command: `"${NODE}" "/other/cli.js" track --codex` };
    writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [{ hooks: [legacy, similar] }] } }));
    registerCodexHook(NODE, CLI);
    const handlers = readHooks().hooks.Stop[0].hooks;
    expect(handlers[0].command).toBe(codexHookCommand(NODE, CLI, "Stop"));
    expect(handlers[1]).toEqual(similar);
  });

  it("重複した自handlerだけを除き、空になった重複groupだけを削除する", () => {
    const handler = { type: "command", command: codexHookCommand(NODE, CLI), timeout: 20 };
    writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [{ marker: 1, hooks: [handler] }, { marker: 2, hooks: [handler] }] } }));
    registerCodexHook(NODE, CLI);
    expect(readHooks().hooks.Stop).toEqual([{ marker: 1, hooks: [handler] }]);
  });

  it("マーカー一致エントリの command を更新し、重複させず、非マーカー Stop エントリは残す", () => {
    const nonMarker = { hooks: [{ type: "command", command: "bash /some/other/hook.sh" }] };
    const oldMarker = { hooks: [{ type: "command", command: codexHookCommand(NODE, OLD_CLI) }] };
    writeFileSync(
      hooksFile,
      JSON.stringify({ hooks: { Stop: [nonMarker, oldMarker] } }, null, 2) + "\n",
      "utf8",
    );

    const res = registerCodexHook(NODE, CLI);
    expect(res.status).toBe("written");
    expect(res.backupPath).not.toBeNull();

    const stop = readHooks().hooks.Stop;
    // 重複追加されず 2件のまま。
    expect(stop).toHaveLength(2);
    // 非マーカーエントリは完全に不変。
    expect(stop.find((e: any) => !isOurs(e))).toEqual(nonMarker);
    // マーカーエントリは1件だけ、command は新しい CLI パスに更新済み(古いパスは消える)。
    const ours = stop.filter(isOurs);
    expect(ours).toHaveLength(1);
    expect(ours[0].hooks[0].command).toBe(codexHookCommand(NODE, CLI));
    expect(ours[0].hooks[0].command).not.toContain("/old/");
  });

  it("Stop 内に同居する非マーカー hook は温存したまま marker hook のみ更新する", () => {
    // 1エントリ内に marker hook と別ツール hook が同居するケース(1項目たりとも壊さない)。
    const entry = {
      hooks: [
        { type: "command", command: codexHookCommand(NODE, OLD_CLI) },
        { type: "command", command: "bash /sibling/tool.sh" },
      ],
    };
    writeFileSync(
      hooksFile,
      JSON.stringify({ hooks: { Stop: [entry] } }, null, 2) + "\n",
      "utf8",
    );

    expect(registerCodexHook(NODE, CLI).status).toBe("written");

    const hooks = readHooks().hooks.Stop[0].hooks;
    expect(hooks).toHaveLength(2);
    expect(hooks[0].command).toBe(codexHookCommand(NODE, CLI)); // marker hook は更新
    expect(hooks[1].command).toBe("bash /sibling/tool.sh"); // 同居 hook は温存
  });
});

// ============ 5. 破損 / 予期しない構造 → manual ============

describe("registerCodexHook — 破損・異形は書かず manual", () => {
  it("破損 JSON には書き込まず manual を返し、manualSnippet に command 情報を含む", () => {
    const broken = "{ this is not valid json ";
    writeFileSync(hooksFile, broken, "utf8");

    const res = registerCodexHook(NODE, CLI);
    expect(res.status).toBe("manual");
    expect(res.backupPath).toBeNull();
    // JSON エスケープに耐える部分文字列で command 情報の存在を確認する。
    expect(res.manualSnippet).toBeDefined();
    expect(res.manualSnippet).toContain("ccc-notifier");
    expect(res.manualSnippet).toContain("__ccc-notifier-codex-hook UserPromptSubmit");
    expect(res.manualSnippet).toContain("__ccc-notifier-codex-hook SubagentStart");

    // ファイルは1バイトも変わらず、バックアップも作らない。
    expect(readFileSync(hooksFile, "utf8")).toBe(broken);
    expect(backups()).toHaveLength(0);
  });

  it("hooks が配列など予期しない構造は clobber せず manual(ファイル不変)", () => {
    const weird = JSON.stringify({ hooks: ["not", "an", "object"] });
    writeFileSync(hooksFile, weird, "utf8");

    const res = registerCodexHook(NODE, CLI);
    expect(res.status).toBe("manual");
    expect(readFileSync(hooksFile, "utf8")).toBe(weird);
    expect(backups()).toHaveLength(0);
  });

  it("Stop が文字列など予期しない構造も manual(ファイル不変)", () => {
    const weird = JSON.stringify({ hooks: { Stop: "oops" } });
    writeFileSync(hooksFile, weird, "utf8");

    const res = registerCodexHook(NODE, CLI);
    expect(res.status).toBe("manual");
    expect(readFileSync(hooksFile, "utf8")).toBe(weird);
    expect(backups()).toHaveLength(0);
  });

  it("hooks キーがない既存ファイルには他キーを残して Stop を新設できる", () => {
    // hooks 欠損は「異形」ではなく単なる欠損なので manual ではなく追記する。
    const raw = JSON.stringify({ someOtherKey: 1 }, null, 2) + "\n";
    writeFileSync(hooksFile, raw, "utf8");

    expect(registerCodexHook(NODE, CLI).status).toBe("written");
    const after = readHooks();
    expect(after.someOtherKey).toBe(1); // 他キー温存
    expect(after.hooks.Stop).toHaveLength(1);
  });
});

// ============ 6. removeCodexHook ============

describe("removeCodexHook", () => {
  it("マーカー一致のみ除去し、他 Stop エントリ・他イベントは残す", () => {
    const nonMarker = { hooks: [{ type: "command", command: "bash /some/other/hook.sh" }] };
    writeFileSync(hooksFile, PERMISSION_RAW, "utf8");
    // PermissionRequest はそのまま、Stop に非マーカー + マーカーを用意する。
    const obj = readHooks();
    obj.hooks.Stop = [nonMarker];
    writeFileSync(hooksFile, JSON.stringify(obj, null, 2) + "\n", "utf8");
    registerCodexHook(NODE, CLI); // マーカーエントリを追記
    expect(readHooks().hooks.Stop).toHaveLength(2);

    const before = JSON.parse(PERMISSION_RAW);
    const res = removeCodexHook();
    expect(res.status).toBe("written");
    expect(res.backupPath).not.toBeNull();

    const after = readHooks();
    // マーカーだけ消え、非マーカー Stop エントリと PermissionRequest は残る。
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0]).toEqual(nonMarker);
    expect(after.hooks.PermissionRequest).toEqual(before.hooks.PermissionRequest);
  });

  it("除去後 Stop が空になれば Stop キーごと削除し、hooks の他キーは維持する", () => {
    writeFileSync(hooksFile, PERMISSION_RAW, "utf8");
    registerCodexHook(NODE, CLI); // Stop はマーカー1件のみ
    expect(readHooks().hooks.Stop).toHaveLength(1);

    const res = removeCodexHook();
    expect(res.status).toBe("written");

    const after = readHooks();
    expect("Stop" in after.hooks).toBe(false); // Stop キーごと消える
    expect("UserPromptSubmit" in after.hooks).toBe(false);
    expect("SubagentStart" in after.hooks).toBe(false);
    expect("SubagentStop" in after.hooks).toBe(false);
    expect(after.hooks.PermissionRequest).toBeDefined(); // 他イベントは維持
  });

  it("マーカー未登録なら unchanged・ファイル不変・バックアップなし", () => {
    writeFileSync(hooksFile, PERMISSION_RAW, "utf8");

    const res = removeCodexHook();
    expect(res.status).toBe("unchanged");
    expect(res.backupPath).toBeNull();
    expect(readFileSync(hooksFile, "utf8")).toBe(PERMISSION_RAW);
    expect(backups()).toHaveLength(0);
  });

  it("hooks.json 不在なら unchanged(何もしない)", () => {
    expect(existsSync(hooksFile)).toBe(false);
    const res = removeCodexHook();
    expect(res.status).toBe("unchanged");
    expect(res.backupPath).toBeNull();
  });

  it("破損 JSON は manual ではなく unchanged(削除で壊さない)・ファイル不変", () => {
    const broken = "{ broken ";
    writeFileSync(hooksFile, broken, "utf8");

    const res = removeCodexHook();
    expect(res.status).toBe("unchanged");
    expect(readFileSync(hooksFile, "utf8")).toBe(broken);
    expect(backups()).toHaveLength(0);
  });
});

// ============ 7. codexHookCommand のクォート流儀 ============

describe("codexHookCommand — Claude 側 hook と同じクォート流儀", () => {
  it("空白入りパスでも両パスを '\"' で囲み、専用subcommandを使う", () => {
    const cmd = codexHookCommand("/a b/node", "/c d/ccc-notifier/cli.js");
    // Claude 側 buildHookCommand の `"<node>" "<cli>" track` に --codex を足した形。
    expect(cmd).toBe('"/a b/node" "/c d/ccc-notifier/cli.js" __ccc-notifier-codex-hook Stop');
    expect(cmd.startsWith('"')).toBe(true);
    expect(cmd).toContain('"/a b/node"');
    expect(cmd).toContain('"/c d/ccc-notifier/cli.js"');
    expect(cmd.endsWith("__ccc-notifier-codex-hook Stop")).toBe(true);
  });

  it("win32 ではパス区切りを '/' に正規化する", () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const cmd = codexHookCommand(
        "C:\\Program Files\\node.exe",
        "C:\\Users\\me\\ccc-notifier\\cli.js",
      );
      expect(cmd).toBe('"C:/Program Files/node.exe" "C:/Users/me/ccc-notifier/cli.js" __ccc-notifier-codex-hook Stop');
      expect(cmd).not.toContain("\\");
    } finally {
      if (orig) Object.defineProperty(process, "platform", orig);
    }
  });
});

// ============ 8. env: codexHome / codexHooksFile / detectCodex ============

describe("codexHome / codexHooksFile", () => {
  it("CCCN_CODEX_HOME を最優先し、hooks.json はその配下に解決する", () => {
    expect(codexHome()).toBe(tmpDir);
    expect(codexHooksFile()).toBe(join(tmpDir, "hooks.json"));
  });

  it("CCCN_CODEX_HOME 未設定なら ~/.codex を既定にする", () => {
    delete process.env.CCCN_CODEX_HOME;
    expect(codexHome()).toBe(join(homedir(), ".codex"));
  });
});

describe("detectCodex", () => {
  it("codexHome がディレクトリとして存在すれば true", () => {
    // beforeEach で tmpDir(実在ディレクトリ)を指している。
    expect(detectCodex()).toBe(true);
  });

  it("codexHome が存在しなければ false", () => {
    process.env.CCCN_CODEX_HOME = join(tmpDir, "does-not-exist");
    expect(detectCodex()).toBe(false);
  });

  it("codexHome がファイル(非ディレクトリ)なら false", () => {
    const asFile = join(tmpDir, "codex-as-file");
    writeFileSync(asFile, "x", "utf8");
    process.env.CCCN_CODEX_HOME = asFile;
    expect(detectCodex()).toBe(false);
  });
});
