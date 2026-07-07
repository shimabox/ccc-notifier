// src/sweep.ts — 過去分の一括回収(backfill)。
//
// 契約: src/contracts.md の "src/sweep.ts(2026-07-07 追加)" 参照。
//
// hook(track)のタイミングに依存せず、~/.claude/projects 配下の全 transcript(メイン +
// subagents/)を走査し、カーソルで「まだ計上していない分」を **ターン単位に復元** して履歴へ
// 取り込む。パース規約は transcript.ts の aggregateNewTurn を1ミリも違えず踏襲する
// (extractBucket / promptCandidate を再利用し、開始位置・改行終端・破損行スキップ・rescan ガード・
//  去重・コンテキスト採取の各規則をコードレベルで同一にする)。
//
// 二重計上しない理由: メイン/SA いずれもカーソル(処理済みオフセット + tsFloor)と message.id +
// requestId の去重で、hook が既に読んだ分は自動スキップされる。splitIntoTurnDrafts の newCursor は
// 同一ウィンドウに対する aggregateNewTurn の newCursor と互換なので、hook ↔ sweep の相互運用でも
// 取りこぼし/二重計上が起きない。

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
  sanitizeCursor,
  saveCursor,
} from "./store";
import { collectSubagentUsage } from "./subagents";
import type { SubagentUsage } from "./subagents";
import { formatJPY, formatUSD, modelDisplayName } from "./format";
import type { Cursor, FxResult, PriceTable, TokenBuckets, TurnRecord, UsageByModel } from "./types";

// aggregateNewTurn と同一の定数(挙動を1ミリも違えないため）。
const NEWLINE = 0x0a; // '\n'
const MAX_SEEN_KEYS = 500;
const SYNTHETIC_MODEL = "<synthetic>";
const DAY_MS = 86_400_000;

// 進行中セッション保護: mtime がこの時間以内の transcript は既定でスキップする(--include-active で解除)。
// 理由: 応答完了と同時に sweep が走ると、hook(track)より先にそのターンを読み切ってカーソルを
// 進めてしまい、track が「新規なし」で即 return → そのターンだけ通知・再生成が消える競合が起きる。
// 進行中のセッションは応答のたびに mtime が更新されるため、「直近更新なし」を完了済みの近似とする。
// スキップした分は次回 sweep か通常の hook が拾うので取りこぼしにはならない。
const ACTIVE_GUARD_MIN = 5;
const ACTIVE_GUARD_MS = ACTIVE_GUARD_MIN * 60_000;

