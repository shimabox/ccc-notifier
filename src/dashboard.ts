// src/dashboard.ts — `ccc-notifier dashboard` の実体。
//
// 全履歴を集計し、外部リクエスト 0 の完全自己完結な HTML ダッシュボードを 1 ファイル生成して
// (既定で)ブラウザで開く。日別コストは 日 / 週 / 月 の粒度をブラウザ側で切り替えられ、横スクロールで
// 過去まで遡れる。棒をクリックするとその期間が選択され、モデル別内訳・プロジェクト別・ターン履歴が
// 連動する(「通算」で全期間)。集計・描画はブラウザ側(埋め込み JSON + バニラ JS)で行い、生成物は
// CSS/JS/SVG をすべてインライン化した完全オフライン・外部通信ゼロのファイルにする。
//
// デザインは dataviz スキルの原則に準拠(固定スロット順の配色・2px サーフェスギャップ・常設凡例・
// 直接ラベル・表(table twin)・ライト/ダーク両テーマ)。

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatJPY, formatTokens, formatUSD, modelDisplayName } from "./format";
import { paths, readConfig, readTurns } from "./store";
import type { TokenBuckets, TurnRecord } from "./types";

const PROMPT_MAX = 10000;
const PROMPT_TRUNC_MARK = "…(以下略)";

// ============ 引数パース ============

interface DashboardOpts {
  days: number | null; // null = 全履歴
  open: boolean;
  out: string | null;
  autoReloadSec: number; // 生成 HTML の meta refresh 間隔秒。0 で無効。
}

/** --days の値をパースする。正の整数のみ採用。不正・未指定は null(=全履歴)。 */
function parseDays(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** --refresh の値をパースする。0 以上の整数のみ採用し、不正値は fallback(config 値)に倒す。 */
function parseRefresh(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): DashboardOpts {
  let days: number | null = null; // 既定は全履歴
  let open = true;
  let out: string | null = null;
  const cfgReloadSec = readConfig().dashboard.autoReloadSec;
  let autoReloadSec = cfgReloadSec;

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
    } else if (arg === "--no-refresh") {
      autoReloadSec = 0;
    } else if (arg === "--refresh") {
      autoReloadSec = parseRefresh(argv[i + 1], cfgReloadSec);
      i++;
    } else if (arg.startsWith("--refresh=")) {
      autoReloadSec = parseRefresh(arg.slice("--refresh=".length), cfgReloadSec);
    }
  }

  return { days, open, out, autoReloadSec };
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

/** HTML 用エスケープ(サーバ側で埋め込む静的テキスト向け)。 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

/** ターンの「モデル別コスト」(実配分)。旧レコードは先頭モデルへ全額帰属(後方互換)。 */
function turnCostByModel(rec: TurnRecord): Record<string, number> {
  if (rec.costByModel && Object.keys(rec.costByModel).length > 0) return rec.costByModel;
  return { [rec.models[0] ?? "unknown"]: rec.costUSD };
}

/** モデル別コスト(メイン実配分 + サブエージェント costByModel をマージ)。rec.costByModel は壊さない。 */
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

/** ターンの総額(メイン + サブエージェント)。 */
function turnTotalUSD(rec: TurnRecord): number {
  return rec.costUSD + (rec.subagents?.costUSD ?? 0);
}

function turnTotalJPY(rec: TurnRecord): number {
  const sa = rec.subagents?.costUSD ?? 0;
  return rec.costJPY + sa * rec.fxRate;
}

function truncatePrompt(raw: string): { text: string; truncated: boolean } {
  if (raw.length <= PROMPT_MAX) return { text: raw, truncated: false };
  return { text: raw.slice(0, PROMPT_MAX) + PROMPT_TRUNC_MARK, truncated: true };
}

// ============ モデル→スロット割当(全履歴基準・配色の安定化) ============

interface SlotDef {
  slot: string; // "1".."8" または "other"
  name: string;
}

interface SlotMap {
  slots: SlotDef[]; // 表示順(コスト降順の名前付き + 末尾 other)
  slotByModel: Map<string, string>; // 生モデルID → slot("1".."8")
  hasOther: boolean;
}

/**
 * 全履歴のモデル別総コストで上位を決め、固定スロット(色)を割り当てる。
 * 期間を切り替えても色がぶれないよう、スロットは全期間基準で一度だけ決める。
 * 9 種以上あるときは上位 7 + "その他"(other)。
 */
