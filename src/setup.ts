// src/setup.ts (T7) — セットアップ / アンインストール。
//
// ユーザーの ~/.claude/settings.json を編集する、本ツールで最も破壊リスクの高いモジュール。
// 「既存設定を1項目たりとも壊さない」ことが絶対の品質基準。
//
// 契約: src/contracts.md の "src/setup.ts (T7)" セクション参照。
//   - runInit(argv: string[]): Promise<number>      // --yes --os-only を必ずサポート
//   - runUninstall(argv: string[]): Promise<number> // --purge サポート

import {
  copyFileSync,
  existsSync,
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
import { paths, readConfig } from "./store";
import { notifyOS } from "./notify/os";
import { notifySlack } from "./notify/slack";

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
  return process.env.ACN_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json");
}

/**
 * 実行中モジュールから dist/cli.js の絶対パスを解決する。
 * - ACN_CLI_PATH があればそれを最優先(テスト用上書き)。
 * - tsup バンドル後は実行ファイル自身が dist/cli.js。import.meta.url が dist 配下なら
 *   それ自身(= dist/cli.js)、src 配下なら ../dist/cli.js を解決する。
 */
function resolveCliPath(): string {
  const override = process.env.ACN_CLI_PATH;
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
    sessionId: "acn-setup-test",
    project: process.cwd(),
    gitBranch: null,
    models: ["claude-fable-5"],
    tokens: { input: 100, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    sidechainTokens: null,
    apiCalls: 1,
    costUSD: 0.01,
    costJPY: 1.5,
    fxRate: 150,
    fxSource: "fixed",
    prompt: "セットアップ完了テスト",
  };
}

// ============ flags ============

interface InitFlags {
  yes: boolean;
  osOnly: boolean;
  slackOnly: boolean;
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
  const flags: InitFlags = { yes: false, osOnly: false, slackOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--os-only") flags.osOnly = true;
    else if (a === "--slack-only") flags.slackOnly = true;
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

  // 1. 設定値の決定 —— readConfig()(既存 + デフォルトのマージ済み)を起点に回答を適用する。
  const cfg = readConfig();
  cfg.notify.os = true; // init は OS 通知を有効化する。
  // 月予算の既定: 既に設定済みならその値、未設定(0)なら $400 を提案する。
  const budgetDefault = cfg.monthlyBudgetUSD > 0 ? cfg.monthlyBudgetUSD : DEFAULT_BUDGET_USD;

  if (flags.yes) {
    // 非対話(CI / テスト)。フラグで与えられた値のみ適用する(未指定キーは既存値を維持)。
    if (flags.slackOnly) {
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
  } else {
    // 対話モード。isCancel を必ず処理し、キャンセル時は何も書かずに exit 1。
    p.intro("ccc-notifier セットアップ");

    const channel = await p.select<string>({
      message: "通知チャネルを選択してください",
      options: [
        { value: "os", label: "OS 通知のみ" },
        { value: "both", label: "OS 通知 + Slack" },
        { value: "slack", label: "Slack のみ(OS 通知なし)" },
      ],
      initialValue: "os",
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

    p.outro("設定を適用します");
  }

  // 2. config.json 書き込み。
  const acn = paths();
  writeFileSync(acn.configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");

  // 3. hook コマンド構築。
  const command = buildHookCommand();

  // 4. settings マージ(破損時は書き込まず exit 1)。
  const sPath = settingsPath();
  const result = mergeSettings(sPath, command);
  if (!result.ok) return 1;

  // 5. テスト通知(ACN_DRY_RUN 下では last-notify.json に書かれるだけ)。
  //    OS が有効なら OS 通知を、Slack を設定していれば Slack 通知も送り、その場で設定を確認できるようにする。
  const testRecord = makeTestRecord();
  await notifyOS(testRecord, cfg);
  if (cfg.notify.slack) {
    await notifySlack(testRecord, cfg);
  }

  // 6. 完了メッセージ。
  console.log("");
  console.log(`settings を更新しました: ${sPath}`);
  console.log(
    result.backupPath
      ? `  バックアップ: ${result.backupPath}`
      : "  (settings.json を新規作成したためバックアップはありません)",
  );
  console.log(`  設定ファイル: ${acn.configFile}`);
  console.log("Claude Code で何か実行すると通知が届きます。確認: npx ccc-notifier doctor");
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
