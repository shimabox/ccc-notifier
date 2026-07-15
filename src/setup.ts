// src/setup.ts (T7) — セットアップ / アンインストール。
//
// ユーザーの ~/.claude/settings.json を編集する、本ツールで最も破壊リスクの高いモジュール。
// 「既存設定を1項目たりとも壊さない」ことが絶対の品質基準。
//
// 契約: src/contracts.md の "src/setup.ts (T7)" セクション参照。
//   - runInit(argv: string[]): Promise<number>      // --yes --os-only --no-notify を必ずサポート
//   - runUninstall(argv: string[]): Promise<number> // --purge サポート

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";

import type { TurnRecord } from "./types";
import { configFilePath, paths, readConfig } from "./store";
import { notifyOS } from "./notify/os";
import { notifySlack } from "./notify/slack";
import { detectCodex } from "./codex/env";
import { codexHooksFile, registerCodexHook, removeCodexHook } from "./codex/setup";
import type { CodexHookResult } from "./codex/setup";

// 本ツールの hook エントリの識別マーカー: command 文字列にこれを含む Stop エントリを「自分のもの」とみなす。
const HOOK_MARKER = "ccc-notifier";
const HOOK_TIMEOUT = 15;
const SLACK_PROMPT_CHARS = 100;
const DEFAULT_BUDGET_USD = 400; // init で提案する月予算の既定値(USD)。既存設定があればそちらを維持する。

// ============ 小ヘルパー ============

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 対象 settings パスを呼び出しのたびに評価して返す(モジュールロード時に固定しない)。 */
function settingsPath(): string {
  return process.env.CCCN_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json");
}

/**
 * 実行中モジュールから dist/cli.js の絶対パスを解決する。
 * - CCCN_CLI_PATH があればそれを最優先(テスト用上書き)。
 * - tsup バンドル後は実行ファイル自身が dist/cli.js。import.meta.url が dist 配下なら
 *   それ自身(= dist/cli.js)、src 配下なら ../dist/cli.js を解決する。
 */
function resolveCliPath(): string {
  const override = process.env.CCCN_CLI_PATH;
  if (override) return override;
  const here = fileURLToPath(import.meta.url);
  const dir = dirname(here);
  if (basename(dir) === "dist") return join(dir, "cli.js");
  return join(dir, "..", "dist", "cli.js");
}

/** hook コマンド文字列を組み立てる。win32 ではパス区切りを "/" に正規化し、常に両パスを "" で囲む。 */
function buildHookCommand(): string {
  let nodePath = process.execPath;
  let cliPath = resolveCliPath();
  if (process.platform === "win32") {
    nodePath = nodePath.replace(/\\/g, "/");
    cliPath = cliPath.replace(/\\/g, "/");
  }
  return `"${nodePath}" "${cliPath}" track`;
}

/** command 文字列がマーカーを含むか。doctor.ts の hook 検出とも共有する。 */
export function matchesMarker(command: string): boolean {
  return command.includes(HOOK_MARKER);
}

/** Stop エントリ(マッチャーグループ)が本ツールのものか判定する(いずれかの hook がマーカーを含むか)。 */
function isOurStopEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const hooks = entry.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) => isPlainObject(h) && typeof h.command === "string" && matchesMarker(h.command),
  );
}

/** 本ツールが追加する Stop エントリの正準構造を返す。 */
function ourStopEntry(command: string): Record<string, unknown> {
  return { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT }] };
}

