// test/dashboard.test.ts
//
// runDashboard を直接 import し、一時 ACN_HOME に seed した履歴から生成される HTML を検証する。
// 日/週/月・通算の集計と描画はブラウザ側(埋め込み JSON + JS)で行うため、サーバ側テストでは
//  - 埋め込みデータ(#acn-data)の形と数値(全ターン・slot 別コスト)
//  - セキュリティ不変条件(外部参照ゼロ / </script> 脱出防止 / 危険プロンプト非実行 / 10,000字切詰め)
//  - 期間フィルタ(--days)・出力先(--out)・自動リロード(meta refresh)・空状態
//  - 操作 UI(粒度トグル・通算ボタン・各コンテナ)の存在
// を検証する(クリック等の実挙動はブラウザ結合で別途確認)。ブラウザは常に --no-open。

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

/** 標準シナリオ(3モデル・3プロジェクト・複数日・危険プロンプト・10,000字超、計10件)を seed し合計 USD を返す。 */
function seedStandard(): number {
  const now = Date.now();
  const recs: TurnRecord[] = [
    makeTurn({ ts: new Date(now - 1 * HOUR).toISOString(), models: ["claude-fable-5"], project: "/home/me/alpha", prompt: DANGEROUS_PROMPT, costUSD: 0.12, costJPY: 18 }),
    makeTurn({ ts: new Date(now - 2 * HOUR).toISOString(), models: ["claude-sonnet-5"], project: "/home/me/beta", prompt: "あ".repeat(10_050) + HUGE_TAIL, costUSD: 0.34, costJPY: 51 }),
    makeTurn({ ts: new Date(now - 3 * HOUR).toISOString(), models: ["claude-fable-5"], project: "/home/me/beta", prompt: "small change", costUSD: 0.0009, costJPY: 0.135 }),
    makeTurn({ ts: new Date(now - 5 * HOUR).toISOString(), models: ["claude-3-5-haiku"], project: "/home/me/gamma", prompt: "ドキュメントを書いて", costUSD: 0.02, costJPY: 3 }),
    makeTurn({ ts: new Date(now - 1 * DAY - 2 * HOUR).toISOString(), models: ["claude-fable-5"], project: "/home/me/alpha", prompt: "yesterday work", costUSD: 0.08, costJPY: 12 }),
    makeTurn({ ts: new Date(now - 1 * DAY - 6 * HOUR).toISOString(), models: ["claude-sonnet-5"], project: "/home/me/gamma", prompt: "設計レビュー", costUSD: 0.21, costJPY: 31.5 }),
    makeTurn({ ts: new Date(now - 2 * DAY - 3 * HOUR).toISOString(), models: ["claude-3-5-haiku"], project: "/home/me/alpha", prompt: "テスト追加", costUSD: 0.03, costJPY: 4.5 }),
    makeTurn({ ts: new Date(now - 2 * DAY - 5 * HOUR).toISOString(), models: ["claude-fable-5"], project: "/home/me/beta", prompt: "リファクタ", costUSD: 0.15, costJPY: 22.5 }),
    makeTurn({ ts: new Date(now - 2 * DAY - 8 * HOUR).toISOString(), models: ["claude-sonnet-5"], project: "/home/me/alpha", prompt: "パフォーマンス調査", costUSD: 0.27, costJPY: 40.5 }),
    makeTurn({ ts: new Date(now - 2 * DAY - 10 * HOUR).toISOString(), models: ["claude-3-5-haiku", "claude-fable-5"], project: "/home/me/gamma", prompt: "複数モデルのターン", costUSD: 0.06, costJPY: 9 }),
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

function extractDataRaw(html: string): string {
  const i = html.indexOf(ACN_DATA_OPEN);
  expect(i).toBeGreaterThanOrEqual(0);
  const start = i + ACN_DATA_OPEN.length;
  const end = html.indexOf("</script>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

interface EmbedTurn {
  t: number;
  ts: string;
  p: string;
  pf: string;
  br: string | null;
  md: string;
  mr: string[];
  ti: string;
  to: string;
  um: number;
  fx: number;
  bs: Record<string, number>;
  pr: string;
  tr: boolean;
  sa: { usd: string; jpy: string; models: string; apiCalls: number } | null;
}
interface Embed {
  version: string;
  generatedAt: string;
  slots: { slot: string; name: string }[];
  turns: EmbedTurn[];
}

function parseData(html: string): Embed {
  return JSON.parse(extractDataRaw(html)) as Embed;
}

/** ターンの総額(slot 別 USD の合計 = メイン + SA)。 */
function turnTotal(t: EmbedTurn): number {
  return Object.values(t.bs).reduce((s, v) => s + v, 0);
}
function sumTotals(turns: EmbedTurn[]): number {
  return turns.reduce((s, t) => s + turnTotal(t), 0);
}

describe("runDashboard — 標準シナリオ", () => {
  it("exit 0 で report.html を生成する", async () => {
    seedStandard();
    const code = await run(["--no-open"]);
    expect(code).toBe(0);
    expect(existsSync(join(tmpHome, "report.html"))).toBe(true);
    const html = readHtml();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("ccc-notifier");
  });

  it("既定で全履歴を埋め込み、slot 別コストの総和が seed 合計と一致する", async () => {
    const seededTotal = seedStandard();
    await run(["--no-open"]);
    const data = parseData(readHtml());

    expect(Array.isArray(data.turns)).toBe(true);
    expect(data.turns.length).toBe(10); // 既定=全履歴(旧 --days 30 の制限は撤廃)
    expect(sumTotals(data.turns)).toBeCloseTo(seededTotal, 6);
  });

  it("外部参照ゼロ(http(s) の src/href や @import が無い)", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).not.toMatch(/src\s*=\s*["']?\s*https?:/i);
    expect(html).not.toMatch(/href\s*=\s*["']?\s*https?:/i);
    expect(html).not.toContain("@import");
  });

  it("#acn-data は生の </script> を含まず、危険プロンプトの < は \\u003c にエスケープされる", async () => {
    seedStandard();
    await run(["--no-open"]);
    const raw = extractDataRaw(readHtml());
    expect(raw).not.toContain("</script");
    expect(raw).toContain("\\u003cscript>alert(1)\\u003c/script>");
  });

  it("危険プロンプトは実行可能な形で埋め込まれない(埋め込み外に <script>alert が無い)", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).not.toContain("<script>alert");
    // JSON.parse 後は元のプロンプトが復元される(埋め込みデータ内は安全)。
    const dangerous = parseData(html).turns.find((t) => t.pr.includes("alert(1)"));
    expect(dangerous).toBeDefined();
    expect(dangerous!.pr).toContain("<script>alert(1)</script>");
  });

  it("10,000字超プロンプトは切り詰められ「…(以下略)」が付き、末尾は落ちる", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain("…(以下略)");
    expect(html).not.toContain(HUGE_TAIL);
    const huge = parseData(html).turns.find((t) => t.tr);
    expect(huge).toBeDefined();
    expect(huge!.pr.endsWith("…(以下略)")).toBe(true);
    expect(huge!.pr).not.toContain(HUGE_TAIL);
    expect(huge!.pr.length).toBeLessThanOrEqual(10_000 + "…(以下略)".length);
  });

  it("KPI(今日/今週/今月/通算)・凡例のモデル名が含まれる", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    for (const label of ["今日", "今週", "今月", "通算"]) expect(html).toContain(label);
    // slots(凡例)にモデル表示名が入る。
    for (const name of ["Fable 5", "Sonnet 5", "Haiku 3.5"]) expect(html).toContain(name);
    const data = parseData(html);
    expect(data.slots.map((s) => s.name)).toEqual(expect.arrayContaining(["Fable 5", "Sonnet 5", "Haiku 3.5"]));
  });

  it("操作 UI(粒度トグル・通算ボタン・各コンテナ)が存在する", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain('data-gran="day"');
    expect(html).toContain('data-gran="week"');
    expect(html).toContain('data-gran="month"');
    expect(html).toContain('id="acn-all"');
    expect(html).toContain('id="acn-chart"');
    expect(html).toContain('id="acn-bymodel"');
    expect(html).toContain('id="acn-byproject"');
    expect(html).toContain('id="turn-body"');
    expect(html).toContain('id="turn-search"');
    expect(html).toContain("通算");
  });

  it("状態(粒度・選択・検索・スクロール)を自動リロード跨ぎで保持する JS が埋め込まれている", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain("sessionStorage");
    expect(html).toContain("acn-gran");
    expect(html).toContain("acn-sel");
    expect(html).toContain("acn-search");
    expect(html).toContain("acn-scroll");
    expect(html).toContain("window.scrollTo");
  });
});

