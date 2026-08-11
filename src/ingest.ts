// src/ingest.ts — hook 非依存の増分取り込み(ingest)共通処理。
//
// sweep(全リセット再構築)とは別物で、history / cursors を破壊しない追記型。
// 指定ルート群(Claude: claudeTranscriptRoots() / Codex: listCodexRollouts())の *.jsonl を
// 列挙し、mtime プリフィルタとカーソルで未処理増分があるファイルだけ既存の分割関数
// (Claude: splitIntoTurnDrafts / Codex: splitIntoCodexTurnDrafts)で取り込む。
// history.jsonl は1ターン1行なので、複数ターン分の増分は sweep と同じターン境界で分けて記録する。
// `cccn scan`(手動)と track への便乗り取込(hook 発火時ベストエフォート)の両方から使う。
//
// 存在しない/読めないルート・ファイルは黙ってスキップする(sweep の strictRead とは異なり、
// ここでの失敗は「取りこぼしを次回に持ち越す」だけで全体を止めない)。

import { promises as fsp, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { claudeTranscriptRoots, surfaceForClaudePath } from "./claude-roots";
import type { ClaudeTranscriptRoot } from "./claude-roots";
import { codexHome } from "./codex/env";
import { normalizeCodexOriginator } from "./codex/originator";
import { codexResumePointAtTs, scanCodexTurns } from "./codex/transcript";
import { listCodexRollouts } from "./codex/sessions";
import { waitForDataLock } from "./data-lock";
import { getUsdJpy } from "./fx";
import { notifyOS } from "./notify/os";
import { notifySlack } from "./notify/slack";
import { formatIngestSummary } from "./format";
import { computeCost, loadPriceTable } from "./pricing";
import {
  appendTurn,
  floorKey,
  isMuted,
  loadAllCursors,
  loadHistoryIndex,
  logError,
  paths,
  readConfig,
  readConfigReadOnly,
  saveAllCursors,
  sanitizeCursor,
} from "./store";
import type { FloorScope, HistoryIndex } from "./store";
import { anyOf, callFingerprints, messageKeyFilterOf, setCountedCalls } from "./counted-calls";
import type { MessageKeyFilter } from "./counted-calls";
import { attachSubagentGroups, splitIntoTurnDrafts } from "./sweep";
import type { TurnDraft } from "./sweep";
import { collectSubagentUsage } from "./subagents";
import type { SubagentUsage } from "./subagents";
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

async function fileMtimeMs(filePath: string): Promise<number> {
  return (await fsp.stat(filePath)).mtimeMs;
}

/**
 * Claude transcript の「変化したか」を表す値。親 transcript だけでなく
 * <transcript>/subagents/agent-*.jsonl も含めた最大 mtime を使う。
 * サブエージェントのログは親より遅れて作成・追記されるので、親の mtime だけを見ていると
 * 「親は変わっていない」と判定してサブエージェント分を恒久的に取りこぼす。
 */
async function claudeMtimeSignature(filePath: string): Promise<number> {
  let newest = (await fsp.stat(filePath)).mtimeMs;
  const dir = join(
    filePath.endsWith(".jsonl") ? filePath.slice(0, -".jsonl".length) : filePath,
    "subagents",
  );
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // サブエージェントディレクトリが無い(大多数)。読めない場合は判定材料が欠けるので伝播する。
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return newest;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("agent-") || !entry.name.endsWith(".jsonl")) continue;
    try {
      const m = (await fsp.stat(join(dir, entry.name))).mtimeMs;
      if (m > newest) newest = m;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err; // 走査中に消えた分だけ無視する
    }
  }
  return newest;
}

// ============ 既取り込み判定(history.jsonl 由来) ============
//
// カーソルは「どこまで読んだか」の目印であって、計上済みかどうかの真実源ではない。
// cursors.json の消失・リセット、sweep、transcript のパス変更、別マシンからの移行では
// 「history に記録済みなのにカーソルが無い」状態になる。そこで真実源を history 側に置く:
//
//  1. 計上済み呼び出しの指紋集合(TurnRecord.countedCalls)。ここに載っている呼び出しは
//     どの経路からでも再計上しない。親ターン分もサブエージェント分も同じ集合で扱う。
//  2. レコードの一意キー(TurnRecord.ingestKey)。同じキーのレコードは二度 append しない。
//  3. 指紋を持たない旧レコード向けのフォールバックとして、セッション別の ts 下限。
//     カーソルを持たないファイルを読み直すとき、この下限より前は計上済みとみなす。
//     サブエージェント用の下限は別に持つ(親ターンが記録済みでも、その時点で SA が
//     回収済みとは限らないため。下限は「subagents を持つ旧レコードの最後の ts」)。
//
// history.jsonl は数千行・数MBになるので、読み込みは ingest 1回につき最大1度・遅延実行
// (カーソルまたは指紋の突合が実際に必要になったときだけ)。全ファイルにカーソルがあり
// mtime も動いていない定常状態では1バイトも読まない。

