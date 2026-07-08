// test/e2e.test.ts — 結合 E2E テスト(ビルド済み dist/cli.js を child_process で実際に起動する)
//
// 契約: src/contracts.md 全体、および GOLDEN 値は test/fixtures/GOLDEN.md
// (test/fixtures/transcript-basic.jsonl の正解値)を参照。
//
// 他の test/*.test.ts は各モジュール(src/track.ts, src/setup.ts, src/cli.ts …)を直接
// import して検証する unit / integration テストだが、このファイルは「npm run build で
// 生成された dist/cli.js」を実際に子プロセスとして spawn し、実プロセスの
// exit code・stdout・stderr・ファイル副作用のみを観察するブラックボックス E2E テストである。
// src/** は一切 import しない(型情報の参照のみ import type で行う)。
//
// 前提: `npm run build` 済みであること。ビルド自体はこのテストの責務ではない
// (呼び出し側が `npm run build` → このファイル → `npm test` の順で実行する)。
// dist/cli.js が存在しない場合は beforeAll でわかりやすいメッセージとともに fail する。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TurnRecord } from "../src/types";

// 子プロセスを複数回 spawn する関係で、既定の testTimeout (5000ms) では足りないことがある。
vi.setConfig({ testTimeout: 30000 });

// ============ 定数・フィクスチャパス ============

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "dist", "cli.js");

const FIXTURE_TRANSCRIPT = fileURLToPath(new URL("./fixtures/transcript-basic.jsonl", import.meta.url));
const FIXTURE_STDIN = fileURLToPath(new URL("./fixtures/stop-hook-stdin.json", import.meta.url));
const FIXTURE_SETTINGS = fileURLToPath(new URL("./fixtures/settings-existing.json", import.meta.url));
const FIXTURE_SUBAGENT = fileURLToPath(new URL("./fixtures/subagent-basic.jsonl", import.meta.url));

const FIXED_FX_RATE = 150;

// 子プロセスが応答不能になった場合に無限に待ち続けないための安全弁(テスト全体の
// testTimeout=30000ms より十分短くし、詰まった場合でも他のアサーション時間を圧迫しない)。
const RUNCLI_KILL_MS = 15000;

// ============ runCli ヘルパー ============

interface RunCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** dist/cli.js を実際の子プロセスとして起動し、終了コード・stdout・stderr をまとめて返す。 */
function runCli(args: string[], opts: { env: NodeJS.ProcessEnv; stdin?: string }): Promise<RunCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env: opts.env });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `runCli: "node dist/cli.js ${args.join(" ")}" が ${RUNCLI_KILL_MS}ms 以内に終了しませんでした\n` +
            `--- stdout so far ---\n${Buffer.concat(stdoutChunks).toString("utf8")}\n` +
            `--- stderr so far ---\n${Buffer.concat(stderrChunks).toString("utf8")}`,
        ),
      );
    }, RUNCLI_KILL_MS);

    child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    child.stdin.end(opts.stdin ?? "", "utf8");
  });
}

// ============ サンドボックス ============
// 各テストで CCCN_HOME・fixture transcript のコピー・settings.json のコピー・
// CCCN_CLAUDE_PROJECTS 用ディレクトリを一時領域に作り直す。実ホーム
// (~/.claude や ~/.ccc-notifier)には一切触れない。

interface Sandbox {
  tmp: string;
  cccnHome: string;
  transcriptPath: string; // track の stdin (transcript_path) に使う fixture のコピー
  settingsPath: string; // CCCN_CLAUDE_SETTINGS に使う fixture のコピー
  projectsDir: string; // CCCN_CLAUDE_PROJECTS。proj/session.jsonl に fixture のコピーを配置
  env: NodeJS.ProcessEnv;
}

