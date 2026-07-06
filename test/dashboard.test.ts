// test/dashboard.test.ts
//
// runDashboard を直接 import し、一時 ACN_HOME に seed した履歴から生成される HTML を
// 検証する。ブラウザは常に --no-open で開かない。
//
// 検証観点(タスク仕様):
//  1. exit 0 & report.html 生成
//  2. 埋め込み JSON(#acn-data)をパースでき、合計 costUSD が seed 合計と一致
//  3. 外部参照ゼロ(src="http / href="http / @import が無い)
//  4. </script> 脱出防止(#acn-data 内に生の </script が無い)
//  5. 危険プロンプトが実行可能な形で埋め込まれていない(<script>alert が #acn-data の外に現れない)
//  6. 10,000字超プロンプトが切り詰められ「…(以下略)」が付く
//  7. --out 指定 / --days フィルタ
//  8. 0件時も exit 0 で「まだ履歴がありません」

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDashboard } from "../src/dashboard";
import { formatUSD } from "../src/format";
import { appendTurn } from "../src/store";
import type { TurnRecord } from "../src/types";

const DAY = 86_400_000;
const HOUR = 3_600_000;

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.ACN_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "acn-dashboard-test-"));
  process.env.ACN_HOME = tmpHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.ACN_HOME;
  else process.env.ACN_HOME = prevHome;
});

/** console.log/console.error を抑制しつつ runDashboard を実行し、終了コードを返す。 */
async function run(argv: string[]): Promise<number> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return await runDashboard(argv);
}

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    sessionId: "sess",
    project: "/home/me/alpha",
    gitBranch: "main",
    models: ["claude-fable-5"],
    tokens: { input: 1200, output: 480, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 800 },
    sidechainTokens: null,
    apiCalls: 1,
    costUSD: 0.12,
    costJPY: 18,
    fxRate: 150,
    fxSource: "fixed",
    prompt: "テストプロンプト",
    ...overrides,
  };
}

const DANGEROUS_PROMPT = "<script>alert(1)</script>\nバグを直してください <b>太字</b> & <img src=x>";
const HUGE_TAIL = "TAILMARKER_END";

/**
 * 標準シナリオ(3モデル・3プロジェクト・複数日・危険プロンプト・10,000字超、計10件)を seed し、
 * seed した costUSD の合計を返す。すべて直近48時間内(既定30日窓・--days>=2 に収まる)。
 */
function seedStandard(): number {
  const now = Date.now();
  const recs: TurnRecord[] = [
    // 危険プロンプト(今日)
    makeTurn({
      ts: new Date(now - 1 * HOUR).toISOString(),
      models: ["claude-fable-5"],
      project: "/home/me/alpha",
      prompt: DANGEROUS_PROMPT,
      costUSD: 0.12,
      costJPY: 18,
    }),
    // 10,000字超(今日)
    makeTurn({
      ts: new Date(now - 2 * HOUR).toISOString(),
      models: ["claude-sonnet-5"],
      project: "/home/me/beta",
      prompt: "あ".repeat(10_050) + HUGE_TAIL,
      costUSD: 0.34,
      costJPY: 51,
    }),
    makeTurn({
      ts: new Date(now - 3 * HOUR).toISOString(),
      models: ["claude-fable-5"],
      project: "/home/me/beta",
      prompt: "small change",
      costUSD: 0.0009,
      costJPY: 0.135,
    }),
    makeTurn({
      ts: new Date(now - 5 * HOUR).toISOString(),
      models: ["claude-3-5-haiku"],
      project: "/home/me/gamma",
      prompt: "ドキュメントを書いて",
      costUSD: 0.02,
      costJPY: 3,
    }),
    // 昨日
    makeTurn({
      ts: new Date(now - 1 * DAY - 2 * HOUR).toISOString(),
      models: ["claude-fable-5"],
      project: "/home/me/alpha",
      prompt: "yesterday work",
      costUSD: 0.08,
      costJPY: 12,
    }),
    makeTurn({
      ts: new Date(now - 1 * DAY - 6 * HOUR).toISOString(),
      models: ["claude-sonnet-5"],
      project: "/home/me/gamma",
      prompt: "設計レビュー",
      costUSD: 0.21,
      costJPY: 31.5,
    }),
    // 一昨日
    makeTurn({
      ts: new Date(now - 2 * DAY - 3 * HOUR).toISOString(),
      models: ["claude-3-5-haiku"],
      project: "/home/me/alpha",
      prompt: "テスト追加",
      costUSD: 0.03,
      costJPY: 4.5,
    }),
    makeTurn({
      ts: new Date(now - 2 * DAY - 5 * HOUR).toISOString(),
      models: ["claude-fable-5"],
      project: "/home/me/beta",
      prompt: "リファクタ",
      costUSD: 0.15,
      costJPY: 22.5,
    }),
    makeTurn({
      ts: new Date(now - 2 * DAY - 8 * HOUR).toISOString(),
      models: ["claude-sonnet-5"],
      project: "/home/me/alpha",
      prompt: "パフォーマンス調査",
      costUSD: 0.27,
      costJPY: 40.5,
    }),
    makeTurn({
      ts: new Date(now - 2 * DAY - 10 * HOUR).toISOString(),
      models: ["claude-3-5-haiku", "claude-fable-5"],
      project: "/home/me/gamma",
      prompt: "複数モデルのターン",
      costUSD: 0.06,
      costJPY: 9,
    }),
  ];

  let total = 0;
  for (const r of recs) {
    appendTurn(r);
    total += r.costUSD;
  }
  return total;
}