/**
 * 記録済み ts を下限に持つ回収用カーソル。offset 0 = 先頭から読み直し、
 * aggregateNewTurn 側では「カーソルはあるが offset が無効」= rescan として扱われ、
 * lastTs 以前の行は集計から除外される(オフセットだけは EOF まで進む)。
 */
function recoveryCursor(floorTs: string): Cursor {
  return { offset: 0, lastUuid: null, lastTs: floorTs, seenMessageKeys: [] };
}

// ============ レコード化 ============

/** ターン下書き1件を history のレコードにする(history.jsonl は1ターン1行)。 */
function buildClaudeDraftRecord(
  draft: TurnDraft,
  ts: string,
  table: PriceTable,
  fx: FxResult,
  surface: Surface,
): TurnRecord {
  const main = draft.mainPerModel;
  const sidechain = draft.sidechainPerModel;
  const breakdown = computeCost(main, sidechain, table);
  const sidechainHasModels = Object.keys(sidechain).length > 0;
  const rec: TurnRecord = {
    schemaVersion: 1,
    ts,
    sessionId: draft.sessionId,
    project: draft.cwd ?? "",
    gitBranch: draft.gitBranch,
    models: collectModels(main, sidechain),
    tokens: sumBuckets(main),
    sidechainTokens: sidechainHasModels ? sumBuckets(sidechain) : null,
    apiCalls: draft.apiCalls,
    costUSD: breakdown.usd,
    costByModel: breakdown.byModel,
    costJPY: breakdown.usd * fx.rate,
    fxRate: fx.rate,
    fxSource: fx.source,
    prompt: draft.prompt,
    ingest: "scan",
    surface,
  };
  if (breakdown.unknownModels.length > 0) rec.unknownModels = breakdown.unknownModels;
  setCountedCalls(rec, callFingerprints(draft.messageKeys));
  return rec;
}

/** ドラフト群から transcript のセッション ID を取る(採り方は aggregateNewTurn と同じく最後の観測値)。 */
function sessionIdOfDrafts(drafts: TurnDraft[]): string {
  for (let i = drafts.length - 1; i >= 0; i--) {
    if (drafts[i].sessionId.length > 0) return drafts[i].sessionId;
  }
  return "";
}

/**
 * 新規ターンが1件も無い窓では上の関数がセッション ID を返せないので、ファイル名から補う。
 * Claude Code の transcript は `<projectDir>/<sessionId>.jsonl` に置かれる。
 */
function sessionIdFromTranscriptPath(filePath: string): string {
  const name = basename(filePath);
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
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
  setCountedCalls(rec, agg.codexEventKeys ?? []);
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
  /** 一意キーが history に既にあり append しなかったレコード数(冪等化が効いた件数)。 */
  skippedDuplicates: number;
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
    skippedDuplicates: 0,
    failures: 0,
    totalUSD: 0,
    totalJPY: 0,
    fxRate: fx.rate,
    fxSource: fx.source,
    bySurface: {},
  };
}

