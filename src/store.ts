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
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Config, Cursor, DEFAULT_CONFIG, TurnRecord } from "./types";

export interface AcnPaths {
  home: string;
  configFile: string;
  historyFile: string;
  cursorsFile: string;
  cacheDir: string;
  errorLog: string;
  lastNotifyFile: string;
}

const ERROR_LOG_MAX_BYTES = 1024 * 1024; // 1MB

/**
 * データディレクトリ配下の各パスを返す。
 * - ACN_HOME は呼び出しのたびに評価する(モジュールロード時に固定しない)。
 * - home / cacheDir はここで冪等に mkdirSync(recursive) しておく。
 */
export function paths(): AcnPaths {
  const home = process.env.ACN_HOME || join(homedir(), ".agent-cost-notifier");
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
  if (isPlainObject(partial.dashboard)) {
    if ("autoRegenerate" in partial.dashboard) {
      result.dashboard.autoRegenerate = partial.dashboard.autoRegenerate as boolean;
    }
    if ("autoReloadSec" in partial.dashboard) {
      result.dashboard.autoReloadSec = partial.dashboard.autoReloadSec as number;
    }
    if ("days" in partial.dashboard) {
      result.dashboard.days = partial.dashboard.days as number;
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
  const { offset, lastUuid, lastTs, seenMessageKeys } = raw;
  if (typeof offset !== "number" || !Number.isFinite(offset)) return null;
  if (lastUuid !== null && typeof lastUuid !== "string") return null;
  if (lastTs !== null && typeof lastTs !== "string") return null;
  if (!Array.isArray(seenMessageKeys)) return null;
  const keys: string[] = [];
  for (const key of seenMessageKeys) {
    if (typeof key !== "string") return null;
    keys.push(key);
  }
  return { offset, lastUuid, lastTs, seenMessageKeys: keys };
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
