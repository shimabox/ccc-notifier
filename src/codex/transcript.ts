// src/codex/transcript.ts — Codex rollout(セッションログ)の増分集計。
//
// Codex CLI は ~/.codex/sessions 配下に追記専用の rollout jsonl を書く。Claude の transcript と
// 違って assistant 行ごとの usage は無く、event_msg/token_count が「セッション累積カウンタ
// (total_token_usage)」のスナップショットを運ぶ。そのため集計は逐次ステップ差分方式で行う:
// step = total − prev(成分ごと)、いずれかが負ならリセット(コンパクション等)とみなして
// last_token_usage にフォールバックする。重複イベントは step=0 で自然に無害、リセット後も prev が
// 実カウンタに追従するので次ウィンドウから差分方式に自己復帰する。
// ここの誤りは全ユーザーの金額を狂わせるので、破損行・書きかけ行・壊れたカーソル・重複・リセットの
// すべてでクラッシュせず・二重計上しないことを最優先にする(src/transcript.ts と同じ防御方針)。
// 契約は docs/internal/contracts.md「2026-07-10 追加: Codex CLI 対応」§ src/codex/transcript.ts。

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { codexEventFingerprint } from "../counted-calls";
import type { MessageKeyFilter } from "../counted-calls";
import type { Cursor, TokenBuckets, TurnAggregate } from "../types";

/** 走査オプション。excludeEvents は「計上済みイベントの指紋」を判定する述語。 */
export interface CodexScanOptions {
  excludeEvents?: MessageKeyFilter;
}

const NEWLINE = 0x0a; // '\n'

/** Cursor.codexTotals と同じ3成分(累積カウンタのスナップショット)。 */
type CodexTotals = NonNullable<Cursor["codexTotals"]>;

/** splitIntoCodexTurnDrafts が返す「1ターン分」の下書き。TurnRecord 化は sweep 側が行う。 */
export interface CodexTurnDraft {
  agg: TurnAggregate; // ターン1件分(aggregateCodexTurn と同じ規約で構築)
  endTs: string | null; // そのターン最後のイベント timestamp(record の ts に使う)
  isSubagentRollout: boolean; // session_meta.payload.source.subagent を持つ child rollout か
}

// ============ 小ヘルパー(src/transcript.ts と同一規則をローカルに複製) ============

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 非有限・欠損は 0 に潰す(1フィールドの破損が合計を汚染しないように)。 */
function numOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function zeroTotals(): CodexTotals {
  return { input: 0, cached: 0, output: 0 };
}

function isZeroTotals(t: CodexTotals): boolean {
  return t.input === 0 && t.cached === 0 && t.output === 0;
}

function addTotals(target: CodexTotals, d: CodexTotals): void {
  target.input += d.input;
  target.cached += d.cached;
  target.output += d.output;
}

/**
 * total_token_usage / last_token_usage を3成分に読む。record でなければ null(欠損扱い)。
 *
 * 成分がすべて 0 なのに total_tokens だけ正のイベントがある(Codex Desktop の一部ビルドは
 * 内訳を書かず合計だけを残す)。成分だけを見ると使用量ゼロと判定して丸ごと取りこぼすため、
 * total_tokens を内訳不明の使用量として拾う。どのバケットに置くかは内訳が無い以上仮定に
 * なるので、単価が最も低いキャッシュ読みとして扱う(過大計上を作らない側に倒す)。
 * 内訳を持つイベントは total_tokens === input_tokens + output_tokens が成立するため、
 * この分岐には入らない。
 */
function readTotals(v: unknown): CodexTotals | null {
  if (!isRecord(v)) return null;
  const input = numOf(v.input_tokens);
  const cached = numOf(v.cached_input_tokens);
  const output = numOf(v.output_tokens);
  if (input === 0 && cached === 0 && output === 0) {
    const total = numOf(v.total_tokens);
    if (total > 0) return { input: total, cached: total, output: 0 };
  }
  return { input, cached, output };
}

