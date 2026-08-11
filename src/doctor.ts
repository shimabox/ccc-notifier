// src/doctor.ts (T8) — インストール状態の自己診断。
//
// 契約: src/contracts.md の "src/cli.ts, src/doctor.ts, src/report.ts (T8)" 参照。
// 各チェックは ✅/⚠️/❌ + 1行説明を表示し、❌ が1つでもあれば全体として 1 を返す。
// 個々のチェックは必ず自分自身で例外を処理し(内部で try/catch)、さらに safeRun() で
// 二重に例外を捕捉することで、1つのチェックの想定外の失敗が残りのチェックを止めないようにする。

import { existsSync, readdirSync, statSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { computeCost, loadPriceTable } from "./pricing";
import { isWSL } from "./env";
import { getUsdJpy } from "./fx";
import { formatUSD } from "./format";
import { notifyOS, selectNotifyBackend } from "./notify/os";
import { notifySlack } from "./notify/slack";
import { fmtMuteUntil } from "./mute";
import { matchesMarker } from "./setup";
import { claudeTranscriptRoots, rootForClaudePath } from "./claude-roots";
import type { ClaudeTranscriptRoot } from "./claude-roots";
import { codexHome, detectCodex } from "./codex/env";
import { CODEX_HOOK_EVENTS } from "./codex/setup";
import { diagnoseCodexHookSources } from "./codex/hook-diagnostics";
import { findLatestCodexRollout, listCodexRollouts } from "./codex/sessions";
import { splitIntoCodexTurnDrafts } from "./codex/transcript";
import { cursorPaths, isMuted, paths, readConfig, readMuteState, readTurns } from "./store";
import { aggregateNewTurn } from "./transcript";
import type { Config, TokenBuckets, TurnRecord, UsageByModel } from "./types";

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
  return process.env.CCCN_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json");
}

