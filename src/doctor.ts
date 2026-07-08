// src/doctor.ts (T8) — インストール状態の自己診断。
//
// 契約: src/contracts.md の "src/cli.ts, src/doctor.ts, src/report.ts (T8)" 参照。
// 各チェックは ✅/⚠️/❌ + 1行説明を表示し、❌ が1つでもあれば全体として 1 を返す。
// 個々のチェックは必ず自分自身で例外を処理し(内部で try/catch)、さらに safeRun() で
// 二重に例外を捕捉することで、1つのチェックの想定外の失敗が残りのチェックを止めないようにする。

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { computeCost, loadPriceTable } from "./pricing";
import { getUsdJpy } from "./fx";
import { formatUSD } from "./format";
import { notifyOS } from "./notify/os";
import { notifySlack } from "./notify/slack";
import { fmtMuteUntil } from "./mute";
import { matchesMarker } from "./setup";
import { isMuted, paths, readConfig, readMuteState } from "./store";
import { aggregateNewTurn } from "./transcript";
import type { Config, TurnRecord } from "./types";

type Status = "ok" | "warn" | "fail";

function icon(status: Status): string {
  if (status === "ok") return "✅";
  if (status === "warn") return "⚠️";
  return "❌";
}

function log(status: Status, message: string): void {
  console.log(`${icon(status)} ${message}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function settingsPath(): string {
  return process.env.ACN_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json");
}

function projectsDir(): string {
  return process.env.ACN_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");
}

/**
 * シェルのコマンド文字列を(ダブルクォート/シングルクォートを尊重して)トークン分割する。
 * setup.ts が組み立てる hook コマンドは `"<node絶対パス>" "<dist/cli.js絶対パス>" track`
 * のような形を想定しているが、引用符の有無や Windows のパス区切りにも耐えるよう緩めに扱う。
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

/** hook コマンド文字列からスクリプトパスらしきトークンを推定する。見つからなければ null。 */
function extractScriptPath(command: string): string | null {
  const tokens = tokenizeCommand(command).filter((t) => t.length > 0);
  const markerJs = tokens.find((t) => t.endsWith(".js") && matchesMarker(t));
  if (markerJs) return markerJs;
  const anyJs = tokens.find((t) => t.endsWith(".js"));
  if (anyJs) return anyJs;
  const marker = tokens.find((t) => matchesMarker(t));
  return marker ?? null;
}

/** すべてのエラーを内部で処理し、失敗しても false を返すだけの安全な実行ラッパー。 */
async function safeRun(name: string, fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await fn();
  } catch (err) {
    log("fail", `[${name}] チェック中に予期しないエラーが発生しました: ${errMessage(err)}`);
    return false;
  }
}

// ---- 1. settings.json の hooks.Stop 登録確認 ----
async function checkHookRegistration(): Promise<boolean> {
  const file = settingsPath();
  if (!existsSync(file)) {
    log("fail", `settings.json が見つかりません: ${file}(init を実行してください)`);
    return false;
  }

  let parsed: unknown;
  try {
    const raw = await readFile(file, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    log("fail", `settings.json を読み込めません: ${file}(${errMessage(err)})`);
    return false;
  }

  if (!isRecord(parsed)) {
    log("fail", `settings.json の内容が不正です: ${file}`);
    return false;
  }

  const hooks = parsed.hooks;
  const stopEntries = isRecord(hooks) ? hooks.Stop : undefined;
  const matchedCommands: string[] = [];

  if (Array.isArray(stopEntries)) {
    for (const entry of stopEntries) {
      if (!isRecord(entry)) continue;
      const innerHooks = entry.hooks;
      if (!Array.isArray(innerHooks)) continue;
      for (const h of innerHooks) {
        if (isRecord(h) && typeof h.command === "string" && matchesMarker(h.command)) {
          matchedCommands.push(h.command);
        }
      }
    }
  }

  if (matchedCommands.length === 0) {
    log("fail", "hooks.Stop に ccc-notifier のエントリが見つかりません(init を実行してください)");
    return false;
  }

  // 実行コマンドの絶対パスも表示する: source(node dist/cli.js)・グローバルインストール・
  // 複数クローンなど、どの実体が hook として動いているか一目で分かるようにするため
  // (npm 未公開でも npx がローカル node_modules/.bin を拾って動くことがあり紛らわしいため)。
  log(
    "ok",
    `hooks.Stop に ccc-notifier のエントリが登録されています(${matchedCommands.length}件): ${matchedCommands.join(" / ")}`,
  );

  let allScriptsExist = true;
  for (const command of matchedCommands) {
    const scriptPath = extractScriptPath(command);
    if (scriptPath === null || !existsSync(scriptPath)) {
      allScriptsExist = false;
    }
  }
  if (!allScriptsExist) {
    log(
      "warn",
      "登録済みコマンドのスクリプトパスが見つかりません(移動・削除された可能性があります。init の再実行を検討してください)",
    );
  }

  // Node 実行パスの死活チェック: 各 command の第1トークンを Node 実行パス候補とみなす。
  // 絶対パス風("/" または Windows の ":\\" を含む)のに存在しなければ ⚠️(mise 等で Node を更新・
  // 削除するとここが無効化される)。ベア名("node" 等)はチェックしない。❌ にはしない(exit code 不変)。
  for (const command of matchedCommands) {
    const first = tokenizeCommand(command).filter((t) => t.length > 0)[0];
    if (first === undefined) continue;
    const looksAbsolute = first.includes("/") || first.includes(":\\");
    if (!looksAbsolute) continue; // "node" のようなベア名は PATH 解決なのでチェックしない
    if (!existsSync(first)) {
      log(
        "warn",
        `hook の Node 実行パスが見つかりません(mise 等での更新が原因の可能性)。init を再実行してください: ${first}`,
      );
    }
  }

  return true;
}

// ---- 2. Claude projects ディレクトリ + 最新 transcript のパース確認 ----

/** readdirSync(withFileTypes:true) を試み、失敗すれば null を返す(例外を外に出さない)。 */
function readDirSafe(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

function findLatestTranscript(dir: string): string | null {
  let latestPath: string | null = null;
  let latestMtime = -Infinity;

  const walk = (current: string): void => {
    const entries = readDirSafe(current);
    if (entries === null) return; // 読めないサブディレクトリは黙って無視する
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const mtime = statSync(full).mtimeMs;
          if (mtime > latestMtime) {
            latestMtime = mtime;
            latestPath = full;
          }
        } catch {
          // stat できないファイルは無視する
        }
      }
    }
  };

  walk(dir);
  return latestPath;
}

async function checkProjectsAndTranscript(): Promise<{ ok: boolean; latestTranscript: string | null }> {
  const dir = projectsDir();

  try {
    readdirSync(dir);
  } catch (err) {
    log("fail", `Claude projects ディレクトリを読み込めません: ${dir}(${errMessage(err)})`);
    return { ok: false, latestTranscript: null };
  }

  log("ok", `Claude projects ディレクトリを読み込めました: ${dir}`);

  const latest = findLatestTranscript(dir);
  if (latest === null) {
    log("warn", "*.jsonl の transcript が見つかりません(まだセッションが記録されていない可能性があります)");
    return { ok: true, latestTranscript: null };
  }

  try {
    const result = await aggregateNewTurn(latest, null);
    if (result === null) {
      log("warn", `最新の transcript から新規 usage を検出できませんでした: ${latest}`);
    } else {
      log("ok", `最新の transcript を解析できました(apiCalls=${result.apiCalls}): ${latest}`);
    }
  } catch (err) {
    // パース例外は ❌ 扱いにせず ⚠️ に留める。
    log("warn", `transcript の解析中に例外が発生しました: ${errMessage(err)}`);
  }

  return { ok: true, latestTranscript: latest };
}

// ---- 3. config.json ----
function checkConfig(): boolean {
  const cfg = readConfig();
  const slackState = cfg.notify.slack ? "有効" : "無効";
  log(
    "ok",
    `config.json を読み込みました(notify.os=${cfg.notify.os}, slack=${slackState}, costLabel=${cfg.costLabel}, minNotifyUSD=${cfg.minNotifyUSD}, fx.fallbackRate=${cfg.fx.fallbackRate})`,
  );
  return true;
}

// ---- 4. 単価表 ----
async function checkPricing(): Promise<boolean> {
  try {
    const table = await loadPriceTable(paths().cacheDir, { offline: false });
    const entries = Object.entries(table);
    const litellmCount = entries.filter(([, price]) => price.source === "litellm").length;
    if (litellmCount > 0) {
      log("ok", `単価表を取得しました(${entries.length}件、litellm由来 ${litellmCount}件)`);
    } else {
      log(
        "warn",
        `単価表は内蔵データのみです(${entries.length}件、litellm由来 0件。ネットワーク取得に失敗した可能性があります)`,
      );
    }
    // ネットワーク取得に失敗しても builtin テーブルで動作を継続できるため、
    // このチェックは ⚠️ 止まりとし ❌ にはしない。
    return true;
  } catch (err) {
    log("warn", `単価表の取得中にエラーが発生しました(内蔵データで動作します): ${errMessage(err)}`);
    return true;
  }
}

// ---- 5. 為替レート ----
async function checkFx(cfg: Config): Promise<boolean> {
  try {
    const result = await getUsdJpy(cfg, paths().cacheDir);
    if (result.source === "fixed") {
      log("warn", `為替レートは固定値にフォールバックしています: 1USD = ${result.rate}JPY(source=fixed)`);
    } else {
      log("ok", `為替レートを取得しました: 1USD = ${result.rate}JPY(source=${result.source})`);
    }
    return true;
  } catch (err) {
    log("warn", `為替レートの取得に失敗しました: ${errMessage(err)}`);
    return true;
  }
}

// ---- 6. テスト通知 ----
async function checkNotification(cfg: Config): Promise<boolean> {
  try {
    // ミュート中の見落とし(「通知が来ない!」)を防ぐため、状態を明示する。
    // テスト通知自体はミュートの影響を受けずに送る(通知経路の診断が目的のため)。
    if (isMuted()) {
      const until = readMuteState()?.until;
      log(
        "warn",
        until
          ? `通知はミュート中です(${fmtMuteUntil(until)} まで)。再開は ccc-notifier unmute`
          : "通知はミュート中です(無期限)。再開は ccc-notifier unmute",
      );
    }

    const dummy: TurnRecord = {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      sessionId: "doctor-test",
      project: process.cwd(),
      gitBranch: null,
      models: ["claude-fable-5"],
      tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
      sidechainTokens: null,
      apiCalls: 0,
      costUSD: 0,
      costJPY: 0,
      fxRate: cfg.fx.fallbackRate,
      fxSource: "fixed",
      prompt: "doctor によるテスト通知です",
    };

    const dryRun = process.env.ACN_DRY_RUN === "1";
    const dryHint = `(ACN_DRY_RUN=1 のため ${paths().lastNotifyFile} の内容で確認できます)`;

    // OS 通知(有効なときのみ)。
    if (cfg.notify.os) {
      await notifyOS(dummy, cfg);
      log("ok", `OS のテスト通知を送信しました${dryRun ? dryHint : "(OS通知が表示されたか確認してください)"}`);
    } else {
      log("warn", "notify.os が無効なため、OS のテスト通知はスキップしました");
    }

    // Slack 通知(webhook を設定しているときのみ)。notifySlack は throw しない。
    if (cfg.notify.slack) {
      await notifySlack(dummy, cfg);
      log(
        "ok",
        `Slack のテスト通知を送信しました${dryRun ? dryHint : "(Slack チャンネルに届いたか確認してください。届かない場合は error.log を参照)"}`,
      );
    }

    if (!cfg.notify.os && !cfg.notify.slack) {
      log("warn", "OS・Slack とも無効なため、テスト通知は送信していません");
    }

    return true;
  } catch (err) {
    // notifyOS は契約上 throw しないが、念のため ⚠️ に倒す。
    log("warn", `テスト通知の送信に失敗しました: ${errMessage(err)}`);
    return true;
  }
}

// ---- 7. 直近セッションの合計 USD ----
async function checkRecentSessionTotal(latestTranscript: string | null): Promise<boolean> {
  if (latestTranscript === null) {
    log("warn", "直近セッション合計: transcript が見つからないため計算をスキップしました");
    return true;
  }

  try {
    const aggregate = await aggregateNewTurn(latestTranscript, null);
    if (aggregate === null) {
      log("warn", "直近セッション合計: 新規 usage が無いため計算できませんでした");
      return true;
    }

    // 単価表の再取得はチェック4で行っているため、ここではネットワークに出ず
    // キャッシュ(なければ内蔵表)のみで計算する。
    const table = await loadPriceTable(paths().cacheDir, { offline: true });
    const breakdown = computeCost(aggregate.main, aggregate.sidechain, table);
    log(
      "ok",
      `直近セッション合計: ${formatUSD(breakdown.usd)}(Claude Code の /cost の Total cost と見比べてください)`,
    );
    return true;
  } catch (err) {
    log("warn", `直近セッション合計の計算中にエラーが発生しました: ${errMessage(err)}`);
    return true;
  }
}

export async function runDoctor(): Promise<number> {
  const results: boolean[] = [];

  results.push(await safeRun("settings.json", () => checkHookRegistration()));

  let latestTranscript: string | null = null;
  results.push(
    await safeRun("projects", async () => {
      const r = await checkProjectsAndTranscript();
      latestTranscript = r.latestTranscript;
      return r.ok;
    }),
  );

  const cfg = readConfig();

  results.push(await safeRun("config", () => Promise.resolve(checkConfig())));
  results.push(await safeRun("pricing", () => checkPricing()));
  results.push(await safeRun("fx", () => checkFx(cfg)));
  results.push(await safeRun("notify", () => checkNotification(cfg)));
  results.push(await safeRun("recent-session", () => checkRecentSessionTotal(latestTranscript)));

  const hasFailure = results.some((ok) => ok === false);
  return hasFailure ? 1 : 0;
}