/**
 * acc → TokenBuckets 写像(契約): input は非キャッシュ分(負にはしない)、cached は cacheRead へ。
 * Codex にキャッシュ書き込みの概念は無いので write 系は常に 0。
 */
function totalsToBuckets(acc: CodexTotals): TokenBuckets {
  return {
    input: Math.max(0, acc.input - acc.cached),
    output: acc.output,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: acc.cached,
  };
}

/** rollout-<ISO>-<uuid>.jsonl のファイル名から uuid 部を取る(session_meta 欠損時のフォールバック)。 */
function sessionIdFromFilename(rolloutPath: string): string {
  const m = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    basename(rolloutPath),
  );
  return m !== null ? m[1] : "";
}

async function readAll(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null; // 不在・読めないファイル → 呼び出し側で null(決して投げない)
  }
}

/** session_meta(ファイル先頭行にしか現れない)から採れるセッション属性。 */
interface SessionMetaSeed {
  sessionId: string | null;
  cwd: string | null;
  originator: string | null;
  isSubagentRollout: boolean;
}

/**
 * バッファ先頭行を session_meta として読む。増分読み(offset > 0 からの再開)では先頭行を
 * 走査しないため、originator / child rollout 判定 / session_id / cwd をここから補う。
 * 先頭行が session_meta でない・壊れている場合は null。
 */
function readSessionMetaSeed(buffer: Buffer): SessionMetaSeed | null {
  const nl = buffer.indexOf(NEWLINE);
  if (nl <= 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(buffer.toString("utf8", 0, nl));
  } catch {
    return null;
  }
  if (!isRecord(obj) || obj.type !== "session_meta") return null;
  const payload = isRecord(obj.payload) ? obj.payload : null;
  if (payload === null) return null;
  const source = payload.source;
  return {
    // session_meta.payload のキーは id。将来 session_id へ戻る可能性に備えて両方見る。
    sessionId: strOrNull(payload.id) ?? strOrNull(payload.session_id),
    cwd: strOrNull(payload.cwd),
    originator: strOrNull(payload.originator),
    isSubagentRollout: isRecord(source) && Object.hasOwn(source, "subagent"),
  };
}

// ============ ウィンドウスキャン(aggregate / split 共通コア) ============

/** task_complete で確定した(または EOF で打ち切られた)1セグメント分のスキャン結果。 */
interface Segment {
  acc: CodexTotals; // このセグメントに帰属した step の合計
  apiCalls: number; // info あり・step≠0 の token_count 件数
  prompt: string | null; // セグメント内最後の user_message.message
  model: string | null; // セグメント内最後の turn_context.model(無ければ直前セグメントから持ち回り)
  cwd: string | null; // セグメント内最後の turn_context.cwd → session_meta.cwd
  firstTs: string | null;
  endTs: string | null; // セグメント内最後に処理したイベントの timestamp
  endOffset: number; // セグメント末尾直後のバイトオフセット(行境界)
  prevAtEnd: CodexTotals; // 確定時点の prev(このオフセットから再開するときの codexTotals)
  lastTsAtEnd: string | null; // 確定時点のウィンドウ最終 timestamp
  eventKeys: string[]; // このセグメントで計上した token_count イベントの指紋
}

/** スキャン中の現セグメントのバッファ。task_complete で Segment に確定して作り直す。 */
interface SegmentBuf {
  acc: CodexTotals;
  apiCalls: number;
  prompt: string | null;
  turnCtxCwd: string | null;
  firstTs: string | null;
  endTs: string | null;
  hasLines: boolean; // 処理した行が1つでもあるか(EOF 時に「残り」を持ち帰る判定)
  eventKeys: string[];
}

function newSegmentBuf(): SegmentBuf {
  return {
    acc: zeroTotals(),
    apiCalls: 0,
    prompt: null,
    turnCtxCwd: null,
    firstTs: null,
    endTs: null,
    hasLines: false,
    eventKeys: [],
  };
}

