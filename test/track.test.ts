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
import * as store from "../src/store";
import * as dashboard from "../src/dashboard";
import * as subagents from "../src/subagents";
import type { TurnRecord } from "../src/types";

// 読み取り専用のゴールデン fixture。実行のたびに一時 dir へコピーして使う(fixture を汚さない)。
const FIXTURE_TRANSCRIPT = fileURLToPath(new URL("./fixtures/transcript-basic.jsonl", import.meta.url));
const FIXTURE_STDIN = fileURLToPath(new URL("./fixtures/stop-hook-stdin.json", import.meta.url));
const FIXTURE_SUBAGENT = fileURLToPath(new URL("./fixtures/subagent-basic.jsonl", import.meta.url));

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

  // 誤って実ネットワークに出ない保険。fx はフォールバックで fixed(fallbackRate=150)になる。
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

// ---- suite ----------------------------------------------------------------

describe("runTrack", () => {
  // 1. 正常系: GOLDEN 値どおりに1行記録し、通知タイトルに費用が入る。
  it("1. records one golden turn and writes a notification title with the cost", async () => {
    await runTrack(stdinFor(transcriptPath));

    const rows = readHistory();
    expect(rows).toHaveLength(1);
    const rec = rows[0];

    expect(rec.costUSD).toBeCloseTo(0.267, 10);
    expect(rec.costJPY).toBeCloseTo(40.05, 8);
    expect(rec.apiCalls).toBe(2);
    expect(rec.models).toEqual(["claude-fable-5", "claude-haiku-4-5"]);
    expect(rec.prompt).toBe("テスト用プロンプトです");
    expect(rec.fxSource).toBe("fixed");
    expect(rec.fxRate).toBe(150);
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
    expect(notify.os.title).toContain("¥40");
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
  });

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

    expect(spy).toHaveBeenCalledTimes(1);
    // 再生成が失敗しても履歴は記録される。
    expect(readHistory()).toHaveLength(1);
    // mock が throw したため report.html は書かれない。
    expect(existsSync(join(tmpHome, "report.html"))).toBe(false);
    // フェイルセーフ: error.log に track:dashboard が残る。
    const errLog = join(tmpHome, "error.log");
    expect(existsSync(errLog)).toBe(true);
    expect(readFileSync(errLog, "utf8")).toContain("[track:dashboard]");
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
