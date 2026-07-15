// src/sweep.ts — 手元のClaude/Codex JSONLから履歴を全再生成する。
//
// 契約: src/contracts.md の "src/sweep.ts(2026-07-07 追加)" 参照。
//
// hook(track)のタイミングに依存せず、~/.claude/projects 配下の全 transcript(メイン +
// subagents/)とCodex rolloutを先頭から走査し、**ターン単位に復元**して履歴へ取り込む。
// パース規約は transcript.ts の aggregateNewTurn を1ミリも違えず踏襲する
// (extractBucket / promptCandidate を再利用し、開始位置・改行終端・破損行スキップ・rescan ガード・
//  去重・コンテキスト採取の各規則をコードレベルで同一にする)。
//
// 通常実行は既存履歴とカーソルをresetして全件を書き直し、dry-runは同じ先頭走査をread-onlyで行う。
// 生成したnewCursorはhookと互換なので、sweep後に追記された末尾は後続hookが回収できる。

import { readFile } from "node:fs/promises";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { extractBucket, promptCandidate } from "./transcript";
import { computeCost, loadPriceTable } from "./pricing";
import { getUsdJpy } from "./fx";
import {
  appendTurn,
  loadCursor,
  logError,
  paths,
  readConfig,
  readConfigReadOnly,
  readTurns,
  resetHistoryAndCursors,
  sanitizeCursor,
  saveCursor,
} from "./store";
import { collectSubagentUsage } from "./subagents";
import type { SubagentUsage } from "./subagents";
import { codexHome } from "./codex/env";
import { splitIntoCodexTurnDrafts } from "./codex/transcript";
import type { CodexTurnDraft } from "./codex/transcript";
import { listCodexRollouts } from "./codex/sessions";
import type { CodexRolloutDiscovery } from "./codex/sessions";
import { formatJPY, formatUSD, modelDisplayName } from "./format";
import type { Cursor, FxResult, PriceTable, TokenBuckets, TurnRecord, UsageByModel } from "./types";
import { waitForDataLock, type DataLockHandle } from "./data-lock";
import { writeDashboardHtml } from "./dashboard";
import {
  invalidateCanonicalDashboards,
  makeFullDashboardState,
  writeFullDashboardStateAtomic,
} from "./dashboard-state";

type SweepLockProvider = () => Promise<DataLockHandle | null>;

// aggregateNewTurn と同一の定数(挙動を1ミリも違えないため）。
const NEWLINE = 0x0a; // '\n'
const MAX_SEEN_KEYS = 500;
const SYNTHETIC_MODEL = "<synthetic>";
const DAY_MS = 86_400_000;
const SWEEP_PROGRESS_INTERVAL = 25;

type SweepProgressEvent =
  | { type: "preparing"; dryRun: boolean }
  | { type: "lock" }
  | { type: "scan-start"; claudeProjects: number; codexRollouts: number }
  | {
      type: "source-progress";
      source: "claude" | "codex";
      completed: number;
      total: number;
    }
  | {
      type: "scan-complete";
      claudeTranscripts: number;
      codexRollouts: number;
      records: number;
      failures: number;
    }
  | { type: "dashboard-start" };

type SweepProgressReporter = (event: SweepProgressEvent) => void;

/**
 * 長いsweepが停止して見えないよう、改行区切りの簡素な進捗だけを表示する。
 * source名やpathは受け取らず、件数以外の利用データを出力しない。
 */
function createSweepProgressReporter(): SweepProgressReporter {
  const lastSourceCount: Partial<Record<"claude" | "codex", number>> = {};
  return (event): void => {
    if (event.type === "preparing") {
      console.log(`準備: 単価表・為替を読み込みます${event.dryRun ? " (dry-run)" : ""}`);
      return;
    }
    if (event.type === "lock") {
      console.log("lock: 取得を待っています");
      return;
    }
    if (event.type === "scan-start") {
      console.log(
        `走査開始: Claude project ${event.claudeProjects} / Codex rollout ${event.codexRollouts}`,
      );
      return;
    }
    if (event.type === "source-progress") {
      if (event.completed <= 0 || event.total <= 0) return;
      if (event.completed % SWEEP_PROGRESS_INTERVAL !== 0) return;
      if (lastSourceCount[event.source] === event.completed) return;
      lastSourceCount[event.source] = event.completed;
      const label = event.source === "claude" ? "Claude transcript" : "Codex rollout";
      console.log(`走査進捗: ${label} ${event.completed}/${event.total}`);
      return;
    }
    if (event.type === "scan-complete") {
      console.log(
        `走査完了: Claude transcript ${event.claudeTranscripts} / Codex rollout ${event.codexRollouts} / 対象 ${event.records} ターン / 失敗 ${event.failures}`,
      );
      return;
    }
    console.log("dashboard: 生成開始");
  };
}

