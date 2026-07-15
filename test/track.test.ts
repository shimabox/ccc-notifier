import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runTrack } from "../src/track";
import { runDashboard } from "../src/dashboard";
import { runHistory } from "../src/history";
import { acquireDataLock } from "../src/data-lock";
import * as store from "../src/store";
import * as dashboard from "../src/dashboard";
import * as subagents from "../src/subagents";
import type { TurnRecord } from "../src/types";

// 読み取り専用のゴールデン fixture。実行のたびに一時 dir へコピーして使う(fixture を汚さない)。
const FIXTURE_TRANSCRIPT = fileURLToPath(new URL("./fixtures/transcript-basic.jsonl", import.meta.url));
const FIXTURE_STDIN = fileURLToPath(new URL("./fixtures/stop-hook-stdin.json", import.meta.url));
const FIXTURE_SUBAGENT = fileURLToPath(new URL("./fixtures/subagent-basic.jsonl", import.meta.url));
// Codex(rollout jsonl + Stop hook stdin)。実行のたびに一時 dir へコピーして使う。
const FIXTURE_CODEX_ROLLOUT = fileURLToPath(new URL("./fixtures/codex/rollout-basic.jsonl", import.meta.url));
const FIXTURE_CODEX_PAYLOAD = fileURLToPath(new URL("./fixtures/codex/stop-payload.json", import.meta.url));

let tmpHome: string;
let transcriptPath: string;
let prevHome: string | undefined;
let prevDryRun: string | undefined;

beforeEach(() => {
  prevHome = process.env.CCCN_HOME;
  prevDryRun = process.env.CCCN_DRY_RUN;

  tmpHome = mkdtempSync(join(tmpdir(), "cccn-track-test-"));
  process.env.CCCN_HOME = tmpHome;
  process.env.CCCN_DRY_RUN = "1"; // 実通知せず last-notify.json に書き出す

  // 誤って実ネットワークに出ない保険。config/cache不在なので既定の fixed(fallbackRate=160)になる。
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

  transcriptPath = join(tmpHome, "transcript.jsonl");
  copyFileSync(FIXTURE_TRANSCRIPT, transcriptPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });

  if (prevHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = prevHome;
  if (prevDryRun === undefined) delete process.env.CCCN_DRY_RUN;
  else process.env.CCCN_DRY_RUN = prevDryRun;
});

// ---- helpers --------------------------------------------------------------

/** stop-hook-stdin.json の __TRANSCRIPT_PATH__ を実パスへ置換した stdin 文字列を返す。 */
function stdinFor(path: string): string {
  const raw = readFileSync(FIXTURE_STDIN, "utf8");
  // JSON 文字列リテラルごと置換する(Windows パスの \ を JSON.stringify で正しくエスケープ。
  // 生文字列の埋め込みは不正な JSON になり、track のフェイルセーフに黙殺される)。
  return raw.replace('"__TRANSCRIPT_PATH__"', () => JSON.stringify(path));
}

function historyFile(): string {
  return join(tmpHome, "history.jsonl");
}

function lastNotifyFile(): string {
  return join(tmpHome, "last-notify.json");
}

function readHistory(): TurnRecord[] {
  if (!existsSync(historyFile())) return [];
  return readFileSync(historyFile(), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TurnRecord);
}

function dashboardTurnCount(file: string): number {
  return dashboardData(file).turns.length;
}

function dashboardData(file: string): { turns: unknown[]; generatedAt: string } {
  const html = readFileSync(file, "utf8");
  const marker = '<script id="cccn-data" type="application/json">';
  const start = html.indexOf(marker) + marker.length;
  const end = html.indexOf("</script>", start);
  return JSON.parse(html.slice(start, end)) as { turns: unknown[]; generatedAt: string };
}

