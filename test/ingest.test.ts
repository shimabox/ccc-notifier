// test/ingest.test.ts — hook 非依存の増分取り込み(src/ingest.ts)の単体/結合テスト。
//
// 一時 CCCN_HOME + 一時 CCCN_CLAUDE_PROJECTS(cli) + CCCN_CLAUDE_DESKTOP_ROOTS(desktop) +
// 一時 CCCN_CODEX_HOME に隔離して検証する。実データ(~/.claude 等)には一切触れない。

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

import { notifyIngestSummary, runIngest } from "../src/ingest";
import { runTrack } from "../src/track";
import { loadCursor, readConfig, sanitizeCursor, writeMuteState } from "../src/store";
import type { Config, TurnRecord } from "../src/types";

const FIXTURE_TRANSCRIPT = fileURLToPath(new URL("./fixtures/transcript-basic.jsonl", import.meta.url));
const FIXTURE_DESKTOP_TRANSCRIPT = fileURLToPath(
  new URL("./fixtures/desktop/transcript-desktop-basic.jsonl", import.meta.url),
);
const FIXTURE_CODEX_ROLLOUT = fileURLToPath(new URL("./fixtures/codex/rollout-basic.jsonl", import.meta.url));
const FIXTURE_CODEX_DESKTOP_ROLLOUT = fileURLToPath(new URL("./fixtures/codex/rollout-desktop.jsonl", import.meta.url));
const FIXTURE_STDIN = fileURLToPath(new URL("./fixtures/stop-hook-stdin.json", import.meta.url));
const FIXTURE_SUBAGENT = fileURLToPath(new URL("./fixtures/subagent-basic.jsonl", import.meta.url));

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

/** サブエージェント fixture を、指定セッション・指定時刻に読み替えて返す。 */
function subagentFixture(sessionId: string, ts1: string, ts2: string): string {
  return readFileSync(FIXTURE_SUBAGENT, "utf8")
    .replaceAll('"sessionId":"sess-1"', `"sessionId":"${sessionId}"`)
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
      readFileSync(FIXTURE_TRANSCRIPT, "utf8").replaceAll('"sessionId":"sess-1"', '"sessionId":"sess-lost"'),
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
      readFileSync(FIXTURE_TRANSCRIPT, "utf8").replaceAll('"sessionId":"sess-1"', '"sessionId":"sess-multi"') +
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
      readFileSync(FIXTURE_TRANSCRIPT, "utf8").replaceAll('"sessionId":"sess-1"', '"sessionId":"sess-sa"'),
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

  it("15. カーソルを失っても、記録済みのサブエージェント分を二重計上しない", async () => {
    const parentPath = join(cliProjects, "proj-cli", "sa-cursor-lost.jsonl");
    writeFileSync(
      parentPath,
      readFileSync(FIXTURE_TRANSCRIPT, "utf8").replaceAll('"sessionId":"sess-1"', '"sessionId":"sess-sa-lost"'),
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
