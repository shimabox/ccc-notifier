// test/ingest.test.ts — hook 非依存の増分取り込み(src/ingest.ts)の単体/結合テスト。
//
// 一時 CCCN_HOME + 一時 CCCN_CLAUDE_PROJECTS(cli) + CCCN_CLAUDE_DESKTOP_ROOTS(desktop) +
// 一時 CCCN_CODEX_HOME に隔離して検証する。実データ(~/.claude 等)には一切触れない。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  chmodSync,
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

import { notifyIngestSummary, runIngest } from "../src/ingest";
import { runResetCursors } from "../src/reset-cursors";
import { runSweep } from "../src/sweep";
import { runTrack } from "../src/track";
import { callFingerprint } from "../src/counted-calls";
import {
  hasPendingAppend,
  loadCursor,
  markPendingAppend,
  pendingAppendPath,
  readConfig,
  sanitizeCursor,
  writeMuteState,
} from "../src/store";
import type { Config, TurnRecord } from "../src/types";

const FIXTURE_TRANSCRIPT = fileURLToPath(new URL("./fixtures/transcript-basic.jsonl", import.meta.url));
const FIXTURE_DESKTOP_TRANSCRIPT = fileURLToPath(
  new URL("./fixtures/desktop/transcript-desktop-basic.jsonl", import.meta.url),
);
const FIXTURE_CODEX_ROLLOUT = fileURLToPath(new URL("./fixtures/codex/rollout-basic.jsonl", import.meta.url));
const FIXTURE_CODEX_DESKTOP_ROLLOUT = fileURLToPath(new URL("./fixtures/codex/rollout-desktop.jsonl", import.meta.url));
const FIXTURE_STDIN = fileURLToPath(new URL("./fixtures/stop-hook-stdin.json", import.meta.url));
const FIXTURE_SUBAGENT = fileURLToPath(new URL("./fixtures/subagent-basic.jsonl", import.meta.url));
const FIXTURE_CODEX_STOP_PAYLOAD = fileURLToPath(new URL("./fixtures/codex/stop-payload.json", import.meta.url));

let tmpHome: string;
let cliProjects: string;
let desktopRoot: string;
let codexHomeDir: string;
let prevHome: string | undefined;
let prevProjects: string | undefined;
let prevDesktopRoots: string | undefined;
let prevCodexHome: string | undefined;
let prevDryRun: string | undefined;

beforeEach(() => {
  prevHome = process.env.CCCN_HOME;
  prevProjects = process.env.CCCN_CLAUDE_PROJECTS;
  prevDesktopRoots = process.env.CCCN_CLAUDE_DESKTOP_ROOTS;
  prevCodexHome = process.env.CCCN_CODEX_HOME;
  prevDryRun = process.env.CCCN_DRY_RUN;

  tmpHome = mkdtempSync(join(tmpdir(), "cccn-ingest-test-"));
  cliProjects = join(tmpHome, "claude-projects");
  desktopRoot = join(tmpHome, "claude-desktop", "sandbox", ".claude", "projects");
  codexHomeDir = join(tmpHome, "codex-home");

  mkdirSync(join(cliProjects, "proj-cli"), { recursive: true });
  mkdirSync(join(desktopRoot, "proj-desktop"), { recursive: true });
  mkdirSync(join(codexHomeDir, "sessions", "2026", "08", "01"), { recursive: true });

  copyFileSync(FIXTURE_TRANSCRIPT, join(cliProjects, "proj-cli", "session.jsonl"));
  copyFileSync(FIXTURE_DESKTOP_TRANSCRIPT, join(desktopRoot, "proj-desktop", "session.jsonl"));
  copyFileSync(FIXTURE_CODEX_ROLLOUT, join(codexHomeDir, "sessions", "2026", "08", "01", "rollout-cli.jsonl"));
  copyFileSync(
    FIXTURE_CODEX_DESKTOP_ROLLOUT,
    join(codexHomeDir, "sessions", "2026", "08", "01", "rollout-desktop.jsonl"),
  );

  process.env.CCCN_HOME = tmpHome;
  process.env.CCCN_CLAUDE_PROJECTS = cliProjects;
  process.env.CCCN_CLAUDE_DESKTOP_ROOTS = desktopRoot;
  process.env.CCCN_CODEX_HOME = codexHomeDir;
  process.env.CCCN_DRY_RUN = "1";

  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });

  if (prevHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = prevHome;
  if (prevProjects === undefined) delete process.env.CCCN_CLAUDE_PROJECTS;
  else process.env.CCCN_CLAUDE_PROJECTS = prevProjects;
  if (prevDesktopRoots === undefined) delete process.env.CCCN_CLAUDE_DESKTOP_ROOTS;
  else process.env.CCCN_CLAUDE_DESKTOP_ROOTS = prevDesktopRoots;
  if (prevCodexHome === undefined) delete process.env.CCCN_CODEX_HOME;
  else process.env.CCCN_CODEX_HOME = prevCodexHome;
  if (prevDryRun === undefined) delete process.env.CCCN_DRY_RUN;
  else process.env.CCCN_DRY_RUN = prevDryRun;
});

/**
 * cursors.json から1ファイル分のエントリだけを消す(cursors.json のリセット・sweep・
 * transcript のパス変更・別マシンからの移行で起きる「history にはあるがカーソルが無い」状態)。
 * mtime キャッシュはそのまま残す — カーソルの無いファイルは mtime が動いていなくても
 * 走査対象になる、という前提ごと検証するため。
 */
function dropCursorEntry(transcriptPath: string): void {
  const file = join(tmpHome, "cursors.json");
  const dict = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  expect(Object.hasOwn(dict, transcriptPath)).toBe(true);
  delete dict[transcriptPath];
  writeFileSync(file, JSON.stringify(dict), "utf8");
  expect(existsSync(join(tmpHome, "cache", "ingest-mtimes.json"))).toBe(true);
}

/** 実ユーザープロンプト行 + assistant 行 = Claude transcript のターン1つ分。 */
function claudeTurnLines(
  sessionId: string,
  prompt: string,
  requestId: string,
  messageId: string,
  ts: string,
): string {
  const base = { isSidechain: false, cwd: "/tmp/proj", sessionId, gitBranch: "main" };
  return (
    JSON.stringify({ ...base, type: "user", message: { role: "user", content: prompt }, uuid: `u-${requestId}`, timestamp: ts }) +
    "\n" +
    JSON.stringify({
      ...base,
      type: "assistant",
      requestId,
      message: {
        id: messageId,
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "応答" }],
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 },
      },
      uuid: `a-${requestId}`,
      timestamp: ts,
    }) +
    "\n"
  );
}

function codexTokenCountLine(ts: string, input: number, cached: number, output: number): string {
  return JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
        last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
      },
    },
  });
}

/** rollout に「1ターン分」(user_message → token_count(累積) → task_complete)を足す行群。 */
function codexTurnLines(tsPrefix: string, input: number, cached: number, output: number, turnId: string): string {
  return (
    [
      `{"timestamp":"${tsPrefix}:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"次の質問"}}`,
      codexTokenCountLine(`${tsPrefix}:05.000Z`, input, cached, output),
      `{"timestamp":"${tsPrefix}:06.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"${turnId}"}}`,
    ].join("\n") + "\n"
  );
}

/** transcript fixture を、指定セッション・固有の messageId/requestId に読み替えて返す。 */
function transcriptFixture(sessionId: string, tag: string): string {
  return readFileSync(FIXTURE_TRANSCRIPT, "utf8")
    .replaceAll('"sessionId":"sess-1"', `"sessionId":"${sessionId}"`)
    .replaceAll('"msg_', `"msg_${tag}_`)
    .replaceAll('"req_', `"req_${tag}_`);
}

/** サブエージェント fixture を、指定セッション・指定時刻に読み替えて返す。 */
function subagentFixture(sessionId: string, ts1: string, ts2: string): string {
  return readFileSync(FIXTURE_SUBAGENT, "utf8")
    .replaceAll('"sessionId":"sess-1"', `"sessionId":"${sessionId}"`)
    .replaceAll('"msg_', `"msg_${sessionId}_`)
    .replaceAll('"req_', `"req_${sessionId}_`)
    .replaceAll("2026-07-06T10:00:20.000Z", `2026-07-06T${ts1}.000Z`)
    .replaceAll("2026-07-06T10:00:21.000Z", `2026-07-06T${ts2}.000Z`);
}

