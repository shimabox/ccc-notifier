// test/cli.test.ts (T8)
//
// 契約: src/contracts.md の "src/cli.ts, src/doctor.ts, src/report.ts (T8)" 参照。
//
// 注意: src/track.ts / src/setup.ts は並行実装中のため、このテストファイルは
// それらを直接 import しない。main() のテスト(--version / unknown / help)は
// src/cli.ts を経由するが、cli.ts 側が track/setup を動的 import() しているため、
// track/setup が万一未完成・破損していても、track/init/uninstall を実際に実行しない
// これらのテストには影響しない。念のため cli.ts 自体も各 it() 内で動的 import する
// (静的 import にすると、cli.ts の読み込みに失敗した場合にファイル全体のテスト収集が
// 失敗し、report/doctor 系の無関係なテストまで巻き込まれてしまうため)。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDoctor } from "../src/doctor";
import { formatUSD } from "../src/format";
import { runReport } from "../src/report";
import { appendTurn } from "../src/store";
import type { TurnRecord } from "../src/types";

// ============ 共通ヘルパー ============

/** console.log を spy し、呼び出し中の戻り値と出力(全呼び出しを連結したテキスト)を返す。 */
async function captureLogs(fn: () => Promise<number>): Promise<{ code: number; output: string }> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const code = await fn();
    const output = spy.mock.calls.map((args) => args.map((a) => String(a)).join(" ")).join("\n");
    return { code, output };
  } finally {
    spy.mockRestore();
  }
}

function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    sessionId: "sess-report",
    project: "/tmp/proj",
    gitBranch: "main",
    models: ["claude-fable-5"],
    tokens: { input: 100, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    sidechainTokens: null,
    apiCalls: 1,
    costUSD: 0.1,
    costJPY: 15,
    fxRate: 150,
    fxSource: "fixed",
    prompt: "test prompt",
    ...overrides,
  };
}

interface ReportJson {
  days: number;
  daily: Array<{
    date: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    costJPY: number;
  }>;
  byModel: Record<string, { turns: number; costUSD: number; costJPY: number }>;
  total: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    costJPY: number;
    subagentsUSD: number;
  };
}

// ============ main() ============
// --version / unknown-cmd / (引数なし) の3ケース。cli.ts は各 it 内で動的 import する。