/** ウィンドウ(カーソル位置〜EOF)全体のスキャン結果。 */
interface WindowScan {
  segments: Segment[]; // task_complete で確定したセグメント(usage ゼロも含む)
  open: Segment | null; // 最後の task_complete 以降に処理した行があればその残り
  acc: CodexTotals; // ウィンドウ全体の合計(= 各セグメント acc の合計)
  prev: CodexTotals; // 最後に観測した total_token_usage(フォールバック発生時も実カウンタ)
  apiCalls: number;
  model: string | null; // ウィンドウ内最後の turn_context.model
  prompt: string | null; // ウィンドウ内最後の user_message.message
  cwd: string | null; // 最後の turn_context.cwd → session_meta.cwd
  sessionId: string; // session_meta の id(旧 session_id)→ ファイル名の uuid 部 → ""
  eventKeys: string[]; // ウィンドウ全体で計上した token_count イベントの指紋
  isSubagentRollout: boolean; // child rollout は sweep の料金履歴へ入れないため呼び出し側へ伝える
  originator: string | null; // session_meta.originator(生値)。ファイル先頭にしか無いのでカーソル越しに持ち回る
  firstTs: string | null;
  lastTs: string | null;
  newOffset: number; // 処理済み末尾バイト(書きかけ行の行頭で止まる)
}

/**
 * ウィンドウを1回だけ走査し、aggregate 用(ウィンドウ全体)と split 用(セグメント列)の両方を
 * 同時に作る。両関数がこのコアを共有することで「全ドラフトの acc 合計・適用後 newCursor =
 * aggregateCodexTurn の結果」という相互運用不変条件が構造的に保証される。
 */