export interface SweepSummary {
  projects: number;
  transcripts: number;
  agentFiles: number;
  newRecords: number;
  totalUSD: number;
  totalJPY: number;
  subagentsUSD: number; // SA 回収額(別枠)。totalUSD / byModel はメイン基準のまま(SA を含めない)
  byModel: Record<string, number>;
  codexRecords: number; // Codex 由来の取り込みターン数(サマリの Codex 行用)。newRecords / totalUSD / byModel にも含める
  codexUSD: number; // Codex 由来の取り込み額(同上・Codex 行の別枠表示用)
  dryRun: boolean;
  sourceFailures: number;
}

// splitIntoTurnDrafts が返す「1ターン分」の下書き。TurnRecord 化は draftToRecord が行う。
export interface TurnDraft {
  prompt: string;
  mainPerModel: UsageByModel;
  sidechainPerModel: UsageByModel;
  apiCalls: number;
  firstTs: string | null;
  lastTs: string | null;
  cwd: string | null;
  gitBranch: string | null;
  sessionId: string;
}

// ============ 小ヘルパー(transcript.ts / track.ts と同一規則をローカルに複製) ============

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function emptyBuckets(): TokenBuckets {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function addToModel(target: UsageByModel, model: string, b: TokenBuckets): void {
  const cur = target[model] ?? emptyBuckets();
  cur.input += b.input;
  cur.output += b.output;
  cur.cacheWrite5m += b.cacheWrite5m;
  cur.cacheWrite1h += b.cacheWrite1h;
  cur.cacheRead += b.cacheRead;
  target[model] = cur;
}

/** UsageByModel の全モデルを 1 つの TokenBuckets に合算する(track.ts の sumBuckets と同一)。 */
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

function addToBuckets(target: TokenBuckets, src: TokenBuckets): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheWrite5m += src.cacheWrite5m;
  target.cacheWrite1h += src.cacheWrite1h;
  target.cacheRead += src.cacheRead;
}

/** main のモデル → sidechain のみに現れるモデル の順で重複排除(contracts.md / track.ts と同一)。 */
function collectModels(main: UsageByModel, sidechain: UsageByModel): string[] {
  const models: string[] = [];
  for (const m of Object.keys(main)) if (!models.includes(m)) models.push(m);
  for (const m of Object.keys(sidechain)) if (!models.includes(m)) models.push(m);
  return models;
}

// ============ ターン分割読み ============

interface PendingMsg {
  model: string;
  isSidechain: boolean;
  bucket: TokenBuckets;
}

interface TurnBuffer {
  prompt: string | null;
  pending: Map<string, PendingMsg>;
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
}

function newBuffer(): TurnBuffer {
  return {
    prompt: null,
    pending: new Map(),
    sessionId: "",
    cwd: null,
    gitBranch: null,
    firstTs: null,
    lastTs: null,
  };
}

async function readAll(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null; // 読めないファイルはスキップ(呼び出し側で空扱い)
  }
}

/**
 * transcript を「実ユーザープロンプト行」をターン境界にして分割し、各ターンの下書きを返す。
 *
 * 開始位置・改行終端でない最終行の不処理・破損行スキップ・rescan 時の tsFloor / seenMessageKeys
 * ガード・message.id+requestId の去重・コンテキスト採取は、すべて aggregateNewTurn と同一規則。
 * 戻り値の newCursor は同一ウィンドウに対する aggregateNewTurn の newCursor と互換。
 *
 * ターン境界の規則:
 *  - 「実ユーザープロンプト行」= type==="user" && isSidechain!==true && promptCandidate が非 null
 *    && trim 後が非空 && "<" 始まりでない。
 *  - 境界に達したら、それまでのバッファに assistant usage が1件以上あればターンとして flush してから
 *    新しいバッファを開始し、そのプロンプトを新ターンのプロンプトにする。
 *  - 窓の先頭からの assistant 群(先行プロンプトなし)は prompt="" の1ターンとして扱う。
 */