/** 合計はサブエージェント分を含む(取り込んだ金額そのもの = 通知しきい値の判定対象)。 */
function addRecord(result: IngestResult, rec: TurnRecord): void {
  const usd = rec.costUSD + (rec.subagents?.costUSD ?? 0);
  const jpy = rec.costJPY + (rec.subagents?.costUSD ?? 0) * rec.fxRate;
  result.records.push(rec);
  result.totalUSD += usd;
  result.totalJPY += jpy;
  const surface = rec.surface ?? "cli";
  const cur = result.bySurface[surface] ?? { turns: 0, usd: 0 };
  cur.turns += 1;
  cur.usd += usd;
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

  // history 由来の突合材料は ingest 1回につき最大1度だけ読む。
  let index: HistoryIndex | null = null;
  const historyIndex = (): HistoryIndex => (index ??= loadHistoryIndex());
  const recordedFloor = (scope: FloorScope, sessionId: string): string | null => {
    if (sessionId.length === 0) return null; // セッション不明のファイルは突合できない
    return historyIndex().legacyFloors.get(floorKey(scope, sessionId)) ?? null;
  };
  /** history に指紋として残っている呼び出しを弾く述語。 */
  const countedFilter = (): MessageKeyFilter => messageKeyFilterOf(historyIndex().countedCalls);

  /**
   * 取り込んだレコード群を history へ書き、カーソルを進める(1ターン1行)。
   * 記録が先・カーソルが後(track / sweep と同じ順序)。サブエージェント側のカーソルは
   * メインより後に進める(途中で落ちても次回 seenMessageKeys で重複排除される側に倒す)。
   */
  const commit = (
    filePath: string,
    records: TurnRecord[],
    newCursor: Cursor,
    subagentCursors: Array<{ path: string; cursor: Cursor }> = [],
  ): void => {
    // 同じ一意キーのレコードが既に history にあるなら append しない(append の冪等化)。
    // キーは計上した呼び出しの集合そのものから決まるので、カーソルがどう壊れていても効く。
    const fresh: TurnRecord[] = [];
    for (const rec of records) {
      const key = rec.ingestKey;
      if (key !== undefined && historyIndex().ingestKeys.has(key)) {
        result.skippedDuplicates += 1;
        continue;
      }
      if (key !== undefined) historyIndex().ingestKeys.add(key);
      for (const fp of rec.countedCalls ?? []) historyIndex().countedCalls.add(fp);
      fresh.push(rec);
    }
    if (!dryRun) {
      for (const rec of fresh) appendTurn(rec);
      cursorsDict[filePath] = newCursor;
      for (const nc of subagentCursors) cursorsDict[nc.path] = nc.cursor;
      cursorsChanged = true;
    }
    for (const rec of fresh) addRecord(result, rec);
  };

  /** aggregateNewTurn と同じカーソル意味論(ウィンドウが値を持たなければ前回値を保つ)に揃える。 */
  const carryCursor = (next: Cursor, prev: Cursor | null, floor: string | null): Cursor => ({
    ...next,
    lastUuid: next.lastUuid ?? prev?.lastUuid ?? null,
    lastTs: next.lastTs ?? prev?.lastTs ?? floor,
  });

  const processClaudeFile = async (filePath: string): Promise<void> => {
    const cursor = sanitizeCursor(cursorsDict[filePath]);
    // カーソルが無いファイルは history 側の記録済み ts を下限にして読み直す。
    // 下限の引き当てに sessionId が要るので、まず素の分割で sessionId を得る。
    // 計上済みの呼び出しは、カーソルの有無に関係なく history 由来の指紋で弾く。
    const counted = countedFilter();
    let split = await splitIntoTurnDrafts(filePath, cursor, { excludeMessageKeys: counted });
    if (split.unreadable === true) throw new Error(`transcript を読み込めませんでした: ${filePath}`);
    // sessionId は「下限で切る前」の分割から採る(下限適用後は0ターンになり得るため)。
    const sessionId = sessionIdOfDrafts(split.drafts) || sessionIdFromTranscriptPath(filePath);
    let floor: string | null = null;
    if (cursor === null) {
      // 指紋を持たない旧レコードぶんのフォールバック。
      floor = recordedFloor("claude", sessionId);
      if (floor !== null) {
        split = await splitIntoTurnDrafts(filePath, recoveryCursor(floor), { excludeMessageKeys: counted });
      }
    }
    const newCursor = carryCursor(split.newCursor, cursor, floor);
    const surface = surfaceForClaudePath(filePath, claudeRoots);
    const records = split.drafts.map((draft) =>
      buildClaudeDraftRecord(draft, draft.lastTs ?? new Date().toISOString(), table, fx, surface),
    );

    // サブエージェント(<transcript>/subagents/agent-*.jsonl)は親ターンへ合算する。
    // hook 経路(track)・sweep と同じ回収をしないと、取り込み経路によって同じセッションの
    // 金額が変わる。カーソルが無いときだけ、SA 用の下限で既記録分を除外する。
    // 二重計上は指紋で防ぐ。旧レコードぶんのフォールバックとして、カーソルを持たない
    // agent ファイルにだけ SA 用の下限を適用する(親カーソルの有無とは独立)。
    const saFloor = recordedFloor("claude-sa", sessionId);
    let sa: SubagentUsage | null = null;
    try {
      sa = await collectSubagentUsage(filePath, {
        excludeMessageKeys: anyOf([new Set(split.messageKeys), counted]),
        recovery: () => ({ minTimestampMs: saFloor === null ? null : Date.parse(saFloor) + 1 }),
        readCursor: (path) => sanitizeCursor(cursorsDict[path]),
      });
    } catch (err) {
      logError("ingest:subagents", err);
      sa = null;
    }
    if (sa !== null && sa.apiCalls > 0) {
      attachSubagentGroups(records, sa, table, fx, surface, "scan");
    }

    commit(filePath, records, newCursor, sa?.newCursors ?? []);
  };

  const processCodexFile = async (filePath: string): Promise<void> => {
    const cursor = sanitizeCursor(cursorsDict[filePath]);
    // 計上済みの token_count イベントは、カーソルの有無に関係なく指紋で弾く。
    // Codex 側は既に指紋そのものを渡してくるので、集合をそのまま述語に使う
    // (Claude 側の messageKey → 指紋の変換は挟まない)。
    const scanOpts = { excludeEvents: historyIndex().countedCalls };
    // 分割とカーソルは1回の走査から同時に得る。別々に読むと、片方だけ失敗したときに
    // 「usage を記録せずカーソルだけ進める」= その範囲の恒久的な取りこぼしになる。
    const scan = await scanCodexTurns(filePath, cursor, scanOpts);
    if (scan === null) throw new Error(`rollout を読み込めませんでした: ${filePath}`);
    const drafts = scan.drafts;
    if (drafts.length === 0) {
      // 新規 usage 無し。読み切った位置までカーソルだけ進める。
      commit(filePath, [], scan.newCursor);
      return;
    }
    const windowCursor = scan.newCursor;

    if (drafts[0].isSubagentRollout) {
      // Codex child rollout は利用記録のみで料金未集計という公開仕様に合わせる(sweep と同じ扱い)。
      // カーソルだけ進めて次回以降の再走査を避ける。
      commit(filePath, [], windowCursor);
      return;
    }
    if (cursor !== null) {
      commit(filePath, drafts.map((draft) => buildCodexRecord(draft.agg, table, fx)), windowCursor);
      return;
    }

    // カーソル不在: 記録済み ts があれば、そこまで消費した再開点から読み直す。
    // ウィンドウ全体は消費済みなので、新規ターンが無くてもカーソルは EOF まで進める。
    // (同じターンを再集計しても指紋が一致するので、commit 側でも重複は落ちる)
    // 指紋を持たない旧レコードぶんのフォールバック。
    const floor = recordedFloor("codex", drafts[0].agg.sessionId);
    const target =
      floor === null
        ? drafts
        : ((await scanCodexTurns(filePath, await codexResumePointAtTs(filePath, floor), scanOpts))?.drafts ?? []);
    commit(filePath, target.map((draft) => buildCodexRecord(draft.agg, table, fx)), windowCursor);
  };

  const runOver = async (
    files: string[],
    context: "ingest:claude" | "ingest:codex",
    handle: (filePath: string) => Promise<void>,
    signature: (filePath: string) => Promise<number> = fileMtimeMs,
  ): Promise<void> => {
    for (const filePath of files) {
      let mtimeMs: number;
      try {
        mtimeMs = await signature(filePath);
      } catch (err) {
        // 発見直後に消えた(ENOENT)なら次回の走査に委ねる。権限エラー等は失敗として数える
        // (黙って飛ばすと「走査したが0件」と区別できず、取りこぼしに気付けない)。
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          result.failures += 1;
          logError(context, err);
        }
        continue;
      }
      // mtime プリフィルタはカーソルがあるファイルにだけ効かせる。カーソルが無いファイルは
      // まだ取り込みが確定していない(sweep のリセット後・cursors.json の消失など)ので、
      // mtime が動いていなくても必ず走査して history 側と突合する。
      const cached = mtimeCache[filePath];
      if (cached !== undefined && cached >= mtimeMs && sanitizeCursor(cursorsDict[filePath]) !== null) {
        result.skippedByMtime += 1;
        continue;
      }
      result.scannedFiles += 1;
      try {
        await handle(filePath);
        // mtime を覚えるのは取り込みに成功したときだけ。失敗したファイルを次回スキップしてしまうと
        // 取りこぼしが持ち越されないまま消える。
        nextMtimeCache[filePath] = mtimeMs;
      } catch (err) {
        result.failures += 1;
        logError(context, err);
      }
    }
  };

  await runOver(claudeFiles, "ingest:claude", processClaudeFile, claudeMtimeSignature);
  await runOver(codexFiles, "ingest:codex", processCodexFile);

  if (!dryRun) {
    if (cursorsChanged) saveAllCursors(cursorsDict);
    saveIngestMtimeCache(nextMtimeCache);
  }

  return result;
}

/**
 * scan(手動)/ track 便乗り取込が新規に取り込んだターン群の合計が minNotifyUSD 以上のとき、
 * 1通にまとめて通知する(サーフェス・件数・合計 USD/JPY を表記)。ミュート設定を尊重する。
 * 対象は今回新たに history へ追記したターンだけなので、hook 経由の既存ターン単位通知と
 * 重ならない(二重通知にならない)。
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