async function scanWindow(
  rolloutPath: string,
  cursor: Cursor | null,
  opts: CodexScanOptions = {},
): Promise<WindowScan | null> {
  const buffer = await readAll(rolloutPath);
  if (buffer === null) return null;
  const fileSize = buffer.length;

  // 1. 開始位置と rescan 判定(aggregateNewTurn と同一の流儀)。カーソルは「offset の直前が改行」
  //    という行境界に一致するときだけ信用する。それ以外(null / 0 / EOF 超え / 行の途中)は
  //    先頭からのフルリスキャンとし、lastTs 以前の行をスキップして二重計上を防ぐ。
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
  const tsFloor = cursor?.lastTs ?? null;

  // 2. 逐次ステップ差分の状態。prev は常に「最後に観測した実カウンタ」で、リセット(負差分)後も
  //    total に追従させるため次ウィンドウから自動的に差分方式へ復帰する。カーソル側の値は
  //    変更しない(コピーして使う)。
  const initTotals = cursor?.codexTotals;
  let prev: CodexTotals = initTotals !== undefined ? { ...initTotals } : zeroTotals();
  const acc = zeroTotals();
  let apiCalls = 0;

  // ウィンドウ全体のコンテキスト。lastModel は「直前セグメントからの持ち回り」も兼ねる。
  // ターン境界より後ろから再開した窓には turn_context が無いため、カーソル側の値を初期値にする。
  let lastModel: string | null = cursor?.codexModel ?? null;
  let windowPrompt: string | null = null;
  let windowTurnCtxCwd: string | null = null;
  let sessionMetaCwd: string | null = null;
  let sessionMetaSid: string | null = null;
  let isSubagentRollout = false;
  // session_meta はファイル先頭にしか現れないため、増分読み(rescan でない再開)では観測できない。
  // カーソルに保存済みの originator を初期値にし、先頭行からも直接読み直して補う
  // (child rollout 判定はカーソルに持たないため、常に先頭行から採る)。
  let originator: string | null = cursor?.codexOriginator ?? null;
  if (startOffset > 0) {
    const seed = readSessionMetaSeed(buffer);
    if (seed !== null) {
      sessionMetaSid = seed.sessionId;
      sessionMetaCwd = seed.cwd;
      if (seed.originator !== null) originator = seed.originator;
      isSubagentRollout = seed.isSubagentRollout;
    }
  }
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  const segments: Segment[] = [];
  const windowEventKeys: string[] = [];
  let seg = newSegmentBuf();

  // 指紋の素材になるセッション ID。session_meta はファイル先頭行にしかないので、
  // 先頭から読む場合は最初の行で、増分読みの場合は seed で既に確定している。
  const rolloutFile = basename(rolloutPath);
  const filenameId = sessionIdFromFilename(rolloutPath);
  const rolloutId = (): string => sessionMetaSid ?? filenameId;

  // 現セグメントを endOffset 時点の状態で確定する。prevAtEnd / lastTsAtEnd を持たせるので、
  // どのセグメント末尾も「そこから読み直せば残りが差分になる」有効な再開点になる。
  const snapshotSegment = (endOffset: number): Segment => ({
    acc: seg.acc,
    apiCalls: seg.apiCalls,
    prompt: seg.prompt,
    model: lastModel,
    cwd: seg.turnCtxCwd ?? sessionMetaCwd,
    firstTs: seg.firstTs,
    endTs: seg.endTs,
    endOffset,
    prevAtEnd: { ...prev },
    lastTsAtEnd: lastTs,
    eventKeys: seg.eventKeys,
  });

  const handleLine = (raw: string, lineOffset: number, endOffset: number): void => {
    if (raw.trim().length === 0) return; // 空行
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return; // 破損 JSON は1行スキップ(全体は壊さない)
    }
    if (!isRecord(obj)) return;

    const ts = strOrNull(obj.timestamp);
    // rescan ガード(タイムスタンプ下限): 前回までに計上済みの行を丸ごとスキップ。
    if (rescan && tsFloor !== null && ts !== null && ts <= tsFloor) return;

    // timestamp は処理したすべての行から採取する(response_item 等の非集計行も含む)。
    if (ts !== null) {
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
      if (seg.firstTs === null || ts < seg.firstTs) seg.firstTs = ts;
      seg.endTs = ts; // 追記専用ログなので「最後に処理した行」= 実質最大
    }
    seg.hasLines = true;

    const payload = isRecord(obj.payload) ? obj.payload : null;
    if (payload === null) return; // payload の無い行は timestamp だけ

    const type = obj.type;
    if (type === "session_meta") {
      const sid = strOrNull(payload.id) ?? strOrNull(payload.session_id);
      if (sid !== null) sessionMetaSid = sid;
      const c = strOrNull(payload.cwd);
      if (c !== null) sessionMetaCwd = c;
      const source = payload.source;
      if (isRecord(source) && Object.hasOwn(source, "subagent")) isSubagentRollout = true;
      const orig = strOrNull(payload.originator);
      if (orig !== null) originator = orig;
      return;
    }
    if (type === "turn_context") {
      const m = strOrNull(payload.model);
      if (m !== null) lastModel = m;
      const c = strOrNull(payload.cwd);
      if (c !== null) {
        seg.turnCtxCwd = c;
        windowTurnCtxCwd = c;
      }
      return;
    }
    if (type !== "event_msg") return; // response_item ほかは usage を運ばない

    const kind = payload.type;
    if (kind === "user_message") {
      const msg = strOrNull(payload.message);
      if (msg !== null) {
        seg.prompt = msg;
        windowPrompt = msg;
      }
      return;
    }
    if (kind === "token_count") {
      // info が null/欠損、または total_token_usage が読めない行はスキップする。
      // prev には触らない(欠損を {0,0,0} と誤読すると、次の実カウンタとの差分が
      // 「累積全量」になって大幅な過大計上になるため)。
      const info = isRecord(payload.info) ? payload.info : null;
      if (info === null) return;
      const total = readTotals(info.total_token_usage);
      if (total === null) return;

      // 既に計上済みのイベントは金額に足さない。ただし prev は必ず進める
      // (累積カウンタを取りこぼすと、次のイベントの差分が累積全量になって過大計上になる)。
      const eventKey = codexEventFingerprint(rolloutFile, rolloutId(), lineOffset, total);
      if (opts.excludeEvents?.has(eventKey) === true) {
        prev = total;
        return;
      }

      let step: CodexTotals = {
        input: total.input - prev.input,
        cached: total.cached - prev.cached,
        output: total.output - prev.output,
      };
      if (step.input < 0 || step.cached < 0 || step.output < 0) {
        // カウンタリセット(コンパクション・新スレッド等)。この1件は last_token_usage で代用。
        step = readTotals(info.last_token_usage) ?? zeroTotals();
      }
      addTotals(acc, step);
      addTotals(seg.acc, step);
      seg.eventKeys.push(eventKey);
      windowEventKeys.push(eventKey);
      prev = total; // フォールバック時も「最後に観測した実カウンタ」に追従させる
      if (!isZeroTotals(step)) {
        apiCalls++; // 重複イベント(step=0)は API 呼び出しに数えない
        seg.apiCalls++;
      }
      return;
    }
    if (kind === "task_complete") {
      // task_complete 行自身は現セグメントに属する(endTs はこの行)。ここでターンを確定する。
      segments.push(snapshotSegment(endOffset));
      seg = newSegmentBuf();
    }
  };

  // 3. 改行終端の行だけを処理する。書きかけの最終行は処理せず、オフセットをその行頭で止めて
  //    次回完成後に読み直す(aggregateNewTurn と同一)。
  let lineStart = startOffset;
  for (let pos = startOffset; pos < fileSize; pos++) {
    if (buffer[pos] !== NEWLINE) continue;
    handleLine(buffer.toString("utf8", lineStart, pos), lineStart, pos + 1);
    lineStart = pos + 1;
  }
  const newOffset = lineStart;

  // 最後の task_complete 以降に処理した行が残っていれば「未確定セグメント」として持ち帰る。
  const open = seg.hasLines ? snapshotSegment(newOffset) : null;

  return {
    segments,
    open,
    acc,
    prev,
    apiCalls,
    model: lastModel,
    prompt: windowPrompt,
    cwd: windowTurnCtxCwd ?? sessionMetaCwd,
    sessionId: rolloutId(),
    eventKeys: windowEventKeys,
    isSubagentRollout,
    originator,
    firstTs,
    lastTs,
    newOffset,
  };
}

