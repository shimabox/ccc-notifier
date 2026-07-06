// src/dashboard.ts — `acn dashboard` の実体。
//
// readTurns(days) を集計し、外部リクエスト 0 の完全自己完結な HTML ダッシュボードを
// 1ファイル生成して(既定で)ブラウザで開く。テンプレートはこのモジュール内の文字列と
// して持ち、実行時にテンプレートファイルを探しに行かない(ビルド後も単一バンドルで完結)。
//
// デザインは dataviz スキルの原則に準拠:
//  - カテゴリカル配色は固定スロット順(reference palette)。順序が CVD 安全性の担保。
//  - 積み上げ/横棒はスロット順に隣接するため adjacent 検査でパス。2px のサーフェスギャップ・
//    常設凡例・直接ラベル・表(table twin)を二次エンコードとして必ず併置する。
//  - ライト/ダーク両テーマを @media (prefers-color-scheme) で選定(自動反転ではない)。

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatJPY, formatTokens, formatUSD, modelDisplayName } from "./format";
import { paths, readTurns } from "./store";
import type { TokenBuckets, TurnRecord } from "./types";

const DEFAULT_DAYS = 30;
const PROMPT_MAX = 10000;
const PROMPT_TRUNC_MARK = "…(以下略)";
const MAX_CHART_DAYS = 92; // 連続日数がこれを超えたら「データのある日」のみ描画に切替

// ============ 引数パース ============

interface DashboardOpts {
  days: number;
  open: boolean;
  out: string | null;
}

function parseDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DAYS;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAYS;
}

function parseArgs(argv: string[]): DashboardOpts {
  let days = DEFAULT_DAYS;
  let open = true;
  let out: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") {
      open = false;
    } else if (arg === "--days") {
      days = parseDays(argv[i + 1]);
      i++;
    } else if (arg.startsWith("--days=")) {
      days = parseDays(arg.slice("--days=".length));
    } else if (arg === "--out") {
      out = argv[i + 1] ?? null;
      i++;
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length) || null;
    }
  }

  return { days, open, out };
}

// ============ 小さなユーティリティ ============

/** package.json の version を読む(cli.ts と同じ戦略)。失敗時 "unknown"。 */
function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** HTML 用エスケープ(サーバ側で埋め込む動的テキスト向け)。 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** SVG 座標を短くする(小数2桁)。 */
function f2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** ローカルタイムゾーンの YYYY-MM-DD。パース不能なら null。 */
function localDateKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return dateKeyOf(d);
}

function dateKeyOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ローカルの "YYYY-MM-DD HH:mm"。表示用。 */
function fmtLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${dateKeyOf(d)} ${hh}:${mm}`;
}

function effectiveInputTokens(t: TokenBuckets | null): number {
  if (!t) return 0;
  return t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

function turnInputTokens(rec: TurnRecord): number {
  return effectiveInputTokens(rec.tokens) + effectiveInputTokens(rec.sidechainTokens);
}

function turnOutputTokens(rec: TurnRecord): number {
  return rec.tokens.output + (rec.sidechainTokens ? rec.sidechainTokens.output : 0);
}

/** min..max(いずれもローカル日付キー)を1日刻みで列挙する。 */
function fillDayKeys(min: string, max: string): string[] {
  const res: string[] = [];
  const cur = new Date(`${min}T00:00:00`);
  const end = new Date(`${max}T00:00:00`);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return [min];
  let guard = 0;
  while (cur.getTime() <= end.getTime() && guard < 4000) {
    res.push(dateKeyOf(cur));
    cur.setDate(cur.getDate() + 1);
    guard++;
  }
  return res;
}

// ============ 集計 ============

interface ModelSlot {
  key: string; // 生モデルID または "__other__"
  name: string; // 表示名
  slot: string; // "1".."8" または "other"
  cost: number;
  jpy: number;
  turns: number;
  usdFmt: string;
  jpyFmt: string;
  sharePct: number;
}

interface DailyModelPart {
  name: string;
  slot: string;
  value: number;
  usdFmt: string;
}

interface DailyDay {
  date: string;
  total: number;
  turns: number;
  usdFmt: string;
  jpyFmt: string;
  models: DailyModelPart[]; // スロット順、value>0 のみ
}

interface ProjRow {
  name: string;
  turns: number;
  cost: number;
  jpy: number;
  usdFmt: string;
  jpyFmt: string;
}

interface PeriodTotals {
  cost: number;
  jpy: number;
  turns: number;
}

interface TurnEmbed {
  tsLocal: string;
  project: string; // basename
  projectFull: string;
  branch: string | null;
  model: string; // 表示名(+ 追加数)
  modelsRaw: string[];
  tokInFmt: string;
  tokOutFmt: string;
  costUSD: number; // 生値(合計検証用)
  usd: string;
  jpy: string;
  prompt: string; // 最大 PROMPT_MAX 字 + マーク
  truncated: boolean;
}

interface Aggregated {
  totals: PeriodTotals;
  today: PeriodTotals;
  week: PeriodTotals;
  month: PeriodTotals;
  models: ModelSlot[];
  dayKeys: string[];
  daily: DailyDay[];
  projects: ProjRow[];
  turnsEmbed: TurnEmbed[];
  minDate: string | null;
  maxDate: string | null;
  anyTruncated: boolean;
  chartTruncatedDays: boolean;
}

function emptyTotals(): PeriodTotals {
  return { cost: 0, jpy: 0, turns: 0 };
}

function truncatePrompt(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= PROMPT_MAX) return { text: raw, truncated: false };
  return { text: raw.slice(0, PROMPT_MAX) + PROMPT_TRUNC_MARK, truncated: true };
}

function aggregate(turns: TurnRecord[]): Aggregated {
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  const weekCutoff = now.getTime() - 7 * 86400000;

  const totals = emptyTotals();
  const today = emptyTotals();
  const week = emptyTotals();
  const month = emptyTotals();

  const primaryAgg = new Map<string, { cost: number; jpy: number; turns: number }>();
  const projAgg = new Map<string, { cost: number; jpy: number; turns: number }>();

  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const rec of turns) {
    totals.cost += rec.costUSD;
    totals.jpy += rec.costJPY;
    totals.turns += 1;

    const dt = new Date(rec.ts);
    if (!Number.isNaN(dt.getTime())) {
      if (dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d) {
        today.cost += rec.costUSD;
        today.jpy += rec.costJPY;
        today.turns += 1;
      }
      if (dt.getTime() >= weekCutoff) {
        week.cost += rec.costUSD;
        week.jpy += rec.costJPY;
        week.turns += 1;
      }
      if (dt.getFullYear() === y && dt.getMonth() === mo) {
        month.cost += rec.costUSD;
        month.jpy += rec.costJPY;
        month.turns += 1;
      }
      const key = dateKeyOf(dt);
      if (minDate === null || key < minDate) minDate = key;
      if (maxDate === null || key > maxDate) maxDate = key;
    }

    const pm = rec.models[0] ?? "unknown";
    const pa = primaryAgg.get(pm) ?? { cost: 0, jpy: 0, turns: 0 };
    pa.cost += rec.costUSD;
    pa.jpy += rec.costJPY;
    pa.turns += 1;
    primaryAgg.set(pm, pa);

    const projName = basename(rec.project) || rec.project || "(unknown)";
    const px = projAgg.get(projName) ?? { cost: 0, jpy: 0, turns: 0 };
    px.cost += rec.costUSD;
    px.jpy += rec.costJPY;
    px.turns += 1;
    projAgg.set(projName, px);
  }

  // ---- モデルスロット割当(コスト降順、8超は上位7 + その他) ----
  const entries = [...primaryAgg.entries()].sort(
    (a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0]),
  );

  let named = entries;
  let other: { cost: number; jpy: number; turns: number } | null = null;
  if (entries.length > 8) {
    named = entries.slice(0, 7);
    other = entries.slice(7).reduce(
      (acc, [, v]) => ({
        cost: acc.cost + v.cost,
        jpy: acc.jpy + v.jpy,
        turns: acc.turns + v.turns,
      }),
      { cost: 0, jpy: 0, turns: 0 },
    );
  }

  const totalCostForShare = totals.cost;
  const models: ModelSlot[] = named.map(([key, v], i) => ({
    key,
    name: modelDisplayName(key),
    slot: String(i + 1),
    cost: v.cost,
    jpy: v.jpy,
    turns: v.turns,
    usdFmt: formatUSD(v.cost),
    jpyFmt: formatJPY(v.jpy),
    sharePct: totalCostForShare > 0 ? (v.cost / totalCostForShare) * 100 : 0,
  }));
  if (other) {
    models.push({
      key: "__other__",
      name: "その他",
      slot: "other",
      cost: other.cost,
      jpy: other.jpy,
      turns: other.turns,
      usdFmt: formatUSD(other.cost),
      jpyFmt: formatJPY(other.jpy),
      sharePct: totalCostForShare > 0 ? (other.cost / totalCostForShare) * 100 : 0,
    });
  }

  // 生モデルID -> {slot,name}
  const slotByModel = new Map<string, { slot: string; name: string }>();
  for (const m of models) {
    if (m.key !== "__other__") slotByModel.set(m.key, { slot: m.slot, name: m.name });
  }
  const otherSlot = other ? { slot: "other", name: "その他" } : null;

  // ---- 日別スタック ----
  const dayKeys = computeDayKeys(minDate, maxDate);
  const chartTruncatedDays =
    minDate !== null && maxDate !== null && fillDayKeys(minDate, maxDate).length > MAX_CHART_DAYS;

  const dayIndex = new Map<string, number>();
  dayKeys.forEach((k, i) => dayIndex.set(k, i));

  // date index -> slot -> {value,name,slot}
  const stacks: Array<Map<string, DailyModelPart>> = dayKeys.map(() => new Map());
  const dayTotals: number[] = dayKeys.map(() => 0);
  const dayTurns: number[] = dayKeys.map(() => 0);

  for (const rec of turns) {
    const key = localDateKey(rec.ts);
    if (key === null) continue;
    const idx = dayIndex.get(key);
    if (idx === undefined) continue;
    const pm = rec.models[0] ?? "unknown";
    const info = slotByModel.get(pm) ?? otherSlot ?? { slot: "other", name: "その他" };
    const bucket = stacks[idx];
    const cur = bucket.get(info.slot) ?? { name: info.name, slot: info.slot, value: 0, usdFmt: "" };
    cur.value += rec.costUSD;
    bucket.set(info.slot, cur);
    dayTotals[idx] += rec.costUSD;
    dayTurns[idx] += 1;
  }

  const slotOrder = models.map((m) => m.slot);
  const daily: DailyDay[] = dayKeys.map((date, i) => {
    const bucket = stacks[i];
    const parts: DailyModelPart[] = [];
    for (const slot of slotOrder) {
      const p = bucket.get(slot);
      if (p && p.value > 0) parts.push({ ...p, usdFmt: formatUSD(p.value) });
    }
    return {
      date,
      total: dayTotals[i],
      turns: dayTurns[i],
      usdFmt: formatUSD(dayTotals[i]),
      jpyFmt: "",
      models: parts,
    };
  });

  // ---- プロジェクト ----
  const projects: ProjRow[] = [...projAgg.entries()]
    .map(([name, v]) => ({
      name,
      turns: v.turns,
      cost: v.cost,
      jpy: v.jpy,
      usdFmt: formatUSD(v.cost),
      jpyFmt: formatJPY(v.jpy),
    }))
    .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));

  // ---- ターン履歴(新しい順) ----
  let anyTruncated = false;
  const sortedTurns = [...turns].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const turnsEmbed: TurnEmbed[] = sortedTurns.map((rec) => {
    const raw = String(rec.prompt ?? "");
    const { text, truncated } = truncatePrompt(raw);
    if (truncated) anyTruncated = true;
    const primary = rec.models[0] ?? "unknown";
    const extra = rec.models.length > 1 ? ` +${rec.models.length - 1}` : "";
    return {
      tsLocal: fmtLocalDateTime(rec.ts),
      project: basename(rec.project) || rec.project || "(unknown)",
      projectFull: rec.project ?? "",
      branch: rec.gitBranch,
      model: modelDisplayName(primary) + extra,
      modelsRaw: rec.models,
      tokInFmt: formatTokens(turnInputTokens(rec)),
      tokOutFmt: formatTokens(turnOutputTokens(rec)),
      costUSD: rec.costUSD,
      usd: formatUSD(rec.costUSD),
      jpy: formatJPY(rec.costJPY),
      prompt: text,
      truncated,
    };
  });

  return {
    totals,
    today,
    week,
    month,
    models,
    dayKeys,
    daily,
    projects,
    turnsEmbed,
    minDate,
    maxDate,
    anyTruncated,
    chartTruncatedDays,
  };
}

function computeDayKeys(minDate: string | null, maxDate: string | null): string[] {
  if (minDate === null || maxDate === null) return [];
  const filled = fillDayKeys(minDate, maxDate);
  if (filled.length <= MAX_CHART_DAYS) return filled;
  // 連続描画すると横に長すぎるため「データのある日」のみに退避
  return filled; // fillDayKeys は guard で 4000 日に制限済み。ここでは連続のまま返す。
}

// ============ SVG チャート(サーバ側描画) ============

function niceCeil(max: number): number {
  if (!(max > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
}

function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return (
    `M${f2(x)} ${f2(y + h)}` +
    `L${f2(x)} ${f2(y + rr)}` +
    `Q${f2(x)} ${f2(y)} ${f2(x + rr)} ${f2(y)}` +
    `L${f2(x + w - rr)} ${f2(y)}` +
    `Q${f2(x + w)} ${f2(y)} ${f2(x + w)} ${f2(y + rr)}` +
    `L${f2(x + w)} ${f2(y + h)} Z`
  );
}

function roundedRightRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w, h / 2));
  return (
    `M${f2(x)} ${f2(y)}` +
    `L${f2(x + w - rr)} ${f2(y)}` +
    `Q${f2(x + w)} ${f2(y)} ${f2(x + w)} ${f2(y + rr)}` +
    `L${f2(x + w)} ${f2(y + h - rr)}` +
    `Q${f2(x + w)} ${f2(y + h)} ${f2(x + w - rr)} ${f2(y + h)}` +
    `L${f2(x)} ${f2(y + h)} Z`
  );
}

/** 日別積み上げ棒グラフ(SVG 手書き)。モデル別に色分け。 */
function renderDailyChart(agg: Aggregated): string {
  const W = 960;
  const H = 340;
  const ml = 58;
  const mr = 16;
  const mt = 18;
  const mb = 40;
  const plotW = W - ml - mr;
  const plotH = H - mt - mb;
  const baseY = mt + plotH;
  const GAP = 2;

  const n = agg.dayKeys.length;
  const maxTotal = Math.max(0, ...agg.daily.map((x) => x.total));
  const niceMax = niceCeil(maxTotal);
  const yscale = plotH / niceMax;
  const band = plotW / Math.max(n, 1);
  const barW = Math.max(2, Math.min(24, band * 0.7));

  const parts: string[] = [];

  // y グリッド + ラベル
  const ticks = 5;
  for (let t = 0; t <= ticks; t++) {
    const val = (niceMax * t) / ticks;
    const yy = f2(baseY - val * yscale);
    parts.push(`<line class="grid-line" x1="${ml}" y1="${yy}" x2="${W - mr}" y2="${yy}"/>`);
    parts.push(
      `<text class="tick-label" x="${ml - 8}" y="${yy + 4}" text-anchor="end">${esc(formatUSD(val))}</text>`,
    );
  }

  // 列(スタック)
  const xLabelStep = Math.max(1, Math.ceil(n / 12));
  for (let i = 0; i < n; i++) {
    const day = agg.daily[i];
    const cx = ml + band * (i + 0.5);
    const x = cx - barW / 2;

    let cumV = 0;
    const stack = day.models;
    for (let j = 0; j < stack.length; j++) {
      const seg = stack[j];
      const vTop = cumV + seg.value;
      const yTop = baseY - vTop * yscale;
      let yBot = baseY - cumV * yscale;
      if (j > 0) yBot -= GAP; // セグメント間に 2px のサーフェスギャップ
      cumV = vTop;
      const h = yBot - yTop;
      if (h <= 0.4) continue;
      const isTop = j === stack.length - 1;
      const title = `<title>${esc(day.date)} · ${esc(seg.name)}: ${esc(seg.usdFmt)}</title>`;
      if (isTop) {
        parts.push(
          `<path class="seg s${seg.slot}" d="${roundedTopRect(x, yTop, barW, h, 4)}">${title}</path>`,
        );
      } else {
        parts.push(
          `<rect class="seg s${seg.slot}" x="${f2(x)}" y="${f2(yTop)}" width="${f2(barW)}" height="${f2(h)}">${title}</rect>`,
        );
      }
    }

    // x ラベル(間引き)
    if (i % xLabelStep === 0 || i === n - 1) {
      const label = day.date.slice(5).replace("-", "/");
      parts.push(
        `<text class="tick-label" x="${f2(cx)}" y="${baseY + 16}" text-anchor="middle">${esc(label)}</text>`,
      );
    }

    // ホバー用の透明バンド(ツールチップのヒットターゲット)
    parts.push(
      `<rect class="acn-band" x="${f2(ml + band * i)}" y="${mt}" width="${f2(band)}" height="${plotH}" data-i="${i}"/>`,
    );
  }

  // ベースライン
  parts.push(`<line class="axis-line" x1="${ml}" y1="${baseY}" x2="${W - mr}" y2="${baseY}"/>`);

  return (
    `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="日別コスト積み上げ棒グラフ" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg>`
  );
}

/** モデル別内訳 横棒(SVG 手書き)。 */
function renderModelBars(agg: Aggregated): string {
  const models = agg.models;
  if (models.length === 0) return "";
  const W = 960;
  const rowH = 38;
  const mt = 6;
  const mb = 6;
  const nameW = 150;
  const valW = 168;
  const gap = 14;
  const barX = nameW;
  const barMaxW = W - nameW - valW - gap;
  const maxCost = Math.max(0.0000001, ...models.map((m) => m.cost));
  const H = mt + mb + models.length * rowH;

  const parts: string[] = [];
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const y = mt + i * rowH;
    const barH = Math.min(22, rowH - 14);
    const by = y + (rowH - barH) / 2;
    const w = Math.max(2, (m.cost / maxCost) * barMaxW);
    const label = `${m.usdFmt} · ${m.sharePct.toFixed(1)}%`;
    const title = `<title>${esc(m.name)}: ${esc(m.usdFmt)}(${esc(m.jpyFmt)})· ${esc(m.sharePct.toFixed(1))}% · ${m.turns} ターン</title>`;
    // モデル名(テキストは ink トークン。色はバーが担う)
    parts.push(
      `<text class="bar-name" x="0" y="${f2(by + barH / 2 + 4)}">${esc(truncateLabel(m.name, 16))}</text>`,
    );
    // バー(データエンドの右側だけ 4px 角丸)
    parts.push(`<path class="seg s${m.slot}" d="${roundedRightRect(barX, by, w, barH, 4)}">${title}</path>`);
    // 値ラベル(右ガター、テキストトークン)
    parts.push(
      `<text class="bar-val" x="${W}" y="${f2(by + barH / 2 + 4)}" text-anchor="end">${esc(label)}</text>`,
    );
  }

  return (
    `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" ` +
    `aria-label="モデル別コスト内訳 横棒グラフ" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg>`
  );
}

