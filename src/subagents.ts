// src/subagents.ts — サブエージェント(バックグラウンド/サブエージェント)usage の増分集計。
//
// 契約: src/contracts.md の "src/subagents.ts" 参照。
//
// メイン transcript の兄弟ディレクトリ
//   <mainTranscriptPath(.jsonl 除去)>/subagents/agent-*.jsonl
// に、各サブエージェントの JSONL が恒久保存される(メインとほぼ同一スキーマ・全行
// isSidechain:true)。これを既存の aggregateNewTurn でファイル単位に増分集計し、
// 全ファイル合算の usage / apiCalls / 各ファイルの新カーソルを返す。
//
// 設計上の要点:
//  - ディレクトリが無い/読めない → null(旧形式環境。メイン transcript 内の isSidechain 行は
//    既存パーサが既に拾うので、ここでは何もしなくてよい)。
//  - agent- で始まり .jsonl で終わる「通常ファイル」のみを対象(.meta.json は読まない)。
//    シンボリックリンクは辿らない(Dirent.isFile() は symlink に対して false なので自然に除外)。
//  - ファイル数が MAX_AGENT_FILES を超える場合は更新時刻の新しい順に打ち切る(異常系ガード)。
//  - 全行 isSidechain のため usage は戻り値の sidechain 側に入るが、将来フラグが変わっても
//    取りこぼさないよう main と sidechain の両方を perModel にマージする。
//  - カーソル保存はここでは行わない(呼び出し側が履歴追記後に保存する)。
//  - 1ファイルの処理失敗は握りつぶして次へ(全体を止めない)。

import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { aggregateNewTurn } from "./transcript";
import { loadCursor, logError, sanitizeCursor } from "./store";
import type { Cursor, TokenBuckets, UsageByModel } from "./types";

const MAX_AGENT_FILES = 200;

export interface SubagentUsage {
  perModel: UsageByModel;
  apiCalls: number;
  agentFiles: number;
  newCursors: Array<{ path: string; cursor: Cursor }>;
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

/** src の全モデルを target にマージ(加算)する。 */
function mergeUsage(target: UsageByModel, src: UsageByModel): void {
  for (const [model, b] of Object.entries(src)) addToModel(target, model, b);
}

/**
 * メイン transcript パスからサブエージェントディレクトリを導出する。
 * 末尾 ".jsonl" を除去したパス + "/subagents"(例: /x/abc.jsonl → /x/abc/subagents)。
 */
function subagentsDirOf(mainTranscriptPath: string): string {
  const base = mainTranscriptPath.endsWith(".jsonl")
    ? mainTranscriptPath.slice(0, -".jsonl".length)
    : mainTranscriptPath;
  return join(base, "subagents");
}

/** 対象ディレクトリ内の agent-*.jsonl(通常ファイルのみ)を絶対パスで列挙する。 */
async function listAgentFiles(
  dir: string,
  entries: Dirent[],
  includeAllFiles: boolean,
): Promise<string[]> {
  const files = entries
    .filter((e) => e.isFile() && e.name.startsWith("agent-") && e.name.endsWith(".jsonl"))
    .map((e) => join(dir, e.name));

  if (includeAllFiles || files.length <= MAX_AGENT_FILES) return files;

  // 異常系ガード: 更新時刻の新しい順に MAX_AGENT_FILES 件で打ち切る。
  const withMtime: Array<{ path: string; mtime: number }> = [];
  for (const p of files) {
    let mtime = 0;
    try {
      mtime = (await fs.stat(p)).mtimeMs;
    } catch {
      mtime = 0; // stat 失敗は最古扱いにして打ち切られやすくする
    }
    withMtime.push({ path: p, mtime });
  }
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.slice(0, MAX_AGENT_FILES).map((x) => x.path);
}

/**
 * サブエージェント usage を増分集計する。
 * ディレクトリが無い/読めない場合は null(旧形式環境)。それ以外は全ファイル合算を返す
 * (対象ファイルが 0 件でも空集計の非 null を返す — 呼び出し側は apiCalls>0 で分岐する)。
 */
export async function collectSubagentUsage(
  mainTranscriptPath: string,
  opts: { ignoreCursors?: boolean; strictRead?: boolean; includeAllFiles?: boolean } = {},
): Promise<SubagentUsage | null> {
  const dir = subagentsDirOf(mainTranscriptPath);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (opts.strictRead && (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null; // ディレクトリ不在/読めない → 旧形式環境
  }

  const files = await listAgentFiles(dir, entries, opts.includeAllFiles === true);

  const perModel: UsageByModel = {};
  let apiCalls = 0;
  let agentFiles = 0;
  const newCursors: Array<{ path: string; cursor: Cursor }> = [];

  for (const filePath of files) {
    try {
      if (opts.strictRead) {
        const file = await fs.open(filePath, "r");
        await file.close();
      }
      const cursor = opts.ignoreCursors ? null : sanitizeCursor(loadCursor(filePath));
      const agg = await aggregateNewTurn(filePath, cursor);
      if (agg === null) continue; // このファイルに新規 usage なし
      // 全行 isSidechain だが、両側をマージして取りこぼしを防ぐ。
      mergeUsage(perModel, agg.main);
      mergeUsage(perModel, agg.sidechain);
      apiCalls += agg.apiCalls;
      agentFiles += 1;
      newCursors.push({ path: filePath, cursor: agg.newCursor });
    } catch (err) {
      if (opts.strictRead) throw err;
      // 1ファイルの失敗で全体を止めない。観測のためログのみ残す。
      logError("subagents:file", err);
    }
  }

  return { perModel, apiCalls, agentFiles, newCursors };
}