/** ウィンドウ全体を消費した状態の新カーソル(aggregate と split の最終ドラフトで共通)。 */
function windowCursor(scan: WindowScan): Cursor {
  return {
    offset: scan.newOffset,
    lastUuid: null, // rollout に uuid 行は無い
    lastTs: scan.lastTs,
    seenMessageKeys: [], // 去重は codexTotals の差分方式が担う
    codexTotals: { ...scan.prev },
    codexOriginator: scan.originator,
    codexModel: scan.model,
  };
}

// ============ 公開 API ============

/**
 * カーソル位置から EOF までを1ターン分として集計する(hook の Stop 経路用)。
 * 新規 usage が無ければ null を返し、カーソルは進めない(= 呼び出し側は保存しない。
 * aggregateNewTurn の「新規 assistant usage が 0 件なら null」と同じ意味論)。同じ窓を
 * 次回読み直しても、同じ total は step=0 になるだけなので二重計上にはならない。
 */
export async function aggregateCodexTurn(
  rolloutPath: string,
  cursor: Cursor | null,
  opts: CodexScanOptions = {},
): Promise<TurnAggregate | null> {
  const scan = await scanWindow(rolloutPath, cursor, opts);
  if (scan === null || isZeroTotals(scan.acc)) return null;
  return {
    sessionId: scan.sessionId,
    main: { [scan.model ?? "unknown"]: totalsToBuckets(scan.acc) },
    sidechain: {}, // Codex にサブエージェント概念は無い
    apiCalls: scan.apiCalls,
    prompt: scan.prompt,
    cwd: scan.cwd,
    gitBranch: null, // rollout に無い
    firstTs: scan.firstTs,
    lastTs: scan.lastTs,
    newCursor: windowCursor(scan),
    originator: scan.originator,
    isSubagentRollout: scan.isSubagentRollout,
    codexEventKeys: scan.eventKeys,
  };
}