function readHtml(path = join(tmpHome, "report.html")): string {
  return readFileSync(path, "utf8");
}

const ACN_DATA_OPEN = '<script id="acn-data" type="application/json">';

/** #acn-data の生テキスト(エスケープ済み JSON 文字列)を取り出す。 */
function extractDataRaw(html: string): string {
  const i = html.indexOf(ACN_DATA_OPEN);
  expect(i).toBeGreaterThanOrEqual(0);
  const start = i + ACN_DATA_OPEN.length;
  const end = html.indexOf("</script>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

interface EmbedTurn {
  costUSD: number;
  prompt: string;
  model: string;
}
interface Embed {
  turns: EmbedTurn[];
  totals: { cost: number; turns: number };
  daily: unknown[];
}

/** #acn-data をパースして埋め込みオブジェクトを返す(< 等は JSON.parse が復元する)。 */
function parseData(html: string): Embed {
  return JSON.parse(extractDataRaw(html)) as Embed;
}

interface EmbedDailyModel {
  name: string;
  slot: string;
  usdFmt: string;
}
interface EmbedDaily {
  date: string;
  turns: number;
  usdFmt: string;
  models: EmbedDailyModel[];
}

/** #acn-data の daily 配列を(モデル内訳込みで)取り出す。parseData の Embed 型は daily を unknown[] にしているため、ここで具体的な形へキャストする。 */
function parseDailyData(html: string): EmbedDaily[] {
  return parseData(html).daily as unknown as EmbedDaily[];
}

/**
 * 「モデル別内訳」card 内の data-table から $ 表示のコスト列だけを抜き出す
 * (ターン数・¥・構成比%の各セルは先頭文字が異なるため regex で除外される)。
 */
function extractModelTableUsd(html: string): number[] {
  const marker = "モデル別内訳 / By model</h2>";
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const tableStart = html.indexOf('<table class="data-table">', start);
  expect(tableStart).toBeGreaterThan(start);
  const tableEnd = html.indexOf("</table>", tableStart);
  expect(tableEnd).toBeGreaterThan(tableStart);
  const tableHtml = html.slice(tableStart, tableEnd);
  const matches = [...tableHtml.matchAll(/<td class="c-num">\$([\d,]+\.?\d*)<\/td>/g)];
  return matches.map((m) => Number(m[1].replace(/,/g, "")));
}

/** renderDailyChart(aria-label="日別コスト積み上げ棒グラフ")の SVG 断片だけを取り出す。 */
function extractDailyChartSvg(html: string): string {
  const m = html.match(/<svg[^>]*aria-label="日別コスト積み上げ棒グラフ"[\s\S]*?<\/svg>/);
  expect(m).toBeTruthy();
  return m![0];
}

describe("runDashboard — 標準シナリオ", () => {
  it("1. exit 0 で report.html を生成する", async () => {
    seedStandard();
    const code = await run(["--no-open"]);
    expect(code).toBe(0);
    expect(existsSync(join(tmpHome, "report.html"))).toBe(true);
    const html = readHtml();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("agent-cost-notifier");
  });

  it("2. #acn-data をパースでき、合計 costUSD が seed 合計と一致する", async () => {
    const seededTotal = seedStandard();
    await run(["--no-open", "--days", "9999"]);
    const data = parseData(readHtml());

    expect(Array.isArray(data.turns)).toBe(true);
    expect(data.turns.length).toBe(10);
    const sum = data.turns.reduce((s, t) => s + t.costUSD, 0);
    expect(sum).toBeCloseTo(seededTotal, 6);
    // totals も一致
    expect(data.totals.cost).toBeCloseTo(seededTotal, 6);
    expect(data.totals.turns).toBe(10);
  });

  it("3. 外部参照ゼロ(src=/href= に http が無く、@import も無い)", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).not.toMatch(/src\s*=\s*["']?\s*https?:/i);
    expect(html).not.toMatch(/href\s*=\s*["']?\s*https?:/i);
    expect(html).not.toContain("@import");

    // #acn-data(データ)を除いた本体には http(s):// が一切現れない
    const raw = extractDataRaw(html);
    const withoutData = html.replace(raw, "");
    expect(withoutData).not.toMatch(/https?:\/\//i);
  });

  it("4. </script> 脱出防止 — #acn-data 内に生の </script は無く、\\u003c にエスケープされている", async () => {
    seedStandard();
    await run(["--no-open"]);
    const raw = extractDataRaw(readHtml());
    // 危険プロンプトの </script> が生のまま入っていない
    expect(raw).not.toContain("</script");
    // '<' は < にエスケープされている(危険プロンプト由来)
    expect(raw).toContain("\\u003cscript>alert(1)\\u003c/script>");
  });

  it("5. 危険プロンプトが実行可能な形(<script>alert)で埋め込まれていない", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    // どこにも生の <script>alert は現れない(データ内は <script>alert に化けている)
    expect(html).not.toContain("<script>alert");
    // パースすると元のプロンプトは正しく復元できる(データとしては保持されている)
    const data = parseData(html);
    const dangerous = data.turns.find((t) => t.prompt.includes("alert(1)"));
    expect(dangerous).toBeDefined();
    expect(dangerous!.prompt).toContain("<script>alert(1)</script>");
  });

  it("6. 10,000字超プロンプトは切り詰められ「…(以下略)」が付く(末尾は落ちる)", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain("…(以下略)");

    const data = parseData(html);
    const huge = data.turns.find((t) => t.prompt.startsWith("あ"));
    expect(huge).toBeDefined();
    expect(huge!.prompt.endsWith("…(以下略)")).toBe(true);
    // 元の末尾マーカーは切り捨てられている
    expect(huge!.prompt).not.toContain(HUGE_TAIL);
    expect(html).not.toContain(HUGE_TAIL);
    // 長さは 10000 + マーク長 に収まる
    expect(huge!.prompt.length).toBeLessThanOrEqual(10_000 + "…(以下略)".length);
  });

  it("主要セクション・SVGチャート・検索ボックス・モデル表示名・両通貨が存在する", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    // サマリーカード(タスク仕様のラベル)
    expect(html).toContain("今日");
    expect(html).toContain("今週");
    expect(html).toContain("今月");
    expect(html).toContain("期間合計");
    // SVG チャート
    expect(html).toMatch(/<svg[^>]*class="chart"/);
    // 各セクション
    expect(html).toContain("モデル別内訳");
    expect(html).toContain("プロジェクト別");
    expect(html).toContain("ターン履歴");
    // 履歴テーブルと検索
    expect(html).toContain('id="turn-body"');
    expect(html).toContain('id="turn-search"');
    // モデル表示名(format.ts の modelDisplayName 相当)
    expect(html).toContain("Fable 5");
    expect(html).toContain("Sonnet 5");
    expect(html).toContain("Haiku 3.5");
    // 両通貨
    expect(html).toContain("$");
    expect(html).toContain("¥");
  });
});

describe("runDashboard — フラグ", () => {
  it("7a. --out 指定でそのパスに出力し、既定 report.html は作らない", async () => {
    seedStandard();
    const out = join(tmpHome, "sub", "custom.html");
    const code = await run(["--no-open", "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(tmpHome, "report.html"))).toBe(false);
    expect(readHtml(out)).toContain("agent-cost-notifier");
  });

  it("7b. --days フィルタで窓の外の古いレコードは #acn-data に含まれない", async () => {
    const now = Date.now();
    // 窓内(今日)
    appendTurn(
      makeTurn({
        ts: new Date(now - 1 * HOUR).toISOString(),
        prompt: "RECENT_ONE",
        costUSD: 0.1,
      }),
    );
    // 窓外(40日前)
    appendTurn(
      makeTurn({
        ts: new Date(now - 40 * DAY).toISOString(),
        prompt: "ZZOLD_MARKER 古い履歴",
        costUSD: 0.9,
      }),
    );

    await run(["--no-open", "--days", "1"]);
    const html = readHtml();
    const data = parseData(html);

    // 古いレコードは JSON にも HTML 本文にも現れない
    expect(data.turns.some((t) => t.prompt.includes("ZZOLD_MARKER"))).toBe(false);
    expect(html).not.toContain("ZZOLD_MARKER");
    // 直近のものは含まれる
    expect(data.turns.some((t) => t.prompt.includes("RECENT_ONE"))).toBe(true);
    expect(data.turns.length).toBe(1);
  });

  it("不正な --days は既定30扱いで生成できる", async () => {
    seedStandard();
    const code = await run(["--no-open", "--days", "not-a-number"]);
    expect(code).toBe(0);
    expect(readHtml()).toContain("直近 30 日間");
  });

  it("--days=N 形式(= 区切り)も受け付ける", async () => {
    seedStandard();
    const code = await run(["--no-open", "--days=7"]);
    expect(code).toBe(0);
    expect(readHtml()).toContain("直近 7 日間");
  });
});

describe("runDashboard — 自動リロード / meta refresh", () => {
  it("既定(config の autoReloadSec=30)では meta refresh を content=\"30\" で出力する", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*content="30"/);
    // フッタに自動更新の案内が1行出る
    expect(html).toContain("約 30 秒ごとに自動更新");
  });

  it("--no-refresh を付けると meta refresh も自動更新案内も出さない", async () => {
    seedStandard();
    await run(["--no-open", "--no-refresh"]);
    const html = readHtml();
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain("秒ごとに自動更新");
  });

  it("--refresh 0 でも meta refresh を出さない", async () => {
    seedStandard();
    await run(["--no-open", "--refresh", "0"]);
    expect(readHtml()).not.toContain('http-equiv="refresh"');
  });

  it("--refresh <sec> でリロード間隔を上書きできる", async () => {
    seedStandard();
    await run(["--no-open", "--refresh", "15"]);
    expect(readHtml()).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*content="15"/);
  });

  it("config の dashboard.autoReloadSec が既定リロード秒になる", async () => {
    writeFileSync(
      join(tmpHome, "config.json"),
      JSON.stringify({ dashboard: { autoReloadSec: 45 } }),
      "utf8",
    );
    seedStandard();
    await run(["--no-open"]);
    expect(readHtml()).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*content="45"/);
  });

  it("リロードを跨いで状態を保持する JS(検索語・スクロール位置の復元)が埋め込まれている", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    // sessionStorage を使う
    expect(html).toContain("sessionStorage");
    // 検索語の保存・復元キー
    expect(html).toContain("acn-search");
    // スクロール位置の保存・復元キーと復元呼び出し
    expect(html).toContain("acn-scroll");
    expect(html).toContain("window.scrollTo");
  });
});