describe("runDashboard — フラグ", () => {
  it("--out で指定パスに書き出す", async () => {
    seedStandard();
    const out = join(tmpHome, "custom", "dash.html");
    const code = await run(["--no-open", "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readHtml(out)).toContain("ccc-notifier");
  });

  it("--days N で N 日より前を除外する(--days 1 は直近24時間の 4 件)", async () => {
    seedStandard();
    await run(["--no-open", "--days", "1"]);
    const data = parseData(readHtml());
    expect(data.turns.length).toBe(4);
    // 埋め込まれた全ターンが直近24時間以内。
    const cutoff = Date.now() - DAY;
    expect(data.turns.every((t) => t.t >= cutoff)).toBe(true);
  });

  it("--days に不正値を渡すと全履歴になる(制限しない)", async () => {
    seedStandard();
    await run(["--no-open", "--days", "not-a-number"]);
    expect(parseData(readHtml()).turns.length).toBe(10);
  });
});

describe("runDashboard — 自動リロード / meta refresh", () => {
  it("既定(config 30秒)で meta refresh が出力される", async () => {
    seedStandard();
    await run(["--no-open"]);
    expect(readHtml()).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*content="30"/);
  });

  it("--no-refresh で meta refresh を出力しない", async () => {
    seedStandard();
    await run(["--no-open", "--no-refresh"]);
    expect(readHtml()).not.toMatch(/http-equiv="refresh"/);
  });

  it("--refresh 15 で content=15 になる", async () => {
    seedStandard();
    await run(["--no-open", "--refresh", "15"]);
    expect(readHtml()).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*content="15"/);
  });

  it("config の dashboard.autoReloadSec が既定リロード秒になる", async () => {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ dashboard: { autoReloadSec: 45 } }), "utf8");
    seedStandard();
    await run(["--no-open"]);
    expect(readHtml()).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*content="45"/);
  });
});