/**
 * ウィンドウを消費し切った位置のカーソルだけを返す(新規 usage の有無に関わらず)。
 * 「読んだが計上対象は無かった」ファイルのカーソルを進めて、次回の再読み込みを避けるために使う。
 * ファイルが読めなければ null。
 */
export async function codexConsumedCursor(
  rolloutPath: string,
  cursor: Cursor | null,
  opts: CodexScanOptions = {},
): Promise<Cursor | null> {
  const scan = await scanWindow(rolloutPath, cursor, opts);
  return scan === null ? null : windowCursor(scan);
}

/**
 * ターン分割と「消費し切った位置のカーソル」を1回の走査で同時に返す。
 *
 * 分割とカーソル取得を別々に呼ぶと、片方だけが読み取りに失敗したときに
 * 「usage を記録しないままカーソルだけ進める」= その範囲の恒久的な取りこぼしが起きる。
 * 読めなければ null(呼び出し側は失敗として扱う)。新規 usage が無ければ drafts は空。
 */
export async function scanCodexTurns(
  rolloutPath: string,
  cursor: Cursor | null,
  opts: CodexScanOptions = {},
): Promise<{ drafts: CodexTurnDraft[]; newCursor: Cursor } | null> {
  const scan = await scanWindow(rolloutPath, cursor, opts);
  if (scan === null) return null;
  const newCursor = windowCursor(scan);
  if (isZeroTotals(scan.acc)) return { drafts: [], newCursor };
  return { drafts: draftsFromScan(scan), newCursor };
}

/**
 * 「timestamp が floorTs 以前の行をすべて消費し切った」状態の再開カーソルを作る。
 *
 * rollout は累積カウンタの差分(step = total − prev)で集計するため、行を読み飛ばすだけでは
 * prev が置き去りになり、次の差分が累積全量になって大幅な過大計上になる。ここでは floorTs 以前の
 * token_count から prev を実カウンタまで進めたうえで、最初に floorTs を超える行の直前で
 * オフセットを止める。返したカーソルで aggregateCodexTurn / splitIntoCodexTurnDrafts を呼べば、
 * floorTs より後の分だけが正しい差分として集計される(ターンの途中に floorTs があっても、
 * その残りだけが1ターンとして出る)。ファイルが読めなければ null。
 */
export async function codexResumePointAtTs(rolloutPath: string, floorTs: string): Promise<Cursor | null> {
  const buffer = await readAll(rolloutPath);
  if (buffer === null) return null;

  const seed = readSessionMetaSeed(buffer);
  let prev = zeroTotals();
  let lastModel: string | null = null;
  let consumedEnd = 0;
  let lineStart = 0;

  for (let pos = 0; pos < buffer.length; pos++) {
    if (buffer[pos] !== NEWLINE) continue;
    const raw = buffer.toString("utf8", lineStart, pos);
    let obj: unknown = null;
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = null; // 破損行は「消費済み」として扱う(集計側の破損行スキップと同じ)
    }
    if (isRecord(obj)) {
      const ts = strOrNull(obj.timestamp);
      if (ts !== null && ts > floorTs) break; // ここから先が未記録分
      const payload = isRecord(obj.payload) ? obj.payload : null;
      if (obj.type === "turn_context" && payload !== null) {
        const m = strOrNull(payload.model);
        if (m !== null) lastModel = m;
      }
      if (obj.type === "event_msg" && payload !== null && payload.type === "token_count") {
        const info = isRecord(payload.info) ? payload.info : null;
        const total = info === null ? null : readTotals(info.total_token_usage);
        if (total !== null) prev = total;
      }
    }
    consumedEnd = pos + 1;
    lineStart = pos + 1;
  }

  return {
    offset: consumedEnd,
    lastUuid: null,
    lastTs: floorTs,
    seenMessageKeys: [],
    codexTotals: prev,
    codexOriginator: seed?.originator ?? null,
    codexModel: lastModel,
  };
}