function computeSlotMap(turns: TurnRecord[]): SlotMap {
  const agg = new Map<string, number>();
  for (const rec of turns) {
    for (const [model, usd] of Object.entries(turnCostByModelWithSA(rec))) {
      agg.set(model, (agg.get(model) ?? 0) + usd);
    }
  }
  const entries = [...agg.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  let named = entries;
  let hasOther = false;
  if (entries.length > 8) {
    named = entries.slice(0, 7);
    hasOther = true;
  }

  const slots: SlotDef[] = named.map(([key], i) => ({ slot: String(i + 1), name: modelDisplayName(key) }));
  const slotByModel = new Map<string, string>();
  named.forEach(([key], i) => slotByModel.set(key, String(i + 1)));
  if (hasOther) slots.push({ slot: "other", name: "その他" });

  return { slots, slotByModel, hasOther };
}

/** 1 ターンの slot 別 USD(メイン実配分 + SA、上位外は other へ)。 */
function turnBySlot(rec: TurnRecord, map: SlotMap): Record<string, number> {
  const bs: Record<string, number> = {};
  for (const [model, usd] of Object.entries(turnCostByModelWithSA(rec))) {
    const slot = map.slotByModel.get(model) ?? "other";
    bs[slot] = (bs[slot] ?? 0) + usd;
  }
  return bs;
}

// ============ 埋め込みデータ ============

interface TurnEmbed {
  t: number; // ts の epoch ms(ブラウザ側のバケット分割用。ローカルTZは new Date(t) で解釈)
  ts: string; // 表示用ローカル日時
  p: string; // プロジェクト basename
  pf: string; // プロジェクトフルパス
  br: string | null;
  md: string; // モデル表示(+N / +SA サフィックス込み)
  mr: string[]; // 生モデルID配列
  ti: string; // in トークン(整形済み)
  to: string; // out トークン(整形済み)
  um: number; // メインのみ USD(履歴テーブルの $ 列)
  fx: number; // 為替レート
  bs: Record<string, number>; // slot → USD(SA 込み。チャート/内訳/プロジェクト集計用)
  pr: string; // プロンプト(最大 PROMPT_MAX 字 + マーク)
  tr: boolean; // 切り詰めたか
  sa: { usd: string; jpy: string; models: string; apiCalls: number } | null;
}

interface PeriodTotals {
  usd: number;
  jpy: number;
  turns: number;
}

function emptyTotals(): PeriodTotals {
  return { usd: 0, jpy: 0, turns: 0 };
}

function buildTurnEmbed(rec: TurnRecord, map: SlotMap): TurnEmbed {
  const raw = String(rec.prompt ?? "");
  const { text, truncated } = truncatePrompt(raw);
  const primary = rec.models[0] ?? "unknown";
  const extra = rec.models.length > 1 ? ` +${rec.models.length - 1}` : "";
  const saMark = rec.subagents ? " +SA" : "";
  let sa: TurnEmbed["sa"] = null;
  if (rec.subagents) {
    const saModels = Object.keys(rec.subagents.costByModel).map((m) => modelDisplayName(m));
    sa = {
      usd: formatUSD(rec.subagents.costUSD),
      jpy: formatJPY(rec.subagents.costUSD * rec.fxRate),
      models: saModels.join(", "),
      apiCalls: rec.subagents.apiCalls,
    };
  }
  const ms = Date.parse(rec.ts);
  return {
    t: Number.isFinite(ms) ? ms : 0,
    ts: fmtLocalDateTime(rec.ts),
    p: basename(rec.project) || rec.project || "(unknown)",
    pf: rec.project ?? "",
    br: rec.gitBranch,
    md: modelDisplayName(primary) + extra + saMark,
    mr: rec.models,
    ti: formatTokens(turnInputTokens(rec)),
    to: formatTokens(turnOutputTokens(rec)),
    um: rec.costUSD,
    fx: rec.fxRate,
    bs: turnBySlot(rec, map),
    pr: text,
    tr: truncated,
    sa,
  };
}

/** today / week / month / all のサマリ(SA 込み総額)。 */
function computeKpis(turns: TurnRecord[]): {
  today: PeriodTotals;
  week: PeriodTotals;
  month: PeriodTotals;
  all: PeriodTotals;
} {
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  const weekCutoff = now.getTime() - 7 * 86400000;

  const today = emptyTotals();
  const week = emptyTotals();
  const month = emptyTotals();
  const all = emptyTotals();

  for (const rec of turns) {
    const usd = turnTotalUSD(rec);
    const jpy = turnTotalJPY(rec);
    all.usd += usd;
    all.jpy += jpy;
    all.turns += 1;

    const dt = new Date(rec.ts);
    if (Number.isNaN(dt.getTime())) continue;
    if (dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d) {
      today.usd += usd;
      today.jpy += jpy;
      today.turns += 1;
    }
    if (dt.getTime() >= weekCutoff) {
      week.usd += usd;
      week.jpy += jpy;
      week.turns += 1;
    }
    if (dt.getFullYear() === y && dt.getMonth() === mo) {
      month.usd += usd;
      month.jpy += jpy;
      month.turns += 1;
    }
  }
  return { today, week, month, all };
}

// ============ スタイル ============

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

.toolbar-row{display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; margin:2px 0 12px;}
.seg-toggle{display:inline-flex; border:1px solid var(--border); border-radius:9px; overflow:hidden;}
.seg-toggle button{padding:6px 14px; background:var(--surface); color:var(--ink2); border:0; border-left:1px solid var(--border); cursor:pointer; font:inherit; font-size:13px;}
.seg-toggle button:first-child{border-left:0;}
.seg-toggle button.active{background:var(--s1); color:#fff;}
.btn{padding:6px 14px; border:1px solid var(--border); border-radius:9px; background:var(--surface); color:var(--ink2); cursor:pointer; font:inherit; font-size:13px;}
.btn.active{background:var(--s1); color:#fff; border-color:var(--s1);}
.sel-label{color:var(--ink2); font-size:13px; margin-left:auto; text-align:right; font-variant-numeric:tabular-nums;}
.sel-label b{color:var(--ink); font-weight:640;}

.legend{display:flex; flex-wrap:wrap; gap:8px 18px; margin:2px 0 14px;}
.legend-item{display:inline-flex; align-items:center; gap:7px; font-size:13px; color:var(--ink2);}
.swatch{display:inline-block; width:11px; height:11px; border-radius:3px; flex:0 0 auto;}
.k1{background:var(--s1);} .k2{background:var(--s2);} .k3{background:var(--s3);} .k4{background:var(--s4);}
.k5{background:var(--s5);} .k6{background:var(--s6);} .k7{background:var(--s7);} .k8{background:var(--s8);} .kother{background:var(--sother);}

.budget-bar{height:12px; background:var(--plane); border:1px solid var(--border); border-radius:7px; overflow:hidden; margin:12px 0;}
.budget-fill{height:100%; border-radius:6px; min-width:2px;}
.budget-fill.lvl-ok{background:var(--s2);}
.budget-fill.lvl-warn{background:var(--s3);}
.budget-fill.lvl-over{background:var(--s6);}
.budget-foot{display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; font-size:13px; color:var(--ink2);}
.budget-foot b{color:var(--ink); font-weight:660; font-variant-numeric:tabular-nums;}
.budget-pct{font-variant-numeric:tabular-nums; font-weight:640;}
.budget-pct.lvl-warn{color:var(--s3);}
.budget-pct.lvl-over{color:var(--s6);}

.chart{height:auto; display:block;}
.chart-scroll{overflow-x:auto;}
.seg.s1{fill:var(--s1);} .seg.s2{fill:var(--s2);} .seg.s3{fill:var(--s3);} .seg.s4{fill:var(--s4);}
.seg.s5{fill:var(--s5);} .seg.s6{fill:var(--s6);} .seg.s7{fill:var(--s7);} .seg.s8{fill:var(--s8);} .seg.sother{fill:var(--sother);}
.seg.dim{opacity:0.28;}
.grid-line{stroke:var(--grid); stroke-width:1;}
.axis-line{stroke:var(--axis); stroke-width:1;}
.tick-label{fill:var(--muted); font-size:11px; font-variant-numeric:tabular-nums;}
.bar-name{fill:var(--ink); font-size:13px; font-weight:550;}
.bar-val{fill:var(--ink2); font-size:12px; font-variant-numeric:tabular-nums;}
.acn-band{fill:transparent; cursor:pointer;}
.acn-band:hover{fill:var(--ink); fill-opacity:0.05;}
.acn-band.sel{fill:var(--s1); fill-opacity:0.10;}

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
.empty-hint{color:var(--muted); font-size:13px; padding:20px 0; text-align:center;}

.empty{background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:56px 24px; text-align:center; box-shadow:var(--shadow);}
.empty h2{font-size:20px; margin:0 0 8px;}
.empty p{color:var(--ink2); margin:4px 0;}

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
  .sel-label{margin-left:0;}
}
</style>`;

// ============ アプリ JS(全描画・期間集計をブラウザ側で行う) ============

const APP_JS = `<script>
(function(){
  var el = document.getElementById('acn-data');
  if(!el){ return; }
  var data;
  try { data = JSON.parse(el.textContent || '{}'); } catch(e){ return; }
  var turns = data.turns || [];
  var slots = data.slots || [];
  var slotOrder = slots.map(function(s){ return s.slot; });
  var slotName = {}; slots.forEach(function(s){ slotName[s.slot] = s.name; });

  // ---- 数値整形(サーバの format.ts と等価に移植)----
  function formatUSD(n){
    var v = n || 0;
    if(v >= 1) return '$' + v.toFixed(2);
    if(v >= 0.01) return '$' + v.toFixed(3);
    return '$' + v.toFixed(4);
  }
  function formatJPY(n){
    var v = n || 0;
    if(v >= 1) return '¥' + Math.round(v).toLocaleString('en-US');
    return '¥' + (Math.round(v * 10) / 10);
  }

  // ---- 日付/バケット(ローカルTZ)----
  function pad(n){ return (n < 10 ? '0' : '') + n; }
  function dkey(d){ return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
  function mondayOf(d){
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var wd = (x.getDay() + 6) % 7; // 月=0 .. 日=6
    x.setDate(x.getDate() - wd);
    return x;
  }
  function bucketKey(t, gran){
    var d = new Date(t);
    if(isNaN(d.getTime())) return null;
    if(gran === 'month') return d.getFullYear() + '-' + pad(d.getMonth()+1);
    if(gran === 'week') return dkey(mondayOf(d));
    return dkey(d);
  }
  function bucketLabel(key, gran){
    var p = key.split('-');
    if(gran === 'month') return p[0] + '/' + p[1];
    return p[1] + '/' + p[2] + (gran === 'week' ? '週' : '');
  }
  function periodText(key, gran){
    if(key === null) return '通算 / All time';
    if(gran === 'month') return key + ' (月)';
    if(gran === 'week') return key + ' の週';
    return key;
  }

  // ---- 状態(sessionStorage に保存し、自動リロード(meta refresh)を跨いでも維持)----
  function ssGet(k){ try { return sessionStorage.getItem(k); } catch(e){ return null; } }
  function ssSet(k, v){ try { sessionStorage.setItem(k, v); } catch(e){} }
  var GRAN = ssGet('acn-gran'); if(['day','week','month'].indexOf(GRAN) < 0) GRAN = 'day';
  // 既定は「起動した日」を初期選択する(未保存時)。明示的な通算は '__all__'、その他は保存キー。
  var storedSel = ssGet('acn-sel');
  var SEL = (storedSel === null) ? defaultSel(GRAN) : (storedSel === '__all__' ? null : storedSel);
  function setGran(g){ GRAN = g; ssSet('acn-gran', g); }
  function setSel(v){ SEL = v; ssSet('acn-sel', v === null ? '__all__' : v); }
  var lastRenderedGran = null; // 直前に描画した粒度。変わったとき(=バケット数が変わるとき)だけ右端へ寄せる。

  function buildBuckets(gran){
    var map = {}; var keys = [];
    for(var i=0;i<turns.length;i++){
      var tn = turns[i];
      var k = bucketKey(tn.t, gran);
      if(k === null) continue;
      var b = map[k];
      if(!b){ b = map[k] = { key:k, total:0, turns:0, bs:{} }; keys.push(k); }
      b.turns++;
      var bs = tn.bs || {};
      for(var s in bs){ if(bs.hasOwnProperty(s)){ b.bs[s] = (b.bs[s]||0) + bs[s]; b.total += bs[s]; } }
    }
    keys.sort();
    return keys.map(function(k){ return map[k]; });
  }

  // 起動時の既定選択: 起動日(今日)にデータがあればその日、無ければ直近のデータがある期間。
  // データが全く無ければ null(通算)。
  function defaultSel(gran){
    var buckets = buildBuckets(gran);
    if(buckets.length === 0) return null;
    var todayKey = bucketKey(Date.now(), gran);
    for(var i=0;i<buckets.length;i++){ if(buckets[i].key === todayKey) return todayKey; }
    return buckets[buckets.length - 1].key; // 最新のデータがある期間(バケットは昇順ソート済み)
  }

  function turnsInSelection(){
    if(SEL === null) return turns;
    return turns.filter(function(tn){ return bucketKey(tn.t, GRAN) === SEL; });
  }

  // ---- SVG ヘルパー ----
  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs){
    var e = document.createElementNS(SVGNS, tag);
    if(attrs){ for(var k in attrs){ if(attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]); } }
    return e;
  }
  function niceCeil(max){
    if(!(max > 0)) return 1;
    var pow = Math.pow(10, Math.floor(Math.log10(max)));
    var n = max / pow;
    var nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return nice * pow;
  }
  function f2(n){ return Math.round(n * 100) / 100; }
  function clearNode(node){ while(node.firstChild){ node.removeChild(node.firstChild); } }

  // ---- 日別/週別/月別 チャート ----
  var chartEl = document.getElementById('acn-chart');
  var tip = document.getElementById('acn-tip');

  function renderChart(){
    if(!chartEl) return;
    var scroller0 = chartEl.parentNode;
    var prevScroll = scroller0 ? scroller0.scrollLeft : 0; // clearNode 前に現在のスクロール位置を退避
    clearNode(chartEl);
    var buckets = buildBuckets(GRAN);
    if(buckets.length === 0){
      var p = document.createElement('p'); p.className = 'empty-hint';
      p.textContent = 'データがありません';
      chartEl.appendChild(p);
      return;
    }
    var H = 320, ml = 58, mr = 16, mt = 18, mb = 40;
    var plotH = H - mt - mb;
    var baseY = mt + plotH;
    var GAP = 2;
    var n = buckets.length;
    // 帯幅はコンテナ幅から決める: バケットが少なければ横幅いっぱいに広げ、多ければ最小幅で
    // 横スクロールさせる(svg 自身の px 幅で描くため .chart は width:100% にしない)。
    var scroller = chartEl.parentNode;
    var avail = (scroller && scroller.clientWidth) ? scroller.clientWidth : 900;
    var band = Math.max(28, Math.min(90, (avail - ml - mr) / n));
    var barW = Math.min(26, band * 0.7);
    var plotW = band * n;
    var W = ml + plotW + mr;

    var maxTotal = 0;
    buckets.forEach(function(b){ if(b.total > maxTotal) maxTotal = b.total; });
    var niceMax = niceCeil(maxTotal);
    var yscale = plotH / niceMax;
    // 選択中バケットが現在の粒度に存在するときだけ他を淡色化する(データ無しの日を選ぶと
    // 全部暗くなるのを避ける)。
    var selPresent = false;
    for(var sp=0; sp<buckets.length; sp++){ if(buckets[sp].key === SEL){ selPresent = true; break; } }

    var svg = svgEl('svg', { 'class':'chart', viewBox:'0 0 ' + W + ' ' + H, role:'img',
      'aria-label':'コスト積み上げ棒グラフ', preserveAspectRatio:'xMidYMid meet' });
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));

    var ticks = 5;
    for(var t=0;t<=ticks;t++){
      var val = niceMax * t / ticks;
      var yy = f2(baseY - val * yscale);
      svg.appendChild(svgEl('line', { 'class':'grid-line', x1:ml, y1:yy, x2:W-mr, y2:yy }));
      var lbl = svgEl('text', { 'class':'tick-label', x:ml-8, y:yy+4, 'text-anchor':'end' });
      lbl.textContent = formatUSD(val);
      svg.appendChild(lbl);
    }

    // ラベルは幅で間引く(帯幅よりラベルが広いと重なるため)。
    var labelPx = bucketLabel(buckets[0].key, GRAN).length * 7.5 + 8;
    var xStep = Math.max(1, Math.ceil(labelPx / band));
    for(var i=0;i<n;i++){
      var b = buckets[i];
      var cx = ml + band * (i + 0.5);
      var x = cx - barW/2;
      var dim = (SEL !== null && selPresent && b.key !== SEL);
      var cumV = 0;
      for(var j=0;j<slotOrder.length;j++){
        var slot = slotOrder[j];
        var v = b.bs[slot] || 0;
        if(v <= 0) continue;
        var vTop = cumV + v;
        var yTop = baseY - vTop * yscale;
        var yBot = baseY - cumV * yscale;
        if(cumV > 0) yBot -= GAP;
        cumV = vTop;
        var h = yBot - yTop;
        if(h <= 0.4) continue;
        var rect = svgEl('rect', { 'class':'seg s'+slot+(dim?' dim':''), x:f2(x), y:f2(yTop), width:f2(barW), height:f2(h) });
        svg.appendChild(rect);
      }
      if(i % xStep === 0 || i === n-1){
        var xl = svgEl('text', { 'class':'tick-label', x:f2(cx), y:baseY+16, 'text-anchor':'middle' });
        xl.textContent = bucketLabel(b.key, GRAN);
        svg.appendChild(xl);
      }
      var band2 = svgEl('rect', { 'class':'acn-band'+(b.key===SEL?' sel':''), x:f2(ml+band*i), y:mt, width:f2(band), height:plotH });
      band2.setAttribute('data-i', String(i));
      (function(bucket){
        band2.addEventListener('pointermove', function(e){ showTip(e, bucket); });
        band2.addEventListener('pointerenter', function(e){ showTip(e, bucket); });
        band2.addEventListener('pointerleave', function(){ if(tip) tip.hidden = true; });
        band2.addEventListener('click', function(){
          setSel(SEL === bucket.key ? null : bucket.key);
          if(tip) tip.hidden = true;
          render();
        });
      })(b);
      svg.appendChild(band2);
    }
    svg.appendChild(svgEl('line', { 'class':'axis-line', x1:ml, y1:baseY, x2:W-mr, y2:baseY }));
    chartEl.appendChild(svg);
    // スクロール位置: 初回はリロード跨ぎで復元(無ければ右端=最新)、粒度が変わったら右端、
    // それ以外(選択の変更など同一粒度の再描画)は直前のスクロール位置を維持する。
    var scroller = chartEl.parentNode;
    if(scroller){
      if(lastRenderedGran === null){
        var saved = parseInt(ssGet('acn-chart-scroll'), 10);
        scroller.scrollLeft = isNaN(saved) ? scroller.scrollWidth : saved;
      } else if(GRAN !== lastRenderedGran){
        scroller.scrollLeft = scroller.scrollWidth;
      } else {
        scroller.scrollLeft = prevScroll;
      }
    }
    lastRenderedGran = GRAN;
  }

  function showTip(evt, bucket){
    if(!tip) return;
    clearNode(tip);
    var h = document.createElement('div'); h.className = 'tip-title';
    h.textContent = periodText(bucket.key, GRAN) + '  合計 ' + formatUSD(bucket.total) + '  ·  ' + bucket.turns + ' ターン';
    tip.appendChild(h);
    for(var j=0;j<slotOrder.length;j++){
      var slot = slotOrder[j];
      var v = bucket.bs[slot] || 0;
      if(v <= 0) continue;
      var row = document.createElement('div'); row.className = 'tip-row';
      var key = document.createElement('span'); key.className = 'tip-key k'+slot;
      var name = document.createElement('span'); name.className = 'tip-name'; name.textContent = slotName[slot] || slot;
      var val = document.createElement('span'); val.className = 'tip-val'; val.textContent = formatUSD(v);
      row.appendChild(key); row.appendChild(name); row.appendChild(val);
      tip.appendChild(row);
    }
    tip.hidden = false;
    positionTip(evt);
  }
  function positionTip(evt){
    if(!tip) return;
    var pad = 14; var r = tip.getBoundingClientRect();
    var x = evt.clientX + pad, y = evt.clientY + pad;
    if(x + r.width > window.innerWidth - 8){ x = evt.clientX - r.width - pad; }
    if(y + r.height > window.innerHeight - 8){ y = evt.clientY - r.height - pad; }
    tip.style.left = (x < 8 ? 8 : x) + 'px';
    tip.style.top = (y < 8 ? 8 : y) + 'px';
  }

  // ---- モデル別内訳 ----
  var modelEl = document.getElementById('acn-bymodel');
  function renderByModel(sub){
    if(!modelEl) return;
    clearNode(modelEl);
    var usd = {}, jpy = {}, tcount = {}, total = 0;
    sub.forEach(function(tn){
      var bs = tn.bs || {}, fx = tn.fx || 0;
      for(var s in bs){ if(bs.hasOwnProperty(s) && bs[s] > 0){
        usd[s] = (usd[s]||0) + bs[s]; jpy[s] = (jpy[s]||0) + bs[s]*fx; total += bs[s];
        tcount[s] = (tcount[s]||0) + 1;
      } }
    });
    var table = document.createElement('table'); table.className = 'data-table';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>モデル / Model</th><th class="c-num">ターン</th><th class="c-num">$</th><th class="c-num">¥</th><th class="c-num">構成比</th></tr>';
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    var any = false;
    for(var j=0;j<slotOrder.length;j++){
      var slot = slotOrder[j];
      if(!(usd[slot] > 0)) continue;
      any = true;
      var share = total > 0 ? (usd[slot]/total*100) : 0;
      var tr = document.createElement('tr');
      var c1 = document.createElement('td'); c1.className = 'c-name';
      var sw = document.createElement('span'); sw.className = 'swatch k'+slot; c1.appendChild(sw);
      c1.appendChild(document.createTextNode(slotName[slot] || slot));
      var c2 = document.createElement('td'); c2.className = 'c-num'; c2.textContent = String(tcount[slot]||0);
      var c3 = document.createElement('td'); c3.className = 'c-num'; c3.textContent = formatUSD(usd[slot]);
      var c4 = document.createElement('td'); c4.className = 'c-num'; c4.textContent = formatJPY(jpy[slot]);
      var c5 = document.createElement('td'); c5.className = 'c-num'; c5.textContent = share.toFixed(1) + '%';
      tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3); tr.appendChild(c4); tr.appendChild(c5);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    if(!any){ var p = document.createElement('p'); p.className='empty-hint'; p.textContent='この期間のデータはありません'; modelEl.appendChild(p); return; }
    modelEl.appendChild(table);
  }

  // ---- プロジェクト別 ----
  var projEl = document.getElementById('acn-byproject');
  function renderByProject(sub){
    if(!projEl) return;
    clearNode(projEl);
    var agg = {};
    sub.forEach(function(tn){
      var bs = tn.bs || {}, fx = tn.fx || 0, total = 0;
      for(var s in bs){ if(bs.hasOwnProperty(s)) total += bs[s]; }
      var name = tn.p || '(unknown)';
      var a = agg[name] || (agg[name] = { usd:0, jpy:0, turns:0 });
      a.usd += total; a.jpy += total*fx; a.turns++;
    });
    var rows = Object.keys(agg).map(function(name){ var a = agg[name]; return { name:name, usd:a.usd, jpy:a.jpy, turns:a.turns }; });
    rows.sort(function(a,b){ return b.usd - a.usd || a.name.localeCompare(b.name); });
    if(rows.length === 0){ var p = document.createElement('p'); p.className='empty-hint'; p.textContent='この期間のデータはありません'; projEl.appendChild(p); return; }
    var table = document.createElement('table'); table.className = 'data-table';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>プロジェクト / Project</th><th class="c-num">ターン</th><th class="c-num">$</th><th class="c-num">¥</th></tr>';
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function(r){
      var tr = document.createElement('tr');
      var c1 = document.createElement('td'); c1.className='c-name'; c1.textContent = r.name;
      var c2 = document.createElement('td'); c2.className='c-num'; c2.textContent = String(r.turns);
      var c3 = document.createElement('td'); c3.className='c-num'; c3.textContent = formatUSD(r.usd);
      var c4 = document.createElement('td'); c4.className='c-num'; c4.textContent = formatJPY(r.jpy);
      tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3); tr.appendChild(c4);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    projEl.appendChild(table);
  }

  // ---- 月予算(選択中の月に連動)----
  var budgetEl = document.getElementById('acn-budget');
  var BUDGET = +data.budget || 0;
  var BUDGET_RATE = +data.budgetRate || 0;
  function monthKeyOf(t){ var d = new Date(t); if(isNaN(d.getTime())) return null; return d.getFullYear() + '-' + pad(d.getMonth()+1); }
  // 予算は「月」単位。選択中バケットが属する暦月を対象にする(通算のときは今月)。
  function targetMonthKey(){
    if(SEL === null) return monthKeyOf(Date.now());
    if(GRAN === 'month') return SEL;      // 既に YYYY-MM
    return SEL.slice(0, 7);               // YYYY-MM-DD -> YYYY-MM
  }
  function renderBudget(){
    if(!budgetEl || !(BUDGET > 0)) return;
    var mk = targetMonthKey();
    var usd = 0, jpy = 0;
    for(var i=0;i<turns.length;i++){
      var tn = turns[i];
      if(monthKeyOf(tn.t) !== mk) continue;
      var bs = tn.bs || {}, fx = tn.fx || 0;
      for(var s in bs){ if(bs.hasOwnProperty(s)){ usd += bs[s]; jpy += bs[s]*fx; } }
    }
    var pct = BUDGET > 0 ? (usd / BUDGET) * 100 : 0;
    var width = Math.max(0, Math.min(100, pct));
    var level = pct >= 100 ? 'over' : pct >= 70 ? 'warn' : 'ok';
    var budgetJpy = BUDGET * BUDGET_RATE;
    var curMonth = monthKeyOf(Date.now());
    var monthShort = (mk === curMonth) ? '今月' : mk;

    clearNode(budgetEl);
    var h = document.createElement('h2');
    h.textContent = '月予算 / Monthly budget';
    var sub = document.createElement('span'); sub.className = 'stat-sub';
    sub.textContent = ' ' + mk + (mk === curMonth ? '(今月)' : '');
    h.appendChild(sub);
    budgetEl.appendChild(h);

    var bar = document.createElement('div'); bar.className = 'budget-bar';
    var fill = document.createElement('div'); fill.className = 'budget-fill lvl-' + level;
    fill.style.width = width.toFixed(1) + '%';
    bar.appendChild(fill); budgetEl.appendChild(bar);

    var foot = document.createElement('div'); foot.className = 'budget-foot';
    var left = document.createElement('span');
    left.appendChild(document.createTextNode(monthShort + ' '));
    var b = document.createElement('b'); b.textContent = formatUSD(usd); left.appendChild(b);
    left.appendChild(document.createTextNode(' / ' + formatUSD(BUDGET) + ' '));
    var mut = document.createElement('span'); mut.className = 'muted';
    mut.textContent = '(' + formatJPY(jpy) + ' / ' + formatJPY(budgetJpy) + ')';
    left.appendChild(mut);
    var pctEl = document.createElement('span'); pctEl.className = 'budget-pct lvl-' + level;
    pctEl.textContent = pct.toFixed(1) + '% used';
    foot.appendChild(left); foot.appendChild(pctEl);
    budgetEl.appendChild(foot);
  }

  // ---- ターン履歴 ----
  // 全期間だと数千行になりページが極端に長く・重くなるため、DOM 描画は最大 HIST_CAP 件に抑える。
  // 検索は選択中の全ターンを対象にし、一致件数を件数表示に出す(先頭 HIST_CAP 件だけ描画)。
  var HIST_CAP = 200;
  var tbody = document.getElementById('turn-body');
  var search = document.getElementById('turn-search');
  var count = document.getElementById('turn-count');
  var histData = []; // 選択中の期間のターン(新しい順)

  function matchStr(t){
    return ((t.pr||'') + ' ' + (t.p||'') + ' ' + (t.pf||'') + ' ' + (t.md||'') + ' ' + ((t.mr||[]).join(' '))).toLowerCase();
  }

  function buildRow(t){
    var tr = document.createElement('tr');
    tr.className = 'turn-row'; tr.tabIndex = 0; tr.title = 'クリックで全文表示 / click to expand';
    function cell(text, cls){ var td = document.createElement('td'); if(cls) td.className = cls; td.textContent = text; tr.appendChild(td); return td; }
    cell(t.ts || '', 'c-time');
    cell(t.p || '', 'c-proj');
    cell(t.md || '', 'c-model');
    cell(t.ti || '', 'c-num');
    cell(t.to || '', 'c-num');
    cell(formatUSD(t.um || 0), 'c-num');
    cell(formatJPY((t.um || 0) * (t.fx || 0)), 'c-num');
    var full = t.pr || '';
    var head = full.length > 80 ? full.slice(0,80) + '…' : full;
    cell(head.length ? head : '(プロンプトなし)', 'c-prompt');

    var dtr = document.createElement('tr'); dtr.className = 'turn-detail'; dtr.hidden = true;
    var dtd = document.createElement('td'); dtd.colSpan = 8;
    var meta = document.createElement('div'); meta.className = 'detail-meta';
    var mp = [];
    if(t.pf) mp.push(t.pf);
    if(t.br) mp.push(t.br);
    if(t.mr && t.mr.length) mp.push(t.mr.join(', '));
    meta.textContent = mp.join('  ·  ');
    dtd.appendChild(meta);
    if(t.sa){
      var saLine = document.createElement('div'); saLine.className = 'detail-meta';
      saLine.textContent = 'サブエージェント: ' + (t.sa.usd||'') + '(' + (t.sa.jpy||'') + ')· ' + (t.sa.models||'') + ' · APIコール ' + (t.sa.apiCalls||0);
      dtd.appendChild(saLine);
    }
    var pre = document.createElement('div'); pre.className = 'detail-prompt';
    pre.textContent = full.length ? full : '(プロンプトなし)';
    dtd.appendChild(pre); dtr.appendChild(dtd);
    function toggle(){ dtr.hidden = !dtr.hidden; if(dtr.hidden) tr.classList.remove('open'); else tr.classList.add('open'); }
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', function(e){ if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggle(); } });
    tbody.appendChild(tr); tbody.appendChild(dtr);
  }

  function renderHistory(sub){
    if(!tbody) return;
    histData = sub.slice().sort(function(a,b){ return b.t - a.t; });
    applyFilter();
  }
  function applyFilter(){
    if(!tbody) return;
    clearNode(tbody);
    var q = ((search && search.value) || '').trim().toLowerCase();
    var matched = 0, shown = 0;
    for(var i=0;i<histData.length;i++){
      var t = histData[i];
      if(q && matchStr(t).indexOf(q) < 0) continue;
      matched++;
      if(shown < HIST_CAP){ buildRow(t); shown++; }
    }
    if(count){ count.textContent = (matched > shown) ? (matched + ' 件中 ' + shown + ' 件を表示') : (matched + ' 件'); }
  }

  // ---- 選択ラベル・コントロール ----
  var selLabelEl = document.getElementById('acn-sel-label');
  function updateSelLabel(sub){
    if(!selLabelEl) return;
    var usd = 0, jpy = 0;
    sub.forEach(function(tn){ var fx = tn.fx||0; var bs = tn.bs||{}; for(var s in bs){ if(bs.hasOwnProperty(s)){ usd += bs[s]; jpy += bs[s]*fx; } } });
    clearNode(selLabelEl);
    var b = document.createElement('b'); b.textContent = periodText(SEL, GRAN);
    selLabelEl.appendChild(b);
    selLabelEl.appendChild(document.createTextNode('  ' + formatUSD(usd) + ' · ' + formatJPY(jpy) + ' · ' + sub.length + ' ターン'));
  }
  function updateControls(){
    var gbtns = document.querySelectorAll('[data-gran]');
    for(var i=0;i<gbtns.length;i++){ gbtns[i].classList.toggle('active', gbtns[i].getAttribute('data-gran') === GRAN); }
    var allBtn = document.getElementById('acn-all');
    if(allBtn) allBtn.classList.toggle('active', SEL === null);
  }

  // ---- 全体レンダリング ----
  function render(){
    var sub = turnsInSelection();
    renderChart();
    renderBudget();
    renderByModel(sub);
    renderByProject(sub);
    renderHistory(sub);
    updateSelLabel(sub);
    updateControls();
  }

  // イベント配線。
  var gbtns = document.querySelectorAll('[data-gran]');
  for(var i=0;i<gbtns.length;i++){
    (function(btn){ btn.addEventListener('click', function(){ setGran(btn.getAttribute('data-gran')); setSel(null); render(); }); })(gbtns[i]);
  }
  var allBtn = document.getElementById('acn-all');
  if(allBtn) allBtn.addEventListener('click', function(){ setSel(null); render(); });
  if(search){
    var saved = ssGet('acn-search');
    if(saved !== null) search.value = saved;
    search.addEventListener('input', function(){ ssSet('acn-search', search.value); applyFilter(); });
  }

  render();

  // 自動リロードを跨いでスクロール位置を維持する(ロード時に復元 → 以後は保存のみ)。
  var savedScroll = ssGet('acn-scroll');
  if(savedScroll !== null){ var sy = parseInt(savedScroll, 10); if(!isNaN(sy)){ try { window.scrollTo(0, sy); } catch(e){} } }
  window.addEventListener('scroll', function(){ ssSet('acn-scroll', String(window.scrollY)); });

  // チャートの横スクロール位置も保存する(リロード跨ぎの復元用。復元は renderChart の初回で行う)。
  var chartScroller = chartEl ? chartEl.parentNode : null;
  if(chartScroller){ chartScroller.addEventListener('scroll', function(){ ssSet('acn-chart-scroll', String(chartScroller.scrollLeft)); }); }
})();
</script>`;

// ============ HTML 断片(サーバ描画・静的) ============

function statCard(label: string, sub: string, totals: PeriodTotals): string {
  return (
    `<div class="stat">` +
    `<div class="stat-label">${esc(label)}<span class="stat-sub">${esc(sub)}</span></div>` +
    `<div class="stat-value">${esc(formatUSD(totals.usd))}</div>` +
    `<div class="stat-meta">${esc(formatJPY(totals.jpy))} · ${totals.turns} ターン</div>` +
    `</div>`
  );
}

function renderLegend(slots: SlotDef[]): string {
  if (slots.length < 2) return "";
  const items = slots
    .map((m) => `<span class="legend-item"><span class="swatch k${m.slot}"></span>${esc(m.name)}</span>`)
    .join("");
  return `<div class="legend">${items}</div>`;
}

/**
 * 月予算カード。budgetUSD が 0 以下(未設定)なら空文字。
 * 当月(暦月)の使用額 / 予算 / 使用率(%)を、しきい値で色分けしたプログレスバーで表示する。
 */
function budgetCard(budgetUSD: number, month: PeriodTotals, fallbackRate: number): string {
  if (!(budgetUSD > 0)) return "";
  const pct = (month.usd / budgetUSD) * 100;
  const width = Math.max(0, Math.min(100, pct));
  const level = pct >= 100 ? "over" : pct >= 70 ? "warn" : "ok";
  const budgetJpy = budgetUSD * fallbackRate;
  // サーバは初期表示(当月)を描画し、ブラウザ側が選択中の月に合わせて #acn-budget を差し替える。
  return (
    `<section class="card" id="acn-budget">` +
    `<h2>月予算 / Monthly budget<span class="stat-sub"> 今月(暦月)</span></h2>` +
    `<div class="budget-bar"><div class="budget-fill lvl-${level}" style="width:${width.toFixed(1)}%"></div></div>` +
    `<div class="budget-foot">` +
    `<span>今月 <b>${esc(formatUSD(month.usd))}</b> / ${esc(formatUSD(budgetUSD))} ` +
    `<span class="muted">(${esc(formatJPY(month.jpy))} / ${esc(formatJPY(budgetJpy))})</span></span>` +
    `<span class="budget-pct lvl-${level}">${pct.toFixed(1)}% used</span>` +
    `</div>` +
    `</section>`
  );
}

// ============ フルページ組み立て ============

function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function renderDashboard(turns: TurnRecord[], opts: DashboardOpts): string {
  const version = readVersion();
  const generatedAt = fmtLocalDateTime(new Date().toISOString());
  const period = opts.days === null ? "全期間" : `直近 ${opts.days} 日間`;

  const map = computeSlotMap(turns);
  const kpi = computeKpis(turns);
  const cfg = readConfig();
  const budgetUSD = cfg.monthlyBudgetUSD;
  const turnsEmbed = turns.map((rec) => buildTurnEmbed(rec, map));
  const anyTruncated = turnsEmbed.some((t) => t.tr);
  const anySub = turns.some((r) => r.subagents);
  let subUsd = 0;
  let subJpy = 0;
  for (const r of turns) {
    if (r.subagents) {
      subUsd += r.subagents.costUSD;
      subJpy += r.subagents.costUSD * r.fxRate;
    }
  }

  // 日付レンジ(表示用)。
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const t of turnsEmbed) {
    if (t.t > 0) {
      if (t.t < minMs) minMs = t.t;
      if (t.t > maxMs) maxMs = t.t;
    }
  }
  const rangeText =
    Number.isFinite(minMs) && Number.isFinite(maxMs)
      ? `${dateKeyOf(new Date(minMs))} 〜 ${dateKeyOf(new Date(maxMs))}`
      : "—";

  const embed = {
    version,
    generatedAt,
    slots: map.slots,
    turns: turnsEmbed,
    budget: budgetUSD,
    budgetRate: cfg.fx.fallbackRate,
  };
  const dataJson = escapeJsonForScript(JSON.stringify(embed));

  const reloadSec =
    Number.isFinite(opts.autoReloadSec) && opts.autoReloadSec > 0 ? Math.floor(opts.autoReloadSec) : 0;
  const refreshMeta = reloadSec > 0 ? `<meta http-equiv="refresh" content="${reloadSec}">` : "";
  const autoUpdateFoot =
    reloadSec > 0
      ? `<div class="foot">約 ${reloadSec} 秒ごとに自動更新(最新化は Claude Code の応答完了時)</div>`
      : "";

  const head =
    `<!doctype html><html lang="ja"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark">` +
    refreshMeta +
    `<title>ccc-notifier ダッシュボード</title>` +
    STYLE +
    `</head><body><div class="wrap">`;

  const foot =
    autoUpdateFoot +
    `<div class="foot">ccc-notifier v${esc(version)} · データはローカルのみ / all data stays local</div>` +
    `</div>` +
    `<div id="acn-tip" class="acn-tip" hidden></div>` +
    `<script id="acn-data" type="application/json">${dataJson}</script>` +
    APP_JS +
    `</body></html>`;

  // ---- 0件: 空状態 ----
  if (turns.length === 0) {
    const header =
      `<div class="head"><div>` +
      `<h1>ccc-notifier ダッシュボード</h1>` +
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
    `<h1>ccc-notifier ダッシュボード</h1>` +
    `<div class="sub">${esc(period)}<span class="muted"> · ${esc(rangeText)}</span></div>` +
    `<div class="sub muted">生成 ${esc(generatedAt)} / generated</div>` +
    `</div>` +
    `<div class="hero">` +
    `<div class="hero-label">通算 / Total</div>` +
    `<div class="hero-value">${esc(formatUSD(kpi.all.usd))}</div>` +
    `<div class="hero-meta">${esc(formatJPY(kpi.all.jpy))} · ${kpi.all.turns} ターン</div>` +
    (anySub
      ? `<div class="hero-meta">うちサブエージェント ${esc(formatUSD(subUsd))}(${esc(formatJPY(subJpy))})</div>`
      : "") +
    `</div>` +
    `</div>`;

  // ---- KPI ----
  const kpiSection =
    `<div class="kpi">` +
    statCard("今日", "Today", kpi.today) +
    statCard("今週", "直近7日", kpi.week) +
    statCard("今月", "暦月", kpi.month) +
    statCard("通算", "全期間", kpi.all) +
    `</div>`;

  // ---- 月予算(設定時のみ)----
  const budgetSection = budgetCard(budgetUSD, kpi.month, cfg.fx.fallbackRate);

  // ---- 日別コスト(粒度切替・選択・通算) ----
  const chartSection =
    `<section class="card">` +
    `<h2>コスト推移 / Cost over time</h2>` +
    `<p class="note">粒度を 日 / 週 / 月 で切り替えられます(横スクロールで過去まで)。棒をクリックするとその期間が選択され、下のモデル別・プロジェクト別・履歴が連動します。「通算」で全期間に戻ります。モデル別に色分け。</p>` +
    `<div class="toolbar-row">` +
    `<div class="seg-toggle">` +
    `<button type="button" data-gran="day">日</button>` +
    `<button type="button" data-gran="week">週</button>` +
    `<button type="button" data-gran="month">月</button>` +
    `</div>` +
    `<button type="button" id="acn-all" class="btn">通算</button>` +
    `<span id="acn-sel-label" class="sel-label"></span>` +
    `</div>` +
    renderLegend(map.slots) +
    `<div class="chart-scroll"><div id="acn-chart"></div></div>` +
    `</section>`;

  // ---- モデル別 + プロジェクト別(選択連動) ----
  const breakdownSection =
    `<div class="grid2">` +
    `<section class="card">` +
    `<h2>モデル別内訳 / By model</h2>` +
    `<p class="note">選択中の期間(既定は通算)のコスト降順。複数モデルのターンは各モデルに1ずつ計上。</p>` +
    `<div class="table-wrap" id="acn-bymodel"></div>` +
    `</section>` +
    `<section class="card">` +
    `<h2>プロジェクト別 / By project</h2>` +
    `<p class="note">選択中の期間のプロジェクト(ディレクトリ basename)単位・コスト降順。</p>` +
    `<div class="table-wrap" id="acn-byproject"></div>` +
    `</section>` +
    `</div>`;

  // ---- ターン履歴 ----
  const capNote = "件数が多い場合は新しい順に先頭200件のみ描画します(検索や、上のグラフで期間を選ぶと絞り込めます)。";
  const truncNote = anyTruncated
    ? `<p class="note">選択中の期間のターンを新しい順に表示します。${capNote}プロンプトは1件あたり最大 ${PROMPT_MAX.toLocaleString("en-US")} 字まで(超過分は「${esc(PROMPT_TRUNC_MARK)}」)。行クリックで全文展開。</p>`
    : `<p class="note">選択中の期間のターンを新しい順に表示します。${capNote}行クリックでプロンプト全文を展開します。</p>`;
  const historySection =
    `<section class="card">` +
    `<h2>ターン履歴 / History</h2>` +
    truncNote +
    `<div class="toolbar">` +
    `<input id="turn-search" class="search" type="search" placeholder="プロンプト・プロジェクト・モデルで検索 / search…" autocomplete="off">` +
    `<span class="count"><span id="turn-count">0</span></span>` +
    `</div>` +
    `<div class="table-wrap"><table class="turns"><thead><tr>` +
    `<th>時刻</th><th>プロジェクト</th><th>モデル</th>` +
    `<th class="c-num">in</th><th class="c-num">out</th>` +
    `<th class="c-num">$</th><th class="c-num">¥</th><th>プロンプト</th>` +
    `</tr></thead><tbody id="turn-body"></tbody></table></div>` +
    `</section>`;

  return head + header + kpiSection + budgetSection + chartSection + breakdownSection + historySection + foot;
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

/**
 * ダッシュボード HTML を生成してファイルへ書き出す(副作用は書き込みのみ)。
 * days 省略(undefined)/ null で全履歴。console 出力・ブラウザ起動はしない。失敗は throw。
 */
export function writeDashboardHtml(opts: {
  days?: number | null;
  outPath: string;
  autoReloadSec: number;
}): void {
  const days = opts.days ?? null;
  const turns = readTurns(days ?? undefined);
  const html = renderDashboard(turns, {
    days,
    open: false,
    out: opts.outPath,
    autoReloadSec: opts.autoReloadSec,
  });
  mkdirSync(dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, html, "utf8");
}

export async function runDashboard(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);

  let outPath: string;
  try {
    outPath = opts.out ?? join(paths().home, "report.html");
    writeDashboardHtml({ days: opts.days, outPath, autoReloadSec: opts.autoReloadSec });
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
