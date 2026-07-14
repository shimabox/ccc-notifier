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

// Codex CLI 対応(2026-07-10)のフィクスチャ。正解値は test/fixtures/codex/README.md 参照。
const FIXTURE_CODEX_ROLLOUT_BASIC = fileURLToPath(new URL("./fixtures/codex/rollout-basic.jsonl", import.meta.url));
const FIXTURE_CODEX_ROLLOUT_MULTITURN = fileURLToPath(
  new URL("./fixtures/codex/rollout-multiturn.jsonl", import.meta.url),
);
const FIXTURE_CODEX_STOP_PAYLOAD = fileURLToPath(new URL("./fixtures/codex/stop-payload.json", import.meta.url));

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
function runCli(args: string[], opts: { env: NodeJS.ProcessEnv; stdin?: string; cwd?: string }): Promise<RunCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env: opts.env, cwd: opts.cwd });

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
  codexHome: string; // CCCN_CODEX_HOME。既定は不在ディレクトリ(detectCodex()=false に隔離)。Codex
  // シナリオのテストはここへ sessions/ や hooks.json を自分で用意してから使う。
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

  // sweep/doctor が実 ~/.codex を読まないよう隔離(2026-07-10)。既定はディレクトリを作らない
  // (= 不在パス)ことで detectCodex() を false に倒し、既存シナリオ(Codex ブロック非表示・sweep の
  // Codex 走査スキップ)の挙動を一切変えない。Codex シナリオのテストは、このパス配下に
  // sessions/ や hooks.json を自分で用意してから使う。
  const codexHome = join(tmp, "codex-home");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CCCN_HOME: cccnHome,
    CCCN_DRY_RUN: "1",
    CCCN_CLAUDE_SETTINGS: settingsPath,
    CCCN_CLAUDE_PROJECTS: projectsDir,
    CCCN_CODEX_HOME: codexHome,
    CCCN_CLI_PATH: CLI_PATH,
  };

  return { tmp, cccnHome, transcriptPath, settingsPath, projectsDir, codexHome, env };
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

/**
 * Codex の stop-payload.json(実機捕獲を無害化した固定値)の transcript_path を実パスへ差し替えた
 * stdin 文字列を返す(track --codex 用)。プレースホルダではなく実パスが直接入っているため、
 * stdinFor と違って JSON.parse → 上書き → JSON.stringify で安全に差し替える。
 */