/**
 * 同じウィンドウを task_complete 境界でターンに分割する(sweep の過去分回収用)。
 * prev はセグメントを跨いで持ち回るため、全ドラフトの acc 合計と最後のドラフトの newCursor は
 * 同一ウィンドウに対する aggregateCodexTurn の結果と一致する(hook ↔ sweep 相互運用の不変条件)。
 * usage ゼロのセグメントはドラフトにしない。ファイルが読めない/新規 usage が無ければ null。
 */
export async function splitIntoCodexTurnDrafts(
  rolloutPath: string,
  cursor: Cursor | null,
  opts: CodexScanOptions = {},
): Promise<CodexTurnDraft[] | null> {
  const scan = await scanWindow(rolloutPath, cursor, opts);
  if (scan === null || isZeroTotals(scan.acc)) return null;
  return draftsFromScan(scan);
}

/** 走査結果を task_complete 境界のドラフト列にする(acc が非ゼロであること)。 */
function draftsFromScan(scan: WindowScan): CodexTurnDraft[] {
  // usage を持つ確定セグメントだけがターンになる(ゼロのセグメントは境界ごと読み捨て)。
  const picked = scan.segments.filter((s) => !isZeroTotals(s.acc));

  // 末尾(最後の task_complete 以降)に usage が残った場合は独立したドラフトにする。
  // 直前の完了ターンへ混ぜると、進行中の次ターンでモデルが変わったときに前モデルの単価で
  // 計算されるため。独立させても acc 合計と最終 cursor の不変条件は維持できる。
  if (scan.open !== null && !isZeroTotals(scan.open.acc)) {
    picked.push(scan.open);
  }
  // scan.acc が非ゼロならその usage は必ずいずれかのセグメントにあるので、ここで picked は非空。

  const lastIndex = picked.length - 1;
  return picked.map((s, i) => ({
    isSubagentRollout: scan.isSubagentRollout,
    agg: {
      sessionId: scan.sessionId, // session_meta はファイル先頭にしか無いので全ドラフト共通
      main: { [s.model ?? "unknown"]: totalsToBuckets(s.acc) },
      sidechain: {},
      apiCalls: s.apiCalls,
      prompt: s.prompt,
      cwd: s.cwd,
      gitBranch: null,
      originator: scan.originator, // session_meta はファイル先頭にしか無いので全ドラフト共通
      isSubagentRollout: scan.isSubagentRollout,
      codexEventKeys: s.eventKeys,
      firstTs: s.firstTs,
      lastTs: s.endTs,
      // 最後のドラフトはウィンドウ全体を消費した状態(= aggregateCodexTurn の newCursor と同一。
      // 末尾の usage ゼロな行の読み捨てもここに含まれる)。途中のドラフトはそのセグメント末尾を
      // 指す有効な再開点(そこから読み直せば残りが差分になる)。
      newCursor:
        i === lastIndex
          ? windowCursor(scan)
          : {
              offset: s.endOffset,
              lastUuid: null,
              lastTs: s.lastTsAtEnd,
              seenMessageKeys: [],
              codexTotals: { ...s.prevAtEnd },
              codexOriginator: scan.originator,
              codexModel: s.model,
            },
    },
    endTs: s.endTs,
  }));
}