function createSandbox(): Sandbox {
  const tmp = mkdtempSync(join(tmpdir(), "cccn-e2e-"));

  const cccnHome = join(tmp, "cccn-home");
  const cacheDir = join(cccnHome, "cache");
  mkdirSync(cacheDir, { recursive: true });

  // 為替を決定的にする: costJPY = costUSD × 150 が常に確定するよう、新鮮な fx キャッシュを
  // 事前生成する(cacheHours は既定12時間なので必ずキャッシュヒットし、ネットには一切出ない)。
  writeFileSync(
    join(cacheDir, "fx.json"),
    JSON.stringify({ rate: FIXED_FX_RATE, fetchedAt: new Date().toISOString() }),
    "utf8",
  );

  // 単価表も決定的 & オフラインにする。doctor の checkPricing は offline:false で
  // loadPriceTable を呼ぶため、新鮮な pricing キャッシュを与えないと実ネットワーク
  // (GitHub raw)へ到達を試みてしまう。GOLDEN.md と同値の単価を litellm 由来として与える
  // (数値は builtin と同一なので、他シナリオの GOLDEN コスト計算には影響しない)。
  writeFileSync(
    join(cacheDir, "pricing.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      table: {
        "claude-fable-5": {
          input: 10,
          output: 50,
          cacheWrite5m: 12.5,
          cacheWrite1h: 20,
          cacheRead: 1,
          source: "litellm",
        },
        "claude-haiku-4-5": {
          input: 1,
          output: 5,
          cacheWrite5m: 1.25,
          cacheWrite1h: 2,
          cacheRead: 0.1,
          source: "litellm",
        },
      },
    }),
    "utf8",
  );

  const transcriptPath = join(tmp, "transcript.jsonl");
  copyFileSync(FIXTURE_TRANSCRIPT, transcriptPath);

  const settingsPath = join(tmp, "settings.json");
  copyFileSync(FIXTURE_SETTINGS, settingsPath);

  const projectsDir = join(tmp, "claude-projects");
  mkdirSync(join(projectsDir, "proj"), { recursive: true });
  const sweepTarget = join(projectsDir, "proj", "session.jsonl");
  copyFileSync(FIXTURE_TRANSCRIPT, sweepTarget);
  // コピー直後(mtime=現在)だと sweep の進行中セッション保護でスキップされるため、完了済みを模して古くする。
  const aged = new Date(Date.now() - 10 * 60_000);
  utimesSync(sweepTarget, aged, aged);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CCCN_HOME: cccnHome,
    CCCN_DRY_RUN: "1",
    CCCN_CLAUDE_SETTINGS: settingsPath,
    CCCN_CLAUDE_PROJECTS: projectsDir,
    CCCN_CLI_PATH: CLI_PATH,
  };

  return { tmp, cccnHome, transcriptPath, settingsPath, projectsDir, env };
}

function cleanupSandbox(sb: Sandbox): void {
  rmSync(sb.tmp, { recursive: true, force: true });
}

// ============ 小ヘルパー ============

/** stop-hook-stdin.json の __TRANSCRIPT_PATH__ を実パスへ置換した stdin 文字列を返す。 */
function stdinFor(transcriptPath: string): string {
  const raw = readFileSync(FIXTURE_STDIN, "utf8");
  // JSON 文字列リテラルごと置換する(Windows パスの \ を JSON.stringify で正しくエスケープ。
  // 生文字列の埋め込みは不正な JSON になり、track のフェイルセーフに黙殺される)。
  return raw.replace('"__TRANSCRIPT_PATH__"', () => JSON.stringify(transcriptPath));
}

