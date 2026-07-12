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
// 契約は src/contracts.md「2026-07-10 追加: Codex CLI 対応」§ src/codex/transcript.ts。

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Cursor, TokenBuckets, TurnAggregate } from "../types";

const NEWLINE = 0x0a; // '\n'

/** Cursor.codexTotals と同じ3成分(累積カウンタのスナップショット)。 */
type CodexTotals = NonNullable<Cursor["codexTotals"]>;

/** splitIntoCodexTurnDrafts が返す「1ターン分」の下書き。TurnRecord 化は sweep 側が行う。 */
export interface CodexTurnDraft {
  agg: TurnAggregate; // ターン1件分(aggregateCodexTurn と同じ規約で構築)
  endTs: string | null; // そのターン最後のイベント timestamp(record の ts に使う)
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

/** total_token_usage / last_token_usage を3成分に読む。record でなければ null(欠損扱い)。 */
function readTotals(v: unknown): CodexTotals | null {
  if (!isRecord(v)) return null;
  return {
    input: numOf(v.input_tokens),
    cached: numOf(v.cached_input_tokens),
    output: numOf(v.output_tokens),
  };
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
  sessionId: string; // session_meta.session_id → ファイル名の uuid 部 → ""
  firstTs: string | null;
  lastTs: string | null;
  newOffset: number; // 処理済み末尾バイト(書きかけ行の行頭で止まる)
}

/**
 * ウィンドウを1回だけ走査し、aggregate 用(ウィンドウ全体)と split 用(セグメント列)の両方を
 * 同時に作る。両関数がこのコアを共有することで「全ドラフトの acc 合計・適用後 newCursor =
 * aggregateCodexTurn の結果」という相互運用不変条件が構造的に保証される。
 */
async function scanWindow(rolloutPath: string, cursor: Cursor | null): Promise<WindowScan | null> {
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
  let lastModel: string | null = null;
  let windowPrompt: string | null = null;
  let windowTurnCtxCwd: string | null = null;
  let sessionMetaCwd: string | null = null;
  let sessionMetaSid: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  const segments: Segment[] = [];
  let seg = newSegmentBuf();

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
  });

  const handleLine = (raw: string, endOffset: number): void => {
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
      const sid = strOrNull(payload.session_id);
      if (sid !== null) sessionMetaSid = sid;
      const c = strOrNull(payload.cwd);
      if (c !== null) sessionMetaCwd = c;
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
    handleLine(buffer.toString("utf8", lineStart, pos), pos + 1);
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
    sessionId: sessionMetaSid ?? sessionIdFromFilename(rolloutPath),
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
): Promise<TurnAggregate | null> {
  const scan = await scanWindow(rolloutPath, cursor);
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
): Promise<CodexTurnDraft[] | null> {
  const scan = await scanWindow(rolloutPath, cursor);
  if (scan === null || isZeroTotals(scan.acc)) return null;

  // usage を持つ確定セグメントだけがターンになる(ゼロのセグメントは境界ごと読み捨て)。
  const picked = scan.segments.filter((s) => !isZeroTotals(s.acc));

  // 末尾(最後の task_complete 以降)に usage が残った場合:
  //  - 確定ターンがあれば最後のドラフトに合算する(契約)。endTs も残りの最終イベントまで延ばす。
  //  - 1つも無ければ(task_complete がまだ書かれていない進行中/中断セッション)残り全体を
  //    1ターンとして返す。捨てると acc 合計が aggregateCodexTurn と食い違ってしまうため。
  if (scan.open !== null && !isZeroTotals(scan.open.acc)) {
    const last = picked[picked.length - 1];
    if (last !== undefined) {
      addTotals(last.acc, scan.open.acc);
      last.apiCalls += scan.open.apiCalls;
      if (scan.open.endTs !== null) last.endTs = scan.open.endTs;
    } else {
      picked.push(scan.open);
    }
  }
  // scan.acc が非ゼロならその usage は必ずいずれかのセグメントにあるので、ここで picked は非空。

  const lastIndex = picked.length - 1;
  return picked.map((s, i) => ({
    agg: {
      sessionId: scan.sessionId, // session_meta はファイル先頭にしか無いので全ドラフト共通
      main: { [s.model ?? "unknown"]: totalsToBuckets(s.acc) },
      sidechain: {},
      apiCalls: s.apiCalls,
      prompt: s.prompt,
      cwd: s.cwd,
      gitBranch: null,
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
            },
    },
    endTs: s.endTs,
  }));
}