export async function splitIntoTurnDrafts(
  transcriptPath: string,
  cursor: Cursor | null,
): Promise<{ drafts: TurnDraft[]; newCursor: Cursor; messageKeys: string[] }> {
  const buffer = await readAll(transcriptPath);
  if (buffer === null) {
    // 読めない場合は何も消費しない(既存カーソルがあればそのまま、無ければゼロ)。
    const nc: Cursor = cursor ?? { offset: 0, lastUuid: null, lastTs: null, seenMessageKeys: [] };
    return { drafts: [], newCursor: nc, messageKeys: [] };
  }
  const fileSize = buffer.length;

  // 開始位置と rescan 判定(aggregateNewTurn と同一)。
  let startOffset: number;
  let rescan: boolean;
  if (
    cursor !== null &&
    cursor.offset > 0 &&
    cursor.offset <= fileSize &&
    buffer[cursor.offset - 1] === NEWLINE
  ) {
    startOffset = cursor.offset;
    rescan = false;
  } else {
    startOffset = 0;
    rescan = cursor !== null;
  }

  const priorSeen = new Set<string>(cursor?.seenMessageKeys ?? []); // グローバル seen(過去に計上済み)
  const tsFloor = cursor?.lastTs ?? null;

  const drafts: TurnDraft[] = [];
  const runSeen = new Set<string>(); // 実行中 seen(flush 済みターンが計上したキー)
  const newKeys: string[] = []; // 初出順(カーソルのリングバッファ用)
  let winLastUuid: string | null = null; // ウィンドウ全体の最終 uuid(aggregateNewTurn と同一に null 始点)
  let winLastTs: string | null = null; // ウィンドウ全体の最大 ts

  let cur = newBuffer();

  const flush = (): void => {
    if (cur.pending.size === 0) return; // assistant usage が無いバッファはターンにしない
    const mainPerModel: UsageByModel = {};
    const sidechainPerModel: UsageByModel = {};
    for (const [key, pm] of cur.pending) {
      runSeen.add(key);
      newKeys.push(key);
      if (pm.isSidechain) addToModel(sidechainPerModel, pm.model, pm.bucket);
      else addToModel(mainPerModel, pm.model, pm.bucket);
    }
    drafts.push({
      prompt: cur.prompt ?? "",
      mainPerModel,
      sidechainPerModel,
      apiCalls: cur.pending.size,
      firstTs: cur.firstTs,
      lastTs: cur.lastTs,
      cwd: cur.cwd,
      gitBranch: cur.gitBranch,
      sessionId: cur.sessionId,
    });
  };

  const handleLine = (raw: string): void => {
    if (raw.trim().length === 0) return; // 空行
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return; // 破損 JSON は1行スキップ
    }
    if (!isRecord(obj)) return;

    const ts = strOrNull(obj.timestamp);
    // rescan ガード #1(タイムスタンプ下限）: 既計上済みの行はスキップ。
    if (rescan && tsFloor !== null && ts !== null && ts <= tsFloor) return;

    const isSide = obj.isSidechain === true;
    const type = obj.type;
    const message = isRecord(obj.message) ? obj.message : null;

    // 実ユーザープロンプト行の検出(= ターン境界)。規則は aggregateNewTurn の prompt 抽出と同一。
    let isBoundary = false;
    let boundaryPrompt = "";
    if (type === "user" && !isSide && message !== null) {
      const cand = promptCandidate(message.content);
      if (cand !== null) {
        const t = cand.trim();
        if (t.length > 0 && !t.startsWith("<")) {
          isBoundary = true;
          boundaryPrompt = t;
        }
      }
    }

    if (isBoundary) {
      flush();
      cur = newBuffer();
      cur.prompt = boundaryPrompt;
    }

    // コンテキスト(ターン内で採取。採り方は aggregateNewTurn と同一で、境界行は新ターンに属する)。
    const sid = strOrNull(obj.sessionId);
    if (sid !== null) cur.sessionId = sid;
    if (!isSide) {
      const c = strOrNull(obj.cwd);
      if (c !== null) cur.cwd = c;
      const gb = strOrNull(obj.gitBranch);
      if (gb !== null) cur.gitBranch = gb;
    }
    if (ts !== null) {
      if (cur.firstTs === null || ts < cur.firstTs) cur.firstTs = ts;
      if (cur.lastTs === null || ts > cur.lastTs) cur.lastTs = ts;
      if (winLastTs === null || ts > winLastTs) winLastTs = ts;
    }
    const uuid = strOrNull(obj.uuid);
    if (uuid !== null) winLastUuid = uuid;

    // assistant usage の計上(去重は message.id + requestId）。
    if (type === "assistant" && message !== null) {
      const usage = message.usage;
      if (isRecord(usage)) {
        const rawModel = message.model;
        if (rawModel !== SYNTHETIC_MODEL) {
          const id = strOrNull(message.id) ?? "";
          const reqId = strOrNull(obj.requestId) ?? "";
          const key = `${id}:${reqId}`;
          // priorSeen(過去計上)/ runSeen(別ターンで計上済み)は再計上しない。
          // 同一ターン内の重複行は Map の上書き(last-write-wins)で aggregateNewTurn と一致。
          if (!priorSeen.has(key) && !runSeen.has(key)) {
            const model = strOrNull(rawModel) ?? "unknown";
            cur.pending.set(key, { model, isSidechain: isSide, bucket: extractBucket(usage) });
          }
        }
      }
    }
  };

  // 改行終端の行のみ処理する(未終端の最終行は次回に回す）。newOffset の算出も aggregateNewTurn と同一。
  let lineStart = startOffset;
  for (let pos = startOffset; pos < fileSize; pos++) {
    if (buffer[pos] !== NEWLINE) continue;
    handleLine(buffer.toString("utf8", lineStart, pos));
    lineStart = pos + 1;
  }
  const newOffset = lineStart;

  // 末尾のターンを flush する。
  flush();

  // リングバッファ(過去キー + 今回の新規キー、新しい方を残す）。aggregateNewTurn と同一。
  const combined = [...(cursor?.seenMessageKeys ?? []), ...newKeys];
  const seenMessageKeys =
    combined.length > MAX_SEEN_KEYS ? combined.slice(combined.length - MAX_SEEN_KEYS) : combined;

  const newCursor: Cursor = {
    offset: newOffset,
    lastUuid: winLastUuid,
    lastTs: winLastTs,
    seenMessageKeys,
  };

  return { drafts, newCursor, messageKeys: newKeys };
}