function readHistory(cccnHome: string): TurnRecord[] {
  const file = join(cccnHome, "history.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TurnRecord);
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function findBackups(settingsPath: string): string[] {
  const dir = dirname(settingsPath);
  const base = basename(settingsPath);
  return readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-`));
}

// ============ テスト本体 ============

describe("E2E: dist/cli.js (built binary via child_process)", () => {
  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `dist/cli.js が見つかりません: ${CLI_PATH}\n` +
          "先に `npm run build` を実行してから、このテストを再実行してください。",
      );
    }
  });

  let sb: Sandbox;

  beforeEach(() => {
    sb = createSandbox();
  });

  afterEach(() => {
    cleanupSandbox(sb);
  });

  // ---- 1. track 正常系 ----
  it("1. track: GOLDEN 値どおりに1行記録し、stdout は完全に空、通知タイトルに費用が入る", async () => {
    const result = await runCli(["track"], { env: sb.env, stdin: stdinFor(sb.transcriptPath) });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");

    const rows = readHistory(sb.cccnHome);
    expect(rows).toHaveLength(1);
    const rec = rows[0];

    expect(rec.costUSD).toBeCloseTo(0.267, 10);
    expect(rec.costJPY).toBeCloseTo(40.05, 8);
    expect(rec.apiCalls).toBe(2);
    expect(rec.models).toEqual(["claude-fable-5", "claude-haiku-4-5"]);
    expect(rec.prompt).toBe("テスト用プロンプトです");
    expect(rec.fxRate).toBe(FIXED_FX_RATE);
    expect(rec.tokens).toEqual({
      input: 100,
      output: 200,
      cacheWrite5m: 0,
      cacheWrite1h: 10000,
      cacheRead: 50000,
    });
    expect(rec.sidechainTokens).toEqual({
      input: 1000,
      output: 500,
      cacheWrite5m: 2000,
      cacheWrite1h: 0,
      cacheRead: 0,
    });
    expect(rec.costByModel).toBeDefined();
    expect(rec.costByModel!["claude-fable-5"]).toBeCloseTo(0.261, 10);
    expect(rec.costByModel!["claude-haiku-4-5"]).toBeCloseTo(0.006, 10);

    const notify = readJson(join(sb.cccnHome, "last-notify.json"));
    expect(notify.os.title).toContain("$0.267");
    expect(notify.os.title).toContain("¥40");
    expect(notify.os.title).toContain("API換算");

    // track による report.html 自動再生成(dashboard.autoRegenerate 既定 true)。
    const reportPath = join(sb.cccnHome, "report.html");
    expect(existsSync(reportPath)).toBe(true);
    const reportHtml = readFileSync(reportPath, "utf8");
    expect(reportHtml).toContain("ccc-notifier");
    // 既定 autoReloadSec=30 の meta refresh(開くたびに最新へ近づくダッシュボード)。
    expect(reportHtml).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*content="30"/);
  });

  // ---- 2. 冪等性 ----
  it("2. track: 同一入力をもう1回渡しても history は1行のまま", async () => {
    const stdin = stdinFor(sb.transcriptPath);

    const first = await runCli(["track"], { env: sb.env, stdin });
    expect(first.code).toBe(0);
    expect(readHistory(sb.cccnHome)).toHaveLength(1);

    const second = await runCli(["track"], { env: sb.env, stdin });
    expect(second.code).toBe(0);
    expect(second.stdout).toBe("");
    expect(readHistory(sb.cccnHome)).toHaveLength(1);
  });

  // ---- 3. 追記継続 ----
  it("3. track: transcript に新しい assistant 行を追記すると、2回目は新規分のみ記録される", async () => {
    const stdin = stdinFor(sb.transcriptPath);

    await runCli(["track"], { env: sb.env, stdin });
    expect(readHistory(sb.cccnHome)).toHaveLength(1);

    const newLine = {
      parentUuid: "u3",
      isSidechain: false,
      cwd: "/tmp/proj",
      sessionId: "sess-1",
      gitBranch: "main",
      type: "assistant",
      requestId: "req_C",
      message: {
        id: "msg_C",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "追記応答" }],
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      },
      uuid: "c1",
      timestamp: "2026-07-06T10:05:00.000Z",
    };
    // fixture は改行終端。先頭にも改行を足しておくと、間に空行が挟まっても
    // (aggregateNewTurn は空行を skip するため)安全に追記継続を検証できる。
    appendFileSync(sb.transcriptPath, "\n" + JSON.stringify(newLine) + "\n", "utf8");

    const result = await runCli(["track"], { env: sb.env, stdin });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");

    const rows = readHistory(sb.cccnHome);
    expect(rows).toHaveLength(2);
    const added = rows[1];
    expect(added.costUSD).toBeCloseTo(0.05, 10); // 1000 出力トークン × $50/1e6
    expect(added.models).toEqual(["claude-fable-5"]);
    expect(added.sidechainTokens).toBeNull();
    expect(added.apiCalls).toBe(1);
  });

  // ---- 4. 不正入力で無害 ----
  it("4. track: 不正な stdin(不正JSON・空・存在しない transcript_path)でも exit 0 / stdout 空 / history 不変", async () => {
    const a = await runCli(["track"], { env: sb.env, stdin: "not json" });
    expect(a.code).toBe(0);
    expect(a.stdout).toBe("");
    expect(readHistory(sb.cccnHome)).toHaveLength(0);

    const empty = await runCli(["track"], { env: sb.env, stdin: "" });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toBe("");
    expect(readHistory(sb.cccnHome)).toHaveLength(0);

    const b = await runCli(["track"], {
      env: sb.env,
      stdin: JSON.stringify({ transcript_path: "/no/such/file.jsonl" }),
    });
    expect(b.code).toBe(0);
    expect(b.stdout).toBe("");
    expect(readHistory(sb.cccnHome)).toHaveLength(0);

    // 不正入力3種のいずれでも通知は一切発火しない。
    expect(existsSync(join(sb.cccnHome, "last-notify.json"))).toBe(false);
  });

  // ---- 5. カーソル破損耐性 ----
  it("5. track: cursors.json が壊れていても exit 0 で正常に1行記録し、二重計上しない", async () => {
    writeFileSync(join(sb.cccnHome, "cursors.json"), "broken{{{", "utf8");

    const result = await runCli(["track"], { env: sb.env, stdin: stdinFor(sb.transcriptPath) });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");

    const rows = readHistory(sb.cccnHome);
    expect(rows).toHaveLength(1);
    expect(rows[0].apiCalls).toBe(2);
    expect(rows[0].costUSD).toBeCloseTo(0.267, 10);
  });

  // ---- 6. init → doctor → uninstall 一気通貫 ----
  it("6. init --yes --os-only → doctor → uninstall --yes [--purge] の一気通貫フロー", async () => {
    const before = readJson(sb.settingsPath);

    // --- init (1回目) ---
    const init1 = await runCli(["init", "--yes", "--os-only"], { env: sb.env });
    expect(init1.code).toBe(0);

    const afterInit1 = readJson(sb.settingsPath);
    expect(Array.isArray(afterInit1.hooks.Stop)).toBe(true);
    expect(afterInit1.hooks.Stop).toHaveLength(1);
    const hookEntry = afterInit1.hooks.Stop[0].hooks[0];
    // フォルダ名(ブランド名)に依存させず、実際にビルドされた dist/cli.js のパスで検証する。
    // buildHookCommand は win32 で "\" を "/" に正規化するため、比較側も同様に正規化する
    // (CLI_PATH は join() 由来でバックスラッシュを含みうる)。
    expect(hookEntry.command).toContain(CLI_PATH.replace(/\\/g, "/"));
    expect(hookEntry.command).toContain("track");

    // 既存キーは deep-equal で不変。
    expect(afterInit1.permissions).toEqual(before.permissions);
    expect(afterInit1.model).toEqual(before.model);
    expect(afterInit1.statusLine).toEqual(before.statusLine);
    expect(afterInit1.effortLevel).toEqual(before.effortLevel);
    expect(afterInit1.unknownFutureKey).toEqual(before.unknownFutureKey);
    expect(afterInit1.hooks.PermissionRequest).toEqual(before.hooks.PermissionRequest);
    expect(afterInit1.hooks.SessionStart).toEqual(before.hooks.SessionStart);

    // バックアップ (.bak-*) が生成されている。
    expect(findBackups(sb.settingsPath).length).toBeGreaterThanOrEqual(1);

    // CCCN_HOME/config.json が生成されている。
    expect(existsSync(join(sb.cccnHome, "config.json"))).toBe(true);

    // last-notify.json にテスト通知が書かれている。
    const notifyAfterInit1 = readJson(join(sb.cccnHome, "last-notify.json"));
    expect(typeof notifyAfterInit1.os.title).toBe("string");
    expect(notifyAfterInit1.os.title).toContain("💰");

    // --- init (2回目・冪等性) ---
    const init2 = await runCli(["init", "--yes", "--os-only"], { env: sb.env });
    expect(init2.code).toBe(0);
    expect(readJson(sb.settingsPath).hooks.Stop).toHaveLength(1);

    // --- doctor ---
    const doctor = await runCli(["doctor"], { env: sb.env });
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).not.toContain("❌");
    expect(doctor.stdout).toContain("✅");

    // --- uninstall --yes ---
    const uninstall1 = await runCli(["uninstall", "--yes"], { env: sb.env });
    expect(uninstall1.code).toBe(0);

    const afterUninstall1 = readJson(sb.settingsPath);
    expect("Stop" in afterUninstall1.hooks).toBe(false); // 空になったので Stop キー自体が消える
    expect(afterUninstall1.permissions).toEqual(before.permissions);
    expect(afterUninstall1.model).toEqual(before.model);
    expect(afterUninstall1.statusLine).toEqual(before.statusLine);
    expect(afterUninstall1.effortLevel).toEqual(before.effortLevel);
    expect(afterUninstall1.unknownFutureKey).toEqual(before.unknownFutureKey);
    expect(afterUninstall1.hooks.PermissionRequest).toEqual(before.hooks.PermissionRequest);
    expect(afterUninstall1.hooks.SessionStart).toEqual(before.hooks.SessionStart);
    expect(existsSync(sb.cccnHome)).toBe(true); // --purge 無しではデータディレクトリは残る

    // --- uninstall --yes --purge ---
    const uninstall2 = await runCli(["uninstall", "--yes", "--purge"], { env: sb.env });
    expect(uninstall2.code).toBe(0);
    expect(existsSync(sb.cccnHome)).toBe(false);
  });

  // ---- 7. exit code 規約 ----
  it("7. --version は semver 風文字列で0、--help も0、unknown-cmd は1を返す", async () => {
    const version = await runCli(["--version"], { env: sb.env });
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    const help = await runCli(["--help"], { env: sb.env });
    expect(help.code).toBe(0);

    const unknown = await runCli(["unknown-cmd"], { env: sb.env });
    expect(unknown.code).toBe(1);
  });

  // ---- 8. 破損 settings 保護 ----
  it("8. settings.json が不正 JSON のとき、init --yes --os-only は exit 1 でファイルを一切変更しない", async () => {
    const broken = "{ this is not valid json ";
    writeFileSync(sb.settingsPath, broken, "utf8");

    const result = await runCli(["init", "--yes", "--os-only"], { env: sb.env });

    expect(result.code).toBe(1);
    expect(readFileSync(sb.settingsPath, "utf8")).toBe(broken); // バイト単位で不変
    expect(findBackups(sb.settingsPath)).toHaveLength(0); // バックアップも作らない
  });

  // ---- 9. report: 蓄積した履歴を --json / 表形式の両方で正しく集計する ----
  it("9. report: track で2ターン記録した後、--json --days 9999 の合計値が期待どおりで、表形式も exit 0", async () => {
    const stdin = stdinFor(sb.transcriptPath);
    await runCli(["track"], { env: sb.env, stdin });
    expect(readHistory(sb.cccnHome)).toHaveLength(1);

    const newLine = {
      parentUuid: "u3",
      isSidechain: false,
      cwd: "/tmp/proj",
      sessionId: "sess-1",
      gitBranch: "main",
      type: "assistant",
      requestId: "req_C",
      message: {
        id: "msg_C",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "追記応答" }],
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      },
      uuid: "c1",
      timestamp: "2026-07-06T10:05:00.000Z",
    };
    appendFileSync(sb.transcriptPath, "\n" + JSON.stringify(newLine) + "\n", "utf8");
    await runCli(["track"], { env: sb.env, stdin });
    expect(readHistory(sb.cccnHome)).toHaveLength(2);

    const jsonResult = await runCli(["report", "--json", "--days", "9999"], { env: sb.env });
    expect(jsonResult.code).toBe(0);
    const parsed = JSON.parse(jsonResult.stdout) as {
      total: { turns: number; costUSD: number; costJPY: number };
    };
    expect(parsed.total.turns).toBe(2);
    expect(parsed.total.costUSD).toBeCloseTo(0.267 + 0.05, 8);

    const tableResult = await runCli(["report", "--days", "9999"], { env: sb.env });
    expect(tableResult.code).toBe(0);
    expect(tableResult.stdout).toContain("合計");
  });

  // ---- 10. サブエージェント取り込み ----
  it("10. track: subagents ディレクトリを集計して history に subagents ブロックが入り、dashboard に Sonnet 行が現れる", async () => {
    // transcript の兄弟 <transcript(.jsonl除去)>/subagents/agent-x.jsonl に SA フィクスチャを配置。
    // transcriptPath = <tmp>/transcript.jsonl → SA dir = <tmp>/transcript/subagents
    const saDir = join(sb.tmp, "transcript", "subagents");
    mkdirSync(saDir, { recursive: true });
    copyFileSync(FIXTURE_SUBAGENT, join(saDir, "agent-x.jsonl"));

    const result = await runCli(["track"], { env: sb.env, stdin: stdinFor(sb.transcriptPath) });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");

    const rows = readHistory(sb.cccnHome);
    expect(rows).toHaveLength(1);
    const rec = rows[0];
    // メインは GOLDEN どおり(SA は混入しない)。
    expect(rec.costUSD).toBeCloseTo(0.267, 10);
    // SA 枠(GOLDEN: 0.033 / sonnet-5 / 1 call / 1 file)。
    expect(rec.subagents).toBeDefined();
    expect(rec.subagents!.costUSD).toBeCloseTo(0.033, 10);
    expect(rec.subagents!.costByModel["claude-sonnet-5"]).toBeCloseTo(0.033, 10);
    expect(rec.subagents!.apiCalls).toBe(1);
    expect(rec.subagents!.agentFiles).toBe(1);

    // dashboard を生成すると、SA のモデル(Sonnet 5)と「うちサブエージェント」が HTML に現れる。
    const dash = await runCli(["dashboard", "--no-open"], { env: sb.env });
    expect(dash.code).toBe(0);
    const html = readFileSync(join(sb.cccnHome, "report.html"), "utf8");
    expect(html).toContain("Sonnet 5");
    expect(html).toContain("うちサブエージェント");
  });

  // ---- 11. sweep: dry-run はサマリのみ、本実行で ingest:"sweep" の履歴が入る ----
  it('11. sweep: --dry-run prints a summary without writing, then a real run backfills ingest:"sweep" history', async () => {
    // 走査対象 = CCCN_CLAUDE_PROJECTS(projectsDir)/proj/session.jsonl(transcript-basic フィクスチャ)。
    const dry = await runCli(["sweep", "--dry-run"], { env: sb.env });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("dry-run: 書き込みは行っていません");
    expect(dry.stdout).toContain("走査:");
    // dry-run では history を書かない。
    expect(readHistory(sb.cccnHome)).toHaveLength(0);

    const real = await runCli(["sweep"], { env: sb.env });
    expect(real.code).toBe(0);
    expect(real.stdout).toContain("走査:");

    const rows = readHistory(sb.cccnHome);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.ingest === "sweep")).toBe(true);
    // transcript-basic を1ターンに復元(GOLDEN 0.267)。
    expect(rows[0].costUSD).toBeCloseTo(0.267, 10);
  });
});
