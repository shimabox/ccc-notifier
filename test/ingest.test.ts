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
 * transcript のパス変更・別マシンからの移行で実際に起きる「history にはあるがカーソルが無い」状態)。
 * mtime プリフィルタで走査対象から外れてしまわないよう、キャッシュも一緒に落とす。
 */
function dropCursorEntry(transcriptPath: string): void {
  const file = join(tmpHome, "cursors.json");
  const dict = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  expect(Object.hasOwn(dict, transcriptPath)).toBe(true);
  delete dict[transcriptPath];
  writeFileSync(file, JSON.stringify(dict), "utf8");
  rmSync(join(tmpHome, "cache", "ingest-mtimes.json"), { force: true });
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

  // 回帰テスト(2026-08-09 本番事故): track が既に完全に処理済みの transcript を、
  // ingest が cursor を見失ってファイル先頭から丸ごと再集計し、apiCalls/costUSD が
  // 桁違いに水増しされた重複レコードを追加する事故が実際に発生した(既存カーソルは
  // 存在するのに ingest 側の読み取りが効かず、cursor=null 相当の全件再集計になっていた)。
  // track が cursor を書いた「後」に ingest が同じルートを走査しても、新規レコードは
  // 0件でなければならない(= track と ingest は同じ cursors.json を真実源として共有する)。
  it("6. 回帰: track が既にカーソルを保存済みの transcript を ingest が走査しても新規0件(二重計上しない)", async () => {
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
  // パス変更・別マシンからの移行で「history には記録済みだがカーソルだけ無い」状態が生まれ、
  // その状態の集計はファイル全体を1ターンとして読む。history 側の ts と突合しない限り、
  // 記録済みのターンがそのまま重複レコードになる(2026-08-09 の本番事故の形)。
  // テスト6はカーソルを残したままなのでこの経路を通らない。
  it("7. 回帰: history に記録済みで cursors にエントリが無い Claude transcript を丸ごと再取り込みしない", async () => {
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

  it("8. 回帰: history に記録済みで cursors にエントリが無い Codex rollout を丸ごと再取り込みしない", async () => {
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