// ============ レコード化 ============

function draftToRecord(draft: TurnDraft, ts: string, table: PriceTable, fx: FxResult): TurnRecord {
  const breakdown = computeCost(draft.mainPerModel, draft.sidechainPerModel, table);
  const sidechainHasModels = Object.keys(draft.sidechainPerModel).length > 0;

  const rec: TurnRecord = {
    schemaVersion: 1,
    ts,
    sessionId: draft.sessionId,
    project: draft.cwd ?? "",
    gitBranch: draft.gitBranch,
    models: collectModels(draft.mainPerModel, draft.sidechainPerModel),
    tokens: sumBuckets(draft.mainPerModel),
    sidechainTokens: sidechainHasModels ? sumBuckets(draft.sidechainPerModel) : null,
    apiCalls: draft.apiCalls,
    costUSD: breakdown.usd,
    costByModel: breakdown.byModel,
    costJPY: breakdown.usd * fx.rate, // 円換算は sweep 実行時レート
    fxRate: fx.rate,
    fxSource: fx.source,
    prompt: draft.prompt,
    ingest: "sweep",
  };
  if (breakdown.unknownModels.length > 0) rec.unknownModels = breakdown.unknownModels;
  return rec;
}

function mergeUnknownModels(rec: TurnRecord, extra: string[]): void {
  if (extra.length === 0) return;
  const merged = rec.unknownModels ? [...rec.unknownModels] : [];
  for (const m of extra) if (!merged.includes(m)) merged.push(m);
  rec.unknownModels = merged;
}

// ============ 1 transcript の処理 ============

async function processTranscriptLocked(
  mainPath: string,
  table: PriceTable,
  fx: FxResult,
  daysCutoff: number | null,
  dryRun: boolean,
  summary: SweepSummary,
  opts: { ignoreCursors?: boolean; strictRead?: boolean } = {},
): Promise<void> {
  if (opts.strictRead) {
    const file = await fsp.open(mainPath, "r");
    await file.close();
  }
  const cursor = opts.ignoreCursors ? null : sanitizeCursor(loadCursor(mainPath));
  const { drafts, newCursor, messageKeys } = await splitIntoTurnDrafts(mainPath, cursor);

  // 各 draft → TurnRecord(--days より古いターンは捨てる。カーソルは進めるので再走査しない）。
  const records: TurnRecord[] = [];
  for (const draft of drafts) {
    const ts = draft.lastTs ?? new Date().toISOString();
    if (daysCutoff !== null) {
      const tsMs = Date.parse(ts);
      if (!Number.isFinite(tsMs) || tsMs < daysCutoff) continue; // 古い → 捨てる
    }
    records.push(draftToRecord(draft, ts, table, fx));
  }

  // サブエージェント回収。
  let sa: SubagentUsage | null = null;
  try {
    sa = await collectSubagentUsage(mainPath, {
      ignoreCursors: opts.ignoreCursors,
      strictRead: opts.strictRead,
      includeAllFiles: opts.ignoreCursors,
      excludeMessageKeys: new Set(messageKeys),
      minTimestampMs: daysCutoff,
    });
  } catch (err) {
    if (opts.strictRead) throw err;
    logError("sweep:subagents", err);
    sa = null;
  }
  const saHasUsage = sa !== null && sa.apiCalls > 0;
  if (saHasUsage) {
    // Each agent file is kept as a time-bearing group. Attach it to the first
    // parent turn that completes at/after the agent, rather than assigning the
    // whole session to its last turn. --days filtering already happened while
    // parsing each assistant row, so old and recent agent costs are not mixed.
    const parentRecords = [...records];
    for (const group of sa!.groups) {
      const saBreakdown = computeCost(group.perModel, {}, table);
      summary.subagentsUSD += saBreakdown.usd;
      const saBlock: NonNullable<TurnRecord["subagents"]> = {
        costUSD: saBreakdown.usd,
        costByModel: { ...saBreakdown.byModel },
        tokens: sumBuckets(group.perModel),
        apiCalls: group.apiCalls,
        agentFiles: 1,
      };

      const groupMs = group.lastTs === null ? NaN : Date.parse(group.lastTs);
      let target = Number.isFinite(groupMs)
        ? parentRecords.find((rec) => {
            const recMs = Date.parse(rec.ts);
            return Number.isFinite(recMs) && recMs >= groupMs;
          })
        : undefined;
      target ??= parentRecords[parentRecords.length - 1];

      if (target === undefined) {
        target = {
          schemaVersion: 1,
          ts: group.lastTs ?? sa!.lastTs ?? new Date().toISOString(),
          sessionId: sa!.sessionId,
          project: sa!.cwd ?? "",
          gitBranch: sa!.gitBranch,
          models: collectModels(group.perModel, {}),
          tokens: emptyBuckets(),
          sidechainTokens: null,
          apiCalls: 0,
          costUSD: 0,
          costByModel: {},
          costJPY: 0,
          fxRate: fx.rate,
          fxSource: fx.source,
          prompt: "",
          ingest: "sweep",
        };
        records.push(target);
      }

      if (target.subagents === undefined) {
        target.subagents = saBlock;
      } else {
        target.subagents.costUSD += saBlock.costUSD;
        target.subagents.apiCalls += saBlock.apiCalls;
        target.subagents.agentFiles += 1;
        addToBuckets(target.subagents.tokens, saBlock.tokens);
        for (const [model, usd] of Object.entries(saBlock.costByModel)) {
          target.subagents.costByModel[model] = (target.subagents.costByModel[model] ?? 0) + usd;
        }
      }
      mergeUnknownModels(target, saBreakdown.unknownModels);
    }
    summary.agentFiles += sa!.agentFiles;
  }

  // サマリ集計(totalUSD / byModel はメイン基準。SA は含めない = GOLDEN 準拠）。
  for (const rec of records) {
    summary.newRecords += 1;
    summary.totalUSD += rec.costUSD;
    if (rec.costByModel) {
      for (const [m, c] of Object.entries(rec.costByModel)) {
        summary.byModel[m] = (summary.byModel[m] ?? 0) + c;
      }
    }
  }

  // 書き込み(dry-run では appendTurn / saveCursor を一切呼ばない）。
  if (!dryRun) {
    for (const rec of records) appendTurn(rec);
    // 記録が先・カーソルが後(track と同じ順序)。
    // メインカーソルは新規ターンを生成したときのみ進める(= track が「新規 usage あり」で進めるのと同義。
    // 先頭がプロンプトのみ(assistant 未達）の窓を消費してプロンプトを失わないため）。
    if (drafts.length > 0) saveCursor(mainPath, newCursor);
    // 期間外または親/別agentとの重複だけだったファイルも、意図的に消費した
    // 位置を保存する。履歴へ加えない同じ行を後続hookで再評価させないため。
    if (sa !== null) {
      for (const nc of sa!.newCursors) saveCursor(nc.path, nc.cursor);
    }
  }
}