function truncateLabel(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ============ HTML 断片 ============

function statCard(label: string, sub: string, totals: PeriodTotals): string {
  return (
    `<div class="stat">` +
    `<div class="stat-label">${esc(label)}<span class="stat-sub">${esc(sub)}</span></div>` +
    `<div class="stat-value">${esc(formatUSD(totals.cost))}</div>` +
    `<div class="stat-meta">${esc(formatJPY(totals.jpy))} · ${totals.turns} ターン</div>` +
    `</div>`
  );
}

function renderLegend(models: ModelSlot[]): string {
  if (models.length < 2) return "";
  const items = models
    .map((m) => `<span class="legend-item"><span class="swatch k${m.slot}"></span>${esc(m.name)}</span>`)
    .join("");
  return `<div class="legend">${items}</div>`;
}

function renderModelTable(models: ModelSlot[]): string {
  const rows = models
    .map(
      (m) =>
        `<tr><td class="c-name"><span class="swatch k${m.slot}"></span>${esc(m.name)}</td>` +
        `<td class="c-num">${m.turns}</td>` +
        `<td class="c-num">${esc(m.usdFmt)}</td>` +
        `<td class="c-num">${esc(m.jpyFmt)}</td>` +
        `<td class="c-num">${esc(m.sharePct.toFixed(1))}%</td></tr>`,
    )
    .join("");
  return (
    `<table class="data-table"><thead><tr>` +
    `<th>モデル / Model</th><th class="c-num">ターン</th><th class="c-num">$</th>` +
    `<th class="c-num">¥</th><th class="c-num">構成比</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

function renderProjectTable(projects: ProjRow[]): string {
  if (projects.length === 0) return `<p class="empty-hint">プロジェクトデータがありません。</p>`;
  const rows = projects
    .map(
      (p) =>
        `<tr><td class="c-name">${esc(p.name)}</td>` +
        `<td class="c-num">${p.turns}</td>` +
        `<td class="c-num">${esc(p.usdFmt)}</td>` +
        `<td class="c-num">${esc(p.jpyFmt)}</td></tr>`,
    )
    .join("");
  return (
    `<table class="data-table"><thead><tr>` +
    `<th>プロジェクト / Project</th><th class="c-num">ターン</th>` +
    `<th class="c-num">$</th><th class="c-num">¥</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

function renderDailyTable(daily: DailyDay[]): string {
  const withData = daily.filter((d) => d.turns > 0);
  const rows = withData
    .map(
      (d) =>
        `<tr><td class="c-name">${esc(d.date)}</td>` +
        `<td class="c-num">${d.turns}</td>` +
        `<td class="c-num">${esc(d.usdFmt)}</td></tr>`,
    )
    .join("");
  return (
    `<details class="table-twin"><summary>データを表で見る / Show as table</summary>` +
    `<table class="data-table"><thead><tr><th>日付 / Date</th>` +
    `<th class="c-num">ターン</th><th class="c-num">$</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></details>`
  );
}

// ============ スタイル(静的・補間なし) ============

const STYLE = `<style>
:root{
  color-scheme: light dark;
  --surface:#fcfcfb; --plane:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,0.10); --good:#006300;
  --s1:#2a78d6; --s2:#1baf7a; --s3:#eda100; --s4:#008300; --s5:#4a3aa7; --s6:#e34948; --s7:#e87ba4; --s8:#eb6834; --sother:#a7a69f;
  --shadow: 0 1px 2px rgba(11,11,11,0.04), 0 1px 3px rgba(11,11,11,0.06);
}
@media (prefers-color-scheme: dark){
  :root{
    --surface:#1a1a19; --plane:#0d0d0d; --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,0.10); --good:#0ca30c;
    --s1:#3987e5; --s2:#199e70; --s3:#c98500; --s4:#008300; --s5:#9085e9; --s6:#e66767; --s7:#d55181; --s8:#d95926; --sother:#6d6c66;
    --shadow: 0 1px 2px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.5);
  }
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{background:var(--plane); color:var(--ink); font-family: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; line-height:1.5; -webkit-font-smoothing:antialiased;}
.wrap{max-width:1120px; margin:0 auto; padding:24px 20px 72px;}
a{color:inherit;}

.head{display:flex; flex-wrap:wrap; gap:20px 32px; align-items:flex-end; justify-content:space-between; margin-bottom:24px;}
.head h1{font-size:22px; font-weight:650; margin:0 0 6px;}
.head .sub{color:var(--ink2); font-size:13px; margin:2px 0;}
.head .muted{color:var(--muted);}
.hero{text-align:right;}
.hero-label{color:var(--ink2); font-size:12px; letter-spacing:.02em; text-transform:uppercase;}
.hero-value{font-size:46px; font-weight:680; line-height:1.05; margin:2px 0;}
.hero-meta{color:var(--ink2); font-size:13px;}

.kpi{display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:28px;}
.stat{background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:16px 18px; box-shadow:var(--shadow);}
.stat-label{color:var(--ink2); font-size:13px; font-weight:600; display:flex; flex-wrap:wrap; align-items:baseline; gap:6px;}
.stat-sub{color:var(--muted); font-size:11px; font-weight:400;}
.stat-value{font-size:27px; font-weight:660; margin:8px 0 4px;}
.stat-meta{color:var(--muted); font-size:12px;}

section.card{background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:20px 22px; margin-bottom:22px; box-shadow:var(--shadow);}
section.card > h2{font-size:15px; font-weight:640; margin:0 0 4px;}
section.card > .note{color:var(--muted); font-size:12px; margin:0 0 14px;}

.legend{display:flex; flex-wrap:wrap; gap:8px 18px; margin:2px 0 14px;}
.legend-item{display:inline-flex; align-items:center; gap:7px; font-size:13px; color:var(--ink2);}
.swatch{display:inline-block; width:11px; height:11px; border-radius:3px; flex:0 0 auto;}
.k1{background:var(--s1);} .k2{background:var(--s2);} .k3{background:var(--s3);} .k4{background:var(--s4);}
.k5{background:var(--s5);} .k6{background:var(--s6);} .k7{background:var(--s7);} .k8{background:var(--s8);} .kother{background:var(--sother);}

.chart{width:100%; height:auto; display:block;}
.chart-scroll{overflow-x:auto;}
.seg.s1{fill:var(--s1);} .seg.s2{fill:var(--s2);} .seg.s3{fill:var(--s3);} .seg.s4{fill:var(--s4);}
.seg.s5{fill:var(--s5);} .seg.s6{fill:var(--s6);} .seg.s7{fill:var(--s7);} .seg.s8{fill:var(--s8);} .seg.sother{fill:var(--sother);}
.grid-line{stroke:var(--grid); stroke-width:1;}
.axis-line{stroke:var(--axis); stroke-width:1;}
.tick-label{fill:var(--muted); font-size:11px; font-variant-numeric:tabular-nums;}
.bar-name{fill:var(--ink); font-size:13px; font-weight:550;}
.bar-val{fill:var(--ink2); font-size:12px; font-variant-numeric:tabular-nums;}
.acn-band{fill:transparent; cursor:crosshair;}
.acn-band:hover{fill:var(--ink); fill-opacity:0.05;}

.grid2{display:grid; grid-template-columns:1.15fr 1fr; gap:22px; align-items:start;}

.data-table{width:100%; border-collapse:collapse; font-size:13px;}
.data-table th{ text-align:left; color:var(--muted); font-weight:600; font-size:12px; padding:6px 10px; border-bottom:1px solid var(--border); }
.data-table td{padding:7px 10px; border-bottom:1px solid var(--grid);}
.data-table tr:last-child td{border-bottom:none;}
.data-table .c-num{text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap;}
.data-table .c-name{display:flex; align-items:center; gap:8px;}
.table-twin{margin-top:14px;}
.table-twin summary{cursor:pointer; color:var(--ink2); font-size:12px; user-select:none;}
.table-twin[open] summary{margin-bottom:10px;}

.toolbar{display:flex; flex-wrap:wrap; gap:10px 16px; align-items:center; margin-bottom:14px;}
.search{flex:1 1 260px; min-width:200px; background:var(--plane); color:var(--ink); border:1px solid var(--border); border-radius:9px; padding:9px 12px; font-size:13px; font-family:inherit;}
.search::placeholder{color:var(--muted);}
.count{color:var(--muted); font-size:12px; white-space:nowrap;}

.turns{width:100%; border-collapse:collapse; font-size:13px;}
.turns th{ text-align:left; color:var(--muted); font-weight:600; font-size:12px; padding:8px 10px; border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--surface); }
.turns td{padding:8px 10px; border-bottom:1px solid var(--grid); vertical-align:top;}
.turns .c-num{text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap;}
.turns .c-time,.turns .c-model{white-space:nowrap;}
.turns .c-proj{max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.turns .c-prompt{color:var(--ink2);}
.turn-row{cursor:pointer;}
.turn-row:hover{background:color-mix(in srgb, var(--ink) 4%, transparent);}
.turn-row:focus-visible{outline:2px solid var(--s1); outline-offset:-2px;}
.turn-row.open{background:color-mix(in srgb, var(--ink) 5%, transparent);}
.turn-detail > td{background:var(--plane); color:var(--ink); border-bottom:1px solid var(--grid);}
.detail-meta{color:var(--muted); font-size:12px; margin-bottom:8px; word-break:break-all;}
.detail-prompt{white-space:pre-wrap; word-break:break-word; font-size:13px; line-height:1.55;}
.table-wrap{overflow-x:auto;}

.empty{background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:56px 24px; text-align:center; box-shadow:var(--shadow);}
.empty h2{font-size:20px; margin:0 0 8px;}
.empty p{color:var(--ink2); margin:4px 0;}
.empty-hint{color:var(--muted); font-size:13px;}

.foot{color:var(--muted); font-size:12px; margin-top:32px; text-align:center;}

.acn-tip{position:fixed; z-index:50; pointer-events:none; background:var(--surface); color:var(--ink); border:1px solid var(--border); border-radius:10px; box-shadow:var(--shadow); padding:9px 11px; font-size:12px; max-width:280px;}
.acn-tip .tip-title{font-weight:640; margin-bottom:6px; font-variant-numeric:tabular-nums;}
.acn-tip .tip-row{display:flex; align-items:center; gap:8px; margin:2px 0;}
.acn-tip .tip-key{display:inline-block; width:9px; height:9px; border-radius:2px; flex:0 0 auto;}
.acn-tip .tip-name{color:var(--ink2); flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.acn-tip .tip-val{font-variant-numeric:tabular-nums; font-weight:560;}

@media (max-width: 780px){
  .kpi{grid-template-columns:repeat(2,1fr);}
  .grid2{grid-template-columns:1fr;}
  .hero{text-align:left;}
  .head{align-items:flex-start;}
}
</style>`;

// ============ アプリ JS(静的・テンプレート補間なし・textContent 挿入) ============

const APP_JS = `<script>
(function(){
  var el = document.getElementById('acn-data');
  if(!el){ return; }
  var data;
  try { data = JSON.parse(el.textContent || '{}'); } catch(e){ return; }
  var turns = data.turns || [];
  var daily = data.daily || [];

  // ---- ターン履歴テーブル ----
  var tbody = document.getElementById('turn-body');
  var rows = [];
  function clearNode(node){ while(node.firstChild){ node.removeChild(node.firstChild); } }

  for (var i=0;i<turns.length;i++){
    (function(t){
      var tr = document.createElement('tr');
      tr.className = 'turn-row';
      tr.tabIndex = 0;
      tr.title = 'クリックで全文表示 / click to expand';
      function cell(text, cls){
        var td = document.createElement('td');
        if(cls){ td.className = cls; }
        td.textContent = text;
        tr.appendChild(td);
        return td;
      }
      cell(t.tsLocal || '', 'c-time');
      cell(t.project || '', 'c-proj');
      cell(t.model || '', 'c-model');
      cell(t.tokInFmt || '', 'c-num');
      cell(t.tokOutFmt || '', 'c-num');
      cell(t.usd || '', 'c-num');
      cell(t.jpy || '', 'c-num');
      var full = t.prompt || '';
      var head = full.length > 80 ? full.slice(0,80) + '…' : full;
      cell(head.length ? head : '(プロンプトなし)', 'c-prompt');

      var dtr = document.createElement('tr');
      dtr.className = 'turn-detail';
      dtr.hidden = true;
      var dtd = document.createElement('td');
      dtd.colSpan = 8;
      var meta = document.createElement('div');
      meta.className = 'detail-meta';
      var metaParts = [];
      if(t.projectFull){ metaParts.push(t.projectFull); }
      if(t.branch){ metaParts.push(t.branch); }
      if(t.modelsRaw && t.modelsRaw.length){ metaParts.push(t.modelsRaw.join(', ')); }
      meta.textContent = metaParts.join('  ·  ');
      var pre = document.createElement('div');
      pre.className = 'detail-prompt';
      pre.textContent = full.length ? full : '(プロンプトなし)';
      dtd.appendChild(meta);
      dtd.appendChild(pre);
      dtr.appendChild(dtd);

      function toggle(){
        dtr.hidden = !dtr.hidden;
        if(dtr.hidden){ tr.classList.remove('open'); } else { tr.classList.add('open'); }
      }
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', function(e){
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggle(); }
      });

      tbody.appendChild(tr);
      tbody.appendChild(dtr);

      var s = ((full) + ' ' + (t.project||'') + ' ' + (t.projectFull||'') + ' ' + (t.model||'') + ' ' + ((t.modelsRaw||[]).join(' '))).toLowerCase();
      rows.push({ tr: tr, dtr: dtr, s: s });
    })(turns[i]);
  }

  var search = document.getElementById('turn-search');
  var count = document.getElementById('turn-count');
  function applyFilter(){
    var q = ((search && search.value) || '').trim().toLowerCase();
    var shown = 0;
    for (var i=0;i<rows.length;i++){
      var match = !q || rows[i].s.indexOf(q) >= 0;
      rows[i].tr.hidden = !match;
      if(!match){ rows[i].dtr.hidden = true; rows[i].tr.classList.remove('open'); }
      if(match){ shown++; }
    }
    if(count){ count.textContent = shown + ' 件'; }
  }
  if(search){ search.addEventListener('input', applyFilter); }
  applyFilter();

  // ---- 日別チャートのツールチップ ----
  var tip = document.getElementById('acn-tip');
  function showTip(evt, idx){
    var d = daily[idx];
    if(!d || !tip){ return; }
    clearNode(tip);
    var h = document.createElement('div');
    h.className = 'tip-title';
    h.textContent = d.date + '  合計 ' + (d.usdFmt || '') + '  ·  ' + (d.turns||0) + ' ターン';
    tip.appendChild(h);
    var models = d.models || [];
    if(models.length === 0){
      var none = document.createElement('div');
      none.className = 'tip-row';
      none.textContent = '(コストなし)';
      tip.appendChild(none);
    }
    for (var i=0;i<models.length;i++){
      var row = document.createElement('div');
      row.className = 'tip-row';
      var key = document.createElement('span');
      key.className = 'tip-key k' + models[i].slot;
      var name = document.createElement('span');
      name.className = 'tip-name';
      name.textContent = models[i].name;
      var val = document.createElement('span');
      val.className = 'tip-val';
      val.textContent = models[i].usdFmt;
      row.appendChild(key);
      row.appendChild(name);
      row.appendChild(val);
      tip.appendChild(row);
    }
    tip.hidden = false;
    positionTip(evt);
  }
  function positionTip(evt){
    if(!tip){ return; }
    var pad = 14;
    var r = tip.getBoundingClientRect();
    var x = evt.clientX + pad;
    var y = evt.clientY + pad;
    if(x + r.width > window.innerWidth - 8){ x = evt.clientX - r.width - pad; }
    if(y + r.height > window.innerHeight - 8){ y = evt.clientY - r.height - pad; }
    tip.style.left = (x < 8 ? 8 : x) + 'px';
    tip.style.top = (y < 8 ? 8 : y) + 'px';
  }
  var bands = document.querySelectorAll('.acn-band');
  for (var b=0;b<bands.length;b++){
    (function(band){
      var idx = parseInt(band.getAttribute('data-i'), 10);
      band.addEventListener('pointermove', function(e){ showTip(e, idx); });
      band.addEventListener('pointerenter', function(e){ showTip(e, idx); });
      band.addEventListener('pointerleave', function(){ if(tip){ tip.hidden = true; } });
    })(bands[b]);
  }
})();
</script>`;

// ============ フルページ組み立て ============

function escapeJsonForScript(json: string): string {
  // type="application/json" は実行されないが、</script> による脱出を防ぐため '<' を < に
  // エスケープする。U+2028/U+2029 も念のためエスケープ。
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function periodLabel(days: number): string {
  return days >= 3650 ? "全期間" : `直近 ${days} 日間`;
}

function renderDashboard(turns: TurnRecord[], opts: DashboardOpts): string {
  const version = readVersion();
  const agg = aggregate(turns);
  const generatedAt = fmtLocalDateTime(new Date().toISOString());
  const period = periodLabel(opts.days);
  const rangeText =
    agg.minDate && agg.maxDate
      ? agg.minDate === agg.maxDate
        ? agg.minDate
        : `${agg.minDate} 〜 ${agg.maxDate}`
      : "—";

  // 埋め込みデータ(#acn-data)。プロンプト等のユーザーデータはここにのみ入れ、描画は textContent。
  const embed = {
    version,
    generatedAt,
    period,
    days: opts.days,
    totals: agg.totals,
    daily: agg.daily.map((d) => ({
      date: d.date,
      turns: d.turns,
      usdFmt: d.usdFmt,
      models: d.models.map((m) => ({ name: m.name, slot: m.slot, usdFmt: m.usdFmt })),
    })),
    turns: agg.turnsEmbed,
  };
  const dataJson = escapeJsonForScript(JSON.stringify(embed));

  const head =
    `<!doctype html><html lang="ja"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark">` +
    `<title>agent-cost-notifier ダッシュボード</title>` +
    STYLE +
    `</head><body><div class="wrap">`;

  const foot =
    `<div class="foot">agent-cost-notifier v${esc(version)} · データはローカルのみ / all data stays local</div>` +
    `</div>` +
    `<div id="acn-tip" class="acn-tip" hidden></div>` +
    `<script id="acn-data" type="application/json">${dataJson}</script>` +
    APP_JS +
    `</body></html>`;

  // ---- 0件: 空状態 ----
  if (turns.length === 0) {
    const header =
      `<div class="head"><div>` +
      `<h1>agent-cost-notifier ダッシュボード</h1>` +
      `<div class="sub">${esc(period)} · 生成 ${esc(generatedAt)}</div>` +
      `</div></div>`;
    const empty =
      `<div class="empty">` +
      `<h2>まだ履歴がありません</h2>` +
      `<p>Claude Code でプロンプトを実行すると、ここにコスト履歴が表示されます。</p>` +
      `<p class="empty-hint">No history yet — run a prompt in Claude Code and it will appear here.</p>` +
      `</div>`;
    return head + header + empty + foot;
  }

  // ---- ヘッダー ----
  const header =
    `<div class="head">` +
    `<div>` +
    `<h1>agent-cost-notifier ダッシュボード</h1>` +
    `<div class="sub">${esc(period)}<span class="muted"> · ${esc(rangeText)}</span></div>` +
    `<div class="sub muted">生成 ${esc(generatedAt)} / generated</div>` +
    `</div>` +
    `<div class="hero">` +
    `<div class="hero-label">合計 / Total</div>` +
    `<div class="hero-value">${esc(formatUSD(agg.totals.cost))}</div>` +
    `<div class="hero-meta">${esc(formatJPY(agg.totals.jpy))} · ${agg.totals.turns} ターン</div>` +
    `</div>` +
    `</div>`;

  // ---- KPI ----
  const kpi =
    `<div class="kpi">` +
    statCard("今日", "Today", agg.today) +
    statCard("今週", "直近7日", agg.week) +
    statCard("今月", "暦月", agg.month) +
    statCard("期間合計", period, agg.totals) +
    `</div>`;

  // ---- 日別チャート ----
  const dailyNote = agg.chartTruncatedDays
    ? `期間が広いため棒が細く表示されます(チャートは横スクロールできます)。`
    : `各ターンのコストを主要モデル(先頭)に帰属させる簡易集計です。`;
  const dailySection =
    `<section class="card">` +
    `<h2>日別コスト / Daily cost</h2>` +
    `<p class="note">${esc(dailyNote)} モデル別に色分け。棒にカーソルを合わせると内訳を表示します。</p>` +
    renderLegend(agg.models) +
    `<div class="chart-scroll">${renderDailyChart(agg)}</div>` +
    renderDailyTable(agg.daily) +
    `</section>`;

  // ---- モデル別 + プロジェクト別 ----
  const breakdownSection =
    `<div class="grid2">` +
    `<section class="card">` +
    `<h2>モデル別内訳 / By model</h2>` +
    `<p class="note">コスト降順。バー長=コスト、右の数値は $ と構成比。</p>` +
    `<div class="chart-scroll">${renderModelBars(agg)}</div>` +
    `<div class="table-wrap">${renderModelTable(agg.models)}</div>` +
    `</section>` +
    `<section class="card">` +
    `<h2>プロジェクト別 / By project</h2>` +
    `<p class="note">プロジェクト名(ディレクトリ basename)単位・コスト降順。</p>` +
    `<div class="table-wrap">${renderProjectTable(agg.projects)}</div>` +
    `</section>` +
    `</div>`;

  // ---- ターン履歴 ----
  const truncNote = agg.anyTruncated
    ? `<p class="note">※ プロンプトは1件あたり最大 ${PROMPT_MAX.toLocaleString("en-US")} 字まで表示します(超過分は「${esc(PROMPT_TRUNC_MARK)}」と表示)。</p>`
    : `<p class="note">行をクリックするとプロンプト全文を展開します。プロンプトは最大 ${PROMPT_MAX.toLocaleString("en-US")} 字まで保存・表示します。</p>`;
  const historySection =
    `<section class="card">` +
    `<h2>ターン履歴 / History</h2>` +
    truncNote +
    `<div class="toolbar">` +
    `<input id="turn-search" class="search" type="search" placeholder="プロンプト・プロジェクト・モデルで検索 / search…" autocomplete="off">` +
    `<span class="count"><span id="turn-count">${agg.turnsEmbed.length}</span></span>` +
    `</div>` +
    `<div class="table-wrap"><table class="turns"><thead><tr>` +
    `<th>時刻</th><th>プロジェクト</th><th>モデル</th>` +
    `<th class="c-num">in</th><th class="c-num">out</th>` +
    `<th class="c-num">$</th><th class="c-num">¥</th><th>プロンプト</th>` +
    `</tr></thead><tbody id="turn-body"></tbody></table></div>` +
    `</section>`;

  return head + header + kpi + dailySection + breakdownSection + historySection + foot;
}

// ============ ブラウザ起動 ============

function openInBrowser(path: string): void {
  try {
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === "darwin") {
      cmd = "open";
      args = [path];
    } else if (platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", path];
    } else {
      cmd = "xdg-open";
      args = [path];
    }
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // 起動失敗しても致命的ではない(パスは既に表示済み)
    });
    child.unref();
  } catch {
    // spawn 自体が失敗しても exit 0 を維持
  }
}

// ============ エントリ ============

export async function runDashboard(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);

  let outPath: string;
  try {
    outPath = opts.out ?? join(paths().home, "report.html");
    const turns = readTurns(opts.days);
    const html = renderDashboard(turns, opts);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, "utf8");
  } catch (err) {
    console.error(
      `dashboard の生成に失敗しました / failed to generate dashboard: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  console.log(`ダッシュボードを生成しました / dashboard written: ${outPath}`);
  if (opts.open) {
    openInBrowser(outPath);
    console.log("ブラウザで開いています… / opening in your browser…");
  }
  return 0;
}
