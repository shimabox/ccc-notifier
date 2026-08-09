// src/ingest.ts — hook 非依存の増分取り込み(ingest)共通処理。
//
// sweep(全リセット再構築)とは別物で、history / cursors を破壊しない追記型。
// 指定ルート群(Claude: claudeTranscriptRoots() / Codex: listCodexRollouts())の *.jsonl を
// 列挙し、mtime プリフィルタとカーソルで未処理増分があるファイルだけ既存の集計関数
// (Claude: aggregateNewTurn / Codex: aggregateCodexTurn)で取り込む。
// `cccn scan`(手動)と track への便乗り取込(hook 発火時ベストエフォート)の両方から使う。
//
// 存在しない/読めないルート・ファイルは黙ってスキップする(sweep の strictRead とは異なり、
// ここでの失敗は「取りこぼしを次回に持ち越す」だけで全体を止めない)。

import { promises as fsp, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeTranscriptRoots, surfaceForClaudePath } from "./claude-roots";
import type { ClaudeTranscriptRoot } from "./claude-roots";
import { codexHome } from "./codex/env";
import { normalizeCodexOriginator } from "./codex/originator";
import { aggregateCodexTurn, splitIntoCodexTurnDrafts } from "./codex/transcript";
import { listCodexRollouts } from "./codex/sessions";
import { waitForDataLock } from "./data-lock";
import { getUsdJpy } from "./fx";
import { notifyOS } from "./notify/os";
import { notifySlack } from "./notify/slack";
import { formatIngestSummary } from "./format";
import { computeCost, loadPriceTable } from "./pricing";
import {
  appendTurn,
  isMuted,
  loadAllCursors,
  logError,
  paths,
  readConfig,
  readConfigReadOnly,
  saveAllCursors,
  sanitizeCursor,
} from "./store";
import { aggregateNewTurn } from "./transcript";
import type {
  Config,
  Cursor,
  FxResult,
  PriceTable,
  Surface,
  TokenBuckets,
  TurnAggregate,
  TurnRecord,
  UsageByModel,
} from "./types";

// ============ 小ヘルパー(sweep.ts / track.ts と同一規則をローカルに複製) ============

function emptyBuckets(): TokenBuckets {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function sumBuckets(usage: UsageByModel): TokenBuckets {
  const total = emptyBuckets();
  for (const b of Object.values(usage)) {
    total.input += b.input;
    total.output += b.output;
    total.cacheWrite5m += b.cacheWrite5m;
    total.cacheWrite1h += b.cacheWrite1h;
    total.cacheRead += b.cacheRead;
  }
  return total;
}

function collectModels(main: UsageByModel, sidechain: UsageByModel): string[] {
  const models: string[] = [];
  for (const m of Object.keys(main)) if (!models.includes(m)) models.push(m);
  for (const m of Object.keys(sidechain)) if (!models.includes(m)) models.push(m);
  return models;
}

// ============ 発見(ルート・ファイル列挙。すべてベストエフォート) ============

async function listProjectDirsBestEffort(root: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

async function listTranscriptsBestEffort(projectDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(projectDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => join(projectDir, e.name));
  } catch {
    return [];
  }
}

async function discoverClaudeFiles(roots: ClaudeTranscriptRoot[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    for (const dir of await listProjectDirsBestEffort(root.path)) {
      files.push(...(await listTranscriptsBestEffort(dir)));
    }
  }
  return files;
}

async function discoverCodexFiles(): Promise<string[]> {
  const sessionsRoot = join(codexHome(), "sessions");
  try {
    const stat = await fsp.lstat(sessionsRoot);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }
  try {
    const discovery = await listCodexRollouts(sessionsRoot);
    return discovery.rollouts;
  } catch {
    return [];
  }
}

// ============ mtime プリフィルタ用キャッシュ(cacheDir 配下。純粋に高速化目的で正しさには影響しない) ============

type IngestMtimeCache = Record<string, number>;

function ingestMtimeCachePath(): string {
  return join(paths().cacheDir, "ingest-mtimes.json");
}

function loadIngestMtimeCache(): IngestMtimeCache {
  try {
    const raw = readFileSync(ingestMtimeCachePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as IngestMtimeCache;
    }
  } catch {
    // 不在・破損はキャッシュ無し(= 全ファイルを読みにいく)から始める。正しさには影響しない。
  }
  return {};
}

function saveIngestMtimeCache(cache: IngestMtimeCache): void {
  try {
    const file = ingestMtimeCachePath();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), "utf8");
    renameSync(tmp, file);
  } catch {
    // ベストエフォートのキャッシュ。書き込み失敗は次回の効率が落ちるだけで正しさには影響しない。
  }
}