// ============ Codex(rollout)の処理 ============
//
// Codex CLI(OpenAI)は ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl にセッションログを書く。
// Claude と違い assistant 行ごとの usage は無く、event_msg/token_count が運ぶ累積カウンタの
// 逐次ステップ差分で集計する(詳細は src/codex/transcript.ts)。ここでは splitIntoCodexTurnDrafts が
// 返すターン下書きをTurnRecord化する。sweepでは常にcursorなしで先頭から読み、生成したcursorは
// 後続hookとの互換性を保つ。契約: src/contracts.md「2026-07-10 追加: Codex CLI 対応」§ src/sweep.ts。

/** Codex ターン下書きを TurnRecord 化する(source:'codex'・ingest:'sweep'・サブエージェント無し)。 */
function codexDraftToRecord(
  draft: CodexTurnDraft,
  ts: string,
  table: PriceTable,
  fx: FxResult,
): TurnRecord {
  const main = draft.agg.main; // { [model]: TokenBuckets }(単一モデルキー)
  const breakdown = computeCost(main, {}, table); // Codex に sidechain は無いので第2引数は空
  const rec: TurnRecord = {
    schemaVersion: 1,
    ts,
    sessionId: draft.agg.sessionId,
    project: draft.agg.cwd ?? "",
    gitBranch: null, // rollout に git 情報は無い
    models: collectModels(main, {}),
    tokens: sumBuckets(main),
    sidechainTokens: null,
    apiCalls: draft.agg.apiCalls,
    costUSD: breakdown.usd,
    costByModel: breakdown.byModel,
    costJPY: breakdown.usd * fx.rate, // 円換算は sweep 実行時レート(Claude 側と同じ)
    fxRate: fx.rate,
    fxSource: fx.source,
    prompt: draft.agg.prompt ?? "",
    ingest: "sweep",
    source: "codex",
  };
  if (breakdown.unknownModels.length > 0) rec.unknownModels = breakdown.unknownModels;
  return rec;
}

/**
 * 1つのrolloutファイルをターン単位に復元し、--daysで古いターンを捨てつつTurnRecord化する。
 * sweepからはcursorなしで呼び、保存するnewCursorは後続hookが末尾追記だけを回収するために使う。
 */
