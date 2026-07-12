// src/store.ts (T4) — ローカル永続化(config / cursor / history / error log)
//
// 契約: src/contracts.md の "src/store.ts (T4)" セクション参照。
// import は ./types と Node 組み込みのみ。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Config, Cursor, DEFAULT_CONFIG, TurnRecord } from "./types";

export interface CccnPaths {
  home: string;
  configFile: string;
  historyFile: string;
  cursorsFile: string;
  cacheDir: string;
  errorLog: string;
  lastNotifyFile: string;
  muteFile: string;
  recentDashboardFile: string;
  fullDashboardFile: string;
  dashboardFullStateFile: string;
  dataLockDir: string;
  dataReclaimDir: string;
}

const ERROR_LOG_MAX_BYTES = 1024 * 1024; // 1MB

/**
 * データディレクトリ配下の各パスを返す。
 * - CCCN_HOME は呼び出しのたびに評価する(モジュールロード時に固定しない)。
 * - home / cacheDir はここで冪等に mkdirSync(recursive) しておく。
 */
export function paths(): CccnPaths {
  const home = process.env.CCCN_HOME || join(homedir(), ".ccc-notifier");
  const cacheDir = join(home, "cache");
  mkdirSync(home, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  return {
    home,
    configFile: join(home, "config.json"),
    historyFile: join(home, "history.jsonl"),
    cursorsFile: join(home, "cursors.json"),
    cacheDir,
    errorLog: join(home, "error.log"),
    lastNotifyFile: join(home, "last-notify.json"),
    muteFile: join(home, "muted.json"),
    recentDashboardFile: join(home, "report.html"),
    fullDashboardFile: join(home, "report-all.html"),
    dashboardFullStateFile: join(cacheDir, "dashboard-full-state.json"),
    dataLockDir: join(cacheDir, "data.lock"),
    dataReclaimDir: join(cacheDir, "data.lock.reclaim"),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * DEFAULT_CONFIG に対して既知キーのみを深いマージする。
 * - 欠損キーはデフォルト補完
 * - 存在するキーはユーザー値優先
 * - notify.slack はキーさえ存在すれば null であってもユーザー値として尊重する
 */
function mergeConfig(partial: unknown): Config {
  const result = structuredClone(DEFAULT_CONFIG);
  if (!isPlainObject(partial)) return result;

  if (isPlainObject(partial.notify)) {
    if ("os" in partial.notify) {
      result.notify.os = partial.notify.os as boolean;
    }
    if ("slack" in partial.notify) {
      result.notify.slack = partial.notify.slack as Config["notify"]["slack"];
    }
  }
  if ("minNotifyUSD" in partial) {
    result.minNotifyUSD = partial.minNotifyUSD as number;
  }
  if ("costLabel" in partial) {
    result.costLabel = partial.costLabel as Config["costLabel"];
  }
  if (isPlainObject(partial.fx)) {
    if ("fallbackRate" in partial.fx) {
      result.fx.fallbackRate = partial.fx.fallbackRate as number;
    }
    if ("cacheHours" in partial.fx) {
      result.fx.cacheHours = partial.fx.cacheHours as number;
    }
  }
  if ("includeDailyTotal" in partial) {
    result.includeDailyTotal = partial.includeDailyTotal as boolean;
  }
  if ("monthlyBudgetUSD" in partial) {
    // 0 以上の有限数のみ採用(割り算・表示に使うため異常値はデフォルト 0 に倒す)。
    const b = partial.monthlyBudgetUSD;
    if (typeof b === "number" && Number.isFinite(b) && b >= 0) {
      result.monthlyBudgetUSD = b;
    }
  }
  if (isPlainObject(partial.dashboard)) {
    if ("autoRegenerate" in partial.dashboard) {
      result.dashboard.autoRegenerate = partial.dashboard.autoRegenerate as boolean;
    }
    if ("autoReloadSec" in partial.dashboard) {
      result.dashboard.autoReloadSec = partial.dashboard.autoReloadSec as number;
    }
    if ("days" in partial.dashboard) {
      // 自動生成の履歴読み込みに使うため、正の有限整数だけを採用する。
      // 異常値は DEFAULT_CONFIG の 30 日に倒し、全履歴の意図しない読み込みを防ぐ。
      const days = partial.dashboard.days;
      if (typeof days === "number" && Number.isFinite(days) && Number.isInteger(days) && days > 0) {
        result.dashboard.days = days;
      }
    }
  }
  return result;
}

/**
 * config.json を読む。
 * - 不在 → DEFAULT_CONFIG のディープコピー(エラーログなし)
 * - 読み込み/パース失敗 → logError して DEFAULT_CONFIG のディープコピー
 *   (ユーザーのファイルを勝手に修復・上書きすることはしない)
 * - 部分的な config → 既知キーの深いマージ
 */
export function readConfig(): Config {
  const p = paths();
  if (!existsSync(p.configFile)) {
    return structuredClone(DEFAULT_CONFIG);
  }

  let raw: string;
  try {
    raw = readFileSync(p.configFile, "utf8");
  } catch (err) {
    logError("readConfig", err);
    return structuredClone(DEFAULT_CONFIG);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logError("readConfig", err);
    return structuredClone(DEFAULT_CONFIG);
  }

  return mergeConfig(parsed);
}

// ---- 通知ミュート(muted.json) ----
//
// `cccn mute` / `cccn unmute` が管理する通知の一時停止状態。抑止するのは OS/Slack 通知のみで、
// 履歴の記録・ダッシュボード再生成は止めない。config.json とは独立のマーカーファイルにする
// ことで、ユーザーの config を CLI が書き換えない方針(readConfig のコメント参照)を保つ。

/** muted.json の中身。until が null なら無期限、ISO 文字列なら期限付きミュート。 */
export interface MuteState {
  until: string | null;
}

/**
 * muted.json を読む。ファイル不在 → null(ミュートなし)。
 * 読み込み失敗・形が不正・until がパース不能な場合も null に倒す
 * (壊れたファイルのせいで通知が止まりっぱなしになる事故を防ぐ側)。
 */
export function readMuteState(): MuteState | null {
  const p = paths();
  if (!existsSync(p.muteFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p.muteFile, "utf8")) as unknown;
    if (!isPlainObject(parsed) || !("until" in parsed)) return null;
    const until = parsed.until;
    if (until === null) return { until: null };
    if (typeof until === "string" && !Number.isNaN(new Date(until).getTime())) {
      return { until };
    }
    return null;
  } catch (err) {
    logError("readMuteState", err);
    return null;
  }
}

/** 現在ミュート中か。期限付きミュートは until を過ぎていたら false(ファイルは消さない)。 */
export function isMuted(now: Date = new Date()): boolean {
  const state = readMuteState();
  if (state === null) return false;
  if (state.until === null) return true;
  return new Date(state.until).getTime() > now.getTime();
}

export function writeMuteState(state: MuteState): void {
  writeFileSync(paths().muteFile, `${JSON.stringify(state)}\n`, "utf8");
}

export function clearMuteState(): void {
  rmSync(paths().muteFile, { force: true });
}

/**
 * cursors.json ( { [transcriptPath]: Cursor } ) から特定 transcript のカーソルを読む。
 * - ファイル不在 / transcript 未登録 → null(エラーログなし)
 * - 破損(読み込み失敗 or JSON パース失敗 or ルートがオブジェクトでない) → logError して null
 */
export function loadCursor(transcriptPath: string): Cursor | null {
  const p = paths();
  if (!existsSync(p.cursorsFile)) return null;

  let raw: string;
  try {
    raw = readFileSync(p.cursorsFile, "utf8");
  } catch (err) {
    logError("loadCursor", err);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logError("loadCursor", err);
    return null;
  }

  if (!isPlainObject(parsed)) {
    logError("loadCursor", new Error("cursors.json root is not an object"));
    return null;
  }

  const cursor = parsed[transcriptPath];
  return (cursor as Cursor | undefined) ?? null;
}

/**
 * loadCursor の戻り値を「形全体」で検証する。
 * cursors.json は理論上手で編集されうるため、文字列だけの seenMessageKeys フィルタでは足りない。
 * offset が有限数値 / lastUuid が string|null / lastTs が string|null / seenMessageKeys が string 配列 —
 * この形でなければ(部分的な不正も含め)全体を null に落とす。null なら以降はフルリスキャン
 * ではなく「新規読み込み」になり、二重計上は aggregateNewTurn 内の重複排除に委ねられる。
 * track.ts / subagents.ts の双方から使うため store.ts の export として持つ。
 */
export function sanitizeCursor(raw: unknown): Cursor | null {
  if (!isPlainObject(raw)) return null;
  const { offset, lastUuid, lastTs, seenMessageKeys, codexTotals } = raw;
  if (typeof offset !== "number" || !Number.isFinite(offset)) return null;
  if (lastUuid !== null && typeof lastUuid !== "string") return null;
  if (lastTs !== null && typeof lastTs !== "string") return null;
  if (!Array.isArray(seenMessageKeys)) return null;
  const keys: string[] = [];
  for (const key of seenMessageKeys) {
    if (typeof key !== "string") return null;
    keys.push(key);
  }

  const cursor: Cursor = { offset, lastUuid, lastTs, seenMessageKeys: keys };

  // codexTotals は input/cached/output の3キーすべてが有限な非負 number のときのみ採用する。
  // 不正(欠損・型不一致・負数・非有限)ならフィールドごと undefined に落とす — cursor 全体は
  // 無効にしない(Claude 側カーソルには常にこのキーが存在しないため)。
  if (isPlainObject(codexTotals)) {
    const { input, cached, output } = codexTotals;
    if (
      typeof input === "number" && Number.isFinite(input) && input >= 0 &&
      typeof cached === "number" && Number.isFinite(cached) && cached >= 0 &&
      typeof output === "number" && Number.isFinite(output) && output >= 0
    ) {
      cursor.codexTotals = { input, cached, output };
    }
  }

  return cursor;
}

/**
 * cursors.json に transcriptPath -> Cursor を保存する。
 * 読み込み→更新→ cursors.json.tmp に書いて renameSync することで原子的に置換する。
 * 既存 cursors.json が壊れている場合は(復旧不能なため)空辞書から作り直す。
 */
export function saveCursor(transcriptPath: string, c: Cursor): void {
  const p = paths();

  let dict: Record<string, Cursor> = {};
  if (existsSync(p.cursorsFile)) {
    try {
      const raw = readFileSync(p.cursorsFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed)) {
        dict = parsed as Record<string, Cursor>;
      }
    } catch (err) {
      logError("saveCursor", err);
    }
  }

  dict[transcriptPath] = c;

  const tmpFile = `${p.cursorsFile}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(dict), "utf8");
  renameSync(tmpFile, p.cursorsFile);
}

/**
 * history.jsonl に1ターン分のレコードを追記する。
 */
export function appendTurn(record: TurnRecord): void {
  const p = paths();
  appendFileSync(p.historyFile, JSON.stringify(record) + "\n", "utf8");
}

/**
 * history.jsonl を読む。
 * - 不在 → 空配列
 * - 破損行はスキップして黙殺(logError しない)
 * - days 指定時は ts >= (now - days*86400000) の行のみ返す
 */
export function readTurns(days?: number): TurnRecord[] {
  const p = paths();
  if (!existsSync(p.historyFile)) return [];

  let raw: string;
  try {
    raw = readFileSync(p.historyFile, "utf8");
  } catch {
    return [];
  }

  const cutoff = typeof days === "number" ? Date.now() - days * 86400000 : null;
  const result: TurnRecord[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let rec: TurnRecord;
    try {
      rec = JSON.parse(trimmed) as TurnRecord;
    } catch {
      continue; // 破損行は黙殺
    }

    if (cutoff !== null) {
      const ts = Date.parse(rec.ts);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
    }

    result.push(rec);
  }

  return result;
}

/**
 * ローカルタイムゾーンで「今日」に該当する TurnRecord の costUSD 合計。
 */
export function todayTotalUSD(): number {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  let total = 0;
  for (const rec of readTurns()) {
    const ts = new Date(rec.ts);
    if (Number.isNaN(ts.getTime())) continue;
    if (ts.getFullYear() === y && ts.getMonth() === m && ts.getDate() === d) {
      total += rec.costUSD;
    }
  }
  return total;
}

/**
 * ローカルタイムゾーンで「今月(暦月)」に該当する TurnRecord の合計(サブエージェント込みの総額)。
 * 月予算に対する使用率の算出に使う。
 */
export function currentMonthTotals(): { usd: number; jpy: number; turns: number } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  let usd = 0;
  let jpy = 0;
  let turns = 0;
  for (const rec of readTurns()) {
    const ts = new Date(rec.ts);
    if (Number.isNaN(ts.getTime())) continue;
    if (ts.getFullYear() === y && ts.getMonth() === m) {
      const sa = rec.subagents?.costUSD ?? 0;
      usd += rec.costUSD + sa;
      jpy += rec.costJPY + sa * rec.fxRate;
      turns += 1;
    }
  }
  return { usd, jpy, turns };
}

/**
 * error.log にエラーを追記する。
 * - 形式: `[ISO時刻] [context] メッセージ` + 改行 + (あれば) stack + 改行
 * - 追記前に error.log が 1MB を超えていれば error.log.old へ renameSync してからロー
 *   テーションする(既存 .old は上書き)
 * - 自身は決して throw しない
 */
export function logError(context: string, err: unknown): void {
  try {
    const p = paths();
    const iso = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    let entry = `[${iso}] [${context}] ${message}\n`;
    if (stack) {
      entry += `${stack}\n`;
    }

    try {
      const stat = statSync(p.errorLog);
      if (stat.size > ERROR_LOG_MAX_BYTES) {
        renameSync(p.errorLog, `${p.errorLog}.old`);
      }
    } catch {
      // error.log がまだ存在しない場合はローテーション不要
    }

    appendFileSync(p.errorLog, entry, "utf8");
  } catch {
    // logError 自身は決して throw しない
  }
}