// ============ 既取り込み判定(history.jsonl 由来のセッション別 ts 下限) ============
//
// カーソルは「どこまで読んだか」の目印であって、取り込み済みかどうかの真実源ではない。
// cursors.json の消失・リセット、sweep、transcript のパス変更、別マシンからの移行などで
// 「history には記録済みなのにカーソルだけ無い」ファイルが生まれる。カーソル不在のときの
// 集計はファイル先頭から全体を読むため、この状態では記録済みのターンを丸ごと再 append する。
//
// そこで history 側の「そのセッションで記録済みの最後の ts」を下限として持ち、カーソル不在の
// ファイルはその下限より後だけを取り込む。history.jsonl は数千行・数MBになるため、読み込みは
// 遅延1回(カーソル不在のファイルが実際に集計結果を出したときだけ)に限る。定常状態
// (全ファイルにカーソルがある / mtime プリフィルタで落ちる)では1バイトも読まない。

/** key = source + sessionId、value = そのセッションで記録済みの最後の ts(正規化 ISO)。 */
type HistoryFloors = Map<string, string>;

function floorKey(source: "claude" | "codex", sessionId: string): string {
  return `${source}\u0000${sessionId}`;
}

function loadHistorySessionFloors(): HistoryFloors {
  const floors: HistoryFloors = new Map();
  let raw: string;
  try {
    raw = readFileSync(paths().historyFile, "utf8");
  } catch {
    return floors; // 履歴不在(初回)。すべて未取り込みとして扱うのが正しい
  }
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let rec: { sessionId?: unknown; ts?: unknown; source?: unknown };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue; // 破損行は黙殺(readTurns と同じ規則)
    }
    const { sessionId, ts } = rec;
    if (typeof sessionId !== "string" || sessionId.length === 0) continue;
    if (typeof ts !== "string") continue;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) continue;
    // transcript 側の ts と文字列比較するため、表記ゆれで大小が狂わないよう正規化して持つ。
    const iso = new Date(ms).toISOString();
    const key = floorKey(rec.source === "codex" ? "codex" : "claude", sessionId);
    const cur = floors.get(key);
    if (cur === undefined || cur < iso) floors.set(key, iso);
  }
  return floors;
}

/**
 * 記録済み ts を下限に持つ回収用カーソル。offset 0 = 先頭から読み直し、
 * aggregateNewTurn 側では「カーソルはあるが offset が無効」= rescan として扱われ、
 * lastTs 以前の行は集計から除外される(オフセットだけは EOF まで進む)。
 */
function recoveryCursor(floorTs: string): Cursor {
  return { offset: 0, lastUuid: null, lastTs: floorTs, seenMessageKeys: [] };
}

// ============ レコード化 ============

function buildClaudeRecord(agg: TurnAggregate, table: PriceTable, fx: FxResult, surface: Surface): TurnRecord {
  const main = agg.main;
  const sidechain = agg.sidechain;
  const breakdown = computeCost(main, sidechain, table);
  const sidechainHasModels = Object.keys(sidechain).length > 0;
  const rec: TurnRecord = {
    schemaVersion: 1,
    ts: agg.lastTs ?? new Date().toISOString(),
    sessionId: agg.sessionId,
    project: agg.cwd ?? "",
    gitBranch: agg.gitBranch,
    models: collectModels(main, sidechain),
    tokens: sumBuckets(main),
    sidechainTokens: sidechainHasModels ? sumBuckets(sidechain) : null,
    apiCalls: agg.apiCalls,
    costUSD: breakdown.usd,
    costByModel: breakdown.byModel,
    costJPY: breakdown.usd * fx.rate,
    fxRate: fx.rate,
    fxSource: fx.source,
    prompt: agg.prompt ?? "",
    ingest: "scan",
    surface,
  };
  if (breakdown.unknownModels.length > 0) rec.unknownModels = breakdown.unknownModels;
  return rec;
}