async function processCodexRolloutLocked(
  rolloutPath: string,
  table: PriceTable,
  fx: FxResult,
  daysCutoff: number | null,
  dryRun: boolean,
  summary: SweepSummary,
  opts: { ignoreCursors?: boolean; strictRead?: boolean } = {},
): Promise<void> {
  if (opts.strictRead) {
    const file = await fsp.open(rolloutPath, "r");
    await file.close();
  }
  const cursor = opts.ignoreCursors ? null : sanitizeCursor(loadCursor(rolloutPath));
  const drafts = await splitIntoCodexTurnDrafts(rolloutPath, cursor);
  // null = 読めない or 新規 usage なし。カーソルも進めない(進行中セッションを後で hook / 次回 sweep が拾う)。
  if (drafts === null || drafts.length === 0) return;
  // Codex child rolloutは利用記録だけを扱い、料金は未集計という公開仕様に合わせる。
  // source欠損・未知形式はrootとして維持し、将来形式の通常rolloutを誤って捨てない。
  if (drafts[0].isSubagentRollout) return;

  // 各 draft → TurnRecord(--days より古いターンは捨てる。カーソルは最終ドラフトまで進めるので再走査しない)。
  const records: TurnRecord[] = [];
  for (const draft of drafts) {
    const ts = draft.endTs ?? new Date().toISOString();
    if (daysCutoff !== null) {
      const tsMs = Date.parse(ts);
      if (!Number.isFinite(tsMs) || tsMs < daysCutoff) continue; // 古い → 捨てる(カーソルは進める)
    }
    records.push(codexDraftToRecord(draft, ts, table, fx));
  }

  // サマリ集計。Codex 分は全体合計(newRecords / totalUSD / byModel)にも、Codex 別枠にも計上する。
  for (const rec of records) {
    summary.newRecords += 1;
    summary.totalUSD += rec.costUSD;
    summary.codexRecords += 1;
    summary.codexUSD += rec.costUSD;
    if (rec.costByModel) {
      for (const [m, c] of Object.entries(rec.costByModel)) {
        summary.byModel[m] = (summary.byModel[m] ?? 0) + c;
      }
    }
  }

  // 書き込み(dry-run では appendTurn / saveCursor を一切呼ばない)。
  if (!dryRun) {
    for (const rec of records) appendTurn(rec);
    // ファイル単位で最終ドラフトの newCursor を保存する。契約上これはウィンドウ全体消費を表すため、
    // --days で捨てたターンぶんもここで消費され、次回以降に再取り込みされない。
    saveCursor(rolloutPath, drafts[drafts.length - 1].agg.newCursor);
  }
}

interface CodexSweepSource {
  discovery: CodexRolloutDiscovery;
}

function isMissingPathError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Codex sourceのnon-symlink/readable探索結果をpreflightと実走査で共有する。 */
async function discoverCodexSweepSource(): Promise<CodexSweepSource | null> {
  const home = codexHome();
  let homeStat;
  try {
    homeStat = await fsp.lstat(home);
  } catch (err) {
    if (isMissingPathError(err)) return null;
    return { discovery: { rollouts: [], unreadableDirs: 1 } };
  }
  if (!homeStat.isDirectory()) {
    return { discovery: { rollouts: [], unreadableDirs: 1 } };
  }

  const sessionsRoot = join(home, "sessions");
  try {
    await fsp.lstat(sessionsRoot);
  } catch (err) {
    if (isMissingPathError(err)) return null;
    return { discovery: { rollouts: [], unreadableDirs: 1 } };
  }
  return { discovery: await listCodexRollouts(sessionsRoot) };
}

// ============ 走査 ============

function projectsRoot(override: string | null): string {
  if (override) return override;
  return process.env.CCCN_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");
}

interface SweepFlags {
  dryRun: boolean;
  days: number | null;
  projects: string | null;
}

function parseSweepFlags(argv: string[]): { flags: SweepFlags } | { error: string } {
  const flags: SweepFlags = {
    dryRun: false,
    days: null,
    projects: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      flags.dryRun = true;
    } else if (a === "--days" || a.startsWith("--days=")) {
      const v = a.includes("=") ? a.slice("--days=".length) : argv[++i];
      if (v === undefined || v.length === 0) return { error: "--days には値が必要です" };
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { error: "--days は0以上の数で指定してください" };
      flags.days = n;
    } else if (a === "--projects" || a.startsWith("--projects=")) {
      const v = a.includes("=") ? a.slice("--projects=".length) : argv[++i];
      if (!v) return { error: "--projects にはディレクトリが必要です" };
      flags.projects = v;
    } else {
      return { error: `不明なoptionまたは余分な引数です: ${a}` };
    }
  }
  return { flags };
}

/** ルート直下のディレクトリ(= プロジェクト)を絶対パスで列挙する。読めなければ null。 */
async function listProjectDirs(root: string): Promise<string[] | null> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch {
    return null;
  }
}

/** 走査失敗を「対象なし」と混同しない。 */
async function listTranscriptsStrict(projectDir: string): Promise<string[] | null> {
  try {
    const entries = await fsp.readdir(projectDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => join(projectDir, e.name));
  } catch {
    return null;
  }
}