export interface SweepSummary {
  projects: number;
  transcripts: number;
  agentFiles: number;
  newRecords: number;
  totalUSD: number;
  totalJPY: number;
  subagentsUSD: number; // SA 回収額(別枠)。totalUSD / byModel はメイン基準のまま(SA を含めない)
  byModel: Record<string, number>;
  skippedActive: number; // 進行中セッション保護でスキップした transcript 数(黙って落とさず必ず表示する)
  dryRun: boolean;
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
): Promise<{ drafts: TurnDraft[]; newCursor: Cursor }> {
  const buffer = await readAll(transcriptPath);
  if (buffer === null) {
    // 読めない場合は何も消費しない(既存カーソルがあればそのまま、無ければゼロ)。
    const nc: Cursor = cursor ?? { offset: 0, lastUuid: null, lastTs: null, seenMessageKeys: [] };
    return { drafts: [], newCursor: nc };
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

  return { drafts, newCursor };
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

/** SA の newCursors から最大 lastTs を取る(SA だけの回収レコードの ts に使う）。 */
function maxCursorTs(newCursors: Array<{ path: string; cursor: Cursor }>): string | null {
  let max: string | null = null;
  for (const nc of newCursors) {
    const t = nc.cursor.lastTs;
    if (t !== null && (max === null || t > max)) max = t;
  }
  return max;
}

function mergeUnknownModels(rec: TurnRecord, extra: string[]): void {
  if (extra.length === 0) return;
  const merged = rec.unknownModels ? [...rec.unknownModels] : [];
  for (const m of extra) if (!merged.includes(m)) merged.push(m);
  rec.unknownModels = merged;
}

// ============ 1 transcript の処理 ============

async function processTranscript(
  mainPath: string,
  table: PriceTable,
  fx: FxResult,
  daysCutoff: number | null,
  dryRun: boolean,
  summary: SweepSummary,
): Promise<void> {
  const cursor = sanitizeCursor(loadCursor(mainPath));
  const { drafts, newCursor } = await splitIntoTurnDrafts(mainPath, cursor);

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
    sa = await collectSubagentUsage(mainPath);
  } catch (err) {
    logError("sweep:subagents", err);
    sa = null;
  }
  const saHasUsage = sa !== null && sa.apiCalls > 0;

  if (saHasUsage) {
    const saBreakdown = computeCost(sa!.perModel, {}, table);
    summary.subagentsUSD += saBreakdown.usd; // SA 回収額はサマリ別枠に加算(totalUSD には混ぜない)
    const saBlock = {
      costUSD: saBreakdown.usd,
      costByModel: saBreakdown.byModel,
      tokens: sumBuckets(sa!.perModel),
      apiCalls: sa!.apiCalls,
      agentFiles: sa!.agentFiles,
    };

    if (records.length > 0) {
      // この session の最後の新規ターン record に SA ブロックを添付(track と同形式）。
      const last = records[records.length - 1];
      last.subagents = saBlock;
      mergeUnknownModels(last, saBreakdown.unknownModels);
    } else {
      // 新規ターンが無い → SA だけの回収レコードを作る。
      const rec: TurnRecord = {
        schemaVersion: 1,
        ts: maxCursorTs(sa!.newCursors) ?? new Date().toISOString(),
        sessionId: "",
        project: "",
        gitBranch: null,
        models: collectModels(sa!.perModel, {}),
        tokens: emptyBuckets(),
        sidechainTokens: null,
        apiCalls: 0,
        costUSD: 0,
        costByModel: {},
        costJPY: 0,
        fxRate: fx.rate,
        fxSource: fx.source,
        prompt: "",
        subagents: saBlock,
        ingest: "sweep",
      };
      mergeUnknownModels(rec, saBreakdown.unknownModels);
      records.push(rec);
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
    // SA カーソルは SA を計上したときのみ進める。
    if (saHasUsage) {
      for (const nc of sa!.newCursors) saveCursor(nc.path, nc.cursor);
    }
  }
}

// ============ 走査 ============

function projectsRoot(override: string | null): string {
  if (override) return override;
  return process.env.ACN_CLAUDE_PROJECTS || join(homedir(), ".claude", "projects");
}

interface SweepFlags {
  dryRun: boolean;
  days: number | null;
  projects: string | null;
  includeActive: boolean; // 進行中セッション保護(mtime ガード)を無効化して全 transcript を対象にする
}

function parseSweepFlags(argv: string[]): SweepFlags {
  const flags: SweepFlags = { dryRun: false, days: null, projects: null, includeActive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      flags.dryRun = true;
    } else if (a === "--include-active") {
      flags.includeActive = true;
    } else if (a === "--days" || a.startsWith("--days=")) {
      const v = a.includes("=") ? a.slice("--days=".length) : argv[++i];
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) flags.days = n;
    } else if (a === "--projects" || a.startsWith("--projects=")) {
      const v = a.includes("=") ? a.slice("--projects=".length) : argv[++i];
      if (v) flags.projects = v;
    }
  }
  return flags;
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

/**
 * 進行中セッション保護: transcript の mtime が ACTIVE_GUARD_MS 以内なら true。
 * stat 失敗は false(= 従来どおり処理へ進め、read 時の防御に任せる)。
 * 保護は「スキップ」側の追加ガードなので、判定不能時に処理を止めない側へ倒す。
 */
async function isRecentlyModified(path: string): Promise<boolean> {
  try {
    const st = await fsp.stat(path);
    return Date.now() - st.mtimeMs < ACTIVE_GUARD_MS;
  } catch {
    return false;
  }
}

/** プロジェクトディレクトリ直下の *.jsonl(1階層のみ・通常ファイル)を絶対パスで列挙する。 */
async function listTranscripts(projectDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(projectDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => join(projectDir, e.name));
  } catch {
    return []; // 読めないプロジェクトはスキップ
  }
}