function buildCodexRecord(agg: TurnAggregate, table: PriceTable, fx: FxResult): TurnRecord {
  const main = agg.main;
  const breakdown = computeCost(main, {}, table);
  const surface = normalizeCodexOriginator(agg.originator);
  const rec: TurnRecord = {
    schemaVersion: 1,
    ts: agg.lastTs ?? new Date().toISOString(),
    sessionId: agg.sessionId,
    project: agg.cwd ?? "",
    gitBranch: null,
    models: collectModels(main, {}),
    tokens: sumBuckets(main),
    sidechainTokens: null,
    apiCalls: agg.apiCalls,
    costUSD: breakdown.usd,
    costByModel: breakdown.byModel,
    costJPY: breakdown.usd * fx.rate,
    fxRate: fx.rate,
    fxSource: fx.source,
    prompt: agg.prompt ?? "",
    ingest: "scan",
    source: "codex",
    surface,
  };
  if (typeof agg.originator === "string") rec.originator = agg.originator;
  if (breakdown.unknownModels.length > 0) rec.unknownModels = breakdown.unknownModels;
  return rec;
}

// ============ 公開 API ============

export interface IngestOptions {
  dryRun: boolean;
  /** 単価表をキャッシュのみで読むか(既定 true = 便乗り取込向けの軽量パス)。手動 scan は false 推奨。 */
  offlinePricing?: boolean;
  cfg?: Config;
  claudeRoots?: ClaudeTranscriptRoot[];
  /** Codex rollout も走査するか(既定 true)。 */
  includeCodex?: boolean;
}

export interface IngestSurfaceTotal {
  turns: number;
  usd: number;
}

export interface IngestResult {
  dryRun: boolean;
  /** !dryRun のとき data lock を取得できたか。false の場合、走査結果はすべて次回に持ち越し(0件)。 */
  lockAcquired: boolean;
  records: TurnRecord[];
  scannedFiles: number;
  skippedByMtime: number;
  failures: number;
  totalUSD: number;
  totalJPY: number;
  fxRate: number;
  fxSource: FxResult["source"];
  bySurface: Partial<Record<Surface, IngestSurfaceTotal>>;
}

function emptyResult(dryRun: boolean, fx: FxResult, lockAcquired: boolean): IngestResult {
  return {
    dryRun,
    lockAcquired,
    records: [],
    scannedFiles: 0,
    skippedByMtime: 0,
    failures: 0,
    totalUSD: 0,
    totalJPY: 0,
    fxRate: fx.rate,
    fxSource: fx.source,
    bySurface: {},
  };
}

function addRecord(result: IngestResult, rec: TurnRecord): void {
  result.records.push(rec);
  result.totalUSD += rec.costUSD;
  result.totalJPY += rec.costJPY;
  const surface = rec.surface ?? "cli";
  const cur = result.bySurface[surface] ?? { turns: 0, usd: 0 };
  cur.turns += 1;
  cur.usd += rec.costUSD;
  result.bySurface[surface] = cur;
}

/**
 * mtime プリフィルタとカーソルで未処理増分があるファイルだけを取り込む。
 * dryRun のときは appendTurn / saveCursor / mtime キャッシュ更新のいずれも行わない(read-only・lock 不要)。
 * 設定・単価表・為替・ルート決定・ファイル列挙は data lock の外で準備する(track.ts と同じ流儀)。
 * lock は実際に history / cursors / mtime キャッシュを書き込む区間だけを囲み、
 * 呼び出し元(track.ts の便乗り取込・cccn scan)が別途ロックを取る必要はない。
 */