describe("main", () => {
  it("main(['--version']) は 0 を返し、セマンティックバージョン風の文字列を表示する", async () => {
    const { main } = await import("../src/cli");
    const { code, output } = await captureLogs(() => main(["--version"]));

    expect(code).toBe(0);
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("main(['-v']) も --version と同様に扱う", async () => {
    const { main } = await import("../src/cli");
    const { code, output } = await captureLogs(() => main(["-v"]));

    expect(code).toBe(0);
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("main(['unknown-cmd']) は 1 を返し、help を表示する(track にフォールバックしない)", async () => {
    const { main } = await import("../src/cli");
    const { code, output } = await captureLogs(() => main(["unknown-cmd"]));

    expect(code).toBe(1);
    expect(output).toContain("使い方");
    expect(output).toContain("doctor");
  });

  it("main([]) (引数なし) は 0 を返し、help を表示する", async () => {
    const { main } = await import("../src/cli");
    const { code, output } = await captureLogs(() => main([]));

    expect(code).toBe(0);
    expect(output).toContain("使い方");
    expect(output).toContain("report");
  });

  it("main(['--help']) も引数なしと同様に help を表示して 0 を返す", async () => {
    const { main } = await import("../src/cli");
    const { code, output } = await captureLogs(() => main(["--help"]));

    expect(code).toBe(0);
    expect(output).toContain("Usage");
  });
});

// ============ runReport ============

describe("runReport", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "acn-cli-test-report-"));
    process.env.ACN_HOME = tmpHome;
  });

  afterEach(() => {
    delete process.env.ACN_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("日付・モデルの異なる3件を集計し、既定30日の合計・日別件数が期待どおりで、--days 1 で古い行が除外される", async () => {
    const now = Date.now();
    const day = 86400000;

    // 12時間前: 既定(30日)・--days 1 のどちらでも含まれる
    const recent = makeTurn({
      ts: new Date(now - 12 * 60 * 60 * 1000).toISOString(),
      models: ["claude-fable-5"],
      costUSD: 0.1,
      costJPY: 15,
    });
    // 2日前: 既定(30日)では含まれるが --days 1 では除外される
    const mid = makeTurn({
      ts: new Date(now - 2 * day).toISOString(),
      models: ["claude-sonnet-5"],
      costUSD: 0.2,
      costJPY: 30,
    });
    // 40日前: 既定(30日)でも --days 1 でも除外される
    const old = makeTurn({
      ts: new Date(now - 40 * day).toISOString(),
      models: ["claude-haiku-4-5"],
      costUSD: 0.05,
      costJPY: 7.5,
    });

    appendTurn(old);
    appendTurn(recent);
    appendTurn(mid);

    const all = await captureLogs(() => runReport(["--json"]));
    expect(all.code).toBe(0);
    const allJson = JSON.parse(all.output) as ReportJson;

    expect(allJson.days).toBe(30);
    expect(allJson.total.turns).toBe(2);
    expect(allJson.daily.length).toBe(2);
    expect(allJson.total.costUSD).toBeCloseTo(0.3, 10);
    expect(allJson.total.costJPY).toBeCloseTo(45, 10);
    expect(Object.keys(allJson.byModel).sort()).toEqual(["claude-fable-5", "claude-sonnet-5"]);
    expect(allJson.byModel["claude-haiku-4-5"]).toBeUndefined();

    const recentOnly = await captureLogs(() => runReport(["--days", "1", "--json"]));
    expect(recentOnly.code).toBe(0);
    const recentJson = JSON.parse(recentOnly.output) as ReportJson;

    expect(recentJson.total.turns).toBe(1);
    expect(recentJson.daily.length).toBe(1);
    expect(Object.keys(recentJson.byModel)).toEqual(["claude-fable-5"]);
    expect(recentJson.total.costUSD).toBeCloseTo(0.1, 10);
  });

  it("--json の byModel は costByModel があれば実配分、無ければ主モデルへのフォールバックになる", async () => {
    // costByModel あり: fable/haiku へ実配分される(1ターン=1レコードだが2モデル行に分かれる)。
    appendTurn(
      makeTurn({
        models: ["claude-fable-5", "claude-haiku-4-5"],
        costUSD: 1.0,
        costJPY: 150,
        costByModel: { "claude-fable-5": 0.9, "claude-haiku-4-5": 0.1 },
      }),
    );
    // costByModel 無し(旧レコード相当): 主モデル(先頭)へ全額フォールバック計上される。
    appendTurn(
      makeTurn({
        models: ["claude-sonnet-5"],
        costUSD: 0.5,
        costJPY: 75,
      }),
    );

    const { code, output } = await captureLogs(() => runReport(["--json", "--days", "9999"]));
    expect(code).toBe(0);
    const json = JSON.parse(output) as ReportJson;

    expect(json.byModel["claude-fable-5"].costUSD).toBeCloseTo(0.9, 10);
    expect(json.byModel["claude-fable-5"].turns).toBe(1);
    expect(json.byModel["claude-haiku-4-5"].costUSD).toBeCloseTo(0.1, 10);
    expect(json.byModel["claude-haiku-4-5"].turns).toBe(1);
    // フォールバック: costByModel が無いレコードは主モデルへ全額計上される。
    expect(json.byModel["claude-sonnet-5"].costUSD).toBeCloseTo(0.5, 10);
    expect(json.byModel["claude-sonnet-5"].turns).toBe(1);

    // 実配分の合計は総コストと一致する。参加カウントのため byModel の turns 合計(3)は
    // 総ターン数(2)を超える。
    const sumCost = Object.values(json.byModel).reduce((s, m) => s + m.costUSD, 0);
    expect(sumCost).toBeCloseTo(json.total.costUSD, 8);
    expect(json.total.turns).toBe(2);
    const sumTurns = Object.values(json.byModel).reduce((s, m) => s + m.turns, 0);
    expect(sumTurns).toBe(3);
  });

  it("--json の total は SA 込み・subagentsUSD キーを持ち、byModel は SA モデルもマージする", async () => {
    // メイン fable 0.267 + SA sonnet 0.033(GOLDEN 相当)。
    appendTurn(
      makeTurn({
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

    const { code, output } = await captureLogs(() => runReport(["--json", "--days", "9999"]));
    expect(code).toBe(0);
    const json = JSON.parse(output) as ReportJson;

    // total は SA 込みの総額、subagentsUSD は SA 部分。
    expect(json.total.costUSD).toBeCloseTo(0.3, 8);
    expect(json.total.subagentsUSD).toBeCloseTo(0.033, 10);
    // byModel は メイン(fable)と SA(sonnet)の両方を持つ。
    expect(json.byModel["claude-fable-5"].costUSD).toBeCloseTo(0.267, 10);
    expect(json.byModel["claude-sonnet-5"].costUSD).toBeCloseTo(0.033, 10);
    // byModel の合計は総額と一致する。
    const sumCost = Object.values(json.byModel).reduce((s, m) => s + m.costUSD, 0);
    expect(sumCost).toBeCloseTo(json.total.costUSD, 8);

    // テキスト表には「(うちサブエージェント $0.033)」が1行出て、byModel 表に SA モデルが並ぶ。
    const table = await captureLogs(() => runReport(["--days", "9999"]));
    expect(table.code).toBe(0);
    expect(table.output).toContain("うちサブエージェント");
    expect(table.output).toContain(formatUSD(0.033)); // "$0.033"
    expect(table.output).toContain("claude-sonnet-5"); // byModel 表(モデルIDそのまま)
  });

  it("SA の無い履歴では total.subagentsUSD は 0 で、テキスト表に SA 行は出ない", async () => {
    appendTurn(makeTurn({ models: ["claude-fable-5"], costUSD: 0.1, costJPY: 15 }));

    const jsonRes = await captureLogs(() => runReport(["--json"]));
    const json = JSON.parse(jsonRes.output) as ReportJson;
    expect(json.total.subagentsUSD).toBe(0);

    const table = await captureLogs(() => runReport([]));
    expect(table.output).not.toContain("うちサブエージェント");
  });

  it("--days に不正値を渡すと既定の30が使われる", async () => {
    appendTurn(makeTurn());

    const { code, output } = await captureLogs(() => runReport(["--days", "not-a-number", "--json"]));

    expect(code).toBe(0);
    const json = JSON.parse(output) as ReportJson;
    expect(json.days).toBe(30);
  });

  it("履歴が無ければ 0 を返し「履歴がありません」を表示する", async () => {
    const { code, output } = await captureLogs(() => runReport([]));

    expect(code).toBe(0);
    expect(output).toContain("履歴がありません");
  });

  it("--json 指定でも履歴が無ければ JSON ではなく「履歴がありません」を表示する", async () => {
    const { code, output } = await captureLogs(() => runReport(["--json"]));

    expect(code).toBe(0);
    expect(output).toContain("履歴がありません");
    expect(() => JSON.parse(output)).toThrow();
  });
});

// ============ runDoctor ============

describe("runDoctor", () => {
  let tmpHome: string;
  let projectsDir: string;
  let goodSettingsPath: string;
  let badSettingsPath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "acn-cli-test-doctor-"));
    process.env.ACN_HOME = tmpHome;

    // ACN_CLAUDE_PROJECTS: 一時dir配下に proj/x.jsonl として transcript フィクスチャを配置
    projectsDir = join(tmpHome, "claude-projects");
    mkdirSync(join(projectsDir, "proj"), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("./fixtures/transcript-basic.jsonl", import.meta.url)),
      join(projectsDir, "proj", "x.jsonl"),
    );
    process.env.ACN_CLAUDE_PROJECTS = projectsDir;

    // hook コマンドが指すスクリプトパスとして実在するダミーファイルを用意する
    // (script path 存在チェックが ⚠️ にならず ✅ になることを確認するため)。
    const scriptDir = join(tmpHome, "agent-cost-notifier-dist");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "cli.js");
    writeFileSync(scriptPath, "", "utf8");

    // settings-existing.json フィクスチャのコピーに agent-cost-notifier を含む Stop エントリを足したもの
    const rawFixture = readFileSync(
      fileURLToPath(new URL("./fixtures/settings-existing.json", import.meta.url)),
      "utf8",
    );
    const parsedGood = JSON.parse(rawFixture) as Record<string, unknown>;
    const existingHooks = (parsedGood.hooks ?? {}) as Record<string, unknown>;
    parsedGood.hooks = {
      ...existingHooks,
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `"${process.execPath}" "${scriptPath}" track`,
              timeout: 15,
            },
          ],
        },
      ],
    };
    goodSettingsPath = join(tmpHome, "settings-good.json");
    writeFileSync(goodSettingsPath, JSON.stringify(parsedGood, null, 2), "utf8");

    // Stop エントリなし(= 元のフィクスチャそのまま)
    badSettingsPath = join(tmpHome, "settings-bad.json");
    writeFileSync(badSettingsPath, rawFixture, "utf8");

    process.env.ACN_DRY_RUN = "1";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in test")));
  });

  afterEach(() => {
    delete process.env.ACN_CLAUDE_PROJECTS;
    delete process.env.ACN_CLAUDE_SETTINGS;
    delete process.env.ACN_DRY_RUN;
    delete process.env.ACN_HOME;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("Stop hook 登録済み・fetch 全滅でも ❌ 無しで 0 を返す", async () => {
    process.env.ACN_CLAUDE_SETTINGS = goodSettingsPath;

    const { code, output } = await captureLogs(() => runDoctor());

    expect(code).toBe(0);
    expect((output.match(/❌/g) ?? []).length).toBe(0);
    expect((output.match(/✅/g) ?? []).length).toBeGreaterThan(0);
  });

  it("Stop エントリの無い settings.json では 1 を返す", async () => {
    process.env.ACN_CLAUDE_SETTINGS = badSettingsPath;

    const { code, output } = await captureLogs(() => runDoctor());

    expect(code).toBe(1);
    expect((output.match(/❌/g) ?? []).length).toBeGreaterThan(0);
  });

  /** settings-existing.json を基に、Stop の hook command を差し替えた settings ファイルを書く。 */
  function writeSettingsWithCommand(name: string, command: string): string {
    const rawFixture = readFileSync(
      fileURLToPath(new URL("./fixtures/settings-existing.json", import.meta.url)),
      "utf8",
    );
    const parsed = JSON.parse(rawFixture) as Record<string, unknown>;
    const existingHooks = (parsed.hooks ?? {}) as Record<string, unknown>;
    parsed.hooks = {
      ...existingHooks,
      Stop: [{ hooks: [{ type: "command", command, timeout: 15 }] }],
    };
    const p = join(tmpHome, name);
    writeFileSync(p, JSON.stringify(parsed, null, 2), "utf8");
    return p;
  }

  it("hook の第1トークンが存在しない絶対パスの Node なら ⚠️ を出すが ❌ にせず 0 を返す", async () => {
    // scriptPath は beforeEach が実在させたダミー(存在チェックは ✅ のまま)。第1トークンだけ無効化。
    const scriptPath = join(tmpHome, "agent-cost-notifier-dist", "cli.js");
    const p = writeSettingsWithCommand(
      "settings-nodepath.json",
      `"/no/such/mise/node/bin/node" "${scriptPath}" track`,
    );
    process.env.ACN_CLAUDE_SETTINGS = p;

    const { code, output } = await captureLogs(() => runDoctor());

    expect(code).toBe(0);
    expect((output.match(/❌/g) ?? []).length).toBe(0);
    expect(output).toContain("hook の Node 実行パスが見つかりません");
    expect(output).toContain("/no/such/mise/node/bin/node");
  });

  it("hook の第1トークンがベア名 'node' なら Node 実行パス警告を出さない", async () => {
    const scriptPath = join(tmpHome, "agent-cost-notifier-dist", "cli.js");
    const p = writeSettingsWithCommand("settings-barenode.json", `node "${scriptPath}" track`);
    process.env.ACN_CLAUDE_SETTINGS = p;

    const { code, output } = await captureLogs(() => runDoctor());

    expect(code).toBe(0);
    expect(output).not.toContain("hook の Node 実行パスが見つかりません");
  });
});

