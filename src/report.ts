// src/report.ts (T8) — ターミナル向け集計レポート。
//
// 契約: src/contracts.md の "src/cli.ts, src/doctor.ts, src/report.ts (T8)" 参照。

import { formatJPY, formatTokens, formatUSD } from "./format";
import { readTurns } from "./store";
import type { TurnRecord } from "./types";

const DEFAULT_DAYS = 30;

interface ReportFlags {
  days: number;
  json: boolean;
}

function parseArgs(argv: string[]): ReportFlags {
  let days = DEFAULT_DAYS;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--days") {
      const value = argv[i + 1];
      days = parseDays(value);
      i++;
      continue;
    }
    if (arg.startsWith("--days=")) {
      days = parseDays(arg.slice("--days=".length));
    }
  }

  return { days, json };
}

/** 数値として解釈できない・0以下の値は不正値として扱い、既定の30を返す。 */
function parseDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DAYS;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAYS;
}

/** レコードの ts をローカルタイムゾーンの YYYY-MM-DD に変換する。パース不能なら null。 */
function localDateKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** main + sidechain の実効入力トークン(input + cacheRead + cacheWrite5m + cacheWrite1h)。 */
function effectiveInputTokens(rec: TurnRecord): number {
  const main = rec.tokens;
  const side = rec.sidechainTokens;
  const mainIn = main.input + main.cacheRead + main.cacheWrite5m + main.cacheWrite1h;
  const sideIn = side ? side.input + side.cacheRead + side.cacheWrite5m + side.cacheWrite1h : 0;
  return mainIn + sideIn;
}

function outputTokensOf(rec: TurnRecord): number {
  return rec.tokens.output + (rec.sidechainTokens ? rec.sidechainTokens.output : 0);
}

interface DailyAgg {
  date: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  costJPY: number;
}

interface ModelAgg {
  turns: number;
  costUSD: number;
  costJPY: number;
}

interface TotalAgg {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  costJPY: number;
}

interface Aggregated {
  daily: DailyAgg[];
  byModel: Record<string, ModelAgg>;
  total: TotalAgg;
}

function aggregate(turns: TurnRecord[]): Aggregated {
  const dailyMap = new Map<string, DailyAgg>();
  // モデル別集計は record.models の先頭モデル(主要モデル)にターン全体を帰属させる簡易集計。
  // サイドチェーンで別モデルが使われていても内訳は分けず、1ターン=主要モデル1件としてカウントする。
  const modelMap = new Map<string, ModelAgg>();

  const total: TotalAgg = { turns: 0, inputTokens: 0, outputTokens: 0, costUSD: 0, costJPY: 0 };

  for (const rec of turns) {
    const dateKey = localDateKey(rec.ts) ?? "unknown";
    const inTok = effectiveInputTokens(rec);
    const outTok = outputTokensOf(rec);

    const d = dailyMap.get(dateKey) ?? {
      date: dateKey,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      costJPY: 0,
    };
    d.turns += 1;
    d.inputTokens += inTok;
    d.outputTokens += outTok;
    d.costUSD += rec.costUSD;
    d.costJPY += rec.costJPY;
    dailyMap.set(dateKey, d);

    const primaryModel = rec.models[0] ?? "unknown";
    const m = modelMap.get(primaryModel) ?? { turns: 0, costUSD: 0, costJPY: 0 };
    m.turns += 1;
    m.costUSD += rec.costUSD;
    m.costJPY += rec.costJPY;
    modelMap.set(primaryModel, m);

    total.turns += 1;
    total.inputTokens += inTok;
    total.outputTokens += outTok;
    total.costUSD += rec.costUSD;
    total.costJPY += rec.costJPY;
  }

  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const byModel: Record<string, ModelAgg> = {};
  for (const [model, agg] of modelMap) byModel[model] = agg;

  return { daily, byModel, total };
}

function printTable(result: Aggregated, days: number): void {
  console.log(`直近 ${days} 日間の集計 (last ${days} days):`);
  console.log("");

  console.log("日別 (Daily):");
  console.log(
    "日付".padEnd(12) +
      "ターン".padStart(8) +
      "入力".padStart(10) +
      "出力".padStart(10) +
      "USD".padStart(10) +
      "JPY".padStart(12),
  );
  for (const d of result.daily) {
    console.log(
      d.date.padEnd(12) +
        String(d.turns).padStart(8) +
        formatTokens(d.inputTokens).padStart(10) +
        formatTokens(d.outputTokens).padStart(10) +
        formatUSD(d.costUSD).padStart(10) +
        formatJPY(d.costJPY).padStart(12),
    );
  }
  console.log(
    "合計".padEnd(12) +
      String(result.total.turns).padStart(8) +
      formatTokens(result.total.inputTokens).padStart(10) +
      formatTokens(result.total.outputTokens).padStart(10) +
      formatUSD(result.total.costUSD).padStart(10) +
      formatJPY(result.total.costJPY).padStart(12),
  );

  console.log("");
  console.log("モデル別 (By model):");
  console.log("モデル".padEnd(28) + "ターン".padStart(8) + "USD".padStart(10) + "JPY".padStart(12));
  for (const [model, m] of Object.entries(result.byModel)) {
    console.log(
      model.padEnd(28) + String(m.turns).padStart(8) + formatUSD(m.costUSD).padStart(10) + formatJPY(m.costJPY).padStart(12),
    );
  }

  console.log("");
  console.log(`合計 (Total): ${formatUSD(result.total.costUSD)} (${formatJPY(result.total.costJPY)}) / ${result.total.turns} turns`);
}

export async function runReport(argv: string[]): Promise<number> {
  const { days, json } = parseArgs(argv);
  const turns = readTurns(days);

  if (turns.length === 0) {
    console.log("履歴がありません(まだ1ターンも記録されていません)");
    return 0;
  }

  const result = aggregate(turns);

  if (json) {
    console.log(JSON.stringify({ days, daily: result.daily, byModel: result.byModel, total: result.total }, null, 2));
    return 0;
  }

  printTable(result, days);
  return 0;
}