function printSweepSummary(summary: SweepSummary, fx: FxResult): void {
  if (summary.dryRun) {
    console.log("(dry-run: 書き込みは行っていません)");
  }
  console.log(
    `走査: プロジェクト ${summary.projects} / transcript ${summary.transcripts} / サブエージェントファイル ${summary.agentFiles}`,
  );
  if (summary.skippedActive > 0) {
    console.log(
      `スキップ: ${summary.skippedActive} transcript(直近${ACTIVE_GUARD_MIN}分以内に更新 = 進行中セッションの可能性)。` +
        `セッション完了後に再実行するか、完了済みと分かっている場合は --include-active で取り込めます`,
    );
  }

  if (summary.newRecords === 0) {
    console.log("新規はありませんでした");
  } else {
    console.log(
      `新規取り込み: ${summary.newRecords} ターン、合計 ${formatUSD(summary.totalUSD)}(${formatJPY(summary.totalJPY)})`,
    );
    // SA 回収額(別枠)。合計(メイン基準)には含まれないため、回収の主役が SA のケース
    // (hook 導入前セッションの backfill 等)でも回収額が見えるようにする。
    if (summary.subagentsUSD > 0) {
      console.log(
        `  うちサブエージェント: ${formatUSD(summary.subagentsUSD)}(${formatJPY(summary.subagentsUSD * fx.rate)})`,
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

  console.log("既に計上済みの分はスキップされました(二重計上なし)");
  console.log(`円換算レート: 1USD = ${fx.rate}JPY(source=${fx.source})`);
}

export async function runSweep(argv: string[]): Promise<number> {
  const flags = parseSweepFlags(argv);
  const root = projectsRoot(flags.projects);

  const projectDirs = await listProjectDirs(root);
  if (projectDirs === null) {
    console.log(`走査ルートが見つかりません: ${root}`);
    return 1;
  }

  // 実行時に一度だけ: 設定 / 単価表(オンライン可・失敗時は内蔵へフォールバック) / 為替。
  const cfg = readConfig();
  const cacheDir = paths().cacheDir;
  const table = await loadPriceTable(cacheDir, { offline: false });
  const fx = await getUsdJpy(cfg, cacheDir);

  const summary: SweepSummary = {
    projects: projectDirs.length,
    transcripts: 0,
    agentFiles: 0,
    newRecords: 0,
    totalUSD: 0,
    totalJPY: 0,
    subagentsUSD: 0,
    byModel: {},
    skippedActive: 0,
    dryRun: flags.dryRun,
  };

  const daysCutoff = flags.days !== null ? Date.now() - flags.days * DAY_MS : null;

  for (const projectDir of projectDirs) {
    const transcripts = await listTranscripts(projectDir);
    for (const mainPath of transcripts) {
      summary.transcripts += 1;
      // 進行中セッション保護(冒頭の ACTIVE_GUARD_MS コメント参照)。カーソルも進めず丸ごと後回しにする。
      if (!flags.includeActive && (await isRecentlyModified(mainPath))) {
        summary.skippedActive += 1;
        continue;
      }
      try {
        await processTranscript(mainPath, table, fx, daysCutoff, flags.dryRun, summary);
      } catch (err) {
        // 1 transcript の失敗で全体を止めない。
        logError("sweep:transcript", err);
      }
    }
  }

  summary.totalJPY = summary.totalUSD * fx.rate;
  printSweepSummary(summary, fx);
  return 0;
}