// ============ main sweep 配線 ============
// main() が "sweep" を runSweep に配線し、rest 引数(--dry-run)を渡すことを検証する。

describe("main sweep", () => {
  let tmpHome: string;
  let projectsRoot: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "acn-cli-test-sweep-"));
    projectsRoot = mkdtempSync(join(tmpdir(), "acn-cli-test-sweep-proj-"));
    process.env.ACN_HOME = tmpHome;
    process.env.ACN_CLAUDE_PROJECTS = projectsRoot;
    // 実ネットワークに出ない保険(単価 builtin / fx fixed 150 に決定的にフォールバック)。
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    mkdirSync(join(projectsRoot, "projA"), { recursive: true });
    const t1 = join(projectsRoot, "projA", "t1.jsonl");
    copyFileSync(
      fileURLToPath(new URL("./fixtures/transcript-multiturn.jsonl", import.meta.url)),
      t1,
    );
    // コピー直後(mtime=現在)だと進行中セッション保護でスキップされるため、完了済みを模して古くする。
    const aged = new Date(Date.now() - 10 * 60_000);
    utimesSync(t1, aged, aged);
  });

  afterEach(() => {
    delete process.env.ACN_HOME;
    delete process.env.ACN_CLAUDE_PROJECTS;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(projectsRoot, { recursive: true, force: true });
  });

  it("main(['sweep','--dry-run']) は 0 を返しサマリを表示するが history を書かない", async () => {
    const { main } = await import("../src/cli");
    const { code, output } = await captureLogs(() => main(["sweep", "--dry-run"]));

    expect(code).toBe(0);
    expect(output).toContain("dry-run: 書き込みは行っていません");
    expect(output).toContain("走査:");
    expect(existsSync(join(tmpHome, "history.jsonl"))).toBe(false);
  });

  it("main(['sweep']) は rest を runSweep に渡し history に ingest:'sweep' を2行書く", async () => {
    const { main } = await import("../src/cli");
    const { code } = await captureLogs(() => main(["sweep"]));

    expect(code).toBe(0);
    const rows = readFileSync(join(tmpHome, "history.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TurnRecord);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ingest === "sweep")).toBe(true);
  });
});