function printSweepSummary(summary: SweepSummary, fx: FxResult): void {
  if (summary.dryRun) {
    console.log("(dry-run: 書き込みは行っていません)");
  }
  console.log(
    `走査: プロジェクト ${summary.projects} / transcript ${summary.transcripts} / サブエージェントファイル ${summary.agentFiles}`,
  );
  if (summary.newRecords === 0) {
    console.log("再生成対象はありませんでした");
  } else {
    console.log(
      `再生成: ${summary.newRecords} ターン、合計 ${formatUSD(summary.totalUSD)}(${formatJPY(summary.totalJPY)})`,
    );
    // SA 回収額(別枠)。合計(メイン基準)には含まれないため、回収の主役が SA のケース
    // (hook導入前セッションの全再生成等)でも回収額が見えるようにする。
    if (summary.subagentsUSD > 0) {
      console.log(
        `  うちサブエージェント: ${formatUSD(summary.subagentsUSD)}(${formatJPY(summary.subagentsUSD * fx.rate)})`,
      );
    }
    // Codex 分(別ソース)の内訳。totalUSD には含めた上で、Claude 分と切り分けて見えるようにする
    // (うちサブエージェント行と同じ位置感・同じ $(¥)書式の別枠1行。¥ は fx.rate 換算。
    //  取り込みが無い = codexRecords 0 のときは出さない)。
    if (summary.codexRecords > 0) {
      console.log(
        `  Codex: ${summary.codexRecords} ターン ${formatUSD(summary.codexUSD)}(${formatJPY(summary.codexUSD * fx.rate)})`,
      );
    }
    const top = Object.entries(summary.byModel)
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    if (top.length > 0) {
      console.log("  モデル別(上位):");
      for (const [m, c] of top) {
        console.log(`    ${modelDisplayName(m)}: ${formatUSD(c)}`);
      }
    }
  }

  console.log(`円換算レート: 1USD = ${fx.rate}JPY(source=${fx.source})`);
}

