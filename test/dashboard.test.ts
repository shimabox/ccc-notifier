// test/dashboard.test.ts
//
// runDashboard を直接 import し、一時 CCCN_HOME に seed した履歴から生成される HTML を検証する。
// 日/週/月・通算の集計と描画はブラウザ側(埋め込み JSON + JS)で行うため、サーバ側テストでは
//  - 埋め込みデータ(#cccn-data)の形と数値(全ターン・slot 別コスト)
//  - セキュリティ不変条件(外部参照ゼロ / </script> 脱出防止 / 危険プロンプト非実行 / 10,000字切詰め)
//  - 期間フィルタ(--days)・出力先(--out)・自動リロード(meta refresh)・空状態
//  - 操作 UI(粒度トグル・通算ボタン・各コンテナ)の存在
// を検証する(クリック等の実挙動はブラウザ結合で別途確認)。ブラウザは常に --no-open。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserOpenPlan, runDashboard, writeDashboardHtml } from "../src/dashboard";
import { formatUSD } from "../src/format";
import { appendTurn } from "../src/store";
import * as store from "../src/store";
import type { TurnRecord } from "../src/types";

const DAY = 86_400_000;
const HOUR = 3_600_000;

let tmpHome: string;
let prevHome: string | undefined;
let defaultOutput: string;

beforeEach(() => {
  prevHome = process.env.CCCN_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), "cccn-dashboard-test-"));
  process.env.CCCN_HOME = tmpHome;
  defaultOutput = join(tmpHome, "report.html");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = prevHome;
});

async function run(argv: string[]): Promise<number> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  defaultOutput = argv.includes("--all") ? join(tmpHome, "report-all.html") : join(tmpHome, "report.html");
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

function readHtml(path = defaultOutput): string {
  return readFileSync(path, "utf8");
}

function writeDashboardSentinels(): void {
  writeFileSync(join(tmpHome, "report.html"), "recent-sentinel", "utf8");
  writeFileSync(join(tmpHome, "report-all.html"), "full-sentinel", "utf8");
  mkdirSync(join(tmpHome, "cache"), { recursive: true });
  writeFileSync(join(tmpHome, "cache", "dashboard-full-state.json"), "state-sentinel", "utf8");
}

function expectDashboardSentinelsUnchanged(): void {
  expect(readFileSync(join(tmpHome, "report.html"), "utf8")).toBe("recent-sentinel");
  expect(readFileSync(join(tmpHome, "report-all.html"), "utf8")).toBe("full-sentinel");
  expect(readFileSync(join(tmpHome, "cache", "dashboard-full-state.json"), "utf8")).toBe("state-sentinel");
}

const CCCN_DATA_OPEN = '<script id="cccn-data" type="application/json">';

