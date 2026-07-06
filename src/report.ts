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

/**
 * ターンの「モデル別コスト」を返す(実配分)。
 * rec.costByModel があり空でなければそれをそのまま返す。
 * 無ければ(旧レコード・後方互換)先頭モデルへ costUSD を全額帰属させるフォールバックを返す。
 */
function turnCostByModel(rec: TurnRecord): Record<string, number> {
  if (rec.costByModel && Object.keys(rec.costByModel).length > 0) return rec.costByModel;
  return { [rec.models[0] ?? "unknown"]: rec.costUSD };
}

/** ターンの総額(メイン + サブエージェント)。 */
function turnTotalUSD(rec: TurnRecord): number {
  return rec.costUSD + (rec.subagents?.costUSD ?? 0);
}

/** ターンの総額 JPY。SA 分は costUSD × fxRate で換算して costJPY に加える。 */
function turnTotalJPY(rec: TurnRecord): number {
  const sa = rec.subagents?.costUSD ?? 0;
  return rec.costJPY + sa * rec.fxRate;
}

/**
 * モデル別コスト(メイン実配分 + サブエージェント costByModel をマージ)。
 * turnCostByModel の結果を複製し、SA の各モデルコストを同一モデルへ加算する
 * (rec.costByModel を破壊しないため必ずコピーする)。
 */
function turnCostByModelWithSA(rec: TurnRecord): Record<string, number> {
  const base: Record<string, number> = { ...turnCostByModel(rec) };
  const sa = rec.subagents?.costByModel;
  if (sa) {
    for (const [model, usd] of Object.entries(sa)) {
      base[model] = (base[model] ?? 0) + usd;
    }
  }
  return base;
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
  turns: number; // 参加カウント(そのモデルが登場したターン数。複数モデルのターンは各モデル+1)
  costUSD: number;
  costJPY: number;
}

interface TotalAgg {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number; // SA 込みの総額
  costJPY: number; // SA 込みの総額
  subagentsUSD: number; // うちサブエージェント部分の合計(0 なら 0)
}

interface Aggregated {
  daily: DailyAgg[];
  byModel: Record<string, ModelAgg>;
  total: TotalAgg;
}

function aggregate(turns: TurnRecord[]): Aggregated {
  const dailyMap = new Map<string, DailyAgg>();
  // モデル別集計はターンごとの実配分(turnCostByModel)を合算する。costByModel が無い旧レコードは
  // 先頭モデル(主要モデル)にターン全体を帰属させるフォールバックになる。複数モデルのターンは
  // 各モデルの行に1ずつ計上する(参加カウント)ため、turns の合計は総ターン数を超えうる。
  const modelMap = new Map<string, ModelAgg>();

  const total: TotalAgg = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    costJPY: 0,
    subagentsUSD: 0,
  };

  for (const rec of turns) {
    const dateKey = localDateKey(rec.ts) ?? "unknown";
    const inTok = effectiveInputTokens(rec);
    const outTok = outputTokensOf(rec);
    // 日別・合計は SA 込みの総額で集計する(dashboard と同じ扱い)。
    const totalUsd = turnTotalUSD(rec);
    const totalJpy = turnTotalJPY(rec);
    const saUsd = rec.subagents?.costUSD ?? 0;

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
    d.costUSD += totalUsd;
    d.costJPY += totalJpy;
    dailyMap.set(dateKey, d);

    // モデル別: メイン実配分 + SA の costByModel をマージ(turnCostByModelWithSA)。
    for (const [model, modelUsd] of Object.entries(turnCostByModelWithSA(rec))) {
      const m = modelMap.get(model) ?? { turns: 0, costUSD: 0, costJPY: 0 };
      m.turns += 1;
      m.costUSD += modelUsd;
      m.costJPY += modelUsd * rec.fxRate;
      modelMap.set(model, m);
    }

    total.turns += 1;
    total.inputTokens += inTok;
    total.outputTokens += outTok;
    total.costUSD += totalUsd;
    total.costJPY += totalJpy;
    total.subagentsUSD += saUsd;
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
  if (result.total.subagentsUSD > 0) {
    console.log(`(うちサブエージェント ${formatUSD(result.total.subagentsUSD)})`);
  }

  console.log("");
  console.log("モデル別 (By model):");
  console.log("モデル".padEnd(28) + "ターン".padStart(8) + "USD".padStart(10) + "JPY".padStart(12));
  for (const [model, m] of Object.entries(result.byModel)) {
    console.log(
      model.padEnd(28) + String(m.turns).padStart(8) + formatUSD(m.costUSD).padStart(10) + formatJPY(m.costJPY).padStart(12),
    );
  }
  console.log("※ 複数モデルを使ったターンは各モデルの行に1ずつ計上します(ターン数の合計は総ターン数を超えることがあります)。");

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