function makeHistoryTurn(ts: string, prompt: string): TurnRecord {
  return {
    schemaVersion: 1,
    ts,
    sessionId: "seed-session",
    project: "/tmp/seed-project",
    gitBranch: "main",
    models: ["claude-fable-5"],
    tokens: { input: 10, output: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    sidechainTokens: null,
    apiCalls: 1,
    costUSD: 0.01,
    costJPY: 1.5,
    fxRate: 150,
    fxSource: "fixed",
    prompt,
  };
}

function appendTranscriptTurn(prompt: string, suffix: string): void {
  const line = {
    parentUuid: `p-${suffix}`,
    isSidechain: false,
    cwd: "/tmp/proj",
    sessionId: "sess-1",
    gitBranch: "main",
    type: "assistant",
    requestId: `req-${suffix}`,
    message: {
      id: `msg-${suffix}`,
      type: "message",
      role: "assistant",
      model: "claude-fable-5",
      content: [{ type: "text", text: prompt }],
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    },
    uuid: `uuid-${suffix}`,
    timestamp: new Date().toISOString(),
  };
  appendFileSync(transcriptPath, `\n${JSON.stringify(line)}\n`, "utf8");
}

/** transcriptPath の兄弟 subagents ディレクトリに SA フィクスチャを配置し、その絶対パスを返す。 */
function subagentsDir(): string {
  // transcriptPath = <tmpHome>/transcript.jsonl → SA dir = <tmpHome>/transcript/subagents
  return join(tmpHome, "transcript", "subagents");
}
function placeSubagent(name = "agent-x.jsonl"): string {
  const dir = subagentsDir();
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  copyFileSync(FIXTURE_SUBAGENT, p);
  return p;
}

/** rollout フィクスチャを一時 dir にコピーし、その絶対パス(cursors.json のキーにもなる)を返す。 */
function placeCodexRollout(name = "rollout-basic.jsonl"): string {
  const p = join(tmpHome, name);
  copyFileSync(FIXTURE_CODEX_ROLLOUT, p);
  return p;
}

/** stop-payload.json を読み、transcript_path を実パスに差し替えた(必要なら model も上書きした)stdin を返す。 */
function codexStdinFor(rolloutPath: string, overrides?: { model?: string }): string {
  const payload = JSON.parse(readFileSync(FIXTURE_CODEX_PAYLOAD, "utf8")) as Record<string, unknown>;
  payload.transcript_path = rolloutPath;
  if (overrides?.model !== undefined) payload.model = overrides.model;
  return JSON.stringify(payload);
}

// ---- suite ----------------------------------------------------------------

describe("runTrack", () => {
  // 1. 正常系: GOLDEN 値どおりに1行記録し、通知タイトルに費用が入る。
  it("1. records one golden turn and writes a notification title with the cost", async () => {
    await runTrack(stdinFor(transcriptPath));

    const rows = readHistory();
    expect(rows).toHaveLength(1);
    const rec = rows[0];

    expect(rec.costUSD).toBeCloseTo(0.267, 10);
    expect(rec.costJPY).toBeCloseTo(42.72, 8);
    expect(rec.apiCalls).toBe(2);
    expect(rec.models).toEqual(["claude-fable-5", "claude-haiku-4-5"]);
    expect(rec.prompt).toBe("テスト用プロンプトです");
    expect(rec.fxSource).toBe("fixed");
    expect(rec.fxRate).toBe(160);
    expect(rec.sessionId).toBe("sess-1");
    expect(rec.project).toBe("/tmp/proj");
    expect(rec.gitBranch).toBe("main");
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

    const notify = JSON.parse(readFileSync(lastNotifyFile(), "utf8"));
    expect(notify.os.title).toContain("$0.267");
    expect(notify.os.title).toContain("¥43");
    expect(notify.os.title).toContain("API換算");
  });

  // 2. 冪等性: 同一入力の2回目は history も通知も増えない。
  it("2. is idempotent: a second run with the same input adds no row and no notification", async () => {
    const stdin = stdinFor(transcriptPath);

    await runTrack(stdin);
    const notifyAfterFirst = readFileSync(lastNotifyFile(), "utf8");

    await runTrack(stdin);

    expect(readHistory()).toHaveLength(1);
    // 2回目は新規ターンが無く通知が発火しないため、last-notify.json は byte 単位で不変(ts も変わらない)。
    expect(readFileSync(lastNotifyFile(), "utf8")).toBe(notifyAfterFirst);
  });

  // 3. 追記継続: 新しい assistant 行を追記した2回目は新規分のみを記録する。
  it("3. continues from the cursor and records only the newly-appended assistant row", async () => {
    const stdin = stdinFor(transcriptPath);

    await runTrack(stdin);
    expect(readHistory()).toHaveLength(1);

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
    // fixture 末尾は改行終端。先頭にも改行を足しておくと、末尾が未終端でも安全(空行はスキップされる)。
    appendFileSync(transcriptPath, "\n" + JSON.stringify(newLine) + "\n", "utf8");

    await runTrack(stdin);

    const rows = readHistory();
    expect(rows).toHaveLength(2);
    const added = rows[1];
    expect(added.costUSD).toBeCloseTo(0.05, 10); // 1000 × 50 / 1e6
    expect(added.models).toEqual(["claude-fable-5"]);
    expect(added.sidechainTokens).toBeNull();
    expect(added.apiCalls).toBe(1);
    expect(added.tokens).toEqual({
      input: 0,
      output: 1000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    });
  });

  // 4. 不正入力で無害: not json / {} / 存在しないパス でも throw せず history 不変・通知なし。
  it("4. is harmless on invalid input (not-json / {} / missing path)", async () => {
    await expect(runTrack("not json")).resolves.toBeUndefined();
    expect(readHistory()).toHaveLength(0);

    await expect(runTrack("{}")).resolves.toBeUndefined();
    expect(readHistory()).toHaveLength(0);

    const missing = stdinFor(join(tmpHome, "does-not-exist.jsonl"));
    await expect(runTrack(missing)).resolves.toBeUndefined();
    expect(readHistory()).toHaveLength(0);

    expect(existsSync(lastNotifyFile())).toBe(false);
  });

  // 5a. 壊れた cursors.json(不正 JSON): throw せず正常に1行記録。
  it("5a. survives a corrupt (invalid-JSON) cursors.json and still records one row", async () => {
    writeFileSync(join(tmpHome, "cursors.json"), "not valid json {{{", "utf8");

    await expect(runTrack(stdinFor(transcriptPath))).resolves.toBeUndefined();
    expect(readHistory()).toHaveLength(1);
  });

  // 5b. カーソル形状破壊: サニタイズで null に落ち、throw せず二重計上なし(1行のまま)。
  it("5b. drops a shape-corrupt cursor via sanitization without double-counting", async () => {
    const broken = { [transcriptPath]: { offset: "abc", seenMessageKeys: 42 } };
    writeFileSync(join(tmpHome, "cursors.json"), JSON.stringify(broken), "utf8");

    await expect(runTrack(stdinFor(transcriptPath))).resolves.toBeUndefined();
    expect(readHistory()).toHaveLength(1);
  });

  // 6. しきい値: minNotifyUSD=1 なら history には記録するが last-notify.json は作られない。
  it("6. records but does not notify when the cost is below minNotifyUSD", async () => {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ minNotifyUSD: 1 }), "utf8");

    await runTrack(stdinFor(transcriptPath));

    expect(readHistory()).toHaveLength(1);
    expect(existsSync(lastNotifyFile())).toBe(false);
  });

  // 7. 順序の検証: appendTurn の後に saveCursor が呼ばれる(通り抜けスパイで呼び出し順を観察)。
  it("7. calls appendTurn before saveCursor", async () => {
    const appendSpy = vi.spyOn(store, "appendTurn");
    const saveSpy = vi.spyOn(store, "saveCursor");

    await runTrack(stdinFor(transcriptPath));

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.invocationCallOrder[0]).toBeLessThan(saveSpy.mock.invocationCallOrder[0]);

    // 通り抜けスパイなので副作用も本物: 実際に1行記録されている。
    expect(readHistory()).toHaveLength(1);
  });

  // 8. 自動再生成(既定): track 成功後に report.html が生成され、meta refresh を含む。
  it("8. regenerates CCCN_HOME/report.html (with meta refresh) after a successful track by default", async () => {
    await runTrack(stdinFor(transcriptPath));

    expect(readHistory()).toHaveLength(1);
    const report = join(tmpHome, "report.html");
    expect(existsSync(report)).toBe(true);
    const html = readFileSync(report, "utf8");
    expect(html).toContain("ccc-notifier");
    // 既定 autoReloadSec=30 の meta refresh が入っている(開きっぱなしのタブが最新化される)。
    expect(html).toMatch(/<meta[^>]*http-equiv="refresh"[^>]*content="30"/);
    expect(existsSync(join(tmpHome, "report-all.html"))).toBe(true);
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(true);
    expect(html).toContain('href="report-all.html"');
    expect(readFileSync(join(tmpHome, "report-all.html"), "utf8")).toContain('href="report.html"');
  });

  it("8a2. regenerates recent every new turn but full only once on the same local day", async () => {
    const stdin = stdinFor(transcriptPath);
    await runTrack(stdin);
    const fullBefore = readFileSync(join(tmpHome, "report-all.html"), "utf8");
    appendTranscriptTurn("same-day-new", "same-day");
    await runTrack(stdin);
    expect(dashboardTurnCount(join(tmpHome, "report.html"))).toBe(2);
    expect(readFileSync(join(tmpHome, "report-all.html"), "utf8")).toBe(fullBefore);
  });

  it("8a3. regenerates full after local-day rollover", async () => {
    const stdin = stdinFor(transcriptPath);
    await runTrack(stdin);
    const stateFile = join(tmpHome, "cache", "dashboard-full-state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    state.localDate = "2000-01-01";
    writeFileSync(stateFile, JSON.stringify(state), "utf8");
    appendTranscriptTurn("next-day-new", "next-day");
    await runTrack(stdin);
    expect(dashboardTurnCount(join(tmpHome, "report-all.html"))).toBe(2);
  });

  it("8a4. regenerates full when timezone changes", async () => {
    const stdin = stdinFor(transcriptPath);
    await runTrack(stdin);
    const stateFile = join(tmpHome, "cache", "dashboard-full-state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    state.timeZone = "Invalid/Old-Time-Zone";
    writeFileSync(stateFile, JSON.stringify(state), "utf8");
    appendTranscriptTurn("timezone-new", "timezone");
    await runTrack(stdin);
    expect(dashboardTurnCount(join(tmpHome, "report-all.html"))).toBe(2);
    const updated = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    expect(updated.timeZone).not.toBe("Invalid/Old-Time-Zone");
  });

  it("8a5. retries full on the next new turn after full generation failure", async () => {
    const real = dashboard.writeDashboardHtml;
    let failFull = true;
    vi.spyOn(dashboard, "writeDashboardHtml").mockImplementation((opts) => {
      if (opts.outPath.endsWith("report-all.html") && failFull) throw new Error("full failed");
      return real(opts);
    });
    const stdin = stdinFor(transcriptPath);
    await runTrack(stdin);
    expect(existsSync(join(tmpHome, "report.html"))).toBe(true);
    expect(existsSync(join(tmpHome, "report-all.html"))).toBe(true);
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(false);
    const recent = readFileSync(join(tmpHome, "report.html"), "utf8");
    expect(recent).toContain('href="report-all.html"');
    expect(readFileSync(join(tmpHome, "report-all.html"), "utf8")).toContain("全履歴版はまだ生成されていません");
    failFull = false;
    appendTranscriptTurn("retry-full", "retry");
    await runTrack(stdin);
    expect(dashboardTurnCount(join(tmpHome, "report-all.html"))).toBe(2);
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(true);
  });

  it("8a6. still generates full when recent generation fails", async () => {
    const real = dashboard.writeDashboardHtml;
    vi.spyOn(dashboard, "writeDashboardHtml").mockImplementation((opts) => {
      if (opts.outPath.endsWith("report.html")) throw new Error("recent failed");
      return real(opts);
    });
    await runTrack(stdinFor(transcriptPath));
    expect(existsSync(join(tmpHome, "report.html"))).toBe(true);
    expect(readFileSync(join(tmpHome, "report.html"), "utf8")).toContain("直近版はまだ生成されていません");
    expect(existsSync(join(tmpHome, "report-all.html"))).toBe(true);
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(true);
  });

  it("8a7. shares one history read between initial recent/full generation", async () => {
    const spy = vi.spyOn(store, "readTurns");
    await runTrack(stdinFor(transcriptPath));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("8a8. an active first-turn lock prevents duplicate full generation", async () => {
    const lock = acquireDataLock();
    expect(lock).not.toBeNull();
    await runTrack(stdinFor(transcriptPath));
    expect(readHistory()).toEqual([]);
    expect(existsSync(join(tmpHome, "cursors.json"))).toBe(false);
    expect(readFileSync(join(tmpHome, "error.log"), "utf8")).toContain("[track:data-lock]");
    expect(existsSync(join(tmpHome, "report.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "report-all.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(false);
    expect(existsSync(join(tmpHome, "cache", "data.lock"))).toBe(true);
    lock!.release();
  });

  it("8a9. concurrent history clear and track never revive a deleted prompt in canonical HTML", async () => {
    store.appendTurn(makeHistoryTurn(new Date().toISOString(), "privacy-secret-to-delete"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await Promise.all([runTrack(stdinFor(transcriptPath)), runHistory(["clear", "--yes"])]);
    for (const file of [join(tmpHome, "report.html"), join(tmpHome, "report-all.html")]) {
      if (existsSync(file)) expect(readFileSync(file, "utf8")).not.toContain("privacy-secret-to-delete");
    }
    expect(existsSync(join(tmpHome, "cache", "data.lock"))).toBe(false);
  });

  it("8a10. concurrent manual full and track leave an internally valid full snapshot/state", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await Promise.all([runTrack(stdinFor(transcriptPath)), runDashboard(["--no-open", "--all"])]);
    const full = join(tmpHome, "report-all.html");
    const stateFile = join(tmpHome, "cache", "dashboard-full-state.json");
    expect(existsSync(full)).toBe(true);
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { localDate: string; generatedAt: string };
    expect(Number.isFinite(Date.parse(state.generatedAt))).toBe(true);
    expect(state.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dashboardData(full).generatedAt.startsWith(state.localDate)).toBe(true);
    expect(dashboardTurnCount(full)).toBeLessThanOrEqual(readHistory().length);
    expect(existsSync(join(tmpHome, "cache", "data.lock"))).toBe(false);
  });

  it("8b. limits automatic report regeneration to the default 30 days", async () => {
    store.appendTurn(makeHistoryTurn(new Date(Date.now() - 40 * 86_400_000).toISOString(), "auto-old-turn"));
    store.appendTurn(makeHistoryTurn(new Date(Date.now() - 20 * 86_400_000).toISOString(), "auto-recent-turn"));

    await runTrack(stdinFor(transcriptPath));

    const html = readFileSync(join(tmpHome, "report.html"), "utf8");
    expect(html).not.toContain("auto-old-turn");
    expect(html).toContain("auto-recent-turn");
  });

  it("8c. uses dashboard.days for automatic report regeneration", async () => {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ dashboard: { days: 2 } }), "utf8");
    store.appendTurn(makeHistoryTurn(new Date(Date.now() - 3 * 86_400_000).toISOString(), "configured-old-turn"));
    store.appendTurn(makeHistoryTurn(new Date(Date.now() - 1 * 86_400_000).toISOString(), "configured-recent-turn"));

    await runTrack(stdinFor(transcriptPath));

    const html = readFileSync(join(tmpHome, "report.html"), "utf8");
    expect(html).not.toContain("configured-old-turn");
    expect(html).toContain("configured-recent-turn");
  });

  it.each([0, -1, 1.5, "7", null])(
    "8d. falls back to 30 days when dashboard.days is invalid (%j)",
    async (days) => {
      writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ dashboard: { days } }), "utf8");
      const spy = vi.spyOn(dashboard, "writeDashboardHtml").mockImplementation(() => {});

      await runTrack(stdinFor(transcriptPath));

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ days: 30 }));
    },
  );

  // 9. autoRegenerate=false なら report.html は生成されない(history は記録される)。
  it("9. does not regenerate report.html when dashboard.autoRegenerate is false", async () => {
    writeFileSync(
      join(tmpHome, "config.json"),
      JSON.stringify({ dashboard: { autoRegenerate: false } }),
      "utf8",
    );

    await runTrack(stdinFor(transcriptPath));

    expect(readHistory()).toHaveLength(1);
    expect(existsSync(join(tmpHome, "report.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "report-all.html"))).toBe(false);
    expect(existsSync(join(tmpHome, "cache", "dashboard-full-state.json"))).toBe(false);
    expect(existsSync(join(tmpHome, "cache", "data.lock"))).toBe(false);
  });

  it("9b. leaves existing dashboard HTML/state/lock untouched when autoRegenerate is false", async () => {
    writeFileSync(
      join(tmpHome, "config.json"),
      JSON.stringify({ notify: { os: false, slack: null }, dashboard: { autoRegenerate: false } }),
      "utf8",
    );
    mkdirSync(join(tmpHome, "cache"), { recursive: true });
    const files = [
      join(tmpHome, "report.html"),
      join(tmpHome, "report-all.html"),
      join(tmpHome, "cache", "dashboard-full-state.json"),
    ];
    files.forEach((file, i) => writeFileSync(file, `sentinel-${i}`, "utf8"));
    await runTrack(stdinFor(transcriptPath));
    files.forEach((file, i) => expect(readFileSync(file, "utf8")).toBe(`sentinel-${i}`));
  });

  // 10. 通知しきい値未満で通知がスキップされても、再生成は独立に実行される。
  it("10. still regenerates report.html even when the notification is skipped by minNotifyUSD", async () => {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ minNotifyUSD: 1 }), "utf8");

    await runTrack(stdinFor(transcriptPath));

    expect(readHistory()).toHaveLength(1);
    // 通知はスキップされる。
    expect(existsSync(lastNotifyFile())).toBe(false);
    // が、再生成は実行される(通知しきい値とは独立)。
    expect(existsSync(join(tmpHome, "report.html"))).toBe(true);
  });

  // 11. 再生成が throw しても runTrack は正常終了し、history は記録される(フェイルセーフ)。
  it("11. survives a failing report regeneration and still records the turn", async () => {
    const spy = vi.spyOn(dashboard, "writeDashboardHtml").mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(runTrack(stdinFor(transcriptPath))).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledTimes(2);
    // 再生成が失敗しても履歴は記録される。
    expect(readHistory()).toHaveLength(1);
    // mock が throw したため report.html は書かれない。
    expect(existsSync(join(tmpHome, "report.html"))).toBe(false);
    // フェイルセーフ: error.log に track:dashboard が残る。
    const errLog = join(tmpHome, "error.log");
    expect(existsSync(errLog)).toBe(true);
    expect(readFileSync(errLog, "utf8")).toContain("[track:dashboard-recent]");
    expect(readFileSync(errLog, "utf8")).toContain("[track:dashboard-full]");
  });

  // 12. 通知なしモード(notify.os=false, slack=null): 記録・再生成は行うが通知は一切出ない。
  //     todayTotalUSD の履歴走査もスキップされる(通知タスクを組み立てないため)。
  it("12. records and regenerates but never notifies in dashboard-only mode (notify.os=false, slack=null)", async () => {
    writeFileSync(
      join(tmpHome, "config.json"),
      JSON.stringify({ notify: { os: false, slack: null } }),
      "utf8",
    );
    const todaySpy = vi.spyOn(store, "todayTotalUSD");

    await runTrack(stdinFor(transcriptPath));

    expect(readHistory()).toHaveLength(1);
    expect(existsSync(join(tmpHome, "report.html"))).toBe(true);
    expect(existsSync(lastNotifyFile())).toBe(false);
    expect(todaySpy).not.toHaveBeenCalled();
  });
});