describe("runDashboard — 空状態", () => {
  it("履歴0件でも exit 0 で「まだ履歴がありません」を含む HTML を生成する", async () => {
    const code = await run(["--no-open"]);
    expect(code).toBe(0);
    const html = readHtml();
    expect(html).toContain("まだ履歴がありません");
    expect(parseData(html).turns).toEqual([]);
    expect(html).not.toMatch(/src\s*=\s*["']?\s*https?:/i);
  });
});

describe("runDashboard — モデル別の実配分 (costByModel)", () => {
  it("costByModel 付きは各モデル(slot)へ実配分され、主モデルに全額計上されない", async () => {
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

    const t = parseData(html).turns[0];
    const vals = Object.values(t.bs).sort((a, b) => a - b);
    expect(vals[0]).toBeCloseTo(0.1, 10);
    expect(vals[1]).toBeCloseTo(0.9, 10);
    expect(vals).not.toContain(1.0); // 主モデルへの全額計上ではない
    expect(turnTotal(t)).toBeCloseTo(1.0, 10);
  });

  it("costByModel 無し(旧レコード)は主モデルへ全額フォールバックする", async () => {
    appendTurn(makeTurn({ models: ["claude-sonnet-5"], costUSD: 0.42, costJPY: 63 }));
    await run(["--no-open"]);
    const data = parseData(readHtml());
    expect(data.slots.some((s) => s.name === "Sonnet 5")).toBe(true);
    const t = data.turns[0];
    expect(Object.values(t.bs)).toEqual([expect.closeTo(0.42, 10)]);
  });

  it("混在 seed でも全 slot コストの総和が総コストと一致する", async () => {
    const now = new Date().toISOString();
    appendTurn(makeTurn({ ts: now, models: ["claude-fable-5", "claude-haiku-4-5"], costUSD: 1.0, costJPY: 150, costByModel: { "claude-fable-5": 0.9, "claude-haiku-4-5": 0.1 } }));
    appendTurn(makeTurn({ ts: now, models: ["claude-sonnet-5"], costUSD: 0.5, costJPY: 75 }));
    await run(["--no-open"]);
    const data = parseData(readHtml());
    expect(data.turns.length).toBe(2);
    expect(sumTotals(data.turns)).toBeCloseTo(1.5, 10);
  });
});

describe("runDashboard — サブエージェント (subagents)", () => {
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

  it("総額が SA 込み(0.267 + 0.033 = 0.300)になり、ヒーローに表示される", async () => {
    seedWithSubagents();
    await run(["--no-open"]);
    const html = readHtml();
    const data = parseData(html);
    expect(sumTotals(data.turns)).toBeCloseTo(0.3, 10);
    expect(turnTotal(data.turns[0])).toBeCloseTo(0.3, 10);
    expect(html).toContain(formatUSD(0.3)); // "$0.300"
  });

  it("ヒーローに「うちサブエージェント」が表示され、SA モデル(Sonnet 5)が slot に現れる", async () => {
    seedWithSubagents();
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain("うちサブエージェント");
    expect(html).toContain(formatUSD(0.033));
    const data = parseData(html);
    expect(data.slots.map((s) => s.name)).toEqual(expect.arrayContaining(["Fable 5", "Sonnet 5"]));
  });

  it("ターン履歴の埋め込みに SA 情報と model の +SA が入る", async () => {
    seedWithSubagents();
    await run(["--no-open"]);
    const t = parseData(readHtml()).turns[0];
    expect(t.md).toContain("+SA");
    expect(t.sa).not.toBeNull();
    expect(t.sa!.usd).toBe(formatUSD(0.033));
    expect(t.sa!.apiCalls).toBe(1);
    expect(t.sa!.models).toContain("Sonnet 5");
  });

  it("SA なしなら「うちサブエージェント」は出ず、embed の sa は null・md に +SA が無い", async () => {
    appendTurn(makeTurn({ models: ["claude-fable-5"], costUSD: 0.12, costJPY: 18 }));
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).not.toContain("うちサブエージェント");
    const t = parseData(html).turns[0];
    expect(t.sa).toBeNull();
    expect(t.md).not.toContain("+SA");
  });
});

describe("runDashboard — 月予算カード", () => {
  function setBudget(usd: number): void {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ monthlyBudgetUSD: usd }), "utf8");
  }

  // カードの有無はコンテナ #acn-budget で判定する(「月予算」の文字列は
  // クライアント JS 内にも含まれるため、テキスト検索では判定できない)。
  it("予算未設定(0)ならカード(#acn-budget)は出ない", async () => {
    appendTurn(makeTurn({ costUSD: 10, costJPY: 1500 })); // 今月
    await run(["--no-open"]);
    expect(readHtml()).not.toContain('id="acn-budget"');
  });

  it("予算設定時: 当月使用額 / 予算 / 使用率% とバー幅(初期=当月)が出る", async () => {
    // 今月 $124(=8×$15.5)。ダミーは ts 既定=now=今月。31% は緑(ok)。
    for (let i = 0; i < 8; i++) appendTurn(makeTurn({ costUSD: 15.5, costJPY: 15.5 * 150 }));
    setBudget(400);
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain('id="acn-budget"');
    expect(html).toContain("<b>$124.00</b> / $400.00");
    expect(html).toContain("31.0% used");
    expect(html).toContain('budget-fill lvl-ok" style="width:31.0%');
  });

  it("70%以上100%未満は warn(黄)", async () => {
    appendTurn(makeTurn({ costUSD: 300, costJPY: 45000 })); // 今月 $300 / $400 = 75%
    setBudget(400);
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain("75.0% used");
    expect(html).toContain('budget-fill lvl-warn" style="width:75.0%');
    expect(html).toContain('class="budget-pct lvl-warn"');
  });

  it("100%以上は over(赤)かつバー幅は 100% に頭打ち", async () => {
    appendTurn(makeTurn({ costUSD: 500, costJPY: 75000 })); // 今月 $500 > 予算 $400
    setBudget(400);
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain("125.0% used");
    expect(html).toContain('budget-fill lvl-over" style="width:100.0%');
    expect(html).toContain('class="budget-pct lvl-over"');
  });
});
