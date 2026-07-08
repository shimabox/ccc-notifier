// src/history.ts — 履歴(history.jsonl)の削除ユーティリティ。
//
// ダッシュボードは全履歴(プロンプト全文を含む)を埋め込むため、ファイルが大きくなったり
// プロンプトを残したくない場合に、ユーザー自身が履歴を消せるようにする。
//   - `history clear  [--days N] [--yes]` : レコードごと削除(チャート・集計からも消える)
//   - `history redact [--days N] [--yes]` : プロンプト全文だけ消す(コスト・チャートは残す)
// --days N を付けると「N 日より前」だけが対象。省略時は全期間が対象。破壊的操作のため、
// --yes が無ければ対象件数を示して確認する(setup の --purge と同じ流儀)。

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import * as p from "@clack/prompts";
import { paths } from "./store";
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

export async function runHistory(argv: string[]): Promise<number> {
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
  if (!existsSync(file)) {
    console.log("履歴がありません(history.jsonl は未作成です)。");
    return 0;
  }

  const lines = readLines(file);
  const cutoff = flags.days !== null ? Date.now() - flags.days * 86_400_000 : null;
  const scope = flags.days !== null ? `${flags.days}日より前` : "全期間";

  // 対象行を数える。redact はプロンプトが空でない行のみを対象にする(消す意味がある行だけ)。
  const targetSet = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const rec = lines[i].rec;
    if (!rec || !isTargeted(rec, cutoff)) continue;
    if (sub === "redact" && !(typeof rec.prompt === "string" && rec.prompt.length > 0)) continue;
    targetSet.add(i);
  }

  if (targetSet.size === 0) {
    console.log(`対象がありません(${scope})。`);
    return 0;
  }

  const action = sub === "clear" ? "レコードごと削除" : "プロンプト全文を消去";
  if (!flags.yes) {
    const confirmed = await p.confirm({
      message: `${scope}の履歴 ${targetSet.size} 件を${action}します。元に戻せません。よろしいですか?`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("キャンセルしました");
      return 0;
    }
  }

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
  return 0;
}