// ============ サブエージェント usage の取り込み ============
// transcript の兄弟 <transcript(.jsonl除去)>/subagents/agent-*.jsonl を増分集計し、
// record.subagents(GOLDEN: costUSD 0.033 / claude-sonnet-5 / apiCalls 1 / agentFiles 1)に記録する。

describe("runTrack — subagents", () => {
  // 1. SA を集計して record.subagents に GOLDEN 値どおり記録する(メインは不変)。
  it("1. collects subagent usage into record.subagents (GOLDEN 0.033 / sonnet-5 / 1 call / 1 file)", async () => {
    placeSubagent();

    await runTrack(stdinFor(transcriptPath));

    const rows = readHistory();
    expect(rows).toHaveLength(1);
    const rec = rows[0];

    // メインは従来どおり(SA は costUSD に混入しない)。
    expect(rec.costUSD).toBeCloseTo(0.267, 10);

    expect(rec.subagents).toBeDefined();
    expect(rec.subagents!.costUSD).toBeCloseTo(0.033, 10);
    expect(rec.subagents!.costByModel["claude-sonnet-5"]).toBeCloseTo(0.033, 10);
    expect(rec.subagents!.apiCalls).toBe(1);
    expect(rec.subagents!.agentFiles).toBe(1);
    expect(rec.subagents!.tokens).toEqual({
      input: 1000,
      output: 2000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    });
  });

  // 2. 冪等性: 新規メターンが無ければ SA も再計上されない(record 追加自体なし)。
  it("2. does not re-count subagents on a second run with no new main turn", async () => {
    placeSubagent();
    const stdin = stdinFor(transcriptPath);

    await runTrack(stdin);
    expect(readHistory()).toHaveLength(1);

    await runTrack(stdin);
    // メインに新規行が無いので新規ターン自体が発生せず、SA も再計上されない。
    expect(readHistory()).toHaveLength(1);
  });

  // 3. SA ファイルに新規行を追記 → 次ターンで SA 差分のみが計上される。
  it("3. records only the newly-appended subagent delta on the next turn", async () => {
    const saPath = placeSubagent();
    const stdin = stdinFor(transcriptPath);

    await runTrack(stdin);
    expect(readHistory()).toHaveLength(1);

    // 新しいメイン行(新規ターンのトリガ)。
    const newMain = {
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
    appendFileSync(transcriptPath, "\n" + JSON.stringify(newMain) + "\n", "utf8");

    // 新しい SA 行(別 message.id / requestId)。sonnet-5 output 1000 → 0.015 USD。
    const newSa = {
      parentUuid: "sa2",
      isSidechain: true,
      cwd: "/tmp/proj",
      sessionId: "sess-1",
      gitBranch: "main",
      type: "assistant",
      requestId: "req_SA2",
      message: {
        id: "msg_SA2",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "追加のサブエージェント応答" }],
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      },
      uuid: "sa3",
      timestamp: "2026-07-06T10:05:10.000Z",
    };
    appendFileSync(saPath, JSON.stringify(newSa) + "\n", "utf8");

    await runTrack(stdin);

    const rows = readHistory();
    expect(rows).toHaveLength(2);
    const added = rows[1];
    // メインは追記行のみ(0.05)。
    expect(added.costUSD).toBeCloseTo(0.05, 10);
    // SA は差分のみ: 1000 output × $15/1e6 = 0.015。
    expect(added.subagents).toBeDefined();
    expect(added.subagents!.costUSD).toBeCloseTo(0.015, 10);
    expect(added.subagents!.apiCalls).toBe(1);
    expect(added.subagents!.agentFiles).toBe(1);
  });

  it("3b. does not charge an API call copied from the parent transcript into an agent file", async () => {
    const dir = subagentsDir();
    mkdirSync(dir, { recursive: true });
    const duplicatePath = join(dir, "agent-parent-copy.jsonl");
    const duplicateRows = readFileSync(transcriptPath, "utf8")
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          const row = JSON.parse(line) as { message?: { id?: string } };
          return row.message?.id === "msg_A";
        } catch {
          return false;
        }
      });
    writeFileSync(duplicatePath, `${duplicateRows.join("\n")}\n`, "utf8");

    await runTrack(stdinFor(transcriptPath));

    expect(readHistory()).toHaveLength(1);
    expect(readHistory()[0].subagents).toBeUndefined();
    const cursors = JSON.parse(readFileSync(join(tmpHome, "cursors.json"), "utf8")) as Record<string, unknown>;
    expect(cursors[duplicatePath]).toBeDefined();
  });

  it("3c. de-duplicates the same API call copied into two agent files", async () => {
    placeSubagent("agent-a.jsonl");
    placeSubagent("agent-b.jsonl");

    await runTrack(stdinFor(transcriptPath));

    const sa = readHistory()[0].subagents!;
    expect(sa.costUSD).toBeCloseTo(0.033, 10);
    expect(sa.apiCalls).toBe(1);
    expect(sa.agentFiles).toBe(1);
  });

  it("3d. records an agent-only late completion even when the parent has no new usage", async () => {
    const stdin = stdinFor(transcriptPath);
    await runTrack(stdin);
    rmSync(lastNotifyFile(), { force: true });
    const saPath = placeSubagent();

    await runTrack(stdin);

    const rows = readHistory();
    expect(rows).toHaveLength(2);
    expect(rows[1].costUSD).toBe(0);
    expect(rows[1].apiCalls).toBe(0);
    expect(rows[1].subagents?.costUSD).toBeCloseTo(0.033, 10);
    expect(rows[1].subagents?.apiCalls).toBe(1);
    expect(existsSync(lastNotifyFile())).toBe(false);
    const cursors = JSON.parse(readFileSync(join(tmpHome, "cursors.json"), "utf8")) as Record<string, unknown>;
    expect(cursors[saPath]).toBeDefined();
  });

  // 4. subagents ディレクトリが無ければ record.subagents は undefined。
  it("4. leaves record.subagents undefined when there is no subagents directory", async () => {
    await runTrack(stdinFor(transcriptPath));

    const rows = readHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0].subagents).toBeUndefined();
  });

  // 5. collectSubagentUsage が throw してもメイン記録は成功する(フェイルセーフ)。
  it("5. still records the main turn when collectSubagentUsage throws", async () => {
    placeSubagent();
    vi.spyOn(subagents, "collectSubagentUsage").mockRejectedValue(new Error("boom"));

    await expect(runTrack(stdinFor(transcriptPath))).resolves.toBeUndefined();

    const rows = readHistory();
    expect(rows).toHaveLength(1);
    // SA は付かないがメインは記録される。
    expect(rows[0].costUSD).toBeCloseTo(0.267, 10);
    expect(rows[0].subagents).toBeUndefined();
    // フェイルセーフ: error.log に track:subagents が残る。
    const errLog = join(tmpHome, "error.log");
    expect(existsSync(errLog)).toBe(true);
    expect(readFileSync(errLog, "utf8")).toContain("[track:subagents]");
  });

  // 6a. 通知はメイン基準: minNotifyUSD=0.1 で メイン0.267 が閾値超えのため通知は出る。
  //     ただし通知金額は SA を含まないメインのみ($0.267)であることを検証する。
  it("6a. notifies on the main cost (title shows main-only $, SA excluded from the amount)", async () => {
    placeSubagent();
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ minNotifyUSD: 0.1 }), "utf8");

    await runTrack(stdinFor(transcriptPath));

    expect(readHistory()[0].subagents!.costUSD).toBeCloseTo(0.033, 10);
    // 通知は発火する(メイン 0.267 >= 0.1)。
    expect(existsSync(lastNotifyFile())).toBe(true);
    const notify = JSON.parse(readFileSync(lastNotifyFile(), "utf8"));
    // 通知金額はメインのみ($0.267)。総額 $0.300 は通知に現れない。
    expect(notify.os.title).toContain("$0.267");
    expect(notify.os.title).not.toContain("$0.300");
  });

  // 6b. 通知はメイン基準: メイン(0.267)< 閾値(0.28)なら、総額(0.300)が閾値超でも通知は出ない。
  it("6b. does not notify when the main cost is below the threshold even if main+SA exceeds it", async () => {
    placeSubagent();
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ minNotifyUSD: 0.28 }), "utf8");

    await runTrack(stdinFor(transcriptPath));

    // 記録はされ、SA も付く。
    const rows = readHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0].subagents!.costUSD).toBeCloseTo(0.033, 10);
    // が、通知はメイン(0.267 < 0.28)基準でスキップされる(総額 0.300 > 0.28 でも出ない)。
    expect(existsSync(lastNotifyFile())).toBe(false);
  });
});