function projectsDir(): string {
  return process.env.CCCN_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");
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

// ---- 1b. Codex CLI の hook 登録確認(検出時のみ) ----
// hook 登録セクションの直後・通知チェック(通知なしモードの早期 return を含む)より前に置く。
// Codex 未検出・未登録は「未使用なら問題ない」ため ❌ にはせず、exit code の意味論を変えない。
async function checkCodex(): Promise<{ ok: boolean; stopConfigured: boolean }> {
  const expectedCli = process.env.CCCN_CLI_PATH ?? process.argv[1] ?? "";
  const diagnostics = diagnoseCodexHookSources({
    codexHome: codexHome(),
    cwd: process.cwd(),
    expectedNodePath: process.execPath,
    expectedCliPath: expectedCli,
    envSources: process.env.CCCN_CODEX_HOOK_SOURCES,
  });

  // Project / supplemental source discovery must happen before detectCodex()'s user-home check.
  if (!detectCodex() && diagnostics.candidates.length === 0) {
    log("ok", "Codex CLI は未検出です(未使用なら問題ありません)");
    return { ok: true, stopConfigured: false };
  }

  for (const source of diagnostics.candidates) {
    if (source.format === "toml") {
      log("warn", `Codex inline hook候補を検出しました(${source.scope}, ${source.discovery}): ${source.path}`);
      log("warn", "config.tomlは解釈しないためhandler・features.hooks・trustの実効状態は未確認です。Codexで /hooks を確認してください");
    } else if (source.format === "opaque") {
      log("warn", `Codex opaque env-extra sourceを検出しました(内容未確認): ${source.path}`);
    }
  }

  for (const warning of diagnostics.warnings) {
    if (warning.kind === "nonstandard-feature-field") {
      log("warn", `Codex JSON sourceに非標準features.hooks fieldがあります。global disabledの根拠にはしません: ${warning.sourcePath}`);
    } else {
      log("warn", `Codex JSON sourceを安全に検査できません(${warning.kind}): ${warning.sourcePath}`);
    }
  }

  for (const handler of diagnostics.handlers) {
    log(
      handler.pathMatches && handler.timeoutMatches ? "ok" : "warn",
      `Codex ${handler.event} hookを設定ファイル上で確認(${handler.scope}): ${handler.sourcePath}; actual nodePath=${handler.nodePath}, actual cliPath=${handler.cliPath}, expected nodePath=${process.execPath.replace(/\\/g, "/")}, expected cliPath=${expectedCli.replace(/\\/g, "/")}, 実体path=${handler.pathMatches ? "一致" : "不一致(stale/wrong)"}, timeout=${String(handler.timeout)}`,
    );
  }

  for (const event of CODEX_HOOK_EVENTS) {
    if (!diagnostics.handlers.some((handler) => handler.event === event)) {
      log("warn", `Codex ${event} hookは検査できたJSON sourceでは確認できません。inline/plugin/managed sourceは未確認です。必要なら init --codex、実効状態はCodexの /hooksを確認してください`);
    }
  }
  for (const duplicate of diagnostics.exactDuplicates) {
    log("warn", `Codex ${duplicate.event} hookのexact duplicateを検査済みJSONで確認(${duplicate.count}件): ${duplicate.sources.join(" / ")}。matching hooksは複数sourceからすべて実行され得ます`);
  }
  for (const mixed of diagnostics.sameLayerMixedRepresentation) {
    log("warn", `Codex ${mixed.scope} layerにhooks.jsonとconfig.tomlが併存しています(potential duplicate、TOML内容未確認): ${mixed.json} / ${mixed.toml}`);
  }
  log("warn", "Codex hookのglobal/individual disabled、project/hook trustは静的診断では未確認です。Codexで /hooksを確認してください");
  log("warn", "plugin/managed/session sourceを含む実効状態は静的診断だけでは完全列挙できません。Codexで /hooksを確認してください");

  // sessions/ の存在。無くても「まだセッションが無いだけ」の可能性があるため ❌ にはしない。
  const sessionsDir = join(codexHome(), "sessions");
  if (existsSync(sessionsDir)) {
    log("ok", `Codex のセッションディレクトリを確認しました: ${sessionsDir}`);
  } else {
    log("ok", `Codex のセッションディレクトリはまだありません: ${sessionsDir}(セッション未作成の可能性があります)`);
  }

  return {
    ok: true,
    stopConfigured: diagnostics.handlers.some(
      (handler) => handler.event === "Stop" && handler.scope !== "env-extra",
    ),
  };
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
    // 通知なしモード(両チャネル無効)は意図的な設定として ✅ で明示する。
    // notify.os の既定は true のため、両方無効は init の「通知なし」選択・--no-notify・
    // 手動編集のいずれかによる意図的な状態でしかありえない。ミュートや通知経路の
    // 診断はこのモードでは無関係なのでスキップする。
    if (!cfg.notify.os && !cfg.notify.slack) {
      log("ok", "通知チャネルはすべて無効です(通知なし・ダッシュボードのみモード)。記録とダッシュボードは動作します");
      log("ok", "通知を有効にするには npx ccc-notifier init を再実行してください");
      return true;
    }

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

    // 通知経路(実行環境)を明示する。WSL2 では notify-send ではなく Windows の
    // トースト(powershell.exe)へ橋渡しするため、その旨を診断ログに出す。
    if (process.platform === "linux" && isWSL()) {
      log("ok", "WSL2 環境を検出しました。通知は Windows のトースト(powershell.exe)経由で送信します");
    } else {
      const backend = selectNotifyBackend();
      log("ok", `通知経路: ${backend.kind}(platform=${process.platform})`);
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

    const dryRun = process.env.CCCN_DRY_RUN === "1";
    const dryHint = `(CCCN_DRY_RUN=1 のため ${paths().lastNotifyFile} の内容で確認できます)`;

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

    return true;
  } catch (err) {
    // notifyOS は契約上 throw しないが、念のため ⚠️ に倒す。
    log("warn", `テスト通知の送信に失敗しました: ${errMessage(err)}`);
    return true;
  }
}

// ---- 7. 直近セッションの合計 USD ----
async function checkClaudeRecentSessionTotal(latestTranscript: string | null): Promise<boolean> {
  if (latestTranscript === null) {
    log("warn", "Claude Code 直近セッション合計: transcript が見つからないため計算をスキップしました");
    return true;
  }

  try {
    const aggregate = await aggregateNewTurn(latestTranscript, null);
    if (aggregate === null) {
      log("warn", "Claude Code 直近セッション合計: 新規 usage が無いため計算できませんでした");
      return true;
    }

    // 単価表の再取得はチェック4で行っているため、ここではネットワークに出ず
    // キャッシュ(なければ内蔵表)のみで計算する。
    const table = await loadPriceTable(paths().cacheDir, { offline: true });
    const breakdown = computeCost(aggregate.main, aggregate.sidechain, table);
    log(
      "ok",
      `Claude Code 直近セッション合計: ${formatUSD(breakdown.usd)}(Claude Code の /cost の Total cost と見比べてください)`,
    );
    return true;
  } catch (err) {
    log("warn", `Claude Code 直近セッション合計の計算中にエラーが発生しました: ${errMessage(err)}`);
    return true;
  }
}

function emptyBuckets(): TokenBuckets {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function mergeUsage(target: UsageByModel, incoming: UsageByModel): void {
  for (const [model, bucket] of Object.entries(incoming)) {
    const merged = Object.hasOwn(target, model) ? target[model] : emptyBuckets();
    merged.input += bucket.input;
    merged.output += bucket.output;
    merged.cacheWrite5m += bucket.cacheWrite5m;
    merged.cacheWrite1h += bucket.cacheWrite1h;
    merged.cacheRead += bucket.cacheRead;
    target[model] = merged;
  }
}

function safeUnknownModels(models: readonly string[]): string {
  const safe = [...new Set(models.map((model) =>
    model.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim().slice(0, 64) || "unknown"
  ))].sort();
  const shown = safe.slice(0, 5);
  return `${shown.join(", ")}${safe.length > shown.length ? `, ...(+${safe.length - shown.length})` : ""}`;
}

async function checkCodexRecentSessionTotal(configured: boolean): Promise<boolean> {
  if (!configured) return true;
  try {
    const sessionsRoot = join(codexHome(), "sessions");
    if (!existsSync(sessionsRoot)) {
      log("warn", "Codex 最新rollout合計: セッションディレクトリがないためスキップ");
      return true;
    }

    const discovery = await findLatestCodexRollout(sessionsRoot);
    if (discovery.unreadableDirs > 0 || discovery.unreadableFiles > 0) {
      log("warn", "Codex 最新rollout合計: rollout探索を完全に検証できず最新を確定できないためスキップ");
      return true;
    }
    if (discovery.latest === null) {
      log("warn", "Codex 最新rollout合計: rolloutが見つからないためスキップ");
      return true;
    }

    // The latest single rollout is read from byte zero. Returned cursors are deliberately discarded.
    const drafts = await splitIntoCodexTurnDrafts(discovery.latest, null);
    if (drafts === null || drafts.length === 0) {
      log("warn", "Codex 最新rollout合計: usageがない、または有効なtoken_countを解析できません");
      return true;
    }
    const usage = Object.create(null) as UsageByModel;
    for (const draft of drafts) mergeUsage(usage, draft.agg.main);
    const table = await loadPriceTable(paths().cacheDir, { offline: true });
    const breakdown = computeCost(usage, {}, table);
    if (breakdown.unknownModels.length > 0) {
      log(
        "warn",
        `Codex 最新rollout合計: ${formatUSD(breakdown.usd)}(API換算・単一rolloutのみ・親/子未分類/非合算・Claude Code分とは別集計。ただし単価不明モデルを含むため過少計上の可能性があります: ${safeUnknownModels(breakdown.unknownModels)})`,
      );
    } else {
      log("ok", `Codex 最新rollout合計: ${formatUSD(breakdown.usd)}(API換算・単一rolloutのみ・親/子未分類/非合算・Claude Code分とは別集計)`);
    }
    return true;
  } catch {
    log("warn", "Codex 最新rollout合計の計算中にエラーが発生したためスキップ");
    return true;
  }
}

// ---- 8. デスクトップ検出状況・追跡漏れ・originator 内訳・sessionId 重複(desktop-cost-tracking) ----

const PEEK_CHUNK_BYTES = 64 * 1024;
const PEEK_MAX_BYTES = 4 * 1024 * 1024;

/**
 * ファイル先頭の1行だけを読み JSON として返す。失敗は null(診断のみが目的のベストエフォート)。
 *
 * 改行が見つかるまでチャンク単位で読み進める。Codex rollout の先頭行は base_instructions
 * (長いシステムプロンプト)を含み、実データでは 14KB〜42KB になる。固定長で切ると
 * 途中で切れた文字列を JSON.parse することになり、全件が黙って null になる。
 * ファイル全体を読み込まないよう上限を設け、超えたら null にする。
 */
async function peekFirstJsonLine(
  path: string,
  maxBytes = PEEK_MAX_BYTES,
): Promise<Record<string, unknown> | null> {
  try {
    const fh = await open(path, "r");
    try {
      const chunk = Buffer.alloc(Math.min(PEEK_CHUNK_BYTES, maxBytes));
      const parts: Buffer[] = [];
      let read = 0;
      let line: string | null = null;
      while (read < maxBytes) {
        const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, maxBytes - read), read);
        if (bytesRead === 0) {
          line = Buffer.concat(parts).toString("utf8"); // 改行なしで EOF = ファイル全体が1行
          break;
        }
        const slice = chunk.subarray(0, bytesRead);
        const nl = slice.indexOf(0x0a);
        if (nl !== -1) {
          parts.push(Buffer.from(slice.subarray(0, nl)));
          line = Buffer.concat(parts).toString("utf8");
          break;
        }
        parts.push(Buffer.from(slice));
        read += bytesRead;
      }
      if (line === null) return null; // 上限まで改行が無い
      const trimmed = line.trim();
      if (trimmed.length === 0) return null;
      const obj: unknown = JSON.parse(trimmed);
      return isRecord(obj) ? obj : null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function listProjectDirsSafe(root: string): Promise<string[]> {
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

async function listTranscriptsSafe(projectDir: string): Promise<string[]> {
  try {
    const entries = readdirSync(projectDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => join(projectDir, e.name));
  } catch {
    return [];
  }
}

async function discoverClaudeFilesForDoctor(roots: ClaudeTranscriptRoot[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    for (const dir of await listProjectDirsSafe(root.path)) {
      files.push(...(await listTranscriptsSafe(dir)));
    }
  }
  return files;
}

async function checkDesktopScan(): Promise<boolean> {
  const roots = await claudeTranscriptRoots();
  const desktopRoots = roots.filter((r) => r.surface === "desktop");
  if (desktopRoots.length === 0) {
    log("ok", "Claude デスクトップのスキャンルートは検出されませんでした(未使用、または macOS 以外・CCCN_CLAUDE_DESKTOP_ROOTS 未設定)");
  } else {
    for (const root of desktopRoots) {
      const exists = existsSync(root.path);
      log(
        exists ? "ok" : "warn",
        `Claude デスクトップのスキャンルート: ${root.path}${exists ? "" : "(現在は不在。アプリ更新でレイアウトが変わった可能性があります)"}`,
      );
    }
  }

  const tracked = cursorPaths();

  const claudeFiles = await discoverClaudeFilesForDoctor(roots);
  const claudeUntracked = claudeFiles.filter((f) => !tracked.has(f)).length;
  log(
    "ok",
    `Claude transcript 追跡漏れ: ${claudeUntracked}件(全 ${claudeFiles.length}件中。未追跡分は ccc-notifier scan で回収できます)`,
  );

  // 同一 sessionId が複数の transcript ファイルに現れるケースを検知する(二重計上ガード)。
  // 数えるのはサーフェスの種類ではなくファイル。同じサーフェスのルートが複数ある構成
  // (デスクトップルートが2つ等)の重複も検知対象に含める。
  const sessionToFiles = new Map<string, string[]>();
  for (const f of claudeFiles) {
    const line = await peekFirstJsonLine(f);
    const sid = typeof line?.sessionId === "string" ? line.sessionId : null;
    if (sid === null || sid.length === 0) continue;
    const files = sessionToFiles.get(sid) ?? [];
    files.push(f);
    sessionToFiles.set(sid, files);
  }
  const dupEntries = [...sessionToFiles.entries()].filter(([, files]) => files.length > 1);
  if (dupEntries.length > 0) {
    const multiRoot = dupEntries.filter(
      ([, files]) => new Set(files.map((f) => rootForClaudePath(f, roots)?.path ?? "")).size > 1,
    ).length;
    const sample = dupEntries
      .slice(0, 3)
      .map(([sid, files]) => `${sid.slice(0, 8)}…(${files.length}ファイル)`)
      .join(" / ");
    log(
      "warn",
      `同一 sessionId が複数の transcript ファイルに現れています(${dupEntries.length}件・うち複数ルートにまたがるもの ${multiRoot}件): ${sample}。` +
        "二重計上の可能性があるため history を確認してください",
    );
  } else {
    log("ok", "同一 sessionId が複数の Claude transcript ファイルに重複するケースは検出されませんでした");
  }

  // Codex originator 内訳 + 未追跡件数(セッションディレクトリが無ければスキップ)。
  const sessionsRoot = join(codexHome(), "sessions");
  if (!existsSync(sessionsRoot)) {
    log("ok", "Codex セッションディレクトリが無いため originator 内訳・追跡漏れはスキップしました");
    return true;
  }

  let codexFiles: string[] = [];
  try {
    codexFiles = (await listCodexRollouts(sessionsRoot)).rollouts;
  } catch (err) {
    log("warn", `Codex rollout の列挙中にエラーが発生しました: ${errMessage(err)}`);
    return true;
  }

  const codexUntracked = codexFiles.filter((f) => !tracked.has(f)).length;
  log(
    "ok",
    `Codex rollout 追跡漏れ: ${codexUntracked}件(全 ${codexFiles.length}件中。未追跡分は ccc-notifier scan で回収できます)`,
  );

  const originatorCounts = new Map<string, number>();
  const sessionIdToFiles = new Map<string, Set<string>>();
  for (const f of codexFiles) {
    const line = await peekFirstJsonLine(f);
    const payload = isRecord(line?.payload) ? line!.payload : null;
    const originator = typeof payload?.originator === "string" ? payload.originator : "(unknown)";
    originatorCounts.set(originator, (originatorCounts.get(originator) ?? 0) + 1);
    // 実データの session_meta.payload のキーは id(session_id ではない)。
    // 将来 session_id へ戻る可能性に備えて両方を見る。
    const sid =
      typeof payload?.id === "string"
        ? payload.id
        : typeof payload?.session_id === "string"
          ? payload.session_id
          : null;
    if (sid !== null && sid.length > 0) {
      const set = sessionIdToFiles.get(sid) ?? new Set();
      set.add(f);
      sessionIdToFiles.set(sid, set);
    }
  }
  const originatorSummary = [...originatorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(" / ");
  log("ok", `Codex originator 内訳: ${originatorSummary.length > 0 ? originatorSummary : "(rollout なし)"}`);

  const dupCodex = [...sessionIdToFiles.values()].filter((files) => files.size > 1).length;
  if (dupCodex > 0) {
    log(
      "warn",
      `同一 session_id を持つ Codex rollout が複数ファイルにまたがっています(${dupCodex}件)。二重計上の可能性があるため history を確認してください`,
    );
  } else {
    log("ok", "同一 session_id が複数の Codex rollout ファイルに重複するケースは検出されませんでした");
  }

  return true;
}

// ---- 9. history.jsonl 内の完全重複ターン検知(同一 sessionId + ts が複数行) ----
//
// 同じ transcript を track(通常の増分)と ingest(scan / 便乗り取込)の双方が異なる範囲認識で
// 二重に取り込むと、同一 sessionId・同一 ts(そのターンの最終メッセージ時刻はカーソル位置に依らず
// 一意に決まる)を持つ行が history.jsonl に複数現れる。1ターンにつき1行が正しい状態であるため、
// これは強い二重計上シグナルとして扱う。apiCalls が大きく異なる(片方が全履歴分)場合は特に疑わしい。
function checkDuplicateHistoryTurns(): boolean {
  const turns = readTurns();
  const groups = new Map<string, TurnRecord[]>();
  // 一意キー(計上した呼び出しの集合から決まる)を持つレコードはキーで、
  // キーが無い旧レコードは sessionId + ts で束ねる。
  const byIngestKey = new Map<string, TurnRecord[]>();
  for (const rec of turns) {
    if (typeof rec.ingestKey === "string" && rec.ingestKey.length > 0) {
      const keyed = byIngestKey.get(rec.ingestKey) ?? [];
      keyed.push(rec);
      byIngestKey.set(rec.ingestKey, keyed);
    }
    if (!rec.sessionId || !rec.ts) continue;
    const key = `${rec.sessionId} ${rec.ts} ${rec.source ?? "claude"}`;
    const list = groups.get(key) ?? [];
    list.push(rec);
    groups.set(key, list);
  }

  const dupKeys = [...byIngestKey.entries()].filter(([, list]) => list.length > 1);
  if (dupKeys.length > 0) {
    const rows = dupKeys.reduce((sum, [, list]) => sum + list.length, 0);
    const sample = dupKeys
      .slice(0, 3)
      .map(([key, list]) => `${key.slice(0, 8)}…(${list[0].sessionId.slice(0, 8)}… apiCalls ${list.map((r) => r.apiCalls).join("/")})`);
    log(
      "warn",
      `history.jsonl に同一の取り込みキーを持つレコードが複数あります(${dupKeys.length}組・${rows}行)。` +
        `同じ API 呼び出しを二度計上しています。例: ${sample.join(", ")}`,
    );
  } else {
    log("ok", "history.jsonl に同一の取り込みキーを持つ重複レコードは検出されませんでした");
  }

  const dupGroups = [...groups.entries()].filter(([, list]) => list.length > 1);
  if (dupGroups.length === 0) {
    log("ok", "history.jsonl に同一 sessionId+ts の重複ターンは検出されませんでした");
    return true;
  }
  const totalDupRows = dupGroups.reduce((sum, [, list]) => sum + list.length, 0);
  const sample = dupGroups.slice(0, 3).map(([key, list]) => {
    const [sessionId] = key.split(" ");
    const apiCallsList = list.map((r) => r.apiCalls).join("/");
    return `${sessionId.slice(0, 8)}…(apiCalls ${apiCallsList})`;
  });
  log(
    "warn",
    `history.jsonl に同一 sessionId+ts の重複ターンを検出しました(${dupGroups.length}組・${totalDupRows}行)。` +
      `二重計上の可能性があります。例: ${sample.join(", ")}。history redact/clear での手動整理を検討してください`,
  );
  return true;
}

export async function runDoctor(): Promise<number> {
  const results: boolean[] = [];

  results.push(await safeRun("settings.json", () => checkHookRegistration()));
  // hook 登録セクションの直後・通知チェックより前に Codex ブロックを置く。
  let codexStopConfigured = false;
  results.push(await safeRun("codex", async () => {
    const result = await checkCodex();
    codexStopConfigured = result.stopConfigured;
    return result.ok;
  }));

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
  results.push(await safeRun("claude-recent-session", () => checkClaudeRecentSessionTotal(latestTranscript)));
  results.push(await safeRun("codex-recent-session", () => checkCodexRecentSessionTotal(codexStopConfigured)));
  results.push(await safeRun("desktop-scan", () => checkDesktopScan()));
  results.push(await safeRun("duplicate-history", () => Promise.resolve(checkDuplicateHistoryTurns())));

  const hasFailure = results.some((ok) => ok === false);
  return hasFailure ? 1 : 0;
}