function reportSourceFailure(
  summary: SweepSummary,
  dryRun: boolean,
  scope: string,
  err: unknown,
  count = 1,
): void {
  summary.sourceFailures += count;
  if (dryRun) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${scope}: ${message}`);
    return;
  }
  logError(scope, err);
}

/**
 * Claude main/agentとCodex rolloutを、保存済みcursorに依存せず先頭から走査する。
 * 呼び出し元が通常実行ではdata lockを保持し、dry-runでは書き込みを無効化する。
 */
async function scanAllSources(
  projectDirs: string[] | null,
  codexSource: CodexSweepSource | null,
  table: PriceTable,
  fx: FxResult,
  daysCutoff: number | null,
  dryRun: boolean,
  summary: SweepSummary,
  progress: SweepProgressReporter,
): Promise<void> {
  const codexRollouts = codexSource?.discovery.rollouts.length ?? 0;
  progress({
    type: "scan-start",
    claudeProjects: projectDirs?.length ?? 0,
    codexRollouts,
  });

  // 件数だけを先に確定し、各ファイルの名前を出さずN/Mで進捗を示す。
  const transcriptPaths: string[] = [];
  for (const projectDir of projectDirs ?? []) {
    const transcripts = await listTranscriptsStrict(projectDir);
    if (transcripts === null) {
      reportSourceFailure(
        summary,
        dryRun,
        "sweep:discovery",
        new Error(`cannot read project: ${projectDir}`),
      );
      continue;
    }
    transcriptPaths.push(...transcripts);
  }
  for (const mainPath of transcriptPaths) {
    summary.transcripts += 1;
    try {
      await processTranscriptLocked(mainPath, table, fx, daysCutoff, dryRun, summary, {
        ignoreCursors: true,
        strictRead: true,
      });
    } catch (err) {
      reportSourceFailure(summary, dryRun, "sweep:transcript", err);
    }
    progress({
      type: "source-progress",
      source: "claude",
      completed: summary.transcripts,
      total: transcriptPaths.length,
    });
  }

  let completedCodexRollouts = 0;
  if (codexSource !== null) {
    const { discovery } = codexSource;
    if (discovery.unreadableDirs > 0) {
      reportSourceFailure(
        summary,
        dryRun,
        "sweep:codex-discovery",
        new Error(`${discovery.unreadableDirs} directories could not be read`),
        discovery.unreadableDirs,
      );
    }
    for (const rolloutPath of discovery.rollouts) {
      try {
        await processCodexRolloutLocked(rolloutPath, table, fx, daysCutoff, dryRun, summary, {
          ignoreCursors: true,
          strictRead: true,
        });
      } catch (err) {
        reportSourceFailure(summary, dryRun, "sweep:codex", err);
      }
      completedCodexRollouts += 1;
      progress({
        type: "source-progress",
        source: "codex",
        completed: completedCodexRollouts,
        total: codexRollouts,
      });
    }
  }
  progress({
    type: "scan-complete",
    claudeTranscripts: summary.transcripts,
    codexRollouts: completedCodexRollouts,
    records: summary.newRecords,
    failures: summary.sourceFailures,
  });
}

export async function runSweep(
  argv: string[],
  deps: { lockProvider?: SweepLockProvider } = {},
): Promise<number> {
  const parsed = parseSweepFlags(argv);
  if ("error" in parsed) {
    console.error(`${parsed.error}\n使い方 / Usage: ccc-notifier sweep [--dry-run] [--days N] [--projects DIR]`);
    return 1;
  }
  const flags = parsed.flags;
  const progress = createSweepProgressReporter();
  const root = projectsRoot(flags.projects);

  // Claude ルート不在でも、Codex 側が走査可能なら警告1行を出して Codex 走査だけ続行する
  // (Codex 専用ユーザーの全再生成を成立させるため)。両方走査不能ならreset前にエラー終了。
  const projectDirs = await listProjectDirs(root);
  const codexSource = await discoverCodexSweepSource();
  if (projectDirs === null) {
    if (codexSource === null || codexSource.discovery.unreadableDirs > 0) {
      console.log(`走査ルートが見つかりません: ${root}`);
      return 1;
    }
    console.log(`Claude の走査ルートが見つかりません: ${root}(Codex のみ走査します)`);
  }

  // 実行時に一度だけ: 設定 / 単価表(オンライン可・失敗時は内蔵へフォールバック) / 為替。
  progress({ type: "preparing", dryRun: flags.dryRun });
  const cfg = flags.dryRun
    ? readConfigReadOnly((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`sweep:config: ${message}(既定値で続行します)`);
      })
    : readConfig();
  const cacheDir = paths().cacheDir;
  const table = await loadPriceTable(cacheDir, { offline: false });
  const fx = await getUsdJpy(cfg, cacheDir);

  const summary: SweepSummary = {
    projects: projectDirs === null ? 0 : projectDirs.length,
    transcripts: 0,
    agentFiles: 0,
    newRecords: 0,
    totalUSD: 0,
    totalJPY: 0,
    subagentsUSD: 0,
    byModel: {},
    codexRecords: 0,
    codexUSD: 0,
    dryRun: flags.dryRun,
    sourceFailures: 0,
  };

  const daysCutoff = flags.days !== null ? Date.now() - flags.days * DAY_MS : null;
  const lockProvider = deps.lockProvider ?? (() => waitForDataLock());

  if (flags.dryRun) {
    try {
      await scanAllSources(projectDirs, codexSource, table, fx, daysCutoff, true, summary, progress);
    } catch (err) {
      reportSourceFailure(summary, true, "sweep:dry-run", err);
    }
    summary.totalJPY = summary.totalUSD * fx.rate;
    printSweepSummary(summary, fx);
    if (summary.sourceFailures > 0) {
      console.error(
        `一部を走査できませんでした(${summary.sourceFailures}件失敗)。sourceを確認して同じ ccc-notifier sweep --dry-run を再実行してください`,
      );
      return 1;
    }
    return 0;
  }

  progress({ type: "lock" });
  const lock = await lockProvider();
  if (lock === null) {
    console.error("全再生成のdata lockを取得できませんでした。後でもう一度お試しください");
    return 1;
  }
  let dashboardFailure = false;
  try {
    invalidateCanonicalDashboards();
    resetHistoryAndCursors();
    await scanAllSources(projectDirs, codexSource, table, fx, daysCutoff, false, summary, progress);
    try {
      // scan前の古いHTMLだけでなく、writerが作り得るplaceholderも一度消してから同じsnapshotで再生成する。
      invalidateCanonicalDashboards();
      if (summary.sourceFailures === 0 && cfg.dashboard.autoRegenerate) {
        progress({ type: "dashboard-start" });
        const generatedAt = new Date();
        const generatedAtIso = generatedAt.toISOString();
        const allTurns = readTurns();
        writeDashboardHtml({
          days: cfg.dashboard.days,
          outPath: paths().recentDashboardFile,
          autoReloadSec: cfg.dashboard.autoReloadSec,
          allTurns,
          variant: "recent",
          generatedAt: generatedAtIso,
        });
        writeDashboardHtml({
          days: null,
          outPath: paths().fullDashboardFile,
          autoReloadSec: cfg.dashboard.autoReloadSec,
          allTurns,
          variant: "full",
          generatedAt: generatedAtIso,
        });
        // full HTMLのatomic writeが成功した後だけ日次stateを進める。
        writeFullDashboardStateAtomic(makeFullDashboardState(generatedAt));
      }
    } catch (err) {
      dashboardFailure = true;
      logError("sweep:dashboard", err);
      // 片方だけの成功やwriterのplaceholderをcanonicalとして残さない。
      try {
        invalidateCanonicalDashboards();
      } catch (invalidateErr) {
        logError("sweep:dashboard-invalidate", invalidateErr);
      }
    }
  } catch (err) {
    reportSourceFailure(summary, false, "sweep", err);
  } finally {
    lock.release();
  }

  summary.totalJPY = summary.totalUSD * fx.rate;
  printSweepSummary(summary, fx);
  if (summary.sourceFailures > 0) {
    console.error(
      `一部再生成です(${summary.sourceFailures}件失敗)。同じ ccc-notifier sweep を再実行してください / partial regeneration; retry`,
    );
    return 1;
  }
  if (dashboardFailure) {
    console.error(
      "履歴は再生成済みですが、ダッシュボードを生成できませんでした。ccc-notifier dashboard と ccc-notifier dashboard --all を手動実行してください",
    );
    return 1;
  }
  console.log("履歴と取り込み位置を元JSONLから全再生成しました");
  return 0;
}