export async function runIngest(opts: IngestOptions): Promise<IngestResult> {
  const dryRun = opts.dryRun;
  const cfg = opts.cfg ?? (dryRun ? readConfigReadOnly() : readConfig());
  const cacheDir = paths().cacheDir;
  const table = await loadPriceTable(cacheDir, { offline: opts.offlinePricing ?? true });
  const fx = await getUsdJpy(cfg, cacheDir);
  const claudeRoots = opts.claudeRoots ?? (await claudeTranscriptRoots());
  const includeCodex = opts.includeCodex ?? true;

  const claudeFiles = await discoverClaudeFiles(claudeRoots);
  const codexFiles = includeCodex ? await discoverCodexFiles() : [];

  if (dryRun) {
    return await processFiles(claudeFiles, codexFiles, claudeRoots, table, fx, true);
  }

  const lock = await waitForDataLock(1000);
  if (lock === null) {
    logError("ingest", new Error("data lock timeout; ingest skipped this cycle"));
    return emptyResult(false, fx, false);
  }
  try {
    return await processFiles(claudeFiles, codexFiles, claudeRoots, table, fx, false);
  } finally {
    lock.release();
  }
}

async function processFiles(
  claudeFiles: string[],
  codexFiles: string[],
  claudeRoots: ClaudeTranscriptRoot[],
  table: PriceTable,
  fx: FxResult,
  dryRun: boolean,
): Promise<IngestResult> {
  const mtimeCache = loadIngestMtimeCache();
  const nextMtimeCache: IngestMtimeCache = { ...mtimeCache };
  const result = emptyResult(dryRun, fx, true);

  // cursors.json は1回だけ読み、この呼び出しが保持している data lock の間だけメモリ上で更新し、
  // 最後に1回だけ書き戻す。
  const cursorsDict = loadAllCursors();
  let cursorsChanged = false;

  let floors: HistoryFloors | null = null;
  const recordedFloor = (source: "claude" | "codex", sessionId: string): string | null => {
    if (sessionId.length === 0) return null; // セッション不明のファイルは突合できない
    floors ??= loadHistorySessionFloors();
    return floors.get(floorKey(source, sessionId)) ?? null;
  };

  for (const filePath of claudeFiles) {
    let mtimeMs: number;
    try {
      mtimeMs = (await fsp.stat(filePath)).mtimeMs;
    } catch {
      continue; // 発見直後に消えた等。次回の走査に委ねる
    }
    const cached = mtimeCache[filePath];
    if (cached !== undefined && cached >= mtimeMs) {
      result.skippedByMtime += 1;
      continue;
    }
    result.scannedFiles += 1;
    nextMtimeCache[filePath] = mtimeMs;
    try {
      const cursor = sanitizeCursor(cursorsDict[filePath]);
      let agg = await aggregateNewTurn(filePath, cursor);
      if (agg === null) continue;
      if (cursor === null) {
        const floor = recordedFloor("claude", agg.sessionId);
        if (floor !== null) {
          const consumed = agg.newCursor;
          agg = await aggregateNewTurn(filePath, recoveryCursor(floor));
          if (agg === null) {
            // 記録済み分しか無いファイル。カーソルだけ EOF まで進めて次回から増分読みに戻す。
            if (!dryRun) {
              cursorsDict[filePath] = consumed;
              cursorsChanged = true;
            }
            continue;
          }
        }
      }
      const surface = surfaceForClaudePath(filePath, claudeRoots);
      const rec = buildClaudeRecord(agg, table, fx, surface);
      if (!dryRun) {
        appendTurn(rec);
        cursorsDict[filePath] = agg.newCursor;
        cursorsChanged = true;
      }
      addRecord(result, rec);
    } catch (err) {
      result.failures += 1;
      logError("ingest:claude", err);
    }
  }

  for (const filePath of codexFiles) {
    let mtimeMs: number;
    try {
      mtimeMs = (await fsp.stat(filePath)).mtimeMs;
    } catch {
      continue;
    }
    const cached = mtimeCache[filePath];
    if (cached !== undefined && cached >= mtimeMs) {
      result.skippedByMtime += 1;
      continue;
    }
    result.scannedFiles += 1;
    nextMtimeCache[filePath] = mtimeMs;
    try {
      const cursor = sanitizeCursor(cursorsDict[filePath]);
      const agg = await aggregateCodexTurn(filePath, cursor);
      if (agg === null) continue;
      if (agg.isSubagentRollout === true) {
        // Codex child rollout は利用記録のみで料金未集計という公開仕様に合わせる(sweep と同じ扱い)。
        // カーソルだけ進めて次回以降の再走査を避ける。
        if (!dryRun) {
          cursorsDict[filePath] = agg.newCursor;
          cursorsChanged = true;
        }
        continue;
      }
      const floor = cursor === null ? recordedFloor("codex", agg.sessionId) : null;
      if (floor !== null) {
        // rollout は累積カウンタの差分方式で集計するため、Claude のように ts 下限だけを渡して
        // 読み直すことはできない(スキップした行のカウンタを取りこぼすと、次の差分が累積全量に
        // なって大幅な過大計上になる)。task_complete 境界でターンに割ってから、記録済みより
        // 後に「始まった」ターンだけを採る。rollout は hook がターンを記録した後にも同じターンの
        // 行が追記されるため、記録済み ts は分割後のターン終端より僅かに手前になる。終端で
        // 比べると同一ターンを新規と誤判定するので、開始時刻で判定する。下限をまたぐターンは
        // 一部が記録済みなので採らない(取りこぼしより二重計上を避ける)。
        // カーソルはウィンドウ全体を消費した位置まで進める。
        const drafts = await splitIntoCodexTurnDrafts(filePath, null);
        if (!dryRun) {
          cursorsDict[filePath] = agg.newCursor;
          cursorsChanged = true;
        }
        const floorMs = Date.parse(floor);
        for (const draft of drafts ?? []) {
          const startMs = draft.agg.firstTs === null ? NaN : Date.parse(draft.agg.firstTs);
          if (!Number.isFinite(startMs) || startMs <= floorMs) continue;
          const rec = buildCodexRecord(draft.agg, table, fx);
          if (!dryRun) appendTurn(rec);
          addRecord(result, rec);
        }
        continue;
      }
      const rec = buildCodexRecord(agg, table, fx);
      if (!dryRun) {
        appendTurn(rec);
        cursorsDict[filePath] = agg.newCursor;
        cursorsChanged = true;
      }
      addRecord(result, rec);
    } catch (err) {
      result.failures += 1;
      logError("ingest:codex", err);
    }
  }

  if (!dryRun) {
    if (cursorsChanged) saveAllCursors(cursorsDict);
    saveIngestMtimeCache(nextMtimeCache);
  }

  return result;
}