describe("runDashboard — 空状態", () => {
  it("8. 履歴0件でも exit 0 で「まだ履歴がありません」を含む HTML を生成する", async () => {
    const code = await run(["--no-open"]);
    expect(code).toBe(0);
    expect(existsSync(join(tmpHome, "report.html"))).toBe(true);
    const html = readHtml();
    expect(html).toContain("まだ履歴がありません");
    // 空でも #acn-data は存在し、turns は空配列
    const data = parseData(html);
    expect(data.turns).toEqual([]);
    // 外部参照ゼロは空状態でも維持
    expect(html).not.toMatch(/src\s*=\s*["']?\s*https?:/i);
  });
});

// ============ モデル別の実配分(costByModel) ============
//
// track.ts が保存する TurnRecord.costByModel を dashboard.ts がどう集計するかを検証する。
//  (a) costByModel 付き: 各モデルへ実配分され、主モデルへの全額計上にならない
//  (b) costByModel 無し(旧レコード): 主モデルへ全額のフォールバック
//  (c) 混在: モデル別表の合計が総コストと一致する
//  (d) 日別スタックに同日で複数モデルのセグメントが現れる

describe("runDashboard — モデル別の実配分 (costByModel)", () => {
  it("(a) costByModel 付きレコードは各モデルへ実配分され、主モデルに全額計上されない", async () => {
    appendTurn(
      makeTurn({
        models: ["claude-fable-5", "claude-haiku-4-5"],
        costUSD: 1.0,
        costJPY: 150,
        costByModel: { "claude-fable-5": 0.9, "claude-haiku-4-5": 0.1 },
      }),
    );

    await run(["--no-open"]);
    const html = readHtml();

    expect(html).toContain("Fable 5");
    expect(html).toContain("Haiku 4.5");
    // 各モデルの行に実配分どおりの金額が入っている(どちらかが $1.00 全額を持つのではない)。
    expect(html).toContain(`>Fable 5</td><td class="c-num">1</td><td class="c-num">${formatUSD(0.9)}</td>`);
    expect(html).toContain(`>Haiku 4.5</td><td class="c-num">1</td><td class="c-num">${formatUSD(0.1)}</td>`);

    const modelCosts = extractModelTableUsd(html);
    expect(modelCosts.sort((a, b) => a - b)).toEqual([0.1, 0.9]);
    expect(modelCosts).not.toContain(1.0);
  });

  it("(b) costByModel の無い旧形式レコードは主モデルへ全額フォールバック計上される", async () => {
    appendTurn(
      makeTurn({
        models: ["claude-sonnet-5"],
        costUSD: 0.42,
        costJPY: 63,
        // costByModel は指定しない = 旧レコード相当
      }),
    );

    await run(["--no-open"]);
    const html = readHtml();

    expect(html).toContain("Sonnet 5");
    expect(html).toContain(
      `>Sonnet 5</td><td class="c-num">1</td><td class="c-num">${formatUSD(0.42)}</td>`,
    );
    const modelCosts = extractModelTableUsd(html);
    expect(modelCosts).toEqual([0.42]);
  });

  it("(c) 混在 seed(実配分 + フォールバック)でもモデル別表の合計は総コストと一致する", async () => {
    const now = new Date().toISOString();
    appendTurn(
      makeTurn({
        ts: now,
        models: ["claude-fable-5", "claude-haiku-4-5"],
        costUSD: 1.0,
        costJPY: 150,
        costByModel: { "claude-fable-5": 0.9, "claude-haiku-4-5": 0.1 },
      }),
    );
    appendTurn(
      makeTurn({
        ts: now,
        models: ["claude-sonnet-5"],
        costUSD: 0.5,
        costJPY: 75,
        // costByModel なし → フォールバック
      }),
    );

    await run(["--no-open"]);
    const html = readHtml();
    const data = parseData(html);

    expect(data.totals.cost).toBeCloseTo(1.5, 10);
    expect(data.totals.turns).toBe(2);

    const modelCosts = extractModelTableUsd(html);
    const sum = modelCosts.reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(data.totals.cost, 6);
  });

  it("(d) 日別チャートで複数モデルのスタックが同日に現れる(seg クラス・埋め込み daily.models で検証)", async () => {
    appendTurn(
      makeTurn({
        ts: new Date().toISOString(),
        models: ["claude-fable-5", "claude-haiku-4-5"],
        costUSD: 1.0,
        costJPY: 150,
        costByModel: { "claude-fable-5": 0.9, "claude-haiku-4-5": 0.1 },
      }),
    );

    await run(["--no-open"]);
    const html = readHtml();

    // 埋め込み daily データ: データのある唯一の日に2モデル分のセグメントが入っている。
    const daily = parseDailyData(html);
    const day = daily.find((dd) => dd.models.length > 0);
    expect(day).toBeDefined();
    expect(day!.models.length).toBe(2);
    expect(day!.models.map((m) => m.name).sort()).toEqual(["Fable 5", "Haiku 4.5"]);

    // 日別チャート SVG 自体にも、同じバーの中に異なるモデルスロットの seg が2つ現れる
    // (このテストではデータのある日が1日だけなので、この SVG 内の seg はすべてその日のもの)。
    const dailySvg = extractDailyChartSvg(html);
    const segClasses = [...dailySvg.matchAll(/class="seg (s\d+|sother)"/g)].map((m) => m[1]);
    expect(new Set(segClasses).size).toBe(2);
  });
});

// ============ サブエージェント枠(subagents) ============
//
// track.ts が保存する TurnRecord.subagents を dashboard.ts がどう総額に反映するかを検証する。
//  - ヒーロー合計・KPI・埋め込み totals は SA 込みの総額
//  - 「うちサブエージェント」がヒーローに表示される
//  - モデル別表に SA のモデル(Sonnet 5)が現れる
//  - ターン履歴の埋め込みに SA 情報(subagent)と model の "+SA" が入る
//  - SA なしレコードだけなら「うちサブエージェント」は出ない

interface SubagentEmbedTurn {
  model: string;
  costUSD: number;
  subagent: { usd: string; jpy: string; models: string; apiCalls: number } | null;
}

/** GOLDEN 相当の SA 付きレコード(メイン fable 0.267 + SA sonnet 0.033)。 */
function seedWithSubagents(): void {
  appendTurn(
    makeTurn({
      ts: new Date().toISOString(),
      models: ["claude-fable-5"],
      costUSD: 0.267,
      costJPY: 40.05,
      costByModel: { "claude-fable-5": 0.267 },
      subagents: {
        costUSD: 0.033,
        costByModel: { "claude-sonnet-5": 0.033 },
        tokens: { input: 1000, output: 2000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
        apiCalls: 1,
        agentFiles: 1,
      },
    }),
  );
}

describe("runDashboard — サブエージェント (subagents)", () => {
  it("ヒーロー合計・埋め込み totals が SA 込みの総額(0.267 + 0.033 = 0.300)になる", async () => {
    seedWithSubagents();
    await run(["--no-open"]);
    const html = readHtml();

    // 埋め込み totals は総額。
    const data = parseData(html);
    expect(data.totals.cost).toBeCloseTo(0.3, 10);
    expect(data.totals.turns).toBe(1);
    // ヒーローの合計値表示も総額。
    expect(html).toContain(formatUSD(0.3)); // "$0.300"
  });

  it("ヒーローに「うちサブエージェント $0.033(¥5)」が表示される", async () => {
    seedWithSubagents();
    await run(["--no-open"]);
    const html = readHtml();

    expect(html).toContain("うちサブエージェント");
    expect(html).toContain(formatUSD(0.033)); // "$0.033"
  });

  it("モデル別表に SA のモデル(Sonnet 5)が現れ、表の合計が総額と一致する", async () => {
    seedWithSubagents();
    await run(["--no-open"]);
    const html = readHtml();

    expect(html).toContain("Fable 5");
    expect(html).toContain("Sonnet 5");

    const modelCosts = extractModelTableUsd(html);
    expect(modelCosts.sort((a, b) => a - b)).toEqual([0.033, 0.267]);
    const sum = modelCosts.reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(0.3, 6);
  });

  it("ターン履歴の埋め込みに SA 情報(subagent)と model の +SA が入る", async () => {
    seedWithSubagents();
    await run(["--no-open"]);
    const html = readHtml();

    const turns = parseData(html).turns as unknown as SubagentEmbedTurn[];
    expect(turns).toHaveLength(1);
    const t = turns[0];
    expect(t.model).toContain("+SA");
    expect(t.subagent).not.toBeNull();
    expect(t.subagent!.usd).toBe(formatUSD(0.033));
    expect(t.subagent!.apiCalls).toBe(1);
    expect(t.subagent!.models).toContain("Sonnet 5");
  });

  it("SA なしレコードだけなら「うちサブエージェント」は表示されず、embed の subagent は null", async () => {
    appendTurn(makeTurn({ models: ["claude-fable-5"], costUSD: 0.12, costJPY: 18 }));
    await run(["--no-open"]);
    const html = readHtml();

    expect(html).not.toContain("うちサブエージェント");
    const turns = parseData(html).turns as unknown as SubagentEmbedTurn[];
    expect(turns[0].subagent).toBeNull();
    expect(turns[0].model).not.toContain("+SA");
  });
});
