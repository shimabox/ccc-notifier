// src/store.ts (T4) — ローカル永続化(config / cursor / history / error log)
//
// 契約: src/contracts.md の "src/store.ts (T4)" セクション参照。
// history readerはCodex activityのruntime projectionもpure mergeする。

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
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { Config, Cursor, DEFAULT_CONFIG, TurnRecord } from "./types";
import { projectCodexSubagentActivity, readCodexSubagentActivity } from "./codex/subagent-store";

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
 * ccc-notifier のデータ home を副作用なしで解決する。
 * 存在確認だけをしたい呼び出し側のため、ディレクトリは作成しない。
 */
export function dataHomePath(): string {
  return process.env.CCCN_HOME || join(homedir(), ".ccc-notifier");
}

/** config.json のパスを副作用なしで解決する。 */
export function configFilePath(): string {
  return join(dataHomePath(), "config.json");
}

/**
 * データディレクトリ配下の各パスを返す。
 * - CCCN_HOME は呼び出しのたびに評価する(モジュールロード時に固定しない)。
 * - home / cacheDir はここで冪等に mkdirSync(recursive) しておく。
 */
export function paths(): CccnPaths {
  const home = dataHomePath();
  const cacheDir = join(home, "cache");
  mkdirSync(home, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  return {
    home,
    configFile: configFilePath(),
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

/**
 * dry-run等、診断ログを含む永続ファイルを変更できない経路向けのconfig reader。
 * 読み込み/parse失敗は呼び出し元へ通知し、通常readConfigと同じDEFAULT_CONFIGへ倒す。
 */
export function readConfigReadOnly(onError?: (err: unknown) => void): Config {
  const file = configFilePath();
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    onError?.(err);
    return structuredClone(DEFAULT_CONFIG);
  }

  try {
    return mergeConfig(JSON.parse(raw) as unknown);
  } catch (err) {
    onError?.(err);
    return structuredClone(DEFAULT_CONFIG);
  }
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
 * cursors.json に登録済みの全パス(キー)を返す(doctor の追跡漏れ検知用)。
 * 不在/破損時は空 Set(loadCursor と同じ規則: 破損時のみ logError)。
 */
export function cursorPaths(): Set<string> {
  const p = paths();
  if (!existsSync(p.cursorsFile)) return new Set();
  try {
    const parsed: unknown = JSON.parse(readFileSync(p.cursorsFile, "utf8"));
    if (!isPlainObject(parsed)) return new Set();
    return new Set(Object.keys(parsed));
  } catch (err) {
    logError("cursorPaths", err);
    return new Set();
  }
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
  const { offset, lastUuid, lastTs, seenMessageKeys, codexTotals, codexOriginator, codexModel } = raw;
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

  // codexOriginator / codexModel は string|null のときのみ採用する
  // (Claude 側カーソルには常にこれらのキーが存在しない)。
  if (Object.hasOwn(raw, "codexOriginator")) {
    if (codexOriginator === null || typeof codexOriginator === "string") {
      cursor.codexOriginator = codexOriginator;
    }
  }
  if (Object.hasOwn(raw, "codexModel")) {
    if (codexModel === null || typeof codexModel === "string") {
      cursor.codexModel = codexModel;
    }
  }

  return cursor;
}

/**
 * cursors.json 全体を1回の読み込みで返す(生の辞書。値は sanitizeCursor に通す前)。
 * ingest(src/ingest.ts)のように多数のファイルのカーソルをまとめて参照する呼び出し元向け。
 * 呼び出し元は同じ data lock を保持したまま読み → 処理 → saveAllCursors で1回だけ書き戻すこと。
 * 不在 → 空辞書。壊れている → logError して空辞書(loadCursor と同じ規則)。
 */
export function loadAllCursors(): Record<string, unknown> {
  const p = paths();
  if (!existsSync(p.cursorsFile)) return {};
  try {
    const raw = readFileSync(p.cursorsFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      logError("loadAllCursors", new Error("cursors.json root is not an object"));
      return {};
    }
    return parsed;
  } catch (err) {
    logError("loadAllCursors", err);
    return {};
  }
}

/**
 * cursors.json 全体を1回の書き込みで置換する(loadAllCursors とペアで使う)。
 * 呼び出しごとに一意な tmp ファイルへ書いて renameSync することで原子的に置換する。
 */
export function saveAllCursors(dict: Record<string, unknown>): void {
  const p = paths();
  const tmpFile = `${p.cursorsFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpFile, JSON.stringify(dict), "utf8");
    renameSync(tmpFile, p.cursorsFile);
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

/**
 * cursors.json に transcriptPath -> Cursor を保存する。
 * 読み込み→更新→一意な tmp ファイルに書いて renameSync することで原子的に置換する。
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

  const tmpFile = `${p.cursorsFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpFile, JSON.stringify(dict), "utf8");
    renameSync(tmpFile, p.cursorsFile);
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

/**
 * 「append したがカーソル保存がまだ済んでいない」ことを示すマーカー。
 *
 * append と saveCursor は原子的に行えないので、その間で落ちるとカーソルだけが古いまま残る。
 * カーソルが古いと、次回は同じ範囲を読み直して既計上の呼び出しを再び計上してしまう。
 * マーカーは append の「前」に置き、カーソル保存が全部済んでから消す。したがって
 *
 *   マーカーが無い = 直前の append はカーソルに反映済み
 *
 * が常に成り立つ。マーカーがあるときだけ history と突合すればよく、健全時は history を読まない。
 * 判定を「直近何件」「何バイト」といった窓に頼らないので、間に何件 append されようと破れない。
 * 逆に「マーカーがあるが実際には append 前に落ちていた」場合は、history に指紋が無いので
 * 除外は起きず、そのターンは通常どおり記録される(取りこぼさない側に倒れる)。
 *
 * transcript パスごとに持つ(別セッションの hook がマーカーを消し合わないため)。
 */
export function pendingAppendPath(): string {
  return join(paths().cacheDir, "pending-append.json");
}

function readPendingAppends(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pendingAppendPath(), "utf8"));
    return isPlainObject(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {}; // 不在・破損 → 保留なし
  }
}

function writePendingAppends(dict: Record<string, string>): void {
  const file = pendingAppendPath();
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(dict), "utf8");
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 対象 transcript に「カーソル未反映かもしれない append」が残っているか。 */
export function hasPendingAppend(transcriptPath: string): boolean {
  return Object.hasOwn(readPendingAppends(), transcriptPath);
}

/** append の直前に置く。失敗しても append 自体は続行する(throw しない)。 */
export function markPendingAppend(transcriptPath: string, ingestKey: string): void {
  try {
    const dict = readPendingAppends();
    dict[transcriptPath] = ingestKey;
    writePendingAppends(dict);
  } catch (err) {
    logError("markPendingAppend", err);
  }
}

/** カーソル保存まで済んだ後に消す。消せなくても次回 history を読むだけで実害はない。 */
export function clearPendingAppend(transcriptPath: string): void {
  try {
    const dict = readPendingAppends();
    if (!Object.hasOwn(dict, transcriptPath)) return;
    delete dict[transcriptPath];
    writePendingAppends(dict);
  } catch (err) {
    logError("clearPendingAppend", err);
  }
}

/**
 * history.jsonl に1ターン分のレコードを追記する。
 */
export function appendTurn(record: TurnRecord): void {
  const p = paths();
  // subagentActivityはcanonical台帳から毎回導出するruntime-only値。呼び出し側から渡されても保存しない。
  const { subagentActivity: _runtimeActivity, ...persisted } = record;
  appendFileSync(p.historyFile, JSON.stringify(persisted) + "\n", "utf8");
}

/**
 * sweepの全再生成用に、再生成対象だけを空に戻す。
 * config/cache/mute/通知状態/Codex activity は意図的に触らず、backup も作らない。
 */
export function resetHistoryAndCursors(): void {
  const p = paths();
  rmSync(p.historyFile, { force: true });
  rmSync(p.cursorsFile, { force: true });
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

    // runtime-only値はhistory内の保存値を信用せず、canonical台帳からだけ再構築する。
    delete rec.subagentActivity;
    result.push(rec);
  }

  const keyedRecords = result.filter(
    (rec) => rec.source === "codex" && typeof rec.activityProjectionKey === "string" &&
      /^[a-f0-9]{64}$/.test(rec.activityProjectionKey),
  );
  if (keyedRecords.length === 0) return result;

  // 台帳は1 readにつき一度だけ読む。破損時は[]へfail-closedする。
  const byProjection = new Map<string, ReturnType<typeof readCodexSubagentActivity>>();
  for (const state of readCodexSubagentActivity()) {
    const states = byProjection.get(state.projectionKey) ?? [];
    states.push(state);
    byProjection.set(state.projectionKey, states);
  }
  for (const rec of keyedRecords) {
    const activity = projectCodexSubagentActivity(byProjection.get(rec.activityProjectionKey!) ?? []);
    if (activity !== undefined) rec.subagentActivity = activity;
  }
  return result;
}

/** claude / codex = メインターン、claude-sa = サブエージェント分を含むターン。 */
export type FloorScope = "claude" | "codex" | "claude-sa";

export function floorKey(scope: FloorScope, sessionId: string): string {
  return `${scope}\u0000${sessionId}`;
}

export interface HistoryIndex {
  /** 計上済み呼び出しの指紋。 */
  countedCalls: Set<string>;
  /** 既に history にあるレコードの一意キー。 */
  ingestKeys: Set<string>;
  /** 指紋を持たない旧レコードだけから作った ts 下限(scope + sessionId → 正規化 ISO)。 */
  legacyFloors: Map<string, string>;
}

export function loadHistoryIndex(): HistoryIndex {
  const index: HistoryIndex = { countedCalls: new Set(), ingestKeys: new Set(), legacyFloors: new Map() };
  let raw: string;
  try {
    raw = readFileSync(paths().historyFile, "utf8");
  } catch {
    return index; // 履歴不在(初回)。すべて未取り込みとして扱うのが正しい
  }
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let rec: {
      sessionId?: unknown;
      ts?: unknown;
      source?: unknown;
      subagents?: unknown;
      countedCalls?: unknown;
      ingestKey?: unknown;
    };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue; // 破損行は黙殺(readTurns と同じ規則)
    }

    let hasFingerprints = false;
    if (Array.isArray(rec.countedCalls)) {
      for (const fp of rec.countedCalls) {
        if (typeof fp === "string" && fp.length > 0) {
          index.countedCalls.add(fp);
          hasFingerprints = true;
        }
      }
    }
    if (typeof rec.ingestKey === "string" && rec.ingestKey.length > 0) index.ingestKeys.add(rec.ingestKey);

    // 指紋を持つレコードは指紋で正確に突合できるので、下限(粗い近似)には寄与させない。
    if (hasFingerprints) continue;

    const { sessionId, ts } = rec;
    if (typeof sessionId !== "string" || sessionId.length === 0) continue;
    if (typeof ts !== "string") continue;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) continue;
    // transcript 側の ts と文字列比較するため、表記ゆれで大小が狂わないよう正規化して持つ。
    const iso = new Date(ms).toISOString();
    const isCodex = rec.source === "codex";
    const scopes: FloorScope[] = isCodex ? ["codex"] : ["claude"];
    if (!isCodex && rec.subagents !== undefined && rec.subagents !== null) scopes.push("claude-sa");
    for (const scope of scopes) {
      const key = floorKey(scope, sessionId);
      const cur = index.legacyFloors.get(key);
      if (cur === undefined || cur < iso) index.legacyFloors.set(key, iso);
    }
  }
  return index;
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