/**
 * scan(手動)/ track 便乗り取込が新規に取り込んだターン群の合計が minNotifyUSD 以上のとき、
 * 1通にまとめて通知する(サーフェス・件数・合計 USD/JPY を表記)。ミュート設定を尊重する。
 * カーソルが真実源であるため、既に取り込み済みのファイルは agg===null で自然に除外され、
 * hook 経由の既存ターン単位通知と対象が重ならない(二重通知にならない)。
 */
export async function notifyIngestSummary(result: IngestResult, cfg: Config): Promise<void> {
  if (result.dryRun) return;
  if (result.records.length === 0) return;
  if (!(cfg.notify.os || cfg.notify.slack)) return;
  if (result.totalUSD < cfg.minNotifyUSD) return;
  if (isMuted()) return;

  const bySurface: Record<string, { turns: number; usd: number }> = {};
  for (const [surface, v] of Object.entries(result.bySurface)) {
    if (v) bySurface[surface] = v;
  }
  const summary = formatIngestSummary(
    { recordCount: result.records.length, totalUSD: result.totalUSD, totalJPY: result.totalJPY, bySurface },
    cfg,
  );

  const record: TurnRecord = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    sessionId: "ingest-scan",
    project: "",
    gitBranch: null,
    models: [],
    tokens: emptyBuckets(),
    sidechainTokens: null,
    apiCalls: 0,
    costUSD: result.totalUSD,
    costJPY: result.totalJPY,
    fxRate: result.fxRate,
    fxSource: result.fxSource,
    prompt: "",
  };

  await Promise.allSettled([
    notifyOS(record, cfg, undefined, summary),
    notifySlack(record, cfg, undefined, summary),
  ]);
}
