// src/history.ts — 履歴(history.jsonl)の削除ユーティリティ。
//
// 全履歴ダッシュボードはプロンプト全文を含むため、ファイルが大きくなったり
// プロンプトを残したくない場合に、ユーザー自身が履歴を消せるようにする。
//   - `history clear  [--days N] [--yes]` : レコードごと削除(チャート・集計からも消える)
//   - `history redact [--days N] [--yes]` : プロンプト全文だけ消す(コスト・チャートは残す)
// --days N を付けると「N 日より前」だけが対象。省略時は全期間が対象。破壊的操作のため、
// --yes が無ければ対象件数を示して確認する(setup の --purge と同じ流儀)。

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import * as p from "@clack/prompts";
import { paths } from "./store";
import { invalidateCanonicalDashboards } from "./dashboard-state";
import { waitForDataLock } from "./data-lock";
import type { TurnRecord } from "./types";

interface HistoryFlags {
  days: number | null;
  yes: boolean;
}

function parseFlags(argv: string[]): HistoryFlags {
  let days: number | null = null;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (a === "--days") {
      const n = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(n) && n > 0) days = n;
      i++;
    } else if (a.startsWith("--days=")) {
      const n = Number.parseInt(a.slice("--days=".length), 10);
      if (Number.isFinite(n) && n > 0) days = n;
    }
  }
  return { days, yes };
}

interface Line {
  raw: string;
  rec: TurnRecord | null; // パース不能(壊れた)行は null にして「触らない」対象にする
}

function readLines(file: string): Line[] {
  const raw = readFileSync(file, "utf8");
  const lines: Line[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: TurnRecord | null = null;
    try {
      rec = JSON.parse(line) as TurnRecord;
    } catch {
      rec = null;
    }
    lines.push({ raw: line, rec });
  }
  return lines;
}

/** cutoffMs より前(ts < cutoff)なら対象。cutoff が null(=--days 無し)なら全件対象。 */
function isTargeted(rec: TurnRecord, cutoffMs: number | null): boolean {
  if (cutoffMs === null) return true;
  const ts = Date.parse(rec.ts);
  if (!Number.isFinite(ts)) return false; // ts をパースできない行は安全側で対象外
  return ts < cutoffMs;
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

function collectTargets(lines: Line[], sub: "clear" | "redact", cutoff: number | null): Set<number> {
  const targetSet = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const rec = lines[i].rec;
    if (!rec || !isTargeted(rec, cutoff)) continue;
    if (sub === "redact" && !(typeof rec.prompt === "string" && rec.prompt.length > 0)) continue;
    targetSet.add(i);
  }
  return targetSet;
}

function targetFingerprint(lines: Line[], targets: Set<number>): string {
  const hash = createHash("sha256");
  hash.update(`count:${targets.size}\n`);
  for (const i of [...targets].sort((a, b) => a - b)) {
    hash.update(`${i}:${lines[i]?.raw ?? ""}\n`);
  }
  return hash.digest("hex");
}

export async function runHistory(
  argv: string[],
  deps: { confirm?: (opts: { message: string; initialValue: boolean }) => Promise<unknown> } = {},
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "clear" && sub !== "redact") {
    console.error(
      "使い方 / Usage: ccc-notifier history <clear|redact> [--days N] [--yes]\n" +
        "  clear  … レコードごと削除(チャート・集計からも消える) / delete records\n" +
        "  redact … プロンプト全文だけ消す(コスト・チャートは残す) / strip prompts only",
    );
    return 1;
  }

  const flags = parseFlags(rest);
  const file = paths().historyFile;
  let lines = existsSync(file) ? readLines(file) : [];
  const cutoff = flags.days !== null ? Date.now() - flags.days * 86_400_000 : null;
  const scope = flags.days !== null ? `${flags.days}日より前` : "全期間";

  // 対象行を数える。redact はプロンプトが空でない行のみを対象にする(消す意味がある行だけ)。
  let targetSet = collectTargets(lines, sub, cutoff);
  const initialFingerprint = targetFingerprint(lines, targetSet);

  const action = sub === "clear" ? "レコードごと削除" : "プロンプト全文を消去";
  if (targetSet.size > 0 && !flags.yes) {
    const confirmed = await (deps.confirm ?? p.confirm)({
      message: `${scope}の履歴 ${targetSet.size} 件を${action}します。元に戻せません。よろしいですか?`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("キャンセルしました");
      return 0;
    }
  }

  const lock = await waitForDataLock();
  if (lock === null) {
    console.error("履歴の更新ロックを取得できませんでした。後でもう一度お試しください / history lock is busy");
    return 1;
  }
  try {
    // 確認待ちの間にtrackが追記し得るため、lock取得後にsnapshotと対象集合を作り直す。
    lines = existsSync(file) ? readLines(file) : [];
    targetSet = collectTargets(lines, sub, cutoff);
    if (!flags.yes && targetFingerprint(lines, targetSet) !== initialFingerprint) {
      console.error(
        "確認中に履歴が変更されたため処理しませんでした。もう一度実行してください / history changed; retry",
      );
      return 1;
    }

    // crash safety: mutationより先に旧promptを含みうるcanonical/stateを無効化する。
    // 前回mutation後・無効化前にcrashしてhistoryが既に無い/対象無しでも、この再実行で収束する。
    invalidateCanonicalDashboards();

    if (!existsSync(file)) {
      console.log("履歴がありません(history.jsonl は未作成です)。");
      return 0;
    }
    if (targetSet.size === 0) {
      console.log(`対象がありません(${scope})。`);
      return 0;
    }

    try {
      if (sub === "clear") {
        const kept = lines.filter((_, i) => !targetSet.has(i)).map((l) => l.raw);
        if (kept.length === 0) {
          rmSync(file, { force: true });
        } else {
          atomicWrite(file, kept.join("\n") + "\n");
        }
        console.log(`履歴 ${targetSet.size} 件を削除しました(${scope})。`);
      } else {
        const out = lines.map((l, i) => {
          if (!targetSet.has(i) || l.rec === null) return l.raw;
          return JSON.stringify({ ...l.rec, prompt: "" });
        });
        atomicWrite(file, out.join("\n") + "\n");
        console.log(
          `プロンプト全文を ${targetSet.size} 件消去しました(${scope}。コスト集計・チャートは保持されます)。`,
        );
      }
    } catch (err) {
      console.error(
        `履歴の更新に失敗しました / failed to update history: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
    // idempotentな後段も実行し、mutation中に外部から置かれた生成物にも収束する。
    invalidateCanonicalDashboards();
    return 0;
  } finally {
    lock.release();
  }
}