/** 既存 settings を `<path>.bak-<epoch millis>` にコピーし、そのパスを返す(書き込み前に必ず呼ぶ)。 */
function backupSettings(path: string): string {
  const backupPath = `${path}.bak-${Date.now()}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

/** 破損 / 非オブジェクトな settings を検出した際、自動編集を諦めて手動追記スニペットを表示する。 */
function printManualSnippet(path: string, command: string, reason: string): void {
  const snippet = JSON.stringify(ourStopEntry(command), null, 2);
  console.error(`ERROR: ${reason}: ${path}`);
  console.error("安全のため settings.json の自動編集を中止しました。");
  console.error("以下の JSON を settings.json の hooks.Stop 配列に手動で追加してください:");
  console.error("");
  console.error(snippet);
  console.error("");
}

/** テスト通知用のダミー TurnRecord。 */
function makeTestRecord(): TurnRecord {
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    sessionId: "cccn-setup-test",
    project: process.cwd(),
    gitBranch: null,
    models: ["claude-fable-5"],
    tokens: { input: 100, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    sidechainTokens: null,
    apiCalls: 1,
    costUSD: 0.01,
    costJPY: 1.6,
    fxRate: 160,
    fxSource: "fixed",
    prompt: "セットアップ完了テスト",
  };
}

// ============ flags ============

interface InitFlags {
  yes: boolean;
  osOnly: boolean;
  slackOnly: boolean;
  noNotify: boolean;
  codex: boolean; // --codex: Codex CLI にも Stop hook を導入する
  noCodex: boolean; // --no-codex: Codex hook を導入しない(検出しても触らない)
  slackWebhook?: string;
  label?: string;
  rate?: string;
  budget?: string;
}

interface UninstallFlags {
  yes: boolean;
  purge: boolean;
}

function takeValue(argv: string[], i: number, prefix: string): string | undefined {
  const a = argv[i];
  if (a.startsWith(prefix + "=")) return a.slice(prefix.length + 1);
  return argv[i + 1];
}

function parseInitFlags(argv: string[]): InitFlags {
  const flags: InitFlags = {
    yes: false,
    osOnly: false,
    slackOnly: false,
    noNotify: false,
    codex: false,
    noCodex: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--os-only") {
      flags.osOnly = true;
    } else if (a === "--slack-only") {
      flags.slackOnly = true;
    } else if (a === "--no-notify") {
      flags.noNotify = true;
    } else if (a === "--codex") flags.codex = true;
    else if (a === "--no-codex") flags.noCodex = true;
    else if (a === "--slack-webhook" || a.startsWith("--slack-webhook=")) {
      flags.slackWebhook = takeValue(argv, i, "--slack-webhook");
      if (!a.includes("=")) i++;
    } else if (a === "--label" || a.startsWith("--label=")) {
      flags.label = takeValue(argv, i, "--label");
      if (!a.includes("=")) i++;
    } else if (a === "--rate" || a.startsWith("--rate=")) {
      flags.rate = takeValue(argv, i, "--rate");
      if (!a.includes("=")) i++;
    } else if (a === "--budget" || a.startsWith("--budget=")) {
      flags.budget = takeValue(argv, i, "--budget");
      if (!a.includes("=")) i++;
    }
  }
  return flags;
}

/**
 * config path entry の存在を symlink 自体も含めて副作用なく判定する。
 * null は ENOENT 以外の理由で安全に判定できなかったことを表す。
 */
function configPathEntryExists(path: string): boolean | null {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if (isPlainObject(err) && err.code === "ENOENT") return false;
    return null;
  }
}

/** 素の `init --yes --codex`（順不同、-y可）だけを限定移行候補にする。 */
function isExactCodexMigrationInvocation(argv: string[], flags: InitFlags): boolean {
  return flags.yes && flags.codex && argv.every((arg) => arg === "--yes" || arg === "-y" || arg === "--codex");
}

/** Codex hook 登録結果を通常 init / 限定移行で同じ文言に揃えて表示する。 */
function printCodexHookResult(codexResult: CodexHookResult): void {
  if (codexResult.status === "written") {
    console.log(`Codex に Stop/UserPromptSubmit/SubagentStart/SubagentStop hook を登録しました: ${codexHooksFile()}`);
    if (codexResult.backupPath) {
      console.log(`  バックアップ: ${codexResult.backupPath}`);
    }
    console.log(
      "次回 codex 起動時に『Hooks need review』が表示されます。『Trust all and continue』を選ぶと有効になります(承認までは動きません)",
    );
  } else if (codexResult.status === "unchanged") {
    console.log("Codex の Stop/UserPromptSubmit/SubagentStart/SubagentStop hook は登録済みです");
  } else {
    console.error(`Codex の hooks.json を自動編集できませんでした: ${codexHooksFile()}`);
    console.error("安全のため hooks.json の自動編集を中止しました。");
    console.error("以下の JSON の4イベントを hooks.json へ手動で追加してください:");
    console.error("");
    console.error(codexResult.manualSnippet ?? "");
    console.error("");
  }
}

function parseUninstallFlags(argv: string[]): UninstallFlags {
  const flags: UninstallFlags = { yes: false, purge: false };
  for (const a of argv) {
    if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--purge") flags.purge = true;
  }
  return flags;
}

// ============ settings への安全な書き込み ============

interface SettingsWriteResult {
  ok: boolean;      // false のとき: 破損等で書き込めなかった(呼び出し側は exit 1)
  backupPath: string | null;
}

/**
 * settings.json に本ツールの Stop フックをマージする(冪等)。
 * - 破損 / 非オブジェクト JSON: 絶対に書き込まず ok=false を返す(呼び出し側でスニペット表示 + exit 1)。
 * - 既存キー(他 hooks イベント / statusLine / permissions / 未知キー)は一切変更しない。
 * - マーカー一致の既存エントリがあれば command/timeout を更新、無ければ追記。
 * - ファイル不在: 新規作成(バックアップ不要)。
 */
function mergeSettings(sPath: string, command: string): SettingsWriteResult {
  if (!existsSync(sPath)) {
    mkdirSync(dirname(sPath), { recursive: true });
    const fresh = { hooks: { Stop: [ourStopEntry(command)] } };
    writeFileSync(sPath, JSON.stringify(fresh, null, 2) + "\n", "utf8");
    return { ok: true, backupPath: null };
  }

  const raw = readFileSync(sPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    printManualSnippet(sPath, command, "settings.json の JSON 解析に失敗しました");
    return { ok: false, backupPath: null };
  }
  if (!isPlainObject(parsed)) {
    printManualSnippet(sPath, command, "settings.json のルートがオブジェクトではありません");
    return { ok: false, backupPath: null };
  }

  const obj = parsed;

  // 書き込み前に必ずバックアップ。
  const backupPath = backupSettings(sPath);

  if (!isPlainObject(obj.hooks)) obj.hooks = {};
  const hooks = obj.hooks as Record<string, unknown>;
  if (!Array.isArray(hooks.Stop)) hooks.Stop = [];
  const stop = hooks.Stop as unknown[];

  const idx = stop.findIndex(isOurStopEntry);
  if (idx >= 0) {
    // 既存エントリの command/timeout のみ更新(重複追加しない = 冪等)。
    const entry = stop[idx] as Record<string, unknown>;
    const entryHooks = entry.hooks as unknown[];
    for (const h of entryHooks) {
      if (isPlainObject(h) && typeof h.command === "string" && matchesMarker(h.command)) {
        h.command = command;
        h.timeout = HOOK_TIMEOUT;
      }
    }
  } else {
    stop.push(ourStopEntry(command));
  }

  writeFileSync(sPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return { ok: true, backupPath };
}

// ============ runInit ============

export async function runInit(argv: string[]): Promise<number> {
  const flags = parseInitFlags(argv);

  // --codex と --no-codex は排他(対話・非対話を問わず。既存の排他フラグと同じ文体で先に弾く)。
  if (flags.codex && flags.noCodex) {
    console.error("--codex と --no-codex は同時に指定できません");
    return 1;
  }

  // 既存利用者向けの安全な hook 移行。config の存在確認は副作用なしで行い、
  // この経路では config の解釈・Claude settings・通知処理へ一切進まない。
  const exactMigrationInvocation = isExactCodexMigrationInvocation(argv, flags);
  const configEntryState = exactMigrationInvocation
    ? configPathEntryExists(configFilePath())
    : false;
  if (configEntryState === null) {
    console.error(`config.json の存在を安全に確認できませんでした: ${configFilePath()}`);
    console.error("安全のため Codex hook を含むすべての変更を中止しました。");
    return 1;
  }
  const codexOnlyMigration = exactMigrationInvocation && configEntryState;
  if (codexOnlyMigration) {
    const codexResult = registerCodexHook(process.execPath, resolveCliPath());
    printCodexHookResult(codexResult);
    if (codexResult.status === "manual") {
      console.error(
        "Codex hook 限定移行を完了できませんでした。config.json、Claude settings、通知設定は変更していません。",
      );
      return 1;
    }
    console.log(
      "Codex hook のみを確認・更新しました。config.json、Claude settings、通知設定は変更せず、テスト通知も送信していません。",
    );
    if (codexResult.status === "written") {
      console.log(
        "Codex を再起動し、/hooks で Stop / UserPromptSubmit / SubagentStart / SubagentStop を信頼済みにしてください。",
      );
    }
    return 0;
  }
  // Codex hook を登録するかどうか(下の分岐で確定する)。
  //   非対話: --codex のときだけ true(どちらも未指定なら Codex に触らない)。
  //   対話  : --codex/--no-codex 指定時はそれに従い、未指定かつ detectCodex() 真のときだけ確認する。
  let installCodex = false;

  // 1. 設定値の決定 —— readConfig()(既存 + デフォルトのマージ済み)を起点に回答を適用する。
  const cfg = readConfig();
  // 対話モードの初期選択を既存設定から導出する。特に通知なしモードのユーザーが
  // (hook の Node パス更新などで)再 init したとき、既定値のまま Enter して
  // 通知が復活してしまう事故を防ぐ。
  const initialChannel =
    !cfg.notify.os && !cfg.notify.slack
      ? "none"
      : cfg.notify.slack
        ? cfg.notify.os
          ? "both"
          : "slack"
        : "os";
  cfg.notify.os = true; // init は OS 通知を有効化する(通知なし: --no-notify / 対話の "none" で上書き)。
  // 月予算の既定: 既に設定済みならその値、未設定(0)なら $400 を提案する。
  const budgetDefault = cfg.monthlyBudgetUSD > 0 ? cfg.monthlyBudgetUSD : DEFAULT_BUDGET_USD;

  if (flags.yes) {
    // 非対話(CI / テスト)。フラグで与えられた値のみ適用する(未指定キーは既存値を維持)。
    if (flags.noNotify) {
      // 通知なし(記録・ダッシュボードのみ)。チャネル系フラグとは排他。
      if (flags.osOnly || flags.slackOnly || flags.slackWebhook !== undefined) {
        console.error("--no-notify と --os-only / --slack-only / --slack-webhook は同時に指定できません");
        return 1;
      }
      cfg.notify.os = false;
      cfg.notify.slack = null;
    } else if (flags.slackOnly) {
      // Slack のみ(OS 通知なし)。webhook が無いと通知手段がゼロになるため必須。
      if (flags.osOnly) {
        console.error("--slack-only と --os-only は同時に指定できません");
        return 1;
      }
      if (flags.slackWebhook === undefined) {
        console.error("--slack-only は --slack-webhook で Webhook URL を指定してください");
        return 1;
      }
      cfg.notify.os = false;
      cfg.notify.slack = {
        webhookUrl: flags.slackWebhook,
        promptChars: SLACK_PROMPT_CHARS,
        sendFullPrompt: false,
      };
    } else if (flags.osOnly) {
      cfg.notify.slack = null;
    } else if (flags.slackWebhook !== undefined) {
      cfg.notify.slack = {
        webhookUrl: flags.slackWebhook,
        promptChars: SLACK_PROMPT_CHARS,
        sendFullPrompt: false,
      };
    }
    if (flags.label !== undefined) {
      if (flags.label !== "api_equivalent" && flags.label !== "actual") {
        console.error(`--label は api_equivalent か actual を指定してください(受領: ${flags.label})`);
        return 1;
      }
      cfg.costLabel = flags.label;
    }
    if (flags.rate !== undefined) {
      const r = Number(flags.rate);
      if (!Number.isFinite(r) || r <= 0) {
        console.error(`--rate は正の数値を指定してください(受領: ${flags.rate})`);
        return 1;
      }
      cfg.fx.fallbackRate = r;
    }
    if (flags.budget !== undefined) {
      const b = Number(flags.budget);
      if (!Number.isFinite(b) || b < 0) {
        console.error(`--budget は 0 以上の数値を指定してください(受領: ${flags.budget})`);
        return 1;
      }
      cfg.monthlyBudgetUSD = b;
    } else {
      // 未指定なら既定($400。既存設定があればそれを維持)を適用する。
      cfg.monthlyBudgetUSD = budgetDefault;
    }
    // 非対話は --codex を明示したときのみ Codex hook を導入する(未指定・--no-codex は触らない)。
    installCodex = flags.codex;
  } else {
    // 対話モード。isCancel を必ず処理し、キャンセル時は何も書かずに exit 1。
    p.intro("ccc-notifier セットアップ");

    const channel = await p.select<string>({
      message: "通知チャネルを選択してください",
      options: [
        { value: "os", label: "OS 通知のみ" },
        { value: "slack", label: "Slack のみ(OS 通知なし)" },
        { value: "both", label: "OS 通知 + Slack" },
        { value: "none", label: "通知なし(記録・ダッシュボードのみ)" },
      ],
      initialValue: initialChannel,
    });
    if (p.isCancel(channel)) {
      p.cancel("キャンセルしました");
      return 1;
    }

    if (channel === "both" || channel === "slack") {
      const webhook = await p.text({
        message: "Slack Incoming Webhook URL",
        placeholder: "https://hooks.slack.com/services/...",
        validate: (v) =>
          !v || !v.startsWith("https://") ? "https:// で始まる URL を入力してください" : undefined,
      });
      if (p.isCancel(webhook)) {
        p.cancel("キャンセルしました");
        return 1;
      }
      cfg.notify.slack = {
        webhookUrl: webhook,
        promptChars: SLACK_PROMPT_CHARS,
        sendFullPrompt: false,
      };
      cfg.notify.os = channel === "both"; // 「Slack のみ」は OS 通知を無効化する
    } else {
      cfg.notify.slack = null;
      cfg.notify.os = channel === "os"; // "none" は通知を無効化する(記録・ダッシュボードは継続)
    }

    const labelChoice = await p.select<string>({
      message: "コスト表示ラベル",
      options: [
        { value: "api_equivalent", label: "API 換算(定額プランでも従量換算で表示)" },
        { value: "actual", label: "実額" },
      ],
      initialValue: cfg.costLabel,
    });
    if (p.isCancel(labelChoice)) {
      p.cancel("キャンセルしました");
      return 1;
    }
    cfg.costLabel = labelChoice === "actual" ? "actual" : "api_equivalent";

    const rateStr = await p.text({
      message: "USD/JPY フォールバック為替レート",
      placeholder: String(cfg.fx.fallbackRate),
      defaultValue: String(cfg.fx.fallbackRate),
      validate: (v) => {
        if (v === undefined || v === "") return undefined; // 既定値を採用
        const n = Number(v);
        return !Number.isFinite(n) || n <= 0 ? "正の数値を入力してください" : undefined;
      },
    });
    if (p.isCancel(rateStr)) {
      p.cancel("キャンセルしました");
      return 1;
    }
    const parsedRate = Number(rateStr);
    if (Number.isFinite(parsedRate) && parsedRate > 0) cfg.fx.fallbackRate = parsedRate;

    const budgetStr = await p.text({
      message: "月の予算(USD、既定 $400。0 で無効・ダッシュボードに当月の使用率を表示)",
      placeholder: String(budgetDefault),
      defaultValue: String(budgetDefault),
      validate: (v) => {
        if (v === undefined || v === "") return undefined; // 既定値を採用
        const n = Number(v);
        return !Number.isFinite(n) || n < 0 ? "0 以上の数値を入力してください" : undefined;
      },
    });
    if (p.isCancel(budgetStr)) {
      p.cancel("キャンセルしました");
      return 1;
    }
    const parsedBudget = Number(budgetStr);
    if (Number.isFinite(parsedBudget) && parsedBudget >= 0) cfg.monthlyBudgetUSD = parsedBudget;

    // Codex 連携。--codex/--no-codex がフラグで指定されていればそれに従い(質問しない)、
    // 未指定のときだけ Codex CLI を検出したら確認する(既定 Yes)。未検出なら質問自体を出さない。
    if (flags.codex) {
      installCodex = true;
    } else if (flags.noCodex) {
      installCodex = false;
    } else if (detectCodex()) {
      const codexConfirm = await p.confirm({
        message: "Codex CLI を検出しました。Codex にもコスト通知を入れますか?",
        initialValue: true,
      });
      if (p.isCancel(codexConfirm)) {
        p.cancel("キャンセルしました");
        return 1;
      }
      installCodex = codexConfirm;
    }

    p.outro("設定を適用します");
  }

  // 2. config.json 書き込み。
  const cccn = paths();
  writeFileSync(cccn.configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");

  // 3. hook コマンド構築。
  const command = buildHookCommand();

  // 4. settings マージ(破損時は書き込まず exit 1)。
  const sPath = settingsPath();
  const result = mergeSettings(sPath, command);
  if (!result.ok) return 1;

  // 4.5. Codex hook 登録(--codex または対話の確認で選ばれたときのみ)。
  //      nodePath/cliPath は Claude 側 hook と同一実体(process.execPath / resolveCliPath())を渡す。
  //      win32 正規化は codexHookCommand が内部で行うため、ここでは生の解決結果を渡す。
  //      hooks.json 破損時は manual に倒るが、Codex は副次的な連携なので init 自体は成功させる(exit 0)。
  let codexResult: CodexHookResult | null = null;
  if (installCodex) {
    codexResult = registerCodexHook(process.execPath, resolveCliPath());
  }

  // 5. テスト通知(CCCN_DRY_RUN 下では last-notify.json に書かれるだけ)。
  //    OS が有効なら OS 通知を、Slack を設定していれば Slack 通知も送り、その場で設定を確認できるようにする。
  //    通知なしモード(両チャネル無効)なら送らず、スキップした旨を明示する。
  const notifyDisabled = !cfg.notify.os && !cfg.notify.slack;
  if (notifyDisabled) {
    console.log("テスト通知: 通知なしモードのためスキップしました");
  } else {
    const testRecord = makeTestRecord();
    await notifyOS(testRecord, cfg);
    if (cfg.notify.slack) {
      await notifySlack(testRecord, cfg);
    }
  }

  // 6. 完了メッセージ。
  console.log("");
  console.log(`settings を更新しました: ${sPath}`);
  console.log(
    result.backupPath
      ? `  バックアップ: ${result.backupPath}`
      : "  (settings.json を新規作成したためバックアップはありません)",
  );
  console.log(`  設定ファイル: ${cccn.configFile}`);
  if (notifyDisabled) {
    console.log(
      "通知なしモードです。Claude Code の利用は自動で記録されます。ダッシュボード: npx ccc-notifier dashboard",
    );
  } else {
    console.log("Claude Code で何か実行すると通知が届きます。確認: npx ccc-notifier doctor");
  }

  // Codex 連携の結果表示(登録を試みたときのみ)。
  if (codexResult) {
    printCodexHookResult(codexResult);
  }
  return 0;
}

// ============ runUninstall ============

export async function runUninstall(argv: string[]): Promise<number> {
  const flags = parseUninstallFlags(argv);
  const sPath = settingsPath();

  // 1. settings からマーカー一致 Stop エントリのみを除去する。
  if (!existsSync(sPath)) {
    console.log("登録なし: settings.json が見つかりませんでした。");
  } else {
    const raw = readFileSync(sPath, "utf8");
    let parsed: unknown;
    let parseOk = true;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parseOk = false;
    }

    if (!parseOk || !isPlainObject(parsed)) {
      // 破損している settings は絶対に書き換えない(自動修復もしない)。
      console.error(`settings.json を解析できないため編集をスキップしました: ${sPath}`);
    } else {
      const obj = parsed;
      const hooks = isPlainObject(obj.hooks) ? (obj.hooks as Record<string, unknown>) : null;
      const stop = hooks && Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : null;
      const hasMarker = stop ? stop.some(isOurStopEntry) : false;

      if (!hasMarker || !hooks || !stop) {
        console.log("登録なし: 本ツールの Stop フックは登録されていません。");
      } else {
        const backupPath = backupSettings(sPath);
        const filtered = stop.filter((e) => !isOurStopEntry(e));
        if (filtered.length === 0) {
          delete hooks.Stop; // 空配列になったら Stop キー自体を削除(他 hooks キーは残す)。
        } else {
          hooks.Stop = filtered;
        }
        writeFileSync(sPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
        console.log(`本ツールの Stop フックを除去しました: ${sPath}`);
        console.log(`  バックアップ: ${backupPath}`);
      }
    }
  }

  // 1.5. Codex hooks.json からも本ツールの Stop エントリを除去する(未登録・不在なら黙ってスキップ)。
  const codexRemoval = removeCodexHook();
  if (codexRemoval.status === "written") {
    console.log("Codex の Stop/UserPromptSubmit/SubagentStart/SubagentStop hook を削除しました");
  }

  // 2. --purge: データディレクトリを削除する。
  if (flags.purge) {
    const home = paths().home;
    let doPurge = flags.yes;
    if (!flags.yes) {
      const confirmed = await p.confirm({
        message: `データディレクトリを完全に削除しますか?(${home})`,
        initialValue: false,
      });
      if (p.isCancel(confirmed)) {
        p.cancel("キャンセルしました");
        return 0;
      }
      doPurge = confirmed;
    }
    if (doPurge) {
      rmSync(home, { recursive: true, force: true });
      console.log(`データディレクトリを削除しました: ${home}`);
    }
  }

  return 0;
}
