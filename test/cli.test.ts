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
    expect(output).toContain("dashboard [--all|--days N]");
    expect(output).toContain("sweep [--dry-run] [--days N]");
  });
});

// ============ runReport ============

describe("runReport", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "cccn-cli-test-report-"));
    process.env.CCCN_HOME = tmpHome;
  });

  afterEach(() => {
    delete process.env.CCCN_HOME;
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
    tmpHome = mkdtempSync(join(tmpdir(), "cccn-cli-test-doctor-"));
    process.env.CCCN_HOME = tmpHome;

    // CCCN_CLAUDE_PROJECTS: 一時dir配下に proj/x.jsonl として transcript フィクスチャを配置
    projectsDir = join(tmpHome, "claude-projects");
    mkdirSync(join(projectsDir, "proj"), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("./fixtures/transcript-basic.jsonl", import.meta.url)),
      join(projectsDir, "proj", "x.jsonl"),
    );
    process.env.CCCN_CLAUDE_PROJECTS = projectsDir;

    // hook コマンドが指すスクリプトパスとして実在するダミーファイルを用意する
    // (script path 存在チェックが ⚠️ にならず ✅ になることを確認するため)。
    const scriptDir = join(tmpHome, "ccc-notifier-dist");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "cli.js");
    writeFileSync(scriptPath, "", "utf8");

    // settings-existing.json フィクスチャのコピーに ccc-notifier を含む Stop エントリを足したもの
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

    // doctor の Codex ブロックが実 ~/.codex を読まないよう隔離(2026-07-10)。
    // 存在しないパスで「未検出(info 1行)」に固定し、実マシン/CI どちらでも出力を決定的にする。
    process.env.CCCN_CODEX_HOME = join(tmpHome, "no-codex");

    process.env.CCCN_DRY_RUN = "1";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in test")));
  });

  afterEach(() => {
    delete process.env.CCCN_CLAUDE_PROJECTS;
    delete process.env.CCCN_CLAUDE_SETTINGS;
    delete process.env.CCCN_CODEX_HOME;
    delete process.env.CCCN_CODEX_HOOK_SOURCES;
    delete process.env.CCCN_DRY_RUN;
    delete process.env.CCCN_HOME;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("Stop hook 登録済み・fetch 全滅でも ❌ 無しで 0 を返す", async () => {
    process.env.CCCN_CLAUDE_SETTINGS = goodSettingsPath;

    const { code, output } = await captureLogs(() => runDoctor());

    expect(code).toBe(0);
    expect((output.match(/❌/g) ?? []).length).toBe(0);
    expect((output.match(/✅/g) ?? []).length).toBeGreaterThan(0);
    expect(output).toContain("Claude Code 直近セッション合計:");
    expect(output).not.toContain("✅ 直近セッション合計:");
  });

  it("Stop エントリの無い settings.json では 1 を返す", async () => {
    process.env.CCCN_CLAUDE_SETTINGS = badSettingsPath;

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
    const scriptPath = join(tmpHome, "ccc-notifier-dist", "cli.js");
    const p = writeSettingsWithCommand(
      "settings-nodepath.json",
      `"/no/such/mise/node/bin/node" "${scriptPath}" track`,
    );
    process.env.CCCN_CLAUDE_SETTINGS = p;

    const { code, output } = await captureLogs(() => runDoctor());

    expect(code).toBe(0);
    expect((output.match(/❌/g) ?? []).length).toBe(0);
    expect(output).toContain("hook の Node 実行パスが見つかりません");
    expect(output).toContain("/no/such/mise/node/bin/node");
  });

  it("hook の第1トークンがベア名 'node' なら Node 実行パス警告を出さない", async () => {
    const scriptPath = join(tmpHome, "ccc-notifier-dist", "cli.js");
    const p = writeSettingsWithCommand("settings-barenode.json", `node "${scriptPath}" track`);
    process.env.CCCN_CLAUDE_SETTINGS = p;

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
    tmpHome = mkdtempSync(join(tmpdir(), "cccn-cli-test-sweep-"));
    projectsRoot = mkdtempSync(join(tmpdir(), "cccn-cli-test-sweep-proj-"));
    process.env.CCCN_HOME = tmpHome;
    process.env.CCCN_CLAUDE_PROJECTS = projectsRoot;
    // sweep が実 ~/.codex を読まないよう隔離(2026-07-10)。存在しないパスで detectCodex() を偽にし、
    // 実マシンの rollout(数百件)が history に混入して件数アサーションが壊れるのを防ぐ。
    process.env.CCCN_CODEX_HOME = join(tmpHome, "no-codex");
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
    delete process.env.CCCN_HOME;
    delete process.env.CCCN_CLAUDE_PROJECTS;
    delete process.env.CCCN_CODEX_HOME;
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

// ============ runDoctor — Codex ブロック ============
// Codex 検出は CCCN_CODEX_HOME に依存するため各ケースで一時ディレクトリに固定する
// (未設定だと実ホーム ~/.codex を見て非決定になるため、この describe では必ず張る)。
// Claude 側は健全な状態(マーカー付き Stop hook・読める projects)にして exit 0 を担保し、
// Codex ブロックが ❌ を出さない(exit code 意味論を変えない)ことを検証する。

describe("runDoctor — Codex ブロック", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "cccn-cli-test-codex-"));
    process.env.CCCN_HOME = tmpHome;

    // Claude projects: 空でも「読める」なら ✅(transcript 無しは ⚠️ 止まり)。
    const projectsDir = join(tmpHome, "claude-projects");
    mkdirSync(projectsDir, { recursive: true });
    process.env.CCCN_CLAUDE_PROJECTS = projectsDir;

    // マーカー付き Stop hook を持つ健全な settings.json(script/node を実在パスにして ✅)。
    const scriptDir = join(tmpHome, "ccc-notifier-dist");
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, "cli.js");
    writeFileSync(scriptPath, "", "utf8");
    const settingsPath = join(tmpHome, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: "command", command: `"${process.execPath}" "${scriptPath}" track`, timeout: 15 },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.CCCN_CLAUDE_SETTINGS = settingsPath;

    // 各 it が CCCN_CODEX_HOME を明示設定するが、設定し忘れた将来のテストが
    // 実 ~/.codex を読まないよう既定でも存在しないパスへ隔離しておく(2026-07-10)。
    process.env.CCCN_CODEX_HOME = join(tmpHome, "no-codex-default");

    process.env.CCCN_DRY_RUN = "1";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in test")));
  });

  function writeOwnedStopHook(codexHome: string, legacy = false): void {
    mkdirSync(codexHome, { recursive: true });
    const command = legacy
      ? `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" track --codex`
      : `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook Stop`;
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 20 }] }] },
    }));
  }

  function placeDoctorRollout(codexHome: string, fixture = "rollout-multiturn.jsonl"): string {
    const dir = join(codexHome, "sessions", "2026", "07", "14");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "rollout-doctor.jsonl");
    copyFileSync(fileURLToPath(new URL(`./fixtures/codex/${fixture}`, import.meta.url)), path);
    return path;
  }

  afterEach(() => {
    delete process.env.CCCN_HOME;
    delete process.env.CCCN_CLAUDE_PROJECTS;
    delete process.env.CCCN_CLAUDE_SETTINGS;
    delete process.env.CCCN_CODEX_HOME;
    delete process.env.CCCN_CODEX_HOOK_SOURCES;
    delete process.env.CCCN_DRY_RUN;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("Codex 未検出なら info 1行を出し、❌ 無しで 0 を返す", async () => {
    process.env.CCCN_CODEX_HOME = join(tmpHome, "no-such-codex"); // 実在しない → 未検出

    const { code, output } = await captureLogs(() => runDoctor());

    expect(code).toBe(0);
    expect(output).toContain("Codex CLI は未検出です");
    expect((output.match(/❌/g) ?? []).length).toBe(0);
  });

  it("Codex 検出+hook 登録済みなら ok 行(コマンド全文)と承認注意を出し、❌ 無しで 0 を返す", async () => {
    const codexHome = join(tmpHome, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    // 専用内部subcommandを持つ4イベントの hooks.json。
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook Stop`, timeout: 20 }] }],
            UserPromptSubmit: [{ hooks: [{ type: "command", command: `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook UserPromptSubmit`, timeout: 20 }] }],
            SubagentStart: [{ hooks: [{ type: "command", command: `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook SubagentStart`, timeout: 20 }] }],
            SubagentStop: [{ hooks: [{ type: "command", command: `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook SubagentStop`, timeout: 20 }] }],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.CCCN_CODEX_HOME = codexHome;

    const { code, output } = await captureLogs(() => runDoctor());

    expect(code).toBe(0);
    expect(output).toContain("Codex Stop hook");
    expect(output).toContain("Codex UserPromptSubmit hook");
    expect(output).toContain("Codex SubagentStart hook");
    expect(output).toContain("設定ファイル上で確認(user)");
    expect(output).toContain(
      `actual nodePath=${process.execPath.replace(/\\/g, "/")}`,
    );
    expect(output).toContain("actual cliPath=/x/ccc-notifier/dist/cli.js");
    expect(output).toContain("expected nodePath=");
    expect(output).toContain("expected cliPath=");
    expect(output).toContain("実体path=不一致(stale/wrong)");
    expect(output).toContain("project/hook trustは静的診断では未確認");
    expect(output).not.toContain("Codex UserPromptSubmit hookは検査できたJSON sourceでは確認できません");
    expect((output.match(/❌/g) ?? []).length).toBe(0);
  });

  it("旧3event設定はUserPromptSubmit不足を明示して4hook migrationを促す", async () => {
    const codexHome = join(tmpHome, "codex-home-old-three");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook Stop`, timeout: 20 }] }],
        SubagentStart: [{ hooks: [{ type: "command", command: `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook SubagentStart`, timeout: 20 }] }],
        SubagentStop: [{ hooks: [{ type: "command", command: `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook SubagentStop`, timeout: 20 }] }],
      },
    }));
    process.env.CCCN_CODEX_HOME = codexHome;

    const { code, output } = await captureLogs(() => runDoctor());
    expect(code).toBe(0);
    expect(output).toContain("Codex UserPromptSubmit hookは検査できたJSON sourceでは確認できません");
    expect(output).toContain("必要なら init --codex");
  });

  it("Codex 検出+hook 未登録なら warn 行を出すが ❌ にはせず 0 を返す", async () => {
    const codexHome = join(tmpHome, "codex-home");
    mkdirSync(codexHome, { recursive: true }); // hooks.json は作らない(= 未登録)
    process.env.CCCN_CODEX_HOME = codexHome;

    const { code, output } = await captureLogs(() => runDoctor());

    expect(code).toBe(0);
    expect(output).toContain("Codex Stop hookは検査できたJSON sourceでは確認できません");
    expect(output).toContain("Codex SubagentStop hookは検査できたJSON sourceでは確認できません");
    expect((output.match(/❌/g) ?? []).length).toBe(0);
  });

  it("所有Stop hook設定済みの場合だけ単一最新rolloutをモデル別にAPI換算しClaudeと別表示する", async () => {
    const codexHome = join(tmpHome, "codex-home-total");
    writeOwnedStopHook(codexHome);
    placeDoctorRollout(codexHome);
    process.env.CCCN_CODEX_HOME = codexHome;

    const { code, output } = await captureLogs(() => runDoctor());
    expect(code).toBe(0);
    expect(output).toContain(`Codex 最新rollout合計: ${formatUSD(0.0180125)}`);
    expect(output).toContain("API換算・単一rolloutのみ・親/子未分類/非合算・Claude Code分とは別集計");
    expect(output).not.toContain("Claude + Codex");
  });

  it("厳格な旧track --codex Stopも設定済み扱いにする", async () => {
    const codexHome = join(tmpHome, "codex-home-legacy-total");
    writeOwnedStopHook(codexHome, true);
    placeDoctorRollout(codexHome, "rollout-basic.jsonl");
    process.env.CCCN_CODEX_HOME = codexHome;
    const { code, output } = await captureLogs(() => runDoctor());
    expect(code).toBe(0);
    expect(output).toContain(`Codex 最新rollout合計: ${formatUSD(0.064106)}`);
    expect(output).toContain("API換算");
  });

  it("rolloutがあっても所有Stop hook未設定・TOMLだけなら合計もskip行も出さない", async () => {
    const codexHome = join(tmpHome, "codex-home-unowned-total");
    mkdirSync(codexHome, { recursive: true });
    placeDoctorRollout(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "[hooks]\nopaque=true\n");
    process.env.CCCN_CODEX_HOME = codexHome;
    const { code, output } = await captureLogs(() => runDoctor());
    expect(code).toBe(0);
    expect(output).not.toContain("Codex 最新rollout合計:");
  });

  it("env-extra JSONだけの所有Stopは診断するが金額gateには使わない", async () => {
    const codexHome = join(tmpHome, "codex-home-env-extra-only");
    mkdirSync(codexHome, { recursive: true });
    placeDoctorRollout(codexHome);
    const extra = join(tmpHome, "supplemental-hooks.json");
    writeFileSync(extra, JSON.stringify({
      hooks: { Stop: [{ hooks: [{
        type: "command",
        command: `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook Stop`,
        timeout: 20,
      }] }] },
    }));
    process.env.CCCN_CODEX_HOME = codexHome;
    process.env.CCCN_CODEX_HOOK_SOURCES = extra;
    const { code, output } = await captureLogs(() => runDoctor());
    expect(code).toBe(0);
    expect(output).toContain("Codex Stop hookを設定ファイル上で確認(env-extra)");
    expect(output).not.toContain("Codex 最新rollout合計:");
  });

  it("設定済みでもsessions無しはwarnだけでexit 0", async () => {
    const codexHome = join(tmpHome, "codex-home-no-sessions");
    writeOwnedStopHook(codexHome);
    process.env.CCCN_CODEX_HOME = codexHome;
    const { code, output } = await captureLogs(() => runDoctor());
    expect(code).toBe(0);
    expect(output).toContain("Codex 最新rollout合計: セッションディレクトリがないためスキップ");
    expect(output).not.toContain("❌ Codex 最新rollout合計");
  });

  it("unknown modelは安全化したmodel名と過少計上警告を出してexit 0", async () => {
    const codexHome = join(tmpHome, "codex-home-unknown-total");
    writeOwnedStopHook(codexHome);
    const rollout = placeDoctorRollout(codexHome);
    const changed = readFileSync(rollout, "utf8").replaceAll(
      "gpt-5-codex",
      "unknown-model\\u000a\\u2028\\u2029\\u202eSECRET",
    );
    writeFileSync(rollout, changed);
    process.env.CCCN_CODEX_HOME = codexHome;
    const { code, output } = await captureLogs(() => runDoctor());
    expect(code).toBe(0);
    expect(output).toContain("Codex 最新rollout合計:");
    expect(output).toContain("単価不明モデルを含むため過少計上");
    expect(output).toContain("unknown-modelSECRET");
    expect(output).not.toContain("unknown-model\nSECRET");
    expect(output).not.toContain("\u2028");
    expect(output).not.toContain("\u2029");
    expect(output).not.toContain("\u202e");
  });

  it("prototype-like model IDでも組込みを変更せずwarn+exit 0", async () => {
    const codexHome = join(tmpHome, "codex-home-prototype-models");
    writeOwnedStopHook(codexHome);
    const rollout = placeDoctorRollout(codexHome);
    const changed = readFileSync(rollout, "utf8")
      .replaceAll("gpt-5.5", "__proto__")
      .replaceAll("gpt-5-codex", "constructor");
    writeFileSync(rollout, changed);
    process.env.CCCN_CODEX_HOME = codexHome;
    const prototypeBefore = Object.getOwnPropertyNames(Object.prototype);
    const constructorBefore = Object.getOwnPropertyNames(Object);
    const { code, output } = await captureLogs(() => runDoctor());
    expect(code).toBe(0);
    expect(output).toContain("⚠️ Codex 最新rollout合計:");
    expect(output).toContain("__proto__");
    expect(output).toContain("constructor");
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(prototypeBefore);
    expect(Object.getOwnPropertyNames(Object)).toEqual(constructorBefore);
  });

  it("探索不完全なら金額を表示せずwarnだけでexit 0", async () => {
    const codexHome = join(tmpHome, "codex-home-incomplete");
    writeOwnedStopHook(codexHome);
    writeFileSync(join(codexHome, "sessions"), "not-a-directory");
    process.env.CCCN_CODEX_HOME = codexHome;
    const { code, output } = await captureLogs(() => runDoctor());
    expect(code).toBe(0);
    expect(output).toContain("⚠️ Codex 最新rollout合計: rollout探索を完全に検証できず最新を確定できないためスキップ");
    expect(output).not.toContain("✅ Codex 最新rollout合計:");
  });

  it("Codex合計診断はrollout/history/cursor/activity/dashboardをbyte-exactに変えずlockも作らない", async () => {
    const codexHome = join(tmpHome, "codex-home-read-only");
    writeOwnedStopHook(codexHome);
    const rollout = placeDoctorRollout(codexHome);
    process.env.CCCN_CODEX_HOME = codexHome;
    const sentinels = [
      join(tmpHome, "history.jsonl"),
      join(tmpHome, "cursors.json"),
      join(tmpHome, "codex-subagent-activity.json"),
      join(tmpHome, "codex-subagent-key"),
      join(tmpHome, "report.html"),
    ];
    for (const [index, file] of sentinels.entries()) writeFileSync(file, `sentinel-${index}\n`);
    const before = new Map([...sentinels, rollout].map((file) => [file, readFileSync(file)]));

    const { code } = await captureLogs(() => runDoctor());
    expect(code).toBe(0);
    for (const [file, bytes] of before) expect(readFileSync(file)).toEqual(bytes);
    expect(existsSync(join(tmpHome, "cache", "data.lock"))).toBe(false);
    expect(existsSync(join(tmpHome, "codex-subagent-activity.lock"))).toBe(false);
    expect(existsSync(join(tmpHome, "codex-subagent-key.lock"))).toBe(false);
  });

  it("hooks無効・timeout不一致・複数source重複・trust制限を明示する", async () => {
    const codexHome = join(tmpHome, "codex-home");
    const extra = join(tmpHome, "project-hooks.json");
    mkdirSync(codexHome, { recursive: true });
    const makeHooks = (timeout: number) => ({
      features: { hooks: false },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook Stop`, timeout }] }],
        SubagentStart: [{ hooks: [{ type: "command", command: `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook SubagentStart`, timeout }] }],
        SubagentStop: [{ hooks: [{ type: "command", command: `"${process.execPath}" "/x/ccc-notifier/dist/cli.js" __ccc-notifier-codex-hook SubagentStop`, timeout }] }],
      },
    });
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify(makeHooks(10)));
    writeFileSync(extra, JSON.stringify(makeHooks(20)));
    process.env.CCCN_CODEX_HOME = codexHome;
    process.env.CCCN_CODEX_HOOK_SOURCES = extra;

    const { output } = await captureLogs(() => runDoctor());
    expect(output).toContain("timeout=10");
    expect(output).toContain("非標準features.hooks field");
    expect(output).toContain("exact duplicate");
    expect(output).toContain("project/hook trustは静的診断では未確認");
    delete process.env.CCCN_CODEX_HOOK_SOURCES;
  });

  it("Codex home不在でもproject標準sourceをearly-return前に診断しTOMLをunknown表示する", async () => {
    const repo = join(tmpHome, "project-repo");
    const nested = join(repo, "nested");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".codex"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repo, ".codex", "config.toml"), '# [hooks]\nsecret = "DO-NOT-PRINT"');
    process.env.CCCN_CODEX_HOME = join(tmpHome, "missing-codex-home");
    const previous = process.cwd();
    try {
      process.chdir(nested);
      const { code, output } = await captureLogs(() => runDoctor());
      expect(code).toBe(0);
      expect(output).not.toContain("Codex CLI は未検出です");
      expect(output).toContain("inline hook候補を検出しました(project, standard)");
      expect(output).toContain("config.tomlは解釈しない");
      expect(output).toContain("plugin/managed/session source");
      expect(output).toContain("/hooks");
      expect(output).not.toContain("DO-NOT-PRINT");
    } finally {
      process.chdir(previous);
    }
  });
});