function readHistory(): TurnRecord[] {
  const file = join(tmpHome, "history.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TurnRecord);
}

describe("runIngest", () => {
  it("1. dry-run はプレビューのみで history / cursors を一切変更しない", async () => {
    const result = await runIngest({ dryRun: true, offlinePricing: true });

    expect(result.dryRun).toBe(true);
    expect(result.records.length).toBeGreaterThanOrEqual(3); // cli + desktop(claude) + codex(cli) + codex(desktop)
    expect(existsSync(join(tmpHome, "history.jsonl"))).toBe(false);
    expect(existsSync(join(tmpHome, "cursors.json"))).toBe(false);
  });

  it("2. 実行すると cli/desktop(Claude)・cli/desktop(Codex)を取り込み、surface/originator を記録する", async () => {
    const result = await runIngest({ dryRun: false, offlinePricing: true });

    expect(result.lockAcquired).toBe(true);
    expect(result.failures).toBe(0);

    const rows = readHistory();
    const cliClaude = rows.find((r) => r.sessionId === "sess-1");
    const desktopClaude = rows.find((r) => r.sessionId === "desktop-sess-1");
    const cliCodex = rows.find((r) => r.source === "codex" && r.sessionId === "01234567-aaaa-7000-8000-000000000001");
    const desktopCodex = rows.find(
      (r) => r.source === "codex" && r.sessionId === "01234567-cccc-7000-8000-000000000099",
    );

    expect(cliClaude?.surface).toBe("cli");
    expect(cliClaude?.ingest).toBe("scan");
    expect(desktopClaude?.surface).toBe("desktop");
    expect(desktopClaude?.costUSD).toBeCloseTo(0.02925, 10);

    expect(cliCodex?.surface).toBe("cli");
    expect(cliCodex?.originator).toBe("codex-tui");
    expect(desktopCodex?.surface).toBe("desktop");
    expect(desktopCodex?.originator).toBe("Codex Desktop");
    expect(desktopCodex?.costUSD).toBeCloseTo(0.0348, 10);

    // カーソルが保存され、増分に使われる(冪等性は次のテストで検証)。
    const cursor = sanitizeCursor(loadCursor(join(desktopRoot, "proj-desktop", "session.jsonl")));
    expect(cursor).not.toBeNull();
  });

  it("3. 2回目の実行では新規に何も取り込まない(mtime プリフィルタ + カーソルで冪等)", async () => {
    await runIngest({ dryRun: false, offlinePricing: true });
    const firstCount = readHistory().length;

    const second = await runIngest({ dryRun: false, offlinePricing: true });
    expect(second.records).toHaveLength(0);
    expect(second.scannedFiles).toBe(0); // mtime 変化なしで全ファイルがプリフィルタでスキップされる
    expect(readHistory()).toHaveLength(firstCount);
  });

  it("4. Codex child rollout(session_meta.payload.source.subagent)は取り込まずカーソルだけ進める", async () => {
    const childPath = join(codexHomeDir, "sessions", "2026", "08", "01", "rollout-child.jsonl");
    const raw = readFileSync(FIXTURE_CODEX_ROLLOUT, "utf8").replace(
      '"source":"cli"',
      '"source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent-1","depth":1}}}',
    );
    writeFileSync(childPath, raw, "utf8");

    const result = await runIngest({ dryRun: false, offlinePricing: true });
    const rows = readHistory();
    expect(rows.some((r) => r.sessionId === "01234567-aaaa-7000-8000-000000000001" && r.project === undefined)).toBe(
      false,
    );
    // child rollout 自体からは history レコードが作られない。
    const childRecords = rows.filter((r) => r.source === "codex" && r.project === "/home/user/proj-a");
    expect(childRecords).toHaveLength(1); // root(rollout-cli.jsonl)分のみ
    expect(result.failures).toBe(0);
    // カーソルは進んでいる(次回以降スキャン対象にならない)。
    expect(sanitizeCursor(loadCursor(childPath))).not.toBeNull();
  });

  it("5. --dry-run と実行時で totalUSD 等の集計が一致する(同一入力に対して)", async () => {
    const dry = await runIngest({ dryRun: true, offlinePricing: true });
    const real = await runIngest({ dryRun: false, offlinePricing: true });
    expect(real.totalUSD).toBeCloseTo(dry.totalUSD, 10);
    expect(real.records.length).toBe(dry.records.length);
  });

  // track と ingest は同じ cursors.json を真実源として共有する。track が cursor を書いた
  // 「後」に ingest が同じルートを走査しても、新規レコードは0件でなければならない。
  it("6. track が既にカーソルを保存済みの transcript を ingest が走査しても新規0件(二重計上しない)", async () => {
    // 1. track が(cli ルート内の)transcript を通常どおり最初から最後まで処理し、
    //    history 1行 + cursors.json にオフセット/lastTs/seenMessageKeys 込みの正しいカーソルを残す。
    const trackedPath = join(cliProjects, "proj-cli", "already-tracked-by-hook.jsonl");
    copyFileSync(FIXTURE_TRANSCRIPT, trackedPath);
    const stdinRaw = readFileSync(FIXTURE_STDIN, "utf8");
    const stdin = stdinRaw.replace('"__TRANSCRIPT_PATH__"', () => JSON.stringify(trackedPath));
    await runTrack(stdin);

    const afterTrack = readHistory();
    const trackedRecord = afterTrack.find((r) => r.sessionId === "sess-1");
    expect(trackedRecord).toBeDefined();
    expect(trackedRecord!.apiCalls).toBe(2); // GOLDEN(transcript-basic.jsonl): 2

    const cursorAfterTrack = sanitizeCursor(loadCursor(trackedPath));
    expect(cursorAfterTrack).not.toBeNull();
    expect(cursorAfterTrack!.seenMessageKeys.length).toBeGreaterThan(0);

    const historyCountAfterTrack = afterTrack.length;

    // 2. 同じルートに対して ingest(track とは無関係の、hook 非依存の増分取り込み)を走らせる。
    //    track が既に処理し切ったこのファイルからは、新規レコードが1件も生まれてはならない。
    const result = await runIngest({ dryRun: false, offlinePricing: true });
    const ingestedThisFile = result.records.filter((r) => r.sessionId === "sess-1");
    expect(ingestedThisFile).toHaveLength(0);

    const afterIngest = readHistory();
    expect(afterIngest).toHaveLength(historyCountAfterTrack); // 増えていない
    // 全レコードを通じて apiCalls が異常値(GOLDEN の 2 を大きく超える値)になっていないこと。
    for (const rec of afterIngest) {
      if (rec.sessionId === "sess-1") expect(rec.apiCalls).toBe(2);
    }
  });

  // カーソルの有無は「取り込み済みか」の証拠にならない。cursors.json のリセット・sweep・
  // パス変更・別マシンからの移行では「history には記録済みだがカーソルだけ無い」状態になる。
  // その状態の集計はファイル全体を読むため、history 側の ts と突合しない限り記録済みのターンが
  // そのまま重複レコードになる。テスト6はカーソルを残したままなのでこの経路を通らない。
  it("7. history に記録済みで cursors にエントリが無い Claude transcript を丸ごと再取り込みしない", async () => {
    const lostPath = join(cliProjects, "proj-cli", "cursor-lost.jsonl");
    writeFileSync(
      lostPath,
      transcriptFixture("sess-lost", "lost"),
      "utf8",
    );

    // 1. 通常どおり取り込む(history 1行 + cursors エントリ)。
    await runIngest({ dryRun: false, offlinePricing: true });
    const recorded = readHistory().filter((r) => r.sessionId === "sess-lost");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].apiCalls).toBe(2); // GOLDEN(transcript-basic.jsonl): 2
    const historyCount = readHistory().length;

    // 2. カーソルだけを失わせる(history はそのまま)。
    dropCursorEntry(lostPath);

    // 3. 再走査しても、記録済みのターンは1件も再 append されない。
    const second = await runIngest({ dryRun: false, offlinePricing: true });
    expect(second.records.filter((r) => r.sessionId === "sess-lost")).toHaveLength(0);
    expect(readHistory()).toHaveLength(historyCount);
    expect(readHistory().filter((r) => r.sessionId === "sess-lost")).toHaveLength(1);
    // カーソルは張り直され、次回以降は通常の増分読みに戻る。
    expect(sanitizeCursor(loadCursor(lostPath))).not.toBeNull();

    // 4. 未記録の末尾(記録済み ts より後の assistant 行)だけは取りこぼさずに取り込む。
    appendFileSync(
      lostPath,
      JSON.stringify({
        parentUuid: "u3",
        isSidechain: false,
        cwd: "/tmp/proj",
        sessionId: "sess-lost",
        gitBranch: "main",
        type: "assistant",
        requestId: "req_NEW",
        message: {
          id: "msg_NEW",
          role: "assistant",
          model: "claude-fable-5",
          content: [{ type: "text", text: "新しい応答" }],
          usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 },
        },
        uuid: "aNEW",
        timestamp: "2026-07-06T11:00:00.000Z",
      }) + "\n",
      "utf8",
    );
    dropCursorEntry(lostPath);

    const third = await runIngest({ dryRun: false, offlinePricing: true });
    const fresh = third.records.filter((r) => r.sessionId === "sess-lost");
    expect(fresh).toHaveLength(1);
    expect(fresh[0].apiCalls).toBe(1); // 追記した1件だけ(ファイル全体の 3 ではない)
  });

  it("8. history に記録済みで cursors にエントリが無い Codex rollout を丸ごと再取り込みしない", async () => {
    const rolloutPath = join(codexHomeDir, "sessions", "2026", "08", "01", "rollout-cli.jsonl");
    const sessionId = "01234567-aaaa-7000-8000-000000000001";

    await runIngest({ dryRun: false, offlinePricing: true });
    const recorded = readHistory().filter((r) => r.source === "codex" && r.sessionId === sessionId);
    expect(recorded).toHaveLength(1);
    const historyCount = readHistory().length;

    dropCursorEntry(rolloutPath);

    const second = await runIngest({ dryRun: false, offlinePricing: true });
    expect(second.records.filter((r) => r.sessionId === sessionId)).toHaveLength(0);
    expect(readHistory()).toHaveLength(historyCount);
    expect(sanitizeCursor(loadCursor(rolloutPath))).not.toBeNull();

    // 記録済みより後に始まった新ターンだけは取り込む(累積カウンタの差分= 2728/1008/13)。
    appendFileSync(
      rolloutPath,
      [
        '{"timestamp":"2026-07-10T12:20:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"2+2は？"}}',
        '{"timestamp":"2026-07-10T12:20:05.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":20000,"cached_input_tokens":6000,"output_tokens":20,"total_tokens":26020},"last_token_usage":{"input_tokens":2728,"cached_input_tokens":1008,"output_tokens":13,"total_tokens":3741},"model_context_window":258400}}}',
        '{"timestamp":"2026-07-10T12:20:06.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"01234567-bbbb-7000-8000-000000000002","last_agent_message":"4です。"}}',
        "",
      ].join("\n"),
      "utf8",
    );
    dropCursorEntry(rolloutPath);

    const third = await runIngest({ dryRun: false, offlinePricing: true });
    const fresh = third.records.filter((r) => r.sessionId === sessionId);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].tokens.cacheRead).toBe(1008); // 新ターン分の差分のみ(累積 6000 ではない)
    expect(fresh[0].tokens.output).toBe(13);
  });

  // history.jsonl は「1ターン1行」。カーソルが無いファイルもセッション全体を1レコードに
  // 丸めず、ターン境界(Claude: 実ユーザープロンプト行 / Codex: task_complete)で分ける。
  it("9. カーソル不在の Claude transcript を1レコードに丸めず、ターンごとに分けて記録する", async () => {
    const multiPath = join(cliProjects, "proj-cli", "multi-turn.jsonl");
    writeFileSync(
      multiPath,
      transcriptFixture("sess-multi", "multi") +
        claudeTurnLines("sess-multi", "2つめの質問", "req_T2", "msg_T2", "2026-07-06T12:00:00.000Z") +
        claudeTurnLines("sess-multi", "3つめの質問", "req_T3", "msg_T3", "2026-07-06T13:00:00.000Z"),
      "utf8",
    );

    const result = await runIngest({ dryRun: false, offlinePricing: true });
    const recs = result.records
      .filter((r) => r.sessionId === "sess-multi")
      .sort((a, b) => a.ts.localeCompare(b.ts));
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.apiCalls)).toEqual([2, 1, 1]);
    expect(recs.map((r) => r.prompt)).toEqual(["テスト用プロンプトです", "2つめの質問", "3つめの質問"]);
    expect(recs.map((r) => r.ts)).toEqual([
      "2026-07-06T10:00:12.000Z",
      "2026-07-06T12:00:00.000Z",
      "2026-07-06T13:00:00.000Z",
    ]);
    // 分割しても合計は変わらない。
    const total = recs.reduce((sum, r) => sum + r.costUSD, 0);
    expect(total).toBeGreaterThan(0);
    expect(readHistory().filter((r) => r.sessionId === "sess-multi")).toHaveLength(3);
  });

  it("10. カーソル不在の Codex rollout もターン(task_complete)ごとに分けて記録する", async () => {
    const rolloutPath = join(codexHomeDir, "sessions", "2026", "08", "01", "rollout-cli.jsonl");
    appendFileSync(rolloutPath, codexTurnLines("2026-07-10T12:20", 20000, 6000, 20, "turn-2"), "utf8");
    appendFileSync(rolloutPath, codexTurnLines("2026-07-10T12:30", 30000, 9000, 40, "turn-3"), "utf8");

    const result = await runIngest({ dryRun: false, offlinePricing: true });
    const recs = result.records
      .filter((r) => r.source === "codex" && r.sessionId === "01234567-aaaa-7000-8000-000000000001")
      .sort((a, b) => a.ts.localeCompare(b.ts));
    expect(recs).toHaveLength(3);
    // 各ターンは累積カウンタの差分。合計は最終累積(input 30000 のうち cached 9000 を除いた分)と一致する。
    expect(recs.map((r) => r.tokens.output)).toEqual([7, 13, 20]);
    expect(recs.reduce((sum, r) => sum + r.tokens.cacheRead, 0)).toBe(9000);
    expect(recs.reduce((sum, r) => sum + r.tokens.input, 0)).toBe(30000 - 9000);
  });

  // 記録済み ts がターンの途中にある(scan が進行中ターンを先に記録した)場合、
  // 残りが取り込まれないまま カーソルだけ EOF へ進むと欠落が恒久化する。
  it("11. 記録済み ts がターン途中にある Codex rollout でも、残りの差分だけを取り込む", async () => {
    const rolloutPath = join(codexHomeDir, "sessions", "2026", "08", "01", "rollout-partial.jsonl");
    const sessionId = "01234567-dddd-7000-8000-000000000011";
    writeFileSync(
      rolloutPath,
      [
        `{"timestamp":"2026-07-11T09:00:00.000Z","type":"session_meta","payload":{"session_id":"${sessionId}","cwd":"/home/user/p","originator":"codex-tui","source":"cli"}}`,
        '{"timestamp":"2026-07-11T09:00:01.000Z","type":"turn_context","payload":{"model":"gpt-5.5","cwd":"/home/user/p"}}',
        '{"timestamp":"2026-07-11T09:00:02.000Z","type":"event_msg","payload":{"type":"user_message","message":"1つめ"}}',
        codexTokenCountLine("2026-07-11T09:00:03.000Z", 1000, 0, 10),
        '{"timestamp":"2026-07-11T09:00:04.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}',
        '{"timestamp":"2026-07-11T09:10:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"2つめ"}}',
        codexTokenCountLine("2026-07-11T09:10:05.000Z", 3000, 0, 30), // ここまでを scan が記録済み
        codexTokenCountLine("2026-07-11T09:10:10.000Z", 5000, 0, 50), // 未記録の残り
        '{"timestamp":"2026-07-11T09:10:12.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t2"}}',
        "",
      ].join("\n"),
      "utf8",
    );
    // 進行中ターンの前半までが history にある状態(ts は 09:10:05)。cursors.json は無い。
    writeFileSync(
      join(tmpHome, "history.jsonl"),
      JSON.stringify({
        schemaVersion: 1,
        ts: "2026-07-11T09:10:05.000Z",
        sessionId,
        project: "/home/user/p",
        gitBranch: null,
        models: ["gpt-5.5"],
        tokens: { input: 3000, output: 30, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
        sidechainTokens: null,
        apiCalls: 2,
        costUSD: 0,
        costJPY: 0,
        fxRate: 160,
        fxSource: "fixed",
        prompt: "",
        ingest: "scan",
        source: "codex",
      }) + "\n",
      "utf8",
    );

    const result = await runIngest({ dryRun: false, offlinePricing: true });
    const recs = result.records.filter((r) => r.sessionId === sessionId);
    expect(recs).toHaveLength(1); // 1つめのターンは記録済み ts より前なので取り込まない
    expect(recs[0].tokens.input).toBe(2000); // 5000 - 3000(記録済み分を差し引いた残りだけ)
    expect(recs[0].tokens.output).toBe(20); // 50 - 30
  });

  // mtime キャッシュは高速化専用。失敗したファイルまで「処理済み」にすると、
  // 次に mtime が動くまで取りこぼしが持ち越されないまま消える。
  it("12. 取り込みに失敗したファイルは mtime キャッシュに載せず、次回もう一度走査する", async () => {
    // history.jsonl をディレクトリにして appendTurn(appendFileSync)を必ず失敗させる。
    mkdirSync(join(tmpHome, "history.jsonl"), { recursive: true });
    const failed = await runIngest({ dryRun: false, offlinePricing: true });
    expect(failed.failures).toBeGreaterThan(0);
    expect(failed.records).toHaveLength(0);

    rmSync(join(tmpHome, "history.jsonl"), { recursive: true, force: true });
    const retried = await runIngest({ dryRun: false, offlinePricing: true });
    expect(retried.skippedByMtime).toBe(0); // 前回失敗分は mtime プリフィルタで飛ばさない
    expect(retried.records.length).toBeGreaterThan(0);
    expect(retried.failures).toBe(0);
  });

  // mtime キャッシュはカーソルのあるファイルにしか効かせない。sweep が history / cursors を
  // 消した後は、transcript の mtime が動いていなくても再取り込みの対象になる。
  it("13. cursors.json を失ったファイルは mtime が変わっていなくても走査対象になる", async () => {
    await runIngest({ dryRun: false, offlinePricing: true });
    const cached = await runIngest({ dryRun: false, offlinePricing: true });
    expect(cached.scannedFiles).toBe(0); // カーソルがある間は mtime プリフィルタが効く

    // sweep 相当のリセット(history / cursors だけを消し、mtime キャッシュは残す)。
    rmSync(join(tmpHome, "history.jsonl"), { force: true });
    rmSync(join(tmpHome, "cursors.json"), { force: true });
    expect(existsSync(join(tmpHome, "cache", "ingest-mtimes.json"))).toBe(true);

    const rebuilt = await runIngest({ dryRun: false, offlinePricing: true });
    expect(rebuilt.scannedFiles).toBeGreaterThan(0);
    expect(rebuilt.records.length).toBeGreaterThan(0);
  });

  // サブエージェント(<transcript>/subagents/agent-*.jsonl)は親ターンへ合算する。
  // hook 経路(track)と同じ回収をしないと、取り込み経路によって同じセッションの金額が変わる。
  it("14. scan 由来のレコードにもサブエージェント分が合算される(二重計上しない)", async () => {
    const parentPath = join(cliProjects, "proj-cli", "with-subagents.jsonl");
    writeFileSync(
      parentPath,
      transcriptFixture("sess-sa", "sa"),
      "utf8",
    );
    const agentDir = join(cliProjects, "proj-cli", "with-subagents", "subagents");
    mkdirSync(agentDir, { recursive: true });
    // 親の最終ターン(10:00:12)より前に完了した agent = その親ターンへ合算される。
    writeFileSync(join(agentDir, "agent-aaa.jsonl"), subagentFixture("sess-sa", "10:00:09", "10:00:10"), "utf8");

    const first = await runIngest({ dryRun: false, offlinePricing: true });
    const withSa = first.records.filter((r) => r.sessionId === "sess-sa" && r.subagents !== undefined);
    expect(withSa).toHaveLength(1);
    expect(withSa[0].subagents!.apiCalls).toBeGreaterThan(0);
    expect(withSa[0].subagents!.agentFiles).toBe(1);
    expect(withSa[0].subagents!.costUSD).toBeGreaterThan(0);
    // メインの costUSD には SA 分を足さない(通知額を変えない既存仕様)。
    expect(withSa[0].costUSD).toBeGreaterThan(0);

    // 2回目は SA 側にも新規が無く、二重計上されない。
    const second = await runIngest({ dryRun: false, offlinePricing: true });
    expect(second.records.filter((r) => r.sessionId === "sess-sa")).toHaveLength(0);
    const saRows = readHistory().filter((r) => r.sessionId === "sess-sa" && r.subagents !== undefined);
    expect(saRows).toHaveLength(1);
  });

  // 受け入れ基準: カーソルをどう壊しても結果が変わらないこと。
  // 「計上済みか」の真実源を history 側(countedCalls / ingestKey)に置いたので、
  // 親カーソル・agent カーソル・cursors.json 全体のいずれを失っても再計上されない。
  describe("カーソル破壊耐性", () => {
    interface Setup {
      parentPath: string;
      agentPath: string;
    }

    async function seed(): Promise<Setup> {
      const parentPath = join(cliProjects, "proj-cli", "resilient.jsonl");
      writeFileSync(parentPath, transcriptFixture("sess-resilient", "res"), "utf8");
      const agentDir = join(cliProjects, "proj-cli", "resilient", "subagents");
      mkdirSync(agentDir, { recursive: true });
      const agentPath = join(agentDir, "agent-res.jsonl");
      writeFileSync(agentPath, subagentFixture("sess-resilient", "10:00:09", "10:00:10"), "utf8");
      await runIngest({ dryRun: false, offlinePricing: true });
      return { parentPath, agentPath };
    }

    /** history 全体で「同一 sessionId+ts」「同一 ingestKey」が重複していないこと。 */
    function expectNoDuplicates(): void {
      const rows = readHistory();
      const byTs = new Map<string, number>();
      const byKey = new Map<string, number>();
      for (const rec of rows) {
        const tsKey = `${rec.sessionId} ${rec.ts} ${rec.source ?? "claude"}`;
        byTs.set(tsKey, (byTs.get(tsKey) ?? 0) + 1);
        if (rec.ingestKey) byKey.set(rec.ingestKey, (byKey.get(rec.ingestKey) ?? 0) + 1);
      }
      expect([...byTs.entries()].filter(([, n]) => n > 1)).toEqual([]);
      expect([...byKey.entries()].filter(([, n]) => n > 1)).toEqual([]);
    }

    function totals(): { main: number; sa: number; rows: number } {
      const rows = readHistory();
      return {
        rows: rows.length,
        main: rows.reduce((sum, r) => sum + r.costUSD, 0),
        sa: rows.reduce((sum, r) => sum + (r.subagents?.costUSD ?? 0), 0),
      };
    }

    it("16a. ケース1: カーソル無改変では2回目に何も取り込まない", async () => {
      await seed();
      const before = totals();
      const again = await runIngest({ dryRun: false, offlinePricing: true });
      expect(again.records).toHaveLength(0);
      expect(totals()).toEqual(before);
      expectNoDuplicates();
    });

    it("16b. ケース2: 親 transcript のカーソルを1件削除しても再計上しない", async () => {
      const { parentPath } = await seed();
      const before = totals();
      dropCursorEntry(parentPath);
      const again = await runIngest({ dryRun: false, offlinePricing: true });
      expect(again.records.filter((r) => r.sessionId === "sess-resilient")).toHaveLength(0);
      expect(totals()).toEqual(before);
      expectNoDuplicates();
    });

    it("16c. ケース3: cursors.json を {} に全損させても再計上しない", async () => {
      await seed();
      const before = totals();
      writeFileSync(join(tmpHome, "cursors.json"), "{}", "utf8");
      const again = await runIngest({ dryRun: false, offlinePricing: true });
      expect(again.records).toHaveLength(0);
      expect(totals()).toEqual(before);
      expectNoDuplicates();
    });

    it("16d. ケース4: agent-*.jsonl のカーソルだけを削除しても SA を再計上しない", async () => {
      const { agentPath } = await seed();
      const before = totals();
      expect(before.sa).toBeGreaterThan(0);
      dropCursorEntry(agentPath);
      const again = await runIngest({ dryRun: false, offlinePricing: true });
      expect(again.records).toHaveLength(0);
      expect(totals()).toEqual(before);
      expectNoDuplicates();
    });

    it("16e. カーソルを全損させても、未記録の新しいターンは取りこぼさない", async () => {
      const { parentPath } = await seed();
      const before = totals();
      appendFileSync(
        parentPath,
        claudeTurnLines("sess-resilient", "追加の質問", "req_res_NEW", "msg_res_NEW", "2026-07-06T14:00:00.000Z"),
        "utf8",
      );
      writeFileSync(join(tmpHome, "cursors.json"), "{}", "utf8");

      const again = await runIngest({ dryRun: false, offlinePricing: true });
      const fresh = again.records.filter((r) => r.sessionId === "sess-resilient");
      expect(fresh).toHaveLength(1);
      expect(fresh[0].apiCalls).toBe(1);
      expect(totals().rows).toBe(before.rows + 1);
      expectNoDuplicates();
    });

    it("16f. 壊れたカーソルは「カーソルあり」と扱わず、mtime プリフィルタで恒久スキップしない", async () => {
      const { parentPath } = await seed();
      const dict = JSON.parse(readFileSync(join(tmpHome, "cursors.json"), "utf8")) as Record<string, unknown>;
      dict[parentPath] = { offset: "壊れた値", seenMessageKeys: null };
      writeFileSync(join(tmpHome, "cursors.json"), JSON.stringify(dict), "utf8");

      const again = await runIngest({ dryRun: false, offlinePricing: true });
      expect(again.scannedFiles).toBeGreaterThan(0); // 壊れたカーソルのファイルは走査対象に戻る
      expect(again.records).toHaveLength(0); // 走査はするが再計上はしない
      expect(sanitizeCursor(loadCursor(parentPath))).not.toBeNull(); // カーソルは張り直される
      expectNoDuplicates();
    });
  });

  // Codex の指紋は token_count イベント単位(rollout 内のバイトオフセット + 累積カウンタ)なので、
  // 集計窓の広さやターン境界の取り方が変わっても一致する。
  describe("Codex のカーソル破壊耐性", () => {
    /** 3ターン分の rollout(session_meta → turn_context → user → token_count → task_complete × 3)。 */
    function multiTurnRollout(sessionId: string): string {
      const lines = [
        `{"timestamp":"2026-07-12T09:00:00.000Z","type":"session_meta","payload":{"session_id":"${sessionId}","cwd":"/home/user/p","originator":"codex-tui","source":"cli"}}`,
        '{"timestamp":"2026-07-12T09:00:01.000Z","type":"turn_context","payload":{"model":"gpt-5.5","cwd":"/home/user/p"}}',
      ];
      const totals = [
        [1000, 200, 10],
        [2500, 500, 25],
        [4000, 900, 40],
      ];
      totals.forEach(([input, cached, output], i) => {
        const mm = String(10 + i * 10).padStart(2, "0");
        lines.push(
          `{"timestamp":"2026-07-12T09:${mm}:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"質問${i + 1}"}}`,
          `{"timestamp":"2026-07-12T09:${mm}:05.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":${input},"cached_input_tokens":${cached},"output_tokens":${output}}}}}`,
          `{"timestamp":"2026-07-12T09:${mm}:06.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t${i + 1}"}}`,
        );
      });
      return lines.join("\n") + "\n";
    }

    const rolloutDir = () => join(codexHomeDir, "sessions", "2026", "08", "01");

    it("18. track が複数ターンをまとめて記録した後にカーソルを失っても、再分割で二重計上しない", async () => {
      const sessionId = "01234567-eeee-7000-8000-000000000018";
      const rolloutPath = join(rolloutDir(), "rollout-multiturn-track.jsonl");
      writeFileSync(rolloutPath, multiTurnRollout(sessionId), "utf8");

      // track は Stop 時点のカーソル位置から EOF までを「1ターン」としてまとめて記録する。
      const payload = JSON.parse(readFileSync(FIXTURE_CODEX_STOP_PAYLOAD, "utf8")) as Record<string, unknown>;
      payload.transcript_path = rolloutPath;
      payload.session_id = sessionId;
      await runTrack(JSON.stringify(payload), { codex: true });

      const tracked = readHistory().filter((r) => r.sessionId === sessionId);
      expect(tracked).toHaveLength(1); // 3ターンぶんが1レコードにまとまっている
      expect(tracked[0].countedCalls).toHaveLength(3); // 指標は token_count イベント単位
      const trackedTotal = tracked[0].tokens.input + tracked[0].tokens.cacheRead + tracked[0].tokens.output;
      const historyCount = readHistory().length;

      // カーソルを失った状態で ingest が task_complete ごとに再分割しても、再計上されない。
      writeFileSync(join(tmpHome, "cursors.json"), "{}", "utf8");
      const again = await runIngest({ dryRun: false, offlinePricing: true });
      expect(again.records.filter((r) => r.sessionId === sessionId)).toHaveLength(0);
      expect(readHistory().filter((r) => r.sessionId === sessionId)).toHaveLength(1);
      expect(readHistory()).toHaveLength(historyCount);
      expect(trackedTotal).toBe(4000 + 40); // 累積カウンタの最終値(cached は input の内数)
    });

    it("19. sweep で再構築した Codex レコードにも指紋が載り、カーソルを失っても再計上しない", async () => {
      const sessionId = "01234567-ffff-7000-8000-000000000019";
      const rolloutPath = join(rolloutDir(), "rollout-multiturn-sweep.jsonl");
      writeFileSync(rolloutPath, multiTurnRollout(sessionId), "utf8");

      await runSweep([]); // history / cursors を捨てて先頭から再構築する
      const rebuilt = readHistory().filter((r) => r.sessionId === sessionId);
      expect(rebuilt).toHaveLength(3); // task_complete ごとに1レコード
      for (const rec of rebuilt) {
        expect(rec.ingest).toBe("sweep");
        expect(rec.countedCalls).toHaveLength(1);
        expect(rec.ingestKey).toBeTruthy();
      }
      const historyCount = readHistory().length;

      writeFileSync(join(tmpHome, "cursors.json"), "{}", "utf8");
      const again = await runIngest({ dryRun: false, offlinePricing: true });
      expect(again.records.filter((r) => r.sessionId === sessionId)).toHaveLength(0);
      expect(readHistory()).toHaveLength(historyCount);
    });

    it("20. 部分取り込み後にカーソルを失っても、未計上のイベントだけを取り込む", async () => {
      const sessionId = "01234567-aaab-7000-8000-000000000020";
      const rolloutPath = join(rolloutDir(), "rollout-partial-resume.jsonl");
      const full = multiTurnRollout(sessionId).split("\n").filter(Boolean);
      // 先に2ターン分だけ存在する状態で取り込む。
      writeFileSync(rolloutPath, full.slice(0, 8).join("\n") + "\n", "utf8");
      await runIngest({ dryRun: false, offlinePricing: true });
      const before = readHistory().filter((r) => r.sessionId === sessionId);
      expect(before.length).toBeGreaterThan(0);

      // 3ターン目が追記され、かつカーソルを失う。
      writeFileSync(rolloutPath, full.join("\n") + "\n", "utf8");
      writeFileSync(join(tmpHome, "cursors.json"), "{}", "utf8");

      const again = await runIngest({ dryRun: false, offlinePricing: true });
      const fresh = again.records.filter((r) => r.sessionId === sessionId);
      expect(fresh).toHaveLength(1); // 3ターン目だけ
      expect(fresh[0].tokens.cacheRead).toBe(900 - 500); // 累積 900 − 既計上 500
      expect(fresh[0].tokens.output).toBe(40 - 25);
    });
  });

  // 逆方向: 先に取り込み済みの状態でカーソルを失い、その状態で Stop hook(track)が発火する。
  // track もカーソルの不在を「未計上」の証拠として扱わない。
  describe("track のカーソル破壊耐性", () => {
    it("21. Claude: カーソルを失った状態で track が走っても既計上分を再計上しない", async () => {
      const trackedPath = join(cliProjects, "proj-cli", "track-recover.jsonl");
      writeFileSync(trackedPath, transcriptFixture("sess-trackrec", "trk"), "utf8");
      const stdin = readFileSync(FIXTURE_STDIN, "utf8").replace(
        '"__TRANSCRIPT_PATH__"',
        () => JSON.stringify(trackedPath),
      );

      await runTrack(stdin);
      const before = readHistory().filter((r) => r.sessionId === "sess-trackrec");
      expect(before).toHaveLength(1);
      expect(before[0].apiCalls).toBe(2);
      expect(before[0].countedCalls).toHaveLength(2);
      const historyCount = readHistory().length;

      // カーソルを失った状態で同じ Stop hook がもう一度発火する。
      writeFileSync(join(tmpHome, "cursors.json"), "{}", "utf8");
      await runTrack(stdin);

      expect(readHistory()).toHaveLength(historyCount); // 新しい行は増えない
      expect(readHistory().filter((r) => r.sessionId === "sess-trackrec")).toHaveLength(1);
      // カーソルは張り直され、次回以降は history を読まない通常経路に戻る。
      expect(sanitizeCursor(loadCursor(trackedPath))).not.toBeNull();
    });

    it("22. Claude: カーソルを失っても、未計上の新しいターンは track が記録する", async () => {
      const trackedPath = join(cliProjects, "proj-cli", "track-recover-new.jsonl");
      writeFileSync(trackedPath, transcriptFixture("sess-tracknew", "tnw"), "utf8");
      const stdin = readFileSync(FIXTURE_STDIN, "utf8").replace(
        '"__TRANSCRIPT_PATH__"',
        () => JSON.stringify(trackedPath),
      );
      await runTrack(stdin);

      appendFileSync(
        trackedPath,
        claudeTurnLines("sess-tracknew", "追加の質問", "req_tnw_NEW", "msg_tnw_NEW", "2026-07-06T15:00:00.000Z"),
        "utf8",
      );
      writeFileSync(join(tmpHome, "cursors.json"), "{}", "utf8");
      await runTrack(stdin);

      const rows = readHistory().filter((r) => r.sessionId === "sess-tracknew");
      expect(rows).toHaveLength(2);
      expect(rows[1].apiCalls).toBe(1); // 追記した1件だけ(ファイル全体の3ではない)
    });

    it("23. Codex: カーソルを失った状態で track が走っても既計上分を再計上しない", async () => {
      const sessionId = "01234567-bbbb-7000-8000-000000000023";
      const rolloutPath = join(codexHomeDir, "sessions", "2026", "08", "01", "rollout-track-recover.jsonl");
      writeFileSync(
        rolloutPath,
        readFileSync(FIXTURE_CODEX_ROLLOUT, "utf8").replaceAll("01234567-aaaa-7000-8000-000000000001", sessionId),
        "utf8",
      );
      const payload = JSON.parse(readFileSync(FIXTURE_CODEX_STOP_PAYLOAD, "utf8")) as Record<string, unknown>;
      payload.transcript_path = rolloutPath;
      payload.session_id = sessionId;
      const stdin = JSON.stringify(payload);

      await runTrack(stdin, { codex: true });
      const before = readHistory().filter((r) => r.source === "codex" && r.sessionId === sessionId);
      expect(before).toHaveLength(1);
      expect(before[0].countedCalls).toHaveLength(1);
      const historyCount = readHistory().length;

      writeFileSync(join(tmpHome, "cursors.json"), "{}", "utf8");
      await runTrack(stdin, { codex: true });

      expect(readHistory()).toHaveLength(historyCount);
      expect(sanitizeCursor(loadCursor(rolloutPath))).not.toBeNull(); // カーソルは張り直される
    });

    it("25. 指紋を持たない旧レコードしか無くても、カーソル欠損時の track が再計上しない", async () => {
      // この仕組みより前に記録された history には countedCalls が無い。
      // その場合はセッション別の ts 下限(ingest と同じ規則)で既計上分を落とす。
      const sessionId = "sess-legacy";
      const trackedPath = join(cliProjects, "proj-cli", `${sessionId}.jsonl`);
      writeFileSync(trackedPath, transcriptFixture(sessionId, "lgc"), "utf8");
      const stdin = readFileSync(FIXTURE_STDIN, "utf8")
        .replace('"__TRANSCRIPT_PATH__"', () => JSON.stringify(trackedPath))
        .replace('"sess-1"', () => JSON.stringify(sessionId));

      // 旧形式のレコード(countedCalls / ingestKey を持たない)を history に置く。
      writeFileSync(
        join(tmpHome, "history.jsonl"),
        JSON.stringify({
          schemaVersion: 1,
          ts: "2026-07-06T10:00:12.000Z", // transcript の最終行の時刻
          sessionId,
          project: "/tmp/proj",
          gitBranch: "main",
          models: ["claude-fable-5"],
          tokens: { input: 100, output: 200, cacheWrite5m: 0, cacheWrite1h: 10000, cacheRead: 50000 },
          sidechainTokens: null,
          apiCalls: 2,
          costUSD: 1,
          costJPY: 150,
          fxRate: 150,
          fxSource: "fixed",
          prompt: "",
        }) + "\n",
        "utf8",
      );
      expect(existsSync(join(tmpHome, "cursors.json"))).toBe(false); // カーソルは無い

      await runTrack(stdin);

      expect(readHistory().filter((r) => r.sessionId === sessionId)).toHaveLength(1); // 増えない
      expect(sanitizeCursor(loadCursor(trackedPath))).not.toBeNull(); // カーソルは張り直される
    });

    /** history 全体で各呼び出し指紋が1回しか現れないこと + 総コスト。 */
    function countedCallStats(): { duplicates: string[]; totalUSD: number; rows: number } {
      const seen = new Map<string, number>();
      let totalUSD = 0;
      const rows = readHistory();
      for (const rec of rows) {
        totalUSD += rec.costUSD + (rec.subagents?.costUSD ?? 0);
        for (const fp of rec.countedCalls ?? []) seen.set(fp, (seen.get(fp) ?? 0) + 1);
      }
      return {
        duplicates: [...seen.entries()].filter(([, n]) => n > 1).map(([fp]) => fp),
        totalUSD,
        rows: rows.length,
      };
    }

    it("26. append 成功・カーソル保存失敗の後に新しいターンが来ても、既計上分を再計上しない", async () => {
      const trackedPath = join(cliProjects, "proj-cli", "crash-window.jsonl");
      writeFileSync(trackedPath, transcriptFixture("sess-crash", "csh"), "utf8");
      const stdin = readFileSync(FIXTURE_STDIN, "utf8").replace(
        '"__TRANSCRIPT_PATH__"',
        () => JSON.stringify(trackedPath),
      );
      await runTrack(stdin); // ターン0
      const cursorC0 = readFileSync(join(tmpHome, "cursors.json"), "utf8");

      // ターンA を追記して記録する。
      appendFileSync(
        trackedPath,
        claudeTurnLines("sess-crash", "ターンA", "req_csh_A2", "msg_csh_A2", "2026-07-06T17:00:00.000Z"),
        "utf8",
      );
      await runTrack(stdin);
      const recordA = readHistory().at(-1)!;
      expect(recordA.apiCalls).toBe(1);
      const usdBefore = countedCallStats().totalUSD;

      // A の append 後にカーソル保存が失敗した状態: カーソルは C0 のまま、保留マーカーが残る。
      writeFileSync(join(tmpHome, "cursors.json"), cursorC0, "utf8");
      markPendingAppend(trackedPath, recordA.ingestKey!);

      // さらにターンB が来て次の Stop hook が発火する(集計範囲は A+B になる)。
      appendFileSync(
        trackedPath,
        claudeTurnLines("sess-crash", "ターンB", "req_csh_B2", "msg_csh_B2", "2026-07-06T18:00:00.000Z"),
        "utf8",
      );
      await runTrack(stdin);

      const after = countedCallStats();
      expect(after.duplicates).toEqual([]); // 各呼び出しの指紋は1回だけ
      const recordB = readHistory().at(-1)!;
      expect(recordB.apiCalls).toBe(1); // A+B ではなく B だけ
      expect(recordB.prompt).toBe("ターンB");
      expect(after.totalUSD).toBeCloseTo(usdBefore + recordB.costUSD, 10); // 総額は A+B の重複を含まない
      expect(existsSync(pendingAppendPath()) ? readFileSync(pendingAppendPath(), "utf8") : "{}").not.toContain(
        trackedPath,
      );
    });

    it("26b. Codex でも、カーソル保存失敗の後に新しいターンが来て再計上しない", async () => {
      const sessionId = "01234567-cccc-7000-8000-000000000026";
      const rolloutPath = join(codexHomeDir, "sessions", "2026", "08", "01", "rollout-crash.jsonl");
      const lines = [
        `{"timestamp":"2026-07-12T09:00:00.000Z","type":"session_meta","payload":{"id":"${sessionId}","cwd":"/home/user/p","originator":"codex-tui","source":"cli"}}`,
        '{"timestamp":"2026-07-12T09:00:01.000Z","type":"turn_context","payload":{"model":"gpt-5.5","cwd":"/home/user/p"}}',
      ];
      const turn = (mm: string, input: number, cached: number, output: number, id: string): string[] => [
        `{"timestamp":"2026-07-12T09:${mm}:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"${id}"}}`,
        `{"timestamp":"2026-07-12T09:${mm}:05.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":${input},"cached_input_tokens":${cached},"output_tokens":${output}}}}}`,
        `{"timestamp":"2026-07-12T09:${mm}:06.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"${id}"}}`,
      ];
      writeFileSync(rolloutPath, [...lines, ...turn("10", 1000, 200, 10, "t0")].join("\n") + "\n", "utf8");

      const payload = JSON.parse(readFileSync(FIXTURE_CODEX_STOP_PAYLOAD, "utf8")) as Record<string, unknown>;
      payload.transcript_path = rolloutPath;
      payload.session_id = sessionId;
      const stdin = JSON.stringify(payload);

      await runTrack(stdin, { codex: true }); // ターン0
      const cursorC0 = readFileSync(join(tmpHome, "cursors.json"), "utf8");

      appendFileSync(rolloutPath, turn("20", 2500, 500, 25, "tA").join("\n") + "\n", "utf8");
      await runTrack(stdin, { codex: true }); // ターンA
      const recordA = readHistory().at(-1)!;
      expect(recordA.tokens.output).toBe(15); // 25 - 10(差分)
      const usdBefore = countedCallStats().totalUSD;

      writeFileSync(join(tmpHome, "cursors.json"), cursorC0, "utf8");
      markPendingAppend(rolloutPath, recordA.ingestKey!);

      appendFileSync(rolloutPath, turn("30", 4000, 900, 40, "tB").join("\n") + "\n", "utf8");
      await runTrack(stdin, { codex: true });

      const after = countedCallStats();
      expect(after.duplicates).toEqual([]);
      const recordB = readHistory().at(-1)!;
      expect(recordB.tokens.output).toBe(15); // 40 - 25(A の分を含まない)
      expect(recordB.tokens.cacheRead).toBe(400); // 900 - 500
      expect(after.totalUSD).toBeCloseTo(usdBefore + recordB.costUSD, 10);
    });

    it("26d. 遅延サブエージェントだけが新規のときも、メインのカーソルを張り直してから収束する", async () => {
      // 走査ルートの外に置いて track 単体の挙動を見る(便乗り取込が古いカーソルを
      // 直してしまうと、track 自身の欠陥が隠れるため)。
      const outside = join(tmpHome, "outside-roots", "proj");
      mkdirSync(outside, { recursive: true });
      const trackedPath = join(outside, "sa-only-recover.jsonl");
      writeFileSync(trackedPath, transcriptFixture("sess-saonly", "sao"), "utf8");
      const stdin = readFileSync(FIXTURE_STDIN, "utf8").replace(
        '"__TRANSCRIPT_PATH__"',
        () => JSON.stringify(trackedPath),
      );
      await runTrack(stdin); // ターン0
      const cursorC0 = readFileSync(join(tmpHome, "cursors.json"), "utf8");

      appendFileSync(
        trackedPath,
        claudeTurnLines("sess-saonly", "ターンA", "req_sao_A2", "msg_sao_A2", "2026-07-06T17:00:00.000Z"),
        "utf8",
      );
      await runTrack(stdin); // ターンA
      const recordA = readHistory().at(-1)!;
      const fingerprintA = recordA.countedCalls![0];
      const usdBefore = countedCallStats().totalUSD;

      // A の append 後にカーソル保存が失敗した状態を作る。
      writeFileSync(join(tmpHome, "cursors.json"), cursorC0, "utf8");
      markPendingAppend(trackedPath, recordA.ingestKey!);

      // メインには新規が無く、遅れて完了したサブエージェントだけが増える。
      const agentDir = join(outside, "sa-only-recover", "subagents");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "agent-late.jsonl"), subagentFixture("sess-saonly", "17:00:30", "17:00:31"), "utf8");

      await runTrack(stdin); // SA-only 記録。ここでメインのカーソルも張り直さないと収束しない
      expect(readHistory().at(-1)!.subagents).toBeDefined();

      // 次の Stop hook(新規なし)で A が再計上されないこと。
      await runTrack(stdin);

      const after = countedCallStats();
      expect(after.duplicates).toEqual([]);
      const occurrencesOfA = readHistory().reduce(
        (n, r) => n + (r.countedCalls ?? []).filter((fp) => fp === fingerprintA).length,
        0,
      );
      expect(occurrencesOfA).toBe(1);
      const saUSD = readHistory().reduce((sum, r) => sum + (r.subagents?.costUSD ?? 0), 0);
      expect(after.totalUSD).toBeCloseTo(usdBefore + saUSD, 10);
    });

    it("26e. 保留マーカーが壊れていたら「保留あり」として扱う(fail-closed)", async () => {
      const trackedPath = join(cliProjects, "proj-cli", "broken-marker.jsonl");
      writeFileSync(trackedPath, transcriptFixture("sess-broken", "brk"), "utf8");
      const stdin = readFileSync(FIXTURE_STDIN, "utf8").replace(
        '"__TRANSCRIPT_PATH__"',
        () => JSON.stringify(trackedPath),
      );
      await runTrack(stdin); // ターン0
      const cursorC0 = readFileSync(join(tmpHome, "cursors.json"), "utf8");

      appendFileSync(
        trackedPath,
        claudeTurnLines("sess-broken", "ターンA", "req_brk_A2", "msg_brk_A2", "2026-07-06T17:00:00.000Z"),
        "utf8",
      );
      await runTrack(stdin);
      const recordA = readHistory().at(-1)!;
      const fingerprintA = recordA.countedCalls![0];

      // カーソルは古いまま、マーカーは壊れている(= 保留の有無が分からない)。
      writeFileSync(join(tmpHome, "cursors.json"), cursorC0, "utf8");
      writeFileSync(pendingAppendPath(), "{壊れた JSON", "utf8");
      expect(hasPendingAppend(trackedPath)).toBe(true);

      appendFileSync(
        trackedPath,
        claudeTurnLines("sess-broken", "ターンB", "req_brk_B2", "msg_brk_B2", "2026-07-06T18:00:00.000Z"),
        "utf8",
      );
      await runTrack(stdin);

      expect(countedCallStats().duplicates).toEqual([]);
      const occurrencesOfA = readHistory().reduce(
        (n, r) => n + (r.countedCalls ?? []).filter((fp) => fp === fingerprintA).length,
        0,
      );
      expect(occurrencesOfA).toBe(1);
      expect(readHistory().at(-1)!.prompt).toBe("ターンB");
    });

    it("26g. マーカー破損からの復旧が、別 transcript の保留状態を消さない", async () => {
      // 走査ルートの外に置いて track 単体の挙動を見る(便乗り取込が古いカーソルを直すと隠れる)。
      const outside = join(tmpHome, "outside-multi");
      mkdirSync(outside, { recursive: true });
      const pathA = join(outside, "sess-mA.jsonl");
      const pathB = join(outside, "sess-mB.jsonl");
      writeFileSync(pathA, transcriptFixture("sess-mA", "mta"), "utf8");
      writeFileSync(pathB, transcriptFixture("sess-mB", "mtb"), "utf8");
      const stdinFor = (p: string): string =>
        readFileSync(FIXTURE_STDIN, "utf8").replace('"__TRANSCRIPT_PATH__"', () => JSON.stringify(p));

      await runTrack(stdinFor(pathA)); // A ターン0
      await runTrack(stdinFor(pathB)); // B ターン0
      const cursorsBase = JSON.parse(readFileSync(join(tmpHome, "cursors.json"), "utf8")) as Record<string, unknown>;

      // A・B ともに1ターン追記して記録し、そのカーソル保存が失敗した状態を作る。
      appendFileSync(pathA, claudeTurnLines("sess-mA", "A1", "req_mta_1", "msg_mta_1", "2026-07-06T17:00:00.000Z"), "utf8");
      await runTrack(stdinFor(pathA));
      const recordA = readHistory().at(-1)!;
      appendFileSync(pathB, claudeTurnLines("sess-mB", "B1", "req_mtb_1", "msg_mtb_1", "2026-07-06T17:10:00.000Z"), "utf8");
      await runTrack(stdinFor(pathB));
      const recordB = readHistory().at(-1)!;
      const fingerprintB = recordB.countedCalls![0];
      const usdBefore = countedCallStats().totalUSD;

      // 両方のカーソルを記録前へ戻し、両方に保留を立てる。
      const rolledBack = JSON.parse(readFileSync(join(tmpHome, "cursors.json"), "utf8")) as Record<string, unknown>;
      rolledBack[pathA] = cursorsBase[pathA];
      rolledBack[pathB] = cursorsBase[pathB];
      writeFileSync(join(tmpHome, "cursors.json"), JSON.stringify(rolledBack), "utf8");
      markPendingAppend(pathA, recordA.ingestKey!);
      markPendingAppend(pathB, recordB.ingestKey!);

      // ここでマーカーが壊れる。
      writeFileSync(pendingAppendPath(), "{壊れた", "utf8");

      // A 側だけ track を通す(A の保留は解消される)。
      appendFileSync(pathA, claudeTurnLines("sess-mA", "A2", "req_mta_2", "msg_mta_2", "2026-07-06T18:00:00.000Z"), "utf8");
      await runTrack(stdinFor(pathA));

      // B の保留が失われていないこと。
      expect(hasPendingAppend(pathB)).toBe(true);

      // B を track しても、記録済みの B1 が再計上されないこと。
      appendFileSync(pathB, claudeTurnLines("sess-mB", "B2", "req_mtb_2", "msg_mtb_2", "2026-07-06T18:10:00.000Z"), "utf8");
      await runTrack(stdinFor(pathB));

      const after = countedCallStats();
      expect(after.duplicates).toEqual([]);
      const occurrencesOfB = readHistory().reduce(
        (n, r) => n + (r.countedCalls ?? []).filter((fp) => fp === fingerprintB).length,
        0,
      );
      expect(occurrencesOfB).toBe(1);
      const added = readHistory().slice(-2); // A2 と B2
      expect(added.map((r) => r.prompt)).toEqual(["A2", "B2"]);
      expect(added.every((r) => r.apiCalls === 1)).toBe(true);
      expect(after.totalUSD).toBeCloseTo(usdBefore + added[0].costUSD + added[1].costUSD, 10);
    });

    it("26h. 案内された解除操作(reset-cursors)は、未回復の transcript を再計上させない", async () => {
      const outside = join(tmpHome, "outside-release");
      mkdirSync(outside, { recursive: true });
      const pathA = join(outside, "sess-rA.jsonl");
      const pathB = join(outside, "sess-rB.jsonl");
      writeFileSync(pathA, transcriptFixture("sess-rA", "rla"), "utf8");
      writeFileSync(pathB, transcriptFixture("sess-rB", "rlb"), "utf8");
      const stdinFor = (p: string): string =>
        readFileSync(FIXTURE_STDIN, "utf8").replace('"__TRANSCRIPT_PATH__"', () => JSON.stringify(p));

      await runTrack(stdinFor(pathA));
      await runTrack(stdinFor(pathB));
      const cursorsBase = JSON.parse(readFileSync(join(tmpHome, "cursors.json"), "utf8")) as Record<string, unknown>;

      appendFileSync(pathA, claudeTurnLines("sess-rA", "A1", "req_rla_1", "msg_rla_1", "2026-07-06T17:00:00.000Z"), "utf8");
      await runTrack(stdinFor(pathA));
      const recordA = readHistory().at(-1)!;
      appendFileSync(pathB, claudeTurnLines("sess-rB", "B1", "req_rlb_1", "msg_rlb_1", "2026-07-06T17:10:00.000Z"), "utf8");
      await runTrack(stdinFor(pathB));
      const recordB = readHistory().at(-1)!;
      const fingerprintB = recordB.countedCalls![0];

      // A・B ともカーソルが古く、両方に保留がある状態でマーカーが壊れる。
      const rolledBack = JSON.parse(readFileSync(join(tmpHome, "cursors.json"), "utf8")) as Record<string, unknown>;
      rolledBack[pathA] = cursorsBase[pathA];
      rolledBack[pathB] = cursorsBase[pathB];
      writeFileSync(join(tmpHome, "cursors.json"), JSON.stringify(rolledBack), "utf8");
      markPendingAppend(pathA, recordA.ingestKey!);
      markPendingAppend(pathB, recordB.ingestKey!);
      writeFileSync(pendingAppendPath(), "{壊れた", "utf8");

      // A だけが回復する(B は未回復のまま)。
      appendFileSync(pathA, claudeTurnLines("sess-rA", "A2", "req_rla_2", "msg_rla_2", "2026-07-06T18:00:00.000Z"), "utf8");
      await runTrack(stdinFor(pathA));
      const usdBefore = countedCallStats().totalUSD;

      // doctor が案内する解除操作。
      expect(await runResetCursors([])).toBe(0);
      expect(existsSync(join(tmpHome, "cursors.json"))).toBe(false); // カーソルを先に捨てる
      expect(existsSync(pendingAppendPath())).toBe(false); // その後にマーカーを消す

      // 未回復だった B を track しても再計上しない。
      appendFileSync(pathB, claudeTurnLines("sess-rB", "B2", "req_rlb_2", "msg_rlb_2", "2026-07-06T18:10:00.000Z"), "utf8");
      await runTrack(stdinFor(pathB));

      const after = countedCallStats();
      expect(after.duplicates).toEqual([]);
      const occurrencesOfB = readHistory().reduce(
        (n, r) => n + (r.countedCalls ?? []).filter((fp) => fp === fingerprintB).length,
        0,
      );
      expect(occurrencesOfB).toBe(1);
      const added = readHistory().at(-1)!;
      expect(added.prompt).toBe("B2");
      expect(added.apiCalls).toBe(1);
      expect(after.totalUSD).toBeCloseTo(usdBefore + added.costUSD, 10);
    });

    it("26i. 解除操作がカーソル破棄後・マーカー削除前で中断しても再計上しない", async () => {
      const outside = join(tmpHome, "outside-partial");
      mkdirSync(outside, { recursive: true });
      const pathB = join(outside, "sess-pB.jsonl");
      writeFileSync(pathB, transcriptFixture("sess-pB", "plb"), "utf8");
      const stdin = readFileSync(FIXTURE_STDIN, "utf8").replace(
        '"__TRANSCRIPT_PATH__"',
        () => JSON.stringify(pathB),
      );
      await runTrack(stdin);
      const cursorsBase = readFileSync(join(tmpHome, "cursors.json"), "utf8");

      appendFileSync(pathB, claudeTurnLines("sess-pB", "B1", "req_plb_1", "msg_plb_1", "2026-07-06T17:00:00.000Z"), "utf8");
      await runTrack(stdin);
      const recordB = readHistory().at(-1)!;
      const fingerprintB = recordB.countedCalls![0];
      writeFileSync(join(tmpHome, "cursors.json"), cursorsBase, "utf8");
      markPendingAppend(pathB, recordB.ingestKey!);
      writeFileSync(pendingAppendPath(), "{壊れた", "utf8");
      const usdBefore = countedCallStats().totalUSD;

      // カーソルは捨てたが、マーカーを消す前に落ちた状態。
      rmSync(join(tmpHome, "cursors.json"), { force: true });
      expect(hasPendingAppend(pathB)).toBe(true); // 保留は残ったまま(安全側)

      appendFileSync(pathB, claudeTurnLines("sess-pB", "B2", "req_plb_2", "msg_plb_2", "2026-07-06T18:10:00.000Z"), "utf8");
      await runTrack(stdin);

      const after = countedCallStats();
      expect(after.duplicates).toEqual([]);
      const occurrencesOfB = readHistory().reduce(
        (n, r) => n + (r.countedCalls ?? []).filter((fp) => fp === fingerprintB).length,
        0,
      );
      expect(occurrencesOfB).toBe(1);
      expect(after.totalUSD).toBeCloseTo(usdBefore + readHistory().at(-1)!.costUSD, 10);
    });

    it("26f. 保留マーカーを作れないときは append せずに終える(例外は外に出さない)", async () => {
      const trackedPath = join(cliProjects, "proj-cli", "marker-unwritable.jsonl");
      writeFileSync(trackedPath, transcriptFixture("sess-nomarker", "nmk"), "utf8");
      const stdin = readFileSync(FIXTURE_STDIN, "utf8").replace(
        '"__TRANSCRIPT_PATH__"',
        () => JSON.stringify(trackedPath),
      );
      // マーカーのパスをディレクトリにして rename を必ず失敗させる。
      mkdirSync(join(tmpHome, "cache"), { recursive: true });
      mkdirSync(pendingAppendPath(), { recursive: true });
      writeFileSync(join(pendingAppendPath(), "keep"), "x", "utf8"); // 空でないディレクトリ

      await expect(runTrack(stdin)).resolves.toBeUndefined(); // 例外を外に出さない

      // track 経路(ingest 印の無いレコード)では記録しない。
      const rows = readHistory().filter((r) => r.sessionId === "sess-nomarker");
      expect(rows.filter((r) => r.ingest === undefined)).toHaveLength(0);

      // transcript は残っているので ingest が後から回収する。
      rmSync(pendingAppendPath(), { recursive: true, force: true });
      await runIngest({ dryRun: false, offlinePricing: true });
      const recovered = readHistory().filter((r) => r.sessionId === "sess-nomarker");
      expect(recovered.length).toBeGreaterThan(0);
      expect(recovered.every((r) => r.ingest === "scan")).toBe(true);
      expect(countedCallStats().duplicates).toEqual([]);
    });

    it("26c. カーソル保存に失敗すると保留マーカーが残り、成功すると消える", async () => {
      const trackedPath = join(cliProjects, "proj-cli", "marker.jsonl");
      writeFileSync(trackedPath, transcriptFixture("sess-marker", "mrk"), "utf8");
      const stdin = readFileSync(FIXTURE_STDIN, "utf8").replace(
        '"__TRANSCRIPT_PATH__"',
        () => JSON.stringify(trackedPath),
      );

      // cursors.json をディレクトリにして saveCursor を確実に失敗させる。
      rmSync(join(tmpHome, "cursors.json"), { force: true });
      mkdirSync(join(tmpHome, "cursors.json"), { recursive: true });
      await runTrack(stdin); // runTrack は例外を logError に閉じ込めるので投げない
      expect(readHistory().filter((r) => r.sessionId === "sess-marker")).toHaveLength(1); // append は済んでいる
      expect(sanitizeCursor(loadCursor(trackedPath))).toBeNull(); // カーソルは保存できていない
      expect(readFileSync(pendingAppendPath(), "utf8")).toContain(trackedPath); // マーカーが残る

      // 書き込めるように戻して再実行すると、再計上せずマーカーが消える。
      rmSync(join(tmpHome, "cursors.json"), { recursive: true, force: true });
      await runTrack(stdin);
      expect(readHistory().filter((r) => r.sessionId === "sess-marker")).toHaveLength(1);
      expect(countedCallStats().duplicates).toEqual([]);
      expect(readFileSync(pendingAppendPath(), "utf8")).not.toContain(trackedPath);
    });

    it("24. カーソルが健全なら track は history の指紋を参照しない", async () => {
      const trackedPath = join(cliProjects, "proj-cli", "track-no-read.jsonl");
      writeFileSync(trackedPath, transcriptFixture("sess-noread", "nrd"), "utf8");
      const stdin = readFileSync(FIXTURE_STDIN, "utf8").replace(
        '"__TRANSCRIPT_PATH__"',
        () => JSON.stringify(trackedPath),
      );
      await runTrack(stdin); // 1ターン目を記録し、正常なカーソルを残す

      // 2ターン目を追記したうえで、その呼び出しの指紋を「計上済み」として history に仕込む。
      appendFileSync(
        trackedPath,
        claudeTurnLines("sess-noread", "2つめ", "req_nrd_X", "msg_nrd_X", "2026-07-06T16:00:00.000Z"),
        "utf8",
      );
      const poison = callFingerprint("msg_nrd_X:req_nrd_X");
      appendFileSync(
        join(tmpHome, "history.jsonl"),
        JSON.stringify({ ...readHistory()[0], ts: "2026-07-06T15:59:00.000Z", countedCalls: [poison], ingestKey: "poison" }) + "\n",
        "utf8",
      );

      // カーソルは健全なので history を読まない = 仕込んだ指紋は効かず、2ターン目が記録される。
      await runTrack(stdin);
      const rows = readHistory().filter((r) => r.sessionId === "sess-noread" && r.ingestKey !== "poison");
      expect(rows).toHaveLength(2);
      expect(rows[1].apiCalls).toBe(1);

      // 逆にカーソルを失うと history を読む = 同じ指紋で除外される(参照経路の対照実験)。
      const path3 = join(cliProjects, "proj-cli", "track-read.jsonl");
      writeFileSync(path3, transcriptFixture("sess-read", "rdd"), "utf8");
      appendFileSync(
        path3,
        claudeTurnLines("sess-read", "2つめ", "req_rdd_X", "msg_rdd_X", "2026-07-06T16:00:00.000Z"),
        "utf8",
      );
      appendFileSync(
        join(tmpHome, "history.jsonl"),
        JSON.stringify({
          ...readHistory()[0],
          sessionId: "sess-read",
          ts: "2026-07-06T15:59:00.000Z",
          countedCalls: [callFingerprint("msg_rdd_A:req_rdd_A"), callFingerprint("msg_rdd_B:req_rdd_B"), callFingerprint("msg_rdd_X:req_rdd_X")],
          ingestKey: "poison2",
        }) + "\n",
        "utf8",
      );
      const stdin3 = readFileSync(FIXTURE_STDIN, "utf8").replace('"__TRANSCRIPT_PATH__"', () => JSON.stringify(path3));
      await runTrack(stdin3);
      expect(readHistory().filter((r) => r.sessionId === "sess-read" && r.ingestKey !== "poison2")).toHaveLength(0);
    });
  });

  // mtime プリフィルタは親 transcript だけでなく subagents/agent-*.jsonl の変化も見る。
  // サブエージェントのログは親より遅れて作られる/追記されるため、親の mtime だけでは
  // 「変化なし」と誤判定して恒久的に取りこぼす。
  it("27. 親を触らずサブエージェントログだけ追加・更新しても取り込む", async () => {
    const parentPath = join(cliProjects, "proj-cli", "late-sa.jsonl");
    writeFileSync(parentPath, transcriptFixture("sess-late", "lat"), "utf8");
    await runIngest({ dryRun: false, offlinePricing: true });
    const baseRows = readHistory().length;
    expect(readHistory().filter((r) => r.sessionId === "sess-late")).toHaveLength(1);

    // 親には一切触らず、サブエージェントログだけを後から置く。
    const agentDir = join(cliProjects, "proj-cli", "late-sa", "subagents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "agent-a1.jsonl"), subagentFixture("sess-late", "10:00:09", "10:00:10"), "utf8");

    const second = await runIngest({ dryRun: false, offlinePricing: true });
    expect(second.records.filter((r) => r.subagents !== undefined)).toHaveLength(1);
    expect(readHistory()).toHaveLength(baseRows + 1);

    // さらに既存の agent ファイルへ追記した場合も拾う(ファイル一覧が変わらないケース)。
    appendFileSync(
      join(agentDir, "agent-a1.jsonl"),
      subagentFixture("sess-late", "10:00:11", "10:00:12").replaceAll("_SA1", "_SA2"),
      "utf8",
    );
    const third = await runIngest({ dryRun: false, offlinePricing: true });
    expect(third.records.filter((r) => r.subagents !== undefined)).toHaveLength(1);
  });

  // 読み取り失敗は「新規なし」と区別する。処理済み扱いで mtime を保存すると、
  // 権限が戻っても mtime が同じ限り二度と走査されない。
  it("28. transcript を読めなかったファイルは失敗として数え、mtime キャッシュに載せない", async () => {
    const lockedPath = join(cliProjects, "proj-cli", "unreadable.jsonl");
    writeFileSync(lockedPath, transcriptFixture("sess-locked", "lck"), "utf8");
    chmodSync(lockedPath, 0o000);
    try {
      const blocked = await runIngest({ dryRun: false, offlinePricing: true });
      expect(blocked.failures).toBeGreaterThan(0);
      expect(blocked.records.filter((r) => r.sessionId === "sess-locked")).toHaveLength(0);
    } finally {
      chmodSync(lockedPath, 0o644);
    }

    // 権限が戻れば(mtime が変わっていなくても)取り込める。
    const recovered = await runIngest({ dryRun: false, offlinePricing: true });
    expect(recovered.failures).toBe(0);
    expect(recovered.records.filter((r) => r.sessionId === "sess-locked")).toHaveLength(1);
  });

  it("17. IngestResult の合計にサブエージェント分を含める", async () => {
    const parentPath = join(cliProjects, "proj-cli", "sa-total.jsonl");
    writeFileSync(parentPath, transcriptFixture("sess-total", "tot"), "utf8");
    const agentDir = join(cliProjects, "proj-cli", "sa-total", "subagents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "agent-tot.jsonl"), subagentFixture("sess-total", "10:00:09", "10:00:10"), "utf8");

    const result = await runIngest({ dryRun: false, offlinePricing: true });
    const expected = result.records.reduce((sum, r) => sum + r.costUSD + (r.subagents?.costUSD ?? 0), 0);
    expect(result.totalUSD).toBeCloseTo(expected, 10);
    const saTotal = result.records.reduce((sum, r) => sum + (r.subagents?.costUSD ?? 0), 0);
    expect(saTotal).toBeGreaterThan(0);
    // サーフェス別内訳の合計も本体合計と一致する。
    const bySurface = Object.values(result.bySurface).reduce((sum, v) => sum + (v?.usd ?? 0), 0);
    expect(bySurface).toBeCloseTo(result.totalUSD, 10);
  });

  it("15. カーソルを失っても、記録済みのサブエージェント分を二重計上しない", async () => {
    const parentPath = join(cliProjects, "proj-cli", "sa-cursor-lost.jsonl");
    writeFileSync(
      parentPath,
      transcriptFixture("sess-sa-lost", "salost"),
      "utf8",
    );
    const agentDir = join(cliProjects, "proj-cli", "sa-cursor-lost", "subagents");
    mkdirSync(agentDir, { recursive: true });
    const agentPath = join(agentDir, "agent-bbb.jsonl");
    writeFileSync(agentPath, subagentFixture("sess-sa-lost", "10:00:09", "10:00:10"), "utf8");

    await runIngest({ dryRun: false, offlinePricing: true });
    const before = readHistory().filter((r) => r.sessionId === "sess-sa-lost");
    expect(before.filter((r) => r.subagents !== undefined)).toHaveLength(1);

    // 親も agent 側もカーソルを失った状態(cursors.json のリセット相当)。
    dropCursorEntry(parentPath);
    dropCursorEntry(agentPath);

    const second = await runIngest({ dryRun: false, offlinePricing: true });
    expect(second.records.filter((r) => r.sessionId === "sess-sa-lost")).toHaveLength(0);
    expect(readHistory().filter((r) => r.sessionId === "sess-sa-lost")).toHaveLength(before.length);
  });
});