function codexStdinFor(rolloutPath: string): string {
  const payload = JSON.parse(readFileSync(FIXTURE_CODEX_STOP_PAYLOAD, "utf8")) as Record<string, unknown>;
  payload.transcript_path = rolloutPath;
  return JSON.stringify(payload);
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
    const doctor = await runCli(["doctor"], { env: sb.env, cwd: sb.tmp });
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

  // ---- 6b. 通知なしモード(--no-notify)一気通貫 ----
  it("6b. init --yes --no-notify → doctor がダッシュボードのみモードを ✅ で報告する", async () => {
    // --- init --no-notify ---
    const init = await runCli(["init", "--yes", "--no-notify"], { env: sb.env });
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("テスト通知: 通知なしモードのためスキップしました");
    expect(init.stdout).toContain("通知なしモードです");

    // config は通知なし、hook は登録される。
    const cfg = readJson(join(sb.cccnHome, "config.json"));
    expect(cfg.notify.os).toBe(false);
    expect(cfg.notify.slack).toBeNull();
    expect(readJson(sb.settingsPath).hooks.Stop).toHaveLength(1);

    // テスト通知はスキップされる(CCCN_DRY_RUN=1 でも last-notify.json は書かれない)。
    expect(existsSync(join(sb.cccnHome, "last-notify.json"))).toBe(false);

    // --- doctor ---
    const doctor = await runCli(["doctor"], { env: sb.env, cwd: sb.tmp });
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("ダッシュボードのみモード");
    expect(doctor.stdout).not.toContain("OS・Slack とも無効");
    expect(doctor.stdout).not.toContain("❌");

    // --- track: 通知は出ないが記録・再生成はされる ---
    const track = await runCli(["track"], { env: sb.env, stdin: stdinFor(sb.transcriptPath) });
    expect(track.code).toBe(0);
    expect(readHistory(sb.cccnHome)).toHaveLength(1);
    expect(existsSync(join(sb.cccnHome, "report.html"))).toBe(true);
    expect(existsSync(join(sb.cccnHome, "last-notify.json"))).toBe(false);
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
    expect(dash.stdout).toContain(join(sb.cccnHome, "report.html"));
    const html = readFileSync(join(sb.cccnHome, "report.html"), "utf8");
    expect(html).toContain("Sonnet 5");
    expect(html).toContain("うちサブエージェント");

    // 明示した --all だけが canonical 全履歴版と日次stateを更新する。
    const fullDash = await runCli(["dashboard", "--all", "--no-open"], { env: sb.env });
    expect(fullDash.code).toBe(0);
    expect(fullDash.stdout).toContain(join(sb.cccnHome, "report-all.html"));
    expect(readFileSync(join(sb.cccnHome, "report-all.html"), "utf8")).toContain("全履歴版 / Full history");
    expect(existsSync(join(sb.cccnHome, "cache", "dashboard-full-state.json"))).toBe(true);
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

  // ================================================================================
  // Codex CLI 対応(2026-07-10)。契約: src/contracts.md「2026-07-10 追加: Codex CLI 対応」。
  // 正解値・逐次ステップ差分方式の検算は test/fixtures/codex/README.md 参照。
  // sb.codexHome は既定で不在(隔離済み)なので、各テストが sessions/ や hooks.json を
  // 自分で用意してから使う。
  // ================================================================================

  // ---- 12. Codex: init --codex は hooks.json に3つの専用hookを登録し、次回 codex 起動時の
  //          信頼承認(Trust all and continue)を案内する。doctor はそれを検出して報告する ----
  it("12. init --yes --codex: hooks.json に3eventを登録して Trust all and continue を案内し、doctor が検出+登録済みを報告する", async () => {
    // Codex ホームはディレクトリだけ用意する(hooks.json はまだ無い = 新規作成パスを通す)。
    mkdirSync(sb.codexHome, { recursive: true });

    const init = await runCli(["init", "--yes", "--codex"], { env: sb.env });
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("Codex に Stop/SubagentStart/SubagentStop hook を登録しました");
    expect(init.stdout).toContain("Trust all and continue");

    const hooksPath = join(sb.codexHome, "hooks.json");
    expect(existsSync(hooksPath)).toBe(true);
    const hooksJson = readJson(hooksPath);
    const codexCommand: string = hooksJson.hooks.Stop[0].hooks[0].command;
    // buildHookCommand と同様、win32 は "\" を "/" に正規化するため比較側も正規化する。
    expect(codexCommand).toContain(CLI_PATH.replace(/\\/g, "/"));
    expect(codexCommand).toContain("__ccc-notifier-codex-hook Stop");
    expect(hooksJson.hooks.UserPromptSubmit[0].hooks[0].command).toContain("__ccc-notifier-codex-hook UserPromptSubmit");
    expect(hooksJson.hooks.SubagentStart[0].hooks[0].timeout).toBe(20);
    expect(hooksJson.hooks.SubagentStop[0].hooks[0].command).toContain("__ccc-notifier-codex-hook SubagentStop");

    // --- doctor: Codex ブロックが検出+登録済み+承認注意を報告する ---
    const doctor = await runCli(["doctor"], { env: sb.env, cwd: sb.tmp });
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).not.toContain("❌");
    expect(doctor.stdout).toContain("Codex Stop hook");
    expect(doctor.stdout).toContain("Codex SubagentStart hook");
    expect(doctor.stdout).toContain(`actual nodePath=${process.execPath.replace(/\\/g, "/")}`);
    expect(doctor.stdout).toContain(`actual cliPath=${CLI_PATH.replace(/\\/g, "/")}`);
    expect(doctor.stdout).toContain(`expected cliPath=${CLI_PATH.replace(/\\/g, "/")}`);
    expect(doctor.stdout).toContain("実体path=一致");
    expect(doctor.stdout).toContain("project/hook trustは静的診断では未確認");
  });

  it("12b. passive hook wire: UserPrompt/Startは0 bytes、SubagentStop/親Stopはexact {}+LF", async () => {
    const identity = { session_id: "session-a", turn_id: "turn-a", agent_id: "agent-a", agent_type: "explorer" };
    const prompt = await runCli(["__ccc-notifier-codex-hook", "UserPromptSubmit"], {
      env: sb.env,
      stdin: JSON.stringify({ ...identity, hook_event_name: "UserPromptSubmit", prompt: "private-canary" }),
    });
    expect(prompt.code).toBe(0);
    expect(Buffer.from(prompt.stdout)).toEqual(Buffer.alloc(0));
    const start = await runCli(["__ccc-notifier-codex-hook", "SubagentStart"], {
      env: sb.env,
      stdin: JSON.stringify({ ...identity, hook_event_name: "SubagentStart" }),
    });
    expect(start.code).toBe(0);
    expect(Buffer.from(start.stdout)).toEqual(Buffer.alloc(0));

    const subStop = await runCli(["__ccc-notifier-codex-hook", "SubagentStop"], {
      env: sb.env,
      stdin: JSON.stringify({ ...identity, hook_event_name: "SubagentStop", agent_transcript_path: "/not-stored" }),
    });
    expect(subStop.code).toBe(0);
    expect(Buffer.from(subStop.stdout)).toEqual(Buffer.from("{}\n"));

    const parentStop = await runCli(["__ccc-notifier-codex-hook", "Stop"], {
      env: sb.env,
      stdin: "invalid parent payload",
    });
    expect(parentStop.code).toBe(0);
    expect(Buffer.from(parentStop.stdout)).toEqual(Buffer.from("{}\n"));
  });

  it("12c. 別プロセスの並行writerがatomic台帳へunique agentを失わず保存する", async () => {
    writeFileSync(join(sb.cccnHome, "codex-subagent-key"), Buffer.alloc(32, 0x5a));
    writeFileSync(join(sb.cccnHome, "codex-subagent-activity.json"), `${JSON.stringify({ schemaVersion: 1, agents: {} })}\n`);
    const malformedLock = join(sb.cccnHome, "codex-subagent-activity.lock");
    mkdirSync(malformedLock);
    writeFileSync(join(malformedLock, "owner.json.tmp-crash"), "partial");
    const oldLock = new Date(Date.now() - 1_000);
    utimesSync(malformedLock, oldLock, oldLock);
    const root = await runCli(["__ccc-notifier-codex-hook", "UserPromptSubmit"], {
      env: sb.env,
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "session-concurrent",
        turn_id: "root-A",
        prompt: "PROMPT-CANARY",
      }),
    });
    expect(root.code).toBe(0);
    expect(root.stdout).toBe("");
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      runCli(["__ccc-notifier-codex-hook", i % 2 === 0 ? "SubagentStart" : "SubagentStop"], {
        env: sb.env,
        stdin: JSON.stringify({
          hook_event_name: i % 2 === 0 ? "SubagentStart" : "SubagentStop",
          session_id: "session-concurrent",
          turn_id: `child-${i}`,
          agent_id: `agent-${i % 5}`,
          agent_type: "worker",
        }),
      })));
    expect(results.every((result) => result.code === 0)).toBe(true);
    const ledger = readJson(join(sb.cccnHome, "codex-subagent-activity.json"));
    const agents = Object.values(ledger.roots).flatMap((value: any) => Object.keys(value.agents));
    expect(agents).toHaveLength(5);
    expect(ledger.keyCheck).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(ledger)).not.toContain("PROMPT-CANARY");
    expect(JSON.stringify(ledger)).not.toContain("session-concurrent");
    expect(JSON.stringify(ledger)).not.toContain("child-");

    const lateAgentStart = await runCli(["__ccc-notifier-codex-hook", "SubagentStart"], {
      env: sb.env,
      stdin: JSON.stringify({
        hook_event_name: "SubagentStart",
        session_id: "session-concurrent",
        turn_id: "child-X",
        agent_id: "late-agent",
        agent_type: "explorer",
      }),
    });
    expect(lateAgentStart.stdout).toBe("");
    const rollout = join(sb.tmp, "rollout-root-A.jsonl");
    copyFileSync(FIXTURE_CODEX_ROLLOUT_BASIC, rollout);
    const parentPayload = JSON.parse(readFileSync(FIXTURE_CODEX_STOP_PAYLOAD, "utf8"));
    const [parent, lateStop] = await Promise.all([
      runCli(["__ccc-notifier-codex-hook", "Stop"], {
        env: sb.env,
        stdin: JSON.stringify({
          ...parentPayload,
          hook_event_name: "Stop",
          session_id: "session-concurrent",
          turn_id: "root-A",
          transcript_path: rollout,
        }),
      }),
      runCli(["__ccc-notifier-codex-hook", "SubagentStop"], {
        env: sb.env,
        stdin: JSON.stringify({
          hook_event_name: "SubagentStop",
          session_id: "session-concurrent",
          turn_id: "child-Y",
          agent_id: "late-agent",
          agent_type: "explorer",
        }),
      }),
    ]);
    expect(parent.stdout).toBe("{}\n");
    expect(lateStop.stdout).toBe("{}\n");
    const report = await runCli(["report", "--days", "9999", "--json"], { env: sb.env });
    expect(JSON.parse(report.stdout).total.codexSubagentActivity).toMatchObject({ turns: 1 });
    await runCli(["dashboard", "--no-open"], { env: sb.env });
    const html = readFileSync(join(sb.cccnHome, "report.html"), "utf8");
    expect(html).toContain("利用あり・料金未集計");
    for (const forbidden of ["PROMPT-CANARY", "session-concurrent", "child-X", "child-Y", "late-agent"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("12d. 並行UserPromptとSubagentStartはactivity lock取得順どおり単一rootへだけ割り当てる", async () => {
    const sessionId = "session-root-race";
    const firstRoot = await runCli(["__ccc-notifier-codex-hook", "UserPromptSubmit"], {
      env: sb.env,
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        turn_id: "root-A",
        prompt: "RACE-PROMPT-A",
      }),
    });
    expect(firstRoot.code).toBe(0);

    const [nextRoot, start] = await Promise.all([
      runCli(["__ccc-notifier-codex-hook", "UserPromptSubmit"], {
        env: sb.env,
        stdin: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: sessionId,
          turn_id: "root-B",
          prompt: "RACE-PROMPT-B",
        }),
      }),
      runCli(["__ccc-notifier-codex-hook", "SubagentStart"], {
        env: sb.env,
        stdin: JSON.stringify({
          hook_event_name: "SubagentStart",
          session_id: sessionId,
          turn_id: "child-X",
          agent_id: "race-agent",
          agent_type: "worker",
        }),
      }),
    ]);
    expect(nextRoot.code).toBe(0);
    expect(start.code).toBe(0);
    expect(nextRoot.stdout).toBe("");
    expect(start.stdout).toBe("");

    const ledger = readJson(join(sb.cccnHome, "codex-subagent-activity.json"));
    const session = Object.values(ledger.sessions)[0] as any;
    const roots = Object.entries(ledger.roots) as Array<[string, any]>;
    expect(roots).toHaveLength(2);
    expect(roots.filter(([, root]) => Object.keys(root.agents).length === 1)).toHaveLength(1);
    expect(roots.filter(([, root]) => Object.keys(root.agents).length === 0)).toHaveLength(1);
    expect(ledger.agentAssignments[Object.keys(ledger.agentAssignments)[0]]).toBe(
      roots.find(([, root]) => Object.keys(root.agents).length === 1)?.[0],
    );
    expect(ledger.roots[session.activeRootKey].status).toBe("open");
    expect(JSON.stringify(ledger)).not.toContain("RACE-PROMPT");
    expect(JSON.stringify(ledger)).not.toContain(sessionId);
    expect(JSON.stringify(ledger)).not.toContain("race-agent");
  });

  // ---- 13. Codex: track --codex は rollout の累積カウンタを逐次ステップ差分で集計し、
  //          source:"codex" のレコードを記録する ----
  it('13. track --codex: rollout-basic.jsonl を集計し、GOLDEN 値どおり source:"codex" のレコードを1件記録する', async () => {
    // 実 Codex と同じディレクトリ構造(sessions/YYYY/MM/DD/rollout-*.jsonl)を sandbox 内に再現する。
    const rolloutDir = join(sb.codexHome, "sessions", "2026", "07", "10");
    mkdirSync(rolloutDir, { recursive: true });
    const rolloutPath = join(
      rolloutDir,
      "rollout-2026-07-10T12-09-25-01234567-aaaa-7000-8000-000000000001.jsonl",
    );
    copyFileSync(FIXTURE_CODEX_ROLLOUT_BASIC, rolloutPath);

    const result = await runCli(["track", "--codex"], {
      env: sb.env,
      stdin: codexStdinFor(rolloutPath),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");

    const rows = readHistory(sb.cccnHome);
    expect(rows).toHaveLength(1);
    const rec = rows[0];
    expect(rec.source).toBe("codex");
    expect(rec.sessionId).toBe("01234567-aaaa-7000-8000-000000000001");
    expect(rec.models).toEqual(["gpt-5.5"]);
    expect(rec.costUSD).toBeCloseTo(0.064106, 10);
    expect(rec.tokens).toEqual({
      input: 12280,
      output: 7,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 4992,
    });
    expect(rec.sidechainTokens).toBeNull();
    expect(rec.apiCalls).toBe(1);
    expect(rec.prompt).toBe("1+1は？"); // fixture は全角「？」(U+FF1F)
    expect(rec.project).toBe("/home/user/proj-a");
    expect(rec.gitBranch).toBeNull();

    // 通知はメインと同じ共通経路(record.costUSD がしきい値以上なら送る)。モデル表示名が
    // GPT-5.5(modelDisplayName)に変換されていることも合わせて確認する。
    const notify = readJson(join(sb.cccnHome, "last-notify.json"));
    expect(notify.os.title).toContain("GPT-5.5");
  });

  // ---- 14. Codex: sweep は rollout を task_complete 境界でターン分割して取り込む ----
  it("14. sweep (codex): --dry-run はサマリのみで書き込みなし、本実行で3ターン取り込み、再実行では増えない", async () => {
    const rolloutDir = join(sb.codexHome, "sessions", "2026", "07", "10");
    mkdirSync(rolloutDir, { recursive: true });
    const rolloutPath = join(
      rolloutDir,
      "rollout-2026-07-10T13-00-00-01234567-aaaa-7000-8000-000000000002.jsonl",
    );
    copyFileSync(FIXTURE_CODEX_ROLLOUT_MULTITURN, rolloutPath);
    // 進行中セッション保護(mtime 5分)を避けるため、Claude 側の sweepTarget と同じく完了済みを模して古くする。
    const agedRollout = new Date(Date.now() - 10 * 60_000);
    utimesSync(rolloutPath, agedRollout, agedRollout);

    const dry = await runCli(["sweep", "--dry-run"], { env: sb.env });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("dry-run: 書き込みは行っていません");
    expect(dry.stdout).toContain("Codex: 3 ターン");
    // dry-run では history を書かない。
    expect(readHistory(sb.cccnHome)).toHaveLength(0);

    const real = await runCli(["sweep"], { env: sb.env });
    expect(real.code).toBe(0);
    expect(real.stdout).toContain("Codex: 3 ターン");

    const rows = readHistory(sb.cccnHome);
    const codexRows = rows.filter((r) => r.source === "codex");
    expect(codexRows).toHaveLength(3);
    expect(codexRows.every((r) => r.ingest === "sweep")).toBe(true);
    expect(codexRows.map((r) => r.prompt).sort()).toEqual(["ターン1です", "ターン2です", "ターン3です"]);
    // GOLDEN(test/fixtures/codex/README.md): t1=0.0047 + t2=0.0123 + t3=0.0010125。
    const codexTotal = codexRows.reduce((sum, r) => sum + r.costUSD, 0);
    expect(codexTotal).toBeCloseTo(0.0180125, 8);

    // 再実行してもカーソル(codexTotals の差分方式)で去重され、Codex 分は増えない。
    const rerun = await runCli(["sweep"], { env: sb.env });
    expect(rerun.code).toBe(0);
    expect(readHistory(sb.cccnHome).filter((r) => r.source === "codex")).toHaveLength(3);
  });
});