// ============ Codex 経路(track --codex)============
// rollout jsonl を aggregateCodexTurn で集計し、source: 'codex' で記録する。SA は収集しない。
// 価格・fx・通知・再生成は Claude 経路と同じ共通コードを通す。GOLDEN は fixtures/codex/README.md。

describe("runTrack — codex", () => {
  // 1. 正常系: GOLDEN 値どおりに1行記録する(source/model/コスト/プロンプト、SA なし)。
  it("1. records one golden codex turn (source, model, cost, prompt) with no subagents", async () => {
    const rollout = placeCodexRollout();

    await runTrack(codexStdinFor(rollout), { codex: true });

    const rows = readHistory();
    expect(rows).toHaveLength(1);
    const rec = rows[0];

    expect(rec.source).toBe("codex");
    expect(rec.models).toEqual(["gpt-5.5"]);
    // builtin gpt-5.5(input $5/M, output $30/M, cacheRead $0.5/M)・fx は既定フォールバック(fixed 160)。
    expect(rec.costUSD).toBeCloseTo(0.064106, 6);
    expect(rec.prompt).toBe("1+1は？");
    expect(rec.subagents).toBeUndefined();
    expect(rec.gitBranch).toBeNull();
    expect(rec.project).toBe("/home/user/proj-a");
    expect(rec.apiCalls).toBe(1);
    expect(rec.fxSource).toBe("fixed");
    expect(rec.fxRate).toBe(160);
    expect(rec.tokens).toEqual({
      input: 12280,
      output: 7,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 4992,
    });
  });

  // 2. カーソル: rollout パスに codexTotals(最後に観測した total_token_usage)が保存される。
  it("2. saves the rollout cursor with codexTotals", async () => {
    const rollout = placeCodexRollout();

    await runTrack(codexStdinFor(rollout), { codex: true });

    const cursors = JSON.parse(readFileSync(join(tmpHome, "cursors.json"), "utf8"));
    expect(cursors[rollout]).toBeDefined();
    expect(cursors[rollout].codexTotals).toEqual({ input: 17272, cached: 4992, output: 7 });
  });

  // 3. 冪等性: 同一入力の2回目は新規 usage が無く、history も通知も増えない。
  it("3. is idempotent: a second run with no new usage adds no row and no notification", async () => {
    const rollout = placeCodexRollout();
    const stdin = codexStdinFor(rollout);

    await runTrack(stdin, { codex: true });
    expect(readHistory()).toHaveLength(1);
    const notifyAfterFirst = readFileSync(lastNotifyFile(), "utf8");

    await runTrack(stdin, { codex: true });

    expect(readHistory()).toHaveLength(1);
    // 2回目は新規ターンが無く通知が発火しないため、last-notify.json は byte 単位で不変。
    expect(readFileSync(lastNotifyFile(), "utf8")).toBe(notifyAfterFirst);
  });

  // 4. モデル優先: payload.model が rollout の turn_context.model と異なるとき payload を採用する。
  it("4. prefers the hook payload model over the rollout turn_context model", async () => {
    const rollout = placeCodexRollout();

    await runTrack(codexStdinFor(rollout, { model: "gpt-5.5-codex" }), { codex: true });

    const rows = readHistory();
    expect(rows).toHaveLength(1);
    // rollout 由来は "gpt-5.5" だが、payload の "gpt-5.5-codex" が優先される。
    expect(rows[0].models).toEqual(["gpt-5.5-codex"]);
    expect(rows[0].source).toBe("codex");
  });

  // 5. 通知経路: CCCN_DRY_RUN で last-notify.json に通知ペイロードが書かれる(共通の通知経路が動く)。
  it("5. writes a notification payload to last-notify.json (CCCN_DRY_RUN)", async () => {
    const rollout = placeCodexRollout();

    await runTrack(codexStdinFor(rollout), { codex: true });

    expect(existsSync(lastNotifyFile())).toBe(true);
    const notify = JSON.parse(readFileSync(lastNotifyFile(), "utf8"));
    expect(notify.os).toBeDefined();
    expect(typeof notify.os.title).toBe("string");
    expect(notify.os.title).toContain("$");
  });

  // 6. 互換性: opts を省略した既存 Claude 経路は無変更(source なし・GOLDEN どおり)。
  it("6. leaves the existing Claude path unchanged when opts is omitted", async () => {
    await runTrack(stdinFor(transcriptPath));

    const rows = readHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBeUndefined();
    expect(rows[0].costUSD).toBeCloseTo(0.267, 10);
    expect(rows[0].models).toEqual(["claude-fable-5", "claude-haiku-4-5"]);
  });
});