function extractDataRaw(html: string): string {
  const i = html.indexOf(CCCN_DATA_OPEN);
  expect(i).toBeGreaterThanOrEqual(0);
  const start = i + CCCN_DATA_OPEN.length;
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
  budgetMonth?: { usd: number; jpy: number; turns: number };
  budgetFixed?: boolean;
  variant?: string;
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
  it("exit 0 で既定の直近版 report.html を生成する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0, 0));
    seedStandard();
    const code = await run(["--no-open"]);
    expect(code).toBe(0);
    expect(existsSync(join(tmpHome, "report.html"))).toBe(true);
    const html = readHtml();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("ccc-notifier");
    expect(html).toContain("履歴 3 日分 / Recent");
    expect(html).toContain("sweep");
    expect(html).toContain('href="report-all.html"');
    expect(readFileSync(join(tmpHome, "report-all.html"), "utf8")).toContain("全履歴版はまだ生成されていません");
    expect(readFileSync(join(tmpHome, "report-all.html"), "utf8")).toContain("ccc-notifier dashboard --all");
    expect(parseData(html).variant).toBe("recent");
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(false);
  });

  it("--all は全履歴を report-all.html に埋め込み、日次stateを成功後に更新する", async () => {
    const seededTotal = seedStandard();
    await run(["--no-open", "--all"]);
    const data = parseData(readHtml());

    expect(Array.isArray(data.turns)).toBe(true);
    expect(data.turns.length).toBe(10);
    expect(sumTotals(data.turns)).toBeCloseTo(seededTotal, 6);
    expect(data.variant).toBe("full");
    expect(readHtml()).toContain("sweep");
    expect(readHtml()).toContain("ローカル日");
    expect(readHtml()).toContain("dashboard --all");
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(true);
    expect(readFileSync(join(tmpHome, "report.html"), "utf8")).toContain("ccc-notifier dashboard");
    expect(readFileSync(join(tmpHome, "report.html"), "utf8")).not.toContain("dashboard --all");
  });

  it("手動 dashboard の既定はconfig既定30日より古い履歴を除外する", async () => {
    appendTurn(makeTurn({ ts: new Date(Date.now() - 90 * DAY).toISOString(), prompt: "manual-old-turn" }));
    appendTurn(makeTurn({ ts: new Date(Date.now() - HOUR).toISOString(), prompt: "manual-recent-turn" }));

    await run(["--no-open"]);

    const prompts = parseData(readHtml()).turns.map((turn) => turn.pr);
    expect(prompts).toEqual(["manual-recent-turn"]);
  });

  it("引数なしは config.dashboard.days を対象期間に使う", async () => {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ dashboard: { days: 7 } }), "utf8");
    appendTurn(makeTurn({ ts: new Date(Date.now() - 8 * DAY).toISOString(), prompt: "outside-config-window" }));
    appendTurn(makeTurn({ ts: new Date(Date.now() - HOUR).toISOString(), prompt: "inside-config-window" }));

    expect(await run(["--no-open"])).toBe(0);

    expect(parseData(readHtml()).turns.map((turn) => turn.pr)).toEqual(["inside-config-window"]);
    expect(readHtml()).toContain("履歴 1 日分 / Recent");
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(false);
  });

  it("外部参照ゼロ(http(s) の src/href や @import が無い)", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).not.toMatch(/src\s*=\s*["']?\s*https?:/i);
    expect(html).not.toMatch(/href\s*=\s*["']?\s*https?:/i);
    expect(html).not.toContain("@import");
  });

  it("#cccn-data は生の </script> を含まず、危険プロンプトの < は \\u003c にエスケープされる", async () => {
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
    expect(html).toContain('id="cccn-all"');
    expect(html).toContain('id="cccn-chart"');
    expect(html).toContain('id="cccn-bymodel"');
    expect(html).toContain('id="cccn-byproject"');
    expect(html).toContain('id="turn-body"');
    expect(html).toContain('id="turn-search"');
    expect(html).toContain("通算");
  });

  it("状態(粒度・選択・検索・スクロール)を自動リロード跨ぎで保持する JS が埋め込まれている", async () => {
    seedStandard();
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain("sessionStorage");
    expect(html).toContain("cccn-gran");
    expect(html).toContain("cccn-sel");
    expect(html).toContain("cccn-search");
    expect(html).toContain("cccn-scroll");
    expect(html).toContain("window.scrollTo");
  });
});

describe("runDashboard — Recentの実履歴日数ラベル", () => {
  it("同じローカル暦日の複数turnは履歴1日分、翌日追加後の再生成は履歴2日分と表示する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0, 0));
    appendTurn(makeTurn({ ts: new Date(2026, 6, 14, 9, 0, 0, 0).toISOString() }));
    appendTurn(makeTurn({ ts: new Date(2026, 6, 14, 18, 0, 0, 0).toISOString() }));

    expect(await run(["--no-open", "--days", "30"])).toBe(0);
    expect(readHtml()).toContain("履歴 1 日分 / Recent");

    appendTurn(makeTurn({ ts: new Date(2026, 6, 15, 8, 0, 0, 0).toISOString() }));
    expect(await run(["--no-open", "--days", "30"])).toBe(0);
    expect(readHtml()).toContain("履歴 2 日分 / Recent");
  });

  it("埋込turnの暦日spanが設定days以上なら従来の直近N日版と表示する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 30, 12, 0, 0, 0));
    appendTurn(makeTurn({ ts: new Date(2026, 6, 1, 12, 0, 0, 0).toISOString() }));
    appendTurn(makeTurn({ ts: new Date(2026, 6, 30, 12, 0, 0, 0).toISOString() }));

    expect(await run(["--no-open", "--days", "30"])).toBe(0);

    expect(readHtml()).toContain("直近 30 日版 / Recent");
    expect(readHtml()).not.toContain("履歴 30 日分 / Recent");
  });

  it("DSTを跨いでも経過時間ではなくローカル暦日で3日分と数える", async () => {
    const priorTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-09T16:00:00.000Z"));
      appendTurn(makeTurn({ ts: "2026-03-07T12:00:00-05:00" }));
      appendTurn(makeTurn({ ts: "2026-03-09T12:00:00-04:00" }));

      expect(await run(["--no-open", "--days", "30"])).toBe(0);

      expect(readHtml()).toContain("履歴 3 日分 / Recent");
    } finally {
      if (priorTz === undefined) delete process.env.TZ;
      else process.env.TZ = priorTz;
    }
  });
});