describe("notifyIngestSummary", () => {
  function cfgWith(overrides: Partial<Config>): Config {
    const base = readConfig();
    return { ...base, ...overrides };
  }

  it("6. 合計が minNotifyUSD 未満なら通知しない", async () => {
    const result = await runIngest({ dryRun: false, offlinePricing: true });
    const cfg = cfgWith({ minNotifyUSD: result.totalUSD + 1 });
    await notifyIngestSummary(result, cfg);
    expect(existsSync(join(tmpHome, "last-notify.json"))).toBe(false);
  });

  it("7. 合計が minNotifyUSD 以上ならまとめて1通(dry-run 経由で last-notify.json に記録)", async () => {
    const result = await runIngest({ dryRun: false, offlinePricing: true });
    const cfg = cfgWith({ minNotifyUSD: 0 });
    await notifyIngestSummary(result, cfg);
    expect(existsSync(join(tmpHome, "last-notify.json"))).toBe(true);
    const notify = JSON.parse(readFileSync(join(tmpHome, "last-notify.json"), "utf8"));
    expect(notify.os.title).toContain("取り込み");
  });

  it("8. ミュート中は通知しない", async () => {
    const result = await runIngest({ dryRun: false, offlinePricing: true });
    writeMuteState({ until: null });
    const cfg = cfgWith({ minNotifyUSD: 0 });
    await notifyIngestSummary(result, cfg);
    expect(existsSync(join(tmpHome, "last-notify.json"))).toBe(false);
  });

  it("9. 新規レコードが0件なら通知しない", async () => {
    await runIngest({ dryRun: false, offlinePricing: true }); // 1回目で消費しきる
    const empty = await runIngest({ dryRun: false, offlinePricing: true }); // 2回目は0件
    const cfg = cfgWith({ minNotifyUSD: 0 });
    await notifyIngestSummary(empty, cfg);
    expect(existsSync(join(tmpHome, "last-notify.json"))).toBe(false);
  });
});