describe("runDashboard — フラグ", () => {
  it("data lock timeoutを明示失敗しcustom出力を作らない", async () => {
    const { acquireDataLock } = await import("../src/data-lock");
    const lock = acquireDataLock();
    expect(lock).not.toBeNull();
    process.env.CCCN_LOCK_TIMEOUT_MS = "0";
    const out = join(tmpHome, "blocked-custom.html");
    try {
      expect(await run(["--no-open", "--out", out])).toBe(1);
      expect(existsSync(out)).toBe(false);
    } finally {
      delete process.env.CCCN_LOCK_TIMEOUT_MS;
      lock!.release();
    }
  });

  it("生成順に関係なくplaceholderでcanonical相互anchorを切らさない", async () => {
    seedStandard();
    await run(["--no-open"]);
    expect(readHtml()).toContain('href="report-all.html"');
    expect(readFileSync(join(tmpHome, "report-all.html"), "utf8")).toContain('href="report.html"');

    await run(["--no-open", "--days", "30"]);
    expect(readHtml()).toContain('href="report-all.html"');

    await run(["--no-open", "--all"]);
    expect(readHtml()).toContain('href="report.html"');
  });

  it("--out で指定パスに書き出す", async () => {
    seedStandard();
    appendTurn(makeTurn({ ts: new Date(Date.now() - 90 * DAY).toISOString(), prompt: "legacy-custom-all" }));
    const out = join(tmpHome, "custom", "dash.html");
    const code = await run(["--no-open", "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readHtml(out)).toContain("ccc-notifier");
    expect(readHtml(out)).not.toContain('href="report.html"');
    expect(readHtml(out)).not.toContain('href="report-all.html"');
    expect(parseData(readHtml(out)).variant).toBe("custom");
    expect(parseData(readHtml(out)).turns.map((turn) => turn.pr)).toContain("legacy-custom-all");
    expect(existsSync(join(tmpHome, "report.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "report-all.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(false);
  });

  it("custom出力は --all なら全履歴、--days N なら直近だけにし、canonical/stateへ触れない", async () => {
    appendTurn(makeTurn({ ts: new Date(Date.now() - 90 * DAY).toISOString(), prompt: "custom-old" }));
    appendTurn(makeTurn({ ts: new Date(Date.now() - HOUR).toISOString(), prompt: "custom-recent" }));
    const allOut = join(tmpHome, "custom-all.html");
    const recentOut = join(tmpHome, "custom-recent.html");

    expect(await run(["--no-open", "--all", "--out", allOut])).toBe(0);
    expect(parseData(readHtml(allOut)).turns.map((turn) => turn.pr)).toEqual(["custom-old", "custom-recent"]);
    expect(await run(["--no-open", "--days", "7", "--out", recentOut])).toBe(0);
    expect(parseData(readHtml(recentOut)).turns.map((turn) => turn.pr)).toEqual(["custom-recent"]);
    for (const html of [readHtml(allOut), readHtml(recentOut)]) {
      expect(html).not.toContain('href="report.html"');
      expect(html).not.toContain('href="report-all.html"');
      expect(parseData(html).variant).toBe("custom");
    }
    expect(existsSync(join(tmpHome, "report.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "report-all.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(false);
  });

  it("--days N で N 日より前を除外する(--days 1 は直近24時間の 4 件)", async () => {
    seedStandard();
    await run(["--no-open", "--days", "1"]);
    const data = parseData(readHtml());
    expect(data.turns.length).toBe(4);
    // 埋め込まれた全ターンが直近24時間以内。
    const cutoff = Date.now() - DAY;
    expect(data.turns.every((t) => t.t >= cutoff)).toBe(true);
    expect(readHtml()).toContain("対象期間合計 / Embedded period total");
    expect(readHtml()).toContain("埋め込み対象期間");
    expect(readHtml()).toContain('href="report-all.html"');
    expect(readFileSync(join(tmpHome, "report-all.html"), "utf8")).toContain("全履歴版はまだ生成されていません");
    expect(parseData(readHtml()).variant).toBe("recent");
    expect(existsSync(join(tmpHome, "report-all.html"))).toBe(true);
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(false);
  });

  it("期間限定版でも slot 配色は埋め込み対象外を含む全履歴基準で決める", async () => {
    appendTurn(
      makeTurn({
        ts: new Date(Date.now() - 40 * DAY).toISOString(),
        models: ["claude-fable-5"],
        costUSD: 10,
        prompt: "outside-window-dominant-model",
      }),
    );
    appendTurn(
      makeTurn({
        ts: new Date(Date.now() - HOUR).toISOString(),
        models: ["claude-haiku-4-5"],
        costUSD: 0.1,
        prompt: "inside-window-model",
      }),
    );

    await run(["--no-open", "--days", "30"]);

    const data = parseData(readHtml());
    expect(data.turns.map((turn) => turn.pr)).toEqual(["inside-window-model"]);
    expect(data.slots.map((slot) => slot.name)).toEqual(["Fable 5", "Haiku 4.5"]);
    expect(data.turns[0].bs).toEqual({ "2": 0.1 });
  });

  it("--all と --days は指定順に関係なくexit 1で何も生成しない", async () => {
    seedStandard();
    expect(await run(["--no-open", "--all", "--days", "7"])).toBe(1);
    expect(await run(["--no-open", "--days", "7", "--all"])).toBe(1);
    expect(existsSync(join(tmpHome, "report.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "report-all.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(false);
  });

  it("--days の欠落・0・負数・小数・非数値はexit 1で何も生成しない", async () => {
    seedStandard();
    const invalidArgv = [
      ["--no-open", "--days"],
      ["--no-open", "--days", "0"],
      ["--no-open", "--days", "-1"],
      ["--no-open", "--days", "1.5"],
      ["--no-open", "--days", "not-a-number"],
      ["--no-open", "--days="],
    ];
    for (const argv of invalidArgv) expect(await run(argv)).toBe(1);
    expect(existsSync(join(tmpHome, "report.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "report-all.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(false);
  });

  it("--out の値が欠けている場合はexit 1で何も生成しない", async () => {
    seedStandard();
    expect(await run(["--no-open", "--out"])).toBe(1);
    expect(await run(["--no-open", "--out="])).toBe(1);
    expect(existsSync(join(tmpHome, "report.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "report-all.html"))).toBe(false);
  });

  it("不明なoptionと余剰の位置引数はexit 1で既存HTML/stateを変更しない", async () => {
    seedStandard();
    writeDashboardSentinels();
    const invalidArgv = [
      ["--al"],
      ["--full"],
      ["stray"],
      ["--days", "7", "stray"],
    ];
    for (const argv of invalidArgv) expect(await run(argv)).toBe(1);
    expectDashboardSentinelsUnchanged();
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

  it("--refresh 0 は有効で meta refresh を出力しない", async () => {
    seedStandard();
    expect(await run(["--no-open", "--refresh", "0"])).toBe(0);
    expect(readHtml()).not.toMatch(/http-equiv="refresh"/);
  });

  it("--refresh は scope option の前後どちらでも有効", async () => {
    seedStandard();
    expect(await run(["--refresh", "15", "--all", "--no-open"])).toBe(0);
    expect(readHtml()).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*content="15"/);
    expect(await run(["--days", "7", "--no-open", "--refresh=0"])).toBe(0);
    expect(readHtml()).not.toMatch(/http-equiv="refresh"/);
  });

  it("--refresh の値欠落・option誤認・不正値はexit 1で既存HTML/stateを変更しない", async () => {
    seedStandard();
    writeDashboardSentinels();
    const invalidArgv = [
      ["--refresh"],
      ["--refresh="],
      ["--refresh", "--all"],
      ["--all", "--refresh"],
      ["--refresh", "--days", "7"],
      ["--refresh", "1.5"],
      ["--refresh", "15x"],
      ["--refresh", "-1"],
      ["--refresh", "NaN"],
      ["--refresh=1.5"],
      ["--refresh=15x"],
      ["--refresh=-1"],
      ["--refresh=NaN"],
    ];
    for (const argv of invalidArgv) expect(await run(argv)).toBe(1);
    expectDashboardSentinelsUnchanged();
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
    expect(html).toContain("直近 30 日版 / Recent");
    expect(parseData(html).turns).toEqual([]);
    expect(html).not.toMatch(/src\s*=\s*["']?\s*https?:/i);
  });

  it("全履歴はあるが対象期間が0件なら対象期間用の空状態を表示する", async () => {
    appendTurn(makeTurn({ ts: new Date(Date.now() - 40 * DAY).toISOString() }));

    const code = await run(["--no-open", "--days", "30"]);

    expect(code).toBe(0);
    const html = readHtml();
    expect(html).toContain("対象期間に履歴がありません");
    expect(html).toContain("直近 30 日版 / Recent");
    expect(html).not.toContain("まだ履歴がありません");
    expect(parseData(html).turns).toEqual([]);
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

  // カードの有無はコンテナ #cccn-budget で判定する(「月予算」の文字列は
  // クライアント JS 内にも含まれるため、テキスト検索では判定できない)。
  it("予算未設定(0)ならカード(#cccn-budget)は出ない", async () => {
    appendTurn(makeTurn({ costUSD: 10, costJPY: 1500 })); // 今月
    await run(["--no-open"]);
    expect(readHtml()).not.toContain('id="cccn-budget"');
  });

  it("予算設定時: 当月使用額 / 予算 / 使用率% とバー幅(初期=当月)が出る", async () => {
    // 今月 $124(=8×$15.5)。ダミーは ts 既定=now=今月。31% は緑(ok)。
    for (let i = 0; i < 8; i++) appendTurn(makeTurn({ costUSD: 15.5, costJPY: 15.5 * 150 }));
    setBudget(400);
    await run(["--no-open", "--all"]);
    const html = readHtml();
    expect(html).toContain('id="cccn-budget"');
    expect(html).toContain("<b>$124.00</b> / $400.00");
    expect(html).toContain("31.0% used");
    expect(html).toContain('budget-fill lvl-ok" style="width:31.0%');
    expect(parseData(html).budgetFixed).toBe(false);
  });

  it("期間限定版は履歴を1回だけ読み、埋め込み対象外の当月分も予算に含める", () => {
    vi.useFakeTimers();
    const now = new Date(2026, 6, 31, 12, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    expect(now.getTime() - monthStart.getTime()).toBeGreaterThan(30 * DAY);
    vi.setSystemTime(now);
    setBudget(1);
    appendTurn(
      makeTurn({
        ts: monthStart.toISOString(),
        prompt: "month-start-outside-window",
        costUSD: 0.2,
        costJPY: 30,
      }),
    );
    const readSpy = vi.spyOn(store, "readTurns");

    writeDashboardHtml({ days: 30, outPath: join(tmpHome, "report.html"), autoReloadSec: 30 });

    const html = readHtml(join(tmpHome, "report.html"));
    const data = parseData(html);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith();
    expect(data.turns).toEqual([]);
    expect(data.budgetFixed).toBe(true);
    expect(data.budgetMonth).toEqual({ usd: 0.2, jpy: 30, turns: 1 });
    expect(html).toContain("保存済み履歴を全件集計");
    expect(html).toContain("all recorded history");
    expect(html).not.toContain("正確");
    expect(html).not.toContain("exact current month");
  });

  it("保存済みの選択期間が埋め込み対象に無ければ対象期間合計へ戻す", async () => {
    appendTurn(makeTurn());
    await run(["--no-open", "--days", "30"]);

    expect(readHtml()).toContain("if(!initialSelPresent) setSel(null);");
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

describe("browserOpenPlan", () => {
  const P = "/home/user/report.html";

  it("uses `open` on darwin", () => {
    expect(browserOpenPlan("darwin", false, P, null)).toEqual({ cmd: "open", args: [P] });
  });

  it("uses `cmd /c start` on win32", () => {
    expect(browserOpenPlan("win32", false, P, null)).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", P],
    });
  });

  it("uses `xdg-open` on plain linux (not WSL)", () => {
    expect(browserOpenPlan("linux", false, P, null)).toEqual({ cmd: "xdg-open", args: [P] });
  });

  it("opens the Windows-side path via powershell Start-Process on WSL", () => {
    const winPath = "\\\\wsl.localhost\\Ubuntu\\home\\user\\report.html";
    const plan = browserOpenPlan("linux", true, P, winPath);
    expect(plan.cmd).toBe("powershell.exe");
    expect(plan.args).toContain("-Command");
    expect(plan.args[plan.args.length - 1]).toBe(`Start-Process -FilePath "${winPath}"`);
    // ファイルは移動せず WSL 内のパスを Windows パスへ変換して開く(全角パス問題を回避)。
    expect(plan.args.join(" ")).not.toContain(P);
  });

  it("falls back to xdg-open on WSL when the Windows path could not be resolved", () => {
    expect(browserOpenPlan("linux", true, P, null)).toEqual({ cmd: "xdg-open", args: [P] });
  });
});

// ============ Codex ソースフィルタ(T7) ============
// Codex 由来レコード(source:'codex')の埋め込み・ソースチップ UI・月予算注記・クライアント JS の
// フィルタ/バッジ描画・XSS 不変条件を、サーバ生成 HTML の構造検査で担保する。挙動(クリック等)は
// 既存流儀どおりブラウザ結合で別途確認。

/** codex 由来ターンを1件作る(source:'codex' 以外は makeTurn 既定 + overrides)。 */
function makeCodexTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return makeTurn({ source: "codex", models: ["gpt-5.1-codex"], ...overrides });
}

describe("runDashboard — Codex ソースフィルタ", () => {
  it("codex レコードは embed に sc:'codex' を持ち、Claude レコードには sc キーが無い", async () => {
    appendTurn(makeTurn({ models: ["claude-fable-5"], costUSD: 0.1, costJPY: 15, prompt: "claude turn" }));
    appendTurn(makeCodexTurn({ costUSD: 0.2, costJPY: 30, prompt: "codex turn" }));
    await run(["--no-open"]);
    const html = readHtml();
    // 生の埋め込み JSON に sc:"codex" が含まれる。
    expect(extractDataRaw(html)).toContain('"sc":"codex"');
    const turns = parseData(html).turns as unknown as Array<{ pr: string; sc?: string }>;
    const codex = turns.find((t) => t.pr === "codex turn");
    const claude = turns.find((t) => t.pr === "claude turn");
    expect(codex).toBeDefined();
    expect(claude).toBeDefined();
    expect(codex!.sc).toBe("codex");
    expect(claude!.sc).toBeUndefined(); // Claude 行に sc キーは無い(容量節約)
  });

  it("codex ありのとき ソースチップ(全体/Claude/Codex)を粒度トグルの隣に出す", async () => {
    appendTurn(makeCodexTurn({ costUSD: 0.2, costJPY: 30 }));
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain('id="cccn-src-toggle"');
    expect(html).toContain('data-src="all"');
    expect(html).toContain('data-src="claude"');
    expect(html).toContain('data-src="codex"');
    // チップのラベルはサーバ markup 内(ボタン直下テキスト)。
    expect(html).toContain('data-src="all">全体<');
    expect(html).toContain('data-src="claude">Claude<');
    expect(html).toContain('data-src="codex">Codex<');
  });

  it("codex ゼロのとき ソースチップは一切出ない(既存 UI を変えない)", async () => {
    appendTurn(makeTurn({ models: ["claude-fable-5"], costUSD: 0.1, costJPY: 15 }));
    await run(["--no-open"]);
    const html = readHtml();
    // markup 側の属性/コンテナのみで判定(APP_JS の querySelector('[data-src]') は data-src=" を含まない)。
    expect(html).not.toContain('data-src="');
    expect(html).not.toContain('id="cccn-src-toggle"');
  });

  it("APP_JS に cccn-src の永続化・ソースフィルタ述語・Codex バッジ描画が含まれる", async () => {
    appendTurn(makeCodexTurn({ costUSD: 0.2, costJPY: 30 }));
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain("cccn-src"); // sessionStorage キー(永続化)
    expect(html).toContain("sc === 'codex'"); // フィルタ述語 / バッジ判定
    expect(html).toContain("src-badge"); // Codex バッジ要素の class
    expect(html).toContain("createTextNode"); // 動的値は textContent/createTextNode 経由
  });

  it("APP_JS にヒーロー(通算バナー)のフィルタ連動ロジック(SA 行の非表示切替含む)が含まれる", async () => {
    appendTurn(makeCodexTurn({ costUSD: 0.2, costJPY: 30 }));
    await run(["--no-open"]);
    const html = readHtml();
    // ヒーローの $・¥・ターン数をフィルタ後の全期間合計で差し替える。
    expect(html).toContain("'.hero .hero-value'");
    expect(html).toContain("'.hero .hero-meta'");
    // SA 行はサーバ描画の接頭辞を再利用して数値だけ組み直し、SA 合計ゼロなら行ごと隠す。
    expect(html).toContain("heroSaPrefix");
    expect(html).toContain("heroSaEl.hidden = !(saUsd > 0)");
  });

  it("Codex 由来の危険プロンプトも \\u003c にエスケープされ、実行可能な形で埋め込まれない(XSS 回帰)", async () => {
    appendTurn(makeCodexTurn({ prompt: DANGEROUS_PROMPT, costUSD: 0.2, costJPY: 30 }));
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).not.toContain("<script>alert");
    const raw = extractDataRaw(html);
    expect(raw).not.toContain("</script");
    expect(raw).toContain("\\u003cscript>alert(1)\\u003c/script>");
    // JSON.parse 後は原文に復元される(埋め込み内は安全)。
    const turns = parseData(html).turns as unknown as Array<{ pr: string; sc?: string }>;
    const t = turns.find((x) => x.sc === "codex");
    expect(t).toBeDefined();
    expect(t!.pr).toContain("<script>alert(1)</script>");
  });
});

describe("runDashboard — Codex と月予算カード", () => {
  function setBudget(usd: number): void {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ monthlyBudgetUSD: usd }), "utf8");
  }

  it("Codex ありのとき 月予算カードに『全ソース合算』注記(サーバ markup)が出る", async () => {
    setBudget(400);
    appendTurn(makeTurn({ costUSD: 100, costJPY: 15000 })); // Claude・今月
    appendTurn(makeCodexTurn({ costUSD: 50, costJPY: 7500 })); // Codex・今月
    await run(["--no-open", "--all"]);
    const html = readHtml();
    expect(html).toContain('id="cccn-budget"');
    // サーバ描画の注記(APP_JS 内の文字列リテラルと区別するため <p class="note"> 形で判定)。
    expect(html).toContain('<p class="note">全ソース合算 / all sources</p>');
    // 予算バーは全ソース合算($150 / $400 = 37.5%)。フィルタの影響を受けない。
    expect(html).toContain("<b>$150.00</b> / $400.00");
    expect(html).toContain("37.5% used");
  });

  it("Codex 無しなら 月予算カードに『全ソース合算』注記マークアップは出ない", async () => {
    setBudget(400);
    appendTurn(makeTurn({ costUSD: 100, costJPY: 15000 }));
    await run(["--no-open"]);
    const html = readHtml();
    expect(html).toContain('id="cccn-budget"');
    expect(html).not.toContain('<p class="note">全ソース合算');
  });
});
